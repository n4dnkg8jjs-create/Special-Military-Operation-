// Versus protocol test that fits in a small sandbox: a real host (battle iframe) + a recording joiner without a game.
// Checks manifest/snapshots/events arrive and that a joiner command moves its unit on the host; saves the stream
// to previews/versus/stream.json for the replay test (tools/mp_replay: index.html?vsreplay).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, r)); const port = server.address().port;
const [secs = '30', map = 'city'] = process.argv.slice(2);
const br = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const mk = async (name, rec) => { const ctx = await br.newContext({ viewport: { width: 1280, height: 760 } }); await ctx.addInitScript(r => { localStorage.setItem('smo_quality', 'low'); localStorage.setItem('smo_noaudio', '1'); localStorage.setItem('smo_norender', '1'); if (r) window.__vsRecord = true; }, rec); const p = await ctx.newPage(); p.on('pageerror', e => console.log(`[${name} pageerror]`, e.stack || e.message)); p.on('console', m => { if (m.type() === 'error') console.log(`[${name}]`, m.text().slice(0, 300)); }); return p; };
const A = await mk('host', false), B = await mk('guest', true);
await A.goto(`http://localhost:${port}/index.html?versus=1&vsmap=${map}`); await B.goto(`http://localhost:${port}/index.html?versus=1`);
await A.waitForSelector('.vs-mk'); await A.click('.vs-mk'); await A.waitForFunction(() => document.querySelector('.vs-code')?.value.length > 20);
await B.fill('.vs-inv', await A.$eval('.vs-code', e => e.value)); await B.click('.vs-join'); await B.waitForFunction(() => document.querySelector('.vs-rcode')?.value.length > 20);
await A.fill('.vs-reply', await B.$eval('.vs-rcode', e => e.value)); await A.click('.vs-acc');
await A.waitForSelector('.cp-end'); await B.waitForSelector('.cp-end'); console.log('connected');
// host (UA, the operation's side) plans an attack; both end the turn
const planned = await A.evaluate(() => { for (const s of document.querySelectorAll('.cp-sec')) { s.dispatchEvent(new MouseEvent('click', { bubbles: true })); const units = document.querySelectorAll('.cp-unit'); if ([...document.querySelectorAll('.cp-card button.big')].some(b => /PLAN ATTACK/.test(b.textContent)) && units.length) { [...units].slice(0, 5).forEach(u => u.click()); [...document.querySelectorAll('.cp-card button.big')].find(b => /PLAN ATTACK/.test(b.textContent)).click(); return true; } } return false; });
console.log('planned', planned);
await A.click('.cp-end'); await B.click('.cp-end');
await A.waitForSelector('.vs-frame', { timeout: 30000 });
const FA = await (await A.$('.vs-frame')).contentFrame();
await FA.waitForFunction(() => window.game?.phase === 'deploy', null, { timeout: 300000 }); console.log('host battle loaded');
await B.waitForFunction(() => (window.__rec || []).some(m => m.t === 'manifest'), null, { timeout: 60000 });
const man = await B.evaluate(() => window.__rec.find(m => m.t === 'manifest').d);
const mine = man.squads.filter(s => s.side === 'enemy'), vehs = man.vehicles.filter(v => v.side === 'enemy');
console.log('manifest: host units', man.squads.filter(s => s.side === 'player').length, '+', man.vehicles.filter(v => v.side === 'player').length, '· joiner units', mine.length, '+', vehs.length);
// joiner: ready + move its first vehicle 60 m forward (south)
const v0 = vehs[0];
await B.evaluate(id => { window.__vsPeer = null; }, 0);
await B.evaluate(([id, x, z]) => { const send = (t, d) => window.__peerSend(t, d); }, [v0.id, v0.x, v0.z]).catch(() => {});
await B.evaluate(([id, x, z]) => { const p = window.__guestPeer; p.send('ready', 1); }, [v0.id, v0.x, v0.z]);
await FA.evaluate(() => window.game.startBattle());
await A.waitForTimeout(1500);
await B.evaluate(([id, x, z]) => { window.__guestPeer.send('cmd', { id, m: 'orderMove', a: [x, z + 60, 0, true] }); }, [v0.id, v0.x, v0.z]);
await A.waitForTimeout(+secs * 1000);
const st = await FA.evaluate(id => { const g = window.game, v = g.vehicles.find(x => x.id === id); return { phase: g.phase, t: g.time.toFixed(1), moved: v ? [v.pos.x.toFixed(0), v.pos.z.toFixed(0)] : null }; }, v0.id);
console.log('host after', JSON.stringify(st), 'joiner vehicle started at', Math.round(v0.x), Math.round(v0.z));
const rec = await B.evaluate(() => window.__rec);
const snaps = rec.filter(m => m.t === 'snap'), evs = rec.filter(m => m.t === 'ev');
console.log('received: snapshots', snaps.length, 'avg size', Math.round(snaps.reduce((a, m) => a + JSON.stringify(m).length, 0) / Math.max(1, snaps.length)), 'B · event batches', evs.length, 'events', evs.reduce((a, m) => a + m.d.length, 0));
fs.mkdirSync(path.join(root, 'previews/versus'), { recursive: true });
fs.writeFileSync(path.join(root, 'previews/versus/stream.json'), JSON.stringify({ map, side: 'RU', manifest: man, rec }));
await A.screenshot({ path: path.join(root, 'previews/versus/host_battle.png') });
await br.close(); server.close();
