import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// The main menu's scene, in 3-D (v2: the whole view, not a layer of models over the painting). Drawn on its own canvas over the
// painted backdrop (backdrop.js), which keeps the sky - cloud deck, the glow of the last light, artillery flashes, smoke columns,
// embers, ash - and stops drawing its flat town once this scene is up:
//   * a hilltop at dusk: the viewer sits a few metres behind a low earth berm; beyond it the ground falls away to a plain with a
//     road across it 180 m off, where the convoys pass (the game's vehicle models, LOD1, timed by the backdrop's convoy logic)
//   * the town beyond the road, built here from simple solids: a street of private houses (gabled roofs, chimneys) among
//     poplars and garden trees, an Orthodox church (bell tower with a tented spire, drum and onion domes, crosses), five- and
//     nine-storey panel blocks and a point block behind, a few lit windows, a power line along the road, anti-tank hedgehogs
//     on the verge
//   * two Ukrainian soldiers behind the berm, nearest the viewer: one kneeling at the parapet, rifle in his hands, looking over
//     the crest at the road; the other sitting with his back against the berm, knees up, rifle across them
// Lit as the painting was: last light low on the horizon to the right, cold dark sky behind the viewer, haze over the distance.
// The soldier and vehicle files (~55 MB) are fetched after the menu is up and the scene fades in when ready; until then, and if
// anything fails (or with ?menu2d), the painted backdrop is all there is. Stopped and freed when the menu goes.

const VFOV = 30, D2R = Math.PI / 180, PITCH = 0.0536;          // camera looks up 3 deg: horizon at 60 % of the height, as painted
const FY = -1.42, PLAIN = -9.6, ROAD_Z = -180;                 // hilltop floor / plain / road, below and beyond the eye (origin)
const VEH = { btr: ['btr82a', 'assets/vehicles/btr82a.glb'], bmp: ['bmp3', 'assets/vehicles/bmp3.glb'], tank: ['t72b3', 'assets/vehicles/t72b3.glb'] };
const ENV = 'assets/env/';
const SOLDIER = 'assets/soldiers/soldier_ua.glb', ANIMS = 'assets/soldiers/soldier_anims.glb', RIFLE = 'assets/soldiers/ak74m_optic.glb';
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---- ground: flat hilltop round the viewer, falling to the plain; the berm stands on the hilltop
const hill = z => FY + (PLAIN - FY) * sstep(-14, -120, z);
const crestZ = x => -8.05 + 0.12 * Math.sin(x * 0.8 + 0.5) + 0.05 * Math.sin(x * 2.1);
const crestH = x => 0.9 + 0.07 * Math.sin(x * 1.3 + 0.4) + 0.04 * Math.sin(x * 3.1 + 1.0);
const bermAt = (x, z) => { const d = z - crestZ(x); return crestH(x) * (d >= 0 ? 1 - sstep(0, 0.42, d) : 1 - sstep(0, 2.3, -d)); };   // steep to the men, easy to the enemy

export class MenuScene {
  constructor(backdrop) {
    this.bd = backdrop; this.ready = false; this.running = false; this.loading = null; this.veh = {}; this.pool = new Map(); this.men = []; this.full = false;
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
    this.loading ||= this.load().catch(e => { console.warn('menu 3-D scene unavailable', e); this.failed = true; });
    if (this.ready) this.show();
  }
  stop() {
    if (!this.running) return; this.running = false; clearTimeout(this._full); this.full = false;
    if (this.canvas) { this.canvas.style.opacity = '0'; this.canvas.style.display = 'none'; }
    this.bd.scene3d = null;
    if (this.renderer) {   // free the GPU side: the battle is about to make its own context
      this.scene.traverse(o => { if (o.isMesh || o.isSprite || o.isLine) { o.geometry?.dispose?.(); for (const m of [].concat(o.material || [])) { for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) m[k]?.dispose?.(); m.dispose?.(); } } });
      this.renderer.dispose(); this.renderer.forceContextLoss?.(); this.renderer = null; this.scene = null; this.ready = false; this.loading = null; this.pool.clear(); this.men = []; this.veh = {};
      removeEventListener('resize', this._rs);
      this.canvas.remove(); this.canvas = null;
    }
  }
  // (the painting's town goes once the fade is through: until then both are on screen)
  show() {
    if (!this.running || !this.ready) return; this.bd.scene3d = this;
    requestAnimationFrame(() => { if (this.canvas) this.canvas.style.opacity = '1'; });
  }
  // ---------------------------------------------------------------- build
  async load() {
    const L = new GLTFLoader(), get = u => L.loadAsync(u);
    const [sg, ag, rifle] = await Promise.all([get(SOLDIER), get(ANIMS), get(RIFLE)]);
    if (!this.running) return;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    r.setClearColor(0x000000, 0); r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.95;
    const scene = this.scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x2a251f, 0.0034);
    scene.add(new THREE.HemisphereLight(0x4a5562, 0x12100d, 2.1));
    const sun = new THREE.DirectionalLight(0xd98a45, 2.0); sun.position.set(150, 26, -230); scene.add(sun);          // last light, low on the right horizon
    const fill = new THREE.DirectionalLight(0x5c6878, 1.0); fill.position.set(-40, 60, 60); scene.add(fill);       // sky behind the viewer
    const near = new THREE.PointLight(0x7f8894, 9, 10, 1.6); near.position.set(0.6, 0.5, -4.6); scene.add(near);   /* what is left of the sky on the two men and the berm beside them (they were black on black) */
    this.cam = new THREE.PerspectiveCamera(VFOV, 16 / 9, 1.2, 1400); this.cam.rotation.order = 'YXZ'; this.cam.rotation.x = PITCH;
    this.resize(); addEventListener('resize', this._rs = () => this.resize());
    this.ground(scene);
    this.soldiers(scene, sg, ag, rifle);
    this.clock = performance.now(); this.ready = true; this.show();
    window.__menu3d = { men: this.men.length, veh: 0 }; window.__menuScene = this;
    this.town(scene, get).catch(e => console.warn('menu town', e));   /* ~31 MB of the game's environment models: the painted town stays until they are in */
    // ---- vehicles (the flat sprites stay for a kind until its model is in)
    for (const [k, [, url]] of Object.entries(VEH)) get(url).then(g => {
      if (!this.running || !this.scene) return;
      const src = g.scene;   // the far-detail meshes only (as the game shows them at range), no wreck parts
      src.traverse(o => { if (/_wreck$/i.test(o.name) || o.userData?.hidden) o.visible = false; });
      src.traverse(o => { if (/_LOD1$/i.test(o.name)) { o.visible = true; const b = src.getObjectByName(o.name.replace(/_LOD1$/i, '')); if (b) b.visible = false; } });
      const box = new THREE.Box3().setFromObject(src); this.veh[k] = { src, len: box.max.z - box.min.z };
      window.__menu3d.veh++;
    }).catch(e => console.warn('menu vehicle', k, e));
  }
  // ---------------------------------------------------------------- the land (at once) and the town (when its files are in)
  ground(scene) {
    const earth = new THREE.MeshStandardMaterial({ color: 0x2b2519, roughness: 1 }), berm = new THREE.MeshStandardMaterial({ color: 0x74624c, roughness: 1 });
    // terrain (coarse) + the hilltop patch with the berm (fine); the patch's rim is sunk under the terrain
    const tg = new THREE.PlaneGeometry(1500, 1300, 100, 130); tg.rotateX(-Math.PI / 2); tg.translate(0, 0, -560);
    let P = tg.attributes.position;
    for (let i = 0; i < P.count; i++) { const z = P.getZ(i); P.setY(i, hill(z)); }
    tg.computeVertexNormals(); scene.add(new THREE.Mesh(tg, earth));
    const bg = new THREE.PlaneGeometry(48, 10, 240, 96); bg.rotateX(-Math.PI / 2); bg.translate(2, 0, -7);
    P = bg.attributes.position;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), z = P.getZ(i), e = Math.min(sstep(-22, -19, x), 1 - sstep(23, 26, x), sstep(-12, -11, z), 1 - sstep(-3, -2, z));
      P.setY(i, FY + (bermAt(x, z) + 0.035 + (Math.sin(x * 4.3 + z * 2.9) + Math.sin(x * 9.1 - z * 6.7) * 0.5) * 0.012) * e - 0.25 * (1 - e));
    }
    bg.computeVertexNormals(); scene.add(new THREE.Mesh(bg, berm));
    const road = new THREE.Mesh(new THREE.BoxGeometry(1500, 0.06, 7.5), new THREE.MeshStandardMaterial({ color: 0x2a2824, roughness: 0.95 })); road.position.set(0, PLAIN + 0.03, ROAD_Z); scene.add(road);
    // dust behind the convoy: soft sprites
    this.dust = Array.from({ length: 44 }, () => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot('120,108,92'), depthWrite: false, transparent: true, opacity: 0 })); sp.visible = false; sp.userData.life = 9; scene.add(sp); return sp; });
  }
  dot(rgb) {
    const k = '_dot' + rgb; if (this[k]) return this[k];
    const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, `rgba(${rgb},1)`); g.addColorStop(0.35, `rgba(${rgb},.45)`); g.addColorStop(1, `rgba(${rgb},0)`); x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return (this[k] = t);
  }
  // The town is the game's own models (v3: the first 3-D town was plain solids): the private houses, fences, church, sub-station
  // and lamp of assets/env/city.glb, the leafy trees, barn, water tower, sheds and wells of farmland.glb, utility poles of
  // wires.glb, and five- and nine-storey blocks put together from the panel kit (panel_kit.glb: plinth, window / balcony /
  // entrance / blank end panels, balconies, parapet, roof huts) the way src/world/buildings.js does, a few flats shelled.
  // Every model is drawn instanced (one InstancedMesh per sub-mesh of a model).
  async town(scene, get) {
    const [city, farm, wires, kit] = await Promise.all([get(ENV + 'city.glb'), get(ENV + 'farmland.glb'), get(ENV + 'wires.glb'), get(ENV + 'panel_kit.glb')]);
    if (!this.running || this.scene !== scene) return;
    const R = rng(1917), M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), V = (x, y, z) => new THREE.Vector3(x, y, z);
    const bins = new Map(), find = (...n) => { for (const g of [city, farm, wires, kit]) for (const k of n) { const o = g.scene.getObjectByName(k); if (o) return o; } return null; };
    const put = (t, x, y, z, ry = 0, sc = 1) => { if (!t) return; (bins.get(t) || bins.set(t, []).get(t)).push(new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, ry), V(sc, sc, sc))); };
    const T = n => find(n), far = n => find(n + '_lod1', n);
    // ---- private houses: three streets behind the road, fences along the fronts, sheds, wells, garden trees
    const houses = ['house_a', 'house_b', 'house_c', 'house_d', 'house_e'].map(T).filter(Boolean), gard = ['tree_oak_leafy', 'tree_walnut_leafy', 'tree_acacia_leafy'];
    const street = (z, x0, x1, near) => {
      for (let x = x0; x <= x1; x += 21 + R() * 8) {
        if (Math.abs(x - 30) < 34 && z < ROAD_Z - 50 && z > ROAD_Z - 110) continue;                      /* the church's yard */
        const hz = z - R() * 5;
        put(houses[Math.floor(R() * houses.length)], x, PLAIN, hz, Math.floor(R() * 4) * Math.PI / 2 + (R() - 0.5) * 0.08);
        if (R() < 0.55) put(T('shed_wood'), x + 7 + R() * 3, PLAIN, hz - 6 - R() * 4, R() * 6.28);
        if (R() < 0.2) put(T('well_village'), x - 6, PLAIN, hz + 3);
        for (let k = 0, n = 1 + Math.floor(R() * 3); k < n; k++) put((near ? T : far)(gard[Math.floor(R() * 3)]), x + (R() - 0.5) * 20, PLAIN, hz - 4 - R() * 14, R() * 6.28, 0.8 + R() * 0.45);
      }
      for (let x = x0 - 9; x <= x1 + 9; x += 18.05) put(T(R() < 0.5 ? 'fence_house_picket' : R() < 0.6 ? 'fence_house_plain' : 'fence_house_plain_brown'), x, PLAIN, z + 9.5);
    };
    street(ROAD_Z - 24, -300, 300, true); street(ROAD_Z - 58, -310, 310, false); street(ROAD_Z - 92, -300, 300, false);
    for (let x = -340; x <= 340; x += 30 + R() * 34) put(far('tree_poplar_leafy'), x, PLAIN, ROAD_Z - 41 - R() * 5, R() * 6.28, 0.9 + R() * 0.3);
    for (let x = -320; x <= 320; x += 55 + R() * 60) put(T('tree_poplar_leafy'), x, PLAIN, ROAD_Z - 11 - R() * 2, R() * 6.28, 0.9 + R() * 0.25);
    // ---- the church in its yard, the farm on the town's edge, the sub-station
    put(T('church_small'), 30, PLAIN, ROAD_Z - 80, Math.PI / 2, 1.25);
    for (const [dx, dz] of [[-24, 6], [-18, -16], [22, 10], [27, -12], [2, 18], [-8, -22]]) put(far('tree_oak_leafy'), 30 + dx, PLAIN, ROAD_Z - 80 + dz, R() * 6.28, 0.9 + R() * 0.3);
    put(T('barn_kolkhoz'), -262, PLAIN, ROAD_Z - 40, 0.2); put(T('water_tower'), -235, PLAIN, ROAD_Z - 62); put(T('machine_shed'), -292, PLAIN, ROAD_Z - 66, 1.4);
    put(T('substation_a'), 150, PLAIN, ROAD_Z - 118, 0.1);
    // ---- utility poles along the near verge (their wires: three sagging lines between the cross-arms)
    const wire = [];
    for (let x = -330; x <= 330; x += 44) {
      put(T('utility_pole'), x, PLAIN, ROAD_Z + 7.5);
      if (x < 330) for (const dz of [-0.75, -0.35, 0.35, 0.75]) for (let k = 0; k < 8; k++) { const u0 = k / 8, u1 = (k + 1) / 8, sag = u => -1.0 * 4 * u * (1 - u); wire.push(x + 44 * u0, PLAIN + 8.16 + sag(u0), ROAD_Z + 7.5 + dz, x + 44 * u1, PLAIN + 8.16 + sag(u1), ROAD_Z + 7.5 + dz); }
    }
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    scene.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x0c0c0c, transparent: true, opacity: 0.8 })));
    // ---- panel blocks: front facade (to the viewer) and both ends from kit pieces, a roof slab and a dark core behind them
    const W = 3.2, H = 2.8, dark = new THREE.MeshBasicMaterial({ color: 0x060606 }), roofM = new THREE.MeshStandardMaterial({ color: 0x1b1a19, roughness: 0.9 });
    this.fires = [];
    const block = (xc, zf, bays, floors, kind, hit = 0) => {
      const x0 = xc - bays * W / 2, x1 = x0 + bays * W, yb = PLAIN + 0.9, D = 4, top = yb + floors * H, K = n => T(n), pre = kind === 'wall' ? 'wall' : kind;
      const hb = hit ? 2 + Math.floor(R() * (bays - 4)) : -9, hf = hit ? 1 + Math.floor(R() * (floors - 2)) : -9;
      for (let i = 0; i < bays; i++) {
        put(K('plinth'), x0 + i * W, PLAIN, zf);
        for (let f = 0; f < floors; f++) {
          const d = Math.hypot(i - hb, (f - hf) * 1.3), y = yb + f * H, ent = f === 0 && i % 6 === 2, bal = !ent && f > 0 && i % 4 === 1;
          const st = d < 0.8 ? '_holed' : d < 1.9 ? '_damaged' : '_intact';
          put(K(`${pre}_${ent ? 'entrance' : bal ? 'balcony' : 'window'}${st}`) || K(`${pre}_window_intact`), x0 + i * W, y, zf);
          if (ent) put(K('entrance_canopy'), x0 + i * W, y, zf);
          if (bal && st !== '_holed') put(K(R() < 0.4 ? 'balcony_slab_glazed' : R() < 0.5 ? 'balcony_slab_open' : 'balcony_slab'), x0 + i * W, y, zf);
          if (d < 0.8) this.fires.push([x0 + (i + 0.5) * W, y + 1.4, zf + 0.5, 1.5 + R() * 1.5]);
        }
        put(K(kind === 'wall' ? 'roof_parapet' : `${kind}_parapet`) || K('roof_parapet'), x0 + i * W, top, zf);
      }
      for (let j = 0; j < D; j++) {
        put(K('plinth'), x1, PLAIN, zf - j * W, Math.PI / 2); put(K('plinth'), x0, PLAIN, zf - (j + 1) * W, -Math.PI / 2);
        for (let f = 0; f < floors; f++) { put(K(`${pre}_blank_end_intact`), x1, yb + f * H, zf - j * W, Math.PI / 2); put(K(`${pre}_blank_end_intact`), x0, yb + f * H, zf - (j + 1) * W, -Math.PI / 2); }
      }
      const core = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 - 0.7, top - PLAIN, D * W - 0.5), dark); core.position.set(xc, (top + PLAIN) / 2, zf - 0.4 - (D * W - 0.5) / 2); scene.add(core);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 - 0.2, 0.3, D * W - 0.2), roofM); roof.position.set(xc, top + 0.15, zf - D * W / 2); scene.add(roof);
      if (floors > 5) for (let k = 0, n = Math.max(1, Math.round(bays / 7)); k < n; k++) put(K('roof_machine_room'), x0 + ((k + 0.5) / n) * (x1 - x0) - 1.6, top + 0.3, zf - 4);
      for (let k = 0; k < bays / 5; k++) put(K(R() < 0.6 ? 'roof_vent' : 'roof_antenna'), x0 + R() * (x1 - x0 - 3.2), top + 0.3, zf - 3 - R() * 5);
    };
    for (const [x, z, bays, fl, kind, hit] of [[-250, -150, 18, 5, 'brick', 0], [-168, -172, 22, 5, 'brick_red', 1], [-92, -158, 14, 9, 'wall', 0], [-150, -236, 24, 9, 'wall', 1], [-40, -228, 20, 5, 'brick', 0],
      [86, -166, 18, 9, 'wall', 1], [150, -196, 22, 5, 'brick_red', 0], [120, -252, 18, 9, 'wall', 0], [222, -172, 20, 9, 'wall', 1], [292, -204, 22, 5, 'brick', 0], [20, -292, 28, 9, 'wall', 0], [-262, -262, 22, 9, 'wall', 0],
      [182, -238, 6, 14, 'wall', 0], [-206, -216, 6, 14, 'wall', 0]]) block(x, ROAD_Z + z, bays, fl, kind, hit);
    for (let k = 0; k < 60; k++) { const x = (R() - 0.5) * 660, z = ROAD_Z - 128 - R() * 160; put(far(R() < 0.4 ? 'tree_poplar_leafy' : gard[Math.floor(R() * 3)]), x, PLAIN, z, R() * 6.28, 0.9 + R() * 0.4); }
    // ---- one InstancedMesh per sub-mesh of every placed model
    const rel = new THREE.Matrix4(), inv = new THREE.Matrix4();
    for (const [t, Ms] of bins) {
      t.updateWorldMatrix(true, true); inv.copy(t.matrixWorld).invert();
      t.traverse(o => {
        if (!o.isMesh || o.visible === false) return;
        rel.multiplyMatrices(inv, o.matrixWorld);
        const im = new THREE.InstancedMesh(o.geometry, o.material, Ms.length); im.frustumCulled = false;
        Ms.forEach((M, i) => im.setMatrixAt(i, M4.multiplyMatrices(M, rel))); im.instanceMatrix.needsUpdate = true; scene.add(im);
      });
    }
    // fire light in the shelled flats
    const glowM = new THREE.SpriteMaterial({ map: this.dot('255,150,60'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
    this.glows = this.fires.map(([x, y, z, sz]) => { const sp = new THREE.Sprite(glowM.clone()); sp.position.set(x, y, z); sp.userData.s = sz * 6; scene.add(sp); return sp; });
    this.townIn = true; this._full = setTimeout(() => { this.full = true; }, 400);   /* the painted town goes now */
    if (window.__menu3d) window.__menu3d.town = bins.size;
  }
  soldiers(scene, sg, ag, rifle) {
    const clipOf = n => ag.animations.find(a => a.name === n);
    const man = (x, d, yaw, clip, combo, t0, ts) => {
      const m = SkeletonUtils.clone(sg.scene), keep = new Set([combo, combo + '_tape']), z = crestZ(x) + d;
      m.traverse(o => { if (!o.isMesh) return; o.frustumCulled = false; let n = o, hit = null; while (n) { if (keep.has(n.name.replace(/_LOD1$/, ''))) { hit = n; break; } n = n.parent; } o.visible = !!hit && !/_LOD1$/.test(hit.name); });
      m.position.set(x, FY + 0.03, z); m.rotation.y = yaw; scene.add(m);
      const mixer = new THREE.AnimationMixer(m), a = clipOf(clip) || clipOf('crouch_idle'); if (a) { const act = mixer.clipAction(a); act.timeScale = ts; act.play(); act.time = t0; }
      const w = rifle.scene.clone(true); w.traverse(o => { if (o.isMesh && /_LOD1$/i.test(o.name)) o.visible = false; }); m.getObjectByName('weapon_socket')?.add(w);
      const B = n => m.getObjectByName(n);
      return { m, mixer, yaw, spine: B('Spine1'), spine0: B('Spine'), neck: B('Neck'), head: B('Head'), ph: Math.random() * 6 };
    };
    // the watcher: kneeling 0.8 m behind the crest, body a quarter left so the rifle in his hands lies along the berm, head turned
    // back over the crest to the road; the other: sitting at the foot of the berm with his back on it, a little toward his mate
    const a = man(1.45, 0.82, Math.PI + 0.62, 'crouch_idle', 'combo_0', 0.4, 0.7); a.watch = true;
    // (v3: 'ride_sit_deck' is a man perched on a hull with his rifle upright between his knees - on the ground he hovered and held
    // it like a staff. This is the game's sitting-on-the-ground pose: back against the slope, one knee up, one leg out, a hand on
    // the knee; his rifle stands propped against the berm at his side)
    const b = man(2.85, 0.56, -0.3, 'wounded_sit', 'combo_2', 0.0, 0.0001); b.sit = true;
    const rw = b.m.getObjectByName('weapon_socket')?.children[0];
    if (rw) {
      const bx = 2.85 - 0.62, bz = crestZ(bx) + 0.54, by = FY + bermAt(bx, bz) + 0.05, zm = new THREE.Vector3(0, 0.86, -0.51).normalize(), ym = new THREE.Vector3(0, -0.51, -0.86).normalize(), xm = new THREE.Vector3().crossVectors(ym, zm);
      scene.add(rw); rw.matrix.makeBasis(xm, ym, zm); rw.matrix.decompose(rw.position, rw.quaternion, rw.scale); rw.position.set(bx, by, bz).addScaledVector(zm, 0.34);
    }
    this.men = [a, b];
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
    const bd = this.bd, t = this.t, tanH = Math.tan(VFOV / 2 * D2R) * this.cam.aspect;
    // the viewer shifts a little with the pointer (the painting's parallax, now a real one)
    this.cam.position.set((bd.px || 0) * 0.35 + Math.sin(t * 0.05) * 0.12, -(bd.py || 0) * 0.08, 0); this.cam.rotation.y = -(bd.px || 0) * 0.006;
    this.onCam?.(this.cam);   /* (dev: a close-up for checking the men) */
    // the two men: the clip, then life on top (breath, small shifts of weight, the watcher's eyes along the road, the sitter's head)
    for (const s of this.men) {
      s.mixer.update(dt);
      const br = Math.sin(t * 1.25 + s.ph), sw = Math.sin(t * 0.43 + s.ph * 1.7), sw2 = Math.sin(t * 0.71 + s.ph), look = Math.sin(t * 0.17 + s.ph) * 0.5 + Math.sin(t * 0.07 + s.ph * 2) * 0.5;
      if (s.watch) {
        s.spine0?.rotateX(0.16 + br * 0.006); s.spine?.rotateX(0.12 + br * 0.012); s.spine?.rotateY(-0.2 + sw * 0.015);
        s.neck?.rotateY(-0.16); s.neck?.rotateX(-0.14); s.head?.rotateY(-0.24 + look * 0.2); s.head?.rotateX(-0.12 + sw2 * 0.02);
      } else {
        s.spine?.rotateX(br * 0.012); s.spine?.rotateZ(sw2 * 0.006);
        s.neck?.rotateX(0.22); s.head?.rotateX(0.2 + sw * 0.03); s.head?.rotateY(0.3 + look * 0.22);   /* (the clip throws the head back: level it, eyes to his mate / the viewer) */
      }
    }
    // the convoy: the backdrop's timing (v.x in its pixels across the view) on the 3-D road
    const [ox] = bd._mo || [0], W = bd.W, seen = new Set(), half = tanH * -ROAD_Z;
    for (const v of bd.convoy || []) {
      const K = this.veh[v.k]; if (!K) continue;
      let o = this.pool.get(v);
      if (!o) { o = K.src.clone(true); this.scene.add(o); this.pool.set(v, o); }
      seen.add(v);
      const img = bd.vehSprites[v.k], nx = (v.x + ox + img.width / 2) / W * 2 - 1;
      o.position.set(nx * half, PLAIN + 0.06 + Math.sin(t * 9 + v.ph) * 0.015, ROAD_Z + (v.dir > 0 ? 1.7 : -1.7));
      o.rotation.y = v.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      if (Math.random() < dt * 7) { const d = this.dust.find(q => q.userData.life >= q.userData.max || !q.visible); if (d) { d.visible = true; d.userData.life = 0; d.userData.max = 2.2 + Math.random() * 1.8; d.userData.vx = -v.dir * (0.6 + Math.random()); d.position.set(o.position.x - v.dir * (K.len / 2 + 0.5), PLAIN + 0.7, o.position.z + (Math.random() - 0.5) * 2); d.userData.r = 1.6 + Math.random(); } }
    }
    for (const [v, o] of this.pool) if (!seen.has(v)) { this.scene.remove(o); this.pool.delete(v); }
    for (const d of this.dust) { if (!d.visible) continue; const u = d.userData; u.life += dt; if (u.life >= u.max) { d.visible = false; continue; } const k = u.life / u.max; d.position.x += u.vx * dt; d.position.y += 0.5 * dt; const r = u.r * (1 + k * 3.2); d.scale.set(r * 1.6, r, 1); d.material.opacity = 0.34 * Math.min(1, u.life / 0.3) * (1 - k); }
    for (const [i, g] of (this.glows || []).entries()) { const f = 0.75 + 0.18 * Math.sin(t * 11 + i * 3) + 0.1 * Math.sin(t * 23 + i * 1.7); g.scale.setScalar(g.userData.s * f); g.material.opacity = 0.8 * f; }
    this.renderer.render(this.scene, this.cam);
  }
}
