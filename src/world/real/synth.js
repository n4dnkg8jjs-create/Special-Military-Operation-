// Generated battle maps for the campaign squares that have no real-place map of their own (campaign/v2/battlemap.js picks):
//   rural      open steppe as it is between the villages of both sectors: big fields, windbreak belts along their edges, a
//              paved road and field tracks, a wood, a field camp (grain yard) - platoon strongpoints dug into the belts
//   river      a small steppe river (Vovcha / Kinska / Tokmak size: 15-25 m of water in a flood meadow) with a village street
//              along the north bank; it is crossed where roads run over it on earth dams (culverted causeways, the usual
//              crossing of these rivers) - nowhere else for vehicles, men wade
//   greyzone   ground between two lines that have not moved since 2022 (Avdiivka's southern approaches - Opytne, Vodiane,
//              Pisky -, the Robotyne front before June 2023): untilled weed-grown fields torn by shelling, the belts reduced
//              to splintered trunks and stumps, a hamlet of wall stubs, trench lines and their forward outposts on both sides
// They are not places: the layouts are laid out here from a few numbers (a slightly turned, jittered field grid; roads and
// belts along its lines) in the SAME data format as the OpenStreetMap conversions (real/<id>_osm.js), so world/real.js
// builds them with everything the real maps have (merged road surfaces, plots and houses, belts, ruins, craters, trenches).
// Pure data + arithmetic (no three.js): maps.js takes the map definitions from here, real.js the layouts.
const rng = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const r1 = v => Math.round(v * 10) / 10, P1 = p => [r1(p[0]), r1(p[1])];
const SIZE = 1400, HALF = SIZE / 2, EDGE = HALF + 24;
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k];
const unit = v => { const L = Math.hypot(v[0], v[1]) || 1; return [v[0] / L, v[1] / L]; };
const area = P => { let s = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const inBox = (p, m = 0) => Math.abs(p[0]) <= EDGE - m && Math.abs(p[1]) <= EDGE - m;
// polygon / polyline against the map square
function clipPoly(P) {
  for (const [ax, k] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
    const out = [], ins = p => p[ax] * k <= EDGE;
    for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length], ia = ins(a), ib = ins(b); if (ia) out.push(a); if (ia !== ib) out.push(lerp(a, b, (EDGE * k - a[ax]) / (b[ax] - a[ax]))); }
    P = out; if (P.length < 3) return [];
  }
  return P;
}
function clipLine(P) {
  const runs = []; let run = [];
  for (let i = 0; i < P.length - 1; i++) {
    let a = P[i], b = P[i + 1], t0 = 0, t1 = 1, ok = true;
    for (const ax of [0, 1]) for (const k of [1, -1]) { const da = EDGE - a[ax] * k, db = EDGE - b[ax] * k; if (da < 0 && db < 0) ok = false; else if (da < 0) t0 = Math.max(t0, da / (da - db)); else if (db < 0) t1 = Math.min(t1, da / (da - db)); }
    if (!ok || t0 >= t1) { if (run.length > 1) runs.push(run); run = []; continue; }
    const p = lerp(a, b, t0), q = lerp(a, b, t1);
    if (!run.length) run.push(p); run.push(q);
    if (t1 < 1) { runs.push(run); run = []; }
  }
  if (run.length > 1) runs.push(run);
  return runs;
}
// a polyline moved sideways by d (to the left of its direction for d > 0)
function offset(P, d) {
  return P.map((p, i) => { const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)], u = unit(sub(b, a)); return [p[0] - u[1] * d, p[1] + u[0] * d]; });
}
// convex polygon pulled in by a distance per edge
function inset(P, D) {
  const n = P.length, sg = area(P) > 0 ? 1 : -1, L = P.map((p, i) => { const q = P[(i + 1) % n], u = unit(sub(q, p)), nr = [-u[1] * sg, u[0] * sg]; return { p: add(p, nr, D[i]), u }; });
  const out = [];
  for (let i = 0; i < n; i++) { const A = L[(i + n - 1) % n], B = L[i], den = A.u[0] * B.u[1] - A.u[1] * B.u[0]; if (Math.abs(den) < 1e-6) { out.push(B.p); continue; } const w = sub(B.p, A.p), t = (w[0] * B.u[1] - w[1] * B.u[0]) / den; out.push(add(A.p, A.u, t)); }
  return area(out) * sg > 400 ? out : [];
}
// what runs along a grid line: [road type, width, OSM class, belt offsets beside it, how far the fields keep back]
const ROLE = {
  paved: { road: ['paved', 7.2, 'secondary'], belts: [11, -11], back: 19 }, gravel: { road: ['gravel', 5.5, 'unclassified'], belts: [9], back: 16 },
  street: { road: ['gravel', 5.5, 'residential'], belts: [], back: 62 }, track: { road: ['track', 3.4, 'track'], belts: [7], back: 14 },
  lane: { road: ['track', 3.4, 'track'], belts: [], back: 8 }, belt: { belts: [0], back: 9 }, none: { belts: [], back: 1.5 },
};

// ---------------------------------------------------------------- the layout from a spec
function build(S) {
  const R = rng(S.seed), th = (S.rot || 0) * Math.PI / 180, c = Math.cos(th), s = Math.sin(th), nx = S.xs.length, nz = S.zs.length, RV = S.river;
  const jit = S.xs.map(() => S.zs.map(() => [(R() - 0.5) * 2 * S.jit, (R() - 0.5) * 2 * S.jit]));
  if (RV) for (let i = 0; i < nx; i++) jit[i][RV.row + 1] = jit[i][RV.row];             /* (the two banks move together: the meadow keeps its width) */
  const N = S.xs.map((x, i) => S.zs.map((z, j) => { const gx = x + jit[i][j][0], gz = z + jit[i][j][1]; return [gx * c - gz * s, gx * s + gz * c]; }));
  const D = { name: S.id, size: SIZE, synthetic: true, roads: [], paths: [], buildings: [], areas: [], lines: [], pois: [], plots: [] };
  const role = (line, seg) => { const k = S.seg?.[`${line}:${seg}`]; if (k) return k; const kind = line[0], i = +line.slice(1); if (RV && kind === 'c' && seg === RV.row) return RV.cross[i] || 'none'; return (kind === 'c' ? S.cols : S.rows)[i] || 'none'; };
  const linePts = line => { const i = +line.slice(1); return line[0] === 'c' ? N[i] : N.map(col => col[i]); };
  // roads and belts: runs of segments of one kind along each line
  const lines = [...S.xs.map((_, i) => 'c' + i), ...S.zs.map((_, j) => 'r' + j)];
  for (const line of lines) {
    const P = linePts(line), flip = S.flip?.includes(line) ? -1 : 1; let from = 0;
    for (let k = 1; k <= P.length - 1; k++) {
      if (k < P.length - 1 && role(line, k) === role(line, from)) continue;
      const ro = ROLE[role(line, from)], pts = P.slice(from, k + 1); from = k;
      if (ro.road) for (const run of clipLine(pts)) D.roads.push({ pts: run.map(P1), w: ro.road[1], type: ro.road[0], cls: ro.road[2], name: '' });
      for (const o of ro.belts) for (const run of clipLine(offset(pts, o * flip))) if (run.length > 1) D.lines.push({ t: 'tree_row', pts: run.map(P1) });
    }
  }
  // the squares between the lines: fields, the flood meadow, woods
  const cells = [];
  for (let i = 0; i < nx - 1; i++) for (let j = 0; j < nz - 1; j++) {
    const type = S.cells?.[`${i},${j}`] || (RV && j === RV.row ? 'meadow' : 'field');
    const Q = [N[i][j], N[i + 1][j], N[i + 1][j + 1], N[i][j + 1]], roles = [role('r' + j, i), role('c' + (i + 1), j), role('r' + (j + 1), i), role('c' + i, j)];
    let poly = inset(Q, roles.map(r => type === 'meadow' ? Math.min(ROLE[r].back, 9) : ROLE[r].back)); if (!poly.length) continue;
    const yard = (S.yards || []).find(y => y.cell[0] === i && y.cell[1] === j);
    if (yard) {   /* a yard takes one corner of the field: the field keeps the L around it */
      const k = yard.corner, p0 = poly[k], u1 = unit(sub(poly[(k + 1) % 4], p0)), u3 = unit(sub(poly[(k + 3) % 4], p0)), a = add(p0, u1, yard.w), b = add(p0, u3, yard.d), m = add(a, u3, yard.d);
      yard.poly = [p0, a, m, b]; yard.u1 = u1; yard.u3 = u3;
      poly = [add(a, u1, 6), poly[(k + 1) % 4], poly[(k + 2) % 4], poly[(k + 3) % 4], add(b, u3, 6), add(add(m, u1, 6), u3, 6)];
      D.areas.push({ t: 'industrial', pts: clipPoly(yard.poly).map(P1) });
      /* its drive in from the road along one of the two field edges it stands on */
      const [g, ax] = yard.gate, rk = ROLE[roles[ax === 'a' ? k : (k + 3) % 4]], yat = (q, w2) => add(add(p0, u1, q), u3, w2);
      if (rk.road) D.roads.push({ pts: (ax === 'a' ? [yat(g, -rk.back), yat(g, 0), yat(g, 30)] : [yat(-rk.back, g), yat(0, g), yat(26, g)]).map(P1), w: 3, type: 'drive', cls: 'service', name: '' });
    }
    const pts = clipPoly(poly).map(P1); if (pts.length < 3 || Math.abs(area(pts)) < 1500) continue;
    D.areas.push({ t: type === 'field' ? 'farmland' : type === 'meadow' ? 'grass' : type, pts });
    cells.push({ i, j, type, pts });
  }
  // the river: down the middle of its meadow, swinging between the columns, straight where a road goes over it
  if (RV) {
    const M = N.map(col => lerp(col[RV.row], col[RV.row + 1], RV.at ?? 0.5)), pts = [];
    for (let i = 0; i < nx - 1; i++) { const a = M[i], b = M[i + 1], u = unit(sub(b, a)), n = [-u[1], u[0]], ph = R() < 0.5 ? 1 : -1, amp = RV.amp * (0.6 + R() * 0.6), m = Math.max(4, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 22));
      for (let k = 0; k < m; k++) { const t = k / m, w = Math.sin(t * Math.PI) ** 2 * Math.sin(t * Math.PI * 2 + (ph > 0 ? 0 : Math.PI)) * amp; pts.push(add(lerp(a, b, t), n, w)); } }
    pts.push(M[nx - 1]);
    for (const run of clipLine(pts)) D.lines.push({ t: 'river', pts: run.map(P1) });
    D.river = { pts: pts.map(P1) };
  }
  // houses and their plots along the village streets
  const frontOf = (x, z) => { let best = null; for (const r of D.roads) for (let k = 0; k < r.pts.length - 1; k++) { const a = r.pts[k], b = r.pts[k + 1], dx = b[0] - a[0], dz = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1))), d = Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t); if (!best || d < best) best = d; } return best ?? 99; };
  for (const st of S.streets || []) {
    const P = linePts(st.line), w = ROLE[role(st.line, st.from)].road?.[1] || 5.5;
    for (let k = st.from; k < st.to; k++) {
      const a = P[k], b = P[k + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]), u = unit(sub(b, a)), n = [-u[1], u[0]];
      for (const sd of st.sides || [1, -1]) {
        const dep = (sd > 0 ? st.depth?.[0] : st.depth?.[1]) ?? 52;
        for (let t = 20 + R() * 6; t < L - 34;) {
          const fr = 24 + R() * 10; if (t + fr > L - 18) break;
          if (R() < (st.skip ?? 0.12)) { t += fr; continue; }
          const hl = 9 + R() * 4, hd = 7 + R() * 2.5, back = w / 2 + 6.5 + R() * 4, mid = add(a, u, t + fr / 2), hp = add(mid, n, sd * (back + hd / 2));
          if (!inBox(hp, 40) || frontOf(hp[0], hp[1]) < back + hd / 2 - 1.5) { t += fr; continue; }
          const pa = add(add(a, u, t + 1), n, sd * (w / 2 + 2.6)), pb = add(add(a, u, t + fr - 1), n, sd * (w / 2 + 2.6)), f = [-n[0] * sd, -n[1] * sd];
          D.buildings.push({ x: r1(hp[0]), z: r1(hp[1]), L: r1(hl), D: r1(hd), rot: +(Math.atan2(-u[1], u[0]) + (R() - 0.5) * 0.08).toFixed(4), cls: 'house', a: Math.round(hl * hd), b: 'house' });
          D.plots.push({ pts: [pa, pb, add(pb, f, -dep), add(pa, f, -dep)].map(P1), h: D.buildings.length - 1, f: [+f[0].toFixed(3), +f[1].toFixed(3)] });
          t += fr;
        }
      }
    }
  }
  // the yards' sheds (cow sheds / grain stores along the yard, a workshop across its end)
  for (const y of S.yards || []) if (y.poly) {
    const [p0] = y.poly, rot = Math.atan2(-y.u1[1], y.u1[0]), at = (a, b) => add(add(p0, y.u1, a), y.u3, b);
    for (const [a, b, L, Dp, turn] of y.halls) { const p = at(a, b); D.buildings.push({ x: r1(p[0]), z: r1(p[1]), L, D: Dp, rot: +(rot + (turn ? Math.PI / 2 : 0)).toFixed(4), cls: 'hall', a: L * Dp }); }
    y.at = at;
  }
  // (QA / the map definitions below) points on the layout: node(i, j), a point `t` grid steps along a line
  const G = { D, N, S, cells, node: (i, j) => N[i][j],
    at(line, t) { const P = linePts(line), k = Math.max(0, Math.min(P.length - 2, Math.floor(t))); return lerp(P[k], P[k + 1], t - k); },
    dir(line, t) { const P = linePts(line), k = Math.max(0, Math.min(P.length - 2, Math.floor(t))); return unit(sub(P[k + 1], P[k])); },
    // distance to the nearest road / belt line of the grid (open ground to stand vehicles on)
    lineDist(x, z) { let best = 1e9; for (const l of lines) { const P = linePts(l); for (let k = 0; k < P.length - 1; k++) { if (role(l, k) === 'none') continue; const a = P[k], b = P[k + 1], dx = b[0] - a[0], dz = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1))); best = Math.min(best, Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t)); } } return best; },
    // the nearest spot to (x, z) along x that is `clear` metres from every line
    open(x, z, clear = 24) { for (let d = 0; d < 260; d += 6) for (const sd of [1, -1]) if (Math.abs(x + sd * d) < HALF - 30 && G.lineDist(x + sd * d, z) >= clear) return [Math.round(x + sd * d), Math.round(z)]; return [Math.round(x), Math.round(z)]; },
  };
  return G;
}

// ---------------------------------------------------------------- field works (the `fortifications` rows of maps.js)
// a platoon / squad position: a hand-dug fire trench of `len` m centred on p, running along u, facing f (unit vectors)
function strongpoint(F, id, name, p, u, f, o = {}) {
  const len = o.len || 44, n = Math.max(2, Math.round(len / 21)), at = (a, b) => P1([p[0] + u[0] * a + f[0] * b, p[1] + u[1] * a + f[1] * b]), fr = (a, b) => { const v = unit([u[0] * a + f[0] * b, u[1] * a + f[1] * b]); return [+v[0].toFixed(2), +v[1].toFixed(2)]; };
  F.push({ type: 'sp', id, name, front: fr(0, 1), revet: o.revet || 'rough', ...(o.kind ? { kind: o.kind } : {}), ...(o.craters ? { craters: o.craters } : {}), ...(o.yard ? { yard: true } : {}) });
  if (o.kind === 'line') { F.push({ type: 'fire', sp: id, base: [at(-len / 2, 0), at(len / 2, 0)], style: 'zigzag', leg: 8, amp: 2.5, bays: 2, dug: o.dugs || [0.3, 0.7], mg: o.mgs || [0.5] }); if (o.comm !== false) F.push({ type: 'comm', sp: id, pts: [at(len * 0.12, -1), at(len * 0.12 + 3, -(o.commLen || 46))], style: 'zigzag', link: false }); return; }
  F.push({ type: 'fire', sp: id, base: Array.from({ length: n + 1 }, (_, k) => at(-len / 2 + len * k / n, k % 2 ? 1.5 : 0)), bayGap: o.kind === 'outpost' ? 6 : 8 });
  const fx = (a, b, da, db) => [...at(a, b), ...fr(da, db)];
  if (o.kind === 'outpost') { F.push({ type: 'fox', sp: id, pts: [fx(-len / 2 - 9, 5, -0.6, 0.8), fx(len / 2 + 9, 6, 0.6, 0.8)] }); if (o.mg) F.push({ type: 'mg', sp: id, at: at(0, 6), front: fr(0, 1) }); return; }
  F.push({ type: 'mg', sp: id, at: at((o.mgEnd || 1) * (len / 2 + 6), 4.5), front: fr((o.mgEnd || 1) * 0.4, 0.9) });
  F.push({ type: 'fox', sp: id, pts: [fx(-(o.mgEnd || 1) * (len / 2 + 11), 6, -(o.mgEnd || 1) * 0.6, 0.8), fx(len * 0.1, 8.5, 0, 1), fx((o.mgEnd || 1) * (len / 2 + 19), 9, (o.mgEnd || 1) * 0.5, 0.85)] });
  const db = o.dugBack || 9.5; F.push({ type: 'dug', sp: id, at: at(-len * 0.22, -db) }); if (len > 50) F.push({ type: 'dug', sp: id, at: at(len * 0.3, -db) });
  if (o.comm !== false) F.push({ type: 'comm', sp: id, pts: [at(len * 0.2, -0.5), at(len * 0.2 + 1.5, -(o.commLen || 27))] });
}
// a churned vehicle trail from a map edge to a point: gentle bends, a few metres of wander
function trail(seed, from, to, w = 4.2, mud = 0.8) {
  const R = rng(seed), n = Math.max(3, Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) / 80)), u = unit(sub(to, from)), pts = [];
  for (let k = 0; k <= n; k++) { const t = k / n, o = k && k < n ? (R() - 0.5) * 26 : 0; pts.push(P1([from[0] + (to[0] - from[0]) * t - u[1] * o, from[1] + (to[1] - from[1]) * t + u[0] * o])); }
  return { w, mud, pts };
}
const NZ = [0, -1], SZ = [0, 1];
const PLUMES = [[-900, -1100, 1.6], [700, -1000, 2.0], [1150, 200, 1.2], [-1100, 400, 1.3], [200, -1300, 2.4]];
// what every generated map shares: the staging grounds on the north / south edges, the first vehicles on open ground
function common(G, o) {
  const op = (x, z) => G.open(x, z, 26);
  const L = [[-70, 640, 'btr', '1st Squad'], [60, 632, 'btr', '2nd Squad'], [-10, 654, 'ifv', '3rd Squad'], [-130, 656, 'tank', 'Assault Squad'], [240, 646, 'tank', null], [420, 664, 'spg', null]];
  const obj = Object.fromEntries(o.objectives.map(q => [q.id, q])), near = (id, dx, dz) => { const q = obj[id]; return op(q.x + dx, q.z + dz); };
  const ai = { staging: {}, overwatch: {}, army: [] };
  for (const q of o.objectives) { ai.staging[q.id] = [near(q.id, 0, -84), near(q.id, -70, -92), near(q.id, 70, -88), near(q.id, -120, -60)]; ai.overwatch[q.id] = [near(q.id, -45, -150), near(q.id, 50, -156)]; }
  const ids = o.objectives.map(q => q.id), A = ids[0], B = ids[1] || A, C = ids[2] || A, Dd = ids[3] || B;
  for (const [x, z, k, id] of [[-300, -640, 'mech', A], [-200, -646, 'assault', A], [60, -640, 'imech', B], [150, -646, 'foot', B], [-250, -662, 'tank', A], [120, -662, 'tank', B], [420, -650, 'atgm', Dd], [-460, -652, 'fpv', C], [250, -674, 'spg', Dd]]) ai.army.push([...op(x, z), k, id]);
  return {
    real: o.id, kind: 'rural', generated: true, size: 'Large', sizeM: SIZE, bounds: 680, roads: [], buildings: [], pancakes: [],
    deployZones: { player: { x0: -680, x1: 680, z0: 612, z1: 692 }, enemy: { x0: -680, x1: 680, z0: -692, z1: -612 } },
    spawns: { attacker: [-560, -300, -50, 325, 560].map(x => [x, -690]), defender: [-245, -30, 183, 572].map(x => [x, 690]) },
    lineup: L.map(([x, z, k, n]) => [...op(x, z), k, n]), support: [[...op(90, 668), 'atgm'], [...op(-190, 672), 'fpv']],
    ai, plumes: PLUMES, cam: [-20, 560, 190], fog: 0.0012, ambience: 'ambience_wind',
  };
}

// ================================================================ rural: fields, belts, roads, trenches
function rural() {
  const G = build({ id: 'rural', seed: 5521, rot: 7, jit: 13,
    xs: [-900, -590, -262, 96, 418, 700, 900], zs: [-900, -604, -318, -44, 232, 512, 900],
    cols: ['belt', 'track', 'belt', 'paved', 'track', 'belt', 'none'], rows: ['belt', 'track', 'belt', 'gravel', 'track', 'belt', 'none'],
    flip: ['c4', 'r1'], cells: { '1,3': 'wood' },
    yards: [{ cell: [3, 2], corner: 3, w: 132, d: 96, gate: [80, 'a'], halls: [[34, 26, 56, 16, 0], [34, 62, 56, 16, 0], [104, 44, 38, 14, 1]] }] });
  const F = [], Y = G.S.yards[0], yc = Y.at(62, 46), at = (l, t) => G.at(l, t), dir = (l, t) => G.dir(l, t);
  // the defender's positions, facing south: in the belt south of the gravel road (C, D forward), the road junction and the
  // field camp (A, B) behind, a machine-dug line with a ditch in the northern belt
  const BT = { dugBack: 5.5, comm: false };   /* (a position on the enemy-side edge of a belt that has its track behind it) */
  const pC = add(at('r4', 1.55), SZ, 11.5), pD = add(at('r4', 3.45), SZ, 11.5), pA = add(at('r3', 2.62), SZ, 16), pB = add(yc, SZ, 58);
  strongpoint(F, 'C1', 'West belt position', pC, dir('r4', 1.5), SZ, { ...BT, len: 62, revet: 'logs', craters: 5 });
  strongpoint(F, 'C2', 'West belt outpost', add(at('r5', 1.4), [0, -1], 0), dir('r5', 1.4), SZ, { len: 16, kind: 'outpost', craters: 5 });
  strongpoint(F, 'D1', 'East belt position', pD, dir('r4', 3.5), SZ, { ...BT, len: 62, mgEnd: -1, craters: 5 });
  strongpoint(F, 'D2', 'East belt outpost', add(at('r5', 3.6), [0, -1], 0), dir('r5', 3.6), SZ, { len: 16, kind: 'outpost', mg: true, craters: 5 });
  strongpoint(F, 'A1', 'Road junction position', pA, dir('r3', 2.6), SZ, { len: 46, revet: 'crude', craters: 4, comm: false });
  strongpoint(F, 'B1', 'Field camp south edge', pB, Y.u3, SZ, { len: 46, revet: 'crude', mgEnd: -1, craters: 4, comm: false });
  strongpoint(F, 'N1', 'Northern belt line west', add(at('r2', 2.45), [0, 1], 9), dir('r2', 2.45), SZ, { len: 190, kind: 'line', revet: 'eng', craters: 8, dugs: [0.2, 0.5, 0.8], mgs: [0.35, 0.7] });
  strongpoint(F, 'N2', 'Northern belt line east', add(at('r2', 3.5), [0, 1], 9), dir('r2', 3.5), SZ, { len: 170, kind: 'line', craters: 7 });
  { const a = add(at('r2', 2.1), [0, 1], 44), b = add(at('r2', 2.9), [0, 1], 44); F.push({ type: 'ditch', pts: [P1(a), P1(b)], bermSide: -1 }); }
  const objectives = [
    { id: 'A', name: 'Road Junction', x: Math.round(pA[0]), z: Math.round(pA[1] - 14), r: 28, phase: 2 },
    { id: 'B', name: 'Field Camp', x: Math.round(yc[0]), z: Math.round(yc[1]), r: 32, phase: 2 },
    { id: 'C', name: 'West Belt Strongpoint', x: Math.round(pC[0]), z: Math.round(pC[1]), r: 28, phase: 1 },
    { id: 'D', name: 'East Belt Strongpoint', x: Math.round(pD[0]), z: Math.round(pD[1]), r: 28, phase: 1 },
  ];
  const def = { ...common(G, { id: 'rural', objectives }), id: 'rural', name: 'Open Steppe', seed: 5521,
    blurb: 'Open farmland as it lies between the villages: big fields, windbreak belts along their edges, a paved road and field tracks, a wood and a field camp. Platoon strongpoints dug into the belts, a machine-dug line behind them.',
    sub: 'Generated · fields, tree belts, trenches',
    damage: { rubble: 0.3, burnt: 0.4 },
    ruin: { houses: { intact: 0.1, grad: [0, 0.4], mix: { rubble: 0.2, stub: 0.2, shell: 0.3, holed: 0.3 } }, trees: { level: 0.4, stump: 0.1, broken: 0.14, stripped: 0.36 }, poles: 0.45, cars: 4, litter: 0.6,
      craters: { zones: [[-680, 180, 680, 640, 130], [-680, -120, 680, 180, 50], [-680, -640, 680, -120, 30]], plot: 1, belt: 0.5 },
      wrecks: [[...G.open(pC[0] + 60, pC[1] + 150), 3.1, 'bradley_ua', 0], [...G.open(pD[0] - 40, pD[1] + 170), 2.9, 'btr80_ua', 0], [...G.open(pA[0] - 90, pA[1] - 120), 0.3, 'bmp3', 0]] },
    objectives, fortifications: F,
    trails: [trail(11, [pC[0] - 30, 704], [pC[0] + 14, pC[1] + 40]), trail(12, [pD[0] + 50, 704], [pD[0] - 10, pD[1] + 44]), trail(13, [at('c3', 5)[0] - 90, 704], add(at('r4', 2.5), [0, 1], 30), 4.0, 0.7),
      trail(14, [pA[0] - 120, -704], add(at('r2', 2.3), [0, -1], 30)), trail(15, [yc[0] + 60, -704], add(at('r2', 3.6), [0, -1], 30))],
    wrecks: [[...G.open(pC[0] + 30, pC[1] + 90), 3.0, 'bradley_ua', 0], [...G.open(pD[0] + 20, pD[1] + 110), 2.8, 't72av_ua', 1], [...G.open(pA[0] + 60, pA[1] + 90), 0.2, 'btr82a', 0], [...G.open(yc[0] - 30, yc[1] - 150), 0.4, 't72b3', 0]],
    smoulder: [[Math.round(yc[0]), Math.round(yc[1]), 0.9], [Math.round(pC[0]), Math.round(pC[1]), 0.7]] };
  return { def, D: G.D, G };
}

// ================================================================ river
function river() {
  const G = build({ id: 'river', seed: 7243, rot: -5, jit: 12,
    xs: [-900, -610, -300, 30, 330, 640, 900], zs: [-900, -560, -300, -100, 56, 330, 900],
    river: { row: 3, at: 0.64, amp: 12, cross: { 3: 'paved', 1: 'lane' } },
    cols: ['belt', 'track', 'belt', 'paved', 'track', 'belt', 'none'], rows: ['belt', 'track', 'belt', 'street', 'lane', 'track', 'none'],
    seg: { 'r3:0': 'track', 'r3:5': 'track', 'r3:1': 'gravel', 'r3:4': 'gravel', 'c2:2': 'street', 'c4:2': 'lane' }, flip: ['c4'],
    streets: [{ line: 'r3', from: 2, to: 4, depth: [46, 52] }, { line: 'c2', from: 2, to: 3, depth: [48, 48], skip: 0.2 }],
    yards: [{ cell: [3, 1], corner: 3, w: 120, d: 90, gate: [76, 'a'], halls: [[32, 24, 52, 16, 0], [32, 58, 52, 16, 0], [96, 40, 34, 14, 1]] }] });
  const F = [], at = (l, t) => G.at(l, t), dir = (l, t) => G.dir(l, t), RV = G.D.river.pts, Y = G.S.yards[0], yc = Y.at(58, 42);
  const dam = lerp(G.node(3, 3), G.node(3, 4), 0.64), dam2 = lerp(G.node(1, 3), G.node(1, 4), 0.64), cross = G.node(3, 3), BT = { dugBack: 5.5, comm: false };
  // the defender holds the north bank: the dam's far end, the village street, the second (track) dam; forward of the river
  // he keeps the south-bank belt (C, D) that the attack has to clear before it can reach the water
  const pC = add(at('r5', 1.5), SZ, 11.5), pD = add(at('r5', 3.5), SZ, 11.5);
  strongpoint(F, 'C1', 'South bank belt west', pC, dir('r5', 1.5), SZ, { ...BT, len: 58, craters: 5 });
  strongpoint(F, 'D1', 'South bank belt east', pD, dir('r5', 3.5), SZ, { ...BT, len: 58, mgEnd: -1, craters: 5 });
  strongpoint(F, 'D2', 'Dam approach outpost', add(at('r4', 3.22), [0, 1], 14), dir('r4', 3.2), SZ, { len: 16, kind: 'outpost', mg: true, craters: 5 });
  strongpoint(F, 'A1', 'Dam north end', add(at('r3', 3.3), [0, 1], 22), dir('r3', 3.3), SZ, { len: 44, revet: 'crude', craters: 5, yard: true, comm: false });
  strongpoint(F, 'A2', 'Village bank west', add(at('r3', 2.4), [0, 1], 66), dir('r3', 2.4), SZ, { len: 40, revet: 'crude', mgEnd: -1, yard: true, comm: false });
  strongpoint(F, 'B1', 'Track dam north end', add(at('r3', 1.22), [0, 1], 20), dir('r3', 1.2), SZ, { len: 40, craters: 4, comm: false });
  strongpoint(F, 'E1', 'East bank outpost', add(at('r3', 4.5), [0, 1], 16), dir('r3', 4.5), SZ, { len: 16, kind: 'outpost', mg: true });
  strongpoint(F, 'N1', 'Northern belt line', add(at('r2', 2.6), [0, 1], 9), dir('r2', 2.6), SZ, { len: 180, kind: 'line', craters: 7 });
  const objectives = [
    { id: 'A', name: 'Village Crossroads', x: Math.round(cross[0]), z: Math.round(cross[1]), r: 30, phase: 2 },
    { id: 'B', name: 'Track Dam', x: Math.round(dam2[0]), z: Math.round(dam2[1] - 40), r: 28, phase: 2 },
    { id: 'C', name: 'South Bank West', x: Math.round(pC[0]), z: Math.round(pC[1]), r: 28, phase: 1 },
    { id: 'D', name: 'Road Dam', x: Math.round(dam[0]), z: Math.round(dam[1] + 44), r: 28, phase: 1 },
  ];
  const def = { ...common(G, { id: 'river', objectives }), id: 'river', name: 'River Crossing', seed: 7243,
    blurb: 'A small steppe river in its flood meadow, a village street along the north bank. Vehicles cross only where a road runs over the river on an earth dam - the paved road at the village, a field track to the west; men can wade. The south-bank belt has to be cleared first.',
    sub: 'Generated · river, village, two crossings',
    damage: { rubble: 0.4, burnt: 0.4 },
    ruin: { houses: { intact: 0.12, grad: [0, 0.4], mix: { rubble: 0.2, stub: 0.18, shell: 0.3, holed: 0.32 } }, trees: { level: 0.4, stump: 0.1, broken: 0.14, stripped: 0.36 }, poles: 0.5, cars: 8, litter: 0.8,
      craters: { zones: [[-680, 150, 680, 640, 120], [-680, -140, 680, 150, 60], [-680, -640, 680, -140, 30]], plot: 1.5, belt: 0.5 },
      wrecks: [[...G.open(dam[0] + 40, dam[1] + 150), 3.1, 'bradley_ua', 0], [...G.open(pC[0] + 50, pC[1] + 130), 2.9, 'btr80_ua', 0], [...G.open(cross[0] - 80, cross[1] - 90), 0.3, 'bmp3', 0]] },
    objectives, fortifications: F,
    trails: [trail(21, [pC[0] - 20, 704], [pC[0] + 12, pC[1] + 40]), trail(22, [pD[0] + 40, 704], [pD[0] - 8, pD[1] + 44]), trail(23, [dam[0] + 110, 704], add(at('r5', 3.12), [0, 1], 26), 4.0, 0.7),
      trail(24, [cross[0] - 150, -704], add(at('r2', 2.4), [0, -1], 30)), trail(25, [yc[0] + 80, -704], add(at('r2', 3.7), [0, -1], 30))],
    wrecks: [[...G.open(dam[0] - 50, dam[1] + 120), 3.0, 'bradley_ua', 0], [...G.open(pD[0] + 30, pD[1] + 100), 2.8, 't72av_ua', 1], [...G.open(dam2[0] + 60, dam2[1] + 130), 3.2, 'btr80_ua', 0], [...G.open(cross[0] + 90, cross[1] - 140), 0.2, 'btr82a', 0]],
    smoulder: [[Math.round(cross[0] - 40), Math.round(cross[1] + 20), 0.9], [Math.round(yc[0]), Math.round(yc[1]), 0.8]] };
  return { def, D: G.D, G, RV };
}

// ================================================================ grey zone
function greyzone() {
  const G = build({ id: 'greyzone', seed: 9917, rot: 11, jit: 14,
    xs: [-900, -640, -360, -40, 250, 560, 900], zs: [-900, -620, -360, -150, 110, 380, 900],
    cols: ['belt', 'track', 'belt', 'gravel', 'belt', 'track', 'none'], rows: ['belt', 'track', 'belt', 'lane', 'belt', 'track', 'none'],
    seg: { 'r3:2': 'street', 'r3:3': 'street' }, flip: ['c1', 'r5'],
    streets: [{ line: 'r3', from: 2, to: 4, depth: [44, 44], skip: 0.25 }],
    yards: [{ cell: [3, 3], corner: 0, w: 110, d: 84, gate: [70, 'b'], halls: [[30, 24, 48, 15, 0], [30, 56, 48, 15, 0]] }] });
  const F = [], at = (l, t) => G.at(l, t), dir = (l, t) => G.dir(l, t), Y = G.S.yards[0], yc = Y.at(54, 40), ham = at('r3', 3.0);
  // two lines 500-600 m apart that have not moved in a year and more: the enemy's in the belt north of the hamlet (zig-zag,
  // dugouts, communication trenches back), ours in the belt to the south (facing north); between them the hamlet's wall
  // stubs and the outposts each side pushed forward into the broken belts
  const lN = 'r2', lS = 'r5';
  strongpoint(F, 'N1', 'Enemy line west', add(at(lN, 1.6), [0, 1], 8), dir(lN, 1.6), SZ, { len: 210, kind: 'line', revet: 'eng', craters: 12, dugs: [0.15, 0.4, 0.65, 0.9], mgs: [0.25, 0.75], commLen: 70 });
  strongpoint(F, 'N2', 'Enemy line centre', add(at(lN, 2.62), [0, 1], 8), dir(lN, 2.62), SZ, { len: 200, kind: 'line', revet: 'logs', craters: 12, dugs: [0.2, 0.5, 0.8], mgs: [0.3, 0.7], commLen: 70 });
  strongpoint(F, 'N3', 'Enemy line east', add(at(lN, 3.6), [0, 1], 8), dir(lN, 3.6), SZ, { len: 190, kind: 'line', craters: 12, dugs: [0.25, 0.7], mgs: [0.5], commLen: 70 });
  strongpoint(F, 'S1', 'Old forward line west', add(at(lS, 1.7), NZ, 13), dir(lS, 1.7), NZ, { len: 170, kind: 'line', craters: 9, dugs: [0.3, 0.7], mgs: [0.5], comm: false });
  strongpoint(F, 'S2', 'Old forward line east', add(at(lS, 3.3), NZ, 13), dir(lS, 3.3), NZ, { len: 170, kind: 'line', revet: 'logs', craters: 9, dugs: [0.3, 0.7], mgs: [0.5], comm: false });
  const pC = add(at('r4', 1.5), [0, -1], 6), pD = add(at('r4', 3.6), [0, -1], 6), pA = add(at(lN, 1.6), [0, 1], 8), pB = add(at(lN, 3.6), [0, 1], 8);
  strongpoint(F, 'C1', 'Broken belt outpost west', pC, dir('r4', 1.5), SZ, { len: 40, revet: 'logs', craters: 9 });
  strongpoint(F, 'D1', 'Broken belt outpost east', pD, dir('r4', 3.6), SZ, { len: 40, mgEnd: -1, craters: 9 });
  strongpoint(F, 'H1', 'Hamlet ruins', add(ham, [0, 1], 30), dir('r3', 3), SZ, { len: 18, kind: 'outpost', revet: 'crude', mg: true, yard: true, craters: 8 });
  strongpoint(F, 'H2', 'Yard ruins', add(yc, [0, 1], 52), Y.u1, SZ, { len: 18, kind: 'outpost', revet: 'crude', yard: true, craters: 8 });
  const objectives = [
    { id: 'A', name: 'Enemy Line West', x: Math.round(pA[0]), z: Math.round(pA[1]), r: 30, phase: 2 },
    { id: 'B', name: 'Enemy Line East', x: Math.round(pB[0]), z: Math.round(pB[1]), r: 30, phase: 2 },
    { id: 'C', name: 'Hamlet Ruins', x: Math.round(ham[0]), z: Math.round(ham[1] + 12), r: 30, phase: 1 },
    { id: 'D', name: 'Broken Belt East', x: Math.round(pD[0]), z: Math.round(pD[1]), r: 28, phase: 1 },
  ];
  const W = (x, z, h, k, f) => [...G.open(x, z, 18), h, k, f];
  const def = { ...common(G, { id: 'greyzone', objectives }), id: 'greyzone', name: 'Grey Zone', seed: 9917, fallow: 1,
    blurb: 'Ground between two lines that have not moved since 2022: untilled, shell-torn fields, tree belts reduced to splintered trunks and stumps, a hamlet of wall stubs, burnt-out armour of earlier assaults. The old forward trenches behind you, the enemy line in the far belt, his outposts in the wreckage between.',
    sub: 'Generated · no man\'s land, trench lines',
    belts: [[P1(at('r4', 0.9)), P1(at('r4', 2.5)), P1(at('r4', 4.4))], [P1(at(lN, 0.9)), P1(at(lN, 2.6)), P1(at(lN, 4.4))], [P1(at(lS, 0.9)), P1(at(lS, 2.5)), P1(at(lS, 4.4))]],
    damage: { rubble: 0.75, burnt: 0.6 },
    ruin: { houses: { intact: 0, grad: [0, 0.1], mix: { rubble: 0.42, stub: 0.34, shell: 0.2, holed: 0.04 } }, blocks: { glass: 1, burn: 0.9, roof: 0.95, roofTall: 0.95, scale: 1.2 },
      trees: { level: 0.95, stump: 0.3, broken: 0.05, stripped: 0.55 } /* (rural 'broken' = a shelled tree still in leaf: here nearly all are stumps or bare splintered trunks) */, poles: 0.9, cars: 6, litter: 1,
      craters: { zones: [[-680, 40, 680, 500, 330], [-680, -430, 680, 40, 330], [-680, 500, 680, 640, 30], [-680, -640, 680, -430, 40]], plot: 3, belt: 0.9 },
      wrecks: [W(ham[0] - 150, ham[1] + 120, 3.0, 'bradley_ua', 0), W(ham[0] + 120, ham[1] + 160, 2.8, 't72av_ua', 2), W(pC[0] + 90, pC[1] + 110, 3.2, 'btr80_ua', 0), W(pD[0] - 60, pD[1] + 130, 3.1, 'bradley_ua', 0),
        W(ham[0] - 40, ham[1] - 110, 0.2, 'bmp3', 0), W(pA[0] + 120, pA[1] + 120, 0.3, 't72b3', 2), W(pB[0] - 100, pB[1] + 110, 0.1, 'btr82a', 0)] },
    objectives, fortifications: F,
    trails: [trail(31, [pC[0] - 40, 704], add(at(lS, 1.4), [0, 1], 34)), trail(32, [pD[0] + 30, 704], add(at(lS, 3.6), [0, 1], 34)), trail(33, add(at(lS, 2.5), [0, -1], 30), add(ham, [0, 1], 70), 4.0, 0.9),
      trail(34, [pA[0] - 60, -704], add(at(lN, 1.3), [0, -1], 80)), trail(35, [pB[0] + 60, -704], add(at(lN, 3.9), [0, -1], 80))],
    wrecks: [W(ham[0] + 40, ham[1] + 90, 2.9, 'bradley_ua', 0), W(ham[0] - 90, ham[1] + 210, 3.3, 't72av_ua', 1), W(pD[0] + 70, pD[1] + 80, 3.0, 'btr80_ua', 0), W(pC[0] - 70, pC[1] + 150, 2.7, 'bradley_ua', 0),
      W(ham[0] + 150, ham[1] - 60, 0.3, 'bmp3', 0), W(pA[0] - 60, pA[1] + 90, 0.2, 't72b3', 1), W(yc[0] + 30, yc[1] - 110, 0.4, 'btr82a', 0), W(pB[0] + 40, pB[1] + 140, 0.1, 'bmp3', 0)],
    smoulder: [[Math.round(ham[0] - 30), Math.round(ham[1] + 10), 0.8], [Math.round(yc[0]), Math.round(yc[1]), 0.7]] };
  return { def, D: G.D, G };
}

const BUILT = { rural: rural(), river: river(), greyzone: greyzone() };
export const SYNTH_MAPS = Object.fromEntries(Object.entries(BUILT).map(([k, v]) => [k, v.def]));
export const SYNTH_DATA = Object.fromEntries(Object.entries(BUILT).map(([k, v]) => [k, v.D]));
