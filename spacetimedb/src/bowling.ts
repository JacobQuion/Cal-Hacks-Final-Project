// Ten-pin scoring, shared by the SpacetimeDB module (which keeps score) and the browser (which draws
// the scorecard and calls the result the moment the pins settle). Pins are bits 0–9 = pins 1–10.

export const FULL_RACK = 0x3ff;

export const pinCount = (mask: number) => {
  let n = 0;
  for (let m = mask & FULL_RACK; m; m &= m - 1) n++;
  return n;
};

export interface BowlFrame { rolls: number[]; total: number | null }
export interface BowlState {
  frames: BowlFrame[];   // 10 frames; total is the running score once the frame can be scored
  frame: number;         // frame of the next ball (0–9)
  ball: number;          // ball of the next ball within its frame (0–2)
  fresh: boolean;        // the next ball faces a full rack
  up: number;            // pins standing for the next ball
  done: boolean;
  score: number;         // running total so far (scored frames only)
  strikes: number;
  spares: number;
}

export function bowlState(rolls: readonly number[]): BowlState {
  const frames: BowlFrame[] = [];
  const starts: number[] = [];
  let i = 0, frame = 0, ball = 0, fresh = true, up = 10, done = false;
  for (let f = 0; f < 10; f++) {
    starts.push(i);
    const r: number[] = [];
    if (f < 9) {
      if (i < rolls.length) r.push(rolls[i++]);
      if (r.length === 1 && r[0] < 10 && i < rolls.length) r.push(rolls[i++]);
      frames.push({ rolls: r, total: null });
      const complete = r.length === 2 || r[0] === 10;
      if (!complete) { frame = f; ball = r.length; fresh = r.length === 0; up = 10 - (r[0] ?? 0); break; }
    } else {
      while (r.length < 3 && i < rolls.length) r.push(rolls[i++]);
      frames.push({ rolls: r, total: null });
      const need = r.length >= 2 && (r[0] === 10 || r[0] + r[1] === 10) ? 3 : 2;
      frame = 9; ball = r.length;
      if (r.length >= need) { done = true; fresh = false; up = 0; break; }
      if (r.length === 0) { fresh = true; up = 10; }
      else if (r.length === 1) { fresh = r[0] === 10; up = fresh ? 10 : 10 - r[0]; }
      else { fresh = r[1] === 10 || (r[0] < 10 && r[0] + r[1] === 10); up = fresh ? 10 : 10 - r[1]; }
    }
  }
  while (frames.length < 10) frames.push({ rolls: [], total: null });

  // Running totals: a strike waits for two more balls, a spare for one.
  let score = 0, strikes = 0, spares = 0;
  for (let f = 0; f < 10; f++) {
    const r = frames[f].rolls, s = starts[f];
    if (s === undefined || !r.length) break;
    if (f < 9) {
      if (r[0] === 10) {
        strikes++;
        if (rolls.length < s + 3) break;
        score += 10 + rolls[s + 1] + rolls[s + 2];
      } else if (r.length === 2 && r[0] + r[1] === 10) {
        spares++;
        if (rolls.length < s + 3) break;
        score += 10 + rolls[s + 2];
      } else if (r.length === 2) score += r[0] + r[1];
      else break;
    } else {
      const marks = frameMarks(frames[f], true);
      strikes += marks.filter(m => m === 'X').length;
      spares += marks.filter(m => m === '/').length;
      if (!done) break;
      score += r.reduce((a, b) => a + b, 0);
    }
    frames[f].total = score;
  }
  return { frames, frame, ball, fresh, up, done, score, strikes, spares };
}

/** Scorecard marks for one frame: X, /, - or a number per box (the 10th frame has three boxes). */
export function frameMarks(f: BowlFrame, tenth: boolean): string[] {
  const r = f.rolls, out: string[] = [];
  const n = (v: number) => (v === 0 ? '-' : String(v));
  if (!tenth) {
    if (r[0] === 10) return ['', 'X'];
    if (r.length) out.push(n(r[0]));
    if (r.length > 1) out.push(r[0] + r[1] === 10 ? '/' : n(r[1]));
    return out;
  }
  let rackStart = 0;   // index of the ball that faced a full rack
  r.forEach((v, k) => {
    const prev = k > rackStart ? r[k - 1] : null;
    if (prev === null) { out.push(v === 10 ? 'X' : n(v)); if (v === 10) rackStart = k + 1; }
    else { out.push(prev + v === 10 ? '/' : n(v)); rackStart = k + 1; }
  });
  return out;
}

/** What to call a ball that knocked down `pins`, given the balls before it. */
export function callRoll(prev: readonly number[], pins: number): 'strike' | 'spare' | 'gutter' | 'pins' {
  const st = bowlState(prev);
  if (st.fresh && pins === 10) return 'strike';
  if (!st.fresh && pins === st.up) return 'spare';
  return pins === 0 ? 'gutter' : 'pins';
}
