import * as THREE from 'three';
import { SPAWNS, OBJECTIVES, MAP } from '../world/city.js';

// Enemy commander. Phase 1: dug-in defenders hold both objectives. Phase 2 (after the player takes an
// objective, or 40% into the round): counterattack waves from the north — mounted approach riding on
// armour, dismount at staging, fire-team bounding through cover with smoke, flanking routes, tank
// overwatch with stand-off from RPG teams, assault squads storming garrisoned buildings, artillery.
const STAGING = new Proxy({}, { get: (_, k) => MAP.ai.staging[k] });
const OVERWATCH = new Proxy({}, { get: (_, k) => MAP.ai.overwatch[k] });

export class Commander {
  constructor(game) {
    this.g = game; this.units = []; this.waveI = 0; this.artT = 70 + Math.random() * 40; this.n = 0;
    this.counter = false;
    // [fraction of remaining time, foot squads, mounted squads, tanks, assault squads]
    this.plan = [[0.02, 1, 1, 0, 1], [0.16, 1, 2, 1, 0], [0.3, 2, 1, 1, 1], [0.46, 1, 2, 1, 1], [0.62, 2, 1, 1, 1], [0.78, 2, 2, 1, 1]];
    this.deployArmy();
  }
  // Initial army laid out in the enemy staging ground during the deployment phase.
  deployArmy() {
    const g = this.g, N = 0; // facing south (+Z)
    this.army = [];
    const lay = MAP.ai.army;
    for (const [x, z, kind, obj] of lay) {
      if (kind === 'tank') { const v = g.makeVehicle('enemy', 'tank', x, z, N); this.army.push({ kind: 'tank', v, obj, state: 'move', t: 2, home: OVERWATCH[obj][0] }); continue; }
      if (kind === 'mech') { const v = g.makeVehicle('enemy', 'btr', x, z, N); const s = g.makeSquad('enemy', x, z + 6, N, 'Enemy squad'); s.board(v, true); this.army.push({ kind: 'mech', sq: s, v, obj, state: 'approach', t: 1, flank: this.flank() }); continue; }
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
    while (this.counter && this.waveI < this.waves.length && g.time >= this.waves[this.waveI].t) this.spawnWave(this.waves[this.waveI++]);
    for (const b of this.units) if (!b.dead) { b.t -= dt; if (b.t <= 0) { b.t = 1.2 + Math.random() * 0.6; this.think(b); } }
    // artillery on spotted player concentrations
    this.artT -= dt;
    if (this.artT <= 0) {
      this.artT = 70 + Math.random() * 55;
      const targets = g.unitsOf('player').filter(u => (u.type === 'squad' && !u.mounted) || u.type === 'vehicle');
      targets.sort((a, b) => this.clusterScore(b) - this.clusterScore(a));
      const t = targets[0]; if (!t) return;
      const c = t.center(); const err = t.type === 'vehicle' ? 30 : 22;
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
  flank() { const r = Math.random(); return r < 0.3 ? -1 : r < 0.6 ? 1 : 0; }
  stagingFor(obj) { const l = STAGING[obj]; return l[Math.floor(Math.random() * l.length)]; }
  objPos(obj) { const o = OBJECTIVES.find(o => o.id === obj); return [o.x, o.z]; }
  // nearest player squad/vehicle within r of p
  threatsNear(p, r) { let n = 0, rpg = 0; for (const u of this.g.unitsOf('player')) { if (u.type === 'squad' && u.mounted) continue; const c = u.center(); if (c.distanceTo(p) < r) { n++; if (u.type === 'squad' && u.effective.some(s => s.weaponKey === 'rpg7' || s.rpg22 > 0)) rpg++; } } return { n, rpg }; }
  friendsNear(p, r) { let n = 0; for (const u of this.g.unitsOf('enemy')) if (u.type === 'squad' && !u.mounted && u.center().distanceTo(p) < r) n++; return n; }
  think(b) {
    const g = this.g;
    if (b.kind === 'tank' || b.kind === 'vdefend') return this.thinkVehicle(b);
    const sq = b.sq;
    if (sq.destroyed) { b.dead = true; if (b.v && !b.v.destroyed) b.v.orderMove(...this.stagingFor(b.obj)); return; }
    if (b.kind === 'defend') return this.thinkDefender(b);
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
    if (sq.morale < 32) { if (!moving && sq.underFireT < 3 && !sq.building) { const bld = this.nearBuilding(c, 30, sq); if (bld) sq.orderGarrison(bld); } b.wait = 8; return; }
    if (moving) return;
    // assault squads: storm a player-held building near the objective
    if (b.kind === 'assault' && dObj < 90) {
      const target = this.g.city.buildings.filter(bl => bl.slots.some(sl => sl.occupant && sl.occupant.squad.side === 'player')).sort((p, q) => Math.hypot(p.x - ox, p.z - oz) - Math.hypot(q.x - ox, q.z - oz))[0];
      if (target && Math.hypot(target.x - c.x, target.z - c.z) < 110) { sq.orderGarrison(target); b.wait = 4; return; }
    }
    if (b.state === 'hold') { if (g.objectives.every(o => o.owner === 'enemy')) return; if (Math.random() < 0.04) { b.state = 'advance'; b.obj = b.obj === 'A' ? 'B' : 'A'; } return; }
    if (dObj < 22) { b.state = 'hold'; const bld = this.nearBuilding(new THREE.Vector3(ox, 0, oz), 30, sq); if (bld && Math.random() < 0.6) sq.orderGarrison(bld); return; }
    if (sq.building && sq.underFireT < 4 && Math.random() < 0.7) { b.wait = 5; return; }
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
  thinkDefender(b) {
    const g = this.g, sq = b.sq, o = g.objectives.find(q => q.id === b.obj);
    if (sq.routing) return;
    // building collapsed / lost the garrison -> fall back to the next building near the objective
    if (!sq.building && !sq.effective.some(s => s.path) && sq.effective.length) {
      const bld = this.nearBuilding(new THREE.Vector3(o.x, 0, o.z), 45, sq);
      if (bld && Math.random() < 0.5) sq.orderGarrison(bld);
    }
    // objective lost and still steady: switch to counterattack mode
    if (o.owner === 'player' && sq.morale > 45 && !sq.building) { b.kind = 'foot'; b.state = 'advance'; b.flank = 0; }
  }
  supportVehicle(b) {
    const v = b.v, sq = b.sq, c = sq.center();
    const t = this.threatsNear(v.pos, 70);
    // stand-off: never sit within RPG range of enemy infantry without own infantry close by
    if (t.rpg > 0 && sq.center().distanceTo(v.pos) > 35 && !v.path) { const [ox, oz] = this.objPos(b.obj); const back = new THREE.Vector3(v.pos.x - ox, 0, v.pos.z - oz).normalize(); const p = v.pos.clone().addScaledVector(back, 45); v.orderMove(p.x, p.z); return; }
    if (v.pos.distanceTo(c) > 70 && !v.path) { const [ox, oz] = this.objPos(b.obj); const back = new THREE.Vector3(c.x - ox, 0, c.z - oz).normalize(); const p = c.clone().addScaledVector(back, 35); v.orderMove(p.x, p.z); }
    if (v.hp < v.def.hp * 0.4 && !b.retreated) { b.retreated = true; const [x, z] = this.stagingFor(b.obj); v.orderMove(x, z - 60); }
  }
  nearBuilding(c, r, sq) {
    let best = null, bd = r;
    for (const bl of this.g.city.buildings) { if (bl.collapsedAll) continue; const [lx, lz] = bl.toLocal(c.x, c.z); const d = Math.max(0, Math.abs(lx) - bl.L / 2) + Math.max(0, Math.abs(lz) - bl.D / 2); if (d < bd && bl.slots.some(s => !s.occupant && !s.panel.gone) && !bl.slots.some(s => s.occupant && s.occupant.squad.side !== sq.side)) { bd = d; best = bl; } }
    return best;
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
      if (u.building || (u.order && u.effective.some(s => s.path))) continue;
      const enemyIn = g.city.buildings.find(b => Math.hypot(b.x - o.x, b.z - o.z) < 35 && b.slots.some(s => s.occupant && s.occupant.squad.side === 'enemy'));
      if (enemyIn && u.assault) { u.orderGarrison(enemyIn); continue; }
      if (o.owner === 'enemy') { u.orderMove(o.x + (Math.random() - .5) * 16, o.z + 10, Math.PI, 16, false); continue; }
      const bl = g.city.buildings.slice().sort((a, b) => Math.hypot(a.x - o.x, a.z - o.z) - Math.hypot(b.x - o.x, b.z - o.z)).find(b => b.slots.some(s => !s.occupant && !s.panel.gone));
      if (bl && Math.random() < 0.5) u.orderGarrison(bl); else u.orderMove(o.x + (Math.random() - .5) * 20, o.z - 8, Math.PI, 18, true);
    }
    for (const v of g.unitsOf('player')) if (v.type === 'vehicle' && !v.path && !v.passengers) { const o = g.objectives[v.id % 2]; if (Math.hypot(v.pos.x - o.x, v.pos.z - o.z) > 70) v.orderMove(o.x, o.z + 55, Math.PI); }
    if (g.mortars > 0 && Math.random() < 0.08) { const e = g.unitsOf('enemy').filter(u => u.type === 'squad' && !u.mounted && u.spotted); if (e.length) { const c = e[0].center(); g.playerMortar(c.x, c.z); } }
  }
}
