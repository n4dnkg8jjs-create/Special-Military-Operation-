import * as THREE from 'three';
import { SPAWNS, OBJECTIVES } from '../world/city.js';

// Attacker AI: timed waves, mounted approach, dismount at staging, bounding advance through cover,
// tank overwatch, building clearing and artillery prep fires.
const STAGING = {
  A: [[-62, -38], [-95, -52], [-20, -28], [-120, -25]],
  B: [[85, -62], [120, -32], [60, -40], [150, -25]],
};
const OVERWATCH = { A: [[-95, -70], [-10, -40]], B: [[85, -95], [110, -40]] };

export class Commander {
  constructor(game) {
    this.g = game; this.units = []; this.waveI = 0; this.artT = 70 + Math.random() * 40;
    const R = game.roundLen;
    // [time fraction, foot squads, BTR squads, tanks]
    this.waves = [[0.03, 2, 2, 0], [0.17, 1, 2, 1], [0.33, 2, 2, 1], [0.5, 1, 2, 2], [0.66, 3, 1, 1], [0.8, 2, 2, 1]].map(([f, a, b, c]) => ({ t: f * R, foot: a, btr: b, tank: c }));
    this.n = 0;
  }
  update(dt) {
    const g = this.g;
    while (this.waveI < this.waves.length && g.time >= this.waves[this.waveI].t) this.spawnWave(this.waves[this.waveI++]);
    for (const b of this.units) if (!b.dead) { b.t -= dt; if (b.t <= 0) { b.t = 1.5 + Math.random(); this.think(b); } }
    // artillery prep / harassment
    this.artT -= dt;
    if (this.artT <= 0) {
      this.artT = 75 + Math.random() * 60;
      const targets = g.unitsOf('player').filter(u => u.type === 'squad' && !u.mounted);
      const pick = targets.length && Math.random() < 0.7 ? targets[Math.floor(Math.random() * targets.length)].center() : (() => { const o = g.objectives[Math.floor(Math.random() * 2)]; return new THREE.Vector3(o.x, 0, o.z); })();
      g.callStrike(pick.x, pick.z, 4 + Math.floor(Math.random() * 3), 26, 'enemy', 3, Math.random() < 0.2 ? 'arty' : 'mortar');
      if (g.hud) g.hud.alert('Incoming artillery!', 'bad');
    }
  }
  spawnWave(w) {
    const g = this.g; const sp = SPAWNS.attacker;
    const objFor = () => (this.n++ % 2 ? 'B' : 'A');
    for (let i = 0; i < w.btr; i++) {
      const [x, z] = sp[(this.n + i) % sp.length];
      const obj = objFor(); const v = g.makeVehicle('enemy', 'btr', x + (Math.random() - .5) * 6, z, 0);
      const s = g.makeSquad('enemy', x, z, 0, 'Enemy squad'); s.carrier = v; s.mounted = true; v.passengers = s; for (const m of s.soldiers) { m.inside = 'btr'; m.pos.copy(v.pos); m.visible = false; }
      const st = this.stagingFor(obj);
      v.orderMove(st[0], st[1], 0, true);
      this.units.push({ kind: 'mech', sq: s, v, obj, state: 'approach', t: 1 });
    }
    for (let i = 0; i < w.foot; i++) {
      const [x, z] = sp[(this.n + i + 1) % sp.length];
      const obj = objFor(); const s = g.makeSquad('enemy', x + (Math.random() - .5) * 10, z, 0, 'Enemy squad');
      this.units.push({ kind: 'foot', sq: s, obj, state: 'advance', t: 1 + i, bound: 0 });
    }
    for (let i = 0; i < w.tank; i++) {
      const [x, z] = sp[(this.n + i + 2) % sp.length];
      const obj = objFor(); const v = g.makeVehicle('enemy', 'tank', x, z - 8, 0);
      const ow = OVERWATCH[obj][Math.floor(Math.random() * 2)];
      v.orderMove(ow[0], ow[1], 0, false);
      this.units.push({ kind: 'tank', v, obj, state: 'move', t: 2, home: ow });
    }
    if (g.hud && this.waveI > 1) g.hud.alert('Enemy movement reported to the north', 'bad');
  }
  stagingFor(obj) { const l = STAGING[obj]; return l[Math.floor(Math.random() * l.length)]; }
  objPos(obj) { const o = OBJECTIVES.find(o => o.id === obj); return [o.x, o.z]; }
  think(b) {
    const g = this.g;
    if (b.kind === 'tank') return this.thinkTank(b);
    const sq = b.sq;
    if (sq.destroyed) { b.dead = true; if (b.v && !b.v.destroyed) b.v.orderMove(...this.stagingFor(b.obj)); return; }
    // the objective the squad goes for: switch to whichever is still player-held
    const tgtObj = g.objectives.find(o => o.id === b.obj);
    if (tgtObj.owner === 'enemy' && b.state !== 'hold') { const other = g.objectives.find(o => o.owner === 'player'); if (other && Math.random() < 0.5) b.obj = other.id; }
    if (b.kind === 'mech' && b.state === 'approach') {
      const v = b.v;
      const arrived = !v.path || v.destroyed || v.immobile;
      const underFire = sq.underFireT < 2 || (v.hp < v.def.hp * 0.8);
      const near = Math.hypot(v.pos.x - this.objPos(b.obj)[0], v.pos.z - this.objPos(b.obj)[1]) < 150;
      if ((arrived || underFire || near) && sq.mounted) {
        if (!v.destroyed) { v.halt(); sq.dismount(Math.atan2(this.objPos(b.obj)[0] - v.pos.x, this.objPos(b.obj)[1] - v.pos.z)); }
        b.state = 'advance'; b.t = 4; b.bound = 0;
        // carrier: overwatch behind the squad
        b.vState = 'support';
      }
      return;
    }
    if (b.v && !b.v.destroyed && b.vState === 'support' && !sq.mounted) {
      const c = sq.center(); const d = b.v.pos.distanceTo(c);
      if (d > 70 && !b.v.path) { const [ox, oz] = this.objPos(b.obj); const back = new THREE.Vector3(c.x - ox, 0, c.z - oz).normalize(); const p = c.clone().addScaledVector(back, 35); b.v.orderMove(p.x, p.z); }
      if (b.v.hp < b.v.def.hp * 0.4 && !b.retreated) { b.retreated = true; const [x, z] = this.stagingFor(b.obj); b.v.orderMove(x, z - 60); }
    }
    if (sq.mounted) return;
    if (sq.routing) { b.state = 'routed'; return; }
    if (b.state === 'routed') { b.state = 'advance'; b.wait = 10; }
    // morale-driven behaviour
    const [ox, oz] = this.objPos(b.obj);
    const c = sq.center(); const dObj = Math.hypot(c.x - ox, c.z - oz);
    const moving = sq.effective.some(s => (s.path && s.pathI < s.path.length) || s.pathReq);
    if (b.wait > 0) { b.wait -= 1.5; return; }
    if (sq.morale < 32) { // go to ground, hold
      if (!moving && sq.underFireT < 3 && !sq.building) { const bld = this.nearBuilding(c, 30, sq); if (bld) sq.orderGarrison(bld); }
      b.wait = 8; return;
    }
    if (moving) return;
    if (b.state === 'hold') {
      // when holding a captured objective: stay; sometimes push to the other one
      if (g.objectives.every(o => o.owner === 'enemy')) return;
      if (Math.random() < 0.05) { b.state = 'advance'; b.obj = b.obj === 'A' ? 'B' : 'A'; }
      return;
    }
    if (dObj < 22) {
      b.state = 'hold';
      const bld = this.nearBuilding(new THREE.Vector3(ox, 0, oz), 30, sq);
      if (bld && Math.random() < 0.6) sq.orderGarrison(bld);
      return;
    }
    if (sq.building) { // leave the building to keep advancing when the coast is clearer
      if (sq.underFireT < 4 && Math.random() < 0.7) { b.wait = 6; return; }
    }
    // bounding: next position ~30–40 m along the path to the objective, in cover; run across open ground
    const path = g.nav.findPath(c.x, c.z, ox, oz, 0.45, false, 60000);
    if (!path || path.length < 2) { sq.orderMove(ox, oz, null, 16, true); return; }
    const step = dObj < 60 ? dObj + 5 : 30 + Math.random() * 12;
    let acc = 0, px = c.x, pz = c.z, tx = ox, tz = oz;
    for (const [x, z] of path) { const d = Math.hypot(x - px, z - pz); if (acc + d >= step) { const f = (step - acc) / d; tx = px + (x - px) * f; tz = pz + (z - pz) * f; break; } acc += d; px = x; pz = z; tx = x; tz = z; }
    const facing = Math.atan2(ox - tx, oz - tz);
    if (sq.underFireT < 5 && (b.smokes ?? 2) > 0 && Math.random() < 0.6) {
      const thrower = sq.effective.find(s => !s.inside); if (thrower) { b.smokes = (b.smokes ?? 2) - 1; g.combat.throwSmoke(thrower, new THREE.Vector3(ox, 0, oz)); b.wait = 0; }
    }
    const assault = dObj < 60 && sq.effective.length >= 3;
    sq.orderMove(tx, tz, facing, assault ? 14 : 18, assault || sq.underFireT > 6);
    b.bound++;
    b.wait = assault ? 2 : 6 + Math.random() * 8; // pause to shoot between bounds
  }
  nearBuilding(c, r, sq) {
    let best = null, bd = r;
    for (const bl of this.g.city.buildings) { const [lx, lz] = bl.toLocal(c.x, c.z); const d = Math.max(0, Math.abs(lx) - bl.L / 2) + Math.max(0, Math.abs(lz) - bl.D / 2); if (d < bd && bl.slots.some(s => !s.occupant) && ![...bl.slots].some(s => s.occupant && s.occupant.squad.side !== sq.side)) { bd = d; best = bl; } }
    return best;
  }
  thinkTank(b) {
    const v = b.v; if (v.destroyed) { b.dead = true; return; }
    if (v.crew < 2 || v.hp < v.def.hp * 0.35) { if (!b.retreating) { b.retreating = true; v.orderMove(b.home[0], b.home[1] - 80); } return; }
    if (v.path) return;
    // no targets for a while -> creep forward along the street towards the objective
    b.idle = v.target ? 0 : (b.idle || 0) + 1.5;
    if (b.idle > 20) {
      b.idle = 0; const [ox, oz] = this.objPos(b.obj); const d = Math.hypot(v.pos.x - ox, v.pos.z - oz);
      if (d > 90) { const p = v.pos.clone().lerp(new THREE.Vector3(ox, 0, oz), 40 / d); v.orderMove(p.x, p.z); }
    }
  }
}

// Simple defensive AI for the player side, used for automated balance testing (?autoplay=1).
export class AutoDefender {
  constructor(g) { this.g = g; this.t = 5; }
  update(dt) {
    const g = this.g; this.t -= dt; if (this.t > 0) return; this.t = 4;
    for (const u of g.unitsOf('player')) {
      if (u.type !== 'squad' || u.routing) continue;
      if (u.mounted && u.carrier && !u.carrier.path) { u.dismount(Math.PI); continue; }
      if (u.building || u.order) continue;
      // garrison the nearest building to the weaker objective
      const o = g.objectives.slice().sort((a, b) => a.control - b.control)[0];
      const bl = g.city.buildings.slice().sort((a, b) => Math.hypot(a.x - o.x, a.z - o.z) - Math.hypot(b.x - o.x, b.z - o.z)).find(b => b.slots.some(s => !s.occupant));
      if (bl && Math.random() < 0.5) u.orderGarrison(bl); else u.orderMove(o.x + (Math.random() - .5) * 20, o.z - 8, Math.PI, 18, true);
    }
    if (g.mortars > 0 && g.time > 120 && Math.random() < 0.05) { const e = g.unitsOf('enemy').filter(u => u.type === 'squad' && !u.mounted); if (e.length) { const c = e[0].center(); g.playerMortar(c.x, c.z); } }
  }
}
