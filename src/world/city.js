import * as THREE from 'three';
import { NavGrid, BLOCK } from './nav.js';
import { Building, KitPool } from './buildings.js';
import { instance, trs } from './instancer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Map 1 — Novozavodsk eastern microdistrict. North (−Z) is the attacker's side.
export const MAP_SIZE = 520, BOUNDS = 245;
const E = MAP_SIZE / 2 + 2;
export const ROADS = [
  { x0: -E, x1: E, z0: -10, z1: 10, w: 'avenue' },       // Prospekt Myru (E–W)
  { x0: -102, x1: -88, z0: -E, z1: E },                   // vul. Shkilna (N–S)
  { x0: 78, x1: 92, z0: -E, z1: E },                      // vul. Zavodska (N–S)
  { x0: -E, x1: E, z0: -116, z1: -104 },                  // north E–W
  { x0: -E, x1: E, z0: 99, z1: 111 },                     // south E–W
  { x0: -E, x1: E, z0: -201, z1: -193 },                  // northern outskirts lane
  { x0: -E, x1: E, z0: 193, z1: 201 },                    // southern outskirts lane
  { x0: -208, x1: -200, z0: -E, z1: E },                  // western ring road
  { x0: 198, x1: 206, z0: -E, z1: E },                    // eastern ring road
];
const SIDEWALK = 3.2;
export const OBJECTIVES = [
  { id: 'A', name: 'School No. 7', x: -62, z: 50 },
  { id: 'B', name: 'Market Crossroads', x: 95, z: 12 },
];
// Staging grounds for the deployment phase (axis-aligned rectangles in world metres)
export const DEPLOY_ZONES = {
  player: { x0: -240, x1: 240, z0: 203, z1: 250 },
  enemy: { x0: -240, x1: 240, z0: -250, z1: -203 },
};
export const SPAWNS = {
  attacker: [[-95, -240], [85, -240], [-30, -235], [150, -238]],
  defender: [[-95, 240], [85, 240], [0, 235]],
};
// x, z, rot, modules, floors, depthModules, sections, kind, predamage
// x, z, rot, modules, floors, depthModules, sections, kind, predamage, opts
const BUILDINGS = [
  [-150, -150, 0, 15, 5, 4, 3, 'brick', 1.0], [-150, -60, 0, 15, 9, 4, 3, 'nine', 1.2],
  [-30, -150, 0, 18, 5, 4, 4, 'khrushchyovka', 0.9], [-40, -60, Math.PI / 2, 12, 5, 4, 3, 'khrushchyovka', 1.3],
  [30, -68, 0, 12, 9, 4, 2, 'nine', 1.4], [150, -150, Math.PI / 2, 15, 5, 4, 3, 'khrushchyovka', 0.8],
  [150, -55, 0, 12, 5, 4, 3, 'brick', 1.2], [40, -160, 0, 10, 5, 4, 2, 'khrushchyovka', 0.7],
  [-60, 40, Math.PI, 10, 3, 4, 2, 'school', 1.0], [-78, 62, Math.PI / 2, 6, 3, 4, 1, 'school', 0.9],
  [-150, 50, Math.PI / 2, 15, 9, 4, 3, 'nine', 1.1], [10, 60, 0, 12, 5, 4, 3, 'brick', 1.0],
  [40, 28, Math.PI, 12, 5, 4, 3, 'khrushchyovka', 1.2, { shops: true }], [140, 70, 0, 14, 5, 4, 3, 'khrushchyovka', 0.9],
  [112, 26, Math.PI, 6, 2, 3, 1, 'shop', 1.0, { shops: true }], [-140, 150, 0, 15, 5, 4, 3, 'khrushchyovka', 0.6],
  [-20, 150, 0, 18, 9, 4, 3, 'nine', 0.7], [140, 160, Math.PI / 2, 12, 5, 4, 3, 'khrushchyovka', 0.5],
  // infill (appended so indices above stay stable)
  [-70, -160, Math.PI / 2, 8, 5, 4, 2, 'khrushchyovka', 1.0], [-140, -30, 0, 12, 5, 4, 3, 'brick', 1.3, { shops: true }],
  [-65, -80, Math.PI / 2, 10, 9, 4, 2, 'nine', 1.3], [30, -35, 0, 10, 5, 4, 2, 'khrushchyovka', 1.4, { shops: true }],
  [130, -80, 0, 10, 5, 4, 2, 'khrushchyovka', 1.1], [120, -160, Math.PI / 2, 10, 5, 4, 2, 'khrushchyovka', 0.8],
  [-150, 128, 0, 10, 5, 4, 2, 'brick', 0.6], [55, 75, Math.PI / 2, 8, 5, 4, 2, 'khrushchyovka', 0.9],
  [150, 30, Math.PI / 2, 8, 9, 4, 2, 'nine', 1.0], [-20, 25, Math.PI, 8, 5, 4, 2, 'brick', 1.1, { shops: true }],
  [50, 150, 0, 12, 5, 4, 3, 'khrushchyovka', 0.5],
  // outer ring: 9-storeys, 12–16-storey point towers, brick blocks
  [232, -150, Math.PI / 2, 12, 9, 4, 3, 'nine', 1.0], [232, -45, 0, 6, 16, 6, 1, 'tower', 1.1], [232, 72, Math.PI / 2, 14, 5, 4, 3, 'brick', 0.8],
  [232, 160, 0, 6, 12, 6, 1, 'tower', 0.6], [-232, -150, Math.PI / 2, 14, 5, 4, 3, 'brick', 1.0], [-232, -45, 0, 6, 16, 6, 1, 'tower', 1.2],
  [-232, 60, Math.PI / 2, 15, 9, 4, 3, 'nine', 0.9], [-232, 160, 0, 6, 12, 6, 1, 'tower', 0.5],
  [-10, -88, 0, 6, 14, 6, 1, 'tower', 1.3], [150, 124, 0, 10, 5, 4, 2, 'brick', 0.7, { shops: true }],
];

function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const onRoad = (x, z, pad = 0) => ROADS.some(r => x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad);

export class City {
  constructor(scene, assets, quality) {
    this.scene = scene; this.assets = assets; this.quality = quality;
    this.rng = mulberry(7031);
    this.nav = new NavGrid(MAP_SIZE, 1);
    this.buildings = []; this.dynamic = new THREE.Group(); scene.add(this.dynamic);
    this.burning = []; this.wrecks = [];
  }
  build() {
    this.ground(); this.roads();
    this.placeBuildings();
    this.rubbleAndDebris();
    this.trees(); this.poles(); this.props(); this.dressing(); this.defences();
    this.craters(); this.skyline();
    this.nav.finalize();
  }
  // ---------------------------------------------------------------- ground
  mat(name, repeat, extra = {}) {
    const t = this.assets.tex[name] || {};
    const p = { roughness: 0.95, ...extra };
    for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap']) if (t[k]) { p[k] = t[k].clone(); p[k].needsUpdate = true; p[k].repeat.set(repeat, repeat); }
    if (p.roughnessMap) p.roughness = 1;
    return new THREE.MeshStandardMaterial(p);
  }
  ground() {
    const g = new THREE.PlaneGeometry(MAP_SIZE + 400, MAP_SIZE + 400, 1, 1); g.rotateX(-Math.PI / 2);
    const m = this.mat('dirt', (MAP_SIZE + 400) / 6, { color: 0xb9ad98 });
    const ground = new THREE.Mesh(g, m); ground.receiveShadow = true; ground.name = 'ground'; this.scene.add(ground);
    this.groundMesh = ground;
    // rubble-strewn ground patches near buildings + dead grass in courtyards
    const rub = this.mat('rubble', 2.5);
    const patches = [];
    for (const b of BUILDINGS) for (let i = 0; i < 4; i++) {
      const [x, , z] = [b[0] + (this.rng() - 0.5) * b[3] * 3, 0, b[1] + (this.rng() - 0.5) * 30];
      if (onRoad(x, z, 2)) continue; patches.push([x, z, 8 + this.rng() * 10]);
    }
    for (const [x, z, r] of patches) {
      const pg = new THREE.CircleGeometry(r, 20); pg.rotateX(-Math.PI / 2);
      const pos = pg.attributes.position; for (let i = 1; i < pos.count; i++) { const k = 0.7 + this.rng() * 0.45; pos.setX(i, pos.getX(i) * k); pos.setZ(i, pos.getZ(i) * k); }
      const pm = new THREE.Mesh(pg, rub); pm.position.set(x, 0.015, z); pm.receiveShadow = true; this.scene.add(pm);
    }
  }
  roads() {
    const asphalt = this.mat('asphalt', 1, { color: 0xd8d4cc, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const walk = this.mat('concrete', 1, { color: 0xbab4a8, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0x9d988c, roughness: 0.9 });
    const uvPlane = (w, d, scale) => { const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / scale, uv.getY(i) * d / scale); return g; };
    for (const r of ROADS) {
      const w = r.x1 - r.x0, d = r.z1 - r.z0;
      const s = new THREE.Mesh(uvPlane(w + SIDEWALK * 2, d + SIDEWALK * 2, 4), walk); s.position.set((r.x0 + r.x1) / 2, 0.03, (r.z0 + r.z1) / 2); s.receiveShadow = true; this.scene.add(s);
    }
    for (const r of ROADS) {
      const w = r.x1 - r.x0, d = r.z1 - r.z0;
      const a = new THREE.Mesh(uvPlane(w, d, 7), asphalt); a.position.set((r.x0 + r.x1) / 2, 0.05, (r.z0 + r.z1) / 2); a.receiveShadow = true; this.scene.add(a);
      // lane markings (worn)
      const horiz = w > d; const len = horiz ? w : d;
      const dash = new THREE.MeshStandardMaterial({ color: 0xc9c5b8, roughness: 0.9, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -3 });
      const mats = [];
      for (let t = -len / 2 + 2; t < len / 2; t += 9) if (this.rng() > 0.25) mats.push(horiz ? trs((r.x0 + r.x1) / 2 + t, 0.06, (r.z0 + r.z1) / 2, 0) : trs((r.x0 + r.x1) / 2, 0.06, (r.z0 + r.z1) / 2 + t, Math.PI / 2));
      const dg = new THREE.PlaneGeometry(3, 0.15); dg.rotateX(-Math.PI / 2);
      instance(this.scene, new THREE.Mesh(dg, dash), mats, { shadows: false });
    }
    // curbs along road edges, broken at intersections
    const curbs = [];
    for (const r of ROADS) {
      const horiz = (r.x1 - r.x0) > (r.z1 - r.z0);
      for (const edge of horiz ? [r.z0, r.z1] : [r.x0, r.x1]) {
        const from = horiz ? r.x0 : r.z0, to = horiz ? r.x1 : r.z1;
        for (let t = from; t < to; t += 1.0) {
          const x = horiz ? t + 0.5 : edge, z = horiz ? edge : t + 0.5;
          if (ROADS.some(o => o !== r && x > o.x0 - 0.5 && x < o.x1 + 0.5 && z > o.z0 - 0.5 && z < o.z1 + 0.5)) continue;
          if (this.rng() < 0.04) continue; // missing curb stones
          curbs.push(trs(x, 0.08, z, horiz ? 0 : Math.PI / 2, 1, 0, (this.rng() - .5) * 0.04));
        }
      }
    }
    const cg = new THREE.BoxGeometry(0.98, 0.2, 0.22);
    instance(this.scene, new THREE.Mesh(cg, curbMat), curbs);
  }
  // ---------------------------------------------------------------- buildings
  placeBuildings() {
    const kit = this.assets.kit;
    this.pool = new KitPool(this.scene, kit);
    const signNames = Object.keys(kit.pieces).filter(k => /^sign_.*_intact$/.test(k));
    for (const [x, z, rot, modules, floors, depthModules, sections, kind, dmg, extra] of BUILDINGS) {
      const b = new Building({ x, z, rot, modules, floors, depthModules, sections, kind, ...(extra || {}), signNames }, kit);
      b.predamage(dmg);
      this.buildings.push(b);
    }
    // a pancaked section on the nine-storey at (30,-68) and the one at (-150,-60)
    this.buildings[4].pancake(4, 6); this.buildings[1].pancake(9, 10);
    const aabb = b => { const c = Math.abs(Math.cos(b.rot)), sn = Math.abs(Math.sin(b.rot)); const hx = (b.L * c + b.D * sn) / 2, hz = (b.L * sn + b.D * c) / 2; return [b.x - hx, b.x + hx, b.z - hz, b.z + hz]; };
    this.buildings.forEach((b, i) => { const A = aabb(b);
      this.buildings.forEach((o, j) => { if (j <= i) return; const B = aabb(o); if (A[0] < B[1] && A[1] > B[0] && A[2] < B[3] && A[3] > B[2]) console.warn('building overlap', i, j); });
      for (const r of ROADS) if (A[0] < r.x1 + SIDEWALK && A[1] > r.x0 - SIDEWALK && A[2] < r.z1 + SIDEWALK && A[3] > r.z0 - SIDEWALK) console.warn('building on road', i, JSON.stringify(r)); });
    for (const b of this.buildings) b.requestKit(this.pool);
    this.pool.build();
    for (const b of this.buildings) b.place(this.pool);
    this.pool.finish();
    // interiors (instanced boxes)
    const cnt = this.buildings.reduce((a, b) => a + b.modules * b.floors, 0);
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x8a857c, roughness: 0.95 });
    const wp = document.createElement('canvas'); wp.width = 64; wp.height = 64; { const x = wp.getContext('2d'); x.fillStyle = '#5a5246'; x.fillRect(0, 0, 64, 64); for (let i = 0; i < 64; i += 8) { x.fillStyle = i % 16 ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.05)'; x.fillRect(i, 0, 4, 64); } const g = x.createLinearGradient(0, 0, 0, 64); g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(0.6, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.25)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64); }
    const wpt = new THREE.CanvasTexture(wp); wpt.colorSpace = THREE.SRGBColorSpace;
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x8a8279, map: wpt, roughness: 1, envMapIntensity: 0.3 });
    const box = new THREE.BoxGeometry(1, 1, 1);
    const slab = new THREE.InstancedMesh(box, slabMat, cnt), dark = new THREE.InstancedMesh(box, darkMat, cnt);
    const counters = { slab: 0, dark: 0, roofs: [] };
    for (const b of this.buildings) b.buildInterior(slab, dark, counters);
    slab.count = counters.slab; dark.count = counters.dark; this.slabMesh = slab; this.darkMesh = dark; slab.castShadow = slab.receiveShadow = true; dark.receiveShadow = true;
    this.scene.add(slab, dark);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x3b3934, roughness: 0.9 });
    const roofs = new THREE.InstancedMesh(box, roofMat, Math.max(1, counters.roofs.length)); counters.roofs.forEach((m, i) => roofs.setMatrixAt(i, m));
    roofs.castShadow = roofs.receiveShadow = true; this.scene.add(roofs); this.roofMesh = roofs; this.falling = [];
    // nav + occluders (one per contiguous standing part; pancaked gap leaves a passage)
    for (const b of this.buildings) {
      const { W } = kit;
      const parts = b.pancaked ? [[0, b.pancaked[0] - 1], [b.pancaked[1] + 1, b.modules - 1]] : [[0, b.modules - 1]];
      b.occ = [];
      for (const [a, c] of parts) {
        if (c < a) continue;
        const lx = -b.L / 2 + ((a + c + 1) / 2) * W, hx = (c - a + 1) * W / 2;
        const ctr = b.toWorld(lx, 0, 0);
        this.nav.rect(ctr.x, ctr.z, hx, b.D / 2, b.rot, BLOCK, 0.3);
        b.occ.push(this.nav.addOccluder(ctr.x, ctr.z, hx, b.D / 2, b.rot, b.height, b));
      }
    }
  }
  // ---------------------------------------------------------------- rubble
  rubbleTemplates() {
    if (this._rt) return this._rt;
    const keys = this.assets.rubbleKeys || [];
    this._rt = keys.map(k => this.assets.gltf[k].scene);
    if (!this._rt.length) {
      // fallback: chunky pile of broken slabs
      const m = new THREE.MeshStandardMaterial({ color: 0x8e887d, roughness: 0.95, flatShading: true });
      for (let v = 0; v < 3; v++) {
        const g = new THREE.Group(), r = mulberry(v + 11);
        const mound = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), m); mound.scale.set(3, 1.1, 2.4); mound.position.y = -0.2; g.add(mound);
        for (let i = 0; i < 9; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.4 + r() * 1.6, 0.18, 0.4 + r() * 1.2), m); s.position.set((r() - .5) * 4, 0.3 + r() * 0.6, (r() - .5) * 3); s.rotation.set(r() * 1.2, r() * 3, r() * 1.2); g.add(s); }
        g.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
        this._rt.push(g);
      }
    }
    for (const t of this._rt) { const b = new THREE.Box3().setFromObject(t); t.userData.r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2; t.userData.h = b.max.y; }
    return this._rt;
  }
  rubbleAndDebris() {
    const T = this.rubbleTemplates(), place = T.map(() => []);
    const add = (x, z, s, ry) => {
      if (onRoad(x, z, -1) && this.rng() < 0.5) s *= 0.6;
      const k = Math.floor(this.rng() * T.length); place[k].push(trs(x, 0, z, ry, s));
      const r = T[k].userData.r * s;
      this.nav.circle(x, z, r * 0.65, r * s > 2.5 ? 7 : 4, true);
    };
    for (const b of this.buildings) {
      // debris fans under destroyed/holed panels
      for (const p of b.panels) {
        if (p.state < 2 || p.floor > 3) continue;
        if (p.state === 2 && this.rng() < 0.6) continue;
        const c = b.panelCenter(p), o = b.outward(p);
        add(c.x + o.x * (1.5 + this.rng() * 2), c.z + o.z * (1.5 + this.rng() * 2), 0.6 + this.rng() * 0.5 + (p.state === 3 ? 0.4 : 0), this.rng() * 6.28);
      }
      if (b.pancaked) for (let c = b.pancaked[0]; c <= b.pancaked[1]; c++) for (let k = 0; k < 3; k++) {
        const w = b.toWorld(-b.L / 2 + (c + 0.5) * this.assets.kit.W + (this.rng() - .5) * 3, 0, (this.rng() - .5) * b.D * 1.4);
        add(w.x, w.z, 1.6 + this.rng() * 0.9, this.rng() * 6.28);
      }
      if (b.collapsedCorner) for (let k = 0; k < 3; k++) {
        const ex = (b.collapsedCorner === 'right' ? 1 : -1) * (b.L / 2 + 2 + this.rng() * 3);
        const w = b.toWorld(ex, 0, (this.rng() - .5) * b.D); add(w.x, w.z, 1.0 + this.rng() * 0.7, this.rng() * 6.28);
      }
    }
    // scattered debris on streets
    for (let i = 0; i < 60; i++) { const x = (this.rng() - .5) * (MAP_SIZE - 40), z = (this.rng() - .5) * (MAP_SIZE - 40); add(x, z, 0.35 + this.rng() * 0.4, this.rng() * 6.28); }
    T.forEach((t, k) => place[k].length && instance(this.scene, t, place[k]));
    this.rubbleInstances = place;
  }
  // Dynamic rubble when panels are destroyed during play.
  spawnRubble(x, z, s) {
    const T = this.rubbleTemplates(); const t = T[Math.floor(Math.random() * T.length)].clone();
    t.position.set(x, -0.6 * s, z); t.rotation.y = Math.random() * 6.28; t.scale.setScalar(s); t.userData.rise = 0.6 * s;
    this.dynamic.add(t); this.nav.circle(x, z, t.userData.r * s * 0.6, 4, true);
    return t;
  }
  // ---------------------------------------------------------------- vegetation
  templatesFrom(key, tests) {
    const g = this.assets.gltf[key]; const out = {};
    if (!g) return out;
    for (const c of g.scene.children) for (const [type, re] of Object.entries(tests)) if (re.test(c.name)) (out[type] ||= []).push(c);
    return out;
  }
  trees() {
    let T = this.templatesFrom('trees', { leafy: /leaf|green|summer|alive/i, stump: /stump/i, fallen: /fallen|log/i, bare: /strip|bare|broken|dead|poplar|chestnut|birch|tree/i });
    if (!T.bare) {
      const bark = new THREE.MeshStandardMaterial({ color: 0x4b4239, roughness: 1 });
      const mk = (seed, leafy) => { const g = new THREE.Group(), r = mulberry(seed);
        const h = 7 + r() * 5; const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.25, h, 7), bark); tr.position.y = h / 2; g.add(tr);
        for (let i = 0; i < 7; i++) { const l = 1.5 + r() * 2.5; const b = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.08, l, 5), bark); b.position.set(0, h * (0.45 + r() * 0.5), 0); b.rotation.set(0.6 + r() * 0.5, r() * 6.28, 0, 'YXZ'); b.translateY(l / 2); g.add(b); }
        if (leafy) { const f = new THREE.Mesh(new THREE.IcosahedronGeometry(2.6, 1), new THREE.MeshStandardMaterial({ color: 0x5d5f32, roughness: 1, flatShading: true })); f.position.y = h * 0.85; f.scale.y = 1.3; g.add(f); }
        g.traverse(o => o.isMesh && (o.castShadow = true)); return g; };
      T = { bare: [mk(1), mk(2), mk(3)], leafy: [mk(4, true)] };
    }
    const spots = [];
    // avenue rows
    for (let x = -E + 8; x < E - 8; x += 11) for (const z of [-15.5, 15.5]) if (!onRoad(x, z, 1) && this.rng() < 0.8) spots.push([x + (this.rng() - .5) * 2, z]);
    // side streets
    for (const sx of [-106, -84, 74, 96]) for (let z = -E + 8; z < E - 8; z += 13) if (!onRoad(sx, z, 1) && this.rng() < 0.6) spots.push([sx, z + (this.rng() - .5) * 3]);
    // courtyards
    for (let i = 0; i < 110; i++) { const x = (this.rng() - .5) * (MAP_SIZE - 40), z = (this.rng() - .5) * (MAP_SIZE - 40); if (!onRoad(x, z, 4)) spots.push([x, z]); }
    const by = {};
    for (const [x, z] of spots) {
      const i = this.nav.idx(x, z); if (i < 0 || this.nav.cost[i] === BLOCK) continue;
      if (this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + 3 && Math.abs(lz) < b.D / 2 + 3; })) continue;
      const roll = this.rng();
      const type = roll < 0.12 && T.leafy ? 'leafy' : roll < 0.22 && T.stump ? 'stump' : roll < 0.27 && T.fallen ? 'fallen' : 'bare';
      const list = T[type]; const k = Math.floor(this.rng() * list.length);
      (by[type + k] ||= { t: list[k], m: [] }).m.push(trs(x, 0, z, this.rng() * 6.28, 0.85 + this.rng() * 0.35));
      this.nav.circle(x, z, type === 'fallen' ? 1.2 : 0.5, type === 'fallen' ? 5 : BLOCK, true);
    }
    for (const v of Object.values(by)) instance(this.scene, v.t, v.m);
  }
  // ---------------------------------------------------------------- poles & wires
  poles() {
    const T = this.templatesFrom('wires', { pole: /^(utility_)?pole|utility/i, trolley: /trolley|tram/i, concertina: /concertina|razor/i, fence: /barb|fence/i });
    const conc = new THREE.MeshStandardMaterial({ color: 0x99958b, roughness: 0.9 });
    let pole = T.pole?.[0];
    if (!pole) { pole = new THREE.Group(); const p = new THREE.Mesh(new THREE.BoxGeometry(0.22, 9.5, 0.22), conc); p.position.y = 4.75; pole.add(p); const a = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.1), conc); a.position.y = 9; pole.add(a); pole.traverse(o => o.isMesh && (o.castShadow = true)); }
    const trolley = T.trolley?.[0] || pole;
    // attachment points: empties named attach*/wire* in the template, else top of pole
    const attachOf = t => { const pts = []; t.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(t.matrixWorld).invert(); t.traverse(o => { if (!o.isMesh && /attach|wire|insul/i.test(o.name)) pts.push(o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv)); }); if (!pts.length) { const b = new THREE.Box3().setFromObject(t); pts.push(new THREE.Vector3(0.7, b.max.y - 0.5, 0), new THREE.Vector3(-0.7, b.max.y - 0.5, 0)); } return pts; };
    const lines = [];
    const run = (tpl, x0, z0, x1, z1, step, rotY, sag) => {
      const n = Math.floor(Math.hypot(x1 - x0, z1 - z0) / step), mats = [], att = attachOf(tpl), tops = [];
      for (let i = 0; i <= n; i++) {
        const x = x0 + (x1 - x0) * i / n, z = z0 + (z1 - z0) * i / n;
        if (onRoad(x, z, -0.5)) { tops.push(null); continue; }
        const broken = this.rng() < 0.12, tilt = broken ? (this.rng() - .5) * 0.5 : (this.rng() - .5) * 0.04;
        const M = trs(x, 0, z, rotY, 1, tilt, (this.rng() - .5) * 0.05); mats.push(M);
        this.nav.circle(x, z, 0.4, BLOCK);
        tops.push(broken ? null : att.map(a => a.clone().applyMatrix4(M)));
      }
      for (let i = 0; i < tops.length - 1; i++) {
        const a = tops[i], b = tops[i + 1];
        for (let k = 0; k < (a ? a.length : 0); k++) {
          if (!a || this.rng() < 0.08) continue;
          if (b && b[k]) lines.push(catenary(a[k], b[k], sag + this.rng() * 0.5));
          else { const end = a[k].clone().add(new THREE.Vector3((x1 - x0) / n * 0.4, 0, (z1 - z0) / n * 0.4)); end.y = 0.05; lines.push(catenary(a[k], end, 0.8)); } // snapped wire hanging to the ground
        }
      }
      instance(this.scene, tpl, mats);
    };
    run(trolley, -E + 5, -13.5, E - 5, -13.5, 32, 0, 0.6); run(trolley, -E + 5, 13.5, E - 5, 13.5, 32, Math.PI, 0.6);
    run(pole, -105.5, -E + 5, -105.5, E - 5, 36, Math.PI / 2, 1.3); run(pole, 95.5, -E + 5, 95.5, E - 5, 36, -Math.PI / 2, 1.3);
    run(pole, -E + 5, 114, E - 5, 114, 36, 0, 1.3); run(pole, -E + 5, -190, E - 5, -190, 36, 0, 1.5); run(pole, -E + 5, 190, E - 5, 190, 36, Math.PI, 1.5);
    // trolleybus contact wires spanning the avenue between the two pole rows
    for (let x = -E + 18; x < E - 5; x += 32) { if (this.rng() < 0.25) continue; lines.push(catenary(new THREE.Vector3(x, 6.6, -13.2), new THREE.Vector3(x, 6.6, 13.2), 0.35)); }
    for (const z of [-2.1, 2.1]) for (let x = -E + 18; x < E - 37; x += 32) { if (this.rng() < 0.3) continue; lines.push(catenary(new THREE.Vector3(x, 6.4, z), new THREE.Vector3(x + 32, 6.4, z), 0.25)); }
    const wireMat = new THREE.MeshStandardMaterial({ color: 0x1c1b19, roughness: 0.6, metalness: 0.4 });
    const tubes = lines.map(pts => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.012, 3));
    const merged = mergeGeometries(tubes); const wires = new THREE.Mesh(merged, wireMat); wires.castShadow = false; this.scene.add(wires);
    this.wireT = T;
  }
  // ---------------------------------------------------------------- props
  props() {
    const T = this.templatesFrom('props', { car: /car|sedan|vaz|lada|zhiguli/i, bus: /bus(?!_?stop)|paz|minibus/i, hedgehog: /hedgehog/i, sandbag: /sandbag/i, tyre: /tyre|tire/i, garage: /garage/i, busstop: /bus_?stop|shelter/i, playground: /playground|climb/i, kiosk: /kiosk/i, crater: /crater/i });
    this.propT = T;
    const steel = new THREE.MeshStandardMaterial({ color: 0x4a3a30, roughness: 0.95, metalness: 0.2 });
    if (!T.car) { const c = new THREE.Group(); const b = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.8, 4.1), steel); b.position.y = 0.65; c.add(b); const t = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.55, 2.0), steel); t.position.set(0, 1.3, -0.2); c.add(t); c.traverse(o => o.isMesh && (o.castShadow = true)); T.car = [c]; }
    if (!T.hedgehog) { const h = new THREE.Group(); for (let i = 0; i < 3; i++) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 2.0), new THREE.MeshStandardMaterial({ color: 0x3a2e25, metalness: 0.5, roughness: 0.7 })); r.position.y = 0.6; r.rotation.set(i === 0 ? 0.9 : 0, i === 1 ? 1.1 : 0, i === 2 ? 0.9 : 0); if (i === 2) r.rotation.y = -1.1; h.add(r); } h.traverse(o => o.isMesh && (o.castShadow = true)); T.hedgehog = [h]; }
    const placeList = {};
    const put = (type, x, z, ry, s = 1, navR = 1.5, cost = 6) => {
      const list = T[type]; if (!list) return;
      const k = Math.floor(this.rng() * list.length); (placeList[type + k] ||= { t: list[k], m: [] }).m.push(trs(x, 0, z, ry, s));
      if (navR) { const bb = list[k].userData.bb ||= new THREE.Box3().setFromObject(list[k]); const sx = (bb.max.x - bb.min.x) / 2 * s, sz = (bb.max.z - bb.min.z) / 2 * s; this.nav.rect(x, z, sx, sz, ry, cost, 0.2); for (let a = 0; a < 1; a++) { const idx = this.nav.idx(x, z); if (idx >= 0) this.nav.low[idx] = 1; } }
    };
    // burnt cars along kerbs
    for (let i = 0; i < 34; i++) {
      const r = ROADS[Math.floor(this.rng() * ROADS.length)], horiz = (r.x1 - r.x0) > (r.z1 - r.z0);
      const t = this.rng(); const side = this.rng() < 0.5;
      const x = horiz ? r.x0 + t * (r.x1 - r.x0) : (side ? r.x0 + 1.4 : r.x1 - 1.4);
      const z = horiz ? (side ? r.z0 + 1.4 : r.z1 - 1.4) : r.z0 + t * (r.z1 - r.z0);
      if (Math.abs(x) > BOUNDS || Math.abs(z) > BOUNDS) continue;
      put('car', x, z, (horiz ? Math.PI / 2 : 0) + (this.rng() - .5) * 0.5 + (this.rng() < .5 ? Math.PI : 0), 1, 1, BLOCK);
    }
    put('bus', 72, 3, 0.25, 1, 1, BLOCK);
    put('busstop', 100, -13.5, Math.PI, 1, 1, BLOCK);
    put('kiosk', 104, 16, Math.PI * 0.95, 1, 1, BLOCK); put('kiosk', 122, 16.5, Math.PI, 1, 1, BLOCK);
    // garage rows in courtyards
    for (const [x, z, ry] of [[-120, -95, 0], [-10, -120, 0], [120, -128, 0], [-120, 85, 0], [60, 125, 0], [-60, 125, 0]]) for (let i = 0; i < 4; i++) put('garage', x + i * 3.6, z, ry, 1, 1, BLOCK);
    for (const [x, z] of [[-150, -100], [-30, 85], [160, 120], [10, -100]]) put('playground', x, z, this.rng() * 3, 1, 1, 6);
    for (let i = 0; i < 45; i++) { const x = (this.rng() - .5) * (MAP_SIZE - 60), z = (this.rng() - .5) * (MAP_SIZE - 60); const idx = this.nav.idx(x, z); if (idx >= 0 && this.nav.cost[idx] < 5) put('tyre', x, z, this.rng() * 6, 1, 0); }
    for (const v of Object.values(placeList)) instance(this.scene, v.t, v.m);
    this.put = put; this._pl = placeList;
  }
  // ---------------------------------------------------------------- city dressing (city.glb)
  dressing() {
    const T = this.templatesFrom('city', { house: /^house_/i, fenceH: /^fence_house/i, po2: /^fence_po2/i, pipe: /^pipe_straight/i, pipeLoop: /^pipe_loop/i, sub: /^substation/i, church: /^church/i, pav: /^pavilion/i, bill: /^billboard/i, bench: /^bench/i, bin: /^bin/i, lamp: /^lamp/i, car: /^car_parked/i, road: /^sign_road/i, goal: /^goal/i, laundry: /^laundry/i });
    // procedural stand-in for private houses if city.glb isn't there yet
    if (!T.house) {
      const wall = new THREE.MeshStandardMaterial({ color: 0xbfb6a3, roughness: 0.95 }), roof = new THREE.MeshStandardMaterial({ color: 0x5f6a63, roughness: 0.6, metalness: 0.4 }), dark = new THREE.MeshStandardMaterial({ color: 0x1a1a19 });
      T.house = [0, 1, 2].map(k => { const g = new THREE.Group(), w = 7 + k, d = 6 + (k % 2) * 2, h = 2.9;
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wall); body.position.y = h / 2; g.add(body);
        const sh = new THREE.Shape(); sh.moveTo(-d / 2 - 0.4, 0); sh.lineTo(d / 2 + 0.4, 0); sh.lineTo(0, 2.1); sh.closePath();
        const rg = new THREE.ExtrudeGeometry(sh, { depth: w + 0.8, bevelEnabled: false }); rg.rotateY(Math.PI / 2); rg.translate(-(w + 0.8) / 2, h, 0);
        const r = new THREE.Mesh(rg, roof); g.add(r);
        for (let i = 0; i < 3; i++) { const win = new THREE.Mesh(new THREE.BoxGeometry(1, 1.2, 0.08), dark); win.position.set(-w / 3 + i * w / 3, 1.6, d / 2 + 0.02); g.add(win); }
        g.traverse(o => o.isMesh && (o.castShadow = o.receiveShadow = true)); return g; });
    }
    const place = {}, R = this.rng;
    const put = (type, x, z, ry, cost = BLOCK, s = 1) => {
      const list = T[type]; if (!list) return false;
      const k = Math.floor(R() * list.length), t = list[k];
      const bb = t.userData.bb ||= new THREE.Box3().setFromObject(t); const hx = (bb.max.x - bb.min.x) / 2 * s, hz = (bb.max.z - bb.min.z) / 2 * s;
      // refuse placements on roads or overlapping blocked cells
      if (onRoad(x, z, Math.max(hx, hz) * 0.6)) return false;
      const ci = this.nav.idx(x, z); if (ci < 0 || this.nav.cost[ci] === BLOCK) return false;
      if (this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + hx + 1 && Math.abs(lz) < b.D / 2 + hz + 1; })) return false;
      (place[type + k] ||= { t, m: [] }).m.push(trs(x, 0, z, ry, s));
      if (cost) this.nav.rect(x, z, hx, hz, ry, cost, 0.15);
      return true;
    };
    // private-house sectors (приватний сектор) at the four outer corners, lanes left clear for deployment
    for (const [x0, x1, z0, z1] of [[-252, -150, 206, 252], [150, 252, 206, 252], [-252, -150, -252, -206], [150, 252, -252, -206], [-198, -130, 140, 186], [160, 196, -100, -60]]) {
      for (let x = x0 + 10; x < x1 - 6; x += 21) for (let z = z0 + 10; z < z1 - 6; z += 23) {
        if (R() < 0.15) continue;
        const ry = (R() < 0.5 ? 0 : Math.PI) + (R() - .5) * 0.15, hx = x + (R() - .5) * 4, hz = z + (R() - .5) * 4;
        if (!put('house', hx, hz, ry)) continue;
        if (T.fenceH) for (const [fx, fz, fr] of [[hx, hz + 9, 0], [hx - 9.5, hz, Math.PI / 2], [hx + 9.5, hz, Math.PI / 2]]) if (R() < 0.75) put('fenceH', fx, fz, fr + (R() - .5) * 0.06, 5);
        if (R() < 0.3) this.addCrater(hx + (R() - .5) * 12, hz + (R() - .5) * 12, 2 + R() * 3);
      }
    }
    // district heating mains with expansion loops
    for (const [x0, z0, x1, z1] of [[-128, -88, -50, -88], [52, 92, 128, 92], [-80, 125, -10, 125], [110, -95, 175, -95], [-190, 20, -190, 90]]) {
      const L = Math.hypot(x1 - x0, z1 - z0), n = Math.floor(L / 6), ry = Math.atan2(x1 - x0, z1 - z0) + Math.PI / 2;
      for (let i = 0; i < n; i++) { const f = (i + 0.5) / n; put(i === Math.floor(n / 2) && T.pipeLoop ? 'pipeLoop' : 'pipe', x0 + (x1 - x0) * f, z0 + (z1 - z0) * f, ry, 7); }
    }
    for (const [x, z] of [[-115, 42], [62, -95], [128, 42], [-62, 132], [175, 185], [-175, -185]]) put('sub', x, z, R() * 4);
    put('church', -184, 128, 0); put('church', 184, -178, Math.PI);
    for (const [x, z, r] of [[122, 46, Math.PI], [134, 46, Math.PI], [146, 46, Math.PI], [128, 56, 0]]) put('pav', x, z, r);
    for (const [x, z, r] of [[60, 16, Math.PI], [-120, -17, 0], [170, 17, Math.PI]]) put('bill', x, z, r, 6);
    // concrete ПО-2 fences around the school yard and garage rows
    if (T.po2) { for (let x = -96; x < -36; x += 4.1) put('po2', x, 82, 0, 7); for (let z = 30; z < 82; z += 4.1) put('po2', -98, z, Math.PI / 2, 7); }
    for (const [x, z] of [[-50, 78], [-20, 78]]) put('goal', x, z, Math.PI / 2, 6);
    // street furniture
    for (let x = -E + 20; x < E - 20; x += 30) { put('lamp', x + 15, -16.6, 0, 0); put('lamp', x, 16.6, Math.PI, 0); }
    for (const b of this.buildings) for (const e of b.entrances) { if (R() < 0.6) put('bench', e.x + (R() - .5) * 3, e.z + (R() - .5) * 2, b.rot, 0); if (R() < 0.35) put('bin', e.x + 4 * (R() < .5 ? 1 : -1), e.z, b.rot, 6); if (R() < 0.15) put('laundry', e.x + (R() - .5) * 10, e.z - 8, R() * 3, 0); }
    for (let i = 0; i < 26; i++) { const r = ROADS[Math.floor(R() * ROADS.length)], horiz = (r.x1 - r.x0) > (r.z1 - r.z0), t = R(), sd = R() < 0.5;
      const x = horiz ? r.x0 + t * (r.x1 - r.x0) : (sd ? r.x0 - 2.6 : r.x1 + 2.6), z = horiz ? (sd ? r.z0 - 2.6 : r.z1 + 2.6) : r.z0 + t * (r.z1 - r.z0);
      if (Math.abs(x) < BOUNDS && Math.abs(z) < BOUNDS) put('car', x, z, horiz ? Math.PI / 2 : 0, BLOCK); }
    for (const v of Object.values(place)) instance(this.scene, v.t, v.m);
  }
  // field fortifications at the objectives (facing north)
  defences() {
    const T = this.propT, placeList = {};
    const put = (type, x, z, ry) => {
      const list = T[type]; if (!list) return; const k = Math.floor(this.rng() * list.length);
      (placeList[type + k] ||= { t: list[k], m: [] }).m.push(trs(x, 0, z, ry, 1));
      const bb = list[k].userData.bb ||= new THREE.Box3().setFromObject(list[k]);
      const sx = (bb.max.x - bb.min.x) / 2, sz = (bb.max.z - bb.min.z) / 2;
      this.nav.rect(x, z, sx, sz, ry, type === 'hedgehog' ? BLOCK : 7, 0.1);
    };
    if (!T.sandbag) { const sb = new THREE.Group(); const m = new THREE.MeshStandardMaterial({ color: 0x7c7058, roughness: 1 }); for (let r = 0; r < 3; r++) for (let i = 0; i < 5; i++) { const b = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.4, 3, 8), m); b.rotation.z = Math.PI / 2; b.scale.set(1, 1, 0.75); b.position.set(-1.2 + i * 0.6 + (r % 2) * 0.3, 0.15 + r * 0.26, 0); sb.add(b); } sb.traverse(o => o.isMesh && (o.castShadow = true)); T.sandbag = [sb]; }
    // School: sandbagged positions along the avenue side and the gap between wings
    for (let x = -78; x <= -44; x += 4.2) if (this.rng() < 0.75) put('sandbag', x, 30, 0);
    for (const [x, z, r] of [[-94, 45, Math.PI / 2], [-94, 52, Math.PI / 2], [-70, 76, 0.3]]) put('sandbag', x, z, r);
    // Crossroads: barricade of hedgehogs across the intersection mouths + sandbag nests at corners
    for (let x = 80; x <= 90; x += 2.6) put('hedgehog', x, -14, this.rng() * 3);
    for (let z = -6; z <= 6; z += 2.6) put('hedgehog', 70, z, this.rng() * 3);
    for (const [x, z, r] of [[98, -14.5, 0], [102, -14.5, 0], [74, -14.5, 0], [98, 17, Math.PI], [72, 17, Math.PI]]) put('sandbag', x, z, r);
    for (const v of Object.values(placeList)) instance(this.scene, v.t, v.m);
    // concertina wire belts in front of both objectives
    const C = this.wireT?.concertina?.[0];
    const coil = C || (() => { const pts = []; for (let i = 0; i < 240; i++) { const a = i * 0.45; pts.push(new THREE.Vector3(Math.cos(a) * 0.45, 0.45 + Math.sin(a) * 0.45, i / 240 * 5 - 2.5)); } const g = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 480, 0.008, 3), new THREE.MeshStandardMaterial({ color: 0x6d6a64, metalness: 0.8, roughness: 0.4 })); const grp = new THREE.Group(); g.rotation.y = Math.PI / 2; grp.add(g); return grp; })();
    const bb = new THREE.Box3().setFromObject(coil); const len = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z); const alongX = (bb.max.x - bb.min.x) >= (bb.max.z - bb.min.z);
    const m = [];
    const belt = (x0, z0, x1, z1) => { const d = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(d / len), ang = Math.atan2(x1 - x0, z1 - z0) + (alongX ? -Math.PI / 2 : 0); for (let i = 0; i < n; i++) { const f = (i + 0.5) / n; const x = x0 + (x1 - x0) * f, z = z0 + (z1 - z0) * f; m.push(trs(x, 0, z, ang)); this.nav.circle(x, z, 0.9, 5); } };
    belt(-84, 22, -40, 22); belt(100, -24, 125, -24); belt(60, -20, 72, -20);
    instance(this.scene, coil, m);
  }
  craters() {
    const T = this.propT?.crater;
    const mat = new THREE.MeshStandardMaterial({ color: 0x2c2722, roughness: 1, transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    const tex = craterTexture(); mat.map = tex; mat.color.set(0xffffff);
    const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
    this.craterMesh = new THREE.InstancedMesh(g, mat, 400); this.craterMesh.count = 0; this.craterMesh.receiveShadow = true; this.craterMesh.frustumCulled = false; this.scene.add(this.craterMesh);
    for (const c of this.pendingCraters || []) this.addCrater(...c); this.pendingCraters = null;
    for (let i = 0; i < 120; i++) { const x = (this.rng() - .5) * (MAP_SIZE - 40), z = (this.rng() - .5) * (MAP_SIZE - 40); this.addCrater(x, z, 2 + this.rng() * 4); }
    if (T) { const m = []; for (let i = 0; i < 18; i++) { const x = (this.rng() - .5) * (MAP_SIZE - 60), z = (this.rng() - .5) * (MAP_SIZE - 60); const idx = this.nav.idx(x, z); if (idx >= 0 && this.nav.cost[idx] < 5) m.push(trs(x, 0, z, this.rng() * 6)); } instance(this.scene, T[0], m); }
  }
  addCrater(x, z, size) {
    if (!this.craterMesh) { (this.pendingCraters ||= []).push([x, z, size]); return; }
    const c = this.craterMesh; if (c.count >= 400) return;
    c.setMatrixAt(c.count++, trs(x, 0.07 + c.count * 0.0004, z, Math.random() * 6.28, size)); c.instanceMatrix.needsUpdate = true;
  }
  // distant city silhouette beyond the playable area
  skyline() {
    const m = new THREE.MeshStandardMaterial({ color: 0x77736b, roughness: 1 });
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
    const mats = [];
    for (let i = 0; i < 70; i++) {
      const a = this.rng() * Math.PI * 2, r = MAP_SIZE * 0.78 + this.rng() * 220;
      const h = 15 + this.rng() * 30 * (this.rng() < 0.3 ? 1.6 : 1);
      const M = new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng() * 3), new THREE.Vector3(12 + this.rng() * 50, h, 12 + this.rng() * 4));
      mats.push(M);
    }
    const im = new THREE.InstancedMesh(box, m, mats.length); mats.forEach((M, i) => im.setMatrixAt(i, M)); im.castShadow = false; this.scene.add(im);
  }
  // ---------------------------------------------------------------- section collapse
  rebuildOccluders(b) {
    for (const o of b.occ || []) o.dead = true;
    const { W } = this.assets.kit; b.occ = [];
    let a = null;
    for (let c = 0; c <= b.modules; c++) {
      const standing = c < b.modules && !b.goneCols.has(c) && !(b.pancaked && c >= b.pancaked[0] && c <= b.pancaked[1]);
      if (standing && a === null) a = c;
      if (!standing && a !== null) {
        const lx = -b.L / 2 + ((a + c) / 2) * W, hx = (c - a) * W / 2, ctr = b.toWorld(lx, 0, 0);
        b.occ.push(this.nav.addOccluder(ctr.x, ctr.z, hx, b.D / 2, b.rot, b.height, b)); a = null;
      }
    }
  }
  collapseSection(b, si, game) {
    if (b.collapsedSecs.has(si)) return; b.collapsedSecs.add(si);
    const { W, H } = this.assets.kit, [a, c] = b.secCols[si];
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    // panels drop and tumble, then vanish into the dust
    for (const p of b.panelsOfSection(si)) {
      const m = b.panelMatrix(p, new THREE.Matrix4());
      this.falling.push({ b, p, m, t: -p.floor * 0.12 - Math.random() * 0.25, v: 0, rx: (Math.random() - .5) * 0.6, rz: (Math.random() - .5) * 0.4, out: b.outward(p).multiplyScalar(0.6 + Math.random()) });
      if (p.acc && p.acc.slot >= 0) this.pool.remove(p.balcony ? 'balcony_slab' : 'entrance_canopy', p.acc);
    }
    for (let col = a; col <= c; col++) {
      b.goneCols.add(col);
      for (const [kind, i] of (b.intIdx?.[col] || [])) { const m = kind === 'slab' ? this.slabMesh : kind === 'dark' ? this.darkMesh : this.roofMesh; m.setMatrixAt(i, zero); m.instanceMatrix.needsUpdate = true; }
    }
    for (const o of b.parapets || []) if (o.slot >= 0 && o.col >= a && o.col <= c) this.pool.remove('roof_parapet', o);
    for (const sg of b.signs || []) if (sg.slot >= 0 && sg.p.col >= a && sg.p.col <= c) this.pool.remove(sg.name, sg);
    for (const mr of b.machines || []) if (mr.o.slot >= 0 && mr.a <= c && mr.b >= a) this.pool.remove('roof_machine_room', mr.o);
    // occupants of the section are caught in the collapse
    for (const sl of b.slots) if (sl.occupant && sl.panel.col >= a && sl.panel.col <= c && (sl.panel.side === 'front' || sl.panel.side === 'back' || sl.panel.side === (si === 0 ? 'left' : 'right'))) {
      const s = sl.occupant; sl.occupant = null; s.slotRef = null; s.inside = null; s.pos.y = 0;
      game.combat.hitSoldier(s, { dmg: [70, 220], type: 'blast' }, s.pos, true);
    }
    for (const sl of b.slots) if (sl.panel.col >= a && sl.panel.col <= c) sl.panel.gone = true;
    // footprint becomes a rubble mound (passable, low cover), LOS reopens
    const lx = -b.L / 2 + ((a + c + 1) / 2) * W, hx = (c - a + 1) * W / 2, ctr = b.toWorld(lx, 0, 0);
    this.nav.setRect(ctr.x, ctr.z, hx + 0.5, b.D / 2 + 0.5, b.rot, 6, 1);
    this.nav.finalize(); this.rebuildOccluders(b);
    const pile = this.assets.gltf.panel_kit?.scene.getObjectByName('collapse_pile_large') || null;
    const n = Math.max(1, Math.round(hx * 2 / 13));
    for (let i = 0; i < n; i++) {
      const p = b.toWorld(-b.L / 2 + (a + (i + 0.5) * (c - a + 1) / n) * W, 0, (Math.random() - .5) * 2);
      if (pile) { const m = pile.clone(); m.position.set(p.x, -4, p.z); m.rotation.y = b.rot + (Math.random() < .5 ? 0 : Math.PI); m.userData.rise = 4; m.scale.setScalar(Math.min(1.2, b.floors / 6 + 0.4)); this.dynamic.add(m); }
      else for (let k = 0; k < 3; k++) this.spawnRubble(p.x + (Math.random() - .5) * 8, p.z + (Math.random() - .5) * 8, 1.5 + Math.random());
    }
    this.cutFaces(b, a, c);
    // the event itself
    const top = b.toWorld(lx, b.floors * H * 0.5, 0);
    game.fx.collapseDust(top, hx * 2, b.D, b.floors * H);
    game.sfx('collapse', top); setTimeout(() => game.sfx('debris', top), 900);
    game.cam.addShake(Math.max(0, 1 - game.camDist(top) / 260));
    for (const sq of game.squads) if (!sq.destroyed && sq.center().distanceTo(top) < 60) { sq.addMorale(-10); sq.underFireT = 0; }
    game.hud?.alert(`A block section collapsed`, 'bad');
    b.collapsedAll = b.collapsedSecs.size === b.secCols.length;
  }
  // broken party walls on the faces exposed by a collapsed section (one merged mesh per collapse)
  cutFaces(b, a, c) {
    const { W, H } = this.assets.kit, kit = this.assets.kit.pieces, parts = new Map();
    const Y = new THREE.Vector3(0, 1, 0), m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const face = (xcut, sign) => {
      for (let f = 0; f < b.floors; f++) for (let j = 0; j < b.depthModules; j++) {
        const r = Math.random(), name = (f > b.floors - 3 && r < 0.5) || r < 0.25 ? 'wall_blank_end_destroyed' : 'wall_blank_end_holed';
        const piece = kit[name] || kit.wall_blank_end_holed; if (!piece) continue;
        const pz = sign > 0 ? b.D / 2 - j * W : -b.D / 2 + j * W;
        b.toWorld(xcut, f * H, pz, v); q.setFromAxisAngle(Y, b.rot + sign * Math.PI / 2); m.compose(v, q, one);
        for (const pt of piece) { const g = pt.geometry.clone().applyMatrix4(m); (parts.get(pt.material) || parts.set(pt.material, []).get(pt.material)).push(g); }
      }
    };
    if (a > 0 && !b.goneCols.has(a - 1)) face(-b.L / 2 + a * W, +1);
    if (c < b.modules - 1 && !b.goneCols.has(c + 1)) face(-b.L / 2 + (c + 1) * W, -1);
    for (const [mat, geos] of parts) { const g = mergeGeometries(geos.map(x => x.index ? x : x), false); if (!g) continue; const mesh = new THREE.Mesh(g, mat); mesh.castShadow = mesh.receiveShadow = true; this.dynamic.add(mesh); }
  }
  updateFalling(dt) {
    if (!this.falling.length) return;
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), e = new THREE.Euler();
    for (const f of this.falling) {
      f.t += dt; if (f.t < 0) continue;
      f.v += 9.8 * dt;
      f.m.decompose(pos, q, sc); pos.y -= f.v * dt; pos.addScaledVector(f.out, dt * 0.8);
      e.set(f.rx * dt, 0, f.rz * dt); q.multiply(new THREE.Quaternion().setFromEuler(e));
      f.m.compose(pos, q, sc); this.pool.setMatrix(f.p, f.m);
      if (pos.y < -3.5) { f.b.setGone(f.p); f.done = true; }
    }
    this.falling = this.falling.filter(f => !f.done);
  }
  // building lookup by world point (for damage)
  buildingAt(x, z, pad = 1.5) {
    for (const b of this.buildings) { const [lx, lz] = b.toLocal(x, z); if (Math.abs(lx) < b.L / 2 + pad && Math.abs(lz) < b.D / 2 + pad) return b; }
    return null;
  }
}

function catenary(a, b, sag) {
  const pts = []; for (let i = 0; i <= 10; i++) { const t = i / 10; const p = a.clone().lerp(b, t); p.y -= sag * 4 * t * (1 - t); pts.push(p); } return pts;
}
function craterTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(18,15,12,0.95)'); g.addColorStop(0.35, 'rgba(40,34,28,0.9)'); g.addColorStop(0.55, 'rgba(70,62,52,0.75)'); g.addColorStop(0.8, 'rgba(60,54,46,0.35)'); g.addColorStop(1, 'rgba(60,54,46,0)');
  x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 160; i++) { const a = Math.random() * 6.28, r = 40 + Math.random() * 85; x.fillStyle = `rgba(${30 + Math.random() * 50},${26 + Math.random() * 40},${22 + Math.random() * 30},${Math.random() * 0.6})`; x.beginPath(); x.arc(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, 1 + Math.random() * 4, 0, 7); x.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
