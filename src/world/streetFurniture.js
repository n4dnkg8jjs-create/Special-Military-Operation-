// Street furniture (streets v1): Vienna-convention Ukrainian road signs and the gear around them, war-worn (2023-24).
//   - main-road diamonds on the main road before junctions, give-way triangles on the side streets entering it (a rare stop)
//   - zebra crossings (faded) with blue pedestrian-crossing squares both sides, near schools / shops / stops on main roads
//   - bus-stop signs and a few plain Soviet concrete shelters on the main roads
//   - town entry / exit name plates on the through roads at the map edge
//   - street-name plates on panel-block corners, dead traffic lights at the central junction(s)
//   - railway level crossings: crossing light posts with St Andrew's crosses, barriers (raised / broken), countdown beacons
// All cosmetic (no nav; the shelters register as solids so later props keep off).  Built procedurally into one merged mesh per map third
// (a few draw calls, one material: a sign-face atlas drawn on a canvas at load + vertex colours), cast into the static shadow
// cache, culled by distance through instancer LODS.  Own RNG stream (never the world's): deterministic for multiplayer.
import * as THREE from 'three';
import { LODS, trs } from './instancer.js';
import { markStatic } from '../engine/renderer.js';

export function streetRng(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const strHash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
function segD(x, z, ax, az, bx, bz) { const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9; let t = ((x - ax) * dx + (z - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t; return Math.hypot(ax + dx * t - x, az + dz * t - z); }
function segX(a, b, c, d) { const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1], den = rx * sz - rz * sx; if (Math.abs(den) < 1e-9) return null; const t = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / den; return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null; }

// ---------------------------------------------------------------- polyline helpers (arc length s)
function prep(r, i) { const P = r.pts, cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1])); return { ...r, i, P, cum, len: cum[cum.length - 1], src: r }; }
function at(r, s) {   // [x, z, ux, uz] at arc length s (clamped)
  const { P, cum } = r; s = Math.max(0, Math.min(r.len, s)); let k = 1; while (k < P.length - 1 && cum[k] < s) k++;
  const L = cum[k] - cum[k - 1] || 1e-9, t = (s - cum[k - 1]) / L, ux = (P[k][0] - P[k - 1][0]) / L, uz = (P[k][1] - P[k - 1][1]) / L;
  return [P[k - 1][0] + (P[k][0] - P[k - 1][0]) * t, P[k - 1][1] + (P[k][1] - P[k - 1][1]) * t, ux, uz];
}
function project(r, x, z) {
  let best = null; const P = r.P;
  for (let k = 0; k < P.length - 1; k++) {
    const [ax, az] = P[k], [bx, bz] = P[k + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9; let t = ((x - ax) * dx + (z - az) * dz) / L2; t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz), L = Math.sqrt(L2);
    if (!best || d < best.d) best = { d, x: px, z: pz, ux: dx / L, uz: dz / L, s: r.cum[k] + t * L };
  }
  return best;
}

// ---------------------------------------------------------------- plan (roads only: no buildings needed)
// roads: [{ pts, w, sw, sc ('main' | 'micro' | 'priv' | 'gravel' | 'drive' | 'track'), name }]
export function planStreets(roads, { pois = [], areas = [], rails = [], size = 1000, extraCands = [] } = {}) {
  const R = roads.map(prep).filter(r => r.P.length > 1 && r.len > 1);
  const main = R.filter(r => r.sc === 'main'), sideOk = r => r.sc === 'main' || r.sc === 'micro' || r.sc === 'priv' || r.sc === 'gravel';
  const J = [];
  const addJ = (q, r, x, z, apps) => {
    const pq = project(q, x, z); if (J.some(j => j.q === q && j.r === r && Math.hypot(j.x - pq.x, j.z - pq.z) < 12)) return;
    const a0 = at(r, apps[0].s); if (Math.abs(a0[2] * pq.uz - a0[3] * pq.ux) < 0.45) return;   // (one way simply carrying on from the other)
    if (r.sc === 'main' && J.some(j => j.mm && Math.hypot(j.x - pq.x, j.z - pq.z) < 15)) return;
    J.push({ q, r, x: pq.x, z: pq.z, s: pq.s, ux: pq.ux, uz: pq.uz, apps, mm: r.sc === 'main' });
  };
  for (const q of main) for (const r of R) {
    if (r === q || !sideOk(r)) continue;
    for (const e of [0, 1]) { const p = e ? r.P[r.P.length - 1] : r.P[0], pq = project(q, p[0], p[1]); if (pq.d < q.w / 2 + 2.5) addJ(q, r, p[0], p[1], [{ s: e ? r.len : 0, dir: e ? 1 : -1 }]); }
    for (let i = 0; i < r.P.length - 1; i++) for (let k = 0; k < q.P.length - 1; k++) {
      const t = segX(r.P[i], r.P[i + 1], q.P[k], q.P[k + 1]); if (t == null) continue;
      const s = r.cum[i] + t * (r.cum[i + 1] - r.cum[i]); if (s < 3 || s > r.len - 3) continue;
      const [x, z] = at(r, s); addJ(q, r, x, z, [{ s, dir: 1 }, { s, dir: -1 }]);
    }
  }
  // railway level crossings: road x rail, parallel tracks within 16 m along the road as one crossing
  const RX = [];
  for (const r of R) {
    if (!sideOk(r)) continue; const hits = [];
    for (const l of rails) for (let i = 0; i < r.P.length - 1; i++) for (let k = 0; k < l.pts.length - 1; k++) {
      const t = segX(r.P[i], r.P[i + 1], l.pts[k], l.pts[k + 1]); if (t != null) hits.push(r.cum[i] + t * (r.cum[i + 1] - r.cum[i]));
    }
    hits.sort((a, b) => a - b);
    for (let i = 0; i < hits.length;) { let j = i; while (j + 1 < hits.length && hits[j + 1] - hits[j] < 16) j++; const s = (hits[i] + hits[j]) / 2, [x, z, ux, uz] = at(r, s); RX.push({ r, s, x, z, ux, uz, half: (hits[j] - hits[i]) / 2 + 3 }); i = j + 1; }
  }
  // zebra crossings on the main roads by schools, shops, stops
  const cands = [...extraCands];
  for (const p of pois) if (/school|kindergarten|bus_stop|tram_stop|shop|convenience|supermarket|pharmacy|cafe|bank|post|marketplace|hairdresser/.test(p[3] || '')) cands.push([p[1], p[2], /school|kinder/.test(p[3]) ? 0 : /stop/.test(p[3]) ? 1 : 2]);
  for (const a of areas) if (['school', 'kindergarten', 'retail'].includes(a.t)) { let x = 0, z = 0; for (const p of a.pts) { x += p[0]; z += p[1]; } cands.push([x / a.pts.length, z / a.pts.length, a.t === 'retail' ? 2 : 0]); }
  cands.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
  const Z = [], half = size / 2;
  for (const [cx, cz] of cands) {
    let best = null; for (const q of main) { const p = project(q, cx, cz); if (p.d < 60 && (!best || p.d < best.p.d)) best = { q, p }; }
    if (!best) continue; const { q, p } = best;
    if (p.s < 20 || p.s > q.len - 20 || Math.max(Math.abs(p.x), Math.abs(p.z)) > half - 30) continue;
    if (R.some(o => o !== q && o.sc !== 'track' && o.P.some((a, k) => k < o.P.length - 1 && segD(p.x, p.z, a[0], a[1], o.P[k + 1][0], o.P[k + 1][1]) < o.w / 2 + q.w / 2 + 9))) continue;   // clear of junctions / drives
    if (RX.some(c => Math.hypot(c.x - p.x, c.z - p.z) < 40) || Z.some(c => Math.hypot(c.x - p.x, c.z - p.z) < 110) || Z.length >= 7) continue;
    Z.push({ q, x: p.x, z: p.z, ux: p.ux, uz: p.uz, s: p.s, w: q.w, sw: q.sw || 0 });
  }
  // entries: through roads running off the map
  const E = [];
  for (const r of main) for (const e of [0, 1]) {
    const p = e ? r.P[r.P.length - 1] : r.P[0]; if (Math.max(Math.abs(p[0]), Math.abs(p[1])) < half - 45 || r.len < 120) continue;
    E.push({ r, s: e ? r.len - 34 : 34, dir: e ? -1 : 1 });   // dir: inbound travel along s
  }
  return { R, J, RX, Z, E };
}

// ---------------------------------------------------------------- sign-face atlas (canvas)
const AW = 1024, AH = 512;
const RECT = {
  plain: [0, 0, 128, 128], diamond: [128, 0, 128, 128], diamondH: [256, 0, 128, 128], give: [384, 0, 128, 128], giveH: [512, 0, 128, 128],
  ped: [640, 0, 128, 128], pedH: [768, 0, 128, 128], bus: [896, 0, 128, 128],
  entry: [0, 128, 256, 96], exit: [256, 128, 256, 96], stop: [768, 128, 128, 128],
  stripes: [896, 128, 128, 32], b3: [896, 168, 32, 88], b2: [936, 168, 32, 88], b1: [976, 168, 32, 88],
  plate0: [0, 256, 256, 44], plate1: [0, 304, 256, 44], plate2: [0, 352, 256, 44], plate3: [0, 400, 256, 44],
  concrete: [256, 256, 128, 128], metal: [384, 256, 128, 128], timetable: [512, 256, 64, 96], rust: [576, 256, 128, 128],
};
let ATLAS = null, ATLAS_KEY = '';
function atlas(town, names) {
  const key = town + '|' + names.join('|'); if (ATLAS && ATLAS_KEY === key) return ATLAS;
  const cv = document.createElement('canvas'); cv.width = AW; cv.height = AH; const x = cv.getContext('2d');
  const rnd = streetRng(77); x.fillStyle = '#ffffff'; x.fillRect(0, 0, AW, AH);
  const grime = ([X, Y, W, H], n, a = 0.08) => { for (let i = 0; i < n; i++) { x.fillStyle = `rgba(${40 + rnd() * 40 | 0},${35 + rnd() * 30 | 0},${25 + rnd() * 20 | 0},${rnd() * a})`; const r = 1 + rnd() * 5; x.beginPath(); x.arc(X + rnd() * W, Y + rnd() * H, r, 0, 7); x.fill(); } };
  const poly = (pts, fill, stroke, lw) => { x.beginPath(); pts.forEach(([a, b], i) => i ? x.lineTo(a, b) : x.moveTo(a, b)); x.closePath(); if (fill) { x.fillStyle = fill; x.fill(); } if (stroke) { x.strokeStyle = stroke; x.lineWidth = lw; x.stroke(); } };
  const inset = (pts, cx, cy, k) => pts.map(([a, b]) => [cx + (a - cx) * k, cy + (b - cy) * k]);
  const holes = ([X, Y, W, H], n) => { for (let i = 0; i < n; i++) { const hx = X + W * (0.2 + rnd() * 0.6), hy = Y + H * (0.25 + rnd() * 0.55); x.fillStyle = '#c9c6bd'; x.beginPath(); x.arc(hx, hy, 3.2, 0, 7); x.fill(); x.fillStyle = '#141210'; x.beginPath(); x.arc(hx, hy, 1.8, 0, 7); x.fill(); x.fillStyle = 'rgba(110,60,30,0.35)'; x.fillRect(hx - 1, hy, 2, 6 + rnd() * 10); } };
  const text = (s, cx, cy, maxW, px, col, weight = 'bold') => { x.fillStyle = col; let f = px; x.font = `${weight} ${f}px sans-serif`; while (x.measureText(s).width > maxW && f > 8) { f--; x.font = `${weight} ${f}px sans-serif`; } x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(s, cx, cy); };
  // plain / metal / concrete / rust
  grime(RECT.plain, 60, 0.05);
  { const [X, Y, W, H] = RECT.metal; x.fillStyle = '#d8dad6'; x.fillRect(X, Y, W, H); for (let i = 0; i < 40; i++) { x.fillStyle = `rgba(120,70,35,${rnd() * 0.25})`; x.fillRect(X + rnd() * W, Y + rnd() * H, 1 + rnd() * 3, 4 + rnd() * 30); } grime(RECT.metal, 80, 0.12); }
  { const [X, Y, W, H] = RECT.concrete; x.fillStyle = '#e4e0d8'; x.fillRect(X, Y, W, H); grime(RECT.concrete, 260, 0.14); for (let i = 0; i < 6; i++) { x.strokeStyle = 'rgba(30,28,25,0.35)'; x.lineWidth = 1; x.beginPath(); let a = X + rnd() * W, b = Y + rnd() * H; x.moveTo(a, b); for (let k = 0; k < 5; k++) { a += (rnd() - 0.5) * 30; b += rnd() * 20; x.lineTo(a, b); } x.stroke(); } }
  { const [X, Y, W, H] = RECT.rust; x.fillStyle = '#9a6a48'; x.fillRect(X, Y, W, H); grime(RECT.rust, 200, 0.3); }
  // main road: yellow diamond, white border (2.3)
  for (const k of ['diamond', 'diamondH']) { const [X, Y, W, H] = RECT[k], d = [[X + W / 2, Y + 1], [X + W - 1, Y + H / 2], [X + W / 2, Y + H - 1], [X + 1, Y + H / 2]]; poly(d, '#f2f0ea'); poly(inset(d, X + W / 2, Y + H / 2, 0.86), '#2a2a2a'); poly(inset(d, X + W / 2, Y + H / 2, 0.82), '#f2f0ea'); poly(inset(d, X + W / 2, Y + H / 2, 0.58), '#e8b81c'); grime(RECT[k], 70, 0.12); if (k === 'diamondH') holes(RECT[k], 6); }
  // give way: inverted triangle, red border (2.1)
  for (const k of ['give', 'giveH']) { const [X, Y, W, H] = RECT[k], t = [[X + 1, Y + 1], [X + W - 1, Y + 1], [X + W / 2, Y + H - 1]]; poly(t, '#c8202a'); poly(inset(t, X + W / 2, Y + H / 3, 0.62), '#f2f0ea'); grime(RECT[k], 70, 0.12); if (k === 'giveH') holes(RECT[k], 5); }
  // pedestrian crossing (5.35.1): blue square, white triangle, walking figure on the zebra
  for (const k of ['ped', 'pedH']) {
    const [X, Y, W, H] = RECT[k]; x.fillStyle = '#f2f0ea'; x.fillRect(X, Y, W, H); x.fillStyle = '#1f55a8'; x.fillRect(X + 5, Y + 5, W - 10, H - 10);
    poly([[X + W / 2, Y + 14], [X + W - 14, Y + H - 16], [X + 14, Y + H - 16]], '#f2f0ea');
    x.fillStyle = '#111'; for (let i = 0; i < 4; i++) x.fillRect(X + 34 + i * 16, Y + H - 34, 9, 12);
    x.strokeStyle = '#111'; x.lineWidth = 5; x.lineCap = 'round'; const cx = X + W / 2, cy = Y + 58;
    x.beginPath(); x.arc(cx + 2, cy - 12, 6, 0, 7); x.fillStyle = '#111'; x.fill();
    x.beginPath(); x.moveTo(cx, cy - 4); x.lineTo(cx - 3, cy + 14); x.lineTo(cx - 12, cy + 30); x.moveTo(cx - 3, cy + 14); x.lineTo(cx + 9, cy + 30); x.moveTo(cx - 12, cy + 4); x.lineTo(cx + 10, cy + 2); x.stroke();
    grime(RECT[k], 60, 0.12); if (k === 'pedH') holes(RECT[k], 6);
  }
  // bus stop (5.41): blue, white panel with a bus
  { const [X, Y, W, H] = RECT.bus; x.fillStyle = '#f2f0ea'; x.fillRect(X, Y, W, H); x.fillStyle = '#1f55a8'; x.fillRect(X + 5, Y + 5, W - 10, H - 10); x.fillStyle = '#f2f0ea'; x.fillRect(X + 18, Y + 22, W - 36, H - 44);
    x.fillStyle = '#111'; x.fillRect(X + 28, Y + 46, 72, 30); x.fillStyle = '#f2f0ea'; for (let i = 0; i < 4; i++) x.fillRect(X + 32 + i * 17, Y + 50, 12, 11); x.fillStyle = '#111'; x.beginPath(); x.arc(X + 44, Y + 80, 7, 0, 7); x.arc(X + 86, Y + 80, 7, 0, 7); x.fill(); grime(RECT.bus, 60, 0.12); }
  // timetable sheet holder
  { const [X, Y, W, H] = RECT.timetable; x.fillStyle = '#f5f4ee'; x.fillRect(X, Y, W, H); x.fillStyle = '#333'; for (let i = 0; i < 9; i++) x.fillRect(X + 8, Y + 12 + i * 9, 20 + rnd() * 26, 3); grime(RECT.timetable, 40, 0.2); }
  // town entry (5.45) / exit (5.46): white, black border, name; exit struck through in red
  for (const k of ['entry', 'exit']) { const [X, Y, W, H] = RECT[k]; x.fillStyle = '#111'; x.fillRect(X + 2, Y + 2, W - 4, H - 4); x.fillStyle = '#f2f0ea'; x.fillRect(X + 7, Y + 7, W - 14, H - 14); text(town.toUpperCase(), X + W / 2, Y + H / 2 + 2, W - 30, 44, '#111');
    if (k === 'exit') { x.strokeStyle = '#c8202a'; x.lineWidth = 9; x.beginPath(); x.moveTo(X + 16, Y + H - 14); x.lineTo(X + W - 16, Y + 14); x.stroke(); } grime(RECT[k], 120, 0.1); }
  // stop (2.2): red octagon
  { const [X, Y, W, H] = RECT.stop, c = 0.2929, o = [[c, 0], [1 - c, 0], [1, c], [1, 1 - c], [1 - c, 1], [c, 1], [0, 1 - c], [0, c]].map(([a, b]) => [X + 1 + a * (W - 2), Y + 1 + b * (H - 2)]); poly(o, '#f2f0ea'); poly(inset(o, X + W / 2, Y + H / 2, 0.9), '#c8202a'); text('STOP', X + W / 2, Y + H / 2 + 2, 96, 34, '#f2f0ea'); grime(RECT.stop, 50, 0.12); }
  // red / white stripes (St Andrew's cross arms, barrier arms)
  { const [X, Y, W, H] = RECT.stripes; for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? '#f0eee8' : '#c41e1e'; x.fillRect(X + i * 16, Y, 16, H); } grime(RECT.stripes, 40, 0.2); }
  // countdown beacons (1.4.x): white, 3 / 2 / 1 red slants
  for (const [k, n] of [['b3', 3], ['b2', 2], ['b1', 1]]) { const [X, Y, W, H] = RECT[k]; x.fillStyle = '#f0eee8'; x.fillRect(X, Y, W, H); x.fillStyle = '#c41e1e'; for (let i = 0; i < n; i++) { const y0 = Y + 12 + i * 24; x.beginPath(); x.moveTo(X, y0 + 12); x.lineTo(X + W, y0); x.lineTo(X + W, y0 + 10); x.lineTo(X, y0 + 22); x.closePath(); x.fill(); } grime(RECT[k], 30, 0.2); }
  // street-name plates: blue, white text
  names.forEach((nm, i) => { const [X, Y, W, H] = RECT['plate' + i]; x.fillStyle = '#f0eee8'; x.fillRect(X, Y, W, H); x.fillStyle = '#1d4f9c'; x.fillRect(X + 3, Y + 3, W - 6, H - 6); text(nm, X + W / 2, Y + H / 2 + 1, W - 16, 26, '#f0eee8'); grime(RECT['plate' + i], 40, 0.15); });
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  ATLAS = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 0.78, metalness: 0.08 }); ATLAS.name = 'street_furniture'; ATLAS_KEY = key;
  return ATLAS;
}
const uvr = (k, fx, fy) => { const [X, Y, W, H] = RECT[k], p = 2; return [(X + p + fx * (W - 2 * p)) / AW, 1 - (Y + p + (1 - fy) * (H - 2 * p)) / AH]; };

// ---------------------------------------------------------------- merged geometry per map third
const col = h => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };
const C = { post: col(0x8e918c), postDark: col(0x3c3f3a), white: col(0xffffff), concrete: col(0xb9b4aa), wood: col(0x5e4a36), lightHead: col(0x262825), red: col(0x3a0d0c), amber: col(0x3a2808), green: col(0x0b2a16), black: col(0x1c1c1a), stripe: col(0xffffff) };
class GB {
  constructor() { this.p = []; this.n = []; this.u = []; this.c = []; this.i = []; }
  get nv() { return this.p.length / 3; }
}
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _m3 = new THREE.Matrix3();
function emitPoly(g, M, pts3, nrm, uvs, c) {   // convex polygon, CCW about nrm
  _m3.setFromMatrix4(M); _n.set(...nrm).applyMatrix3(_m3).normalize();
  const b = g.nv;
  pts3.forEach((p, k) => { _v.set(p[0], p[1], p[2]).applyMatrix4(M); g.p.push(_v.x, _v.y, _v.z); g.n.push(_n.x, _n.y, _n.z); g.u.push(uvs[k][0], uvs[k][1]); g.c.push(c[0], c[1], c[2]); });
  for (let k = 1; k < pts3.length - 1; k++) g.i.push(b, b + k, b + k + 1);
}
// box (no bottom), centre (cx, cy, cz), size, colour, atlas region (whole face)
function box(g, M, cx, cy, cz, sx, sy, sz, c, rk = 'plain', bottom = false) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2, U = [uvr(rk, 0, 0), uvr(rk, 1, 0), uvr(rk, 1, 1), uvr(rk, 0, 1)];
  const F = [[[1, 0, 0], [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]]], [[-1, 0, 0], [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]]],
    [[0, 0, 1], [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]]], [[0, 0, -1], [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]]],
    [[0, 1, 0], [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]]]];
  if (bottom) F.push([[0, -1, 0], [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]]]);
  for (const [n, q] of F) emitPoly(g, M, q.map(p => [p[0] + cx, p[1] + cy, p[2] + cz]), n, U, c);
}
const SHAPE = { tri: [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]], itri: [[-0.5, 0.5], [0, -0.5], [0.5, 0.5]], diamond: [[0, -0.5], [0.5, 0], [0, 0.5], [-0.5, 0]], rect: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] };
{ const c = 0.2929; SHAPE.oct = [[c, 0], [1 - c, 0], [1, c], [1, 1 - c], [1 - c, 1], [c, 1], [0, 1 - c], [0, c]].map(([a, b]) => [a - 0.5, b - 0.5]); }
// flat sign plate in the local xy plane facing +z, centre (cx, cy, cz); back face plain metal (or the same face: double)
function plate(g, M, shape, w, h, cx, cy, cz, rk, { double = false, back = 'metal', t = 0.016, tint = C.white } = {}) {
  let S = SHAPE[shape]; let A = 0; for (let i = 0, j = S.length - 1; i < S.length; j = i++) A += S[j][0] * S[i][1] - S[i][0] * S[j][1]; if (A < 0) S = S.slice().reverse();
  emitPoly(g, M, S.map(([a, b]) => [cx + a * w, cy + b * h, cz + t / 2]), [0, 0, 1], S.map(([a, b]) => uvr(rk, a + 0.5, b + 0.5)), tint);
  const Sb = S.slice().reverse();
  emitPoly(g, M, Sb.map(([a, b]) => [cx + a * w, cy + b * h, cz - t / 2]), [0, 0, -1], Sb.map(([a, b]) => double ? uvr(rk, 0.5 - a, b + 0.5) : uvr(back, a + 0.5, b + 0.5)), double ? tint : C.post);
}

// ---------------------------------------------------------------- build
export function buildStreetFurniture(w, plan, { size = 1000, seed = 1, town = '', urban = true, lights = 1, shelters = 3, plates = true, busPois = [] } = {}) {
  if (!plan || typeof document === 'undefined') return null;
  const R = streetRng(seed ^ 0x51ee7f0), half = size / 2, CH = Math.ceil(size / 3), stats = {};
  const gy = (x, z) => { try { return w.terrain?.heightAt ? Math.max(0, w.terrain.heightAt(x, z)) : 0; } catch { return 0; } };
  const roads = plan.R, onRoad = (x, z, pad) => roads.some(r => r.sc !== 'track' || pad > 0.5 ? r.P.some((a, k) => k < r.P.length - 1 && segD(x, z, a[0], a[1], r.P[k + 1][0], r.P[k + 1][1]) < r.w / 2 + pad) : false);
  const kit = (w.buildings || []).filter(b => b.L && b.D);
  const inKit = (x, z, pad) => kit.some(b => { const dx = x - b.x, dz = z - b.z, lx = dx * b.cos - dz * b.sin, lz = dx * b.sin + dz * b.cos; return Math.abs(lx) < b.L / 2 + pad && Math.abs(lz) < b.D / 2 + pad; });
  const free = (x, z, pad = 0.35) => Math.abs(x) < half - 2 && Math.abs(z) < half - 2 && !onRoad(x, z, 0.3) && !inKit(x, z, pad + 0.3) && !w.overlapsBuilding?.(x, z, pad, pad, 0.3) && !w.solidHit?.(x, z, pad * 0.5, pad * 0.5, 0, 0.05);
  const chunks = new Map(), G = (x, z) => { const k = Math.floor((x + half) / CH) + ',' + Math.floor((z + half) / CH); return chunks.get(k) || chunks.set(k, new GB()).get(k); };
  const count = k => { stats[k] = (stats[k] || 0) + 1; };
  const faceYaw = (nx, nz) => Math.atan2(nx, nz);   // local +z -> (nx, nz)
  // wear: 0 upright, 1 leaning, 2 bent over, 3 knocked down, 4 gone (stub)
  const wear = (p = 1) => { const u = R(); return u < 1 - 0.5 * p ? 0 : u < 1 - 0.25 * p ? 1 : u < 1 - 0.14 * p ? 2 : u < 1 - 0.05 * p ? 3 : 4; };
  const frame = (x, z, yaw, st, y = gy(x, z)) => {
    if (st === 0) return trs(x, y, z, yaw, 1, (R() - 0.5) * 0.04, (R() - 0.5) * 0.04);
    if (st === 1) return trs(x, y, z, yaw, 1, (R() - 0.5) * 0.45, (R() - 0.5) * 0.45);
    if (st === 2) return trs(x, y, z, yaw, 1, (R() < 0.5 ? -1 : 1) * (0.5 + R() * 0.5), (R() - 0.5) * 0.6);
    return trs(x, y + 0.04, z, yaw, 1, (R() < 0.5 ? -1 : 1) * (1.5 + R() * 0.04), (R() - 0.5) * 0.3);
  };
  // a sign on a post: plates top-down [[shape, w, h, rect, opts]]
  const signPost = (x, z, nx, nz, plates, { wearP = 1, postH = 2.5, wood = false } = {}) => {
    if (!free(x, z)) return false;
    const st = wear(wearP), g = G(x, z), yaw = faceYaw(nx, nz);
    if (st === 4) { if (R() < 0.6) box(g, trs(x, gy(x, z), z, yaw, 1, (R() - 0.5) * 0.3, (R() - 0.5) * 0.3), 0, 0.2, 0, 0.06, 0.4, 0.06, C.postDark, 'rust'); count('gone'); return true; }
    const M = frame(x, z, yaw, st), tot = plates.reduce((a, p) => a + p[2] + 0.06, 0), H = Math.max(postH, tot + 1.6);
    box(g, M, 0, H / 2, 0, wood ? 0.08 : 0.06, H, wood ? 0.08 : 0.06, wood ? C.wood : C.post, wood ? 'plain' : 'metal');
    let y = H - 0.02;
    for (const [shape, pw, ph, rk, o] of plates) { plate(g, M, shape, pw, ph, 0, y - ph / 2, 0.045, rk, o || {}); y -= ph + 0.06; }
    count('signs'); if (st) count('worn'); return true;
  };
  const right = (ux, uz) => [-uz, ux];
  const RAD = { main: 9, micro: 5.5, priv: 4, gravel: 3 };   // (roads' fillet radii: signs stand back of the corner apron)
  const holed = k => (R() < 0.4 ? k + 'H' : k);

  // ---- junctions: diamond on the main road, give way on the side street
  const diamonds = [];
  for (const j of plan.J) {
    const q = j.q, qsw = q.sw || 0;
    for (const a of j.apps) {   // side street approaches
      const r = j.r; if (r.sc === 'main') continue;
      const dist = q.w / 2 + Math.max(qsw, RAD[r.sc] || 3) + 1.5, [x0, z0, tx, tz] = at(r, a.s - a.dir * dist), ux = tx * a.dir, uz = tz * a.dir, [rx, rz] = right(ux, uz);
      const off = r.w / 2 + ((r.sw || 0) > 1 ? r.sw * 0.6 : 0.9), x = x0 + rx * off, z = z0 + rz * off;
      if (r.sc === 'priv' && R() < 0.35) continue;   // (private-sector lanes: often never signed)
      const stop = R() < 0.07;
      signPost(x, z, -ux, -uz, [stop ? ['oct', 0.7, 0.7, 'stop'] : ['itri', 0.9, 0.78, holed('give')]]);
    }
    for (const sd of [-1, 1]) {   // main-road diamonds, both directions, ~18 m before the junction
      if (R() < 0.3) continue;
      const [x0, z0, tx, tz] = at(q, j.s - sd * 18), ux = tx * sd, uz = tz * sd, [rx, rz] = right(ux, uz), off = q.w / 2 + (qsw > 1 ? qsw * 0.55 : 1.0), x = x0 + rx * off, z = z0 + rz * off;
      if (diamonds.some(d => Math.hypot(d[0] - x, d[1] - z) < 40 && d[2] * ux + d[3] * uz > 0.8)) continue;
      if (signPost(x, z, -ux, -uz, [['diamond', 0.62, 0.62, holed('diamond')]])) diamonds.push([x, z, ux, uz]);
    }
  }
  // ---- dead traffic lights at the central junction(s)
  const cx0 = kit.length ? kit.reduce((a, b) => a + b.x, 0) / kit.length : 0, cz0 = kit.length ? kit.reduce((a, b) => a + b.z, 0) / kit.length : 0;
  const tl = plan.J.filter(j => j.mm).sort((a, b) => Math.hypot(a.x - cx0, a.z - cz0) - Math.hypot(b.x - cx0, b.z - cz0)), tlUsed = [];
  for (const j of tl) {
    if (tlUsed.length >= lights || tlUsed.some(t => Math.hypot(t.x - j.x, t.z - j.z) < 150)) continue; tlUsed.push(j);
    let n = 0;
    for (const sd of [-1, 1]) {
      const q = j.q, [x0, z0, tx, tz] = at(q, j.s - sd * (j.r.w / 2 + 10)), ux = tx * sd, uz = tz * sd, [rx, rz] = right(ux, uz), off = q.w / 2 + 0.9, x = x0 + rx * off, z = z0 + rz * off;
      if (!free(x, z)) continue;
      const g = G(x, z), down = n === 0 && R() < 0.5, M = down ? trs(x, gy(x, z) + 0.12, z, faceYaw(-ux, -uz) + (R() - 0.5), 1, -1.52, 0) : frame(x, z, faceYaw(-ux, -uz), R() < 0.5 ? 0 : 1);
      box(g, M, 0, 1.7, 0, 0.12, 3.4, 0.12, C.postDark, 'metal');
      const hang = !down && R() < 0.35, HM = hang ? M.clone().multiply(trs(0, 3.35, 0.2, 0, 1, 0.6, 0.25)).multiply(new THREE.Matrix4().makeTranslation(0, -3.35, -0.2)) : M;
      box(g, HM, 0, 3.0, 0.2, 0.34, 0.98, 0.26, C.lightHead, 'metal');
      [[C.red, 3.3], [C.amber, 3.0], [C.green, 2.7]].forEach(([c, y]) => box(g, HM, 0, y, 0.34, 0.2, 0.2, 0.03, c, 'plain'));
      count('lights'); n++;
    }
  }
  // ---- zebra crossings: pedestrian-crossing squares both sides (double-sided), the faded paint as one instanced mesh
  const stripes = [], scol = [];
  for (const zc of plan.Z) {
    const [rx, rz] = right(zc.ux, zc.uz), hw = zc.w / 2;
    for (let o = -hw + 0.75; o <= hw - 0.5; o += 1.0) {
      const hsh = Math.abs(Math.sin((zc.x + o) * 12.9898 + zc.z * 78.233) * 43758.5453) % 1; if (hsh < 0.18) continue;
      const M = trs(zc.x + rx * o, 0.06, zc.z + rz * o, Math.atan2(-zc.uz, zc.ux)); M.multiply(new THREE.Matrix4().makeScale(3.6, 1, 0.5)); stripes.push(M); scol.push(0.45 + hsh * 0.55);
    }
    for (const sd of [-1, 1]) {
      const off = hw + (zc.sw > 1 ? 0.6 : 0.8), x = zc.x + rx * off * sd, z = zc.z + rz * off * sd;
      signPost(x, z, -zc.ux * sd, -zc.uz * sd, [['rect', 0.6, 0.6, holed('ped'), { double: true }]], { wearP: 0.7 });
    }
    count('zebras');
  }
  let zebraMesh = null;
  if (stripes.length) {
    const pg = new THREE.PlaneGeometry(1, 1); pg.rotateX(-Math.PI / 2);
    const im = new THREE.InstancedMesh(pg, new THREE.MeshStandardMaterial({ color: 0xd2cec2, roughness: 0.9, transparent: true, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), stripes.length);
    stripes.forEach((M, i) => { im.setMatrixAt(i, M); im.setColorAt(i, new THREE.Color(scol[i], scol[i], scol[i])); });
    im.computeBoundingSphere(); im.castShadow = false; im.receiveShadow = true; im.matrixAutoUpdate = false; im.name = 'zebra'; w.scene.add(im); zebraMesh = im;
  }
  // ---- bus stops: signs at the mapped stops, a few plain concrete shelters on the main roads
  const stops = [];
  for (const [px, pz] of busPois) {
    let best = null; for (const r of roads) if (r.sc === 'main' || r.sc === 'micro') { const p = project(r, px, pz); if (p.d < 25 && (!best || p.d < best.p.d)) best = { r, p }; }
    if (!best) continue; const { r, p } = best, sd = Math.sign((px - p.x) * -p.uz + (pz - p.z) * p.ux) || 1, [rx, rz] = right(p.ux * sd, p.uz * sd);
    const x = p.x + rx * (r.w / 2 + 0.6) - p.ux * sd * 5, z = p.z + rz * (r.w / 2 + 0.6) - p.uz * sd * 5;
    if (signPost(x, z, -p.ux * sd, -p.uz * sd, [['rect', 0.55, 0.55, 'bus'], ['rect', 0.3, 0.42, 'timetable']], { wearP: 0.6 })) stops.push([px, pz]);
  }
  if (shelters > 0) {
    const C2 = [];
    for (const r of roads) if (r.sc === 'main') for (let s = 30; s < r.len - 30; s += 14) for (const sd of [-1, 1]) {
      const [x0, z0, tx, tz] = at(r, s), ux = tx * sd, uz = tz * sd, [rx, rz] = right(ux, uz), off = r.w / 2 + Math.max(r.sw || 0, 0.8) + 1.15, x = x0 + rx * off, z = z0 + rz * off;
      if (Math.max(Math.abs(x), Math.abs(z)) > half - 40) continue;
      const near = kit.filter(b => Math.hypot(b.x - x, b.z - z) < 90).length; if (near < 2) continue;
      C2.push({ r, s, x, z, ux, uz, rx, rz, k: R() });
    }
    C2.sort((a, b) => a.k - b.k); let n = 0;
    for (const c of C2) {
      if (n >= shelters) break;
      if (stops.some(([a, b]) => Math.hypot(a - c.x, b - c.z) < 120) || plan.J.some(j => Math.hypot(j.x - c.x, j.z - c.z) < 30) || plan.Z.some(zc => Math.hypot(zc.x - c.x, zc.z - c.z) < 25)) continue;
      const yaw = faceYaw(-c.rx, -c.rz), pts = [[0, 0], [1.9, 0], [-1.9, 0], [1.9, -1.0], [-1.9, -1.0], [0, -1.1]].map(([a, b]) => [c.x + c.ux * a + c.rx * -b, c.z + c.uz * a + c.rz * -b]);
      if (!pts.every(([a, b]) => free(a, b, 0.4)) || w.solidHit?.(c.x + c.rx * 0.6, c.z + c.rz * 0.6, 2.1, 1.0, Math.atan2(-c.uz, c.ux), 0.2)) continue;
      const cxs = c.x + c.rx * 0.6, czs = c.z + c.rz * 0.6, y = gy(cxs, czs), g = G(cxs, czs), M = trs(cxs, y, czs, yaw), tint = col([0xb9b4aa, 0xc2b79c, 0xa9aeb0][n % 3]);
      box(g, M, 0, 1.15, -0.85, 3.8, 2.3, 0.16, tint, 'concrete');                                 // back wall (slab)
      for (const sx of [-1, 1]) if (!(n === 1 && sx > 0)) box(g, M, sx * 1.84, 1.15, -0.25, 0.14, 2.3, 1.3, tint, 'concrete');
      const RM = R() < 0.4 ? M.clone().multiply(trs(0, 0, 0, 0, 1, 0.06, (R() - 0.5) * 0.12)) : M;
      box(g, RM, 0, 2.38, -0.2, 4.2, 0.16, 2.0, tint, 'concrete', true);                          // roof slab
      box(g, M, 0, 0.45, -0.55, 2.8, 0.07, 0.38, C.wood, 'plain'); for (const sx of [-1.1, 1.1]) box(g, M, sx, 0.21, -0.55, 0.1, 0.42, 0.3, C.concrete, 'concrete');
      w.solidAdd?.(cxs, czs, 2.1, 1.0, Math.atan2(-c.uz, c.ux), 'shelter');
      const sx = cxs + c.ux * 3.2 + c.rx * 0.9, sz = czs + c.uz * 3.2 + c.rz * 0.9;
      signPost(sx, sz, -c.ux, -c.uz, [['rect', 0.55, 0.55, 'bus'], ['rect', 0.3, 0.42, 'timetable']], { wearP: 0.6 });
      count('shelters'); n++; stops.push([c.x, c.z]);
    }
  }
  // ---- town entry / exit
  for (const e of plan.E) {
    const r = e.r, [x0, z0, tx, tz] = at(r, e.s), ux = tx * e.dir, uz = tz * e.dir, [rx, rz] = right(ux, uz), off = r.w / 2 + Math.max(r.sw || 0, 0.8) * 0.6 + 0.6;
    if (town) {
      const two = (x, z, nx, nz, rk) => {
        if (!free(x, z) || !free(x + nz * 0.8, z - nx * 0.8)) return;
        const st = wear(0.8), g = G(x, z), M = st === 4 ? null : frame(x, z, faceYaw(nx, nz), Math.min(st, 3)); if (!M) return;
        for (const s of [-0.65, 0.65]) box(g, M, s, 1.2, 0, 0.06, 2.4, 0.06, C.post, 'metal');
        plate(g, M, 'rect', 1.7, 0.62, 0, 2.05, 0.045, rk); count('town');
      };
      two(x0 + rx * off, z0 + rz * off, -ux, -uz, 'entry');
      const [x1, z1] = at(r, e.s + e.dir * 6); two(x1 - rx * off, z1 - rz * off, ux, uz, 'exit');
    }
  }
  // ---- railway level crossings
  for (const c of plan.RX) {
    for (const sd of [-1, 1]) {
      const r = c.r, approach = s => { const [x, z, tx, tz] = at(r, c.s - sd * s); return [x, z, tx * sd, tz * sd]; };
      { // crossing light post: black / white bands, two red lamps on a bar, St Andrew's cross on top
        const [x0, z0, ux, uz] = approach(c.half + 2.5), [rx, rz] = right(ux, uz), off = r.w / 2 + 1.0, x = x0 + rx * off, z = z0 + rz * off;
        if (free(x, z)) {
          const st = Math.min(wear(0.8), 3), g = G(x, z), M = frame(x, z, faceYaw(-ux, -uz), st);
          for (let k = 0; k < 6; k++) box(g, M, 0, 0.22 + k * 0.44, 0, 0.11, 0.44, 0.11, k % 2 ? C.black : C.white, 'metal');
          box(g, M, 0, 2.2, 0.08, 0.9, 0.08, 0.06, C.black, 'plain');
          for (const s of [-0.38, 0.38]) { box(g, M, s, 2.2, 0.12, 0.24, 0.24, 0.12, C.black, 'plain'); box(g, M, s, 2.2, 0.19, 0.17, 0.17, 0.02, C.red, 'plain'); }
          for (const a of [-1, 1]) { const XM = M.clone().multiply(trs(0, 2.85, 0.08, 0, 1, 0, a * Math.PI / 4)); plate(g, XM, 'rect', 1.15, 0.17, 0, 0, 0.012 * a, 'stripes', { t: 0.02 }); }
          count('railLights');
        }
      }
      { // barrier: base housing, the striped arm raised, or broken off and lying on the verge
        const [x0, z0, ux, uz] = approach(c.half + 6), [rx, rz] = right(ux, uz), off = r.w / 2 + 0.9, x = x0 + rx * off, z = z0 + rz * off;
        if (free(x, z, 0.5)) {
          const g = G(x, z), M = trs(x, gy(x, z), z, faceYaw(-ux, -uz)), arm = r.w / 2 + 0.6, mode = R();
          box(g, M, 0, 0.55, 0, 0.42, 1.1, 0.42, col(0xd8d4c8), 'metal');
          if (mode < 0.45) { const AM = M.clone().multiply(trs(0, 1.0, 0.2, 0, 1, 0, Math.PI / 2 - 0.08 - R() * 0.1)); plate(g, AM, 'rect', arm, 0.1, arm / 2, 0, 0, 'stripes', { double: true, t: 0.08 }); }
          else if (mode < 0.85) { const AM = trs(x - ux * (arm / 2 + 0.6) + rx * (0.6 + R()), gy(x, z) + 0.05, z - uz * (arm / 2 + 0.6) + rz * (0.6 + R()), Math.atan2(-uz, ux) + (R() - 0.5) * 0.5, 1, -Math.PI / 2, 0); plate(g, AM, 'rect', arm * (0.5 + R() * 0.5), 0.1, 0, 0, 0, 'stripes', { double: true, t: 0.08 }); }
          count('barriers');
        }
      }
      for (const [k, s] of [['b1', 30], ['b2', 60], ['b3', 90]]) {   // countdown beacons
        if (c.s - sd * (c.half + s) < 0 || c.s - sd * (c.half + s) > r.len) continue;
        const [x0, z0, ux, uz] = approach(c.half + s), [rx, rz] = right(ux, uz), off = r.w / 2 + 1.4;
        if (plan.J.some(j => Math.hypot(j.x - x0, j.z - z0) < 18)) continue;
        signPost(x0 + rx * off, z0 + rz * off, -ux, -uz, [['rect', 0.25, 0.75, k, { double: true }]], { postH: 1.7, wearP: 0.6 });
      }
      if (sd > 0 && R() < 0.5) { const [x0, z0, ux, uz] = approach(c.half + 9), [rx, rz] = right(ux, uz); signPost(x0 + rx * (r.w / 2 + 1.0), z0 + rz * (r.w / 2 + 1.0), -ux, -uz, [['oct', 0.7, 0.7, 'stop']]); }
    }
    count('railCrossings');
  }
  // ---- street-name plates on the panel-block corners facing a named street
  const names = [];
  if (plates) {
    const tidy = n => { let s = n.trim(); for (const [a, b] of [['вулиця', 'вул.'], ['проспект', 'просп.'], ['провулок', 'пров.'], ['площа', 'пл.']]) if (s.toLowerCase().includes(a)) { s = b + ' ' + s.replace(new RegExp(a, 'i'), '').replace(/\s+/g, ' ').trim(); break; } return s; };
    const hits = [];
    for (const b of kit) {
      if (b.ruined && R() < 0.6) continue;
      let best = null; for (const r of roads) if (r.name && r.sc !== 'drive' && r.sc !== 'track') { const p = project(r, b.x, b.z); const lim = Math.max(b.L, b.D) / 2 + 22; if (p.d < lim && (!best || p.d < best.p.d)) best = { r, p }; }
      if (best) hits.push({ b, ...best, nm: tidy(best.r.name) });
    }
    const freq = new Map(); for (const h of hits) freq.set(h.nm, (freq.get(h.nm) || 0) + 1);
    names.push(...[...freq.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4).map(e => e[0]));
    for (const h of hits) {
      const k = names.indexOf(h.nm); if (k < 0 || R() < 0.35) continue;
      const b = h.b, tx = h.p.x - b.x, tz = h.p.z - b.z;
      const faces = [[b.sin, b.cos, b.D / 2, b.L], [-b.sin, -b.cos, b.D / 2, b.L], [b.cos, -b.sin, b.L / 2, b.D], [-b.cos, b.sin, b.L / 2, b.D]];
      faces.sort((f1, f2) => (f2[0] * tx + f2[1] * tz) - (f1[0] * tx + f1[1] * tz));
      const [nx, nz, dd, fl] = faces[0], ax = -nz, az = nx, along = (fl / 2 - 0.9) * (R() < 0.5 ? -1 : 1);
      const x = b.x + nx * (dd + 0.1) + ax * along, z = b.z + nz * (dd + 0.1) + az * along, g = G(x, z);
      const M = trs(x, gy(b.x, b.z) + 2.75, z, faceYaw(nx, nz), 1, 0, (R() - 0.5) * 0.08);
      plate(g, M, 'rect', 0.66, 0.2, 0, 0, 0, 'plate' + k, { t: 0.02 }); count('plates');
    }
  }
  // ---- meshes: one per map third, distance-culled, static shadow cache
  const mat = atlas(town, names), meshes = [];
  for (const [k, g] of chunks) {
    if (!g.i.length) continue;
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(g.p, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.n, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.u, 2)); geo.setAttribute('color', new THREE.Float32BufferAttribute(g.c, 3)); geo.setIndex(g.nv > 65535 ? new THREE.Uint32BufferAttribute(g.i, 1) : new THREE.Uint16BufferAttribute(g.i, 1));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mat); m.name = 'street_furniture'; m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false; m.visible = false; w.scene.add(m); markStatic(m); meshes.push(m);
    const sph = geo.boundingSphere;
    LODS.push({ near: [m], mid: null, far: [], cx: sph.center.x, cz: sph.center.z, dm: 330, d1: 330, d2: 330, state: -1, hr: Math.min(sph.radius, CH * 0.75) });
  }
  stats.meshes = meshes.length; stats.tris = meshes.reduce((a, m) => a + m.geometry.index.count / 3, 0); stats.zebraStripes = stripes.length;
  return { stats, meshes, zebraMesh };
}
