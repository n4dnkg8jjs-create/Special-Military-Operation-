// Campaign v5 previews + headless checks: a big formation spotted without recon (own and enemy), the grid before /
// after it grows past the original AOR (UA: south to Tokmak, RU: west of Avdiivka) and close-ups of the new squares.
// usage: flock /tmp/heavy.lock nice -n 10 node src/campaign/v2/tools/v5_shots.mjs [UA|RU]   -> previews/campaign_v5/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const out = path.join(root, 'previews/campaign_v5'); fs.mkdirSync(out, { recursive: true });
const sides = process.argv.slice(2).filter(a => !a.startsWith('--')); if (!sides.length) sides.push('UA', 'RU');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, r)); const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
for (const side of sides) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  const errors = [];
  page.on('console', m => { if (/404|GPU stall|GroupMarkerNotSet|content_index/.test(m.text())) return; if (m.type() === 'error') { errors.push(m.text()); console.log('[page]', m.text()); } });
  page.on('pageerror', e => { errors.push(e.message); console.log('[pageerror]', e.stack || e.message); });
  const shot = async n => { await page.waitForTimeout(1200); await page.screenshot({ path: path.join(out, n), timeout: 240000 }); console.log('shot', n); };
  await page.goto(`${base}/index.html?campaign=1&cside=${side}&nointro`); await page.waitForFunction('window.__done === true', null, { timeout: 600000 });
  await page.evaluate(() => { document.querySelector('.c2-tut')?.remove(); document.querySelectorAll('.c2-modal, .c2-tour').forEach(e => e.remove()); });
  // ---- 1. spotted: the brigade massed at the front, an enemy concentration opposite
  const r1 = await page.evaluate(() => {
    const ui = window.__c2, C = ui.C, T = C.forces[0];
    for (const f of [...C.forces]) if (f !== T) { f.cell = T.cell; C.merge(T.id, f.id); }
    const front = C.def.aor.cells.filter(c => C.owner[c.id] === 'player' && C.frontline(c.id) && C.supplied[c.id] >= 1).sort((a, b) => (b.road || 0) - (a.road || 0))[0];
    T.cell = front.id; T.mp = 0; T.movedT = C.turn;
    const opp = C.neighbors(front.id).map(id => C.cell(id)).filter(c => C.owner[c.id] === 'enemy' && c.terrain !== 'water').sort((a, b) => (b.road || 0) - (a.road || 0));
    const deep = C.def.aor.cells.filter(c => C.owner[c.id] === 'enemy' && C.isOpen(c.id) && !C.neighbors(c.id).some(n => C.owner[n] === 'player') && C.neighbors(c.id).some(n => opp.some(o => o.id === n)))[0] || opp[1] || opp[0];
    const fs = C.eforces.slice(0, 3), lead = fs[0]; for (const f of fs.slice(1)) { lead.str += f.str; C.eforces = C.eforces.filter(x => x !== f); }
    lead.cell = deep.id; lead.movedT = C.turn; C.updateSpots();
    ui.select(T.id); ui.map.refresh(); ui.render();
    const p = ui.map.cellCenter(front.id), q = ui.map.cellCenter(deep.id);
    ui.map.jump({ x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 + 0.6, dist: 9, yaw: 0.25, pitch: 0.82 });
    return { own: C.spotStatus(T.id), enemy: C.spottedEnemy().map(x => x.name), badges: document.querySelectorAll('.c2-spot').length, front: front.id, deep: deep.id };
  });
  ok(r1.own.spotted && r1.enemy.length >= 1 && r1.badges >= 2, `${side} spotted: ${JSON.stringify(r1)}`);
  await shot(`spotted_${side}.png`);
  // ---- 2. the grid before growth (whole AOR from above)
  await page.goto(`${base}/index.html?campaign=1&cside=${side}&nointro`); await page.waitForFunction('window.__done === true', null, { timeout: 600000 });
  await page.evaluate(() => { document.querySelectorAll('.c2-modal, .c2-tour, .c2-tut').forEach(e => e.remove()); const m = window.__c2.map; m.jump({ ...m.view('aor'), pitch: 1.25, yaw: 0 }); });
  const r2 = await page.evaluate(() => ({ cells: window.__c2.C.def.aor.cells.length, gridV: window.__c2.map.gridV, status: window.__c2.C.growthStatus() }));
  ok(r2.gridV === 0 && r2.status.next, `${side} before growth: ${JSON.stringify(r2)}`);
  await shot(`grid_before_${side}.png`);
  // ---- 3. the front reaches the edge: take ground 3 squares from it -> the first band joins, the map is rebuilt
  const grow = async label => page.evaluate(label => {
    const ui = window.__c2, C = ui.C, A = C.def.aor, g = C.growthStatus(), key = g.dir === 'west' || g.dir === 'east' ? 'col' : 'row';
    const edge = g.dir === 'west' ? A.col0 || 0 : g.dir === 'north' ? A.row0 || 0 : g.dir === 'east' ? (A.col0 || 0) + A.cols - 1 : (A.row0 || 0) + A.rows - 1;
    // the brigade's advance: every enemy square up to 3 from the edge along the main axis (a 3-square-wide corridor)
    const own = A.cells.filter(c => C.owner[c.id] === 'player'), axis = own.reduce((a, c) => a + c[key === 'row' ? 'col' : 'row'], 0) / own.length;
    for (const c of A.cells) if (C.owner[c.id] !== 'player' && Math.abs(c[key] - edge) >= 3 && Math.abs(c[key === 'row' ? 'col' : 'row'] - axis) <= 1.5 && c.terrain !== 'water') { C.owner[c.id] = 'player'; C.garrison[c.id] = 0; }
    const added = C.checkGrowth(); C.computeSupply(); ui.map.refresh(); ui.render();
    const m = ui.map; m.jump({ ...m.view('aor'), pitch: 1.25, yaw: 0 });
    return { label, added, cells: C.def.aor.cells.length, cols: C.def.aor.cols, rows: C.def.aor.rows, col0: C.def.aor.col0, row0: C.def.aor.row0, gridV: C.gridV, mapV: ui.map.gridV, mapCells: ui.map.def.aor.cells.length, log: C.log.slice(-6).map(l => l.text).find(t => /edge of the brigade/.test(t)) };
  }, label);
  const r3 = await grow('band1');
  ok(r3.added.length >= 1 && r3.mapV === r3.gridV && r3.mapCells === r3.cells, `${side} grows: ${JSON.stringify(r3)}`);
  await shot(`grid_after1_${side}.png`);
  let r4 = r3; for (let i = 0; i < 3 && (await page.evaluate(() => !!window.__c2.C.growthStatus().next)); i++) r4 = await grow('band' + (i + 2));
  ok(!(await page.evaluate(() => window.__c2.C.growthStatus().next)), `${side} all bands added: ${JSON.stringify(r4)}`);
  await shot(`grid_after_all_${side}.png`);
  // ---- 4. close-up of the new ground (real OSM roads, villages, fortification lines)
  const r5 = await page.evaluate(side => {
    const ui = window.__c2, C = ui.C, name = side === 'UA' ? 'Tokmak' : 'Novoselivka Persha', c = C.def.aor.cells.find(x => x.name === name);
    for (const id of [c.id, ...C.neighbors(c.id)]) C.opened[id] ??= C.turn;
    ui.map.refresh(); const p = ui.map.cellCenter(c.id); ui.map.jump({ x: p.x, z: p.z - (side === 'UA' ? 2.2 : 0), dist: side === 'UA' ? 10 : 8, yaw: 0.3, pitch: 0.85 });
    return { cell: c.id, buildings: ui.map.buildingList.length };
  }, side);
  ok(r5.buildings > 0, `${side} close-up ${JSON.stringify(r5)}`);
  await shot(`grid_closeup_${side}.png`);
  ok(!errors.length, `${side}: no page errors (${errors.slice(0, 3).join(' | ')})`);
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
