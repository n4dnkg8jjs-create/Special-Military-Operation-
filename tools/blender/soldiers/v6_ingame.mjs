// soldiers_v6 in-game check: run a battle headless (index.html?autostart&sim=N), report soldier damage stats + shader errors,
// then aim the camera at the nearest wounded / dead man and screenshot.  run: node tools/blender/soldiers/v6_ingame.mjs out.png [sim] [map]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, r));
const [out = '/tmp/v6_ingame.png', sim = '60', map = 'farmland'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errs = [];
page.on('console', m => { if (m.type() === 'error' || /shader|THREE\.WebGLProgram/i.test(m.text())) errs.push(m.text().slice(0, 300)); });
page.on('pageerror', e => errs.push('pageerror ' + (e.stack || e.message).slice(0, 300)));
await page.goto(`http://localhost:${server.address().port}/index.html?autostart&map=${map}&quality=medium&sim=${sim}`);
await page.waitForFunction('window.__done === true', null, { timeout: 900000 });
const st = await page.evaluate(() => {
  const g = window.game, S = g.squads.flatMap(q => q.soldiers);
  const r = { soldiers: S.length, dmgActive: S.filter(s => s.dmg?.active).length, states: {}, withWounds: 0, wounds: 0, bandaged: 0, muddy: 0, sample: null };
  for (const s of S) { r.states[s.state] = (r.states[s.state] || 0) + 1; const w = s.dmg?.wounds || []; if (w.length) r.withWounds++; r.wounds += w.length; r.bandaged += w.filter(x => x.type > 0).length; if (s.dmg?.mud > 0.3 || s.dmg?.backMud > 0.3) r.muddy++; }
  const v = S.find(s => s.dmg?.wounds.length && s.state !== 'evac' && s.root.visible) || S.find(s => s.dmg?.wounds.length);
  if (v) { r.sample = { state: v.state, wounds: v.dmg.wounds.map(w => ({ type: w.type, r: +w.r.toFixed(3), seg: w.seg })), mud: +v.dmg.mud.toFixed(2), back: +v.dmg.backMud.toFixed(2) }; g.cam.lookAt(v.pos.x, v.pos.z); g.cam.tDist = 7; window.__v = v; }
  g.noRender = false; return r;
});
console.log(JSON.stringify(st)); console.log('errors', errs.length, JSON.stringify(errs.slice(0, 5)));
await page.waitForTimeout(6000);
await page.evaluate(() => { window.game.noRender = true; });
await page.screenshot({ path: out, timeout: 600000 });
console.log('errors after render', errs.length, JSON.stringify(errs.slice(0, 5)));
await browser.close(); server.close();
