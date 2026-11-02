// Room-code lobby test: host gets a short code, joiner joins by typed code and by ?join= link, error on unknown code,
// then (unless LOBBY_ONLY) a planned attack → both battle iframes → the joiner's move order reaches the host.
// Needs a PeerJS broker: default a local one (node /tmp/pj/srv.cjs → 127.0.0.1:9000); BROKER=cloud uses 0.peerjs.com.
// Usage: node tools/mp_roomcode.mjs        (screenshots → previews/roomcode/)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
const out = path.join(root, 'previews/roomcode'); fs.mkdirSync(out, { recursive: true });
const broker = process.env.BROKER === 'cloud' ? '' : '&peerhost=127.0.0.1&peerport=9000&peersecure=0';
const base = `http://127.0.0.1:${port}/index.html`;
const launchOpts = { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] };
if (process.env.BROKER === 'cloud' && process.env.HTTPS_PROXY) launchOpts.proxy = { server: process.env.HTTPS_PROXY.replace(/^https?:\/\/[^@]*@/, 'http://'), bypass: '127.0.0.1,localhost' };
const browser = await chromium.launch(launchOpts);
const mk = async (name, norender, vp = { width: 1280, height: 760 }) => { const ctx = await browser.newContext({ viewport: vp }); await ctx.addInitScript(n => { localStorage.setItem('smo_quality', 'low'); localStorage.setItem('smo_noaudio', '1'); localStorage.setItem('smo_norender', n ? '1' : '0'); }, norender); const p = await ctx.newPage(); p.on('pageerror', e => console.log(`[${name} pageerror]`, e.message)); p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name} ${m.type()}]`, m.text().slice(0, 200)); }); return p; };
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const msg = p => p.$eval('.vs-msg', e => e.textContent);
const host = async (p, side = 'UA') => { await p.goto(`${base}?versus=1${broker}`); await p.waitForSelector('.vs-host'); await p.check(`input[name=vs-side][value=${side}]`, { force: true }); await p.click('.vs-host'); await p.waitForFunction(() => window.__roomCode, null, { timeout: 20000 }); return p.evaluate(() => window.__roomCode); };

// 1. unknown code → clear error
{ const G = await mk('g0', true); await G.goto(`${base}?versus=1${broker}`); await G.waitForSelector('.vs-codein');
  await G.fill('.vs-codein', 'zzz-222'); await G.click('.vs-joinbtn'); await G.waitForFunction(() => /No game with code/.test(document.querySelector('.vs-msg').textContent), null, { timeout: 20000 }).catch(() => {});
  ok(/No game with code ZZZ-222/.test(await msg(G)), 'unknown code: ' + await msg(G));
  await G.fill('.vs-codein', 'O1L'); await G.click('.vs-joinbtn'); ok(/never contain|6-character/.test(await msg(G)), 'bad input: ' + await msg(G));
  await G.context().close(); }

// 2. join via ?join= link
{ const H = await mk('h1', true), G = await mk('g1', true); const code = await host(H);
  ok(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(code), 'host code ' + code + ' shown as ' + await H.$eval('.vs-code-big', e => e.textContent));
  const link = await H.$eval('.vs-link', e => e.value); ok(link.includes('?join=' + code), 'link ' + link);
  const t0 = Date.now(); await G.goto(link);
  await Promise.all([H.waitForSelector('.cp-end', { timeout: 30000 }), G.waitForSelector('.cp-end', { timeout: 30000 })]);
  ok(true, `link join: both on the sector map in ${Date.now() - t0} ms`);
  await H.context().close(); await G.context().close(); }

// 2b. no usable network path (joiner's browser may not use UDP) → strict-network message after ~15 s on both sides
if (!process.env.SKIP_NAT) { const B2 = await chromium.launch({ ...launchOpts, args: [...launchOpts.args, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  const H = await mk('h2', true), ctx = await B2.newContext({ viewport: { width: 1280, height: 760 } }); await ctx.addInitScript(() => { localStorage.setItem('smo_noaudio', '1'); localStorage.setItem('smo_norender', '1'); });
  const G = await ctx.newPage(); const code = await host(H);
  await G.goto(`${base}?versus=1${broker}`); await G.fill('.vs-codein', code); await G.click('.vs-joinbtn');
  await G.waitForFunction(() => /strict network/.test(document.querySelector('.vs-msg').textContent), null, { timeout: 30000 }).catch(() => {});
  ok(/strict network/.test(await msg(G)), 'joiner, no direct path: ' + await msg(G));
  await H.waitForFunction(() => /strict network/.test(document.querySelector('.vs-msg').textContent), null, { timeout: 20000 }).catch(() => {});
  ok(/strict network/.test(await msg(H)), 'host, no direct path: ' + await msg(H));
  await G.click('.vs-adv summary'); await G.screenshot({ path: path.join(out, 'joiner_strict_nat.png') });
  await H.context().close(); await B2.close(); }

// 3. typed code (lowercase, no dash) + battle
const H = await mk('host', !!process.env.HOST_NORENDER), G = await mk('guest', true);
const code = await host(H, 'UA');
await H.screenshot({ path: path.join(out, 'host_lobby.png') });
await G.goto(`${base}?versus=1${broker}`); await G.waitForSelector('.vs-codein');
await G.type('.vs-codein', code.toLowerCase()); ok(await G.$eval('.vs-codein', e => e.value) === code.slice(0, 3) + '-' + code.slice(3), 'input auto-formats to ' + await G.$eval('.vs-codein', e => e.value));
await G.screenshot({ path: path.join(out, 'joiner_code.png') });
await G.click('.vs-joinbtn');
await G.waitForFunction(() => /Connected/.test(document.querySelector('.vs-msg')?.textContent || ''), null, { timeout: 20000 });
console.log('joiner status:', await msg(G)); console.log('host status:', await msg(H).catch(() => '(left lobby)'));
await G.screenshot({ path: path.join(out, 'joiner_connected.png') });
await Promise.all([H.waitForSelector('.cp-end', { timeout: 30000 }), G.waitForSelector('.cp-end', { timeout: 30000 })]);
ok(true, 'typed-code join: both on the sector map');
for (const [n, P] of [['host', H], ['joiner', G]]) console.log(n, 'link', await P.evaluate(() => { const p = window.__vsPeer; return JSON.stringify({ kind: p.constructor.name, ctl: p.ctl?.readyState, ctlOrdered: p.ctl?.ordered, snap: p.snap?.readyState, snapOrdered: p.snap?.ordered, snapRetx: p.snap?.maxRetransmits, rtt: p.rtt, broker: p.pj?.disconnected }); }));
console.log('host status bar:', await H.evaluate(() => document.body.innerText.match(/Versus:[^\n]*/)?.[0]));
await H.screenshot({ path: path.join(out, 'host_map.png') });
if (process.env.LOBBY_ONLY) { await browser.close(); server.close(); process.exit(); }

const planned = await H.evaluate(() => { for (const s of document.querySelectorAll('.cp-sec')) { s.dispatchEvent(new MouseEvent('click', { bubbles: true })); const units = document.querySelectorAll('.cp-unit'); const plan = [...document.querySelectorAll('.cp-card button.big')].find(b => /PLAN ATTACK/.test(b.textContent)); if (plan && units.length) { [...units].slice(0, 5).forEach(u => u.click()); [...document.querySelectorAll('.cp-card button.big')].find(b => /PLAN ATTACK/.test(b.textContent)).click(); return true; } } return false; });
ok(planned, 'host planned an attack');
await H.click('.cp-end'); await G.click('.cp-end');
await H.waitForSelector('.vs-frame', { timeout: 30000 }); await G.waitForSelector('.vs-frame', { timeout: 30000 });
const FA = await (await H.$('.vs-frame')).contentFrame(), FB = await (await G.$('.vs-frame')).contentFrame();
await FA.waitForFunction(() => window.game?.phase === 'deploy', null, { timeout: 300000 });
await FB.waitForFunction(() => window.game?.netClient && window.game?.phase === 'deploy', null, { timeout: 300000 });
ok(true, 'both battle iframes loaded (deploy)');
await FB.evaluate(() => { const g = window.game, u = g.playerUnits.find(x => x.type === 'vehicle' && !x.destroyed) || g.playerUnits[0]; const c = u.center ? u.center() : u.pos; window.__mv = { id: u.netId, from: [c.x, c.z] }; g.startBattle(); setTimeout(() => u.orderMove(c.x + 10, c.z + 60, 0, true), 500); });
await FA.evaluate(() => window.game.startBattle());
await H.waitForTimeout(15000);
const hostSaw = await FA.evaluate(id => { const g = window.game; const u = [...g.squads, ...g.vehicles].find(x => x.netId === id || x.id === id); return u ? { phase: g.phase, t: +g.time.toFixed(1), pos: (u.center ? [u.center().x, u.center().z] : [u.pos.x, u.pos.z]).map(Math.round) } : { phase: g.phase, missing: id }; }, await FB.evaluate(() => window.__mv.id));
const from = await FB.evaluate(() => window.__mv.from.map(Math.round));
console.log('host view of the joiner unit', JSON.stringify(hostSaw), 'from', JSON.stringify(from));
ok(hostSaw.pos && Math.hypot(hostSaw.pos[0] - from[0], hostSaw.pos[1] - from[1]) > 5, 'joiner move order arrived and executed on the host');
ok(await FB.evaluate(() => !!window.game.lastSnap), 'joiner receives snapshots');
await browser.close(); server.close();
