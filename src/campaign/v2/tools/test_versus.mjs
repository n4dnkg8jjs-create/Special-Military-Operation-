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

function invariants(V, where) {
  const bad = [];
  for (const c of V.sdef[V.opId].aor.cells) { const a = V.side.UA.owner[c.id], b = V.side.RU.owner[c.id]; if ((a === 'player') === (b === 'player')) bad.push(`owner ${c.id} UA:${a} RU:${b}`); }
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
// a simple commander: merge stacks, attack the weakest reachable target with the strongest force, otherwise advance
function play(V, f, rnd) {
  const C = V.side[f], foes = V.foes(f);
  for (const t of [...C.forces]) { const o = C.forcesAt(t.cell).find(x => x !== t); if (o && rnd() < 0.6) V.apply(f, 'merge', [t.id, o.id]); }
  for (const t of [...C.forces]) {
    if (!C.tf(t.id) || t.planned) continue;
    const R = C.reach(t), targets = C.def.aor.cells.filter(c => C.owner[c.id] !== 'player').map(c => ({ id: c.id, p: C.plan(t.id, c.id, R) })).filter(x => x.p.ok && x.p.attack);
    const val = id => (foes.some(x => x.cell === id) ? -foes.filter(x => x.cell === id).reduce((a, x) => a + x.power, 0) : -(C.garrison[id] || 1) * 2) + (C.cell(id).vp || 0);
    if (targets.length && C.tfPower(t) > 2.5 && rnd() < 0.8) { const tg = targets.sort((a, b) => val(b.id) - val(a.id))[0]; const r = V.apply(f, 'planAttack', [t.id, tg.id, rnd() < 0.5]); ok(r === null, `${f} planAttack ${tg.id}: ${r}`); continue; }
    const moves = Object.keys(R.dist).filter(id => id !== t.cell && C.plan(t.id, id, R).ok);
    if (moves.length && rnd() < 0.7) V.apply(f, 'move', [t.id, moves[Math.floor(rnd() * moves.length)]]);
  }
  if (C.lp > 60 && rnd() < 0.5) { const u = C.units.find(x => C.replaceCost(x) > 0 && C.replaceCost(x) < C.lp); if (u) V.apply(f, 'replenish', [u.uid]); }
  if (C.lp > 80 && rnd() < 0.3) { const c = C.def.catalog.find(x => C.catalogAvailable(x) && C.unitCost(x) < C.lp); if (c) V.apply(f, 'orderUnit', [c.key]); }
  if (rnd() < 0.2) { const t = C.forces.find(x => x.units.length > 2 && !x.planned); if (t) V.apply(f, 'split', [t.id, [t.units[0]]]); }
}

for (const opId of ['UA', 'RU']) for (const host of ['UA', 'RU']) {
  setRandom(seeded(11 + opId.charCodeAt(0) + host.charCodeAt(1))); const rnd = seeded(5 + host.charCodeAt(0));
  const realRandom = Math.random; Math.random = seeded(99 + opId.charCodeAt(1));
  console.log(`== operation ${opId}, host ${host}`);
  const V = new VersusGame(defs, opId, host);
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
    V.buildQueue();
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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
