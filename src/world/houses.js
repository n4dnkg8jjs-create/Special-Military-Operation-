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
// v7: the real windows of the house templates (city.glb house_a..e; tools: previews/infantry_v7/scen/house_windows.py): glass panes
// recessed 0.1 m in 0.4 m walls, sills 1.35 m up. [side, outer wall plane, pane plane, u0, u1, y0, y1] in the template's own
// frame (u = x on front / back, z on right / left). The garrison takes these windows (before: a slot every 3.3 m of wall, mostly
// behind solid wall, so nobody was ever seen); a garrisoned house is drawn from a copy of its template without those panes.
const WINDOWS = {"house_a":[["front",3.4,3.3,-2.675,-1.525,1.35,2.7],["front",3.4,3.3,-0.575,0.575,1.35,2.7],["front",3.4,3.3,1.525,2.675,1.35,2.7],["back",-3.4,-3.3,-1.975,-0.825,1.35,2.7],["back",-3.4,-3.3,0.825,1.975,1.35,2.7],["right",4.2,4.1,-0.575,0.575,1.35,2.7],["left",-4.2,-4.1,-0.575,0.575,1.35,2.7]],"house_b":[["front",3.6,3.5,-2.825,-1.675,1.35,2.7],["front",3.6,3.5,-0.575,0.575,1.35,2.7],["front",3.6,3.5,1.675,2.825,1.35,2.7],["back",-3.6,-3.5,-2.075,-0.925,1.35,2.7],["back",-3.6,-3.5,0.925,2.075,1.35,2.7],["right",4.5,4.4,-1.642,-0.492,1.35,2.7],["right",4.5,4.4,0.492,1.642,1.35,2.7],["left",-4.5,-4.4,-0.575,0.575,1.35,2.7]],"house_d":[["front",4.6,4.5,-1.742,-0.592,1.35,2.7],["front",4.6,4.5,0.592,1.742,1.35,2.7],["back",-4.6,-4.5,-1.742,-0.592,1.35,2.7],["back",-4.6,-4.5,0.592,1.742,1.35,2.7],["right",3.5,3.4,-1.975,-0.825,1.35,2.7],["right",3.5,3.4,0.825,1.975,1.35,2.7],["left",-3.5,-3.4,-0.575,0.575,1.35,2.7]],"house_e":[["front",3.5,3.4,-2.475,-1.325,1.35,2.7],["front",3.5,3.4,-0.575,0.575,1.35,2.7],["front",3.5,3.4,1.325,2.475,1.35,2.7],["back",-3.5,-3.4,-1.842,-0.692,1.35,2.7],["back",-3.5,-3.4,0.692,1.842,1.35,2.7],["right",3.8,3.7,-0.575,0.575,1.35,2.7],["left",-3.8,-3.7,-0.575,0.575,1.35,2.7]]};
const SIDE_ROT = { front: 0, back: Math.PI, right: Math.PI / 2, left: -Math.PI / 2 };
// the template geometry without the window panes (shared by every garrisoned house of that template)
const OPEN_GEO = new Map();
function openGeometry(tpl, name) {
  if (OPEN_GEO.has(tpl)) return OPEN_GEO.get(tpl);
  const W = WINDOWS[name] || [], g0 = tpl.geometry; let g = null;
  if (g0 && W.length) {
    const pos = g0.attributes.position, idx = g0.index, n = idx ? idx.count : pos.count, keep = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    for (let t = 0; t < n; t += 3) {
      const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
      a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
      const nr = e1.subVectors(b, a).cross(e2.subVectors(c, a)).normalize(), cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3;
      const pane = W.some(([side, , pl, u0, u1, y0, y1]) => {
        const zax = side === 'front' || side === 'back', sg = side === 'front' || side === 'right' ? 1 : -1;
        const nv = zax ? nr.z : nr.x, w = zax ? cz : cx, u = zax ? cx : cz;
        return nv * sg > 0.9 && Math.abs(w - pl) < 0.05 && u > u0 - 0.02 && u < u1 + 0.02 && cy > y0 - 0.02 && cy < y1 + 0.02;
      });
      if (!pane) keep.push(i0, i1, i2);
    }
    if (keep.length < n) { g = g0.clone(); g.setIndex(keep); }
  }
  OPEN_GEO.set(tpl, g); return g;
}

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
  // v7: slots at the template's real windows (WINDOWS): bc = the template's bbox centre (its frame), sc = the placement's scale
  realWindows(W, bc, sc) {
    if (!W?.length) return;
    this.panels = []; this.slots = [];
    W.forEach(([side, outer, , u0, u1, y0, y1], i) => {
      const zax = side === 'front' || side === 'back', u = (u0 + u1) / 2;
      const lx = zax ? (u - bc.x) * sc.x : (outer - bc.x) * sc.x, lz = zax ? (outer - bc.z) * sc.z : (u - bc.z) * sc.z;
      const p = { b: this, side, col: i, floor: 0, state: 0, gone: false, rot: SIDE_ROT[side], lx, lz, cy: (y0 + y1) / 2 * sc.y, sill: y0 * sc.y, type: 'house_window', hp: 100, slot: -1, real: true };
      this.panels.push(p); this.slots.push({ panel: p, occupant: null });
    });
    this.garrisonCap = this.slots.length; this.realWin = true;
  }
  // first man at a window: this house is drawn from the pane-less copy of its template (the instance is hidden in the instancer's
  // InstancedMesh, a plain mesh with the open geometry takes its place)
  openWindow(p) {
    if (p) p.open = true;
    if (this.opened || !this.tpl || !this.M) return; this.opened = true;
    const src = this.tpl.isMesh ? this.tpl : this.tpl.getObjectByProperty?.('isMesh', true), scene = this.game?.scene; if (!src || !scene) return;
    const g = openGeometry(src, this.name); if (!g) return;
    this.tpl.updateMatrixWorld(true);
    const rel = new THREE.Matrix4().copy(this.tpl.matrixWorld).invert().multiply(src.matrixWorld), MM = new THREE.Matrix4().multiplyMatrices(this.M, rel);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0), m = new THREE.Matrix4(), t = new THREE.Vector3(), t0 = new THREE.Vector3().setFromMatrixPosition(MM);
    scene.traverse(o => {
      if (!o.isInstancedMesh || (o.geometry !== src.geometry && o.name !== src.name)) return;   // (its LOD copies too: the open mesh is drawn at every range)
      for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); t.setFromMatrixPosition(m); if (t.distanceToSquared(t0) < 0.01) { o.setMatrixAt(i, zero); o.instanceMatrix.needsUpdate = true; } }
    });
    const mesh = new THREE.Mesh(g, src.material); mesh.matrixAutoUpdate = false; mesh.matrix.copy(MM); mesh.matrixWorldNeedsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = this.name + '_open'; scene.add(mesh); this.openMesh = mesh;
  }
  toWorld(lx, ly, lz, out = new THREE.Vector3()) { return out.set(this.x + lx * this.cos + lz * this.sin, ly, this.z - lx * this.sin + lz * this.cos); }
  toLocal(wx, wz) { const dx = wx - this.x, dz = wz - this.z; return [dx * this.cos - dz * this.sin, dx * this.sin + dz * this.cos]; }
  contains(wx, wz, pad = 0) { const [lx, lz] = this.toLocal(wx, wz); return Math.abs(lx) < this.L / 2 + pad && Math.abs(lz) < this.D / 2 + pad; }
  panelCenter(p, out = new THREE.Vector3()) { return this.toWorld(p.lx, this.y0 + (p.cy ?? 1.4), p.lz, out); }
  outward(p) { const a = this.rot + p.rot; return new THREE.Vector3(Math.sin(a), 0, Math.cos(a)); }
  slotPos(slot, out = new THREE.Vector3()) { const p = slot.panel; this.panelCenter(p, out); const o = this.outward(p); out.addScaledVector(o, -0.6); out.y = this.floorY(); return out; }
  // floor height inside (one storey)
  floorY() { return this.y0 + (this.floorH ?? 0.05); }   // v7: the templates' raised floor (0.45 m plinth: men stood in it, legs in the slab)
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
      hs.tpl = P.template; hs.M = M; hs.game = game; if (WINDOWS[name]) { hs.floorH = 0.45 * sc.y + 0.02; hs.cellar.hatch.y = hs.floorY(); for (const d of hs.doors) d.in.y = hs.floorY(); } hs.realWindows(WINDOWS[name], new THREE.Vector3((bb.min.x + bb.max.x) / 2, 0, (bb.min.z + bb.max.z) / 2), sc);   // v7
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
