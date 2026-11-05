// Campaign v2 — UAV reconnaissance on the strategic grid (both sides, same rules).
//
// Research basis (PROGRESS_RULES.md): brigades scouted with commercial quadcopters (DJI Mavic 3 / Autel: a few km past
// the line, minutes of flight) and fixed-wing drones (Ukraine's Leleka-100 / Furia, Russia's Orlan-10 / ZALA: tens of
// km, hours aloft) that also spot for the guns. Electronic warfare was dense — RUSI counted at least one major Russian
// EW system per 10 km of front and Ukrainian drone losses of ~10,000 a month in 2023 — and grew through 2023–24.
//
// Rules: each week a side has SORTIES (2 + upgrades) limited by its AIRFRAMES (stock, +1 a week back from the depot
// while the HQ is supplied, max 6). A sortie flies to a square within the type's reach of the own line and observes the
// squares around it (radius): enemy garrison strength, fortifications, task forces, batteries and hubs are known for
// this week and the next (C.intel). The drone may be lost to EW / air defence: the base risk of its type, +3% per enemy
// task force at the target, +5% from July 2023 and +8% from 2024 (EW growth); a lost drone still sends its first
// pictures half the time (the centre square only).
export const UAV = {
  quad: { label: 'Quadcopter (Mavic 3 / Autel)', ru: 'Quadcopter (Mavic 3)', reach: 3, radius: 1, loss: 0.08 },
  wing: { label: 'Fixed-wing (Leleka-100)', ru: 'Fixed-wing (Orlan-10)', reach: 8, radius: 1, loss: 0.15 },
};
export const UAV_MAX = 6, INTEL_TURNS = 2;
const cheb = (a, b) => Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));

export function sorties(C, side) {
  const m = side === 'player' ? C.mods() : (C.def.enemy?.uavMods || {});
  return 2 + (m.reconDrone ? 1 : 0) + (m.uavSorties || 0);
}
export function radius(C, side, type) { const m = side === 'player' ? C.mods() : (C.def.enemy?.uavMods || {}); return UAV[type].radius + (type === 'wing' && m.spotRange ? 1 : 0); }
export function ewRisk(C, side, cellId) {
  const d = C.date; let p = d >= '2024-01-01' ? 0.08 : d >= '2023-07-01' ? 0.05 : 0;
  const foes = side === 'player' ? (C.eforces || []).filter(f => f.cell === cellId).length : C.forcesAt(cellId).length;
  p += foes * 0.03;
  const ew = side === 'player' ? (C.def.enemy?.ew || 0) : (C.mods().ewJam || 0);   // the other side's jammers
  return Math.min(0.35, p + ew * 0.3);
}
// distance (squares) from a side's nearest own square
export function depth(C, side, cellId) { const t = C.cell(cellId); let best = 99; for (const c of C.def.aor.cells) if (C.owner[c.id] === side) best = Math.min(best, cheb(c, t)); return best; }

export function flyCheck(C, side, type, cellId) {
  const U = C.uav?.[side]; if (!U) return 'No drones';
  if (!UAV[type]) return 'Unknown drone type';
  if (U.used >= sorties(C, side)) return 'No sorties left this week';
  if (U.stock <= 0) return 'No airframes left: wait for deliveries';
  if (!C.cell(cellId)) return 'No such square';
  if (side === 'player' && C.isOpen && !C.isOpen(cellId)) return 'Beyond the brigade\'s area of responsibility';
  if (depth(C, side, cellId) > UAV[type].reach) return `Out of reach (${UAV[type].reach * (C.def.aor.cellKm || 2)} km past the line)`;
  return null;
}
// returns { ok, lost, cells: [observed squares], risk }
export function fly(C, side, type, cellId, rnd) {
  const why = flyCheck(C, side, type, cellId); if (why) return { ok: false, why };
  const U = C.uav[side]; U.used++;
  const risk = ewRisk(C, side, cellId) + UAV[type].loss, lost = rnd() < risk;
  const t = C.cell(cellId), r = radius(C, side, type), cells = [];
  if (!lost || rnd() < 0.5) for (const c of C.def.aor.cells) if (cheb(c, t) <= (lost ? 0 : r)) cells.push(c.id);
  if (lost) { U.stock--; U.lost = (U.lost || 0) + 1; }
  (U.log ||= []).push({ turn: C.turn, type, cell: cellId, lost }); if (U.log.length > 20) U.log.shift();
  return { ok: true, lost, cells, risk: Math.round(risk * 100) / 100, type, cell: cellId };
}
export function weekly(C, side, hqSupplied) { const U = C.uav?.[side]; if (!U) return; U.used = 0; if (hqSupplied && U.stock < (U.max || UAV_MAX)) U.stock++; }

// ------------------------------------------------------------------ big formations give themselves away (campaign v5)
// A battalion group massed into one task force cannot hide on a front watched around the clock by drones, Orlan /
// Leleka patrols, satellites and radio direction finding: columns, vehicle parks, assembly areas and the radio traffic
// of a big headquarters are found even without a dedicated sortie, and then draw artillery, Lancets and UAV
// attention. Small dispersed groups stay hidden unless a drone looks at their square or they are in contact.
// SIGNATURE = companies in the task force (player: unit records alive; enemy: 3 per point of strength — a battalion)
//   +1 if it moved this / last week, +1 if it attacked (or is preparing an announced attack), -1 in a town, works or
//   woods when it kept still. SIGNATURE >= SPOT_SIZE (5, i.e. more than four companies) = SPOTTED by the other side,
//   if it stands within SPOT_DEPTH squares of that side's line: 2 squares at 5, +2 per point above (6 -> 4, 7 -> 6,
//   8+ -> 8). Spotted task forces are known to the other side (strength, position) for its next week, the enemy AI
//   aims spoiling fire at the biggest one it sees and both sides' suppression hits a spotted mass twice as hard.
export const SPOT_SIZE = 5, SPOT_DEPTH_MAX = 8;
const COVER = new Set(['urban', 'industrial', 'forest']);
export function companies(C, side, f) { return side === 'player' ? C.tfUnits(f).filter(u => C.alive(u)).length : Math.max(1, Math.round((f.str || 0) * 3)); }
// { n, sig, depth, moved, attacked } for a task force of `side` ('player' = C.forces, 'enemy' = C.eforces)
export function signature(C, side, f) {
  const n = companies(C, side, f), T = C.turn;
  let moved, attacked;
  if (side === 'player') { moved = (f.mp < C.tfMpMax(f) - 1e-6) || (f.movedT ?? -9) >= T - 1; attacked = !!f.attacked || !!f.planned || (f.attackedT ?? -9) >= T - 1; }
  else { moved = (f.movedT ?? -9) >= T - 1; attacked = !!f.attacked || (f.attackedT ?? -9) >= T - 1; }
  const c = C.cell(f.cell), cover = c && COVER.has(c.terrain) && !moved && !attacked ? 1 : 0;
  const sig = n + (moved ? 1 : 0) + (attacked ? 1 : 0) - cover;
  return { n, sig, moved, attacked, cover: !!cover, depth: sig >= SPOT_SIZE ? Math.min(SPOT_DEPTH_MAX, 2 + (sig - SPOT_SIZE) * 2) : 0 };
}
// is task force f of `side` spotted by the other side right now? -> the signature (with .spotted, .dist) or null
export function spotted(C, side, f) {
  const s = signature(C, side, f); if (s.sig < SPOT_SIZE) return null;
  const obs = side === 'player' ? 'enemy' : 'player', d = depth(C, obs, f.cell);
  return d <= s.depth ? { ...s, dist: d, spotted: true } : null;
}
// all task forces of `side` the other side sees because of their size: [{ id, cell, name, kind, str|n, sig, depth }]
export function spottedList(C, side) {
  const list = side === 'player' ? C.forces : (C.eforces || []), out = [];
  for (const f of list) { const s = spotted(C, side, f); if (s) out.push({ id: f.id, cell: f.cell, name: f.name, kind: f.kind, str: f.str, n: s.n, sig: s.sig, depth: s.depth, moved: s.moved, attacked: s.attacked }); }
  return out.sort((a, b) => b.sig - a.sig);
}
