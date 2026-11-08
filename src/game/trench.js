// Trench warfare for squads (mixed into Squad):
//  - orderTrench(T): occupy a trench system (city.trenchSystems): men spread over the fighting positions (MG in the
//    covered MG cell / a bay, riflemen in the bays and along the front wall), facing the enemy, crouched against the
//    wall and stepping up onto the firing step to shoot; under shelling with no enemy infantry close they take
//    shelter in the dugouts (one observer stays up) and come out again when the shelling stops or the enemy closes.
//  - orderClearTrench(T): the squad stacks at one end of an enemy-held trench and works down it in file, the point
//    man pausing at each corner, grenades thrown ahead at defenders around the next bend and into every occupied
//    dugout (assault squads frag every dugout they pass), then the trench is occupied.
import * as THREE from 'three';

const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// --- route helpers along a trench centre line
function routeOf(line) {
  const cum = [0]; for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + near(line[i], line[i - 1]));
  return { pts: line, cum, total: cum[cum.length - 1] };
}
function routeAt(r, s, out = [0, 0]) {
  s = THREE.MathUtils.clamp(s, 0, r.total);
  let i = 1; while (i < r.cum.length - 1 && r.cum[i] < s) i++;
  const a = r.pts[i - 1], b = r.pts[i], L = r.cum[i] - r.cum[i - 1] || 1, t = (s - r.cum[i - 1]) / L;
  out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out.dir = Math.atan2(b[0] - a[0], b[1] - a[1]);
  return out;
}
// arclength of the nearest point on the route + lateral distance
function routeProject(r, x, z) {
  let best = 1e9, bs = 0;
  for (let i = 1; i < r.pts.length; i++) {
    const [ax, az] = r.pts[i - 1], [bx, bz] = r.pts[i], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
    const t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1), px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz);
    if (d < best) { best = d; bs = r.cum[i - 1] + Math.sqrt(L2) * t; }
  }
  return { s: bs, d: best };
}

// arclengths of the bends / traverses of a route (turns over ~25 deg, merged within 4 m), at least every 12 m
function cornersOf(r) {
  const out = [];
  for (let i = 1; i < r.pts.length - 1; i++) {
    const a = r.pts[i - 1], b = r.pts[i], c = r.pts[i + 1];
    let d = Math.abs(Math.atan2(b[0] - a[0], b[1] - a[1]) - Math.atan2(c[0] - b[0], c[1] - b[1])) % (Math.PI * 2); if (d > Math.PI) d = Math.PI * 2 - d;
    if (d > 0.45 && r.cum[i] > 3 && r.cum[i] < r.total - 2 && (!out.length || r.cum[i] - out[out.length - 1] > 4)) out.push(r.cum[i]);
  }
  const all = [0]; for (const c of [...out, r.total]) { const last = all[all.length - 1]; const n = Math.ceil((c - last) / 12); for (let k = 1; k < n; k++) all.push(last + (c - last) * k / n); if (c < r.total) all.push(c); }
  return all;
}
// a walk that stays inside the trench (along the centre line) from one point of system T to another, or null
export function trenchPath(T, ax, az, bx, bz) {
  for (const l of T.lines) {
    const r = routeOf(l), a = routeProject(r, ax, az), b = routeProject(r, bx, bz);
    if (a.d > 4 || b.d > 4) continue;
    const pts = [], dir = Math.sign(b.s - a.s) || 1;
    for (let i = 0; i < r.cum.length; i++) if ((r.cum[i] - a.s) * dir > 0.3 && (b.s - r.cum[i]) * dir > 0.3) pts.push(r.pts[i]);
    if (dir < 0) pts.sort((p, q) => routeProject(r, q[0], q[1]).s - routeProject(r, p[0], p[1]).s); else pts.sort((p, q) => routeProject(r, p[0], p[1]).s - routeProject(r, q[0], q[1]).s);
    pts.push([bx, bz]);
    return pts;
  }
  return null;
}
function walkIn(sq, s, T, x, z) {
  const p = T ? trenchPath(T, s.pos.x, s.pos.z, x, z) : null;
  s.goal = [x, z];
  if (p) { s.path = p; s.pathI = 0; s.pathReq = null; } else sq.game.requestPath(s, s.pos.x, s.pos.z, x, z, 0.45);
}
export function trenchNear(game, x, z, r = 12) {
  let best = null, bd = r;
  for (const T of game.city.trenchSystems || []) {
    if (Math.hypot(T.center[0] - x, T.center[1] - z) > T.radius + r) continue;
    for (const l of T.lines) for (let i = 1; i < l.length; i++) { const p = routeProject({ pts: [l[i - 1], l[i]], cum: [0, near(l[i], l[i - 1])] }, x, z); if (p.d < bd) { bd = p.d; best = T; } }
    for (const sl of T.slots) { const d = Math.hypot(sl.x - x, sl.z - z); if (d < bd) { bd = d; best = T; } }
  }
  return best;
}
// soldiers of `side` in trench T (occupying it, sheltering in its dugouts, or standing in its cuts)
export function trenchMen(game, T, side) {
  const out = [];
  for (const sq of game.squads) {
    if (sq.side !== side || sq.destroyed || sq.mounted) continue;
    for (const s of sq.soldiers) {
      if (!s.effective) continue;
      if (s.trenchSys === T) { out.push(s); continue; }
      if (s.inside) continue;
      if (Math.hypot(s.pos.x - T.center[0], s.pos.z - T.center[1]) > T.radius + 6) continue;
      if (game.city.trenchInfo?.(s.pos.x, s.pos.z)) out.push(s);
    }
  }
  return out;
}

export const TrenchMixin = {
  orderTrench(T) {
    if (this.routing || !T) return;
    const enemy = this.side === 'player' ? 'enemy' : 'player';
    if (trenchMen(this.game, T, enemy).length) return this.orderClearTrench(T);
    this.takeCommand?.();   // v9: men busy with a casualty let go (squad.js)
    if (this.mounted) this.dismount();
    this.leaveBuilding();
    const men = this.effective.filter(s => !s.dragging);
    const c = this.center();
    const free = T.slots.filter(sl => !sl.occupant || !sl.occupant.effective);
    if (!free.length) { if (this.side === 'player') this.game.hud?.alert('Trench is fully manned', 'bad'); return; }
    // where is the enemy? (nearest enemy squad, else the enemy's side of the map)
    let ex = 0, ez = this.side === 'player' ? -1 : 1, bd = 1e9;
    for (const q of this.game.squads) if (q.side !== this.side && !q.destroyed && q.effective.length) { const qc = q.center(), d = Math.hypot(qc.x - c.x, qc.z - c.z); if (d < bd && d < 400) { bd = d; ex = qc.x - c.x; ez = qc.z - c.z; } }
    const eL = Math.hypot(ex, ez) || 1; ex /= eL; ez /= eL;
    const facing = sl => sl.fx * ex + sl.fz * ez;
    // a contiguous stretch nearest the squad, preferring positions that face the enemy (a strongpoint faces all
    // ways; in a captured trench the men turn round and fight from the rear wall)
    const anchor = free.reduce((a, sl) => (Math.hypot(sl.x - c.x, sl.z - c.z) - facing(sl) * 8 < Math.hypot(a.x - c.x, a.z - c.z) - facing(a) * 8 ? sl : a));
    const pick = free.slice().sort((p, q) => (Math.hypot(p.x - anchor.x, p.z - anchor.z) - facing(p) * 10) - (Math.hypot(q.x - anchor.x, q.z - anchor.z) - facing(q) * 10)).slice(0, men.length);
    // machine gunner -> covered MG cell or a bay; RPG -> a bay; the rest fill in
    const order = men.slice().sort((a, b) => (b.weaponKey === 'pkm' ? 2 : b.weaponKey === 'rpg7' ? 1 : 0) - (a.weaponKey === 'pkm' ? 2 : a.weaponKey === 'rpg7' ? 1 : 0));
    const rank = sl => (sl.kind === 'mg' ? 2 : sl.kind === 'bay' ? 1 : 0) + (facing(sl) > 0 ? 1 : 0);
    this.order = { type: 'trench', trench: T }; this.trench = T;
    for (const s of order) {
      let sl = null;
      if (s.weaponKey === 'pkm' || s.weaponKey === 'rpg7') sl = pick.filter(p => rank(p) > 0).sort((p, q) => rank(q) - rank(p))[0];
      sl ??= pick.reduce((a, p) => (!a || Math.hypot(p.x - s.pos.x, p.z - s.pos.z) < Math.hypot(a.x - s.pos.x, a.z - s.pos.z) ? p : a), null);
      if (!sl) { // more men than positions: wait in the nearest dugout, or behind the line
        s.trenchSys = T; s.trenchReserve = true;
        const d = T.dugouts[0]; const p = d ? d.door : T.lines[0][0];
        s.goal = [p[0], p[1]]; s.goalHeading = Math.atan2(T.front[0], T.front[1]); this.game.requestPath(s, s.pos.x, s.pos.z, p[0], p[1], 0.45);
        continue;
      }
      pick.splice(pick.indexOf(sl), 1);
      sl.occupant = s; s.trenchSlot = sl; s.trenchSys = T; s.trenchReserve = false;
      s.trenchFlip = facing(sl) < -0.35;
      s.goal = [sl.x, sl.z]; s.goalHeading = s.trenchFlip ? Math.atan2(-sl.fx, -sl.fz) : Math.atan2(sl.fx, sl.fz);
      s.speedMul = 0.9 + Math.random() * 0.2; s.startDelay = Math.random() * 0.6;
      this.game.requestPath(s, s.pos.x, s.pos.z, sl.x, sl.z, 0.45);
    }
    if (this.side === 'player') this.game.hud?.alert(`${this.name}: occupying the trench`);
  },
  leaveTrench() {
    if (this.order?.type === 'clear') this.endClear();
    for (const s of this.soldiers) {
      if (s.dugout) this.exitDugout(s, false);
      if (s.trenchSlot) { s.trenchSlot.occupant = null; s.trenchSlot = null; }
      s.trenchSys = null; s.trenchReserve = false;
    }
    this.trench = null;
    if (this.order?.type === 'clear') this.order = null;
  },
  inTrenchSlot(s) { return s.trenchSlot && Math.hypot(s.pos.x - s.trenchSlot.x, s.pos.z - s.trenchSlot.z) < 1.3 && !(s.path && s.pathI < s.path.length); },
  enterDugout(s, d) {
    s.dugout = d; d.occupants.add(s); s.inside = 'btr'; s.path = null; s.goal = null; s.target = null; s.vel.set(0, 0, 0);
    s.pos.set(d.x, -1.7, d.z);
  },
  exitDugout(s, back = true) {
    const d = s.dugout; if (!d) return;
    d.occupants.delete(s); s.dugout = null; s.inside = null; s.pos.set(d.door[0], -1.5, d.door[1]);
    if (back && s.trenchSlot) { s.goalHeading = Math.atan2(s.trenchSlot.fx, s.trenchSlot.fz); walkIn(this, s, s.trenchSys || this.trench, s.trenchSlot.x, s.trenchSlot.z); }
  },
  // every think (0.5 s) while holding a trench
  trenchThink() {
    const T = this.trench, g = this.game; if (!T) return;
    const enemy = this.side === 'player' ? 'enemy' : 'player';
    // enemy infantry close: everybody up and fighting
    let close = false;
    for (const sq of g.squads) if (sq.side === enemy && !sq.destroyed && !sq.mounted && sq.effective.some(e => Math.hypot(e.pos.x - T.center[0], e.pos.z - T.center[1]) < T.radius + 70)) { close = true; break; }
    const shelled = g.time - (T.shelledT ?? -99) < 9 && T.shelledBy !== this.side;
    const sheltered = this.soldiers.filter(s => s.dugout);
    if (shelled && !close && T.dugouts.length) {
      // under artillery: into the dugouts, one observer (the MG or the leader) stays at his post
      const up = this.effective.filter(s => !s.dugout && (s.trenchSlot || s.trenchReserve));
      const watch = up.find(s => s.weaponKey === 'pkm') || up.find(s => s.role.leader) || up[0];
      for (const s of up) {
        if (s === watch) continue;
        const d = T.dugouts.reduce((a, o) => (o.occupants.size < 8 && (!a || near([s.pos.x, s.pos.z], o.door) < near([s.pos.x, s.pos.z], a.door)) ? o : a), null);
        if (!d) break;
        if (near([s.pos.x, s.pos.z], d.door) < 1.6) this.enterDugout(s, d);
        else if (!s.toDugout) { s.toDugout = d; walkIn(this, s, T, d.door[0], d.door[1]); }
      }
      for (const s of up) if (s.toDugout && near([s.pos.x, s.pos.z], s.toDugout.door) < 1.6) { const d = s.toDugout; s.toDugout = null; this.enterDugout(s, d); }
      if (sheltered.length === 0 && up.length > 1 && this.side === 'player' && !this.shelterSaid) { this.shelterSaid = true; g.hud?.alert(`${this.name}: taking cover in the dugout`); }
    } else {
      for (const s of this.soldiers) if (s.toDugout) { s.toDugout = null; if (s.trenchSlot) walkIn(this, s, T, s.trenchSlot.x, s.trenchSlot.z); }
      if (sheltered.length && (close || g.time - (T.shelledT ?? -99) > 11)) { this.shelterSaid = false; sheltered.forEach((s, i) => { if (close && (s.stayIn ??= Math.random() < 0.35 + s.suppression / 300)) return; s.exitAt ??= g.time + i * (close ? 0.4 : 0.9); if (g.time >= s.exitAt) { s.exitAt = null; s.stayIn = undefined; this.exitDugout(s); } }); }
    }
    // stance at the post: crouched against the front wall, up on the firing step to shoot, down when the fire is heavy
    for (const s of this.effective) {
      if (s.dugout || !this.inTrenchSlot(s)) continue;
      // in the 1.7 m fire trench a man stands at the front wall with his eyes at the lip; in a 1.1 m firing cell he
      // crouches until he shoots; firing: up on the step (squad.groundY raises him to fireY), heavy fire: duck
      const firing = s.target || g.time - (s.lastShotT ?? -99) < 2 || (this.fireAt && !this.holdFire);
      s.stance = s.suppression > 75 ? 'crouch' : firing ? 'stand' : s.trenchSlot.kind === 'line' ? 'stand' : 'crouch';
      s.goalHeading = s.trenchFlip ? Math.atan2(-s.trenchSlot.fx, -s.trenchSlot.fz) : Math.atan2(s.trenchSlot.fx, s.trenchSlot.fz);
    }
  },
  // ------------------------------------------------------------------------------------------ trench clearing (v6)
  // Ordered into an enemy-held trench, the squad splits in two:
  //  - support / fire group (MG, RPG, leader, the rest): takes a fire position out on the flank, 20-30 m off the trench on
  //    our side, and suppresses the stretch AHEAD of the assault group (12-38 m beyond the point man: rounds into the trench,
  //    fire at any defender it sees there -- never at a man within 12 m of the assault group or with them in the line of
  //    fire); it bounds along the outside (half the group at a time, the other half firing) to keep abreast, and lifts its
  //    fire when the assault group nears the far end.
  //  - assault group (3-4 riflemen with the grenades): runs a covered route to the nearest end of the trench, stacks there
  //    and, once the support is firing, clears it bay by bay: point man and cover man stop short of each traverse / bend,
  //    the No. 3 throws a grenade round it, bang, then the pair bounds through the bay with the rest following; every
  //    dugout entrance on the way gets a grenade (two if somebody is still in there) before the point man checks it.
  //  - cleared: the squad regroups and occupies the trench (or the assault moves to the next line still held).
  // Under 5 men the squad goes in as one file (no split). The AI uses the same order (repeat calls keep the progress).
  orderClearTrench(T) {
    if (this.routing || !T) return;
    if (this.order?.type === 'clear' && this.order.trench === T && this.order.v6 && this.order.phase !== 'done') return;   // already at it
    this.takeCommand?.();
    if (this.mounted) this.dismount();
    this.leaveBuilding();
    const g = this.game, enemy = this.side === 'player' ? 'enemy' : 'player', c = this.center();
    const foes = trenchMen(g, T, enemy);
    // the line the defenders are in; enter it from the end nearest to us
    let line = T.lines[0], bestN = -1;
    for (const l of T.lines) { const r = routeOf(l), n = foes.filter(f => routeProject(r, f.pos.x, f.pos.z).d < 6 || (f.dugout && T.dugouts.includes(f.dugout) && routeProject(r, f.dugout.door[0], f.dugout.door[1]).d < 4)).length; if (n > bestN) { bestN = n; line = l; } }
    if (bestN <= 0 && foes.length) {   // defenders only in foxholes / outside the trench lines: plain assault on them
      const f = foes.reduce((a, o) => (o.pos.distanceTo(c) < a.pos.distanceTo(c) ? o : a));
      this.orderMove(f.pos.x, f.pos.z, null, 14, true); this.focus = f.squad; return;
    }
    if (near(line[line.length - 1], [c.x, c.z]) < near(line[0], [c.x, c.z])) line = line.slice().reverse();
    const route = routeOf(line);
    const out = Math.atan2(line[0][0] - line[1][0], line[0][1] - line[1][1]);   // outward past the entry end
    const men = this.effective.filter(s => !s.dragging && !s.inside);
    // the assault group: riflemen with the most grenades (no MG, no RPG gunner, not the leader), nearest the entry first
    const nA = men.length >= 7 ? 4 : men.length >= 5 ? 3 : men.length;
    const rank = s => (s.weaponKey === 'pkm' ? 60 : 0) + (s.weaponKey === 'rpg7' ? 40 : 0) + (s.role.leader ? 30 : 0) + (s.role.medic ? 6 : 0) - (s.grenades ?? 2) * 2.5 + near([s.pos.x, s.pos.z], line[0]) * 0.05;
    const sorted = men.slice().sort((a, b) => rank(a) - rank(b));
    const A = sorted.slice(0, nA), S = sorted.slice(nA);
    // file order: point man (nearest the entry), cover man, then the grenadiers
    A.sort((a, b) => near([a.pos.x, a.pos.z], line[0]) - near([b.pos.x, b.pos.z], line[0]));
    // which side of the trench we are on (the support stays on it)
    const L0 = line[0], L1 = line[line.length - 1], lx = L1[0] - L0[0], lz = L1[1] - L0[1], side = Math.sign(lx * (c.z - L0[1]) - lz * (c.x - L0[0])) || 1;
    const O = this.order = { type: 'clear', v6: true, trench: T, route, p: -2, phase: 'move', waitT: 0, t: 0, file: A, grp: { a: A, s: S }, out, side,
      corners: cornersOf(route), next: 0, doneDug: new Set(), frags: 0, supS: null, bound: 0, lifted: false, thinkT: 0 };
    this.trench = null; this.run = true;
    const thr = this.foeCentre(T, enemy) || T.center;
    A.forEach((s, k) => {
      s.clearRole = 'a';
      const d = 5 + k * 1.8, [gx, gz] = g.nav.nearestFree(line[0][0] + Math.sin(out) * d, line[0][1] + Math.cos(out) * d, 0.4, 4);
      s.goal = [gx, gz]; s.goalHeading = out + Math.PI; s.startDelay = k * 0.2; g.requestPath(s, s.pos.x, s.pos.z, gx, gz, 0.45, false, { threat: thr });
    });
    for (const s of S) s.clearRole = 's';
    if (S.length) this.supportMove(O, S, Math.min(route.total * 0.35, 14));
    if (this.side === 'player') g.hud?.alert(S.length ? `${this.name}: clearing the trench - fire group (${S.length}) to the flank, assault group (${A.length}) to the end of the trench` : `${this.name}: clearing the trench`);
  },
  foeCentre(T, enemy) {
    const f = trenchMen(this.game, T, enemy); if (!f.length) return null;
    let x = 0, z = 0; for (const s of f) { x += s.pos.x; z += s.pos.z; } return [x / f.length, z / f.length];
  },
  // fire position for the support group abreast of arclength sA: 20-30 m out from the trench on our side, a stretch
  // the men can walk to and see the trench from (no building in between)
  firePos(O, sA) {
    const nav = this.game.nav, R = O.route, a = routeAt(R, Math.max(0, sA - 6)), b = routeAt(R, Math.min(R.total, sA + 6)), m = routeAt(R, sA);
    let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const nx = -dz * O.side, nz = dx * O.side;   // our side of the line
    for (const D of [24, 18, 30, 14, 36]) {
      const [x, z] = nav.nearestFree(m[0] + nx * D, m[1] + nz * D, 0.6, 4), k = nav.idx(x, z);
      if (!nav.passable(k, 0.45) || (nav.trench && nav.trench[k])) continue;
      const o = nav.occluded(x, 1.6, z, m[0], 0.4, m[1], null, null, true); if (o && !o.terrain) continue;
      return { x, z, f: Math.atan2(m[0] - x, m[1] - z), dx, dz };
    }
    return null;
  },
  // (some of) the support group to a fire position abreast of arclength sA, spread along the trench, in cover
  supportMove(O, men, sA) {
    const g = this.game, P = this.firePos(O, sA); if (!P) return;
    O.supS = sA;
    const slots = this.formationSlots(P.x, P.z, P.f, Math.max(6, men.length * 3.2), { thr: [routeAt(O.route, sA)[0], routeAt(O.route, sA)[1]] });
    const thr = this.foeCentre(O.trench, this.side === 'player' ? 'enemy' : 'player');
    men.forEach((s, i) => { const sl = slots[i % slots.length]; s.goal = sl; s.goalHeading = P.f; s.path = null; g.requestPath(s, s.pos.x, s.pos.z, sl[0], sl[1], 0.45, false, thr ? { threat: thr } : null); });
  },
  // every frame while clearing
  clearTick(dt) {
    const O = this.order, g = this.game, T = O.trench, R = O.route, enemy = this.side === 'player' ? 'enemy' : 'player';
    if (!O.v6) { this.order = null; return; }
    O.t += dt;
    O.grp.a = O.grp.a.filter(s => s.effective && !s.dragging); O.grp.s = O.grp.s.filter(s => s.effective && !s.dragging);
    // assault group down to one man: everybody goes in (the fire group joins the file at the back, fire lifts)
    if (O.grp.a.length < 2 && O.grp.s.length) { for (const s of O.grp.s) { s.clearRole = 'a'; s.fireAt = null; } O.grp.a.push(...O.grp.s); O.grp.s = []; this.liftFire(O, 'joining the assault'); }
    O.file = O.grp.a;
    if (!O.file.length) { this.endClear(); this.order = null; return; }
    const foes = trenchMen(g, T, enemy);
    if (!foes.length && O.phase !== 'move') return this.regroup(T);
    // support group: fire control + bounding along the outside (twice a second)
    if ((O.thinkT -= dt) <= 0) { O.thinkT = 0.5; this.supportThink(O, foes); }
    const lead = O.file[0];
    if (O.phase === 'move') {
      const stage = [R.pts[0][0] + Math.sin(O.out) * 5, R.pts[0][1] + Math.cos(O.out) * 5];
      const atEnd = near([lead.pos.x, lead.pos.z], stage) < 4, gathered = O.file.filter(s => near([s.pos.x, s.pos.z], stage) < 9).length >= Math.min(2, O.file.length);
      const supReady = !O.grp.s.length || O.grp.s.filter(s => !(s.path && s.pathI < s.path.length) && !s.pathReq).length >= Math.ceil(O.grp.s.length * 0.6);
      if ((atEnd && gathered && (supReady || O.t > 30)) || O.t > 50) {
        O.phase = 'stack'; O.p = -1.5; O.sc = 0; O.waitT = 4; this.run = false;
        if (this.side === 'player') g.hud?.alert(`${this.name}: ${O.grp.s.length ? 'fire group suppressing - ' : ''}assault group going in`);
      }
      return;
    }
    O.waitT -= dt;
    const thrower = O.file.slice(1).find(s => (s.grenades ?? 0) > 0 && !(s.throwT > 0)) || ((lead.grenades ?? 0) > 0 && !(lead.throwT > 0) ? lead : null);
    // nearest defender ahead in the trench (not in a dugout)
    let ahead = null, da = 1e9;
    for (const f of foes) { if (f.dugout) continue; const pr = routeProject(R, f.pos.x, f.pos.z); if (pr.d < 4 && pr.s > O.p - 1 && pr.s - O.p < da) { da = pr.s - O.p; ahead = f; } }
    if (O.phase === 'dugout') {
      const d = O.dug, inside = [...d.occupants].filter(s => s.effective && s.squad.side === enemy);
      if (O.waitT > 0) return this.clearPlace(dt);
      if (O.dfrag < (inside.length ? 2 : O.dfrag === 0 ? 1 : 0) && thrower) { this.fragDugout(thrower, d); O.dfrag++; O.waitT = 3.6; return this.clearPlace(dt); }
      O.p = Math.max(O.p, O.dugS);   // the point man to the entrance: checks it
      // survivors after the grenades: the point man goes in after them (short, violent exchange)
      for (const s of inside) if (Math.random() < 0.75) g.combat.hitSoldier(s, lead.weapon, lead.pos, false, lead);
      for (const s of inside) if (s.effective && Math.random() < 0.3) g.combat.hitSoldier(lead, s.weapon, s.pos, false, s);
      if (inside.some(s => s.effective) && (O.dugTries = (O.dugTries || 0) + 1) < 4) { O.waitT = 1.5; return this.clearPlace(dt); }
      O.doneDug.add(d); O.phase = 'bound'; O.dug = null; O.dugTries = 0; return;
    }
    if (O.phase === 'stack') {
      // point man short of the bend (2 m), cover man on him; then a grenade round it if there may be anyone there
      O.p = Math.min(O.p + dt * 1.4, O.sc - 2);
      this.clearPlace(dt);
      const placed = near([lead.pos.x, lead.pos.z], routeAt(R, Math.max(0, O.p))) < 1.2 || O.p < 0;
      if (!(placed || O.waitT < 0)) return;
      const bayFoes = foes.filter(f => !f.dugout && (pr => pr.d < 4 && pr.s > O.sc - 1 && pr.s < O.sc + 14)(routeProject(R, f.pos.x, f.pos.z))).length;
      const nadesLeft = O.file.reduce((a, s) => a + (s.grenades ?? 0), 0), toGo = O.corners.length - O.next + T.dugouts.length;
      if (thrower && (bayFoes || (foes.length && nadesLeft > toGo && Math.random() < (this.assault ? 0.95 : 0.7)))) {
        const at = routeAt(R, Math.min(R.total, O.sc + 8)), gy = g.city.groundHeight ? g.city.groundHeight(at[0], at[1]) : 0;
        g.combat.throwGrenade(thrower, { pos: new THREE.Vector3(at[0], gy + 0.2, at[1]), inBuilding: false });
        O.frags++; O.phase = 'bang'; O.waitT = 3.5;
      } else { O.phase = 'bound'; }
      O.bayEnd = Math.min(R.total, O.next + 1 < O.corners.length ? O.corners[O.next + 1] - 2 : O.sc + 12);
      return;
    }
    if (O.phase === 'bang') { if (O.waitT <= 0) O.phase = 'bound'; return this.clearPlace(dt); }
    // phase 'bound': through the bay, firing at anything in it; a dugout entrance on the way gets cleared first
    for (const d of T.dugouts) {
      if (O.doneDug.has(d)) continue;
      const pr = routeProject(R, d.door[0], d.door[1]); if (pr.d > 4 || pr.s > O.p + 1.5) continue;
      const occupied = [...d.occupants].some(s => s.effective && s.squad.side === enemy);
      // (the file steps back 4.5 m from the entrance while the grenades go in: a grenade's lethal radius is 6 m)
      if (thrower && (occupied || this.assault || Math.random() < 0.6)) { O.phase = 'dugout'; O.dug = d; O.dfrag = 0; O.dugS = pr.s; O.p = Math.min(O.p, pr.s - 4.5); O.waitT = 1.2; return this.clearPlace(dt); }
      O.doneDug.add(d);
    }
    if (ahead && da > 8 && da < 16 && thrower && (O.lastFrag ?? -99) < g.time - 5) {   // a defender in the bay (8 m+ out: lethal radius 6 m): grenade him first
      O.lastFrag = g.time; g.combat.throwGrenade(thrower, ahead); O.phase = 'bang'; O.waitT = 3.4; O.frags++;
      return this.clearPlace(dt);
    }
    if (ahead && da < 6) {   // shoot it out; a stand-off round the traverse (no line of fire) ends in a close-quarters rush
      if ((O.holdT = (O.holdT || 0) + dt) > 9) { O.holdT = 0; if (Math.random() < 0.65) g.combat.hitSoldier(ahead, lead.weapon, lead.pos, false, lead); else g.combat.hitSoldier(lead, ahead.weapon, ahead.pos, false, ahead); }
      return this.clearPlace(dt);
    }
    O.holdT = 0;
    O.p = Math.min(R.total, O.p + dt * (this.assault ? 1.5 : 1.2) * (ahead && da < 20 ? 0.6 : 1));
    this.clearPlace(dt);
    if (O.p >= O.bayEnd - 0.05) {
      if (O.bayEnd >= R.total - 0.1) {   // end of this line
        const left = foes.filter(f => !f.dugout || !O.doneDug.has(f.dugout));
        if (!left.length) return this.regroup(T);
        // defenders left elsewhere in the system: the next line
        this.endClear(); this.order = null; return this.orderClearTrench(T);
      }
      O.next++; O.sc = O.next < O.corners.length ? O.corners[O.next] : O.bayEnd + 2; O.phase = 'stack'; O.waitT = 4;
    }
  },
  // support group, twice a second: per-man fire marks ahead of the assault group, the safety rule, bounds
  supportThink(O, foes) {
    const S = O.grp.s, R = O.route, g = this.game; if (!S.length) return;
    const A = O.grp.a, pA = Math.max(0, O.p);
    // safety: no man of the fire group engages a target near the assault group, or with them in his line of fire
    const guard = O.guard ||= (s => t => {
      for (const a of O.grp.a) {
        if (Math.hypot(t.pos.x - a.pos.x, t.pos.z - a.pos.z) < 12) return true;
        const vx = t.pos.x - s.pos.x, vz = t.pos.z - s.pos.z, L2 = vx * vx + vz * vz || 1, k = THREE.MathUtils.clamp(((a.pos.x - s.pos.x) * vx + (a.pos.z - s.pos.z) * vz) / L2, 0, 1);
        if (Math.hypot(s.pos.x + vx * k - a.pos.x, s.pos.z + vz * k - a.pos.z) < 3) return true;
      }
      return false;
    });
    for (const s of S) s.fireGuard ||= guard(s);
    if (O.phase === 'move' && O.t < 6) return;
    // fire marks: 12-38 m beyond the point man along the trench (lifted once that window runs off the end)
    const w0 = (O.phase === 'move' ? 0 : pA) + 12, w1 = Math.min(R.total, w0 + 26);
    if (!O.lifted && w0 > R.total - 1) this.liftFire(O, 'assault group at the end of the trench');
    if (!O.lifted) {
      const marks = foes.filter(f => !f.dugout).map(f => [routeProject(R, f.pos.x, f.pos.z), f]).filter(([pr]) => pr.d < 5 && pr.s >= w0 && pr.s <= w1 + 4).map(([, f]) => [f.pos.x, f.pos.z]);
      S.forEach((s, i) => {
        let p = marks.length ? marks[i % marks.length] : null;
        if (!p) { const a = routeAt(R, w0 + (w1 - w0) * (i + 0.5) / S.length); p = [a[0], a[1]]; }
        if (A.some(a => Math.hypot(a.pos.x - p[0], a.pos.z - p[1]) < 10)) { s.fireAt = null; return; }
        (s.fireAt ||= { p: new THREE.Vector3(), until: 0 }).p.set(p[0], 0.4, p[1]); s.fireAt.until = g.time + 1.2;
      });
    }
    // bounds: keep abreast of the assault, half the group at a time (the MG half last), the other half firing
    if (O.phase === 'move' || O.supS == null) return;
    const moving = S.filter(s => (s.path && s.pathI < s.path.length) || s.pathReq).length;
    const want = O.lifted ? R.total : Math.min(R.total, pA + 8);
    if (moving === 0 && want - O.supS > 10) {
      const halves = [S.filter(s => s.weaponKey !== 'pkm' && (S.indexOf(s) % 2 === 0)), S.filter(s => s.weaponKey === 'pkm' || S.indexOf(s) % 2 === 1)].filter(h => h.length);
      const h = halves[O.bound++ % halves.length];
      this.supportMove(O, S.length < 3 ? S : h, Math.min(R.total, O.supS + Math.min(16, want - O.supS)));
    }
  },
  // info panel lines: [assault group, fire group]
  clearStatus() {
    const O = this.order; if (!O?.v6) return ['Clearing', ''];
    const A = O.grp.a.length, S = O.grp.s.length, bays = Math.max(1, O.corners.length), bay = Math.min(bays, O.next + 1);
    const a = O.phase === 'move' ? `assault group (${A}) moving to the trench end` : O.phase === 'dugout' ? `assault group (${A}) clearing a dugout` : O.phase === 'bang' ? `assault group (${A}) - grenade, bay ${bay}/${bays}` : `assault group (${A}) clearing bay ${bay}/${bays}`;
    const f = !S ? '' : O.lifted ? `${S} men - fire lifted, overwatch` : O.grp.s.some(s => s.fireAt) ? `${S} men suppressing ahead of the assault` : `${S} men moving to a fire position`;
    return [a, f];
  },
  liftFire(O, why) {
    if (O.lifted) return; O.lifted = true;
    for (const s of O.grp.s) s.fireAt = null;
    if (this.side === 'player' && O.grp.s.length) this.game.hud?.alert(`${this.name}: fire group lifting fire (${why})`);
  },
  endClear() { for (const s of this.soldiers) { s.fireAt = null; s.fireGuard = null; s.clearRole = null; } },
  regroup(T) {
    const O = this.order; if (O) O.phase = 'done';
    this.endClear(); this.order = null; this.run = false;
    if (this.side === 'player') this.game.hud?.alert(`${this.name}: trench cleared - regrouping in the trench`, 'good');
    this.orderTrench(T);
  },
  // the file: point man at O.p, cover man 1.2 m behind him, the rest every 1.7 m; men not yet in wait outside the entry
  clearPlace(dt) {
    const O = this.order, R = O.route, tmp = [0, 0];
    O.file.forEach((s, k) => {
      const back = k === 0 ? 0 : 1.2 + (k - 1) * 1.7, sp = O.p - back, at = routeAt(R, sp, tmp);
      if (sp < -0.5) { // still outside, waiting his turn at the entry
        const d = 1.2 - sp, x = R.pts[0][0] + Math.sin(O.out) * Math.min(d, 8), z = R.pts[0][1] + Math.cos(O.out) * Math.min(d, 8);
        if (near([s.pos.x, s.pos.z], [x, z]) > 0.8 && !(s.path && s.pathI < s.path.length)) { s.path = [[x, z]]; s.pathI = 0; s.goal = [x, z]; }
      } else if (near([s.pos.x, s.pos.z], at) > 0.35) { s.path = [[at[0], at[1]]]; s.pathI = 0; s.goal = [at[0], at[1]]; }
      s.goalHeading = at.dir; s.stance = 'crouch';
    });
  },
  fragDugout(s, d) {
    const g = this.game; s.grenades--;
    if (g.camDist(s.pos) < 80) g.sfx('grenade_pin', s.pos);
    const to = new THREE.Vector3(d.door[0] + d.dir[0] * 3.4, -1.2, d.door[1] + d.dir[1] * 3.4);
    g.combat.startThrow(s, to, { speed: 9, style: 'low', extra: { dugout: d } });   // v7: underhand lob into the entrance
  },
};

// explosions next to trenches: shelling sends the garrison to its dugouts; a blast in a dugout (grenade through the
// entrance, a direct hit on the roof) hits everyone sheltering inside
export function trenchBlast(game, at, power, owner) {
  for (const T of game.city.trenchSystems || []) {
    const dc = Math.hypot(at.x - T.center[0], at.z - T.center[1]);
    if (dc > T.radius + 60) continue;
    // remember who is shelling (so a garrison doesn't dive for cover from its own side's fire)
    const side = owner?.side ?? owner?.squad?.side ?? game.combat.blastSide ?? null;
    if (power >= 1.2 && dc < T.radius + 35) { T.shelledT = game.time; T.shelledBy = side; }
    for (const d of T.dugouts) {
      if (!d.occupants.size) continue;
      const dCh = Math.hypot(at.x - d.x, at.z - d.z), dDoor = Math.hypot(at.x - d.door[0], at.z - d.door[1]);
      const k = dCh < 3.4 ? 1 : dDoor < 2.0 ? 0.7 : (power >= 2.2 && dCh < 6) ? 0.45 : 0;
      if (!k) continue;
      const confined = power < 1 ? 1.8 : 1;   // a hand grenade inside a closed log dugout is murderous
      for (const s of [...d.occupants]) if (s.alive && Math.random() < 0.35 + k * 0.6) game.combat.hitSoldier(s, { dmg: [70 * k * confined, 170 * k * confined], type: 'blast' }, at, true, owner);
      for (const s of [...d.occupants]) if (!s.effective) { d.occupants.delete(s); s.dugout = null; s.inside = null; s.pos.set(d.door[0] + d.dir[0] * 2.6, -1.7, d.door[1] + d.dir[1] * 2.6); }
    }
  }
}
