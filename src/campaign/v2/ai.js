// Campaign v2 — the enemy brigade on the grid and its commander (single player).
//
// v7: the enemy is organised like the player's brigade. There is NO free garrison in every enemy square any more:
// the enemy is a set of battalion TASK FORCES (C.eforces) whose units are COMPANIES ({ k: kind, s: strength 0..1 }),
// with veterancy (xp, the player's scale), standing on real squares (content enemy.forces: where the real units were).
// A square is held by whatever sits in it, and COVERED (zone of control) by a battalion next to it, which pushes
// outposts forward and counterattacks with a company: defPower(cell) = companies in the square + 0.3 x the best
// neighbouring battalion. Squares with no enemy force in them or next to them (and no battery) are UNDEFENDED: the
// player occupies them by moving in. Fortifications stay terrain (trench lines, strongpoints): whoever occupies the
// square fights from them; empty fortified squares only keep their mines (half the fort bonus).
//
// The commander plays by the player's rules: movement points by kind and terrain/roads (enemy-held squares only),
// supply from its hubs (supply.js; unsupplied battalions wither and cannot attack), fires from its batteries and
// shells (fires.js), drone sorties (recon.js), signature / spotting (recon.js: big moving battalions give themselves
// away), frontage (at most FRONTAGE companies fight for a square). It knows only what it sees: player task forces in
// contact, under its drones this / last week, or spotted big formations; unknown squares are assumed held.
//
// Each week (after the player's turn), in order:
//   1. RECON: drone sorties over the player squares it most needs to see (opposite its threatened front squares).
//   2. ASSESS: THREAT per own front square (seen player power next to it, + spotted masses two squares out) against
//      its defence; OPPORTUNITY per player square on its line (value: VP, hubs, goal squares, penetrations, its own
//      ground lost — recently lost ground counts double —, unsupplied or contested squares) against expected defence.
//   3. ROLES: worn battalions (average company strength < 55%, half the companies lost, or one left) are ROTATED out to a
//      rest square behind it (they recover faster there) and relieved by a fresh battalion where one can reach; the
//      strongest fresh battalion(s) out of contact are the RESERVE (1 with 3+ battalions, 2 with 7+), held on a
//      reserve post two squares behind the most valuable sector (goal squares, hubs, towns, roads).
//   4. LINE: battalions in contact stay; the most threatened valuable squares get another battalion (up to the
//      frontage); every front square must be covered: free battalions close the gaps, else a battalion with 3+
//      companies DETACHES a one-company SCREEN (outpost) into the gap; screens that are no longer needed rejoin
//      their battalion. Free battalions form a second line behind the most threatened sector. Hubs within two squares
//      of the front keep a force in or next to them.
//   5. ATTACK: concentration — several battalions meet on one staging square (they stay separate units) and attack
//      together when the odds clear a bar set by the date's pressure (content enemy.pressure); 1–3 attacks a week,
//      announced to the player a week ahead (pendingAttacks: tf, tfs, power). Counterattacks on penetrations and on
//      lost key ground commit the reserve; cut-off and spotted player squares are preferred targets.
//   6. FIRES: counter-battery on found player batteries, preparation fire on its attack targets, fire on the biggest
//      spotted player formation, spoiling fire on player task forces facing its threatened squares, interdiction of
//      the player's supply chokepoint.
//   Every move is recorded (C.enemyMoves: { turn, list: [{ id, name, kind, from, to, role, seen }] }); moves the player
//   can see (either end observed / in contact, or the force spotted) go into the weekly log.
//   Upkeep (start of its week): supply, recovery (rest > reserve > line), dated reinforcements (content
//   enemy.reinforcements), crisis battalions when the brigade is worn down (enemy.minStrength / crisisWeeks).
import * as F from './fires.js';
import * as R from './recon.js';
import { chokepoints } from './supply.js';

const MP = { mech: 3, tank: 3, vdv: 3, inf: 2, assault: 2, atgm: 2, recon: 3 };
const cheb = (a, b) => Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
const r2 = v => Math.round(v * 100) / 100;
export const EF_POWER = 2.1;               // legacy scale: one point of strength = 2.1 player power (defenderStrength, strength 1..3)
// company power (player power units) by kind (content enemy.coyPower overrides COY_POWER per campaign)
export const COY_POWER = 1.45;
export const COY = { mech: 1.0, tank: 1.15, vdv: 1.05, inf: 0.8, assault: 0.95, atgm: 0.7, recon: 0.6 };
export const COY_LABEL = { mech: 'motor-rifle / mech. coy', tank: 'tank coy', vdv: 'airborne coy', inf: 'rifle coy', assault: 'assault coy', atgm: 'anti-tank coy', recon: 'recon coy' };
export const COVER_K = 0.3, COVER_MAX = 1.6, FRONTAGE_COYS = 8;
const xpLevel = xp => (xp >= 9 ? 3 : xp >= 5 ? 2 : xp >= 2 ? 1 : 0);

// ------------------------------------------------------------------ the force record
// the companies of a battalion of `kind` with n companies (content may list them explicitly)
export function coysFor(kind, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let k = kind;
    if (kind === 'mech') k = i === 3 ? 'tank' : 'mech';
    else if (kind === 'tank') k = i < Math.max(1, n - 1) ? 'tank' : 'mech';
    else if (kind === 'inf') k = i === 2 ? 'atgm' : 'inf';
    else if (kind === 'vdv') k = i === 3 ? 'tank' : 'vdv';
    out.push(k);
  }
  return out;
}
// content spec { name, kind, cell, str | coys:[kinds | {k, s}], xp, role } -> a force record
export function makeForce(C, spec, cell = null) {
  let coys;
  if (Array.isArray(spec.coys) && spec.coys.length) coys = spec.coys.map(c => (typeof c === 'string' ? { k: c, s: 1 } : { k: c.k || 'mech', s: c.s ?? 1 }));
  else { const str = spec.str ?? 1, n = Math.max(1, Math.round(str * 3)); coys = coysFor(spec.kind || 'mech', n).map(k => ({ k, s: Math.min(1, r2(str * 3 / n)) })); }
  const f = { id: spec.id || C.newId('ef'), name: spec.name || 'Battalion group', kind: spec.kind || 'mech', cell: cell || spec.cell, coys, xp: spec.xp ?? 2,
    role: spec.role || 'line', home: spec.home || spec.cell || cell, mp: 0, attacked: false, supply: 1 };
  if (spec.parent) f.parent = spec.parent;
  sync(f); f.size = f.role === 'screen' ? 1 : f.coys.length; if (f.role === 'hold') f.hold = true; return f;
}
// older saves: a force with only str gets companies
export function migrate(f) { if (!Array.isArray(f.coys)) { const n = Math.max(1, Math.round((f.str || 1) * 3)); f.coys = coysFor(f.kind || 'mech', n).map(k => ({ k, s: Math.min(1, r2((f.str || 1) * 3 / n)) })); f.xp ??= 2; f.role ||= 'line'; } return sync(f); }
// str (battalions: 1 = three full companies) and max follow the companies
export function sync(f) { f.coys = (f.coys || []).filter(c => c.s >= 0.12); f.str = r2(f.coys.reduce((a, c) => a + c.s, 0) / 3); f.max = r2(f.coys.length / 3); return f; }
export const ncoys = f => (f.coys ? f.coys.length : Math.max(1, Math.round((f.str || 0) * 3)));
export const avgS = f => (f.coys?.length ? f.coys.reduce((a, c) => a + c.s, 0) / f.coys.length : 0);
export function fpow(C, f, sup = true) {
  const raw = (f.coys || []).reduce((a, c) => a + c.s * (COY[c.k] ?? 0.9), 0) * (C.def.enemy?.coyPower ?? COY_POWER) * (1 + xpLevel(f.xp || 0) * 0.12);
  return sup ? raw * (0.6 + 0.4 * (f.supply ?? 1)) : raw;
}
// losses: k in battalion units (0.33 = a company's worth), spread over the companies; companies under 12% dissolve
export function hurt(f, k) { const n = f.coys.length; if (!n || k <= 0) return f; const L = k * 3 / n; for (const c of f.coys) c.s = Math.round(Math.max(0, c.s - L) * 1000) / 1000; return sync(f); }
export function heal(f, d) { for (const c of f.coys) c.s = r2(Math.min(1, c.s + d)); return sync(f); }

// ------------------------------------------------------------------ positions, cover, defence
export function mpMax(C, f) { let m = MP[f.kind] || 2; if ((f.supply ?? 1) < 0.5) m = Math.max(1, Math.floor(m / 2)); return m; }
let CACHE = null;   // per enemy phase: reach by task force position
export function reach(C, f) {
  const key = `${f.id}@${f.cell}`; if (CACHE && CACHE[key]) return CACHE[key];
  const out = reach0(C, f); if (CACHE) CACHE[key] = out; return out;
}
function reach0(C, f) {   // Dijkstra over enemy-held squares
  const dist = { [f.cell]: 0 }, prev = {}, open = new Set([f.cell]);
  while (open.size) {
    let cur = null; for (const o of open) if (cur == null || dist[o] < dist[cur]) cur = o; open.delete(cur);
    for (const n of C.neighbors(cur)) {
      if (C.owner[n] !== 'enemy') continue;
      const d = dist[cur] + C.baseCost(cur, n); if (!isFinite(d)) continue;
      if (dist[n] == null || d < dist[n] - 1e-9) { dist[n] = d; prev[n] = cur; open.add(n); }
    }
  }
  return { dist, prev };
}
export function forcesAt(C, cell) { return (C.eforces || []).filter(f => f.cell === cell); }
export const aiCampaign = C => !!C.def.enemy?.forces && !C.def.versus;
// legacy (test campaigns without enemy task forces): line garrison + forces, in strength points
export function strengthAt(C, cell) {
  if (aiCampaign(C)) return defPower(C, cell) / EF_POWER;
  return (C.garrison[cell] || 0) + forcesAt(C, cell).reduce((a, f) => a + f.str * (0.6 + 0.4 * (f.supply ?? 1)), 0);
}
// the neighbouring battalion that covers a square (its outposts and its counterattack company)
export function coverOf(C, cell) {
  let best = null, bp = 0;
  for (const n of C.neighbors(cell)) { if (C.owner[n] !== 'enemy') continue; for (const f of forcesAt(C, n)) { if (f.role === 'screen') continue; const p = fpow(C, f); if (p > bp) { bp = p; best = f; } } }
  return best ? { f: best, p: Math.min(COVER_MAX, bp * COVER_K) } : null;
}
// enemy combat power holding a square (player power units, before suppression; the flat fortification / town bonus
// is added by the battle resolution): companies that did not move this week are dug in (x DUG_IN), and occupied
// fortifications multiply the defence (x (1 + FORT_K x fort))
export const DUG_IN = 1.25, DUG_IN_HOLD = 1.5, FORT_K = 0.1;   // a fortress garrison (role 'hold') has prepared its strongpoint
export function defPower(C, cell) {
  const fs = forcesAt(C, cell), fk = 1 + FORT_K * (C.fort?.[cell] || 0);
  let p = 0, n = 0; for (const f of fs.slice().sort((a, b) => fpow(C, b) - fpow(C, a))) { const k = Math.min(ncoys(f), FRONTAGE_COYS - n); if (k <= 0) break; p += fpow(C, f) * k / ncoys(f) * ((f.movedT ?? -9) < C.turn ? (f.role === 'hold' ? DUG_IN_HOLD : DUG_IN) : 1) * fk; n += k; }
  const cv = coverOf(C, cell); if (cv) p += cv.p;
  if (!fs.length && !cv && (C.arty?.enemy || []).some(b => b.cell === cell && !b.down)) p += 0.6;   // gun lines have their own security
  return p;
}
export function covered(C, cell) { return forcesAt(C, cell).length > 0 || !!coverOf(C, cell) || C.neighbors(cell).some(n => C.owner[n] === 'enemy' && forcesAt(C, n).length) || (C.arty?.enemy || []).some(b => b.cell === cell && !b.down); }
export const undefended = (C, cell) => aiCampaign(C) && C.owner[cell] === 'enemy' && !covered(C, cell);
const urbanOf = c => (['urban', 'industrial'].includes(c.terrain) ? 1 : c.terrain === 'village' || c.terrain === 'forest' ? 0.5 : 0);
// a player task force the enemy knows about: in contact, under its drones, or a big formation that gave itself away
function seen(C, tf) { return C.neighbors(tf.cell).some(n => C.owner[n] === 'enemy') || (C.eintel?.[tf.cell] ?? -9) >= C.turn - 1 || bigSpotted(C, tf); }
function bigSpotted(C, tf) { return !!(C.espots && C.espots.turn === C.turn && C.espots.list.some(x => x.id === tf.id && x.cell === tf.cell)); }
// the enemy's estimate of a player square's defence (unknown squares: a reserve is assumed there)
function playerDef(C, cell) {
  const c = C.cell(cell), vis = (C.eintel?.[cell] ?? -9) >= C.turn - 1 || C.neighbors(cell).some(n => C.owner[n] === 'enemy' && forcesAt(C, n).length);
  const tfs = C.forcesAt(cell), cov = C.neighbors(cell).some(n => C.forcesAt(n).length);
  let p = (tfs.length || cov ? 2.0 : 1.2) + (C.fort[cell] || 0) * 0.6 + urbanOf(c);
  if (vis || tfs.every(t => seen(C, t))) p += tfs.reduce((a, t) => a + C.tfPower(t) * (0.6 + 0.4 * (t.supply ?? 1)), 0);
  else p += 1.5;
  // the player can reinforce a threatened square from next door within the week (it is warned of the attack)
  p += C.neighbors(cell).filter(n => C.owner[n] === 'player').reduce((a, n) => a + C.forcesAt(n).filter(t => seen(C, t)).reduce((s, t) => s + C.tfPower(t), 0), 0) * 0.35;
  return p * F.suppressMul(C, cell, 'enemy');
}
function value(C, cell) {
  const c = C.cell(cell), hub = (C.def.aor.hubs || []).some(h => h.cell === cell) ? 3 : 0, goal = (C.def.goal?.cells || []).some(g => g.cell === cell) ? 3 : 0;
  return 1 + (c.vp || 0) + hub + goal;
}
// the player's picture of a square: { known, fresh, forces:[visible], screen, empty, covered, def }
export function presence(C, cell) {
  if (C.owner[cell] === 'player') return null;
  const fresh = C.fresh(cell), I = fresh ? null : C.intel?.[cell];
  const fs = fresh ? forcesAt(C, cell) : [];
  const vis = fresh ? fs.map(f => f.id) : (I?.forces || []).map(f => f.id);
  const sp = (C.spottedEnemy?.() || []).filter(x => x.cell === cell).map(x => x.id);
  const ids = [...new Set([...vis, ...sp])];
  const known = fresh || !!I;
  const cov = fresh ? covered(C, cell) : null;
  return { known, fresh, forces: ids, screen: fresh && fs.length > 0 && fs.every(f => f.role === 'screen'), empty: known && !ids.length && (fresh ? !cov : !(I?.garrison > 0)), covered: cov, def: fresh ? r2(defPower(C, cell)) : (I?.garrison != null ? r2(I.garrison * EF_POWER) : null) };
}

// ------------------------------------------------------------------ movement helpers (logged)
function logMove(C, M, f, from, to, kind) {
  if (from === to) return;
  const vis = C.fresh(from) || C.fresh(to);
  M.push({ id: f.id, name: f.name, kind, role: f.role, from, to, n: ncoys(f), seen: vis });
}
function step(C, M, f, cell, kind, Rf = null) {
  if (cell === f.cell) return true;
  const d = (Rf || reach(C, f)).dist[cell]; if (d == null) return false;
  const full = f.mp >= mpMax(C, f) - 1e-6, adj = C.adjacent(f.cell, cell);
  if (d > f.mp + 1e-6 && !(full && adj)) return false;
  const from = f.cell; f.cell = cell; f.mp = Math.max(0, f.mp - d); f.movedT = C.turn; logMove(C, M, f, from, cell, kind); return true;
}
// move as far as possible towards a cell (the reachable square closest to it)
function toward(C, M, f, cell, kind) {
  if (f.cell === cell) return true;
  if (step(C, M, f, cell, kind)) return true;
  const Rf = reach(C, f), t = C.cell(cell);
  const best = Object.keys(Rf.dist).filter(id => Rf.dist[id] <= f.mp + 1e-6).sort((a, b) => cheb(C.cell(a), t) - cheb(C.cell(b), t) || Rf.dist[a] - Rf.dist[b])[0];
  if (best && cheb(C.cell(best), t) < cheb(C.cell(f.cell), t)) return step(C, M, f, best, kind, Rf);
  return false;
}
// a one-company outpost detached from a battalion
function detach(C, f) {
  if (ncoys(f) < 3) return null;
  const i = f.coys.map((c, j) => [c, j]).filter(([c]) => c.k !== 'tank' && c.s >= 0.35).sort((a, b) => a[0].s - b[0].s)[0]?.[1];
  if (i == null) return null;
  const [coy] = f.coys.splice(i, 1); sync(f);
  const s = { id: C.newId('ef'), name: `Outpost (${shortName(f.name)})`, kind: coy.k === 'atgm' ? 'inf' : coy.k, cell: f.cell, coys: [coy], xp: f.xp, role: 'screen', parent: f.id, home: f.cell, mp: f.mp, attacked: false, supply: f.supply };
  C.eforces.push(sync(s)); return s;
}
function rejoin(C, M, s, into) { into.coys.push(...s.coys); sync(into); C.eforces = C.eforces.filter(x => x !== s); M.push({ id: s.id, name: s.name, kind: 'rejoin', role: 'screen', from: s.cell, to: into.cell, n: 1, seen: C.fresh(s.cell), into: into.id }); }
const shortName = n => { const m = String(n).match(/\(([^)]*)\)/); return m ? `${m[1]} bn` : String(n); };

// ------------------------------------------------------------------ deployment at the start (screens fill the gaps)
export function deploy(C) {
  if (!aiCampaign(C)) return;
  const M = [];
  for (const f of C.eforces) { f.mp = mpMax(C, f); }
  CACHE = {};
  for (let pass = 0; pass < 3; pass++) for (const g of frontCells(C).filter(id => !covered(C, id))) {
    const par = C.eforces.filter(f => f.role !== 'screen' && f.role !== 'reserve' && ncoys(f) >= 3).map(f => ({ f, d: reach(C, f).dist[g] })).filter(x => x.d != null).sort((a, b) => a.d - b.d)[0];
    if (!par || par.d > 8) continue;
    const s = detach(C, par.f); if (!s) continue; s.cell = g; s.home = g;
  }
  for (const f of C.eforces) f.mp = 0;
  CACHE = null;
}
function frontCells(C) { return C.def.aor.cells.filter(c => C.owner[c.id] === 'enemy' && C.neighbors(c.id).some(n => C.owner[n] !== 'enemy')).map(c => c.id); }

// ------------------------------------------------------------------ the weekly plan
export function enemyAI(C, rnd, p) {
  const A = C.def.aor, log = [], M = [];
  C.eforces ||= []; C.eintel ||= {}; CACHE = {};
  for (const f of C.eforces) { f.mp = mpMax(C, f); f.attacked = false; }
  const front = A.cells.filter(c => C.owner[c.id] === 'enemy' && C.neighbors(c.id).some(n => C.owner[n] === 'player' || C.owner[n] === 'contested'));
  const frontSet = new Set(front.map(c => c.id));
  // ---- 1. recon
  const wantSee = new Map();
  for (const c of front) for (const n of C.neighbors(c.id)) if (C.owner[n] === 'player' && (C.eintel[n] ?? -9) < C.turn - 1) wantSee.set(n, (wantSee.get(n) || 0) + value(C, c.id));
  for (const [cell] of [...wantSee].sort((a, b) => b[1] - a[1])) {
    if (R.flyCheck(C, 'enemy', 'quad', cell) && R.flyCheck(C, 'enemy', 'wing', cell)) break;
    const type = R.flyCheck(C, 'enemy', 'quad', cell) ? 'wing' : 'quad', r = R.fly(C, 'enemy', type, cell, rnd);
    if (!r.ok) break; for (const id of r.cells) C.eintel[id] = C.turn;
    C.euavLog = r;
  }
  // ---- 2. assess
  const massNear = c => C.forces.filter(t => bigSpotted(C, t) && !C.adjacent(t.cell, c.id) && cheb(C.cell(t.cell), c) === 2).reduce((s, t) => s + C.tfPower(t) * 0.6, 0);
  const defOf = id => { const c = C.cell(id); return defPower(C, id) + (C.fort[id] || 0) * (urbanOf(c) >= 1 ? 1.0 : 0.6) + urbanOf(c); };
  const threatOf = c => {
    const pow = C.neighbors(c.id).filter(n => C.owner[n] === 'player').reduce((a, n) => a + C.forcesAt(n).filter(t => seen(C, t)).reduce((s, t) => s + C.tfPower(t), 0), 0) + massNear(c);
    const def = defOf(c.id);
    return { cell: c.id, pow, def, ratio: pow / Math.max(0.5, def), v: value(C, c.id) };
  };
  let threats = front.map(threatOf).sort((a, b) => b.ratio * b.v - a.ratio * a.v);
  const startEnemy = id => C.cell(id).owner === 'enemy';
  const lostRecently = id => (C.elost?.[id] ?? -99) >= C.turn - 3;
  const opps = [];
  for (const c of A.cells) {
    if (C.owner[c.id] === 'enemy') continue;
    const adjE = C.neighbors(c.id).filter(n => C.owner[n] === 'enemy'); if (!adjE.length) continue;
    let v = value(C, c.id);
    if (adjE.length >= 4) v += 2;                                    // a penetration into its line
    if (startEnemy(c.id)) v += 1.5;                                  // its own ground, lost
    if (lostRecently(c.id)) v += 2;                                  // ... this month: counterattack before it is dug in
    if ((C.supplied?.[c.id] ?? 1) < 0.5) v += 1.5;                   // cut-off player square
    if (C.owner[c.id] === 'contested') v += 1;
    if ((C.espots?.turn === C.turn ? C.espots.list : []).some(x => x.cell === c.id)) v += 0.5;   // a spotted mass: a target for its guns first
    opps.push({ cell: c.id, v, need: playerDef(C, c.id) * (C.owner[c.id] === 'contested' ? 0.6 : 1) });
  }
  // ---- 3. roles: rotation, reserve
  const contact = f => C.neighbors(f.cell).some(n => C.owner[n] !== 'enemy');
  const bns = () => C.eforces.filter(f => f.role !== 'screen');
  const worn = f => f.role !== 'screen' && (avgS(f) < 0.55 || ncoys(f) <= 1 || (f.size >= 3 && ncoys(f) <= f.size / 2));   // or half its companies gone
  const rested = f => avgS(f) >= 0.85 && ncoys(f) >= 2;
  for (const f of bns()) { if (f.role === 'rest' && rested(f)) f.role = f.hold ? 'hold' : 'line'; }
  const dFront = id => { const c = C.cell(id); let d = 99; for (const x of front) d = Math.min(d, cheb(c, x)); return d; };
  const supplied = id => (C.esupplied?.[id] ?? 0) >= 1;
  const restSquare = f => { const Rf = reach(C, f); return Object.keys(Rf.dist).filter(id => supplied(id) && dFront(id) >= 2 && !forcesAt(C, id).some(x => x !== f && x.role !== 'screen')).sort((a, b) => (Math.abs(dFront(a) - 2.5) - Math.abs(dFront(b) - 2.5)) || Rf.dist[a] - Rf.dist[b])[0]; };
  const used = new Set();
  // key ground: the player's objective squares and its hubs; the battalion holding one stays (relieved only in place)
  const keyGround = [...(C.def.goal?.cells || []).map(g => g.cell), ...(A.hubs || []).filter(h => (h.side || 'player') === 'enemy').map(h => h.cell)].filter((id, i, a) => a.indexOf(id) === i && C.owner[id] === 'enemy');
  const keySet = new Set(keyGround);
  const goalSet = new Set((C.def.goal?.cells || []).map(g => g.cell));
  for (const f of bns()) if (f.role === 'hold' && !worn(f)) used.add(f);          // fortress garrisons (content role 'hold') stay put
  for (const id of keyGround) { if (dFront(id) > 3 && !goalSet.has(id)) continue; const h = forcesAt(C, id).filter(f => f.role !== 'screen' && f.role !== 'rest').sort((a, b) => fpow(C, b) - fpow(C, a))[0]; if (h && !worn(h)) { used.add(h); if (h.role === 'reserve') h.role = 'line'; } }
  // reserve
  const nb = bns().length, nRes = nb >= 7 ? 2 : nb >= 3 ? 1 : 0;
  for (const f of bns()) if (f.role === 'reserve' && (worn(f) || contact(f))) f.role = 'line';
  let res = bns().filter(f => f.role === 'reserve');
  if (res.length < nRes) {
    const cand = bns().filter(f => f.role === 'line' && !contact(f) && !worn(f)).sort((a, b) => fpow(C, b) - fpow(C, a));
    for (const f of cand.slice(0, nRes - res.length)) { f.role = 'reserve'; res.push(f); }
  }
  // rotation: a worn battalion in the line goes back to rest; a fresh one relieves it where it can
  for (const f of bns().filter(x => worn(x) && x.role !== 'rest')) {
    const sq = f.cell, critical = frontSet.has(sq) && value(C, sq) >= 4;
    const relief = bns().filter(x => x !== f && !used.has(x) && !worn(x) && (x.role === 'line' && !contact(x) || x.role === 'reserve' && critical)).map(x => ({ x, d: reach(C, x).dist[sq] })).filter(o => o.d != null && o.d <= o.x.mp + 1e-6).sort((a, b) => a.d - b.d)[0];
    if (contact(f) && !relief && frontSet.has(sq) && !C.neighbors(sq).some(n => forcesAt(C, n).some(y => y !== f && y.role !== 'screen'))) continue;   // nobody else covers the square: hold on
    if (keySet.has(sq) && !relief && !forcesAt(C, sq).some(y => y !== f && y.role !== 'screen')) continue;            // key ground is never left empty
    const back = restSquare(f); if (!back) continue;
    if (relief) { step(C, M, relief.x, sq, 'relieve'); used.add(relief.x); if (relief.x.role === 'reserve') relief.x.role = 'line'; }
    if (step(C, M, f, back, 'rotate') || toward(C, M, f, back, 'rotate')) { f.role = 'rest'; used.add(f); log.push(`${f.name} rotates out of the line towards ${C.cellName(back)}${relief ? `, relieved by ${relief.x.name}` : ''}`); }
  }
  // ---- 4. line
  const line = () => bns().filter(f => (f.role === 'line' || f.role === 'hold') && !used.has(f));
  const coysAt = id => forcesAt(C, id).reduce((a, f) => a + ncoys(f), 0);
  // battalions in contact hold their ground (stability)
  for (const f of line()) if (contact(f)) used.add(f);
  // the most threatened valuable squares get another battalion (reserve too, for key ground)
  threats = front.map(threatOf).sort((a, b) => b.ratio * b.v - a.ratio * a.v);
  for (const t of threats) {
    const hasBn = forcesAt(C, t.cell).some(f => f.role !== 'screen');
    if (t.ratio < (t.v >= 7 ? 0.6 : 0.8) || (hasBn && t.ratio < (t.v >= 7 ? 0.8 : 1.3)) || coysAt(t.cell) >= FRONTAGE_COYS) continue;
    const critical = t.v >= 4 || t.ratio >= 1.5;
    const pool = [...line(), ...(critical ? res.filter(f => !used.has(f)) : []), ...bns().filter(f => used.has(f) && f.role === 'line' && !frontSet.has(f.cell) && !contact(f))];
    const cand = pool.filter(f => f.cell !== t.cell && !(threats.some(o => o.cell === f.cell && o.ratio > t.ratio))).map(f => ({ f, d: reach(C, f).dist[t.cell] })).filter(x => x.d != null && x.d <= x.f.mp + 1e-6).sort((a, b) => a.d - b.d)[0];
    if (cand && step(C, M, cand.f, t.cell, 'reinforce')) { used.add(cand.f); if (cand.f.role === 'reserve') cand.f.role = 'line'; log.push(`${cand.f.name} reinforces ${C.cellName(t.cell)}`); }
  }
  // key ground: hubs and the player's objective squares near the front keep a battalion in them (hubs within two
  // squares at least covered)
  for (const id of keyGround) {
    const goal = (C.def.goal?.cells || []).some(g => g.cell === id), d = dFront(id);
    if (d > (goal ? 3 : 2) || forcesAt(C, id).some(f => f.role !== 'screen') || (!goal && coverOf(C, id))) continue;
    const pool = [...line(), ...(d <= 2 || goal ? res.filter(f => !used.has(f)) : [])];
    const cand = pool.map(f => ({ f, d: reach(C, f).dist[id] })).filter(x => x.d != null).sort((a, b) => a.d - b.d)[0];
    if (cand && (step(C, M, cand.f, id, 'hub') || (d <= 3 && toward(C, M, cand.f, id, 'hub')))) { used.add(cand.f); if (cand.f.role === 'reserve' && cand.f.cell === id) cand.f.role = 'line'; }
  }
  // gaps: every front square covered — a free battalion if one can get there, else a one-company outpost
  const gaps = () => front.map(c => c.id).filter(id => !covered(C, id)).sort((a, b) => value(C, b) - value(C, a));
  for (const g of gaps()) {
    if (covered(C, g)) continue;
    const opts = [g, ...C.neighbors(g).filter(n => C.owner[n] === 'enemy')];
    let best = null;
    for (const f of line()) { const Rf = reach(C, f); for (const o of opts) { const d = Rf.dist[o]; if (d == null || d > f.mp + 1e-6) continue; const k = front.filter(c => !covered(C, c.id) && (c.id === o || C.adjacent(c.id, o))).length; if (!best || k > best.k || (k === best.k && d < best.d)) best = { f, o, d, k }; } }
    if (best && step(C, M, best.f, best.o, 'close the gap')) { used.add(best.f); continue; }
    const par = bns().filter(f => ncoys(f) >= 3 && f.role !== 'rest' && (!res.includes(f) || bns().length <= 2)).map(f => ({ f, d: reach(C, f).dist[g] })).filter(x => x.d != null && x.d <= x.f.mp + 1e-6).sort((a, b) => a.d - b.d)[0];
    if (par) { const s = detach(C, par.f); if (s && step(C, M, s, g, 'outpost')) { used.add(s); log.push(`${par.f.name} pushes an outpost into ${C.cellName(g)}`); } }
  }
  // screens no longer needed rejoin their battalion
  for (const s of C.eforces.filter(f => f.role === 'screen' && !used.has(f))) {
    const sq = s.cell, needed = frontSet.has(sq) && !forcesAt(C, sq).some(f => f !== s && f.role !== 'screen') && !C.neighbors(sq).some(n => forcesAt(C, n).some(f => f.role !== 'screen'));
    if (needed && !C.neighbors(sq).filter(n => frontSet.has(n)).every(n => covered(C, n))) continue;
    const parent = C.eforces.find(f => f.id === s.parent) || bns().map(f => ({ f, d: cheb(C.cell(f.cell), C.cell(sq)) })).sort((a, b) => a.d - b.d)[0]?.f;
    if (!parent) continue;
    s.parent = parent.id;
    if (needed && ncoys(parent) < 3) continue;
    if (frontSet.has(sq) && !forcesAt(C, sq).some(f => f !== s)) { const left = (() => { const keep = s.cell; s.cell = '__'; const ok = C.neighbors(keep).filter(n => frontSet.has(n)).concat([keep]).every(n => covered(C, n)); s.cell = keep; return ok; })(); if (!left) continue; }
    if (parent.cell === s.cell) { rejoin(C, M, s, parent); continue; }
    if (C.adjacent(parent.cell, s.cell) && step(C, M, s, parent.cell, 'rejoin')) rejoin(C, M, s, parent);
  }
  // free battalions: a second line behind the most threatened sector
  for (const f of line()) {
    if (frontSet.has(f.cell) && C.neighbors(f.cell).some(n => C.owner[n] === 'player')) continue;
    const t = threats.find(x => x.pow > 0 && !forcesAt(C, x.cell).some(y => y.role !== 'screen')) || threats.find(x => x.pow > 0); if (!t) continue;
    const Rf = reach(C, f), tc = C.cell(t.cell);
    const dest = Object.keys(Rf.dist).filter(id => Rf.dist[id] <= f.mp + 1e-6 && cheb(C.cell(id), tc) <= 1 && coysAt(id) + ncoys(f) <= FRONTAGE_COYS).sort((a, b) => (frontSet.has(b) ? 1 : 0) - (frontSet.has(a) ? 1 : 0) || Rf.dist[a] - Rf.dist[b])[0];
    if (dest && dest !== f.cell) { step(C, M, f, dest, 'second line', Rf); used.add(f); }
    else if (!dest && cheb(C.cell(f.cell), tc) > 2) { toward(C, M, f, t.cell, 'second line'); used.add(f); }
  }
  // reserve post: two squares behind the most valuable sector, on a road if possible
  const post = (() => {
    const key = [...front.map(c => ({ id: c.id, w: value(C, c.id) * (1 + (threats.find(t => t.cell === c.id)?.ratio || 0)) })), ...(C.def.goal?.cells || []).filter(g => C.owner[g.cell] === 'enemy').map(g => ({ id: g.cell, w: 6 }))];
    const cand = A.cells.filter(c => C.owner[c.id] === 'enemy' && supplied(c.id) && dFront(c.id) >= 2 && dFront(c.id) <= 4);
    let best = null; for (const c of cand) { let s = (c.road || 0) * 0.6 + (c.settlement ? 0.4 : 0) + (keySet.has(c.id) ? 4 : 0) - (dFront(c.id) === 4 ? 1 : 0); for (const k of key) { const d = cheb(c, C.cell(k.id)); if (d <= 3) s += k.w / (1 + d); } if (!best || s > best.s) best = { id: c.id, s }; }
    return best?.id || null;
  })();
  if (post) for (const f of res.filter(x => !used.has(x))) { if (cheb(C.cell(f.cell), C.cell(post)) > 1) toward(C, M, f, post, 'reserve'); }
  // resting battalions that ended up in contact move back
  for (const f of bns().filter(x => x.role === 'rest' && !used.has(x) && contact(x))) { const b = restSquare(f); if (b) step(C, M, f, b, 'rotate'); }
  // ---- 5. attack (concentration; the battalions stay separate units)
  // (v7) a commander who must husband his battalions: fewer, better-prepared attacks than the old garrison model
  const maxA = p < 0.15 ? 1 : p < 0.22 ? 2 : 3, bar = Math.max(1.0, 1.6 - p * 2.5);
  const announced = [], committed = new Set();
  opps.sort((a, b) => b.v / b.need - a.v / a.need);
  for (const o of opps) {
    if (announced.length >= maxA) break;
    const counter = startEnemy(o.cell) && (lostRecently(o.cell) || value(C, o.cell) >= 4);
    if (rnd() > Math.min(0.95, p * 3 + 0.35 + (counter ? 0.25 : 0))) continue;
    const stages = C.neighbors(o.cell).filter(n => C.owner[n] === 'enemy' && isFinite(C.baseCost(n, o.cell)));
    let best = null;
    for (const s of stages) {
      const group = [];
      for (const f of bns()) {
        if (committed.has(f) || f.attacked || (f.supply ?? 1) < 0.5 || avgS(f) < 0.6 || f.role === 'rest' || ncoys(f) < 2) continue;
        if (f.role === 'reserve' && !counter && !(value(C, o.cell) >= 4)) continue;          // the reserve counterattacks only for key ground
        if (f.role === 'hold' && f.cell !== s) continue;                                       // a garrison strikes only from its own strongpoint
        // a battalion holding a threatened square of its own does not leave it
        if (f.cell !== s && frontSet.has(f.cell) && threats.some(t => t.cell === f.cell && t.ratio > 0.9) && forcesAt(C, f.cell).filter(x => x !== f && x.role !== 'screen').length === 0) continue;
        const d = f.cell === s ? 0 : reach(C, f).dist[s]; if (d == null || (d > f.mp - 1 + 1e-6 && f.cell !== s)) continue;
        group.push({ f, d });
      }
      group.sort((a, b) => fpow(C, b.f) - fpow(C, a.f));
      let sum = 0, n = 0; const pick = [];
      for (const g of group) { if (n + ncoys(g.f) > FRONTAGE_COYS + 1) continue; pick.push(g); sum += fpow(C, g.f); n += ncoys(g.f); if (sum >= o.need * bar * 1.1) break; }
      const odds = sum / o.need;
      if (pick.length && (!best || odds > best.odds)) best = { s, pick, odds };
    }
    const key = startEnemy(o.cell) && value(C, o.cell) >= 7;
    if (!best || best.odds < (key ? Math.min(bar, 0.95) : counter ? bar * 0.95 : bar)) continue;
    const pick = best.pick.filter(g => g.f.cell === best.s || step(C, M, g.f, best.s, counter ? 'counterattack' : 'attack'));
    if (!pick.length) continue;
    for (const g of pick) { committed.add(g.f); used.add(g.f); g.f.attacked = true; g.f.attackedT = C.turn; if (g.f.role === 'reserve') g.f.role = 'line'; }
    const lead = pick.map(g => g.f).sort((a, b) => (a.role === 'hold') - (b.role === 'hold') || fpow(C, b) - fpow(C, a))[0];
    announced.push({ tf: lead, tfs: pick.map(g => g.f), to: o.cell, from: best.s, counter, power: pick.reduce((a, g) => a + fpow(C, g.f), 0), coys: pick.reduce((a, g) => a + ncoys(g.f), 0) });
    if (pick.length > 1) log.push(`${pick.map(g => g.f.name).join(' + ')} concentrate at ${C.cellName(best.s)}`);
  }
  // ---- 6. fires
  const bats = (C.arty?.enemy || []).filter(b => F.ready(C, b));
  const shoot = (kind, cell) => { for (const b of bats) { if (b.acted === C.turn) continue; if (F.fireCheck(C, 'enemy', b, kind, cell)) continue; const r = F.fire(C, 'enemy', b.id, kind, cell, rnd); if (r.ok) { C.applyFire(r, rnd); return true; } } return false; };
  for (const pb of (C.arty?.player || []).filter(b => F.found(C, 'enemy', b))) if (rnd() < 0.6) shoot('counterbattery', pb.cell);
  for (const a of announced) shoot('suppress', a.to);
  const masses = (C.espots?.turn === C.turn ? C.espots.list : []).filter(x => C.tf(x.id)?.cell === x.cell);
  for (const m of masses.slice(0, 1)) if (shoot('suppress', m.cell)) log.push(`fire on the spotted formation at ${C.cellName(m.cell)}`);
  const spoil = threats.flatMap(t => C.neighbors(t.cell).filter(n => C.owner[n] === 'player' && C.forcesAt(n).some(x => seen(C, x)))).sort((a, b) => C.forcesAt(b).reduce((s, t) => s + C.tfPower(t), 0) - C.forcesAt(a).reduce((s, t) => s + C.tfPower(t), 0));
  for (const cell of [...new Set(spoil)].slice(0, 2)) shoot('suppress', cell);
  if ((C.ammo?.enemy || 0) >= 2 && p >= 0.14) { const ch = chokepoints(C, C.supplyNet.player, 3)[0]; if (ch) shoot('interdict', ch.cell); }
  // ---- dig in: battalions that kept still on the front improve the trenches they hold
  for (const f of bns()) if ((f.movedT ?? -9) < C.turn && frontSet.has(f.cell) && (C.fort[f.cell] || 0) < 3 && (f.supply ?? 1) >= 1 && rnd() < 0.18) C.fort[f.cell] = (C.fort[f.cell] || 0) + 1;
  CACHE = null;
  C.enemyMoves = { turn: C.turn, list: M };
  return { announced, log, moves: M };
}

// a player win on a square with enemy task forces: they fall back to the best neighbouring enemy square or are destroyed
export function pushOut(C, cell, rnd) {
  for (const f of forcesAt(C, cell)) {
    const back = C.neighbors(cell).filter(n => C.owner[n] === 'enemy').sort((a, b) => (C.esupplied?.[b] ?? 0) - (C.esupplied?.[a] ?? 0) || defPower(C, b) - defPower(C, a))[0];
    hurt(f, f.str * (0.3 + rnd() * 0.15));
    if (!back || f.str < 0.2 || !f.coys.length) { C.eforces = C.eforces.filter(x => x !== f); C.note(`Enemy ${f.name} destroyed at ${C.cellName(cell)}.`, 'good'); C.stats.efDestroyed = (C.stats.efDestroyed || 0) + 1; }
    else { f.cell = back; f.mp = 0; f.xp = Math.max(0, (f.xp || 0) - 0.5); C.note(`Enemy ${f.name} falls back to ${C.cellName(back)}.`, 'good'); }
  }
}
// enemy losses in a fight at a square (lost defence or repulsed attack): k battalion units, spread over the forces
export function attrit(C, cell, k, list = null, xp = 0.5) {
  const fs = list || forcesAt(C, cell); if (!fs.length) return;
  const tot = fs.reduce((a, f) => a + Math.max(0.05, f.str), 0);
  for (const f of fs) { hurt(f, k * Math.max(0.05, f.str) / tot * (list ? 1 : fs.length > 1 ? 1.15 : 1)); f.xp = (f.xp || 0) + xp; }
  C.eforces = (C.eforces || []).filter(f => (f.coys?.length && f.str >= 0.1) || (C.note(`Enemy ${f.name} has been destroyed.`, 'good'), (C.stats.efDestroyed = (C.stats.efDestroyed || 0) + 1), false));
}

// weekly upkeep: supply, recovery (rest > reserve > line), reinforcements
export function upkeep(C) {
  const E = C.def.enemy || {};
  for (const f of C.eforces || []) {
    if (!f.coys) migrate(f);
    f.supply = C.esupplied?.[f.cell] ?? 0;
    const contact = C.neighbors(f.cell).some(n => C.owner[n] !== 'enemy');
    if (f.supply >= 1 && !f.attacked) heal(f, f.role === 'rest' ? 0.15 : contact ? 0.03 : 0.08);
    f.size ??= ncoys(f);
    if (f.role !== 'screen' && f.supply >= 1 && !contact && ncoys(f) < f.size && C.turn - (f.refitT ?? -9) >= 3) { f.coys.push({ k: f.kind === 'tank' ? 'tank' : f.kind === 'atgm' ? 'inf' : f.kind, s: 0.5 }); f.refitT = C.turn; f.xp = Math.max(0, (f.xp || 0) - 0.5); sync(f); }
    else if (f.supply >= 0.5 && !f.attacked && !contact) heal(f, 0.04);
    else if (f.supply < 0.5) { for (const c of f.coys) c.s = r2(Math.max(0.15, c.s - 0.08)); sync(f); }
  }
  // higher command answers a crisis: when the brigade's battalion groups are worn down (total strength under
  // enemy.minStrength) a fresh battalion is sent every enemy.crisisWeeks weeks while it still holds a working hub
  const tot = (C.eforces || []).reduce((a, f) => a + f.str, 0);
  if (E.minStrength && tot < E.minStrength && C.turn - (C.efCrisis || -99) >= (E.crisisWeeks || 4)) {
    const hub = (C.supplyNet?.enemy?.hubs || []).find(h => h.cap > 0 && !h.captured);
    if (hub) { C.efCrisis = C.turn; C.eforces.push(makeForce(C, { name: `${E.crisisName || 'Reserve battalion'} #${(C.efCrisisN = (C.efCrisisN || 0) + 1)}`, kind: 'mech', coys: ['mech', 'mech', 'mech'], xp: 1, role: 'reserve' }, hub.cell)); C.note(`Intelligence: the enemy rushes a reserve battalion to ${C.cellName(hub.cell)}.`, 'bad'); }
  }
  C.efArrived ||= {};
  for (const [i, r] of (E.reinforcements || []).entries()) {
    if (C.efArrived[i] || String(r.date) > C.date) continue;
    C.efArrived[i] = 1;
    const at = [r.cell, ...(C.def.aor.hubs || []).filter(h => (h.side || 'player') === 'enemy').map(h => h.cell), ...(C.def.aor.enemySources || [])].find(id => id && C.owner[id] === 'enemy');
    if (!at) continue;
    C.eforces.push(makeForce(C, { ...r, role: r.role || 'reserve' }, at));
    C.note(`Intelligence: enemy reinforcements — ${r.name} — reported arriving in the sector.`, 'bad');
  }
}
