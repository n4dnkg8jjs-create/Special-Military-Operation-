// Contact sheet for previews/campaign_v3/ (tour steps, hunt screenshots, fixes before / after, versus screens).
// usage: node src/campaign/v2/tools/previews_index.mjs
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../previews/campaign_v3');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
const groups = [['tour_', 'Guided tour (coach marks over the live command screen)'], ['fix_', 'Fixes — before / after'], ['vs_', 'Versus on the v2 grid (two players)'], ['hunt_', 'Bug hunt run (real mouse / keyboard play)'], ['', 'Other']];
const used = new Set(); let html = `<!DOCTYPE html><meta charset="utf-8"><title>Campaign v3 previews</title><style>body{background:#0c110f;color:#dfe4d6;font:15px/1.4 system-ui,sans-serif;margin:24px}h1{font-weight:800;letter-spacing:.04em}h2{color:#e9a93b;font-size:14px;letter-spacing:.2em;text-transform:uppercase;margin:32px 0 10px}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:14px}figure{margin:0;background:#151b18;border:1px solid rgba(196,212,192,.13)}img{width:100%;display:block}figcaption{padding:6px 9px;font-size:13px;color:#98a395}</style><h1>Campaign v3 — previews</h1>`;
for (const [p, title] of groups) {
  const list = files.filter(f => f.startsWith(p) && !used.has(f)); if (!list.length) continue;
  html += `<h2>${title}</h2><div class="g">` + list.map(f => { used.add(f); return `<figure><a href="${f}"><img src="${f}" loading="lazy"></a><figcaption>${f.replace(/\.png$/, '').replace(/_/g, ' ')}</figcaption></figure>`; }).join('') + '</div>';
}
fs.writeFileSync(path.join(dir, 'index.html'), html); console.log('wrote', path.join(dir, 'index.html'), files.length, 'images');
