import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Procedural stand-ins used when a GLB is missing. Deliberately simple but correctly sized.
let concreteMat, sootMat, glassMat, frameMat;
function rnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function noiseCanvas(size, base, vari, seed = 1, blotch = 0) {
  const c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d');
  const img = x.createImageData(size, size), r = rnd(seed);
  for (let i = 0; i < size * size; i++) { const v = (r() - 0.5) * vari; img.data[i * 4] = base[0] + v; img.data[i * 4 + 1] = base[1] + v; img.data[i * 4 + 2] = base[2] + v; img.data[i * 4 + 3] = 255; }
  x.putImageData(img, 0, 0);
  for (let i = 0; i < blotch; i++) { x.fillStyle = `rgba(${r() < .5 ? '20,18,15' : '200,195,180'},${r() * 0.08})`; x.beginPath(); x.arc(r() * size, r() * size, r() * size * 0.15, 0, 7); x.fill(); }
  return c;
}
export function textureSet(name, renderer) {
  const spec = { asphalt: [[70, 70, 68], 40], concrete: [[150, 146, 138], 30], brick: [[178, 172, 160], 30], dirt: [[96, 84, 66], 45], rubble: [[120, 114, 104], 60] }[name] || [[128, 128, 128], 30];
  const t = new THREE.CanvasTexture(noiseCanvas(256, spec[0], spec[1], name.length * 7, 60));
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return { map: t };
}

function mats() {
  if (concreteMat) return;
  const t = new THREE.CanvasTexture(noiseCanvas(128, [168, 164, 154], 26, 3, 40)); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  concreteMat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.92, name: 'concrete_fb' });
  sootMat = new THREE.MeshStandardMaterial({ map: t, color: 0x5a5650, roughness: 0.95, name: 'concrete_soot_fb' });
  glassMat = new THREE.MeshStandardMaterial({ color: 0x0c0d0e, roughness: 0.25, metalness: 0.2, name: 'glass_fb' });
  frameMat = new THREE.MeshStandardMaterial({ color: 0x6a5a44, roughness: 0.8, name: 'frame_fb' });
}

function wallWithHole(W, H, T, hole, seed) {
  const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(W, 0); s.lineTo(W, H); s.lineTo(0, H); s.lineTo(0, 0);
  if (hole) { const p = new THREE.Path(); hole.forEach(([x, y], i) => i ? p.lineTo(x, y) : p.moveTo(x, y)); p.closePath(); s.holes.push(p); }
  const g = new THREE.ExtrudeGeometry(s, { depth: T, bevelEnabled: false }); g.translate(0, 0, -T);
  // planar UVs in metres / 3
  const pos = g.attributes.position, uv = g.attributes.uv; for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + pos.getZ(i)) / 3, pos.getY(i) / 3);
  return g;
}
function jagged(cx, cy, rx, ry, n, r) { const pts = []; for (let i = 0; i < n; i++) { const a = -i / n * Math.PI * 2, k = 0.65 + r() * 0.5; pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]); } return pts; }

export function panelKit(kit) {
  mats();
  const { W, H, T } = kit, out = {}, r = rnd(42);
  const win = [[W * 0.27, H * 0.3], [W * 0.73, H * 0.3], [W * 0.73, H * 0.82], [W * 0.27, H * 0.82]];
  const glass = () => { const g = new THREE.BoxGeometry(W * 0.46, H * 0.52, 0.04); g.translate(W * 0.5, H * 0.56, -T * 0.6); return g; };
  const frame = () => { const parts = []; const fw = 0.06;
    for (const [w, h, x, y] of [[W * 0.46, fw, W * .5, H * .3], [W * 0.46, fw, W * .5, H * .82], [fw, H * .52, W * .27, H * .56], [fw, H * .52, W * .73, H * .56], [fw, H * .52, W * .5, H * .56]]) { const b = new THREE.BoxGeometry(w, h, 0.08); b.translate(x, y, -T * 0.55); parts.push(b); }
    return mergeGeometries(parts); };
  const make = (base, holeIntact) => {
    out[base + '_intact'] = [{ geometry: wallWithHole(W, H, T, holeIntact), material: concreteMat }, ...(holeIntact ? [{ geometry: glass(), material: glassMat }, { geometry: frame(), material: frameMat }] : [])];
    out[base + '_damaged'] = [{ geometry: wallWithHole(W, H, T, holeIntact), material: sootMat }, ...(holeIntact ? [{ geometry: frame(), material: frameMat }] : [])];
    out[base + '_holed'] = [{ geometry: wallWithHole(W, H, T, jagged(W * .5, H * .5, W * .42, H * .4, 14, r)), material: sootMat }];
    const st = new THREE.Shape(); st.moveTo(0, 0); st.lineTo(W, 0); for (let i = 8; i >= 0; i--) st.lineTo(W * i / 8, 0.3 + r() * 0.7); st.closePath();
    const sg = new THREE.ExtrudeGeometry(st, { depth: T, bevelEnabled: false }); sg.translate(0, 0, -T);
    out[base + '_destroyed'] = [{ geometry: sg, material: sootMat }];
  };
  const door = [[W * 0.3, 0.02], [W * 0.7, 0.02], [W * 0.7, H * 0.85], [W * 0.3, H * 0.85]];
  make('wall_window', win); make('wall_balcony', door); make('wall_blank_end', null); make('wall_entrance', door);
  for (const k in out) out[k].size = new THREE.Vector3(W, H, T);
  const bal = new THREE.BoxGeometry(W * 0.9, 0.16, 1.1); bal.translate(W * 0.5, 0.08, 0.55);
  const rail = new THREE.BoxGeometry(W * 0.9, 1.0, 0.06); rail.translate(W * 0.5, 0.6, 1.08);
  out.balcony_slab = [{ geometry: mergeGeometries([bal, rail]), material: concreteMat }]; out.balcony_slab.size = new THREE.Vector3(W * .9, 1.1, 1.1);
  const par = new THREE.BoxGeometry(W, 0.6, T); par.translate(W / 2, 0.3, -T / 2);
  out.roof_parapet = [{ geometry: par, material: concreteMat }]; out.roof_parapet.size = new THREE.Vector3(W, 0.6, T);
  const can = new THREE.BoxGeometry(W * 0.8, 0.15, 1.4); can.translate(W / 2, 0.075, 0.7);
  out.entrance_canopy = [{ geometry: can, material: concreteMat }]; out.entrance_canopy.size = new THREE.Vector3(W * .8, .15, 1.4);
  return out;
}

// --- soldier fallback: capsule body with a separate armband so faction tape shows ---
export function soldier(tape) {
  const g = new THREE.Group();
  const uni = new THREE.MeshStandardMaterial({ color: 0x55573f, roughness: 0.9 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1.0, 4, 10), uni); body.position.y = 0.95; g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), new THREE.MeshStandardMaterial({ color: 0x4a4b3a, roughness: .8 })); head.position.y = 1.68; g.add(head);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.07, 12), new THREE.MeshStandardMaterial({ color: tape, roughness: .5 })); band.position.y = 1.3; g.add(band);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.9), new THREE.MeshStandardMaterial({ color: 0x1a1a1a })); gun.position.set(-0.15, 1.25, 0.35); g.add(gun);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// --- vehicle fallbacks with the contract hierarchy ---
export function vehicle(kind, camo) {
  const steel = new THREE.MeshStandardMaterial({ color: camo, roughness: 0.75, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1b19, roughness: 0.9 });
  const root = new THREE.Group(); root.name = 'root';
  const hull = new THREE.Group(); hull.name = 'hull'; root.add(hull);
  const add = (geo, mat, x, y, z, parent = hull, name = '') => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.name = name; m.castShadow = m.receiveShadow = true; parent.add(m); return m; };
  if (kind === 'btr') {
    add(new THREE.BoxGeometry(2.8, 1.2, 7.4), steel, 0, 1.35, 0);
    const nose = add(new THREE.BoxGeometry(2.6, 0.7, 1.4), steel, 0, 1.0, 3.8); nose.rotation.x = 0.5;
    for (let i = 0; i < 4; i++) for (const s of [-1, 1]) { const w = add(new THREE.CylinderGeometry(0.6, 0.6, 0.45, 18), dark, s * 1.25, 0.6, 2.4 - i * 1.45 - (i > 1 ? 0.4 : 0), root, `wheel_${s < 0 ? 'R' : 'L'}${i + 1}`); w.rotation.z = Math.PI / 2; }
    const tur = new THREE.Group(); tur.name = 'turret'; tur.position.set(0, 1.95, 1.2); hull.add(tur);
    add(new THREE.CylinderGeometry(0.75, 0.9, 0.55, 14), steel, 0, 0.27, 0, tur);
    const gp = new THREE.Group(); gp.name = 'gun_pivot'; gp.position.set(0, 0.35, 0.5); tur.add(gp);
    const b = add(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 8), dark, 0, 0, 1.1, gp); b.rotation.x = Math.PI / 2;
    const mz = new THREE.Object3D(); mz.name = 'muzzle'; mz.position.set(0, 0, 2.2); gp.add(mz);
  } else {
    add(new THREE.BoxGeometry(3.4, 0.9, 6.9), steel, 0, 1.0, 0);
    add(new THREE.BoxGeometry(3.6, 0.9, 6.6), dark, 0, 0.45, 0, hull, 'track_L');
    const tur = new THREE.Group(); tur.name = 'turret'; tur.position.set(0, 1.45, -0.3); hull.add(tur);
    const t = add(new THREE.SphereGeometry(1.4, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), steel, 0, 0, 0, tur); t.scale.set(1, 0.5, 1.15);
    const gp = new THREE.Group(); gp.name = 'gun_pivot'; gp.position.set(0, 0.35, 1.1); tur.add(gp);
    const b = add(new THREE.CylinderGeometry(0.09, 0.11, 5.5, 10), steel, 0, 0, 2.75, gp); b.rotation.x = Math.PI / 2;
    const mz = new THREE.Object3D(); mz.name = 'muzzle'; mz.position.set(0, 0, 5.5); gp.add(mz);
  }
  return root;
}
