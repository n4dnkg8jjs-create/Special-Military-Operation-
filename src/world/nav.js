// Navigation grid (1 m cells): A* pathfinding for infantry and vehicles, clearance map,
// directional cover map, and segment occlusion against building footprints.
export const BLOCK = 255;
export const TOOTH_R = 1.25;   // vehicle-blocking radius around a dragon's tooth (m)
// Vehicle route costs (per metre, open ground = 1). Wheeled vehicles are road-bound (much cheaper on roads), tracked
// ones only somewhat. laneW / edge: paved cells within laneW m (dirt tracks: trackW) of the edge cost up to (1 + edge) x more, keeping
// routes on the middle of the carriageway. heur: A* heuristic weight per metre (just above the cheapest road cost: a
// road that is reasonably close is found, a long search for a far one is not made).
export const VEH_COST = {
  wheeled: { paved: 0.3, dirt: 0.5 }, tracked: { paved: 0.6, dirt: 0.72 },
  laneW: 4.5, trackW: 1.8, edge: 0.45, heur: { wheeled: 0.55, tracked: 0.75 }, longM: 200,
};
// Infantry route costs (per metre, on top of the cell cost; open ground = 1): scrape = right against a wall (clear < 0.9 m),
// wallBand = along a wall / fence (0.9-2.6 m off it: a slight pull towards facades), threat = a cell a known enemy can
// see into (findPath opts.threat), heur / heurThr = A* heuristic weight without / with a threat (navbench.mjs: threat 1.25 +
// heurThr 1.3 cut the exposed share of routes from 52 % to 37 % for 4 % more length, ~3 ms a query).
export const INF_COST = { scrape: 0.35, wallBand: -0.15, threat: 1.25, heur: 1.0, heurThr: 1.3 };
export const TERRAIN_OCC = { terrain: true, h: 0, ref: null, cx: 0, cz: 0, hx: 0, hz: 0, cos: 1, sin: 0 };

class Heap {
  constructor() { this.k = []; this.v = []; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; } k[i] = lk; v[i] = lv; }
    return top;
  }
  get size() { return this.k.length; }
}

export class NavGrid {
  constructor(size, cell = 1) {
    this.size = size; this.cell = cell; this.n = Math.round(size / cell); this.half = size / 2;
    const N = this.n * this.n;
    this.cost = new Uint8Array(N).fill(1);
    this.clear = new Float32Array(N);   // distance to nearest blocked cell (m)
    this.cover = new Uint8Array(N);     // 8-direction cover bitmask
    this.low = new Uint8Array(N);       // 1 = low cover (rubble, sandbags, wrecks) vs 0 = wall
    this.road = new Uint8Array(N);      // 2 = paved road, 1 = dirt track (vehicles prefer and drive faster on them)
    // set by Terrain when the map has field fortifications / rubble relief:
    //   veh[i]    0 = any vehicle, 1 = wheeled vehicles can't cross (trench; tanks cross slowly), 2 = no vehicle (AT ditch,
    //             dragon's teeth, dugout roofs, dense forest)
    //   trench[i] trench / ditch floor depth in dm (0 = not in a cut); infantry there is in cover (coverFrom = 1)
    this.veh = null; this.trench = null; this.clearV = null; this.clearT = null; this.terrain = null; this.terrainLOS = true;
    this.g = new Float32Array(N); this.from = new Int32Array(N); this.stamp = new Uint32Array(N); this.closed = new Uint32Array(N); this.gen = 1;
    this.occluders = []; // {cx,cz,hx,hz,cos,sin,h, ref}
    this.occGrid = new Map(); this.occCell = 24;
  }
  idx(x, z) { const i = Math.floor((x + this.half) / this.cell), j = Math.floor((z + this.half) / this.cell); if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1; return j * this.n + i; }
  cx(i) { return (i % this.n + 0.5) * this.cell - this.half; }
  cz(i) { return (Math.floor(i / this.n) + 0.5) * this.cell - this.half; }
  // mark an oriented rectangle
  rect(cx, cz, hx, hz, rot, val, pad = 0) {
    const c = Math.cos(rot), s = Math.sin(rot), r = Math.hypot(hx, hz) + pad;
    for (let z = cz - r; z <= cz + r; z += this.cell) for (let x = cx - r; x <= cx + r; x += this.cell) {
      const dx = x - cx, dz = z - cz, lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) <= hx + pad && Math.abs(lz) <= hz + pad) { const i = this.idx(x, z); if (i >= 0) this.cost[i] = Math.max(this.cost[i], val); }
    }
  }
  // overwrite (not max) costs inside an oriented rectangle, e.g. a collapsed building becoming rubble
  setRect(cx, cz, hx, hz, rot, val, low = 1) {
    const c = Math.cos(rot), s = Math.sin(rot), r = Math.hypot(hx, hz);
    for (let z = cz - r; z <= cz + r; z += this.cell) for (let x = cx - r; x <= cx + r; x += this.cell) {
      const dx = x - cx, dz = z - cz, lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) <= hx && Math.abs(lz) <= hz) { const i = this.idx(x, z); if (i >= 0) { this.cost[i] = val; this.low[i] = low; } }
    }
  }
  // vehicle restriction (max) inside an oriented rectangle, see this.veh
  setVeh(cx, cz, hx, hz, rot, val) {
    this.veh ||= new Uint8Array(this.n * this.n); this.vehDirty = true;
    const c = Math.cos(rot), s = Math.sin(rot), r = Math.hypot(hx, hz);
    for (let z = cz - r; z <= cz + r; z += this.cell) for (let x = cx - r; x <= cx + r; x += this.cell) {
      const dx = x - cx, dz = z - cz, lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) <= hx && Math.abs(lz) <= hz) { const i = this.idx(x, z); if (i >= 0) this.veh[i] = Math.max(this.veh[i], val); }
    }
  }
  // ---- dragon's teeth (breachable): a tooth blocks infantry on its own cell and every vehicle within TOOTH_R; the
  // vehicle block is counted per cell (teethN) so removing one tooth only reopens the cells no other tooth covers,
  // restoring what the cell held before (teethBase).  Call refreshArea() after removals (local clearance update).
  addTooth(x, z) { this.toothStamp(x, z, 1); }
  // destroyed tooth: its cell becomes concrete rubble (passable, slow, low cover), its vehicle block is lifted
  removeTooth(x, z, rubbleCost = 4) { this.toothStamp(x, z, -1, rubbleCost); }
  toothStamp(x, z, d, rubbleCost = 4) {
    const N = this.n * this.n; this.veh ||= new Uint8Array(N);
    const tn = this.teethN ||= new Map(), tb = this.teethBase ||= new Map(), cb = this.teethCost ||= new Map(), R = TOOTH_R, c = this.cell;
    for (let zz = z - R - c; zz <= z + R + c; zz += c) for (let xx = x - R - c; xx <= x + R + c; xx += c) {
      const i = this.idx(xx, zz); if (i < 0 || (this.cx(i) - x) ** 2 + (this.cz(i) - z) ** 2 > R * R) continue;
      const k = tn.get(i) || 0;
      if (d > 0) { if (!k) tb.set(i, this.veh[i]); tn.set(i, k + 1); this.veh[i] = Math.max(this.veh[i], 2); }
      else if (k) { if (k > 1) tn.set(i, k - 1); else { tn.delete(i); this.veh[i] = tb.get(i) || 0; tb.delete(i); } }
    }
    const i = this.idx(x, z); if (i < 0) return;
    if (d > 0) { if (!cb.has(i)) cb.set(i, this.cost[i]); this.cost[i] = BLOCK; }
    else if (cb.has(i)) { this.cost[i] = Math.max(cb.get(i) === BLOCK ? 1 : cb.get(i), rubbleCost); this.low[i] = 1; cb.delete(i); }
  }
  // Local update of clearance (clear, clearV, clearT) and cover bits after cells changed inside the rect (cheap: a
  // window padded by the 25.5 m clearance cap, the window border keeps its values as chamfer seeds -- exact for the
  // chamfer metric as long as the change does not reach the border).
  refreshArea(x0, z0, x1, z1, pad = 26) {
    const n = this.n, c = this.cell, i0 = Math.max(0, Math.floor((x0 - pad + this.half) / c)), j0 = Math.max(0, Math.floor((z0 - pad + this.half) / c));
    const i1 = Math.min(n - 1, Math.floor((x1 + pad + this.half) / c)), j1 = Math.min(n - 1, Math.floor((z1 + pad + this.half) / c)), W = i1 - i0 + 1, H = j1 - j0 + 1;
    const d = new Float32Array(W * H), INF = 1e6, b = Math.SQRT2;
    const run = (out, blocked, unit, cap) => {   // unit: stored value per cell step
      for (let jj = 0; jj < H; jj++) for (let ii = 0; ii < W; ii++) { const k = (j0 + jj) * n + i0 + ii, e = ii === 0 || jj === 0 || ii === W - 1 || jj === H - 1; d[jj * W + ii] = blocked(k) ? 0 : e ? out[k] / unit : INF; }
      for (let jj = 1; jj < H - 1; jj++) for (let ii = 1; ii < W - 1; ii++) { const k = jj * W + ii; let v = d[k]; if (!v) continue; v = Math.min(v, d[k - 1] + 1, d[k - W] + 1, d[k - W - 1] + b, d[k - W + 1] + b); d[k] = v; }
      for (let jj = H - 2; jj > 0; jj--) for (let ii = W - 2; ii > 0; ii--) { const k = jj * W + ii; let v = d[k]; if (!v) continue; v = Math.min(v, d[k + 1] + 1, d[k + W] + 1, d[k + W + 1] + b, d[k + W - 1] + b); d[k] = v; }
      for (let jj = 1; jj < H - 1; jj++) for (let ii = 1; ii < W - 1; ii++) { const k = (j0 + jj) * n + i0 + ii, v = d[jj * W + ii] * unit; out[k] = cap ? Math.min(cap, Math.round(v)) : v; }
    };
    run(this.clear, k => this.cost[k] === BLOCK, c, 0);
    if (this.veh && this.clearV) { run(this.clearV, k => this.cost[k] === BLOCK || this.veh[k] >= 1, c * 10, 255); run(this.clearT, k => this.cost[k] === BLOCK || this.veh[k] >= 2, c * 10, 255); }
    const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    for (let j = Math.max(1, j0); j <= Math.min(n - 2, j1); j++) for (let i = Math.max(1, i0); i <= Math.min(n - 2, i1); i++) {
      const k = j * n + i; if (this.cost[k] === BLOCK) { this.cover[k] = 0; continue; } let m = 0;
      for (let q = 0; q < 8; q++) if (this.cost[(j + dirs[q][1]) * n + i + dirs[q][0]] >= 6) m |= 1 << q;
      this.cover[k] = m;
    }
  }
  // can a vehicle stand / drive here? tracked = tanks (cross trenches), else wheeled (BTR)
  vehPassable(x, z, tracked = false) { const i = this.idx(x, z); if (i < 0 || this.cost[i] === BLOCK) return false; if (!this.veh) return true; return this.veh[i] < (tracked ? 2 : 1); }
  trenchDepth(x, z) { const i = this.idx(x, z); return i < 0 || !this.trench ? 0 : this.trench[i] / 10; }
  markRoad(x0, z0, x1, z1, v) {
    for (let z = z0; z <= z1; z += this.cell) for (let x = x0; x <= x1; x += this.cell) { const i = this.idx(x, z); if (i >= 0) this.road[i] = Math.max(this.road[i], v); }
  }
  roadAt(x, z) { const i = this.idx(x, z); return i < 0 ? 0 : this.road[i]; }
  circle(cx, cz, r, val, lowCover = false) {
    for (let z = cz - r; z <= cz + r; z += this.cell) for (let x = cx - r; x <= cx + r; x += this.cell) {
      if ((x - cx) ** 2 + (z - cz) ** 2 > r * r) continue;
      const i = this.idx(x, z); if (i < 0) continue;
      this.cost[i] = Math.max(this.cost[i], val); if (lowCover) this.low[i] = 1;
    }
  }
  addOccluder(cx, cz, hx, hz, rot, h, ref) {
    const o = { cx, cz, hx, hz, cos: Math.cos(rot), sin: Math.sin(rot), h, ref, r: Math.hypot(hx, hz) };
    this.occluders.push(o);
    const C = this.occCell;
    for (let x = Math.floor((cx - o.r) / C); x <= Math.floor((cx + o.r) / C); x++)
      for (let z = Math.floor((cz - o.r) / C); z <= Math.floor((cz + o.r) / C); z++) {
        const k = x * 4096 + z; let l = this.occGrid.get(k); if (!l) this.occGrid.set(k, l = []); l.push(o);
      }
    return o;
  }
  // Recompute clearance (two-pass chamfer distance transform) and cover bitmasks.
  finalize() {
    const n = this.n, N = n * n, d = this.clear, INF = 1e6;
    for (let i = 0; i < N; i++) d[i] = this.cost[i] === BLOCK ? 0 : INF;
    const a = 1, b = Math.SQRT2;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = j * n + i; let v = d[k]; if (!v) continue;
      if (i > 0) v = Math.min(v, d[k - 1] + a); if (j > 0) { v = Math.min(v, d[k - n] + a); if (i > 0) v = Math.min(v, d[k - n - 1] + b); if (i < n - 1) v = Math.min(v, d[k - n + 1] + b); } d[k] = v; }
    for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) { const k = j * n + i; let v = d[k]; if (!v) continue;
      if (i < n - 1) v = Math.min(v, d[k + 1] + a); if (j < n - 1) { v = Math.min(v, d[k + n] + a); if (i < n - 1) v = Math.min(v, d[k + n + 1] + b); if (i > 0) v = Math.min(v, d[k + n - 1] + b); } d[k] = v; }
    for (let i = 0; i < N; i++) d[i] *= this.cell;
    if (this.veh && (this.vehDirty || !this.clearV)) { this.clearV = this.chamfer(i => this.cost[i] === BLOCK || this.veh[i] >= 1); this.clearT = this.chamfer(i => this.cost[i] === BLOCK || this.veh[i] >= 2); this.vehDirty = false; }
    const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
      const k = j * n + i; if (this.cost[k] === BLOCK) continue; let m = 0;
      for (let q = 0; q < 8; q++) { const kk = (j + dirs[q][1]) * n + i + dirs[q][0]; if (this.cost[kk] >= 6) m |= 1 << q; }
      this.cover[k] = m;
    }
  }
  // distance (dm, capped at 255) to the nearest cell matching blocked(i)
  chamfer(blocked) {
    const n = this.n, N = n * n, d = new Float32Array(N), INF = 1e6, b = Math.SQRT2;
    for (let i = 0; i < N; i++) d[i] = blocked(i) ? 0 : INF;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = j * n + i; let v = d[k]; if (!v) continue;
      if (i > 0) v = Math.min(v, d[k - 1] + 1); if (j > 0) { v = Math.min(v, d[k - n] + 1); if (i > 0) v = Math.min(v, d[k - n - 1] + b); if (i < n - 1) v = Math.min(v, d[k - n + 1] + b); } d[k] = v; }
    for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) { const k = j * n + i; let v = d[k]; if (!v) continue;
      if (i < n - 1) v = Math.min(v, d[k + 1] + 1); if (j < n - 1) { v = Math.min(v, d[k + n] + 1); if (i < n - 1) v = Math.min(v, d[k + n + 1] + b); if (i > 0) v = Math.min(v, d[k + n - 1] + b); } d[k] = v; }
    const out = new Uint8Array(N); for (let i = 0; i < N; i++) out[i] = Math.min(255, Math.round(d[i] * this.cell * 10)); return out;
  }
  // Cover value (0..1) at position against a threat direction (from pos towards threat).
  // In a trench / ditch the soldier is below the lip: full cover from anything not right on top of him.
  coverFrom(x, z, tx, tz) {
    const k = this.idx(x, z); if (k < 0) return 0;
    if (this.trench && this.trench[k] >= 9 && (tx - x) ** 2 + (tz - z) ** 2 > 16) return 1;
    const m = this.cover[k]; if (!m) return 0;
    const ang = Math.atan2(tz - z, tx - x); const q = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
    if (m & (1 << q)) return 1; if (m & (1 << ((q + 1) % 8)) || m & (1 << ((q + 7) % 8))) return 0.55; return 0;
  }
  passable(i, clearance) { return i >= 0 && this.cost[i] !== BLOCK && this.clear[i] >= clearance; }
  // vehicle passability: also keeps the hull clear of trenches (wheeled) / ditches, teeth, forest (tracked)
  passableV(i, clearance, tracked) { if (!this.passable(i, clearance)) return false; const cv = tracked ? this.clearT : this.clearV; return !cv || cv[i] >= clearance * 10 * 0.8; }
  nearestFree(x, z, clearance = 0.5, maxR = 30) {
    let i = this.idx(x, z); if (this.passable(i, clearance)) return [x, z];
    for (let r = 1; r <= maxR; r++) for (let a = 0; a < 16 + r * 4; a++) {
      const t = a / (16 + r * 4) * Math.PI * 2, px = x + Math.cos(t) * r * this.cell, pz = z + Math.sin(t) * r * this.cell;
      i = this.idx(px, pz); if (this.passable(i, clearance)) return [this.cx(i), this.cz(i)];
    }
    return [x, z];
  }
  // A* with octile heuristic. clearance in metres (infantry 0.45, BTR 1.9, tank 2.1). Returns [[x,z],...]
  // vehicle: false (infantry) | true | 'wheeled' | 'tracked'. true = tracked when clearance >= 1.95 (tanks ask for 2.0+),
  // else wheeled. Wheeled vehicles never enter trench cells; tracked ones cross trenches at a high cost.
  // opts (infantry only): { threat: [x, z] } -- a known enemy: cells it can see into (no wall / rubble / wreck / trench
  // between, see exposed()) cost INF_COST.threat more per metre, so a squad under threat takes the covered way when it
  // is not much longer.
  findPath(sx, sz, tx, tz, clearance = 0.45, vehicle = false, maxIter = this.maxIter || 120000, opts = null) {
    if (vehicle) return this.findPathV(sx, sz, tx, tz, clearance, vehicle === 'tracked' || (vehicle === true && clearance >= 1.95));
    return this.findPathInf(sx, sz, tx, tz, clearance, maxIter, opts);
  }
  // ---------------------------------------------------------------- infantry routing (v6)
  // per-metre cost of an infantry cell: terrain cost, keeping a little off walls (clear < 0.9) and a mild preference for
  // the band along walls / fences (moving along facades rather than across open ground), plus the threat term
  infCost(k) {
    const cl = this.clear[k];
    let c = this.cost[k] + (cl < 0.9 ? INF_COST.scrape : cl < 2.6 ? INF_COST.wallBand : 0);
    if (this._thr) c += this.exposed(k) * INF_COST.threat;
    return c;
  }
  // can the threat (this._thr = [x, z]) see into cell k? Marches from the cell towards the threat (1 m steps to 8 m, then
  // 2 m to 32 m): a wall / building / wreck / rubble heap / sandbags (cost >= 6) on the way, or a trench floor, hides it.
  // Cached per query (stamped with the A* generation).
  exposed(k) {
    const N = this.n * this.n;
    if (!this._exS || this._exS.length !== N) { this._exS = new Uint32Array(N); this._exV = new Uint8Array(N); }
    if (this._exS[k] === this._thrGen) return this._exV[k];
    this._exS[k] = this._thrGen;
    const [qx, qz] = this._thr, x = this.cx(k), z = this.cz(k), dx = qx - x, dz = qz - z, d = Math.hypot(dx, dz);
    let v = 1;
    if (d > 520 || (this.trench && this.trench[k] >= 9)) v = 0;
    else { const ux = dx / d, uz = dz / d; for (let r = 1; r < Math.min(d - 2, 32); r += r < 8 ? 1 : 2) { const i = this.idx(x + ux * r, z + uz * r); if (i >= 0 && this.cost[i] >= 6) { v = 0; break; } } }
    return (this._exV[k] = v);
  }
  findPathInf(sx, sz, tx, tz, clearance, maxIter, opts) {
    [sx, sz] = this.nearestFree(sx, sz, clearance, 6); [tx, tz] = this.nearestFree(tx, tz, clearance, 40);
    const s = this.idx(sx, sz), t = this.idx(tx, tz); if (s < 0 || t < 0) return null;
    if (s === t) return [[tx, tz]];
    const n = this.n, gen = ++this.gen, g = this.g, from = this.from, st = this.stamp, cl = this.closed;
    this._thr = opts?.threat || null; this._thrGen = gen;
    try {
      const ti = t % n, tj = (t / n) | 0, HW = this._thr ? INF_COST.heurThr : INF_COST.heur;
      const h = k => { const dx = Math.abs(k % n - ti), dz = Math.abs(((k / n) | 0) - tj); return (dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz)) * HW; };
      const heap = new Heap(); g[s] = 0; st[s] = gen; from[s] = -1; heap.push(h(s), s);
      const D = [1, -1, n, -n, n + 1, n - 1, -n + 1, -n - 1], DX = [1, -1, 0, 0, 1, -1, 1, -1], DZ = [0, 0, 1, -1, 1, 1, -1, -1], C = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
      let it = 0, best = s, bestH = h(s);
      while (heap.size && it++ < maxIter) {
        const k = heap.pop(); if (cl[k] === gen) continue; cl[k] = gen;
        if (k === t) { best = k; break; }
        const hk = h(k); if (hk < bestH) { bestH = hk; best = k; }
        const ki = k % n;
        for (let q = 0; q < 8; q++) {
          const kk = k + D[q]; if (kk < 0 || kk >= n * n) continue;
          const kki = kk % n; if (Math.abs(kki - ki) > 1) continue;
          if (!this.passable(kk, clearance)) continue;
          if (q >= 4 && (!this.passable(k + DX[q], clearance) || !this.passable(k + DZ[q] * n, clearance))) continue;
          const ng = g[k] + C[q] * this.infCost(kk);
          if (st[kk] !== gen || ng < g[kk]) { st[kk] = gen; g[kk] = ng; from[kk] = k; heap.push(ng + h(kk), kk); }
        }
      }
      this.lastIter = it;
      const raw = []; for (let k = best; k !== -1; k = from[k]) raw.push(k); raw.reverse();
      return this.smoothInf(raw, clearance, best === t ? [tx, tz] : null);
    } finally { this._thr = null; }
  }
  // cost of walking the straight segment a->b (0.5 m samples of infCost)
  segCostInf(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(d / 0.5)), stp = d / m; let c = 0;
    for (let i = 0; i < m; i++) { const f = (i + 0.5) / m, k = this.idx(ax + (bx - ax) * f, az + (bz - az) * f); c += k < 0 ? 99 : this.infCost(k) * stp; }
    return c;
  }
  // string-pulling with a cost check (as smoothV): a shortcut is taken when the line is clear AND no dearer than the stretch
  // of lattice route it replaces -- straight legs lose the 45-degree zig-zags of the 8-neighbour grid, while a route that
  // follows a wall / a covered way keeps doing so (the old version capped shortcuts near walls at 6 cells instead: a
  // saw-tooth of short legs along every facade)
  smoothInf(raw, clearance, end) {
    const p = raw.map(k => [this.cx(k), this.cz(k)]);
    if (p.length < 3) { if (end) p[p.length - 1] = end; return p; }
    const cum = [0]; for (let i = 1; i < raw.length; i++) cum[i] = cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]) * this.infCost(raw[i]);
    const out = [p[0]]; let a = 0; const LOOK = 90;
    while (a < p.length - 1) {
      let b = Math.min(p.length - 1, a + LOOK);
      for (; b > a + 1; b--) {
        if (!this.lineFree(p[a][0], p[a][1], p[b][0], p[b][1], clearance)) continue;
        if (this.segCostInf(p[a][0], p[a][1], p[b][0], p[b][1]) <= (cum[b] - cum[a]) * 1.03 + 0.3) break;
      }
      out.push(p[b]); a = b;
    }
    if (end) out[out.length - 1] = end;
    return out;
  }
  nearestFreeV(x, z, clearance, tracked, maxR = 30) {
    let i = this.idx(x, z); if (this.passableV(i, clearance, tracked)) return [x, z];
    for (let r = 1; r <= maxR; r++) for (let a = 0; a < 16 + r * 4; a++) {
      const t = a / (16 + r * 4) * Math.PI * 2, px = x + Math.cos(t) * r * this.cell, pz = z + Math.sin(t) * r * this.cell;
      i = this.idx(px, pz); if (this.passableV(i, clearance, tracked)) return [this.cx(i), this.cz(i)];
    }
    return [x, z];
  }
  // ---------------------------------------------------------------- vehicle routing
  // Road-aware: per-metre cost of a cell for a vehicle (see VEH_COST). Road cells close to the road edge cost a bit
  // more, so routes run down the middle of the carriageway rather than shaving the kerb / the fences at every bend.
  roadDist() {   // dm from each road cell to the nearest non-road cell (0 off-road); roads are static after the build
    if (!this._roadD) this._roadD = this.chamfer(i => !this.road[i]);
    return this._roadD;
  }
  vCost(k, clearance, tracked) {
    let c = this.cost[k]; if (c > 1) c *= 2.5;   // rubble, craters, crushable junk: slow for armour
    if (this.veh && this.veh[k] === 1) c += 12;  // a tank crossing a trench: only when it saves a long detour
    if (this.clear[k] < clearance + 1.2) c += 0.6;   // keep the hull off walls
    const r = this.road[k];
    if (r) { const e = this._roadD[k] * 0.1, R = VEH_COST[tracked ? 'tracked' : 'wheeled'][r === 2 ? 'paved' : 'dirt'], lw = r === 2 ? VEH_COST.laneW : VEH_COST.trackW; c *= R * (e < lw ? 1 + VEH_COST.edge * (1 - e / lw) : 1); }
    return c;
  }
  // cost of driving the straight segment a->b (sampled every 0.5 m, same measure as a raw lattice path)
  segCost(ax, az, bx, bz, clearance, tracked) {
    const d = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(d / 0.5)), st = d / n; let c = 0;
    for (let i = 0; i < n; i++) { const f = (i + 0.5) / n, k = this.idx(ax + (bx - ax) * f, az + (bz - az) * f); c += k < 0 ? 99 : this.vCost(k, clearance, tracked) * st; }
    return c;
  }
  // A* for vehicles on a 2 m lattice (every other cell: a hull needs ~2 m clearance anyway, so nothing a vehicle could
  // use is lost, and a cross-map query stays at a few ms), heuristic weighted to the cheapest road so the search
  // finds a road that is reasonably close and not only the straight line. Then string-pulled on the 1 m grid with a
  // cost check: a shortcut is only taken when it is no dearer than the stretch of route it replaces, so straight runs
  // lose their zig-zags while the route keeps to the road instead of cutting across the fields beside it.
  findPathV(sx, sz, tx, tz, clearance, tracked) {
    const vrest = !!this.clearV, pass = vrest ? i => i >= 0 && this.passableV(i, clearance, tracked) : i => this.passable(i, clearance);
    [sx, sz] = vrest ? this.nearestFreeV(sx, sz, clearance, tracked, 8) : this.nearestFree(sx, sz, clearance, 8);
    [tx, tz] = vrest ? this.nearestFreeV(tx, tz, clearance, tracked, 40) : this.nearestFree(tx, tz, clearance, 40);
    const s0 = this.idx(sx, sz), t0 = this.idx(tx, tz); if (s0 < 0 || t0 < 0) return null;
    this.roadDist(); this._pv = vrest ? tracked : null;
    try {
      const dd = Math.hypot(tx - sx, tz - sz);
      if (s0 === t0 || (dd < 14 && this.lineFree(sx, sz, tx, tz, clearance))) return [[sx, sz], [tx, tz]];
      // long trips on a 4 m lattice (4x fewer nodes), short ones and any the coarse lattice can't solve on 2 m
      const n = this.n, plan = this.vLattice ? [this.vLattice] : dd > VEH_COST.longM ? [4, 2] : [2], last = plan[plan.length - 1];
      this.lastPassV = [];
      for (const S of plan) {
        const snap = k => { const i = k % n, j = (k / n) | 0, i0 = i - i % S, j0 = j - j % S; let best = -1, bd = 1e9;
          for (let r = 0; r <= Math.ceil(8 / S) && best < 0; r++) for (let dj = -r; dj <= r + 1; dj++) for (let di = -r; di <= r + 1; di++) {
            const ii = i0 + di * S, jj = j0 + dj * S; if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue; const kk = jj * n + ii;
            if (!pass(kk)) continue; const d = (ii - i) ** 2 + (jj - j) ** 2; if (d < bd) { bd = d; best = kk; } }
          return best; };
        const s = snap(s0), t = snap(t0); if (s < 0 || t < 0) { if (S !== last) continue; return null; }
        const gen = ++this.gen, g = this.g, from = this.from, st = this.stamp, cl = this.closed, N = n * n;
        // per-query cache of the cell cost (-1 = the hull can't stand there), each cell is looked at ~10 times
        if (!this._vc || this._vc.length !== N) { this._vc = new Float32Array(N); this._vs = new Uint32Array(N); }
        const vc = this._vc, vs = this._vs, cost = this.cost, clr = this.clear, road = this.road, rdD = this._roadD, veh = this.veh;
        const cv = vrest ? (tracked ? this.clearT : this.clearV) : null, cvMin = clearance * 10 * 0.8, wallC = clearance + 1.2;
        const VC = VEH_COST[tracked ? 'tracked' : 'wheeled'], RP = VC.paved, RT = VC.dirt, LW = VEH_COST.laneW, TW = VEH_COST.trackW, ED = VEH_COST.edge;
        const cc = k => {
          if (vs[k] === gen) return vc[k];
          vs[k] = gen; let c = cost[k];
          if (c === BLOCK || clr[k] < clearance || (cv && cv[k] < cvMin)) return (vc[k] = -1);
          if (c > 1) c *= 2.5; if (veh && veh[k] === 1) c += 12; if (clr[k] < wallC) c += 0.6;
          const r = road[k]; if (r) { const e = rdD[k] * 0.1, lw = r === 2 ? LW : TW; c *= (r === 2 ? RP : RT) * (e < lw ? 1 + ED * (1 - e / lw) : 1); }
          return (vc[k] = c);
        };
        const ti = t % n, tj = (t / n) | 0, W = VEH_COST.heur[tracked ? 'tracked' : 'wheeled'], R2 = Math.SQRT2 - 2;
        const DI = [1, -1, 0, 0, 1, -1, 1, -1], DJ = [0, 0, 1, -1, 1, 1, -1, -1], C = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
        const heap = new Heap(); g[s] = 0; st[s] = gen; from[s] = -1;
        const h0 = (() => { const dx = Math.abs(s % n - ti), dz = Math.abs(((s / n) | 0) - tj); return (dx + dz + R2 * Math.min(dx, dz)) * W; })();
        heap.push(h0, s);
        let it = 0, best = s, bestH = h0, imp = 0; const maxIter = S > 2 ? 140000 : this.maxIterV || 260000, stall = S > 2 ? 16000 : 1e9;
        while (heap.size && it++ < maxIter) {
          const k = heap.pop(); if (cl[k] === gen) continue; cl[k] = gen;
          if (k === t) { best = k; break; }
          const ki = k % n, kj = (k / n) | 0;
          { const dx = Math.abs(ki - ti), dz = Math.abs(kj - tj), hk = (dx + dz + R2 * Math.min(dx, dz)) * W; if (hk < bestH) { bestH = hk; best = k; imp = it; } else if (it - imp > stall) break; }
          const gk = g[k];
          for (let q = 0; q < 8; q++) {
            const ii = ki + DI[q] * S, jj = kj + DJ[q] * S; if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
            const kk = jj * n + ii; if (cl[kk] === gen) continue;
            // the hull drives through every cell of the step: all must take it, the step costs their sum
            const dk = DJ[q] * n + DI[q]; let sc = 0, m = 1;
            for (; m <= S; m++) { const c = cc(k + dk * m); if (c < 0) break; sc += c; } if (m <= S) continue;
            if (q >= 4 && (cc(k + DI[q]) < 0 || cc(k + DJ[q] * n) < 0)) continue;
            const ng = gk + C[q] * sc;
            if (st[kk] !== gen || ng < g[kk]) { st[kk] = gen; g[kk] = ng; from[kk] = k; const dx = Math.abs(ii - ti), dz = Math.abs(jj - tj); heap.push(ng + (dx + dz + R2 * Math.min(dx, dz)) * W, kk); }
          }
        }
        this.lastIterV = it; (this.lastPassV ||= []).push([S, it, best === t]);
        const raw = []; for (let k = best; k !== -1; k = from[k]) raw.push(k); raw.reverse();
        const pts = raw.map(k => [this.cx(k), this.cz(k)]);
        if (s !== s0) pts.unshift([sx, sz]);
        const reached = best === t; if (reached) pts.push([tx, tz]);
        if (!reached && S !== last) continue;   // the coarse lattice found no way through (a narrow gap?): search finer
        return this.smoothV(pts, clearance, tracked);
      }
      return null;
    } finally { this._pv = null; }
  }
  smoothV(p, clearance, tracked) {
    if (p.length < 3) return p;
    const cum = [0]; for (let i = 1; i < p.length; i++) cum[i] = cum[i - 1] + this.segCost(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1], clearance, tracked);
    const out = [p[0]]; let a = 0; const LOOK = 48;
    while (a < p.length - 1) {
      let b = Math.min(p.length - 1, a + LOOK);
      for (; b > a + 1; b--) {
        if (!this.lineFree(p[a][0], p[a][1], p[b][0], p[b][1], clearance)) continue;
        if (this.segCost(p[a][0], p[a][1], p[b][0], p[b][1], clearance, tracked) <= (cum[b] - cum[a]) * 1.02 + 0.2) break;
      }
      out.push(p[b]); a = b;
    }
    return this.centreOnRoad(out, clearance);
  }
  // pull route corners that lie on a road towards the middle of the carriageway (up to laneW from the edge), so the
  // straight legs between them run down the road instead of along its kerb; a move is kept only if both legs stay clear
  centreOnRoad(p, clearance) {
    const rd = this._roadD, DX = [1, -1, 0, 0, 1, 1, -1, -1], DZ = [0, 0, 1, -1, 1, -1, 1, -1];
    for (let i = 1; i < p.length - 1; i++) {
      let [x, z] = p[i], k = this.idx(x, z); if (k < 0 || !this.road[k]) continue; const W = (this.road[k] === 2 ? VEH_COST.laneW : VEH_COST.trackW) * 10;
      for (let step = 0; step < 8 && rd[k] < W; step++) {
        let bk = -1, bv = rd[k];
        for (let q = 0; q < 8; q++) { const kk = this.idx(x + DX[q], z + DZ[q]); if (kk >= 0 && rd[kk] > bv && this.cost[kk] !== BLOCK) { bv = rd[kk]; bk = kk; } }
        if (bk < 0) break;
        const nx = this.cx(bk), nz = this.cz(bk);
        if (!this.lineFree(p[i - 1][0], p[i - 1][1], nx, nz, clearance) || !this.lineFree(nx, nz, p[i + 1][0], p[i + 1][1], clearance)) break;
        x = nx; z = nz; k = bk;
      }
      p[i] = [x, z];
    }
    return p;
  }
  lineFree(ax, az, bx, bz, clearance) {
    const d = Math.hypot(bx - ax, bz - az), steps = Math.ceil(d / (this.cell * 0.5)), pv = this._pv;
    for (let i = 1; i < steps; i++) { const f = i / steps, k = this.idx(ax + (bx - ax) * f, az + (bz - az) * f); if (pv === null || pv === undefined ? !this.passable(k, clearance) : !this.passableV(k, clearance, pv)) return false; if (pv === false && this.veh[k] === 1) return false; }
    return true;
  }
  smooth(p, clearance, end, hug = false) {
    if (p.length < 3) { if (end) p[p.length - 1] = end; return p; }
    const out = [p[0]]; let a = 0;
    const nearWall = q => { const i = this.idx(q[0], q[1]); return i >= 0 && this.clear[i] < 2.8; };
    while (a < p.length - 1) {
      let b = p.length - 1;
      // infantry along a wall: only short shortcuts, so the route keeps following the wall
      if (hug && nearWall(p[a])) b = Math.min(b, a + 6);
      while (b > a + 1 && !this.lineFree(p[a][0], p[a][1], p[b][0], p[b][1], clearance)) b--;
      out.push(p[b]); a = b;
    }
    if (end) out[out.length - 1] = end;
    return out;
  }
  // Does the segment a->b (3D) pass through any building volume? Returns the occluder or null.
  // Foliage (tree belts, forest): you can see into / out of the edge but not through; the see-through depth is per
  // occluder (o.depth, default 9 m with an end inside, 4.5 m crossing) and accumulates over consecutive belts / cells.
  // Ground relief (trench lips, parapets, rubble mounds) also blocks when this.terrainLOS (returns TERRAIN_OCC).
  occluded(ax, ay, az, bx, by, bz, ignore, ignore2, noFoliage = false) {
    const C = this.occCell, seen = new Set(); let leaf = 0;
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / C) + 1;
    for (let s = 0; s <= steps; s++) {
      const f = s / steps, x = ax + (bx - ax) * f, z = az + (bz - az) * f;
      const l = this.occGrid.get(Math.floor(x / C) * 4096 + Math.floor(z / C)); if (!l) continue;
      for (const o of l) {
        if (seen.has(o) || o.dead || (o.smokeUntil && o.smokeUntil < (globalThis.__gameTime || 0)) || (ignore && (o === ignore || o.ref === ignore)) || (ignore2 && (o === ignore2 || o.ref === ignore2))) continue; seen.add(o);
        const t = segRect(ax, az, bx, bz, o); if (t === null) continue;
        const y = ay + (by - ay) * t; if (y >= o.h || (o.y0 && y < o.y0 && ay + (by - ay) * segT1 < o.y0)) continue;   // over it, or under a tree crown
        if (o.foliage) {
          if (noFoliage === true || (noFoliage === 'veg' && o.veg)) continue;   // 'veg': single bushes / crowns don't stop a round, belts do
          // tree-line belts: you can see and shoot out of (or into the edge of) a belt, not through it
          const L = Math.hypot(bx - ax, bz - az), inside = (segT1 - t) * L;
          const endIn = t <= 0.0001 || segT1 >= 0.9999;
          leaf += inside;
          if (leaf < (o.depth ? o.depth * (endIn ? 1 : 0.6) : endIn ? 9 : 4.5)) continue;
        }
        return o;
      }
    }
    if (this.terrain && this.terrainLOS && this.terrain.segmentBlocked(ax, ay, az, bx, by, bz)) return TERRAIN_OCC;
    return null;
  }
}

// segment vs oriented rect; returns first param t (0..1) or null
function segRect(ax, az, bx, bz, o) {
  const tx = (x, z) => { const dx = x - o.cx, dz = z - o.cz; return [dx * o.cos - dz * o.sin, dx * o.sin + dz * o.cos]; };
  const [px, pz] = tx(ax, az), [qx, qz] = tx(bx, bz); const dx = qx - px, dz = qz - pz;
  let t0 = 0, t1 = 1;
  for (const [p, d, h] of [[px, dx, o.hx], [pz, dz, o.hz]]) {
    if (Math.abs(d) < 1e-9) { if (p < -h || p > h) return null; continue; }
    let a = (-h - p) / d, b = (h - p) / d; if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) return null;
  }
  segT1 = t1;
  return t0;
}
let segT1 = 1;
