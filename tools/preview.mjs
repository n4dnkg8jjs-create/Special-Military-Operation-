// Headless screenshot of a GLB asset or a game page.
// Usage: node tools/preview.mjs <glb path rel to repo | page:/index.html?x> <out.png> [query e.g. "views=4&anim=walk&t=0.4"] [waitMs]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.json':'application/json', '.glb':'model/gltf-binary', '.png':'image/png', '.jpg':'image/jpeg', '.ktx2':'application/octet-stream', '.bin':'application/octet-stream', '.wasm':'application/wasm' , '.css':'text/css'};
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const [target, out, extra = '', waitMs = '0'] = process.argv.slice(2);
const url = target.startsWith('page:') ? `http://localhost:${port}${target.slice(5)}`
  : `http://localhost:${port}/tools/preview.html?glb=/${target}&${extra}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
page.on('console', m => { if (/404|GPU stall|GroupMarkerNotSet/.test(m.text())) return; if (m.type() === 'error' || m.type() === 'warning' || process.env.VERBOSE) console.log('[page]', m.type(), m.text()); });
page.on('pageerror', e => console.log('[pageerror]', e.stack || e.message));
await page.goto(url);
try { await page.waitForFunction('window.__done === true', null, { timeout: 900000 }); } catch (e) { console.log('timeout waiting for __done'); }
if (+waitMs) await page.waitForTimeout(+waitMs);
await page.screenshot({ path: out, timeout: 600000 });
console.log(JSON.stringify(await page.evaluate('window.__info || null')));
if (process.env.BR) console.log(JSON.stringify(await page.evaluate('window.__br || null')));
await browser.close(); server.close();
