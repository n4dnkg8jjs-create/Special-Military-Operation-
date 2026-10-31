import * as THREE from 'three';

// Hit-location armour model. Each vehicle is a set of armour zones (boxes in vehicle-local metres: x right,
// y up, z forward, origin on the ground at the hull centre) with per-face protection in mm RHA-equivalent
// against kinetic (KE) and shaped-charge (CE) attack, plus explosive reactive armour (ERA) that adds
// protection against single-charge HEAT and (Kontakt-5/Relikt only) APFSDS until the tiles are used up.
// Values follow open-source estimates (Zaloga, btvt.info, Warspot):
//   T-72B3 (2016+): turret front ~520 KE / 900 CE base + Relikt/K-5 (+~250 KE, +~500 CE vs single charge),
//     upper glacis ~520 KE / 600 CE + K-5, lower front plate ~220, hull side 80 + rubber skirts with
//     ERA on the front third, turret side ~350/450 at the cheeks falling to ~90 at the rear, roof ~40–60.
//   T-72AV (Ukraine): turret ~410 KE / 500 CE, glacis ~335 / 450, Kontakt-1 (+0 KE, +~350 CE vs single charge).
//   BTR-80 / BTR-82A: hull 7–10 mm rolled steel (front upper 10 mm steeply sloped ≈ 14–16 mm LOS,
//     sides 7–9 mm, rear 7, roof 7), turret 7–10 mm. Stops 7.62 ball at range; 12.7/14.5 mm and 30 mm defeat it.
// Behind the armour, interior components (crew, ammunition, fuel, engine, breech, optics, turret ring) sit
// where they are in the real vehicles; a penetrating round damages what lies along its path (plus spall).

const Z = (x0, x1, y0, y1, z0, z1, faces, name) => ({ name, min: [x0, y0, z0], max: [x1, y1, z1], faces });
const F = (ke, ce, era) => ({ ke, ce, era });

function tankZones(model) {
  const b3 = model === 't72b3';
  const eraT = b3 ? { ke: 250, ce: 500 } : { ke: 0, ce: 350 }, eraG = b3 ? { ke: 220, ce: 450 } : { ke: 0, ce: 330 };
  return [
    Z(-1.15, 1.15, 1.55, 2.3, -1.5, 1.25, { front: F(b3 ? 520 : 410, b3 ? 900 : 500, eraT), side: F(b3 ? 330 : 280, b3 ? 420 : 350, b3 ? { ke: 60, ce: 300 } : { ke: 0, ce: 200 }), rear: F(80, 90), top: F(55, 60, b3 ? { ke: 0, ce: 150 } : null) }, 'turret'),
    Z(-1.75, 1.75, 0.95, 1.55, 2.35, 3.45, { front: F(b3 ? 520 : 335, b3 ? 600 : 450, eraG), side: F(80, 80), top: F(40, 40) }, 'glacis'),
    Z(-1.75, 1.75, 0.3, 0.95, 2.5, 3.45, { front: F(220, 230), side: F(80, 80) }, 'lower_front'),
    Z(-1.75, 1.75, 0.3, 1.55, -3.45, 2.5, { side: F(80, 80, { ke: 0, ce: b3 ? 250 : 200, front: true }), rear: F(45, 45), top: F(40, 40) }, 'hull'),
    Z(-1.82, -1.4, 0.0, 0.85, -3.4, 3.2, { side: F(25, 25), front: F(25, 25), rear: F(25, 25) }, 'tracks_l'),
    Z(1.4, 1.82, 0.0, 0.85, -3.4, 3.2, { side: F(25, 25), front: F(25, 25), rear: F(25, 25) }, 'tracks_r'),
  ];
}
const TANK_PARTS = [
  { name: 'driver', crew: 'driver', min: [-0.5, 0.4, 1.9], max: [0.5, 1.3, 2.9] },
  { name: 'carousel', ammo: 0.75, min: [-1.1, 0.35, -0.6], max: [1.1, 0.75, 1.0] },
  { name: 'hull_rack', ammo: 0.45, fuel: 0.4, min: [0.6, 0.4, 1.6], max: [1.6, 1.4, 2.6] },
  { name: 'gunner', crew: 'gunner', min: [-1.0, 1.0, -0.2], max: [-0.2, 2.0, 0.8] },
  { name: 'commander', crew: 'commander', min: [0.2, 1.0, -0.4], max: [1.0, 2.0, 0.6] },
  { name: 'breech', gun: true, min: [-0.3, 1.5, -0.6], max: [0.3, 2.1, 0.9] },
  { name: 'optics', optics: true, min: [-1.1, 2.0, 0.6], max: [1.1, 2.35, 1.15] },
  { name: 'turret_ring', ring: true, min: [-1.0, 1.42, -0.9], max: [1.0, 1.6, 1.0] },
  { name: 'fuel_r', fuel: 0.45, min: [1.2, 0.4, -2.5], max: [1.7, 1.4, 1.6] },
  { name: 'fuel_l', fuel: 0.45, min: [-1.7, 0.4, -0.5], max: [-1.2, 1.4, 2.4] },
  { name: 'engine', engine: true, fuel: 0.25, min: [-1.4, 0.4, -3.4], max: [1.4, 1.5, -1.6] },
];
function btrZones() {
  return [
    Z(-1.45, 1.45, 0.55, 2.05, -3.75, 3.6, { front: F(15, 15), side: F(9, 9), rear: F(7, 7), top: F(7, 7), bottom: F(7, 7) }, 'hull'),
    Z(-0.75, 0.75, 2.05, 2.75, 0.6, 2.0, { front: F(10, 10), side: F(8, 8), rear: F(7, 7), top: F(7, 7) }, 'turret'),
    Z(-1.5, -1.25, 0.0, 1.1, -3.2, 3.0, { side: F(12, 12), front: F(12, 12), rear: F(12, 12) }, 'wheels_l'),
    Z(1.25, 1.5, 0.0, 1.1, -3.2, 3.0, { side: F(12, 12), front: F(12, 12), rear: F(12, 12) }, 'wheels_r'),
  ];
}
const BTR_PARTS = [
  { name: 'driver', crew: 'driver', min: [-0.9, 0.8, 2.3], max: [-0.1, 1.9, 3.4] },
  { name: 'commander', crew: 'commander', min: [0.1, 0.8, 2.3], max: [0.9, 1.9, 3.4] },
  { name: 'gunner', crew: 'gunner', min: [-0.6, 1.4, 0.9], max: [0.6, 2.6, 1.9] },
  { name: 'ammo', ammo: 0.3, fuel: 0.2, min: [-0.5, 1.0, 0.7], max: [0.5, 1.6, 1.9] },
  { name: 'troops', troops: true, min: [-1.2, 0.6, -1.4], max: [1.2, 1.9, 2.2] },
  { name: 'fuel', fuel: 0.5, min: [-1.3, 0.6, -1.7], max: [1.3, 1.6, -1.0] },
  { name: 'engine', engine: true, fuel: 0.3, min: [-1.2, 0.6, -3.7], max: [1.2, 1.8, -1.7] },
  { name: 'weapon', gun: true, min: [-0.25, 2.05, 1.6], max: [0.25, 2.5, 3.2] },
];

export function armorModelOf(v) { return v.kind === 'tank' ? (v.faction.id === 'RU' ? 't72b3' : 't72av') : 'btr'; }
export function initArmor(v) {
  const m = armorModelOf(v);
  v.zones = m === 'btr' ? btrZones() : tankZones(m);
  v.parts = m === 'btr' ? BTR_PARTS : TANK_PARTS;
  v.eraLeft = {}; // per zone+face remaining ERA coverage (0..1)
  for (const z of v.zones) for (const [f, a] of Object.entries(z.faces)) if (a.era) v.eraLeft[z.name + ':' + f] = 1;
  v.crewList = [{ role: 'commander', hp: 100 }, { role: 'gunner', hp: 100 }, { role: 'driver', hp: 100 }];
  v.wheelsLost = 0;
}

const tmp = new THREE.Vector3();
function toLocal(v, p) { const dx = p.x - v.pos.x, dz = p.z - v.pos.z, c = Math.cos(v.heading), s = Math.sin(v.heading); return [dx * c - dz * s, p.y, dx * s + dz * c]; }
function dirLocal(v, d) { const c = Math.cos(v.heading), s = Math.sin(v.heading); return [d.x * c - d.z * s, d.y, d.x * s + d.z * c]; }
// slab test: returns [tEnter, tExit, axis, sign] or null
function rayBox(o, d, b) {
  let t0 = -1e9, t1 = 1e9, ax = 0, sg = 0;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < b.min[i] || o[i] > b.max[i]) return null; continue; }
    let a = (b.min[i] - o[i]) / d[i], c = (b.max[i] - o[i]) / d[i], s = -1;
    if (a > c) { [a, c] = [c, a]; s = 1; }
    if (a > t0) { t0 = a; ax = i; sg = s; }
    t1 = Math.min(t1, c); if (t0 > t1) return null;
  }
  return t1 < 0 ? null : [t0, t1, ax, sg];
}
const faceName = (ax, sg) => ax === 1 ? (sg > 0 ? 'top' : 'bottom') : ax === 2 ? (sg > 0 ? 'front' : 'rear') : 'side';

// Resolve a hit. W: weapon {pen, dmg, tandem?}, kind 'ke'|'ce'|'he', fromPos: shooter position, at: exact impact
// point (world) if known. Returns a description of what happened.
export function resolveHit(v, W, fromPos, kind, at = null, dist = 0) {
  const from = tmp.set(fromPos.x, Math.max(0.6, fromPos.y ?? 1.5), fromPos.z);
  // aim point: exact impact, or a point on the silhouette scattered around the centre of mass
  const g = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
  const P = at ? at.clone() : (() => { const c = Math.cos(v.heading), s = Math.sin(v.heading), lx = g() * v.def.width * 0.45, lz = g() * v.def.length * 0.4; return new THREE.Vector3(v.pos.x + lx * c + lz * s, 0.5 + Math.random() * (v.def.height - 0.4), v.pos.z - lx * s + lz * c); })();
  const dW = P.clone().sub(from); const L = dW.length(); dW.divideScalar(L);
  const o = toLocal(v, from), d = dirLocal(v, dW);
  let best = null;
  for (const z of v.zones) { const r = rayBox(o, d, z); if (r && r[0] > 0 && (!best || r[0] < best.r[0])) best = { z, r }; }
  if (!best) return { miss: true };
  const { z, r } = best, face = faceName(r[2], r[3]); const a = z.faces[face] || z.faces.side || { ke: 10, ce: 10 };
  const n = [0, 0, 0]; n[r[2]] = r[3]; const cos = Math.max(0.05, Math.abs(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]));
  // KE glances off at extreme obliquity
  if (kind === 'ke' && cos < 0.28 && Math.random() < 0.65) return { zone: z.name, face, ricochet: true };
  let armor = (kind === 'ke' ? a.ke : a.ce) / Math.max(0.3, cos);
  let eraHit = false;
  if (a.era && (!a.era.front || (o[2] + d[2] * r[0]) > 0.8)) { const key = z.name + ':' + face; const cov = v.eraLeft[key] ?? 0;
    if (cov > 0 && Math.random() < cov) { eraHit = true; v.eraLeft[key] = Math.max(0, cov - 0.12); armor += kind === 'ke' ? a.era.ke : (W.tandem ? a.era.ce * 0.15 : a.era.ce); } }
  // small-calibre KE loses penetration with range
  let pen = (W.pen || 0) * (0.88 + Math.random() * 0.24);
  if (kind === 'ke' && (W.pen || 0) < 100) pen *= Math.max(0.35, 1 - dist / 1400);
  const hitLocal = [o[0] + d[0] * r[0], o[1] + d[1] * r[0], o[2] + d[2] * r[0]];
  const res = { zone: z.name, face, armor: Math.round(armor), pen: Math.round(pen), era: eraHit, local: hitLocal, effects: [] };
  // running gear: tracks / wheels break even without penetrating the hull
  if (/tracks|wheels/.test(z.name)) {
    if (v.kind === 'tank') { if ((kind !== 'ke' || pen > 30) && Math.random() < (kind === 'ke' ? 0.35 : 0.65)) res.effects.push('track'); }
    else if (pen > 8 || kind !== 'ke') res.effects.push('wheel');
    res.pen0 = true; return res;
  }
  if (pen <= armor) { res.stopped = true; if (kind !== 'ke' && (W.pen || 0) > 100 && Math.random() < 0.25) res.effects.push(Math.random() < 0.5 ? 'optics' : 'stun'); return res; }
  res.penetrated = true;
  const residual = pen - armor;
  // behind-armour path: KE goes through, a HEAT jet runs out after a short distance; spall cone around it
  const depth = kind === 'ke' ? (W.pen > 100 ? 5 : Math.min(2.2, 0.4 + residual / 8)) : Math.min(3, 0.6 + residual / 120);
  const t0 = r[0], t1 = r[0] + depth;
  for (const part of v.parts) {
    const pr = rayBox(o, d, part);
    let p = 0;
    if (pr && pr[0] < t1 && pr[1] > t0) p = kind === 'ke' ? 0.85 : 0.9;
    else {
      const cx = (part.min[0] + part.max[0]) / 2, cy = (part.min[1] + part.max[1]) / 2, cz = (part.min[2] + part.max[2]) / 2;
      const tc = Math.max(t0, Math.min(t1, (cx - o[0]) * d[0] + (cy - o[1]) * d[1] + (cz - o[2]) * d[2]));
      const q = [o[0] + d[0] * tc - cx, o[1] + d[1] * tc - cy, o[2] + d[2] * tc - cz], dist2 = Math.hypot(...q);
      const half = Math.hypot(part.max[0] - part.min[0], part.max[1] - part.min[1], part.max[2] - part.min[2]) / 2;
      if (dist2 < half + 0.8) p = (kind === 'ke' ? 0.3 : 0.22) * (W.pen > 100 ? 1 : 0.5);
    }
    if (p && Math.random() < p) res.effects.push(part.name);
  }
  res.residual = residual;
  return res;
}
