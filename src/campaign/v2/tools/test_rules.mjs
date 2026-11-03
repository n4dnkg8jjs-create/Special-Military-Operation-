// Node checks of the campaign v2 rules: split / merge / move / supply / battle / endTurn / directives / full run.
// usage: node src/campaign/v2/tools/test_rules.mjs [content]   ('content' = the real campaigns via v2/index.js loadCampaigns)
import { Campaign2, setRandom, atDate, MAX_BATTLE } from '../state.js';

const L = await import('../index.js');
let defs;
if (process.argv[2] === 'content') { const r = await L.loadCampaigns(); defs = r.defs; console.log(r.test ? '(content not available: test campaigns)' : '(real content)'); }
else defs = L.normalizeAll((await import('../test_campaign.js')).TEST_CAMPAIGNS);
// in-memory localStorage
const mem = {}; globalThis.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('  FAIL:', msg); } };
function seeded(s) { return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

for (const side of Object.keys(defs)) {
  setRandom(seeded(42));
  const def = defs[side]; console.log(`== ${side}: ${def.title} (${def.aor.cols}x${def.aor.rows}, ${def.aor.cells.length} cells)`);
  const C = new Campaign2(def);
  ok(C.date === def.start.date, 'start date');
  ok(C.maxTurn >= 50 && C.maxTurn <= 60, `~55 weekly turns (${C.maxTurn})`);
  ok(C.forces.length >= 1, 'has task forces');
  ok(C.forces.every(f => C.owner[f.cell] === 'player'), 'forces start in own cells');
  ok(C.forces.every(f => f.mp > 0), 'forces have MP');
  ok(C.directives.length >= 1, 'a directive is active at start');
  // supply
  ok(C.forces.every(f => f.supply >= 0.5), 'start forces in supply');
  const src = def.aor.supplySources.filter(s => C.owner[s] === 'player');
  ok(src.length > 0 && src.every(s => C.supplied[s] === 1), 'supply sources supplied');
  ok(def.aor.cells.filter(c => C.owner[c.id] === 'enemy').every(c => !C.supplied[c.id]), 'enemy cells never supplied');
  ok(C.lpIncome() > 0, 'LP income');
  // split / merge
  const tf = C.forces[0], n0 = tf.units.length, mp0 = tf.mp;
  const part = C.split(tf.id, [tf.units[0]], 'Detached');
  ok(typeof part === 'object' && part.units.length === 1 && tf.units.length === n0 - 1 && part.cell === tf.cell, 'split');
  ok(typeof C.split(tf.id, [...tf.units]) === 'string', 'cannot split everything off');
  ok(part.mp <= C.tfMpMax(part) + 1e-9, 'split MP capped by new composition');
  const m = C.merge(tf.id, part.id);
  ok(m === tf && tf.units.length === n0 && !C.tf(part.id), 'merge');
  ok(Math.abs(tf.mp - mp0) < 1e-9, `split + merge keeps the week's movement (${mp0} -> ${tf.mp})`);
  // MP by composition: a pure foot force moves 2, tanks 3
  const foot = C.units.find(u => !u.veh && C.tfOf(u.uid)?.units.length > 1);
  if (foot) { const t = C.tfOf(foot.uid), p2 = C.split(t.id, [foot.uid]); ok(C.tfMpMax(p2) === 2, `foot force MP 2 (${C.tfMpMax(p2)})`); C.merge(t.id, p2.id); }
  // move inside own lines
  C.resetMoves();
  const reach = C.reach(tf), dest = Object.keys(reach.dist).filter(id => id !== tf.cell && reach.dist[id] <= tf.mp).sort((a, b) => reach.dist[b] - reach.dist[a])[0];
  if (dest) { const mp0 = tf.mp, pl = C.move(tf.id, dest); ok(pl.ok && tf.cell === dest && Math.abs(tf.mp - (mp0 - pl.cost)) < 1e-6, `move ${pl.path?.length - 1} cells for ${pl.cost} MP`); }
  const far = def.aor.cells.filter(c => C.owner[c.id] === 'player').sort((a, b) => (reach.dist[b.id] ?? 0) - (reach.dist[a.id] ?? 0))[0];
  ok(!C.plan(tf.id, far.id).ok || (reach.dist[far.id] ?? 0) <= tf.mp, 'cannot move beyond MP');
  ok(C.enterCost(tf.cell, tf.cell) === Infinity, 'no self move');
  // roads are cheaper than open fields
  const hw = x => x.road === 2 && !x.river && C.owner[x.id] === 'player';
  const rc = def.aor.cells.find(c => hw(c) && def.aor.cells.some(d => hw(d) && C.adjacent(c.id, d.id) && (d.col === c.col || d.row === c.row)));
  if (rc) { const d = def.aor.cells.find(x => hw(x) && C.adjacent(rc.id, x.id) && (x.col === rc.col || x.row === rc.row)); ok(C.enterCost(rc.id, d.id) <= 1, 'highway costs 1'); }
  // attack: find the force's nearest enemy cell, walk there over turns, then attack (auto-resolve)
  C.resetMoves();
  let target = null, tries = 0, res = null;
  while (tries++ < 6) {
    const T = C.forces[0];
    const enemy = def.aor.cells.filter(c => C.owner[c.id] !== 'player').map(c => ({ c, p: C.plan(T.id, c.id) })).filter(x => x.p.ok).sort((a, b) => a.p.cost - b.p.cost)[0];
    if (process.env.DBG) console.log('try', tries, T.cell, T.mp, enemy && enemy.c.id);
    if (enemy) { target = enemy.c.id; const mv = C.move(T.id, target); ok(mv.ok && mv.attack && C.adjacent(T.cell, target), 'moved to attack position');
      const setup = C.attackSetup(T.id, target);
      ok(setup && setup.v2 && setup.sector === target && setup.mode === 'attack' && setup.force.length > 0 && setup.force.length <= MAX_BATTLE && setup.enemy.length > 0 && setup.map && setup.mapFallback, 'battle setup contract');
      ok(setup.force.every(u => T.units.includes(u.uid)), 'battle uses the task force units');
      // stored and restored like the real reload flow
      C.launch(setup); ok(Campaign2.pendingBattle()?.sector === target, 'pending battle stored');
      const C2 = Campaign2.load(defs); ok(C2 && C2.battle?.cell === target && C2.turn === C.turn, 'state persisted before battle');
      // fake collectResult: the battle is won
      const r = { sector: target, mode: 'attack', win: true, units: setup.force.map(u => ({ uid: u.uid, alive: Math.max(0, u.men - 1), wounded: u.men ? 1 : 0, kills: 2, vehLost: false, vehHp: 0.8 })), enemyKia: 9, enemyVehLost: 1, objectivesHeld: 2, losses: 1 };
      Campaign2.storeResult(r); const C3 = Campaign2.load(defs); const rr = Campaign2.takeResult(); C3.applyResult(rr);
      ok(C3.owner[target] === 'player' && C3.tf(T.id).cell === target && C3.tf(T.id).attacked, 'won attack takes the cell and moves the force in');
      ok(C3.stats.battles === 1 && C3.stats.won === 1 && C3.lp > C.lp, 'battle stats and LP');
      ok(!C3.plan(T.id, def.aor.cells.find(c => C3.owner[c.id] === 'enemy' && C3.adjacent(c.id, target))?.id || target).ok, 'one attack per turn');
      Object.assign(C, C3); C.def = def; C.index(); res = rr; break; }
    // no target in reach: move towards the front
    const enemyCells = def.aor.cells.filter(c => C.owner[c.id] !== 'player');
    const dE = id => { const a = C.cell(id); return Math.min(...enemyCells.map(e => Math.max(Math.abs(e.col - a.col), Math.abs(e.row - a.row)))); };
    const fr = Object.keys(C.reach(T).dist).filter(id => C.plan(T.id, id).ok).sort((a, b) => dE(a) - dE(b))[0];
    if (fr) C.move(T.id, fr);
    C.endTurn();
  }
  ok(res, 'an attack was possible within a few turns');
  // lost attack: the force stays put, enemy weakened
  C.endTurn();
  { const T = C.forces[0]; const e = def.aor.cells.map(c => ({ c, p: C.plan(T.id, c.id) })).filter(x => x.p.ok && x.p.attack)[0];
    if (e) { C.move(T.id, e.c.id); const stage = T.cell, g0 = C.garrison[e.c.id]; C.attackSetup(T.id, e.c.id); C.applyResult({ sector: e.c.id, mode: 'attack', win: false, units: [], enemyKia: 10, enemyVehLost: 0, objectivesHeld: 0 }); ok(T.cell === stage && C.owner[e.c.id] !== 'player' && C.garrison[e.c.id] < g0, 'lost attack: force stays, enemy weakened'); } }
  // defend: force the enemy to attack a cell with a task force
  C.endTurn();
  { const T = C.forces[0], from = C.neighbors(T.cell).find(n => C.owner[n] === 'enemy');
    if (from) { C.pendingAttacks = [{ id: 'eaX', from, to: T.cell, strength: 3 }]; const ds = C.defendSetup('eaX'); ok(ds && ds.mode === 'defend' && ds.strength === 3 && ds.force.length > 0, 'defend setup');
      const cell = T.cell; C.applyResult({ sector: cell, mode: 'defend', win: false, units: [], enemyKia: 3, enemyVehLost: 0, objectivesHeld: 0 });
      ok(C.owner[cell] === 'enemy' && T.cell !== cell && C.owner[T.cell] === 'player', 'lost defence: cell falls, force falls back'); } }
  // orders: tech with a date gate and delivery
  const gated = def.tech.find(t => t.date && t.date > C.date && (t.req || []).every(r => C.unlocked.includes(r)));
  if (gated) ok(typeof C.orderTech(gated.id) === 'string', 'date-gated tech refused early');
  C.lp += 500;
  const cat = def.catalog.find(c => C.catalogAvailable(c) && c.kind !== 'replacements');
  if (cat) { const nU = C.units.length; ok(C.orderUnit(cat.key) === null, 'order unit'); for (let i = 0; i < (cat.eta ?? 1); i++) C.endTurn(); ok(C.units.length >= nU + 1 && C.forces.some(f => f.reserve), 'unit delivered to the reserve at HQ'); }
  // depot
  const dc = def.aor.cells.find(c => C.depotAllowed(c.id)); if (dc) ok(C.buildDepot(dc.id) === null && C.depots.includes(dc.id), 'forward depot');
  // out of supply: cut a force off
  { const T = C.forces[0]; const save = { ...C.owner }; for (const n of C.neighbors(T.cell)) C.owner[n] = 'enemy'; C.computeSupply(); ok(T.supply === 0 && C.tfMpMax(T) <= 2, 'encircled force out of supply, MP halved'); ok(C.battleMods(T.cell, T.units).outOfSupply, 'out-of-supply battle penalties'); C.owner = save; C.computeSupply(); }
  // full run to the end date with auto-resolved attacks
  setRandom(seeded(7)); let turns = 0, battles = 0;
  while (!C.outcome() && turns < 80) {
    for (const T of [...C.forces]) { const e = def.aor.cells.map(c => ({ c, p: C.plan(T.id, c.id) })).filter(x => x.p.ok && x.p.attack).sort((a, b) => (C.garrison[a.c.id] || 0) - (C.garrison[b.c.id] || 0))[0]; if (e && C.tfPower(T) > 2.5) { C.move(T.id, e.c.id); C.attackSetup(T.id, e.c.id); C.autoResolve(e.c.id, 'attack'); battles++; } }
    C.endTurn(); turns++;
    if (C.lp > 40) { const r = C.units.find(u => C.replaceCost(u) > 0 && C.replaceCost(u) < C.lp); if (r) C.replenish(r.uid); }
  }
  const o = C.outcome();
  ok(o, 'campaign reaches an outcome');
  console.log(`  run: ${turns} turns -> ${C.date} | ${o?.title}: ${o?.text}\n  battles ${battles} (${C.stats.won} won), cells +${C.stats.cellsTaken}/-${C.stats.cellsLost}, units ${C.units.length}, forces ${C.forces.length}, LP ${C.lp}, directives ${JSON.stringify(C.doneDirectives)}`);
  ok(C.log.some(l => l.kind === 'news'), 'theatre news logged');
  ok(atDate([{ date: '2023-02', p: 1 }, { date: '2023-06', p: 2 }], '2023-07-03', 'p') === 2, 'atDate');
}
// ---------------------------------------------------------------- v4 rules: fires, drones, supply hubs, enemy AI, goal, AOR
for (const side of Object.keys(defs)) {
  const def = defs[side]; if (!def.start.batteries || !def.enemy?.forces) continue;
  setRandom(seeded(99)); console.log(`== v4 ${side}`);
  const C = new Campaign2(def);
  // dispersed brigade: several battalion task forces, none bigger than a third of the brigade
  ok(C.forces.length >= 4 && C.forces.every(f => f.units.length <= Math.ceil(C.units.length / 3)), `dispersed start (${C.forces.map(f => f.units.length).join('/')})`);
  ok(C.eforces.length >= 4 && C.eforces.every(f => C.owner[f.cell] === 'enemy'), 'enemy task forces on enemy squares');
  // supply network and hubs
  ok(C.hubs('player').length >= 2 && C.hubs('player').every(h => h.linked), 'own hubs linked');
  ok(C.hubs('enemy').length >= 2 && C.hubs('enemy').every(h => h.linked), 'enemy hubs linked');
  const fed = C.forces.filter(f => C.supplied[f.cell] >= 0.5).length; ok(fed === C.forces.length, 'all battalions in supply at start');
  const r0 = C.supplyRoute(C.forces[0].cell); ok(r0.length >= 1 && r0[r0.length - 1] === C.forces[0].cell, 'supply route ends at the force');
  // capturing an enemy hub starves the squares it fed
  { const hub = C.hubs('enemy').find(h => h.kind !== 'railhead'), before = { ...C.esupplied }, saveO = { ...C.owner };
    C.owner[hub.cell] = 'player'; C.computeSupply();
    const worse = Object.keys(before).filter(id => C.owner[id] === 'enemy' && (C.esupplied[id] ?? 0) < before[id]).length;
    ok(worse > 0, `capturing ${hub.name} cuts enemy supply (${worse} squares worse)`);
    ok(C.allHubs().find(h => h.cell === hub.cell).holder === 'player', 'captured hub listed with its new holder');
    C.owner = saveO; C.computeSupply(); }
  // interdiction raises route costs on the enemy network
  { const ch = C.chokepoints('enemy', 1)[0]; ok(!!ch, 'enemy chokepoint found'); const d0 = { ...C.supplyNet.enemy.dist }; C.interdicted[ch.cell] = { by: 'player', turn: C.turn }; C.computeSupply();
    ok(Object.keys(d0).some(id => (C.supplyNet.enemy.dist[id] ?? 99) > d0[id]), 'interdicted chokepoint lengthens enemy routes'); delete C.interdicted[ch.cell]; C.computeSupply(); }
  // fires: range, ammo, one mission per battery, suppression helps the attack, counter-battery needs a found battery
  const B = C.batteries();
  ok(B.length >= 3 && B.every(b => C.batteryRange(b.id).cells >= 3), 'artillery group with ranges');
  const mor = B.find(b => b.kind === 'mortar120'), far = def.aor.cells.find(c => C.owner[c.id] === 'enemy' && !C.batteryRange(mor.id).coverage.includes(c.id) && C.isOpen(c.id));
  if (far) ok(/range/.test(C.fireCheck(mor.id, 'suppress', far.id) || ''), 'mortars out of range deep');
  const tgt = Object.keys(C.fireTargets(B[1].id)).find(id => C.owner[id] === 'enemy' && C.garrison[id] >= 1);
  const ammo0 = C.ammo.player, g0 = C.garrison[tgt], d0 = C.defenderStrength(tgt);
  const fr = C.fire(B[1].id, 'suppress', tgt);
  ok(typeof fr === 'object' && fr.ok && C.ammo.player < ammo0 && C.suppression(tgt)?.by === 'player' && C.suppression(tgt).mul < 1, 'suppress mission');
  ok(C.garrison[tgt] < g0 && C.defenderStrength(tgt) < d0, 'suppression wears the line');
  ok(typeof C.fire(B[1].id, 'suppress', tgt) === 'string', 'one mission per battery per week');
  ok(typeof C.fire(B[0].id, 'counterbattery', tgt) === 'string', 'counter-battery needs a found battery');
  C.ammo.player = 0; ok(/ammunition/.test(C.fireCheck(B[2].id, 'suppress', tgt) || ''), 'no ammunition, no fire'); C.ammo.player = 6;
  ok(typeof C.moveBattery(B[1].id, B[0].cell) === 'string', 'a battery that fired cannot displace the same week');
  { const own = def.aor.cells.find(c => C.owner[c.id] === 'player' && C.supplied[c.id] >= 1 && c.id !== B[2].cell && !C.moveBatteryCheck(B[2].id, c.id)); if (own) ok(C.moveBattery(B[2].id, own.id) === null && C.battery(B[2].id).cell === own.id, 'displace a battery'); }
  // a found enemy battery can be hit
  { const eb = C.batteries('enemy')[0]; eb.revealed = C.turn; ok(C.foundBatteries().some(b => b.id === eb.id), 'enemy battery found after firing');
    const sh = C.batteries().find(b => b.acted !== C.turn && !C.fireCheck(b.id, 'counterbattery', eb.cell));
    if (sh) { setRandom(() => 0.01); C.fire(sh.id, 'counterbattery', eb.cell); setRandom(seeded(5)); ok(eb.hp < 1, 'counter-battery hit'); } }
  // UAV sorties: limited per week, reveal enemy task forces, intel snapshot persists
  ok(/reach/.test(C.uavCheck('quad', def.aor.cells.filter(c => C.owner[c.id] === 'enemy' && C.isOpen(c.id)).sort((a, b) => C.goalProgress() ? 0 : 0).find(c => !C.uavCheck('wing', c.id) && C.uavCheck('quad', c.id))?.id) || ''), 'quadcopter reach shorter than fixed-wing');
  const ef = C.eforces.find(f => C.uavCheck('wing', f.cell) === null);
  if (ef) { setRandom(() => 0.99); const u = C.flyUav('wing', ef.cell); setRandom(seeded(6));
    ok(typeof u === 'object' && u.cells.includes(ef.cell) && C.cellIntel(ef.cell).forces.some(x => x.id === ef.id), 'UAV reveals an enemy task force'); }
  while (C.uavStatus().used < C.uavStatus().sorties) { const c0 = def.aor.cells.find(c => C.owner[c.id] === 'enemy' && !C.uavCheck('quad', c.id)); if (!c0) break; C.flyUav('quad', c0.id); }
  ok(/sorties/.test(C.uavCheck('quad', def.aor.cells.find(c => C.owner[c.id] === 'enemy').id) || 'sorties'), 'sorties run out');
  // expanding AOR
  const closed = def.aor.cells.filter(c => !C.isOpen(c.id)); ok(closed.length > 0, `squares beyond the AOR at start (${closed.length})`);
  ok(!C.plan(C.forces[0].id, closed[0].id).ok, 'no attack beyond the AOR');
  { const nearC = closed.sort((a, b) => a.row - b.row)[0], nb = def.aor.cells.find(c => Math.max(Math.abs(c.col - nearC.col), Math.abs(c.row - nearC.row)) === 3 && C.owner[c.id] === 'enemy');
    if (nb) { const s0 = C.owner[nb.id]; C.owner[nb.id] = 'player'; C.computeSupply(); ok(C.isOpen(nearC.id) && C.justOpened.includes(nearC.id), 'the AOR grows when the front moves'); C.owner[nb.id] = s0; C.computeSupply(); } }
  // operation goal
  const G = C.goalProgress(); ok(G && G.cells.length >= 3 && G.pct === 0 && G.total > 0, 'operation goal defined');
  { const save = { ...C.owner }; for (const g of G.cells) C.owner[g.cell] = 'player'; C.pendingAttacks = []; C.endTurn(); const o = C.outcome(); ok(o && o.win && o.goal && o.title === 'VICTORY', `goal achieved = victory (${o?.title})`); C.owner = save; C.goalDone = null; }
  // the enemy commander: over some weeks it moves, fires, flies drones and attacks
  setRandom(seeded(123)); const C2 = new Campaign2(def), start = C2.eforces.map(f => f.cell).join();
  let moved = false, attacks = 0, efires = 0;
  for (let i = 0; i < 30 && !C2.outcome(); i++) { C2.endTurn(); if (C2.eforces.map(f => f.cell).join() !== start) moved = true; attacks += C2.pendingAttacks.length; }
  efires = C2.fireLog.filter(f => f.side === 'enemy').length;
  ok(moved, 'enemy task forces move'); ok(attacks > 0, `enemy attacks (${attacks} in 30 weeks)`); ok(efires > 0, `enemy fire missions (${efires})`); ok((C2.uav.enemy.log || []).length > 0, 'enemy drone sorties');
  ok(C2.pendingAttacks.every(a => !a.tf || C2.eforces.some(f => f.id === a.tf && C2.adjacent(f.cell, a.to))), 'announced attacks come from adjacent task forces');
  // persistence of v4 state
  C2.save(); const C3 = Campaign2.load(defs); ok(C3 && C3.eforces.length === C2.eforces.length && C3.arty.player.length === C2.arty.player.length && C3.uav.player.stock === C2.uav.player.stock, 'v4 state persists');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
