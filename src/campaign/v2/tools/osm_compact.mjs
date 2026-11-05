// Compacts the raw OSM extracts (assets/campaign/osm/<side>/*.json) into one small file per side for the strategic
// 3D map: building footprints as oriented boxes, streets, main roads, rivers, rail, woods and tree rows.
// usage: node src/campaign/v2/tools/osm_compact.mjs UA|RU   -> src/campaign/v2/data/osm_<side>.json
//        node src/campaign/v2/tools/osm_compact.mjs UA --ext /tmp/osmv2/UAX   -> src/campaign/v2/data/osm_<side>_ext.json
//        (campaign v5 grid extension: the OSM API map tiles of the extension; features inside the main file's
//        sector patches are skipped so nothing is drawn twice)
//        --tiles /tmp/osmv2/UA   (campaign v6) also every building footprint of the grid's OSM API map tiles (the sector
//        patches only cover parts of the grid); --skipbox latS,lonW,latN,lonE: no buildings centred inside (the main grid,
//        for the extension file). Everything but the buildings is drawn from the aor geo (geo_v6.py).
// Data © OpenStreetMap contributors (ODbL).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const side = process.argv[2] || 'UA';
const extDir = process.argv.includes('--ext') ? process.argv[process.argv.indexOf('--ext') + 1] : null;
const dir = extDir || path.join(root, 'assets/campaign/osm', side);
const out = path.join(here, '../data', extDir ? `osm_${side}_ext.json` : `osm_${side}.json`);
const skip = extDir ? JSON.parse(fs.readFileSync(path.join(here, '../data', `osm_${side}.json`), 'utf8')).patches : [];
const inSkip = p => p && skip.some(([a, b, c, d]) => p[0] >= a && p[0] <= c && p[1] >= b && p[1] <= d);
const relSeen = new Set();
const tilesDir = process.argv.includes('--tiles') ? process.argv[process.argv.indexOf('--tiles') + 1] : null;
const skipBox = process.argv.includes('--skipbox') ? process.argv[process.argv.indexOf('--skipbox') + 1].split(',').map(Number) : null;

const nodes = new Map(), ways = new Map(), rels = [];
const patches = [];
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  if (!d || !Array.isArray(d.elements)) continue;
  if (f.startsWith('sector_') && d.bounds) patches.push([d.bounds.minlat, d.bounds.minlon, d.bounds.maxlat, d.bounds.maxlon].map(v => +v.toFixed(5)));
  for (const e of d.elements) {
    if (e.type === 'node') nodes.set(e.id, [e.lat, e.lon]);
    else if (e.type === 'way') ways.set(e.id, e);
    else if (e.type === 'relation') { if (!relSeen.has(e.id)) { relSeen.add(e.id); rels.push(e); } }
  }
}
// v6: building footprints of the whole grid from the map tiles (deduplicated by way id with the sector patches)
const tileB = new Set();
if (tilesDir) for (const f of fs.readdirSync(tilesDir).filter(f => f.endsWith('.json'))) {
  let d; try { d = JSON.parse(fs.readFileSync(path.join(tilesDir, f), 'utf8')); } catch { continue; }
  for (const e of d.elements || []) {
    if (e.type === 'node') { if (!nodes.has(e.id)) nodes.set(e.id, [e.lat, e.lon]); }
    else if (e.type === 'way' && e.tags?.building && !ways.has(e.id)) { ways.set(e.id, e); tileB.add(e.id); }
  }
}
const lat0 = [...nodes.values()].reduce((a, n) => a + n[0], 0) / Math.max(1, nodes.size);
const KX = 111320 * Math.cos(lat0 * Math.PI / 180), KY = 110570;   // metres per degree
const pts = w => w.nodes.map(i => nodes.get(i)).filter(Boolean);
const r5 = v => +v.toFixed(5);
// Douglas-Peucker in metres
function simplify(p, tol) {
  if (p.length < 3) return p;
  const m = p.map(([la, lo]) => [lo * KX, la * KY]);
  const keep = new Uint8Array(p.length); keep[0] = keep[p.length - 1] = 1;
  const st = [[0, p.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let dm = -1, k = -1;
    const [ax, ay] = m[a], [bx, by] = m[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * m[i][0] - dx * m[i][1] + bx * ay - by * ax) / L; if (d > dm) { dm = d; k = i; } }
    if (dm > tol) { keep[k] = 1; st.push([a, k], [k, b]); }
  }
  return p.filter((_, i) => keep[i]);
}
// minimum-area oriented rectangle of a footprint -> [lat, lon, w, d, angle, h]
function obb(p, tags) {
  const m = p.map(([la, lo]) => [lo * KX, la * KY]);
  let best = null;
  for (let i = 0; i < m.length - 1; i++) {
    const ex = m[i + 1][0] - m[i][0], ey = m[i + 1][1] - m[i][1], L = Math.hypot(ex, ey); if (L < 0.5) continue;
    const ux = ex / L, uy = ey / L; let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
    for (const [x, y] of m) { const a = x * ux + y * uy, b = -x * uy + y * ux; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) best = { area, ux, uy, a: (a0 + a1) / 2, b: (b0 + b1) / 2, w: a1 - a0, d: b1 - b0 };
  }
  if (!best || best.w < 2 || best.d < 2) return null;
  const cx = best.a * best.ux - best.b * best.uy, cy = best.a * best.uy + best.b * best.ux;
  const lv = parseFloat(tags['building:levels']) || 0, bt = tags.building;
  const h = lv ? lv * 3 + 1.5 : (['apartments', 'school', 'hospital', 'public', 'commercial', 'office'].includes(bt) ? 12 : ['industrial', 'warehouse', 'hangar', 'farm_auxiliary', 'barn', 'cowshed', 'greenhouse'].includes(bt) ? 7 : bt === 'garage' || bt === 'garages' || bt === 'shed' ? 3 : 5);
  const kind = ['industrial', 'warehouse', 'hangar', 'farm_auxiliary', 'barn', 'cowshed'].includes(bt) || best.area > 900 ? 2 : (lv >= 3 || ['apartments'].includes(bt)) ? 1 : 0;   // 0 house, 1 block, 2 shed/industrial
  return [r5(cy / KY), r5(cx / KX), +best.w.toFixed(1), +best.d.toFixed(1), +Math.atan2(best.uy, best.ux).toFixed(3), +h.toFixed(1), kind];
}
const STREET = { residential: 1, unclassified: 1, service: 0, living_street: 1, tertiary: 2, secondary: 3, primary: 3, trunk: 3, track: 0 };
const res = { side, attribution: '© OpenStreetMap contributors (ODbL)', patches, buildings: [], streets: [], roads: [], rivers: [], rail: [], woods: [], treeRows: [], water: [] };
const usedInRoute = new Set();
for (const r of rels) {
  const t = r.tags || {};
  const members = (r.members || []).filter(m => m.type === 'way').map(m => ways.get(m.ref)).filter(Boolean);
  if (t.route === 'road') for (const w of members) { usedInRoute.add(w.id); const p = simplify(pts(w), 8); if (p.length > 1) res.roads.push({ ref: t.ref || '', k: /^[МН]-|^[MH]-|^М|^Н/.test(t.ref || '') ? 3 : 2, p: p.map(q => q.map(r5)) }); }
  if (t.waterway === 'river' || t.waterway === 'stream' || t.type === 'waterway') for (const w of members) { usedInRoute.add(w.id); const p = simplify(pts(w), 10); if (p.length > 1) res.rivers.push({ name: t['name:en'] || t.name || '', p: p.map(q => q.map(r5)) }); }
  if (t.route === 'railway' || t.route === 'train') for (const w of members) { usedInRoute.add(w.id); const p = simplify(pts(w), 10); if (p.length > 1) res.rail.push(p.map(q => q.map(r5))); }
}
for (const w of ways.values()) {
  const t = w.tags || {}; if (usedInRoute.has(w.id)) continue;
  const p = pts(w); if (p.length < 2) continue;
  if (extDir && (t.building || (t.highway && STREET[t.highway] != null)) && inSkip(p[0])) continue;
  if (t.building) { const b = obb(p, t); if (b && !(skipBox && b[0] >= skipBox[0] && b[0] <= skipBox[2] && b[1] >= skipBox[1] && b[1] <= skipBox[3])) res.buildings.push(b); continue; }
  if (tileB.has(w.id)) continue;
  if (t.highway && STREET[t.highway] != null) { const q = simplify(p, 3); res.streets.push({ k: STREET[t.highway], p: q.map(v => v.map(r5)) }); continue; }
  if (t.railway === 'rail') { res.rail.push(simplify(p, 5).map(v => v.map(r5))); continue; }
  if (t.waterway) { res.rivers.push({ name: t['name:en'] || t.name || '', p: simplify(p, 6).map(v => v.map(r5)), small: t.waterway !== 'river' }); continue; }
  if (t.natural === 'tree_row') { res.treeRows.push(simplify(p, 4).map(v => v.map(r5))); continue; }
  if (t.natural === 'wood' || t.landuse === 'forest') { res.woods.push(simplify(p, 4).map(v => v.map(r5))); continue; }
  if (t.natural === 'water' || t.landuse === 'reservoir') { res.water.push(simplify(p, 4).map(v => v.map(r5))); continue; }
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(res));
console.log(out, (fs.statSync(out).size / 1024).toFixed(0) + ' KB', Object.fromEntries(Object.entries(res).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])));
