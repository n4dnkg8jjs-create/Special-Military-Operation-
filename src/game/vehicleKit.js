// Vehicle upgrade kits: visible field modifications on the battle vehicles (and in the campaign tech tree's 3D
// preview) for the upgrades the player's brigade has received (src/campaign/v2/tech.js KITS):
//   cage     welded anti-drone screen over the turret: tube posts welded (weld plates) to the real turret roof / side
//            found by ray casts, a top frame that follows the turret outline, a sagging chain-link screen with framed
//            openings over the hatches (and the jammer), a slot over the gun on high-elevation guns (BTR / IFV / SPG),
//            chain-link curtains on the sides and rear. On hulls that already carry a cage in the model (T-72B3,
//            BMP-3, Msta-S) chain-link curtains are hung from that cage's own top rim instead.
//   roof     full-length screen over the engine deck (tanks): posts welded to the fenders outside the turret sweep
//   era      Kontakt-1 style bricks (tanks) / Kaktus-BRAT style tiles (IFVs) in rows on the glacis plane and in rows
//            round the turret cheeks on wedge brackets
//   sandbags sandbags on the hull sides behind a welded rail (wheeled) / spare track links on the glacis and the turret
//            sides (tracked)
//   sight    armoured thermal-sight head on a plinth on the gunner's side of the turret roof
//   ew       jammer box on a welded tube stand with a ring of whip antennas
//   smoke    902-type launcher clusters on brackets welded to the turret sides
//   crew     (no visual)
// Geometry is procedural, sized per vehicle from the model's own meshes by ray casts (every foot is placed on the hit
// surface and sunk 1 cm into it, so nothing floats), and built in the local space of the `hull` / `turret` EMPTIES:
// turret kits traverse with the turret, everything hides with the intact hull for the wreck, and the LOD lists and
// hatch-lid / door nodes are never touched. Built geometry is cached per GLB + kit set (clones share it).
// Battle effects: applyKitFx (cage chance, ERA, side armour, sight, smoke, mobility).
// Checked by tools/blender/vehicles/vcheck.py (kits=1 exports, turret / gun / hatch poses): previews/vehicles_v6.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KITS } from '../campaign/v2/tech.js';

const SKIP = /_LOD1$|_wreck$|antenna|aerial/i;
const GEAR = /^(wheel_|roadwheel_|sprocket_|idler_|track_|return_|steer_)/i;

// ---------------------------------------------------------------- materials (shared; textures drawn once)
let MATS = null;
function canvasTex(size, draw, repeat = true) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d'); draw(g, size);
  const t = new THREE.CanvasTexture(c); if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; t.colorSpace = THREE.SRGBColorSpace; return t;
}
function mats() {
  if (MATS) return MATS;
  const M = (color, rough = 0.85, metal = 0.25, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
  // chain-link: diamond wire mesh, 1 texture tile = 2 x 2 diamonds; alpha-tested, galvanised wire with rust
  const chain = canvasTex(128, (g, s) => {
    g.clearRect(0, 0, s, s); g.lineCap = 'round';
    for (const [w, col] of [[7, 'rgba(70,62,48,1)'], [4, 'rgba(150,146,132,1)']]) {
      g.strokeStyle = col; g.lineWidth = w;
      for (let k = -2; k <= 2; k++) { g.beginPath(); g.moveTo(k * s / 2, 0); g.lineTo(k * s / 2 + s, s); g.stroke(); g.beginPath(); g.moveTo(k * s / 2 + s, 0); g.lineTo(k * s / 2, s); g.stroke(); }
    }
    g.fillStyle = 'rgba(120,70,35,0.55)'; for (let i = 0; i < 40; i++) { g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 2 + Math.random() * 3, 0, 7); g.fill(); }
  });
  // welded square mesh (roof screens): 4 x 4 cells per tile
  const weld = canvasTex(128, (g, s) => {
    g.clearRect(0, 0, s, s); g.strokeStyle = 'rgba(92,88,74,1)'; g.lineWidth = 5;
    for (let i = 0; i <= 4; i++) { const p = i * s / 4; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.stroke(); g.beginPath(); g.moveTo(0, p); g.lineTo(s, p); g.stroke(); }
    g.fillStyle = 'rgba(115,68,36,0.6)'; for (let i = 0; i < 30; i++) { g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 2 + Math.random() * 3, 0, 7); g.fill(); }
  });
  // sandbag weave
  const sack = canvasTex(64, (g, s) => { g.fillStyle = '#9a8c66'; g.fillRect(0, 0, s, s); g.strokeStyle = 'rgba(60,50,30,.35)'; g.lineWidth = 1; for (let i = 0; i < s; i += 3) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.stroke(); g.beginPath(); g.moveTo(0, i + 1); g.lineTo(s, i + 1); g.stroke(); } for (let i = 0; i < 25; i++) { g.fillStyle = `rgba(70,55,35,${Math.random() * 0.25})`; g.fillRect(Math.random() * s, Math.random() * s, 6, 4); } });
  // the game renders without MSAA (src/engine/renderer.js): alpha-blended so the wire mesh is crisp up close and fades to
  // a light veil in the distant mip levels (an alpha-tested mesh would vanish or turn into a solid sheet)
  const screen = (map, color) => M(color, 0.65, 0.55, { side: THREE.DoubleSide, transparent: true, depthWrite: false, ...(map ? { map, alphaTest: 0.04 } : { opacity: 0.6 }) });
  MATS = {
    steel: M(0x4a4636, 0.7, 0.45), weld: M(0x2e2c24, 0.8, 0.4), chain: screen(chain, 0xb4b0a0), weldmesh: screen(weld, 0xa8a490),
    era: M(0xffffff, 0.72, 0.25, { vertexColors: true }), bag: M(0xffffff, 1, 0, { vertexColors: true, ...(sack ? { map: sack } : {}) }),
    link: M(0x3a3832, 0.6, 0.65), box: M(0x434833, 0.7, 0.3), glass: M(0x0b0d10, 0.12, 0.7), black: M(0x161616, 0.6, 0.2), cable: M(0x1d1d1a, 0.9, 0),
  };
  for (const k of Object.keys(MATS)) MATS[k].name = 'kit_' + k;
  return MATS;
}

// ---------------------------------------------------------------- measuring the model
// meshes under `node` (LOD0, intact: not under a *_LOD1 / *_wreck / hidden group — by name, not by .visible, which
// the LOD switch toggles), stopping at subtrees `stop` rejects
function under(node, stop) { const out = []; node?.traverse(o => { if (!o.isMesh || o.userData?.kit) return; let p = o; while (p && p !== node) { if (stop(p) || SKIP.test(p.name) || p.userData?.hidden) return; p = p.parent; } out.push(o); }); return out; }
function pointsIn(meshes, space, max = 1500) {
  const inv = new THREE.Matrix4().copy(space.matrixWorld).invert(), v = new THREE.Vector3(), xs = [], ys = [], zs = [];
  for (const o of meshes) { const pa = o.geometry.attributes.position, step = Math.max(1, Math.floor(pa.count / max)); const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld); for (let i = 0; i < pa.count; i += step) { v.fromBufferAttribute(pa, i).applyMatrix4(m); xs.push(v.x); ys.push(v.y); zs.push(v.z); } }
  const sorted = [xs, ys, zs].map(a => [...a].sort((p, r) => p - r));
  const q = (a, f) => { if (!a.length) return 0; return a[Math.floor(f * (a.length - 1))]; };
  return { n: xs.length, xs, ys, zs, q: (axis, f) => q(sorted[axis === 'x' ? 0 : axis === 'y' ? 1 : 2], f) };
}
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V3(0, 1, 0);
// ray casts in node-local space against a node's meshes: a one-level BVH (Morton-sorted chunks of 32 triangles with
// boxes) built once per mesh list, ~20x faster than THREE.Raycaster on these 20-90k triangle models
const CASTERS = new WeakMap();
function caster(meshes, space) {
  let C = CASTERS.get(meshes); if (C) return C;
  const inv = new THREE.Matrix4().copy(space.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3(), tris = [];
  for (const o of meshes) {
    m.multiplyMatrices(inv, o.matrixWorld); const pa = o.geometry.attributes.position, ix = o.geometry.index, n = ix ? ix.count : pa.count;
    const P = new Float32Array(pa.count * 3); for (let i = 0; i < pa.count; i++) { v.fromBufferAttribute(pa, i).applyMatrix4(m); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; }
    for (let i = 0; i + 2 < n; i += 3) for (let k = 0; k < 3; k++) { const j = ix ? ix.getX(i + k) : i + k; tris.push(P[j * 3], P[j * 3 + 1], P[j * 3 + 2]); }
  }
  const nt = tris.length / 9, T = new Float32Array(tris); let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < nt * 3; i++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], T[i * 3 + k]); hi[k] = Math.max(hi[k], T[i * 3 + k]); }
  const spread = x => { x &= 1023; x = (x | (x << 16)) & 0x030000FF; x = (x | (x << 8)) & 0x0300F00F; x = (x | (x << 4)) & 0x030C30C3; return (x | (x << 2)) & 0x09249249; };
  const code = new Float64Array(nt), ord = new Uint32Array(nt);
  for (let t = 0; t < nt; t++) { ord[t] = t; let c = 0; for (let k = 0; k < 3; k++) { const cc = (T[t * 9 + k] + T[t * 9 + 3 + k] + T[t * 9 + 6 + k]) / 3; c |= spread(Math.floor((cc - lo[k]) / (hi[k] - lo[k] + 1e-6) * 1023)) << k; } code[t] = c; }
  ord.sort((a, b) => code[a] - code[b]);
  const CH = 32, nc = Math.ceil(nt / CH), B = new Float32Array(nc * 6);
  for (let c = 0; c < nc; c++) { const b = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9]; for (let i = c * CH; i < Math.min(nt, c * CH + CH); i++) { const t = ord[i]; for (let q = 0; q < 3; q++) for (let k = 0; k < 3; k++) { const x = T[t * 9 + q * 3 + k]; if (x < b[k]) b[k] = x; if (x > b[3 + k]) b[3 + k] = x; } } B.set(b, c * 6); }
  C = (o, d, far) => {
    const ix = 1 / (d.x || 1e-12), iy = 1 / (d.y || 1e-12), iz = 1 / (d.z || 1e-12); let best = far, bt = -1;
    for (let c = 0; c < nc; c++) {
      const j = c * 6; let t0 = (B[j] - o.x) * ix, t1 = (B[j + 3] - o.x) * ix; if (t0 > t1) [t0, t1] = [t1, t0];
      let u0 = (B[j + 1] - o.y) * iy, u1 = (B[j + 4] - o.y) * iy; if (u0 > u1) [u0, u1] = [u1, u0]; t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
      u0 = (B[j + 2] - o.z) * iz; u1 = (B[j + 5] - o.z) * iz; if (u0 > u1) [u0, u1] = [u1, u0]; t0 = Math.max(t0, u0); t1 = Math.min(t1, u1);
      if (t1 < Math.max(t0, 0) || t0 > best) continue;
      for (let i = c * CH; i < Math.min(nt, c * CH + CH); i++) {
        const k = ord[i] * 9, ax = T[k], ay = T[k + 1], az = T[k + 2], e1x = T[k + 3] - ax, e1y = T[k + 4] - ay, e1z = T[k + 5] - az, e2x = T[k + 6] - ax, e2y = T[k + 7] - ay, e2z = T[k + 8] - az;
        const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x, det = e1x * px + e1y * py + e1z * pz; if (Math.abs(det) < 1e-12) continue;
        const id = 1 / det, sx = o.x - ax, sy = o.y - ay, sz = o.z - az, u = (sx * px + sy * py + sz * pz) * id; if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, w = (d.x * qx + d.y * qy + d.z * qz) * id; if (w < 0 || u + w > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * id; if (t > 1e-5 && t < best) { best = t; bt = ord[i]; }
      }
    }
    if (bt < 0) return null;
    const k = bt * 9, n = new THREE.Vector3(T[k + 3] - T[k], T[k + 4] - T[k + 1], T[k + 5] - T[k + 2]).cross(new THREE.Vector3(T[k + 6] - T[k], T[k + 7] - T[k + 1], T[k + 8] - T[k + 2])).normalize();
    return { t: best, n };
  };
  CASTERS.set(meshes, C); return C;
}
function cast(meshes, space, from, dir, far = 20) {
  const d = dir.clone().normalize(), h = caster(meshes, space)(from, d, far); if (!h) return null;
  if (h.n.dot(d) > 0) h.n.negate();
  return { p: from.clone().add(d.multiplyScalar(h.t)), n: h.n, dist: h.t };
}
const down = (S, x, z, from) => cast(S.meshes, S.node, V3(x, from, z), V3(0, -1, 0));
export function _survey(M, S) { return survey(M, S); }
export function measure(model) {
  model.updateMatrixWorld(true);
  const N = n => model.getObjectByName(n);
  const hull = N('hull') || model, turret = N('turret'), gun = N('gun_pivot');
  const cageMesh = N('cope_cage');
  const hullMeshes = under(hull, p => p === turret || GEAR.test(p.name) || /cope_cage|hatch_lid|door|ramp|tailgate|stretcher/i.test(p.name));
  const turMeshes = turret ? under(turret, p => p === gun || /cope_cage|hatch_lid/i.test(p.name)) : [];
  const H = pointsIn(hullMeshes, hull), T = turret ? pointsIn(turMeshes, turret) : null;
  const gunMeshes = gun ? under(gun, () => false) : [];
  const M = { model, hull, turret, gun, hullMeshes, turMeshes, gunMeshes, H, T, hasCage: !!cageMesh && cageMesh.visible !== false, cageNode: cageMesh };
  M.TS = turret && T?.n > 20 ? { node: turret, P: T, meshes: turMeshes, isTurret: true } : { node: hull, P: H, meshes: hullMeshes, isTurret: false };
  // hatches in each node's space: rim empties hatch_<role> + the lid size
  const hatches = (node) => { const out = [], inv = new THREE.Matrix4().copy(node.matrixWorld).invert(); model.traverse(o => { const m = /^hatch_(?!lid)([a-z_A-Z0-9]+)$/.exec(o.name); if (!m) return; let p = o.parent; while (p && p !== hull && p !== turret) p = p.parent; if (p !== node) return; const w = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(inv); const lid = N('hatch_lid_' + m[1]); let r = 0.33, rect = null;
    if (lid) {
      // closed lid footprint + the hinge side grown by 0.25 m (an opened lid leans past its hinge line)
      const lm = []; lid.traverse(o => { if (o.isMesh && !/_LOD1$/.test(o.name)) lm.push(o); }); const L = pointsIn(lm, node, 600);
      if (L.n > 8) {
        const hp = new THREE.Vector3().setFromMatrixPosition(lid.matrixWorld).applyMatrix4(inv);
        let x0 = Math.min(L.q('x', 0), hp.x), x1 = Math.max(L.q('x', 1), hp.x), z0 = Math.min(L.q('z', 0), hp.z), z1 = Math.max(L.q('z', 1), hp.z);
        const cx = (L.q('x', 0) + L.q('x', 1)) / 2, cz = (L.q('z', 0) + L.q('z', 1)) / 2, dx = hp.x - cx, dz = hp.z - cz;
        if (Math.abs(dx) > Math.abs(dz)) { if (dx > 0) x1 += 0.25; else x0 -= 0.25; } else { if (dz > 0) z1 += 0.25; else z0 -= 0.25; }
        rect = { x0: x0 - 0.06, x1: x1 + 0.06, z0: z0 - 0.06, z1: z1 + 0.06 }; r = Math.max(0.25, Math.min(0.6, Math.max(x1 - x0, z1 - z0) / 2));
      }
    }
    out.push({ x: w.x, y: w.y, z: w.z, r, rect, role: m[1] }); }); return out; };
  M.hatchT = turret ? hatches(turret) : []; M.hatchH = hatches(hull);
  return M;
}

// ---------------------------------------------------------------- geometry helpers
// every piece: non-indexed, position + normal + uv + color (merge-compatible)
function prep(g, col = 1) {
  if (g.index) g = g.toNonIndexed();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  const c = new Float32Array(n * 3), cc = Array.isArray(col) ? col : [col, col, col]; for (let i = 0; i < n; i++) c.set(cc, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g;
}
function tube(geos, a, b, r = 0.02, seg = 6) {
  const d = new THREE.Vector3().subVectors(b, a), L = d.length(); if (L < 1e-3) return;
  const g = new THREE.CylinderGeometry(r, r, L, seg, 1, false); g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); geos.push(prep(g));
}
// a box (w along `u`, t along the normal `n`, d along n x u) sitting on surface point p, sunk `sink` into it
function slab(geos, p, n, u, w, t, d, sink = 0.004, col = 1) {
  const nn = n.clone().normalize(), uu = u.clone().sub(nn.clone().multiplyScalar(u.dot(nn))).normalize(), vv = new THREE.Vector3().crossVectors(uu, nn);
  const g = new THREE.BoxGeometry(w, t, d); const m = new THREE.Matrix4().makeBasis(uu, nn, vv); m.setPosition(p.clone().add(nn.clone().multiplyScalar(t / 2 - sink)));
  g.applyMatrix4(m); geos.push(prep(g, col)); return { u: uu, n: nn, v: vv };
}
function weldPlate(geos, p, n, s = 0.09) { slab(geos, p, n, Math.abs(n.y) > 0.9 ? V3(1, 0, 0) : V3(0, 1, 0), s, 0.012, s, 0.006); }
function mesh(geos, mat, name) { const gs = geos.filter(Boolean); if (!gs.length) return null; const m = new THREE.Mesh(mergeGeometries(gs), mat); m.name = name; m.castShadow = true; m.receiveShadow = true; m.userData.kit = true; return m; }
// seeded random so a vehicle type always gets the same "random" variation (cached geometry, stable screenshots)
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// 2D polygon helpers (x, z)
function hull2(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = []; for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));   // CCW in (x, z)
}
function simplify(poly, tol) {   // drop vertices that deviate < tol from the line of their neighbours (convex in, convex out)
  let p = poly.slice(), changed = true;
  while (changed && p.length > 4) {
    changed = false; let best = -1, bd = tol;
    for (let i = 0; i < p.length; i++) { const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length]; const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1; const d = Math.abs((c[0] - a[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (c[1] - a[1])) / L; if (d < bd) { bd = d; best = i; } }
    if (best >= 0) { p.splice(best, 1); changed = true; }
  }
  return p;
}
function offsetPoly(poly, m) {   // convex CCW polygon grown by m
  const n = poly.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = poly[(i + n - 1) % n], b = poly[i], c = poly[(i + 1) % n];
    const n1 = norm2([b[1] - a[1], -(b[0] - a[0])]), n2 = norm2([c[1] - b[1], -(c[0] - b[0])]);   // outward normals (CCW in x,z -> right-hand)
    const bis = norm2([n1[0] + n2[0], n1[1] + n2[1]]), k = m / Math.max(0.5, bis[0] * n1[0] + bis[1] * n1[1]);
    out.push([b[0] + bis[0] * k, b[1] + bis[1] * k]);
  }
  return out;
}
function norm2(v) { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }
function outwardSign(poly) { let a = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; } return a > 0 ? 1 : -1; }
function clipConvex(subject, clip) {   // Sutherland-Hodgman; clip polygon convex, any winding
  const s = outwardSign(clip); let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length], inp = out; out = [];
    const side = p => s * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) >= 0;
    for (let j = 0; j < inp.length; j++) {
      const P = inp[j], Q = inp[(j + 1) % inp.length], ip = side(P), iq = side(Q);
      if (ip) out.push(P);
      if (ip !== iq) { const dx = Q[0] - P[0], dz = Q[1] - P[1], ex = b[0] - a[0], ez = b[1] - a[1]; const den = dx * ez - dz * ex; if (Math.abs(den) > 1e-12) { const t = ((a[0] - P[0]) * ez - (a[1] - P[1]) * ex) / den; out.push([P[0] + dx * t, P[1] + dz * t]); } }
    }
  }
  return out;
}
function inPoly(poly, x, z) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; }
function segDist(px, pz, a, b) { const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz || 1; let t = ((px - a[0]) * dx + (pz - a[1]) * dz) / L; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - a[0] - dx * t, pz - a[1] - dz * t); }
function clipSeg(a, b, poly) {   // segment a-b clipped to a convex polygon -> [a', b'] or null
  let t0 = 0, t1 = 1; const s = outwardSign(poly), dx = b[0] - a[0], dz = b[1] - a[1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], ex = q[0] - p[0], ez = q[1] - p[1];
    const fa = s * (ex * (a[1] - p[1]) - ez * (a[0] - p[0])), fd = s * (ex * dz - ez * dx);
    if (Math.abs(fd) < 1e-12) { if (fa < 0) return null; continue; }
    const t = -fa / fd; if (fd > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [[a[0] + dx * t0, a[1] + dz * t0], [a[0] + dx * t1, a[1] + dz * t1]];
}

// a screen panel: convex outline `outer` (x, z) minus axis-aligned rectangular `holes` (snapped to the cell grid),
// at height y resting on its supports (segments, (x, z)) and sagging between them. uv in metres / tile.
function screenGeo(outer, holes, y, cell, sag, supports, tile = 0.24) {
  const xs = outer.map(p => p[0]), zs = outer.map(p => p[1]);
  const i0 = Math.floor(Math.min(...xs) / cell), i1 = Math.ceil(Math.max(...xs) / cell), j0 = Math.floor(Math.min(...zs) / cell), j1 = Math.ceil(Math.max(...zs) / cell);
  const inHole = (x, z) => holes.some(h => x > h.x0 && x < h.x1 && z > h.z0 && z < h.z1);
  const sagAt = (x, z) => { let d = 9; for (const [a, b] of supports) d = Math.min(d, segDist(x, z, a, b)); return sag * (1 - Math.exp(-d / 0.11)); };
  const pos = [], uv = [];
  for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
    const x0 = i * cell, x1 = x0 + cell, z0 = j * cell, z1 = z0 + cell;
    if (inHole((x0 + x1) / 2, (z0 + z1) / 2)) continue;
    const poly = clipConvex([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], outer); if (poly.length < 3) continue;
    for (let k = 1; k < poly.length - 1; k++) for (const p of [poly[0], poly[k], poly[k + 1]]) { pos.push(p[0], y - sagAt(p[0], p[1]), p[1]); uv.push(p[0] / tile, p[1] / tile); }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.computeVertexNormals();
  return prep(g);
}
// a hanging chain-link curtain under the edge a -> b (x, z) from height yTop down by h, bellying out by `belly`
function curtainGeo(a, b, yTop, h, outN, belly = 0.03, tile = 0.24) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.15) return null;
  const nu = Math.max(2, Math.ceil(L / 0.2)), nv = 3, pos = [], uv = [];
  const P = (u, v) => { const w = Math.sin(Math.PI * u) * Math.sin(Math.PI * v * 0.8) * belly; const x = a[0] + (b[0] - a[0]) * u + outN[0] * w, z = a[1] + (b[1] - a[1]) * u + outN[1] * w; const yy = yTop - v * h * (1 - 0.06 * Math.sin(Math.PI * u)); return [x, yy, z, u * L / tile, (yTop - yy) / tile]; };
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const q = [P(i / nu, j / nv), P((i + 1) / nu, j / nv), P((i + 1) / nu, (j + 1) / nv), P(i / nu, (j + 1) / nv)];
    for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(q[k][0], q[k][1], q[k][2]); uv.push(q[k][3], q[k][4]); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.computeVertexNormals();
  return { geo: prep(g), hem: Array.from({ length: nu + 1 }, (_, i) => P(i / nu, 1)) };
}

// ---------------------------------------------------------------- planning (shared spots, so kits never collide)
// turret (or hull) outline at the roof edge, roof height map, top of everything on the roof, gun slot
function survey(M, S) {
  if (S._sv) return S._sv;
  const P = S.P, cx = (P.q('x', 0.02) + P.q('x', 0.98)) / 2, cz = S.zr ? (S.zr[0] + S.zr[1]) / 2 : (P.q('z', 0.02) + P.q('z', 0.98)) / 2;
  const xr = [P.q('x', 0.01), P.q('x', 0.99)], zr = S.zr || [P.q('z', 0.01), P.q('z', 0.99)], yTop = P.q('y', 0.999) + 0.5, inZ = z => !S.zr || (z > zr[0] - 0.02 && z < zr[1] + 0.02);
  // roof height map (cells 0.1 m)
  const cell = 0.1, roof = [];
  for (let x = xr[0] + 0.05; x < xr[1]; x += cell) for (let z = zr[0] + 0.05; z < zr[1]; z += cell) { const h = down(S, x, z, yTop); if (h && h.n.y > 0.3) roof.push({ x, z, y: h.p.y, n: h.n }); }
  if (S.zr && roof.length) { const ys0 = roof.map(r => r.y).sort((a, b) => a - b), hiY = ys0[Math.floor(0.98 * (ys0.length - 1))]; for (let i = roof.length - 1; i >= 0; i--) if (roof[i].y < hiY - 0.45) roof.splice(i, 1); }
  const ys = roof.map(r => r.y).sort((a, b) => a - b), qy = f => ys.length ? ys[Math.floor(f * (ys.length - 1))] : P.q('y', 0.9);
  const yEdge = qy(0.55), yMax = qy(0.985);
  // outline at the roof edge (horizontal rays at 10 deg steps toward the centre, a little under the edge)
  const R = Math.max(xr[1] - xr[0], zr[1] - zr[0]) + 1, pts = [];
  for (const yy of [yEdge - 0.06, yEdge - 0.2]) for (let a = 0; a < 360; a += 7.5) {
    const s = Math.sin(a * Math.PI / 180), c = Math.cos(a * Math.PI / 180);
    const h = cast(S.meshes, S.node, V3(cx + s * R, yy, cz + c * R), V3(-s, 0, -c), R); if (h && inZ(h.p.z)) pts.push([h.p.x, h.p.z]);
  }
  for (const r of roof) if (Math.abs(r.y - yEdge) < 0.15) pts.push([r.x, r.z]);
  const hull = pts.length > 5 ? hull2(pts) : [[xr[0], zr[0]], [xr[1], zr[0]], [xr[1], zr[1]], [xr[0], zr[1]]];
  // gun pivot in this node's space
  let gun = null; if (M.gun) { const g = new THREE.Vector3().setFromMatrixPosition(M.gun.matrixWorld).applyMatrix4(new THREE.Matrix4().copy(S.node.matrixWorld).invert()); const gb = pointsIn(M.gunMeshes, S.node, 400); gun = { x: g.x, y: g.y, z: g.z, hw: gb.n ? Math.min(0.32, Math.max(0.1, (gb.q('x', 0.97) - gb.q('x', 0.03)) / 2)) : 0.2, zBack: gb.n ? gb.q('z', 0.02) : g.z - 0.3 }; }
  S._sv = { cx, cz, roof, yEdge, yMax, outline: hull, gun, xr, zr };
  return S._sv;
}
// the cage's own geometry (when the kit builds one): top height, outline, hatch openings
function plan(M, kits, info) {
  let S = M.TS;
  if (info.kind === 'spg' && info.wheeled && !M.hasCage && M.hatchH.length) {   // truck SPG (Bohdana): the screen goes over the armoured cab
    const zs = M.hatchH.map(h => h.z); S = { node: M.hull, meshes: M.hullMeshes, P: M.H, isTurret: false, zr: [Math.min(...zs) - 0.55, Math.max(...zs) + 0.55] };
  }
  const sv = survey(M, S), hs = S.isTurret ? M.hatchT : M.hatchH.filter(h => inPoly(sv.outline, h.x, h.z));
  const pl = { S, sv, hatches: hs, holes: [], spots: {} };
  // jammer spot: rear half of the roof, on a flat patch, clear of the hatches
  const flat = (x, z, rad) => { const near = sv.roof.filter(r => Math.hypot(r.x - x, r.z - z) < rad); return near.length >= 3 && Math.max(...near.map(r => r.y)) - Math.min(...near.map(r => r.y)) < 0.12; };
  const clear = (x, z, rad) => hs.every(h => Math.hypot(h.x - x, h.z - z) > h.r + rad) && (!sv.gun || Math.abs(x - sv.gun.x) > sv.gun.hw + rad || z < sv.gun.zBack - rad);
  const pick = (cands, rad) => { for (const [x, z] of cands) if (inPoly(sv.outline, x, z) && clear(x, z, rad) && flat(x, z, rad)) return { x, z }; for (const [x, z] of cands) if (inPoly(sv.outline, x, z) && clear(x, z, rad * 0.6)) return { x, z }; return null; };
  const { xr, zr } = sv, W = xr[1] - xr[0], L = zr[1] - zr[0], gx = sv.gun ? sv.gun.x : sv.cx;
  if (kits.includes('ew')) { const c = []; for (const fz of [0.22, 0.3, 0.15, 0.38, 0.45]) for (const fx of [0.5, 0.3, 0.7, 0.2, 0.8]) c.push([xr[0] + W * fx, zr[0] + L * fz]); pl.spots.ew = pick(c, 0.3);
    // the stand's four legs must all find the roof (else the jammer goes on the hull roof, below)
    const e = pl.spots.ew; if (e) { const hs = [[-0.2, -0.15], [0.2, -0.15], [-0.2, 0.15], [0.2, 0.15]].map(([dx, dz]) => down(S, e.x + dx, e.z + dz, sv.yMax + 1)); if (hs.some(h => !h || h.n.y < 0.3) || Math.max(...hs.map(h => h.p.y)) - Math.min(...hs.map(h => h.p.y)) > 0.3) pl.spots.ew = null; } }
  if (kits.includes('ew') && !pl.spots.ew) {
    // no room on the turret roof (small BTR turret, Bradley hatches): on the hull roof behind the turret sweep instead
    const H = M.H, HS = { node: M.hull, meshes: M.hullMeshes, P: H }, top = H.q('y', 0.999) + 1;
    let tcx = 0, tcz = 0, sweep = 0; if (M.turret && M.T?.n > 20) { const tp = new THREE.Vector3().setFromMatrixPosition(M.turret.matrixWorld).applyMatrix4(new THREE.Matrix4().copy(M.hull.matrixWorld).invert()); tcx = tp.x; tcz = tp.z; for (let i = 0; i < M.T.n; i += 3) sweep = Math.max(sweep, Math.hypot(M.T.xs[i], M.T.zs[i])); }
    const W = H.q('x', 0.95) - H.q('x', 0.05);
    for (const fz of [0.3, 0.22, 0.38, 0.15, 0.45]) { if (pl.spots.ew) break; for (const fx of [0, 0.25, -0.25]) {
      const x = fx * W, z = H.q('z', fz); if (Math.hypot(x - tcx, z - tcz) < sweep + 0.45 || !hullFree(M, V3(x, 0, z), 0.3)) continue;
      const hs = [[-0.2, -0.15], [0.2, -0.15], [-0.2, 0.15], [0.2, 0.15]].map(([dx, dz]) => down(HS, x + dx, z + dz, top));
      if (hs.some(h => !h || h.n.y < 0.8) || Math.max(...hs.map(h => h.p.y)) - Math.min(...hs.map(h => h.p.y)) > 0.1) continue;
      pl.spots.ew = { x, z, S: HS, top }; break;
    } }
  }
  if (kits.includes('sight')) { const c = []; for (const fz of [0.72, 0.65, 0.8, 0.58]) for (const dx of [0.5, 0.42, 0.6, 0.35, 0.7]) c.push([gx + dx, zr[0] + L * fz]); for (const fz of [0.72, 0.6]) for (const dx of [-0.5, -0.6]) c.push([gx + dx, zr[0] + L * fz]); pl.spots.sight = pick(c.filter(([x]) => x < xr[1] - 0.15), 0.24); }
  return pl;
}

// ---------------------------------------------------------------- the kits
const CELL = 0.1;
const snap = (v, f) => f(v / CELL) * CELL;
function buildCage(M, out, info, pl) {
  const S = pl.S, sv = pl.sv, node = S.node, col = [], scr = [], cur = [];
  // top height: over everything on the roof (sights, cupola, MG) with a minimum stand-off over the roof edge
  const top = Math.min(sv.yEdge + 0.8, Math.max(sv.yMax + 0.1, sv.yEdge + 0.42));
  const outer = simplify(offsetPoly(sv.outline, 0.1), 0.08);
  const isFront = (x, z) => { const a = Math.atan2(x - sv.cx, z - sv.cz); return Math.abs(a) < 0.55; };
  // openings: hatches (lid swings through), the jammer, the gun slot on high-elevation guns
  const holes = [];
  for (const h of pl.hatches) { const q = h.rect || { x0: h.x - h.r - 0.06, x1: h.x + h.r + 0.06, z0: h.z - h.r - 0.06, z1: h.z + h.r + 0.06 }; holes.push({ x0: snap(q.x0, Math.floor), x1: snap(q.x1, Math.ceil), z0: snap(q.z0, Math.floor), z1: snap(q.z1, Math.ceil) }); }
  if (pl.spots.ew && !pl.spots.ew.S) { const e = pl.spots.ew; holes.push({ x0: snap(e.x - 0.32, Math.floor), x1: snap(e.x + 0.32, Math.ceil), z0: snap(e.z - 0.26, Math.floor), z1: snap(e.z + 0.26, Math.ceil) }); }
  const zMax = Math.max(...outer.map(p => p[1])) + 1;
  if (sv.gun && info.kind !== 'tank') {
    const g = sv.gun, zMin = Math.min(...outer.map(p => p[1])) - 1, band = { x0: snap(g.x - g.hw - 0.07, Math.floor), x1: snap(g.x + g.hw + 0.07, Math.ceil) };
    if (inPoly(outer, g.x, Math.min(g.z, g.zBack) + 0.05)) holes.push({ ...band, z0: snap(Math.min(g.z - 0.3, g.zBack), Math.floor), z1: zMax });
    else if (g.z < zMin + 1 && inPoly(outer, g.x, (zMin + zMax) / 2)) holes.push({ ...band, z0: snap(zMin, Math.floor), z1: zMax, full: true });   // barrel laid over the cab
  }
  // supports: perimeter, cross tubes every 0.5 m (x) / 0.6 m (z) along the grid lines, opening frames
  const supports = [];
  for (let i = 0; i < outer.length; i++) supports.push([outer[i], outer[(i + 1) % outer.length]]);
  const inside = (x, z) => holes.some(h => x > h.x0 + 1e-4 && x < h.x1 - 1e-4 && z > h.z0 + 1e-4 && z < h.z1 - 1e-4);
  const gridLine = (fixed, alongX, lo, hi) => {   // pieces of a grid line outside the openings, clipped to the outline
    const segs = []; let cur0 = null;
    for (let t = lo; t < hi - 1e-6; t += CELL) {
      const a = alongX ? [t, fixed] : [fixed, t], b = alongX ? [t + CELL, fixed] : [fixed, t + CELL], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const ok = !inside(mid[0], mid[1]) && inPoly(outer, mid[0], mid[1]);
      if (ok && !cur0) cur0 = a; if (!ok && cur0) { segs.push([cur0, a]); cur0 = null; }
    }
    if (cur0) segs.push([cur0, alongX ? [hi, fixed] : [fixed, hi]]);
    return segs.map(([a, b]) => clipSeg(a, b, outer)).filter(Boolean);
  };
  const xs = outer.map(p => p[0]), zs = outer.map(p => p[1]), X0 = snap(Math.min(...xs), Math.floor), X1 = snap(Math.max(...xs), Math.ceil), Z0 = snap(Math.min(...zs), Math.floor), Z1 = snap(Math.max(...zs), Math.ceil);
  const cross = [];
  for (let z = Z0 + 5 * CELL; z < Z1 - 2 * CELL; z += 5 * CELL) cross.push(...gridLine(z, true, X0, X1));
  for (let x = X0 + 6 * CELL; x < X1 - 3 * CELL; x += 6 * CELL) cross.push(...gridLine(x, false, Z0, Z1));
  // opening frames: the hole edges (on grid lines), minus the parts inside another opening
  const frame = [];
  for (const h of holes) {
    const zt = Math.min(h.z1, Z1), zb = Math.max(h.z0, Z0);
    for (const [fixed, alongX, lo, hi] of [[h.z0, true, h.x0, h.x1], [h.z1, true, h.x0, h.x1], [h.x0, false, zb, zt], [h.x1, false, zb, zt]]) {
      if (hi - lo < 0.05) continue;
      for (const c of gridLine(fixed, alongX, lo, hi)) if (Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]) > 0.05) frame.push(c);
    }
  }
  supports.push(...cross, ...frame);
  const R0 = 0.024, R1 = 0.016;
  const outsideHoles = (a, b) => {   // pieces of a segment not crossing an opening
    const out = []; let p0 = null; const NS = 24, at = t => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (let k = 0; k < NS; k++) { const m = at((k + 0.5) / NS), inH = holes.some(h => m[0] > h.x0 - 0.03 && m[0] < h.x1 + 0.03 && m[1] > h.z0 - 0.03 && m[1] < h.z1 + 0.03); if (!inH && p0 == null) p0 = k / NS; if (inH && p0 != null) { out.push([at(p0), at(k / NS)]); p0 = null; } }
    if (p0 != null) out.push([at(p0), b]); return out;
  };
  for (const [a, b] of supports.slice(0, outer.length)) for (const [A, B] of outsideHoles(a, b)) tube(col, V3(A[0], top, A[1]), V3(B[0], top, B[1]), R0);
  for (const [a, b] of cross) tube(col, V3(a[0], top, a[1]), V3(b[0], top, b[1]), R1);
  for (const [a, b] of frame) tube(col, V3(a[0], top, a[1]), V3(b[0], top, b[1]), 0.018);
  scr.push(screenGeo(outer, holes, top + R1 + 0.004, CELL, 0.035, supports));
  // posts: at the outline corners (not in front of the gun), plus mid-edge posts on long edges; feet found by casting
  // down onto the roof just inside the edge, else welded to the side wall under the edge
  const corners = [];
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], b = outer[(i + 1) % outer.length]; corners.push(a);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L > 1.3) corners.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  }
  const keep = (x, z) => pl.hatches.every(h => h.rect ? !(x > h.rect.x0 - 0.08 && x < h.rect.x1 + 0.08 && z > h.rect.z0 - 0.08 && z < h.rect.z1 + 0.08) : Math.hypot(h.x - x, h.z - z) > h.r + 0.1) && (!sv.gun || Math.abs(x - sv.gun.x) > sv.gun.hw + 0.2 || z < sv.gun.zBack - 0.15);
  let posts = 0;
  for (const [tx, tz] of corners) {
    if (isFront(tx, tz)) continue;
    const dx = sv.cx - tx, dz = sv.cz - tz, dl = Math.hypot(dx, dz) || 1, ux = dx / dl, uz = dz / dl;
    let foot = null;
    for (const ins of [0.16, 0.22, 0.3, 0.4, 0.5]) {
      const x = tx + ux * ins, z = tz + uz * ins; if (!keep(x, z)) continue;
      const h = down(S, x, z, top - 0.03); if (h && h.n.y > 0.45 && h.p.y > sv.yEdge - 0.4 && h.p.y < top - 0.12) { foot = h; break; }
    }
    if (!foot) {   // side wall: horizontal ray inward under the roof edge, then a short stand-off bracket
      const h = cast(S.meshes, node, V3(tx - ux * 0.3, sv.yEdge - 0.12, tz - uz * 0.3), V3(ux, 0, uz), 1.2);
      if (h && Math.abs(h.n.y) < 0.6 && keep(h.p.x, h.p.z)) { foot = h; }
    }
    if (!foot) continue;
    (pl.feet ||= []).push({ x: foot.p.x, z: foot.p.z });
    const f = foot.p.clone().add(foot.n.clone().multiplyScalar(0.004));
    if (foot.n.y > 0.45) { tube(col, f, V3(tx, top, tz), R0); weldPlate(col, foot.p, foot.n, 0.1); }
    else { const s = V3(tx, foot.p.y, tz); tube(col, f, s, R0); tube(col, s.clone().add(V3(0, -0.04, 0)), V3(tx, top, tz), R0); weldPlate(col, foot.p, foot.n, 0.11); tube(col, f.clone().add(V3(0, 0.08, 0)), V3(tx, foot.p.y + 0.22, tz), 0.012); }
    posts++;
  }
  // side + rear curtains (chain-link hanging from the top frame), not across the front (sights, driver's view)
  const sgn = outwardSign(outer);
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], b = outer[(i + 1) % outer.length]; const e = norm2([b[0] - a[0], b[1] - a[1]]), on = sgn > 0 ? [e[1], -e[0]] : [-e[1], e[0]];
    if (on[1] > 0.5) continue;
    // pieces of the edge outside the openings (a slot over a gun crosses the rear edge on a truck cab)
    const pieces = []; let p0 = null; const NS = 24;
    for (let k = 0; k < NS; k++) { const t0 = k / NS, t1 = (k + 1) / NS, mx = a[0] + (b[0] - a[0]) * (t0 + t1) / 2, mz = a[1] + (b[1] - a[1]) * (t0 + t1) / 2, inH = holes.some(h => mx > h.x0 - 0.02 && mx < h.x1 + 0.02 && mz > h.z0 - 0.05 && mz < h.z1 + 0.05); if (!inH && p0 == null) p0 = t0; if (inH && p0 != null) { pieces.push([p0, t0]); p0 = null; } }
    if (p0 != null) pieces.push([p0, 1]);
    for (const [t0, t1] of pieces) {
      const A = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], B = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      const c = curtainGeo(A, B, top - R0, Math.min(0.38, top - sv.yEdge - 0.12), on); if (!c) continue;
      cur.push(c.geo); for (let k = 0; k < c.hem.length - 1; k++) tube(col, V3(...c.hem[k].slice(0, 3)), V3(...c.hem[k + 1].slice(0, 3)), 0.007, 4);
    }
  }
  out.push([node, mesh(col, mats().steel, 'kit_cage')], [node, mesh(scr, mats().chain, 'kit_cage_screen')], [node, mesh(cur, mats().chain, 'kit_cage_curtain')]);
  pl.cage = { top, outer, posts, feet: pl.feet || [] };
}
// the model has its own cage (T-72B3, BMP-3, Msta-S): hang chain-link curtains from its top rim
function cageCurtains(M, out) {
  const cm = []; M.cageNode.traverse(o => { if (o.isMesh && !/_LOD1$/i.test(o.name)) cm.push(o); });
  const S = M.TS, C = pointsIn(cm, S.node, 4000); if (C.n < 20) return;
  const yTop = C.q('y', 0.995), rim = []; for (let i = 0; i < C.n; i++) if (C.ys[i] > yTop - 0.06) rim.push([C.xs[i], C.zs[i]]);
  const poly = simplify(hull2(rim), 0.04); if (poly.length < 3) return;
  const sv = survey(M, S), sgn = outwardSign(poly), col = [], cur = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]; const e = norm2([b[0] - a[0], b[1] - a[1]]), on = sgn > 0 ? [e[1], -e[0]] : [-e[1], e[0]];
    if (on[1] > 0.5) continue;
    // a hanger tube along the rim edge (sits on the cage's own rim), the curtain hangs from it
    const ya = yTop - 0.02;
    tube(col, V3(a[0], ya, a[1]), V3(b[0], ya, b[1]), 0.012, 5);
    const c = curtainGeo(a, b, ya - 0.01, Math.max(0.2, Math.min(0.42, ya - sv.yEdge - 0.1)), on); if (!c) continue;
    cur.push(c.geo); for (let k = 0; k < c.hem.length - 1; k++) tube(col, V3(...c.hem[k].slice(0, 3)), V3(...c.hem[k + 1].slice(0, 3)), 0.007, 4);
  }
  out.push([S.node, mesh(col, mats().steel, 'kit_cage_rim')], [S.node, mesh(cur, mats().chain, 'kit_cage_curtain')]);
}

// clear of the hull hatches' lid swing (rects from measure) by `m`
const hullFree = (M, p, m = 0.12) => M.hatchH.every(h => { const q = h.rect || { x0: h.x - h.r, x1: h.x + h.r, z0: h.z - h.r, z1: h.z + h.r }; return !(p.x > q.x0 - m && p.x < q.x1 + m && p.z > q.z0 - m && p.z < q.z1 + m); });
const BUILD = {
  cage(M, out, info, pl) { if (M.hasCage) cageCurtains(M, out); else buildCage(M, out, info, pl); },
  roof(M, out, info, pl) {
    // engine-deck screen: posts welded to the fenders outside the turret sweep, a sagging welded-mesh roof from just
    // behind the turret sweep to the stern, chain-link side curtains
    const P = M.H, S = { node: M.hull, meshes: M.hullMeshes }, col = [], scr = [], cur = [];
    const x0 = P.q('x', 0.01), x1 = P.q('x', 0.99), zs = P.q('z', 0.015);
    let tcx = 0, tcz = 0, sweep = 1.5, troof = P.q('y', 0.95) + 0.6;
    if (M.turret && M.T?.n > 20) {
      const tp = new THREE.Vector3().setFromMatrixPosition(M.turret.matrixWorld).applyMatrix4(new THREE.Matrix4().copy(M.hull.matrixWorld).invert());
      tcx = tp.x; tcz = tp.z; let r = 0; for (let i = 0; i < M.T.n; i += 3) r = Math.max(r, Math.hypot(M.T.xs[i], M.T.zs[i])); sweep = r;
      troof = tp.y + (pl.cage ? pl.cage.top + 0.03 : M.T.q('y', 0.995));
    }
    // front edge just behind the turret's rear (the screen is above the turret top, so the turret turns under it);
    // posts only where the turret sweep cannot reach them
    const tback = M.turret && M.T?.n > 20 ? tcz + M.T.q('z', 0.005) - 0.1 : P.q('z', 0.5);
    const top = troof + 0.22, ze = tback;
    if (ze - zs < 0.8) return;
    const X0 = x0 - 0.04, X1 = x1 + 0.04, outer = [[X0, zs], [X1, zs], [X1, ze], [X0, ze]];
    let n = 0;
    for (const sx of [x0, x1]) for (const f of [0.02, 0.5, 1]) {
      const dirIn = sx < (x0 + x1) / 2 ? 1 : -1, tx = dirIn > 0 ? X0 : X1;
      let foot = null, z = 0;
      for (const fz of [f, f - 0.06, f - 0.12, f - 0.2].filter(v => v >= 0)) {
        z = zs + (ze - zs) * fz;
        for (const ins of [0.06, 0.12, 0.2, 0.3, 0.42]) { const x = sx + dirIn * ins; if (Math.hypot(x - tcx, z - tcz) < sweep + 0.12) continue; const h = down(S, x, z, top - 0.05); if (h && h.n.y > 0.5 && h.p.y < troof - 0.1) { foot = h; break; } }
        if (foot) break;
      }
      if (!foot) continue;
      const knee = V3(foot.p.x, foot.p.y + 0.25, foot.p.z), tp = V3(tx, top, z);
      tube(col, foot.p.clone().add(V3(0, -0.01, 0)), knee, 0.028); tube(col, knee, tp, 0.028);
      weldPlate(col, foot.p, foot.n, 0.12); n++;
    }
    if (n < 4) return;
    const supports = []; for (let i = 0; i < 4; i++) supports.push([outer[i], outer[(i + 1) % 4]]);
    for (const [a, b] of supports) tube(col, V3(a[0], top, a[1]), V3(b[0], top, b[1]), 0.026);
    for (let z = zs + 0.5; z < ze - 0.25; z += 0.5) { supports.push([[X0, z], [X1, z]]); tube(col, V3(X0, top, z), V3(X1, top, z), 0.018); }
    for (const x of [X0 + (X1 - X0) / 3, X0 + 2 * (X1 - X0) / 3]) { supports.push([[x, zs], [x, ze]]); tube(col, V3(x, top, zs), V3(x, top, ze), 0.016); }
    scr.push(screenGeo(outer, [], top + 0.02, CELL, 0.04, supports, 0.3));
    for (const [a, b, on] of [[[X1, zs], [X1, ze], [1, 0]], [[X0, ze], [X0, zs], [-1, 0]], [[X0, zs], [X1, zs], [0, -1]]]) {
      const c = curtainGeo(a, b, top - 0.026, 0.4, on, 0.04); if (!c) continue;
      cur.push(c.geo); for (let k = 0; k < c.hem.length - 1; k++) tube(col, V3(...c.hem[k].slice(0, 3)), V3(...c.hem[k + 1].slice(0, 3)), 0.007, 4);
    }
    out.push([M.hull, mesh(col, mats().steel, 'kit_roof')], [M.hull, mesh(scr, mats().weldmesh, 'kit_roof_screen')], [M.hull, mesh(cur, mats().chain, 'kit_roof_curtain')]);
  },
  era(M, out, info) {
    const R = rng(0xE7A + M.H.n), tank = info.kind === 'tank' || info.kind == null;
    // Kontakt-1 container ~ 0.26 x 0.14 x 0.07 m (tanks); Kaktus / BRAT style tile ~ 0.36 x 0.24 x 0.06 m (IFVs)
    const BW = tank ? 0.26 : 0.36, BD = tank ? 0.14 : 0.24, BT = tank ? 0.07 : 0.06, GAP = 0.012;
    const brick = (geos, p, n, u, tilt = 0) => {
      const c = 0.88 + R() * 0.24, colr = [0.40 * c, 0.42 * c, 0.29 * c];
      const ax = slab([], p, n, u, 1, 1, 1);   // basis only
      let nn = ax.n, vv = ax.v;
      if (tilt) { const q = new THREE.Quaternion().setFromAxisAngle(ax.u, tilt); nn = nn.clone().applyQuaternion(q); vv = vv.clone().applyQuaternion(q); const lift = Math.sin(Math.abs(tilt)) * BD / 2 + 0.004; const wedge = new THREE.BoxGeometry(BW * 0.9, lift * 2, BD * 0.8); wedge.applyMatrix4(new THREE.Matrix4().makeBasis(ax.u, ax.n, ax.v).setPosition(p.clone().add(ax.n.clone().multiplyScalar(lift - 0.003)))); geos.push(prep(wedge, [0.2, 0.2, 0.16])); p = p.clone().add(ax.n.clone().multiplyScalar(lift * 2 + 0.004)); }
      const jit = (R() - 0.5) * 0.04, uu = ax.u.clone().applyAxisAngle(nn, jit);
      const g = new THREE.BoxGeometry(BW, BT, BD, 1, 1, 1); const pa = g.attributes.position; for (let i = 0; i < pa.count; i++) if (pa.getY(i) > 0) { pa.setX(i, pa.getX(i) * 0.94); pa.setZ(i, pa.getZ(i) * 0.86); }   // chamfered lid
      const m = new THREE.Matrix4().makeBasis(uu, nn, new THREE.Vector3().crossVectors(uu, nn)); m.setPosition(p.clone().add(nn.clone().multiplyScalar(BT / 2 - 0.004)));
      g.applyMatrix4(m); geos.push(prep(g, colr));
      for (const s of [-1, 1]) { const b = new THREE.CylinderGeometry(0.012, 0.012, 0.012, 6); b.applyMatrix4(new THREE.Matrix4().makeBasis(uu, nn, new THREE.Vector3().crossVectors(uu, nn)).setPosition(p.clone().add(nn.clone().multiplyScalar(BT + 0.002)).add(uu.clone().multiplyScalar(s * BW * 0.36)))); geos.push(prep(b, [0.18, 0.18, 0.15])); }
    };
    // glacis: find the front plate by rays from ahead, fit a plane, lay rows of bricks on it (each one ray-checked)
    const P = M.H, S = { node: M.hull, meshes: M.hullMeshes }, geos = [];
    const W = P.q('x', 0.98) - P.q('x', 0.02), xc = (P.q('x', 0.98) + P.q('x', 0.02)) / 2, zf = P.q('z', 0.999) + 2, zc = (P.q('z', 0.02) + P.q('z', 0.98)) / 2, Lh = P.q('z', 0.98) - P.q('z', 0.02);
    const hits = [];
    for (let y = P.q('y', 0.2); y <= P.q('y', 0.92); y += 0.06) for (let x = xc - W * 0.4; x <= xc + W * 0.4; x += 0.12) {
      const h = cast(S.meshes, S.node, V3(x, y, zf), V3(0, 0, -1)); if (!h || h.p.z < zc + Lh * 0.22 || h.n.z < 0.3 || h.n.y < 0.15) continue; hits.push(h);
    }
    if (hits.length > 8) {
      // dominant plane: median normal, keep hits on it
      const nrm = hits.map(h => h.n).sort((a, b) => a.y - b.y)[Math.floor(hits.length / 2)].clone();
      const on = hits.filter(h => h.n.dot(nrm) > 0.97); const c0 = on.reduce((s, h) => s.add(h.p), V3(0, 0, 0)).multiplyScalar(1 / on.length);
      const u = V3(1, 0, 0), v = new THREE.Vector3().crossVectors(u, nrm).normalize().negate();   // v: up the slope
      const us = on.map(h => h.p.clone().sub(c0).dot(u)), vs = on.map(h => h.p.clone().sub(c0).dot(v));
      const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
      const nu = Math.floor((u1 - u0 - 0.1) / (BW + GAP)), nv = Math.min(tank ? 4 : 2, Math.floor((v1 - v0 - 0.08) / (BD + GAP)));
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        const uu = u0 + 0.05 + (u1 - u0 - 0.1 - nu * (BW + GAP)) / 2 + (i + 0.5) * (BW + GAP) + (j % 2 ? (BW + GAP) / 2 * 0 : 0);
        const vv = v1 - 0.05 - (j + 0.5) * (BD + GAP);
        const c = c0.clone().add(u.clone().multiplyScalar(uu)).add(v.clone().multiplyScalar(vv));
        // the brick's four corners + centre must sit on the plate (no lamps / hooks / hatches under it)
        let ok = true, best = null;
        for (const [a, b] of [[0, 0], [-0.45, -0.4], [0.45, -0.4], [-0.45, 0.4], [0.45, 0.4]]) {
          const q = c.clone().add(u.clone().multiplyScalar(a * BW)).add(v.clone().multiplyScalar(b * BD));
          const h = cast(S.meshes, S.node, q.clone().add(nrm.clone().multiplyScalar(0.6)), nrm.clone().negate(), 1.2);
          if (!h || Math.abs(h.p.clone().sub(q).dot(nrm)) > 0.02 || h.n.dot(nrm) < 0.95) { ok = false; break; } if (!best) best = h;
        }
        if (!ok || !hullFree(M, best.p) || R() < 0.04) continue;
        brick(geos, best.p, nrm, u);
      }
    }
    // a row along each hull side over the front of the track run (tank skirts / IFV upper side plates), each brick on
    // the side surface found by a horizontal ray, all four corners checked
    {
      const xo = Math.max(Math.abs(P.q('x', 0.002)), Math.abs(P.q('x', 0.998))) + 1;
      for (const sx of [-1, 1]) for (const fy of tank ? [0.38, 0.5] : [0.6, 0.72]) {
        const y = P.q('y', fy); let last = null;
        for (let z = P.q('z', 0.9); z > P.q('z', tank ? 0.45 : 0.4); z -= 0.03) {
          const h = cast(S.meshes, S.node, V3(sx * xo, y, z), V3(-sx, 0, 0)); if (!h || Math.abs(h.n.x) < 0.75) continue;
          if (last && last.distanceTo(h.p) < BW + GAP) continue;
          const u = V3(0, 0, 1).sub(h.n.clone().multiplyScalar(h.n.z)).normalize(), v = new THREE.Vector3().crossVectors(u, h.n);
          const pr = [[-0.45, -0.4], [0.45, -0.4], [-0.45, 0.4], [0.45, 0.4]].map(([a, b]) => { const q = h.p.clone().add(u.clone().multiplyScalar(a * BW)).add(v.clone().multiplyScalar(b * BD)); const hh = cast(S.meshes, S.node, q.clone().add(h.n.clone().multiplyScalar(0.3)), h.n.clone().negate(), 0.6); return hh ? hh.p.clone().sub(h.p).dot(h.n) : null; });
          if (pr.some(d => d == null || Math.abs(d) > 0.012) || !hullFree(M, h.p)) continue;
          last = h.p.clone(); if (R() < 0.05) continue;
          brick(geos, h.p.clone().add(h.n.clone().multiplyScalar(Math.max(0, ...pr))), h.n, u);
        }
      }
    }
    out.push([M.hull, mesh(geos, mats().era, 'kit_era_hull')]);
    // turret front: rows round the cheeks, each brick tangent to the cheek on a wedge bracket (tilted ~18 deg)
    if (M.turret && M.T?.n > 20) {
      const T = M.T, S2 = { node: M.turret, meshes: M.turMeshes }, sv = survey(M, M.TS), tg = [];
      const gx = sv.gun ? sv.gun.x : 0, ghw = (sv.gun ? sv.gun.hw : 0.25) + 0.12;
      const R0 = Math.max(T.q('x', 0.99) - T.q('x', 0.01), T.q('z', 0.99) - T.q('z', 0.01)) + 1;
      const yLo = T.q('y', tank ? 0.08 : 0.3), yHi = sv.yEdge - BD * 0.6;
      // a turret brick must never sweep over an opened hull hatch lid (driver's hatch in front of the turret)
      const tp = new THREE.Vector3().setFromMatrixPosition(M.turret.matrixWorld).applyMatrix4(new THREE.Matrix4().copy(M.hull.matrixWorld).invert());
      const lidSweep = p => M.hatchH.some(hh => { const q = hh.rect; if (!q) return false; const nx = Math.max(q.x0, Math.min(tp.x, q.x1)), nz = Math.max(q.z0, Math.min(tp.z, q.z1)); return Math.hypot(p.x, p.z) + BW * 0.6 > Math.hypot(nx - tp.x, nz - tp.z) && tp.y + p.y < hh.y + 0.75; });
      for (let y = yHi, row = 0; y >= yLo && row < (tank ? 3 : 2); y -= BD + GAP + 0.01, row++) for (const side of [-1, 1]) {
        let last = null;
        for (let a = 2; a < 80; a += 1.5) {
          const ar = side * a * Math.PI / 180, s = Math.sin(ar), c = Math.cos(ar);
          const h = cast(S2.meshes, S2.node, V3(sv.cx + s * R0, y, sv.cz + c * R0), V3(-s, 0, -c), R0 * 2);
          if (!h || Math.abs(h.n.y) > 0.6 || h.n.z < 0.15 || Math.abs(h.p.x - gx) < ghw + BW / 2) continue;
          if (last && last.distanceTo(h.p) < BW + GAP) continue;
          // the brick's two ends must touch the cheek too (no bridging over gaps)
          const t = new THREE.Vector3().crossVectors(UP, h.n).normalize(); let ok = true;
          for (const e of [-0.42, 0.42]) { const q = h.p.clone().add(t.clone().multiplyScalar(e * BW)); const hh = cast(S2.meshes, S2.node, q.clone().add(h.n.clone().multiplyScalar(0.4)), h.n.clone().negate(), 0.8); if (!hh || hh.p.distanceTo(q) > 0.05) { ok = false; break; } }
          if (!ok) continue;
          last = h.p.clone(); if (R() < 0.04 || lidSweep(h.p)) continue;
          brick(tg, h.p, h.n, t, tank ? -0.3 : 0);
        }
      }
      // tanks: a carpet of Kontakt-1 on the turret roof against top-attack drones (2023-24 field practice), laid flat
      // in rows in front of and beside the hatches, clear of the gun, the sight / jammer and the cage feet
      if (tank) {
        const pl = info._pl, keep = [...(pl?.hatches || M.hatchT).map(h => ({ x: h.x, z: h.z, r: h.r + 0.03 })), ...['sight', 'ew'].filter(k => pl?.spots[k] && !pl.spots[k].S).map(k => ({ ...pl.spots[k], r: 0.38 })), ...(pl?.cage?.feet || []).map(f => ({ x: f.x, z: f.z, r: 0.12 }))];
        const free = (x, z) => keep.every(k => Math.hypot(k.x - x, k.z - z) > k.r + BW * 0.4) && !(Math.abs(x - gx) < ghw - 0.04 + BW / 2 && z > (sv.gun ? sv.gun.z - 0.15 : 9));
        const zTop = Math.max(...sv.roof.map(r => r.z)) - 0.15, zLo = (M.hatchT.length ? Math.min(...M.hatchT.map(h => h.z)) - 0.5 : sv.cz);
        for (let z = zTop; z > zLo; z -= BD + GAP + 0.02) for (let x = sv.xr[0] + 0.2; x < sv.xr[1] - 0.2; x += BW + GAP + 0.01) {
          if (!free(x, z) || !inPoly(sv.outline, x, z)) continue;
          const hs = [[0, 0], [-0.45, -0.4], [0.45, -0.4], [-0.45, 0.4], [0.45, 0.4]].map(([a, b]) => down(S2, x + a * BW, z + b * BD, sv.yMax + 1));
          if (hs.some(h => !h || h.n.y < 0.55)) continue;
          // local plate plane from the five probes: all within 1.5 cm of it (no boxes, lips or hatch rings under the brick)
          const nn = hs.reduce((a, h) => a.add(h.n), V3(0, 0, 0)).normalize(), c0 = hs[0].p;
          const dev = hs.map(h => h.p.clone().sub(c0).dot(nn)); if (Math.max(...dev) - Math.min(...dev) > 0.03 || c0.y > sv.yEdge + 0.15) continue;
          if (R() < 0.05) continue;
          brick(tg, c0.clone().add(nn.clone().multiplyScalar(Math.max(0, ...dev))), nn, V3(1, 0, 0));
        }
      }
      out.push([M.turret, mesh(tg, mats().era, 'kit_era_turret')]);
    }
  },
  sandbags(M, out, info) {
    const P = M.H, tracked = !info.wheeled, R = rng(0x5A9D + M.H.n), S = { node: M.hull, meshes: M.hullMeshes };
    const bagGeo = (L, W, Hh) => { const g = new THREE.SphereGeometry(1, 10, 6); const pa = g.attributes.position; for (let i = 0; i < pa.count; i++) { let x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i); x = Math.sign(x) * Math.pow(Math.abs(x), 0.55); z = Math.sign(z) * Math.pow(Math.abs(z), 0.6); y = y < 0 ? y * 0.25 : y; pa.setXYZ(i, x * L / 2, (y + 0.25) * Hh / 1.25, z * W / 2); } g.computeVertexNormals(); return g; };
    if (!tracked) {
      // wheeled: two courses of bags on the sloped upper hull side between the axles' arches, held by a welded rail
      const geos = [], rail = [];
      const z0 = P.q('z', 0.2), z1 = P.q('z', 0.82), yU = P.q('y', 0.62), yL = P.q('y', 0.42);
      for (const sx of [-1, 1]) {
        const xFar = sx * (Math.max(Math.abs(P.q('x', 0.005)), Math.abs(P.q('x', 0.995))) + 1);
        let railPts = [];
        for (let z = z0; z <= z1; z += 0.5) for (const [k, y] of [[0, yL], [1, (yL + yU) / 2 + 0.05]]) {
          const h = cast(S.meshes, S.node, V3(xFar, y, z), V3(-sx, 0, 0)); if (!h || Math.abs(h.n.x) < 0.35 || h.n.y < -0.3) continue;
          // flatness under the bag: three probes along z must hit within 4 cm of the plane
          let ok = true; for (const [dz, dy] of [[-0.22, 0], [0.22, 0], [0, 0.1], [0, -0.1], [-0.2, 0.08], [0.2, -0.08]]) { const hh = cast(S.meshes, S.node, V3(xFar, y + dy, z + dz), V3(-sx, 0, 0)); if (!hh || Math.abs(hh.p.clone().sub(h.p).dot(h.n)) > 0.035 + Math.abs(dy) * Math.abs(h.n.y) * 1.2) ok = false; }
          if (!ok) continue;
          const g = bagGeo(0.5 + R() * 0.06, 0.3, 0.17); const n = h.n, v = UP.clone().sub(n.clone().multiplyScalar(n.y)).normalize(), u = new THREE.Vector3().crossVectors(n, v).normalize();   // v: up the slope, u: along the hull
          g.applyMatrix4(new THREE.Matrix4().makeBasis(u, n, v).multiply(new THREE.Matrix4().makeRotationY((R() - 0.5) * 0.15)).setPosition(h.p.clone().add(n.clone().multiplyScalar(0.01))));
          const c = 0.8 + R() * 0.3; geos.push(prep(g, [c, c * 0.97, c * 0.9]));
          if (k === 0) railPts.push(h.p.clone().add(v.clone().multiplyScalar(-0.17)).add(n.clone().multiplyScalar(0.22)));
          if (k === 0) { weldPlate(rail, h.p.clone().add(v.clone().multiplyScalar(-0.17)), n, 0.07); tube(rail, h.p.clone().add(v.clone().multiplyScalar(-0.17)).add(n.clone().multiplyScalar(-0.005)), h.p.clone().add(v.clone().multiplyScalar(-0.17)).add(n.clone().multiplyScalar(0.22)), 0.012, 5); }
        }
        // retaining rail along the lower course, on the brackets
        for (let i = 0; i < railPts.length - 1; i++) if (railPts[i].distanceTo(railPts[i + 1]) < 0.7) tube(rail, railPts[i], railPts[i + 1], 0.013, 5);
      }
      out.push([M.hull, mesh(geos, mats().bag, 'kit_sandbags')], [M.hull, mesh(rail, mats().steel, 'kit_sandbag_rail')]);
      return;
    }
    // tracked: spare track links on the glacis in rows (laid on the fitted plate plane), and on the turret sides
    const link = (geos, p, n, u) => {
      const ax = slab([], p, n, u, 1, 1, 1), m = new THREE.Matrix4().makeBasis(ax.u, ax.n, ax.v).setPosition(p.clone().add(ax.n.clone().multiplyScalar(-0.004)));
      const parts = [];
      for (const s of [-1, 1]) { const pad = new THREE.BoxGeometry(0.25, 0.04, 0.13); pad.translate(s * 0.15, 0.02, 0); parts.push(pad); const pin = new THREE.CylinderGeometry(0.018, 0.018, 0.58, 6); pin.rotateZ(Math.PI / 2); pin.translate(0, 0.022, s * 0.06); parts.push(pin); }
      const horn = new THREE.BoxGeometry(0.035, 0.09, 0.07); horn.translate(0, 0.06, 0); parts.push(horn);
      for (const g of parts) { g.applyMatrix4(m); geos.push(prep(g)); }
    };
    const geos = [], placed = [];
    const W = P.q('x', 0.98) - P.q('x', 0.02), xc = (P.q('x', 0.98) + P.q('x', 0.02)) / 2, zf = P.q('z', 0.999) + 2, zc = (P.q('z', 0.02) + P.q('z', 0.98)) / 2, Lh = P.q('z', 0.98) - P.q('z', 0.02);
    for (let y = P.q('y', 0.12); y <= P.q('y', 0.75); y += 0.035) for (const x of [xc - W * 0.2, xc + W * 0.2]) {
      const h = cast(S.meshes, S.node, V3(x, y, zf), V3(0, 0, -1)); if (!h || h.p.z < zc + Lh * 0.22 || h.n.z < 0.25) continue;
      if (placed.some(q => q.distanceTo(h.p) < 0.155)) continue;
      // both pads must lie on the plate
      const u = V3(1, 0, 0); let ok = true; for (const e of [-0.25, 0.25]) { const q = h.p.clone().add(u.clone().multiplyScalar(e)); const hh = cast(S.meshes, S.node, q.clone().add(h.n.clone().multiplyScalar(0.4)), h.n.clone().negate(), 0.8); if (!hh || Math.abs(hh.p.clone().sub(q).dot(h.n)) > 0.025) ok = false; }
      if (!ok || !hullFree(M, h.p)) continue;
      placed.push(h.p); link(geos, h.p, h.n, u);
    }
    out.push([M.hull, mesh(geos, mats().link, 'kit_links_hull')]);
    if (M.turret && M.T?.n > 20) {
      const T = M.T, S2 = { node: M.turret, meshes: M.turMeshes }, tg = [], tp = [], sv = survey(M, M.TS);
      for (const sx of [-1, 1]) for (let z = T.q('z', 0.12); z <= T.q('z', 0.5); z += 0.16) {
        const h = cast(S2.meshes, S2.node, V3(sx * 6, (T.q('y', 0.35) + sv.yEdge) / 2 - 0.05, z), V3(-sx, 0, 0)); if (!h || Math.abs(h.n.y) > 0.5) continue;
        if (tp.some(q => q.distanceTo(h.p) < 0.15)) continue;
        const u = V3(0, 1, 0); let ok = true; for (const e of [-0.25, 0.25]) { const q = h.p.clone().add(u.clone().sub(h.n.clone().multiplyScalar(h.n.y)).normalize().multiplyScalar(e)); const hh = cast(S2.meshes, S2.node, q.clone().add(h.n.clone().multiplyScalar(0.4)), h.n.clone().negate(), 0.8); if (!hh || Math.abs(hh.p.clone().sub(q).dot(h.n)) > 0.03) ok = false; }
        if (!ok) continue;
        tp.push(h.p); link(tg, h.p, h.n, u);
      }
      out.push([M.turret, mesh(tg, mats().link, 'kit_links_turret')]);
    }
  },
  sight(M, out, info, pl) {
    const sp = pl.spots.sight; if (!sp) return;
    const S = pl.S, col = [], gl = [], blk = [];
    // footprint: four corner rays; the plinth reaches down to the lowest so it sits on the roof everywhere
    const hs = [[-0.13, -0.15], [0.13, -0.15], [-0.13, 0.15], [0.13, 0.15], [0, 0]].map(([dx, dz]) => down(S, sp.x + dx, sp.z + dz, pl.sv.yMax + 1)).filter(h => h && h.n.y > 0.3);
    if (hs.length < 3) return;
    const hi = Math.max(...hs.map(h => h.p.y)), lo = Math.min(...hs.map(h => h.p.y));
    // plinth: a box whose bottom vertices are dropped onto the roof under each of them (welded on, 5 mm in)
    const plinth = new THREE.BoxGeometry(0.28, 0.1, 0.32); plinth.translate(sp.x, hi, sp.z);
    { const pa = plinth.attributes.position; for (let i = 0; i < pa.count; i++) if (pa.getY(i) < hi) { const h = down(S, pa.getX(i), pa.getZ(i), pl.sv.yMax + 1); pa.setY(i, (h && h.p.y > lo - 0.15 ? h.p.y : lo) - 0.005); } else pa.setY(i, hi + 0.05); }
    col.push(prep(plinth));
    const y0 = hi + 0.05;
    const body = new THREE.BoxGeometry(0.32, 0.26, 0.4); const pa = body.attributes.position; for (let i = 0; i < pa.count; i++) if (pa.getY(i) > 0 && pa.getZ(i) > 0) pa.setZ(i, pa.getZ(i) - 0.07);   // sloped armoured front
    body.translate(sp.x, y0 + 0.13, sp.z); col.push(prep(body));
    const hood = new THREE.BoxGeometry(0.36, 0.025, 0.3); hood.translate(sp.x, y0 + 0.272, sp.z + 0.02); col.push(prep(hood));
    for (const s of [-1, 1]) { const door = new THREE.BoxGeometry(0.012, 0.16, 0.12); door.rotateY(s * 0.5); door.translate(sp.x + s * 0.17, y0 + 0.13, sp.z + 0.2); col.push(prep(door)); }
    const win = new THREE.BoxGeometry(0.24, 0.13, 0.012); win.translate(sp.x, y0 + 0.13, sp.z + 0.196); gl.push(prep(win));
    const conduit = [V3(sp.x - 0.16, y0 + 0.08, sp.z - 0.1), V3(sp.x - 0.22, y0 + 0.02, sp.z - 0.18), V3(sp.x - 0.22, lo + 0.015, sp.z - 0.3)];
    const cd = down(S, conduit[2].x, conduit[2].z, pl.sv.yMax + 1); if (cd && cd.p.y > lo - 0.2) conduit[2].y = cd.p.y + 0.012;
    for (let i = 0; i < 2; i++) tube(blk, conduit[i], conduit[i + 1], 0.014, 5);
    out.push([S.node, mesh(col, mats().box, 'kit_sight')], [S.node, mesh(gl, mats().glass, 'kit_sight_lens')], [S.node, mesh(blk, mats().cable, 'kit_sight_cable')]);
  },
  ew(M, out, info, pl) {
    const sp = pl.spots.ew; if (!sp) return;
    const S = sp.S || pl.S, yStart = sp.top || pl.sv.yMax + 1, col = [], blk = [], st = [];
    // tube stand: 4 legs welded to the roof (each leg its own ray), a deck plate, the jammer box, a ring of whips
    const legs = [[-0.2, -0.15], [0.2, -0.15], [-0.2, 0.15], [0.2, 0.15]].map(([dx, dz]) => ({ dx, dz, h: down(S, sp.x + dx, sp.z + dz, yStart) }));
    if (legs.filter(l => l.h && l.h.n.y > 0.3).length < 4) return;
    const deck = Math.max(...legs.map(l => l.h.p.y)) + 0.14;
    for (const l of legs) { tube(st, l.h.p.clone().add(V3(0, -0.01, 0)), V3(sp.x + l.dx, deck, sp.z + l.dz), 0.016, 6); weldPlate(st, l.h.p, l.h.n, 0.07); }
    for (const [a, b] of [[0, 1], [2, 3], [0, 2], [1, 3]]) { const A = legs[a], B = legs[b]; const ym = (deck + Math.max(A.h.p.y, B.h.p.y)) / 2; tube(st, V3(sp.x + A.dx, ym, sp.z + A.dz), V3(sp.x + B.dx, ym, sp.z + B.dz), 0.01, 5); }
    const plate = new THREE.BoxGeometry(0.5, 0.012, 0.38); plate.translate(sp.x, deck + 0.006, sp.z); st.push(prep(plate));
    const box = new THREE.BoxGeometry(0.44, 0.2, 0.32); box.translate(sp.x, deck + 0.112, sp.z); col.push(prep(box));
    for (const sxx of [-1, 1]) for (let i = 0; i < 4; i++) { const f = new THREE.BoxGeometry(0.006, 0.12, 0.26); f.translate(sp.x + sxx * (0.226 + i * 0.0), deck + 0.1, sp.z); if (i === 0) col.push(prep(f)); }   // heat-sink plates on the box ends
    const lid = new THREE.BoxGeometry(0.46, 0.02, 0.34); lid.translate(sp.x, deck + 0.222, sp.z); col.push(prep(lid));
    // antennas: 6 whips in a ring on the lid (different bands, different lengths), black bases + a cable down to the roof
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2, x = sp.x + Math.cos(a) * 0.16, z = sp.z + Math.sin(a) * 0.12, L = [0.55, 0.42, 0.7, 0.5, 0.62, 0.45][i];
      const b = new THREE.CylinderGeometry(0.022, 0.026, 0.06, 8); b.translate(x, deck + 0.262, z); blk.push(prep(b));
      const w = new THREE.CylinderGeometry(0.005, 0.009, L, 5); w.translate(x, deck + 0.29 + L / 2, z); blk.push(prep(w));
    }
    tube(blk, V3(sp.x + 0.22, deck + 0.08, sp.z - 0.1), V3(sp.x + 0.3, legs[1].h.p.y + 0.012, sp.z - 0.2), 0.012, 5);
    out.push([S.node, mesh(col, mats().box, 'kit_ew')], [S.node, mesh(st, mats().steel, 'kit_ew_stand')], [S.node, mesh(blk, mats().black, 'kit_ew_antennas')]);
  },
  smoke(M, out, info, pl) {
    const S = pl.S, P = S.P, sv = pl.sv, geos = [], caps = [];
    for (const sx of [-1, 1]) {
      // candidate spots on the turret side (front half first); the bracket arm is as long as needed to keep every tube
      // 6 cm clear of the turret (tube ends probed by rays), and a spot needing an arm over 0.2 m is skipped
      let h = null, n, out_, al, tubes, arm;
      for (const fz of [0.62, 0.55, 0.7, 0.48, 0.4, 0.3]) for (const dy of [0.16, 0.24, 0.1, 0.3]) {
        if (h) break;
        const c = cast(S.meshes, S.node, V3(sx * 6, sv.yEdge - dy, P.q('z', fz)), V3(-sx, 0, 0)); if (!c || Math.abs(c.n.y) > 0.5 || Math.abs(c.n.x) < 0.6) continue;
        const n_ = c.n, o_ = n_.clone().setY(0).normalize(), a_ = new THREE.Vector3().crossVectors(UP, o_).normalize();
        const tb = k => Array.from({ length: 4 }, (_, i) => { const dir = o_.clone().multiplyScalar(0.7).add(V3(0, 0.62, 0)).add(V3(0, 0, 0.42)).normalize().applyAxisAngle(UP, sx * (i - 1.5) * 0.1); const foot = c.p.clone().add(o_.clone().multiplyScalar(k)).add(a_.clone().multiplyScalar((i - 1.5) * 0.075)); return [foot, foot.clone().add(dir.multiplyScalar(0.3))]; });
        let k = 0.1;
        for (let it = 0; it < 6; it++) {
          let need = 0; for (const [f, e] of tb(k)) for (const q of [f, e, f.clone().lerp(e, 0.5)]) { const back = cast(S.meshes, S.node, q.clone().add(o_.clone().multiplyScalar(0.5)), o_.clone().negate(), 1.0); if (back && back.dist - 0.5 < 0.06) need = Math.max(need, 0.06 - (back.dist - 0.5)); }   // clearance of q from the turret along the side normal
          if (need <= 0) break; k += need + 0.01;
        }
        if (k > 0.2) continue;
        h = c; n = n_; out_ = o_; al = a_; tubes = tb; arm = k;
      }
      if (!h) continue;
      weldPlate(geos, h.p, n, 0.1);
      tube(geos, h.p.clone().add(n.clone().multiplyScalar(0.006)), h.p.clone().add(out_.clone().multiplyScalar(arm)), 0.025, 6);
      const blk = new THREE.BoxGeometry(0.06, 0.06, 0.32); blk.applyMatrix4(new THREE.Matrix4().makeBasis(out_, UP, al).setPosition(h.p.clone().add(out_.clone().multiplyScalar(arm)))); geos.push(prep(blk));
      for (const [f, e] of tubes(arm)) {
        tube(geos, f, e, 0.045, 8);
        const dir = e.clone().sub(f).normalize(), cap = new THREE.CylinderGeometry(0.036, 0.036, 0.01, 8); cap.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir)); cap.translate(e.x, e.y, e.z); caps.push(prep(cap));
      }
    }
    out.push([S.node, mesh(geos, mats().link, 'kit_smoke')], [S.node, mesh(caps, mats().black, 'kit_smoke_caps')]);
  },
  crew() {},
};
const ORDER = ['ew', 'sight', 'cage', 'roof', 'era', 'sandbags', 'smoke', 'crew'];

// ---------------------------------------------------------------- public API
// add the kit meshes for `kits` to a vehicle model (a clone of the GLB scene); returns the meshes. info.wheeled: BTR /
// Bohdana style hull (sandbags rather than track links); info.kind: btr / ifv / tank / spg.
const CACHE = new Map();
export function attachKits(model, kits, info = {}) {
  removeKits(model);
  if (!kits?.length) return [];
  const ks = ORDER.filter(k => kits.includes(k));
  const hullGeo = model.getObjectByName('hull_geo') || (() => { let g = null; model.traverse(o => { if (!g && o.isMesh) g = o; }); return g; })();
  const key = (hullGeo?.geometry?.uuid || model.uuid) + '|' + ks.join(',') + '|' + !!info.wheeled + '|' + (info.kind || '');
  let recipe = CACHE.get(key);
  if (!recipe) {
    const M = measure(model); if (!M.H.n) return [];
    const pl = plan(M, ks, info), out = []; info = { ...info, _pl: pl };
    for (const k of ks) { const n0 = out.length; try { BUILD[k]?.(M, out, info, pl); } catch (e) { console.warn('vehicleKit', k, e); } for (const e of out.slice(n0)) if (e[1]) e[1].userData.kitId = k; }
    recipe = out.filter(([p, m]) => p && m).map(([p, m]) => ({ parent: p === M.turret ? 'turret' : 'hull', geo: m.geometry, mat: m.material, name: m.name, kitId: m.userData.kitId }));
    if (CACHE.size > 64) CACHE.clear();
    CACHE.set(key, recipe);
  }
  const made = [];
  for (const r of recipe) {
    const parent = model.getObjectByName(r.parent) || model; const m = new THREE.Mesh(r.geo, r.mat);
    m.name = r.name; m.castShadow = m.receiveShadow = true; m.userData = { kit: true, kitShared: true, kitId: r.kitId };
    parent.add(m); made.push(m);
  }
  return made;
}
export function removeKits(model) { const old = []; model.traverse(o => { if (o.userData?.kit) old.push(o); }); for (const o of old) { o.parent?.remove(o); if (!o.userData.kitShared) o.geometry?.dispose?.(); } }

// battle effects of the kits on one vehicle (KITS[k].fx summed); idempotent
export function applyKitFx(v, kits) {
  if (v.kitFx || !kits?.length) return;
  const fx = {}; for (const k of new Set(kits)) for (const [a, b] of Object.entries(KITS[k]?.fx || {})) fx[a] = (fx[a] || 0) + b;
  v.kits = [...new Set(kits)]; v.kitFx = fx;
  if (fx.cage) v.cage = Math.min(0.7, (v.cage || 0) + fx.cage);   // capped: screens and jammers never make a vehicle drone-proof
  if (fx.speed || fx.accel || fx.turret) {
    v.def = { ...v.def };
    if (fx.speed) v.def.speed *= 1 + fx.speed;
    if (fx.accel) v.def.accel *= 1 + fx.accel;
    if (fx.turret && v.def.turretSpeed) v.def.turretSpeed *= 1 + fx.turret;
  }
  if ((fx.era || fx.side) && v.zones) {
    v.zones = v.zones.map(z => ({ ...z, faces: Object.fromEntries(Object.entries(z.faces).map(([f, a]) => [f, { ...a, ...(a.era ? { era: { ...a.era } } : {}) }])) }));
    for (const z of v.zones) {
      if (/track|wheel|tow|ammo|engine|crew|driver|gunner|commander/i.test(z.name)) continue;
      const fr = z.faces.front;
      if (fx.era && fr && !/rear|body|bonnet/.test(z.name)) {
        if (fr.era) { fr.era.ce = Math.round(fr.era.ce * 1.15); fr.era.ke = Math.round((fr.era.ke || 0) * 1.1); }
        else fr.era = { ke: v.kind === 'tank' ? 60 : 10, ce: v.kind === 'tank' ? 300 : 200 };
        v.eraLeft[z.name + ':front'] = 1;
      }
      const sd = z.faces.side;
      if (fx.side && sd && !/turret|era_/.test(z.name)) { sd.ce += fx.side; sd.ke += Math.round(fx.side * 0.25); }
    }
  }
  if (fx.smoke) {
    v.smokeLeft = fx.smoke; let lastHp = v.hp; const up = v.update.bind(v), g = v.game;
    v.update = dt => {
      up(dt);
      if (v.smokeLeft > 0 && !v.destroyed && v.hp < lastHp - 1 && g.time > (v.smokeT || 0)) {
        v.smokeLeft--; v.smokeT = g.time + 15;
        const a = v.heading + (v.turretYaw || 0), p = v.pos.clone().add(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).multiplyScalar(16));
        g.fx?.smokeScreen?.(p); const o = g.nav?.addOccluder?.(p.x, p.z, 7, 7, 0, 7, null); if (o) o.smokeUntil = g.time + 30;
        g.sfx?.('grenade_throw', v.pos);
      }
      lastHp = v.hp;
    };
  }
  if (fx.sight) patchSights(v.game);
}
// stabilised thermal sight: shots on the move sometimes without the movement penalty, a better first round on a
// new target (tank / 100 mm guns). Wraps the combat calls once per game.
function patchSights(g) {
  const C = g?.combat; if (!C || C._kitSight) return; C._kitSight = true;
  const wrap = (fn, tank) => function (v, ...a) {
    const s = v?.kitFx?.sight || 0; if (!s) return fn.call(this, v, ...a);
    const t = tank ? a[0] : a[1];
    if (tank && t && v.lastTarget !== t && Math.random() < s) { v.lastTarget = t; v.rangedShots = 0; }
    if (Math.abs(v.speed) > 1 && Math.random() < s) { const sp = v.speed; v.speed = 0; try { return fn.call(this, v, ...a); } finally { v.speed = sp; } }
    return fn.call(this, v, ...a);
  };
  if (C.fireTankGun) C.fireTankGun = wrap(C.fireTankGun, true);
  if (C.fireVehicleGun) C.fireVehicleGun = wrap(C.fireVehicleGun, false);
}

// a battle vehicle: visuals + effects for its side's campaign kits (game.mods[side].kits[kind]); idempotent.
// Called from the Vehicle constructor (src/game/vehicle.js) and from campaignBattle.applyMods. A random field cage
// (Vehicle.addCage, BTRs) is the same kit mesh; it stays when the issued kits do not include a cage.
export function applyVehicleKits(v) {
  if (v.kitDone || v.fallback) return; const kits = v.game?.mods?.[v.side]?.kits?.[v.kind]; if (!kits?.length) return;
  v.kitDone = true;
  const vis = v.cageMesh && !kits.includes('cage') ? [...kits, 'cage'] : kits;
  if (kits.includes('cage') && v.cageMesh) v.cage = 0;   // the random field cage gives way to the issued one
  v.cageMesh = null;
  try { attachKits(v.model, vis, { wheeled: !!v.def?.wheeled || v.kind === 'btr', kind: v.kind }); } catch (e) { console.warn('vehicleKit attach', e); }
  applyKitFx(v, kits);
}
// the random field cage some BTRs carry without any campaign kit (Vehicle.addCage)
export function fieldCage(v) { const made = attachKits(v.model, ['cage'], { wheeled: true, kind: v.kind }); return made.length ? made : null; }
