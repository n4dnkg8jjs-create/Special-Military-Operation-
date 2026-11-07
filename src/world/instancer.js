import * as THREE from 'three';
import { MeshoptSimplifier } from '../../vendor/meshopt/meshopt_simplifier.module.js';
import { markStatic, STATIC_SHADOW } from '../engine/renderer.js';
import { treeImpostor } from './impostor.js';

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
  const P = { template, matrices, opts, parts: [] }; PLACED.push(P);   // parts: [meshes, placement index per instance] (world/treeDamage.js edits single trees)
  // group placements by spatial cell so each InstancedMesh can be frustum/shadow culled
  // opts.cell: own cell size (m) for many small, cheap instances (fewer, larger InstancedMeshes = fewer draw calls)
  const cells = new Map(), v = new THREE.Vector3(), CS = opts.cell || CELL;
  matrices.forEach((M, i) => { v.setFromMatrixPosition(M); const k = Math.floor(v.x / CS) + ',' + Math.floor(v.z / CS); (cells.get(k) || cells.set(k, []).get(k)).push(i); });
  const groups = new Map(), K = opts.coarse && opts.lod ? opts.coarse : 0;
  if (K) {
    const by = new Map(); matrices.forEach((M, i) => { v.setFromMatrixPosition(M); const k = Math.floor(v.x / (CELL * K)) + ',' + Math.floor(v.z / (CELL * K)); (by.get(k) || by.set(k, []).get(k)).push(i); });
    for (const [k, ids] of by) { const far = instanceOne(scene, opts.lod, ids.map(i => matrices[i]), { shadows: opts.lodShadows ?? opts.shadows ?? true }); P.parts.push([far, ids]); for (const m of far) m.visible = false; const G = { far, cells: [], on: false }; groups.set(k, G); GROUPS.push(G); }
  }
  const out = [];
  for (const [key, idx] of cells) {
    const sub = idx.map(i => matrices[i]), o = { ...opts, colors: opts.colors ? idx.map(i => opts.colors[i]) : null };
    const near = instanceOne(scene, template, sub, o); out.push(...near); P.parts.push([near, idx]);
    if (opts.lodDist || opts.cullDist) {
      const [cx, cz] = key.split(',').map(Number);
      const far = opts.lod ? instanceOne(scene, opts.lod, sub, { ...o, shadows: opts.lodShadows ?? o.shadows }) : [];
      const mid = opts.mid ? instanceOne(scene, opts.mid, sub, { ...o, shadows: opts.midShadows ?? o.shadows }) : [];
      P.parts.push([far, idx], [mid, idx]);
      const d1 = opts.lodDist || opts.cullDist;
      const L = { near, mid, far, cx: (cx + 0.5) * CS, cz: (cz + 0.5) * CS, dm: opts.mid ? Math.min(opts.nearDist || 60, d1) : d1, d1, d2: opts.cullDist || 1e9, state: -1, hr: CS * 0.5 };
      if (K) { L.group = groups.get(Math.floor((cx + 0.5) * CS / (CELL * K)) + ',' + Math.floor((cz + 0.5) * CS / (CELL * K))); L.group?.cells.push(L); }
      LODS.push(L);
    }
  }
  return out;
}
// static shadow cache (engine/renderer.js): ONE level of a LOD set casts into the cache whatever the camera distance (the
// coarsest level that casts: sub-texel at the shadow map's ~6-11 cm texels), the others never do, so LOD switches while
// the camera moves do not force a cache redraw.  Only when every casting level is a cached static.
function shadowLevel(L) {
  L.sd = true;
  const lv = [L.far, L.mid, L.near].filter(a => a && a.length).map(ms => ms.filter(m => m.castShadow));
  if (lv.some(ms => ms.some(m => !STATIC_SHADOW.has(m)))) return;
  const pick = lv.findIndex(ms => ms.length); if (pick < 0) return;
  lv.forEach((ms, i) => { for (const m of ms) m.userData.shadowMode = i === pick ? 'always' : 'skip'; });
  if (L.group) for (const m of L.group.far) if (STATIC_SHADOW.has(m)) m.userData.shadowMode = 'skip';   // (coarse far block: the cells' level covers it)
}
// call once per frame (cheap: a few hundred cells)
export function updateLods(cam) {
  for (const L of LODS) {
    if (!L.sd) shadowLevel(L);
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
    // cached shadow (engine/renderer.js: same depth material variants as three's shadow pass, alpha-tested cards
    // included), unless a cut-out / two-sided material has its own shader edits (it may move vertices: wind)
    if (im.castShadow && !mats.some(mm => mm.transparent || mm.alphaToCoverage || ((mm.alphaTest > 0 || mm.side !== THREE.FrontSide || mm.shadowSide != null) && Object.hasOwn(mm, 'onBeforeCompile') && !mm.userData.alphaCov && !mm.userData.staticOk))) markStatic(im);   // (wear.js alphaCoverage / charred / ruin shells: fragment only)
    scene.add(im); out.push(im);
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
// distance LOD for the big leafy street trees that ship without one (leafy_summer_birch / _chestnut: 6-7.7k triangles,
// ~80 % of them bark: branch tubes): mid / far = the same tree with the bark simplified to 4 / 8 cm absolute error (the
// leaf cards are kept as they are: the crown is unchanged).  nearDist / lodDist are cell-edge distances (instancer cells):
// the first simplified level starts >= ~70 m from the camera (< ~1.2 px at 1620 px tall), the second >= ~180 m.
// With impostors (world/impostor.js: leafy templates, shadow cache on) the far level is a camera-facing quad per tree
// (casts no shadow: the cache draws the mid level instead).
export function treeLod(template, nearDist = 90, lodDist = 200) {
  const mid = simplified(template, 0, 0.04, true), imp = mid && treeImpostor(template);
  if (imp) return { mid, lod: imp, nearDist, lodDist, lodShadows: false };
  const far = simplified(template, 0, 0.08, true);
  return mid && far ? { mid, lod: far, nearDist, lodDist } : {};
}
// instance() options for such a template: full detail near the camera, the simplified copy further out; 120 m cells
// (rubble is scattered thinly: the 90 m default made ~15 cells x 12 heap types = 180 InstancedMeshes, each drawn in
// the main and the shadow pass, most holding 2-4 heaps)
export function farLod(template, lodDist = 90, cell = 120) { const lod = simplified(template); return lod ? { lod, lodDist, cell } : { cell }; }

// ---- curbs and other long rows of identical boxes (one 1 m kerb stone per metre along every street: tens of thousands
// of 12-triangle instances, most of them only a pixel or two tall at RTS range).  Near the camera the boxes are
// instanced as before; beyond lodDist (cell-edge distance) each straight unbroken run of them inside a cell is ONE box
// (same section, the UVs repeat along it, no bottom face), merged per cell.  Runs break at gaps, bends and cell edges.
// The far level also carries the shadow in the static shadow cache.  ?curbruns=0: plain instancing.
export function instanceRuns(scene, template, matrices, { cell = 160, lodDist = 100, cullDist, ...opts } = {}) {
  let on = true; try { on = new URLSearchParams(location.search).get('curbruns') !== '0'; } catch { /* */ }
  const p = template.geometry?.parameters;
  if (!on || !template.geometry?.isBufferGeometry || !(p?.width > 0) || template.geometry.type !== 'BoxGeometry') return instance(scene, template, matrices, { cell, cullDist, ...opts });
  const n0 = LODS.length, out = instance(scene, template, matrices, { cell, lodDist, cullDist: cullDist || 1e9, ...opts });
  const W = p.width;
  const pos = new THREE.Vector3(), q = new THREE.Vector3(), key = v => Math.floor(v.x / cell) + ',' + Math.floor(v.z / cell);
  const info = matrices.map(M => { const e = M.elements, L = Math.hypot(e[0], e[2]) || 1; return { x: e[12], y: e[13], z: e[14], ux: e[0] / L, uz: e[2] / L, s: Math.hypot(e[0], e[1], e[2]) }; });
  const runs = new Map();   // cell key -> geometries
  const flush = (a, b) => {
    const A = info[a], B = info[b], s = A.s, half = W * s / 2;
    let ux = B.x - A.x, uz = B.z - A.z; const d = Math.hypot(ux, uz); if (d > 1e-3) { ux /= d; uz /= d; } else { ux = A.ux; uz = A.uz; }
    const L = d + 2 * half, cx = (A.x + B.x) / 2, cz = (A.z + B.z) / 2, cy = (A.y + B.y) / 2;
    const g = new THREE.BoxGeometry(L, p.height * s, p.depth * s);
    const uv = g.attributes.uv; for (let i = 8; i < 24; i++) uv.setX(i, uv.getX(i) * L / (W * s));   // (faces py, ny, pz, nz run along x)
    const idx = Array.from(g.index.array); idx.splice(18, 6); g.setIndex(idx);                          // (no bottom face)
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(cx, cy, cz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-uz, ux)), new THREE.Vector3(1, 1, 1)));
    pos.set(cx, 0, cz); const k = key(pos); (runs.get(k) || runs.set(k, []).get(k)).push(g);
  };
  let s = 0;
  for (let i = 1; i <= info.length; i++) {
    const A = info[i - 1], B = info[i];
    const join = B && Math.hypot(B.x - A.x, B.z - A.z) < W * A.s * 1.25 && Math.abs(A.ux * B.uz - A.uz * B.ux) < 0.06 && A.ux * B.ux + A.uz * B.uz > 0.9 && Math.abs(B.y - A.y) < 0.15
      && Math.abs((B.x - info[s].x) * info[s].uz - (B.z - info[s].z) * info[s].ux) < 0.08 && key(pos.set(A.x, 0, A.z)) === key(q.set(B.x, 0, B.z));
    if (!join) { flush(s, i - 1); s = i; }
  }
  const mat = Array.isArray(template.material) ? template.material[0] : template.material;
  for (const L of LODS.slice(n0)) {
    const k = Math.floor(L.cx / cell) + ',' + Math.floor(L.cz / cell), gs = runs.get(k); if (!gs) continue;
    const g = mergeGeos(gs); const m = new THREE.Mesh(g, mat); m.name = (template.name || 'row') + '_runs';
    m.castShadow = opts.shadows !== false; m.receiveShadow = true; m.matrixAutoUpdate = false; m.visible = false; scene.add(m);
    if (m.castShadow) markStatic(m);
    L.far = [m]; L.state = -1; L.sd = false;
  }
  return out;
}
function mergeGeos(gs) {
  let nv = 0, ni = 0; for (const g of gs) { nv += g.attributes.position.count; ni += g.index.count; }
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), U = new Float32Array(nv * 2), I = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let v = 0, j = 0;
  for (const g of gs) { P.set(g.attributes.position.array, v * 3); N.set(g.attributes.normal.array, v * 3); U.set(g.attributes.uv.array, v * 2); const ix = g.index.array; for (let t = 0; t < ix.length; t++) I[j++] = ix[t] + v; v += g.attributes.position.count; g.dispose(); }
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(P, 3)); out.setAttribute('normal', new THREE.BufferAttribute(N, 3)); out.setAttribute('uv', new THREE.BufferAttribute(U, 2)); out.setIndex(new THREE.BufferAttribute(I, 1)); out.computeBoundingSphere();
  return out;
}
