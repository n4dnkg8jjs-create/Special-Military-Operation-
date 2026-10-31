import * as THREE from 'three';

// Turns N placements of an Object3D template into one InstancedMesh per sub-mesh.
const CELL = 90;
// Distance LOD per cell: {near, far, cx, cz, d1, d2}. near shown < d1, far (optional) shown d1..d2, nothing beyond d2.
export const LODS = [];
export function instance(scene, template, matrices, opts = {}) {
  // group placements by spatial cell so each InstancedMesh can be frustum/shadow culled
  const cells = new Map(), v = new THREE.Vector3();
  matrices.forEach((M, i) => { v.setFromMatrixPosition(M); const k = Math.floor(v.x / CELL) + ',' + Math.floor(v.z / CELL); (cells.get(k) || cells.set(k, []).get(k)).push(i); });
  const out = [];
  for (const [key, idx] of cells) {
    const sub = idx.map(i => matrices[i]), o = { ...opts, colors: opts.colors ? idx.map(i => opts.colors[i]) : null };
    const near = instanceOne(scene, template, sub, o); out.push(...near);
    if (opts.lodDist || opts.cullDist) {
      const [cx, cz] = key.split(',').map(Number);
      const far = opts.lod ? instanceOne(scene, opts.lod, sub, { ...o, shadows: opts.lodShadows ?? o.shadows }) : [];
      LODS.push({ near, far, cx: (cx + 0.5) * CELL, cz: (cz + 0.5) * CELL, d1: opts.lodDist || opts.cullDist, d2: opts.lod ? (opts.cullDist || 1e9) : (opts.cullDist || 1e9), state: -1 });
    }
  }
  return out;
}
// call once per frame (cheap: a few hundred cells)
export function updateLods(cam) {
  for (const L of LODS) {
    const d = Math.max(0, Math.hypot(cam.x - L.cx, cam.z - L.cz, cam.y * 0.6) - CELL * 0.5);
    const st = d < L.d1 ? 0 : d < L.d2 ? 1 : 2;
    if (st === L.state) continue; L.state = st;
    for (const m of L.near) m.visible = st === 0;
    for (const m of L.far) m.visible = st === 1;
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
