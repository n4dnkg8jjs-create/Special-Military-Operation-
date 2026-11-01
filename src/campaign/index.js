// Campaign registry + a validator for the data contract in schema.js (run it after editing content files):
//   node -e "import('./src/campaign/index.js').then(m=>console.log(m.validate(m.CAMPAIGNS.UA), m.validate(m.CAMPAIGNS.RU)))"
import { MODS } from './schema.js';
import { CAMPAIGN_UA } from './content_ua.js';
import { CAMPAIGN_RU } from './content_ru.js';

export const CAMPAIGNS = { UA: CAMPAIGN_UA, RU: CAMPAIGN_RU };

const SECTOR_TYPES = ['village', 'town', 'farm', 'fields', 'forest', 'height', 'crossroads', 'industrial'];
const BATTLE_MAPS = ['city', 'farmland'];
const DIRECTIVE_KINDS = ['capture', 'hold', 'destroy', 'recon', 'survive'];
const UNIT_KINDS = ['mech', 'imech', 'tank', 'assault', 'atgm', 'fpv', 'spg'];
const CATALOG_KINDS = [...UNIT_KINDS, 'replacements'];
const VEHICLES = ['btr', 'ifv', 'tank', 'spg'];
const ENEMY_KINDS = ['mech', 'imech', 'foot', 'assault', 'tank', 'atgm', 'fpv', 'spg', 'defend'];
const OBJ_LETTERS = ['A', 'B'];   // objectives that exist on BOTH battle maps (city has A/B, farmland A–D)

// Returns { id, ok, errors: [...], warnings: [...], stats }. Errors break the contract; warnings are suspicious data.
export function validate(def) {
  const errors = [], warnings = [];
  const err = m => errors.push(m), warn = m => warnings.push(m);
  if (!def || typeof def !== 'object') return { ok: false, errors: ['no campaign definition'], warnings };
  const dupes = (arr, what) => { const seen = new Set(); for (const x of arr) { if (seen.has(x)) err(`duplicate ${what} id "${x}"`); seen.add(x); } return seen; };
  for (const k of ['id', 'title', 'map', 'sectors', 'start', 'directives', 'enemy', 'catalog', 'tech']) if (def[k] == null) err(`missing field "${k}"`);
  if (!['UA', 'RU'].includes(def.id)) err(`id must be UA or RU (got ${def.id})`);
  if (!Array.isArray(def.sources) || !def.sources.length) warn('no sources listed');
  else for (const s of def.sources) if (!s.title || !/^https?:\/\//.test(s.url || '')) err(`bad source entry ${JSON.stringify(s)}`);
  const sectors = def.sectors || [], directives = def.directives || [], tech = def.tech || [], catalog = def.catalog || [];
  const sIds = dupes(sectors.map(s => s.id), 'sector'), dIds = dupes(directives.map(d => d.id), 'directive');
  const tIds = dupes(tech.map(t => t.id), 'tech'), cKeys = dupes(catalog.map(c => c.key), 'catalog');
  const byId = Object.fromEntries(sectors.map(s => [s.id, s]));
  const M = def.map || {};
  if (!(M.w > 0 && M.h > 0)) err('map.w / map.h must be positive');
  if (!['north', 'south', 'east', 'west'].includes(M.enemyEdge)) err(`map.enemyEdge invalid (${M.enemyEdge})`);
  const ptsOk = (pts, what) => { if (!Array.isArray(pts) || pts.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite))) err(`${what}: bad point list`); };
  (M.rivers || []).forEach((r, i) => ptsOk(r.pts, `map.rivers[${i}]`));
  (M.roads || []).forEach((r, i) => { ptsOk(r.pts, `map.roads[${i}]`); if (!['highway', 'road', 'track'].includes(r.kind)) err(`map.roads[${i}].kind invalid`); });
  (M.rail || []).forEach((r, i) => ptsOk(r.pts, `map.rail[${i}]`));
  (M.forests || []).forEach((p, i) => ptsOk(p, `map.forests[${i}]`));
  (M.fields || []).forEach((p, i) => ptsOk(p, `map.fields[${i}]`));
  for (const l of M.labels || []) if (!(l.x >= 0 && l.x <= M.w && l.y >= 0 && l.y <= M.h)) warn(`label "${l.text}" outside the map`);
  // projection consistency: sectors carrying latlon must sit where the map's bbox projection puts them
  const proj = M.bbox && M.kmPerUnit ? (lat, lon) => { const kx = 111.32 * Math.cos((M.bbox[1] + M.bbox[3]) / 2 * Math.PI / 180); return [(lon - M.bbox[0]) * kx / M.kmPerUnit, (M.bbox[3] - lat) * 110.57 / M.kmPerUnit]; } : null;
  // ---- sectors
  for (const s of sectors) {
    const at = `sector ${s.id}`;
    if (!s.name) err(`${at}: no name`);
    if (!SECTOR_TYPES.includes(s.type)) err(`${at}: type "${s.type}" invalid`);
    if (!BATTLE_MAPS.includes(s.battleMap)) err(`${at}: battleMap "${s.battleMap}" not in ${BATTLE_MAPS}`);
    if (!['player', 'enemy'].includes(s.owner)) err(`${at}: owner invalid`);
    if (!(s.x >= 0 && s.x <= M.w && s.y >= 0 && s.y <= M.h)) err(`${at}: position (${s.x},${s.y}) outside the map`);
    if (!(s.fort >= 0 && s.fort <= 3)) err(`${at}: fort must be 0..3`);
    if (!(s.garrison >= 0 && s.garrison <= 3)) err(`${at}: garrison must be 0..3`);
    if (s.owner === 'enemy' && !s.garrison) warn(`${at}: enemy-held with garrison 0`);
    if (!Number.isFinite(s.vp) || !Number.isFinite(s.lp)) err(`${at}: vp / lp must be numbers`);
    if (s.latlon && proj) { const [px, py] = proj(...s.latlon); if (Math.hypot(px - s.x, py - s.y) > 1) err(`${at}: x/y (${s.x},${s.y}) disagree with latlon projection (${px.toFixed(1)},${py.toFixed(1)})`); }
    if (!Array.isArray(s.adj) || !s.adj.length) err(`${at}: no neighbours`);
    for (const a of s.adj || []) {
      if (a === s.id) err(`${at}: adjacent to itself`);
      else if (!byId[a]) err(`${at}: unknown neighbour "${a}"`);
      else if (!byId[a].adj?.includes(s.id)) err(`adjacency not symmetric: ${s.id} -> ${a}`);
    }
  }
  // connectivity: every sector reachable from the HQ
  const st = def.start || {};
  if (!byId[st.hq]) err(`start.hq "${st.hq}" is not a sector`);
  else {
    if (byId[st.hq].owner !== 'player') err('start.hq must be player-owned');
    const seen = new Set([st.hq]), q = [st.hq];
    while (q.length) for (const a of byId[q.shift()].adj || []) if (byId[a] && !seen.has(a)) { seen.add(a); q.push(a); }
    for (const s of sectors) if (!seen.has(s.id)) err(`sector ${s.id} not connected to the HQ`);
  }
  const income = sectors.filter(s => s.owner === 'player').reduce((a, s) => a + (s.lp || 0), 0);
  if (income < 5 || income > 12) warn(`starting income ${income} LP/turn outside the intended 5–12`);
  if (!sectors.some(s => s.owner === 'enemy' && s.adj.some(a => byId[a]?.owner === 'player'))) err('no front line at the start');
  // ---- start
  for (const t of st.unlocked || []) if (!tIds.has(t)) err(`start.unlocked: unknown tech "${t}"`);
  for (const k of st.available || []) if (!cKeys.has(k)) err(`start.available: unknown catalog key "${k}"`);
  dupes((st.force || []).map(u => u.uid), 'unit uid');
  const unitOk = (u, at) => {
    const c = catalog.find(x => x.key === u.key);
    if (!c) return err(`${at}: unit key "${u.key}" not in catalog`);
    if (c.kind === 'replacements') err(`${at}: unit uses a replacements catalog key`);
    if (u.kind && u.kind !== c.kind) err(`${at}: kind "${u.kind}" differs from catalog kind "${c.kind}"`);
    if (!UNIT_KINDS.includes(u.kind || c.kind)) err(`${at}: unit kind invalid`);
    const vk = u.veh?.kind || c.vehicle; if (vk && !VEHICLES.includes(vk)) err(`${at}: vehicle kind invalid`);
    if (c.vehicle && u.veh && u.veh.kind !== c.vehicle) err(`${at}: vehicle "${u.veh.kind}" differs from catalog "${c.vehicle}"`);
    if (u.men != null && u.menMax != null && u.men > u.menMax) err(`${at}: men > menMax`);
  };
  (st.force || []).forEach(u => unitOk(u, `start.force ${u.uid}`));
  if (!(st.force || []).length) err('start.force is empty');
  // ---- directives
  const referenced = new Set();
  for (const d of directives) for (const k of ['success', 'failure']) if (d.next?.[k]) referenced.add(d.next[k]);
  const finals = directives.filter(d => d.final);
  if (!finals.length) err('no directive is marked final');
  if (finals.length > 1) warn(`${finals.length} final directives; state.js only checks the first (${finals[0].id})`);
  for (const d of directives) {
    const at = `directive ${d.id}`, is = d.issue || {};
    if (!d.title || !d.text) err(`${at}: title/text missing`);
    if (!DIRECTIVE_KINDS.includes(d.kind)) err(`${at}: kind "${d.kind}" invalid`);
    if (!Array.isArray(d.targets) || !d.targets.length) err(`${at}: no targets`);
    for (const t of d.targets || []) if (!byId[t]) err(`${at}: unknown target "${t}"`);
    if (!(d.deadline > 0)) err(`${at}: deadline must be > 0`);
    if ((d.kind === 'hold' || d.kind === 'survive') && d.count > d.deadline) warn(`${at}: count > deadline (deadline is not used for hold/survive when count is set)`);
    if (d.kind === 'destroy' && !(d.count > 0)) warn(`${at}: destroy without count (defaults to 5)`);
    if (d.kind === 'survive' || d.kind === 'hold') for (const t of d.targets || []) if (byId[t]?.owner !== 'player' && !(is.when === `captured:${t}`)) warn(`${at}: ${d.kind} target "${t}" may not be held when issued`);
    for (const k of ['success', 'failure']) if (d.next?.[k] && !dIds.has(d.next[k])) err(`${at}: next.${k} "${d.next[k]}" unknown`);
    if (is.after && !dIds.has(is.after)) err(`${at}: issue.after "${is.after}" unknown`);
    if (is.result && !['success', 'failure'].includes(is.result)) err(`${at}: issue.result must be success|failure`);
    if (is.result && !is.after) err(`${at}: issue.result without issue.after`);
    if (is.when) {
      const m = /^(captured|lost):(.+)$/.exec(is.when);
      if (!m || !byId[m[2]]) err(`${at}: issue.when "${is.when}" invalid`);
      else if (m[1] === 'lost' && byId[m[2]].owner !== 'player') err(`${at}: lost:${m[2]} never fires (state.js only fires it for sectors that start player-owned)`);
      else if (m[1] === 'captured' && byId[m[2]].owner === 'player') warn(`${at}: captured:${m[2]} fires at once (sector starts player-owned)`);
    }
    if (is.turn == null && !is.after && !is.when && !referenced.has(d.id)) err(`${at}: can never be issued (no turn/after/when and no parent's next)`);
    for (const t of d.reward?.unlock || []) if (!tIds.has(t)) err(`${at}: reward.unlock unknown tech "${t}"`);
    (d.reward?.units || []).forEach((u, i) => unitOk(u, `${at} reward.units[${i}]`));
    if (d.after) err(`${at}: "after" belongs inside issue`);
  }
  // final reachable from the turn-issued directives through next / after / when
  if (finals.length) {
    const reach = new Set(directives.filter(d => d.issue?.turn != null || d.issue?.when).map(d => d.id));
    let grow = true;
    while (grow) { grow = false; for (const d of directives) { if (reach.has(d.id)) continue; const parentNext = directives.some(p => reach.has(p.id) && (p.next?.success === d.id || p.next?.failure === d.id)); if (parentNext || (d.issue?.after && reach.has(d.issue.after))) { reach.add(d.id); grow = true; } } }
    if (!reach.has(finals[0].id)) err(`final directive ${finals[0].id} unreachable`);
    for (const d of directives) if (!reach.has(d.id)) warn(`directive ${d.id} unreachable`);
  }
  // ---- catalog
  for (const c of catalog) {
    const at = `catalog ${c.key}`;
    if (!CATALOG_KINDS.includes(c.kind)) err(`${at}: kind "${c.kind}" invalid`);
    if (c.vehicle && !VEHICLES.includes(c.vehicle)) err(`${at}: vehicle "${c.vehicle}" invalid`);
    if (!(c.lp > 0)) err(`${at}: lp cost must be > 0`);
    if (c.kind !== 'replacements' && !(c.men > 0)) err(`${at}: men must be > 0`);
    for (const r of c.req || []) if (!tIds.has(r)) err(`${at}: req unknown tech "${r}"`);
    const unlockedBy = tech.some(t => (t.unlock || []).includes(c.key)) || (st.available || []).includes(c.key);
    if (!unlockedBy) warn(`${at}: never becomes available (not in start.available nor unlocked by tech)`);
  }
  // ---- tech
  const techById = Object.fromEntries(tech.map(t => [t.id, t]));
  for (const t of tech) {
    const at = `tech ${t.id}`;
    if (!t.name || !t.branch) err(`${at}: name/branch missing`);
    if (!['unlock', 'upgrade'].includes(t.kind)) err(`${at}: kind must be unlock|upgrade`);
    if (!(t.lp > 0)) err(`${at}: lp cost must be > 0`);
    for (const r of t.req || []) if (!tIds.has(r)) err(`${at}: req unknown tech "${r}"`);
    if (t.kind === 'unlock' && !(t.unlock || []).length) err(`${at}: unlock tech without unlock list`);
    for (const k of t.unlock || []) if (!cKeys.has(k)) err(`${at}: unlock unknown catalog key "${k}"`);
    if (t.kind === 'upgrade' && !Object.keys(t.mods || {}).length) err(`${at}: upgrade without mods`);
    for (const [k, v] of Object.entries(t.mods || {})) {
      if (!(k in MODS)) err(`${at}: mod "${k}" not in MODS`);
      else if (typeof v !== 'boolean' && !Number.isFinite(v)) err(`${at}: mod ${k} value must be a number or boolean`);
      else if (typeof v === 'number' && Math.abs(v) >= 1 && !['fpvDrones', 'atgmAmmo', 'mortar'].includes(k)) warn(`${at}: mod ${k}=${v} — the battle code applies multipliers as (1 + value)`);
    }
  }
  // prerequisite cycles
  const state = {};
  const visit = (id, path) => { if (state[id] === 2) return; if (state[id] === 1) return err(`tech prerequisite cycle: ${[...path, id].join(' -> ')}`); state[id] = 1; for (const r of techById[id]?.req || []) if (techById[r]) visit(r, [...path, id]); state[id] = 2; };
  for (const t of tech) visit(t.id, []);
  const branches = [...new Set(tech.map(t => t.branch))];
  if (tech.length < 20 || tech.length > 30) warn(`${tech.length} tech entries (intended 20–30)`);
  if (branches.length < 4 || branches.length > 6) warn(`${branches.length} tech branches (intended 4–6)`);
  if (directives.length < 10 || directives.length > 16) warn(`${directives.length} directives (intended 10–16)`);
  // ---- enemy
  const E = def.enemy || {};
  for (const k of ['pressure', 'reinforce']) { if (!Array.isArray(E[k]) || !E[k].length) err(`enemy.${k} missing`); else if (E[k].some(v => !(v >= 0 && v <= 1))) err(`enemy.${k} values must be 0..1`); }
  for (const lvl of ['1', '2', '3']) {
    const tpl = E.forceTemplates?.[lvl];
    if (!Array.isArray(tpl) || !tpl.length) { err(`enemy.forceTemplates[${lvl}] missing`); continue; }
    for (const e of tpl) { if (!ENEMY_KINDS.includes(e.kind)) err(`enemy.forceTemplates[${lvl}]: kind "${e.kind}" invalid`); if (e.obj && !OBJ_LETTERS.includes(e.obj)) err(`enemy.forceTemplates[${lvl}]: obj "${e.obj}" not on both maps`); }
  }
  for (const k of ['fpvThreat', 'artillery']) if (E[k] != null && !(E[k] >= 0 && E[k] <= 1)) err(`enemy.${k} must be 0..1`);
  const stats = { sectors: sectors.length, player: sectors.filter(s => s.owner === 'player').length, directives: directives.length, tech: tech.length, branches: branches.length, catalog: catalog.length, income };
  return { id: def.id, ok: !errors.length, errors, warnings, stats };
}
