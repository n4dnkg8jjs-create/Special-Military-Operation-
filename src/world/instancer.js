import * as THREE from 'three';

// Turns N placements of an Object3D template into one InstancedMesh per sub-mesh.
const CELL = 90;
// Distance LOD per cell: {near, mid, far, cx, cz, dm, d1, d2}. near shown < dm, mid (optional) dm..d1, far (optional)
// d1..d2, nothing beyond d2. opts: lod (far template), mid (mid template) + nearDist (near -> mid), lodDist, cullDist.
// opts.coarse = k: the far level is also instanced per (k x CELL) block; while every cell of a block is far the block's
// single instanced mesh draws instead of the k*k per-cell ones (cuts the overview draw calls of trees ~k*k-fold).
export const LODS = [];
export const GROUPS = [];
export function instance(scene, template, matrices, opts = {}) {
  // group placements by spatial cell so each InstancedMesh can be frustum/shadow culled
  const cells = new Map(), v = new THREE.Vector3();
  matrices.forEach((M, i) => { v.setFromMatrixPosition(M); const k = Math.floor(v.x / CELL) + ',' + Math.floor(v.z / CELL); (cells.get(k) || cells.set(k, []).get(k)).push(i); });
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
      const L = { near, mid, far, cx: (cx + 0.5) * CELL, cz: (cz + 0.5) * CELL, dm: opts.mid ? Math.min(opts.nearDist || 60, d1) : d1, d1, d2: opts.cullDist || 1e9, state: -1 };
      if (K) { L.group = groups.get(Math.floor(cx / K) + ',' + Math.floor(cz / K)); L.group.cells.push(L); }
      LODS.push(L);
    }
  }
  return out;
}
// call once per frame (cheap: a few hundred cells)
export function updateLods(cam) {
  for (const L of LODS) {
    const d = Math.max(0, Math.hypot(cam.x - L.cx, cam.z - L.cz, cam.y * 0.6) - CELL * 0.5);
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
    scene.add(im); out.push(im);
  });
  return out;
}

export function trs(x, y, z, ry = 0, s = 1, rx = 0, rz = 0) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(s, s, s));
}
