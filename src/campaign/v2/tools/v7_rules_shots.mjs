// Campaign v7 (rules) previews: the enemy layout on the strategic map — before (a garrison badge in every square) and
// after (battalion groups of companies, outposts, empty rear; observed enemy moves as arrows after two weeks).
// usage: flock /tmp/heavy.lock nice -n 10 node src/campaign/v2/tools/v7_rules_shots.mjs <before|after> [UA|RU]
//   before: serves the rules files from OVERLAY (default /tmp/v7r_before/v2) on top of the current tree
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const out = path.join(root, 'previews/campaign_v7_rules'); fs.mkdirSync(out, { recursive: true });
const args = process.argv.slice(2), tag = args[0] || 'after', sides = args.slice(1).length ? args.slice(1) : ['UA', 'RU'];
const overlay = tag === 'before' ? (process.env.OVERLAY || '/tmp/v7r_before/v2') : null;
const RULES = new Set(['state.js', 'ai.js', 'growth.js', 'recon.js', 'versus.js', 'content_ua.js', 'content_ru.js', 'ui.js']);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  let p = path.join(root, rel);
  if (overlay && rel.startsWith('/src/campaign/v2/') && RULES.has(path.basename(rel)) && fs.existsSync(path.join(overlay, path.basename(rel)))) p = path.join(overlay, path.basename(rel));
  if ((!p.startsWith(root) && !(overlay && p.startsWith(overlay))) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r)); const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
for (const side of sides) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  page.on('pageerror', e => { fail++; console.log('[pageerror]', e.stack || e.message); });
  const shot = async n => { await page.waitForTimeout(1500); await page.screenshot({ path: path.join(out, n), timeout: 240000 }); console.log('shot', n); };
  await page.goto(`${base}/index.html?campaign=1&cside=${side}&nointro`, { timeout: 180000 }); await page.waitForFunction('window.__done === true', null, { timeout: 600000 });
  const clean = () => page.evaluate(() => { document.querySelectorAll('.c2-modal, .c2-tour, .c2-tut').forEach(e => e.remove()); });
  await clean();
  // camera over the front: the centre of the own front squares, looking across the line
  const aim = () => page.evaluate(() => {
    const ui = window.__c2, C = ui.C, m = ui.map, fr = C.def.aor.cells.filter(c => C.owner[c.id] !== 'player' && C.neighbors(c.id).some(n => C.owner[n] === 'player'));
    const ps = fr.map(c => m.cellCenter(c.id)), x = ps.reduce((a, p) => a + p.x, 0) / ps.length, z = ps.reduce((a, p) => a + p.z, 0) / ps.length;
    m.jump({ x, z, dist: 22, yaw: 0, pitch: 1.05 }); m.refresh();
    const en = document.querySelectorAll('.c2-en').length, foes = document.querySelectorAll('.c2-tok.foe').length;
    return { side: C.side, enemyBadges: en, foeTokens: foes, eforces: (C.eforces || []).length, foesVisible: (C.foes || []).length, moves: (C.enemyMoves?.list || []).filter(x => x.seen).length };
  });
  const r1 = await aim(); console.log(tag, side, 'start', JSON.stringify(r1)); ok(r1.enemyBadges + r1.foeTokens > 0, `${side} enemy markers shown`);
  await shot(`${tag}_${side}_start.png`);
  // two weeks: drones over the enemy line first (what the brigade would see), then end the week twice
  const r2 = await page.evaluate(() => {
    const ui = window.__c2, C = ui.C;
    for (let w = 0; w < 2; w++) {
      const tgts = C.def.aor.cells.filter(c => C.owner[c.id] === 'enemy' && C.isOpen(c.id) && !C.uavCheck('wing', c.id)).sort((a, b) => (b.vp || 0) - (a.vp || 0));
      for (const c of tgts.slice(0, 3)) C.flyUav(C.uavCheck('quad', c.id) ? 'wing' : 'quad', c.id);
      C.pendingAttacks = []; C.endTurn();
    }
    const tgts = C.def.aor.cells.filter(c => C.owner[c.id] === 'enemy' && C.isOpen(c.id) && !C.uavCheck('wing', c.id)).sort((a, b) => (b.vp || 0) - (a.vp || 0));
    for (const c of tgts.slice(0, 2)) C.flyUav('wing', c.id);
    ui.render(); ui.map.refresh();
    return { turn: C.turn, log: C.log.filter(l => /Enemy movement observed|preparing to/.test(l.text)).slice(-6).map(l => l.text) };
  });
  console.log(tag, side, 'week', r2.turn, JSON.stringify(r2.log));
  await clean();
  const r3 = await aim(); console.log(tag, side, 'week3', JSON.stringify(r3));
  await shot(`${tag}_${side}_week3.png`);
  await page.close();
}
await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed`);
