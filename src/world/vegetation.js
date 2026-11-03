// Line of sight through vegetation: every leafy tree crown and bush placed by the world builders becomes a foliage
// occluder (nav.occluded): a ray passing through enough leaves (o.depth metres) is blocked, so men can't see or be
// seen through a crown or a thick bush, and rockets burst on them. Tree crowns start above head height (o.y0) so
// you still see under them; bare / shelled / stripped trees are left out. Instances already inside a tree-line belt
// or forest occluder (farmland.js) are skipped.
import * as THREE from 'three';
import { PLACED } from './instancer.js';

const LEAFY = /^(tree_.*_leafy|leafy_summer_.*|bush_.*)$/;
export function vegetationLOS(nav) {
  const box = new THREE.Box3(), v = new THREE.Vector3(), sc = new THREE.Vector3(), q = new THREE.Quaternion();
  const sizes = new Map(); let n = 0;
  const inBelt = (x, z) => { const l = nav.occGrid.get(Math.floor(x / nav.occCell) * 4096 + Math.floor(z / nav.occCell)); if (!l) return false;
    for (const o of l) { if (!o.foliage || o.veg) continue; const dx = x - o.cx, dz = z - o.cz, lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos; if (Math.abs(lx) < o.hx && Math.abs(lz) < o.hz) return true; } return false; };
  for (const P of PLACED) {
    const name = P.template?.name || ''; if (!LEAFY.test(name)) continue;
    let S = sizes.get(P.template);
    if (!S) { box.setFromObject(P.template); S = { r: Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2, h: box.max.y, bush: name.startsWith('bush') }; sizes.set(P.template, S); }
    for (const M of P.matrices) {
      M.decompose(v, q, sc); const s = (sc.x + sc.z) / 2, r = S.r * s * 0.75, h = S.h * sc.y;
      if (r < 0.4 || inBelt(v.x, v.z)) continue;
      const o = nav.addOccluder(v.x, v.z, r, r, 0, h, null);
      o.foliage = true; o.veg = true; o.depth = S.bush ? Math.max(1.6, r * 1.2) : Math.max(2.2, r * 1.3); o.y0 = S.bush ? 0 : h * 0.38;
      n++;
    }
  }
  return n;
}

// Tree trunks stop rounds: every instanced tree (tree_* / leafy_summer_* placements, also bare / shelled / stripped
// trunks) becomes a vertical cylinder (radius measured from the template's mesh at chest height, scaled per instance).
// Leaves, bushes and crops do not stop a bullet (they only hide men: the foliage occluders above). Kept in its own
// grid, queried only by the fire code (combat.js trunkStop): sight lines are not cut by a 30 cm trunk.
const TREE = /^(tree_|leafy_summer_)/, NOT_TRUNK = /fallen|stump|_lod\d*$|_mid$|row$/;
const TC = 8;
export const TRUNKS = { grid: new Map(), n: 0 };
function trunkShape(tpl) {
  tpl.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(tpl.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3(), rs = [];
  let top = 0;
  tpl.traverse(o => {
    if (!o.isMesh || /_LOD1$/i.test(o.name)) return;
    m.multiplyMatrices(inv, o.matrixWorld); const pa = o.geometry.attributes.position, st = Math.max(1, Math.floor(pa.count / 6000));
    for (let i = 0; i < pa.count; i += st) { v.fromBufferAttribute(pa, i).applyMatrix4(m); top = Math.max(top, v.y); if (v.y > 0.5 && v.y < 1.7) rs.push(Math.hypot(v.x, v.z)); }
  });
  rs.sort((a, b) => a - b);
  const r = rs.length ? rs[Math.floor(rs.length * 0.6)] : 0.2;
  return { r: Math.min(0.55, Math.max(0.1, r)), h: top };
}
export function vegetationTrunks() {
  TRUNKS.grid.clear(); TRUNKS.n = 0;
  const shapes = new Map(), v = new THREE.Vector3(), sc = new THREE.Vector3(), q = new THREE.Quaternion();
  for (const P of PLACED) {
    const name = P.template?.name || ''; if (!TREE.test(name) || NOT_TRUNK.test(name)) continue;
    let S = shapes.get(P.template); if (!S) { S = trunkShape(P.template); S.leafy = /leafy/.test(name); shapes.set(P.template, S); }
    for (const M of P.matrices) {
      M.decompose(v, q, sc); const s = (sc.x + sc.z) / 2, r = S.r * s, h = S.h * sc.y * (S.leafy ? 0.6 : 0.85);
      if (h < 1) continue;
      const t = { x: v.x, z: v.z, r, y0: v.y - 0.3, y1: v.y + h };
      const k = Math.floor(v.x / TC) * 4096 + Math.floor(v.z / TC); let l = TRUNKS.grid.get(k); if (!l) TRUNKS.grid.set(k, l = []); l.push(t); TRUNKS.n++;
    }
  }
  return TRUNKS.n;
}
// first trunk the segment a->b passes through (beyond `skip` metres from a): { t, x, y, z, trunk } or null
export function trunkHit(ax, ay, az, bx, by, bz, skip = 0.6) {
  if (!TRUNKS.n) return null;
  const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz); if (L < 0.01) return null;
  // cells along the segment (and their neighbours: a trunk centred next door can still reach over the line)
  const keys = new Set(), n = Math.ceil(L / (TC * 0.5));
  for (let i = 0; i <= n; i++) { const f = i / n, ci = Math.floor((ax + dx * f) / TC), cj = Math.floor((az + dz * f) / TC); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) keys.add((ci + a) * 4096 + cj + b); }
  let best = null, bt = 2;
  for (const k of keys) {
    const l = TRUNKS.grid.get(k); if (!l) continue;
    for (const T of l) {
      // segment vs circle in plan, then the height at the entry point must be on the trunk
      const fx = ax - T.x, fz = az - T.z, a = dx * dx + dz * dz, b = 2 * (fx * dx + fz * dz), c = fx * fx + fz * fz - T.r * T.r, disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a); if (t < 0 || t > 1 || t >= bt || t * L < skip) continue;
      const y = ay + (by - ay) * t; if (y < T.y0 || y > T.y1) continue;
      bt = t; best = { t, x: ax + dx * t, y, z: az + dz * t, trunk: T };
    }
  }
  return best;
}
