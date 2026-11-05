// Campaign v6 previews: the strategic map at fixed cameras (before / after the true-to-scale rework) and top-down
// close-ups of named squares (incl. the growth bands) for the side-by-side with OpenStreetMap (tools/v6_sbs.py).
// usage: flock /tmp/heavy.lock nice -n 10 node src/campaign/v2/tools/v6_shots.mjs UA|RU <tag>   -> previews/campaign_v6/
//        writes <tag>_<side>_<view>.png and cells_<side>.json (lat/lon box of every close-up)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'), root = process.env.ROOT || repo;
const out = path.join(repo, 'previews/campaign_v6'); fs.mkdirSync(out, { recursive: true });
const side = process.argv[2] || 'UA', tag = process.argv[3] || 'after';
// close-ups: squares named by their settlement / name (first match), growth-band squares marked ext
const CELLS = {
  UA: ['Orikhiv', 'Mala Tokmachka', 'Robotyne', 'Kopani', 'Verbove', 'Novoprokopivka', 'ext:Tokmak', 'ext:Nove', 'ext:Tokmak line (T-04-08)'],
  RU: ['Avdiivka (north)', 'Avdiivka Coke Plant', 'Krasnohorivka', 'Vodiane', 'Opytne', 'Yasynuvata', 'ext:Novoselivka Persha', 'ext:Netailove', 'ext:Karlivka'],
}[side];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, r)); const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errors = [];
page.on('console', m => { if (/404|GPU stall|GroupMarkerNotSet|content_index/.test(m.text())) return; if (m.type() === 'error') { errors.push(m.text()); console.log('[page]', m.text()); } });
page.on('pageerror', e => { errors.push(e.message); console.log('[pageerror]', e.stack || e.message); });
const shot = async (n, clip) => { await page.waitForTimeout(1500); await page.screenshot({ path: path.join(out, n), timeout: 240000, ...(clip ? { clip } : {}) }); console.log('shot', n); };
const t0 = Date.now();
await page.goto(`${base}/index.html?campaign=1&cside=${side}&nointro`); await page.waitForFunction('window.__done === true', null, { timeout: 600000 });
console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.evaluate(() => { document.querySelectorAll('.c2-modal, .c2-tour, .c2-tut').forEach(e => e.remove()); });
const stats = await page.evaluate(() => { const m = window.__c2.map, r = m.renderer.info; return { build: m.buildMs, buildings: m.buildingList?.length, trees: m.trees?.count, tex: [m.gW, m.gH] }; });
console.log('map', JSON.stringify(stats));
// 1. overview (the whole AOR from above) and the default oblique view
await page.evaluate(() => { const m = window.__c2.map; m.jump({ ...m.view('aor'), pitch: 1.25, yaw: 0 }); });
await shot(`${tag}_${side}_overview.png`);
await page.evaluate(() => { const m = window.__c2.map, c = m.aorCenter(); m.jump({ x: c.x, z: c.z, dist: 26, yaw: 0.18, pitch: 0.92 }); });
await shot(`${tag}_${side}_oblique.png`);
// 2. grow every band, then close-ups: oblique (with the grid) and top-down plain (no overlay / labels) for OSM
await page.evaluate(async () => {
  const ui = window.__c2, C = ui.C, GR = await import('/src/campaign/v2/growth.js');
  for (const b of C.baseDef.aor.ext?.bands || []) GR.applyBand(C, b, { quiet: true });
  ui.opts = { ...(ui.opts || {}), noFly: true }; ui.regrid(); ui.render?.();
  document.querySelectorAll('.c2-modal, .c2-tour, .c2-tut, .c2-toast').forEach(e => e.remove());
});
const boxes = {};
for (const spec of CELLS) {
  const ext = spec.startsWith('ext:'), name = spec.replace(/^ext:/, '');
  const info = await page.evaluate(({ name, ext }) => {
    const ui = window.__c2, C = ui.C, m = ui.map;
    const c = C.def.aor.cells.find(x => (x.settlement?.name === name || x.name === name) && !!x.ext === ext) || C.def.aor.cells.find(x => x.settlement?.name === name || x.name === name);
    if (!c) return null;
    const p = m.cellCenter(c.id), half = 1.2, dist = half / Math.tan(20 * Math.PI / 180);
    const [latS, lonW, latN, lonE] = C.def.aor.bbox, lat0 = (latS + latN) / 2, lon0 = (lonW + lonE) / 2;
    const lat = lat0 - p.z / 110.57, lon = lon0 + p.x / m.kx;
    return { id: c.id, x: p.x, z: p.z, dist, box: [lat - half / 110.57, lon - half / m.kx, lat + half / 110.57, lon + half / m.kx] };
  }, { name, ext });
  if (!info) { console.log('no cell', spec); continue; }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  boxes[slug] = { id: info.id, box: info.box, name };
  // oblique close-up with the grid
  await page.evaluate(i => { const m = window.__c2.map; m.viewOffset = 0; m.resize(); m.jump({ x: i.x, z: i.z + 0.4, dist: 5.2, yaw: 0.3, pitch: 0.75 }); }, info);
  await shot(`${tag}_${side}_${slug}_3d.png`);
  // top-down, overlay / labels hidden, square viewport crop
  await page.setViewportSize({ width: 900, height: 900 });
  await page.evaluate(i => { const m = window.__c2.map; m.viewOffset = 0; m.resize(); m.scene.traverse(o => { if (o.material?.map && (o.material.map === m.ovTex || o.material.map === m.hlTex)) o.visible = false; }); m.labels.style.display = 'none'; for (const o of [m.cellFront, m.cellFrontG, m.dyn]) if (o) o.visible = false; for (const e of document.body.querySelectorAll('*')) if (!e.contains(m.canvas) && e !== m.canvas && !e.dataset.v6hid && getComputedStyle(e).visibility !== 'hidden') { e.dataset.v6hid = 1; e.style.visibility = 'hidden'; } m.jump({ x: i.x, z: i.z, dist: i.dist, yaw: 0, pitch: Math.PI / 2 - 0.001 }); }, info);
  const r = await page.evaluate(() => { const b = window.__c2.map.canvas.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; });
  await shot(`${tag}_${side}_${slug}_top.png`, r);
  await page.evaluate(() => { const m = window.__c2.map; m.scene.traverse(o => { if (o.material?.map && (o.material.map === m.ovTex || o.material.map === m.hlTex)) o.visible = true; }); m.labels.style.display = ''; for (const o of [m.cellFront, m.cellFrontG, m.dyn]) if (o) o.visible = true; for (const e of document.querySelectorAll('[data-v6hid]')) { e.style.visibility = ''; delete e.dataset.v6hid; } });
  await page.setViewportSize({ width: 1400, height: 800 });
}
fs.writeFileSync(path.join(out, `cells_${side}.json`), JSON.stringify(boxes, null, 1));
const perf = await page.evaluate(() => { const m = window.__c2.map; m.renderer.info.reset(); m.renderer.render(m.scene, m.camera); const r = m.renderer.info.render; return { calls: r.calls, tris: r.triangles, buildings: m.buildingList?.length, trees: m.trees?.count, tex: [m.gW, m.gH] }; });
console.log('render', JSON.stringify(perf), 'errors', errors.length);
await browser.close(); server.close();
