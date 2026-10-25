// Table tennis scoring, shared by the SpacetimeDB module (which keeps score) and the browser (which
// shows whose serve it is). Seat 0 = the player, 1 = the NPC.

export const PONG_TO = 11;

/** First to 11, win by two. */
export const pongDone = (me: number, cpu: number) => (me >= PONG_TO || cpu >= PONG_TO) && Math.abs(me - cpu) >= 2;

/** Who serves the next point: two serves each, then one each from 10–10. */
export function pongServer(me: number, cpu: number, firstServer: number): number {
  const n = me + cpu;
  const turns = n < 20 ? Math.floor(n / 2) : 10 + (n - 20);
  return (firstServer + turns) % 2;
}

export const PONG_LEVELS = ['Easy', 'Medium', 'Hard'];
