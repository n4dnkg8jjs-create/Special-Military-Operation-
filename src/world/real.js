// Real-place battle maps: worlds built from OpenStreetMap layouts (src/world/real/<id>_osm.js, converted by
// tools/maps_real/osm2map.py).  Map data (c) OpenStreetMap contributors, ODbL 1.0 -- https://www.openstreetmap.org/copyright
//
// maps.js entries with `real: '<id>'` are built here instead of from the hand-made grid layouts:
//   RealRural  (kind 'rural', extends Farmland)  Robotyne: village streets with house plots, fields, tree belts, balkas
//   RealUrban  (kind 'urban', extends City)      Avdiivka: panel blocks, private sector, garages, rail, industry
// City / Farmland construction is redirected to these classes (city.js REAL_WORLDS), so game code is unchanged; the whole
// gameplay contract (trenchSystems, damageFortAt, groundHeight, trenchInfo, buildings, nav, concealAt) is the base
// classes' own.  What is new here is generator support for arbitrary layouts:
//   - a polyline road network (any angle; onRoad() goes through RoadNet via city.js setRoadTest), rendered as mitred
//     ribbons per surface (asphalt with the war wear shader, gravel / dirt tracks with ruts, pavements and kerbs)
//   - real footprints -> kit panel blocks (L / U shapes as several blocks, storeys from OSM), schools, civic buildings;
//     village houses -> house templates fitted to the footprint, destroyed / burnt per the map's damage profile
//   - irregular house plots (OSM houses + the plots osm2map.py inferred along the mapped streets): street fences and
//     gates, outbuildings, gardens, fruit trees, yard concealment
//   - procedural industrial halls / barns (merged, a few draw calls for all of them), garage rows, rail track
//     (ballast, sleepers, rails), platforms, gas pipes, power lines, tree rows, woods, balkas along streams
//   - fields from the OSM farmland polygons (crop / stubble / ploughed / fallow, row direction along the field)
import * as THREE from 'three';
import { City, MAP, MAP_SIZE, REAL_WORLDS, setRoadTest, onRoad, mulberry, catenary } from './city.js';
import { Farmland, fieldRuts } from './farmland.js';
import { BLOCK } from './nav.js';
import { instance, trs, LODS, treeLod } from './instancer.js';
import { setKitCell } from './buildings.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { roadWear, trackWear, paintWar, wreckTemplates, weatherEnv } from './wear.js';
import { battlefieldDetail } from './battlefieldDetail.js';
import { MAPS } from './maps.js';
import ROBOTYNE from './real/robotyne_osm.js';
import AVDIIVKA from './real/avdiivka_osm.js';

export const REAL_DATA = { robotyne: ROBOTYNE, avdiivka: AVDIIVKA };
// OSM tracks / service roads that stop in the open (the mapper stopped, or the way was clipped oddly) would read in the
// game as a road running into a field and ending.  Every track / drive / gravel end must join another road, reach a
// building / yard (farmyard, garage, plot), or run off the map edge:
//   - an end within 40 m of another road is carried on to it (snapped to the nearest centre-line point)
//   - an end in the open is carried on in its own direction to the map edge when that is under 360 m and passes no
//     building / plot (the field track continues off the map); otherwise the stub is cut back to its last junction
// Runs once per layout at load (idempotent); D.roadFix lists what was changed (QA).
function cleanRoads(D) {
  if (D.roadFix) return;
  const fix = D.roadFix = [], half = D.size / 2, roads = D.roads;
  const proj = (p, a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2)), x = a[0] + dx * t, z = a[1] + dz * t; return [x, z, Math.hypot(p[0] - x, p[1] - z)]; };
  const nearRoad = (p, r) => { let best = null; for (const q of roads) { if (q === r || q.drop) continue; for (let k = 0; k < q.pts.length - 1; k++) { const [x, z, d] = proj(p, q.pts[k], q.pts[k + 1]); if (!best || d < best.d) best = { d, x, z, q }; } } return best; };
  const built = (p, R) => D.buildings.some(b => Math.hypot(b.x - p[0], b.z - p[1]) < R + Math.max(b.L, b.D) / 2) || (D.plots || []).some(pl => inPoly(p[0], p[1], pl.pts));
  for (const r of roads) {
    if (!['track', 'drive', 'gravel'].includes(r.type)) continue;
    for (const end of [0, 1]) {
      const P = r.pts; if (P.length < 2) continue;
      const p = end ? P[P.length - 1] : P[0], q = end ? P[P.length - 2] : P[1];
      if (Math.max(Math.abs(p[0]), Math.abs(p[1])) > half - 25) continue;                 // runs off the map
      if (Math.hypot(P[0][0] - P[P.length - 1][0], P[0][1] - P[P.length - 1][1]) < 1) continue;   // loop
      const n = nearRoad(p, r); if (n && n.d < n.q.w / 2 + 1.5) continue;                 // joins a road
      if (built(p, 25)) continue;                                                           // to a yard / building
      if (n && n.d < 40) { const pt = [+n.x.toFixed(1), +n.z.toFixed(1)]; if (end) P.push(pt); else P.unshift(pt); fix.push({ road: roads.indexOf(r), end, snap: pt }); continue; }
      const dx = p[0] - q[0], dz = p[1] - q[1], L = Math.hypot(dx, dz) || 1, ux = dx / L, uz = dz / L;
      let te = 1e9; for (const [u, c] of [[ux, p[0]], [uz, p[1]]]) if (Math.abs(u) > 1e-6) te = Math.min(te, ((u > 0 ? half : -half) - c) / u);
      let clear = te < 360; for (let t = 5; clear && t < te; t += 5) if (built([p[0] + ux * t, p[1] + uz * t], 12)) clear = false;
      if (clear) { const pt = [+(p[0] + ux * (te + 6)).toFixed(1), +(p[1] + uz * (te + 6)).toFixed(1)]; if (end) P.push(pt); else P.unshift(pt); fix.push({ road: roads.indexOf(r), end, extend: pt }); continue; }
      // cut back to the last point that is on (near) another road; no junction at all -> drop the whole way
      const idx = end ? [...P.keys()].reverse() : [...P.keys()]; let keep = -1;
      for (const i of idx) { const m = nearRoad(P[i], r); if (m && m.d < m.q.w / 2 + 2) { keep = i; break; } }
      if (keep < 0 || (end ? keep < 1 : keep > P.length - 2)) { r.drop = true; fix.push({ road: roads.indexOf(r), drop: true }); break; }
      if (end) P.length = keep + 1; else P.splice(0, keep); fix.push({ road: roads.indexOf(r), end, cut: keep });
    }
  }
  D.roads = roads.filter(r => !r.drop);
  // ways of one kind that simply continue each other (a node shared by exactly two way ends) become one polyline, so
  // the ribbon is mitred through the bend instead of two butt ends leaving a wedge-shaped gap on the outside
  for (let merged = true; merged;) {
    merged = false; const R = D.roads, ends = [];
    R.forEach((r, i) => { if (r.pts.length > 1 && Math.hypot(r.pts[0][0] - r.pts[r.pts.length - 1][0], r.pts[0][1] - r.pts[r.pts.length - 1][1]) > 1) ends.push([i, 0], [i, 1]); });
    const at = ([i, e]) => e ? R[i].pts[R[i].pts.length - 1] : R[i].pts[0];
    for (let a = 0; a < ends.length && !merged; a++) {
      const pa = at(ends[a]), here = ends.filter(q => Math.hypot(at(q)[0] - pa[0], at(q)[1] - pa[1]) < 0.6);
      if (here.length !== 2) continue;
      const [[i, ei], [j, ej]] = here, ri = R[i], rj = R[j]; if (i === j || ri.type !== rj.type || Math.abs(ri.w - rj.w) > 0.6) continue;
      // nothing else passes through the node
      if (R.some((q, k) => k !== i && k !== j && q.pts.some((p, n) => n < q.pts.length - 1 && proj(pa, p, q.pts[n + 1])[2] < q.w / 2))) continue;
      const A = ei ? ri.pts : ri.pts.slice().reverse(), B = ej ? rj.pts.slice().reverse() : rj.pts;
      ri.pts = [...A, ...B.slice(1)]; R.splice(j, 1); fix.push({ merge: [i, j] }); merged = true;
    }
  }
}
for (const D of Object.values(REAL_DATA)) cleanRoads(D);
export const OSM_CREDIT = 'Map data © OpenStreetMap contributors (ODbL)';
const SIDEWALK = 3.2;
// pavement width per street (osm2map / refine.py r.sw: narrower where the blocks come close, a verge in the private sector)
const swOf = r => r.sw ?? (r.type === 'drive' ? 1.1 : SIDEWALK);

// ================================================================ geometry helpers
export function inPoly(x, z, P) {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c; }
  return c;
}
const polyArea = P => { let a = 0; for (let i = 0, j = P.length - 1; i < P.length; j = i++) a += (P[j][0] + P[i][0]) * (P[j][1] - P[i][1]); return Math.abs(a / 2); };
const polyBB = P => { let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9; for (const [x, z] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); } return [x0, z0, x1, z1]; };
function segD(x, z, ax, az, bx, bz) { const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9; let t = ((x - ax) * dx + (z - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t; const px = ax + dx * t - x, pz = az + dz * t - z; return Math.sqrt(px * px + pz * pz); }
function edgeDist(x, z, P) { let d = 1e9; for (let i = 0, j = P.length - 1; i < P.length; j = i++) d = Math.min(d, segD(x, z, P[j][0], P[j][1], P[i][0], P[i][1])); return d; }
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) { const [ax, az] = pts[i - 1], [bx, bz] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step)); for (let k = 1; k <= n; k++) out.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]); }
  return out;
}
function lineLen(P) { let L = 0; for (let i = 1; i < P.length; i++) L += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); return L; }
// walk a polyline in steps: f(x, z, ux, uz, s)
function walk(P, step, f, start = step / 2) {
  let acc = start;
  for (let i = 0; i < P.length - 1; i++) {
    const [ax, az] = P[i], [bx, bz] = P[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < 1e-6) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    for (; acc < L; acc += step) f(ax + ux * acc, az + uz * acc, ux, uz);
    acc -= L;
  }
}
// spatial index of polygons (point queries)
class PolyIndex {
  constructor(C = 32) { this.C = C; this.g = new Map(); this.items = []; }
  add(P, data) {
    const bb = polyBB(P), it = { P, bb, data, area: polyArea(P) }; this.items.push(it);
    for (let i = Math.floor(bb[0] / this.C); i <= Math.floor(bb[2] / this.C); i++) for (let j = Math.floor(bb[1] / this.C); j <= Math.floor(bb[3] / this.C); j++) { const k = i * 8192 + j; (this.g.get(k) || this.g.set(k, []).get(k)).push(it); }
    return it;
  }
  at(x, z) { const l = this.g.get(Math.floor(x / this.C) * 8192 + Math.floor(z / this.C)); if (!l) return []; const out = []; for (const it of l) if (x >= it.bb[0] && x <= it.bb[2] && z >= it.bb[1] && z <= it.bb[3] && inPoly(x, z, it.P)) out.push(it.data); return out; }
}

// ================================================================ road network
const RW = { paved: 2, street: 2, drive: 2, gravel: 1, track: 1 };
class RoadNet {
  constructor(roads) {
    const C = this.C = 12, M = 14; this.g = new Map(); this.roads = roads;
    roads.forEach((r, ri) => {
      const hw = r.w / 2; r.ri = ri;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], s = { ax, az, bx, bz, hw, r };
        for (let gx = Math.floor((Math.min(ax, bx) - hw - M) / C); gx <= Math.floor((Math.max(ax, bx) + hw + M) / C); gx++)
          for (let gz = Math.floor((Math.min(az, bz) - hw - M) / C); gz <= Math.floor((Math.max(az, bz) + hw + M) / C); gz++) {
            if (segD((gx + 0.5) * C, (gz + 0.5) * C, ax, az, bx, bz) > hw + M + C * 0.71) continue;
            const k = gx * 8192 + gz; (this.g.get(k) || this.g.set(k, []).get(k)).push(s);
          }
      }
    });
  }
  hit(x, z, pad = 0, except = null) {
    const l = this.g.get(Math.floor(x / this.C) * 8192 + Math.floor(z / this.C)); if (!l) return false;
    for (const s of l) if (s.r !== except && segD(x, z, s.ax, s.az, s.bx, s.bz) < s.hw + pad) return s.r;
    return false;
  }
  // nearest road centre line within maxD: { d (to the centre line), r, px, pz, ux, uz }
  near(x, z, maxD = 40, filter = null) {
    let best = null; const C = this.C, seen = new Set();
    for (let i = Math.floor((x - maxD) / C); i <= Math.floor((x + maxD) / C); i++) for (let j = Math.floor((z - maxD) / C); j <= Math.floor((z + maxD) / C); j++) {
      for (const s of this.g.get(i * 8192 + j) || []) {
        if (seen.has(s) || (filter && !filter(s.r))) continue; seen.add(s);
        const dx = s.bx - s.ax, dz = s.bz - s.az, L2 = dx * dx + dz * dz || 1e-9; let t = ((x - s.ax) * dx + (z - s.az) * dz) / L2; t = Math.max(0, Math.min(1, t));
        const px = s.ax + dx * t, pz = s.az + dz * t, d = Math.hypot(x - px, z - pz);
        if (d < maxD && (!best || d < best.d)) { const L = Math.sqrt(L2); best = { d, r: s.r, hw: s.hw, px, pz, ux: dx / L, uz: dz / L }; }
      }
    }
    return best;
  }
}

// ================================================================ geometry buffers
class GeoBuf {
  constructor(extra = false) { this.pos = []; this.uv = []; this.ex = extra ? [] : null; this.idx = []; this.col = null; }
  get n() { return this.pos.length / 3; }
  geometry() {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    const nr = new Float32Array(this.pos.length); for (let i = 1; i < nr.length; i += 3) nr[i] = 1; g.setAttribute('normal', new THREE.BufferAttribute(nr, 3));
    if (this.ex) g.setAttribute('aRoad', new THREE.Float32BufferAttribute(this.ex, 3));
    g.setIndex(this.idx); g.computeBoundingSphere(); return g;
  }
}
// mitred ribbon along a polyline; uvMode 'world' (asphalt / concrete: world xz / tile) or 'strip' (u across 0..1, v along / tile)
function ribbon(B, P, hw, y, { tile = 7, uvMode = 'world', horiz = 1, ext = 0 } = {}) {
  const n = P.length; if (n < 2) return;
  P = P.map(p => [p[0], p[1]]);
  if (ext) { for (const [i, j] of [[0, 1], [n - 1, n - 2]]) { const dx = P[i][0] - P[j][0], dz = P[i][1] - P[j][1], L = Math.hypot(dx, dz) || 1; P[i] = [P[i][0] + dx / L * ext, P[i][1] + dz / L * ext]; } }
  const N = []; for (let i = 0; i < n - 1; i++) { const dx = P[i + 1][0] - P[i][0], dz = P[i + 1][1] - P[i][1], L = Math.hypot(dx, dz) || 1; N.push([-dz / L, dx / L]); }
  let along = 0; const base = B.n;
  for (let i = 0; i < n; i++) {
    if (i) along += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
    let mx, mz, k = 1;
    if (i === 0) [mx, mz] = N[0]; else if (i === n - 1) [mx, mz] = N[n - 2];
    else { mx = N[i - 1][0] + N[i][0]; mz = N[i - 1][1] + N[i][1]; const L = Math.hypot(mx, mz) || 1; mx /= L; mz /= L; k = Math.min(2.2, 1 / Math.max(0.35, mx * N[i][0] + mz * N[i][1])); }
    for (const sd of [-1, 1]) {
      const x = P[i][0] + mx * hw * k * sd, z = P[i][1] + mz * hw * k * sd;
      B.pos.push(x, y, z);
      if (uvMode === 'world') B.uv.push(x / tile, z / tile); else B.uv.push(sd < 0 ? 0 : 1, along / tile);
      if (B.ex) B.ex.push(sd * hw, hw, horiz);
    }
    if (i) { const a = base + (i - 1) * 2; B.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
}
// a box (w along local x, h, d) at a transform, with UVs scaled to metres / tile; returns a geometry
function boxGeo(w, h, d, M, tile = 3, color = null) {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(0, h / 2, 0);
  const uv = g.attributes.uv, sz = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) { const i = f * 4 + v; uv.setXY(i, uv.getX(i) * sz[f][0] / tile, uv.getY(i) * sz[f][1] / tile); }
  g.applyMatrix4(M);
  if (color) { const c = new Float32Array(g.attributes.position.count * 3); for (let i = 0; i < c.length; i += 3) { c[i] = color.r; c[i + 1] = color.g; c[i + 2] = color.b; } g.setAttribute('color', new THREE.BufferAttribute(c, 3)); }
  return g;
}
function canvasTex(w, h, draw, repeat = true) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; return t; }

// Kit blocks are whole panel modules (W wide): fit each footprint rectangle of a building (several for L / U / H
// outlines) to whole modules without growing it into its surroundings, and keep the parts of one outline joined:
// a part end (or long side) that abuts another part stays where it is and the part shrinks / grows at its free end, so
// an L / U joint neither overlaps (end wall through the neighbour's facade) nor opens a gap.  Returns
// [[x, z, L, D, rot]...] with L, D the final module lengths (L = whole modules along local X).
export function fitParts(b, W, maxDepth = 5) {
  const parts = b.parts || [[b.x, b.z, b.L, b.D]], c = Math.cos(b.rot), s = Math.sin(b.rot);
  // building frame: lx along b.rot's local X, lz along local Z (Building.toLocal)
  const R = parts.map(([x, z, L, D]) => { const dx = x - b.x, dz = z - b.z, lx = dx * c - dz * s, lz = dx * s + dz * c; return { x0: lx - L / 2, x1: lx + L / 2, z0: lz - D / 2, z1: lz + D / 2 }; });
  const snap = (len, n0, max) => { let n = Math.max(2, Math.min(max, Math.round(len / W))); if (n * W > len + 0.9 && n > 2) n--; return n * W; };
  // does part i touch another part at its side (axis 'x' | 'z', end -1 | 1)?
  const touch = (i, ax, end) => R.some((q, j) => {
    if (j === i) return false; const p = R[i];
    if (ax === 'x') { const e = end < 0 ? p.x0 : p.x1, f = end < 0 ? q.x1 : q.x0; return Math.abs(e - f) < 0.8 && Math.min(p.z1, q.z1) - Math.max(p.z0, q.z0) > 1; }
    const e = end < 0 ? p.z0 : p.z1, f = end < 0 ? q.z1 : q.z0; return Math.abs(e - f) < 0.8 && Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) > 1;
  });
  const out = [];
  R.forEach((p, i) => {
    const long = p.x1 - p.x0 >= p.z1 - p.z0;   // the kit's L runs along the longer side
    const fit = (a0, a1, ax, max) => {
      const len = a1 - a0, T = snap(len, 0, max), lo = touch(i, ax, -1), hi = touch(i, ax, 1);
      if (lo && !hi) return [a0, a0 + T]; if (hi && !lo) return [a1 - T, a1];
      const m = (a0 + a1) / 2; return [m - T / 2, m + T / 2];
    };
    const [x0, x1] = fit(p.x0, p.x1, 'x', long ? 999 : maxDepth), [z0, z1] = fit(p.z0, p.z1, 'z', long ? maxDepth : 999);
    const lx = (x0 + x1) / 2, lz = (z0 + z1) / 2, wx = b.x + lx * c + lz * s, wz = b.z - lx * s + lz * c;
    out.push(long ? [wx, wz, x1 - x0, z1 - z0, b.rot] : [wx, wz, z1 - z0, x1 - x0, b.rot + Math.PI / 2]);
  });
  return out;
}
// ================================================================ shared world-building (mixed into both classes)
const Real = {
  realSetup() {
    const D = this.osm = REAL_DATA[MAP.real]; this.real = true; this.urban = MAP.kind !== 'rural';
    this.rng = mulberry(MAP.seed || 9157);
    this.place = {}; this.CS = 2; this.CN = Math.ceil(MAP_SIZE / this.CS); this.conceal = new Uint8Array(this.CN * this.CN).fill(255);
    this.nav.maxIter = 900000; this.streetDebris = this.urban ? 40 : 0;
    this.net = new RoadNet(D.roads);
    setRoadTest((x, z, pad) => !!this.net.hit(x, z, pad));
    this.areaIdx = new PolyIndex(); for (const a of D.areas) if (a.pts.length > 2) this.areaIdx.add(a.pts, a);
    this.plotIdx = new PolyIndex(); for (const p of D.plots || []) this.plotIdx.add(p.pts, p);
    this.dmg = MAP.damage || {};
    this.houseSpots = []; this.yardRects = []; this.burntSpots = []; this.lawnPolys = []; this.gardenPolys = []; this.yardPolys = [];
  },
  areasAt(x, z) { return this.areaIdx.at(x, z); },
  // rubble piles: the scanned heaps are 10-30k triangles each -- beyond ~240 m one instanced low-poly mound (all
  // templates, sized per heap) stands in for them (moundsFlush builds it with its own distance LOD cells)
  rubbleInst(t, mats) {
    const bb = t.userData.bbM ||= new THREE.Box3().setFromObject(t), r = Math.max(0.5, (bb.max.x - bb.min.x + bb.max.z - bb.min.z) / 4), h = Math.max(0.3, bb.max.y);
    const S = new THREE.Matrix4().makeScale(r, h, r * 0.85); for (const M of mats) (this._moundM ||= []).push(M.clone().multiply(S));
    return { cullDist: 240, cell: 180 };
  },
  moundsFlush() {
    const list = this._moundM; if (!list?.length) return;
    const g = new THREE.IcosahedronGeometry(1, 1), pos = g.attributes.position; for (let i = 0; i < pos.count; i++) if (pos.getY(i) < 0) pos.setY(i, pos.getY(i) * 0.1);
    g.computeVertexNormals();
    const tpl = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 1, flatShading: true }));
    const cells = new Map(), v = new THREE.Vector3(), C = 180;
    for (const M of list) { v.setFromMatrixPosition(M); const k = Math.floor(v.x / C) + ',' + Math.floor(v.z / C); (cells.get(k) || cells.set(k, []).get(k)).push(M); }
    for (const [k, mats] of cells) {
      const im = new THREE.InstancedMesh(g, tpl.material, mats.length); mats.forEach((M, i) => im.setMatrixAt(i, M)); im.computeBoundingSphere(); im.castShadow = false; im.receiveShadow = true; im.visible = false; im.name = 'rubble_far'; this.scene.add(im);
      const [cx, cz] = k.split(',').map(Number); LODS.push({ near: [], mid: null, far: [im], cx: (cx + 0.5) * C, cz: (cz + 0.5) * C, dm: 240, d1: 240, d2: 1600, state: -1, hr: C / 2 });
    }
    this._moundM = null;
  },
  areaIs(x, z, types) { return this.areaIdx.at(x, z).some(a => types.includes(a.t)); },
  inPlot(x, z) { return this.plotIdx.at(x, z)[0] || null; },
  // fortifications keep out of yards (City.fortifications keepOut); the farm / farmstead of the grid map don't exist
  inVillage(x, z, pad = 0) { return !!this.plotIdx.at(x, z).length || (pad > 0 && (!!this.plotIdx.at(x + pad, z).length || !!this.plotIdx.at(x - pad, z).length || !!this.plotIdx.at(x, z + pad).length || !!this.plotIdx.at(x, z - pad).length)); },
  inFarm() { return false; }, inFarmstead() { return false; },
  inWood(x, z) { return this.areaIs(x, z, ['wood', 'forest']); },
  // ---------------------------------------------------------------- roads
  roadsReal() {
    const D = this.osm, T = this.assets.tex, U = this.groundUniforms, urban = this.urban;
    const asphalt = roadWear(this.mat('asphalt', 1, { color: urban ? 0xd8d4cc : 0xc4c0b6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), U, urban ? { damage: 0.9 } : { rural: true, damage: 1 });
    const walkM = roadWear(this.mat('concrete', 1, { color: 0xbab4a8, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), U, { damage: 0 });
    // dirt tracks / gravel village streets: strip texture with ruts and soft edges (farmland track set, else the dirt set)
    const a = document.createElement('canvas'); a.width = 64; a.height = 4; { const x = a.getContext('2d'), gr = x.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, '#000'); gr.addColorStop(0.16, '#fff'); gr.addColorStop(0.84, '#fff'); gr.addColorStop(1, '#000'); x.fillStyle = gr; x.fillRect(0, 0, 64, 4); }
    const alpha = new THREE.CanvasTexture(a); alpha.wrapT = THREE.RepeatWrapping;
    const mkTrack = (color, mapTex) => {
      const m = new THREE.MeshStandardMaterial({ map: mapTex ? mapTex.clone() : null, alphaMap: alpha, transparent: true, depthWrite: false, roughness: 1, color, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      if (m.map) { m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping; m.map.needsUpdate = true; }
      if (T.track?.normalMap) { m.normalMap = T.track.normalMap.clone(); m.normalMap.wrapS = m.normalMap.wrapT = THREE.RepeatWrapping; m.normalMap.needsUpdate = true; m.normalScale = new THREE.Vector2(0.9, 0.9); }
      trackWear(m, U); return m;
    };
    const trackTex = T.track?.map || T.dirt?.map;
    this.trackMat = mkTrack(T.track ? 0xffffff : 0xb0a28a, trackTex);
    const gravelMat = mkTrack(T.track ? 0xd9d2c4 : 0xc4b9a4, trackTex); gravelMat.customProgramCacheKey = this.trackMat.customProgramCacheKey;
    const B = { asphalt: new GeoBuf(true), walk: new GeoBuf(true), track: new GeoBuf(), gravel: new GeoBuf() }, dashes = [], curbs = [];
    for (const r of D.roads) {
      const P = r.pts; if (P.length < 2) continue;
      const hw = r.w / 2, x0 = P[0][0], x1 = P[P.length - 1][0], z0 = P[0][1], z1 = P[P.length - 1][1], horiz = Math.abs(x1 - x0) > Math.abs(z1 - z0) ? 1 : 0;
      if (r.type === 'paved' || r.type === 'street' || r.type === 'drive') {
        // crossing ribbons of one class would be coplanar and z-fight at the junction: higher classes sit a few mm up
        ribbon(B.asphalt, P, hw, r.type === 'paved' ? 0.058 : r.type === 'street' ? 0.054 : 0.05, { horiz, ext: 0.5 });
        if (urban && swOf(r) > 0.05) ribbon(B.walk, P, hw + swOf(r), 0.03, { horiz, tile: 4 });
        if (r.type === 'paved') walk(P, urban ? 9 : 12, (x, z, ux, uz) => { if (this.rng() < (urban ? 0.75 : 0.45) && !this.net.hit(x, z, 0.5, r)) dashes.push(trs(x, 0.066, z, Math.atan2(-uz, ux))); });
        if (urban && r.type !== 'drive' && swOf(r) >= 1.5) for (const sd of [-1, 1]) walk(P, 1, (x, z, ux, uz) => { const cx = x - uz * hw * sd, cz = z + ux * hw * sd; if (this.net.hit(cx, cz, 0.6, r) || this.rng() < 0.05) return; curbs.push(trs(cx, 0.08, cz, Math.atan2(-uz, ux), 1, 0, (this.rng() - 0.5) * 0.04)); });
      } else ribbon(r.type === 'gravel' ? B.gravel : B.track, P, hw + 0.6, r.type === 'gravel' ? 0.04 : 0.035, { uvMode: 'strip', tile: 4.5, ext: 0.3 });
      // nav: vehicles prefer roads (2 paved, 1 dirt)
      const v = RW[r.type] || 1, pad = v === 1 ? 0.6 : 0;
      for (let i = 0; i < P.length - 1; i++) {
        const [ax, az] = P[i], [bx, bz] = P[i + 1];
        for (let z = Math.floor(Math.min(az, bz) - hw - 1); z <= Math.ceil(Math.max(az, bz) + hw + 1); z++) for (let x = Math.floor(Math.min(ax, bx) - hw - 1); x <= Math.ceil(Math.max(ax, bx) + hw + 1); x++) {
          if (segD(x + 0.5, z + 0.5, ax, az, bx, bz) > hw + pad) continue; const i2 = this.nav.idx(x + 0.5, z + 0.5); if (i2 >= 0) this.nav.road[i2] = Math.max(this.nav.road[i2], v);
        }
      }
    }
    // junction patches: where two or more carriageway ends meet at one node (corner of two streets, a fork) their butt
    // ends leave notches on the outside; a disc just under the ribbons fills them (pavements the same)
    { const ends = new Map();
      for (const r of D.roads) if (r.type === 'paved' || r.type === 'street' || r.type === 'drive') for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) { const k = Math.round(p[0] * 2) + ',' + Math.round(p[1] * 2); (ends.get(k) || ends.set(k, []).get(k)).push([p, r]); }
      const disc = (Bf, x, z, rad, y, tile) => { const n = 18, c = Bf.n; Bf.pos.push(x, y, z); Bf.uv.push(x / tile, z / tile); if (Bf.ex) Bf.ex.push(0, rad, 1); for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2, px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad; Bf.pos.push(px, y, pz); Bf.uv.push(px / tile, pz / tile); if (Bf.ex) Bf.ex.push(0, rad, 1); Bf.idx.push(c, c + 1 + (i + 1) % n, c + 1 + i); } };
      for (const [, L] of ends) { if (L.length < 2) continue; const [p] = L[0], hw = Math.max(...L.map(([, r]) => r.w / 2));
        disc(B.asphalt, p[0], p[1], hw, 0.047, 7);
        const sw = Math.max(...L.map(([, r]) => swOf(r))); if (urban && sw > 0.05) disc(B.walk, p[0], p[1], hw + sw, 0.028, 4); } }
    const add = (buf, mat, ro = 0) => { const g = buf.geometry(); if (!g) return; const m = new THREE.Mesh(g, mat); m.receiveShadow = true; m.renderOrder = ro; this.scene.add(m); return m; };
    add(B.walk, walkM); add(B.asphalt, asphalt); add(B.gravel, gravelMat, 1); add(B.track, this.trackMat, 1);
    if (dashes.length) { const dg = new THREE.PlaneGeometry(3, 0.14); dg.rotateX(-Math.PI / 2); instance(this.scene, new THREE.Mesh(dg, new THREE.MeshStandardMaterial({ color: urban ? 0xc9c5b8 : 0xa9a598, roughness: 0.9, transparent: true, opacity: urban ? 0.5 : 0.32, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 })), dashes, { shadows: false, cell: 400 }); }
    if (curbs.length) { const curbMat = T.curb ? this.mat('curb', 1, { color: 0xffffff }) : new THREE.MeshStandardMaterial({ color: 0x9d988c, roughness: 0.9 }); instance(this.scene, new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.2, 0.22), curbMat), curbs, { cell: 320, cullDist: 520 }); }
  },
  // ---------------------------------------------------------------- buildings from footprints
  // kit rows (panel blocks, schools, civic) for City.placeBuildings, the rest queued for templates / halls / garages
  classifyBuildings() {
    const D = this.osm, R = this.rng, W = this.assets.kit.W, rows = this.buildingRows = [], tplQ = this.tplQueue = [], halls = this.hallList = [], garages = this.garageList = [];
    const dm = this.dmg.blocks || [0.6, 1.3];
    const face = (x, z, rot) => {   // flip so the kit front (+Z local, balconies / shopfronts) faces the nearest road
      const n = this.net.near(x, z, 90, r => r.type !== 'track'); if (!n) return rot;
      return ((n.px - x) * Math.sin(rot) + (n.pz - z) * Math.cos(rot)) < 0 ? rot + Math.PI : rot;
    };
    for (const b of D.buildings) {
      let cls = b.cls; const area = b.a || b.L * b.D;
      if (cls === 'hall' && this.areaIs(b.x, b.z, ['school', 'kindergarten'])) cls = 'school';
      if (!this.urban && cls === 'hall' && area < 650 && !this.areaIs(b.x, b.z, ['industrial'])) cls = 'village';   // single-storey brick (club, shop, office)
      if (this.urban && cls === 'civic' && (b.lv || 1) < 2 && area < 900) cls = area > 200 ? 'store' : 'shop';
      if (this.urban && cls === 'shop' && area > 260) cls = 'store';
      const kit = cls === 'block' || cls === 'school' || cls === 'civic' || cls === 'village';
      if (kit) {
        const lv = b.lv || (cls === 'block' ? 5 : cls === 'school' ? (this.urban ? 3 : 2) : cls === 'village' ? (b.L > 27 ? 2 : 1) : 2);
        const rot0 = face(b.x, b.z, b.rot);
        // damage: imagery-ranked where the layout has it (b.dmg 0..1, refine.py), else the map's random range
        const dmg = this.urban ? (b.dmg != null ? dm[0] * 0.6 + b.dmg * (dm[1] * 1.25 - dm[0] * 0.6) : dm[0] + R() * (dm[1] - dm[0])) : 1.0 + R() * 0.6;
        // construction: 4-storey and lower = brick (1950s-60s), 5-storey = brick or panel khrushchyovka, 7+ = panel nine-storey
        const kind = cls === 'school' ? 'school' : cls === 'village' ? 'brick' : lv >= 12 && b.L < 26 ? 'tower' : lv >= 7 ? 'nine' : cls === 'civic' || lv <= 4 ? 'brick' : (Math.abs(Math.round(b.x * 7 + b.z * 3)) % 3 === 0 ? 'brick' : 'khrushchyovka');
        const shops = cls === 'civic' && /retail|commercial|commerce/.test(b.b || '') || (cls === 'block' && lv >= 9 && R() < 0.5);
        const floors = Math.max(1, Math.min(16, Math.round(lv))), maxDepth = kind === 'tower' ? 6 : 5;
        for (const [x, z, L, Dd, rot] of fitParts({ ...b, rot: rot0 }, W, maxDepth)) {
          const modules = Math.max(2, Math.round(L / W)), depthModules = Math.max(2, Math.min(maxDepth, Math.round(Dd / W)));
          rows.push([x, z, rot, modules, floors, depthModules, Math.max(1, Math.round(modules / 6)), kind, dmg, { shops, osm: b }]);
        }
      } else if (cls === 'hall' || cls === 'store') halls.push({ ...b, cls });
      else if (cls === 'garages') garages.push(b);
      else tplQ.push({ ...b, cls });
    }
    // whole-module rounding can still push a block into a separate neighbouring outline (another block, a hall, a garage
    // row): shorten it by a module at the end facing the conflict (up to 3 modules)
    { const obb = (x, z, L, Dd, rot) => ({ x, z, L, D: Dd, c: Math.cos(rot), s: Math.sin(rot) });
      const sep = (A, B) => { for (const [c, s] of [[A.c, A.s], [-A.s, A.c], [B.c, B.s], [-B.s, B.c]]) {   // SAT on the 4 axes (x' = c x - s z)
          const pr = (O) => { const ex = Math.abs(O.c * c + O.s * s) * O.L / 2 + Math.abs(-O.s * c + O.c * s) * O.D / 2; const m = O.x * c - O.z * s; return [m - ex, m + ex]; };
          const [a0, a1] = pr(A), [b0, b1] = pr(B); if (a1 <= b0 + 0.05 || b1 <= a0 + 0.05) return true; } return false; };
      const others = [...halls, ...garages].flatMap(h => (h.parts || [[h.x, h.z, h.L, h.D]]).map(([x, z, L, Dd]) => ({ o: obb(x, z, L, Dd, h.rot), osm: h })));
      for (let pass = 0; pass < 3; pass++) for (const r of rows) {
        const A = obb(r[0], r[1], r[3] * W, r[5] * W, r[2]);
        const hit = [...rows.filter(q => q !== r && q[9].osm !== r[9].osm).map(q => obb(q[0], q[1], q[3] * W, q[5] * W, q[2])), ...others.map(o => o.o)].find(B => !sep(A, B));
        if (!hit || r[3] <= 2 || (r[10] = (r[10] || 0) + 1) > 3) continue;
        const along = (hit.x - r[0]) * Math.cos(r[2]) - (hit.z - r[1]) * Math.sin(r[2]), sd = along > 0 ? -1 : 1;   // move away from it
        r[3] -= 1; r[0] += Math.cos(r[2]) * sd * W / 2; r[1] -= Math.sin(r[2]) * sd * W / 2; r[6] = Math.max(1, Math.round(r[3] / 6));
      }
      for (const r of rows) r.length = 10; }
    // pancaked entrance sections on a few long blocks (urban maps)
    this.pancakes = [];
    // (imagery-ranked layouts: the worst-hit blocks; otherwise 12 % at random)
    if (this.urban) rows.forEach((r, i) => { const d = r[9].osm?.dmg; if (r[7] !== 'school' && r[3] >= 8 && r[4] >= 4 && (d != null ? d > 0.82 && R() < 0.75 : r[3] >= 14 && R() < 0.12)) { const a = 1 + Math.floor(R() * Math.max(1, r[3] - 4)); this.pancakes.push([i, a, Math.min(r[3] - 2, a + 1 + Math.floor(R() * 2))]); } });
  },
  // ---------------------------------------------------------------- procedural halls (industrial, barns, stores)
  hallsReal() {
    const R = this.rng, wallG = [], roofG = [], darkG = [], rural = !this.urban;
    for (const h of this.hallList || []) {
      const parts = h.parts || [[h.x, h.z, h.L, h.D]];
      const lv = h.lv || 1, store = h.cls === 'store', H = store ? 4.2 * lv : rural ? 4.2 + (h.L > 40 ? 0.8 : 0) : 5 + Math.min(4, h.D * 0.12) + (lv - 1) * 3.5;
      const col = new THREE.Color().setHSL(rural ? 0.1 : 0.08 + R() * 0.04, rural ? 0.08 : 0.06 + R() * 0.06, (rural ? 0.62 : 0.56) + R() * 0.12);
      const roofCol = new THREE.Color().setHSL(0.08, 0.04, (rural ? 0.5 : 0.36) + R() * 0.1), gable = rural || (!store && h.D > 14 && R() < 0.5);
      const ruined = R() < (this.dmg.rubble ?? 0.3) * 0.7;
      for (const [x, z, L0, D0] of parts) {
        let L = L0, Dd = D0, rot = h.rot; if (Dd > L) { [L, Dd] = [Dd, L]; rot += Math.PI / 2; }
        const base = trs(x, 0, z, rot), place = (w, hh, d, lx, ly, lz, list, c, rx = 0) => list.push(boxGeo(w, hh, d, base.clone().multiply(trs(lx, ly, lz, 0, 1, rx, 0)), 3, c));
        const t = 0.3, wallH = ruined ? H * (0.45 + R() * 0.3) : H;
        // long walls in bays (some blown out), end walls
        const bays = Math.max(1, Math.round(L / 6)), bw = L / bays;
        for (const sd of [-1, 1]) for (let i = 0; i < bays; i++) {
          const gone = R() < (ruined ? 0.35 : 0.08), hh = gone ? wallH * (0.15 + R() * 0.35) : wallH * (ruined ? 0.7 + R() * 0.3 : 1);
          place(bw, hh + 0.4, t, -L / 2 + (i + 0.5) * bw, -0.4, sd * (Dd / 2 - t / 2), wallG, col);   // footing 0.4 m into the ground: no gap on uneven ground
          if (!gone && hh > 3) place(bw * 0.7, 1.1, 0.05, -L / 2 + (i + 0.5) * bw, Math.min(hh - 1.6, 2.4), sd * (Dd / 2 + 0.01), darkG, null);   // window band
        }
        for (const sd of [-1, 1]) place(t, wallH + 0.4, Dd, sd * (L / 2 - t / 2), -0.4, 0, wallG, col);
        // roof: gable (two slopes) or flat slab with parapet; missing bays where it burnt / was hit
        if (!ruined) {
          const rb = Math.max(1, Math.round(L / 8)), rw = L / rb;
          const pitch = 0.3, half = Dd / 2 + 0.4, sl = half / Math.cos(pitch), rise = Math.tan(pitch) * (Dd / 2);
          for (let i = 0; i < rb; i++) {
            if (R() < 0.2) continue;
            if (gable) for (const sd of [-1, 1]) place(rw, 0.12, sl, -L / 2 + (i + 0.5) * rw, wallH + Math.tan(pitch) * half / 2 - 0.12, sd * half / 2, roofG, roofCol, sd * pitch);
            else place(rw, 0.3, Dd, -L / 2 + (i + 0.5) * rw, wallH, 0, roofG, roofCol);
          }
          if (gable) for (const sd of [-1, 1]) {   // gable end triangles
            const sh = new THREE.Shape([new THREE.Vector2(-Dd / 2, 0), new THREE.Vector2(Dd / 2, 0), new THREE.Vector2(0, rise)]);
            const g = new THREE.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false }); g.rotateY(Math.PI / 2); g.translate(sd * (L / 2) - (sd > 0 ? t : 0), wallH, 0);
            const uv = g.attributes.uv; for (let q = 0; q < uv.count; q++) uv.setXY(q, uv.getX(q) / 3, uv.getY(q) / 3);
            g.applyMatrix4(base); const c = new Float32Array(g.attributes.position.count * 3); for (let q = 0; q < c.length; q += 3) { c[q] = col.r; c[q + 1] = col.g; c[q + 2] = col.b; } g.setAttribute('color', new THREE.BufferAttribute(c, 3)); wallG.push(g);
          }
        }
        place(L - 0.6, 0.06, Dd - 0.6, 0, 0.02, 0, darkG, null);   // dark floor / debris inside
        this.nav.rect(x, z, L / 2, Dd / 2, rot, BLOCK, 0.2);
        this.nav.addOccluder(x, z, L / 2, Dd / 2, rot, wallH, null);
        this.solidAdd(x, z, L / 2, Dd / 2, rot, 'house');
        (this.hallRects ||= []).push([x, z, L, Dd, rot, ruined]);
        if (ruined) (this.burntSpots ||= []).push([x, z, Math.max(L, Dd) * 0.45]);
      }
    }
    const conc = this.mat(this.urban ? 'concrete' : 'brick', 1, { color: 0xffffff, vertexColors: true });
    const roofTex = canvasTex(64, 64, (x, w, h) => { x.fillStyle = '#8a8a86'; x.fillRect(0, 0, w, h); for (let i = 0; i < w; i += 8) { x.fillStyle = 'rgba(0,0,0,.22)'; x.fillRect(i, 0, 3, h); x.fillStyle = 'rgba(255,255,255,.08)'; x.fillRect(i + 4, 0, 2, h); } for (let i = 0; i < 40; i++) { x.fillStyle = `rgba(60,45,30,${Math.random() * 0.25})`; x.fillRect(Math.random() * w, Math.random() * h, 4 + Math.random() * 10, 4 + Math.random() * 10); } });
    const roofM = new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.85, metalness: 0.15, vertexColors: true, side: THREE.DoubleSide });
    const darkM = new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 1 });
    for (const [list, m] of [[wallG, conc], [roofG, roofM], [darkG, darkM]]) {
      if (!list.length) continue;
      for (const g of list) if (!g.attributes.color) { const c = new Float32Array(g.attributes.position.count * 3).fill(1); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); }
      const mesh = new THREE.Mesh(mergeGeometries(list.map(g => g.index ? g.toNonIndexed() : g)), m); mesh.castShadow = mesh.receiveShadow = true; mesh.name = 'halls'; this.scene.add(mesh);
    }
  },
  // ---------------------------------------------------------------- garage cooperatives: rows of garage units
  garagesReal() {
    const R = this.rng, have = this.tpl('garage_unit'); if (!have) return;
    const F = ['garage_unit', 'garage_unit_damaged'].map(n => this.tplFoot(n)).filter(Boolean);
    const uw = Math.max(...F.map(f => 2 * Math.max(-f[0], f[2]))), ud = Math.max(...F.map(f => 2 * Math.max(-f[1], f[3])));
    for (const g of this.garageList || []) {
      for (const [x, z, L0, D0] of g.parts || [[g.x, g.z, g.L, g.D]]) {
        let L = L0, Dd = D0, rot = g.rot; if (Dd > L) { [L, Dd] = [Dd, L]; rot += Math.PI / 2; }
        // units fitted inside the OSM outline: one or two back-to-back rows, scaled (0.7..1) so no unit pokes out
        const rowsN = Dd > ud * 1.7 ? 2 : 1, c = Math.cos(rot), s = Math.sin(rot);
        let sc = Math.min(1, Dd / (rowsN * ud)), n = Math.max(1, Math.floor(L / (uw * sc) + 0.15)); sc = Math.max(0.6, Math.min(sc, L / (n * uw)));
        if (L < uw * 0.6 || Dd < ud * 0.6) continue;
        for (let rI = 0; rI < rowsN; rI++) {
          const off = rowsN === 2 ? (rI ? 1 : -1) * ud * sc / 2 : 0, ry = rot + (rowsN === 2 ? (rI ? 0 : Math.PI) : (R() < 0.5 ? 0 : Math.PI));
          for (let i = 0; i < n; i++) {
            const lx = -L / 2 + (i + 0.5) * (L / n), px = x + lx * c + off * s, pz = z - lx * s + off * c;
            const dmg = R() < (this.dmg.burnt ?? 0.25) + 0.1;
            this.put(dmg ? 'garage_unit_damaged' : 'garage_unit', px, pz, ry, { s: sc, check: false, cost: BLOCK, inst: { cell: 260, cullDist: 900 } });
          }
        }
        this.nav.rect(x, z, L / 2, Dd / 2, rot, BLOCK, 0.1);
        this.nav.addOccluder(x, z, L / 2, Dd / 2, rot, 2.6, null);
        (this.hallRects ||= []).push([x, z, L, Dd, rot, false, 'garages']);
      }
    }
  },
  // ---------------------------------------------------------------- house templates fitted to footprints
  houseTemplates() {
    if (this._houseT) return this._houseT;
    const names = ['house_a', 'house_b', 'house_c', 'house_d', 'house_e'].filter(n => this.tpl(n));
    return (this._houseT = names.map(n => { const bb = this.tpl(n).userData.bb, sx = bb.max.x - bb.min.x, sz = bb.max.z - bb.min.z; return { n, sx, sz, long: sx >= sz }; }));
  },
  // houses, sheds, kiosks, silos, churches, ruins (template-built)
  smallBuildings() {
    const R = this.rng, HT = this.houseTemplates(), dRub = this.dmg.rubble ?? 0.3, dBurn = this.dmg.burnt ?? 0.3;
    const facing = (x, z, rot) => { const n = this.net.near(x, z, 60); if (!n) return rot; return ((n.px - x) * Math.sin(rot) + (n.pz - z) * Math.cos(rot)) < 0 ? rot + Math.PI : rot; };
    this.houseState = new Map();
    const rubble = (x, z, s) => { const pool = this.rubblePool('house'); (this._houseRubble ||= []).push([pool[Math.floor(R() * pool.length)], trs(x, 0, z, R() * 6, s)]); this.nav.circle(x, z, 4.2 * s / 1.3, 6, true); this.solidAdd(x, z, 5 * s / 1.3, 5 * s / 1.3, 0, 'house'); };
    D: for (const b of this.tplQueue) {
      const x = b.x, z = b.z;
      if (this.terrain.cutSDF(x, z) < Math.max(b.L, b.D) * 0.5 + 2) continue;   // a position was dug here
      if (b.cls === 'house') {
        // template: closest footprint (both orientations), scaled into it
        let best = null;
        for (const t of HT) for (const sw of [0, 1]) {
          const tl = sw ? t.sz : t.sx, td = sw ? t.sx : t.sz, e = Math.abs(Math.log(b.L / tl)) + Math.abs(Math.log(b.D / td)) + R() * 0.25;
          // scaled to the footprint area, but never past the outline (eaves 0.3 m): no wall through the neighbour / street
          const fitS = Math.min((b.L + 0.3) / tl, (b.D + 0.3) / td);
          if (!best || e < best.e) best = { t, sw, e, s: Math.max(0.6, Math.min(1.22, fitS, Math.sqrt((b.L * b.D) / (tl * td)))) };
        }
        if (!best) continue;
        // syn plots carry the street-facing rotation; OSM houses: front (+Z of the template) towards the nearest road
        let ry = b.syn ? b.rot : facing(x, z, b.rot) ; if (best.sw && !b.syn) ry += Math.PI / 2;
        const roll = R(), state = roll < dRub ? 2 : roll < dRub + dBurn ? 1 : 0;
        this.houseState.set(b, state);
        if (state === 2) rubble(x, z, (1.0 + R() * 0.3) * best.s);
        else {
          const name = state === 1 ? (this.burntTpl(best.t.n) || best.t.n) : best.t.n;
          if (!this.put(name, x, z, ry + (R() - 0.5) * 0.06, { s: best.s, occ: state === 1 ? 2.4 : 3.2, roadPad: 0.5, inst: { cell: 300, cullDist: 1300 } })) continue D;
          if (state === 1) this.burntSpots.push([x, z, 8]);
        }
        this.houseSpots.push([x, z, state === 2]);
      } else if (b.cls === 'shed') {
        const n = this.urban ? (R() < 0.5 ? 'garage_unit' : 'shed_wood') : (b.L > 5 ? 'shed_wood' : 'outhouse');
        if (this.railNear(x, z, 6.5)) continue;
        this.put(R() < dRub && this.tpl(n + '_damaged') ? n + '_damaged' : n, x, z, b.rot, { roadPad: 2.2, inst: { cell: 300, cullDist: 800 } });
      } else if (b.cls === 'kiosk') this.put(R() < 0.5 ? 'kiosk_burnt' : 'kiosk_press', x, z, facing(x, z, b.rot), { roadPad: 1.6, inst: { cell: 300 } });
      else if (b.cls === 'shop') this.put(R() < 0.45 ? 'pavilion_burnt' : 'pavilion_closed', x, z, facing(x, z, b.rot), { roadPad: 2, occ: 3, inst: { cell: 300 } });
      else if (b.cls === 'church') this.put('church_small', x, z, facing(x, z, b.rot), { occ: true });
      else if (b.cls === 'silo') this.put(this.urban ? 'water_tower_damaged' : 'grain_silo', x, z, b.rot, { circle: Math.max(2, b.L / 2) });
      else if (b.cls === 'ruin') rubble(x, z, Math.min(2.2, Math.sqrt(b.L * b.D) / 7));
    }
    const by = new Map(); for (const [t, M] of this._houseRubble || []) { (by.get(t) || by.set(t, []).get(t)).push(M); this.terrain.stamp(t, M); }
    for (const [t, l] of by) instance(this.scene, t, l, this.rubbleInst(t, l));
  },
  // ---------------------------------------------------------------- plots: fences, gates, outbuildings, gardens, trees
  plotsReal() {
    const R = this.rng, D = this.osm, urban = this.urban, dRub = this.dmg.rubble ?? 0.3;
    const fenceNames = urban ? ['fence_house_prof', 'fence_house_plain', 'fence_house_plain_brown', 'fence_house_picket'].filter(n => this.tpl(n)) : ['fence_wood_village', 'fence_wattle'];
    const flen = n => { const bb = this.tpl(n).userData.bb; return Math.max(1.5, bb.max.x - bb.min.x); };
    const fruit = urban ? ['tree_walnut_leafy', 'leafy_summer_chestnut', 'tree_acacia_leafy', 'leafy_summer_birch'] : ['tree_walnut_leafy', 'tree_acacia_leafy', 'leafy_summer_chestnut', 'tree_acacia_shelled'];
    const lod = n => this.tpl(n + '_lod1') && this.hasTpl(n + '_lod1') ? n + '_lod1' : null;
    for (const p of D.plots || []) {
      const [a, b, c, d] = p.pts, fx = p.f[0], fz = p.f[1];   // a-b on the street side, f = unit vector towards the street
      const nx = -fx, nz = -fz, ux = b[0] - a[0], uz = b[1] - a[1], fr = Math.hypot(ux, uz) || 1, dep = Math.hypot(d[0] - a[0], d[1] - a[1]);
      const h = D.buildings[p.h], hs = h ? this.houseState?.get(h) : undefined;
      const wrecked = hs === 2 || (hs === undefined && R() < dRub);
      const fn = fenceNames[Math.floor(R() * fenceNames.length)], L = flen(fn), ry = Math.atan2(-uz, ux);
      // street fence with a gate in front of the house
      const gateT = h ? ((h.x - a[0]) * ux + (h.z - a[1]) * uz) / fr : fr / 2;
      for (let t = L / 2; t < fr - L / 2 + 0.01; t += L) {
        const x = a[0] + ux / fr * t + nx * 0.5, z = a[1] + uz / fr * t + nz * 0.5;
        if (R() < (wrecked ? 0.55 : 0.14) || this.net.hit(x, z, 0.4) || this.terrain.cutSDF(x, z) < 1.6 || this.segBlocked(x, z, ux / fr, uz / fr, L) || this.solidHit(x, z, L / 2, 0.12, ry, 0.05, k => k === 'fence')) continue;
        if (Math.abs(t - gateT) < L * 0.6 && !urban) { this.put('gate_village', x, z, ry, { crush: 'any', check: false }); continue; }
        if (Math.abs(t - gateT) < L * 0.6) continue;   // urban: open gateway
        if (this.houseNear(x, z, ry)) continue;
        if (this.put(fn, x, z, ry + (R() - 0.5) * (wrecked ? 0.25 : 0.05), { crush: 'any', check: false })) this.solidAdd(x, z, L / 2, 0.1, ry, 'fence');
      }
      // side fences along the yard (first ~20 m)
      if (!urban || R() < 0.5) for (const [e0, sgn] of [[a, 1], [b, -1]]) for (let w = 3; w < Math.min(urban ? 9 : 22, dep - 2); w += L) {
        if (R() < (wrecked ? 0.6 : 0.3)) continue;
        const x = e0[0] + nx * w + ux / fr * 0.4 * sgn, z = e0[1] + nz * w + uz / fr * 0.4 * sgn;
        if (this.net.hit(x, z, 0.4) || this.terrain.cutSDF(x, z) < 1.6 || this.segBlocked(x, z, nx, nz, L) || this.solidHit(x, z, L / 2, 0.12, ry + Math.PI / 2, 0.05, k => k === 'fence') || this.houseNear(x, z, ry + Math.PI / 2)) continue;
        if (this.put(fn, x, z, ry + Math.PI / 2, { crush: 'any', check: false })) this.solidAdd(x, z, L / 2, 0.1, ry + Math.PI / 2, 'fence');
      }
      // behind the house: outbuildings; then the garden (paint) with fruit trees
      const hx = h ? h.x : a[0] + ux / 2 + nx * 10, hz = h ? h.z : a[1] + uz / 2 + nz * 10, back = h ? ((h.x - a[0]) * nx + (h.z - a[1]) * nz) + 9 : 18;
      const yb = urban ? [['shed_wood', 0.55], ['garage_unit', 0.3]] : [['shed_wood', 0.8], ['outhouse', 0.55], ['woodpile', 0.45], ['well_village', 0.35], ['greenhouse_frame', 0.2]];
      for (const [n, pr] of yb) if (R() < pr * (wrecked ? 0.7 : 1)) {
        const t = (0.2 + R() * 0.6) * fr, w = back + R() * 8, x = a[0] + ux / fr * t + nx * w, z = a[1] + uz / fr * t + nz * w;
        if (w > dep - 3 || !this.inPlotPoly(p, x, z, 1.5)) continue;
        this.put(n, x, z, ry + (R() < 0.5 ? 0 : Math.PI / 2), { cost: n === 'woodpile' ? 7 : BLOCK, low: n === 'woodpile', roadPad: 0.5, inst: { cell: 300, cullDist: 800 } });
      }
      const g0 = Math.min(dep - 6, back + 10);
      if (dep - g0 > 8) {
        const gp = [[a[0] + nx * g0, a[1] + nz * g0], [b[0] + nx * g0, b[1] + nz * g0], c, d];
        this.gardenPolys.push(gp);
        for (let q = 0; q < (urban ? 4 : 3); q++) if (R() < 0.8) {
          const t = (0.15 + R() * 0.7) * fr, w = g0 + R() * (dep - g0 - 3), x = a[0] + ux / fr * t + nx * w, z = a[1] + uz / fr * t + nz * w;
          const n = fruit[Math.floor(R() * fruit.length)]; if (!this.tpl(n)) continue;
          this.put(n, x, z, R() * 6, { s: 0.7 + R() * 0.35, circle: 0.5, lod: lod(n), inst: { lodDist: 200, cullDist: 1100, cell: 180 } });
        }
      }
      this.yardPolys.push([a, b, [b[0] + nx * g0, b[1] + nz * g0], [a[0] + nx * g0, a[1] + nz * g0]]);
      // concealment: yards and gardens (sampled over the quad)
      for (let t = 1; t < fr; t += 3) for (let w = 1; w < dep; w += 3) { const x = a[0] + ux / fr * t + nx * w, z = a[1] + uz / fr * t + nz * w; this.concealRect(x - 1.5, z - 1.5, x + 1.5, z + 1.5, 190); }
      if (urban && !wrecked && h && R() < 0.12) { const x = a[0] + ux / fr * (gateT + 4) + nx * 4, z = a[1] + uz / fr * (gateT + 4) + nz * 4; this.put(R() < 0.6 ? 'car_parked_lada' : 'car_vaz2107_burnt', x, z, ry + Math.PI / 2 + (R() - 0.5) * 0.3, { cost: BLOCK, roadPad: 0.3 }); }
    }
  },
  // a straight piece (fence panel, wall, pipe) of length len centred at x, z along (ux, uz): any point of it in a
  // panel block (rotated rectangles, not the axis box of the piece) or a hall / garage row?
  segBlocked(x, z, ux, uz, len) {
    for (const t of [-0.5, -0.25, 0, 0.25, 0.5]) { const px = x + ux * len * t, pz = z + uz * len * t; if (this.overlapsBuilding(px, pz, 0.15, 0.15, 0.1)) return true;
      for (const [hx, hz, L, Dd, rot] of this.hallRects || []) { const dx = px - hx, dz = pz - hz, c = Math.cos(rot), s = Math.sin(rot); if (Math.abs(dx * c - dz * s) < L / 2 + 0.25 && Math.abs(dx * s + dz * c) < Dd / 2 + 0.25) return true; } }
    return false;
  },
  // template footprint in its own frame (the instancer draws the meshes relative to the template root): [x0, z0, x1, z1]
  tplFoot(name) {
    const t = this.tpl(name); if (!t) return null; if (t.userData.footL) return t.userData.footL;
    t.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(t.matrixWorld).invert(), bb = new THREE.Box3();
    t.traverse(o => { if (!o.isMesh) return; if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); bb.union(o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld))); });
    return (t.userData.footL = bb.isEmpty() ? null : [bb.min.x, bb.min.z, bb.max.x, bb.max.z]);
  },
  railNear(x, z, d) { for (const l of this.osm.lines) if (/^rail/.test(l.t)) for (let i = 0; i < l.pts.length - 1; i++) if (segD(x, z, l.pts[i][0], l.pts[i][1], l.pts[i + 1][0], l.pts[i + 1][1]) < d) return true; return false; },
  inPlotPoly(p, x, z, m = 0) { return inPoly(x, z, p.pts) && edgeDist(x, z, p.pts) > m; },
  // ---------------------------------------------------------------- vegetation: woods, tree rows, belts, street trees
  vegetationReal() {
    const R = this.rng, D = this.osm, urban = this.urban, self = this;
    const rural = ['tree_acacia_leafy', 'tree_oak_leafy', 'tree_poplar_leafy', 'tree_walnut_leafy', 'tree_acacia_shelled'].filter(n => this.tpl(n));
    const cityT = ['leafy_summer_chestnut', 'leafy_summer_birch', 'tree_chestnut_broken', 'tree_poplar_broken', 'tree_birch_stripped', 'tree_chestnut_stripped'];
    const kinds = rural.length ? rural : cityT;
    const lodOf = n => this.hasTpl(n + '_lod1') ? n + '_lod1' : null;
    const items = [];
    const tree = (n, x, z, s, belt = false) => { if (this.terrain.cutSDF(x, z) < 1.8 || this.solidHit(x, z, 0.45, 0.45, 0, 0.3) || this.net.hit(x, z, 1.5) || this.overlapsBuilding(x, z, 0.5, 0.5, 1.5)) return false;
      const t = this.tpl(n); if (this.crownHit(x, z, t ? this.canopyR(t, s) * 0.75 : 2)) return false;   // crown clear of roofs
      items.push([n, trs(x, 0, z, R() * 6.28, s)]); this.nav.circle(x, z, 0.45, BLOCK); this.solidAdd(x, z, 0.4, 0.4, 0, 'tree'); return true; };
    const pick = (shell = 0.15) => { if (R() < shell && this.tpl('tree_acacia_shelled')) return 'tree_acacia_shelled'; return kinds[Math.floor(R() * Math.min(4, kinds.length))]; };
    // woods / forest / scrub polygons
    const MN = this.forestMN = Math.ceil(MAP_SIZE / 4), mask = this.forestMask = new Uint8Array(MN * MN), half = MAP_SIZE / 2;
    for (const a of D.areas) {
      if (!['wood', 'forest', 'scrub', 'heath', 'orchard', 'allotments', 'park'].includes(a.t) || a.pts.length < 3) continue;
      const [x0, z0, x1, z1] = polyBB(a.pts), dense = a.t === 'wood' || a.t === 'forest', sp = dense ? 6.2 : a.t === 'park' ? 12 : a.t === 'orchard' || a.t === 'allotments' ? 7.5 : 9;
      for (let z = z0; z < z1; z += sp) for (let x = x0; x < x1; x += sp) {
        const px = x + (R() - 0.5) * sp * 0.8, pz = z + (R() - 0.5) * sp * 0.8;
        if (Math.abs(px) > half - 2 || Math.abs(pz) > half - 2 || !inPoly(px, pz, a.pts)) continue;
        const edge = edgeDist(px, pz, a.pts) < 7;
        if (a.t === 'scrub' || a.t === 'heath' || (a.t === 'allotments' && R() < 0.4)) { if (R() < 0.7 && this.terrain.cutSDF(px, pz) > 1.4 && !this.net.hit(px, pz, 1)) { items.push([R() < 0.5 ? 'bush_a' : 'bush_b', trs(px, 0, pz, R() * 6.28, 0.7 + R() * 0.6)]); this.nav.circle(px, pz, 0.9, 4); } continue; }
        tree(a.t === 'orchard' || a.t === 'allotments' ? (R() < 0.6 ? 'tree_walnut_leafy' : 'tree_acacia_leafy') : pick(edge ? 0.3 : 0.08), px, pz, edge ? 0.7 + R() * 0.35 : 0.8 + R() * 0.45);
        if (dense && R() < (edge ? 0.6 : 0.25)) { const bx = px + (R() - 0.5) * 4, bz = pz + (R() - 0.5) * 4; if (!this.net.hit(bx, bz, 2) && this.terrain.cutSDF(bx, bz) > 1.6) { items.push([R() < 0.55 ? 'bush_a' : 'bush_b', trs(bx, 0, bz, R() * 6.28, 0.8 + R() * 0.6)]); this.nav.circle(bx, bz, 1.0, 4); } }
      }
      if (dense) {
        for (let z = z0; z < z1; z += 2) for (let x = x0; x < x1; x += 2) if (inPoly(x, z, a.pts)) {
          this.concealRect(x, z, x + 1.9, z + 1.9, 80);
          const i = Math.floor((x + half) / 4), j = Math.floor((z + half) / 4); if (i >= 0 && j >= 0 && i < MN && j < MN) mask[j * MN + i] = 1;
          if (polyArea(a.pts) > (urban ? 9000 : 2500) && edgeDist(x, z, a.pts) > 2 && !this.net.hit(x, z, 1.5)) { const k = this.nav.idx(x + 1, z + 1); if (k >= 0) { this.nav.veh ||= new Uint8Array(this.nav.n * this.nav.n); this.nav.veh[k] = 2; if (this.nav.cost[k] < 2) this.nav.cost[k] = 2; } }
        }
        this.nav.vehDirty = true;
        for (let z = z0; z < z1; z += 16) { let run = null; const close = x2 => { if (run !== null && x2 - run > 8) { const o = this.nav.addOccluder((run + x2) / 2, z + 8, (x2 - run) / 2, 8, 0, 14, null); o.foliage = true; o.depth = 26; } run = null; }; for (let x = x0; x < x1 + 4; x += 4) { if (inPoly(x, z + 8, a.pts)) { if (run === null) run = x; } else close(x); } close(x1 + 4); }
      }
    }
    // tree rows and hedges (OSM) + the map's extra belts: windbreak rows of 2-3 lines with bushes
    const belts = [...D.lines.filter(l => l.t === 'tree_row' || l.t === 'hedge').map(l => ({ pts: l.pts, hedge: l.t === 'hedge', rows: urban ? 1 : 3 })), ...(MAP.belts || []).map(p => ({ pts: p, rows: 3 }))];
    for (const bl of belts) {
      const P = bl.pts; let run = [];
      walk(P, bl.hedge ? 2.2 : urban ? 7 + R() * 3 : 4.4, (cx, cz, ux, uz) => {
        const nx = -uz, nz = ux;
        if (Math.abs(cx) > half - 3 || Math.abs(cz) > half - 3 || this.net.hit(cx, cz, 6) || this.terrain.cutSDF(cx, cz) < 1) { flush(); return; }
        run.push([cx, cz, ux, uz]);
        const offs = bl.hedge ? [0] : bl.rows === 1 ? [0] : [-3.2, 0.2, 3.5];
        for (const off of offs) {
          const o2 = off + (R() - 0.5) * 1.2, px = cx + nx * o2 + ux * (R() - 0.5) * 1.6, pz = cz + nz * o2 + uz * (R() - 0.5) * 1.6;
          if (bl.hedge || off === 0.2 || R() < 0.1) { if (R() < 0.75 && this.terrain.cutSDF(px, pz) > 1.4 && !this.solidHit(px, pz, 0.6, 0.6, 0, 0.2)) { const n = R() < 0.5 ? 'bush_a' : 'bush_b'; items.push([n, trs(px, 0, pz, R() * 6.28, 0.8 + R() * 0.6)]); this.nav.circle(px, pz, 1.0, 4); } continue; }
          if (R() < 0.12) continue;
          tree(pick(urban ? 0.25 : 0.3), px, pz, 0.8 + R() * 0.4, true);
        }
        this.concealRect(cx - 6, cz - 6, cx + 6, cz + 6, 110);
      });
      flush();
      function flush() { if (run.length > 2) { const [ax, az] = run[0], [bx, bz] = run[run.length - 1], L = Math.hypot(bx - ax, bz - az); if (L > 6) { const o = self.nav.addOccluder((ax + bx) / 2, (az + bz) / 2, L / 2 + 2, bl.hedge ? 1.5 : 5, Math.atan2(-(bz - az), bx - ax), bl.hedge ? 2.2 : 9, null); o.foliage = true; } } run = []; }
    }
    // balkas: scrub and willow / poplar clumps along the stream floor, thinner up the slopes
    if (!urban) for (const l of D.lines) if (l.t === 'stream') walk(densify(l.pts, 4), 4.5, (x, z, ux, uz) => {
      const nx = -uz, nz = ux;
      for (let k = 0; k < 2; k++) {
        const o = (R() - 0.5) * (k ? 22 : 9), px = x + nx * o + ux * (R() - 0.5) * 3, pz = z + nz * o + uz * (R() - 0.5) * 3;
        if (Math.abs(px) > half - 3 || Math.abs(pz) > half - 3 || this.net.hit(px, pz, 3) || this.terrain.cutSDF(px, pz) < 1.4) continue;
        if (R() < (k ? 0.25 : 0.55)) { items.push([R() < 0.5 ? 'bush_a' : 'bush_b', trs(px, this.terrain.heightAt(px, pz), pz, R() * 6.28, 0.8 + R() * 0.7)]); this.nav.circle(px, pz, 1.0, 4); }
        else if (R() < (k ? 0.12 : 0.3)) { const n = R() < 0.5 ? 'tree_poplar_leafy' : R() < 0.5 ? 'tree_acacia_leafy' : 'tree_acacia_shelled'; if (this.tpl(n) && !this.solidHit(px, pz, 0.45, 0.45, 0, 0.3)) { items.push([n, trs(px, this.terrain.heightAt(px, pz), pz, R() * 6.28, 0.7 + R() * 0.4)]); this.nav.circle(px, pz, 0.45, BLOCK); this.solidAdd(px, pz, 0.4, 0.4, 0, 'tree'); } }
      }
      this.concealRect(x - 7, z - 7, x + 7, z + 7, 120);
    });
    // village streets: walnut / acacia / poplar in front of the plots
    if (!urban) for (const r of D.roads) {
      if (r.type !== 'gravel' && r.type !== 'paved') continue;
      for (const sd of [-1, 1]) walk(r.pts, 9 + R() * 4, (x, z, ux, uz) => { if (R() > 0.34) return; const o = r.w / 2 + 2.4 + R() * 1.5, px = x - uz * o * sd, pz = z + ux * o * sd; if (!this.inPlot(px - uz * 3 * sd, pz + ux * 3 * sd)) return; tree(R() < 0.45 ? 'tree_walnut_leafy' : R() < 0.5 ? 'tree_poplar_leafy' : pick(0.45), px, pz, 0.75 + R() * 0.4); });
    }
    // urban: street trees along the verges, courtyard trees on the lawns between the blocks
    if (urban) {
      for (const r of D.roads) {
        if (r.type !== 'street' && r.type !== 'paved') continue;
        for (const sd of [-1, 1]) walk(r.pts, 10 + R() * 3, (x, z, ux, uz) => { if (R() > 0.6) return; const o = r.w / 2 + swOf(r) + 1.6, px = x - uz * o * sd, pz = z + ux * o * sd; tree(R() < 0.75 ? (R() < 0.6 ? 'leafy_summer_chestnut' : 'leafy_summer_birch') : cityT[2 + Math.floor(R() * 4)], px, pz, 0.85 + R() * 0.3); });
      }
      for (let i = 0; i < 900; i++) {
        const x = (R() - 0.5) * (MAP_SIZE - 30), z = (R() - 0.5) * (MAP_SIZE - 30);
        if (this.inPlot(x, z) || this.areaIs(x, z, ['farmland', 'parking', 'pitch', 'garages', 'industrial', 'railway'])) continue;
        if (!this.areaIs(x, z, ['residential', 'school', 'kindergarten', 'hospital', 'grass', 'grassland', 'meadow', 'park']) && R() < 0.7) continue;
        if (this.overlapsBuilding(x, z, 0.5, 0.5, 4)) continue;
        tree(R() < 0.7 ? (R() < 0.5 ? 'leafy_summer_chestnut' : 'leafy_summer_birch') : cityT[2 + Math.floor(R() * 4)], x, z, 0.8 + R() * 0.4);
      }
    }
    // instance per species: near full model, mid / far lod1, coarse far blocks
    const by = new Map(), v = new THREE.Vector3();
    for (const [n, M] of items) { v.setFromMatrixPosition(M); if (this.terrain.cutSDF(v.x, v.z) < (/bush/.test(n) ? 1.2 : 1.6)) continue; M.elements[13] = this.baseY(v.x, v.z, 0.35, 0.35); (by.get(n) || by.set(n, []).get(n)).push(M); }
    for (const [n, mats] of by) {
      const t = this.tpl(n); if (!t) continue;
      const lod = lodOf(n) ? this.tpl(lodOf(n)) : null, mid = this.hasTpl(n + '_mid') ? this.tpl(n + '_mid') : null;
      instance(this.scene, t, mats, lod ? { lod, mid: mid || lod, nearDist: 14, lodDist: mid ? 175 : 80, cullDist: 1500, coarse: 3, cell: 180, midShadows: !/bush/.test(n), lodShadows: false } : { cell: 180, cullDist: 700, ...treeLod(t, 100, 220) });
    }
  },
  // ---------------------------------------------------------------- rail: ballast, sleepers, rails, platforms
  railReal() {
    const D = this.osm, lines = D.lines.filter(l => l.t === 'rail' || l.t === 'rail_old' || l.t === 'rail_siding');
    if (!lines.length) return;
    const ballast = new GeoBuf(), sleepers = [], railG = [];
    for (const l of lines) {
      const P = densify(l.pts, 6);
      ribbon(ballast, P, 2.1, 0.025, { uvMode: 'strip', tile: 3 });
      walk(P, 0.75, (x, z, ux, uz) => { if (!this.net.hit(x, z, 0.3)) sleepers.push(trs(x, 0.06, z, Math.atan2(-uz, ux) + Math.PI / 2, 1, 0, (this.rng() - 0.5) * 0.06)); });
      for (let i = 0; i < P.length - 1; i++) {
        const [ax, az] = P[i], [bx, bz] = P[i + 1], L = Math.hypot(bx - ax, bz - az), ry = Math.atan2(-(bz - az), bx - ax), nx = -(bz - az) / L, nz = (bx - ax) / L;
        for (const sd of [-0.76, 0.76]) railG.push(boxGeo(L, 0.14, 0.07, trs((ax + bx) / 2 + nx * sd, 0.09, (az + bz) / 2 + nz * sd, ry), 1));
        // rail cells: rough going for infantry (ballast), wheeled vehicles cross slowly
        for (let t = 0; t < L; t += 0.7) for (let o = -2; o <= 2; o += 0.8) { const k = this.nav.idx(ax + (bx - ax) * t / L + nx * o, az + (bz - az) * t / L + nz * o); if (k >= 0 && this.nav.cost[k] < 2) this.nav.cost[k] = 2; }
      }
    }
    const bm = new THREE.MeshStandardMaterial({ map: canvasTex(64, 64, (x, w, h) => { for (let i = 0; i < 900; i++) { const v = 80 + Math.random() * 70; x.fillStyle = `rgb(${v + 8},${v + 2},${v - 6})`; x.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 3, 2 + Math.random() * 3); } }), roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const g = ballast.geometry(); if (g) { const m = new THREE.Mesh(g, bm); m.receiveShadow = true; this.scene.add(m); }
    const sg = new THREE.BoxGeometry(2.6, 0.12, 0.24);
    instance(this.scene, new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ color: 0x4a3e33, roughness: 1 })), sleepers, { cell: 320, cullDist: 420, shadows: false });
    if (railG.length) { const m = new THREE.Mesh(mergeGeometries(railG), new THREE.MeshStandardMaterial({ color: 0x5a4c40, roughness: 0.55, metalness: 0.6 })); m.castShadow = true; this.scene.add(m); }
    // platforms (concrete slabs, 0.9 m high: low cover, vehicles go round)
    const pl = []; for (const a of D.areas) if (a.t === 'platform') { const [x0, z0, x1, z1] = polyBB(a.pts); const L = Math.hypot(a.pts[1][0] - a.pts[0][0], a.pts[1][1] - a.pts[0][1]); void L; const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2; const sh = new THREE.Shape(a.pts.map(p => new THREE.Vector2(p[0] - cx, -(p[1] - cz)))); const eg = new THREE.ExtrudeGeometry(sh, { depth: 0.9, bevelEnabled: false }); eg.rotateX(-Math.PI / 2); eg.translate(cx, 0, cz); pl.push(eg); for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) if (inPoly(x + 0.5, z + 0.5, a.pts)) { const k = this.nav.idx(x + 0.5, z + 0.5); if (k >= 0) { this.nav.cost[k] = Math.max(this.nav.cost[k], 6); this.nav.low[k] = 1; } } }
    for (const l of D.lines) if (l.t === 'platform') for (let i = 0; i < l.pts.length - 1; i++) { const [ax, az] = l.pts[i], [bx, bz] = l.pts[i + 1], L = Math.hypot(bx - ax, bz - az); pl.push(boxGeo(L, 0.9, 3.2, trs((ax + bx) / 2, 0, (az + bz) / 2, Math.atan2(-(bz - az), bx - ax)), 3)); this.nav.rect((ax + bx) / 2, (az + bz) / 2, L / 2, 1.6, Math.atan2(-(bz - az), bx - ax), 6, 0); }
    if (pl.length) { const m = new THREE.Mesh(mergeGeometries(pl.map(g => g.index ? g.toNonIndexed() : g)), new THREE.MeshStandardMaterial({ color: 0xa8a399, roughness: 0.95 })); m.castShadow = m.receiveShadow = true; this.scene.add(m); }
  },
  // ---------------------------------------------------------------- walls, fences, gas pipes, power lines (OSM lines)
  linesReal() {
    const R = this.rng, D = this.osm;
    for (const l of D.lines) {
      if (l.t === 'wall' || (l.t === 'fence' && this.urban)) {
        // walls: precast PO-2 panels (only tanks push through); fences: profiled sheet / mesh (anything flattens them)
        const wall = l.t === 'wall', n = wall ? (R() < 0.7 ? 'fence_po2_a' : 'fence_po2_b') : (R() < 0.6 ? 'fence_house_prof' : 'fence_house_plain'), t = this.tpl(n); if (!t) continue;
        const len = Math.max(2, t.userData.bb.max.x - t.userData.bb.min.x);
        walk(l.pts, len, (x, z, ux, uz) => { if (R() < (wall ? 0.18 : 0.3) || this.net.hit(x, z, 0.6) || this.terrain.cutSDF(x, z) < 2 || this.segBlocked(x, z, ux, uz, len) || this.solidHit(x, z, len / 2, 0.2, Math.atan2(-uz, ux), 0.05, k => k === 'fence')) return; if (this.put(wall && R() < 0.15 ? 'fence_po2_broken' : !wall && R() < 0.2 ? 'fence_house_broken' : n, x, z, Math.atan2(-uz, ux), { crush: wall ? 'tank' : 'any', check: false })) this.solidAdd(x, z, len / 2, 0.12, Math.atan2(-uz, ux), 'fence'); });
      } else if (l.t === 'pipe') {
        const t = this.tpl('pipe_straight_a'); if (!t) continue; const bb = t.userData.bb, len = Math.max(2, Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z)), alongX = (bb.max.x - bb.min.x) >= (bb.max.z - bb.min.z);
        walk(l.pts, len, (x, z, ux, uz) => { if (this.net.hit(x, z, 1) || this.net.hit(x + ux * len * 0.6, z + uz * len * 0.6, 0.8) || this.net.hit(x - ux * len * 0.6, z - uz * len * 0.6, 0.8) || this.terrain.cutSDF(x, z) < 2 || this.segBlocked(x, z, ux, uz, len * 1.3) || this.solidHit(x, z, len / 2, 0.3, Math.atan2(-uz, ux), 0.05)) return; const ry = Math.atan2(-uz, ux) + (alongX ? 0 : Math.PI / 2); this.put(R() < 0.12 ? 'pipe_straight_torn' : 'pipe_straight_a', x, z, ry, { cost: 5, low: true, check: false, inst: { cell: 300 } }); });
      }
    }
  },
  polesReal() {
    const T = this.templatesFrom('wires', { pole: /^(utility_)?pole|utility/i, concertina: /concertina|razor/i }); this.wireT = T;
    let pole = T.pole?.[0];
    if (!pole) { const conc = new THREE.MeshStandardMaterial({ color: 0x99958b, roughness: 0.9 }); pole = new THREE.Group(); const p = new THREE.Mesh(new THREE.BoxGeometry(0.22, 9.5, 0.22), conc); p.position.y = 4.75; pole.add(p); const a = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.1), conc); a.position.y = 9; pole.add(a); }
    const att = (() => { const pts = []; pole.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(pole.matrixWorld).invert(); pole.traverse(o => { if (!o.isMesh && /attach|wire|insul/i.test(o.name)) pts.push(o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv)); }); if (!pts.length) { const b = new THREE.Box3().setFromObject(pole); pts.push(new THREE.Vector3(0.7, b.max.y - b.min.y - 0.5, 0), new THREE.Vector3(-0.7, b.max.y - b.min.y - 0.5, 0)); } return pts; })();
    const lines = [], mats = [], R = this.rng, half = MAP_SIZE / 2;
    const run = (P, step) => {
      let prev = null;
      walk(P, step, (x, z, ux, uz) => {
        const ry = Math.atan2(-uz, ux) + Math.PI / 2;
        if (Math.abs(x) > half - 4 || Math.abs(z) > half - 4 || this.net.hit(x, z, 1.3) || this.solidHit(x, z, 0.6, 0.3, ry, 0.2) || this.terrain.cutSDF(x, z) < 1.5 || this.overlapsBuilding(x, z, 0.4, 0.4, 0.3)) { prev = null; return; }
        const broken = R() < 0.15, M = trs(x, this.baseY(x, z, 0.2, 0.2), z, ry, 1, broken ? (R() - 0.5) * 0.6 : (R() - 0.5) * 0.05, (R() - 0.5) * 0.06); mats.push(M);
        this.nav.circle(x, z, 0.4, BLOCK); this.solidAdd(x, z, 0.25, 0.25, 0, 'pole');
        const top = broken ? null : att.map(a => a.clone().applyMatrix4(M));
        if (prev && top) for (let q = 0; q < top.length; q++) { if (R() < 0.1) continue; const b = prev[q] && prev[q].distanceTo(top[q]) < 55 ? prev[q] : null; if (b) lines.push(catenary(b, top[q], 1.2 + R() * 0.7)); }
        else if (prev && !top) for (const a of prev) if (R() < 0.6) { const e = a.clone().add(new THREE.Vector3(ux * step * 0.35, 0, uz * step * 0.35)); e.y = 0.05; lines.push(catenary(a, e, 0.8)); }
        prev = top;
      });
    };
    for (const l of this.osm.lines) if (l.t === 'power') run(l.pts, 40);
    // distribution lines along the main streets, on the verge
    for (const r of this.osm.roads) {
      if (!(r.type === 'paved' || (this.urban ? r.type === 'street' : r.type === 'gravel' && lineLen(r.pts) > 250))) continue;
      const sd = R() < 0.5 ? -1 : 1, o = r.w / 2 + (this.urban ? swOf(r) + 0.7 : 2.2);
      const P = r.pts.map((p, i) => { const q = r.pts[Math.min(i + 1, r.pts.length - 1)], pr = r.pts[Math.max(i - 1, 0)], dx = q[0] - pr[0], dz = q[1] - pr[1], L = Math.hypot(dx, dz) || 1; return [p[0] - dz / L * o * sd, p[1] + dx / L * o * sd]; });
      run(P, this.urban ? 34 : 40);
    }
    if (mats.length) instance(this.scene, pole, mats, { cell: 320, cullDist: 650 });
    if (lines.length) { const g = mergeGeometries(lines.map(p => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(p), 10, 0.012, 3))); this.scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x1c1b19, roughness: 0.6, metalness: 0.4 }))); }
  },
  // ---------------------------------------------------------------- balkas along the streams (rural)
  balkasReal() {
    const T = this.terrain; T.roadTest = (x, z, pad) => onRoad(x, z, pad);
    const N = Math.round(MAP_SIZE), half = MAP_SIZE / 2, soft = new Uint8Array(N * N);
    for (const l of this.osm.lines) if (l.t === 'stream' && lineLen(l.pts) > 40) {
      const P = densify(l.pts, 3); T.balka(P, { top: 30, bot: 7, depth: 2.6, gap: 19 });
      // soft-relief mask (1 px / m): the terrain shader keeps the grass / steppe look in a balka (no trench-floor mud)
      for (let i = 0; i < P.length - 1; i++) { const [ax, az] = P[i], [bx, bz] = P[i + 1]; for (let z = Math.floor(Math.min(az, bz) - 18); z <= Math.max(az, bz) + 18; z++) for (let x = Math.floor(Math.min(ax, bx) - 18); x <= Math.max(ax, bx) + 18; x++) { const d = segD(x + 0.5, z + 0.5, ax, az, bx, bz), ii = x + half, jj = z + half; if (d < 17 && ii >= 0 && jj >= 0 && ii < N && jj < N) soft[jj * N + ii] = Math.max(soft[jj * N + ii], Math.min(255, (17 - d) * 60)); } }
    }
    const t = new THREE.DataTexture(soft, N, N, THREE.RedFormat, THREE.UnsignedByteType); t.flipY = false; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    this.softMask = t;
  },
  // ---------------------------------------------------------------- knocked-out armour, burnt cars, barricades
  warReal() {
    const R = this.rng, H = (x, z) => this.terrain.heightAt(x, z);
    const WT = wreckTemplates(this.assets, ['t72b3', 't72av_ua', 'bmp3', 'btr82a', 'btr80_ua', 'bradley_ua']);
    const by = new Map(), add = (key, grp, M) => { (by.get(key) || by.set(key, { grp, m: [] }).get(key)).m.push(M); };
    this.wreckSpots = [];
    for (const [x0, z0, ry, k, off] of MAP.wrecks || []) {
      const t = WT[k]; if (!t) continue;
      let x = x0, z = z0, ok = false;
      for (let i = 0; i < 24 && !ok; i++) { if (i) { x = x0 + (R() - 0.5) * 30; z = z0 + (R() - 0.5) * 30; } ok = this.terrain.cutSDF(x, z) > 7 && !this.net.hit(x, z, 2) && !this.overlapsBuilding(x, z, 2, 4, 1) && !this.solidHit(x, z, 1.9, 3.9, ry, 0.3) && !this.inPlot(x, z); }
      if (!ok) continue;
      const M = this.restM(x, z, ry, 1.6, 3.4, (R() - 0.5) * 0.06, (R() - 0.5) * 0.08); add(k + '_h', t.hull, M);
      if (t.turret && !off) add(k + '_t', t.turret, M.clone().multiply(new THREE.Matrix4().makeRotationY((R() - 0.5) * 1.2)));
      this.nav.rect(x, z, 1.75, 3.7, ry, BLOCK, 0.2); this.solidAdd(x, z, 1.75, 3.7, ry, 'wreck'); this.nav.addOccluder(x, z, 1.6, 3.4, ry, 2.2, null);
      this.wreckSpots.push([x, z]);
    }
    for (const [, v] of by) instance(this.scene, v.grp, v.m, { cullDist: 520 });
    // burnt cars on the verges of the paved / main streets
    const roads = this.osm.roads.filter(r => r.type === 'paved' || r.type === 'street' || r.type === 'gravel');
    for (let i = 0, n = 0; i < 200 && n < (this.urban ? 16 : 9); i++) {
      const r = roads[Math.floor(R() * roads.length)]; if (!r) break;
      const P = r.pts, k = Math.floor(R() * (P.length - 1)), [ax, az] = P[k], [bx, bz] = P[k + 1], t = R(), L = Math.hypot(bx - ax, bz - az) || 1, sd = R() < 0.5 ? -1 : 1, o = r.w / 2 - 1.1;
      const x = ax + (bx - ax) * t - (bz - az) / L * o * sd, z = az + (bz - az) * t + (bx - ax) / L * o * sd;
      if (Math.abs(x) > MAP_SIZE / 2 - 15 || Math.abs(z) > MAP_SIZE / 2 - 15 || this.terrain.cutSDF(x, z) < 6) continue;
      if (this.put(R() < 0.7 ? 'car_vaz2107_burnt' : 'car_vaz2107_burnt_sagged', x, z, Math.atan2(-(bz - az), bx - ax) + Math.PI / 2 + (R() - 0.5) * 0.6, { cost: BLOCK, check: false })) { n++; this.burntSpots.push([x, z, 4]); }
    }
    // hedgehogs / sandbags at the objectives' road approaches
    for (const o of MAP.objectives) {
      const n = this.net.near(o.x, o.z, 60, r => r.type !== 'track'); if (!n) continue;
      for (const sd of [-1, 1]) { const x = n.px + n.ux * sd * (16 + R() * 10), z = n.pz + n.uz * sd * (16 + R() * 10); for (let q = -1; q <= 1; q++) { const px = x - n.uz * q * 2.4, pz = z + n.ux * q * 2.4; if (q === 1 && R() < 0.5) continue; this.put('hedgehog_ibeam', px, pz, R() * 3, { cost: BLOCK, check: false }); } }
      for (let q = 0; q < 3; q++) { const a = R() * 6.28, d = 8 + R() * 10, x = o.x + Math.cos(a) * d, z = o.z + Math.sin(a) * d; if (!this.net.hit(x, z, 1)) this.put('sandbag_wall', x, z, a + Math.PI / 2, { cost: 7, low: true }); }
    }
  },
  // ---------------------------------------------------------------- minimap + map credit
  minimapBase(x, k, o) {
    const P = (p) => [(p[0] + o) * k, (p[1] + o) * k], poly = (pts, fill) => { x.fillStyle = fill; x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(...P(p)) : x.moveTo(...P(p))); x.closePath(); x.fill(); };
    const col = { farmland: '#5a5238', meadow: '#4d5232', grass: '#4b5034', grassland: '#4b5034', wood: '#2b3a20', forest: '#2b3a20', scrub: '#3a4628', industrial: '#4a4642', garages: '#4c4944', allotments: '#4a5030', park: '#3f4a2c', pitch: '#45553a', stadium: '#45553a', parking: '#55534e', railway: '#4a4642' };
    for (const a of this.osm.areas) if (col[a.t] && a.pts.length > 2) poly(a.pts, col[a.t]);
    x.fillStyle = '#5e5643'; for (const g of this.gardenPolys || []) poly(g, '#56503c');
    x.lineCap = 'round';
    for (const r of this.osm.roads) { x.strokeStyle = r.type === 'track' ? '#6e6248' : r.type === 'gravel' ? '#77705e' : '#6a6862'; x.lineWidth = Math.max(1, r.w * k); x.beginPath(); r.pts.forEach((p, i) => i ? x.lineTo(...P(p)) : x.moveTo(...P(p))); x.stroke(); }
    x.strokeStyle = '#2a2622'; x.lineWidth = Math.max(1, 2.5 * k); for (const l of this.osm.lines) if (/^rail/.test(l.t)) { x.beginPath(); l.pts.forEach((p, i) => i ? x.lineTo(...P(p)) : x.moveTo(...P(p))); x.stroke(); }
    x.strokeStyle = '#3d5a7a'; x.lineWidth = Math.max(1, 3 * k); for (const l of this.osm.lines) if (l.t === 'stream') { x.beginPath(); l.pts.forEach((p, i) => i ? x.lineTo(...P(p)) : x.moveTo(...P(p))); x.stroke(); }
  },
  minimapOver(x, k, o) {
    const P = (p) => [(p[0] + o) * k, (p[1] + o) * k];
    x.strokeStyle = '#2d3f22'; x.lineWidth = Math.max(2, 8 * k);
    for (const l of [...this.osm.lines.filter(l => l.t === 'tree_row'), ...(MAP.belts || []).map(p => ({ pts: p }))]) { x.beginPath(); l.pts.forEach((p, i) => i ? x.lineTo(...P(p)) : x.moveTo(...P(p))); x.stroke(); }
    x.fillStyle = '#a89f8c'; for (const [hx, hz, d] of this.houseSpots || []) { x.globalAlpha = d ? 0.5 : 1; x.fillRect((hx + o) * k - 1.5, (hz + o) * k - 1.5, 3, 3); } x.globalAlpha = 1;
    x.fillStyle = '#8b867a'; for (const [hx, hz, L, Dd, rot] of this.hallRects || []) { x.save(); x.translate((hx + o) * k, (hz + o) * k); x.rotate(-rot); x.fillRect(-L / 2 * k, -Dd / 2 * k, L * k, Dd * k); x.restore(); }
    x.fillStyle = '#2a2219'; for (const q of this.terrain.cuts) { x.beginPath(); q.pts.forEach((p, i) => i ? x.lineTo(...P(p)) : x.moveTo(...P(p))); x.closePath(); x.fill(); }
    x.strokeStyle = '#3a3128'; x.lineWidth = Math.max(1, 3 * k); for (const r of this.terrain.reliefs) if (r.type === 'ditch' && !r.soft) { x.beginPath(); r.pts.forEach((p, i) => i ? x.lineTo(...P(p)) : x.moveTo(...P(p))); x.stroke(); }
    x.fillStyle = 'rgba(230,225,210,0.75)'; x.font = '9px sans-serif'; x.fillText('© OpenStreetMap', 4, 440 - 5);
  },
  creditOverlay() {
    if (typeof document === 'undefined' || document.getElementById('osmCredit')) return;
    const d = document.createElement('div'); d.id = 'osmCredit'; d.textContent = OSM_CREDIT;
    Object.assign(d.style, { position: 'fixed', left: '8px', bottom: '4px', zIndex: 15, font: '10px sans-serif', color: 'rgba(235,230,215,0.75)', textShadow: '0 1px 2px #000', pointerEvents: 'none' });
    document.body.appendChild(d);
    // the minimap's compass letter marks the top edge: on a map turned 180 deg that is real south
    const n = document.querySelector('.mm-n'); if (n && MAP.north) n.textContent = MAP.north[1] > 0 ? 'S' : 'N';
  },
};

// ================================================================ rural: Robotyne
export class RealRural extends Farmland {
  static isReal = true;
  build() {
    const times = this.buildTimes = {}, step = (k, f) => { const t = performance.now(); f(); times[k] = Math.round(performance.now() - t); };
    this.realSetup();
    this.grassMax = this.quality === 'low' ? 48000 : this.quality === 'medium' ? 90000 : 130000; this.grassCull = 260; this.noOuterGrass = true;
    weatherEnv(this.assets);
    step('layout', () => this.layoutReal());
    step('ground', () => { this.ground(); this.roadsReal(); });
    step('classify', () => this.classifyBuildings());
    step('buildings', () => this.placeBuildings());
    step('balkas', () => this.balkasReal());
    step('fortifications', () => this.fortifications());
    step('halls', () => { this.hallsReal(); this.garagesReal(); });
    step('houses', () => { this.smallBuildings(); this.plotsReal(); });
    step('vegetation', () => this.vegetationReal());
    step('rubble', () => this.rubbleAndDebris());
    step('props', () => { this.polesReal(); this.linesReal(); this.propsLight(); this.warReal(); });
    step('trails', () => this.trailsReal());
    step('crops', () => this.cropsReal());
    step('flush', () => { this.flush(); this.moundsFlush(); });
    step('craters', () => this.craters());
    step('paint', () => this.paintGround());
    step('detail', () => battlefieldDetail(this));   // razor wire, war debris, scorched patches (battlefieldDetail.js)
    step('skyline', () => this.skyline());
    step('crush', () => this.buildCrushables());
    step('nav', () => this.nav.finalize());
    this.creditOverlay();
  }
  // fields (OSM farmland polygons), crater pre-roll, burns, hotspots
  layoutReal() {
    const R = this.rng, D = this.osm, T_PLOW = 0, T_STUB = 1, T_FALLOW = 2, T_SUN = 3, T_CORN = 4;
    this.fieldsR = D.areas.filter(a => a.t === 'farmland' && a.pts.length > 2).map((a, i) => {
      // long axis -> row direction
      let best = 0, ang = 0; for (let k = 0; k < a.pts.length; k++) { const p = a.pts[k], q = a.pts[(k + 1) % a.pts.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]); if (L > best) { best = L; ang = Math.atan2(q[1] - p[1], q[0] - p[0]); } }
      const r = R(), type = r < 0.2 ? T_PLOW : r < 0.4 ? T_STUB : r < 0.66 ? T_FALLOW : r < 0.86 ? T_SUN : T_CORN;
      return { pts: a.pts, bb: polyBB(a.pts), type, rowsX: Math.abs(Math.cos(ang)) > Math.abs(Math.sin(ang)), id: i + 1 };
    });
    this.fieldIdx = new PolyIndex(48); for (const f of this.fieldsR) this.fieldIdx.add(f.pts, f);
    // war layout: churned approach trails from the north (UA) and the Russian supply tracks, field fires, burnt belts
    this.trails = MAP.trails || [];
    this.lanes = [];
    this.burns = []; for (let i = 0; i < 16; i++) { const f = this.fieldsR[Math.floor(R() * this.fieldsR.length)]; if (!f) break; const [x0, z0, x1, z1] = f.bb; const x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0); if (inPoly(x, z, f.pts)) this.burns.push([x, z, 22 + R() * 30]); }
    this.burntBelts = (MAP.belts || []).map(p => [p[0][0], p[0][1], p[p.length - 1][0], p[p.length - 1][1]]);
    const kind = {}; for (const f of MAP.fortifications || []) if (f.type === 'sp') kind[f.id] = f.kind || 'sp';
    this.hotspots = []; for (const f of MAP.fortifications || []) if (f.type === 'fire') { const n = f.base.length; let x = 0, z = 0; for (const p of f.base) { x += p[0]; z += p[1]; } const k = kind[f.sp]; this.hotspots.push([x / n, z / n, k === 'line' ? 2.4 : k === 'outpost' ? 1.1 : 1.5]); }
    this.craterList = [];
    const half = MAP_SIZE / 2, push = (x, z, bigP = 0.1) => { if (Math.abs(x) > half - 12 || Math.abs(z) > half - 12) return; if (Math.abs(z) > half - 80 && R() < 0.8) return; if (onRoad(x, z, 2) && R() < 0.85) return; const big = R() < bigP * 0.6; this.craterList.push([x, z, big ? 4.4 + R() * 3 : 1.3 + R() * 2.6]); };
    const gauss = () => (R() + R() + R() - 1.5) / 1.5;
    for (const [x, z, k] of this.hotspots) { const n = Math.round(24 * k); for (let i = 0; i < n; i++) { const a = R() * 6.28, r = 12 + Math.abs(gauss()) * 70; push(x + Math.cos(a) * r, z + Math.sin(a) * r * 0.8, 0.16); } }
    for (const o of MAP.objectives) for (let i = 0; i < 40; i++) { const a = R() * 6.28, r = Math.abs(gauss()) * 90; push(o.x + Math.cos(a) * r, o.z + Math.sin(a) * r, 0.14); }
    // the village took weeks of shelling: dense scatter over the built-up area, lighter on the fields
    for (const p of D.plots || []) if (R() < 0.8) { const [a, b, c] = p.pts; push(a[0] + (c[0] - a[0]) * R(), a[1] + (c[1] - a[1]) * R(), 0.08); }
    for (let i = 0; i < 700; i++) push((R() - 0.5) * (MAP_SIZE - 30), (R() - 0.5) * (MAP_SIZE - 30), 0.1);
  }
  fieldIndex() { return 0; }
  // trench / relief surface: as the farmland one, but no dark damp floor / puddles inside a balka (soft-relief mask)
  trenchTopMat() {
    const m = City.prototype.trenchTopMat.call(this), base = m.onBeforeCompile, key = m.customProgramCacheKey, U = { tSoft: { value: this.softMask || (() => { const t = new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat); t.needsUpdate = true; return t; })() } };
    m.customProgramCacheKey = () => key() + '_balka';
    m.onBeforeCompile = (sh, r) => {
      base(sh, r); Object.assign(sh.uniforms, U);
      sh.fragmentShader = sh.fragmentShader.replace('uniform sampler2D tDirt,', 'uniform sampler2D tSoft; uniform sampler2D tDirt,')
        .replace('float tdep = smoothstep(0.05, 0.55, -vWPos.y);', 'float tSoftV = texture2D(tSoft, clamp(vWPos.xz / splatSize + 0.5, 0.0, 1.0)).r; float tdep = smoothstep(0.05, 0.55, -vWPos.y) * (1.0 - tSoftV);')
        .replace('float tfl = smoothstep(0.55, 0.95, -ty);', 'float tfl = smoothstep(0.55, 0.95, -ty) * (1.0 - tSoftV);');
    };
    return m;
  }
  inForest(x, z, pad = 0) { return this.inWood(x, z) || (pad > 0 && this.inWood(x + pad, z)); }
  nearBurntBelt(x, z, pad = 0) { for (const [a, b, c, d] of this.burntBelts || []) if (this.segDist(x, z, [a, b], [c, d]) < 8 + pad) return true; return false; }
  // churned trails (MAP.trails) as track ribbons; trail cells count as dirt road for vehicles
  trailsReal() {
    if (!this.trails.length) { this.trailM = new Uint8Array(this.CN * this.CN); this.trailSamples = []; return; }
    this.warDressingTrailsOnly = true;
    const pos = [], uv = [], idx = [], H = (x, z) => this.terrain.heightAt(x, z), R = this.rng;
    this.trailM = new Uint8Array(this.CN * this.CN); const samples = this.trailSamples = [];
    for (const T of this.trails) {
      const curve = new THREE.CatmullRomCurve3(T.pts.map(p => new THREE.Vector3(p[0], 0, p[1])), false, 'centripetal'), L = curve.getLength(), n = Math.max(2, Math.ceil(L / 1.6)), pts = [];   // 1.6 m: the ribbon follows small hollows (no span over a dip)
      let prev = -1, along = 0, last = null;
      for (let i = 0; i <= n; i++) {
        const p = curve.getPointAt(i / n), t = curve.getTangentAt(i / n), nx = -t.z, nz = t.x; if (last) along += p.distanceTo(last); last = p;
        const w = T.w * (1 + 0.14 * Math.sin(along * 0.07 + T.pts[0][0]) + 0.08 * (R() - 0.5));
        const ok = Math.abs(p.x) < MAP_SIZE / 2 - 2 && Math.abs(p.z) < MAP_SIZE / 2 - 2 && this.terrain.cutSDF(p.x, p.z) > w * 0.5 + 1.4 && !this.terrain.relief(p.x, p.z, false) && !onRoad(p.x, p.z, 1) && !this.overlapsBuilding(p.x, p.z, w / 2, w / 2, 0.5) && !this.solidHit(p.x, p.z, w / 2, w / 2, 0, 0, k => k !== 'house');
        if (!ok) { prev = -1; continue; }
        pts.push([p.x, p.z]); const a = pos.length / 3;
        // 5 vertices across (the ribbon is 4-5 m wide: two edge vertices bridged furrows / rims and left the middle buried)
        for (const sd of [-1, -0.5, 0, 0.5, 1]) { const x = p.x + nx * sd * w / 2, z = p.z + nz * sd * w / 2; pos.push(x, H(x, z) + 0.045, z); uv.push((sd + 1) / 2, along / 4.5); }
        if (prev >= 0) for (let k = 0; k < 4; k++) idx.push(prev + k, prev + k + 1, a + k, prev + k + 1, a + k + 1, a + k); prev = a;
        for (let o = -w / 2; o <= w / 2; o += 0.8) { const x = p.x + nx * o, z = p.z + nz * o, ci = this.nav.idx(x, z); if (ci >= 0 && this.nav.cost[ci] !== BLOCK) this.nav.road[ci] = Math.max(this.nav.road[ci], 1); const i2 = Math.floor((x + MAP_SIZE / 2) / this.CS), j2 = Math.floor((z + MAP_SIZE / 2) / this.CS); if (i2 >= 0 && j2 >= 0 && i2 < this.CN && j2 < this.CN) this.trailM[j2 * this.CN + i2] = 1; }
      }
      samples.push({ pts, w: T.w, mud: T.mud ?? 0.9 });
    }
    if (idx.length && this.trackMat) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); const nr = g.attributes.normal; for (let i = 0; i < nr.count; i++) nr.setXYZ(i, 0, 1, 0);
      const tm = this.trackMat.clone(); tm.color.multiplyScalar(0.78); tm.onBeforeCompile = this.trackMat.onBeforeCompile; tm.customProgramCacheKey = this.trackMat.customProgramCacheKey;
      const m = new THREE.Mesh(g, tm); m.receiveShadow = true; m.renderOrder = 1; m.name = 'trails'; this.scene.add(m);
    }
  }
  propsLight() {
    const T = this.templatesFrom('props', { car: /car|sedan|vaz|lada|zhiguli/i, hedgehog: /hedgehog/i, sandbag: /sandbag/i, tyre: /tyre|tire/i, crater: /crater/i }); this.propT = T;
    const R = this.rng;
    // abandoned farm machinery in the yards / field edges, hay
    for (const [x, z, r] of [[-190, 455, 0.7], [-150, 470, 2.2], [-210, 500, 1.4]]) this.put(R() < 0.6 ? 'tractor_mtz80_burnt' : 'trailer_farm', x + (R() - 0.5) * 20, z + (R() - 0.5) * 16, r, { cost: BLOCK, low: true });
    for (let i = 0; i < 26; i++) { const f = this.fieldsR[Math.floor(R() * this.fieldsR.length)]; if (!f) break; const [x0, z0, x1, z1] = f.bb, x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0); if (!inPoly(x, z, f.pts) || edgeDist(x, z, f.pts) > 25) continue; this.put(R() < 0.4 ? 'haybale_round_burnt' : R() < 0.5 ? 'haystack' : 'haybale_round', x, z, R() * 6, { cost: 7, low: true, circle: 1.6 }); }
    for (let i = 0; i < 50; i++) { const x = (R() - 0.5) * (MAP_SIZE - 80), z = (R() - 0.5) * (MAP_SIZE - 200), ci = this.nav.idx(x, z); if (ci >= 0 && this.nav.cost[ci] === 1 && !onRoad(x, z, 2) && T.tyre && this.terrain.cutSDF(x, z) > 4) this.putProp('tyre', x, z, R() * 6, 0); }
  }
  // crops in the OSM field polygons
  cropsReal() {
    const R = this.rng, cap = this.quality === 'low' ? 7000 : this.quality === 'medium' ? 12000 : 16000, inst = { shadows: this.quality === 'high', cullDist: this.quality === 'high' ? 300 : 230, cell: 180 };
    const area = this.fieldsR.reduce((a, f) => a + polyArea(f.pts) * (f.type >= 2 ? 1 : 0), 0) || 1;
    for (const f of this.fieldsR) {
      if (f.type < 2) { this.concealPoly(f.pts, 215); continue; }
      const name = f.type === 3 ? 'sunflower_dead_clump' : f.type === 4 ? 'corn_dry_clump' : 'weeds_tall_clump';
      const along = f.type === 2 ? 3.4 : 1.7, across = f.type === 2 ? 3.4 : 1.45, keep = Math.min(1, cap / (area / (along * across)));
      const [x0, z0, x1, z1] = f.bb;
      for (let a = (f.rowsX ? x0 : z0) + 4; a < (f.rowsX ? x1 : z1) - 4; a += along) for (let b = (f.rowsX ? z0 : x0) + 4; b < (f.rowsX ? z1 : x1) - 4; b += across) {
        if (R() > keep) continue;
        const x = (f.rowsX ? a : b) + (R() - 0.5) * (f.type === 2 ? 3 : 0.5), z = (f.rowsX ? b : a) + (R() - 0.5) * (f.type === 2 ? 3 : 0.5);
        if (!inPoly(x, z, f.pts) || edgeDist(x, z, f.pts) < 5) continue;
        const pn = this.noise2(x / 26, z / 26, 11); if (pn < (f.type === 2 ? 0.45 : 0.22) || (pn < 0.35 && R() < 0.5)) continue;
        if (onRoad(x, z, 2.5) || this.nearCrater(x, z, 0.9) || this.onTrail(x, z) || (this.inBurn(x, z) && R() < 0.8) || this.terrain.cutSDF(x, z) < 1.4 || this.uneven(x, z, 0.8) > 0.25) continue;
        const ci = this.nav.idx(x, z); if (ci < 0 || this.nav.cost[ci] !== 1) continue;
        this.put(name, x, z, R() * 6.28, { s: 0.8 + R() * 0.45, cost: 0, check: false, trench: false, inst, rx: (R() - 0.5) * 0.12, rz: (R() - 0.5) * 0.12 });
      }
      this.concealPoly(f.pts, f.type === 2 ? 215 : 140);
    }
  }
  concealPoly(P, v) { const [x0, z0, x1, z1] = polyBB(P); for (let z = z0; z < z1; z += 2) for (let x = x0; x < x1; x += 2) if (inPoly(x + 1, z + 1, P)) this.concealRect(x, z, x + 1.9, z + 1.9, v); }
  // war map + splat (R fallow / grass, G ploughed, B stubble, A packed) and row direction from the field polygons
  paintGround() {
    this.paintRealWar();
    const N = 1792, k = N / MAP_SIZE, o = MAP_SIZE / 2, out = new Uint8Array(N * N * 4), R = this.rng;
    const TM = this.terrain.maskData, TN = this.terrain.maskN;
    const layer = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; };
    const blurred = (src, px) => { const c = layer(), x = c.getContext('2d'); x.filter = `blur(${px}px)`; x.drawImage(src, 0, 0); return x; };
    const P = (x, z) => [(x + o) * k, (z + o) * k], path = (ctx, pts, close) => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(...P(p[0], p[1])) : ctx.moveTo(...P(p[0], p[1]))); if (close) ctx.closePath(); };
    const yards = layer(), yx = yards.getContext('2d'); yx.fillStyle = '#fff'; yx.strokeStyle = '#fff'; yx.lineCap = 'round'; yx.lineJoin = 'round';
    const gard = layer(), gx = gard.getContext('2d'); gx.fillStyle = '#fff';
    const verge = layer(), vx = verge.getContext('2d'); vx.strokeStyle = '#fff'; vx.fillStyle = '#fff'; vx.lineCap = 'round';
    const fld = layer(), fx = fld.getContext('2d');
    for (const f of this.fieldsR) { fx.fillStyle = `rgb(${f.id},0,0)`; path(fx, f.pts, true); fx.fill(); }
    for (const r of this.osm.roads) { yx.globalAlpha = r.type === 'paved' ? 0.55 : 0.7; yx.lineWidth = (r.w + (r.type === 'paved' ? 6 : 3)) * k; path(yx, r.pts); yx.stroke(); }
    for (const p of this.yardPolys) { yx.globalAlpha = 0.55; path(yx, p, true); yx.fill(); }
    for (const b of this.buildings) { yx.save(); yx.translate(...P(b.x, b.z)); yx.rotate(-b.rot); yx.globalAlpha = 0.7; yx.fillRect((-b.L / 2 - 6) * k, (-b.D / 2 - 6) * k, (b.L + 12) * k, (b.D + 12) * k); yx.restore(); }
    for (const [x, z, L, Dd, rot] of this.hallRects || []) { yx.save(); yx.translate(...P(x, z)); yx.rotate(-rot); yx.globalAlpha = 0.75; yx.fillRect((-L / 2 - 7) * k, (-Dd / 2 - 7) * k, (L + 14) * k, (Dd + 14) * k); yx.restore(); }
    for (const a of this.osm.areas) if (a.t === 'industrial' || a.t === 'school') { yx.globalAlpha = 0.45; path(yx, a.pts, true); yx.fill(); }
    for (const g of this.gardenPolys) { gx.globalAlpha = 0.5 + R() * 0.4; path(gx, g, true); gx.fill(); }
    // grass verges along roads / tracks (ground look v6): road -> packed / gravel shoulder (yards layer) -> worn grass -> field
    for (const r of this.osm.roads) if (r.type !== 'drive') { vx.globalAlpha = r.type === 'paved' ? 0.85 : 0.6; vx.lineWidth = (r.w + (r.type === 'paved' ? 15 : 8)) * k; path(vx, r.pts); vx.stroke(); }
    for (const l of [...this.osm.lines.filter(l => l.t === 'tree_row' || l.t === 'hedge' || l.t === 'stream'), ...(MAP.belts || []).map(p => ({ pts: p }))]) { vx.lineWidth = 20 * k; vx.globalAlpha = 1; path(vx, l.pts); vx.stroke(); }
    for (const a of this.osm.areas) if (['grass', 'meadow', 'wood', 'forest', 'scrub'].includes(a.t)) { vx.globalAlpha = 0.9; path(vx, a.pts, true); vx.fill(); }
    yx.globalAlpha = 1;
    // wheel ruts across the fields: road / track -> across the field -> the next road / track / trail (or off the map);
    // never a line that starts or stops in the middle of a field (fieldRuts)
    {
      const roads = this.osm.roads.filter(r => r.type !== 'drive' && r.pts.length > 1), rows = [...this.osm.lines.filter(l => l.t === 'tree_row' || l.t === 'hedge'), ...(MAP.belts || []).map(p => ({ pts: p }))];
      const nearLine = (x, z, L, d) => { for (let i = 0; i < L.pts.length - 1; i++) if (segD(x, z, L.pts[i][0], L.pts[i][1], L.pts[i + 1][0], L.pts[i + 1][1]) < d) return true; return false; };
      const start = () => {
        const r = roads[Math.floor(R() * roads.length)], i = Math.floor(R() * (r.pts.length - 1)), [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < 8) return null;
        const t = 0.1 + R() * 0.8, ux = (bx - ax) / L, uz = (bz - az) / L, sd = R() < 0.5 ? -1 : 1, nx = -uz * sd, nz = ux * sd, o = r.w / 2 + 0.6;
        return [ax + (bx - ax) * t + nx * o, az + (bz - az) * t + nz * o, Math.atan2(nz, nx) + (R() - 0.5) * 0.24, r];
      };
      const hit = (x, z) => !!this.net.hit(x, z, 0.3) || this.onTrail(x, z);
      const bad = (x, z) => !this.fieldIdx.at(x, z).length || this.overlapsBuilding(x, z, 1, 1, 2) || this.solidHit(x, z, 1.2, 1.2, 0, 0) || this.inPlot(x, z) || this.terrain.cutSDF(x, z) < 2.5 || rows.some(l => nearLine(x, z, l, 6));
      this.ruts = fieldRuts(R, 30, start, (x, z) => hit(x, z), (x, z) => !hit(x, z) && bad(x, z), MAP_SIZE / 2);
      for (const pts of this.ruts) { yx.globalAlpha = 0.3 + R() * 0.25; yx.lineWidth = 2.6 * k; path(yx, pts); yx.stroke(); }
    }
    const Y = blurred(yards, 2 * k).getImageData(0, 0, N, N).data, G = blurred(gard, 1.6 * k).getImageData(0, 0, N, N).data, V = blurred(verge, 3 * k).getImageData(0, 0, N, N).data, F = fx.getImageData(0, 0, N, N).data;
    const byId = []; for (const f of this.fieldsR) byId[f.id] = f;
    // field type one-hot (R ploughed, G stubble, B fallow / steppe, none = crop rows), from a gently jittered lookup,
    // blurred ~2.5 m (ground look v7): fields fade into each other through a weedy balk, not on a hard wobbly line
    const fieldAt = new Uint8Array(N * N);
    const FT = blurred((() => { const c = layer(), x = c.getContext('2d'), im = x.createImageData(N, N), d = im.data;
      for (let j = 0; j < N; j++) { const z = j / k - o; for (let i = 0; i < N; i++) {
        const x2 = i / k - o, p = (j * N + i) * 4;
        const ji = Math.min(N - 1, Math.max(0, i + Math.round(((this.noise2(x2 / 30, z / 30, 7) - 0.5) * 3 + (this.noise2(x2 / 5, z / 5, 9) - 0.5)) * k))), jj = Math.min(N - 1, Math.max(0, j + Math.round(((this.noise2(x2 / 30, z / 30, 8) - 0.5) * 3 + (this.noise2(x2 / 5, z / 5, 10) - 0.5)) * k)));
        const id = F[(jj * N + ji) * 4], f = byId[id], t = f ? f.type : 2; fieldAt[j * N + i] = id;
        d[p] = t === 0 ? 255 : 0; d[p + 1] = t === 1 ? 255 : 0; d[p + 2] = t === 2 ? 255 : 0; d[p + 3] = 255;
      } }
      x.putImageData(im, 0, 0); return c; })(), 3.5 * k).getImageData(0, 0, N, N).data;
    for (let j = 0; j < N; j++) {
      const z = j / k - o;
      for (let i = 0; i < N; i++) {
        const x = i / k - o, p = (j * N + i) * 4;
        const f = byId[fieldAt[j * N + i]];
        const n1 = this.noise2(x / 22, z / 22, 1), n2 = this.noise2(x / 6, z / 6, 2);
        // per-type layers weighted by the blurred one-hot type (R channel: fallow, or steppe / village land off the fields)
        const oP = FT[p] / 255, oS = FT[p + 1] / 255, oF = FT[p + 2] / 255, oC = Math.max(0, 1 - oP - oS - oF);
        const rF = f ? 0.75 + n2 * 0.4 : 0.8 + n2 * 0.35, aF = f ? Math.max(0, 0.35 - n1) * 1.2 : Math.max(0, 0.32 - n1) * 1.1, gF = f ? 0 : Math.max(0, n1 - 0.78) * 1.5;
        let r = oP * Math.max(0, n1 - 0.72) * 2.5 + oS * Math.max(0, n1 - 0.65) * 1.8 + oF * rF + oC * (0.25 + n1 * 0.35);
        let g = oP + oF * gF + oC * (0.55 + n2 * 0.25), b = oS, a = oF * aF;
        const balk = Math.max(0, Math.min(1, (0.9 - Math.max(oP, oS, oF, oC)) / 0.35)) * (0.75 + n2 * 0.5);   // weedy balk between fields
        r = Math.max(r, balk * 0.95); g *= 1 - balk * 0.85; b *= 1 - balk * 0.85;
        const ver = V[p + 3] / 255, yd = Y[p + 3] / 255, gd = G[p + 3] / 255;   // alpha: white-on-transparent layers (v7)
        r = Math.max(r * (1 - ver), ver * (0.85 + n2 * 0.3)); g *= 1 - ver; b *= 1 - ver;
        if (gd > 0) { g = Math.max(g * (1 - gd * 0.8), gd * Math.max(0, this.noise2(x / 11, z / 11, 13) - 0.45) * 1.3); r = Math.max(r, gd * (0.6 + n1 * 0.4)); b *= 1 - gd; }   // gardens: abandoned beds going to weeds, a few dug patches
        a = Math.max(a, yd); r *= 1 - yd * 0.6; g *= 1 - yd * 0.8; b *= 1 - yd * 0.8;
        const fm = this.forestMask[Math.floor((z + o) / 4) * this.forestMN + Math.floor((x + o) / 4)];
        if (fm === 1) { r = 0.6 + n2 * 0.3; g = 0; b = 0; a = Math.max(a, 0.25 + n1 * 0.3); }
        const ti = Math.floor(x + o), tj = Math.floor(z + o);
        if (TM && ti >= 0 && tj >= 0 && ti < TN && tj < TN && TM[tj * TN + ti]) { g *= 0.05; r *= 0.2; b *= 0.05; a = Math.max(a * 0.5, 0.12); }   // fresh spoil: bare soil, no rows
        out[p] = Math.min(255, r * 255); out[p + 1] = Math.min(255, g * 255); out[p + 2] = Math.min(255, b * 255); out[p + 3] = Math.min(255, a * 255);
      }
    }
    const t = new THREE.DataTexture(out, N, N, THREE.RGBAFormat); t.flipY = false; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    this.groundUniforms.tSplat.value = t; this.splatData = out; this.splatN = N;
    // row direction (R) + headland distance (G) per field
    const RN = 512, rows = new Uint8Array(RN * RN * 4), rk = RN / MAP_SIZE;
    for (let j = 0; j < RN; j++) for (let i = 0; i < RN; i++) {
      const x = (i + 0.5) / rk - o, z = (j + 0.5) / rk - o, f = this.fieldIdx.at(x, z)[0], p = (j * RN + i) * 4;
      rows[p] = f?.rowsX ? 255 : 0; rows[p + 1] = f ? Math.min(255, edgeDist(x, z, f.pts) / 22 * 255) : 255;
    }
    const rt = new THREE.DataTexture(rows, RN, RN, THREE.RGBAFormat); rt.flipY = false; rt.magFilter = rt.minFilter = THREE.NearestFilter; rt.needsUpdate = true;
    this.groundUniforms.tRows.value = rt;
    this.grassClumps();
  }
  paintRealWar() {
    const R = this.rng;
    this.groundUniforms.tWar.value = paintWar(this, MAP_SIZE, { N: 1024, craterWet: 0.3, extra: ({ L, P, k, blob, line }) => {
      for (const [x, z, r] of this.burns) { const a = -0.9 + (R() - 0.5) * 0.6, ux = Math.cos(a), uz = Math.sin(a); for (let i = 0; i < 9; i++) { const t = (R() - 0.5) * 2.2 * r, o = (R() - 0.5) * r * 0.7; blob(L.r, x + ux * t - uz * o, z + uz * t + ux * o, r * (0.18 + R() * 0.26), 0.7, 0.85); } }
      for (const [a, b, c, d] of this.burntBelts) { line(L.r, [[a, b], [c, d]], 12, 0.35); }
      for (const [x, z, r] of this.burntSpots || []) { blob(L.r, x, z, r, 0.8); blob(L.a, x, z, r * 0.8, 0.4); }
      for (const [x, z] of this.wreckSpots || []) { blob(L.r, x, z, 4.5 + R() * 2, 0.75); blob(L.g, x, z, 7, 0.4); blob(L.a, x, z, 8, 0.45); }   // (v7: a burnt-out vehicle scorches a few metres, not a 20 m disc)
      for (const [x, z, sc] of MAP.smoulder || []) blob(L.r, x, z, 14 * sc, 0.6);
      // mud: dirt / gravel streets (worst at junctions and gateways), trails, yards
      for (const r of this.osm.roads) {
        if (r.type === 'paved') { walk(r.pts, 20, (x, z, ux, uz) => { if (R() < 0.5) blob(L.b, x - uz * (r.w / 2 + 1.5) * (R() < 0.5 ? 1 : -1), z + ux * (r.w / 2 + 1.5), 1.5 + R() * 2.5, 0.8, 0.6); }); continue; }
        line(L.a, r.pts, r.w + 2, 0.3);
        walk(r.pts, 26, (x, z) => { blob(L.a, x, z, 3 + R() * 6, 0.45 + R() * 0.35); if (R() < 0.35) blob(L.b, x, z, 1.5 + R() * 3, 0.85, 0.6); });
      }
      for (const r of this.osm.roads) for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) if (this.net.hit(p[0], p[1], 1, r)) { blob(L.a, p[0], p[1], 8 + R() * 5, 0.8); blob(L.b, p[0] + (R() - 0.5) * 6, p[1] + (R() - 0.5) * 6, 3 + R() * 3, 0.8, 0.5); }
      for (const S of this.trailSamples || []) { if (S.pts.length < 2) continue; line(L.a, S.pts, S.w + 3, S.mud * 0.75); line(L.g, S.pts, S.w + 2, 0.18); }
      for (const p of this.yardPolys) { L.a.globalAlpha = 0.25; L.a.beginPath(); p.forEach((q, i) => i ? L.a.lineTo(...P(q[0], q[1])) : L.a.moveTo(...P(q[0], q[1]))); L.a.closePath(); L.a.fill(); }
      // staging grounds churned behind the deploy lines; old shelling over the village and the no-man's land
      const Z = MAP.deployZones;
      for (const zz of [(Z.player.z0 + Z.player.z1) / 2, (Z.enemy.z0 + Z.enemy.z1) / 2]) for (let i = 0; i < 40; i++) { const x = (R() - 0.5) * (MAP_SIZE - 80), z = zz + (R() - 0.5) * 30; blob(L.a, x, z, 4 + R() * 7, 0.32); }
      for (const p of this.osm.plots || []) if (R() < 0.35) blob(L.g, p.pts[0][0], p.pts[0][1], 10 + R() * 14, 0.14);
      for (let i = 0; i < 60; i++) blob(L.b, (R() - 0.5) * (MAP_SIZE - 40), (R() - 0.5) * (MAP_SIZE - 40), 2 + R() * 5, 0.45 + R() * 0.35, 0.7);
    } });
  }
}

// ================================================================ urban: Avdiivka
export class RealUrban extends City {
  static isReal = true;
  build() {
    const times = this.buildTimes = {}, step = (k, f) => { const t = performance.now(); f(); times[k] = Math.round(performance.now() - t); };
    this.realSetup();
    // ~80 panel blocks over 1.3 km: bigger kit cells (one InstancedMesh per kit piece per 320 m cell) keep the draw calls down
    setKitCell(320);
    this.grassMax = this.quality === 'low' ? 50000 : this.quality === 'medium' ? 80000 : 110000; this.grassCull = 280; this.noOuterGrass = true;
    this.lots = []; weatherEnv(this.assets);
    step('ground', () => { this.ground(); this.roadsReal(); });
    step('classify', () => this.classifyBuildings());
    step('buildings', () => { this.placeBuildings(); this.facadeDecals(); });
    step('fortifications', () => this.fortifications());
    step('halls', () => { this.hallsReal(); this.garagesReal(); });
    step('houses', () => { this.smallBuildings(); this.plotsReal(); });
    step('rubble', () => this.rubbleAndDebris());
    step('rail', () => this.railReal());
    step('vegetation', () => { this.linesReal(); this.vegetationReal(); });   // walls / fences / gas pipes first: trees keep clear
    step('props', () => { this.polesReal(); this.propsUrban(); this.warReal(); this.cityWrecksReal(); });
    step('flush', () => { this.flush(); this.moundsFlush(); });
    step('craters', () => this.craters());
    step('paint', () => this.paintGround());
    step('detail', () => battlefieldDetail(this));   // razor wire, war debris, scorched patches (battlefieldDetail.js)
    step('skyline', () => this.skylineReal());
    step('crush', () => this.buildCrushables());
    step('nav', () => this.nav.finalize());
    this.creditOverlay();
  }
  propsUrban() {
    const T = this.templatesFrom('props', { car: /car|sedan|vaz|lada|zhiguli/i, bus: /bus(?!_?stop)|paz|minibus/i, hedgehog: /hedgehog/i, sandbag: /sandbag/i, tyre: /tyre|tire/i, crater: /crater/i, playground: /playground|climb/i }); this.propT = T;
    const R = this.rng, D = this.osm;
    // playgrounds, sports pitches (goals), parking lots with cars
    for (const a of D.areas) {
      const [x0, z0, x1, z1] = polyBB(a.pts), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      if (a.t === 'playground') this.put(this.tpl('playground_modern') && R() < 0.6 ? 'playground_modern' : 'playground_climbing_frame', cx, cz, R() * 6, { cost: 6, roadPad: 3.5 });
      else if (a.t === 'pitch' && polyArea(a.pts) > 600) { const L = Math.max(x1 - x0, z1 - z0), ax = (x1 - x0) > (z1 - z0); for (const sd of [-1, 1]) this.put(R() < 0.5 ? 'goal_a' : 'goal_b', cx + (ax ? sd * (L / 2 - 4) : 0), cz + (ax ? 0 : sd * (L / 2 - 4)), (ax ? Math.PI / 2 : 0) + (sd > 0 ? Math.PI : 0), { cost: 4, check: false }); }
      else if (a.t === 'parking' && polyArea(a.pts) > 300) for (let i = 0; i < Math.min(8, polyArea(a.pts) / 120); i++) { const x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0); if (inPoly(x, z, a.pts)) this.put(['car_parked_lada', 'car_parked_lada_red', 'car_parked_moskvich', 'car_vaz2107_burnt', 'car_hatch_modern_burnt'][Math.floor(R() * 5)], x, z, R() < 0.5 ? 0 : Math.PI, { cost: BLOCK, roadPad: 0 }); }
    }
    // benches / bins / lamps on the block lawns, kiosks at the stops, bus stops
    for (const p of D.pois) if (p[3] === 'bus_stop' || p[3] === 'tram_stop') { const n = this.net.near(p[1], p[2], 20); if (n) { const sd = Math.sign((p[1] - n.px) * -n.uz + (p[2] - n.pz) * n.ux) || 1, o = n.hw + swOf(n.r || {}) + 1.2; this.put(this.tpl('bus_stop_modern') ? 'bus_stop_modern' : 'bus_stop', n.px - n.uz * o * sd, n.pz + n.ux * o * sd, Math.atan2(-n.uz, n.ux) + (sd > 0 ? Math.PI : 0), { cost: BLOCK, roadPad: 0 }); } }
    for (const b of this.buildings) for (const e of b.entrances) if (R() < 0.35) { const o = b.toWorld(0, 0, 0), dx = e.x - o.x, dz = e.z - o.z, d = Math.hypot(dx, dz) || 1; this.put(R() < 0.5 ? 'bench_concrete' : 'bin_a', e.x + dx / d * 3 + (R() - 0.5) * 4, e.z + dz / d * 3, b.rot, { cost: 4, low: true, roadPad: 0.9 }); }
    for (let i = 0; i < 40; i++) { const x = (R() - 0.5) * (MAP_SIZE - 60), z = (R() - 0.5) * (MAP_SIZE - 60), idx = this.nav.idx(x, z); if (idx >= 0 && this.nav.cost[idx] < 5 && T.tyre && !this.inPlot(x, z)) this.putProp('tyre', x, z, R() * 6, 0); }
  }
  putProp(type, x, z, ry, cost) { Farmland.prototype.putProp.call(this, type, x, z, ry, cost); }
  // knocked-out armour handled by warReal (MAP.wrecks); nothing on the carriageways
  cityWrecksReal() { }
  // urban splat: R lawn, G rubble / gravel, B mud, A trampled paths -- painted from the OSM layout
  paintGround() {
    this.paintCityWar();
    const N = 1280, k = N / MAP_SIZE, o = MAP_SIZE / 2, R = this.rng, D = this.osm;
    const layer = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; };
    const blurred = (src, px) => { const c = layer(), x = c.getContext('2d'); x.filter = `blur(${px}px)`; x.drawImage(src, 0, 0); return x; };
    const P = (x, z) => [(x + o) * k, (z + o) * k], path = (ctx, pts, close) => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(...P(p[0], p[1])) : ctx.moveTo(...P(p[0], p[1]))); if (close) ctx.closePath(); };
    const rub = layer(), rx = rub.getContext('2d'); rx.fillStyle = '#fff'; rx.strokeStyle = '#fff'; rx.lineCap = 'round';
    for (const b of this.buildings) { rx.save(); rx.translate(...P(b.x, b.z)); rx.rotate(-b.rot); rx.globalAlpha = 0.25 + R() * 0.15; rx.fillRect((-b.L / 2 - 3.5) * k, (-b.D / 2 - 3.5) * k, (b.L + 7) * k, (b.D + 7) * k); rx.restore(); }
    for (const [x, z, L, Dd, rot, ruined] of this.hallRects || []) { rx.save(); rx.translate(...P(x, z)); rx.rotate(-rot); rx.globalAlpha = ruined ? 0.7 : 0.4; rx.fillRect((-L / 2 - 5) * k, (-Dd / 2 - 5) * k, (L + 10) * k, (Dd + 10) * k); rx.restore(); }
    for (const a of D.areas) if (['industrial', 'garages', 'construction', 'railway', 'landfill', 'brownfield'].includes(a.t)) { rx.globalAlpha = 0.55; path(rx, a.pts, true); rx.fill(); }
    for (const l of D.lines) if (/^rail/.test(l.t)) { rx.globalAlpha = 0.8; rx.lineWidth = 7 * k; path(rx, l.pts); rx.stroke(); }
    const v = new THREE.Vector3(); rx.globalAlpha = 0.6;
    for (const list of this.rubbleInstances || []) for (const M of list) { v.setFromMatrixPosition(M); rx.beginPath(); rx.arc(...P(v.x, v.z), 3.5 * k, 0, 7); rx.fill(); }
    const pth = layer(), px = pth.getContext('2d'); px.strokeStyle = '#fff'; px.fillStyle = '#fff'; px.lineCap = 'round';
    for (const p of D.paths) { px.globalAlpha = 0.85; px.lineWidth = 2.2 * k; path(px, p); px.stroke(); }
    for (const a of D.areas) if (a.t === 'parking' || a.t === 'sand') { px.globalAlpha = 0.9; path(px, a.pts, true); px.fill(); }
    for (const b of this.buildings) for (const e of b.entrances) { const n = this.net.near(e.x, e.z, 70); if (!n) continue; px.globalAlpha = 0.75; px.lineWidth = 2.2 * k; px.beginPath(); px.moveTo(...P(e.x, e.z)); px.lineTo(...P(n.px, n.pz)); px.stroke(); }
    for (const p of this.yardPolys) { px.globalAlpha = 0.5; path(px, p, true); px.fill(); }
    const mud = layer(), mx = mud.getContext('2d'); mx.fillStyle = '#fff';
    const cm = this.craterMesh, M = new THREE.Matrix4(), sc = new THREE.Vector3(), q = new THREE.Quaternion();
    // craters: mud in the bowl only (v7: no mud disc / gravel ring around every crater in a lawn -- the war map's churn ring does the ejecta)
    if (cm) for (let i = 0; i < cm.count; i++) { cm.getMatrixAt(i, M); M.decompose(v, q, sc); mx.globalAlpha = 0.45; mx.beginPath(); mx.arc(...P(v.x, v.z), sc.x * 0.26 * k, 0, 7); mx.fill(); }
    for (const g of this.gardenPolys) { mx.globalAlpha = 0.25 + R() * 0.25; path(mx, g, true); mx.fill(); }
    // lawns: everything is lawn / verge, minus carriageways + pavements, building aprons, hard surfaces
    const lawn = layer(), lx = lawn.getContext('2d'); lx.fillStyle = '#fff'; lx.fillRect(0, 0, N, N);
    lx.globalCompositeOperation = 'destination-out'; lx.fillStyle = '#000'; lx.strokeStyle = '#000'; lx.lineCap = 'round'; lx.lineJoin = 'round';
    for (const r of D.roads) { const sw = r.type === 'street' || r.type === 'paved' || r.type === 'drive' ? swOf(r) + 0.5 : 0.8; lx.lineWidth = (r.w + sw * 2) * k; path(lx, r.pts); lx.stroke(); }
    for (const b of this.buildings) { lx.save(); lx.translate(...P(b.x, b.z)); lx.rotate(-b.rot); lx.fillRect((-b.L / 2 - 1.3) * k, (-b.D / 2 - 1.3) * k, (b.L + 2.6) * k, (b.D + 2.6) * k); lx.restore(); }
    for (const [x, z, L, Dd, rot] of this.hallRects || []) { lx.save(); lx.translate(...P(x, z)); lx.rotate(-rot); lx.fillRect((-L / 2 - 3) * k, (-Dd / 2 - 3) * k, (L + 6) * k, (Dd + 6) * k); lx.restore(); }
    for (const a of D.areas) if (['parking', 'garages', 'industrial', 'construction', 'railway', 'landfill', 'platform', 'sand'].includes(a.t)) { path(lx, a.pts, true); lx.fill(); }
    for (const l of D.lines) if (/^rail/.test(l.t)) { lx.lineWidth = 5 * k; path(lx, l.pts); lx.stroke(); }
    for (const p of D.paths) { lx.lineWidth = 1.6 * k; path(lx, p); lx.stroke(); }
    lx.globalCompositeOperation = 'source-over';
    const lawnB = layer(), lb = lawnB.getContext('2d'); lb.filter = `blur(${2.2 * k}px)`; lb.drawImage(lawn, 0, 0);
    const g1 = blurred(rub, 4 * k).getImageData(0, 0, N, N).data, g2 = blurred(pth, 1.2 * k).getImageData(0, 0, N, N).data, g3 = blurred(mud, 2 * k).getImageData(0, 0, N, N).data, g4 = lb.getImageData(0, 0, N, N).data;
    const out = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = i / k - o, z = j / k - o, p = (j * N + i) * 4, rubble = g1[p + 3] / 255, pathv = g2[p + 3] / 255, lw = g4[p + 3] / 255, n1 = this.noise2(x / 14, z / 14, 1);   // alpha (v7)
      const edge = Math.min(1, Math.max(0, lw + (this.noise2(x / 3.5, z / 3.5, 6) - 0.5) * 0.45 * (1 - Math.abs(lw * 2 - 1))));
      const grass = Math.max(edge * (0.84 + n1 * 0.16), 0.22 * this.noise2(x / 6, z / 6, 3)) * (1 - rubble * 0.6) * (1 - pathv * 0.5);
      const mudv = g3[p + 3] / 255 * (0.6 + this.noise2(x / 2, z / 2, 5) * 0.5);
      out[p] = grass * 255; out[p + 1] = Math.min(1, rubble * (0.35 + this.noise2(x / 4, z / 4, 4) * 0.8)) * 255; out[p + 2] = mudv * 255; out[p + 3] = Math.max(pathv, (1 - lw) * 0.5) * 255;
    }
    const t = new THREE.DataTexture(out, N, N, THREE.RGBAFormat); t.flipY = false; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    this.groundUniforms.tSplat.value = t; this.splatData = out; this.splatN = N;
    this.grassClumps();
  }
  // the town carries on past the playable square: low private-sector roofs, panel blocks to the west / north,
  // tree lumps, the main streets continue
  skylineReal() {
    const half = MAP_SIZE / 2, R = this.rng, mats = [], cols = [], tm = [];
    for (let i = 0; i < 1400; i++) {
      const x = (R() - 0.5) * (MAP_SIZE + 1100), z = (R() - 0.5) * (MAP_SIZE + 1100); if (Math.max(Math.abs(x), Math.abs(z)) < half + 14) continue;
      if (z > half - 60 && x < -60 && x > -half - 300) { if (R() < 0.3) tm.push([x, z]); continue; }   // the open field south-west
      const blocks = (x < -half + 100 || z < -half + 60) && x < 100 && R() < 0.35;
      if (blocks) { const L = 38 + Math.floor(R() * 4) * 9.6, H = 2.8 * (R() < 0.3 ? 9 : 5) + 0.6; mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() < 0.5 ? 0 : Math.PI / 2), new THREE.Vector3(L, H, 12.8))); cols.push(new THREE.Color().setHSL(0.09 + R() * 0.05, 0.06 + R() * 0.08, 0.34 + R() * 0.1)); }
      else if (R() < 0.55) { mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), R() * 3), new THREE.Vector3(8 + R() * 3, 3.2 + R() * 1.5, 7 + R() * 2))); cols.push(new THREE.Color().setHSL(0.04 + R() * 0.06, 0.1, 0.2 + R() * 0.1)); }
      else tm.push([x, z]);
    }
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
    const im = new THREE.InstancedMesh(box, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 }), mats.length); mats.forEach((M, i) => { im.setMatrixAt(i, M); im.setColorAt(i, cols[i]); }); im.castShadow = false; im.receiveShadow = true; this.scene.add(im);
    const tg = new THREE.IcosahedronGeometry(1, 1); tg.translate(0, 0.85, 0);
    const ti = new THREE.InstancedMesh(tg, new THREE.MeshStandardMaterial({ color: 0x3c4527, roughness: 1, flatShading: true }), tm.length); tm.forEach(([x, z], i) => { const s = 3 + R() * 2.5; ti.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(s, s * (1.1 + R() * 0.4), s))); }); ti.castShadow = false; this.scene.add(ti);
    // roads leaving the square continue straight out
    const asphalt = this.mat('asphalt', 1, { color: 0xd0ccc4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), B = new GeoBuf();
    for (const r of this.osm.roads) { if (r.type === 'track') continue; for (const [i, j] of [[0, 1], [r.pts.length - 1, r.pts.length - 2]]) { const p = r.pts[i], q = r.pts[j]; if (Math.max(Math.abs(p[0]), Math.abs(p[1])) < half) continue; const dx = p[0] - q[0], dz = p[1] - q[1], L = Math.hypot(dx, dz) || 1; ribbon(B, [p, [p[0] + dx / L * 380, p[1] + dz / L * 380]], r.w / 2, 0.05); } }
    const g = B.geometry(); if (g) { const m = new THREE.Mesh(g, asphalt); m.receiveShadow = true; this.scene.add(m); }
  }
}

// ================================================================ wiring
for (const C of [RealRural, RealUrban]) for (const [k, f] of Object.entries(Real)) if (!Object.prototype.hasOwnProperty.call(C.prototype, k)) C.prototype[k] = f;
// the template / instancing helpers of the farmland builder serve the urban map too (houses, sheds, fences, trees)
for (const k of ['tpl', 'burntTpl', 'hasTpl', 'hasReal', 'put', 'flush', 'overlapsBuilding', 'houseHit', 'houseNear', 'teethNear', 'concealAt', 'concealRect', 'segDist', 'nearCrater', 'onTrail', 'inBurn'])
  if (!Object.prototype.hasOwnProperty.call(RealUrban.prototype, k)) RealUrban.prototype[k] = Farmland.prototype[k];
REAL_WORLDS.rural = RealRural; REAL_WORLDS.urban = RealUrban;

// map-picker preview: the OSM layout (fields, woods, roads, rail, buildings) under the standard objective / zone marks
export function drawLayout(x, S, D) {
  const k = S / D.size, o = D.size / 2, P = p => [(p[0] + o) * k, (p[1] + o) * k];
  const col = { farmland: '#5a5238', wood: '#2f4a25', forest: '#2f4a25', scrub: '#3a4a2a', grass: '#4d5232', meadow: '#4d5232', industrial: '#4a4642', garages: '#4c4944', park: '#3f4a2c', pitch: '#45553a', stadium: '#45553a', allotments: '#4a5030' };
  for (const a of D.areas) if (col[a.t]) { x.fillStyle = col[a.t]; x.beginPath(); a.pts.forEach((p, i) => i ? x.lineTo(...P(p)) : x.moveTo(...P(p))); x.closePath(); x.fill(); }
  x.lineCap = 'round';
  for (const r of D.roads) { x.strokeStyle = r.type === 'track' ? '#7a6c55' : '#8a8a84'; x.lineWidth = Math.max(0.8, r.w * k * 1.4); x.beginPath(); r.pts.forEach((p, i) => i ? x.lineTo(...P(p)) : x.moveTo(...P(p))); x.stroke(); }
  x.strokeStyle = '#222'; x.lineWidth = 1.2; for (const l of D.lines) if (/^rail/.test(l.t)) { x.beginPath(); l.pts.forEach((p, i) => i ? x.lineTo(...P(p)) : x.moveTo(...P(p))); x.stroke(); }
  x.strokeStyle = '#2f4a25'; x.lineWidth = 2; for (const l of D.lines) if (l.t === 'tree_row') { x.beginPath(); l.pts.forEach((p, i) => i ? x.lineTo(...P(p)) : x.moveTo(...P(p))); x.stroke(); }
  x.fillStyle = '#c9c4b5';
  for (const b of D.buildings) { const c = Math.cos(b.rot), s = Math.sin(b.rot); for (const [bx, bz, L, Dd] of b.parts || [[b.x, b.z, b.L, b.D]]) { x.save(); x.translate(...P([bx, bz])); x.rotate(-b.rot); x.fillRect(-L / 2 * k, -Dd / 2 * k, Math.max(1, L * k), Math.max(1, Dd * k)); x.restore(); } void c; void s; }
}
for (const [id, D] of Object.entries(REAL_DATA)) if (MAPS[id]) MAPS[id].drawPreview = (ctx, S) => drawLayout(ctx, S, D);
