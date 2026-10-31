import * as THREE from 'three';

// Procedural flames: Y-axis billboards whose fragment shader builds rising flame tongues from
// scrolling fbm noise, with a white-hot core → orange → deep red ramp. One draw call for all fires.
const VERT = `
  attribute vec3 iPos; attribute vec2 iSize; attribute float iSeed; attribute float iInt;
  varying vec2 vUv; varying float vSeed; varying float vInt;
  void main(){
    vUv = uv; vSeed = iSeed; vInt = iInt;
    vec3 right = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
    vec3 wp = iPos + right * position.x * iSize.x + vec3(0.0, 1.0, 0.0) * position.y * iSize.y;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }`;
const FRAG = `
  uniform float time; varying vec2 vUv; varying float vSeed; varying float vInt;
  float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++){ s += a * n(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
  void main(){
    float t = time * 1.6 + vSeed * 10.0;
    vec2 p = vec2((vUv.x - 0.5) * 2.0, vUv.y);
    // rising, licking turbulence
    float q = fbm(vec2(p.x * 2.2 + vSeed, p.y * 2.6 - t * 1.9));
    float r = fbm(vec2(p.x * 4.0 - vSeed, p.y * 5.0 - t * 2.7));
    float sway = (q - 0.5) * 0.55 * vUv.y;
    float width = mix(0.95, 0.12, pow(vUv.y, 0.8));          // teardrop: wide base, thin tip
    float d = abs(p.x + sway) / width;
    float body = smoothstep(0.85, 0.45, d + (r - 0.5) * 0.7);
    float top = smoothstep(0.95, 0.45, vUv.y + (q - 0.45) * 0.9);
    float base = smoothstep(0.0, 0.12, vUv.y);
    float f = pow(clamp(body * top * base, 0.0, 1.0), 1.3);
    float heat = f * (1.1 - vUv.y * 1.0) * (0.75 + 0.45 * r);
    vec3 col = mix(vec3(0.55, 0.06, 0.01), vec3(1.0, 0.36, 0.05), smoothstep(0.15, 0.45, heat));
    col = mix(col, vec3(1.0, 0.7, 0.25), smoothstep(0.55, 0.85, heat));
    col = mix(col, vec3(1.0, 0.93, 0.7), smoothstep(0.92, 1.1, heat));
    float flick = 0.85 + 0.15 * n(vec2(t * 3.0, vSeed * 7.0));
    gl_FragColor = vec4(col * f * vInt * flick * 1.05, 1.0);
  }`;

export class Flames {
  constructor(scene, max = 256) {
    this.max = max; this.list = [];
    const g = new THREE.InstancedBufferGeometry(); const q = new THREE.PlaneGeometry(1, 1); q.translate(0, 0.5, 0);
    g.index = q.index; g.attributes.position = q.attributes.position; g.attributes.uv = q.attributes.uv;
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.aSeed = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aInt = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iSize', this.aSize); g.setAttribute('iSeed', this.aSeed); g.setAttribute('iInt', this.aInt);
    g.instanceCount = 0; this.geo = g;
    this.mat = new THREE.ShaderMaterial({ uniforms: { time: { value: 0 } }, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 12; scene.add(this.mesh);
  }
  // a fire = a few overlapping tongues; returns a handle whose .intensity can be faded
  add(pos, scale = 1) {
    const h = { tongues: [], intensity: 1, dead: false };
    const n = scale > 1.2 ? 4 : 3;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random(), r = (i ? 0.45 : 0) * scale;
      h.tongues.push({ x: pos.x + Math.cos(a) * r, y: pos.y, z: pos.z + Math.sin(a) * r, w: (1.1 + Math.random() * 0.6) * scale, hgt: (2.0 + Math.random() * 1.6) * scale * (i ? 0.75 : 1), seed: Math.random() * 10 });
    }
    this.list.push(h); return h;
  }
  update(dt, time) {
    this.mat.uniforms.time.value = time;
    this.list = this.list.filter(h => !h.dead && h.intensity > 0.01);
    let k = 0;
    for (const h of this.list) for (const t of h.tongues) {
      if (k >= this.max) break;
      this.aPos.setXYZ(k, t.x, t.y, t.z); this.aSize.setXY(k, t.w, t.hgt * (0.6 + 0.4 * h.intensity)); this.aSeed.setX(k, t.seed); this.aInt.setX(k, h.intensity); k++;
    }
    this.geo.instanceCount = k;
    this.aPos.needsUpdate = this.aSize.needsUpdate = this.aSeed.needsUpdate = this.aInt.needsUpdate = true;
  }
}
