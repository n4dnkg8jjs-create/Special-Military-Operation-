import * as THREE from 'three';
import { vegetationLOS, vegetationTrunks } from '../world/vegetation.js';
import { deployCampaign } from './campaignBattle.js';
import { hostBattle, clientBattle, clientFrame } from '../net/battle.js';
import { Renderer } from '../engine/renderer.js';
import { RTSCamera } from '../engine/camera.js';
import { Assets } from '../engine/assets.js';
import { City, OBJECTIVES, SPAWNS, BOUNDS, DEPLOY_ZONES, MAP, setMap, mulberry } from '../world/city.js';
import { Farmland } from '../world/farmland.js';
import { updateLods, simplifierReady } from '../world/instancer.js';
import { FX } from '../fx/particles.js';
import { Audio } from '../audio/sfx.js';
import { Squad } from './squad.js';
import { Vehicle } from './vehicle.js';
import { Combat } from './combat.js';
import { CQB } from './cqb.js';
import { buildHouses } from '../world/houses.js';
import { prepareSoldierAssets } from './soldier.js';
import { Commander, AutoDefender } from './ai.js';
import { setupMedevac } from './medevac.js';
import { FACTIONS, TUNING } from '../config.js';

const Q = new URLSearchParams(location.search);

export class Game {
  constructor(opts) {
    this.opts = opts; // {side:'UA'|'RU', minutes, quality}
    this.campaign = opts.campaign || null;
    this.playerFaction = FACTIONS[opts.side]; this.enemyFaction = FACTIONS[opts.side === 'UA' ? 'RU' : 'UA'];
    this.squads = []; this.vehicles = []; this.pathQueue = [];
    this.time = 0; this.roundLen = opts.minutes * 60; this.paused = false; this.over = false; this.timeScale = +(Q.get('speed') || 1);
    this.stats = { player: { kia: 0, wia: 0, evac: 0, kills: 0, vehLost: 0 }, enemy: { kia: 0, wia: 0, evac: 0, kills: 0, vehLost: 0 } };
    this.mortars = TUNING.mortarStrikes; this.strikes = [];
    // tickets (see TUNING.tickets): game.tickets = { player, enemy, max }, game.ticketDrain = { player, enemy } in
    // tickets per minute currently draining each side (objective bleed + losses over the last minute)
    const tmax = Math.round(TUNING.tickets * THREE.MathUtils.clamp((opts.minutes || 12) / 12, 0.75, 1.5) / 10) * 10;
    this.tickets = { player: tmax, enemy: tmax, max: tmax }; this.ticketDrain = { player: 0, enemy: 0 };
    this.ticketLog = { player: [], enemy: [] };   // [time, tickets] of recent losses (drain rate)
    this.noRender = Q.has('norender') || (() => { try { return localStorage.getItem('smo_norender') === '1'; } catch { return false; } })();
    setMap(opts.map || 'city'); this.map = MAP;
  }
  async init(progress) {
    const canvas = document.getElementById('view');
    this.renderer = new Renderer(canvas, this.opts.quality);
    this.scene = this.renderer.scene;
    this.assets = new Assets();
    await this.assets.load((f, k) => progress(f * 0.65, `Loading ${k}`), this.renderer.r, { rural: MAP.kind === 'rural' });
    progress(0.68, 'Loading sound library');
    this.audio = new Audio();
    await this.audio.init(f => progress(0.68 + f * 0.12, 'Loading sound library'));
    progress(0.82, `Building ${MAP.name}`);
    await new Promise(r => setTimeout(r, 20)); await simplifierReady;   // (distance LODs for heavy templates: world/instancer.js)
    // world generation is fully seeded so a map looks identical on every load
    const rnd = Math.random; Math.random = mulberry(MAP.sizeM * 31 + (MAP.kind === 'rural' ? 7 : 3));
    this.city = new (MAP.kind === 'rural' ? Farmland : City)(this.scene, this.assets, this.opts.quality);
    if (MAP.fog && this.scene.fog) this.scene.fog.density = MAP.fog;
    try { this.city.build(); } finally { this.genRandom = Math.random; }
    this.nav = this.city.nav; this.nav.roadDist?.();   // road-centre distance field for vehicle routing, built once up front
    this.vegOcc = vegetationLOS(this.nav); this.trunkN = vegetationTrunks();   // tree trunks stop rounds (combat.js)
    this.houses = buildHouses(this);   // private houses: garrisonable, with a cellar (world/houses.js)
    progress(0.92, 'Deploying forces');
    this.fx = new FX(this.scene, this.renderer.sunDir, this.opts.quality);
    this.combat = new Combat(this); this.cqb = new CQB(this);   // building clearing (game/cqb.js)
    this.cam = new RTSCamera(this.renderer.camera, canvas, BOUNDS);
    prepareSoldierAssets(this.assets);
    this.objectives = OBJECTIVES.map(o => ({ ...o, control: 0, owner: 'neutral', lostT: 0, contested: false, captured: false }));
    this.phase = 'deploy';
    this.objectiveMarkers();
    this.zoneMarkers();
    this.deploy();
    this.medevac = setupMedevac(this);   // casualty-evacuation pickup + medics for both sides (game/medevac.js)
    const net = this.opts.net;
    this.commander = net ? { update() {}, begin() {}, adoptCrew() {}, plan: [], waveI: 0 } : new Commander(this);   // versus: the other side is a human
    if (net) this.reinforced = true;   // no scripted reinforcements in versus
    if (net?.role === 'host') hostBattle(this, net.peer);
    if (net?.role === 'client') { const Z = DEPLOY_ZONES, a = Z.player; Z.player = Z.enemy; Z.enemy = a; for (const m of this.zoneMeshes || []) this.scene.remove(m); this.zoneMarkers(); }
    if (Q.has('autoplay')) this.autoDef = new AutoDefender(this);
    // atmosphere: burning buildings & distant smoke columns
    for (const [x, z, s] of MAP.smoulder) this.fx.emitter(new THREE.Vector3(x + (Math.random() - .5) * (MAP.kind === 'rural' ? 6 : 20), MAP.kind === 'rural' ? 6 : 14, z), 'smoulder', 2 * s);
    for (const [x, z, s] of MAP.plumes) this.fx.emitter(new THREE.Vector3(x, 10, z), 'plume', s);
    for (const b of this.city.buildings) for (const p of b.panels) if (p.state === 3 && p.floor > 1 && Math.random() < 0.08) this.fx.emitter(b.panelCenter(p, new THREE.Vector3()), 'fire', 0.8, undefined, { b, p });
    Math.random = rnd;
    if (this.audio.ok) { this.audio.play(MAP.ambience || 'ambience_city', null, { gain: 0.8 }); this.audio.play('ambience_wind', null, { gain: 0.6 }); this.audio.play('ambience_battle', null, { gain: 0.5 }); }
    this.cam.lookAt(MAP.cam[0], MAP.cam[1]); this.cam.tYaw = 0.1; this.cam.tDist = MAP.cam[2];
    if (net?.role === 'client') { const Z = DEPLOY_ZONES.player; this.cam.lookAt((Z.x0 + Z.x1) / 2, (Z.z0 + Z.z1) / 2 - 60); this.cam.tYaw = Math.PI + 0.1; }
    progress(1, 'Ready');
  }
  // ---------------------------------------------------------------- forces
  makeSquad(side, x, z, facing, n, kind = 'mech', roles = null) {
    const f = side === 'player' ? this.playerFaction : this.enemyFaction;
    const sq = new Squad(this, side, f, `${n}`, kind, roles); sq.placeAt(x, z, facing); this.squads.push(sq); return sq;
  }
  makeVehicle(side, kind, x, z, h) {
    const f = side === 'player' ? this.playerFaction : this.enemyFaction;
    const [fx, fz] = this.nav.nearestFree(x, z, kind === 'tank' ? 2.2 : 2.0, 30);
    const v = new Vehicle(this, side, f, kind); v.place(fx, fz, h); this.vehicles.push(v); return v;
  }
  garrison(sq, b) {
    sq.building = b;
    const free = sq.spreadSlots(b, b.slots.filter(s => !s.occupant && !s.panel.gone), sq.soldiers.length);
    sq.soldiers.forEach((s, i) => { const sl = free[i]; if (!sl) return; sl.occupant = s; s.slotRef = sl; s.inside = sl; b.slotPos(sl, s.pos); const o = b.outward(sl.panel); s.heading = Math.atan2(o.x, o.z); s.stance = 'crouch'; s.sync(); });
  }
  deploy() {
    const N = Math.PI, S = 0; // facing north (−Z) / south (+Z)
    const pf = this.playerFaction, B = this.city.buildings;
    if (this.opts.net?.role === 'client') return clientBattle(this, this.opts.net.peer);   // versus joiner: puppet units from the host
    if (this.campaign) { deployCampaign(this); if (this.opts.net?.role === 'host') deployCampaign(this, 'enemy', this.opts.net.enemyForce, this.opts.net.enemyMods); return; }   // the brigade's persistent task group (+ the versus opponent's)
    // --- player: motorized rifle company riding on armour at the southern edge
    const lineup = MAP.lineup;
    this.playerUnits = [];
    let bn = 1, tn = 1, in_ = 1;
    for (const [x, z, kind, sqName] of lineup) {
      const v = this.makeVehicle('player', kind, x, z, N);
      v.name = kind === 'btr' ? `${pf.btrName} #${bn++}` : kind === 'ifv' ? `${pf.ifvName} #${in_++}` : kind === 'spg' ? `${pf.spgName}` : (pf.id === 'UA' ? `${pf.tankName} ${['"Hrim"', '"Ludmila"'][tn++ - 1]}` : `${pf.tankName} #21${tn++}`);
      this.playerUnits.push(v);
      if (sqName) {
        const sq = this.makeSquad('player', x, z + 6, N, sqName, kind === 'tank' ? 'assault' : 'mech'); sq.name = sqName;
        sq.board(v, true); this.playerUnits.splice(this.playerUnits.length - 1, 0, sq);
      }
    }
    // ATGM (Kornet / Stugna-P) and FPV drone teams move up on foot
    for (const [x, z, kind] of MAP.support || []) {
      const sq = this.makeSquad('player', x, z, N, '', kind);
      sq.name = kind === 'atgm' ? `${pf.id === 'RU' ? 'Kornet' : 'Stugna'} team` : 'FPV team';
      this.playerUnits.push(sq);
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
  deployPlace(u, x, z, facing, side = 'player') {
    [x, z] = this.inZone(x, z, side);
    if (u.type === 'vehicle') {
      const [fx, fz] = this.nav.nearestFree(x, z, u.kind === 'tank' ? 2.2 : 2.0, 30); u.place(fx, fz, facing ?? u.heading); u.path = null;
      if (u.passengers?.mounted) u.passengers.board(u, true);
    } else if (u.mounted && u.carrier) this.deployPlace(u.carrier, x, z, facing);
    else { const [fx, fz] = this.nav.nearestFree(x, z, 0.5, 20); u.placeAt(fx, fz, facing ?? u.facing); for (const s of u.soldiers) { s.path = null; s.goal = null; s.pathReq = null; s.waitTeam = false; } u.order = null; }
  }
  startBattle() {
    if (this.phase !== 'deploy') return;
    this.phase = 'capture'; this.time = 0;
    // recon drone overflight before the attack (campaign upgrade): enemy positions known at the start
    if (this.mods?.player?.reconDrone) for (const u of this.unitsOf('enemy')) { (u.detect ||= {}).player = 1.6; (u.seenBy ||= {}).player = 0; u.spotted = true; }
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
  // panel blocks + private houses (anything a squad can garrison / storm)
  allBuildings() { return this.houses?.list.length ? (this._allB ||= [...this.city.buildings, ...this.houses.list]) : this.city.buildings; }
  unitsOf(side) { return [...this.squads.filter(s => s.side === side && !s.destroyed), ...this.vehicles.filter(v => v.side === side && !v.destroyed)]; }
  enemiesOf(side) { const o = side === 'player' ? 'enemy' : 'player'; return this.unitsOf(o); }
  rallyPoint(side) { const p = side === 'player' ? SPAWNS.defender : SPAWNS.attacker; const c = p[Math.floor(Math.random() * p.length)]; return [c[0], c[1] + (side === 'player' ? -15 : 15)]; }
  camDist(p) { const c = this.renderer.camera.position; return Math.hypot(p.x - this.cam.focus.x, p.z - this.cam.focus.z) * 0.6 + Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) * 0.4; }
  sfx(key, pos = null, opts) { if (this.audio?.ok) return this.audio.play(key, pos, opts); }
  hitSoldier(...a) { return this.combat.hitSoldier(...a); }
  // ---------------------------------------------------------------- pathing (time-sliced)
  requestPath(ent, sx, sz, tx, tz, clearance, vehicle = false, opts = null) {
    ent.pathReq = { sx, sz, tx, tz, clearance, vehicle, opts };   // opts (infantry): { threat: [x, z] } -> nav.findPath
    if (!this.pathQueue.includes(ent)) this.pathQueue.push(ent);
  }
  servicePaths(budgetMs) {
    const t0 = performance.now();
    while (this.pathQueue.length && performance.now() - t0 < budgetMs) {
      const e = this.pathQueue.shift(), r = e.pathReq; if (!r) continue; e.pathReq = null;
      let p = this.nav.findPath(r.sx, r.sz, r.tx, r.tz, r.clearance, r.vehicle, undefined, r.opts);
      if (!p || !p.length) p = this.nav.findPath(r.sx, r.sz, r.tx, r.tz, Math.max(0.4, r.clearance * 0.75), r.vehicle, undefined, r.opts);
      // no route: never walk a straight line through walls — only go direct if that line is actually clear
      if (!p || !p.length) p = this.nav.lineFree(r.sx, r.sz, r.tx, r.tz, Math.min(0.45, r.clearance)) ? [[r.tx, r.tz]] : null;
      e.path = p; e.pathI = p && p.length > 1 ? 1 : 0; e.pathFail = !p;
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
    if (s.trenchSlot) { s.trenchSlot.occupant = null; s.trenchSlot = null; }
    if (sq.destroyed && sq.side === 'player') this.hud?.alert(`${sq.name} has been wiped out`, 'bad');
    const L = TUNING.ticketLoss;
    this.ticketLoss(sq.side, L.soldier);
    if (sq.destroyed && (sq.kind === 'atgm' || sq.kind === 'fpv' || sq.support) && !sq.ticketed) { sq.ticketed = true; this.ticketLoss(sq.side, L.support); }
  }
  // ---------------------------------------------------------------- tickets
  ticketLoss(side, n) {
    if (this.over || this.phase === 'deploy' || !n) return;
    this.tickets[side] = Math.max(0, this.tickets[side] - n);
    this.ticketLog[side].push([this.time, n]);
  }
  // weight of a held objective: a fresh capture bleeds the other side less than one held for a while
  holdWeight(o) { const B = TUNING.ticketBleed; return B.fresh + (1 - B.fresh) * Math.min(1, (o.holdT || 0) / B.ramp); }
  updateTickets(dt) {
    const B = TUNING.ticketBleed, T = this.tickets; let wp = 0, we = 0;
    for (const o of this.objectives) { if (o.contested) continue; if (o.owner === 'player') wp += this.holdWeight(o); else if (o.owner === 'enemy') we += this.holdWeight(o); }
    const bleedE = Math.max(0, wp - we) * B.perObj, bleedP = Math.max(0, we - wp) * B.perObj;   // tickets per minute
    T.enemy = Math.max(0, T.enemy - bleedE * dt / 60); T.player = Math.max(0, T.player - bleedP * dt / 60);
    this.ticketBleedRate = { player: bleedP, enemy: bleedE };
    for (const side of ['player', 'enemy']) {
      const log = this.ticketLog[side]; while (log.length && log[0][0] < this.time - 60) log.shift();
      const lost = log.reduce((a, e) => a + e[1], 0);
      this.ticketDrain[side] = Math.round((side === 'player' ? bleedP : bleedE) + lost * 60 / Math.max(20, Math.min(60, this.time)));
    }
  }
  bailOut(v, cas) {
    const sq = v.passengers; if (!sq) return;
    sq.dismount(v.heading + Math.PI);
    for (const s of sq.soldiers) if (s.effective && Math.random() < cas) this.combat.hitSoldier(s, { dmg: [40, 160], type: 'blast' }, v.pos, true);
    if (sq.side === 'player') this.hud?.alert(`${sq.name} bailed out of burning ${v.name}`, 'bad');
    sq.addMorale(-15);
  }
  // the vehicle is knocked out with the squad aboard. Men inside (BMP / BTR / Bradley troop compartment) get out exactly as
  // often as the crew does (crewSurvival: the same roll vehicle.bailCrew uses; 0 when it brews up / the ammo goes); the
  // rest stay in the wreck. Riders on the deck are thrown or jump clear: they mostly survive the kill itself — the price
  // of riding on top is being in the open to small arms and fragments the whole way (combat.js hitChance / explode).
  passengersOnKill(v, crewSurvival, catastrophic, owner = null) {
    const sq = v.passengers; if (!sq) return;
    const R = TUNING.riderKillSurvival || { normal: 0.85, catastrophic: 0.65 };
    const fate = new Map();
    for (const s of sq.soldiers) if (s.aboard && s.effective) fate.set(s, s.inside === 'ride' ? (Math.random() < (catastrophic ? R.catastrophic : R.normal) ? 'ok' : 'hurt') : (Math.random() < crewSurvival ? 'out' : 'lost'));
    (this.vkLog ||= []).push({ v: v.kind, cat: catastrophic, inside: [...fate.values()].filter(f => f === 'out' || f === 'lost').length, out: [...fate.values()].filter(f => f === 'out').length, ride: [...fate.values()].filter(f => f === 'ok' || f === 'hurt').length, rideOk: [...fate.values()].filter(f => f === 'ok').length });
    sq.dismount(v.heading + Math.PI);
    for (const [s, f] of fate) {
      if (f === 'lost') {   // killed in the troop compartment: the body stays in the wreck
        s.dmWait = null; s.die(null, { blast: true }); s.inside = 'btr'; s.lostInVeh = true; this.onDeath(s, owner, false);
      } else if (f === 'hurt') this.combat.hitSoldier(s, { dmg: [40, 150], type: 'blast' }, v.pos, true, owner);
      else if (f === 'out' && Math.random() < 0.3) { s.hp -= 25 + Math.random() * 25; if (s.state === 'ok' && s.hp < 55) s.state = 'light'; }   // burns, concussion
    }
    if (sq.side === 'player') this.hud?.alert(`${sq.name}: ${[...fate.values()].filter(f => f === 'lost').length ? 'men lost in' : 'got out of'} the burning ${v.name}`, 'bad');
    sq.addMorale(-15);
  }
  passengerCasualties(v, p, owner) {
    const sq = v.passengers; if (!sq) return;
    // a hit in the troop compartment: the men inside take the spall / blast; riders on the deck above only the odd fragment
    for (const s of sq.soldiers) if (s.aboard && s.effective && Math.random() < p * (s.inside === 'ride' ? 0.5 : 1)) {
      s.hp -= 40 + Math.random() * 120;
      if (s.hp <= -20) { s.die(); this.onDeath(s, owner, false); } else if (s.hp <= 0) { s.state = 'critical'; s.bleed = 120; sq.onCasualty(s, false); this.stats[sq.side].wia++; }
    }
    sq.addMorale(-10);
    if (Math.random() < 0.6) this.bailOut(v, 0.1);
  }
  onVehicleLost(v) {
    this.stats[v.side].vehLost++;
    const L = TUNING.ticketLoss; this.ticketLoss(v.side, L[v.kind] ?? L.soft);
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
      if (!s.whistled && this.time > s.t - (s.caliber === 'spg' ? 2.3 : 1.4)) { s.whistled = true; this.sfx(s.caliber === 'spg' ? 'shell_incoming' : 'incoming_whistle', new THREE.Vector3(s.x, 20, s.z), { delay: false }); }
      if (this.time >= s.t) {
        this.strikes.splice(i, 1);
        const at = new THREE.Vector3(s.x, 0.1, s.z);
        // rounds landing on a building hit the roof/top floor
        const b = this.city.buildingAt(s.x, s.z, 0); if (b) at.y = b.floors * this.assets.kit.H - 0.5;
        this.combat.blastSide = s.side;
        if (s.caliber === 'spg') {   // 152 / 155 mm HE-Frag: ~6-7 kg of explosive, lethal radius well beyond a mortar's
          this.combat.explode(at, s.power || 2.7, s.owner || null, [170, 420], 15);
          if (!b) for (let k = 0; k < 2; k++) this.fx.vehicleDust(at, 16);
          for (const v of this.vehicles) if (!v.destroyed && v.pos.distanceTo(at) < 7) { v.hp -= (7 - v.pos.distanceTo(at)) * (v.kind === 'tank' ? 25 : 70); if (v.hp <= 0) v.knockOut(false); else if (v.pos.distanceTo(at) < 3 && Math.random() < 0.5) { v.immob.track = true; v.immobile = true; } }
        } else this.combat.explode(at, s.caliber === 'arty' ? 2.2 : 1.3, null, s.caliber === 'arty' ? [120, 320] : [80, 220], s.caliber === 'arty' ? 11 : 8);
        this.combat.blastSide = null;
      }
    }
  }
  // ---------------------------------------------------------------- spotting
  // Symmetric spotting: each side only sees (and the AI only engages) what its units have line of sight to.
  spotFor(side) {
    const other = side === 'player' ? 'enemy' : 'player', spotters = [];
    for (const u of this.unitsOf(side)) {
      const sm = 1 + (this.mods?.[side]?.spotRange || 0) + (this.mods?.[side]?.thermals || 0) * 0.5;   // optics / thermal sights ordered in the campaign
      if (u.type === 'vehicle') spotters.push([u.pos.x, (u.pos.y || 0) + 2.6, u.pos.z, (u.kind === 'tank' ? 150 : 165) * (side === 'enemy' ? 0.85 : 1) * sm, u]); // buttoned-up crews see little
      else for (const s of u.effective) if (s.inside !== 'btr') spotters.push([s.pos.x, s.pos.y + s.headHeight(), s.pos.z, (s.inside === 'ride' ? 220 : 280) * sm, u.building]);
    }
    for (const u of this.unitsOf(other)) {
      const ca = this.city.concealAt;
      // every man counts (it used to be the first 4 only: a squad whose first four were behind a wall vanished with
      // the rest standing in the open); big squads: 8 per tick, rotating
      const men = u.type === 'vehicle' ? null : u.effective.filter(s => s.inside !== 'btr' && !s.cellar), mo = men && men.length > 8 ? ((this.spotRot = (this.spotRot || 0) + 1) % men.length) : 0;
      const pts = u.type === 'vehicle' ? [[u.pos.x, (u.pos.y || 0) + 1.6, u.pos.z, null, ca ? Math.max(0.8, ca.call(this.city, u.pos.x, u.pos.z)) : 1]] : (men.length > 8 ? men.slice(mo).concat(men.slice(0, mo)).slice(0, 8) : men).map(s => [s.pos.x, s.pos.y + s.headHeight(), s.pos.z, s.inBuilding ? u.building : null, (ca && !s.inBuilding && !s.aboard ? ca.call(this.city, s.pos.x, s.pos.z) : 1) * (s.stance === 'prone' ? 0.75 : s.stance === 'crouch' ? 0.9 : 1)]);
      // detection is a meter, not a switch: it fills faster for close, moving or firing targets, needs line
      // of sight, falls off with distance and concealment, and drains when nobody is looking
      let seen = false, best = 0;
      const fired = (u.firedT ?? 99) < 3;
      const moving = u.type === 'vehicle' ? Math.abs(u.speed || 0) > 0.5 : u.effective.some(s => s.vel.lengthSq() > 1);
      const tracked = u.seenBy?.[side] != null && this.time - u.seenBy[side] < 4;
      for (const [x, y, z, ign, cf] of pts) {
        for (const sp of spotters) {
          const d = Math.hypot(sp[0] - x, sp[2] - z);
          if (d < 25) { best = 9; break; }
          const range = sp[3] * (u.type === 'vehicle' ? 1.25 : 1) * (u.type === 'squad' && u.building ? 0.75 : 1) * (fired ? 1.6 : 1) * cf;
          if (d > range) continue;
          const f = Math.pow(1 - d / range, 1.4) * (moving ? 1.6 : 1) * (fired ? 2.5 : 1) * (tracked ? 2 : 1) * (u.type === 'vehicle' ? 1.5 : 1);
          if (f * 3 <= best) continue;
          if (this.combat.los(sp[0], sp[1], sp[2], x, y, z, sp[4], ign || u)) best = Math.max(best, f * 3);
          else if (fired && this.combat.los(sp[0], sp[1], sp[2], x, y, z, sp[4], ign || u, true)) best = Math.max(best, f * 1.5);   // muzzle flashes through the leaves: located roughly
        }
        if (best >= 9) break;
      }
      u.detect ||= {}; const dm = u.detect[side] || 0;
      // drain: slower for a target that was being tracked (the meter no longer bounces across the threshold)
      u.detect[side] = best > 0 ? Math.min(1.6, dm + best * 0.5 * (0.6 + Math.random() * 0.8)) : Math.max(0, dm - (tracked ? 0.2 : 0.35));
      seen = u.detect[side] >= 1;
      u.seenBy ||= {};
      if (seen) u.seenBy[side] = this.time;
      if (side === 'player') {
        // hysteresis: once spotted a unit stays shown until the meter has really drained (or 3 s after the last sighting),
        // then it leaves a fading last-known-position marker instead of just popping out of existence
        const was = !!u.spotted;
        u.spotted = (u.seenBy.player != null && this.time - u.seenBy.player < 3) || (was && u.detect.player > 0.25);
        if (was && !u.spotted && !u.destroyed) this.lastKnown(u); else if (u.spotted && u.lkm) this.dropLastKnown(u);
        if (u.type === 'squad') for (const s of u.soldiers) s.visible = (u.spotted && !s.cellar) || s.state === 'dead';
      }
    }
  }
  // last-known-position marker: a red ring where an enemy unit was last seen, fading over ~12 s
  lastKnown(u) {
    if (this.noRender && !this.renderer) return;
    const p = u.type === 'vehicle' ? u.pos : u.center(), r = u.type === 'vehicle' ? 4 : 3.2;
    let m = u.lkm; if (!m) { m = new THREE.Mesh(this._lkG ||= new THREE.RingGeometry(0.82, 1, 40), new THREE.MeshBasicMaterial({ color: 0xc8483a, transparent: true, opacity: 0.55, depthWrite: false })); m.rotation.x = -Math.PI / 2; m.renderOrder = 4; this.scene.add(m); u.lkm = m; (this.lkms ||= new Set()).add(u); }
    m.scale.setScalar(r); m.position.set(p.x, (this.city.groundHeight?.(p.x, p.z) || 0) + 0.25, p.z); m.userData.t0 = this.time; m.visible = true;
  }
  dropLastKnown(u) { if (!u.lkm) return; this.scene.remove(u.lkm); u.lkm.material.dispose(); u.lkm = null; this.lkms?.delete(u); }
  updateLastKnown() { if (this.lkms) for (const u of [...this.lkms]) { const a = (this.time - u.lkm.userData.t0) / 12; if (a >= 1 || u.destroyed) this.dropLastKnown(u); else u.lkm.material.opacity = 0.55 * (1 - a); } }
  updateSpotting() {
    this.updateLastKnown();
    this.spotFor('player'); this.spotFor('enemy');
    for (const sq of this.squads) if (sq.side === 'player') for (const s of sq.soldiers) s.visible = !s.cellar;   // (men down in a cellar: not drawn)
  }
  // can `side` currently engage unit u (spotted recently or very close)?
  seen(side, u, from) { if (u.seenBy?.[side] != null && this.time - u.seenBy[side] < 4) return true; if (!from) return false; const p = u.type === 'vehicle' ? u.pos : (u._c ||= new THREE.Vector3()) && u.center(u._c); return Math.hypot(from.x - p.x, from.z - p.z) < 35; }
  // ---------------------------------------------------------------- objectives
  objectiveMarkers() {
    this.objMeshes = this.objectives.map(o => {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.RingGeometry((o.r ?? TUNING.captureRadius) - 0.6, o.r ?? TUNING.captureRadius, 96), new THREE.MeshBasicMaterial({ color: 0x8fb069, transparent: true, opacity: 0.45, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.12; g.add(ring);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 6, 6), new THREE.MeshStandardMaterial({ color: 0x333333 })); pole.position.y = 3; g.add(pole);
      g.position.set(o.x, 0, o.z); this.scene.add(g); o.ring = ring; return g;
    });
  }
  updateObjectives(dt) {
    for (const o of this.objectives) {
      let p = 0, e = 0;
      for (const sq of this.squads) {
        if (sq.mounted || sq.routing || sq.destroyed || sq.noncombat) continue;
        for (const s of sq.soldiers) if (s.effective && s.inside !== 'btr' && Math.hypot(s.pos.x - o.x, s.pos.z - o.z) < (o.r ?? TUNING.captureRadius)) { if (sq.side === 'player') p++; else e++; }
      }
      for (const v of this.vehicles) if (!v.destroyed && !v.noncombat && Math.hypot(v.pos.x - o.x, v.pos.z - o.z) < (o.r ?? TUNING.captureRadius)) { if (v.side === 'player') p += 1.5; else e += 1.5; }
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
        o.holdT = 0;
        if (o.owner === 'enemy') { this.hud?.alert(o.captured ? `Objective ${o.id} — ${o.name} LOST! The enemy holding it bleeds our tickets` : `Enemy has seized ${o.name} — every minute they hold it costs us tickets`, 'bad'); this.sfx('ui_alert'); }
        else { this.hud?.alert(`Objective ${o.id} — ${o.name} ${o.captured ? 'retaken' : 'CAPTURED'} — holding it drains the enemy's tickets`, 'good'); o.lostT = 0; o.captured = true; this.sfx('radio'); }
        if (this.phase === 'capture' && this.objectives.every(q => q.captured)) { this.phase = 'hold'; this.hud?.alert(`${this.objectives.length > 2 ? 'All' : 'Both'} objectives taken — hold them to bleed the enemy dry`, 'good'); }
      } else if (o.owner !== 'neutral' && !o.contested) o.holdT = (o.holdT || 0) + dt;
      o.lostT = 0;   // legacy field (the old retake countdown); losing a point now costs tickets instead
      o.ring.material.color.set(o.owner === 'player' ? (o.contested ? 0xd8b25a : 0x8fb069) : o.owner === 'enemy' ? 0xc8483a : 0xb8b4a8);
    }
  }
  checkEnd() {
    if (this.over || this.phase === 'deploy') return;
    const T = this.tickets, pa = this.armyLeft('player'), ea = this.armyLeft('enemy'), tp = Math.round(T.player), te = Math.round(T.enemy);
    // versus: the joiner gets the host's result with the title flipped, so the reason names the sides instead of 'you'
    const vs = !!this.opts.net, P = vs ? `${this.playerFaction.name}'s` : 'Your', E = vs ? `${this.enemyFaction.name}'s` : 'Enemy', score = `Tickets ${tp} – ${te}.`;
    let result = null;
    if (T.enemy <= 0 && T.player <= 0) result = { win: false, title: 'DEFEAT', why: `Both sides' tickets exhausted — neither can hold the ground. ${score}`, reason: 'tickets' };
    else if (T.enemy <= 0) result = { win: true, title: 'VICTORY', why: `${E} tickets exhausted — losses and lost ground have broken ${vs ? 'it' : 'the enemy'}. ${score}`, reason: 'tickets' };
    else if (T.player <= 0) result = { win: false, title: 'DEFEAT', why: `${P} tickets exhausted — losses and lost ground have broken the ${vs ? 'force' : 'company'}. ${score}`, reason: 'tickets' };
    else if (!pa && !ea) result = { win: false, title: 'DEFEAT', why: `Both forces were destroyed. ${score}`, reason: 'army' };
    else if (!pa) result = { win: false, title: 'DEFEAT', why: `${P} force is broken — no fighting units left. ${score}`, reason: 'army' };
    else if (!ea) result = { win: true, title: 'VICTORY', why: `${E} force is destroyed — no fighting units left. ${score}`, reason: 'army' };
    else if (this.time >= this.roundLen) {
      const who = s => (vs ? (s === 'player' ? this.playerFaction.name : this.enemyFaction.name) : s === 'player' ? 'you' : 'the enemy');
      if (tp > te) result = { win: true, title: 'VICTORY', why: `Time — more tickets remaining: ${who('player')} ${tp}, ${who('enemy')} ${te}.`, reason: 'time' };
      else if (tp < te) result = { win: false, title: 'DEFEAT', why: `Time — ${who('enemy')} has more tickets remaining: ${te} vs ${tp}.`, reason: 'time' };
      else { const def = this.campaign?.mode === 'defend'; result = { win: def, title: def ? 'VICTORY' : 'DEFEAT', why: `Time — tickets level at ${tp}; the ${def ? 'defence holds' : 'attack has stalled'}.`, reason: 'time' }; }
    }
    if (result) { result.tickets = { player: tp, enemy: te, max: T.max }; this.over = true; this.result = result; this.sfx(result.win ? 'victory' : 'defeat'); this.hud?.showEnd(result); }
  }
  // fighting units left: squads with an effective man, vehicles still crewed (an abandoned hull doesn't count)
  armyLeft(side) {
    let n = 0;
    for (const s of this.squads) if (s.side === side && !s.destroyed && !s.noncombat) n++;   // (medevac crews / trucks don't count)
    for (const v of this.vehicles) if (v.side === side && !v.destroyed && !v.abandoned && v.crew > 0 && !v.noncombat) n++;
    return n;
  }
  // ---------------------------------------------------------------- loop
  update(dt) {
    if (this.netClient) { if (!this.paused) clientFrame(this, dt); return; }
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
    this.updateTickets(dt);
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
      // apply it here every frame: sync() only runs inside update(), so while paused / after the end a man culled
      // off-screen stayed invisible when the camera panned onto him ('units turn invisible')
      s.root.visible = s.visible && (s.inside !== 'btr' || s.inCab) && (s.state !== 'evac' || !!s.onBed) && s.inView;   // onBed: casualty lying on the medevac pickup
      const near = Math.hypot(s.pos.x - f.x, s.pos.z - f.z) < 70 + this.cam.dist * 0.3;
      if (near !== s.shadowOn) { s.shadowOn = near; s.root.traverse(o => { if (o.isMesh) o.castShadow = near; }); }
    }
  }
  // fires / smoke columns sitting on a building fall onto the rubble once their floor or section is gone
  supportEmitters() {
    const W = this.assets.kit.W; this.city.updateDecals?.();
    for (const e of this.fx.emitters) {
      if (e.dead || e.dropped || e.pos.y < 1.5 || (e.kind !== 'fire' && e.kind !== 'smoulder')) continue;
      if (e.attach?.p?.gone) { this.fx.drop(e); continue; }
      const b = this.city.buildingAt(e.pos.x, e.pos.z, 2.5);
      if (!b) { this.fx.drop(e, e.kind === 'fire' ? 0.4 : 1); continue; }
      const [lx] = b.toLocal(e.pos.x, e.pos.z), col = Math.max(0, Math.min(b.modules - 1, Math.floor((lx + b.L / 2) / W)));
      if (b.goneCols.has(col) || (b.pancaked && col >= b.pancaked[0] - 1 && col <= b.pancaked[1] + 1)) { this.fx.drop(e, e.kind === 'fire' ? 0.6 : 2); continue; }
      if (e.pos.y > b.height + 1) e.pos.y = b.height;
    }
  }
  frame(dt) {
    const f0 = performance.now();
    this.supT = (this.supT || 0) - dt; if (this.supT <= 0) { this.supT = 0.5; this.supportEmitters(); }
    this.update(dt);
    this.cam.update(Math.min(dt, 0.05));
    this.cullSoldiers();   // after the camera moved (was before update: a frame late, and nothing re-applied it while paused)
    this.renderer.followShadow(this.cam.focus); this.renderer.tick(dt); if (this.city.windUniform) this.city.windUniform.value += dt; this.city.updateFalling(Math.min(dt, 0.05) * (this.paused ? 0 : this.timeScale)); this.city.pool.finish();
    const cp = this.renderer.camera.position; updateLods(cp);
    this.fx.update(Math.min(dt, 0.05) * (this.paused ? 0 : this.timeScale), cp);
    for (const d of this.city.dynamic.children) if (d.userData.rise > 0) { const k = Math.min(d.userData.rise, dt * 0.8); d.position.y += k; d.userData.rise -= k; }
    if (this.audio.ok) { const f = this.cam.focus; this.audio.setListener({ x: f.x * 0.7 + cp.x * 0.3, y: 12 + (cp.y - 12) * 0.3, z: f.z * 0.7 + cp.z * 0.3 }, new THREE.Vector3(f.x - cp.x, 0, f.z - cp.z).normalize()); }
    this.netTick?.(dt);
    this.hud?.update(dt);
    if (!this.noRender) { this.renderer.dynFrame(performance.now() - f0); this.renderer.render(dt, this.time); }
  }
  mortarMarker(x, z) {
    const m = new THREE.Mesh(new THREE.RingGeometry(15, 16, 48), new THREE.MeshBasicMaterial({ color: 0xd8b25a, transparent: true, opacity: 0.6, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.15, z); this.scene.add(m);
    setTimeout(() => this.scene.remove(m), 16000);
  }
}
