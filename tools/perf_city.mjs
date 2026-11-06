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
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: VW, height: VH } });
await ctx.addInitScript(seed => { localStorage.setItem('smo_noaudio', '1'); let a = seed; Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }, +(E.SEED ?? 12345));
const page = await ctx.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.stack || e.message));
page.on('console', m => { if (m.type() === 'error' && !/404|Failed to load/.test(m.text())) console.log('[page]', m.text().slice(0, 300)); });
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/index.html?autostart&map=${MAP}&quality=${Q}&sim=${SIM}&cam=0,0,80${E.EXTRA || ''}`);
await page.waitForFunction('window.__done === true', null, { timeout: 900000 });
console.log('loaded in', Math.round((Date.now() - t0) / 1000), 's');
const views = JSON.parse(E.VIEWS || 'null');
const res = await page.evaluate(async ({ REPS, views }) => {
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
  const outV = [];
  for (const v of V) {
    const c = g.cam; c.lookAt(v.f[0], v.f[1]); c.tDist = v.dist; c.tYaw = v.yaw; c.tPitch = v.pitch;
    c.focus.copy(c.tFocus); c.dist = c.tDist; c.yaw = c.tYaw; c.pitch = c.tPitch;
    for (let i = 0; i < 30; i++) { c.update(0.05); g.frame(0.0001); }
    // warm-up render (program compiles, uploads)
    R.render(0.016, g.time); gl.finish(); R.render(0.016, g.time); gl.finish();
    let ms = [], smms = [], calls = 0, tris = 0; sh = { calls: 0, tris: 0 };
    for (let i = 0; i < REPS; i++) {
      r.info.reset(); smMs = 0; const sh0 = { ...sh };
      const a = performance.now(); R.render(0.016, g.time); const b = performance.now(); gl.finish();
      ms.push(b - a); smms.push(smMs); calls += r.info.render.calls; tris += r.info.render.triangles;
    }
    const png = r.domElement.toDataURL('image/png');
    // visible triangles by category (main-pass candidates: visible meshes, before frustum culling)
    const br = {}; g.scene.traverse(o => { if (!o.isMesh || !o.visible) return; for (let p = o; p; p = p.parent) if (!p.visible) return; const geo = o.geometry; const t = (geo.index ? geo.index.count : geo.attributes.position?.count || 0) / 3 * (o.isInstancedMesh ? o.count : 1); let k = o.isSkinnedMesh ? 'soldier' : o.isInstancedMesh ? 'inst:' + (o.name || '?').replace(/_(intact|damaged|holed|destroyed)(_v\d)?$/, '') : 'mesh'; if (!o.isSkinnedMesh && !o.isInstancedMesh) { let q = o; while (q.parent && q.parent !== g.scene) q = q.parent; k = 'mesh:' + (q.name || q.type); } (br[k] ||= [0, 0, 0]); br[k][0]++; br[k][1] += Math.round(t); if (o.castShadow) br[k][2]++; });
    const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
    outV.push({ name: v.name, cam: [+R.camera.position.x.toFixed(1), +R.camera.position.y.toFixed(1), +R.camera.position.z.toFixed(1)], renderJsMs: +med(ms).toFixed(1), shadowJsMs: +med(smms).toFixed(1), calls: Math.round(calls / REPS), tris: Math.round(tris / REPS), shadowCalls: Math.round(sh.calls / REPS), shadowTris: Math.round(sh.tris / REPS), png, top: Object.entries(br).sort((a, b) => b[1][1] - a[1][1]).slice(0, 18).map(([k, [n, t, cs]]) => `${k} n${n} cs${cs} ${(t / 1000).toFixed(0)}k`) });
  }
  let meshes = 0, inst = 0, mats = new Set(); g.scene.traverse(o => { if (o.isMesh) { meshes++; if (o.isInstancedMesh) inst++; (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m)); } });
  return { programs: r.info.programs?.length, geometries: r.info.memory.geometries, textures: r.info.memory.textures, meshes, instancedMeshes: inst, materials: mats.size, views: outV };
}, { REPS, views });
for (const v of res.views) { fs.writeFileSync(path.join(out, `${TAG}_${MAP}_${Q}_${v.name}.png`), Buffer.from(v.png.split(',')[1], 'base64')); delete v.png; }
console.log(JSON.stringify(res, null, 1));
fs.writeFileSync(path.join(out, `${TAG}_${MAP}_${Q}.json`), JSON.stringify({ map: MAP, q: Q, sim: SIM, ...res }, null, 1));
await browser.close(); server.close();
