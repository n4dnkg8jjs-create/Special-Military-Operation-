// Room-code lobby + versus campaign (v2 grid) test: host gets a short code, joiner joins by typed code and by ?join=
// link, error on unknown code; then (unless LOBBY_ONLY) several weeks of simultaneous planning with the joiner's orders
// applied by the host and both screens in sync, a battle round trip between the two players' task forces (both battle
// iframes, the joiner's move order reaches the host, results applied on both sides, both back on the map), a dropped
// link that reconnects by itself (orders given meanwhile arrive), and the host reloading the page and resuming.
// Needs a PeerJS broker: default a local one (node /tmp/pj/srv.cjs → 127.0.0.1:9000); BROKER=cloud uses 0.peerjs.com.
// Usage: node tools/mp_roomcode.mjs        (screenshots → previews/roomcode/)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
const out = process.env.OUT ? path.resolve(root, process.env.OUT) : path.join(root, 'previews/roomcode'); fs.mkdirSync(out, { recursive: true });
const RELAY = !!process.env.RELAY;   // RELAY=1: the joiner's browser may not use UDP, so every connection must go through the relay (local MQTT ws broker: node /tmp/mq/srv.cjs → :8888)
const broker = (process.env.BROKER === 'cloud' ? '' : '&peerhost=127.0.0.1&peerport=9000&peersecure=0') + (RELAY && process.env.BROKER !== 'cloud' ? '&mqtt=ws://127.0.0.1:8888' : '');
const base = `http://127.0.0.1:${port}/index.html`;
const launchOpts = { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'].concat(process.env.REAL_AUTOPLAY ? [] : ['--autoplay-policy=no-user-gesture-required']) };
if (process.env.BROKER === 'cloud' && process.env.HTTPS_PROXY) launchOpts.proxy = { server: process.env.HTTPS_PROXY.replace(/^https?:\/\/[^@]*@/, 'http://'), bypass: '127.0.0.1,localhost' };
const browser = await chromium.launch(launchOpts);
const noUdp = RELAY ? await chromium.launch({ ...launchOpts, args: [...launchOpts.args, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] }) : null;
const mk = async (name, norender, vp = { width: 1280, height: 760 }, B = browser) => { const ctx = await B.newContext({ viewport: vp }); await ctx.addInitScript(([n, a]) => { localStorage.setItem('smo_quality', 'low'); localStorage.setItem('smo_noaudio', a ? '0' : '1'); localStorage.setItem('smo_norender', n ? '1' : '0'); localStorage.setItem('smo.campaign.v2.tutorial', 'done'); }, [norender, !!process.env.AUDIO]); const p = await ctx.newPage(); p.setDefaultNavigationTimeout(180000);   // (a busy shared machine loads slowly)
  p.on('pageerror', e => console.log(`[${name} pageerror]`, e.message)); p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name} ${m.type()}]`, m.text().slice(0, 200)); }); return p; };
const snap = (P, f) => P.screenshot({ path: path.join(out, f), timeout: 120000 }).catch(e => console.log('screenshot skipped', f, e.message.split('\n')[0]));
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
  await Promise.all([H.waitForSelector('#c2 .c2-end', { timeout: 60000 }), G.waitForSelector('#c2 .c2-end', { timeout: 60000 })]);
  ok(true, `link join: both on the sector map in ${Date.now() - t0} ms`);
  await H.context().close(); await G.context().close(); }

// 2b. no usable network path (joiner's browser may not use UDP) → strict-network message after ~15 s on both sides
if (!process.env.SKIP_NAT && !RELAY) { const B2 = await chromium.launch({ ...launchOpts, args: [...launchOpts.args, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  const H = await mk('h2', true), ctx = await B2.newContext({ viewport: { width: 1280, height: 760 } }); await ctx.addInitScript(() => { localStorage.setItem('smo_noaudio', '1'); localStorage.setItem('smo_norender', '1'); });
  const G = await ctx.newPage(); const code = await host(H);
  await G.goto(`${base}?versus=1${broker}`); await G.fill('.vs-codein', code); await G.click('.vs-joinbtn');
  await G.waitForFunction(() => /strict network/.test(document.querySelector('.vs-msg').textContent), null, { timeout: 30000 }).catch(() => {});
  ok(/strict network/.test(await msg(G)), 'joiner, no direct path: ' + await msg(G));
  await H.waitForFunction(() => /strict network/.test(document.querySelector('.vs-msg').textContent), null, { timeout: 20000 }).catch(() => {});
  ok(/strict network/.test(await msg(H)), 'host, no direct path: ' + await msg(H));
  await G.click('.vs-adv summary'); await snap(G, 'joiner_strict_nat.png');
  await H.context().close(); await B2.close(); }

// 3. typed code (lowercase, no dash) + battle
const H = await mk('host', !!process.env.HOST_NORENDER), G = await mk('guest', true, undefined, noUdp || browser);
const code = await host(H, 'UA');
await snap(H, 'host_lobby.png');
await G.goto(`${base}?versus=1${broker}`); await G.waitForSelector('.vs-codein');
await G.type('.vs-codein', code.toLowerCase()); ok(await G.$eval('.vs-codein', e => e.value) === code.slice(0, 3) + '-' + code.slice(3), 'input auto-formats to ' + await G.$eval('.vs-codein', e => e.value));
await snap(G, 'joiner_code.png');
await G.click('.vs-joinbtn');
await G.waitForFunction(() => /Connected/.test(document.querySelector('.vs-msg')?.textContent || ''), null, { timeout: RELAY ? 45000 : 20000 });
if (RELAY) ok(/through relay/.test(await msg(G)), 'joiner connected through the relay: ' + await msg(G));
console.log('joiner status:', await msg(G)); console.log('host status:', await msg(H).catch(() => '(left lobby)'));
await snap(G, 'joiner_connected.png');
await Promise.all([H.waitForSelector('#c2 .c2-end', { timeout: 60000 }), G.waitForSelector('#c2 .c2-end', { timeout: 60000 })]);
ok(true, 'typed-code join: both on the sector map');
for (const [n, P] of [['host', H], ['joiner', G]]) console.log(n, 'link', await P.evaluate(() => { const p = window.__vsPeer; return JSON.stringify({ kind: p.constructor.name, ctl: p.ctl?.readyState, snap: p.snap?.readyState, rtt: p.rtt, mode: p.mode || 'direct' }); }));
const closeModals = async P => { for (let i = 0; i < 6; i++) { const b = await P.$('#c2 .c2-modal button.pri'); if (!b) { const t = await P.$('.c2-tut .c2-tut-skip'); if (t) { await t.click(); continue; } return; } await b.click().catch(() => {}); await P.waitForTimeout(150); } };
await H.waitForTimeout(1500); await closeModals(H); await closeModals(G);
await snap(H, 'vs_host_map.png'); await snap(G, 'vs_joiner_map.png');
if (process.env.LOBBY_ONLY) { await browser.close(); server.close(); process.exit(); }
// both sides' view of the joiner's side must be identical once the host has acknowledged everything
const sync = async what => {
  await G.waitForFunction(() => { const L = window.__vsLink, u = window.__vsUi; return u && L?.connected; }, null, { timeout: 30000 }).catch(() => {});
  await H.waitForTimeout(900);
  const g = await G.evaluate(() => { const C = window.__vsUi.C; return { turn: C.turn, lp: C.lp, f: C.forces.map(t => `${t.id}@${t.cell}:${t.units.length}:${(+t.mp).toFixed(2)}`).sort().join(' ') }; });
  const h = await H.evaluate(() => { const V = window.__vsGame, C = V.side[V.guest]; return { turn: C.turn, lp: C.lp, f: C.forces.map(t => `${t.id}@${t.cell}:${t.units.length}:${(+t.mp).toFixed(2)}`).sort().join(' ') }; });
  ok(JSON.stringify(g) === JSON.stringify(h), `${what}: joiner and host agree on the joiner's side ${JSON.stringify(g).slice(0, 160)} | host ${JSON.stringify(h).slice(0, 160)}`);
  const own = await Promise.all([H, G].map(P => P.evaluate(() => { const u = window.__vsUi, C = u.C; return C.def.aor.cells.filter(c => C.owner[c.id] === 'player').length; })));
  ok(own[0] + own[1] === await H.evaluate(() => window.__vsGame.sdef.UA.aor.cells.length), `${what}: ownership complementary (${own})`);
};
const endWeek = async () => {
  const t0 = await H.evaluate(() => window.__vsGame.turn);
  await G.click('#c2 .c2-end'); await G.waitForTimeout(400);
  ok(/WAITING/.test(await G.$eval('#c2 .c2-end', e => e.textContent)), 'joiner: END WEEK → WAITING…');
  await H.waitForFunction(() => /ended the week/.test(document.querySelector('.c2-vs')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  ok(/ended the week/.test(await H.$eval('.c2-vs', e => e.textContent)), 'host sees the opponent ready: ' + await H.$eval('.c2-vs', e => e.textContent));
  await H.click('#c2 .c2-end');
  await H.waitForFunction(t => window.__vsGame.turn > t, t0, { timeout: 600000 });
  await G.waitForFunction(t => (window.__vsUi?.C?.turn || 0) > t, t0, { timeout: 60000 }).catch(() => {});
  const r = await Promise.all([H, G].map(P => P.evaluate(() => ({ turn: window.__vsUi.C.turn, report: !!document.querySelector('#c2 .c2-report') }))));
  ok(r[0].turn === t0 + 1 && r[1].turn === t0 + 1, `week ${t0} → both on week ${r[0].turn}/${r[1].turn}`);
  ok(r[0].report && r[1].report, `weekly report on both screens ${JSON.stringify(r)}`);
  await closeModals(H); await closeModals(G);
};
// ---- week 1: the joiner moves a task force (its own screen at once, the host applies it), the host splits one
const mv = await G.evaluate(() => { const u = window.__vsUi, C = u.C; for (const t of C.forces) { const R = C.reach(t), d = Object.keys(R.dist).find(id => id !== t.cell && C.plan(t.id, id, R).ok && !C.plan(t.id, id, R).attack); if (d) { u.select(t.id); u.order(d); return { tf: t.id, to: d, local: C.tf(t.id).cell }; } } return null; });
ok(mv && mv.local === mv.to, `joiner moved ${JSON.stringify(mv)}`);
await H.waitForFunction(m => window.__vsGame.side[window.__vsGame.guest].tf(m.tf)?.cell === m.to, mv, { timeout: 15000 }).catch(() => {});
ok(await H.evaluate(m => window.__vsGame.side[window.__vsGame.guest].tf(m.tf)?.cell === m.to, mv), 'host applied the joiner move');
await H.evaluate(() => { const u = window.__vsUi, C = u.C, t = C.forces.find(x => x.units.length > 2); if (t) { u.pick = new Set([t.units[0]]); u.select(t.id); u.pick = new Set([t.units[0]]); u.renderRight(); [...document.querySelectorAll('.c2-card.tfsel button')].find(b => /Split off/.test(b.textContent))?.click(); } });
await sync('week 1 planning');
await endWeek(); await sync('after week 1');
await endWeek(); await sync('after week 2');
if (!process.env.SKIP_BATTLE && !process.env.SKIP_BATTLE1) {
// ---- a battle between the two players: put a host task force next to a joiner task force and plan the attack
const plan = await H.evaluate(() => {
  const V = window.__vsGame, me = V.host, them = V.guest, A = V.side[me], D = V.side[them];
  for (const g of D.forces) for (const n of A.neighbors(g.cell)) {
    if (A.owner[n] !== 'player' || A.forcesAt(n).length) continue;
    const t = A.forces.find(x => A.tfPower(x) > 2) || A.forces[0]; t.cell = n; A.resetMoves(); A.computeSupply();
    const p = A.plan(t.id, g.cell); if (!p.ok || !p.attack) continue;
    window.__vsUi.planAttack(t, g.cell, false); return { tf: t.id, cell: g.cell, planned: !!t.planned, gtf: g.id, gn: D.battleUnits(g.units).length };
  }
  return null;
});
ok(plan?.planned, `host planned an attack on the joiner's task force ${JSON.stringify(plan)}`);
const g0 = await G.evaluate(() => window.__vsUi.C.stats.battles);
await G.click('#c2 .c2-end'); await H.waitForTimeout(800); await H.click('#c2 .c2-end');
await H.waitForSelector('.vs-frame', { timeout: 60000 }); await G.waitForSelector('.vs-frame', { timeout: 60000 });
ok(true, 'both players in the battle iframe');
await G.waitForTimeout(3000); await G.screenshot({ path: path.join(out, 'vs_joiner_battle_wait.png'), timeout: 120000 }).catch(e => console.log('screenshot skipped:', e.message.split('\n')[0]));
const FA = await (await H.$('.vs-frame')).contentFrame(), FB = await (await G.$('.vs-frame')).contentFrame();
await FA.waitForFunction(() => window.game?.phase === 'deploy', null, { timeout: 400000 });
await FB.waitForFunction(() => window.game?.netClient && window.game?.phase === 'deploy', null, { timeout: 400000 });
ok(true, 'both battle iframes loaded (deploy)');
console.log('host battle', await FA.evaluate(() => ({ map: window.game.map?.id || window.game.opts.map, own: window.game.playerUnits.length, enemy: window.game.squads.filter(s => s.side === 'enemy').length + window.game.vehicles.filter(v => v.side === 'enemy').length })));
// both ready → the battle starts; then the joiner orders a unit 60 m towards the middle of the map
await FB.evaluate(() => window.game.startBattle()); await FA.evaluate(() => window.game.startBattle());
await FA.waitForFunction(() => window.game.phase !== 'deploy', null, { timeout: 60000 }).catch(() => {});
await FB.waitForFunction(() => window.game.phase !== 'deploy', null, { timeout: 60000 }).catch(() => {});
// a vehicle and a dismounted squad, each 60 m towards the middle of the map
await FB.evaluate(() => { const g = window.game; window.__mv = []; for (const u of [g.playerUnits.find(x => x.type === 'vehicle' && !x.destroyed), g.playerUnits.find(x => x.type === 'squad' && !x.mounted && !x.destroyed)]) { if (!u) continue; const c = u.center ? u.center() : u.pos; const L = Math.hypot(c.x, c.z) || 1, to = [c.x - c.x / L * 60, c.z - c.z / L * 60]; window.__mv.push({ id: u.netId, type: u.type, from: [c.x, c.z], to }); u.orderMove(to[0], to[1], null, u.type === 'squad' ? 18 : true); } });
await H.waitForTimeout(15000);
const mvs = await FB.evaluate(() => window.__mv);
const hostSaw = await FA.evaluate(mvs => mvs.map(m => { const g = window.game, u = [...g.squads, ...g.vehicles].find(x => x.id === m.id); if (!u) return { missing: m.id }; const c = u.center ? u.center() : u.pos; return { type: u.type, side: u.side, pos: [Math.round(c.x), Math.round(c.z)], moved: Math.round(Math.hypot(c.x - m.from[0], c.z - m.from[1])), order: u.order ? { type: u.order.type, x: Math.round(u.order.x ?? NaN), z: Math.round(u.order.z ?? NaN) } : null, goal: u.goal || null, path: u.path ? u.path.length : null, immobile: !!u.immobile }; }), mvs);
console.log('joiner orders seen on the host', JSON.stringify(hostSaw), JSON.stringify(mvs.map(m => ({ type: m.type, to: m.to.map(Math.round) }))));
ok(hostSaw.some((h, i) => h.moved > 5 || (h.order && Math.abs(h.order.x - mvs[i].to[0]) < 2 && Math.abs(h.order.z - mvs[i].to[1]) < 2) || (h.goal && Math.abs(h.goal[0] - mvs[i].to[0]) < 2)), 'joiner move orders arrived on the host');
ok(hostSaw.some(h => h.moved > 5), 'a joiner unit moved on the host');
ok(await FB.evaluate(() => !!window.game.lastSnap), 'joiner receives snapshots');
await H.screenshot({ path: path.join(out, 'vs_host_battle.png') }).catch(() => {}); await G.screenshot({ path: path.join(out, 'vs_joiner_battle.png') }).catch(() => {});
// end the battle: the host wins, both return to the map, results applied on both sides
await FA.evaluate(() => { const g = window.game; g.over = true; g.result = { win: true, title: 'VICTORY', why: 'test' }; setTimeout(() => window.__campaignReturn(), 50); }).catch(() => {});   // (the iframe goes away with the return)
await H.waitForFunction(() => !document.querySelector('.vs-frame'), null, { timeout: 60000 });
await G.waitForFunction(() => !document.querySelector('.vs-frame'), null, { timeout: 60000 });
ok(true, 'battle iframes closed on both sides');
await H.waitForFunction(() => window.__vsGame.phase === 'plan', null, { timeout: 60000 });
await G.waitForFunction(g0 => (window.__vsUi?.C?.stats?.battles || 0) > g0, g0, { timeout: 30000 }).catch(() => {});
const br = await Promise.all([H.evaluate(p => { const V = window.__vsGame; return { cellOwner: V.own[p.cell], history: V.history.slice(-1)[0], turn: V.turn }; }, plan), G.evaluate(p => ({ battles: window.__vsUi.C.stats.battles, owner: window.__vsUi.C.owner[p.cell], gtf: window.__vsUi.C.tf(p.gtf)?.cell, turn: window.__vsUi.C.turn }), plan)]);
console.log('after battle', JSON.stringify(br));
ok(br[0].history?.cell === plan.cell && br[1].battles > g0, 'battle result applied on both sides');
ok(br[0].cellOwner === await H.evaluate(() => window.__vsGame.host) && br[1].owner === 'enemy' && br[1].gtf !== plan.cell, 'host won: the square changed hands and the joiner task force fell back');
await closeModals(H); await closeModals(G);
await snap(G, 'vs_joiner_after_battle.png');
await sync('after the battle week');
}
// ---- a dropped link: the joiner's connection dies; it reconnects through the same room code by itself
await G.evaluate(() => window.__vsLink.drop('test'));
await H.waitForFunction(() => !window.__vsLink.connected, null, { timeout: 40000 }).catch(() => {});
ok(await H.evaluate(() => !window.__vsLink.connected), 'host noticed the drop');
await G.waitForTimeout(1200); await snap(G, 'vs_joiner_reconnecting.png'); await snap(H, 'vs_host_opponent_lost.png');
const mv2 = await G.evaluate(() => { const u = window.__vsUi, C = u.C; for (const t of C.forces) { const R = C.reach(t), d = Object.keys(R.dist).find(id => id !== t.cell && C.plan(t.id, id, R).ok && !C.plan(t.id, id, R).attack); if (d) { u.select(t.id); u.order(d); return { tf: t.id, to: d }; } } return null; });
await G.waitForFunction(() => window.__vsLink.connected, null, { timeout: 90000 }).catch(() => {});
await H.waitForFunction(() => window.__vsLink.connected, null, { timeout: 30000 }).catch(() => {});
ok(await G.evaluate(() => window.__vsLink.connected) && await H.evaluate(() => window.__vsLink.connected), 'reconnected through the room code');
if (mv2) { await H.waitForFunction(m => window.__vsGame.side[window.__vsGame.guest].tf(m.tf)?.cell === m.to, mv2, { timeout: 15000 }).catch(() => {}); ok(await H.evaluate(m => window.__vsGame.side[window.__vsGame.guest].tf(m.tf)?.cell === m.to, mv2), 'order given while disconnected reached the host'); }
await sync('after reconnect');
await endWeek(); await sync('week after reconnect');
// ---- the host reloads the page: resume from the Versus menu with the same code, the joiner rejoins by itself
if (!process.env.SKIP_RESUME) {
  const tH = await H.evaluate(() => window.__vsGame.turn);
  await H.goto(`${base}?versus=1${broker}`); await H.waitForSelector('.vs-resumebtn', { timeout: 30000 });
  await snap(H, 'vs_host_resume_lobby.png');
  await H.waitForTimeout(500); ok(await H.$eval('.vs-resumebtn', b => b.disabled), 'host page reloaded mid-game: the saved game resumes by itself');
  await H.click('.vs-resumebtn', { timeout: 1000 }).catch(() => {});   // (disabled: no second registration)
  await H.waitForSelector('#c2 .c2-end', { timeout: 120000 });
  await G.waitForFunction(() => window.__vsLink.connected, null, { timeout: 120000 }).catch(() => {});
  ok(await H.evaluate(t => window.__vsGame.turn === t, tH), 'host resumed the saved game');
  ok(await G.evaluate(() => window.__vsLink.connected), 'joiner rejoined the resumed game');
  await closeModals(H); await closeModals(G);
  await sync('after host resume');
  await endWeek(); await sync('week after resume');
}
// ---- the host reloads DURING a battle: after the resume the battle is fought again, and the joiner gets it as a new
// battle (a fresh iframe, not the dead one of the first attempt); the result is applied on both sides
if (!process.env.SKIP_RESUME && !process.env.SKIP_BATTLE && !process.env.SKIP_MIDBATTLE) {
  const plan2 = await H.evaluate(() => {
    const V = window.__vsGame, A = V.side[V.host], D = V.side[V.guest];
    for (const g of D.forces) for (const n of A.neighbors(g.cell)) {
      if (A.owner[n] !== 'player' || A.forcesAt(n).length) continue;
      const t = A.forces.find(x => A.tfPower(x) > 2) || A.forces[0]; t.cell = n; A.resetMoves(); A.computeSupply();
      const p = A.plan(t.id, g.cell); if (!p.ok || !p.attack) continue;
      window.__vsUi.planAttack(t, g.cell, false); return { tf: t.id, cell: g.cell, planned: !!t.planned };
    }
    return null;
  });
  ok(plan2?.planned, `mid-battle reload: host planned an attack ${JSON.stringify(plan2)}`);
  await G.click('#c2 .c2-end'); await H.waitForTimeout(800); await H.click('#c2 .c2-end');
  await H.waitForSelector('.vs-frame', { timeout: 60000 }); await G.waitForSelector('.vs-frame', { timeout: 60000 });
  const id1 = await G.evaluate(() => window.__vsLink.battleId); await H.waitForTimeout(3000);
  await H.goto(`${base}?versus=1${broker}`);   // the saved game resumes by itself, the week goes on with the battle
  await H.waitForSelector('.vs-frame', { timeout: 180000 }).catch(() => {});
  await G.waitForFunction(id => window.__vsLink.connected && window.__vsLink.battleId && window.__vsLink.battleId !== id && !!document.querySelector('.vs-frame'), id1, { timeout: 120000 }).catch(() => {});
  const id2 = await G.evaluate(() => window.__vsLink.battleId);
  ok(await H.$('.vs-frame') && id2 && id2 !== id1, `host reloaded mid-battle: the battle restarts on both screens (${id1} → ${id2})`);
  const FA2 = await (await H.$('.vs-frame'))?.contentFrame();
  if (FA2) {
    await FA2.waitForFunction(() => window.game?.phase === 'deploy', null, { timeout: 400000 }).catch(() => {});
    await FA2.evaluate(() => { const g = window.game; g.over = true; g.result = { win: false, title: 'DEFEAT', why: 'test' }; setTimeout(() => window.__campaignReturn(), 50); }).catch(() => {});
  }
  await H.waitForFunction(() => window.__vsGame?.phase === 'plan' && !document.querySelector('.vs-frame'), null, { timeout: 120000 }).catch(() => {});
  await G.waitForFunction(() => !document.querySelector('.vs-frame'), null, { timeout: 60000 }).catch(() => {});
  const h2 = await H.evaluate(p => { const V = window.__vsGame; return { phase: V.phase, last: V.history.slice(-1)[0] }; }, plan2);
  ok(h2.phase === 'plan' && h2.last?.cell === plan2?.cell && !h2.last.win && !(await G.$('.vs-frame')), `mid-battle reload: battle result applied, both back on the map ${JSON.stringify(h2)}`);
  await H.waitForTimeout(1500); await closeModals(H); await closeModals(G);
  await sync('after the mid-battle reload');
}
// ---- the joiner's page is reloaded mid-game: it rejoins the room by itself
if (!process.env.SKIP_RESUME) {
  await G.goto(`${base}?versus=1${broker}`);
  await G.waitForSelector('#c2 .c2-end', { timeout: 120000 }).catch(() => {});
  ok(await G.$('#c2 .c2-end'), 'joiner page reloaded mid-game: rejoined by itself');
  await closeModals(G); await sync('after joiner reload');
}
// ---- the end of the operation: fast-forward the host's game to its last week, both end it → the outcome on both screens
{
  await H.evaluate(() => { const V = window.__vsGame, C0 = V.side[V.opId]; for (let i = 0; i < 80 && V.phase === 'plan' && C0.turn < C0.maxTurn - 1 && C0.date < C0.def.start.end; i++) { V.setReady('UA', true); V.setReady('RU', true); V.buildQueue(); for (let b; (b = V.nextAttack());) V.autoBattle(b); V.endWeek(); } window.__vsUi.vs.toggleReady(); window.__vsUi.vs.toggleReady(); window.__vsUi.setCampaign(window.__vsUi.C); });
  await H.waitForTimeout(1500); await closeModals(H); await G.waitForTimeout(1500);
  for (let i = 0; i < 4; i++) { const b = await G.$('#c2 .c2-modal button.pri'); if (!b) break; await b.click(); await G.waitForTimeout(300); }
  const ph = await H.evaluate(() => window.__vsGame.phase);
  if (ph === 'plan') { await G.click('#c2 .c2-end'); await G.waitForTimeout(600); await H.click('#c2 .c2-end'); }
  await H.waitForFunction(() => window.__vsGame.phase === 'over', null, { timeout: 300000 }).catch(() => {});
  ok(await H.evaluate(() => window.__vsGame.phase === 'over' && !!window.__vsGame.result), 'the operation ends: ' + JSON.stringify(await H.evaluate(() => window.__vsGame.result)));
  const outcome = async P => { for (let i = 0; i < 8; i++) { const t = await P.evaluate(() => [...document.querySelectorAll('#c2 .c2-modal h1')].map(e => e.textContent).join('|')); if (/VICTORY|DEFEAT|DRAW/.test(t)) return t; const b = await P.$('#c2 .c2-modal button.pri'); if (b && !/MENU/.test(await b.textContent())) await b.click(); await P.waitForTimeout(800); } return ''; };
  const oh = await outcome(H), og = await outcome(G);
  ok(oh && og && oh !== og || (oh === 'DRAW' && og === 'DRAW'), `outcome on both screens: host ${oh}, joiner ${og}`);
  await snap(H, 'vs_host_outcome.png'); await snap(G, 'vs_joiner_outcome.png');
  ok(/GAME OVER/.test(await G.$eval('#c2 .c2-end', e => e.textContent)), 'joiner: END WEEK button shows GAME OVER');
}
await browser.close(); await noUdp?.close(); server.close();
