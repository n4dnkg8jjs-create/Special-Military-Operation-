// Contact sheet of every vehicle x every kit with the CPU rasteriser (kitraster.mjs): one row per vehicle, one column
// per kit (+ none + all of the kind's kits), two views per cell. KITSRC=<other vehicleKit.js> renders a before state.
// Usage: node tools/blender/vehicles/kitsheet.mjs <out.png> [vehicle ...]
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { loadGlb, pose, KK, kindOf } from './kitnode.mjs';
import { render, png } from './kitraster.mjs';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const { attachKits, removeKits } = await import(process.env.KITSRC ? path.resolve(process.env.KITSRC) : path.join(root, 'src/game/vehicleKit.js'));
const man = JSON.parse(fs.readFileSync(path.join(root, 'assets/vehicles/manifest.json'), 'utf8')).vehicles;
const [out, ...vs] = process.argv.slice(2);
const VS = vs.length ? vs : ['btr82a', 'btr80_ua', 't72b3', 't72av_ua', 'bmp3', 'bradley_ua', 'msta_s', 'bohdana'];
const COLS = ['none', 'cage', 'roof', 'era', 'sandbags', 'sight', 'ew', 'smoke', 'all'], CW = 300, CH = 300;
const sheet = Buffer.alloc(CW * COLS.length * CH * VS.length * 3, 40);
VS.forEach((vn, r) => {
  const V = man[vn], kind = kindOf(V), have = KK[kind].split(','), scene = loadGlb(path.join(root, V.file)); pose(scene, V, {});
  COLS.forEach((c, ci) => {
    if (c !== 'none' && c !== 'all' && !have.includes(c)) return;
    removeKits(scene); const ks = c === 'none' ? [] : c === 'all' ? have : [c];
    if (ks.length) attachKits(scene, ks, { wheeled: !!V.wheeled || V.kind === 'btr', kind });
    scene.updateMatrixWorld(true);
    const img = render(scene, CW, CH, [[40, 30], [215, 40]], { dist: 0.74, cols: 1 });
    for (let y = 0; y < CH; y++) img.copy(sheet, ((r * CH + y) * CW * COLS.length + ci * CW) * 3, y * CW * 3, (y + 1) * CW * 3);
    console.log(vn, c);
  });
});
png(out, CW * COLS.length, CH * VS.length, sheet);
console.log('wrote', out);
