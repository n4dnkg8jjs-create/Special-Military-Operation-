// In-game hatch smoke test: run the headless sim with ?bail=i, then frame the bailing player vehicle and screenshot it.
// Usage: node tools/blender/vehicles/bail_shot.mjs "<index.html query incl. sim=..&bail=i>" out.png [dist=11] [yawOffset=0.8] [pitch=0.5]
// Prints the vehicle name/model and every hatch_lid_* rotation (closed = 0, open = manifest hatch_lids[].open).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r));
const [query, out, dist = '11', yawOff = '0.8', pitch = '0.75'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
page.setDefaultTimeout(900000);
page.on('pageerror', e => console.log('[pageerror]', e.stack || e.message));
page.on('console', m => { if (m.type() === 'error') console.log('[page]', m.text()); });
await page.goto(`http://localhost:${server.address().port}/index.html?${query}`);
await page.waitForFunction('window.__done === true', null, { timeout: 900000 });
const info = await page.evaluate(([dist, yawOff, pitch]) => {
  const g = window.game, Q = new URLSearchParams(location.search);
  const v = g.playerUnits.filter(u => u.type === 'vehicle')[+(Q.get('bail') || 0)];
  const lids = {}; v.model.traverse(o => { if (/^hatch_lid_[A-Za-z_]+$/.test(o.name) && !/_geo/.test(o.name)) lids[o.name] = [o.rotation.x, o.rotation.y, o.rotation.z].map(a => +a.toFixed(3)); });
  g.cam.lookAt(v.pos.x, v.pos.z); g.cam.tDist = dist; g.cam.tYaw = v.heading + yawOff; g.cam.tPitch = pitch;
  for (let i = 0; i < 60; i++) g.cam.update(0.05);
  g.scene.fog.density = 0; g.frame(0.0001); g.renderer.render(0.016, g.time);
  return { name: v.name, kind: v.kind, model: v.vman?.file || v.model?.name, abandoned: v.abandoned, destroyed: v.destroyed, pos: [v.pos.x, v.pos.z].map(Math.round), lids,
    crew: g.squads.filter(s => s.name === `${v.name} crew`).map(s => s.soldiers.map(m => m.role?.role || m.role).join(',')) };
}, [+dist, +yawOff, +pitch]);
await page.screenshot({ path: out, timeout: 600000 });
console.log(JSON.stringify(info));
await browser.close(); server.close();
