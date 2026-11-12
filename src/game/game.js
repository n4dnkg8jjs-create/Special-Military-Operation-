import * as THREE from 'three';
import { vegetationLOS, vegetationTrunks } from '../world/vegetation.js';
import { deployCampaign } from './campaignBattle.js';
import { hostBattle, clientBattle, clientFrame } from '../net/battle.js';
import { Renderer } from '../engine/renderer.js';
import { RTSCamera } from '../engine/camera.js';
import { Assets } from '../engine/assets.js';
import { City, OBJECTIVES, SPAWNS, BOUNDS, DEPLOY_ZONES, MAP, setMap, mulberry } from '../world/city.js';
import { Farmland } from '../world/farmland.js';
import { updateLods, simplifierReady, PLACED } from '../world/instancer.js';
import { FX } from '../fx/particles.js';
import { Audio } from '../audio/sfx.js';
import { Squad, hullBox } from './squad.js';
import { Vehicle } from './vehicle.js';
import { Combat } from './combat.js';
import { CQB } from './cqb.js';
import { buildHouses } from '../world/houses.js';
import { setupTreeDamage } from '../world/treeDamage.js';
import { prepareSoldierAssets } from './soldier.js';
import { Commander, AutoDefender } from './ai.js';
import { setupMedevac } from './medevac.js';
import { setupAtgmTrucks } from './atgmTruck.js';
import { setupFires } from './fireMission.js';
import { FACTIONS, TUNING } from '../config.js';
import { BloodDecals } from '../fx/blood.js';
import { HeliSupport } from './heli.js';

const Q = new URLSearchParams(location.search);
const CONTACT_TTL = 25, ISR_R = 700;   // (spotFor) a contact not re-reported for 25 s is gone; the side's recon drones watch the open ground out to 700 m from its units (~ an FPV's reach)
// an enemy squad as the local player knows it (fogSquad: also the versus joiner, net/battle.js): its men drawn only when
// identified (the dead once seen stay drawn where they fell; a casualty on a medevac bed as the truck is); an ATGM team's launcher
// (a separate object in the scene) hidden with them (layer mask 0: the team's own code keeps toggling .visible on its parts)
export function fogSquad(u) {
  const t = u.tier || 0;
  for (const s of u.soldiers) {
    if (s.state === 'dead') { if (t === 2) s.seenDead = true; s.visible = !!s.seenDead; }   // (the dead: once found they stay drawn where they lie)
    else s.visible = !s.cellar && (s.onBed && typeof s.onBed === 'object' ? s.onBed.tier === 2 : t === 2);
  }
  const S = u.support; if (!S?.launcher) return;
  const hide = t !== 2, L = S.launcher;
  if (L.userData.fogHid !== hide) { L.userData.fogHid = hide; const m = hide ? 0 : 1; L.traverse(o => { o.layers.mask = m; }); for (const n of Object.values(S.nodes || {})) n.o?.traverse?.(o => { o.layers.mask = m; }); }
}

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
    this.deadWoods = this.thinDeadWoods();   // woods / belts of bare trees: trunks only for sight (spotting v3)
    this.houses = buildHouses(this);   // private houses: garrisonable, with a cellar (world/houses.js)
    progress(0.92, 'Deploying forces');
    this.fx = new FX(this.scene, this.renderer.sunDir, this.opts.quality);
    this.blood = this.noRender ? null : new BloodDecals(this.scene);   // pools under the bleeding, smears where casualties are dragged (fx/blood.js)
    this.treeDamage = setupTreeDamage(this);   // shelled trees lose leaves, splinter, snap (world/treeDamage.js; driven by fx.explosion)
    this.combat = new Combat(this); this.cqb = new CQB(this);   // building clearing (game/cqb.js)
    this.cam = new RTSCamera(this.renderer.camera, canvas, BOUNDS);
    prepareSoldierAssets(this.assets);
    this.objectives = OBJECTIVES.map(o => ({ ...o, control: 0, owner: 'neutral', lostT: 0, contested: false, captured: false }));
    this.phase = 'deploy';
    this.objectiveMarkers();
    this.zoneMarkers();
    this.deploy();
    this.medevac = setupMedevac(this);   // casualty-evacuation pickup + medics for both sides (game/medevac.js)
    this.atgmTrucks = setupAtgmTrucks(this);   // skirmish: a Kornet / Stugna-P pickup per side (game/atgmTruck.js)
    this.heli = new HeliSupport(this);   // Mi-24 rocket strikes (Command Influence request / ?hind): game/heli.js
    this.fires = setupFires(this);       // 152 / 155 mm tube-artillery fire missions, both sides (game/fireMission.js)
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
    const sq = new Squad(this, side, f, `${n}`, kind, roles); sq.placeAt(x, z, facing); this.squads.push(sq);
    // campaign v7: the enemy squads carry the veterancy of the battalion groups they come from (setup.enemyVet)
    if (side === 'enemy' && this.campaign?.enemyVet && !this.opts?.net) sq.vet = this.campaign.enemyVet;
    return sq;
  }
  makeVehicle(side, kind, x, z, h, variant = null) {
    const f = side === 'player' ? this.playerFaction : this.enemyFaction;
    const [fx, fz] = this.nav.nearestFree(x, z, kind === 'tank' ? 2.2 : 2.0, 30);
    const v = new Vehicle(this, side, f, kind, variant); v.place(fx, fz, h); this.vehicles.push(v); return v;
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
    if (this.campaign) { this.reinforced = true; /* (campaign: only the task group's own units, no scripted free reinforcement) */ deployCampaign(this); if (this.opts.net?.role === 'host') deployCampaign(this, 'enemy', this.opts.net.enemyForce, this.opts.net.enemyMods); return; }   // the brigade's persistent task group (+ the versus opponent's)
    // --- player: motorized rifle company riding on armour at the southern edge
    const lineup = MAP.lineup;
    this.playerUnits = [];
    let bn = 1, tn = 1, in_ = 1;
    for (const [x, z, kind, sqName] of lineup) {
      const leo = kind === 'tank' && pf.id === 'UA' && tn === 1 && new URLSearchParams(location.search).has('leopard');   /* ?leopard: the first UA tank of a skirmish is the Command Influence Leopard 2A6 (to look at it outside the campaign) */
      const v = this.makeVehicle('player', kind, x, z, N, leo ? 'tank_leopard' : null);
      v.name = leo ? (tn++, 'Leopard 2A6') : kind === 'btr' ? `${pf.btrName} #${bn++}` : kind === 'ifv' ? `${pf.ifvName} #${in_++}` : kind === 'spg' ? `${pf.spgName}` : (pf.id === 'UA' ? `${pf.tankName} ${['"Hrim"', '"Ludmila"'][tn++ - 1]}` : `${pf.tankName} #21${tn++}`);
      this.playerUnits.push(v);
      if (sqName) {
        const sq = this.makeSquad('player', x, z + 6, N, sqName, kind === 'tank' ? 'assault' : 'mech'); sq.name = sqName;
        if (v.def.seats !== 0) sq.board(v, true); /* (a Leopard carries nobody: its assault squad walks) */ this.playerUnits.splice(this.playerUnits.length - 1, 0, sq);
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
      for (const a of this.defAreas?.[side] || []) {   // defence areas: a ring on the ground round each
        const ring = new THREE.Mesh(new THREE.RingGeometry(a.r - 0.7, a.r, 64), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }));
        const disc = new THREE.Mesh(new THREE.CircleGeometry(a.r, 48), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }));
        const gg = new THREE.Group(); ring.rotation.x = disc.rotation.x = -Math.PI / 2; gg.add(disc, ring); gg.position.set(a.x, (this.city.groundHeight?.(a.x, a.z) ?? 0) + 0.25, a.z); gg.renderOrder = 3; this.scene.add(gg); this.zoneMeshes.push(gg);
      }
    }
  }
  // Defence deployment (defence v1): the side that holds the ground may set its units up on it before the battle - on the
  // objectives (58 m round each) and in the trench systems - not only on its own staging ground. So that the attacker's
  // forming-up place cannot be camped, no such area may come within CAMP metres of his staging ground: he always has that
  // much clear ground in front of him to plan and shake out in. Areas: [{ x, z, r, name }] per side (this.defAreas).
  setDefence(side) {
    const os = side === 'player' ? 'enemy' : 'player', E = DEPLOY_ZONES[os], CAMP = Math.max(170, MAP.sizeM * 0.24);
    const far = a => Math.hypot(Math.max(E.x0 - a.x, 0, a.x - E.x1), Math.max(E.z0 - a.z, 0, a.z - E.z1)) - a.r >= CAMP;
    const A = [...OBJECTIVES.map(o => ({ x: o.x, z: o.z, r: 58, name: o.name || o.id })), ...(this.city.trenchSystems || []).map(t => ({ x: t.center[0], z: t.center[1], r: Math.min(95, (t.radius || 30) + 8), name: t.name || 'Trench line' }))].filter(far);
    (this.defAreas ||= {})[side] = A; for (const m of this.zoneMeshes || []) this.scene.remove(m); this.zoneMarkers();
    return A;
  }
  // clamp a point into the side's deployment ground: its staging rectangle or one of its defence areas (deployment phase)
  inZone(x, z, side = 'player', pad = 3) {
    const Z = DEPLOY_ZONES[side], A = this.defAreas?.[side] || [];
    for (const a of A) if (Math.hypot(x - a.x, z - a.z) <= a.r - pad) return [x, z];
    let best = [Math.min(Z.x1 - pad, Math.max(Z.x0 + pad, x)), Math.min(Z.z1 - pad, Math.max(Z.z0 + pad, z))], bd = Math.hypot(best[0] - x, best[1] - z);
    for (const a of A) { const d = Math.hypot(x - a.x, z - a.z) || 1, k = (a.r - pad) / d, q = [a.x + (x - a.x) * k, a.z + (z - a.z) * k], qd = Math.hypot(q[0] - x, q[1] - z); if (qd < bd) { bd = qd; best = q; } }
    return best;
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
    // in-trench move (both ends in one trench system): along the trench floor - the trench lines' graph, else A* in trench mode
    if (!vehicle && !opts?.trench) { const T = this.nav.trenchPair?.(sx, sz, tx, tz, this.city.trenchSystems); if (T) { const p = this.nav.trenchRoute(T, sx, sz, tx, tz); if (p) { ent.pathReq = null; ent.path = p; ent.pathI = 0; ent.pathFail = false; return; } opts = { ...opts, trench: true }; } }
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
      // (p[0] is the start: skipped, unless it was moved off a parked hull / wreck he stands against - then he walks out to it first)
      e.path = p; e.pathI = p && p.length > 1 && (r.vehicle || Math.hypot(p[0][0] - r.sx, p[0][1] - r.sz) < 0.7) ? 1 : 0; e.pathFail = !p;
      // v8: his goal is on a parked vehicle / wreck (a slot laid out before it stopped there, a door): the route ends at the nearest
      // free cell beside it - that is his goal now (he used to arrive, find himself > 1.6 m off the goal and ask again for good)
      if (p && !r.vehicle && e.goal && e.squad && Math.hypot(e.goal[0] - r.tx, e.goal[1] - r.tz) < 0.1) {
        const end = p[p.length - 1], k = this.nav.idx(r.tx, r.tz);
        if (k >= 0 && this.nav.dyn?.[k] && Math.hypot(end[0] - r.tx, end[1] - r.tz) > 0.3) e.goal = [end[0], end[1]];
      }
    }
  }
  // v8: live vehicles standing still (and wrecks) are stamped into the nav grid's infantry layer (nav.dyn) so foot routes go
  // round them instead of through them (a live hull was never in the grid: the men walked into it and slid round it greedily,
  // often for good). Every 0.25 s: a vehicle that has stood still for ~0.75 s (speed and heading steady) is stamped, one that
  // moves is lifted; on a new stamp the men whose route runs through it ask for a new one (time-sliced path queue). Host only.
  vehObstacles(dt) {
    if ((this.vobT = (this.vobT || 0) - dt) > 0) return; this.vobT = 0.25;
    const nav = this.nav, t = this.time;
    for (const k of nav.dynStamps.keys()) if (!this.vehicles.includes(k)) nav.unstampDyn(k);   // (taken out of game.vehicles: a medevac truck gone to the aid station)
    for (const v of this.vehicles) {
      const gone = v.destroyed && !v.wreck, still = v.wreck || (!v.destroyed && Math.abs(v.speed) < 0.3 && Math.abs((v.heading - (v._vobH ?? v.heading))) < 0.02);
      v._vobH = v.heading;
      const S = nav.dynStamps.get(v);
      if (gone || (!still && !(v.dynForceT > t))) { if (S) nav.unstampDyn(v); v._stillT = 0; continue; }
      v._stillT = (v._stillT || 0) + 0.25;
      if (S && Math.hypot(S.x - v.pos.x, S.z - v.pos.z) < 0.3 && Math.abs(S.h - v.heading) < 0.06) continue;
      if (!S && v._stillT < 0.75 && !(v.dynForceT > t)) continue;
      const B = hullBox(v); nav.stampDyn(v, v.pos.x, v.pos.z, v.heading, { x0: B.min.x, x1: B.max.x, z0: B.min.z, z1: B.max.z }, 0.8);
      this.vehStamps = (this.vehStamps || 0) + 1;
      // routes through the new stamp: re-planned (from where each man stands; the next three legs are checked)
      const R2 = (v.def.length + 40) ** 2;
      for (const sq of this.squads) for (const s of sq.soldiers) {
        if (!s.effective || !s.path || s.pathI >= s.path.length || !s.goal || s.pathReq || s.aboard || s.rampWalk) continue;
        if ((s.pos.x - v.pos.x) ** 2 + (s.pos.z - v.pos.z) ** 2 > R2) continue;
        let px = s.pos.x, pz = s.pos.z, hit = false;
        for (let j = s.pathI; j < Math.min(s.path.length, s.pathI + 3) && !hit; j++) { hit = nav.segHitsDyn(v, px, pz, s.path[j][0], s.path[j][1]); px = s.path[j][0]; pz = s.path[j][1]; }
        if (hit) { this.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], 0.45, false, sq.pathOpts?.()); this.vehRepaths = (this.vehRepaths || 0) + 1; }
      }
    }
  }
  // a man stuck (squad.moveStep watchdog) against a vehicle that is creeping / jittering (not stamped yet): stamp it for a few
  // seconds so his new route goes round it
  vehBlockNear(s) {
    for (const v of this.vehicles) {
      if (v.destroyed || Math.abs(v.speed) > 1.5 || this.nav.dynStamps.has(v)) continue;
      const d = Math.hypot(v.pos.x - s.pos.x, v.pos.z - s.pos.z) - Math.max(v.def.length, v.def.width) / 2; if (d > 2.5) continue;
      v.dynForceT = this.time + 5; v._stillT = 1; this.vobT = 0; this.vehObstacles(0);
    }
  }
  // ---------------------------------------------------------------- casualties / events
  onDeath(s, killer, bledOut) {
    const sq = s.squad;
    // a man already down (critical / stable) who dies: no second casualty shock for the squad, WIA becomes KIA, and the
    // killer gets the other half of the kill (the half went to whoever wounded him)
    const down = bledOut || s.wasDown;
    if (!down) sq.onCasualty(s, true); else { sq.addMorale(-4); sq.stats.kia++; this.stats[sq.side].wia = Math.max(0, this.stats[sq.side].wia - 1); }
    this.stats[sq.side].kia++;
    const kc = down ? 0.5 : 1; if (killer && killer.squad) killer.squad.stats.kills += kc; else if (killer && killer.stats) killer.stats.kills += kc;
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
    // wounded men lying in the troop compartment (hit inside, passengerCasualties) cannot get themselves out: the same roll
    for (const s of sq.soldiers) if (s.aboard && (s.state === 'critical' || s.state === 'stable') && s.inside !== 'ride' && Math.random() >= crewSurvival) { s.wasDown = true; s.die(null, { blast: true }); s.inside = 'btr'; s.lostInVeh = true; this.onDeath(s, owner, false); }
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
  playerHeli(x, z) { return !!this.heli?.call('player', x, z); }
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
  // What each side knows about an enemy unit comes in three tiers (u.tierBy[side]; u.tier / u.spotted / u.qx,qz are the
  // local player's view, what the renderer, the HUD and the input go by):
  //   0  hidden      nothing: no model, no "?", not on the minimap. A unit holed up in a building, a cellar, a dugout or
  //                  covered trench bay, or under heavy foliage, that nobody has identified and that gives nothing away
  //   1  contact     something is there - the drone picture of the open ground (ISR: every unit not under cover within
  //                  ISR_R of the side's own units), a burst of fire / an engine heard, a unit lost from sight a moment
  //                  ago. No model and no type: a "?" at an estimated position (ctc.x/z: a grid ref with an error that
  //                  grows with distance; heard contacts get a new rough fix every few seconds, between them the "?" sits
  //                  still). Ages out CONTACT_TTL s after the last report
  //   2  identified  the detection meter filled: line of sight in the open, or a drone camera over it (an FPV in the air
  //                  is a spotter along its path; one sent to a "?" circles it and looks - game/support.js). Model + label
  // The same rules for both sides: the AI's knowledge (ai_tactics Intel), its FPV teams and the versus joiner's picture
  // (net/battle.js sends the joiner only what its side knows) all come from here. Throttled: twice a second.
  spotFor(side) {
    const other = side === 'player' ? 'enemy' : 'player', spotters = [], own = this._ownPos ||= [], eyes = this._eyes ||= [];
    own.length = 0; eyes.length = 0;
    for (const u of this.unitsOf(side)) {
      const sm = 1 + (this.mods?.[side]?.spotRange || 0) + (this.mods?.[side]?.thermals || 0) * 0.5;   // optics / thermal sights ordered in the campaign
      if (u.type === 'vehicle') { spotters.push([u.pos.x, (u.pos.y || 0) + 3.0, u.pos.z, (u.kind === 'tank' ? 210 : 220) * (side === 'enemy' ? 0.9 : 1) * sm, u]); own.push(u.pos.x, u.pos.z); } // buttoned-up crews see little
      else { for (const s of u.effective) if (s.inside !== 'btr') spotters.push([s.pos.x, s.pos.y + s.headHeight(), s.pos.z, (s.inside === 'ride' ? 220 : 280) * sm, u.building]);
        if (!u.mounted) { const l = u.leader?.effective && u.leader.inside !== 'btr' ? u.leader : u.effective.find(s => s.inside !== 'btr'); if (l) own.push(l.pos.x, l.pos.z); } }
      // drone cameras: an FPV in the air sees what is under it (wider while it circles a contact looking for it)
      const d = u.type === 'squad' && u.support?.drone;
      if (d && !d.jam && d.phase !== 'launch' && d.phase !== 'fall') eyes.push([d.pos.x, d.pos.y, d.pos.z, d.phase === 'search' ? 70 : d.phase === 'dive' ? 35 : 45]);
    }
    const isr = Math.max(ISR_R, (MAP.sizeM || 0) * 0.65) * (this.mods?.[side]?.reconDrone ? 1.5 : 1), now = this.time;   // (big maps: the drones reach most of it)
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
      const tracked = u.seenBy?.[side] != null && now - u.seenBy[side] < 4;
      for (const [x, y, z, ign, cf] of pts) {
        for (const sp of spotters) {
          const d = Math.hypot(sp[0] - x, sp[2] - z);
          if (d < 25) { best = 9; break; }
          const range = sp[3] * (u.type === 'vehicle' ? 1.5 : 1) * (u.type === 'squad' && u.building ? 0.75 : 1) * (fired ? 1.6 : 1) * cf;
          if (d > range) continue;
          const f = Math.pow(1 - d / range, 1.4) * (moving ? 1.6 : 1) * (fired ? 2.5 : 1) * (tracked ? 2 : 1) * (u.type === 'vehicle' ? 1.5 : 1);
          if (f * 3 <= best) continue;
          if (this.combat.los(sp[0], sp[1], sp[2], x, y, z, sp[4], ign || u)) best = Math.max(best, f * 3);
          else if (fired && this.combat.los(sp[0], sp[1], sp[2], x, y, z, sp[4], ign || u, true)) best = Math.max(best, f * 1.5);   // muzzle flashes through the leaves: located roughly
        }
        if (best >= 9) break;
        // a drone camera looking down: the open ground under it at once, into a tree belt only from nearly overhead
        // (nav.occluded: the leaves along the steep line of sight), never into a building
        if (!ign) for (const e of eyes) {
          const R = e[3] * (cf < 0.45 ? 0.45 : 1), dh = Math.hypot(e[0] - x, e[2] - z);
          if (dh > R || 6 * (1 - dh / R * 0.5) <= best) continue;
          if (this.combat.los(e[0], e[1], e[2], x, y, z, null, u)) best = Math.max(best, 6 * (1 - dh / R * 0.5));
        }
      }
      // a vehicle standing / driving in the open within half the drone-watch range: the recon drone's camera makes out what
      // it is within a couple of seconds (infantry in the open stays a "?" until someone has line of sight)
      if (u.type === 'vehicle' && !u.hid && best < 0.5) { const p0 = u.pos; for (let i = 0; i < own.length; i += 2) if (Math.hypot(own[i] - p0.x, own[i + 1] - p0.z) < isr * 0.5) { best = 0.5; break; } }
      u.detect ||= {}; const dm = u.detect[side] || 0;
      // drain: slower for a target that was being tracked (the meter no longer bounces across the threshold)
      u.detect[side] = best > 0 ? Math.min(1.6, dm + best * 0.5 * (0.6 + Math.random() * 0.8)) : Math.max(0, dm - (tracked ? 0.2 : 0.35));
      seen = u.detect[side] >= 1;
      u.seenBy ||= {};
      if (seen) u.seenBy[side] = now;
      // identified: hysteresis - once identified a unit stays so until the meter has really drained (or 3 s after the last sighting)
      const ids = u.idBy ||= {}, idf = ids[side] = (u.seenBy[side] != null && now - u.seenBy[side] < 3) || (!!ids[side] && u.detect[side] > 0.25);
      // ---- contact: what reaches the side without anyone seeing the unit itself
      const p = u.type === 'vehicle' ? u.pos : u.center(u._c ||= new THREE.Vector3());
      let dmin = 1e9; for (let i = 0; i < own.length; i += 2) { const dd = Math.hypot(own[i] - p.x, own[i + 1] - p.z); if (dd < dmin) dmin = dd; }
      const c = (u.ctc ||= {})[side] ||= { t: -1e9, x: p.x, z: p.z, ox: 0, oz: 0, src: 0, et: -1e9 };
      let src = 0, err = 0;
      if (idf) src = 3;
      else if (!u.hid && dmin < isr) { src = 2; err = 4 + dmin * 0.025; }   // in the open: on someone's drone feed
      else if (fired && dmin < (u.type === 'vehicle' || u.kind === 'atgm' ? 900 : u.kind === 'fpv' ? 0 : 350)) { src = 1; err = 6 + dmin * 0.05; }   // heard firing (guns / missiles carry far)
      else if (dmin < (u.type === 'vehicle' ? (moving ? 220 : 50) : moving ? 45 : 25)) { src = 1; err = 5 + dmin * 0.08; }   // engines, movement close by
      if (src === 3) { c.ox = c.oz = 0; c.x = p.x; c.z = p.z; c.t = now; c.src = 3; }
      else if (src === 2) {   // a drone-fed grid ref: tracks the unit, the error wanders
        c.ox += (Math.random() - 0.5) * err * 0.5; c.oz += (Math.random() - 0.5) * err * 0.5; const m = Math.hypot(c.ox, c.oz); if (m > err) { c.ox *= err / m; c.oz *= err / m; }
        c.x = p.x + c.ox; c.z = p.z + c.oz; c.t = now; c.src = 2;
      } else if (src === 1) {   // a rough fix by ear: a new one every few seconds, in between the "?" stays put
        if (c.src !== 1 || now - c.et > 5 || now - c.t > 6) { const a = Math.random() * 6.283, r = err * (0.35 + Math.random() * 0.65); c.ox = Math.cos(a) * r; c.oz = Math.sin(a) * r; c.x = p.x + c.ox; c.z = p.z + c.oz; c.et = now; }
        c.t = now; c.src = 1;
      }
      (u.tierBy ||= {})[side] = idf ? 2 : now - c.t < CONTACT_TTL ? 1 : 0;
    }
    // squads aboard a vehicle (and a medevac crew in its cab) are known as their vehicle is
    for (const q of this.squads) {
      if (q.side !== other || q.destroyed) continue;
      const car = q.mounted ? q.carrier : q.medevac && q.effective.every(s => s.inCab || s.inside === 'btr') ? q.medevac : null;
      if (!car || car.destroyed || !car.tierBy) continue;
      q.tierBy[side] = car.tierBy[side]; const a = car.ctc?.[side], b = q.ctc?.[side]; if (a && b) { b.x = a.x; b.z = a.z; b.t = a.t; }
    }
    if (side === 'player') for (const u of this.unitsOf(other)) this.viewSet(u, u.tierBy?.player || 0, u.ctc?.player);
  }
  // the local player's view of an enemy unit (host / single player from spotFor, the versus joiner from the snapshots)
  viewSet(u, tier, c) {
    const was = u.tier || 0;
    u.tier = tier; u.spotted = tier === 2;
    if (c) { u.qx = c.x; u.qz = c.z; u.qt = c.t; }
    // a contact gone cold leaves a fading last-known-position ring where its "?" (or the unit) was last
    if (was >= 1 && tier === 0 && !u.destroyed) this.lastKnown(u, was === 2 ? null : u);
    else if (tier >= 1 && u.lkm) this.dropLastKnown(u);
  }
  // Woods and tree belts of mostly bare trees (dead, shelled, stripped templates) hide nothing but trunks: under 25 % of
  // their trees in leaf the belt's sight occluder goes (o.dead: see through as over open ground), under 60 % you see three
  // times as deep into it; their concealment cells (rural maps) lighten to light cover, so men there are not 'hidden'.
  // Shelling strips leafy belts during the battle (world/treeDamage.js) on top of this. Once at load.
  thinDeadWoods() {
    const nav = this.nav, C = nav.occCell, TREE = /^(tree_|leafy_summer_)/, LEAF = /^(tree_.*_leafy|leafy_summer_.*)$/, SKIP = /fallen|stump|_lod\d*$|_mid$|row$/;
    const cnt = new Map(), v = new THREE.Vector3();
    for (const P of PLACED) {
      const n = P.template?.name || ''; if (!TREE.test(n) || SKIP.test(n)) continue; const leafy = LEAF.test(n);
      for (const M of P.matrices) {
        v.setFromMatrixPosition(M); const l = nav.occGrid.get(Math.floor(v.x / C) * 4096 + Math.floor(v.z / C)); if (!l) continue;
        for (const o of l) { if (!o.foliage || o.veg) continue; const dx = v.x - o.cx, dz = v.z - o.cz, lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos; if (Math.abs(lx) > o.hx || Math.abs(lz) > o.hz) continue; const c = cnt.get(o) || cnt.set(o, [0, 0]).get(o); c[0]++; if (leafy) c[1]++; }
      }
    }
    const Cy = this.city, cc = Cy.conceal, half = (MAP.sizeM || 0) / 2; let dead = 0, thin = 0;
    for (const [o, [n, lf]] of cnt) {
      if (n < 3) continue; const f = lf / n; if (f >= 0.6) continue;
      if (f < 0.25) { o.dead = true; dead++; } else { o.depth = (o.depth || 9) * 3; thin++; }
      if (!cc || !Cy.CS) continue;   // lighten the concealment under it: light cover (0.6) for a dead wood, medium (0.45+) for a thinned one
      const R = Math.hypot(o.hx, o.hz), i0 = Math.max(0, Math.floor((o.cx - R + half) / Cy.CS)), i1 = Math.min(Cy.CN - 1, Math.floor((o.cx + R + half) / Cy.CS)), j0 = Math.max(0, Math.floor((o.cz - R + half) / Cy.CS)), j1 = Math.min(Cy.CN - 1, Math.floor((o.cz + R + half) / Cy.CS));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const x = (i + 0.5) * Cy.CS - half, z = (j + 0.5) * Cy.CS - half, dx = x - o.cx, dz = z - o.cz; if (Math.abs(dx * o.cos - dz * o.sin) > o.hx || Math.abs(dx * o.sin + dz * o.cos) > o.hz) continue; const k = j * Cy.CN + i; cc[k] = Math.max(cc[k], f < 0.25 ? 155 : 118); }
    }
    return { dead, thin };
  }
  // is the unit somewhere it can't be seen from the air (most of its men in buildings / cellars / dugouts / covered trench
  // bays or under heavy foliage; a vehicle in a forest)? (side-independent: once per spotting tick, game.updateSpotting)
  hiddenSpot(u) {
    const C = this.city, ca = C.concealAt, heavy = (x, z) => !!ca && ca.call(C, x, z) < 0.45;
    if (u.type === 'vehicle') return heavy(u.pos.x, u.pos.z);
    let n = 0, hid = 0;
    for (const s of u.soldiers) { if (!s.alive || s.state === 'dead' || s.inside === 'btr') continue; n++; if (s.inBuilding || s.cellar || heavy(s.pos.x, s.pos.z) || this.overheadCover(s.pos.x, s.pos.z)) hid++; }
    return n === 0 ? !u.mounted : hid >= n * 0.75;   // (everyone down in the dugouts: hidden)
  }
  // a trench bay under a log roof (MG nest), a dugout passage, or a section under a camo net / branches / tarp
  overheadCover(x, z) {
    const C = this.city, T = C.terrain; if (!T || !C.trenchInfo) return false;
    if (!this._cov) { this._cov = new Set(); for (const [cx, cz, , , w] of T.covers || []) { const r = Math.max(1.6, (w || 1) * 0.6); for (let dx = -r; dx <= r; dx += 0.8) for (let dz = -r; dz <= r; dz += 0.8) if (dx * dx + dz * dz <= r * r) this._cov.add(Math.floor((cx + dx) / 2) * 65536 + Math.floor((cz + dz) / 2)); } }
    if (!C.trenchInfo(x, z)) return false;
    const q = T._q; return !!(q && (q.covered || q.kind === 'pass')) || this._cov.has(Math.floor(x / 2) * 65536 + Math.floor(z / 2));
  }
  // draw what the local player knows: enemy men only when identified (the dead stay where they fell), an enemy ATGM
  // team's launcher with them; vehicles do it in their own sync (vehicle.js: u.tier)
  applyFog() {
    for (const u of this.squads) if (u.side !== 'player') fogSquad(u);
  }
  // last-known-position marker: a red ring where an enemy unit was last seen, fading over ~12 s
  lastKnown(u, at = null) {
    if (this.noRender && !this.renderer) return;
    const p = at ? { x: at.qx, z: at.qz } : u.type === 'vehicle' ? u.pos : u.center(), r = u.type === 'vehicle' ? 4 : 3.2;
    let m = u.lkm; if (!m) { m = new THREE.Mesh(this._lkG ||= new THREE.RingGeometry(0.82, 1, 40), new THREE.MeshBasicMaterial({ color: 0xc8483a, transparent: true, opacity: 0.55, depthWrite: false })); m.rotation.x = -Math.PI / 2; m.renderOrder = 4; this.scene.add(m); u.lkm = m; (this.lkms ||= new Set()).add(u); }
    m.scale.setScalar(r); m.position.set(p.x, (this.city.groundHeight?.(p.x, p.z) || 0) + 0.25, p.z); m.userData.t0 = this.time; m.visible = true;
  }
  dropLastKnown(u) { if (!u.lkm) return; this.scene.remove(u.lkm); u.lkm.material.dispose(); u.lkm = null; this.lkms?.delete(u); }
  updateLastKnown() { if (this.lkms) for (const u of [...this.lkms]) { const a = (this.time - u.lkm.userData.t0) / 12; if (a >= 1 || u.destroyed) this.dropLastKnown(u); else u.lkm.material.opacity = 0.55 * (1 - a); } }
  updateSpotting() {
    this.updateLastKnown();
    for (const u of this.squads) if (!u.destroyed) u.hid = this.hiddenSpot(u);
    for (const v of this.vehicles) if (!v.destroyed) v.hid = this.hiddenSpot(v);
    this.spotFor('player'); this.spotFor('enemy');
    this.applyFog();
    for (const sq of this.squads) if (sq.side === 'player') for (const s of sq.soldiers) s.visible = !s.cellar;   // (men down in a cellar: not drawn)
    if (Q.has('fogstats')) this.fogStats();
  }
  // test hook (?fogstats): running counts of enemy unit-ticks per tier, both sides' view
  fogStats() {
    const S = this.fogS ||= { player: [0, 0, 0], enemy: [0, 0, 0], fpv: { contact: 0, found: 0, spec: 0 } };
    for (const side of ['player', 'enemy']) for (const u of this.enemiesOf(side)) if (!(u.type === 'squad' && (u.mounted || u.medevac))) S[side][u.tierBy?.[side] || 0]++;
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
      for (const v of this.vehicles) if (!v.destroyed && !v.noncombat && !v.abandoned && v.crew > 0 && Math.hypot(v.pos.x - o.x, v.pos.z - o.z) < (o.r ?? TUNING.captureRadius)) { if (v.side === 'player') p += 1.5; else e += 1.5; }
      o.contested = p > 0 && e > 0; o.p = p; o.e = e;
      const rate = TUNING.captureRate;
      if (e > 0 && p === 0) o.control -= rate * Math.min(6, e) * dt;
      else if (p > 0 && e === 0) o.control += rate * Math.min(6, p) * dt;
      else if (e > p * 2.5) o.control -= rate * 0.5 * dt;
      else if (this.opts.net && p > e * 2.5) o.control += rate * 0.5 * dt;   // (versus: same rules for both sides)
      o.control = THREE.MathUtils.clamp(o.control, -100, 100);
      const prev = o.owner;
      if (o.control < -25 || (o.owner === 'player' && o.control < 0)) o.owner = 'enemy';
      else if (o.control > 25 || (o.owner === 'enemy' && o.control > 0 && this.opts.net)) o.owner = 'player';   // (single player: the enemy's hold is stickier -- difficulty)
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
    if (this.phase === 'deploy') { const ad = Math.min(dt, 0.05); for (const sq of this.squads) { if (sq.mounted) sq.updateRiders(ad, true); else for (const s of sq.soldiers) { s.animate(ad, this.camDist(s.pos)); s.sync(); } } for (const v of this.vehicles) v.sync(); return; }
    if (this.paused || this.over) { this.servicePaths(4); return; }
    dt = Math.min(dt, 0.05) * this.timeScale;
    this.time += dt; globalThis.__gameTime = this.time;
    this.servicePaths(this.noRender ? 50 : 5);
    this.spotT = (this.spotT || 0) - dt; if (this.spotT <= 0) { this.spotT = 0.5; this.updateSpotting(); }
    for (const sq of this.squads) {
      sq.firedT = (sq.firedT ?? 99) + dt;
      if (!sq.destroyed || sq.alive.length) sq.update(dt);
      // v7: a wiped-out squad is no longer updated - but its last dead still have to fall (death clip / ragdoll: they froze
      // standing, mid-fall or on the medic's shoulder, 'floating') and its casualties on the medevac bed to lie on it
      else if (sq.mounted) sq.updateRiders(dt);   // (dead riders slide off the deck: they lay on it, 2 m up, and rode off with it)
      else if (!sq.medevac) for (const s of sq.soldiers) if ((s.state === 'dead' && !s.corpseDone) || s.onBed) { s.vel.set(0, 0, 0); s.animate(dt, this.camDist(s.pos)); s.sync(); }
    }
    for (const v of this.vehicles) v.update(dt);
    this.vehObstacles(dt);
    // deck riders follow their vehicle's NEW position (squads update before the vehicles: placed against last frame's hull
    // they hung ~0.4 m behind their seats at speed)
    for (const sq of this.squads) if (sq.mounted && sq.carrier && !sq.carrier.destroyed) for (const s of sq.soldiers) if (s.inside === 'ride' && s.seat && s.effective) { const w = sq.carrier.seatWorld(s.seat.i); s.pos.copy(w.pos); s.sync(); }
    this.combat.update(dt);
    this.updateStrikes(); this.fires?.update();
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
    this.blood?.update(Math.min(dt, 0.05) * (this.paused ? 0 : this.timeScale), this);
    if (!this.paused) this.heli?.update(Math.min(dt, 0.05) * this.timeScale);
    for (const d of this.city.dynamic.children) if (d.userData.rise > 0) { const k = Math.min(d.userData.rise, dt * 0.8); d.position.y += k; d.userData.rise -= k; }
    if (this.audio.ok) { const f = this.cam.focus; this.audio.setListener({ x: f.x * 0.7 + cp.x * 0.3, y: 12 + (cp.y - 12) * 0.3, z: f.z * 0.7 + cp.z * 0.3 }, new THREE.Vector3(f.x - cp.x, 0, f.z - cp.z).normalize()); }
    this.netTick?.(dt);
    this.hud?.update(dt);
    this.droneFeed?.update(dt);   // FPV drone view (ui/droneFeed.js): drawn into its window after the main post chain; its CPU time counts as non-scalable work for the adaptive resolution
    if (!this.noRender) { this.renderer.dynFrame(performance.now() - f0 + (this.droneFeed?.cpuMs || 0)); this.renderer.render(dt, this.time); this.droneFeed?.render(dt); }
  }
  mortarMarker(x, z) {
    const m = new THREE.Mesh(new THREE.RingGeometry(15, 16, 48), new THREE.MeshBasicMaterial({ color: 0xd8b25a, transparent: true, opacity: 0.6, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.15, z); this.scene.add(m);
    setTimeout(() => this.scene.remove(m), 16000);
  }
}
