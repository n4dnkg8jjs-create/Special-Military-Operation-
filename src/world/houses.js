// Private houses (приватний сектор: village / suburban single-storey houses, house_* templates on every map) made
// enterable. Each placed, standing house becomes a House with the duck-typed interface the panel-block Building
// offers to the garrison / storm / combat code: slots at its windows (all four walls), its entrance (the template's real
// door, PLAN below), panelCenter / outward / slotPos / toLocal / toWorld, plus the room (clampIn / interior / entryRoute /
// exitRoute) for the men walking in and out (game/cqb.js). Derived from the instancer's placements after the world is
// built, so no map builder needs to know about it (farmland.js, city.js and real.js are untouched).
// Every house has a cellar (погріб) under the floor, reached by a hatch: a squad inside can go down (no firing, nothing
// to see, but shells and drones barely touch it) and come back up to fight. A squad clearing the house has to deal
// with it: grenade down the hatch, then whoever is still alive down there (game/cqb.js).
import * as THREE from 'three';
import { PLACED } from './instancer.js';

const HOUSE = /^house_/i, NOT = /burnt|ruin|rubble|destroy|_lod\d*$|_mid$|shell|wreck/i;
const WIN = 3.3;   // a window every ~3.3 m of wall
// The real layout of the house templates (city.glb house_a..e; tool: previews/house_interior/scen/house_plan.py, ray casts through
// every wall of the mesh): one room inside 0.4 m walls (no interior walls), a 0.45 m floor plinth, ONE door - in the left gable
// wall, behind 2-step porch stairs (the doors this file used to assume, middle of the front and back walls, were solid wall or a
// window: men walked through the brickwork) - and the real windows (sills 0.93 m over the floor; v7: before, a slot every 3.3 m of
// wall). house_c (the abandoned one) has empty window holes and rubble heaped on its floor; house_d a shell hole in its right
// wall. Template frame: front = +z, right = +x. f floor, w {side: [outer face, inner face]}, d doors [side, u0, u1, top, leaf plane |
// null, porch edge], win [side, outer, pane plane | null (no glass), u0, u1, sill, top] (u = x on front / back, z on right /
// left), rub rubble cells (0.25 m) [i, k, height over the floor].
const PLAN = {"house_a":{"f":0.45,"w":{"front":[3.4,3.0],"back":[-3.4,-3.0],"right":[4.2,3.8],"left":[-4.2,-3.8]},"d":[["left",-2.4,-1.5,2.5,-4.06,-5.4]],"win":[["front",3.4,3.3,-2.675,-1.525,1.38,2.68],["front",3.4,3.3,-0.575,0.575,1.38,2.68],["front",3.4,3.3,1.525,2.675,1.38,2.68],["back",-3.4,-3.3,-1.975,-0.825,1.38,2.68],["back",-3.4,-3.3,0.825,1.975,1.38,2.68],["right",4.2,4.1,-0.575,0.575,1.38,2.68],["left",-4.2,-4.1,-0.575,0.575,1.38,2.68]]},"house_b":{"f":0.45,"w":{"front":[3.6,3.2],"back":[-3.6,-3.2],"right":[4.5,4.1],"left":[-4.5,-4.1]},"d":[["left",-2.6,-1.7,2.5,-4.36,-5.7]],"win":[["front",3.6,3.5,-2.825,-1.675,1.38,2.68],["front",3.6,3.5,-0.575,0.575,1.38,2.68],["front",3.6,3.5,1.675,2.825,1.38,2.68],["back",-3.6,-3.5,-2.075,-0.925,1.38,2.68],["back",-3.6,-3.5,0.925,2.075,1.38,2.68],["right",4.5,4.4,-1.65,-0.5,1.38,2.68],["right",4.5,4.4,0.5,1.65,1.38,2.68],["left",-4.5,-4.4,-0.575,0.575,1.38,2.68]]},"house_c":{"f":0.45,"w":{"front":[3.5,3.1],"back":[-3.5,-3.1],"right":[4.0,3.6],"left":[-4.0,-3.6]},"d":[["left",-2.5,-1.6,2.5,null,-5.2]],"win":[["front",3.5,null,-2.575,-1.425,1.38,2.68],["front",3.5,null,-0.575,0.575,1.38,2.68],["front",3.5,null,1.425,2.575,1.38,2.68],["back",-3.5,null,-1.9,-0.75,1.38,2.68],["back",-3.5,null,0.75,1.9,1.38,2.68],["right",4.0,null,-0.575,0.575,1.38,2.68],["left",-4.0,null,-0.575,0.575,1.38,2.68]],"rub":[[-13,-3,0.25],[-13,-2,0.25],[-13,-1,0.25],[-12,-3,0.25],[-12,-2,0.25],[-12,-1,0.25],[-12,2,0.29],[-12,3,0.29],[-12,4,0.29],[-11,-3,0.25],[-11,-2,0.25],[-11,-1,0.25],[-11,2,0.29],[-11,3,0.29],[-11,4,0.29],[-10,-3,0.25],[-10,-2,0.25],[-10,-1,0.25],[-10,2,0.29],[-10,3,0.29],[-10,4,0.29],[-9,0,0.23],[-9,1,0.23],[-9,2,0.29],[-9,3,0.29],[-9,4,0.29],[-8,0,0.23],[-8,1,0.23],[-8,2,0.29],[-8,3,0.37],[-8,4,0.37],[-8,5,0.37],[-8,6,0.37],[-7,-1,0.23],[-7,0,0.23],[-7,1,0.23],[-7,2,0.3],[-7,3,0.39],[-7,4,0.39],[-7,5,0.39],[-7,6,0.39],[-6,-1,0.23],[-6,0,0.23],[-6,1,0.3],[-6,2,0.3],[-6,3,0.39],[-6,4,0.39],[-6,5,0.39],[-6,6,0.39],[-6,8,0.26],[-6,9,0.26],[-6,10,0.26],[-5,-1,0.23],[-5,0,0.23],[-5,1,0.32],[-5,2,0.32],[-5,3,0.39],[-5,4,0.39],[-5,5,0.39],[-5,6,0.39],[-5,7,0.38],[-5,8,0.26],[-5,9,0.26],[-5,10,0.26],[-4,-1,0.23],[-4,0,0.23],[-4,1,0.33],[-4,2,0.33],[-4,3,0.33],[-4,4,0.38],[-4,5,0.38],[-4,6,0.38],[-4,7,0.38],[-4,8,0.26],[-4,9,0.26],[-4,10,0.26],[-3,-6,0.58],[-3,-5,0.58],[-3,-4,0.58],[-3,-3,0.58],[-3,-1,0.09],[-3,0,0.09],[-3,1,0.33],[-3,2,0.33],[-3,3,0.33],[-3,4,0.38],[-3,5,0.38],[-3,6,0.38],[-3,7,0.38],[-2,-6,0.58],[-2,-5,0.58],[-2,-4,0.58],[-2,-3,0.58],[-2,-1,0.09],[-2,0,0.09],[-2,1,0.33],[-2,2,0.33],[-2,3,0.33],[-1,-10,0.34],[-1,-9,0.34],[-1,-8,0.34],[-1,-7,0.34],[-1,-6,0.58],[-1,-5,0.58],[-1,-4,0.58],[-1,-3,0.58],[-1,-2,0.27],[-1,-1,0.09],[-1,0,0.09],[-1,1,0.33],[-1,2,0.33],[-1,3,0.33],[-1,7,0.35],[-1,8,0.35],[-1,9,0.35],[-1,10,0.28],[0,-10,0.34],[0,-9,0.34],[0,-8,0.34],[0,-7,0.34],[0,-6,0.28],[0,-5,0.58],[0,-4,0.58],[0,-3,0.58],[0,-2,0.45],[0,-1,0.45],[0,0,0.45],[0,7,0.35],[0,8,0.35],[0,9,0.35],[0,10,0.28],[1,-10,0.34],[1,-9,0.45],[1,-8,0.45],[1,-7,0.45],[1,-6,0.45],[1,-5,0.28],[1,-4,0.28],[1,-3,0.29],[1,-2,0.45],[1,-1,0.45],[1,0,0.45],[1,1,0.45],[1,2,0.45],[1,7,0.35],[1,8,0.35],[1,9,0.35],[1,10,0.28],[2,-10,0.34],[2,-9,0.45],[2,-8,0.45],[2,-7,0.45],[2,-6,0.45],[2,-5,0.28],[2,-4,0.28],[2,-3,0.29],[2,-2,0.45],[2,-1,0.45],[2,0,0.45],[2,1,0.45],[2,2,0.45],[2,3,0.33],[3,-9,0.45],[3,-8,0.45],[3,-7,0.45],[3,-6,0.45],[3,-5,0.28],[3,-4,0.33],[3,-3,0.33],[3,-2,0.45],[3,-1,0.45],[3,0,0.45],[3,1,0.45],[3,2,0.45],[3,3,0.33],[4,-9,0.45],[4,-8,0.45],[4,-7,0.45],[4,-6,0.45],[4,-5,0.18],[4,-4,0.33],[4,-3,0.33],[4,-2,0.37],[4,-1,0.37],[4,0,0.37],[4,1,0.37],[4,2,0.33],[4,3,0.33],[5,-4,0.33],[5,-3,0.33],[5,-2,0.37],[5,-1,0.37],[5,0,0.37],[5,1,0.37],[5,2,0.33],[5,3,0.33],[6,-2,0.37],[6,-1,0.37],[6,0,0.37],[6,1,0.37],[8,-6,0.31],[8,-5,0.31],[8,-4,0.31],[8,-3,0.3],[9,-6,0.31],[9,-5,0.31],[9,-4,0.31],[9,-3,0.3],[10,-6,0.31],[10,-5,0.31],[10,-4,0.31],[10,-3,0.3],[11,-6,0.31],[11,-5,0.31],[11,-4,0.31],[11,-3,0.3]]},"house_d":{"f":0.45,"w":{"front":[4.6,4.2],"back":[-4.6,-4.2],"right":[3.5,3.1],"left":[-3.5,-3.1]},"d":[["left",-3.6,-2.7,2.5,-3.36,-4.7]],"win":[["front",4.6,4.5,-1.75,-0.6,1.38,2.68],["front",4.6,4.5,0.6,1.75,1.38,2.68],["back",-4.6,-4.5,-1.75,-0.6,1.38,2.68],["back",-4.6,-4.5,0.6,1.75,1.38,2.68],["right",3.5,null,-3.05,-2.1,0.93,2.53],["right",3.5,3.4,-1.975,-0.825,1.38,2.68],["right",3.5,3.4,0.825,1.975,1.38,2.68],["left",-3.5,-3.4,-0.575,0.575,1.38,2.68]]},"house_e":{"f":0.45,"w":{"front":[3.5,3.1],"back":[-3.5,-3.1],"right":[3.8,3.4],"left":[-3.8,-3.4]},"d":[["left",-2.5,-1.6,2.5,-3.66,-5.0]],"win":[["front",3.5,3.4,-2.475,-1.325,1.38,2.68],["front",3.5,3.4,-0.575,0.575,1.38,2.68],["front",3.5,3.4,1.325,2.475,1.38,2.68],["back",-3.5,-3.4,-1.85,-0.7,1.38,2.68],["back",-3.5,-3.4,0.7,1.85,1.38,2.68],["right",3.8,3.7,-0.575,0.575,1.38,2.68],["left",-3.8,-3.7,-0.575,0.575,1.38,2.68]]}};
const BODY = 0.42;   // a man stands this far in from the inner face of a wall (body radius + a little)
const SIDE_ROT = { front: 0, back: Math.PI, right: Math.PI / 2, left: -Math.PI / 2 };
// the template geometry without the window panes (shared by every garrisoned house of that template)
const OPEN_GEO = new Map();
function openGeometry(tpl, name) {
  if (OPEN_GEO.has(tpl)) return OPEN_GEO.get(tpl);
  const P = PLAN[name], W = (P?.win || []).filter(w => w[2] != null), Dr = (P?.d || []).filter(d => d[4] != null), g0 = tpl.geometry; let g = null;
  if (g0 && (W.length || Dr.length)) {
    const pos = g0.attributes.position, idx = g0.index, n = idx ? idx.count : pos.count, keep = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    const ax = side => side === 'front' || side === 'back';
    for (let t = 0; t < n; t += 3) {
      const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
      a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
      const nr = e1.subVectors(b, a).cross(e2.subVectors(c, a)).normalize(), cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3;
      const pane = W.some(([side, , pl, u0, u1, y0, y1]) => {
        const zax = ax(side), sg = side === 'front' || side === 'right' ? 1 : -1;
        const nv = zax ? nr.z : nr.x, w = zax ? cz : cx, u = zax ? cx : cz;
        return nv * sg > 0.9 && Math.abs(w - pl) < 0.05 && u > u0 - 0.02 && u < u1 + 0.02 && cy > y0 - 0.05 && cy < y1 + 0.02;
      });
      // the door leaf (and its handle): flat in the doorway, a little behind the outer face -> the door stands open
      const leaf = !pane && Dr.some(([side, u0, u1, top, pl]) => {
        const zax = ax(side), k = zax ? 'z' : 'x', uk = zax ? 'x' : 'z';
        return [a, b, c].every(v => Math.abs(v[k] - pl) < 0.07 && v[uk] > u0 - 0.01 && v[uk] < u1 + 0.01 && v.y > P.f - 0.02 && v.y < top + 0.02);
      });
      if (!pane && !leaf) keep.push(i0, i1, i2);
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
  // the template's real layout (PLAN): slots at its real windows, standing spots inside the room clear of the walls, the real
  // door with its porch steps, the interior (for routes, rubble heights), the cellar hatch on clear floor. bc = the template's bbox
  // centre (its frame), sc = the placement's scale
  applyPlan(P, bc, sc) {
    if (!P) return;
    const tl = (tx, tz) => [(tx - bc.x) * sc.x, (tz - bc.z) * sc.z], zax = side => side === 'front' || side === 'back', sgn = side => (side === 'front' || side === 'right' ? 1 : -1);
    const at = (side, w, u) => (zax(side) ? tl(u, w) : tl(w, u));   // wall coordinate w, along-wall u -> local
    this.P = P; this.bc = bc; this.sc = sc; this.floorH = P.f * sc.y + 0.02;
    const [x0, z0] = tl(P.w.left[1], P.w.back[1]), [x1, z1] = tl(P.w.right[1], P.w.front[1]);
    this.inner = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) };
    this.rub = P.rub ? new Map(P.rub.map(([i, k, h]) => [i * 4096 + k, h * sc.y])) : null;
    // windows: the slot (and the panel, for the line of fire) at the window; the man stands BODY in from the inner face
    this.panels = []; this.slots = [];
    P.win.forEach(([side, outer, , u0, u1, y0, y1], i) => {
      const u = (u0 + u1) / 2, sg = sgn(side), inner = P.w[side][1], [lx, lz] = at(side, outer, u);
      const [sx, sz] = this.clampLocal(...at(side, inner - sg * BODY / Math.abs(zax(side) ? sc.z : sc.x), u));
      const p = { b: this, side, col: i, floor: 0, state: 0, gone: false, rot: SIDE_ROT[side], lx, lz, sx, sz, cy: (y0 + y1) / 2 * sc.y, sill: y0 * sc.y, sillH: (y0 - P.f) * sc.y, type: 'house_window', hp: 100, slot: -1, real: true };
      this.panels.push(p); this.slots.push({ panel: p, occupant: null });
    });
    this.garrisonCap = this.slots.length; this.realWin = true;
    // the door: out (on the ground, past the porch steps) -> foot of the steps -> threshold -> in (inside the room)
    const fy = this.floorY(), y0 = this.y0;
    this.doors = P.d.map(([side, u0, u1, top, leaf, porch]) => {
      const u = (u0 + u1) / 2, sg = sgn(side), [ox, oz] = at(side, P.w[side][0], u), [nx, nz] = at(side, P.w[side][0] + sg, u), nrm = this.toWorld(nx, 0, nz).sub(this.toWorld(ox, 0, oz));
      const W = (w, y) => { const [lx, lz] = at(side, w, u); return this.toWorld(lx, y, lz); };
      return { side, lx: ox, lz: oz, out: W(porch + sg * 0.9, y0), foot: W(porch + sg * 0.1, y0), thr: W(P.w[side][0], fy), in: W(P.w[side][1] - sg * 0.55, fy), dir: nrm.setY(0).normalize(), tan: new THREE.Vector3(nrm.z, 0, -nrm.x).normalize(), width: (u1 - u0) * (zax(side) ? sc.x : sc.z) };
    });
    this.entrances = this.doors.map(d => d.out);
    // the cellar hatch: clear floor (no rubble), away from the doorway and the window spots, nearest the middle of the room
    const I = this.inner, cx = (I.x0 + I.x1) / 2, cz = (I.z0 + I.z1) / 2; let best = null, bs = 1e9;
    for (let x = I.x0 + 1; x <= I.x1 - 1; x += 0.25) for (let z = I.z0 + 1; z <= I.z1 - 1; z += 0.25) {
      let r = 0; for (const dx of [-0.5, 0, 0.5]) for (const dz of [-0.5, 0, 0.5]) r = Math.max(r, this.rubAt(x + dx, z + dz));
      if (r > 0.02) continue;
      const w = this.toWorld(x, fy, z); if (this.doors.some(d => d.in.distanceTo(w) < 1.6) || this.panels.some(p => Math.hypot(p.sx - x, p.sz - z) < 1.0)) continue;
      const sc2 = Math.hypot(x - cx, z - cz); if (sc2 < bs) { bs = sc2; best = w; }
    }
    this.cellar.hatch = best || this.toWorld(cx, fy, cz);
  }
  // the room, shrunk by a body radius: a local point clamped into it
  clampLocal(lx, lz, pad = BODY) { const I = this.inner; return I ? [Math.max(I.x0 + pad, Math.min(I.x1 - pad, lx)), Math.max(I.z0 + pad, Math.min(I.z1 - pad, lz))] : [lx, lz]; }
  // rubble height (local point) over the floor
  rubAt(lx, lz) { if (!this.rub) return 0; const tx = lx / this.sc.x + this.bc.x, tz = lz / this.sc.z + this.bc.z; return this.rub.get(Math.floor(tx / 0.25) * 4096 + Math.floor(tz / 0.25)) || 0; }
  floorAt(wx, wz) { const [lx, lz] = this.toLocal(wx, wz); return this.floorY() + this.rubAt(lx, lz); }
  // a world point moved into the room (clear of the walls), on the floor / the rubble
  clampIn(v, pad = BODY) { if (!this.inner) return v; const [lx, lz] = this.clampLocal(...this.toLocal(v.x, v.z), pad); this.toWorld(lx, 0, lz, v); v.y = this.floorY() + this.rubAt(lx, lz); return v; }
  // points strictly between a and b inside the room ([x, y, z]): the room is one convex box, so straight is clear of the walls;
  // over rubble the line is sampled so the man climbs it
  interior(a, b) {
    if (!this.rub) return [];
    const n = Math.floor(Math.hypot(b.x - a.x, b.z - a.z) / 0.35), out = [];
    for (let k = 1; k < n; k++) { const x = a.x + (b.x - a.x) * k / n, z = a.z + (b.z - a.z) * k / n; out.push([x, this.floorAt(x, z), z]); }
    return out;
  }
  inRoom(wx, wz, pad = 0) { const I = this.inner; if (!I) return this.contains(wx, wz); const [lx, lz] = this.toLocal(wx, wz); return lx > I.x0 + pad && lx < I.x1 - pad && lz > I.z0 + pad && lz < I.z1 - pad; }
  // a man somewhere on the way in (outside, on the steps, in the doorway): the rest of the way to the door's inside point
  toDoorIn(p, d = this.doorNear(p)) {
    if (this.inRoom(p.x, p.z)) return [];
    const P = [d.out, d.foot, d.thr, d.in], rest = [0, 0, 0, 0];
    for (let k = 2; k >= 0; k--) rest[k] = rest[k + 1] + P[k].distanceTo(P[k + 1]);
    const me = p.distanceTo(d.in); return P.filter((q, k) => rest[k] < me - 0.05).map(q => [q.x, q.y, q.z]);
  }
  doorNear(p) { return this.doors.reduce((a, d) => (d.out.distanceToSquared(p) < a.out.distanceToSquared(p) ? d : a)); }
  // points from outside (at door.out) to `to` inside, and back out
  entryRoute(d, to) { return [[d.out.x, d.out.y, d.out.z], [d.foot.x, d.foot.y, d.foot.z], [d.thr.x, d.thr.y, d.thr.z], [d.in.x, d.in.y, d.in.z], ...this.interior(d.in, to), [to.x, to.y, to.z]]; }
  exitRoute(from, d) { return this.entryRoute(d, from).reverse(); }
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
  slotPos(slot, out = new THREE.Vector3()) {
    const p = slot.panel;
    if (p.sx != null) { this.toWorld(p.sx, 0, p.sz, out); out.y = this.floorY() + this.rubAt(p.sx, p.sz); return out; }   // (PLAN: inside the room)
    this.panelCenter(p, out); const o = this.outward(p); out.addScaledVector(o, -0.6); out.y = this.floorY(); return out;
  }
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
      hs.tpl = P.template; hs.M = M; hs.game = game; hs.applyPlan(PLAN[name], new THREE.Vector3((bb.min.x + bb.max.x) / 2, 0, (bb.min.z + bb.max.z) / 2), sc.clone());
      // its line-of-sight occluder (put by the map builder) gets the house as its ref, so the garrison's own walls can be
      // ignored where the building's are (spotting); none there: add one
      let occ = null;
      const k = Math.floor(hs.x / nav.occCell) * 4096 + Math.floor(hs.z / nav.occCell);
      for (const o of nav.occGrid.get(k) || []) if (!o.foliage && !o.ref && Math.hypot(o.cx - hs.x, o.cz - hs.z) < 2.5 && Math.max(o.hx, o.hz) < 16) { occ = o; break; }
      if (!occ) occ = nav.addOccluder(hs.x, hs.z, L / 2 * 0.95, D / 2 * 0.95, rot, Math.max(2.6, h * 0.9) + v.y, null);
      occ.ref = hs; hs.occ = occ;
      // doors: step outside onto free ground (the porch is part of the house's nav footprint)
      for (const d of hs.doors) { const [fx, fz] = nav.nearestFree(d.out.x, d.out.z, 0.4, 5); d.out.set(fx, game.city.groundHeight ? game.city.groundHeight(fx, fz) : d.out.y, fz); }
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
