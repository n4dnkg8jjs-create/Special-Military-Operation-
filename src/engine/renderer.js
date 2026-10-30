import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

// Colour grade + vignette + grain, applied before OutputPass (linear HDR in, so keep it gentle).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, sat: { value: 0.78 }, warm: { value: 0.035 }, vig: { value: 0.42 }, grain: { value: 0.035 }, flash: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time,sat,warm,vig,grain,flash; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
    void main(){ vec4 c=texture2D(tDiffuse,vUv); float l=dot(c.rgb,vec3(.2126,.7152,.0722));
      c.rgb=mix(vec3(l),c.rgb,sat); c.rgb*=vec3(1.+warm,1.,1.-warm*1.4);
      c.rgb = mix(c.rgb, c.rgb*vec3(0.92,0.97,1.04), smoothstep(0.6,0.0,l)*0.5); // cool shadows
      vec2 d=vUv-.5; c.rgb*=1.-vig*dot(d,d)*1.6;
      c.rgb+= (h(vUv*vec2(1920.,1080.)+fract(time)*91.)-.5)*grain*(0.4+l);
      c.rgb+= flash*vec3(1.,.85,.6);
      gl_FragColor=c; }`,
};

export class Renderer {
  constructor(canvas, quality) {
    this.quality = quality;
    const hi = quality === 'high', lo = quality === 'low';
    this.r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.r.setPixelRatio(Math.min(window.devicePixelRatio, hi ? 1.5 : 1));
    this.r.setSize(innerWidth, innerHeight);
    this.r.shadowMap.enabled = !lo;
    this.r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.r.toneMapping = THREE.AgXToneMapping;
    this.r.toneMappingExposure = 1.0;
    this.r.outputColorSpace = THREE.SRGBColorSpace;

    const scene = this.scene = new THREE.Scene();
    // Overcast, smoky late-autumn afternoon.
    scene.fog = new THREE.FogExp2(0x9a978e, 0.0026);
    this.camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.5, 2500);

    // Overcast smoky sky dome (custom so brightness stays controllable) + matching image-based light.
    const sunDir = this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(215));
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { sunDir: { value: sunDir }, zen: { value: new THREE.Color(0x6f7c88) }, hor: { value: new THREE.Color(0xa9a59b) }, gnd: { value: new THREE.Color(0x5a554c) }, sunCol: { value: new THREE.Color(0xffe6c2) }, k: { value: 1.0 } },
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
    scene.environmentIntensity = 0.9;

    const sun = this.sun = new THREE.DirectionalLight(0xffe2c0, 2.6);
    sun.castShadow = !lo;
    const sm = hi ? 4096 : 2048;
    sun.shadow.mapSize.set(sm, sm);
    const S = hi ? 130 : 110;
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 700 });
    sun.shadow.bias = -0.00025; sun.shadow.normalBias = 0.035;
    scene.add(sun, sun.target);
    this.hemi = new THREE.HemisphereLight(0xb8c0c8, 0x4a4236, 0.25);
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
      ao.blendIntensity = 0.9;
      comp.addPass(ao);
    }
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.35, 0.5, 0.92);
    comp.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    comp.addPass(this.grade);
    comp.addPass(new OutputPass());
    if (!lo) comp.addPass(new SMAAPass());

    addEventListener('resize', () => this.resize());
  }
  resize() {
    this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix();
    this.r.setSize(innerWidth, innerHeight); this.composer.setSize(innerWidth, innerHeight);
  }
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
