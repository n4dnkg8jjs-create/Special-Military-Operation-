import * as THREE from 'three';
import * as Fallback from '../engine/fallback.js';
import { Vehicle } from './vehicle.js';
import { Squad, angDiff } from './squad.js';
import { hasClip } from './soldier.js';
import { cabPose, turnWheel } from './cabPose.js';
import { WEAPONS } from '../config.js';
import { SPAWNS } from '../world/city.js';

// ATGM pickup ('technical'): the white double-cab truck (assets/vehicles/pickup_atgm.glb, tools/blender/vehicles/pickup.py --atgm)
// with the side's anti-tank missile launcher standing on its tripod on a plywood deck in the bed - 9M133 Kornet (RU) /
// Stugna-P (UA), the same launcher models and missile data the dismounted ATGM teams use - and a three-man crew drawn aboard:
// driver and second man in the cab; the Kornet's gunner kneels behind the launcher in the bed (tailgate shut, his rifle laid on
// the deck under the tripod), the Stugna-P is laid from its remote panel by the third man on the cab's rear seat. Two spare
// missile containers lie in the bed. Fast, unarmoured (a rifle burst stops it, any AT round destroys it), six missiles.
//   * fires only halted, at spotted enemy VEHICLES inside the launcher's arc (this.arc either side of the truck's nose: the
//     tripod's legs are lashed down and only its head turns - the Kornet's gunner has to stay between the rear legs and the
//     spare containers, the Stugna's powered head turns freely), one missile in flight at a time, RELOAD s between shots
//     (+8 s when the second man is down)
//   * the crew squad is driven from here (squad.medevac hook, as the casualty-evacuation pickup's crew): aboard for the game
//     logic, visible in their seats; crew hits from the armour model land on the men; when the truck burns they get out and
//     fight on as an ordinary squad
//   * the enemy's truck runs a small routine of its own (think): stays behind its own armour, moves to where it can see known
//     player armour from 550-1100 m, halts and shoots, and shifts after each shot
// v1: skirmish battles only (one per side); not in campaign task groups or versus yet.

export const MSL = 6, RELOAD = 16, ARC = { kornet: 0.6, stugna: 1.75 }, SLEW = 0.8;
export const ATGM_TRUCK_ROLES = [
  { role: 'Driver', weapon: 'ak74m', mags: 4, grenades: 0, leader: true, armor: 'light' },
  { role: 'ATGM loader', weapon: 'ak74m', mags: 4, grenades: 0, armor: 'light', second: true },
  { role: 'ATGM gunner', weapon: 'ak74m', mags: 4, grenades: 0, armor: 'light' },
];
const V3 = () => new THREE.Vector3();
const _w = V3(), _a = V3();
const CAB_CLIP = ['medevac_cab_exit', 'dismount_door', 'crouch_idle'], AIM_CLIP = ['atgm_aim', 'crouch_idle'];
const clipOf = L => L.find(hasClip) || L[0];
const SEAT_DROP = [0.13, 0.13, 0.13];
/* tripod meshes: the triangles above the hub (traverse head, sight, cradle) go to a second mesh that turns; the legs stay put */
const HEAD_Y = { kornet: 0.625, stugna: 0.505 };
function splitHead(tripod, head, yCut) {
  const list = []; tripod?.traverse(o => { if (o.isMesh && !/_LOD1$/i.test(o.name) && !/_LOD1$/i.test(o.parent?.name || '')) list.push(o); });
  for (const m of list) {
    const g = m.geometry, P = g.attributes.position; if (!g.index || !P) continue;
    const sp = g.userData.atgmSplit || (g.userData.atgmSplit = (() => {
      const I = g.index.array, lo = [], hi = [];
      for (let i = 0; i < I.length; i += 3) (Math.min(P.getY(I[i]), P.getY(I[i + 1]), P.getY(I[i + 2])) >= yCut ? hi : lo).push(I[i], I[i + 1], I[i + 2]);
      const mk = idx => { const n = new THREE.BufferGeometry(); for (const k in g.attributes) n.setAttribute(k, g.attributes[k]); n.setIndex(idx); n.computeBoundingSphere(); n.computeBoundingBox(); return n; };
      return { legs: mk(lo), head: mk(hi) };
    })());
    const h = new THREE.Mesh(sp.head, m.material); h.name = m.name + '_head'; h.castShadow = m.castShadow; h.receiveShadow = m.receiveShadow;
    m.updateWorldMatrix(true, false); head.updateWorldMatrix(true, false);
    head.add(h); h.matrix.copy(head.matrixWorld).invert().multiply(m.matrixWorld); h.matrix.decompose(h.position, h.quaternion, h.scale);
    m.geometry = sp.legs;
  }
}

export class AtgmTruck extends Vehicle {
  constructor(game, side, faction) {
    super(game, side, faction, 'atgmtruck');
    this.rus = faction.id === 'RU'; this.sys = this.rus ? 'kornet' : 'stugna'; this.arc = ARC[this.sys];
    this.name = `${side === 'player' ? '' : 'Enemy '}${this.rus ? 'Kornet' : 'Stugna-P'} pickup`;
    this.atgm = { key: this.sys, ammo: MSL, cd: 4, fired: 0 };
    this.weapons = [{ key: this.sys, ammo: MSL, cd: 0 }, { key: 'pkt', ammo: 0, cd: 0, burst: 0, coax: true }];
    this.supply = null; this.cage = 0; this.crewSq = null; this.men = []; this.thinkCd = 2;
  }
  build() {
    const A = this.game.assets, key = 'pickup_atgm', g = A.gltf[key];
    this.assetKey = key; this.vman = A.manifest?.vehicles?.vehicles?.[key] || {};
    const root = this.root = new THREE.Group();
    if (g) this.model = g.scene.clone(true); else { this.model = Fallback.vehicle('btr', 0xd9d8d0); this.fallback = true; }
    root.add(this.model);
    const N = n => this.model.getObjectByName(n);
    this.hull = N('hull') || this.model; this.turret = null; this.gun = null; this.muzzle = null; this.coax = null;
    this.exhaustN = N('exhaust'); this.roadwheels = []; this.trackMats = [];
    this.model.traverse(o => {
      if (o.isMesh) { o.castShadow = !o.material?.transparent; o.receiveShadow = true; }
      if (o.userData?.hidden) o.visible = false;
      if (/_wreck$/i.test(o.name)) { o.visible = false; (this.wreckParts ||= []).push(o); }
      if (/_LOD1$/i.test(o.name)) { o.visible = false; (this.lod1 ||= []).push(o); }
    });
    this.lod0 = []; if (this.lod1) for (const l of this.lod1) { const b = this.model.getObjectByName(l.name.replace(/_LOD1$/i, '')); if (b) this.lod0.push(b); }
    this.wheels = ['wheel_L1', 'wheel_R1', 'wheel_L2', 'wheel_R2'].map(N).filter(Boolean);
    this.steerN = ['steer_L1', 'steer_R1'].map(N).filter(Boolean);
    const tape = N('id_tape'), ru = N('id_ru');
    if (tape?.material) { tape.material = tape.material.clone(); tape.material.color.setHex(this.faction?.tape ?? 0xf2c81a); }
    if (ru) ru.visible = this.faction?.id === 'RU';
    // the launcher on its tripod on the deck (the dismounted teams' model), two spare missile containers in the bed
    const rus = this.faction?.id === 'RU', sys = rus ? 'kornet' : 'stugna', mount = this.mount = N('atgm_mount'), src = A.gltf[sys];
    this.kit = []; this.spares = []; this.cabGunner = !rus;
    if (mount && src) {
      const L = this.launcher = src.scene.clone(true); this.kit.push(L);
      L.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; if (/_LOD1$/i.test(o.name)) o.visible = false; } });
      for (const n of ['folded', 'stugna_cable', 'stugna_control']) { const o = L.getObjectByName(n); if (o) o.visible = false; }   /* (the Stugna's remote panel is on its operator's knees in the cab) */
      mount.add(L);
      /* mount-local: +Z = the truck's front, bulkhead at +0.62, shut tailgate at -0.84, bed walls at +-0.77. The Stugna tripod's
         front foot reaches 0.68, so it stands 7 cm further back */
      L.position.set(0, 0, rus ? 0 : -0.07);
      /* only the head turns (v2 turned the whole tripod: its feet swept a 0.6 m circle through anything lying in the bed) */
      const head = this.head = new THREE.Group(); head.name = 'traverse'; L.add(head);
      const tube = L.getObjectByName(`${sys}_tube`);
      mount.updateWorldMatrix(true, true);
      splitHead(L.getObjectByName(`${sys}_tripod`), head, HEAD_Y[sys]);
      if (tube) head.add(tube);
      this.muzzle = L.getObjectByName('muzzle') || null;
      const seat = L.getObjectByName('seat'); this.seatLocal = (seat ? seat.position.clone() : V3().set(0.03, 0, -0.6)).add(L.position);
      /* spare containers (clean clones of the launcher's own tube). Kornet: one along each bed wall, clear of the rear feet (0.54)
         and the wall (0.77), front caps at the bulkhead - the gunner's feet pass behind them; Stugna: nobody rides in the bed,
         so both lie across the deck behind the tripod */
      const tm = tube && L.getObjectByName(`${sys}_tube_mesh`);
      if (tm) for (const k of [0, 1]) {
        const c = tm.clone(true); c.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        const bb = new THREE.Box3(); tm.traverse(o => { if (o.isMesh && !/_LOD1$/i.test(o.name)) { o.geometry.boundingBox || o.geometry.computeBoundingBox(); bb.union(o.geometry.boundingBox); } });   /* the tube about its own node */
        mount.add(c);
        if (rus) c.position.set((k ? -1 : 1) * 0.67, -bb.min.y + 0.004, 0.612 - bb.max.z);
        else { c.rotation.y = Math.PI / 2; c.position.set(0, -bb.min.y + 0.004, -0.37 - 0.035 - bb.max.x - k * (bb.max.x - bb.min.x + 0.02)); }
        this.spares.push(c); this.kit.push(c);
      }
    }
    // (v3: the tailgate stays shut - v2 lowered it as a firing step)
    this.baseTurretRot = 0; this.baseGunRot = 0;
    this.game.scene.add(root);
  }
  // ------------------------------------------------------------------ status / HUD
  ammoFrac() { return this.atgm.ammo / MSL; }
  gunnerOk() { const s = this.men[2]?.s; return !!s && s.effective && !this.abandoned; }
  moraleState() {
    if (this.destroyed) return 'DESTROYED';
    if (this.abandoned) return 'ABANDONED';
    if (this.burning) return 'ON FIRE';
    if (!this.gunnerOk()) return 'NO GUNNER';
    if (this.missileOut) return 'MISSILE IN FLIGHT';
    if (this.atgm.ammo <= 0) return 'OUT OF MISSILES';
    if (this.atgm.cd > 0 && this.atgm.fired) return `RELOADING · ${Math.ceil(this.atgm.cd)}s`;
    if (Math.abs(this.speed) > 1) return `MOVING · ${this.atgm.ammo} MSL`;
    return this.immobile ? 'IMMOBILISED' : `READY · ${this.atgm.ammo} MSL`;
  }
  hudPanel(meter, row) {
    const hull = Math.max(0, this.hp / this.def.hp), crew = this.men.filter(m => m.s.effective).length;
    const meters = meter('Hull', hull, `${Math.round(hull * 100)}%`, hull < 0.35 ? 'bad' : hull < 0.65 ? 'warn' : 'friend')
      + meter('Missiles', this.atgm.ammo / MSL, `${this.atgm.ammo}/${MSL}`, this.atgm.ammo <= 1 ? 'bad' : this.atgm.ammo <= 2 ? 'warn' : 'ok')
      + meter('Crew', crew / 3, `${crew}/3`, crew < 3 ? 'warn' : 'ok');
    let rows = row('Status', this.moraleState().toLowerCase());
    rows += row('Weapon', `${WEAPONS[this.sys].name} · ${Math.round(WEAPONS[this.sys].range / 100) / 10} km · vehicles only`);
    rows += row('Fires', `halted, within ${Math.round(this.arc * 57.3)}° of the nose`);
    rows += row('Armour', 'none: keep it out of sight of guns');
    return { meters, rows };
  }
  // ------------------------------------------------------------------ helpers (world)
  node(n) { return this.model.getObjectByName(n); }
  wpos(n, out = V3()) { const o = this.node(n); this.root.updateMatrixWorld(true); return o ? o.getWorldPosition(out) : out.copy(this.pos); }
  fwd(out = V3()) { return out.set(Math.sin(this.heading), 0, Math.cos(this.heading)); }
  left(out = V3()) { return out.set(Math.cos(this.heading), 0, -Math.sin(this.heading)); }
  groundY(x, z) { return this.game.city.groundHeight?.(x, z) ?? 0; }
  // ------------------------------------------------------------------ frame
  update(dt) {
    super.update(dt);
    if (this.destroyed) { if (this.crewSq) this.loseCrew(); return; }
    this.crewSync();
    this.seatCrew(dt);
    if (this.side === 'enemy' && !this.game.opts?.net) this.think(dt);
  }
  sync() {
    super.sync();
    const d = this.dist || 0, R = this.vman.wheel_radius_m || 0.388;
    for (const w of this.wheels) w.rotation.x = d / R;
    const sp = Math.abs(this.speed), want = sp > 0.5 ? THREE.MathUtils.clamp(Math.atan((this.angVel || 0) * 3.08 / sp), -0.6, 0.6) * Math.sign(this.speed) : (this.steerA || 0) * 0.9;
    this.steerA = THREE.MathUtils.lerp(this.steerA || 0, want, 0.25);
    for (const s of this.steerN || []) s.rotation.y = this.steerA;
    if (this.head) this.head.rotation.y = this.turretYaw;
    turnWheel(this);
    if (this.game.phase === 'deploy' && this.crewSq && !this.destroyed) this.seatCrew(1 / 60);
  }
  // the launcher follows the target inside its arc; a missile goes when the truck stands still, the tube is on, the last one
  // has landed and the gunner is at his sight
  aimAndFire(dt) {
    if (this.abandoned) { this.target = null; return; }
    if (this.stunT > 0) { this.stunT -= dt; return; }
    this.thinkT -= dt;
    if (this.thinkT <= 0) { this.thinkT = 0.6; this.game.combat.vehicleTargets(this); }
    const A = this.atgm, W = WEAPONS[A.key]; A.cd -= dt;
    let t = this.target; if (t && (t.type !== 'vehicle' || t.destroyed)) t = null;
    const bear = t ? angDiff(Math.atan2(t.pos.x - this.pos.x, t.pos.z - this.pos.z), this.heading) : 0;
    const ARC = this.arc, want = t ? THREE.MathUtils.clamp(bear, -ARC, ARC) : 0, d = angDiff(want, this.turretYaw);
    this.turretYaw += THREE.MathUtils.clamp(d, -SLEW * dt, SLEW * dt);
    if (!t || this.holdFire || !this.gunnerOk() || A.ammo <= 0 || A.cd > 0 || this.missileOut) return;
    const dist = Math.hypot(t.pos.x - this.pos.x, t.pos.z - this.pos.z);
    if (Math.abs(bear) > ARC || Math.abs(angDiff(bear, this.turretYaw)) > 0.04 || Math.abs(this.speed) > 1 || dist > W.range || dist < 70) return;
    A.ammo--; A.fired++; this.weapons[0].ammo = A.ammo;
    A.cd = RELOAD + (this.men[1]?.s.effective ? 0 : 8);
    this.game.combat.fireVehicleMissile(this, t, W);
    this.lastShotT = this.game.time;
    if (this.side === 'player') this.game.hud?.alert(`${this.name}: missile away (${A.ammo} left)`);
  }
  coaxFire() { }
  groundFire() { }
  // ------------------------------------------------------------------ crew (driven here: squad.medevac hook)
  attachCrew(sq) {
    this.crewSq = sq; sq.medevac = this; sq.noncombat = true; sq.run = true;
    this.men = sq.soldiers.map((s, i) => ({ s, i }));
    for (const s of sq.soldiers) { s.inside = 'btr'; s.inCab = true; s.pos.copy(this.pos); s.stance = 'stand'; s.sync(); }
  }
  updateCrew() { }   // (Squad.update hands the crew to the truck: seatCrew runs from update / sync)
  get medics() { return []; }   // (squad.js looks for casualty claims on a medevac crew: none here)
  seatCrew(dt) {
    const out = this.left().negate(), f = this.fwd(), cam = p => this.game.camDist(p);
    for (const m of this.men) {
      const s = m.s; if (!s || s.inside !== 'btr') continue;
      s.inCab = true; s.vel.set(0, 0, 0);
      if (m.i < 2 || this.cabGunner) {   // cab seats (the medevac crew's seated frame: root beside the seat, facing right)
        const seat = this.wpos(`ride_seat_${m.i + 1}`, _w);
        s.pos.copy(seat).addScaledVector(out, 0.62).addScaledVector(f, 0.06); s.pos.y = seat.y - 0.84 - SEAT_DROP[m.i];
        s.heading = Math.atan2(out.x, out.z);
        if (!s.alive) { if (!s.cabSlump) this.slump(s); s.sync(); continue; }
        s.netClip = clipOf(CAB_CLIP); s.netTs = 1e-4; s.netClipT = 0;
        if (s.weaponObj && s.weaponObj.visible && !s.dropped) { s.weaponObj.visible = false; s.slingUpdate?.(); }   /* rifles in the footwell: slung on his back it stood in the seat back */
      } else {         // the Kornet's gunner behind the launcher on the deck
        const yaw = this.turretYaw, c = Math.cos(yaw), sn = Math.sin(yaw), L = this.seatLocal || _a.set(0, 0, -0.62);
        const deck = this.wpos('atgm_mount', _w);
        s.pos.copy(deck).addScaledVector(this.left(), L.x * c + L.z * sn).addScaledVector(f, -L.x * sn + L.z * c); s.pos.y += L.y || 0;
        s.heading = this.heading + yaw;
        if (!s.alive) { if (!s.cabSlump) this.slump(s); s.sync(); continue; }
        s.netClip = clipOf(AIM_CLIP); s.netTs = 1; s.netClipT = null;
      }
      if (s.animate) s.animate(dt, cam(s.pos));
      s.sync();
      if (m.i < 2 || this.cabGunner) cabPose(s, this, m.i === 0); else this.stowRifle(s);
    }
  }
  // the bed gunner's rifle lies on the deck across the front of the bed, under the tripod's front leg (on his back its muzzle
  // stood over the tailgate)
  stowRifle(s) {
    const w = s.weaponObj; if (!w || s.dropped || s.wSock === 'truck' || !this.mount) return;
    this.mount.add(w); w.matrix.makeBasis(_a.set(0, -1, 0), V3().set(0, 0, -1), V3().set(1, 0, 0)); w.matrix.decompose(w.position, w.quaternion, w.scale);
    w.position.set(-0.14, 0.044, 0.40); w.visible = true; s.wSock = 'truck'; s.slingUpdate?.();
  }
  slump(s) { s.cabSlump = true; const N = n => s.model?.getObjectByName(n); N('Spine1')?.rotateX(0.35); N('Neck')?.rotateX(0.3); N('Head')?.rotateZ(0.35); }
  // the armour model's crew hits (armor.js parts driver / commander / gunner) land on the men aboard
  crewSync() {
    const roles = ['driver', 'commander', 'gunner'];
    for (const m of this.men) {
      const c = this.crewList?.find(e => e.role === roles[m.i]), s = m.s; if (!c || s.inside !== 'btr') continue;
      if (!s.alive) { c.hp = 0; continue; }
      if (c.hp <= 0 && s.effective) { s.die(null, { blast: true }); s.lostInVeh = true; this.game.onDeath(s, null, false); }
      else if (c.hp < 60 && s.state === 'ok') { s.state = 'light'; s.hp = c.hp; }
    }
    this.crew = Math.max(this.men[0]?.s.effective ? 1 : 0, this.crewList?.filter(c => c.hp > 0).length ?? 1);
  }
  // burning: whoever is alive gets out and fights on foot
  bailCrew() {
    if (this.abandoned) return; this.abandoned = true;
    const g = this.game, sq = this.crewSq, left = this.left(), f = this.fwd(); if (!sq) return;
    for (const m of this.men) {
      const s = m.s; s.netClip = null; s.inCab = false; if (!s.alive) continue;
      if (Math.random() < 0.25) { s.die(null, { blast: true }); s.lostInVeh = true; g.onDeath(s, null, false); continue; }
      s.inside = null; s.pos.copy(this.pos).addScaledVector(left, m.i === 0 ? 2.2 : -2.2).addScaledVector(f, m.i === 2 ? -2.6 : 0.4); s.pos.y = this.groundY(s.pos.x, s.pos.z);
      if (s.weaponObj && !s.dropped) { s.weaponObj.visible = true; if (s.wSock !== 'R') s.weaponTo?.('R'); }
      s.sync();
    }
    sq.medevac = null; sq.noncombat = false; sq.name = `${this.name} crew`; sq.run = false; this.crewSq = null;
    if (sq.effective.length) {
      if (this.side === 'player') { g.playerUnits?.push(sq); g.hud?.rebuildCards(); g.hud?.alert(`${this.name} abandoned — the crew got out`, 'bad'); }
      else g.commander?.adoptCrew?.(sq);
    }
  }
  // destroyed outright: the men aboard die with it
  loseCrew() {
    const g = this.game, sq = this.crewSq; this.crewSq = null; if (!sq) return;
    for (const m of this.men) { const s = m.s; if (s.inside !== 'btr') continue; s.inCab = false; if (s.alive) { s.die(null, { blast: true }); s.lostInVeh = true; g.onDeath(s, null, false); } }
    sq.medevac = null;
    for (const k of this.kit || []) k.visible = false;
    for (const m of this.men) if (m.s.wSock === 'truck' && m.s.weaponObj) m.s.weaponObj.visible = false;
  }
  // ------------------------------------------------------------------ the enemy's truck: a small routine of its own
  think(dt) {
    this.thinkCd -= dt; if (this.thinkCd > 0) return; this.thinkCd = 3;
    const g = this.game; if (this.abandoned || this.immobile || g.phase === 'deploy') return;
    if (this.path || this.pathReq || Math.abs(this.speed) > 0.5) return;
    const cmd = g.commander, home = (SPAWNS.attacker || [[0, -300]]).reduce((a, p) => [a[0] + p[0] / (SPAWNS.attacker || [1]).length, a[1] + p[1] / (SPAWNS.attacker || [1]).length], [0, 0]);
    const go = (x, z) => { const [fx, fz] = g.nav.nearestFree(x, z, 2.0, 30); this.orderMove(fx, fz, null, true); };
    const arm = (cmd?.intel?.armour?.(60) || []).map(e => ({ e, d: Math.hypot(e.x - this.pos.x, e.z - this.pos.z) })).sort((a, b) => a.d - b.d)[0];
    const shot = this.lastShotT != null && g.time - this.lastShotT < 3.5 && !this.shifted;
    if (shot) {   // shift after a shot: 40-60 m to a flank, a little back
      this.shifted = true; const l = this.left(), k = Math.random() < 0.5 ? 1 : -1, f = this.fwd();
      return go(this.pos.x + l.x * k * (40 + Math.random() * 20) - f.x * 15, this.pos.z + l.z * k * (40 + Math.random() * 20) - f.z * 15);
    }
    if (this.atgm.cd <= 2) this.shifted = false;
    if (this.target?.type === 'vehicle' && this.atgm.ammo > 0) {   // has a target: turn the nose to it if it is outside the arc, else stay
      const bear = angDiff(Math.atan2(this.target.pos.x - this.pos.x, this.target.pos.z - this.pos.z), this.heading);
      if (Math.abs(bear) > this.arc * 0.8) { const dx = this.target.pos.x - this.pos.x, dz = this.target.pos.z - this.pos.z, L = Math.hypot(dx, dz) || 1; go(this.pos.x + dx / L * 14, this.pos.z + dz / L * 14); }
      return;
    }
    if (this.atgm.ammo <= 0 || !this.gunnerOk()) { if (Math.hypot(this.pos.x - home[0], this.pos.z - home[1]) > 120) go(home[0], home[1] + 60); return; }
    if (arm) {
      // (a truck is no tank destroyer: it shoots from as far as it can see - it was driving up to 500 m and dying in two minutes)
      if (arm.d < 550) { const dx = this.pos.x - arm.e.x, dz = this.pos.z - arm.e.z, L = Math.hypot(dx, dz) || 1; return go(this.pos.x + dx / L * 200, this.pos.z + dz / L * 200); }   // too close: back off
      if (arm.d > 1100) { const dx = this.pos.x - arm.e.x, dz = this.pos.z - arm.e.z, L = Math.hypot(dx, dz) || 1; return go(arm.e.x + dx / L * 900 + (Math.random() - .5) * 80, arm.e.z + dz / L * 900 + (Math.random() - .5) * 80); }
      if (g.time - (this.peekT || 0) > 20) { this.peekT = g.time; const l = this.left(), k = Math.random() < 0.5 ? 1 : -1; return go(this.pos.x + l.x * k * 35, this.pos.z + l.z * k * 35); }   // in range, no line of sight: try another spot
      return;
    }
    // nothing known: follow the own tanks, 250 m behind the nearest
    const tk = g.vehicles.filter(v => v.side === this.side && v.kind === 'tank' && !v.destroyed).sort((a, b) => a.pos.distanceTo(this.pos) - b.pos.distanceTo(this.pos))[0];
    if (tk) { const dx = home[0] - tk.pos.x, dz = home[1] - tk.pos.z, L = Math.hypot(dx, dz) || 1, tx = tk.pos.x + dx / L * 250, tz = tk.pos.z + dz / L * 250; if (Math.hypot(tx - this.pos.x, tz - this.pos.z) > 90) go(tx, tz); }
  }
}

// one truck per side in a skirmish battle (not in campaign task groups or versus yet)
export function setupAtgmTrucks(game) {
  if (game.opts?.net || game.campaign || !game.assets?.gltf?.pickup_atgm) return [];
  const out = [];
  try {
    for (const side of ['player', 'enemy']) {
      const f = side === 'player' ? game.playerFaction : game.enemyFaction;
      const H = game.medevac?.homeOf?.(side); if (!H) continue;
      const lx = Math.cos(H.h), lz = -Math.sin(H.h);
      const [fx, fz] = game.nav.nearestFree(H.x + lx * 9, H.z + lz * 9, 2.0, 30);
      const v = new AtgmTruck(game, side, f); v.place(fx, fz, H.h); game.vehicles.push(v);
      const sq = new Squad(game, side, f, `${v.name} crew`, 'medevac', ATGM_TRUCK_ROLES);
      sq.placeAt?.(fx, fz, H.h); game.squads.push(sq); v.attachCrew(sq);
      if (side === 'player') game.playerUnits?.push(v);
      out.push(v);
    }
  } catch (e) { console.warn('ATGM truck setup failed', e); }
  return out;
}
