// Synthesized sounds (no audio files needed).
let ctx = null, master = null, noiseBuf = null;

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.7; master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch { ctx = null; }
}

function tone(freq, dur, { type = 'sine', vol = 0.3, slide = 0, delay = 0 } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
}

function noise(dur, { freq = 2000, q = 1, vol = 0.3, attack = 0.002, type = 'bandpass', sweep = 0, delay = 0 } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + delay;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(50, freq + sweep), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + dur + 0.02);
}

export const sfx = {
  hit(power, smash) {
    noise(0.06, { freq: 3200, q: 1.5, vol: 0.45 + power * 0.3 });
    tone(900 + power * 400, 0.06, { type: 'triangle', vol: 0.3, slide: -350 });
    if (smash) { noise(0.25, { freq: 900, q: 0.7, vol: 0.4, sweep: -600 }); tone(160, 0.2, { vol: 0.35, slide: -80 }); }
  },
  swoosh() { noise(0.22, { freq: 600, q: 1.2, vol: 0.18, attack: 0.04, sweep: 1800 }); },
  land() { noise(0.08, { freq: 400, q: 0.8, vol: 0.25 }); tone(180, 0.08, { vol: 0.15, slide: -60 }); },
  net() { noise(0.16, { freq: 700, q: 0.6, vol: 0.3 }); },
  point() { [0, 4, 7, 12].forEach((s, i) => tone(587 * 2 ** (s / 12), 0.2, { type: 'triangle', vol: 0.18, delay: i * 0.07 })); },
  lose() { tone(392, 0.18, { type: 'square', vol: 0.07, slide: -120 }); tone(262, 0.3, { type: 'square', vol: 0.07, slide: -90, delay: 0.14 }); },
  // Crowd: a roar that swells and fades, whoops gliding up, and applause. i = how excited (0–1).
  cheer(i = 0.5) {
    if (!ctx) return;
    const dur = 1.6 + i * 1.4;
    for (const [freq, q, v] of [[420, 1.1, 1], [950, 1.4, 0.75], [1800, 2, 0.5], [2700, 2.6, 0.28]]) {
      noise(dur, { freq, q, vol: (0.06 + i * 0.12) * v, attack: 0.25, sweep: freq * 0.15 });
    }
    const whoops = 2 + Math.round(i * 6);
    for (let k = 0; k < whoops; k++) {
      tone(480 + Math.random() * 520, 0.3 + Math.random() * 0.35, { vol: 0.018 + i * 0.03, slide: 350 + Math.random() * 650, delay: 0.08 + Math.random() * dur * 0.45 });
    }
    sfx.applause(dur * 0.9, 0.4 + i * 0.6);
  },
  /** Many hands clapping for `dur` seconds. */
  applause(dur = 1.4, i = 0.5) {
    if (!ctx) return;
    const claps = Math.round(dur * (18 + i * 40));
    for (let k = 0; k < claps; k++) {
      const at = Math.random() * dur, fade = 1 - at / dur;
      noise(0.025 + Math.random() * 0.02, { freq: 1300 + Math.random() * 1700, q: 1.2, vol: (0.04 + i * 0.07) * (0.35 + 0.65 * fade), attack: 0.001, delay: at });
    }
  },
  hover() { tone(1180, 0.045, { type: 'triangle', vol: 0.09, slide: 220 }); },
  ui() { tone(880, 0.06, { type: 'triangle', vol: 0.2 }); tone(1320, 0.08, { type: 'triangle', vol: 0.15, delay: 0.04 }); },
  connect() { [0, 7, 12].forEach((s, i) => tone(660 * 2 ** (s / 12), 0.14, { type: 'triangle', vol: 0.16, delay: i * 0.08 })); },
  // Bowling
  rumble(dur, vol = 1) {
    noise(dur, { freq: 160, q: 0.9, vol: 0.32 * vol, attack: 0.08, type: 'lowpass', sweep: 120 });
    noise(dur * 0.9, { freq: 420, q: 2, vol: 0.05 * vol, attack: 0.1, sweep: 300 });
  },
  pins(power, vol = 1) {
    const n = 2 + Math.round(power * 7);
    for (let i = 0; i < n; i++) {
      const d = Math.random() * (0.05 + power * 0.25);
      noise(0.05 + Math.random() * 0.05, { freq: 2200 + Math.random() * 2400, q: 3, vol: (0.18 + power * 0.25) * vol, delay: d });
      tone(900 + Math.random() * 900, 0.07, { type: 'triangle', vol: (0.08 + power * 0.1) * vol, slide: -200, delay: d });
    }
    if (power > 0.5) noise(0.5, { freq: 1400, q: 0.6, vol: 0.2 * power * vol, attack: 0.01, sweep: -900 });
  },
  clack(power, vol = 1) { noise(0.04, { freq: 3000 + Math.random() * 1500, q: 4, vol: (0.06 + power * 0.2) * vol }); },
  thud(vol = 1) { noise(0.09, { freq: 320, q: 1, vol: 0.14 * vol, type: 'lowpass' }); },
  gutter() { noise(0.5, { freq: 700, q: 3, vol: 0.12, attack: 0.03, sweep: -400 }); tone(220, 0.3, { type: 'square', vol: 0.05, slide: -90, delay: 0.1 }); },
  sweep() { noise(0.9, { freq: 260, q: 1.5, vol: 0.12, attack: 0.1, type: 'lowpass', sweep: 220 }); tone(110, 0.8, { type: 'sawtooth', vol: 0.025, slide: 30 }); },
  strike() { [0, 4, 7, 12, 16].forEach((s, i) => tone(523 * 2 ** (s / 12), 0.22, { type: 'square', vol: 0.06, delay: i * 0.07 })); },
  // Ping pong
  pock(vol = 1, pitch = 1) { tone(1500 * pitch, 0.035, { type: 'triangle', vol: 0.22 * vol, slide: -500 }); noise(0.03, { freq: 3800 * pitch, q: 2, vol: 0.2 * vol }); },
  paddle(power = 0.5) { tone(900 + power * 500, 0.045, { type: 'triangle', vol: 0.3, slide: -400 }); noise(0.05, { freq: 2600 + power * 1600, q: 1.4, vol: 0.3 + power * 0.25 }); if (power > 0.8) noise(0.18, { freq: 1200, q: 0.7, vol: 0.18, sweep: -700 }); },
  win() { [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => tone(523 * 2 ** (s / 12), 0.25, { type: 'triangle', vol: 0.16, delay: i * 0.09 })); },
};
