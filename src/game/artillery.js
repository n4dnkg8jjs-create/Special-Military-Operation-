// Self-propelled howitzers: 2S19M2 Msta-S (RU, tracked, 360° turret, travel lock) and 2S22 Bohdana (UA, 6x6 truck,
// ±30° open mount, rear spades). Mixed into Vehicle for kind === 'spg'.
// States: deployed -> packing -> packed (can drive) -> deploying -> deployed. Fire missions come from the FIRE AT
// command (u.fireAt) and need no line of sight: the battery fires on map coordinates, rounds fly for several seconds
// and land with dispersion. Deploy / pack times and rates of fire follow the researched figures in
// assets/vehicles/manifest.json (msta_s.game / bohdana.game).
import * as THREE from 'three';
import { WEAPONS } from '../config.js';

const DEG = Math.PI / 180;
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

export const SpgMixin = {
  spgInit() {
    const N = n => this.model.getObjectByName(n);
    this.spg = { state: 'deployed', k: 1, mission: null, next: 0, cool: 0, idleT: 0, fired: 0, missions: 0 };
    this.spgNodes = { lock: N('travel_lock'), spades: [N('spade_L'), N('spade_R')].filter(Boolean) };
    this.coax = N('mg_muzzle') || this.coax;
    this.gunPitch = 0.3;          // starts emplaced, gun laid at a resting elevation
    this.spgPose();
  },
  get spgHold() { return this.kind === 'spg' && this.spg?.state !== 'packed'; },
  spgPose() {
    const S = this.spg, n = this.spgNodes, e = S.k * S.k * (3 - 2 * S.k);
    if (n.lock) n.lock.rotation.x = -45 * DEG * e;                       // A-frame folds onto the glacis
    for (const s of n.spades) s.rotation.x = -85 * DEG * e;              // spades lowered into the ground
  },
  spgStatus() {
    const S = this.spg; if (!S) return '';
    if (S.state === 'packing') return 'PACKING UP';
    if (S.state === 'deploying') return this.def.spades ? 'LOWERING SPADES' : 'EMPLACING';
    if (S.state === 'packed') return 'MOBILE';
    if (S.mission) return `FIRING · ${S.mission.left} RDS`;
    if (S.cool > 0) return 'RELOADING';
    return 'READY TO FIRE';
  },
  // laying elevation for the (high-angle, reduced-charge) fire on map distances
  spgElev(d, direct) { return direct ? THREE.MathUtils.clamp(0.004 + d / 90000, 0.004, 0.08) : THREE.MathUtils.clamp(0.62 + d / 2600, 0.62, 0.95); },
  // direct fire needs a clear line from the muzzle to the target point (buildings, terrain, tree crowns)
  spgSees(p) { const g = this.game, h = (this.pos.y || 0) + 2.8; return g.combat.los(this.pos.x, h, this.pos.z, p.x, (g.city.groundHeight?.(p.x, p.z) || 0) + 1.2, p.z, this, null); },
  spgUpdate(dt) {
    const S = this.spg, D = this.def, g = this.game, main = this.weapons[0];
    const travel = D.travelPitch || 0;
    S.next -= dt; S.cool -= dt;
    // a new fire mission from the FIRE AT order
    if (this.fireAt && !this.holdFire) {
      const p = this.fireAt.p.clone(); this.fireAt = null;
      const d = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
      const say = (m, k) => { if (globalThis.__hitlog) console.warn('SPG', m); if (this.side === 'player') g.hud?.alert(`${this.name}: ${m}`, k); };
      if (main.ammo <= 0) say('out of shells', 'bad');
      else if (d < 110) say('target too close to the gun position', 'bad');
      else if (this.gunDisabled) say('gun out of action', 'bad');
      else if (d < D.minRange && !(d <= D.directRange && this.spgSees(p))) say(`inside the ${D.minRange >= 1000 ? (D.minRange / 1000).toFixed(1) + ' km' : D.minRange + ' m'} minimum range for indirect fire, and no line of sight for direct fire`, 'bad');
      else {
        const direct = d < D.minRange;
        S.mission = { p, left: Math.min(D.salvo, main.ammo), first: true, direct };
        say(direct ? `direct fire, ${S.mission.left} × ${D.caliber} HE-Frag over open sights` : `fire mission, ${S.mission.left} × ${D.caliber} HE-Frag, flight time ~${Math.round(this.spgTof(d))} s${S.state !== 'deployed' ? ` (deploying first, ~${Math.round(D.deployT * (1 - S.k))} s)` : ''}`, 'good');
        if (this.side === 'player') g.sfx('radio');
        if (S.state === 'packed' && !this.path) S.state = 'deploying';
      }
    }
    const moving = !!(this.path && this.pathI < this.path.length);
    if (moving && (S.state === 'deployed' || S.state === 'deploying')) { S.state = 'packing'; if (this.side === 'player') g.hud?.alert(`${this.name}: packing up to move (~${Math.round(D.packT * S.k)} s)`); }
    if (moving && S.mission) S.mission = null;          // a move order cancels the fire mission
    // the target bearing relative to the hull; Bohdana's mount only covers ±30°, outside that the truck has to turn
    let bearing = 0;
    if (S.mission) bearing = angDiff(Math.atan2(S.mission.p.x - this.pos.x, S.mission.p.z - this.pos.z), this.heading);
    const outOfArc = S.mission && D.arc && Math.abs(bearing) > D.arc * 0.92;
    if (outOfArc && S.state === 'deployed') { S.state = 'packing'; S.pivot = true; if (this.side === 'player') g.hud?.alert(`${this.name}: target outside the ±30° sector, re-laying the vehicle`); }
    let wantYaw = this.turretYaw, wantPitch = this.gunPitch;
    switch (S.state) {
      case 'packing': {
        // stow the gun first (Bohdana: keep it above the cab lock while it traverses back), then the lock / spades
        wantYaw = 0; const centred = Math.abs(this.turretYaw) < 0.015;
        wantPitch = centred ? travel : Math.max(travel, 0.12);
        if (centred && Math.abs(this.gunPitch - travel) < 0.012) { S.k = Math.max(0, S.k - dt / D.packT); if (S.k === 0) { S.state = 'packed'; S.idleT = 0; if (this.side === 'player' && !S.pivot) g.hud?.alert(`${this.name}: packed, moving`); } }
        break;
      }
      case 'packed': {
        wantYaw = 0; wantPitch = travel;
        if (S.pivot && S.mission) {   // turn the hull onto the target bearing, then emplace again
          if (Math.abs(bearing) > 0.06) this.heading += THREE.MathUtils.clamp(bearing, -1, 1) * D.turnRate * 0.5 * dt;
          else { S.pivot = false; S.state = 'deploying'; }
          break;
        }
        S.idleT = !moving && Math.abs(this.speed) < 0.3 ? S.idleT + dt : 0;
        if (S.idleT > 5 || (S.mission && !moving && Math.abs(this.speed) < 0.3)) S.state = 'deploying';   // a halted gun emplaces itself
        break;
      }
      case 'deploying': {
        wantYaw = 0; wantPitch = travel;
        S.k = Math.min(1, S.k + dt / D.deployT);
        if (S.k === 1) { S.state = 'deployed'; if (this.side === 'player') g.hud?.alert(`${this.name}: emplaced, ready to fire`, 'good'); }
        break;
      }
      case 'deployed': {
        if (S.mission) {
          const d = Math.hypot(S.mission.p.x - this.pos.x, S.mission.p.z - this.pos.z);
          wantPitch = this.spgElev(d, S.mission.direct);
          wantYaw = D.arc ? THREE.MathUtils.clamp(bearing, -D.arc, D.arc) : bearing;
          if (D.arc && this.gunPitch < 0.09) wantYaw = this.turretYaw;          // lift off the cab lock before traversing
        } else wantPitch = Math.max(0.25, Math.min(this.gunPitch, 0.6));
        break;
      }
    }
    // slew: turret and elevation drives (researched speeds where published, otherwise estimates)
    const tr = D.turretSpeed * (this.turretJam ? 0.15 : 1) * dt, er = D.elevSpeed * dt;
    const dy = angDiff(wantYaw, this.turretYaw); this.turretYaw += THREE.MathUtils.clamp(dy, -tr, tr);
    this.gunPitch += THREE.MathUtils.clamp(wantPitch - this.gunPitch, -er, er);
    this.turretSlewing = Math.abs(dy) > 0.01;
    this.spgPose();
    // fire
    if (S.state === 'deployed' && S.mission && !this.gunDisabled && !this.holdFire && S.cool <= 0 && S.next <= 0) {
      const d = Math.hypot(S.mission.p.x - this.pos.x, S.mission.p.z - this.pos.z);
      const laid = Math.abs(angDiff(D.arc ? THREE.MathUtils.clamp(bearing, -D.arc, D.arc) : bearing, this.turretYaw)) < 0.012 && Math.abs(this.spgElev(d, S.mission.direct) - this.gunPitch) < 0.02;
      if (laid && main.ammo > 0 && S.mission.direct && !this.spgSees(S.mission.p)) { S.mission = null; if (this.side === 'player') g.hud?.alert(`${this.name}: lost sight of the target`, 'bad'); }
      else if (laid && main.ammo > 0) this.spgFire(S.mission, d);
      if (main.ammo <= 0 && S.mission) { S.mission = null; if (this.side === 'player') g.hud?.alert(`${this.name}: out of shells`, 'bad'); }
    }
    this.coaxFire(dt);
  },
  spgTof(d) { return 6 + d / 140; },
  spgFire(M, d) {
    const S = this.spg, D = this.def, g = this.game, main = this.weapons[0];
    main.ammo--; M.left--; S.fired++;
    S.next = D.interval * (this.crew < 4 ? 1.5 : 1) * (0.92 + Math.random() * 0.16);
    this.recoil = 1; this.firedT = 0; this.lastFireT = g.time;
    // muzzle blast along the barrel, dust kicked up around the vehicle, a long rolling report
    this.root.updateMatrixWorld(true);
    const f = this.muzzle ? this.muzzle.getWorldPosition(new THREE.Vector3()) : this.pos.clone().setY(3.5);
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion((this.gun || this.root).getWorldQuaternion(new THREE.Quaternion()));
    g.fx.muzzleBlastTank(f, dir); g.fx.muzzleBlastTank(f.clone().addScaledVector(dir, 1.2), dir);
    g.fx.vehicleDust(this.pos, 14); g.fx.vehicleDust(this.pos, 14);
    g.sfx('howitzer', this.pos); g.cam.addShake(Math.max(0, 0.9 - g.camDist(this.pos) / 300));
    if (g.camDist(this.pos) < 90) g.renderer.flash(0.05);
    // dispersion: the first round of a mission is the adjusting round, later rounds are corrected onto the target
    const sig = M.direct ? (0.8 + d * 0.003) / 1.1774 : (D.cep + d * 0.012) * (M.first ? 1.7 : 1) / 1.1774;   // CEP -> sigma
    M.first = false;
    const x = M.p.x + gauss() * sig, z = M.p.z + gauss() * sig;
    // direct fire: flat trajectory, ~800 m/s, no incoming whistle; indirect: high-angle, several seconds of flight
    g.strikes.push({ x, z, t: g.time + (M.direct ? 0.15 + d / 800 : this.spgTof(d)), side: this.side, whistled: M.direct, caliber: 'spg', owner: this, power: D.power });
    if (M.direct) g.fx.tracer(f, new THREE.Vector3(x, 1, z), 1400, [1, 0.8, 0.5]);
    if (M.left <= 0) { S.mission = null; S.cool = D.cool; S.missions++; if (this.side === 'player') g.hud?.alert(`${this.name}: rounds complete, ${main.ammo} shells left`); }
  },
};
