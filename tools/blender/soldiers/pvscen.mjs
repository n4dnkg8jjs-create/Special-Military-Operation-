// Scripted in-game scenario: one page load (autostart, sim=0.05 so nothing auto-runs), then a scenario script runs in the page.
// Usage: node tools/blender/soldiers/pvscen.mjs <scenario.js> "<query e.g. side=RU&map=city>" [outPrefix]
// The scenario file is the body of an async function (g = window.game, THREE-free helpers below) and returns any JSON.
//   step(sec)                     advance the simulation in 0.05 s frames (no rendering)
//   shot(name, [cx,cy,cz], [tx,ty,tz])   render one frame from that camera and save <outPrefix>_<name>.png
//   log(...)                      collected lines (printed by the harness)
// env W / H frame size.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.ktx2': 'application/octet-stream', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const [scen, q = '', outPrefix = '/tmp/scen'] = process.argv.slice(2);
const W = +(process.env.W || 900), H = +(process.env.H || 600);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('console', m => { if (/404|GPU stall|GroupMarkerNotSet/.test(m.text())) return; if (m.type() === 'error' || process.env.VERBOSE) console.log('[page]', m.type(), m.text()); });
page.on('pageerror', e => console.log('[pageerror]', e.stack || e.message));
await page.goto(`http://localhost:${port}/index.html?autostart&quality=${process.env.Q || 'medium'}&nofog&sim=0.05&${q}`);
await page.waitForFunction('window.__done === true', null, { timeout: 900000 });
await page.evaluate(() => {
  const g = window.game; window.__shots = []; window.__log = [];
  document.querySelectorAll('body > *:not(#view)').forEach(e => { e.style.display = 'none'; });
  g.noRender = true;
  window.step = sec => { for (let t = 0; t < sec - 1e-6; t += 0.05) g.frame(0.05); };
  window.log = (...a) => window.__log.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
  window.shot = (name, c, t) => {
    const cam = g.renderer.camera; for (const sq of g.squads) for (const s of sq.soldiers) { s.inView = true; s.animAcc = 0; s.animate(0, 5); s.sync(); }
    cam.position.set(c[0], c[1], c[2]); cam.lookAt(t[0], t[1], t[2]); cam.updateMatrixWorld(true);
    g.renderer.render(0.016, g.time);
    window.__shots.push([name, g.renderer.r.domElement.toDataURL('image/png')]);
  };
});
const body = fs.readFileSync(scen, 'utf8');
let res;
try { res = await page.evaluate(`(async () => { const g = window.game; ${body}\n})()`); } catch (e) { console.log('[scenario error]', e.message); }
const shots = await page.evaluate(() => window.__shots), logs = await page.evaluate(() => window.__log);
for (const l of logs) console.log(l);
for (const [n, u] of shots) { const f = `${outPrefix}_${n}.png`; fs.writeFileSync(f, Buffer.from(u.split(',')[1], 'base64')); console.log('wrote', f); }
console.log('RESULT', JSON.stringify(res));
await browser.close(); server.close();
