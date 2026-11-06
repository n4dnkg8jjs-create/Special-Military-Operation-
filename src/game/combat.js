import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three';
import { trenchBlast } from './trench.js';
import { WEAPONS, TUNING } from '../config.js';
import { angDiff } from './squad.js';
import { initArmor, resolveHit } from './armor.js';
import { trunkHit } from '../world/vegetation.js';
import { clipDuration, clipEvents, hasClip } from './soldier.js';

const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), C2 = new THREE.Vector3();
const LA = new THREE.Vector3(), LB = new THREE.Vector3(), WC = new THREE.Vector3();
const WIN_OUT = 0.3, WIN_COS = 0.17;   // window point past the facade (m); widest angle out of a window: ~80 deg off its normal
const rf = (a, b) => a + Math.random() * (b - a);
const TRACER = { RU: [0.62, 1.0, 0.34], UA: [1.0, 0.42, 0.14] }; // green-yellow / orange-red burning tracer compound

export class Combat {
  constructor(game) { this.g = game; this.projectiles = []; }

  // ---------------------------------------------------------------- line of sight
  los(ax, ay, az, bx, by, bz, ignoreA, ignoreB, noFoliage = false) {
    const o = this.g.nav.occluded(ax, ay, az, bx, by, bz, ignoreA, ignoreB, noFoliage);
    return !o;
  }
  // a shooter hidden in foliage gives himself away when he fires: his muzzle flash / report lets the other side put
  // rounds into the bush he's in (rough fix, poor accuracy) even though they can't actually see him
  roughFix(t) { const u = t.squad || t; return (u.firedT ?? 99) < 4 || (this.g.time - (t.lastShotT ?? -99)) < 4; }
  // a garrisoned man sees, shoots and is seen through his own window only: his eye / body point is just outside the window
  // opening (WIN_OUT m past the facade, so the building's own volume no longer has to be ignored - it used to be, and with it
  // men at a front window shot through the whole block at targets behind it, and men behind a building shot through it at a
  // garrison on the far facade), and the other end of the line has to be in front of that window (facesWindow)
  soldierEye(s, out = A) {
    if (s.inBuilding) return this.windowPoint(s, out, s.headHeight());
    const pv = s.peek ? s.peekVec : null; return out.set(s.pos.x + (pv ? pv[0] : 0), s.pos.y + s.headHeight(), s.pos.z + (pv ? pv[1] : 0));
  }
  targetPoint(t, out = B) {
    if (t.type === 'vehicle') return out.set(t.pos.x, 1.5, t.pos.z);
    if (t.inBuilding) return this.windowPoint(t, out, t.headHeight() * 0.75);
    const k = t.peek ? (t.peekAmt || 0) : 0, pv = t.peekVec;
    return out.set(t.pos.x + (k ? pv[0] * k * 0.9 : 0), t.pos.y + t.headHeight() * 0.75, t.pos.z + (k ? pv[1] * k * 0.9 : 0));   // leaning out: his head and shoulders are where his eye is
  }
  windowPoint(s, out, h) { const b = s.bld, p = s.inside.panel; b.panelCenter(p, out); const o = b.outward(p); out.x += o.x * WIN_OUT; out.z += o.z * WIN_OUT; out.y = s.pos.y + h; return out; }
  facesWindow(s, x, z) { const b = s.bld, p = s.inside.panel, c = b.panelCenter(p, WC), o = b.outward(p), dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz); return d > 0.01 && (dx * o.x + dz * o.z) / d > WIN_COS; }
  // line of sight from an eye point to target t (soldier or vehicle): garrisoned targets only through their window
  losFrom(ex, ey, ez, t, ignA = null, noFoliage = false) {
    const tp = this.targetPoint(t, LB);
    if (t.type !== 'vehicle' && t.inBuilding && !this.facesWindow(t, ex, ez)) return false;
    return this.los(ex, ey, ez, tp.x, tp.y, tp.z, ignA, t.type === 'vehicle' ? t : null, noFoliage);
  }
  // can soldier s see target t right now (from where his head really is: leaning out of a corner, at his window)?
  canSee(s, t, noFoliage = false) {
    const e = this.soldierEye(s, LA);
    if (s.inBuilding) { const tp = t.type === 'vehicle' ? t.pos : this.targetPoint(t, LB); if (!this.facesWindow(s, tp.x, tp.z)) return false; }
    return this.losFrom(e.x, e.y, e.z, t, null, noFoliage);
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
    // a lean (0.8 m: root shift + the peek clip's lean put the head about there) or, failing that, a lean with half a step out
    for (let i = 0; i < Math.min(5, cands.length); i++) {
      const t = cands[i][0]; if (t.type === 'vehicle') continue;
      const tp = this.targetPoint(t, B), h = Math.atan2(tp.x - s.pos.x, tp.z - s.pos.z), rx = -Math.cos(h), rz = Math.sin(h);
      for (const [side, r] of [[1, 0.8], [-1, 0.8], [1, 1.2], [-1, 1.2]]) {
        const ox = rx * side * r, oz = rz * side * r, k = nav.idx(s.pos.x + ox, s.pos.z + oz);
        if (k < 0 || nav.cost[k] === 255 || (r > 1 && !nav.lineFree(s.pos.x, s.pos.z, s.pos.x + ox, s.pos.z + oz, 0.3))) continue;
        const ey = s.pos.y + s.headHeight();
        if (this.losFrom(s.pos.x + ox, ey, s.pos.z + oz, t)) { s.target = t; s.peek = side; s.peekVec = [ox, oz]; s.heading = h; return true; }
      }
    }
    return false;
  }
  bldOf(s) { return s && s.inBuilding ? s.bld : null; }

  // ---------------------------------------------------------------- infantry
  soldierCombat(s, dt) {
    const sq = s.squad;
    if (s.cellar || s.cellarMove || s.cqb) { s.target = null; return; }   // down in the cellar / on the stairs / clearing rooms (cqb.js shoots)
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
    let t = s.target;
    s.groundAim = false;
    if (t && s.fireGuard && s.fireGuard(t)) { s.target = t = null; }   // v6: a mark too near own men (trench clearing: the fire group)
    if (!t) { if ((sq.fireAt || s.fireAt) && !sq.holdFire) this.fireAtGround(s, dt); return; }
    if (s.noRifle || s.supportClip) return;                          // busy on the launcher / drone controls
    if (sq.holdFire && !(sq.order?.type === 'attack')) return;
    if (s.ducking && s.inside !== 'ride') return;                     // head down behind cover
    if (s.peek && s.peekAmt < 0.85) return;                          // still leaning out from the corner
    if (s.rpg22 > 0 && t.type === 'vehicle' && s.inside !== 'ride' && Math.hypot(t.pos.x - s.pos.x, t.pos.z - s.pos.z) < WEAPONS.rpg22.range && s.vel.lengthSq() < 0.5 && this.canSee(s, t)) {
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
    // every shot needs a clear line from where his head really is (leaning out / at his window) to the target: the target is only
    // re-validated by acquire() every ~1 s, and meanwhile he (or the target) may have moved behind a wall
    if (!this.shotClear(s, t)) { s.target = null; s.burstLeft = 0; s.scanT = Math.min(s.scanT, 0.15); return; }
    const W = s.weapon;
    if (s.inMag <= 0) { this.startReload(s); return; }
    if (W.type === 'at') { this.fireRpg(s, t); return; }
    if (s.burstLeft <= 0) s.burstLeft = Math.round(rf(W.burst[0], W.burst[1] + 0.49));
    s.burstLeft--; s.inMag--;
    s.fireCd = s.burstLeft > 0 ? 60 / W.rof : rf(W.burstGap[0], W.burstGap[1]) * (1 + s.suppression / 60);
    this.fireSmallArms(s, t, W);
  }
  shotClear(s, t) { return this.canSee(s, t) || (s.tgtFoliage && (this.canSee(s, t, 'veg') || (this.roughFix(t) && this.canSee(s, t, true)))); }   // (a few segment tests per round: cheap)
  // ---- fire at ground (suppressive / recon-by-fire on a point the player clicked, without a spotted target)
  groundPoint(u, s) {
    if (s?.fireAt) { if (this.g.time > s.fireAt.until) s.fireAt = null; else return s.fireAt.p; }   // v6: his own mark (trench clearing)
    const fa = u.fireAt; if (!fa) return null;
    if (this.g.time > fa.until) { u.fireAt = null; return null; }
    const k = s ? s.idx * 2.399 : 0, r = s ? 2.5 + (s.idx % 3) * 1.4 : 0;            // each man takes his own bit of the area
    return (s ? (s._gp ||= new THREE.Vector3()) : (u._gp ||= new THREE.Vector3())).set(fa.p.x + Math.cos(k) * r, 0.4, fa.p.z + Math.sin(k) * r);
  }
  fireAtGround(s, dt) {
    const sq = s.squad, W = s.weapon;
    if (s.noRifle || s.supportClip || s.ducking || s.inside === 'btr' || W.type === 'at' || s.reloadT > 0) return;
    const p = this.groundPoint(sq, s); if (!p) return;
    const d = Math.hypot(p.x - s.pos.x, p.z - s.pos.z); if (d > W.range * 1.3 || d < 4) return;
    if (s.inBuilding && !this.facesWindow(s, p.x, p.z)) return;     // the area is behind his facade
    s.groundAim = true; s.aimPoint = p;
    if (s.vel.lengthSq() > 0.5) return;
    if (Math.abs(angDiff(Math.atan2(p.x - s.pos.x, p.z - s.pos.z), s.heading)) > 0.3) return;
    s.fireCd -= dt; if (s.fireCd > 0) return;
    if (s.inMag <= 0) { this.startReload(s); return; }
    if (s.burstLeft <= 0) s.burstLeft = Math.round(rf(W.burst[0], W.burst[1] + 0.49));
    s.burstLeft--; s.inMag--;
    s.fireCd = s.burstLeft > 0 ? 60 / W.rof : rf(W.burstGap[0], W.burstGap[1]) * 1.3;
    this.groundRound(s, s.inBuilding ? this.windowPoint(s, new THREE.Vector3(), s.headHeight() - 0.1) : s.muzzleWorld(C).clone(), p, W, s.squad.side, s);
    s.kick = 1; s.squad.firedT = 0; s.firingT = W.type === 'mg' ? 0.5 : 0.35; s.lastShotT = this.g.time;
    this.g.sfx(W.sound === 'mg' ? 'mg_near' : 'rifle_near', s.pos);
  }
  // one round into an area: tracer, impact, suppression of anyone near, a small chance to hit someone hidden there
  groundRound(owner, from, p, W, side, shooter) {
    const g = this.g, d = from.distanceTo(p), m = 0.8 + d * 0.025;
    const end = p.clone(); end.x += (Math.random() - .5) * m * 2; end.z += (Math.random() - .5) * m * 2; end.y = Math.max(0.05, end.y + (Math.random() - .5) * 0.8);
    const occ = g.nav.occluded(from.x, from.y, from.z, end.x, end.y, end.z, owner.inBuilding ? null : owner.squad?.building || null, null);
    if (occ && occ.ref?.panels) end.copy(this.facadePoint(occ, from, end));
    if (g.camDist(from) < 260) g.fx.muzzle(from, end.clone().sub(from).normalize(), W.type === 'mg' || W.type === 'hmg' ? 1.1 : 0.8);
    owner.shots = (owner.shots || 0) + 1;
    if (owner.shots % (W.tracerEvery || 4) === 0 && g.camDist(from) < 450) g.fx.tracer(from, end, 800, TRACER[(shooter || owner).faction.id]);
    if (g.camDist(end) < 200) g.fx.impact(end, occ ? 'concrete' : 'dirt', W.type === 'hmg' ? 1.2 : 0.6);
    if (occ?.ref?.panels && W.type === 'hmg') this.damageBuilding(occ.ref, end, 3);
    for (const sq of g.squads) {
      if (sq.side === side || sq.destroyed || sq.mounted) continue;
      for (const o of sq.effective) {
        const dd = o.pos.distanceTo(end); if (dd > 6) continue;
        o.suppression = Math.min(100, o.suppression + (W.suppress || 1) * 7 * (1 - dd / 7)); sq.underFireT = 0; o.nearMissT = g.time;
        if (dd < 1.6 && Math.random() < (o.inBuilding ? (this.windowExposed(o) ? 0.05 : 0.004) : o.stance === 'prone' ? 0.02 : 0.05)) this.hitSoldier(o, W, from, false, shooter || owner);
      }
    }
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
      for (const e of u.soldiers) if (e.effective && e.inside !== 'btr' && !e.cellar) consider(e, focus + (e.inBuilding ? -10 : 0) + (e.weaponKey === 'pkm' ? 25 : 0) + (e.weaponKey === 'rpg7' || e.rpg22 > 0 ? 18 : 0) + (e.role?.leader ? 10 : 0) + (e.vel.lengthSq() > 1 ? 12 : 0) - (this.g.nav.coverFrom(e.pos.x, e.pos.z, s.pos.x, s.pos.z) * 15));
    }
    // an RPG gunner on his AK goes back to the launcher as soon as there is armour in its reach and a rocket left
    if (s.origWeapon?.key === 'rpg7' && (s.origWeapon.mags > 0 || s.origWeapon.inMag > 0) && cands.some(c => c[0].type === 'vehicle' && !c[0].destroyed && Math.hypot(c[0].pos.x - s.pos.x, c[0].pos.z - s.pos.z) < WEAPONS.rpg7.range)) { this.swapBack(s); return this.acquire(s); }
    if (s.weaponKey === 'rpg7') { // RPG gunner: only vehicles or garrisoned clusters
      for (let i = cands.length - 1; i >= 0; i--) { const t = cands[i][0]; if (t.type !== 'vehicle' && !(t.inBuilding && cands[i][1] < 120 && Math.random() < 0.25)) cands.splice(i, 1); }
      if (!cands.length && s.sideKey && s.sideMags > 0) { this.swapToSide(s); return this.acquire(s); }
    }
    cands.sort((a, b) => a[1] - b[1]);
    const ignA = null;
    // keep current target if still valid
    if (s.target && cands.some(c => c[0] === s.target)) {
      if (this.canSee(s, s.target)) { s.tgtFoliage = false; return; }
      if (this.roughFix(s.target) && this.canSee(s, s.target, true)) { s.tgtFoliage = true; return; }
      if (s.target.type !== 'vehicle' && this.canSee(s, s.target, 'veg')) { s.tgtFoliage = true; return; }   // still known to be in that bush: keep firing into it
    }
    s.target = null; s.tgtFoliage = false;
    const peeked = s.peek; s.peek = 0;
    // a man at a window only looks out of it: targets behind his facade are not candidates (canSee checks it too)
    for (let i = 0, n = 0; i < cands.length && n < 6; i++) {
      const t = cands[i][0]; if (s.inBuilding && !this.facesWindow(s, t.pos.x, t.pos.z)) continue; n++;
      if (this.canSee(s, t)) { s.target = t; break; }
    }
    // nobody in plain view: return fire into the foliage a shooter just revealed himself in
    if (!s.target) for (let i = 0; i < Math.min(5, cands.length); i++) {
      const t = cands[i][0]; if (t.type === 'vehicle' || !this.roughFix(t)) continue;
      if (this.canSee(s, t, true)) { s.target = t; s.tgtFoliage = true; break; }
    }
    // a spotted man behind a bush / under a crown: the leaves hide him but don't stop rounds - fire into the foliage
    if (!s.target) for (let i = 0; i < Math.min(5, cands.length); i++) {
      const t = cands[i][0]; if (t.type === 'vehicle' || (s.inBuilding && !this.facesWindow(s, t.pos.x, t.pos.z))) continue;
      if (this.canSee(s, t, 'veg')) { s.target = t; s.tgtFoliage = true; break; }
    }
    if (!s.target && this.tryPeek(s, cands, ignA)) { if (!peeked) s.peekT = 0; }
    else if (s.target && s.target.type !== 'vehicle') this.wallLean(s);
    if (!s.target && s.sideKey && s.weaponKey !== 'rpg7' && s.origWeapon) this.swapBack(s);
  }
  // (the model in his hands changes with it: soldier.showHeld - an RPG gunner firing rifle rounds out of the launcher was this)
  swapToSide(s) { if (s.origWeapon) return; s.origWeapon = { key: s.weaponKey, mags: s.mags, inMag: s.inMag }; s.weaponKey = s.sideKey; s.weapon = WEAPONS[s.sideKey]; s.mags = s.sideMags; s.inMag = 0; s.reloadT = 1.5; s.target = null; s.showHeld?.(); }
  swapBack(s) { const o = s.origWeapon; s.sideMags = s.mags + (s.inMag > 0 ? 1 : 0); s.weaponKey = o.key; s.weapon = WEAPONS[o.key]; s.mags = o.mags; s.inMag = o.inMag; s.origWeapon = null; s.target = null; s.reloadT = Math.max(s.reloadT || 0, 1.2); s.showHeld?.(); }
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
    // inside a building the walls stop small-arms fire: only a man showing himself at the window (shooting in the last ~1.5 s)
    // is really hittable; otherwise only the odd round through the opening finds him
    if (t.inBuilding) p *= this.windowExposed(t) ? 0.3 : 0.02;
    else if (t.inside === 'ride') p *= 0.9;   // sat up on the deck: no cover to speak of (the price of riding on top)
    else {
      // two men in the same trench (a clearing fight) see each other along the straight stretches: the walls are no
      // cover then (the bends already block line of sight through the terrain test)
      const nv = this.g.nav, both = nv.trenchDepth && nv.trenchDepth(t.pos.x, t.pos.z) > 0.9 && nv.trenchDepth(s.pos.x, s.pos.z) > 0.9 && t.pos.distanceTo(s.pos) < 40;
      const cov = both ? 0 : nv.coverFrom(t.pos.x, t.pos.z, s.pos.x, s.pos.z);
      p *= 1 - cov * (t.stance === 'stand' ? 0.45 : 0.72);
      if (t.stance === 'prone') p *= 0.5; else if (t.stance === 'crouch') p *= 0.75;
      if (t.vel.lengthSq() > 4) p *= 0.65;
    }
    if (t.state === 'critical' || t.state === 'stable') p *= 0.6;
    if (s.tgtFoliage) p *= 0.3;   // firing blind into the leaves at a muzzle flash
    const sd = s.squad?.side; if (sd) p *= (1 + (s.squad.vet || 0) * 0.1) * (1 + (this.g.mods?.[sd]?.accuracy || 0));   // veterancy, training / optics upgrades
    return THREE.MathUtils.clamp(p, 0.004, 0.75);
  }
  windowExposed(t) { return (this.g.time - (t.lastShotT ?? -99)) < 1.5 || t.throwT > 0 || t.launcherT > 0 || (t.stance === 'stand' && !t.ducking && !!t.inside?.panel?.open); }   // v7: standing in an open window (seen) is exposed too; below the sill he is not
  fireSmallArms(s, t, W) {
    const g = this.g, from = s.muzzleWorld(C).clone(), tp = this.targetPoint(t, B).clone();
    const d = from.distanceTo(tp);
    s.kick = 1; s.squad.firedT = 0; s.firingT = W.type === 'mg' ? 0.5 : 0.35; s.lastShotT = g.time;
    const near = g.camDist(s.pos) < 220;
    if (near) g.fx.muzzle(from, tp.clone().sub(from).normalize(), W.type === 'mg' ? 1.1 : 0.8);
    g.sfx(W.sound === 'mg' ? 'mg_near' : 'rifle_near', s.pos);
    let hit = Math.random() < this.hitChance(s, t, W, d);
    let end = tp.clone();
    if (!hit) { const miss = 0.6 + d * 0.022; end.x += (Math.random() - .5) * miss * 2; end.y = Math.max(0.05, end.y + (Math.random() - .6) * miss); end.z += (Math.random() - .5) * miss * 2; end.addScaledVector(end.clone().sub(from).normalize(), Math.random() * 6); }
    // a tree trunk on the round's path stops it (leaves / bushes / crops don't: they only hide men)
    const th = trunkHit(from.x, from.y, from.z, end.x, end.y, end.z); let trunk = false;
    if (th) { trunk = true; this.trunkStops = (this.trunkStops || 0) + 1; if (hit) this.trunkSaves = (this.trunkSaves || 0) + 1; hit = false; end.set(th.x, th.y, th.z); }
    s.shots = (s.shots || 0) + 1;
    // tracers: Russian green, Ukrainian red, about every 3rd–4th round
    s.nextTracer ??= 3 + Math.floor(Math.random() * 2);
    if (--s.nextTracer <= 0) { s.nextTracer = 3 + Math.floor(Math.random() * 2); if (g.camDist(s.pos) < 450) g.fx.tracer(from, end, 800, TRACER[s.faction.id]); }
    if (t.type === 'vehicle') {
      if (hit) { if (near) g.fx.impact(end, 'metal'); this.hitVehicle(t, W, s.pos, 'ke', s); if (Math.random() < 0.2) g.sfx('ricochet', end); }
      else if (trunk && near) g.fx.impact(end, 'dirt', 0.5);
      return;
    }
    // suppression on the target and his neighbours
    const sup = (W.suppress || 1) * (hit ? 10 : 7);
    for (const o of t.squad.soldiers) if (o.effective && o.pos.distanceToSquared(end) < 16) o.suppression = Math.min(100, o.suppression + sup * (o === t ? 1.4 : 0.6));
    t.squad.underFireT = 0; t.squad.flankDirs.push(Math.atan2(s.pos.x - t.pos.x, s.pos.z - t.pos.z));
    if (hit) this.hitSoldier(t, W, s.pos, false, s);
    else {
      const inB = t.inBuilding && !trunk ? t.bld : null;
      if (near) g.fx.impact(end, inB ? 'concrete' : 'dirt', trunk ? 0.45 : 0.6);
      if (g.camDist(end) < 30 && Math.random() < 0.25) g.sfx(Math.random() < 0.5 ? 'bullet_whizz' : (inB ? 'impact_concrete' : 'impact_dirt'), end, { gain: 0.6 });
    }
  }
  throwGrenade(s, t) {
    s.grenades = (s.grenades ?? 2) - 1;
    const to = t.inBuilding ? t.bld.panelCenter(t.inside.panel, new THREE.Vector3()) : t.pos.clone();
    to.x += (Math.random() - .5) * 4; to.z += (Math.random() - .5) * 4;
    if (this.g.camDist(s.pos) < 60) this.g.sfx('grenade_pin', s.pos);
    return this.startThrow(s, to, { speed: 14, style: t.inBuilding && (t.inside?.panel?.floor || 0) > 0 ? 'window' : null });
  }
  // v7 every hand grenade (open ground, windows, CQB rooms, trench bays, dugouts, cellars): the thrower plays a real throw clip -
  // overhand (throw_grenade_over), up into a window (throw_grenade_window) or, crouched behind cover / at a door / bend, an
  // underhand lob (throw_grenade_low) - with the grenade in his right hand from the pin pull; it leaves the hand at the clip's
  // release frame (events.release) from where the hand is. The fuse runs from the throw as before (bang max(flight, 3.2 s) after
  // he starts: the drills' timings are unchanged). Shot / hit before the release, he drops it at his feet.
  // extra: projectile fields (cellar, dugout, ...); opts.style: 'window' | 'low' | 'over' (default: low when crouched / in a
  // trench / clearing, else over)
  startThrow(s, to, opts = {}) {
    const low = Math.hypot(to.x - s.pos.x, to.z - s.pos.z) < 13 && (s.stance === 'crouch' || s.cqb || s.squad?.order?.type === 'clear' || s.squad?.order?.type === 'storm');   // a short toss from cover; longer: overhand
    const want = opts.style === 'window' ? 'throw_grenade_window' : opts.style === 'low' || (!opts.style && low) ? 'throw_grenade_low' : 'throw_grenade_over';
    const clip = hasClip(want) ? want : hasClip('throw_grenade_over') ? 'throw_grenade_over' : 'throw_grenade';
    const ev = clipEvents(clip), rel = Math.max(0.2, ev.release ?? ev.release_approx ?? 0.8);
    s.throwClip = clip; s.throwWindow = clip === 'throw_grenade_window';
    s.throwT = Math.min(clipDuration(clip, 1.5), rel + 0.8); s.fireCd = Math.max(s.fireCd || 0, s.throwT + 0.3);
    s.aimStopT = Math.max(s.aimStopT || 0, s.throwT);          // he stops to throw (squad.moveStep holds him)
    s.throwYaw = Math.atan2(to.x - s.pos.x, to.z - s.pos.z);   // faces the throw (squad.updateSoldier)
    const hand = s.pos.clone(); hand.y += 1.5;
    const p = { kind: 'grenade', pos: hand.clone(), from: hand, target: to, t: null, speed: opts.speed || 12, owner: s, side: s.squad.side, fuse: 0, arc: true, delay: rel, ...(opts.extra || {}) };
    this.projectiles.push(p);
    return p;
  }
  // the grenade in the thrower's hand until the release; then it flies (a visible grenade, spinning, near the camera)
  grenadeHeld(p, dt) {
    const s = p.owner, g = this.g;
    p.delay -= dt;
    const ok = s && s.effective && s.throwT > 0 && s.state !== 'dead';
    if (!ok) {   // shot / knocked down with the pin out: it falls where he is
      p.delay = 0; p.dropped = true; const y = g.city.groundHeight && !s?.inBuilding && !s?.cqb ? g.city.groundHeight(s.pos.x, s.pos.z) : (s?.pos.y ?? 0);
      p.from = (s?.pos || p.pos).clone().setY(y + 0.4); p.target = p.from.clone().setY(y + 0.1); p.speed = 4;
      p.target.x += (Math.random() - .5) * 0.8; p.target.z += (Math.random() - .5) * 0.8; p.pos.copy(p.from); return;
    }
    if (s.sockets?.R) { s.root.updateMatrixWorld(true); s.sockets.R.getWorldPosition(p.pos); } else p.pos.copy(s.pos).setY(s.pos.y + 1.5);
    if (p.delay > 0) return;
    p.from = p.pos.clone();   // released: the flight starts at the hand
    p.relT = g.time;
    if (!g.noRender && g.camDist(s.pos) < 90) {
      const A = g.assets?.gltf, tpl = (Math.random() < 0.5 ? A?.grenade_f1 : A?.grenade_rgd5) || A?.grenade_f1 || A?.grenade_rgd5;
      if (tpl) { const m = p.gmesh = tpl.scene.clone(); m.traverse(o => { if (o.isMesh) { o.castShadow = true; if (/_LOD1$/i.test(o.name)) o.visible = false; } }); m.position.copy(p.pos); g.scene.add(m); p.spin = new THREE.Vector3(Math.random() * 12 + 6, Math.random() * 4, Math.random() * 4); }
    }
    if (g.camDist(s.pos) < 60) g.sfx('grenade_throw', s.pos);
  }
  throwSmoke(s, toward) {
    const p = s.pos.clone().lerp(toward, Math.min(1, 18 / s.pos.distanceTo(toward)));
    // v7: thrown like a grenade (clip, in hand, release); the screen builds where it lands (smokeLand)
    if (s.effective && !s.aboard && !(s.throwT > 0)) { p.y = this.g.city.groundHeight ? this.g.city.groundHeight(p.x, p.z) + 0.1 : 0.1; this.startThrow(s, p, { speed: 14, extra: { smoke: true } }); return; }
    this.smokeLand(p);
  }
  smokeLand(p) {
    this.g.fx.smokeScreen(p); this.g.sfx('grenade_throw', p);
    const o = this.g.nav.addOccluder(p.x, p.z, 5, 5, 0, 7, null);
    o.smokeUntil = this.g.time + 30;
  }
  // ---------------------------------------------------------------- close quarters (building storming)
  // storming an occupied building: stack, breach, then room-by-room clearing inside (game/cqb.js)
  stormTick(sq, dt) { return this.g.cqb.think(sq, dt); }
  // v7: a section that comes down takes its floors with it: the dead lying on them drop onto the rubble (they stayed in the air
  // where the floor had been) and men inside clearing it (not at a window slot: city.collapseSection deals with those) are caught
  collapseDrop(b, si) {
    const g = this.g, gh = g.city.groundHeight, [a, c] = b.secCols?.[si] || [];
    if (a == null || !b.toLocal) return;
    const W = b.kit.W, x0 = -b.L / 2 + a * W - 0.5, x1 = -b.L / 2 + (c + 1) * W + 0.5;
    for (const sq of g.squads) for (const s of sq.soldiers) {
      if (s.state === 'evac' || s.aboard) continue;
      const [lx, lz] = b.toLocal(s.pos.x, s.pos.z); if (lx < x0 || lx > x1 || Math.abs(lz) > b.D / 2 + 0.5) continue;
      const y = gh ? gh(s.pos.x, s.pos.z) : 0; if (s.pos.y < y + 0.8) continue;
      if (s.state === 'dead') { const dy = y - s.pos.y; s.pos.y = y; if (s.inBuilding) s.inside = null; s.cqb = null; s.root.position.y += dy; s.root.updateMatrixWorld(true); continue; }
      if (s.slotRef || s.cellar) continue;
      s.cqb = null; s.inside = null; s.pos.y = y; s.path = null; this.hitSoldier(s, { dmg: [70, 220], type: 'blast' }, s.pos, true);
    }
  }
  // ---------------------------------------------------------------- casualties
  hitSoldier(t, W, fromPos, blast = false, shooter = null) {
    if (!t.alive || t.state === 'dead') return;
    const g = this.g; let dmg, head = false;
    if (blast || W.type === 'blast') { dmg = rf(...(W.dmg || [40, 90])); if (t.stance === 'prone') dmg *= 0.6; if (t.armor?.plateCoverage > 0.5) dmg *= 0.8; }
    else {
      const r = Math.random();
      if (r < 0.06) { head = true; if (Math.random() < (t.armor?.helmetStop ?? TUNING.helmetStopChance) && W.type !== 'hmg' && W.type !== 'autocannon') { dmg = rf(8, 20); head = false; t.suppression = 100; } else if (W.type !== 'hmg' && W.type !== 'autocannon' && Math.random() < (TUNING.wound?.headGraze ?? 0)) { dmg = rf(45, 85); head = false; t.suppression = 100; } else dmg = 160; }   // v7: some head hits are grazes (face / neck / glancing): a bad wound, not death
      else if (r < 0.55) { // torso
        const A = t.armor || { plateCoverage: TUNING.plateCoverage, plateStop: TUNING.plateStopsRifle }; const stopP = W.type === 'rifle' || W.type === 'frag' ? A.plateStop * A.plateCoverage / 0.47 : W.type === 'mg' ? A.plateStop * A.plateCoverage / 0.47 * 0.65 : 0;
        if (Math.random() < Math.min(0.9, stopP)) { dmg = rf(4, 14); t.suppression = Math.min(100, t.suppression + 40); t.hitT = 0.5; }
        else dmg = rf(W.dmg[0], W.dmg[1]) * 1.1;
      } else { dmg = rf(W.dmg[0] * 0.6, W.dmg[1] * 0.8) * (t.armor?.plateCoverage > 0.5 && r < 0.7 ? 0.5 : 1); if (r > 0.78) t.legWound = true; }
      if (W.type === 'hmg' || W.type === 'autocannon') dmg *= 2.5;
      t.lastHit = { region: r < 0.06 ? (head ? 'head' : 'helmet') : r < 0.55 ? (dmg < 15 ? 'plate' : 'torso') : r > 0.78 ? 'leg' : 'limb', from: fromPos };   // soldierDamage.js: where the wound shows
    }
    if (blast || W.type === 'blast') t.lastHit = { region: 'blast', from: fromPos };
    t.hp -= dmg;
    const sq = t.squad;
    if (g.camDist(t.pos) < 120) g.fx.blood(this.targetPoint(t, C));
    if (t.hp <= 0) {
      // survivability: most non-head hits leave a man badly wounded (savable by a medic/evac) rather than dead
      const WT = TUNING.wound || {};
      const heavy = blast || W.type === 'blast' || W.type === 'hmg' || W.type === 'autocannon';   // (heavy weapons keep the old overkill line)
      if (head || t.hp < (heavy ? (WT.overkillHeavy ?? -95) : (WT.overkill ?? -95)) || (blast && Math.random() < (WT.blastKill ?? 0.25))) { t.die(null, { from: fromPos, blast: blast || W.type === 'blast', power: dmg, head }); g.onDeath(t, shooter, false); }
      else if (t.state !== 'critical' && t.state !== 'stable') {
        t.state = 'critical'; t.bleed = rf(...TUNING.bleedOut) * (1 + (g.mods?.[sq.side]?.medevac || 0)); t.target = null; t.path = null;
        if (t.dragging) { t.dragging.dragger = null; t.dragging = null; }
        if (t.slotRef) { t.slotRef.occupant = null; t.slotRef = null; if (t.inBuilding) { t.inside = null; } }
        sq.onCasualty(t, false); g.stats[sq.side].wia++;
        if (g.camDist(t.pos) < 80) g.sfx('pain', t.pos);
        if (shooter) (shooter.squad || shooter).stats.kills += 0.5;
      } else { t.die(null, { from: fromPos, blast: blast || W.type === 'blast', power: dmg, head }); g.onDeath(t, shooter, false); }
    } else if (t.hp < (TUNING.wound?.lightHp ?? 55) && t.state === 'ok') {
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
  fireTankGun(v, t, round, W = WEAPONS.a46) {
    const g = this.g; v.firedT = 0;
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
    this.projectiles.push({ kind: round === 'ap' ? 'apfsds' : 'he', pos: from.clone(), target: tp, t, speed: round === 'ap' ? 1650 : W.projectile?.speed || 850, owner: v, side: v.side, weapon: W, occ, hit });
  }
  // vehicle-launched guided missile (TOW from the Bradley's launcher box, 9M117 through the BMP-3's 100 mm gun)
  fireVehicleMissile(v, t, W) {
    const g = this.g; v.firedT = 0;
    const n = v.model?.getObjectByName((v.atgm?.fired || 1) % 2 ? 'atgm_muzzle_1' : 'atgm_muzzle_2') || v.muzzle;
    const from = n ? n.getWorldPosition(new THREE.Vector3()) : v.pos.clone().setY(2.4);
    const tp = this.targetPoint(t, B).clone(), d = from.distanceTo(tp);
    const hit = Math.random() < 0.9 * Math.exp(-d / 4000) * (Math.abs(t.speed || 0) > 3 ? 0.85 : 1) * (v.opticsDamaged ? 0.6 : 1);
    if (!hit) { tp.x += (Math.random() - .5) * 8; tp.z += (Math.random() - .5) * 8; tp.y = Math.max(0.2, tp.y + (Math.random() - .5) * 2); }
    const dir = tp.clone().sub(from).normalize();
    g.fx.muzzle(from, dir, 1.6); g.fx.light(from, 0xffc27a, 18, 10, 0.07);
    for (let i = 0; i < 8; i++) g.fx.smoke.spawn({ x: from.x - dir.x * (0.5 + i * 0.5), y: from.y, z: from.z - dir.z * (0.5 + i * 0.5), vx: -dir.x * 5 + (Math.random() - .5) * 2, vy: 0.5, vz: -dir.z * 5 + (Math.random() - .5) * 2, life: 2.6, size0: 0.6, size1: 3, r: 0.78, g: 0.76, b: 0.72, a0: 0.5, a1: 0, drag: 1.8, wind: g.fx.wind });
    g.sfx('rpg_launch', from, { gain: 1.2 });
    const mesh = this.rocketMesh(); mesh.scale.setScalar(1.6); mesh.position.copy(from); mesh.lookAt(tp); g.scene.add(mesh);
    this.projectiles.push({ kind: 'rpg', pos: from.clone(), last: from.clone(), target: tp, t, speed: W.projectile?.speed || 280, owner: v, side: v.side, weapon: W, trail: 0, age: 0, mesh, hit });
    if (v.side === 'player') g.hud?.alert(`${v.name}: ${W.name.split(' (')[0]} launched at ${t.name}`);
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
    if (t.type !== 'vehicle') { if (t.inBuilding) p *= W.type === 'hmg' || W.type === 'autocannon' ? 0.45 : this.windowExposed(t) ? 0.4 : 0.03; else if (t.inside === 'ride') p *= 0.8; else { p *= 1 - g.nav.coverFrom(t.pos.x, t.pos.z, v.pos.x, v.pos.z) * 0.7; if (t.stance === 'prone') p *= 0.45; else if (t.stance === 'crouch') p *= 0.75; } }
    else p = Math.min(0.9, p * 3);
    let hit = Math.random() < p;
    const end = tp.clone(); if (!hit) { const m = 0.8 + d * 0.02; end.x += (Math.random() - .5) * m * 2; end.z += (Math.random() - .5) * m * 2; end.y = Math.max(0.05, end.y + (Math.random() - .6) * m); }
    // MG rounds stop in a trunk; HMG / 30 mm go through a tree (and the 30 mm bursts on it below)
    if (W.type !== 'autocannon' && W.type !== 'hmg') { const th = trunkHit(from.x, from.y, from.z, end.x, end.y, end.z, 1.5); if (th) { hit = false; end.set(th.x, th.y, th.z); this.trunkStops = (this.trunkStops || 0) + 1; } }
    w.shots = (w.shots || 0) + 1;
    // BTR weapons trace every round; tank coax every 3rd
    if (g.camDist(v.pos) < 500 && (v.kind === 'btr' || v.kind === 'ifv' || w.shots % 3 === 0)) g.fx.tracer(from, end, 900, TRACER[v.faction.id]);
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
        // v7: held until the throw clip's release (startThrow / grenadeHeld); the fuse counts from the start of the throw
        if (p.delay > 0) { p.fuse += dt; p.fuse0 = p.fuse; this.grenadeHeld(p, dt); if (p.delay > 0) continue; }
        p.fuse += dt; const fl = p.fuse - (p.fuse0 || 0), tot = Math.max(0.05, p.from.distanceTo(p.target) / p.speed); const f = Math.min(1, fl / tot);
        const arcH = p.dropped ? 0.15 : Math.min(4, 0.6 + p.from.distanceTo(p.target) * 0.16);   // a 5 m lob into a bay / room stays low; 25 m: ~4 m
        p.pos.lerpVectors(p.from, p.target, f); p.pos.y = p.from.y + (p.target.y - p.from.y) * f + Math.sin(f * Math.PI) * arcH;
        if (p.gmesh) { p.gmesh.position.copy(p.pos); if (f < 1) { p.gmesh.rotation.x += p.spin.x * dt; p.gmesh.rotation.y += p.spin.y * dt; p.gmesh.rotation.z += p.spin.z * dt; } }
        if (p.smoke && f >= 1) { this.projectiles.splice(i, 1); if (p.gmesh) { g.scene.remove(p.gmesh); p.gmesh = null; } this.smokeLand(p.target.clone()); continue; }
        if (p.fuse >= Math.max((p.fuse0 || 0) + tot, 3.2)) { this.projectiles.splice(i, 1); if (p.gmesh) { g.scene.remove(p.gmesh); p.gmesh = null; } this.explode(p.target.clone().setY(Math.max(0.2, p.target.y)), 0.45, p.owner, [50, 140], 6); if (p.cellar) g.cqb?.cellarBlast(p.cellar, p.owner); }
        continue;
      }
      // rockets & HE fly through the world: walls, terrain (trench lips, rubble, rises) and tree crowns / bushes stop
      // them where they are, not where the target is. The firer's own building is ignored for the first metres (he
      // fires out of a window), the target's building is a facade it bursts on.
      if (p.kind === 'rpg' || p.kind === 'he' || p.kind === 'he30') {
        const nx = dist <= step ? to : C2.copy(p.pos).addScaledVector(dir, step / dist);
        p.flown = (p.flown || 0) + Math.min(step, dist);
        const own = p.flown < 5 ? (p.owner?.squad?.building || p.owner?.bld || null) : null;
        const occ = g.nav.occluded(p.pos.x, p.pos.y, p.pos.z, nx.x, nx.y, nx.z, own, null);
        const th = (p.kind === 'rpg' || p.kind === 'he') && p.flown > 1.5 ? trunkHit(p.pos.x, p.pos.y, p.pos.z, nx.x, nx.y, nx.z, 0) : null;   // a rocket / shell bursts on a tree trunk
        if (th && !(occ && g.nav.occluded(p.pos.x, p.pos.y, p.pos.z, th.x, th.y, th.z, own, null))) {
          this.projectiles.splice(i, 1); if (p.mesh) { g.scene.remove(p.mesh); p.mesh = null; }
          p.occ = null; p.hit = false; this.trunkBursts = (this.trunkBursts || 0) + 1; this.impact(p, new THREE.Vector3(th.x, th.y, th.z)); continue;
        }
        if (occ) {
          this.projectiles.splice(i, 1); if (p.mesh) { g.scene.remove(p.mesh); p.mesh = null; }
          const at = occ.ref?.panels ? this.facadePoint(occ, p.pos, nx) : p.pos.clone().lerp(nx, 0.5);
          p.occ = null;   // resolved here: burst at this point
          this.impact(p, at); continue;
        }
      }
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
      if (p.occ === undefined && !p.flown) p.occ = g.nav.occluded(p.owner.pos.x, 2, p.owner.pos.z, at.x, at.y, at.z, p.owner.squad?.building || null, p.t && p.t.type !== 'vehicle' && p.t.inBuilding ? p.t.bld : null);
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
    if (globalThis.__hitlog) console.warn(`EXPL ${at.x.toFixed(0)},${at.z.toFixed(0)} p=${power} by ${owner?.name} t=${this.g.time.toFixed(1)}`);
    const g = this.g;
    at.y = Math.max(0.1, at.y);
    const b = g.city.buildingAt(at.x, at.z, 1.2);
    const hs = !b && g.houses ? g.houses.at(at.x, at.z, 0.4) : null;   // a burst in / on a private house
    if (g.houses && power >= 1) for (const h of g.houses.near(at.x, at.z, 40)) h.shelledT = g.time;   // (the garrison's cellar AI)
    const onGround = at.y < 0.6 && !b && !hs;
    g.fx.explosion(at, power, { dust: b ? [0.66, 0.63, 0.58] : [0.55, 0.49, 0.41] });
    g.sfx(power >= 2 ? 'explosion_medium' : power >= 0.7 ? 'explosion_small' : 'explosion_small', at, { gain: power >= 0.5 ? 1 : 0.6 });
    const cd = g.camDist(at); g.cam.addShake(Math.max(0, power * 0.5 - cd / 200)); if (cd < 120) g.renderer.flash(0.04 * power);
    if (onGround) g.city.addCrater(at.x, at.z, 1.2 + power * 1.3);
    if (b) this.damageBuilding(b, at, power * 55);
    // casualties. Inside `radius`: the blast core (overpressure + dense fragments, kills/wounds by distance). Beyond
    // it, out to fragR: the fragment zone - each man has a falling chance of being struck by a splinter, mostly
    // wounding (152/155 mm HE: ~50 m lethal / ~100 m casualty radius for men standing in the open; 82 mm mortar ~30 m;
    // prone, trench, cover and buildings cut it hard)
    const fragR = radius * (power >= 2.5 ? 6.5 : power >= 1 ? 4 : 2.5), supR = Math.max(radius * 3, fragR);
    for (const sq of g.squads) {
      for (const s of sq.soldiers) {
        if (!s.alive || s.inside === 'btr') continue;
        const d = s.pos.distanceTo(at); if (d > supR) continue;
        if (s.cellar) {   // down in a cellar: only a heavy shell right on the house reaches it (a grenade down the hatch: cqb.cellarBlast)
          if (hs === s.cellar && power >= 2 && Math.random() < 0.12 * power) this.hitSoldier(s, { dmg: [40, 120], type: 'blast' }, at, true, owner);
          continue;
        }
        s.suppression = Math.min(100, s.suppression + 60 * (1 - d / supR) * power);
        sq.underFireT = 0;
        if (d > radius) {   // fragment zone
          if (d > fragR) continue;
          let p = 0.85 * Math.pow(radius / d, 1.5);
          if (s.stance === 'prone') p *= 0.35; else if (s.stance === 'crouch') p *= 0.7;
          if (s.inBuilding) p *= s.bld.house ? 0.3 : 0.06;   // brick/timber walls vs concrete panels
          else if (s.pos.y < -0.8) p *= 0.12;                // down in a trench / foxhole: only what comes down from above
          if (Math.random() >= p) continue;
          if (!s.inBuilding && !this.los(at.x, at.y + 0.5, at.z, s.pos.x, 1, s.pos.z, null, null)) continue;   // a wall/wreck took it
          const f = Math.pow(radius / d, 0.5);
          this.hitSoldier(s, { type: 'frag', dmg: [30 * f, 130 * f] }, at, false, owner);
          continue;
        }
        let k = Math.pow(1 - d / radius, 1.4);
        if (s.inBuilding && s.bld.house) {   // brick / timber cottage: walls stop less than a concrete panel
          if (hs === s.bld) k = Math.pow(Math.max(0, 1 - d / Math.max(5, radius)), 1.1) * 0.95; else k *= 0.6;
        } else if (s.inBuilding) {
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
      if (sq.side) sq.addMorale(-1.5 * power * (sq.center().distanceTo(at) < supR ? 1 : 0));
    }
    for (const v of g.vehicles) {
      if (v.destroyed) continue; const d = v.pos.distanceTo(at); if (d > radius) continue;
      if (power >= 1.5 && Math.random() < 0.3) this.hitVehicle(v, { pen: 40, dmg: [60, 120] }, at, 'ce', owner, true);
      else v.hp -= 20 * power * (1 - d / radius);
    }
    if (!b && at.y < 3) g.city.damageFortAt?.(at.x, at.z, power, radius);   // dragon's teeth: big HE breaches the belt
    trenchBlast(g, at, power, owner);
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
    for (const si of b.checkCollapse()) { const had = b.collapsedSecs?.has(si); g.city.collapseSection(b, si, g); if (!had) this.collapseDrop(b, si); }
    // garrison morale
    for (const sq of g.squads) if (sq.building === b) { sq.addMorale(-4 * Math.min(3, changed.length)); sq.underFireT = 0; }
  }
  // ---------------------------------------------------------------- armour
  // Hit-location armour model (armor.js): which plate was struck, at what obliquity, ERA, penetration vs
  // effective thickness, then what lies behind the armour along the round's path.
  hitVehicle(v, W, fromPos, kind, owner, top = false, at = null) {
    if (globalThis.__hitlog) console.warn(`HIT ${v.name} by ${owner?.name} ${W?.name} kind=${kind} t=${this.g.time.toFixed(1)}`);
    if (v.destroyed) return;
    const g = this.g;
    if (!v.zones) initArmor(v);
    const k = W.type === 'tankgun' && kind === 'ke' ? 'ke' : kind;
    const from = top ? new THREE.Vector3(v.pos.x + (Math.random() - .5) * 2, 30, v.pos.z + (Math.random() - .5) * 2) : fromPos;
    const r = resolveHit(v, W, from, k, at, from.distanceTo ? from.distanceTo(v.pos) : 0);
    if (r.miss) return;
    if ((k === 'ce' || k === 'he') && v.passengers) for (const s of v.passengers.soldiers) if (s.inside === 'ride' && s.effective && Math.random() < 0.3) this.hitSoldier(s, { dmg: [30, 120], type: 'blast' }, at || v.pos, true, owner);   // riders: fragments of the burst on the hull
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
    // big shaped charges (ATGM, FPV warhead) through thin armour: the jet and blast wreck the compartment
    if (W.type === 'atgm' && r.residual > 250) {
      v.hp -= rf(...W.dmg) * Math.min(1, r.residual / 700) * (v.kind === 'btr' ? 1.6 : v.kind === 'ifv' ? 1.35 : 1);
      if (!v.burning && Math.random() < (v.kind === 'btr' ? 0.55 : v.kind === 'ifv' ? 0.45 : 0.25)) { v.burning = 0.01; msgs.push('on fire'); }
    }
    // an FPV warhead on the engine deck: engine wrecked, fuel and oil very often catch
    if (W === WEAPONS.fpv && fx.has('engine') && !v.burning && Math.random() < 0.65) { v.burning = 0.01; msgs.push('engine on fire'); }
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
      if (part.atgm && !v.atgmDisabled) { v.atgmDisabled = true; msgs.push('ATGM launcher destroyed'); }
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
    const g = this.g, eye = A.set(v.pos.x, (v.pos.y || 0) + 2.4, v.pos.z).clone();
    const mainW = WEAPONS[v.weapons[0].key];
    let best = null, bs = -1e9, bestInf = null, bi = 1e9;
    for (const u of g.enemiesOf(v.side)) {
      if (!g.seen(v.side, u, v.pos)) continue;
      if (u.type === 'vehicle') {
        if (u.destroyed) continue; const d = u.pos.distanceTo(v.pos); if (d > mainW.range) continue;
        if (!this.los(eye.x, eye.y, eye.z, u.pos.x, (u.pos.y || 0) + 1.5, u.pos.z, v, u)) continue;
        const sc = (u.kind === 'tank' ? 300 : 200) - d * 0.3 + (v.focus === u ? 200 : 0);
        if (v.kind === 'btr' && u.kind === 'tank') continue; // BTRs don't duel tanks
        if (v.kind === 'ifv' && u.kind === 'tank' && (!v.atgm || v.atgm.ammo <= 0 || v.atgmDisabled)) continue;   // IFVs only with missiles
        if (sc > bs) { bs = sc; best = u; }
        continue;
      }
      // infantry: pick a soldier (riders on armour are prime targets) (prefer clusters / garrisons for HE)
      for (const s of u.soldiers) {
        if (!s.effective || s.inside === 'btr') continue;
        // a vehicle only engages infantry it could plausibly make out itself (or that is shooting at it)
        const d = s.pos.distanceTo(v.pos); if (d > ((u.firedT ?? 99) < 3 ? 420 : v.side === 'enemy' ? 200 : 260)) continue;
        if (!this.losFrom(eye.x, eye.y, eye.z, s, v) && !(this.roughFix(s) && this.losFrom(eye.x, eye.y, eye.z, s, v, true))) continue;
        if (d < bi) { bi = d; bestInf = s; }
        const sc = 120 - d * 0.25 + (s.inBuilding ? 40 : 0) + (s.inside === 'ride' ? 50 : 0) + (v.focus === u ? 200 : 0) + (s.weaponKey === 'rpg7' ? 60 : 0);
        if (v.kind === 'tank' && v.weapons[0].he <= 0 && !s.inBuilding) continue;
        if (sc > bs) { bs = sc; best = s; }
        break; // one LOS-checked soldier per squad is enough
      }
    }
    v.target = v.kind === 'spg' ? null : best; v.coaxTarget = bestInf && bi < 500 ? bestInf : null;
    if (v.target && v.target.type !== 'vehicle' && v.kind === 'tank' && v.target.squad && !v.target.inBuilding && v.weapons[0].he < 6) v.target = null; // save HE for buildings
  }
}
