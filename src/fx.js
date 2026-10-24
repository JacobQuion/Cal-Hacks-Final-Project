import * as THREE from 'three';

function tex(draw, size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// Thin bright ring with a soft glow on both sides (tinted by the material colour).
const ringTex = (width = 0.06, glow = 0.12) => tex((ctx, s) => {
  const r = s / 2 - s * 0.08;
  const g = ctx.createRadialGradient(s / 2, s / 2, r * (1 - width - glow), s / 2, s / 2, r * (1 + glow));
  const a = (1 - width - glow) / (1 + glow), b = (1 - width) / (1 + glow), c = 1 / (1 + glow);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(a, 'rgba(255,255,255,0)');
  g.addColorStop(b, 'rgba(255,255,255,0.95)'); g.addColorStop(c, 'rgba(255,255,255,0.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
}, 256);
// Aim reticle: ring with four ticks and a centre dot.
const reticleTex = () => tex((ctx, s) => {
  ctx.translate(s / 2, s / 2);
  ctx.shadowColor = 'rgba(255,255,255,0.9)'; ctx.shadowBlur = 10;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.arc(0, 0, s * 0.36, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 8; ctx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * s * 0.26, Math.sin(a) * s * 0.26); ctx.lineTo(Math.cos(a) * s * 0.46, Math.sin(a) * s * 0.46); ctx.stroke();
  }
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, s * 0.04, 0, Math.PI * 2); ctx.fill();
}, 256);
const crossTex = () => tex((ctx, s) => {
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(255,60,60,1)'; ctx.shadowBlur = 18;
  ctx.strokeStyle = '#ff4a4a'; ctx.lineWidth = s * 0.1;
  ctx.beginPath(); ctx.moveTo(s * 0.25, s * 0.25); ctx.lineTo(s * 0.75, s * 0.75); ctx.moveTo(s * 0.75, s * 0.25); ctx.lineTo(s * 0.25, s * 0.75); ctx.stroke();
  ctx.shadowBlur = 0; ctx.strokeStyle = '#ffd6d6'; ctx.lineWidth = s * 0.03;
  ctx.beginPath(); ctx.moveTo(s * 0.25, s * 0.25); ctx.lineTo(s * 0.75, s * 0.75); ctx.moveTo(s * 0.75, s * 0.25); ctx.lineTo(s * 0.25, s * 0.75); ctx.stroke();
}, 256);
const glowTex = (core = 0.15) => tex((ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(core, 'rgba(255,255,255,0.85)'); g.addColorStop(0.45, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
}, 64);
const discTex = (alpha = 0.55) => tex((ctx, s) => {
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, `rgba(255,255,255,${alpha})`); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
}, 64);
// Light-grey wisp for landing dust and feather fluff
const wispTex = () => tex((ctx, s) => {
  for (let i = 0; i < 9; i++) {
    const x = s / 2 + (Math.random() - 0.5) * s * 0.3, y = s / 2 + (Math.random() - 0.5) * s * 0.3, r = s * (0.18 + Math.random() * 0.15);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.22)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  }
}, 64);

// main.js asks for lime (normal) or magenta (smash); the realistic look uses a cool white streak and
// a hot orange-red one.
const TRAIL_LOOK = { 0xc6ff00: 0xcfe9ff, 0xff2bd6: 0xff5a2a };

export class FX {
  constructor(scene, camera) {
    this.scene = scene; this.camera = camera;
    this.shakeAmt = 0; this.shakeOffset = new THREE.Vector3();

    // Trail: a camera-facing ribbon that tapers and fades behind the shuttle
    this.trailN = 30; this.trailPts = [];
    const N = this.trailN;
    this.trailPos = new Float32Array(N * 2 * 3); this.trailA = new Float32Array(N * 2);
    const idx = [];
    for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    tg.setAttribute('alpha', new THREE.BufferAttribute(this.trailA, 1));
    tg.setIndex(idx);
    this.trailColor = new THREE.Color(0xcfe9ff);
    this.trail = new THREE.Mesh(tg, new THREE.ShaderMaterial({
      uniforms: { color: { value: this.trailColor } },
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 color; varying float vA; void main(){ gl_FragColor = vec4(color * vA * 1.6, vA); }',
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.trail.frustumCulled = false; this.trail.renderOrder = 4; scene.add(this.trail);

    // Under the shuttle: a soft shadow plus a faint ring, so its position reads on the court
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshBasicMaterial({ map: discTex(0.8), color: 0x000000, transparent: true, depthWrite: false, opacity: 0.5 }));
    this.shadow.rotation.x = -Math.PI / 2; scene.add(this.shadow);
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.36), new THREE.MeshBasicMaterial({ map: ringTex(0.08, 0.2), color: 0xdff4ff, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.blob.rotation.x = -Math.PI / 2; scene.add(this.blob);

    // Timing ring: shrinks onto the contact point; swing when it closes.
    const rt = ringTex(0.07, 0.16);
    this.timing = new THREE.Sprite(new THREE.SpriteMaterial({ map: rt, color: 0xffffff, transparent: true, depthTest: false, opacity: 0, blending: THREE.AdditiveBlending }));
    this.timing.renderOrder = 10; scene.add(this.timing);
    this.timingCore = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex(0.12, 0.18), color: 0x3bd16f, transparent: true, depthTest: false, opacity: 0, blending: THREE.AdditiveBlending }));
    this.timingCore.renderOrder = 11; this.timingCore.scale.setScalar(0.35); scene.add(this.timingCore);

    // Landing marker (player's side) and out-cross
    this.land = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7), new THREE.MeshBasicMaterial({ map: ringTex(0.1, 0.22), color: 0xffffff, transparent: true, depthWrite: false, opacity: 0, blending: THREE.AdditiveBlending }));
    this.land.rotation.x = -Math.PI / 2; scene.add(this.land);
    this.out = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), new THREE.MeshBasicMaterial({ map: crossTex(), transparent: true, depthWrite: false, opacity: 0 }));
    this.out.rotation.x = -Math.PI / 2; scene.add(this.out);

    // Aim reticle on the opponent's court
    this.aim = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshBasicMaterial({ map: reticleTex(), color: 0xff4f8b, transparent: true, depthWrite: false, opacity: 0.0, blending: THREE.AdditiveBlending }));
    this.aim.rotation.x = -Math.PI / 2; this.aim.position.set(0, 0.01, -4.6); scene.add(this.aim);
    this.aimX = 0;

    // Your secret target zone on the opponent's court (only your screen draws it)
    this.zone = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ map: discTex(0.9), color: 0x8a5cff, transparent: true, depthWrite: false, opacity: 0, blending: THREE.AdditiveBlending }));
    this.zone.rotation.x = -Math.PI / 2; this.zone.position.y = 0.008; scene.add(this.zone);
    this.zoneRing = new THREE.Mesh(new THREE.RingGeometry(0.95, 1, 64), new THREE.MeshBasicMaterial({ color: 0xb48cff, transparent: true, depthWrite: false, opacity: 0, blending: THREE.AdditiveBlending }));
    this.zoneRing.rotation.x = -Math.PI / 2; this.zoneRing.position.y = 0.01; scene.add(this.zoneRing);

    // Impact: glowing sparks, a flash, a shockwave on smashes and a little feather fluff
    const gTex = glowTex(), wTex = wispTex();
    this.sparks = Array.from({ length: 70 }, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: gTex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      s.visible = false; scene.add(s);
      return { s, v: new THREE.Vector3(), life: 0, max: 1, size: 0.1, drag: 1.5, grav: 7 };
    });
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(0.05), color: new THREE.Color(3, 3, 3), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.flash.visible = false; this.flash.renderOrder = 12; scene.add(this.flash); this.flashT = 0;
    this.wave = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex(0.05, 0.3), color: 0xffb070, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.wave.visible = false; scene.add(this.wave); this.waveT = 1;
    this.fluff = Array.from({ length: 16 }, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: wTex, color: 0xffffff, transparent: true, depthWrite: false }));
      s.visible = false; scene.add(s);
      return { s, v: new THREE.Vector3(), life: 0, max: 1, spin: 0 };
    });

    // Landing: a dust ring that spreads, plus a few dust wisps
    this.puffs = Array.from({ length: 4 }, () => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: ringTex(0.18, 0.4), color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.visible = false; scene.add(m);
      return { m, t: 1 };
    });
    this.dust = Array.from({ length: 24 }, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: wTex, color: 0xd8dde6, transparent: true, depthWrite: false }));
      s.visible = false; scene.add(s);
      return { s, v: new THREE.Vector3(), life: 0, max: 1, size: 0.3 };
    });
    this._side = new THREE.Vector3(); this._tan = new THREE.Vector3(); this._view = new THREE.Vector3();
  }

  resetTrail() { this.trailPts.length = 0; }
  setTrailColor(hex) { this.trailColor.setHex(TRAIL_LOOK[hex] ?? hex); this.smashTrail = hex === 0xff2bd6; }

  burst(pos, power = 0.5, n = 16) {
    const hot = power >= 0.9;
    const cols = hot ? [0xffb36b, 0xff6a3d, 0xffe2b0] : [0xfff4d6, 0xdff2ff, 0xffffff];
    let k = 0;
    for (const p of this.sparks) {
      if (p.life > 0) continue;
      p.life = p.max = 0.25 + Math.random() * 0.35;
      p.s.position.copy(pos);
      p.v.set(Math.random() - 0.5, Math.random() * 0.9 - 0.1, Math.random() - 0.5).normalize().multiplyScalar(3 + Math.random() * 5 * (0.5 + power));
      p.size = 0.04 + Math.random() * 0.05 + power * 0.03;
      p.s.material.color.setHex(cols[k % cols.length]).multiplyScalar(2);
      p.s.visible = true;
      if (++k >= n) break;
    }
    this.flash.position.copy(pos); this.flash.visible = true; this.flashT = 0.12; this.flashSize = 0.5 + power * 0.7;
    if (hot) { this.wave.position.copy(pos); this.wave.visible = true; this.waveT = 0; }
    let f = 0;
    for (const p of this.fluff) {
      if (p.life > 0) continue;
      p.life = p.max = 0.8 + Math.random() * 0.6;
      p.s.position.copy(pos);
      p.v.set((Math.random() - 0.5) * 1.6, Math.random() * 1.2, (Math.random() - 0.5) * 1.6);
      p.spin = (Math.random() - 0.5) * 6; p.s.visible = true;
      if (++f >= (hot ? 5 : 2)) break;
    }
  }

  puff(pos, color = 0xffffff) {
    const p = this.puffs.find(p => p.t >= 1) || this.puffs[0];
    p.t = 0; p.m.visible = true; p.m.position.set(pos.x, 0.012, pos.z); p.m.material.color.setHex(color);
    let k = 0;
    for (const d of this.dust) {
      if (d.life > 0) continue;
      d.life = d.max = 0.6 + Math.random() * 0.5;
      const a = Math.random() * Math.PI * 2;
      d.s.position.set(pos.x + Math.cos(a) * 0.05, 0.04, pos.z + Math.sin(a) * 0.05);
      d.v.set(Math.cos(a) * (0.6 + Math.random()), 0.25 + Math.random() * 0.4, Math.sin(a) * (0.6 + Math.random()));
      d.size = 0.12 + Math.random() * 0.12;
      d.s.material.color.setHex(color === 0xffffff ? 0xd8dde6 : color);
      d.s.visible = true;
      if (++k >= 7) break;
    }
  }

  shake(a) { this.shakeAmt = Math.max(this.shakeAmt, a); }

  // contact: {pos}, timeLeft (s, real time) or null to hide
  setTiming(pos, timeLeft) { this.timingPos = pos; this.timingLeft = timeLeft; }
  setLanding(pos, isIn) { this.landPos = pos; this.landIn = isIn; }
  setAim(x, visible) { this.aimX = x; this.aimVisible = visible; }
  // zone: { x, z, r } in the local frame, or null
  setZone(zone) { this.zoneData = zone; }

  updateTrail() {
    const N = this.trailN, pts = this.trailPts, cam = this.camera.position;
    const head = this.smashTrail ? 0.075 : 0.05;
    for (let i = 0; i < N; i++) {
      const p = pts[Math.min(i, pts.length - 1)];
      if (!p) { this.trailA[i * 2] = this.trailA[i * 2 + 1] = 0; continue; }
      const j = Math.min(i, pts.length - 1);
      const a = pts[Math.max(0, j - 1)], b = pts[Math.min(pts.length - 1, j + 1)];
      this._tan.subVectors(a, b);
      if (this._tan.lengthSq() < 1e-8) this._tan.set(0, 1, 0);
      this._view.subVectors(cam, p);
      this._side.crossVectors(this._tan, this._view).normalize();
      const k = 1 - i / N, w = head * k;
      this.trailPos.set([p.x + this._side.x * w, p.y + this._side.y * w, p.z + this._side.z * w], i * 6);
      this.trailPos.set([p.x - this._side.x * w, p.y - this._side.y * w, p.z - this._side.z * w], i * 6 + 3);
      const al = i < pts.length ? Math.pow(k, 1.6) * (this.smashTrail ? 0.9 : 0.55) : 0;
      this.trailA[i * 2] = this.trailA[i * 2 + 1] = al;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trail.geometry.attributes.alpha.needsUpdate = true;
    this.trail.visible = pts.length > 1;
  }

  update(dt, t, shuttleMesh, shuttleActive) {
    // trail
    if (shuttleActive) { this.trailPts.unshift(shuttleMesh.position.clone()); if (this.trailPts.length > this.trailN) this.trailPts.pop(); }
    else if (this.trailPts.length) this.trailPts.pop();
    this.updateTrail();

    // shadow + ring under the shuttle
    const sp = shuttleMesh.position;
    const h = Math.max(0, sp.y);
    this.shadow.visible = this.blob.visible = shuttleMesh.visible;
    this.shadow.position.set(sp.x, 0.011, sp.z); this.blob.position.set(sp.x, 0.012, sp.z);
    this.shadow.scale.setScalar(0.5 + h * 0.18); this.shadow.material.opacity = Math.max(0.12, 0.6 - h * 0.07);
    this.blob.scale.setScalar(0.7 + h * 0.12); this.blob.material.opacity = Math.max(0.2, 0.55 - h * 0.04);

    // timing ring
    const fade = (mat, target) => { mat.opacity += (target - mat.opacity) * Math.min(1, dt * 12); };
    if (this.timingPos && this.timingLeft !== null) {
      const left = Math.max(0, this.timingLeft);
      this.timing.position.copy(this.timingPos); this.timingCore.position.copy(this.timingPos);
      this.timing.scale.setScalar(0.35 + left * 2.2);
      const perfect = Math.abs(this.timingLeft) < 0.07;
      this.timing.material.color.setHex(perfect ? 0x3bd16f : 0xffffff).multiplyScalar(perfect ? 2.2 : 1.3);
      fade(this.timing.material, this.timingLeft < 1.1 ? 1 : 0);
      fade(this.timingCore.material, this.timingLeft < 1.1 ? 0.9 : 0);
      this.timingCore.scale.setScalar(perfect ? 0.45 : 0.35);
    } else { fade(this.timing.material, 0); fade(this.timingCore.material, 0); }

    // landing marker
    if (this.landPos) {
      this.land.position.set(this.landPos.x, 0.015, this.landPos.z); this.out.position.copy(this.land.position);
      fade(this.land.material, this.landIn ? 0.85 : 0); fade(this.out.material, this.landIn ? 0 : 0.9);
      this.land.scale.setScalar(1 + Math.sin(t * 10) * 0.08);
    } else { fade(this.land.material, 0); fade(this.out.material, 0); }

    // aim marker
    this.aim.position.x += (this.aimX - this.aim.position.x) * Math.min(1, dt * 14);
    fade(this.aim.material, this.aimVisible ? 0.75 : 0);
    this.aim.rotation.z += dt * 1.5;

    // secret target zone
    const zd = this.zoneData;
    if (zd) {
      for (const m of [this.zone, this.zoneRing]) { m.position.x = zd.x; m.position.z = zd.z; m.scale.setScalar(zd.r); }
    }
    fade(this.zone.material, zd ? 0.22 + Math.sin(t * 3) * 0.06 : 0);
    fade(this.zoneRing.material, zd ? 0.85 : 0);

    for (const p of this.puffs) {
      if (p.t >= 1) continue;
      p.t = Math.min(1, p.t + dt * 2.0);
      p.m.scale.setScalar(0.1 + p.t * 0.45); p.m.material.opacity = (1 - p.t) * (1 - p.t) * 0.7;
      if (p.t >= 1) p.m.visible = false;
    }
    for (const d of this.dust) {
      if (d.life <= 0) continue;
      d.life -= dt; d.v.multiplyScalar(1 - dt * 3);
      d.s.position.addScaledVector(d.v, dt);
      const a = d.life / d.max;
      d.s.material.opacity = Math.min(1, a * 1.5) * 0.6;
      d.s.scale.setScalar(d.size * (1.6 - a));
      if (d.life <= 0) d.s.visible = false;
    }
    for (const p of this.sparks) {
      if (p.life <= 0) continue;
      p.life -= dt; p.v.y -= p.grav * dt; p.v.multiplyScalar(1 - dt * p.drag);
      p.s.position.addScaledVector(p.v, dt);
      const a = p.life / p.max;
      p.s.material.opacity = Math.min(1, a * 2);
      p.s.scale.setScalar(p.size * (0.3 + a));
      if (p.life <= 0) p.s.visible = false;
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      const a = Math.max(0, this.flashT / 0.12);
      this.flash.scale.setScalar(this.flashSize * (0.4 + a)); this.flash.material.opacity = a;
      if (this.flashT <= 0) this.flash.visible = false;
    }
    if (this.waveT < 1) {
      this.waveT = Math.min(1, this.waveT + dt * 3.2);
      this.wave.scale.setScalar(0.2 + this.waveT * 2.2); this.wave.material.opacity = (1 - this.waveT) * 0.9;
      if (this.waveT >= 1) this.wave.visible = false;
    }
    for (const p of this.fluff) {
      if (p.life <= 0) continue;
      p.life -= dt; p.v.multiplyScalar(1 - dt * 2.5); p.v.y -= 0.6 * dt;
      p.s.position.addScaledVector(p.v, dt);
      p.s.material.rotation += p.spin * dt;
      const a = p.life / p.max;
      p.s.material.opacity = Math.min(1, a * 2) * 0.8; p.s.scale.setScalar(0.07 + (1 - a) * 0.05);
      if (p.life <= 0) p.s.visible = false;
    }

    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 2.5);
    const s = this.shakeAmt * this.shakeAmt;
    this.shakeOffset.set((Math.random() - 0.5) * s * 0.2, (Math.random() - 0.5) * s * 0.2, 0);
  }
}
