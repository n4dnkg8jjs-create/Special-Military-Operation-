// Bug hunt: plays the v2 campaign like a player with REAL mouse / keyboard input (token clicks, right-click moves and
// attacks on the 3D map, panel buttons, modals, keys), many weeks, unusual actions (split / merge spam, depots,
// purchases, defending announced attacks, reload mid-turn, reload / back mid-battle, losing the HQ, the end of the
// campaign), and checks state + UI invariants after every step. Screenshots → previews/campaign_v3/hunt_*.png
// usage: flock /tmp/heavy.lock nice -n 10 node src/campaign/v2/tools/play_hunt.mjs [UA|RU] [weeks=14] [--shots]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const out = path.join(root, 'previews/campaign_v3'); fs.mkdirSync(out, { recursive: true });
const args = process.argv.slice(2).filter(a => !a.startsWith('--')), SIDE = args[0] || 'UA', WEEKS = +(args[1] || 14), SHOTS = process.argv.includes('--shots');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.ktx2': 'application/octet-stream', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, r)); const base = `http://localhost:${server.address().port}/index.html`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 } });
await ctx.addInitScript(() => { localStorage.setItem('smo_noaudio', '1'); localStorage.setItem('smo_quality', 'low'); });
const page = await ctx.newPage();
const errors = [], issues = [];
page.on('console', m => { if (/404|GPU stall|GroupMarkerNotSet|content_index|Automatic fallback/.test(m.text())) return; if (m.type() === 'error') { errors.push(m.text()); console.log('[page error]', m.text().slice(0, 300)); } });
page.on('pageerror', e => { errors.push(e.message); console.log('[pageerror]', (e.stack || e.message).slice(0, 600)); });
page.on('dialog', d => d.accept('Renamed TF'));
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; issues.push(m); console.log('  FAIL:', m); } };
const shot = async n => { if (!SHOTS) return; await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, `hunt_${SIDE}_${n}.png`), timeout: 180000 }).catch(e => console.log('shot failed', n, e.message)); };
page.on('crash', () => console.log('[page crashed]'));
const done = () => page.waitForFunction('window.__done === true', null, { timeout: 600000 });
const R = (() => { let s = 1234 + SIDE.charCodeAt(0); return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
const pickOne = a => a[Math.floor(R() * a.length)];

// ---- in-page helpers
const inv = () => page.evaluate(() => {
  const ui = window.__c2; if (!ui) return ['no __c2'];
  const C = ui.C, bad = [], seen = new Map();
  for (const f of C.forces) { if (!f.units.length) bad.push(`empty tf ${f.id}`); if (C.owner[f.cell] !== 'player') bad.push(`tf ${f.name} on ${C.owner[f.cell]} cell ${f.cell}`); if (!isFinite(f.mp) || f.mp < -1e-6 || f.mp > C.tfMpMax(f) + 1e-6) bad.push(`tf ${f.name} mp ${f.mp}/${C.tfMpMax(f)}`); for (const u of f.units) { if (seen.has(u)) bad.push(`unit ${u} in two tfs`); seen.set(u, f.id); if (!C.unit(u)) bad.push(`tf ${f.name} has missing unit ${u}`); } }
  for (const u of C.units) if (!seen.has(u.uid)) bad.push(`unit ${u.uid} ${u.name} in no tf`);
  if (new Set(C.forces.map(f => f.id)).size !== C.forces.length) bad.push('duplicate tf ids');
  if (!isFinite(C.lp) || C.lp < 0) bad.push(`lp ${C.lp}`);
  for (const u of C.units) { if (u.men < 0 || u.wounded < 0 || !isFinite(u.men) || u.men > u.menMax) bad.push(`unit ${u.name} men ${u.men}/${u.menMax} w${u.wounded}`); if (u.veh && (!isFinite(u.veh.hp) || u.veh.hp < 0 || u.veh.hp > 1)) bad.push(`unit ${u.name} veh hp ${u.veh.hp}`); }
  for (const a of C.pendingAttacks) { if (C.owner[a.to] === 'enemy') bad.push(`pending attack on enemy cell ${a.to}`); if (C.owner[a.from] === 'player') bad.push(`pending attack from own cell ${a.from}`); }
  const toks = document.querySelectorAll('.c2-tok').length; if (toks !== C.forces.length) bad.push(`tokens ${toks} != forces ${C.forces.length}`);
  if (document.querySelectorAll('.c2-modal').length > 1) bad.push(`${document.querySelectorAll('.c2-modal').length} modals stacked`);
  if (ui.sel && !C.tf(ui.sel)) bad.push('selection points at a dissolved tf');
  const hq = document.querySelectorAll('.c2-hq').length; if (hq !== 1) bad.push(`hq badges ${hq}`);
  if (C.owner[C.hq || C.def.start.hq] !== 'player' && C.def.aor.cells.some(c => C.owner[c.id] === 'player')) bad.push(`HQ ${C.hq} on a lost cell`);
  if (!document.querySelector('.c2-top .c2-end')) bad.push('no end week button');
  return bad;
});
const check = async what => { const b = await inv(); ok(!b.length, `${what}: ${b.join('; ')}`); return b; };
const modalText = () => page.evaluate(() => [...document.querySelectorAll('.c2-modal')].map(m => m.innerText.slice(0, 120).replace(/\s+/g, ' ')).join(' | '));
// dismiss modals by clicking their primary (or the given label) with the real mouse
async function closeModals(label = null, max = 6) {
  for (let i = 0; i < max; i++) {
    const has = await page.$('.c2-modal'); if (!has) return;
    const btns = await page.$$('.c2-modal >> nth=-1 >> button');
    let b = null; if (label) for (const x of btns) if (new RegExp(label, 'i').test(await x.textContent())) { b = x; break; }
    if (!b) b = (await page.$$('.c2-modal >> nth=-1 >> button.pri'))[0] || btns[0];
    if (!b) return; await b.click(); await page.waitForTimeout(120);
  }
}
// screen position of a cell (centre the camera on it first if it is off-screen or under a panel)
async function cellPoint(id, centre = false) {
  return page.evaluate(([id, centre]) => {
    const ui = window.__c2, m = ui.map;
    // any point inside the cell where the canvas itself is hit (not a token, badge or panel)
    const find = () => { const c = m.cellCenter(id); for (const [dx, dz] of [[0, 0], [0.25, 0.25], [-0.25, 0.25], [0.25, -0.25], [-0.25, -0.25], [0, 0.35], [0.35, 0], [-0.35, 0], [0, -0.35]]) { const p = m.screenOf(new c.constructor(c.x + dx * m.cw, 0, c.z + dz * m.ch)); if (!p) continue; const el = document.elementFromPoint(p.x, p.y); if (el === m.canvas && m.cellAtWorld(m.groundAt(p.x, p.y)?.x ?? 1e9, m.groundAt(p.x, p.y)?.z ?? 1e9) === id) return p; } return null; };
    let p = centre ? null : find();
    if (!p) { const c = m.cellCenter(id); m.jump({ x: c.x, z: c.z, dist: Math.min(m.cam.dist, 14) }); m.frame(0.016, performance.now() + 1000); p = find(); }
    if (!p) { const c = m.cellCenter(id); m.jump({ x: c.x, z: c.z, dist: 7, pitch: 1.3 }); m.frame(0.016, performance.now() + 2000); p = find(); }
    if (!p) { const q = m.screenOf(id); const el = q && document.elementFromPoint(q.x, q.y); console.error('cellPoint failed', id, JSON.stringify(q), el?.tagName, el?.className?.baseVal ?? el?.className, document.querySelector('.c2-modal')?.innerText?.slice(0, 80)); }
    return p;
  }, [id, centre]);
}
async function rightClickCell(id) { const p = await cellPoint(id); if (!p) return false; await page.mouse.move(p.x, p.y); await page.waitForTimeout(60); await page.mouse.click(p.x, p.y, { button: 'right' }); await page.waitForTimeout(120); return true; }
async function leftClickCell(id) { const p = await cellPoint(id); if (!p) return false; await page.mouse.click(p.x, p.y); await page.waitForTimeout(100); return true; }
async function clickToken(tfId) {
  const p = await page.evaluate(id => { const ui = window.__c2, f = ui.C.tf(id); const c = ui.map.cellCenter(f.cell); ui.map.jump({ x: c.x, z: c.z, dist: Math.min(ui.map.cam.dist, 12) }); ui.map.frame(0.016, performance.now() + 3000); const t = ui.map.tokens.find(t => t.tf === id); if (!t) return null; const r = t.e.querySelector('.c2-nato')?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; }, tfId);
  if (!p) return false; const el = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e?.closest('.c2-tok') ? 'tok' : e?.className?.baseVal ?? e?.className; }, [p.x, p.y]);
  if (el !== 'tok') { ok(false, `token of ${tfId} not clickable at ${p.x},${p.y} (covered by ${el})`); return false; }
  await page.mouse.click(p.x, p.y); await page.waitForTimeout(100); return true;
}
const state = () => page.evaluate(() => { const C = window.__c2.C; return { turn: C.turn, date: C.date, lp: C.lp, forces: C.forces.map(f => ({ id: f.id, cell: f.cell, n: f.units.length, mp: f.mp, att: f.attacked })), battles: C.stats.battles, att: C.pendingAttacks.length, dirs: C.directives.map(a => a.id), done: { ...C.doneDirectives }, outcome: C.outcome()?.title || null, battle: C.battle }; });

// ================================================================ 1. fresh start through the side picker + intro
await page.goto(`${base}?campaign=1`, { timeout: 300000 }); await page.evaluate(() => localStorage.removeItem('smo.campaign.v2.tutorial'));
await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('smo.campaign.v2')) localStorage.removeItem(k); });
await page.goto(`${base}?campaign=1`, { timeout: 300000 }); await page.waitForSelector('.c2-side');
await page.click(`.c2-side.${SIDE}`); await page.waitForSelector('.c2-intro', { timeout: 60000 });
await page.waitForTimeout(1500); await shot('01_intro');
// reload in the middle of the intro: the intro must come back (it was never watched to the end)
await page.reload({ timeout: 300000 }); await page.waitForFunction('!!window.__c2', null, { timeout: 60000 });
ok(await page.$('.c2-intro'), 'intro replays after a reload during the intro');
await page.keyboard.press('Space'); await page.waitForTimeout(1200);
ok(!(await page.$('.c2-intro')), 'intro skipped with a key');
// after the intro: directive modal and/or the tutorial offer
let mt = await modalText(); console.log('after intro:', mt.slice(0, 200));
ok(/DIRECTIVE|TUTORIAL|tutorial/i.test(mt + (await page.evaluate(() => document.querySelector('.c2-tut')?.innerText || ''))), 'directive / tutorial offer after the intro');
// Escape on a modal must not trigger its primary action unless it is the only one
await closeModals(); await page.waitForSelector('.c2-tut.on', { timeout: 15000 }).catch(() => {});   // (slow headless frames)
ok(await page.$('.c2-tut.on'), 'guided tour offered after the first directive');
await shot('02a_tour_offer');
await page.keyboard.press('Escape'); await page.waitForTimeout(600);
ok(!(await page.$('.c2-tut')), 'Esc closes the tour offer');
await check('after intro');
await shot('02_start');

// ================================================================ 2. selection, hover path, right-click move (real mouse)
let S = await state();
const tf0 = S.forces[0].id;
ok(await clickToken(tf0), 'click token selects'); ok(await page.evaluate(id => window.__c2.sel === id, tf0), 'token click → selection');
ok(await page.$('.c2-card.tfsel'), 'selection panel open');
// Escape deselects
await page.keyboard.press('Escape'); ok(await page.evaluate(() => !window.__c2.sel), 'Escape deselects');
await page.keyboard.press('Tab'); ok(await page.evaluate(() => !!window.__c2.sel), 'Tab selects a task force');
// find a move destination and hover it
const mv = await page.evaluate(() => { const ui = window.__c2, C = ui.C; for (const f of C.forces) { const r = ui.reachOf(f.id); const d = [...r].filter(([id, k]) => k === 'move').map(([id]) => id); if (d.length) return { tf: f.id, dest: d[d.length - 1] }; } return null; });
ok(mv, 'some task force can move');
if (mv) {
  await clickToken(mv.tf);
  const p = await cellPoint(mv.dest); await page.mouse.move(p.x - 3, p.y - 3); await page.mouse.move(p.x, p.y); await page.waitForTimeout(150);
  const lbl = await page.evaluate(() => document.querySelector('.c2-path-l')?.textContent);
  ok(/MP/.test(lbl || ''), `hover path label: ${lbl}`);
  await shot('03_hover');
  await page.mouse.click(p.x, p.y, { button: 'right' }); await page.waitForTimeout(200);
  const at = await page.evaluate(id => window.__c2.C.tf(id)?.cell, mv.tf);
  ok(at === mv.dest, `right-click move: tf at ${at}, wanted ${mv.dest}`);
  await check('after move');
}
// left-click on empty ground deselects / selects the cell
await page.keyboard.press('Escape');
// ================================================================ 3. split / merge spam through the panel
{
  const big = await page.evaluate(() => { const C = window.__c2.C; return C.forces.slice().sort((a, b) => b.units.length - a.units.length)[0].id; });
  await clickToken(big);
  const n0 = await page.evaluate(() => window.__c2.C.forces.length), u0 = await page.evaluate(id => window.__c2.C.tf(id).units.length, big);
  for (let i = 0; i < u0 - 1; i++) {   // detach one unit at a time (re-select the original each time)
    await page.evaluate(id => window.__c2.select(id), big);
    const boxes = await page.$$('.c2-card.tfsel .c2-unit input'); if (boxes.length < 2) break;
    await boxes[0].click();
    const sb = (await page.$$('.c2-card.tfsel button')).find; const btn = await page.$('.c2-card.tfsel button:has-text("Split off")');
    await btn.click(); await page.waitForTimeout(80);
  }
  const n1 = await page.evaluate(() => window.__c2.C.forces.length);
  ok(n1 === n0 + u0 - 1, `split spam: ${n0} → ${n1} forces`);
  const tabN = await page.evaluate(() => +(document.querySelector('.c2-tabs button:nth-child(2) i')?.textContent || 0)); ok(tabN === n1, `Forces tab count follows the splits (${tabN} / ${n1})`);
  await check('after split spam'); await shot('04_split_spam');
  // stacked tokens must all be clickable (not overlapping)
  const cellF = await page.evaluate(id => { const C = window.__c2.C; const c = C.tf(id).cell; return C.forcesAt(c).map(f => f.id); }, big);
  const ovl = await page.evaluate(ids => { const rs = window.__c2.map.tokens.filter(t => ids.includes(t.tf) && t.vis !== false).map(t => t.e.querySelector('.c2-nato').getBoundingClientRect()); let n = 0; for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const a = rs[i], b = rs[j]; if (a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2) n++; } const names = window.__c2.map.tokens.filter(t => ids.includes(t.tf) && t.vis !== false && getComputedStyle(t.e.querySelector('.c2-tok-n')).visibility !== 'hidden').length; return { n, names, of: rs.length }; }, cellF);
  ok(ovl.n === 0 && ovl.names === 1, `stacked tokens side by side, one name shown: ${JSON.stringify(ovl)}`);
  let clickable = 0; for (const id of cellF) if (await clickToken(id)) clickable++;
  ok(clickable === cellF.length, `stacked tokens clickable: ${clickable}/${cellF.length}`);
  // merge them all back through the Merge buttons
  for (let i = 0; i < 20; i++) { await page.evaluate(id => window.__c2.select(id), big); const b = await page.$('.c2-card.tfsel button:has-text("Merge")'); if (!b) break; await b.click(); await page.waitForTimeout(60); }
  const n2 = await page.evaluate(() => window.__c2.C.forces.length);
  ok(n2 === n0, `merge back: ${n2} forces (was ${n0})`);
  await check('after merge spam');
  // split + move one part + merge must not create movement points
  const r = await page.evaluate(id => { const ui = window.__c2, C = ui.C, tf = C.tf(id); C.resetMoves(); const mp0 = tf.mp; const p = C.split(tf.id, [tf.units[0]]); const ok1 = C.merge(tf.id, p.id); return { mp0, mp1: C.tf(id).mp }; }, big);
  ok(Math.abs(r.mp0 - r.mp1) < 1e-6, `split/merge MP neutral ${JSON.stringify(r)}`);
  await page.evaluate(() => { window.__c2.C.save(); window.__c2.render(); window.__c2.map.refresh(); });
}
// ================================================================ 4. depot, purchases, tech, replacements (panel clicks)
await page.evaluate(() => { window.__c2.C.lp += 300; window.__c2.render(); });
{
  const dc = await page.evaluate(() => { const C = window.__c2.C; return C.def.aor.cells.filter(c => C.depotAllowed(c.id)).map(c => c.id).pop(); });
  if (dc) { await page.keyboard.press('Escape'); await leftClickCell(dc); const b = await page.$('.c2-card.cell button:has-text("depot")'); ok(b, `depot button on ${dc}`); if (b) { await b.click(); ok(await page.evaluate(id => window.__c2.C.depots.includes(id), dc), 'depot built'); } }
  await page.click('.c2-tabs button:has-text("High command")');
  const ordered = await page.$$('.c2-pane .c2-card.cat button.pri:not([disabled])'); if (ordered[0]) { await ordered[0].click(); ok(await page.evaluate(() => window.__c2.C.orders.length > 0), 'unit ordered'); }
  await page.click('.c2-subtabs button:has-text("Tech")'); await shot('05_tech');
  const tb = await page.$$('.c2-tn.avail button:not([disabled])'); if (tb[0]) { await tb[0].click(); ok(await page.evaluate(() => window.__c2.C.orders.some(o => o.what === 'tech')), 'tech requested'); }
  await page.click('.c2-subtabs button:has-text("Replacements")');
  await check('after purchases');
}
// ================================================================ 5. weeks of play
let reloads = 0, battlesFought = 0, defended = 0, lostHq = false;
for (let w = 0; w < WEEKS; w++) {
  S = await state(); if (S.outcome) break;
  // (make sure the defence path is exercised at least once: announce an enemy attack on a task force's square)
  if (w === 2 && !S.att) await page.evaluate(() => { const ui = window.__c2, C = ui.C; for (const f of C.forces) { const from = C.neighbors(f.cell).find(n => C.owner[n] === 'enemy'); if (from) { C.pendingAttacks.push({ id: 'eaHunt', from, to: f.cell, strength: 2 }); ui.render(); ui.map.refresh(); return; } } });
  // defend announced attacks: move a task force into a threatened square when possible
  const def = await page.evaluate(() => { const ui = window.__c2, C = ui.C; for (const a of C.pendingAttacks) for (const f of C.forces) { if (f.cell === a.to) return { tf: f.id, to: a.to, there: true, a: a.id }; const p = C.plan(f.id, a.to); if (p.ok && !p.attack) return { tf: f.id, to: a.to, a: a.id }; } return null; });
  if (def) {
    if (!def.there) { await clickToken(def.tf); await rightClickCell(def.to); }
    const there = await page.evaluate(d => window.__c2.C.tf(d.tf)?.cell === d.to, def);
    if (there) { const b = await page.$('.c2-card.c2-alert button:has-text("Auto")'); if (b) { const n0 = await page.evaluate(() => window.__c2.C.pendingAttacks.length); await b.click(); await page.waitForTimeout(150); defended++; if (w === 2) await shot('06b_defence_result'); await closeModals(); ok(await page.evaluate(() => window.__c2.C.pendingAttacks.length) === n0 - 1, 'auto-resolved defence clears the announced attack'); } }
  }
  // attacks: each force with an attack option, through the attack modal (auto-resolve), right-click on the cell
  const atk = await page.evaluate(() => { const ui = window.__c2, C = ui.C, out = []; for (const f of C.forces) { if (C.tfPower(f) < 2) continue; const t = C.def.aor.cells.map(c => ({ id: c.id, p: C.plan(f.id, c.id) })).filter(x => x.p.ok && x.p.attack).sort((a, b) => (C.garrison[a.id] || 0) - (C.garrison[b.id] || 0))[0]; if (t) out.push({ tf: f.id, cell: t.id }); } return out; });
  for (const a of atk.slice(0, 2)) {
    if (!(await page.evaluate(a => { const C = window.__c2.C, p = C.tf(a.tf) && C.plan(a.tf, a.cell); return !!(p && p.ok && p.attack); }, a))) continue;   // (an earlier attack this week may have taken the square)
    const nB = await page.evaluate(() => window.__c2.C.stats.battles);
    await clickToken(a.tf); const okc = await rightClickCell(a.cell);
    const modal = await page.$('.c2-modal'); if (!modal) { ok(false, `attack modal did not open for ${a.tf} → ${a.cell} (clicked ${okc})`); continue; }
    if (w === 1) await shot('06_attack_modal');
    // Escape must cancel the attack order, not start the battle
    if (w === 0) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); const st = await page.evaluate(() => ({ modal: !!document.querySelector('.c2-modal'), launched: !!localStorage.getItem('smo.campaign.v2.battle'), battles: window.__c2.C.stats.battles })); ok(!st.modal && !st.launched && st.battles === nB, `Escape cancels the attack order ${JSON.stringify(st)}`); await clickToken(a.tf); await rightClickCell(a.cell); }
    const b = await page.$('.c2-modal button:has-text("Auto")'); if (b) { await b.click(); battlesFought++; await page.waitForTimeout(150); }
    await closeModals(); await check(`after attack ${a.tf} → ${a.cell}`);
  }
  // random split / merge / stance
  const r = R();
  if (r < 0.3) await page.evaluate(() => { const ui = window.__c2, C = ui.C, f = C.forces.find(x => x.units.length > 2); if (f) { const p = C.split(f.id, [f.units[0]]); ui.select(typeof p === 'object' ? p.id : f.id); } });
  else if (r < 0.5) await page.evaluate(() => { const ui = window.__c2, C = ui.C; for (const f of C.forces) { const o = C.forcesAt(f.cell).find(x => x !== f); if (o) { C.merge(f.id, o.id); break; } } ui.render(); ui.map.refresh(); });
  else if (r < 0.6) { const f = pickOne(S.forces); await page.evaluate(id => window.__c2.select(id), f.id); const sb = await page.$('.c2-seg button:has-text("Dig in")'); if (sb) await sb.click(); }
  await check(`week ${w} actions`);
  // reload mid-turn now and then
  if (w % 5 === 2) { const before = await state(); await page.reload({ timeout: 300000 }); await done(); await closeModals(); const after = await state(); ok(after.turn === before.turn && after.lp === before.lp && JSON.stringify(after.forces) === JSON.stringify(before.forces), `reload mid-turn keeps the state`); reloads++; }
  // end the week with the button (real click) and walk the reports
  await page.click('.c2-end'); await page.waitForTimeout(150);
  const t1 = await modalText(); if (/expected on undefended/.test(t1)) await closeModals('End week', 1);
  if (w === 0) await shot('07_weekly');
  await closeModals(); await page.waitForTimeout(80); await closeModals();
  const S2 = await state(); ok(S2.turn === S.turn + 1 || S2.outcome, `week advanced ${S.turn} → ${S2.turn}`);
  await check(`after end of week ${S.turn}`);
}
// pressing Enter twice must not skip two weeks
{
  const t0 = (await state()).turn; await page.click('.c2-end'); await page.waitForTimeout(150);   // the END WEEK button keeps focus
  await page.keyboard.press('Enter'); await page.waitForTimeout(150); await page.keyboard.press('Enter'); await page.waitForTimeout(150); await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  await closeModals(); const t1 = (await state()).turn; ok(t1 - t0 <= 2, `END WEEK + Enter presses: ${t0} → ${t1}`);
}
// ================================================================ 6. a real battle: launch, reload mid-battle, back button, resume / withdraw
{
  await page.evaluate(() => { window.__c2.C.lp += 100; });
  const a = await page.evaluate(() => { const ui = window.__c2, C = ui.C; C.resetMoves(); for (const f of C.forces) { const t = C.def.aor.cells.find(c => C.plan(f.id, c.id).ok && C.plan(f.id, c.id).attack); if (t) return { tf: f.id, cell: t.id, n: C.stats.battles }; } return null; });
  if (a) {
    await clickToken(a.tf); await rightClickCell(a.cell); const fb = await page.$('.c2-modal button:has-text("FIGHT")'); ok(fb, 'FIGHT button');
    if (fb) {
      await fb.click(); await page.waitForURL(/cbattle=1/, { timeout: 30000 }); await page.waitForFunction(() => window.game && window.__done, null, { timeout: 300000 });
      ok(await page.evaluate(() => !!window.game?.campaign?.v2), 'battle page loaded');
      await page.reload({ timeout: 300000 }); await page.waitForFunction(() => window.game && window.__done, null, { timeout: 300000 });
      ok(await page.evaluate(() => !!window.game?.campaign?.v2), 'reload mid-battle restarts the same battle');
      await page.goBack({ timeout: 300000 }); await page.waitForFunction('!!window.__c2 && window.__done', null, { timeout: 120000 }).catch(() => {});
      const st = await page.evaluate(() => ({ url: location.search, modal: document.querySelector('.c2-modal')?.innerText.slice(0, 200), battle: window.__c2?.C.battle }));
      console.log('back from battle:', JSON.stringify(st));
      ok(st.modal && /battle|BATTLE/.test(st.modal), `back button from the battle offers resume / withdraw: ${st.modal}`);
      await shot('08_resume');
      const wd = await page.$('.c2-modal button:has-text("Withdraw")');
      if (wd) { await wd.click(); await page.waitForTimeout(200); const s3 = await page.evaluate(() => ({ battles: window.__c2.C.stats.battles, battle: window.__c2.C.battle, pending: localStorage.getItem('smo.campaign.v2.battle'), att: window.__c2.C.tf(window.__c2.C.forces[0].id)?.attacked })); ok(s3.battles === a.n + 1 && !s3.battle && !s3.pending, `withdraw counts the battle as lost ${JSON.stringify(s3)}`); await closeModals(); }
      await check('after withdraw');
    }
  }
}
// ================================================================ 7. losing the HQ
{
  const r = await page.evaluate(() => { const ui = window.__c2, C = ui.C, hq = C.hq || C.def.start.hq; const from = C.neighbors(hq).find(n => C.owner[n] === 'enemy') || C.def.aor.cells.find(c => C.owner[c.id] === 'enemy').id; for (const f of C.forcesAt(hq)) { /* leave them: they must fall back */ } C.pendingAttacks.push({ id: 'eaHQ', from, to: hq, strength: 3 }); C.battle = { mode: 'defend', cell: hq, attack: 'eaHQ', from }; C.applyResult({ sector: hq, mode: 'defend', win: false, units: [], enemyKia: 1, enemyVehLost: 0, objectivesHeld: 0 }); ui.afterBattle(null); return { old: hq, now: C.hq, owner: C.owner[C.hq], delivery: C.deliveryCell() }; });
  ok(r.now !== r.old && r.owner === 'player', `HQ displaced ${JSON.stringify(r)}`); lostHq = true;
  await closeModals(); await check('after HQ lost'); await shot('09_hq_lost');
}
// ================================================================ 8. theatre view: labels and the left panel
await page.click('.c2-views button:has-text("Whole front")'); await page.waitForTimeout(500); await page.waitForFunction(() => !window.__c2.map.flying, null, { timeout: 60000 }); await page.waitForTimeout(800);
{
  const r = await page.evaluate(() => { const L = [...document.querySelectorAll('.c2-tl')].filter(e => e.style.display !== 'none' && getComputedStyle(e).visibility !== 'hidden').map(e => e.getBoundingClientRect()); let ov = 0; for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) { const a = L[i], b = L[j]; if (a.width && b.width && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) ov++; } const pane = document.querySelector('.c2-pane'), first = pane?.firstElementChild?.getBoundingClientRect(), pr = pane?.getBoundingClientRect(); return { labels: L.length, overlaps: ov, gap: first && pr ? Math.round(first.top - pr.top) : null }; });
  ok(r.overlaps <= 2, `theatre labels overlapping: ${JSON.stringify(r)}`); ok(r.gap == null || r.gap < 30, `left panel top gap ${r.gap}px`);
  await shot('10_theatre');
}
// ================================================================ 9. the end of the campaign
{
  const r = await page.evaluate(() => { const ui = window.__c2, C = ui.C; let n = 0; while (!C.outcome() && n < 80) { C.pendingAttacks = []; C.endTurn(); n++; } ui.map.setDate(C.date, false); ui.map.refresh(); ui.render(); ui.checkOutcome(); return { n, o: C.outcome(), date: C.date, final: C.finalResult, dirs: C.directives.length }; });
  console.log('end:', JSON.stringify(r).slice(0, 300));
  ok(r.o, 'campaign reaches an outcome'); ok(await page.$('.c2-modal'), 'outcome modal');
  await shot('11_end');
  await closeModals('Look at the map'); await page.click('.c2-end'); await page.waitForTimeout(200);
  ok(await page.$('.c2-modal'), 'END WEEK after the end shows the outcome again');
  await closeModals('Look at the map'); await check('after the end');
}
console.log(`\nweeks played, ${battlesFought} attacks, ${defended} defences, ${reloads} reloads, HQ lost: ${lostHq}`);
ok(defended > 0, `a defence was fought (${defended})`);
ok(!errors.length, `page errors: ${errors.slice(0, 4).join(' | ')}`);
console.log(`\n${pass} passed, ${fail} failed`); if (issues.length) console.log('ISSUES:\n - ' + issues.join('\n - '));
await browser.close(); server.close(); process.exit(fail ? 1 : 0);
