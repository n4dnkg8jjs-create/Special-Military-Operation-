// CPU software rasteriser (no browser / GPU / Blender): flat-shaded, z-buffered, 2x supersampled previews of a
// vehicle GLB with kits, for fast iteration on src/game/vehicleKit.js when the shared heavy-job lock is busy.
// Chain-link / welded-mesh screens are alpha-tested per pixel like the game material.
// Usage: node tools/blender/vehicles/kitraster.mjs <vehicle> <kits|none|all> <out.png> ["az,el;az,el"] [dist] [rot=turret:y:90;...] [open=1]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { loadGlb, pose, KK, kindOf } from './kitnode.mjs';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const { attachKits } = await import(path.join(root, 'src/game/vehicleKit.js'));
const man = JSON.parse(fs.readFileSync(path.join(root, 'assets/vehicles/manifest.json'), 'utf8')).vehicles;

export function png(file, W, H, rgb) {
  const raw = Buffer.alloc((W * 3 + 1) * H); for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; rgb.copy ? rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3) : raw.set(rgb.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1); }
  const crc = b => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const COL = { kit_steel: [0.42, 0.40, 0.31], kit_weld: [0.25, 0.24, 0.2], kit_chain: [0.62, 0.6, 0.53], kit_weldmesh: [0.55, 0.53, 0.45], kit_era: null, kit_bag: null, kit_link: [0.3, 0.29, 0.26], kit_box: [0.34, 0.37, 0.25], kit_glass: [0.05, 0.06, 0.08], kit_black: [0.08, 0.08, 0.08], kit_cable: [0.1, 0.1, 0.1] };
// draw meshes into a tile; views: [[az, el]], target centre c, radius r
export function render(scene, W, H, views, opt = {}) {
  const SS = 2, w = W * SS, h = H * SS, cols = views.length > 1 ? 2 : 1, rows = Math.ceil(views.length / cols), tw = Math.floor(w / cols), th = Math.floor(h / rows);
  const img = new Float32Array(w * h * 3), zb = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { const y = Math.floor(i / w) % th; const g = 0.62 + 0.18 * (1 - y / th); img.set([g * 0.92, g * 0.95, g], i * 3); }
  const items = [];
  scene.updateMatrixWorld(true);
  scene.traverse(o => {
    if (!o.isMesh) return; for (let p = o; p; p = p.parent) if (!p.visible) return;
    let p = o; while (p) { if (/_LOD1$|_wreck$/.test(p.name)) return; p = p.parent; }
    const mn = o.material?.name || '', kit = !!o.userData.kit;
    const g = o.geometry, pa = g.attributes.position, ix = g.index, uv = g.attributes.uv, cl = g.attributes.color;
    items.push({ o, kit, mn, pa, ix, uv, cl, alpha: /chain|weldmesh/.test(mn) ? mn : null, hl: opt.hl && kit && opt.hl.test(o.userData.kitId || '') });
  });
  const box = new THREE.Box3(); for (const it of items) if (!it.kit) box.expandByObject(it.o);
  const c = opt.target || box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() * 0.62 * (opt.dist || 1);
  const L = new THREE.Vector3(-0.5, 0.8, 0.45).normalize(), L2 = new THREE.Vector3(0.6, 0.3, -0.5).normalize();
  views.forEach(([az, el], vi) => {
    const ox = (vi % cols) * tw, oy = Math.floor(vi / cols) * th;
    for (let y = oy; y < oy + th; y++) zb.fill(Infinity, y * w + ox, y * w + ox + tw);
    const a = az * Math.PI / 180, e = el * Math.PI / 180;
    const cam = new THREE.PerspectiveCamera(opt.fov || 30, tw / th, 0.05, 200); cam.position.set(c.x + r * 2 * Math.cos(e) * Math.sin(a), c.y + r * 2 * Math.sin(e), c.z + r * 2 * Math.cos(e) * Math.cos(a)); cam.lookAt(c); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    const VP = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const v = new THREE.Vector3(), wv = new THREE.Vector3();
    for (const it of items) {
      const n = it.pa.count, S = new Float32Array(n * 3), Wp = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { wv.fromBufferAttribute(it.pa, i).applyMatrix4(it.o.matrixWorld); Wp.set([wv.x, wv.y, wv.z], i * 3); v.copy(wv).applyMatrix4(VP); S[i * 3] = ox + (v.x * 0.5 + 0.5) * tw; S[i * 3 + 1] = oy + (1 - (v.y * 0.5 + 0.5)) * th; S[i * 3 + 2] = v.z; }
      const base = it.kit ? (COL[it.mn] || [0.6, 0.6, 0.6]) : (it.hl ? [1, 0, 0] : [0.47, 0.5, 0.38]);
      const nt = it.ix ? it.ix.count / 3 : n / 3;
      for (let t = 0; t < nt; t++) {
        const I = it.ix ? [it.ix.getX(t * 3), it.ix.getX(t * 3 + 1), it.ix.getX(t * 3 + 2)] : [t * 3, t * 3 + 1, t * 3 + 2];
        const [A, B, C] = I; if (S[A * 3 + 2] > 1 || S[B * 3 + 2] > 1 || S[C * 3 + 2] > 1 || S[A * 3 + 2] < -1) continue;
        const e1 = [Wp[B * 3] - Wp[A * 3], Wp[B * 3 + 1] - Wp[A * 3 + 1], Wp[B * 3 + 2] - Wp[A * 3 + 2]], e2 = [Wp[C * 3] - Wp[A * 3], Wp[C * 3 + 1] - Wp[A * 3 + 1], Wp[C * 3 + 2] - Wp[A * 3 + 2]];
        const N = new THREE.Vector3(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]).normalize();
        const toCam = new THREE.Vector3(cam.position.x - Wp[A * 3], cam.position.y - Wp[A * 3 + 1], cam.position.z - Wp[A * 3 + 2]); if (N.dot(toCam) < 0) N.negate();
        const sh = 0.35 + 0.65 * Math.max(0, N.dot(L)) + 0.18 * Math.max(0, N.dot(L2));
        let col = base; if (it.cl && it.kit && (it.mn === 'kit_era' || it.mn === 'kit_bag')) col = [it.cl.getX(A) * (it.mn === 'kit_bag' ? 0.62 : 1), it.cl.getY(A) * (it.mn === 'kit_bag' ? 0.56 : 1), it.cl.getZ(A) * (it.mn === 'kit_bag' ? 0.4 : 1)];
        const x0 = S[A * 3], y0 = S[A * 3 + 1], x1 = S[B * 3], y1 = S[B * 3 + 1], x2 = S[C * 3], y2 = S[C * 3 + 1];
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0); if (Math.abs(area) < 1e-9) continue;
        const minx = Math.max(ox, Math.floor(Math.min(x0, x1, x2))), maxx = Math.min(ox + tw - 1, Math.ceil(Math.max(x0, x1, x2))), miny = Math.max(oy, Math.floor(Math.min(y0, y1, y2))), maxy = Math.min(oy + th - 1, Math.ceil(Math.max(y0, y1, y2)));
        for (let py = miny; py <= maxy; py++) for (let px = minx; px <= maxx; px++) {
          const sx = px + 0.5, sy = py + 0.5;
          const w0 = ((x1 - sx) * (y2 - sy) - (x2 - sx) * (y1 - sy)) / area, w1 = ((x2 - sx) * (y0 - sy) - (x0 - sx) * (y2 - sy)) / area, w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * S[A * 3 + 2] + w1 * S[B * 3 + 2] + w2 * S[C * 3 + 2], k = py * w + px; if (z >= zb[k]) continue;
          if (it.alpha && it.uv) { const u = w0 * it.uv.getX(A) + w1 * it.uv.getX(B) + w2 * it.uv.getX(C), vv = w0 * it.uv.getY(A) + w1 * it.uv.getY(B) + w2 * it.uv.getY(C); let f; if (it.alpha === 'kit_chain') { const p = (u + vv) * 2, q = (u - vv) * 2; f = Math.min(Math.abs(p - Math.round(p)), Math.abs(q - Math.round(q))) < 0.05; } else { const p = u * 4, q = vv * 4; f = Math.min(Math.abs(p - Math.round(p)), Math.abs(q - Math.round(q))) < 0.05; } if (!f) continue; }
          zb[k] = z; img[k * 3] = col[0] * sh; img[k * 3 + 1] = col[1] * sh; img[k * 3 + 2] = col[2] * sh;
        }
      }
    }
  });
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let ch = 0; ch < 3; ch++) { let s = 0; for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += img[((y * SS + j) * w + x * SS + i) * 3 + ch]; out[(y * W + x) * 3 + ch] = Math.max(0, Math.min(255, Math.round(Math.pow(s / SS / SS, 1 / 1.2) * 255))); }
  return out;
}

if (process.argv[1].endsWith('kitraster.mjs')) {
  const [vn, kitsArg, out, vs, dist, ...kw] = process.argv.slice(2); const V = man[vn], o = Object.fromEntries(kw.map(s => s.split('=')));
  const scene = loadGlb(path.join(root, V.file)); pose(scene, V, {});
  const kind = kindOf(V), kits = kitsArg === 'none' ? [] : (kitsArg === 'all' ? KK[kind] : kitsArg).split(',');
  if (kits.length) attachKits(scene, kits, { wheeled: !!V.wheeled || V.kind === 'btr', kind });
  pose(scene, V, { open: o.open, rot: o.rot });
  const views = (vs || '35,25;210,35').split(';').map(s => s.split(',').map(Number));
  const W = +(o.w || 1000), H = +(o.h || 300 * Math.ceil(views.length / 2));
  png(out, W, H, render(scene, W, H, views, { dist: +(dist || 1), target: o.target ? new THREE.Vector3(...o.target.split(',').map(Number)) : null }));
  console.log('wrote', out);
}
