import * as THREE from 'three';
import { trenchNear, trenchMen } from './trench.js';
import { campaignArmy, campaignDefenders } from './campaignBattle.js';
import { SPAWNS, OBJECTIVES, MAP } from '../world/city.js';
import { TUNING } from '../config.js';
import { Intel, concealedPath, nextBound, concealOf, vehicleHide, firePosition } from './ai_tactics.js';

// v8 (previews/ai_v8/PROGRESS.md): both commanders fight the way the front has since 2023 — infantry moves concealed
// (tree lines, ruins, trenches; concealed A* + bounds that end in cover, spread out so a drone / a shell finds one group,
// not three), carriers drop their squads far out of sight of the objective, squads halt on a line of departure while the
// drones look and the guns work on what they found, then go in by bounds with one squad covering the other; tanks are
// mobile artillery from hides behind the infantry (shoot and scoot, never leading); defenders stay hidden and hold their
// fire until the enemy is close. And no cheating: the commander knows only what its side has spotted (Intel), like v2.
// LEGACY enemy commander (v1), kept for A/B benchmarks (?aiold, tools/ai_bench.mjs) and as the base class of the
// v2 Commander in ai.js (deployment, building/trench/cover helpers, the howitzer). Phase 1: dug-in defenders hold both objectives. Phase 2 (after the player takes an
// objective, or 40% into the round): counterattack waves from the north — mounted approach riding on
// armour, dismount at staging, fire-team bounding through cover with smoke, flanking routes, tank
// overwatch with stand-off from RPG teams, assault squads storming garrisoned buildings, artillery.
// per-objective AI points; objectives without hand-placed points get ones derived from the objective (enemy side = -Z)
const D2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const objXZ = k => { const o = OBJECTIVES.find(q => q.id === k) || OBJECTIVES[0]; return [o.x, o.z]; };
export const STAGING = new Proxy({}, { get: (_, k) => MAP.ai.staging?.[k] || (([x, z]) => [[x - 40, z - 90], [x + 40, z - 95], [x, z - 110], [x - 70, z - 80]])(objXZ(k)) });
export const OVERWATCH = new Proxy({}, { get: (_, k) => MAP.ai.overwatch?.[k] || (([x, z]) => [[x - 50, z - 130], [x + 50, z - 130]])(objXZ(k)) });

export class CommanderV1 {
  constructor(game) {
    this.g = game; this.units = []; this.waveI = 0; this.artT = 70 + Math.random() * 40; this.n = 0;
    this.counter = false;
    this.intel = new Intel(game, 'enemy'); this.prepT = {}; this.stats = { overwatch: 0, scoots: 0, prepFires: 0, fires: 0 };   // v8: what our side knows (no all-seeing threat checks)
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
    const lay = g.campaign ? campaignArmy(g) : MAP.ai.army;
    // campaign attack missions: the enemy holds the objectives with dug-in defenders (trenches first, else buildings)
    if (g.campaign) for (const obj of campaignDefenders(g)) {
      const o = g.objectives.find(q => q.id === obj); if (!o) continue;
      const s = g.makeSquad('enemy', o.x, o.z - 12, N, 'Enemy defenders', 'mech');
      const T = this.freeTrench(o.x, o.z, 70, s), bld = !T && this.nearBuilding(new THREE.Vector3(o.x, 0, o.z), 45, s);
      if (T) { s.orderTrench(T); for (const m of s.soldiers) if (m.trenchSlot) { m.pos.set(m.trenchSlot.x, 0, m.trenchSlot.z); m.path = null; m.pathReq = null; m.sync(); } }
      else if (bld) g.garrison(s, bld);
      this.army.push({ kind: 'defend', sq: s, obj, state: 'hold', t: 3 });
    }
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
      if (b.kind === 'mech') { const st = this.dismountPoint(b.obj); b.v.orderMove(st[0], st[1], 0, true); }
      if (b.kind === 'tank') b.v.orderMove(b.home[0], b.home[1], 0, false);
      this.units.push(b);
    }
    this.started = true;
  }
  // Ticket sense: who is bleeding whom. 'attack' when the player's objectives drain us or we are behind with nothing
  // to show for it (sitting still loses on time), 'hold' when our objectives bleed the player and we lead (no need
  // to throw men away), else 'balanced'. low = few tickets left: every loss counts, units pull back earlier.
  assess() {
    const g = this.g, T = g.tickets, held = side => g.objectives.filter(o => o.owner === side && !o.contested).length;
    const mine = held('enemy'), theirs = held('player'), lead = T ? T.enemy - T.player : 0;
    this.bleeding = theirs > mine;
    this.low = !!T && T.enemy < T.max * 0.3;
    this.posture = this.bleeding || (lead < 0 && mine <= theirs) ? 'attack' : mine > theirs && lead > -T?.max * 0.05 ? 'hold' : 'balanced';
    return this.posture;
  }
  cautious() { return this.low || this.posture === 'hold'; }
  // the objective a unit should go for: one the player holds (it bleeds us), else a free one, else its own
  pickObjective(from, cur) {
    const g = this.g, d = o => Math.hypot(o.x - from.x, o.z - from.z);
    const theirs = g.objectives.filter(o => o.owner === 'player').sort((a, b) => d(a) - d(b));
    if (theirs.length) return theirs[0].id;
    const free = g.objectives.filter(o => o.owner === 'neutral').sort((a, b) => d(a) - d(b));
    return free.length && this.posture !== 'hold' ? free[0].id : cur;
  }
  update(dt) {
    const g = this.g;
    if (!this.started) return;
    this.intelT = (this.intelT || 0) - dt; if (this.intelT <= 0) { this.intelT = 1; this.intel.update(); }
    this.assessT = (this.assessT || 0) - dt; if (this.assessT <= 0) { this.assessT = 3; this.assess(); }
    if (!this.counter && !g.campaign && (g.objectives.some(o => o.captured) || g.time > g.roundLen * 0.3)) {   // (campaign: no free reinforcement, as for the player)
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
    // artillery on what our side has found (drone picture, sightings, contacts: Intel) — v8: it used to pick the densest
    // group of ALL player units, seen or not
    this.artT -= dt;
    if (this.artT <= 0) {
      this.artT = 70 + Math.random() * 55;
      // counter-battery: a player howitzer that has been firing gives its position away (sound ranging / radar)
      // (only one its side has a fix on -- heard / seen / reported: game.spotFor contact -- fired at that estimated position)
      const pg = g.vehicles.find(v => v.side === 'player' && v.kind === 'spg' && !v.destroyed && g.time - (v.lastFireT ?? -999) < 90 && (v.tierBy?.enemy || 0) >= 1 && v.ctc?.enemy);
      const cl = this.intel.cluster(25);
      if (!(pg && Math.random() < 0.5) && !cl) { this.artT = 12; return; }   // nothing known yet: look again soon
      const cb = pg && (!cl || Math.random() < 0.5);
      if (cb) { if (this.fireOn(pg.ctc.enemy.x, pg.ctc.enemy.z, 40, false, true)) g.hud?.alert('Enemy counter-battery fire on our howitzer!', 'bad'); }
      else if (this.fireOn(cl.e.x, cl.e.z, cl.e.veh ? 30 : cl.e.contact ? 30 : 22, cl.score >= 3)) this.artT *= 0.9;
    }
  }
  // one fire mission on (x, z): our own howitzer if it can, else the heavy battery on a real concentration (rationed in
  // game/fireMission.js: cooldown, count, never danger close), else the rationed mortar missions. true = fired
  fireOn(x, z, err, heavy = false, cb = false) {
    const r = this.fireOn_(x, z, err, heavy, cb); if (r) this.stats.fires++; return r;
  }
  fireOn_(x, z, err, heavy, cb) {
    const g = this.g, own = this.spg && !this.spg.destroyed && this.spg.weapons[0].ammo > 0 && !this.spg.spg.mission ? this.spg : null;
    const ap = new THREE.Vector3(x + (Math.random() - .5) * err, 0, z + (Math.random() - .5) * err), ad = own ? Math.hypot(ap.x - own.pos.x, ap.z - own.pos.z) : 0;
    if (own && (ad >= own.def.minRange || (ad <= own.def.directRange && own.spgSees(ap)))) { own.fireAt = { p: ap }; this.artT *= 0.75; return true; }
    if (cb) return false;
    if (heavy && g.fires?.aiCall(ap.x, ap.z)) return true;
    if ((g.enemyMortars ??= (g.campaign?.enemyMortars ?? TUNING.mortarStrikes)) <= 0) return false;
    g.enemyMortars--; g.callStrike(ap.x, ap.z, 6, 16, 'enemy', 9, 'mortar'); g.hud?.alert('Incoming mortar fire!', 'bad');
    return true;
  }
  // v8 prep fire before a squad goes in from its line of departure: on the strongest known position at the objective,
  // once per objective in 90 s (the rounds come down while the squad waits in cover)
  ldPrep(obj) {
    const g = this.g; if (g.time - (this.prepT[obj] ?? -999) < 90) return false;
    const [ox, oz] = this.objPos(obj), cl = this.intel.cluster(60, [ox, oz], 120); if (!cl) return false;
    this.prepT[obj] = g.time; this.stats.prepFires++;
    return this.fireOn(cl.e.x, cl.e.z, cl.e.dug ? 12 : 20, cl.score >= 3);
  }
  // how far out carriers drop their squads (out of sight of the objective, short of the ATGM / FPV killing zone; the maps
  // are 0.5-1.4 km, so this is a fraction of the map, not the real 1-2 km)
  dismountR() { return Math.max(150, Math.min(320, (MAP.sizeM || 600) * 0.22)); }
  // the dismount point for objective `obj`: dismountR out on the line objective -> staging, in a vehicle hide (tree cover /
  // behind a building / out of the objective's sight)
  dismountPoint(obj) {
    const g = this.g, [ox, oz] = this.objPos(obj), st = this.stagingFor(obj);
    let dx = st[0] - ox, dz = st[1] - oz; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const R = Math.max(L, this.dismountR()), p = g.nav.nearestFree(ox + dx * R, oz + dz * R, 2.0, 30);
    return vehicleHide(g, p, [ox, oz], [dx, dz], 36) || p;
  }
  // the intel-based threat check (v8: v1 used to look at every player unit)
  threatsNear(p, r) { const l = this.intel.near(p.x, p.z, r, 30); return { n: l.length, rpg: this.intel.rpgNear(p.x, p.z, r) }; }
  isInf(b) { return !!b.sq && b.kind !== 'atgm' && b.kind !== 'fpv' && b.kind !== 'spg'; }
  // other squads of ours (positions + where they are going): bounds keep ~20 m off them (dispersion)
  friendSpots(sq) {
    const c = sq.center(), out = [];
    for (const q of this.g.squads) { if (q === sq || q.side !== 'enemy' || q.destroyed || q.mounted || !q.effective.length) continue; const p = q.center(); if (Math.hypot(p.x - c.x, p.z - c.z) > 160) continue; out.push([p.x, p.z]); if (q.order?.type === 'move') out.push([q.order.x, q.order.z]); }
    return out;
  }
  // bounding overwatch between squads: near the enemy one squad moves while the others of the same objective / operation
  // stay down and cover it; then the next one goes (capped: nobody waits more than ~14 s)
  overwatchWait(b, near) {
    if (!near) { b.owT = 0; return false; }
    const c = b.sq.center(), mv = q => q.sq.effective.some(s => (s.path && s.pathI < s.path.length) || s.pathReq);
    const mates = this.units.filter(q => q !== b && !q.dead && this.isInf(q) && !q.sq.destroyed && !q.sq.mounted && q.sq.effective.length && (b.op ? q.op === b.op : q.obj === b.obj) && q.sq.center().distanceTo(c) < 140);
    if (!mates.length || !mates.some(mv) || (b.owT || 0) > 14) { b.owT = 0; return false; }
    b.owT = (b.owT || 0) + 1.5; b.wait = 1.5; this.stats && (this.stats.overwatch = (this.stats.overwatch || 0) + 1);
    return true;
  }
  // fire discipline: a squad that is hidden (garrison, dug in, observing, in reserve) holds its fire until the enemy is
  // close or it is found anyway (under fire): every burst gives the position away (game.spotFor: firing = seen / heard far)
  fireDiscipline(b, hold) {
    const g = this.g, sq = b.sq; if (!sq || sq.mounted) return;
    if (!hold) { if (b.aiHold) { b.aiHold = false; sq.holdFire = false; } return; }
    const c = sq.center(), R = (MAP.sizeM || 600) > 900 ? 170 : 110;
    const close = this.intel.near(c.x, c.z, R, 8).length > 0 || this.threatsNear(c, 45).n > 0;
    if (close || sq.underFireT < 2.5) b.freeT = g.time;
    const hold2 = g.time - (b.freeT ?? -999) > 40;   // free for 40 s after the last close contact / incoming fire
    if (hold2 !== !!b.aiHold) { b.aiHold = hold2; sq.holdFire = hold2; }
  }
  // v8 tank drill ("mobile artillery"): wait in a hide behind the own infantry, out of the enemy's sight and under tree cover
  // where there is any; when there is something known to shoot at, come up to a hull-down firing position, fire on it for
  // ~15-25 s (direct fire at what is seen, area fire at the reported position), then back into the hide before the drones /
  // ATGMs find it (shoot and scoot). Never closer to the enemy than the own infantry. tgt = [x, z] to engage, back = unit
  // vector towards our side, hot = there is something to shoot at
  tankDrill(b, tgt, back, r0, r1, hot) {
    const g = this.g, v = b.v, vp = [v.pos.x, v.pos.z], now = g.time;
    let inf = 1e9; for (const q of g.squads) if (q.side === 'enemy' && !q.destroyed && !q.mounted && q.kind !== 'atgm' && q.kind !== 'fpv' && q.effective.length) { const c = q.center(); inf = Math.min(inf, Math.hypot(c.x - tgt[0], c.z - tgt[1])); }
    r0 = Math.min(Math.max(r0, inf + 50), r1 + 150); r1 = Math.max(r1, r0 + 50);   // (no own infantry out yet: stand off at r1 + 150)
    const hit = v.hp < (b.hp0 ?? v.hp) - 0.5; b.hp0 = v.hp;
    const drone = v.droneThreat && now - v.droneThreat.t < 3;
    const hideAt = (from, why) => { const h = vehicleHide(g, from, tgt, back, 84) || g.nav.nearestFree(from[0] + back[0] * 45, from[1] + back[1] * 45, 2.2, 20); b.dr = 'hide'; b.drT = now; b.hideUntil = now + 18 + Math.random() * 15; b.hideP = h; v.fireAt = null; v.orderMove(h[0], h[1], null, true); if (b.task) b.task.why = why; };
    if (!b.dr) return hideAt(b.home || vp, 'into a hide');
    if (b.dr === 'fire') {
      if (v.firedT < 2 && b.shot0 == null) b.shot0 = now;
      const up = now - b.drT;
      if (hit || drone || (b.shot0 != null && now - b.shot0 > 15 + Math.random() * 10) || up > (hot ? 60 : 30) || (!v.path && D2(vp, b.fp) > 30 && up > 40)) { this.stats && (this.stats.scoots = (this.stats.scoots || 0) + 1); return hideAt(vp, hit ? 'hit — back into cover' : 'shoot and scoot: back into the hide'); }
      // area fire on the reported position while it has no target of its own in sight
      if (!v.path && !v.target) { const e = this.intel.list(30).filter(e => Math.hypot(e.x - vp[0], e.z - vp[1]) < 600).sort((a, c) => Math.hypot(a.x - tgt[0], a.z - tgt[1]) - Math.hypot(c.x - tgt[0], c.z - tgt[1]))[0]; if (e && Math.hypot(e.x - vp[0], e.z - vp[1]) > 40) v.fireAt = { p: new THREE.Vector3(e.x, 0.6, e.z), until: now + 4 }; }
      return;
    }
    // in the hide
    if (v.path || now < b.hideUntil || !hot) return;
    const fp = firePosition(g, tgt, back, r0, r1, 0.75, true); if (!fp) { b.hideUntil = now + 10; return; }
    b.dr = 'fire'; b.drT = now; b.shot0 = null; b.fp = fp; v.orderMove(fp[0], fp[1], Math.atan2(tgt[0] - fp[0], tgt[1] - fp[1]), true);
    if (b.task) b.task.why = 'up into a firing position';
  }
  spawnWave(w) {
    const g = this.g, sp = SPAWNS.attacker;
    const target = () => { const held = g.objectives.filter(o => o.owner === 'player'), free = g.objectives.filter(o => o.owner === 'neutral'); const l = held.length ? held : free.length ? free : g.objectives; return l[this.n++ % l.length].id; };
    const at = i => sp[(this.n + i) % sp.length];
    for (let i = 0; i < w.mech; i++) {
      const [x, z] = at(i), obj = target(); const v = g.makeVehicle('enemy', 'btr', x + (Math.random() - .5) * 6, z, 0);
      const s = g.makeSquad('enemy', x, z, 0, 'Enemy squad'); s.board(v, true);
      const st = this.dismountPoint(obj); v.orderMove(st[0], st[1], 0, true);
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
  // v7: a squad dug into a trench stays and fights while it is in contact (under fire in the last 15 s, or enemy known within
  // 250 m): it goes to ground in the trench (squad.trenchThink / cower) and returns fire. It leaves only when overrun (enemy in the
  // trench or within 22 m) - or once the contact has gone quiet (a covered withdrawal / the next task). Every 'pull back / regroup
  // / carry on / counterattack / reposition' path checks this first: before, they took men out of the trench into the open the
  // moment the fire came in, where they were cut down.
  overrun(sq) {
    const c = sq.center();
    for (const q of this.g.squads) if (q.side !== sq.side && !q.destroyed && !q.mounted) for (const s of q.effective) if (!s.aboard && Math.hypot(s.pos.x - c.x, s.pos.z - c.z) < 22) return true;
    return !!sq.trench && trenchMen(this.g, sq.trench, sq.side === 'enemy' ? 'player' : 'enemy').length > 0;
  }
  dugInHold(b) {
    const sq = b?.sq; if (!sq || !sq.trench || sq.routing || sq.mounted) return false;
    if (this.overrun(sq)) return false;
    return sq.underFireT < 15 || this.threatsNear(sq.center(), 250).n > 0;
  }
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
    if (tgt.owner === 'enemy' && b.state !== 'hold') b.obj = this.pickObjective(sq.center(), b.obj);
    if (b.kind === 'mech' && b.state === 'approach') {
      const v = b.v, [ox, oz] = this.objPos(b.obj);
      const arrived = !v.path || v.destroyed || v.immobile;
      // v8: out well short of the objective (dismountPoint), or at once when something known is within reach of the carrier
      const danger = sq.underFireT < 2 || v.hp < v.def.hp * 0.85 || this.threatsNear(v.pos, this.dismountR() * 0.8).n > 0;
      const near = Math.hypot(v.pos.x - ox, v.pos.z - oz) < this.dismountR() - 10;
      if ((arrived || danger || near) && sq.mounted) {
        if (!v.destroyed) v.halt();
        sq.dismount(Math.atan2(ox - v.pos.x, oz - v.pos.z));
        b.state = 'advance'; b.t = 3; b.bound = 0; b.vState = 'support';
      }
      return;
    }
    if (b.v && !b.v.destroyed && b.vState === 'support' && !sq.mounted) this.supportVehicle(b);
    if (sq.mounted) return;
    this.fireDiscipline(b, b.state === 'hold' && (!!sq.building || !!sq.trench));   // v8: a hidden garrison holds fire until the enemy is close
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
      if (!sq.building && !sq.trench && !moving) b.state = 'advance';   // (v7: a trench is a strongpoint too - it was dropped at once)
      else if (g.time > b.holdT && sq.morale > 55 && this.friendsNear(c, 90) >= 1 && sq.underFireT > 4 && !this.dugInHold(b)) { b.state = 'advance'; sq.leaveBuilding(); }
      else { b.wait = 3; return; }
    }
    // ---- badly hurt or shaken and outgunned: pull back to cover / a building on the own side and regroup
    const strength = sq.effective.length / sq.soldiers.length;
    const careful = this.cautious();   // ahead on objectives / short of tickets: don't spend men needlessly
    if ((strength <= (careful ? 0.55 : 0.45) || sq.morale < (careful ? 42 : 36)) && b.state !== 'hold' && !sq.building && !this.dugInHold(b)) {
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
      const Tp = (g.city.trenchSystems || []).filter(T => Math.hypot(T.center[0] - ox, T.center[1] - oz) < T.radius + 90 && this.knownIn(T)).sort((p, q) => Math.hypot(p.center[0] - c.x, p.center[1] - c.z) - Math.hypot(q.center[0] - c.x, q.center[1] - c.z))[0];
      if (Tp && Math.hypot(Tp.center[0] - c.x, Tp.center[1] - c.z) < Tp.radius + 110) { sq.orderClearTrench(Tp); b.wait = 8; return; }
      const target = this.knownBuildings().sort((p, q) => Math.hypot(p.x - ox, p.z - oz) - Math.hypot(q.x - ox, q.z - oz))[0];
      if (target && Math.hypot(target.x - c.x, target.z - c.z) < 110) { sq.orderGarrison(target); b.wait = 4; return; }
    }
    if (b.state === 'hold') {
      if (g.objectives.every(o => o.owner === 'enemy')) return;
      // the point we sit on bleeds the player: stay; the player's points bleed us: send men to contest them
      const own = g.objectives.find(o => o.id === b.obj), guards = own ? this.friendsNear(new THREE.Vector3(own.x, 0, own.z), 45) : 0;
      const p = this.posture === 'attack' ? (guards > 1 ? 0.2 : 0.08) : this.posture === 'hold' ? 0 : 0.04;
      if (Math.random() < p && !this.dugInHold(b) && sq.underFireT > 20) { const others = g.objectives.filter(o => o.id !== b.obj && o.owner !== 'enemy'); if (others.length) { b.state = 'advance'; b.obj = (others.find(o => o.owner === 'player') || others[Math.floor(Math.random() * others.length)]).id; if (sq.building) sq.leaveBuilding(); } }
      return;
    }
    if (dObj < 22) { b.state = 'hold'; const T = this.freeTrench(ox, oz, 70, sq); if (T && Math.random() < 0.7) { sq.orderTrench(T); return; } const bld = this.nearBuilding(new THREE.Vector3(ox, 0, oz), 30, sq); if (bld && Math.random() < 0.6) sq.orderGarrison(bld); return; }
    if (sq.building && sq.underFireT < 4 && Math.random() < 0.7) { b.wait = 5; return; }
    if (this.dugInHold(b)) { b.wait = 4; return; }   // v7: in a trench and in contact: fight from it (no bound out into the open)
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
      if (local > friends + (careful ? 0 : 1) && sq.morale < (careful ? 70 : 60)) { const cv = this.coverSpot(c, T, 14); if (cv) sq.orderMove(cv[0], cv[1], Math.atan2(T.x - cv[0], T.z - cv[1]), 12, true); b.wait = 8 + Math.random() * 6; return; }
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
    // v8 line of departure: the first time a squad comes within ~LD of its objective it goes to ground concealed; the drones
    // look (Intel), the guns prepare what they found (ldPrep), then it goes in. Not when the objective is ours to take empty.
    const LD = this.dismountR() * 0.8, objO = g.objectives.find(o => o.id === b.obj);
    if (!this.ops && dObj < LD && dObj > 70 && b.ldObj !== b.obj && objO?.owner !== 'neutral') {
      if (!b.ldT) { b.ldT = g.time; const cv = this.coverSpot(c, new THREE.Vector3(ox, 0, oz), 16); if (cv) sq.orderMove(cv[0], cv[1], Math.atan2(ox - cv[0], oz - cv[1]), 16, false); b.wait = 4; return; }
      const known = this.intel.near(ox, oz, 130, 60).length;
      if (g.time - b.ldT < (known ? 10 : 22)) { b.wait = 3; return; }
      b.ldObj = b.obj; b.ldT = 0;
      if (known && this.ldPrep(b.obj)) { b.wait = 14; return; }   // the rounds come down, then the squad goes
    }
    // next bound along a concealed route (tree lines, ruins, walls, trenches: ai_tactics.concealedPath), ending in cover and
    // ~20 m off the other squads; while still far out the route aims past the objective's flank (several directions)
    const nearE = dObj < LD + 60 || this.threatsNear(c, 300).n > 0;
    if (this.overwatchWait(b, nearE && dObj > 45)) return;
    let gx = ox, gz = oz;
    if (b.flank && dObj > 120) { const dx = ox - c.x, dz = oz - c.z, L = Math.hypot(dx, dz) || 1; [gx, gz] = g.nav.nearestFree(ox + (-dz / L) * b.flank * 45, oz + (dx / L) * b.flank * 45, 0.5, 15); }
    const th0 = this.intel.near(c.x, c.z, 320, 45)[0];
    const path = concealedPath(g, [c.x, c.z], [gx, gz], th0 ? [th0.x, th0.z] : null);
    if (!path || path.length < 1) { sq.orderMove(ox, oz, null, 16, true); return; }
    const step = dObj < 60 ? dObj + 5 : nearE ? 28 + Math.random() * 14 : 75;
    const nb = nextBound(g, path, [c.x, c.z], step, dObj < 60 ? null : this.friendSpots(sq)), [tx, tz] = nb.p, openLeg = nb.open > 0.6 && nearE;
    const facing = Math.atan2(ox - tx, oz - tz);
    const assault = dObj < 60 && sq.effective.length >= 3;
    if (sq.underFireT < 5 && (b.smokes ?? 2) > 0 && Math.random() < 0.55) {
      const thrower = sq.effective.find(s => !s.inside); if (thrower) { b.smokes = (b.smokes ?? 2) - 1; g.combat.throwSmoke(thrower, new THREE.Vector3(ox, 0, oz)); }
    }
    // under fire: move by fire teams (half covers while the other half moves)
    // open ground near the enemy: fire teams bound (one covers, one moves: half the men in the open at a time), wider spacing
    sq.orderMove(tx, tz, facing, assault ? 14 : openLeg ? 22 : 18, assault || sq.underFireT > 6, false, (sq.underFireT < 6 || openLeg) && sq.effective.length > 3);
    b.bound++;
    b.wait = assault ? 2 : nearE ? 4 + Math.random() * 5 : 1.5;
  }
  // a trench system near (x,z) with room for most of the squad and no player troops in it
  freeTrench(x, z, r, sq) {
    const g = this.g, n = sq.effective.length;
    return (g.city.trenchSystems || []).filter(T => Math.hypot(T.center[0] - x, T.center[1] - z) < T.radius + r && T.slots.filter(sl => !sl.occupant || !sl.occupant.effective).length >= Math.min(n, 4) && !this.knownIn(T))
      .sort((p, q) => Math.hypot(p.center[0] - x, p.center[1] - z) - Math.hypot(q.center[0] - x, q.center[1] - z))[0] || null;
  }
  // v8 (no cheating): is the enemy KNOWN to be in trench system T / which buildings is he known to hold (identified squads)
  knownIn(T, age = 60) { return this.intel.list(age).some(e => !e.veh && Math.hypot(e.x - T.center[0], e.z - T.center[1]) < T.radius + 6 && (e.contact || e.u.trench === T)); }
  knownBld(bl) { const g = this.g; if (this._kbT !== Math.floor(g.time)) { this._kbT = Math.floor(g.time); this._kb = new Set(this.knownBuildings(30)); } return this._kb.has(bl); }
  knownBuildings(age = 60) { const s = new Set(); for (const e of this.intel.list(age)) if (!e.veh && !e.contact && e.u.building && !e.u.building.collapsedAll) s.add(e.u.building); return [...s]; }
  thinkDefender(b) {
    const g = this.g, sq = b.sq, o = g.objectives.find(q => q.id === b.obj);
    if (sq.routing) return;
    this.fireDiscipline(b, !!sq.building || !!sq.trench);   // v8: hidden until the enemy is close
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
    // v8: the carrier follows 50-130 m behind its squad, hull-down on the objective where it can (fire support from the
    // rear, not leading); it used to close up to 35 m behind the men
    const [ox, oz] = this.objPos(b.obj), dc = v.pos.distanceTo(c), ahead = Math.hypot(v.pos.x - ox, v.pos.z - oz) < Math.hypot(c.x - ox, c.z - oz) + 25;
    if ((dc > 130 || ahead) && !v.path && this.g.time - (b.svT || 0) > 12) {
      b.svT = this.g.time; const back = new THREE.Vector3(c.x - ox, 0, c.z - oz).normalize(), dO = Math.hypot(c.x - ox, c.z - oz);
      const p = firePosition(this.g, [ox, oz], [back.x, back.z], dO + 50, dO + 120, 0.5, true) || [c.x + back.x * 70, c.z + back.z * 70]; v.orderMove(p[0], p[1]);
    }
    if (v.hp < v.def.hp * (this.cautious() ? 0.5 : 0.4) && !b.retreated) { b.retreated = true; const [x, z] = this.stagingFor(b.obj); v.orderMove(x, z - 60); }
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
      const sc = nav.coverFrom(x, z, T.x, T.z) - rr * 0.015 + (nav.low[i] ? 0.05 : 0) + (1 - concealOf(this.g, x, z)) * 0.4;   // v8: + out of sight (tree belt, wall)
      if (sc > bs) { bs = sc; best = [x, z]; }
    }
    return best;
  }
  // nearest usable building lying back along `dir` (toward the own side) from c, within r
  buildingBehind(c, dir, r, sq) {
    let best = null, bs = 1e9;
    for (const bl of this.g.allBuildings()) {
      if (bl.collapsedAll) continue; const dx = bl.x - c.x, dz = bl.z - c.z, d = Math.hypot(dx, dz); if (d > r || d < 8) continue;
      const along = (dx * dir.x + dz * dir.z) / (d || 1); if (along < 0.3) continue;
      if (!bl.slots.some(s => !s.occupant && !s.panel.gone) || this.knownBld(bl)) continue;
      const sc = d - along * 20; if (sc < bs) { bs = sc; best = bl; }
    }
    return best;
  }
  nearBuilding(c, r, sq) {
    let best = null, bd = r;
    for (const bl of this.g.allBuildings()) { if (bl.collapsedAll) continue; const [lx, lz] = bl.toLocal(c.x, c.z); const d = Math.max(0, Math.abs(lx) - bl.L / 2) + Math.max(0, Math.abs(lz) - bl.D / 2); if (d < bd && bl.slots.some(s => !s.occupant && !s.panel.gone) && !this.knownBld(bl)) { bd = d; best = bl; } }
    return best;
  }
  // the enemy howitzer: stays emplaced in the rear; after firing it sometimes relocates ("shoot and scoot") to dodge
  // counter-battery fire, especially when a player howitzer is around
  thinkSpg(b) {
    const v = b.v, g = this.g; if (v.destroyed) { b.dead = true; return; }
    const S = v.spg;
    if (b.state === 'emplaced' && S.missions > (b.seen ?? 0)) {
      b.seen = S.missions;
      const threat = g.vehicles.some(o => o.side === 'player' && o.kind === 'spg' && !o.destroyed && g.time - (o.lastFireT ?? -999) < 300) ? 0.55 : 0.25;   // (v8: a player battery that has been heard firing)
      if (!S.mission && Math.random() < threat) {
        b.home ??= [v.pos.x, v.pos.z];
        const a = Math.random() * Math.PI * 2, r = 35 + Math.random() * 35;
        const [x, z] = g.nav.nearestFree(b.home[0] + Math.cos(a) * r, b.home[1] + Math.sin(a) * r * 0.5, 2.4, 30);
        v.orderMove(x, z, 0, false); b.state = 'relocating';
      }
    } else if (b.state === 'relocating' && !v.path && S.state !== 'packing') b.state = 'emplaced';
  }
  thinkVehicle(b) {
    const v = b.v, g = this.g; if (v.destroyed) { b.dead = true; return; }
    if (v.crew < 2 || v.hp < v.def.hp * (this.cautious() ? 0.45 : 0.35)) { if (!b.retreating) { b.retreating = true; v.fireAt = null; v.orderMove(b.home[0], b.home[1] - 80); } return; }
    // the player's objectives bleed us: shift the tank's overwatch onto one of them (stand-off, not a charge)
    if (b.kind === 'tank' && this.bleeding && g.time > (b.shiftT || 0) && !v.path) {
      const o = g.objectives.find(q => q.id === b.obj);
      if (o && o.owner !== 'player') { const n = this.pickObjective(v.pos, b.obj); if (n !== b.obj) { b.obj = n; b.home = OVERWATCH[n][Math.floor(Math.random() * 2)]; b.shiftT = g.time + 60; b.dr = null; } }
    }
    const t = this.threatsNear(v.pos, 75), f = this.friendsNear(v.pos, 40);
    if (t.rpg > 0 && f === 0 && !v.path) { // back off out of RPG range (from the known infantry: v8, no all-seeing)
      const away = new THREE.Vector3(); for (const e of this.intel.near(v.pos.x, v.pos.z, 80, 30)) if (!e.veh) away.add(new THREE.Vector3(v.pos.x - e.x, 0, v.pos.z - e.z).normalize());
      if (away.lengthSq() < 0.01) away.set(0, 0, -1); away.normalize(); const p = v.pos.clone().addScaledVector(away, 50); const [x, z] = g.nav.nearestFree(p.x, p.z, 2.2, 20); v.orderMove(x, z);
      if (b.dr) { b.dr = 'hide'; b.drT = g.time; b.hideUntil = g.time + 15; } return;
    }
    if (b.kind === 'vdefend') return;
    // v8: the tank drill (tankDrill: hide behind the infantry, up to fire on what is known at the objective, back again).
    // It used to creep up to the objective whenever it had nothing to shoot at.
    const [ox, oz] = this.objPos(b.obj), known = this.intel.list(30).filter(e => Math.hypot(e.x - ox, e.z - oz) < 230);
    const tgtE = known.find(e => e.armour) || known.sort((a, c) => c.pow - a.pow)[0];
    const fight = g.squads.some(q => q.side === 'enemy' && !q.destroyed && !q.mounted && q.underFireT < 5 && Math.hypot(q.center().x - ox, q.center().z - oz) < 220);
    let bx = b.home[0] - ox, bz = b.home[1] - oz, L = Math.hypot(bx, bz);
    if (L < 30) { const sp = SPAWNS.attacker[0]; bx = sp[0] - ox; bz = sp[1] - oz; L = Math.hypot(bx, bz) || 1; }
    this.tankDrill(b, tgtE ? [tgtE.x, tgtE.z] : [ox, oz], [bx / L, bz / L], 150, 260, !!tgtE || fight);
  }
}

