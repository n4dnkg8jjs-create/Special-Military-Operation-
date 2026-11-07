// Render-side cost of a map at fixed cameras (city / real-place maps): draw calls + triangles of the main and the shadow
// pass, programs, JS time of renderer.render (the three.js CPU side: culling, sorting, uniforms, state; gl.finish() is
// called between frames and NOT counted), per-category visible triangles, and a canvas PNG per view for pixel diffs.
// The battle is paused right after load (SIM s of simulation first), so before / after runs see the same world.
// Usage: MAP=city Q=medium TAG=before OUTDIR=previews/perf_v2 node tools/perf_city.mjs
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(E_ROOT());
function E_ROOT() { return process.env.ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); }
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
const E = process.env, MAP = E.MAP || 'city', Q = E.Q || 'medium', SIM = +(E.SIM || 2), TAG = E.TAG || 'run', REPS = +(E.REPS || 3);
const VW = +(E.VW || 1280), VH = +(E.VH || 720);
const out = E.OUTDIR || path.join(root, 'previews/perf_v2'); fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: [...(E.JSFLAGS ? ['--js-flags=' + E.JSFLAGS] : []), '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
await ctx.addInitScript(seed => { localStorage.setItem('smo_noaudio', '1'); let a = seed; Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }, +(E.SEED ?? 12345));
const page = await ctx.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.stack || e.message));
page.on('crash', () => console.log('[crash]', new Date().toISOString()));
page.on('console', m => { if (m.type() === 'info') console.log('[info]', m.text().slice(0, 200)); if (m.type() === 'error' && !/404|Failed to load/.test(m.text())) console.log('[page]', m.text().slice(0, 300)); });
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/index.html?autostart&map=${MAP}&quality=${Q}&sim=${SIM}&cam=0,0,80${E.EXTRA || ''}`);
await page.waitForFunction('window.__done === true', null, { timeout: 900000 });
console.log('loaded in', Math.round((Date.now() - t0) / 1000), 's');
const views = JSON.parse(E.VIEWS || 'null');
const res = await page.evaluate(async ({ REPS, views, PAN, CATGPU }) => {
  const g = window.game, R = g.renderer, r = R.r, gl = r.getContext();
  g.paused = true; g.noRender = true;
  for (const el of document.querySelectorAll('body > *:not(canvas)')) if (el.style) el.style.visibility = 'hidden';
  const ob = g.objectives.map(o => [o.x ?? o.pos?.x ?? o.p?.x ?? 0, o.z ?? o.pos?.z ?? o.p?.z ?? 0]);
  const V = views || [
    { name: 'street', f: ob[0], dist: 55, yaw: 0.7, pitch: 0.42 },
    { name: 'mid', f: ob[1] || ob[0], dist: 140, yaw: 2.2, pitch: 0.55 },
    { name: 'wide', f: ob[Math.min(2, ob.length - 1)], dist: 260, yaw: 4.0, pitch: 0.62 },
  ];
  let sh = { calls: 0, tris: 0 }; const sm = r.shadowMap, smr = sm.render;
  let smMs = 0;
  sm.render = function (...a) { const c0 = r.info.render.calls, t0 = r.info.render.triangles, p0 = performance.now(); smr.apply(this, a); smMs += performance.now() - p0; sh.calls += r.info.render.calls - c0; sh.tris += r.info.render.triangles - t0; };
  r.info.autoReset = false;
  // drawn triangles / calls per category (main pass only): renderBufferDirect wrapped, info deltas
  let inShadow = false, drawn = null; const rbd = r.renderBufferDirect;
  const catOf = (o, m) => o.isSkinnedMesh ? 'soldier' : o.isBatchedMesh ? 'kit' : (o.name || o.parent?.name || ('m:' + (m?.name || m?.type) + ':' + (o.geometry?.type || '') + (o.isInstancedMesh ? ':inst' : ''))).replace(/_(intact|damaged|holed|destroyed)(_v\d)?$/, '').replace(/^kit\|.*/, 'kit').replace(/_\d+$/, (m) => /leafy|rubble/.test(o.name) ? m : '');
  r.renderBufferDirect = function (camera, scene, geometry, material, object, group) { if (!drawn || inShadow) return rbd.apply(this, arguments); if (CATGPU) sync(); const t0 = r.info.render.triangles, p0 = performance.now(); rbd.apply(this, arguments); if (CATGPU) sync(); const k = catOf(object, material) + (material.alphaTest > 0 ? '*' : ''); const e = drawn[k] ||= [0, 0, 0]; e[0]++; e[1] += r.info.render.triangles - t0; e[2] += performance.now() - p0; };
  { const smr0 = r.shadowMap.render; r.shadowMap.render = function (...a) { inShadow = true; try { return smr0.apply(this, a); } finally { inShadow = false; } }; }
  const outV = [];
  // (Chrome's WebGL finish() does not wait for the GPU process: a 1-pixel readPixels does)
  const px = new Uint8Array(4), sync = () => { const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING), rfb = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rfb); };
  for (const v of V) {
    console.info('view ' + v.name + ' ' + (performance.memory?.usedJSHeapSize / 1e6 | 0) + 'MB / limit ' + (performance.memory?.jsHeapSizeLimit / 1e6 | 0) + 'MB');
    const c = g.cam; c.lookAt(v.f[0], v.f[1]); c.tDist = v.dist; c.tYaw = v.yaw; c.tPitch = v.pitch;
    c.focus.copy(c.tFocus); c.dist = c.tDist; c.yaw = c.tYaw; c.pitch = c.tPitch;
    for (let i = 0; i < 30; i++) { c.update(0.05); g.frame(0.0001); if (i % 10 === 0) console.info('f' + i + ' ' + (performance.memory?.usedJSHeapSize / 1e6 | 0) + 'MB'); }
    console.info('warm');
    // warm-up render (program compiles, uploads)
    R.render(0.016, g.time); gl.finish(); R.render(0.016, g.time); gl.finish();
    let ms = [], wall = [], smms = [], calls = 0, tris = 0; sh = { calls: 0, tris: 0 };
    for (let i = 0; i < REPS; i++) {
      r.info.reset(); smMs = 0; const sh0 = { ...sh }; if (i === 0) drawn = {};
      sync(); const a = performance.now(); R.render(0.016, g.time); const b = performance.now(); sync(); wall.push(performance.now() - a);
      ms.push(b - a); smms.push(smMs); if (i === 0) { v.drawn = drawn; drawn = null; } calls += r.info.render.calls; tris += r.info.render.triangles;
    }
    const png = r.domElement.toDataURL('image/png');
    // visible triangles by category (main-pass candidates: visible meshes, before frustum culling)
    const br = {}; g.scene.traverse(o => { if (!o.isMesh || !o.visible) return; for (let p = o; p; p = p.parent) if (!p.visible) return; const geo = o.geometry; const t = (geo.index ? geo.index.count : geo.attributes.position?.count || 0) / 3 * (o.isInstancedMesh ? o.count : 1); let k = o.isSkinnedMesh ? 'soldier' : o.isInstancedMesh ? 'inst:' + (o.name || '?').replace(/_(intact|damaged|holed|destroyed)(_v\d)?$/, '') : 'mesh'; if (!o.isSkinnedMesh && !o.isInstancedMesh) { let q = o; while (q.parent && q.parent !== g.scene) q = q.parent; k = 'mesh:' + (q.name || q.type); } (br[k] ||= [0, 0, 0]); br[k][0]++; br[k][1] += Math.round(t); if (o.castShadow) br[k][2]++; });
    const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
    outV.push({ name: v.name, cam: [+R.camera.position.x.toFixed(1), +R.camera.position.y.toFixed(1), +R.camera.position.z.toFixed(1)], renderJsMs: +med(ms).toFixed(1), wallMs: +med(wall).toFixed(1), shadowJsMs: +med(smms).toFixed(1), calls: Math.round(calls / REPS), tris: Math.round(tris / REPS), shadowCalls: Math.round(sh.calls / REPS), shadowTris: Math.round(sh.tris / REPS), png, drawn: Object.entries(v.drawn).sort((a, b) => CATGPU ? b[1][2] - a[1][2] : b[1][1] - a[1][1]).slice(0, 30).map(([k, [n, t, ms]]) => `${k} c${n} ${(t / 1000).toFixed(0)}k${CATGPU ? ' ' + ms.toFixed(0) + 'ms' : ''}`), top: Object.entries(br).sort((a, b) => b[1][1] - a[1][1]).slice(0, 18).map(([k, [n, t, cs]]) => `${k} n${n} cs${cs} ${(t / 1000).toFixed(0)}k`) });
  }
  // panning camera: the focus slides 3 m per frame along the last view's right vector (the static shadow cache must
  // re-render when the shadow camera moves), plus per-pass time with gl.finish() after each composer pass (SwiftShader
  // raster cost: rough fill-rate indicator for GTAO / bloom / SMAA / grade)
  const pan = { wall: [], ms: [], calls: 0, tris: 0, shCalls: 0, shTris: 0, n: 0, cacheRenders: 0 };
  console.info('pan'); if (PAN) {
    const c = g.cam, cr0 = R.shadowCache?.renders ?? 0; if (R.shadowCache) R.shadowCache.changed = []; const dx = Math.cos(c.yaw), dz = -Math.sin(c.yaw);
    for (let i = 0; i < PAN; i++) {
      c.tFocus.x += dx * 3; c.tFocus.z += dz * 3; c.focus.copy(c.tFocus); c.update(0.016); g.frame(0.0001);
      sync(); r.info.reset(); const s0 = { ...sh }; const a = performance.now(); R.render(0.016, g.time); const b = performance.now(); sync(); const w = performance.now();
      if (i >= 2) { pan.ms.push(b - a); pan.wall.push(w - a); pan.calls += r.info.render.calls; pan.tris += r.info.render.triangles; pan.shCalls += sh.calls - s0.calls; pan.shTris += sh.tris - s0.tris; pan.n++; }
    }
    pan.cacheRenders = (R.shadowCache?.renders ?? 0) - cr0;
  }
  const passes = {};
  { const ps = R.composer.passes, orig = ps.map(p => p.render);
    ps.forEach((p, i) => { p.render = function (...a) { sync(); const t0 = performance.now(); orig[i].apply(this, a); sync(); const k = i + ':' + p.constructor.name; passes[k] = (passes[k] || 0) + performance.now() - t0; }; });
    for (let i = 0; i < 2; i++) R.render(0.016, g.time);
    ps.forEach((p, i) => { p.render = orig[i]; }); for (const k in passes) passes[k] = +(passes[k] / 2).toFixed(1);
    { const smr2 = sm.render; let t = 0; sm.render = function (...a) { sync(); const t0 = performance.now(); smr2.apply(this, a); sync(); t += performance.now() - t0; }; R.render(0.016, g.time); sm.render = smr2; passes.shadowInRenderPass = +t.toFixed(1); }
    { sync(); const t0 = performance.now(); R.render(0.016, g.time); sync(); passes.frameSynced = +(performance.now() - t0).toFixed(1); }
  }
  const mem = { heapMB: performance.memory?.usedJSHeapSize / 1e6 | 0 }; { const seen = new Set(); let geo = 0; g.scene.traverse(o => { const gg = o.geometry; if (!gg) return; for (const a of [...Object.values(gg.attributes || {}), gg.index]) { const arr = a?.array || a?.data?.array; if (arr && !seen.has(arr.buffer || arr)) { seen.add(arr.buffer || arr); geo += arr.byteLength; } } if (o.instanceMatrix && !seen.has(o.instanceMatrix.array)) { seen.add(o.instanceMatrix.array); geo += o.instanceMatrix.array.byteLength; } }); mem.geoArraysMB = geo / 1e6 | 0;
    const big = []; const scan = (obj, path, depth) => { if (!obj || depth > 2) return; for (const k of Object.keys(obj)) { const v = obj[k]; if (ArrayBuffer.isView(v) && v.byteLength > 4e6) big.push([path + '.' + k, v.byteLength / 1e6 | 0]); else if (v && typeof v === 'object' && !v.isObject3D && !Array.isArray(v) && depth < 2) scan(v, path + '.' + k, depth + 1); } }; scan(g.city, 'city', 0); scan(g, 'game', 1); mem.bigArrays = big.sort((a, b) => b[1] - a[1]).slice(0, 20); }
  let meshes = 0, inst = 0, mats = new Set(); g.scene.traverse(o => { if (o.isMesh) { meshes++; if (o.isInstancedMesh) inst++; (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m)); } });
  const pmed = pan.ms.slice().sort((x, y) => x - y)[pan.ms.length >> 1]; return { pan: PAN ? { renderJsMs: +pmed.toFixed(1), wallMs: +pan.wall.slice().sort((x, y) => x - y)[pan.wall.length >> 1].toFixed(1), calls: Math.round(pan.calls / pan.n), tris: Math.round(pan.tris / pan.n), shadowCalls: Math.round(pan.shCalls / pan.n), shadowTris: Math.round(pan.shTris / pan.n), cacheRenders: pan.cacheRenders, scrolls: R.shadowCache?.scrolls, changed: [...new Set(R.shadowCache?.changed || [])].slice(0, 40), frames: pan.n } : null, passesFinishMs: passes, mem, programs: r.info.programs?.length, geometries: r.info.memory.geometries, textures: r.info.memory.textures, meshes, instancedMeshes: inst, materials: mats.size, views: outV };
}, { REPS, views, PAN: +(E.PAN ?? 12), CATGPU: !!E.CATGPU });
for (const v of res.views) { fs.writeFileSync(path.join(out, `${TAG}_${MAP}_${Q}_${v.name}.png`), Buffer.from(v.png.split(',')[1], 'base64')); delete v.png; }
console.log(JSON.stringify(res, null, 1));
fs.writeFileSync(path.join(out, `${TAG}_${MAP}_${Q}.json`), JSON.stringify({ map: MAP, q: Q, sim: SIM, ...res }, null, 1));
await browser.close(); server.close();
