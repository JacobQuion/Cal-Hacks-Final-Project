import * as THREE from 'three';
import QRCode from 'qrcode';
import { createWorld } from './scene.js';
import { Shuttle, predictContact, serveSpots, gradeTiming, TIME_SCALE, HALF_L, WINDOWS, LEVELS } from './physics.js';
import { FX } from './fx.js';
import { hud } from './hud.js';
import { initAudio, sfx } from './audio.js';
import { connect, call, tables, link } from './stdb.js';
import { createVideoCall } from './video.js';

// The laptop is a window onto the match: SpacetimeDB decides shots, landings, scoring and the NPC.
// This page renders the flight locally from each `shot` row, judges your swing timing against that
// flight, and sends the swing to the `swing` reducer. Everything is drawn in a local frame where
// you are always on the near (+Z) side; seat 1 sees the world mirrored.

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const other = w => (w === 'you' ? 'cpu' : 'you');
const first = it => { for (const x of it) return x; return undefined; };
const STEP = 1 / 240;
const REACH = 2.4;                // how far (m) the player may still be from the contact point (lunge)
const params = new URLSearchParams(location.search);

const world = createWorld($('game'));
const fx = new FX(world.scene, world.camera);
const shuttle = new Shuttle();

// Fog of war: a dark curtain over the opponent's half (local −Z). The data behind it really isn't
// on this laptop — the server withholds the opponent's shot until it crosses the net.
const fogCurtain = new THREE.Mesh(
  new THREE.BoxGeometry(11, 7, 9.2),
  new THREE.MeshBasicMaterial({ color: 0x05060d, transparent: true, opacity: 0, depthWrite: false }),
);
fogCurtain.position.set(0, 3.5, -4.7); fogCurtain.renderOrder = 5; world.scene.add(fogCurtain);
const fogWall = new THREE.Mesh(
  new THREE.PlaneGeometry(11, 4),
  new THREE.MeshBasicMaterial({ color: 0x8a5cff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
);
fogWall.position.set(0, 2, -0.12); fogWall.renderOrder = 6; world.scene.add(fogWall);
const fogOn = () => !!M && M.fogLeft > 0 && (game.state === 'playing' || game.state === 'paused');

const net = { conn: null, me: null, matchId: 0, seat: 0, spectator: false, watchCode: (params.get('watch') || '').toUpperCase() };
let M = null;                     // current match row
const game = {
  state: 'menu',                  // menu | lobby | countdown | playing | paused | results | replay
  level: 1,
  phase: 'idle',                  // serve | rally | point (mirrors the match row)
  incoming: null,                 // { who, seq, contactPos, contactT, land, landIn, hit }
  lastHitter: null,
  lastSeq: 0,
  serveKey: -1,
  gameT: 0,
  excite: 0,
  replay: null,
};
const phone = { connected: false, ready: false, tapMode: false, aim: 0, pitch: 0 };
let keyAim = 0;

// Local frame: seat 1 is mirrored so the player is always at the bottom of the screen.
const flip = () => net.seat === 1;
const toLocal = v => (flip() ? { x: -v.x, y: v.y, z: -v.z } : { x: v.x, y: v.y, z: v.z });
const aimWorld = a => (flip() ? -a : a);
const mySeatScore = m => (net.seat === 0 ? m.scoreA : m.scoreB);
const oppSeatScore = m => (net.seat === 0 ? m.scoreB : m.scoreA);
const myName = m => (net.seat === 0 ? m.nameA : m.nameB);
const oppName = m => (net.seat === 0 ? m.nameB : m.nameA) || 'Opponent';
const seatName = (m, seat) => (seat === 0 ? m?.nameA : m?.nameB) || 'Player';

// ---------- actors ----------
// Actor frame = the athlete group's own axes: +X racket side, −Z facing the net. `you` (side +1) faces −Z,
// the far player (side −1) is turned around, so a world vector maps to the actor frame by flipping X and Z.
// Footwork: accelerate and brake instead of sliding at a constant speed, and sprint (or lunge) harder when
// the contact is coming soon. `ref` is a plain 6.5 m/s runner that the reach rule is judged by, so how
// far you can get to is the same however the drawn player moves.
const RUN = { max: 7, lunge: 12, accel: 40, dash: 75, ref: 6.5 };
function makeActor(mesh, side) {
  return {
    mesh, side,
    pos: mesh.group.position, target: mesh.group.position.clone(), vel: new THREE.Vector3(), ref: mesh.group.position.clone(),
    swing: null, plan: null, clock: 0, moving: 0, step: 0, whiffUntil: 0, whiffPower: 0, arm: null,
  };
}
const actors = { you: makeActor(world.player, 1), cpu: makeActor(world.cpu, -1) };
const toActor = (a, v) => v.set(a.side * v.x, v.y, a.side * v.z);   // also actor → world (it's its own inverse)

function place(a, p) { a.pos.set(p.x, 0, p.z); a.target.copy(a.pos); a.ref.copy(a.pos); a.vel.set(0, 0, 0); a.plan = null; }
// The server stands where an underarm swing meets the shuttle held out at `hold` (near the usual spot).
function placeServer(a, spot, hold) {
  place(a, spot);
  const plan = planSwing(a, hold), r = toActor(a, plan.reach.clone());
  place(a, { x: hold.x - r.x, z: hold.z - r.z });
  a.plan = Object.assign(plan, { serve: true });   // racket held back, ready to serve
}
// Run to where this actor's racket will meet the shuttle at `contactPos`, `inS` seconds from now.
function moveTo(a, contactPos, inS = Infinity) {
  const p = a.plan = planSwing(a, contactPos);
  p.t = a.clock + inS;
  const r = toActor(a, p.reach.clone());
  a.target.set(clamp(contactPos.x - r.x, -3.6, 3.6), 0, a.side * clamp(a.side * (contactPos.z - r.z), 0.7, HALF_L + 1.2));
}
function goHome(a) { a.target.set(0, 0, a.side * 3.7); a.plan = null; }

// ---------- swing animation ----------
// A swing is planned around its contact point. At contact the arm points the racket face at the shuttle;
// the backswing and follow-through are arcs either side of that pose (over the top, side-arm or underarm).
// The player is positioned so the contact pose meets the shuttle, loads into the backswing as it arrives,
// and the strike passes through contact a few frames after the swing.
const REST = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0, -0.35));
const ARCS = {   // arc axis (actor frame), backswing / follow-through angles from contact (rad), arm heading at contact (x, z)
  over: { axis: new THREE.Vector3(1, 0, 0), back: 1.5, follow: -1.7, dir: [0.3, -1] },
  mid:  { axis: new THREE.Vector3(0, 1, 0), back: -1.7, follow: 1.6, dir: [1, -0.3] },
  low:  { axis: new THREE.Vector3(1, 0, 0), back: -1.5, follow: 1.7, dir: [0.45, -1] },
};
const PREP_S = 0.42;     // the arm starts loading this long before contact
const STRIKE_S = 0.05;   // backswing → contact
const FOLLOW_S = 0.17;   // contact → end of the follow-through
const swingKind = y => (y > 1.9 ? 'over' : y > 1.0 ? 'mid' : 'low');

const RIG = { L: 0, face: new THREE.Vector3() };   // shoulder → racket face: length (m), direction in the shoulder frame
function measureRig() {
  const m = world.player;
  m.group.updateMatrixWorld(true);
  const s = m.shoulder.getWorldPosition(new THREE.Vector3()), f = m.racket.userData.face.getWorldPosition(new THREE.Vector3());
  RIG.L = s.distanceTo(f);
  RIG.face.copy(m.shoulder.worldToLocal(f)).normalize();
}
const _va = new THREE.Vector3(), _qa = new THREE.Quaternion(), _qg = new THREE.Quaternion(), _qt = new THREE.Quaternion(), _qp = new THREE.Quaternion();
const _qr = new THREE.Quaternion(), _er = new THREE.Euler();

// `aimAt`: point the arm straight at `at` from where the player is now (a strike, which may come before the
// player has fully arrived) rather than along the swing's usual heading (planning where to stand).
function planSwing(a, at, aimAt = false) {
  if (!RIG.L) measureRig();
  const kind = swingKind(at.y), arc = ARCS[kind];
  a.mesh.group.updateMatrixWorld(true);
  const sh = toActor(a, a.mesh.shoulder.getWorldPosition(new THREE.Vector3()).sub(a.pos));   // shoulder pivot above the feet
  const s = clamp((at.y - sh.y) / RIG.L, -0.95, 0.98), h = Math.sqrt(1 - s * s), n = Math.hypot(arc.dir[0], arc.dir[1]);
  const d = new THREE.Vector3(arc.dir[0] / n * h, s, arc.dir[1] / n * h);
  if (aimAt) {
    const to = toActor(a, _va.set(at.x - a.pos.x, at.y, at.z - a.pos.z)).sub(sh);
    if (to.length() > 0.3) d.copy(to.normalize());
  }
  return {
    kind, t: Infinity,
    base: new THREE.Quaternion().setFromUnitVectors(RIG.face, d),   // shoulder orientation at contact (actor frame)
    reach: sh.addScaledVector(d, RIG.L),                             // feet → racket face at contact (actor frame)
  };
}
// Arm orientation (actor frame) at the point `theta` along the plan's arc.
function arcPose(plan, theta, out) { return out.setFromAxisAngle(ARCS[plan.kind].axis, theta).multiply(plan.base); }
// The torso's orientation in the actor frame (it leans and twists with the swing).
function torsoRel(a, out) {
  a.mesh.shoulder.parent.getWorldQuaternion(out);
  a.mesh.group.getWorldQuaternion(_qp);
  return out.premultiply(_qp.invert());
}
// The arm is tracked in the actor frame (a.arm), so the torso's lean and twist don't drag the racket off
// line; this turns it into the shoulder's own rotation. Run again once the rig has posed the torso.
function seatArm(a) {
  a.mesh.group.updateMatrixWorld(true);
  a.mesh.shoulder.quaternion.copy(torsoRel(a, _qt).invert().multiply(a.arm));
}
// Strike through `at`. `fromContact` = the hit already happened (an opponent's shot arriving), so the arm
// is at contact at once and only the follow-through plays.
function startSwing(a, at, fromContact = false) {
  a.swing = { t: fromContact ? STRIKE_S : 0, plan: planSwing(a, at, true), from: a.arm.clone() };
  a.plan = null;
}
function animateActor(a, dt, t) {
  a.clock += dt;
  // Footwork: steer toward the target, braking so the player stops on the spot
  _va.subVectors(a.target, a.ref).setY(0);
  const refDist = _va.length();
  if (refDist > 0.01) a.ref.addScaledVector(_va, Math.min(refDist, RUN.ref * dt) / refDist);
  _va.subVectors(a.target, a.pos).setY(0);
  const dist = _va.length();
  let vmax = RUN.max, accel = RUN.accel;
  if (a.plan && a.plan.t < Infinity) {
    const left = a.plan.t - a.clock - 0.08;
    vmax = left > 0 ? clamp(1.35 * dist / left, RUN.max, RUN.lunge) : RUN.lunge;
    if (left < 0.35) accel = RUN.dash;   // a fast shot: explode toward it
  }
  if (dist > 0.005) _va.multiplyScalar(Math.min(vmax, Math.sqrt(1.4 * accel * dist)) / dist); else _va.set(0, 0, 0);
  _va.sub(a.vel);
  const dv = _va.length(), maxDv = accel * dt;
  if (dv > maxDv) _va.multiplyScalar(maxDv / dv);
  a.vel.add(_va);
  a.pos.addScaledVector(a.vel, dt);
  if (dist < 0.01 && a.vel.lengthSq() < 0.04) { a.pos.set(a.target.x, 0, a.target.z); a.vel.set(0, 0, 0); }
  const speed = a.vel.length();
  a.moving += (clamp(speed / 2.5, 0, 1) - a.moving) * Math.min(1, dt * 10);
  a.step += dt * (6 + speed * 1.25) * a.moving;
  a.mesh.legs[0].rotation.x = Math.sin(a.step) * 0.6 * a.moving;
  a.mesh.legs[1].rotation.x = -Math.sin(a.step) * 0.6 * a.moving;
  a.mesh.body.position.y = Math.abs(Math.sin(a.step)) * 0.05 * a.moving + Math.sin(t * 3) * 0.008;

  // Racket arm
  a.mesh.group.updateMatrixWorld(true);
  a.arm ??= torsoRel(a, new THREE.Quaternion()).multiply(REST);
  let rest = REST;
  if (a === actors.you && phone.ready && !phone.tapMode) rest = _qr.setFromEuler(_er.set(clamp(0.4 + phone.pitch / 90, -0.4, 1.4), 0, -0.35));
  rest = torsoRel(a, _qg).multiply(rest);   // the ready pose is relative to the torso
  const sw = a.swing;
  if (sw) {
    if (sw.drawn) sw.t += dt;   // the first frame shows the starting pose (contact, for a hit already made)
    sw.drawn = true;
    if (sw.t < STRIKE_S) {
      const u = sw.t / STRIKE_S;
      a.arm.slerpQuaternions(sw.from, arcPose(sw.plan, 0, _qa), u * u);   // accelerate into the shuttle
    } else if (sw.t < STRIKE_S + FOLLOW_S) {
      const u = (sw.t - STRIKE_S) / FOLLOW_S;
      arcPose(sw.plan, ARCS[sw.plan.kind].follow * (1 - (1 - u) * (1 - u)), a.arm);
    } else if (sw.t > STRIKE_S + FOLLOW_S + 0.12) a.swing = null;   // hold the finish a moment
  } else {
    // Ready position, loading into the backswing as the shuttle arrives
    let goal = rest;
    const p = a.plan;
    if (p && (p.serve || (a.clock > p.t - PREP_S && a.clock < p.t + 0.3))) {
      const u = p.serve ? 0.7 : clamp((a.clock - (p.t - PREP_S)) / (PREP_S * 0.75), 0, 1);
      goal = rest.slerp(arcPose(p, ARCS[p.kind].back, _qa), u * u * (3 - 2 * u));
    }
    a.arm.slerp(goal, Math.min(1, dt * 12));
  }
  seatArm(a);
}

// ---------- SpacetimeDB ----------
const say = msg => hud.toast(msg, 2600);
const act = (name, args = {}) => call(net.conn, name, args, say);
// Keep a fresh measure of this laptop's hop to SpacetimeDB during a match (phone swings are back-dated by
// it). phone_aim does nothing when a laptop calls it, so it serves as a cheap ping.
setInterval(() => {
  if (net.conn && !net.spectator && ['lobby', 'countdown', 'playing'].includes(game.state)) act('phoneAim', { aim: 0, pitch: 0 });
}, 2000);

let refreshQueued = false;
const queueRefresh = () => { if (!refreshQueued) { refreshQueued = true; queueMicrotask(() => { refreshQueued = false; refresh(); }); } };
const onRows = tbl => { tbl.onInsert(queueRefresh); tbl.onDelete(queueRefresh); tbl.onUpdate?.(queueRefresh); };

connect({
  subs: [
    tables.match, tables.shotFeed, tables.myShot, tables.myLoadout, tables.device, tables.hallOfFame, tables.queue,
    tables.myDevice, tables.mySecret, tables.myStamina, tables.condition, tables.matchStats, tables.matchLog,
    tables.myRead, tables.myTarget, tables.scoutingReport, tables.myRtc,
    tables.swingEvent, tables.aimEvent, tables.hitEvent, tables.rallyEvent, tables.readEvent, tables.noticeEvent,
  ],
  wire(conn) {
    net.conn = conn;
    for (const t of ['match', 'device', 'hallOfFame', 'queue', 'myDevice', 'mySecret', 'myStamina', 'condition', 'matchStats', 'myRead', 'myTarget', 'scoutingReport', 'myLoadout']) onRows(conn.db[t]);
    // Shots arrive two ways: shot_feed (public; in fog only once the shuttle crosses the net) and
    // my_shot (a view with your own shot, immediately). Whichever brings a new seq first wins.
    for (const t of ['shotFeed', 'myShot']) {
      conn.db[t].onInsert((_c, row) => onShot(row));
      conn.db[t].onUpdate?.((_c, _o, row) => onShot(row));
    }
    conn.db.swingEvent.onInsert((_c, e) => onPhoneSwing(e));
    conn.db.aimEvent.onInsert((_c, e) => { if (mine(e)) { phone.aim = e.aim; phone.pitch = e.pitch; } });
    conn.db.hitEvent.onInsert((_c, e) => onHitEvent(e));
    conn.db.rallyEvent.onInsert((_c, e) => onRallyEvent(e));
    conn.db.readEvent.onInsert((_c, e) => onReadEvent(e));
    conn.db.noticeEvent.onInsert((_c, e) => { if (e.matchId === net.matchId) say(e.text); });
    conn.db.myRtc.onInsert((_c, row) => video.receive(row));
  },
  onReady(conn, me) {
    net.conn = conn; net.me = me;
    act('setName', { name: nameNow() });
    const join = (params.get('join') || '').toUpperCase();
    if (join) {
      act('joinMatch', { code: join, name: nameNow() });
      params.delete('join'); history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
    }
    refresh();
  },
  onStatus(text) { $('connStatus').textContent = text || '● Connected to SpacetimeDB'; if (text && game.state === 'playing') say(text); },
});

// Face-to-face video for 1v1s: signaling goes through SpacetimeDB, the media itself is peer to peer.
const video = createVideoCall({
  send: data => call(net.conn, 'rtcSignal', { data }, e => console.warn('video signal:', e)),
  ack: upTo => call(net.conn, 'rtcAck', { upTo }, () => {}),
});
function syncVideo() {
  const pvp = M && M.mode === 'pvp' && !net.spectator;
  if (!pvp) { video.sync(null); return; }
  const opp = net.seat === 0 ? M.laptopB : M.laptopA;
  video.sync({ matchId: M.id, seat: net.seat, oppKey: opp || '', oppName: opp ? oppName(M) : '', myName: myName(M) || nameNow() });
}

const mine = e => !net.spectator && e.matchId === net.matchId && e.seat === net.seat;

/** Re-derive everything from the client cache: which match we're in, phone, secrets, stamina, menus. */
function refresh() {
  const conn = net.conn;
  if (!conn) return;
  const d = first(conn.db.myDevice.iter());
  let matchId = d?.matchId || 0;
  net.spectator = false;
  if (!matchId && net.watchCode) {
    const w = [...conn.db.match.iter()].find(m => m.code === net.watchCode);
    if (w) { matchId = w.id; net.spectator = true; }
  }
  if (matchId !== net.matchId) { game.lastSeq = 0; game.serveKey = -1; }
  net.matchId = matchId;
  net.seat = !net.spectator && d && d.seat !== 255 ? d.seat : 0;
  M = matchId ? [...conn.db.match.iter()].find(m => m.id === matchId) || null : null;

  const ph = M && [...conn.db.device.iter()].find(x => x.kind === 'phone' && x.matchId === M.id && x.seat === net.seat);
  phone.connected = !!(ph && ph.online);
  phone.ready = !!(ph && ph.online && ph.ready);
  phone.tapMode = !!(ph && ph.tapMode);
  setPhoneStatus();

  hud.setSecret(first(conn.db.mySecret.iter()));
  const st = first(conn.db.myStamina.iter());
  hud.setStamina(st ? st.value : 100);
  const cond = [...conn.db.condition.iter()].find(c => c.seat !== net.seat);
  hud.setCondition(cond ? cond.label : 'fresh');

  renderReads();
  renderScout();
  renderLive();
  renderHallOfFame();
  const queued = [...conn.db.queue.iter()].some(q => q.identity.toHexString() === net.me);
  $('queueHint').textContent = queued ? '⏳ Looking for an opponent…' : '';
  $('btnQuick').textContent = queued ? '✖ Cancel search' : '⚡ Quick match';

  applyMatch(M);
  syncVideo();
}

// ---------- hidden information: reads, target zone, scouting (all from per-player views) ----------
const READ_LABEL = { drop: 'drop', clear: 'clear', smash: 'smash' };
function readAllowed() {
  if (!M || net.spectator || M.status !== 'playing') return false;
  return (M.phase === 'rally' && game.lastHitter === 'you') || (M.phase === 'serve' && M.server !== net.seat);
}
function renderReads() {
  const rd = net.conn && first(net.conn.db.myRead.iter());
  const ok = readAllowed();
  for (const b of document.querySelectorAll('#readCard button')) {
    b.disabled = !ok;
    b.classList.toggle('armed', !!rd && rd.guess === b.dataset.read && ok);
  }
  const zone = net.conn && first(net.conn.db.myTarget.iter());
  const showZone = zone && !net.spectator && (game.state === 'playing' || game.state === 'countdown');
  fx.setZone(showZone ? { ...toLocal({ x: zone.x, y: 0, z: zone.z }), r: zone.r } : null);
}
function renderScout() {
  const sec = net.conn && first(net.conn.db.mySecret.iter());
  const lines = net.conn ? [...net.conn.db.scoutingReport.iter()] : [];
  // Scouting is chosen in the lobby; the button only opens the report you brought into the match.
  $('btnScout').classList.toggle('hidden', !(sec && sec.scouted));
  $('scoutLines').innerHTML = lines.map(l => `<div class="scout-line"><b>${esc(l.label)}</b>${esc(l.detail)}</div>`).join('');
  if (!lines.length) $('scoutPanel').classList.add('hidden');
}
function toggleScout() {
  if (net.spectator || !net.conn || !M) return;
  const sec = first(net.conn.db.mySecret.iter());
  if (sec && sec.scouted) $('scoutPanel').classList.toggle('hidden');
}
function pickRead(guess) {
  if (!readAllowed()) return;
  const rd = first(net.conn.db.myRead.iter());
  act('pickRead', { guess: rd && rd.guess === guess ? '' : guess });
}
function onReadEvent(e) {
  if (e.matchId !== net.matchId) return;
  if (e.seat === net.seat && !net.spectator) {
    if (e.correct) { hud.callout('READ IT!', '#00e5ff'); hud.toast(`🔮 You read the ${READ_LABEL[e.actual]} — your next swing is sharper`, 2200); }
    else hud.toast(`🔮 Misread — it was a ${READ_LABEL[e.actual]} (−5 stamina)`, 2000);
  } else if (e.correct) {
    hud.toast(`😱 ${net.spectator ? seatName(M, e.seat) : oppName(M || {})} read your ${READ_LABEL[e.actual]}!`, 2000);
  }
}

// Other matches in progress — anyone can watch (the match table is public).
function renderLive() {
  const live = [...net.conn.db.match.iter()]
    .filter(m => (m.status === 'playing' || m.status === 'paused' || m.status === 'countdown') && m.id !== net.matchId)
    .slice(0, 6);
  $('liveList').innerHTML = live.length
    ? live.map(m => `<li><span>${esc(m.nameA)} ${m.scoreA}–${m.scoreB} ${esc(m.nameB)}</span><button class="small-btn" data-watch="${m.code}">👀 Watch</button></li>`).join('')
    : '<li class="hint">No matches being played</li>';
}
$('liveList').addEventListener('click', e => {
  const code = e.target?.dataset?.watch;
  if (!code) return;
  net.watchCode = code;
  refresh();
});

function renderHallOfFame() {
  const rows = [...net.conn.db.hallOfFame.iter()]
    .sort((a, b) => (a.at.microsSinceUnixEpoch < b.at.microsSinceUnixEpoch ? 1 : -1)).slice(0, 6);
  $('hofList').innerHTML = rows.length
    ? rows.map(r => `<li><b>${esc(r.winner)}</b> beat ${esc(r.loser)} <span>${esc(r.score)}</span>${r.fastestSmashKmh ? ` <i>💥 ${Math.round(r.fastestSmashKmh)} km/h</i>` : ''}</li>`).join('')
    : '<li class="hint">No matches yet</li>';
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- match state → screens ----------
function showScreen(id) { for (const s of ['menu', 'lobby', 'pause', 'results']) $(s).classList.toggle('show', s === id); }

function applyMatch(m) {
  if (game.state === 'replay') return;
  if (!m) {
    if (game.state !== 'menu') toMenu();
    return;
  }
  const level = net.spectator ? 'SPECTATING' : m.mode === 'ai' ? LEVELS[m.level]?.name ?? '' : '1V1';
  document.querySelector('.me-panel').classList.toggle('hidden', net.spectator);
  $('pauseBtn').classList.toggle('hidden', net.spectator);
  $('btnStopWatch').classList.toggle('hidden', !net.spectator);
  $('oppCondition').classList.toggle('hidden', net.spectator);
  $('btnEndRematch').classList.toggle('hidden', net.spectator);
  $('btnEndReplay').classList.toggle('hidden', net.spectator);
  $('btnEndResults').classList.toggle('hidden', net.spectator);
  hud.setLevel(level);
  hud.setNames(net.spectator ? m.nameA : 'You', net.spectator ? m.nameB : oppName(m));
  hud.setScore(mySeatScore(m), oppSeatScore(m), m.server === net.seat ? 'you' : 'cpu');
  world.setScoreboard({ left: net.spectator ? m.nameA || 'Player 1' : myName(m) || 'You', right: net.spectator ? m.nameB || 'Player 2' : oppName(m),
    a: mySeatScore(m), b: oppSeatScore(m), serving: m.server === net.seat ? 0 : 1 });
  game.level = m.level;
  $('fogChip').classList.toggle('hidden', !(m.fogLeft > 0));
  $('fogChip').textContent = `🌫 FOG · ${m.fogLeft} ${m.fogLeft === 1 ? 'rally' : 'rallies'}`;

  if (m.status === 'lobby') return showLobby(m);
  if (m.status === 'countdown') return startCountdown();
  if (m.status === 'paused') {
    game.state = 'paused'; game.incoming = null; fx.setTiming(null, null);
    $('pauseReason').textContent = m.pausedReason;
    showScreen('pause'); hud.show(true);
    return;
  }
  if (m.status === 'over') {
    if (game.state === 'results') renderStats(m);
    else if (game.state !== 'ended') enterEnded(m);
    return;
  }
  $('endBar').classList.add('hidden');
  // playing
  if (game.state !== 'playing') {
    game.state = 'playing';
    showScreen(null); hud.show(true);
    setPhoneStatus();
  }
  game.phase = m.phase;
  if (m.phase === 'serve' && game.serveKey !== m.shotSeq) { game.serveKey = m.shotSeq; setupServe(m); }
  if (m.phase === 'point') { game.incoming = null; fx.setTiming(null, null); fx.setLanding(null); }
}

function showLobby(m) {
  game.state = 'lobby'; hud.show(false); showScreen('lobby');
  $('endBar').classList.add('hidden');
  $('matchCode').textContent = m.code;
  const ai = m.mode === 'ai';
  const row = (name, ready, isMe) => `<div class="pl ${ready ? 'ready' : ''}"><span>${esc(name || 'Waiting for player 2…')}${isMe ? ' (you)' : ''}</span><b>${name ? (ready ? '✔ Ready' : '…') : ''}</b></div>`;
  $('lobbyPlayers').innerHTML = row(m.nameA, m.readyA, !net.spectator && net.seat === 0) + row(m.nameB, m.readyB, !net.spectator && net.seat === 1);
  $('inviteBox').classList.toggle('hidden', ai || !!m.laptopB);
  $('inviteUrl').textContent = `${publicBase()}/?join=${m.code}`;
  const myReady = net.seat === 0 ? m.readyA : m.readyB;
  $('btnReady').textContent = ai ? '▶ Start match' : myReady ? '✖ Not ready' : m.laptopB ? '✋ Ready' : '✋ Ready (waiting for player 2)';
  $('btnReady').classList.toggle('hidden', net.spectator);
  $('optFog').checked = m.fogEnabled;
  $('optFog').disabled = net.spectator || net.seat !== 0;
  $('optFogNote').textContent = net.seat !== 0 ? '(host decides)' : '';
  const lo = first(net.conn.db.myLoadout.iter());
  $('optScout').checked = !!lo?.scout;
  $('optScout').disabled = net.spectator;
  renderQR(m.code, net.seat);
}

// Phones need the public HTTPS address (tunnel), not localhost.
function publicBase() { return (import.meta.env.VITE_PUBLIC_URL || location.origin).replace(/\/$/, ''); }

let qrKey = '';
function renderQR(code, seat) {
  const url = `${publicBase()}/phone.html?code=${code}&seat=${seat}`;
  if (qrKey === url) return;
  qrKey = url;
  QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#1d2340', light: '#ffffff' } })
    .then(svg => { $('qr').innerHTML = svg; })
    .catch(() => { $('qr').textContent = 'QR failed'; });
  // Motion sensors only work over HTTPS, so a plain-http QR can't drive a phone racket.
  const insecure = new URL(url).protocol !== 'https:';
  $('phoneUrl').textContent = insecure ? `⚠️ ${url} — phones need HTTPS: start the tunnel and open this page from its https:// address` : url;
}

function setPhoneStatus() {
  const s = $('phoneStatus');
  s.classList.remove('wait', 'good');
  const [cls, text] = !phone.connected ? ['wait', 'Waiting for phone… (optional)']
    : !phone.ready ? ['wait', 'Phone connected — calibrating…']
    : ['good', phone.tapMode ? 'Phone ready (tap mode)' : 'Phone ready — swing to ready up!'];
  s.classList.add(cls); s.querySelector('span').textContent = text;
  hud.setInput(net.spectator ? '👀 Spectating' : phone.ready ? (phone.tapMode ? '📱 Phone (tap)' : '📱 Phone racket') : phone.connected ? '📱 Calibrating…' : '⌨️ Keyboard',
    phone.ready ? 'good' : phone.connected ? 'wait' : null);
}

let countdownTimer = null;
function startCountdown() {
  if (game.state === 'countdown') return;
  game.state = 'countdown';
  showScreen(null); hud.show(true);
  const sp = serveSpots(0, 0);
  const sv = net.seat === 0 ? actors.you : actors.cpu, rv = net.seat === 0 ? actors.cpu : actors.you;
  placeServer(sv, toLocal(sp.server), toLocal(sp.hold));
  place(rv, toLocal(sp.receiver));
  holdShuttle(toLocal(sp.hold), false);
  let n = 3;
  const tick = () => {
    if (game.state !== 'countdown') return;
    const el = $('countdown');
    el.textContent = n > 0 ? String(n) : 'GO!';
    el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
    sfx.ui();
    if (n-- > 0) countdownTimer = setTimeout(tick, 1000);
  };
  clearTimeout(countdownTimer);
  initAudioSafe();
  tick();
}

function setupServe(m) {
  game.phase = 'serve';
  game.incoming = null;
  game.lastHitter = null;
  const sv = m.server, sc = sv === 0 ? m.scoreA : m.scoreB;
  const spots = serveSpots(sv, sc);
  const svA = sv === net.seat ? actors.you : actors.cpu, rvA = sv === net.seat ? actors.cpu : actors.you;
  placeServer(svA, toLocal(spots.server), toLocal(spots.hold));
  place(rvA, toLocal(spots.receiver));
  game.hitHold = null;
  holdShuttle(toLocal(spots.hold), false);
  fx.resetTrail(); fx.setTiming(null, null); fx.setLanding(null);
  renderReads();
  if (!net.spectator && sv === net.seat) {
    hud.toast(phone.ready ? '📱 Your serve — swing! (gentle = short, hard = long)' : '⌨️ Your serve — press Z (short) or Space (long)', 2600);
  }
}

// A new shot row: the server launched the shuttle. Animate it locally and plan the receiver.
function onShot(row) {
  if (row.matchId !== net.matchId || row.seq <= game.lastSeq || game.state === 'replay') return;
  game.lastSeq = row.seq;
  if (game.state !== 'playing') return;
  const p = toLocal({ x: row.px, y: row.py, z: row.pz }), v = toLocal({ x: row.vx, y: row.vy, z: row.vz });
  const who = row.hitter === net.seat ? 'you' : 'cpu';
  // Out of the fog: the shuttle appears at the net — the swing that sent it was never seen.
  if (row.fromNet) { fx.puff({ x: p.x, z: p.z }, 0x8a5cff); sfx.net(); }
  else if (who === 'cpu' || net.spectator) startSwing(actors[who], p, true);
  else if (actors.you.swing && actors.you.swing.t < STRIKE_S) Object.assign(actors.you.swing, { t: STRIKE_S, drawn: false });   // return came back before the racket got there
  game.hitHold = null;
  launchShuttle(p, v, !row.fromNet);
  fx.resetTrail(); fx.setTrailColor(row.smash ? 0xff2bd6 : 0xc6ff00);
  game.lastHitter = who;
  game.phase = 'rally';
  onLaunched(row.seq);
  renderReads();
}

function onLaunched(seq) {
  const hitter = game.lastHitter, recv = other(hitter);
  const ra = actors[recv];
  const pred = predictContact(shuttle, ra.side);
  goHome(actors[hitter]);
  if (!pred.contact) { game.incoming = null; return; }
  game.incoming = {
    who: recv, seq, contactPos: pred.contact.pos, contactT: game.gameT + pred.contact.t,
    land: pred.land, landIn: pred.landIn, hit: false,
  };
  moveTo(ra, pred.contact.pos, pred.contact.t / TIME_SCALE);
  const showLanding = recv === 'you' && !net.spectator && M?.mode === 'ai' && game.level < 2;
  fx.setLanding(showLanding ? pred.land : null, pred.landIn);
}

function onHitEvent(e) {
  if (e.matchId !== net.matchId || game.state !== 'playing') return;
  const smash = e.smash;
  fx.burst(world.shuttle.position, smash ? 1 : 0.5, smash ? 26 : 12);
  if (smash) fx.shake(e.seat === net.seat ? 1 : 0.6);
  if (e.seat === net.seat && !net.spectator) {
    hud.sub(e.shown, smash ? '#ff4f8b' : '#ffffff');
    game.excite = Math.max(game.excite, smash ? 0.8 : 0.3);
  } else {
    sfx.hit(clamp(e.speedKmh / 110, 0.2, 1), smash);
    hud.sub(`${net.spectator ? seatName(M, e.seat) : oppName(M || {})}: ${e.shown}`, smash ? '#ff4f8b' : '#b9c4ff');
  }
}

function onRallyEvent(e) {
  if (e.matchId !== net.matchId) return;
  game.incoming = null; fx.setTiming(null, null); fx.setLanding(null);
  releaseHold();
  if (net.spectator) {
    hud.callout(`${seatName(M, e.winner)}!`, '#ffd23f'); sfx.point();
  } else if (e.winner === net.seat) {
    hud.callout('POINT!', '#ffd23f'); hud.sub(e.reason, '#ffffff'); sfx.point(); sfx.cheer(0.6); game.excite = 1;
  } else {
    hud.callout(e.reason === 'WINNER!' ? 'MISSED!' : e.reason, '#ffffff'); sfx.lose(); game.excite = 0.3;
  }
  if (e.bullseye) setTimeout(() => hud.toast(e.winner === net.seat && !net.spectator ? '🎯 BULLSEYE — landed in your secret zone! +25 stamina' : `🎯 ${seatName(M, e.winner)} hit a secret target zone`, 2200), 400);
  if (e.rally >= 6) setTimeout(() => hud.toast(`🔥 ${e.rally}-shot rally!`, 1500), 500);
  const you = net.seat === 0 ? e.scoreA : e.scoreB, opp = net.seat === 0 ? e.scoreB : e.scoreA;
  const target = M?.target ?? 11;
  if (!net.spectator && Math.max(you, opp) >= target - 1 && Math.abs(you - opp) >= 1 && Math.max(you, opp) < target + 2) {
    setTimeout(() => hud.toast(you > opp ? '🔥 MATCH POINT!' : '😬 Opponent match point', 1500), 900);
  }
}

function onPhoneSwing(e) {
  if (!mine(e)) return;
  phone.aim = e.aim;
  if (game.state === 'lobby' && M && !(net.seat === 0 ? M.readyA : M.readyB)) { act('setReady', { ready: true }); return; }
  if (game.state === 'results') { act('rematch'); return; }
  // e.lag already includes the phone's own hop to SpacetimeDB; add this laptop's hop back from it.
  if (game.state === 'playing') playerSwing(e.power, e.aim, Math.min(0.45, (e.lag || 0) / 1000 + link.oneWay()), { dir: e.dir, slice: e.slice });
}

// Player swing from phone or keyboard. `lag` = seconds between the real swing and now.
function playerSwing(power, aim, lag = 0, gesture = {}) {
  if (net.spectator || game.state !== 'playing' || !M) return;
  const me = actors.you;
  const inc = game.incoming;
  const serving = M.phase === 'serve' && M.server === net.seat;
  startSwing(me, inc && inc.who === 'you' ? inc.contactPos
    : serving ? shuttle.pos : new THREE.Vector3(0.45, 2.1, -0.4).add(me.pos));
  sfx.swoosh();

  if (M.phase === 'serve') {
    if (M.server === net.seat) { act('serve', { power: gesture.slice ? 0.2 : power, aim: aimWorld(aim) }); sfx.hit(0.3, false); }
    return;
  }
  if (M.phase !== 'rally' || !inc || inc.who !== 'you' || inc.hit) return;
  if (elapsed < me.whiffUntil && power <= me.whiffPower + 0.25) return;   // a clearly harder swing still counts

  const swingT = game.gameT - lag * TIME_SCALE;
  const dt = (swingT - inc.contactT) / TIME_SCALE;
  const grade = gradeTiming(dt);
  const inPlay = (shuttle.active && !shuttle.landed && shuttle.pos.y > 0.08) || (!!inc.pending && !!game.hitHold);   // held at the racket for a waiting swing
  const near = me.ref.distanceTo(me.target) < REACH;
  if (!grade || !near || !inPlay) {
    me.whiffUntil = elapsed + 0.25; me.whiffPower = power;
    const msg = !near && grade ? 'CAN\'T REACH!' : dt < 0 ? 'TOO EARLY' : 'TOO LATE';
    if (!near && grade) inc.hit = true;
    hud.sub(msg, '#ffffff');
    if (dt > 0) inc.hit = true; // late whiff — that was the chance
    return;
  }
  const hit = { grade, power, gesture, args: { seq: inc.seq, power, aim: aimWorld(aim), dir: gesture.dir || 'flat', slice: !!gesture.slice, dtMs: Math.round(dt * 1000) } };
  // A soft swing well before the contact is often just the backswing of the real one (raising the phone
  // before a chop). Hold it until the contact moment; a harder swing meanwhile replaces it.
  if (grade === 'EARLY' && power < 0.5 && !inc.pending) { inc.pending = hit; return; }
  commitHit(inc, hit);
}

function commitHit(inc, { grade, power, gesture, args }) {
  inc.hit = true; inc.pending = null;
  // The server launches the return from the contact point; hold the shuttle there until it does, rather
  // than letting it fall past the racket for a network round trip and then snap back.
  game.hitHold = { seq: inc.seq, until: elapsed + 0.9, pos: inc.contactPos, vel: shuttle.vel.clone() };
  holdShuttle(inc.contactPos);
  fx.setTiming(null, null); fx.setLanding(null);
  const colors = { 'PERFECT!': '#3bd16f', GOOD: '#3ec7ff', EARLY: '#ffd23f', LATE: '#ffd23f' };
  hud.callout(grade, colors[grade]);
  sfx.hit(power, gesture.dir === 'down' && power >= 0.8);
  act('swing', args);
}

// Match just ended: freeze on the court (last landing still visible) until the player opens results.
function enterEnded(m) {
  game.state = 'ended'; game.incoming = null;
  fx.setZone(null); $('scoutPanel').classList.add('hidden');
  fx.setTiming(null, null); fx.setLanding(null);
  showScreen(null); hud.show(true);
  const win = m.winner === net.seat;
  $('endTitle').textContent = net.spectator ? `${seatName(m, m.winner)} wins` : win ? '🏆 YOU WIN!' : `${oppName(m)} wins`;
  $('endScore').textContent = `${mySeatScore(m)} – ${oppSeatScore(m)}`;
  $('endBar').classList.remove('hidden');
  if (win) { sfx.win(); sfx.cheer(1); } else sfx.lose();
}

function showResults(m) {
  game.state = 'results';
  $('endBar').classList.add('hidden');
  hud.show(false);
  const win = m.winner === net.seat;
  $('resultTitle').textContent = net.spectator ? `${seatName(m, m.winner).toUpperCase()} WINS!` : win ? 'YOU WIN!' : `${oppName(m).toUpperCase()} WINS`;
  $('resultTitle').style.color = win || net.spectator ? '#ffd23f' : '#ffffff';
  $('resultScore').textContent = `${mySeatScore(m)} – ${oppSeatScore(m)}`;
  renderStats(m);
  showScreen('results');
}

// Stats come from the match_stats view, which SpacetimeDB computes from the shot log.
function renderStats(m) {
  const rows = [...net.conn.db.matchStats.iter()];
  const me = rows.find(r => r.seat === net.seat), op = rows.find(r => r.seat !== net.seat);
  if (!me || !op) { $('statsTable').innerHTML = ''; return; }
  const line = (label, f) => `<tr><th>${label}</th><td>${f(me)}</td><td>${f(op)}</td></tr>`;
  $('statsTable').innerHTML =
    `<tr><th></th><td><b>${esc(myName(m) || 'You')}</b></td><td><b>${esc(oppName(m))}</b></td></tr>` +
    line('Shots', r => r.shots) + line('Smashes', r => r.smashes) +
    line('Fastest smash', r => (r.fastestKmh ? `${Math.round(r.fastestKmh)} km/h` : '—')) +
    line('Perfect hits', r => r.perfects) + line('Drops &amp; net shots', r => r.drops) +
    line('Clears / lifts', r => `${r.clears} / ${r.lifts}`) + line('Secret moves', r => r.specials) +
    `<tr><th>Longest rally</th><td colspan="2">${me.longestRally} shots</td></tr>`;
}

function toMenu() {
  game.state = 'menu'; game.incoming = null; game.replay = null;
  $('replayBar').classList.add('hidden');
  $('endBar').classList.add('hidden');
  $('scoutPanel').classList.add('hidden');
  fx.setZone(null);
  world.setScoreboard(null);
  hud.show(false); showScreen('menu');
  shuttle.active = false; fx.setTiming(null, null); fx.setLanding(null);
}

// ---------- instant replay (from the shot_log table) ----------
// kind: 'last' = the final rally, 'best' = the longest rally of the match. Stays up until closed.
let replaySpeed = 0.5, replayKind = 'last';
function startReplay(kind = replayKind) {
  if (!net.matchId) return;
  const log = [...net.conn.db.matchLog.iter()].filter(r => r.matchId === net.matchId);
  if (!log.length) { say('Nothing to replay yet'); return; }
  const rallies = new Map();
  for (const r of log) (rallies.get(r.pointNo) || rallies.set(r.pointNo, []).get(r.pointNo)).push(r);
  let pointNo = Math.max(...rallies.keys());
  if (kind === 'best') for (const [p, rs] of rallies) if (rs.length > rallies.get(pointNo).length) pointNo = p;
  replayKind = kind;
  const shots = rallies.get(pointNo).sort((a, b) => a.seq - b.seq);
  const t0 = Number(shots[0].at.microsSinceUnixEpoch);
  game.replay = { shots, offsets: shots.map(s => (Number(s.at.microsSinceUnixEpoch) - t0) / 1e6), i: 0, t: -0.6, done: 0 };
  game.state = 'replay';
  shuttle.active = false;
  showScreen(null); hud.show(false);
  $('endBar').classList.add('hidden');
  $('replayBar').classList.remove('hidden');
  $('replayInfo').textContent = `${kind === 'best' ? 'Best rally' : 'Last rally'} · point ${pointNo + 1} · ${shots.length} shot${shots.length === 1 ? '' : 's'}`;
  $('btnReplaySpeed').textContent = replaySpeed === 1 ? '1×' : replaySpeed === 0.5 ? '½×' : '¼×';
}

function closeReplay() {
  game.replay = null;
  $('replayBar').classList.add('hidden');
  if (M && M.status === 'over') showResults(M); else { game.state = 'menu'; refresh(); }
}

function updateReplay(dt) {
  const rp = game.replay;
  rp.t += dt * replaySpeed;
  while (rp.i < rp.shots.length && rp.t >= rp.offsets[rp.i]) {
    const s = rp.shots[rp.i++];
    const p = toLocal({ x: s.px, y: s.py, z: s.pz }), v = toLocal({ x: s.vx, y: s.vy, z: s.vz });
    const who = s.seat === net.seat ? 'you' : 'cpu';
    startSwing(actors[who], p, true);
    goHome(actors[who]);
    // The receiver heads for the next contact (actor clocks run at replay speed, like rp.t).
    const nx = rp.shots[rp.i];
    if (nx) moveTo(actors[nx.seat === net.seat ? 'you' : 'cpu'], toLocal({ x: nx.px, y: nx.py, z: nx.pz }), rp.offsets[rp.i] - rp.t);
    launchShuttle(p, v, rp.i > 1); fx.resetTrail(); fx.setTrailColor(s.name === 'SMASH!' ? 0xff2bd6 : 0xc6ff00);
    const shotEl = $('replayShot');
    shotEl.textContent = `${seatName(M, s.seat)}: ${s.name}${s.special ? ` · secret ${s.special.toUpperCase()}` : ''} · ${Math.round(s.speedKmh)} km/h${s.grade ? ` · ${s.grade}` : ''}`;
    shotEl.style.color = s.name === 'SMASH!' ? '#ff4f8b' : '#ffffff';
    shotEl.classList.remove('go'); void shotEl.offsetWidth; shotEl.classList.add('go');
  }
  let left = dt;
  while (left > 0) { const h = Math.min(STEP, left); left -= h; shuttle.step(h * TIME_SCALE * replaySpeed, null); }
  // When the rally is over, hold the last frame and wait for Again / Best / Close.
  if (rp.i >= rp.shots.length && (shuttle.landed || !shuttle.active) && !rp.done) {
    rp.done = 1;
    $('replayInfo').textContent += ' · finished';
  }
}

// ---------- physics events (visual only — the server keeps score) ----------
function handleEvents(events) {
  for (const e of events) {
    if (e.type === 'net') sfx.net();
    if (e.type === 'land') { sfx.land(); fx.puff(e.pos, e.in ? 0xffffff : 0xff4a4a); }
  }
}

// ---------- menu, lobby and keyboard ----------
function storedName() {
  try { return localStorage.getItem('racket.name') || ''; } catch { return ''; }
}
$('nameInput').value = storedName() || `Player ${Math.floor(Math.random() * 900 + 100)}`;
const nameNow = () => $('nameInput').value.trim() || 'Player';
$('nameInput').addEventListener('change', () => {
  try { localStorage.setItem('racket.name', nameNow()); } catch { /* storage unavailable */ }
  act('setName', { name: nameNow() });
});
for (const b of document.querySelectorAll('#levelSeg button')) {
  b.addEventListener('click', () => {
    initAudioSafe(); sfx.ui();
    document.querySelectorAll('#levelSeg button').forEach(x => x.classList.toggle('on', x === b));
    game.level = +b.dataset.level;
  });
}
// Soft tick when a home-screen button is hovered or tabbed to (audio unlocks on the first click/key).
let hoverBtn = null;
const onMenuSelect = e => {
  const b = e.target.closest('#menu button');
  if (b === hoverBtn) return;
  hoverBtn = b;
  if (b && !b.disabled) sfx.hover();
};
$('menu').addEventListener('pointerover', onMenuSelect);
$('menu').addEventListener('focusin', onMenuSelect);
$('menu').addEventListener('pointerleave', () => { hoverBtn = null; });
window.addEventListener('pointerdown', initAudioSafe, { once: true });
window.addEventListener('keydown', initAudioSafe, { once: true });
$('btnAI').addEventListener('click', () => { initAudioSafe(); sfx.ui(); act('createMatch', { mode: 'ai', level: game.level, name: nameNow() }); });
$('btnCreate').addEventListener('click', () => { initAudioSafe(); sfx.ui(); act('createMatch', { mode: 'pvp', level: 1, name: nameNow() }); });
$('btnJoin').addEventListener('click', () => {
  initAudioSafe(); sfx.ui();
  const code = $('joinInput').value.trim().toUpperCase();
  if (code.length !== 4) { say('Enter the 4-letter match code'); return; }
  act('joinMatch', { code, name: nameNow() });
});
$('joinInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnJoin').click(); });
$('btnQuick').addEventListener('click', () => {
  initAudioSafe(); sfx.ui();
  const queued = net.conn && [...net.conn.db.queue.iter()].some(q => q.identity.toHexString() === net.me);
  if (queued) act('leaveQueue'); else act('quickMatch', { name: nameNow() });
});
$('btnReady').addEventListener('click', () => {
  initAudioSafe(); sfx.ui();
  if (!M) return;
  act('setReady', { ready: !(net.seat === 0 ? M.readyA : M.readyB) });
});
$('optFog').addEventListener('change', () => act('setFog', { on: $('optFog').checked }));
$('optScout').addEventListener('change', () => act('setScout', { on: $('optScout').checked }));
$('btnCopy').addEventListener('click', () => {
  navigator.clipboard?.writeText($('inviteUrl').textContent).then(() => say('Invite link copied'), () => say('Copy failed — select the link'));
});
$('btnLeaveLobby').addEventListener('click', () => { sfx.ui(); if (net.spectator) { net.watchCode = ''; toMenu(); } else act('leaveMatch'); });
$('btnResume').addEventListener('click', () => { sfx.ui(); act('setPaused', { paused: false }); });
$('btnMenu').addEventListener('click', () => { sfx.ui(); act('leaveMatch'); });
$('btnMenu2').addEventListener('click', () => { sfx.ui(); net.watchCode = ''; act('leaveMatch'); toMenu(); });
$('btnEndMenu').addEventListener('click', () => { sfx.ui(); stopWatching(); });
$('btnStopWatch').addEventListener('click', () => { sfx.ui(); stopWatching(); });
function stopWatching() {
  const watching = net.spectator;
  net.watchCode = '';
  if (!watching) act('leaveMatch');
  toMenu();
  if (watching) refresh();
}
$('btnAgain').addEventListener('click', () => { sfx.ui(); act('rematch'); });
$('btnReplay').addEventListener('click', () => { sfx.ui(); startReplay('last'); });
$('btnReplayAgain').addEventListener('click', () => { sfx.ui(); startReplay(); });
$('btnReplayBest').addEventListener('click', () => { sfx.ui(); startReplay('best'); });
$('btnReplaySpeed').addEventListener('click', () => {
  sfx.ui();
  replaySpeed = replaySpeed === 0.5 ? 0.25 : replaySpeed === 0.25 ? 1 : 0.5;
  $('btnReplaySpeed').textContent = replaySpeed === 1 ? '1×' : replaySpeed === 0.5 ? '½×' : '¼×';
});
$('btnReplayClose').addEventListener('click', () => { sfx.ui(); closeReplay(); });
$('btnEndResults').addEventListener('click', () => { sfx.ui(); if (M) showResults(M); });
$('btnEndReplay').addEventListener('click', () => { sfx.ui(); startReplay('last'); });
$('btnEndRematch').addEventListener('click', () => { sfx.ui(); act('rematch'); });
$('pauseBtn').addEventListener('click', () => { sfx.ui(); act('setPaused', { paused: true }); });
for (const b of document.querySelectorAll('#secretCard button')) b.addEventListener('click', () => toggleSecret(b.dataset.move));
for (const b of document.querySelectorAll('#readCard button')) b.addEventListener('click', () => pickRead(b.dataset.read));
$('btnScout').addEventListener('click', toggleScout);
$('btnScoutClose').addEventListener('click', () => $('scoutPanel').classList.add('hidden'));

function toggleSecret(move) {
  if (net.spectator || !net.conn) return;
  const sec = first(net.conn.db.mySecret.iter());
  act('pickSecret', { move: sec && sec.armed === move ? '' : move });
}

const held = new Set();
window.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (k === 'p' || k === 'escape') { if (game.state === 'playing' || game.state === 'paused') act('setPaused', { paused: game.state === 'playing' }); return; }
  if (e.repeat) return;
  held.add(e.key);
  keyAim = (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0);
  if (game.state === 'lobby' && (k === 'enter' || k === ' ')) { e.preventDefault(); $('btnReady').click(); return; }
  if (game.state !== 'playing') return;
  if (k === '1') toggleSecret('power');
  if (k === '2') toggleSecret('curve');
  if (k === '3') toggleSecret('feint');
  if (k === 'q') pickRead('drop');
  if (k === 'w') pickRead('clear');
  if (k === 'e') pickRead('smash');
  if (k === 's') toggleScout();
  if (k === ' ') { e.preventDefault(); playerSwing(e.shiftKey ? 1 : 0.55, keyAim); }
  if (k === 'z') playerSwing(0.5, keyAim, 0, { slice: true });
  if (k === 'x') playerSwing(1, keyAim, 0, { dir: 'down' });
  if (k === 'c') playerSwing(0.7, keyAim, 0, { dir: 'up' });
});
window.addEventListener('keyup', e => {
  held.delete(e.key);
  keyAim = (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0);
});
function initAudioSafe() { try { initAudio(); } catch { /* audio unavailable */ } }

// ---------- main loop ----------
const clock = new THREE.Clock();
let acc = 0, elapsed = 0, perfT = 0, perfN = 0, renderScale = Math.min(window.devicePixelRatio, 1.5);
const camPos = new THREE.Vector3(0, 6, 14), camLook = new THREE.Vector3(0, 1, 0), lookCur = camLook.clone();
const camTarget = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _dir = new THREE.Vector3();

// ---------- shuttle hand-offs ----------
// A new flight rarely starts exactly where the shuttle is drawn (timing error, network delay). The drawn
// shuttle keeps an offset that eases to zero, so it glides onto the new flight instead of jumping.
const shuttleOff = new THREE.Vector3();
const _qs = new THREE.Quaternion(), _landTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2.4, 0, 0));
const BLEND_S = 0.06;
function easeFrom(p, blend) {
  shuttleOff.subVectors(world.shuttle.position, p);
  if (!blend || !world.shuttle.visible || shuttleOff.length() > 4) shuttleOff.set(0, 0, 0);
}
function launchShuttle(p, v, blend = true) { easeFrom(p, blend); shuttle.launch(p, v); }
function holdShuttle(p, blend = true) { easeFrom(p, blend); shuttle.hold(p); }
// The return never came (the server judged it a miss): let the shuttle fall on from the contact point.
function releaseHold() {
  const h = game.hitHold;
  game.hitHold = null;
  if (h && !shuttle.active) shuttle.launch(h.pos, h.vel);
}

function update(dt) {
  // Fixed-step physics in game time (rendering only; the server referees)
  acc += dt;
  while (acc >= STEP) {
    acc -= STEP;
    const gdt = STEP * TIME_SCALE;
    game.gameT += gdt;
    const events = [];
    shuttle.step(gdt, events);
    handleEvents(events);
  }
  if (game.phase === 'serve' && M) {
    const sc = M.server === 0 ? M.scoreA : M.scoreB;
    shuttle.hold(toLocal(serveSpots(M.server, sc).hold));
  }
  if (game.hitHold && elapsed > game.hitHold.until) releaseHold();

  // Timing ring for the player
  const inc = game.incoming;
  if (!net.spectator && game.phase === 'rally' && inc && inc.who === 'you' && !inc.hit) {
    const left = (inc.contactT - game.gameT) / TIME_SCALE;
    fx.setTiming(inc.contactPos, left);
    if (inc.pending) {
      // An early soft swing is waiting: the shuttle stops at the racket at the contact moment, and the swing
      // stands once a harder one (sensor + network delay behind the real swing) can no longer be on its way.
      if (left <= 0 && !game.hitHold) {
        game.hitHold = { seq: inc.seq, until: elapsed + 1.2, pos: inc.contactPos, vel: shuttle.vel.clone() };
        holdShuttle(inc.contactPos);
      }
      if (left <= -Math.min(0.3, 0.1 + 2 * link.oneWay())) commitHit(inc, inc.pending);
    } else if (left < -WINDOWS.ok) { inc.hit = true; fx.setTiming(null, null); }
  } else fx.setTiming(null, null);

  // Aim marker on the opponent's court
  const aim = phone.ready ? phone.aim : keyAim;
  fx.setAim(aim * 2.2, !net.spectator && game.phase !== 'point');
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;
  if (game.state === 'playing') update(dt);
  if (game.state === 'replay') updateReplay(dt);

  const actorDt = game.state === 'paused' ? 0 : game.state === 'replay' ? dt * replaySpeed : dt;
  for (const a of Object.values(actors)) animateActor(a, actorDt, elapsed);

  // Shuttle mesh: interpolated between physics steps, easing out any hand-off offset; the cork turns to
  // lead along the velocity (a quick flip after each hit, like a real shuttle).
  const sm = world.shuttle;
  sm.visible = game.state !== 'menu' && game.state !== 'lobby';
  sm.position.lerpVectors(shuttle.prev, shuttle.pos, game.state === 'playing' ? acc / STEP : 1).add(shuttleOff);
  shuttleOff.multiplyScalar(Math.exp(-dt / BLEND_S));
  if (shuttle.active && !shuttle.landed && shuttle.vel.length() > 0.7) _qs.setFromUnitVectors(_up, _dir.copy(shuttle.vel).normalize());
  else if (shuttle.landed) _qs.copy(_landTilt);
  else if (!game.hitHold) _qs.identity();
  sm.quaternion.slerp(_qs, game.state === 'playing' || game.state === 'replay' ? 1 - Math.exp(-dt * 28) : 1);

  const fog = fogOn();
  const fk = Math.min(1, dt * 3);
  fogCurtain.material.opacity += ((fog ? 0.93 : 0) - fogCurtain.material.opacity) * fk;
  fogWall.material.opacity += ((fog ? 0.22 + Math.sin(elapsed * 2) * 0.06 : 0) - fogWall.material.opacity) * fk;
  fogCurtain.visible = fogWall.visible = fogCurtain.material.opacity > 0.01;
  world.cpu.group.visible = !(fog && fogCurtain.material.opacity > 0.5);
  if (fog && sm.position.z < -0.05) sm.visible = false;

  game.excite = Math.max(0, game.excite - dt * 0.4);
  world.update(elapsed, dt, game.excite);
  for (const a of Object.values(actors)) seatArm(a);
  fx.update(dt, elapsed, sm, shuttle.active && !shuttle.landed);

  // Camera
  if (game.state === 'menu' || game.state === 'lobby') {
    const a = elapsed * 0.1;
    camTarget.set(Math.sin(a) * 13, 5.5, Math.cos(a) * 13); camLook.set(0, 1, 0);
  } else {
    const p = actors.you.pos;
    camTarget.set(p.x * 0.4, 3.6, 10.2 + (p.z - 4.5) * 0.35);
    camLook.set(p.x * 0.2, 1.0, -2.2);
  }
  camPos.lerp(camTarget, Math.min(1, dt * 2.5));
  lookCur.lerp(camLook, Math.min(1, dt * 2.5));
  world.camera.position.copy(camPos).add(fx.shakeOffset);
  world.camera.lookAt(lookCur);

  perfT += dt; perfN++;
  if (perfT > 1.5) {
    if (perfT / perfN > 1 / 48 && renderScale > 0.75) { renderScale -= 0.25; world.setPixelRatio(renderScale); }
    perfT = perfN = 0;
  }
  world.render();
}
requestAnimationFrame(frame);

// Test hook for automated checks
window.__bb = { game, net, shuttle, actors, phone, playerSwing, act, world, get match() { return M; } };
