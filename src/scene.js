import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { HALF_L, HALF_W, HALF_W_DOUBLES, SHORT_LINE, NET_H } from './physics.js';

// Broadcast-style indoor arena: PBR court and floors, a real net, detailed athletes with secondary
// animation (knees, balance arm, head tracking the shuttle), a feathered shuttle, tiered stands with
// an instanced crowd, scrolling LED boards, a live jumbotron, light shafts and a filmic grade.
// Everything is procedural (no asset downloads). The interface main.js relies on is unchanged:
// player/cpu { group, body, shoulder, legs, racket, head }, shuttle (+Y = cork = direction of travel),
// crowd.update, update(t, dt, excite), render(), setPixelRatio(pr).

export const SHUTTLE_SCALE = 2.4; // drawn a bit larger than real so it reads at laptop distance

const TEAM = {
  you: { shirt: 0x1f6fff, trim: 0xffffff, accent: 0x00d4ff, shorts: 0x0d1630, racket: 0x1f8bff, number: '7' },
  cpu: { shirt: 0xe8304f, trim: 0xffffff, accent: 0xffb000, shorts: 0x15151c, racket: 0xff3355, number: '10' },
};

// ---------- small utilities ----------
let seed = 1337;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function canvas(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  return c;
}
function tex(c, { repeat, srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
// Tileable height noise → tangent-space normal map (for mats, floors, fabric).
function noiseCanvas(size, layers) {
  return canvas(size, size, (ctx, w, h) => {
    ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, w, h);
    for (const [count, rMin, rMax, alpha] of layers) {
      for (let i = 0; i < count; i++) {
        const x = rnd() * w, y = rnd() * h, r = rMin + rnd() * (rMax - rMin);
        ctx.fillStyle = rnd() > 0.5 ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
        for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) { ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2); ctx.fill(); }
      }
    }
  });
}
function normalFromHeight(src, strength = 2) {
  const w = src.width, h = src.height;
  const s = src.getContext('2d').getImageData(0, 0, w, h).data;
  return canvas(w, h, (ctx) => {
    const out = ctx.createImageData(w, h), d = out.data;
    const H = (x, y) => s[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
      d[i] = (-dx / l * 0.5 + 0.5) * 255; d[i + 1] = (dy / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
  });
}
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, ...o });
const phys = (color, o = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.6, metalness: 0, ...o });
const hdr = (color, k) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), toneMapped: true });
function shadowy(obj, cast = true, receive = true) {
  obj.traverse(o => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; } });
  return obj;
}
function softDisc(inner = 'rgba(0,0,0,0.55)', size = 128) {
  return tex(canvas(size, size, (ctx, w) => {
    const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, inner); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
  }));
}

// Tapered limb along −Y from 0 to −len with rounded ends (radius r0 at the top, r1 at the bottom).
function limbGeo(r0, r1, len, radial = 18) {
  const pts = [];
  for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2); pts.push(new THREE.Vector2(Math.max(1e-4, Math.cos(a) * r1), -len + r1 + Math.sin(a) * r1)); }
  for (let i = 0; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); pts.push(new THREE.Vector2(Math.max(1e-4, Math.cos(a) * r0), -r0 + Math.sin(a) * r0)); }
  return new THREE.LatheGeometry(pts, radial);
}
const upLimb = (r0, r1, len, radial) => limbGeo(r0, r1, len, radial).rotateX(Math.PI); // 0 → +len

// ---------- reflections: an HDR environment shaped like the arena (ceiling light banks, LED rings) ----------
function makeEnvironment(renderer) {
  const s = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(44, 20, 50), new THREE.MeshBasicMaterial({ color: 0x0b0d14, side: THREE.BackSide }));
  room.position.y = 9; s.add(room);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 30), new THREE.MeshBasicMaterial({ color: 0x0c2546 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = 0.01; s.add(floor);
  const court = new THREE.Mesh(new THREE.PlaneGeometry(9, 17), new THREE.MeshBasicMaterial({ color: 0x1b5a44 }));
  court.rotation.x = -Math.PI / 2; court.position.y = 0.02; s.add(court);
  const panel = hdr(0xfff3e6, 9);
  for (const x of [-5, 0, 5]) for (const z of [-9, -3, 3, 9]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.1), panel);
    p.rotation.x = Math.PI / 2; p.position.set(x, 15, z); s.add(p);
  }
  const ring = [[0x1f8bff, 2.2], [0xff2d6f, 2.0], [0x00e0c0, 1.8], [0xffb000, 1.8]];
  ring.forEach(([c, k], i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(i % 2 ? 22 : 15, 0.9), hdr(c, k));
    const a = (i * Math.PI) / 2;
    m.position.set(Math.sin(a) * (i % 2 ? 7.5 : 11), 0.6, Math.cos(a) * (i % 2 ? 7.5 : 11));
    m.lookAt(0, 0.6, 0); s.add(m);
  });
  const stands = new THREE.Mesh(new THREE.CylinderGeometry(19, 13, 6, 32, 1, true), new THREE.MeshBasicMaterial({ color: 0x161a26, side: THREE.BackSide }));
  stands.position.y = 3; s.add(stands);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(s, 0.02).texture;
  pmrem.dispose();
  return env;
}

// ---------- floors and court ----------
function makeFloors() {
  const g = new THREE.Group();

  // Hardwood beyond the field of play
  const wood = canvas(1024, 1024, (ctx, w, h) => {
    const plank = w / 10;
    for (let i = 0; i < 10; i++) {
      let y = -rnd() * h;
      while (y < h) {
        const len = h * (0.35 + rnd() * 0.5);
        const l = 30 + rnd() * 14;
        ctx.fillStyle = `hsl(${26 + rnd() * 8}, ${45 + rnd() * 15}%, ${l}%)`;
        ctx.fillRect(i * plank, y, plank, len);
        ctx.strokeStyle = 'rgba(40,20,8,0.25)'; ctx.lineWidth = 1;
        for (let k = 0; k < 14; k++) {
          const x = i * plank + rnd() * plank;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.bezierCurveTo(x + rnd() * 6 - 3, y + len * 0.3, x + rnd() * 6 - 3, y + len * 0.7, x + rnd() * 4 - 2, y + len); ctx.stroke();
        }
        ctx.fillStyle = 'rgba(20,10,4,0.55)'; ctx.fillRect(i * plank, y + len - 2, plank, 2);
        y += len;
      }
      ctx.fillStyle = 'rgba(20,10,4,0.6)'; ctx.fillRect(i * plank, 0, 2, h);
    }
  });
  const woodMat = phys(0xffffff, { map: tex(wood, { repeat: [14, 14] }), roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.25, envMapIntensity: 0.8 });
  const woodFloor = new THREE.Mesh(new THREE.PlaneGeometry(56, 56), woodMat);
  woodFloor.rotation.x = -Math.PI / 2; woodFloor.position.y = -0.005; woodFloor.receiveShadow = true; g.add(woodFloor);

  // Field of play: deep blue sports surface with painted branding behind each baseline
  const fineN = tex(normalFromHeight(noiseCanvas(256, [[2600, 0.6, 1.6, 0.35], [500, 2, 4, 0.12]]), 3), { repeat: [10, 16], srgb: false });
  const fop = canvas(1024, 1536, (ctx, w, h) => {
    const gr = ctx.createRadialGradient(w / 2, h / 2, 50, w / 2, h / 2, h * 0.7);
    gr.addColorStop(0, '#16407a'); gr.addColorStop(1, '#0b2448');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 4; ctx.strokeRect(10, 10, w - 20, h - 20);
    ctx.font = '900 italic 64px "Arial Black", Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    for (const [y, rot] of [[h * 0.055, 0], [h * 0.945, 0]]) { // both read correctly from the broadcast (near) side
      ctx.save(); ctx.translate(w / 2, y); ctx.rotate(rot); ctx.fillText('RACKET RUSH', 0, 0); ctx.restore();
    }
  });
  const fopMat = phys(0xffffff, { map: tex(fop), normalMap: fineN, normalScale: new THREE.Vector2(0.25, 0.25), roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.18, envMapIntensity: 0.9 });
  const fopMesh = new THREE.Mesh(new THREE.PlaneGeometry(13.6, 20.4), fopMat);
  fopMesh.rotation.x = -Math.PI / 2; fopMesh.position.y = 0.001; fopMesh.receiveShadow = true; g.add(fopMesh);

  // Court mat: tournament green with crisp 40 mm white lines, a fine PVC grain and a slight sheen
  const W = 9, L = 17.4, ppm = 120, m = v => v * ppm;
  const courtC = canvas(W * ppm, L * ppm, (ctx, w, h) => {
    const cx = w / 2, cy = h / 2;
    ctx.fillStyle = '#145a43'; ctx.fillRect(0, 0, w, h);
    const gr = ctx.createRadialGradient(cx, cy, 10, cx, cy, h * 0.6);
    gr.addColorStop(0, 'rgba(255,255,255,0.05)'); gr.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
    // faint scuffs where players move most
    for (let i = 0; i < 220; i++) {
      const x = cx + (rnd() - 0.5) * m(5), y = cy + (rnd() > 0.5 ? 1 : -1) * m(2 + rnd() * 4);
      ctx.fillStyle = `rgba(255,255,255,${0.012 + rnd() * 0.02})`;
      ctx.beginPath(); ctx.ellipse(x, y, 4 + rnd() * 20, 2 + rnd() * 6, rnd() * Math.PI, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = '#e4e8e2'; ctx.lineWidth = m(0.04);
    const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(cx + m(x1), cy + m(y1)); ctx.lineTo(cx + m(x2), cy + m(y2)); ctx.stroke(); };
    ctx.strokeRect(cx - m(HALF_W_DOUBLES), cy - m(HALF_L), m(HALF_W_DOUBLES * 2), m(HALF_L * 2));
    for (const s of [-1, 1]) {
      line(s * HALF_W, -HALF_L, s * HALF_W, HALF_L);
      line(-HALF_W_DOUBLES, s * SHORT_LINE, HALF_W_DOUBLES, s * SHORT_LINE);
      line(-HALF_W_DOUBLES, s * (HALF_L - 0.76), HALF_W_DOUBLES, s * (HALF_L - 0.76));
      line(0, s * SHORT_LINE, 0, s * HALF_L);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 3; ctx.strokeRect(2, 2, w - 4, h - 4);
  });
  const matN = tex(normalFromHeight(noiseCanvas(256, [[5000, 0.5, 1.2, 0.4]]), 2.5), { repeat: [16, 30], srgb: false });
  const courtMat = phys(0xffffff, { map: tex(courtC, { aniso: 16 }), normalMap: matN, normalScale: new THREE.Vector2(0.35, 0.35), roughness: 0.7, clearcoat: 0.08, clearcoatRoughness: 0.5, envMapIntensity: 0.35 });
  const court = new THREE.Mesh(new THREE.BoxGeometry(W, 0.008, L), [std(0x175c45), std(0x175c45), courtMat, std(0x175c45), std(0x175c45), std(0x175c45)]);
  court.position.y = 0.004; court.receiveShadow = true; g.add(court);
  return g;
}

// ---------- net ----------
function makeNet() {
  const g = new THREE.Group();
  const span = HALF_W_DOUBLES;
  const cell = canvas(32, 32, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = 'rgba(14,14,16,0.95)';
    ctx.fillRect(0, 0, w, 3); ctx.fillRect(0, 0, 3, h);
  });
  const netH = 0.76;
  const netTex = tex(cell, { repeat: [span * 2 / 0.019, netH / 0.019], aniso: 16 });
  const net = new THREE.Mesh(new THREE.PlaneGeometry(span * 2, netH - 0.075),
    new THREE.MeshStandardMaterial({ map: netTex, color: 0x2a2c33, roughness: 0.8, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  net.position.set(0, NET_H - 0.075 - (netH - 0.075) / 2, 0); net.renderOrder = 2; g.add(net);
  const tapeMat = phys(0xf7f7f2, { roughness: 0.75, sheen: 0.6, sheenColor: 0xffffff });
  const tape = new THREE.Mesh(new RoundedBoxGeometry(span * 2, 0.075, 0.014, 2, 0.005), tapeMat);
  tape.position.set(0, NET_H - 0.0375, 0); g.add(tape);
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, span * 2, 6), std(0x222222));
  cord.rotation.z = Math.PI / 2; cord.position.set(0, NET_H - netH + 0.002, 0); g.add(cord);
  const postMat = phys(0x1b4d3e, { metalness: 0.55, roughness: 0.32, clearcoat: 0.6 });
  const baseMat = phys(0x16181f, { roughness: 0.5, clearcoat: 0.3 });
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, NET_H, 20), postMat);
    post.position.set(sx * (span + 0.02), NET_H / 2, 0); g.add(post);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 10), postMat);
    cap.position.set(sx * (span + 0.02), NET_H, 0); g.add(cap);
    const base = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.12, 0.72, 3, 0.03), baseMat);
    base.position.set(sx * (span + 0.14), 0.06, 0); g.add(base);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.345, 0.025, 0.725), hdr(0x1f8bff, 1.4));
    stripe.position.set(sx * (span + 0.14), 0.085, 0); g.add(stripe);
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.01, netH - 0.075, 0.016), tapeMat);
    band.position.set(sx * span, NET_H - 0.075 - (netH - 0.075) / 2, 0); g.add(band);
  }
  shadowy(g, true, true);
  net.castShadow = false;
  return g;
}

// ---------- LED boards (scrolling), jumbotron ----------
function ledCanvas(segments) {
  const W = 3072, H = 128;
  return canvas(W, H, (ctx) => {
    const seg = W / segments.length;
    segments.forEach(([bg1, bg2, fg, text, style], i) => {
      const x = i * seg;
      const gr = ctx.createLinearGradient(x, 0, x + seg, 0); gr.addColorStop(0, bg1); gr.addColorStop(1, bg2);
      ctx.fillStyle = gr; ctx.fillRect(x, 0, seg, H);
      ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = style || '900 italic 76px "Arial Black", Arial, sans-serif';
      ctx.fillText(text, x + seg / 2, H / 2 + 4);
    });
    // LED pixel grid
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 1);
    for (let x = 0; x < W; x += 4) ctx.fillRect(x, 0, 1, H);
  });
}
function makeBoards() {
  const g = new THREE.Group();
  const main = ledCanvas([
    ['#071a3d', '#0a3a8a', '#ffffff', 'RACKET RUSH'],
    ['#0b0b12', '#16161f', '#c6ff00', 'WORLD TOUR FINALS'],
    ['#7a0a2c', '#e8304f', '#ffffff', '#RACKETRUSH'],
    ['#00121a', '#003a4d', '#00e5ff', 'SWING YOUR PHONE'],
    ['#151006', '#3a2a06', '#ffd23f', '1V1 • LIVE'],
    ['#071a3d', '#0a3a8a', '#ffffff', 'SMASH • DROP • CLEAR'],
  ]);
  const party = ledCanvas(Array.from({ length: 6 }, (_, i) => (i % 2
    ? ['#ffb000', '#ff5a00', '#1a0d00', 'POINT!']
    : ['#1f0040', '#5a00b8', '#ffffff', 'WHAT A RALLY!'])));
  const mainTex = tex(main, { repeat: [1, 1] }), partyTex = tex(party, { repeat: [1, 1] });
  const ledMat = new THREE.MeshBasicMaterial({ map: mainTex, color: new THREE.Color(1.5, 1.5, 1.5) });
  const housing = phys(0x0c0d12, { roughness: 0.4, clearcoat: 0.5 });
  const H = 0.82;
  const boards = [];
  const add = (len, x, z, rotY) => {
    const b = new THREE.Group();
    const box = new THREE.Mesh(new RoundedBoxGeometry(len, H + 0.08, 0.2, 2, 0.02), housing);
    box.position.y = (H + 0.08) / 2; b.add(box);
    const face = new THREE.Mesh(new THREE.PlaneGeometry(len - 0.04, H), ledMat);
    face.position.set(0, (H + 0.08) / 2, 0.101); b.add(face);
    // each board gets its own UV span so the text scrolls continuously around the hall
    const uv = face.geometry.attributes.uv, span = H * 3072 / 128; // metres per texture repeat (keeps the text's aspect)
    const u0 = boards.reduce((s, l) => s + l, 0) / span, u1 = u0 + len / span;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) < 0.5 ? u0 : u1);
    boards.push(len);
    b.position.set(x, 0, z); b.rotation.y = rotY; g.add(b);
  };
  add(13.6, 0, -10.6, 0);
  add(19.6, -7.2, -0.6, Math.PI / 2);
  add(19.6, 7.2, -0.6, -Math.PI / 2);
  add(13.6, 0, 11.6, Math.PI);
  mainTex.wrapS = partyTex.wrapS = THREE.RepeatWrapping;
  let party_t = 0;
  return {
    group: g,
    celebrate() { party_t = 2.6; },
    update(dt) {
      party_t = Math.max(0, party_t - dt);
      const want = party_t > 0 ? partyTex : mainTex;
      if (ledMat.map !== want) { ledMat.map = want; ledMat.needsUpdate = true; }
      want.offset.x = (want.offset.x + dt * (party_t > 0 ? 0.22 : 0.035)) % 1;
      const k = party_t > 0 ? 1.4 + Math.sin(party_t * 18) * 0.5 : 1.15;
      ledMat.color.setScalar(k);
    },
  };
}

function makeJumbotron() {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 400;
  const t = tex(c);
  let key = '';
  const draw = (s) => {
    const ctx = c.getContext('2d'), w = c.width, h = c.height;
    const bg = ctx.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#081226'); bg.addColorStop(1, '#02050c');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '900 italic 54px "Arial Black", Arial, sans-serif';
    ctx.fillStyle = '#ffd23f'; ctx.fillText('RACKET RUSH', w / 2, 52);
    ctx.font = '700 22px Arial, sans-serif'; ctx.fillStyle = '#8fb4ff'; ctx.fillText('WORLD TOUR FINALS', w / 2, 92);
    if (s) {
      const row = (y, name, score, col, serving) => {
        ctx.fillStyle = col; ctx.fillRect(60, y - 44, 16, 88);
        ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(76, y - 44, w - 136, 88);
        ctx.textAlign = 'left'; ctx.font = '800 50px Arial, sans-serif'; ctx.fillStyle = '#ffffff';
        ctx.fillText(name.toUpperCase().slice(0, 16), 104, y + 2);
        if (serving) { ctx.fillStyle = '#c6ff00'; ctx.beginPath(); ctx.arc(w - 230, y, 12, 0, Math.PI * 2); ctx.fill(); }
        ctx.textAlign = 'right'; ctx.font = '900 76px Arial, sans-serif'; ctx.fillStyle = '#ffffff'; ctx.fillText(String(score), w - 90, y + 4);
      };
      row(178, s.left, s.a, '#1f8bff', s.serving === 0);
      row(290, s.right, s.b, '#e8304f', s.serving === 1);
      ctx.textAlign = 'center'; ctx.font = '700 20px Arial, sans-serif'; ctx.fillStyle = '#ff4a4a'; ctx.fillText('● LIVE', w / 2, 368);
    } else {
      ctx.font = '900 italic 92px "Arial Black", Arial, sans-serif';
      const gr = ctx.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#00e5ff'); gr.addColorStop(1, '#ff2d6f');
      ctx.fillStyle = gr; ctx.fillText('LET’S PLAY', w / 2, 240);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
    t.needsUpdate = true;
  };
  draw(null);
  const g = new THREE.Group();
  const frameMat = phys(0x0b0c10, { roughness: 0.4, metalness: 0.4 });
  const screenMat = new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(1.15, 1.15, 1.15) });
  for (const sx of [-1, 1]) {
    const unit = new THREE.Group();
    unit.add(new THREE.Mesh(new RoundedBoxGeometry(6.3, 2.65, 0.3, 2, 0.05), frameMat));
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(6, 2.344), screenMat);
    screen.position.z = 0.16; unit.add(screen);
    unit.position.set(sx * 11.2, 6.6, -19.2); unit.rotation.y = -sx * 0.5;
    g.add(unit);
  }
  return {
    group: g,
    set(s) {
      const k = s ? `${s.left}|${s.right}|${s.a}|${s.b}|${s.serving}` : '';
      if (k !== key) { key = k; draw(s); }
    },
  };
}

// ---------- arena shell: stands, seats, crowd, walls, ceiling, light shafts ----------
function makeArena() {
  const g = new THREE.Group();
  const ROW_D = 0.85, ROW_H = 0.42;
  // Stand blocks: [axis, sign, start (distance from centre), along-from, along-to, rows]
  const blocks = [
    ['z', -1, 11.4, -9.5, 9.5, 8],
    ['x', -1, 8.0, -10.5, 10.5, 9],
    ['x', 1, 8.0, -10.5, 10.5, 9],
    ['z', 1, 12.6, -9.5, 9.5, 8],
  ];
  const stepGeos = [], seats = [];
  for (const [axis, sign, start, a0, a1, rows] of blocks) {
    for (let r = 0; r < rows; r++) {
      const d = start + r * ROW_D, h = 0.9 + r * ROW_H, len = a1 - a0;
      const geo = new THREE.BoxGeometry(axis === 'z' ? len : ROW_D, h, axis === 'z' ? ROW_D : len);
      const mid = (a0 + a1) / 2;
      geo.translate(axis === 'z' ? mid : sign * (d + ROW_D / 2), h / 2, axis === 'z' ? sign * (d + ROW_D / 2) : mid);
      stepGeos.push(geo);
      let k = 0;
      for (let a = a0 + 0.35; a <= a1 - 0.3; a += 0.56, k++) {
        if (k % 13 === 6) continue; // aisle
        const pos = axis === 'z' ? new THREE.Vector3(a, h, sign * (d + 0.42)) : new THREE.Vector3(sign * (d + 0.42), h, a);
        const yaw = axis === 'z' ? (sign < 0 ? 0 : Math.PI) : (sign < 0 ? Math.PI / 2 : -Math.PI / 2); // fans face the court (local +Z)
        seats.push({ pos, yaw, row: r, block: axis + sign });
      }
    }
  }
  const concrete = tex(noiseCanvas(256, [[3000, 0.6, 1.8, 0.18], [200, 4, 10, 0.06]]), { repeat: [6, 6] });
  const stands = new THREE.Mesh(mergeGeometries(stepGeos), std(0x2a2d36, { map: concrete, roughness: 0.85 }));
  stands.receiveShadow = true; g.add(stands);

  // Seats (instanced): a moulded pan + back, team-coloured blocks
  const seatGeo = mergeGeometries([
    new RoundedBoxGeometry(0.46, 0.06, 0.42, 2, 0.02).translate(0, 0.42, -0.02),
    new RoundedBoxGeometry(0.46, 0.4, 0.05, 2, 0.02).translate(0, 0.64, -0.22),
  ]);
  const seatMesh = new THREE.InstancedMesh(seatGeo, phys(0xffffff, { roughness: 0.45, clearcoat: 0.4 }), seats.length);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), col = new THREE.Color(), Y = new THREE.Vector3(0, 1, 0);
  seats.forEach((s, i) => {
    q.setFromAxisAngle(Y, s.yaw); mtx.compose(s.pos, q, one); seatMesh.setMatrixAt(i, mtx);
    seatMesh.setColorAt(i, col.setHex(s.row % 4 === 3 ? 0x7a1428 : 0x10275a));
  });
  g.add(seatMesh);

  // Crowd (instanced): torso, head, hair and two arms per fan; arms go up when the hall gets loud
  const fans = [];
  seats.forEach(s => { if (rnd() < 0.82) fans.push({ ...s, phase: rnd() * Math.PI * 2, speed: 1.6 + rnd() * 1.8, hype: rnd(), lean: (rnd() - 0.5) * 0.2, armL: 0, armR: 0 }); });
  const n = fans.length;
  const torsoGeo = new THREE.CapsuleGeometry(0.17, 0.3, 4, 10).scale(1.05, 1, 0.7);
  const headGeo = new THREE.SphereGeometry(0.105, 14, 10).scale(0.9, 1.08, 0.96);
  const hairGeo = new THREE.SphereGeometry(0.112, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.55).scale(0.92, 1.05, 1).rotateX(-0.35).translate(0, 0.012, -0.014);
  const armGeo = new THREE.CapsuleGeometry(0.045, 0.42, 3, 8).translate(0, 0.25, 0);
  const fabric = phys(0xffffff, { roughness: 0.85, sheen: 0.5, sheenRoughness: 0.7, sheenColor: 0x888888 });
  const skinM = std(0xffffff, { roughness: 0.6 });
  const torsos = new THREE.InstancedMesh(torsoGeo, fabric, n);
  const heads = new THREE.InstancedMesh(headGeo, skinM, n);
  const hairs = new THREE.InstancedMesh(hairGeo, std(0xffffff, { roughness: 0.75 }), n);
  const arms = new THREE.InstancedMesh(armGeo, fabric, n * 2);
  const shirts = [0x1f5fd6, 0x1f5fd6, 0xc92a45, 0xc92a45, 0xe8e8e8, 0x1b1b22, 0x22252e, 0x3a3f4a, 0x2a3550, 0x6b7280, 0xd9b44a, 0x2e8b62, 0x5b3fa8, 0x8a4b2a];
  const skins = [0xf3d0b4, 0xe5b590, 0xc98e66, 0x9c6644, 0x6e4129, 0xf8dcc8];
  const hairC = [0x1a120c, 0x2b1d14, 0x4a3020, 0x0d0d0d, 0x8a6a3e, 0x6b3b1e, 0xb8b0a0];
  fans.forEach((f, i) => {
    const shirt = col.setHex(shirts[Math.floor(rnd() * shirts.length)]).multiplyScalar(0.5 + rnd() * 0.3);
    torsos.setColorAt(i, shirt); arms.setColorAt(i * 2, shirt); arms.setColorAt(i * 2 + 1, shirt);
    heads.setColorAt(i, col.setHex(skins[Math.floor(rnd() * skins.length)]).multiplyScalar(0.75));
    hairs.setColorAt(i, col.setHex(hairC[Math.floor(rnd() * hairC.length)]));
    f.rot = new THREE.Matrix4().makeRotationY(f.yaw);
  });
  g.add(torsos, heads, hairs, arms);

  const tmp = new THREE.Matrix4(), rx = new THREE.Matrix4(), rz = new THREE.Matrix4(), off = new THREE.Vector3();
  const place = (inst, i, f, x, y, z) => {
    tmp.copy(f.rot); off.set(x, y, z).applyMatrix4(f.rot);
    tmp.setPosition(f.pos.x + off.x, f.pos.y + off.y, f.pos.z + off.z);
    inst.setMatrixAt(i, tmp);
  };
  let frame = 0;
  const update = (t, excite, force) => {
    if (!force && excite < 0.03 && (frame++ % 3)) return; // idle crowd only needs ~20 Hz
    for (let i = 0; i < n; i++) {
      const f = fans[i];
      const up = excite > 0.15 + f.hype * 0.6 ? 1 : 0;
      f.armL += (up - f.armL) * 0.15; f.armR += ((up && f.hype < 0.8 ? 1 : 0) - f.armR) * 0.15;
      const bounce = Math.abs(Math.sin(t * (f.speed + excite * 5) + f.phase)) * (0.012 + excite * 0.16);
      const y = 0.72 + bounce;
      place(torsos, i, f, 0, y, 0.04);
      place(heads, i, f, Math.sin(t * 0.3 + f.phase) * 0.02, y + 0.38, 0.0);
      place(hairs, i, f, Math.sin(t * 0.3 + f.phase) * 0.02, y + 0.38, 0.0);
      for (const side of [-1, 1]) {
        const raise = side < 0 ? f.armL : f.armR;
        const wave = raise * Math.sin(t * 6 + f.phase + side) * 0.25;
        rx.makeRotationX(lerp(Math.PI * 0.92, 0.1, raise) - 0.25 * (1 - raise));
        rz.makeRotationZ(side * (0.18 + wave));
        tmp.multiplyMatrices(f.rot, rz).multiply(rx);
        off.set(side * 0.2, y + 0.18, 0.04).applyMatrix4(f.rot);
        tmp.setPosition(f.pos.x + off.x, f.pos.y + off.y, f.pos.z + off.z);
        arms.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), tmp);
      }
    }
    torsos.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = hairs.instanceMatrix.needsUpdate = arms.instanceMatrix.needsUpdate = true;
  };
  update(0, 0, true);

  // Camera flashes from the stands
  const flashTex = tex(canvas(64, 64, (ctx, w) => {
    const gr = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(220,235,255,0.8)'); gr.addColorStop(1, 'rgba(200,220,255,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, w, w);
  }));
  const flashes = Array.from({ length: 24 }, () => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: new THREE.Color(3, 3, 3), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.visible = false; g.add(s); return { s, life: 0 };
  });

  // Walls, ceiling, truss and light banks
  const wallMat = std(0x10131c, { roughness: 0.9, map: tex(canvas(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#7a7f8c'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#5c616e'; for (let x = 0; x < w; x += 32) ctx.fillRect(x, 0, 2, h);
  }), { repeat: [24, 4] }) });
  const shell = new THREE.Mesh(new THREE.BoxGeometry(36, 17, 44), [wallMat, wallMat, std(0x07080c), std(0x07080c), wallMat, wallMat].map(m => { const c = m.clone(); c.side = THREE.BackSide; return c; }));
  shell.position.set(0, 8.4, 0.4); g.add(shell);
  const trussMat = phys(0x3a3f4a, { metalness: 0.8, roughness: 0.35 });
  const truss = [];
  for (const x of [-6, -2, 2, 6]) truss.push(new THREE.BoxGeometry(0.25, 0.4, 30).translate(x, 15.2, 0));
  for (const z of [-12, -6, 0, 6, 12]) truss.push(new THREE.BoxGeometry(14, 0.25, 0.25).translate(0, 15.3, z));
  g.add(new THREE.Mesh(mergeGeometries(truss), trussMat));
  const bankGeo = new THREE.BoxGeometry(1.6, 0.25, 0.8);
  const bankMat = [std(0x1a1c22), std(0x1a1c22), std(0x1a1c22), hdr(0xfff2e0, 7), std(0x1a1c22), std(0x1a1c22)];
  const LIGHTS = [];
  for (const x of [-5.5, 5.5]) for (const z of [-8, -2.7, 2.7, 8]) {
    const b = new THREE.Mesh(bankGeo, bankMat); b.position.set(x, 14.8, z); g.add(b);
    LIGHTS.push(b.position.clone());
  }

  // Light shafts through the hall's haze
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(1.0, 0.95, 0.86) }, strength: { value: 0.05 } },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying float vH;
      void main(){ vH = uv.y; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 color; uniform float strength; varying vec3 vN; varying vec3 vV; varying float vH;
      void main(){ float edge = pow(abs(dot(normalize(vN), normalize(vV))), 2.0);
        float fade = smoothstep(0.0, 0.6, vH) * (0.35 + 0.65 * vH);
        gl_FragColor = vec4(color * strength * edge * fade, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const down = new THREE.Vector3(0, -1, 0);
  for (const p of LIGHTS) {
    const target = new THREE.Vector3(p.x * 0.3, 0, p.z * 0.75);
    const dir = target.clone().sub(p), len = dir.length();
    const geo = new THREE.CylinderGeometry(0.5, 3.0, len, 32, 1, true).translate(0, -len / 2, 0);
    const beam = new THREE.Mesh(geo, beamMat);
    beam.position.copy(p); beam.quaternion.setFromUnitVectors(down, dir.normalize()); beam.renderOrder = 3;
    g.add(beam);
  }

  // Dust drifting in the light
  const dustN = 700, dp = new Float32Array(dustN * 3);
  for (let i = 0; i < dustN; i++) { dp[i * 3] = (rnd() - 0.5) * 14; dp[i * 3 + 1] = 0.3 + rnd() * 13; dp[i * 3 + 2] = (rnd() - 0.5) * 22; }
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(dp, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ map: softDisc('rgba(255,250,235,1)', 32), size: 0.035, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xfff1d8 }));
  g.add(dust);

  return {
    group: g, lights: LIGHTS,
    crowd: { group: torsos, update },
    update(t, dt, excite) {
      update(t, excite);
      for (let i = 0; i < dustN; i++) {
        dp[i * 3 + 1] += dt * (0.05 + (i % 7) * 0.01); dp[i * 3] += Math.sin(t * 0.2 + i) * dt * 0.03;
        if (dp[i * 3 + 1] > 13.5) dp[i * 3 + 1] = 0.3;
      }
      dustGeo.attributes.position.needsUpdate = true;
      if (rnd() < dt * (1.5 + excite * 30)) {
        const f = flashes.find(x => x.life <= 0), fan = fans[Math.floor(rnd() * n)];
        if (f && fan) { f.life = 0.12; f.s.position.set(fan.pos.x, fan.pos.y + 1.2, fan.pos.z); f.s.visible = true; }
      }
      for (const f of flashes) {
        if (f.life <= 0) continue;
        f.life -= dt; const k = Math.max(0, f.life / 0.12);
        f.s.scale.setScalar(0.25 + k * 0.5); f.s.material.opacity = k;
        if (f.life <= 0) f.s.visible = false;
      }
    },
  };
}

// ---------- athletes ----------
function jerseyTexture(team) {
  const c = canvas(1024, 512, (ctx, w, h) => {
    const base = `#${new THREE.Color(team.shirt).getHexString()}`;
    const dark = `#${new THREE.Color(team.shirt).multiplyScalar(0.55).getHexString()}`;
    const acc = `#${new THREE.Color(team.accent).getHexString()}`;
    ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
    // diagonal sublimated pattern
    ctx.globalAlpha = 0.08; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 10;
    for (let x = -h; x < w; x += 46) { ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x + h, 0); ctx.stroke(); }
    ctx.globalAlpha = 1;
    // side panels (u = 0.25 and 0.75 are the flanks)
    for (const u of [0.25, 0.75]) {
      const gr = ctx.createLinearGradient(u * w - 70, 0, u * w + 70, 0);
      gr.addColorStop(0, base); gr.addColorStop(0.3, dark); gr.addColorStop(0.5, acc); gr.addColorStop(0.7, dark); gr.addColorStop(1, base);
      ctx.fillStyle = gr; ctx.fillRect(u * w - 70, 0, 140, h);
    }
    // collar + hem
    ctx.fillStyle = `#${new THREE.Color(team.trim).getHexString()}`; ctx.fillRect(0, 0, w, 16);
    ctx.fillStyle = dark; ctx.fillRect(0, h - 22, w, 22);
    // back: name + number (u = 0.5 is the back)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff';
    ctx.font = '800 44px Arial, sans-serif'; ctx.fillText('RUSH', w * 0.5, 92);
    ctx.font = '900 190px Arial, sans-serif';
    ctx.lineWidth = 10; ctx.strokeStyle = dark; ctx.strokeText(team.number, w * 0.5, 250); ctx.fillText(team.number, w * 0.5, 250);
    // front: small chest crest and number
    ctx.font = '900 64px Arial, sans-serif'; ctx.fillText(team.number, w * 0.07, 170);
    ctx.beginPath(); ctx.arc(w * 0.93, 160, 26, 0, Math.PI * 2); ctx.fillStyle = acc; ctx.fill();
  });
  return tex(c);
}

function makeRacket(frameColor) {
  const r = new THREE.Group();
  const grip = tex(canvas(64, 256, (ctx, w, h) => {
    ctx.fillStyle = '#f1f1f1'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 6;
    for (let y = -w; y < h; y += 22) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y + w); ctx.stroke(); }
  }));
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.0145, 0.0135, 0.2, 12), std(0xffffff, { map: grip, roughness: 0.9 }));
  handle.position.y = 0.1; r.add(handle);
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.015, 0.012, 12), std(0x111111, { roughness: 0.4 }));
  butt.position.y = 0.002; r.add(butt);
  const carbon = phys(0x15161a, { roughness: 0.25, metalness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0042, 0.0045, 0.24, 8), carbon);
  shaft.position.y = 0.32; r.add(shaft);
  // Isometric head: a squared-oval tube in the team colour
  const W = 0.105, H = 0.125, cy = 0.44 + H;
  const pts = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const e = 2.6; // superellipse exponent → squarer shoulders
    pts.push(new THREE.Vector3(Math.sign(c) * Math.pow(Math.abs(c), 2 / e) * W, Math.sign(s) * Math.pow(Math.abs(s), 2 / e) * H * (s < 0 ? 1.06 : 1), 0));
  }
  const frameMat = phys(frameColor, { roughness: 0.22, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.06, emissive: frameColor, emissiveIntensity: 0.12 });
  const head = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 96, 0.0065, 8, true), frameMat);
  head.scale.z = 0.7; head.position.y = cy; r.add(head);
  const throat = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.009, 0.05, 8), frameMat);
  throat.position.y = 0.44 + 0.012; r.add(throat);
  const strings = tex(canvas(256, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.save(); ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w / 2 - 2, h / 2 - 2, 0, 0, Math.PI * 2); ctx.clip();
    ctx.strokeStyle = 'rgba(245,245,240,0.85)'; ctx.lineWidth = 1.6;
    for (let i = 4; i < w; i += 11) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, h); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(w, i); ctx.stroke(); }
    ctx.restore();
  }));
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(W * 2, H * 2.05), new THREE.MeshStandardMaterial({ map: strings, transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.4 }));
  bed.position.y = cy; r.add(bed);
  const tip = new THREE.Object3D(); tip.position.y = cy + H * 0.4; r.add(tip);
  const neck = new THREE.Object3D(); neck.position.y = 0.44; r.add(neck);
  const face = new THREE.Object3D(); face.position.y = cy; r.add(face);   // string-bed centre: where the shuttle is struck
  r.userData = { tip, neck, face };
  r.scale.setScalar(1.12);
  return r;
}

function makeShoe(color) {
  const s = new THREE.Group();
  const sole = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.028, 0.27, 2, 0.012), phys(0xf4f4f0, { roughness: 0.6 }));
  sole.position.set(0, 0.014, 0); s.add(sole);
  const gum = new THREE.Mesh(new RoundedBoxGeometry(0.098, 0.01, 0.262, 1, 0.004), std(0x8a5a2b, { roughness: 0.8 }));
  gum.position.y = 0.004; s.add(gum);
  const upper = new THREE.Mesh(new RoundedBoxGeometry(0.092, 0.07, 0.235, 3, 0.032), phys(0xffffff, { roughness: 0.5, sheen: 0.4 }));
  upper.position.set(0, 0.058, 0.01); s.add(upper);
  const swoop = new THREE.Mesh(new RoundedBoxGeometry(0.095, 0.022, 0.16, 2, 0.01), phys(color, { roughness: 0.35, clearcoat: 0.5 }));
  swoop.position.set(0, 0.05, 0.02); swoop.rotation.x = -0.12; s.add(swoop);
  const heel = new THREE.Mesh(new RoundedBoxGeometry(0.09, 0.06, 0.06, 2, 0.02), phys(color, { roughness: 0.4 }));
  heel.position.set(0, 0.07, 0.1); s.add(heel);
  return s;
}

function makeAthlete({ team, skin, hair, umpire = false }) {
  const c = new THREE.Group();
  const body = new THREE.Group(); c.add(body);           // main.js bobs this
  const pelvis = new THREE.Group(); body.add(pelvis);   // lowered here so the feet stay planted when knees bend
  const skinM = phys(skin, { roughness: 0.48, sheen: 0.35, sheenRoughness: 0.6, sheenColor: 0xffc9b0, clearcoat: 0.06 });
  const shirtM = umpire ? phys(0x1a2340, { roughness: 0.7, sheen: 0.5, sheenColor: 0x5566aa })
    : phys(0xffffff, { map: jerseyTexture(team), roughness: 0.72, sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color(team.shirt).lerp(new THREE.Color(0xffffff), 0.5) });
  const shortsM = phys(umpire ? 0x3a3f4c : team.shorts, { roughness: 0.65, sheen: 0.8, sheenRoughness: 0.4, sheenColor: 0x6677aa });
  const hairM = phys(hair, { roughness: 0.55, sheen: 1, sheenRoughness: 0.35, sheenColor: new THREE.Color(hair).lerp(new THREE.Color(0xffffff), 0.35) });
  const sockM = phys(0xf8f8f8, { roughness: 0.9, sheen: 0.5 });
  const HIP = 0.86, THIGH = 0.43, SHIN = 0.41;

  // Shorts
  const shortsPts = [[0.0, 0.0], [0.142, 0.0], [0.152, 0.07], [0.148, 0.16], [0.13, 0.22], [0.0, 0.22]].map(([x, y]) => new THREE.Vector2(Math.max(1e-4, x), y));
  const shorts = new THREE.Mesh(new THREE.LatheGeometry(shortsPts, 24), shortsM);
  shorts.scale.set(1.2, 1, 0.82); shorts.position.y = HIP - 0.07; pelvis.add(shorts);

  // Legs: legs[i] is rotated by main.js (stride); the inner hip/knee joints are driven here
  const legs = [], hips = [], knees = [];
  for (const sx of [-1, 1]) {
    const leg = new THREE.Group(); leg.position.set(sx * 0.1, HIP, 0); pelvis.add(leg); legs.push(leg);
    const hip = new THREE.Group(); leg.add(hip); hips.push(hip);
    const thigh = new THREE.Mesh(limbGeo(0.094, 0.064, THIGH), skinM); hip.add(thigh);
    const shortLeg = new THREE.Mesh(limbGeo(0.112, 0.1, 0.28), shortsM); shortLeg.position.y = 0.02; hip.add(shortLeg);
    const knee = new THREE.Group(); knee.position.y = -THIGH + 0.03; hip.add(knee); knees.push(knee);
    const shin = new THREE.Mesh(limbGeo(0.064, 0.04, SHIN), skinM); knee.add(shin);
    const calf = new THREE.Mesh(new THREE.SphereGeometry(0.058, 14, 10).scale(0.95, 1.7, 1.0), skinM); calf.position.set(0, -0.13, 0.016); knee.add(calf);
    const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.044, 0.11, 14), sockM); sock.position.y = -SHIN + 0.08; knee.add(sock);
    const shoe = makeShoe(umpire ? 0x222222 : team.accent); shoe.position.set(0, -SHIN - 0.005, -0.04); knee.add(shoe);
  }

  // Torso: a tapered, flattened lathe with the jersey wrapped around (u = 0.5 at the back)
  const torso = new THREE.Group(); torso.position.y = HIP + 0.1; pelvis.add(torso);
  const torsoPts = [[0.128, -0.06], [0.13, 0.0], [0.134, 0.1], [0.152, 0.22], [0.162, 0.31], [0.156, 0.38], [0.128, 0.43], [0.075, 0.465], [0.05, 0.475], [0.0, 0.476]]
    .map(([x, y]) => new THREE.Vector2(Math.max(1e-4, x), y));
  const chestGeo = new THREE.LatheGeometry(torsoPts, 32, Math.PI);
  { // v by height (not by profile point) so the print on the jersey isn't stretched
    const p = chestGeo.attributes.position, uv = chestGeo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, (p.getY(i) + 0.06) / 0.536);
  }
  const chest = new THREE.Mesh(chestGeo, shirtM);
  chest.scale.set(1.24, 1, 0.78); torso.add(chest);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.052, 0.11, 14), skinM); neck.position.y = 0.5; torso.add(neck);

  // Head (tracks the shuttle)
  const head = new THREE.Group(); head.position.y = 0.6; torso.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.105, 28, 20).scale(0.9, 1.1, 1.0), skinM); skull.position.y = 0.04; head.add(skull);
  const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.08, 20, 14).scale(0.95, 0.9, 1.0), skinM); jaw.position.set(0, -0.015, -0.022); head.add(jaw);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.04, 8).rotateX(-Math.PI / 2 - 0.3), skinM); nose.position.set(0, 0.03, -0.105); head.add(nose);
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 8).scale(0.5, 1.1, 0.8), skinM); ear.position.set(sx * 0.095, 0.04, 0.005); head.add(ear);
    const eyeW = new THREE.Mesh(new THREE.SphereGeometry(0.015, 10, 8).scale(1.3, 0.8, 0.6), std(0xf4f1ea, { roughness: 0.2 })); eyeW.position.set(sx * 0.036, 0.055, -0.092); head.add(eyeW);
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.0085, 10, 8), std(0x2a1a10, { roughness: 0.1 })); iris.position.set(sx * 0.036, 0.055, -0.1); head.add(iris);
    const brow = new THREE.Mesh(new RoundedBoxGeometry(0.036, 0.008, 0.01, 1, 0.003), hairM); brow.position.set(sx * 0.037, 0.078, -0.097); brow.rotation.z = -sx * 0.12; head.add(brow);
  }
  const mouth = new THREE.Mesh(new RoundedBoxGeometry(0.032, 0.006, 0.008, 1, 0.003), std(0x8a3b35, { roughness: 0.5 })); mouth.position.set(0, -0.012, -0.098); head.add(mouth);
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.112, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.52).scale(0.93, 1.1, 1.04), hairM);
  hairCap.position.set(0, 0.05, 0.006); hairCap.rotation.x = 0.2; head.add(hairCap);
  const hairBack = new THREE.Mesh(new THREE.SphereGeometry(0.104, 20, 12).scale(0.95, 0.9, 0.9), hairM); hairBack.position.set(0, 0.035, 0.03); head.add(hairBack);
  if (!umpire) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.012, 8, 32).scale(0.93, 1, 1.05), phys(team.accent, { roughness: 0.6, sheen: 1 }));
    band.rotation.x = Math.PI / 2 + 0.2; band.position.set(0, 0.085, 0.004); head.add(band);
  }

  // Racket arm: pivot at the shoulder, extends along +Y (main.js swings this group)
  const shoulder = new THREE.Group(); shoulder.position.set(0.195, 0.4, 0); torso.add(shoulder);
  const delt = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 12), shirtM); shoulder.add(delt);
  const upper = new THREE.Mesh(upLimb(0.058, 0.045, 0.29), skinM); shoulder.add(upper);
  const sleeve = new THREE.Mesh(upLimb(0.072, 0.064, 0.14), shirtM); shoulder.add(sleeve);
  const elbow = new THREE.Group(); elbow.position.y = 0.27; elbow.rotation.x = -0.18; shoulder.add(elbow);
  const fore = new THREE.Mesh(upLimb(0.047, 0.034, 0.25), skinM); elbow.add(fore);
  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.05, 12), phys(team.accent, { roughness: 0.8, sheen: 1 })); wrist.position.y = 0.2; elbow.add(wrist);
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10).scale(0.85, 1.15, 0.6), skinM); hand.position.y = 0.27; elbow.add(hand);
  const racket = makeRacket(umpire ? 0x333333 : team.racket);
  racket.position.y = 0.23; elbow.add(racket);

  // Balance arm: hangs down (−Y); swings with the stride and points at the shuttle on overheads
  const offArm = new THREE.Group(); offArm.position.set(-0.195, 0.4, 0); torso.add(offArm);
  offArm.add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 12), shirtM));
  offArm.add(new THREE.Mesh(limbGeo(0.058, 0.045, 0.29), skinM));
  offArm.add(new THREE.Mesh(limbGeo(0.072, 0.064, 0.14), shirtM));
  const offElbow = new THREE.Group(); offElbow.position.y = -0.27; offElbow.rotation.x = 0.35; offArm.add(offElbow);
  offElbow.add(new THREE.Mesh(limbGeo(0.047, 0.034, 0.25), skinM));
  const offHand = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 10).scale(0.85, 1.15, 0.6), skinM); offHand.position.y = -0.27; offElbow.add(offHand);

  // Soft contact shadow (the shadow map does the rest)
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshBasicMaterial({ map: softDisc('rgba(0,0,0,0.6)'), transparent: true, depthWrite: false }));
  contact.rotation.x = -Math.PI / 2; contact.position.y = 0.012; c.add(contact);

  shadowy(c, true, false);
  contact.castShadow = false;
  c.scale.setScalar(1.1);
  const rig = { pelvis, torso, hips, knees, offArm, offElbow, head, THIGH, SHIN, look: new THREE.Vector2(), raise: 0, crouch: 0.3 };
  return { group: c, body, shoulder, legs, racket, head, rig };
}

// Secondary animation layered on top of main.js's stride + swing: knee bend and planted feet,
// athletic lean, torso twist into the swing, balance arm, and the head following the shuttle.
const _v = new THREE.Vector3();
function animateRig(a, dt, shuttle, live) {
  const r = a.rig, k = Math.min(1, dt * 10);
  if (r.seated) { lookAt(r, dt, shuttle, live); return; }
  const sh = a.shoulder.rotation;
  const swingAmt = clamp((sh.x - 0.55) / 0.9, 0, 1);              // arm drawn back for an overhead
  r.raise += (swingAmt - r.raise) * Math.min(1, dt * 8);
  const moving = Math.abs(a.legs[0].rotation.x) + Math.abs(a.legs[1].rotation.x);
  const crouch = live ? 0.32 + clamp(moving, 0, 0.6) * 0.25 : 0.1;
  r.crouch += (crouch - r.crouch) * k;
  let reach = 0;
  for (let i = 0; i < 2; i++) {
    const stride = a.legs[i].rotation.x;
    const kneeBend = r.crouch + Math.max(0, -stride) * 1.1 + Math.max(0, stride) * 0.25;
    r.hips[i].rotation.x = r.crouch * 0.55;
    r.knees[i].rotation.x = -kneeBend;
    const th = stride + r.crouch * 0.55;
    reach = Math.max(reach, r.THIGH * Math.cos(th) + r.SHIN * Math.cos(th - kneeBend));
  }
  r.pelvis.position.y = reach - (r.THIGH + r.SHIN);
  r.torso.rotation.x = -0.1 - r.crouch * 0.25 + r.raise * 0.18;
  r.torso.rotation.y = clamp(sh.y * 0.25 - r.raise * 0.35 + (sh.z + 0.35) * 0.2, -0.6, 0.6);
  const walk = a.legs[1].rotation.x * 0.8;
  r.offArm.rotation.x = lerp(walk + 0.08, 2.5, r.raise);
  r.offArm.rotation.z = lerp(-0.18, -0.35, r.raise);
  r.offElbow.rotation.x = lerp(0.35, 0.15, r.raise);
  lookAt(r, dt, shuttle, live);
}
function lookAt(r, dt, shuttle, live) {
  let yaw = 0, pitch = 0;
  if (live && shuttle.visible) {
    r.head.parent.worldToLocal(_v.copy(shuttle.position));
    _v.sub(r.head.position);
    yaw = clamp(Math.atan2(-_v.x, -_v.z), -1.0, 1.0);
    pitch = clamp(Math.atan2(_v.y, Math.hypot(_v.x, _v.z)), -0.5, 0.8);
  }
  r.look.x += (yaw - r.look.x) * Math.min(1, dt * 6);
  r.look.y += (pitch - r.look.y) * Math.min(1, dt * 6);
  r.head.rotation.set(r.look.y, r.look.x, 0, 'YXZ');
}

// Racket swoosh: a fading ribbon swept by the racket head on fast swings.
function makeSwingTrail(color) {
  const N = 16;
  const pos = new Float32Array(N * 2 * 3), alpha = new Float32Array(N * 2);
  const idx = [];
  for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.5).multiplyScalar(1.4) } },
    vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 color; varying float vA; void main(){ gl_FragColor = vec4(color * vA, vA); }',
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false;
  const hist = [];
  const tipW = new THREE.Vector3(), neckW = new THREE.Vector3(), last = new THREE.Vector3();
  let has = false;
  return {
    mesh,
    update(racket, dt, visible) {
      racket.userData.tip.getWorldPosition(tipW); racket.userData.neck.getWorldPosition(neckW);
      const speed = has ? tipW.distanceTo(last) / Math.max(dt, 1e-3) : 0;
      last.copy(tipW); has = true;
      const on = visible && speed > 7;
      for (const h of hist) h.life -= dt * 5;
      if (on) hist.unshift({ t: tipW.clone(), n: neckW.clone().lerp(tipW, 0.45), life: Math.min(1, (speed - 7) / 8) });
      while (hist.length > N || (hist.length && hist[hist.length - 1].life <= 0)) hist.pop();
      mesh.visible = hist.length > 1;
      for (let i = 0; i < N; i++) {
        const h = hist[Math.min(i, hist.length - 1)];
        if (!h) continue;
        const a = i < hist.length ? Math.max(0, h.life) * (1 - i / N) * 0.55 : 0;
        pos.set([h.t.x, h.t.y, h.t.z], i * 6); pos.set([h.n.x, h.n.y, h.n.z], i * 6 + 3);
        alpha[i * 2] = a; alpha[i * 2 + 1] = a * 0.15;
      }
      geo.attributes.position.needsUpdate = true; geo.attributes.alpha.needsUpdate = true;
    },
  };
}

// ---------- umpire's chair ----------
function makeUmpire() {
  const g = new THREE.Group();
  const metal = phys(0xd9dde3, { metalness: 0.85, roughness: 0.3 });
  const wood = phys(0x1b2a4a, { roughness: 0.5, clearcoat: 0.4 });
  const parts = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 8).translate(sx * 0.3, 0.65, sz * 0.3));
  for (const y of [0.35, 0.8]) for (const sz of [-1, 1]) parts.push(new THREE.CylinderGeometry(0.015, 0.015, 0.6, 6).rotateZ(Math.PI / 2).translate(0, y, sz * 0.3));
  g.add(new THREE.Mesh(mergeGeometries(parts), metal));
  const deck = new THREE.Mesh(new RoundedBoxGeometry(0.75, 0.06, 0.75, 2, 0.02), wood); deck.position.y = 1.32; g.add(deck);
  const seat = new THREE.Mesh(new RoundedBoxGeometry(0.46, 0.08, 0.42, 2, 0.03), phys(0x101318, { roughness: 0.6 })); seat.position.set(0.05, 1.42, 0); g.add(seat);
  const back = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.5, 0.42, 2, 0.02), phys(0x101318, { roughness: 0.6 })); back.position.set(0.27, 1.68, 0); g.add(back);
  const desk = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.32, 0.6, 2, 0.02), wood); desk.position.set(-0.36, 1.5, 0); g.add(desk);
  const tablet = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.01, 0.28), hdr(0x6fb3ff, 1.2)); tablet.position.set(-0.3, 1.67, 0); tablet.rotation.z = 0.3; g.add(tablet);
  const ump = makeAthlete({ team: TEAM.you, skin: 0xd9a27e, hair: 0x2b2b2b, umpire: true });
  ump.racket.visible = false;
  for (const l of ump.legs) l.rotation.x = 1.45;
  for (const k of ump.rig.knees) k.rotation.x = -1.45;
  ump.shoulder.rotation.set(2.3, 0, -0.2);
  ump.rig.offArm.rotation.set(0.9, 0, 0.1);
  ump.rig.seated = true;
  ump.group.scale.setScalar(1.05);
  ump.group.rotation.y = Math.PI / 2;
  ump.group.position.set(0.05, 1.42 - 0.86 * 1.05 + 0.02, 0);
  g.add(ump.group);
  shadowy(g, true, true);
  return { group: g, ump };
}

// ---------- shuttlecock ----------
function makeShuttle() {
  const s = new THREE.Group();
  const corkMat = phys(0xf6f2ea, { roughness: 0.55, sheen: 0.5, sheenColor: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.08 });
  const cork = new THREE.Mesh(new THREE.SphereGeometry(0.0128, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), corkMat);
  s.add(cork);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.0128, 0.0128, 0.012, 20), corkMat); base.position.y = -0.006; s.add(base);
  const tape = new THREE.Mesh(new THREE.CylinderGeometry(0.0131, 0.0131, 0.005, 20), phys(0xd0213a, { roughness: 0.4, clearcoat: 0.6 }));
  tape.position.y = -0.009; s.add(tape);
  // Skirt: 16 goose feathers with scalloped tips and dark shafts, drawn on an open cone
  const feathers = canvas(1024, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const n = 16, fw = w / n;
    for (let i = 0; i < n; i++) {
      const x = i * fw;
      const gr = ctx.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(255,255,255,0.97)'); gr.addColorStop(1, 'rgba(236,236,230,0.9)');
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.moveTo(x + fw * 0.08, 0);
      ctx.lineTo(x + fw * 0.92, 0);
      ctx.lineTo(x + fw * 1.02, h * 0.62);
      ctx.quadraticCurveTo(x + fw * 0.98, h * 0.98, x + fw * 0.5, h * 0.985);
      ctx.quadraticCurveTo(x + fw * 0.02, h * 0.98, x - fw * 0.02, h * 0.62);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(150,150,140,0.35)'; ctx.lineWidth = 1;
      for (let k = 0; k < 10; k++) { const yy = h * 0.2 + k * h * 0.075; ctx.beginPath(); ctx.moveTo(x + fw * 0.5, yy); ctx.lineTo(x + fw * 0.08, yy + 10); ctx.moveTo(x + fw * 0.5, yy); ctx.lineTo(x + fw * 0.92, yy + 10); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(70,70,70,0.9)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x + fw * 0.5, 0); ctx.lineTo(x + fw * 0.5, h * 0.93); ctx.stroke();
    }
    // two binding threads
    ctx.fillStyle = 'rgba(40,40,46,0.9)';
    ctx.fillRect(0, h * 0.22, w, 5); ctx.fillRect(0, h * 0.42, w, 5);
  });
  const ft = tex(feathers, { aniso: 8 });
  const skirtMat = new THREE.MeshPhysicalMaterial({ map: ft, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.75, sheen: 0.6, sheenColor: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.12, emissiveMap: ft });
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.0128, 0.033, 0.064, 48, 1, true), skirtMat);
  skirt.position.y = -0.012 - 0.032; s.add(skirt);
  s.scale.setScalar(SHUTTLE_SCALE);
  shadowy(s, true, false);
  return s;
}

// ---------- main factory ----------
export function createWorld(canvasEl) {
  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: false, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.Fog(0x070910, 26, 70);
  scene.environment = makeEnvironment(renderer);

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 400);

  scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x1c1610, 0.28));
  const key = new THREE.DirectionalLight(0xfff3e6, 1.7);
  key.position.set(3, 18, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -9, right: 9, top: 12, bottom: -12, near: 4, far: 34 });
  key.shadow.bias = -0.0003; key.shadow.normalBias = 0.02;
  scene.add(key);

  const floors = makeFloors(); scene.add(floors);
  scene.add(makeNet());
  const boards = makeBoards(); scene.add(boards.group);
  const jumbo = makeJumbotron(); scene.add(jumbo.group);
  const arena = makeArena(); scene.add(arena.group);
  // Court floodlights from the ceiling banks (no shadows: the key light handles those)
  for (const p of arena.lights.filter((_, i) => i % 2 === 0)) {
    const s = new THREE.SpotLight(0xfff1e0, 190, 0, 0.5, 0.8, 1.6);
    s.position.copy(p); s.target.position.set(p.x * 0.25, 0, p.z * 0.7);
    scene.add(s, s.target);
  }
  const umpire = makeUmpire(); umpire.group.position.set(HALF_W_DOUBLES + 1.45, 0, 0); scene.add(umpire.group);

  const player = makeAthlete({ team: TEAM.you, skin: 0xe8b996, hair: 0x2a1a10 });
  player.group.position.set(0.5, 0, 4.5);
  scene.add(player.group);
  const cpu = makeAthlete({ team: TEAM.cpu, skin: 0xa8714c, hair: 0x0f0c0a });
  cpu.group.position.set(-0.5, 0, -4.5); cpu.group.rotation.y = Math.PI;
  scene.add(cpu.group);
  const trails = [[player, makeSwingTrail(TEAM.you.racket)], [cpu, makeSwingTrail(TEAM.cpu.racket)]];
  for (const [, tr] of trails) scene.add(tr.mesh);

  const shuttle = makeShuttle(); scene.add(shuttle);

  // Post: MSAA HDR render → bloom → tone map → filmic grade (split tone, vignette, lens fringe, grain)
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.6, 0.93);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, time: { value: 0 }, res: { value: new THREE.Vector2(1, 1) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform float time; uniform vec2 res; varying vec2 vUv;
      void main(){
        vec2 d = vUv - 0.5; float r2 = dot(d, d);
        float ca = 0.006 * r2;
        vec3 col = vec3(texture2D(tDiffuse, vUv - d * ca).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv + d * ca).b);
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(l), col, 1.1);
        col = (col - 0.5) * 1.05 + 0.5;
        col *= mix(vec3(0.95, 0.99, 1.06), vec3(1.04, 1.0, 0.95), smoothstep(0.05, 0.75, l));
        col *= mix(1.0, 0.68, smoothstep(0.08, 0.5, r2));
        float n = fract(sin(dot(vUv * res + fract(time) * 97.0, vec2(12.9898, 78.233))) * 43758.5453);
        col += (n - 0.5) * 0.022;
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }`,
  });
  composer.addPass(grade);

  let pixelRatio = Math.min(window.devicePixelRatio, 1.5);
  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(w, h);
    grade.uniforms.res.value.set(w * pixelRatio, h * pixelRatio);
    camera.aspect = w / h;
    camera.fov = w / h < 0.9 ? 70 : 48;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  let lastExcite = 0;
  return {
    renderer, scene, camera, player, cpu, shuttle, crowd: arena.crowd,
    update(t, dt, excite) {
      arena.update(t, dt, excite);
      if (excite > 0.75 && lastExcite <= 0.75) boards.celebrate();
      lastExcite = excite;
      boards.update(dt);
      const live = shuttle.visible;
      animateRig(player, dt, shuttle, live);
      animateRig(cpu, dt, shuttle, live);
      animateRig(umpire.ump, dt, shuttle, live);
      for (const [ch, tr] of trails) tr.update(ch.racket, dt, ch.group.visible);
    },
    /** Jumbotron scoreboard: { left, right, a, b, serving } or null for the idle screen. */
    setScoreboard(s) { jumbo.set(s); },
    render() { grade.uniforms.time.value = performance.now() / 1000; composer.render(); },
    setPixelRatio(pr) { pixelRatio = pr; resize(); },
  };
}
