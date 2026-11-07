// Node checks of the v2 versus rules (src/campaign/v2/versus.js): side definitions, commands, the weekly resolution
// with staff-resolved battles (line battalions and task force vs task force), ownership kept identical on both sides,
// save / restore, and a full game to the outcome for both operations and both host sides.
// usage: node src/campaign/v2/tools/test_versus.mjs
import { setRandom } from '../state.js';
const mem = {}; globalThis.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
const { loadCampaigns } = await import('../index.js');
const { VersusGame, sideDef2, mirror2, OTHER } = await import('../versus.js');
const { defs } = await loadCampaigns();
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m); } };
function seeded(s) { return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const def0 = C => C.def.aor.cells.every(c => C.isOpen(c.id));
function invariants(V, where) {
  const bad = [];
  for (const c of V.side[V.opId].def.aor.cells) { const a = V.side.UA.owner[c.id], b = V.side.RU.owner[c.id]; if ((a === 'player') === (b === 'player')) bad.push(`owner ${c.id} UA:${a} RU:${b}`); }
  for (const f of ['UA', 'RU']) {
    const C = V.side[f], seen = new Set();
    for (const t of C.forces) { if (C.owner[t.cell] !== 'player') bad.push(`${f} tf ${t.name} on enemy cell ${t.cell}`); if (!t.units.length) bad.push(`${f} empty tf`); for (const u of t.units) { if (seen.has(u)) bad.push(`${f} unit ${u} twice`); seen.add(u); if (!C.unit(u)) bad.push(`${f} missing unit ${u}`); } if (!isFinite(t.mp)) bad.push(`${f} mp NaN`); }
    for (const u of C.units) if (!seen.has(u.uid)) bad.push(`${f} unit ${u.uid} in no tf`);
    if (!isFinite(C.lp) || C.lp < 0) bad.push(`${f} lp ${C.lp}`);
    if (C.owner[C.hq || C.def.start.hq] !== 'player') bad.push(`${f} HQ on a lost cell`);
  }
  // the two sides' task forces never share a cell
  for (const t of V.side.UA.forces) if (V.side.RU.forces.some(x => x.cell === t.cell)) bad.push(`UA ${t.name} and an RU tf share ${t.cell}`);
  ok(!bad.length, `${where}: ${bad.slice(0, 5).join('; ')}`);
}
const stats = { fires: 0, uav: 0, cb: 0 };
// a simple commander: merge stacks, attack the weakest reachable target with the strongest force, otherwise advance
function play(V, f, rnd) {
  const C = V.side[f], foes = V.foes(f);
  for (const t of [...C.forces]) { const o = C.forcesAt(t.cell).find(x => x !== t); if (o && rnd() < 0.6) V.apply(f, 'merge', [t.id, o.id]); }
  for (const t of [...C.forces]) {
    if (!C.tf(t.id) || t.planned) continue;
    const R = C.reach(t), targets = C.def.aor.cells.filter(c => C.owner[c.id] !== 'player').map(c => ({ id: c.id, p: C.plan(t.id, c.id, R) })).filter(x => x.p.ok && x.p.attack);
    const val = id => (foes.some(x => x.cell === id) ? -foes.filter(x => x.cell === id).reduce((a, x) => a + x.power, 0) : -(C.garrison[id] || 1) * 2) + (C.cell(id).vp || 0);
    if (targets.length && C.tfPower(t) > 2.5 && rnd() < 0.8) { const tg = targets.sort((a, b) => val(b.id) - val(a.id))[0]; const r = V.apply(f, 'planAttack', [t.id, tg.id, rnd() < 0.5]); ok(r === null, `${f} planAttack ${tg.id}: ${r}`);
      const bt = C.batteries().find(b => !C.fireCheck(b.id, 'suppress', tg.id)); if (bt) { const fr = V.apply(f, 'fire', [bt.id, 'suppress', tg.id]); ok(typeof fr === 'object' && fr.ok && C.firePlans.length > 0, `${f} plans a fire mission`); stats.fires++; }
      continue; }
    const moves = Object.keys(R.dist).filter(id => id !== t.cell && C.plan(t.id, id, R).ok);
    if (moves.length && rnd() < 0.7) V.apply(f, 'move', [t.id, moves[Math.floor(rnd() * moves.length)]]);
  }
  // drones over the enemy's squares, counter-battery on found guns
  for (let i = 0; i < 2; i++) { const c = C.def.aor.cells.find(x => C.owner[x.id] !== 'player' && !C.fresh(x.id) && !C.uavCheck('quad', x.id)); if (c) { const u = V.apply(f, 'flyUav', ['quad', c.id]); if (typeof u === 'object') stats.uav++; } }
  for (const eb of C.arty.enemy) { const bt = C.batteries().find(b => !C.fireCheck(b.id, 'counterbattery', eb.cell)); if (bt) { V.apply(f, 'fire', [bt.id, 'counterbattery', eb.cell]); stats.cb++; } }
  if (C.lp > 60 && rnd() < 0.5) { const u = C.units.find(x => C.replaceCost(x) > 0 && C.replaceCost(x) < C.lp); if (u) V.apply(f, 'replenish', [u.uid]); }
  if (C.lp > 80 && rnd() < 0.3) { const c = C.def.catalog.find(x => C.catalogAvailable(x) && C.unitCost(x) < C.lp); if (c) V.apply(f, 'orderUnit', [c.key]); }
  if (rnd() < 0.2) { const t = C.forces.find(x => x.units.length > 2 && !x.planned); if (t) V.apply(f, 'split', [t.id, [t.units[0]]]); }
}

for (const opId of ['UA', 'RU']) for (const host of ['UA', 'RU']) {
  setRandom(seeded(11 + opId.charCodeAt(0) + host.charCodeAt(1))); const rnd = seeded(5 + host.charCodeAt(0));
  const realRandom = Math.random; Math.random = seeded(99 + opId.charCodeAt(1));
  console.log(`== operation ${opId}, host ${host}`);
  const V = new VersusGame(defs, opId, host);
  for (const f of ['UA', 'RU']) { const C = V.side[f]; ok(C.batteries().length >= 3 && C.batteries().every(b => C.owner[b.cell] === 'player'), `${f} artillery group on own squares`); ok(C.hubs('player').length >= 2, `${f} has supply hubs (${C.hubs('player').length})`); ok(def0(C), `${f} whole map open`); }
  for (const f of ['UA', 'RU']) { const C = V.side[f]; ok(C.def.versus && C.def.mapId === opId, `${f} def versus/mapId`); ok(C.forces.length >= 2, `${f} has task forces (${C.forces.length})`); ok(C.directives.length >= 1, `${f} has directives`); ok((C.def.aor.supplySources || []).length > 0 && C.forces.every(t => (t.supply ?? 0) >= 0.5), `${f} forces in supply`); ok(!C.def.directives.some(d => d.final), `${f} no final directive`); }
  invariants(V, 'start');
  // commands outside the planning phase / after ready are refused
  V.setReady(host, true); ok(typeof V.apply(host, 'move', [V.side[host].forces[0].id, V.side[host].forces[0].cell]) === 'string', 'no commands after ending the week'); V.setReady(host, false);
  // the joiner's mirror reproduces the host's view and stays deterministic under the same commands
  { const g = OTHER(host), st = V.view(g), M = mirror2(defs, st); const t = M.forces.find(x => Object.keys(M.reach(x).dist).length > 1); if (t) { const dest = Object.keys(M.reach(t).dist).find(id => id !== t.cell && M.plan(t.id, id).ok); if (dest) { M.move(t.id, dest); V.apply(g, 'move', [t.id, dest]); ok(V.side[g].tf(t.id).cell === M.tf(t.id).cell && Math.abs(V.side[g].tf(t.id).mp - M.tf(t.id).mp) < 1e-9, 'joiner prediction == host result (move)'); } } const t2 = M.forces.find(x => x.units.length > 1); if (t2) { const a = M.split(t2.id, [t2.units[0]]), b = V.apply(g, 'split', [t2.id, [t2.units[0]]]); ok(a.id === b.id, `joiner prediction == host result (split id ${a.id} / ${b.id})`); } }
  // random command sequences: the joiner's prediction and the host's result must match after every command
  { const g = OTHER(host); let M = mirror2(defs, V.view(g)); const r2 = seeded(77); let n = 0, diff = 0;
    const key = C => JSON.stringify({ f: C.forces.map(t => [t.id, t.name, t.cell, +t.mp.toFixed(6), t.units, t.stance, t.planned || null, t.attacked]), u: C.units.map(u => [u.uid, u.men, u.wounded, u.status, u.veh?.hp]), lp: C.lp, o: C.orders, d: C.depots, n: C.nextId });
    for (let i = 0; i < 60; i++) {
      const C = M, t = C.forces[Math.floor(r2() * C.forces.length)]; if (!t) break; let cmd = null;
      const k = r2();
      if (k < 0.25) { const R = C.reach(t), d = Object.keys(R.dist).filter(id => id !== t.cell && C.plan(t.id, id, R).ok && !C.plan(t.id, id, R).attack); if (d.length) cmd = ['move', [t.id, d[Math.floor(r2() * d.length)]]]; }
      else if (k < 0.4) { if (t.units.length > 1) cmd = ['split', [t.id, [t.units[t.units.length - 1]]]]; }
      else if (k < 0.5) { const o = C.forcesAt(t.cell).find(x => x !== t); if (o) cmd = ['merge', [t.id, o.id]]; }
      else if (k < 0.6) { const R = C.reach(t), a = C.def.aor.cells.find(c => C.owner[c.id] !== 'player' && C.plan(t.id, c.id, R).ok && C.plan(t.id, c.id, R).attack); if (a) cmd = ['planAttack', [t.id, a.id, r2() < 0.5]]; }
      else if (k < 0.65) { if (t.planned) cmd = ['cancelAttack', [t.id]]; }
      else if (k < 0.72) cmd = ['setStance', [t.id, ['attack', 'hold', 'rest'][Math.floor(r2() * 3)]]];
      else if (k < 0.76) cmd = ['rename', [t.id, 'TF ' + i]];
      else if (k < 0.84) { C.lp; const c = C.def.catalog.find(x => C.catalogAvailable(x) && C.unitCost(x) <= C.lp); if (c) cmd = ['orderUnit', [c.key]]; }
      else if (k < 0.9) { const u = C.units.find(x => C.replaceCost(x) > 0 && C.replaceCost(x) <= C.lp); if (u) cmd = ['replenish', [u.uid]]; }
      else if (k < 0.95) { const c = C.def.aor.cells.find(x => C.depotAllowed(x.id)); if (c && C.lp >= 30) cmd = ['buildDepot', [c.id]]; }
      else { const tt = C.def.tech.find(x => C.techAvailable(x.id) && x.lp <= C.lp); if (tt) cmd = ['orderTech', [tt.id]]; }
      if (!cmd) continue; n++;
      const a = M[cmd[0]](...cmd[1]), b = V.apply(g, cmd[0], JSON.parse(JSON.stringify(cmd[1])));
      if (key(M) !== key(V.side[g]) || (typeof a === 'string') !== (typeof b === 'string')) { diff++; console.log('   desync after', cmd[0], JSON.stringify(cmd[1])); M = mirror2(defs, V.view(g)); }
      if (i % 15 === 14) M = mirror2(defs, V.view(g));   // a fresh state from the host now and then, as on the link
    }
    ok(n > 12 && !diff, `joiner prediction matches the host over ${n} random commands (${diff} desyncs)`);
    for (const t of V.side[g].forces) if (t.planned) V.apply(g, 'cancelAttack', [t.id]);
  }
  let weeks = 0, battles = 0, pvp = 0;
  while (V.phase !== 'over' && weeks < 70) {
    play(V, 'UA', rnd); play(V, 'RU', rnd);
    V.setReady('UA', true); V.setReady('RU', true); ok(V.bothReady(), 'both ready');
    const plans = { UA: V.side.UA.firePlans.filter(p => p.kind === 'suppress').map(p => p.cell), RU: V.side.RU.firePlans.filter(p => p.kind === 'suppress').map(p => p.cell) };
    V.buildQueue();
    for (const f of ['UA', 'RU']) for (const cell of plans[f]) ok(V.side[f].suppressed[cell]?.by === 'player' && V.side[OTHER(f)].suppressed[cell]?.by === 'enemy', `${f} fire lands on ${cell} for both sides`);
    for (let b; (b = V.nextAttack());) { pvp++; // a "fought" PvP battle: resolved by the staff here (the real one runs in the battle iframes)
      V.autoBattle(b); }
    battles = V.history.length;
    V.endWeek(); weeks++;
    invariants(V, `week ${weeks}`);
    if (weeks === 6) { const S = JSON.parse(JSON.stringify(V.save())); const V2 = new VersusGame(defs, S.opId, S.host, S); ok(V2.turn === V.turn && JSON.stringify(V2.own) === JSON.stringify(V.own) && V2.side.UA.forces.length === V.side.UA.forces.length && V2.side.RU.lp === V.side.RU.lp, 'save / restore'); invariants(V2, 'restored'); }
  }
  ok(V.phase === 'over' && V.result, `game reaches an outcome (${weeks} weeks)`);
  ok(V.side.UA.outcome() && V.side.RU.outcome() && V.side.UA.outcome().win !== V.side.RU.outcome().win || V.result?.win === 'draw', 'outcome mirrored');
  const own = f => Object.values(V.own).filter(x => x === f).length;
  console.log(`  ${weeks} weeks, ${battles} battles (${pvp} vs task forces), result ${JSON.stringify(V.result)} · cells UA ${own('UA')} RU ${own('RU')} · LP UA ${V.side.UA.lp} RU ${V.side.RU.lp}`);
  Math.random = realRandom;
}
// v5: the grid grows for both commanders together; big formations are seen by the other player
{ const GR = await import('../growth.js');
  for (const op of ['UA', 'RU']) {
    setRandom(seeded(99)); const V = new VersusGame(defs, op, op), A = V.side[op], D = V.side[OTHER(op)], X = A.baseDef.aor.ext;
    ok(V.grow().length === 0, `${op}: no growth at the start of a versus game`);
    const e = GR.edgeLine(A.def.aor, X.dir), take = A.def.aor.cells.find(c => A.owner[c.id] !== 'player' && c.owner !== 'player' && Math.abs(c[e.key] - e.v) === 3);
    V.own[take.id] = op; V.sync(); const g = V.grow();
    ok(g.length === 1 && A.grown.join() === g.join() && D.grown.join() === g.join(), `${op}: both sides grow by ${g}`);
    ok(A.def.aor.cells.length === D.def.aor.cells.length && A.def.aor.cells.length > V.sdef[op].aor.cells.length, `${op}: both maps have ${A.def.aor.cells.length} squares`);
    const band = X.bands[0];
    ok(band.cells.every(c => V.own[c.id] === OTHER(op) && A.owner[c.id] === 'enemy' && D.owner[c.id] === 'player'), `${op}: new squares belong to the defender on both maps`);
    ok(band.sources.every(id => D.def.aor.supplySources.includes(id)) && band.sources.every(id => A.def.aor.enemySources.includes(id)), `${op}: the defender's supply sources move out to the new edge`);
    ok(band.cells.some(c => (D.supplied[c.id] ?? 0) >= 1), `${op}: the defender supplies its new rear`);
    invariants(V, `${op} after growth`);
    const S = JSON.parse(JSON.stringify(V.save())), V2 = new VersusGame(defs, S.opId, S.host, S);
    ok(V2.side.UA.def.aor.cells.length === A.def.aor.cells.length && V2.side.RU.grown.join() === g.join(), `${op}: the grown grid survives save / restore`);
    const M = mirror2(defs, JSON.parse(JSON.stringify(V.view(OTHER(op)))));
    ok(M.def.aor.cells.length === A.def.aor.cells.length && M.owner[band.cells[0].id] === 'player', `${op}: the joiner's mirror has the grown grid`);
    // a massed task force is shown to the other commander without recon
    const T = A.forces[0]; for (const f of [...A.forces]) if (f !== T) { f.cell = T.cell; A.merge(T.id, f.id); }
    const fr = A.def.aor.cells.find(c => A.owner[c.id] === 'player' && A.frontline(c.id) && !D.forces.some(t => D.adjacent(t.cell, c.id)) && !D.recon[c.id]); T.cell = fr.id;
    ok(V.foes(OTHER(op)).some(x => x.id === T.id && x.spotted), `${op}: the massed brigade is spotted by the other player`);
  }
}
ok(stats.fires > 20 && stats.uav > 20, `versus commanders used fires (${stats.fires}), drones (${stats.uav}), counter-battery (${stats.cb})`);
// ------------------------------------------------------------------ v7: zone of control and a dispersed defender
for (const op of ['UA', 'RU']) {
  console.log(`== v7 versus ${op}`);
  const V = new VersusGame(defs, op, op), Dd = V.side[OTHER(op)];
  const cells = new Set(Dd.forces.map(t => t.cell));
  ok(Dd.forces.length >= 4 && cells.size >= Math.min(Dd.forces.length - 1, 4), `${op}: the defending brigade starts dispersed (${Dd.forces.length} task forces on ${cells.size} squares)`);
  ok(Dd.forces.every(t => Dd.owner[t.cell] === 'player'), `${op}: defender task forces on own squares`);
  // staff-resolved attacks: a square no defending task force covers is thinly held, a covered one is held by its line
  const A0 = V.side[op], strong = A0.forces.slice().sort((a, b) => A0.tfPower(a) - A0.tfPower(b))[0];   // the weakest task force: the odds matter
  const zoc = id => Dd.forcesAt(id).length > 0 || Dd.neighbors(id).some(n => Dd.forcesAt(n).length);
  const open = Dd.def.aor.cells.filter(c => Dd.owner[c.id] === 'player' && !zoc(c.id) && !['urban', 'industrial'].includes(c.terrain) && (Dd.fort[c.id] || 0) <= 1).map(c => c.id);
  const held = Dd.def.aor.cells.filter(c => Dd.owner[c.id] === 'player' && !Dd.forcesAt(c.id).length && zoc(c.id) && !['urban', 'industrial'].includes(c.terrain) && (Dd.fort[c.id] || 0) <= 1).map(c => c.id);
  const trial = (cell, seed) => {
    const W = new VersusGame(defs, op, op), A = W.side[op], D = W.side[OTHER(op)], T = A.tf(strong.id);
    const st = A.neighbors(cell).find(n => A.owner[n] === 'player') || A.neighbors(cell)[0];
    A.owner[st] = 'player'; W.own[st] = op; T.cell = st; T.planned = { cell, auto: true };
    const rr = Math.random; Math.random = seeded(seed); const r = W.autoBattle({ f: op, tf: T.id, cell, stage: st, defTfs: [], defUids: [], id: 't' }); Math.random = rr;
    return r.rAtt.win;
  };
  if (open.length && held.length) {
    let wOpen = 0, wHeld = 0; for (let i = 0; i < 24; i++) { wOpen += trial(open[i % open.length], 900 + i) ? 1 : 0; wHeld += trial(held[i % held.length], 900 + i) ? 1 : 0; }
    ok(wOpen > wHeld, `${op}: squares outside the defender's zone of control fall more easily (won ${wOpen}/24 vs ${wHeld}/24)`);
  } else ok(true, `${op}: (no open/held pair to compare)`);
}

// ------------------------------------------------------------------ purchases arrive under the name that was ordered
// (a bought team used to land in a second 'Brigade reserve' next to the brigade's own, which holds the starting 'UAV
// strike platoon', and was numbered among start units of other names: 'Stugna-P ATGM team #3'). Single player, versus
// (host and the joiner's mirror) for both sides.
{ const { Campaign2 } = await import('../state.js');
  const checkNames = (C, before, where) => {
    const fresh = C.units.filter(u => !before.has(u.uid)), names = C.forces.map(t => t.name);
    ok(fresh.length >= 4, `${where}: ${fresh.length} units delivered`);
    for (const u of fresh) { const c = C.catalogItem(u.key); ok(c && (u.name === c.label || new RegExp(`^${c.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} #\\d+$`).test(u.name)) && c.kind === u.kind, `${where}: ${u.key} arrives as '${u.name}' (ordered '${c?.label}')`); }
    ok(new Set(names).size === names.length, `${where}: task force names are unique (${names.join(' / ')})`);
    for (const u of fresh) { const t = C.tfOf(u.uid); ok(t && (!t.autoName || (t.units.length === 1 && t.name === u.name)), `${where}: '${u.name}' waits in '${t?.name}'`); }
    ok(new Set(C.units.map(u => u.name)).size === C.units.length, `${where}: unit names are unique`);
  };
  const buyAll = (C, buy) => { C.lp = 5000; C.unlocked.push(...C.def.tech.map(t => t.id).filter(id => !C.unlocked.includes(id))); for (const c of C.def.catalog) if (!C.available.includes(c.key)) C.available.push(c.key);
    for (const c of C.def.catalog) if (c.kind !== 'replacements' && C.catalogAvailable(c)) buy(c.key); };
  for (const f of ['UA', 'RU']) {
    const C = new Campaign2(defs[f]), before = new Set(C.units.map(u => u.uid)); buyAll(C, k => ok(C.orderUnit(k) === null, `${f}: order ${k}`));
    for (let i = 0; i < 5; i++) C.endTurn();
    checkNames(C, before, `single player ${f}`);
    // one delivery alone: its own group, named after it — not the brigade's reserve holding other units
    const D = new Campaign2(defs[f]); D.lp = 500; D.unlocked.push(...D.def.tech.map(t => t.id)); D.available.push('fpv_plus'); D.orderUnit('fpv_plus'); D.endTurn();
    const u = D.units.find(x => x.key === 'fpv_plus'), t = D.tfOf(u.uid); ok(t.units.length === 1 && t.name === D.catalogItem('fpv_plus').label, `${f}: a bought FPV team waits as '${t.name}' [${D.tfUnits(t).map(x => x.name)}]`);
  }
  for (const op of ['UA', 'RU']) {
    const V = new VersusGame(defs, op, op), before = { UA: new Set(V.side.UA.units.map(u => u.uid)), RU: new Set(V.side.RU.units.map(u => u.uid)) };
    for (const f of ['UA', 'RU']) buyAll(V.side[f], k => ok(V.apply(f, 'orderUnit', [k]) === null, `versus ${op} ${f}: order ${k}`));
    for (let w = 0; w < 5; w++) { V.setReady('UA', true); V.setReady('RU', true); V.buildQueue(); while (V.nextAttack()); V.endWeek(); }
    for (const f of ['UA', 'RU']) { checkNames(V.side[f], before[f], `versus ${op} ${f}`);
      const M = mirror2(defs, JSON.parse(JSON.stringify(V.view(f))));
      ok(JSON.stringify(M.units.map(u => [u.uid, u.key, u.name])) === JSON.stringify(V.side[f].units.map(u => [u.uid, u.key, u.name])) && JSON.stringify(M.forces.map(t => [t.id, t.name])) === JSON.stringify(V.side[f].forces.map(t => [t.id, t.name])), `versus ${op} ${f}: the joiner's mirror has the same units and groups`); }
  }
}
// ------------------------------------------------------------------ versus: the operation goal and the week's fire on both maps
for (const op of ['UA', 'RU']) {
  setRandom(seeded(321)); const V = new VersusGame(defs, op, op), A = V.side[op], D = V.side[OTHER(op)], G = V.sdef[op].vsGoal;
  const ga = A.goalProgress(), gd = D.goalProgress();
  ok(ga && gd && ga.vs === 'attack' && gd.vs === 'defend', `${op}: both commanders have the operation goal (attack / defend)`);
  ok(ga.cells.length === G.cells.length && ga.cells.every((c, i) => c.held !== gd.cells[i].held), `${op}: goal squares held by exactly one side`);
  ok(!A.outcome() && !D.outcome(), `${op}: the goal does not end a versus week by itself`);
  const M = mirror2(defs, JSON.parse(JSON.stringify(V.view(OTHER(op))))); ok(M.goalProgress()?.vs === 'defend' && M.goalProgress().cells.length === G.cells.length, `${op}: the joiner's mirror shows the goal`);
  // a fire mission planned this week: the firer's map keeps its craters this week, the target's commander sees it land next week
  let fired = null;
  for (const b of A.batteries()) { const c = A.def.aor.cells.find(x => !A.fireCheck(b.id, 'suppress', x.id)); if (c) { const r = V.apply(op, 'fire', [b.id, 'suppress', c.id]); if (r?.ok) { fired = { b, cell: c.id, turn: A.turn }; break; } } }
  ok(!!fired, `${op}: a fire mission planned`);
  V.setReady('UA', true); V.setReady('RU', true); V.buildQueue(); while (V.nextAttack()); 
  ok(A.fireLog.some(l => l.turn === fired.turn && l.side === 'player' && l.cell === fired.cell && l.battery === fired.b.id), `${op}: the firer's fire log has the mission (this week)`);
  V.endWeek();
  const seen = D.fireLog.filter(l => l.turn === D.turn && l.side === 'enemy' && l.cell === fired.cell);
  ok(seen.length === 1 && seen[0].bkind === fired.b.kind && !D.battery(seen[0].battery), `${op}: the other commander's map plays it at the start of the next week (${JSON.stringify(seen[0])})`);
  const M2 = mirror2(defs, JSON.parse(JSON.stringify(V.view(OTHER(op))))); ok(M2.fireLog.some(l => l.turn === M2.turn && l.side === 'enemy'), `${op}: in the joiner's mirror too`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
