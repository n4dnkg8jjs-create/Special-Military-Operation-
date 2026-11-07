import * as THREE from 'three';
import * as Fallback from '../engine/fallback.js';
import { Vehicle } from './vehicle.js';
import { Squad, angDiff } from './squad.js';
import { clipDuration, hasClip } from './soldier.js';
import { SPAWNS, MAP_SIZE, DEPLOY_ZONES } from '../world/city.js';
import { TUNING } from '../config.js';

// Casualty evacuation: an unarmoured civilian double-cab pickup (assets/vehicles/pickup.glb, tools/blender/vehicles/pickup.py)
// with a driver and two medics, in player control on every battle (the enemy has one too, run by a simple AI).
//   * parked near wounded (critical / stable men of any friendly squad lying in the open within PICKUP_R), the medics get out of
//     the cab (medevac_cab_exit), run to them, lift them onto a shoulder (medevac_lift / wounded_lifted), carry them to the open
//     tailgate (medevac_carry_walk / wounded_carry_walk) and slide them onto the bed (medevac_load_bed / wounded_load_bed), where
//     they lie on the stretcher slots (wounded_on_bed) - up to CAP casualties - then climb back in (medevac_cab_enter);
//   * Evacuate (order bar / H / the EVAC marker at the road exit, on the map or the minimap, or a move order onto it): the truck
//     drives down the road where reinforcements come in and off the map, is away TRIP s (the drive to the casualty collection
//     point / aid station), the wounded count as saved (game.stats.evac, soldier.saved -> campaign collectResult), and it drives
//     back in along the same road.
// It plugs into the existing wounded system: casualties are the squads' own 'critical' / 'stable' men (squad.js buddy drag and
// treatment still run first); loaded men go to state 'evac' (out of the fight, counted as wounded) with soldier.onBed set so they
// stay drawn on the bed; the medics' squad is driven from here (Squad.update hook: squad.medevac).

export const CAP = 3, PICKUP_R = 45, TRIP = [60, 90];
export const MSTATES = ['ready', 'evac', 'exiting', 'away', 'returning'];   // (net/battle.js snapshots)
export const MEDIC_ROLES = [
  { role: 'Driver', weapon: 'ak74m', mags: 4, grenades: 0, leader: true, armor: 'light' },
  { role: 'Medic', weapon: 'ak74m', mags: 4, grenades: 0, medic: true, armor: 'light' },
  { role: 'Medic', weapon: 'ak74m', mags: 4, grenades: 0, medic: true, second: true, armor: 'light' },
];
const V3 = () => new THREE.Vector3();
const _v = V3(), _w = V3();
const CLIP = {
  exit: ['medevac_cab_exit', 'dismount_door'], enter: ['medevac_cab_enter', 'dismount_door'], lift: ['medevac_lift', 'treat_wounded'],
  carry: ['medevac_carry_walk', 'drag_wounded'], load: ['medevac_load_bed', 'crouch_idle'],
  cLift: ['wounded_lifted', 'being_dragged'], cCarry: ['wounded_carry_walk', 'being_dragged'], cLoad: ['wounded_load_bed', 'wounded_ground'], cBed: ['wounded_on_bed', 'wounded_ground'],
};
const clipOf = k => CLIP[k].find(hasClip) || CLIP[k][0];
const dur = (k, d) => clipDuration(clipOf(k), d);

export class MedevacTruck extends Vehicle {
  constructor(game, side, faction, mgr) {
    super(game, side, faction, 'medevac');
    this.mgr = mgr; this.noncombat = true;
    this.name = side === 'player' ? 'Medevac pickup' : 'Enemy medevac pickup';
    this.weapons = [{ key: 'pm', ammo: 0, cd: 0, burst: 0 }, { key: 'pkt', ammo: 0, cd: 0, burst: 0, coax: true }];
    this.supply = null; this.cage = 0;
    this.load = [];                 // casualties on the bed: soldier objects (slot = index)
    this.mstate = 'ready';          // ready | evac (heading for the exit) | exiting | away | returning
    this.medics = []; this.crewSq = null; this.tripT = 0; this.saved = 0;
  }
  build() {
    const A = this.game.assets, key = 'pickup', g = A.gltf[key];
    this.assetKey = key; this.vman = A.manifest?.vehicles?.vehicles?.[key] || {};
    const root = this.root = new THREE.Group();
    if (g) this.model = g.scene.clone(true); else { this.model = Fallback.vehicle('btr', 0xd9d8d0); this.fallback = true; }
    root.add(this.model);
    const N = n => this.model.getObjectByName(n);
    this.hull = N('hull') || this.model; this.turret = null; this.gun = null; this.muzzle = null; this.coax = null;
    this.exhaustN = N('exhaust'); this.roadwheels = []; this.trackMats = [];
    this.model.traverse(o => {
      if (o.isMesh) { o.castShadow = !o.material?.transparent; o.receiveShadow = true; }   // see-through cab glass casts no shadow into the cab
      if (o.userData?.hidden) o.visible = false;
      if (/_wreck$/i.test(o.name)) { o.visible = false; (this.wreckParts ||= []).push(o); }
      if (/_LOD1$/i.test(o.name)) { o.visible = false; (this.lod1 ||= []).push(o); }
    });
    this.lod0 = []; if (this.lod1) for (const l of this.lod1) { const b = this.model.getObjectByName(l.name.replace(/_LOD1$/i, '')); if (b) this.lod0.push(b); }
    this.wheels = ['wheel_L1', 'wheel_R1', 'wheel_L2', 'wheel_R2'].map(N).filter(Boolean);
    this.steerN = ['steer_L1', 'steer_R1'].map(N).filter(Boolean);
    const D = this.vman.doors || {};
    this.doors = {};
    for (const [n, ax, open] of [['door_FL', 'y', -1.19], ['door_FR', 'y', 1.19], ['door_RL', 'y', -1.26], ['door_RR', 'y', 1.26], ['tailgate', 'x', -1.571], ['canopy_door', 'x', 1.484]]) {
      const o = N(n); if (o) this.doors[n] = { o, ax: D[n]?.axis || ax, open: D[n]?.open ?? open, k: 0, until: 0, hold: false };
    }
    // faction identification on the shared model: tape bands in the side's tape colour (UA yellow / RU white), white V marks only on RU trucks
    const tape = N('id_tape'), ru = N('id_ru');
    if (tape?.material) { tape.material = tape.material.clone(); tape.material.color.setHex(this.faction?.tape ?? 0xf2c81a); }
    if (ru) ru.visible = this.faction?.id === 'RU';
    this.baseTurretRot = 0; this.baseGunRot = 0;
    this.game.scene.add(root);
  }
  // ------------------------------------------------------------------ status / HUD
  ammoFrac() { return this.load.length / CAP; }
  get onRoadOut() { return this.mstate === 'evac' || this.mstate === 'exiting'; }
  moraleState() {
    if (this.destroyed) return 'DESTROYED';
    if (this.mstate === 'away') return `AID STATION · ${Math.max(0, Math.ceil(this.tripT))}s`;
    if (this.mstate === 'exiting' || this.mstate === 'evac') return this.medicsOut() ? 'RECALLING MEDICS' : `EVACUATING ${this.load.length}`;
    if (this.mstate === 'returning') return 'RETURNING';
    if (this.burning) return 'ON FIRE';
    if (this.immobile) return 'IMMOBILISED';
    if (this.medicsOut()) return `COLLECTING ${this.load.length}/${CAP}`;
    return this.load.length ? `LOADED ${this.load.length}/${CAP}` : 'READY';
  }
  hudPanel(meter, row) {
    const hull = Math.max(0, this.hp / this.def.hp), med = this.medics.filter(m => m.i > 0 && m.s.effective).length;
    const meters = meter('Hull', hull, `${Math.round(hull * 100)}%`, hull < 0.35 ? 'bad' : hull < 0.65 ? 'warn' : 'friend')
      + meter('Casualties', this.load.length / CAP, `${this.load.length}/${CAP}`, this.load.length >= CAP ? 'warn' : 'ok')
      + meter('Medics', med / 2, `${med}/2`, med < 2 ? 'warn' : 'ok');
    let rows = row('Status', this.moraleState().toLowerCase());
    rows += row('Vehicle', 'civilian pickup · unarmoured');
    if (this.mstate === 'away') rows += row('Trip', `aid station · back in ${Math.max(0, Math.ceil(this.tripT))} s`);
    rows += row('Saved this battle', `${this.saved}`);
    const near = this.side === 'player' ? this.mgr.candidates(this, PICKUP_R * 4).length : 0;
    if (near) rows += row('Wounded nearby', `${near} (park within ${PICKUP_R} m)`);
    rows += row('Evacuate', this.load.length ? 'H / EVAC marker at the road exit' : 'load casualties first');
    return { meters, rows };
  }
  // ------------------------------------------------------------------ orders
  orderMove(x, z, facing = null, fast = true) {
    if (this.destroyed) return;
    if (this.mgr.nearExit(this.side, x, z)) { this.orderEvacuate(); return; }
    if (this.mstate !== 'ready') { if (this.side === 'player') this.game.hud?.alert(`${this.name}: on the evacuation run`); return; }
    if (this.medicsOut()) { this.queued = { x, z, facing }; this.recall(); return; }
    super.orderMove(x, z, facing, true);
  }
  orderAttack() {}
  halt() { super.halt(); this.queued = null; if (this.mstate === 'evac') { this.mstate = 'ready'; } }
  orderEvacuate() {
    if (this.destroyed || this.mstate !== 'ready') return false;
    if (!this.load.length) { if (this.side === 'player') this.game.hud?.alert(`${this.name}: no casualties aboard`); return false; }
    this.mstate = 'evac'; this.queued = null; this.recall();
    if (this.side === 'player') { this.game.hud?.alert(`${this.name}: evacuating ${this.load.length} wounded to the aid station`, 'good'); this.game.sfx('radio'); }
    return true;
  }
  aimAndFire() { this.target = null; this.coaxTarget = null; }
  // ------------------------------------------------------------------ frame
  update(dt) {
    if (this.mstate === 'away') { this.root.visible = false; return; }   // (off the map: not in game.vehicles, see Medevac.tick)
    if (this.destroyed) { this.scripted = null; super.update(dt); return; }
    if (this.scripted) { this.scriptDrive(dt); this.medicsInside(dt); this.cargo(); return; }
    super.update(dt);
    if (this.destroyed) return;
    this.crewSync();
    this.think(dt);
    this.updateMedics(dt);
    this.animDoorsM(dt);
    this.cargo();
  }
  sync() {
    super.sync();
    const d = this.dist || 0, R = this.vman.wheel_radius_m || 0.388;
    for (const w of this.wheels) w.rotation.x = d / R;
    // front wheel steering (bicycle model from the yaw rate)
    const sp = Math.abs(this.speed), want = sp > 0.5 ? THREE.MathUtils.clamp(Math.atan((this.angVel || 0) * 3.08 / sp), -0.6, 0.6) * Math.sign(this.speed) : (this.steerA || 0) * 0.9;
    this.steerA = THREE.MathUtils.lerp(this.steerA || 0, want, 0.25);
    for (const s of this.steerN) s.rotation.y = this.steerA;
    if (this.mstate === 'away') this.root.visible = false;
  }
  // ------------------------------------------------------------------ doors
  // the hardtop's rear lift door (canopy_door) goes up / down together with the tailgate
  door(n, on, t = 0) { if (n === 'tailgate') this.door('canopy_door', on, t); const D = this.doors[n]; if (!D) return; if (on) { D.until = Math.max(D.until, this.game.time + t); D.hold = t === 0; } else D.hold = false; }
  animDoorsM(dt) {
    for (const [n, D] of Object.entries(this.doors)) {
      const want = (D.hold || this.game.time < D.until) && Math.abs(this.speed) < 1 ? 1 : 0, k = D.k;
      const slow = n === 'tailgate' || n === 'canopy_door'; D.k = want > k ? Math.min(1, k + dt * (slow ? 1.6 : 2.4)) : Math.max(0, k - dt * (slow ? 1.2 : 2.4));
      if (D.k === k) continue;
      const e = D.k * D.k * (3 - 2 * D.k); D.o.rotation[D.ax] = D.open * e;
      if ((k === 0 && D.k > 0) || (k === 1 && D.k < 1)) this.game.sfx('hatch', this.pos, { gain: 0.5 });
    }
  }
  // ------------------------------------------------------------------ geometry helpers (world)
  node(n) { const o = this.model.getObjectByName(n); return o; }
  wpos(n, out = V3()) { const o = this.node(n); this.root.updateMatrixWorld(true); return o ? o.getWorldPosition(out) : out.copy(this.pos); }
  fwd(out = V3()) { return out.set(Math.sin(this.heading), 0, Math.cos(this.heading)); }
  left(out = V3()) { return out.set(Math.cos(this.heading), 0, -Math.sin(this.heading)); }   // model +X = the vehicle's left
  // medic i (1 or 2) exit / entry point beside his door (the clip's end root), facing away from the truck
  doorSpot(i) {
    const seat = this.wpos(i === 1 ? 'ride_seat_2' : 'ride_seat_3'), out = this.left().negate(), f = this.fwd();
    const p = seat.clone().addScaledVector(out, 0.62).addScaledVector(f, 0.10);
    p.y = this.groundY(p.x, p.z);
    return { p, h: Math.atan2(out.x, out.z), door: i === 1 ? 'door_FR' : 'door_RR' };
  }
  groundY(x, z) { return this.game.city.groundHeight?.(x, z) ?? 0; }
  slotPos(k, out = V3()) { return this.wpos(`stretcher_${k + 1}`, out); }
  loadSpot(k) {
    const lp = this.wpos('load_point'), st = this.node(`stretcher_${k + 1}`), xoff = st ? st.position.x : (k - 1) * -0.47;
    const p = lp.addScaledVector(this.left(), xoff); p.y = this.groundY(p.x, p.z);
    return { p, h: this.heading };
  }
  // ------------------------------------------------------------------ crew (medic squad)
  attachCrew(sq) {
    this.crewSq = sq; sq.medevac = this; sq.noncombat = true; sq.run = true;
    this.medics = sq.soldiers.map((s, i) => ({ s, i, task: 'in', t: 0 }));
    for (const s of sq.soldiers) { s.inside = 'btr'; s.inCab = true; s.pos.copy(this.pos); s.stance = 'stand'; s.sync(); }
  }
  // the driver and both medics stay drawn in their cab seats (soldier.inCab: aboard for the game logic, but visible): the
  // first frame of medevac_cab_exit is the seated pose, its root beside the seat (seat + 0.62 m to the truck's right + 0.10 m
  // forward, facing right) - for the medics that root is exactly their door spot, so exit / enter blend in and out of it
  seatMan(m, dt) {
    const s = m.s, seat = this.wpos(`ride_seat_${m.i + 1}`, _w), out = this.left().negate(), f = this.fwd();
    s.inCab = this.mstate !== 'away';
    s.pos.copy(seat).addScaledVector(out, 0.62).addScaledVector(f, 0.10); s.pos.y = seat.y - 0.84;
    s.heading = Math.atan2(out.x, out.z); s.vel.set(0, 0, 0);
    s.netClip = clipOf('exit'); s.netTs = 1e-4; s.netClipT = 0;
    if (s.inCab && s.animate) s.animate(dt, this.game.camDist(s.pos));
    s.sync();
  }
  medicsOut() { return this.medics.some(m => m.i > 0 && m.task !== 'in' && m.s.alive); }
  medicsInside(dt) { for (const m of this.medics) if (m.task === 'in' && m.s.alive) this.seatMan(m, dt); }
  // the armour model's crew hits (armor.js parts driver / commander / gunner) land on the men in the cab
  crewSync() {
    const roles = ['driver', 'commander', 'gunner'];
    this.medics.forEach((m, i) => {
      const c = this.crewList?.find(e => e.role === roles[i]); if (!c) return;
      if (m.task !== 'in' || !m.s.alive) { c.hp = m.s.alive ? 100 : 0; return; }
      if (c.hp <= 0 && m.s.effective) { m.s.die(null, { blast: true }); m.s.lostInVeh = true; this.game.onDeath(m.s, null, false); }
      else if (c.hp < 60 && m.s.state === 'ok') { m.s.state = 'light'; m.s.hp = c.hp; }
    });
    this.crew = Math.max(this.medics[0]?.s.effective ? 1 : 0, this.crewList?.filter(c => c.hp > 0).length ?? 1);
  }
  // updated from Squad.update (squad.medevac): the medics are driven here, not by the squad AI
  updateCrew(dt) { }
  recall() { for (const m of this.medics) if (m.i > 0 && (m.task === 'goto')) this.abandonTask(m); }
  abandonTask(m) {
    const c = m.cas; if (c) { c.medevacClaim = null; if (c.dragger === m.s) c.dragger = null; if (c.netClip && !c.onBed) c.netClip = null; }
    m.cas = null; this.goDoor(m);
  }
  // ------------------------------------------------------------------ think: start collecting when parked near wounded
  think(dt) {
    this.thinkCd = (this.thinkCd || 0) - dt; if (this.thinkCd > 0) return; this.thinkCd = 0.5;
    if (this.queued && !this.medicsOut()) { const q = this.queued; this.queued = null; super.orderMove(q.x, q.z, q.facing, true); return; }
    if (this.mstate === 'evac') {
      if (this.medicsOut()) return;
      this.exitTries ||= 0;
      if (!this.path && !this.pathReq && !this.exitPlanned) { const E = this.mgr.exitOf(this.side); this.exitPlanned = true; super.orderMove(E.p.x, E.p.z, E.h, true); }
      const E = this.mgr.exitOf(this.side);
      if (Math.hypot(this.pos.x - E.p.x, this.pos.z - E.p.z) < 9 || (!this.path && !this.pathReq && this.exitPlanned && Math.hypot(this.pos.x - E.p.x, this.pos.z - E.p.z) < 40)) this.startExit();
      else if (!this.path && !this.pathReq && this.exitPlanned) { this.exitPlanned = false; if (++this.exitTries > 4) this.startExit(); }   // no route: ask again, then just go
      return;
    }
    if (this.mstate !== 'ready' || Math.abs(this.speed) > 0.4 || this.path || this.pathReq) return;
    const free = CAP - this.load.length - this.medics.filter(m => m.cas).length;
    if (free <= 0) return;
    const C = this.mgr.candidates(this, PICKUP_R);
    for (const m of this.medics) {
      if (m.i === 0 || m.task !== 'in' || !m.s.effective || !C.length) continue;
      if (CAP - this.load.length - this.medics.filter(q => q.cas).length <= 0) break;
      const c = C.shift(); this.claim(m, c);
      this.startExitCab(m);
    }
  }
  claim(m, c) {
    m.cas = c; c.medevacClaim = m.s; c.dragger = m.s; c.path = null; c.crawl = false;
    for (const q of c.squad?.soldiers || []) if (q.dragging === c) { q.dragging = null; q.dragPhase = null; q.path = null; }   // the medic takes over from a mate
  }
  startExitCab(m) {
    const D = this.doorSpot(m.i), s = m.s;
    m.task = 'exit'; m.t = 0; m.T = dur('exit', 1.8);
    s.inside = null; s.inCab = false; s.pos.copy(D.p); s.heading = D.h; s.vel.set(0, 0, 0); s.path = null; s.goal = null;
    s.netClip = clipOf('exit'); s.netTs = 1; s.netClipT = null;
    this.door(D.door, true, m.T + 0.4 + m.i * 0.1);
    if (m.i === 1 || !this.medics[1]?.s.alive) this.door('tailgate', true);
  }
  goDoor(m) {
    const D = this.doorSpot(m.i), s = m.s;
    m.task = 'return'; m.t = 0; m.best = null; m.stuck = 0; m.force = false; s.goal = [D.p.x, D.p.z]; this.game.requestPath(s, s.pos.x, s.pos.z, D.p.x, D.p.z, 0.45); s.netClip = null;
  }
  // ------------------------------------------------------------------ the medics' tasks
  updateMedics(dt) {
    const g = this.game, sq = this.crewSq; if (!sq) return;
    for (const m of this.medics) {
      const s = m.s;
      if (!s.alive) { s.inCab = false; if (m.cas) this.dropCas(m); if (s.state === 'dead' || s.onBed) { s.animate(dt, g.camDist(s.pos)); s.sync(); } continue; }   // (a medic on the bed: his squad does not animate him)
      if (m.task === 'in') { this.seatMan(m, dt); continue; }
      if (!s.effective) {   // the medic himself is down: he becomes a casualty for the other one
        if (m.cas) this.dropCas(m);
        m.task = 'down'; s.netClip = null; s.inside = null; s.inCab = false;
        if (s.state === 'critical') { s.bleed -= dt; if (s.bleed <= 0) { s.die('death_crumple'); g.onDeath(s, null, true); } }
        s.vel.set(0, 0, 0); s.animate(dt, g.camDist(s.pos)); s.sync(); continue;
      }
      m.t += dt;
      s.suppression = Math.max(0, s.suppression - TUNING.suppressionDecay * dt);
      const c = m.cas;
      if (c && (c.state === 'dead' || (c.state === 'evac' && !c.onBed && m.task !== 'load'))) this.dropCas(m);
      switch (m.task) {
        case 'exit':
          if (m.t >= m.T) { s.netClip = null; if (m.cas) this.goCas(m); else this.goDoor(m); }
          break;
        case 'goto': {
          if (!m.cas) { this.goDoor(m); break; }
          const A = this.liftSpot(m);
          if (Math.hypot(s.pos.x - A.p.x, s.pos.z - A.p.z) < 0.45 || (!s.path && !s.pathReq && Math.hypot(s.pos.x - A.p.x, s.pos.z - A.p.z) < 1.6)) {
            s.pos.set(A.p.x, s.pos.y, A.p.z); s.heading = A.h; s.path = null; s.vel.set(0, 0, 0);
            m.task = 'lift'; m.t = 0; m.T = dur('lift', 2.6); s.netClip = clipOf('lift'); s.netTs = 1;
            const w = m.cas; w.dragger = s; w.netClip = clipOf('cLift'); w.netTs = 1; w.path = null; w.crawl = false;
          } else if (!s.path && !s.pathReq) { s.goal = [A.p.x, A.p.z]; g.requestPath(s, s.pos.x, s.pos.z, A.p.x, A.p.z, 0.45); }
          break;
        }
        case 'lift':
          if (m.t >= m.T) { m.task = 'carry'; m.t = 0; this.toLoad(m); }
          break;
        case 'carry': {
          const L = this.loadSpot(m.slot ?? this.freeSlot(m));
          if (Math.hypot(s.pos.x - L.p.x, s.pos.z - L.p.z) < 0.4 || (!s.path && !s.pathReq && Math.hypot(s.pos.x - L.p.x, s.pos.z - L.p.z) < 1.5)) {
            if (Math.abs(this.speed) < 0.5 && !this.scripted) {
              s.pos.set(L.p.x, s.pos.y, L.p.z); s.heading = L.h; s.path = null; s.vel.set(0, 0, 0);
              m.task = 'load'; m.t = 0; m.T = dur('load', 2.8); s.netClip = clipOf('load'); s.netTs = 1; m.cas.netClip = clipOf('cLoad');
              this.door('tailgate', true, m.T + 1.5);
            }
          } else if (!s.path && !s.pathReq) { s.goal = [L.p.x, L.p.z]; g.requestPath(s, s.pos.x, s.pos.z, L.p.x, L.p.z, 0.45); }
          break;
        }
        case 'load':
          if (m.t >= m.T) this.onBedNow(m);
          break;
        case 'return': {
          const D = this.doorSpot(m.i);
          if (this.mstate === 'ready' && Math.abs(this.speed) < 0.5 && !m.cas) {
            const more = this.load.length + this.medics.filter(q => q.cas).length < CAP ? this.mgr.candidates(this, PICKUP_R) : [];
            if (more.length && this.mstate === 'ready' && !this.queued) { this.claim(m, more[0]); this.goCas(m); break; }
          }
          // stuck guard: no 0.3 m of progress for 5 s -> new route; twice and within 4.5 m of the door -> he gets in anyway
          // (round the stern the hull push and the door spot inside the mirror-wide footprint can pin a man at a corner)
          const dd = Math.hypot(s.pos.x - D.p.x, s.pos.z - D.p.z);
          if (m.best == null || dd < m.best - 0.3) { m.best = dd; m.bestT = m.t; }
          else if (m.t - m.bestT > 5) { m.bestT = m.t; m.stuck = (m.stuck || 0) + 1; s.path = null; if (m.stuck >= 2 && dd < 4.5) m.force = true; }
          if (dd < 0.45 || m.force || (!s.path && !s.pathReq && dd < 1.6)) {
            m.force = false; m.best = null; m.stuck = 0;
            s.pos.set(D.p.x, s.pos.y, D.p.z); s.heading = D.h; s.path = null; s.vel.set(0, 0, 0);
            m.task = 'enter'; m.t = 0; m.T = dur('enter', 1.8); s.netClip = clipOf('enter'); s.netTs = 1; this.door(D.door, true, m.T);
          } else if (!s.path && !s.pathReq) { s.goal = [D.p.x, D.p.z]; g.requestPath(s, s.pos.x, s.pos.z, D.p.x, D.p.z, 0.45); }
          break;
        }
        case 'enter':
          if (m.t >= m.T) { m.task = 'in'; s.inside = 'btr'; s.inCab = true; s.netClip = null; if (!this.load.length && !this.medics.some(q => q.i > 0 && q.task !== 'in' && q.s.alive)) this.door('tailgate', false); }   // loaded: the tailgate stays down (litters + feet over it, as on real casevac pickups)
          break;
      }
      // movement (path following, collisions) and facing, then animation
      const moving = m.task === 'goto' || m.task === 'carry' || m.task === 'return';
      if (moving) {
        sq.run = true; s.speedMul = m.task === 'carry' ? 1.1 / 4.2 : 1; s.stance = 'stand';
        // final approach to a spot beside / behind the truck (door, tailgate): inside squad.js's hull push margin, so the push is
        // skipped for this truck over the last 2.2 m (the man would otherwise be slid round the hull forever)
        const near = s.goal && Math.hypot(s.pos.x - s.goal[0], s.pos.z - s.goal[1]) < 2.2 && m.task !== 'goto', d0 = this.destroyed;
        if (near) this.destroyed = true;
        try { sq.moveStep(s, dt); } finally { this.destroyed = d0; }
        if (s.vel.lengthSq() > 0.05) s.heading += THREE.MathUtils.clamp(angDiff(Math.atan2(s.vel.x, s.vel.z), s.heading), -5 * dt, 5 * dt);
      } else { s.vel.set(0, 0, 0); s.pos.y = this.groundY(s.pos.x, s.pos.z); }
      if (m.task === 'carry') { const sp = s.vel.length(); s.netClip = clipOf('carry'); s.netTs = THREE.MathUtils.clamp(sp / 1.14, 0.05, 1.6); }
      s.animate(dt, g.camDist(s.pos)); s.sync();
      this.pairCas(m);
    }
  }
  liftSpot(m) {
    const s = m.s, c = m.cas, d = _v.set(c.pos.x - s.pos.x, 0, c.pos.z - s.pos.z); const L = d.length();
    if (L < 1e-3) d.set(0, 0, 1); else d.multiplyScalar(1 / L);
    const p = V3().set(c.pos.x - d.x * 0.62, 0, c.pos.z - d.z * 0.62);
    const [fx, fz] = this.game.nav.nearestFree(p.x, p.z, 0.35, 3);
    return { p: V3().set(fx, 0, fz), h: Math.atan2(c.pos.x - fx, c.pos.z - fz) };
  }
  goCas(m) {
    const A = this.liftSpot(m), s = m.s; m.task = 'goto'; m.t = 0; s.netClip = null;
    s.goal = [A.p.x, A.p.z]; this.game.requestPath(s, s.pos.x, s.pos.z, A.p.x, A.p.z, 0.45);
  }
  freeSlot(m) {
    const used = new Set([...this.load.map(c => c.bedSlot), ...this.medics.filter(q => q !== m && q.slot != null).map(q => q.slot)]);
    for (let k = 0; k < CAP; k++) if (!used.has(k)) { m.slot = k; return k; }
    return m.slot = 0;
  }
  toLoad(m) { this.freeSlot(m); const L = this.loadSpot(m.slot), s = m.s; s.goal = [L.p.x, L.p.z]; this.game.requestPath(s, s.pos.x, s.pos.z, L.p.x, L.p.z, 0.45); }
  // the casualty in the medic's hands follows his root and stays in phase with his clip
  pairCas(m) {
    const c = m.cas, s = m.s; if (!c || !(m.task === 'lift' || m.task === 'carry' || m.task === 'load')) return;
    c.pos.copy(s.pos); c.heading = s.heading; c.vel.set(0, 0, 0); c.path = null; c.dragger = s;
    c.netClip = m.task === 'lift' ? clipOf('cLift') : m.task === 'carry' ? clipOf('cCarry') : clipOf('cLoad'); c.netTs = s.netTs || 1;
    if (c.mixer) { c.play(c.netClip, 0.2, c.netTs, ['wounded_ground']); if (c.cur && s.cur) { c.cur.time = Math.min(s.cur.time, c.cur.getClip().duration); c.mixer.update(0); } }
    c.sync();
  }
  dropCas(m) {
    const c = m.cas; m.cas = null; m.slot = null; if (!c) return;
    c.medevacClaim = null; if (c.dragger === m.s) c.dragger = null; c.netClip = null;
    if (c.alive && !c.onBed) { c.pos.y = this.groundY(c.pos.x, c.pos.z); c.sync(); }
    if (m.task === 'lift' || m.task === 'carry' || m.task === 'load') { if (m.s.effective) this.goDoor(m); }
  }
  onBedNow(m) {
    const c = m.cas, s = m.s; m.cas = null;
    if (c && c.state !== 'dead') {
      c.bedSlot = m.slot ?? this.load.length; c.state = 'evac'; c.onBed = this; c.dragger = null; c.medevacClaim = null; c.target = null; c.path = null;
      c.netClip = clipOf('cBed'); c.netTs = 1; c.inside = null;
      this.load.push(c);
      if (this.side === 'player') this.game.hud?.alert(`${this.name}: casualty loaded (${this.load.length}/${CAP})`, 'good');
    }
    m.slot = null; s.netClip = null;
    this.goDoor(m);
  }
  // casualties on the bed ride with the truck (drawn: soldier.onBed)
  cargo() {
    for (const c of this.load) {
      if (!c.onBed) continue;
      this.slotPos(c.bedSlot, c.pos); c.heading = this.heading + Math.PI; c.netClip = clipOf('cBed');
      c.root.visible = this.mstate !== 'away';   // (enemy pickups are drawn like every enemy unit: ui/contactMarkers.js)
      c.sync();
    }
  }
  // ------------------------------------------------------------------ the evacuation run
  startExit() {
    const E = this.mgr.exitOf(this.side);
    this.path = null; this.pathReq = null; this.exitPlanned = false; this.exitTries = 0;
    this.scripted = { mode: 'out', from: this.pos.clone(), dir: E.n.clone(), to: E.p.clone(), t: 0, edge: E.edge };
    this.mstate = 'exiting';
    for (const n of Object.keys(this.doors)) this.door(n, false);
  }
  scriptDrive(dt) {
    const S = this.scripted, def = this.def, g = this.game;
    S.t += dt;
    // out: steer for the exit point on the road first, then straight along the road off the map edge
    if (S.mode === 'out' && !S.onRoad && Math.hypot(this.pos.x - S.to.x, this.pos.z - S.to.z) < 6) S.onRoad = true;
    const dx = S.mode === 'out' && !S.onRoad ? S.to.x - this.pos.x : S.dir.x, dz = S.mode === 'out' && !S.onRoad ? S.to.z - this.pos.z : S.dir.z;
    const want = Math.atan2(dx, dz);
    const err = angDiff(want, this.heading);
    this.heading += THREE.MathUtils.clamp(err * 2.5, -def.turnRate, def.turnRate) * dt;
    this.angVel = THREE.MathUtils.clamp(err * 2.5, -def.turnRate, def.turnRate);
    const target = S.mode === 'out' ? def.speed * 1.2 : (S.remain > 18 ? def.speed : Math.max(2, S.remain * 0.6));
    this.speed += THREE.MathUtils.clamp(target - this.speed, -def.accel * 2 * dt, def.accel * dt);
    this.pos.x += Math.sin(this.heading) * this.speed * dt; this.pos.z += Math.cos(this.heading) * this.speed * dt;
    this.dist = (this.dist || 0) + this.speed * dt;
    const half = MAP_SIZE / 2;
    const inside = Math.abs(this.pos.x) < half - 1 && Math.abs(this.pos.z) < half - 1;
    this.pos.y = inside ? this.groundY(this.pos.x, this.pos.z) : this.pos.y;
    this.pitch = 0; this.roll = 0;
    this.fx(dt); this.sync();
    if (S.mode === 'out') {
      const beyond = Math.max(Math.abs(this.pos.x), Math.abs(this.pos.z)) - half;
      if (beyond > 35) this.goAway();
    } else {
      S.remain = Math.hypot(this.pos.x - S.to.x, this.pos.z - S.to.z);
      if (S.remain < 3 || S.t > 30) {
        this.scripted = null; this.mstate = 'ready'; this.root.visible = true;
        const B = this.mgr.homeOf(this.side); super.orderMove(B.x, B.z, B.h, true);
        if (this.side === 'player') g.hud?.alert(`${this.name} is back from the aid station`, 'good');
      }
    }
  }
  goAway() {
    const g = this.game;
    this.scripted = null; this.mstate = 'away'; this.speed = 0; this.root.visible = false; for (const m of this.medics) m.s.inCab = false; this.tripT = TRIP[0] + Math.random() * (TRIP[1] - TRIP[0]);
    this.awayPos = this.pos.clone(); this.backAt = g.time + this.tripT; this.leaving = true;   // Medevac.tick takes it out of game.vehicles (nobody can see / shoot it)
    this.target = null; this.seenBy = {}; this.detect = {}; this.spotted = false;
    const b = g.hud?.banners?.get(this); if (b) { b.el._sdisplay = 'none'; b.el.style.display = 'none'; }
    this.engine?.stop(); this.engineDrive?.stop(); this.engine = this.engineDrive = null;
    // the wounded reach the casualty collection point: saved
    const n = this.load.length;
    for (const c of this.load) { c.onBed = null; c.saved = true; c.root.visible = false; g.stats[this.side].evac++; }
    this.saved += n; this.load = []; this.door('tailgate', false);
    if (this.side === 'player') g.hud?.alert(`${this.name}: ${n} wounded handed over at the aid station — back in about ${Math.round(this.tripT)} s`, 'good');
  }
  comeBack() {
    const E = this.mgr.exitOf(this.side), p = this.awayPos || E.p.clone().addScaledVector(E.n, 40);
    this.pos.copy(p); this.pos.y = this.groundY(E.p.x, E.p.z); this.heading = Math.atan2(-E.n.x, -E.n.z); this.speed = this.def.speed * 0.8;
    if (!this.game.vehicles.includes(this)) this.game.vehicles.push(this);
    this.scripted = { mode: 'in', dir: E.n.clone().negate(), to: E.p.clone(), t: 0, remain: 99 };
    this.mstate = 'returning'; this.root.visible = true;
  }
  // ------------------------------------------------------------------ knocked out
  bailCrew() {
    if (this.abandoned) return; this.abandoned = true;
    const g = this.game, sq = this.crewSq, left = this.left(), f = this.fwd();
    // the casualties on the bed are thrown off / pulled out: back on the ground, bleeding again
    for (const c of this.load) {
      c.onBed = null; c.netClip = null; c.state = 'critical'; c.bleed = 40 + Math.random() * 80; c.dragger = null; c.medevacClaim = null;
      const k = c.bedSlot ?? 0; c.pos.copy(this.pos).addScaledVector(left, (k - 1) * 1.2 - 2.2).addScaledVector(f, -2.2); c.pos.y = this.groundY(c.pos.x, c.pos.z);
      if (Math.random() < 0.3) { c.die(null, { blast: true }); g.onDeath(c, null, false); }
      c.sync();
    }
    this.load = [];
    if (!sq) return;
    for (const m of this.medics) {
      const s = m.s; if (m.cas) this.dropCas(m);
      s.netClip = null; s.inCab = false;
      if (m.task === 'in' && s.alive) {
        if (Math.random() < 0.35) { s.die(null, { blast: true }); s.lostInVeh = true; g.onDeath(s, null, false); continue; }
        s.inside = null; s.pos.copy(this.pos).addScaledVector(left, -2.4 + m.i * 0.9).addScaledVector(f, m.i - 1); s.pos.y = this.groundY(s.pos.x, s.pos.z); s.sync();
      }
    }
    // the surviving crew become an ordinary (unarmoured) squad in the owner's hands
    sq.medevac = null; sq.noncombat = false; sq.name = `${this.name} crew`; sq.run = false;
    if (sq.effective.length) {
      if (this.side === 'player') { g.playerUnits?.push(sq); g.hud?.rebuildCards(); g.hud?.alert(`${this.name} destroyed — the crew got out`, 'bad'); }
      else g.commander?.adoptCrew?.(sq);
    }
  }
}

// ---------------------------------------------------------------------------------------------- manager: trucks, exits, HUD bits, AI
export class Medevac {
  // puppets (versus joiner, net/battle.js clientBattle): the host's two pickups, already built from the spawn manifest. They
  // are driven by the host's snapshots; the exits are the host's (the deploy zones are not swapped yet when this runs, so
  // the joiner's own road out is the host's 'enemy' one)
  constructor(game, puppets = null) {
    this.g = game; this.trucks = []; this.exits = {}; this.client = !!puppets;
    if (puppets) { this.exits.player = this.findExit('enemy'); this.exits.enemy = this.findExit('player'); for (const v of puppets) { v.mgr = this; this.trucks.push(v); } }
    else {
      for (const side of ['player', 'enemy']) this.exits[side] = this.findExit(side);
      for (const side of ['player', 'enemy']) this.spawn(side);
    }
    if (!game.noRender) this.marker();
    this.aiT = 0;
    if (puppets) return;
    // per-tick bookkeeping after the game's own update (the trip timer runs on game time: paused = stopped)
    const up = game.update.bind(game);
    game.update = dt => { up(dt); this.tick(); };
  }
  tick() {
    const g = this.g;
    for (const t of this.trucks) {
      if (t.leaving) { t.leaving = false; const i = g.vehicles.indexOf(t); if (i >= 0) g.vehicles.splice(i, 1); }
      if (t.mstate === 'away') { t.tripT = t.backAt - g.time; if (t.tripT <= 0) t.comeBack(); }
    }
    if (g.phase === 'deploy' || g.time < (this.aiAt || 0)) return; this.aiAt = g.time + 3;
    if (g.opts?.net) return;   // versus: the 'enemy' pickup is the other player's (orders from the joiner, net/battle.js)
    for (const t of this.trucks) if (t.side === 'enemy' && !t.destroyed && t.mstate === 'ready' && !t.medicsOut()) this.ai(t);
  }
  // the road on which reinforcements arrive: the side's spawn point on a road nearest its staging ground, leaving by the closest edge
  findExit(side) {
    const g = this.g, P = (side === 'player' ? SPAWNS.defender : SPAWNS.attacker) || [[0, side === 'player' ? MAP_SIZE / 2 - 20 : -MAP_SIZE / 2 + 20]];
    const Z = DEPLOY_ZONES[side], cx = Z ? (Z.x0 + Z.x1) / 2 : 0;
    const road = p => (g.nav.roadAt?.(p[0], p[1]) || 0) > 0;
    const best = [...P].sort((a, b) => (road(b) - road(a)) * 1000 + Math.abs(a[0] - cx) - Math.abs(b[0] - cx))[0];
    const n = Math.abs(best[1]) >= Math.abs(best[0]) ? new THREE.Vector3(0, 0, Math.sign(best[1]) || 1) : new THREE.Vector3(Math.sign(best[0]) || 1, 0, 0);
    const [fx, fz] = g.nav.nearestFree(best[0], best[1], 2.0, 30);
    const p = new THREE.Vector3(fx, 0, fz);
    return { p, n, h: Math.atan2(n.x, n.z), edge: MAP_SIZE / 2, icon: p.clone().addScaledVector(n, -6) };
  }
  exitOf(side) { return this.exits[side]; }
  homeOf(side) {
    const E = this.exits[side], p = E.p.clone().addScaledVector(E.n, -45);
    const [x, z] = this.g.inZone ? this.g.inZone(p.x, p.z, side, 6) : [p.x, p.z];
    return { x, z, h: Math.atan2(-E.n.x, -E.n.z) };
  }
  nearExit(side, x, z) { const E = this.exits[side]; return Math.hypot(x - E.icon.x, z - E.icon.z) < 14; }
  spawn(side) {
    const g = this.g, f = side === 'player' ? g.playerFaction : g.enemyFaction, H = this.homeOf(side);
    const [fx, fz] = g.nav.nearestFree(H.x, H.z, 2.0, 30);
    const v = new MedevacTruck(g, side, f, this); v.place(fx, fz, H.h); g.vehicles.push(v); this.trucks.push(v);
    const sq = new Squad(g, side, f, side === 'player' ? 'Medevac crew' : 'Enemy medevac crew', 'medevac', MEDIC_ROLES);
    sq.placeAt?.(fx, fz, H.h); g.squads.push(sq); v.attachCrew(sq);
    if (side === 'player') g.playerUnits?.push(v);
    return v;
  }
  // friendly casualties the medics could fetch: lying in the open (not in a building, not aboard), not already handled
  candidates(v, R) {
    const out = [];
    for (const sq of this.g.squads) {
      if (sq.side !== v.side) continue;
      for (const s of sq.soldiers) {
        if ((s.state !== 'critical' && s.state !== 'stable') || s.onBed || s.medevacClaim || s.aboard || s.inBuilding || s.cellar) continue;
        if (s.dragger && s.dragger.alive && s.dragger.dragging === s) continue;      // a mate is already dragging / treating him
        const d = Math.hypot(s.pos.x - v.pos.x, s.pos.z - v.pos.z); if (d > R) continue;
        out.push([s, d]);
      }
    }
    return out.sort((a, b) => a[1] - b[1]).map(e => e[0]);
  }
  selectedTrucks() { const h = this.g.hud; return h ? [...h.selected].filter(u => u instanceof MedevacTruck && !u.destroyed) : []; }
  playerTrucks() { return this.trucks.filter(t => t.side === 'player' && !t.destroyed); }
  evacuate(list = null) {
    const L = (list && list.length ? list : this.selectedTrucks().length ? this.selectedTrucks() : this.playerTrucks());
    let ok = false; for (const t of L) ok = t.orderEvacuate() || ok;
    if (ok) this.g.sfx('ui_order');
    return ok;
  }
  // ------------------------------------------------------------------ simple enemy AI (every 3 s from tick)
  ai(t) {
    const g = this.g;
    if (t.load.length >= CAP) { t.orderEvacuate(); return; }
    if (t.path || t.pathReq || Math.abs(t.speed) > 0.5) return;
    const near = this.candidates(t, PICKUP_R);
    if (near.length) return;             // the medics are about to go out (MedevacTruck.think)
    const far = this.candidates(t, 380).filter(s => !this.danger(s.pos, 'enemy', 70));
    if (far.length) { const s = far[0], d = V3().set(t.pos.x - s.pos.x, 0, t.pos.z - s.pos.z).normalize(); const [x, z] = g.nav.nearestFree(s.pos.x + d.x * 10, s.pos.z + d.z * 10, 2.0, 20); MedevacTruck.prototype.orderMove.call(t, x, z, null, true); return; }
    if (t.load.length) { t.orderEvacuate(); return; }
    const H = this.homeOf('enemy'); if (Math.hypot(t.pos.x - H.x, t.pos.z - H.z) > 30) MedevacTruck.prototype.orderMove.call(t, H.x, H.z, H.h, true);
  }
  danger(p, side, r) { for (const u of this.g.enemiesOf(side)) { if (u.noncombat) continue; const c = u.type === 'vehicle' ? u.pos : u.center(); if (Math.hypot(c.x - p.x, c.z - p.z) < r && this.g.seen(side, u)) return true; } return false; }
  // ------------------------------------------------------------------ the EVAC marker at the road exit (3D billboard + clickable label)
  marker() {
    const g = this.g, E = this.exits.player;
    const cv = document.createElement('canvas'); cv.width = cv.height = 128; const x = cv.getContext('2d');
    x.fillStyle = 'rgba(245,244,236,.95)'; x.beginPath(); x.arc(64, 64, 58, 0, 7); x.fill(); x.lineWidth = 6; x.strokeStyle = '#c62a22'; x.stroke();
    x.fillStyle = '#c62a22'; x.fillRect(52, 22, 24, 84); x.fillRect(22, 52, 84, 24);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sp.scale.set(5, 5, 1); sp.renderOrder = 6;
    const grp = new THREE.Group(); grp.add(sp); sp.position.y = 8;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 6, 6), new THREE.MeshBasicMaterial({ color: 0xe8e6dc })); pole.position.y = 3; grp.add(pole);
    const ring = new THREE.Mesh(new THREE.RingGeometry(5.2, 6, 40), new THREE.MeshBasicMaterial({ color: 0xc62a22, transparent: true, opacity: 0.55, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.25; grp.add(ring);
    grp.position.set(E.icon.x, this.g.city.groundHeight?.(E.icon.x, E.icon.z) || 0, E.icon.z); g.scene.add(grp);
    this.markerObj = grp; this.markerRing = ring;
    // clickable label anchored over the billboard
    const el = document.createElement('div'); el.className = 'evac-mark';
    el.innerHTML = '<b>EVAC</b><span>road to the aid station</span>';
    Object.assign(el.style, { position: 'fixed', left: '0', top: '0', zIndex: 6, pointerEvents: 'auto', cursor: 'pointer', font: '600 11px "Barlow SC", Barlow, sans-serif',
      color: '#f3f1e8', background: 'rgba(20,22,20,.78)', border: '1px solid #c62a22', borderRadius: '3px', padding: '2px 6px', display: 'none', whiteSpace: 'nowrap', textAlign: 'center', lineHeight: '1.15' });
    el.querySelector('span').style.cssText = 'display:block;font-weight:400;font-size:9.5px;opacity:.85';
    el.title = 'Evacuate: send the selected medevac pickup (or all of them) down this road to the aid station (H)';
    el.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); this.evacuate(); });
    document.body.appendChild(el); this.labelEl = el;
    // order-bar button
    const bar = document.getElementById('orders');
    if (bar && !bar.querySelector('[data-o="evacuate"]')) {
      const b = document.createElement('button'); b.dataset.o = 'evacuate'; b.dataset.k = 'H';
      b.dataset.tip = 'Evacuate: the medevac pickup drives the wounded down the road off the map to the aid station and comes back';
      b.innerHTML = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5z"/></svg><span class="ol">Evacuate</span>';
      const halt = bar.querySelector('[data-o="halt"]'); bar.insertBefore(b, halt || null);
      b.addEventListener('click', () => this.evacuate());
      this.btn = b;
    }
    addEventListener('keydown', e => { if (e.code === 'KeyH' && !e.repeat && !e.ctrlKey && !e.metaKey && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) this.evacuate(); });
  }
  // per frame from the HUD: label position / text, button state
  hudUpdate() {
    const g = this.g, el = this.labelEl; if (!el) return;
    const E = this.exits.player, cam = g.renderer.camera, v = _w.set(E.icon.x, (this.markerObj?.position.y || 0) + 10.6, E.icon.z).project(cam);
    const tr = this.playerTrucks(), sel = this.selectedTrucks(), ready = (sel.length ? sel : tr).some(t => t.mstate === 'ready' && t.load.length);
    const away = tr.find(t => t.mstate === 'away'), going = tr.find(t => t.mstate === 'evac' || t.mstate === 'exiting'), back = tr.find(t => t.mstate === 'returning');
    if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) el.style.display = 'none';
    else {
      el.style.display = 'block'; el.style.transform = `translate(${Math.round((v.x * 0.5 + 0.5) * innerWidth)}px,${Math.round((-v.y * 0.5 + 0.5) * innerHeight)}px) translate(-50%,-100%)`;
      const sub = away ? `aid station · back in ${Math.ceil(away.tripT)} s` : going ? 'medevac en route' : back ? 'medevac returning' : ready ? 'click: evacuate the wounded' : 'road to the aid station';
      if (el._sub !== sub) { el._sub = sub; el.querySelector('span').textContent = sub; }
      el.style.borderColor = ready ? '#e4a948' : '#c62a22';
    }
    if (this.markerRing) this.markerRing.material.opacity = ready ? 0.45 + 0.3 * Math.sin(performance.now() / 250) : 0.4;
    if (this.btn) { const dis = !ready; if (this.btn.disabled !== dis) this.btn.disabled = dis; }
  }
  // minimap: a red cross at the exit (+ the trip timer); a click on it evacuates
  drawMinimap(x, P) {
    const E = this.exits.player, half = MAP_SIZE / 2, cx = P(Math.max(-half + 8, Math.min(half - 8, E.icon.x))), cz = P(Math.max(-half + 8, Math.min(half - 8, E.icon.z)));
    x.fillStyle = 'rgba(245,244,236,.95)'; x.beginPath(); x.arc(cx, cz, 6.5, 0, 7); x.fill(); x.lineWidth = 1.2; x.strokeStyle = '#c62a22'; x.stroke();
    x.fillStyle = '#c62a22'; x.fillRect(cx - 1.4, cz - 4.5, 2.8, 9); x.fillRect(cx - 4.5, cz - 1.4, 9, 2.8);
    const away = this.playerTrucks().find(t => t.mstate === 'away');
    if (away) { x.fillStyle = '#ece8de'; x.font = '700 9px "Barlow SC", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'bottom'; x.fillText(`${Math.ceil(away.tripT)}s`, cx, cz - 8); }
    this.mmIcon = [cx, cz];
  }
  minimapClick(wx, wz) {
    const E = this.exits.player; if (Math.hypot(wx - E.icon.x, wz - E.icon.z) > MAP_SIZE * 0.03 + 6) return false;
    this.evacuate(); return true;
  }
}

// game.js: this.medevac = setupMedevac(this) after deploy (skirmish, campaign, versus host; the versus joiner's puppets
// are made by clientBattle during deploy: medevacPuppet + clientMedevac)
export function setupMedevac(game) {
  if (game.opts?.net?.role === 'client') return game.medevac || null;
  try { return new Medevac(game); } catch (e) { console.warn('medevac setup failed', e); return null; }
}
// versus joiner: one of the host's pickups (spawn manifest entry vm: x, z, h; side already from the joiner's point of view)
export function medevacPuppet(game, side, vm) {
  const v = new MedevacTruck(game, side, side === 'player' ? game.playerFaction : game.enemyFaction, null);
  v.medicsOut = () => !!v._mOut;   // (the medics' tasks run on the host: net/battle.js snapshots)
  v.place(vm.x, vm.z, vm.h); game.vehicles.push(v); return v;
}
export function clientMedevac(game, trucks) {
  if (!trucks.length) return null;
  try { return new Medevac(game, trucks); } catch (e) { console.warn('medevac (joiner) setup failed', e); return null; }
}
