// Campaign battles: deploy the player's persistent task group and the enemy composition chosen by the campaign
// (src/campaign/state.js battleSetup), apply ordered upgrades (MODS) and veterancy, and report the outcome per unit
// back to the campaign. Used when game.campaign is set (main.js passes it from the stored pending battle).
import { addAtgmTruck } from './atgmTruck.js';
import * as THREE from 'three';
import { MAP, DEPLOY_ZONES, OBJECTIVES } from '../world/city.js';
import { SQUAD_ROLES, ASSAULT_ROLES, ATGM_ROLES, FPV_ROLES } from '../config.js';
import { xpLevel } from '../campaign/state.js';
import { applyVehicleKits } from './vehicleKit.js';
import { crewUnit } from './campaignResult.js';

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
  // (a tank / SPG unit whose vehicle was lost: its surviving crew waits for a new one, it does not fight on foot)
  const recs = (forceOverride || C.force).filter(u => crewUnit(u) ? !u.veh.lost : (u.men > 0 || (u.veh && !u.veh.lost)));
  // the records that went in (collectResult: every deployed unit gets a result entry; crews scaled to the unit's men)
  (game.campRecs ||= {})[side] = recs.map(u => ({ uid: u.uid, kind: u.kind, men: u.men || 0, veh: u.veh ? { kind: u.veh.kind, hp: u.veh.hp, lost: !!u.veh.lost } : null }));
  if (side === 'player' && game.heli) game.heli.left.player = C.ci?.heli || 0;   /* Command Influence: Mi-24 on call */
  // order: carriers with their squads, tanks, assault, support, guns
  const rank = { mech: 0, imech: 0, tank: 1, assault: 2, atgm: 3, fpv: 3, spg: 4 };
  recs.sort((a, b) => (rank[a.kind] ?? 5) - (rank[b.kind] ?? 5));
  const S = side === 'player' ? slots(recs.length + 2) : enemySlots(recs.length + 2); let si = 0;
  const assaults = recs.filter(r => r.kind === 'assault');
  const squadOf = (r, x, z) => {
    const roles = (ROLES[r.kind] || SQUAD_ROLES).slice(0, Math.max(1, Math.min(r.men, (ROLES[r.kind] || SQUAD_ROLES).length)));
    const sq = game.makeSquad(side, x, z, N, r.name, r.kind === 'imech' ? 'mech' : r.kind, roles); sq.name = r.name; sq.rec = r.uid; sq.vet = xpLevel(r.xp); sq.morale = Math.min(100, sq.morale + sq.vet * 5);
    if (r.special === 'vdv') { sq.vet = 3; sq.morale = 100; sq.elite = true; }   /* airborne assault section on loan (campaign/v2/influence.js) */
    return sq;
  };
  for (const r of recs) {
    if (r.kind === 'assault' && r.mounted) continue;
    const [x, z] = S[si++];
    if (r.veh && !r.veh.lost && r.veh.kind === 'atgmtruck') {
      // the ATGM team on its pickup (game/atgmTruck.js): the unit's men are its crew; without the model, or in a net battle (the
      // joiner has no puppet for it yet), the team deploys on foot as it does once the truck is lost
      const v = !game.opts?.net && (r.men || 0) >= 3 ? addAtgmTruck(game, side, x, z, N, r.name, 3) : null;   /* (a team short of a man fights on foot until it is made up) */
      if (v) { v.rec = r.uid; v.vet = xpLevel(r.xp); v.hp = v.def.hp * Math.max(0.2, r.veh.hp ?? 1); if (v.crewSq) { v.crewSq.rec = r.uid; v.crewSq.vet = xpLevel(r.xp); } list.push(v); }
      else if (r.men > 0) list.push(squadOf(r, x, z));
    } else if (r.veh && !r.veh.lost) {
      const v = game.makeVehicle(side, r.veh.kind, x, z, N, r.veh.variant || null); v.name = r.name.replace(/ squad$/i, '') + (r.kind === 'mech' || r.kind === 'imech' ? '' : '');
      v.rec = r.uid; v.vet = xpLevel(r.xp); v.hp = v.def.hp * Math.max(0.2, r.veh.hp ?? 1);
      if (r.kind === 'mech' || r.kind === 'imech') { v.name = `${r.veh.kind === 'ifv' ? pf.ifvName : pf.btrName} (${r.name})`; }
      list.push(v);
      let sq = null;
      if ((r.kind === 'mech' || r.kind === 'imech') && r.men > 0) sq = squadOf(r, x, z + 6);
      else if (r.kind === 'tank' && v.def.seats !== 0) { const a = assaults.find(q => !q.mounted && q.men > 0); if (a) { a.mounted = true; sq = squadOf(a, x, z + 6); } }
      if (sq) { sq.board(v, true); list.splice(list.length - 1, 0, sq); }
    } else if (r.men > 0) list.push(squadOf(r, x, z));
  }
  for (const a of assaults) delete a.mounted;
  if (side === 'player' && C.mode === 'defend') {
    // defending: besides the staging ground, the objectives and the trench systems are open to set up on (game.setDefence:
    // nothing nearer the attacker's staging ground than the no-camp distance) - positions prepared in advance
    const A = game.setDefence('player');
    if (A.length) setTimeout(() => game.hud?.alert(`Defence: place your units on the objectives and in the trenches (ringed) or keep them back on the staging ground. ${A.length} position${A.length > 1 ? 's' : ''} open.`, 'good'), 2500);
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
    applyVehicleKits(v);   // vehicle upgrades from the campaign tech tree (M.kits): kit meshes + effects
    if (M.copeCage) v.cage = Math.min(0.9, (v.cage || 0) + M.copeCage);
    if (v.kind === 'spg' && M.artyAmmo) v.weapons[0].ammo = Math.round(v.weapons[0].ammo * (1 + M.artyAmmo));
  }
  if (side === 'player' && M.mortar) game.mortars += M.mortar;
}

// what happened to each persistent unit: campaignResult.js (no three.js imports: the node rule tests run it)
export { collectResult } from './campaignResult.js';

// small helpers for upgrade effects elsewhere in the battle code
export { modOf } from './campaignResult.js';
export const vetOf = u => (u?.squad?.vet ?? u?.vet ?? 0);
export { THREE };
