import * as THREE from 'three';
import { Soldier } from './soldier.js';
import { SQUAD_ROLES, ASSAULT_ROLES, TUNING, WEAPONS } from '../config.js';

let NEXT_ID = 1;
const V = new THREE.Vector3();

// An infantry squad (8 men). Owns orders, formation, morale and casualty handling.
export class Squad {
  constructor(game, side, faction, name, kind = 'mech') {
    this.game = game; this.id = NEXT_ID++; this.side = side; this.faction = faction; this.name = name;
    this.type = 'squad'; this.kind = kind; this.assault = kind === 'assault';
    this.soldiers = (this.assault ? ASSAULT_ROLES : SQUAD_ROLES).map((r, i) => new Soldier(this, i, r, faction, game.scene));
    this.morale = 82; this.order = null; this.holdFire = false; this.run = false;
    this.carrier = null; this.mounted = false; this.building = null; this.routing = false;
    this.underFireT = 99; this.flankDirs = []; this.selected = false; this.spotted = side === 'player';
    this.facing = 0; this.lastPos = new THREE.Vector3(); this.thinkT = Math.random();
    this.stats = { kills: 0, kia: 0, wia: 0 };
    this.supplyRpg = 0;
  }
  get alive() { return this.soldiers.filter(s => s.alive); }
  get effective() { return this.soldiers.filter(s => s.effective); }
  get leader() { return this.soldiers.find(s => s.role.leader && s.effective) || this.soldiers.find(s => s.role.second && s.effective) || this.effective[0]; }
  get destroyed() { return this.effective.length === 0; }
  center(out = new THREE.Vector3()) {
    if (this.mounted && this.carrier) return out.copy(this.carrier.pos);
    const e = this.effective.length ? this.effective : this.alive; if (!e.length) return out.copy(this.lastPos);
    out.set(0, 0, 0); for (const s of e) out.add(s.pos); out.multiplyScalar(1 / e.length); this.lastPos.copy(out); return out;
  }
  ammoFrac() {
    let have = 0, max = 0;
    for (const s of this.effective) { const w = s.weapon; have += s.mags * w.mag + s.inMag; max += (s.role.mags + 1) * w.mag; }
    return max ? have / max : 0;
  }
  moraleState() {
    if (this.routing) return 'ROUTING';
    const m = this.morale; return m >= 60 ? 'STEADY' : m >= 45 ? 'HOLDING' : m >= 25 ? 'SHAKEN' : 'WAVERING';
  }
  // ------------------------------------------------------------ placement & orders
  placeAt(x, z, facing) {
    this.facing = facing;
    const slots = this.formationSlots(x, z, facing, 16);
    this.soldiers.forEach((s, i) => { s.pos.set(slots[i][0], 0, slots[i][1]); s.heading = facing; s.sync(); });
  }
  formationSlots(x, z, facing, width) {
    const nav = this.game.nav, n = this.effective.length || 8;
    const right = [Math.cos(facing), -Math.sin(facing)], fwd = [Math.sin(facing), Math.cos(facing)];
    const perRank = width < 10 ? Math.ceil(n / 2) : n;
    const sp = Math.max(1.8, Math.min(4.2, width / Math.max(1, perRank - 1)));
    const out = [];
    for (let i = 0; i < this.soldiers.length; i++) {
      // loose, staggered line: alternate men sit forward/back, irregular spacing — never a parade-ground rank
      const rank = Math.floor(i / perRank), k = i % perRank, off = (k - (perRank - 1) / 2) * sp + (Math.random() - .5) * sp * 0.45;
      const depth = rank * 3.2 + (k % 2 ? 1.6 : -0.4) + (Math.random() - .5) * 1.8;
      let px = x + right[0] * off - fwd[0] * depth, pz = z + right[1] * off - fwd[1] * depth;
      // snap to a nearby cell offering cover toward the facing direction
      let best = null, bestS = -1;
      for (let r = 0; r <= 3.5; r += 0.9) for (let a = 0; a < 8; a++) {
        const cx = px + Math.cos(a * 0.785) * r, cz = pz + Math.sin(a * 0.785) * r, idx = nav.idx(cx, cz);
        if (!nav.passable(idx, 0.4)) continue;
        const sc = nav.coverFrom(cx, cz, cx + fwd[0] * 50, cz + fwd[1] * 50) * 2 - r * 0.25;
        if (sc > bestS) { bestS = sc; best = [cx, cz]; }
      }
      if (!best) best = nav.nearestFree(px, pz, 0.4, 8);
      out.push(best);
    }
    return out;
  }
  orderMove(x, z, facing = null, width = 18, run = false, queued = false, bound = false) {
    if (this.routing) return;
    const c = this.center();
    if (facing == null) facing = Math.atan2(x - c.x, z - c.z);
    this.leaveBuilding();
    if (this.mounted && this.carrier) { this.carrier.orderMove(x, z, facing, run); return; }
    this.order = { type: 'move', x, z, facing, width, run };
    this.run = run; this.facing = facing;
    if (this.pinned && this.side === 'player') this.game.hud?.alert(`${this.name} is pinned down — will move when the fire slackens`, 'bad');
    const slots = this.formationSlots(x, z, facing, width);
    // assign slots by lateral order to avoid crossing
    const right = [Math.cos(facing), -Math.sin(facing)];
    const men = this.alive.filter(s => s.effective && !s.dragging);
    const lat = p => p[0] * right[0] + p[1] * right[1];
    const ms = [...men].sort((a, b) => lat([a.pos.x, a.pos.z]) - lat([b.pos.x, b.pos.z]));
    const ss = slots.slice(0, ms.length).sort((a, b) => lat(a) - lat(b));
    ms.forEach((s, i) => {
      s.goal = ss[i]; s.goalHeading = facing; s.path = null;
      // individual pace and reaction time so the squad doesn't move in lockstep
      s.speedMul = 0.86 + Math.random() * 0.24; s.startDelay = s.role.leader ? 0 : 0.15 + Math.random() * 0.9;
      // fire-team bounding: team B (odd) covers and waits until team A has reached its positions
      if (bound && i % 2 === 1 && ms.length > 3) { s.waitTeam = true; s.waitT = 9; }
      else { s.waitTeam = false; this.game.requestPath(s, s.pos.x, s.pos.z, ss[i][0], ss[i][1], 0.45); }
    });
  }
  orderGarrison(b) {
    if (this.routing) return;
    // building held by the enemy -> storm it (stack up at an entrance, grenades, room clearing)
    if (b.slots.some(sl => sl.occupant && sl.occupant.squad.side !== this.side && sl.occupant.effective)) return this.orderStorm(b);
    if (this.mounted) this.dismount();
    this.leaveBuilding();
    const free = b.slots.filter(sl => !sl.occupant && !sl.panel.gone);
    const men = this.effective.filter(s => !s.dragging);
    if (!free.length) { this.game.hud?.alert(`${b.kind === 'school' ? 'School' : 'Building'} is full`, 'bad'); return; }
    this.order = { type: 'garrison', building: b };
    this.building = b;
    // fill slots nearest to the threat (north for defenders) first
    free.sort((p, q) => this.threatScore(b, q) - this.threatScore(b, p));
    men.forEach((s, i) => {
      const sl = free[i % free.length]; if (i >= free.length) return;
      sl.occupant = s; s.slotRef = sl;
      const ent = b.entrances.reduce((a, e) => (e.distanceToSquared(s.pos) < a.distanceToSquared(s.pos) ? e : a));
      s.goal = [ent.x, ent.z]; s.goalHeading = null; this.game.requestPath(s, s.pos.x, s.pos.z, ent.x, ent.z, 0.45);
    });
  }
  orderStorm(b) {
    if (this.mounted) this.dismount();
    this.leaveBuilding();
    const c = this.center();
    const ent = b.entrances.slice().sort((p, q) => p.distanceTo(c) - q.distanceTo(c))[0];
    this.order = { type: 'storm', building: b, entrance: ent, t: 0 };
    const f = Math.atan2(ent.x - c.x, ent.z - c.z);
    this.effective.forEach((s, i) => {
      const side = (i % 2 ? 1 : -1) * (1.2 + (i >> 1) * 0.9); // stack along the wall either side of the door
      const r = new THREE.Vector3(Math.cos(b.rot), 0, -Math.sin(b.rot));
      const [gx, gz] = this.game.nav.nearestFree(ent.x + r.x * side, ent.z + r.z * side, 0.4, 6);
      s.goal = [gx, gz]; s.goalHeading = f; this.game.requestPath(s, s.pos.x, s.pos.z, gx, gz, 0.45);
    });
    this.run = true;
    if (this.side === 'player') this.game.hud?.alert(`${this.name}: storming the building`);
  }
  threatScore(b, sl) { const o = b.outward(sl.panel); const enemyDir = this.side === 'player' ? -1 : 1; return o.z * enemyDir - sl.panel.floor * 0.1 + (sl.panel.state >= 2 ? -0.5 : 0); }
  leaveBuilding() {
    if (!this.building) return;
    const b = this.building;
    for (const s of this.soldiers) if (s.slotRef) {
      s.slotRef.occupant = null; s.slotRef = null;
      if (s.inBuilding) { const ent = b.entrances.reduce((a, e) => (e.distanceToSquared(s.pos) < a.distanceToSquared(s.pos) ? e : a)); s.pos.set(ent.x, 0, ent.z); s.inside = null; }
    }
    this.building = null;
  }
  orderMount(v) {
    if (this.routing || !v || v.destroyed) return;
    this.leaveBuilding();
    this.order = { type: 'mount', vehicle: v }; this.carrier = v;
    for (const s of this.alive) { if (s.state === 'dead') continue; const d = v.doorPos(s.idx); s.goal = [d.x, d.z]; this.game.requestPath(s, s.pos.x, s.pos.z, d.x, d.z, 0.45); }
  }
  dismount(facing) {
    const v = this.carrier; if (!v || !this.mounted) return;
    this.mounted = false; v.passengers = null;
    facing ??= v.heading;
    this.soldiers.forEach((s, i) => {
      if (s.inside === 'ride' && s.seat) {
        // jump down off the deck on the seat's side
        const w = v.seatWorld(s.seat.i); const out = new THREE.Vector3(Math.sin(w.heading), 0, Math.cos(w.heading));
        const side = new THREE.Vector3(w.pos.x - v.pos.x, 0, w.pos.z - v.pos.z); if (side.lengthSq() > 0.01 && out.dot(side) < 0) out.negate();
        s.pos.set(w.pos.x + out.x * 1.6, 0, w.pos.z + out.z * 1.6); s.heading = Math.atan2(out.x, out.z); s.jumpT = 1.1;
        s.inside = null; s.seat = null; return;
      }
      if (s.inside !== 'btr' || s.state === 'evac') return;
      const d = v.doorPos(i, true); s.pos.set(d.x, 0, d.z); s.inside = null; s.heading = v.heading + (i % 2 ? 1.57 : -1.57);
    });
    const back = v.pos.clone().addScaledVector(new THREE.Vector3(Math.sin(v.heading), 0, Math.cos(v.heading)), -6);
    this.order = null;
    const slots = this.formationSlots(back.x, back.z, facing, 18);
    this.effective.forEach((s, i) => { s.goal = slots[i]; s.goalHeading = facing; this.game.requestPath(s, s.pos.x, s.pos.z, slots[i][0], slots[i][1], 0.45); });
    this.game.sfx('hatch', v.pos);
  }
  // ride on top of the vehicle (tank/BTR desant). Overflow rides inside.
  board(v, instant = false) {
    const seats = v.seatCount(); let k = 0;
    for (const s of this.soldiers) {
      if (s.state === 'dead' || s.state === 'evac' || s.aboard) continue;
      if (s.state === 'critical' || s.state === 'stable') { this.evacuate(s); continue; }
      if (k < seats) { s.inside = 'ride'; s.seat = { i: k }; s.seatType = v.seatType(k); k++; }
      else { s.inside = 'btr'; }
      s.path = null; s.goal = null; s.target = null;
      if (instant) { const w = v.seatWorld(s.seat ? s.seat.i : 0); s.pos.copy(w.pos); s.heading = w.heading; }
    }
    this.mounted = true; this.carrier = v; v.passengers = this; this.order = null;
  }
  orderAttack(target) {
    if (this.routing) return;
    this.order = { type: 'attack', target };
    const tc = target.center ? target.center() : target.pos;
    const c = this.center(); const d = c.distanceTo(tc);
    const range = 160;
    if (d > range) { const p = c.clone().lerp(tc, 1 - range * 0.85 / d); this.orderMove(p.x, p.z, Math.atan2(tc.x - p.x, tc.z - p.z), 18, this.run); this.order.attack = target; }
    this.focus = target;
  }
  halt() { this.order = null; for (const s of this.alive) { s.path = null; s.goal = null; } }
  // ------------------------------------------------------------ morale
  addMorale(d, why) { if (this.destroyed) return; this.morale = THREE.MathUtils.clamp(this.morale + d, 0, 100); }
  onCasualty(s, killed) {
    this.addMorale(killed ? -9 : -6);
    if (s.role.leader) { this.addMorale(-14); if (this.side === 'player') this.game.hud?.alert(`${this.name}: squad leader ${killed ? 'killed' : 'down'}`, 'bad'); }
    // nearby friendly squads feel it too
    for (const o of this.game.unitsOf(this.side)) if (o !== this && o.type === 'squad' && o.center().distanceTo(s.pos) < 40) o.addMorale(-2.5);
    if (killed) this.stats.kia++; else this.stats.wia++;
  }
  updateMorale(dt) {
    const e = this.effective; if (!e.length) return;
    let supp = 0; for (const s of e) supp += s.suppression; supp /= e.length;
    this.underFireT += dt;
    let d = 0;
    d -= supp * 0.035;
    if (this.ammoFrac() < 0.15) d -= 0.6;
    if (this.flankDirs.length >= 2) { const a = this.flankDirs; let spread = 0; for (let i = 1; i < a.length; i++) { let x = Math.abs(a[i] - a[0]) % (Math.PI * 2); if (x > Math.PI) x = Math.PI * 2 - x; spread = Math.max(spread, x); } if (spread > 1.6) d -= 0.9; }
    this.flankDirs.length = 0;
    // PINNED: sustained heavy fire on most of the squad
    let heavy = 0; for (const s of e) if (s.suppression > 60) heavy++;
    if (!this.pinned && (supp > 60 || heavy >= Math.ceil(e.length * 0.7)) && !this.mounted) { this.pinned = true; if (this.side === 'player') this.game.hud?.alert(`${this.name} is PINNED DOWN`, 'bad'); }
    else if (this.pinned && supp < 32 && heavy <= Math.floor(e.length * 0.3)) this.pinned = false;
    if (this.mounted) this.pinned = false;
    if (this.underFireT > 6) {
      let r = TUNING.moraleRegen * (this.leader?.role.leader ? 1.4 : 1);
      if (this.building) r += 0.5;
      const c = this.center();
      for (const u of this.game.unitsOf(this.side)) if (u.type === 'vehicle' && !u.destroyed && u.pos.distanceTo(c) < 30) { r += 0.6; break; }
      for (const o of this.game.objectives) if (o.owner === this.side && Math.hypot(o.x - c.x, o.z - c.z) < 30) r += 0.4;
      d += r;
    }
    // local odds
    if (e.length <= 3) d -= 0.5;
    this.morale = THREE.MathUtils.clamp(this.morale + d * dt, 0, 100);
    if (!this.routing && this.morale < TUNING.routThreshold) this.startRout();
    else if (this.routing && this.morale > 42 && this.underFireT > 8) { this.routing = false; this.order = null; this.morale = 45; if (this.side === 'player') this.game.hud?.alert(`${this.name} has rallied`, 'good'); }
  }
  startRout() {
    this.routing = true; this.leaveBuilding();
    if (this.side === 'player') { this.game.hud?.alert(`${this.name} is ROUTING!`, 'bad'); this.game.sfx('ui_alert'); }
    for (const o of this.game.unitsOf(this.side)) if (o !== this && o.type === 'squad' && o.center().distanceTo(this.center()) < 45) o.addMorale(-6);
    const sp = this.game.rallyPoint(this.side);
    const c = this.center(); const f = Math.atan2(c.x - sp[0], c.z - sp[1]);
    const slots = this.formationSlots(sp[0], sp[1], f, 14);
    this.effective.forEach((s, i) => { s.goal = slots[i]; s.goalHeading = f; this.game.requestPath(s, s.pos.x, s.pos.z, slots[i][0], slots[i][1], 0.45); });
    this.order = { type: 'rout' };
  }
  // ------------------------------------------------------------ per-frame
  update(dt) {
    if (this.mounted) { this.updateRiders(dt); this.updateMorale(dt); this.resupplyTick(dt); return; }
    this.updateMorale(dt);
    this.thinkT -= dt;
    if (this.thinkT <= 0) { this.thinkT = 0.5; this.think(); }
    for (const s of this.soldiers) this.updateSoldier(s, dt);
    this.resupplyTick(dt);
  }
  updateRiders(dt, frozen = false) {
    const v = this.carrier, g = this.game;
    for (const s of this.soldiers) {
      s.suppression = Math.max(0, s.suppression - TUNING.suppressionDecay * dt);
      if (s.inside === 'btr' || s.state === 'evac') { if (v) s.pos.copy(v.pos); s.sync(); continue; }
      if (s.inside === 'ride' && v) {
        if (!s.effective) { // hit while riding: falls off the vehicle
          const w = v.seatWorld(s.seat.i); s.inside = null; s.seat = null; s.pos.set(w.pos.x + (Math.random() - .5) * 3, 0, w.pos.z + (Math.random() - .5) * 3);
        } else {
          const w = v.seatWorld(s.seat.i); s.pos.copy(w.pos); s.heading = s.target ? Math.atan2(s.target.pos.x - s.pos.x, s.target.pos.z - s.pos.z) : w.heading;
          s.vel.set(Math.sin(v.heading) * v.speed, 0, Math.cos(v.heading) * v.speed); s.stance = 'crouch';
          if (!frozen && !this.routing && !this.holdFire) g.combat.soldierCombat(s, dt); else s.target = null;
        }
      }
      if (s.inside === 'ride') { s.animate(dt, g.camDist(s.pos)); s.sync(); }
      else this.updateSoldier(s, dt);
    }
    // whole squad jumps off when the vehicle is hit hard or brews up
    if (!frozen && v && (v.destroyed || v.burning > 0)) this.dismount(v.heading + Math.PI);
    this.underFireT += dt;
  }
  think() {
    // fire teams: release the covering half once the moving half has arrived
    const waiting = this.soldiers.filter(s => s.waitTeam && s.effective);
    if (waiting.length) {
      const movers = this.effective.filter(s => !s.waitTeam && s.path && s.pathI < s.path.length);
      for (const s of waiting) { s.waitT -= 0.5; if (!movers.length || s.waitT <= 0) { s.waitTeam = false; if (s.goal) this.game.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], 0.45); } }
    }
    // storming a building
    if (this.order?.type === 'storm') this.game.combat.stormTick(this, 0.5);
    // mounting completion
    if (this.order?.type === 'mount') {
      const v = this.order.vehicle;
      if (!v || v.destroyed) { this.order = null; for (const s of this.soldiers) if (s.inside === 'btr') s.inside = null; return; }
      const need = this.alive.filter(s => s.state !== 'dead' && !s.inside);
      for (const s of need) if (s.pos.distanceTo(v.pos) < v.def.radius + 3) {
        if (s.state === 'critical' || s.state === 'stable') { this.evacuate(s); continue; }
        if (s.dragging) { this.evacuate(s.dragging); s.dragging = null; }
        s.arrived = true; s.path = null;
      }
      if (this.effective.every(s => s.arrived || s.inside)) {
        for (const s of this.soldiers) s.arrived = false;
        this.board(v, true);
        if (this.side === 'player') this.game.sfx('hatch', v.pos);
      }
    }
    // pending wounded -> assign a buddy to drag them to cover / the carrier
    if (!this.routing) for (const w of this.soldiers) {
      if (w.state !== 'critical' || w.dragger) continue;
      const helpers = this.effective.filter(s => !s.dragging && !s.inside);
      if (!helpers.length) break;
      helpers.sort((a, b) => (b.role.medic ? 20 : 0) - (a.role.medic ? 20 : 0) + a.pos.distanceTo(w.pos) - b.pos.distanceTo(w.pos));
      const h = helpers[0]; if (h.pos.distanceTo(w.pos) > 60) continue;
      h.dragging = w; h.dragPhase = 'reach'; h.goal = [w.pos.x, w.pos.z]; this.game.requestPath(h, h.pos.x, h.pos.z, w.pos.x, w.pos.z, 0.45);
    }
    this.seekCover();
    // stance from situation
    for (const s of this.effective) {
      if (s.aboard) continue;
      if (s.inBuilding) { s.stance = s.suppression > 60 ? 'crouch' : (s.target ? 'stand' : 'crouch'); continue; }
      const moving = s.path && s.pathI < s.path.length;
      if (moving) s.stance = (this.underFireT < 3 && !this.run && !this.routing) ? 'crouch' : 'stand';
      else {
        const threat = s.target ? s.target.pos : null;
        const cov = threat ? this.game.nav.coverFrom(s.pos.x, s.pos.z, threat.x, threat.z) : 0;
        const lowc = this.game.nav.low[this.game.nav.idx(s.pos.x, s.pos.z)] === 1;
        if ((s.suppression > 70 || this.pinned) && cov < 0.5 && !lowc) s.stance = 'prone';
        else if (s.suppression > 70 || this.pinned) s.stance = 'crouch';
        else if (cov > 0.5) s.stance = lowc ? 'crouch' : (s.weaponKey === 'rpg7' ? 'stand' : 'crouch');
        else if (this.underFireT < 4) s.stance = s.weaponKey === 'pkm' ? 'prone' : 'crouch';
        else s.stance = s.weaponKey === 'pkm' && s.target ? 'prone' : 'stand';
      }
    }
  }
  // individual initiative: a man caught in the open while his squad is halted and taking fire scrambles to the
  // nearest real cover against his target (a few metres, never far from where he was ordered)
  seekCover() {
    if (this.mounted || this.routing || this.building || this.order?.type === 'storm' || this.order?.type === 'mount') return;
    if (this.underFireT > 2.5) return;
    const nav = this.game.nav, now = this.game.time;
    for (const s of this.effective) {
      if (s.inside || s.dragging || (s.path && s.pathI < s.path.length) || s.pathReq || s.waitTeam || !s.target || (s.coverT || 0) > now) continue;
      const tp = s.target.pos; if (nav.coverFrom(s.pos.x, s.pos.z, tp.x, tp.z) >= 0.55) continue;
      s.coverT = now + 7 + Math.random() * 4;
      const ax = s.goal ? s.goal[0] : s.pos.x, az = s.goal ? s.goal[1] : s.pos.z;
      let best = null, bs = 0.5;
      for (let r = 1.5; r <= 9; r += 1.5) for (let a = 0; a < 12; a++) {
        const x = ax + Math.cos(a / 12 * 6.283) * r, z = az + Math.sin(a / 12 * 6.283) * r, i = nav.idx(x, z);
        if (!nav.passable(i, 0.45)) continue;
        if (this.soldiers.some(o => o !== s && o.alive && Math.hypot(o.pos.x - x, o.pos.z - z) < 1.3)) continue;
        const sc = nav.coverFrom(x, z, tp.x, tp.z) - Math.hypot(x - s.pos.x, z - s.pos.z) * 0.03;
        if (sc > bs) { bs = sc; best = [x, z]; }
      }
      if (best) { s.goal = best; this.game.requestPath(s, s.pos.x, s.pos.z, best[0], best[1], 0.45); }
    }
  }
  evacuate(s) { s.state = 'evac'; s.root.visible = false; s.inside = 'btr'; this.game.stats[this.side].evac++; if (s.dragger) { s.dragger.dragging = null; s.dragger = null; } }
  abandonWounded(s) { /* left on the field; keeps bleeding */ }
  resupplyTick(dt) {
    const v = this.carrier && !this.carrier.destroyed ? this.carrier : null; if (!v || !v.supply) return;
    const near = this.mounted || this.center().distanceTo(v.pos) < 25; if (!near) return;
    this.resupT = (this.resupT || 0) + dt; if (this.resupT < 1.2) return; this.resupT = 0;
    for (const s of this.effective) {
      if (s.weaponKey === 'ak74m' && s.mags < s.role.mags && v.supply.rifle >= 30) { s.mags++; v.supply.rifle -= 30; }
      if (s.weaponKey === 'pkm' && s.mags < s.role.mags && v.supply.mg >= 100) { s.mags++; v.supply.mg -= 100; }
      if (s.weaponKey === 'rpg7' && s.mags < s.role.mags && v.supply.rpg > 0) { s.mags++; v.supply.rpg--; }
      if (s.sideKey && s.sideMags < (s.role.sideMags || 0) && v.supply.rifle >= 30) { s.sideMags++; v.supply.rifle -= 30; }
    }
  }
  updateSoldier(s, dt) {
    const g = this.game;
    s.suppression = Math.max(0, s.suppression - TUNING.suppressionDecay * dt * (s.inBuilding ? 1.4 : 1));
    // heavily suppressed: duck behind the wall / window sill, pop up for a burst, duck again
    if (s.suppression > 55 || this.pinned) {
      s.duckT = (s.duckT ?? 0) - dt;
      if (s.duckT <= 0) { s.ducking = !s.ducking; s.duckT = s.ducking ? 1.2 + s.suppression / 35 + Math.random() * 1.5 : 0.8 + Math.random() * 0.9; }
      if (s.suppression > 92) s.ducking = true;
    } else s.ducking = false;
    if (s.state === 'dead' || s.state === 'evac') { s.vel.set(0, 0, 0); s.animate(dt, g.camDist(s.pos)); s.sync(); return; }
    if (s.aboard) { s.sync(); return; }
    // bleeding
    if (s.state === 'critical') {
      s.bleed -= dt * (s.dragger && s.dragger.dragPhase === 'treat' ? 0.25 : 1);
      if (s.bleed <= 0) { s.die('death_crumple'); g.onDeath(s, null, true); }
      if (!s.dragger && s.vel.lengthSq() < 0.01 && Math.random() < dt * 0.05) { // crawl a little towards cover
        const [cx, cz] = g.nav.nearestFree(s.pos.x + (Math.random() - .5) * 4, s.pos.z + (this.side === 'player' ? 3 : -3), 0.4, 3); s.path = [[cx, cz]]; s.pathI = 0; s.crawl = true;
      }
    }
    // dragging logic (medic / buddy)
    if (s.dragging) this.dragStep(s, dt);
    // garrison: entering the building through the entrance
    if (s.slotRef && !s.inside && s.goal && Math.hypot(s.pos.x - s.goal[0], s.pos.z - s.goal[1]) < 2.2) {
      s.inside = s.slotRef; s.path = null; s.goal = null;
      const bb = s.slotRef.panel.b; bb.slotPos(s.slotRef, s.pos); s.heading = Math.atan2(bb.outward(s.slotRef.panel).x, bb.outward(s.slotRef.panel).z);
    }
    if (s.inBuilding) {
      // panel destroyed under him -> he falls back inside but keeps fighting; if the floor is gone he drops
      if (s.inside.panel.state === 3 && s.inside.panel.floor > 0 && Math.random() < dt * 0.3) { g.hitSoldier(s, { dmg: [40, 90], type: 'blast' }, s.pos, true); }
      s.vel.set(0, 0, 0);
    } else this.moveStep(s, dt);
    // facing
    let want = s.heading;
    if (s.target && s.effective && !(s.path && s.pathI < s.path.length && this.run)) want = Math.atan2(s.target.pos.x - s.pos.x, s.target.pos.z - s.pos.z);
    else if (s.vel.lengthSq() > 0.05) want = Math.atan2(s.vel.x, s.vel.z);
    else if (s.goalHeading != null) want = s.goalHeading;
    if (s.inBuilding && s.target) { const o = s.bld.outward(s.inside.panel); const base = Math.atan2(o.x, o.z); let d = angDiff(want, base); d = THREE.MathUtils.clamp(d, -1.1, 1.1); want = base + d; }
    if (s.dragging && s.dragPhase === 'drag') want = Math.atan2(-s.vel.x, -s.vel.z); // walks backwards pulling
    s.heading += THREE.MathUtils.clamp(angDiff(want, s.heading), -5 * dt, 5 * dt);
    // combat
    if (s.effective && !this.routing && !s.dragging) g.combat.soldierCombat(s, dt);
    else s.target = null;
    s.animate(dt, g.camDist(s.pos));
    s.sync();
  }
  moveStep(s, dt) {
    const g = this.game;
    if (s.jumpT > 0) { s.vel.set(0, 0, 0); return; }
    let moving = s.path && s.pathI < s.path.length;
    let speed = 0;
    // pinned down: nobody gets up and moves (except to drag a wounded mate)
    const pinned = (this.pinned || s.suppression > 88) && !s.dragging && s.state !== 'critical';
    if (moving && (pinned || (s.startDelay > 0 && (s.startDelay -= dt) > 0))) { s.vel.multiplyScalar(Math.max(0, 1 - dt * 8)); s.wdT = 0; s.wdP = null; s.pos.y = 0; return; }
    if (moving) {
      const wp = s.path[s.pathI];
      const dx = wp[0] - s.pos.x, dz = wp[1] - s.pos.z, d = Math.hypot(dx, dz);
      let base = this.run || this.routing ? TUNING.run : TUNING.walk;
      if (s.stance === 'crouch') base = Math.min(base, this.run ? TUNING.crouchRun : TUNING.crouchWalk);
      if (s.stance === 'prone') base = TUNING.crawl;
      if (this.assault) base *= 1.06;
      if (s.state === 'light' && s.legWound) base *= 0.55;
      if (s.state === 'critical') base = 0.3;
      if (s.dragging && s.dragPhase === 'drag') base = TUNING.dragSpeed;
      else base *= s.speedMul || 1;
      const ci = g.nav.idx(s.pos.x, s.pos.z); if (ci >= 0 && g.nav.cost[ci] > 2 && g.nav.cost[ci] < 255) base *= 0.7;
      // cohesion: don't outrun the squad too much
      speed = base;
      if (d < 0.4) { s.pathI++; if (s.pathI >= s.path.length) { s.path = null; s.crawl = false; } }
      else { V.set(dx / d, 0, dz / d); s.vel.lerp(V.multiplyScalar(Math.min(speed, d * 3)), Math.min(1, dt * 6)); }
    } else s.vel.multiplyScalar(Math.max(0, 1 - dt * 8));
    // separation from squadmates & vehicles (never shoves anyone into a wall)
    const nav = g.nav, free = (x, z) => { const i = nav.idx(x, z); return i >= 0 && nav.cost[i] !== 255; };
    for (const o of this.soldiers) { if (o === s || !o.alive || o.inside) continue; const dx = s.pos.x - o.pos.x, dz = s.pos.z - o.pos.z, d2 = dx * dx + dz * dz; if (d2 < 1.2 && d2 > 1e-4) { const k = (1.2 - d2) * 1.5 * dt; if (free(s.pos.x + dx * k, s.pos.z + dz * k)) { s.pos.x += dx * k; s.pos.z += dz * k; } } }
    for (const v of g.vehicles) { if (v.destroyed && !v.wreck) continue; const dx = s.pos.x - v.pos.x, dz = s.pos.z - v.pos.z, d = Math.hypot(dx, dz), r = v.def.radius + 0.9; if (d < r && d > 0.01) { const px = s.pos.x + dx / d * (r - d), pz = s.pos.z + dz / d * (r - d); if (free(px, pz)) { s.pos.x = px; s.pos.z = pz; } else if (free(s.pos.x + dz / d * (r - d), s.pos.z - dx / d * (r - d))) { s.pos.x += dz / d * (r - d); s.pos.z -= dx / d * (r - d); } } }
    // already inside a blocked cell (pushed, collapsed rubble, spawned badly): step out to the nearest free spot
    if (!free(s.pos.x, s.pos.z)) { const [fx, fz] = nav.nearestFree(s.pos.x, s.pos.z, 0.45, 8); s.pos.x = fx; s.pos.z = fz; if (s.goal) { s.path = null; g.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], 0.45); } }
    const nx = s.pos.x + s.vel.x * dt, nz = s.pos.z + s.vel.z * dt;
    if (free(nx, nz)) { s.pos.x = nx; s.pos.z = nz; }
    else if (free(nx, s.pos.z)) { s.pos.x = nx; s.vel.z *= 0.5; }      // slide along the wall
    else if (free(s.pos.x, nz)) { s.pos.z = nz; s.vel.x *= 0.5; }
    else if (moving) { s.vel.multiplyScalar(0.3); s.blockedT = (s.blockedT || 0) + dt; }
    // watchdog: wanted to move but made no progress for a while -> replan from where we stand
    if (moving) {
      s.wdT = (s.wdT || 0) + dt;
      if (s.wdT > 2.5) { const moved = s.wdP ? Math.hypot(s.pos.x - s.wdP[0], s.pos.z - s.wdP[1]) : 9; s.wdP = [s.pos.x, s.pos.z]; s.wdT = 0;
        if (moved < 0.6 && s.goal) { s.stuckN = (s.stuckN || 0) + 1; s.path = null; s.blockedT = 0;
          if (s.stuckN > 2) { const [fx, fz] = nav.nearestFree(s.pos.x + (Math.random() - .5) * 3, s.pos.z + (Math.random() - .5) * 3, 0.6, 8); s.pos.x = fx; s.pos.z = fz; }
          if (s.stuckN > 5) { s.goal = null; s.stuckN = 0; } else g.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], 0.45); }
        else if (moved >= 0.6) s.stuckN = 0; }
    } else { s.wdT = 0; s.wdP = null; }
    // footsteps (close to camera only)
    if (s.vel.lengthSq() > 1 && g.camDist(s.pos) < 35) { s.stepT = (s.stepT || 0) + dt * s.vel.length(); if (s.stepT > 1.6) { s.stepT = 0; g.sfx(Math.random() < .6 ? 'footstep_rubble' : 'footstep_gravel', s.pos, { gain: 0.5 }); } }
    s.pos.y = 0;
  }
  dragStep(s, dt) {
    const w = s.dragging, g = this.game;
    if (!w.alive || w.state === 'evac') { s.dragging = null; return; }
    if (s.dragPhase === 'reach') {
      if (s.pos.distanceTo(w.pos) < 1.4) {
        s.dragPhase = 'drag'; w.dragger = s;
        // destination: carrier if close, else nearest cover away from the enemy
        const v = this.carrier && !this.carrier.destroyed && this.carrier.pos.distanceTo(s.pos) < 70 ? this.carrier : null;
        let dest;
        if (v) { const d = v.doorPos(s.idx); dest = [d.x, d.z]; s.dragTarget = 'carrier'; }
        else { const back = this.side === 'player' ? 1 : -1; dest = this.findCover(s.pos.x, s.pos.z + back * 14, s.pos); s.dragTarget = 'cover'; }
        s.goal = dest; g.requestPath(s, s.pos.x, s.pos.z, dest[0], dest[1], 0.45);
      } else if (!s.path) { s.goal = [w.pos.x, w.pos.z]; g.requestPath(s, s.pos.x, s.pos.z, w.pos.x, w.pos.z, 0.45); }
    } else if (s.dragPhase === 'drag') {
      // wounded is pulled behind the dragger
      const back = new THREE.Vector3(-Math.sin(s.heading), 0, -Math.cos(s.heading));
      w.pos.lerp(s.pos.clone().addScaledVector(back, -1.0), Math.min(1, dt * 8)); w.heading = s.heading + Math.PI;
      w.vel.set(0, 0, 0);
      if (!s.path || s.pathI >= (s.path?.length || 0)) {
        if (s.dragTarget === 'carrier' && this.carrier && this.carrier.pos.distanceTo(s.pos) < 5) { this.evacuate(w); s.dragging = null; s.dragPhase = null; this.game.hud && this.side === 'player' && this.game.hud.alert(`${this.name}: casualty evacuated`, 'good'); }
        else { s.dragPhase = 'treat'; s.treatT = 7 + Math.random() * 4; }
      }
    } else if (s.dragPhase === 'treat') {
      s.treatT -= dt; s.vel.set(0, 0, 0); s.stance = 'crouch';
      if (s.treatT <= 0) { w.state = 'stable'; w.dragger = null; s.dragging = null; s.dragPhase = null; }
    }
  }
  findCover(x, z, from) {
    const nav = this.game.nav; let best = [x, z], bs = -1e9;
    const enemyZ = this.side === 'player' ? -200 : 200;
    for (let r = 0; r <= 10; r += 2) for (let a = 0; a < 12; a++) {
      const cx = x + Math.cos(a / 12 * 6.28) * r, cz = z + Math.sin(a / 12 * 6.28) * r, i = nav.idx(cx, cz);
      if (!nav.passable(i, 0.4)) continue;
      const sc = nav.coverFrom(cx, cz, cx, enemyZ) * 10 - r * 0.3 - Math.hypot(cx - from.x, cz - from.z) * 0.1;
      if (sc > bs) { bs = sc; best = [cx, cz]; }
    }
    return best;
  }
}

export function angDiff(a, b) { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }
