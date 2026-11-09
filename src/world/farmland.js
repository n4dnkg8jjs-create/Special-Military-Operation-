import * as THREE from 'three';
import { City, MAP, MAP_SIZE, BOUNDS, ROADS, onRoad, footOnRoad, mulberry, catenary, rectMinus, roadPieces } from './city.js';
import { BLOCK } from './nav.js';
import { instance, trs, farLod } from './instancer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WAR_GROUND_DECL, warGroundGLSL, warGroundHooks, paintWar, roadFrame, roadWear, trackWear, weatherEnv, craterMesh, burntHouse, wreckTemplates, blackTex as warBlack } from './wear.js';
import { groundMaterial } from './ground.js';
import { ruinTpl } from './ruins.js';
import { roadSurfaces, ROAD_Y } from './roadmesh.js';
import { buildWires } from './powerWires.js';
import { battlefieldDetail, treeFate, treeTilt } from './battlefieldDetail.js';

// Map 2 — Ukrainian steppe farmland: big open fields cut by acacia/poplar windbreaks ("lesopolosa"),
// two villages strung along their roads, a kolkhoz farm, cratered everywhere.
// Field grid: boundaries follow the windbreaks and tracks in maps.js.
const XS = [-702, -640, -559.5, -395, -359.5, -124.5, -20, 10, 103.5, 180, 224.5, 359.5, 390, 559, 702];
const ZS = [-702, -560, -547.5, -335, -294.5, -175, -143.5, -22, 63.5, 190, 323.5, 335, 401, 545, 702];
const T_PLOW = 0, T_STUB = 1, T_FALLOW = 2, T_SUN = 3, T_CORN = 4;

// ground pads / play equipment that lie flat on the ground: never partly over a road or pavement (z-fight, clipping)
const PAD = /playground|court|gym|pad|sandbox|swing|carousel|slide|bin|container|waste|goal|bench/i;
export class Farmland extends City {
  constructor(scene, assets, quality) {
    super(scene, assets, quality);
    this.rng = mulberry(4417);
    this.streetDebris = 0; this.noOuterGrass = true;
    this.grassMax = quality === 'low' ? 48000 : quality === 'medium' ? 90000 : 130000; this.grassCull = 260;
    this.nav.maxIter = 700000;
    this.CS = 2; this.CN = Math.ceil(MAP_SIZE / this.CS); this.conceal = new Uint8Array(this.CN * this.CN).fill(255);
    this.place = {};
  }
  build() {
    const times = this.buildTimes = {}, step = (k, f) => { const t = performance.now(); f(); times[k] = Math.round(performance.now() - t); };
    weatherEnv(this.assets);
    step('fields', () => this.layoutFields());
    step('ground', () => { this.ground(); this.roads(); });
    step('buildings', () => this.placeBuildings());
    step('fortifications', () => this.fortifications());   // cut into the ground first: everything placed later keeps clear of it
    step('farm', () => { this.farm(); this.farmstead(); this.villages(); });
    step('forest', () => this.forest());
    step('treelines', () => this.treelines());
    step('rubble', () => this.rubbleAndDebris());
    step('props', () => { this.poles(); this.props(); this.defences(); });
    step('war', () => this.warDressing());   // knocked-out armour, mine-cleared lanes, churned vehicle trails
    step('crops', () => this.crops());
    step('flush', () => this.flush());
    step('craters', () => this.craters());
    step('paint', () => this.paintGround());
    step('detail', () => battlefieldDetail(this));   // razor wire, war debris, scorched patches (battlefieldDetail.js)
    step('skyline', () => this.skyline());
    step('crush', () => this.buildCrushables());
    step('nav', () => this.nav.finalize());
  }
  // ---------------------------------------------------------------- helpers
  concealAt(x, z) { const i = Math.floor((x + MAP_SIZE / 2) / this.CS), j = Math.floor((z + MAP_SIZE / 2) / this.CS); if (i < 0 || j < 0 || i >= this.CN || j >= this.CN) return 1; return this.conceal[j * this.CN + i] / 255; }
  concealRect(x0, z0, x1, z1, v) {
    const o = MAP_SIZE / 2, a = Math.max(0, Math.floor((Math.min(x0, x1) + o) / this.CS)), b = Math.min(this.CN - 1, Math.floor((Math.max(x0, x1) + o) / this.CS));
    const c = Math.max(0, Math.floor((Math.min(z0, z1) + o) / this.CS)), d = Math.min(this.CN - 1, Math.floor((Math.max(z0, z1) + o) / this.CS));
    for (let j = c; j <= d; j++) for (let i = a; i <= b; i++) { const k = j * this.CN + i; this.conceal[k] = Math.min(this.conceal[k], v); }
  }
  fieldIndex(x, z) {
    let i = 0; while (i < XS.length - 2 && x >= XS[i + 1]) i++;
    let j = 0; while (j < ZS.length - 2 && z >= ZS[j + 1]) j++;
    return j * (XS.length - 1) + i;
  }
  overlapsBuilding(x, z, hx, hz, pad = 1) { return this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + hx + pad && Math.abs(lz) < b.D / 2 + hz + pad; }); }
  inVillage(x, z, pad = 0) {
    for (const v of MAP.villages) {
      const lo = v.side === 1 ? 0 : v.depth + pad, hi = v.side === -1 ? 0 : v.depth + pad;
      if (v.street === 'x') { if (x > v.from - pad && x < v.to + pad && z > v.z0 - lo && z < v.z1 + hi) return v; }
      else if (z > v.from - pad && z < v.to + pad && x > v.x0 - lo && x < v.x1 + hi) return v;
    }
    return null;
  }
  inForest(x, z, pad = 0, ignoreClearings = false) {
    const F = MAP.forest; if (!F) return false;
    // ragged edge: +-7 m of noise along the outline
    const e = (this.noise2(x / 23, z / 23, 31) - 0.5) * 14;
    if (x < F.x0 - pad + e || x > F.x1 + pad - e || z < F.z0 - pad + e || z > F.z1 + pad - e) return false;
    if (!ignoreClearings) for (const [cx, cz, r] of F.clearings) if (Math.hypot(x - cx, z - cz) < r + (this.noise2(x / 9, z / 9, 33) - 0.5) * 8 - pad) return false;
    return true;
  }
  inFarmstead(x, z, pad = 0) { const f = MAP.farmstead; return !!f && x > f.x - 40 - pad && x < f.x + 42 + pad && z > f.z - 30 - pad && z < f.z + 24 + pad; }
  inFarm(x, z, pad = 0) { const f = MAP.farm; return Math.abs(x - f.x) < 95 + pad && Math.abs(z - f.z) < 62 + pad; }
  // template lookup in farmland.glb (or city/trees/props.glb), with a procedural stand-in so the map always builds
  tpl(name) {
    this._tpl ||= {};
    if (name in this._tpl) return this._tpl[name];
    let t = null;
    for (const k of ['farmland', 'fortifications', 'city', 'trees', 'props']) { const g = this.assets.gltf[k]; const o = g?.scene.getObjectByName(name); if (o) { t = o; break; } }
    // until farmland.glb has its own windbreak trees, borrow the detailed city trees (never blobs up close)
    const alias = { tree_acacia_leafy: 'leafy_summer_chestnut', tree_oak_leafy: 'leafy_summer_chestnut', tree_walnut_leafy: 'leafy_summer_chestnut', tree_poplar_leafy: 'leafy_summer_birch', tree_acacia_shelled: 'tree_chestnut_broken' };
    if (!t && alias[name]) { const o = this.assets.gltf.trees?.scene.getObjectByName(alias[name]); if (o) t = o; }
    if (!t) t = fallbackTpl(name);
    if (t) { t.userData.bb = new THREE.Box3().setFromObject(t); }
    return (this._tpl[name] = t);
  }
  // burnt-out, roofless shell of a template (wear.js burntHouse), registered as '<name>_burnt'; null if unavailable
  burntTpl(name) {
    const k = name + '_burnt'; this._tpl ||= {};
    if (!(k in this._tpl)) {
      let g = null; const base = this.hasReal(name) || this.assets.gltf.city?.scene.getObjectByName(name) ? this.tpl(name) : null;
      try { g = base ? burntHouse(base) : null; } catch (e) { console.warn('burntHouse', name, e); g = null; }
      if (g) g.userData.bb = new THREE.Box3().setFromObject(g);
      this._tpl[k] = g;
    }
    return this._tpl[k] ? k : null;
  }
  // overlap with the placed village houses only (fences, yard props): City.solidHit restricted to kind 'house'
  houseHit(x, z, hx, hz, ry = 0, pad = 0.3) { return this.solidHit(x, z, hx, hz, ry, pad, k => k !== 'house'); }
  houseNear(x, z, ry = 0) { return this.solidHit(x, z, 1.5, 0.12, ry, 0.15, k => k === 'fence'); }
  teethNear(x, z, r = 3) {
    if (!this._teeth) { this._teeth = new Map(); for (const [tx, tz] of this.terrain.teeth || []) { const k = Math.floor(tx / 8) * 4096 + Math.floor(tz / 8); (this._teeth.get(k) || this._teeth.set(k, []).get(k)).push([tx, tz]); } }
    for (let i = Math.floor((x - r) / 8); i <= Math.floor((x + r) / 8); i++) for (let j = Math.floor((z - r) / 8); j <= Math.floor((z + r) / 8); j++) for (const [tx, tz] of this._teeth.get(i * 4096 + j) || []) if (Math.abs(tx - x) < r && Math.abs(tz - z) < r) return true;
    return false;
  }
  hasTpl(name) { for (const k of ['farmland', 'fortifications']) if (this.assets.gltf[k]?.scene.getObjectByName(name)) return true; return false; }
  hasReal(name) { return !!this.assets.gltf.farmland?.scene.getObjectByName(name); }
  // queue an instanced placement; nav footprint, optional occluder, crushable fences
  put(name, x, z, ry = 0, o = {}) {
    const t = this.tpl(name); if (!t) return false;
    const s = o.s || 1, bb = t.userData.bb, hx = (bb.max.x - bb.min.x) / 2 * s * (o.sx || 1), hz = (bb.max.z - bb.min.z) / 2 * s;   // (o.sx: stretch along local x -- fence runs cut to a piece)
    if (o.check !== false) {
      if (onRoad(x, z, o.roadPad ?? Math.max(hx, hz) * 0.5)) return false;
      if (PAD.test(name) && footOnRoad(x, z, hx * 0.95, hz * 0.95, ry)) return false;   // flat pads (playgrounds, courts, bin pads): the whole footprint off the road and pavement
      const ci = this.nav.idx(x, z); if (ci < 0 || this.nav.cost[ci] === BLOCK) return false;
      if (this.overlapsBuilding(x, z, hx, hz, 0.5)) return false;
    }
    if (o.trench !== false && this.terrain.cutSDF(x, z) < Math.min(Math.max(hx, hz), 6) * 0.85 + 0.5) return false;   // never into a trench
    // nor into another solid prop / trunk (houses, sheds, wells, cars, trees: see City.solidAdd)
    const tree = !!o.circle && /tree|leafy/.test(name), house = /^(house_|church)/.test(name), fx = tree ? 0.4 : house ? hx + 0.2 : hx * 0.95, fz = tree ? 0.4 : house ? hz + 0.2 : hz * 0.95;
    if (o.check !== false && !o.crush && this.solidHit(x, z, fx, fz, ry, tree ? 0.25 : 0.15)) return false;
    if (tree && this.crownHit(x, z, this.canopyR(t, s) * 0.75)) return false;   // crown clear of roofs
    if (o.cost !== 0 && !o.crush && !/bush|fallen|haybale/.test(name)) this.solidAdd(x, z, fx, fz, ry, house ? 'house' : tree ? 'tree' : name);
    // base: lowest ground under the footprint (trees / bushes: under the trunk), never a corner in the air
    const y = o.y ?? (tree || /bush|clump|tree_|leafy/.test(name) ? this.baseY(x, z, 0.35 * s, 0.35 * s) : this.tplBaseY(t, x, z, ry, s));
    const M = trs(x, y + (/playground|court|pad|sandbox/i.test(name) ? 0.03 : 0), z, ry, s, o.rx || 0, o.rz || 0);
    if (o.sx && o.sx !== 1) M.multiply(new THREE.Matrix4().makeScale(o.sx, 1, 1));   // (a flat base slab coplanar with the ground z-fought)
    if (o.crush) { (this.crushables ||= []).push({ t, M, x, z, ry, hx, hz, crush: o.crush, type: o.crush === 'tank' ? 'po2' : 'fenceH' }); this.nav.rect(x, z, hx, hz, ry, o.crush === 'any' ? 3 : 7, 0.1); if (o.crush === 'tank') this.nav.setVeh(x, z, hx + 0.3, hz + 0.3, ry, 1); return true; }
    const key = name + (o.group || '');
    (this.place[key] ||= { t, m: [], opts: o.inst || {}, lodName: o.lod, midName: o.mid ?? (o.lod && this.hasTpl(name + '_mid') ? name + '_mid' : null) }).m.push(M);
    if (o.cost !== 0) {
      const ns = o.navScale || 1;
      if (o.circle) this.nav.circle(x, z, o.circle, o.cost ?? BLOCK, !!o.low);
      else { this.nav.rect(x, z, hx * ns, hz * ns, ry, o.cost ?? BLOCK, 0.15); if (o.low) this.nav.setRect(x, z, hx * ns, hz * ns, ry, o.cost ?? 6, 1); }
    }
    if (o.occ) this.nav.addOccluder(x, z, hx * 0.95, hz * 0.95, ry, typeof o.occ === 'number' ? o.occ : (bb.max.y - bb.min.y) * s * 0.9, null);
    return true;
  }
  flush() {
    const p = new THREE.Vector3();
    for (const [, v] of Object.entries(this.place)) {
      if (/tree|leafy|bush/.test(v.t.name || '')) v.m = v.m.filter(M => { p.setFromMatrixPosition(M); return this.terrain.cutSDF(p.x, p.z) > 1.2; });   // final guard: no trunk in a trench
      if (!v.m.length) continue;
      const lod = v.lodName ? this.tpl(v.lodName) : null, mid = v.midName ? this.tpl(v.midName) : null;
      instance(this.scene, v.t, v.m, { ...v.opts, lod: lod || v.opts.lod, ...(mid ? { mid, nearDist: 58, midShadows: true, lodShadows: false } : {}), ...(lod ? { coarse: 3 } : {}) });
    }
    this.place = {};
  }
  // ---------------------------------------------------------------- fields
  layoutFields() {
    const R = this.rng, nx = XS.length - 1, nz = ZS.length - 1;
    this.fields = [];
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x0 = XS[i], x1 = XS[i + 1], z0 = ZS[j], z1 = ZS[j + 1], w = x1 - x0, d = z1 - z0;
      let type;
      if (Math.min(w, d) < 45) type = T_FALLOW;
      else { const r = R(); type = r < 0.22 ? T_PLOW : r < 0.44 ? T_STUB : r < 0.66 ? T_FALLOW : r < 0.86 ? T_SUN : T_CORN; }
      this.fields.push({ x0, x1, z0, z1, type, rowsX: w > d });
    }
    // fixed picks so both sides get some tall-crop cover on the approaches
    const set = (x, z, t) => { this.fields[this.fieldIndex(x, z)].type = t; };
    set(-250, 250, T_SUN); set(60, 250, T_STUB); set(280, 250, T_SUN); set(-250, -80, T_SUN); set(280, -80, T_CORN); set(-80, -80, T_PLOW);
    set(-250, -240, T_STUB); set(280, -240, T_FALLOW); set(-60, 120, T_FALLOW); set(160, 120, T_SUN); set(-250, 400, T_FALLOW); set(-250, -400, T_FALLOW);
    set(-250, 470, T_SUN); set(40, 470, T_CORN); set(300, 470, T_STUB); set(470, 470, T_SUN); set(-250, 620, T_STUB); set(60, 620, T_FALLOW); set(300, 620, T_STUB);
    set(470, 250, T_CORN); set(470, -80, T_SUN); set(-500, -80, T_STUB); set(-500, -250, T_SUN); set(470, -420, T_STUB); set(-60, -420, T_PLOW); set(-480, 620, T_FALLOW);
    this.warLayout();
    // pre-roll crater positions. Heaviest on and around the held positions and the lines, in the no-man's-land bands
    // in front of them and along the tree belts (where the positions are); lighter scatter elsewhere; the staging
    // grounds in the far rear stay mostly clean.
    this.craterList = [];
    const tl = MAP.treelines, hot = this.hotspots;
    const push = (x, z, bigP = 0.12) => {
      if (Math.abs(x) > MAP_SIZE / 2 - 12 || Math.abs(z) > MAP_SIZE / 2 - 12) return;
      if (Math.abs(z) > 600 && R() < 0.85) return;
      if (onRoad(x, z, 2) && (R() < 0.85 || ROADS.some(r => r.type === 'track' && x > r.x0 - 3 && x < r.x1 + 3 && z > r.z0 - 3 && z < r.z1 + 3))) return;    // a few land on the asphalt (fresh scars), none on the tracks
      const big = R() < bigP * 0.6;
      this.craterList.push([x, z, big ? 4.6 + R() * 3 : 1.3 + R() * 2.8]);
    };
    const gauss = () => (R() + R() + R() - 1.5) / 1.5;
    // tree belts, weighted towards the belts that carry positions / are burnt
    for (let i = 0; i < 700; i++) {
      const [a, b, c, d] = tl[Math.floor(R() * tl.length)]; const f = R(); const px = a + (c - a) * f, pz = b + (d - b) * f;
      if (!this.nearBurntBelt(px, pz, 4) && R() < 0.45) continue;
      const off = gauss() * 45; push(px + (b === d ? 0 : off), pz + (b === d ? off : 0));
    }
    // strongpoints: a dense cluster on every fire position (the 'line' ones heavier)
    for (const [x, z, k] of hot) { const n = Math.round(26 * k); for (let i = 0; i < n; i++) { const a = R() * 6.28, r = 12 + Math.abs(gauss()) * 70; push(x + Math.cos(a) * r, z + Math.sin(a) * r * 0.8, 0.16); } }
    // no-man's land in front of the northern line and in front of the C / D positions
    for (let i = 0; i < 260; i++) push((R() - .5) * (MAP_SIZE - 40), -300 + (R() - 0.35) * 180);
    for (let i = 0; i < 200; i++) push(-560 + R() * 820, 470 + (R() - .5) * 120);
    // open scatter
    for (let i = 0; i < 420; i++) push((R() - .5) * (MAP_SIZE - 30), (R() - .5) * (MAP_SIZE - 30), 0.1);
  }
  // ---------------------------------------------------------------- war layout (before anything is placed)
  // Trails: churned tracks of the assault columns from both staging grounds through the fields and the belts (gaps
  // driven through the windbreaks), and worn shortcuts across the fields between the tracks. Lanes: two mine-cleared
  // lanes (ploughed, staked) in front of C and D where the earlier assaults were stopped. Burns: field fires.
  warLayout() {
    this.trails = [
      // assault columns from the south (from off the map, through the staging ground: no trail starts in a field)
      { w: 4.4, mud: 0.85, pts: [[-236, 704], [-232, 606], [-227, 560], [-213, 500], [-196, 440], [-178, 372], [-160, 323]] },
      { w: 4.4, mud: 0.85, pts: [[-326, 704], [-330, 606], [-342, 552], [-366, 505], [-412, 474], [-424, 452]] },          // up to the C1 trench
      { w: 4.2, mud: 0.8, pts: [[264, 704], [268, 606], [272, 560], [266, 505], [258, 470], [254, 432], [252, 401]] },
      { w: 4.2, mud: 0.75, pts: [[-32, 704], [-28, 606], [-22, 556], [-4, 500], [14, 456], [20, 430], [22, 401]] },
      // the enemy's supply / assault tracks from the north down to the line
      { w: 4.4, mud: 0.85, pts: [[-200, -704], [-205, -606], [-214, -560], [-208, -500], [-196, -440], [-204, -412], [-201, -403]] },   // to the NW communication trench
      { w: 4.4, mud: 0.85, pts: [[266, -704], [262, -606], [256, -556], [241, -482], [251, -412], [250, -403]] },          // to the NE communication trench
      { w: 4.0, mud: 0.7, pts: [[26, -704], [30, -606], [41, -540], [58, -470], [84, -410], [96, -372]] },
      // worn shortcuts across the fields
      { w: 3.2, mud: 0.45, pts: [[-121, 252], [-60, 263], [0, 281], [58, 300], [99, 310]] },
      { w: 3.0, mud: 0.4, pts: [[228, -98], [262, -108], [300, -126], [340, -140]] },
      { w: 3.2, mud: 0.45, pts: [[-356, -196], [-300, -228], [-240, -260], [-182, -290]] },
      { w: 3.0, mud: 0.4, pts: [[-556, -120], [-520, -86], [-470, -60], [-420, -48], [-405, -28], [-404, 20], [-404, 62]] },   // then along the belt to the road
      { w: 3.0, mud: 0.4, pts: [[-357, 230], [-300, 250], [-250, 268], [-180, 300], [-150, 323]] },
    ];
    this.lanes = [
      { w: 4.6, pts: [[166, 547], [165, 531], [163, 490], [160, 450], [160, 428]] },     // from the southern track up to the D1 position
      { w: 4.6, pts: [[-451, 547], [-452, 532], [-454, 500], [-456, 472], [-453, 455]] },   // ... and the C1 position
    ];
    // field fires (shelling sets the dry stubble / dead sunflowers alight): scorched patches, crops thinned
    this.burns = [[-250, -250, 55], [60, -262, 42], [280, -238, 46], [-470, -252, 36], [-250, -82, 40], [282, -84, 36], [-80, -92, 30],
      [-252, 402, 44], [40, 472, 40], [300, 470, 36], [-300, 478, 30], [-60, 252, 34], [160, 252, 30], [470, -80, 34], [-500, -250, 30], [470, 250, 26]];
    // shell-stripped, burnt stretches of the tree belts (the belts that carry positions)
    this.burntBelts = [[-340, -335, -60, -335], [150, -335, 340, -335], [-60, 335, 260, 335], [230, 404, 230, 540], [-395, 470, -395, 560],
      [-340, -22, -30, -22], [180, -22, 290, -22], [-398, 190, -120, 190], [-200, -560, 260, -560]];
    // fire positions (strongpoint centres) for the crater clusters, weight by kind
    const kind = {}; for (const f of MAP.fortifications || []) if (f.type === 'sp') kind[f.id] = f.kind || 'sp';
    this.hotspots = [];
    for (const f of MAP.fortifications || []) if (f.type === 'fire') { const n = f.base.length; let x = 0, z = 0; for (const p of f.base) { x += p[0]; z += p[1]; } const k = kind[f.sp]; this.hotspots.push([x / n, z / n, k === 'line' ? 2.6 : k === 'outpost' ? 1.2 : 1.6]); }
  }
  segDist(x, z, a, b) { const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2)); return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t); }
  nearTrail(x, z, pad = 0) {
    for (const T of [...this.trails, ...this.lanes]) for (let i = 1; i < T.pts.length; i++) { const a = T.pts[i - 1], b = T.pts[i]; if (x < Math.min(a[0], b[0]) - 40 || x > Math.max(a[0], b[0]) + 40 || z < Math.min(a[1], b[1]) - 40 || z > Math.max(a[1], b[1]) + 40) continue; if (this.segDist(x, z, a, b) < T.w / 2 + pad) return true; }
    return false;
  }
  nearBurntBelt(x, z, pad = 0) { for (const [a, b, c, d] of this.burntBelts || []) if (this.segDist(x, z, [a, b], [c, d]) < 8 + pad) return true; return false; }
  inBurn(x, z) { for (const [bx, bz, r] of this.burns || []) { const d = Math.hypot(x - bx, z - bz); if (d < r * (0.75 + 0.5 * this.noise2(x / 15, z / 15, 41))) return true; } return false; }
  onTrail(x, z) { const M = this.trailM; if (!M) return false; const i = Math.floor((x + MAP_SIZE / 2) / this.CS), j = Math.floor((z + MAP_SIZE / 2) / this.CS); return i >= 0 && j >= 0 && i < this.CN && j < this.CN && M[j * this.CN + i] > 0; }
  nearCrater(x, z, pad = 0.6) { for (const [cx, cz, s] of this.craterList) if (Math.abs(cx - x) < s && Math.abs(cz - z) < s && Math.hypot(cx - x, cz - z) < s * pad) return true; return false; }
  // ---------------------------------------------------------------- ground
  ground() {
    const S = this.groundS = MAP_SIZE + 900, g = new THREE.PlaneGeometry(S, S, 1, 1); g.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(g, this.groundMat(false)); ground.receiveShadow = true; ground.name = 'ground'; this.scene.add(ground);
    this.groundMesh = ground;
  }
  // ground shader; terrain = the trench / relief mesh variant (no hole discard, darker damp soil below the surface)
  groundMat(terrain) {   // ground look v6: src/world/ground.js (height-blended, anti-tiled material sets)
    return groundMaterial(this, terrain, true, MAP_SIZE);
  }
  // splat: R fallow/grass, G ploughed soil, B stubble, A packed dirt; rows texture: field row direction
  paintGround() {
    this.paintFarmWar();
    const N = 1792, k = N / MAP_SIZE, o = MAP_SIZE / 2, out = new Uint8Array(N * N * 4), R = this.rng, pa = performance.now();
    const TM = this.terrain.maskData, TN = this.terrain.maskN;
    const ttrack = ROADS.filter(r => r.type === 'track'), paved = ROADS.filter(r => r.type !== 'track');
    // per-pixel mask layers from canvas: verges/yards (A) and gardens (G)
    const layer = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; };
    // shapes are drawn sharp and each layer is blurred once at the end (a per-shape canvas filter costs minutes in software GL)
    const blurred = (src, px) => { const c = layer(), x = c.getContext('2d'); x.filter = `blur(${px}px)`; x.drawImage(src, 0, 0); return x; };
    const yards = layer(), yx = yards.getContext('2d'); yx.fillStyle = '#fff';
    const gard = layer(), gx = gard.getContext('2d'); gx.fillStyle = '#fff';
    const verge = layer(), vx = verge.getContext('2d'); vx.strokeStyle = '#fff'; vx.lineCap = 'round';
    const P = (x, z) => [(x + o) * k, (z + o) * k];
    for (const r of ttrack) { yx.globalAlpha = 0.75; yx.fillRect(...P(r.x0 - 1.5, r.z0 - 1.5), (r.x1 - r.x0 + 3) * k, (r.z1 - r.z0 + 3) * k); }
    for (const r of paved) { yx.globalAlpha = 0.55; yx.fillRect(...P(r.x0 - 3, r.z0 - 3), (r.x1 - r.x0 + 6) * k, (r.z1 - r.z0 + 6) * k); }
    for (const b of this.buildings) { yx.save(); yx.translate(...P(b.x, b.z)); yx.rotate(-b.rot); yx.globalAlpha = 0.7; yx.fillRect((-b.L / 2 - 6) * k, (-b.D / 2 - 6) * k, (b.L + 12) * k, (b.D + 12) * k); yx.restore(); }
    for (const y of this.yardRects || []) { yx.globalAlpha = y[4] ?? 0.65; yx.fillRect(...P(y[0], y[1]), (y[2] - y[0]) * k, (y[3] - y[1]) * k); }
    for (const g of this.gardenRects || []) { gx.globalAlpha = 0.9; gx.fillRect(...P(g[0], g[1]), (g[2] - g[0]) * k, (g[3] - g[1]) * k); }
    vx.fillStyle = '#fff'; for (const l of this.lawnRects || []) { vx.globalAlpha = 0.9; vx.fillRect(...P(l[0], l[1]), (l[2] - l[0]) * k, (l[3] - l[1]) * k); }  // grassy house yards
    // grass verges along roads / tracks (ground look v6): road -> packed / gravel shoulder (yards layer) -> worn grass -> field
    for (const r of ROADS) { const e = r.type === 'track' ? 4 : 7.5; vx.globalAlpha = r.type === 'track' ? 0.6 : 0.85; vx.fillRect(...P(r.x0 - e, r.z0 - e), (r.x1 - r.x0 + e * 2) * k, (r.z1 - r.z0 + e * 2) * k); }
    for (const [x0, z0, x1, z1] of MAP.treelines) { vx.lineWidth = 22 * k; vx.globalAlpha = 1; vx.beginPath(); vx.moveTo(...P(x0, z0)); vx.lineTo(...P(x1, z1)); vx.stroke(); }
    // wheel ruts / trampled lanes across fields: each one runs from a road / track across the field to the next road /
    // track / trail (or off the map), never starting or stopping in the middle of a field
    yx.strokeStyle = '#fff'; yx.lineCap = 'round'; yx.lineJoin = 'round';
    {
      const belts = MAP.treelines, Fo = MAP.forest, inR = (x, z, q, p = 0) => x > q[0] - p && x < q[2] + p && z > q[1] - p && z < q[3] + p;
      const start = () => {
        const r = ROADS[Math.floor(R() * ROADS.length)], horiz = r.x1 - r.x0 > r.z1 - r.z0, t = 0.03 + R() * 0.94, sd = R() < 0.5 ? -1 : 1, j = (R() - 0.5) * 0.24;
        return horiz ? [r.x0 + t * (r.x1 - r.x0), sd > 0 ? r.z1 + 0.6 : r.z0 - 0.6, sd * Math.PI / 2 + j, r] : [sd > 0 ? r.x1 + 0.6 : r.x0 - 0.6, r.z0 + t * (r.z1 - r.z0), (sd > 0 ? 0 : Math.PI) + j, r];
      };
      const hit = (x, z, r0) => ROADS.some(r => r !== r0 && x > r.x0 - 0.3 && x < r.x1 + 0.3 && z > r.z0 - 0.3 && z < r.z1 + 0.3) || this.nearTrail(x, z, -0.5);
      const bad = (x, z) => belts.some(([a, b, c, d]) => this.segDist(x, z, [a, b], [c, d]) < 7) || (Fo && x > Fo.x0 - 4 && x < Fo.x1 + 4 && z > Fo.z0 - 4 && z < Fo.z1 + 4)
        || (this.yardRects || []).some(q => inR(x, z, q, 2)) || (this.gardenRects || []).some(q => inR(x, z, q, 2)) || this.solidHit(x, z, 1.2, 1.2, 0, 0) || this.terrain.cutSDF(x, z) < 2.5;
      this.ruts = fieldRuts(R, 26, start, hit, bad, MAP_SIZE / 2);
      for (const pts of this.ruts) { yx.globalAlpha = 0.35 + R() * 0.25; yx.lineWidth = 2.6 * k; yx.beginPath(); pts.forEach((p, i) => i ? yx.lineTo(...P(p[0], p[1])) : yx.moveTo(...P(p[0], p[1]))); yx.stroke(); }
    }
    const pt = this.paintTimes = {}, p0 = performance.now(); pt.draw = 0;
    const Y = blurred(yards, 2 * k).getImageData(0, 0, N, N).data, G = blurred(gard, 1.6 * k).getImageData(0, 0, N, N).data, V = blurred(verge, 3 * k).getImageData(0, 0, N, N).data;
    // field type, one-hot (R ploughed, G stubble, B fallow, none = sunflower / maize), blurred ~2.5 m (ground look v7):
    // neighbouring fields fade into each other over a few metres through a weedy balk instead of meeting on a hard,
    // wobbly line; the boundary itself only wobbles gently (field edges are ploughed straight)
    const FT = blurred((() => { const c = layer(), x = c.getContext('2d'), im = x.createImageData(N, N), d = im.data;
      for (let j = 0; j < N; j++) { const z = j / k - o; for (let i = 0; i < N; i++) {
        const x2 = i / k - o, p = (j * N + i) * 4;
        const jx = x2 + (this.noise2(x2 / 30, z / 30, 7) - 0.5) * 3 + (this.noise2(x2 / 5, z / 5, 9) - 0.5) * 1, jz = z + (this.noise2(x2 / 30, z / 30, 8) - 0.5) * 3 + (this.noise2(x2 / 5, z / 5, 10) - 0.5) * 1;
        const t = this.fields[this.fieldIndex(jx, jz)].type;
        d[p] = t === T_PLOW ? 255 : 0; d[p + 1] = t === T_STUB ? 255 : 0; d[p + 2] = t === T_FALLOW ? 255 : 0; d[p + 3] = 255;
      } }
      x.putImageData(im, 0, 0); return c; })(), 3.5 * k).getImageData(0, 0, N, N).data;
    pt.read = Math.round(performance.now() - p0); pt.layers = Math.round(p0 - pa);
    const nx = XS.length - 1;
    for (let j = 0; j < N; j++) {
      const z = j / k - o;
      for (let i = 0; i < N; i++) {
        const x = i / k - o, p = (j * N + i) * 4;
        const n1 = this.noise2(x / 22, z / 22, 1), n2 = this.noise2(x / 6, z / 6, 2);
        // per-type layers weighted by the blurred one-hot field type
        const oP = FT[p] / 255, oS = FT[p + 1] / 255, oF = FT[p + 2] / 255, oC = Math.max(0, 1 - oP - oS - oF);
        let r = oP * Math.max(0, n1 - 0.72) * 2.5 + oS * Math.max(0, n1 - 0.65) * 1.8 + oF * (0.75 + n2 * 0.4) + oC * (0.25 + n1 * 0.35);
        let g = oP + oC * (0.55 + n2 * 0.25), b = oS, a = oF * Math.max(0, 0.35 - n1) * 1.2;   // sunflower / maize: weedy soil between the rows
        // balk where two different fields meet: a weedy, grassy strip (purity of the blurred type < 1)
        const balk = Math.max(0, Math.min(1, (0.9 - Math.max(oP, oS, oF, oC)) / 0.35)) * (0.75 + n2 * 0.5);
        r = Math.max(r, balk * 0.95); g *= 1 - balk * 0.85; b *= 1 - balk * 0.85;
        const ver = V[p + 3] / 255, yd = Y[p + 3] / 255, gd = G[p + 3] / 255;   // alpha: white-on-transparent layers (v7)
        r = Math.max(r * (1 - ver), ver * (0.85 + n2 * 0.3)); g *= 1 - ver; b *= 1 - ver;
        if (gd > 0) { g = Math.max(g * (1 - gd), gd * (0.75 + n2 * 0.3)); r *= 1 - gd * 0.7; b *= 1 - gd; }
        a = Math.max(a, yd); r *= 1 - yd * 0.6; g *= 1 - yd * 0.8; b *= 1 - yd * 0.8;
        const fm = this.forestMask ? this.forestMask[Math.floor((z + o) / 4) * this.forestMN + Math.floor((x + o) / 4)] : 0;
        if (fm === 1) { r = 0.6 + n2 * 0.3; g = 0; b = 0; a = Math.max(a, 0.25 + n1 * 0.3); }          // leaf litter under the stand
        else if (fm === 2) { r = 0.85 + n2 * 0.2; g = 0; b = 0; a = Math.max(a * 0.5, Math.max(0, 0.3 - n1) * 0.6); } // grassy clearing
        const ti = Math.floor(x + o), tj = Math.floor(z + o);
        if (TM && ti >= 0 && tj >= 0 && ti < TN && tj < TN && TM[tj * TN + ti]) { g *= 0.05; r *= 0.2; b *= 0.05; a = Math.max(a * 0.5, 0.12); } // fresh spoil: bare loess / soil (no ploughed rows, no stubble)
        out[p] = Math.min(255, r * 255); out[p + 1] = Math.min(255, g * 255); out[p + 2] = Math.min(255, b * 255); out[p + 3] = Math.min(255, a * 255);
      }
    }
    pt.loop = Math.round(performance.now() - p0);
    const t = new THREE.DataTexture(out, N, N, THREE.RGBAFormat); t.flipY = false; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    this.groundUniforms.tSplat.value = t; this.splatData = out; this.splatN = N;
    // row direction (nearest-sampled)
    const RN = 512, rows = new Uint8Array(RN * RN * 4), rk = RN / MAP_SIZE;
    for (let j = 0; j < RN; j++) for (let i = 0; i < RN; i++) { const x = (i + 0.5) / rk - o, z = (j + 0.5) / rk - o, f = this.fields[this.fieldIndex(x, z)]; const p = (j * RN + i) * 4; rows[p] = f.rowsX ? 255 : 0; rows[p + 1] = Math.min(255, Math.min(x - f.x0, f.x1 - x, z - f.z0, f.z1 - z) / 22 * 255); }
    const rt = new THREE.DataTexture(rows, RN, RN, THREE.RGBAFormat); rt.flipY = false; rt.magFilter = rt.minFilter = THREE.NearestFilter; rt.needsUpdate = true;   // (G is read with a wobble: nearest is fine)
    this.groundUniforms.tRows.value = rt;
    pt.rows = Math.round(performance.now() - p0);
    this.grassClumps();
    pt.grass = Math.round(performance.now() - p0);
  }
  // ---------------------------------------------------------------- roads & tracks
  roads() {
    // regional roads: old, sun-bleached asphalt, crumbling ragged edges on a gravel shoulder, potholes, patches, shell
    // scars and mud tracked in from the fields (wear.js roadWear reads the war map)
    const asphalt = roadWear(this.mat('asphalt', 1, { color: 0xc4c0b6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), this.groundUniforms, { rural: true, damage: 1 });
    const T = this.assets.tex, trackTex = T.track?.map || T.dirt?.map;
    const a = document.createElement('canvas'); a.width = 64; a.height = 4; { const x = a.getContext('2d'), gr = x.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, '#000'); gr.addColorStop(0.18, '#fff'); gr.addColorStop(0.82, '#fff'); gr.addColorStop(1, '#000'); x.fillStyle = gr; x.fillRect(0, 0, 64, 4); }
    const alpha = new THREE.CanvasTexture(a); alpha.wrapT = THREE.RepeatWrapping;
    const trackMat = new THREE.MeshStandardMaterial({ map: trackTex ? trackTex.clone() : null, alphaMap: alpha, transparent: true, depthWrite: false, roughness: 1, color: T.track ? 0xffffff : 0xb0a28a, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    if (trackMat.map) { trackMat.map.wrapS = trackMat.map.wrapT = THREE.RepeatWrapping; trackMat.map.needsUpdate = true; }
    if (T.track?.normalMap) { trackMat.normalMap = T.track.normalMap.clone(); trackMat.normalMap.wrapS = trackMat.normalMap.wrapT = THREE.RepeatWrapping; trackMat.normalMap.needsUpdate = true; trackMat.normalScale = new THREE.Vector2(0.9, 0.9); }
    trackWear(trackMat, this.groundUniforms); this.trackMat = trackMat;   // muddy ruts with standing water
    const strip = (w, len, texW) => { const g = new THREE.PlaneGeometry(w, len); g.rotateX(-Math.PI / 2); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i), uv.getY(i) * len / texW); return g; };
    for (const r of ROADS) this.nav.markRoad(r.x0 - (r.type === 'track' ? 0.6 : 0), r.z0 - (r.type === 'track' ? 0.6 : 0), r.x1 + (r.type === 'track' ? 0.6 : 0), r.z1 + (r.type === 'track' ? 0.6 : 0), r.type === 'track' ? 1 : 2);
    // roads v2 (roadmesh.js): the paved roads merged into one same-level surface with filleted junctions; the tracks stay
    // strip ribbons at the same level, under the asphalt by polygonOffset
    { const S = roadSurfaces(ROADS.filter(r => r.type !== 'track').map(r => { const w = r.x1 - r.x0, d = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
        return { pts: w > d ? [[r.x0, cz], [r.x1, cz]] : [[cx, r.z0], [cx, r.z1]], hw: Math.min(w, d) / 2, sw: 0, rad: 4, kerb: false, ext: 0 }; }), { key: 'farm' });
      this.roadStats = { ms: S.ms, tris: S.tris, cached: S.cached };
      for (const g of S.asphalt) { const m = new THREE.Mesh(g, asphalt); m.receiveShadow = true; this.scene.add(m); } }
    for (const r of ROADS) {
      const w = r.x1 - r.x0, d = r.z1 - r.z0, horiz = w > d, len = horiz ? w : d, wid = horiz ? d : w;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      if (r.type === 'track') {
        const m = new THREE.Mesh(strip(wid + 1.2, len, 4.5), trackMat); m.position.set(cx, ROAD_Y, cz); if (horiz) m.rotation.y = Math.PI / 2; m.receiveShadow = true; m.renderOrder = 1; this.scene.add(m);
      } else {
        // junction: the later paved road is cut where an earlier one crosses (no coplanar overlap -> no z-fighting)
        const paved = ROADS.filter(o => o.type !== 'track'), above = paved.slice(0, paved.indexOf(r));
        const dash = this._dashM ||= new THREE.MeshStandardMaterial({ color: 0xa9a598, roughness: 0.9, transparent: true, opacity: 0.32, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });   // faded paint
        const inX = (x, z) => above.some(o => x > o.x0 - 6 && x < o.x1 + 6 && z > o.z0 - 6 && z < o.z1 + 6);
        const mats = []; for (let t = -len / 2 + 2; t < len / 2; t += 12) if (this.rng() > 0.55) { const x = horiz ? cx + t : cx, z = horiz ? cz : cz + t; if (!inX(x, z)) mats.push(trs(x, ROAD_Y, z, horiz ? 0 : Math.PI / 2)); }
        const dg = new THREE.PlaneGeometry(3, 0.12); dg.rotateX(-Math.PI / 2); instance(this.scene, new THREE.Mesh(dg, dash), mats, { shadows: false });
      }
    }
  }
  // ---------------------------------------------------------------- kolkhoz farm (objective B)
  farm() {
    const { x: fx, z: fz } = MAP.farm, R = this.rng;
    const big = { inst: { lodDist: 520 } };
    this.put(this.burntTpl('barn_kolkhoz') || 'barn_kolkhoz', fx, fz - 27, 0, { occ: true, ...big });   // burnt out, roof gone
    (this.burntSpots ||= []).push([fx - 12, fz - 27, 22], [fx + 14, fz - 25, 16], [fx - 18, fz + 4, 6], [fx + 50, fz + 30, 7]);
    this.put('barn_kolkhoz_damaged', fx, fz + 28, 0, { occ: true, ...big });
    this.put('machine_shed', fx + 72, fz, Math.PI / 2, { cost: 6, navScale: 0.35 });
    this.put('grain_silo', fx - 68, fz - 4, 0, { occ: true });
    this.put('water_tower_damaged', fx - 62, fz + 40, 0.4, { circle: 3.2 });
    this.put('water_tower', fx + 60, fz - 52, 0, { circle: 3.2 });
    this.put('tractor_mtz80_burnt', fx - 18, fz + 4, 0.7, { cost: BLOCK, low: true });
    this.put('tractor_mtz80', fx + 30, fz - 6, 2.2, { cost: BLOCK });
    this.put('combine_niva_burnt', fx + 50, fz + 30, 1.4, { cost: BLOCK });
    this.put('trailer_farm', fx + 14, fz + 10, 0.2, { cost: 6, low: true });
    for (let i = 0; i < 9; i++) this.put(R() < 0.25 ? 'haybale_round_burnt' : 'haybale_round', fx + 30 + (i % 3) * 2.2 + (R() - .5) * 0.6, fz + 52 + Math.floor(i / 3) * 2.4, R() * 0.3, { cost: 7, low: true });
    for (const [x, z] of [[fx - 40, fz - 48], [fx + 85, fz + 48], [fx - 85, fz - 40]]) this.put('haystack', x, z, R() * 6, { circle: 2.6, cost: BLOCK });
    // concrete fence along the north side of the yard (only tanks push through)
    for (let x = fx - 92; x < fx + 92; x += 4) if (R() < 0.8 && Math.abs(x - fx) > 7) this.put('fence_po2_a', x, fz - 58, 0, { crush: 'tank' });
    this.yardRects = [[fx - 95, fz - 60, fx + 95, fz + 62, 0.8]];
    this.concealRect(fx - 95, fz - 60, fx + 95, fz + 62, 255);
  }
  // ---------------------------------------------------------------- crossroads farmstead (objective D)
  farmstead() {
    const F = MAP.farmstead; if (!F) return;
    const { x: fx, z: fz } = F, R = this.rng;
    this.put('house_b', fx - 22, fz + 14, 0, { occ: 3.2 }); this.put('house_d', fx + 24, fz + 15, 0, { occ: 3.2 });
    this.put('machine_shed', fx, fz - 16, 0, { cost: 6, navScale: 0.35 });
    this.put('shed_wood', fx - 34, fz - 2, Math.PI / 2); this.put('shed_wood', fx + 36, fz - 4, -Math.PI / 2); this.put('outhouse', fx - 34, fz - 14, Math.PI / 2);
    this.put('well_village', fx + 2, fz + 10, 0); this.put('woodpile', fx - 12, fz + 4, 0.1, { cost: 7, low: true });
    this.put('tractor_mtz80_burnt', fx + 12, fz + 2, 2.4, { cost: BLOCK, low: true }); this.put('trailer_farm', fx - 4, fz + 1, 1.5, { cost: 6, low: true });
    (this.burntSpots ||= []).push([fx + 12, fz + 2, 6]);
    this.put('haystack', fx + 33, fz - 22, 1, { circle: 2.6, cost: BLOCK }); this.put('haystack', fx - 30, fz - 24, 2, { circle: 2.6, cost: BLOCK });
    for (let i = 0; i < 5; i++) this.put(R() < 0.4 ? 'haybale_round_burnt' : 'haybale_round', fx + 18 + i * 2.3, fz - 3 + (R() - .5), R() * 0.3, { cost: 7, low: true });
    for (const [x, z] of [[fx - 6, fz + 20], [fx + 38, fz + 8], [fx - 38, fz + 12]]) this.put('tree_walnut_leafy', x, z, R() * 6, { s: 0.9 + R() * 0.2, circle: 0.5, lod: this.tpl('tree_walnut_leafy_lod1') ? 'tree_walnut_leafy_lod1' : null, inst: { lodDist: 200, cullDist: 900 } });
    // board fence along the track with a gate, wattle on the sides
    for (let x = fx - 38; x <= fx + 39; x += 3) { if (Math.abs(x - fx + 2) < 2.5) { this.put('gate_village', x, fz + 21.5, 0, { crush: 'any', check: false }); continue; } if (R() < 0.15) continue; this.put('fence_wood_village', x, fz + 21.5, (R() - .5) * 0.05, { crush: 'any', check: false }); }
    for (const sx of [-1, 1]) for (let z = fz - 27; z < fz + 20; z += 3) { if (R() < 0.25) continue; this.put('fence_wattle', fx + sx * 40.5, z, Math.PI / 2, { crush: 'any', check: false }); }
    (this.yardRects ||= []).push([fx - 40, fz - 30, fx + 42, fz + 22, 0.8]);
    this.concealRect(fx - 40, fz - 30, fx + 42, fz + 22, 190);
  }
  // ---------------------------------------------------------------- forest block: mixed broadleaf woodland
  // oak / robinia / poplar canopy on a ~6.4 m jittered grid, hazel-elder-rose understorey (dense on the ecotone edge),
  // shell-damaged trees along the edges facing the fields, deadfall; rides and clearings left open.
  forest() {
    const F = MAP.forest; if (!F) return;
    const R = this.rng, half = MAP_SIZE / 2;
    const MN = this.forestMN = Math.ceil(MAP_SIZE / 4), mask = this.forestMask = new Uint8Array(MN * MN);
    for (let j = Math.floor((F.z0 - 20 + half) / 4); j < Math.ceil((F.z1 + 20 + half) / 4); j++) for (let i = Math.floor((F.x0 - 20 + half) / 4); i < Math.ceil((F.x1 + 20 + half) / 4); i++) { const x = i * 4 - half + 2, z = j * 4 - half + 2; if (this.inForest(x, z)) mask[j * MN + i] = 1; else if (this.inForest(x, z, 0, true)) mask[j * MN + i] = 2; }
    const kinds = [['tree_oak_leafy', 0.38], ['tree_acacia_leafy', 0.3], ['tree_poplar_leafy', 0.12], ['tree_walnut_leafy', 0.06], ['tree_acacia_shelled', 0.14]];
    const pick = (shell) => { if (R() < shell) return 'tree_acacia_shelled'; let r = R() * 0.86; for (const [n, w] of kinds) { if (n === 'tree_acacia_shelled') continue; if ((r -= w) < 0) return n; } return 'tree_oak_leafy'; };
    const items = [], sp = 6.4;
    for (let z = F.z0 - 12; z < F.z1 + 12; z += sp) for (let x = F.x0 - 12; x < F.x1 + 12; x += sp) {
      const px = x + (R() - .5) * sp * 0.85, pz = z + (R() - .5) * sp * 0.85;
      if (!this.inForest(px, pz) || onRoad(px, pz, 3.2) || this.terrain.cutSDF(px, pz) < 1.8) continue;
      const edge = !this.inForest(px, pz, -10), front = (F.z1 - pz < 30) || (F.x1 - px < 30);
      const n = pick(edge && front ? 0.4 : front ? 0.18 : 0.06), s = edge ? 0.72 + R() * 0.36 : 0.82 + R() * 0.5 * (0.6 + this.noise2(px / 40, pz / 40, 37));
      items.push([n, trs(px, 0, pz, R() * 6.28, s)]); this.nav.circle(px, pz, 0.45, BLOCK);
      if (R() < (edge ? 0.75 : 0.28)) { const bx = px + (R() - .5) * 4, bz = pz + (R() - .5) * 4; if (!onRoad(bx, bz, 2) && this.terrain.cutSDF(bx, bz) > 1.6) { items.push([R() < 0.55 ? 'bush_a' : 'bush_b', trs(bx, 0, bz, R() * 6.28, 0.8 + R() * 0.6)]); this.nav.circle(bx, bz, 1.0, 4); } }
      if (R() < 0.025) { const fx2 = px + (R() - .5) * 5, fz2 = pz + (R() - .5) * 5; if (!onRoad(fx2, fz2, 3) && this.terrain.cutSDF(fx2, fz2) > 3) this.put('fallen_trunk', fx2, fz2, R() * 6, { cost: 5, low: true, check: false, inst: { cullDist: 420 } }); }
    }
    // ecotone fringe: young trees and scrub spilling 0-12 m out of the stand, thinning out into the field
    for (let z = F.z0 - 16; z < F.z1 + 16; z += 3.2) for (let x = F.x0 - 16; x < F.x1 + 16; x += 3.2) {
      const px = x + (R() - .5) * 2.6, pz = z + (R() - .5) * 2.6;
      if (this.inForest(px, pz) || !this.inForest(px, pz, 12) || onRoad(px, pz, 3) || this.terrain.cutSDF(px, pz) < 2 || this.inVillage(px, pz, 4)) continue;
      const near = this.inForest(px, pz, 5), r = R();
      if (r < (near ? 0.3 : 0.12)) { items.push([R() < 0.5 ? 'bush_a' : 'bush_b', trs(px, 0, pz, R() * 6.28, 0.6 + R() * 0.7)]); this.nav.circle(px, pz, 0.9, 4); }
      else if (r < (near ? 0.38 : 0.15)) { items.push([R() < 0.6 ? 'tree_acacia_leafy' : 'tree_oak_leafy', trs(px, 0, pz, R() * 6.28, 0.5 + R() * 0.3)]); this.nav.circle(px, pz, 0.35, BLOCK); }
    }
    this.forestInstancing(items);
    // no vehicles through the stand (rides and clearings excepted), undergrowth slows infantry, heavy concealment
    for (let z = F.z0 - 10; z < F.z1 + 10; z += 1) for (let x = F.x0 - 10; x < F.x1 + 10; x += 1) {
      if (!this.inForest(x, z, -1.5) || onRoad(x, z, 0.5)) continue; const i = this.nav.idx(x, z); if (i < 0) continue;
      this.nav.veh ||= new Uint8Array(this.nav.n * this.nav.n); this.nav.veh[i] = 2; if (this.nav.cost[i] < 2) this.nav.cost[i] = 2;
    }
    this.nav.vehDirty = true;
    for (let z = F.z0 - 10; z < F.z1 + 10; z += 2) for (let x = F.x0 - 10; x < F.x1 + 10; x += 2) if (this.inForest(x, z)) this.concealRect(x, z, x + 1.9, z + 1.9, 70);
    // line-of-sight: you see ~28 m into the wood (rows of foliage occluders)
    for (let z = F.z0 - 8; z < F.z1 + 8; z += 16) {
      let run = null; const close = (x1) => { if (run !== null && x1 - run > 8) { const o = this.nav.addOccluder((run + x1) / 2, z + 8, (x1 - run) / 2, 8, 0, 16, null); o.foliage = true; o.depth = 28; } run = null; };
      for (let x = F.x0 - 10; x < F.x1 + 12; x += 4) { if (this.inForest(x, z + 8, 2)) { if (run === null) run = x; } else close(x); }
      close(F.x1 + 12);
    }
  }
  // per species: near (< 32 m) full model, mid (< 175 m) *_mid (bushes: lod1), far lod1 in 270 m blocks
  forestInstancing(items) {
    const by = new Map(), v = new THREE.Vector3();
    for (const [n, M] of items) { v.setFromMatrixPosition(M); if (this.terrain.cutSDF(v.x, v.z) < (/bush/.test(n) ? 1.2 : 1.6)) continue; M.elements[13] = this.baseY(v.x, v.z, 0.35, 0.35); (by.get(n) || by.set(n, []).get(n)).push(M); }
    for (const [n, mats] of by) {
      const mid = this.hasTpl(n + '_mid') ? this.tpl(n + '_mid') : null, lod = this.tpl(n + '_lod1');
      instance(this.scene, this.tpl(n), mats, { lod, mid: mid || lod, nearDist: 12, lodDist: mid ? 175 : 70, cullDist: 1600, coarse: 3, midShadows: !/bush/.test(n), lodShadows: false });
    }
  }
  // ---------------------------------------------------------------- villages
  villages() {
    const R = this.rng; this.gardenRects ||= []; this.yardRects ||= [];
    const fences = ['fence_wattle', 'fence_wood_village'];
    const houseNames = ['house_a', 'house_b', 'house_c', 'house_d', 'house_e'].filter(n => this.tpl(n)); if (!houseNames.length) houseNames.push('shed_wood');
    const trees = ['tree_walnut_leafy', 'leafy_summer_chestnut', 'tree_acacia_leafy', 'leafy_summer_birch'];
    this.houseSpots = [];
    for (const v of MAP.villages) {
      const along = v.street === 'x';
      for (let t = v.from + 12; t < v.to - 10; t += 22 + R() * 6) for (const side of v.side ? [v.side] : [-1, 1]) {
        if (R() < 0.1) continue;
        // local -> world: u along the street, w outward from the street edge
        const W = (u, w) => along ? [u, side < 0 ? v.z0 - w : v.z1 + w] : [side < 0 ? v.x0 - w : v.x1 + w, u];
        const face = along ? (side < 0 ? 0 : Math.PI) : (side < 0 ? Math.PI / 2 : -Math.PI / 2);
        const [hx, hz] = W(t + (R() - .5) * 3, 8.5 + R() * 2.5);
        if (this.overlapsBuilding(hx, hz, 12, 12, 0)) continue;
        if (onRoad(hx, hz, 5) || this.terrain.cutSDF(hx, hz) < 9) continue;
        // Kurylivka (nearest the enemy line) and the hamlet at the crossroads are the worst hit
        const dP = v.name === 'Kurylivka' ? 0.44 : v.name === 'Novomykolaivka' ? 0.3 : 0.4;
        const destroyed = R() < dP, burnt = destroyed && R() < 0.55;
        const hn = houseNames[Math.floor(R() * houseNames.length)], bn = burnt ? this.burntTpl(hn) : null;
        if (!destroyed) { if (!this.put(hn, hx, hz, face + (R() - .5) * 0.08, { occ: 3.2 })) continue; }
        else if (bn) { if (!this.put(bn, hx, hz, face + (R() - .5) * 0.1, { occ: 2.4 })) continue; (this.burntSpots ||= []).push([hx, hz, 9]); }
        else {
          // flattened: wall stubs along the outline (plinth, a corner / the chimney standing: wear.js houseRuin 'flat') with the
          // heap inside them, not a heap on an empty plot; the bare heap only if the variant cannot be built / placed
          const pool = this.rubblePool('house'), ht = pool[Math.floor(R() * pool.length)], hr = R() * 6, hs = 1.15 + R() * 0.35, fl = ruinTpl(this, hn, 'flat');
          if (fl && this.put(fl, hx, hz, face, { cost: 7, low: true, occ: 0.9 })) { (this._houseRubble ||= []).push([ht, trs(hx, 0, hz, hr, hs * 0.58)]); this.nav.circle(hx, hz, 2.6, 6, true); this.nav.setVeh(hx, hz, 4, 4, face, 1); }
          else { (this._houseRubble ||= []).push([ht, trs(hx, 0, hz, hr, hs)]); this.nav.circle(hx, hz, 4.5, 6, true); this.solidAdd(hx, hz, 5.6, 5.6, 0, 'house'); }
        }
        this.houseSpots.push([hx, hz, destroyed]);
        // street fence with a gate, side fences around the front yard
        const fn = fences[Math.floor(R() * 2)], fr = along ? 0 : Math.PI / 2;
        for (let u = -10.5; u <= 10.5; u += 3) { if (R() < 0.22) continue; const [x, z] = W(t + u, 1.6); if (onRoad(x, z, 0.6) || this.overlapsBuilding(x, z, 1.6, 0.3, 0) || this.terrain.cutSDF(x, z) < 2 || this.houseNear(x, z, fr)) continue; if (Math.abs(u) < 2) { this.put('gate_village', x, z, fr, { crush: 'any', check: false }); continue; } this.put(fn, x, z, fr + (R() - .5) * 0.06, { crush: 'any', check: false }); }
        for (const su of [-12, 12]) for (let w = 3.2; w < 20; w += 3) { if (R() < 0.3) continue; const [x, z] = W(t + su, w); if (onRoad(x, z, 0.6) || this.overlapsBuilding(x, z, 1.6, 0.3, 0) || this.terrain.cutSDF(x, z) < 2 || this.houseNear(x, z, fr + Math.PI / 2)) continue; this.put(fn, x, z, fr + Math.PI / 2, { crush: 'any', check: false }); }
        // back yard: outbuildings, well, woodpile, then the vegetable garden and a fruit/walnut tree
        const yb = [['shed_wood', 22, 6], ['outhouse', 27, -7], ['woodpile', 20, -5], ['well_village', 18, 7], ['greenhouse_frame', 31, 4]];
        for (const [n, w, u] of yb) if (R() < (n === 'shed_wood' ? 0.85 : 0.5)) { const [x, z] = W(t + u + (R() - .5) * 2, w + (R() - .5) * 2); this.put(n, x, z, face + (R() < 0.5 ? 0 : Math.PI / 2), { cost: n === 'woodpile' ? 7 : BLOCK, low: n === 'woodpile' }); }
        const [gx0, gz0] = W(t - 11, 34), [gx1, gz1] = W(t + 11, v.depth);
        this.gardenRects.push([Math.min(gx0, gx1), Math.min(gz0, gz1), Math.max(gx0, gx1), Math.max(gz0, gz1)]);
        const [yx0, yz0] = W(t - 11, 2), [yx1, yz1] = W(t + 11, 33);
        (this.lawnRects ||= []).push([Math.min(yx0, yx1), Math.min(yz0, yz1), Math.max(yx0, yx1), Math.max(yz0, yz1)]);
        for (let q = 0; q < 2; q++) if (R() < 0.75) { const [x, z] = W(t + (R() - .5) * 18, 14 + R() * 24); const n = trees[Math.floor(R() * trees.length)]; this.put(n, x, z, R() * 6, { s: 0.85 + R() * 0.3, circle: 0.5, lod: this.tpl(n + '_lod1') ? n + '_lod1' : null, inst: { lodDist: 200, cullDist: 900 } }); }
        this.concealRect(...W(t - 11, 2), ...W(t + 11, v.depth), 190);
      }
      // a roadside cross and a bus stop at the village edge
      const [cx, cz] = along ? [v.from - 6, v.z1 + 4] : [v.x1 + 4, v.to + 6]; this.put('cross_roadside', cx, cz, along ? Math.PI : -Math.PI / 2, { circle: 0.4 });
      const [bx, bz] = along ? [(v.from + v.to) / 2 + 40, v.z0 - 4] : [v.x0 - 4, (v.from + v.to) / 2 - 30]; this.put('bus_stop_village', bx, bz, along ? 0 : Math.PI / 2, { roadPad: 0 });
    }
    { const by = new Map(); for (const [t, M] of this._houseRubble || []) { (by.get(t) || by.set(t, []).get(t)).push(M); this.terrain.stamp(t, M); } for (const [t, l] of by) instance(this.scene, t, l, this.rubbleInst?.(t, l) || farLod(t)); }   // (heaps: simplified copy beyond ~80 m, world/instancer.js)
    // a church at the west end of Novomykolaivka, cars in the yards
    this.put('church_small', -300, 98, Math.PI, { occ: true });
    for (const [hx, hz, d] of this.houseSpots) if (!d && R() < 0.22) this.put(R() < 0.6 ? 'car_parked_lada' : 'car_vaz2107_burnt', hx + (R() - .5) * 10, hz + (R() < .5 ? 7 : -7), R() * 6, { cost: BLOCK });
  }
  // ---------------------------------------------------------------- windbreaks
  treelines() {
    const R = this.rng;
    const kinds = [['tree_acacia_leafy', 0.48], ['tree_oak_leafy', 0.14], ['tree_poplar_leafy', 0.14], ['tree_acacia_shelled', 0.24]];
    const pick = () => { let r = R(); for (const [n, w] of kinds) { if ((r -= w) < 0) return n; } return kinds[0][0]; };
    const lodOf = n => this.tpl(n + '_lod1') ? n + '_lod1' : null;
    for (const [x0, z0, x1, z1] of MAP.treelines) {
      const L = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / L, uz = (z1 - z0) / L, nx = -uz, nz = ux, rot = Math.atan2(-uz, ux);
      let gap = 0, run = null;
      const close = () => { if (run && run[1] - run[0] > 6) { const a = (run[0] + run[1]) / 2, hl = (run[1] - run[0]) / 2; const o = this.nav.addOccluder(x0 + ux * a, z0 + uz * a, hl, 5.5, rot, 9, null); o.foliage = true; } run = null; };
      for (let t = 2; t < L; t += 4.2 + R() * 2.4) {
        const cx = x0 + ux * t, cz = z0 + uz * t;
        if (Math.abs(cx) > MAP_SIZE / 2 - 3 || Math.abs(cz) > MAP_SIZE / 2 - 3) { close(); continue; }
        if (onRoad(cx, cz, 7) || this.inVillage(cx, cz, 2) || this.inFarm(cx, cz, 4) || this.inFarmstead(cx, cz, 3) || this.inForest(cx, cz, 4)) { close(); continue; }
        if (this.nearTrail(cx, cz, 5)) { close(); continue; }   // gap driven through the belt
        const burntB = this.nearBurntBelt(cx, cz);
        if (gap > 0) { gap -= 5; close(); continue; }
        if (R() < 0.03) { gap = 6 + R() * 16; close(); continue; }
        if (!run) run = [t, t]; run[1] = t + 3;
        for (const off of [-3.4, 0.2, 3.6]) {
          const o2 = off + (R() - .5) * 1.4, px = cx + nx * o2 + ux * (R() - .5) * 2, pz = cz + nz * o2 + uz * (R() - .5) * 2;
          if (this.terrain.cutSDF(px, pz) < 1.6 || this.teethNear(px, pz) || this.solidHit(px, pz, 0.45, 0.45, 0, 0.3)) continue;
          if (off === 0.2 || R() < 0.12) { if (R() < (burntB ? 0.3 : 0.75)) { const b = treeFate(this, R() < 0.5 ? 'bush_a' : 'bush_b', px, pz); this.put(b, px, pz, R() * 6, { s: 0.8 + R() * 0.6, circle: 1.1, cost: 4, check: false, lod: lodOf(b), inst: { lodDist: 90, cullDist: 700, lodShadows: false } }); } continue; }
          if (burntB && R() < 0.22) continue;                                   // trees felled by the shelling
          const n = treeFate(this, burntB && R() < 0.72 ? 'tree_acacia_shelled' : pick(), px, pz), ry = R() * 6; if (!this.put(n, px, pz, ry, { s: 0.8 + R() * 0.4, circle: 0.45, check: false, lod: lodOf(n), inst: { lodDist: 210, cullDist: 1500 }, ...treeTilt(this, n, px, pz, ry) })) continue;
        }
        // undergrowth litter & fallen limbs
        if (R() < (burntB ? 0.16 : 0.05)) this.put('fallen_trunk', cx + nx * (R() - .5) * 8, cz + nz * (R() - .5) * 8, R() * 6, { cost: 5, low: true, check: false, trench: true, inst: { cullDist: 420 } });
        this.concealRect(cx - 6.5 - Math.abs(ux) * 3, cz - 6.5 - Math.abs(uz) * 3, cx + 6.5 + Math.abs(ux) * 3, cz + 6.5 + Math.abs(uz) * 3, 105);
      }
      close();
    }
  }
  // ---------------------------------------------------------------- crops
  crops() {
    // own stream: the number of draws depends on the quality cap, and peers on different quality settings must build the
    // same map after this step (layout and nav from this.rng)
    const R = mulberry(0x5bd1e995 ^ 4417), cap = this.quality === 'low' ? 7000 : this.quality === 'medium' ? 12000 : 16000;
    const inst = { shadows: this.quality === 'high', cullDist: this.quality === 'high' ? 300 : 230 };
    for (const f of this.fields) {
      if (f.type !== T_SUN && f.type !== T_CORN && f.type !== T_FALLOW) continue;
      const name = f.type === T_SUN ? 'sunflower_dead_clump' : f.type === T_CORN ? 'corn_dry_clump' : 'weeds_tall_clump';
      const along = f.type === T_FALLOW ? 3.4 : f.type === T_SUN ? 1.8 : 1.6, across = f.type === T_FALLOW ? 3.4 : f.type === T_SUN ? 1.55 : 1.35;
      const w = f.x1 - f.x0, d = f.z1 - f.z0, area = w * d;
      const n = area / (along * across), keep = Math.min(1, cap / n);
      for (let a = f.x0 + 6; a < f.x1 - 6; a += f.rowsX ? along : across) for (let b = f.z0 + 6; b < f.z1 - 6; b += f.rowsX ? across : along) {
        if (R() > keep) continue;
        const x = a + (R() - .5) * (f.type === T_FALLOW ? 3 : 0.5), z = b + (R() - .5) * (f.type === T_FALLOW ? 3 : 0.5);
        const pn = this.noise2(x / 26, z / 26, 11);
        if (pn < (f.type === T_FALLOW ? 0.45 : 0.22) || (pn < 0.35 && R() < 0.5)) continue; // trampled / burnt patches
        if (onRoad(x, z, 2.5) || this.inVillage(x, z) || this.inFarm(x, z) || this.inFarmstead(x, z) || this.inForest(x, z, 3) || this.nearCrater(x, z, 0.9)) continue;
        if (this.onTrail(x, z) || (this.inBurn(x, z) && R() < 0.8)) continue;   // driven flat / burnt off
        if (this.terrain.cutSDF(x, z) < 1.4 || this.uneven(x, z, 0.8) > 0.25) continue;   // not on spoil / crater rims
        const ci = this.nav.idx(x, z); if (ci < 0 || this.nav.cost[ci] !== 1) continue;
        this.put(name, x, z, R() * 6.28, { s: 0.8 + R() * 0.45, cost: 0, check: false, trench: false, inst, rx: (R() - .5) * 0.12, rz: (R() - .5) * 0.12 });
      }
      if (MAP.forest && f.x1 <= MAP.forest.x1 + 10 && f.x0 >= MAP.forest.x0 - 30 && f.z0 >= MAP.forest.z0 - 30 && f.z1 <= MAP.forest.z1 + 100) continue; // under the forest
      if (f.type !== T_FALLOW) this.concealRect(f.x0 + 6, f.z0 + 6, f.x1 - 6, f.z1 - 6, 140);
      else this.concealRect(f.x0 + 6, f.z0 + 6, f.x1 - 6, f.z1 - 6, 215);
    }
  }
  // ---------------------------------------------------------------- power lines along the paved roads
  poles() {
    const T = this.templatesFrom('wires', { pole: /^(utility_)?pole|utility/i, concertina: /concertina|razor/i });
    this.wireT = T;
    let pole = T.pole?.[0];
    if (!pole) { const conc = new THREE.MeshStandardMaterial({ color: 0x99958b, roughness: 0.9 }); pole = new THREE.Group(); const p = new THREE.Mesh(new THREE.BoxGeometry(0.22, 9.5, 0.22), conc); p.position.y = 4.75; pole.add(p); const a = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.1), conc); a.position.y = 9; pole.add(a); }
    const att = (() => { const pts = []; pole.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(pole.matrixWorld).invert(); pole.traverse(o => { if (!o.isMesh && /attach|wire|insul/i.test(o.name)) pts.push(o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv)); }); if (!pts.length) { const b = new THREE.Box3().setFromObject(pole); pts.push(new THREE.Vector3(0.7, b.max.y - b.min.y - 0.5, 0), new THREE.Vector3(-0.7, b.max.y - b.min.y - 0.5, 0)); } return pts; })();
    const lines = [], mats = [];
    const run = (x0, z0, x1, z1, rotY) => {
      const n = Math.floor(Math.hypot(x1 - x0, z1 - z0) / 42), tops = [];
      for (let i = 0; i <= n; i++) {
        const x = x0 + (x1 - x0) * i / n, z = z0 + (z1 - z0) * i / n;
        if (onRoad(x, z, -0.5) || Math.abs(x) > MAP_SIZE / 2 - 4 || Math.abs(z) > MAP_SIZE / 2 - 4 || this.solidHit(x, z, 1.0, 0.3, rotY, 0.2) || this.terrain.cutSDF(x, z) < 1.5) { tops.push(null); continue; }
        const broken = this.rng() < 0.15, M = trs(x, this.baseY(x, z, 0.2, 0.2), z, rotY, 1, broken ? (this.rng() - .5) * 0.6 : (this.rng() - .5) * 0.05, (this.rng() - .5) * 0.06); mats.push(M);
        this.nav.circle(x, z, 0.4, BLOCK); tops.push(broken ? null : att.map(a => a.clone().applyMatrix4(M)));
      }
      for (let i = 0; i < tops.length - 1; i++) { const a = tops[i], b = tops[i + 1]; if (!a) continue; for (let q = 0; q < a.length; q++) { if (this.rng() < 0.1) continue; if (b && b[q]) lines.push(catenary(a[q], b[q], 1.4 + this.rng() * 0.6)); else { const e = a[q].clone().add(new THREE.Vector3((x1 - x0) / n * 0.35, 0, (z1 - z0) / n * 0.35)); e.y = 0.05; lines.push(catenary(a[q], e, 0.8)); } } }
    };
    run(-MAP_SIZE / 2 + 6, 56, MAP_SIZE / 2 - 6, 56, 0); run(111.5, -MAP_SIZE / 2 + 6, 111.5, MAP_SIZE / 2 - 6, Math.PI / 2);
    instance(this.scene, pole, mats);
    if (lines.length) buildWires(this.scene, lines, (x, z) => this.terrain.heightAt(x, z));   // (streets v2: screen-space ribbons, powerWires.js)
  }
  // ---------------------------------------------------------------- props: wrecks along the roads, field debris
  props() {
    const T = this.templatesFrom('props', { car: /car|sedan|vaz|lada|zhiguli/i, bus: /bus(?!_?stop)|paz|minibus/i, hedgehog: /hedgehog/i, sandbag: /sandbag/i, tyre: /tyre|tire/i, crater: /crater/i });
    this.propT = T; const R = this.rng;
    const one = (list, x, z, ry, cost = BLOCK) => { if (!list) return; const t = list[Math.floor(R() * list.length)]; const k = 'p_' + t.name; (this.place[k] ||= { t, m: [], opts: {} }).m.push(trs(x, this.tplBaseY(t, x, z, ry), z, ry)); const bb = t.userData.bb ||= new THREE.Box3().setFromObject(t); this.nav.rect(x, z, (bb.max.x - bb.min.x) / 2, (bb.max.z - bb.min.z) / 2, ry, cost, 0.2); };
    // burnt-out cars on the regional roads (shot up on the move), a bus at the village
    for (let i = 0; i < 14; i++) { const r = ROADS.filter(r => r.type !== 'track')[i % 2], horiz = (r.x1 - r.x0) > (r.z1 - r.z0); const t = R(), sd = R() < 0.5;
      const x = horiz ? r.x0 + t * (r.x1 - r.x0) : (sd ? r.x0 + 1.2 : r.x1 - 1.2), z = horiz ? (sd ? r.z0 + 1.2 : r.z1 - 1.2) : r.z0 + t * (r.z1 - r.z0);
      if (Math.abs(x) > BOUNDS - 10 || Math.abs(z) > BOUNDS - 10 || Math.abs(z) > 590 || this.terrain.cutSDF(x, z) < 6 || this.teethNear(x, z, 6) || this.inForest(x, z, 3)) continue;
      one(T.car, x + (horiz ? 0 : (sd ? -3 : 3) * R()), z + (horiz ? (sd ? -3 : 3) * R() : 0), (horiz ? Math.PI / 2 : 0) + (R() - .5) * 0.9); }
    if (T.bus) one(T.bus, -60, 63.6, Math.PI / 2 + 0.12);
    for (let i = 0; i < 55; i++) { const x = (R() - .5) * (MAP_SIZE - 80), z = (R() - .5) * (MAP_SIZE - 220), ci = this.nav.idx(x, z); if (ci >= 0 && this.nav.cost[ci] === 1 && !onRoad(x, z, 2) && T.tyre && this.terrain.cutSDF(x, z) > 4 && !this.inForest(x, z)) one(T.tyre, x, z, R() * 6, 0); }
  }
  // ---------------------------------------------------------------- field fortifications facing north
  defences() {
    const R = this.rng;
    // (trenches, dugouts, MG nests, the AT ditch and dragon's teeth are cut into the ground by fortifications())
    // sandbag nests at the objectives, hedgehog chicanes on the roads, vehicle berms in the staging grounds
    for (const [x, z, r] of [[-175, 70.5, 0], [-160, 70.5, 0], [-120, 56, Math.PI], [255, 52, 0], [270, 52, 0], [210, 75, Math.PI / 2], [118, 395, 0], [96, 410, Math.PI / 2]]) this.putSandbag(x, z, r);
    for (const [x0, z0, x1, z1] of [[-336, 56, -336, 71], [96, 40, 111, 40], [96, -60, 111, -60], [93, 414, 99, 414], [108, 386, 114, 386], [96, -318, 111, -318], [-366, -318, -353, -318], [353, -318, 366, -318]]) for (let f = 0; f <= 1.001; f += 0.25) this.putProp('hedgehog', x0 + (x1 - x0) * f, z0 + (z1 - z0) * f, R() * 3, BLOCK);
    for (let i = 0; i < 9; i++) this.put('berm_earth', -520 + i * 125 + R() * 30, -590 + R() * 10, (R() - .5) * 0.3, { cost: 6, low: true });
    for (let i = 0; i < 9; i++) this.put('berm_earth', -520 + i * 125 + R() * 30, 596 + R() * 10, Math.PI + (R() - .5) * 0.3, { cost: 6, low: true });
    // concertina belts in front of the trenches
    const C = this.wireT?.concertina?.[0];
    if (C) { const bb = new THREE.Box3().setFromObject(C), len = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z), alongX = (bb.max.x - bb.min.x) >= (bb.max.z - bb.min.z), m = [];
      const belt = (x0, z0, x1, z1) => { const d = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(d / len), ang = Math.atan2(x1 - x0, z1 - z0) + (alongX ? -Math.PI / 2 : 0); for (let i = 0; i < n; i++) { if (R() < 0.15) continue; const f = (i + 0.5) / n, x = x0 + (x1 - x0) * f, z = z0 + (z1 - z0) * f; m.push(trs(x, 0, z, ang)); this.nav.circle(x, z, 0.9, 5); } };
      /* no concertina wire */ }
  }
  putProp(type, x, z, ry, cost) { const list = this.propT?.[type]; if (!list) return; if (this.terrain.cutSDF(x, z) < 1.5) return; const t = list[0]; (this.place['pp_' + type] ||= { t, m: [], opts: {} }).m.push(trs(x, this.tplBaseY(t, x, z, ry), z, ry)); const bb = t.userData.bb ||= new THREE.Box3().setFromObject(t); this.nav.rect(x, z, (bb.max.x - bb.min.x) / 2, (bb.max.z - bb.min.z) / 2, ry, cost, 0.1); }
  putSandbag(x, z, r) { this.putProp('sandbag', x, z, r, 7); const i = this.nav.idx(x, z); if (i >= 0) this.nav.low[i] = 1; }
  // ---------------------------------------------------------------- war dressing
  // Knocked-out armour from earlier assaults (static, charred wrecks built from the vehicles' own *_wreck nodes), the
  // churned trails / worn shortcuts and two mine-cleared lanes (ribbons with ruts; trails also become dirt-track cells
  // for vehicle routing), marker stakes and the anti-tank mines the plough threw aside.
  warDressing() {
    const R = this.rng, H = (x, z) => this.terrain.heightAt(x, z);
    // ---- ribbons (one merged mesh, track material)
    this.trailM = new Uint8Array(this.CN * this.CN);
    const pos = [], uv = [], idx = [], samples = this.trailSamples = [];
    const ribbon = (T, lane) => {
      const curve = new THREE.CatmullRomCurve3(T.pts.map(p => new THREE.Vector3(p[0], 0, p[1])), false, 'centripetal');
      const L = curve.getLength(), n = Math.max(2, Math.ceil(L / 2.5)), pts = [];
      let prev = -1, along = 0, last = null;
      for (let i = 0; i <= n; i++) {
        const p = curve.getPointAt(i / n), t = curve.getTangentAt(i / n), nx = -t.z, nz = t.x;
        if (last) along += p.distanceTo(last); last = p;
        const w = T.w * (1 + 0.14 * Math.sin(along * 0.07 + T.pts[0][0]) + (lane ? 0 : 0.08 * (R() - 0.5)));
        const ok = Math.abs(p.x) < MAP_SIZE / 2 - 2 && Math.abs(p.z) < MAP_SIZE / 2 - 2 && this.terrain.cutSDF(p.x, p.z) > w * 0.5 + 1.4 && !this.terrain.relief(p.x, p.z, false) && !onRoad(p.x, p.z, 1) && !this.overlapsBuilding(p.x, p.z, w / 2, w / 2, 0.5);
        if (!ok) { prev = -1; continue; }
        pts.push([p.x, p.z]);
        const a = pos.length / 3;
        for (const sd of [-1, 1]) { const x = p.x + nx * sd * w / 2, z = p.z + nz * sd * w / 2; pos.push(x, H(x, z) + 0.045, z); uv.push(sd < 0 ? 0 : 1, along / 4.5); }
        if (prev >= 0) idx.push(prev, prev + 1, a, prev + 1, a + 1, a);
        prev = a;
        // vehicles follow the beaten track (dirt-track cells); crops are driven flat
        for (let o = -w / 2; o <= w / 2; o += 0.8) { const x = p.x + nx * o, z = p.z + nz * o, ci = this.nav.idx(x, z); if (ci >= 0 && this.nav.cost[ci] !== BLOCK && !lane) this.nav.road[ci] = Math.max(this.nav.road[ci], 1); const i2 = Math.floor((x + MAP_SIZE / 2) / this.CS), j2 = Math.floor((z + MAP_SIZE / 2) / this.CS); if (i2 >= 0 && j2 >= 0 && i2 < this.CN && j2 < this.CN) this.trailM[j2 * this.CN + i2] = 1; }
      }
      samples.push({ pts, w: T.w, mud: T.mud ?? 0.9, lane });
    };
    for (const T of this.trails) ribbon(T, false);
    for (const T of this.lanes) ribbon(T, true);
    if (idx.length && this.trackMat) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
      const nr = g.attributes.normal; for (let i = 0; i < nr.count; i++) nr.setXYZ(i, 0, 1, 0);
      const tm = this.trackMat.clone(); tm.color.multiplyScalar(0.78); tm.onBeforeCompile = this.trackMat.onBeforeCompile; tm.customProgramCacheKey = this.trackMat.customProgramCacheKey;   // fresh-churned: darker than the old tracks (same program)
      const m = new THREE.Mesh(g, tm); m.receiveShadow = true; m.renderOrder = 1; m.name = 'trails'; this.scene.add(m);
    }
    // ---- mine-cleared lanes: marker stakes with tape both sides, TM-62 mines thrown aside by the plough
    {
      const stakes = [], mines = [], tape = [];
      const stakeG = new THREE.BoxGeometry(0.05, 1.1, 0.05); stakeG.translate(0, 0.55, 0);
      const tapeG = new THREE.PlaneGeometry(0.06, 0.32); tapeG.translate(0.03, 0.85, 0);
      const mineG = new THREE.CylinderGeometry(0.16, 0.16, 0.1, 10); mineG.translate(0, 0.03, 0);
      for (const S of samples) if (S.lane) for (let i = 0; i < S.pts.length; i += 3) {
        const [x, z] = S.pts[i], [x2, z2] = S.pts[Math.min(S.pts.length - 1, i + 1)], a = Math.atan2(x2 - x, z2 - z), nx = Math.cos(a), nz = -Math.sin(a);
        for (const sd of [-1, 1]) {
          const sx = x + nx * sd * (S.w / 2 + 0.6), sz = z + nz * sd * (S.w / 2 + 0.6);
          if (i % 6 === 0) { const M = trs(sx, H(sx, sz), sz, R() * 6, 1, (R() - .5) * 0.25, (R() - .5) * 0.25); stakes.push(M); tape.push(M); }
          if (R() < 0.55) { const o = S.w / 2 + 1.4 + R() * 2.5, mx = x + nx * sd * o + (R() - .5) * 2, mz = z + nz * sd * o + (R() - .5) * 2; if (this.terrain.cutSDF(mx, mz) > 1) mines.push(trs(mx, H(mx, mz), mz, R() * 6, 1, (R() - .5) * 0.5, (R() - .5) * 0.5)); }
        }
      }
      const merge = (geo, list, mat, name) => { if (!list.length) return; const g = mergeGeometries(list.map(M => geo.clone().applyMatrix4(M))); const m = new THREE.Mesh(g, mat); m.castShadow = m.receiveShadow = true; m.name = name; this.scene.add(m); };
      merge(stakeG, stakes, new THREE.MeshStandardMaterial({ color: 0x5a4a38, roughness: 0.95 }), 'lane_stakes');
      merge(tapeG, tape, new THREE.MeshStandardMaterial({ color: 0x9a2a20, roughness: 0.8, side: THREE.DoubleSide }), 'lane_tape');
      merge(mineG, mines, new THREE.MeshStandardMaterial({ color: 0x3c4430, roughness: 0.75, metalness: 0.2 }), 'tm62');
    }
    // ---- knocked-out armour
    const WT = wreckTemplates(this.assets, ['t72b3', 't72av_ua', 'bmp3', 'btr82a', 'btr80_ua', 'bradley_ua']);
    const W = [
      // the failed assaults on D and C, stopped in the minefields in front of the positions
      [150, 474, 0.25, 'bradley_ua', 0], [177, 496, -0.35, 'btr80_ua', 0], [62, 471, 0.4, 't72av_ua', 1],
      [-471, 497, 0.15, 't72av_ua', 1], [-506, 516, -0.55, 'btr80_ua', 0],
      // a column caught on the regional road south of the crossroads
      [96, 262, 0.1, 'btr80_ua', 0], [111, 486, 3.0, 'bradley_ua', 0],
      // the enemy's counter-attacks on A and B, stopped north of the villages
      [-232, -79, 3.0, 'bmp3', 0], [-95, -88, 3.35, 't72b3', 1], [-300, -45, 2.75, 'btr82a', 0],
      [232, -83, 3.25, 'bmp3', 0], [292, -36, 2.9, 'btr82a', 0],
      // in front of the northern line
      [-150, -280, 2.9, 'bradley_ua', 0], [210, -268, 3.4, 't72av_ua', 1],
    ];
    const by = new Map(), add = (key, grp, M) => { (by.get(key) || by.set(key, { grp, m: [] }).get(key)).m.push(M); };
    this.wreckSpots = [];
    for (const [x, z, ry, k, off] of W) {
      const t = WT[k]; if (!t) continue;
      if (this.terrain.cutSDF(x, z) < 7 || onRoad(x, z, 1.8) || this.overlapsBuilding(x, z, 2, 4, 1) || this.solidHit(x, z, 1.8, 3.8, ry, 0.3) || this.teethNear(x, z, 6)) continue;
      const M = this.restM(x, z, ry, 1.6, 3.4, (R() - .5) * 0.06, (R() - .5) * 0.08);
      add(k + '_h', t.hull, M);
      if (t.turret) {
        if (!off) add(k + '_t', t.turret, M.clone().multiply(new THREE.Matrix4().makeRotationY((R() - .5) * 1.2)));
        else {   // turret blown off: lying upside down / on its side a few metres away
          const tc = t.turretC ||= (() => { const b = new THREE.Box3().setFromObject(t.turret), c = b.getCenter(new THREE.Vector3()); const g = new THREE.Group(); const inner = t.turret.clone(); inner.position.set(-c.x, -c.y, -c.z); g.add(inner); g.userData.h = (b.max.y - b.min.y) / 2; return g; })();
          const a = R() * 6.28, d = 4 + R() * 5, tx = x + Math.cos(a) * d, tz = z + Math.sin(a) * d, flip = R() < 0.5;
          if (this.terrain.cutSDF(tx, tz) > 3 && !onRoad(tx, tz, 1)) { add(k + '_to', tc, this.restOn(tc, tx, tz, R() * 6, flip ? Math.PI : (R() - .5) * 0.5, flip ? 0 : 1.2 + R() * 0.4, 0.08)); this.nav.circle(tx, tz, 1.6, BLOCK); }
        }
      }
      this.nav.rect(x, z, 1.75, 3.7, ry, BLOCK, 0.2); this.solidAdd(x, z, 1.75, 3.7, ry, 'wreck');
      this.nav.addOccluder(x, z, 1.6, 3.4, ry, 2.2, null);
      this.wreckSpots.push([x, z]);
    }
    for (const [, v] of by) instance(this.scene, v.grp, v.m, { cullDist: 470 });
  }
  // war map (wear.js): scorch / churn / wet / mud painted from the finished layout
  paintFarmWar() {
    const R = this.rng;
    this.groundUniforms.tWar.value = paintWar(this, MAP_SIZE, { N: 1024, craterWet: 0.3, extra: ({ L, P, k, blob, line }) => {
      // scorch: field fires, burnt belts, burnt houses / farm, wrecks, smouldering spots
      // field fires run with the wind (here from the south-east): elongated, ragged, fingers and unburnt islands
      for (const [x, z, r] of this.burns) { const a = -0.9 + (R() - .5) * 0.6, ux = Math.cos(a), uz = Math.sin(a); for (let i = 0; i < 9; i++) { const t = (R() - .5) * 2.2 * r, o = (R() - .5) * r * 0.7; blob(L.r, x + ux * t - uz * o, z + uz * t + ux * o, r * (0.18 + R() * 0.26), 0.7, 0.85); } }
      for (const [a, b, c, d] of this.burntBelts) { line(L.r, [[a, b], [c, d]], 14, 0.45); for (let i = 0; i < 10; i++) { const f = R(); blob(L.r, a + (c - a) * f + (R() - .5) * 8, b + (d - b) * f + (R() - .5) * 8, 6 + R() * 10, 0.55); } }
      for (const [x, z, r] of this.burntSpots || []) { blob(L.r, x, z, r, 0.85); blob(L.a, x, z, r * 0.8, 0.4); }
      for (const [x, z] of this.wreckSpots || []) { blob(L.r, x, z, 4.5 + R() * 2, 0.75); blob(L.g, x, z, 7, 0.4); blob(L.a, x, z, 8, 0.45); }   // (v7: a burnt-out vehicle scorches a few metres, not a 20 m disc)
      for (const [x, z, sc] of MAP.smoulder || []) blob(L.r, x, z, 14 * sc, 0.6);
      // mud: tracks (wheel-churned, worst at the junctions and the field entrances), trails, lanes, yards
      const tracks = ROADS.filter(r => r.type === 'track'), paved = ROADS.filter(r => r.type !== 'track');
      for (const r of tracks) {
        const horiz = (r.x1 - r.x0) > (r.z1 - r.z0), cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, len = horiz ? r.x1 - r.x0 : r.z1 - r.z0;
        line(L.a, horiz ? [[r.x0, cz], [r.x1, cz]] : [[cx, r.z0], [cx, r.z1]], 5.5, 0.28);
        for (let i = 0; i < len / 26; i++) { const t = R(); const x = horiz ? r.x0 + t * len : cx, z = horiz ? cz : r.z0 + t * len; blob(L.a, x, z, 3 + R() * 6, 0.45 + R() * 0.35); if (R() < 0.35) blob(L.b, x, z, 1.5 + R() * 3, 0.85, 0.6); }
        // field entrances: a short churned apron off the track at the field gateway (5-9 m: a gateway, not a stub of a
        // track running into the crop and stopping)
        for (let i = 0; i < len / 140; i++) { const t = R(), sd = R() < 0.5 ? -1 : 1, x = horiz ? r.x0 + t * len : cx, z = horiz ? cz : r.z0 + t * len, L2 = 5 + R() * 4; line(L.a, [[x, z], [x + (horiz ? (R() - .5) * 3 : sd * L2), z + (horiz ? sd * L2 : (R() - .5) * 3)]], 6, 0.6); }
      }
      for (const a of ROADS) for (const b of ROADS) if (a !== b && a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1) { const x = (Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2, z = (Math.max(a.z0, b.z0) + Math.min(a.z1, b.z1)) / 2; if (Math.abs(x) > MAP_SIZE / 2 || Math.abs(z) > MAP_SIZE / 2) continue; blob(L.a, x, z, 9 + R() * 6, 0.85); blob(L.b, x + (R() - .5) * 6, z + (R() - .5) * 6, 3 + R() * 3, 0.8, 0.5); }
      for (const r of paved) { const horiz = (r.x1 - r.x0) > (r.z1 - r.z0); for (let i = 0; i < 18; i++) { const t = R(); const x = horiz ? r.x0 + t * (r.x1 - r.x0) : (R() < 0.5 ? r.x0 - 1.5 : r.x1 + 1.5), z = horiz ? (R() < 0.5 ? r.z0 - 1.5 : r.z1 + 1.5) : r.z0 + t * (r.z1 - r.z0); blob(L.b, x, z, 1.5 + R() * 2.5, 0.8, 0.6); } }
      for (const S of this.trailSamples || []) { if (S.pts.length < 2) continue; line(L.a, S.pts, S.w + 3, S.lane ? 0.85 : S.mud * 0.75); line(L.g, S.pts, S.w + (S.lane ? 6 : 2), S.lane ? 0.65 : 0.18); for (let i = 0; i < S.pts.length; i += 6) if (R() < 0.4) blob(L.b, S.pts[i][0], S.pts[i][1], 1.5 + R() * 2.5, 0.85, 0.6); }
      for (const y of this.yardRects || []) { L.a.globalAlpha = 0.4; L.a.fillRect(...P(y[0], y[1]), (y[2] - y[0]) * k, (y[3] - y[1]) * k); }
      // staging grounds: vehicle parks churned to mud behind the berms
      for (const zz of [-600, 604]) for (let i = 0; i < 45; i++) { const x = (R() - .5) * (MAP_SIZE - 80), z = zz + (R() - .5) * 26; blob(L.a, x, z, 4 + R() * 7, 0.35); blob(L.a, x + (R() - .5) * 14, z + (R() - .5) * 6, 3 + R() * 4, 0.3); }
      // churn: no-man's land bands (old, overlapping shelling)
      for (let i = 0; i < 90; i++) blob(L.g, (R() - .5) * (MAP_SIZE - 40), -300 + (R() - 0.35) * 150, 12 + R() * 20, 0.16);
      for (let i = 0; i < 60; i++) blob(L.g, -560 + R() * 820, 470 + (R() - .5) * 100, 12 + R() * 18, 0.16);
      // wet: low spots in the fields, wet field corners under the belts
      for (let i = 0; i < 60; i++) blob(L.b, (R() - .5) * (MAP_SIZE - 40), (R() - .5) * (MAP_SIZE - 40), 2 + R() * 5, 0.45 + R() * 0.35, 0.7);
    } });
  }
  // ---------------------------------------------------------------- craters (pre-rolled in layoutFields)
  craters() {
    this.craterList = this.craterList.filter(([x, z, s]) => this.terrain.cutSDF(x, z) > s + 3 && !this.terrain.relief(x, z, false) && !this.teethNear(x, z, s + 2) && !this.inFarmstead(x, z) && !this.overlapsBuilding(x, z, s, s, 0.5) && !this.solidHit(x, z, s * 0.4, s * 0.4, 0, 0));
    this.craterCap = 3800; this.craterMesh = craterMesh(this.scene, this.assets.tex.crater, craterTex(), this.craterCap);
    for (const c of this.pendingCraters || []) this.addCrater(...c); this.pendingCraters = null;
    const T = this.propT?.crater, big = [];
    let nBig = 0;
    for (let [x, z, s] of this.craterList) {
      const rd = onRoad(x, z, 1); if (rd) s = Math.min(s, 2.4);   // on the asphalt: shallow scars only
      this.addCrater(x, z, s * 2.1, rd ? 2 : null);
      if (s > 4.5 && T && nBig++ < 170) { { const ry = this.rng() * 6; big.push(trs(x, this.tplBaseY(T[0], x, z, ry, s / 4.5), z, ry, s / 4.5)); } this.nav.circle(x, z, s * 0.8, 3, true); }
      else if (s > 2.5) this.nav.circle(x, z, s * 0.5, 2, true);
    }
    if (T && big.length) instance(this.scene, T[0], big, { cullDist: 750 });
  }
  // distant tree belts and village roofs on the horizon instead of a city skyline
  skyline() {
    const m = new THREE.MeshStandardMaterial({ color: 0x4a5236, roughness: 1 }), geo = new THREE.IcosahedronGeometry(1, 1); geo.translate(0, 0.6, 0);
    const mats = [];
    for (let i = 0; i < 420; i++) {
      const a = this.rng() * Math.PI * 2, r = MAP_SIZE * 0.62 + this.rng() * 420;
      const belt = Math.floor(a / 0.05), L = 6 + this.rng() * 5;
      mats.push(new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng() * 3), new THREE.Vector3(L, 6 + this.rng() * 7, L)));
    }
    const im = new THREE.InstancedMesh(geo, m, mats.length); mats.forEach((M, i) => im.setMatrixAt(i, M)); im.castShadow = false; this.scene.add(im);
  }
  minimapBase(x, k, o) {
    const cols = ['#4a3f31', '#6b6141', '#4b5034', '#574a33', '#5d5739'];
    for (const f of this.fields) { x.fillStyle = cols[f.type]; x.fillRect((f.x0 + o) * k, (f.z0 + o) * k, (f.x1 - f.x0) * k, (f.z1 - f.z0) * k); }
    x.fillStyle = '#5e5643'; for (const g of this.gardenRects || []) x.fillRect((g[0] + o) * k, (g[1] + o) * k, (g[2] - g[0]) * k, (g[3] - g[1]) * k);
    if (this.forestMask) { x.fillStyle = '#2b3a20'; const MN = this.forestMN; for (let j = 0; j < MN; j++) for (let i = 0; i < MN; i++) if (this.forestMask[j * MN + i] === 1) x.fillRect(i * 4 * k, j * 4 * k, Math.max(1, 4 * k + 0.5), Math.max(1, 4 * k + 0.5)); }
  }
  minimapOver(x, k, o) {
    x.strokeStyle = '#2d3f22'; x.lineWidth = Math.max(2, 10 * k); for (const [a, b, c, d] of MAP.treelines) { x.beginPath(); x.moveTo((a + o) * k, (b + o) * k); x.lineTo((c + o) * k, (d + o) * k); x.stroke(); }
    x.fillStyle = '#a89f8c'; for (const [hx, hz, d] of this.houseSpots || []) x.fillRect((hx + o) * k - 1.5, (hz + o) * k - 1.5, 3, 3);
    x.fillStyle = '#2a2219'; for (const q of this.terrain.cuts) { x.beginPath(); q.pts.forEach((p, i) => i ? x.lineTo((p[0] + o) * k, (p[1] + o) * k) : x.moveTo((p[0] + o) * k, (p[1] + o) * k)); x.closePath(); x.fill(); }
    x.strokeStyle = '#3a3128'; x.lineWidth = Math.max(1, 3 * k); for (const r of this.terrain.reliefs) if (r.type === 'ditch') { x.beginPath(); r.pts.forEach((p, i) => i ? x.lineTo((p[0] + o) * k, (p[1] + o) * k) : x.moveTo((p[0] + o) * k, (p[1] + o) * k)); x.stroke(); }
    const f = MAP.farm; x.fillStyle = '#9a9384'; x.fillRect((f.x - 30 + o) * k, (f.z - 33 + o) * k, 60 * k, 12 * k); x.fillRect((f.x - 30 + o) * k, (f.z + 22 + o) * k, 60 * k, 12 * k);
  }
}

// Wheel ruts / tramlines across a field (ground paint): from a point just off a road / track edge, straight (slightly
// bowed) across the field to the next road / track / trail, or off the map edge -- a tractor's way between two tracks,
// never a line that starts or stops in the open.  start() -> [x, z, heading (x = cos, z = sin), road] or null;
// hit(x, z, road) -> on another road / track / trail; bad(x, z) -> blocked (buildings, belts, forest, trenches, yards).
// Returns up to n polylines [[x, z], ...]; R = seeded rng.
export function fieldRuts(R, n, start, hit, bad, half, { min = 45, max = 460, step = 2 } = {}) {
  const out = [];
  for (let tries = 0; out.length < n && tries < n * 40; tries++) {
    const s = start(); if (!s) continue;
    const [x0, z0, a, road] = s, ux = Math.cos(a), uz = Math.sin(a); let L = 0;
    if (bad(x0 + ux * 3, z0 + uz * 3)) continue;
    for (let t = step; t <= max; t += step) {
      const x = x0 + ux * t, z = z0 + uz * t;
      if (Math.abs(x) > half + 4 || Math.abs(z) > half + 4) { L = t; break; }    // runs off the map
      if (t > 4 && hit(x, z, road)) { L = t + 1.5; break; }                       // reached the next road / track
      if (bad(x, z)) break;
    }
    if (L < min) continue;
    // gentle bow (zero at both ends) + small wander, so it reads as driven, not ruled
    const bow = (R() - 0.5) * Math.min(14, L * 0.05), w1 = (R() - 0.5) * 2.5, nseg = Math.max(2, Math.ceil(L / 12)), pts = [];
    let ok = true;
    for (let i = 0; i <= nseg; i++) {
      const f = i / nseg, o = Math.sin(Math.PI * f) * bow + Math.sin(Math.PI * 3 * f) * w1, x = x0 + ux * L * f - uz * o, z = z0 + uz * L * f + ux * o;
      if (i > 0 && i < nseg && f * L > 6 && (1 - f) * L > 6 && bad(x, z)) { ok = false; break; }
      pts.push([x, z]);
    }
    if (ok && !out.some(q => Math.hypot(q[0][0] - x0, q[0][1] - z0) < 40)) out.push(pts);
  }
  return out;
}
function craterTex() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  for (let i = 0; i < 1100; i++) { const a = Math.random() * 6.28, r = 40 + Math.pow(Math.random(), 0.7) * 86; const v = 30 + Math.random() * 50; x.fillStyle = `rgba(${v + 12},${v + 6},${v},${0.18 + Math.random() * 0.45})`; x.beginPath(); x.arc(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, 0.7 + Math.random() * 3, 0, 7); x.fill(); }
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 72);
  g.addColorStop(0, 'rgba(18,15,12,0.9)'); g.addColorStop(0.45, 'rgba(34,28,22,0.8)'); g.addColorStop(0.8, 'rgba(60,50,40,0.4)'); g.addColorStop(1, 'rgba(60,50,40,0)');
  x.fillStyle = g; x.beginPath(); for (let i = 0; i <= 40; i++) { const a = i / 40 * 6.28, r = 60 + (Math.random() - .5) * 20; i ? x.lineTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r) : x.moveTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r); } x.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------------------------------------------------------------- procedural stand-ins (used until farmland.glb exists)
const _fbm = {};
function M(color, extra = {}) { return (_fbm[color] ||= new THREE.MeshStandardMaterial({ color, roughness: 0.95, ...extra })); }
function grp(...meshes) { const g = new THREE.Group(); for (const m of meshes) { m.castShadow = m.receiveShadow = true; g.add(m); } return g; }
function box(w, h, d, c, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M(c)); m.position.set(x, y + h / 2, z); return m; }
function cyl(r0, r1, h, c, x = 0, y = 0, z = 0, seg = 8) { const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, seg), M(c)); m.position.set(x, y + h / 2, z); return m; }
function blob(r, c, x, y, z, sy = 1) { const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), M(c, { flatShading: true })); m.position.set(x, y, z); m.scale.y = sy; return m; }
function fallbackTpl(name) {
  if (!name) return null;
  const n = name.replace(/_lod1$/, '');
  const leaf = 0x56603a, bark = 0x4b4239;
  if (/poplar/.test(n)) return grp(cyl(0.15, 0.3, 6, bark), blob(2.2, leaf, 0, 11, 0, 4));
  if (/shelled/.test(n)) return grp(cyl(0.12, 0.28, 7, bark), blob(1.8, 0x5f6040, 1, 7, 0, 0.8));
  if (/^tree_|leafy/.test(n)) return grp(cyl(0.14, 0.3, 4, bark), blob(3.3, leaf, 0, 6.5, 0, 0.85), blob(2.2, 0x5e683f, 1.6, 5.5, 0.8));
  if (/^bush/.test(n)) return grp(blob(1.3, 0x5a6038, 0, 0.9, 0, 0.8));
  if (/sunflower/.test(n)) return grp(...[0, 1, 2, 3, 4].map(i => { const m = cyl(0.02, 0.025, 1.6, 0x4a3b28, Math.cos(i * 1.3) * 0.35, 0, Math.sin(i * 1.3) * 0.35, 4); return m; }), ...[0, 1, 2, 3, 4].map(i => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.04, 7), M(0x2e241a)); m.position.set(Math.cos(i * 1.3) * 0.35, 1.55, Math.sin(i * 1.3) * 0.35 + 0.08); m.rotation.x = 1.2; return m; }));
  if (/corn/.test(n)) return grp(...[0, 1, 2, 3].map(i => cyl(0.02, 0.03, 2.0, 0x8c7a52, Math.cos(i * 1.6) * 0.3, 0, Math.sin(i * 1.6) * 0.3, 4)));
  if (/weeds/.test(n)) return grp(blob(0.5, 0x6d6a45, 0, 0.35, 0, 1.2));
  if (/haybale/.test(n)) { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 1.2, 12), M(/burnt/.test(n) ? 0x2b2620 : 0xa88f5a)); m.rotation.z = Math.PI / 2; m.position.y = 0.75; return grp(m); }
  if (/haystack/.test(n)) { const m = new THREE.Mesh(new THREE.ConeGeometry(2.4, 4.5, 10), M(0x9a8455)); m.position.y = 2.25; return grp(m); }
  if (/barn_kolkhoz/.test(n)) { const g = grp(box(60, 4.2, 12, 0xbdb7a6)); const sh = new THREE.Shape(); sh.moveTo(-6.6, 0); sh.lineTo(6.6, 0); sh.lineTo(0, 2.6); sh.closePath(); const rg = new THREE.ExtrudeGeometry(sh, { depth: 61, bevelEnabled: false }); rg.rotateY(Math.PI / 2); rg.translate(-30.5, 4.2, 0); const r = new THREE.Mesh(rg, M(/damaged/.test(n) ? 0x4e4c47 : 0x8b8d86)); r.castShadow = true; g.add(r); return g; }
  if (/machine_shed/.test(n)) { const g = grp(box(30, 0.3, 15, 0x6d6e68, 0, 6)); for (let i = 0; i < 6; i++) for (const s of [-1, 1]) g.add(box(0.3, 6, 0.3, 0x55554f, -15 + i * 6, 0, s * 7.2)); return g; }
  if (/grain_silo/.test(n)) return grp(cyl(3, 3, 18, 0xa7a49b, -4), cyl(3, 3, 18, 0xa7a49b, 3), box(2, 3, 2, 0x77756e, 0, 17));
  if (/water_tower/.test(n)) return grp(cyl(1.0, 1.0, 14, 0x6b5a4a), cyl(2.6, 2.6, 4, 0x6e5a49, 0, 14));
  if (/tractor|combine/.test(n)) return grp(box(1.9, 1.6, 3.8, /burnt/.test(n) ? 0x2c2622 : 0x3c5a8a, 0, 0.5), box(1.3, 1.2, 1.3, 0x333333, 0, 2.1, -0.6));
  if (/trailer/.test(n)) return grp(box(2.3, 1.1, 5, 0x6a5a40, 0, 0.6));
  if (/well/.test(n)) return grp(box(1.2, 0.9, 1.2, 0x7d6e58), box(1.6, 0.1, 1.6, 0x4c4440, 0, 2));
  if (/shed_wood/.test(n)) return grp(box(4, 2.4, 3, 0x6e5e48), box(4.4, 0.2, 3.4, 0x6f716b, 0, 2.4));
  if (/outhouse/.test(n)) return grp(box(1.1, 2.1, 1.1, 0x6e5e48));
  if (/woodpile/.test(n)) return grp(box(2.5, 1.1, 0.9, 0x7a6248));
  if (/greenhouse/.test(n)) return grp(box(3, 2, 6, 0xb8c0b6));
  if (/fence|gate/.test(n)) return grp(box(3, 1.3, 0.07, /gate/.test(n) ? 0x4f6a5a : 0x6e5e48));
  if (/bus_stop/.test(n)) return grp(box(3.5, 2.6, 0.25, 0xb2ada3, 0, 0, -0.8), box(3.6, 0.2, 1.8, 0x9a958c, 0, 2.6));
  if (/cross/.test(n)) return grp(box(0.15, 2.6, 0.15, 0x5e4a36), box(1.0, 0.12, 0.12, 0x5e4a36, 0, 1.9));
  if (/berm/.test(n)) return grp(box(8, 1.0, 2.2, 0x5a4a38));
  if (/trench/.test(n)) return grp(box(6, 0.55, 0.8, 0x5a4a38, 0, 0, -1.1), box(6, 0.5, 0.7, 0x5a4a38, 0, 0, 1.1), box(6, 0.02, 1.4, 0x2a231b));
  if (/dugout/.test(n)) return grp(box(2.4, 0.8, 2.6, 0x4f4233));
  return null;
}

function blackTex() { const t = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat); t.needsUpdate = true; return t; }
