import * as THREE from 'three';
import { MeshoptSimplifier } from '../../vendor/meshopt/meshopt_simplifier.module.js';
import { markStatic } from '../engine/renderer.js';

// Turns N placements of an Object3D template into one InstancedMesh per sub-mesh.
const CELL = 90;
// Distance LOD per cell: {near, mid, far, cx, cz, dm, d1, d2}. near shown < dm, mid (optional) dm..d1, far (optional)
// d1..d2, nothing beyond d2. opts: lod (far template), mid (mid template) + nearDist (near -> mid), lodDist, cullDist.
// opts.coarse = k: the far level is also instanced per (k x CELL) block; while every cell of a block is far the block's
// single instanced mesh draws instead of the k*k per-cell ones (cuts the overview draw calls of trees ~k*k-fold).
export const LODS = [];
export const GROUPS = [];
// every placement, by template, so game code can derive gameplay data (e.g. vegetation line-of-sight occluders)
export const PLACED = [];
export function instance(scene, template, matrices, opts = {}) {
  PLACED.push({ template, matrices, opts });
  // group placements by spatial cell so each InstancedMesh can be frustum/shadow culled
  // opts.cell: own cell size (m) for many small, cheap instances (fewer, larger InstancedMeshes = fewer draw calls)
  const cells = new Map(), v = new THREE.Vector3(), CS = opts.cell || CELL;
  matrices.forEach((M, i) => { v.setFromMatrixPosition(M); const k = Math.floor(v.x / CS) + ',' + Math.floor(v.z / CS); (cells.get(k) || cells.set(k, []).get(k)).push(i); });
  const groups = new Map(), K = opts.coarse && opts.lod ? opts.coarse : 0;
  if (K) {
    const by = new Map(); matrices.forEach((M, i) => { v.setFromMatrixPosition(M); const k = Math.floor(v.x / (CELL * K)) + ',' + Math.floor(v.z / (CELL * K)); (by.get(k) || by.set(k, []).get(k)).push(M); });
    for (const [k, mats] of by) { const far = instanceOne(scene, opts.lod, mats, { shadows: opts.lodShadows ?? opts.shadows ?? true }); for (const m of far) m.visible = false; const G = { far, cells: [], on: false }; groups.set(k, G); GROUPS.push(G); }
  }
  const out = [];
  for (const [key, idx] of cells) {
    const sub = idx.map(i => matrices[i]), o = { ...opts, colors: opts.colors ? idx.map(i => opts.colors[i]) : null };
    const near = instanceOne(scene, template, sub, o); out.push(...near);
    if (opts.lodDist || opts.cullDist) {
      const [cx, cz] = key.split(',').map(Number);
      const far = opts.lod ? instanceOne(scene, opts.lod, sub, { ...o, shadows: opts.lodShadows ?? o.shadows }) : [];
      const mid = opts.mid ? instanceOne(scene, opts.mid, sub, { ...o, shadows: opts.midShadows ?? o.shadows }) : [];
      const d1 = opts.lodDist || opts.cullDist;
      const L = { near, mid, far, cx: (cx + 0.5) * CS, cz: (cz + 0.5) * CS, dm: opts.mid ? Math.min(opts.nearDist || 60, d1) : d1, d1, d2: opts.cullDist || 1e9, state: -1, hr: CS * 0.5 };
      if (K) { L.group = groups.get(Math.floor((cx + 0.5) * CS / (CELL * K)) + ',' + Math.floor((cz + 0.5) * CS / (CELL * K))); L.group?.cells.push(L); }
      LODS.push(L);
    }
  }
  return out;
}
// call once per frame (cheap: a few hundred cells)
export function updateLods(cam) {
  for (const L of LODS) {
    const d = Math.max(0, Math.hypot(cam.x - L.cx, cam.z - L.cz, cam.y * 0.6) - (L.hr ?? CELL * 0.5));
    const st = d < (L.dm ?? L.d1) ? 0 : d < L.d1 ? 1 : d < L.d2 ? 2 : 3;
    if (st === L.state) continue; L.state = st;
    for (const m of L.near) m.visible = st === 0;
    if (L.mid) for (const m of L.mid) m.visible = st === 1;
    const showFar = st === 2 && !(L.group && L.group.on);
    for (const m of L.far) m.visible = showFar;
  }
  for (const G of GROUPS) {
    let all = true, any = false; for (const c of G.cells) { if (c.state < 2) { all = false; break; } if (c.state === 2) any = true; }
    const on = all && any;
    if (on === G.on) continue; G.on = on;
    for (const m of G.far) m.visible = on;
    for (const c of G.cells) { const show = !on && c.state === 2; for (const m of c.far) m.visible = show; }
  }
}
function instanceOne(scene, template, matrices, { shadows = true, colors = null } = {}) {
  template.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(template.matrixWorld).invert();
  const out = [];
  template.traverse(o => {
    if (!o.isMesh || o.isSkinnedMesh) return;
    const rel = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const im = new THREE.InstancedMesh(o.geometry, o.material, matrices.length);
    const m = new THREE.Matrix4();
    matrices.forEach((M, i) => { m.multiplyMatrices(M, rel); im.setMatrixAt(i, m); if (colors) im.setColorAt(i, colors[i]); });
    im.castShadow = shadows && !mats.some(mm => mm.transparent); im.receiveShadow = true;
    im.computeBoundingSphere(); im.name = o.name;
    im.matrixAutoUpdate = false;   // static: the per-instance matrices carry the placement (no per-frame matrix recompose)
    scene.add(im); out.push(im);
    if (im.castShadow && !mats.some(mm => mm.transparent || mm.alphaTest > 0 || mm.alphaToCoverage || mm.side !== THREE.FrontSide || mm.shadowSide != null)) markStatic(im);   // cached shadow (engine/renderer.js; its depth pass draws back faces, as three does for FrontSide casters)
  });
  return out;
}

export function trs(x, y, z, ry = 0, s = 1, rx = 0, rz = 0) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(s, s, s));
}

// ---- distance LOD for heavy templates that ship without one (the scanned rubble heaps: 10-30k triangles each).
// simplified(t) = a clone of the template whose meshes share the original vertex buffers (positions, normals, UVs:
// exact at every kept vertex) with a simplified index buffer (meshoptimizer, attribute seams kept, max error 1.5 % of
// the mesh size: ~10 cm on a heap). Used for instances beyond ~90 m (5-6 cm per pixel there at 1080p). Await
// simplifierReady before building a world (WASM start-up); without WebAssembly the full mesh is used everywhere.
let simpOk = false;
export const simplifierReady = (MeshoptSimplifier.supported ? MeshoptSimplifier.ready.then(() => { simpOk = true; }) : Promise.resolve()).catch(() => {});
const simpGeo = new WeakMap(), simpTpl = new WeakMap();
export function simplifier() { return simpOk ? MeshoptSimplifier : null; }
function simplifyGeometry(geo, ratio, error, abs = false) {
  const key = ratio + '|' + error + '|' + abs; let byK = simpGeo.get(geo); if (byK?.has(key)) return byK.get(key);
  let out = geo;
  const pos = geo.attributes.position, idx = geo.index;
  if (pos && pos.itemSize === 3 && pos.count > 600) {
    // (positions packed: the GLBs store interleaved position / normal / uv)
    const P = new Float32Array(pos.count * 3); for (let i = 0; i < pos.count; i++) { P[i * 3] = pos.getX(i); P[i * 3 + 1] = pos.getY(i); P[i * 3 + 2] = pos.getZ(i); }
    const I = idx ? new Uint32Array(idx.array) : new Uint32Array(pos.count).map((_, i) => i);
    const target = Math.max(3, Math.floor(I.length * ratio / 3) * 3);
    const [res, err] = MeshoptSimplifier.simplify(I, P, 3, target, error, abs ? ['ErrorAbsolute'] : []);
    if (res.length < I.length * 0.8 && err <= error * 1.5) { out = geo.clone(); out.setIndex(new THREE.BufferAttribute(pos.count > 65535 ? res : new Uint16Array(res), 1)); out.userData.simplified = true; }
  }
  (byK ||= new Map()).set(key, out); simpGeo.set(geo, byK);
  return out;
}
export function simplified(template, ratio = 0.25, error = 0.015, abs = false) {
  if (!simpOk) return null;
  const key = ratio + '|' + error + '|' + abs; let byT = simpTpl.get(template); if (byT?.has(key)) return byT.get(key);
  let c = template.clone(true), any = false;
  c.traverse(o => { if (o.isMesh && !o.isSkinnedMesh) { const g = simplifyGeometry(o.geometry, ratio, error, abs); if (g !== o.geometry) { o.geometry = g; any = true; } } });
  if (!any) c = null; (byT ||= new Map()).set(key, c); simpTpl.set(template, byT);
  return c;
}
// instance() options for such a template: full detail near the camera, the simplified copy further out; 120 m cells
// distance LOD for the big leafy street trees that ship without one (leafy_summer_birch / _chestnut: 6-7.7k triangles,
// ~80 % of them bark: branch tubes): mid / far = the same tree with the bark simplified to 4 / 8 cm absolute error (the
// leaf cards are kept as they are: the crown is unchanged).  nearDist / lodDist are cell-edge distances (instancer cells):
// the first simplified level starts >= ~70 m from the camera (< ~1.2 px at 1620 px tall), the second >= ~180 m.
export function treeLod(template, nearDist = 90, lodDist = 200) {
  const mid = simplified(template, 0, 0.04, true), far = simplified(template, 0, 0.08, true);
  return mid && far ? { mid, lod: far, nearDist, lodDist } : {};
}
// (rubble is scattered thinly: the 90 m default made ~15 cells x 12 heap types = 180 InstancedMeshes, each drawn in
// the main and the shadow pass, most holding 2-4 heaps)
export function farLod(template, lodDist = 90, cell = 120) { const lod = simplified(template); return lod ? { lod, lodDist, cell } : { cell }; }
