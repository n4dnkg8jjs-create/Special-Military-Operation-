import * as THREE from 'three';

// GPU-billboarded particle systems (smoke/dust lit by the sun; fire/flash/tracers additive),
// a small pool of dynamic point lights, and helpers for composite effects.

function puffAtlas() {
  // 2x2 atlas of soft noisy smoke puffs
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S * 2; const x = c.getContext('2d');
  for (let k = 0; k < 4; k++) {
    const ox = (k % 2) * S, oy = Math.floor(k / 2) * S;
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * 6.28, r = Math.random() ** 0.7 * S * 0.3, cx = ox + S / 2 + Math.cos(a) * r, cy = oy + S / 2 + Math.sin(a) * r, rr = S * (0.08 + Math.random() * 0.16);
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, rr); const v = 200 + Math.random() * 55;
      g.addColorStop(0, `rgba(${v},${v},${v},${0.10 + Math.random() * 0.12})`); g.addColorStop(1, `rgba(${v},${v},${v},0)`);
      x.fillStyle = g; x.beginPath(); x.arc(cx, cy, rr, 0, 7); x.fill();
    }
    // radial falloff mask
    x.globalCompositeOperation = 'destination-in';
    const m = x.createRadialGradient(ox + S / 2, oy + S / 2, S * 0.15, ox + S / 2, oy + S / 2, S / 2);
    m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = m; x.fillRect(ox, oy, S, S);
    x.globalCompositeOperation = 'source-over';
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function flareTex() {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.2, 'rgba(255,230,180,0.85)'); g.addColorStop(0.5, 'rgba(255,140,40,0.25)'); g.addColorStop(1, 'rgba(255,90,10,0)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  // star rays
  x.globalCompositeOperation = 'lighter'; x.strokeStyle = 'rgba(255,220,160,0.35)'; x.lineWidth = 3;
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + Math.random() * 0.4; x.beginPath(); x.moveTo(S / 2, S / 2); x.lineTo(S / 2 + Math.cos(a) * S * 0.48, S / 2 + Math.sin(a) * S * 0.48); x.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

const VERT = `
  attribute vec3 iPos; attribute vec4 iCol; attribute vec4 iMisc; attribute vec3 iVel;
  varying vec2 vUv; varying vec4 vCol; varying float vLight; varying float vDepth;
  uniform vec3 sunDir; uniform float stretchK; uniform float atlas;
  void main(){
    float size = iMisc.x, rot = iMisc.y, frame = iMisc.z, stretch = iMisc.w;
    vec4 mv = modelViewMatrix * vec4(iPos,1.0);
    vec2 p = position.xy;
    if (stretch > 0.0) {
      vec3 dv = (modelViewMatrix * vec4(iPos + iVel, 1.0)).xyz - mv.xyz;
      vec2 d = normalize(dv.xy + 1e-5); vec2 n = vec2(-d.y, d.x);
      mv.xyz += vec3(d * p.y * stretch + n * p.x * size, 0.0);
    } else {
      float c = cos(rot), s = sin(rot);
      mv.xy += mat2(c,-s,s,c) * p * size;
    }
    vUv = (uv + vec2(mod(frame,2.0), floor(frame/2.0))) * 0.5;
    if (stretch > 0.0 || atlas < 0.5) vUv = uv;
    vCol = iCol;
    // cheap lighting: puffs facing the sun are brighter
    vLight = 0.55 + 0.45 * clamp(dot(normalize(vec3(p, 0.6)), normalize((viewMatrix*vec4(sunDir,0.0)).xyz))*0.9+0.4, 0.0, 1.0);
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG_ALPHA = `
  uniform sampler2D map; uniform vec3 fogColor; uniform float fogDensity; uniform vec3 ambient;
  varying vec2 vUv; varying vec4 vCol; varying float vLight; varying float vDepth;
  void main(){
    vec4 t = texture2D(map, vUv);
    vec3 col = vCol.rgb * t.rgb * (ambient + vLight);
    float a = t.a * vCol.a;
    float f = 1.0 - exp(-fogDensity*fogDensity*vDepth*vDepth);
    col = mix(col, fogColor, f*0.85);
    gl_FragColor = vec4(col, a);
    #include <colorspace_fragment>
  }`;
const FRAG_ADD = `
  uniform sampler2D map; varying vec2 vUv; varying vec4 vCol; varying float vDepth;
  void main(){ vec4 t = texture2D(map, vUv); gl_FragColor = vec4(vCol.rgb * t.rgb * vCol.a * t.a, 1.0); }`;

class System {
  constructor(scene, max, additive, tex, sunDir) {
    this.max = max; this.n = 0; this.p = [];
    const g = new THREE.InstancedBufferGeometry();
    const q = new THREE.PlaneGeometry(1, 1); g.index = q.index; g.attributes.position = q.attributes.position; g.attributes.uv = q.attributes.uv;
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aMisc = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iCol', this.aCol); g.setAttribute('iMisc', this.aMisc); g.setAttribute('iVel', this.aVel);
    g.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, sunDir: { value: sunDir }, fogColor: { value: new THREE.Color(0x9a978e) }, fogDensity: { value: 0.0026 }, ambient: { value: new THREE.Vector3(0.35, 0.36, 0.38) }, stretchK: { value: 1 }, atlas: { value: additive ? 0 : 1 } },
      vertexShader: VERT, fragmentShader: additive ? FRAG_ADD : FRAG_ALPHA, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = additive ? 11 : 10; scene.add(this.mesh);
    this.geo = g;
  }
  // o: {x,y,z, vx,vy,vz, life, size0, size1, r,g,b, a0,a1, drag, grav, rot, rotv, frame, stretch, buoy}
  spawn(o) {
    if (this.p.length >= this.max) this.p.shift();
    o.t = 0; o.rot ??= Math.random() * 6.28; o.rotv ??= (Math.random() - .5) * 0.6; o.frame ??= Math.floor(Math.random() * 4);
    o.vx ??= 0; o.vy ??= 0; o.vz ??= 0; o.drag ??= 0.5; o.grav ??= 0; o.a1 ??= 0; o.size1 ??= o.size0; o.stretch ??= 0;
    this.p.push(o);
  }
  update(dt, camPos) {
    const P = this.p; let w = 0;
    for (let i = 0; i < P.length; i++) {
      const o = P[i]; o.t += dt; if (o.t >= o.life) continue;
      const k = Math.exp(-o.drag * dt); o.vx *= k; o.vy = o.vy * k - o.grav * dt; o.vz *= k;
      if (o.wind) { o.vx += o.wind[0] * dt; o.vz += o.wind[1] * dt; }
      o.x += o.vx * dt; o.y += o.vy * dt; o.z += o.vz * dt; o.rot += o.rotv * dt;
      if (o.y < 0.05 && o.grav > 0) { o.y = 0.05; o.vy *= -0.25; o.vx *= 0.5; o.vz *= 0.5; }
      P[w++] = o;
    }
    P.length = w;
    // sort back-to-front for alpha systems
    if (camPos && !this.additive) P.sort((a, b) => ((b.x - camPos.x) ** 2 + (b.y - camPos.y) ** 2 + (b.z - camPos.z) ** 2) - ((a.x - camPos.x) ** 2 + (a.y - camPos.y) ** 2 + (a.z - camPos.z) ** 2));
    const pos = this.aPos.array, col = this.aCol.array, misc = this.aMisc.array, vel = this.aVel.array;
    for (let i = 0; i < P.length; i++) {
      const o = P[i], f = o.t / o.life, ease = 1 - (1 - f) * (1 - f);
      pos[i * 3] = o.x; pos[i * 3 + 1] = o.y; pos[i * 3 + 2] = o.z;
      const fadeIn = o.fadeIn ? Math.min(1, o.t / o.fadeIn) : 1;
      const cf = o.cool ? Math.min(1, f / o.cool) : 0;
      col[i * 4] = o.r + ((o.r1 ?? o.r) - o.r) * cf; col[i * 4 + 1] = o.g + ((o.g1 ?? o.g) - o.g) * cf; col[i * 4 + 2] = o.b + ((o.b1 ?? o.b) - o.b) * cf;
      col[i * 4 + 3] = (o.a0 + (o.a1 - o.a0) * f) * fadeIn;
      misc[i * 4] = o.size0 + (o.size1 - o.size0) * ease; misc[i * 4 + 1] = o.rot; misc[i * 4 + 2] = o.frame; misc[i * 4 + 3] = o.stretch;
      const sp = Math.hypot(o.vx, o.vy, o.vz) || 1, L = o.stretch ? 1 : 0;
      vel[i * 3] = o.vx / sp * L; vel[i * 3 + 1] = o.vy / sp * L; vel[i * 3 + 2] = o.vz / sp * L;
    }
    this.geo.instanceCount = P.length;
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aMisc.needsUpdate = this.aVel.needsUpdate = true;
  }
}

export class FX {
  constructor(scene, sunDir, quality) {
    this.scene = scene; this.q = quality;
    const mul = quality === 'low' ? 0.5 : 1;
    this.smoke = new System(scene, Math.round(3500 * mul), false, puffAtlas(), sunDir);
    const flare = flareTex();
    this.glow = new System(scene, Math.round(2500 * mul), true, flare, sunDir);
    this.glow.additive = true;
    this.lights = [];
    for (let i = 0; i < (quality === 'low' ? 3 : 8); i++) { const l = new THREE.PointLight(0xffb060, 0, 30, 2); l.castShadow = false; scene.add(l); this.lights.push({ l, t: 0, life: 0.1, i0: 0 }); }
    this.emitters = []; this.wind = [0.9, 0.35];
    this.debris = []; this.debrisMat = new THREE.MeshStandardMaterial({ color: 0x77716a, roughness: 1 });
    this.debrisGeo = new THREE.BoxGeometry(1, 1, 1);
    this.debrisMesh = new THREE.InstancedMesh(this.debrisGeo, this.debrisMat, 600); this.debrisMesh.count = 0; this.debrisMesh.castShadow = true; this.debrisMesh.frustumCulled = false; scene.add(this.debrisMesh);
  }
  light(pos, color, intensity, dist, life) {
    let best = this.lights[0]; for (const L of this.lights) if (L.l.intensity / (L.i0 || 1) < best.l.intensity / (best.i0 || 1)) best = L;
    best.l.position.copy(pos); best.l.color.set(color); best.l.distance = dist; best.i0 = intensity; best.l.intensity = intensity; best.t = 0; best.life = life;
  }
  muzzle(pos, dir, big = 1) {
    this.glow.spawn({ x: pos.x, y: pos.y, z: pos.z, life: 0.05 + 0.03 * big, size0: 0.35 * big, size1: 0.6 * big, r: 1, g: 0.75, b: 0.4, a0: 2.2, a1: 0 });
    this.glow.spawn({ x: pos.x + dir.x * 0.3 * big, y: pos.y + dir.y * 0.3 * big, z: pos.z + dir.z * 0.3 * big, life: 0.05, size0: 0.25 * big, size1: 0.4 * big, r: 1, g: 0.8, b: 0.5, a0: 1.5, a1: 0 });
    this.smoke.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: dir.x * 2 * big, vy: 0.4, vz: dir.z * 2 * big, life: 0.9 + big * 0.6, size0: 0.25 * big, size1: 1.2 * big, r: 0.85, g: 0.84, b: 0.82, a0: 0.22, a1: 0, drag: 2.5, wind: this.wind });
    if (big >= 1) this.light(pos, 0xffb265, 6 * big, 6 + 6 * big, 0.06);
  }
  tracer(a, b, speed = 750, color = [1, 0.55, 0.25]) {
    const d = new THREE.Vector3().subVectors(b, a); const L = d.length(); d.normalize();
    this.glow.spawn({ x: a.x, y: a.y, z: a.z, vx: d.x * speed, vy: d.y * speed, vz: d.z * speed, life: Math.max(0.02, L / speed), size0: 0.05, size1: 0.05, stretch: 4.5, r: color[0], g: color[1], b: color[2], a0: 4, a1: 3, drag: 0, frame: 0 });
  }
  impact(pos, kind = 'dirt', n = 1) {
    const c = kind === 'concrete' ? [0.72, 0.7, 0.66] : kind === 'metal' ? [0.6, 0.58, 0.55] : [0.5, 0.44, 0.36];
    this.smoke.spawn({ x: pos.x, y: pos.y + 0.1, z: pos.z, vx: (Math.random() - .5), vy: 1.2 + Math.random(), vz: (Math.random() - .5), life: 0.9 + Math.random() * 0.6, size0: 0.15, size1: 0.9 * n, r: c[0], g: c[1], b: c[2], a0: 0.45, a1: 0, drag: 2.2, wind: this.wind });
    if (kind === 'metal' || Math.random() < 0.3) for (let i = 0; i < 3; i++) this.glow.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: (Math.random() - .5) * 8, vy: Math.random() * 5, vz: (Math.random() - .5) * 8, life: 0.15 + Math.random() * 0.2, size0: 0.03, size1: 0.02, stretch: 0.25, r: 1, g: 0.7, b: 0.3, a0: 3, a1: 0, grav: 9.8, drag: 0.5 });
  }
  blood(pos) { // muted, non-gory hit puff
    this.smoke.spawn({ x: pos.x, y: pos.y, z: pos.z, vy: 0.3, life: 0.5, size0: 0.1, size1: 0.45, r: 0.35, g: 0.12, b: 0.1, a0: 0.4, a1: 0, drag: 3 });
  }
  explosion(pos, power = 1, opts = {}) {
    const p = power;
    // flash + fireball
    this.glow.spawn({ x: pos.x, y: pos.y + 0.5 * p, z: pos.z, life: 0.12, size0: 3 * p, size1: 7 * p, r: 1, g: 0.85, b: 0.6, a0: 3, a1: 0, frame: 0 });
    for (let i = 0; i < 10 * p; i++) this.glow.spawn({ x: pos.x + (Math.random() - .5) * p, y: pos.y + Math.random() * p, z: pos.z + (Math.random() - .5) * p, vx: (Math.random() - .5) * 8 * p, vy: 2 + Math.random() * 6 * p, vz: (Math.random() - .5) * 8 * p, life: 0.25 + Math.random() * 0.35, size0: 1.2 * p, size1: 2.6 * p, r: 1, g: 0.55, b: 0.2, a0: 1.6, a1: 0, drag: 3.5 });
    // sparks / fragments
    for (let i = 0; i < 18 * p; i++) this.glow.spawn({ x: pos.x, y: pos.y + 0.3, z: pos.z, vx: (Math.random() - .5) * 40, vy: Math.random() * 25, vz: (Math.random() - .5) * 40, life: 0.3 + Math.random() * 0.5, size0: 0.05, size1: 0.03, stretch: 0.6, r: 1, g: 0.65, b: 0.3, a0: 3, a1: 0, grav: 9.8, drag: 0.8 });
    // dust + black smoke column
    const dust = opts.dust ?? [0.62, 0.57, 0.5];
    for (let i = 0; i < 9 * p; i++) { const a = Math.random() * 6.28, s = 2 + Math.random() * 5; this.smoke.spawn({ x: pos.x, y: pos.y + 0.4, z: pos.z, vx: Math.cos(a) * s * Math.sqrt(p), vy: 0.5 + Math.random() * 2, vz: Math.sin(a) * s * Math.sqrt(p), life: 2 + Math.random() * 2.5, size0: 0.8 * p, size1: 3.6 * p, r: dust[0], g: dust[1], b: dust[2], a0: 0.5, a1: 0, drag: 2.0, wind: this.wind }); }
    for (let i = 0; i < 6 * p; i++) this.smoke.spawn({ x: pos.x + (Math.random() - .5) * p, y: pos.y + 0.5 + Math.random() * 2 * p, z: pos.z + (Math.random() - .5) * p, vx: (Math.random() - .5) * 3, vy: 3 + Math.random() * 5 * Math.sqrt(p), vz: (Math.random() - .5) * 3, life: 3 + Math.random() * 3, size0: 1.2 * p, size1: 4.5 * p, r: 0.16, g: 0.15, b: 0.14, a0: 0.7, a1: 0, drag: 1.1, wind: this.wind, fadeIn: 0.15 });
    // chunks
    const n = Math.round(8 * p); const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) this.debris.push({ x: pos.x, y: pos.y + 0.4, z: pos.z, vx: (Math.random() - .5) * 18 * p, vy: 6 + Math.random() * 14 * p, vz: (Math.random() - .5) * 18 * p, s: 0.08 + Math.random() * 0.25 * p, r: [Math.random() * 6, Math.random() * 6, Math.random() * 6], w: [(Math.random() - .5) * 15, (Math.random() - .5) * 15], t: 0, rest: false });
    this.light(new THREE.Vector3(pos.x, pos.y + 2, pos.z), 0xff9a4a, 60 * p, 22 * p, 0.25);
  }
  muzzleBlastTank(pos, dir) {
    this.muzzle(pos, dir, 3.2);
    // ground dust ring from the overpressure
    for (let i = 0; i < 18; i++) { const a = Math.random() * 6.28; this.smoke.spawn({ x: pos.x - dir.x * 3, y: 0.4, z: pos.z - dir.z * 3, vx: Math.cos(a) * 10, vy: 0.4, vz: Math.sin(a) * 10, life: 2.5, size0: 1, size1: 4.5, r: 0.6, g: 0.55, b: 0.48, a0: 0.4, a1: 0, drag: 2.4, wind: this.wind }); }
    for (let i = 0; i < 6; i++) this.smoke.spawn({ x: pos.x + dir.x * i * 0.8, y: pos.y, z: pos.z + dir.z * i * 0.8, vx: dir.x * 14, vy: 0.5, vz: dir.z * 14, life: 2, size0: 0.8, size1: 3.5, r: 0.8, g: 0.78, b: 0.74, a0: 0.45, a1: 0, drag: 3 });
  }
  dustCloud(pos, w, h, n = 20, color = [0.66, 0.62, 0.56]) {
    for (let i = 0; i < n; i++) this.smoke.spawn({ x: pos.x + (Math.random() - .5) * w, y: pos.y + Math.random() * h, z: pos.z + (Math.random() - .5) * w, vx: (Math.random() - .5) * 2, vy: -0.5 + Math.random(), vz: (Math.random() - .5) * 2, life: 3.5 + Math.random() * 3, size0: 1.5, size1: 5, r: color[0], g: color[1], b: color[2], a0: 0.4, a1: 0, drag: 0.8, wind: this.wind, fadeIn: 0.3 });
  }
  smokeScreen(pos, life = 35) {
    for (let i = 0; i < 26; i++) this.smoke.spawn({ x: pos.x + (Math.random() - .5) * 3, y: 0.5 + Math.random() * 2, z: pos.z + (Math.random() - .5) * 3, vx: (Math.random() - .5) * 3, vy: 0.4 + Math.random() * 0.6, vz: (Math.random() - .5) * 3, life: life * (0.6 + Math.random() * 0.4), size0: 2, size1: 10 + Math.random() * 5, r: 0.86, g: 0.86, b: 0.84, a0: 0.75, a1: 0, drag: 0.6, wind: [this.wind[0] * 0.4, this.wind[1] * 0.4], fadeIn: 1.5 });
  }
  // persistent emitters: fire (burning wreck/building), plume (distant columns), smoulder
  emitter(pos, kind, scale = 1, life = Infinity) { const e = { pos: pos.clone(), kind, scale, acc: 0, life, t: 0 }; this.emitters.push(e); return e; }
  vehicleDust(pos, speed) {
    if (Math.random() > speed * 0.06) return;
    this.smoke.spawn({ x: pos.x + (Math.random() - .5) * 2, y: 0.4, z: pos.z + (Math.random() - .5) * 2, vy: 0.3, life: 3, size0: 1, size1: 4, r: 0.6, g: 0.56, b: 0.5, a0: 0.25, a1: 0, drag: 1, wind: this.wind });
  }
  exhaust(pos, load) {
    if (Math.random() > 0.35 + load * 0.5) return;
    this.smoke.spawn({ x: pos.x, y: pos.y, z: pos.z, vy: 0.8, life: 1.6 + load, size0: 0.25, size1: 1.6 + load * 1.5, r: 0.22, g: 0.22, b: 0.22, a0: 0.25 + load * 0.3, a1: 0, drag: 1.5, wind: this.wind });
  }
  update(dt, camPos) {
    for (const e of this.emitters) {
      e.t += dt; if (e.t > e.life) { e.dead = true; continue; }
      e.acc += dt; const s = e.scale, fade = e.life < Infinity ? Math.max(0, 1 - e.t / e.life) : 1;
      if (e.kind === 'fire') {
        while (e.acc > 0.05) { e.acc -= 0.05;
          this.glow.spawn({ x: e.pos.x + (Math.random() - .5) * s, y: e.pos.y + Math.random() * 0.4, z: e.pos.z + (Math.random() - .5) * s, vx: 0, vy: 2 + Math.random() * 2, vz: 0, life: 0.5 + Math.random() * 0.4, size0: 0.9 * s, size1: 0.3 * s, r: 1, g: 0.38, b: 0.08, a0: 0.75 * fade, a1: 0, drag: 0.5, wind: this.wind, frame: 0 });
          if (Math.random() < 0.5) this.smoke.spawn({ x: e.pos.x, y: e.pos.y + 1.2 * s, z: e.pos.z, vx: (Math.random() - .5), vy: 2.5 + Math.random() * 2, vz: (Math.random() - .5), life: 7 + Math.random() * 5, size0: 1.0 * s, size1: 6 * s, r: 0.1, g: 0.095, b: 0.09, a0: 0.6 * fade, a1: 0, drag: 0.4, wind: this.wind, fadeIn: 0.4 });
        }
        if (Math.random() < 0.1) this.light(new THREE.Vector3(e.pos.x, e.pos.y + 1.5, e.pos.z), 0xff7a2a, 8 * s, 12 * s, 0.25);
      } else if (e.kind === 'plume') {
        while (e.acc > 0.35) { e.acc -= 0.35;
          this.smoke.spawn({ x: e.pos.x + (Math.random() - .5) * 4, y: e.pos.y, z: e.pos.z + (Math.random() - .5) * 4, vx: 0, vy: 4 + Math.random() * 2, vz: 0, life: 30 + Math.random() * 10, size0: 6 * s, size1: 38 * s, r: 0.13, g: 0.125, b: 0.12, a0: 0.55, a1: 0, drag: 0.08, wind: [this.wind[0] * 1.5, this.wind[1] * 1.5], fadeIn: 2 });
        }
      } else if (e.kind === 'smoulder') {
        while (e.acc > 0.4) { e.acc -= 0.4; this.smoke.spawn({ x: e.pos.x + (Math.random() - .5) * 2 * s, y: e.pos.y, z: e.pos.z + (Math.random() - .5) * 2 * s, vy: 1 + Math.random(), life: 7, size0: 0.8 * s, size1: 3.5 * s, r: 0.3, g: 0.29, b: 0.27, a0: 0.22 * fade, a1: 0, drag: 0.3, wind: this.wind, fadeIn: 1 }); }
      }
    }
    this.emitters = this.emitters.filter(e => !e.dead);
    for (const L of this.lights) { if (L.l.intensity <= 0) continue; L.t += dt; L.l.intensity = L.t > L.life ? 0 : L.i0 * (1 - L.t / L.life); }
    // debris chunks
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    let w = 0;
    for (const d of this.debris) {
      d.t += dt; if (d.t > 25) continue;
      if (!d.rest) { d.vy -= 9.8 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt; d.r[0] += d.w[0] * dt; d.r[1] += d.w[1] * dt;
        if (d.y < d.s * 0.5) { d.y = d.s * 0.5; d.vy *= -0.3; d.vx *= 0.5; d.vz *= 0.5; d.w[0] *= 0.5; d.w[1] *= 0.5; if (Math.abs(d.vy) < 1) d.rest = true; } }
      m.compose(v.set(d.x, d.y, d.z), q.setFromEuler(e.set(d.r[0], d.r[1], d.r[2])), sc.set(d.s * 1.4, d.s * 0.6, d.s));
      if (w < 600) this.debrisMesh.setMatrixAt(w, m);
      this.debris[w++] = d;
    }
    this.debris.length = Math.min(w, 600); this.debrisMesh.count = this.debris.length; this.debrisMesh.instanceMatrix.needsUpdate = true;
    this.smoke.update(dt, camPos); this.glow.update(dt, null);
  }
}
