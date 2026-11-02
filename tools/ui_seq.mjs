// Headless UI screenshot sequence: load a page once, then run steps (eval → wait → screenshot).
// Usage: node tools/ui_seq.mjs "<page:/index.html?...>" WxH steps.json
//   steps.json: [{ "js": "game.startBattle()", "wait": 8000, "out": "previews/ui_v2/after/battle_1280.png" }, ...]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.ktx2': 'application/octet-stream', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r));
const [target, size = '1280x720', stepsFile] = process.argv.slice(2);
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
const [width, height] = size.split('x').map(Number);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width, height } });
page.on('console', m => { if (/404|GPU stall|GroupMarkerNotSet/.test(m.text())) return; if (m.type() === 'error') console.log('[page]', m.type(), m.text()); });
page.on('pageerror', e => console.log('[pageerror]', e.stack || e.message));
await page.goto(`http://localhost:${server.address().port}${target.replace(/^page:/, '')}`);
try { await page.waitForFunction('window.__done === true', null, { timeout: 900000 }); } catch (e) { console.log('timeout waiting for __done'); }
for (const s of steps) {
  if (s.js) { const r = await page.evaluate(s.js); if (r !== undefined) console.log('eval:', JSON.stringify(r)); }
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.out) { await page.evaluate(() => document.fonts?.ready); await page.screenshot({ path: s.out, timeout: 600000 }); console.log('shot', s.out); }
}
await browser.close(); server.close();
