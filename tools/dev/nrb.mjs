import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; let _pw; try { _pw = createRequire(import.meta.url)('playwright'); } catch { _pw = createRequire('/opt/npm-tools/node_modules/')('playwright'); } const { chromium } = _pw;
const root = new URL('../..', import.meta.url).pathname;   // repo root const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const errs = [];
for (const map of (process.argv[2] || 'city,farmland').split(',')) {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await p.addInitScript(() => { localStorage.setItem('smo_noaudio', '1'); localStorage.setItem('smo_norender', '1'); });
  p.on('pageerror', e => errs.push(map + ': ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')));
  await p.goto(`http://127.0.0.1:${server.address().port}/index.html?autostart&quality=low&map=${map}`);
  await p.waitForFunction(() => window.game?.phase === 'deploy', null, { timeout: 560000 });
  await p.evaluate(() => game.startBattle());
  await p.waitForTimeout(+process.argv[3] || 60000);
  console.log(map, await p.evaluate(() => JSON.stringify({ t: game.time | 0, phase: game.phase, kia: game.squads.reduce((a, s) => a + s.soldiers.filter(x => x.hp <= 0).length, 0), tickets: game.tickets || null })));
  await b.close();
}
console.log('page errors:', errs.length); for (const e of [...new Set(errs)].slice(0, 8)) console.log(' ', e);
server.close();
