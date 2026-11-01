// Two-player versus smoke test in one headless browser: host + joiner pages, code exchange, planned attack,
// both end the turn, the battle iframes load, then N seconds of battle; screenshots of both and a status dump.
// Usage: node tools/mp_test.mjs [battleSeconds=40] [op=UA] [hostSide=UA]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, r)); const port = server.address().port;
const [secs = '40', op = 'UA', side = 'UA'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const mk = async name => { const br = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--js-flags=--max-old-space-size=4096'] }); const ctx = await br.newContext({ viewport: { width: 800, height: 480 } }); const p = await ctx.newPage(); p.on('pageerror', e => console.log(`[${name} pageerror]`, e.stack || e.message)); p.on('console', m => { if (m.type() === 'error') console.log(`[${name}]`, m.text().slice(0, 300)); }); p.on('frameattached', () => {}); await ctx.addInitScript(n => { localStorage.setItem('smo_quality', 'low'); localStorage.setItem('smo_noaudio', '1'); localStorage.setItem('smo_norender', n === 'guest' ? '1' : '0'); }, name); return p; };
const A = await mk('host'), B = await mk('guest');
await A.goto(`http://localhost:${port}/index.html?versus=1${process.env.VSMAP ? '&vsmap=' + process.env.VSMAP : ''}`); await B.goto(`http://localhost:${port}/index.html?versus=1`);
await A.waitForSelector('.vs-mk'); await B.waitForSelector('.vs-join');
await A.selectOption('.vs-op', op); await A.selectOption('.vs-side', side);
await A.click('.vs-mk'); await A.waitForFunction(() => document.querySelector('.vs-code')?.value.length > 20, null, { timeout: 30000 });
const inv = await A.$eval('.vs-code', e => e.value); console.log('invite code length', inv.length);
await B.fill('.vs-inv', inv); await B.click('.vs-join'); await B.waitForFunction(() => document.querySelector('.vs-rcode')?.value.length > 20, null, { timeout: 30000 });
const rep = await B.$eval('.vs-rcode', e => e.value); console.log('reply code length', rep.length);
await A.fill('.vs-reply', rep); await A.click('.vs-acc');
await A.waitForSelector('.cp-end', { timeout: 30000 }); await B.waitForSelector('.cp-end', { timeout: 30000 });
console.log('connected; both on the strategic map');
// the attacking side (the operation's own side) plans an attack on the first attackable sector
const attacker = side === op ? A : B, defender = attacker === A ? B : A;
const planned = await attacker.evaluate(() => { const secs = [...document.querySelectorAll('.cp-sec')]; for (const s of secs) { s.dispatchEvent(new MouseEvent('click', { bubbles: true })); const units = document.querySelectorAll('.cp-unit'); const plan = [...document.querySelectorAll('.cp-card button.big')].find(b => /PLAN ATTACK/.test(b.textContent)); if (plan && units.length) { [...units].slice(0, 5).forEach(u => u.click()); const p2 = [...document.querySelectorAll('.cp-card button.big')].find(b => /PLAN ATTACK/.test(b.textContent)); p2.click(); return p2.textContent; } } return null; });
console.log('planned:', planned);
await attacker.click('.cp-end'); await defender.click('.cp-end');
await A.waitForSelector('.vs-frame', { timeout: 30000 }); await B.waitForSelector('.vs-frame', { timeout: 30000 });
console.log('battle iframes open; loading…');
const fr = async p => (await (await p.$('.vs-frame')).contentFrame());
const FA = await fr(A), FB = await fr(B);
await FA.waitForFunction(() => window.game?.phase === 'deploy', null, { timeout: 300000 }); console.log('host battle loaded');
await FB.waitForFunction(() => window.game?.netClient && window.game?.phase === 'deploy', null, { timeout: 300000 }); console.log('guest battle loaded');
const guestStat = () => FB.evaluate(() => { const g = window.game; return { phase: g.phase, t: g.time?.toFixed(1), own: g.squads.filter(s => s.side === 'player').length + '+' + g.vehicles.filter(v => v.side === 'player').length, opp: g.squads.filter(s => s.side === 'enemy').length + '+' + g.vehicles.filter(v => v.side === 'enemy').length, snap: !!g.lastSnap }; });
for (let i = 0; i < 6; i++) { await A.waitForTimeout(700); try { console.log('tick', i, await FA.evaluate(() => JSON.stringify({ t: window.game.time, ph: window.game.phase, snap: window.__lastSnapSize, heap: performance.memory?.usedJSHeapSize })), await FB.evaluate(() => JSON.stringify({ snap: !!window.game.lastSnap, heap: performance.memory?.usedJSHeapSize }))); } catch (e) { console.log('tick err', e.message); break; } }
console.log('guest units', JSON.stringify(await guestStat()));
console.log('host snap size', await FA.evaluate(() => { try { return JSON.stringify(window.__lastSnapSize || null); } catch (e) { return e.message; } }));
console.log('host peer', await A.evaluate(() => { const p = window.__vs?.peer; return JSON.stringify({ bp: !!p }); }));
if (process.env.STOP) { await browser.close(); process.exit(0); }
// guest gives a move order to its first unit and readies; host readies
await FB.evaluate(() => { const g = window.game, u = g.playerUnits.find(x => x.type === 'vehicle' && !x.destroyed) || g.playerUnits[0]; const c = u.center ? u.center() : u.pos; window.__mv = { id: u.netId, from: [c.x, c.z] }; g.startBattle(); setTimeout(() => u.orderMove(c.x + 10, c.z + 60, 0, true), 500); });
await FA.evaluate(() => window.game.startBattle());
await A.waitForTimeout(+secs * 1000);
console.log('guest after battle time', JSON.stringify(await guestStat()));
console.log('host', JSON.stringify(await FA.evaluate(() => { const g = window.game, mv = window.parent; return { phase: g.phase, t: g.time.toFixed(1), enemyUnits: g.squads.filter(s => s.side === 'enemy').map(s => s.name + ':' + s.effective.length).join(','), objectives: g.objectives.map(o => o.owner).join(','), vehEnemy: g.vehicles.filter(v => v.side === 'enemy').map(v => v.name + '@' + v.pos.x.toFixed(0) + ',' + v.pos.z.toFixed(0)).join(' ') }; })));
console.log('guest moved unit', JSON.stringify(await FB.evaluate(() => { const g = window.game, u = g.netMap.get(window.__mv.id); const c = u.center ? u.center() : u.pos; return { from: window.__mv.from.map(Math.round), now: [Math.round(c.x), Math.round(c.z)] }; })));
await A.screenshot({ path: 'previews/versus/host.png' }); await B.screenshot({ path: 'previews/versus/guest.png' });
await browser.close(); server.close();
