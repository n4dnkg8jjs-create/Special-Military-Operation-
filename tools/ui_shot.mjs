// Headless UI screenshot at a chosen viewport (for HUD / menu reviews).
// Usage: node tools/ui_shot.mjs "<page:/index.html?...>" out.png [WxH] [js-to-eval-after-done] [waitMs] [dpr]
//   e.g. node tools/ui_shot.mjs "page:/index.html" previews/ui_v2/menu_1280.png 1280x720
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.ktx2': 'application/octet-stream', '.bin': 'application/octet-stream', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const [target, out, size = '1280x720', js = '', waitMs = '300', dpr = '1'] = process.argv.slice(2);
const [width, height] = size.split('x').map(Number);
const url = `http://localhost:${port}${target.replace(/^page:/, '')}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: +dpr });
page.on('console', m => { if (/404|GPU stall|GroupMarkerNotSet/.test(m.text())) return; if (m.type() === 'error' || process.env.VERBOSE) console.log('[page]', m.type(), m.text()); });
page.on('pageerror', e => console.log('[pageerror]', e.stack || e.message));
await page.goto(url);
try { await page.waitForFunction('window.__done === true', null, { timeout: 900000 }); } catch (e) { console.log('timeout waiting for __done'); }
if (js) { const r = await page.evaluate(js); if (r !== undefined) console.log('eval:', JSON.stringify(r)); }
if (+waitMs) await page.waitForTimeout(+waitMs);
await page.evaluate(() => document.fonts?.ready);
// sim-mode pages stop their loop after one frame; redraw so the WebGL buffer is fresh for the capture
await page.evaluate(() => { const g = window.game; if (g?.renderer && Q_SIM()) { g.frame(0.0001); g.renderer.render(0.016, g.time); } function Q_SIM() { return new URLSearchParams(location.search).has('sim'); } });
await page.screenshot({ path: out, timeout: 600000 });
await browser.close(); server.close();
