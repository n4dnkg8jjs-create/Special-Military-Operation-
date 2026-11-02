// Balance check for the single-player campaign: a directive-aware bot (heads for directive targets, defends announced
// attacks, merges stacks, attacks at decent odds, spends LP on replacements / units / tech) plays every side over
// several seeds; prints directive success rates, battle record, ground and the outcome.
// usage: node src/campaign/v2/tools/balance.mjs [seeds=6] [UA|RU] [--v]
import { Campaign2, setRandom } from '../state.js';
const mem = {}; globalThis.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
const { defs } = await (await import('../index.js')).loadCampaigns();
const args = process.argv.slice(2).filter(a => !a.startsWith('--')), SEEDS = +(args[0] || 6), ONLY = args[1], VERBOSE = process.argv.includes('--v');
function seeded(s) { return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const cheb = (C, a, b) => { const p = C.cell(a), q = C.cell(b); return Math.max(Math.abs(p.col - q.col), Math.abs(p.row - q.row)); };

function odds(C, tf, cell) {
  const us = C.battleUnits(tf.units), sup = tf.supply ?? 1, fort = C.fort[cell] || 0, c = C.cell(cell);
  const urban = ['urban', 'industrial'].includes(c.terrain) ? 1 : c.terrain === 'village' || c.terrain === 'forest' ? 0.5 : 0;
  return us.reduce((a, u) => a + C.unitPower(u), 0) * (0.6 + 0.4 * sup) / (Math.max(0.5, C.garrison[cell] || 1) * 2.1 + fort * 0.6 + urban * 0.8);
}
function botTurn(C) {
  const goals = [], holds = [];
  for (const a of C.directives) { const d = C.directiveDef(a.id); for (const t of d.targets || []) { if (['capture', 'raid', 'recon'].includes(d.kind) && C.owner[t] !== 'player') goals.push({ t, kind: d.kind, urgent: C.directiveStatus(a).weeksLeft }); if (['hold', 'survive'].includes(d.kind)) holds.push(t); } }
  // merge stacks
  for (const tf of [...C.forces]) { const o = C.forcesAt(tf.cell).find(x => x !== tf && C.tf(x.id)); if (o && C.tf(tf.id)) C.merge(tf.id, o.id); }
  // defend announced attacks on held objectives / any square, with the nearest force that can get there
  for (const a of C.pendingAttacks) {
    if (C.forcesAt(a.to).length) continue;
    const t = C.forces.filter(f => !f.attacked).map(f => ({ f, p: C.plan(f.id, a.to) })).filter(x => x.p.ok && !x.p.attack).sort((x, y) => x.p.cost - y.p.cost)[0];
    if (t && (holds.includes(a.to) || (C.cell(a.to).vp || 0) > 0 || a.to === C.hq || Math.random() < 0.5)) C.move(t.f.id, a.to);
  }
  for (const tf of [...C.forces]) {
    if (!C.tf(tf.id) || tf.attacked || C.forcesAt(tf.cell).some(x => x !== tf && C.pendingAttacks.some(a => a.to === tf.cell))) continue;
    if (C.pendingAttacks.some(a => a.to === tf.cell)) continue;   // stays to defend
    if (C.tfPower(tf) < 1.5) continue;
    const R = C.reach(tf), atk = C.def.aor.cells.filter(c => C.owner[c.id] !== 'player').map(c => ({ id: c.id, p: C.plan(tf.id, c.id, R) })).filter(x => x.p.ok && x.p.attack);
    const val = x => { const g = goals.find(q => q.t === x.id); return odds(C, tf, x.id) * (g ? (g.urgent <= 2 ? 3 : 2) : 1) + (C.cell(x.id).vp || 0) * 0.15; };
    const best = atk.sort((a, b) => val(b) - val(a))[0];
    const goal = best && goals.find(g => g.t === best.id);
    if (best && (odds(C, tf, best.id) > 1.05 || (goal?.kind === 'raid' && odds(C, tf, best.id) > 0.6) || (goal && goal.urgent <= 1 && odds(C, tf, best.id) > 0.75))) { C.move(tf.id, best.id); C.attackSetup(tf.id, best.id); C.autoResolve(best.id, 'attack'); continue; }
    // move towards the nearest goal (or the closest front square)
    const tgt = goals.slice().sort((a, b) => cheb(C, tf.cell, a.t) - cheb(C, tf.cell, b.t))[0]?.t || holds[0];
    if (!tgt) continue;
    const dest = Object.keys(R.dist).filter(id => C.plan(tf.id, id, R).ok).sort((a, b) => cheb(C, a, tgt) - cheb(C, b, tgt))[0];
    if (dest && cheb(C, dest, tgt) < cheb(C, tf.cell, tgt)) C.move(tf.id, dest);
  }
  // spend LP
  for (let i = 0; i < 4; i++) { const u = C.units.filter(x => C.replaceCost(x) > 4 && C.replaceCost(x) < C.lp - 10 && (C.tfOf(x.uid)?.supply ?? 1) >= 0.5).sort((a, b) => C.replaceCost(b) - C.replaceCost(a))[0]; if (!u) break; C.replenish(u.uid); }
  const t = C.def.tech.find(x => C.techAvailable(x.id) && x.lp < C.lp - 30); if (t) C.orderTech(t.id);
  const c = C.def.catalog.filter(x => x.kind !== 'replacements' && C.catalogAvailable(x) && C.unitCost(x) < C.lp - 40).sort((a, b) => b.lp - a.lp)[0]; if (c && C.units.length < 18) C.orderUnit(c.key);
}
const tot = {};
for (const side of Object.keys(defs)) {
  if (ONLY && side !== ONLY) continue;
  const agg = tot[side] = { ok: 0, fail: 0, battles: 0, won: 0, taken: 0, lost: 0, lp: 0, spent: 0, wins: 0, results: {}, perDir: {} };
  for (let s = 0; s < SEEDS; s++) {
    setRandom(seeded(1000 + s * 77)); const rr = Math.random; Math.random = seeded(5000 + s * 31);
    const C = new Campaign2(defs[side]); let n = 0;
    while (!C.outcome() && n++ < 70) { botTurn(C); C.endTurn(); }
    const o = C.outcome(), sc = C.score();
    agg.ok += sc.ok; agg.fail += sc.fail; agg.battles += C.stats.battles; agg.won += C.stats.won; agg.taken += C.stats.cellsTaken; agg.lost += C.stats.cellsLost; agg.lp += C.lp; agg.wins += o?.win ? 1 : 0; agg.results[o?.title] = (agg.results[o?.title] || 0) + 1;
    for (const [id, r] of Object.entries(C.doneDirectives)) { const p = agg.perDir[id] ||= { ok: 0, n: 0 }; p.n++; if (r === 'success') p.ok++; }
    if (VERBOSE) console.log(side, s, o?.title, JSON.stringify(sc), 'battles', C.stats.won + '/' + C.stats.battles, 'LP', C.lp, 'units', C.units.length);
    Math.random = rr;
  }
  const S = SEEDS;
  console.log(`== ${side}: wins ${agg.wins}/${S} ${JSON.stringify(agg.results)} · directives ${(agg.ok / S).toFixed(1)} ok / ${(agg.fail / S).toFixed(1)} failed · battles won ${agg.won}/${agg.battles} · squares +${(agg.taken / S).toFixed(1)} / -${(agg.lost / S).toFixed(1)} · LP left ${Math.round(agg.lp / S)}`);
  console.log('   ' + Object.entries(agg.perDir).map(([id, p]) => `${id.replace(/^(ua|ru)_/, '')} ${p.ok}/${p.n}`).join(' · '));
}
