// Sponsor artwork for the arena signage (LED boards, barriers, masking units, jumbotron):
// SpacetimeDB is drawn on canvas; the Cal Hacks 13.0 logo is the official SVG from calhacks.io.
import calHacksUrl from './assets/calhacks-13.svg';

const calHacks = new Image();
calHacks.src = calHacksUrl;
const ready = [];
calHacks.onload = () => { for (const fn of ready.splice(0)) fn(); };

/** Run fn now if the Cal Hacks logo has loaded, else once it does (redraw the sign + flag the texture). */
export function onBrandReady(fn) {
  if (calHacks.complete && calHacks.naturalWidth) fn(); else ready.push(fn);
}

/**
 * The Cal Hacks 13.0 logo on a light sponsor plate, centred on (cx, cy), plate `h` px tall.
 * (Its navy lettering is made for a light background.) The plate shows even before the logo loads.
 */
export function drawCalHacks(ctx, cx, cy, h) {
  const sx = 125, sy = 125, sw = 630, sh = 440;   // the lettering's box inside the SVG
  const lh = h * 0.86, lw = lh * sw / sh, pw = lw + h * 0.5;
  ctx.save();
  const g = ctx.createLinearGradient(0, cy - h / 2, 0, cy + h / 2); g.addColorStop(0, '#f4f8fd'); g.addColorStop(1, '#d5e3f1');
  ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(cx - pw / 2, cy - h / 2, pw, h, h * 0.16); ctx.fill();
  if (calHacks.complete && calHacks.naturalWidth) ctx.drawImage(calHacks, sx, sy, sw, sh, cx - lw / 2, cy - lh / 2, lw, lh);
  ctx.restore();
  return pw;
}

/** The SpacetimeDB mark: a ring with two swept blades, centred at (cx, cy) with radius r. */
export function drawSpacetimeLogo(ctx, cx, cy, r, color = '#ffffff') {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = color; ctx.strokeStyle = color;
  ctx.lineWidth = r * 0.2;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2); ctx.stroke();
  // Two blades: each hugs the ring for a stretch, then sweeps out to a sharp tip.
  for (const rot of [0, Math.PI]) {
    ctx.save(); ctx.rotate(rot);
    ctx.beginPath();
    ctx.moveTo(r * -0.62, r * 0.12);
    ctx.bezierCurveTo(r * -0.72, r * -0.55, r * -0.1, r * -0.92, r * 0.42, r * -0.72);
    ctx.lineTo(r * 1.05, r * -1.05);
    ctx.bezierCurveTo(r * 0.55, r * -0.5, r * 0.1, r * -0.72, r * -0.25, r * -0.6);
    ctx.bezierCurveTo(r * -0.55, r * -0.48, r * -0.66, r * -0.18, r * -0.62, r * 0.12);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/**
 * Logo + "SpacetimeDB" wordmark centred on (cx, cy), `size` = cap height in px.
 * "Spacetime" is heavy, "DB" light, as in the real wordmark. Returns the drawn width.
 */
export function drawSpacetimeWordmark(ctx, cx, cy, size, { color = '#ffffff', db = 'rgba(255,255,255,0.72)' } = {}) {
  ctx.save();
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const heavy = `700 ${size}px "Helvetica Neue", Arial, sans-serif`, light = `300 ${size}px "Helvetica Neue", Arial, sans-serif`;
  ctx.font = heavy; const w1 = ctx.measureText('Spacetime').width;
  ctx.font = light; const w2 = ctx.measureText('DB').width;
  const logoR = size * 0.62, gap = size * 0.35, total = logoR * 2 + gap + w1 + w2;
  let x = cx - total / 2;
  drawSpacetimeLogo(ctx, x + logoR, cy, logoR, color);
  x += logoR * 2 + gap;
  ctx.fillStyle = color; ctx.font = heavy; ctx.fillText('Spacetime', x, cy + size * 0.04);
  ctx.fillStyle = db; ctx.font = light; ctx.fillText('DB', x + w1, cy + size * 0.04);
  ctx.restore();
  return total;
}

/** Faint orbit rings behind the logo, like SpacetimeDB's own artwork. */
export function drawOrbits(ctx, cx, cy, r, alpha = 0.18) {
  ctx.save();
  ctx.strokeStyle = `rgba(160,140,255,${alpha})`; ctx.lineWidth = 2;
  for (let i = 1; i <= 4; i++) { ctx.beginPath(); ctx.ellipse(cx, cy, r * i * 0.55, r * i * 0.2, 0, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
}
