import * as THREE from 'three';
import { BLOCK } from './nav.js';
import { trs } from './instancer.js';

// Ground relief for the flat game world: field fortifications cut INTO the ground (trenches, firing cells, foxholes,
// dugout passages), smooth relief (anti-tank ditches, spoil berms, parapets, dugout mounds, shell craters) and rubble
// piles, all feeding one sparse heightfield that the game queries with groundHeight(x, z).
//
//   cuts     trench runs / crawl trenches / dugout passages are 'lines': a centre polyline + half width, S(p) =
//            distance to the polyline - half width (a chain of capsules: round outer bends, sharp inner ones, never
//            self-intersecting, open junctions by construction).  Firing cells, foxholes and MG pits are simple polygons
//            (exact signed distance to the edges).  Either is then pushed out by a noise field (widen(), scaled by the
//            cut's roughness) so outlines are ragged and widths uneven like hand-dug 2023-25 positions; lines never get
//            narrower than MIN_HW so the 0.4 m grid always resolves them.  Union = min over cuts.  Everything (heights,
//            nav, mask, meshes, dressing) reads the same displaced S, so collision and visuals agree.
//            Spoil / parapets are a function of S, lumpy and patchy (thrown out by hand, partly spread / hidden).
//   reliefs  ditches (polyline, trapezoid profile + spoil berm), mounds (rounded boxes; mesh:false = height only)
//            and shell craters (bowl + rim).
//   heights  16 m tiles of (CPT+1)^2 Float32 vertices at RES m, allocated only where something is non-flat.  Grid
//            cells the cut outline passes through (or near) are flagged: heightAt() evaluates them exactly (cutSDF ->
//            floor / battered wall profile / top surface), so the walkable height follows the ragged outline instead
//            of a 0.4 m bilinear staircase, and matches the rendered mesh.
//
// Rendering: the cut / relief areas get their own terrain mesh (same splat shader as the ground, plus depth
// darkening / mud) built by marching triangles on the heightfield grid: every grid triangle the outline crosses is
// clipped at the exact crossing points (bisection on S along the grid edges, shared by neighbouring triangles) into a
// top part (lip height) and a floor part; the raw-earth wall runs between the crossing points: battered (the floor is
// narrower than the lip), three rows of lumpy vertices between lip and floor.  No top triangle can span the cut.  The
// main ground plane discards fragments where the hole mask (1 px / m) is set.
const TS = 16, CPT = 40, RES = TS / CPT, VW = CPT + 1;   // heightfield tiles: 16 m, 0.4 m cells
const GR = RES;                                           // trench mesh grid == heightfield grid (shared vertices)
const BLK = 20;                                           // meshing block: 20 cells = 8 m
const SPOIL = 3.1;                                        // max reach of the spoil / parapet past the cut (m)
const CORR = 3.5;                                         // the terrain mesh covers the cut + this margin
const HC = 8;                                             // feature hash cell (m)
const HN = 2;                                             // near-outline hash cell (m), see sdfNear
const LOW = -0.02;                                        // terrain mesh rim, tucked just under the ground plane
const MIN_HW = 0.37;                                      // narrowest half width of a line cut (m): > grid diagonal / 2
const WALL_U = [0, 0.34, 0.64, 0.86, 1], WALL_F = [0, 0.09, 0.36, 0.7, 1];   // battered wall: inset / s0 -> fraction of the drop
// cut kinds: parapet front / rear height, nav cost (infantry), vehicle flag (1 = wheeled can't cross, 2 = no vehicle),
// rough = outline noise scale, batter = how far the wall foot creeps in (slumped raw earth)
const KIND = {
  fire: { pf: 0.38, pr: 0.26, cost: 3, veh: 1, rough: 1.0, batter: 1.0 }, comm: { pf: 0.27, pr: 0.27, cost: 3, veh: 1, rough: 0.85, batter: 0.9 },
  bay: { pf: 0.34, pr: 0.0, cost: 3, veh: 1, rough: 0.45, batter: 0.65 }, pass: { pf: 0.2, pr: 0.2, cost: 3, veh: 2, rough: 0.3, batter: 0.45 },
  pit: { pf: 0.32, pr: 0.24, cost: 4, veh: 2, rough: 0.5, batter: 0.7 },
};
const hkey = (x, z) => Math.floor(x / HC) * 8192 + Math.floor(z / HC);

// ---------------------------------------------------------------- noise (deterministic, C1)
function h2(i, j) { let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
export function vnoise(x, z) {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = h2(i, j), b = h2(i + 1, j), c = h2(i, j + 1), d = h2(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
// how much wider than drawn the cut is at (x, z) for roughness 1 (m, -0.24 .. +0.3): long uneven stretches, slumped
// bites out of the lip, small lumps
function widen(x, z) {
  return 0.3 * (vnoise(x * 0.11 + 3.1, z * 0.11 + 7.7) - 0.4) + 0.17 * (vnoise(x * 0.42 + 11.3, z * 0.42 + 1.9) - 0.5) + 0.07 * (vnoise(x * 1.05 - 4.2, z * 1.05 + 9.4) - 0.5);
}
// spoil amount / spread at (x, z): heaps, thin spread-out stretches, gaps where it was carried off or levelled
function spoilAt(x, z) {
  const lump = vnoise(x * 0.33 + 5.2, z * 0.33 + 2.4), l2 = vnoise(x * 0.9 + 1.7, z * 0.9 + 8.3), gap = vnoise(x * 0.07 + 9.1, z * 0.07 + 4.6);
  return [Math.min(1.6, Math.max(0.08, (gap - 0.24) * 2.3) * (0.5 + 0.8 * lump * lump + 0.3 * l2)), 0.72 + 0.58 * lump];
}

export class Terrain {
  constructor(size, nav, rng = Math.random) {
    this.size = size; this.half = size / 2; this.nav = nav; this.R = rng;
    this.TN = Math.ceil(size / TS); this.tiles = new Array(this.TN * this.TN).fill(null);
    this.tmax = new Float32Array(this.TN * this.TN); this.tmin = new Float32Array(this.TN * this.TN);
    this.cuts = []; this.reliefs = []; this.hCut = new Map(); this.hNear = new Map(); this.hRel = new Map();
    this.dress = new Map();   // piece name -> [Matrix4]
    this.blocks = new Set();  // 8 m meshing blocks touched by features
    this.maxH = 0; this._tplH = new Map();
    this._touch = []; this._stamp = 0; this._pd = null;
    this.roadTest = null;     // (x, z, pad) => bool, set by the map so trenches leave gaps at roads
    this.keepOut = null;      // (x, z) => bool, e.g. buildings / village yards
    this.covers = [];         // [x, z, ux, uz, width, kind] requested overhead cover (nets / branches / tarps)
  }
  // ================================================================ heightfield
  tile(ti, tj, make) { const k = tj * this.TN + ti; let t = this.tiles[k]; if (!t && make) { t = this.tiles[k] = new Float32Array(VW * VW); } return t; }
  // global vertex (gi, gj) sits at x = gi * RES - half; shared edge vertices are written into every tile that holds them
  writeV(gi, gj, h, max) {
    const a = Math.floor(gi / CPT), b = Math.floor(gj / CPT), TN = this.TN;
    for (let ti = gi % CPT === 0 ? a - 1 : a; ti <= a; ti++) for (let tj = gj % CPT === 0 ? b - 1 : b; tj <= b; tj++) {
      if (ti < 0 || tj < 0 || ti >= TN || tj >= TN) continue;
      const tk = tj * TN + ti, t = this.tiles[tk] || (max && h <= 0 ? null : this.tile(ti, tj, true)); if (!t) continue;
      const k = (gj - tj * CPT) * VW + (gi - ti * CPT), v = max ? Math.max(t[k], h) : h; t[k] = v;
      if (v > this.tmax[tk]) this.tmax[tk] = v; if (v < this.tmin[tk]) this.tmin[tk] = v; if (v > this.maxH) this.maxH = v;
    }
  }
  // Ground height (m, Y-up) at a world point: 0 on the flat, < 0 in trenches / ditches, > 0 on parapets, mounds, rubble.
  // Bilinear on the 0.4 m grid; cells the cut outline passes through are evaluated exactly (edgeH).
  heightAt(x, z) {
    const u = (x + this.half) / TS, v = (z + this.half) / TS, ti = Math.floor(u), tj = Math.floor(v);
    if (ti < 0 || tj < 0 || ti >= this.TN || tj >= this.TN) return 0;
    const tk = tj * this.TN + ti, t = this.tiles[tk]; if (!t) return 0;
    const fx = (u - ti) * CPT, fz = (v - tj) * CPT, i = Math.min(CPT - 1, fx | 0), j = Math.min(CPT - 1, fz | 0), a = fx - i, b = fz - j, k = j * VW + i;
    const ef = this.efl && this.efl[tk], f = ef ? ef[j * CPT + i] : 0;
    if (f) return this.edgeH(x, z, t, this.tops[tk], k, a, b, f);   // the cut outline passes here: exact
    return (t[k] * (1 - a) + t[k + 1] * a) * (1 - b) + (t[k + VW] * (1 - a) + t[k + VW + 1] * a) * b;
  }
  normalAt(x, z, out = new THREE.Vector3()) {
    const e = 0.45, hx = this.heightAt(x + e, z) - this.heightAt(x - e, z), hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
  }
  // Does the 3D segment a->b dip below the ground (parapet, trench wall, rubble mound)? Skips flat tiles cheaply;
  // ignores the first / last 0.7 m so a soldier's own footing never blocks him.
  segmentBlocked(ax, ay, az, bx, by, bz) {
    if (Math.min(ay, by) > this.maxH) return false;
    const L = Math.hypot(bx - ax, bz - az); if (L < 1.6) return false;
    const st = 0.5 / L, t0 = 0.7 / L, t1 = 1 - t0, TN = this.TN;
    for (let t = t0; t < t1; t += st) {
      const x = ax + (bx - ax) * t, z = az + (bz - az) * t, ti = Math.floor((x + this.half) / TS), tj = Math.floor((z + this.half) / TS);
      if (ti < 0 || tj < 0 || ti >= TN || tj >= TN) continue;
      const tk = tj * TN + ti, y = ay + (by - ay) * t;
      if (!this.tiles[tk] || y > this.tmax[tk]) { // jump to the tile exit
        const x0 = ti * TS - this.half, z0 = tj * TS - this.half, dx = bx - ax, dz = bz - az;
        let te = 1; if (dx > 1e-9) te = Math.min(te, (x0 + TS - ax) / dx); else if (dx < -1e-9) te = Math.min(te, (x0 - ax) / dx);
        if (dz > 1e-9) te = Math.min(te, (z0 + TS - az) / dz); else if (dz < -1e-9) te = Math.min(te, (z0 - az) / dz);
        if (te > t) t = te - st * 0.5; continue;
      }
      if (y < this.heightAt(x, z) - 0.04) return true;
    }
    return false;
  }
  // ================================================================ features
  // A cut is a simple polygon (firing cells, foxholes, MG pits) or a line (o.line = centre polyline, o.w = half width:
  // trench runs, crawl trenches, passages; pts is then only its mitred outline, used for dressing / map painting).
  // Polygon edges / line segments are hashed; S(p) per cut = exact signed distance to its edges (sign from the edge
  // normal, or the vertex pseudo-normal at corners) or distance to the centre line - max(MIN_HW, w + rough * widen(p));
  // polygons: minus rough * widen(p); union = min over cuts (overlaps stay negative, no seams).
  addPoly(pts, o) {
    pts = pts.map(p => [p[0], p[1]]);
    let area = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1]; }
    if (area < 0) pts.reverse();
    const n = pts.length, K = KIND[o.kind] || KIND.fire, id = this.cuts.length;
    const q = { pts, depth: o.depth, kind: o.kind, K, rough: o.rough ?? K.rough, front: o.front || null, revet: o.revet || null, sys: o.sys, segs: o.segs || null, w: o.w, tag: o.tag, id, edges: [], line: o.line || null };
    q.cx = pts.reduce((s, p) => s + p[0], 0) / n; q.cz = pts.reduce((s, p) => s + p[1], 0) / n;
    // hCut: 8 m cells, reach = spoil / mesh margin; hNear: 2 m cells, reach = 1.1 m past the widest wall (sdfNear)
    const hash = (e, x0, z0, x1, z1, m, mn) => {
      for (let x = Math.floor((x0 - m) / HC); x <= Math.floor((x1 + m) / HC); x++) for (let z = Math.floor((z0 - m) / HC); z <= Math.floor((z1 + m) / HC); z++) { const k = x * 8192 + z; (this.hCut.get(k) || this.hCut.set(k, []).get(k)).push(e); }
      for (let x = Math.floor((x0 - mn) / HN); x <= Math.floor((x1 + mn) / HN); x++) for (let z = Math.floor((z0 - mn) / HN); z <= Math.floor((z1 + mn) / HN); z++) { const k = x * 65536 + z; (this.hNear.get(k) || this.hNear.set(k, []).get(k)).push(e); }
    };
    const N = []; for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1; N.push([dz / L, -dx / L, L]); }
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], [nx, nz, L] = N[i], pa = N[(i + n - 1) % n], pb = N[(i + 1) % n];
      const e = { ax: a[0], az: a[1], bx: b[0], bz: b[1], nx, nz, L, q, wall: o.walls ? o.walls[i] : 1, pax: nx + pa[0], paz: nz + pa[1], pbx: nx + pb[0], pbz: nz + pb[1] };
      q.edges.push(e);
      if (!q.line) hash(e, Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), CORR + 1, 1.1 + 0.3 * q.rough);
    }
    if (q.line) {
      // capsule segments: the band out to the widest wall + mesh margin
      const P = q.line, m = (o.w || 0.5) + 0.35 * q.rough + CORR + 1;
      if (P.length === 1) P.push([P[0][0] + 0.01, P[0][1]]);
      for (let i = 0; i < P.length - 1; i++) {
        const [ax, az] = P[i], [bx, bz] = P[i + 1], e = { cap: true, ax, az, bx, bz, L: Math.max(1e-6, Math.hypot(bx - ax, bz - az)), q };
        hash(e, Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), m, Math.max(MIN_HW, (o.w || 0.5) + 0.3 * q.rough) + 1.1);
      }
    }
    const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
    q.bb = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
    if (q.line) { const hw = (o.w || 0.5) + 0.35 * q.rough; for (const [x, z] of q.line) { q.bb[0] = Math.min(q.bb[0], x - hw); q.bb[1] = Math.min(q.bb[1], z - hw); q.bb[2] = Math.max(q.bb[2], x + hw); q.bb[3] = Math.max(q.bb[3], z + hw); } }
    this.cuts.push(q); this._pd = null;
    this.markBlocks(q.bb[0] - CORR - 0.5, q.bb[1] - CORR - 0.5, q.bb[2] + CORR + 0.5, q.bb[3] + CORR + 0.5);
    return q;
  }
  markBlocks(x0, z0, x1, z1) { const B = BLK * GR; for (let i = Math.floor((x0 + this.half) / B); i <= Math.floor((x1 + this.half) / B); i++) for (let j = Math.floor((z0 + this.half) / B); j <= Math.floor((z1 + this.half) / B); j++) this.blocks.add(i * 8192 + j); }
  // local half width of a line cut at (x, z) (noise included, never below MIN_HW)
  halfW(q, x, z, D = widen(x, z)) { return Math.max(MIN_HW, q.w + q.rough * D); }
  // per-cut signed distances at (x, z) for the cuts whose edges are hashed here; returns the touched list.
  // this._pd[id] = displaced signed distance, this._pvx/_pvz[id] = vector from the nearest outline (polygon) or centre
  // line (line cut) point to (x, z)
  polyDists(x, z, l = this.hCut.get(hkey(x, z))) {
    this._touch.length = 0; if (!l) return this._touch;
    if (!this._pd || this._pd.length < this.cuts.length) { const n = this.cuts.length + 64; this._pd = new Float64Array(n); this._ps = new Float64Array(n); this._pst = new Uint32Array(n); this._pvx = new Float64Array(n); this._pvz = new Float64Array(n); }
    const st = ++this._stamp, pd = this._pd, ps = this._ps, pst = this._pst, pvx = this._pvx, pvz = this._pvz, touch = this._touch;
    for (let n = 0; n < l.length; n++) {
      const e = l[n], dx = e.bx - e.ax, dz = e.bz - e.az, wx = x - e.ax, wz = z - e.az;
      let t = (wx * dx + wz * dz) / (e.L * e.L); let sx, sz;
      if (e.cap) { t = t < 0 ? 0 : t > 1 ? 1 : t; sx = 0; sz = 0; }
      else if (t <= 0) { t = 0; sx = e.pax; sz = e.paz; } else if (t >= 1) { t = 1; sx = e.pbx; sz = e.pbz; } else { sx = e.nx; sz = e.nz; }
      const px = wx - dx * t, pz = wz - dz * t, d2 = px * px + pz * pz, id = e.q.id;
      if (pst[id] !== st) { pst[id] = st; pd[id] = d2; ps[id] = px * sx + pz * sz; pvx[id] = px; pvz[id] = pz; touch.push(id); }
      else if (d2 < pd[id] - 1e-12) { pd[id] = d2; ps[id] = px * sx + pz * sz; pvx[id] = px; pvz[id] = pz; }
    }
    let D = null; this._D = undefined;
    for (const id of touch) {
      const q = this.cuts[id], r = q.rough;
      if (q.line) { if (D === null) D = widen(x, z); pd[id] = Math.sqrt(pd[id]) - Math.max(MIN_HW, q.w + r * D); continue; }
      let d = (ps[id] < 0 ? -1 : 1) * Math.sqrt(pd[id]);
      if (r) { if (D === null) D = widen(x, z); d -= r * D; }
      pd[id] = d;
    }
    if (D !== null) this._D = D;   // widen(x, z), reused by s0At
    return touch;
  }
  // signed distance to the union of cuts (m, < 0 inside); this._q = the polygon it comes from (deepest inside)
  cutSDF(x, z) {
    const touch = this.polyDists(x, z); this._q = null; let best = 99;
    for (const id of touch) { const d = this._pd[id]; if (d < best) { best = d; this._q = this.cuts[id]; } }
    return best;
  }
  // cutSDF exact only within ~1 m of the outline (fine hash: much cheaper; 99 / a value > 1 further out)
  sdfNear(x, z) {
    const touch = this.polyDists(x, z, this.hNear.get(Math.floor(x / HN) * 65536 + Math.floor(z / HN))); this._q = null; let best = 99;
    for (const id of touch) { const d = this._pd[id]; if (d < best) { best = d; this._q = this.cuts[id]; } }
    return best;
  }
  // unit gradient of cutSDF (points out of the cut)
  grad(x, z) {
    const e = 0.05, gx = this.cutSDF(x + e, z) - this.cutSDF(x - e, z), gz = this.cutSDF(x, z + e) - this.cutSDF(x, z - e), L = Math.hypot(gx, gz);
    return L > 1e-6 ? [gx / L, gz / L] : [1, 0];
  }
  // parapet / parados / spoil height outside the cut: hand-thrown heaps, thicker on the enemy side, lumpy, with gaps
  parapet(x, z) {
    const touch = this.polyDists(x, z); if (!touch.length) return 0;
    let h = 0, sp = null;
    for (const id of touch) {
      const d = this._pd[id]; if (d < 0 || d > SPOIL) continue; const q = this.cuts[id];
      const fr = q.front ? (this._pvx[id] * q.front[0] + this._pvz[id] * q.front[1] > 0) : true;
      const H = fr ? q.K.pf : q.K.pr; if (H <= 0) continue;
      sp ||= spoilAt(x, z);
      const W = (fr ? 2.3 : 1.75) * sp[1], t = d / W;
      const prof = t < 0.1 ? 0.5 + 0.5 * t / 0.1 : t < 0.3 ? 1 : t < 1 ? Math.pow(1 - ((t - 0.3) / 0.7) ** 2, 1.6) : 0;
      // clods / thrown shovelfuls: lumps of ~1 m and ~0.4 m, a few landing past the heap
      const cl = vnoise(x * 1.15 + 4.4, z * 1.15 + 9.9), c2 = vnoise(x * 2.7 + 1.1, z * 2.7 + 6.6);
      h = Math.max(h, H * sp[0] * prof * (0.62 + 0.55 * cl + 0.18 * c2) + (t > 0.6 && t < 1.35 ? 0.09 * H / 0.38 * Math.max(0, cl - 0.62) * sp[0] : 0));
    }
    return h;
  }
  addRelief(r) {
    r.bb = r.type === 'ditch' ? (() => { const xs = r.pts.map(p => p[0]), zs = r.pts.map(p => p[1]); return [Math.min(...xs) - r.reach, Math.min(...zs) - r.reach, Math.max(...xs) + r.reach, Math.max(...zs) + r.reach]; })()
      : r.type === 'crater' ? [r.x - r.reach, r.z - r.reach, r.x + r.reach, r.z + r.reach]
      : (() => { const R = Math.hypot(r.hx, r.hz) + 0.5; return [r.x - R, r.z - R, r.x + R, r.z + R]; })();
    this.reliefs.push(r);
    for (let x = Math.floor((r.bb[0] - 2) / HC); x <= Math.floor((r.bb[2] + 2) / HC); x++) for (let z = Math.floor((r.bb[1] - 2) / HC); z <= Math.floor((r.bb[3] + 2) / HC); z++) { const k = x * 8192 + z; (this.hRel.get(k) || this.hRel.set(k, []).get(k)).push(r); }
    if (r.mesh !== false) this.markBlocks(r.bb[0] - 1.6, r.bb[1] - 1.6, r.bb[2] + 1.6, r.bb[3] + 1.6);
    return r;
  }
  // relief at a point: [negative part (ditch, crater bowl), positive part (berm, mound, crater rim)], meshOnly = skip
  // height-only features
  relief(x, z, meshOnly) {
    const l = this.hRel.get(hkey(x, z)); if (!l) return null;
    let neg = 0, pos = 0, hit = false;
    for (const r of l) {
      if (meshOnly && r.mesh === false) continue;
      if (x < r.bb[0] || x > r.bb[2] || z < r.bb[1] || z > r.bb[3]) continue;
      if (r.type === 'ditch') {
        let best = 1e9, side = 0;
        for (let i = 0; i < r.pts.length - 1; i++) { const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz; let t = ((x - ax) * dx + (z - az) * dz) / L2; t = Math.max(0, Math.min(1, t)); const px = ax + dx * t - x, pz = az + dz * t - z, d = Math.hypot(px, pz); if (d < best) { best = d; side = Math.sign(dx * (z - az) - dz * (x - ax)); } }
        // machine-dug, but slumped: the edges wander a little
        best += (vnoise(x * 0.35 + 2.2, z * 0.35 + 6.1) - 0.5) * 0.7;
        if (best > r.reach) continue; hit = true;
        if (best < r.top) neg = Math.min(neg, best < r.bot ? -r.depth : -r.depth * Math.pow(Math.max(0, 1 - (best - r.bot) / (r.top - r.bot)), 0.85));
        const bd = best - r.top - 0.4; if (side === r.bermSide && bd > 0 && bd < r.bermW) pos = Math.max(pos, r.bermH * Math.sin(Math.PI * bd / r.bermW) ** 0.8 * (0.75 + 0.5 * vnoise(x * 0.45 + 1.3, z * 0.45 + 8.8)));
      } else if (r.type === 'crater') {
        const dx = x - r.x, dz = z - r.z, d = Math.hypot(dx, dz); if (d > r.reach) continue;
        const a = Math.atan2(dz, dx), rr = r.r * (0.86 + 0.28 * vnoise(Math.cos(a) * 1.7 + r.x, Math.sin(a) * 1.7 + r.z)), t = d / rr;
        const h = (t < 1 ? -r.depth * Math.pow(1 - t * t, 1.25) : 0) + r.rim * Math.exp(-(((t - 1.0) / (t < 1 ? 0.22 : 0.45)) ** 2)) * (0.6 + 0.6 * vnoise(x * 1.3, z * 1.3));
        hit = true; if (h < 0) neg = Math.min(neg, h); else pos = Math.max(pos, h);
      } else { // mound: rounded box
        const c = Math.cos(r.rot), s = Math.sin(r.rot), dx = x - r.x, dz = z - r.z, lx = (dx * c - dz * s) / r.hx, lz = (dx * s + dz * c) / r.hz;
        const e = Math.pow(Math.abs(lx), 4) + Math.pow(Math.abs(lz), 4); if (e >= 1) continue; hit = true;
        pos = Math.max(pos, r.h * Math.pow(1 - e, 0.6));
      }
    }
    return hit ? [neg, pos] : null;
  }
  // both top heights at once: [terrain-mesh version, heightfield version] (one parapet + one relief pass)
  topH2(x, z) {
    const p = this.parapet(x, z), l = this.hRel.get(hkey(x, z));
    if (!l) return [p > 0.004 ? p : LOW, p > 0.004 ? p : 0];
    let heightOnly = false; for (const r of l) if (r.mesh === false && x >= r.bb[0] && x <= r.bb[2] && z >= r.bb[1] && z <= r.bb[3]) { heightOnly = true; break; }
    const fin = (rel, mesh) => { const pos = Math.max(p, rel ? rel[1] : 0); if (rel && rel[0] < -0.001) return rel[0] + pos * 0.5; return pos > 0.004 ? pos : (mesh ? LOW : 0); };
    const ra = this.relief(x, z, false), rm = heightOnly ? this.relief(x, z, true) : ra;
    return [fin(rm, true), fin(ra, false)];
  }
  // top-surface height outside the cut (mesh = terrain mesh version: skips height-only mounds and keeps the LOW rim)
  topH(x, z, mesh) {
    const rel = this.relief(x, z, mesh);
    let pos = Math.max(this.parapet(x, z), rel ? rel[1] : 0);
    if (rel && rel[0] < -0.001) return rel[0] + pos * 0.5;
    return pos > 0.004 ? pos : (mesh ? LOW : 0);
  }
  // ---------------------------------------------------------------- trench builders
  // polyline -> one line cut (capsule chain; pts = mitred offset outline for dressing); segs keeps the centre line for
  // floor litter / covers
  strip(P, w, o) {
    const n = P.length; if (n < 2) return [];
    const N = []; for (let i = 0; i < n - 1; i++) { const dx = P[i + 1][0] - P[i][0], dz = P[i + 1][1] - P[i][1], L = Math.hypot(dx, dz) || 1; N.push([-dz / L, dx / L]); }
    const off = i => { if (i === 0) return [N[0][0] * w, N[0][1] * w]; if (i === n - 1) return [N[n - 2][0] * w, N[n - 2][1] * w]; let mx = N[i - 1][0] + N[i][0], mz = N[i - 1][1] + N[i][1]; const L = Math.hypot(mx, mz) || 1; mx /= L; mz /= L; const k = Math.min(1.9, 1 / Math.max(0.3, mx * N[i][0] + mz * N[i][1])); return [mx * w * k, mz * w * k]; };
    const O = P.map((_, i) => off(i));
    const pts = [...P.map((p, i) => [p[0] + O[i][0], p[1] + O[i][1]]), ...P.map((p, i) => [p[0] - O[i][0], p[1] - O[i][1]]).reverse()];
    const segs = []; for (let i = 0; i < n - 1; i++) segs.push([P[i][0], P[i][1], P[i + 1][0], P[i + 1][1]]);
    return [this.addPoly(pts, { ...o, segs, w, line: P.map(p => [p[0], p[1]]) })];
  }
  // split a polyline into runs that stay off roads / keep-out areas
  runs(P, pad) {
    const ok = (x, z) => !(this.roadTest && this.roadTest(x, z, pad)) && !(this.keepOut && this.keepOut(x, z));
    const out = []; let cur = [];
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (!ok(p[0], p[1])) { if (cur.length > 1) out.push(cur); cur = []; continue; }
      if (cur.length) { const q = cur[cur.length - 1], mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2; if (!ok(mx, mz)) { if (cur.length > 1) out.push(cur); cur = []; } }
      cur.push(p);
    }
    if (cur.length > 1) out.push(cur);
    return out;
  }
  // zig-zag / crenellated / wiggly line along a baseline polyline. Returns {pts, fwd: indices of forward-most vertices}
  zigzag(base, style, leg, amp, frontSign) {
    const R = this.R, pts = [], fwd = [];
    for (let s = 0; s < base.length - 1; s++) {
      const [ax, az] = base[s], [bx, bz] = base[s + 1], L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz * frontSign, nz = ux * frontSign;
      const at = (t, o) => [ax + ux * t + nx * o, az + uz * t + nz * o];
      let t = s === 0 ? 0 : leg * 0.5, k = 0;
      if (style === 'crenel') { // square wave: fire bays forward, traverses behind
        if (s === 0) pts.push(at(0, 0));
        while (t + leg * 1.6 < L) { const a = leg * (0.75 + R() * 0.4), b = leg * (0.55 + R() * 0.3); pts.push(at(t + leg * 0.35, 0)); pts.push(at(t + leg * 0.35, amp)); fwd.push(pts.length - 1, pts.length); pts.push(at(t + leg * 0.35 + a, amp)); pts.push(at(t + leg * 0.35 + a, 0)); t += leg * 0.35 + a + b * 0.4; }
        pts.push(at(L, 0)); continue;
      }
      while (t < L - 0.5) {
        const o = style === 'wiggle' ? (k % 2 ? 1 : -1) * amp * (0.35 + R() * 0.65) : (k % 2 ? 0.5 : -0.5) * amp * (0.7 + R() * 0.6);
        pts.push(at(t, o)); if (o > 0) fwd.push(pts.length - 1);
        t += leg * (0.6 + R() * 0.8); k++;
      }
      if (s === base.length - 2) pts.push(at(L, 0));
    }
    return { pts, fwd };
  }
  // Hand-dug trench line: follows the baseline with a slow meander and sharp dog-leg jogs (traverses against blast /
  // enfilade) every 6-13 m.  Returns {pts, fwd: indices of points that sit forward (towards the front side)}
  wander(base, amp, jog, frontSign, step = 1.6) {
    const R = this.R, pts = [], lat = [], ph = R() * 100, total = base.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - base[i][0], p[1] - base[i][1]), 0);
    let acc = 0, nextJog = 3 + R() * 6, off = 0;
    for (let s = 0; s < base.length - 1; s++) {
      const [ax, az] = base[s], [bx, bz] = base[s + 1], L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz * frontSign, nz = ux * frontSign;
      const ts = []; for (let t = s === 0 ? 0 : step * 0.5; t < L - step * 0.4; t += step * (0.8 + R() * 0.4)) ts.push(t); ts.push(L);
      for (const tt of ts) {
        const g = acc + tt, m = amp * (vnoise(g * 0.06 + ph, ph) - 0.5) * 2 * Math.min(1, g / 3, (total - g) / 3);
        if (jog > 0 && g > nextJog && total - g > 3) { // dog-leg: the old offset and the new one at the same station
          const o0 = m + off; pts.push([ax + ux * tt + nx * o0, az + uz * tt + nz * o0]); lat.push(o0);
          off += (Math.abs(off) > jog * 0.8 ? -Math.sign(off) : (R() < 0.5 ? 1 : -1)) * jog * (0.7 + R() * 0.5);
          nextJog = g + 6 + R() * 7;
        }
        const o = m + off;
        pts.push([ax + ux * tt + nx * o, az + uz * tt + nz * o]); lat.push(o);
      }
      acc += L;
    }
    // forward points: local maxima of the lateral offset
    const lo = Math.min(...lat), fwd = []; for (let i = 1; i < pts.length - 1; i++) if (lat[i] >= lat[i - 1] - 0.05 && lat[i] >= lat[i + 1] - 0.05 && lat[i] > lo + 0.3) fwd.push(i);
    return { pts, fwd };
  }
  // irregular rounded polygon around (x, z): half sizes a (along s) and b (along f), squareness k
  blob(x, z, fx, fz, a, b, n = 10, k = 3) {
    const sx = -fz, sz = fx, R = this.R, out = [];
    for (let i = 0; i < n; i++) {
      const t = i / n * Math.PI * 2 + 0.2, c = Math.cos(t), s = Math.sin(t), e = 2 / k;
      const u = Math.sign(c) * Math.abs(c) ** e * a * (0.9 + R() * 0.2), v = Math.sign(s) * Math.abs(s) ** e * b * (0.9 + R() * 0.2);
      out.push([x + sx * u + fx * v, z + sz * u + fz * v]);
    }
    return out;
  }
  // Fire trench along `base`: style 'rough' (hand-dug meander with jogs, default), 'zigzag' (machine-dug Russian
  // 'lomanaya'), 'crenel' or 'wiggle'; firing cells pushed out of the front wall. front = unit vector towards the enemy.
  fireTrench(base, o = {}) {
    const R = this.R, front = o.front, w = (o.width || 1.25) / 2, depth = o.depth || 1.7, style = o.style || 'rough';
    const [ax, az] = base[0], [bx, bz] = base[base.length - 1], fs = Math.sign((-(bz - az)) * front[0] + (bx - ax) * front[1]) || 1;
    const { pts, fwd } = style === 'rough' ? this.wander(base, o.amp ?? 0.9, o.jog ?? 1.5, fs) : this.zigzag(base, style, o.leg || 7, o.amp || 2.4, fs);
    const sys = o.sys, made = [];
    for (const run of this.runs(pts, 3.5)) made.push(...this.strip(run, w, { kind: 'fire', depth, front, revet: o.revet, sys }));
    // firing cells: small irregular pits pushed forward, roughly every bayGap metres (from the forward points)
    const gap = o.bayGap ?? (o.bays ? o.bays * 7 : 9), bays = []; let last = -1e9, along = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i) along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (style === 'rough' ? along - last < gap * (0.75 + R() * 0.5) || !(fwd.includes(i) || along - last > gap * 1.6) : !fwd.includes(i) || along - last < gap * 0.8) continue;
      const [x, z] = pts[i]; if (this.cutSDF(x, z) > -0.05) continue; // dropped (road gap)
      // cells fan out a little (each covers its own sector) and vary in size: no regular crenellation
      const ang = style === 'rough' ? (R() - 0.5) * 0.7 : (R() - 0.5) * 0.2, ca = Math.cos(ang), sa = Math.sin(ang);
      const L = 0.95 + R() * 0.55, W = 0.5 + R() * 0.2, d0 = w - 0.1, fx = front[0] * ca - front[1] * sa, fz = front[0] * sa + front[1] * ca, sx = -fz, sz = fx;
      const c = (a, b) => [x + fx * a + sx * b, z + fz * a + sz * b];
      if (this.roadTest && this.roadTest(x + fx * (d0 + L), z + fz * (d0 + L), 2)) continue;
      if (this.keepOut && this.keepOut(x + fx * (d0 + L), z + fz * (d0 + L))) continue;
      last = along;
      bays.push(this.addPoly([c(d0 - 0.2, -W), c(d0 + L * 0.65, -W * (0.85 + R() * 0.3)), c(d0 + L, -W * (0.4 + R() * 0.3)), c(d0 + L + 0.05, (R() - 0.5) * 0.2), c(d0 + L, W * (0.4 + R() * 0.3)), c(d0 + L * 0.65, W * (0.85 + R() * 0.3)), c(d0 - 0.2, W)], { kind: 'bay', depth: o.bayDepth || 1.12, front: [fx, fz], revet: o.revet, sys, tag: { x, z, fx, fz, L: d0 + L } }));
    }
    return { pts, quads: made, bays, front, depth, w, sys };
  }
  commTrench(base, o = {}) {
    const style = o.style || 'rough', w = (o.width || 1.05) / 2;
    let P;
    if (style === 'rough') P = this.wander(base, o.amp ?? 0.7, o.jog ?? 1.2, 1).pts;
    else P = base.length === 2 && style !== 'straight' ? this.zigzag(base, style === 'wiggle' ? 'wiggle' : 'zigzag', o.leg || 9, o.amp || 3, 1).pts : base.map(p => [p[0], p[1]]);
    // keep the exact end points (junctions)
    P[0] = base[0]; P[P.length - 1] = base[base.length - 1];
    const made = []; for (const run of this.runs(P, 3)) made.push(...this.strip(run, w, { kind: 'comm', depth: o.depth || 1.55, front: null, revet: o.revet, sys: o.sys }));
    return { pts: P, quads: made };
  }
  // Foxhole / two-man fighting pit facing (fx, fz): an irregular rounded pit, long axis across the front.
  // Returns the cut with tag {x, z, fx, fz, L, slots: [[x, z], ...]} (one or two firing places against the front wall).
  foxhole(x, z, fx, fz, o = {}) {
    const R = this.R, dbl = o.double ?? R() < 0.45, a = (dbl ? 1.25 : 0.82) + R() * 0.15, b = 0.56 + R() * 0.1, sx = -fz, sz = fx;
    if (this.roadTest && this.roadTest(x, z, 1.5)) return null;
    if (this.keepOut && this.keepOut(x, z)) return null;
    const q = this.addPoly(this.blob(x, z, fx, fz, a, b, dbl ? 12 : 9, 3.2), { kind: 'pit', depth: o.depth || 1.25 + R() * 0.2, front: [fx, fz], revet: o.revet, sys: o.sys });
    const k = b * 0.25, slots = dbl ? [[x + sx * a * 0.45 + fx * k, z + sz * a * 0.45 + fz * k], [x - sx * a * 0.45 + fx * k, z - sz * a * 0.45 + fz * k]] : [[x + fx * k, z + fz * k]];
    q.tag = { x, z, fx, fz, L: b, slots, fox: true };
    return q;
  }
  // machine-gun pit (open-backed cell, log roof on posts over it) facing (fx, fz)
  mgPit(x, z, fx, fz, o = {}) {
    if (this.roadTest && this.roadTest(x, z, 2)) return null;
    if (this.keepOut && this.keepOut(x, z)) return null;
    const q = this.addPoly(this.blob(x, z, fx, fz, 1.0, 0.85, 10, 4), { kind: 'bay', depth: 1.12, front: [fx, fz], revet: o.revet, sys: o.sys });
    q.tag = { x: x - fx * 0.6, z: z - fz * 0.6, fx, fz, L: 1.25 };
    this.put('mg_nest_roof', trs(x - fx * 0.05, 0, z - fz * 0.05, Math.atan2(fx, fz) + (this.R() - 0.5) * 0.15));
    q.covered = true;
    return q;
  }
  // Dugout (blindazh): passage from the trench point (x,z) going along (dx,dz), ending at a log-roofed, earth-covered
  // pit; the roof mound is height-only (the dugout_roof piece carries its own earth cover).
  dugout(x, z, dx, dz, o = {}) {
    const L = Math.hypot(dx, dz); dx /= L; dz /= L;
    const len = o.len || 3.2, depth = o.depth || 1.7, ex = x + dx * len, ez = z + dz * len;
    this.strip([[x - dx * 0.6, z - dz * 0.6], [ex - dx * 0.4, ez - dz * 0.4]], 0.44, { kind: 'pass', depth, front: null, revet: o.revet || 'pass', sys: o.sys });   // round end reaches the doorway
    const hl = 2.5, cx = ex + dx * hl, cz = ez + dz * hl, rot = Math.atan2(dx, dz);
    this.addRelief({ type: 'mound', x: cx, z: cz, hx: 2.35, hz: 2.75, rot: -rot, h: 0.5, mesh: false, nav: 'dugout' });
    this.put(this.R() < 0.5 ? 'dugout_roof' : 'dugout_roof_b', trs(cx, 0, cz, rot + Math.PI));
    return [cx, cz];
  }
  // covered machine-gun position over a firing cell (log roof on posts, sandbag cheeks, embrasure to the front)
  mgNest(bay) { const t = bay.tag; const cx = t.x + t.fx * (t.L - 0.7), cz = t.z + t.fz * (t.L - 0.7); this.put('mg_nest_roof', trs(cx, 0, cz, Math.atan2(t.fx, t.fz))); bay.covered = true; }
  antitankDitch(pts, o = {}) {
    const r = { type: 'ditch', pts, top: (o.top || 5.6) / 2, bot: (o.bot || 0.9) / 2, depth: o.depth || 2.6, bermSide: o.bermSide || 1, bermW: o.bermW || 4.5, bermH: o.bermH || 0.9 };
    r.reach = r.top + 0.4 + r.bermW + 0.6;
    for (const run of this.runs(pts, r.reach)) this.addRelief({ ...r, pts: run });
  }
  // shell crater: bowl + thrown-out rim (r = bowl radius, m)
  crater(x, z, r, o = {}) {
    return this.addRelief({ type: 'crater', x, z, r, depth: o.depth ?? Math.min(1.0, 0.16 + r * 0.19), rim: o.rim ?? Math.min(0.35, 0.05 + r * 0.06), reach: r * 1.9 });
  }
  // rows of concrete pyramids ("dragon's teeth"), staggered; gaps where roads cross.  Each tooth is recorded in
  // this.teeth as [x, z] (+ y, ry, s, rx, rz placement, bad = already chipped); City instances them itself so they can
  // be damaged / destroyed (City.damageFortAt), nav blocks them via NavGrid.addTooth.
  dragonTeeth(pts, o = {}) {
    const R = this.R, rows = o.rows || 3, gap = o.gap || 2.1, rowGap = o.rowGap || 2.0;
    for (let s = 0; s < pts.length - 1; s++) {
      const [ax, az] = pts[s], [bx, bz] = pts[s + 1], L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux;
      for (let r = 0; r < rows; r++) for (let t = (r % 2) * gap * 0.5; t < L; t += gap) {
        const off = (r - (rows - 1) / 2) * rowGap, x = ax + ux * t + nx * off + (R() - .5) * 0.35, z = az + uz * t + nz * off + (R() - .5) * 0.35;
        if (this.roadTest && this.roadTest(x, z, 4)) continue;
        if (this.keepOut && this.keepOut(x, z)) continue;
        if (R() < 0.04) continue; // a few lifted out / blown
        const bad = R() < 0.08, tooth = [x, z];
        tooth.y = -0.12 - R() * 0.12; tooth.ry = R() * 6.28; tooth.s = 0.92 + R() * 0.16; tooth.rx = bad ? (R() - .5) * 0.6 : (R() - .5) * 0.08; tooth.rz = bad ? (R() - .5) * 0.6 : (R() - .5) * 0.08; tooth.bad = bad;
        (this.teeth ||= []).push(tooth);
      }
    }
  }
  put(name, M) { (this.dress.get(name) || this.dress.set(name, []).get(name)).push(M); }
  // ================================================================ finalise: heights, nav, mask, meshes, dressing
  // vertex record cache over the global GR grid (raw grid positions: S, the cut it is in, top heights outside)
  vrec(gi, gj) {
    const k = gi * 65536 + gj; let v = this._vc.get(k); if (v) return v;
    const x = gi * GR - this.half, z = gj * GR - this.half, S = this.cutSDF(x, z), q = this._q;
    v = { x, z, S, q, cls: S < 0 ? 2 : 0, gi, gj };
    if (S >= 0) { const h = this.topH2(x, z); v.H = h[0]; v.Hh = h[1]; }
    this._vc.set(k, v); return v;
  }
  // top-surface (heightfield) height extrapolated to an inside vertex: the lip height where it projects onto the outline
  vtop(v) {
    if (v.T !== undefined) return v.T;
    if (v.S >= 0) return (v.T = v.Hh);
    let x = v.x, z = v.z;
    for (let it = 0; it < 4; it++) { const S = this.cutSDF(x, z); if (S >= 0 && S < 0.02) break; const [gx, gz] = this.grad(x, z); x -= gx * (S - 0.01); z -= gz * (S - 0.01); }
    return (v.T = this.topH2(x, z)[1]);
  }
  finalize(opts = {}) {
    const tt = this.times = {}, t0 = performance.now(), lap = k => { tt[k] = Math.round(performance.now() - t0); };
    this._vc = new Map();
    const nb = Math.round(this.size / GR), blocks = [...this.blocks];
    this.tops = new Array(this.TN * this.TN).fill(null); this.efl = new Array(this.TN * this.TN).fill(null);
    // 1) heightfield at the raw grid points: inside -> floor (same floor noise as the mesh), else top (height-only
    //    mounds included)
    for (const b of blocks) {
      const bi = Math.floor(b / 8192), bj = b % 8192, i0 = bi * BLK, j0 = bj * BLK;
      for (let gj = j0; gj <= j0 + BLK; gj++) for (let gi = i0; gi <= i0 + BLK; gi++) {
        if (gi < 0 || gj < 0 || gi > nb || gj > nb) continue;
        const v = this.vrec(gi, gj), h = v.S < 0 ? this.floorAt(v.x, v.z, v.q) : v.Hh;
        if (Math.abs(h) > 0.003) this.writeV(gi, gj, h, false);
      }
    }
    // 2) edge cells: the outline passes through or near the cell (or its battered wall reaches into it): heightAt()
    //    evaluates those exactly; tops = top surface at the corners (lip height projected for inside corners),
    //    flag = 1 | inside-corner bits << 1
    for (const b of blocks) {
      const bi = Math.floor(b / 8192), bj = b % 8192, i0 = bi * BLK, j0 = bj * BLK;
      for (let gj = j0; gj < j0 + BLK; gj++) for (let gi = i0; gi < i0 + BLK; gi++) {
        if (gi < 0 || gj < 0 || gi >= nb || gj >= nb) continue;
        const V = [this.vrec(gi, gj), this.vrec(gi + 1, gj), this.vrec(gi, gj + 1), this.vrec(gi + 1, gj + 1)];
        let mn = 99, mx = -99, bits = 0, sm = 0; V.forEach((v, k) => { mn = Math.min(mn, v.S); mx = Math.max(mx, v.S); if (v.S < 0) { bits |= 1 << k; sm = Math.max(sm, 0.36 * v.q.K.batter); } });
        // S varies by < 0.4 m inside a cell (|grad S| < ~1.3, half diagonal 0.28): skip cells surely outside, or surely
        // beyond the deepest wall foot (s0 <= 0.36 batter)
        if (!(mn < 0.4 && mx > -(sm + 0.4))) continue;
        const ti = Math.floor(gi / CPT), tj = Math.floor(gj / CPT), tk = tj * this.TN + ti;
        if (!this.tiles[tk]) this.tile(ti, tj, true);
        (this.efl[tk] ||= new Uint8Array(CPT * CPT))[(gj - tj * CPT) * CPT + (gi - ti * CPT)] = 1 | (bits << 1);
        V.forEach(v => this.writeT(v.gi, v.gj, this.vtop(v)));
      }
    }
    // height-only mounds outside the meshed blocks (dugout roofs) -- never over a cut (the passage stays open)
    for (const r of this.reliefs) if (r.mesh === false) {
      for (let gj = Math.floor((r.bb[1] + this.half) / GR); gj <= Math.ceil((r.bb[3] + this.half) / GR); gj++) for (let gi = Math.floor((r.bb[0] + this.half) / GR); gi <= Math.ceil((r.bb[2] + this.half) / GR); gi++) {
        const x = gi * GR - this.half, z = gj * GR - this.half, rel = this.relief(x, z, false); if (!rel || rel[1] <= 0.003) continue;
        if (this.cutSDF(x, z) < 0.45) continue;
        this.writeV(gi, gj, rel[1], true);
      }
    }
    lap('heights');
    this.markNav(); lap('nav');
    this.buildMask(); lap('mask');
    if (opts.scene) this.buildMeshes(opts.scene, opts.matTop, opts.matWall, opts.groundS);
    lap('meshes');
    this.buildDressing(opts); lap('dressing');
    this._vc = null; this._xc = null;
  }
  // write the top-surface value of global vertex (gi, gj) into every tile that holds it (see writeV)
  writeT(gi, gj, h) {
    const a = Math.floor(gi / CPT), b = Math.floor(gj / CPT), TN = this.TN;
    for (let ti = gi % CPT === 0 ? a - 1 : a; ti <= a; ti++) for (let tj = gj % CPT === 0 ? b - 1 : b; tj <= b; tj++) {
      if (ti < 0 || tj < 0 || ti >= TN || tj >= TN) continue;
      const tk = tj * TN + ti; (this.tops[tk] ||= new Float32Array(VW * VW))[(gj - tj * CPT) * VW + (gi - ti * CPT)] = h;
    }
  }
  // exact walkable height in an edge cell (see finalize): top surface outside, the battered wall profile (same rows as
  // the mesh, wallRing) between the lip and the wall foot, the floor beyond
  edgeH(x, z, t, T, k, a, b, f) {
    const S = this.sdfNear(x, z), q = this._q;
    if (S >= 0 || !q) return (T[k] * (1 - a) + T[k + 1] * a) * (1 - b) + (T[k + VW] * (1 - a) + T[k + VW + 1] * a) * b;
    const F = (f & 30) === 30 ? (t[k] * (1 - a) + t[k + 1] * a) * (1 - b) + (t[k + VW] * (1 - a) + t[k + VW + 1] * a) * b : this.floorAt(x, z, q);
    const sm = 0.36 * q.K.batter; if (-S >= sm) return F;   // beyond any wall foot
    const s0 = this.s0At(x, z, q, this._D), u = -S / s0; if (u >= 1) return F;
    const top = (T[k] * (1 - a) + T[k + 1] * a) * (1 - b) + (T[k + VW] * (1 - a) + T[k + VW + 1] * a) * b;
    let i = 1; while (WALL_U[i] < u) i++;
    const fr = WALL_F[i - 1] + (WALL_F[i] - WALL_F[i - 1]) * (u - WALL_U[i - 1]) / (WALL_U[i] - WALL_U[i - 1]);
    return top + (F - top) * fr;
  }
  // battered raw-earth walls: s0 = how far the wall foot creeps in from the lip at this spot (never more than ~0.4 of
  // a line cut's half width, so the floor of a narrow crawl trench cannot fold over)
  s0At(x, z, q, D) {
    const s = (q ? q.K.batter : 1) * (0.16 + 0.2 * vnoise(x * 0.31 + 11.7, z * 0.31 + 2.3));
    return q && q.line ? Math.min(s, 0.42 * this.halfW(q, x, z, D ?? widen(x, z))) : s;
  }
  floorAt(x, z, q) { return -q.depth + 0.08 * (vnoise(x * 0.7 + 3.3, z * 0.7 + 1.1) - 0.5); }
  floorY(v) { this.floorPos(v); return this.floorAt(v.fx, v.fz, v.q); }
  // floor position of a vertex: pulled in along the gradient by g(S) = s0 (1 + S / 2 s0) so the floor shrinks
  // monotonically (no folds) and meets the wall foot
  floorPos(v) {
    if (v.fx !== undefined) return;
    const s0 = this.s0At(v.x, v.z, v.q), S = v.cls === 1 ? 0 : v.S; v.s0 = s0;
    if (S < -2 * s0) { v.fx = v.x; v.fz = v.z; v.gx = 1; v.gz = 0; return; }
    const [gx, gz] = this.grad(v.x, v.z), g = s0 * Math.max(0, 1 + S / (2 * s0));
    v.gx = gx; v.gz = gz; v.fx = v.x - gx * g; v.fz = v.z - gz * g;
  }
  // wall vertex ring (lip -> floor): [x, y, z, nx, ny, nz] x 5
  wallRing(v) {
    if (v.wr) return v.wr; this.floorPos(v);
    const top = v.H, bot = this.floorY(v), s0 = v.s0, gx = v.gx, gz = v.gz, K = v.q.K, D = Math.max(0.4, top - bot);
    // rows: lip, eroded shoulder, upper wall, lower wall, slumped foot
    const LV = WALL_F, IN = WALL_U, SL = [2.6, 2.0, 1.1, 0.7, 0.5], ring = [];
    for (let k = 0; k < 5; k++) {
      let ins = s0 * IN[k], y = top + (bot - top) * LV[k], jx = 0, jz = 0;
      if (k >= 1 && k <= 3) {
        ins += (vnoise(v.x * 2.3 + k * 17.1, v.z * 2.3 - k * 5.3) - 0.5) * (k === 1 ? 0.08 : 0.17) * K.rough * Math.min(1, s0 / 0.25);
        y += (vnoise(v.x * 1.9 - k * 3.7, v.z * 1.9 + k * 9.1) - 0.5) * (k === 1 ? 0.05 : 0.12);
        jx = (vnoise(v.x * 3.1 + k, v.z * 3.1) - 0.5) * 0.6; jz = (vnoise(v.x * 3.1, v.z * 3.1 + k * 7) - 0.5) * 0.6;
      }
      let nx = -gx + jx, ny = SL[k] * s0 / D + (k === 0 ? 0.6 : k === 1 ? 0.25 : 0), nz = -gz + jz; const L = Math.hypot(nx, ny, nz) || 1;
      ring.push([v.x - gx * ins, y, v.z - gz * ins, nx / L, ny / L, nz / L]);
    }
    return v.wr = ring;
  }
  // crossing point of the outline on the grid edge between inside vertex A and outside vertex B (bisection on S),
  // cached per edge so the neighbouring triangle uses the same point (watertight top / floor / wall)
  cross(ek, A, B) {
    let r = this._xc.get(ek); if (r) return r;
    let lo = 0, hi = 1, sl = A.S, sh = B.S;
    for (let it = 0; it < 9; it++) {
      let m = sl / (sl - sh); m = lo + (hi - lo) * Math.min(0.85, Math.max(0.15, m));   // safeguarded regula falsi
      const S = this.cutSDF(A.x + (B.x - A.x) * m, A.z + (B.z - A.z) * m);
      if (S < 0) { lo = m; sl = S; } else { hi = m; sh = S; }
      if (hi - lo < 0.004) break;
    }
    const x = A.x + (B.x - A.x) * lo, z = A.z + (B.z - A.z) * lo; this.cutSDF(x, z);
    r = { x, z, S: 0, cls: 1, q: this._q || A.q, H: this.topH2(A.x + (B.x - A.x) * hi, A.z + (B.z - A.z) * hi)[0] };
    this._xc.set(ek, r); return r;
  }
  markNav() {
    const nav = this.nav; if (!nav) return; nav.terrain = this;
    nav.trench ||= new Uint8Array(nav.n * nav.n); nav.veh ||= new Uint8Array(nav.n * nav.n);
    const done = new Set();
    for (const b of this.blocks) {
      const bi = Math.floor(b / 8192), bj = b % 8192, x0 = bi * BLK * GR - this.half, z0 = bj * BLK * GR - this.half;
      for (let z = z0 + 0.5; z < z0 + BLK * GR; z += 1) for (let x = x0 + 0.5; x < x0 + BLK * GR; x += 1) {
        const i = nav.idx(x, z); if (i < 0 || done.has(i)) continue; done.add(i);
        const cx = nav.cx(i), cz = nav.cz(i), S = this.cutSDF(cx, cz), q = this._q;
        if (S < 0.15 && q) { nav.cost[i] = Math.max(nav.cost[i] === BLOCK ? 1 : nav.cost[i], q.K.cost); nav.veh[i] = Math.max(nav.veh[i], q.K.veh); nav.trench[i] = Math.max(1, Math.min(255, Math.round(q.depth * 10))); nav.low[i] = 1; continue; }
        const rel = this.relief(cx, cz, false);
        if (rel && rel[0] < -0.7) { nav.cost[i] = Math.max(nav.cost[i], 6); nav.veh[i] = 2; nav.low[i] = 1; nav.trench[i] = Math.min(255, Math.round(-rel[0] * 10)); }
        else if (rel && rel[0] < -0.35) { nav.low[i] = 1; nav.cost[i] = Math.max(nav.cost[i], 2); }
        else if (rel && rel[1] > 0.5) { nav.veh[i] = Math.max(nav.veh[i], 1); }
      }
    }
    for (const r of this.reliefs) if (r.nav === 'dugout') nav.rect(r.x, r.z, r.hx * 0.85, r.hz * 0.85, r.rot, 4, 0), nav.setVeh(r.x, r.z, r.hx, r.hz, r.rot, 2);
    for (const [x, z] of this.teeth || []) nav.addTooth(x, z);
    nav.vehDirty = true;
  }
  // 1 px / m hole mask for the ground plane (R channel): cut + spoil zone and meshed relief.  maskData (what map
  // painters read as 'disturbed ground') is only the cut and its lips -- the spoil colour itself comes from the
  // terrain shader, so no 1 m pixel staircase shows around the positions.
  buildMask() {
    const N = Math.round(this.size), data = new Uint8Array(N * N), core = new Uint8Array(N * N);
    for (const b of this.blocks) {
      const bi = Math.floor(b / 8192), bj = b % 8192, x0 = bi * BLK * GR - this.half, z0 = bj * BLK * GR - this.half;
      for (let z = Math.floor(z0) + 0.5; z < z0 + BLK * GR; z += 1) for (let x = Math.floor(x0) + 0.5; x < x0 + BLK * GR; x += 1) {
        const i = Math.floor(x + this.half), j = Math.floor(z + this.half); if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const S = this.cutSDF(x, z); let hole = S < SPOIL - 0.05;
        if (S < 0.5) core[j * N + i] = 255;
        if (!hole) { const rel = this.relief(x, z, true); if (rel && (rel[0] < -0.004 || rel[1] > 0.004)) hole = true; }
        if (hole) data[j * N + i] = 255;
      }
    }
    const t = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType); t.flipY = false; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    this.mask = t; this.maskData = core; this.holeData = data; this.maskN = N;
    return t;
  }
  // terrain meshes per 64 m chunk: top + floor (ground material) and walls (earth material), marching triangles:
  // grid triangles wholly outside -> top, wholly inside -> floor, crossed -> clipped at the outline crossing points into
  // a top polygon (lip height) and a floor polygon (wall foot, pulled in), plus a wall strip between the crossings.
  buildMeshes(scene, matTop, matWall, groundS) {
    const CH = 64, chunks = new Map(), nb = Math.round(this.size / GR);
    this._xc = new Map();
    const chunkOf = (x, z) => { const k = Math.floor((x + this.half) / CH) * 1024 + Math.floor((z + this.half) / CH); let c = chunks.get(k); if (!c) chunks.set(k, c = { tp: [], tn: [], tu: [], ti: [], tmap: new Map(), fmap: new Map(), wp: [], wn: [], wu: [] }); return c; };
    const S = groundS, uvOf = (x, z) => [x / S + 0.5, 0.5 - z / S];
    // key >= 0: grid vertex, < 0: crossing point (edge key)
    const vtx = (c, key, v, floor) => {
      const map = floor ? c.fmap : c.tmap; let i = map.get(key); if (i !== undefined) return i;
      i = c.tp.length / 3; map.set(key, i);
      if (floor) { const y = this.floorY(v); c.tp.push(v.fx, y, v.fz); c.tu.push(...uvOf(v.fx, v.fz)); c.tn.push(0, 1, 0); }
      else { c.tp.push(v.x, v.H, v.z); c.tu.push(...uvOf(v.x, v.z)); c.tn.push(0, 1, 0); }
      return i;
    };
    const emit = (c, ids) => {   // convex polygon fan, every triangle wound up-facing (from the emitted positions)
      const P = c.tp;
      for (let k = 1; k < ids.length - 1; k++) {
        const ia = ids[0], ib = ids[k], ic = ids[k + 1], ax = P[ia * 3], az = P[ia * 3 + 2];
        const cr = (P[ib * 3] - ax) * (P[ic * 3 + 2] - az) - (P[ib * 3 + 2] - az) * (P[ic * 3] - ax);
        if (Math.abs(cr) < 1e-9) continue;
        if (cr < 0) c.ti.push(ia, ib, ic); else c.ti.push(ia, ic, ib);
      }
    };
    // grid edge key: horizontal (gi,gj)-(gi+1,gj) *4+0, vertical *4+1, the cell's diagonal *4+2
    const ekey = (a, b) => a.gj === b.gj ? (Math.min(a.gi, b.gi) * 65536 + a.gj) * 4 : a.gi === b.gi ? (a.gi * 65536 + Math.min(a.gj, b.gj)) * 4 + 1 : (Math.min(a.gi, b.gi) * 65536 + Math.min(a.gj, b.gj)) * 4 + 2;
    const inMesh = v => v.S < CORR || v.H > LOW + 0.001 || v.H < LOW - 0.001;
    let nw = 0;
    const wall = (c, A, B, side) => {   // raw earth wall along crossing A -> B, facing the inside vertex `side`
      const ra = this.wallRing(A), rb = this.wallRing(B);
      const dx = B.x - A.x, dz = B.z - A.z, sx = side.x - A.x, sz = side.z - A.z, flip = (dx * sz - dz * sx) > 0;
      for (let k = 0; k < 4; k++) {
        const A0 = ra[k], B0 = rb[k], A1 = ra[k + 1], B1 = rb[k + 1];
        for (const p of flip ? [A0, A1, B1, A0, B1, B0] : [A0, B0, B1, A0, B1, A1]) { c.wp.push(p[0], p[1], p[2]); c.wn.push(p[3], p[4], p[5]); c.wu.push(0, p[1] / 1.4); }
      }
      nw++;
    };
    for (const b of this.blocks) {
      const bi = Math.floor(b / 8192), bj = b % 8192, i0 = bi * BLK, j0 = bj * BLK;
      for (let gj = j0; gj < j0 + BLK; gj++) for (let gi = i0; gi < i0 + BLK; gi++) {
        if (gi < 0 || gj < 0 || gi >= nb || gj >= nb) continue;
        const V = [this.vrec(gi, gj), this.vrec(gi + 1, gj), this.vrec(gi + 1, gj + 1), this.vrec(gi, gj + 1)];
        if (!V.some(inMesh)) continue;
        // diagonal: the one that does not cross the outline (one wall segment per cell instead of two); across a
        // saddle the one joining the inside corners (junctions stay open); else alternating
        const m = (V[0].S < 0 ? 1 : 0) | (V[1].S < 0 ? 2 : 0) | (V[2].S < 0 ? 4 : 0) | (V[3].S < 0 ? 8 : 0);
        const odd = m === 1 || m === 4 || m === 14 || m === 11 ? 1 : m === 2 || m === 8 || m === 13 || m === 7 ? 0 : -1;
        const d02 = odd === 1 ? false : odd === 0 ? true : m === 5 ? true : m === 10 ? false : (gi + gj) % 2 === 0;
        const tris = d02 ? [[0, 2, 1], [0, 3, 2]] : [[0, 3, 1], [1, 3, 2]];
        const c = chunkOf(gi * GR - this.half + 0.2, gj * GR - this.half + 0.2);
        for (const t of tris) {
          const tv = t.map(k => V[k]), ins = tv.map(v => v.S < 0), n = ins.filter(Boolean).length;
          const gk = v => v.gi * 65536 + v.gj;
          if (n === 0) { emit(c, tv.map(v => vtx(c, gk(v), v, false))); continue; }
          if (n === 3) { emit(c, tv.map(v => vtx(c, gk(v), v, true))); continue; }
          const top = [], flo = [], X = [];
          for (let k = 0; k < 3; k++) {
            const P = tv[k], Pn = tv[(k + 1) % 3], pi = ins[k];
            if (pi) flo.push(vtx(c, gk(P), P, true)); else top.push(vtx(c, gk(P), P, false));
            if (pi !== ins[(k + 1) % 3]) {
              const ek = ekey(P, Pn), r = pi ? this.cross(ek, P, Pn) : this.cross(ek, Pn, P);
              top.push(vtx(c, -1 - ek, r, false)); flo.push(vtx(c, -1 - ek, r, true)); X.push(r);
            }
          }
          emit(c, top); emit(c, flo);
          if (X.length === 2) wall(c, X[0], X[1], tv[ins.indexOf(true)]);
        }
      }
    }
    this.meshes = [];
    let tris = 0;
    for (const c of chunks.values()) {
      if (c.ti.length) {
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(c.tp, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(c.tn, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(c.tu, 2)); g.setIndex(c.ti);
        g.computeVertexNormals(); g.computeBoundingSphere();
        // flat rim / floor stay straight up (the rim must match the ground plane's shading)
        { const P = g.attributes.position.array, Nn = g.attributes.normal.array; for (let i = 0; i < P.length / 3; i++) { const y = P[i * 3 + 1]; if (Math.abs(y - LOW) < 0.002 || y < -0.6) { Nn[i * 3] = 0; Nn[i * 3 + 1] = 1; Nn[i * 3 + 2] = 0; } } }
        const m = new THREE.Mesh(g, matTop); m.receiveShadow = true; m.castShadow = true; m.name = 'terrain'; scene.add(m); this.meshes.push(m); tris += c.ti.length / 3;
      }
      if (c.wp.length) {
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(c.wp, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(c.wn, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(c.wu, 2)); g.computeBoundingSphere();
        const m = new THREE.Mesh(g, matWall); m.receiveShadow = true; m.castShadow = true; m.name = 'terrain_walls'; scene.add(m); this.meshes.push(m); tris += c.wp.length / 9;
      }
    }
    this.stats = { tris, walls: nw, chunks: chunks.size, cuts: this.cuts.length, reliefs: this.reliefs.length };
  }
  // ---------------------------------------------------------------- dressing: improvised, sparse, varied
  // Revetment is patchy scrap leaned against the raw wall (pallets, old doors, corrugated / plywood sheets, branches,
  // a few logs, wire-mesh panels on engineered stretches); sandbags on some firing places only; mud-floor pallets and
  // planks in the wet spots; litter; overhead cover (camo net, cut branches, tarps) over some sections.
  buildDressing() {
    const R = this.R, up = new THREE.Vector3(0, 1, 0), ax = new THREE.Vector3(1, 0, 0);
    const Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion(), P = new THREE.Vector3(), SC = new THREE.Vector3();
    const place = (name, x, y, z, ry, lean = 0, sx = 1, sy = 1, sz = 1) => {
      Q.setFromAxisAngle(up, ry); if (lean) Q.multiply(Q2.setFromAxisAngle(ax, lean));
      this.put(name, new THREE.Matrix4().compose(P.set(x, y, z), Q, SC.set(sx, sy, sz)));
    };
    const SETS = {
      rough: [['rv_pallet', 0.24], ['rv_sheet', 0.2], ['rv_ply', 0.16], ['rv_door', 0.07], ['rv_branches', 0.18], ['rv_logs', 0.15]],
      crude: [['rv_pallet', 0.22], ['rv_sheet', 0.2], ['rv_ply', 0.2], ['rv_door', 0.1], ['rv_branches', 0.14], ['rv_logs', 0.14]],
      urban: [['rv_door', 0.22], ['rv_sheet', 0.26], ['rv_ply', 0.26], ['rv_pallet', 0.26]],
      logs: [['rv_logs', 0.45], ['rv_branches', 0.4], ['rv_pallet', 0.15]],
      eng: [['rv_mesh', 0.72], ['rv_logs', 0.18], ['rv_ply', 0.1]],
      pass: [['rv_logs', 0.55], ['rv_ply', 0.25], ['rv_pallet', 0.2]],
    };
    const DENS = { none: 0, rough: 0.05, crude: 0.11, urban: 0.12, logs: 0.08, eng: 0.3, pass: 0.4 };
    const RUN = { rough: [1, 3], crude: [1, 4], urban: [1, 3], logs: [1, 3], eng: [3, 9], pass: [2, 4] };
    const pick = set => { let r = R(); for (const [n, w] of set) { if ((r -= w) < 0) return n; } return set[0][0]; };
    const W = { rv_pallet: 1.2, rv_sheet: 0.95, rv_ply: 1.22, rv_door: 0.84, rv_branches: 1.3, rv_logs: 1.6, rv_mesh: 1.5 };
    const toWall = (x, z) => { for (let it = 0; it < 4; it++) { const S = this.cutSDF(x, z); if (Math.abs(S) < 0.01) break; const [gx, gz] = this.grad(x, z); x -= gx * S; z -= gz * S; } return [x, z]; };
    const floorAt = (x, z) => { const S = this.cutSDF(x, z), q = this._q; return q && S < 0 ? -q.depth : 0; };
    for (const q of this.cuts) {
      // ---- revetment patches along the walls
      const style = q.revet || 'rough', set = SETS[style] || SETS.rough, dens = DENS[style] ?? 0.05, run = RUN[style] || [1, 3];
      if (dens > 0) for (const ed of q.edges) {
        if (!ed.wall || ed.L < 0.5) continue;
        let t = 0.3 + R() * 0.5, left = 0, name = null;
        while (t < ed.L - 0.3) {
          if (!left) { if (R() > dens * (q.kind === 'bay' || q.kind === 'pit' ? 2.2 : 1) * 1.15) { t += 1.0; continue; } left = run[0] + Math.floor(R() * (run[1] - run[0] + 1)); name = pick(set); }
          const wPiece = W[name] * (0.92 + R() * 0.12);
          const mx = ed.ax + (ed.bx - ed.ax) * t / ed.L, mz = ed.az + (ed.bz - ed.az) * t / ed.L;
          const [wx, wz] = toWall(mx + ed.nx * 0.05, mz + ed.nz * 0.05), [gx, gz] = this.grad(wx, wz);
          // the wall opens into another cut here (junction, firing cell, passage): no panel
          if (this.cutSDF(wx + gx * 0.25, wz + gz * 0.25) < 0.02 || this.cutSDF(wx + gx * 0.25 - gz * wPiece * 0.45, wz + gz * 0.25 + gx * wPiece * 0.45) < 0.02 || this.cutSDF(wx + gx * 0.25 + gz * wPiece * 0.45, wz + gz * 0.25 - gx * wPiece * 0.45) < 0.02) { left = 0; t += 0.8; continue; }
          this.cutSDF(wx - gx * 0.3, wz - gz * 0.3); const sq = this._q || q, depth = sq.depth, s0 = this.s0At(wx, wz, sq), lip = Math.max(0, this.topH(wx + gx * 0.08, wz + gz * 0.08, false));
          const H = name === 'rv_door' ? 2.0 : name === 'rv_sheet' ? 1.8 : name === 'rv_mesh' || name === 'rv_ply' ? 1.25 + (name === 'rv_mesh' ? 0.25 : 0) : name === 'rv_pallet' ? 1.2 : name === 'rv_logs' ? 1.0 : 1.3;
          const room = depth + lip + 0.06, sy = H > room ? room / H : (name === 'rv_branches' ? Math.min(1.3, room / H) : 1);
          const hEff = H * sy, lean = -Math.atan2(s0 * Math.min(1, hEff / depth) + 0.04 + R() * 0.05, hEff);
          const fx = wx - gx * (s0 + 0.06), fz = wz - gz * (s0 + 0.06);
          place(name, fx, -depth + 0.02, fz, Math.atan2(-gx, -gz) + (R() - 0.5) * 0.1, lean + (R() - 0.5) * 0.04, 1 + (R() - 0.5) * 0.1, sy, 1);
          left--; t += wPiece + (R() < 0.3 ? 0.15 + R() * 0.4 : 0.02);
        }
      }
      // ---- sandbags / debris on some firing places (raw earth notch on the rest)
      if ((q.kind === 'bay' || (q.kind === 'pit' && q.tag?.fox)) && !q.covered && q.tag) {
        const t = q.tag, x = t.x + t.fx * (t.L + 0.35), z = t.z + t.fz * (t.L + 0.35), r = R();
        if (r < (style === 'urban' ? 0.25 : 0.45)) place(R() < 0.6 ? 'sandbag_row' : 'sandbag_pile', x, this.topH(x, z, false) - 0.08, z, Math.atan2(t.fx, t.fz) + (R() - 0.5) * 0.3, 0, 0.8 + R() * 0.3);
        else if (style === 'urban' && r < 0.75) place('debris_conc', x, this.topH(x, z, false) - 0.05, z, R() * 6.28);
        if (q.kind === 'pit' && R() < 0.3) this.covers.push([t.x, t.z, -t.fz, t.fx, 1.6, R() < 0.5 ? 'branch_cover' : 'net_cover']);
      }
      // ---- floor: pallets / planks in the wet spots, litter against the walls, crates in the odd traverse
      if (q.segs && (q.kind === 'fire' || q.kind === 'comm')) for (const [ax0, az0, bx0, bz0] of q.segs) {
        const L = Math.hypot(bx0 - ax0, bz0 - az0); if (L < 0.4) continue; const ux = (bx0 - ax0) / L, uz = (bz0 - az0) / L, ry = Math.atan2(ux, uz);
        for (let t = 0.4; t < L - 0.3; t += 1.5) {
          const x = ax0 + ux * t, z = az0 + uz * t; if (this.cutSDF(x, z) > -0.3) continue;
          const wet = vnoise(x * 0.45 + 7.7, z * 0.45 + 1.3), r = R();
          if (wet > 0.62 && r < 0.22) place(R() < 0.6 ? 'floor_pallet' : 'floor_planks', x, -q.depth + 0.01, z, ry + Math.PI / 2 + (R() - 0.5) * 0.25);
          else if (r < (style === 'urban' ? 0.07 : 0.045)) { const side = R() < 0.5 ? 1 : -1, o = (q.w || 0.5) * 0.45; place(R() < 0.5 ? 'litter_a' : 'litter_b', x - uz * o * side, -q.depth + 0.01, z + ux * o * side, R() * 6.28); }
          else if (r < 0.06 && q.kind === 'fire') { const side = R() < 0.5 ? 1 : -1, o = (q.w || 0.5) * 0.35; place('ammo_crates', x - uz * o * side, -q.depth + 0.02, z + ux * o * side, ry + (R() - 0.5) * 0.5, 0, 0.9); }
        }
        // urban positions: broken brick / concrete thrown out with the spoil
        if (style === 'urban') for (let t = 0.8; t < L; t += 2.2) { if (R() > 0.4) continue; const side = R() < 0.5 ? 1 : -1, o = (q.w || 0.5) + 0.7 + R() * 1.2, x = ax0 + ux * t - uz * o * side, z = az0 + uz * t + ux * o * side; if (this.cutSDF(x, z) < 0.5) continue; place('debris_conc', x, Math.max(0, this.topH(x, z, false)) - 0.06, z, R() * 6.28, 0, 0.7 + R() * 0.6); }
        // overhead cover: a section every so often under a camo net / cut branches / a tarp / an anti-drone net
        if (L > 2.2) for (let t = 1.2; t < L - 1.2; t += 4.5) {
          const x = ax0 + ux * t, z = az0 + uz * t; if (this.cutSDF(x, z) > -0.25) continue;
          const r = R(), wTr = 2 * (q.w || 0.5) + 2 * Math.max(0, widen(x, z) * q.rough);
          const kind = r < 0.13 ? 'net_cover' : r < 0.22 ? 'branch_cover' : r < 0.25 ? 'tarp_cover' : r < 0.27 && q.kind === 'comm' ? 'net_drone' : null;
          if (kind) this.covers.push([x, z, ux, uz, wTr, kind]);
        }
      }
    }
    // overhead covers (after all cuts, so they can measure the actual width and sit on the lips)
    for (const [x, z, ux, uz, wTr, kind] of this.covers) {
      const lipA = this.topH(x - uz * (wTr / 2 + 0.25), z + ux * (wTr / 2 + 0.25), false), lipB = this.topH(x + uz * (wTr / 2 + 0.25), z - ux * (wTr / 2 + 0.25), false);
      const y = Math.max(0, Math.min(lipA, lipB)) + 0.02, across = (wTr + 1.3) / (kind === 'net_drone' ? 2.0 : kind === 'tarp_cover' ? 2.2 : 2.6);
      place(kind, x, y, z, Math.atan2(ux, uz) + Math.PI / 2 + (R() - 0.5) * 0.25, 0, 0.85 + R() * 0.35, 1, Math.max(0.7, across));
    }
  }
  noise(x, z) { const t = Math.sin(Math.floor(x) * 127.1 + Math.floor(z) * 311.7) * 43758.5453; return t - Math.floor(t); }
  // ================================================================ rubble / pile heights from meshes
  // local max-height raster of a template (0.2 m), smoothed so vehicles roll over it instead of catching on rebar
  templateHeights(tpl) {
    let H = this._tplH.get(tpl); if (H) return H;
    tpl.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(tpl.matrixWorld).invert(), box = new THREE.Box3().setFromObject(tpl).applyMatrix4(inv);
    const C = 0.2, x0 = box.min.x - C, z0 = box.min.z - C, nx = Math.ceil((box.max.x - x0) / C) + 2, nz = Math.ceil((box.max.z - z0) / C) + 2;
    const g = new Float32Array(nx * nz), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), M = new THREE.Matrix4();
    tpl.traverse(o => {
      if (!o.isMesh) return; M.multiplyMatrices(inv, o.matrixWorld);
      const pos = o.geometry.attributes.position, idx = o.geometry.index, n = idx ? idx.count : pos.count;
      for (let f = 0; f < n; f += 3) {
        a.fromBufferAttribute(pos, idx ? idx.getX(f) : f).applyMatrix4(M); b.fromBufferAttribute(pos, idx ? idx.getX(f + 1) : f + 1).applyMatrix4(M); c.fromBufferAttribute(pos, idx ? idx.getX(f + 2) : f + 2).applyMatrix4(M);
        const area = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x); if (Math.abs(area) < 1e-6) continue;
        const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - x0) / C)), i1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x, c.x) - x0) / C));
        const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - z0) / C)), j1 = Math.min(nz - 1, Math.ceil((Math.max(a.z, b.z, c.z) - z0) / C));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const px = x0 + i * C, pz = z0 + j * C;
          const w0 = ((b.x - px) * (c.z - pz) - (b.z - pz) * (c.x - px)) / area, w1 = ((c.x - px) * (a.z - pz) - (c.z - pz) * (a.x - px)) / area, w2 = 1 - w0 - w1;
          if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
          const y = w0 * a.y + w1 * b.y + w2 * c.y, k = j * nx + i; if (y > g[k]) g[k] = y;
        }
      }
    });
    // smooth: 2 passes of 3x3 mean over a 3x3 max-closed raster (fills slivers, removes spikes)
    let s = new Float32Array(g);
    for (let pass = 0; pass < 2; pass++) { const o = new Float32Array(nx * nz); for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { let sum = 0, n = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue; sum += s[jj * nx + ii]; n++; } o[j * nx + i] = sum / n; } s = o; }
    for (let k = 0; k < s.length; k++) s[k] = Math.max(0, Math.min(s[k], g[k] + 0.05, s[k]));
    H = { g: s, x0, z0, nx, nz, C, top: Math.max(...s) }; this._tplH.set(tpl, H); return H;
  }
  sampleT(H, lx, lz) {
    const fx = (lx - H.x0) / H.C, fz = (lz - H.z0) / H.C, i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= H.nx - 1 || j >= H.nz - 1) return 0;
    const a = fx - i, b = fz - j, k = j * H.nx + i, g = H.g;
    return (g[k] * (1 - a) + g[k + 1] * a) * (1 - b) + (g[k + H.nx] * (1 - a) + g[k + H.nx + 1] * a) * b;
  }
  // stamp a placed template (rubble pile, collapse heap) into the heightfield (max with what's there; trenches and
  // their edge cells are left alone)
  stamp(tpl, M) {
    const H = this.templateHeights(tpl); if (H.top < 0.05) return;
    const inv = new THREE.Matrix4().copy(M).invert(), p = new THREE.Vector3(), e = M.elements;
    const sy = Math.hypot(e[4], e[5], e[6]), ty = e[13];
    const corners = [[H.x0, H.z0], [H.x0 + H.nx * H.C, H.z0], [H.x0, H.z0 + H.nz * H.C], [H.x0 + H.nx * H.C, H.z0 + H.nz * H.C]].map(([x, z]) => p.set(x, 0, z).applyMatrix4(M).clone());
    const xs = corners.map(v => v.x), zs = corners.map(v => v.z);
    const gi0 = Math.floor((Math.min(...xs) + this.half) / GR), gi1 = Math.ceil((Math.max(...xs) + this.half) / GR), gj0 = Math.floor((Math.min(...zs) + this.half) / GR), gj1 = Math.ceil((Math.max(...zs) + this.half) / GR);
    for (let gj = gj0; gj <= gj1; gj++) for (let gi = gi0; gi <= gi1; gi++) {
      p.set(gi * GR - this.half, 0, gj * GR - this.half).applyMatrix4(inv);
      const h = this.sampleT(H, p.x, p.z); if (h < 0.03) continue;
      if (this.cuts.length && this.cutSDF(gi * GR - this.half, gj * GR - this.half) < 1.0) continue;   // never fills a trench
      this.writeV(gi, gj, h * sy + ty, true);
    }
  }
}
