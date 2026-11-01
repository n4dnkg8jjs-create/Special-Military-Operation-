// Navigation grid (1 m cells): A* pathfinding for infantry and vehicles, clearance map,
// directional cover map, and segment occlusion against building footprints.
export const BLOCK = 255;
export const TOOTH_R = 1.25;   // vehicle-blocking radius around a dragon's tooth (m)
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
  findPath(sx, sz, tx, tz, clearance = 0.45, vehicle = false, maxIter = this.maxIter || 120000) {
    const tracked = vehicle === 'tracked' || (vehicle === true && clearance >= 1.95), vrest = !!vehicle && !!this.clearV;
    if (vrest) { [sx, sz] = this.nearestFreeV(sx, sz, clearance, tracked, 8); [tx, tz] = this.nearestFreeV(tx, tz, clearance, tracked, 40); }
    else { [sx, sz] = this.nearestFree(sx, sz, clearance, 6); [tx, tz] = this.nearestFree(tx, tz, clearance, 40); }
    const s = this.idx(sx, sz), t = this.idx(tx, tz); if (s < 0 || t < 0) return null;
    if (s === t) return [[tx, tz]];
    const n = this.n, gen = ++this.gen, g = this.g, from = this.from, st = this.stamp, cl = this.closed;
    const ti = t % n, tj = (t / n) | 0;
    const h = k => { const dx = Math.abs(k % n - ti), dz = Math.abs(((k / n) | 0) - tj); return (dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz)); };
    const heap = new Heap(); g[s] = 0; st[s] = gen; from[s] = -1; heap.push(h(s), s);
    const D = [1, -1, n, -n, n + 1, n - 1, -n + 1, -n - 1], DX = [1, -1, 0, 0, 1, -1, 1, -1], DZ = [0, 0, 1, -1, 1, 1, -1, -1], C =[1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
    let it = 0, best = s, bestH = h(s);
    while (heap.size && it++ < maxIter) {
      const k = heap.pop(); if (cl[k] === gen) continue; cl[k] = gen;
      if (k === t) { best = k; break; }
      const hk = h(k); if (hk < bestH) { bestH = hk; best = k; }
      const ki = k % n;
      for (let q = 0; q < 8; q++) {
        const kk = k + D[q]; if (kk < 0 || kk >= n * n) continue;
        const kki = kk % n; if (Math.abs(kki - ki) > 1) continue;
        if (vrest ? !this.passableV(kk, clearance, tracked) : !this.passable(kk, clearance)) continue;
        if (q >= 4 && (vrest ? (!this.passableV(k + DX[q], clearance, tracked) || !this.passableV(k + DZ[q] * n, clearance, tracked)) : (!this.passable(k + DX[q], clearance) || !this.passable(k + DZ[q] * n, clearance)))) continue;
        let c = this.cost[kk]; if (vehicle && c > 1) c = c * 2.5; // rubble slows armour more
        if (vrest && this.veh[kk] === 1) c += 12; // a tank crossing a trench: only when it saves a long detour
        if (vehicle) c *= this.road[kk] === 2 ? 0.8 : this.road[kk] === 1 ? 0.9 : 1.15; // prefer roads when they're roughly on the way
        // stay off walls: prefer cells with more clearance
        // vehicles keep off walls; infantry hug them (move along facades and fences, not across open ground)
        const cl = this.clear[kk];
        const wall = vehicle ? (cl < clearance + 1.2 ? 0.6 : 0) : (cl < 0.9 ? 0.35 : cl < 2.6 ? -0.32 : 0);
        const ng = g[k] + C[q] * (c + wall);
        if (st[kk] !== gen || ng < g[kk]) { st[kk] = gen; g[kk] = ng; from[kk] = k; heap.push(ng + h(kk) * 1.02, kk); }
      }
    }
    const raw = []; for (let k = best; k !== -1; k = from[k]) raw.push(k); raw.reverse();
    this._pv = vrest ? tracked : null;
    const out = this.smooth(raw.map(k => [this.cx(k), this.cz(k)]), clearance, best === t ? [tx, tz] : null, !vehicle);
    this._pv = null; return out;
  }
  nearestFreeV(x, z, clearance, tracked, maxR = 30) {
    let i = this.idx(x, z); if (this.passableV(i, clearance, tracked)) return [x, z];
    for (let r = 1; r <= maxR; r++) for (let a = 0; a < 16 + r * 4; a++) {
      const t = a / (16 + r * 4) * Math.PI * 2, px = x + Math.cos(t) * r * this.cell, pz = z + Math.sin(t) * r * this.cell;
      i = this.idx(px, pz); if (this.passableV(i, clearance, tracked)) return [this.cx(i), this.cz(i)];
    }
    return [x, z];
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
          if (noFoliage) continue;
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
