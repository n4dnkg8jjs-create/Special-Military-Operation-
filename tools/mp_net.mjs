// Versus link-quality + joiner-audio check, one world at a time (two battle pages at once - one of them with its sound
// library decoded - were OOM-killed in this 8 GB box): 1) the HOST battle page alone (as versus_ui.js opens it), both
// forces ordered forward, its whole outgoing stream recorded with timestamps (bytes/s per message type, the largest
// message); 2) a JOINER battle page alone, audio ON (real autoplay policy: one click in its frame unlocks it), fed that
// stream in real time through a shim that behaves like a poor relayed link: latency + jitter, a bandwidth cap, the
// reliable channel in order (a backlog delays it), snapshots unreliable (lost at random, dropped while the backlog is
// over 256 KB, reordered by jitter), stalls ("packet bursts"), and one OUTAGE in which reliable messages are lost
// outright (a dropped link / a relay that lost them): the joiner must notice the missing world-state events and get them
// again ('wsync', answered here from the recorded host log). Measures: the joiner's replayed sound events and the voices
// its mixer actually started (by group), resyncs, building damage equal to the host's at the end, page errors.
// Usage: flock -w 3600 /tmp/heavy.lock nice -n 10 node tools/mp_net.mjs [seconds=180] [map=city]
//   env LAT=120 JIT=60 BW=60000 (bytes/s) LOSS=0.05 STALL=4 (s, every ~40 s)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [SECS = '180', MAPID = 'city'] = process.argv.slice(2);
const E = process.env, LAT = +(E.LAT ?? 120), JIT = +(E.JIT ?? 60), BW = +(E.BW ?? 60000), LOSS = +(E.LOSS ?? 0.05), STALL = +(E.STALL ?? 4);
const mem = {}; globalThis.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
const { loadCampaigns } = await import('../src/campaign/v2/index.js');
const { VersusGame } = await import('../src/campaign/v2/versus.js');
const { defs } = await loadCampaigns();
const V = new VersusGame(defs, 'UA', 'UA'), HC = V.side.UA, GC = V.side.RU;
const big = C => C.forces.slice().sort((a, b) => C.battleUnits(b.units).length - C.battleUnits(a.units).length).slice(0, 2);
const gts = big(GC), hts = big(HC), gt = gts[0], gU = gts.flatMap(t => t.units), hU = hts.flatMap(t => t.units);
const setup = HC.battleSetup(gt.cell, hU, 'attack'); setup.enemy = []; setup.map = MAPID;
const hostOpts = { side: 'UA', map: MAPID, campaign: setup, net: { role: 'host', enemyForce: JSON.parse(JSON.stringify(GC.battleUnits(gU))), enemyMods: GC.battleMods(gt.cell, gU) } };
const joinOpts = { side: 'RU', map: MAPID, campaign: { sectorName: setup.sectorName, mode: 'defend', force: [], enemy: [] }, net: { role: 'client' } };
// the page: the battle iframe + its end of the link (window.__peer, the interface versus_ui.js's per-battle proxy has)
const PAGE = `<!doctype html><html><body style="margin:0;background:#000"><script>
window.__peer = { handlers: {}, last: {}, open: true,
  on(t, f) { (this.handlers[t] ||= []).push(f); if (t === 'manifest' && this.last.manifest) f(this.last.manifest); return this; }, off() {},
  deliver(t, s) { const d = JSON.parse(s); if (t === 'manifest') this.last.manifest = d; for (const f of this.handlers[t] || []) try { f(d); } catch (e) { console.error('peer', t, e); } },
  send(t, d) { window.__mpSend(t, JSON.stringify(d), 0); },
  sendSnap(t, d) { window.__mpSend(t, JSON.stringify(d), 1); } };
window.__start = (id, o) => {
  window.__vs = { peer: window.__peer, opts: o, done: (a, b) => { window.__result = [a, b]; }, fail: m => { window.__fail = m; } };
  const A = document.createElement('iframe'); A.id = id; A.style.cssText = 'width:640px;height:400px;border:0'; A.allow = 'autoplay'; A.src = '/index.html?vsbattle=1'; document.body.appendChild(A);
};
</script></body></html>`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm', '.ktx2': 'application/octet-stream', '.bin': 'application/octet-stream', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.opus': 'audio/ogg' };
const server = http.createServer((req, res) => { const u = decodeURIComponent(req.url.split('?')[0]); if (u === '/__mp.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); } const p = path.join(root, u); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
// ---- phase 1: the host alone, its stream recorded
const rec = []; let recT0 = 0, recording = true;
const errs = [];
const launch = audio => chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=2048'].concat(audio ? [] : ['--autoplay-policy=no-user-gesture-required']) });
const pages = {}, onSend = {};
const mkPage = async (name, audio) => { const br = await launch(audio), ctx = await br.newContext({ viewport: { width: 660, height: 420 } });
  await ctx.addInitScript(a => { localStorage.setItem('smo_quality', 'low'); localStorage.setItem('smo_noaudio', a ? '0' : '1'); localStorage.setItem('smo_norender', '1'); localStorage.setItem('smo_menuaudio', '0'); }, audio);
  const p = await ctx.newPage(); p.br = br;
  p.on('pageerror', e => { errs.push(name + ': ' + e.message); console.log(`[${name} pageerror]`, e.message); });
  p.on('console', m => { const t = m.text().slice(0, 240); if (m.type() === 'error' || (m.type() === 'warning' && /replay|net|link|relay|wsync/i.test(t))) { if (!/404|GPU stall|GroupMarker|Failed to load resource/.test(t)) { errs.push(name + ': ' + t); console.log(`[${name} ${m.type()}]`, t); } } });
  await p.exposeFunction('__mpSend', (t, s, u) => onSend[name]?.(t, s, u));
  await p.goto(`http://127.0.0.1:${server.address().port}/__mp.html`); pages[name] = p; return p; };
const fr = async (P, id) => { for (let i = 0; i < 600; i++) { const h = await P.$('#' + id); const f = h && await h.contentFrame(); if (f) return f; await P.waitForTimeout(200); } throw new Error('no frame ' + id); };
const orders = side => `(() => { const g = window.game, O = g.objectives; let i = 0, n = 0;
  for (const u of [...g.squads, ...g.vehicles]) { if (u.side !== '${side}' || u.destroyed || u.kind === 'medevac' || u.noncombat || (u.type === 'squad' && u.mounted)) continue; const o = O[i++ % O.length];
    const x = o.x + (Math.random() - 0.5) * 30, z = o.z + (Math.random() - 0.5) * 30; try { if (u.type === 'squad') u.orderMove(x, z, null, 18, true); else u.orderMove(x, z, null, true); n++; } catch { } }
  return n; })()`;
const CACHE = '/tmp/mp_net_rec.json';
let hostEnd;
if (E.REUSE && fs.existsSync(CACHE)) { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); rec.push(...c.rec); hostEnd = c.hostEnd; console.log('host stream: reusing', CACHE); }
else {
const PH = await mkPage('host', false);
onSend.host = (t, s, u) => rec.push({ at: recording && recT0 ? Date.now() - recT0 : 0, t, s, u });
await PH.evaluate(o => window.__start('host', o), hostOpts);
const FH = await fr(PH, 'host'); await FH.waitForFunction(() => window.game?.phase === 'deploy' && window.game.netEvents, null, { timeout: 900000, polling: 1000 });
console.log('host loaded');
await FH.evaluate(() => { const g = window.game; g.guestReady = true; g.startBattle(); });
recT0 = Date.now();
console.log('battle; orders host', await FH.evaluate(orders('player')), 'joiner side', await FH.evaluate(orders('enemy')));
for (let s = 0; s < +SECS; s += 10) {
  await PH.waitForTimeout(10000);
  if (s === 30 || s === 80 || s === 130) { await FH.evaluate(orders('player')); await FH.evaluate(orders('enemy')); await FH.evaluate(() => { const g = window.game, e = g.unitsOf('player'), t = e[(Math.random() * e.length) | 0], p = t?.center ? t.center() : t?.pos; if (p) { g.mortarsEnemyN++; g.callStrike(p.x, p.z, 6, 16, 'enemy', 9, 'mortar'); } }); }
  if (await FH.evaluate(() => window.game.over)) break;
}
recording = false;
hostEnd = await FH.evaluate(() => { const g = window.game; return { t: g.time, log: g.netLog.length, stat: g.netStat, panels: g.city.buildings.map(b => b.panels.map(p => p.gone ? 'x' : p.state).join('')).join('|'), craters: g.city.craterMesh?.count ?? null }; });
await PH.br.close(); fs.writeFileSync(CACHE, JSON.stringify({ rec, hostEnd }));
}
const recDur = (rec[rec.length - 1].at - rec.find(m => m.at > 0).at) / 1000 || 1;
{ const by = {}; let max = { n: 0 }; for (const m of rec) { if (!m.at) continue; const b = by[m.t] ||= { n: 0, bytes: 0, max: 0 }; b.n++; b.bytes += m.s.length; b.max = Math.max(b.max, m.s.length); if (m.s.length > max.n) max = { n: m.s.length, t: m.t }; }
  const man = rec.find(m => m.t === 'manifest');
  console.log(`host stream over ${recDur.toFixed(0)} s:`, JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { n: v.n, KBps: +(v.bytes / 1024 / recDur).toFixed(1), avgKB: +(v.bytes / v.n / 1024).toFixed(1), maxKB: +(v.max / 1024).toFixed(1) }]))));
  console.log(`largest message ${max.t} ${(max.n / 1024).toFixed(1)} KB · manifest ${(man.s.length / 1024).toFixed(1)} KB · host events sent ${hostEnd.stat.ev}, shed ${hostEnd.stat.shed} · world-state events ${hostEnd.log}`); }

// ---- phase 2: the joiner alone, fed the stream through the shim
const stats = { snapLost: 0, snapDropped: 0, stalls: 0, outageLost: 0, wsync: 0, resent: 0 };
const Lk = { busyUntil: 0, lastRel: 0, backlog: 0 };
let stallUntil = 0, nextStall = 0, outage = null;
const deliver = (t, s) => pages.joiner?.evaluate(([t, s]) => window.__peer.deliver(t, s), [t, s]).catch(() => {});
const wire = (t, s, unrel) => {
  const now = Date.now(), n = s.length;
  if (STALL && now > nextStall) { stallUntil = now + STALL * 1000; nextStall = now + 30000 + Math.random() * 20000; stats.stalls++; }
  if (outage && now > outage[0] && now < outage[1]) { if (!unrel) stats.outageLost++; return; }   // the link is down: all lost
  if (unrel) { if (Math.random() < LOSS) { stats.snapLost++; return; } if (Lk.backlog > 256 * 1024) { stats.snapDropped++; return; } }
  const start = Math.max(now, Lk.busyUntil, stallUntil), done = start + n / BW * 1000; Lk.busyUntil = done; Lk.backlog += n;
  let at = done + LAT + Math.random() * JIT; if (!unrel) { at = Math.max(at, Lk.lastRel + 1); Lk.lastRel = at; }
  setTimeout(() => { Lk.backlog -= n; }, done - now);
  setTimeout(() => deliver(t, s), at - now);
};
// the host's side of 'wsync': its world-state log (the events recorded so far carry their numbers last)
const stateLog = []; const STATE = new Set(['bs', 'bg', 'rb', 'cr', 'ft', 'ck', 'tc']);
let fed = 0;
onSend.joiner = (t, s) => { if (t !== 'wsync') return; stats.wsync++; const have = JSON.parse(s).have | 0, miss = stateLog.slice(have); stats.resent += miss.length; for (let i = 0; i < miss.length; i += 400) wire('ev', JSON.stringify(miss.slice(i, i + 400)), false); };
const PJ = await mkPage('joiner', true);
console.log(`link: ${LAT} ms + ${JIT} ms jitter, ${Math.round(BW / 1024)} KB/s, snapshot loss ${LOSS * 100}%, ${STALL ? STALL + ' s stalls every 30-50 s' : 'no stalls'}, one 8 s outage`);
const pre = rec.filter(m => !m.at), live = rec.filter(m => m.at);
for (const m of pre) deliver(m.t, m.s);   // the deployment phase (manifest, snapshots) as it was before the battle
await PJ.evaluate(o => window.__start('joiner', o), joinOpts);
const FJ = await fr(PJ, 'joiner'); await FJ.waitForFunction(() => window.game?.netClient && window.game.hud, null, { timeout: 900000, polling: 1000 }); console.log('joiner loaded');
await FJ.evaluate(() => { const g = window.game, A = g.audio, S = window.__aud = { sfx: 0, sfxKeys: {}, voices: {}, nullPlays: 0, state0: A.ctx?.state };
  const vo = A.voice.bind(A); A.voice = (k, ...a) => { const v = vo(k, ...a); if (v) S.voices[v.group] = (S.voices[v.group] || 0) + 1; return v; };
  const sf = g.sfx.bind(g); g.sfx = (k, p, o) => { S.sfx++; S.sfxKeys[k] = (S.sfxKeys[k] || 0) + 1; const v = sf(k, p, o); if (!v && p) S.nullPlays++; return v; }; });
await FJ.click('body', { position: { x: 300, y: 200 } }).catch(e => console.log('click', e.message));
await FJ.waitForTimeout(400);
console.log('joiner audio', JSON.stringify(await FJ.evaluate(() => ({ ok: window.game.audio.ok, before: window.__aud.state0, after: window.game.audio.ctx?.state }))));
const T0 = Date.now(); nextStall = T0 + 25000; outage = [T0 + 50000, T0 + 58000];
const logState = m => { if (m.t === 'ev') for (const e of JSON.parse(m.s)) if (STATE.has(e[0])) stateLog.push(e); };
pre.forEach(logState);
for (const m of live) setTimeout(() => { logState(m); wire(m.t, m.s, m.u); }, m.at);
for (let s = 0; s < recDur + 15; s += 10) {
  await PJ.waitForTimeout(10000);
  const j = await FJ.evaluate(() => { const g = window.game, S = window.__aud; return { t: +g.time.toFixed(1), sfx: S.sfx, voices: S.voices, have: g.netSync.have, asked: g.netSync.asked, wait: g.netSync.wait.size }; });
  console.log(`[${Math.round((Date.now() - T0) / 1000)}s] joiner t ${j.t} · sfx events ${j.sfx} · voices ${JSON.stringify(j.voices)} · world-state ${j.have}${j.wait ? ` (+${j.wait} held)` : ''} asked ${j.asked}`);
}
await PJ.waitForTimeout(3000);
const J = await FJ.evaluate(() => { const g = window.game, S = window.__aud; return { t: g.time, have: g.netSync.have, panels: g.city.buildings.map(b => b.panels.map(p => p.gone ? 'x' : p.state).join('')).join('|'), craters: g.city.craterMesh?.count ?? null, sfx: S.sfx, voices: S.voices, nullPlays: S.nullPlays, top: Object.entries(S.sfxKeys).sort((a, b) => b[1] - a[1]).slice(0, 10) }; });
console.log('shim', JSON.stringify(stats));
console.log('joiner audio', JSON.stringify({ sfx: J.sfx, voices: J.voices, nullPlays: J.nullPlays, top: J.top }));
const oneShot = Object.entries(J.voices).filter(([k]) => k !== 'amb').reduce((a, [, v]) => a + v, 0);
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
ok(oneShot > 50, `joiner started ${oneShot} one-shot voices from ${J.sfx} sound events`);
ok(J.have === hostEnd.log, `world-state events applied ${J.have} / host ${hostEnd.log} (resync requests ${stats.wsync}, ${stats.outageLost} reliable messages lost in the outage)`);
ok(J.panels === hostEnd.panels, 'building panels identical to the host' + (J.panels === hostEnd.panels ? '' : ` (${[...J.panels].filter((c, i) => c !== hostEnd.panels[i]).length} differ)`));
ok(J.craters === hostEnd.craters, `craters ${J.craters} / host ${hostEnd.craters}`);
ok(!errs.length, `${errs.length} page errors`);
await PJ.br.close(); server.close(); process.exit(fails ? 1 : 0);
