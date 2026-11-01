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
