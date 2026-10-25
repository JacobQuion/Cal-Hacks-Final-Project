import * as THREE from 'three';
import QRCode from 'qrcode';
import { createPongWorld, HALF_L, HALF_W, TOP, NET_H, BALL_R } from './pong-scene.js';
import { pongServer, PONG_LEVELS } from '../spacetimedb/src/pong.ts';
import { initAudio, sfx } from './audio.js';
import { connect, call, tables } from './stdb.js';

// Ping pong: the phone is the paddle. Tilt it right for a forehand, left for a backhand: if the paddle
// is on the side the ball comes to, it hits. A flick as the ball arrives turns the block into a drive.
// Tilt and flicks arrive through SpacetimeDB (pong_input); the rally runs here and each point goes to
// the database (pong_point), which keeps score and ends the game at 11.

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const first = it => { for (const x of it) return x; return undefined; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rand = (a, b) => a + Math.random() * (b - a);
const G = 9.81;

const HIT_Z = HALF_L + 0.25;      // where the player's paddle meets the ball (the NPC's is at −HIT_Z)
const SIDE_DEAD = 0.12;           // tilt inside this counts as neither side
const HOLD = 0.13;                // hit-stop on contact; a flick that lands in it still counts
const SWING_EARLY = 0.55;         // a flick this long before contact still drives
const LATE_UPGRADE = 0.22;        // a flick this soon after a block still upgrades it
const LV = [
  { speed: 1.0, err: 0.15, npcSpeed: 2.2, cue: true },
  { speed: 0.82, err: 0.09, npcSpeed: 2.9, cue: false },
  { speed: 0.68, err: 0.05, npcSpeed: 3.6, cue: false },
];

const world = createPongWorld($('game'));
const net = { conn: null, matchId: 0, code: '', phoneConnected: false, phoneReady: false, tapMode: false };
let P = null;              // this table's pong_game row
const game = {
  state: 'lobby',          // lobby | serve | rally | point | over
  level: (() => { try { return clamp(Number(localStorage.getItem('racket.pongLevel')) || 0, 0, 2); } catch { return 0; } })(),
  tilt: 0, tiltShown: 0,
  lastSwing: -9, lastPower: 0.6,
  rally: 0, perfects: 0, pointPerfects: 0,
  server: 0, t: 0, pendingSeq: -1, why: '',
  swingAnim: 0, swingDir: 1, yaw: 0,
  sideStreak: 0, lastSide: 0,
};
const ball = { pos: new THREE.Vector3(0, -5, 0), vel: new THREE.Vector3(), mode: 'hidden', path: null, freeT: 0, stuckT: 0, contactAt: 0, hitSide: 1 };
const npc = { x: 0, paddleX: 0.3, target: 0.3, swing: 0 };

// ---------- SpacetimeDB ----------
const say = (msg, ms = 2400) => {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(say.t); say.t = setTimeout(() => t.classList.remove('show'), ms);
};
const act = (name, args = {}) => call(net.conn, name, args, say);

connect({
  subs: [tables.match, tables.device, tables.myDevice, tables.pongGame, tables.pongScore, tables.pongInput, tables.noticeEvent],
  wire(conn) {
    net.conn = conn;
    for (const t of ['match', 'device', 'myDevice', 'pongScore']) {
      conn.db[t].onInsert(queueRefresh); conn.db[t].onDelete(queueRefresh); conn.db[t].onUpdate?.(queueRefresh);
    }
    conn.db.pongGame.onInsert(queueRefresh);
    conn.db.pongGame.onUpdate?.((_c, _o, row) => { if (row.matchId === net.matchId) { P = row; onGame(); } queueRefresh(); });
    conn.db.pongInput.onInsert((_c, e) => { if (e.matchId === net.matchId) onPhone(e); });
    conn.db.noticeEvent.onInsert((_c, e) => { if (e.matchId === net.matchId) say(e.text); });
  },
  onReady(conn) {
    net.conn = conn;
    act('setName', { name: nameNow() });
    // Same tab, same identity: a reload keeps the table (and the paired phone).
    const d = first(conn.db.myDevice.iter());
    const m = d && d.matchId ? [...conn.db.match.iter()].find(x => x.id === d.matchId) : null;
    if (!(m && m.mode === 'pong' && m.status === 'lobby')) act('startPong', { name: nameNow(), level: game.level });
    refresh();
  },
  onStatus(text) { $('connStatus').textContent = text || '● Connected to SpacetimeDB'; },
});

let refreshQueued = false;
function queueRefresh() { if (!refreshQueued) { refreshQueued = true; queueMicrotask(() => { refreshQueued = false; refresh(); }); } }

function refresh() {
  const conn = net.conn;
  if (!conn) return;
  const d = first(conn.db.myDevice.iter());
  const m = d && d.matchId ? [...conn.db.match.iter()].find(x => x.id === d.matchId) : null;
  const ours = m && m.mode === 'pong' ? m : null;
  net.matchId = ours ? ours.id : 0;
  net.code = ours ? ours.code : '';
  P = ours ? conn.db.pongGame.matchId.find(ours.id) ?? null : null;
  const ph = ours && [...conn.db.device.iter()].find(x => x.kind === 'phone' && x.matchId === ours.id && x.seat === 0);
  net.phoneConnected = !!(ph && ph.online);
  net.phoneReady = !!(ph && ph.online && ph.ready);
  net.tapMode = !!(ph && ph.tapMode);
  renderLobby();
  renderBest();
  renderBoard();
}

// ---------- lobby ----------
function publicBase() { return (import.meta.env.VITE_PUBLIC_URL || location.origin).replace(/\/$/, ''); }
let qrKey = '';
function renderLobby() {
  $('tableCode').textContent = net.code || '····';
  if (net.code) {
    const url = `${publicBase()}/phone.html?code=${net.code}&seat=0&game=pong`;
    if (qrKey !== url) {
      qrKey = url;
      QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#1d2340', light: '#ffffff' } })
        .then(svg => { $('qr').innerHTML = svg; }).catch(() => { $('qr').textContent = 'QR failed'; });
      $('phoneUrl').textContent = new URL(url).protocol !== 'https:' ? '⚠️ Phones need HTTPS: open this page from its https:// address' : '';
    }
  }
  const s = $('phoneStatus');
  const [cls, text] = !net.phoneConnected ? ['wait', 'Waiting for phone…'] : !net.phoneReady ? ['wait', 'Phone connected, calibrating…']
    : ['good', net.tapMode ? 'Phone ready (tap mode)' : 'Phone ready! Flick to start'];
  s.classList.remove('wait', 'good'); s.classList.add(cls); s.querySelector('span').textContent = text;
  const chip = $('inputChip');
  chip.classList.remove('good', 'wait');
  if (net.phoneReady) chip.classList.add('good'); else if (net.phoneConnected) chip.classList.add('wait');
  chip.querySelector('span').textContent = net.phoneReady ? (net.tapMode ? '📱 Phone (tap)' : '📱 Phone paddle') : net.phoneConnected ? '📱 Calibrating…' : '📱 No phone';

  const mid = !!(P && !P.done && P.me + P.cpu > 0);
  $('btnStart').textContent = !net.phoneReady ? '📱 Pair your phone to play' : mid ? `▶ Resume (${P.me} – ${P.cpu})` : '▶ Start game';
  $('btnStart').disabled = !P || !net.phoneReady;
  $('btnNewGame').classList.toggle('hidden', !mid);
  for (const b of document.querySelectorAll('#levelSeg button')) b.classList.toggle('on', Number(b.dataset.level) === game.level);
}

function renderBest() {
  const rows = [...net.conn.db.pongScore.iter()].filter(r => r.won)
    .sort((a, b) => b.level - a.level || (b.me - b.cpu) - (a.me - a.cpu) || b.longestRally - a.longestRally).slice(0, 7);
  $('bestList').innerHTML = rows.length
    ? rows.map(r => `<li><span class="who"><span class="line"><b>${esc(r.name)}</b> <em>beat ${PONG_LEVELS[r.level] ?? ''} NPC</em></span><i class="pong-x">longest rally ${r.longestRally}</i></span><b class="score">${r.me}–${r.cpu}</b></li>`).join('')
    : '<li class="hint">No wins yet. Be the first!</li>';
}

// ---------- scoreboard ----------
function renderBoard() {
  const me = P?.me ?? 0, cpu = P?.cpu ?? 0;
  bump($('scoreYou'), me); bump($('scoreCpu'), cpu);
  $('nameYou').textContent = P?.name || nameNow();
  $('nameCpu').textContent = `NPC · ${PONG_LEVELS[P?.level ?? game.level]}`;
  const srv = P && !P.done ? pongServer(me, cpu, P.firstServer) : -1;
  $('serveYou').style.visibility = srv === 0 ? 'visible' : 'hidden';
  $('serveCpu').style.visibility = srv === 1 ? 'visible' : 'hidden';
  $('levelChip').textContent = PONG_LEVELS[P?.level ?? game.level].toUpperCase();
  const gp = P && !P.done && (me >= 10 || cpu >= 10) && me !== cpu ? (me > cpu ? 'GAME POINT' : 'NPC GAME POINT') : me >= 10 && me === cpu ? 'DEUCE' : '';
  $('gameChip').textContent = gp; $('gameChip').classList.toggle('hidden', !gp);
}
function bump(el, v) {
  if (el.textContent === String(v)) return;
  el.textContent = v; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}

// ---------- flow ----------
function startPlay() {
  initAudioSafe(); sfx.ui();
  if (!P) return;
  if (P.done || P.level !== game.level) { newGame(); return; }
  showHud();
  nextPoint();
}
function newGame() {
  act('pongNew', { level: game.level });
  game.pendingSeq = (P?.seq ?? 0) + 1;
  game.perfects = 0;
  showHud();
  game.state = 'point'; game.t = 1.2;    // nextPoint once the database has reset the score
  ball.mode = 'hidden';
}
function showHud() {
  $('lobby').classList.remove('show');
  $('hud').classList.remove('hidden');
  $('endCard').classList.add('hidden');
}
function toLobby() {
  game.state = 'lobby';
  ball.mode = 'hidden';
  world.marker.hide();
  $('lobby').classList.add('show');
  $('hud').classList.add('hidden');
  $('endCard').classList.add('hidden');
}

/** Ready the next serve, once the database has the last point. */
function nextPoint() {
  if (!P) return;
  if (P.done) return showEnd();
  game.server = pongServer(P.me, P.cpu, P.firstServer);
  game.state = 'serve'; game.t = 0; game.rally = 0; game.pointPerfects = 0; game.sideStreak = 0;
  $('rallyChip').textContent = 'Rally 0';
  ball.mode = 'hold'; ball.path = null;
  world.marker.hide();
  setPrompt(game.server === 0 ? (net.tapMode ? '📱 Tap to serve' : '📱 Flick to serve!') : 'NPC to serve…');
  renderBoard();
}

function onPhone(e) {
  if (e.kind === 'tilt' || e.kind === 'swing') game.tilt = clamp(e.tilt, -1, 1);
  if (e.kind !== 'swing') return;
  game.lastSwing = elapsed; game.lastPower = clamp(e.power, 0, 1.2);
  game.swingAnim = 1; game.swingDir = sideOf(game.tilt) || 1;
  if (game.state === 'lobby') { if (net.phoneReady) startPlay(); return; }
  if (game.state === 'over') return playAgain();
  if (game.state === 'serve' && game.server === 0 && game.t > 0.4) return playerServe(game.lastPower);
  // A flick just after a block still turns it into a drive.
  const p = ball.path;
  if (game.state === 'rally' && ball.mode === 'path' && p?.from === 'you' && p.kind === 'block' && p.i === 0 && p.t < LATE_UPGRADE) {
    game.rally--;
    playerReturn('LATE', game.lastPower, ball.pos.clone());
  }
}

const sideOf = t => (t > SIDE_DEAD ? 1 : t < -SIDE_DEAD ? -1 : 0);
const sideName = s => (s > 0 ? 'FOREHAND' : 'BACKHAND');

// ---------- ball paths: parabolic segments between chosen points ----------
// A segment goes p0 → p1 in T seconds under gravity g (more g = more topspin dip).
const segPos = (s, t, out) => { out.lerpVectors(s.p0, s.p1, t / s.T); out.y += 0.5 * s.g * t * (s.T - t); return out; };
const segVel = (s, t, out) => { out.subVectors(s.p1, s.p0).divideScalar(s.T); out.y += 0.5 * s.g * (s.T - 2 * t); return out; };
const V = (x, y, z) => new THREE.Vector3(x, y, z);
function seg(p0, p1, T, g, end) {
  // Stretch the flight until it clears the net.
  if (p0.z * p1.z < 0) {
    for (let k = 0; k < 20; k++) {
      const tn = T * (-p0.z) / (p1.z - p0.z);
      const y = p0.y + (p1.y - p0.y) * (tn / T) + 0.5 * g * tn * (T - tn);
      if (y >= TOP + NET_H + BALL_R + 0.03) break;
      T *= 1.07;
    }
  }
  return { p0: p0.clone(), p1: p1.clone(), T, g, end };
}
function launchPath(from, segs, extra = {}) {
  ball.path = { from, segs, i: 0, t: 0, ...extra };
  ball.mode = 'path';
}
const bounceY = TOP + BALL_R;

/** The NPC's shot to one of the player's sides (or an error). */
function npcShot(start, { serve = false, quality = 0, attacked = false } = {}) {
  const L = LV[P?.level ?? game.level];
  const fast = serve ? 1.1 : Math.max(0.8, 1 - game.rally * 0.012) * (attacked ? 0.84 : 1);
  // Mostly alternate sides; on Easy never more than two in a row on one side.
  let side = Math.random() < 0.5 ? 1 : -1;
  if (game.sideStreak >= 2 || (game.lastSide && Math.random() < 0.55)) side = -game.lastSide || side;
  game.sideStreak = side === game.lastSide ? game.sideStreak + 1 : 1; game.lastSide = side;
  const cx = side * rand(0.3, 0.6), cy = rand(0.9, 1.02);
  const bz = rand(0.75, 1.1);
  const segs = [];
  let p = start;
  if (serve) { const b = V(start.x * 0.6, bounceY, -0.75); segs.push(seg(p, b, 0.34, G, 'bounce')); p = b; }
  const b = V(cx * 0.82, bounceY, bz);
  segs.push(seg(p, b, (serve ? 0.5 : 0.56) * L.speed * fast, G + (attacked ? 7 : quality * 3), 'bounce'));
  segs.push(seg(b, V(cx, cy, HIT_Z), 0.44 * L.speed * fast, G, 'contact'));
  launchPath('cpu', segs, { kind: attacked ? 'smash' : 'push', side });
  if (attacked) { callout('SMASH!', '#ff4f8b', ''); }
  // Where it lands on your side, coloured by the stroke it needs
  world.marker.show(b.x, b.z, side > 0 ? 0xf23545 : 0x1f8bff);
  cue(side, L.cue);
  npc.swing = 1;
  sfx.paddle(attacked ? 1 : 0.5);
}
/** NPC miss: into the net, long or wide. */
function npcError(start) {
  const r = Math.random();
  if (r < 0.5) {
    launchPath('cpu', [seg(start, V(start.x * 0.5, TOP + NET_H * 0.55, -0.02), 0.32, G, 'net')], { kind: 'error' });
    game.why = 'NPC hit the net';
  } else {
    const wide = r > 0.8;
    const end = V(wide ? Math.sign(start.x || 1) * (HALF_W + 0.35) : start.x * 0.5, bounceY + 0.05, wide ? 0.7 : HALF_L + 0.35);
    launchPath('cpu', [seg(start, end, 0.5, G, 'out')], { kind: 'error' });
    game.why = wide ? 'NPC went wide' : 'NPC hit it long';
  }
  npc.swing = 1;
  sfx.paddle(0.5);
}

function playerServe(power) {
  if (game.state !== 'serve') return;
  game.state = 'rally';
  const start = paddleContact();
  const tx = -(Math.sign(npc.paddleX) || 1) * rand(0.25, 0.5);
  const b1 = V(start.x * 0.6, bounceY, 0.7), b2 = V(tx, bounceY, -rand(0.8, 1.05));
  const T = 0.52 - clamp(power, 0, 1.2) * 0.1;
  launchPath('you', [seg(start, b1, 0.3, G, 'bounce'), seg(b1, b2, T, G, 'bounce'), seg(b2, V(tx * 1.2, rand(0.92, 1), -HIT_Z), 0.4, G, 'contact')], { kind: 'serve', quality: 0.15 });
  npc.target = tx * 1.2;
  world.marker.hide();
  setPrompt('');
  sfx.paddle(0.5 + power * 0.3);
  world.burst(start, 0xffffff, 0.08);
}

/** Our return: a drive (with a flick) or a block (tilt only). */
function playerReturn(grade, power, from) {
  const drive = grade !== 'BLOCK';
  const q = grade === 'PERFECT' ? 1 : grade === 'GOOD' ? 0.6 : grade === 'LATE' ? 0.3 : 0;
  const pw = drive ? clamp(power, 0.15, 1.2) : 0;
  const away = -(Math.sign(npc.paddleX) || (Math.random() < 0.5 ? -1 : 1));
  const tx = drive ? away * clamp(0.22 + 0.36 * q + rand(0, 0.1), 0, 0.68) : rand(-0.28, 0.28);
  const tz = drive ? -(0.8 + 0.35 * q + rand(0, 0.1)) : -rand(0.6, 0.95);
  const T1 = drive ? 0.5 - 0.15 * pw - 0.06 * q : 0.64;
  const T2 = drive ? 0.34 - 0.05 * q : 0.5;
  const gv = drive ? G + 6 * pw : G;
  const b = V(tx, bounceY, tz), c = V(clamp(tx * 1.25, -0.95, 0.95), rand(0.9, 1.02), -HIT_Z);
  const quality = drive ? clamp(0.3 + 0.5 * q + 0.2 * pw, 0, 1) : 0;
  launchPath('you', [seg(from, b, T1, gv, 'bounce'), seg(b, c, T2, G, 'contact')], { kind: drive ? 'drive' : 'block', quality, grade });
  npc.target = c.x;
  game.rally++;
  game.state = 'rally';
  world.marker.hide();
  cue(0, false);
  $('rallyChip').textContent = `Rally ${game.rally}`;
  if (grade === 'PERFECT') { game.perfects++; game.pointPerfects++; }
  // Feedback: the grade over the paddle, a burst, the crowd
  sfx.paddle(drive ? 0.45 + pw * 0.5 : 0.3);
  world.burst(from, grade === 'PERFECT' ? 0xffc61a : drive ? 0xffffff : 0x8fb8ff, grade === 'PERFECT' ? 0.13 : 0.09);
  if (grade === 'PERFECT') { world.flash(0.5); world.cheer(0.4); }
  hitText(grade === 'BLOCK' ? `${sideName(ball.hitSide)} BLOCK` : grade === 'LATE' ? `LATE ${sideName(ball.hitSide)}` : `${grade === 'PERFECT' ? 'PERFECT' : 'GOOD'} ${sideName(ball.hitSide)}!`, grade);
  if (game.rally > 0 && game.rally % 10 === 0) { callout(`${game.rally} RALLY!`, '#ffc61a', '🔥 Keep it going'); world.cheer(0.8); }
}

// The ball reached the end of a segment.
function onSegEnd(p, s) {
  if (s.end === 'bounce') {
    sfx.pock(1, s.p1.z > 0 ? 1 : 0.92);
    world.burst(V(s.p1.x, TOP + 0.003, s.p1.z), 0xffffff, 0.06);
    if (p.from === 'cpu' && s.p1.z > 0) world.marker.hide();
  } else if (s.end === 'contact') {
    if (p.from === 'cpu') playerContact(); else npcContact();
  } else if (s.end === 'net') {
    sfx.net();
    ball.mode = 'free'; ball.freeT = 0; ball.vel.set(0, -0.3, 0.4);
    endPoint(p.from === 'cpu', game.why || 'Into the net');
  } else if (s.end === 'out') {
    endPoint(p.from === 'cpu', game.why || 'Out');
  }
}

function playerContact() {
  const want = ball.pos.x >= 0 ? 1 : -1, have = sideOf(game.tilt);
  ball.hitSide = want;
  if (have !== want) {
    // Missed: it flies on past the paddle.
    const why = have === 0 ? 'Tilt left or right to hit!' : `That was your ${sideName(want)}!`;
    game.why = have === 0 ? 'No paddle side' : `Wrong side: it was a ${sideName(want).toLowerCase()}`;
    endPoint(false, game.why, 0.15, ['MISSED!', why]);
    return;
  }
  ball.mode = 'stuck'; ball.stuckT = 0; ball.contactAt = elapsed;
}

/** End of the hit-stop: drive if a flick came in around contact, block otherwise. */
function resolveHit() {
  const dt = game.lastSwing - ball.contactAt;     // flicks arrive ~0.1 s after they happen
  let grade = 'BLOCK';
  if (dt > -SWING_EARLY && dt <= HOLD + 0.01) grade = Math.abs(dt - 0.06) < 0.16 ? 'PERFECT' : 'GOOD';
  playerReturn(grade, game.lastPower, ball.pos.clone());
}

function npcContact() {
  const p = ball.path, L = LV[P?.level ?? game.level];
  const reach = Math.abs(npc.paddleX - ball.pos.x) < 0.16;
  if (!reach) {
    game.why = p.kind === 'serve' ? 'Ace!' : p.grade === 'PERFECT' ? 'Unreturnable!' : 'Too wide for the NPC';
    endPoint(true, game.why);
    return;
  }
  const errChance = L.err + p.quality * p.quality * 0.3;
  if (Math.random() < errChance) return npcError(ball.pos.clone());
  // A soft block gets punished now and then.
  const attacked = p.kind === 'block' && Math.random() < 0.25 + (P?.level ?? 0) * 0.15;
  npcShot(ball.pos.clone(), { quality: p.quality, attacked });
}

function npcServe() {
  if (game.state !== 'serve') return;
  game.state = 'rally';
  setPrompt('');
  npcShot(V(npc.paddleX, 0.98, -HALF_L - 0.12), { serve: true });
}

/** A point is over: show it now, then tell the database. */
function endPoint(won, why, delay = 0, shout = null) {
  if (game.state === 'point') return;
  game.state = 'point'; game.t = -delay;
  world.marker.hide();
  cue(0, false);
  if (P) { game.pendingSeq = P.seq + 1; act('pongPoint', { won, rally: game.rally, perfects: game.pointPerfects, why }); }
  setPrompt('');
  if (won) {
    const big = game.rally >= 8;
    callout(big ? 'WHAT A RALLY!' : 'POINT!', '#ffc61a', why);
    sfx.point(); sfx.cheer(big ? 0.8 : 0.35); world.cheer(big ? 1 : 0.6);
    world.confetti.burst(V(0, 1.1, -0.6), big ? 1 : 0.5);
  } else {
    if (shout) callout(shout[0], '#ffffff', shout[1]); else callout('NPC POINT', '#ffffff', why);
    sfx.lose();
  }
}

function onGame() {
  renderBoard();
}

function showEnd() {
  game.state = 'over';
  ball.mode = 'hidden';
  setPrompt('');
  cue(0, false);
  const won = P.me > P.cpu;
  $('endTitle').textContent = won ? (P.cpu <= 3 ? 'DOMINATION! 🏓' : 'YOU WIN! 🏆') : 'NPC WINS';
  $('endCard').classList.toggle('lost', !won);
  $('endMe').textContent = P.me; $('endCpu').textContent = P.cpu;
  $('endMeName').textContent = P.name || nameNow(); $('endCpuName').textContent = `NPC · ${PONG_LEVELS[P.level]}`;
  $('endSideMe').classList.toggle('won', won); $('endSideCpu').classList.toggle('won', !won);
  $('endStats').innerHTML = `<span><b>${P.longestRally}</b> longest rally</span><span><b>${P.perfects}</b> perfect hit${P.perfects === 1 ? '' : 's'}</span>`;
  const card = $('endCard');
  card.classList.remove('hidden', 'go'); void card.offsetWidth; card.classList.add('go');
  if (won) { sfx.win(); world.confetti.burst(V(0, 1.2, 0), 1.4); world.cheer(1); } else sfx.lose();
}
function playAgain() {
  initAudioSafe(); sfx.ui();
  $('endCard').classList.add('hidden');
  newGame();
}

// ---------- HUD text ----------
function callout(text, color, sub = '') {
  const el = $('bigCallout'), s = $('bigSub');
  el.textContent = text; el.style.color = color;
  s.textContent = sub;
  for (const x of [el, s]) { x.classList.remove('go'); void x.offsetWidth; x.classList.add('go'); }
}
function hitText(text, grade) {
  const el = $('hitText');
  el.textContent = text;
  el.className = `hit-text ${grade.toLowerCase()}`;
  void el.offsetWidth; el.classList.add('go');
}
function setPrompt(t) { $('prompt').textContent = t; $('prompt').classList.toggle('hidden', !t); }
/** Easy level: light up the stroke the incoming ball needs. */
function cue(side, on) {
  $('sideFh').classList.toggle('cue', on && side > 0);
  $('sideBh').classList.toggle('cue', on && side < 0);
}

// ---------- keys, name, buttons ----------
// The phone is the only controller; Esc returns to the lobby.
window.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement) { if (e.key === 'Enter') e.target.blur(); return; }
  if (e.key === 'Escape' && game.state !== 'lobby') toLobby();
});
const nameNow = () => $('nameInput').value.trim() || 'Player';
$('nameInput').value = (() => { try { return localStorage.getItem('racket.name') || ''; } catch { return ''; } })() || 'Player';
$('nameInput').addEventListener('change', () => {
  try { localStorage.setItem('racket.name', nameNow()); } catch { /* storage unavailable */ }
  act('setName', { name: nameNow() });
  renderBoard();
});
for (const b of document.querySelectorAll('#levelSeg button')) {
  b.addEventListener('click', () => {
    game.level = Number(b.dataset.level); sfx.ui();
    try { localStorage.setItem('racket.pongLevel', String(game.level)); } catch { /* storage unavailable */ }
    renderLobby(); renderBoard();
  });
}
$('btnStart').addEventListener('click', startPlay);
$('btnNewGame').addEventListener('click', () => { initAudioSafe(); sfx.ui(); newGame(); });
$('btnHome').addEventListener('click', () => { sfx.ui(); toLobby(); });
$('btnAgain').addEventListener('click', playAgain);
$('btnEndLobby').addEventListener('click', () => { sfx.ui(); toLobby(); });
for (const a of document.querySelectorAll('a[href="/"]')) a.addEventListener('click', () => act('leaveMatch'));
window.addEventListener('pointerdown', initAudioSafe, { once: true });
function initAudioSafe() { try { initAudio(); } catch { /* audio unavailable */ } }

// ---------- main loop ----------
const clock = new THREE.Clock();
let elapsed = 0, perfT = 0, perfN = 0, renderScale = Math.min(window.devicePixelRatio, 1.5);
const camPos = new THREE.Vector3(0, 1.6, 3.2), camLook = new THREE.Vector3(0, 0.8, -1);
const camTarget = new THREE.Vector3(), lookTarget = new THREE.Vector3();
const tmp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();

/** Where the player's paddle meets the ball right now. */
function paddleContact() { return V(paddleX(), 0.97, HIT_Z); }
let padX = 0.3;
function paddleX() { return padX; }

function stepBall(dt) {
  if (ball.mode === 'path') {
    const p = ball.path;
    p.t += dt;
    while (ball.mode === 'path' && ball.path === p && p.t >= p.segs[p.i].T) {
      const s = p.segs[p.i];
      p.t -= s.T;
      segPos(s, s.T, ball.pos);
      onSegEnd(p, s);
      if (ball.path !== p || ball.mode !== 'path') return;
      p.i++;
      if (p.i >= p.segs.length) {
        // Nobody hit it: it flies on.
        segVel(s, s.T, ball.vel); ball.mode = 'free'; ball.freeT = 0;
        return;
      }
    }
    if (ball.mode === 'path' && ball.path === p) segPos(p.segs[p.i], p.t, ball.pos);
  } else if (ball.mode === 'free') {
    ball.freeT += dt;
    ball.vel.y -= G * dt;
    ball.pos.addScaledVector(ball.vel, dt);
    const onTable = Math.abs(ball.pos.x) < HALF_W && Math.abs(ball.pos.z) < HALF_L;
    const floorY = onTable && ball.pos.y > TOP - 0.05 ? bounceY : BALL_R;
    if (ball.pos.y < floorY && ball.vel.y < 0) {
      ball.pos.y = floorY; ball.vel.y *= -0.62; ball.vel.x *= 0.8; ball.vel.z *= 0.8;
      if (Math.abs(ball.vel.y) > 0.4) sfx.pock(Math.min(1, Math.abs(ball.vel.y) / 3) * 0.6, floorY < 0.1 ? 0.7 : 1);
    }
    if (ball.freeT > 2.5) ball.mode = 'hidden';
  } else if (ball.mode === 'stuck') {
    ball.stuckT += dt;
    if (ball.stuckT >= HOLD) resolveHit();
  }
}

function update(dt) {
  game.t += dt;
  game.tiltShown += (game.tilt - game.tiltShown) * Math.min(1, dt * 14);
  game.swingAnim = Math.max(0, game.swingAnim - dt * 4);
  npc.swing = Math.max(0, npc.swing - dt * 3.5);

  if (game.state === 'serve') {
    if (game.server === 1 && game.t > 1.3) npcServe();
  } else if (game.state === 'point') {
    if (game.t > 1.7 && P && P.seq >= game.pendingSeq) nextPoint();
  }
  stepBall(dt);

  // Ball in hand before a serve
  if (game.state === 'serve' && ball.mode === 'hold') {
    const toss = Math.abs(Math.sin(elapsed * 2.6)) * 0.12;
    if (game.server === 0) ball.pos.set(padX - 0.04, 1.02 + toss, HIT_Z - 0.06);
    else ball.pos.set(npc.paddleX + 0.05, 1.02 + toss, -HALF_L - 0.12);
  }

  // Player paddle: follows the tilt; once it's on the ball's side it reaches for the ball.
  const side = sideOf(game.tiltShown);
  let wantX = game.tiltShown * 0.55;
  const p = ball.path;
  if (ball.mode === 'path' && p?.from === 'cpu' && p.kind !== 'error') {
    const c = p.segs[p.segs.length - 1].p1;
    if (side !== 0 && side === Math.sign(c.x)) {
      const left = p.segs.slice(p.i).reduce((a, s) => a + s.T, 0) - p.t;
      wantX = THREE.MathUtils.lerp(c.x, wantX, clamp(left / 0.8, 0, 1));
    }
  }
  if (ball.mode === 'stuck') wantX = ball.pos.x;
  padX += (wantX - padX) * Math.min(1, dt * 16);
  const pad = world.paddle;
  const yawWant = game.tiltShown >= 0 ? 0.25 : Math.PI - 0.25;
  game.yaw += (yawWant - game.yaw) * Math.min(1, dt * 14);
  const sw = Math.sin(game.swingAnim * Math.PI);
  const padY = ball.mode === 'stuck' ? ball.pos.y - 0.115 : 0.86;
  pad.position.set(padX, padY - sw * 0.04, HIT_Z + 0.03 - sw * 0.16);
  pad.rotation.set(-0.25 - sw * 0.5, game.yaw + game.swingDir * sw * 0.7, -game.tiltShown * 0.55);
  pad.visible = game.state !== 'lobby';

  // NPC: slides along the baseline towards where the ball will be.
  const L = LV[P?.level ?? game.level];
  if (ball.mode === 'path' && ball.path.from === 'you') npc.target = ball.path.segs[ball.path.segs.length - 1].p1.x;
  else if (game.state !== 'rally') npc.target = game.server === 1 && game.state === 'serve' ? 0.25 : 0;
  const step = L.npcSpeed * dt;
  npc.paddleX += clamp(npc.target - npc.paddleX, -step, step);
  npc.x += (npc.paddleX * 0.7 - npc.x) * Math.min(1, dt * 6);
  const nsw = Math.sin(npc.swing * Math.PI);
  const g = world.npc.group;
  g.position.set(npc.x, Math.abs(Math.sin(elapsed * 5)) * 0.015, -HIT_Z - 0.45);
  g.rotation.y = clamp((npc.paddleX - npc.x) * 0.6, -0.4, 0.4);
  world.npc.head.rotation.y = clamp((ball.pos.x - npc.x) * 0.5, -0.5, 0.5);
  const np = world.npcPaddle;
  np.position.set(npc.paddleX, 0.9 + nsw * 0.06, -HIT_Z - 0.03 + nsw * 0.14);
  np.rotation.set(0.25 + nsw * 0.4, Math.PI + (npc.paddleX < npc.x ? 0.3 : -0.3), (npc.paddleX - npc.x) * 0.8);
  // Arm from shoulder to paddle handle
  const sh = tmp.set(npc.x + (npc.paddleX >= npc.x ? 0.22 : -0.22), 1.3, -HIT_Z - 0.42);
  const hand = V(npc.paddleX, 0.9 + nsw * 0.06, -HIT_Z - 0.06);
  dir.subVectors(hand, sh);
  const arm = world.npc.arm;
  arm.position.copy(sh).addScaledVector(dir, 0.5).sub(g.position);
  arm.position.applyAxisAngle(up, -g.rotation.y);
  arm.quaternion.setFromUnitVectors(up, dir.clone().applyAxisAngle(up, -g.rotation.y).normalize());
  arm.scale.y = clamp(dir.length() / 0.46, 0.6, 1.6);

  world.setBall(ball.pos, ball.mode !== 'hidden', ball.mode === 'path' || ball.mode === 'free');

  // HUD side meter
  $('sideDot').style.left = `${50 + game.tiltShown * 46}%`;
  const hs = sideOf(game.tilt);
  $('sideFh').classList.toggle('on', hs > 0);
  $('sideBh').classList.toggle('on', hs < 0);
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;
  update(dt);
  world.update(elapsed, dt);

  // Camera: behind your end of the table, leaning a little with the ball.
  if (game.state === 'lobby') {
    const a = elapsed * 0.12;
    camTarget.set(Math.sin(a) * 4.2, 2.2, Math.cos(a) * 4.2); lookTarget.set(0, TOP, 0);
  } else {
    const bx = ball.mode === 'hidden' ? 0 : clamp(ball.pos.x, -0.8, 0.8);
    camTarget.set(bx * 0.18 + game.tiltShown * 0.05, 1.52, HALF_L + 1.5); lookTarget.set(bx * 0.25, 0.82, -1.1);
  }
  const ck = Math.min(1, dt * (game.state === 'lobby' ? 1.2 : 3));
  camPos.lerp(camTarget, ck); camLook.lerp(lookTarget, ck);
  world.camera.position.copy(camPos);
  world.camera.lookAt(camLook);

  perfT += dt; perfN++;
  if (perfT > 1.5) {
    if (perfT / perfN > 1 / 48 && renderScale > 0.75) { renderScale -= 0.25; world.setPixelRatio(renderScale); }
    perfT = perfN = 0;
  }
  world.render();
}
renderBoard();
setPrompt('');
requestAnimationFrame(frame);

// Test hook
window.__pong = { game, ball, npc, net, get P() { return P; }, onPhone, startPlay, playerServe };
