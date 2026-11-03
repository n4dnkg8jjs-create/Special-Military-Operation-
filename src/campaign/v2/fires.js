// Campaign v2 — brigade fires (artillery / mortars / rockets) on the strategic grid, the same rules for both sides.
//
// Research basis (PROGRESS_RULES.md): a 2023 brigade fought with its own artillery group — a 120 mm mortar battery
// (~7 km), a 122 mm howitzer battalion (2S1 / D-30, ~15 km), a 152/155 mm battalion (2S3 ~18 km, 2S19 Msta-S 24.7 km,
// M777 ~24 km) and a 122 mm rocket battalion (BM-21 Grad, ~20 km) — but the limit was SHELLS, not tubes: Ukraine
// fired ~3,600 rounds a day in spring 2023 and ~2,000 by early 2024 against Russia's ~10,000 ("ten-to-one" at
// Avdiivka). Both sides hunted each other's guns with drones, counter-battery radar and Lancets, so guns that fire are
// found and guns that stay put die (shoot and scoot).
//
// Rules (one "fire mission" = a battery's concentrated fire for the week on one grid square):
//   * every BATTERY may either FIRE ONE MISSION or DISPLACE (up to 3 squares inside own, supplied ground) per week;
//     it fires only if its square is supplied (>= 0.5) and the target is within its range (km / cellKm squares);
//   * missions draw on the brigade's AMMUNITION STOCK, refilled weekly by the date's shell allocation (content:
//     start.ammo / enemy.ammo step tables) times the supply at the brigade HQ / hub;
//   * SUPPRESS (1, rockets 2): the square's defenders fight at -12% per mission (max 2 stacks, less against dug-in
//     defenders: x(1 - 0.15 per fortification level)) until the other side has moved,
//     the line there loses strength, a task force there may lose men / vehicles; prep fire before an attack also gives
//     the battle extra mortar missions;
//   * INTERDICT (1): fire on a road / hub square: the other side's supply routes through it cost +4 and a hub there
//     works at half throughput until the other side's next week;
//   * COUNTER-BATTERY (2): fire at a square holding an enemy battery that has been FOUND (it fired last / this week, or
//     the square is under fresh drone observation): 30% (+15% with fresh drone intel) to hit it for -35% strength;
//     three hits destroy it.
//     A destroyed battery is rebuilt by higher command after 5 weeks at half strength.
//   * Firing REVEALS the battery's square to the other side for a week (65%: counter-battery radar, drones);
//     displacing hides it again.
export const BATTERY = {
  mortar120: { label: '120 mm mortar battery', short: 'Mortars 120', km: 7, cost: 1, n: 1 },
  how122: { label: '122 mm SP howitzer battalion (2S1)', short: '2S1 122 mm', km: 15, cost: 1, n: 1 },
  d30: { label: '122 mm towed howitzer battalion (D-30)', short: 'D-30 122 mm', km: 15, cost: 1, n: 1 },
  how152: { label: '152 mm SP howitzer battalion (2S3)', short: '2S3 152 mm', km: 18, cost: 1, n: 1 },
  msta: { label: '152 mm SP howitzer battalion (2S19 Msta-S)', short: '2S19 152 mm', km: 24, cost: 1, n: 1 },
  m777: { label: '155 mm howitzer battery (M777)', short: 'M777 155 mm', km: 24, cost: 1, n: 1, cb: 0.1 },
  grad: { label: '122 mm rocket battalion (BM-21 Grad)', short: 'Grad MLRS', km: 20, cost: 2, n: 2 },
};
export const MISSIONS = {
  suppress: { label: 'Suppress', desc: 'Fire on the defenders of a square: they fight weaker until the enemy has moved, and lose men.' },
  interdict: { label: 'Interdict', desc: 'Put a road or hub square under fire: enemy supply through it is cut back until his next week.' },
  counterbattery: { label: 'Counter-battery', desc: 'Fire at a found enemy battery: 30% to hit (45% with fresh drone observation); three hits destroy it.' },
};
export const SUPPRESS_STEP = 0.12, SUPPRESS_MAX = 2, CB_HIT = 0.3, CB_INTEL = 0.15, CB_DMG = 0.35, REVEAL = 0.65, REBUILD = 5, DISPLACE = 3;
const OPP = s => (s === 'player' ? 'enemy' : 'player');
const cheb = (a, b) => Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));

// the defence multiplier of suppression on a square (1 = none)
export function suppressMul(C, cellId, by) { const s = C.suppressed?.[cellId]; if (!s || (by && s.by !== by)) return 1; return 1 - SUPPRESS_STEP * Math.min(SUPPRESS_MAX, s.n) * (1 - 0.15 * (C.fort?.[cellId] || 0)); }
export function batteryDef(b) { return BATTERY[b.kind] || BATTERY.how122; }
export function rangeCells(C, b) { return Math.floor(batteryDef(b).km / (C.def.aor.cellKm || 2)); }
export function inRange(C, b, cellId) { const p = C.cell(b.cell), q = C.cell(cellId); return !!(p && q) && cheb(p, q) <= rangeCells(C, b); }
export function ready(C, b) { return !b.down && b.hp > 0 && b.acted !== C.turn; }
// the squares a battery can hit (for the UI's range ring)
export function coverage(C, b) { const p = C.cell(b.cell), R = rangeCells(C, b), out = []; if (!p) return out; for (const c of C.def.aor.cells) if (cheb(p, c) <= R) out.push(c.id); return out; }
// an opposing battery is FOUND by `side` if it fired since the last week, or its square is under fresh observation
export function found(C, side, b) {
  if (b.down || b.hp <= 0) return false;
  if (b.revealed != null && b.revealed >= C.turn - 1) return true;
  return side === 'player' ? (C.intel?.[b.cell]?.turn ?? -9) >= C.turn - 1 : (C.eintel?.[b.cell] ?? -9) >= C.turn - 1;
}
export function cost(b, kind) { return kind === 'counterbattery' ? 2 : batteryDef(b).cost; }

// why a mission is not possible (null = it is)
export function fireCheck(C, side, b, kind, cellId) {
  if (!b) return 'No such battery';
  if (!MISSIONS[kind]) return 'Unknown fire mission';
  if (b.down) return `Being rebuilt (${b.down} wk)`;
  if (b.acted === C.turn) return b.moved === C.turn ? 'Displaced this week' : 'Already fired this week';
  if ((C.supplyNet?.[side]?.level?.[b.cell] ?? 0) < 0.5) return 'Battery out of supply';
  const c = C.cell(cellId); if (!c) return 'No such square';
  if (side === 'player' && C.isOpen && !C.isOpen(cellId)) return 'Beyond the brigade\'s area of responsibility';
  if (!inRange(C, b, cellId)) return `Out of range (${batteryDef(b).km} km)`;
  if ((C.ammo?.[side] ?? 0) < cost(b, kind)) return 'Not enough ammunition';
  if (C.owner[cellId] === side) return 'Own square';
  if (kind === 'counterbattery' && !(C.arty?.[OPP(side)] || []).some(x => x.cell === cellId && found(C, side, x))) return 'No found enemy battery there';
  return null;
}

// fire a mission: effects on the other side are applied by the caller's hooks (state.js) so versus can route them
export function fire(C, side, id, kind, cellId, rnd = Math.random) {
  const b = (C.arty?.[side] || []).find(x => x.id === id), why = fireCheck(C, side, b, kind, cellId); if (why) return { ok: false, why };
  const k = cost(b, kind); C.ammo[side] = Math.round((C.ammo[side] - k) * 10) / 10; b.acted = C.turn; if (rnd() < REVEAL) b.revealed = C.turn; b.fired = (b.fired || 0) + 1;
  const res = { ok: true, side, battery: b.id, kind, cell: cellId, n: kind === 'suppress' ? batteryDef(b).n * (b.hp < 1 ? 0.5 : 1) : 1, cb: batteryDef(b).cb || 0 };
  return res;
}
export function moveCheck(C, side, b, cellId) {
  if (!b) return 'No such battery';
  if (b.down) return `Being rebuilt (${b.down} wk)`;
  if (b.acted === C.turn) return b.moved === C.turn ? 'Already displaced this week' : 'Fired this week: it displaces next week';
  if (C.owner[cellId] !== side) return 'Batteries move inside own lines';
  if (cellId === b.cell) return 'Already there';
  if ((C.supplyNet?.[side]?.level?.[cellId] ?? 0) < 0.5) return 'That square is out of supply';
  if (cheb(C.cell(b.cell), C.cell(cellId)) > DISPLACE) return `Displace at most ${DISPLACE} squares a week`;
  return null;
}
export function displace(C, side, id, cellId) {
  const b = (C.arty?.[side] || []).find(x => x.id === id), why = moveCheck(C, side, b, cellId); if (why) return why;
  b.cell = cellId; b.acted = C.turn; b.moved = C.turn; b.revealed = null; return null;
}
// counter-battery dice against the batteries in a square
export function resolveCB(C, side, cellId, bonus, rnd) {
  const hits = [];
  for (const x of C.arty?.[OPP(side)] || []) {
    if (x.cell !== cellId || !found(C, side, x)) continue;
    const intel = side === 'player' ? (C.intel?.[cellId]?.turn ?? -9) >= C.turn - 1 : (C.eintel?.[cellId] ?? -9) >= C.turn - 1;
    if (rnd() < CB_HIT + (intel ? CB_INTEL : 0) + (bonus || 0)) { x.hp = Math.round((x.hp - CB_DMG) * 100) / 100; if (x.hp <= 0) { x.hp = 0; x.down = REBUILD; } hits.push(x); }
  }
  return hits;
}
// weekly: rebuild destroyed batteries
export function weekly(C, side) {
  for (const b of C.arty?.[side] || []) if (b.down && --b.down <= 0) { b.down = 0; b.hp = 0.5; b.revealed = null; }
}
export { OPP, cheb };
