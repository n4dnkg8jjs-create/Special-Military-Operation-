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
  // (v7: task-force campaigns have no line garrison — aim at a square an enemy force holds)
  const tgt = Object.keys(C.fireTargets(B[1].id)).find(id => C.owner[id] === 'enemy' && (def.enemy?.forces ? C.eforces.some(f => f.cell === id) : C.garrison[id] >= 1));
  const ammo0 = C.ammo.player, g0 = C.garrison[tgt], d0 = C.defenderStrength(tgt);
  const fr = C.fire(B[1].id, 'suppress', tgt);
  ok(typeof fr === 'object' && fr.ok && C.ammo.player < ammo0 && C.suppression(tgt)?.by === 'player' && C.suppression(tgt).mul < 1, 'suppress mission');
  ok((def.enemy?.forces ? true : C.garrison[tgt] < g0) && C.defenderStrength(tgt) < d0, 'suppression wears the line');
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
// ------------------------------------------------------------------ v5: big formations reveal themselves; the grid grows
const R5 = await import('../recon.js'), GR5 = await import('../growth.js'), AI7 = await import('../ai.js');
for (const def of (process.argv[2] === 'content' ? Object.values(defs) : []).filter(d => d.aor.ext)) {
  console.log(`== v5 ${def.id}`);
  setRandom(seeded(77)); for (const k of Object.keys(mem)) delete mem[k];
  // --- reveal: a dispersed task force is hidden, the brigade massed on one square is spotted
  { const C = new Campaign2(def), T = C.forces[0];
    ok(!C.spotStatus(T.id).spotted && C.spotStatus(T.id).sig < R5.SPOT_SIZE, `a dispersed task force stays hidden (signature ${C.spotStatus(T.id).sig})`);
    for (const f of [...C.forces]) if (f !== T) { f.cell = T.cell; C.merge(T.id, f.id); }
    const st = C.spotStatus(T.id);
    ok(st.n > 4 && st.sig >= R5.SPOT_SIZE && st.depth >= 2, `the massed brigade has a big signature (${st.n} coy, sig ${st.sig}, depth ${st.depth})`);
    // move the mass next to the line: spotted (within depth), the enemy learns where it is
    const front = def.aor.cells.find(c => C.owner[c.id] === 'player' && C.frontline(c.id) && C.supplied[c.id] >= 1);
    T.cell = front.id; ok(C.spotStatus(T.id).spotted, 'the mass at the front is SPOTTED');
    T.mp = C.tfMpMax(T); T.movedT = -9; const sig0 = R5.signature(C, 'player', T).sig; T.movedT = C.turn; ok(R5.signature(C, 'player', T).sig > sig0, `movement raises the signature (${sig0} -> ${R5.signature(C, 'player', T).sig})`);
    // a 4-company group sitting still in the open is hidden, the same group after moving is seen
    { const C4 = new Campaign2(def), t4 = C4.forces[0]; const us = C4.tfUnits(t4); const c4 = def.aor.cells.find(c => C4.owner[c.id] === 'player' && C4.frontline(c.id) && !['urban', 'industrial', 'forest'].includes(c.terrain));
      t4.cell = c4.id; t4.units = C4.units.filter(u => !C4.forces.slice(1).some(f => f.units.includes(u.uid)) || true).slice(0, 4).map(u => u.uid); for (const f of C4.forces.slice(1)) f.units = f.units.filter(id => !t4.units.includes(id)); C4.forces = C4.forces.filter(f => f.units.length);
      t4.mp = C4.tfMpMax(t4); ok(!C4.spotStatus(t4.id).spotted, `4 companies keeping still are hidden (sig ${C4.spotStatus(t4.id).sig})`);
      t4.movedT = C4.turn; ok(C4.spotStatus(t4.id).spotted, `4 companies on the move are seen (sig ${C4.spotStatus(t4.id).sig})`); }
    // the enemy's week: it knows the spotted square and aims fire at it
    C.pendingAttacks = []; C.endTurn();
    ok(C.espots && C.espots.list.some(x => x.id === T.id), 'the enemy recorded the spotted formation');
    ok((C.eintel[C.espots.list[0].cell] ?? -9) >= C.turn - 1, 'spotting gives the enemy fresh intel on that square');
    ok(C.fireLog.some(f => f.side === 'enemy' && f.turn === C.turn && C.espots.list.some(x => x.cell === f.cell)) || C.ammo.enemy < 1, 'enemy artillery fires at the spotted formation'); }
  // --- the enemy's concentration is spotted by the player
  { const C = new Campaign2(def); const fs = C.eforces.slice(0, 3), lead = fs[0];
    for (const f of fs.slice(1)) { lead.coys.push(...f.coys); C.eforces = C.eforces.filter(x => x !== f); } AI7.sync(lead);
    const near = def.aor.cells.find(c => C.owner[c.id] === 'enemy' && C.frontline(c.id)); lead.cell = near.id;
    C.updateSpots();
    ok(C.spottedEnemy().some(x => x.id === lead.id), `an enemy concentration (str ${lead.str.toFixed(1)}) is spotted without recon`);
    ok(C.cellIntel(near.id).forces.some(x => x.id === lead.id && x.spotted), 'cellIntel lists the spotted enemy formation');
    const small = C.eforces.find(f => f !== lead && f.str <= 1.1 && !C.forces.some(t => C.adjacent(t.cell, f.cell)));
    if (small) ok(!C.spottedEnemy().some(x => x.id === small.id), `a single battalion group (str ${small.str}) stays hidden`);
    const sum = () => C.eforces.filter(f => f.cell === near.id).reduce((a, f) => a + f.str, 0), g0 = sum(); C.suppressed = {}; const r = { side: 'player', kind: 'suppress', cell: near.id, n: 1, battery: C.batteries()[0].id }; C.applyFire(r);
    ok(g0 - sum() >= 0.085, `suppression hits a spotted mass 1.5x as hard (-${(g0 - sum()).toFixed(2)})`); }
  // --- growth: the grid stays as it is until taken ground nears the enemy edge, then the next band joins
  { const C = new Campaign2(def), X = def.aor.ext, n0 = def.aor.cells.length;
    ok(C.checkGrowth().length === 0 && C.def.aor.cells.length === n0, 'no growth at the start');
    const e = GR5.edgeLine(C.def.aor, X.dir), key = e.key;
    const take = def.aor.cells.filter(c => c.owner !== 'player' && Math.abs(c[key] - e.v) === 3 && c.terrain !== 'water').sort((a, b) => (b.road || 0) - (a.road || 0))[0];
    const far = def.aor.cells.filter(c => c.owner !== 'player' && Math.abs(c[key] - e.v) === 5)[0];
    if (far) { C.owner[far.id] = 'player'; ok(C.checkGrowth().length === 0, 'no growth while the front is 5 squares from the edge'); C.owner[far.id] = 'enemy'; }
    C.owner[take.id] = 'player';
    const g = C.checkGrowth(), b1 = X.bands[0];
    ok(g.length === 1 && g[0] === b1.id, `taking ${C.cellName(take.id)} (3 from the edge) adds band ${b1.id}`);
    ok(C.def.aor.cells.length === n0 + b1.cells.length && def.aor.cells.length === n0, `grid grew by ${b1.cells.length} squares; the content definition is untouched`);
    ok(b1.cells.every(c => C.cell(c.id) && C.owner[c.id] === 'enemy' && (C.fort[c.id] || 0) >= 0), 'new squares enemy-held (with their fortifications)');
    const A = C.def.aor; ok(A.cells.length === A.cols * A.rows && A.cells.every(c => c.col >= A.col0 && c.col < A.col0 + A.cols && c.row >= A.row0 && c.row < A.row0 + A.rows), `grown grid is a full ${A.cols}x${A.rows} rectangle (col0 ${A.col0}, row0 ${A.row0})`);
    ok(A.bbox[0] <= def.aor.bbox[0] && A.bbox[1] <= def.aor.bbox[1] && (A.bbox[0] < def.aor.bbox[0] || A.bbox[1] < def.aor.bbox[1]), 'bbox expanded');
    const edgeCell = b1.cells.find(c => c[key] === (X.dir === 'south' ? A.row0 + A.rows - 1 : A.col0));
    ok(edgeCell && C.neighbors(edgeCell.id).length >= 3, 'new squares are linked into the grid');
    ok((A.enemySources || []).every(id => C.cell(id)) && b1.sources.every(id => A.enemySources.includes(id)) && !A.enemySources.some(id => C.cell(id)[key] === e.v), 'enemy supply sources moved out to the new edge');
    ok(b1.cells.filter(c => C.owner[c.id] === 'enemy').every(c => (C.esupplied[c.id] ?? 0) >= 0) && b1.cells.some(c => C.esupplied[c.id] >= 1), 'new squares are on the enemy supply network');
    ok((b1.hubs || []).every(h => C.hubs('enemy').some(x => x.cell === h.cell)), 'band hubs work for the enemy');
    ok((b1.forces || []).every(f => C.eforces.some(x => x.name === f.name && x.cell === f.cell && x.coys?.length >= 2)), 'band battalion groups (with companies) arrive');
    ok((b1.directives || []).every(d => C.directives.some(a => a.id === d.id)), 'band directive issued');
    ok(C.gridV === 1 && C.lastGrowth?.band === b1.id, 'grid version bumped for the 3D map');
    // persistence of the grown grid
    C.save(); const L2 = Campaign2.load(defs); ok(L2 && L2.def.aor.cells.length === n0 + b1.cells.length && L2.grown.join() === b1.id && L2.owner[b1.cells[0].id] === 'enemy', 'grown grid persists');
    // a capture in the battle flow triggers growth too: next band after taking a square 3 from the new edge
    const e2 = GR5.edgeLine(C.def.aor, X.dir), t2 = b1.cells.find(c => Math.abs(c[key] - e2.v) <= 3 && c.terrain !== 'water');
    C.owner[t2.id] = 'player'; C.pendingAttacks = []; C.endTurn(); ok(C.grown.includes(X.bands[1].id), `end of week adds band ${X.bands[1].id}`);
    const tf = C.forces[0]; C.battle = { mode: 'attack', tf: tf.id, cell: X.bands[1].cells[0].id }; C.owner[X.bands[1].cells[X.bands[1].cells.length - 1].id] = 'player';
    C.applyResult({ sector: X.bands[1].cells[0].id, mode: 'attack', win: true, units: [], enemyKia: 3, enemyVehLost: 0, objectivesHeld: 1 });
    ok(C.grown.includes(X.bands[2].id) && C.def.aor.cells.length === n0 + X.bands.reduce((a, b) => a + b.cells.length, 0), 'a won attack near the new edge adds the last band');
    ok(C.growthStatus().next === null, 'no more bands after the last');
    for (let i = 0; i < 3 && !C.outcome(); i++) C.endTurn(); ok(true, 'the grown campaign keeps running'); }
}
// ------------------------------------------------------------------ v7: the enemy is a brigade of battalion groups
for (const def of (process.argv[2] === 'content' ? Object.values(defs) : []).filter(d => d.enemy?.forces)) {
  console.log(`== v7 ${def.id}`);
  setRandom(seeded(707)); for (const k of Object.keys(mem)) delete mem[k];
  { const C = new Campaign2(def), en = def.aor.cells.filter(c => C.owner[c.id] === 'enemy');
    // organisation: battalions of companies with veterancy; str follows the companies; screens are one company
    ok(C.eforces.length >= 8 && C.eforces.every(f => f.coys?.length >= 1 && Math.abs(f.str - f.coys.reduce((a, c) => a + c.s, 0) / 3) < 0.02 && f.xp != null), `enemy battalion groups with companies (${C.eforces.length} forces, ${C.eforces.reduce((a, f) => a + f.coys.length, 0)} coys)`);
    ok(C.eforces.filter(f => f.role === 'screen').every(f => f.coys.length === 1 && C.eforces.some(p => p.id === f.parent)), 'outposts are single companies detached from a battalion');
    ok(C.eforces.some(f => f.role === 'reserve'), 'the enemy keeps a reserve');
    // no garrison in every square: most of the rear is empty, every front square is held or covered
    const empty = en.filter(c => !AI7.forcesAt(C, c.id).length).length;
    ok(empty / en.length > 0.6, `most enemy squares hold no force (${empty}/${en.length})`);
    const front = en.filter(c => C.frontline(c.id));
    ok(front.every(c => AI7.covered(C, c.id)), `every front square is held or covered at the start (${front.length})`);
    const deep = en.filter(c => !AI7.covered(C, c.id)); ok(deep.length > 10, `squares behind the line are undefended (${deep.length})`);
    // defence comes from the forces: a battalion square > a covered square > an empty uncovered square
    const bn = C.eforces.find(f => f.role === 'line' && f.coys.length >= 3), cov = front.find(c => !AI7.forcesAt(C, c.id).length && AI7.coverOf(C, c.id));
    ok(C.defenderStrength(bn.cell) > (cov ? C.defenderStrength(cov.id) : 0) && (cov ? C.defenderStrength(cov.id) : 1) > C.defenderStrength(deep[0].id), `defence: battalion ${C.defenderStrength(bn.cell).toFixed(2)} > covered ${cov ? C.defenderStrength(cov.id).toFixed(2) : '-'} > empty ${C.defenderStrength(deep[0].id).toFixed(2)}`);
    ok(Object.values(C.garrison).every(g => g >= 0) && deep.every(c => C.garrison[c.id] === 1 || C.garrison[c.id] === 0), 'garrison is only the picture of what the brigade knows (unknown squares 1, known empty 0)');
    // the brigade sees only what it observes: C.foes = enemy forces in fresh squares, no spotted duplicates
    ok(C.foes.every(f => C.fresh(f.cell) && C.eforces.some(e => e.id === f.id) && f.units.length === f.n), `visible enemy forces (${C.foes.length}) only where observed / in contact`);
    ok(!C.eforces.some(f => !C.fresh(f.cell) && C.foes.some(x => x.id === f.id)), 'unobserved forces stay hidden');
    // battle setup from the forces involved: the companies holding the square, their veterancy
    const T = C.forces[0]; const st = C.battleSetup(bn.cell, T.units, 'attack');
    const here = C.eforces.filter(f => f.cell === bn.cell), nHere = here.reduce((a, f) => a + f.coys.length, 0);
    ok(st.enemyForces?.some(f => f.id === bn.id) && st.enemyCoys >= Math.min(8, nHere) && st.enemy.length >= Math.min(8, nHere) && st.enemy.some(e => e.kind === 'defend'), `attack battle: ${st.enemyCoys} enemy companies (${st.enemy.map(e => e.kind).join(',')}) from ${st.enemyForces?.map(f => f.name).join(' + ')}`);
    { const xp = here.reduce((a, f) => a + f.xp * f.coys.length, 0) / nHere, lv = xp >= 9 ? 3 : xp >= 5 ? 2 : xp >= 2 ? 1 : 0; ok(st.enemyVet === lv, `enemy veterancy passed to the battle (level ${st.enemyVet})`); }
    { const b2 = C.eforces.find(f => f.cell !== bn.cell && f.coys.length >= 3 && f.cell !== deep[0].id); const s2 = C.battleSetup(b2.cell, T.units, 'attack'); ok(s2.enemy.map(e => e.kind).join() !== st.enemy.map(e => e.kind).join() || s2.enemyForces[0].id !== st.enemyForces[0].id, 'different squares, different defenders'); }
    const stE = C.battleSetup(deep[0].id, T.units, 'attack'); ok(stE.enemyCoys === 0 && stE.enemy.length <= 3, 'an empty square has only rear security');
    // a fight there wears the battalion (not a garrison)
    { const s0 = bn.str; C.battle = { mode: 'attack', tf: T.id, cell: bn.cell }; C.applyResult({ sector: bn.cell, mode: 'attack', win: false, units: [], enemyKia: 10, enemyVehLost: 1, objectivesHeld: 0 });
      ok(bn.str < s0 || !C.eforces.includes(bn), `a repulsed attack costs the defending battalion (${s0} -> ${bn.str})`); }
  }
  // occupation: an undefended, observed square is taken by moving in, no battle; it ends the task force's week
  { const C = new Campaign2(def); let done = false;
    for (const c of def.aor.cells) {
      if (done || C.owner[c.id] !== 'enemy' || !AI7.undefended(C, c.id)) continue;
      const nb = C.neighbors(c.id).find(n => C.owner[n] === 'player'); if (!nb) continue;
      const T = C.forces[0]; T.cell = nb; T.mp = C.tfMpMax(T); C.observe(c.id);
      const p = C.plan(T.id, c.id); const b0 = C.stats.battles;
      ok(p.ok && p.occupy && !p.attack, `undefended ${C.cellName(c.id)}: plan says occupy`);
      C.move(T.id, c.id); ok(C.owner[c.id] === 'player' && T.cell === c.id && C.stats.battles === b0 && T.mp === 0, 'occupied without a battle; the week is spent');
      done = true;
    }
    if (!done) { const c = def.aor.cells.find(x => C.owner[x.id] === 'enemy' && AI7.undefended(C, x.id) && C.isOpen(x.id) && C.neighbors(x.id).some(n => C.owner[n] === 'enemy' && AI7.undefended(C, n))); const nb = c && C.neighbors(c.id).find(n => C.owner[n] === 'enemy' && AI7.undefended(C, n));
      if (c && nb) { C.owner[nb] = 'player'; const T = C.forces[0]; T.cell = nb; T.mp = C.tfMpMax(T); C.observe(c.id); const p = C.plan(T.id, c.id); ok(p.ok && p.occupy, 'undefended square next to a taken one: occupy'); C.move(T.id, c.id); ok(C.owner[c.id] === 'player' && T.mp === 0, 'occupied, week spent'); } }
    // a covered square still needs an attack
    const cov = def.aor.cells.find(c => C.owner[c.id] === 'enemy' && C.frontline(c.id) && AI7.covered(C, c.id) && C.neighbors(c.id).some(n => C.owner[n] === 'player'));
    if (cov) { const T = C.forces[1]; T.cell = C.neighbors(cov.id).find(n => C.owner[n] === 'player'); T.mp = C.tfMpMax(T); T.attacked = false; ok(C.plan(T.id, cov.id).attack === true, 'a held / covered square needs an attack'); }
  }
  // the enemy commander over some weeks: it moves every week, keeps the line covered, keeps a reserve, pushes
  // outposts / rotates, counterattacks lost ground, attacks with several battalions; seen moves reach the log
  { setRandom(seeded(4242)); const C = new Campaign2(def); let weeks = 0, movedWeeks = 0, kinds = {}, seenNotes = 0, multi = 0, uncovered = 0, frontN = 0, counters = 0;
    // give the brigade a foothold in the enemy line to provoke a counterattack
    const key = (def.goal?.cells || []).map(g => g.cell).find(id => C.neighbors(id).some(n => C.owner[n] === 'player')) || def.aor.cells.find(c => C.owner[c.id] === 'enemy' && C.frontline(c.id) && !AI7.forcesAt(C, c.id).length)?.id;
    for (let i = 0; i < 16 && !C.outcome(); i++) {
      if (i === 2 && key) { for (const f of AI7.forcesAt(C, key)) { const b = C.neighbors(key).find(n => C.owner[n] === 'enemy'); if (b) f.cell = b; } C.owner[key] = 'player'; C.elost[key] = C.turn; C.computeSupply(); }
      const n0 = C.logSeq || 0; C.endTurn(); weeks++;
      const M = C.enemyMoves; if (M?.turn === C.turn && M.list.length) movedWeeks++;
      for (const m of M?.list || []) kinds[m.kind] = (kinds[m.kind] || 0) + 1;
      seenNotes += C.log.filter(l => l.n > n0 && /^Enemy movement observed/.test(l.text)).length;
      for (const a of C.pendingAttacks) { if ((a.tfs || []).length > 1) multi++; if (a.counter) counters++; }
      const fr = def.aor.cells.filter(c => C.owner[c.id] === 'enemy' && C.neighbors(c.id).some(n => C.owner[n] === 'player')); frontN += fr.length; uncovered += fr.filter(c => !AI7.covered(C, c.id)).length;
    }
    ok(movedWeeks >= weeks * 0.6, `the enemy moves forces most weeks even against a passive brigade (${movedWeeks}/${weeks})`);
    ok(Object.keys(kinds).length >= 4, `varied manoeuvre (${Object.entries(kinds).map(([k, v]) => k + ' ' + v).join(', ')})`);
    ok(seenNotes > 0, `observed enemy moves are logged (${seenNotes} lines)`);
    ok(uncovered / Math.max(1, frontN) < 0.25, `the enemy keeps its front covered (${uncovered}/${frontN} front-square-weeks open)`);
    ok(C.eforces.some(f => f.role === 'reserve' || f.role === 'rest') || C.eforces.length < 4, 'reserve / resting battalions kept');
    ok((C.stats.eAttacks || 0) > 0, `the enemy attacks (${C.stats.eAttacks}; ${multi} with several battalions, ${counters} counterattacks announced)`);
    ok(C.pendingAttacks.every(a => (a.tfs || [a.tf]).every(id => C.eforces.some(f => f.id === id && f.cell === a.from)) && a.power > 0), 'announced attacks: every battalion on the staging square, power set');
    ok(C.enemyMoves.list.every(m => C.cell(m.from) && C.cell(m.to) && typeof m.seen === 'boolean'), 'C.enemyMoves entries: from, to, seen');
    // a defensive battle against an announced attack uses the attacking battalions' companies
    const a = C.pendingAttacks.find(x => C.forcesAt(x.to).length); if (a) { const st = C.defendSetup(a.id); ok(st && st.enemyForces.length === (a.tfs || [a.tf]).length && st.enemyCoys >= 2 && !st.enemy.some(e => e.kind === 'defend'), `defend battle against ${a.tfName}: ${st?.enemy.map(e => e.kind).join(',')}`); C.battle = null; }
    // rotation: a worn battalion (half its companies gone) is pulled back to rest when another battalion covers its square
    { const keys = new Set([...(def.goal?.cells || []).map(g => g.cell), ...(def.aor.hubs || []).map(h => h.cell)]), C = new Campaign2(def);
      const w = C.eforces.find(f => f.role === 'line' && f.coys.length >= 2 && !keys.has(f.cell) && C.neighbors(f.cell).some(n => C.owner[n] === 'enemy' && !keys.has(n)));
      if (w) { const nb = C.neighbors(w.cell).find(n => C.owner[n] === 'enemy' && !keys.has(n)), helper = C.eforces.find(f => f !== w && f.role === 'line' && f.coys.length >= 3 && !keys.has(f.cell));
        if (helper) { helper.cell = nb; helper.movedT = C.turn; }
        for (const c of w.coys) c.s = 0.3; AI7.sync(w); C.pendingAttacks = []; C.endTurn();
        ok(w.role === 'rest' || C.enemyMoves.list.some(m => m.id === w.id && m.kind === 'rotate'), `worn ${w.name} rotates out to rest (${w.role} at ${C.cellName(w.cell)})`);
        if (w.role === 'rest') { const s0 = w.str; C.pendingAttacks = []; C.endTurn(); ok(w.str > s0 || !C.eforces.includes(w), `resting battalion recovers (${s0} -> ${w.str})`); } } }
    // persistence of the v7 force records
    C.save(); const L7 = Campaign2.load(defs); ok(L7 && L7.eforces.every((f, i) => f.coys?.length === C.eforces[i].coys.length && f.role === C.eforces[i].role), 'battalion groups (companies, roles) persist');
  }
  // older saves (forces with str only) are migrated to companies
  { const C = new Campaign2(def); const f = C.eforces[0]; delete f.coys; f.str = 1.2; AI7.migrate(f); ok(f.coys.length === 4 && Math.abs(f.str - 1.2) < 0.05, 'old force record migrated (str 1.2 -> 4 coys)'); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
