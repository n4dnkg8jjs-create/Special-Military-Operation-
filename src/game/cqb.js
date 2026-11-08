// Close-quarters clearing of an occupied building (panel blocks and private houses): the squad stacks at the door, the
// point man frags the doorway, then a file of up to four men goes in and works room by room — up the stairwell for
// the upper floors — fragging each defended room before entering and shooting it out at close range, men visibly
// moving through the floors (the route + file scheme of the trench clearing, trench.js, in 3D). A house's cellar is
// dealt with last: a grenade down the hatch, then whoever is still alive down there.
// Called from combat.stormTick (every 0.5 s, the old abstract exchange at the door) and squad.update (every frame).
import * as THREE from 'three';

const GAP = 1.4;              // file spacing (m)
const rf = (a, b) => a + Math.random() * (b - a);
function route(pts) { const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2])); return { pts, cum, total: cum[cum.length - 1] }; }
function routeAt(R, s, out = [0, 0, 0]) {
  const P = R.pts; if (s <= 0 || P.length < 2) { out[0] = P[0][0]; out[1] = P[0][1]; out[2] = P[0][2]; return out; }
  let i = 1; while (i < P.length - 1 && R.cum[i] < s) i++;
  const a = P[i - 1], b = P[i], L = R.cum[i] - R.cum[i - 1], f = L > 1e-6 ? Math.min(1, (s - R.cum[i - 1]) / L) : 1;
  out[0] = a[0] + (b[0] - a[0]) * f; out[1] = a[1] + (b[1] - a[1]) * f; out[2] = a[2] + (b[2] - a[2]) * f; return out;
}
const v3 = p => [p.x, p.y, p.z];

export class CQB {
  constructor(g) { this.g = g; this.stats = { rooms: 0, frags: 0, cellars: 0, duels: 0, kills: 0, attLost: 0 }; }
  // ---------------------------------------------------------------- interior geometry
  H(b) { return b.house ? 2.8 : b.kit.H; }
  floorY(b, f) { return b.house ? (b.floorY ? b.floorY() : b.y0 + 0.05) : f * b.kit.H + 0.02; }   // (v7: the house's real floor)
  floorOf(b, y) { return b.house ? 0 : Math.max(0, Math.min(b.floors - 1, Math.round((y - 0.02) / b.kit.H))); }
  door(b, ent) {
    if (b.house) { const d = b.doors.reduce((a, q) => (q.out.distanceTo(ent) < a.out.distanceTo(ent) ? q : a)); return { out: d.out.clone(), in: d.in.clone(), lx: d.lx, d }; }
    const [lx] = b.toLocal(ent.x, ent.z);
    return { out: ent.clone(), in: b.toWorld(lx, 0.02, -b.D / 2 + 1.2), lx };
  }
  stair(b, D, f, k = 0) { return b.toWorld(D.lx + k * 1.1, this.floorY(b, f), -b.D / 2 + 2.6 + Math.abs(k) * 1.0); }
  // points from `from` (on floor f0) to `to` (on floor f1): straight on one floor, by the stairwell between floors
  leg(b, D, from, f0, to, f1) {
    const pts = [from];
    if (b.house) { if (b.interior) pts.push(...b.interior({ x: from[0], z: from[2] }, { x: to[0], z: to[2] })); pts.push(to); return pts; }   // one room: straight (over the rubble)
    if (f0 !== f1) {
      const s = Math.sign(f1 - f0); pts.push(v3(this.stair(b, D, f0)));
      for (let f = f0; f !== f1; f += s) { const m = this.stair(b, D, f, 1); m.y = (this.floorY(b, f) + this.floorY(b, f + s)) / 2; pts.push(v3(m)); pts.push(v3(this.stair(b, D, f + s))); }
    }
    pts.push(to); return pts;
  }
  roomPos(b, sl, back = 0) { const p = b.slotPos(sl, new THREE.Vector3()), o = b.outward(sl.panel); p.addScaledVector(o, -back); if (back && b.clampIn) b.clampIn(p); return p; }   // (a house: still inside its room)
  // ---------------------------------------------------------------- per-man movement (squad.updateSoldier hook)
  // men inside walk toward their file point / walk target: smooth, never a teleport
  step(sq, s, dt) {
    const C = s.cqb; if (!C) return;
    if (C.walk?.wait > 0) { C.walk.wait -= dt; s.vel.set(0, 0, 0); return; }   // his turn at the door
    if (C.walk) { C.walk.p = Math.min(C.walk.R.total, C.walk.p + dt * 1.6); const a = routeAt(C.walk.R, C.walk.p); C.to = a; if (C.walk.p >= C.walk.R.total - 0.01) { const sl = C.walk.slot; s.cqb = null; if (sl && !sl.occupant) { sl.occupant = s; } if (sl && sl.occupant === s) { s.slotRef = sl; s.inside = sl; sq.building = C.walk.b; sq.building.slotPos(sl, s.pos); const o = C.walk.b.outward(sl.panel); s.heading = Math.atan2(o.x, o.z); } s.vel.set(0, 0, 0); return; } }
    if (!s.effective) { s.vel.set(0, 0, 0); return; }   // hit inside: lies where he fell
    const to = C.to; if (!to) { s.vel.set(0, 0, 0); return; }
    const dx = to[0] - s.pos.x, dy = to[1] - s.pos.y, dz = to[2] - s.pos.z, d = Math.hypot(dx, dy, dz);
    const sp = Math.min(d / Math.max(dt, 1e-3), d > 2.5 ? 3.2 : 1.9);
    if (d > 0.04) { s.pos.x += dx / d * sp * dt; s.pos.y += dy / d * sp * dt; s.pos.z += dz / d * sp * dt; s.vel.set(dx / d * sp, 0, dz / d * sp); } else s.vel.set(0, 0, 0);
    s.stance = 'crouch';
    if (C.face) s.heading = Math.atan2(C.face[0] - s.pos.x, C.face[1] - s.pos.z);
    else if (s.vel.lengthSq() > 0.05) s.heading = Math.atan2(s.vel.x, s.vel.z);
  }
  // ---------------------------------------------------------------- squad-level (stormTick: every 0.5 s)
  defenders(sq, b) { return b.slots.map(sl => sl.occupant).filter(d => d && d.effective && d.squad.side !== sq.side); }
  think(sq) {
    const O = sq.order, b = O.building, g = this.g;
    O.cqb ||= { phase: 'stack', t: 0 };
    const C = O.cqb;
    if (b.collapsedAll) return this.abort(sq, 'the building came down');
    if (C.phase !== 'stack') return;
    const def = this.defenders(sq, b);
    if (!def.length) return this.finish(sq);
    const att = sq.effective.filter(s => !s.path || s.pathI >= s.path.length).filter(s => s.pos.distanceTo(O.entrance) < 9);
    if (att.length < Math.min(2, sq.effective.length)) { if ((C.wait = (C.wait || 0) + 0.5) < 30) return; }   // still stacking up (go anyway after 30 s)
    C.t += 0.5; for (const s of att) s.stackT = 1;
    if (C.t < 2) return;
    // breach: pick the entry team, frag the doorway
    const D = this.door(b, O.entrance);
    const pool = sq.effective.filter(s => !s.dragging && !s.aboard).sort((p, q) => (q.assault ? 2 : 0) + (q.role?.leader ? 1 : 0) - (p.assault ? 2 : 0) - (p.role?.leader ? 1 : 0) + (p.pos.distanceTo(D.out) - q.pos.distanceTo(D.out)) * 0.1);
    if (!pool.length) return;   // nobody free to go in (all down / dragging / aboard): wait
    C.file = pool.slice(0, Math.min(4, pool.length)); C.D = D; C.p = 0; C.floor = 0;
    const lead = C.file[0];
    C.R = route(b.house && D.d?.thr ? [v3(lead.pos), ...b.entryRoute(D.d, D.in).slice(0, 4)] : [v3(lead.pos), v3(D.out), v3(D.in)]); C.legEnd = C.R.total;   // (a house: up the porch steps, through its real door)
    if (b.house) b.openWindow?.(null);   // (the door stands open)
    const thrower = C.file.find(s => (s.grenades ?? 0) > 0);
    if (thrower) { this.frag(thrower, D.in.clone().setY(D.in.y + 0.3)); C.waitT = 3.4; } else C.waitT = 0.6;
    C.phase = 'breach';
    if (sq.side === 'player') g.hud?.alert(`${sq.name}: breaching ${b.house ? 'the house' : 'the building'}`);
  }
  frag(s, at, cellar = null) {
    const g = this.g; s.grenades = (s.grenades ?? 2) - 1; this.stats.frags++;
    if (g.camDist(s.pos) < 80) g.sfx('grenade_pin', s.pos);
    g.combat.startThrow(s, at, { speed: 9, style: 'low', extra: { cellar } });   // v7: crouched underhand lob through the door / down the hatch
  }
  // a grenade down the cellar hatch: confined space, everyone down there is likely hit (combat.update calls this)
  cellarBlast(house, owner) {
    const g = this.g;
    for (const sq of g.squads) for (const s of sq.soldiers) if (s.cellar === house && s.alive && Math.random() < 0.72) g.combat.hitSoldier(s, { dmg: [70, 170], type: 'blast' }, house.cellar.hatch, true, owner);
  }
  // ---------------------------------------------------------------- every frame while storming
  tick(sq, dt) {
    const O = sq.order, C = O.cqb, g = this.g, b = O.building;
    if (!C || C.phase === 'stack') return;
    const before = C.file.length; C.file = C.file.filter(s => s.effective && !s.dragging);
    if (C.file.length < before) this.stats.attLost += before - C.file.length;
    if (!C.file.length) return this.abort(sq, 'the entry team is down');
    C.waitT = (C.waitT || 0) - dt;
    const lead = C.file[0];
    if (C.phase === 'breach') { this.place(sq, C, true); if (C.waitT <= 0) C.phase = 'move'; return; }
    if (C.phase === 'move') {
      if (C.p >= C.legEnd - 0.05) {
        // at the end of a leg: pick the next defended room (or the cellar), extend the route to it
        const tgt = this.nextRoom(sq, b, lead, C);
        if (!tgt) return this.finish(sq);
        const f1 = tgt.floor, end = v3(tgt.entry), here = routeAt(C.R, C.p).slice();
        const pts = this.leg(b, C.D, here, C.floor, end, f1);
        C.R = route(C.R.pts.slice(0, this.ptIndex(C.R, C.p)).concat([here]).concat(pts.slice(1)));   // keep the walked part: the file behind follows the same line
        C.p = Math.min(C.p, C.R.total); C.legEnd = C.R.total; C.floor = f1; C.room = tgt; C.fragged = false; C.duelT = 0;
      }
      C.p = Math.min(C.legEnd, C.p + dt * (sq.assault ? 1.9 : 1.6));
      this.place(sq, C, false);
      if (C.p >= C.legEnd - 0.05 && C.room) C.phase = 'room';
      return;
    }
    if (C.phase === 'room') {
      const R = C.room, foes = R.cellar ? this.cellarMen(sq, b) : this.roomFoes(sq, b, R);
      if (!foes.length) { this.stats.rooms++; C.room = null; C.phase = 'move'; C.face = null; for (const s of C.file) s.cqb && (s.cqb.face = null); return; }
      const thrower = C.file.slice(0, 3).find(s => (s.grenades ?? 0) > 0 && !(s.throwT > 0));
      if (!C.fragged && thrower) { C.fragged = true; C.fragT = g.time; this.frag(thrower, R.cellar ? b.cellar.hatch.clone().setY(b.cellar.y + 0.4) : R.pos.clone().setY(R.pos.y + 0.4), R.cellar ? b : null); C.waitT = 3.3; }
      C.fragged = true;
      this.place(sq, C, true, R);
      if (C.waitT > 0) return;
      // in: the point man and his number two step into the doorway of the room and shoot it out
      if (!R.cellar) C.p = Math.min(C.legEnd, C.p + dt * 0.8);
      if ((C.duelT -= dt) > 0) return;
      C.duelT = 0.4; this.stats.duels++;
      const stunned = g.time - (C.fragT ?? -99) < 4.2, skill = sq.assault ? 1.5 : 1;
      for (const s of C.file.slice(0, R.cellar ? 1 : 2)) {
        const d = foes[Math.floor(Math.random() * foes.length)]; if (!d.effective) continue;
        this.shoot(s, d, (R.cellar ? 0.22 : 0.32) * skill * (stunned ? 1.25 : 1));
      }
      for (const d of foes) {
        if (!d.effective || Math.random() > 0.7) continue;
        const t = C.file[0]; d.heading = Math.atan2(t.pos.x - d.pos.x, t.pos.z - d.pos.z);
        this.shoot(d, t, (R.cellar ? 0.26 : 0.21) * (d.squad.assault ? 1.4 : 1) * (1 - Math.min(0.8, d.suppression / 140)) * (stunned ? 0.35 : 1), R.cellar);
        d.suppression = Math.min(100, d.suppression + 15);
      }
      // still standing after a long exchange and grenades left: frag again
      if (foes.some(d => d.effective) && g.time - (C.fragT ?? -99) > 6 && thrower) C.fragged = false;
    }
  }
  shoot(s, t, p, hidden = false) {
    const g = this.g; s.firingT = 0.35; s.kick = 1; s.lastShotT = g.time;
    if (!hidden) s.heading = Math.atan2(t.pos.x - s.pos.x, t.pos.z - s.pos.z);
    if (!hidden && g.camDist(s.pos) < 160) { const m = s.muzzleWorld(new THREE.Vector3()), tp = t.pos.clone(); tp.y += 1.1; g.fx.muzzle(m, tp.sub(m).normalize(), 0.8); }
    g.sfx(s.weapon?.sound === 'mg' ? 'mg_near' : 'rifle_near', s.pos, { gain: 0.85 });
    if (Math.random() < p) { const was = t.state; g.combat.hitSoldier(t, s.weapon, s.pos, false, s); if (was !== t.state && !t.effective) this.stats.kills++; }
  }
  roomFoes(sq, b, R) { return b.slots.filter(sl => sl.occupant && sl.occupant.effective && sl.occupant.squad.side !== sq.side && !sl.occupant.cellar && sl.panel.floor === R.floor && b.slotPos(sl, new THREE.Vector3()).distanceTo(R.pos) < 4.6).map(sl => sl.occupant); }
  cellarMen(sq, b) { const out = []; for (const q of this.g.squads) if (q.side !== sq.side) for (const s of q.soldiers) if (s.cellar === b && s.effective) out.push(s); return out; }
  nextRoom(sq, b, lead, C) {
    let best = null, bc = 1e9;
    for (const sl of b.slots) {
      const d = sl.occupant; if (!d || !d.effective || d.squad.side === sq.side || d.cellar) continue;
      const pos = this.roomPos(b, sl), c = Math.abs(sl.panel.floor - C.floor) * 9 + pos.distanceTo(lead.pos);
      if (c < bc) { bc = c; best = { sl, floor: sl.panel.floor, pos, entry: this.roomPos(b, sl, b.house ? 1.4 : 1.9) }; }
    }
    if (best) return best;
    if (b.cellar && this.cellarMen(sq, b).length) { const h = b.cellar.hatch.clone(); h.y = b.floorY ? b.floorY() : b.y0 + 0.05; const e = h.clone(); e.x += 0.9; b.clampIn?.(e); return { cellar: true, floor: 0, pos: h, entry: e }; }
    return null;
  }
  ptIndex(R, p) { let i = 1; while (i < R.pts.length && R.cum[i] <= p) i++; return i; }
  // the file along the route: man k holds k * GAP behind the point; anyone still short of the door stays outside
  place(sq, C, hold, R = null) {
    C.file.forEach((s, k) => {
      const at = C.p - k * GAP;
      if (at < 0 && !s.cqb) return;   // not his turn yet: stays in the stack by the door (covering, normal fire)
      if (!s.cqb) { s.cqb = { b: sq.order?.building }; s.path = null; s.goal = null; s.pathReq = null; s.target = null; s.peek = 0; }
      s.cqb.to = routeAt(C.R, Math.max(0, at)).slice();
      s.cqb.face = R && k < 2 ? [R.pos.x, R.pos.z] : null;
    });
  }
  // ---------------------------------------------------------------- end of the clearing
  finish(sq) {
    const O = sq.order, b = O.building, g = this.g, C = O.cqb;
    if (C?.file?.length) this.stats.cleared = (this.stats.cleared || 0) + 1;
    if (sq.side === 'player') g.hud?.alert(`${sq.name}: ${b.house ? 'house' : 'building'} cleared`, 'good');
    // the men inside walk to free windows (through the floors); the rest come in by the door (normal garrison order)
    const inside = sq.soldiers.filter(s => s.cqb && s.effective);
    sq.order = null;
    if (!inside.length) return sq.orderGarrison(b);
    sq.order = { type: 'garrison', building: b }; sq.building = b;
    const free = b.slots.filter(sl => !sl.occupant && !sl.panel.gone);
    const picked = sq.spreadSlots(b, free, sq.effective.filter(s => !s.dragging).length);
    for (const s of inside) {
      let k = -1, bc = 1e9; picked.forEach((sl, i) => { const c = Math.abs(sl.panel.floor - this.floorOf(b, s.pos.y)) * 9 + this.roomPos(b, sl).distanceTo(s.pos); if (c < bc) { bc = c; k = i; } });
      if (k < 0) { s.cqb = { to: [s.pos.x, s.pos.y, s.pos.z] }; continue; }
      const sl = picked.splice(k, 1)[0]; sl.occupant = s;
      const via = b.house && b.P ? b.toDoorIn(s.pos, C?.D?.d) : [];   // (a house: a man still on the steps / in the doorway goes in by the door first)
      const pts = via.length ? [v3(s.pos), ...via, ...this.leg(b, null, via[via.length - 1], 0, v3(this.roomPos(b, sl)), 0).slice(1)]
        : this.leg(b, C?.D || this.door(b, b.entrances[0]), v3(s.pos), this.floorOf(b, s.pos.y), v3(this.roomPos(b, sl)), sl.panel.floor);
      s.cqb = { walk: { R: route(pts), p: 0, slot: sl, b } };
    }
    for (const s of sq.effective) if (!s.cqb && !s.dragging && !s.inBuilding && picked.length) {
      const sl = picked.shift(); sl.occupant = s; s.slotRef = sl;
      const ent = b.entrances.reduce((a, e) => (e.distanceToSquared(s.pos) < a.distanceToSquared(s.pos) ? e : a));
      s.goal = [ent.x, ent.z]; s.goalHeading = null; g.requestPath(s, s.pos.x, s.pos.z, ent.x, ent.z, 0.45);
    }
  }
  // garrisoning: a man reaching the door walks in and to his window through the floors (no pop from the door to the window). A
  // house: from where he stands to the door's outside point, up the porch steps, through the doorway, across the room to his spot
  // at the window - one man at a time in the doorway
  entryWalk(sq, s, b, sl) {
    const ent = b.entrances.reduce((a, e) => (e.distanceToSquared(s.pos) < a.distanceToSquared(s.pos) ? e : a)), D = this.door(b, ent);
    if (b.house && D.d?.thr) {
      const pts = [v3(s.pos), ...b.entryRoute(D.d, this.roomPos(b, sl))], R = route(pts), inS = R.cum[4] ?? R.total;
      const queue = sq.soldiers.filter(o => o !== s && o.cqb?.walk?.b === b && !o.cqb.walk.exit && o.cqb.walk.p < o.cqb.walk.inS).length;
      s.cqb = { walk: { R, p: 0, slot: sl, b, inS, wait: queue * 0.75 } }; s.target = null; b.openWindow?.(null);
      return;
    }
    const pts = [v3(s.pos), v3(D.in)].concat(this.leg(b, D, v3(D.in), 0, v3(this.roomPos(b, sl)), sl.panel.floor).slice(1));
    s.cqb = { walk: { R: route(pts), p: 0, slot: sl, b } }; s.target = null;
  }
  // leaving a house: from his spot (or the hatch) across the room, out through the door and down the steps; then on to wherever
  // he was sent (squad.update -> walkStep). k = his place in the file out of the door
  exitWalk(sq, s, b, k = 0) {
    const d = b.doorNear(s.pos), from = s.pos.clone(); b.clampIn?.(from, 0.3);
    s.cqb = null; s.houseWalk = { R: route([v3(s.pos), ...b.exitRoute(from, d)]), p: 0, b, wait: k * 0.7 }; s.vel.set(0, 0, 0);
  }
  walkStep(sq, s, dt) {
    const W = s.houseWalk;
    if (!s.effective) { s.houseWalk = null; s.cqb = { to: null }; s.vel.set(0, 0, 0); return; }   // hit on the way out: lies inside
    if (W.wait > 0) { W.wait -= dt; s.vel.set(0, 0, 0); return; }
    const a = routeAt(W.R, W.p), sp = s.squad?.run ? 2.2 : 1.6; W.p = Math.min(W.R.total, W.p + dt * sp); const b = routeAt(W.R, W.p);
    s.pos.set(b[0], b[1], b[2]); s.vel.set((b[0] - a[0]) / Math.max(dt, 1e-3), 0, (b[2] - a[2]) / Math.max(dt, 1e-3)); s.stance = 'crouch';
    if (W.p >= W.R.total - 1e-3) {
      s.houseWalk = null; s.vel.set(0, 0, 0); const g = this.g;
      if (g.city.groundHeight) s.pos.y = g.city.groundHeight(s.pos.x, s.pos.z);
      if (s.goal && !s.dragging) { s.path = null; g.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], 0.45); }   // (the route asked for from inside the house is no good)
    }
  }
  abort(sq, why) {
    const g = this.g, O = sq.order;
    if (sq.side === 'player' && why) g.hud?.alert(`${sq.name}: assault on the ${O?.building?.house ? 'house' : 'building'} failed — ${why}`, 'bad');
    sq.order = null; this.exitAll(sq, O?.cqb?.D, O?.building);
    // one more go with whoever is left (a fresh entry team from the stack)
    if (O?.building && (O.tries || 0) < 1 && sq.effective.length >= 2 && !sq.routing && !O.building.collapsedAll) { sq.orderStorm(O.building); if (sq.order?.type === 'storm') sq.order.tries = (O.tries || 0) + 1; }
  }
  // anyone still inside (order changed, rout, abort): out by the door (a house: walks out through it)
  exitAll(sq, D = null, b = null) {
    let k = 0;
    for (const s of sq.soldiers) {
      if (!s.cqb) continue;
      const C = s.cqb; s.cqb = null;
      if (C.walk?.slot?.occupant === s && !s.inside) C.walk.slot.occupant = null;
      if (!s.effective) { s.cqb = { to: null }; continue; }   // the wounded / dead stay where they fell (on that floor)
      const hb = b || C.walk?.b || C.b;
      if (hb?.house && hb.P && hb.contains(s.pos, 0.2)) { this.exitWalk(sq, s, hb, k++); continue; }
      const out = D?.out || s.pos; s.pos.set(out.x, this.g.city.groundHeight ? this.g.city.groundHeight(out.x, out.z) : 0, out.z); s.path = null; s.goal = null; s.vel.set(0, 0, 0);
    }
  }
}
