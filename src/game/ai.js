import * as THREE from 'three';
import { trenchNear, trenchMen } from './trench.js';
import { SPAWNS, OBJECTIVES, MAP } from '../world/city.js';

// Enemy commander. Phase 1: dug-in defenders hold both objectives. Phase 2 (after the player takes an
// objective, or 40% into the round): counterattack waves from the north — mounted approach riding on
// armour, dismount at staging, fire-team bounding through cover with smoke, flanking routes, tank
// overwatch with stand-off from RPG teams, assault squads storming garrisoned buildings, artillery.
// per-objective AI points; objectives without hand-placed points get ones derived from the objective (enemy side = -Z)
const objXZ = k => { const o = OBJECTIVES.find(q => q.id === k) || OBJECTIVES[0]; return [o.x, o.z]; };
const STAGING = new Proxy({}, { get: (_, k) => MAP.ai.staging?.[k] || (([x, z]) => [[x - 40, z - 90], [x + 40, z - 95], [x, z - 110], [x - 70, z - 80]])(objXZ(k)) });
const OVERWATCH = new Proxy({}, { get: (_, k) => MAP.ai.overwatch?.[k] || (([x, z]) => [[x - 50, z - 130], [x + 50, z - 130]])(objXZ(k)) });

export class Commander {
  constructor(game) {
    this.g = game; this.units = []; this.waveI = 0; this.artT = 70 + Math.random() * 40; this.n = 0;
    this.counter = false;
    // [fraction of remaining time, foot squads, mounted squads, tanks, assault squads]
    // finite reserves: three counterattack waves (about the size of the player's company in total), and a wave
    // waits while the enemy still has plenty of men in the field — no endless stream
    // parity: the enemy's starting force matches the player's company (4 squads, 4 vehicles) and it gets the same
    // single reinforcement the player gets (one mounted squad), at about the same point in the round
    this.plan = [[0.2, 0, 1, 0, 0]];
    this.fieldCap = 4;
    this.deployArmy();
  }
  // Initial army laid out in the enemy staging ground during the deployment phase.
  deployArmy() {
    const g = this.g, N = 0; // facing south (+Z)
    this.army = [];
    const lay = MAP.ai.army;
    for (const [x, z, kind, obj] of lay) {
      if (kind === 'spg') { const v = g.makeVehicle('enemy', 'spg', x, z, N); v.name = `Enemy ${g.enemyFaction.spgName}`; this.army.push({ kind: 'spg', v, obj, state: 'emplaced', t: 3 }); this.spg = v; continue; }
      if (kind === 'tank') { const v = g.makeVehicle('enemy', 'tank', x, z, N); this.army.push({ kind: 'tank', v, obj, state: 'move', t: 2, home: OVERWATCH[obj][0] }); continue; }
      if (kind === 'mech' || kind === 'imech') { const v = g.makeVehicle('enemy', kind === 'imech' ? 'ifv' : 'btr', x, z, N); const s = g.makeSquad('enemy', x, z + 6, N, 'Enemy squad'); s.board(v, true); this.army.push({ kind: 'mech', sq: s, v, obj, state: 'approach', t: 1, flank: this.flank() }); continue; }
      if (kind === 'atgm' || kind === 'fpv') { const s = g.makeSquad('enemy', x, z, N, kind === 'atgm' ? `Enemy ${g.enemyFaction.id === 'RU' ? 'Kornet' : 'Stugna'} team` : 'Enemy FPV team', kind); this.army.push({ kind, sq: s, obj, state: 'move', t: 2 }); continue; }
      const s = g.makeSquad('enemy', x, z, N, kind === 'assault' ? 'Enemy assault squad' : 'Enemy squad', kind === 'assault' ? 'assault' : 'mech');
      this.army.push({ kind, sq: s, obj, state: 'advance', t: 2, bound: 0, flank: this.flank() });
    }
  }
  // Battle starts: the deployed army races for the objectives.
  begin() {
    for (const b of this.army) {
      if (b.kind === 'mech') { const st = this.stagingFor(b.obj); b.v.orderMove(st[0], st[1], 0, true); }
      if (b.kind === 'tank') b.v.orderMove(b.home[0], b.home[1], 0, false);
      this.units.push(b);
    }
    this.started = true;
  }
  update(dt) {
    const g = this.g;
    if (!this.started) return;
    if (!this.counter && (g.objectives.some(o => o.captured) || g.time > g.roundLen * 0.3)) {
      this.counter = true; const rem = Math.max(120, g.roundLen - g.time);
      this.waves = this.plan.map(([f, a, b, c, d]) => ({ t: g.time + 25 + f * rem, foot: a, mech: b, tank: c, assault: d }));
      g.hud?.alert('Enemy is massing for a counterattack from the north', 'bad');
    }
    if (this.counter && this.waveI < this.waves.length && g.time >= this.waves[this.waveI].t) {
      const inField = g.squads.filter(q => q.side === 'enemy' && !q.destroyed && q.effective.length >= 3 && !q.routing).length;
      if (inField < this.fieldCap) { this.spawnWave(this.waves[this.waveI++]); if (this.waveI >= this.waves.length) setTimeout(() => g.hud?.alert('Intercepts: the enemy has committed his last reserve', 'good'), 15000); }
      else this.waves[this.waveI].t = g.time + 20; // hold the wave back until the field thins out
    }
    for (const b of this.units) if (!b.dead) { b.t -= dt; if (b.t <= 0) { b.t = 1.2 + Math.random() * 0.6; this.think(b); } }
    // artillery on spotted player concentrations
    this.artT -= dt;
    if (this.artT <= 0) {
      this.artT = 70 + Math.random() * 55;
      const targets = g.unitsOf('player').filter(u => (u.type === 'squad' && !u.mounted) || u.type === 'vehicle');
      targets.sort((a, b) => this.clusterScore(b) - this.clusterScore(a));
      // counter-battery: a player howitzer that has been firing gives its position away (sound ranging / radar)
      const pg = g.vehicles.find(v => v.side === 'player' && v.kind === 'spg' && !v.destroyed && g.time - (v.lastFireT ?? -999) < 90);
      const t = pg && Math.random() < 0.5 ? pg : targets[0]; if (!t) return;
      const c = t.center(); const err = t === pg ? 40 : t.type === 'vehicle' ? 30 : 22;
      // our own howitzer takes the mission if it can; otherwise divisional fire from off the map
      const own = this.spg && !this.spg.destroyed && this.spg.weapons[0].ammo > 0 && !this.spg.spg.mission ? this.spg : null;
      const ap = new THREE.Vector3(c.x + (Math.random() - .5) * err, 0, c.z + (Math.random() - .5) * err), ad = own ? Math.hypot(ap.x - own.pos.x, ap.z - own.pos.z) : 0;
      if (own && (ad >= own.def.minRange || (ad <= own.def.directRange && own.spgSees(ap)))) { own.fireAt = { p: ap }; this.artT *= 0.75; if (t === pg) g.hud?.alert('Enemy counter-battery fire on our howitzer!', 'bad'); return; }
      g.callStrike(c.x + (Math.random() - .5) * err, c.z + (Math.random() - .5) * err, 4 + Math.floor(Math.random() * 3), 24, 'enemy', 3, Math.random() < 0.25 ? 'arty' : 'mortar');
      g.hud?.alert('Incoming artillery!', 'bad');
    }
  }
  clusterScore(u) { const c = u.center(); let n = 0; for (const o of this.g.unitsOf('player')) if (o !== u && o.center().distanceTo(c) < 40) n++; return n + (u.type === 'vehicle' ? 0.5 : 0) + Math.random(); }
  spawnWave(w) {
    const g = this.g, sp = SPAWNS.attacker;
    const target = () => { const held = g.objectives.filter(o => o.owner === 'player'); const l = held.length ? held : g.objectives; return l[this.n++ % l.length].id; };
    const at = i => sp[(this.n + i) % sp.length];
    for (let i = 0; i < w.mech; i++) {
      const [x, z] = at(i), obj = target(); const v = g.makeVehicle('enemy', 'btr', x + (Math.random() - .5) * 6, z, 0);
      const s = g.makeSquad('enemy', x, z, 0, 'Enemy squad'); s.board(v, true);
      const st = this.stagingFor(obj); v.orderMove(st[0], st[1], 0, true);
      this.units.push({ kind: 'mech', sq: s, v, obj, state: 'approach', t: 1, flank: this.flank() });
    }
    for (let i = 0; i < w.foot; i++) {
      const [x, z] = at(i + 1), obj = target(); const s = g.makeSquad('enemy', x + (Math.random() - .5) * 10, z, 0, 'Enemy squad');
      this.units.push({ kind: 'foot', sq: s, obj, state: 'advance', t: 1 + i, bound: 0, flank: this.flank() });
    }
    for (let i = 0; i < w.assault; i++) {
      const [x, z] = at(i + 2), obj = target(); const s = g.makeSquad('enemy', x, z, 0, 'Enemy assault squad', 'assault');
      this.units.push({ kind: 'assault', sq: s, obj, state: 'advance', t: 2, bound: 0, flank: this.flank() });
    }
    for (let i = 0; i < w.tank; i++) {
      const [x, z] = at(i + 3), obj = target(); const v = g.makeVehicle('enemy', 'tank', x, z - 8, 0);
      const ow = OVERWATCH[obj][Math.floor(Math.random() * 2)]; v.orderMove(ow[0], ow[1], 0, false);
      this.units.push({ kind: 'tank', v, obj, state: 'move', t: 2, home: ow });
    }
    g.hud?.alert(w.assault ? 'Enemy assault groups moving in' : 'Enemy movement reported to the north', 'bad');
  }
  // ATGM teams take a firing position with long sightlines behind the overwatch line; FPV teams sit back near
  // the staging area. Both relocate after being shot at (a launch signature gives them away).
  thinkSupport(b) {
    const sq = b.sq, g = this.g;
    if (sq.routing) return;
    const moving = sq.effective.some(s => (s.path && s.pathI < s.path.length) || s.pathReq);
    if (moving) return;
    const hot = sq.underFireT < 3 && sq.morale < 55;
    if (!b.spot || hot && (b.moved = (b.moved || 0) + 1) < 4) {
      let p;
      if (b.kind === 'atgm') { const o = OVERWATCH[b.obj][Math.floor(Math.random() * 2)]; p = [o[0] + (Math.random() - .5) * 30, o[1] - 25 - Math.random() * 25]; }
      else { const st = this.stagingFor(b.obj); p = [st[0] + (Math.random() - .5) * 30, st[1] - 60 - Math.random() * 40]; }
      const f = g.nav.nearestFree(p[0], p[1], 0.5, 20); b.spot = f;
      sq.orderMove(f[0], f[1], 0, 10, b.kind === 'atgm' && !hot ? false : true);
    }
  }
  flank() { const r = Math.random(); return r < 0.3 ? -1 : r < 0.6 ? 1 : 0; }
  stagingFor(obj) { const l = STAGING[obj]; return l[Math.floor(Math.random() * l.length)]; }
  objPos(obj) { const o = OBJECTIVES.find(o => o.id === obj); return [o.x, o.z]; }
  // nearest player squad/vehicle within r of p
  threatsNear(p, r) { let n = 0, rpg = 0; for (const u of this.g.unitsOf('player')) { if (u.type === 'squad' && u.mounted) continue; const c = u.center(); if (c.distanceTo(p) < r) { n++; if (u.type === 'squad' && u.effective.some(s => s.weaponKey === 'rpg7' || s.rpg22 > 0)) rpg++; } } return { n, rpg }; }
  friendsNear(p, r) { let n = 0; for (const u of this.g.unitsOf('enemy')) if (u.type === 'squad' && !u.mounted && u.center().distanceTo(p) < r) n++; return n; }
  think(b) {
    const g = this.g;
    if (b.kind === 'spg') return this.thinkSpg(b);
    if (b.kind === 'tank' || b.kind === 'vdefend') return this.thinkVehicle(b);
    const sq = b.sq;
    if (sq.destroyed) { b.dead = true; if (b.v && !b.v.destroyed) b.v.orderMove(...this.stagingFor(b.obj)); return; }
    if (b.kind === 'defend') return this.thinkDefender(b);
    if (b.kind === 'atgm' || b.kind === 'fpv') return this.thinkSupport(b);
    // keep attacking whichever objective the player holds
    const tgt = g.objectives.find(o => o.id === b.obj);
    if (tgt.owner === 'enemy' && b.state !== 'hold') { const other = g.objectives.find(o => o.owner === 'player'); if (other) b.obj = other.id; }
    if (b.kind === 'mech' && b.state === 'approach') {
      const v = b.v, [ox, oz] = this.objPos(b.obj);
      const arrived = !v.path || v.destroyed || v.immobile;
      const danger = sq.underFireT < 2 || v.hp < v.def.hp * 0.85 || this.threatsNear(v.pos, 130).n > 0;
      const near = Math.hypot(v.pos.x - ox, v.pos.z - oz) < 150;
      if ((arrived || danger || near) && sq.mounted) {
        if (!v.destroyed) v.halt();
        sq.dismount(Math.atan2(ox - v.pos.x, oz - v.pos.z));
        b.state = 'advance'; b.t = 3; b.bound = 0; b.vState = 'support';
      }
      return;
    }
    if (b.v && !b.v.destroyed && b.vState === 'support' && !sq.mounted) this.supportVehicle(b);
    if (sq.mounted) return;
    if (sq.routing) { b.state = 'routed'; return; }
    if (b.state === 'routed') { b.state = 'advance'; b.wait = 8; }
    const [ox, oz] = this.objPos(b.obj);
    const c = sq.center(); const dObj = Math.hypot(c.x - ox, c.z - oz);
    const moving = sq.effective.some(s => (s.path && s.pathI < s.path.length) || s.pathReq || s.waitTeam);
    if (b.wait > 0) { b.wait -= 1.5; return; }
    if (sq.order?.type === 'storm') return;
    // ---- regrouping after a mauling: hold the fallback position until the squad has its nerve back, then go again
    if (b.state === 'regroup') {
      if (moving) return;
      if (g.time > b.regroupT && sq.morale > 50 && sq.underFireT > 8) { b.state = 'advance'; b.wait = 4; if (sq.building) sq.leaveBuilding(); }
      else { b.wait = 4; return; }
    }
    // ---- strongpoint: a building taken in contact is held for a while (covering friends) before moving on
    if (b.state === 'strongpoint') {
      if (!sq.building && !moving) b.state = 'advance';
      else if (g.time > b.holdT && sq.morale > 55 && this.friendsNear(c, 90) >= 1 && sq.underFireT > 4) { b.state = 'advance'; sq.leaveBuilding(); }
      else { b.wait = 3; return; }
    }
    // ---- badly hurt or shaken and outgunned: pull back to cover / a building on the own side and regroup
    const strength = sq.effective.length / sq.soldiers.length;
    if ((strength <= 0.45 || sq.morale < 36) && b.state !== 'hold' && !sq.building) {
      const thr = this.threatsNear(c, 120);
      if (thr.n > this.friendsNear(c, 90) || sq.morale < 30) {
        const home = this.stagingFor(b.obj), back = new THREE.Vector3(home[0] - c.x, 0, home[1] - c.z); const L = back.length() || 1; back.multiplyScalar(1 / L);
        const fb = new THREE.Vector3(c.x + back.x * Math.min(L, 70), 0, c.z + back.z * Math.min(L, 70));
        const bld = this.buildingBehind(c, back, 70, sq);
        if (bld) sq.orderGarrison(bld);
        else { const cv = this.coverSpot(fb, new THREE.Vector3(c.x - back.x * 50, 0, c.z - back.z * 50), 18) || [fb.x, fb.z]; sq.orderMove(cv[0], cv[1], Math.atan2(-back.x, -back.z), 14, true); }
        b.state = 'regroup'; b.regroupT = g.time + 35 + Math.random() * 25; b.wait = 6;
        return;
      }
    }
    if (sq.morale < 32) { if (!moving && sq.underFireT < 3 && !sq.building) { const bld = this.nearBuilding(c, 30, sq); if (bld) sq.orderGarrison(bld); } b.wait = 8; return; }
    if (moving) return;
    // assault squads: storm a player-held building near the objective
    if (b.kind === 'assault' && dObj < 90) {
      // player dug into a trench near the objective: clear it
      const Tp = (g.city.trenchSystems || []).filter(T => Math.hypot(T.center[0] - ox, T.center[1] - oz) < T.radius + 90 && trenchMen(g, T, 'player').length).sort((p, q) => Math.hypot(p.center[0] - c.x, p.center[1] - c.z) - Math.hypot(q.center[0] - c.x, q.center[1] - c.z))[0];
      if (Tp && Math.hypot(Tp.center[0] - c.x, Tp.center[1] - c.z) < Tp.radius + 110) { sq.orderClearTrench(Tp); b.wait = 8; return; }
      const target = this.g.city.buildings.filter(bl => bl.slots.some(sl => sl.occupant && sl.occupant.squad.side === 'player')).sort((p, q) => Math.hypot(p.x - ox, p.z - oz) - Math.hypot(q.x - ox, q.z - oz))[0];
      if (target && Math.hypot(target.x - c.x, target.z - c.z) < 110) { sq.orderGarrison(target); b.wait = 4; return; }
    }
    if (b.state === 'hold') { if (g.objectives.every(o => o.owner === 'enemy')) return; if (Math.random() < 0.04) { const others = g.objectives.filter(o => o.id !== b.obj && o.owner !== 'enemy'); if (others.length) { b.state = 'advance'; b.obj = others[Math.floor(Math.random() * others.length)].id; if (sq.building) sq.leaveBuilding(); } } return; }
    if (dObj < 22) { b.state = 'hold'; const T = this.freeTrench(ox, oz, 70, sq); if (T && Math.random() < 0.7) { sq.orderTrench(T); return; } const bld = this.nearBuilding(new THREE.Vector3(ox, 0, oz), 30, sq); if (bld && Math.random() < 0.6) sq.orderGarrison(bld); return; }
    if (sq.building && sq.underFireT < 4 && Math.random() < 0.7) { b.wait = 5; return; }
    // in contact: fire and manoeuvre — one fire team keeps the enemy's heads down while the other bounds to
    // cover on a flank; if clearly outnumbered locally, go to ground in the best cover and wait for support
    const contact = this.contactNear(sq, c, 170);
    if (contact) {
      const T = contact.p, local = this.threatsNear(c, 90).n, friends = this.friendsNear(c, 70);
      // a solid building close by facing the contact: turn it into a strongpoint (360 deg garrison) instead of fighting in the open
      // or a trench close by: drop into it and fight from it
      if (b.kind !== 'assault' && !sq.trench && T.distanceTo(c) < 170) {
        const tr = this.freeTrench(c.x, c.z, 35, sq);
        if (tr && Math.random() < (local >= friends ? 0.8 : 0.5)) { sq.orderTrench(tr); b.state = 'strongpoint'; b.holdT = g.time + 40 + Math.random() * 30; b.wait = 6; return; }
      }
      if (!b.noBld && b.kind !== 'assault' && T.distanceTo(c) < 160) {
        const bld = this.nearBuilding(c, 28, sq);
        if (bld && Math.random() < (local >= friends ? 0.75 : 0.4)) { sq.orderGarrison(bld); b.state = 'strongpoint'; b.holdT = g.time + 30 + Math.random() * 30; b.wait = 5; return; }
      }
      if (local > friends + 1 && sq.morale < 60) { const cv = this.coverSpot(c, T, 14); if (cv) sq.orderMove(cv[0], cv[1], Math.atan2(T.x - cv[0], T.z - cv[1]), 12, true); b.wait = 8 + Math.random() * 6; return; }
      const flank = b.flank || (Math.random() < 0.5 ? -1 : 1); b.flank = flank;
      const ax = T.x - c.x, az = T.z - c.z, L = Math.hypot(ax, az) || 1, ux = ax / L, uz = az / L;
      const want = Math.min(32, Math.max(12, L - 45));
      const base = new THREE.Vector3(c.x + ux * want - uz * flank * 20, 0, c.z + uz * want + ux * flank * 20);
      const cv = this.coverSpot(base, T, 16) || [base.x, base.z];
      const open = g.nav.coverFrom(cv[0], cv[1], T.x, T.z) < 0.5;
      if (open && (b.smokes ?? 2) > 0 && Math.random() < 0.6) { const th = sq.effective.find(s => !s.inside); if (th) { b.smokes = (b.smokes ?? 2) - 1; g.combat.throwSmoke(th, new THREE.Vector3((c.x + T.x) / 2, 0, (c.z + T.z) / 2)); } }
      sq.focus = contact.u; sq.orderMove(cv[0], cv[1], Math.atan2(T.x - cv[0], T.z - cv[1]), 16, true, false, true);
      b.wait = 6 + Math.random() * 6; b.bound++; return;
    }
    // next bound: ~30–40 m along the route, offset to the flank while still far out
    const path = g.nav.findPath(c.x, c.z, ox, oz, 0.45, false, 60000);
    if (!path || path.length < 2) { sq.orderMove(ox, oz, null, 16, true); return; }
    const step = dObj < 60 ? dObj + 5 : 28 + Math.random() * 14;
    let acc = 0, px = c.x, pz = c.z, tx = ox, tz = oz;
    for (const [x, z] of path) { const d = Math.hypot(x - px, z - pz); if (acc + d >= step) { const f = (step - acc) / d; tx = px + (x - px) * f; tz = pz + (z - pz) * f; break; } acc += d; px = x; pz = z; tx = x; tz = z; }
    if (b.flank && dObj > 70) { const dx = ox - c.x, dz = oz - c.z, L = Math.hypot(dx, dz) || 1; [tx, tz] = g.nav.nearestFree(tx + (-dz / L) * b.flank * 22, tz + (dx / L) * b.flank * 22, 0.5, 10); }
    const facing = Math.atan2(ox - tx, oz - tz);
    const assault = dObj < 60 && sq.effective.length >= 3;
    if (sq.underFireT < 5 && (b.smokes ?? 2) > 0 && Math.random() < 0.55) {
      const thrower = sq.effective.find(s => !s.inside); if (thrower) { b.smokes = (b.smokes ?? 2) - 1; g.combat.throwSmoke(thrower, new THREE.Vector3(ox, 0, oz)); }
    }
    // under fire: move by fire teams (half covers while the other half moves)
    sq.orderMove(tx, tz, facing, assault ? 14 : 18, assault || sq.underFireT > 6, false, sq.underFireT < 6);
    b.bound++;
    b.wait = assault ? 2 : 5 + Math.random() * 7;
  }
  // a trench system near (x,z) with room for most of the squad and no player troops in it
  freeTrench(x, z, r, sq) {
    const g = this.g, n = sq.effective.length;
    return (g.city.trenchSystems || []).filter(T => Math.hypot(T.center[0] - x, T.center[1] - z) < T.radius + r && T.slots.filter(sl => !sl.occupant || !sl.occupant.effective).length >= Math.min(n, 4) && !trenchMen(g, T, 'player').length)
      .sort((p, q) => Math.hypot(p.center[0] - x, p.center[1] - z) - Math.hypot(q.center[0] - x, q.center[1] - z))[0] || null;
  }
  thinkDefender(b) {
    const g = this.g, sq = b.sq, o = g.objectives.find(q => q.id === b.obj);
    if (sq.routing) return;
    // building collapsed / lost the garrison -> fall back to the next building near the objective
    if (!sq.building && !sq.trench && !sq.effective.some(s => s.path) && sq.effective.length) {
      const T = this.freeTrench(o.x, o.z, 80, sq); if (T && Math.random() < 0.6) { sq.orderTrench(T); return; }
      const bld = this.nearBuilding(new THREE.Vector3(o.x, 0, o.z), 45, sq);
      if (bld && Math.random() < 0.5) sq.orderGarrison(bld);
    }
    // objective lost and still steady: switch to counterattack mode
    if (o.owner === 'player' && sq.morale > 45 && !sq.building && !sq.trench) { b.kind = 'foot'; b.state = 'advance'; b.flank = 0; }
  }
  supportVehicle(b) {
    const v = b.v, sq = b.sq, c = sq.center();
    const t = this.threatsNear(v.pos, 70);
    // stand-off: never sit within RPG range of enemy infantry without own infantry close by
    if (t.rpg > 0 && sq.center().distanceTo(v.pos) > 35 && !v.path) { const [ox, oz] = this.objPos(b.obj); const back = new THREE.Vector3(v.pos.x - ox, 0, v.pos.z - oz).normalize(); const p = v.pos.clone().addScaledVector(back, 45); v.orderMove(p.x, p.z); return; }
    if (v.pos.distanceTo(c) > 70 && !v.path) { const [ox, oz] = this.objPos(b.obj); const back = new THREE.Vector3(c.x - ox, 0, c.z - oz).normalize(); const p = c.clone().addScaledVector(back, 35); v.orderMove(p.x, p.z); }
    if (v.hp < v.def.hp * 0.4 && !b.retreated) { b.retreated = true; const [x, z] = this.stagingFor(b.obj); v.orderMove(x, z - 60); }
  }
  // bailed-out enemy crews fall back towards their own lines and defend themselves
  adoptCrew(sq) {
    const sp = SPAWNS.attacker[0]; setTimeout(() => { if (!sq.destroyed) sq.orderMove(sp[0], sp[1] + 30, 0, 8, true); }, 3000);
  }
  // nearest spotted player unit within r of this squad (position + unit)
  contactNear(sq, c, r) {
    let best = null, bd = r;
    for (const u of this.g.unitsOf('player')) { if (u.type === 'squad' && u.mounted) continue; if (!this.g.seen('enemy', u, c)) continue; const p = u.type === 'vehicle' ? u.pos : u.center(); const d = p.distanceTo(c); if (d < bd) { bd = d; best = { u, p: p.clone(), d }; } }
    return best;
  }
  // best cover cell against threat T within r of p (directional cover from the nav grid, then distance)
  coverSpot(p, T, r) {
    const nav = this.g.nav; let best = null, bs = 0.3;
    for (let rr = 0; rr <= r; rr += 2) for (let a = 0; a < 16; a++) {
      const x = p.x + Math.cos(a / 16 * 6.283) * rr, z = p.z + Math.sin(a / 16 * 6.283) * rr, i = nav.idx(x, z);
      if (!nav.passable(i, 0.45)) continue;
      const sc = nav.coverFrom(x, z, T.x, T.z) - rr * 0.015 + (nav.low[i] ? 0.05 : 0);
      if (sc > bs) { bs = sc; best = [x, z]; }
    }
    return best;
  }
  // nearest usable building lying back along `dir` (toward the own side) from c, within r
  buildingBehind(c, dir, r, sq) {
    let best = null, bs = 1e9;
    for (const bl of this.g.city.buildings) {
      if (bl.collapsedAll) continue; const dx = bl.x - c.x, dz = bl.z - c.z, d = Math.hypot(dx, dz); if (d > r || d < 8) continue;
      const along = (dx * dir.x + dz * dir.z) / (d || 1); if (along < 0.3) continue;
      if (!bl.slots.some(s => !s.occupant && !s.panel.gone) || bl.slots.some(s => s.occupant && s.occupant.squad.side !== sq.side)) continue;
      const sc = d - along * 20; if (sc < bs) { bs = sc; best = bl; }
    }
    return best;
  }
  nearBuilding(c, r, sq) {
    let best = null, bd = r;
    for (const bl of this.g.city.buildings) { if (bl.collapsedAll) continue; const [lx, lz] = bl.toLocal(c.x, c.z); const d = Math.max(0, Math.abs(lx) - bl.L / 2) + Math.max(0, Math.abs(lz) - bl.D / 2); if (d < bd && bl.slots.some(s => !s.occupant && !s.panel.gone) && !bl.slots.some(s => s.occupant && s.occupant.squad.side !== sq.side)) { bd = d; best = bl; } }
    return best;
  }
  // the enemy howitzer: stays emplaced in the rear; after firing it sometimes relocates ("shoot and scoot") to dodge
  // counter-battery fire, especially when a player howitzer is around
  thinkSpg(b) {
    const v = b.v, g = this.g; if (v.destroyed) { b.dead = true; return; }
    const S = v.spg;
    if (b.state === 'emplaced' && S.missions > (b.seen ?? 0)) {
      b.seen = S.missions;
      const threat = g.vehicles.some(o => o.side === 'player' && o.kind === 'spg' && !o.destroyed) ? 0.55 : 0.25;
      if (!S.mission && Math.random() < threat) {
        b.home ??= [v.pos.x, v.pos.z];
        const a = Math.random() * Math.PI * 2, r = 35 + Math.random() * 35;
        const [x, z] = g.nav.nearestFree(b.home[0] + Math.cos(a) * r, b.home[1] + Math.sin(a) * r * 0.5, 2.4, 30);
        v.orderMove(x, z, 0, false); b.state = 'relocating';
      }
    } else if (b.state === 'relocating' && !v.path && S.state !== 'packing') b.state = 'emplaced';
  }
  thinkVehicle(b) {
    const v = b.v; if (v.destroyed) { b.dead = true; return; }
    if (v.crew < 2 || v.hp < v.def.hp * 0.35) { if (!b.retreating) { b.retreating = true; v.orderMove(b.home[0], b.home[1] - 80); } return; }
    if (v.path) return;
    const t = this.threatsNear(v.pos, 75), f = this.friendsNear(v.pos, 40);
    if (t.rpg > 0 && f === 0) { // back off out of RPG range
      const away = new THREE.Vector3(0, 0, -1); for (const u of this.g.unitsOf('player')) if (u.type === 'squad' && u.center().distanceTo(v.pos) < 75) away.add(v.pos.clone().sub(u.center()).normalize());
      away.normalize(); const p = v.pos.clone().addScaledVector(away, 50); const [x, z] = this.g.nav.nearestFree(p.x, p.z, 2.2, 20); v.orderMove(x, z); return;
    }
    if (b.kind === 'vdefend') return;
    b.idle = v.target ? 0 : (b.idle || 0) + 1.5;
    if (b.idle > 20) {
      b.idle = 0; const [ox, oz] = this.objPos(b.obj); const d = Math.hypot(v.pos.x - ox, v.pos.z - oz);
      if (d > 90 && f > 0) { const p = v.pos.clone().lerp(new THREE.Vector3(ox, 0, oz), 40 / d); v.orderMove(p.x, p.z); }
    }
  }
}

// Simple player-side AI for automated balance testing (?autoplay=1): dismount, take objectives, garrison.
export class AutoDefender {
  constructor(g) { this.g = g; this.t = 5; }
  update(dt) {
    const g = this.g; this.t -= dt; if (this.t > 0) return; this.t = 4;
    for (const u of g.unitsOf('player')) {
      if (u.type !== 'squad' || u.routing) continue;
      const o = g.objectives.slice().sort((a, b) => (a.owner === 'enemy' ? -200 : 0) + a.control - ((b.owner === 'enemy' ? -200 : 0) + b.control))[u.id % 2];
      if (u.mounted && u.carrier) {
        const d = Math.hypot(u.carrier.pos.x - o.x, u.carrier.pos.z - o.z);
        if (d < 120 || u.underFireT < 2 || u.carrier.destroyed) u.dismount(Math.PI); else if (!u.carrier.path) u.carrier.orderMove(o.x, o.z + 90, Math.PI, true);
        continue;
      }
      if (u.building || u.trench || u.order?.type === 'clear' || (u.order && u.effective.some(s => s.path))) continue;
      const eT = (g.city.trenchSystems || []).find(T => Math.hypot(T.center[0] - o.x, T.center[1] - o.z) < T.radius + 60 && trenchMen(g, T, 'enemy').length);
      if (eT && u.assault && Math.hypot(eT.center[0] - u.center().x, eT.center[1] - u.center().z) < eT.radius + 120) { u.orderClearTrench(eT); continue; }
      const enemyIn = g.city.buildings.find(b => Math.hypot(b.x - o.x, b.z - o.z) < 35 && b.slots.some(s => s.occupant && s.occupant.squad.side === 'enemy'));
      if (enemyIn && u.assault) { u.orderGarrison(enemyIn); continue; }
      if (o.owner === 'enemy') { u.orderMove(o.x + (Math.random() - .5) * 16, o.z + 10, Math.PI, 16, false); continue; }
      const bl = g.city.buildings.slice().sort((a, b) => Math.hypot(a.x - o.x, a.z - o.z) - Math.hypot(b.x - o.x, b.z - o.z)).find(b => b.slots.some(s => !s.occupant && !s.panel.gone));
      const fT = (g.city.trenchSystems || []).find(T => Math.hypot(T.center[0] - o.x, T.center[1] - o.z) < T.radius + 50 && T.slots.some(sl => !sl.occupant) && !trenchMen(g, T, 'enemy').length);
      if (fT && Math.random() < 0.5) { u.orderTrench(fT); continue; }
      if (bl && Math.random() < 0.5) u.orderGarrison(bl); else u.orderMove(o.x + (Math.random() - .5) * 20, o.z - 8, Math.PI, 18, true);
    }
    for (const v of g.unitsOf('player')) if (v.type === 'vehicle' && !v.path && !v.passengers) { const o = g.objectives[v.id % 2]; if (Math.hypot(v.pos.x - o.x, v.pos.z - o.z) > 70) v.orderMove(o.x, o.z + 55, Math.PI); }
    if (g.mortars > 0 && Math.random() < 0.08) { const e = g.unitsOf('enemy').filter(u => u.type === 'squad' && !u.mounted && u.spotted); if (e.length) { const c = e[0].center(); g.playerMortar(c.x, c.z); } }
  }
}
