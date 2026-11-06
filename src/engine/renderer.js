import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

// Legacy grade (?grade=0): gentle saturation + vignette in linear HDR before OutputPass (the pre-v2 look, for A/B).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, sat: { value: 0.93 }, warm: { value: 0.0 }, vig: { value: 0.2 }, grain: { value: 0.0 }, flash: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time,sat,warm,vig,grain,flash; varying vec2 vUv;
    void main(){ vec4 c=texture2D(tDiffuse,vUv); float l=dot(c.rgb,vec3(.2126,.7152,.0722));
      c.rgb=mix(vec3(l),c.rgb,sat); c.rgb*=vec3(1.+warm,1.,1.-warm*1.4);
      vec2 d=vUv-.5; c.rgb*=1.-vig*dot(d,d)*1.6;
      c.rgb+= flash*vec3(1.,.85,.6);
      gl_FragColor=c; }`,
};
// War-film grade (default): runs LAST, on the display-referred image (after tone mapping + sRGB, after SMAA), so the
// curve behaves like a LUT: desaturation (stronger in the highlights, keeps a little earth colour in the mids), cool
// green-grey shadows / warm-grey highlights (split tone), slightly crushed blacks + soft filmic S-curve, a faint warm
// dust veil, vignette and animated luminance-weighted film grain. HTML UI is untouched (it is not in the canvas).
const WarGradeShader = {
  uniforms: {
    tDiffuse: { value: null }, time: { value: 0 }, flash: { value: 0 }, res: { value: new THREE.Vector2(1, 1) },
    sat: { value: 0.74 }, satHi: { value: 0.64 }, contrast: { value: 0.28 }, black: { value: 0.022 }, gamma: { value: 1.0 },
    shadowTint: { value: new THREE.Vector3(0.9, 0.99, 1.02) }, highTint: { value: new THREE.Vector3(1.05, 1.0, 0.9) },
    veil: { value: new THREE.Vector3(0.62, 0.6, 0.55) }, veilAmt: { value: 0.045 },
    vig: { value: 0.36 }, grain: { value: 0.02 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time, flash, sat, satHi, contrast, black, gamma, veilAmt, vig, grain;
    uniform vec2 res; uniform vec3 shadowTint, highTint, veil; varying vec2 vUv;
    float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main(){
      vec3 c = clamp(texture2D(tDiffuse, vUv).rgb, 0.0, 1.0);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // desaturate (highlights bleach harder), but keep the warm earth / olive hue family in the mids
      c = mix(vec3(l), c, mix(sat, satHi, smoothstep(0.45, 0.9, l)));
      // split tone
      float sh = 1.0 - smoothstep(0.0, 0.42, l), hi = smoothstep(0.5, 0.95, l);
      c *= mix(vec3(1.0), shadowTint, sh * 0.85);
      c *= mix(vec3(1.0), highTint, hi * 0.7);
      // crushed blacks + filmic S-curve around mid grey
      c = max(c - black, 0.0) / (1.0 - black);
      c = pow(c, vec3(gamma));
      vec3 s = c * c * (3.0 - 2.0 * c);
      c = mix(c, s, contrast);
      // airborne dust: a faint warm veil, strongest in the upper (sky / far) part of the frame
      c = mix(c, veil, veilAmt * (0.55 + 0.45 * smoothstep(0.25, 0.85, vUv.y)));
      // vignette (oval, soft)
      vec2 d = (vUv - 0.5) * vec2(1.0, 0.82); c *= 1.0 - vig * smoothstep(0.08, 0.62, dot(d, d) * 2.2);
      // muzzle / blast flash
      c += flash * vec3(1.0, 0.85, 0.6);
      // film grain: per pixel, re-rolled ~24 fps, strongest in the mid tones
      float g = h12(floor(vUv * res) + floor(time * 24.0) * vec2(37.0, 17.0)) + h12(floor(vUv * res) * 1.7 + 11.0 + floor(time * 24.0)) - 1.0;
      float lw = 4.0 * l * (1.0 - l) * 0.75 + 0.25;
      c += g * grain * lw;
      gl_FragColor = vec4(c, 1.0);
    }`,
};
// ?grade=0 restores the pre-v2 look (legacy grade, fog and sky colours) for comparison; localStorage smo_grade=0 too.
export function gradeEnabled() {
  try { const q = new URLSearchParams(location.search).get('grade'); if (q != null) return q !== '0'; return localStorage.getItem('smo_grade') !== '0'; } catch { return true; }
}

// context capabilities other modules pick their draw path by (world/buildings.js: BatchedMesh kit when multi-draw exists)
export const CAPS = { multiDraw: false };
// ---- static shadow cache.  Opaque world geometry that never moves (panel-block kit, interiors, instanced props / rubble /
// curbs / trunks: markStatic) is drawn into a cached depth target with the sun's shadow camera only when that camera
// moved (the focus crossed a 2 m snap step) or a static changed (instances added / removed / moved, LOD visibility:
// checked by a per-frame signature); every frame the cached depth is blitted into the shadow map right after three
// clears it and only the other casters (units, vehicles, wrecks, foliage cards, fx) are drawn on top.  The shadow map is
// the same texture as without the cache.  ?shadowcache=0 / localStorage smo_shadowcache=0: off.
export const STATIC_SHADOW = new Set();
export function markStatic(o) { if (o && !STATIC_SHADOW.has(o)) { STATIC_SHADOW.add(o); o.layers.enable(3); } }
function shadowCacheOn() { try { const q = new URLSearchParams(location.search).get('shadowcache'); if (q != null) return q !== '0'; return localStorage.getItem('smo_shadowcache') !== '0'; } catch { return true; } }
export class Renderer {
  constructor(canvas, quality) {
    this.quality = quality;
    const hi = quality === 'high', lo = quality === 'low';
    this.r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.r.setPixelRatio(Math.min(window.devicePixelRatio, hi ? 1.5 : 1));
    this.r.setSize(innerWidth, innerHeight);
    this.r.shadowMap.enabled = !lo;
    this.r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.r.toneMapping = THREE.NeutralToneMapping;
    this.r.toneMappingExposure = 1.0;
    this.r.outputColorSpace = THREE.SRGBColorSpace;
    CAPS.multiDraw = this.r.extensions.has('WEBGL_multi_draw');

    const scene = this.scene = new THREE.Scene();
    const graded = this.graded = gradeEnabled();
    if (graded) this.r.toneMappingExposure = 1.1;    // the grade crushes the blacks a little: lift the mids back
    // Overcast, smoky late-autumn afternoon (graded: dustier, warmer grey air).
    scene.fog = new THREE.FogExp2(graded ? 0xaeaba2 : 0xb3b7b6, 0.0021);
    this.camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.5, 2500);

    // Overcast smoky sky dome (custom so brightness stays controllable) + matching image-based light.
    const sunDir = this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(48), THREE.MathUtils.degToRad(215));
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { sunDir: { value: sunDir }, zen: { value: new THREE.Color(graded ? 0x7f8b97 : 0x7d91a6) }, hor: { value: new THREE.Color(graded ? 0xbab8b1 : 0xbfc3c3) }, gnd: { value: new THREE.Color(0x6a665d) }, sunCol: { value: new THREE.Color(0xfff1dc) }, k: { value: 1.0 } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix*vec4(position,1.); gl_Position = projectionMatrix*p; gl_Position.z = gl_Position.w; }`,
      fragmentShader: `uniform vec3 sunDir,zen,hor,gnd,sunCol; uniform float k; varying vec3 vDir;
        float h(vec3 p){ return fract(sin(dot(p,vec3(12.9898,78.233,37.719)))*43758.5453); }
        float n3(vec3 p){ vec3 i=floor(p),f=fract(p); f=f*f*(3.-2.*f); return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
        void main(){ vec3 d=normalize(vDir); float y=d.y;
          vec3 c = y>0. ? mix(hor, zen, pow(clamp(y,0.,1.),0.55)) : mix(hor, gnd, clamp(-y*4.,0.,1.));
          // cloud deck
          vec2 uv = d.xz/(max(y,0.04))*1.4; float cl = n3(vec3(uv*1.3,1.))*0.55+n3(vec3(uv*3.1,2.))*0.3+n3(vec3(uv*7.,3.))*0.15;
          c = mix(c, c*vec3(0.82,0.83,0.85), smoothstep(0.45,0.8,cl)*smoothstep(0.0,0.25,y));
          float s=max(dot(d,sunDir),0.); c += sunCol*(pow(s,8.)*0.25 + pow(s,64.)*0.6 + pow(s,900.)*4.);
          gl_FragColor=vec4(c*k,1.); }`,
    });
    const sky = this.sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 48, 24), skyMat);
    sky.frustumCulled = false; sky.renderOrder = -1; scene.add(sky);
    const pm = new THREE.PMREMGenerator(this.r);
    const envScene = new THREE.Scene(); envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat));
    this.envRT = pm.fromScene(envScene, 0.02, 1, 1000);
    scene.environment = this.envRT.texture;
    scene.environmentIntensity = 0.75;

    const sun = this.sun = new THREE.DirectionalLight(0xfff0dc, 2.9);
    sun.castShadow = !lo;
    const sm = hi ? 4096 : 2048;
    sun.shadow.mapSize.set(sm, sm);
    const S = hi ? 130 : 110;
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 700 });
    sun.shadow.bias = -0.00025; sun.shadow.normalBias = 0.035;
    scene.add(sun, sun.target);
    this.hemi = new THREE.HemisphereLight(0xc9d4df, 0x6b6253, 0.45);
    scene.add(this.hemi);

    // Post
    // composer targets carry a depth texture so GTAO can reconstruct normals from depth
    // instead of re-rendering the whole scene into a normal buffer (halves scene draw calls)
    const rt = new THREE.WebGLRenderTarget(innerWidth * this.r.getPixelRatio(), innerHeight * this.r.getPixelRatio(), { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType) });
    const comp = this.composer = new EffectComposer(this.r, rt);
    comp.setSize(innerWidth, innerHeight);
    comp.addPass(new RenderPass(scene, this.camera));
    if (!lo) {
      const ao = this.ao = new GTAOPass(scene, this.camera, innerWidth, innerHeight, { depthTexture: comp.readBuffer.depthTexture });
      ao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: hi ? 16 : 8 });
      ao.blendIntensity = 0.75;
      comp.addPass(ao);
    }
    // sanitize before bloom: one NaN / Inf pixel (degenerate normals, a shader edge case on some GPUs, half-float
    // overflow from a bright flash) gets smeared by the bloom mip chain into big flickering black blotches
    const clean = new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
        bool bad(float v){ return isnan(v) || isinf(v) || !(v >= -1e4 && v <= 6e4); }
        void main(){ vec4 c = texture2D(tDiffuse, vUv);
          if (bad(c.r) || bad(c.g) || bad(c.b)) {   // replace with the average of the valid neighbours
            vec2 px = 1.0 / vec2(textureSize(tDiffuse, 0)); vec3 sum = vec3(0.); float n = 0.;
            for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) { vec3 q = texture2D(tDiffuse, vUv + vec2(i, j) * px * 2.0).rgb; if (!(bad(q.r) || bad(q.g) || bad(q.b))) { sum += q; n += 1.; } }
            c.rgb = n > 0. ? sum / n : vec3(0.);
          }
          gl_FragColor = vec4(clamp(c.rgb, 0.0, 64.0), 1.0); }`,
    });
    comp.addPass(clean);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.35, 0.5, 0.92);
    comp.addPass(this.bloom);
    if (graded) {
      comp.addPass(new OutputPass());
      if (!lo) comp.addPass(new SMAAPass());
      this.grade = new ShaderPass(WarGradeShader);
      const u = this.grade.uniforms;
      // low: same curve, lighter grain / vignette (it is one cheap full-screen pass either way)
      if (lo) { u.grain.value = 0.014; u.vig.value = 0.36; }
      if (hi) u.grain.value = 0.022;
      comp.addPass(this.grade);
    } else {
      this.grade = new ShaderPass(GradeShader);
      comp.addPass(this.grade);
      comp.addPass(new OutputPass());
      if (!lo) comp.addPass(new SMAAPass());
    }
    this.sizeGrade();
    if (!lo && shadowCacheOn()) this.installShadowCache();

    addEventListener('resize', () => this.resize());
  }
  installShadowCache() {
    const r = this.r, gl = r.getContext(), sm = r.shadowMap, sun = this.sun, base = sm.render;
    const camC = new THREE.OrthographicCamera(), depthMat = new THREE.MeshDepthMaterial({ side: THREE.BackSide });   // (three draws FrontSide casters' back faces into shadow maps)
    const pv = new THREE.Matrix4(), lastPV = new THREE.Matrix4(); let rt = null, sig0 = NaN, cacheOk = false;
    const C = this.shadowCache = { renders: 0, frames: 0 };
    const blit = map => {
      const src = r.properties.get(rt).__webglFramebuffer, dst = r.properties.get(map).__webglFramebuffer; if (!src || !dst) return;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, src); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
      gl.blitFramebuffer(0, 0, rt.width, rt.height, 0, 0, rt.width, rt.height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst);   // (three's state cache has dst bound to FRAMEBUFFER = read + draw)
    };
    sm.render = function (lights, scene, camera) {
      const sh = sun.shadow;
      if (!STATIC_SHADOW.size || !lights.includes(sun) || !sm.enabled || !sun.castShadow || !sh.map || (sm.autoUpdate === false && sm.needsUpdate === false)) return base.call(this, lights, scene, camera);
      sh.updateMatrices(sun, camera); pv.multiplyMatrices(sh.camera.projectionMatrix, sh.camera.matrixWorldInverse);
      // signature of the static set: visibility, instance counts / matrix versions, kit batch versions
      let sig = 0;
      for (const o of STATIC_SHADOW) { let vis = o.visible, root = o; for (let p = o.parent; p; p = p.parent) { vis &&= p.visible; root = p; } if (root !== scene) { STATIC_SHADOW.delete(o); continue; } sig = (sig * 31 + (vis ? 1 + (o.count ?? 0) + (o.instanceMatrix?.version ?? 0) * 7 + (o.kv ?? 0) * 13 : 0)) | 0; }
      const w = sh.map.width, h = sh.map.height;
      if (!rt || rt.width !== w || rt.height !== h) { rt?.dispose(); rt = new THREE.WebGLRenderTarget(w, h, { depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType) }); cacheOk = false; }
      if (!cacheOk || sig !== sig0 || !pv.equals(lastPV)) {
        const prev = r.getRenderTarget(), ov = scene.overrideMaterial, ar = r.info.autoReset, au = sm.autoUpdate;
        camC.copy(sh.camera); camC.layers.set(3); sm.autoUpdate = false; r.info.autoReset = false; scene.overrideMaterial = depthMat;
        const off = []; for (const o of STATIC_SHADOW) if (!o.castShadow && o.visible) { o.visible = false; off.push(o); }   // (statics that do not cast)
        try { r.setRenderTarget(rt); r.clear(); r.render(scene, camC); } finally { for (const o of off) o.visible = true; scene.overrideMaterial = ov; sm.autoUpdate = au; r.info.autoReset = ar; r.setRenderTarget(prev); }
        sig0 = sig; lastPV.copy(pv); cacheOk = true; C.renders++;
      }
      C.frames++;
      for (const o of STATIC_SHADOW) { o.userData.cs0 = o.castShadow; o.castShadow = false; }
      const clr = r.clear; r.clear = function (...a) { clr.apply(this, a); if (r.getRenderTarget() === sh.map) blit(sh.map); };
      try { base.call(this, lights, scene, camera); } finally { r.clear = clr; for (const o of STATIC_SHADOW) o.castShadow = o.userData.cs0; }
    };
  }
  resize() {
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.r.setSize(innerWidth, innerHeight); this.composer.setSize(innerWidth, innerHeight); this.sizeGrade();
  }
  // ---- adaptive resolution: full resolution whenever the GPU keeps up; when the frame rate stays below ~30 fps and the
  // time is NOT going into the simulation (frame interval much longer than the JS work before render: the GPU / fill
  // rate is the limit), the internal render resolution steps down (x0.9, at most to 0.8 of the preset's pixel ratio; only below ~30 fps);
  // it steps back up as soon as there is headroom again. The canvas keeps its size (CSS scales it). Off: ?dynres=0 or
  // localStorage smo_dynres=0; off by default under automation (headless screenshot tools), ?dynres=1 forces it on.
  dynFrame(simMs) {
    if (this.dynOff ??= (() => { try { const q = new URLSearchParams(location.search).get('dynres'); return q != null ? q === '0' : navigator.webdriver || localStorage.getItem('smo_dynres') === '0'; } catch { return false; } })()) return;
    const now = performance.now(), D = this.dyn ||= { last: now, n: 0, int: 0, sim: 0, t0: now, scale: 1, base: this.r.getPixelRatio(), upBlockUntil: 0 };
    const gap = now - D.last; D.last = now;
    if (gap > 1000 || document.hidden) { D.n = 0; D.int = 0; D.sim = 0; D.t0 = now; return; }   // tab switch, load hitch: start over
    D.n++; D.int += gap; D.sim += simMs;
    if (now - D.t0 < 1500 || D.n < 8) return;
    const avg = D.int / D.n, sim = D.sim / D.n; D.n = 0; D.int = 0; D.sim = 0; D.t0 = now;
    let s = D.scale;
    if (avg > 33 && avg - sim > 18 && s > 0.81) { s = Math.max(0.8, s * 0.9); if (now - (D.upAt || -1e9) < 5000) D.upBlockUntil = now + 20000; }   // (the last step up was one too many: wait before trying again)
    else if (avg < 26 && s < 1 && now > D.upBlockUntil) { s = Math.min(1, s / 0.9); D.upAt = now; }
    if (s !== D.scale) { D.scale = s; this.r.setPixelRatio(D.base * s); this.r.setSize(innerWidth, innerHeight); this.composer.setPixelRatio(D.base * s); this.sizeGrade(); }
  }
  sizeGrade() { const r = this.grade?.uniforms.res; if (r) r.value.set(innerWidth * this.r.getPixelRatio(), innerHeight * this.r.getPixelRatio()); }
  // Keep the shadow frustum centred on what the camera looks at.
  followShadow(focus) {
    const s = this.sun;
    const snap = 2;
    const fx = Math.round(focus.x / snap) * snap, fz = Math.round(focus.z / snap) * snap;
    s.target.position.set(fx, 0, fz);
    s.position.set(fx + this.sunDir.x * 300, this.sunDir.y * 300, fz + this.sunDir.z * 300);
  }
  render(dt, t) {
    this.grade.uniforms.time.value = t;
    if (this.ao) { // RenderPass draws into the current read buffer: point GTAO at that buffer's depth
      const d = this.composer.readBuffer.depthTexture;
      if (this.ao.depthTexture !== d) { this.ao.depthTexture = d; this.ao.gtaoMaterial.uniforms.tDepth.value = d; this.ao.pdMaterial.uniforms.tDepth.value = d; this.ao.depthRenderMaterial.uniforms.tDepth.value = d; }
    }
    this.composer.render(dt);
  }
  tick(dt) { const f = this.grade.uniforms.flash; f.value = Math.max(0, f.value - dt * 3); }
  flash(a) { this.grade.uniforms.flash.value = Math.min(0.35, this.grade.uniforms.flash.value + a); }
}
