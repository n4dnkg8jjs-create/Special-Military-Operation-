// Drives tools/blender/vehicles/vcheck.html in one headless browser for a list of jobs.
// Usage: node tools/blender/vehicles/vcheck.mjs jobs.json      jobs: [{q: "v=t72b3&open=1", png?: out.png, glb?: out.glb}]
// or     node tools/blender/vehicles/vcheck.mjs "<query>" out.png|out.glb
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
let jobs;
if (process.argv[2].endsWith('.json')) jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
else { const o = process.argv[3]; jobs = [{ q: process.argv[2], [o.endsWith('.glb') ? 'glb' : 'png']: o }]; }
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const j of jobs) {
  const page = await browser.newPage({ viewport: { width: j.w || 1400, height: j.h || 800 } });
  page.on('pageerror', e => console.log('[pageerror]', j.q, e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') { if (!/404|GPU stall|GroupMarker/.test(m.text())) console.log('[page]', m.text()); } });
  const q = j.q + (j.glb ? '&export=1&views=1&w=64&h=64' : '') + (j.w ? `&w=${j.w}&h=${j.h}` : '');
  await page.goto(`http://localhost:${port}/tools/blender/vehicles/vcheck.html?${q}`);
  try { await page.waitForFunction('window.__done === true', null, { timeout: 600000 }); } catch (e) { console.log('timeout', j.q); await page.close(); continue; }
  if (j.glb) { const b = await page.evaluate('window.__glb'); fs.writeFileSync(j.glb, Buffer.from(b, 'base64')); }
  if (j.png) await page.screenshot({ path: j.png, timeout: 600000 });
  console.log('ok', j.q, j.png || j.glb, JSON.stringify(await page.evaluate('window.__info')));
  await page.close();
}
await browser.close(); server.close();
