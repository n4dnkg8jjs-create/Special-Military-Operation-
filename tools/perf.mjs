// Frame-time breakdown (CPU ms per subsystem, draw calls / triangles) for a single-player battle or the versus joiner
// path (replayed from previews/versus/stream.json). Headless SwiftShader: GPU time is not meaningful, so the main
// metrics are the JS-side costs of each subsystem and renderer.info; FINISH=1 adds gl.finish() after each composer pass
// (SwiftShader raster cost per pass: only a rough fill-rate indicator).
// Usage: MAP=city Q=medium SIM=30 FRAMES=60 node tools/perf.mjs [label]        MODE=replay for the joiner path
//        TAG=before → previews/perf/<tag>_<map>_<q>.{json,png}
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
const E = process.env, MODE = E.MODE || 'sp', MAP = E.MAP || 'city', Q = E.Q || 'medium', SIM = +(E.SIM || 30), FRAMES = +(E.FRAMES || 150), TAG = E.TAG || 'run';
const VW = +(E.VW || 1280), VH = +(E.VH || 720);
const out = E.OUTDIR || path.join(root, 'previews/perf'); fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
await ctx.addInitScript(seed => { localStorage.setItem('smo_noaudio', '1'); if (seed) { let a = seed; Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; } }, +(E.SEED ?? 12345));   // reproducible battles for before / after
const page = await ctx.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.stack || e.message));
page.on('console', m => { if (m.type() === 'error' && !/404|Failed to load/.test(m.text())) console.log('[page]', m.text().slice(0, 300)); });
const url = MODE === 'replay' ? `/index.html?vsreplay&quality=${Q}&sim=${SIM}${E.EXTRA || ''}${E.RENDER ? '&perfrender=1' : ''}`
  : `/index.html?autostart&map=${MAP}&quality=${Q}&sim=${SIM}&cam=${E.CAM || 'fight'}&dist=${E.DIST || 60}${E.EXTRA || ''}${E.RENDER ? '&perfrender=1' : ''}`;
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}${url}`);
await page.waitForFunction('window.__done === true', null, { timeout: 900000 });
console.log('loaded + simulated in', Math.round((Date.now() - t0) / 1000), 's');
let cdp = null; if (E.PROFILE) { cdp = await ctx.newCDPSession(page); await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
const res = await page.evaluate(async ({ FRAMES, FINISH, replay, SIM }) => {
  const g = window.game, T = {}, N = {};
  const wrap = (o, k, label) => { const f = o?.[k]; if (typeof f !== 'function' || f.__w) return; const w = function (...a) { const t0 = performance.now(); try { return f.apply(this, a); } finally { T[label] = (T[label] || 0) + performance.now() - t0; N[label] = (N[label] || 0) + 1; } }; w.__w = true; o[k] = w; };
  const sq = g.squads[0], so = sq?.soldiers[0], veh = g.vehicles[0];
  wrap(g, 'update', 'update(all sim)');
  wrap(Object.getPrototypeOf(sq), 'update', ' squad.update');
  wrap(Object.getPrototypeOf(so), 'animate', '  soldier.animate');
  if (so?.mixer) wrap(Object.getPrototypeOf(so.mixer), 'update', '   mixer.update');
  if (veh) wrap(Object.getPrototypeOf(veh), 'update', ' vehicle.update');
  if (veh) wrap(Object.getPrototypeOf(veh), 'sync', '  vehicle.sync');
  wrap(g.combat, 'update', ' combat.update'); wrap(g.combat, 'los', '  combat.los');
  wrap(g, 'updateSpotting', ' spotting'); wrap(g, 'servicePaths', ' paths');
  if (g.commander) wrap(g.commander, 'update', ' commander(AI)');
  if (g.medevac) wrap(g.medevac, 'update', ' medevac');
  wrap(g, 'cullSoldiers', 'cullSoldiers'); wrap(g.fx, 'update', 'fx.update'); wrap(g.hud, 'update', 'hud.update');
  wrap(g.cam, 'update', 'cam.update'); wrap(g.city, 'updateFalling', 'city.updateFalling'); wrap(g.city.pool, 'finish', 'pool.finish');
  wrap(g, 'supportEmitters', 'supportEmitters');
  wrap(g.renderer, 'render', 'render(total)');
  const r = g.renderer.r, gl = r.getContext();
  wrap(r.shadowMap, 'render', '  shadowMap');
  for (const p of g.renderer.composer.passes) { const f = p.render; const lbl = ' pass:' + p.constructor.name; p.render = function (...a) { const t0 = performance.now(); f.apply(this, a); if (FINISH) gl.finish(); T[lbl] = (T[lbl] || 0) + performance.now() - t0; N[lbl] = (N[lbl] || 0) + 1; }; }
  r.info.autoReset = false;
  const RENDER = +(new URLSearchParams(location.search).get('perfrender') || 0); g.noRender = !RENDER;   // CPU frames without the (SwiftShader-bound) render; calls / tris come from main.js' sim report
  let t = SIM, calls = 0, tris = 0; const ft = [];
  const dt = 1 / 30;
  for (let i = 0; i < FRAMES + 5; i++) {
    if (i === 5) { for (const k in T) T[k] = 0; for (const k in N) N[k] = 0; calls = tris = 0; ft.length = 0; }
    r.info.reset();
    if (replay) { t += dt; window.__replayStep?.(t); }
    const a = performance.now(); g.frame(dt); const b = performance.now(); gl.finish(); const c = performance.now();
    ft.push([b - a, c - a]); calls += r.info.render.calls; tris += r.info.render.triangles;
    await new Promise(r => setTimeout(r, 0));
  }
  const F = FRAMES, out = {};
  for (const k of Object.keys(T).sort((x, y) => T[y] - T[x])) out[k] = { ms: +(T[k] / F).toFixed(2), n: +(N[k] / F).toFixed(1) };
  const cpu = ft.map(x => x[0]).sort((a, b) => a - b), all = ft.map(x => x[1]).sort((a, b) => a - b);
  const vis = { soldiers: 0, soldiersVisible: 0, mixersVisible: 0 }; for (const q of g.squads) for (const s of q.soldiers) { vis.soldiers++; if (s.root.visible) vis.soldiersVisible++; }
  return { info: window.__info && { renderMs: __info.renderMs, calls: __info.calls, tris: __info.tris, programs: __info.programs }, br: window.__br, frameCpuMs: +(cpu.reduce((a, b) => a + b, 0) / F).toFixed(2), frameCpuP90: +cpu[Math.floor(F * 0.9)].toFixed(2), frameWithFinishMs: +(all.reduce((a, b) => a + b, 0) / F).toFixed(2), calls: Math.round(calls / F), tris: Math.round(tris / F), programs: r.info.programs?.length, geometries: r.info.memory.geometries, textures: r.info.memory.textures, ...vis, units: g.squads.length + '/' + g.vehicles.length, particles: g.fx.smoke?.p?.length, breakdown: out };
}, { FRAMES, FINISH: !!E.FINISH, replay: MODE === 'replay', SIM });
const name = `${TAG}_${MODE === 'replay' ? 'replay' : MAP}_${Q}`;
if (cdp) {   // self time per function (top 40) over the measured frames
  const { profile } = await cdp.send('Profiler.stop'); const self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
  const dt = profile.timeDeltas; const cnt = new Map(); profile.samples.forEach((id, i) => cnt.set(id, (cnt.get(id) || 0) + (dt[i] || 0)));
  for (const [id, us] of cnt) { const n = byId.get(id), cf = n.callFrame, k = `${cf.functionName || '(anon)'} ${cf.url.split('/').slice(-2).join('/')}:${cf.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + us); }
  res.profile = [...self].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, us]) => [k, +(us / 1000 / (FRAMES + 5)).toFixed(3)]);
}
console.log(JSON.stringify(res, null, 1));
fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify({ mode: MODE, map: MAP, q: Q, sim: SIM, frames: FRAMES, vw: VW, vh: VH, ...res }, null, 1));
if (!E.NOSHOT) await page.screenshot({ path: path.join(out, name + '.png'), timeout: 300000 }).catch(e => console.log('shot failed', e.message));
await browser.close(); server.close();
