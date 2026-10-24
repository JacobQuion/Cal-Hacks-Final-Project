// Video call between the two laptops of a 1v1. Media flows peer to peer over WebRTC; SpacetimeDB is
// only the signaling channel: messages go through the `rtcSignal` reducer into a private mailbox
// that the recipient alone reads through the `my_rtc` view (and deletes with `rtcAck`).
//
// Roles are fixed so the two sides never offer at the same time: seat 0 calls (makes offers), seat 1
// answers. Each page load picks a random session id (`sid`); every message names the sender's and the
// recipient's sid, so leftovers from an old session (a reload, a dropped laptop) are ignored.
// Both sides always negotiate one audio + one video transceiver; turning the camera or mic on/off later
// only swaps tracks (replaceTrack), so it never needs another round of signaling.

const $ = id => document.getElementById(id);

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (import.meta.env.VITE_TURN_URL) {
  ICE_SERVERS.push({ urls: import.meta.env.VITE_TURN_URL, username: import.meta.env.VITE_TURN_USER, credential: import.meta.env.VITE_TURN_PASS });
}
const VIDEO = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' };
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const MAX_VIDEO_BITRATE = 600_000; // keep the call light so it never competes with the game's own traffic

/**
 * send(json) delivers a signaling message to the other laptop; ack(id) deletes mailbox rows up to id.
 * Call sync() whenever the match changes and receive() for every my_rtc row.
 */
export function createVideoCall({ send, ack }) {
  const ui = {
    panel: $('videoPanel'), opp: $('vidOpp'), me: $('vidMe'),
    oppTile: $('vTileOpp'), meTile: $('vTileMe'), oppName: $('vNameOpp'), meName: $('vNameMe'),
    oppNote: $('vNoteOpp'), meNote: $('vNoteMe'), oppInitial: $('vInitOpp'), meInitial: $('vInitMe'),
    mic: $('btnMic'), cam: $('btnCam'), min: $('btnVidMin'), unmute: $('btnVidUnmute'),
  };

  let session = null;     // { matchId, seat, oppKey } while in a 1v1
  let sid = '';
  let remoteSid = '';
  let pc = null, pcBorn = 0, remoteStream = null, pendingIce = [], iceOut = [], iceTimer = 0;
  let local = { audio: null, video: null };
  let want = { mic: true, cam: true };
  let remoteState = { mic: true, cam: true };
  let mediaError = '';
  let lastId = 0n, ackTimer = 0, chain = Promise.resolve(), restartTimer = 0;
  let meter = null;

  const isCaller = () => session?.seat === 0;
  const msg = (type, extra = {}) => send(JSON.stringify({ type, from: sid, to: remoteSid, ...extra }));

  // ---------- local camera + mic ----------
  async function acquire(kinds) {
    const constraints = { audio: kinds.audio ? AUDIO : false, video: kinds.video ? VIDEO : false };
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      return { audio: s.getAudioTracks()[0] || null, video: s.getVideoTracks()[0] || null, error: '' };
    } catch (e) {
      // One device missing or blocked shouldn't cost the other one.
      if (kinds.audio && kinds.video) {
        const v = await acquire({ video: true }), a = await acquire({ audio: true });
        return { audio: a.audio, video: v.video, error: !a.audio && !v.video ? describe(e) : '' };
      }
      return { audio: null, video: null, error: describe(e) };
    }
  }
  const describe = e => (e?.name === 'NotAllowedError' ? 'Camera blocked — click to allow'
    : e?.name === 'NotFoundError' ? 'No camera found'
    : !window.isSecureContext ? 'Camera needs HTTPS' : 'Camera unavailable — click to retry');

  async function startMedia() {
    if (!navigator.mediaDevices?.getUserMedia) { mediaError = window.isSecureContext ? 'Camera not supported' : 'Camera needs HTTPS'; render(); return; }
    const got = await acquire({ audio: want.mic && !local.audio, video: want.cam && !local.video });
    if (!session) { got.audio?.stop(); got.video?.stop(); return; }
    if (got.audio) local.audio = got.audio;
    if (got.video) local.video = got.video;
    mediaError = got.error;
    if (local.video) local.video.onended = () => { local.video = null; attachTracks(); render(); };
    attachTracks();
    render();
    sendState();
  }

  function stopMedia() {
    local.audio?.stop(); local.video?.stop();
    local = { audio: null, video: null };
    ui.me.srcObject = null;
  }

  // Put the current local tracks on the negotiated transceivers (no renegotiation needed).
  function attachTracks() {
    const stream = new MediaStream([local.video].filter(Boolean));
    if (ui.me.srcObject?.getVideoTracks()[0] !== local.video) ui.me.srcObject = local.video ? stream : null;
    if (!pc) return;
    for (const tr of pc.getTransceivers()) {
      const kind = tr.receiver.track?.kind;
      if (!kind || tr.stopped) continue;
      if (tr.direction !== 'sendrecv') tr.direction = 'sendrecv';
      tr.sender.replaceTrack(kind === 'audio' ? (want.mic ? local.audio : null) : (want.cam ? local.video : null)).catch(() => {});
    }
    meter?.watch('me', local.audio && want.mic ? new MediaStream([local.audio]) : null);
  }

  // ---------- peer connection ----------
  function closePc() {
    clearTimeout(restartTimer);
    if (pc) { pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null; pc.close(); }
    pc = null; pendingIce = []; iceOut = [];
    remoteStream = null; ui.opp.srcObject = null;
    meter?.watch('opp', null);
  }

  function newPc() {
    closePc();
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcBorn = performance.now();
    remoteStream = new MediaStream();
    ui.opp.srcObject = remoteStream;
    pc.ontrack = e => {
      remoteStream.addTrack(e.track);
      if (e.track.kind === 'audio') meter?.watch('opp', new MediaStream([e.track]));
      playRemote();
      render();
    };
    pc.onicecandidate = e => {
      if (!e.candidate) return;
      // Batch trickled candidates into a few reducer calls instead of one per candidate.
      iceOut.push(e.candidate.toJSON());
      clearTimeout(iceTimer);
      iceTimer = setTimeout(() => { if (iceOut.length) msg('ice', { c: iceOut.splice(0) }); }, 150);
    };
    pc.onconnectionstatechange = () => {
      const st = pc?.connectionState;
      if (st === 'connected') { capBitrate(); sendState(); }
      if (st === 'failed') {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => { if (!session) return; if (isCaller()) call(); else msg('hello'); }, 1500);
      }
      render();
    };
    return pc;
  }

  const healthy = () => !!pc && (pc.connectionState === 'connected' || pc.connectionState === 'connecting'
    || (pc.signalingState === 'have-local-offer' && performance.now() - pcBorn < 6000));

  function capBitrate() {
    for (const s of pc?.getSenders() || []) {
      if (s.track?.kind !== 'video') continue;
      const p = s.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
      s.setParameters(p).catch(() => {});
    }
  }

  async function call() {
    if (!remoteSid) return;
    const p = newPc();
    p.addTransceiver('audio', { direction: 'sendrecv' });
    p.addTransceiver('video', { direction: 'sendrecv' });
    attachTracks();
    const offer = await p.createOffer();
    if (p !== pc) return;
    await p.setLocalDescription(offer);
    msg('offer', { sdp: p.localDescription.sdp });
  }

  async function answer(m) {
    if (m.from !== remoteSid || !pc || pc.signalingState === 'closed') { remoteSid = m.from; newPc(); }
    const p = pc;
    await p.setRemoteDescription({ type: 'offer', sdp: m.sdp });
    attachTracks();
    const ans = await p.createAnswer();
    if (p !== pc) return;
    await p.setLocalDescription(ans);
    msg('answer', { sdp: p.localDescription.sdp });
    await flushIce();
  }

  async function flushIce() {
    if (!pc?.remoteDescription) return;
    for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
  }

  async function handle(m) {
    if (!session || !m || m.from === sid) return;
    if (m.type === 'hello') {
      if (isCaller()) {
        if (m.from !== remoteSid || !healthy()) { remoteSid = m.from; await call(); }
        else sendState();
      } else {
        if (m.from !== remoteSid) { remoteSid = m.from; closePc(); }
        msg('hello');
      }
      return;
    }
    // Everything else must be from the peer we're talking to, addressed to this session.
    if (m.to !== sid) return;
    if (m.type === 'offer' && !isCaller()) return answer(m);
    if (m.from !== remoteSid) return;
    if (m.type === 'answer' && isCaller() && pc?.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      await flushIce();
    } else if (m.type === 'ice') {
      pendingIce.push(...(m.c || []));
      await flushIce();
    } else if (m.type === 'state') {
      remoteState = { mic: !!m.mic, cam: !!m.cam };
      render();
    } else if (m.type === 'bye') {
      closePc();
      render();
    }
  }

  function sendState() {
    if (session && remoteSid) msg('state', { mic: want.mic && !!local.audio, cam: want.cam && !!local.video });
  }

  // Remote audio: browsers can refuse unmuted autoplay; then play muted and offer a click to unmute.
  function playRemote() {
    ui.opp.muted = false;
    ui.opp.play().then(() => ui.unmute.classList.add('hidden')).catch(() => {
      ui.opp.muted = true;
      ui.opp.play().catch(() => {});
      ui.unmute.classList.remove('hidden');
    });
  }

  // ---------- UI ----------
  function render() {
    if (!session) return;
    const connected = pc?.connectionState === 'connected';
    const oppVideo = connected && remoteState.cam && ui.opp.videoWidth > 0 && remoteStream?.getVideoTracks().some(t => t.readyState === 'live');
    ui.oppTile.classList.toggle('live', !!oppVideo);
    ui.oppTile.classList.toggle('muted', connected && !remoteState.mic);
    ui.oppNote.textContent = !session.oppKey ? 'Waiting for player 2…'
      : !pc ? 'Calling…'
      : pc.connectionState === 'failed' ? 'Reconnecting…'
      : pc.connectionState === 'disconnected' ? 'Connection lost — reconnecting…'
      : !connected ? 'Connecting video…'
      : !remoteState.cam ? 'Camera off' : '';
    const meVideo = !!local.video && want.cam;
    ui.meTile.classList.toggle('live', meVideo);
    ui.meTile.classList.toggle('muted', !(want.mic && local.audio));
    ui.meNote.textContent = mediaError || (!want.cam ? 'Camera off' : !local.video ? 'Starting camera…' : '');
    ui.meTile.classList.toggle('clickable', !!mediaError);
    ui.mic.classList.toggle('off', !(want.mic && local.audio));
    ui.cam.classList.toggle('off', !meVideo);
    ui.mic.title = want.mic ? 'Mute microphone' : 'Unmute microphone';
    ui.cam.title = want.cam ? 'Turn camera off' : 'Turn camera on';
  }

  async function toggleCam() {
    want.cam = !want.cam;
    if (!want.cam && local.video) { local.video.stop(); local.video = null; } // camera light goes off
    if (want.cam && !local.video) await startMedia();
    attachTracks(); render(); sendState();
  }
  async function toggleMic() {
    want.mic = !want.mic;
    if (want.mic && !local.audio) await startMedia();
    attachTracks(); render(); sendState();
  }
  ui.cam.addEventListener('click', toggleCam);
  ui.mic.addEventListener('click', toggleMic);
  ui.min.addEventListener('click', () => {
    const min = ui.panel.classList.toggle('min');
    ui.min.textContent = min ? '▢' : '–';
    ui.min.title = min ? 'Show video' : 'Minimize video';
  });
  ui.meTile.addEventListener('click', () => { if (mediaError) { mediaError = ''; render(); startMedia(); } });
  ui.unmute.addEventListener('click', () => playRemote());
  for (const ev of ['loadeddata', 'resize']) ui.opp.addEventListener(ev, () => render());
  addEventListener('pagehide', () => { if (session && remoteSid) msg('bye'); });

  // ---------- public API ----------
  return {
    /** s: { matchId, seat, oppKey, oppName, myName } while in a 1v1 (oppKey '' until player 2 joins), or null. */
    sync(s) {
      if (!s) {
        if (!session) return;
        if (remoteSid) msg('bye');
        session = null; remoteSid = ''; remoteState = { mic: true, cam: true };
        closePc(); stopMedia(); meter?.close(); meter = null;
        ui.panel.classList.add('hidden'); document.body.classList.remove('with-video');
        return;
      }
      const fresh = !session || session.matchId !== s.matchId || session.seat !== s.seat;
      const oppChanged = session && session.oppKey !== s.oppKey;
      session = { matchId: s.matchId, seat: s.seat, oppKey: s.oppKey };
      ui.oppName.textContent = s.oppName || 'Opponent';
      ui.meName.textContent = s.myName ? `${s.myName} (you)` : 'You';
      ui.oppInitial.textContent = (s.oppName || '?').trim().charAt(0).toUpperCase();
      ui.meInitial.textContent = (s.myName || 'Y').trim().charAt(0).toUpperCase();
      if (fresh) {
        sid = Math.random().toString(36).slice(2, 10);
        remoteSid = '';
        ui.panel.classList.remove('hidden'); document.body.classList.add('with-video');
        meter = meter || createMeter(ui);
        startMedia();
        if (s.oppKey) msg('hello');
      } else if (oppChanged) {
        remoteSid = ''; remoteState = { mic: true, cam: true }; closePc();
        if (s.oppKey) msg('hello');
      }
      render();
    },
    /** A my_rtc row: process in order, then acknowledge so the server can delete it. */
    receive(row) {
      if (row.id <= lastId) return;
      lastId = row.id;
      if (!session || row.matchId !== session.matchId) { scheduleAck(); return; }
      let m = null;
      try { m = JSON.parse(row.data); } catch { /* malformed */ }
      chain = chain.then(() => handle(m)).catch(e => console.warn('video signaling', e));
      scheduleAck();
    },
  };

  function scheduleAck() {
    clearTimeout(ackTimer);
    ackTimer = setTimeout(() => ack(lastId), 250);
  }
}

// Speaking indicator: a soft glow on a tile while that person talks.
function createMeter(ui) {
  let ac = null;
  try { ac = new AudioContext(); } catch { return null; }
  const srcs = { me: null, opp: null };
  const tiles = { me: ui.meTile, opp: ui.oppTile };
  const buf = new Uint8Array(256);
  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    for (const k of ['me', 'opp']) {
      const s = srcs[k];
      if (!s) { tiles[k].style.setProperty('--talk', '0'); continue; }
      s.an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 6);
      s.level += (level - s.level) * (level > s.level ? 0.5 : 0.08);
      tiles[k].style.setProperty('--talk', s.level > 0.12 ? s.level.toFixed(2) : '0');
    }
  };
  raf = requestAnimationFrame(tick);
  return {
    watch(k, stream) {
      srcs[k]?.node.disconnect();
      srcs[k] = null;
      if (!stream) return;
      if (ac.state === 'suspended') ac.resume().catch(() => {});
      const node = ac.createMediaStreamSource(stream), an = ac.createAnalyser();
      an.fftSize = 512; node.connect(an);
      srcs[k] = { node, an, level: 0 };
    },
    close() { cancelAnimationFrame(raf); ac.close().catch(() => {}); },
  };
}
