// What happened to each persistent campaign unit in a battle (the per-unit result the campaign applies:
// src/campaign/v2/state.js applyResult; versus: campaign/v2/versus.js applyBattle with both sides' results).
// No imports (three.js, the map ...): the node rule tests (src/campaign/v2/tools/test_rules.mjs) run it on fake battles.
//
// The unit records that went into the battle are kept on the game by deployCampaign (game.campRecs[side]); every
// deployed unit gets an entry, so a unit is never left out of the result (applyResult leaves units that are not in it
// untouched = their pre-battle count):
//  - squads (sq.rec = unit uid): every man counted — fit (ok / light), wounded (critical / stable / evacuated), dead;
//    men killed in their carrier (game.passengersOnKill) are dead; a squad wiped out = 0 fit, 0 wounded
//  - vehicles (v.rec): lost when knocked out (or at 0 hp), otherwise their hp fraction
//  - tank / SPG units (no squad of their own: the unit's men ARE the vehicle crew): the crew inside the vehicle
//    (v.crewList) plus the crew that bailed out (vehicle.bailCrew squad, sq.crewOf = the vehicle's rec); scaled to the
//    unit's men when the battle crew is a different size. The crew of a carrier of a mech unit is not part of its men.

export const modOf = (game, side, key, dflt = 0) => game.mods?.[side]?.[key] ?? dflt;
// unit kinds whose men are the vehicle's crew (no dismounts)
export const CREW_KINDS = new Set(['tank', 'spg']);
export const crewUnit = r => !!(r && r.veh && CREW_KINDS.has(r.kind));

const WOUNDED = new Set(['critical', 'stable', 'evac']);

export function collectResult(game, side = 'player') {
  const C = game.campaign || {}, os = side === 'player' ? 'enemy' : 'player';
  const P = game.stats?.[side] || {}, E = game.stats?.[os] || {}, units = {};
  const won = side === 'player' ? !!game.result?.win : !game.result?.win;
  const recs = game.campRecs?.[side] || (side === 'player' ? C.force : game.opts?.net?.enemyForce) || [];
  const recOf = uid => recs.find(r => r.uid === uid);
  const entry = uid => (units[uid] ||= { uid, alive: 0, wounded: 0, saved: 0, diedOfWounds: 0, kills: 0, vehLost: false, vehHp: 1 });
  // wounded still lying out on the field at the end (never evacuated) may not make it: more of them when the ground is lost;
  // men evacuated (state 'evac': by their carrier or the medevac pickup, game/medevac.js -> soldier.saved) all come back
  // (campaign tech medSave — stabilisation point, blood forward, armoured ambulances: fewer of them die of their wounds)
  const care = 1 - Math.min(0.75, modOf(game, side, 'medSave')), rnd = game.rnd || Math.random;
  const dow = s => (s.state === 'critical' ? (won ? 0.25 : 0.6) : s.state === 'stable' ? (won ? 0.05 : 0.3) : 0) * care;
  // one man's fate into a result entry (c: counter for a crew, scaled later)
  const count = (u, s) => {
    if (!s || s.state === 'dead' || s.lostInVeh) return;
    if (WOUNDED.has(s.state)) { if (s.state !== 'evac' && rnd() < dow(s)) { u.diedOfWounds++; return; } u.wounded++; if (s.saved || s.onBed) u.saved++; }
    else u.alive++;
  };
  // squads of the units (not the bailed-out crews: below)
  for (const sq of game.squads || []) {
    if (sq.side !== side || sq.rec == null) continue;
    const u = entry(sq.rec);
    for (const s of sq.soldiers) count(u, s);
    u.kills += Math.round(sq.stats?.kills || 0);
  }
  // vehicles; the crews of tank / SPG units
  const crews = {};
  for (const v of game.vehicles || []) {
    if (v.side !== side || v.rec == null) continue;
    const u = entry(v.rec), lost = !!v.destroyed || !(v.hp > 0);
    u.vehLost = lost; u.vehHp = lost ? 0 : Math.max(0, Math.min(1, v.hp / (v.def?.hp || v.hp)));
    u.kills += Math.round(v.stats?.kills || 0);
    if (!crewUnit(recOf(v.rec))) continue;
    const c = crews[v.rec] ||= { n: 0, alive: 0, wounded: 0, saved: 0, diedOfWounds: 0, lost };
    const list = v.crewList;
    if (!list) { c.n += 3; if (!lost) c.alive += 3; continue; }   // (no crew model: the crew shares the vehicle's fate)
    c.n += list.length;
    // still inside (not bailed out): alive unless hit; a hit crewman who lived is wounded. A knocked-out vehicle the crew
    // never left (catastrophic kill, ammunition) killed them; the men who got out are in the crew squad
    if (!v.abandoned && !v.destroyed) for (const m of list) { if (m.hp >= 100) c.alive++; else if (m.hp > 0) c.wounded++; }
  }
  for (const sq of game.squads || []) {
    if (sq.side !== side || sq.crewOf == null || sq.rec != null || !crews[sq.crewOf]) continue;
    for (const s of sq.soldiers) count(crews[sq.crewOf], s);
    entry(sq.crewOf).kills += Math.round(sq.stats?.kills || 0);
  }
  for (const [uid, c] of Object.entries(crews)) {
    const rec = recs.find(r => String(r.uid) === uid), u = units[rec ? rec.uid : uid], M = Math.max(0, rec?.men ?? c.n);
    // scaled to the unit's men (a battle crew of 3 for a gun crew of 5 ...): fit first, then the wounded, the rest dead
    const k = c.n ? M / c.n : 0;
    u.alive = Math.min(M, Math.round(c.alive * k)); u.wounded = Math.min(M - u.alive, Math.round(c.wounded * k));
    u.saved = Math.min(u.wounded, Math.round(c.saved * k)); u.diedOfWounds += Math.round(c.diedOfWounds * k);
  }
  // casualties stay casualties: never more men back than went in
  for (const u of Object.values(units)) {
    const r = recOf(u.uid); if (!r) continue;
    const M = Math.max(0, r.men || 0); u.alive = Math.min(u.alive, M); u.wounded = Math.min(u.wounded, M - u.alive);
  }
  const win = won;
  return { sector: C.sector, mode: side === 'player' ? C.mode : (C.mode === 'attack' ? 'defend' : 'attack'), win, units: Object.values(units), enemyKia: E.kia || 0, enemyVehLost: E.vehLost || 0,
    objectivesHeld: (game.objectives || []).filter(o => o.owner === side).length, losses: P.kia || 0, time: game.time };
}
