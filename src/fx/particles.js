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

const byDepth = (a, b) => b.d2 - a.d2;
const mulberry = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
class Particle { constructor() { this.x = 0; this.y = 0; this.z = 0; this.vx = 0; this.vy = 0; this.vz = 0; this.life = 0; this.t = 0; this.size0 = 0; this.size1 = 0; this.r = 0; this.g = 0; this.b = 0; this.a0 = 0; this.a1 = 0; this.drag = 0; this.grav = 0; this.rot = 0; this.rotv = 0; this.frame = 0; this.stretch = 0; this.wind = null; this.fadeIn = 0; this.cool = 0; this.r1 = 0; this.g1 = 0; this.b1 = 0; this.d2 = 0; } }
class System {
  constructor(scene, max, additive, tex, sunDir, atlas = !additive) {
    this.max = max; this.n = 0; this.p = []; this.free = [];
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
  // o: {x,y,z, vx,vy,vz, life, size0, size1, r,g,b, a0,a1, drag, grav, rot, rotv, frame, stretch, wind, fadeIn, cool, r1,g1,b1}
  // The spawn sites pass object literals of many different shapes; the update loops over thousands of them every frame
  // then ran on megamorphic property access. Each particle is copied into one fixed-shape object (recycled from a free
  // list, no garbage per spawn) - same values, same defaults.
  spawn(o) {
    // full: the oldest-sorted (= farthest, after the back-to-front sort) particles make room. Dropped in one splice in
    // update() instead of an O(n) shift() per spawn (a busy fight spawns hundreds per frame into a full system)
    if (this.p.length >= this.max) this.over = (this.over || 0) + 1;
    const q = this.free.pop() || new Particle();
    q.x = o.x; q.y = o.y; q.z = o.z; q.vx = o.vx ?? 0; q.vy = o.vy ?? 0; q.vz = o.vz ?? 0;
    q.life = o.life; q.t = 0; q.size0 = o.size0; q.size1 = o.size1 ?? o.size0;
    q.r = o.r; q.g = o.g; q.b = o.b; q.a0 = o.a0; q.a1 = o.a1 ?? 0;
    q.drag = o.drag ?? 0.5; q.grav = o.grav ?? 0; q.rot = o.rot ?? Math.random() * 6.28; q.rotv = o.rotv ?? (Math.random() - .5) * 0.6;
    q.frame = o.frame ?? Math.floor(Math.random() * 4); q.stretch = o.stretch ?? 0; q.wind = o.wind || null; q.fadeIn = o.fadeIn || 0;
    q.cool = o.cool || 0; q.r1 = o.r1 ?? o.r; q.g1 = o.g1 ?? o.g; q.b1 = o.b1 ?? o.b; q.d2 = 0;
    this.p.push(q);
  }
  update(dt, camPos) {
    const P = this.p; let w = 0;
    if (this.over) { const gone = P.splice(0, Math.min(this.over, P.length - this.max)); this.over = 0; if (this.free.length < this.max) this.free.push(...gone); }
    // (drag: exp() once per distinct drag value and frame, not per particle; Math.hypot is slow in V8: plain sqrt)
    let lastDrag = NaN, k = 1;
    const sort = camPos && !this.additive && (this.frameN = (this.frameN || 0) + 1) % 2 === 0, cx = camPos?.x, cy = camPos?.y, cz = camPos?.z;
    for (let i = 0; i < P.length; i++) {
      const o = P[i]; o.t += dt; if (o.t >= o.life) { if (this.free.length < this.max) this.free.push(o); continue; }
      if (o.drag !== lastDrag) { lastDrag = o.drag; k = Math.exp(-lastDrag * dt); }
      o.vx *= k; o.vy = o.vy * k - o.grav * dt; o.vz *= k;
      if (o.wind) { o.vx += o.wind[0] * dt; o.vz += o.wind[1] * dt; }
      o.x += o.vx * dt; o.y += o.vy * dt; o.z += o.vz * dt; o.rot += o.rotv * dt;
      if (o.y < 0.05 && o.grav > 0) { o.y = 0.05; o.vy *= -0.25; o.vx *= 0.5; o.vz *= 0.5; }
      if (sort) { const dx = o.x - cx, dy = o.y - cy, dz = o.z - cz; o.d2 = dx * dx + dy * dy + dz * dz; }
      P[w++] = o;
    }
    P.length = w;
    // sort back-to-front for alpha systems (key computed once per particle above, not twice per comparison)
    if (sort) P.sort(byDepth);
    const pos = this.aPos.array, col = this.aCol.array, misc = this.aMisc.array, vel = this.aVel.array;
    for (let i = 0; i < P.length; i++) {
      const o = P[i], f = o.t / o.life, ease = 1 - (1 - f) * (1 - f), i3 = i * 3, i4 = i * 4;
      pos[i3] = o.x; pos[i3 + 1] = o.y; pos[i3 + 2] = o.z;
      const fadeIn = o.fadeIn ? Math.min(1, o.t / o.fadeIn) : 1;
      if (o.cool) { const cf = Math.min(1, f / o.cool); col[i4] = o.r + (o.r1 - o.r) * cf; col[i4 + 1] = o.g + (o.g1 - o.g) * cf; col[i4 + 2] = o.b + (o.b1 - o.b) * cf; }
      else { col[i4] = o.r; col[i4 + 1] = o.g; col[i4 + 2] = o.b; }
      col[i4 + 3] = (o.a0 + (o.a1 - o.a0) * f) * fadeIn;
      misc[i4] = o.size0 + (o.size1 - o.size0) * ease; misc[i4 + 1] = o.rot; misc[i4 + 2] = o.frame; misc[i4 + 3] = o.stretch;
      if (o.stretch) { const sp = Math.sqrt(o.vx * o.vx + o.vy * o.vy + o.vz * o.vz) || 1; vel[i3] = o.vx / sp; vel[i3 + 1] = o.vy / sp; vel[i3 + 2] = o.vz / sp; }
      else { vel[i3] = 0; vel[i3 + 1] = 0; vel[i3 + 2] = 0; }
    }
    this.geo.instanceCount = P.length;
    // upload only the live part of the instance buffers (they are sized for the cap: 3500 x 14 floats for smoke)
    for (const a of this.attrs ||= [this.aPos, this.aCol, this.aMisc, this.aVel]) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, P.length) * a.itemSize); a.needsUpdate = true; }
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
    const tmp = this._t ||= new THREE.Vector3(), head = this._h ||= new THREE.Vector3(), tail = this._l ||= new THREE.Vector3(), side = this._s ||= new THREE.Vector3();
    const L = this.list; let w = 0;
    for (let i = 0; i < L.length; i++) { const t = L[i]; if ((t.t += dt) * t.speed < t.L + t.len) L[w++] = t; }
    L.length = w;
    let n = 0; const P = this.pos, C = this.col;
    for (const t of L) {
      const hd = Math.min(t.L, t.t * t.speed), tl = Math.max(0, t.t * t.speed - t.len);
      if (hd - tl < 0.05) continue;
      head.copy(t.a).addScaledVector(t.dir, hd); tail.copy(t.a).addScaledVector(t.dir, Math.min(tl, hd));
      tmp.addVectors(head, tail).multiplyScalar(0.5);
      const dist = tmp.distanceTo(cam), wd = Math.max(0.022, dist * 0.0011);
      side.subVectors(cam, tmp).cross(t.dir).normalize().multiplyScalar(wd);
      const o = n * 12;
      P[o] = tail.x - side.x; P[o + 1] = tail.y - side.y; P[o + 2] = tail.z - side.z; P[o + 3] = tail.x + side.x; P[o + 4] = tail.y + side.y; P[o + 5] = tail.z + side.z;
      P[o + 6] = head.x - side.x; P[o + 7] = head.y - side.y; P[o + 8] = head.z - side.z; P[o + 9] = head.x + side.x; P[o + 10] = head.y + side.y; P[o + 11] = head.z + side.z;
      const k = 1.7, c = t.color; for (let v = 0; v < 4; v++) { C[o + v * 3] = c[0] * k; C[o + v * 3 + 1] = c[1] * k; C[o + v * 3 + 2] = c[2] * k; }
      if (++n >= this.max) break;
    }
    const g = this.mesh.geometry, pa = g.attributes.position, ca = g.attributes.color;
    if (n || this._n) { for (const a of [pa, ca]) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, n) * 12); a.needsUpdate = true; } }
    this._n = n; g.setDrawRange(0, n * 6);
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
    this.flames = new Flames(scene, quality === 'low' ? 96 : 256); this.time = 0; this._lp = new THREE.Vector3();
    this.later = [];   // delayed puffs (fragments striking the ground after a burst)
    this.lights = [];
    for (let i = 0; i < (quality === 'low' ? 2 : quality === 'medium' ? 3 : 4); i++) { const l = new THREE.PointLight(0xffb060, 0, 30, 2); l.castShadow = false; scene.add(l); this.lights.push({ l, t: 0, life: 0.1, i0: 0 }); }
    this.emitters = []; this.wind = [0.9, 0.35];
    // thrown fragments, by kind (one InstancedMesh each, irregular low-poly shapes instead of the old unit cubes):
    // shard = steel splinters from the casing (a few cm, elongated, dark metal), clod = earth thrown up by a ground burst,
    // chunk = concrete / brick lumps from a collapsing section
    const lump = (detail, k, seed) => { const g = new THREE.IcosahedronGeometry(1, detail), p = g.attributes.position, r = mulberry(seed);
      const m = new Map(); for (let i = 0; i < p.count; i++) { const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`; if (!m.has(key)) m.set(key, 1 - k + r() * k * 2); const f = m.get(key); p.setXYZ(i, p.getX(i) * f, p.getY(i) * f, p.getZ(i) * f); }
      g.computeVertexNormals(); return g; };
    const shardGeo = (() => { const g = new THREE.OctahedronGeometry(1, 0), p = g.attributes.position, r = mulberry(5), m = new Map();
      for (let i = 0; i < p.count; i++) { const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`; if (!m.has(key)) m.set(key, [(r() - .5) * 0.5, (r() - .5) * 0.5]); const [a, b] = m.get(key); p.setXYZ(i, p.getX(i) * 0.5 + a * 0.2, p.getY(i) * 0.16 + b * 0.06, p.getZ(i) * 0.09 + a * 0.04); }
      g.computeVertexNormals(); return g; })();   // a thin twisted splinter, 1 m long at scale 1
    const kind = (geo, mat, cap, shadow) => { const mesh = new THREE.InstancedMesh(geo, mat, cap); mesh.count = 0; mesh.castShadow = shadow; mesh.receiveShadow = shadow; mesh.frustumCulled = false; scene.add(mesh); return { mesh, cap, list: [] }; };
    this.frag = {
      shard: kind(shardGeo, new THREE.MeshStandardMaterial({ color: 0x2c2a27, roughness: 0.45, metalness: 0.7, flatShading: true }), 500, false),
      clod: kind(lump(0, 0.35, 9), new THREE.MeshStandardMaterial({ color: 0x4a3f32, roughness: 1, flatShading: true }), 500, false),
      chunk: kind(lump(1, 0.3, 13), new THREE.MeshStandardMaterial({ color: 0x77716a, roughness: 1, flatShading: true }), 300, true),
    };
    this.debris = this.frag.chunk.list;   // (legacy name)
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
  // HE burst. What a shell / mortar bomb / shaped charge looks like on the ground (2022-24 footage): a flash of a few hundredths
  // of a second, at once swallowed by a black-brown cloud of detonation products and soil; earth thrown up in separate jets
  // (the spiky 'crown'), falling back within ~2 s; dust swept low along the ground by the blast; a dark column that rises,
  // slows and leans with the wind, thinning to a grey haze over 10-15 s. No lingering orange fireball (that is fuel, not HE)
  // and no visible ring: the shock front shows only as the dust it lifts.
  explosion(pos, power = 1, opts = {}) {
    const p = power, R = Math.random, sp = Math.sqrt(p), S = this.smoke, W = this.wind;
    const k = (this.q === 'low' ? 0.6 : 1) * Math.min(2.2, 0.45 + 0.55 * p), N = n => Math.max(1, Math.round(n * k));   // (particle budget: sub-linear in the charge)
    const ground = pos.y < 2;
    this.onBlast?.(pos, power);   // shelled trees (world/treeDamage.js): leaves, splinters, stumps
    // (the puff shader lights particles at ~1.2x their colour while the sunlit ground sits near 0.3: smoke and thrown earth must be
    // well below that to read dark against it, and dust only a little above)
    const dust = opts.dust ?? [0.55, 0.49, 0.41], soil = [dust[0] * 0.25, dust[1] * 0.235, dust[2] * 0.22], pale = [dust[0] * 0.62, dust[1] * 0.62, dust[2] * 0.62];
    // detonation flash (white-yellow, 2-3 frames) and the short fireball inside the cloud
    for (let i = 0; i < 2; i++) this.fire.spawn({ x: pos.x + (R() - .5) * 0.5 * p, y: pos.y + (0.35 + R() * 0.5) * p, z: pos.z + (R() - .5) * 0.5 * p, life: 0.055 + R() * 0.04, size0: (1.1 + R() * 0.4) * p, size1: (2.6 + R() * 0.8) * p, r: 1, g: 0.94, b: 0.8, a0: 1.5, a1: 0 });
    for (let i = 0; i < N(5); i++) this.fire.spawn({ x: pos.x + (R() - .5) * 0.8 * p, y: pos.y + 0.3 + R() * 0.8 * p, z: pos.z + (R() - .5) * 0.8 * p, vx: (R() - .5) * 6 * p, vy: 1.5 + R() * 4 * p, vz: (R() - .5) * 6 * p, life: 0.11 + R() * 0.13, size0: 0.8 * p, size1: 2.4 * p, r: 1, g: 0.74, b: 0.36, r1: 0.7, g1: 0.2, b1: 0.04, cool: 0.7, a0: 1.3, a1: 0, drag: 4.5 });
    // the burst cloud: detonation products + pulverised soil. Out fast in every direction and stalled within a few metres: a
    // short-lived layer that swells at once (the puff itself), and the same mass lingering, thinning and drifting
    // (the puff texture is opaque only in its inner half: sizes are about twice the visible lump; brown-black, not neutral)
    const dark = (d, m) => [d * 1.45 + soil[0] * m, d * 1.02 + soil[1] * m * 0.92, d * 0.72 + soil[2] * m * 0.8];   // (warm: a thin neutral dark takes the green of the field behind it)
    for (let i = 0; i < N(7); i++) { const a = R() * 6.283, e = ground ? R() * 1.3 : (R() - .35) * 2.2, v = (9 + R() * 10) * sp, c = Math.cos(e), q = dark(0.05 + R() * 0.04, R() * 0.5);
      S.spawn({ x: pos.x, y: pos.y + 0.4 * p, z: pos.z, vx: Math.cos(a) * c * v, vy: Math.max(0, Math.sin(e)) * v + 1, vz: Math.sin(a) * c * v, life: 0.9 + R() * 0.8, size0: 1.6 * p, size1: (5.5 + R() * 1.5) * p, r: q[0], g: q[1], b: q[2], a0: 1.7, a1: 0, drag: 5, wind: W, fadeIn: 0.03 }); }
    for (let i = 0; i < N(7); i++) { const a = R() * 6.283, e = ground ? R() * 1.35 : (R() - .35) * 2.2, v = (6 + R() * 8) * sp, c = Math.cos(e), q = dark(0.055 + R() * 0.045, R() * 0.45);
      S.spawn({ x: pos.x, y: pos.y + 0.4 * p, z: pos.z, vx: Math.cos(a) * c * v, vy: Math.max(0, Math.sin(e)) * v + 1.2, vz: Math.sin(a) * c * v, life: 6 + R() * 5, size0: 2.2 * p, size1: (6.5 + R() * 2.5) * p, r: q[0], g: q[1], b: q[2], a0: 1.5, a1: 0, drag: 4.4, grav: -1.4, wind: W, fadeIn: 0.05 }); }
    // the column: hot smoke carrying dust up, slowing, leaning with the wind
    for (let i = 0; i < N(7); i++) { const q = dark(0.06 + R() * 0.05, 0.3 + R() * 0.9);
      S.spawn({ x: pos.x + (R() - .5) * 0.8 * p, y: pos.y + 0.6 + R() * 1.4 * p, z: pos.z + (R() - .5) * 0.8 * p, vx: (R() - .5) * 1.6, vy: (4 + R() * 6.5) * sp, vz: (R() - .5) * 1.6, life: 6 + R() * 5, size0: 2 * p, size1: (6.5 + R() * 3) * p, r: q[0], g: q[1], b: q[2], a0: 1.6, a1: 0, drag: 1.3, wind: W, fadeIn: 0.1 }); }
    if (ground) {
      // earth thrown up in separate jets: each a string of clots, the fastest leading, falling back
      const nj = N(7);
      for (let j = 0; j < nj; j++) { const a = (j + R()) / nj * 6.283, e = 0.75 + R() * 0.6, v = (12 + R() * 10) * sp, cx = Math.cos(a) * Math.cos(e), cy = Math.sin(e), cz = Math.sin(a) * Math.cos(e);
        for (let i = 0; i < 6; i++) { const f = 1 - i * 0.14 + R() * 0.05, t = 0.85 + R() * 0.3;
          S.spawn({ x: pos.x + cx * 0.4 * p, y: 0.3, z: pos.z + cz * 0.4 * p, vx: cx * v * f, vy: cy * v * f, vz: cz * v * f, life: 1.1 + R() * 0.9, size0: (0.45 + 0.14 * i) * p, size1: (1.3 + 0.42 * i) * p, r: soil[0] * t, g: soil[1] * t, b: soil[2] * t, a0: 1.6, a1: 0, drag: 0.9, grav: 9.8, fadeIn: 0.03 }); } }
      // dust swept along the ground by the blast: races out and stalls (this is all there is to see of the shock front)
      for (let i = 0; i < N(18); i++) { const a = R() * 6.283, v = (12 + R() * 18) * sp;
        S.spawn({ x: pos.x + Math.cos(a) * 0.6 * p, y: 0.22 + R() * 0.25, z: pos.z + Math.sin(a) * 0.6 * p, vx: Math.cos(a) * v, vy: 0.2 + R() * 0.7, vz: Math.sin(a) * v, life: 1.5 + R() * 1.6, size0: 1.4 * p, size1: (3.4 + R() * 1.4) * p, r: pale[0], g: pale[1], b: pale[2], a0: 0.45, a1: 0, drag: 4.2, wind: W, fadeIn: 0.05 }); }
      // fragments striking the ground round the burst a moment later
      for (let i = 0; i < N(5); i++) { const a = R() * 6.283, d = (3 + R() * 8) * sp; this.later.push({ t: 0.05 + d / 60 + R() * 0.12, x: pos.x + Math.cos(a) * d, z: pos.z + Math.sin(a) * d }); }
    } else for (let i = 0; i < N(5); i++) S.spawn({ x: pos.x + (R() - .5) * p, y: pos.y + (R() - .5) * p, z: pos.z + (R() - .5) * p, vx: (R() - .5) * 5, vy: R() * 2, vz: (R() - .5) * 5, life: 2.2 + R() * 2, size0: 0.6 * p, size1: 2.6 * p, r: pale[0], g: pale[1], b: pale[2], a0: 0.5, a1: 0, drag: 2.2, grav: 1.2, wind: W });   // (burst on a wall / hull: dust shaken off, sinking)
    // thin grey haze left hanging over the place
    for (let i = 0; i < N(3); i++) S.spawn({ x: pos.x + (R() - .5) * 2 * p, y: pos.y + 0.8 + R() * 1.5 * p, z: pos.z + (R() - .5) * 2 * p, vx: (R() - .5) * 0.8, vy: 0.35 + R() * 0.5, vz: (R() - .5) * 0.8, life: 10 + R() * 6, size0: 3.5 * p, size1: (9 + R() * 3) * p, r: 0.25, g: 0.235, b: 0.22, a0: 0.42, a1: 0, drag: 0.5, wind: W, fadeIn: 1.4 });
    // a few glowing fragments (hardly seen by day)
    for (let i = 0; i < N(7); i++) this.glow.spawn({ x: pos.x, y: pos.y + 0.3, z: pos.z, vx: (R() - .5) * 46, vy: R() * 26, vz: (R() - .5) * 46, life: 0.18 + R() * 0.32, size0: 0.045, size1: 0.025, stretch: 0.6, r: 1, g: 0.62, b: 0.28, a0: 2.6, a1: 0, grav: 9.8, drag: 0.7 });
    // fragments, scaled by the charge: casing splinters (2-8 cm, fast, mostly low and flat out), earth clods from a ground
    // burst (3-12 cm)
    for (let i = 0; i < Math.round(10 * p); i++) { const a = R() * 6.28, v = (12 + R() * 22) * sp; this.fragment('shard', pos.x, pos.y + 0.3, pos.z, Math.cos(a) * v, 2 + R() * 9 * sp, Math.sin(a) * v, (0.02 + R() * 0.06) * Math.min(1.6, sp)); }
    if (ground) for (let i = 0; i < Math.round(9 * p); i++) { const a = R() * 6.28, v = (2 + R() * 7) * sp; this.fragment('clod', pos.x + (R() - .5) * p, pos.y + 0.3, pos.z + (R() - .5) * p, Math.cos(a) * v, (5 + R() * 9) * sp, Math.sin(a) * v, (0.03 + R() * 0.09) * Math.min(1.5, sp)); }
    this.light(new THREE.Vector3(pos.x, pos.y + 1.6, pos.z), 0xffbe78, 85 * p, 28 * p, 0.15);
  }
  collapseDust(pos, w, d, h) {
    const R = Math.random;
    for (let i = 0; i < 70; i++) this.smoke.spawn({ x: pos.x + (R() - .5) * w, y: R() * h, z: pos.z + (R() - .5) * d, vx: (R() - .5) * 6, vy: -1 + R() * 2.5, vz: (R() - .5) * 6, life: 9 + R() * 8, size0: 4, size1: 16 + R() * 10, r: 0.7, g: 0.67, b: 0.62, a0: 0.65, a1: 0, drag: 0.5, wind: this.wind, fadeIn: 0.4 });
    for (let i = 0; i < 40; i++) { const a = R() * 6.28, sp = 8 + R() * 10; this.smoke.spawn({ x: pos.x, y: 1, z: pos.z, vx: Math.cos(a) * sp, vy: 0.5, vz: Math.sin(a) * sp, life: 7 + R() * 5, size0: 4, size1: 14, r: 0.68, g: 0.65, b: 0.6, a0: 0.55, a1: 0, drag: 0.9, wind: this.wind }); }
    for (let i = 0; i < 40; i++) this.fragment('chunk', pos.x + (R() - .5) * w, R() * h, pos.z + (R() - .5) * d, (R() - .5) * 8, R() * 4, (R() - .5) * 8, 0.18 + R() * 0.5);
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
  // persistent emitters: fire (burning building / ground fire), plume (distant columns), smoulder
  emitter(pos, kind, scale = 1, life = Infinity, attach = null) { const e = { pos: pos.clone(), kind, scale, acc: 0, acc2: 0, acc3: 0, life, t: 0, attach }; if (kind === 'fire') e.flame = this.flames.add(e.pos, scale); this.emitters.push(e); return e; }
  // a burning vehicle (vehicle.js fireFx). Not a recorded net event: the vehicle drives it on the host and the versus joiner
  // alike. e.pos follows the engine deck; the vehicle sets e.target (0..1, power eases toward it), e.white (0..1: grey-white
  // smoke while the crew fights the fire), e.cook (seconds of ammunition cook-off jet left) and e.kill (burn down and go);
  // fireVent adds flames out of an open hatch / the turret ring
  vehFire(pos, scale) { const e = { pos: pos.clone(), kind: 'vfire', scale, acc: 0, acc2: 0, acc3: 0, life: Infinity, t: 0, power: 0, target: 0.5, white: 0, vents: [], cook: 0, jet: null }; e.flame = this.flames.add(e.pos, scale, { n: 3 }); e.flame.intensity = 0; this.emitters.push(e); return e; }
  fireVent(e, pos, scale, jet = false) { const f = this.flames.add(pos.clone(), scale, { n: jet ? 2 : 1, kind: jet ? 1 : 0 }); f.intensity = 0; if (jet) e.jet = f; else e.vents.push(f); return f; }
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
  // one thrown fragment (kind: shard | clod | chunk; s = size in m)
  fragment(kind, x, y, z, vx, vy, vz, s) {
    const K = this.frag[kind], L = K.list, R = Math.random; if (L.length >= K.cap) L.shift();
    L.push({ x, y, z, vx, vy, vz, s, ax: kind === 'shard' ? 1 : 0.8 + R() * 0.5, az: kind === 'shard' ? 1 : 0.7 + R() * 0.5, drag: kind === 'shard' ? 0.25 : 0.1,
      r0: R() * 6.28, r1: R() * 6.28, r2: R() * 6.28, w0: (R() - .5) * (kind === 'shard' ? 40 : 14), w1: (R() - .5) * (kind === 'shard' ? 40 : 14), t: 0, rest: false });
  }
  update(dt, camPos) {
    // fires (v2): flames are the instanced shader tongues (flames.js); the particles only add the smoke column and, near the
    // camera, a little billowing fire at the base and embers. Per fire about half the smoke puffs of v1 (bigger, denser ones,
    // underlit orange by the flames for their first second), fewer still far off or when the smoke system is filling up;
    // one flickering light for the nearest big fire instead of every fire grabbing a pooled light at random
    const R = Math.random, E = this.emitters, cx = camPos ? camPos.x : 0, cz = camPos ? camPos.z : 0;
    const load = this.smoke.p.length / this.smoke.max, thin = load > 0.85 ? 3 : load > 0.65 ? 1.7 : 1;
    let lit = null, litD = 150, w = 0;
    for (let i = 0; i < E.length; i++) {
      const e = E[i]; e.t += dt;
      if (e.dead || e.t > e.life) { e.dead = true; if (e.flame) e.flame.dead = true; if (e.vents) { for (const f of e.vents) f.dead = true; if (e.jet) e.jet.dead = true; } continue; }
      E[w++] = e;
      e.acc += dt; const s = e.scale, fade = e.life < Infinity ? Math.max(0, 1 - e.t / e.life) : 1;
      if (e.kind === 'fire' || e.kind === 'vfire') {
        const veh = e.kind === 'vfire', d = camPos ? Math.hypot(e.pos.x - cx, e.pos.z - cz) : 0;
        let p;
        if (veh) { const tg = e.kill ? 0 : e.target * Math.min(1, fade * 3); e.power += Math.max(-dt * 0.35, Math.min(dt * 0.5, tg - e.power)); p = e.power; if (e.kill && p < 0.02) e.life = 0; }
        else p = Math.min(1, fade * 1.5);
        if (e.flame) e.flame.intensity = p;
        if (veh) {
          for (const f of e.vents) f.intensity = p * 0.85;
          if (e.jet) { e.jet.intensity = e.cook > 0 ? Math.min(1, e.cook / 1.5) * (0.8 + 0.4 * R()) : 0;
            if (e.cook > 0) { e.cook -= dt; const J = e.jet.anchor;   // burning propellant: a roaring jet throwing sparks
              if (d < 450 && R() < dt * 9) for (let k = 0; k < 2; k++) this.glow.spawn({ x: J.x, y: J.y + 0.6, z: J.z, vx: (R() - .5) * 10, vy: 7 + R() * 10, vz: (R() - .5) * 10, life: 0.5 + R() * 0.8, size0: 0.07, size1: 0.04, stretch: 0.5, r: 1, g: 0.75, b: 0.4, a0: 3, a1: 0, grav: 9.8, drag: 0.4 }); } }
        }
        // smoke: diesel / ammunition fire = dense black, a crew fighting it = grey-white, a building = dark brown-grey. Two layers: a
        // dense core of small puffs boiling off the flames (short-lived, underlit orange by the fire for their first moment) and a few
        // big long-lived puffs carrying the column up and downwind (v1: ~140 uniform big puffs per fire)
        const far = d > 320, k = thin / Math.max(0.35, p), wh = veh ? e.white : 0, c = veh ? 0.05 + wh * 0.45 : 0.1, y0 = e.pos.y + (veh ? 0.9 : 1.3) * s * Math.max(0.4, p);
        e.acc2 = (e.acc2 || 0) + dt;   // (core)
        const ivc = (veh ? 0.12 : 0.18) * k * (far ? 2.5 : 1);
        while (e.acc2 > ivc) { e.acc2 -= ivc;
          this.smoke.spawn({ x: e.pos.x + (R() - .5) * 0.6 * s, y: y0, z: e.pos.z + (R() - .5) * 0.6 * s, vx: (R() - .5) * 0.6, vy: 2.8 + R() * 1.8 * p, vz: (R() - .5) * 0.6,
            life: 3 + R() * 1.5, size0: 0.9 * s, size1: (3 + R()) * s, r: 0.55 * p + c, g: 0.22 * p + c, b: 0.06 * p + c, r1: c, g1: c * 0.95, b1: c * 0.9, cool: 0.25,
            a0: 0.95 * Math.min(1, p + 0.3), a1: 0, drag: 0.5, wind: this.wind, fadeIn: 0.2 });
        }
        const iv = (veh ? 0.42 : 0.6) * k * (far ? 1.6 : 1), big = far ? 1.25 : 1;
        while (e.acc > iv) { e.acc -= iv;
          this.smoke.spawn({ x: e.pos.x + (R() - .5) * 0.8 * s, y: y0 + 2.5 * s, z: e.pos.z + (R() - .5) * 0.8 * s, vx: (R() - .5) * 0.8, vy: 3 + R() * 1.5 * p, vz: (R() - .5) * 0.8,
            life: (veh ? 13 : 11) + R() * 4, size0: 2.2 * s * big, size1: (veh ? 9.5 + R() * 2 : 8 + R() * 2) * s * big, r: c, g: c * 0.95, b: c * 0.9,
            a0: 0.75 * Math.min(1, p + 0.3), a1: 0, drag: 0.3, wind: this.wind, fadeIn: 0.8 });
        }
        if (d < 160 && p > 0.05) {   // close up: billowing fire at the base, embers
          e.acc3 = (e.acc3 || 0) + dt;
          while (e.acc3 > 0.14) { e.acc3 -= 0.14;
            this.fire.spawn({ x: e.pos.x + (R() - .5) * s, y: e.pos.y + R() * 0.3, z: e.pos.z + (R() - .5) * s, vx: 0, vy: 1.4 + R(), vz: 0, life: 0.45 + R() * 0.3, size0: 1.0 * s, size1: 0.5 * s, r: 1, g: 0.5, b: 0.15, r1: 0.8, g1: 0.18, b1: 0.03, cool: 0.7, a0: 0.5 * p, a1: 0, drag: 0.6 });
            if (R() < 0.45) this.glow.spawn({ x: e.pos.x + (R() - .5) * s, y: e.pos.y + 0.6 * s, z: e.pos.z + (R() - .5) * s, vx: (R() - .5) * 1.5, vy: 2.5 + R() * 3, vz: (R() - .5) * 1.5, life: 1.2 + R() * 1.6, size0: 0.05, size1: 0.03, r: 1, g: 0.55, b: 0.18, a0: 2.2 * p, a1: 0, drag: 0.4, wind: this.wind });
          }
        } else e.acc3 = 0;
        if (s >= 1 && p > 0.3 && d < litD) { lit = e; litD = d; }
      } else if (e.kind === 'plume') {
        while (e.acc > 0.35) { e.acc -= 0.35;
          this.smoke.spawn({ x: e.pos.x + (Math.random() - .5) * 4, y: e.pos.y, z: e.pos.z + (Math.random() - .5) * 4, vx: 0, vy: 4 + Math.random() * 2, vz: 0, life: 30 + Math.random() * 10, size0: 6 * s, size1: 38 * s, r: 0.13, g: 0.125, b: 0.12, a0: 0.55, a1: 0, drag: 0.08, wind: [this.wind[0] * 1.5, this.wind[1] * 1.5], fadeIn: 2 });
        }
      } else if (e.kind === 'smoulder') {
        while (e.acc > 0.4) { e.acc -= 0.4; this.smoke.spawn({ x: e.pos.x + (Math.random() - .5) * 2 * s, y: e.pos.y, z: e.pos.z + (Math.random() - .5) * 2 * s, vy: 1 + Math.random(), life: 7, size0: 0.8 * s, size1: 3.5 * s, r: 0.3, g: 0.29, b: 0.27, a0: 0.22 * fade, a1: 0, drag: 0.3, wind: this.wind, fadeIn: 1 }); }
      }
    }
    E.length = w;
    if (lit && (this.litT = (this.litT || 0) - dt) <= 0) {
      const s = lit.scale, q = lit.kind === 'vfire' ? lit.power : 1, ck = lit.cook > 0 ? 2.2 : 1; this.litT = 0.11;
      this.light(this._lp.set(lit.pos.x, lit.pos.y + 1.5 * s, lit.pos.z), lit.cook > 0 ? 0xffa050 : 0xff7a2a, 9 * s * q * ck * (0.75 + 0.5 * R()), 16 * s, 0.16);
    }
    for (const L of this.lights) { if (L.l.intensity <= 0) continue; L.t += dt; L.l.intensity = L.t > L.life ? 0 : L.i0 * (1 - L.t / L.life); }
    // fragments: fly, tumble, bounce, lie for a while (20 s), then go
    const m = this._fm ||= new THREE.Matrix4(), q = this._fq ||= new THREE.Quaternion(), e = this._fe ||= new THREE.Euler(), v = this._fv ||= new THREE.Vector3(), sc = this._fs ||= new THREE.Vector3();
    for (const K of Object.values(this.frag)) {
      const L = K.list; let w = 0;
      for (let i = 0; i < L.length; i++) {
        const d = L[i]; d.t += dt; if (d.t > 20) continue;
        if (!d.rest) { d.vy -= 9.8 * dt; const k = Math.exp(-d.drag * dt); d.vx *= k; d.vz *= k; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt; d.r0 += d.w0 * dt; d.r1 += d.w1 * dt;
          const fl = d.s * 0.3; if (d.y < fl) { d.y = fl; d.vy *= -0.3; d.vx *= 0.45; d.vz *= 0.45; d.w0 *= 0.4; d.w1 *= 0.4; if (Math.abs(d.vy) < 0.8) { d.rest = true; d.r0 = Math.round(d.r0 / Math.PI) * Math.PI; } } }   // (comes to rest lying flat)
        if (w < K.cap) { m.compose(v.set(d.x, d.y, d.z), q.setFromEuler(e.set(d.r0, d.r1, d.r2)), sc.set(d.s * d.ax, d.s, d.s * d.az)); K.mesh.setMatrixAt(w, m); }
        L[w++] = d;
      }
      L.length = Math.min(w, K.cap);
      if (L.length || K.mesh.count) { K.mesh.count = L.length; K.mesh.instanceMatrix.clearUpdateRanges(); K.mesh.instanceMatrix.addUpdateRange(0, Math.max(1, L.length) * 16); K.mesh.instanceMatrix.needsUpdate = true; }
    }
    if (this.later.length) { const L = this.later; let w = 0; for (let i = 0; i < L.length; i++) { const d = L[i]; if ((d.t -= dt) > 0) L[w++] = d; else this.impact({ x: d.x, y: 0.03, z: d.z }, 'dirt', 0.8); } L.length = w; }
    this.time += dt; this.flames.update(dt, this.time, camPos, this.scene.fog?.density); if (camPos) this.tracers.update(dt, camPos);
    this.smoke.update(dt, camPos); this.glow.update(dt, null); this.fire.update(dt, null);
    this.onUpdate?.(dt);   // (world/treeDamage.js: leaves / wood fragments / falling tops)
  }
}
