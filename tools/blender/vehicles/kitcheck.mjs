// Headless kit checker (node, no GPU / Blender; same method and thresholds as vcheck.py's kit checks) for
// src/game/vehicleKit.js on every vehicle GLB, in several poses (kits are built in the straight pose, as in the game,
// then the vehicle is posed): straight, turret +-90 deg, gun at max elevation / max depression, all hatches + doors open.
//  * floating: kit parts (welded connected components) not touching (<= 1.2 cm) the vehicle or a touching kit part
//  * clip: kit vertices inside vehicle solids deeper than 2 cm (parity of +y / -y / +x rays + nearest-surface distance),
//          and moving vehicle parts (gun, hatch lids, doors) whose edges cross kit triangles
// Usage: node tools/blender/vehicles/kitcheck.mjs [out.json] [vehicle ...]    (default: all vehicles, kit set per kind)
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { loadGlb, pose, KK, kindOf } from './kitnode.mjs';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const KIT = process.env.KITSRC ? path.resolve(process.env.KITSRC) : path.join(root, 'src/game/vehicleKit.js');
const { attachKits } = await import(KIT);
const man = JSON.parse(fs.readFileSync(path.join(root, 'assets/vehicles/manifest.json'), 'utf8')).vehicles;
const TOUCH = 0.012, DEPTH = 0.02;

function soup(items) {   // world-space triangles of mesh items -> {T, n, owner}
  const tris = [], own = []; const v = new THREE.Vector3();
  for (const [o, tag] of items) { const pa = o.geometry.attributes.position, ix = o.geometry.index, n = ix ? ix.count : pa.count; const P = []; for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld); P.push(v.x, v.y, v.z); } for (let i = 0; i + 2 < n; i += 3) { for (let k = 0; k < 3; k++) { const j = ix ? ix.getX(i + k) : i + k; tris.push(P[j * 3], P[j * 3 + 1], P[j * 3 + 2]); } own.push(tag); } }
  return bvh(new Float32Array(tris), own);
}
function bvh(T, own) {
  const nt = T.length / 9, ord = Array.from({ length: nt }, (_, i) => i), lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < T.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k], T[i]); hi[k] = Math.max(hi[k], T[i]); }
  const sp = x => { x &= 1023; x = (x | (x << 16)) & 0x030000FF; x = (x | (x << 8)) & 0x0300F00F; x = (x | (x << 4)) & 0x030C30C3; return (x | (x << 2)) & 0x09249249; };
  const code = ord.map(t => { let c = 0; for (let k = 0; k < 3; k++) c |= sp(Math.floor(((T[t * 9 + k] + T[t * 9 + 3 + k] + T[t * 9 + 6 + k]) / 3 - lo[k]) / (hi[k] - lo[k] + 1e-6) * 1023)) << k; return c; });
  ord.sort((a, b) => code[a] - code[b]);
  const CH = 16, nc = Math.ceil(nt / CH), B = new Float32Array(nc * 6);
  for (let c = 0; c < nc; c++) { const b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9]; for (let i = c * CH; i < Math.min(nt, c * CH + CH); i++) for (let q = 0; q < 9; q++) { const x = T[ord[i] * 9 + q], k = q % 3; if (x < b[k]) b[k] = x; if (x > b[3 + k]) b[3 + k] = x; } B.set(b, c * 6); }
  return { T, own, ord, B, nc, nt, CH };
}
function cpTri(p, a, b, c) {   // closest point on triangle (Ericson)
  const ab = b.clone().sub(a), ac = c.clone().sub(a), ap = p.clone().sub(a), d1 = ab.dot(ap), d2 = ac.dot(ap); if (d1 <= 0 && d2 <= 0) return a.clone();
  const bp = p.clone().sub(b), d3 = ab.dot(bp), d4 = ac.dot(bp); if (d3 >= 0 && d4 <= d3) return b.clone();
  const vc = d1 * d4 - d3 * d2; if (vc <= 0 && d1 >= 0 && d3 <= 0) return a.clone().add(ab.multiplyScalar(d1 / (d1 - d3)));
  const cp = p.clone().sub(c), d5 = ab.dot(cp), d6 = ac.dot(cp); if (d6 >= 0 && d5 <= d6) return c.clone();
  const vb = d5 * d2 - d1 * d6; if (vb <= 0 && d2 >= 0 && d6 <= 0) return a.clone().add(ac.multiplyScalar(d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4; if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return b.clone().add(c.clone().sub(b).multiplyScalar((d4 - d3) / ((d4 - d3) + (d5 - d6))));
  const den = 1 / (va + vb + vc); return a.clone().add(ab.multiplyScalar(vb * den)).add(ac.multiplyScalar(vc * den));
}
const tv = (S, t, q) => new THREE.Vector3(S.T[t * 9 + q * 3], S.T[t * 9 + q * 3 + 1], S.T[t * 9 + q * 3 + 2]);
function nearest(S, p, maxD, filter) {   // {d, t, q(point)} within maxD
  let best = { d: maxD, t: -1, q: null };
  for (let c = 0; c < S.nc; c++) {
    const j = c * 6, dx = Math.max(S.B[j] - p.x, 0, p.x - S.B[j + 3]), dy = Math.max(S.B[j + 1] - p.y, 0, p.y - S.B[j + 4]), dz = Math.max(S.B[j + 2] - p.z, 0, p.z - S.B[j + 5]);
    if (dx * dx + dy * dy + dz * dz > best.d * best.d) continue;
    for (let i = c * S.CH; i < Math.min(S.nt, c * S.CH + S.CH); i++) { const t = S.ord[i]; if (filter && !filter(S.own[t])) continue; const q = cpTri(p, tv(S, t, 0), tv(S, t, 1), tv(S, t, 2)), d = q.distanceTo(p); if (d < best.d) best = { d, t, q }; }
  }
  return best;
}
function hits(S, o, d, far, filter) {   // all ray hit distances
  const out = [], ix = 1 / (d.x || 1e-12), iy = 1 / (d.y || 1e-12), iz = 1 / (d.z || 1e-12);
  for (let c = 0; c < S.nc; c++) {
    const j = c * 6; let t0 = (S.B[j] - o.x) * ix, t1 = (S.B[j + 3] - o.x) * ix; if (t0 > t1) [t0, t1] = [t1, t0];
    let u0 = (S.B[j + 1] - o.y) * iy, u1 = (S.B[j + 4] - o.y) * iy; if (u0 > u1) [u0, u1] = [u1, u0]; t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
    u0 = (S.B[j + 2] - o.z) * iz; u1 = (S.B[j + 5] - o.z) * iz; if (u0 > u1) [u0, u1] = [u1, u0]; t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
    if (t1 < Math.max(t0, 0) || t0 > far) continue;
    for (let i = c * S.CH; i < Math.min(S.nt, c * S.CH + S.CH); i++) {
      const t = S.ord[i]; if (filter && !filter(S.own[t])) continue; const k = t * 9, T = S.T;
      const e1 = [T[k + 3] - T[k], T[k + 4] - T[k + 1], T[k + 5] - T[k + 2]], e2 = [T[k + 6] - T[k], T[k + 7] - T[k + 1], T[k + 8] - T[k + 2]];
      const px = d.y * e2[2] - d.z * e2[1], py = d.z * e2[0] - d.x * e2[2], pz = d.x * e2[1] - d.y * e2[0], det = e1[0] * px + e1[1] * py + e1[2] * pz; if (Math.abs(det) < 1e-12) continue;
      const id = 1 / det, sx = o.x - T[k], sy = o.y - T[k + 1], sz = o.z - T[k + 2], u = (sx * px + sy * py + sz * pz) * id; if (u < 0 || u > 1) continue;
      const qx = sy * e1[2] - sz * e1[1], qy = sz * e1[0] - sx * e1[2], qz = sx * e1[1] - sy * e1[0], w = (d.x * qx + d.y * qy + d.z * qz) * id; if (w < 0 || u + w > 1) continue;
      const tt = (e2[0] * qx + e2[1] * qy + e2[2] * qz) * id; if (tt > 1e-6 && tt < far) out.push(tt);
    }
  }
  return out;
}
function groupOf(o, scene) {
  let g = 'hull'; const names = []; for (let p = o; p && p !== scene; p = p.parent) names.push(p.name);
  for (const n of names) { if (/^hatch_lid_/.test(n) && !/_geo$/.test(n)) return 'lid:' + n; if (/^(door_|tailgate$|ramp$|roof_door|cab_door)/.test(n) && !/_geo$|_glass$/.test(n)) return 'door:' + n; }
  if (names.includes('gun_pivot')) return 'gun'; if (names.includes('turret')) g = 'turret';
  for (const n of names) if (/^(wheel_|roadwheel_|sprocket_|idler_|track_|steer_)/.test(n)) return 'gear';
  return g;
}
function components(o) {   // welded connected components of a kit mesh: arrays of world vertices
  const pa = o.geometry.attributes.position, n = pa.count, key = new Map(), id = new Int32Array(n), v = new THREE.Vector3(), W = [];
  for (let i = 0; i < n; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld); const k = `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`; if (!key.has(k)) { key.set(k, key.size); W.push(v.clone()); } id[i] = key.get(k); }
  const par = Array.from({ length: key.size }, (_, i) => i), f = a => { while (par[a] !== a) a = par[a] = par[par[a]]; return a; };
  for (let i = 0; i + 2 < n; i += 3) { const a = f(id[i]), b = f(id[i + 1]), c = f(id[i + 2]); par[a] = b; par[f(c)] = b; }
  const comps = new Map(); for (let i = 0; i < W.length; i++) { const r = f(i); if (!comps.has(r)) comps.set(r, { verts: [], tris: [] }); comps.get(r).verts.push(W[i]); }
  for (let i = 0; i + 2 < n; i += 3) { const c = comps.get(f(id[i])); for (let k = 0; k < 3; k++) { const w = W[id[i + k]]; c.tris.push(w.x, w.y, w.z); } }
  return [...comps.values()];
}
function check(vn, posing) {
  const V = man[vn], kind = kindOf(V), kits = (process.env.KITS || KK[kind]).split(',');
  const scene = loadGlb(path.join(root, V.file)); pose(scene, V, {});
  attachKits(scene, kits, { wheeled: !!V.wheeled || V.kind === 'btr', kind });
  pose(scene, V, posing);
  const veh = [], kitm = [];
  scene.traverse(o => { if (!o.isMesh) return; for (let p = o; p; p = p.parent) { if (!p.visible || /_LOD1$|_wreck$/.test(p.name)) return; } (o.userData.kit ? kitm : veh).push(o); });
  const VS = soup(veh.map(o => [o, groupOf(o, scene)]));
  const rep = { floating: [], clips: [], crossings: [] };
  // floating: components touching the vehicle, then kit-kit contacts transitively
  const comps = []; for (const o of kitm) for (const c of components(o)) comps.push({ mesh: o.name, kitParent: o.parent.name, verts: c.verts, tris: c.tris, ok: false });
  for (const c of comps) { const step = Math.max(1, Math.floor(c.verts.length / 300)); for (let i = 0; i < c.verts.length && !c.ok; i += step) if (nearest(VS, c.verts[i], TOUCH).t >= 0) c.ok = true; }
  for (const c of comps) if (!c.ok) { const b = new THREE.Box3().setFromPoints(c.verts).expandByScalar(TOUCH), cS = c.S ||= soupFromVerts(c); for (let t = 0; t < VS.nt && !c.ok; t++) for (let q = 0; q < 3; q++) { const p = tv(VS, t, q); if (b.containsPoint(p) && nearest(cS, p, TOUCH).t >= 0) { c.ok = true; break; } } }
  for (let changed = true; changed;) {
    changed = false; const grounded = comps.filter(c => c.ok);
    for (const c of comps) {
      if (c.ok) continue; const lo = new THREE.Box3().setFromPoints(c.verts).expandByScalar(TOUCH);
      for (const g of grounded) { const gb = g.box ||= new THREE.Box3().setFromPoints(g.verts); if (!gb.intersectsBox(lo)) continue; const gS = g.S ||= soupFromVerts(g); const step = Math.max(1, Math.floor(c.verts.length / 200)); for (let i = 0; i < c.verts.length; i += step) if (nearest(gS, c.verts[i], TOUCH).t >= 0) { c.ok = true; changed = true; break; } if (!c.ok) { const cS = c.S ||= soupFromVerts(c), st2 = Math.max(1, Math.floor(g.verts.length / 300)); for (let i = 0; i < g.verts.length; i += st2) if (lo.containsPoint(g.verts[i]) && nearest(cS, g.verts[i], TOUCH).t >= 0) { c.ok = true; changed = true; break; } } if (c.ok) break; }
    }
  }
  for (const c of comps) if (!c.ok) { const b = new THREE.Box3().setFromPoints(c.verts); const ctr = b.getCenter(new THREE.Vector3()); const step = Math.max(1, Math.floor(c.verts.length / 100)); let gap = 9; for (let i = 0; i < c.verts.length; i += step) gap = Math.min(gap, nearest(VS, c.verts[i], 1).d); rep.floating.push({ mesh: c.mesh, gap_m: +gap.toFixed(3), at: ctr.toArray().map(x => +x.toFixed(2)), size: b.getSize(new THREE.Vector3()).toArray().map(x => +x.toFixed(2)) }); }
  // clips: kit vertices deep inside vehicle solids (groups other than the kit's own parent for turret kits? all groups)
  const dirs = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0)];
  const byMesh = {};
  for (const o of kitm) {
    const pa = o.geometry.attributes.position, v = new THREE.Vector3(), step = Math.max(1, Math.floor(pa.count / 2500));
    for (let i = 0; i < pa.count; i += step) {
      v.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld); const nr = nearest(VS, v, 0.6); if (nr.t < 0 || nr.d < DEPTH) continue;
      const g = VS.own[nr.t]; const f = x => x === g;
      if (dirs.every(d => hits(VS, v, d, 20, f).length % 2 === 1)) { const k = o.name + ' > ' + g; const r = byMesh[k] ||= { kit: o.name, into: g, verts: 0, max_depth_m: 0, at: null }; r.verts++; if (nr.d > r.max_depth_m) { r.max_depth_m = +nr.d.toFixed(3); r.at = v.toArray().map(x => +x.toFixed(2)); } }
    }
  }
  rep.clips = Object.values(byMesh).filter(r => r.verts >= 3);
  // crossings: edges of moving parts (gun, lids, doors) through kit triangles
  const KS = soup(kitm.map(o => [o, o.name]));
  for (const o of veh) {
    const g = groupOf(o, scene); if (!/^(gun|lid:|door:)/.test(g)) continue;
    const pa = o.geometry.attributes.position, ix = o.geometry.index, n = ix ? ix.count : pa.count, a = new THREE.Vector3(), b = new THREE.Vector3(); let cnt = 0, kitHit = null;
    for (let i = 0; i + 2 < n; i += 3) for (let k = 0; k < 3; k++) {
      const i0 = ix ? ix.getX(i + k) : i + k, i1 = ix ? ix.getX(i + (k + 1) % 3) : i + (k + 1) % 3;
      a.fromBufferAttribute(pa, i0).applyMatrix4(o.matrixWorld); b.fromBufferAttribute(pa, i1).applyMatrix4(o.matrixWorld);
      const d = b.clone().sub(a), L = d.length(); if (L < 1e-4) continue; d.divideScalar(L);
      const h = hits(KS, a, d, L); if (h.length) { cnt++; kitHit = a.clone(); }
    }
    if (cnt >= 2) rep.crossings.push({ part: g, edges: cnt, at: kitHit.toArray().map(x => +x.toFixed(2)) });
  }
  return rep;
}
function soupFromVerts(c) { return bvh(new Float32Array(c.tris), new Array(c.tris.length / 9).fill('kit')); }

const args = process.argv.slice(2), out = args[0] && args[0].endsWith('.json') ? args.shift() : null;
const VS_ = args.length ? args : ['btr82a', 'btr80_ua', 't72b3', 't72av_ua', 'bmp3', 'bradley_ua', 'msta_s', 'bohdana'];
const POSES = { straight: {}, turret_L90: { rot: 'turret:y:90' }, turret_R90: { rot: 'turret:y:-90' }, gun_up: { rot: 'gun_pivot:x:-1' }, gun_down: { rot: 'gun_pivot:x:1' }, hatches_open: { open: 1 } };
const all = {};
for (const vn of VS_) {
  const V = man[vn], lim = V.gun_limits_deg || {}, kind = kindOf(V);
  const up = lim.max ?? lim.elevation?.[1] ?? { tank: 14, btr: 60, ifv: 60, spg: 65 }[kind], dn = lim.min ?? lim.elevation?.[0] ?? { tank: -6, btr: -5, ifv: -5, spg: -3 }[kind];
  all[vn] = {};
  for (const [pn, ps] of Object.entries(POSES)) {
    const p = { ...ps }; if (pn === 'gun_up') p.rot = `gun_pivot:x:${-Math.abs(up)}`; if (pn === 'gun_down') p.rot = `gun_pivot:x:${Math.abs(dn)}`;
    if (pn.startsWith('turret') && !man[vn].hierarchy?.includes?.('turret') && vn === 'pickup') continue;
    const r = check(vn, p); all[vn][pn] = r;
    console.log(vn.padEnd(11), pn.padEnd(13), `floating ${r.floating.length}  clips ${r.clips.length}  crossings ${r.crossings.length}`, r.floating.slice(0, 3).map(f => `${f.mesh}@${f.at}(${f.gap_m})`).join(' '), r.clips.slice(0, 3).map(c => `${c.kit}>${c.into}:${c.verts}v/${c.max_depth_m}m@${c.at}`).join(' '), r.crossings.slice(0, 3).map(c => `${c.part}x${c.edges}@${c.at}`).join(' '));
  }
}
if (out) fs.writeFileSync(out, JSON.stringify(all, null, 1));
