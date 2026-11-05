// Versus frame-time test: host + joiner (two browsers, room code through a local PeerJS broker), straight into a battle
// between the two players, both pages RENDERING; then per-frame timings measured inside both battle iframes for
// SECS seconds: rAF interval, JS time in game.frame split into simulation / snapshot apply (update) and render, plus the
// time the PARENT page (sector map behind the iframe) spends in its own rAF callbacks. Headless SwiftShader: absolute
// fps is meaningless, the split is what counts.
// Needs the PeerJS broker: (cd /tmp/pj && node srv.cjs &)       Usage: SECS=40 Q=low node tools/mp_perf.mjs [tag]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
const E = process.env, TAG = process.argv[2] || 'run', SECS = +(E.SECS || 40), Q = E.Q || 'low';
const out = E.OUTDIR || path.join(root, 'previews/perf'); fs.mkdirSync(out, { recursive: true });
const broker = `&peerhost=127.0.0.1&peerport=9000&peersecure=0${E.RELAY ? '&mqtt=ws://127.0.0.1:8888' : ''}${E.VSMAP ? '&vsmap=' + E.VSMAP : ''}`;
const base = `http://127.0.0.1:${port}/index.html`;
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
const vp = { width: +(E.VW || 960), height: +(E.VH || 540) };
const mk = async (name, B) => { const ctx = await B.newContext({ viewport: vp }); await ctx.addInitScript(q => { localStorage.setItem('smo_quality', q); localStorage.setItem('smo_noaudio', '1'); localStorage.setItem('smo_norender', '0'); localStorage.setItem('smo.campaign.v2.tutorial', 'done'); }, Q); const p = await ctx.newPage(); p.setDefaultNavigationTimeout(180000);
  p.on('pageerror', e => console.log(`[${name} pageerror]`, e.message)); p.on('console', m => { if (m.type() === 'error') console.log(`[${name} ${m.type()}]`, m.text().slice(0, 200)); }); return p; };
const BH = await chromium.launch({ args }), BG = E.RELAY ? await chromium.launch({ args: [...args, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] }) : await chromium.launch({ args });
const H = await mk('host', BH), G = await mk('guest', BG);
await H.goto(`${base}?versus=1${broker}`); await H.waitForSelector('.vs-host'); await H.check('input[name=vs-side][value=UA]', { force: true }); await H.click('.vs-host');
await H.waitForFunction(() => window.__roomCode, null, { timeout: 30000 }); const code = await H.evaluate(() => window.__roomCode);
await G.goto(`${base}?versus=1${broker}`); await G.waitForSelector('.vs-codein'); await G.fill('.vs-codein', code); await G.click('.vs-joinbtn');
await Promise.all([H.waitForSelector('#c2 .c2-end', { timeout: 300000 }), G.waitForSelector('#c2 .c2-end', { timeout: 300000 })]).catch(async e => { console.log('lobby:', await H.$eval('.vs-msg', x => x.textContent).catch(() => '?'), '|', await G.$eval('.vs-msg', x => x.textContent).catch(() => '?')); throw e; });
console.log('connected', await G.evaluate(() => window.__vsPeer?.mode || 'direct'));
const closeModals = async P => { for (let i = 0; i < 6; i++) { const b = await P.$('#c2 .c2-modal button.pri'); if (!b) { const t = await P.$('.c2-tut .c2-tut-skip'); if (t) { await t.click(); continue; } return; } await b.click().catch(() => {}); await P.waitForTimeout(150); } };
await H.waitForTimeout(1500); await closeModals(H); await closeModals(G);
const plan = await H.evaluate(() => {
  const V = window.__vsGame, A = V.side[V.host], D = V.side[V.guest];
  for (const g of D.forces) for (const n of A.neighbors(g.cell)) {
    if (A.owner[n] !== 'player' || A.forcesAt(n).length) continue;
    const t = A.forces.find(x => A.tfPower(x) > 2) || A.forces[0]; t.cell = n; A.resetMoves(); A.computeSupply();
    const p = A.plan(t.id, g.cell); if (!p.ok || !p.attack) continue;
    window.__vsUi.planAttack(t, g.cell, false); return { tf: t.id, cell: g.cell, planned: !!t.planned };
  }
  return null;
});
console.log('plan', JSON.stringify(plan));
await closeModals(H); await closeModals(G); await G.click('#c2 .c2-end'); await H.waitForTimeout(1500); await closeModals(H); await H.click('#c2 .c2-end');
console.log('host end', await H.$eval('#c2 .c2-end', e => e.textContent).catch(() => '?'), 'guest end', await G.$eval('#c2 .c2-end', e => e.textContent).catch(() => '?'));
await H.waitForSelector('.vs-frame', { timeout: 300000, state: 'attached' }); await G.waitForSelector('.vs-frame', { timeout: 300000, state: 'attached' });
const FA = await (await H.$('.vs-frame')).contentFrame(), FB = await (await G.$('.vs-frame')).contentFrame();
const t0 = Date.now();
await FA.waitForFunction(() => window.game?.phase === 'deploy' && window.game.hud, null, { timeout: 900000, polling: 2000 });
await FB.waitForFunction(() => window.game?.netClient && window.game?.phase === 'deploy' && window.game.hud, null, { timeout: 900000, polling: 2000 });
console.log('both battles loaded in', Math.round((Date.now() - t0) / 1000), 's', await FA.evaluate(() => window.game.opts.map));
await FB.evaluate(() => window.game.startBattle()); await FA.evaluate(() => window.game.startBattle());
await FA.waitForFunction(() => window.game.phase !== 'deploy', null, { timeout: 120000, polling: 1000 }).catch(() => {});
// both sides move toward the middle so there is a fight to watch
const advance = () => { const g = window.game; for (const u of g.playerUnits) { if (u.destroyed) continue; const c = u.center ? u.center() : u.pos; const L = Math.hypot(c.x, c.z) || 1; try { u.orderMove(c.x - c.x / L * 120, c.z - c.z / L * 120, null, u.type === 'squad' ? 18 : true); } catch { } } };
await FB.evaluate(advance); await FA.evaluate(advance);
// instrument: game.frame split, rAF interval in the iframe, the parent page's own rAF work
const inst = () => {
  const g = window.game, S = window.__perfS = { n: 0, frame: 0, update: 0, render: 0, gaps: [], parent: 0, parentN: 0, t0: performance.now() };
  const wrap = (o, k, key) => { const f = o[k]; o[k] = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { S[key] += performance.now() - t; } }; };
  wrap(g, 'update', 'update'); wrap(g.renderer, 'render', 'render');
  const fr = g.frame; let last = 0; g.frame = function (dt) { const t = performance.now(); if (last) S.gaps.push(t - last); last = t; S.n++; try { return fr.call(this, dt); } finally { S.frame += performance.now() - t; } };
  // the parent page: time spent in its requestAnimationFrame callbacks (sector map renderer, UI loops)
  const P = window.parent, praf = P.requestAnimationFrame;
  P.__perfWrapped || (P.__perfWrapped = true, P.requestAnimationFrame = function (cb) { return praf.call(P, t => { const a = performance.now(); try { cb(t); } finally { S.parent += performance.now() - a; S.parentN++; } }); });
  // (if the page holds its rAF loops while the battle is open the wrapper is never called: parent = 0)
};
await FA.evaluate(inst); await FB.evaluate(inst);
await H.waitForTimeout(SECS * 1000);
const rep = () => { const S = window.__perfS, T = (performance.now() - S.t0) / 1000, g = window.game, r = g.renderer.r.info; const gs = S.gaps.slice().sort((a, b) => a - b);
  return { secs: +T.toFixed(1), frames: S.n, fps: +(S.n / T).toFixed(2), medianGapMs: Math.round(gs[gs.length >> 1] || 0), frameMs: +(S.frame / S.n).toFixed(1), updateMs: +(S.update / S.n).toFixed(1), renderMs: +(S.render / S.n).toFixed(1), parentMsPerSec: +(S.parent / T).toFixed(1), parentCalls: S.parentN, calls: r.render.calls, tris: r.render.triangles, scene: g.scene.children.length, particles: g.fx.smoke.p.length, glow: g.fx.glow.p.length, time: +g.time.toFixed(1), snap: !!g.lastSnap }; };
const host = await FA.evaluate(rep), joiner = await FB.evaluate(rep);
console.log('HOST  ', JSON.stringify(host)); console.log('JOINER', JSON.stringify(joiner));
fs.writeFileSync(path.join(out, `mp_${TAG}.json`), JSON.stringify({ q: Q, vp, secs: SECS, relay: !!E.RELAY, host, joiner }, null, 1));
await H.screenshot({ path: path.join(out, `mp_${TAG}_host.png`), timeout: 300000 }).catch(e => console.log('shot', e.message.split('\n')[0]));
await G.screenshot({ path: path.join(out, `mp_${TAG}_joiner.png`), timeout: 300000 }).catch(e => console.log('shot', e.message.split('\n')[0]));
await BH.close(); await BG.close(); server.close();
