import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { makeConfetti } from './bowl-scene.js';
import { drawSpacetimeWordmark, drawOrbits, drawCalHacks, onBrandReady } from './brand.js';

// Table tennis arena: a blue tournament table under spotlights, red sports floor, sponsor barriers,
// a crowd in the stands, a cartoon NPC across the net and the player's paddle in the foreground.
// pingpong.js drives it: it moves the ball, both paddles and the NPC every frame.

export const HALF_L = 1.37, HALF_W = 0.7625, TOP = 0.76, NET_H = 0.1525, BALL_R = 0.02;
const C = { ink: 0x1c2033, yellow: 0xffc61a, red: 0xf23545, blue: 0x1f8bff, pink: 0xff4f8b, purple: 0x9b6bff, mint: 0x35c9a5, orange: 0xff8a3d };

let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
function canvas(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  return c;
}
function tex(c, { srgb = true, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}
const glow = (color, k = 2.2) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) });
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, ...o });

function makeEnvironment(renderer) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.BoxGeometry(30, 12, 30), new THREE.MeshBasicMaterial({ color: 0x0b0d22, side: THREE.BackSide })));
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6), glow(0xfff4e0, 2.2));
    m.rotation.x = Math.PI / 2; m.position.set(i < 2 ? -2.5 : 2.5, 5.5, i % 2 ? -2.5 : 2.5); s.add(m);
  }
  [C.blue, C.pink, C.yellow, C.mint].forEach((c, i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(14, 0.6), glow(c, 1.3));
    m.position.set(0, 1.4, 0); m.rotation.y = (i * Math.PI) / 2; m.translateZ(-13); s.add(m);
  });
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(s, 0.03).texture;
  pmrem.dispose();
  return env;
}

// ---------- textures ----------
function tableTexture() {
  return tex(canvas(1370, 762, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#1d58c4'); g.addColorStop(1, '#1747a6');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) { ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.035})`; ctx.fillRect(rnd() * w, rnd() * h, 2, 2); }
    ctx.fillStyle = '#ffffff';
    const e = 10;   // 2 cm edge lines
    ctx.fillRect(0, 0, w, e); ctx.fillRect(0, h - e, w, e); ctx.fillRect(0, 0, e, h); ctx.fillRect(w - e, 0, e, h);
    ctx.fillRect(0, h / 2 - 1.5, w, 3);    // centre line
  }), { aniso: 16 });
}
function netTexture() {
  return tex(canvas(512, 64, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(20,24,44,.9)'; ctx.lineWidth = 1.5;
    for (let x = 0; x <= w; x += 6) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += 6) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }));
}
function floorTexture() {
  return tex(canvas(1024, 1024, (ctx, w, h) => {
    ctx.fillStyle = '#a63a2c'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) { ctx.fillStyle = `rgba(${rnd() > 0.5 ? '255,255,255' : '0,0,0'},${rnd() * 0.05})`; ctx.fillRect(rnd() * w, rnd() * h, 2, 2); }
  }));
}
// text 'SPACETIMEDB' / 'CALHACKS' draws that sponsor's logo instead of lettering.
// The canvas has the barrier face's own aspect (1.38 × 0.62 m) so nothing is stretched, at 2× for sharpness.
const BAR_W = 1024, BAR_H = 460, BAR_RES = 2;
function barrierTexture(color, text) {
  const paint = (ctx, w, h) => {
    ctx.setTransform(BAR_RES, 0, 0, BAR_RES, 0, 0);
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#1b1f45'); g.addColorStop(1, '#0d1030');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = color; ctx.fillRect(0, h - 30, w, 30);
    const cy = (h - 30) / 2;
    if (text === 'SPACETIMEDB') { drawOrbits(ctx, w / 2, cy, 480, 0.3); drawSpacetimeWordmark(ctx, w / 2, cy, 104); return; }
    if (text === 'CALHACKS') { drawCalHacks(ctx, w / 2, cy, 300); return; }
    ctx.font = 'italic 900 200px Nunito, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fit = Math.min(1, (w * 0.86) / ctx.measureText(text).width);
    ctx.font = `italic 900 ${Math.floor(200 * fit)}px Nunito, system-ui, sans-serif`;
    ctx.lineJoin = 'round'; ctx.lineWidth = 22 * fit; ctx.strokeStyle = '#05060d';
    ctx.strokeText(text, w / 2, cy + 6);
    ctx.fillStyle = color; ctx.fillText(text, w / 2, cy + 6);
  };
  const c = canvas(BAR_W * BAR_RES, BAR_H * BAR_RES, ctx => paint(ctx, BAR_W, BAR_H)), t = tex(c, { aniso: 16 });
  if (text === 'CALHACKS') onBrandReady(() => { paint(c.getContext('2d'), BAR_W, BAR_H); t.needsUpdate = true; });
  return t;
}

// ---------- the table ----------
function makeTable() {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new RoundedBoxGeometry(HALF_L * 2, 0.03, HALF_W * 2, 2, 0.006),
    [std(0x14388a), std(0x14388a), new THREE.MeshPhysicalMaterial({ map: tableTexture(), roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.35 }), std(0x14388a), std(0x14388a), std(0x14388a)]);
  // The box's +y face carries the lines; rotate so the long side runs along z (towards the camera).
  top.rotation.y = Math.PI / 2; top.position.y = TOP - 0.015;
  top.castShadow = true; top.receiveShadow = true; g.add(top);
  const apron = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2 - 0.1, 0.06, HALF_L * 2 - 0.1), std(0x111a3a, { roughness: 0.7 }));
  apron.position.y = TOP - 0.06; g.add(apron);
  const legMat = std(0x2a2f45, { metalness: 0.6, roughness: 0.35 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, TOP - 0.06, 0.05), legMat);
    leg.position.set(sx * (HALF_W - 0.2), (TOP - 0.06) / 2, sz * (HALF_L - 0.25)); leg.castShadow = true; g.add(leg);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 16), std(0x111111));
    wheel.rotation.z = Math.PI / 2; wheel.position.set(leg.position.x, 0.035, leg.position.z); g.add(wheel);
  }
  for (const sz of [-1, 1]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(HALF_W * 2 - 0.4, 0.04, 0.04), legMat);
    bar.position.set(0, 0.2, sz * (HALF_L - 0.25)); g.add(bar);
  }
  // Net and posts
  const span = HALF_W * 2 + 0.3;
  const net = new THREE.Mesh(new THREE.PlaneGeometry(span, NET_H), new THREE.MeshBasicMaterial({ map: netTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  net.position.set(0, TOP + NET_H / 2, 0); g.add(net);
  const tape = new THREE.Mesh(new THREE.BoxGeometry(span, 0.016, 0.006), std(0xffffff, { roughness: 0.6 }));
  tape.position.set(0, TOP + NET_H - 0.008, 0); g.add(tape);
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, NET_H + 0.03, 10), std(0x22263a, { metalness: 0.6 }));
    post.position.set(sx * span / 2, TOP + NET_H / 2, 0); g.add(post);
    const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.04, 0.08), std(0x22263a, { metalness: 0.5 }));
    clamp.position.set(sx * (span / 2 - 0.02), TOP + 0.005, 0); g.add(clamp);
  }
  return g;
}

// ---------- paddles ----------
/** A paddle: red rubber on the +z face (what the camera sees on a forehand), black on the other, wooden handle. */
export function makePaddle(scale = 1) {
  const g = new THREE.Group();
  const blade = new THREE.Group(); g.add(blade);
  const shape = new THREE.Shape(); shape.absellipse(0, 0, 0.076, 0.082, 0, Math.PI * 2);
  const flat = new THREE.ShapeGeometry(shape, 40);
  const wood = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.006, 40), std(0xd9a066, { roughness: 0.6 }));
  wood.scale.set(0.077, 1, 0.083); wood.rotation.x = Math.PI / 2; blade.add(wood);
  const red = new THREE.Mesh(flat, new THREE.MeshPhysicalMaterial({ color: 0xe0202e, roughness: 0.55, clearcoat: 0.3, side: THREE.DoubleSide }));
  red.position.z = 0.0035; blade.add(red);
  const black = new THREE.Mesh(flat, new THREE.MeshPhysicalMaterial({ color: 0x16171c, roughness: 0.5, clearcoat: 0.3, side: THREE.DoubleSide }));
  black.position.z = -0.0035; black.rotation.y = Math.PI; blade.add(black);
  const handle = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.1, 0.024, 2, 0.008), std(0xc98a4b, { roughness: 0.5 }));
  handle.position.y = -0.125; blade.add(handle);
  const cap = new THREE.Mesh(new RoundedBoxGeometry(0.034, 0.016, 0.028, 2, 0.006), std(0x1c2033));
  cap.position.y = -0.17; blade.add(cap);
  blade.position.y = 0.1;     // group origin = where the handle meets the hand
  g.scale.setScalar(scale);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ---------- NPC opponent ----------
function makeNpc() {
  const g = new THREE.Group();
  const jersey = new THREE.MeshPhysicalMaterial({ color: C.red, roughness: 0.6, sheen: 0.5 });
  const skin = std(0xf2c39b, { roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.42, 6, 18), jersey); body.position.y = 1.05; body.castShadow = true; g.add(body);
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.203, 0.203, 0.06, 24, 1, true), std(0xffffff)); stripe.position.y = 1.12; g.add(stripe);
  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.5, 6, 14), std(0x1c2033)); legs.position.y = 0.48; legs.scale.x = 1.15; g.add(legs);
  const head = new THREE.Group(); head.position.y = 1.62; g.add(head);
  head.add(Object.assign(new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 18), skin), { castShadow: true }));
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.158, 0.022, 8, 28), std(C.yellow)); band.rotation.x = Math.PI / 2; band.position.y = 0.06; head.add(band);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.163, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.42), std(0x3a2316)); hair.position.y = 0.012; head.add(hair);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 10), std(0xffffff, { roughness: 0.2 })); eye.position.set(s * 0.055, 0, 0.14); head.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 8), std(0x111111)); pupil.position.set(s * 0.055, 0, 0.165); head.add(pupil);
  }
  const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.36, 4, 10), jersey); arm.castShadow = true; g.add(arm);
  const off = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.3, 4, 10), jersey); off.position.set(-0.24, 1.1, 0.05); off.rotation.z = -0.4; g.add(off);
  g.scale.setScalar(0.8);   // shorter, so the far end of the table stays in view; faces +z (the player)
  return { group: g, head, arm, body };
}

// ---------- crowd ----------
function makeCrowd() {
  const spots = [];
  for (let row = 0; row < 6; row++) {
    for (let i = 0; i < 46; i++) spots.push({ x: -8 + i * 0.36 + (row % 2) * 0.18, y: 0.9 + row * 0.42, z: -7.4 - row * 0.55 });
    for (const s of [-1, 1]) for (let i = 0; i < 26; i++) spots.push({ x: s * (5.4 + row * 0.55), y: 0.9 + row * 0.42, z: -6.5 + i * 0.4 + (row % 2) * 0.2 });
  }
  const geo = new THREE.CapsuleGeometry(0.12, 0.22, 3, 8);
  const mesh = new THREE.InstancedMesh(geo, std(0xffffff, { roughness: 0.8 }), spots.length);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.1, 10, 8), std(0xffffff, { roughness: 0.8 }), spots.length);
  const shirts = [C.blue, C.red, C.yellow, C.mint, C.purple, 0xffffff, 0x2b2f52, C.orange].map(c => new THREE.Color(c).multiplyScalar(0.55));
  const skins = [0xf2c39b, 0xd99a6c, 0x8d5a3b, 0xffdcc0, 0x5c3a24].map(c => new THREE.Color(c).multiplyScalar(0.6));
  spots.forEach((s, i) => { s.ph = rnd() * 6.28; s.f = 6 + rnd() * 5; mesh.setColorAt(i, shirts[i % shirts.length]); heads.setColorAt(i, skins[(i * 7) % skins.length]); });
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1);
  const g = new THREE.Group(); g.add(mesh, heads);
  // Tiers under the crowd
  const tierMat = std(0x141734, { roughness: 0.9 });
  for (let row = 0; row < 6; row++) {
    const back = new THREE.Mesh(new THREE.BoxGeometry(18, 0.42, 0.55), tierMat); back.position.set(0, 0.5 + row * 0.42, -7.4 - row * 0.55); g.add(back);
    for (const s of [-1, 1]) { const side = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.42, 12), tierMat); side.position.set(s * (5.4 + row * 0.55), 0.5 + row * 0.42, -1.5); g.add(side); }
  }
  return {
    group: g,
    update(t, excite) {
      spots.forEach((s, i) => {
        const hop = Math.max(0, Math.sin(t * s.f + s.ph)) * (0.02 + excite * 0.16);
        m.compose(p.set(s.x, s.y + hop, s.z), q, sc); mesh.setMatrixAt(i, m);
        m.compose(p.set(s.x, s.y + 0.27 + hop, s.z), q, sc); heads.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true; heads.instanceMatrix.needsUpdate = true;
    },
  };
}

// ---------- ball trail, bounce marker, hit ring ----------
function makeTrail(n = 14) {
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(BALL_R, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd27a).multiplyScalar(1.6), transparent: true, opacity: 0.35, depthWrite: false }), n);
  mesh.frustumCulled = false;
  const pts = [], m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  return {
    mesh,
    push(pos, on) {
      pts.unshift(on ? pos.clone() : null); if (pts.length > n) pts.pop();
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const k = p ? (1 - i / n) * 0.9 : 0;
        m.compose(p || pos, q, s.setScalar(k)); mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    clear() { pts.length = 0; },
  };
}
function makeMarker() {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.07, 32), mat);
  ring.rotation.x = -Math.PI / 2; ring.position.y = TOP + 0.002;
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.025, 24), mat); dot.position.z = 0.0005; ring.add(dot);
  let a = 0, want = 0, born = 0;
  return {
    mesh: ring,
    show(x, z, color) { ring.position.x = x; ring.position.z = z; mat.color.set(color).multiplyScalar(2); want = 1; born = 0; },
    hide() { want = 0; },
    update(dt) {
      born += dt; a += (want - a) * Math.min(1, dt * 12);
      mat.opacity = a * 0.9; ring.visible = a > 0.02;
      ring.scale.setScalar(1 + Math.max(0, 0.6 - born * 3) + Math.sin(born * 10) * 0.06);
    },
  };
}
function makeBursts() {
  const list = [];
  const g = new THREE.Group();
  const geo = new THREE.RingGeometry(0.6, 1, 40);
  return {
    group: g,
    fire(pos, color, size = 0.18) {
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(2.6), transparent: true, depthWrite: false, side: THREE.DoubleSide });
      const m = new THREE.Mesh(geo, mat); m.position.copy(pos); g.add(m);
      list.push({ m, t: 0, size });
    },
    update(dt, camera) {
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i]; b.t += dt;
        const k = b.t / 0.35;
        b.m.quaternion.copy(camera.quaternion);
        b.m.scale.setScalar(b.size * (0.3 + k * 1.4)); b.m.material.opacity = Math.max(0, 1 - k);
        if (k >= 1) { g.remove(b.m); b.m.material.dispose(); list.splice(i, 1); }
      }
    },
  };
}

export function createPongWorld(canvasEl) {
  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: false, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07081a);
  scene.fog = new THREE.Fog(0x07081a, 12, 30);
  scene.environment = makeEnvironment(renderer);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.03, 100);

  scene.add(new THREE.HemisphereLight(0xb8c4ff, 0x40201a, 0.6));
  const key = new THREE.SpotLight(0xfff3e4, 60, 14, 0.62, 0.45, 1.3);
  key.position.set(0.4, 5.2, 0.6); key.target.position.set(0, TOP, 0);
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0003; key.shadow.normalBias = 0.01;
  scene.add(key, key.target);
  for (const s of [-1, 1]) {
    const fill = new THREE.SpotLight(s < 0 ? 0xbcd2ff : 0xffd9ec, 24, 14, 0.7, 0.6, 1.5);
    fill.position.set(s * 3.5, 4, s * 2); fill.target.position.set(0, TOP, 0); scene.add(fill, fill.target);
  }
  const flash = new THREE.PointLight(C.yellow, 0, 4, 1.5); flash.position.set(0, 1.4, 0); scene.add(flash);

  // Floor and play area
  const floorT = floorTexture(); floorT.wrapS = floorT.wrapT = THREE.RepeatWrapping; floorT.repeat.set(3, 4);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(7, 12), new THREE.MeshPhysicalMaterial({ map: floorT, roughness: 0.5, clearcoat: 0.25 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), std(0x0c0e22, { roughness: 0.9 }));
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.002; scene.add(outer);

  // Sponsor barriers around the court
  const words = [['RALLY', '#ffc61a'], ['SPACETIMEDB', '#8a6bff'], ['PING PONG', '#1f8bff'], ['CALHACKS', '#508ba2'], ['RALLY', '#ff4f8b']];
  const bars = [];
  for (let i = 0; i < 4; i++) bars.push({ x: -3.5 + 1.4 * i + 0.7, z: -6, ry: 0 });
  for (const s of [-1, 1]) for (let i = 0; i < 8; i++) bars.push({ x: s * 3.5, z: -6 + 1.4 * i + 0.7, ry: -s * Math.PI / 2 });
  const barGeo = new THREE.BoxGeometry(1.38, 0.62, 0.04);
  const barMats = words.map(([w, c]) => barrierTexture(c, w)).map(t => [std(0x0d1030), std(0x0d1030), std(0x0d1030), std(0x0d1030), new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(1.15, 1.15, 1.15) }), std(0x0d1030)]);
  bars.forEach((b, i) => {
    const m = new THREE.Mesh(barGeo, barMats[i % barMats.length]);
    m.position.set(b.x, 0.31, b.z); m.rotation.y = b.ry;
    if (b.ry) m.rotation.y = b.x < 0 ? Math.PI / 2 : -Math.PI / 2;
    scene.add(m);
  });
  // Scoreboard tower behind the NPC end, ceiling glow strips
  const crowd = makeCrowd(); scene.add(crowd.group);
  for (const x of [-2.5, 0, 2.5]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 9), glow([C.blue, C.yellow, C.pink][(x / 2.5 + 1) | 0], 1.5));
    strip.position.set(x, 5.6, -2); scene.add(strip);
  }

  const table = makeTable(); scene.add(table);
  table.traverse(o => { if (o.isMesh) o.receiveShadow = true; });

  const paddle = makePaddle(1.15); scene.add(paddle);
  const npc = makeNpc(); scene.add(npc.group);
  const npcPaddle = makePaddle(1); scene.add(npcPaddle);

  const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R * 1.15, 24, 18), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d8, emissiveIntensity: 0.55, roughness: 0.35 }));
  ball.castShadow = true; scene.add(ball);
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(BALL_R * 1.4, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; scene.add(shadow);
  const trail = makeTrail(); scene.add(trail.mesh);
  const marker = makeMarker(); scene.add(marker.mesh);
  const bursts = makeBursts(); scene.add(bursts.group);
  const confetti = makeConfetti(); scene.add(confetti.mesh);

  // Post: MSAA HDR render → bloom → tone map → a soft vignette
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.45, 0.95));
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
      void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; vec2 d = vUv - 0.5; c *= mix(1.0, 0.72, smoothstep(0.1, 0.55, dot(d, d))); c = mix(vec3(dot(c, vec3(.2126,.7152,.0722))), c, 1.1); gl_FragColor = vec4(c, 1.0); }`,
  }));

  let pixelRatio = Math.min(window.devicePixelRatio, 1.5);
  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(pixelRatio); renderer.setSize(w, h, false);
    composer.setPixelRatio(pixelRatio); composer.setSize(w, h);
    camera.aspect = w / h; camera.fov = w / h < 0.9 ? 72 : 50; camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  let flashK = 0, excite = 0;
  return {
    scene, camera, paddle, npc, npcPaddle, marker, confetti,
    /** Ball position (or hidden), with its blob shadow on the table or floor and a short trail. */
    setBall(pos, visible, trailOn = true) {
      ball.visible = visible; shadow.visible = visible;
      if (!visible) { trail.push(pos, false); return; }
      ball.position.copy(pos);
      const onTable = Math.abs(pos.x) < HALF_W && Math.abs(pos.z) < HALF_L;
      const fy = onTable ? TOP + 0.001 : 0.001;
      const h = Math.max(0, pos.y - fy);
      shadow.position.set(pos.x, fy, pos.z);
      shadow.scale.setScalar(1 + h * 1.5);
      shadow.material.opacity = Math.max(0.08, 0.5 - h * 0.6);
      trail.push(pos, trailOn);
    },
    burst(pos, color, size) { bursts.fire(pos, color, size); },
    flash(k = 1) { flashK = k; },
    cheer(k = 1) { excite = Math.max(excite, k); },
    update(t, dt) {
      confetti.update(dt);
      marker.update(dt);
      bursts.update(dt, camera);
      excite = Math.max(0, excite - dt * 0.45);
      crowd.update(t, excite);
      flashK = Math.max(0, flashK - dt * 1.8);
      flash.intensity = flashK * 5;
    },
    render() { composer.render(); },
    setPixelRatio(pr) { pixelRatio = pr; resize(); },
  };
}
