// Campaign v7 (rules): a schematic of the enemy layout on the grid (no browser): ownership, fortifications, and what holds
// each enemy square — before (ROOT = a tree with the old rules: a garrison in every square) or after (battalion groups of
// companies, outposts, empty rear; with --weeks N the AI plays N weeks against a passive brigade and its moves are drawn).
// usage: node src/campaign/v2/tools/v7_layout_svg.mjs <tag> <UA|RU> [--root /tmp/v7r_oldtree] [--weeks 3]
//   -> previews/campaign_v7_rules/<tag>_<side>_layout.svg (+ .png via ImageMagick convert when available)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const argv = process.argv.slice(2), opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const tag = argv[0] || 'after', side = argv[1] || 'UA', root = opt('--root') || here, weeks = +(opt('--weeks') || 0);
const mem = {}; globalThis.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
const S = await import(path.join(root, 'src/campaign/v2/state.js'));
const { defs } = await (await import(path.join(root, 'src/campaign/v2/index.js'))).loadCampaigns();
let s = 31; S.setRandom(() => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; });
const C = new S.Campaign2(defs[side]);
for (let i = 0; i < weeks; i++) { C.pendingAttacks = []; C.endTurn(); }
const A = C.def.aor, col0 = Math.min(...A.cells.map(c => c.col)), row0 = Math.min(...A.cells.map(c => c.row));
const cols = Math.max(...A.cells.map(c => c.col)) - col0 + 1, rows = Math.max(...A.cells.map(c => c.row)) - row0 + 1;
const K = 46, W = cols * K + 300, H = Math.max(rows * K + 70, 420);
const X = c => (c.col - col0) * K + 10, Y = c => (c.row - row0) * K + 50;
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif"><rect width="100%" height="100%" fill="#1d2126"/>`];
out.push(`<text x="10" y="22" fill="#f2e6c4" font-size="15" font-weight="bold">${esc(`${side} campaign — enemy layout ${tag.toUpperCase()}${weeks ? ` (after ${weeks} weeks of the enemy commander)` : ' (start)'}`)}</text>`);
const v7 = !!C.eforces?.[0]?.coys;
for (const c of A.cells) {
  const o = C.owner[c.id], x = X(c), y = Y(c);
  out.push(`<rect x="${x}" y="${y}" width="${K - 2}" height="${K - 2}" fill="${o === 'player' ? '#2c4a6e' : o === 'contested' ? '#6e5a2c' : '#5a2f2b'}" stroke="#111" />`);
  if (c.settlement || ['urban', 'industrial'].includes(c.terrain)) out.push(`<rect x="${x + 2}" y="${y + 2}" width="6" height="6" fill="#bbb"/>`);
  const f = C.fort[c.id] || 0; for (let i = 0; i < f; i++) out.push(`<line x1="${x + 4}" y1="${y + K - 6 - i * 3}" x2="${x + K - 6}" y2="${y + K - 6 - i * 3}" stroke="#c9b37a" stroke-width="1" stroke-dasharray="3,2"/>`);
  if (o !== 'enemy') continue;
  if (!v7) { const g = C.garrison[c.id] || 0; out.push(`<text x="${x + K / 2 - 1}" y="${y + K / 2 + 5}" text-anchor="middle" fill="#f0a090" font-size="13" font-weight="bold">${['', 'I', 'I+', 'II'][Math.max(1, Math.min(3, Math.round(g)))]}</text>`); }
}
for (const g of C.def.goal?.cells || []) { const c = C.cell(g.cell); out.push(`<text x="${X(c) + K - 12}" y="${Y(c) + 13}" fill="#ffd34d" font-size="12">★</text>`); }
for (const f of C.forcesAt ? C.forces : []) { const c = C.cell(f.cell); out.push(`<rect x="${X(c) + 8}" y="${Y(c) + K - 18}" width="26" height="10" fill="#4f8fe0" stroke="#0d1520"/>`); }
// enemy task forces (ground truth: this is a debug view)
const by = {}; for (const f of C.eforces || []) (by[f.cell] ||= []).push(f);
for (const [cell, fs] of Object.entries(by)) fs.forEach((f, i) => {
  const c = C.cell(cell), x = X(c) + 5 + i * 9, y = Y(c) + 9 + i * 9, n = f.coys ? f.coys.length : Math.round(f.str * 3);
  const col = f.role === 'screen' ? '#e8a090' : f.role === 'reserve' ? '#c070e0' : f.role === 'rest' ? '#909090' : f.role === 'hold' ? '#ff7050' : '#e0503f';
  out.push(`<rect x="${x}" y="${y}" width="${f.role === 'screen' ? 14 : 30}" height="${f.role === 'screen' ? 10 : 16}" fill="${col}" stroke="#1a0c0a" stroke-width="1.2"/><text x="${x + (f.role === 'screen' ? 7 : 15)}" y="${y + (f.role === 'screen' ? 8 : 12)}" text-anchor="middle" font-size="${f.role === 'screen' ? 8 : 11}" fill="#1a0c0a" font-weight="bold">${n}</text>`);
});
for (const m of C.enemyMoves?.turn === C.turn ? C.enemyMoves.list : []) { const a = C.cell(m.from), b = C.cell(m.to); if (!a || !b) continue; out.push(`<line x1="${X(a) + K / 2}" y1="${Y(a) + K / 2}" x2="${X(b) + K / 2}" y2="${Y(b) + K / 2}" stroke="${/attack/.test(m.kind) ? '#ff4030' : '#ffb060'}" stroke-width="2.5" marker-end="url(#ah)" opacity="${m.seen ? 1 : 0.45}"/>`); }
for (const a of C.pendingAttacks || []) { const p = C.cell(a.from), q = C.cell(a.to); out.push(`<line x1="${X(p) + K / 2}" y1="${Y(p) + K / 2}" x2="${X(q) + K / 2}" y2="${Y(q) + K / 2}" stroke="#ff2020" stroke-width="4" marker-end="url(#ah)"/>`); }
out.splice(1, 0, `<defs><marker id="ah" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#ffd0a0"/></marker></defs>`);
// legend + numbers
const en = A.cells.filter(c => C.owner[c.id] === 'enemy'), withF = en.filter(c => by[c.id]).length;
const lx = cols * K + 30; let ly = 60; const L = (t, c = '#ddd', fz = 12) => { out.push(`<text x="${lx}" y="${ly}" fill="${c}" font-size="${fz}">${esc(t)}</text>`); ly += 18; };
L('Legend', '#f2e6c4', 13);
L('blue square: own / red: enemy', '#aaa'); L('dashed lines: fortification level', '#c9b37a'); L('★ operation goal square', '#ffd34d');
if (v7) { L('red box: battalion group (n = companies)', '#e0503f'); L('bright red: garrison holding (role hold)', '#ff7050'); L('purple: reserve · grey: resting', '#c070e0'); L('small pink: one-company outpost', '#e8a090'); L('orange arrows: this week\'s moves', '#ffb060'); L('(faint = not observed by the brigade)', '#888'); L('thick red: announced attacks', '#ff4040'); }
else { L('I / I+ / II: line garrison in EVERY square', '#f0a090'); L('red box: task force (n = 3 x str)', '#e0503f'); L('thick red: announced attacks', '#ff4040'); }
ly += 8;
L(`enemy squares: ${en.length}`, '#f2e6c4'); L(`with an enemy force: ${withF} (${Math.round(withF / en.length * 100)}%)`, '#f2e6c4');
if (!v7) L(`garrison total: ${en.reduce((a, c) => a + (C.garrison[c.id] || 0), 0).toFixed(0)} str`, '#f2e6c4');
L(`task forces: ${(C.eforces || []).length} (${(C.eforces || []).reduce((a, f) => a + (f.coys ? f.coys.length : Math.round(f.str * 3)), 0)} coys)`, '#f2e6c4');
if (v7) L(`moves this week: ${(C.enemyMoves?.list || []).length} (${(C.enemyMoves?.list || []).filter(m => m.seen).length} seen)`, '#f2e6c4');
out.push('</svg>');
const dir = path.join(here, 'previews/campaign_v7_rules'); fs.mkdirSync(dir, { recursive: true });
const svg = path.join(dir, `${tag}_${side}_layout${weeks ? '_w' + weeks : ''}.svg`); fs.writeFileSync(svg, out.join('\n'));
try { execFileSync('convert', [svg, svg.replace(/\.svg$/, '.png')]); console.log('wrote', svg.replace(/\.svg$/, '.png')); } catch (e) { console.log('wrote', svg, '(no png:', e.message.slice(0, 60), ')'); }
