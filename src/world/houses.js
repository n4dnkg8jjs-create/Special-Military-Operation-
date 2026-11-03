// Private houses (приватний сектор: village / suburban single-storey houses, house_* templates on every map) made
// enterable. Each placed, standing house becomes a House with the duck-typed interface the panel-block Building
// offers to the garrison / storm / combat code: slots at its windows (all four walls), entrances (doors front and
// back), panelCenter / outward / slotPos / toLocal / toWorld. Derived from the instancer's placements after the world is
// built, so no map builder needs to know about it (farmland.js, city.js and real.js are untouched).
// Every house has a cellar (погріб) under the floor, reached by a hatch: a squad inside can go down (no firing, nothing
// to see, but shells and drones barely touch it) and come back up to fight. A squad clearing the house has to deal
// with it: grenade down the hatch, then whoever is still alive down there (game/cqb.js).
import * as THREE from 'three';
import { PLACED } from './instancer.js';

const HOUSE = /^house_/i, NOT = /burnt|ruin|rubble|destroy|_lod\d*$|_mid$|shell|wreck/i;
const WIN = 3.3;   // a window every ~3.3 m of wall

export class House {
  constructor(x, z, rot, L, D, h, y0, name) {
    Object.assign(this, { x, z, rot, L, D, height: h, y0, name });
    this.house = true; this.kind = 'house'; this.floors = 1; this.sections = 1; this.kit = { W: WIN, H: 2.8 };
    this.cos = Math.cos(rot); this.sin = Math.sin(rot);
    this.panels = []; this.slots = []; this.occupants = new Set(); this.goneCols = new Set(); this.collapsedSecs = new Set();
    const facades = [['front', 0, L, (u) => [u, D / 2]], ['back', Math.PI, L, (u) => [-u, -D / 2]], ['right', Math.PI / 2, D, (u) => [L / 2, -u]], ['left', -Math.PI / 2, D, (u) => [-L / 2, u]]];
    for (const [side, prot, len, at] of facades) {
      const n = Math.max(1, Math.floor(len / WIN));
      for (let i = 0; i < n; i++) {
        const u = -len / 2 + (i + 0.5) * len / n, [lx, lz] = at(u);
        const p = { b: this, side, col: i, floor: 0, state: 0, gone: false, rot: prot, lx, lz, type: 'house_window', hp: 100, slot: -1 };
        this.panels.push(p); this.slots.push({ panel: p, occupant: null });
      }
    }
    this.garrisonCap = this.slots.length;
    // doors: middle of the front and back walls, a step outside
    this.doors = [[0, D / 2], [0, -D / 2]].map(([lx, lz]) => ({ lx, lz, out: this.toWorld(lx, y0, lz + Math.sign(lz) * 1.8), in: this.toWorld(lx, y0, lz - Math.sign(lz) * 1.1) }));
    this.entrances = this.doors.map(d => d.out);
    // the cellar hatch: inside, a little behind the middle
    this.cellar = { hatch: this.toWorld(L * 0.18, y0, -D * 0.12), y: y0 - 2.3 };
    this.hp = 260;
  }
  toWorld(lx, ly, lz, out = new THREE.Vector3()) { return out.set(this.x + lx * this.cos + lz * this.sin, ly, this.z - lx * this.sin + lz * this.cos); }
  toLocal(wx, wz) { const dx = wx - this.x, dz = wz - this.z; return [dx * this.cos - dz * this.sin, dx * this.sin + dz * this.cos]; }
  contains(wx, wz, pad = 0) { const [lx, lz] = this.toLocal(wx, wz); return Math.abs(lx) < this.L / 2 + pad && Math.abs(lz) < this.D / 2 + pad; }
  panelCenter(p, out = new THREE.Vector3()) { return this.toWorld(p.lx, this.y0 + 1.4, p.lz, out); }
  outward(p) { const a = this.rot + p.rot; return new THREE.Vector3(Math.sin(a), 0, Math.cos(a)); }
  slotPos(slot, out = new THREE.Vector3()) { const p = slot.panel; this.panelCenter(p, out); const o = this.outward(p); out.addScaledVector(o, -0.6); out.y = this.y0 + 0.05; return out; }
  // floor height inside (one storey)
  floorY() { return this.y0 + 0.05; }
  // shells / rockets on the house: the walls take it (no panel-by-panel model for a cottage); a man at the window
  // nearest the burst may be hurt by game code (combat.explode, house branch)
  damageAt(wx, wy, wz, power) { this.hp -= power; return []; }
  checkCollapse() { return []; }
  isDestroyedTop() { return false; }
}

// bounding box of a template in its own frame (the frame the instancer's matrices place)
function localBox(tpl) {
  if (tpl.userData.houseBB) return tpl.userData.houseBB;
  tpl.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(tpl.matrixWorld).invert(), m = new THREE.Matrix4(), box = new THREE.Box3(), b = new THREE.Box3();
  tpl.traverse(o => { if (!o.isMesh || /_LOD1$/i.test(o.name)) return; if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); b.copy(o.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld)); box.union(b); });
  return (tpl.userData.houseBB = box);
}

export function buildHouses(game) {
  const nav = game.nav, list = [], v = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), c = new THREE.Vector3();
  for (const P of PLACED) {
    const name = P.template?.name || ''; if (!HOUSE.test(name) || NOT.test(name)) continue;
    const bb = localBox(P.template); if (bb.isEmpty()) continue;
    for (const M of P.matrices) {
      M.decompose(v, q, sc);
      const rot = Math.atan2(M.elements[8], M.elements[10]);
      const L = (bb.max.x - bb.min.x) * sc.x, D = (bb.max.z - bb.min.z) * sc.z, h = (bb.max.y - bb.min.y) * sc.y;
      if (L < 4 || D < 4 || L > 26 || D > 26) continue;
      c.set((bb.min.x + bb.max.x) / 2, 0, (bb.min.z + bb.max.z) / 2).multiply(sc).applyQuaternion(q);
      const hs = new House(v.x + c.x, v.z + c.z, rot, L, D, h, v.y, name);
      // its line-of-sight occluder (put by the map builder) gets the house as its ref, so the garrison's own walls can be
      // ignored where the building's are (spotting); none there: add one
      let occ = null;
      const k = Math.floor(hs.x / nav.occCell) * 4096 + Math.floor(hs.z / nav.occCell);
      for (const o of nav.occGrid.get(k) || []) if (!o.foliage && !o.ref && Math.hypot(o.cx - hs.x, o.cz - hs.z) < 2.5 && Math.max(o.hx, o.hz) < 16) { occ = o; break; }
      if (!occ) occ = nav.addOccluder(hs.x, hs.z, L / 2 * 0.95, D / 2 * 0.95, rot, Math.max(2.6, h * 0.9) + v.y, null);
      occ.ref = hs; hs.occ = occ;
      // doors: step outside onto free ground
      for (const d of hs.doors) { const [fx, fz] = nav.nearestFree(d.out.x, d.out.z, 0.4, 5); d.out.set(fx, d.out.y, fz); }
      list.push(hs);
    }
  }
  // spatial lookup
  const grid = new Map(), C = 30;
  for (const h of list) { const kk = Math.floor(h.x / C) * 4096 + Math.floor(h.z / C); (grid.get(kk) || grid.set(kk, []).get(kk)).push(h); }
  const at = (x, z, pad = 0) => { const i0 = Math.floor(x / C), j0 = Math.floor(z / C); for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const h of grid.get(i * 4096 + j) || []) if (h.contains(x, z, pad)) return h; return null; };
  const near = (x, z, r) => { const out = []; const n = Math.ceil(r / C); const i0 = Math.floor(x / C), j0 = Math.floor(z / C); for (let i = i0 - n; i <= i0 + n; i++) for (let j = j0 - n; j <= j0 + n; j++) for (const h of grid.get(i * 4096 + j) || []) if (Math.hypot(h.x - x, h.z - z) < r) out.push(h); return out; };
  return { list, at, near };
}
