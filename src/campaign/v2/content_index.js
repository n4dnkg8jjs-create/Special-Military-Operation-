// Campaign v2 content index (content side): both campaigns + a validator for the schema2.js contract.
// The engine loads this through v2/index.js (loadCampaigns -> CAMPAIGNS2). Node check:
//   node -e "import('./src/campaign/v2/content_index.js').then(m => { for (const d of Object.values(m.CAMPAIGNS2)) console.log(d.id, m.validate2(d)); })"
import { MODS } from '../schema.js';
import { CAMPAIGN2_UA } from './content_ua.js';
import { CAMPAIGN2_RU } from './content_ru.js';

export const CAMPAIGNS2 = { UA: CAMPAIGN2_UA, RU: CAMPAIGN2_RU };
export default CAMPAIGNS2;

const TERRAIN = ['fields', 'forest', 'urban', 'industrial', 'village', 'water', 'heights', 'balka'];
const OWNERS = ['player', 'enemy', 'contested'];
const MAPS = ['robotyne', 'avdiivka', 'city', 'farmland'];
const KINDS = ['capture', 'hold', 'destroy', 'recon', 'survive', 'raid'];
const UNIT_KINDS = ['mech', 'imech', 'tank', 'assault', 'atgm', 'fpv', 'spg', 'replacements'];
const ENEMY_KINDS = ['mech', 'imech', 'foot', 'assault', 'tank', 'atgm', 'fpv', 'spg', 'defend'];
const SETTLE = ['town', 'village', 'hamlet', 'industrial'];
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(s);
const full = s => (s.length === 7 ? `${s}-01` : s);

// Returns a list of problems (empty = valid).
export function validate2(def) {
  const E = [], err = m => E.push(m);
  if (!def || typeof def !== 'object') return ['not an object'];
  if (!['UA', 'RU'].includes(def.id)) err(`id ${def.id}`);
  if (def.version !== 2) err('version must be 2');
  if (!def.title) err('title missing');
  if (!def.brigade?.name || !def.brigade?.short) err('brigade name/short missing');
  // intro
  const I = def.intro;
  if (!I?.place || !I?.date || !Array.isArray(I?.lines) || I.lines.length < 3 || I.lines.length > 5) err('intro: place, date and 3–5 lines required');
  // start
  const S = def.start || {};
  if (!isDate(S.date) || !isDate(S.end) || S.date >= S.end) err('start.date / start.end');
  const inRange = d => isDate(d) && full(d) >= S.date && full(d) <= S.end;
  // grid
  const A = def.aor || {};
  if (!Array.isArray(A.bbox) || A.bbox.length !== 4 || !(A.bbox[0] < A.bbox[2] && A.bbox[1] < A.bbox[3])) err('aor.bbox');
  if (!(A.cellKm > 0.5 && A.cellKm < 5)) err('aor.cellKm');
  if (!['north', 'south', 'east', 'west'].includes(A.enemyEdge)) err('aor.enemyEdge');
  const cells = A.cells || [], byId = new Map();
  for (const c of cells) {
    if (byId.has(c.id)) err(`duplicate cell id ${c.id}`);
    byId.set(c.id, c);
    if (c.id !== `c${c.col}_${c.row}`) err(`cell id ${c.id} != c${c.col}_${c.row}`);
    if (!(c.col >= 0 && c.col < A.cols && c.row >= 0 && c.row < A.rows)) err(`cell ${c.id} outside ${A.cols}x${A.rows}`);
    if (!TERRAIN.includes(c.terrain)) err(`cell ${c.id} terrain ${c.terrain}`);
    if (![0, 1, 2].includes(c.road)) err(`cell ${c.id} road ${c.road}`);
    if (!OWNERS.includes(c.owner)) err(`cell ${c.id} owner ${c.owner}`);
    if (!(c.fort >= 0 && c.fort <= 3)) err(`cell ${c.id} fort`);
    if (!(c.garrison >= 0 && c.garrison <= 3)) err(`cell ${c.id} garrison`);
    if (typeof c.vp !== 'number' || typeof c.lp !== 'number') err(`cell ${c.id} vp/lp`);
    if (!MAPS.includes(c.battleMap)) err(`cell ${c.id} battleMap ${c.battleMap}`);
    const wantMap = def.id === 'UA' ? 'robotyne' : 'avdiivka';
    if (c.battleMap !== wantMap) err(`cell ${c.id} battleMap should be ${wantMap}`);
    if (!Array.isArray(c.latlon) || !(c.latlon[0] >= A.bbox[0] && c.latlon[0] <= A.bbox[2] && c.latlon[1] >= A.bbox[1] && c.latlon[1] <= A.bbox[3])) err(`cell ${c.id} latlon outside bbox`);
    if (c.settlement) {
      const s = c.settlement;
      if (!s.name || !SETTLE.includes(s.kind) || !(s.size >= 1 && s.size <= 5) || !Array.isArray(s.latlon)) err(`cell ${c.id} settlement`);
    }
    if (c.objective && !/^[A-Z]$/.test(c.objective)) err(`cell ${c.id} objective`);
  }
  if (cells.length !== A.cols * A.rows) err(`grid incomplete: ${cells.length} cells for ${A.cols}x${A.rows}`);
  for (let col = 0; col < A.cols; col++) for (let row = 0; row < A.rows; row++) if (!byId.has(`c${col}_${row}`)) err(`missing cell c${col}_${row}`);
  const cell = id => byId.get(id);
  if (!(A.supplySources || []).length) err('no supply sources');
  for (const s of A.supplySources || []) if (!cell(s)) err(`supply source ${s} missing`); else if (cell(s).owner !== 'player') err(`supply source ${s} not own`);
  if (!cell(S.hq)) err(`hq ${S.hq} missing`); else if (cell(S.hq).owner !== 'player') err('hq not own');
  // catalog / tech
  const cat = new Map((def.catalog || []).map(c => [c.key, c])), tech = new Map((def.tech || []).map(t => [t.id, t]));
  if (cat.size !== (def.catalog || []).length) err('duplicate catalog keys');
  if (tech.size !== (def.tech || []).length) err('duplicate tech ids');
  for (const c of def.catalog || []) {
    if (!UNIT_KINDS.includes(c.kind)) err(`catalog ${c.key} kind ${c.kind}`);
    if (!(c.lp > 0)) err(`catalog ${c.key} lp`);
    for (const r of c.req || []) if (!tech.has(r)) err(`catalog ${c.key} req ${r} unknown`);
    if (c.date && !inRange(c.date)) err(`catalog ${c.key} date ${c.date} outside campaign`);
  }
  for (const t of def.tech || []) {
    for (const r of t.req || []) if (!tech.has(r)) err(`tech ${t.id} req ${r} unknown`);
    if (!['unlock', 'upgrade'].includes(t.kind)) err(`tech ${t.id} kind`);
    for (const k of t.unlock || []) if (!cat.has(k)) err(`tech ${t.id} unlocks unknown ${k}`);
    for (const k of Object.keys(t.mods || {})) if (!(k in MODS)) err(`tech ${t.id} mod ${k} not in MODS`);
    if (t.date && !inRange(t.date)) err(`tech ${t.id} date ${t.date} outside campaign`);
  }
  for (const k of S.available || []) if (!cat.has(k)) err(`start.available ${k} not in catalog`);
  for (const k of S.unlocked || []) if (!tech.has(k)) err(`start.unlocked ${k} not in tech`);
  // units and task forces
  const uids = new Set();
  const checkUnit = (u, where) => {
    if (!cat.has(u.key)) err(`${where}: unit ${u.uid} key ${u.key} not in catalog`);
    if (!UNIT_KINDS.includes(u.kind)) err(`${where}: unit ${u.uid} kind ${u.kind}`);
    if (!(u.men >= 0 && u.menMax >= u.men)) err(`${where}: unit ${u.uid} men`);
  };
  for (const u of S.units || []) { if (uids.has(u.uid)) err(`duplicate uid ${u.uid}`); uids.add(u.uid); checkUnit(u, 'start'); }
  const inTf = new Set();
  if (!(S.forces || []).length || S.forces.length < 4 || S.forces.length > 8) err('start.forces: 4–8 battalion task forces expected (the brigade starts dispersed)');
  // v4: fires, hubs, goal, enemy task forces
  const BK = ['mortar120', 'how122', 'd30', 'how152', 'msta', 'm777', 'grad'];
  const own = id => (def.aor?.cells || []).find(c => c.id === id)?.owner;
  for (const b of S.batteries || []) { if (!BK.includes(b.kind)) err(`battery kind ${b.kind}`); if (own(b.cell) !== 'player') err(`battery ${b.id} not on an own cell`); }
  for (const b of def.enemy?.batteries || []) { if (!BK.includes(b.kind)) err(`enemy battery kind ${b.kind}`); if (own(b.cell) !== 'enemy') err(`enemy battery ${b.name} not on an enemy cell`); }
  for (const f of def.enemy?.forces || []) if (own(f.cell) !== 'enemy') err(`enemy force ${f.name} not on an enemy cell`);
  for (const h of def.aor?.hubs || []) { if (!['railhead', 'base', 'ammo'].includes(h.kind)) err(`hub kind ${h.kind}`); if (own(h.cell) !== (h.side || 'player') && own(h.cell) !== 'contested') err(`hub ${h.name} not held by its side at start`); }
  for (const id of def.aor?.enemySources || []) if (own(id) !== 'enemy') err(`enemy source ${id} not enemy`);
  if (def.goal) { if (!def.goal.title || !(def.goal.cells || []).length) err('goal title / cells'); for (const g of def.goal.cells || []) if (!own(g.cell) || !(g.pts > 0)) err(`goal cell ${g.cell}`); }
  for (const t of [...(S.ammo || []), ...(def.enemy?.ammo || [])]) if (!isDate(t.date) || !(t.a >= 0)) err('ammo table');
  for (const f of S.forces || []) {
    if (!cell(f.cell)) err(`force ${f.id} cell ${f.cell} missing`); else if (cell(f.cell).owner !== 'player') err(`force ${f.id} not on an own cell`);
    for (const u of f.units || []) { if (!uids.has(u)) err(`force ${f.id} unit ${u} unknown`); if (inTf.has(u)) err(`unit ${u} in two forces`); inTf.add(u); }
  }
  for (const u of uids) if (!inTf.has(u)) err(`unit ${u} in no task force`);
  // directives
  const D = def.directives || [], dIds = new Set();
  for (const d of D) { if (dIds.has(d.id)) err(`duplicate directive ${d.id}`); dIds.add(d.id); }
  if (D.length < 14 || D.length > 22) err(`directives: ${D.length} (14–22 expected)`);
  if (!D.some(d => d.final)) err('no final directive');
  for (const d of D) {
    const w = `directive ${d.id}`;
    if (!KINDS.includes(d.kind)) err(`${w} kind ${d.kind}`);
    if (!d.title || !d.text || !d.from) err(`${w} title/text/from`);
    for (const t of d.targets || []) if (!cell(t)) err(`${w} target ${t} missing`);
    if (['capture', 'hold', 'survive', 'recon', 'raid'].includes(d.kind) && !(d.targets || []).length) err(`${w} needs targets`);
    const is = d.issue || {};
    if (is.date && !inRange(is.date)) err(`${w} issue.date ${is.date} outside campaign`);
    if (is.after && !dIds.has(is.after)) err(`${w} issue.after ${is.after} unknown`);
    if (is.result && !['success', 'failure'].includes(is.result)) err(`${w} issue.result`);
    if (is.when) { const [k, id] = String(is.when).split(':'); if (!['captured', 'lost'].includes(k) || !cell(id)) err(`${w} issue.when ${is.when}`); }
    if (d.deadlineDate && !inRange(d.deadlineDate)) err(`${w} deadlineDate ${d.deadlineDate} outside campaign`);
    if (d.deadlineDate && is.date && d.deadlineDate <= is.date) err(`${w} deadline before issue`);
    if (!d.deadlineDate && d.deadline == null && !d.final) err(`${w} no deadline`);
    for (const k of ['success', 'failure']) if (d.next?.[k] && !dIds.has(d.next[k])) err(`${w} next.${k} ${d.next[k]} unknown`);
    for (const t of d.reward?.unlock || []) if (!tech.has(t)) err(`${w} reward unlock ${t} unknown`);
    for (const u of d.reward?.units || []) { checkUnit(u, w); }
    for (const s of d.sources || []) if (!s.title || !/^https?:\/\//.test(s.url || '')) err(`${w} source`);
    // reachable: issued by date/when/after, or the target of some next
    const reached = is.date || is.when || is.after || is.turn != null || D.some(o => o.next?.success === d.id || o.next?.failure === d.id);
    if (!reached) err(`${w} is never issued`);
  }
  // v5: grid extension (growth.js) — bands of real squares past the original grid, added as the front approaches
  if (A.ext) {
    const X = A.ext, all = new Map(byId), bandIds = new Set(), key = X.dir === 'south' || X.dir === 'north' ? 'row' : 'col';
    if (X.dir !== A.enemyEdge) err(`aor.ext.dir ${X.dir} must be the enemy edge ${A.enemyEdge}`);
    if (!Array.isArray(X.bbox) || X.bbox.length !== 4) err('aor.ext.bbox');
    if (!(X.bands || []).length) err('aor.ext: no bands');
    let edge = X.dir === 'south' || X.dir === 'east' ? Math.max(...cells.map(c => c[key])) : Math.min(...cells.map(c => c[key]));
    const step = X.dir === 'south' || X.dir === 'east' ? 1 : -1;
    for (const b of X.bands || []) {
      const w = `ext band ${b.id}`;
      if (bandIds.has(b.id)) err(`${w} duplicate`); bandIds.add(b.id);
      if (!b.name || !b.text) err(`${w} name / text`);
      const vals = [...new Set(b.cells.map(c => c[key]))].sort((p, q) => step * (p - q));
      if (vals[0] !== edge + step) err(`${w} does not start next to the grid edge (${vals[0]} vs ${edge + step})`);
      const other = key === 'row' ? 'col' : 'row', span = [...new Set(cells.map(c => c[other]))];
      if (b.cells.length !== vals.length * span.length) err(`${w} incomplete: ${b.cells.length} cells`);
      edge = vals[vals.length - 1];
      for (const c of b.cells) {
        if (all.has(c.id)) err(`${w} duplicate cell ${c.id}`); all.set(c.id, c);
        if (c.id !== `c${c.col}_${c.row}`) err(`${w} cell id ${c.id}`);
        if (!TERRAIN.includes(c.terrain) || ![0, 1, 2].includes(c.road) || c.owner !== 'enemy') err(`${w} cell ${c.id} terrain/road/owner`);
        if (!(c.fort >= 0 && c.fort <= 3) || !(c.garrison >= 1 && c.garrison <= 3)) err(`${w} cell ${c.id} fort/garrison`);
        if (c.battleMap !== (def.id === 'UA' ? 'robotyne' : 'avdiivka')) err(`${w} cell ${c.id} battleMap`);
        if (!(c.latlon[0] >= X.bbox[0] && c.latlon[0] <= X.bbox[2] && c.latlon[1] >= X.bbox[1] && c.latlon[1] <= X.bbox[3])) err(`${w} cell ${c.id} outside ext bbox`);
        if (c.settlement && (!c.settlement.name || !SETTLE.includes(c.settlement.kind))) err(`${w} cell ${c.id} settlement`);
      }
      const inB = id => b.cells.some(c => c.id === id);
      if (!(b.sources || []).length) err(`${w} no enemy sources`);
      for (const id of b.sources || []) if (!inB(id) || all.get(id)[key] !== edge) err(`${w} source ${id} not on the band's outer edge`);
      for (const h of b.hubs || []) if (!inB(h.cell) || !['railhead', 'base', 'ammo'].includes(h.kind) || h.side !== 'enemy') err(`${w} hub ${h.name}`);
      for (const f of b.forces || []) if (!inB(f.cell)) err(`${w} force ${f.name} not in the band`);
      for (const d of b.directives || []) {
        if (dIds.has(d.id)) err(`${w} directive ${d.id} duplicate`); dIds.add(d.id);
        if (!KINDS.includes(d.kind) || !d.title || !d.text || !d.from) err(`${w} directive ${d.id}`);
        if (d.issue?.when !== `grown:${b.id}`) err(`${w} directive ${d.id} must be issued when the band is added`);
        for (const t of d.targets || []) if (!all.has(t)) err(`${w} directive ${d.id} target ${t}`);
        if (d.deadline == null) err(`${w} directive ${d.id} deadline`);
        for (const s2 of d.sources || []) if (!s2.title || !/^https?:\/\//.test(s2.url || '')) err(`${w} directive ${d.id} source`);
      }
    }
  }
  // enemy
  const EN = def.enemy || {};
  for (const lvl of [1, 2, 3]) { const t = EN.forceTemplates?.[lvl]; if (!Array.isArray(t) || !t.length) err(`enemy.forceTemplates[${lvl}]`); else for (const e of t) if (!ENEMY_KINDS.includes(e.kind)) err(`enemy template ${lvl} kind ${e.kind}`); }
  for (const k of ['pressure', 'reinforce']) for (const e of EN[k] || []) if (!inRange(e.date)) err(`enemy.${k} date ${e.date}`);
  // theatre
  const T = def.theatre || {};
  if (!Array.isArray(T.bbox) || T.bbox.length !== 4) err('theatre.bbox');
  const fr = T.fronts || [];
  if (fr.length < 13) err(`theatre.fronts: ${fr.length} (at least monthly expected)`);
  for (let i = 0; i < fr.length; i++) {
    if (!isDate(fr[i].date)) err(`front ${i} date`);
    if (i && fr[i].date <= fr[i - 1].date) err(`fronts not sorted at ${fr[i].date}`);
    if (!Array.isArray(fr[i].line) || fr[i].line.length < 40) err(`front ${fr[i].date}: ${fr[i].line?.length} vertices`);
    for (const p of fr[i].line || []) if (!(p[0] >= T.bbox[0] && p[0] <= T.bbox[2] && p[1] >= T.bbox[1] && p[1] <= T.bbox[3])) { err(`front ${fr[i].date} vertex outside theatre bbox`); break; }
  }
  // monthly coverage start..end
  for (let t = new Date(`${S.date}T00:00:00Z`); t.toISOString().slice(0, 10) <= S.end; t.setUTCMonth(t.getUTCMonth() + 1)) {
    const ym = t.toISOString().slice(0, 7);
    if (!fr.some(f => f.date.slice(0, 7) === ym)) err(`no front snapshot in ${ym}`);
  }
  for (const e of T.events || []) if (!isDate(e.date) || !e.text) err('theatre event');
  if (!(T.events || []).length) err('no theatre events');
  if (!(def.sources || []).length) err('no sources');
  return E;
}
