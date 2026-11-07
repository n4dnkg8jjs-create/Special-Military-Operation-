// Versus battle sync check: the host's and the joiner's battle pages (each in the iframe its lobby page would open,
// window.__vs as versus_ui.js sets it, each in its own headless browser) linked by a loopback peer through node (JSON
// round trip, a little latency, optional snapshot loss), a real versus setup from the campaign (VersusGame: a host task force against the joiner's), both
// sides given orders, mortar / artillery missions, then every N s the joiner's puppet state is compared with the
// host's: units, soldiers (state, position), vehicles (hp, wreck, burning), tickets, objectives, mission counts,
// drones, medevac pickups, building damage, craters. Prints the divergences; exit code 1 on a hard desync.
// Usage: flock /tmp/heavy.lock nice -n 10 node tools/mp_sync.mjs [seconds=150] [map=farmland]   (env DROP=0.1: lose 10% of snapshots)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [SECS = '150', MAPID = 'farmland'] = process.argv.slice(2);
// ---- a versus battle from the campaign rules (host = UA attacks a RU task force)
const mem = {}; globalThis.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
const { loadCampaigns } = await import('../src/campaign/v2/index.js');
const { VersusGame } = await import('../src/campaign/v2/versus.js');
const { defs } = await loadCampaigns();
const V = new VersusGame(defs, 'UA', 'UA'), HC = V.side.UA, GC = V.side.RU;
// the two biggest task forces of each side (a bigger fight than one battalion group against another)
const big = C => C.forces.slice().sort((a, b) => C.battleUnits(b.units).length - C.battleUnits(a.units).length).slice(0, 2);
const gts = big(GC), hts = big(HC), gt = gts[0], gU = gts.flatMap(t => t.units), hU = hts.flatMap(t => t.units);
const setup = HC.battleSetup(gt.cell, hU, 'attack'); setup.enemy = []; setup.map = MAPID;
const hostOpts = { side: 'UA', map: MAPID, campaign: setup, net: { role: 'host', enemyForce: JSON.parse(JSON.stringify(GC.battleUnits(gU))), enemyMods: GC.battleMods(gt.cell, gU) } };
const joinOpts = { side: 'RU', map: MAPID, campaign: { sectorName: setup.sectorName, mode: 'defend', force: [], enemy: [] }, net: { role: 'client' } };
// each side in its own browser (its own renderer process: two battles in one process ran out of memory on big maps);
// a page holds the battle iframe and its end of the loopback peer, node carries the messages between the two
const PAGE = `<!doctype html><html><body style="margin:0;background:#000"><script>
const DROP = ${+(process.env.DROP || 0)};
window.__peer = { handlers: {}, last: {}, sent: 0, bytes: 0,
  on(t, f) { (this.handlers[t] ||= []).push(f); if (t === 'manifest' && this.last.manifest) f(this.last.manifest); return this; }, off() {},
  deliver(t, d) { if (t === 'manifest') this.last.manifest = d; for (const f of this.handlers[t] || []) try { f(d); } catch (e) { console.error('peer', t, e); } },
  send(t, d) { const s = JSON.stringify(d); this.sent++; this.bytes += s.length; window.__mpSend(t, s); },
  sendSnap(t, d) { if (Math.random() < DROP) return; this.send(t, d); } };
window.__start = (id, o) => {
  window.__vs = { peer: window.__peer, opts: o, done: (a, b) => { window.__result = [a, b]; }, fail: m => { window.__fail = m; } };
  const A = document.createElement('iframe'); A.id = id; A.style.cssText = 'width:640px;height:400px;border:0'; A.src = '/index.html?vsbattle=1'; document.body.appendChild(A);
};
</script></body></html>`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm', '.ktx2': 'application/octet-stream', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => { const u = decodeURIComponent(req.url.split('?')[0]); if (u === '/__mp.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); } const p = path.join(root, u); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const launch = () => chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--js-flags=--max-old-space-size=4096'] });
const errs = [], pages = {};
const mkPage = async name => { const br = await launch(), ctx = await br.newContext({ viewport: { width: 660, height: 420 } });
  await ctx.addInitScript(() => { localStorage.setItem('smo_quality', 'low'); localStorage.setItem('smo_noaudio', '1'); localStorage.setItem('smo_norender', '1'); });
  const p = await ctx.newPage(); p.br = br;
  p.on('pageerror', e => { errs.push(e.message); console.log(`[${name} pageerror]`, e.message); });
  p.on('console', m => { if (m.type() === 'error' || (m.type() === 'warning' && /replay|net|medevac|versus/i.test(m.text()))) { const t = m.text().slice(0, 240); if (!/404|GPU stall|GroupMarker/.test(t)) { errs.push(t); console.log(`[${name} ${m.type()}]`, t); } } });
  const LAT = 25; await p.exposeFunction('__mpSend', (t, s) => { const o = pages[name === 'host' ? 'joiner' : 'host']; setTimeout(() => o?.evaluate(([t, s]) => window.__peer.deliver(t, JSON.parse(s)), [t, s]).catch(() => {}), LAT); });
  await p.goto(`http://127.0.0.1:${server.address().port}/__mp.html`); pages[name] = p; return p; };
const PH = await mkPage('host'), PJ = await mkPage('joiner'), page = PH;
await PH.evaluate(o => window.__start('host', o), hostOpts);
await PH.waitForFunction(() => document.getElementById('host')?.contentWindow?.game, null, { timeout: 600000 });
await PJ.evaluate(o => window.__start('joiner', o), joinOpts);
const fr = async id => { const P = id === 'host' ? PH : PJ; for (let i = 0; i < 600; i++) { const h = await P.$('#' + id); const f = h && await h.contentFrame(); if (f) return f; await P.waitForTimeout(200); } throw new Error('no frame ' + id); };
const FH = await fr('host'); await FH.waitForFunction(() => window.game?.phase === 'deploy' && window.game.netEvents, null, { timeout: 600000 }); console.log('host loaded');
const FJ = await fr('joiner'); await FJ.waitForFunction(() => window.game?.netClient && window.game.phase === 'deploy' && window.game.lastSnap, null, { timeout: 600000 }); console.log('joiner loaded');
// ---- orders: both sides push for the objectives; support teams / mortars / artillery / medevac used
const orders = side => `(() => { const g = window.game, O = g.objectives; let i = 0;
  for (const u of g.playerUnits) { if (u.destroyed || u.kind === 'medevac' || u.kind === 'fpv' || u.kind === 'atgm' || (u.type === 'squad' && u.mounted)) continue; const o = O[i++ % O.length]; const c = u.center ? u.center() : u.pos;
    const x = o.x + (Math.random() - 0.5) * 30, z = o.z + (Math.random() - 0.5) * 30; if (u.orderAttack && u.type === 'squad') u.orderMove(x, z, null, 18, true); else u.orderMove(x, z, null, true); }
  return g.playerUnits.length; })()`;
await FJ.evaluate(() => window.game.startBattle()); await FH.evaluate(() => window.game.startBattle());
await FH.waitForFunction(() => window.game.phase !== 'deploy', null, { timeout: 30000 });
console.log('battle started; orders host', await FH.evaluate(orders('host')), 'joiner', await FJ.evaluate(orders('joiner')));
const support = async F => F.evaluate(() => { const g = window.game, e = g.unitsOf('enemy').filter(u => u.spotted || u.type === 'vehicle'); const t = e[Math.floor(Math.random() * e.length)] || g.objectives[0]; const p = t.center ? t.center() : t.pos || t;
  return { mortar: g.playerMortar ? g.playerMortar(p.x + 10, p.z + 10) : null, arty: g.playerArtillery ? g.playerArtillery(p.x - 10, p.z) : null }; });
// ---- the comparison: host state vs the joiner's puppets (sides flipped on the joiner)
const hostState = () => FH.evaluate(() => { const g = window.game, r = v => Math.round(v * 10) / 10;
  return { t: g.time, sq: g.squads.map(q => [q.id, q.side, q.name, q.soldiers.map(s => [s.state, r(s.pos.x), r(s.pos.z), s.weaponKey || 0, s.state === 'evac' ? (s.onBed ? 1 : 0) : 0])]), v: g.vehicles.map(v => [v.id, v.side, r(v.pos.x), r(v.pos.z), Math.round(v.hp), v.destroyed ? 1 : 0, v.burning > 0 ? 1 : 0, v.abandoned ? 1 : 0, r(v.turretYaw || 0)]),
    tk: g.tickets ? [Math.round(g.tickets.player), Math.round(g.tickets.enemy)] : null, o: g.objectives.map(o => o.owner), mo: [g.mortars, g.mortarsEnemy], arty: g.fires ? [g.fires.count.player, g.fires.count.enemy] : null,
    stats: JSON.stringify(g.stats), md: (g.medevac?.trucks || []).map(t => [t.id, t.side, t.mstate, t.load.length, t.saved]), dr: g.squads.filter(q => q.support?.drone).map(q => q.id),
    panels: g.city.buildings.map(b => b.panels.map(p => p.gone ? 'x' : p.state).join('')).join('|'), craters: g.city.craterMesh?.count ?? null, over: g.over }; });
const joinState = () => FJ.evaluate(() => { const g = window.game, r = v => Math.round(v * 10) / 10, fl = s => (s === 'player' ? 'enemy' : 'player'), sq = {}, v = {};
  for (const [id, u] of g.netMap) { if (u.type === 'squad') sq[id] = [fl(u.side), u.name, u.soldiers.map(s => [s.state, r(s.pos.x), r(s.pos.z), s.weaponKey || 0, s.state === 'evac' ? (s.onBed ? 1 : 0) : 0])]; else v[id] = [fl(u.side), r(u.pos.x), r(u.pos.z), Math.round(u.hp), u.destroyed ? 1 : 0, u.burning > 0 ? 1 : 0, u.abandoned ? 1 : 0, r(u.turretYaw || 0)]; }
  return { t: g.time, sq, v, tk: g.tickets ? [Math.round(g.tickets.enemy), Math.round(g.tickets.player)] : null, o: g.objectives.map(o => o.owner === 'neutral' ? 'neutral' : fl(o.owner)), mo: g.mortars, arty: g.fires ? g.fires.count.player : null, stats: JSON.stringify({ player: g.stats.enemy, enemy: g.stats.player }),
    md: (g.medevac?.trucks || []).map(t => [t.netId, fl(t.side), t.mstate, t.load.length, t.saved]), dr: [...(g._netDrones?.keys() || [])], panels: g.city.buildings.map(b => b.panels.map(p => p.gone ? 'x' : p.state).join('')).join('|'), craters: g.city.craterMesh?.count ?? null, over: g.over, local: g.squads.length + g.vehicles.length, mapped: g.netMap.size }; });
const report = { checks: 0, hard: 0 };
const compare = async label => {
  const h = await hostState(); await page.waitForTimeout(150); const j = await joinState();
  const out = [], hard = m => { out.push('HARD ' + m); report.hard++; }, soft = m => out.push(m);
  let pos = [], miss = 0, stateBad = 0, wk = 0, bed = 0;
  for (const [id, side, name, men] of h.sq) {
    const J = j.sq[id]; if (!J) { miss++; if (men.some(m => m[0] !== 'dead')) hard(`squad ${id} ${name} (${side}) not on the joiner`); continue; }
    if (J[0] !== side) hard(`squad ${id} side ${J[0]} vs ${side}`); if (J[1].replace(/^Enemy /, '').toLowerCase() !== name.replace(/^Enemy /, '').toLowerCase()) soft(`squad ${id} name '${J[1]}' vs '${name}'`);
    men.forEach((m, i) => { const q = J[2][i]; if (!q) { hard(`squad ${id} soldier ${i} missing`); return; } if ((m[0] === 'dead') !== (q[0] === 'dead')) stateBad++; else if (m[0] !== q[0]) stateBad += 0.001; if (m[0] !== 'dead' && m[0] !== 'evac') pos.push(Math.hypot(m[1] - q[1], m[2] - q[2])); if (m[3] !== q[3]) wk++; if (m[4] !== q[4]) bed++; });
  }
  const vd = []; for (const [id, side, x, z, hp, d, b, ab, ty] of h.v) { const J = j.v[id]; if (!J) { hard(`vehicle ${id} not on the joiner`); continue; } vd.push(Math.hypot(x - J[1], z - J[2])); if (d !== J[4]) hard(`vehicle ${id} destroyed ${d} vs ${J[4]}`); if (Math.abs(hp - J[3]) > 2) soft(`vehicle ${id} hp ${hp} vs ${J[3]}`); if (b !== J[5]) soft(`vehicle ${id} burning ${b} vs ${J[5]}`); if (ab !== J[6]) soft(`vehicle ${id} abandoned ${ab} vs ${J[6]}`); }
  const s = a => a.length ? `max ${Math.max(...a).toFixed(1)} mean ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2)}` : '-';
  if (Math.floor(stateBad) > 0) hard(`${Math.floor(stateBad)} soldiers dead on one side only`);
  if (stateBad % 1 > 0.0005) soft(`${Math.round((stateBad % 1) * 1000)} soldiers in another wound state`);
  if (wk) soft(`${wk} soldiers with another weapon in hand`); if (bed) soft(`${bed} casualties on / off the medevac bed`);
  if (JSON.stringify(h.tk) !== JSON.stringify(j.tk)) soft(`tickets host ${h.tk} joiner ${j.tk}`);
  if (h.o.join() !== j.o.join()) soft(`objectives host ${h.o} joiner ${j.o}`);
  if (h.mo[1] !== j.mo) soft(`joiner mortars ${j.mo} vs host's count ${h.mo[1]}`);
  if (h.arty && h.arty[1] !== j.arty) soft(`joiner artillery missions ${j.arty} vs host's count ${h.arty[1]}`);
  if (h.stats !== j.stats) soft('stats differ');
  if (JSON.stringify(h.md.map(x => x.slice(1))) !== JSON.stringify(j.md.map(x => x.slice(1)))) soft(`medevac host ${JSON.stringify(h.md)} joiner ${JSON.stringify(j.md)}`);
  if (h.dr.join() !== j.dr.join()) soft(`drones in the air host [${h.dr}] joiner [${j.dr}]`);
  if (h.panels !== j.panels) { let n = 0; const A = h.panels.split(''), B = j.panels.split(''); for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) n++; hard(`building panels differ (${n})`); }
  if (h.craters !== j.craters) soft(`craters host ${h.craters} joiner ${j.craters}`);
  console.log(`[${label}] t host ${h.t.toFixed(1)} joiner ${j.t.toFixed(1)} · squads ${h.sq.length} (missing ${miss}) · men pos ${s(pos)} · veh pos ${s(vd)} · joiner objects ${j.local}/${j.mapped}`);
  for (const m of out) console.log('   ' + m); report.checks++;
};
await compare('start');
const T = +SECS; let next = 10;
for (let t = 0; t < T; t += 5) {
  await page.waitForTimeout(5000);
  if (t === 20 || t === 70 || t === 160) { console.log('support host', JSON.stringify(await support(FH)), 'joiner', JSON.stringify(await support(FJ)));
    await page.waitForTimeout(2500); console.log('   missions left: host sees the joiner with', JSON.stringify(await FH.evaluate(() => ({ mortars: window.game.mortarsEnemy, calls: window.game.mortarsEnemyN, arty: window.game.fires?.count.enemy }))), '· joiner shows', JSON.stringify(await FJ.evaluate(() => ({ mortars: window.game.mortars, arty: window.game.fires?.count.player })))); }
  if (t === 45) { console.log('orders again: host', await FH.evaluate(orders('host')), 'joiner', await FJ.evaluate(orders('joiner'))); }
  if (t === 100) await FJ.evaluate(() => window.game.medevac?.evacuate());
  if (t + 5 >= next) { await compare(`${t + 5}s`); next += 15; }
  if (await FH.evaluate(() => window.game.over)) { console.log('battle over'); await page.waitForTimeout(1500); await compare('end'); break; }
}
const net = { hostSent: await PH.evaluate(() => window.__peer.sent), hostKB: await PH.evaluate(() => Math.round(window.__peer.bytes / 1024)), joinSent: await PJ.evaluate(() => window.__peer.sent) };
console.log('link', JSON.stringify(net), '· page errors', errs.length);
console.log(report.hard ? `HARD DESYNCS: ${report.hard}` : 'no hard desyncs');
await PH.br.close(); await PJ.br.close(); server.close(); process.exit(report.hard || errs.length ? 1 : 0);
