import * as THREE from 'three';
import { NavGrid, BLOCK } from './nav.js';
import { Building, KitPool, setKitCell, makeKitPool } from './buildings.js';
import { instance, instanceRuns, trs, LODS, farLod, treeLod } from './instancer.js';
import { Terrain } from './terrain.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { MAPS } from './maps.js';
import { markStatic } from '../engine/renderer.js';
import { battlefieldDetail } from './battlefieldDetail.js';
import { WAR_GROUND_DECL, warGroundGLSL, warGroundHooks, paintWar, warAt, roadFrame, roadWear, weatherEnv, craterMesh, wreckTemplates, blackTex as warBlack } from './wear.js';
import { groundMaterial } from './ground.js';
import { roadSurfaces, ROAD_Y } from './roadmesh.js';
import { planStreets, buildStreetFurniture } from './streetFurniture.js';

// Active map: live bindings, set by setMap() before the world is built.
export let MAP, MAP_SIZE, BOUNDS, ROADS, OBJECTIVES, DEPLOY_ZONES, SPAWNS;
let BUILDINGS, E;
// Real-place maps (maps.js `real`, src/world/real.js) register their world classes here; City / Farmland construction
// is redirected to them (game.js picks City or Farmland by MAP.kind).  ROAD_TEST: their polyline road network replaces
// the axis-aligned ROADS rectangles in onRoad().
export const REAL_WORLDS = {};
let ROAD_TEST = null;
export function setRoadTest(f) { ROAD_TEST = f; }
export function setMap(id) {
  ROAD_TEST = null;
  MAP = MAPS[id] || MAPS.city;
  setKitCell(MAP.real ? 180 : 90);
  MAP_SIZE = MAP.sizeM; BOUNDS = MAP.bounds; ROADS = MAP.roads; OBJECTIVES = MAP.objectives;
  DEPLOY_ZONES = JSON.parse(JSON.stringify(MAP.deployZones)); SPAWNS = MAP.spawns; BUILDINGS = MAP.buildings; E = MAP_SIZE / 2 + 2;
  return MAP;
}
setMap('city');
const SIDEWALK = 3.2;
const ROOFED = /^(house|shed|garage|kiosk|pavilion|barn|church|machine|grain|water_tower|boiler|kindergarten|supermarket|pharmacy|sub|outhouse|greenhouse|bus_stop)/;
const FOOT = []; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) if (i || j) FOOT.push([i / 2, j / 2]);   // 5 x 5 grid over the footprint

export function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export const onRoad = (x, z, pad = 0) => ROAD_TEST ? ROAD_TEST(x, z, pad) : ROADS.some(r => x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad);

// a footprint (centre, half extents, yaw) on a road or its pavement (generic maps: per road type; real maps: their road test
// with a pavement's pad) - sampled every <= 0.5 m over the whole rectangle, edges included
export function footOnRoad(x, z, hx, hz, ry = 0) {
  const c = Math.cos(ry), s = Math.sin(ry), nu = Math.max(2, Math.ceil(hx / 0.5)), nv = Math.max(2, Math.ceil(hz / 0.5));
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
    const lx = (i / nu * 2 - 1) * hx, lz = (j / nv * 2 - 1) * hz, px = x + lx * c + lz * s, pz = z - lx * s + lz * c;
    if (ROAD_TEST ? ROAD_TEST(px, pz, 1.5) : ROADS.some(r => { const sw = r.type === 'drive' ? 1.3 : SIDEWALK; return px > r.x0 - sw && px < r.x1 + sw && pz > r.z0 - sw && pz < r.z1 + sw; })) return true;
  }
  return false;
}

export class City {
  constructor(scene, assets, quality) {
    const Real = MAP.real && !new.target.isReal && REAL_WORLDS[MAP.kind];
    if (Real) return new Real(scene, assets, quality);
    this.scene = scene; this.assets = assets; this.quality = quality;
    this.rng = mulberry(7031);
    this.nav = new NavGrid(MAP_SIZE, 1);
    this.terrain = new Terrain(MAP_SIZE, this.nav, () => this.rng()); this.nav.terrain = this.terrain;
    this.buildings = []; this.dynamic = new THREE.Group(); scene.add(this.dynamic);
    this.burning = []; this.wrecks = [];
    this.groundHeight = this.groundHeight.bind(this);
  }
  // ================================================================ placement footprints (anti-clipping)
  // Every solid prop / tree trunk registers an oriented box; later placements are refused if they would intersect one.
  solidAdd(x, z, hx, hz, ry = 0, kind = '') {
    const o = { x, z, hx, hz, c: Math.cos(ry), s: Math.sin(ry), kind }, g = this._solids ||= new Map(), r = Math.hypot(hx, hz);
    for (let i = Math.floor((x - r) / 8); i <= Math.floor((x + r) / 8); i++) for (let j = Math.floor((z - r) / 8); j <= Math.floor((z + r) / 8); j++) { const k = i * 4096 + j; (g.get(k) || g.set(k, []).get(k)).push(o); }
    return o;
  }
  solidHit(x, z, hx, hz, ry = 0, pad = 0.1, ignore = null) {
    const g = this._solids; if (!g) return false;
    const c2 = Math.cos(ry), s2 = Math.sin(ry), r = Math.hypot(hx, hz) + pad;
    for (let i = Math.floor((x - r) / 8); i <= Math.floor((x + r) / 8); i++) for (let j = Math.floor((z - r) / 8); j <= Math.floor((z + r) / 8); j++) for (const b of g.get(i * 4096 + j) || []) {
      if (ignore && ignore(b.kind)) continue;
      const dx = x - b.x, dz = z - b.z; let sep = false;
      for (const [ax, az] of [[b.c, -b.s], [b.s, b.c], [c2, -s2], [s2, c2]]) {
        const d = Math.abs(dx * ax + dz * az), ra = b.hx * Math.abs(b.c * ax - b.s * az) + b.hz * Math.abs(b.s * ax + b.c * az), rb = hx * Math.abs(c2 * ax - s2 * az) + hz * Math.abs(s2 * ax + c2 * az);
        if (d > ra + rb + pad) { sep = true; break; }
      }
      if (!sep) return true;
    }
    return false;
  }
  // Base height for an object standing on the ground (instanced props, houses, trees): the LOWEST ground under its
  // footprint (centre, corners, edge midpoints of the oriented hx x hz box), so no edge or corner hangs in the air on a
  // crater rim, a trench parapet or a balka slope -- the uphill side sinks in instead.  hx = hz = 0: centre only.
  baseY(x, z, hx = 0, hz = 0, ry = 0) {
    const T = this.terrain; let y = T.heightAt(x, z); if (!(hx > 0 || hz > 0)) return y;
    const c = Math.cos(ry), s = Math.sin(ry);
    // big footprints (combines, wrecks, large crater meshes): sample at <= ~1.6 m, not just 5 x 5 (a hollow between two
    // samples left an edge 15-25 cm in the air)
    const nx = Math.min(10, Math.max(2, Math.ceil(hx / 0.8))), nz = Math.min(10, Math.max(2, Math.ceil(hz / 0.8)));
    if (nx === 2 && nz === 2) for (const [u, w] of FOOT) { const lx = u * hx, lz = w * hz; y = Math.min(y, T.heightAt(x + lx * c + lz * s, z - lx * s + lz * c)); }
    else for (let i = -nx; i <= nx; i++) for (let j = -nz; j <= nz; j++) { const lx = i / nx * hx, lz = j / nz * hz; y = Math.min(y, T.heightAt(x + lx * c + lz * s, z - lx * s + lz * c)); }
    return y;
  }
  // an object lying at (x, z) in any attitude (ry, rx, rz): lowered / raised so the lowest corner of its box rests on
  // the lowest ground under the box (sunk by `sink`), e.g. a turret blown off and lying on its side
  restOn(obj, x, z, ry, rx = 0, rz = 0, sink = 0.05, sc = 1) {
    // the model's own vertices (object frame, subsampled), not its box: a box corner hangs below a rounded shape
    const P = obj.userData.restPts ||= (() => { obj.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3(), out = [];
      obj.traverse(o => { if (!o.isMesh) return; m.multiplyMatrices(inv, o.matrixWorld); const pos = o.geometry.attributes.position, st = Math.max(1, Math.floor(pos.count / 600)); for (let i = 0; i < pos.count; i += st) { v.fromBufferAttribute(pos, i).applyMatrix4(m); out.push(v.x, v.y, v.z); } }); return out; })();
    const M = trs(x, 0, z, ry, sc, rx, rz), e = M.elements; let lo = 1e9, g = 1e9;
    for (let i = 0; i < P.length; i += 3) { const px = P[i], py = P[i + 1], pz = P[i + 2], wy = e[1] * px + e[5] * py + e[9] * pz; if (wy < lo) lo = wy; }
    for (let i = 0; i < P.length; i += 3) { const px = P[i], py = P[i + 1], pz = P[i + 2], wy = e[1] * px + e[5] * py + e[9] * pz; if (wy < lo + 0.25) g = Math.min(g, this.terrain.heightAt(e[0] * px + e[4] * py + e[8] * pz + x, e[2] * px + e[6] * py + e[10] * pz + z)); }
    e[13] = g - lo - sink; return M;
  }
  // height range of the ground over a disc of radius r (centre + 8 around): crop clumps / low props are not set on
  // spoil berms, crater rims or bank slopes, where any one base height leaves part of them floating or buried
  uneven(x, z, r) {
    const T = this.terrain; let lo = T.heightAt(x, z), hi = lo;
    for (let k = 0; k < 8; k++) { const h = T.heightAt(x + Math.cos(k * 0.785) * r, z + Math.sin(k * 0.785) * r); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    return hi - lo;
  }
  // footprint of a template in its own frame (centre offset + half extents, scaled), for baseY
  footOf(t, s = 1) {
    const f = t.userData.foot ||= (() => { t.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(t).applyMatrix4(new THREE.Matrix4().copy(t.matrixWorld).invert()); return [(b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2, (b.max.x - b.min.x) / 2, (b.max.z - b.min.z) / 2]; })();
    return [f[0] * s, f[1] * s, f[2] * s, f[3] * s];
  }
  // baseY for template t placed at (x, z, ry, scale s)
  tplBaseY(t, x, z, ry = 0, s = 1) {
    const [ox, oz, hx, hz] = this.footOf(t, s), c = Math.cos(ry), sn = Math.sin(ry);
    return this.baseY(x + ox * c + oz * sn, z - ox * sn + oz * c, hx, hz, ry);
  }
  // canopy radius of a tree template at scale s (75 % of its half width): trees keep this far from house boxes / blocks
  // so crowns do not grow through roofs and walls
  crownHit(x, z, cr) { return this.solidHit(x, z, cr, cr, 0, 0, k => !ROOFED.test(k)) || this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + cr && Math.abs(lz) < b.D / 2 + cr; }); }
  canopyR(t, s = 1) { const b = t.userData.bb ||= new THREE.Box3().setFromObject(t); return Math.min(b.max.x - b.min.x, b.max.z - b.min.z) / 2 * 0.75 * s; }
  // a rigid body resting on the ground (wrecks, cars): pitch / roll from the ground under its ends and sides, then
  // lowered until no corner of the hx x hz footprint hangs in the air; jx / jz = extra random tilt
  restM(x, z, ry, hx, hz, jx = 0, jz = 0) {
    const H = (u, w) => this.terrain.heightAt(x + u * Math.cos(ry) + w * Math.sin(ry), z - u * Math.sin(ry) + w * Math.cos(ry));
    const yf = H(0, hz), yb = H(0, -hz), yl = H(hx, 0), yr = H(-hx, 0);
    const rx = -Math.atan2(yf - yb, 2 * hz) + jx, rz = Math.atan2(yl - yr, 2 * hx) + jz;
    let y = (yf + yb + yl + yr) / 4;
    const M = trs(x, y, z, ry, 1, rx, rz), p = new THREE.Vector3(); let gap = 0;
    for (const [u, w] of FOOT) { p.set(u * hx, 0, w * hz).applyMatrix4(M); gap = Math.max(gap, p.y - this.terrain.heightAt(p.x, p.z)); }
    if (gap > 0.02) { y -= gap - 0.02; M.elements[13] = y; }
    return M;
  }
  // ================================================================ ground relief API (for soldier / vehicle Y)
  // Height of the walkable ground (m) at world (x, z): 0 on the flat, negative on trench / ditch floors (-1.1 firing
  // cells, -1.55 communication trenches, -1.7 fire trenches, down to -2.6 in an AT ditch), positive on parapets, dugout
  // roofs and rubble piles (up to ~2.5 m on a big collapse heap). O(1): one sparse-tile lookup + bilinear (0.4 m grid).
  groundHeight(x, z) { return this.terrain.heightAt(x, z); }
  groundNormal(x, z, out) { return this.terrain.normalAt(x, z, out); }
  // null, or { depth, floor, fireY, front:[fx,fz]|null, kind } when (x, z) is inside a trench / firing cell / passage.
  // fireY = feet height for a man firing over the parapet from here (firing step), front = the direction it faces.
  trenchInfo(x, z) {
    const S = this.terrain.cutSDF(x, z), q = this.terrain._q; if (S >= 0 || !q) return null;
    return { depth: q.depth, floor: -q.depth, fireY: -Math.min(q.depth, 1.12), front: q.front, kind: q.kind };
  }
  build() {
    this.lots = (MAP.yards?.lots || []).map(l => [...l]);
    weatherEnv(this.assets);
    this.ground(); this.roads();
    this.placeBuildings(); this.facadeDecals();
    this.fortifications();
    this.rubbleAndDebris();
    this.trees(); this.poles(); this.props(); this.dressing(); this.modernDressing(); this.flushTrees(); this.defences(); this.cityWrecks();
    this.streetFurniture();
    this.craters(); this.paintGround(); battlefieldDetail(this); this.skyline();
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
  // Ground: one large plane with a splat-mapped shader (dry grass, worn paths, rubble/gravel, mud)
  // and anti-tiling (two rotated samples blended by noise + macro tint), painted from the layout.
  ground() {
    const S = this.groundS = MAP_SIZE + 1400, g = new THREE.PlaneGeometry(S, S, 1, 1); g.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(g, this.groundMat(false)); ground.receiveShadow = true; ground.name = 'ground'; this.scene.add(ground);
    // drawn after the other opaque geometry (roads / pavements lie on it with a polygon offset): the depth test then
    // skips its (expensive, splat + war map) shading under buildings, roads, props and vegetation.  ?groundlast=0: off
    try { if (new URLSearchParams(location.search).get('groundlast') !== '0') ground.renderOrder = 1; } catch { /* */ }
    this.groundMesh = ground;
  }
  groundMat(terrain) {   // ground look v6: src/world/ground.js (height-blended, anti-tiled material sets)
    return groundMaterial(this, terrain, false, MAP_SIZE);
  }
  // ================================================================ field fortifications (MAP.fortifications -> terrain.js)
  // MAP.fortifications entries (see maps.js): 'sp' (strongpoint header: id, name, front, kind, revet, craters),
  // 'fire' (fire trench), 'comm' (communication trench), 'fox' (foxholes), 'mg' (machine-gun pit with log roof),
  // 'dug' (dugout), 'ditch' (AT ditch), 'teeth' (dragon's teeth).  Entries carrying the same `sp` form one trench
  // system (strongpoint) for the game; a 'fire' entry without `sp` is a system of its own.
  //
  // Game API:
  //   city.trenchSystems            one entry per strongpoint / line, see trenchSystem()
  //   city.groundHeight(x, z)       walkable height (trench floors, parapets, rubble), city.trenchInfo(x, z)
  //   city.damageFortAt(x, z, power, radius = 0) -> number of dragon's teeth destroyed by this blast.
  //       Call it for every explosion on the ground (combat.explode does).  power = explode()'s power (152 / 155 mm
  //       2.7, mortar / arty 2.2, tank HE 2.0, light mortar 1.3, RPG 0.8, drone 0.65, grenade 0.45); radius = its
  //       lethal radius (only caps the effect).  power >= 1.2: teeth within rD = 1.15 power - 0.1 m (tank HE 2.2 m,
  //       152 mm 3.0 m) are destroyed, out to 1.45 rD damaged / toppled away from the blast (two such hits destroy);
  //       0.6 <= power < 1.2 (RPG, drone, light shells): chips the one nearest tooth within 0.9 m (about three hits
  //       destroy it); weaker blasts and vehicle tracks do nothing.  Destroyed teeth turn into dragon_tooth_rubble
  //       (instanced, swapped in place), their cell becomes slow rubble for infantry and the vehicle block around them
  //       is lifted (nav.removeTooth + a local clearance update), so armour can drive through a breach: one 152 mm
  //       shell on a 3-row belt destroys ~7 teeth and opens a lane for tanks and BTRs; a tank HE round destroys ~4
  //       (usually two are needed for a lane).  Cost: spatial-hash lookup (~0 ms when nothing is in range); the nav
  //       update runs only when something was destroyed (2-3 ms, no full rebuild).  city.fortTeeth = the tooth
  //       records ([x, z] + state 0 intact / 1 damaged / 2 destroyed, hp).
  fortifications() {
    const T = this.terrain, R = this.rng;
    T.roadTest = (x, z, pad) => onRoad(x, z, pad);
    let yard = false;   // entry may dig into village yards / gardens (never into buildings, the farm or the farmstead)
    const bHit = (x, z) => this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + 4 && Math.abs(lz) < b.D / 2 + 4; });
    T.keepOut = (x, z) => bHit(x, z) || (!yard && !!(this.inVillage && this.inVillage(x, z, 1))) || !!(this.inFarm && this.inFarm(x, z, 3)) || !!(this.inFarmstead && this.inFarmstead(x, z, 2));
    // gameplay contract (src/game: trench garrison / clearing): one entry per trench system, see trenchSystem()
    const systems = new Map();
    const sysOf = (key, f) => {
      if (key == null) key = '_' + systems.size;
      let s = systems.get(key);
      if (!s) systems.set(key, s = { id: systems.size, key, name: f.name || null, kind: f.kind || null, front: f.front || [0, -1], revet: null, fires: [], comms: [], foxes: [], mgs: [], dugouts: [], craters: null });
      return s;
    };
    // nearest centre-line point of the system's trenches (inside the cut) to (x, z)
    const nearestTrench = (s, x, z, maxD = 1e9) => {
      let best = null, bd = maxD;
      for (const l of [...s.fires.map(r => r.pts), ...s.comms]) for (const p of l) { const d = Math.hypot(p[0] - x, p[1] - z); if (d < bd && T.cutSDF(p[0], p[1]) < -0.2) { bd = d; best = p; } }
      return best;
    };
    const dugoutFrom = (s, p, bx, bz, w = 0.5) => {
      const L = Math.hypot(bx, bz); bx /= L; bz /= L; const sx = -bz, sz = bx, d0 = w + 0.1, cx = p[0] + bx * (d0 + 3.2 + 2.5), cz = p[1] + bz * (d0 + 3.2 + 2.5);
      const clear = [[-2.4, -2.6], [2.4, -2.6], [-2.4, 2.6], [2.4, 2.6], [0, 0], [0, -1.5]].every(([u, v]) => { const x = cx + sx * u + bx * v, z = cz + sz * u + bz * v; return T.cutSDF(x, z) > 0.4 && !onRoad(x, z, 2) && !T.keepOut(x, z); });
      if (!clear) return false;
      const ch = T.dugout(p[0] + bx * d0, p[1] + bz * d0, bx, bz, { sys: s.key });
      s.dugouts.push({ x: ch[0], z: ch[1], door: [p[0], p[1]], dir: [bx, bz], occupants: new Set() });
      return true;
    };
    for (const f of MAP.fortifications || []) {
      yard = !!f.yard;
      if (f.type === 'sp') { const s = sysOf(f.id, f); s.name = f.name || s.name; s.front = f.front || s.front; s.kind = f.kind || 'strongpoint'; s.revet = f.revet || null; s.craters = f.craters ?? null; s.yard = !!f.yard; s.frontSet = !!f.front; continue; }
      const s = (f.type === 'fire' || f.sp != null) && f.type !== 'ditch' && f.type !== 'teeth' ? sysOf(f.sp, f) : null;
      if (s) yard = yard || !!s.yard;
      const revet = f.revet || s?.revet || 'rough';
      if (f.type === 'fire') {
        const res = T.fireTrench(f.base, { front: f.front || s.front, style: f.style, revet, leg: f.leg, amp: f.amp, jog: f.jog, bays: f.bays, bayGap: f.bayGap, depth: f.depth, width: f.width, sys: s.key });
        s.fires.push(res); if (!s.kind) s.kind = 'line'; if (!s.frontSet) { s.front = f.front || s.front; s.frontSet = true; }
        const fr = res.front, at = t => { // trench point nearest to a fraction along the baseline
          const B = f.base, L = B.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - B[i][0], p[1] - B[i][1]), 0); let d = t * L, i = 0;
          while (i < B.length - 2 && d > Math.hypot(B[i + 1][0] - B[i][0], B[i + 1][1] - B[i][1])) { d -= Math.hypot(B[i + 1][0] - B[i][0], B[i + 1][1] - B[i][1]); i++; }
          const sl = Math.hypot(B[i + 1][0] - B[i][0], B[i + 1][1] - B[i][1]) || 1, x = B[i][0] + (B[i + 1][0] - B[i][0]) * d / sl, z = B[i][1] + (B[i + 1][1] - B[i][1]) * d / sl;
          let best = null, bd = 1e9; for (const p of res.pts) { const dd = Math.hypot(p[0] - x, p[1] - z); if (dd < bd && T.cutSDF(p[0], p[1]) < -0.2) { bd = dd; best = p; } } return best;
        };
        // dugouts hang off the rear-most trench point near the requested spot; the roof must sit clear of every cut
        const rear = t => { const p0 = at(t); if (!p0) return null; let best = null, bv = 1e9; for (const p of res.pts) { if (Math.hypot(p[0] - p0[0], p[1] - p0[1]) > 6 || T.cutSDF(p[0], p[1]) > -0.2) continue; const v = p[0] * fr[0] + p[1] * fr[1]; if (v < bv) { bv = v; best = p; } } return best || p0; };
        for (const t of f.dug || []) { const p = rear(t); if (p) dugoutFrom(s, p, -fr[0] + (R() - 0.5) * 0.3, -fr[1] + (R() - 0.5) * 0.3, res.w); }
        for (const t of f.mg || []) {
          const p = at(t); if (!p) continue; let best = null, bd = 1e9;
          for (const b of res.bays) { const d = Math.hypot(b.tag.x - p[0], b.tag.z - p[1]); if (d < bd && !b.covered) { bd = d; best = b; } }
          if (best && bd < 25) T.mgNest(best);
        }
      } else if (f.type === 'comm') {
        let pts = f.pts.map(p => [p[0], p[1]]);
        if (s && f.link !== false) { const a = nearestTrench(s, pts[0][0], pts[0][1], 7); if (a) pts[0] = [a[0], a[1]]; }
        const res = T.commTrench(pts, { revet: f.revet || (s ? revet : 'rough'), style: f.style, amp: f.amp, sys: s?.key });
        if (s) s.comms.push(res.pts);
      } else if (f.type === 'fox') {
        for (const p of f.pts) {
          let fx = p[2] ?? f.front?.[0] ?? s.front[0], fz = p[3] ?? f.front?.[1] ?? s.front[1]; const L = Math.hypot(fx, fz) || 1; fx /= L; fz /= L;
          const q = T.foxhole(p[0], p[1], fx, fz, { sys: s.key, revet, double: f.double });
          if (q) s.foxes.push(q);
        }
      } else if (f.type === 'mg') {
        let [fx, fz] = f.front || s.front; const L = Math.hypot(fx, fz) || 1; fx /= L; fz /= L;
        const q = T.mgPit(f.at[0], f.at[1], fx, fz, { sys: s.key, revet }); if (!q) continue;
        s.mgs.push(q);
        // crawl trench back to the nearest trench of the strongpoint
        const bx = f.at[0] - fx * 0.9, bz = f.at[1] - fz * 0.9, p = f.link === false ? null : nearestTrench(s, bx, bz, 26);
        if (p && Math.hypot(p[0] - bx, p[1] - bz) > 2.5) { const res = T.commTrench([[bx, bz], [p[0], p[1]]], { revet, width: 0.75, amp: 0.4, jog: 0, sys: s.key }); s.comms.push(res.pts); }
      } else if (f.type === 'dug') {
        const p = nearestTrench(s, f.at[0], f.at[1], 16);
        if (p) { const dx = f.at[0] - p[0], dz = f.at[1] - p[1]; dugoutFrom(s, p, dx || -s.front[0], dz || -s.front[1]); }
        else { const [dx, dz] = f.dir || [-s.front[0], -s.front[1]]; dugoutFrom(s, [f.at[0] - dx * 6, f.at[1] - dz * 6], dx, dz); }
      } else if (f.type === 'ditch') T.antitankDitch(f.pts, { bermSide: f.bermSide });
      else if (f.type === 'teeth') T.dragonTeeth(f.pts, { rows: f.rows });
    }
    yard = false;
    this.trenchSystems = [...systems.values()].map(s => this.trenchSystem(s)).filter(Boolean);
    // shell craters around every position (the ground near a held position is always churned)
    const teethNear = (x, z, r) => (T.teeth || []).some(([tx, tz]) => Math.abs(tx - x) < r && Math.abs(tz - z) < r);
    for (const sy of this.trenchSystems) {
      const n = sy.craters ?? Math.round(3 + sy.radius / 8);
      for (let i = 0, made = 0; i < n * 4 && made < n; i++) {
        const a = R() * Math.PI * 2, d = sy.radius * 0.3 + R() * (sy.radius + 28), x = sy.center[0] + Math.cos(a) * d, z = sy.center[1] + Math.sin(a) * d, r = 0.9 + R() * R() * 3.4;
        if (Math.abs(x) > MAP_SIZE / 2 - 8 || Math.abs(z) > MAP_SIZE / 2 - 8 || T.cutSDF(x, z) < r * 1.9 + 1.2 || onRoad(x, z, r * 1.9 + 1) || T.keepOut(x, z) || teethNear(x, z, r * 2 + 1)) continue;
        if (T.relief(x, z, false)) continue;
        T.crater(x, z, r); made++;
      }
    }
    const wall = this.wallMat();
    // dressing footprints (template frame, from fortifications.glb) so pieces land fully on the lip / floor
    { const fg = this.assets.gltf.fortifications, bx = {}; T.dressBox = n => { if (n in bx) return bx[n]; const t = fg?.scene.getObjectByName(n); if (!t) return (bx[n] = null); t.updateMatrixWorld(true); const b = new THREE.Box3().setFromObject(t).applyMatrix4(new THREE.Matrix4().copy(t.matrixWorld).invert()); return (bx[n] = [b.min.x, b.max.x, b.min.z, b.max.z]); }; }
    T.finalize({ scene: this.scene, matTop: this.trenchTopMat(), matWall: wall, groundS: this.groundS });
    this.groundUniforms.tHole.value = T.mask;
    // dressing pieces (fortifications.glb, procedural stand-ins otherwise)
    const g = this.assets.gltf.fortifications, cull = { rv_pallet: 260, rv_sheet: 260, rv_ply: 260, rv_door: 260, rv_branches: 260, rv_logs: 260, rv_mesh: 300, floor_pallet: 170, floor_planks: 170, litter_a: 140, litter_b: 140, ammo_crates: 170, sandbag_row: 380, sandbag_pile: 380, debris_conc: 300, net_cover: 520, branch_cover: 480, tarp_cover: 480, net_drone: 420, dragon_tooth: 1100, dragon_tooth_b: 1100, dragon_tooth_rubble: 1100, dugout_roof: 1000, dugout_roof_b: 1000, mg_nest_roof: 850 };
    for (const [name, mats] of T.dress) {
      const t = g?.scene.getObjectByName(name) || fortFallback(name); if (!t) continue;
      instance(this.scene, t, mats, { cullDist: cull[name] || 400, shadows: !/floor_|litter|ammo|_cover|net_/.test(name) });
    }
    this.buildTeeth(g, cull.dragon_tooth);
  }
  // ---------------------------------------------------------------- dragon's teeth (destroyable)
  // Own instancing (instancer.js cells of 90 m, same LOD / cull list) with one slot list per variant per cell, so a
  // tooth can switch variant in place: intact (dragon_tooth), damaged / toppled (dragon_tooth_b), destroyed
  // (dragon_tooth_rubble).  Swap-remove keeps each InstancedMesh's count = its live instances.
  buildTeeth(g, cullDist = 1100) {
    const teeth = this.fortTeeth = this.terrain.teeth || []; if (!teeth.length) return;
    const VAR = ['dragon_tooth', 'dragon_tooth_b', 'dragon_tooth_rubble'], CELL = 90, M = new THREE.Matrix4();
    const tpl = this._toothTpl = VAR.map(n => g?.scene.getObjectByName(n) || fortFallback(n));
    const cells = new Map(); this._teethHash = new Map();
    // base on the finished ground: the lowest point under the pyramid's base (the layout y is relative to flat ground),
    // a tilted / chipped tooth set deeper by what its tilt lifts the high edge
    const tb = tpl[0] ? new THREE.Box3().setFromObject(tpl[0]) : null, th = tb ? Math.max(tb.max.x - tb.min.x, tb.max.z - tb.min.z) / 2 : 0.85;
    teeth.forEach(t => { if (t.based) return; t.based = true; const r = th * t.s; t.g = this.baseY(t[0], t[1], r * 0.8, r * 0.8, t.ry); t.y += t.g + Math.sin(Math.abs(t.rx) + Math.abs(t.rz)) * r * -0.6; });
    teeth.forEach((t, i) => {
      t.i = i; t.hp = t.bad ? 0.6 : 1; t.state = t.bad ? 1 : 0; t.slot = [-1, -1, -1];
      const k = Math.floor(t[0] / CELL) + ',' + Math.floor(t[1] / CELL); let c = cells.get(k); if (!c) cells.set(k, c = { ids: [], k });
      c.ids.push(i); t.cell = c;
      const hk = Math.floor(t[0] / 8) * 4096 + Math.floor(t[1] / 8); (this._teethHash.get(hk) || this._teethHash.set(hk, []).get(hk)).push(t);
    });
    for (const c of cells.values()) {
      c.v = tpl.map(tp => {
        const L = { n: 0, ids: new Int32Array(c.ids.length), meshes: [], rels: [] }; tp.updateMatrixWorld(true);
        const inv = new THREE.Matrix4().copy(tp.matrixWorld).invert();
        tp.traverse(o => {
          if (!o.isMesh) return;
          const im = new THREE.InstancedMesh(o.geometry, o.material, c.ids.length); im.count = 0; im.castShadow = true; im.receiveShadow = true; im.name = o.name;
          im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.scene.add(im); L.meshes.push(im); L.rels.push(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
        });
        return L;
      });
      const [cx, cz] = c.k.split(',').map(Number);
      LODS.push({ near: c.v.flatMap(L => L.meshes), mid: [], far: [], cx: (cx + 0.5) * CELL, cz: (cz + 0.5) * CELL, dm: cullDist, d1: cullDist, d2: cullDist, state: -1 });
    }
    this._teethDirty = new Set();
    for (const t of teeth) this.toothShow(t, t.state, this.toothMatrix(t, t.state, M));
    this.teethFlush();
  }
  toothMatrix(t, state, out = new THREE.Matrix4(), from = null) {
    if (state === 0 || (state === 1 && !t.topple)) return out.copy(trs(t[0], t.y, t[1], t.ry, t.s, t.rx, t.rz));
    if (state === 1) { // toppled away from the blast: tipped over its far edge, half out of the ground
      // rested on the ground it fell on (the far edge of the tipped pyramid dug 0.3 m into the churned earth), not at the upright base height
      const [ax, az, a] = t.topple, tp = this._toothTpl?.[1];
      if (tp && this.terrain) return out.copy(this.restOn(tp, t[0] + ax * 0.25, t[1] + az * 0.25, Math.atan2(ax, az), a, 0, 0.3, t.s));
      return out.copy(trs(t[0] + ax * 0.25, t.y + 0.08, t[1] + az * 0.25, Math.atan2(ax, az), t.s, a, 0));
    }
    return out.copy(trs(t[0], (t.g || 0) - 0.06, t[1], t.ry + 1.3, t.s * (0.9 + (t.i % 5) * 0.05)));
  }
  // show tooth t as variant v (removing it from the others)
  toothShow(t, v, Mt) {
    const tmp = this._tm ||= new THREE.Matrix4(), mv = this._tm2 ||= new THREE.Matrix4();
    for (let w = 0; w < 3; w++) {
      const L = t.cell.v[w], s = t.slot[w];
      if (w !== v && s >= 0) { // swap-remove
        const last = --L.n;
        if (s !== last) { for (const im of L.meshes) { im.getMatrixAt(last, mv); im.setMatrixAt(s, mv); } const id = L.ids[last]; L.ids[s] = id; this.fortTeeth[id].slot[w] = s; }
        t.slot[w] = -1; for (const im of L.meshes) { im.count = L.n; this._teethDirty.add(im); }
      }
    }
    const L = t.cell.v[v]; let s = t.slot[v]; if (s < 0) { s = t.slot[v] = L.n++; L.ids[s] = t.i; }
    L.meshes.forEach((im, k) => { im.setMatrixAt(s, tmp.multiplyMatrices(Mt, L.rels[k])); im.count = L.n; this._teethDirty.add(im); });
  }
  teethFlush() { for (const im of this._teethDirty) { im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); } this._teethDirty.clear(); }
  // blast at (x, z): damage / destroy dragon's teeth (see the API notes at the top of this section)
  damageFortAt(x, z, power, radius = 0) {
    const H = this._teethHash; if (!H || !(power >= 0.6)) return 0;
    const big = power >= 1.2, rD = big ? Math.min(3.2, 1.15 * power - 0.1) : 0;
    let rT = big ? rD * 1.45 : 0.9; if (radius > 0) rT = Math.min(rT, Math.max(radius, 0.9));
    const hit = [];
    for (let i = Math.floor((x - rT) / 8); i <= Math.floor((x + rT) / 8); i++) for (let j = Math.floor((z - rT) / 8); j <= Math.floor((z + rT) / 8); j++)
      for (const t of H.get(i * 4096 + j) || []) { if (t.state === 2) continue; const d = Math.hypot(t[0] - x, t[1] - z); if (d < rT) hit.push([d, t]); }
    if (!hit.length) return 0;
    hit.sort((a, b) => a[0] - b[0]); if (!big) hit.length = 1;
    const M = new THREE.Matrix4(), gone = [];
    for (const [d, t] of hit) {
      const dmg = big ? (d <= rD ? 1.5 : 0.15 + 0.5 * (1 - (d - rD) / (rT - rD))) : 0.36 * Math.min(1, power / 0.8);
      t.hp -= dmg;
      if (t.hp <= 0) { t.state = 2; t.hp = 0; gone.push(t); }
      else if (t.hp < 0.75 || t.state === 1) {
        if (big && !t.topple && t.state === 0) { const L = Math.max(d, 0.01); t.topple = [(t[0] - x) / L, (t[1] - z) / L, 0.55 + 0.4 * Math.min(1, dmg / 0.6)]; }
        t.state = 1;
      } else continue;
      this.toothShow(t, t.state, this.toothMatrix(t, t.state, M));
    }
    this.teethFlush();
    if (gone.length) {
      let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
      for (const t of gone) { this.nav.removeTooth(t[0], t[1]); x0 = Math.min(x0, t[0]); z0 = Math.min(z0, t[1]); x1 = Math.max(x1, t[0]); z1 = Math.max(z1, t[1]); }
      this.nav.refreshArea(x0 - 2, z0 - 2, x1 + 2, z1 + 2);
    }
    return gone.length;
  }
  // A trench system (strongpoint / line) as the game sees it:
  //   id, key, name, kind ('strongpoint' | 'outpost' | 'line'), obj (objective id within 160 m, or null),
  //   front [fx,fz] (main facing, towards the enemy), lines: walkable fire-trench centre polylines [[x,z]...] (split
  //   at road gaps), comms: communication / crawl trench polylines, slots: fighting positions {x, z, fx, fz, kind:
  //   'bay' | 'mg' | 'line', fox?, line?, i?} (firing cells, foxholes and covered MG pits first, each with its own facing
  //   -- all-round defence -- then places along the trench front wall every ~5.5 m), dugouts: {x, z (chamber), door
  //   [x,z] (trench point), dir, occupants}, center [x,z], radius, depth.  Positions are on the floor of the cut; feet
  //   height = groundHeight / trenchInfo().fireY.
  trenchSystem(r) {
    const T = this.terrain, inside = (x, z, m = -0.15) => T.cutSDF(x, z) < m;
    const lines = [], slots = [], far = (x, z, d) => !slots.some(o => Math.hypot(o.x - x, o.z - z) < d);
    const ko = T.keepOut; T.keepOut = null;   // split at road gaps only (yard positions sit inside villages)
    for (const res of r.fires) for (const run of T.runs(res.pts, 3.5)) { const l = run.filter(p => inside(p[0], p[1])); if (l.length > 1) lines.push(l); }
    T.keepOut = ko;
    for (const res of r.fires) for (const b of res.bays) {
      const t = b.tag, k = Math.max(0.5, t.L - 0.55), x = t.x + t.fx * k, z = t.z + t.fz * k;
      if (inside(x, z)) slots.push({ x, z, fx: t.fx, fz: t.fz, kind: b.covered ? 'mg' : 'bay' });
    }
    for (const b of r.mgs) { const t = b.tag, x = t.x + t.fx * 0.7, z = t.z + t.fz * 0.7; if (inside(x, z)) slots.push({ x, z, fx: t.fx, fz: t.fz, kind: 'mg' }); }
    for (const q of r.foxes) for (const [x, z] of q.tag.slots) if (inside(x, z, -0.1) && far(x, z, 0.9)) slots.push({ x, z, fx: q.tag.fx, fz: q.tag.fz, kind: 'bay', fox: true });
    lines.forEach((l, li) => {
      const res = r.fires.find(f => f.pts.includes(l[0])) || r.fires[0], [fx, fz] = res.front;
      let acc = 2.5;
      for (let i = 0; i < l.length - 1; i++) {
        const [ax, az] = l[i], [bx, bz] = l[i + 1], L = Math.hypot(bx - ax, bz - az);
        for (; acc < L; acc += 5.5) {
          const x = ax + (bx - ax) * acc / L, z = az + (bz - az) * acc / L;
          // stand against the front wall of the trench (clear of the slumped wall foot)
          for (const k of [res.w - 0.42, res.w - 0.6, 0]) { const px = x + fx * k, pz = z + fz * k; if (inside(px, pz, -0.28) && far(px, pz, 3)) { slots.push({ x: px, z: pz, fx, fz, kind: 'line', line: li, i }); break; } }
        }
        acc -= L;
      }
    });
    if (!lines.length && !slots.length) return null;
    const all = [...lines.flat(), ...slots.map(s => [s.x, s.z])], cx = all.reduce((a, p) => a + p[0], 0) / all.length, cz = all.reduce((a, p) => a + p[1], 0) / all.length;
    const radius = Math.max(4, ...all.map(p => Math.hypot(p[0] - cx, p[1] - cz)));
    let obj = null, od = 160; for (const o of OBJECTIVES || []) { const d = Math.hypot(o.x - cx, o.z - cz); if (d < od) { od = d; obj = o.id; } }
    const depth = r.fires[0]?.depth || 1.3;
    return { id: r.id, key: r.key, name: r.name, kind: r.kind || 'line', obj, front: r.front, lines, comms: r.comms, slots, dugouts: r.dugouts, center: [cx, cz], radius, depth, craters: r.craters };
  }
  // raw earth trench walls: dark damp chernozem over lighter loess / clay, roots and stones, spade marks, wet foot
  wallMat() {
    const map = trenchWallTexture();
    const m = new THREE.MeshStandardMaterial({ map, color: 0xffffff, roughness: 0.96 });
    m.customProgramCacheKey = () => 'trench_wall_v2';
    // world-space biplanar mapping (walls run every which way; mesh UVs are only a fallback)
    m.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vTW; varying vec3 vTWN;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTW = (modelMatrix * vec4(transformed, 1.0)).xyz; vTWN = normalize(mat3(modelMatrix) * objectNormal);');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vTW; varying vec3 vTWN; float twWet;
        float twh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float twn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(twh(i), twh(i+vec2(1,0)), f.x), mix(twh(i+vec2(0,1)), twh(i+vec2(1,1)), f.x), f.y); }`)
        .replace('#include <map_fragment>', `
          vec3 twA = texture2D(map, vec2(vTW.x, vTW.y) / 1.4).rgb, twB = texture2D(map, vec2(vTW.z + 0.37, vTW.y) / 1.4).rgb;
          float twwA = abs(vTWN.z) + 0.05, twwB = abs(vTWN.x) + 0.05;
          diffuseColor.rgb *= (twA * twwA + twB * twwB) / (twwA + twwB);
          float twd = -vTW.y, twa = (vTW.x + vTW.z) * 0.7;
          float twb = smoothstep(0.55, 1.25, twd + (twn(vec2(twa * 0.9, twd * 2.0)) - 0.5) * 0.5);   // humus -> loess / clay
          vec3 twc = mix(vec3(0.62, 0.56, 0.5), vec3(0.95, 0.83, 0.68), twb);
          twc *= 0.8 + 0.4 * twn(vec2(twa * 0.35, twd * 0.6 + 4.0));                                // patchy damp / dry
          twc = mix(twc, twc * vec3(1.2, 1.16, 1.1), smoothstep(0.32, 0.0, twd) * 0.6);              // sun-dried lip
          twWet = smoothstep(0.75, 1.45, twd) * (0.55 + 0.45 * twn(vec2(twa * 1.3, 2.0)));
          twc *= 1.0 - 0.4 * twWet;                                                                    // wet, muddy foot
          diffuseColor.rgb *= twc;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = mix(roughnessFactor, 0.55, twWet * 0.8);`);
    };
    return m;
  }
  // trench / relief terrain material: the map's ground shader plus fresh spoil (dark clods, partly grassed / spread
  // out of sight), a muddy floor and standing water in the low spots
  trenchTopMat() {
    const m = this.groundMat(true), base = m.onBeforeCompile, key = m.customProgramCacheKey;
    m.customProgramCacheKey = () => key() + '_trench2';
    m.onBeforeCompile = (sh, r) => {
      base(sh, r);
      sh.fragmentShader = sh.fragmentShader.replace('diffuseColor.rgb *= col;', `
          #ifdef TERRAIN_MESH
            float tPud = 0.0;
            {
              float ty = vWPos.y;
              float tsp = smoothstep(0.03, 0.45, ty + (vn(wp * 1.3) - 0.5) * 0.12) * (1.0 - 0.7 * smoothstep(0.35, 0.8, vn(wp * 0.19 + 3.0)));   // (v7: fades in up the slope, no outline at the relief's foot)
              vec3 soil = dirt * vec3(0.44, 0.39, 0.34) * (0.7 + 0.6 * vn(wp * 4.3)) + vec3(0.05, 0.045, 0.035) * step(0.78, vn(wp * 9.1));
              col = mix(col, soil, tsp * 0.75);
              float tfl = smoothstep(0.55, 0.95, -ty);
              col = mix(col, dirt * vec3(0.34, 0.3, 0.26) * (0.8 + 0.4 * vn(wp * 1.9 + 5.0)), tfl * 0.7);
              tPud = smoothstep(0.6, 0.67, vn(wp * 0.5 + 11.0) + 0.16 * vn(wp * 2.3)) * tfl;
              col = mix(col, dirt * vec3(0.16, 0.15, 0.13), tPud * 0.9);
            }
          #endif
          diffuseColor.rgb *= col;`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          #ifdef TERRAIN_MESH
            roughnessFactor = mix(roughnessFactor, 0.42, tPud);
          #endif`);
    };
    return m;
  }
  // value-noise helper for painting
  noise2(x, z, s) { const h = (a, b) => { const t = Math.sin(a * 127.1 + b * 311.7 + s * 17.3) * 43758.5453; return t - Math.floor(t); }; const i = Math.floor(x), j = Math.floor(z), f = x - i, g = z - j, u = f * f * (3 - 2 * f), v = g * g * (3 - 2 * g); return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v; }
  // paint the splat map from the finished layout (call after buildings, rubble and craters exist)
  // war map (wear.js): craters + positions + town damage: brick dust along wrecked blocks, scorch at burnt-out blocks,
  // cars and smouldering spots, standing water in low spots of the courtyards and along the kerbs
  paintCityWar() {
    const R = this.rng;
    this.groundUniforms.tWar.value = paintWar(this, MAP_SIZE, { N: 1024, extra: ({ L, P, k, blob }) => {
      for (const b of this.buildings) {
        const dmg = b.panels.filter(p => p.state >= 2 || p.gone).length / Math.max(1, b.panels.length);
        L.a.save(); L.a.translate(...P(b.x, b.z)); L.a.rotate(-b.rot); L.a.globalAlpha = Math.min(0.75, 0.12 + dmg * 1.6); const pad = 2 + dmg * 9; L.a.fillRect((-b.L / 2 - pad) * k, (-b.D / 2 - pad) * k, (b.L + pad * 2) * k, (b.D + pad * 2) * k); L.a.restore();
        if (dmg > 0.18) for (let i = 0; i < 3; i++) { const w = b.toWorld((R() - 0.5) * b.L, 0, (R() < 0.5 ? -1 : 1) * (b.D / 2 + 3 + R() * 5)); blob(L.r, w.x, w.z, 3 + R() * 5, 0.35 + dmg); }
      }
      const v = new THREE.Vector3();
      for (const list of this.rubbleInstances || []) for (const M of list) { v.setFromMatrixPosition(M); blob(L.a, v.x, v.z, 4 + R() * 3, 0.55); if (R() < 0.3) blob(L.r, v.x, v.z, 2.5 + R() * 2, 0.4); }
      for (const [x, z, s] of MAP.smoulder || []) blob(L.r, x, z, 10 * s, 0.6);
      for (const [x, z] of this.wreckSpots || []) { blob(L.r, x, z, 4 + R() * 1.5, 0.7); blob(L.a, x, z, 6, 0.35); }
      for (const pl of Object.values(this._pl || {})) if (/burnt/.test(pl.t.name || '')) for (const M of pl.m) { v.setFromMatrixPosition(M); blob(L.r, v.x, v.z, 3.5, 0.8); }
      for (const r of ROADS) { // water along the kerbs and in the low spots
        const horiz = (r.x1 - r.x0) > (r.z1 - r.z0), n = Math.round(Math.max(r.x1 - r.x0, r.z1 - r.z0) / 30);
        for (let i = 0; i < n; i++) { const t = R(), sd = R() < 0.5 ? 0 : 1; const x = horiz ? r.x0 + t * (r.x1 - r.x0) : (sd ? r.x1 - 0.8 : r.x0 + 0.8), z = horiz ? (sd ? r.z1 - 0.8 : r.z0 + 0.8) : r.z0 + t * (r.z1 - r.z0); blob(L.b, x, z, 1.2 + R() * 2, 0.85, 0.6); }
      }
      for (let i = 0; i < 25; i++) blob(L.b, (R() - 0.5) * MAP_SIZE, (R() - 0.5) * MAP_SIZE, 2 + R() * 2.5, 0.5, 0.7);
      // scorched verges and burnt lawn patches (grass fires from shelling)
      for (let i = 0; i < 10; i++) { const x = (R() - 0.5) * (MAP_SIZE - 40), z = (R() - 0.5) * (MAP_SIZE - 40); if (onRoad(x, z, 2)) continue; blob(L.r, x, z, 3 + R() * 4, 0.3 + R() * 0.2, 0.8); }
    } });
  }
  paintGround() {
    this.paintCityWar();
    const N = 1024, k = N / MAP_SIZE, o = MAP_SIZE / 2, layer = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; };
    const toPx = (x, z) => [(x + o) * k, (z + o) * k];
    const R = this.rng;
    // rubble/gravel around blocks, rubble piles and craters
    // shapes drawn sharp, every layer blurred once at the end (per-shape canvas filters are very slow in software GL)
    const blurred = (src, px) => { const c = layer(), x = c.getContext('2d'); x.filter = `blur(${px}px)`; x.drawImage(src, 0, 0); return x; };
    const rub = layer(), rx = rub.getContext('2d'); rx.fillStyle = '#fff';
    for (const b of this.buildings) { rx.save(); rx.translate(...toPx(b.x, b.z)); rx.rotate(-b.rot); rx.globalAlpha = 0.22 + R() * 0.15; rx.fillRect((-b.L / 2 - 3.5) * k, (-b.D / 2 - 3.5) * k, (b.L + 7) * k, (b.D + 7) * k); rx.restore(); }
    rx.globalAlpha = 0.6; const v = new THREE.Vector3();
    for (const list of this.rubbleInstances || []) for (const M of list) { v.setFromMatrixPosition(M); rx.beginPath(); for (let i = 0; i <= 10; i++) { const a = i / 10 * 6.28, rr = 2.2 + R() * 2.2; const [a1, b1] = toPx(v.x + Math.cos(a) * rr, v.z + Math.sin(a) * rr); i ? rx.lineTo(a1, b1) : rx.moveTo(a1, b1); } rx.fill(); }
    // worn paths: each entrance to the nearest road edge, plus along the courtyard face
    const pth = layer(), px = pth.getContext('2d'); px.strokeStyle = '#fff'; px.lineCap = 'round';
    for (const b of this.buildings) {
      px.lineWidth = 2.4 * k; px.globalAlpha = 0.8;
      for (const e of b.entrances) {
        let best = null, bd = 1e9; for (const r of ROADS) { const cx = Math.max(r.x0 - SIDEWALK, Math.min(r.x1 + SIDEWALK, e.x)), cz = Math.max(r.z0 - SIDEWALK, Math.min(r.z1 + SIDEWALK, e.z)); const d = Math.hypot(cx - e.x, cz - e.z); if (d < bd) { bd = d; best = [cx, cz]; } }
        if (best && bd < 90) { px.beginPath(); px.moveTo(...toPx(e.x, e.z)); if (Math.abs(best[0] - e.x) > 0.5 && Math.abs(best[1] - e.z) > 0.5) px.lineTo(...toPx(e.x, best[1])); px.lineTo(...toPx(best[0], best[1])); px.stroke(); }
      }
      if (b.entrances.length > 1) { px.lineWidth = 3 * k; px.globalAlpha = 0.6; px.beginPath(); px.moveTo(...toPx(b.entrances[0].x, b.entrances[0].z)); for (const e of b.entrances) px.lineTo(...toPx(e.x, e.z)); px.stroke(); }
    }
    // mud: craters only (scorched, churned)
    const mud = layer(), mx = mud.getContext('2d'); mx.fillStyle = '#fff';
    const cm = this.craterMesh, M = new THREE.Matrix4(), sc = new THREE.Vector3(), q = new THREE.Quaternion();
    const blob = (ctx, x, z, r, alpha) => { ctx.globalAlpha = alpha; ctx.beginPath(); const n = 14, ph = R() * 6.28; for (let i = 0; i <= n; i++) { const a = i / n * 6.28, rr = r * (0.55 + 0.45 * this.noise2(Math.cos(a + ph) * 2 + x, Math.sin(a + ph) * 2 + z, 9) + (R() - .5) * 0.25); const [px2, pz2] = toPx(x + Math.cos(a) * rr, z + Math.sin(a) * rr); i ? ctx.lineTo(px2, pz2) : ctx.moveTo(px2, pz2); } ctx.fill(); };
    if (cm) for (let i = 0; i < cm.count; i++) { cm.getMatrixAt(i, M); M.decompose(v, q, sc); blob(mx, v.x, v.z, sc.x * 0.28, 0.45); }   // bowl only (v7: no mud disc + gravel ring round every crater)
    // lawns: an ordered plan — the whole district is laid out as courtyard lawns and road verges, then we cut
    // out roads + pavements, a trampled apron around every block, straight footpaths and the dirt yards
    const lawn = layer(), lx = lawn.getContext('2d'); lx.fillStyle = '#fff'; lx.fillRect(0, 0, N, N);
    lx.globalCompositeOperation = 'destination-out'; lx.fillStyle = '#000'; lx.strokeStyle = '#000'; lx.lineCap = 'butt';
    for (const l of this.lots || []) lx.fillRect(...toPx(l[0] - 1, l[1] - 1), (l[2] - l[0] + 2) * k, (l[3] - l[1] + 2) * k);
    for (const r of ROADS) { const sw = (r.type === 'drive' ? 1.3 : SIDEWALK) + 0.6; lx.fillRect(...toPx(r.x0 - sw, r.z0 - sw), (r.x1 - r.x0 + sw * 2) * k, (r.z1 - r.z0 + sw * 2) * k); }
    for (const b of this.buildings) { lx.save(); lx.translate(...toPx(b.x, b.z)); lx.rotate(-b.rot); lx.fillRect((-b.L / 2 - 1.3) * k, (-b.D / 2 - 1.3) * k, (b.L + 2.6) * k, (b.D + 2.6) * k); lx.restore(); }
    for (const b of this.buildings) for (const e of b.entrances) {
      let best = null, bd = 1e9; for (const r of ROADS) { const cx = Math.max(r.x0 - SIDEWALK, Math.min(r.x1 + SIDEWALK, e.x)), cz = Math.max(r.z0 - SIDEWALK, Math.min(r.z1 + SIDEWALK, e.z)); const d = Math.hypot(cx - e.x, cz - e.z); if (d < bd) { bd = d; best = [cx, cz]; } }
      if (best && bd < 90) { lx.lineWidth = 1.7 * k; lx.beginPath(); lx.moveTo(...toPx(e.x, e.z)); if (Math.abs(best[0] - e.x) > 0.5 && Math.abs(best[1] - e.z) > 0.5) lx.lineTo(...toPx(e.x, best[1])); lx.lineTo(...toPx(best[0], best[1])); lx.stroke(); }
    }
    for (const [x, z, r, rot] of this.dirtYards || []) { lx.save(); lx.translate(...toPx(x, z)); lx.rotate(-rot); lx.fillRect(-r * k, -r * 0.7 * k, r * 2 * k, r * 1.4 * k); lx.restore(); }
    lx.globalCompositeOperation = 'source-over';
    const lawnB = layer(), lb = lawnB.getContext('2d'); lb.filter = `blur(${2.2 * k}px)`; lb.drawImage(lawn, 0, 0);
    const g1 = blurred(rub, 5 * k).getImageData(0, 0, N, N).data, g2 = blurred(pth, 1.2 * k).getImageData(0, 0, N, N).data, g3 = blurred(mud, 2 * k).getImageData(0, 0, N, N).data, g4 = lb.getImageData(0, 0, N, N).data;
    const out = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = i / k - o, z = j / k - o, p = (j * N + i) * 4;
      const rubble = g1[p + 3] / 255, path = g2[p + 3] / 255, lw = g4[p + 3] / 255;   // alpha: white-on-transparent layers (v7)
      const n1 = this.noise2(x / 14, z / 14, 1);
      // lawns are full; only shell-churned / heavily walked spots wear through
      // soft, irregular lawn edges: grass thins out over a couple of metres instead of stopping on a line
      const edge = Math.min(1, Math.max(0, lw + (this.noise2(x / 3.5, z / 3.5, 6) - 0.5) * 0.45 * (1 - Math.abs(lw * 2 - 1))));
      let grass = Math.max(edge * (0.84 + n1 * 0.16), 0.22 * this.noise2(x / 6, z / 6, 3)) * (1 - rubble * 0.6) * (1 - path * 0.5);
      const mudv = g3[p + 3] / 255 * (0.6 + this.noise2(x / 2, z / 2, 5) * 0.5);
      out[p] = grass * 255; out[p + 1] = Math.min(1, rubble * (0.35 + this.noise2(x / 4, z / 4, 4) * 0.8)) * 255; out[p + 2] = mudv * 255; out[p + 3] = Math.max(path, (1 - lw) * 0.5) * 255;
    }
    const t = new THREE.DataTexture(out, N, N, THREE.RGBAFormat); t.flipY = false; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    this.groundUniforms.tSplat.value = t; this.splatData = out; this.splatN = N;
    this.grassClumps();
  }
  // scattered dry-grass / weed clumps (crossed quads, alpha-tested) where the splat says grass
  grassClumps() {
    // blade atlas: thin tapered blades and seed heads on transparent background
    const c = document.createElement('canvas'); c.width = 256; c.height = 256; const x = c.getContext('2d');
    for (let i = 0; i < 160; i++) {
      const bx = 128 + (Math.random() - .5) * 220, h = 70 + Math.random() * 170, lean = (Math.random() - .5) * 70, w = 2 + Math.random() * 3;
      const g = Math.random(); const col = g < 0.5 ? [150 + Math.random() * 22, 150 + Math.random() * 18, 92 + Math.random() * 14] : [170 + Math.random() * 22, 158 + Math.random() * 18, 106 + Math.random() * 14];
      const gr = x.createLinearGradient(0, 256, 0, 256 - h); gr.addColorStop(0, `rgb(${col[0] * 0.78 | 0},${col[1] * 0.78 | 0},${col[2] * 0.72 | 0})`); gr.addColorStop(0.45, `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`); gr.addColorStop(1, `rgb(${Math.min(255, col[0] * 1.12) | 0},${Math.min(255, col[1] * 1.08) | 0},${col[2] * 1.05 | 0})`);
      x.fillStyle = gr;
      x.beginPath(); x.moveTo(bx - w, 256); x.quadraticCurveTo(bx + lean * 0.4 - w * 0.5, 256 - h * 0.55, bx + lean, 256 - h); x.quadraticCurveTo(bx + lean * 0.4 + w * 0.5, 256 - h * 0.55, bx + w, 256); x.fill();
      if (Math.random() < 0.12) { x.fillStyle = 'rgb(160,140,96)'; x.beginPath(); x.ellipse(bx + lean, 256 - h, 2.5, 7, lean * 0.01, 0, 7); x.fill(); }
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const mat = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, color: 0xffffff });
    const wind = this.windUniform = { value: 0 };
    mat.onBeforeCompile = sh => {
      sh.uniforms.uTime = wind;
      // double-sided cards: three.js flips the normal on back faces, which lit the far side of every clump
      // as a dark, almost black blade — keep the (upward) normal on both sides so all blades shade alike
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize( vNormal );');
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 ip = instanceMatrix[3].xyz;
            float sway = sin(uTime * 1.7 + ip.x * 0.35 + ip.z * 0.27) * 0.12 + sin(uTime * 3.1 + ip.x * 1.3) * 0.04;
            transformed.x += sway * position.y * position.y; transformed.z += sway * 0.6 * position.y * position.y;
          #endif`);
    };
    // three crossed quads per clump
    const qs = [0, 1, 2].map(i => { const q = new THREE.PlaneGeometry(1, 1); q.translate(0, 0.5, 0); q.rotateY(i * Math.PI / 3); return q; });
    const gg = mergeGeometries(qs); const nrm = gg.attributes.normal; for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0); // light like the ground
    const tpl = new THREE.Mesh(gg, mat);
    const N = this.splatN, k = N / MAP_SIZE, o = MAP_SIZE / 2, mats = [], cols = [];
    const maxN = this.grassMax || 80000;
    for (let i = 0; i < maxN * 3.2 && mats.length < maxN; i++) {
      const px = (this.rng() - .5) * MAP_SIZE, pz = (this.rng() - .5) * MAP_SIZE;
      const si = (Math.floor((pz + o) * k) * N + Math.floor((px + o) * k)) * 4; const gw = this.splatData[si] / 255;
      if (gw < 0.35 || this.rng() > gw) continue;
      if (this.warData && this.rng() < warAt(this, MAP_SIZE, px, pz, 0) * 2.5 + warAt(this, MAP_SIZE, px, pz, 1) * 2.6 + warAt(this, MAP_SIZE, px, pz, 3) * 1.6 + Math.max(0, warAt(this, MAP_SIZE, px, pz, 2) - 0.4) * 2) continue;   // (v7) thins out gradually into scorch / churn / mud / wet ground
      if (onRoad(px, pz, SIDEWALK + 0.4) || (this.lots || []).some(l => px > l[0] && px < l[2] && pz > l[1] && pz < l[3])) continue; const ni = this.nav.idx(px, pz); if (ni < 0 || this.nav.cost[ni] !== 1) continue;
      if (this.terrain.cutSDF(px, pz) < 0.9) continue;
      const s = 0.35 + this.rng() * 0.55; if (this.uneven(px, pz, 0.9 * s) > 0.25) continue;   // not across a spoil heap / mound edge
      mats.push(trs(px, this.baseY(px, pz, 0.55 * s, 0.55 * s) - 0.03, pz, this.rng() * 6.28, 1).multiply(new THREE.Matrix4().makeScale(s * 1.6, s, s * 1.6)));
      cols.push(new THREE.Color().setHSL(0.15 + (this.rng() - .5) * 0.03, 0.12 + this.rng() * 0.08, 0.9 + this.rng() * 0.08));
    }
    // the lawns carry on past the playable edge (thinner, patchy) so the grass doesn't stop on a line
    if (!this.noOuterGrass) {
      const half = MAP_SIZE / 2, extra = Math.round(maxN * 0.45);
      for (let i = 0, n = 0; i < extra * 4 && n < extra; i++) {
        const px = (this.rng() - .5) * (MAP_SIZE + 320), pz = (this.rng() - .5) * (MAP_SIZE + 320);
        if (Math.max(Math.abs(px), Math.abs(pz)) < half + 2) continue;
        if (Math.abs(pz) < 15 || Math.abs(px - 85) < 11 || Math.abs(px + 204) < 7 || Math.abs(px - 202) < 7 || Math.abs(Math.abs(pz) - 197) < 7) continue;
        if (this.noise2(px * 0.03, pz * 0.03, 12) < 0.4) continue;
        const s = 0.35 + this.rng() * 0.5; mats.push(trs(px, this.baseY(px, pz, 0.55 * s, 0.55 * s) - 0.03, pz, this.rng() * 6.28, 1).multiply(new THREE.Matrix4().makeScale(s * 1.6, s, s * 1.6)));
        cols.push(new THREE.Color().setHSL(0.15 + (this.rng() - .5) * 0.03, 0.12 + this.rng() * 0.08, 0.9 + this.rng() * 0.08)); n++;
      }
    }
    instance(this.scene, tpl, mats, { shadows: false, colors: cols, cullDist: this.grassCull || 340 });
  }
  roads() {
    const asphalt = roadWear(this.mat('asphalt', 1, { color: 0xd8d4cc, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), this.groundUniforms, { damage: 0.8 });
    const walk = roadWear(this.mat('concrete', 1, { color: 0xbab4a8, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), this.groundUniforms, { damage: 0 });
    const curbMat = this.assets.tex.curb ? this.mat('curb', 1, { color: 0xffffff }) : new THREE.MeshStandardMaterial({ color: 0x9d988c, roughness: 0.9 });
    const uvPlane = (w, d, scale) => { const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / scale, uv.getY(i) * d / scale); return g; };
    for (const r of ROADS) this.nav.markRoad(r.x0, r.z0, r.x1, r.z1, 2);
    // roads v2 (roadmesh.js): all carriageways at one level, one merged surface with filleted corners (avenue > street >
    // driveway radius), pavements around it, kerbs along the carriageway outline only
    const prio = r => (r.w === 'avenue' ? 2 : r.type === 'drive' ? 0 : 1) * 1e5 + Math.max(r.x1 - r.x0, r.z1 - r.z0);
    const swOf = r => r.type === 'drive' ? 1.3 : SIDEWALK;
    const above = r => ROADS.filter(o => o !== r && (prio(o) > prio(r) || (prio(o) === prio(r) && ROADS.indexOf(o) > ROADS.indexOf(r))));
    const S = roadSurfaces(ROADS.map(r => { const w = r.x1 - r.x0, d = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      return { pts: w > d ? [[r.x0, cz], [r.x1, cz]] : [[cx, r.z0], [cx, r.z1]], hw: Math.min(w, d) / 2, sw: swOf(r), rad: r.w === 'avenue' || Math.min(w, d) >= 12 ? 9 : r.type === 'drive' ? 2 : 5.5, kerb: true, ext: 0 }; }), { key: 'city:' + MAP.id + ':' + ROADS.length });
    this.roadStats = { ms: S.ms, tris: S.tris, cached: S.cached };
    for (const g of S.walk) { const m = new THREE.Mesh(g, walk); m.receiveShadow = true; this.scene.add(m); }
    for (const g of S.asphalt) { const m = new THREE.Mesh(g, asphalt); m.receiveShadow = true; this.scene.add(m); }
    for (const r of ROADS) {
      const w = r.x1 - r.x0, d = r.z1 - r.z0, ab = above(r);
      // lane markings (worn) — not on the single-lane courtyard driveways; flush (polygonOffset), short of junctions
      if (r.type === 'drive') continue;
      const horiz = w > d; const len = horiz ? w : d;
      const dash = this._dashM ||= new THREE.MeshStandardMaterial({ color: 0xc9c5b8, roughness: 0.9, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
      const mats = [], inX = (x, z) => ab.some(o => x > o.x0 - 5 && x < o.x1 + 5 && z > o.z0 - 5 && z < o.z1 + 5);
      for (let t = -len / 2 + 2; t < len / 2; t += 9) if (this.rng() > 0.25) { const x = horiz ? (r.x0 + r.x1) / 2 + t : (r.x0 + r.x1) / 2, z = horiz ? (r.z0 + r.z1) / 2 : (r.z0 + r.z1) / 2 + t; if (!inX(x, z)) mats.push(trs(x, ROAD_Y, z, horiz ? 0 : Math.PI / 2)); }
      const dg = new THREE.PlaneGeometry(3, 0.15); dg.rotateX(-Math.PI / 2);
      instance(this.scene, new THREE.Mesh(dg, dash), mats, { shadows: false });
    }
    // kerbs (hash per stone, no world RNG draws): a few missing, slightly tilted
    const curbs = [];
    for (const [x, z, yaw] of S.kerbs) { let h = Math.imul(Math.round(x * 10) | 0, 73856093) ^ Math.imul(Math.round(z * 10) | 0, 19349663); h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); h = ((h ^ (h >>> 15)) >>> 0) / 4294967296; if (h < 0.04) continue; curbs.push(trs(x, 0.08, z, yaw, 1, 0, (h * 7 % 1 - 0.5) * 0.04)); }
    const cg = new THREE.BoxGeometry(0.98, 0.2, 0.22);
    instanceRuns(this.scene, Object.assign(new THREE.Mesh(cg, curbMat), { name: 'curb' }), curbs, { cell: 90, lodDist: 100 });   // (far: merged straight runs)
  }
  // streets v1 (streetFurniture.js, own RNG, light here): junction signs, zebras, a dead traffic light, entry plates
  streetFurniture() {
    const roads = ROADS.map(r => { const w = r.x1 - r.x0, d = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, hw = Math.min(w, d) / 2;
      return { pts: w > d ? [[r.x0, cz], [r.x1, cz]] : [[cx, r.z0], [cx, r.z1]], w: hw * 2, sw: r.type === 'drive' ? 1.3 : SIDEWALK, sc: r.w === 'avenue' || hw >= 6 ? 'main' : r.type === 'drive' ? 'drive' : 'micro', name: '' }; });
    const cands = this.buildings.filter(b => b.kind === 'school' || b.shops).map(b => [b.x, b.z, b.kind === 'school' ? 0 : 2]);
    const plan = planStreets(roads, { extraCands: cands, size: MAP_SIZE });
    const res = buildStreetFurniture(this, plan, { size: MAP_SIZE, seed: 4242 + (MAP.id || '').length, town: MAP.id === 'city' ? 'Новозаводськ' : '', urban: true, lights: 1, shelters: 0, plates: false });
    this.streetStats = res?.stats;
  }
  // ---------------------------------------------------------------- buildings
  placeBuildings() {
    const kit = this.assets.kit;
    this.pool = makeKitPool(this.scene, kit);
    const signNames = Object.keys(kit.pieces).filter(k => /^sign_.*_intact$/.test(k));
    for (const [x, z, rot, modules, floors, depthModules, sections, kind, dmg, extra] of this.buildingRows || BUILDINGS) {
      const b = new Building({ x, z, rot, modules, floors, depthModules, sections, kind, ...(extra || {}), signNames }, kit);
      b.predamage(dmg);
      this.buildings.push(b);
    }
    // a pancaked section on the nine-storey at (30,-68) and the one at (-150,-60)
    for (const [i, a, c] of this.pancakes || MAP.pancakes || []) this.buildings[i]?.pancake(a, c);
    // real-place maps (ruins.js): bomb craters, stripped facades, burnt-out storeys, the kit pieces that go with them
    if (this.ruinPlan) for (const b of this.buildings) this.ruinPlan(b);
    const aabb = b => { const c = Math.abs(Math.cos(b.rot)), sn = Math.abs(Math.sin(b.rot)); const hx = (b.L * c + b.D * sn) / 2, hz = (b.L * sn + b.D * c) / 2; return [b.x - hx, b.x + hx, b.z - hz, b.z + hz]; };
    if (!this.buildingRows) this.buildings.forEach((b, i) => { const A = aabb(b);
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
    for (const m of [slab, dark, roofs]) { m.matrixAutoUpdate = false; markStatic(m); }   // (cached static shadow: engine/renderer.js)
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
  // Facade decals that break up the repeating damage kit: soot plumes above burnt-out windows, shrapnel
  // pock-mark clusters on spandrels, big scorches on blank end walls. Placed only on solid wall areas
  // (window head 2.30 m .. next sill 3.66 m), hidden again when the panel they sit on goes.
  facadeDecals() {
    const kinds = ['soot', 'pocks', 'scorch', 'streak'], tex = kinds.map(decalTexture);
    const g = new THREE.PlaneGeometry(1, 1); g.translate(0, 0.5, 0);
    const meshes = tex.map(t => { const m = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ map: t, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), 2600); m.count = 0; m.receiveShadow = true; m.frustumCulled = false; this.scene.add(m); return m; });
    const { W, H } = this.assets.kit, R = this.decalRng || this.rng, list = this.decals = [], q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
    const add = (k, b, p, lx, y, w, h, dep) => {
      const m = meshes[k]; if (m.count >= 2600) return;
      // never past the building's corner (edge panels) or up into the sky above the roof (top storey): a decal overhanging
      // the wall it is painted on floats beside / above the block
      const at = b.panelMap;
      if (at && (!at.get(p.side + ':' + (p.col - 1) + ':' + p.floor) || !at.get(p.side + ':' + (p.col + 1) + ':' + p.floor))) { lx = Math.max(-W / 2 + 0.3, Math.min(W / 2 - 0.3, lx)); w = Math.min(w, W - 0.1 - 2 * Math.abs(lx)); }
      if (at && !at.get(p.side + ':' + p.col + ':' + (p.floor + 1))) h = Math.min(h, H + 0.15 - y);
      if (w < 0.25 || h < 0.25) return;
      const o = b.outward(p), c = b.panelCenter(p, new THREE.Vector3()), side = new THREE.Vector3(o.z, 0, -o.x);
      v.copy(c).addScaledVector(side, lx).addScaledVector(o, 0.02); v.y = p.floor * H + y;
      q.setFromAxisAngle(Y, b.rot + p.rot); sc.set(w, h, 1);
      const M = new THREE.Matrix4().compose(v, q, sc); const i = m.count++; m.setMatrixAt(i, M);
      list.push({ m, i, p, dep });
    };
    for (const b of this.buildings) {
      const at = b.panelMap || new Map();
      for (const p of b.panels) {
        if (p.gone || p.state === 3 || p.shop) continue;
        const up = at.get(p.side + ':' + p.col + ':' + (p.floor + 1));
        const blank = /blank/.test(p.type);
        if (blank) {
          if (p.state >= 1 && R() < 0.55) add(2, b, p, (R() - .5) * 1.2, 0.3 + R() * 1.0, 1.6 + R() * 1.6, 1.4 + R() * 1.3, null);
          if (R() < 0.35 + p.state * 0.2) add(1, b, p, (R() - .5) * 1.6, 0.4 + R() * 1.6, 0.9 + R() * 1.2, 0.8 + R() * 0.9, null);
          if (R() < 0.12) add(3, b, p, (R() - .5) * 2, 0.8, 0.5 + R() * 0.5, 1.8 + R() * 1.2, null);
          continue;
        }
        if (up && (up.state === 3 || up.gone)) continue;
        const band = up?.balcony ? 0.5 : 1.28;               // solid wall between this window head and the next sill
        if ((p.state >= 2 || p.soot) && R() < (p.soot ? 0.92 : 0.8)) add(0, b, p, (R() - .5) * 0.3, 2.33, 1.2 + R() * 0.6, band, up);   // (p.soot: ruins.js burnt-out flats)
        else if (p.state >= 1 && R() < 0.45) add(1, b, p, (R() - .5) * 1.2, 2.34, 0.8 + R() * 0.8, Math.min(band, 0.6 + R() * 0.6), up);
        else if (R() < 0.08) add(3, b, p, (R() - .5) * 2.4, 2.33, 0.35 + R() * 0.3, band, up);
      }
    }
    for (const m of meshes) { m.instanceMatrix.needsUpdate = true; }
  }
  // hide decals whose wall is gone (called from the game a few times a second)
  updateDecals() {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const d of this.decals || []) { if (d.off) continue; const b = d.p.b; if (d.p.gone || d.p.state === 3 || (d.dep && (d.dep.gone || d.dep.state === 3)) || (b && b.goneCols?.has(d.p.col) && (d.p.side === 'front' || d.p.side === 'back'))) { d.off = true; d.m.setMatrixAt(d.i, zero); d.m.instanceMatrix.needsUpdate = true; } }
  }
  // ---------------------------------------------------------------- rubble
  rubbleTemplates() {
    if (this._rt) return this._rt;
    const keys = this.assets.rubbleKeys || [];
    this._rt = keys.map(k => { const sc = this.assets.gltf[k].scene; sc.userData.key = k; return sc; });
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
  // rubble pools by role (keys from assets/env/manifest.json rubble files); missing ones fall back to the whole set
  rubblePool(kind) {
    const T = this.rubbleTemplates(), want = { fan: [4, 5, 6, 9, 11], heap: [1, 3, 7, 9, 10, 12], street: [4, 6, 11, 5], brick: [2, 8, 12, 6], house: [1, 2, 8, 12] }[kind];
    const l = want ? T.filter(t => want.some(n => t.userData.key === 'rubble_' + n)) : [];
    return l.length ? l : T;
  }
  rubbleAndDebris() {
    const T = this.rubbleTemplates(), place = new Map(), REF = 3.4, rng = this.rubbleRng || this.rng;   // (real-place maps: own stream, ruins.js)
    // s = size relative to a 3.4 m-radius pile; each template is scaled to that footprint
    const add = (x, z, s, ry, own = null, kind = 'fan') => {
      if (onRoad(x, z, -1) && rng() < 0.5) s *= 0.6;
      const pool = this.rubblePool(kind), t = pool[Math.floor(rng() * pool.length)], sc = s * REF / Math.max(1.5, t.userData.r), rr = t.userData.r * sc;
      if (this.buildings.some(b => b !== own && (() => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + rr * 0.7 && Math.abs(lz) < b.D / 2 + rr * 0.7; })())) return;
      if (this.terrain.cutSDF(x, z) < rr + 1) return;
      const M = trs(x, 0, z, ry, sc); (place.get(t) || place.set(t, []).get(t)).push(M); this.terrain.stamp(t, M);
      if (this.real) this.solidAdd(x, z, rr * 0.6, rr * 0.6, 0, 'rubble');   // (benches, bins, cars, trees placed later keep off the heap)
      // passable for everyone, slow; big heaps give low cover (vehicles climb them: see groundHeight)
      const top = t.userData.h * sc;
      this.nav.circle(x, z, rr * 0.65, top > 1.1 ? 7 : top > 0.5 ? 5 : 3, true);
      // real-place maps: a heap over ~1.2 m stops wheeled vehicles, over ~2.2 m any vehicle (infantry climb it, slowly)
      if (this.real && top > 1.2) { const nav = this.nav, v = top > 2.2 ? 2 : 1, r0 = rr * 0.5; nav.veh ||= new Uint8Array(nav.n * nav.n); nav.vehDirty = true; for (let zz = z - r0; zz <= z + r0; zz += nav.cell) for (let xx = x - r0; xx <= x + r0; xx += nav.cell) { if ((xx - x) ** 2 + (zz - z) ** 2 > r0 * r0) continue; const i = nav.idx(xx, zz); if (i >= 0) nav.veh[i] = Math.max(nav.veh[i], v); } }
    };
    for (const b of this.buildings) {
      // debris fans under destroyed/holed panels
      for (const p of b.panels) {
        if (p.state < 2 || p.floor > 3) continue;
        if (p.state === 2 && rng() < 0.6) continue;
        const c = b.panelCenter(p), o = b.outward(p);
        const sc = 0.6 + rng() * 0.5 + (p.state === 3 ? 0.4 : 0), off = REF * sc * 0.42 + rng() * 0.5;
        add(c.x + o.x * off, c.z + o.z * off, sc, rng() * 6.28, b, /brick/.test(b.kind) ? (rng() < 0.6 ? 'brick' : 'fan') : 'fan');
      }
      if (b.pancaked) for (let c = b.pancaked[0]; c <= b.pancaked[1]; c++) for (let k = 0; k < 3; k++) {
        const w = b.toWorld(-b.L / 2 + (c + 0.5) * this.assets.kit.W + (rng() - .5) * 3, 0, (rng() - .5) * b.D * 1.4);
        add(w.x, w.z, 1.6 + rng() * 0.9, rng() * 6.28, null, 'heap');
      }
      if (b.collapsedCorner) for (let k = 0; k < 3; k++) {
        const ex = (b.collapsedCorner === 'right' ? 1 : -1) * (b.L / 2 + 2 + rng() * 3);
        const w = b.toWorld(ex, 0, (rng() - .5) * b.D); add(w.x, w.z, 1.0 + rng() * 0.7, rng() * 6.28, null, /brick/.test(b.kind) ? 'brick' : 'heap');
      }
    }
    // loose debris lies along the foot of the walls it fell from, not in the middle of yards
    for (let i = 0; i < (this.streetDebris ?? 18) && this.buildings.length; i++) {
      const b = this.buildings[Math.floor(rng() * this.buildings.length)], side = Math.floor(rng() * 4), s = 0.35 + rng() * 0.4, rr = REF * s * 0.45;
      const u = (rng() - .5) * 0.9, w = side < 2 ? b.toWorld(u * b.L, 0, (side ? 1 : -1) * (b.D / 2 + rr)) : b.toWorld((side === 2 ? 1 : -1) * (b.L / 2 + rr), 0, u * b.D);
      add(w.x, w.z, s, rng() * 6.28, b, 'street');
    }
    this.ruinRubble?.(add);   // (ruins.js: heaps along stripped facades / bomb craters, flattened houses, the kit collapse piles)
    for (const [t, l] of place) instance(this.scene, t, l, this.rubbleInst?.(t, l) || farLod(t));   // (real-place maps: far LOD / bigger cells; otherwise the heaps' simplified copy beyond ~80 m)
    this.rubbleInstances = [...place.values()];
  }
  // Dynamic rubble when panels are destroyed during play.
  spawnRubble(x, z, s) {
    const T = this.rubbleTemplates(), tp = T[Math.floor(Math.random() * T.length)], t = tp.clone();
    t.position.set(x, -0.6 * s, z); t.rotation.y = Math.random() * 6.28; t.scale.setScalar(s); t.userData.rise = 0.6 * s;
    this.dynamic.add(t); this.nav.circle(x, z, t.userData.r * s * 0.6, 4, true);
    this.terrain.stamp(tp, trs(x, 0, z, t.rotation.y, s));
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
    // street trees: rows along both verges of every road (avenue limes/chestnuts, poplars on the driveways)
    for (const r of ROADS) {
      const horiz = (r.x1 - r.x0) > (r.z1 - r.z0), step = r.type === 'drive' ? 13 : 11, off = (horiz ? (r.z1 - r.z0) : (r.x1 - r.x0)) / 2 + SIDEWALK + 2.2;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, a0 = horiz ? r.x0 : r.z0, a1 = horiz ? r.x1 : r.z1;
      for (let t = a0 + 6; t < a1 - 6; t += step) for (const sd of [-1, 1]) {
        if (this.rng() > (r.w === 'avenue' ? 0.85 : 0.6)) continue;
        const x = horiz ? t + (this.rng() - .5) * 1.5 : cx + sd * off, z = horiz ? cz + sd * off : t + (this.rng() - .5) * 1.5;
        if (!onRoad(x, z, 1.5)) spots.push([x, z]);
      }
    }
    // courtyards
    for (let i = 0; i < 110; i++) { const x = (this.rng() - .5) * (MAP_SIZE - 40), z = (this.rng() - .5) * (MAP_SIZE - 40); if (!onRoad(x, z, 4)) spots.push([x, z]); }
    const by = {}, inLot = (x, z) => (this.lots || []).some(l => x > l[0] - 2 && x < l[2] + 2 && z > l[1] - 2 && z < l[3] + 2);
    for (const [x, z] of spots) {
      if (inLot(x, z) || this.terrain.cutSDF(x, z) < 2) continue;
      const i = this.nav.idx(x, z); if (i < 0 || this.nav.cost[i] === BLOCK) continue;
      if (this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + 3 && Math.abs(lz) < b.D / 2 + 3; })) continue;
      if (this.solidHit(x, z, 0.45, 0.45, 0, 0.3)) continue;
      const roll = this.rng();
      const type = roll < 0.12 && T.leafy ? 'leafy' : roll < 0.22 && T.stump ? 'stump' : roll < 0.27 && T.fallen ? 'fallen' : 'bare';
      const list = T[type]; const k = Math.floor(this.rng() * list.length);
      if (type !== 'stump' && type !== 'fallen') { const cr = this.canopyR(list[k], 1.05) * 0.75; if (this.crownHit(x, z, cr)) continue; }
      const fr = type === 'fallen' ? 1.0 : 0.35, M = trs(x, this.baseY(x, z, fr, fr), z, this.rng() * 6.28, 0.85 + this.rng() * 0.35);
      M.userData = type === 'stump' || type === 'fallen' ? null : [x, z, this.canopyR(list[k], Math.hypot(M.elements[0], M.elements[1], M.elements[2])) * 0.9];
      (by[type + k] ||= { t: list[k], m: [] }).m.push(M);
      this.nav.circle(x, z, type === 'fallen' ? 1.2 : 0.5, type === 'fallen' ? 5 : BLOCK, true);
      this.solidAdd(x, z, type === 'fallen' ? 1.2 : 0.4, type === 'fallen' ? 1.2 : 0.4, 0, 'tree');
    }
    this._treesBy = by;   // instanced after the dressing (private houses come later): crowns over a roof are dropped there
  }
  flushTrees() {
    for (const v of Object.values(this._treesBy || {})) {
      const m = v.m.filter(M => { const u = M.userData; if (!u || !this.solidHit(u[0], u[1], u[2], u[2], 0, 0, k => !ROOFED.test(k))) return true; this.nav.circle(u[0], u[1], 0.5, 1); return false; });
      if (m.length) instance(this.scene, v.t, m, treeLod(v.t));
    }
    this._treesBy = null;
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
        if (onRoad(x, z, -0.5) || this.solidHit(x, z, 1.0, 0.25, rotY, 0.1)) { tops.push(null); continue; }
        this.solidAdd(x, z, 0.25, 0.25, 0, 'pole');
        const broken = this.rng() < 0.12, tilt = broken ? (this.rng() - .5) * 0.5 : (this.rng() - .5) * 0.04;
        const M = trs(x, this.baseY(x, z, 0.2, 0.2), z, rotY, 1, tilt, (this.rng() - .5) * 0.05); mats.push(M);
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
    run(pole, 95.5, -E + 5, 95.5, E - 5, 36, -Math.PI / 2, 1.3);
    run(pole, -200, -119.5, -20, -119.5, 36, 0, 1.3); run(pole, -200, 113.5, -20, 113.5, 36, Math.PI, 1.3);
    run(pole, 92, -115.5, 198, -115.5, 36, 0, 1.3); run(pole, 92, 113.5, 198, 113.5, 36, Math.PI, 1.3);
    run(pole, -E + 5, -190, E - 5, -190, 36, 0, 1.5); run(pole, -E + 5, 190, E - 5, 190, 36, Math.PI, 1.5);
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
      if (this.terrain.cutSDF(x, z) < 3) return;
      const k = Math.floor(this.rng() * list.length), bb0 = list[k].userData.bb ||= new THREE.Box3().setFromObject(list[k]), ex = (bb0.max.x - bb0.min.x) / 2 * s, ez = (bb0.max.z - bb0.min.z) / 2 * s;
      if (navR && this.solidHit(x, z, ex, ez, ry, 0.1)) return;
      if (navR) this.solidAdd(x, z, ex, ez, ry, type);
      (placeList[type + k] ||= { t: list[k], m: [] }).m.push(trs(x, this.tplBaseY(list[k], x, z, ry, s), z, ry, s));
      if (navR) { const bb = list[k].userData.bb ||= new THREE.Box3().setFromObject(list[k]); const sx = (bb.max.x - bb.min.x) / 2 * s, sz = (bb.max.z - bb.min.z) / 2 * s; this.nav.rect(x, z, sx, sz, ry, cost, 0.2); for (let a = 0; a < 1; a++) { const idx = this.nav.idx(x, z); if (idx >= 0) this.nav.low[idx] = 1; } }
    };
    // a handful of shot-up wrecks on the arterials (not a scrapyard on every kerb)
    const arterials = ROADS.filter(r => r.type !== 'drive');
    for (let i = 0; i < 9; i++) {
      const r = arterials[Math.floor(this.rng() * arterials.length)], horiz = (r.x1 - r.x0) > (r.z1 - r.z0);
      const t = this.rng(); const side = this.rng() < 0.5;
      const x = horiz ? r.x0 + t * (r.x1 - r.x0) : (side ? r.x0 + 1.4 : r.x1 - 1.4);
      const z = horiz ? (side ? r.z0 + 1.4 : r.z1 - 1.4) : r.z0 + t * (r.z1 - r.z0);
      if (Math.abs(x) > BOUNDS || Math.abs(z) > BOUNDS) continue;
      put('car', x, z, (horiz ? Math.PI / 2 : 0) + (this.rng() - .5) * 0.5 + (this.rng() < .5 ? Math.PI : 0), 1, 1, BLOCK);
    }
    const free = (x, z, r) => !onRoad(x, z, r) && Math.abs(x) < BOUNDS - r && Math.abs(z) < BOUNDS - r && !this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + r && Math.abs(lz) < b.D / 2 + r; }) && [0, 1, 2, 3, 4, 5, 6, 7].every(a => { const i = this.nav.idx(x + Math.cos(a * 0.785) * r, z + Math.sin(a * 0.785) * r); return i >= 0 && this.nav.cost[i] < 5; });
    // courtyard = the entrance side of a block, ~14 m out
    const yards = [];
    for (const b of this.buildings) { if (b.kind === 'school' || b.kind === 'shop' || b.kind === 'tower') continue; for (const f of [-0.25, 0.25]) { const p = b.toWorld(f * b.L, 0, -b.D / 2 - 15); yards.push([p.x, p.z, b.rot]); } }
    const takeYard = (r) => { for (let i = 0; i < 40 && yards.length; i++) { const j = Math.floor(this.rng() * yards.length), [x, z, rot] = yards[j]; yards.splice(j, 1); if (free(x, z, r)) return [x, z, rot]; } return null; };
    if (!this.assets.gltf.modern) put('bus', 72, 3, 0.25, 1, 1, BLOCK);
    const modern = !!this.assets.gltf.modern;
    if (!modern && free(100, -16.5, 1)) put('busstop', 100, -16.5, Math.PI, 1, 1, BLOCK);
    // courtyard plan: playgrounds between the five-storey rows, garage cooperatives and dirt yards at the edges
    this.dirtYards = [];
    for (const [x, z, rot] of MAP.yards?.playgrounds || []) { if (free(x, z, 4)) { if (!modern) put('playground', x, z, rot, 1, 1, 6); this.dirtYards.push([x, z, 11, rot]); } }
    for (const [x, z, rot] of MAP.yards?.garages || []) { const dx = Math.cos(rot) * 3.6, dz = -Math.sin(rot) * 3.6; for (let i = 0; i < 6; i++) put('garage', x + dx * (i - 2.5), z + dz * (i - 2.5), rot, 1, 1, BLOCK); this.dirtYards.push([x, z, 14, rot]); }
    if (!modern) for (let i = 0; i < 45; i++) { const x = (this.rng() - .5) * (MAP_SIZE - 60), z = (this.rng() - .5) * (MAP_SIZE - 60); const idx = this.nav.idx(x, z); if (idx >= 0 && this.nav.cost[idx] < 5) put('tyre', x, z, this.rng() * 6, 1, 0); }
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
      if (/playground|court|gym|pad|sandbox|swing|carousel|slide|bin|container|waste|bench/i.test(type + (t.name || '')) && footOnRoad(x, z, hx * 0.95, hz * 0.95, ry)) return false;
      if (this.terrain.cutSDF(x, z) < Math.max(hx, hz) + 0.8) return false;
      const ci = this.nav.idx(x, z); if (ci < 0 || this.nav.cost[ci] === BLOCK) return false;
      if (this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + hx + 1 && Math.abs(lz) < b.D / 2 + hz + 1; })) return false;
      const crush = type === 'fenceH' || type === 'bench' || type === 'bin' ? 'any' : type === 'po2' ? 'tank' : null;
      if (this.solidHit(x, z, hx, hz, ry, 0.1, crush ? (k => k === 'fence') : null)) return false;
      this.solidAdd(x, z, hx, hz, ry, crush ? 'fence' : type);
      const M = trs(x, this.tplBaseY(t, x, z, ry, s), z, ry, s);
      if (crush) { (this.crushables ||= []).push({ t, M, x, z, ry, hx, hz, crush, type }); if (cost) this.nav.rect(x, z, hx, hz, ry, crush === 'any' ? Math.min(cost, 3) : cost, 0.15); if (crush === 'tank') this.nav.setVeh(x, z, hx + 0.3, hz + 0.3, ry, 1); return true; }
      (place[type + k] ||= { t, m: [] }).m.push(M);
      if (cost) this.nav.rect(x, z, hx, hz, ry, cost, 0.15);
      return true;
    };
    // private-house sectors (приватний сектор) at the four outer corners, lanes left clear for deployment
    for (const [x0, x1, z0, z1] of [[-252, -150, 206, 252], [150, 252, 206, 252], [-252, -150, -252, -206], [150, 252, -252, -206]]) {
      for (let x = x0 + 10; x < x1 - 6; x += 21) for (let z = z0 + 10; z < z1 - 6; z += 23) {
        if (R() < 0.15) continue;
        const ry = (R() < 0.5 ? 0 : Math.PI) + (R() - .5) * 0.15, hx = x + (R() - .5) * 4, hz = z + (R() - .5) * 4;
        if (!put('house', hx, hz, ry)) continue;
        if (T.fenceH) for (const [fx, fz, fr] of [[hx, hz + 9, 0], [hx - 9.5, hz, Math.PI / 2], [hx + 9.5, hz, Math.PI / 2]]) if (R() < 0.75) put('fenceH', fx, fz, fr + (R() - .5) * 0.06, 5);
        if (R() < 0.3) this.addCrater(hx + (R() - .5) * 12, hz + (R() - .5) * 12, 2 + R() * 3);
      }
    }
    // transformer substations (ТП): one per pair of residential blocks, on the courtyard side at the block end
    // next to the access driveway, squared to the block — as in a planned Soviet microdistrict
    let subN = 0;
    this.buildings.forEach((b, i) => {
      if (!/khrushchyovka|brick|nine/.test(b.kind) || i % 2) return;
      for (const sx of [1, -1]) { const p = b.toWorld(sx * (b.L / 2 + 4.5), 0, -(b.D / 2 + 5)); if (put('sub', p.x, p.z, b.rot + (sx > 0 ? 0 : Math.PI))) { subN++; break; } }
    });
    put('church', -107, 152, 0);
    // market: intact closed pavilions in a neat row (no half-collapsed burnt ones)
    if (T.pav) { const ok = T.pav.filter(t => /closed/i.test(t.name)); if (ok.length) T.pav = ok; }
    for (const [x, z, r] of MAP.yards?.markets || []) put('pav', x, z, r);
    // concrete ПО-2 fences around the school yard and garage rows
    if (T.po2) { for (let x = -86; x < -32; x += 4.0) put('po2', x, 86, 0, 7); }
    for (const [x, z] of [[-60, 78], [-36, 78]]) put('goal', x, z, Math.PI / 2, 6);
    // street furniture
    if (!this.assets.gltf.modern) for (let x = -E + 20; x < E - 20; x += 30) { put('lamp', x + 15, -16.6, 0, 0); put('lamp', x, 16.6, Math.PI, 0); }
    for (const b of this.buildings) for (const e of b.entrances) { if (this.assets.gltf.modern) { if (R() < 0.5) put('bench', e.x + 2.2, e.z, b.rot, 0); continue; } if (R() < 0.6) put('bench', e.x + (R() - .5) * 3, e.z + (R() - .5) * 2, b.rot, 0); if (R() < 0.35) put('bin', e.x + 4 * (R() < .5 ? 1 : -1), e.z, b.rot, 6); if (R() < 0.15) put('laundry', e.x + (R() - .5) * 10, e.z - 8, R() * 3, 0); }
    for (const v of Object.values(place)) instance(this.scene, v.t, v.m);
    this.buildCrushables();
  }
  // 2020s layer on the Soviet plan (modern.glb): renovated retail, boiler houses, garage cooperatives, new playgrounds
  // and street gym, LED lamps, parking bays of modern cars along the driveways, euro-bin pads, checkpoints and
  // anti-drone nets over the arterial approaches, a burnt-out city bus.
  modernDressing() {
    const g = this.assets.gltf.modern; if (!g) return;
    const R = this.rng, place = {};
    const tpl = n => { const o = g.scene.getObjectByName(n); if (o && !o.userData.bb) o.userData.bb = new THREE.Box3().setFromObject(o); return o; };
    const mput = (n, x, z, ry, { cost = BLOCK, road = true, occ = false } = {}) => {
      const t = tpl(n); if (!t) return false; const bb = t.userData.bb, hx = (bb.max.x - bb.min.x) / 2, hz = (bb.max.z - bb.min.z) / 2;
      if (road && footOnRoad(x, z, hx, hz, ry)) return false;   // (the whole footprint off the carriageway and its pavement: the centre test let a playground run 4 m into the road)
      if (this.terrain.cutSDF(x, z) < Math.max(hx, hz) + 0.8) return false;
      if (this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + Math.max(hx, hz) * 0.7 && Math.abs(lz) < b.D / 2 + Math.max(hx, hz) * 0.7; })) return false;
      const fx = /lamp/.test(n) ? 0.3 : hx, fz = /lamp/.test(n) ? 0.3 : hz; // lamps: only the post matters
      if (this.solidHit(x, z, fx, fz, ry, 0.1)) return false;
      this.solidAdd(x, z, fx, fz, ry, n);
      (place[n] ||= { t, m: [] }).m.push(trs(x, /lamp/.test(n) ? this.baseY(x, z, 0.2, 0.2) : this.tplBaseY(t, x, z, ry) + (/playground|court|gym|pad/.test(n) ? 0.03 : 0), z, ry));
      if (cost) this.nav.rect(x, z, hx, hz, ry, cost, 0.15);
      if (occ) this.nav.addOccluder(x, z, hx * 0.95, hz * 0.95, ry, (bb.max.y - bb.min.y) * 0.8, null);
      return true;
    };
    // retail and services at the market crossroads
    // neighbourhood supermarket set back from the avenue behind its own car park (as ATB/Silpo boxes are)
    if (mput('supermarket_damaged', 117, -62, 0, { occ: true })) this.parkingLot(97, -44, 137, -17, mput);
    mput('pharmacy_kiosk', 104, 34, Math.PI); mput('kiosk_modern_burnt', 62, -18, 0, { road: false }); mput('bus_burnt_modern', 64, 4, 0.12, { road: false });
    for (const [x, z, r] of [[100, -15.8, Math.PI], [-60, 15.8, 0], [-150, -15.8, Math.PI], [160, 15.8, 0]]) mput('bus_stop_modern', x, z, r, { road: false, cost: 6 });
    // boiler houses and garage cooperatives at the microdistrict edges
    for (const [x, z, r] of this.mapYards('boilers')) mput(R() < 0.5 ? 'boiler_house_damaged' : 'boiler_house', x, z, r, { occ: true });
    for (const [x, z, r] of this.mapYards('garages')) mput('garage_row', x, z + (r ? -9 : 9), r);
    // new playgrounds + street-workout corners in the courtyards
    // (each tried at its usual spot in the yard first, then nudged round it until the whole footprint is clear of the roads,
    // their pavements and the other pieces; none fits: left out)
    const nudge = (n, x, z, r, offs) => offs.some(([dx, dz]) => mput(n, x + dx, z + dz, r, { cost: 6 }));
    for (const [x, z, r] of this.mapYards('playgrounds')) {
      nudge('playground_modern', x, z, r, [[6, 0], [3, 0], [0, 0], [-3, 0], [0, 3], [0, -3], [-6, 0], [0, 6], [0, -6], [-9, 0]]);
      nudge('outdoor_gym', x, z, r, [[-9, 0], [-12, 0], [9, 0], [12, 0], [0, -9], [0, 9], [-15, 0], [15, 0]]);
    }
    // LED lamps along the arterials, ad columns at the crossroads
    for (let t = -E + 20; t < E - 20; t += 28) { mput('lamp_led', t, -16.2, 0, { road: false, cost: 0 }); mput('lamp_led', t + 14, 16.2, Math.PI, { road: false, cost: 0 }); }
    for (let t = -E + 20; t < E - 20; t += 32) { mput('lamp_led', 74.6, t, Math.PI / 2, { road: false, cost: 0 }); }
    mput('ad_column', 72, -17, 0, { road: false, cost: 5 }); mput('ad_column', 98, 18, 0, { road: false, cost: 5 });
    // parking bays along the courtyard driveways: hatchbacks, crossovers, vans; a few burnt out
    const cars = ['car_hatch_modern', 'car_suv_modern', 'car_hatch_modern', 'car_van'];
    for (const r of ROADS) {
      if (r.type !== 'drive') continue;
      const horiz = (r.x1 - r.x0) > (r.z1 - r.z0), side = R() < 0.5 ? -1 : 1, off = (horiz ? (r.z1 - r.z0) : (r.x1 - r.x0)) / 2 + 2.4;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, a0 = horiz ? r.x0 : r.z0, a1 = horiz ? r.x1 : r.z1;
      for (let t = a0 + 14; t < a1 - 14; t += 2.9) {
        if (R() > 0.55) { t += 6; continue; }
        const burnt = R() < 0.22, n = cars[Math.floor(R() * cars.length)] + (burnt ? '_burnt' : '');
        const x = horiz ? t : cx + side * off, z = horiz ? cz + side * off : t;
        mput(n, x, z, (horiz ? Math.PI / 2 : 0) + (R() - .5) * 0.12 + (R() < 0.5 ? Math.PI : 0), { road: false });
      }
    }
    // euro-bin pads by the block entrances (one per block)
    for (const b of this.buildings) { const e = b.entrances[Math.floor(R() * b.entrances.length)]; if (!e || b.kind === 'tower' && R() < 0.5) continue; const o = b.toWorld(0, 0, 0); const dx = e.x - o.x, dz = e.z - o.z, d = Math.hypot(dx, dz) || 1; mput('waste_pad', e.x + dx / d * 7 + (R() - .5) * 6, e.z + dz / d * 7, b.rot, { cost: 6 }); }
    // wartime: checkpoints on the arterial entries, anti-drone netting over the approaches to the crossroads
    for (const [x, z, r] of [[85, -182, 0], [85, 182, 0], [-190, 0, Math.PI / 2], [190, 0, Math.PI / 2]]) mput('checkpoint_blocks', x, z, r, { road: false, cost: 7 });
    // sandbagged ground-floor windows on the school, kindergartens and the avenue frontage
    const swin = tpl('window_sandbags');
    if (swin) for (const b of this.buildings) {
      if (!(b.kind === 'school' || (b.shops && Math.abs(b.z) < 30))) continue;
      for (const p of b.panels) {
        if (p.floor !== 0 || p.gone || p.entrance || p.shop || /blank/.test(p.type) || R() > 0.55) continue;
        const c = b.panelCenter(p), o = b.outward(p);
        (place.window_sandbags ||= { t: swin, m: [] }).m.push(trs(c.x + o.x * 0.37, 0, c.z + o.z * 0.37, b.rot + p.rot));
        const i = this.nav.idx(c.x + o.x * 0.8, c.z + o.z * 0.8); if (i >= 0) { this.nav.cost[i] = Math.max(this.nav.cost[i], 6); this.nav.low[i] = 1; }
      }
    }
    for (const v of Object.values(place)) instance(this.scene, v.t, v.m);
  }
  mapYards(k) { return MAP.yards?.[k] || []; }
  // asphalt car park with painted bays, a few cars (some burnt), lamps and a barrier at the entry
  parkingLot(x0, z0, x1, z1, mput) {
    const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 7, uv.getY(i) * d / 7);
    const asphalt = this.mat('asphalt', 1, { color: 0xbdb9b0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const lot = new THREE.Mesh(g, asphalt); lot.position.set(cx, 0.045, cz); lot.receiveShadow = true; this.scene.add(lot);
    const line = new THREE.PlaneGeometry(0.12, 5); line.rotateX(-Math.PI / 2);
    const lm = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.9, transparent: true, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -3 });
    const mats = [], R = this.rng, cars = ['car_hatch_modern', 'car_suv_modern', 'car_hatch_modern'];
    for (const row of [z0 + 3, z1 - 3]) for (let x = x0 + 2; x <= x1 - 2; x += 2.7) {
      mats.push(trs(x, 0.055, row, 0));
      if (x < x1 - 4 && R() < 0.4) mput(cars[Math.floor(R() * cars.length)] + (R() < 0.3 ? '_burnt' : ''), x + 1.35, row, Math.PI / 2 + (R() - .5) * 0.1 + (row < cz ? 0 : Math.PI), { road: false });
    }
    instance(this.scene, new THREE.Mesh(line, lm), mats, { shadows: false });
    mput('lamp_led', x0 + 1, cz, 0, { road: false, cost: 0 }); mput('lamp_led', x1 - 1, cz, Math.PI, { road: false, cost: 0 });
    mput('parking_barrier', x0 + 3, z1 - 0.5, 0, { road: false, cost: 0 });
    this.nav.markRoad(x0, z0, x1, z1, 2);
  }
  // Crushable street furniture: own InstancedMeshes (index per item kept) + a spatial grid
  buildCrushables() {
    const items = this.crushables || []; this.crushGrid = new Map();
    const byTpl = new Map(); for (const it of items) if (it.t) (byTpl.get(it.t) || byTpl.set(it.t, []).get(it.t)).push(it);   // (t null: drawn elsewhere -- wire coils, it.wire)
    for (const [t, list] of byTpl) {
      t.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(t.matrixWorld).invert();
      const meshes = [];
      t.traverse(o => { if (!o.isMesh) return; const rel = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld); const im = new THREE.InstancedMesh(o.geometry, o.material, list.length); im.castShadow = im.receiveShadow = true; meshes.push({ im, rel }); this.scene.add(im); });
      list.forEach((it, i) => { it.i = i; it.meshes = meshes; this.setCrushMatrix(it, it.M); });
      for (const { im } of meshes) im.computeBoundingSphere();
    }
    for (const it of items) { const k = Math.floor(it.x / 10) + ',' + Math.floor(it.z / 10); (this.crushGrid.get(k) || this.crushGrid.set(k, []).get(k)).push(it); }
  }
  // (wire coils, battlefieldDetail.js: it.wire flattens the coil in place)
  setCrushMatrix(it, M) { if (it.wire) return it.wire(it); const m = new THREE.Matrix4(); for (const { im, rel } of it.meshes) { im.setMatrixAt(it.i, m.multiplyMatrices(M, rel)); im.instanceMatrix.needsUpdate = true; } }
  // vehicles flatten wooden / thin-metal fences, benches and bins; tanks also topple concrete panels
  crushCheck(v, game) {
    if (!this.crushGrid) return;
    const cx = Math.floor(v.pos.x / 10), cz = Math.floor(v.pos.z / 10);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const list = this.crushGrid.get((cx + i) + ',' + (cz + j)); if (!list) continue;
      for (const it of list) {
        // concrete panels (PO-2 walls): tracked armour shoves them over, wheeled vehicles are stopped (nav veh layer 1)
        if (it.crushed || (it.crush === 'tank' && (v.def.wheeled || v.kind === 'btr'))) continue;
        const dx = v.pos.x - it.x, dz = v.pos.z - it.z, c = Math.cos(it.ry), s = Math.sin(it.ry);
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) > it.hx + v.def.width * 0.45 || Math.abs(lz) > it.hz + v.def.length * 0.45) continue;
        it.crushed = true;
        const side = lz > 0 ? -1 : 1; // falls away from the vehicle
        const fall = new THREE.Matrix4().multiplyMatrices(it.M, new THREE.Matrix4().makeRotationX(side * (1.35 + Math.random() * 0.2)));
        fall.multiply(new THREE.Matrix4().makeScale(1, it.type === 'po2' ? 1 : 0.85, it.type === 'po2' ? 1 : 0.5));
        this.setCrushMatrix(it, fall);
        if (it.wire) continue;   // (the coil's nav is the men-only wire layer: lowered by it.wire)
        this.nav.setRect(it.x, it.z, it.hx, it.hz + 0.2, it.ry, 1, 0);
        if (it.crush === 'tank' && this.nav.veh) { this.nav.clearVeh(it.x, it.z, it.hx + 0.3, it.hz + 0.3, it.ry, 1); const r = Math.max(it.hx, it.hz) + 1; this.nav.refreshArea(it.x - r, it.z - r, it.x + r, it.z + r); }
        if (game) { game.fx.dustCloud(new THREE.Vector3(it.x, 0.3, it.z), Math.max(2, it.hx), 1, 5, [0.6, 0.56, 0.5]); game.sfx(it.type === 'po2' ? 'debris' : Math.random() < 0.5 ? 'impact_metal' : 'debris', new THREE.Vector3(it.x, 0.5, it.z), { gain: 0.8 }); }
      }
    }
  }
  // field fortifications at the objectives (facing north)
  defences() {
    const T = this.propT, placeList = {};
    const put = (type, x, z, ry) => {
      const list = T[type]; if (!list) return; const k = Math.floor(this.rng() * list.length);
      (placeList[type + k] ||= { t: list[k], m: [] }).m.push(trs(x, this.tplBaseY(list[k], x, z, ry), z, ry, 1));
      const bb = list[k].userData.bb ||= new THREE.Box3().setFromObject(list[k]);
      const sx = (bb.max.x - bb.min.x) / 2, sz = (bb.max.z - bb.min.z) / 2;
      this.nav.rect(x, z, sx, sz, ry, type === 'hedgehog' ? BLOCK : 7, 0.1);
    };
    if (!T.sandbag) { const sb = new THREE.Group(); const m = new THREE.MeshStandardMaterial({ color: 0x7c7058, roughness: 1 }); for (let r = 0; r < 3; r++) for (let i = 0; i < 5; i++) { const b = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.4, 3, 8), m); b.rotation.z = Math.PI / 2; b.scale.set(1, 1, 0.75); b.position.set(-1.2 + i * 0.6 + (r % 2) * 0.3, 0.15 + r * 0.26, 0); sb.add(b); } sb.traverse(o => o.isMesh && (o.castShadow = true)); T.sandbag = [sb]; }
    // School: sandbagged positions along the avenue side and the gap between wings
    // Crossroads: barricade of hedgehogs across the intersection mouths + sandbag nests at corners
    for (let x = 80; x <= 90; x += 2.6) put('hedgehog', x, -14, this.rng() * 3);
    for (let z = -6; z <= 6; z += 2.6) put('hedgehog', 70, z, this.rng() * 3);
    for (const v of Object.values(placeList)) instance(this.scene, v.t, v.m);
    // concertina wire belts in front of both objectives
    const C = this.wireT?.concertina?.[0];
    const coil = C || (() => { const pts = []; for (let i = 0; i < 240; i++) { const a = i * 0.45; pts.push(new THREE.Vector3(Math.cos(a) * 0.45, 0.45 + Math.sin(a) * 0.45, i / 240 * 5 - 2.5)); } const g = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 480, 0.008, 3), new THREE.MeshStandardMaterial({ color: 0x6d6a64, metalness: 0.8, roughness: 0.4 })); const grp = new THREE.Group(); g.rotation.y = Math.PI / 2; grp.add(g); return grp; })();
    const bb = new THREE.Box3().setFromObject(coil); const len = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z); const alongX = (bb.max.x - bb.min.x) >= (bb.max.z - bb.min.z);
    const m = [];
    const belt = (x0, z0, x1, z1) => { const d = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(d / len), ang = Math.atan2(x1 - x0, z1 - z0) + (alongX ? -Math.PI / 2 : 0); for (let i = 0; i < n; i++) { const f = (i + 0.5) / n; const x = x0 + (x1 - x0) * f, z = z0 + (z1 - z0) * f; m.push(trs(x, 0, z, ang)); this.nav.circle(x, z, 0.9, 5); } };
    // (no concertina wire in the district)
  }
  // knocked-out armour pushed onto the verges / courtyard edges (static, charred; never on the carriageway, so the
  // street network stays open for vehicles)
  cityWrecks() {
    const WT = wreckTemplates(this.assets, ['t72b3', 'bmp3', 'btr82a', 'btr80_ua', 't72av_ua']), keys = Object.keys(WT); if (!keys.length) return;
    const R = this.rng, by = new Map(), roads = ROADS.filter(r => r.type !== 'drive'); this.wreckSpots = [];
    const free = (x, z, ry) => { const c = Math.cos(ry), s = Math.sin(ry); for (const [a, b] of [[0, 0], [1.9, 3.9], [-1.9, 3.9], [1.9, -3.9], [-1.9, -3.9], [0, 4.5], [0, -4.5]]) { const px = x + a * c + b * s, pz = z - a * s + b * c, i = this.nav.idx(px, pz); if (i < 0 || this.nav.cost[i] !== 1 || onRoad(px, pz, 0.6)) return false; } return true; };
    for (let n = 0, tries = 0; n < 6 && tries < 400; tries++) {
      const r = roads[Math.floor(R() * roads.length)], horiz = (r.x1 - r.x0) > (r.z1 - r.z0), t = 0.1 + R() * 0.8, sd = R() < 0.5 ? -1 : 1, off = SIDEWALK + 3.2 + R() * 3;
      const x = horiz ? r.x0 + t * (r.x1 - r.x0) : (sd < 0 ? r.x0 - off : r.x1 + off), z = horiz ? (sd < 0 ? r.z0 - off : r.z1 + off) : r.z0 + t * (r.z1 - r.z0);
      const ry = (horiz ? Math.PI / 2 : 0) + (R() - .5) * 0.7 + (R() < 0.5 ? Math.PI : 0);
      if (Math.abs(x) > MAP_SIZE / 2 - 20 || Math.abs(z) > MAP_SIZE / 2 - 20 || this.buildingAt(x, z, 5) || this.terrain.cutSDF(x, z) < 7 || this.solidHit(x, z, 1.9, 3.9, ry, 0.4) || !free(x, z, ry)) continue;
      if (this.wreckSpots.some(([a, b]) => Math.hypot(a - x, b - z) < 60) || OBJECTIVES.some(o => Math.hypot(o.x - x, o.z - z) < 12)) continue;
      const k = keys[n % keys.length], M = this.restM(x, z, ry, 1.6, 3.4);
      (by.get(k + 'h') || by.set(k + 'h', { g: WT[k].hull, m: [] }).get(k + 'h')).m.push(M);
      if (WT[k].turret) (by.get(k + 't') || by.set(k + 't', { g: WT[k].turret, m: [] }).get(k + 't')).m.push(M.clone().multiply(new THREE.Matrix4().makeRotationY((R() - .5) * 2)));
      this.nav.rect(x, z, 1.75, 3.7, ry, BLOCK, 0.2); this.solidAdd(x, z, 1.75, 3.7, ry, 'wreck'); this.nav.addOccluder(x, z, 1.6, 3.4, ry, 2.2, null);
      this.wreckSpots.push([x, z]); n++;
    }
    for (const [, v] of by) instance(this.scene, v.g, v.m, { cullDist: 420 });
  }
  craters() {
    const T = this.propT?.crater;
    this.craterCap = MAP.kind === 'rural' ? 1400 : 400; this.craterMesh = craterMesh(this.scene, this.assets.tex.crater, craterTexture(), this.craterCap, 0xc2b8a8);
    for (const c of this.pendingCraters || []) this.addCrater(...c); this.pendingCraters = null;
    for (let i = 0; i < 120; i++) { const x = (this.rng() - .5) * (MAP_SIZE - 40), z = (this.rng() - .5) * (MAP_SIZE - 40), sz = 2 + this.rng() * 4; if (this.terrain.cutSDF(x, z) < sz + 2) continue; this.addCrater(x, z, sz); }
    if (T) { const m = []; for (let i = 0; i < 18; i++) { const x = (this.rng() - .5) * (MAP_SIZE - 60), z = (this.rng() - .5) * (MAP_SIZE - 60); const idx = this.nav.idx(x, z); if (idx >= 0 && this.nav.cost[idx] < 5 && !onRoad(x, z, 4)) m.push(trs(x, this.tplBaseY(T[0], x, z), z, this.rng() * 6)); } instance(this.scene, T[0], m); }
  }
  addCrater(x, z, size, cell = null) {
    if (!this.craterMesh) { (this.pendingCraters ||= []).push([x, z, size, cell]); return; }
    if (this.terrain && this.terrain.cutSDF(x, z) < size * 0.68 + 0.3) return; // decal (radius ~0.63 size) would hang over a trench
    const c = this.craterMesh; if (c.count >= this.craterCap) return;
    // the decal is a flat card: on uneven ground (crater bowl / rim, parapet, rubble, balka slope) it would hang in the air
    // or be swallowed -- lift it to the highest point under it, skip it where the ground is too uneven
    let y0 = 0;
    if (this.terrain) {
      const r = size * (c.userData.atlas ? 1.25 : 1) * 0.42; let lo = 1e9, hi = -1e9;
      for (let k = 0; k < 25; k++) { const a = k * 0.3927, rr = k === 24 ? 0 : k < 16 ? r : r * 0.5, h = this.terrain.heightAt(x + Math.cos(a) * rr, z + Math.sin(a) * rr); lo = Math.min(lo, h); hi = Math.max(hi, h); }
      if (hi - lo > 0.12) return;
      y0 = hi;
    }
    // atlas cell: 0 fresh big, 1 old (water), 2 small / mortar splash, 3 field crater (rural)
    const r = Math.random(), rural = MAP.kind === 'rural';
    if (cell == null) cell = size < 3.2 ? (r < 0.75 ? 2 : rural ? 3 : 0) : size > 7 ? (r < 0.45 ? 0 : rural ? 3 : 1) : (r < 0.3 ? 0 : r < 0.6 ? 1 : rural ? 3 : 2);
    const i = c.count++;
    c.setMatrixAt(i, trs(x, y0 + 0.06 + (i % 64) * 0.0005, z, Math.random() * 6.28, size * (c.userData.atlas ? 1.25 : 1))); c.instanceMatrix.needsUpdate = true;
    const ac = c.geometry.attributes.aCell; ac.setX(i, cell); ac.needsUpdate = true;
  }
  // distant city silhouette beyond the playable area
  // The city carries on past the playable area: more microdistricts as cheap facade-shaded blocks (panel joints,
  // window grid, balcony bands, flat roofs; a few burnt-out windows), the arterials continue, tree belts in between.
  skyline() {
    const half = MAP_SIZE / 2, R = this.rng, mats = [], cols = [], boxes = [];
    const clearOf = (x, z, hx, hz) => Math.abs(z) > hz + 22 && Math.abs(x - 85) > hx + 18 && Math.abs(x + 204) > hx + 14 && Math.abs(x - 202) > hx + 14 && Math.abs(z - 197) > hz + 12 && Math.abs(z + 197) > hz + 12;
    for (let gx = -760; gx < 760; gx += 120) for (let gz = -760; gz < 760; gz += 120) {
      const cx = gx + 60, cz = gz + 60;
      if (Math.max(Math.abs(cx), Math.abs(cz)) < half + 50) continue;
      const rows = 2 + Math.floor(R() * 2), along = R() < 0.5;
      for (let i = 0; i < rows; i++) {
        const tall = R() < 0.35, tower = R() < 0.12;
        const L = tower ? 19 : 38 + Math.floor(R() * 4) * 9.6, D = tower ? 19 : 12.8, H = tower ? 2.8 * (12 + Math.floor(R() * 5)) : 2.8 * (tall ? 9 : 5) + 0.6;
        const off = (i - (rows - 1) / 2) * 38 + (R() - .5) * 6;
        const x = cx + (along ? (R() - .5) * 20 : off), z = cz + (along ? off : (R() - .5) * 20);
        const [hx, hz] = along ? [L / 2, D / 2] : [D / 2, L / 2];
        if (Math.max(Math.abs(x) - hx, Math.abs(z) - hz) < half + 12 || !clearOf(x, z, hx, hz)) continue;
        mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), along ? 0 : Math.PI / 2), new THREE.Vector3(L, H, D)));
        cols.push(new THREE.Color().setHSL(0.09 + R() * 0.05, 0.06 + R() * 0.12, 0.5 + R() * 0.14));
        boxes.push([x, z, hx, hz]);
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
    m.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFP; varying vec3 vFN;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n#ifdef USE_INSTANCING\n vec3 isc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));\n vFP = position * isc; vFN = normal;\n#endif');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vFP; varying vec3 vFN;
        float fh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec3 an = abs(vFN);
          if (an.y > 0.5) { diffuseColor.rgb *= 0.32; }
          else {
            float u = an.x > 0.5 ? vFP.z : vFP.x, v = vFP.y;
            vec2 cell = vec2(floor(u / 3.2), floor(v / 2.8)); vec2 f = vec2(fract(u / 3.2), fract(v / 2.8));
            float joint = 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.025, f.x) * smoothstep(1.0, 0.975, f.x) * smoothstep(0.0, 0.03, f.y) * smoothstep(1.0, 0.97, f.y));
            float win = step(0.26, f.x) * step(f.x, 0.74) * step(0.31, f.y) * step(f.y, 0.82);
            float band = step(0.82, f.y) * step(mod(cell.y, 1.0), 0.5) * step(0.5, fh(vec2(floor(vFP.x * 0.01 + vFP.z * 0.013), 3.0)));
            float burnt = step(0.965, fh(cell + floor(vFP.xz * 0.02)));
            vec3 c = diffuseColor.rgb * joint;
            c = mix(c, vec3(0.42, 0.5, 0.56) * diffuseColor.rgb, band * 0.6);
            c = mix(c, mix(vec3(0.07, 0.075, 0.08), vec3(0.16, 0.17, 0.19), fh(cell * 1.7)), win);
            c = mix(c, vec3(0.03, 0.028, 0.025), burnt * smoothstep(0.1, 0.5, 1.0 - abs(f.x - 0.5) * 1.6));
            diffuseColor.rgb = c * (v < 0.6 ? 0.8 : 1.0);
          }`);
    };
    const im = new THREE.InstancedMesh(box, m, mats.length); mats.forEach((M, i) => { im.setMatrixAt(i, M); im.setColorAt(i, cols[i]); });
    im.castShadow = false; im.receiveShadow = true; this.scene.add(im);
    // arterials continue out of the district
    const asphalt = this.mat('asphalt', 1, { color: 0xd0ccc4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const ext = (cx, cz, w, d) => { const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 7, uv.getY(i) * d / 7); const a = new THREE.Mesh(g, asphalt); a.position.set(cx, 0.05, cz); a.receiveShadow = true; this.scene.add(a); };
    for (const sgn of [-1, 1]) {
      ext(sgn * (half + 2 + 240), 0, 480, 20); ext(85, sgn * (half + 2 + 240), 14, 480);
      ext(-204, sgn * (half + 2 + 240), 8, 480); ext(202, sgn * (half + 2 + 240), 8, 480);
      ext(sgn * (half + 2 + 240), -197, 480, 8); ext(sgn * (half + 2 + 240), 197, 480, 8);
    }
    // tree belts between the outer blocks (cheap leafy lumps; fog does the rest)
    const tm = new THREE.MeshStandardMaterial({ color: 0x3c4527, roughness: 1, flatShading: true }), tg = new THREE.IcosahedronGeometry(1, 1); tg.translate(0, 0.85, 0);
    const tmats = [];
    for (let i = 0; i < 900; i++) {
      const x = (R() - .5) * 1500, z = (R() - .5) * 1500; if (Math.max(Math.abs(x), Math.abs(z)) < half + 15) continue;
      if (boxes.some(([bx, bz, hx, hz]) => Math.abs(x - bx) < hx + 4 && Math.abs(z - bz) < hz + 4) || Math.abs(z) < 16 || Math.abs(x - 85) < 12) continue;
      const s = 3 + R() * 2.5; tmats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(s, s * (1.1 + R() * 0.4), s)));
    }
    const ti = new THREE.InstancedMesh(tg, tm, tmats.length); tmats.forEach((M, i) => ti.setMatrixAt(i, M)); ti.castShadow = false; this.scene.add(ti);
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
      if (p.acc && p.acc.slot >= 0) this.pool.remove(p.balcony ? (p.balPiece || 'balcony_slab') : 'entrance_canopy', p.acc);
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
      if (pile) { const m = pile.clone(); m.position.set(p.x, -4, p.z); m.rotation.y = b.rot + (Math.random() < .5 ? 0 : Math.PI); m.userData.rise = 4; m.scale.setScalar(Math.min(1.2, b.floors / 6 + 0.4)); this.dynamic.add(m); this.terrain.stamp(pile, trs(p.x, 0, p.z, m.rotation.y, m.scale.x)); }
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
        // the cross wall left standing beside a collapsed section: intact-ish below, torn only at the top storey
        const r = Math.random(), name = f === b.floors - 1 ? 'wall_blank_end_destroyed' : r < 0.25 ? 'wall_blank_end_holed' : 'wall_blank_end_damaged';
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
    const T = this._fallTmp ||= { pos: new THREE.Vector3(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(), sc: new THREE.Vector3(), e: new THREE.Euler() }, { pos, q, sc, e } = T;
    for (const f of this.falling) {
      f.t += dt; if (f.t < 0) continue;
      f.v += 9.8 * dt;
      f.m.decompose(pos, q, sc); pos.y -= f.v * dt; pos.addScaledVector(f.out, dt * 0.8);
      e.set(f.rx * dt, 0, f.rz * dt); q.multiply(T.q2.setFromEuler(e));
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

// Axis-aligned road surfaces without overlap: rectangle r minus the rectangles in `cuts` (grid split on the cutters'
// edges, uncovered cells merged along x per z band, then equal x runs merged down z) -> list of {x0, x1, z0, z1}.
// Coplanar overlapping road / pavement planes z-fight at every junction (their edge wear differs), so each surface is
// drawn once: the lower-priority road is cut where a higher-priority one crosses it.
export function rectMinus(r, cuts) {
  const cs = cuts.filter(c => c.x0 < r.x1 - 1e-6 && c.x1 > r.x0 + 1e-6 && c.z0 < r.z1 - 1e-6 && c.z1 > r.z0 + 1e-6);
  if (!cs.length) return [{ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 }];
  const xs = new Set([r.x0, r.x1]), zs = new Set([r.z0, r.z1]);
  for (const c of cs) { for (const x of [c.x0, c.x1]) if (x > r.x0 && x < r.x1) xs.add(x); for (const z of [c.z0, c.z1]) if (z > r.z0 && z < r.z1) zs.add(z); }
  const X = [...xs].sort((a, b) => a - b), Z = [...zs].sort((a, b) => a - b), bands = [];
  for (let j = 0; j < Z.length - 1; j++) {
    const zm = (Z[j] + Z[j + 1]) / 2, runs = []; let a = null;
    for (let i = 0; i < X.length - 1; i++) {
      const xm = (X[i] + X[i + 1]) / 2, cov = cs.some(c => xm > c.x0 && xm < c.x1 && zm > c.z0 && zm < c.z1);
      if (!cov && a === null) a = X[i]; if (cov && a !== null) { runs.push([a, X[i]]); a = null; }
    }
    if (a !== null) runs.push([a, X[X.length - 1]]);
    bands.push(runs.map(([x0, x1]) => ({ x0, x1, z0: Z[j], z1: Z[j + 1] })));
  }
  const out = [];
  for (const band of bands) for (const q of band) { const p = out.find(o => o.z1 === q.z0 && o.x0 === q.x0 && o.x1 === q.x1); if (p) p.z1 = q.z1; else out.push(q); }
  return out;
}
// one plane geometry for a set of rectangles of road rd (positions relative to the road centre, UVs continuous in world
// space exactly like a single uvPlane(w, d, scale) of the whole road would have them)
export function roadPieces(rd, pieces, scale, segLen = 0) {
  const cx = (rd.x0 + rd.x1) / 2, cz = (rd.z0 + rd.z1) / 2, gs = [];
  for (const q of pieces) {
    const w = q.x1 - q.x0, d = q.z1 - q.z0; if (w < 0.01 || d < 0.01) continue;
    const g = new THREE.PlaneGeometry(w, d, segLen ? Math.max(1, Math.ceil(w / segLen)) : 1, segLen ? Math.max(1, Math.ceil(d / segLen)) : 1); g.rotateX(-Math.PI / 2); g.translate((q.x0 + q.x1) / 2 - cx, 0, (q.z0 + q.z1) / 2 - cz);
    const pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + cx - rd.x0) / scale, (rd.z1 - (pos.getZ(i) + cz)) / scale);
    gs.push(g);
  }
  return gs.length ? (gs.length === 1 ? gs[0] : mergeGeometries(gs)) : null;
}
export function catenary(a, b, sag) {
  const pts = []; for (let i = 0; i <= 10; i++) { const t = i / 10; const p = a.clone().lerp(b, t); p.y -= sag * 4 * t * (1 - t); pts.push(p); } return pts;
}
function decalTexture(kind) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); const r = Math.random;
  if (kind === 'soot') { // plume rising from a window head: dense at the bottom, feathering up
    for (let i = 0; i < 70; i++) { const px = 64 + (r() - .5) * 70 * (0.4 + i / 70), py = 128 - Math.pow(r(), 0.8) * 120, rr = 10 + r() * 22; const g = x.createRadialGradient(px, py, 0, px, py, rr); const a = 0.10 + 0.25 * (py / 128); g.addColorStop(0, `rgba(14,12,10,${a})`); g.addColorStop(1, 'rgba(14,12,10,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128); }
  } else if (kind === 'pocks') { // shrapnel/bullet pocks: dark core, pale chipped rim
    for (let i = 0; i < 60; i++) { const px = 64 + (r() - .5) * 116 * Math.sqrt(r()), py = 64 + (r() - .5) * 116 * Math.sqrt(r()), rr = 0.6 + Math.pow(r(), 2) * 2.6;
      x.fillStyle = `rgba(190,184,172,${0.18 + r() * 0.15})`; x.beginPath(); for (let k = 0; k <= 7; k++) { const a = k / 7 * 6.28, q = rr * (1.3 + r() * 0.6); k ? x.lineTo(px + Math.cos(a) * q, py + Math.sin(a) * q) : x.moveTo(px + Math.cos(a) * q, py + Math.sin(a) * q); } x.fill();
      x.fillStyle = `rgba(38,35,31,${0.55 + r() * 0.3})`; x.beginPath(); x.arc(px + 0.3, py + 0.3, rr * 0.8, 0, 7); x.fill(); }
  } else if (kind === 'scorch') { // shell strike on a blank wall: blast star + soot
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 62); g.addColorStop(0, 'rgba(10,9,8,0.75)'); g.addColorStop(0.5, 'rgba(25,22,19,0.45)'); g.addColorStop(1, 'rgba(25,22,19,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 30; i++) { const a = r() * 6.28; x.strokeStyle = `rgba(15,13,11,${0.2 + r() * 0.3})`; x.lineWidth = 1 + r() * 2.5; x.beginPath(); x.moveTo(64 + Math.cos(a) * 12, 64 + Math.sin(a) * 12); x.lineTo(64 + Math.cos(a) * (35 + r() * 28), 64 + Math.sin(a) * (35 + r() * 28)); x.stroke(); }
  } else { // rust / water streaks running down from a joint
    for (let i = 0; i < 8; i++) { const px = 20 + r() * 88; const g = x.createLinearGradient(0, 0, 0, 128); g.addColorStop(0, 'rgba(70,52,36,0)'); g.addColorStop(0.1, 'rgba(70,52,36,0.35)'); g.addColorStop(1, 'rgba(70,52,36,0)'); x.fillStyle = g; x.fillRect(px, 0, 2 + r() * 5, 128); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
export function craterTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  // ejecta speckle on the rim first, then the scorched bowl
  for (let i = 0; i < 900; i++) { const a = Math.random() * 6.28, r = 45 + Math.pow(Math.random(), 0.6) * 80; const v = 40 + Math.random() * 60; x.fillStyle = `rgba(${v + 15},${v + 8},${v},${0.15 + Math.random() * 0.45})`; x.beginPath(); x.arc(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, 0.6 + Math.random() * 2.6, 0, 7); x.fill(); }
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 70);
  g.addColorStop(0, 'rgba(14,12,10,0.85)'); g.addColorStop(0.5, 'rgba(32,27,22,0.75)'); g.addColorStop(0.85, 'rgba(58,50,42,0.35)'); g.addColorStop(1, 'rgba(58,50,42,0)');
  x.fillStyle = g; x.beginPath();
  for (let i = 0; i <= 40; i++) { const a = i / 40 * 6.28, r = 62 + (Math.random() - .5) * 18; i ? x.lineTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r) : x.moveTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r); }
  x.fill();
  for (let i = 0; i < 26; i++) { const a = Math.random() * 6.28; x.strokeStyle = `rgba(20,17,14,${0.15 + Math.random() * 0.25})`; x.lineWidth = 1 + Math.random() * 3; x.beginPath(); x.moveTo(128 + Math.cos(a) * 50, 128 + Math.sin(a) * 50); x.lineTo(128 + Math.cos(a) * (80 + Math.random() * 40), 128 + Math.sin(a) * (80 + Math.random() * 40)); x.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function blackTex() { const t = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat); t.needsUpdate = true; return t; }
// procedural stand-ins for fortifications.glb pieces (same conventions, see tools/blender/env/build_fortifications.py)
const _fm = {};
function fm(c) { return (_fm[c] ||= new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 })); }
function fbox(g, w, h, d, c, x, y, z) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), fm(c)); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; g.add(m); }
function fortFallback(name) {
  const g = new THREE.Group();
  const panel = { rv_pallet: [1.2, 1.2, 0x8a7a62], rv_sheet: [0.95, 1.8, 0x7a6a5a], rv_ply: [1.22, 1.25, 0x9a8462], rv_door: [0.84, 2.0, 0x8a9aa0], rv_branches: [1.3, 1.3, 0x5a4a32], rv_logs: [1.6, 1.0, 0x5a4a3a], rv_mesh: [1.5, 1.5, 0x77756f] }[name];
  if (panel) fbox(g, panel[0], panel[1], 0.05, panel[2], 0, panel[1] / 2, -0.03);
  else if (name === 'floor_pallet') fbox(g, 1.2, 0.14, 0.8, 0x7e6e56, 0, 0.07, 0);
  else if (name === 'floor_planks') fbox(g, 1.8, 0.04, 0.5, 0x6e604c, 0, 0.02, 0);
  else if (name === 'sandbag_row') fbox(g, 1.3, 0.3, 0.42, 0x8a7d5e, 0, 0.15, 0);
  else if (name === 'sandbag_pile') fbox(g, 1.0, 0.35, 0.7, 0x857858, 0, 0.17, 0);
  else if (name === 'debris_conc') fbox(g, 0.9, 0.25, 0.6, 0x8f8b84, 0, 0.12, 0);
  else if (/^litter/.test(name)) fbox(g, 0.4, 0.15, 0.3, name === 'litter_a' ? 0x4c5236 : 0x9a8a6a, 0, 0.07, 0);
  else if (name === 'net_cover' || name === 'net_drone') fbox(g, 3.0, 0.04, 2.6, 0x4d5236, 0, 0.05, 0);
  else if (name === 'branch_cover') fbox(g, 2.4, 0.15, 2.4, 0x55603a, 0, 0.08, 0);
  else if (name === 'tarp_cover') fbox(g, 2.0, 0.03, 2.2, 0x4a5038, 0, 0.04, 0);
  else if (/^dugout_roof/.test(name)) { fbox(g, 4.6, 0.45, 4.8, 0x4f4636, 0, 0.22, 0); fbox(g, 1.6, 1.9, 0.2, 0x4b3d2e, 0, -0.85, 2.45); }
  else if (name === 'mg_nest_roof') fbox(g, 2.3, 0.3, 2.1, 0x4b3d2e, 0, 0.55, -0.1);
  else if (name === 'dragon_tooth_rubble') { fbox(g, 0.9, 0.35, 0.9, 0x8f8a80, 0, 0.15, 0); for (const [x, z, w] of [[1.1, 0.3, 0.4], [-0.8, 0.9, 0.3], [0.2, -1.2, 0.35], [-1.2, -0.5, 0.25]]) fbox(g, w, w * 0.6, w * 0.8, 0x8f8a80, x, w * 0.25, z); }
  else if (/^dragon_tooth/.test(name)) { const m = new THREE.Mesh(new THREE.ConeGeometry(0.85, 1.0, 4), fm(0x9a958a)); m.position.y = 0.5; m.rotation.y = Math.PI / 4; m.castShadow = m.receiveShadow = true; g.add(m); }
  else if (name === 'ammo_crates') fbox(g, 0.66, 0.3, 0.36, 0x4c5236, 0, 0.15, 0);
  else return null;
  return g;
}
// Raw trench-wall soil (tiles every 1.4 m along the wall / in depth; y up = towards the lip): crumbly chernozem
// clods and crumbs, pale root threads and dark root channels, pebbles and chalky loess flecks, vertical spade cuts.
let _twTex = null;
function trenchWallTexture() {
  if (_twTex) return _twTex;
  const N = 512, c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d');
  let s = 917; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  x.fillStyle = '#5c4e40'; x.fillRect(0, 0, N, N);
  const wrap = (f) => { for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) { x.save(); x.translate(dx, dy); f(); x.restore(); } };
  // clods: overlapping irregular blobs of browns, dark and light
  for (let i = 0; i < 2600; i++) {
    const px = r() * N, py = r() * N, rad = 2 + r() * r() * 16, l = 0.55 + r() * 0.75, cr = Math.round(92 * l), cg = Math.round(76 * l), cb = Math.round(62 * l);
    x.fillStyle = `rgba(${cr},${cg},${cb},${0.35 + r() * 0.5})`;
    const ang = r() * 6.28, ell = 0.5 + r() * 0.6;
    wrap(() => { x.beginPath(); x.ellipse(px, py, rad, rad * ell, ang, 0, 6.29); x.fill(); });
  }
  // crumbs and shadows under clods
  for (let i = 0; i < 9000; i++) { const px = r() * N, py = r() * N, d = r() < 0.5; x.fillStyle = d ? `rgba(28,22,17,${0.25 + r() * 0.4})` : `rgba(150,128,104,${0.15 + r() * 0.3})`; x.fillRect(px, py, 1 + r() * 2, 1 + r() * 2); }
  // vertical spade cuts (shovel marks on the face): faint darker / lighter strokes in groups
  for (let i = 0; i < 46; i++) {
    const px = r() * N, py = r() * N, h = 40 + r() * 110, w = 6 + r() * 10;
    const gr = x.createLinearGradient(px - w, 0, px + w, 0); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.45, 'rgba(25,19,14,0.22)'); gr.addColorStop(0.55, 'rgba(160,138,112,0.16)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gr; wrap(() => x.fillRect(px - w, py, w * 2, h));
  }
  // roots: pale fine threads and darker thicker ones, mostly hanging down from the top
  for (let i = 0; i < 70; i++) {
    let px = r() * N, py = r() * N; const thick = r() < 0.25, len = 30 + r() * 140;
    x.strokeStyle = thick ? `rgba(48,36,26,${0.6 + r() * 0.3})` : `rgba(196,176,140,${0.45 + r() * 0.4})`; x.lineWidth = thick ? 2 + r() * 2.5 : 0.7 + r() * 0.9; x.lineCap = 'round';
    const pts = [[px, py]]; let a = Math.PI / 2 + (r() - 0.5) * 1.6; for (let k = 0; k < 8; k++) { a += (r() - 0.5) * 0.8; px += Math.cos(a) * len / 8; py += Math.sin(a) * len / 8; pts.push([px, py]); }
    wrap(() => { x.beginPath(); x.moveTo(...pts[0]); for (const p of pts.slice(1)) x.lineTo(...p); x.stroke(); });
  }
  // pebbles / chalky loess flecks
  for (let i = 0; i < 260; i++) { const px = r() * N, py = r() * N, rad = 1 + r() * 4, l = 120 + r() * 80; x.fillStyle = `rgb(${l},${l * 0.94 | 0},${l * 0.86 | 0})`; wrap(() => { x.beginPath(); x.ellipse(px, py, rad, rad * (0.6 + r() * 0.4), r() * 6, 0, 6.29); x.fill(); }); x.fillStyle = 'rgba(20,15,10,0.5)'; wrap(() => { x.beginPath(); x.ellipse(px + 1, py + rad * 0.8, rad, rad * 0.35, 0, 0, 6.29); x.fill(); }); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; t.needsUpdate = true;
  return (_twTex = t);
}
