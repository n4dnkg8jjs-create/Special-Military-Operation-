import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; let _pw; try { _pw = createRequire(import.meta.url)('playwright'); } catch { _pw = createRequire('/opt/npm-tools/node_modules/')('playwright'); } const { chromium } = _pw;
const root = new URL('../..', import.meta.url).pathname;   /* repo root */
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const map = process.argv[2], out = process.argv[3], pick = process.argv[4];   // pick: JS expression returning [[x,z,dist,pitch,yaw],...]
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=4096'] });
const p = await b.newPage({ viewport: { width: 1100, height: 620 } });
await p.addInitScript(() => { localStorage.setItem('smo_noaudio', '1'); });
p.on('pageerror', e => console.log('ERR', e.message));
await p.goto(`http://127.0.0.1:${server.address().port}/index.html?autostart&quality=${process.env.Q || 'medium'}&map=${map}${process.env.SIDE ? '&side=' + process.env.SIDE : ''}`);   /* SIDE=RU: play the Russian side */
await p.waitForFunction(() => window.game?.phase === 'deploy', null, { timeout: 500000 });
await p.evaluate(() => { for (const e of document.querySelectorAll('#hud, .hud, #dock, #topbar, .dock, #deploy-bar')) e.style.display = 'none'; });
const views = await p.evaluate(pick);
console.log(JSON.stringify(views));
let i = 0;
for (const [x, z, d, pi, yaw] of views) {
  await p.evaluate(([x, z, d, pi, yaw]) => { const c = game.cam; c.tFocus.set(x, 0, z); c.focus.set(x, 0, z); c.tDist = c.dist = d; c.tPitch = c.pitch = pi; if (yaw != null) c.tYaw = c.yaw = yaw; }, [x, z, d, pi, yaw]);
  await p.waitForTimeout(2500);
  const img = await p.evaluate(() => { game.renderer.render(0.016, performance.now() / 1000); return game.renderer.r.domElement.toDataURL('image/jpeg', 0.85); });
  fs.writeFileSync(`${out}_${i++}.jpg`, Buffer.from(img.split(',')[1], 'base64'));
}
await b.close(); server.close();
