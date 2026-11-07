// Campaign v2 content loader. The real campaigns come from content_index.js (written by the content side:
// content_ua.js / content_ru.js); until those exist, or if they fail to load, the engine runs on the test campaigns
// in test_campaign.js (same data contract, schema2.js). normalize() fills the fields the engine relies on.
import { addDays } from './state.js';

export async function loadCampaigns() {
  try {
    const m = await import('./content_index.js');
    const defs = m.CAMPAIGNS2 || m.CAMPAIGNS || m.default;
    if (defs && Object.keys(defs).length) return { defs: normalizeAll(defs), test: false };
  } catch (e) { console.info('campaign v2: content_index.js not available, using the test campaigns', e?.message || e); }
  const { TEST_CAMPAIGNS } = await import('./test_campaign.js');
  return { defs: normalizeAll(TEST_CAMPAIGNS), test: true };
}

export function normalizeAll(defs) { const out = {}; for (const [k, d] of Object.entries(defs)) { try { out[d.id || k] = normalize(d); } catch (e) { console.error('campaign v2: bad campaign', k, e); } } return out; }

export function normalize(def) {
  if (def.__norm) return def;
  const A = def.aor, S = def.start = def.start || {};
  A.cells = A.cells || [];
  if (!A.cols) A.cols = Math.max(...A.cells.map(c => c.col)) + 1;
  if (!A.rows) A.rows = Math.max(...A.cells.map(c => c.row)) + 1;
  const [latS, lonW, latN, lonE] = A.bbox;
  for (const c of A.cells) {
    c.id ||= `c${c.col}_${c.row}`;
    c.terrain ||= 'fields'; c.road ??= 0; c.fort ??= 0; c.vp ??= 0; c.lp ??= 0; c.owner ||= 'enemy';
    if (!c.latlon) c.latlon = [latN - (c.row + 0.5) * (latN - latS) / A.rows, lonW + (c.col + 0.5) * (lonE - lonW) / A.cols];
    // RTS map for a battle here: the real-geography maps only for their own town (Avdiivka incl. the coke plant / Robotyne);
    // every other square uses the stand-in maps - towns and industrial areas the city map, everything else farmland
    {
      const nm = `${c.name || ''} ${c.settlement?.name || ''}`, own = { avdiivka: /Avdiivka/i, robotyne: /Robotyne/i };
      const urban = ['urban', 'industrial'].includes(c.terrain) || ['town', 'industrial', 'city'].includes(c.settlement?.kind);
      c.battleMap = Object.keys(own).find(k => own[k].test(nm)) || (urban ? 'city' : 'farmland');
    }
  }
  A.supplySources = (A.supplySources || []).filter(id => A.cells.some(c => c.id === id));
  if (!A.supplySources.length) {   // the own map edge opposite the enemy
    const edge = { north: c => c.row === A.rows - 1, south: c => c.row === 0, east: c => c.col === 0, west: c => c.col === A.cols - 1 }[A.enemyEdge || 'south'];
    A.supplySources = A.cells.filter(c => edge(c) && c.owner === 'player').map(c => c.id);
  }
  S.turnDays ||= 7; S.date ||= '2023-02-06'; S.end ||= addDays(S.date, 7 * 56);
  if (!S.hq || !A.cells.some(c => c.id === S.hq)) S.hq = A.supplySources[0] || A.cells.find(c => c.owner === 'player')?.id;
  def.directives ||= []; def.catalog ||= []; def.tech ||= []; def.enemy ||= {};
  def.theatre ||= { bbox: [latS - 1, lonW - 1.5, latN + 1, lonE + 1.5], fronts: [], labels: [], rivers: [], events: [] };
  def.theatre.fronts ||= []; def.theatre.labels ||= []; def.theatre.rivers ||= []; def.theatre.events ||= [];
  def.intro ||= { place: A.name || def.title, date: 'February 2023', lines: [] };
  Object.defineProperty(def, '__norm', { value: true, enumerable: false });
  return def;
}
