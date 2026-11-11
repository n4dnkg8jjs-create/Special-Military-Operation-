import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; let _pw; try { _pw = createRequire(import.meta.url)('playwright'); } catch { _pw = createRequire('/opt/npm-tools/node_modules/')('playwright'); } const { chromium } = _pw;
const root = new URL('../..', import.meta.url).pathname;   // repo root const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const map = process.argv[2] || 'avdiivka', q = process.argv[3] || 'high';
const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
await p.addInitScript(() => { localStorage.setItem('smo_noaudio', '1'); });
p.on('pageerror', e => console.log('ERR', e.message));
await p.goto(`http://127.0.0.1:${server.address().port}/index.html?autostart&quality=${q}&map=${map}`);
await p.waitForFunction(() => window.game?.phase === 'deploy', null, { timeout: 500000 });
await p.evaluate(() => game.startBattle());
await p.waitForTimeout(8000);
const out = await p.evaluate(async () => { const THREE_F = (await import('/vendor/three/build/three.module.js').catch(() => null))?.Frustum || window.THREE?.Frustum;
  const R = game.renderer.r, res = [];
  const views = [[0, 0, 95, 0.78], [-200, 150, 140, 0.6]];
  for (const [x, z, d, pi] of views) {
    const c = game.cam; c.tFocus.set(x, 0, z); c.focus.set(x, 0, z); c.tDist = c.dist = d; c.tPitch = c.pitch = pi;
    await new Promise(r => setTimeout(r, 600));
    game.renderer.render(0.016, performance.now() / 1000); game.renderer.render(0.016, performance.now() / 1000); const sc0 = game.renderer.shadowCache?.renders || 0; R.info.autoReset = false; R.info.reset(); const t0 = performance.now(); game.renderer.render(0.016, performance.now() / 1000); const t1 = performance.now(); const scR = (game.renderer.shadowCache?.renders || 0) - sc0;
    res.push({ scR, view: [x, z, d], calls: R.info.render.calls, tris: R.info.render.triangles, ms: +(t1 - t0).toFixed(1) }); R.info.autoReset = true;
  }
  { const c = game.cam; c.tFocus.set(0, 0, 0); c.focus.set(0, 0, 0); c.tDist = c.dist = 95; c.tPitch = c.pitch = 0.78; await new Promise(r => setTimeout(r, 600)); }
  const cam = game.renderer.camera; cam.updateMatrixWorld(); const fr = new THREE_F(); 
  const by = {}, cnt = {}, auto = { t: 0, f: 0 };
  game.scene.updateMatrixWorld();
  const pm = new (cam.projectionMatrix.constructor)().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); fr.setFromProjectionMatrix(pm);
  game.scene.traverseVisible(o => { if (o.matrixAutoUpdate) auto.t++; else auto.f++; if (!o.isMesh) return; const k = (o.name || o.parent?.name || o.material?.name || '?').slice(0, 30); cnt[k] = (cnt[k] || 0) + 1;
    const g = o.geometry; const t = (g.index ? g.index.count : g.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
    if (!g.boundingSphere) g.computeBoundingSphere(); if (o.frustumCulled && !o.isInstancedMesh && !fr.intersectsObject(o)) return; by[k] = (by[k] || 0) + t; });
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => k + ':' + (v / 1000 | 0) + 'k');
  const topc = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => k + ':' + v);
  const acc = {}; game.scene.traverse(o => { if (!o.isMesh) return; const k = (o.name || o.parent?.name || o.material?.name || '?').slice(0, 24) + (o.isInstancedMesh ? '' : '*'); o.onAfterRender = (r, sc, cm, g) => { const t = (g.index ? g.index.count : g.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1); const kk = k + (cm.isOrthographicCamera ? '[sh]' : ''); acc[kk] = (acc[kk] || 0) + t; }; });
  { const c = game.cam; c.tFocus.set(0, 0, 0); c.focus.set(0, 0, 0); c.tDist = c.dist = 95; c.tPitch = c.pitch = 0.78; await new Promise(r => setTimeout(r, 900)); for (const k in acc) delete acc[k]; game.renderer.render(0.016, performance.now() / 1000); }
  const big = []; game.scene.traverse(o => { if (!o.isMesh) return; const g = o.geometry, t = (g.index ? g.index.count : g.attributes.position.count) / 3; const tot = t * (o.isInstancedMesh ? o.count : 1); if (tot > 60000 && o.visible && !o.name && !o.material?.name) { if (!g.boundingBox) g.computeBoundingBox(); const bb = g.boundingBox; big.push(['SIZE', t | 0, o.count, o.material?.type, o.material?.color?.getHexString(), !!o.material?.map, +(bb.max.x - bb.min.x).toFixed(1), +(bb.max.y - bb.min.y).toFixed(1), +(bb.max.z - bb.min.z).toFixed(1), Object.keys(g.attributes).join(','), o.frustumCulled, o.castShadow, o.parent?.type, o.parent?.children.length]); } if (tot > 150000) big.push([(o.name || '-') + '/' + (o.parent?.name || '-') + '/' + (o.material?.name || '-') + '/' + (g.name || '') + '/' + Object.keys(o.userData).join(','), t | 0, o.isInstancedMesh ? o.count : 1, o.visible]); });
  const drawn = Object.entries(acc).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => k + ':' + (v / 1000 | 0) + 'k');
  const cats = { rubble: /^rubble_\d/, trees: /^tree_|^bush/, kit: /^kit\|/, atlas: /city_atlas/, garage: /^garage/, wreck: /wreck/, noname: /^\?$/, terrain: /terrain/ }, delta = {};
  const R2 = game.renderer.r; const base = () => { R2.info.autoReset = false; R2.info.reset(); game.renderer.render(0.016, performance.now() / 1000); const t = R2.info.render.triangles; R2.info.autoReset = true; return t; };
  const t0b = base(); delta.base = (t0b / 1000 | 0) + 'k';
  for (const [c, re] of Object.entries(cats)) { const hid = []; game.scene.traverse(o => { if (o.isMesh && o.visible && re.test((o.name || o.parent?.name || o.material?.name || '?').slice(0, 30))) { o.visible = false; hid.push(o); } }); delta[c] = ((t0b - base()) / 1000 | 0) + 'k'; hid.forEach(o => o.visible = true); }
  let meshes = 0, inst = 0, instCount = 0; game.scene.traverse(o => { if (o.isMesh) { meshes++; if (o.isInstancedMesh) { inst++; instCount += o.count; } } });
  // CPU time per sim tick
  const T = []; for (let i = 0; i < 30; i++) { const t0 = performance.now(); game.update?.(1 / 30); T.push(performance.now() - t0); }
  T.sort((a, b) => a - b);
  return { big, drawn, delta, top: top.slice(0, 8), auto, res, meshes, inst, instCount, updMedian: T[15].toFixed(1), updP90: T[27].toFixed(1), mem: performance.memory ? (performance.memory.usedJSHeapSize / 1e6 | 0) : -1 };
});
console.log(JSON.stringify(out, null, 0));
await b.close(); server.close();
