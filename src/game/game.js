import * as THREE from 'three';
import { Renderer } from '../engine/renderer.js';
import { RTSCamera } from '../engine/camera.js';
import { Assets } from '../engine/assets.js';
import { City, OBJECTIVES, SPAWNS, BOUNDS, DEPLOY_ZONES } from '../world/city.js';
import { FX } from '../fx/particles.js';
import { Audio } from '../audio/sfx.js';
import { Squad } from './squad.js';
import { Vehicle } from './vehicle.js';
import { Combat } from './combat.js';
import { prepareSoldierAssets } from './soldier.js';
import { Commander, AutoDefender } from './ai.js';
import { FACTIONS, TUNING } from '../config.js';

const Q = new URLSearchParams(location.search);

export class Game {
  constructor(opts) {
    this.opts = opts; // {side:'UA'|'RU', minutes, quality}
    this.playerFaction = FACTIONS[opts.side]; this.enemyFaction = FACTIONS[opts.side === 'UA' ? 'RU' : 'UA'];
    this.squads = []; this.vehicles = []; this.pathQueue = [];
    this.time = 0; this.roundLen = opts.minutes * 60; this.paused = false; this.over = false; this.timeScale = +(Q.get('speed') || 1);
    this.stats = { player: { kia: 0, wia: 0, evac: 0, kills: 0, vehLost: 0 }, enemy: { kia: 0, wia: 0, evac: 0, kills: 0, vehLost: 0 } };
    this.mortars = TUNING.mortarStrikes; this.strikes = [];
    this.noRender = Q.has('norender');
  }
  async init(progress) {
    const canvas = document.getElementById('view');
    this.renderer = new Renderer(canvas, this.opts.quality);
    this.scene = this.renderer.scene;
    this.assets = new Assets();
    await this.assets.load((f, k) => progress(f * 0.65, `Loading ${k}`), this.renderer.r);
    progress(0.68, 'Loading sound library');
    this.audio = new Audio();
    await this.audio.init(f => progress(0.68 + f * 0.12, 'Loading sound library'));
    progress(0.82, 'Building Novozavodsk');
    await new Promise(r => setTimeout(r, 20));
    this.city = new City(this.scene, this.assets, this.opts.quality);
    this.city.build();
    this.nav = this.city.nav;
    progress(0.92, 'Deploying forces');
    this.fx = new FX(this.scene, this.renderer.sunDir, this.opts.quality);
    this.combat = new Combat(this);
    this.cam = new RTSCamera(this.renderer.camera, canvas, BOUNDS);
    prepareSoldierAssets(this.assets);
    this.objectives = OBJECTIVES.map(o => ({ ...o, control: 0, owner: 'neutral', lostT: 0, contested: false, captured: false }));
    this.phase = 'deploy';
    this.objectiveMarkers();
    this.zoneMarkers();
    this.deploy();
    this.commander = new Commander(this);
    if (Q.has('autoplay')) this.autoDef = new AutoDefender(this);
    // atmosphere: burning buildings & distant smoke columns
    for (const [x, z, s] of [[-150, -60, 1.2], [30, -68, 1.4], [-40, -60, 1], [150, -150, 0.8], [140, 70, 0.7]]) this.fx.emitter(new THREE.Vector3(x + (Math.random() - .5) * 20, 14, z), 'smoulder', 2 * s);
    for (const [x, z, s] of [[-320, -380, 1.4], [260, -420, 1.8], [420, -120, 1.1], [-460, 60, 1.2], [80, -520, 2.2]]) this.fx.emitter(new THREE.Vector3(x, 10, z), 'plume', s);
    for (const b of this.city.buildings) for (const p of b.panels) if (p.state === 3 && p.floor > 1 && Math.random() < 0.08) this.fx.emitter(b.panelCenter(p, new THREE.Vector3()), 'fire', 0.8);
    if (this.audio.ok) { this.audio.play('ambience_city', null, { gain: 0.8 }); this.audio.play('ambience_wind', null, { gain: 0.6 }); this.audio.play('ambience_battle', null, { gain: 0.5 }); }
    this.cam.lookAt(0, 140); this.cam.tYaw = 0.1; this.cam.tDist = 150;
    progress(1, 'Ready');
  }
  // ---------------------------------------------------------------- forces
  makeSquad(side, x, z, facing, n, kind = 'mech') {
    const f = side === 'player' ? this.playerFaction : this.enemyFaction;
    const sq = new Squad(this, side, f, `${n}`, kind); sq.placeAt(x, z, facing); this.squads.push(sq); return sq;
  }
  makeVehicle(side, kind, x, z, h) {
    const f = side === 'player' ? this.playerFaction : this.enemyFaction;
    const [fx, fz] = this.nav.nearestFree(x, z, kind === 'tank' ? 2.2 : 2.0, 30);
    const v = new Vehicle(this, side, f, kind); v.place(fx, fz, h); this.vehicles.push(v); return v;
  }
  garrison(sq, b) {
    sq.building = b;
    const free = b.slots.filter(s => !s.occupant && !s.panel.gone).sort((a, c) => sq.threatScore(b, c) - sq.threatScore(b, a));
    sq.soldiers.forEach((s, i) => { const sl = free[i]; if (!sl) return; sl.occupant = s; s.slotRef = sl; s.inside = sl; b.slotPos(sl, s.pos); const o = b.outward(sl.panel); s.heading = Math.atan2(o.x, o.z); s.stance = 'crouch'; s.sync(); });
  }
  deploy() {
    const N = Math.PI, S = 0; // facing north (−Z) / south (+Z)
    const pf = this.playerFaction, B = this.city.buildings;
    // --- player: motorized rifle company riding on armour at the southern edge
    const lineup = [[-112, 188, 'btr', '1st Squad'], [50, 186, 'btr', '2nd Squad'], [-6, 186, 'btr', '3rd Squad'], [-30, 187, 'tank', 'Assault Squad'], [140, 188, 'tank', null]];
    this.playerUnits = [];
    let bn = 1, tn = 1;
    for (const [x, z, kind, sqName] of lineup) {
      const v = this.makeVehicle('player', kind, x, z, N);
      v.name = kind === 'btr' ? `${pf.btrName} #${bn++}` : (pf.id === 'UA' ? `${pf.tankName} ${['"Hrim"', '"Ludmila"'][tn++ - 1]}` : `${pf.tankName} #21${tn++}`);
      this.playerUnits.push(v);
      if (sqName) {
        const sq = this.makeSquad('player', x, z + 6, N, sqName, kind === 'tank' ? 'assault' : 'mech'); sq.name = sqName;
        sq.board(v, true); this.playerUnits.splice(this.playerUnits.length - 1, 0, sq);
      }
    }
  }
  zoneMarkers() {
    this.zoneMeshes = [];
    for (const [side, z] of Object.entries(DEPLOY_ZONES)) {
      const col = side === 'player' ? 0x8fb069 : 0xc8483a, w = z.x1 - z.x0, d = z.z1 - z.z0;
      const g = new THREE.Group();
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.10, depthWrite: false }));
      fill.rotation.x = -Math.PI / 2; g.add(fill);
      const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [-w / 2, -d / 2]].map(([x, y]) => new THREE.Vector3(x, 0, y));
      const edge = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0), 64, 0.35, 4), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, depthWrite: false }));
      g.add(edge); g.position.set((z.x0 + z.x1) / 2, 0.2, (z.z0 + z.z1) / 2); g.renderOrder = 3;
      this.scene.add(g); this.zoneMeshes.push(g);
    }
  }
  // clamp a point into the player's staging ground (deployment phase)
  inZone(x, z, side = 'player', pad = 3) {
    const Z = DEPLOY_ZONES[side];
    return [Math.min(Z.x1 - pad, Math.max(Z.x0 + pad, x)), Math.min(Z.z1 - pad, Math.max(Z.z0 + pad, z))];
  }
  deployPlace(u, x, z, facing) {
    [x, z] = this.inZone(x, z);
    if (u.type === 'vehicle') {
      const [fx, fz] = this.nav.nearestFree(x, z, u.kind === 'tank' ? 2.2 : 2.0, 30); u.place(fx, fz, facing ?? u.heading); u.path = null;
      if (u.passengers?.mounted) u.passengers.board(u, true);
    } else if (u.mounted && u.carrier) this.deployPlace(u.carrier, x, z, facing);
    else { const [fx, fz] = this.nav.nearestFree(x, z, 0.5, 20); u.placeAt(fx, fz, facing ?? u.facing); for (const s of u.soldiers) { s.path = null; s.goal = null; s.pathReq = null; s.waitTeam = false; } u.order = null; }
  }
  startBattle() {
    if (this.phase !== 'deploy') return;
    this.phase = 'capture'; this.time = 0;
    for (const m of this.zoneMeshes) m.visible = false;
    this.commander.begin();
    this.hud?.battleStarted();
    this.sfx('radio'); this.sfx('ui_alert');
  }
  reinforce() {
    const [x, z] = SPAWNS.defender[Math.floor(Math.random() * SPAWNS.defender.length)];
    const v = this.makeVehicle('player', 'btr', x, z, Math.PI); v.name = `${this.playerFaction.btrName} #4`;
    const s = this.makeSquad('player', x, z, Math.PI, '4th Squad'); s.name = '4th Squad (reinf.)';
    s.board(v, true);
    v.orderMove(x, z - 70, Math.PI, true);
    this.playerUnits.push(s, v);
    this.hud?.alert('Reinforcements arriving from the south', 'good'); this.sfx('radio');
    this.hud?.rebuildCards();
  }
  unitsOf(side) { return [...this.squads.filter(s => s.side === side && !s.destroyed), ...this.vehicles.filter(v => v.side === side && !v.destroyed)]; }
  enemiesOf(side) { const o = side === 'player' ? 'enemy' : 'player'; return this.unitsOf(o); }
  rallyPoint(side) { const p = side === 'player' ? SPAWNS.defender : SPAWNS.attacker; const c = p[Math.floor(Math.random() * p.length)]; return [c[0], c[1] + (side === 'player' ? -15 : 15)]; }
  camDist(p) { const c = this.renderer.camera.position; return Math.hypot(p.x - this.cam.focus.x, p.z - this.cam.focus.z) * 0.6 + Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) * 0.4; }
  sfx(key, pos = null, opts) { if (this.audio?.ok) return this.audio.play(key, pos, opts); }
  hitSoldier(...a) { return this.combat.hitSoldier(...a); }
  // ---------------------------------------------------------------- pathing (time-sliced)
  requestPath(ent, sx, sz, tx, tz, clearance, vehicle = false) {
    ent.pathReq = { sx, sz, tx, tz, clearance, vehicle };
    if (!this.pathQueue.includes(ent)) this.pathQueue.push(ent);
  }
  servicePaths(budgetMs) {
    const t0 = performance.now();
    while (this.pathQueue.length && performance.now() - t0 < budgetMs) {
      const e = this.pathQueue.shift(), r = e.pathReq; if (!r) continue; e.pathReq = null;
      const p = this.nav.findPath(r.sx, r.sz, r.tx, r.tz, r.clearance, r.vehicle);
      e.path = p && p.length ? p : [[r.tx, r.tz]]; e.pathI = e.path.length > 1 ? 1 : 0;
    }
  }
  // ---------------------------------------------------------------- casualties / events
  onDeath(s, killer, bledOut) {
    const sq = s.squad;
    if (!bledOut) sq.onCasualty(s, true); else { sq.addMorale(-4); sq.stats.kia++; this.stats[sq.side].wia = Math.max(0, this.stats[sq.side].wia - 1); }
    this.stats[sq.side].kia++;
    if (killer && killer.squad) killer.squad.stats.kills++; else if (killer && killer.stats) killer.stats.kills++;
    if (this.camDist(s.pos) < 60) { this.sfx('body_fall', s.pos); if (Math.random() < 0.3) this.sfx('death', s.pos, { gain: 0.6 }); }
    if (s.slotRef) { s.slotRef.occupant = null; s.slotRef = null; }
    if (sq.destroyed && sq.side === 'player') this.hud?.alert(`${sq.name} has been wiped out`, 'bad');
  }
  bailOut(v, cas) {
    const sq = v.passengers; if (!sq) return;
    sq.dismount(v.heading + Math.PI);
    for (const s of sq.soldiers) if (s.effective && Math.random() < cas) this.combat.hitSoldier(s, { dmg: [40, 160], type: 'blast' }, v.pos, true);
    if (sq.side === 'player') this.hud?.alert(`${sq.name} bailed out of burning ${v.name}`, 'bad');
    sq.addMorale(-15);
  }
  passengerCasualties(v, p, owner) {
    const sq = v.passengers; if (!sq) return;
    for (const s of sq.soldiers) if (s.aboard && s.effective && Math.random() < p * (s.inside === 'ride' ? 1.4 : 1)) {
      s.hp -= 40 + Math.random() * 120;
      if (s.hp <= -20) { s.die(); this.onDeath(s, owner, false); } else if (s.hp <= 0) { s.state = 'critical'; s.bleed = 120; sq.onCasualty(s, false); this.stats[sq.side].wia++; }
    }
    sq.addMorale(-10);
    if (Math.random() < 0.6) this.bailOut(v, 0.1);
  }
  onVehicleLost(v) {
    this.stats[v.side].vehLost++;
    for (const sq of this.squads) if (sq.side === v.side && !sq.destroyed && sq.center().distanceTo(v.pos) < 60) sq.addMorale(-12);
    for (const sq of this.squads) if (sq.side !== v.side && !sq.destroyed && sq.center().distanceTo(v.pos) < 120) sq.addMorale(8);
    if (v.side === 'player') this.hud?.alert(`${v.name} destroyed!`, 'bad');
  }
  // ---------------------------------------------------------------- indirect fire
  callStrike(x, z, rounds, spread, side, delay, caliber = 'mortar') {
    for (let i = 0; i < rounds; i++) this.strikes.push({ x: x + (Math.random() - .5) * spread * 2, z: z + (Math.random() - .5) * spread * 2, t: this.time + delay + i * (0.8 + Math.random() * 1.2), side, whistled: false, caliber });
  }
  playerMortar(x, z) {
    if (this.mortars <= 0) return false;
    this.mortars--; this.callStrike(x, z, 6, 16, 'player', 9, 'mortar');
    this.hud?.alert(`82 mm mortar fire mission: 6 rounds, ${this.mortars} missions left`, 'good'); this.sfx('radio'); this.sfx('mortar_launch', null, { gain: 0.4 });
    this.mortarMarker(x, z);
    return true;
  }
  updateStrikes() {
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      if (!s.whistled && this.time > s.t - 1.4) { s.whistled = true; this.sfx('incoming_whistle', new THREE.Vector3(s.x, 20, s.z), { delay: false }); }
      if (this.time >= s.t) {
        this.strikes.splice(i, 1);
        const at = new THREE.Vector3(s.x, 0.1, s.z);
        // rounds landing on a building hit the roof/top floor
        const b = this.city.buildingAt(s.x, s.z, 0); if (b) at.y = b.floors * this.assets.kit.H - 0.5;
        this.combat.explode(at, s.caliber === 'arty' ? 2.2 : 1.3, null, s.caliber === 'arty' ? [120, 320] : [80, 220], s.caliber === 'arty' ? 11 : 8);
      }
    }
  }
  // ---------------------------------------------------------------- spotting
  // Symmetric spotting: each side only sees (and the AI only engages) what its units have line of sight to.
  spotFor(side) {
    const other = side === 'player' ? 'enemy' : 'player', spotters = [];
    for (const u of this.unitsOf(side)) {
      if (u.type === 'vehicle') spotters.push([u.pos.x, 2.6, u.pos.z, u.kind === 'tank' ? 190 : 220, u]);
      else for (const s of u.effective) if (s.inside !== 'btr') spotters.push([s.pos.x, s.pos.y + s.headHeight(), s.pos.z, s.inside === 'ride' ? 220 : 280, u.building]);
    }
    for (const u of this.unitsOf(other)) {
      const pts = u.type === 'vehicle' ? [[u.pos.x, 1.6, u.pos.z, null]] : u.effective.filter(s => s.inside !== 'btr').slice(0, 4).map(s => [s.pos.x, s.pos.y + s.headHeight(), s.pos.z, s.inBuilding ? u.building : null]);
      let seen = false;
      const fired = u.type === 'squad' ? (u.firedT ?? 99) < 3 : (u.firedT ?? 99) < 3;
      for (const [x, y, z, ign] of pts) {
        for (const sp of spotters) {
          const d = Math.hypot(sp[0] - x, sp[2] - z);
          if (d < 30 || (fired && d < 300)) { seen = true; break; }
          const range = sp[3] * (u.type === 'vehicle' ? 1.1 : 1) * (u.type === 'squad' && u.building ? 0.75 : 1);
          if (d > range) continue;
          if (this.combat.los(sp[0], sp[1], sp[2], x, y, z, sp[4], ign || u)) { seen = true; break; }
        }
        if (seen) break;
      }
      u.seenBy ||= {};
      if (seen) u.seenBy[side] = this.time;
      if (side === 'player') { u.spotted = u.seenBy.player != null && this.time - u.seenBy.player < 3; if (u.type === 'squad') for (const s of u.soldiers) s.visible = u.spotted || s.state === 'dead'; }
    }
  }
  updateSpotting() {
    this.spotFor('player'); this.spotFor('enemy');
    for (const sq of this.squads) if (sq.side === 'player') for (const s of sq.soldiers) s.visible = true;
  }
  // can `side` currently engage unit u (spotted recently or very close)?
  seen(side, u, from) { if (u.seenBy?.[side] != null && this.time - u.seenBy[side] < 4) return true; if (!from) return false; const p = u.type === 'vehicle' ? u.pos : (u._c ||= new THREE.Vector3()) && u.center(u._c); return Math.hypot(from.x - p.x, from.z - p.z) < 35; }
  // ---------------------------------------------------------------- objectives
  objectiveMarkers() {
    this.objMeshes = this.objectives.map(o => {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry(TUNING.captureRadius - 0.6, TUNING.captureRadius, 96), new THREE.MeshBasicMaterial({ color: 0x8fb069, transparent: true, opacity: 0.45, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.12; g.add(ring);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 6, 6), new THREE.MeshStandardMaterial({ color: 0x333333 })); pole.position.y = 3; g.add(pole);
      g.position.set(o.x, 0, o.z); this.scene.add(g); o.ring = ring; return g;
    });
  }
  updateObjectives(dt) {
    for (const o of this.objectives) {
      let p = 0, e = 0;
      for (const sq of this.squads) {
        if (sq.mounted || sq.routing || sq.destroyed) continue;
        for (const s of sq.soldiers) if (s.effective && s.inside !== 'btr' && Math.hypot(s.pos.x - o.x, s.pos.z - o.z) < TUNING.captureRadius) { if (sq.side === 'player') p++; else e++; }
      }
      for (const v of this.vehicles) if (!v.destroyed && Math.hypot(v.pos.x - o.x, v.pos.z - o.z) < TUNING.captureRadius) { if (v.side === 'player') p += 1.5; else e += 1.5; }
      o.contested = p > 0 && e > 0; o.p = p; o.e = e;
      const rate = TUNING.captureRate;
      if (e > 0 && p === 0) o.control -= rate * Math.min(6, e) * dt;
      else if (p > 0 && e === 0) o.control += rate * Math.min(6, p) * dt;
      else if (e > p * 2.5) o.control -= rate * 0.5 * dt;
      o.control = THREE.MathUtils.clamp(o.control, -100, 100);
      const prev = o.owner;
      if (o.control < -25 || (o.owner === 'player' && o.control < 0)) o.owner = 'enemy';
      else if (o.control > 25 || (o.owner === 'enemy' && o.control > 0 && false)) o.owner = 'player';
      if (prev !== o.owner) {
        if (o.owner === 'enemy') { this.hud?.alert(o.captured ? `Objective ${o.id} — ${o.name} LOST! Retake it within ${TUNING.lostObjectiveGrace}s` : `Enemy has seized ${o.name} — take it from them`, 'bad'); this.sfx('ui_alert'); }
        else { this.hud?.alert(`Objective ${o.id} — ${o.name} ${o.captured ? 'retaken' : 'CAPTURED'}`, 'good'); o.lostT = 0; o.captured = true; this.sfx('radio'); }
        if (this.phase === 'capture' && this.objectives.every(q => q.captured)) { this.phase = 'hold'; this.hud?.alert('Both objectives taken — dig in and HOLD until the end', 'good'); }
      }
      if (o.owner === 'enemy' && o.captured) o.lostT += dt; else o.lostT = 0;
      o.ring.material.color.set(o.owner === 'player' ? (o.contested ? 0xd8b25a : 0x8fb069) : o.owner === 'enemy' ? 0xc8483a : 0xb8b4a8);
    }
  }
  checkEnd() {
    if (this.over) return;
    const lost = this.objectives.filter(o => o.owner !== 'player');
    const playerAlive = this.unitsOf('player').length;
    let result = null;
    if (!playerAlive) result = { win: false, title: 'DEFEAT', why: 'Your company was destroyed.' };
    else if (lost.some(o => o.captured && o.lostT > TUNING.lostObjectiveGrace)) result = { win: false, title: 'DEFEAT', why: `${lost[0].name} fell and was not retaken.` };
    else if (lost.length === 2 && lost.every(o => o.captured && o.lostT > 30)) result = { win: false, title: 'DEFEAT', why: 'Both objectives were overrun.' };
    else if (this.time >= this.roundLen) result = lost.length ? { win: false, title: 'DEFEAT', why: lost.some(o => !o.captured) ? `${lost.find(o => !o.captured).name} was never taken.` : 'An objective was in enemy hands when time ran out.' } : { win: true, title: 'VICTORY', why: 'Both objectives captured and held to the end of the round.' };
    if (result) { this.over = true; this.result = result; this.sfx(result.win ? 'victory' : 'defeat'); this.hud?.showEnd(result); }
  }
  // ---------------------------------------------------------------- loop
  update(dt) {
    if (this.phase === 'deploy') { for (const sq of this.squads) { if (sq.mounted) sq.updateRiders(0.05, true); else for (const s of sq.soldiers) { s.animate(0.05, this.camDist(s.pos)); s.sync(); } } for (const v of this.vehicles) v.sync(); return; }
    if (this.paused || this.over) { this.servicePaths(4); return; }
    dt = Math.min(dt, 0.05) * this.timeScale;
    this.time += dt; globalThis.__gameTime = this.time;
    this.servicePaths(this.noRender ? 50 : 5);
    this.spotT = (this.spotT || 0) - dt; if (this.spotT <= 0) { this.spotT = 0.5; this.updateSpotting(); }
    for (const sq of this.squads) { sq.firedT = (sq.firedT ?? 99) + dt; if (!sq.destroyed || sq.alive.length) sq.update(dt); }
    for (const v of this.vehicles) v.update(dt);
    this.combat.update(dt);
    this.updateStrikes();
    this.commander.update(dt);
    this.autoDef?.update(dt);
    this.updateObjectives(dt);
    if (!this.reinforced && this.time > this.roundLen * 0.45) { this.reinforced = true; this.reinforce(); }
    this.checkEnd();
  }
  cullSoldiers() {
    const cam = this.renderer.camera; cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    (this._frustum ||= new THREE.Frustum()).setFromProjectionMatrix(this._pm = (this._pm || new THREE.Matrix4()).multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const sph = this._sph ||= new THREE.Sphere(new THREE.Vector3(), 2.2), f = this.cam.focus;
    for (const sq of this.squads) for (const s of sq.soldiers) {
      sph.center.set(s.pos.x, s.pos.y + 0.9, s.pos.z);
      s.inView = this._frustum.intersectsSphere(sph);
      const near = Math.hypot(s.pos.x - f.x, s.pos.z - f.z) < 70 + this.cam.dist * 0.3;
      if (near !== s.shadowOn) { s.shadowOn = near; s.root.traverse(o => { if (o.isMesh) o.castShadow = near; }); }
    }
  }
  frame(dt) {
    this.cullSoldiers();
    this.update(dt);
    this.cam.update(Math.min(dt, 0.05));
    this.renderer.followShadow(this.cam.focus); this.renderer.tick(dt); if (this.city.windUniform) this.city.windUniform.value += dt; this.city.updateFalling(Math.min(dt, 0.05) * (this.paused ? 0 : this.timeScale)); this.city.pool.finish();
    const cp = this.renderer.camera.position;
    this.fx.update(Math.min(dt, 0.05) * (this.paused ? 0 : this.timeScale), cp);
    for (const d of this.city.dynamic.children) if (d.userData.rise > 0) { const k = Math.min(d.userData.rise, dt * 0.8); d.position.y += k; d.userData.rise -= k; }
    if (this.audio.ok) { const f = this.cam.focus; this.audio.setListener({ x: f.x * 0.7 + cp.x * 0.3, y: 12 + (cp.y - 12) * 0.3, z: f.z * 0.7 + cp.z * 0.3 }, new THREE.Vector3(f.x - cp.x, 0, f.z - cp.z).normalize()); }
    this.hud?.update(dt);
    if (!this.noRender) this.renderer.render(dt, this.time);
  }
  mortarMarker(x, z) {
    const m = new THREE.Mesh(new THREE.RingGeometry(15, 16, 48), new THREE.MeshBasicMaterial({ color: 0xd8b25a, transparent: true, opacity: 0.6, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.15, z); this.scene.add(m);
    setTimeout(() => this.scene.remove(m), 16000);
  }
}
