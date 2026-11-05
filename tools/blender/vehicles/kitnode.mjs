// Headless (no browser, no GPU) kit build for quick iteration: loads a vehicle GLB's node tree + mesh positions into
// three.js objects, runs src/game/vehicleKit.js attachKits and prints what was built (and the build time).
// Usage: node tools/blender/vehicles/kitnode.mjs <vehicle> [kits=cage,era,...] [out.glb]
//   out.glb: world-space export of the visible LOD0 meshes + kits (same format as vcheck.html export=1) for vcheck.py
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { attachKits } = await import(path.join(root, 'src/game/vehicleKit.js'));
const man = JSON.parse(fs.readFileSync(path.join(root, 'assets/vehicles/manifest.json'), 'utf8')).vehicles;

export function loadGlb(file) {
  const b = fs.readFileSync(file); const jl = b.readUInt32LE(12); const J = JSON.parse(b.subarray(20, 20 + jl).toString());
  const binOff = 20 + jl + 8, bin = b.subarray(binOff);
  const acc = i => { const a = J.accessors[i], bv = J.bufferViews[a.bufferView], n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type]; const C = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType]; const off = (bv.byteOffset || 0) + (a.byteOffset || 0); const stride = bv.byteStride || 0; if (stride && stride !== n * C.BYTES_PER_ELEMENT) { const out = new C(a.count * n), dv = new DataView(bin.buffer, bin.byteOffset + off); for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) out[i * n + k] = C === Float32Array ? dv.getFloat32(i * stride + k * 4, true) : C === Uint32Array ? dv.getUint32(i * stride + k * 4, true) : C === Uint16Array ? dv.getUint16(i * stride + k * 2, true) : dv.getUint8(i * stride + k); return { arr: out, n }; } return { arr: new C(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + a.count * n * C.BYTES_PER_ELEMENT)), n }; };
  const meshCache = {};
  const mkMesh = mi => { if (meshCache[mi]) return meshCache[mi]; const out = []; for (const pr of J.meshes[mi].primitives) { const g = new THREE.BufferGeometry(); const p = acc(pr.attributes.POSITION); g.setAttribute('position', new THREE.BufferAttribute(p.arr, 3)); if (pr.indices != null) { const ix = acc(pr.indices); g.setIndex(new THREE.BufferAttribute(ix.arr instanceof Uint8Array ? new Uint16Array(ix.arr) : ix.arr, 1)); } g.computeVertexNormals(); out.push(g); } return (meshCache[mi] = out); };
  const mk = i => {
    const nd = J.nodes[i]; const o = new THREE.Object3D(); o.name = nd.name || ''; o.userData = { ...(nd.extras || {}) };
    if (nd.matrix) new THREE.Matrix4().fromArray(nd.matrix).decompose(o.position, o.quaternion, o.scale);
    if (nd.translation) o.position.fromArray(nd.translation); if (nd.rotation) o.quaternion.fromArray(nd.rotation); if (nd.scale) o.scale.fromArray(nd.scale);
    let obj = o;
    if (nd.mesh != null) { const gs = mkMesh(nd.mesh); if (gs.length === 1) { const m = new THREE.Mesh(gs[0], new THREE.MeshBasicMaterial()); m.name = o.name; m.userData = o.userData; m.position.copy(o.position); m.quaternion.copy(o.quaternion); m.scale.copy(o.scale); obj = m; } else for (const g of gs) { const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); m.name = o.name; o.add(m); } }
    for (const c of nd.children || []) obj.add(mk(c));
    return obj;
  };
  const scene = new THREE.Group(); for (const r of J.scenes[J.scene || 0].nodes) scene.add(mk(r));
  return scene;
}
export function pose(scene, V, q = {}) {
  scene.traverse(o => { if (o.userData?.hidden && !/_LOD1$/.test(o.name)) o.visible = false; if (/_wreck$|_LOD1$/.test(o.name)) o.visible = false; });
  if (q.open) for (const [n, L] of Object.entries({ ...(V.hatch_lids || {}), ...(V.doors || {}) })) { const o = scene.getObjectByName(n); if (o) o.rotation[L.axis || 'x'] = L.open; }
  for (const r of (q.rot || '').split(';').filter(Boolean)) { const [n, ax, deg] = r.split(':'); const o = scene.getObjectByName(n); if (o) o.rotation[ax] += (+deg) * Math.PI / 180; }
  scene.updateMatrixWorld(true);
}
export const KK = { btr: 'cage,sandbags,sight,ew,smoke', ifv: 'era,cage,ew,sandbags', tank: 'cage,roof,era,sandbags,sight,ew,smoke', spg: 'cage' };
export const kindOf = V => V.kind === 'btr' ? 'btr' : V.kind === 'tank' ? 'tank' : V.kind === 'ifv' ? 'ifv' : 'spg';

if (process.argv[1] && process.argv[1].endsWith('kitnode.mjs')) {
  const [vn, kitsArg, outGlb, rot] = process.argv.slice(2); const V = man[vn];
  const scene = loadGlb(path.join(root, V.file)); pose(scene, V, { open: process.env.OPEN, rot: rot || process.env.ROT });
  const kind = kindOf(V), kits = (kitsArg && kitsArg !== 'all' ? kitsArg : KK[kind]).split(',');
  // kits are attached in the closed / straight pose (as in the game), then the pose is applied
  scene.traverse(o => { if (o.userData?._r0) {} });
  const t0 = performance.now();
  const made = attachKits(scene, kits, { wheeled: !!V.wheeled || V.kind === 'btr', kind });
  const ms = performance.now() - t0;
  console.log(vn, kits.join(','), `${Math.round(ms)} ms`, made.map(m => `${m.name}:${(m.geometry.attributes.position.count / 3) | 0}`).join(' '));
  if (outGlb) {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    globalThis.FileReader ??= class { readAsArrayBuffer(b) { b.arrayBuffer().then(r => { this.result = r; this.onloadend?.(); }); } readAsDataURL(b) { b.arrayBuffer().then(r => { this.result = 'data:application/octet-stream;base64,' + Buffer.from(r).toString('base64'); this.onloadend?.(); }); } };
    pose(scene, V, { open: process.env.OPEN, rot: rot || process.env.ROT });
    const sc = new THREE.Scene();
    scene.traverse(o => {
      if (!o.isMesh) return; for (let p = o; p; p = p.parent) if (!p.visible) return;
      let pth = [], p = o.parent; while (p && p !== scene) { if (/_LOD1$|_wreck$/.test(p.name)) return; pth.unshift(p.name); p = p.parent; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', o.geometry.attributes.position.clone()); if (o.geometry.index) g.setIndex(o.geometry.index.clone()); g.applyMatrix4(o.matrixWorld);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); m.name = o.name; m.userData = { path: pth.join('/'), kit: !!o.userData.kit }; sc.add(m);
    });
    const buf = await new GLTFExporter().parseAsync(sc, { binary: true });
    fs.writeFileSync(outGlb, Buffer.from(buf)); console.log('wrote', outGlb);
  }
}
