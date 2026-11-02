// preview.mjs -> previews/campaign_v2/*.svg : AOR grids (UA, RU) and the theatre with front lines for three dates.
// usage (repo root): node assets/campaign/osm/tools/v2/preview.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../../..');
const { CAMPAIGNS2 } = await import(path.join(root, 'src/campaign/v2/content_index.js'));
const out = path.join(root, 'previews/campaign_v2'); fs.mkdirSync(out, { recursive: true });
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TER = { fields: '#d9d2a6', forest: '#7f9a62', urban: '#a7a29a', industrial: '#8f8a86', village: '#cbbf9a', water: '#7fa7c9', heights: '#c7b07a', balka: '#b9c08c' };
const OWN = { player: '#2f6fd6', enemy: '#c8392f', contested: '#b07fd0' };

function aorSvg(def) {
  const A = def.aor, [latS, lonW, latN, lonE] = A.bbox, CS = 64, PAD = 40, W = A.cols * CS + PAD * 2 + 300, H = A.rows * CS + PAD * 2 + 30;
  const X = lon => PAD + (lon - lonW) / (lonE - lonW) * A.cols * CS, Y = lat => PAD + 30 + (latN - lat) / (latN - latS) * A.rows * CS;
  const geo = JSON.parse(fs.readFileSync(path.join(root, A.geo), 'utf8')).geo;
  const pl = pts => pts.map(p => `${X(p[1]).toFixed(1)},${Y(p[0]).toFixed(1)}`).join(' ');
  const s = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Barlow Semi Condensed, Arial, sans-serif">`,
    `<rect width="${W}" height="${H}" fill="#f4f1e8"/>`,
    `<text x="${PAD}" y="${PAD + 4}" font-size="20" font-weight="700" fill="#222">${esc(def.title)} — AOR ${esc(A.name)} (${A.cols}×${A.rows} cells of ${A.cellKm} km, start ${def.start.date})</text>`];
  // cells: terrain fill
  for (const c of A.cells) s.push(`<rect x="${PAD + c.col * CS}" y="${PAD + 30 + c.row * CS}" width="${CS}" height="${CS}" fill="${TER[c.terrain]}"/>`);
  // OSM geometry
  for (const w of geo.woods) if (w.length > 2) s.push(`<polygon points="${pl(w)}" fill="#5f7f45" fill-opacity="0.55"/>`);
  for (const b of geo.built) if (b.length > 2) s.push(`<polygon points="${pl(b)}" fill="#6d6a66" fill-opacity="0.55"/>`);
  for (const w of geo.water) if (w.length > 2) s.push(`<polygon points="${pl(w)}" fill="#5d8fbf"/>`);
  for (const r of geo.streams) s.push(`<polyline points="${pl(r.pts)}" fill="none" stroke="#6f9cc6" stroke-width="0.8"/>`);
  for (const r of geo.rivers) s.push(`<polyline points="${pl(r.pts)}" fill="none" stroke="#3f78b5" stroke-width="2.4"/>`);
  for (const r of geo.rail) s.push(`<polyline points="${pl(r.pts)}" fill="none" stroke="#333" stroke-width="1.2" stroke-dasharray="5 3"/>`);
  for (const r of geo.minor) s.push(`<polyline points="${pl(r.pts)}" fill="none" stroke="#8b7a5a" stroke-width="0.7"/>`);
  for (const r of geo.roads) s.push(`<polyline points="${pl(r.pts)}" fill="none" stroke="${r.kind === 'highway' ? '#e0a020' : '#f2e2a0'}" stroke-width="${r.kind === 'highway' ? 3 : 1.8}" stroke-linecap="round"/>`);
  for (const r of geo.forts) s.push(`<polyline points="${pl(r.pts)}" fill="none" stroke="#5a1a10" stroke-width="1.6"/>`);
  for (const b of geo.bunkers) s.push(`<circle cx="${X(b[1]).toFixed(1)}" cy="${Y(b[0]).toFixed(1)}" r="1.4" fill="#5a1a10"/>`);
  // owner overlay + fort + grid
  for (const c of A.cells) {
    const x = PAD + c.col * CS, y = PAD + 30 + c.row * CS;
    s.push(`<rect x="${x}" y="${y}" width="${CS}" height="${CS}" fill="${OWN[c.owner]}" fill-opacity="${c.owner === 'player' ? 0.18 : 0.22}" stroke="#333" stroke-opacity="0.35" stroke-width="0.6"/>`);
    for (let k = 0; k < c.fort; k++) s.push(`<rect x="${x + 4 + k * 7}" y="${y + CS - 9}" width="5" height="5" fill="${c.owner === 'player' ? '#1d3f80' : '#7a1d16'}"/>`);
    if (c.owner === 'enemy' && c.garrison) s.push(`<text x="${x + CS - 4}" y="${y + CS - 4}" font-size="9" text-anchor="end" fill="#7a1d16">g${c.garrison}</text>`);
    if (c.river) s.push(`<text x="${x + CS - 4}" y="${y + 10}" font-size="9" text-anchor="end" fill="#1f4f8a">${c.bridge ? '≈b' : '≈'}</text>`);
    s.push(`<text x="${x + 3}" y="${y + 10}" font-size="8" fill="#333" fill-opacity="0.7">${String.fromCharCode(65 + c.col)}${c.row + 1}</text>`);
  }
  // front line between player and non-player cells (cell edges)
  const own = id => A.cells.find(c => c.id === id)?.owner === 'player';
  for (const c of A.cells) {
    const x = PAD + c.col * CS, y = PAD + 30 + c.row * CS, me = c.owner === 'player';
    const r = A.cells.find(o => o.col === c.col + 1 && o.row === c.row), d = A.cells.find(o => o.col === c.col && o.row === c.row + 1);
    if (r && (r.owner === 'player') !== me) s.push(`<line x1="${x + CS}" y1="${y}" x2="${x + CS}" y2="${y + CS}" stroke="#111" stroke-width="3"/>`);
    if (d && (d.owner === 'player') !== me) s.push(`<line x1="${x}" y1="${y + CS}" x2="${x + CS}" y2="${y + CS}" stroke="#111" stroke-width="3"/>`);
  }
  // settlements, objectives, names
  for (const c of A.cells) {
    const x = PAD + c.col * CS, y = PAD + 30 + c.row * CS;
    if (c.settlement) { const [la, lo] = c.settlement.latlon; s.push(`<circle cx="${X(lo).toFixed(1)}" cy="${Y(la).toFixed(1)}" r="${2 + c.settlement.size * 1.4}" fill="#fff" stroke="#222" stroke-width="1.2"/>`); }
    if (c.name) s.push(`<text x="${x + CS / 2}" y="${y + CS / 2 + 14}" font-size="10" font-weight="600" text-anchor="middle" fill="#111" stroke="#f4f1e8" stroke-width="2.5" paint-order="stroke">${esc(c.name.length > 16 ? c.name.slice(0, 15) + '…' : c.name)}</text>`);
    if (c.objective) s.push(`<circle cx="${x + CS - 12}" cy="${y + 22}" r="8" fill="#ffd400" stroke="#222"/><text x="${x + CS - 12}" y="${y + 26}" font-size="11" font-weight="700" text-anchor="middle">${c.objective}</text>`);
  }
  // supply, HQ, task forces
  for (const id of A.supplySources) { const c = A.cells.find(o => o.id === id); s.push(`<rect x="${PAD + c.col * CS + 3}" y="${PAD + 30 + c.row * CS + 14}" width="18" height="12" fill="#2a9d4b" stroke="#111"/><text x="${PAD + c.col * CS + 12}" y="${PAD + 30 + c.row * CS + 23}" font-size="8" text-anchor="middle" fill="#fff">SUP</text>`); }
  { const c = A.cells.find(o => o.id === def.start.hq); s.push(`<rect x="${PAD + c.col * CS + 3}" y="${PAD + 30 + c.row * CS + 28}" width="18" height="12" fill="#111"/><text x="${PAD + c.col * CS + 12}" y="${PAD + 30 + c.row * CS + 37}" font-size="8" text-anchor="middle" fill="#fff">HQ</text>`); }
  def.start.forces.forEach((f, i) => { const c = A.cells.find(o => o.id === f.cell); const cx = PAD + c.col * CS + CS / 2, cy = PAD + 30 + c.row * CS + 22; s.push(`<rect x="${cx - 14}" y="${cy - 9}" width="28" height="18" fill="${OWN.player}" stroke="#fff" stroke-width="1.5"/><text x="${cx}" y="${cy + 4}" font-size="10" font-weight="700" text-anchor="middle" fill="#fff">TF${i + 1}</text>`); });
  // legend
  const lx = PAD + A.cols * CS + 20; let ly = PAD + 40;
  const leg = (col, txt, op = 1) => { s.push(`<rect x="${lx}" y="${ly - 10}" width="14" height="12" fill="${col}" fill-opacity="${op}" stroke="#333" stroke-width="0.5"/><text x="${lx + 20}" y="${ly}" font-size="12">${esc(txt)}</text>`); ly += 18; };
  s.push(`<text x="${lx}" y="${ly}" font-size="13" font-weight="700">Legend</text>`); ly += 20;
  leg(OWN.player, `own (${def.id === 'UA' ? 'Ukrainian' : 'Russian'}) cell`, 0.5); leg(OWN.enemy, 'enemy cell', 0.5); leg(OWN.contested, 'contested cell', 0.5);
  for (const [k, v] of Object.entries(TER)) leg(v, `terrain: ${k}`);
  s.push(`<text x="${lx}" y="${ly}" font-size="12">■■■ fort level 0–3; g = enemy garrison</text>`); ly += 18;
  s.push(`<text x="${lx}" y="${ly}" font-size="12">≈ river cell, ≈b bridged</text>`); ly += 18;
  s.push(`<text x="${lx}" y="${ly}" font-size="12">thick black: line on ${def.start.date}</text>`); ly += 18;
  s.push(`<text x="${lx}" y="${ly}" font-size="12" fill="#5a1a10">dark red lines/dots: OSM ditches, trenches, bunkers</text>`); ly += 18;
  s.push(`<text x="${lx}" y="${ly}" font-size="12">orange/yellow: highways/roads (OSM)</text>`); ly += 26;
  s.push(`<text x="${lx}" y="${ly}" font-size="13" font-weight="700">Task forces</text>`); ly += 18;
  def.start.forces.forEach((f, i) => { s.push(`<text x="${lx}" y="${ly}" font-size="12">TF${i + 1} ${esc(f.name)} — ${f.units.length} units</text>`); ly += 16; });
  ly += 10; s.push(`<text x="${lx}" y="${ly}" font-size="13" font-weight="700">Objectives</text>`); ly += 18;
  for (const c of A.cells.filter(c => c.objective).sort((a, b) => a.objective.localeCompare(b.objective))) { s.push(`<text x="${lx}" y="${ly}" font-size="12">${c.objective} — ${esc(c.name || c.id)}</text>`); ly += 16; }
  ly += 10; s.push(`<text x="${lx}" y="${ly}" font-size="10" fill="#555">Map data © OpenStreetMap contributors (ODbL)</text>`);
  s.push('</svg>');
  return s.join('\n');
}

function theatreSvg(def, dates, bbox = null, SC = 210) {
  const T = def.theatre, [latS, lonW, latN, lonE] = bbox || T.bbox, k = Math.cos((latS + latN) / 2 * Math.PI / 180), PAD = 30;
  const W = Math.round((lonE - lonW) * k * SC + PAD * 2), H = Math.round((latN - latS) * SC + PAD * 2 + 30);
  const X = lon => PAD + (lon - lonW) * k * SC, Y = lat => PAD + 30 + (latN - lat) * SC;
  const pl = pts => pts.map(p => `${X(p[1]).toFixed(1)},${Y(p[0]).toFixed(1)}`).join(' ');
  const COL = ['#1f5fbf', '#e08a00', '#c8392f'];
  const s = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Barlow Semi Condensed, Arial, sans-serif">`,
    `<rect width="${W}" height="${H}" fill="#eef0ea"/>`,
    `<text x="${PAD}" y="${PAD + 4}" font-size="20" font-weight="700">Theatre: front line ${dates.join(' / ')} (approximate; ${T.fronts.length} dated snapshots Feb 2023 – Mar 2024)</text>`, `<clipPath id="cl"><rect x="${PAD}" y="${PAD + 30}" width="${W - 2 * PAD}" height="${H - 2 * PAD - 30}"/></clipPath>`, '<g clip-path="url(#cl)">'];
  for (const r of T.rivers) s.push(`<polyline points="${pl(r.pts)}" fill="none" stroke="#6f9fd0" stroke-width="${(r.w || 1) * 1.6}" stroke-linejoin="round"/>`);
  for (const d of Object.values(CAMPAIGNS2)) { const [a, b, c, e] = d.aor.bbox; s.push(`<rect x="${X(b)}" y="${Y(c)}" width="${X(e) - X(b)}" height="${Y(a) - Y(c)}" fill="none" stroke="#111" stroke-width="1.5" stroke-dasharray="4 2"/><text x="${X(e) + 4}" y="${Y(c) + 10}" font-size="11" font-weight="700">${d.id} AOR</text>`); }
  const at = date => { let f = null; for (const x of T.fronts) if (x.date <= date) f = x; return f; };
  dates.forEach((d, i) => { const f = at(d); s.push(`<polyline points="${pl(f.line)}" fill="none" stroke="${COL[i]}" stroke-width="${i === 0 ? 4 : 2.2}" stroke-opacity="0.9" stroke-linejoin="round"/>`); });
  for (const l of T.labels) {
    const x = X(l.latlon[1]), y = Y(l.latlon[0]);
    if (l.kind === 'city') s.push(`<circle cx="${x}" cy="${y}" r="2.5" fill="#222"/><text x="${x + 4}" y="${y - 3}" font-size="10" fill="#222">${esc(l.text)}</text>`);
    else if (l.kind === 'oblast') s.push(`<text x="${x}" y="${y}" font-size="13" fill="#999" letter-spacing="2" text-anchor="middle">${esc(l.text)}</text>`);
    else s.push(`<text x="${x}" y="${y}" font-size="11" fill="#3f78b5" font-style="italic">${esc(l.text)}</text>`);
  }
  for (const e of T.events) if (e.latlon && e.date <= dates[dates.length - 1]) s.push(`<circle cx="${X(e.latlon[1])}" cy="${Y(e.latlon[0])}" r="4" fill="none" stroke="#a0207a" stroke-width="1.5"/>`);
  s.push('</g>');
  let ly = H - 20 - dates.length * 18;
  dates.forEach((d, i) => { s.push(`<line x1="${PAD}" y1="${ly - 4}" x2="${PAD + 30}" y2="${ly - 4}" stroke="${COL[i]}" stroke-width="3"/><text x="${PAD + 36}" y="${ly}" font-size="13">front line ${d}</text>`); ly += 18; });
  s.push(`<text x="${W - PAD}" y="${H - 8}" font-size="10" text-anchor="end" fill="#555">purple rings: dated events with a location · settlement positions © OpenStreetMap contributors (ODbL)</text>`);
  s.push('</svg>');
  return s.join('\n');
}

const files = [];
for (const def of Object.values(CAMPAIGNS2)) { const f = path.join(out, `aor_${def.id}.svg`); fs.writeFileSync(f, aorSvg(def)); files.push(f); }
{ const f = path.join(out, 'theatre_fronts.svg'); fs.writeFileSync(f, theatreSvg(CAMPAIGNS2.UA, ['2023-02-06', '2023-09-25', '2024-03-01'])); files.push(f); }
{ const f = path.join(out, 'theatre_fronts_zoom.svg'); fs.writeFileSync(f, theatreSvg(CAMPAIGNS2.UA, ['2023-02-06', '2023-09-25', '2024-03-01'], [47.25, 35.4, 48.85, 38.4], 560)); files.push(f); }
console.log(files.join('\n'));
