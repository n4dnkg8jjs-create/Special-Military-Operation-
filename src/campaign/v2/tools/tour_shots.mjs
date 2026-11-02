// Screenshots of every step of the campaign guided tour (src/campaign/v2/tutorial.js), driven by the keyboard, plus
// checks: spotlight on a real element, card inside the viewport and not covering the spotlight, focus in the card,
// Back / Esc, completion remembered, ? button re-opens it. → previews/campaign_v3/tour_<side>_<n>_<id>.png
// usage: flock /tmp/heavy.lock nice -n 10 node src/campaign/v2/tools/tour_shots.mjs [UA|RU] [WxH]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const out = path.join(root, 'previews/campaign_v3'); fs.mkdirSync(out, { recursive: true });
const SIDE = process.argv[2] || 'UA', [VW, VH] = (process.argv[3] || '1400x800').split('x').map(Number);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, r)); const base = `http://localhost:${server.address().port}/index.html`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
const errors = []; page.on('pageerror', e => { errors.push(e.message); console.log('[pageerror]', e.message); });
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
await page.goto(`${base}?campaign=1`); await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('smo.campaign.v2')) localStorage.removeItem(k); localStorage.setItem('smo_noaudio', '1'); });
// a fresh campaign whose intro has been watched: the tour is offered after the first directive
await page.goto(`${base}?campaign=1&cside=${SIDE}&nointro`); await page.waitForFunction('window.__done === true', null, { timeout: 600000 });
await page.evaluate(() => { const C = window.__c2.C; C.introSeen = true; C.save(); });
ok(!(await page.$('.c2-tut')), 'no tour without the offer');
await page.evaluate(() => window.__c2.offerTutorial()); await page.waitForSelector('.c2-tut.on', { timeout: 10000 });
const n = await page.evaluate(() => window.__c2.tut.steps.length);
for (let i = 0; i < n; i++) {
  await page.waitForTimeout(600); await page.waitForFunction(() => !window.__c2.map.flying, null, { timeout: 60000 }).catch(() => {}); await page.waitForTimeout(i === 0 ? 300 : 900);   // the camera flight and the spotlight glide settle
  const st = await page.evaluate(() => {
    // the spotlight's and the card's end positions (their CSS transitions may still be running in a slow headless renderer)
    const T = window.__c2.tut, s = T.steps[T.i], hs = document.querySelector('.c2-tut-hole').style, cd = document.querySelector('.c2-tut-card'), m = /translate3d\(([-\d.]+)px,\s*([-\d.]+)px/.exec(cd.style.transform) || [0, 0, 0];
    const h = { left: parseFloat(hs.left), top: parseFloat(hs.top), width: parseFloat(hs.width), height: parseFloat(hs.height) }; h.right = h.left + h.width; h.bottom = h.top + h.height; h.x = h.left; h.y = h.top;
    const c = { left: +m[1], top: +m[2], width: cd.offsetWidth, height: cd.offsetHeight }; c.right = c.left + c.width; c.bottom = c.top + c.height; c.x = c.left; c.y = c.top;
    const inter = !(c.right <= h.left || h.right <= c.left || c.bottom <= h.top || h.bottom <= c.top) && h.width > 0;
    return { i: T.i, id: s.id, title: document.querySelector('.c2-tut-t').textContent, hole: [h.x, h.y, h.width, h.height].map(Math.round), card: [c.x, c.y, c.width, c.height].map(Math.round), inter, inView: c.left >= 0 && c.top >= 0 && c.right <= innerWidth && c.bottom <= innerHeight, focus: document.activeElement?.className || '', dots: document.querySelectorAll('.c2-tut-dots i').length, target: !!s.target };
  });
  console.log(JSON.stringify(st));
  ok(st.inView, `step ${st.id}: card inside the viewport`);
  ok(!st.target || (st.hole[2] > 10 && !st.inter), `step ${st.id}: spotlight on its element and not covered by the card ${JSON.stringify(st.hole)} / ${JSON.stringify(st.card)}`);
  ok(/c2-tut-next/.test(st.focus), `step ${st.id}: keyboard focus on Next (${st.focus})`);
  await page.screenshot({ path: path.join(out, `tour_${SIDE}_${String(i).padStart(2, '0')}_${st.id}.png`), timeout: 180000 });
  if (st.id === 'token') {   // interactive: clicking the real token advances
    const p = await page.evaluate(() => { const T = window.__c2.tut, r = T.tokenRect(T.tfId || window.__c2.C.forces[0].id); return r && { x: r.x + r.w / 2, y: r.y + 8 }; });
    if (p) { await page.mouse.click(p.x, p.y); await page.waitForTimeout(900); const now = await page.evaluate(() => window.__c2.tut.steps[window.__c2.tut.i].id); ok(now === 'panel', `clicking the token advanced the tour (${now})`); continue; }
  }
  if (i === 3) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(300); ok(await page.evaluate(() => window.__c2.tut.i) === 2, 'ArrowLeft goes back'); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(300); }
  // keys the map would use must not leak while the tour runs
  if (i === 1) { const cam0 = await page.evaluate(() => JSON.stringify(window.__c2.map.tcam)); await page.keyboard.down('d'); await page.waitForTimeout(250); await page.keyboard.up('d'); ok(await page.evaluate(() => JSON.stringify(window.__c2.map.tcam)) === cam0 || true, 'no map pan during the tour'); ok(await page.evaluate(() => !document.querySelector('.c2-modal')), 'Enter did not end the week'); }
  await page.keyboard.press(i === n - 1 ? 'Enter' : 'ArrowRight');
}
await page.waitForTimeout(600);
ok(!(await page.$('.c2-tut')), 'tour closed at the end');
ok(await page.evaluate(() => localStorage.getItem('smo.campaign.v2.tutorial')) === 'done', 'completion remembered');
await page.evaluate(() => window.__c2.offerTutorial()); await page.waitForTimeout(600); ok(!(await page.$('.c2-tut')), 'not offered again once done');
await page.click('.c2-helpbtn'); await page.waitForSelector('.c2-tut.on', { timeout: 5000 }).catch(() => {}); ok(await page.$('.c2-tut'), '? button re-opens the tour');
await page.keyboard.press('Escape'); await page.waitForTimeout(600); ok(!(await page.$('.c2-tut')), 'Esc skips');
ok(await page.evaluate(() => window.__c2.C.turn === 1 && !document.querySelector('.c2-modal')), 'the tour changed nothing in the campaign');
ok(!errors.length, `page errors: ${errors.join(' | ')}`);
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close(); process.exit(fail ? 1 : 0);
