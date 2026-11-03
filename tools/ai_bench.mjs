// Battle-AI benchmark: logic-only battle (no rendering / audio), the player side driven by the scripted AutoDefender
// (ai.js, ?autoplay), the enemy by the Commander (new) or the legacy one (?aiold). Math.random is seeded per run so
// old/new can be compared over the same seeds. Metrics are sampled from game state only (independent of the AI code).
// Usage: node tools/ai_bench.mjs <map> <mode: skirmish|attack|defend> <seed> <old|new> [simSeconds] [out.json]
// Run under: flock /tmp/heavy.lock nice -n 10 node tools/ai_bench.mjs ...
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.ktx2': 'application/octet-stream', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.css': 'text/css', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const [map = 'city', mode = 'skirmish', seed = '1', ai = 'new', simS = '720', out = '', extra = ''] = process.argv.slice(2);
const q = mode === 'skirmish' ? `autostart&quality=low&map=${map}` : `ctest=${mode}&quality=low&map=${map}`;
const url = `http://localhost:${port}/index.html?${q}&autoplay${ai === 'old' ? '&aiold' : '&ainew'}${extra ? '&' + extra : ''}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=2048'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.addInitScript(() => { localStorage.setItem('smo_norender', '1'); localStorage.setItem('smo_noaudio', '1'); });
const errs = [];
page.on('pageerror', e => { errs.push(e.message); console.log('[pageerror]', e.stack || e.message); });
page.on('console', m => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) { errs.push(m.text()); console.log('[page]', m.text()); } else if (process.env.VERBOSE) console.log('[page]', m.text()); });
const t0 = Date.now();
await page.goto(url);
try { await page.waitForFunction('window.game && window.game.objectives && window.__done === true', null, { timeout: 150000 }); }
catch (e) { console.log(JSON.stringify({ map, mode, seed: +seed, ai, failed: 'load', errors: errs.slice(0, 3) })); await browser.close(); server.close(); process.exit(2); }
await page.evaluate(([seed]) => {
  const g = window.game, s0 = +seed;
  let a = s0 * 2654435761 >>> 0; Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const frame = g.frame.bind(g); g.frame = () => {}; window.__step = frame;
  g.startBattle();
  // ---- metric hooks (wrap game functions; AI-independent)
  const M = window.__M = { smoke: [], strikes: [], caps: [], samples: 0, moveN: 0, moveCover: 0, moveOpen: 0, approach: [], ticketsT: [], lostAt: {}, retake: [], firstContact: null, enemyLossAtCap: [], vehRetreat: 0 };
  const ts = g.combat.throwSmoke.bind(g.combat); g.combat.throwSmoke = (s, to) => { if (s.squad?.side === 'enemy') M.smoke.push([g.time, to.x, to.z]); return ts(s, to); };
  const cs = g.callStrike.bind(g); g.callStrike = (x, z, r, sp, side, d, c) => { if (side === 'enemy') M.strikes.push([g.time, x, z, c]); return cs(x, z, r, sp, side, d, c); };
  const fr = g.objectives.map(o => [o.x, o.z]);
  // enemy 'front' direction per objective: from the objective towards the enemy staging / spawn side
  const sp = g.map.spawns?.attacker || [[0, -400]];
  const ec = sp.reduce((a, p) => [a[0] + p[0] / sp.length, a[1] + p[1] / sp.length], [0, 0]);
  M.prevOwner = g.objectives.map(o => o.owner); M.contact = new Map();
  window.__sample = () => {
    const T = g.tickets; M.samples++;
    if (M.samples % 5 === 0) M.ticketsT.push([Math.round(g.time), Math.round(T.player), Math.round(T.enemy)]);
    g.objectives.forEach((o, i) => {
      const prev = M.prevOwner[i];
      if (o.owner !== prev) {
        M.caps.push([Math.round(g.time), o.id, prev, o.owner, g.stats.enemy.kia, g.stats.enemy.vehLost]);
        if (o.owner === 'player' && prev === 'enemy') M.lostAt[o.id] = g.time;           // enemy lost it
        if (o.owner === 'enemy' && M.lostAt[o.id] != null) { M.retake.push([o.id, Math.round(g.time - M.lostAt[o.id])]); M.lostAt[o.id] = null; }
        if (o.owner === 'enemy') {   // fire support in the 90 s before the capture, within 150 m
          const near = (a) => g.time - a[0] < 90 && Math.hypot(a[1] - o.x, a[2] - o.z) < 150;
          M.enemyLossAtCap.push({ obj: o.id, t: Math.round(g.time), kia: g.stats.enemy.kia, veh: g.stats.enemy.vehLost, smoke: M.smoke.some(near), strike: M.strikes.some(near) });
        }
        M.prevOwner[i] = o.owner;
      }
    });
    const pl = g.unitsOf('player').filter(u => !(u.type === 'squad' && u.mounted));
    const pc = pl.map(u => u.type === 'vehicle' ? u.pos : u.center());
    for (const sq of g.squads) {
      if (sq.side !== 'enemy' || sq.mounted || sq.destroyed || sq.routing) continue;
      const c = sq.center(); let bi = -1, bd = 160;
      pc.forEach((p, i) => { const d = Math.hypot(p.x - c.x, p.z - c.z); if (d < bd) { bd = d; bi = i; } });
      if (bi < 0) continue;
      const P = pc[bi];
      for (const s of sq.effective) {
        const mv = s.vel && s.vel.lengthSq() > 1 && !s.inside;
        if (!mv) continue;
        M.moveN++;
        const cov = g.nav.coverFrom(s.pos.x, s.pos.z, P.x, P.z), cc = g.city.concealAt ? g.city.concealAt(s.pos.x, s.pos.z) : 1;
        const smoked = g.nav.occluded ? g.nav.occluded(s.pos.x, 1.4, s.pos.z, P.x, 1.4, P.z) : false;
        if (cov >= 0.5 || cc < 0.6 || smoked) M.moveCover++; else M.moveOpen++;
        if (sq.seenBy?.player != null && g.time - sq.seenBy.player < 2) M.moveSpotted = (M.moveSpotted || 0) + 1;
      }
      // flank approach: first time an enemy squad closes to < 70 m of a player unit holding still (garrison / trench / halted)
      const pu = pl[bi];
      if (bd < 70 && pu.type === 'squad' && !M.contact.has(sq.id + ':' + pu.id)) {
        M.contact.set(sq.id + ':' + pu.id, 1);
        const fx = ec[0] - P.x, fz = ec[1] - P.z, fl = Math.hypot(fx, fz) || 1, ax = c.x - P.x, az = c.z - P.z, al = Math.hypot(ax, az) || 1;
        const ang = Math.acos(Math.max(-1, Math.min(1, (fx * ax + fz * az) / fl / al))) * 180 / Math.PI;
        M.approach.push(Math.round(ang));
      }
    }
  };
}, [seed]);
const total = +simS; let t = 0;
while (t < total) {
  const r = await page.evaluate(([chunk]) => {
    const g = window.game; let k = 0;
    for (let i = 0; i < chunk / 0.05; i++) { window.__step(0.05); if (++k % 20 === 0) window.__sample(); if (g.over) break; }
    return { t: g.time, over: g.over };
  }, [30]);
  t = r.t; if (r.over) break;
  if (process.env.VERBOSE) console.log('t', Math.round(t));
}
const res = await page.evaluate(() => {
  const g = window.game, M = window.__M;
  const fc = M.approach.length ? M.approach.filter(a => a > 50).length / M.approach.length : null;
  return {
    time: Math.round(g.time), over: g.over, result: g.result?.title, why: g.result?.why,
    tickets: { player: Math.round(g.tickets.player), enemy: Math.round(g.tickets.enemy) },
    objectives: g.objectives.map(o => `${o.id}:${o.owner}`).join(' '),
    stats: g.stats, smoke: M.smoke.length, strikes: M.strikes.length,
    caps: M.caps, enemyCaps: M.enemyLossAtCap, retake: M.retake,
    coverMoveFrac: M.moveN ? +(M.moveCover / M.moveN).toFixed(3) : null, spottedMoveFrac: M.moveN ? +((M.moveSpotted || 0) / M.moveN).toFixed(3) : null, moveSamples: M.moveN,
    flankFrac: fc != null ? +fc.toFixed(2) : null, approaches: M.approach.length,
    ticketsT: M.ticketsT, aiStats: g.commander?.stats || null, plan: g.commander?.debugLines?.() || null,
  };
});
res.map = map; res.mode = mode; res.seed = +seed; res.ai = ai; res.wallS = Math.round((Date.now() - t0) / 1000); res.errors = errs.slice(0, 5);
const s = JSON.stringify(res);
if (out) fs.writeFileSync(out, JSON.stringify(res, null, 1));
console.log(s.length > 4000 ? s.slice(0, 4000) + '…' : s);
await browser.close(); server.close();
