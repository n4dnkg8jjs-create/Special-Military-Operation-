import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three';
import { WEAPONS, TUNING } from '../config.js';
import { angDiff } from './squad.js';
import { initArmor, resolveHit } from './armor.js';

const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
const rf = (a, b) => a + Math.random() * (b - a);
const TRACER = { RU: [0.62, 1.0, 0.34], UA: [1.0, 0.42, 0.14] }; // green-yellow / orange-red burning tracer compound

export class Combat {
  constructor(game) { this.g = game; this.projectiles = []; }

  // ---------------------------------------------------------------- line of sight
  los(ax, ay, az, bx, by, bz, ignoreA, ignoreB) {
    const o = this.g.nav.occluded(ax, ay, az, bx, by, bz, ignoreA, ignoreB);
    return !o;
  }
  soldierEye(s, out = A) { const pv = s.peek ? s.peekVec : null; return out.set(s.pos.x + (pv ? pv[0] : 0), s.pos.y + s.headHeight(), s.pos.z + (pv ? pv[1] : 0)); }
  targetPoint(t, out = B) {
    if (t.type === 'vehicle') return out.set(t.pos.x, 1.5, t.pos.z);
    const k = t.peek ? (t.peekAmt || 0) : 0, pv = t.peekVec;
    return out.set(t.pos.x + (k ? pv[0] * k * 0.78 : 0), t.pos.y + t.headHeight() * 0.75, t.pos.z + (k ? pv[1] * k * 0.78 : 0));
  }
  // hugging a wall with the enemy further along it: lean out from the wall to shoot (peek clip), then back
  wallLean(s) {
    if (s.inBuilding || s.aboard || s.stance === 'prone' || s.vel.lengthSq() > 0.2) return;
    const nav = this.g.nav, i = nav.idx(s.pos.x, s.pos.z); if (i < 0 || nav.clear[i] > 1.4 || !nav.cover[i]) return;
    const m = nav.cover[i]; let wx = 0, wz = 0;
    for (let q = 0; q < 8; q++) if (m & (1 << q)) { wx += Math.cos(q * Math.PI / 4); wz += Math.sin(q * Math.PI / 4); }
    const wl = Math.hypot(wx, wz); if (wl < 0.5) return; wx /= wl; wz /= wl;
    const tp = s.target.pos, h = Math.atan2(tp.x - s.pos.x, tp.z - s.pos.z), tx = Math.sin(h), tz = Math.cos(h);
    if (Math.abs(tx * wx + tz * wz) > 0.55) return;            // target isn't along the wall line
    const rx = -Math.cos(h), rz = Math.sin(h), side = (rx * wx + rz * wz) > 0 ? -1 : 1; // lean away from the wall
    const k = nav.idx(s.pos.x + rx * side * 0.6, s.pos.z + rz * side * 0.6); if (k < 0 || nav.cost[k] === 255) return;
    if (!s.peek) s.peekT = 0;
    s.peek = side; s.peekVec = [rx * side * 0.45, rz * side * 0.45];
  }
  // standing at a wall corner with the target hidden: can he lean out left/right and see it?
  tryPeek(s, cands, ignA) {
    if (s.inBuilding || s.aboard || s.stance === 'prone' || s.vel.lengthSq() > 0.2 || s.weaponKey === 'rpg7') return false;
    const nav = this.g.nav;
    for (let i = 0; i < Math.min(3, cands.length); i++) {
      const t = cands[i][0]; if (t.type === 'vehicle') continue;
      const tp = this.targetPoint(t, B), h = Math.atan2(tp.x - s.pos.x, tp.z - s.pos.z), rx = -Math.cos(h), rz = Math.sin(h);
      for (const side of [1, -1]) {
        const ox = rx * side * 0.95, oz = rz * side * 0.95, k = nav.idx(s.pos.x + ox, s.pos.z + oz);
        if (k < 0 || nav.cost[k] === 255) continue;
        const ey = s.pos.y + s.headHeight();
        if (this.los(s.pos.x + ox, ey, s.pos.z + oz, tp.x, tp.y, tp.z, ignA, this.bldOf(t) || t)) { s.target = t; s.peek = side; s.peekVec = [ox, oz]; s.heading = h; return true; }
      }
    }
    return false;
  }
  bldOf(s) { return s && s.inBuilding ? s.bld : null; }

  // ---------------------------------------------------------------- infantry
  soldierCombat(s, dt) {
    const sq = s.squad;
    s.scanT -= dt;
    if (s.reloadT > 0) { s.reloadT -= dt; if (s.reloadT <= 0) this.finishReload(s); return; }
    if (s.scanT <= 0) { s.scanT = 0.7 + Math.random() * 0.5; this.acquire(s); }
    // RPG-22 sequence in progress: aim, fire, discard tube
    if (s.launcherT > 0) {
      s.launcherT -= dt;
      const tv = s.launcherTarget;
      if (!s.launchFired && s.launcherT < 1.0 && tv && !tv.destroyed) { s.launchFired = true; this.fireRpg(s, tv, WEAPONS.rpg22, true); }
      if (s.launcherT <= 0) { s.discardLauncher(); s.launcherTarget = null; }
      return;
    }
    const t = s.target; if (!t) return;
    if (sq.holdFire && !(sq.order?.type === 'attack')) return;
    if (s.ducking && s.inside !== 'ride') return;                     // head down behind cover
    if (s.peek && s.peekAmt < 0.85) return;                          // still leaning out from the corner
    if (s.rpg22 > 0 && t.type === 'vehicle' && s.inside !== 'ride' && Math.hypot(t.pos.x - s.pos.x, t.pos.z - s.pos.z) < WEAPONS.rpg22.range && s.vel.lengthSq() < 0.5) {
      s.rpg22--; s.launcherT = 2.7; s.launchFired = false; s.launcherTarget = t; s.raiseLauncher(); return;
    }
    // hand grenades at close range (RGD-5 / F-1): into windows or over cover
    if ((s.grenades ?? 2) > 0 && t.type !== 'vehicle' && (s.grenT = (s.grenT ?? 4) - dt) <= 0) {
      s.grenT = (s.assault ? 3.5 : 6) + Math.random() * 6;
      const d = Math.hypot(t.pos.x - s.pos.x, t.pos.z - s.pos.z);
      if (d < (s.assault ? 34 : 28) && d > 7 && Math.random() < (s.assault ? 0.8 : 0.55) && !s.inside) { s.throwWindow = !!t.inBuilding; this.throwGrenade(s, t); return; }
    }
    // nobody fires from the hip on the move: a walking man pauses, shoulders the weapon and shoots; runners don't
    if (s.vel.lengthSq() > 0.5) { if (!sq.run && !sq.routing && !s.dragging && !s.waitTeam && (s.aimStopT || 0) <= 0 && Math.random() < 0.35) s.aimStopT = 1.2 + Math.random() * 1.3; return; }
    // facing check
    const want = Math.atan2(t.pos.x - s.pos.x, t.pos.z - s.pos.z);
    if (Math.abs(angDiff(want, s.heading)) > 0.3) return;
    s.fireCd -= dt; if (s.fireCd > 0) return;
    const W = s.weapon;
    if (s.inMag <= 0) { this.startReload(s); return; }
    if (W.type === 'at') { this.fireRpg(s, t); return; }
    if (s.burstLeft <= 0) s.burstLeft = Math.round(rf(W.burst[0], W.burst[1] + 0.49));
    s.burstLeft--; s.inMag--;
    s.fireCd = s.burstLeft > 0 ? 60 / W.rof : rf(W.burstGap[0], W.burstGap[1]) * (1 + s.suppression / 60);
    this.fireSmallArms(s, t, W);
  }
  acquire(s) {
    const g = this.g, sq = s.squad, eye = this.soldierEye(s, A).clone();
    const range = s.weapon.range;
    // focus target from orders first
    const cands = [];
    const consider = (t, prio) => { const d = Math.hypot(t.pos.x - s.pos.x, t.pos.z - s.pos.z); if (d > range) return; cands.push([t, d - prio]); };
    for (const u of g.enemiesOf(sq.side)) {
      if (!g.seen(sq.side, u, s.pos)) continue;
      if (u.type === 'vehicle') { if (!u.destroyed) consider(u, s.weaponKey === 'rpg7' ? 120 : (s.rpg22 > 0 && Math.hypot(u.pos.x - s.pos.x, u.pos.z - s.pos.z) < 160) ? 90 : -40); continue; }
      const focus = sq.focus === u ? 30 : 0;
      // priority: machine gunners and anti-tank gunners first, then leaders; men in the open over men behind cover
      for (const e of u.soldiers) if (e.effective && e.inside !== 'btr') consider(e, focus + (e.inBuilding ? -10 : 0) + (e.weaponKey === 'pkm' ? 25 : 0) + (e.weaponKey === 'rpg7' || e.rpg22 > 0 ? 18 : 0) + (e.role?.leader ? 10 : 0) + (e.vel.lengthSq() > 1 ? 12 : 0) - (this.g.nav.coverFrom(e.pos.x, e.pos.z, s.pos.x, s.pos.z) * 15));
    }
    if (s.weaponKey === 'rpg7') { // RPG gunner: only vehicles or garrisoned clusters
      for (let i = cands.length - 1; i >= 0; i--) { const t = cands[i][0]; if (t.type !== 'vehicle' && !(t.inBuilding && cands[i][1] < 120 && Math.random() < 0.25)) cands.splice(i, 1); }
      if (!cands.length && s.sideKey && s.sideMags > 0) { this.swapToSide(s); return this.acquire(s); }
    }
    cands.sort((a, b) => a[1] - b[1]);
    const ignA = this.bldOf(s);
    // keep current target if still valid
    if (s.target && cands.some(c => c[0] === s.target)) {
      const tp = this.targetPoint(s.target, B);
      if (this.los(eye.x, eye.y, eye.z, tp.x, tp.y, tp.z, ignA, this.bldOf(s.target) || s.target)) return;
    }
    s.target = null;
    const peeked = s.peek; s.peek = 0; this.soldierEye(s, eye);
    for (let i = 0; i < Math.min(5, cands.length); i++) {
      const t = cands[i][0], tp = this.targetPoint(t, B);
      if (this.los(eye.x, eye.y, eye.z, tp.x, tp.y, tp.z, ignA, this.bldOf(t) || t)) { s.target = t; break; }
    }
    if (!s.target && this.tryPeek(s, cands, ignA)) { if (!peeked) s.peekT = 0; }
    else if (s.target && s.target.type !== 'vehicle') this.wallLean(s);
    if (!s.target && s.sideKey && s.weaponKey !== 'rpg7' && s.origWeapon) this.swapBack(s);
  }
  swapToSide(s) { if (s.origWeapon) return; s.origWeapon = { key: s.weaponKey, mags: s.mags, inMag: s.inMag }; s.weaponKey = s.sideKey; s.weapon = WEAPONS[s.sideKey]; s.mags = s.sideMags; s.inMag = 0; s.reloadT = 1.5; }
  swapBack(s) { const o = s.origWeapon; s.sideMags = s.mags + (s.inMag > 0 ? 1 : 0); s.weaponKey = o.key; s.weapon = WEAPONS[o.key]; s.mags = o.mags; s.inMag = o.inMag; s.origWeapon = null; }
  startReload(s) {
    if (s.mags <= 0) {
      // out of ammo: borrow from squadmates / drop to side arm
      const donor = s.squad.effective.find(o => o !== s && o.weaponKey === s.weaponKey && o.mags > 2);
      if (donor) { donor.mags--; s.mags++; }
      else if (s.weaponKey === 'rpg7') { const asst = s.squad.soldiers.find(o => o.rpgCarried > 0 && o.effective); if (asst) { asst.rpgCarried--; s.mags++; } else if (s.sideKey) { this.swapToSide(s); return; } }
      if (s.mags <= 0) { s.target = null; s.outOfAmmo = true; return; }
    }
    s.reloadT = s.weapon.reload * (s.state === 'light' ? 1.4 : 1) * rf(0.9, 1.2);
    if (this.g.camDist(s.pos) < 40) this.g.sfx('reload', s.pos);
  }
  finishReload(s) { if (s.mags > 0) { s.mags--; s.inMag = s.weapon.mag; } s.outOfAmmo = false; }
  hitChance(s, t, W, d) {
    let p = W.type === 'mg' ? 0.32 : 0.42;
    // aimed fire falls off steeply with range (wind, holdover, a man-sized target is tiny at 300 m)
    const sc = W.type === 'mg' ? 125 : W.type === 'dmr' ? 160 : 95;
    p *= Math.exp(-Math.pow(d / sc, 1.35));
    if (W.optic) p *= 1.15;
    p *= 0.85 * (1 - Math.min(0.85, s.suppression / 110));
    if (s.squad.pinned) p *= 0.6;
    if (s.state === 'light') p *= 0.7;
    if (s.vel.lengthSq() > 0.5) p *= 0.3;
    if (s.stance === 'prone') p *= 1.25; else if (s.stance === 'crouch') p *= 1.1;
    if (s.squad.morale < 45) p *= 0.8;
    if (t.type === 'vehicle') return Math.min(0.95, p * 4);
    // target modifiers
    if (t.ducking) p *= 0.3;
    if (t.inBuilding) p *= 0.3;
    else if (t.inside === 'ride') p *= 0.75;
    else {
      const cov = this.g.nav.coverFrom(t.pos.x, t.pos.z, s.pos.x, s.pos.z);
      p *= 1 - cov * (t.stance === 'stand' ? 0.45 : 0.72);
      if (t.stance === 'prone') p *= 0.5; else if (t.stance === 'crouch') p *= 0.75;
      if (t.vel.lengthSq() > 4) p *= 0.65;
    }
    if (t.state === 'critical' || t.state === 'stable') p *= 0.6;
    return THREE.MathUtils.clamp(p, 0.004, 0.75);
  }
  fireSmallArms(s, t, W) {
    const g = this.g, from = s.muzzleWorld(C).clone(), tp = this.targetPoint(t, B).clone();
    const d = from.distanceTo(tp);
    s.kick = 1; s.squad.firedT = 0; s.firingT = W.type === 'mg' ? 0.5 : 0.35;
    const near = g.camDist(s.pos) < 220;
    if (near) g.fx.muzzle(from, tp.clone().sub(from).normalize(), W.type === 'mg' ? 1.1 : 0.8);
    g.sfx(W.sound === 'mg' ? 'mg_near' : 'rifle_near', s.pos);
    const hit = Math.random() < this.hitChance(s, t, W, d);
    let end = tp.clone();
    if (!hit) { const miss = 0.6 + d * 0.022; end.x += (Math.random() - .5) * miss * 2; end.y = Math.max(0.05, end.y + (Math.random() - .6) * miss); end.z += (Math.random() - .5) * miss * 2; end.addScaledVector(end.clone().sub(from).normalize(), Math.random() * 6); }
    s.shots = (s.shots || 0) + 1;
    // tracers: Russian green, Ukrainian red, about every 3rd–4th round
    s.nextTracer ??= 3 + Math.floor(Math.random() * 2);
    if (--s.nextTracer <= 0) { s.nextTracer = 3 + Math.floor(Math.random() * 2); if (g.camDist(s.pos) < 450) g.fx.tracer(from, end, 800, TRACER[s.faction.id]); }
    if (t.type === 'vehicle') {
      if (hit) { if (near) g.fx.impact(end, 'metal'); this.hitVehicle(t, W, s.pos, 'ke', s); if (Math.random() < 0.2) g.sfx('ricochet', end); }
      return;
    }
    // suppression on the target and his neighbours
    const sup = (W.suppress || 1) * (hit ? 10 : 7);
    for (const o of t.squad.soldiers) if (o.effective && o.pos.distanceToSquared(end) < 16) o.suppression = Math.min(100, o.suppression + sup * (o === t ? 1.4 : 0.6));
    t.squad.underFireT = 0; t.squad.flankDirs.push(Math.atan2(s.pos.x - t.pos.x, s.pos.z - t.pos.z));
    if (hit) this.hitSoldier(t, W, s.pos, false, s);
    else {
      const inB = t.inBuilding ? t.bld : null;
      if (near) g.fx.impact(end, inB ? 'concrete' : 'dirt', 0.6);
      if (g.camDist(end) < 30 && Math.random() < 0.25) g.sfx(Math.random() < 0.5 ? 'bullet_whizz' : (inB ? 'impact_concrete' : 'impact_dirt'), end, { gain: 0.6 });
    }
  }
  throwGrenade(s, t) {
    s.grenades = (s.grenades ?? 2) - 1; s.throwT = 1.2; s.fireCd = 1.5;
    const to = t.inBuilding ? t.bld.panelCenter(t.inside.panel, new THREE.Vector3()) : t.pos.clone();
    to.x += (Math.random() - .5) * 4; to.z += (Math.random() - .5) * 4;
    if (this.g.camDist(s.pos) < 60) this.g.sfx('grenade_pin', s.pos);
    this.projectiles.push({ kind: 'grenade', pos: s.pos.clone().setY(1.6), from: s.pos.clone().setY(1.6), target: to, t: null, speed: 14, owner: s, side: s.squad.side, fuse: 0, arc: true });
  }
  throwSmoke(s, toward) {
    const p = s.pos.clone().lerp(toward, Math.min(1, 18 / s.pos.distanceTo(toward)));
    this.g.fx.smokeScreen(p); this.g.sfx('grenade_throw', s.pos);
    const o = this.g.nav.addOccluder(p.x, p.z, 5, 5, 0, 7, null);
    o.smokeUntil = this.g.time + 30;
  }
  // ---------------------------------------------------------------- close quarters (building storming)
  stormTick(sq, dt) {
    const o = sq.order, b = o.building, g = this.g;
    const defenders = b.slots.map(sl => sl.occupant).filter(d => d && d.effective && d.squad.side !== sq.side);
    if (!defenders.length) { sq.order = null; sq.orderGarrison(b); if (sq.side === 'player') g.hud?.alert(`${sq.name}: building cleared`, 'good'); return; }
    const att = sq.effective.filter(s => !s.path || s.pathI >= s.path.length).filter(s => s.pos.distanceTo(o.entrance) < 9);
    if (att.length < Math.min(2, sq.effective.length)) return; // still stacking up
    o.t += dt;
    for (const s of att) s.stackT = 1;
    if (o.t < 2) return;
    // grenades through the door / windows, then entry; each tick resolves a short exchange
    const skill = sq.assault ? 1.6 : 1;
    for (const s of att) {
      if (s.grenades > 0 && Math.random() < 0.45) {
        s.grenades--; s.throwT = 1.2; s.throwWindow = Math.random() < 0.5;
        const d = defenders[Math.floor(Math.random() * defenders.length)];
        const at = b.panelCenter(d.inside.panel, new THREE.Vector3()).addScaledVector(b.outward(d.inside.panel), -1.2); at.y = d.pos.y + 0.4;
        setTimeout(() => this.explode(at, 0.45, s, [60, 150], 5), 1300 / Math.max(1, g.timeScale));
      } else if (Math.random() < 0.22 * skill) {
        const d = defenders[Math.floor(Math.random() * defenders.length)];
        this.hitSoldier(d, s.weapon, s.pos, false, s); g.sfx('rifle_near', s.pos, { gain: 0.8 });
      }
    }
    for (const d of defenders) if (Math.random() < 0.09 * (d.squad.assault ? 1.6 : 1) * (1 - d.suppression / 150)) {
      const t = att[Math.floor(Math.random() * att.length)]; this.hitSoldier(t, d.weapon, d.pos, false, d); g.sfx('rifle_near', d.pos, { gain: 0.7 });
    }
    for (const d of defenders) { d.suppression = Math.min(100, d.suppression + 12); d.squad.underFireT = 0; d.squad.addMorale(-1.2); }
    sq.underFireT = 0;
  }
  // ---------------------------------------------------------------- casualties
  hitSoldier(t, W, fromPos, blast = false, shooter = null) {
    if (!t.alive || t.state === 'dead') return;
    const g = this.g; let dmg, head = false;
    if (blast || W.type === 'blast') { dmg = rf(...(W.dmg || [40, 90])); if (t.stance === 'prone') dmg *= 0.6; if (t.armor?.plateCoverage > 0.5) dmg *= 0.8; }
    else {
      const r = Math.random();
      if (r < 0.06) { head = true; if (Math.random() < (t.armor?.helmetStop ?? TUNING.helmetStopChance) && W.type !== 'hmg' && W.type !== 'autocannon') { dmg = rf(8, 20); head = false; t.suppression = 100; } else dmg = 160; }
      else if (r < 0.55) { // torso
        const A = t.armor || { plateCoverage: TUNING.plateCoverage, plateStop: TUNING.plateStopsRifle }; const stopP = W.type === 'rifle' ? A.plateStop * A.plateCoverage / 0.47 : W.type === 'mg' ? A.plateStop * A.plateCoverage / 0.47 * 0.65 : 0;
        if (Math.random() < Math.min(0.9, stopP)) { dmg = rf(4, 14); t.suppression = Math.min(100, t.suppression + 40); t.hitT = 0.5; }
        else dmg = rf(W.dmg[0], W.dmg[1]) * 1.1;
      } else { dmg = rf(W.dmg[0] * 0.6, W.dmg[1] * 0.8) * (t.armor?.plateCoverage > 0.5 && r < 0.7 ? 0.5 : 1); if (r > 0.78) t.legWound = true; }
      if (W.type === 'hmg' || W.type === 'autocannon') dmg *= 2.5;
    }
    t.hp -= dmg;
    const sq = t.squad;
    if (g.camDist(t.pos) < 120) g.fx.blood(this.targetPoint(t, C));
    if (t.hp <= 0) {
      // survivability: most non-head hits leave a man badly wounded (savable by a medic/evac) rather than dead
      if (head || t.hp < -95 || (blast && Math.random() < 0.25)) { t.die(); g.onDeath(t, shooter, false); }
      else if (t.state !== 'critical' && t.state !== 'stable') {
        t.state = 'critical'; t.bleed = rf(...TUNING.bleedOut); t.target = null; t.path = null;
        if (t.dragging) { t.dragging.dragger = null; t.dragging = null; }
        if (t.slotRef) { t.slotRef.occupant = null; t.slotRef = null; if (t.inBuilding) { t.inside = null; } }
        sq.onCasualty(t, false); g.stats[sq.side].wia++;
        if (g.camDist(t.pos) < 80) g.sfx('pain', t.pos);
        if (shooter) (shooter.squad || shooter).stats.kills += 0.5;
      } else { t.die(); g.onDeath(t, shooter, false); }
    } else if (t.hp < 55 && t.state === 'ok') {
      t.state = 'light'; t.hitT = 0.6; if (g.camDist(t.pos) < 60) g.sfx('pain', t.pos, { gain: 0.7 });
      sq.addMorale(-3);
    } else t.hitT = 0.4;
  }
  // ---------------------------------------------------------------- RPG / projectiles
  fireRpg(s, t, W = s.weapon, disposable = false) {
    const g = this.g, from = s.muzzleWorld(C).clone(), tp = this.targetPoint(t, B).clone();
    if (!disposable) s.inMag--; s.fireCd = 2; s.kick = 2;
    const d = from.distanceTo(tp);
    // accuracy: dispersion grows with range; moving targets harder
    const sp = (W.spread / 1000) * d * (1 + s.suppression / 80) * (t.type === 'vehicle' && Math.abs(t.speed) > 2 ? 2 : 1);
    tp.x += (Math.random() - .5) * sp * 2; tp.y += (Math.random() - .5) * sp; tp.z += (Math.random() - .5) * sp * 2;
    g.fx.muzzle(from, tp.clone().sub(from).normalize(), 1.6);
    // backblast
    const back = from.clone().sub(tp).normalize();
    for (let i = 0; i < 8; i++) g.fx.smoke.spawn({ x: from.x + back.x * i * 0.5, y: from.y, z: from.z + back.z * i * 0.5, vx: back.x * 8, vy: 0.5, vz: back.z * 8, life: 2.5, size0: 0.6, size1: 3, r: 0.75, g: 0.73, b: 0.7, a0: 0.5, a1: 0, drag: 2 });
    // the "pop": ejection flash + sharp grey puff at the muzzle, dust kicked up behind the gunner
    const fwd = tp.clone().sub(from).normalize();
    g.fx.light(from, 0xffc27a, 18, 10, 0.07);
    for (let i = 0; i < 6; i++) g.fx.smoke.spawn({ x: from.x + fwd.x * 0.6, y: from.y, z: from.z + fwd.z * 0.6, vx: fwd.x * 4 + (Math.random() - .5) * 2, vy: (Math.random() - .3) * 1.5, vz: fwd.z * 4 + (Math.random() - .5) * 2, life: 1.6, size0: 0.35, size1: 1.8, r: 0.8, g: 0.79, b: 0.76, a0: 0.55, a1: 0, drag: 3 });
    for (let i = 0; i < 6; i++) g.fx.smoke.spawn({ x: from.x + back.x * (2 + i), y: 0.3, z: from.z + back.z * (2 + i), vx: back.x * 3 + (Math.random() - .5) * 2, vy: 0.6, vz: back.z * 3 + (Math.random() - .5) * 2, life: 3.5, size0: 1, size1: 4.5, r: 0.62, g: 0.57, b: 0.5, a0: 0.4, a1: 0, drag: 1.5, wind: g.fx.wind });
    g.sfx('rpg_launch', s.pos);
    const mesh = this.rocketMesh(); mesh.position.copy(from); mesh.lookAt(tp); g.scene.add(mesh);
    this.projectiles.push({ kind: 'rpg', pos: from.clone(), last: from.clone(), target: tp, t, speed: W.projectile?.speed || 120, owner: s, side: s.squad.side, weapon: W, trail: 0, age: 0, mesh });
    s.squad.firedT = 0;
  }
  // PG-22 / PG-7 rocket: body, ogive, folding fins (oriented +Z for lookAt)
  rocketMesh() {
    if (!this._rocket) {
      const body = new THREE.CylinderGeometry(0.036, 0.036, 0.42, 10); body.rotateX(Math.PI / 2);
      const nose = new THREE.ConeGeometry(0.036, 0.16, 10); nose.rotateX(Math.PI / 2); nose.translate(0, 0, 0.29);
      const tail = new THREE.CylinderGeometry(0.022, 0.03, 0.14, 8); tail.rotateX(Math.PI / 2); tail.translate(0, 0, -0.28);
      const fins = []; for (let i = 0; i < 4; i++) { const f = new THREE.BoxGeometry(0.004, 0.12, 0.09); f.translate(0, 0.07, -0.3); f.rotateZ(i * Math.PI / 2); fins.push(f); }
      const geo = mergeGeometries([body, nose, tail, ...fins].map(g => g.index ? g.toNonIndexed() : g));
      this._rocket = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x4b4d3a, roughness: 0.6, metalness: 0.3 }));
      this._rocket.castShadow = true;
    }
    return this._rocket.clone();
  }
  fireTankGun(v, t, round) {
    const g = this.g, W = WEAPONS.a46; v.firedT = 0;
    const from = v.muzzle ? v.muzzle.getWorldPosition(new THREE.Vector3()) : v.pos.clone().setY(2.3);
    const dir = new THREE.Vector3(); let tp;
    // target in building -> aim at his window panel
    if (t.type !== 'vehicle' && t.inBuilding) tp = t.bld.panelCenter(t.inside.panel, new THREE.Vector3());
    else tp = this.targetPoint(t, B).clone();
    const d = from.distanceTo(tp);
    // first round at a new target is a ranging shot; men are small targets, vehicles are not
    const ranged = v.lastTarget === t ? Math.min(3, (v.rangedShots || 0) + 1) : 0; v.lastTarget = t; v.rangedShots = ranged;
    const base = t.type === 'vehicle' ? (round === 'ap' ? 0.9 : 0.82) * Math.exp(-d / 1400) : (t.inBuilding ? 0.75 : 0.38) * Math.exp(-Math.pow(d / 380, 1.3));
    const acc = base * (0.6 + 0.4 * ranged / 3) * (Math.abs(v.speed) > 1 ? 0.5 : 1) * (v.crew < 3 ? 0.75 : 1) * (v.opticsDamaged ? 0.55 : 1) * (v.gunnerDown ? 0.6 : 1);
    const hit = Math.random() < acc;
    if (!hit) { const m = 2 + d * 0.018; tp.x += (Math.random() - .5) * m * 2; tp.z += (Math.random() - .5) * m * 2; tp.y = Math.max(0.2, tp.y + (Math.random() - .5) * 2); }
    // first obstruction along the line (buildings) stops the round
    const occ = g.nav.occluded(from.x, from.y, from.z, tp.x, tp.y, tp.z, null, t.type !== 'vehicle' && t.inBuilding ? t.bld : null);
    dir.subVectors(tp, from).normalize();
    g.fx.muzzleBlastTank(from, dir);
    g.sfx('tankgun', v.pos); g.cam.addShake(Math.max(0, 0.6 - g.camDist(v.pos) / 250));
    g.fx.tracer(from, tp, 1600, [1, 0.8, 0.5]);
    this.projectiles.push({ kind: round === 'ap' ? 'apfsds' : 'he', pos: from.clone(), target: tp, t, speed: round === 'ap' ? 1650 : 850, owner: v, side: v.side, weapon: W, occ, hit });
  }
  fireVehicleGun(v, w, t, coax = false) {
    const g = this.g, W = WEAPONS[w.key]; v.firedT = 0;
    const from = (coax ? v.coax : v.muzzle) ? (coax ? v.coax : v.muzzle).getWorldPosition(new THREE.Vector3()) : v.pos.clone().setY(2.2);
    const tp = (t.type !== 'vehicle' && t.inBuilding) ? t.bld.panelCenter(t.inside.panel, new THREE.Vector3()) : this.targetPoint(t, B).clone();
    const d = from.distanceTo(tp);
    const near = g.camDist(v.pos) < 300;
    if (near) g.fx.muzzle(from, tp.clone().sub(from).normalize(), W.type === 'autocannon' ? 1.6 : W.type === 'hmg' ? 1.3 : 0.9);
    g.sfx(W.sound === 'cannon30' ? 'cannon30' : W.sound === 'hmg' ? 'hmg' : 'mg_near', v.pos);
    let p = (W.type === 'autocannon' ? 0.3 : W.type === 'hmg' ? 0.2 : 0.14) * Math.exp(-Math.pow(d / 260, 1.35)) * (Math.abs(v.speed) > 1 ? 0.5 : 1) * (v.crew < 3 ? 0.7 : 1) * (v.opticsDamaged ? 0.55 : 1);
    if (t.type !== 'vehicle') { if (t.inBuilding) p *= 0.45; else if (t.inside === 'ride') p *= 0.8; else { p *= 1 - g.nav.coverFrom(t.pos.x, t.pos.z, v.pos.x, v.pos.z) * 0.7; if (t.stance === 'prone') p *= 0.45; else if (t.stance === 'crouch') p *= 0.75; } }
    else p = Math.min(0.9, p * 3);
    const hit = Math.random() < p;
    const end = tp.clone(); if (!hit) { const m = 0.8 + d * 0.02; end.x += (Math.random() - .5) * m * 2; end.z += (Math.random() - .5) * m * 2; end.y = Math.max(0.05, end.y + (Math.random() - .6) * m); }
    w.shots = (w.shots || 0) + 1;
    // BTR weapons trace every round; tank coax every 3rd
    if (g.camDist(v.pos) < 500 && (v.kind === 'btr' || w.shots % 3 === 0)) g.fx.tracer(from, end, 900, TRACER[v.faction.id]);
    if (W.type === 'autocannon') { // HE-frag 30 mm: every round bursts
      this.projectiles.push({ kind: 'he30', pos: from.clone(), target: end, t, speed: 960, owner: v, side: v.side, weapon: W, hit });
      return;
    }
    if (t.type === 'vehicle') { if (hit) { this.hitVehicle(t, W, v.pos, 'ke', v); if (near) g.fx.impact(end, 'metal'); } return; }
    const sup = (W.suppress || 1.5) * 9;
    for (const o of t.squad.soldiers) if (o.effective && o.pos.distanceToSquared(end) < 25) o.suppression = Math.min(100, o.suppression + sup);
    t.squad.underFireT = 0; t.squad.flankDirs.push(Math.atan2(v.pos.x - t.pos.x, v.pos.z - t.pos.z));
    if (t.inBuilding && W.type === 'hmg') this.damageBuilding(t.bld, end, 4);
    if (hit) this.hitSoldier(t, W, v.pos, false, v); else if (near) g.fx.impact(end, t.inBuilding ? 'concrete' : 'dirt', W.type === 'hmg' ? 1.2 : 0.7);
  }
  update(dt) {
    const g = this.g;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const to = p.target, dir = C.subVectors(to, p.pos); const dist = dir.length();
      const step = p.speed * dt;
      if (p.kind === 'rpg') { // visible rocket; motor lights ~10 m out, then a continuous smoke trail follows it
        p.age += dt;
        if (p.mesh) { p.mesh.position.copy(p.pos); p.mesh.lookAt(to); }
        if (p.age > 0.07) {
          if (!p.lit) { p.lit = true; g.fx.light(p.pos, 0xffb060, 10, 8, 0.05); }
          const seg = p.pos.distanceTo(p.last), n = Math.min(40, Math.ceil(seg / 0.4));
          for (let k = 0; k < n; k++) { const f = (k + 1) / n, x = p.last.x + (p.pos.x - p.last.x) * f, y = p.last.y + (p.pos.y - p.last.y) * f, z = p.last.z + (p.pos.z - p.last.z) * f;
            g.fx.smoke.spawn({ x, y, z, vx: (Math.random() - .5) * 0.3, vy: 0.25 + Math.random() * 0.2, vz: (Math.random() - .5) * 0.3, life: 2.6 + Math.random() * 1.4, size0: 0.22, size1: 1.6 + Math.random() * 0.8, r: 0.84, g: 0.83, b: 0.8, a0: 0.55, a1: 0, drag: 1.2, wind: g.fx.wind }); }
          const back = C.clone().normalize().multiplyScalar(-0.45);
          g.fx.glow.spawn({ x: p.pos.x + back.x, y: p.pos.y + back.y, z: p.pos.z + back.z, life: 0.06, size0: 0.7, size1: 0.3, r: 1, g: 0.75, b: 0.35, a0: 3, a1: 0 });
        }
        p.last.copy(p.pos);
      }
      if (p.kind === 'grenade') {
        p.fuse += dt; const tot = p.from.distanceTo(p.target) / p.speed; const f = Math.min(1, p.fuse / tot);
        p.pos.lerpVectors(p.from, p.target, f); p.pos.y = p.from.y + (p.target.y - p.from.y) * f + Math.sin(f * Math.PI) * 4;
        if (p.fuse >= Math.max(tot, 3.2)) { this.projectiles.splice(i, 1); this.explode(p.target.clone().setY(Math.max(0.2, p.target.y)), 0.45, p.owner, [50, 140], 6); }
        continue;
      }
      // obstruction (building facades) for rockets & HE
      if (dist <= step) { this.projectiles.splice(i, 1); if (p.mesh) { g.scene.remove(p.mesh); p.mesh = null; } this.impact(p, to.clone()); continue; }
      p.pos.addScaledVector(dir.normalize(), step);
    }
  }
  impact(p, at) {
    const g = this.g;
    if (p.kind === 'apfsds') {
      if (p.occ && p.occ.ref?.panels) { this.damageBuilding(p.occ.ref, this.facadePoint(p.occ, p.pos, at), 60); g.fx.impact(at, 'concrete', 3); g.sfx('impact_concrete', at); return; }
      if (p.hit && p.t.type === 'vehicle') { this.hitVehicle(p.t, p.weapon, p.owner.pos, 'ke', p.owner); g.fx.impact(at, 'metal', 2); g.sfx('impact_armor', at); g.fx.light(at, 0xffaa55, 30, 12, 0.08); }
      else { g.fx.impact(at, 'dirt', 3); g.sfx('impact_dirt', at); }
      return;
    }
    if (p.kind === 'he' || p.kind === 'rpg' || p.kind === 'he30') {
      // if a building is in the way, burst on the facade
      if (p.occ === undefined) p.occ = g.nav.occluded(p.owner.pos.x, 2, p.owner.pos.z, at.x, at.y, at.z, p.owner.squad?.building || null, p.t && p.t.type !== 'vehicle' && p.t.inBuilding ? p.t.bld : null);
      if (p.occ && p.occ.ref?.panels) at = this.facadePoint(p.occ, p.owner.pos, at);
      if (p.t && p.t.type === 'vehicle' && p.hit !== false && at.distanceTo(p.t.pos) < p.t.def.length * 0.6 && p.kind === 'rpg') {
        this.hitVehicle(p.t, p.weapon, p.owner.pos, 'ce', p.owner, false, at);
        g.fx.explosion(at, 0.7); g.sfx('explosion_small', at); return;
      }
      if (p.t && p.t.type === 'vehicle' && p.kind === 'he30' && p.hit) { this.hitVehicle(p.t, p.weapon, p.owner.pos, 'ke', p.owner); g.fx.impact(at, 'metal', 1); g.fx.light(at, 0xffaa55, 8, 6, 0.05); return; }
      const power = p.kind === 'he' ? 2.0 : p.kind === 'rpg' ? 0.8 : 0.35;
      this.explode(at, power, p.owner, p.kind === 'he' ? [120, 300] : p.kind === 'rpg' ? [60, 160] : [40, 110], p.kind === 'he' ? 9 : p.kind === 'rpg' ? 5 : 3);
    }
  }
  facadePoint(occ, from, to) {
    // intersection of the shot line with the occluder rect (2D) -> world point at the facade
    const o = occ, tx = (x, z) => { const dx = x - o.cx, dz = z - o.cz; return [dx * o.cos - dz * o.sin, dx * o.sin + dz * o.cos]; };
    const [px, pz] = tx(from.x, from.z), [qx, qz] = tx(to.x, to.z); const dx = qx - px, dz = qz - pz;
    let t0 = 0, t1 = 1;
    for (const [pp, d, h] of [[px, dx, o.hx], [pz, dz, o.hz]]) { if (Math.abs(d) < 1e-9) continue; let a = (-h - pp) / d, b = (h - pp) / d; if (a > b) [a, b] = [b, a]; t0 = Math.max(t0, a); t1 = Math.min(t1, b); }
    const t = Math.max(0, t0 - 0.02);
    return new THREE.Vector3(from.x + (to.x - from.x) * t, (from.y ?? 2) + ((to.y ?? 2) - (from.y ?? 2)) * t, from.z + (to.z - from.z) * t);
  }
  // ---------------------------------------------------------------- explosions
  explode(at, power, owner, dmgRange, radius) {
    const g = this.g;
    at.y = Math.max(0.1, at.y);
    const b = g.city.buildingAt(at.x, at.z, 1.2);
    const onGround = at.y < 0.6 && !b;
    g.fx.explosion(at, power, { dust: b ? [0.66, 0.63, 0.58] : [0.55, 0.49, 0.41] });
    g.sfx(power >= 2 ? 'explosion_medium' : power >= 0.7 ? 'explosion_small' : 'explosion_small', at, { gain: power >= 0.5 ? 1 : 0.6 });
    const cd = g.camDist(at); g.cam.addShake(Math.max(0, power * 0.5 - cd / 200)); if (cd < 120) g.renderer.flash(0.04 * power);
    if (onGround) g.city.addCrater(at.x, at.z, 1.2 + power * 1.3);
    if (b) this.damageBuilding(b, at, power * 55);
    // casualties
    for (const sq of g.squads) {
      for (const s of sq.soldiers) {
        if (!s.alive || s.inside === 'btr') continue;
        const d = s.pos.distanceTo(at); if (d > radius * 3) continue;
        s.suppression = Math.min(100, s.suppression + 60 * (1 - d / (radius * 3)) * power);
        sq.underFireT = 0;
        if (d > radius) continue;
        let k = Math.pow(1 - d / radius, 1.4);
        if (s.inBuilding) {
          const pc = s.bld.panelCenter(s.inside.panel, C);
          if (s.bld === b) { const dd = pc.distanceTo(at); if (dd > 4.5) continue; k = Math.pow(1 - dd / 4.5, 1.2) * 0.9; }
          else k *= 0.35; // outside blast vs. a man behind a concrete panel
        } else {
          // shielded by a wall between blast and soldier?
          const shield = !this.los(at.x, at.y + 0.5, at.z, s.pos.x, 1, s.pos.z, null, null);
          if (shield) continue;
        }
        if (s.stance === 'prone') k *= 0.55;
        if (Math.random() < 0.15 + k) this.hitSoldier(s, { dmg: [dmgRange[0] * k, dmgRange[1] * k], type: 'blast' }, at, true, owner);
      }
      if (sq.side) sq.addMorale(-1.5 * power * (sq.center().distanceTo(at) < radius * 3 ? 1 : 0));
    }
    for (const v of g.vehicles) {
      if (v.destroyed) continue; const d = v.pos.distanceTo(at); if (d > radius) continue;
      if (power >= 1.5 && Math.random() < 0.3) this.hitVehicle(v, { pen: 40, dmg: [60, 120] }, at, 'ce', owner, true);
      else v.hp -= 20 * power * (1 - d / radius);
    }
  }
  damageBuilding(b, at, power) {
    const g = this.g;
    const changed = b.damageAt(at.x, at.y, at.z, power);
    if (!changed.length) { if (g.camDist(at) < 150) g.fx.impact(at, 'concrete', 1.5); return; }
    let collapsed = 0;
    for (const p of changed) {
      const c = b.panelCenter(p, new THREE.Vector3()), o = b.outward(p);
      if (p.state >= 2) { g.fx.dustCloud(c, 3, 2, 8); if (g.camDist(c) < 160 && Math.random() < 0.5) g.sfx('glass_break', c); }
      if (p.state === 3 || p.gone) {
        collapsed++;
        const rs = 0.55 + Math.random() * 0.35, ro = (g.city.rubbleTemplates()[0]?.userData.r || 3) * rs * 0.45; const r = g.city.spawnRubble(c.x + o.x * ro, c.z + o.z * ro, rs);
        g.fx.dustCloud(c.clone().setY(Math.max(1, c.y - 2)), 6, c.y, 18);
        // occupants of that panel fall / are hurt
        for (const sl of b.slots) if (sl.panel === p && sl.occupant) this.hitSoldier(sl.occupant, { dmg: [50, 140], type: 'blast' }, c, true);
        if (Math.random() < 0.3 && p.floor > 1) g.fx.emitter(c.clone(), 'smoulder', 1, 90, { b, p });
      }
    }
    if (collapsed >= 2) { g.sfx('collapse', at); g.cam.addShake(Math.max(0, 0.5 - g.camDist(at) / 300)); } else if (collapsed) g.sfx('debris', at);
    for (const si of b.checkCollapse()) g.city.collapseSection(b, si, g);
    // garrison morale
    for (const sq of g.squads) if (sq.building === b) { sq.addMorale(-4 * Math.min(3, changed.length)); sq.underFireT = 0; }
  }
  // ---------------------------------------------------------------- armour
  // Hit-location armour model (armor.js): which plate was struck, at what obliquity, ERA, penetration vs
  // effective thickness, then what lies behind the armour along the round's path.
  hitVehicle(v, W, fromPos, kind, owner, top = false, at = null) {
    if (v.destroyed) return;
    const g = this.g;
    if (!v.zones) initArmor(v);
    const k = W.type === 'tankgun' && kind === 'ke' ? 'ke' : kind;
    const from = top ? new THREE.Vector3(v.pos.x + (Math.random() - .5) * 2, 30, v.pos.z + (Math.random() - .5) * 2) : fromPos;
    const r = resolveHit(v, W, from, k, at, from.distanceTo ? from.distanceTo(v.pos) : 0);
    if (r.miss) return;
    const note = (msg, bad = true) => { if (v.side === 'player') g.hud?.alert(`${v.name}: ${msg}`, bad ? 'bad' : ''); };
    const where = `${r.zone.replace('_', ' ')}${r.face && r.face !== 'side' && !/tracks|wheels/.test(r.zone) ? ' ' + r.face : r.face === 'side' ? ' side' : ''}`;
    if (r.ricochet) { if ((W.pen || 0) > 100) { v.hp -= 4; if (Math.random() < 0.5) note(`round glanced off the ${where}`, false); } return; }
    const fx = new Set(r.effects);
    // running gear
    if (fx.has('track')) { v.immob.track = true; note('track broken — immobilised'); }
    if (fx.has('wheel')) { v.wheelsLost++; if (v.wheelsLost >= 4) { v.immob.wheels = true; note('wheels shot out — immobilised'); } else if (Math.random() < 0.4) note(`wheel hit (${v.wheelsLost}/8)`); }
    if (r.stopped) {
      if ((W.pen || 0) > 20) v.hp -= (W.pen > 200 ? 10 : 3);
      if (fx.has('optics')) { v.opticsDamaged = true; note('sights damaged'); }
      if (fx.has('stun')) v.stunT = 3;
      if ((W.pen || 0) > 100 && Math.random() < 0.5) note(`hit ${where} — no penetration (${r.armor} mm${r.era ? ', ERA' : ''} vs ${r.pen} mm)`, false);
      this.updateImmobile(v); return;
    }
    if (!r.penetrated) { this.updateImmobile(v); return; }
    v.hp -= rf(...(W.dmg || [100, 200])) * (0.45 + 0.55 * r.residual / (r.residual + r.armor + 1));
    const msgs = [];
    const crewHit = role => { const c = v.crewList.find(m => m.role === role && m.hp > 0); if (!c) return; c.hp -= (k === 'ke' ? 60 : 75) + Math.random() * 70; if (c.hp <= 0) { msgs.push(`${role} killed`); if (role === 'driver') { v.immob.driver = true; v.driverSwapT = 18; } } else msgs.push(`${role} wounded`); };
    for (const e of fx) {
      const part = v.parts.find(p => p.name === e); if (!part) continue;
      if (part.crew) crewHit(part.crew);
      if (part.ammo && Math.random() < part.ammo * (k === 'ke' ? 1 : 0.8)) { msgs.push('ammunition detonated'); v.crewList.forEach(c => c.hp = 0); v.crew = 0; v.knockOut(true); break; }
      if (part.fuel && Math.random() < part.fuel && !v.burning) { v.burning = 0.01; msgs.push('on fire'); }
      if (part.engine) { v.immob.engine = true; msgs.push('engine knocked out'); }
      if (part.gun) { v.gunDisabled = true; msgs.push('gun destroyed'); }
      if (part.optics) { v.opticsDamaged = true; msgs.push('sights damaged'); }
      if (part.ring) { v.turretJam = true; msgs.push('turret jammed'); }
      if (part.troops && v.passengers) { g.passengerCasualties(v, k === 'ce' ? 0.35 : 0.22, owner); msgs.push('troop compartment hit'); }
    }
    if (!v.destroyed) {
      v.crew = v.crewList.filter(c => c.hp > 0).length;
      if (v.crew <= 0) { msgs.push('crew killed'); v.knockOut(false); }
      else if (v.hp <= 0) v.knockOut(v.kind === 'tank' && Math.random() < 0.35);
    }
    this.updateImmobile(v);
    if (v.destroyed && owner?.squad) owner.squad.stats.kills += 1; else if (v.destroyed && owner?.stats) owner.stats.kills += 1;
    if (v.side === 'player' && !v.destroyed) note(`penetrated ${where}${msgs.length ? ' — ' + msgs.join(', ') : ''}!`);
    if (v.side !== 'player' && v.destroyed) g.hud?.alert(`Enemy ${v.name} destroyed (${where})`, 'good');
  }
  updateImmobile(v) { v.immob ||= {}; v.immobile = Object.values(v.immob).some(Boolean); }
  // ---------------------------------------------------------------- vehicle targeting
  vehicleTargets(v) {
    const g = this.g, eye = A.set(v.pos.x, 2.4, v.pos.z).clone();
    const mainW = WEAPONS[v.weapons[0].key];
    let best = null, bs = -1e9, bestInf = null, bi = 1e9;
    for (const u of g.enemiesOf(v.side)) {
      if (!g.seen(v.side, u, v.pos)) continue;
      if (u.type === 'vehicle') {
        if (u.destroyed) continue; const d = u.pos.distanceTo(v.pos); if (d > mainW.range) continue;
        if (!this.los(eye.x, eye.y, eye.z, u.pos.x, 1.5, u.pos.z, v, u)) continue;
        const sc = (u.kind === 'tank' ? 300 : 200) - d * 0.3 + (v.focus === u ? 200 : 0);
        if (v.kind === 'btr' && u.kind === 'tank') continue; // BTRs don't duel tanks
        if (sc > bs) { bs = sc; best = u; }
        continue;
      }
      // infantry: pick a soldier (riders on armour are prime targets) (prefer clusters / garrisons for HE)
      for (const s of u.soldiers) {
        if (!s.effective || s.inside === 'btr') continue;
        // a vehicle only engages infantry it could plausibly make out itself (or that is shooting at it)
        const d = s.pos.distanceTo(v.pos); if (d > ((u.firedT ?? 99) < 3 ? 420 : v.side === 'enemy' ? 200 : 260)) continue;
        const tp = this.targetPoint(s, B);
        if (!this.los(eye.x, eye.y, eye.z, tp.x, tp.y, tp.z, v, this.bldOf(s) || s)) continue;
        if (d < bi) { bi = d; bestInf = s; }
        const sc = 120 - d * 0.25 + (s.inBuilding ? 40 : 0) + (s.inside === 'ride' ? 50 : 0) + (v.focus === u ? 200 : 0) + (s.weaponKey === 'rpg7' ? 60 : 0);
        if (v.kind === 'tank' && v.weapons[0].he <= 0 && !s.inBuilding) continue;
        if (sc > bs) { bs = sc; best = s; }
        break; // one LOS-checked soldier per squad is enough
      }
    }
    v.target = best; v.coaxTarget = bestInf && bi < 500 ? bestInf : null;
    if (v.target && v.target.type !== 'vehicle' && v.kind === 'tank' && v.target.squad && !v.target.inBuilding && v.weapons[0].he < 6) v.target = null; // save HE for buildings
  }
}
