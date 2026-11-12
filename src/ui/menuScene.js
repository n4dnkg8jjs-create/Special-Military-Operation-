import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// The 3-D layer of the main menu, drawn over the painted backdrop (backdrop.js) on its own transparent canvas:
//   * the convoys on the road are the game's vehicle models (BTR-82A / BMP-3 / T-72B3, their LOD1 meshes: they are ~70 px
//     long) instead of the flat silhouettes - placed every frame where the backdrop's convoy logic has them (same road, same
//     timing, same parallax; the dust stays the backdrop's)
//   * two Ukrainian soldiers nearest the viewer, kneeling side by side on a berm at the lower right: one with an RPG-7 on his
//     shoulder laid on the road the vehicles pass, the other with his rifle; both sway a little (breathing, the launcher
//     settling on the aim)
// Lit as the painting is: last light low on the horizon to the right, cold dark sky, haze over the distance.
// The models are the game's own files (~55 MB with the soldier): fetched after the menu is up, shown with a fade when ready -
// until then (and if anything fails) the painted backdrop is all there is and the flat convoy sprites stay. The layer is
// stopped and its GPU memory released when the menu goes (a battle makes its own renderer).

const VFOV = 30, D2R = Math.PI / 180;
const VEH = { btr: ['btr82a', 'assets/vehicles/btr82a.glb'], bmp: ['bmp3', 'assets/vehicles/bmp3.glb'], tank: ['t72b3', 'assets/vehicles/t72b3.glb'] };
const SOLDIER = 'assets/soldiers/soldier_ua.glb', ANIMS = 'assets/soldiers/soldier_anims.glb';
const WEAPONS = { rpg7: 'assets/soldiers/rpg7.glb', rifle: 'assets/soldiers/ak74m_optic.glb' };

export class MenuScene {
  constructor(backdrop) {
    this.bd = backdrop; this.ready = false; this.running = false; this.loading = null; this.veh = {}; this.pool = new Map(); this.men = [];
  }
  // ---------------------------------------------------------------- life cycle
  start() {
    if (this.running) return; this.running = true;
    if (!this.canvas) {
      const c = this.canvas = document.createElement('canvas'); c.id = 'menu3d'; c.setAttribute('aria-hidden', 'true');
      c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:19;pointer-events:none;opacity:0;transition:opacity 1.6s ease';
      this.bd.c.after(c);
    }
    this.canvas.style.display = 'block';
    this.loading ||= this.load().catch(e => { console.warn('menu 3-D layer unavailable', e); this.failed = true; });
    if (this.ready) this.show();
  }
  stop() {
    if (!this.running) return; this.running = false;
    if (this.canvas) { this.canvas.style.opacity = '0'; this.canvas.style.display = 'none'; }
    this.bd.scene3d = null;
    if (this.renderer) {   // free the GPU side: the battle is about to make its own context
      this.scene.traverse(o => { if (o.isMesh) { o.geometry?.dispose?.(); for (const m of [].concat(o.material || [])) { for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) m[k]?.dispose?.(); m.dispose?.(); } } });
      this.renderer.dispose(); this.renderer.forceContextLoss?.(); this.renderer = null; this.scene = null; this.ready = false; this.loading = null; this.pool.clear(); this.men = []; this.veh = {};
      this.canvas.remove(); this.canvas = null;
    }
  }
  show() { if (!this.running || !this.ready) return; this.bd.scene3d = this; requestAnimationFrame(() => { if (this.canvas) this.canvas.style.opacity = '1'; }); }
  // ---------------------------------------------------------------- build
  async load() {
    const L = new GLTFLoader(), get = u => L.loadAsync(u);
    // soldiers first (they are what the scene is about), the vehicles as they arrive
    const [sg, ag, rpg, rifle] = await Promise.all([get(SOLDIER), get(ANIMS), get(WEAPONS.rpg7), get(WEAPONS.rifle)]);
    if (!this.running) return;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    r.setClearColor(0x000000, 0); r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.95;
    const scene = this.scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x2a251f, 0.0036);
    scene.add(new THREE.HemisphereLight(0x4a5562, 0x12100d, 2.1));
    const sun = new THREE.DirectionalLight(0xd98a45, 2.6); sun.position.set(150, 26, -230); scene.add(sun);          // last light, low on the right horizon
    const fill = new THREE.DirectionalLight(0x5c6878, 1.0); fill.position.set(-40, 60, 60); scene.add(fill);       // sky behind the viewer
    this.cam = new THREE.PerspectiveCamera(VFOV, 16 / 9, 0.1, 900);
    this.resize(); addEventListener('resize', this._rs = () => this.resize());
    // ---- the berm the two men kneel behind: a low lumpy mound of dark earth, its crest just beyond them
    // (a wide strip of ground rising to a lumpy crest a metre beyond them and falling away to the left into the painting's own
    // dark foreground: unlit, the painting's foreground colour - a silhouette like the rest of it, no hard edges)
    const gy = -1.5, BX = 1.9, BZ = -5.6, bg = new THREE.PlaneGeometry(44, 8, 160, 30); bg.rotateX(-Math.PI / 2);
    const P = bg.attributes.position, n1 = (x, z) => Math.sin(x * 1.7 + 0.4) * Math.cos(z * 1.3 + 1.1) * 0.5 + Math.sin(x * 3.9 + z * 2.3) * 0.25 + Math.sin(x * 7.1 - z * 5.3) * 0.12;
    const hAt = (x, z) => {   // (local x, z)
      const lump = 0.42 + 0.16 * Math.sin(x * 0.9 + 1.3) + 0.09 * Math.sin(x * 2.3 + 0.2) + 0.05 * Math.sin(x * 5.1), crest = Math.exp(-((z + 2.35) ** 2) / 0.55) * lump;
      const fall = x < -1 ? -1.9 * (1 - Math.exp(-((x + 1) ** 2) / 30)) : 0, far = z < -3.1 ? -(-3.1 - z) * 1.6 : 0;
      return crest + n1(x, z) * 0.07 + fall + far;
    };
    for (let i = 0; i < P.count; i++) P.setY(i, hAt(P.getX(i), P.getZ(i)));
    bg.computeVertexNormals();
    const berm = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({ color: 0x0d0c0a, roughness: 1, fog: false })); berm.position.set(BX, gy, BZ); scene.add(berm);
    // ---- the two men
    const clipOf = n => ag.animations.find(a => a.name === n);
    const man = (x, z, yaw, clip, weapon, combo, t0) => {
      const m = SkeletonUtils.clone(sg.scene), keep = new Set([combo, combo + '_tape']);
      m.traverse(o => { if (!o.isMesh) return; o.frustumCulled = false; let n = o, hit = null; while (n) { if (keep.has(n.name.replace(/_LOD1$/, ''))) { hit = n; break; } n = n.parent; } o.visible = !!hit && !/_LOD1$/.test(hit.name); });
      m.position.set(x, gy + hAt(x - BX, z - BZ) - 0.012, z); m.rotation.y = yaw; scene.add(m);
      const mixer = new THREE.AnimationMixer(m), a = clipOf(clip) || clipOf('crouch_idle'); if (a) { const act = mixer.clipAction(a); act.play(); act.time = t0; }
      const w = weapon.scene.clone(true); w.traverse(o => { if (o.isMesh && /_LOD1$/i.test(o.name)) o.visible = false; }); m.getObjectByName('weapon_socket')?.add(w);
      const B = n => m.getObjectByName(n);
      return { m, mixer, yaw, spine: B('Spine1'), spine0: B('Spine'), head: B('Head'), ph: Math.random() * 6 };
    };
    // facing the road a little left of straight ahead (the viewer sees them from behind and to the left)
    this.men = [man(1.42, -6.9, Math.PI + 0.16, 'aim_launcher_kneel', rpg, 'combo_0', 0.3), man(2.12, -6.55, Math.PI + 0.05, 'crouch_idle', rifle, 'combo_2', 1.1)];
    this.men[0].rpg = true;
    this.clock = performance.now(); this.ready = true; this.show();
    window.__menu3d = { men: this.men.length, veh: 0 };
    // ---- vehicles (optional: the flat sprites stay for a kind until its model is in)
    for (const [k, [, url]] of Object.entries(VEH)) get(url).then(g => {
      if (!this.running || !this.scene) return;
      const src = g.scene;   // the far-detail meshes only (as the game shows them at range), no wreck parts
      src.traverse(o => { if (/_wreck$/i.test(o.name) || o.userData?.hidden) o.visible = false; });
      src.traverse(o => { if (/_LOD1$/i.test(o.name)) { o.visible = true; const b = src.getObjectByName(o.name.replace(/_LOD1$/i, '')); if (b) b.visible = false; } });
      const box = new THREE.Box3().setFromObject(src); this.veh[k] = { src, len: box.max.z - box.min.z };
      window.__menu3d.veh++;
    }).catch(e => console.warn('menu vehicle', k, e));
  }
  resize() {
    if (!this.renderer) return; const w = innerWidth, h = innerHeight;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5)); this.renderer.setSize(w, h, false);
    this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
  }
  has(kind) { return !!this.veh[kind]; }
  // ---------------------------------------------------------------- frame (after the backdrop has drawn)
  render() {
    if (!this.ready || !this.running || !this.renderer) return;
    const now = performance.now(), dt = Math.min(0.1, (now - this.clock) / 1000); this.clock = now; this.t = (this.t || 0) + dt;
    const bd = this.bd, t = this.t, tanV = Math.tan(VFOV / 2 * D2R), tanH = tanV * this.cam.aspect;
    // the two men: the clip, then a little life on top (breath in the chest, the launcher settling, a slow look along the road)
    for (const s of this.men) {
      s.mixer.update(dt);
      const br = Math.sin(t * 1.25 + s.ph), sw = Math.sin(t * 0.43 + s.ph * 1.7), sw2 = Math.sin(t * 0.71 + s.ph);
      if (s.spine) { s.spine.rotateX(br * 0.012); s.spine.rotateY(sw * (s.rpg ? 0.016 : 0.022)); s.spine.rotateZ(sw2 * 0.008); }
      if (s.spine0) s.spine0.rotateX(br * 0.006);
      if (s.head && !s.rpg) { s.head.rotateY(Math.sin(t * 0.21 + s.ph) * 0.09); }
      s.m.rotation.y = s.yaw + sw * 0.006;
    }
    // the convoy where the backdrop has it: bottom centre of each sprite -> a point on the road, far enough for the model to
    // span the sprite's width
    const [ox, oy] = bd._mo || [0, 0], W = bd.W, H = bd.H, seen = new Set();
    for (const v of bd.convoy || []) {
      const K = this.veh[v.k]; if (!K) continue;
      let o = this.pool.get(v);
      if (!o) { o = K.src.clone(true); this.scene.add(o); this.pool.set(v, o); }
      seen.add(v);
      const img = bd.vehSprites[v.k], cx = v.x + ox + img.width / 2, by = bd.roadY + 2 + oy;
      const nx = cx / W * 2 - 1, ny = 1 - by / H * 2, d = K.len / (2 * tanH * (img.width / W));
      o.position.set(nx * tanH * d, ny * tanV * d + Math.sin(t * 9 + v.ph) * 0.02, -d);
      o.rotation.y = v.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    }
    for (const [v, o] of this.pool) if (!seen.has(v)) { this.scene.remove(o); this.pool.delete(v); }
    this.renderer.render(this.scene, this.cam);
  }
}
