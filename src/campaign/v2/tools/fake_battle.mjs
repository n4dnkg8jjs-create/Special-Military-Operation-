// Fake battle maps for the node rule tests (test_rules.mjs single player, test_versus.mjs): the squads and vehicles
// deployCampaign (src/game/campaignBattle.js) would put on the map for a list of unit records, the fates a battle
// can give them, and the real collectResult (src/game/campaignResult.js) over them.
import { collectResult, crewUnit } from '../../../game/campaignResult.js';
export { collectResult };

const ROLES_N = { mech: 8, imech: 8, assault: 6, atgm: 3, fpv: 2, tank: 8, spg: 8 };
// the battle objects of one side (same rules as deployCampaign: which units deploy, squad sizes, crews)
export function deploy(game, side, recs) {
  const R = recs.filter(u => crewUnit(u) ? !u.veh.lost : (u.men > 0 || (u.veh && !u.veh.lost)));
  (game.campRecs ||= {})[side] = R.map(u => ({ uid: u.uid, kind: u.kind, men: u.men || 0, veh: u.veh ? { ...u.veh } : null }));
  for (const r of R) {
    let v = null;
    if (r.veh && !r.veh.lost) {
      v = { type: 'vehicle', side, rec: r.uid, kind: r.veh.kind, def: { hp: 1000 }, hp: 1000 * Math.max(0.2, r.veh.hp ?? 1), destroyed: false, abandoned: false, stats: { kills: 0 },
        crewList: [{ role: 'commander', hp: 100 }, { role: 'gunner', hp: 100 }, { role: 'driver', hp: 100 }, ...(r.veh.kind === 'spg' ? [{ role: 'loader', hp: 100 }, { role: 'loader', hp: 100 }] : [])] };
      game.vehicles.push(v);
    }
    if (crewUnit(r) || !(r.men > 0)) continue;
    const n = Math.max(1, Math.min(r.men, ROLES_N[r.kind] || 8));
    game.squads.push({ type: 'squad', side, rec: r.uid, kind: r.kind, carrier: v, mounted: !!v, stats: { kills: 0 }, soldiers: Array.from({ length: n }, () => ({ state: 'ok', aboard: !!v })) });
  }
  return game;
}
export function fakeGame(C, mode = 'attack', sector = null) {
  return { campaign: { sector, mode, force: [] }, squads: [], vehicles: [], stats: { player: { kia: 0, vehLost: 0, wia: 0 }, enemy: { kia: 0, vehLost: 0, wia: 0 } }, objectives: [], result: { win: false }, time: 600, rnd: () => 0.99 };
}
const sqOf = (g, side, uid) => g.squads.find(s => s.side === side && s.rec === uid);
const vOf = (g, side, uid) => g.vehicles.find(v => v.side === side && v.rec === uid);
// what a battle did to a unit; returns the expected { men, wounded, vehLost } after applyResult (wounded = added)
export const FATES = {
  // every man of the squad killed
  wiped(g, side, u) { for (const s of sqOf(g, side, u.uid).soldiers) s.state = 'dead'; return { men: 0, wounded: 0 }; },
  // the vehicle knocked out, one crewman killed, two got out (vehicle.bailCrew: a crew squad, crewOf = the vehicle's rec):
  // one fit, one wounded
  bailed(g, side, u) {
    const v = vOf(g, side, u.uid); v.destroyed = true; v.abandoned = true; v.hp = -50; v.crewList[0].hp = 0;
    const out = v.crewList.slice(1);
    g.squads.push({ type: 'squad', side, crew: true, crewOf: u.uid, stats: { kills: 1 }, soldiers: out.map((c, i) => ({ state: i === 0 ? 'ok' : 'stable' })) });
    const n = v.crewList.length, k = u.men / n;
    const alive = Math.round(1 * k), wounded = Math.min(u.men - alive, Math.round((out.length - 1) * k));
    return { men: alive, wounded, vehLost: true };
  },
  // ammunition cook-off: the crew never got out
  brewup(g, side, u) { const v = vOf(g, side, u.uid); v.destroyed = true; v.abandoned = true; v.hp = 0; for (const c of v.crewList) c.hp = 0; return { men: 0, wounded: 0, vehLost: true }; },
  // the carrier knocked out with the squad inside: half killed in the troop compartment (game.passengersOnKill:
  // lostInVeh), one wounded, the rest got out; the carrier's own crew bailed out (not the unit's men)
  mountedKilled(g, side, u) {
    const v = vOf(g, side, u.uid), sq = sqOf(g, side, u.uid); v.destroyed = true; v.abandoned = true; v.hp = 0;
    g.squads.push({ type: 'squad', side, crew: true, crewOf: u.uid, stats: { kills: 0 }, soldiers: [{ state: 'ok' }, { state: 'ok' }, { state: 'ok' }] });
    const n = sq.soldiers.length, dead = Math.ceil(n / 2);
    sq.soldiers.forEach((s, i) => { s.aboard = false; if (i < dead) { s.state = 'dead'; s.lostInVeh = true; } else if (i === dead) s.state = 'critical'; });
    return { men: Math.max(0, n - dead - 1), wounded: n > dead ? 1 : 0, vehLost: true };
  },
  // two wounded evacuated by the medevac pickup (state 'evac', saved), one killed, the rest fit
  evac(g, side, u) {
    const sq = sqOf(g, side, u.uid); const n = sq.soldiers.length;
    sq.soldiers.forEach((s, i) => { if (i < 2) { s.state = 'evac'; s.saved = true; } else if (i === 2) s.state = 'dead'; });
    return { men: Math.max(0, n - 3), wounded: Math.min(2, n) };
  },
  // a vehicle unit that came through untouched (its crew is its men: they all come back)
  intact(g, side, u) { return { men: u.men, wounded: 0, vehLost: false }; },
};
// the fate that fits a unit (by its kind), cycling through the list
export function fateFor(u, i) {
  if (crewUnit(u)) return ['bailed', 'brewup', 'intact'][i % 3];
  if (u.veh && !u.veh.lost && u.men > 0) return ['mountedKilled', 'evac'][i % 2];
  if (u.men > 0) return ['wiped', 'evac'][i % 2];
  return null;
}
// give every deployed unit of a side a fate; returns [{ uid, name, fate, men0, wounded0, exp }]
export function fight(g, side, units, offset = 0) {
  const out = [];
  units.forEach((u, i) => {
    const f = fateFor(u, i + offset); if (!f) return;
    if (crewUnit(u) ? !vOf(g, side, u.uid) : !sqOf(g, side, u.uid)) return;   // (did not deploy)
    out.push({ uid: u.uid, name: u.name, kind: u.kind, fate: f, men0: u.men, wounded0: u.wounded || 0, exp: FATES[f](g, side, u) });
  });
  return out;
}
// after applyResult: each unit's men / wounded / vehicle as the battle left it
export function verify(C, plan, ok, tag) {
  for (const p of plan) {
    const u = C.unit(p.uid), w = `${tag}: ${p.name} (${p.kind}, ${p.fate})`;
    ok(!!u, `${w}: unit still on the roll`); if (!u) continue;
    ok(u.men === p.exp.men, `${w}: men ${u.men}, expected ${p.exp.men} (was ${p.men0})`);
    ok(u.wounded === p.wounded0 + p.exp.wounded, `${w}: wounded ${u.wounded}, expected ${p.wounded0 + p.exp.wounded}`);
    ok(u.men + u.wounded <= p.men0 + p.wounded0, `${w}: no more men than went in`);
    if (p.exp.vehLost != null && u.veh) ok(u.veh.lost === p.exp.vehLost && (u.veh.lost ? u.veh.hp === 0 : u.veh.hp >= 0.1), `${w}: vehicle lost ${u.veh.lost} hp ${u.veh.hp}, expected lost ${p.exp.vehLost}`);
    if (u.veh && !u.veh.lost) ok(u.veh.hp >= 0.1, `${w}: a kept vehicle never shows 0 hp (${u.veh.hp})`);
    if (p.fate !== 'intact' && p.fate !== 'evac') ok(u.men < p.men0, `${w}: not back at its original count (${u.men}/${p.men0})`);
  }
}
