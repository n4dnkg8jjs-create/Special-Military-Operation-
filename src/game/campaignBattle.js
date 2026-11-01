// Campaign battles: deploy the player's persistent task group and the enemy composition chosen by the campaign
// (src/campaign/state.js battleSetup), apply ordered upgrades (MODS) and veterancy, and report the outcome per unit
// back to the campaign. Used when game.campaign is set (main.js passes it from the stored pending battle).
import * as THREE from 'three';
import { MAP, DEPLOY_ZONES, OBJECTIVES } from '../world/city.js';
import { SQUAD_ROLES, ASSAULT_ROLES, ATGM_ROLES, FPV_ROLES } from '../config.js';
import { xpLevel } from '../campaign/state.js';

const ROLES = { mech: SQUAD_ROLES, imech: SQUAD_ROLES, assault: ASSAULT_ROLES, atgm: ATGM_ROLES, fpv: FPV_ROLES };

// player lineup slots: the map's hand-placed lineup + support spots, then extra spots fanned out behind them
function slots(n) {
  const base = [...MAP.lineup.map(l => [l[0], l[1]]), ...(MAP.support || []).map(l => [l[0], l[1]])];
  const out = []; for (let i = 0; i < n; i++) { const b = base[i % base.length], k = Math.floor(i / base.length); out.push([b[0] + k * 14, b[1] + k * 9]); }
  return out;
}

export function deployCampaign(game, side = 'player', forceOverride = null, modsOverride = null) {
  const C = game.campaign, N = side === 'player' ? Math.PI : 0, pf = side === 'player' ? game.playerFaction : game.enemyFaction;
  if (side === 'player') game.playerUnits = [];
  const list = side === 'player' ? game.playerUnits : (game.enemyUnits = []);
  const recs = (forceOverride || C.force).filter(u => u.men > 0 || (u.veh && !u.veh.lost));
  // order: carriers with their squads, tanks, assault, support, guns
  const rank = { mech: 0, imech: 0, tank: 1, assault: 2, atgm: 3, fpv: 3, spg: 4 };
  recs.sort((a, b) => (rank[a.kind] ?? 5) - (rank[b.kind] ?? 5));
  const S = side === 'player' ? slots(recs.length + 2) : enemySlots(recs.length + 2); let si = 0;
  const assaults = recs.filter(r => r.kind === 'assault');
  const squadOf = (r, x, z) => {
    const roles = (ROLES[r.kind] || SQUAD_ROLES).slice(0, Math.max(1, Math.min(r.men, (ROLES[r.kind] || SQUAD_ROLES).length)));
    const sq = game.makeSquad(side, x, z, N, r.name, r.kind === 'imech' ? 'mech' : r.kind, roles); sq.name = r.name; sq.rec = r.uid; sq.vet = xpLevel(r.xp); sq.morale = Math.min(100, sq.morale + sq.vet * 5);
    return sq;
  };
  for (const r of recs) {
    if (r.kind === 'assault' && r.mounted) continue;
    const [x, z] = S[si++];
    if (r.veh && !r.veh.lost) {
      const v = game.makeVehicle(side, r.veh.kind, x, z, N); v.name = r.name.replace(/ squad$/i, '') + (r.kind === 'mech' || r.kind === 'imech' ? '' : '');
      v.rec = r.uid; v.vet = xpLevel(r.xp); v.hp = v.def.hp * Math.max(0.2, r.veh.hp ?? 1);
      if (r.kind === 'mech' || r.kind === 'imech') { v.name = `${r.veh.kind === 'ifv' ? pf.ifvName : pf.btrName} (${r.name})`; }
      list.push(v);
      let sq = null;
      if ((r.kind === 'mech' || r.kind === 'imech') && r.men > 0) sq = squadOf(r, x, z + 6);
      else if (r.kind === 'tank') { const a = assaults.find(q => !q.mounted && q.men > 0); if (a) { a.mounted = true; sq = squadOf(a, x, z + 6); } }
      if (sq) { sq.board(v, true); list.splice(list.length - 1, 0, sq); }
    } else if (r.men > 0) list.push(squadOf(r, x, z));
  }
  for (const a of assaults) delete a.mounted;
  if (side === 'player' && C.mode === 'defend') {
    // defending: the staging ground stretches forward over the objectives (positions prepared in advance)
    const Z = DEPLOY_ZONES.player, oz = Math.min(...OBJECTIVES.map(o => o.z));
    Z.z0 = Math.min(Z.z0, oz - 40); Z.x0 = Math.min(Z.x0, ...OBJECTIVES.map(o => o.x - 50)); Z.x1 = Math.max(Z.x1, ...OBJECTIVES.map(o => o.x + 50));
  }
  applyMods(game, modsOverride || C.mods || {}, side);
}
function enemySlots(n) {
  const base = MAP.ai.army.map(l => [l[0], l[1]]);
  const out = []; for (let i = 0; i < n; i++) { const b = base[i % base.length], k = Math.floor(i / base.length); out.push([b[0] + k * 14, b[1] - k * 9]); }
  return out;
}

// enemy layout for the Commander (MAP.ai.army format: [x, z, kind, obj]); attack missions add dug-in defenders
export function campaignArmy(game) {
  const C = game.campaign, lay = MAP.ai.army, objs = OBJECTIVES.map(o => o.id), out = [], used = {};
  const pick = kind => { const pool = lay.filter(l => l[2] === kind || (kind === 'imech' && l[2] === 'mech') || (kind === 'foot' && (l[2] === 'assault' || l[2] === 'mech'))); const base = pool.length ? pool : lay; const k = used[kind] = (used[kind] || 0) + 1; const b = base[(k - 1) % base.length]; return [b[0] + Math.floor((k - 1) / base.length) * 16, b[1] - Math.floor((k - 1) / base.length) * 10, b[3]]; };
  C.enemy.forEach((e, i) => { if (e.kind === 'defend') return; const [x, z, obj] = pick(e.kind); out.push([x, z, e.kind, e.obj || obj || objs[i % objs.length]]); });
  return out;
}
export function campaignDefenders(game) {
  const C = game.campaign; if (C.mode !== 'attack') return [];
  const n = (C.enemy.filter(e => e.kind === 'defend').length) || Math.max(1, Math.min(4, C.strength + (C.fort >= 2 ? 1 : 0)));
  return Array.from({ length: n }, (_, i) => OBJECTIVES[i % OBJECTIVES.length].id);
}

// upgrades ordered from high command (campaign MODS) -> battle effects
export function applyMods(game, M, side) {
  game.mods ||= {}; game.mods[side] = M;
  for (const sq of game.squads) {
    if (sq.side !== side) continue;
    for (const s of sq.soldiers) if (s.armor) s.armor = { ...s.armor, plateCoverage: Math.min(0.85, (s.armor.plateCoverage || 0) + (M.armorPlate || 0)), helmetStop: Math.min(0.85, (s.armor.helmetStop || 0) + (M.helmet || 0)) };
    if (sq.support?.drones != null && M.fpvDrones) sq.support.drones += M.fpvDrones;
    if (sq.support && sq.support.ammo != null && sq.support.drones == null && M.atgmAmmo) sq.support.ammo += M.atgmAmmo;
  }
  for (const v of game.vehicles) {
    if (v.side !== side) continue;
    if (M.copeCage) v.cage = Math.min(0.9, (v.cage || 0) + M.copeCage);
    if (v.kind === 'spg' && M.artyAmmo) v.weapons[0].ammo = Math.round(v.weapons[0].ammo * (1 + M.artyAmmo));
  }
  if (side === 'player' && M.mortar) game.mortars += M.mortar;
}

// what happened to each persistent unit
export function collectResult(game, side = 'player') {
  const C = game.campaign, os = side === 'player' ? 'enemy' : 'player', P = game.stats[side], E = game.stats[os], units = {};
  const rec = uid => (units[uid] ||= { uid, alive: 0, wounded: 0, kills: 0, vehLost: false, vehHp: 1 });
  for (const sq of game.squads) {
    if (sq.side !== side || sq.rec == null) continue;
    const u = rec(sq.rec);
    for (const s of sq.soldiers) { if (s.state === 'dead') continue; if (s.state === 'critical' || s.state === 'stable' || s.state === 'evac') u.wounded++; else u.alive++; }
    u.kills += Math.round(sq.stats.kills || 0);
  }
  for (const v of game.vehicles) {
    if (v.side !== side || v.rec == null) continue;
    const u = rec(v.rec); u.vehLost = v.destroyed; u.vehHp = v.destroyed ? 0 : Math.max(0, v.hp / v.def.hp); u.kills += Math.round(v.stats?.kills || 0);
    // crew: bailed-out crews that survived come back to the vehicle unit; vehicle-only units count crew as men
  }
  const win = side === 'player' ? !!game.result?.win : !game.result?.win;
  return { sector: C.sector, mode: side === 'player' ? C.mode : (C.mode === 'attack' ? 'defend' : 'attack'), win, units: Object.values(units), enemyKia: E.kia, enemyVehLost: E.vehLost,
    objectivesHeld: game.objectives.filter(o => o.owner === side).length, losses: P.kia, time: game.time };
}

// small helpers for upgrade effects elsewhere in the battle code
export const modOf = (game, side, key, dflt = 0) => game.mods?.[side]?.[key] ?? dflt;
export const vetOf = u => (u?.squad?.vet ?? u?.vet ?? 0);
export { THREE };
