// Campaign v2 (v5 rules) — the playable grid GROWS past the original area of responsibility.
//
// The content grid (content_grid_<side>.js) is the brigade's AOR at the start. Behind the enemy's edge of it the real
// ground goes on: content_grid_ext_<side>.js holds further squares built from OpenStreetMap the same way (villages,
// roads, rivers, woods, rail, mapped field fortifications), grouped into BANDS of 2–3 rows (UA: south towards Tokmak)
// or columns (RU: west of Avdiivka, negative column numbers). The content (content_ua.js / content_ru.js) adds to each
// band its enemy hubs, garrison task forces and directives (def.aor.ext).
//
// Rule: when a square the side has TAKEN (held now, not at the start) comes within GROW_REACH (3, the AOR reveal distance) of the grid's edge on the
// enemy's side, the next band is added: its squares join the map enemy-held with their garrisons and fortifications,
// the enemy's supply sources move out to the new edge, the band's hubs, task forces (single player) and directives
// arrive. The squares then open like any other (within aor.reveal of an own square). Growth never shrinks back.
//
// The content definition is never mutated: each Campaign2 works on its own grown view (growDef). Versus: the host
// grows both sides together (versus.js), the defending side's view is the same band with owners / hubs flipped.
import * as AI from './ai.js';
export const GROW_REACH = 3;

const keyOf = dir => (dir === 'south' || dir === 'north' ? 'row' : 'col');
// the grid's outer line on side `dir`: { key, v } (cells with c[key] === v)
export function edgeLine(A, dir) {
  const k = keyOf(dir), vals = A.cells.map(c => c[k]);
  return { key: k, v: dir === 'south' || dir === 'east' ? Math.max(...vals) : Math.min(...vals) };
}
export function onEdge(A, dir, c) { const e = edgeLine(A, dir); return c[e.key] === e.v; }

// the grown definition: base content + the bands in `grown` (ids, in order). Returns base itself when nothing grew.
export function growDef(base, grown) {
  const X = base.aor?.ext; if (!X || !grown?.length) return base;
  const A0 = base.aor, bands = X.bands.filter(b => grown.includes(b.id));
  if (!bands.length) return base;
  const srcKey = (X.edgeSide || 'enemy') === 'enemy' ? 'enemySources' : 'supplySources';
  let cells = A0.cells, src = [...(A0[srcKey] || [])]; const depots = [];
  for (const b of bands) {
    const e = edgeLine({ cells }, X.dir), byId = new Map(cells.map(c => [c.id, c]));
    // sources on the old edge are now inland: they become rear depots (base hubs) that work only while the road back
    // to the new edge holds (supply.js HUB_LINK) — taking the band's roads, or shelling them, now starves them
    for (const id of src.filter(id => byId.get(id)?.[e.key] === e.v)) { const c = byId.get(id); depots.push({ cell: id, kind: 'base', side: (X.edgeSide || 'enemy') === 'enemy' ? 'enemy' : 'player', name: `Rear depot (${c.name || c.settlement?.name || (c.roads?.[0] ? c.roads[0] + ' road' : 'grid ' + id)})`, depot: true }); }
    src = src.filter(id => byId.get(id)?.[e.key] !== e.v);
    cells = [...cells, ...b.cells]; src.push(...(b.sources || []));
  }
  const cols = cells.map(c => c.col), rows = cells.map(c => c.row), col0 = Math.min(...cols), row0 = Math.min(...rows);
  const bb = [A0.bbox, ...bands.map(b => b.bbox)];
  const aor = { ...A0, cells, col0, row0, cols: Math.max(...cols) - col0 + 1, rows: Math.max(...rows) - row0 + 1,
    bbox: [Math.min(...bb.map(b => b[0])), Math.min(...bb.map(b => b[1])), Math.max(...bb.map(b => b[2])), Math.max(...bb.map(b => b[3]))],
    hubs: [...(A0.hubs || []), ...depots.filter(d => !(A0.hubs || []).some(h => h.cell === d.cell)), ...bands.flatMap(b => b.hubs || [])], [srcKey]: [...new Set(src)], grown: [...grown] };
  return { ...base, aor, directives: [...(base.directives || []), ...bands.flatMap(b => b.directives || [])] };
}

// the band that should be added now, or null. Only for a side that attacks towards the extension (its enemy edge is
// the extension's direction).
export function nextBand(C) {
  const X = C.baseDef?.aor?.ext; if (!X) return null;
  const A = C.def.aor; if ((A.enemyEdge || 'south') !== X.dir) return null;
  const b = X.bands.find(x => !(C.grown || []).includes(x.id)); if (!b) return null;
  const e = edgeLine(A, X.dir), reach = X.reach ?? GROW_REACH;
  // ground the side has TAKEN (not held at the start: the RU grid's south-west corner was Russian-held since 2014)
  const near = A.cells.some(c => C.owner[c.id] === 'player' && c.owner !== 'player' && Math.abs(c[e.key] - e.v) <= reach);
  return near ? b : null;
}

// add a band to a campaign (state.js Campaign2). opts.quiet: no log line (versus mirrors)
export function applyBand(C, band, opts = {}) {
  if ((C.grown ||= []).includes(band.id)) return false;
  C.grown.push(band.id);
  C.def = growDef(C.baseDef, C.grown); C.index();
  const vs = !!C.def.versus;
  for (const c of band.cells) {
    if (C.owner[c.id] != null) continue;
    C.owner[c.id] = c.owner; C.garrison[c.id] = c.owner === 'player' ? 0 : (vs ? 1 : (c.garrison ?? 1)); C.fort[c.id] = c.fort || 0;
  }
  // v7: the band's battalion groups (companies, ai.js makeForce); its squares are held by them, not by a garrison
  if (!vs) for (const f of band.forces || []) if (C.owner[f.cell] === 'enemy') (C.eforces ||= []).push(AI.makeForce(C, f));
  if (!vs && C.def.enemy?.forces) for (const c of band.cells) if (C.owner[c.id] === 'enemy') C.garrison[c.id] = 0;
  if (!vs) for (const b of band.batteries || []) if (C.owner[b.cell] === 'enemy') C.arty.enemy.push({ id: C.newId('eb'), kind: b.kind, name: b.name || b.kind, cell: b.cell, hp: 1, acted: 0, moved: 0, revealed: null, down: 0, fired: 0 });
  C.gridV = (C.gridV || 0) + 1;
  C.lastGrowth = { band: band.id, name: band.name || band.id, turn: C.turn, cells: band.cells.map(c => c.id) };
  if (!opts.quiet) C.note(`The front has reached the edge of the brigade's map: higher command extends the area of responsibility past it — ${band.name || 'new ground'} (${band.cells.length} grid squares${(band.forces || []).length && !vs ? `, ${band.forces.length} enemy battalion group${band.forces.length > 1 ? 's' : ''} reported there` : ''}).${band.text ? ' ' + band.text : ''}`, 'directive');
  C.computeSupply();
  return true;
}
