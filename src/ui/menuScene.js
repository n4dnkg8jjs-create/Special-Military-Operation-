import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
    this._full = setTimeout(() => { this.full = true; }, 1700);
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
    const sun = new THREE.DirectionalLight(0xd98a45, 2.6); sun.position.set(150, 26, -230); scene.add(sun);          // last light, low on the right horizon
    const fill = new THREE.DirectionalLight(0x5c6878, 1.0); fill.position.set(-40, 60, 60); scene.add(fill);       // sky behind the viewer
    const near = new THREE.PointLight(0x7f8894, 9, 10, 1.6); near.position.set(0.6, 0.5, -4.6); scene.add(near);   /* what is left of the sky on the two men and the berm beside them (they were black on black) */
    this.cam = new THREE.PerspectiveCamera(VFOV, 16 / 9, 1.2, 1400); this.cam.rotation.order = 'YXZ'; this.cam.rotation.x = PITCH;
    this.resize(); addEventListener('resize', this._rs = () => this.resize());
    this.world(scene);
    this.soldiers(scene, sg, ag, rifle);
    this.clock = performance.now(); this.ready = true; this.show();
    window.__menu3d = { men: this.men.length, veh: 0, scene: this };
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
  // the land and the town: everything static, merged into one mesh per material
  world(scene) {
    const R = rng(1917), bins = {}, M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = (x, y, z) => new THREE.Vector3(x, y, z);
    const put = (g, mat, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1) => { g = g.index ? g.toNonIndexed() : g; g.applyMatrix4(M4.compose(V(x, y, z), Q.setFromAxisAngle(V(0, 1, 0), ry), V(sx, sy, sz))); for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k); (bins[mat] ||= []).push(g); };
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    const gable = (w, h, l) => {   // roof: ridge along z
      const a = w / 2, b = l / 2, p = [[-a, 0, b], [a, 0, b], [0, h, b], [-a, 0, -b], [a, 0, -b], [0, h, -b]], f = [[0, 1, 2], [4, 3, 5], [1, 4, 5], [1, 5, 2], [3, 0, 2], [3, 2, 5]];
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(f.flat().flatMap(i => p[i]), 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(36).fill(0), 2)); g.computeVertexNormals(); return g;
    };
    const mats = {
      ground: new THREE.MeshStandardMaterial({ color: 0x16140f, roughness: 1 }), berm: new THREE.MeshStandardMaterial({ color: 0x74624c, roughness: 1 }),
      road: new THREE.MeshStandardMaterial({ color: 0x23211d, roughness: 0.95 }),
      wallA: new THREE.MeshStandardMaterial({ color: 0x57524a, roughness: 0.95 }), wallB: new THREE.MeshStandardMaterial({ color: 0x3b2f28, roughness: 0.95 }), wallC: new THREE.MeshStandardMaterial({ color: 0x464a45, roughness: 0.95 }),
      roof: new THREE.MeshStandardMaterial({ color: 0x1d1c1c, roughness: 0.8 }), roofR: new THREE.MeshStandardMaterial({ color: 0x2c1e17, roughness: 0.85 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x07080a, roughness: 0.35, metalness: 0.2 }), lit: new THREE.MeshBasicMaterial({ color: 0xe9a35a, fog: true }),
      church: new THREE.MeshStandardMaterial({ color: 0x625c52, roughness: 0.9 }), dome: new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.45, metalness: 0.55 }),
      leaf: new THREE.MeshStandardMaterial({ color: 0x0f120d, roughness: 1 }), wood: new THREE.MeshStandardMaterial({ color: 0x14110e, roughness: 1 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x1a1816, roughness: 0.7, metalness: 0.4 }),
    };
    // ---- terrain (coarse) + the hilltop patch with the berm (fine); the patch's rim is sunk under the terrain
    const tg = new THREE.PlaneGeometry(1500, 1300, 100, 130); tg.rotateX(-Math.PI / 2); tg.translate(0, 0, -560);
    let P = tg.attributes.position;
    for (let i = 0; i < P.count; i++) { const x = P.getX(i), z = P.getZ(i); P.setY(i, hill(z) + (z < -30 ? Math.sin(x * 0.021 + 1) * Math.cos(z * 0.017) * 0.5 * sstep(-30, -90, z) : 0)); }
    tg.computeVertexNormals(); scene.add(new THREE.Mesh(tg, mats.ground));
    const bg = new THREE.PlaneGeometry(48, 10, 240, 96); bg.rotateX(-Math.PI / 2); bg.translate(2, 0, -7);
    P = bg.attributes.position;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), z = P.getZ(i), e = Math.min(sstep(-22, -19, x), 1 - sstep(23, 26, x), sstep(-12, -11, z), 1 - sstep(-3, -2, z));
      P.setY(i, FY + (bermAt(x, z) + 0.035 + (Math.sin(x * 4.3 + z * 2.9) + Math.sin(x * 9.1 - z * 6.7) * 0.5) * 0.012) * e - 0.25 * (1 - e));
    }
    bg.computeVertexNormals(); scene.add(new THREE.Mesh(bg, mats.berm));
    // ---- the road across the plain, verges, a farm track up to it
    const py = PLAIN + 0.03;
    put(box(1500, 0.06, 7.5), 'road', 0, py, ROAD_Z);
    put(box(5, 0.05, 80), 'road', -64, py - 0.005, ROAD_Z - 40, 0.12);
    // ---- power line on the near verge: poles, cross-arms, three sagging wires
    const wire = [];
    for (let x = -330; x <= 330; x += 44) {
      put(new THREE.CylinderGeometry(0.11, 0.15, 9.5, 6), 'wood', x, PLAIN + 4.75, ROAD_Z + 7.5);
      put(box(2.2, 0.14, 0.14), 'wood', x, PLAIN + 8.9, ROAD_Z + 7.5);
      if (x < 330) for (const dx of [-0.95, 0, 0.95]) for (let k = 0; k < 8; k++) { const u0 = k / 8, u1 = (k + 1) / 8, sag = u => -1.1 * 4 * u * (1 - u); wire.push(x + dx + 44 * u0, PLAIN + 9.0 + sag(u0), ROAD_Z + 7.5, x + dx + 44 * u1, PLAIN + 9.0 + sag(u1), ROAD_Z + 7.5); }
    }
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    scene.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x0c0c0c, transparent: true, opacity: 0.8 })));
    // ---- anti-tank hedgehogs on the far verge (off the carriageway)
    for (const x of [-52, -47.5, 22, 26.5, 31, 78]) for (const [ax, an] of [[V(1, 0, 0), 0.62], [V(0, 0, 1), 0.62], [V(1, 0, 1).normalize(), -0.95]]) {
      const g = box(0.13, 1.7, 0.13).toNonIndexed(); g.applyMatrix4(M4.makeRotationAxis(ax, an)); put(g, 'steel', x, PLAIN + 0.55, ROAD_Z - 8.5 - (x % 3) * 0.4, x * 0.7);
    }
    // ---- trees
    const poplar = (x, z, h) => { put(new THREE.CylinderGeometry(0.14, 0.24, h * 0.3, 5), 'wood', x, PLAIN + h * 0.15, z); put(new THREE.SphereGeometry(1, 7, 6), 'leaf', x, PLAIN + h * 0.58, z, R() * 3, h * 0.085 + 0.5, h * 0.44, h * 0.085 + 0.5); };
    // (garden / street trees: a forked trunk and a ragged crown of many small clumps - three big balls read as lollipops)
    const tree = (x, z, h) => {
      put(new THREE.CylinderGeometry(0.1, 0.24, h * 0.55, 5), 'wood', x, PLAIN + h * 0.275, z);
      for (let k = 0; k < 3; k++) { const a = R() * 6.28, g = new THREE.CylinderGeometry(0.05, 0.11, h * 0.4, 4).toNonIndexed(); g.translate(0, h * 0.2, 0); g.applyMatrix4(M4.makeRotationAxis(V(Math.cos(a), 0, Math.sin(a)), 0.5 + R() * 0.4)); put(g, 'wood', x, PLAIN + h * 0.45, z); }
      for (let k = 0; k < 9; k++) { const a = R() * 6.28, rr = h * 0.3 * Math.sqrt(R()), s0 = h * (0.1 + R() * 0.07); put(new THREE.IcosahedronGeometry(1, 1), 'leaf', x + Math.cos(a) * rr, PLAIN + h * (0.58 + R() * 0.36) - rr * 0.35, z + Math.sin(a) * rr, R() * 3, s0 * (1 + R() * 0.4), s0 * (0.75 + R() * 0.3), s0 * (1 + R() * 0.4)); }
    };
    // ---- private houses: two streets behind the road, gable to the street or along it, sheds, garden trees
    const house = (x, z, ry) => {
      const w = 6.5 + R() * 2.5, l = 8 + R() * 3.5, hw = 2.9 + R() * 0.5, hr = 2.2 + R() * 1.1, wm = ['wallA', 'wallB', 'wallC'][Math.floor(R() * 3)], rm = R() < 0.45 ? 'roofR' : 'roof';
      const c = Math.cos(ry), s = Math.sin(ry), at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
      put(box(w, hw, l), wm, x, PLAIN + hw / 2, z, ry); put(gable(w + 0.7, hr, l + 0.7), rm, x, PLAIN + hw, z, ry);
      let [cx, cz] = at(w * 0.18, -l * 0.2); put(box(0.5, 1.5, 0.5), 'wallB', cx, PLAIN + hw + hr * 0.75, cz, ry);
      // windows on the long walls (toward the viewer one of them may be lit), a door
      for (const sd of [-1, 1]) for (const k of [-1, 0, 1]) { const [wx, wz] = at(sd * (w / 2 + 0.04), k * l * 0.3); put(box(0.05, 1.15, 0.9), R() < 0.1 ? 'lit' : 'glass', wx, PLAIN + hw * 0.56, wz, ry); }
      for (const sd of [-1, 1]) { const [wx, wz] = at(0, sd * (l / 2 + 0.04)); put(box(1.0, 1.15, 0.05), R() < 0.12 ? 'lit' : 'glass', wx, PLAIN + hw * 0.56, wz, ry); }
      if (R() < 0.6) { const [sx, sz] = at(w * 0.5 + 2.5 + R() * 2, l * 0.3); put(box(3, 2.1, 4), 'wallB', sx, PLAIN + 1.05, sz, ry); put(gable(3.5, 0.9, 4.5), 'roof', sx, PLAIN + 2.1, sz, ry); }
      const n = 1 + Math.floor(R() * 3); for (let k = 0; k < n; k++) { const [tx, tz] = at((R() < 0.5 ? -1 : 1) * (w * 0.5 + 3 + R() * 6), (R() - 0.5) * 18 - 4); (R() < 0.3 ? poplar : tree)(tx, tz, R() < 0.3 ? 15 + R() * 5 : 6 + R() * 4); }
    };
    for (let x = -300; x <= 300; x += 21 + R() * 9) if (Math.abs(x + 64) > 9) house(x, ROAD_Z - 24 - R() * 6, (R() < 0.6 ? Math.PI / 2 : 0) + (R() - 0.5) * 0.12);
    for (let x = -310; x <= 310; x += 24 + R() * 12) house(x, ROAD_Z - 62 - R() * 10, (R() < 0.5 ? Math.PI / 2 : 0) + (R() - 0.5) * 0.12);
    for (let x = -340; x <= 340; x += 26 + R() * 30) poplar(x, ROAD_Z - 44 - R() * 8, 16 + R() * 6);       // the lane between the two streets
    for (let x = -300; x <= 300; x += 50 + R() * 60) poplar(x, ROAD_Z - 12 - R() * 3, 15 + R() * 5);
    // ---- the church: nave and apse, bell tower over the west door with a tented spire, drum + onion dome over the crossing, crosses
    const onion = (rr, hh) => new THREE.LatheGeometry([[0.62, 0], [0.9, 0.12], [1.0, 0.3], [0.9, 0.52], [0.55, 0.72], [0.2, 0.9], [0.05, 1.0], [0, 1.0]].map(([a, b]) => new THREE.Vector2(a * rr, b * hh)), 12);
    const cross = (x, y, z, k) => { put(box(0.14 * k, 2.4 * k, 0.14 * k), 'dome', x, y + 1.2 * k, z); put(box(1.1 * k, 0.14 * k, 0.14 * k), 'dome', x, y + 1.7 * k, z); put(box(0.6 * k, 0.12 * k, 0.12 * k), 'dome', x, y + 2.1 * k, z); };
    {
      const cx = 16, cz = ROAD_Z - 118, y0 = PLAIN;
      put(box(24, 11, 12), 'church', cx, y0 + 5.5, cz); put(gable(13, 3.2, 24.6), 'roof', cx, y0 + 11, cz, Math.PI / 2);
      put(new THREE.CylinderGeometry(5.2, 5.2, 9, 10, 1, false, 0, Math.PI), 'church', cx + 12, y0 + 4.5, cz, -Math.PI / 2); put(new THREE.SphereGeometry(5.2, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), 'dome', cx + 12, y0 + 9, cz);
      put(new THREE.CylinderGeometry(3.6, 3.6, 7, 10), 'church', cx + 3, y0 + 16.5, cz); put(onion(4.6, 7.5), 'dome', cx + 3, y0 + 20, cz); cross(cx + 3, y0 + 27.3, cz, 1);
      for (const [dx, dz] of [[-2.5, 4.6], [8.5, 4.6], [-2.5, -4.6], [8.5, -4.6]]) { put(new THREE.CylinderGeometry(1.2, 1.2, 4, 8), 'church', cx + dx, y0 + 14.5, cz + dz); put(onion(1.7, 3), 'dome', cx + dx, y0 + 16.5, cz + dz); cross(cx + dx, y0 + 19.4, cz + dz, 0.55); }
      put(box(7, 22, 7), 'church', cx - 13, y0 + 11, cz); put(new THREE.CylinderGeometry(3.4, 3.6, 6, 8), 'church', cx - 13, y0 + 25, cz);
      for (let k = 0; k < 4; k++) put(box(1.4, 3.2, 0.3), 'glass', cx - 13 + Math.sin(k * Math.PI / 2) * 3.45, y0 + 25, cz + Math.cos(k * Math.PI / 2) * 3.45, k * Math.PI / 2);   // belfry openings
      put(new THREE.ConeGeometry(3.9, 11, 8), 'dome', cx - 13, y0 + 33.5, cz); put(onion(1.5, 2.6), 'dome', cx - 13, y0 + 38.6, cz); cross(cx - 13, y0 + 41, cz, 0.8);
      for (const k of [-1, 0, 1]) for (const sd of [-1, 1]) put(box(1.2, 4.6, 0.12), 'glass', cx + k * 6.5, y0 + 6, cz + sd * 6.05);
      for (const [tx, tz] of [[-26, 8], [-22, -14], [30, 10], [34, -8], [2, 16]]) tree(cx + tx, cz + tz, 9 + R() * 4);
    }
    // ---- panel blocks behind: window grid as a small tiled texture, a few lit and a few burnt-out flats
    const facade = (wall, seam) => {
      const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
      x.fillStyle = wall; x.fillRect(0, 0, 64, 64); x.fillStyle = seam; x.fillRect(0, 0, 64, 2); x.fillRect(0, 0, 2, 64);
      x.fillStyle = '#0b0c0e'; x.fillRect(18, 16, 30, 30); x.fillStyle = wall; x.fillRect(32, 16, 2, 30);
      const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
    };
    mats.panel = new THREE.MeshStandardMaterial({ map: facade('#5d5a54', '#3f3d39'), roughness: 0.95 }); mats.brick = new THREE.MeshStandardMaterial({ map: facade('#4a3a31', '#33281f'), roughness: 0.95 });
    this.fires = [];
    const block = (x, z, w, d, floors, mat, ry = 0) => {
      const h = floors * 2.9 + 1, g = box(w, h, d), uv = g.attributes.uv, nw = Math.round(w / 3.1), nd = Math.round(d / 3.1);
      for (let i = 0; i < uv.count; i++) { const f = Math.floor(i / 4); uv.setXY(i, uv.getX(i) * (f < 2 ? nd : f < 4 ? 0 : nw), uv.getY(i) * (f >= 2 && f < 4 ? 0 : floors)); }
      put(g, mat, x, PLAIN + h / 2, z, ry); put(box(w - 1.2, 0.5, d - 1.2), 'roof', x, PLAIN + h + 0.25, z, ry);
      for (let k = 0; k < Math.round(w / 20) + 1; k++) put(box(3, 2.6, 3), 'roof', x + ((k + 0.5) / (Math.round(w / 20) + 1) - 0.5) * w * Math.cos(ry), PLAIN + h + 1.5, z, ry);   // stair-head / lift huts
      if (ry === 0) {
        for (let k = 0; k < nw * floors * 0.035; k++) put(box(1.45, 1.4, 0.06), 'lit', x - w / 2 + (Math.floor(R() * nw) + 0.52) * (w / nw), PLAIN + (Math.floor(R() * floors) + 0.52) * (h / floors), z + d / 2 + 0.05);
        if (R() < 0.55) { const fx = x - w / 2 + (Math.floor(R() * nw) + 0.52) * (w / nw), fl = 1 + Math.floor(R() * (floors - 1)), fy = PLAIN + (fl + 0.52) * (h / floors); put(box(3.6, 5.2, 0.07), 'glass', fx, fy + 1.6, z + d / 2 + 0.06); this.fires.push([fx, fy, z + d / 2 + 0.4, 1.6 + R() * 1.6]); }   // soot above a burning flat
      }
    };
    for (const [x, z, w, fl, m] of [[-250, -150, 62, 5, 'brick'], [-170, -175, 70, 5, 'panel'], [-95, -160, 46, 9, 'panel'], [-150, -235, 80, 9, 'panel'], [-40, -230, 66, 5, 'brick'], [70, -165, 58, 9, 'panel'], [135, -190, 74, 5, 'brick'], [118, -250, 60, 9, 'panel'], [215, -170, 64, 9, 'panel'], [290, -200, 70, 5, 'brick'], [20, -290, 90, 9, 'panel'], [-260, -260, 70, 9, 'panel']]) block(x, ROAD_Z + z, w, 12.5, fl, m);
    for (const [x, z] of [[178, -235], [-205, -215], [250, -265]]) block(x, ROAD_Z + z, 20, 20, 16, 'panel');          // point blocks
    for (const [x, z, w, fl] of [[-118, -200, 46, 5], [182, -150, 50, 5]]) block(x, ROAD_Z + z, w, 12.5, fl, 'brick', Math.PI / 2);
    for (let k = 0; k < 46; k++) { const x = (R() - 0.5) * 640, z = ROAD_Z - 135 - R() * 150; (R() < 0.35 ? poplar : tree)(x, z, R() < 0.35 ? 17 + R() * 6 : 8 + R() * 5); }
    put(new THREE.CylinderGeometry(2.2, 3.4, 62, 10), 'church', -330, PLAIN + 31, ROAD_Z - 330);                         // boiler-house chimney on the far edge
    for (const k of Object.keys(bins)) { const m = new THREE.Mesh(mergeGeometries(bins[k], false), mats[k]); m.matrixAutoUpdate = false; scene.add(m); for (const g of bins[k]) g.dispose(); }
    // ---- fire light in the burning flats, dust behind the convoy: soft sprites
    const dot = (rgb) => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, `rgba(${rgb},1)`); g.addColorStop(0.35, `rgba(${rgb},.45)`); g.addColorStop(1, `rgba(${rgb},0)`); x.fillStyle = g; x.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
    const glowM = new THREE.SpriteMaterial({ map: dot('255,150,60'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
    this.glows = this.fires.map(([x, y, z, s]) => { const sp = new THREE.Sprite(glowM.clone()); sp.position.set(x, y, z); sp.userData.s = s * 7; scene.add(sp); return sp; });
    const dustM = new THREE.SpriteMaterial({ map: dot('120,108,92'), depthWrite: false, transparent: true, opacity: 0 });
    this.dust = Array.from({ length: 44 }, () => { const sp = new THREE.Sprite(dustM.clone()); sp.visible = false; sp.userData.life = 9; scene.add(sp); return sp; });
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
    const b = man(2.85, 0.5, -0.32, 'ride_sit_deck', 'combo_2', 1.6, 0.6); b.sit = true;
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
        s.spine0?.rotateX(-0.1 + br * 0.006); s.spine?.rotateX(-0.06 + br * 0.012); s.spine?.rotateZ(sw2 * 0.006);
        s.neck?.rotateX(0.08); s.head?.rotateY(0.3 + look * 0.22); s.head?.rotateX(0.06 + sw * 0.03);
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
