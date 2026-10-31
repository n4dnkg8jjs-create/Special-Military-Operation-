// Navigation grid (1 m cells): A* pathfinding for infantry and vehicles, clearance map,
// directional cover map, and segment occlusion against building footprints.
export const BLOCK = 255;

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
    const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
      const k = j * n + i; if (this.cost[k] === BLOCK) continue; let m = 0;
      for (let q = 0; q < 8; q++) { const kk = (j + dirs[q][1]) * n + i + dirs[q][0]; if (this.cost[kk] >= 6) m |= 1 << q; }
      this.cover[k] = m;
    }
  }
  // Cover value (0..1) at position against a threat direction (from pos towards threat).
  coverFrom(x, z, tx, tz) {
    const k = this.idx(x, z); if (k < 0) return 0; const m = this.cover[k]; if (!m) return 0;
    const ang = Math.atan2(tz - z, tx - x); const q = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
    if (m & (1 << q)) return 1; if (m & (1 << ((q + 1) % 8)) || m & (1 << ((q + 7) % 8))) return 0.55; return 0;
  }
  passable(i, clearance) { return i >= 0 && this.cost[i] !== BLOCK && this.clear[i] >= clearance; }
  nearestFree(x, z, clearance = 0.5, maxR = 30) {
    let i = this.idx(x, z); if (this.passable(i, clearance)) return [x, z];
    for (let r = 1; r <= maxR; r++) for (let a = 0; a < 16 + r * 4; a++) {
      const t = a / (16 + r * 4) * Math.PI * 2, px = x + Math.cos(t) * r * this.cell, pz = z + Math.sin(t) * r * this.cell;
      i = this.idx(px, pz); if (this.passable(i, clearance)) return [this.cx(i), this.cz(i)];
    }
    return [x, z];
  }
  // A* with octile heuristic. clearance in metres (infantry 0.45, BTR 1.9, tank 2.1). Returns [[x,z],...]
  findPath(sx, sz, tx, tz, clearance = 0.45, vehicle = false, maxIter = this.maxIter || 120000) {
    [sx, sz] = this.nearestFree(sx, sz, clearance, 6);
    [tx, tz] = this.nearestFree(tx, tz, clearance, 40);
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
        if (!this.passable(kk, clearance)) continue;
        if (q >= 4 && (!this.passable(k + DX[q], clearance) || !this.passable(k + DZ[q] * n, clearance))) continue;
        let c = this.cost[kk]; if (vehicle && c > 1) c = c * 2.5; // rubble slows armour more
        // stay off walls: prefer cells with more clearance
        // vehicles keep off walls; infantry hug them (move along facades and fences, not across open ground)
        const cl = this.clear[kk];
        const wall = vehicle ? (cl < clearance + 1.2 ? 0.6 : 0) : (cl < 0.9 ? 0.35 : cl < 2.6 ? -0.32 : 0);
        const ng = g[k] + C[q] * (c + wall);
        if (st[kk] !== gen || ng < g[kk]) { st[kk] = gen; g[kk] = ng; from[kk] = k; heap.push(ng + h(kk) * 1.02, kk); }
      }
    }
    const raw = []; for (let k = best; k !== -1; k = from[k]) raw.push(k); raw.reverse();
    return this.smooth(raw.map(k => [this.cx(k), this.cz(k)]), clearance, best === t ? [tx, tz] : null, !vehicle);
  }
  lineFree(ax, az, bx, bz, clearance) {
    const d = Math.hypot(bx - ax, bz - az), steps = Math.ceil(d / (this.cell * 0.5));
    for (let i = 1; i < steps; i++) { const f = i / steps; if (!this.passable(this.idx(ax + (bx - ax) * f, az + (bz - az) * f), clearance)) return false; }
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
  occluded(ax, ay, az, bx, by, bz, ignore, ignore2) {
    const C = this.occCell, seen = new Set();
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / C) + 1;
    for (let s = 0; s <= steps; s++) {
      const f = s / steps, x = ax + (bx - ax) * f, z = az + (bz - az) * f;
      const l = this.occGrid.get(Math.floor(x / C) * 4096 + Math.floor(z / C)); if (!l) continue;
      for (const o of l) {
        if (seen.has(o) || o.dead || (o.smokeUntil && o.smokeUntil < (globalThis.__gameTime || 0)) || (ignore && (o === ignore || o.ref === ignore)) || (ignore2 && (o === ignore2 || o.ref === ignore2))) continue; seen.add(o);
        const t = segRect(ax, az, bx, bz, o); if (t === null) continue;
        const y = ay + (by - ay) * t; if (y >= o.h) continue;
        if (o.foliage) {
          // tree-line belts: you can see and shoot out of (or into the edge of) a belt, not through it
          const L = Math.hypot(bx - ax, bz - az), inside = (segT1 - t) * L;
          const endIn = t <= 0.0001 || segT1 >= 0.9999;
          if (inside < (endIn ? 9 : 4.5)) continue;
        }
        return o;
      }
    }
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
