import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { LANE_HALF, GUTTER_X, KICKBACK_X, BALL_R, HEAD_Z, PIT_Z, PIN_SPOTS } from './bowl-physics.js';

// Neon bowling alley: glossy maple lanes with arrows and dots, chunky cartoon pins, a swirled ball,
// glowing masking units and ceiling strips, and live neighbour lanes. Everything is procedural.
// bowling.js drives it: lanes[k].pins / .ball are rendered from physics state each frame.

export const LANE_PITCH = 2 * GUTTER_X + 0.34;    // centre to centre of neighbouring lanes
const LANE_LEN = 19.4;                             // foul line → end of the pin deck
const C = { ink: 0x1c2033, yellow: 0xffc61a, red: 0xf23545, blue: 0x1f8bff, pink: 0xff4f8b, purple: 0x9b6bff, mint: 0x35c9a5, orange: 0xff8a3d };
const NEON = [C.pink, C.blue, C.yellow, C.mint, C.purple];

let seed = 7;
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
const hex = c => `#${new THREE.Color(c).getHexString()}`;

// ---------- reflections: a dark room with neon bands, so the lacquered lane and ball pick up colour ----------
function makeEnvironment(renderer) {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.BoxGeometry(30, 10, 50), new THREE.MeshBasicMaterial({ color: 0x090a1c, side: THREE.BackSide })));
  NEON.forEach((c, i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 40), glow(c, 1.2));
    m.rotation.x = Math.PI / 2; m.position.set((i - 2) * 2.2, 4.8, -6); s.add(m);
  });
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(14, 1.2), glow(0xfff2dc, 1.1));
  deck.position.set(0, 2.2, -20); s.add(deck);
  for (const x of [-14, 14]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(40, 0.5), glow(x < 0 ? C.purple : C.blue, 2.4));
    w.rotation.y = x < 0 ? Math.PI / 2 : -Math.PI / 2; w.position.set(x, 1.5, -6); s.add(w);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(s, 0.03).texture;
  pmrem.dispose();
  return env;
}

// ---------- lane surface: 39 maple boards, arrows at 15 ft, dots at 7 ft, a lighter pin deck ----------
function laneTexture() {
  const W = 512, H = 4096, ppm = H / LANE_LEN, boards = 39, bw = W / boards;
  const yOf = z => H - (-z) * ppm;     // z = 0 (foul line) at the bottom of the canvas
  return tex(canvas(W, H, (ctx) => {
    for (let i = 0; i < boards; i++) {
      const deck = yOf(HEAD_Z + 0.42);
      const l = 62 + rnd() * 7;
      ctx.fillStyle = `hsl(${32 + rnd() * 6}, ${52 + rnd() * 12}%, ${l}%)`; ctx.fillRect(i * bw, deck, bw + 0.5, H - deck);
      ctx.fillStyle = `hsl(${36 + rnd() * 5}, ${40 + rnd() * 10}%, ${l + 9}%)`; ctx.fillRect(i * bw, 0, bw + 0.5, deck);
      ctx.strokeStyle = 'rgba(120,70,30,0.13)'; ctx.lineWidth = 1;
      for (let k = 0; k < 9; k++) {
        const x = i * bw + rnd() * bw;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.bezierCurveTo(x + rnd() * 4 - 2, H * 0.3, x + rnd() * 4 - 2, H * 0.7, x, H); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(70,40,15,0.35)'; ctx.fillRect(i * bw, 0, 1, H);
    }
    ctx.fillStyle = 'rgba(70,40,15,0.45)'; ctx.fillRect(0, yOf(HEAD_Z + 0.42), W, 3);
    // Range finders, dots and arrows (the boards a bowler aims over)
    const boardX = b => W / 2 + (b - 20) * bw;
    const arrow = (b, z) => {
      const x = boardX(b), y = yOf(z);
      ctx.fillStyle = '#1c2033';
      ctx.beginPath(); ctx.moveTo(x, y - 34); ctx.lineTo(x + bw * 0.85, y + 22); ctx.lineTo(x, y + 8); ctx.lineTo(x - bw * 0.85, y + 22); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#f23545';
      ctx.beginPath(); ctx.moveTo(x, y - 24); ctx.lineTo(x + bw * 0.5, y + 12); ctx.lineTo(x, y + 3); ctx.lineTo(x - bw * 0.5, y + 12); ctx.closePath(); ctx.fill();
    };
    [5, 10, 15, 20, 25, 30, 35].forEach(b => arrow(b, -4.3 - (20 - Math.abs(b - 20)) * 0.035));
    for (const b of [3, 5, 8, 11, 14, 26, 29, 32, 35, 37]) {
      ctx.fillStyle = '#1c2033'; ctx.beginPath(); ctx.arc(boardX(b), yOf(-2.13), 5.5, 0, Math.PI * 2); ctx.fill();
    }
    for (const b of [10, 30]) { ctx.fillStyle = '#1c2033'; ctx.fillRect(boardX(b) - 3, yOf(-12.2), 6, 60); }
    // Pin spots
    for (const p of PIN_SPOTS) { ctx.fillStyle = 'rgba(28,32,51,.55)'; ctx.beginPath(); ctx.arc(W / 2 + (p.x / LANE_HALF) * (W / 2), yOf(p.z), 7, 0, Math.PI * 2); ctx.fill(); }
  }), { aniso: 16 });
}

function approachTexture() {
  return tex(canvas(512, 512, (ctx, w, h) => {
    const bw = w / 16;
    for (let i = 0; i < 16; i++) { ctx.fillStyle = `hsl(${30 + rnd() * 6}, 44%, ${52 + rnd() * 8}%)`; ctx.fillRect(i * bw, 0, bw + 0.5, h); ctx.fillStyle = 'rgba(60,35,15,.35)'; ctx.fillRect(i * bw, 0, 1, h); }
  }));
}

// Masking unit panel above the pins: neon logo and lane number.
function maskTexture(n, color) {
  return tex(canvas(1024, 300, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#171a3a'); g.addColorStop(1, '#0b0c20');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) { ctx.fillStyle = `rgba(255,255,255,${0.15 + rnd() * 0.5})`; ctx.beginPath(); ctx.arc(rnd() * w, rnd() * h, rnd() * 2.2, 0, Math.PI * 2); ctx.fill(); }
    ctx.lineWidth = 10; ctx.strokeStyle = hex(color); ctx.shadowColor = hex(color); ctx.shadowBlur = 24;
    ctx.strokeRect(14, 14, w - 28, h - 28);
    ctx.shadowBlur = 0;
    ctx.font = 'italic 900 112px Nunito, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = 16; ctx.strokeStyle = '#1c2033';
    ctx.strokeText('RACKET RUSH', w / 2 - 60, h / 2 + 6);
    ctx.fillStyle = '#ffc61a'; ctx.fillText('RACKET RUSH', w / 2 - 60, h / 2 + 6);
    ctx.font = 'italic 900 120px Nunito, system-ui, sans-serif';
    ctx.lineWidth = 14; ctx.strokeText(String(n), w - 110, h / 2 + 6);
    ctx.fillStyle = hex(color); ctx.fillText(String(n), w - 110, h / 2 + 6);
  }));
}

// ---------- pins: a lathed white pin with two red neck stripes (vertex colours) ----------
function pinGeometry() {
  const prof = [[0, 0], [0.026, 0], [0.042, 0.03], [0.056, 0.075], [0.0605, 0.114], [0.057, 0.16], [0.046, 0.2], [0.031, 0.236],
    [0.0235, 0.256], [0.025, 0.285], [0.0315, 0.322], [0.0323, 0.343], [0.027, 0.366], [0.014, 0.379], [0, 0.381]];
  const curve = new THREE.CatmullRomCurve3(prof.map(([r, y]) => new THREE.Vector3(r, y, 0)));
  const pts = curve.getSpacedPoints(90).map(p => new THREE.Vector2(Math.max(0, p.x), p.y));
  pts[0].set(0, 0); pts[pts.length - 1].set(0, 0.381);
  const g = new THREE.LatheGeometry(pts, 28);
  const pos = g.attributes.position, col = new Float32Array(pos.count * 3);
  const red = new THREE.Color(C.red), white = new THREE.Color(0xfbfbff);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const c = (y > 0.236 && y < 0.25) || (y > 0.262 && y < 0.276) ? red : white;
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function ballTexture(a, b, c) {
  return tex(canvas(512, 256, (ctx, w, h) => {
    const img = ctx.createImageData(w, h), d = img.data;
    const A = new THREE.Color(a), B = new THREE.Color(b), Cc = new THREE.Color(c), out = new THREE.Color();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = (x / w) * Math.PI * 2, v = (y / h) * Math.PI;
      const n = Math.sin(u * 3 + Math.sin(v * 4 + u) * 2.2) + Math.sin(v * 5 - u * 2 + Math.cos(u * 2) * 1.5) * 0.7;
      const k = (n + 1.7) / 3.4;
      out.copy(A).lerp(B, Math.min(1, Math.max(0, k * 1.4 - 0.2)));
      if (k > 0.78) out.lerp(Cc, (k - 0.78) * 4);
      const i = (y * w + x) * 4;
      d[i] = out.r * 255; d[i + 1] = out.g * 255; d[i + 2] = out.b * 255; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Finger holes
    for (const [x, y, r] of [[w * 0.24, h * 0.42, 13], [w * 0.29, h * 0.42, 13], [w * 0.265, h * 0.6, 16]]) {
      ctx.fillStyle = '#05060d'; ctx.beginPath(); ctx.ellipse(x, y, r * 0.75, r, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2; ctx.stroke();
    }
  }));
}

function makeBall(colors) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 48, 32),
    new THREE.MeshPhysicalMaterial({ map: ballTexture(...colors), roughness: 0.12, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.4 }));
  m.castShadow = true;
  return m;
}

// One lane: surface, gutters, kickbacks, deck, pit and its masking unit. Main lane = number 7.
function makeLaneShell(x, n, color, laneTex) {
  const g = new THREE.Group(); g.position.x = x;
  const surf = new THREE.Mesh(new THREE.PlaneGeometry(LANE_HALF * 2, LANE_LEN),
    new THREE.MeshPhysicalMaterial({ map: laneTex, roughness: 0.3, clearcoat: 0.55, clearcoatRoughness: 0.06, envMapIntensity: 0.35 }));
  surf.rotation.x = -Math.PI / 2; surf.position.set(0, 0, -LANE_LEN / 2); surf.receiveShadow = true; g.add(surf);
  // Gutters: half pipes either side
  const gutterMat = new THREE.MeshStandardMaterial({ color: 0x2a3150, roughness: 0.35, metalness: 0.6, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const gm = new THREE.Mesh(new THREE.CylinderGeometry(0.118, 0.118, LANE_LEN + 0.6, 20, 1, true, Math.PI / 2, Math.PI), gutterMat);
    gm.rotation.x = Math.PI / 2; gm.position.set(s * GUTTER_X, 0.0, -LANE_LEN / 2 - 0.3); gm.receiveShadow = true; g.add(gm);
    // Kickback by the pin deck, with a neon stripe
    const kb = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.8, 2.6, 3, 0.02), new THREE.MeshStandardMaterial({ color: C.ink, roughness: 0.5 }));
    kb.position.set(s * (KICKBACK_X + 0.04), 0.4, HEAD_Z - 0.6); kb.receiveShadow = true; g.add(kb);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.05, 2.5), glow(color, 2.6));
    stripe.position.set(s * (KICKBACK_X + 0.005), 0.55, HEAD_Z - 0.6); g.add(stripe);
  }
  // Pit, back cushion and the light glowing over the deck
  const pit = new THREE.Mesh(new THREE.BoxGeometry(KICKBACK_X * 2, 0.5, 1.2), new THREE.MeshStandardMaterial({ color: 0x05050b, roughness: 1 }));
  pit.position.set(0, -0.26, PIT_Z - 0.6); g.add(pit);
  const curtain = new THREE.Mesh(new THREE.PlaneGeometry(KICKBACK_X * 2 + 0.2, 1.2), new THREE.MeshStandardMaterial({ color: 0x0c0d1e, roughness: 0.95 }));
  curtain.position.set(0, 0.5, PIT_Z - 1.0); g.add(curtain);
  // Masking unit over the deck
  const mask = new THREE.Mesh(new THREE.BoxGeometry(LANE_PITCH, 0.62, 0.3), [
    std(C.ink), std(C.ink), std(C.ink), std(C.ink), new THREE.MeshBasicMaterial({ map: maskTexture(n, color), color: new THREE.Color(1.25, 1.25, 1.25) }), std(C.ink),
  ]);
  mask.position.set(0, 1.42, HEAD_Z + 0.65); g.add(mask);
  const under = new THREE.Mesh(new THREE.BoxGeometry(LANE_PITCH - 0.1, 0.03, 0.04), glow(color, 3));
  under.position.set(0, 1.1, HEAD_Z + 0.8); g.add(under);
  // Foul line
  const foul = new THREE.Mesh(new THREE.BoxGeometry(GUTTER_X * 2 + 0.24, 0.004, 0.035), glow(C.red, 1.6));
  foul.position.set(0, 0.002, 0); g.add(foul);
  return g;
}
const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, ...o });

// Divider between two lanes (capping) with a neon edge; a ball return hood on some of them.
function makeCapping(x, color, withReturn) {
  const g = new THREE.Group(); g.position.x = x;
  const w = LANE_PITCH - 2 * GUTTER_X - 0.12;
  const cap = new THREE.Mesh(new RoundedBoxGeometry(w, 0.07, LANE_LEN + 0.6, 3, 0.03), std(0x2b2f52, { roughness: 0.4 }));
  cap.position.set(0, 0.03, -LANE_LEN / 2 - 0.3); cap.receiveShadow = true; g.add(cap);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.01, LANE_LEN), glow(color, 1.3));
  edge.position.set(0, 0.072, -LANE_LEN / 2); g.add(edge);
  if (withReturn) {
    const hood = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.42, 1.5, 5, 0.12), std(C.yellow, { roughness: 0.35 }));
    hood.position.set(0, 0.21, 2.3); hood.castShadow = hood.receiveShadow = true; g.add(hood);
    const rail = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.08, 1.3, 3, 0.03), std(C.ink));
    rail.position.set(0, 0.46, 2.35); g.add(rail);
    [[C.pink, C.purple, 0xffffff], [C.mint, C.blue, 0xffffff]].forEach((cols, i) => {
      const b = makeBall(cols); b.position.set(0, 0.6, 1.95 + i * 0.26); b.rotation.set(rnd() * 3, rnd() * 3, 0); g.add(b);
    });
  }
  return g;
}

// ---------- aim guide: a flowing, glowing strip along the ball's predicted path ----------
function makeGuide() {
  const N = 48;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
  geo.setAttribute('along', new THREE.BufferAttribute(new Float32Array(N * 2), 1));
  const idx = [];
  for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(C.yellow) }, uLen: { value: 18 }, uAlpha: { value: 1 } },
    vertexShader: 'attribute float along; varying float vA; varying vec2 vUv; void main(){ vA = along; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float uTime; uniform vec3 uColor; uniform float uLen; uniform float uAlpha; varying float vA;
      void main(){
        float d = fract(vA * uLen * 0.9 - uTime * 1.6);
        float dash = smoothstep(0.0, 0.12, d) * (1.0 - smoothstep(0.45, 0.6, d));
        float fade = smoothstep(0.0, 0.05, vA) * (1.0 - smoothstep(0.75, 1.0, vA));
        gl_FragColor = vec4(uColor * (0.75 + dash * 0.45), (0.22 + dash * 0.7) * fade * uAlpha);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 2;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.06, 0.1, 32), new THREE.MeshBasicMaterial({ color: C.yellow, transparent: true, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  const group = new THREE.Group(); group.add(mesh, ring);
  return {
    group, mat,
    set(pts, gutter) {
      const pos = geo.attributes.position, al = geo.attributes.along;
      const last = pts.length - 1;
      for (let i = 0; i < N; i++) {
        const t = (i / (N - 1)) * last, k = Math.min(last - 1, Math.floor(t)), f = t - k;
        const a = pts[k], b = pts[Math.min(last, k + 1)];
        const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
        const w = 0.035 + 0.025 * (i / N);
        pos.setXYZ(i * 2, x - w, 0.004, z); pos.setXYZ(i * 2 + 1, x + w, 0.004, z);
        al.setX(i * 2, i / (N - 1)); al.setX(i * 2 + 1, i / (N - 1));
      }
      pos.needsUpdate = true; al.needsUpdate = true;
      geo.computeBoundingSphere();
      mat.uniforms.uLen.value = Math.abs(pts[last].z - pts[0].z);
      ring.position.set(pts[last].x, 0.006, pts[last].z);
      mat.uniforms.uColor.value.set(gutter ? C.red : C.yellow);
      ring.material.color.set(gutter ? C.red : C.yellow);
    },
  };
}

// ---------- confetti for strikes and spares ----------
export function makeConfetti() {
  const N = 260;
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.035, 0.022), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }), N);
  mesh.frustumCulled = false;
  const parts = [], m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  const cols = [C.yellow, C.pink, C.blue, C.mint, C.purple, 0xffffff].map(c => new THREE.Color(c));
  for (let i = 0; i < N; i++) { parts.push({ p: new THREE.Vector3(0, -10, 0), v: new THREE.Vector3(), r: new THREE.Vector3(), w: new THREE.Vector3(), life: 0 }); mesh.setColorAt(i, cols[i % cols.length]); }
  mesh.visible = false;
  return {
    mesh,
    burst(at, power = 1) {
      mesh.visible = true;
      for (const c of parts) {
        c.p.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * 0.8, Math.random() * 0.3, (Math.random() - 0.5) * 0.4));
        c.v.set((Math.random() - 0.5) * 3.2, 2 + Math.random() * 3 * power, 0.6 + Math.random() * 1.8);
        c.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
        c.w.set((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20);
        c.life = 2.6 + Math.random();
      }
    },
    update(dt) {
      if (!mesh.visible) return;
      let alive = 0;
      parts.forEach((c, i) => {
        c.life -= dt;
        if (c.life > 0) {
          alive++;
          c.v.y -= 4.5 * dt; c.v.multiplyScalar(Math.exp(-dt * 1.4));
          c.p.addScaledVector(c.v, dt); c.r.addScaledVector(c.w, dt);
        }
        q.setFromEuler(e.set(c.r.x, c.r.y, c.r.z));
        m.compose(c.life > 0 ? c.p : p.set(0, -10, 0), q, s);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (!alive) mesh.visible = false;
    },
  };
}

export function createBowlWorld(canvasEl, laneOffsets) {
  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: false, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07081a);
  scene.fog = new THREE.Fog(0x07081a, 26, 58);
  scene.environment = makeEnvironment(renderer);
  const camera = new THREE.PerspectiveCamera(46, 1, 0.05, 200);

  scene.add(new THREE.HemisphereLight(0xaab8ff, 0x2a1a10, 0.55));
  const key = new THREE.DirectionalLight(0xfff1e0, 1.1);
  key.position.set(1.5, 9, 3); key.target.position.set(0, 0, -9);
  key.castShadow = true; key.shadow.mapSize.set(1024, 2048);
  Object.assign(key.shadow.camera, { left: -4, right: 4, top: 14, bottom: -14, near: 1, far: 30 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  // Warm light over the pins (crisp pin shadows) and a soft one on the approach
  const deckLight = new THREE.SpotLight(0xfff0dc, 26, 6, 0.6, 0.5, 1.4);
  deckLight.position.set(0, 3.2, HEAD_Z + 1.4); deckLight.target.position.set(0, 0, HEAD_Z - 0.35);
  deckLight.castShadow = true; deckLight.shadow.mapSize.set(1024, 1024); deckLight.shadow.bias = -0.0005;
  scene.add(deckLight, deckLight.target);
  const flash = new THREE.PointLight(C.yellow, 0, 4, 1.5); flash.position.set(0, 0.8, HEAD_Z - 0.2); scene.add(flash);
  const approachLight = new THREE.SpotLight(0xffe7cc, 22, 9, 0.7, 0.6, 1.5);
  approachLight.position.set(0, 3.4, 1.5); approachLight.target.position.set(0, 0, -1.5);
  scene.add(approachLight, approachLight.target);

  // Lanes, cappings, approach, ceiling strips, side walls
  const laneTex = laneTexture();
  const LANE_NUMS = laneOffsets.map(k => 7 + k);
  laneOffsets.forEach((k, i) => scene.add(makeLaneShell(k * LANE_PITCH, LANE_NUMS[i], NEON[(k + 10) % NEON.length], laneTex)));
  const minK = Math.min(...laneOffsets), maxK = Math.max(...laneOffsets);
  for (let k = minK - 1; k <= maxK; k++) scene.add(makeCapping((k + 0.5) * LANE_PITCH, NEON[(k + 12) % NEON.length], k === 0 || k === -2));
  const span = (maxK - minK + 3) * LANE_PITCH;
  const approachT = approachTexture(); approachT.wrapS = approachT.wrapT = THREE.RepeatWrapping; approachT.repeat.set(span / 2.4, 2.5);
  const approach = new THREE.Mesh(new THREE.PlaneGeometry(span, 6), new THREE.MeshPhysicalMaterial({ map: approachT, roughness: 0.35, clearcoat: 0.6 }));
  approach.rotation.x = -Math.PI / 2; approach.position.set(((minK + maxK) / 2) * LANE_PITCH, -0.001, 3); approach.receiveShadow = true; scene.add(approach);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(span + 6, 30), std(0x0b0c1c, { roughness: 0.9 }));
  ceiling.rotation.x = Math.PI / 2; ceiling.position.set(0, 3.36, -8); scene.add(ceiling);
  for (const s of [-1, 1]) {
    const wx = s * ((s < 0 ? -minK : maxK) + 1.6) * LANE_PITCH;
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 3.4), std(0x10122a, { roughness: 0.85 }));
    wall.rotation.y = -s * Math.PI / 2; wall.position.set(wx, 1.7, -8); scene.add(wall);
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 30), glow(s < 0 ? C.purple : C.blue, 1.4));
    band.position.set(wx - s * 0.02, 1.1, -8); scene.add(band);
  }
  // A dark band over the whole deck row so the masking units read as one wall
  const header = new THREE.Mesh(new THREE.PlaneGeometry(span + 6, 1.95), std(0x0b0c1c, { roughness: 0.9 }));
  header.position.set(0, 2.7, HEAD_Z + 0.5); scene.add(header);

  // Pins and balls per lane
  const pinGeo = pinGeometry();
  const pinMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.8 });
  const ballColors = [[0x0f5fc0, 0x1f8bff, 0xc9e6ff], [0xb51d2b, 0xff4f8b, 0xffd6e4], [0x5b2bd6, 0x9b6bff, 0xffffff], [0x0f7a5c, 0x35c9a5, 0xffffff], [0xd99a00, 0xffc61a, 0xffffff]];
  const lanes = laneOffsets.map((k, i) => {
    const pins = PIN_SPOTS.map(() => { const m = new THREE.Mesh(pinGeo, pinMat); m.castShadow = true; m.receiveShadow = true; scene.add(m); return m; });
    const ball = makeBall(k === 0 ? ballColors[0] : ballColors[1 + (i % 4)]);
    scene.add(ball);
    return { k, x: k * LANE_PITCH, pins, ball };
  });

  const sweep = new THREE.Mesh(new RoundedBoxGeometry(KICKBACK_X * 2, 0.16, 0.05, 2, 0.02), std(0x2b2f52, { roughness: 0.4, metalness: 0.3 }));
  sweep.position.set(0, 0.95, HEAD_Z + 0.45); scene.add(sweep);
  const sweepStripe = new THREE.Mesh(new THREE.BoxGeometry(KICKBACK_X * 2 - 0.1, 0.03, 0.01), glow(C.yellow, 2.4));
  sweepStripe.position.set(0, 0, 0.03); sweep.add(sweepStripe);

  const guide = makeGuide(); scene.add(guide.group);
  const confetti = makeConfetti(); scene.add(confetti.mesh);

  // Post: MSAA HDR render → bloom → tone map → a soft vignette
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.38, 0.45, 0.94);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
      void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; vec2 d = vUv - 0.5; c *= mix(1.0, 0.7, smoothstep(0.1, 0.55, dot(d, d))); c = mix(vec3(dot(c, vec3(.2126,.7152,.0722))), c, 1.12); gl_FragColor = vec4(c, 1.0); }`,
  }));

  let pixelRatio = Math.min(window.devicePixelRatio, 1.5);
  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(pixelRatio); renderer.setSize(w, h, false);
    composer.setPixelRatio(pixelRatio); composer.setSize(w, h);
    camera.aspect = w / h; camera.fov = w / h < 0.9 ? 66 : 46; camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  const _q = new THREE.Quaternion(), _axis = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  let flashK = 0;
  return {
    scene, camera, lanes, sweep, guide, confetti,
    /** Draw one lane's physics state (lift raises standing pins, as the pinsetter does). */
    drawLane(L, state, dt, t, { lift = 0, hideBall = false } = {}) {
      state.pins.forEach((p, i) => {
        const m = L.pins[i];
        m.visible = p.state !== 'gone';
        if (!m.visible) return;
        const s = Math.sin(p.tilt);
        m.position.set(L.x + p.x, p.y + 0.055 * s + (p.state === 'standing' ? lift : 0) + (p.drop || 0), p.z);
        if (p.state === 'standing') {
          const w = p.wobble * 0.14;
          m.quaternion.setFromAxisAngle(_axis.set(Math.cos(t * 31 + i), 0, Math.sin(t * 31 + i)), Math.sin(t * 24 + i) * w);
        } else {
          m.quaternion.setFromAxisAngle(_axis.set(p.dz, 0, -p.dx).normalize(), p.tilt);
          _q.setFromAxisAngle(_up, p.yaw); m.quaternion.premultiply(_q);
        }
      });
      const b = state.ball, bm = L.ball;
      bm.visible = !hideBall && !b.gone;
      if (!bm.visible) return;
      bm.position.set(L.x + b.x, b.y, b.z);
      const v = Math.hypot(b.vx, b.vz);
      if (v > 0.01 && b.live) {
        _axis.set(b.vz, 0, -b.vx).normalize();
        _q.setFromAxisAngle(_axis, (v / BALL_R) * dt); bm.quaternion.premultiply(_q);
        _axis.set(b.vx, 0, b.vz).normalize();
        _q.setFromAxisAngle(_axis, b.spin * 9 * dt); bm.quaternion.premultiply(_q);
      }
    },
    flash(k = 1) { flashK = k; },
    update(t, dt) {
      guide.mat.uniforms.uTime.value = t;
      confetti.update(dt);
      flashK = Math.max(0, flashK - dt * 1.6);
      flash.intensity = flashK * 4;
    },
    render() { composer.render(); },
    setPixelRatio(pr) { pixelRatio = pr; resize(); },
  };
}
