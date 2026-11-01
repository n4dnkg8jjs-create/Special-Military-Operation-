import * as THREE from 'three';
import { BLOCK } from './nav.js';
import { trs } from './instancer.js';

// Ground relief for the flat game world: field fortifications cut INTO the ground (trenches with vertical revetted
// walls, firing bays, dugout passages), smooth relief (anti-tank ditches, spoil berms, parapets, dugout mounds) and
// rubble piles, all feeding one sparse heightfield that the game queries with groundHeight(x, z).
//
//   cuts     convex quads (x-z) with vertical walls and a flat floor at -depth; the union of the quads is the hole.
//            Signed distance S(p) = min over quads of max over the quad's edge planes  (exact on the zero set, sharp
//            mitred corners).  Parapets / parados are a function of S and the side of the quad's 'front'.
//   reliefs  ditches (polyline, trapezoid profile + spoil berm) and mounds (rounded boxes); mesh:false = height only.
//   heights  16 m tiles of (CPT+1)^2 Float32 vertices at RES m, allocated only where something is non-flat.
//
// Rendering: the cut / relief areas get their own terrain mesh (same splat shader as the ground, plus depth
// darkening), built on a GR grid whose vertices next to a cut are snapped onto the cut outline, so lips are crisp
// and walls exactly vertical; the main ground plane discards fragments where the hole mask (1 px / m) is set.
const TS = 16, CPT = 40, RES = TS / CPT, VW = CPT + 1;   // heightfield tiles: 16 m, 0.4 m cells
const GR = RES;                                           // trench mesh grid == heightfield grid (shared vertices)
const BLK = 20;                                           // meshing block: 20 cells = 8 m
const CORR = 3.3;                                         // the terrain mesh covers the cut + this margin
const HC = 8;                                             // feature hash cell (m)
const LOW = -0.02;                                        // terrain mesh rim, tucked just under the ground plane
// cut kinds: parapet front / rear height, nav cost (infantry), vehicle flag (1 = wheeled can't cross, 2 = no vehicle)
const KIND = {
  fire: { pf: 0.36, pr: 0.24, cost: 3, veh: 1 }, comm: { pf: 0.26, pr: 0.26, cost: 3, veh: 1 },
  bay: { pf: 0.34, pr: 0.0, cost: 3, veh: 1 }, pass: { pf: 0.2, pr: 0.2, cost: 3, veh: 2 }, pit: { pf: 0.3, pr: 0.2, cost: 4, veh: 2 },
};
const hkey = (x, z) => Math.floor(x / HC) * 8192 + Math.floor(z / HC);

export class Terrain {
  constructor(size, nav, rng = Math.random) {
    this.size = size; this.half = size / 2; this.nav = nav; this.R = rng;
    this.TN = Math.ceil(size / TS); this.tiles = new Array(this.TN * this.TN).fill(null);
    this.tmax = new Float32Array(this.TN * this.TN); this.tmin = new Float32Array(this.TN * this.TN);
    this.cuts = []; this.reliefs = []; this.hCut = new Map(); this.hRel = new Map();
    this.dress = new Map();   // piece name -> [Matrix4]
    this.blocks = new Set();  // 8 m meshing blocks touched by features
    this.maxH = 0; this._tplH = new Map();
    this._touch = []; this._stamp = 0; this._pd = null;
    this.roadTest = null;     // (x, z, pad) => bool, set by the map so trenches leave gaps at roads
    this.keepOut = null;      // (x, z) => bool, e.g. buildings / village yards
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
  heightAt(x, z) {
    const u = (x + this.half) / TS, v = (z + this.half) / TS, ti = Math.floor(u), tj = Math.floor(v);
    if (ti < 0 || tj < 0 || ti >= this.TN || tj >= this.TN) return 0;
    const t = this.tiles[tj * this.TN + ti]; if (!t) return 0;
    const fx = (u - ti) * CPT, fz = (v - tj) * CPT, i = Math.min(CPT - 1, fx | 0), j = Math.min(CPT - 1, fz | 0), a = fx - i, b = fz - j, k = j * VW + i;
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
  // A cut is a simple polygon (strip runs, firing cells, passages) with vertical walls and a flat floor at -depth.
  // Edges are hashed; S(p) per polygon = exact signed distance to its edges (sign from the edge normal, or the vertex
  // pseudo-normal at corners), union = min over polygons (overlapping pieces stay negative inside, no seams).
  addPoly(pts, o) {
    pts = pts.map(p => [p[0], p[1]]);
    let area = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a[0] * b[1] - b[0] * a[1]; }
    if (area < 0) pts.reverse();
    const n = pts.length, K = KIND[o.kind] || KIND.fire, id = this.cuts.length;
    const q = { pts, depth: o.depth, kind: o.kind, K, front: o.front || null, revet: o.revet || null, sys: o.sys, segs: o.segs || null, tag: o.tag, id, edges: [] };
    q.cx = pts.reduce((s, p) => s + p[0], 0) / n; q.cz = pts.reduce((s, p) => s + p[1], 0) / n;
    const N = []; for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1; N.push([dz / L, -dx / L, L]); }
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], [nx, nz, L] = N[i], pa = N[(i + n - 1) % n], pb = N[(i + 1) % n];
      const e = { ax: a[0], az: a[1], bx: b[0], bz: b[1], nx, nz, L, q, wall: o.walls ? o.walls[i] : 1, pax: nx + pa[0], paz: nz + pa[1], pbx: nx + pb[0], pbz: nz + pb[1] };
      q.edges.push(e);
      const m = CORR + 1;
      for (let x = Math.floor((Math.min(a[0], b[0]) - m) / HC); x <= Math.floor((Math.max(a[0], b[0]) + m) / HC); x++) for (let z = Math.floor((Math.min(a[1], b[1]) - m) / HC); z <= Math.floor((Math.max(a[1], b[1]) + m) / HC); z++) { const k = x * 8192 + z; (this.hCut.get(k) || this.hCut.set(k, []).get(k)).push(e); }
    }
    const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
    q.bb = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
    this.cuts.push(q); this._pd = null;
    this.markBlocks(q.bb[0] - CORR - 0.5, q.bb[1] - CORR - 0.5, q.bb[2] + CORR + 0.5, q.bb[3] + CORR + 0.5);
    return q;
  }
  markBlocks(x0, z0, x1, z1) { const B = BLK * GR; for (let i = Math.floor((x0 + this.half) / B); i <= Math.floor((x1 + this.half) / B); i++) for (let j = Math.floor((z0 + this.half) / B); j <= Math.floor((z1 + this.half) / B); j++) this.blocks.add(i * 8192 + j); }
  // per-polygon signed distances at (x, z) for the polygons whose edges are hashed here; returns the touched list
  polyDists(x, z) {
    const l = this.hCut.get(hkey(x, z)); this._touch.length = 0; if (!l) return this._touch;
    if (!this._pd || this._pd.length < this.cuts.length) { this._pd = new Float64Array(this.cuts.length + 64); this._ps = new Float64Array(this.cuts.length + 64); this._pst = new Uint32Array(this.cuts.length + 64); }
    const st = ++this._stamp, pd = this._pd, ps = this._ps, pst = this._pst, touch = this._touch;
    for (let n = 0; n < l.length; n++) {
      const e = l[n], dx = e.bx - e.ax, dz = e.bz - e.az, wx = x - e.ax, wz = z - e.az;
      let t = (wx * dx + wz * dz) / (e.L * e.L); let sx, sz;
      if (t <= 0) { t = 0; sx = e.pax; sz = e.paz; } else if (t >= 1) { t = 1; sx = e.pbx; sz = e.pbz; } else { sx = e.nx; sz = e.nz; }
      const px = wx - dx * t, pz = wz - dz * t, d2 = px * px + pz * pz, id = e.q.id;
      if (pst[id] !== st) { pst[id] = st; pd[id] = d2; ps[id] = px * sx + pz * sz; touch.push(id); }
      else if (d2 < pd[id] - 1e-12) { pd[id] = d2; ps[id] = px * sx + pz * sz; }
    }
    for (const id of touch) pd[id] = (ps[id] < 0 ? -1 : 1) * Math.sqrt(pd[id]);
    return touch;
  }
  // signed distance to the union of cuts (m, < 0 inside); this._q = the polygon it comes from (deepest inside)
  cutSDF(x, z) {
    const touch = this.polyDists(x, z); this._q = null; let best = 99;
    for (const id of touch) { const d = this._pd[id]; if (d < best) { best = d; this._q = this.cuts[id]; } }
    return best;
  }
  // parapet / parados / spoil height outside the cut
  parapet(x, z) {
    const touch = this.polyDists(x, z); if (!touch.length) return 0;
    let h = 0;
    for (const id of touch) {
      const d = this._pd[id]; if (d < 0 || d > 2.6) continue; const q = this.cuts[id];
      const fr = q.front ? ((x - q.cx) * q.front[0] + (z - q.cz) * q.front[1] > 0) : true;
      const H = fr ? q.K.pf : q.K.pr; if (H <= 0) continue;
      const W = fr ? 2.3 : 1.7, t = d / W;
      const prof = t < 0.14 ? 0.5 + 0.5 * t / 0.14 : t < 0.42 ? 1 : t < 1 ? Math.pow(1 - ((t - 0.42) / 0.58) ** 2, 1.3) : 0;
      h = Math.max(h, H * prof);
    }
    return h > 0 ? h * (1 + 0.16 * Math.sin(x * 1.31 + z * 0.73) * Math.sin(z * 1.67 - x * 0.41)) : 0;
  }
  addRelief(r) {
    r.bb = r.type === 'ditch' ? (() => { const xs = r.pts.map(p => p[0]), zs = r.pts.map(p => p[1]); return [Math.min(...xs) - r.reach, Math.min(...zs) - r.reach, Math.max(...xs) + r.reach, Math.max(...zs) + r.reach]; })()
      : (() => { const R = Math.hypot(r.hx, r.hz) + 0.5; return [r.x - R, r.z - R, r.x + R, r.z + R]; })();
    this.reliefs.push(r);
    for (let x = Math.floor((r.bb[0] - 2) / HC); x <= Math.floor((r.bb[2] + 2) / HC); x++) for (let z = Math.floor((r.bb[1] - 2) / HC); z <= Math.floor((r.bb[3] + 2) / HC); z++) { const k = x * 8192 + z; (this.hRel.get(k) || this.hRel.set(k, []).get(k)).push(r); }
    if (r.mesh !== false) this.markBlocks(r.bb[0] - 1.6, r.bb[1] - 1.6, r.bb[2] + 1.6, r.bb[3] + 1.6);
    return r;
  }
  // relief at a point: [negative part (ditch), positive part (berm / mound)], meshOnly = skip height-only features
  relief(x, z, meshOnly) {
    const l = this.hRel.get(hkey(x, z)); if (!l) return null;
    let neg = 0, pos = 0, hit = false;
    for (const r of l) {
      if (meshOnly && r.mesh === false) continue;
      if (x < r.bb[0] || x > r.bb[2] || z < r.bb[1] || z > r.bb[3]) continue;
      if (r.type === 'ditch') {
        let best = 1e9, side = 0;
        for (let i = 0; i < r.pts.length - 1; i++) { const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz; let t = ((x - ax) * dx + (z - az) * dz) / L2; t = Math.max(0, Math.min(1, t)); const px = ax + dx * t - x, pz = az + dz * t - z, d = Math.hypot(px, pz); if (d < best) { best = d; side = Math.sign(dx * (z - az) - dz * (x - ax)); } }
        if (best > r.reach) continue; hit = true;
        if (best < r.top) neg = Math.min(neg, best < r.bot ? -r.depth : -r.depth * Math.pow(1 - (best - r.bot) / (r.top - r.bot), 0.85));
        const bd = best - r.top - 0.4; if (side === r.bermSide && bd > 0 && bd < r.bermW) pos = Math.max(pos, r.bermH * Math.sin(Math.PI * bd / r.bermW) ** 0.8 * (1 + 0.12 * Math.sin(x * 0.9 + z * 1.3)));
      } else { // mound: rounded box
        const c = Math.cos(r.rot), s = Math.sin(r.rot), dx = x - r.x, dz = z - r.z, lx = (dx * c - dz * s) / r.hx, lz = (dx * s + dz * c) / r.hz;
        const e = Math.pow(Math.abs(lx), 4) + Math.pow(Math.abs(lz), 4); if (e >= 1) continue; hit = true;
        pos = Math.max(pos, r.h * Math.pow(1 - e, 0.6));
      }
    }
    return hit ? [neg, pos] : null;
  }
  // top-surface height outside the cut (mesh = terrain mesh version: skips height-only mounds and keeps the LOW rim)
  topH(x, z, mesh) {
    const rel = this.relief(x, z, mesh);
    let pos = Math.max(this.parapet(x, z), rel ? rel[1] : 0);
    if (rel && rel[0] < -0.001) return rel[0];
    return pos > 0.004 ? pos : (mesh ? LOW : 0);
  }
  // ---------------------------------------------------------------- trench builders
  // polyline -> one polygon (mitred offset outline); segs keeps the centre line for duckboards
  strip(P, w, o) {
    const n = P.length; if (n < 2) return [];
    const N = []; for (let i = 0; i < n - 1; i++) { const dx = P[i + 1][0] - P[i][0], dz = P[i + 1][1] - P[i][1], L = Math.hypot(dx, dz) || 1; N.push([-dz / L, dx / L]); }
    const off = i => { if (i === 0) return [N[0][0] * w, N[0][1] * w]; if (i === n - 1) return [N[n - 2][0] * w, N[n - 2][1] * w]; let mx = N[i - 1][0] + N[i][0], mz = N[i - 1][1] + N[i][1]; const L = Math.hypot(mx, mz) || 1; mx /= L; mz /= L; const k = Math.min(1.9, 1 / Math.max(0.3, mx * N[i][0] + mz * N[i][1])); return [mx * w * k, mz * w * k]; };
    const O = P.map((_, i) => off(i));
    const pts = [...P.map((p, i) => [p[0] + O[i][0], p[1] + O[i][1]]), ...P.map((p, i) => [p[0] - O[i][0], p[1] - O[i][1]]).reverse()];
    const segs = []; for (let i = 0; i < n - 1; i++) segs.push([P[i][0], P[i][1], P[i + 1][0], P[i + 1][1]]);
    return [this.addPoly(pts, { ...o, segs, w })];
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
        const o = style === 'wiggle' ? (k % 2 ? 1 : -1) * amp * (0.35 + R() * 0.65) : (k % 2 ? 0.5 : -0.5) * amp * (0.8 + R() * 0.4);
        pts.push(at(t, o)); if (o > 0) fwd.push(pts.length - 1);
        t += leg * (0.75 + R() * 0.5); k++;
      }
      if (s === base.length - 2) pts.push(at(L, 0));
    }
    return { pts, fwd };
  }
  // Fire trench: zig-zag (Russian 'lomanaya'), crenellated (bays + traverses) or wiggly (tree-line) along `base`,
  // firing cells on the front side, revetment of the given type. front = unit vector towards the enemy.
  fireTrench(base, o = {}) {
    const R = this.R, front = o.front, w = (o.width || 1.0) / 2, depth = o.depth || 1.7, style = o.style || 'zigzag';
    // which side of the baseline is the front?
    const [ax, az] = base[0], [bx, bz] = base[base.length - 1], fs = Math.sign((-(bz - az)) * front[0] + (bx - ax) * front[1]) || 1;
    const { pts, fwd } = this.zigzag(base, style, o.leg || 7, o.amp || 2.4, fs);
    const sys = o.sys, made = [];
    for (const run of this.runs(pts, 3.5)) made.push(...this.strip(run, w, { kind: 'fire', depth, front, revet: o.revet, sys }));
    // firing cells: small pits pushed forward from the forward vertices
    const every = o.bayEvery ?? 2, bays = [];
    fwd.forEach((i, n) => {
      if (n % every || !pts[i]) return;
      const [x, z] = pts[i]; if (this.cutSDF(x, z) > -0.05) return; // vertex dropped (road gap)
      const L = 1.15 + R() * 0.3, W = 0.65, d0 = w - 0.1, fx = front[0], fz = front[1], sx = -fz, sz = fx;
      const c = (a, b) => [x + fx * a + sx * b, z + fz * a + sz * b];
      if (this.roadTest && this.roadTest(x + fx * (d0 + L), z + fz * (d0 + L), 2)) return;
      bays.push(this.addPoly([c(d0, -W), c(d0 + L, -W), c(d0 + L, W), c(d0, W)], { kind: 'bay', depth: o.bayDepth || 1.1, front, revet: o.revet, sys, tag: { x, z, fx, fz, L: d0 + L } }));
    });
    return { pts, quads: made, bays, front, depth, w, sys };
  }
  commTrench(base, o = {}) {
    const style = o.style || 'zigzag', w = (o.width || 0.85) / 2;
    const P = base.length === 2 && style !== 'straight' ? this.zigzag(base, style === 'wiggle' ? 'wiggle' : 'zigzag', o.leg || 9, o.amp || 3, 1).pts : base;
    // keep the exact end points (junctions)
    P[0] = base[0]; P[P.length - 1] = base[base.length - 1];
    const made = []; for (const run of this.runs(P, 3)) made.push(...this.strip(run, w, { kind: 'comm', depth: o.depth || 1.55, front: null, revet: o.revet, sys: o.sys }));
    return { pts: P, quads: made };
  }
  // Dugout (blindazh): passage from the trench point (x,z) going along (dx,dz), ending at a log-roofed, earth-covered
  // pit; the roof mound is height-only (the dugout_roof piece carries its own earth cover).
  dugout(x, z, dx, dz, o = {}) {
    const L = Math.hypot(dx, dz); dx /= L; dz /= L;
    const len = o.len || 3.2, depth = o.depth || 1.7, ex = x + dx * len, ez = z + dz * len;
    this.strip([[x - dx * 0.6, z - dz * 0.6], [ex, ez]], 0.42, { kind: 'pass', depth, front: null, revet: o.revet || 'logs', sys: o.sys });
    const hl = 2.5, cx = ex + dx * hl, cz = ez + dz * hl, rot = Math.atan2(dx, dz);
    this.addRelief({ type: 'mound', x: cx, z: cz, hx: 2.35, hz: 2.75, rot: -rot, h: 0.62, mesh: false, nav: 'dugout' });
    this.put('dugout_roof', trs(cx, 0, cz, rot + Math.PI));
    return [cx, cz];
  }
  // covered machine-gun position over a firing cell (log roof on posts, sandbag cheeks, embrasure to the front)
  mgNest(bay) { const t = bay.tag; const cx = t.x + t.fx * (t.L - 0.7), cz = t.z + t.fz * (t.L - 0.7); this.put('mg_nest_roof', trs(cx, 0, cz, Math.atan2(t.fx, t.fz))); bay.covered = true; }
  antitankDitch(pts, o = {}) {
    const r = { type: 'ditch', pts, top: (o.top || 5.6) / 2, bot: (o.bot || 0.9) / 2, depth: o.depth || 2.6, bermSide: o.bermSide || 1, bermW: o.bermW || 4.5, bermH: o.bermH || 0.9 };
    r.reach = r.top + 0.4 + r.bermW + 0.2;
    for (const run of this.runs(pts, r.reach)) this.addRelief({ ...r, pts: run });
  }
  // rows of concrete pyramids ("dragon's teeth"), staggered; gaps where roads cross
  dragonTeeth(pts, o = {}) {
    const R = this.R, rows = o.rows || 3, gap = o.gap || 2.1, rowGap = o.rowGap || 2.0;
    for (let s = 0; s < pts.length - 1; s++) {
      const [ax, az] = pts[s], [bx, bz] = pts[s + 1], L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux;
      for (let r = 0; r < rows; r++) for (let t = (r % 2) * gap * 0.5; t < L; t += gap) {
        const off = (r - (rows - 1) / 2) * rowGap, x = ax + ux * t + nx * off + (R() - .5) * 0.25, z = az + uz * t + nz * off + (R() - .5) * 0.25;
        if (this.roadTest && this.roadTest(x, z, 4)) continue;
        if (this.keepOut && this.keepOut(x, z)) continue;
        if (R() < 0.03) continue; // a few lifted out / blown
        const bad = R() < 0.07;
        this.put(bad ? 'dragon_tooth_b' : 'dragon_tooth', trs(x, -0.12 - R() * 0.1, z, R() * 6.28, 0.92 + R() * 0.16, bad ? (R() - .5) * 0.5 : (R() - .5) * 0.06, bad ? (R() - .5) * 0.5 : (R() - .5) * 0.06));
        (this.teeth ||= []).push([x, z]);
      }
    }
  }
  put(name, M) { (this.dress.get(name) || this.dress.set(name, []).get(name)).push(M); }
  // ================================================================ finalise: heights, nav, mask, meshes, dressing
  // vertex record cache over the global GR grid
  vrec(gi, gj) {
    const k = gi * 65536 + gj; let v = this._vc.get(k); if (v) return v;
    const x = gi * GR - this.half, z = gj * GR - this.half, S = this.cutSDF(x, z), q = this._q;
    v = { x, z, S, q, cls: S < 0 ? 2 : 0 }; this._vc.set(k, v); return v;
  }
  finalize(opts = {}) {
    const tt = this.times = {}, t0 = performance.now(), lap = k => { tt[k] = Math.round(performance.now() - t0); };
    this._vc = new Map();
    const nb = Math.round(this.size / GR);
    // 1) classify + snap vertices of every active block (+1 ring for neighbour tests)
    const blocks = [...this.blocks];
    for (const b of blocks) {
      const bi = Math.floor(b / 8192), bj = b % 8192, i0 = bi * BLK, j0 = bj * BLK;
      for (let gj = j0; gj <= j0 + BLK; gj++) for (let gi = i0; gi <= i0 + BLK; gi++) {
        if (gi < 0 || gj < 0 || gi > nb || gj > nb) continue;
        const v = this.vrec(gi, gj); if (v.done) continue; v.done = true;
        if (v.cls === 2) { // inside: boundary if any 8-neighbour is outside
          let bnd = false; for (let dj = -1; dj <= 1 && !bnd; dj++) for (let di = -1; di <= 1; di++) { if (!di && !dj) continue; if (this.vrec(gi + di, gj + dj).S >= 0) { bnd = true; break; } }
          if (bnd) { v.cls = 1; this.snap(v); }
        }
        if (v.cls === 2) { v.H = -v.q.depth; }
        else { v.H = this.topH(v.x, v.z, true); v.Hh = this.topH(v.x, v.z, false); }
        if (v.cls === 1) { v.F = -v.q.depth; }
      }
    }
    // 2) heightfield: raw grid points (not snapped): inside -> floor, else top (height-only mounds included)
    for (const b of blocks) {
      const bi = Math.floor(b / 8192), bj = b % 8192, i0 = bi * BLK, j0 = bj * BLK;
      for (let gj = j0; gj <= j0 + BLK; gj++) for (let gi = i0; gi <= i0 + BLK; gi++) {
        if (gi < 0 || gj < 0 || gi > nb || gj > nb) continue;
        const v = this.vrec(gi, gj), h = v.S < 0 ? -v.q.depth : v.Hh;
        if (Math.abs(h) > 0.003) this.writeV(gi, gj, h, false);
      }
    }
    // height-only mounds outside the meshed blocks (dugout roofs)
    for (const r of this.reliefs) if (r.mesh === false) {
      for (let gj = Math.floor((r.bb[1] + this.half) / GR); gj <= Math.ceil((r.bb[3] + this.half) / GR); gj++) for (let gi = Math.floor((r.bb[0] + this.half) / GR); gi <= Math.ceil((r.bb[2] + this.half) / GR); gi++) {
        const x = gi * GR - this.half, z = gj * GR - this.half, rel = this.relief(x, z, false); if (rel && rel[1] > 0.003) this.writeV(gi, gj, rel[1], true);
      }
    }
    lap('heights');
    this.markNav(); lap('nav');
    this.buildMask(); lap('mask');
    if (opts.scene) this.buildMeshes(opts.scene, opts.matTop, opts.matWall, opts.groundS);
    lap('meshes');
    this.buildDressing(opts); lap('dressing');
    this._vc = null;
  }
  snap(v) {
    let x = v.x, z = v.z; const e = 0.02;
    for (let it = 0; it < 4; it++) {
      const S = this.cutSDF(x, z); if (Math.abs(S) < 1e-4) break;
      const gx = (this.cutSDF(x + e, z) - this.cutSDF(x - e, z)) / (2 * e), gz = (this.cutSDF(x, z + e) - this.cutSDF(x, z - e)) / (2 * e), g2 = gx * gx + gz * gz || 1;
      x -= S * gx / g2; z -= S * gz / g2;
    }
    const dx = x - v.x, dz = z - v.z, d = Math.hypot(dx, dz), mx = GR * 0.95;
    if (d > mx) { x = v.x + dx / d * mx; z = v.z + dz / d * mx; }
    v.x = x; v.z = z; this.cutSDF(x, z); v.q = this._q || v.q;
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
        else if (rel && rel[1] > 0.5) { nav.veh[i] = Math.max(nav.veh[i], 1); }
      }
    }
    for (const r of this.reliefs) if (r.nav === 'dugout') nav.rect(r.x, r.z, r.hx * 0.85, r.hz * 0.85, r.rot, 4, 0), nav.setVeh(r.x, r.z, r.hx, r.hz, r.rot, 2);
    for (const [x, z] of this.teeth || []) { nav.circle(x, z, 0.45, BLOCK); }
    if (this.teeth) for (const [x, z] of this.teeth) nav.setVeh(x, z, 1.6, 1.6, 0, 2);
    nav.vehDirty = true;
  }
  // 1 px / m hole mask for the ground plane (R channel): cut + parapet zone and meshed relief
  buildMask() {
    const N = Math.round(this.size), data = new Uint8Array(N * N);
    for (const b of this.blocks) {
      const bi = Math.floor(b / 8192), bj = b % 8192, x0 = bi * BLK * GR - this.half, z0 = bj * BLK * GR - this.half;
      for (let z = Math.floor(z0) + 0.5; z < z0 + BLK * GR; z += 1) for (let x = Math.floor(x0) + 0.5; x < x0 + BLK * GR; x += 1) {
        const i = Math.floor(x + this.half), j = Math.floor(z + this.half); if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const S = this.cutSDF(x, z); let hole = S < 2.15;
        if (!hole) { const rel = this.relief(x, z, true); if (rel && (rel[0] < -0.004 || rel[1] > 0.004)) hole = true; }
        if (hole) data[j * N + i] = 255;
      }
    }
    // reliefs: dilate 1 px (their mesh reaches 1.6 m past the feature)
    const t = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType); t.flipY = false; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    this.mask = t; this.maskData = data; this.maskN = N;
    return t;
  }
  // terrain meshes per 64 m chunk: top + floor (ground material) and walls (earth material)
  buildMeshes(scene, matTop, matWall, groundS) {
    const CH = 64, chunks = new Map(), nb = Math.round(this.size / GR);
    const chunkOf = (x, z) => { const k = Math.floor((x + this.half) / CH) * 1024 + Math.floor((z + this.half) / CH); let c = chunks.get(k); if (!c) chunks.set(k, c = { tp: [], tn: [], tu: [], ti: [], tmap: new Map(), fmap: new Map(), wp: [], wn: [], wu: [] }); return c; };
    const S = groundS, uvOf = (x, z) => [x / S + 0.5, 0.5 - z / S];
    const nrmH = (x, z) => { const e = 0.2, hx = this.topH(x + e, z, true) - this.topH(x - e, z, true), hz = this.topH(x, z + e, true) - this.topH(x, z - e, true), L = Math.hypot(hx / (2 * e), 1, hz / (2 * e)); return [-hx / (2 * e) / L, 1 / L, -hz / (2 * e) / L]; };
    const vtx = (c, key, v, floor) => {
      const map = floor ? c.fmap : c.tmap; let i = map.get(key); if (i !== undefined) return i;
      i = c.tp.length / 3; map.set(key, i);
      const y = floor ? (v.F ?? v.H) : v.H; c.tp.push(v.x, y, v.z); c.tu.push(...uvOf(v.x, v.z));
      if (floor || v.cls === 1) c.tn.push(0, 1, 0); else c.tn.push(...nrmH(v.x, v.z));
      return i;
    };
    const edges = new Map(); // edge key -> {a, b, top, floor, fx, fz (floor-side point)}
    const inMesh = v => v.S < CORR || v.H > LOW + 0.001 || v.H < LOW - 0.001;
    for (const b of this.blocks) {
      const bi = Math.floor(b / 8192), bj = b % 8192, i0 = bi * BLK, j0 = bj * BLK;
      for (let gj = j0; gj < j0 + BLK; gj++) for (let gi = i0; gi < i0 + BLK; gi++) {
        if (gi < 0 || gj < 0 || gi >= nb || gj >= nb) continue;
        const ids = [[gi, gj], [gi + 1, gj], [gi + 1, gj + 1], [gi, gj + 1]], V = ids.map(([a, c]) => this.vrec(a, c));
        if (!V.some(inMesh)) continue;
        const keys = ids.map(([a, c]) => a * 65536 + c);
        const diag = (gi + gj) % 2 === 0;
        const tris = diag ? [[0, 2, 1], [0, 3, 2]] : [[0, 3, 1], [1, 3, 2]];
        const ccx = (V[0].x + V[2].x) / 2, ccz = (V[0].z + V[2].z) / 2, c = chunkOf(gi * GR - this.half + 0.2, gj * GR - this.half + 0.2);
        for (const t of tris) {
          const tv = t.map(k => V[k]); let floor;
          if (tv.some(v => v.cls === 0)) floor = false; else if (tv.some(v => v.cls === 2)) floor = true;
          else { const ox = t.reduce((s, k) => s + (ids[k][0] * GR - this.half), 0) / 3, oz = t.reduce((s, k) => s + (ids[k][1] * GR - this.half), 0) / 3; floor = this.cutSDF(ox, oz) < 0; }
          const ia = vtx(c, keys[t[0]], tv[0], floor), ib = vtx(c, keys[t[1]], tv[1], floor), ic = vtx(c, keys[t[2]], tv[2], floor);
          // winding: up-facing (x-z ccw seen from +Y)
          const ax = tv[0].x, az = tv[0].z, cr = (tv[1].x - ax) * (tv[2].z - az) - (tv[1].z - az) * (tv[2].x - ax);
          if (cr < 0) c.ti.push(ia, ib, ic); else c.ti.push(ia, ic, ib);
          for (let e = 0; e < 3; e++) {
            const p = t[e], q = t[(e + 1) % 3]; if (V[p].cls !== 1 || V[q].cls !== 1) continue;
            const ka = keys[p], kb = keys[q], ek = ka < kb ? ka + ':' + kb : kb + ':' + ka; let E = edges.get(ek);
            if (!E) edges.set(ek, E = { a: V[p], b: V[q] });
            if (floor) { const o = t[(e + 2) % 3]; E.floor = true; E.fx = V[o].x; E.fz = V[o].z; } else E.top = true;
          }
        }
      }
    }
    // walls along top|floor edges
    let nw = 0;
    for (const E of edges.values()) {
      if (!E.top || !E.floor) continue;
      const { a, b } = E, c = chunkOf((a.x + b.x) / 2, (a.z + b.z) / 2);
      let nx = -(b.z - a.z), nz = b.x - a.x; const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
      if ((E.fx - a.x) * nx + (E.fz - a.z) * nz < 0) { nx = -nx; nz = -nz; }
      const ya0 = a.H, yb0 = b.H, ya1 = a.F, yb1 = b.F;
      const P = [[a.x, ya0, a.z], [b.x, yb0, b.z], [b.x, yb1, b.z], [a.x, ya1, a.z]];
      // front face towards the trench (normal n): order so that (P1-P0)x(P3-P0) points along n
      const ux = b.x - a.x, uz = b.z - a.z, cy = ux * nz - uz * nx; // y-component sign check of cross((b-a),(down)) ~ horizontal normal
      const order = cy > 0 ? [0, 3, 2, 0, 2, 1] : [0, 1, 2, 0, 2, 3];
      const along = Math.abs(nx) > Math.abs(nz) ? 'z' : 'x';
      for (const k of order) { const p = P[k]; c.wp.push(p[0], p[1], p[2]); c.wn.push(nx, 0, nz); c.wu.push((along === 'x' ? p[0] : p[2]) / 1.6, p[1] / 1.6); }
      nw++;
    }
    this.meshes = [];
    let tris = 0;
    for (const c of chunks.values()) {
      if (c.ti.length) {
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(c.tp, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(c.tn, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(c.tu, 2)); g.setIndex(c.ti); g.computeBoundingSphere();
        const m = new THREE.Mesh(g, matTop); m.receiveShadow = true; m.castShadow = true; m.name = 'terrain'; scene.add(m); this.meshes.push(m); tris += c.ti.length / 3;
      }
      if (c.wp.length) {
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(c.wp, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(c.wn, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(c.wu, 2)); g.computeBoundingSphere();
        const m = new THREE.Mesh(g, matWall); m.receiveShadow = true; m.castShadow = true; m.name = 'terrain_walls'; scene.add(m); this.meshes.push(m); tris += c.wp.length / 9;
      }
    }
    this.stats = { tris, walls: nw, chunks: chunks.size, cuts: this.cuts.length, reliefs: this.reliefs.length };
  }
  // revetment panels on every exposed cut wall, duckboards, sandbag lips on the firing cells
  buildDressing() {
    const R = this.R;
    for (const q of this.cuts) {
      const revet = q.revet;
      const pieces = !revet || revet === 'none' ? [] : revet === 'mixed' ? ['revet_boards', 'revet_wattle', 'revet_logs'] : ['revet_' + revet];
      for (const ed of pieces.length ? q.edges : []) {
        if (!ed.wall) continue;
        const a = [ed.ax, ed.az], dx = ed.bx - ed.ax, dz = ed.bz - ed.az, L = ed.L; if (L < 0.3) continue;
        const nx = ed.nx, nz = ed.nz; // outward (into the earth)
        const n = Math.max(1, Math.round(L / 1.1)), seg = L / n;
        for (let k = 0; k < n; k++) {
          const t0 = k * seg, mx = a[0] + dx / L * (t0 + seg / 2), mz = a[1] + dz / L * (t0 + seg / 2);
          // skip where the wall opens into another cut (junctions, bays, passages)
          if (this.cutSDF(mx + nx * 0.14, mz + nz * 0.14) < -0.01) continue;
          const e0x = a[0] + dx / L * (t0 + 0.08), e0z = a[1] + dz / L * (t0 + 0.08), e1x = a[0] + dx / L * (t0 + seg - 0.08), e1z = a[1] + dz / L * (t0 + seg - 0.08);
          if (this.cutSDF(e0x + nx * 0.14, e0z + nz * 0.14) < -0.01 || this.cutSDF(e1x + nx * 0.14, e1z + nz * 0.14) < -0.01) continue;
          const top = this.topH(mx + nx * 0.03, mz + nz * 0.03, false) + 0.04, depth = q.depth;
          const name = pieces.length > 1 ? pieces[Math.floor((this.noise(mx * 0.08, mz * 0.08)) * pieces.length) % pieces.length] : pieces[0];
          const ry = Math.atan2(-nx, -nz); // piece +Z faces into the trench
          const M = new THREE.Matrix4().compose(new THREE.Vector3(mx - nx * 0.005, top, mz - nz * 0.005), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(seg + 0.03, top + depth, 1));
          this.put(name, M);
        }
      }
      // duckboards on the trench floor (fire / comm trenches), sometimes missing
      if (q.segs && (q.kind === 'fire' || q.kind === 'comm')) for (const [ax, az, bx, bz] of q.segs) {
        const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L, ry = Math.atan2(ux, uz) + Math.PI / 2;
        for (let t = 0.7; t < L - 0.6; t += 1.28) { if (R() < 0.3) continue; const x = ax + ux * t, z = az + uz * t; if (this.cutSDF(x, z) > -0.25) continue; this.put('duckboard', trs(x, -q.depth + 0.005, z, ry + (R() - .5) * 0.05)); }
      }
      if (q.kind === 'bay' && !q.covered && q.tag) { // sandbag lip on the front parapet
        const t = q.tag, x = t.x + t.fx * (t.L + 0.32), z = t.z + t.fz * (t.L + 0.32);
        this.put('sandbag_row', trs(x, this.topH(x, z, false) - 0.07, z, Math.atan2(t.fx, t.fz)));
      }
      if (q.kind === 'fire' && q.segs) for (const [ax, az, bx, bz] of q.segs) { // ammo crates in the odd traverse
        if (R() > 0.06) continue; const f = 0.3 + R() * 0.4, x = ax + (bx - ax) * f, z = az + (bz - az) * f;
        if (this.cutSDF(x, z) < -0.3) this.put('ammo_crates', trs(x, -q.depth + 0.02, z, Math.atan2(bx - ax, bz - az) + (R() - .5) * 0.4));
      }
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
  // stamp a placed template (rubble pile, collapse heap) into the heightfield (max with what's there)
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
      this.writeV(gi, gj, h * sy + ty, true);
    }
  }
}
