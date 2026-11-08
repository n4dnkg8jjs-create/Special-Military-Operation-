// Versus fog-of-war check. A real versus setup from the campaign rules (as tools/mp_sync.mjs), but one battle page at a
// time (two worlds side by side did not fit in this 8 GB box): first the HOST alone, its peer recorded in node - it
// scatters its force over its staging ground and the joiner's 'place' commands scatter the joiner's force over the other
// one; then the battle runs N s. Then a JOINER page alone is fed the recorded stream (manifest, events, snapshots) in
// order. Checks:
//   deployment  host page: none of the joiner's units drawn / "?" / labelled / on the minimap (tier 0);
//               stream: every snapshot row for a host unit is a bare [id, 0] row (no men, no position, no props, no
//               drone in its hands), the manifest has no positions for the host's vehicles, no host UI sounds;
//               joiner page: none of the host's units drawn / "?" / labelled; its copies nowhere near the real spots
//   battle      both pages: no unidentified enemy drawn; the stream: no men / full rows for a unit the joiner has not
//               identified; tier counts (hidden / contact / identified) of what each side knows of the other
// Usage: flock /tmp/heavy.lock nice -n 10 node tools/mp_fog.mjs [seconds=60] [map=city]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [SECS = '60', MAPID = 'city'] = process.argv.slice(2);
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
const PAGE = `<!doctype html><html><body style="margin:0;background:#000"><script>
const DROP = 0;
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

const launch = () => chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=4096'] });
const errs = [], rec = []; let bad = 0; const flag = m => { bad++; console.log('   LEAK: ' + m); };
let sink = null;
const mkPage = async name => { const br = await launch(), ctx = await br.newContext({ viewport: { width: 660, height: 420 } });
  await ctx.addInitScript(() => { localStorage.setItem('smo_quality', 'low'); localStorage.setItem('smo_noaudio', '1'); localStorage.setItem('smo_norender', '1'); });
  const p = await ctx.newPage(); p.br = br;
  p.on('pageerror', e => { errs.push(e.message); console.log(`[${name} pageerror]`, e.message); });
  p.on('console', m => { if (m.type() === 'error') { const t = m.text().slice(0, 240); if (!/404|GPU stall|GroupMarker/.test(t)) { errs.push(t); console.log(`[${name} error]`, t); } } });
  await p.exposeFunction('__mpSend', (t, s) => sink?.(t, s));
  await p.goto(`http://127.0.0.1:${server.address().port}/__mp.html`); return p; };
const frameOf = async (P, id) => { for (let i = 0; i < 900; i++) { const h = await P.$('#' + id); const f = h && await h.contentFrame(); if (f) return f; await P.waitForTimeout(200); } throw new Error('no frame ' + id); };
// what a page holds of the other side (the side that is not 'player' on that page)
const VIEW = () => { const g = window.game, foes = [...g.squads, ...g.vehicles].filter(u => u.side !== 'player' && !(u.type === 'squad' && (u.mounted || u.medevac)));
  const live = foes.filter(u => !u.destroyed), t = [0, 0, 0]; for (const u of live) t[u.tier || 0]++;
  const drawn = live.filter(u => u.type === 'vehicle' ? u.root.visible : u.soldiers.some(s => s.visible && s.state !== 'dead')).length;
  const leak = live.filter(u => u.tier !== 2 && (u.type === 'vehicle' ? u.root.visible : u.soldiers.some(s => s.visible && s.state !== 'dead'))).length;
  const banners = g.hud ? [...g.hud.banners.entries()].filter(([u, b]) => u.side !== 'player' && b.el.style.display !== 'none').length : 0;
  const pos = {}; for (const u of foes) { const c = u.type === 'vehicle' ? u.pos : (u.soldiers.find(s => s.pos.lengthSq() > 0) || u.soldiers[0]).pos; pos[u.netId ?? u.id] = [Math.round(c.x), Math.round(c.z)]; }
  return { phase: g.phase, t: Math.round(g.time), units: live.length, tiers: t, drawn, leak, q: g.hud?.contacts?.n ?? 0, banners, pos }; };
const near = (seen, real) => { let n = 0, tot = 0; for (const [id, p] of Object.entries(real)) { const q = seen[id]; if (!q) continue; tot++; if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 15) n++; } return `${n}/${tot}`; };
const SCATTER = () => { const g = window.game, [x0, z0] = g.inZone(-1e5, -1e5, 'player', 3), [x1, z1] = g.inZone(1e5, 1e5, 'player', 3); let n = 0;
  for (const u of g.playerUnits) { if (u.destroyed || (u.type === 'squad' && u.mounted) || u.kind === 'medevac') continue; g.deployPlace(u, x0 + Math.random() * (x1 - x0), z0 + Math.random() * (z1 - z0), Math.random() * 6.28); n++; } return n; };

// ================= 1. the host alone, its stream recorded
const PH = await mkPage('host'); const T0 = Date.now();
sink = (t, s) => rec.push({ t, ms: Date.now() - T0, d: JSON.parse(s) });
await PH.evaluate(o => window.__start('host', o), hostOpts);
const FH = await frameOf(PH, 'host'); await FH.waitForFunction(() => window.game?.phase === 'deploy' && window.game.netEvents, null, { timeout: 900000 }); console.log('host loaded');
const deliver = (t, d) => PH.evaluate(([t, d]) => window.__peer.deliver(t, d), [t, d]);
const man = rec.find(m => m.t === 'manifest')?.d; if (!man) throw new Error('no manifest');
const hostIds = new Set([...man.squads, ...man.vehicles].filter(u => u.side === 'player').map(u => u.id));
console.log(`manifest: host ${man.squads.filter(s => s.side === 'player').length} squads + ${man.vehicles.filter(v => v.side === 'player').length} vehicles (positions sent: ${man.vehicles.filter(v => v.side === 'player' && v.x != null).length}) · joiner ${man.squads.filter(s => s.side === 'enemy').length} + ${man.vehicles.filter(v => v.side === 'enemy').length}`);
if (man.vehicles.some(v => v.side === 'player' && v.x != null)) flag('host vehicle positions in the manifest');
// the host scatters its force; the joiner's force is scattered by 'place' commands (as its page would send them)
console.log('host placed', await FH.evaluate(SCATTER));
const Z = await FH.evaluate(() => { const g = window.game; return [...g.inZone(-1e5, -1e5, 'enemy', 3), ...g.inZone(1e5, 1e5, 'enemy', 3)]; });
const jplace = [...man.squads.filter(s => s.side === 'enemy' && !s.mounted && !s.medevac), ...man.vehicles.filter(v => v.side === 'enemy' && v.kind !== 'medevac')];
for (const u of jplace) await deliver('cmd', { id: u.id, m: 'place', a: [Z[0] + Math.random() * (Z[2] - Z[0]), Z[1] + Math.random() * (Z[3] - Z[1]), Math.random() * 6.28] });
console.log('joiner placed (commands)', jplace.length);
await FH.waitForTimeout(2500);
const hostTruth = await FH.evaluate(() => { const g = window.game, o = {}; for (const u of [...g.squads, ...g.vehicles]) if (u.side === 'player') { const c = u.type === 'vehicle' ? u.pos : u.center(); o[u.id] = [Math.round(c.x), Math.round(c.z)]; } return o; });
const joinTruth = await FH.evaluate(() => { const g = window.game, o = {}; for (const u of [...g.squads, ...g.vehicles]) if (u.side === 'enemy') { const c = u.type === 'vehicle' ? u.pos : u.center(); o[u.id] = [Math.round(c.x), Math.round(c.z)]; } return o; });
{ const { pos, ...v } = await FH.evaluate(VIEW); console.log('[deploy] host sees the joiner:', JSON.stringify(v));
  if (v.drawn || v.tiers[1] || v.tiers[2] || v.q || v.banners) flag("joiner's placement visible on the host's page"); }
const nDeploy = rec.length;
// ready on both ends, the battle
await deliver('ready', 1); await FH.evaluate(() => window.game.startBattle());
await FH.waitForFunction(() => window.game.phase !== 'deploy', null, { timeout: 30000 });
const ORDERS = () => { const g = window.game, O = g.objectives; let i = 0;
  for (const u of g.playerUnits) { if (u.destroyed || u.kind === 'medevac' || u.kind === 'fpv' || u.kind === 'atgm' || (u.type === 'squad' && u.mounted)) continue; const o = O[i++ % O.length];
    const x = o.x + (Math.random() - 0.5) * 30, z = o.z + (Math.random() - 0.5) * 30; if (u.type === 'squad') u.orderMove(x, z, null, 18, true); else u.orderMove(x, z, null, true); } return g.playerUnits.length; };
await FH.evaluate(ORDERS);
for (const u of [...man.squads.filter(s => s.side === 'enemy' && !s.medevac && s.kind !== 'fpv' && s.kind !== 'atgm'), ...man.vehicles.filter(v => v.side === 'enemy' && v.kind !== 'medevac')]) { const o = (await FH.evaluate(() => window.game.objectives.map(o => [o.x, o.z])))[u.id % 2]; await deliver('cmd', { id: u.id, m: 'orderMove', a: [o[0] + (Math.random() - 0.5) * 30, o[1] + (Math.random() - 0.5) * 30] }); }
const hostT = [];
for (let t = 10; t <= +SECS; t += 10) { await FH.waitForTimeout(10000); const { pos, ...v } = await FH.evaluate(VIEW); hostT.push(v); console.log(`[${t}s] host sees the joiner:`, JSON.stringify(v)); if (v.leak) flag('unidentified joiner unit drawn on the host'); }
await PH.br.close();
// ---- the stream itself
const snaps = rec.filter(m => m.t === 'snap'), dsn = snaps.filter(m => m.d.ph === 'deploy'), bsn = snaps.filter(m => m.d.ph !== 'deploy');
let rowsDeploy = 0, badDeploy = 0, rowsBattle = [0, 0, 0], badBattle = 0;
for (const { d } of dsn) {
  for (const r of d.sq) if (hostIds.has(r[0])) { rowsDeploy++; if (r[3] !== 0 || r[4] || r[5] || r[6]) badDeploy++; }
  for (const r of d.v) if (hostIds.has(r[0])) { rowsDeploy++; if (r.length > 2 || r[1] !== 0) badDeploy++; }
  if (d.sp.some(r => hostIds.has(r[0]))) badDeploy++;
  if (d.dr.some(r => hostIds.has(r[7]))) badDeploy++;
}
for (const { d } of bsn) {
  for (const r of d.sq) if (hostIds.has(r[0])) { rowsBattle[r[3]]++; if (r[3] < 2 && r[4]) badBattle++; }
  for (const r of d.v) if (hostIds.has(r[0])) { const k = r.length <= 5 ? r[1] : 2; rowsBattle[k]++; }
  for (const r of d.sp) if (hostIds.has(r[0]) && !d.sq.some(q => q[0] === r[0] && q[3] === 2)) badBattle++;
}
const uiSfx = rec.filter(m => m.t === 'ev').flatMap(m => m.d).filter(e => e[0] === 'sfx' && !e[2] && /^(ui_|radio)/.test(e[1])).length;
console.log(`[stream] ${dsn.length} deployment snapshots: ${rowsDeploy} rows for host units, ${badDeploy} carrying anything · ${bsn.length} battle snapshots: host-unit rows by tier [hidden, contact, identified] ${JSON.stringify(rowsBattle)}, ${badBattle} with men / props for an unidentified unit · host UI sounds sent: ${uiSfx} · ${(JSON.stringify(rec).length / 1024 / 1024).toFixed(1)} MB`);
if (badDeploy || badBattle || uiSfx) flag('the stream carries what the joiner does not know');

// ================= 2. the joiner alone, fed the recorded stream
const PJ = await mkPage('joiner'); sink = null;
await PJ.evaluate(o => window.__start('joiner', o), joinOpts);
await PJ.evaluate(m => window.__peer.deliver('manifest', m), man);
const FJ = await frameOf(PJ, 'joiner'); await FJ.waitForFunction(() => window.game?.netClient && window.game.phase === 'deploy', null, { timeout: 900000 }); console.log('joiner loaded');
const feed = async (from, to) => { for (let i = from; i < to; i += 40) await PJ.evaluate(list => { for (const m of list) window.__peer.deliver(m.t, m.d); }, rec.slice(i, Math.min(to, i + 40)).filter(m => m.t !== 'manifest').map(m => ({ t: m.t, d: m.d }))); };
await feed(0, nDeploy); await FJ.waitForTimeout(1500);
{ const { pos, ...v } = await FJ.evaluate(VIEW); console.log('[deploy] joiner sees the host:', JSON.stringify(v), `· host units its copies have within 15 m of where the host put them: ${near(pos, hostTruth)}`);
  if (v.drawn || v.tiers[1] || v.tiers[2] || v.q || v.banners || +near(pos, hostTruth).split('/')[0]) flag("host's placement visible on the joiner's page"); }
{ const own = await FJ.evaluate(() => { const g = window.game, o = {}; for (const u of [...g.squads, ...g.vehicles]) if (u.side === 'player') { const c = u.type === 'vehicle' ? u.pos : u.center(); o[u.netId] = [Math.round(c.x), Math.round(c.z)]; } return o; });
  console.log(`[deploy] joiner's own units where the host has them: ${near(own, joinTruth)} (the host relays the joiner's own placement back)`); }
// the battle part, in the recorded pacing (10x faster than real time is fine for a puppet), checked as it goes
const bStart = rec.findIndex((m, i) => i >= nDeploy && m.t === 'snap' && m.d.ph !== 'deploy'), msT = rec[rec.length - 1].ms;
let i = nDeploy, next = rec[bStart]?.ms ?? msT;
const joinT = [];
while (i < rec.length) { const lim = next + 10000; let j = i; while (j < rec.length && rec[j].ms < lim) j++; await feed(i, j); i = j; next = lim; await FJ.waitForTimeout(800);
  const { pos, ...v } = await FJ.evaluate(VIEW); joinT.push(v); console.log(`[t=${v.t}s] joiner sees the host:`, JSON.stringify(v)); if (v.leak) flag('unidentified host unit drawn on the joiner'); }
await PJ.br.close(); server.close();
const sum = a => a.reduce((s, v) => [s[0] + v.tiers[0], s[1] + v.tiers[1], s[2] + v.tiers[2]], [0, 0, 0]);
console.log(`tiers summed over the battle samples [hidden, contact, identified]: host's view of the joiner ${JSON.stringify(sum(hostT))} · joiner's view of the host ${JSON.stringify(sum(joinT))}`);
console.log('page errors', errs.length, bad ? `· ${bad} LEAKS` : '· no leaks');
process.exit(bad || errs.length ? 1 : 0);
