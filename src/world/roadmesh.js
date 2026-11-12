// Seamless road surfaces (roads v2): every carriageway at one level, merged into one surface without overlapping
// triangles, filleted where roads meet; pavements as their own surface around it (minus the carriageway), kerbs along
// the carriageway outline only.
//
// How: each road is a set of primitives (a flat-ended box per polyline segment, a disc at every bend / shared node).
// Signed distance per road group (ways that simply continue each other: hard min), groups combined with a round union
// (fillet radius by class: the smaller of the two meeting roads, groups folded in descending radius order).  The plane is
// cut into 8 m cells; in each cell the field is sampled every 0.5 m, the zero contour traced (marching squares, cell
// border as part of the outline), simplified (Douglas-Peucker; cell corners / border crossings kept so neighbouring
// cells share their border vertices exactly) and triangulated (earcut, THREE.ShapeUtils).  One mesh per 128 m chunk.
// Fully deterministic (no RNG), UVs world-space (texture continuous across joins), per-vertex aRoad frame for the wear
// shader (across = distance from the outline mapped onto the nearest road's half width).
import * as THREE from 'three';

export const ROAD_Y = 0.06;
// Dirt / gravel road ribbons are blended strips; where two met (a junction, a track crossing a lane) or one folded over itself in
// a bend, the ground was painted twice: a darker patch with both sets of ruts and both soft edges showing ("roads overlap
// instead of fading into each other"). Every ribbon material carries this: a pixel one ribbon has drawn is marked in the stencil
// and the next ribbon leaves it alone (the scene target has a stencil buffer: engine/renderer.js).
export const ONCE = { alphaTest: 0.03, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ReplaceStencilOp };

const CELL = 8, H = 0.5, N = CELL / H, CHUNK = 128;
const cache = new Map();

function roundUnion(a, b, r) {
  if (a > r && b > r) return a < b ? a : b;
  const ux = r - a > 0 ? r - a : 0, uy = r - b > 0 ? r - b : 0, m = a < b ? a : b;
  return (m > r ? m : r) - Math.sqrt(ux * ux + uy * uy);
}

// roads: [{ pts, hw, sw (pavement width, 0 none), rad (fillet radius), kerb, ext (end extension), rough (private-sector
// lane: aRoad.z += 2, the wear shader crumbles its edge into the shoulder) }]
// opts: { y, tile, walkTile, key (cache key) }
// returns { asphalt: [BufferGeometry], walk: [BufferGeometry], kerbs: [[x, z, yaw]], ms, tris }
// cuts: [{ pts, hw }] corridors kept free of PAVEMENT (railway / tram beds beside a road, streets v2: OSM puts the
// tram reservation right beside the carriageway -- a symmetric pavement would swallow it); the carriageway is not cut
export function roadSurfaces(roads, { y = ROAD_Y, tile = 7, walkTile = 4, key = null, cuts = [] } = {}) {
  const t0 = performance.now();
  // cache keyed by the input itself (a rebuilt match on the same map reuses the surfaces)
  let hk = 2166136261; const mix = v => { hk = Math.imul(hk ^ (Math.round(v * 1000) | 0), 16777619); };
  for (const r of roads) { mix(r.hw); mix(r.sw); mix(r.rad); mix(r.kerb ? 1 : 0); mix(r.ext || 0); mix(r.rough ? 1 : 0); for (const p of r.pts) { mix(p[0]); mix(p[1]); } for (const q of r.pads || []) { mix(q.ax); mix(q.az); mix(q.hw); mix(q.L); } }
  for (const c of cuts) { mix(c.hw); for (const p of c.pts) { mix(p[0]); mix(p[1]); } }
  mix(y); mix(tile); mix(walkTile); key = (key || '') + ':' + (hk >>> 0) + ':' + roads.length;
  if (cache.has(key)) return finish(cache.get(key), t0, true);
  // ---- groups: ways whose ends meet at a node of exactly two ends, nearly straight on (< 35 deg)
  const R = roads.filter(r => r.pts.length > 1), par = R.map((_, i) => i), find = i => par[i] === i ? i : (par[i] = find(par[i]));
  const nodes = new Map(), nk = p => Math.round(p[0] * 2) + ',' + Math.round(p[1] * 2);
  R.forEach((r, i) => r.pts.forEach((p, k) => { const e = k === 0 ? 0 : k === r.pts.length - 1 ? 1 : -1, K = nk(p); (nodes.get(K) || nodes.set(K, []).get(K)).push([i, e]); }));
  const dirAt = (r, e) => { const P = r.pts, a = e ? P[P.length - 1] : P[0], b = e ? P[P.length - 2] : P[1], L = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1; return [(a[0] - b[0]) / L, (a[1] - b[1]) / L]; };
  const shared = R.map(() => [false, false]);
  for (const L of nodes.values()) {
    if (L.length < 2) continue;
    for (const [i, e] of L) if (e >= 0) shared[i][e] = true;
    if (L.length === 2 && L[0][1] >= 0 && L[1][1] >= 0 && L[0][0] !== L[1][0]) {
      const [i, ei] = L[0], [j, ej] = L[1], a = dirAt(R[i], ei), b = dirAt(R[j], ej);
      if (-(a[0] * b[0] + a[1] * b[1]) > 0.82) par[find(i)] = find(j);
    }
  }
  const gRad = new Map(); R.forEach((r, i) => { const g = find(i); gRad.set(g, Math.min(gRad.get(g) ?? 1e9, r.rad)); });
  const gOrder = [...gRad.keys()].sort((a, b) => gRad.get(b) - gRad.get(a) || a - b), gRank = new Map(gOrder.map((g, k) => [g, k]));
  const gSw = new Map(); R.forEach((r, i) => { const g = find(i); gSw.set(g, Math.max(gSw.get(g) || 0, r.sw)); });
  // ---- primitives
  const prims = []; let rMax = 0, anyWalk = false;
  R.forEach((r, i) => {
    const P = r.pts.filter((p, k, A) => !k || Math.hypot(p[0] - A[k - 1][0], p[1] - A[k - 1][1]) > 1e-3); if (P.length < 2) return;
    const g = gRank.get(find(i)), sw = r.sw > 0.05 ? r.sw : 0; rMax = Math.max(rMax, r.rad); if (sw) anyWalk = true;
    for (let k = 0; k < P.length - 1; k++) {
      let [ax, az] = P[k]; const [bx, bz] = P[k + 1], L0 = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L0, uz = (bz - az) / L0;
      const e0 = k === 0 && !shared[i][0] ? r.ext || 0 : 0, e1 = k === P.length - 2 && !shared[i][1] ? r.ext || 0 : 0;
      ax -= ux * e0; az -= uz * e0;
      prims.push({ box: true, ax, az, ux, uz, L: L0 + e0 + e1, hw: r.hw, sw, g, kerb: !!r.kerb, rough: !!r.rough });
    }
    P.forEach((p, k) => { if ((k > 0 && k < P.length - 1) || shared[i][k ? 1 : 0]) prims.push({ box: false, ax: p[0], az: p[1], hw: r.hw, sw, g, kerb: !!r.kerb }); });
    // streets v5: dead-end turning pads (a rounded rectangle along the road at its end, same group: one surface)
    for (const q of r.pads || []) { const cr = Math.min(q.cr || 0, q.hw - 0.5, q.L / 2 - 0.5); prims.push({ box: true, ax: q.ax + q.ux * cr, az: q.az + q.uz * cr, ux: q.ux, uz: q.uz, L: q.L - 2 * cr, hw: q.hw - cr, cr, sw, g, kerb: !!r.kerb, rough: !!r.rough }); }
  });
  const gr = gOrder.map(g => gRad.get(g)), grW = gOrder.map(g => Math.max(0.3, gRad.get(g) - gSw.get(g)));
  // ---- cell grid of candidate primitives
  const cells = new Map(), M = rMax + 2;
  for (const p of prims) {
    const ext = p.hw + p.sw + M, bx = p.box ? p.ax + p.ux * p.L : p.ax, bz = p.box ? p.az + p.uz * p.L : p.az;
    for (let ci = Math.floor((Math.min(p.ax, bx) - ext) / CELL); ci <= Math.floor((Math.max(p.ax, bx) + ext) / CELL); ci++)
      for (let cj = Math.floor((Math.min(p.az, bz) - ext) / CELL); cj <= Math.floor((Math.max(p.az, bz) + ext) / CELL); cj++) {
        const k = (ci + 32768) * 65536 + cj + 32768; (cells.get(k) || cells.set(k, []).get(k)).push(p);
      }
  }
  // ---- pavement cuts (capsule chains), own cell grid
  const cutCells = new Map();
  for (const c of cuts) for (let k = 0; k < c.pts.length - 1; k++) {
    const [ax, az] = c.pts[k], [bx, bz] = c.pts[k + 1], e = c.hw + 1, sg = { ax, az, bx, bz, hw: c.hw };
    for (let ci = Math.floor((Math.min(ax, bx) - e) / CELL); ci <= Math.floor((Math.max(ax, bx) + e) / CELL); ci++)
      for (let cj = Math.floor((Math.min(az, bz) - e) / CELL); cj <= Math.floor((Math.max(az, bz) + e) / CELL); cj++) { const kk = (ci + 32768) * 65536 + cj + 32768; (cutCells.get(kk) || cutCells.set(kk, []).get(kk)).push(sg); }
  }
  let CC = null;
  // ---- field evaluation
  const ng = gOrder.length, dA = new Float64Array(ng), dW = new Float64Array(ng), used = [];
  let C = null;   // current candidate list (sorted by group rank)
  const F = { a: 0, w: 0, wr: 0 };
  function field(x, z) {
    for (const g of used) { dA[g] = 1e9; dW[g] = 1e9; }
    for (const p of C) {
      let da, dw;
      if (p.box) {
        const dx = x - p.ax, dz = z - p.az, t = dx * p.ux + dz * p.uz, s = Math.abs(p.ux * dz - p.uz * dx), qx = Math.abs(t - p.L / 2) - p.L / 2;
        const ox = qx > 0 ? qx * qx : 0; let qy = s - p.hw, m = qx > qy ? qx : qy;
        da = Math.sqrt(ox + (qy > 0 ? qy * qy : 0)) + (m < 0 ? m : 0);
        if (p.sw) { qy -= p.sw; m = qx > qy ? qx : qy; dw = Math.sqrt(ox + (qy > 0 ? qy * qy : 0)) + (m < 0 ? m : 0); } else dw = 1e9;
        if (p.cr) { da -= p.cr; if (p.sw) dw -= p.cr; }
      } else { const dx = x - p.ax, dz = z - p.az, d = Math.sqrt(dx * dx + dz * dz); da = d - p.hw; dw = p.sw ? d - p.hw - p.sw : 1e9; }
      if (da < dA[p.g]) dA[p.g] = da; if (dw < dW[p.g]) dW[p.g] = dw;
    }
    let a = 1e9, w = 1e9, first = true;
    for (const g of used) { if (first) { a = dA[g]; w = dW[g]; first = false; } else { a = roundUnion(a, dA[g], gr[g]); w = w > 1e8 ? dW[g] : dW[g] > 1e8 ? w : roundUnion(w, dW[g], grW[g]); } }
    if (CC) { let cin = -1e9;
      for (const c of CC) { const dx = c.bx - c.ax, dz = c.bz - c.az, L2 = dx * dx + dz * dz || 1e-9; let t = ((x - c.ax) * dx + (z - c.az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t; const d = c.hw - Math.hypot(c.ax + dx * t - x, c.az + dz * t - z); if (d > w) w = d; if (d > cin) cin = d; }
      // in the bed: no corner fillet either (the apron would swallow a track running past the junction corner) --
      // the carriageways themselves still cross it at the mapped level crossings
      if (cin > 0) { let a0 = 1e9; for (const g of used) if (dA[g] < a0) a0 = dA[g]; if (a0 > a) a = a0; } }
    F.a = a; F.wr = w; F.w = w > -a ? w : -a;
  }
  function nearest(x, z) {
    let best = null, bd = 1e9, sg = 1;
    for (const p of C) if (p.box) {
      const dx = x - p.ax, dz = z - p.az, t = dx * p.ux + dz * p.uz, s = p.ux * dz - p.uz * dx, qx = Math.abs(t - p.L / 2) - p.L / 2, qy = Math.abs(s) - p.hw;
      const d = Math.sqrt((qx > 0 ? qx * qx : 0) + (qy > 0 ? qy * qy : 0)) + Math.min(Math.max(qx, qy), 0);
      if (d < bd) { bd = d; best = p; sg = s < 0 ? -1 : 1; }
    }
    return [best, sg];
  }
  // ---- per chunk output buffers
  const out = { asphalt: new Map(), walk: new Map(), kerbs: [] };
  const buf = (which, x, z) => { const k = Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK), m = out[which]; return m.get(k) || m.set(k, { pos: [], uv: [], ex: [], idx: [] }).get(k); };
  const VA = new Float64Array((N + 1) * (N + 1)), VW = new Float64Array((N + 1) * (N + 1)), S = (N + 1) * (N + 1);
  const keys = [...cells.keys()].sort((a, b) => a - b), hd = CELL * 0.7072;
  for (const k of keys) {
    const ci = Math.floor(k / 65536) - 32768, cj = k % 65536 - 32768, x0 = ci * CELL, z0 = cj * CELL;
    C = cells.get(k).slice().sort((a, b) => a.g - b.g); CC = cutCells.get(k) || null; used.length = 0; for (const p of C) if (used[used.length - 1] !== p.g) used.push(p.g);
    field(x0 + CELL / 2, z0 + CELL / 2);
    const aFar = Math.abs(F.a) > hd * 2.2, wFar = !anyWalk || F.wr > hd * 2.2 || F.a < -hd * 2.2;
    if (aFar && F.a > 0 && wFar) continue;
    if (aFar && F.a < 0) { emit('asphalt', [[[x0, z0, 1], [x0 + CELL, z0, 1], [x0 + CELL, z0 + CELL, 1], [x0, z0 + CELL, 1]]], x0, z0); continue; }
    // 2 m blocks first: a block whose corners agree in sign, one of them clear of the outline by more than the block
    // diagonal (x1.3: the round union is not quite 1-Lipschitz), gets its 0.5 m samples interpolated (sign only matters)
    const W1 = N + 1, BS = 4;
    for (let j = 0; j <= N; j += BS) for (let i = 0; i <= N; i += BS) { field(x0 + i * H, z0 + j * H); VA[j * W1 + i] = F.a; VW[j * W1 + i] = F.w; }
    for (let bj = 0; bj < N; bj += BS) for (let bi = 0; bi < N; bi += BS) {
      const c = [bj * W1 + bi, bj * W1 + bi + BS, (bj + BS) * W1 + bi, (bj + BS) * W1 + bi + BS], th = 1.3 * BS * H * 1.4143;
      const okA = sameSign(VA, c, th), okW = sameSign(VW, c, th);
      for (let j = bj; j <= bj + BS; j++) for (let i = bi; i <= bi + BS; i++) {
        if ((i - bi) % BS === 0 && (j - bj) % BS === 0) continue;
        const k = j * W1 + i;
        if (okA && okW) { const u = (i - bi) / BS, v = (j - bj) / BS; VA[k] = lerp2(VA, c, u, v); VW[k] = lerp2(VW, c, u, v); continue; }
        field(x0 + i * H, z0 + j * H); VA[k] = F.a; VW[k] = F.w;
      }
    }
    emit('asphalt', contour(VA, x0, z0), x0, z0, true);
    if (anyWalk) emit('walk', contour(VW, x0, z0), x0, z0);
  }
  function emit(which, loops, x0, z0, kerbs = false) {
    if (!loops.length) return;
    const outer = [], holes = [];
    for (const L of loops) { let A = 0; for (let i = 0, j = L.length - 1; i < L.length; j = i++) A += L[j][0] * L[i][1] - L[i][0] * L[j][1]; if (Math.abs(A) < 0.02) continue; (A > 0 ? outer : holes).push(L); }
    const B = buf(which, x0 + CELL / 2, z0 + CELL / 2), T = which === 'walk' ? walkTile : tile;
    for (const O of outer) {
      const hs = holes.filter(Hh => inPoly(Hh[0][0], Hh[0][1], O));
      const all = [O, ...hs], verts = all.flat();
      const faces = THREE.ShapeUtils.triangulateShape(O.map(p => new THREE.Vector2(p[0], p[1])), hs.map(Hh => Hh.map(p => new THREE.Vector2(p[0], p[1]))));
      const base = B.pos.length / 3;
      for (const [x, z] of verts) {
        field(x, z); const [p, sg] = nearest(x, z);
        const hw = p ? (which === 'walk' ? p.hw + p.sw : p.hw) : 3, edge = Math.max(0, -(which === 'walk' ? F.wr : F.a));
        B.pos.push(x, y, z); B.uv.push(x / T, z / T); B.ex.push(sg * Math.max(0, hw - edge), hw, (p && Math.abs(p.ux) > Math.abs(p.uz) ? 1 : 0) + (p?.rough ? 2 : 0));
      }
      for (const [a, b, c] of faces) {
        const A = verts[a], Bv = verts[b], Cv = verts[c], cr = (Bv[0] - A[0]) * (Cv[1] - A[1]) - (Bv[1] - A[1]) * (Cv[0] - A[0]);
        if (cr > 0) B.idx.push(base + a, base + c, base + b); else B.idx.push(base + a, base + b, base + c);   // front face up (+y)
      }
      // kerbs along the carriageway outline (not along the cell border), where a pavement lies outside it
      if (kerbs && anyWalk) for (const L of all) for (let i = 0; i < L.length; i++) {
        const a = L[i], b = L[(i + 1) % L.length];
        if ((a[0] === b[0] && (a[0] === x0 || a[0] === x0 + CELL)) || (a[1] === b[1] && (a[1] === z0 || a[1] === z0 + CELL))) continue;
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz); if (len < 0.3) continue;
        const ux = dx / len, uz = dz / len, n = Math.max(1, Math.round(len));
        for (let s = 0; s < n; s++) {
          const t = (s + 0.5) * len / n, x = a[0] + ux * t, z = a[1] + uz * t;
          field(x + uz * 0.8, z - ux * 0.8); if (F.w > -0.2) continue;   // (outward = right of the CCW outline)
          const [p] = nearest(x, z); if (!p?.kerb) continue;
          out.kerbs.push([x, z, Math.atan2(-uz, ux), len / n]);
        }
      }
    }
  }
  const res = { asphalt: [...out.asphalt.values()], walk: [...out.walk.values()], kerbs: out.kerbs };
  cache.set(key, res);
  return finish(res, t0, false);
}

function finish(res, t0, cached) {
  const geo = b => { if (!b.idx.length) return null; const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2)); const nr = new Float32Array(b.pos.length); for (let i = 1; i < nr.length; i += 3) nr[i] = 1; g.setAttribute('normal', new THREE.BufferAttribute(nr, 3)); g.setAttribute('aRoad', new THREE.Float32BufferAttribute(b.ex, 3)); g.setIndex(b.idx); g.computeBoundingSphere(); return g; };
  const asphalt = res.asphalt.map(geo).filter(Boolean), walk = res.walk.map(geo).filter(Boolean);
  const tris = [...res.asphalt, ...res.walk].reduce((n, b) => n + b.idx.length / 3, 0);
  return { asphalt, walk, kerbs: res.kerbs, ms: Math.round(performance.now() - t0), tris, cached };
}

function sameSign(V, c, th) { const s = V[c[0]] < 0; let m = 0; for (const k of c) { if ((V[k] < 0) !== s) return false; const a = Math.abs(V[k]); if (a > m) m = a; } return m > th; }
function lerp2(V, c, u, v) { return (V[c[0]] * (1 - u) + V[c[1]] * u) * (1 - v) + (V[c[2]] * (1 - u) + V[c[3]] * u) * v; }
function inPoly(x, z, P) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; }

// marching squares over one cell (inside: V < 0), the cell border closing the outline; loops CCW (inside on the left),
// holes CW.  Point flags (3rd element): 1 = cell corner / crossing on the cell border (kept: shared with the neighbour)
function contour(V, x0, z0) {
  const W = N + 1, S = W * W;
  let any = false, all = true; for (let i = 0; i < S; i++) { if (V[i] < 0) any = true; else all = false; }
  if (!any) return [];
  if (all) return [[[x0, z0, 1], [x0 + CELL, z0, 1], [x0 + CELL, z0 + CELL, 1], [x0, z0 + CELL, 1]]];
  const ins = (i, j) => V[j * W + i] < 0;
  const next = new Map();
  const hK = (i, j) => S + j * W + i, vK = (i, j) => 2 * S + j * W + i;
  const seg = (a, b) => { if (a !== b) next.set(a, b); };
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k0 = j * W + i, m = (V[k0] < 0 ? 1 : 0) + (V[k0 + 1] < 0 ? 2 : 0) + (V[k0 + W + 1] < 0 ? 4 : 0) + (V[k0 + W] < 0 ? 8 : 0);
    if (m === 0 || m === 15) continue;
    const c = [ins(i, j), ins(i + 1, j), ins(i + 1, j + 1), ins(i, j + 1)];
    const ek = [hK(i, j), vK(i + 1, j), hK(i, j + 1), vK(i, j)], X = [];
    for (let e = 0; e < 4; e++) { const a = c[e], b = c[(e + 1) & 3]; if (a !== b) X.push([ek[e], a ? 'L' : 'E']); }
    if (X.length === 2) { const L = X.find(q => q[1] === 'L'), E = X.find(q => q[1] === 'E'); seg(L[0], E[0]); }
    else {   // saddle
      const ctr = (V[j * W + i] + V[j * W + i + 1] + V[(j + 1) * W + i + 1] + V[(j + 1) * W + i]) < 0;
      for (let q = 0; q < 4; q++) if (X[q][1] === 'L') seg(X[q][0], X[(q + (ctr ? 1 : 3)) % 4][0]);
    }
  }
  // the cell border, CCW: bottom (j = 0), right (i = N), top (j = N), left (i = 0)
  // (one segment per inside run: corner / border crossing to the next; the samples between are collinear)
  const side = (i0, j0, di, dj) => {
    let run = ins(i0, j0) ? j0 * W + i0 : -1;
    for (let s = 0; s < N; s++) {
      const ia = i0 + di * s, ja = j0 + dj * s, ib = ia + di, jb = ja + dj, a = ins(ia, ja), b = ins(ib, jb);
      if (a === b) continue;
      const xk = dj === 0 ? hK(Math.min(ia, ib), ja) : vK(ia, Math.min(ja, jb));
      if (a) { seg(run, xk); run = -1; } else run = xk;
    }
    if (run >= 0) seg(run, (j0 + dj * N) * W + i0 + di * N);
  };
  side(0, 0, 1, 0); side(N, 0, 0, 1); side(N, N, -1, 0); side(0, N, 0, -1);
  const pt = k => {
    if (k < S) { const i = k % W, j = (k - i) / W, corner = (i === 0 || i === N) && (j === 0 || j === N); return [x0 + i * H, z0 + j * H, corner ? 1 : 2]; }
    const hz = k < 2 * S, kk = hz ? k - S : k - 2 * S, i = kk % W, j = (kk - i) / W;
    const va = V[j * W + i], vb = hz ? V[j * W + i + 1] : V[(j + 1) * W + i], t = va / (va - vb);
    const onB = hz ? (j === 0 || j === N) : (i === 0 || i === N);
    return hz ? [x0 + (i + t) * H, z0 + j * H, onB ? 1 : 0] : [x0 + i * H, z0 + (j + t) * H, onB ? 1 : 0];
  };
  const loops = [], seen = new Set();
  for (const s of next.keys()) {
    if (seen.has(s)) continue;
    const L = []; let k = s, guard = 0;
    while (!seen.has(k) && guard++ < 100000) { seen.add(k); L.push(pt(k)); k = next.get(k); if (k === undefined) break; }
    if (L.length > 2) loops.push(simplify(L));
  }
  return loops.filter(L => L.length > 2);
}
// Douglas-Peucker between kept points (flag 1); border sample points (flag 2) are collinear and dropped
function simplify(L) {
  const n = L.length, keep = new Uint8Array(n); let anchors = [];
  for (let i = 0; i < n; i++) if (L[i][2] === 1) { keep[i] = 1; anchors.push(i); }
  if (anchors.length < 2) { let far = 0, fd = -1; for (let i = 1; i < n; i++) { const d = (L[i][0] - L[0][0]) ** 2 + (L[i][1] - L[0][1]) ** 2; if (d > fd) { fd = d; far = i; } } keep[0] = keep[far] = 1; anchors = [0, far].sort((a, b) => a - b); if (anchors[0] === anchors[1]) return []; }
  const tol = 0.03;
  const dp = (a, b) => {   // indices modulo n, a -> b forward
    const span = (b - a + n) % n; if (span < 2) return;
    const [ax, az] = L[a], [bx, bz] = L[b], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    let md = -1, mi = -1;
    for (let s = 1; s < span; s++) { const i = (a + s) % n; if (L[i][2] === 2) continue; const px = L[i][0] - ax, pz = L[i][1] - az; let d; if (l2 < 1e-12) d = Math.hypot(px, pz); else { const t = Math.max(0, Math.min(1, (px * dx + pz * dz) / l2)); d = Math.hypot(px - dx * t, pz - dz * t); } if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; dp(a, mi); dp(mi, b); }
  };
  for (let k = 0; k < anchors.length; k++) dp(anchors[k], anchors[(k + 1) % anchors.length]);
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) { const p = L[i]; const q = out[out.length - 1]; if (!q || Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) > 1e-6) out.push(p); }
  if (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) + Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
  return out;
}

// ---------------------------------------------------------------- paved field (streets v2)
// Signed distance (m, + outside) to the FINAL merged surfaces, rasterised from the roadSurfaces output at `res` m:
// `asphalt` (carriageway incl. the fillet aprons) and `paved` (carriageway + pavements).  Used for clearance tests
// (street furniture, bus stops), crater relief clamping, and (as a texture) to clip the dirt / gravel track strips
// against the paved union in the track shader.  Int8 in 0.1 m steps (clamped +-12.7 m).
export function pavedField(S, size, res = 0.5) {
  const N = Math.ceil(size / res), o = size / 2, A = new Uint8Array(N * N), P = new Uint8Array(N * N), P1 = new Uint8Array(N * N), P2 = new Uint8Array(N * N);
  const rast = (geos, M1, M2, split) => {
    for (const g of geos) {
      const p = g.attributes.position.array, ix = g.index.array, ex = g.attributes.aRoad?.array;
      for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3, ax = p[a], az = p[a + 2], bx = p[b], bz = p[b + 2], cx = p[c], cz = p[c + 2];
        const d = (bx - ax) * (cz - az) - (bz - az) * (cx - ax); if (Math.abs(d) < 1e-9) continue;
        const M3 = split ? (ex && ex[ix[t] * 3 + 2] >= 1.5 ? P2 : P1) : P1;   // (rough private lanes apart: their shoulder strip stays under the crumbling edge)
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) + o) / res)), i1 = Math.min(N - 1, Math.floor((Math.max(ax, bx, cx) + o) / res));
        const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) + o) / res)), j1 = Math.min(N - 1, Math.floor((Math.max(az, bz, cz) + o) / res));
        for (let j = j0; j <= j1; j++) { const z = (j + 0.5) * res - o; for (let i = i0; i <= i1; i++) {
          const x = (i + 0.5) * res - o, u = ((bx - x) * (cz - z) - (bz - z) * (cx - x)) / d, v = ((cx - x) * (az - z) - (cz - z) * (ax - x)) / d;
          if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) { const k = j * N + i; M1[k] = 1; if (M2) M2[k] = 1; M3[k] = 1; }
        } }
      }
    }
  };
  rast(S.asphalt, A, P, true); rast(S.walk, P, null, false);
  const sdf = M => {   // two-pass chamfer (1, sqrt2) for both signs -> Int8 decimetres
    const big = 1e6, dO = new Float32Array(N * N), dI = new Float32Array(N * N), D2 = Math.SQRT2;
    for (let k = 0; k < N * N; k++) { dO[k] = M[k] ? 0 : big; dI[k] = M[k] ? big : 0; }
    for (const d of [dO, dI]) {   // (plain comparisons: Math.min in this loop costs ~3x)
      let a, v;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const k = j * N + i; v = d[k]; if (v === 0) continue;
        if (i > 0) { a = d[k - 1] + 1; if (a < v) v = a; }
        if (j > 0) { a = d[k - N] + 1; if (a < v) v = a; if (i > 0) { a = d[k - N - 1] + D2; if (a < v) v = a; } if (i < N - 1) { a = d[k - N + 1] + D2; if (a < v) v = a; } }
        d[k] = v; }
      for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) { const k = j * N + i; v = d[k]; if (v === 0) continue;
        if (i < N - 1) { a = d[k + 1] + 1; if (a < v) v = a; }
        if (j < N - 1) { a = d[k + N] + 1; if (a < v) v = a; if (i < N - 1) { a = d[k + N + 1] + D2; if (a < v) v = a; } if (i > 0) { a = d[k + N - 1] + D2; if (a < v) v = a; } }
        d[k] = v; }
    }
    const out = new Int8Array(N * N);
    for (let k = 0; k < N * N; k++) { const m = M[k] ? -(dI[k] - 0.5) * res : (dO[k] - 0.5) * res; out[k] = Math.max(-127, Math.min(127, Math.round(m * 10))); }
    return out;
  };
  const FA = sdf(A), FP = sdf(P); let F1 = null, F2 = null;
  const at = F => (x, z) => {
    const fx = (x + o) / res - 0.5, fz = (z + o) / res - 0.5; if (fx < 0 || fz < 0 || fx >= N - 1 || fz >= N - 1) return 12.7;
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * N + i;
    return ((F[k] * (1 - u) + F[k + 1] * u) * (1 - v) + (F[k + N] * (1 - u) + F[k + N + 1] * u) * v) / 10;
  };
  let tex = null;
  const texture = () => {   // R8: paved signed distance clamped to +-4 m (track-strip clipping in the shader)
    if (tex) return tex;
    F1 ||= sdf(P1); F2 ||= sdf(P2);   // union with the rough lanes shrunk by 0.7 m
    const d = new Uint8Array(N * N); for (let k = 0; k < N * N; k++) { const v = Math.min(F1[k], F2[k] + 7); d[k] = Math.max(0, Math.min(255, Math.round((Math.max(-40, Math.min(40, v)) + 40) / 80 * 255))); }
    tex = new THREE.DataTexture(d, N, N, THREE.RedFormat, THREE.UnsignedByteType); tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    return tex;
  };
  return { asphalt: at(FA), paved: at(FP), texture, size, N, res };
}
