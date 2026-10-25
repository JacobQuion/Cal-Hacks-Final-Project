import * as THREE from 'three';
import QRCode from 'qrcode';
import { createPongWorld, HALF_L, HALF_W, TOP, NET_H, BALL_R } from './pong-scene.js';
import { pongServer, PONG_LEVELS } from '../spacetimedb/src/pong.ts';
import { initAudio, sfx } from './audio.js';
import { connect, call, tables } from './stdb.js';
import { createVideoCall } from './video.js';

// Ping pong: the phone is the paddle. Swing it right for a forehand, left for a backhand: if the paddle
// is on the side the ball comes to, it hits. A flick as the ball arrives turns the block into a drive.
// Paddle side and flicks arrive through SpacetimeDB (pong_input); the rally runs here and each point goes to
// the database (pong_point), which keeps score and ends the game at 11.
// 1v1 (mode = pongvs): each laptop draws the table from its own end. A hit goes to the other laptop as
// its flight (pong_hit → pong_shot); the receiving laptop plays it, judges its own player's return and,
// on a miss, reports the point. The two laptops are on a video call, as in badminton.

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const first = it => { for (const x of it) return x; return undefined; };
const rand = (a, b) => a + Math.random() * (b - a);
const G = 9.81;

const HIT_Z = HALF_L + 0.25;      // where the player's paddle meets the ball (the NPC's is at −HIT_Z)
const SIDE_DEAD = 0.12;           // tilt inside this counts as neither side
const HOLD = 0.06;                // brief hit-stop on contact; a flick that lands in it still counts
const SWING_EARLY = 0.8;          // a flick this long before contact still hits (and drives)
const LATE_UPGRADE = 0.4;         // a flick this soon after a block still upgrades it
const GRACE = 0.4;                // a paddle side or flick that arrives this soon after contact still hits
// speed scales flight times (bigger = slower); centre = what a paddle held in the middle does.
const LV = [
  { speed: 1.18, err: 0.17, npcSpeed: 2.6, cue: true, centre: 'block' },
  { speed: 0.97, err: 0.1, npcSpeed: 3.3, cue: false, centre: 'block' },
  { speed: 0.8, err: 0.055, npcSpeed: 4.0, cue: false, centre: 'miss' },
];
const VS = { speed: 0.97, centre: 'block', npcSpeed: 4.5 };   // 1v1: Medium pace; npcSpeed moves the opponent's avatar
const IDLE_SERVE = 15;                          // 1v1: auto serve after this long
// 1v1 lag hiding: the other laptop starts our shot only when it arrives, and its return takes the same trip
// back, so our ball would sit at their paddle for a round trip. Instead we play our own shot slower by
// about that much (learned from how long we actually waited), so their return lands as our ball gets there.
const LAG = { est: 0.35, min: 0, max: 1.2, learn: 0.5 };

const world = createPongWorld($('game'));
const params = new URLSearchParams(location.search);
const net = { conn: null, matchId: 0, code: '', seat: 0, vs: false, joining: false, phoneConnected: false, phoneReady: false, tapMode: false };
let P = null;              // this table's pong_game row
let M = null;              // its match row
const game = {
  state: 'lobby',          // lobby | countdown | serve | rally | point | paused | over
  level: (() => { try { return clamp(Number(localStorage.getItem('racket.pongLevel')) || 0, 0, 2); } catch { return 0; } })(),
  tilt: 0, tiltShown: 0,
  lastSwing: -9, lastPower: 0.6,
  rally: 0, perfects: 0, pointPerfects: 0,
  server: 0, t: 0, pendingSeq: -1, why: '',
  swingAnim: 0, swingDir: 1, yaw: 0,
  sideStreak: 0, lastSide: 0,
};
// mode: hidden | hold | path | free | grace | stuck | wait (1v1: at the opponent's paddle, waiting for their return)
const ball = { pos: new THREE.Vector3(0, -5, 0), vel: new THREE.Vector3(), mode: 'hidden', path: null, freeT: 0, stuckT: 0, contactAt: 0, hitSide: 1, graceT: 0, waitT: 0 };
const npc = { x: 0, paddleX: 0.3, target: 0.3, swing: 0 };

// Seat-relative views of the table: "me" is this laptop's player, "opp" the NPC or player 2.
const myScore = () => (net.seat === 1 ? P?.cpu : P?.me) ?? 0;
const oppScore = () => (net.seat === 1 ? P?.me : P?.cpu) ?? 0;
const myName = () => (net.vs && M ? (net.seat === 0 ? M.nameA : M.nameB) : P?.name) || nameNow();
const oppName = () => (net.vs ? (M && (net.seat === 0 ? M.nameB : M.nameA)) || 'Player 2' : `NPC · ${PONG_LEVELS[P?.level ?? game.level]}`);
const oppShort = () => (net.vs ? oppName() : 'NPC');
const lv = () => (net.vs ? VS : LV[P?.level ?? game.level]);
const myReady = () => !!M && (net.seat === 0 ? M.readyA : M.readyB);

// Picked on the main menu (?play=solo&level=N or ?play=vs): the table is set up the moment the socket
// opens, so the QR doesn't wait for the full sync. A reload (param gone) resumes whatever we're in.
const intent = params.get('play');
if (params.has('level')) {
  game.level = clamp(Number(params.get('level')) || 0, 0, 2);
  try { localStorage.setItem('racket.pongLevel', String(game.level)); } catch { /* storage unavailable */ }
}
if (intent) {
  for (const k of ['play', 'level']) params.delete(k);
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
}
setModeBanner(intent === 'vs');

// ---------- SpacetimeDB ----------
const say = (msg, ms = 2400) => {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(say.t); say.t = setTimeout(() => t.classList.remove('show'), ms);
};
const act = (name, args = {}) => call(net.conn, name, args, say);

connect({
  subs: [tables.match, tables.device, tables.myDevice, tables.pongGame, tables.pongInput, tables.pongShot, tables.noticeEvent, tables.myRtc, tables.myFrame],
  wire(conn) {
    net.conn = conn;
    for (const t of ['match', 'device', 'myDevice']) {
      conn.db[t].onInsert(queueRefresh); conn.db[t].onDelete(queueRefresh); conn.db[t].onUpdate?.(queueRefresh);
    }
    conn.db.pongGame.onInsert(queueRefresh);
    conn.db.pongGame.onUpdate?.((_c, o, row) => { if (row.matchId === net.matchId) { P = row; onGame(o); } queueRefresh(); });
    conn.db.pongInput.onInsert((_c, e) => { if (e.matchId === net.matchId && e.seat === net.seat) onPhone(e); });
    conn.db.pongShot.onInsert((_c, e) => { if (net.vs && e.matchId === net.matchId && e.seat !== net.seat) onOppShot(e); });
    conn.db.noticeEvent.onInsert((_c, e) => { if (e.matchId === net.matchId) say(e.text); });
    conn.db.myRtc.onInsert((_c, row) => video.receive(row));
    conn.db.myFrame.onInsert((_c, row) => video.frame(row));
    conn.db.myFrame.onUpdate?.((_c, _o, row) => video.frame(row));
  },
  onOpen(conn) {
    if (!intent || net.intentSent) return;
    net.intentSent = true; net.conn = conn;
    if (intent === 'vs') act('createVersus', { sport: 'pong', name: nameNow() }); else startSolo();
  },
  onReady(conn) {
    net.conn = conn;
    act('setName', { name: nameNow() });
    // Same tab, same identity: a reload keeps the table (and the paired phone), or the 1v1 we're in.
    const d = first(conn.db.myDevice.iter());
    const m = d && d.matchId ? [...conn.db.match.iter()].find(x => x.id === d.matchId) : null;
    const join = (params.get('join') || '').toUpperCase();
    if (join) {
      params.delete('join'); history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
      joinCode(join, !(m && (m.mode === 'pong' || m.mode === 'pongvs')));
    } else if (!net.intentSent && !(m && ((m.mode === 'pong' && m.status === 'lobby') || m.mode === 'pongvs'))) startSolo();
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
  // Joined a code that turned out to be another sport: that page runs it (same tab, same identity).
  if (net.joining && m && m.mode !== 'pong' && m.mode !== 'pongvs') { location.replace(m.mode === 'bowlvs' ? '/bowling.html' : '/'); return; }
  const ours = m && (m.mode === 'pong' || m.mode === 'pongvs') ? m : null;
  if (ours?.mode === 'pongvs') net.joining = false;
  M = ours;
  net.vs = ours?.mode === 'pongvs';
  net.seat = ours && d.seat !== 255 ? d.seat : 0;
  net.matchId = ours ? ours.id : 0;
  net.code = ours ? ours.code : '';
  P = ours ? conn.db.pongGame.matchId.find(ours.id) ?? null : null;
  const ph = ours && [...conn.db.device.iter()].find(x => x.kind === 'phone' && x.matchId === ours.id && x.seat === net.seat);
  net.phoneConnected = !!(ph && ph.online);
  net.phoneReady = !!(ph && ph.online && ph.ready);
  net.tapMode = !!(ph && ph.tapMode);
  renderLobby();
  renderBoard();
  applyVersus();
  syncVideo();
}

const startSolo = () => act('startPong', { name: nameNow(), level: game.level });
/** Join a 1v1 by code; `fallback` opens a solo table if that fails and we have nothing else. */
function joinCode(code, fallback) {
  code = code.trim().toUpperCase();
  if (!code) return;
  net.joining = true;
  call(net.conn, 'joinMatch', { code, name: nameNow() }, e => { net.joining = false; say(e); if (fallback) startSolo(); });
}

// Face-to-face video for 1v1s, exactly as in badminton: signaling through SpacetimeDB, media peer to peer.
const video = createVideoCall({
  send: data => call(net.conn, 'rtcSignal', { data }, e => console.warn('video signal:', e)),
  ack: upTo => call(net.conn, 'rtcAck', { upTo }, () => {}),
  sendFrame: data => net.conn?.reducers.rtcSendFrame({ data }),
});
function syncVideo() {
  if (!net.vs || !M) { video.sync(null); return; }
  const opp = net.seat === 0 ? M.laptopB : M.laptopA;
  video.sync({ matchId: M.id, seat: net.seat, oppKey: opp || '', oppName: opp ? oppName() : '', myName: myName() });
  dockVideo(game.state === 'lobby');
}
// In the lobby the call is a third card in the row; in play it floats on the right.
function dockVideo(dock) {
  const panel = $('videoPanel'), home = dock ? $('lobby').querySelector('.menu-row') : document.body;
  if (panel.parentNode === home) return;
  home.appendChild(panel);
  panel.classList.toggle('docked', dock);
  for (const v of panel.querySelectorAll('video')) if (v.srcObject) v.play().catch(() => {});
}

// 1v1: the match row drives the screens (lobby → countdown → playing ⇄ paused → over).
let vsStatus = '';
function applyVersus() {
  const st = net.vs && M ? M.status : '';
  $('pause').classList.toggle('show', st === 'paused');
  if (st === 'paused') $('pauseReason').textContent = M.pausedReason;
  if (st === vsStatus) return;
  const prev = vsStatus;
  vsStatus = st;
  if (!st) return;
  if (st === 'lobby') { if (game.state !== 'lobby') toLobby(); }
  else if (st === 'countdown') startCountdown();
  else if (st === 'playing') { showHud(); nextPoint(); }
  else if (st === 'paused') { game.state = 'paused'; ball.mode = 'hidden'; world.marker.hide(); setPrompt(''); cue(0, false); }
  else if (st === 'over') {
    // A finished game ends through its last point; a forfeit (or a reload) ends right away.
    if (!P?.done || prev === '' || game.state === 'lobby' || game.state === 'paused') { showHud(); showEnd(); }
  }
}

let countdownTimer = 0;
function startCountdown() {
  initAudioSafe();
  showHud();
  game.state = 'countdown'; ball.mode = 'hidden';
  setPrompt('');
  let n = 3;
  clearTimeout(countdownTimer);
  const tick = () => {
    if (game.state !== 'countdown') return;
    callout(n > 0 ? String(n) : 'GO!', n > 0 ? '#ffffff' : '#ffc61a', n === 3 ? `vs ${oppName()}` : '');
    sfx.ui();
    if (n-- > 0) countdownTimer = setTimeout(tick, 1000);
  };
  tick();
}

// ---------- lobby ----------
function publicBase() { return (import.meta.env.VITE_PUBLIC_URL || location.origin).replace(/\/$/, ''); }
let qrKey = '';
function renderLobby() {
  $('tableCode').textContent = net.code || '····';
  if (net.code) {
    const url = `${publicBase()}/phone.html?code=${net.code}&seat=${net.seat}&game=pong`;
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

  const mid = !net.vs && !!(P && !P.done && P.me + P.cpu > 0);
  $('btnNewGame').classList.toggle('hidden', !mid);
  for (const b of document.querySelectorAll('#levelSeg button')) b.classList.toggle('on', Number(b.dataset.level) === game.level);
  for (const id of ['levelSeg', 'btnVersus', 'joinRow']) $(id).classList.toggle('hidden', net.vs);
  for (const id of ['vsPlayers', 'btnSolo']) $(id).classList.toggle('hidden', !net.vs);
  $('btnCopy').classList.toggle('hidden', !net.vs || !!M?.laptopB);
  $('codeLabel').textContent = net.vs ? 'Match' : 'Table';
  setModeBanner(net.code ? net.vs : intent === 'vs');
  if (net.vs && M) {
    const row = (name, ready, isMe) => `<div class="pl ${ready ? 'ready' : ''}"><span>${esc(name || 'Waiting for player 2…')}${isMe ? ' (you)' : ''}</span><b>${name ? (ready ? '✔ Ready' : '…') : ''}</b></div>`;
    $('vsPlayers').innerHTML = row(M.nameA, M.readyA, net.seat === 0) + row(M.nameB, M.readyB, net.seat === 1);
    // The phone is the paddle: no paired, calibrated phone, no match (the server refuses it too).
    const noPhone = !net.phoneReady && !myReady();
    $('btnStart').disabled = noPhone;
    $('btnStart').textContent = noPhone ? (net.phoneConnected ? '📱 Calibrating phone…' : '📱 Pair your phone first')
      : myReady() ? '✖ Not ready' : M.laptopB ? '✋ Ready' : '✋ Ready (waiting for player 2)';
    return;
  }
  $('btnStart').textContent = !net.phoneReady ? '📱 Pair your phone to play' : mid ? `▶ Resume (${P.me} – ${P.cpu})` : '▶ Start game';
  $('btnStart').disabled = !P || !net.phoneReady;
}
/** Solo or doubles, in big letters at the top of the lobby. */
function setModeBanner(vs) {
  const b = $('modeBanner');
  b.classList.toggle('doubles', vs);
  b.innerHTML = vs ? '<b>👥 DOUBLES</b><span>1v1 against a friend</span>' : `<b>🤖 SOLO</b><span>vs the NPC · ${PONG_LEVELS[game.level]}</span>`;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------- scoreboard ----------
function renderBoard() {
  const me = myScore(), cpu = oppScore();
  bump($('scoreYou'), me); bump($('scoreCpu'), cpu);
  $('nameYou').textContent = myName();
  $('nameCpu').textContent = oppName();
  const srvSeat = P && !P.done ? pongServer(P.me, P.cpu, P.firstServer) : -1;
  $('serveYou').style.visibility = srvSeat >= 0 && srvSeat === net.seat ? 'visible' : 'hidden';
  $('serveCpu').style.visibility = srvSeat >= 0 && srvSeat !== net.seat ? 'visible' : 'hidden';
  $('levelChip').textContent = net.vs ? '1V1' : PONG_LEVELS[P?.level ?? game.level].toUpperCase();
  const gp = P && !P.done && (me >= 10 || cpu >= 10) && me !== cpu ? (me > cpu ? 'GAME POINT' : `${oppShort().toUpperCase()} GAME POINT`) : me >= 10 && me === cpu ? 'DEUCE' : '';
  $('gameChip').textContent = gp; $('gameChip').classList.toggle('hidden', !gp);
}
function bump(el, v) {
  if (el.textContent === String(v)) return;
  el.textContent = v; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}

// ---------- flow ----------
function startPlay() {
  initAudioSafe(); sfx.ui();
  if (net.vs) { if (M?.status === 'lobby') act('setReady', { ready: !myReady() }); return; }
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
  if (net.vs) dockVideo(false);
}
function toLobby() {
  game.state = 'lobby';
  ball.mode = 'hidden';
  world.marker.hide();
  $('lobby').classList.add('show');
  $('hud').classList.add('hidden');
  $('endCard').classList.add('hidden');
  if (net.vs) dockVideo(true);
}
/** ⌂ / Esc: back to the lobby, or in a 1v1 pause the match (the pause screen can leave it). */
function goHome() {
  if (!net.vs) { toLobby(); return; }
  if (M?.status === 'playing') act('setPaused', { paused: true });
}

/** Ready the next serve, once the database has the last point. */
function nextPoint() {
  if (!P) return;
  if (P.done) return showEnd();
  if (net.vs && M?.status !== 'playing') return;
  game.server = pongServer(P.me, P.cpu, P.firstServer) === net.seat ? 0 : 1;
  game.state = 'serve'; game.t = 0; game.rally = 0; game.pointPerfects = 0; game.sideStreak = 0; game.queuedShot = null;
  $('rallyChip').textContent = 'Rally 0';
  ball.mode = 'hold'; ball.path = null;
  world.marker.hide();
  setPrompt(game.server === 0 ? (net.tapMode ? '📱 Tap to serve' : '📱 Flick to serve!') : `${oppShort()} to serve…`);
  renderBoard();
}

function onPhone(e) {
  if (e.kind === 'tilt' || e.kind === 'swing') game.tilt = clamp(e.tilt, -1, 1);
  if (e.kind !== 'swing') return;
  game.lastSwing = elapsed; game.lastPower = clamp(e.power, 0, 1.2);
  game.swingAnim = 1; game.swingDir = sideOf(game.tilt) || 1;
  if (net.vs) {
    // Swing to ready up, and for a rematch, like the badminton racket.
    if (M?.status === 'lobby') { if (!myReady() && net.phoneReady) act('setReady', { ready: true }); return; }
    if (M?.status === 'over') { if (game.state === 'over') act('rematch'); return; }
  }
  if (game.state === 'lobby') { if (net.phoneReady) startPlay(); return; }
  if (game.state === 'over') return playAgain();
  if (game.state === 'serve' && game.server === 0 && game.t > 0.4) return playerServe(game.lastPower);
  // A flick just after a block still turns it into a drive.
  const p = ball.path;
  if (game.state === 'rally' && ball.mode === 'path' && p?.from === 'you' && p.kind === 'block' && p.i === 0 && p.t / p.rate < LATE_UPGRADE) {
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
  ball.path = { from, segs, i: 0, t: 0, rate: 1, ...extra };
  ball.mode = 'path';
}
/** 1v1: our own shot, stretched on our screen by the learned lag (the opponent gets it at full speed). */
function launchOwn(segs, extra) {
  const total = segs.reduce((a, s) => a + s.T, 0);
  const lag = net.vs ? LAG.est : 0;
  launchPath('you', segs, { ...extra, rate: total / (total + lag), lag });
}
const bounceY = TOP + BALL_R;

/** The NPC's shot to one of the player's sides (or an error). */
function npcShot(start, { serve = false, quality = 0, attacked = false } = {}) {
  const L = LV[P?.level ?? game.level];
  const fast = serve ? 1.1 : Math.max(0.85, 1 - game.rally * 0.008) * (attacked ? 0.88 : 1);
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
  launchOwn([seg(start, b1, 0.3, G, 'bounce'), seg(b1, b2, T, G, 'bounce'), seg(b2, V(tx * 1.2, rand(0.92, 1), -HIT_Z), 0.4, G, 'contact')], { kind: 'serve', quality: 0.15 });
  sendHit(power);
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
  // 1v1: rallies speed up as they go on, so someone cracks eventually.
  const pace = net.vs ? VS.speed * Math.max(0.72, 1 - game.rally * 0.012) : 1;
  const T1 = (drive ? 0.5 - 0.15 * pw - 0.06 * q : 0.64) * pace;
  const T2 = (drive ? 0.34 - 0.05 * q : 0.5) * pace;
  const gv = drive ? G + 6 * pw : G;
  const b = V(tx, bounceY, tz), c = V(clamp(tx * 1.25, -0.95, 0.95), rand(0.9, 1.02), -HIT_Z);
  const quality = drive ? clamp(0.3 + 0.5 * q + 0.2 * pw, 0, 1) : 0;
  launchOwn([seg(from, b, T1, gv, 'bounce'), seg(b, c, T2, G, 'contact')], { kind: drive ? 'drive' : 'block', quality, grade });
  npc.target = c.x;
  game.rally++;
  sendHit(pw);
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

// Forgiving: the right side hits, and so does any flick around contact, whichever way the paddle points.
const swungLately = () => elapsed - game.lastSwing < SWING_EARLY;
const canHit = want => {
  const have = sideOf(game.tilt);
  return have === want || (have === 0 && lv().centre === 'block') || swungLately();
};
function playerContact() {
  const want = ball.pos.x >= 0 ? 1 : -1;
  ball.hitSide = want;
  ball.contactAt = elapsed;
  if (canHit(want)) { ball.mode = 'stuck'; ball.stuckT = 0; return; }
  // Not there yet: hold the ball a moment, since the phone's swing reaches us a little late.
  segVel(ball.path.segs[ball.path.segs.length - 1], ball.path.segs[ball.path.segs.length - 1].T, ball.vel);
  ball.mode = 'grace'; ball.graceT = 0;
}
function missed() {
  const want = ball.hitSide, have = sideOf(game.tilt);
  const why = 'Flick as the ball arrives!';
  game.why = have === 0 ? 'No paddle side' : `Wrong side: it was a ${sideName(want).toLowerCase()}`;
  ball.mode = 'free'; ball.freeT = 0;
  endPoint(false, game.why, 0.15, ['MISSED!', why]);
}

/** End of the hit-stop: drive if a flick came in around contact, block otherwise. */
function resolveHit() {
  const dt = game.lastSwing - ball.contactAt;     // flicks arrive ~0.1 s after they happen
  let grade = 'BLOCK';
  if (dt > -SWING_EARLY && dt <= elapsed - ball.contactAt + 0.01) grade = Math.abs(dt - 0.06) < 0.2 ? 'PERFECT' : 'GOOD';
  playerReturn(grade, game.lastPower, ball.pos.clone());
}

// ---------- 1v1: hits travel between the laptops ----------
const r3 = v => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
/** Our hit, as its flight in our frame (the other laptop mirrors it into theirs). */
function sendHit(power) {
  if (!net.vs || !P) return;
  const p = ball.path;
  const data = { segs: p.segs.map(s => ({ a: r3(s.p0), b: r3(s.p1), T: +s.T.toFixed(4), g: +s.g.toFixed(3), e: s.end })), kind: p.kind, q: +(p.quality || 0).toFixed(3), power: +power.toFixed(3), rally: game.rally };
  call(net.conn, 'pongHit', { seq: P.seq, data: JSON.stringify(data) }, say);
}
/** The opponent hit the ball: play their flight from our end of the table. */
function onOppShot(e, queued = false) {
  if (!P || e.seq !== P.seq) return;
  if (!(game.state === 'rally' || (game.state === 'serve' && game.server === 1))) return;
  const p = ball.path;
  if (ball.mode === 'path' && p?.from === 'you') {
    // Their return beat our ball to their paddle: we stretched too much. Play it when our ball gets there.
    const left = (p.segs.slice(p.i).reduce((a, s) => a + s.T, 0) - p.t) / p.rate;
    learnLag(p.lag - left);
    game.queuedShot = e;
    return;
  }
  if (!queued && ball.mode === 'wait' && p?.from === 'you') learnLag(p.lag + ball.waitT);   // too little: add what we waited
  let d;
  try { d = JSON.parse(e.data); } catch { return; }
  const mirror = a => V(-a[0], a[1], -a[2]);
  const segs = d.segs.map(s => ({ p0: mirror(s.a), p1: mirror(s.b), T: s.T, g: s.g, end: s.e }));
  if (!segs.length || segs[segs.length - 1].end !== 'contact') return;
  const c = segs[segs.length - 1].p1, side = c.x >= 0 ? 1 : -1;
  npc.paddleX = segs[0].p0.x;
  game.state = 'rally';
  game.rally = d.rally || 0;
  $('rallyChip').textContent = `Rally ${game.rally}`;
  setPrompt('');
  launchPath('cpu', segs, { kind: d.kind, side, quality: d.q });
  const b = [...segs].reverse().find(s => s.end === 'bounce' && s.p1.z > 0);
  if (b) world.marker.show(b.p1.x, b.p1.z, side > 0 ? 0xf23545 : 0x1f8bff);
  if (d.kind === 'drive' && d.power > 0.95) callout('SMASH!', '#ff4f8b', '');
  npc.swing = 1;
  sfx.paddle(d.kind === 'drive' ? 0.45 + d.power * 0.5 : 0.4);
}

function learnLag(target) {
  LAG.est = clamp(LAG.est + (target - LAG.est) * LAG.learn, LAG.min, LAG.max);
}

function npcContact() {
  // 1v1: our shot reached the other player. Their laptop decides; hold the ball there until it does
  // (or play their return straight away if it is already here).
  if (net.vs) {
    ball.mode = 'wait'; ball.waitT = 0;
    const q = game.queuedShot; game.queuedShot = null;
    if (q) onOppShot(q, true);
    return;
  }
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
  const attacked = p.kind === 'block' && Math.random() < 0.32 + (P?.level ?? 0) * 0.15;
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
  if (P) { game.pendingSeq = P.seq + 1; act('pongPoint', { won, rally: game.rally, perfects: game.pointPerfects, why }); }
  showPoint(won, why, delay, shout);
}
function showPoint(won, why, delay = 0, shout = null) {
  game.state = 'point'; game.t = -delay;
  world.marker.hide();
  cue(0, false);
  setPrompt('');
  if (won) {
    const big = game.rally >= 8;
    callout(big ? 'WHAT A RALLY!' : 'POINT!', '#ffc61a', why);
    sfx.point(); sfx.cheer(big ? 0.9 : 0.55); world.cheer(big ? 1 : 0.6);
    world.confetti.burst(V(0, 1.1, -0.6), big ? 1 : 0.5);
  } else {
    if (shout) callout(shout[0], '#ffffff', shout[1]); else callout(`${oppShort().toUpperCase()} POINT`, '#ffffff', why);
    sfx.lose(); sfx.applause(1.1, 0.25); world.cheer(0.3);
  }
}

/** The database scored a point. In a 1v1 the other laptop may have reported it: show it here too. */
function onGame(o) {
  renderBoard();
  if (!net.vs || !o || game.state === 'point' || P.seq !== o.seq + 1 || P.me + P.cpu !== o.me + o.cpu + 1) return;
  const won = (net.seat === 0 ? P.me - o.me : P.cpu - o.cpu) === 1;
  game.pendingSeq = P.seq;
  if (ball.mode === 'wait') { ball.mode = 'free'; ball.freeT = 0; ball.vel.set(0, -0.5, -1.2); }
  showPoint(won, won ? `${oppName()} missed it` : P.last);
}

function showEnd() {
  if (!P) return;
  game.state = 'over';
  ball.mode = 'hidden';
  setPrompt('');
  cue(0, false);
  const me = myScore(), opp = oppScore();
  const won = net.vs ? M?.winner === net.seat : me > opp;
  const forfeit = net.vs && !P.done;
  $('endTitle').textContent = forfeit ? (won ? `${oppName().toUpperCase()} LEFT` : 'YOU LEFT') : won ? (opp <= 3 ? 'DOMINATION! 🏓' : 'YOU WIN! 🏆') : `${oppShort().toUpperCase()} WINS`;
  $('endCard').classList.toggle('lost', !won);
  $('endMe').textContent = me; $('endCpu').textContent = opp;
  $('endMeName').textContent = myName(); $('endCpuName').textContent = oppName();
  $('endSideMe').classList.toggle('won', won); $('endSideCpu').classList.toggle('won', !won);
  $('endStats').innerHTML = `<span><b>${P.longestRally}</b> longest rally</span>${net.vs ? '' : `<span><b>${P.perfects}</b> perfect hit${P.perfects === 1 ? '' : 's'}</span>`}`;
  $('btnAgain').textContent = net.vs ? '↻ Rematch' : '↻ Play again';
  $('btnEndLobby').classList.toggle('hidden', net.vs);
  const card = $('endCard');
  card.classList.remove('hidden', 'go'); void card.offsetWidth; card.classList.add('go');
  if (won) { sfx.win(); sfx.cheer(1); world.confetti.burst(V(0, 1.2, 0), 1.4); world.cheer(1); } else { sfx.lose(); sfx.applause(1.6, 0.4); }
}
function playAgain() {
  initAudioSafe(); sfx.ui();
  if (net.vs) { act('rematch'); return; }
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
  if (e.key === 'Escape' && game.state !== 'lobby') goHome();
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
$('btnHome').addEventListener('click', () => { sfx.ui(); goHome(); });
$('btnAgain').addEventListener('click', playAgain);
$('btnEndLobby').addEventListener('click', () => { sfx.ui(); toLobby(); });
$('btnVersus').addEventListener('click', () => { initAudioSafe(); sfx.ui(); act('createVersus', { sport: 'pong', name: nameNow() }); });
$('btnSolo').addEventListener('click', () => { sfx.ui(); startSolo(); });
$('btnJoin').addEventListener('click', () => { sfx.ui(); joinCode($('joinInput').value, false); });
$('joinInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinCode($('joinInput').value, false); });
$('btnCopy').addEventListener('click', () => {
  const url = `${publicBase()}/pingpong.html?join=${net.code}`;
  navigator.clipboard?.writeText(url).then(() => say('Invite link copied'), () => say(`Copy failed. Share code ${net.code}`));
});
$('btnResume').addEventListener('click', () => { sfx.ui(); act('setPaused', { paused: false }); });
$('btnPauseLeave').addEventListener('click', () => { sfx.ui(); startSolo(); });
// Leave the table before going home, so the menu doesn't find us still seated here.
for (const a of document.querySelectorAll('a[href="/"]')) {
  a.addEventListener('click', e => {
    e.preventDefault();
    const go = () => { location.href = '/'; };
    setTimeout(go, 1500);
    try { Promise.resolve(net.conn?.reducers.leaveMatch({})).finally(go); } catch { go(); }
  });
}
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
    p.t += dt * p.rate;
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
  } else if (ball.mode === 'grace') {
    ball.graceT += dt;
    ball.pos.addScaledVector(ball.vel, dt * 0.15);
    if (canHit(ball.hitSide)) { ball.mode = 'stuck'; ball.stuckT = 0; }
    else if (ball.graceT >= GRACE) missed();
  } else if (ball.mode === 'stuck') {
    ball.stuckT += dt;
    if (ball.stuckT >= HOLD) resolveHit();
  } else if (ball.mode === 'wait') {
    ball.waitT += dt;
    if (ball.waitT > 4) ball.mode = 'hidden';
  }
}

function update(dt) {
  game.t += dt;
  game.tiltShown += (game.tilt - game.tiltShown) * Math.min(1, dt * 10);
  game.swingAnim = Math.max(0, game.swingAnim - dt * 4);
  npc.swing = Math.max(0, npc.swing - dt * 3.5);

  if (game.state === 'serve') {
    if (game.server === 1 && game.t > 1.3 && !net.vs) npcServe();
    if (game.server === 0 && game.t > IDLE_SERVE && net.vs) { say('Auto serve'); playerServe(0.4); }
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
    if ((side !== 0 && side === Math.sign(c.x)) || swungLately()) {
      const left = p.segs.slice(p.i).reduce((a, s) => a + s.T, 0) - p.t;
      wantX = THREE.MathUtils.lerp(c.x, wantX, clamp(left / 0.8, 0, 1));
    }
  }
  if (ball.mode === 'stuck' || ball.mode === 'grace') wantX = ball.pos.x;
  padX += (wantX - padX) * Math.min(1, dt * (ball.mode === 'stuck' ? 24 : 12));
  const pad = world.paddle;
  const yawWant = game.tiltShown >= 0 ? 0.25 : Math.PI - 0.25;
  game.yaw += (yawWant - game.yaw) * Math.min(1, dt * 14);
  const sw = Math.sin(game.swingAnim * Math.PI);
  const padY = ball.mode === 'stuck' ? ball.pos.y - 0.115 : 0.86;
  pad.position.set(padX, padY - sw * 0.04, HIT_Z + 0.03 - sw * 0.16);
  pad.rotation.set(-0.25 - sw * 0.5, game.yaw + game.swingDir * sw * 0.7, -game.tiltShown * 0.55);
  pad.visible = game.state !== 'lobby';

  // NPC (or the 1v1 opponent): slides along the baseline towards where the ball will be.
  const L = lv();
  if (ball.mode === 'path' && ball.path.from === 'you') npc.target = ball.path.segs[ball.path.segs.length - 1].p1.x;
  else if (game.state !== 'rally') npc.target = game.server === 1 && game.state === 'serve' ? 0.25 : 0;
  const step = L.npcSpeed * dt;
  npc.paddleX += clamp(npc.target - npc.paddleX, -step, step);
  npc.x += (npc.paddleX * 0.7 - npc.x) * Math.min(1, dt * 6);
  const nsw = Math.sin(npc.swing * Math.PI);
  const g = world.npc.group, S = g.scale.x;
  g.position.set(npc.x, Math.abs(Math.sin(elapsed * 5)) * 0.015, -HIT_Z - 0.45);
  g.rotation.y = clamp((npc.paddleX - npc.x) * 0.6, -0.4, 0.4);
  world.npc.head.rotation.y = clamp((ball.pos.x - npc.x) * 0.5, -0.5, 0.5);
  const np = world.npcPaddle;
  np.position.set(npc.paddleX, 0.9 + nsw * 0.06, -HIT_Z - 0.03 + nsw * 0.14);
  np.rotation.set(0.25 + nsw * 0.4, Math.PI + (npc.paddleX < npc.x ? 0.3 : -0.3), (npc.paddleX - npc.x) * 0.8);
  // Arm from shoulder to paddle handle
  const sh = tmp.set(npc.x + (npc.paddleX >= npc.x ? 0.22 : -0.22) * S, 1.3 * S, -HIT_Z - 0.42);
  const hand = V(npc.paddleX, 0.9 + nsw * 0.06, -HIT_Z - 0.06);
  dir.subVectors(hand, sh);
  const arm = world.npc.arm;
  arm.position.copy(sh).addScaledVector(dir, 0.5).sub(g.position);
  arm.position.applyAxisAngle(up, -g.rotation.y).divideScalar(S);
  arm.quaternion.setFromUnitVectors(up, dir.clone().applyAxisAngle(up, -g.rotation.y).normalize());
  arm.scale.y = clamp(dir.length() / S / 0.46, 0.6, 2);

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
