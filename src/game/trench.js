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
    if (this.mounted) this.dismount();
    this.leaveBuilding();
    const men = this.effective.filter(s => !s.dragging);
    const c = this.center();
    const free = T.slots.filter(sl => !sl.occupant || !sl.occupant.effective);
    if (!free.length) { if (this.side === 'player') this.game.hud?.alert('Trench is fully manned', 'bad'); return; }
    // a contiguous stretch of the trench nearest the squad: the n positions closest to the nearest free one
    const anchor = free.reduce((a, sl) => (Math.hypot(sl.x - c.x, sl.z - c.z) < Math.hypot(a.x - c.x, a.z - c.z) ? sl : a));
    const pick = free.slice().sort((p, q) => Math.hypot(p.x - anchor.x, p.z - anchor.z) - Math.hypot(q.x - anchor.x, q.z - anchor.z)).slice(0, men.length);
    // machine gunner -> covered MG cell or a bay; RPG -> a bay; the rest fill in
    const order = men.slice().sort((a, b) => (b.weaponKey === 'pkm' ? 2 : b.weaponKey === 'rpg7' ? 1 : 0) - (a.weaponKey === 'pkm' ? 2 : a.weaponKey === 'rpg7' ? 1 : 0));
    const rank = sl => (sl.kind === 'mg' ? 2 : sl.kind === 'bay' ? 1 : 0);
    this.order = { type: 'trench', trench: T }; this.trench = T;
    // a captured trench faces the wrong way: fight from the rear wall (parados) toward the enemy instead
    let ex = 0, ez = this.side === 'player' ? -1 : 1, bd = 1e9;
    for (const q of this.game.squads) if (q.side !== this.side && !q.destroyed && q.effective.length) { const qc = q.center(), d = Math.hypot(qc.x - c.x, qc.z - c.z); if (d < bd && d < 400) { bd = d; ex = qc.x - c.x; ez = qc.z - c.z; } }
    const flip = (T.front[0] * ex + T.front[1] * ez) / (Math.hypot(ex, ez) || 1) < -0.25;
    if (flip) for (let i = pick.length - 1; i >= 0; i--) if (pick[i].kind !== 'line') pick.splice(i, 1);   // the firing cells point the wrong way
    this.trenchFlip = flip;
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
      s.goal = [sl.x, sl.z]; s.goalHeading = flip ? Math.atan2(-sl.fx, -sl.fz) : Math.atan2(sl.fx, sl.fz);
      s.speedMul = 0.9 + Math.random() * 0.2; s.startDelay = Math.random() * 0.6;
      this.game.requestPath(s, s.pos.x, s.pos.z, sl.x, sl.z, 0.45);
    }
    if (this.side === 'player') this.game.hud?.alert(`${this.name}: occupying the trench`);
  },
  leaveTrench() {
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
      s.goalHeading = this.trenchFlip ? Math.atan2(-s.trenchSlot.fx, -s.trenchSlot.fz) : Math.atan2(s.trenchSlot.fx, s.trenchSlot.fz);
    }
  },
  // ------------------------------------------------------------------------------------------ trench clearing
  orderClearTrench(T) {
    if (this.routing || !T) return;
    if (this.mounted) this.dismount();
    this.leaveBuilding();
    const g = this.game, enemy = this.side === 'player' ? 'enemy' : 'player', c = this.center();
    const foes = trenchMen(g, T, enemy);
    // the line the defenders are in; enter it from the end nearest to us
    let line = T.lines[0], bestN = -1;
    for (const l of T.lines) { const r = routeOf(l), n = foes.filter(f => routeProject(r, f.pos.x, f.pos.z).d < 6 || (f.dugout && T.dugouts.includes(f.dugout))).length; if (n > bestN) { bestN = n; line = l; } }
    if (near(line[line.length - 1], [c.x, c.z]) < near(line[0], [c.x, c.z])) line = line.slice().reverse();
    const route = routeOf(line);
    const out = Math.atan2(line[0][0] - line[1][0], line[0][1] - line[1][1]);   // outward past the entry end
    const file = this.effective.filter(s => !s.dragging).sort((a, b) => near([a.pos.x, a.pos.z], line[0]) - near([b.pos.x, b.pos.z], line[0]));
    // assault squads lead with the grenadiers / SMGs; everyone else: the leader second
    this.order = { type: 'clear', trench: T, route, p: 0, phase: 'approach', waitT: 0, corner: 1, doneDug: new Set(), file, out };
    this.trench = null;
    file.forEach((s, k) => {
      const d = 1.2 + k * 1.6, x = line[0][0] + Math.sin(out) * d, z = line[0][1] + Math.cos(out) * d;
      const [gx, gz] = g.nav.nearestFree(x, z, 0.4, 4);
      s.goal = [gx, gz]; s.goalHeading = out + Math.PI; s.startDelay = k * 0.2; g.requestPath(s, s.pos.x, s.pos.z, gx, gz, 0.45);
    });
    this.run = true;
    if (this.side === 'player') g.hud?.alert(`${this.name}: clearing the trench`);
  },
  // every frame while clearing
  clearTick(dt) {
    const O = this.order, g = this.game, T = O.trench, R = O.route, enemy = this.side === 'player' ? 'enemy' : 'player';
    O.file = O.file.filter(s => s.effective && !s.dragging);
    if (!O.file.length) { this.order = null; return; }
    const foes = trenchMen(g, T, enemy);
    const lead = O.file[0];
    if (O.phase === 'approach') {
      const atEnd = near([lead.pos.x, lead.pos.z], R.pts[0]) < 4.5, gathered = O.file.filter(s => near([s.pos.x, s.pos.z], R.pts[0]) < 10).length >= Math.min(3, O.file.length);
      if ((atEnd && gathered) || (O.appT = (O.appT || 0) + dt) > 25) { O.phase = 'advance'; this.run = false; }
      return;
    }
    O.waitT -= dt;
    const thrower = O.file.slice(0, 3).find(s => (s.grenades ?? 0) > 0 && !(s.throwT > 0));
    // defenders ahead (in the trench within ~15 m of the point, or around the next bend)
    let ahead = null, da = 1e9;
    for (const f of foes) { if (f.dugout) continue; const pr = routeProject(R, f.pos.x, f.pos.z); if (pr.d < 4 && pr.s > O.p - 1 && pr.s - O.p < da) { da = pr.s - O.p; ahead = f; } }
    if (O.phase === 'dugout') {
      const d = O.dug, inside = [...d.occupants].filter(s => s.effective && s.squad.side === enemy);
      if (O.waitT > 0) return this.clearPlace(dt, true);
      if (inside.length && O.frags < 2 && thrower) { this.fragDugout(thrower, d); O.frags++; O.waitT = 3.2; return this.clearPlace(dt, true); }
      // survivors after the grenades: the point man goes in after them (short, violent exchange)
      for (const s of inside) if (Math.random() < 0.75) g.combat.hitSoldier(s, lead.weapon, lead.pos, false, lead);
      for (const s of inside) if (s.effective && Math.random() < 0.3) g.combat.hitSoldier(lead, s.weapon, s.pos, false, s);
      if (inside.some(s => s.effective) && (O.dugTries = (O.dugTries || 0) + 1) < 4) { O.waitT = 1.5; return this.clearPlace(dt, true); }
      O.doneDug.add(d); O.phase = 'advance'; O.dug = null; O.dugTries = 0; return;
    }
    if (O.phase === 'wait') { if (O.waitT <= 0) O.phase = 'advance'; return this.clearPlace(dt, true); }
    // a dugout entrance at the point: grenade it if anyone is in there (assault squads frag every dugout)
    for (const d of T.dugouts) {
      if (O.doneDug.has(d)) continue;
      const pr = routeProject(R, d.door[0], d.door[1]); if (pr.d > 4 || pr.s > O.p + 1.5) continue;
      const occupied = [...d.occupants].some(s => s.effective && s.squad.side === enemy);
      if (occupied || (this.assault && thrower && Math.random() < 0.85)) { O.phase = 'dugout'; O.dug = d; O.frags = 0; O.waitT = 0.8; return this.clearPlace(dt, true); }
      O.doneDug.add(d);
    }
    if (ahead && da < 15) {
      // grenade around the bend, wait for the bang, then push; without grenades: hold and shoot it out
      if (thrower && (O.lastFrag ?? -99) < g.time - 4) {
        O.lastFrag = g.time; g.combat.throwGrenade(thrower, ahead); O.phase = 'wait'; O.waitT = 3.0;
        if (g.camDist(thrower.pos) < 80) g.sfx('grenade_throw', thrower.pos);
        return this.clearPlace(dt, true);
      }
      if (da < 6) return this.clearPlace(dt, true);
    }
    // pie each corner: a short pause before moving round it
    if (O.corner < R.cum.length - 1 && O.p >= R.cum[O.corner] - 0.8) { O.corner++; O.phase = 'wait'; O.waitT = 0.7 + Math.random() * 0.6; return this.clearPlace(dt, true); }
    O.p = Math.min(R.total, O.p + dt * (this.assault ? 1.35 : 1.1) * (ahead && da < 25 ? 0.6 : 1));
    this.clearPlace(dt, false);
    if (O.p >= R.total - 0.1 && !foes.some(f => routeProject(R, f.pos.x, f.pos.z).d < 6 || f.dugout)) {
      this.order = null;
      if (this.side === 'player') g.hud?.alert(`${this.name}: trench cleared`, 'good');
      this.orderTrench(T);
    } else if (O.p >= R.total - 0.1 && !ahead) {
      // the end of this stretch, defenders left elsewhere in the system: sweep the next stretch
      const left = foes.filter(f => !f.dugout || !O.doneDug.has(f.dugout));
      if (left.length) this.orderClearTrench(T); else { this.order = null; this.orderTrench(T); }
    }
  },
  // the file: man k holds k * 1.7 m behind the point, crouched, facing down the trench
  clearPlace(dt, hold) {
    const O = this.order, R = O.route, tmp = [0, 0];
    O.file.forEach((s, k) => {
      const at = routeAt(R, O.p - k * 1.7, tmp);
      if (O.p - k * 1.7 < -0.5) { // still outside, waiting his turn at the entry
        const d = 1.2 - (O.p - k * 1.7), x = R.pts[0][0] + Math.sin(O.out) * Math.min(d, 6), z = R.pts[0][1] + Math.cos(O.out) * Math.min(d, 6);
        if (near([s.pos.x, s.pos.z], [x, z]) > 0.8 && !(s.path && s.pathI < s.path.length)) { s.path = [[x, z]]; s.pathI = 0; s.goal = [x, z]; }
      } else if (near([s.pos.x, s.pos.z], at) > 0.35) { s.path = [[at[0], at[1]]]; s.pathI = 0; s.goal = [at[0], at[1]]; }
      s.goalHeading = at.dir; s.stance = 'crouch';
    });
  },
  fragDugout(s, d) {
    const g = this.game; s.grenades--; s.throwT = 1.2; s.fireCd = 1.5;
    if (g.camDist(s.pos) < 80) g.sfx('grenade_pin', s.pos);
    const to = new THREE.Vector3(d.door[0] + d.dir[0] * 3.4, -1.2, d.door[1] + d.dir[1] * 3.4);
    g.combat.projectiles.push({ kind: 'grenade', pos: s.pos.clone().setY(s.pos.y + 1.3), from: s.pos.clone().setY(s.pos.y + 1.3), target: to, t: null, speed: 9, owner: s, side: this.side, fuse: 0, arc: true, dugout: d });
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
