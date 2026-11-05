// Campaign v2 — the enemy brigade's commander on the grid (single player). The enemy has real TASK FORCES (battalion
// groups: C.eforces) on top of the line troops holding every square (C.garrison), and plays by the player's rules:
// movement points by composition and terrain/roads, supply from its own hubs (supply.js), weekly fire missions from its
// own batteries and ammunition (fires.js) and drone sorties (recon.js). It only knows what it can see: player task
// forces in contact (next to its squares) or under its drones this / last week; everything else is estimated.
//
// Each week (after the player's turn), in order:
//   1. RECON: drones over the player squares it most needs to know about (opposite its threatened squares and its
//      planned attack targets).
//   2. ASSESS: for every own front square, THREAT = seen player power next to it / its defence (line + task forces +
//      fortifications + town), weighted by value (VP, hubs x2, the player's operation-goal squares x2); for every
//      player square next to its line, OPPORTUNITY = value (VP, hubs, penetrations deep into its line, squares it lost
//      recently, unsupplied squares) / the defence it expects (unknown squares are assumed stronger).
//   3. RESERVE: the strongest task force out of contact stays back as the reserve (when it has 3+ task forces) and
//      only moves to save a threatened hub / goal square or to retake one.
//   4. DEFEND: the most threatened valuable squares get the nearest free task force that can reach them this week.
//   5. ATTACK: it concentrates — several task forces meet on one staging square and combine — against the best
//      opportunity when its odds clear a bar that falls as the date's pressure (content enemy.pressure) rises; at most
//      1–3 attacks a week. Attacks are announced to the player one week ahead (pendingAttacks), as before.
//   6. FIRES: counter-battery on found player batteries, preparation fire on its attack targets, spoiling fire on the
//      strongest player task forces facing its threatened squares, interdiction of the player's supply chokepoint.
//   7. Upkeep: task forces in supply recover strength, unsupplied ones wither and cannot attack; reinforcements arrive
//      on dated schedules (content enemy.reinforcements), destroyed batteries are rebuilt.
import * as F from './fires.js';
import * as R from './recon.js';
import { chokepoints } from './supply.js';

const MP = { mech: 3, tank: 3, vdv: 3, inf: 2, assault: 2 };
const cheb = (a, b) => Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
export const EF_POWER = 2.1;               // one point of enemy strength = 2.1 player power (the autoResolve scale)

export function mpMax(C, f) { let m = MP[f.kind] || 2; if ((f.supply ?? 1) < 0.5) m = Math.max(1, Math.floor(m / 2)); return m; }
// Dijkstra over enemy-held squares
let CACHE = null;   // per enemy phase: reach by task force position
export function reach(C, f) {
  const key = `${f.id}@${f.cell}`; if (CACHE && CACHE[key]) return CACHE[key];
  const out = reach0(C, f); if (CACHE) CACHE[key] = out; return out;
}
function reach0(C, f) {
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
export function strengthAt(C, cell) { return (C.garrison[cell] || 0) + forcesAt(C, cell).reduce((a, f) => a + f.str * (0.6 + 0.4 * (f.supply ?? 1)), 0); }
const urbanOf = c => (['urban', 'industrial'].includes(c.terrain) ? 1 : c.terrain === 'village' || c.terrain === 'forest' ? 0.5 : 0);
// a player task force the enemy knows about: in contact, under its drones, or a big formation that gave itself away
function seen(C, tf) { return C.neighbors(tf.cell).some(n => C.owner[n] === 'enemy') || (C.eintel?.[tf.cell] ?? -9) >= C.turn - 1 || bigSpotted(C, tf); }
function bigSpotted(C, tf) { return !!(C.espots && C.espots.turn === C.turn && C.espots.list.some(x => x.id === tf.id && x.cell === tf.cell)); }
function playerDef(C, cell) {
  const c = C.cell(cell), vis = (C.eintel?.[cell] ?? -9) >= C.turn - 1 || C.neighbors(cell).some(n => C.owner[n] === 'enemy' && forcesAt(C, n).length);
  let p = 2.0 + (C.fort[cell] || 0) * 0.6 + urbanOf(c);
  const tfs = C.forcesAt(cell);
  if (vis || tfs.every(t => seen(C, t))) p += tfs.reduce((a, t) => a + C.tfPower(t) * (0.6 + 0.4 * (t.supply ?? 1)), 0);
  else p += 1.5;                                                         // not observed: assume a reserve there
  p *= F.suppressMul(C, cell, 'enemy');
  return p;
}
function value(C, cell) {
  const c = C.cell(cell), hub = (C.def.aor.hubs || []).some(h => h.cell === cell) ? 3 : 0, goal = (C.def.goal?.cells || []).some(g => g.cell === cell) ? 3 : 0;
  return 1 + (c.vp || 0) + hub + goal;
}

export function enemyAI(C, rnd, p) {
  const A = C.def.aor, E = C.def.enemy || {}, log = [];
  C.eforces ||= []; C.eintel ||= {}; CACHE = {};
  for (const f of C.eforces) { f.mp = mpMax(C, f); f.attacked = false; }
  const front = A.cells.filter(c => C.owner[c.id] === 'enemy' && C.neighbors(c.id).some(n => C.owner[n] === 'player'));
  // ---- 1. recon
  const wantSee = new Map();
  for (const c of front) for (const n of C.neighbors(c.id)) if (C.owner[n] === 'player' && (C.eintel[n] ?? -9) < C.turn - 1) wantSee.set(n, (wantSee.get(n) || 0) + value(C, c.id));
  const looks = [...wantSee].sort((a, b) => b[1] - a[1]);
  for (const [cell] of looks) {
    if (R.flyCheck(C, 'enemy', 'quad', cell) && R.flyCheck(C, 'enemy', 'wing', cell)) break;
    const type = R.flyCheck(C, 'enemy', 'quad', cell) ? 'wing' : 'quad', r = R.fly(C, 'enemy', type, cell, rnd);
    if (!r.ok) break; for (const id of r.cells) C.eintel[id] = C.turn;
    C.euavLog = r;
  }
  // ---- 2. assess
  // (v5) spotted big player formations up to two squares from its line count as a threat too (60%): it reacts to a
  // concentration it sees forming in the player's rear
  const massNear = c => C.forces.filter(t => bigSpotted(C, t) && !C.adjacent(t.cell, c.id) && cheb(C.cell(t.cell), c) === 2).reduce((s, t) => s + C.tfPower(t) * 0.6, 0);
  const threats = front.map(c => {
    const pow = C.neighbors(c.id).filter(n => C.owner[n] === 'player').reduce((a, n) => a + C.forcesAt(n).filter(t => seen(C, t)).reduce((s, t) => s + C.tfPower(t), 0), 0) + massNear(c);
    const def = strengthAt(C, c.id) * EF_POWER + (C.fort[c.id] || 0) * (urbanOf(c) >= 1 ? 1.0 : 0.6) + urbanOf(c);
    return { cell: c.id, pow, def, ratio: pow / Math.max(0.5, def), v: value(C, c.id) };
  }).filter(t => t.pow > 0).sort((a, b) => b.ratio * b.v - a.ratio * a.v);
  const startEnemy = id => C.cell(id).owner === 'enemy';
  const opps = [];
  for (const c of A.cells) {
    if (C.owner[c.id] === 'enemy') continue;
    const adjE = C.neighbors(c.id).filter(n => C.owner[n] === 'enemy'); if (!adjE.length) continue;
    let v = value(C, c.id);
    if (adjE.length >= 4) v += 2;                                    // a penetration into its line
    if (startEnemy(c.id)) v += 1.5;                                  // its own ground, lost
    if ((C.supplied?.[c.id] ?? 1) < 0.5) v += 1.5;                   // cut-off player square
    if (C.owner[c.id] === 'contested') v += 1;
    opps.push({ cell: c.id, v, need: playerDef(C, c.id) * (C.owner[c.id] === 'contested' ? 0.6 : 1) });
  }
  // ---- 3. reserve
  const inContact = f => C.neighbors(f.cell).some(n => C.owner[n] !== 'enemy');
  const fs = C.eforces.filter(f => f.str >= 0.3);
  const reserve = fs.length >= 3 ? fs.filter(f => !inContact(f)).sort((a, b) => b.str - a.str)[0] : null;
  if (reserve) reserve.reserve = true; for (const f of fs) if (f !== reserve) f.reserve = false;
  const used = new Set();
  const moveTo = (f, cell, Rf) => { const d = (Rf || reach(C, f)).dist[cell]; if (d == null || d > f.mp + 1e-6) return false; if (cell !== f.cell) f.movedT = C.turn; f.cell = cell; f.mp -= d; return true; };
  // ---- 4. defend
  for (const t of threats) {
    if (t.ratio < (t.v >= 7 ? 0.6 : 0.8) || (forcesAt(C, t.cell).length && t.ratio < (t.v >= 7 ? 0.8 : 1.3))) continue;
    const critical = t.v >= 4;
    const cand = fs.filter(f => !used.has(f) && f.cell !== t.cell && (f !== reserve || critical)).map(f => ({ f, d: reach(C, f).dist[t.cell] })).filter(x => x.d != null && x.d <= x.f.mp).sort((a, b) => a.d - b.d)[0];
    if (cand && !(threats.some(o => o.cell === cand.f.cell && o.ratio > t.ratio))) { moveTo(cand.f, t.cell); used.add(cand.f); log.push(`${cand.f.name} moves to ${C.cellName(t.cell)}`); }
  }
  // ---- 5. attack (concentration)
  const maxA = p < 0.12 ? 1 : p < 0.2 ? 2 : 3, bar = Math.max(0.85, 1.45 - p * 2.5);
  const announced = [];
  opps.sort((a, b) => b.v / b.need - a.v / a.need);
  for (const o of opps) {
    if (announced.length >= maxA) break;
    if (rnd() > Math.min(0.95, p * 3 + 0.35)) continue;
    const stages = C.neighbors(o.cell).filter(n => C.owner[n] === 'enemy' && isFinite(C.baseCost(n, o.cell)));
    let best = null;
    for (const s of stages) {
      const group = [];
      for (const f of fs) {
        if (used.has(f) || f.attacked || (f.supply ?? 1) < 0.5 || f.str < 0.5) continue;
        if (f === reserve && !(value(C, o.cell) >= 4 && startEnemy(o.cell))) continue;   // the reserve counterattacks only for key ground
        const d = f.cell === s ? 0 : reach(C, f).dist[s]; if (d == null || d > f.mp - 1 + 1e-6 && f.cell !== s) continue;
        group.push({ f, d });
      }
      group.sort((a, b) => b.f.str - a.f.str);
      let sum = 0; const pick = [];
      for (const g of group) { pick.push(g); sum += g.f.str * (0.6 + 0.4 * (g.f.supply ?? 1)); if (sum * EF_POWER >= o.need * bar) break; }
      const odds = sum * EF_POWER / o.need;
      if (pick.length && (!best || odds > best.odds)) best = { s, pick, odds };
    }
    const key = startEnemy(o.cell) && value(C, o.cell) >= 7;          // its own hub / goal square, lost: counterattack hard
    if (!best || best.odds < (key ? Math.min(bar, 0.9) : bar)) continue;
    // concentrate on the staging square and combine
    const lead = best.pick[0].f; moveTo(lead, best.s);
    for (const g of best.pick.slice(1)) { if (moveTo(g.f, best.s)) { lead.str = Math.min(3, lead.str + g.f.str); lead.max = Math.min(3, (lead.max || lead.str) + (g.f.max || g.f.str)); C.eforces = C.eforces.filter(x => x !== g.f); log.push(`${g.f.name} joins ${lead.name}`); } used.add(g.f); }
    used.add(lead); lead.attacked = true; lead.attackedT = C.turn;
    announced.push({ tf: lead, to: o.cell, from: best.s });
  }
  // ---- idle task forces: close up to the most threatened sector (or hold)
  for (const f of fs) {
    if (used.has(f) || f === reserve || !C.eforces.includes(f)) continue;
    if (threats.some(t => t.cell === f.cell)) continue;
    const t = threats.find(x => !forcesAt(C, x.cell).length); if (!t) continue;
    const Rf = reach(C, f), dest = Object.keys(Rf.dist).filter(id => Rf.dist[id] <= f.mp).sort((a, b) => cheb(C.cell(a), C.cell(t.cell)) - cheb(C.cell(b), C.cell(t.cell)))[0];
    if (dest && cheb(C.cell(dest), C.cell(t.cell)) < cheb(C.cell(f.cell), C.cell(t.cell))) moveTo(f, dest, Rf);
  }
  // ---- 6. fires
  const bats = (C.arty?.enemy || []).filter(b => F.ready(C, b));
  const shoot = (kind, cell) => { for (const b of bats) { if (b.acted === C.turn) continue; if (F.fireCheck(C, 'enemy', b, kind, cell)) continue; const r = F.fire(C, 'enemy', b.id, kind, cell, rnd); if (r.ok) { C.applyFire(r, rnd); return true; } } return false; };
  for (const pb of (C.arty?.player || []).filter(b => F.found(C, 'enemy', b))) if (rnd() < 0.6) shoot('counterbattery', pb.cell);
  for (const a of announced) shoot('suppress', a.to);
  // (v5) the biggest player formation it can see gets artillery attention first
  const masses = (C.espots?.turn === C.turn ? C.espots.list : []).filter(x => C.tf(x.id)?.cell === x.cell);
  for (const m of masses.slice(0, 1)) if (shoot('suppress', m.cell)) log.push(`fire on the spotted formation at ${C.cellName(m.cell)}`);
  const spoil = threats.flatMap(t => C.neighbors(t.cell).filter(n => C.owner[n] === 'player' && C.forcesAt(n).some(x => seen(C, x)))).sort((a, b) => C.forcesAt(b).reduce((s, t) => s + C.tfPower(t), 0) - C.forcesAt(a).reduce((s, t) => s + C.tfPower(t), 0));
  for (const cell of [...new Set(spoil)].slice(0, 2)) shoot('suppress', cell);
  if ((C.ammo?.enemy || 0) >= 2 && p >= 0.14) { const ch = chokepoints(C, C.supplyNet.player, 3).find(x => C.isOpen ? true : true); if (ch) shoot('interdict', ch.cell); }
  CACHE = null;
  return { announced, log };
}

// a player win on a square with enemy task forces: they fall back to the best neighbouring enemy square or are destroyed
export function pushOut(C, cell, rnd) {
  for (const f of forcesAt(C, cell)) {
    const back = C.neighbors(cell).filter(n => C.owner[n] === 'enemy').sort((a, b) => (C.esupplied?.[b] ?? 0) - (C.esupplied?.[a] ?? 0) || strengthAt(C, a) - strengthAt(C, b))[0];
    f.str = Math.round(f.str * (0.55 + rnd() * 0.15) * 100) / 100;
    if (!back || f.str < 0.3) { C.eforces = C.eforces.filter(x => x !== f); C.note(`Enemy ${f.name} destroyed at ${C.cellName(cell)}.`, 'good'); C.stats.efDestroyed = (C.stats.efDestroyed || 0) + 1; }
    else { f.cell = back; f.mp = 0; C.note(`Enemy ${f.name} falls back to ${C.cellName(back)}.`, 'good'); }
  }
}
// enemy losses in a fight at a square (lost defence or repulsed attack)
export function attrit(C, cell, k) { for (const f of forcesAt(C, cell)) { f.str = Math.max(0, Math.round((f.str - k) * 100) / 100); } C.eforces = (C.eforces || []).filter(f => f.str >= 0.25 || (C.note(`Enemy ${f.name} has been destroyed.`, 'good'), (C.stats.efDestroyed = (C.stats.efDestroyed || 0) + 1), false)); }

// weekly upkeep: supply, recovery, reinforcements
export function upkeep(C) {
  const E = C.def.enemy || {};
  for (const f of C.eforces || []) {
    f.supply = C.esupplied?.[f.cell] ?? 0;
    if (f.supply >= 1 && !f.attacked) f.str = Math.min(f.max || f.str, Math.round((f.str + 0.08) * 100) / 100);
    else if (f.supply < 0.5) f.str = Math.max(0.2, Math.round((f.str - 0.1) * 100) / 100);
  }
  // higher command answers a crisis: when the brigade's battalion groups are worn down (total strength under
  // enemy.minStrength) a fresh battalion is sent every enemy.crisisWeeks weeks while it still holds a working hub
  const tot = (C.eforces || []).reduce((a, f) => a + f.str, 0);
  if (E.minStrength && tot < E.minStrength && C.turn - (C.efCrisis || -99) >= (E.crisisWeeks || 4)) {
    const hub = (C.supplyNet?.enemy?.hubs || []).find(h => h.cap > 0 && !h.captured);
    if (hub) { C.efCrisis = C.turn; C.eforces.push({ id: C.newId('ef'), name: `${E.crisisName || 'Reserve battalion'} #${(C.efCrisisN = (C.efCrisisN || 0) + 1)}`, kind: 'mech', cell: hub.cell, str: 1.1, max: 1.1, mp: 0, attacked: false, supply: 1 }); C.note(`Intelligence: the enemy rushes a reserve battalion to ${C.cellName(hub.cell)}.`, 'bad'); }
  }
  C.efArrived ||= {};
  for (const [i, r] of (E.reinforcements || []).entries()) {
    if (C.efArrived[i] || String(r.date) > C.date) continue;
    C.efArrived[i] = 1;
    const at = [r.cell, ...(C.def.aor.hubs || []).filter(h => (h.side || 'player') === 'enemy').map(h => h.cell), ...(C.def.aor.enemySources || [])].find(id => id && C.owner[id] === 'enemy');
    if (!at) continue;
    C.eforces.push({ id: C.newId('ef'), name: r.name, kind: r.kind || 'mech', cell: at, str: r.str || 1, max: r.str || 1, mp: 0, attacked: false, supply: 1 });
    C.note(`Intelligence: enemy reinforcements — ${r.name} — reported arriving in the sector.`, 'bad');
  }
}
