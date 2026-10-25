// Lane physics for bowling: a hooking ball and ten pins on the lane plane (x across, z down the lane,
// foul line at z = 0, bowler looking toward −z). Pins are circles that topple: a toppling pin's body
// sweeps its neighbours, which is where strikes come from. Pure JS (no three.js) so it can be tested headless.

export const LANE_HALF = 0.533;           // 41.5" lane
export const GUTTER_X = LANE_HALF + 0.118;
export const KICKBACK_X = LANE_HALF + 0.26;
export const BALL_R = 0.109;
export const PIN_R = 0.06;                // at the belly, where pins touch each other and the ball
export const PIN_H = 0.381;
export const HEAD_Z = -18.29;             // head pin, 60 ft from the foul line
export const PIT_Z = -19.45;
export const RELEASE_Z = -0.35;
const PIN_SP = 0.3048, ROW_SP = 0.264;
const BALL_M = 6.8, PIN_M = 1.6;
const TIP_DV = 0.24;                      // impulse (m/s) that knocks a standing pin over
const HOOK = 0.5;                        // lateral pull (m/s²) at full spin once the ball leaves the oil

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Pin spots, pin 1 first: rows of 1-2-3-4 going away from the bowler, numbered left to right. */
export const PIN_SPOTS = [];
for (let r = 0; r < 4; r++) for (let k = 0; k <= r; k++) PIN_SPOTS.push({ x: (k - r / 2) * PIN_SP, z: HEAD_Z - r * ROW_SP });

// Pins that touch in the rack (for calling splits).
const NEIGHBOURS = PIN_SPOTS.map((a, i) => PIN_SPOTS.map((b, j) => (i !== j && Math.hypot(a.x - b.x, a.z - b.z) < PIN_SP * 1.05 ? j : -1)).filter(j => j >= 0));

/** Launch speed (m/s) for a swing power of 0–1.2. */
export const speedOf = power => 5.4 + clamp(power, 0, 1.2) * 3.4;

export function createLane(standing = 0x3ff) {
  return {
    t: 0,
    ball: { x: 0, z: RELEASE_Z, y: BALL_R, vx: 0, vz: 0, vy: 0, spin: 0, live: false, gutter: false, gone: false, roll: 0 },
    // Pins never sit exactly on their spots, so the same throw doesn't always do the same thing.
    pins: PIN_SPOTS.map((s, i) => ({
      i, x: s.x + (Math.random() - 0.5) * 0.012, z: s.z + (Math.random() - 0.5) * 0.012, y: 0, vx: 0, vz: 0, vy: 0, up: !!(standing & (1 << i)),
      state: standing & (1 << i) ? 'standing' : 'gone',   // standing | falling | down | gone
      tilt: 0, tiltV: 0, dx: 0, dz: 1, yaw: (i * 2.39) % (Math.PI * 2), yawV: 0, wobble: 0,
    })),
    hitPins: false,
    firstHitT: 0,
  };
}

export function launch(lane, { power, aim, spin, x = 0 }) {
  const b = lane.ball, sp = speedOf(power), a = clamp(aim, -1, 1) * 0.032 + (Math.random() - 0.5) * 0.0025;
  Object.assign(b, { x, z: RELEASE_Z, y: BALL_R, vx: Math.sin(a) * sp, vz: -Math.cos(a) * sp, vy: 0, spin: clamp(spin, -1, 1), live: true, gutter: false, gone: false });
  lane.t = 0; lane.hitPins = false; lane.firstHitT = 0;
}

// Collision circles of a pin: one at the base when standing; a toppling pin also sweeps its body and head.
function pinShapes(p, out) {
  out.length = 0;
  const s = Math.sin(p.tilt), c = Math.cos(p.tilt);
  out.push({ x: p.x + p.dx * s * 0.09, z: p.z + p.dz * s * 0.09, r: PIN_R, lever: 0.09 * c });
  if (p.state !== 'standing') {
    out.push({ x: p.x + p.dx * s * 0.21, z: p.z + p.dz * s * 0.21, r: PIN_R * 0.95, lever: 0.21 * c });
    out.push({ x: p.x + p.dx * s * 0.34, z: p.z + p.dz * s * 0.34, r: PIN_R * 0.75, lever: 0.34 * c });
  }
  return out;
}

function topple(p, nx, nz, dv, events) {
  if (p.state !== 'standing') { p.tiltV = Math.max(p.tiltV, Math.min(dv * 2.5, 10)); return; }
  const l = Math.hypot(p.vx, p.vz);
  const dx = l > 0.05 ? p.vx / l : nx, dz = l > 0.05 ? p.vz / l : nz;
  p.state = 'falling'; p.dx = dx; p.dz = dz;
  p.tiltV = clamp(dv * 3.2, 2.5, 14);
  p.yawV = (Math.random() - 0.5) * 14;
  if (dv > 2.5) p.vy = Math.min(2.6, dv * 0.22);
  events.push({ type: 'pin', i: p.i, power: Math.min(1, dv / 6) });
}

const _a = [], _b = [];
export function stepLane(lane, dt, events = []) {
  lane.t += dt;
  const b = lane.ball;
  if (b.live && !b.gone) {
    if (!b.gutter) {
      // The front of the lane is oiled; the ball hooks once it reads the dry back end.
      const hook = b.spin * HOOK * smooth(-5.5, -13, b.z) * (b.z > HEAD_Z + 0.4 ? 1 : 0.25);
      b.vx += hook * dt;
      if (Math.abs(b.x) > LANE_HALF - 0.02 && b.z > HEAD_Z + 0.3) { b.gutter = true; events.push({ type: 'gutter', side: Math.sign(b.x) }); }
    } else {
      b.vx += (Math.sign(b.x) * GUTTER_X - b.x) * 30 * dt - b.vx * 8 * dt;
      b.y += (BALL_R - 0.07 - b.y) * Math.min(1, dt * 14);
    }
    b.vz += 0.12 * dt;                     // a little friction (vz is negative)
    b.x += b.vx * dt; b.z += b.vz * dt;
    b.roll += Math.hypot(b.vx, b.vz) / BALL_R * dt;
    if (b.z < PIT_Z - 0.2) { b.gone = true; events.push({ type: 'pit' }); }
  }

  for (const p of lane.pins) {
    if (p.state === 'gone') continue;
    // Toppling: gravity pulls a leaning pin down faster the further it leans.
    if (p.state === 'falling') {
      p.tiltV += (22 * Math.sin(p.tilt) + 3) * dt;
      p.tilt += p.tiltV * dt;
      if (p.tilt >= Math.PI / 2) { p.tilt = Math.PI / 2; p.tiltV = 0; p.state = 'down'; events.push({ type: 'thud', i: p.i }); }
    }
    p.wobble *= Math.exp(-dt * 5);
    const sp = Math.hypot(p.vx, p.vz);
    if (sp > 0) {
      const f = Math.max(0, sp - (p.state === 'standing' ? 5 : 2.2) * dt) / sp;
      p.vx *= f; p.vz *= f;
    }
    p.x += p.vx * dt; p.z += p.vz * dt;
    p.yaw += p.yawV * dt; p.yawV *= Math.exp(-dt * 2);
    if (p.vy || p.y > 0) {
      p.vy -= 9.8 * dt; p.y += p.vy * dt;
      if (p.y < 0) { p.y = 0; p.vy = p.vy < -1 ? -p.vy * 0.3 : 0; }
    }
    // Kickbacks bounce pins back onto the deck; slow pins over the gutter drop in; the pit swallows the rest.
    if (Math.abs(p.x) > KICKBACK_X && p.z < HEAD_Z + 0.6) { p.x = Math.sign(p.x) * KICKBACK_X; p.vx = -p.vx * 0.55; events.push({ type: 'kick', power: Math.min(1, Math.abs(p.vx) / 4) }); }
    if (Math.abs(p.x) > LANE_HALF + 0.03 && (sp < 1.6 || p.z > HEAD_Z + 0.6)) p.state = 'gone';
    if (p.z < PIT_Z || p.z > HEAD_Z + 3) p.state = 'gone';
  }

  // Ball ↔ pins
  if (b.live && !b.gone && !b.gutter && b.z < HEAD_Z + 0.8) {
    for (const p of lane.pins) {
      if (p.state === 'gone' || p.y > 0.3) continue;
      for (const s of pinShapes(p, _a)) {
        const dx = s.x - b.x, dz = s.z - b.z, d = Math.hypot(dx, dz), min = BALL_R + s.r;
        if (d >= min || d < 1e-6) continue;
        const nx = dx / d, nz = dz / d;
        const rel = (b.vx - p.vx) * nx + (b.vz - p.vz) * nz;
        const push = (min - d);
        p.x += nx * push * 0.8; p.z += nz * push * 0.8; b.x -= nx * push * 0.2; b.z -= nz * push * 0.2;
        if (rel <= 0) break;
        const j = (1 + 0.72) * rel / (1 / BALL_M + 1 / PIN_M);
        b.vx -= (j / BALL_M) * nx; b.vz -= (j / BALL_M) * nz;
        p.vx += (j / PIN_M) * nx; p.vz += (j / PIN_M) * nz;
        if (!lane.hitPins) { lane.hitPins = true; lane.firstHitT = lane.t; }
        events.push({ type: 'ball-pin', power: Math.min(1, rel / 8) });
        topple(p, nx, nz, j / PIN_M, events);
        break;
      }
    }
  }

  // Pin ↔ pin
  const pins = lane.pins;
  for (let i = 0; i < pins.length; i++) {
    const p = pins[i];
    if (p.state === 'gone') continue;
    for (let k = i + 1; k < pins.length; k++) {
      const q = pins[k];
      if (q.state === 'gone') continue;
      if (Math.abs(p.x - q.x) > 0.8 || Math.abs(p.z - q.z) > 0.8) continue;
      if (p.state === 'down' && q.state === 'down' && Math.hypot(p.vx - q.vx, p.vz - q.vz) < 0.2) continue;
      pinShapes(p, _a); pinShapes(q, _b);
      let hit = false;
      for (const s of _a) {
        for (const r of _b) {
          const dx = r.x - s.x, dz = r.z - s.z, d = Math.hypot(dx, dz), min = s.r + r.r;
          if (d >= min || d < 1e-6) continue;
          const nx = dx / d, nz = dz / d;
          // Velocity of each contact point: sliding plus the sweep of a toppling body.
          const pvx = p.vx + p.dx * s.lever * p.tiltV, pvz = p.vz + p.dz * s.lever * p.tiltV;
          const qvx = q.vx + q.dx * r.lever * q.tiltV, qvz = q.vz + q.dz * r.lever * q.tiltV;
          const rel = (pvx - qvx) * nx + (pvz - qvz) * nz;
          const push = (min - d) * 0.5;
          p.x -= nx * push; p.z -= nz * push; q.x += nx * push; q.z += nz * push;
          if (rel > 0) {
            const j = (1 + 0.7) * rel / 2;   // equal masses
            p.vx -= j * nx; p.vz -= j * nz; q.vx += j * nx; q.vz += j * nz;
            if (j > 0.15) events.push({ type: 'clack', power: Math.min(1, j / 3) });
            if (j > TIP_DV) { topple(q, nx, nz, j, events); if (p.state === 'standing' && j > TIP_DV * 1.6) topple(p, -nx, -nz, j * 0.6, events); }
            else { q.wobble = Math.min(1, q.wobble + j * 3); p.wobble = Math.min(1, p.wobble + j * 2); }
          }
          hit = true; break;
        }
        if (hit) break;
      }
    }
  }
  return events;
}

/** True once the ball is gone and nothing on the deck is still moving. */
export function settled(lane) {
  const b = lane.ball;
  if (!b.gone && b.live) return false;
  return lane.pins.every(p => p.state === 'gone' || (p.state !== 'falling' && Math.hypot(p.vx, p.vz) < 0.04 && p.y === 0));
}

/** Pins (bitmask) that were standing for this ball and aren't any more. */
export function knockedMask(lane, standingBefore) {
  let m = 0;
  for (const p of lane.pins) if (standingBefore & (1 << p.i) && (p.state !== 'standing')) m |= 1 << p.i;
  return m;
}

export function standingMask(lane) {
  let m = 0;
  for (const p of lane.pins) if (p.state === 'standing') m |= 1 << p.i;
  return m;
}

/** A split: the head pin is down and what's left stands in separate, non-touching groups. */
export function isSplit(standing) {
  if (standing & 1) return false;
  const left = PIN_SPOTS.map((_, i) => i).filter(i => standing & (1 << i));
  if (left.length < 2) return false;
  const seen = new Set([left[0]]), todo = [left[0]];
  while (todo.length) for (const j of NEIGHBOURS[todo.pop()]) if (standing & (1 << j) && !seen.has(j)) { seen.add(j); todo.push(j); }
  return seen.size < left.length;
}

/** Where the ball would go with no pins in the way (for the aim guide). */
export function previewPath(aim, spin, power = 0.7, step = 0.5) {
  const lane = createLane(0);
  launch(lane, { power, aim, spin });
  const pts = [{ x: lane.ball.x, z: lane.ball.z }];
  let next = lane.ball.z - step;
  for (let i = 0; i < 4000 && !lane.ball.gutter && lane.ball.z > HEAD_Z; i++) {
    stepLane(lane, 1 / 240);
    if (lane.ball.z <= next) { pts.push({ x: lane.ball.x, z: lane.ball.z }); next -= step; }
  }
  return { pts, gutter: lane.ball.gutter };
}
