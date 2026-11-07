import * as THREE from 'three';

// Flames (v2): instanced billboards, one draw call for every fire on the map. Each tongue is a quad standing on its base,
// turned to the camera about the vertical and leaned partly toward it (a steep RTS view no longer sees it edge-on). The
// fragment shader shapes a teardrop and eats it away with two scrolling, domain-warped lookups into a small baked noise
// texture (was: 10 procedural value noises with sin() hashes per pixel), white-hot core -> orange -> deep red. Blending
// is premultiplied alpha: the flame body adds light (HDR core for the bloom) and the tips turn into dark, slightly
// opaque smoke wisps in the same pass. Fades into the fog like the smoke puffs. kind 1 = an ammunition cook-off jet
// (narrow, fast, white-yellow).
const VERT = `
  attribute vec4 iPos; attribute vec4 iMisc;
  uniform float fogDensity;
  varying vec2 vUv; varying float vSeed; varying float vInt; varying float vKind; varying float vFog;
  void main(){
    vUv = uv; vSeed = iMisc.y; vInt = iMisc.z; vKind = iMisc.w;
    vec3 right = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
    vec3 up = normalize(mix(vec3(0.0, 1.0, 0.0), vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]), 0.45));
    vec3 wp = iPos.xyz + right * position.x * iPos.w + up * position.y * iMisc.x;
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    vFog = exp(-fogDensity * fogDensity * mv.z * mv.z);
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = `
  uniform float time; uniform sampler2D noise;
  varying vec2 vUv; varying float vSeed; varying float vInt; varying float vKind; varying float vFog;
  void main(){
    float y = vUv.y, jet = vKind, spd = 1.0 + jet * 1.2, t = time * spd;
    float n1 = texture2D(noise, vec2(vUv.x * 0.9 + vSeed, y * 0.8 - t * 0.55)).r;
    float n2 = texture2D(noise, vec2(vUv.x * 2.1 - vSeed * 1.7 + (n1 - 0.5) * 0.45, y * 1.9 - t * 1.35)).g;
    float sway = (n1 - 0.5) * mix(0.55, 0.25, jet) * y;
    float width = mix(0.46, 0.05, pow(y, mix(0.8, 0.55, jet)));
    float dx = abs(vUv.x - 0.5 + sway) / width;
    float body = 1.0 - smoothstep(0.45, 0.95, dx + (n2 - 0.5) * 1.1);
    float top = 1.0 - smoothstep(0.25, 0.85, y + (n2 - 0.5) * 0.9 - (n1 - 0.5) * 0.3);
    float f = clamp(body * top * smoothstep(0.0, 0.1, y), 0.0, 1.0);
    float heat = f * (1.15 - y * 1.1) * (0.65 + 0.7 * n2) + jet * 0.15 * f;
    vec3 col = mix(vec3(0.4, 0.04, 0.0), vec3(1.0, 0.28, 0.03), smoothstep(0.08, 0.4, heat));
    col = mix(col, vec3(1.0, 0.58, 0.14), smoothstep(0.45, 0.8, heat));
    col = mix(col, vec3(1.0, 0.86, 0.55), smoothstep(0.88, 1.15, heat));
    float flick = 0.8 + 0.35 * texture2D(noise, vec2(time * 0.37 + vSeed, vSeed * 0.61)).r;
    vec3 em = col * f * (0.9 + smoothstep(0.8, 1.15, heat) * 0.8 + jet * 0.25) * flick * vInt * vFog;
    // smoky tips (not on a jet): a dark wisp where the flame breaks up near the top
    float sm = (1.0 - jet) * smoothstep(0.3, 0.75, y) * (1.0 - smoothstep(0.75, 1.0, y)) * (1.0 - smoothstep(0.2, 0.9, dx + (n1 - 0.5) * 0.9)) * (1.0 - f) * 0.5 * vInt * vFog;
    if (sm + f < 0.004) discard;
    gl_FragColor = vec4(em + vec3(0.018, 0.016, 0.014) * sm, sm);
  }`;

// 64x64 tileable value-noise fbm, two independent fields (R, G); baked once
function noiseTex() {
  const N = 64, d = new Uint8Array(N * N * 4);
  let sd = 1234567; const rnd = () => ((sd = (sd * 1103515245 + 12345) >>> 0) / 4294967296);
  const field = () => {
    const out = new Float32Array(N * N);
    for (let o = 0, f = 4, a = 0.5; o < 4; o++, f *= 2, a *= 0.5) {
      const g = new Float32Array(f * f).map(rnd);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const X = x / N * f, Y = y / N * f, i = Math.floor(X), j = Math.floor(Y), u = X - i, v = Y - j, su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
        const at = (p, q) => g[(q % f) * f + (p % f)];
        out[y * N + x] += a * ((at(i, j) * (1 - su) + at(i + 1, j) * su) * (1 - sv) + (at(i, j + 1) * (1 - su) + at(i + 1, j + 1) * su) * sv);
      }
    }
    let lo = 1e9, hi = -1e9; for (const x of out) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    return out.map(x => (x - lo) / (hi - lo));
  };
  const r = field(), g = field();
  for (let i = 0; i < N * N; i++) { d[i * 4] = r[i] * 255; d[i * 4 + 1] = g[i] * 255; d[i * 4 + 3] = 255; }
  const t = new THREE.DataTexture(d, N, N); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}

export class Flames {
  constructor(scene, max = 256) {
    this.max = max; this.list = [];
    const g = new THREE.InstancedBufferGeometry(); const q = new THREE.PlaneGeometry(1, 1); q.translate(0, 0.5, 0);
    g.index = q.index; g.attributes.position = q.attributes.position; g.attributes.uv = q.attributes.uv;
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aMisc = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iMisc', this.aMisc);
    g.instanceCount = 0; this.geo = g;
    this.mat = new THREE.ShaderMaterial({ uniforms: { time: { value: 0 }, noise: { value: noiseTex() }, fogDensity: { value: 0.0021 } }, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 12; scene.add(this.mesh);
  }
  // a fire = a few overlapping tongues standing on `anchor` (kept by reference: moving it moves the fire); returns a handle
  // whose .intensity the owner sets (0 = not drawn) and .dead ends it. o.kind 1 = cook-off jet, o.n = tongues
  add(anchor, scale = 1, o = {}) {
    const h = { anchor, tongues: [], intensity: 1, dead: false }, jet = o.kind === 1, n = o.n ?? (scale > 1.2 ? 4 : 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random(), r = (i ? (jet ? 0.12 : 0.42) : 0) * scale;
      h.tongues.push({ ox: Math.cos(a) * r, oz: Math.sin(a) * r, w: (jet ? 0.8 + Math.random() * 0.3 : 1.1 + Math.random() * 0.6) * scale,
        hgt: (jet ? 4.2 + Math.random() * 1.6 : 2.0 + Math.random() * 1.6) * scale * (i ? 0.75 : 1), seed: Math.random() * 10, kind: jet ? 1 : 0 });
    }
    this.list.push(h); return h;
  }
  update(dt, time, camPos, fogDensity) {
    this.mat.uniforms.time.value = time; if (fogDensity != null) this.mat.uniforms.fogDensity.value = fogDensity;
    const L = this.list, P = this.aPos.array, M = this.aMisc.array; let k = 0, w = 0;
    for (let i = 0; i < L.length; i++) {
      const h = L[i]; if (h.dead) continue; L[w++] = h;
      if (h.intensity <= 0.01) continue;
      const A = h.anchor, d = camPos ? Math.hypot(A.x - camPos.x, A.z - camPos.z) : 0;
      // distance LOD: far fires keep only their main tongue (a little wider), mid range two
      const n = d > 420 ? 1 : d > 200 ? 2 : h.tongues.length, wk = d > 420 && h.tongues.length > 1 ? 1.3 : 1;
      for (let j = 0; j < n && j < h.tongues.length && k < this.max; j++, k++) {
        const t = h.tongues[j], k4 = k * 4;
        P[k4] = A.x + t.ox; P[k4 + 1] = A.y; P[k4 + 2] = A.z + t.oz; P[k4 + 3] = t.w * wk;
        M[k4] = t.hgt * (0.55 + 0.45 * Math.min(1, h.intensity)); M[k4 + 1] = t.seed; M[k4 + 2] = Math.min(1.2, h.intensity); M[k4 + 3] = t.kind;
      }
    }
    L.length = w;
    this.geo.instanceCount = k;
    for (const a of this.attrs ||= [this.aPos, this.aMisc]) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, k) * 4); a.needsUpdate = true; }
  }
}
