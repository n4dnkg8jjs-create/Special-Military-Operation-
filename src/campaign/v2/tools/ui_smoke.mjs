// Headless smoke test of the v2 strategic screen: select / move / split / merge / attack (auto) / end week / reports,
// then (unless --nobattle) a real battle round trip: launch -> ?cbattle (simulated a few seconds) -> collectResult ->
// back to the campaign with the after-action report. Screenshots go to previews/campaign_v2/.
// usage: flock /tmp/heavy.lock nice -n 10 node src/campaign/v2/tools/ui_smoke.mjs [UA|RU] [--nobattle]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const out = path.join(root, 'previews/campaign_v2'); fs.mkdirSync(out, { recursive: true });
const side = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'UA', battle = !process.argv.includes('--nobattle');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.ktx2': 'application/octet-stream', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, r)); const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errors = [];
page.on('console', m => { if (/404|GPU stall|GroupMarkerNotSet|content_index/.test(m.text())) return; if (m.type() === 'error') { errors.push(m.text()); console.log('[page]', m.text()); } });
page.on('pageerror', e => { errors.push(e.message); console.log('[pageerror]', e.stack || e.message); });
const shot = async n => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(out, n), timeout: 180000 }); console.log('shot', n); };
const done = async () => page.waitForFunction('window.__done === true', null, { timeout: 600000 });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };

await page.goto(`${base}/index.html?campaign=1&cside=${side}&nointro`); await done();
const r1 = await page.evaluate(() => {
  const ui = window.__c2, C = ui.C, tf = C.forces[0]; ui.select(tf.id);
  const reach = ui.reachOf(tf.id), moves = [...reach].filter(([, k]) => k === 'move').map(([id]) => id), atks = [...reach].filter(([, k]) => k === 'attack').map(([id]) => id);
  return { tf: tf.id, n: tf.units.length, moves: moves.length, atks: atks.length, panel: !!document.querySelector('.c2-card.tfsel'), tokens: document.querySelectorAll('.c2-tok').length };
});
ok(r1.panel && r1.tokens >= 1 && r1.moves > 0, `selection: ${JSON.stringify(r1)}`);
// split two units off, merge back
const r2 = await page.evaluate(() => {
  const ui = window.__c2, C = ui.C, tf = C.forces[0], n0 = C.forces.length; ui.pick = new Set(tf.units.slice(0, 1)); ui.renderRight();
  const b = [...document.querySelectorAll('.c2-card.tfsel button')].find(x => /Split off/.test(x.textContent)); b.click();
  const n1 = C.forces.length, nf = C.tf(ui.sel); const mb = [...document.querySelectorAll('.c2-card.tfsel button')].find(x => /^Merge/.test(x.textContent)); mb?.click();
  return { n0, n1, n2: C.forces.length, detached: nf?.units.length };
});
ok(r2.n1 === r2.n0 + 1 && r2.n2 === r2.n0, `split/merge via the panel: ${JSON.stringify(r2)}`);
// hover path + move order
const r3 = await page.evaluate(() => {
  const ui = window.__c2, C = ui.C, tf = C.forces.find(f => ![...ui.reachOf(f.id).values()].includes('attack')) || C.forces[C.forces.length - 1]; ui.select(tf.id);
  const reach = ui.reachOf(tf.id), dest = [...reach].find(([id, k]) => k === 'move' && C.plan(tf.id, id).ok)?.[0];
  ui.hoverCell(dest); const lbl = document.querySelector('.c2-path-l')?.textContent;
  const mp0 = tf.mp; ui.order(dest); return { dest, lbl, at: tf.cell, mp0, mp: tf.mp };
});
ok(r3.at === r3.dest && r3.mp < r3.mp0 && /MP/.test(r3.lbl || ''), `move order: ${JSON.stringify(r3)}`);
await shot(`ui_${side}_moved.png`);
// attack modal (auto-resolve)
const r4 = await page.evaluate(() => {
  const ui = window.__c2, C = ui.C;
  for (const tf of C.forces) { const p = C.def.aor.cells.map(c => ({ id: c.id, p: C.plan(tf.id, c.id) })).find(x => x.p.ok && x.p.attack); if (p) { ui.select(tf.id); ui.order(p.id); return { tf: tf.id, cell: p.id, modal: !!document.querySelector('.c2-modal') }; } }
  return null;
});
ok(r4?.modal, `attack modal: ${JSON.stringify(r4)}`);
if (r4) {
  await shot(`ui_${side}_attack_modal.png`);
  const r5 = await page.evaluate(() => { const b = [...document.querySelectorAll('.c2-modal button')].find(x => /Auto-resolve/.test(x.textContent)); b.click(); return { report: !!document.querySelector('.c2-modal h1'), battles: window.__c2.C.stats.battles }; });
  ok(r5.report && r5.battles === 1, `auto-resolve report: ${JSON.stringify(r5)}`);
  await shot(`ui_${side}_result.png`);
  await page.evaluate(() => document.querySelector('.c2-modal button.pri')?.click());
}
// end weeks until a new directive or 4 weeks
for (let i = 0; i < 4; i++) {
  const r = await page.evaluate(() => { const ui = window.__c2, C = ui.C, d0 = C.date; ui.endTurn(); let b = [...document.querySelectorAll('.c2-modal button')].find(x => /End week/.test(x.textContent)); b?.click(); const rep = !!document.querySelector('.c2-report'); return { d0, d1: C.date, rep }; });
  ok(r.d1 > r.d0, `week advanced ${JSON.stringify(r)}`);
  if (i === 0) await shot(`ui_${side}_weekly_report.png`);
  for (let k = 0; k < 3; k++) await page.evaluate(() => document.querySelector('.c2-modal button.pri')?.click());
}
await page.waitForTimeout(2500); await shot(`ui_${side}_week5.png`);
await page.evaluate(() => { const ui = window.__c2; ui.tab = 'hc'; ui.hcTab = 'tech'; ui.renderLeft(); }); await shot(`ui_${side}_techtree.png`);
await page.evaluate(() => { const ui = window.__c2; ui.tab = 'log'; ui.renderLeft(); ui.toggleSupply(); }); await shot(`ui_${side}_log_supply.png`);
// persistence: reload restores the same week
const before = await page.evaluate(() => ({ turn: window.__c2.C.turn, lp: window.__c2.C.lp }));
// (v6: the true-scale map is a heavier first frame under swiftshader: the reload's load event came at ~32 s, over the 30 s default)
{ const t0 = Date.now(); await page.goto(`${base}/index.html?campaign=1&nointro`, { timeout: 180000 }); console.log('reload: load event after', Date.now() - t0, 'ms'); await done(); }
const after = await page.evaluate(() => ({ turn: window.__c2.C.turn, lp: window.__c2.C.lp }));
ok(after.turn === before.turn && after.lp === before.lp, `persisted ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

if (battle) {
  // a real battle: launch from the attack modal (FIGHT), simulate, return
  const r6 = await page.evaluate(() => {
    const ui = window.__c2, C = ui.C; ui.onLaunch = () => { window.__launched = true; };
    for (const tf of C.forces) { const p = C.def.aor.cells.map(c => ({ id: c.id, p: C.plan(tf.id, c.id) })).find(x => x.p.ok && x.p.attack); if (p) { ui.select(tf.id); ui.order(p.id); [...document.querySelectorAll('.c2-modal button')].find(x => /FIGHT/.test(x.textContent)).click(); return { cell: p.id, pending: !!localStorage.getItem('smo.campaign.v2.battle') }; } }
    return null;
  });
  ok(r6?.pending, `battle stored: ${JSON.stringify(r6)}`);
  if (r6) {
    await page.waitForTimeout(600);
    await page.goto(`${base}/index.html?cbattle=1&sim=20&quality=low`, { timeout: 180000 }); await done();   // (v7: load can exceed 30 s under machine load)
    const info = await page.evaluate(() => ({ camp: window.__info?.camp, map: window.game?.map?.id, v2: !!window.game?.campaign?.v2 }));
    ok(info.v2 && info.camp && info.camp.sector === r6.cell, `battle ran on ${info.map}: ${JSON.stringify(info.camp)?.slice(0, 200)}`);
    await shot(`ui_${side}_battle.png`);
    await page.evaluate(() => { window.game.over = true; window.game.result = { win: true }; window.__campaignReturn(); });
    await page.waitForURL(/campaign=1/); await done();
    const r7 = await page.evaluate(() => ({ battles: window.__c2.C.stats.battles, modal: document.querySelector('.c2-modal h1')?.textContent, pending: localStorage.getItem('smo.campaign.v2.battle') }));
    ok(r7.modal && !r7.pending, `returned with report: ${JSON.stringify(r7)}`);
    await shot(`ui_${side}_after_battle.png`);
  }
}
ok(!errors.length, `no page errors (${errors.length})`);
console.log(`\n${pass} passed, ${fail} failed`); console.log('page errors:', errors.slice(0, 5));
await browser.close(); server.close(); process.exit(fail ? 1 : 0);
