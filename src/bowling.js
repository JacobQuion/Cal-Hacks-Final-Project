import * as THREE from 'three';
import QRCode from 'qrcode';
import { createBowlWorld } from './bowl-scene.js';
import {
  createLane, launch, stepLane, settled, knockedMask, standingMask, isSplit, previewPath, speedOf,
  PIN_SPOTS, HEAD_Z, RELEASE_Z, BALL_R,
} from './bowl-physics.js';
import { FULL_RACK, bowlState, frameMarks, callRoll, pinCount, laneKey } from '../spacetimedb/src/bowling.ts';
import { initAudio, sfx } from './audio.js';
import { connect, call, tables } from './stdb.js';
import { createVideoCall } from './video.js';

// Bowling: the phone is the ball. Its swings and tilt arrive through SpacetimeDB (bowl_input), the
// lane physics runs here, and the database checks each ball against the rack it holds and keeps
// score (bowl_game), so the laptop and the phone show the same scorecard.
// 1v1 (mode = bowlvs): both players bowl their own game at the same time, the higher total wins.
// The opponent's scorecard sits under yours, their rolls replay on the lane next door, and the two
// laptops are on a video call, as in badminton.

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const first = it => { for (const x of it) return x; return undefined; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const STEP = 1 / 480;

const LANE_OFFSETS = [-2, -1, 0, 1, 2];
const world = createBowlWorld($('game'), LANE_OFFSETS);
const mainView = world.lanes.find(l => l.k === 0);
let lane = createLane(FULL_RACK);

// Neighbouring lanes bowl now and then, so the alley feels alive.
const neighbours = world.lanes.filter(l => l.k !== 0).map((view, i) => ({ view, lane: createLane(FULL_RACK), wait: 3 + i * 2.7, done: 0 }));
for (const n of neighbours) n.lane.ball.gone = true;
// 1v1: the lane to the right is the opponent's.
const oppLane = neighbours.find(n => n.view.k === 1);

const params = new URLSearchParams(location.search);
const net = { conn: null, matchId: 0, code: '', seat: 0, vs: false, joining: false, phoneConnected: false, phoneReady: false, tapMode: false };
let G = null;              // this lane's bowl_game row
let O = null;              // 1v1: the opponent's lane
let M = null;              // the match row
const game = {
  state: 'lobby',          // lobby | aim | rolling | count | sweep | over
  aim: 0, spin: 0,         // targets from the phone
  aimShown: 0, spinShown: 0,
  lastPower: 0.7,
  t: 0, standingBefore: FULL_RACK, pendingSeq: -1, nextFresh: false, lastSpeed: 0,
};

// ---------- SpacetimeDB ----------
const say = (msg, ms = 2400) => {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(say.t); say.t = setTimeout(() => t.classList.remove('show'), ms);
};
const act = (name, args = {}) => call(net.conn, name, args, say);

connect({
  subs: [tables.match, tables.device, tables.myDevice, tables.bowlGame, tables.bowlScore, tables.bowlInput, tables.noticeEvent, tables.myRtc, tables.myFrame],
  wire(conn) {
    net.conn = conn;
    for (const t of ['match', 'device', 'myDevice', 'bowlScore']) {
      conn.db[t].onInsert(queueRefresh); conn.db[t].onDelete(queueRefresh); conn.db[t].onUpdate?.(queueRefresh);
    }
    conn.db.bowlGame.onInsert(queueRefresh);
    conn.db.bowlGame.onUpdate?.((_c, o, row) => {
      if (net.matchId && row.matchId === laneKey(net.matchId, net.seat)) { G = row; onGame(); }
      else if (net.vs && row.matchId === laneKey(net.matchId, 1 - net.seat)) { O = row; onOppGame(o, row); }
      queueRefresh();
    });
    conn.db.bowlInput.onInsert((_c, e) => {
      if (e.matchId !== net.matchId) return;
      if (e.seat === net.seat) onPhone(e); else if (net.vs && e.kind === 'roll') oppRoll(e);
    });
    conn.db.noticeEvent.onInsert((_c, e) => { if (e.matchId === net.matchId) say(e.text); });
    conn.db.myRtc.onInsert((_c, row) => video.receive(row));
    conn.db.myFrame.onInsert((_c, row) => video.frame(row));
    conn.db.myFrame.onUpdate?.((_c, _o, row) => video.frame(row));
  },
  onReady(conn) {
    net.conn = conn;
    act('setName', { name: nameNow() });
    // Same tab, same identity: a reload keeps the lane (and the paired phone), or the 1v1 we're in.
    const d = first(conn.db.myDevice.iter());
    const m = d && d.matchId ? [...conn.db.match.iter()].find(x => x.id === d.matchId) : null;
    const join = (params.get('join') || '').toUpperCase();
    if (join) {
      params.delete('join'); history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
      joinCode(join, !(m && (m.mode === 'bowl' || m.mode === 'bowlvs')));
    } else if (!(m && ((m.mode === 'bowl' && m.status === 'lobby') || m.mode === 'bowlvs'))) startSolo();
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
  if (net.joining && m && m.mode !== 'bowl' && m.mode !== 'bowlvs') { location.replace(m.mode === 'pongvs' ? '/pingpong.html' : '/'); return; }
  const ours = m && (m.mode === 'bowl' || m.mode === 'bowlvs') ? m : null;
  if (ours?.mode === 'bowlvs') net.joining = false;
  M = ours;
  net.vs = ours?.mode === 'bowlvs';
  net.seat = ours && d.seat !== 255 ? d.seat : 0;
  net.matchId = ours ? ours.id : 0;
  net.code = ours ? ours.code : '';
  G = ours ? conn.db.bowlGame.matchId.find(laneKey(ours.id, net.seat)) ?? null : null;
  O = net.vs ? conn.db.bowlGame.matchId.find(laneKey(ours.id, 1 - net.seat)) ?? null : null;
  const ph = ours && [...conn.db.device.iter()].find(x => x.kind === 'phone' && x.matchId === ours.id && x.seat === net.seat);
  net.phoneConnected = !!(ph && ph.online);
  net.phoneReady = !!(ph && ph.online && ph.ready);
  net.tapMode = !!(ph && ph.tapMode);
  document.body.classList.toggle('vs', net.vs);
  renderLobby();
  renderBest();
  renderCard();
  applyVersus();
  syncVideo();
}

const startSolo = () => act('startBowling', { name: nameNow() });
/** Join a 1v1 by code; `fallback` opens a solo lane if that fails and we have nothing else. */
function joinCode(code, fallback) {
  code = code.trim().toUpperCase();
  if (!code) return;
  net.joining = true;
  call(net.conn, 'joinMatch', { code, name: nameNow() }, e => { net.joining = false; say(e); if (fallback) startSolo(); });
}
const myName = () => (net.vs && M ? (net.seat === 0 ? M.nameA : M.nameB) : G?.name) || nameNow();
const oppName = () => (M && (net.seat === 0 ? M.nameB : M.nameA)) || 'Player 2';
const myReady = () => !!M && (net.seat === 0 ? M.readyA : M.readyB);

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
// In the lobby the call is a card in the row; while bowling it floats on the right.
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
  else if (st === 'playing') {
    // From the countdown (or a reload): a fresh rack. Back from a pause: carry on where we were.
    if (prev !== 'paused' || game.state === 'lobby') {
      const st2 = G ? bowlState(G.rolls) : null;
      showHud();
      if (st2?.done) showEnd(st2); else enterAim(G ? G.standing : FULL_RACK, true);
    }
  } else if (st === 'over') {
    showHud();
    if (game.state !== 'rolling' && game.state !== 'count' && game.state !== 'sweep') showEnd(bowlState(G?.rolls ?? []));
  }
}

let countdownTimer = 0;
function startCountdown() {
  initAudioSafe();
  showHud();
  enterAim(FULL_RACK, true);
  game.state = 'countdown';
  world.guide.group.visible = false;
  let n = 3;
  clearTimeout(countdownTimer);
  const tick = () => {
    if (game.state !== 'countdown') return;
    callout(n > 0 ? String(n) : 'BOWL!', n > 0 ? '#ffffff' : '#ffc61a', n === 3 ? `vs ${oppName()}` : '');
    sfx.ui();
    if (n-- > 0) countdownTimer = setTimeout(tick, 1000);
  };
  tick();
}
function showHud() {
  $('lobby').classList.remove('show');
  $('hud').classList.remove('hidden');
  $('endCard').classList.add('hidden');
  if (net.vs) dockVideo(false);
}

// ---------- 1v1: the opponent's lane ----------
/** Their ball, replayed on the lane next door against the rack they faced. */
function oppRoll(e) {
  if (!oppLane || M?.status !== 'playing') return;
  oppLane.lane = createLane(O && !O.done ? O.standing : FULL_RACK);
  launch(oppLane.lane, { power: clamp(e.power, 0, 1.2), aim: clamp(e.aim, -1, 1), spin: clamp(e.spin, -1, 1) });
  oppLane.done = 0;
}
function onOppGame(o, g) {
  renderCard();
  if (g.rolls.length !== o.rolls.length + 1) return;
  const c = callRoll(o.rolls, g.rolls[g.rolls.length - 1]);
  if (c === 'strike') say(`🎳 ${oppName()}: STRIKE!`);
  else if (c === 'spare') say(`${oppName()}: spare`);
  if (game.state === 'over' && G && bowlState(G.rolls).done) showEnd(bowlState(G.rolls), true);
}

// ---------- lobby ----------
function publicBase() { return (import.meta.env.VITE_PUBLIC_URL || location.origin).replace(/\/$/, ''); }
let qrKey = '';
function renderLobby() {
  $('laneCode').textContent = net.code || '····';
  if (net.code) {
    const url = `${publicBase()}/phone.html?code=${net.code}&seat=${net.seat}&game=bowl`;
    if (qrKey !== url) {
      qrKey = url;
      QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#1d2340', light: '#ffffff' } })
        .then(svg => { $('qr').innerHTML = svg; }).catch(() => { $('qr').textContent = 'QR failed'; });
      $('phoneUrl').textContent = new URL(url).protocol !== 'https:' ? '⚠️ Phones need HTTPS: open this page from its https:// address' : '';
    }
  }
  const s = $('phoneStatus');
  const [cls, text] = !net.phoneConnected ? ['wait', 'Waiting for phone…'] : !net.phoneReady ? ['wait', 'Phone connected, calibrating…']
    : ['good', net.tapMode ? 'Phone ready (tap mode)' : 'Phone ready! Swing to start'];
  s.classList.remove('wait', 'good'); s.classList.add(cls); s.querySelector('span').textContent = text;
  const chip = $('inputChip');
  chip.classList.remove('good', 'wait');
  if (net.phoneReady) chip.classList.add('good'); else if (net.phoneConnected) chip.classList.add('wait');
  chip.querySelector('span').textContent = net.phoneReady ? (net.tapMode ? '📱 Phone (tap)' : '📱 Phone ball') : net.phoneConnected ? '📱 Calibrating…' : '📱 No phone';

  const st = G ? bowlState(G.rolls) : null;
  const mid = !net.vs && !!(st && G.rolls.length && !st.done);
  $('btnNewGame').classList.toggle('hidden', !mid);
  for (const id of ['btnVersus', 'joinRow', 'bestCard']) $(id).classList.toggle('hidden', net.vs);
  for (const id of ['vsPlayers', 'btnSolo']) $(id).classList.toggle('hidden', !net.vs);
  $('btnCopy').classList.toggle('hidden', !net.vs || !!M?.laptopB);
  $('codeLabel').textContent = net.vs ? 'Match' : 'Lane';
  if (net.vs && M) {
    const row = (name, ready, isMe) => `<div class="pl ${ready ? 'ready' : ''}"><span>${esc(name || 'Waiting for player 2…')}${isMe ? ' (you)' : ''}</span><b>${name ? (ready ? '✔ Ready' : '…') : ''}</b></div>`;
    $('vsPlayers').innerHTML = row(M.nameA, M.readyA, net.seat === 0) + row(M.nameB, M.readyB, net.seat === 1);
    // The phone is the ball: no paired, calibrated phone, no match (the server refuses it too).
    const noPhone = !net.phoneReady && !myReady();
    $('btnStart').disabled = noPhone;
    $('btnStart').textContent = noPhone ? (net.phoneConnected ? '📱 Calibrating phone…' : '📱 Pair your phone first')
      : myReady() ? '✖ Not ready' : M.laptopB ? '✋ Ready' : '✋ Ready (waiting for player 2)';
    return;
  }
  $('btnStart').textContent = !net.phoneReady ? '📱 Pair your phone to bowl' : mid ? `▶ Resume frame ${st.frame + 1}` : '▶ Start bowling';
  $('btnStart').disabled = !G || !net.phoneReady;
}

function renderBest() {
  const rows = [...net.conn.db.bowlScore.iter()].sort((a, b) => b.score - a.score || (a.at.microsSinceUnixEpoch < b.at.microsSinceUnixEpoch ? -1 : 1)).slice(0, 7);
  $('bestList').innerHTML = rows.length
    ? rows.map(r => `<li><span class="who"><span class="line"><b>${esc(r.name)}</b></span><i class="bowl-x">${r.strikes} strike${r.strikes === 1 ? '' : 's'} · ${r.spares} spare${r.spares === 1 ? '' : 's'}</i></span><b class="score">${r.score}</b></li>`).join('')
    : '<li class="hint">No games yet. Be the first!</li>';
  const best = rows[0];
  $('bestChip').textContent = best ? `🏆 ${best.score} · ${best.name}` : '🏆 No games yet';
}

// ---------- scorecard ----------
function cardHtml(rolls, name) {
  const st = bowlState(rolls);
  const cur = st.done ? -1 : st.frame;
  const frames = st.frames.map((f, i) => {
    const marks = frameMarks(f, i === 9);
    const boxes = (i === 9 ? [0, 1, 2] : [0, 1]).map(k => `<i class="${marks[k] === 'X' ? 'x' : marks[k] === '/' ? 'sp' : ''}">${marks[k] ?? ''}</i>`).join('');
    return `<div class="frame ${i === cur ? 'cur' : ''} ${i === 9 ? 'tenth' : ''}"><span class="fn">${i + 1}</span><div class="balls">${boxes}</div><b>${f.total ?? ''}</b></div>`;
  }).join('');
  return `<div class="sc-name"><span>${esc(name)}</span></div>${frames}<div class="sc-total"><span>Total</span><b>${st.score}</b></div>`;
}
function renderCard() {
  const st = G ? bowlState(G.rolls) : bowlState([]);
  $('scorecard').innerHTML = cardHtml(G?.rolls ?? [], myName());
  $('oppCard').classList.toggle('hidden', !net.vs);
  if (net.vs) $('oppCard').innerHTML = cardHtml(O?.rolls ?? [], oppName());
  $('frameChip').textContent = st.done ? 'FINAL' : `FRAME ${st.frame + 1} · BALL ${st.ball + 1}`;
}

function renderPinMap(standing, knocked = 0) {
  // Drawn from the bowler's view: pin 1 at the bottom, back row (7–10) on top.
  const rows = [[6, 7, 8, 9], [3, 4, 5], [1, 2], [0]];
  $('pinMap').innerHTML = rows.map(r => `<div>${r.map(i => `<i class="${standing & (1 << i) ? 'up' : knocked & (1 << i) ? 'hit' : ''}"></i>`).join('')}</div>`).join('');
}

// ---------- flow ----------
function startPlay() {
  initAudioSafe(); sfx.ui();
  if (net.vs) { if (M?.status === 'lobby') act('setReady', { ready: !myReady() }); return; }
  if (!G) return;
  const st = bowlState(G.rolls);
  if (st.done) { act('bowlNew'); game.pendingSeq = G.rollSeq + 1; }
  enterAim(st.done ? FULL_RACK : G.standing, true);
  $('lobby').classList.remove('show');
  $('hud').classList.remove('hidden');
  $('endCard').classList.add('hidden');
}
function toLobby() {
  game.state = 'lobby';
  $('lobby').classList.add('show');
  $('hud').classList.add('hidden');
  $('endCard').classList.add('hidden');
  world.guide.group.visible = false;
  if (net.vs) dockVideo(true);
}
/** ⌂ / Esc: back to the lobby, or in a 1v1 pause the match (the pause screen can leave it). */
function goHome() {
  if (!net.vs) { toLobby(); return; }
  if (M?.status === 'playing') act('setPaused', { paused: true });
}

/** Ball in hand at the foul line, rack as the server holds it. */
function enterAim(standing, rebuild) {
  if (rebuild || standingMask(lane) !== standing) {
    const fresh = standing === FULL_RACK && standingMask(lane) !== FULL_RACK;
    lane = createLane(standing);
    if (fresh) for (const p of lane.pins) p.drop = 0.55;
  }
  lane.ball.live = false; lane.ball.gone = false;
  Object.assign(lane.ball, { x: 0, z: RELEASE_Z + 0.25, y: BALL_R, vx: 0, vz: 0 });
  game.state = 'aim'; game.t = 0; game.standingBefore = standing;
  world.guide.group.visible = true;
  renderPinMap(standing);
  renderCard();
}

function bowl(power, aim, spin) {
  if (game.state !== 'aim') return;
  if (net.vs && M?.status !== 'playing') return;
  initAudioSafe();
  game.lastPower = power;
  launch(lane, { power, aim, spin });
  game.state = 'rolling'; game.t = 0;
  game.lastSpeed = speedOf(power);
  world.guide.group.visible = false;
  sfx.swoosh();
  sfx.rumble(Math.abs(HEAD_Z) / game.lastSpeed + 0.3);
  $('powerLabel').textContent = `⚡ ${Math.round(game.lastSpeed * 3.6)} km/h`;
  $('powerFill').style.width = `${clamp(power / 1.2, 0, 1) * 100}%`;
}

function onPhone(e) {
  if (e.kind === 'aim') { game.aim = clamp(e.aim, -1, 1); game.spin = clamp(e.spin, -1, 1); return; }
  if (e.kind !== 'roll') return;
  game.aim = clamp(e.aim, -1, 1); game.spin = clamp(e.spin, -1, 1);
  if (net.vs) {
    // Swing to ready up, and for a rematch, like the badminton racket.
    if (M?.status === 'lobby') { if (!myReady() && net.phoneReady) act('setReady', { ready: true }); return; }
    if (M?.status === 'over') { if (game.state === 'over') act('rematch'); return; }
  }
  if (game.state === 'lobby') return startPlay();
  if (game.state === 'over') return playAgain();
  if (game.state === 'aim') { game.aimShown = game.aim; game.spinShown = game.spin; bowl(clamp(e.power, 0, 1.2), game.aim, game.spin); }
}

/** Pins have settled: tell the database which ones fell, call it, then sweep. */
function countPins() {
  const knocked = knockedMask(lane, game.standingBefore);
  const left = game.standingBefore & ~knocked;
  const n = pinCount(knocked);
  const prev = G ? [...G.rolls] : [];
  const call_ = callRoll(prev, n);
  const after = bowlState([...prev, n]);
  game.nextFresh = after.done || after.fresh;
  if (G) { game.pendingSeq = G.rollSeq + 1; act('bowlRoll', { knocked }); }
  renderPinMap(left, knocked);

  if (call_ === 'strike') {
    const streak = countStreak([...prev, n]);
    callout(streak >= 3 ? (streak === 3 ? 'TURKEY!' : `${streak} IN A ROW!`) : streak === 2 ? 'DOUBLE!' : 'STRIKE!', '#ffc61a', streak >= 2 ? '🔥 Keep it rolling' : '🎳 All ten down');
    world.confetti.burst(new THREE.Vector3(0, 0.4, HEAD_Z - 0.3), 1.2); world.flash(1.4);
    sfx.strike(); sfx.cheer(1);
  } else if (call_ === 'spare') {
    callout('SPARE!', '#35c9a5', 'Picked it up 👌');
    world.confetti.burst(new THREE.Vector3(0, 0.4, HEAD_Z - 0.3), 0.7); world.flash(0.8);
    sfx.point(); sfx.cheer(0.6);
  } else if (call_ === 'gutter') {
    callout(lane.ball.gutter ? 'GUTTER BALL' : 'MISSED!', '#ffffff', after.done || after.fresh ? '' : 'Shake it off. Pick up the spare!');
    sfx.lose();
  } else {
    const split = !after.fresh && !after.done && isSplit(left);
    if (n >= 7) sfx.cheer(0.25); else if (n > 0) sfx.applause(1, 0.25);
    callout(`${n} PIN${n === 1 ? '' : 'S'}`, '#ffffff', split ? '😬 SPLIT!' : after.fresh || after.done ? `${10 - pinCount(left)} down this frame` : `${pinCount(left)} left, go get the spare`);
  }
  game.state = 'sweep'; game.t = 0;
  sfx.sweep();
}

function countStreak(rolls) {
  const st = bowlState(rolls);
  let n = 0;
  const marks = st.frames.flatMap((f, i) => frameMarks(f, i === 9)).filter(m => m !== '');
  for (let i = marks.length - 1; i >= 0 && marks[i] === 'X'; i--) n++;
  return n;
}

/** The server's scorecard moved on (our ball, or a new game). */
function onGame() {
  renderCard();
  if (game.state === 'over' && G && G.rolls.length === 0) enterAim(FULL_RACK, true), $('endCard').classList.add('hidden');
  // Already finished with the ball still in hand (a reload, another tab): straight to the end card.
  else if (game.state === 'aim' && G && bowlState(G.rolls).done) showEnd(bowlState(G.rolls));
}

function finishSweep() {
  if (!G || G.rollSeq < game.pendingSeq) return false;     // wait for the database to score it
  const st = bowlState(G.rolls);
  if (st.done) { showEnd(st); return true; }
  enterAim(G.standing, false);
  return true;
}

/** `quiet`: just refresh the card (1v1, the opponent bowled while we wait). */
function showEnd(st, quiet = false) {
  const again = game.state === 'over';
  game.state = 'over';
  world.guide.group.visible = false;
  const side = (score, name, won) => `<div class="end-side ${won ? 'won' : ''}"><b>${score}</b><span>${esc(name)}</span></div>`;
  let final = true;
  if (net.vs) {
    const os = bowlState(O?.rolls ?? []);
    const over = M?.status === 'over', forfeit = over && !(st.done && os.done);
    final = over;
    const won = M?.winner === net.seat, tie = over && M?.winner === 255;
    $('endTitle').textContent = !over ? 'WAITING…' : forfeit ? (won ? `${oppName().toUpperCase()} LEFT` : 'YOU LEFT')
      : tie ? 'TIE GAME!' : won ? 'YOU WIN! 🏆' : `${oppName().toUpperCase()} WINS`;
    $('endCard').classList.toggle('lost', over && !won && !tie);
    $('endLine').innerHTML = `${side(st.score, myName(), over && (won || tie))}<span class="end-dash">–</span>${side(os.score, oppName(), over && !won)}`;
    $('endStats').innerHTML = `<span><b>${st.strikes}</b> strike${st.strikes === 1 ? '' : 's'}</span><span><b>${st.spares}</b> spare${st.spares === 1 ? '' : 's'}</span>`
      + (over ? '' : `<span class="end-wait">${esc(oppName())} is on frame ${os.frame + 1}</span>`);
    $('btnAgain').textContent = '↻ Rematch';
    $('btnAgain').classList.toggle('hidden', !over);
    $('btnEndLobby').classList.add('hidden');
  } else {
    $('endCard').classList.remove('lost');
    $('endLine').innerHTML = side(st.score, myName(), true);
    $('endTitle').textContent = st.score >= 250 ? 'LEGENDARY!' : st.score >= 180 ? 'ON FIRE! 🔥' : st.score >= 120 ? 'NICE GAME!' : st.score >= 70 ? 'GOOD GAME!' : 'GG!';
    $('endStats').innerHTML = `<span><b>${st.strikes}</b> strike${st.strikes === 1 ? '' : 's'}</span><span><b>${st.spares}</b> spare${st.spares === 1 ? '' : 's'}</span>`;
    $('btnAgain').textContent = '↻ Play again';
    $('btnAgain').classList.remove('hidden');
    $('btnEndLobby').classList.remove('hidden');
  }
  const card = $('endCard');
  if (quiet && again) { card.classList.remove('hidden'); return; }
  card.classList.remove('hidden', 'go'); void card.offsetWidth; card.classList.add('go');
  if (final && (!net.vs || M?.winner === net.seat || M?.winner === 255)) {
    sfx.win(); sfx.cheer(st.score >= 120 ? 1 : 0.6);
    world.confetti.burst(new THREE.Vector3(0, 0.6, HEAD_Z - 0.2), 1.4);
  } else if (final) sfx.lose();
}
function playAgain() {
  initAudioSafe(); sfx.ui();
  if (net.vs) { act('rematch'); return; }
  if (!G) return;
  $('endCard').classList.add('hidden');
  act('bowlNew');
  enterAim(FULL_RACK, true);
}

function callout(text, color, sub = '') {
  const el = $('bigCallout'), s = $('bigSub');
  el.textContent = text; el.style.color = color;
  s.textContent = sub;
  for (const x of [el, s]) { x.classList.remove('go'); void x.offsetWidth; x.classList.add('go'); }
}

// ---------- keys ----------
// The phone is the only controller; Esc just returns to the lobby.
window.addEventListener('keydown', e => {
  if (e.target instanceof HTMLInputElement) { if (e.key === 'Enter') e.target.blur(); return; }
  if (e.key === 'Escape' && game.state !== 'lobby') goHome();
});

// ---------- name, buttons ----------
const nameNow = () => $('nameInput').value.trim() || 'Bowler';
$('nameInput').value = (() => { try { return localStorage.getItem('racket.name') || ''; } catch { return ''; } })() || 'Bowler';
$('nameInput').addEventListener('change', () => {
  try { localStorage.setItem('racket.name', nameNow()); } catch { /* storage unavailable */ }
  act('setName', { name: nameNow() });
  renderCard();
});
$('btnStart').addEventListener('click', startPlay);
$('btnNewGame').addEventListener('click', () => { act('bowlNew'); if (G) game.pendingSeq = G.rollSeq + 1; startPlayFresh(); });
function startPlayFresh() { initAudioSafe(); sfx.ui(); enterAim(FULL_RACK, true); $('lobby').classList.remove('show'); $('hud').classList.remove('hidden'); }
$('btnHome').addEventListener('click', () => { sfx.ui(); goHome(); });
$('btnAgain').addEventListener('click', playAgain);
$('btnEndLobby').addEventListener('click', () => { sfx.ui(); toLobby(); });
$('btnVersus').addEventListener('click', () => { initAudioSafe(); sfx.ui(); act('createVersus', { sport: 'bowl', name: nameNow() }); });
$('btnSolo').addEventListener('click', () => { sfx.ui(); startSolo(); });
$('btnJoin').addEventListener('click', () => { sfx.ui(); joinCode($('joinInput').value, false); });
$('joinInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinCode($('joinInput').value, false); });
$('btnCopy').addEventListener('click', () => {
  const url = `${publicBase()}/bowling.html?join=${net.code}`;
  navigator.clipboard?.writeText(url).then(() => say('Invite link copied'), () => say(`Copy failed. Share code ${net.code}`));
});
$('btnResume').addEventListener('click', () => { sfx.ui(); act('setPaused', { paused: false }); });
$('btnPauseLeave').addEventListener('click', () => { sfx.ui(); startSolo(); });
// Leave the lane before going home, so the menu doesn't find us still on it.
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
let elapsed = 0, acc = 0, previewKey = '', perfT = 0, perfN = 0, renderScale = Math.min(window.devicePixelRatio, 1.5);
const camPos = new THREE.Vector3(0, 1.6, 3.4), camLook = new THREE.Vector3(0, 0.3, -12);
const camTarget = new THREE.Vector3(), lookTarget = new THREE.Vector3();
let soundBudget = 0;

function handleSounds(events, vol) {
  let pinPow = 0, clacks = 0, thuds = 0;
  for (const e of events) {
    if (e.type === 'ball-pin' || e.type === 'pin') pinPow = Math.max(pinPow, e.power);
    else if (e.type === 'clack' || e.type === 'kick') clacks = Math.max(clacks, e.power);
    else if (e.type === 'thud') thuds++;
    else if (e.type === 'gutter' && vol === 1) sfx.gutter();
  }
  if (soundBudget > 0) return;
  if (pinPow > 0.05) { sfx.pins(pinPow, vol); soundBudget = 0.12; }
  else if (clacks > 0.05) { sfx.clack(clacks, vol); soundBudget = 0.04; }
  else if (thuds) { sfx.thud(vol); soundBudget = 0.05; }
}

function stepNeighbours(dt) {
  for (const n of neighbours) {
    const L = n.lane;
    if (net.vs && n === oppLane) {
      // The opponent's lane: only their rolls; once the pins settle, show the rack they face next.
      if (L.ball.live) {
        acc2(L, dt, 0.25);
        if (settled(L) && (n.done += dt) > 1.6) {
          n.lane = createLane(O && !O.done ? O.standing : FULL_RACK);
          for (const p of n.lane.pins) p.drop = 0.55;
          n.lane.ball.gone = true; n.done = 0;
        }
      }
      continue;
    }
    if (L.ball.live && !L.ball.gone) {
      acc2(L, dt, 0.18);
    } else if (L.ball.live && L.ball.gone) {
      acc2(L, dt, 0.18);
      if (settled(L)) { n.done += dt; if (n.done > 1.6) { n.lane = createLane(FULL_RACK); for (const p of n.lane.pins) p.drop = 0.55; n.lane.ball.gone = true; n.wait = 6 + Math.random() * 9; n.done = 0; } }
    } else if ((n.wait -= dt) <= 0) {
      launch(L, { power: 0.5 + Math.random() * 0.6, aim: (Math.random() - 0.5) * 0.9, spin: (Math.random() - 0.3) * 1.2 });
    }
  }
}
function acc2(L, dt, vol) {
  const ev = [];
  for (let k = 0, n = Math.round(dt / STEP); k < n; k++) stepLane(L, STEP, ev);
  if (ev.length) handleSounds(ev, vol);
}

function update(dt) {
  soundBudget -= dt;
  const k = Math.min(1, dt * 8);
  game.aimShown += (game.aim - game.aimShown) * k;
  game.spinShown += (game.spin - game.spinShown) * k;
  game.t += dt;

  // Pins dropping into place after a reset
  for (const p of lane.pins) if (p.drop) p.drop = Math.max(0, p.drop - dt * 1.4);
  for (const n of neighbours) for (const p of n.lane.pins) if (p.drop) p.drop = Math.max(0, p.drop - dt * 1.4);

  if (game.state === 'aim') {
    const key = `${game.aimShown.toFixed(2)}|${game.spinShown.toFixed(2)}`;
    if (key !== previewKey) { previewKey = key; const p = previewPath(game.aimShown, game.spinShown, game.lastPower); world.guide.set(p.pts, p.gutter); }
    lane.ball.y = BALL_R + 0.22 + Math.sin(elapsed * 2.4) * 0.015;
    lane.ball.x = 0;
  }
  if (game.state === 'rolling') {
    acc += dt;
    const ev = [];
    while (acc >= STEP) { acc -= STEP; stepLane(lane, STEP, ev); }
    handleSounds(ev, 1);
    if (game.t < 0.18) lane.ball.y = BALL_R + 0.22 * (1 - game.t / 0.18);
    // Give up waiting for the last wobbles after a while
    if ((settled(lane) && game.t > 1) || game.t > 9) { game.state = 'count'; game.t = 0; }
  } else if (game.state === 'count') {
    acc = 0;
    const ev = [];
    for (let i = 0; i < Math.round(dt / STEP); i++) stepLane(lane, STEP, ev);
    if (game.t > 0.55) countPins();
  } else if (game.state === 'sweep') updateSweep();

  stepNeighbours(dt);

  // HUD meters
  $('aimDot').style.left = `${50 + game.aimShown * 46}%`;
  const h = $('hookFill');
  h.style.left = `${50 + Math.min(0, game.spinShown) * 50}%`; h.style.width = `${Math.abs(game.spinShown) * 50}%`;
  if (game.state === 'aim') {
    $('powerLabel').textContent = '📱 Swing!';
    $('powerFill').style.width = '0%';
  }
}

// Pinsetter: the bar drops, standing pins are lifted, the deadwood is swept into the pit, the rack comes back.
function updateSweep() {
  const t = game.t, bar = world.sweep, top = 0.95, low = 0.07, z0 = HEAD_Z + 0.45, z1 = HEAD_Z - 1.15;
  const ease = x => x * x * (3 - 2 * x), seg = (a, b) => ease(clamp((t - a) / (b - a), 0, 1));
  const keep = !game.nextFresh;
  bar.position.y = top + (low - top) * seg(0, 0.35) - (low - top) * seg(1.25, 1.55);
  bar.position.z = z0 + (z1 - z0) * seg(0.4, 0.9) - (z1 - z0) * seg(0.95, 1.25);
  const lift = keep ? 0.3 * seg(0.05, 0.35) * (1 - seg(1.0, 1.3)) : 0;
  sweepLift = lift;
  for (const p of lane.pins) {
    if (p.state === 'gone' || (keep && p.state === 'standing')) continue;
    if (bar.position.y < 0.2 && p.z > bar.position.z - 0.08) {
      p.z = bar.position.z - 0.08; p.vx = p.vz = 0;
      if (p.z < HEAD_Z - 1.0) p.state = 'gone';
    }
  }
  if (t > 1.6 && finishSweep()) { sweepLift = 0; bar.position.set(0, top, z0); }
}
let sweepLift = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;
  update(dt);

  world.drawLane(mainView, lane, dt, elapsed, { lift: sweepLift, hideBall: game.state === 'lobby' });
  for (const n of neighbours) world.drawLane(n.view, n.lane, dt, elapsed, { hideBall: !n.lane.ball.live });
  world.update(elapsed, dt);

  // Camera: behind the ball in hand, chases it down the lane, then holds on the pins.
  const b = lane.ball;
  if (game.state === 'lobby') {
    camTarget.set(Math.sin(elapsed * 0.18) * 0.9, 1.5, 3.2); lookTarget.set(Math.sin(elapsed * 0.18) * 0.3, 0.35, -14);
  } else if (game.state === 'aim' || game.state === 'over' || game.state === 'countdown') {
    camTarget.set(game.aimShown * 0.08, 1.15, 2.6); lookTarget.set(game.aimShown * 0.6, -0.2, -10);
  } else if (game.state === 'rolling' && !b.gone && b.z > HEAD_Z + 4.6) {
    camTarget.set(b.x * 0.5, 0.75 + Math.max(0, b.z + 6) * 0.03, b.z + 2.0); lookTarget.set(b.x * 0.5, 0.12, b.z - 7);
  } else {
    camTarget.set(0, 1.0, HEAD_Z + 3.7); lookTarget.set(0, 0.08, HEAD_Z - 0.4);
  }
  const ck = Math.min(1, dt * (game.state === 'rolling' ? 5 : 2.6));
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
renderPinMap(FULL_RACK);
renderCard();
world.guide.group.visible = false;
requestAnimationFrame(frame);

// Test hook
window.__bowl = { game, net, get lane() { return lane; }, get G() { return G; }, bowl, startPlay, onPhone };
