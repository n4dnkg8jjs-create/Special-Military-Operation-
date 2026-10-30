import * as THREE from 'three';

// Turns N placements of an Object3D template into one InstancedMesh per sub-mesh.
const CELL = 90;
export function instance(scene, template, matrices, opts = {}) {
  // group placements by spatial cell so each InstancedMesh can be frustum/shadow culled
  const cells = new Map(), v = new THREE.Vector3();
  matrices.forEach((M, i) => { v.setFromMatrixPosition(M); const k = Math.floor(v.x / CELL) + ',' + Math.floor(v.z / CELL); (cells.get(k) || cells.set(k, []).get(k)).push(i); });
  const out = [];
  for (const idx of cells.values()) out.push(...instanceOne(scene, template, idx.map(i => matrices[i]), { ...opts, colors: opts.colors ? idx.map(i => opts.colors[i]) : null }));
  return out;
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
