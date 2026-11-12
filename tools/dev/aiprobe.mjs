// Battle-AI trace (logic only, no rendering): the enemy Commander against the scripted AutoDefender, seeded; prints the
// objective / spawn layout, every AI decision note, and every N s the tickets, objective owners, all vehicles (hp, position)
// and the commander's plan lines. tools/ai_bench.mjs gives the end-of-battle numbers; this shows WHY.
// usage: node tools/dev/aiprobe.mjs <map> <skirmish|attack|defend> <seed> <simSeconds> <everySeconds>
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, r));
const [map = 'farmland', mode = 'skirmish', seed = '1', simS = '240', every = '40'] = process.argv.slice(2);
const q = mode === 'skirmish' ? `autostart&quality=low&map=${map}` : `ctest=${mode}&quality=low&map=${map}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=2048'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.addInitScript(() => { localStorage.setItem('smo_norender', '1'); localStorage.setItem('smo_noaudio', '1'); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => { const t = m.text(); if (/^\[AI /.test(t)) console.log(t.slice(0, 200)); });
await page.goto(`http://localhost:${server.address().port}/index.html?${q}&autoplay&ainew&aidebug`);
await page.waitForFunction('window.game && window.game.objectives && window.__done === true', null, { timeout: 150000 });
const info = await page.evaluate(([seed]) => { const g = window.game; let a = +seed * 2654435761 >>> 0; Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const frame = g.frame.bind(g); g.frame = () => {}; window.__step = frame; g.startBattle();
  return { obj: g.objectives.map(o => `${o.id}(${Math.round(o.x)},${Math.round(o.z)})`), spawns: g.map.spawns, units: g.vehicles.map(v => `${v.side[0]}:${v.kind}:${v.name}@${Math.round(v.pos.x)},${Math.round(v.pos.z)}`), squads: g.squads.map(s => `${s.side[0]}:${s.kind || ''}:${s.name}:${s.soldiers.length}`) }; }, [seed]);
console.log(JSON.stringify(info));
let t = 0;
while (t < +simS) {
  const r = await page.evaluate(([chunk]) => { const g = window.game; for (let i = 0; i < chunk / 0.05; i++) { window.__step(0.05); if (g.over) break; }
    return { t: Math.round(g.time), over: g.over, tk: [Math.round(g.tickets.player), Math.round(g.tickets.enemy)], obj: g.objectives.map(o => `${o.id}:${o.owner[0]}`).join(' '), plan: g.commander.debugLines?.().slice(0, 16),
      veh: g.vehicles.map(v => `${v.side[0]}${v.kind}${v.destroyed ? 'X' : Math.round(v.hp)}@${Math.round(v.pos.x)},${Math.round(v.pos.z)}${v.killedBy ? ' by ' + v.killedBy : ''}`).join(' | '), slog: (g.supportLog || []).slice(-6) }; }, [+every]);
  t = r.t; console.log(`--- t=${r.t} tickets ${r.tk} obj ${r.obj}\n  VEH ${r.veh}\n  ${(r.plan || []).map(l => l.slice(0, 150)).join('\n  ')}\n  SUP ${JSON.stringify(r.slog)}`); if (r.over) break;
}
await browser.close(); server.close();
