import * as THREE from 'three';
import { Flames } from './flames.js';

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
  constructor(scene, max, additive, tex, sunDir, atlas = !additive) {
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
      uniforms: { map: { value: tex }, sunDir: { value: sunDir }, fogColor: { value: new THREE.Color(0xb3b7b6) }, fogDensity: { value: 0.0021 }, ambient: { value: new THREE.Vector3(0.35, 0.36, 0.38) }, stretchK: { value: 1 }, atlas: { value: atlas ? 1 : 0 } },
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
    this.frameN = (this.frameN || 0) + 1;
    if (camPos && !this.additive && this.frameN % 2 === 0) P.sort((a, b) => ((b.x - camPos.x) ** 2 + (b.y - camPos.y) ** 2 + (b.z - camPos.z) ** 2) - ((a.x - camPos.x) ** 2 + (a.y - camPos.y) ** 2 + (a.z - camPos.z) ** 2));
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

// Tracer streaks: camera-facing ribbons a few metres long, at least ~2 px wide at any zoom, HDR-bright so bloom
// picks them up. (A single tiny glow sprite vanished at RTS camera distances.)
class Tracers {
  constructor(scene, max = 400) {
    this.max = max; this.list = [];
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 4 * 3); this.col = new Float32Array(max * 4 * 3); const uv = new Float32Array(max * 4 * 2), idx = [];
    for (let i = 0; i < max; i++) { uv.set([0, 0, 0, 1, 1, 0, 1, 1], i * 8); const o = i * 4; idx.push(o, o + 1, o + 2, o + 2, o + 1, o + 3); }
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
    const c = document.createElement('canvas'); c.width = 64; c.height = 32; const x = c.getContext('2d');
    for (let i = 0; i < 64; i++) { const along = i / 63; const gr = x.createLinearGradient(0, 0, 0, 32); const a = Math.pow(along, 0.6); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.35, `rgba(255,255,255,${a * 0.5})`); gr.addColorStop(0.5, `rgba(255,255,255,${a})`); gr.addColorStop(0.65, `rgba(255,255,255,${a * 0.5})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(i, 0, 1, 32); }
    const tex = new THREE.CanvasTexture(c);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 13; g.setDrawRange(0, 0); scene.add(this.mesh);
  }
  add(a, b, speed, color) {
    const d = new THREE.Vector3().subVectors(b, a), L = d.length(); if (L < 1) return;
    if (this.list.length >= this.max) this.list.shift();
    speed = Math.min(speed, 560); this.list.push({ a: a.clone(), dir: d.divideScalar(L), L, speed, t: 0, color, len: Math.min(5.5, 1.5 + speed * 0.006) });
  }
  update(dt, cam) {
    const tmp = new THREE.Vector3(), head = new THREE.Vector3(), tail = new THREE.Vector3(), side = new THREE.Vector3();
    this.list = this.list.filter(t => (t.t += dt) * t.speed < t.L + t.len);
    let n = 0;
    for (const t of this.list) {
      const hd = Math.min(t.L, t.t * t.speed), tl = Math.max(0, t.t * t.speed - t.len);
      if (hd - tl < 0.05) continue;
      head.copy(t.a).addScaledVector(t.dir, hd); tail.copy(t.a).addScaledVector(t.dir, Math.min(tl, hd));
      tmp.addVectors(head, tail).multiplyScalar(0.5);
      const dist = tmp.distanceTo(cam), w = Math.max(0.022, dist * 0.0011);
      side.subVectors(cam, tmp).cross(t.dir).normalize().multiplyScalar(w);
      const o = n * 12;
      this.pos.set([tail.x - side.x, tail.y - side.y, tail.z - side.z, tail.x + side.x, tail.y + side.y, tail.z + side.z, head.x - side.x, head.y - side.y, head.z - side.z, head.x + side.x, head.y + side.y, head.z + side.z], o);
      const k = 1.7, c = t.color; for (let v = 0; v < 4; v++) this.col.set([c[0] * k, c[1] * k, c[2] * k], o + v * 3);
      if (++n >= this.max) break;
    }
    const g = this.mesh.geometry; g.attributes.position.needsUpdate = true; g.attributes.color.needsUpdate = true; g.setDrawRange(0, n * 6);
  }
}

export class FX {
  constructor(scene, sunDir, quality) {
    this.tracers = new Tracers(scene);
    this.scene = scene; this.q = quality;
    const mul = quality === 'low' ? 0.5 : 1;
    this.smoke = new System(scene, Math.round(3500 * mul), false, puffAtlas(), sunDir);
    const flare = flareTex();
    this.glow = new System(scene, Math.round(2500 * mul), true, flare, sunDir);
    this.glow.additive = true;
    // billowing fire (additive, uses the puff atlas so flames have texture instead of soft blobs)
    this.fire = new System(scene, Math.round(1600 * mul), true, puffAtlas(), sunDir, true); this.fire.additive = true;
    this.flames = new Flames(scene, quality === 'low' ? 96 : 256); this.time = 0;
    // ground shockwave rings
    this.rings = [];
    const rg = new THREE.RingGeometry(0.85, 1, 48); rg.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xd8cfc0, transparent: true, opacity: 0.0, depthWrite: false });
    this.ringGeo = rg;
    this.lights = [];
    for (let i = 0; i < (quality === 'low' ? 2 : quality === 'medium' ? 3 : 4); i++) { const l = new THREE.PointLight(0xffb060, 0, 30, 2); l.castShadow = false; scene.add(l); this.lights.push({ l, t: 0, life: 0.1, i0: 0 }); }
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
    this.fire.spawn({ x: pos.x + dir.x * 0.25 * big, y: pos.y + dir.y * 0.25 * big, z: pos.z + dir.z * 0.25 * big, vx: dir.x * 6 * big, vy: dir.y * 6 * big, vz: dir.z * 6 * big, life: 0.06, size0: 0.35 * big, size1: 0.7 * big, r: 1, g: 0.7, b: 0.3, a0: 1.6, a1: 0, drag: 4 });
    this.glow.spawn({ x: pos.x, y: pos.y, z: pos.z, life: 0.05 + 0.03 * big, size0: 0.35 * big, size1: 0.6 * big, r: 1, g: 0.75, b: 0.4, a0: 2.2, a1: 0 });
    this.glow.spawn({ x: pos.x + dir.x * 0.3 * big, y: pos.y + dir.y * 0.3 * big, z: pos.z + dir.z * 0.3 * big, life: 0.05, size0: 0.25 * big, size1: 0.4 * big, r: 1, g: 0.8, b: 0.5, a0: 1.5, a1: 0 });
    this.smoke.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: dir.x * 2 * big, vy: 0.4, vz: dir.z * 2 * big, life: 0.9 + big * 0.6, size0: 0.25 * big, size1: 1.2 * big, r: 0.85, g: 0.84, b: 0.82, a0: 0.22, a1: 0, drag: 2.5, wind: this.wind });
    if (big >= 1) this.light(pos, 0xffb265, 6 * big, 6 + 6 * big, 0.06);
  }
  tracer(a, b, speed = 750, color = [1, 0.55, 0.25]) {
    this.tracers.add(a, b, speed, color);
    const d = new THREE.Vector3().subVectors(b, a); const L = d.length(); d.normalize();
    this.glow.spawn({ x: a.x, y: a.y, z: a.z, vx: d.x * speed, vy: d.y * speed, vz: d.z * speed, life: Math.max(0.02, L / speed), size0: 0.07, size1: 0.07, stretch: 6, r: color[0], g: color[1], b: color[2], a0: 5, a1: 4, drag: 0, frame: 0 });
  }
  impact(pos, kind = 'dirt', n = 1) {
    if (kind !== 'metal') for (let i = 0; i < 2 + n * 2; i++) this.smoke.spawn({ x: pos.x, y: pos.y + 0.05, z: pos.z, vx: (Math.random() - .5) * 2, vy: 3 + Math.random() * 4, vz: (Math.random() - .5) * 2, life: 0.6 + Math.random() * 0.5, size0: 0.08, size1: 0.45 * n, r: 0.42, g: 0.37, b: 0.3, a0: 0.55, a1: 0, drag: 2, grav: 6 });
    const c = kind === 'concrete' ? [0.72, 0.7, 0.66] : kind === 'metal' ? [0.6, 0.58, 0.55] : [0.5, 0.44, 0.36];
    this.smoke.spawn({ x: pos.x, y: pos.y + 0.1, z: pos.z, vx: (Math.random() - .5), vy: 1.2 + Math.random(), vz: (Math.random() - .5), life: 0.9 + Math.random() * 0.6, size0: 0.15, size1: 0.9 * n, r: c[0], g: c[1], b: c[2], a0: 0.45, a1: 0, drag: 2.2, wind: this.wind });
    if (kind === 'metal' || Math.random() < 0.3) for (let i = 0; i < 3; i++) this.glow.spawn({ x: pos.x, y: pos.y, z: pos.z, vx: (Math.random() - .5) * 8, vy: Math.random() * 5, vz: (Math.random() - .5) * 8, life: 0.15 + Math.random() * 0.2, size0: 0.03, size1: 0.02, stretch: 0.25, r: 1, g: 0.7, b: 0.3, a0: 3, a1: 0, grav: 9.8, drag: 0.5 });
  }
  blood(pos) { // muted, non-gory hit puff
    this.smoke.spawn({ x: pos.x, y: pos.y, z: pos.z, vy: 0.3, life: 0.5, size0: 0.1, size1: 0.45, r: 0.35, g: 0.12, b: 0.1, a0: 0.4, a1: 0, drag: 3 });
  }
  explosion(pos, power = 1, opts = {}) {
    const p = power, R = Math.random;
    // initial white-hot flash
    this.glow.spawn({ x: pos.x, y: pos.y + 0.6 * p, z: pos.z, life: 0.09, size0: 4 * p, size1: 9 * p, r: 1, g: 0.9, b: 0.7, a0: 3.5, a1: 0, frame: 0 });
    // textured fireball: several billowing puffs expanding and cooling from yellow to deep red
    for (let i = 0; i < 9 * p + 3; i++) this.fire.spawn({ x: pos.x + (R() - .5) * p, y: pos.y + 0.4 + R() * p, z: pos.z + (R() - .5) * p, vx: (R() - .5) * 7 * p, vy: 2 + R() * 5 * p, vz: (R() - .5) * 7 * p, life: 0.35 + R() * 0.4, size0: 1.0 * p, size1: 3.2 * p, r: 1, g: 0.75, b: 0.35, r1: 0.9, g1: 0.25, b1: 0.05, cool: 0.6, a0: 1.6, a1: 0, drag: 3.2 });
    // fragments & sparks
    for (let i = 0; i < 22 * p; i++) this.glow.spawn({ x: pos.x, y: pos.y + 0.3, z: pos.z, vx: (R() - .5) * 45, vy: R() * 28, vz: (R() - .5) * 45, life: 0.25 + R() * 0.55, size0: 0.05, size1: 0.03, stretch: 0.7, r: 1, g: 0.62, b: 0.28, a0: 3, a1: 0, grav: 9.8, drag: 0.7 });
    // dirt / masonry plume thrown up in a cone + low dust skirt racing outward
    const dust = opts.dust ?? [0.55, 0.49, 0.41];
    for (let i = 0; i < 10 * p; i++) this.smoke.spawn({ x: pos.x + (R() - .5) * p, y: pos.y + 0.5, z: pos.z + (R() - .5) * p, vx: (R() - .5) * 5, vy: 6 + R() * 10 * Math.sqrt(p), vz: (R() - .5) * 5, life: 2.5 + R() * 2.5, size0: 0.8 * p, size1: 4.2 * p, r: dust[0] * 0.85, g: dust[1] * 0.85, b: dust[2] * 0.85, a0: 0.6, a1: 0, drag: 1.6, grav: 2.5, wind: this.wind });
    for (let i = 0; i < 12 * p; i++) { const a = R() * 6.28, sp = 5 + R() * 6; this.smoke.spawn({ x: pos.x, y: 0.4, z: pos.z, vx: Math.cos(a) * sp * Math.sqrt(p), vy: 0.3 + R(), vz: Math.sin(a) * sp * Math.sqrt(p), life: 2 + R() * 2, size0: 0.8 * p, size1: 3.4 * p, r: dust[0], g: dust[1], b: dust[2], a0: 0.45, a1: 0, drag: 2.4, wind: this.wind }); }
    // black smoke column
    for (let i = 0; i < 6 * p; i++) this.smoke.spawn({ x: pos.x + (R() - .5) * p, y: pos.y + 0.6 + R() * 1.5 * p, z: pos.z + (R() - .5) * p, vx: (R() - .5) * 2, vy: 3 + R() * 4 * Math.sqrt(p), vz: (R() - .5) * 2, life: 3.5 + R() * 3, size0: 1.2 * p, size1: 5 * p, r: 0.13, g: 0.12, b: 0.11, a0: 0.75, a1: 0, drag: 1.1, wind: this.wind, fadeIn: 0.12 });
    // shockwave ring on the ground
    if (pos.y < 2) { const m = new THREE.Mesh(this.ringGeo, this.ringMat.clone()); m.position.set(pos.x, 0.25, pos.z); m.renderOrder = 4; this.scene.add(m); this.rings.push({ m, t: 0, life: 0.45, r: 9 * p }); }
    // chunks
    for (let i = 0; i < Math.round(8 * p); i++) this.debris.push({ x: pos.x, y: pos.y + 0.4, z: pos.z, vx: (R() - .5) * 18 * p, vy: 6 + R() * 14 * p, vz: (R() - .5) * 18 * p, s: 0.08 + R() * 0.25 * p, r: [R() * 6, R() * 6, R() * 6], w: [(R() - .5) * 15, (R() - .5) * 15], t: 0, rest: false });
    this.light(new THREE.Vector3(pos.x, pos.y + 2, pos.z), 0xff9a4a, 70 * p, 26 * p, 0.3);
  }
  collapseDust(pos, w, d, h) {
    const R = Math.random;
    for (let i = 0; i < 70; i++) this.smoke.spawn({ x: pos.x + (R() - .5) * w, y: R() * h, z: pos.z + (R() - .5) * d, vx: (R() - .5) * 6, vy: -1 + R() * 2.5, vz: (R() - .5) * 6, life: 9 + R() * 8, size0: 4, size1: 16 + R() * 10, r: 0.7, g: 0.67, b: 0.62, a0: 0.65, a1: 0, drag: 0.5, wind: this.wind, fadeIn: 0.4 });
    for (let i = 0; i < 40; i++) { const a = R() * 6.28, sp = 8 + R() * 10; this.smoke.spawn({ x: pos.x, y: 1, z: pos.z, vx: Math.cos(a) * sp, vy: 0.5, vz: Math.sin(a) * sp, life: 7 + R() * 5, size0: 4, size1: 14, r: 0.68, g: 0.65, b: 0.6, a0: 0.55, a1: 0, drag: 0.9, wind: this.wind }); }
    for (let i = 0; i < 40; i++) this.debris.push({ x: pos.x + (R() - .5) * w, y: R() * h, z: pos.z + (R() - .5) * d, vx: (R() - .5) * 8, vy: R() * 4, vz: (R() - .5) * 8, s: 0.3 + R() * 0.8, r: [R() * 6, R() * 6, R() * 6], w: [(R() - .5) * 6, (R() - .5) * 6], t: 0, rest: false });
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
  emitter(pos, kind, scale = 1, life = Infinity, attach = null) { const e = { pos: pos.clone(), kind, scale, acc: 0, life, t: 0, attach }; if (kind === 'fire') e.flame = this.flames.add(pos, scale); this.emitters.push(e); return e; }
  // move an emitter whose support is gone down onto the rubble
  drop(e, y = 0.4) {
    if (e.dropped) return; e.dropped = true; e.attach = null; e.pos.y = y;
    if (e.flame) { e.flame.dead = true; e.scale *= 0.85; e.flame = this.flames.add(e.pos, e.scale); }
    if (e.life === Infinity) e.life = e.t + 60 + Math.random() * 60;
  }
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
        if (e.flame) e.flame.intensity = Math.min(1, fade * 1.5);
        while (e.acc > 0.06) { e.acc -= 0.06;
          // a little textured fire at the base for volume, embers, and a thick smoke column
          if (Math.random() < 0.5) this.fire.spawn({ x: e.pos.x + (Math.random() - .5) * s, y: e.pos.y + Math.random() * 0.3, z: e.pos.z + (Math.random() - .5) * s, vx: 0, vy: 1.4 + Math.random(), vz: 0, life: 0.45 + Math.random() * 0.3, size0: 1.0 * s, size1: 0.5 * s, r: 1, g: 0.5, b: 0.15, r1: 0.8, g1: 0.18, b1: 0.03, cool: 0.7, a0: 0.55 * fade, a1: 0, drag: 0.6 });
          if (Math.random() < 0.35) this.glow.spawn({ x: e.pos.x + (Math.random() - .5) * s, y: e.pos.y + 0.6 * s, z: e.pos.z + (Math.random() - .5) * s, vx: (Math.random() - .5) * 1.5, vy: 2.5 + Math.random() * 3, vz: (Math.random() - .5) * 1.5, life: 1.2 + Math.random() * 1.6, size0: 0.05, size1: 0.03, r: 1, g: 0.55, b: 0.18, a0: 2.2 * fade, a1: 0, drag: 0.4, wind: this.wind });
          if (Math.random() < 0.6) this.smoke.spawn({ x: e.pos.x + (Math.random() - .5) * 0.6 * s, y: e.pos.y + 2.2 * s, z: e.pos.z + (Math.random() - .5) * 0.6 * s, vx: (Math.random() - .5), vy: 3 + Math.random() * 2.5, vz: (Math.random() - .5), life: 11 + Math.random() * 7, size0: 1.2 * s, size1: 8.5 * s, r: 0.085, g: 0.08, b: 0.075, a0: 0.7 * fade, a1: 0, drag: 0.3, wind: this.wind, fadeIn: 0.5 });
        }
        if (Math.random() < 0.12) this.light(new THREE.Vector3(e.pos.x, e.pos.y + 1.5 * s, e.pos.z), 0xff7a2a, 9 * s * fade, 14 * s, 0.25);
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
    for (const r of this.rings) { r.t += dt; const f = r.t / r.life; r.m.scale.setScalar(0.5 + f * r.r); r.m.material.opacity = 0.35 * (1 - f); if (f >= 1) { this.scene.remove(r.m); r.m.material.dispose(); r.dead = true; } }
    this.rings = this.rings.filter(r => !r.dead);
    this.time += dt; this.flames.update(dt, this.time); if (camPos) this.tracers.update(dt, camPos);
    this.smoke.update(dt, camPos); this.glow.update(dt, null); this.fire.update(dt, null);
  }
}
