import * as THREE from 'three';
import { WEAPONS } from '../config.js';
import { MAP } from '../world/city.js';

// Support teams: ATGM (Kornet for Russia / Stugna-P for Ukraine, 3 men) and FPV drone teams (2 men, 3 drones).
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function cloneNode(g, name) { const o = g?.scene.getObjectByName(name); return o ? o.clone(true) : null; }

// ---------------------------------------------------------------- ATGM team
// gunner, loader, ammo bearer. Sets up the tripod when halted (atgm_setup), fires SACLOS-guided missiles at
// spotted vehicles out to long range, the loader reloads from the bearer's tubes. One man down: everything takes
// twice as long. Two down: the survivor abandons the launcher and fights with his pistol.
export class AtgmTeam {
  constructor(sq) {
    this.sq = sq; this.g = sq.game; this.state = 'packed'; this.t = 0; this.ammo = 4; this.loaded = true;
    this.W = WEAPONS[sq.faction.id === 'RU' ? 'kornet' : 'stugna']; this.launcher = null; this.missile = null; this.scanT = 0;
  }
  get name() { return this.sq.faction.id === 'RU' ? 'Kornet' : 'Stugna-P'; }
  status() {
    if (this.abandoned) return 'LAUNCHER ABANDONED';
    if (this.state === 'setting') return 'SETTING UP';
    if (this.state === 'packing') return 'PACKING UP';
    if (this.state === 'deployed') return this.missile ? 'MISSILE IN FLIGHT' : !this.loaded && this.ammo > 0 ? 'RELOADING' : this.ammo <= 0 && !this.loaded ? 'OUT OF MISSILES' : `READY · ${this.ammo} MSL`;
    return `PACKED · ${this.ammo} MSL`;
  }
  crew() { return this.sq.effective; }
  efficiency() { const n = this.crew().length; return n >= 3 ? 1 : n === 2 ? 0.5 : 0; }
  gunner() { return this.crew()[0]; }
  loader() { return this.crew()[1] || this.crew()[0]; }
  placeLauncher(s) {
    this.removeLauncher();
    const A = this.g.assets.gltf, rus = this.sq.faction.id === 'RU';
    const src = rus ? A.kornet : A.stugna;
    let obj = src ? src.scene.clone(true) : null;
    if (obj) { const hide = []; obj.traverse(o => { if (/folded|gunner_ref|seat_ref/i.test(o.name)) hide.push(o); if (o.isMesh) { o.castShadow = true; if (/_LOD1$/i.test(o.name)) o.visible = false; } }); for (const o of hide) o.visible = false; }
    if (!obj) { // stand-in: tripod, pedestal, guidance box with sight, missile tube (TLC) on top
      obj = new THREE.Group(); const rus = this.sq.faction.id === 'RU';
      const m = new THREE.MeshStandardMaterial({ color: rus ? 0x4a5236 : 0x47503a, roughness: 0.75, metalness: 0.2 }), dk = new THREE.MeshStandardMaterial({ color: 0x1d1f1b, roughness: 0.6 });
      const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); o.castShadow = true; obj.add(o); return o; };
      add(new THREE.CylinderGeometry(0.035, 0.04, 0.62, 8), m, 0, 0.31, 0);                                   // pedestal
      for (let i = 0; i < 3; i++) { const a = i * 2.094 + Math.PI, lx = Math.sin(a) * 0.32, lz = Math.cos(a) * 0.32;   // legs splayed to the ground
        const leg = add(new THREE.CylinderGeometry(0.016, 0.02, 0.62, 6), m, lx, 0.21, lz); leg.lookAt(lx * 2.2, -0.2, lz * 2.2); leg.rotateX(Math.PI / 2); add(new THREE.BoxGeometry(0.07, 0.02, 0.07), dk, lx * 1.8, 0.01, lz * 1.8); }
      add(new THREE.BoxGeometry(0.2, 0.24, 0.32), m, 0, 0.72, -0.02);                                         // guidance / sight unit
      add(new THREE.CylinderGeometry(0.035, 0.04, 0.16, 10), dk, -0.02, 0.76, -0.24, Math.PI / 2);            // eyepiece
      add(new THREE.BoxGeometry(0.12, 0.14, 0.26), dk, rus ? 0.17 : -0.17, 0.72, 0.0);                       // thermal sight
      const L = rus ? 1.2 : 1.36, r = rus ? 0.085 : 0.075;
      add(new THREE.CylinderGeometry(r, r, L, 14), m, 0, 0.93, 0.3, Math.PI / 2);                           // TLC tube
      for (const z of [0.3 - L / 2, 0.3 + L / 2]) add(new THREE.CylinderGeometry(r + 0.012, r + 0.012, 0.06, 14), dk, 0, 0.93, z, Math.PI / 2);
      const mz = new THREE.Object3D(); mz.name = 'muzzle'; mz.position.set(0, 0.93, 0.3 + L / 2 + 0.05); obj.add(mz);
    }
    const f = new THREE.Vector3(Math.sin(s.heading), 0, Math.cos(s.heading));
    obj.position.copy(s.pos).addScaledVector(f, 0.75); obj.rotation.y = s.heading; obj.updateMatrixWorld(true);
    this.g.scene.add(obj); this.launcher = obj; this.muzzle = obj.getObjectByName('muzzle');
  }
  removeLauncher(leave = false) { if (this.launcher && !leave) this.g.scene.remove(this.launcher); this.launcher = null; }
  update(dt) {
    const sq = this.sq, g = this.g;
    if (this.missile) this.flyMissile(dt);
    if (sq.mounted || sq.destroyed) { if (this.state !== 'packed') { this.state = 'packed'; this.removeLauncher(); } return; }
    const crew = this.crew(), eff = this.efficiency();
    for (const s of sq.soldiers) { s.supportClip = null; s.noRifle = false; }
    if (this.abandoned) return;
    if (eff === 0) { // last man: leave the launcher, draw the pistol
      this.abandoned = true; this.removeLauncher(true); this.state = 'packed';
      for (const s of crew) s.setWeapon?.('pm');
      if (sq.side === 'player') g.hud?.alert(`${sq.name}: launcher abandoned`, 'bad');
      return;
    }
    const gun = this.gunner();
    // the gunner went down: the next man crawls over and takes the sight
    if (this.launcher && (this.state === 'deployed' || this.state === 'setting') && this.gunRef && gun !== this.gunRef) {
      const f = this.launcher.rotation.y, lx = this.launcher.position.x - Math.sin(f) * 0.75, lz = this.launcher.position.z - Math.cos(f) * 0.75;
      g.requestPath(gun, gun.pos.x, gun.pos.z, lx, lz, 0.3); this.state = 'manning'; this.t = 2 / eff;
      if (sq.side === 'player') g.hud?.alert(`${sq.name}: gunner down — ${gun.role.role.toLowerCase()} takes over`, 'bad');
    }
    this.gunRef = gun;
    if (this.state === 'manning') {
      const f = this.launcher.rotation.y, lx = this.launcher.position.x - Math.sin(f) * 0.75, lz = this.launcher.position.z - Math.cos(f) * 0.75;
      gun.noRifle = true; gun.stance = 'crouch';
      if (Math.hypot(gun.pos.x - lx, gun.pos.z - lz) < 1.3 || (!gun.path && !gun.pathReq)) { this.t -= dt; gun.supportClip = 'atgm_aim'; gun.supportAlt = ['aim_crouch']; if (this.t <= 0) this.state = 'deployed'; }
      return;
    }
    const moving = this.state === 'packed' || this.state === 'packing' ? crew.some(s => (s.path && s.pathI < s.path.length) || s.pathReq) : (gun.path && gun.pathI < gun.path.length) || gun.pathReq || (sq.order?.type === 'move' && sq.order !== this.setOrder);
    if (moving && (this.state === 'deployed' || this.state === 'setting')) { this.state = 'packing'; this.t = 3 / eff; }
    if (this.state === 'packing') {
      this.t -= dt; for (const s of crew) s.aimStopT = Math.max(s.aimStopT || 0, 0.3);
      gun.supportClip = 'atgm_pack'; gun.supportAlt = ['crouch_idle'];
      if (this.t <= 0) { this.state = 'packed'; this.removeLauncher(); }
      return;
    }
    if (!moving && this.state === 'packed') {
      this.state = 'setting'; this.setOrder = sq.order; this.t = 6 / eff; this.placeLauncher(gun); if (this.launcher) this.launcher.visible = false;
      // loader kneels at the gunner's right shoulder, the ammo bearer a few metres back with the spare tubes
      const h = gun.heading, R = [Math.cos(h), -Math.sin(h)], F = [Math.sin(h), Math.cos(h)];
      const slots = [[1.1, -0.4], [-1.6, -3.2]];
      crew.slice(1).forEach((s, i) => { const [r, f] = slots[i] || slots[1]; const [x, z] = g.nav.nearestFree(gun.pos.x + R[0] * r + F[0] * f, gun.pos.z + R[1] * r + F[1] * f, 0.3, 6); s.goal = [x, z]; s.goalHeading = h; g.requestPath(s, s.pos.x, s.pos.z, x, z, 0.3); });
    }
    if (this.state !== 'packed') for (const s of crew) s.stance = s.stance === 'prone' ? 'prone' : 'crouch';
    if (this.state === 'setting') {
      this.t -= dt; gun.supportClip = 'atgm_setup'; gun.supportAlt = ['crouch_idle']; gun.noRifle = true;
      if (this.launcher && this.t < 6 / eff - 1.2) this.launcher.visible = true;
      if (this.t <= 0) { this.state = 'deployed'; if (sq.side === 'player') g.sfx('ui_click'); }
      return;
    }
    if (this.state !== 'deployed') return;
    gun.noRifle = true; gun.supportClip = this.fireT > 0 ? 'atgm_fire' : 'atgm_aim'; gun.supportAlt = ['aim_launcher_kneel', 'aim_crouch'];
    this.fireT = Math.max(0, (this.fireT || 0) - dt);
    if (this.launcher) { gun.heading = this.launcher.rotation.y; }
    // reload: loader fits a new tube
    if (!this.loaded && !this.missile && this.ammo > 0) {
      this.reloadT = (this.reloadT ?? 8 / eff) - dt; const ld = this.loader(); if (ld !== gun) { ld.supportClip = 'atgm_reload'; ld.supportAlt = ['crouch_idle']; ld.noRifle = true; }
      if (this.reloadT <= 0) { this.loaded = true; this.reloadT = null; }
    }
    // targeting
    if ((this.scanT -= dt) > 0 || !this.loaded || this.missile) return;
    this.scanT = 0.8;
    const from = this.muzzle ? this.muzzle.getWorldPosition(tmpA) : tmpA.copy(gun.pos).setY(0.8);
    let best = null, bs = -1e9;
    for (const u of g.enemiesOf(sq.side)) {
      if (u.type !== 'vehicle' || u.destroyed || !g.seen(sq.side, u, from)) continue;
      const d = from.distanceTo(u.pos); if (d > this.W.range || d < 40) continue;
      if (!g.combat.los(from.x, from.y, from.z, u.pos.x, 1.4, u.pos.z, null, u)) continue;
      const sc = (sq.focus === u ? 500 : 0) + (u.kind === 'tank' ? 200 : 120) - d * 0.1 + (u.abandoned ? -400 : 0);
      if (sc > bs) { bs = sc; best = u; }
    }
    if (!best) return;
    // traverse the launcher onto the target, then launch
    const yaw = Math.atan2(best.pos.x - from.x, best.pos.z - from.z);
    if (this.launcher) { this.launcher.rotation.y = yaw; this.launcher.updateMatrixWorld(true); }
    this.fire(best, gun);
  }
  fire(t, gun) {
    const g = this.g, from = (this.muzzle ? this.muzzle.getWorldPosition(new THREE.Vector3()) : gun.pos.clone().setY(0.8));
    this.loaded = false; this.ammo--; this.fireT = 1.5; this.sq.firedT = 0;
    const dir = tmpB.set(t.pos.x - from.x, 0, t.pos.z - from.z).normalize();
    g.fx.muzzle(from, dir, 1.8); g.fx.light(from, 0xffc27a, 20, 12, 0.08);
    for (let i = 0; i < 10; i++) g.fx.smoke.spawn({ x: from.x - dir.x * (1 + i * 0.6), y: from.y, z: from.z - dir.z * (1 + i * 0.6), vx: -dir.x * 6 + (Math.random() - .5) * 2, vy: 0.6, vz: -dir.z * 6 + (Math.random() - .5) * 2, life: 3, size0: 0.7, size1: 3.5, r: 0.78, g: 0.76, b: 0.72, a0: 0.5, a1: 0, drag: 1.8, wind: g.fx.wind });
    g.sfx('rpg_launch', from, { gain: 1.2 });
    const mesh = g.combat.rocketMesh(); mesh.scale.setScalar(1.7); mesh.position.copy(from); g.scene.add(mesh);
    this.missile = { pos: from.clone(), last: from.clone(), t, gun, mesh, age: 0, wob: Math.random() * 6, from: from.clone(), snd: g.audio.ok ? g.audio.loop('atgm_motor', from, 0.7) : null };
    if (this.sq.side === 'player') g.hud?.alert(`${this.sq.name}: ${this.name} launched at ${t.name}`);
    (g.supportLog ||= []).push(`${Math.round(g.time)} ${this.sq.side[0]} ${this.name} -> ${t.kind} ${Math.round(from.distanceTo(t.pos))}m`);
  }
  flyMissile(dt) {
    const m = this.missile, g = this.g, W = this.W;
    m.age += dt;
    const guided = m.gun.effective && !this.abandoned && this.launcher;
    const tp = m.t.destroyed ? m.lastTp || m.t.pos.clone().setY(1.2) : tmpA.set(m.t.pos.x, 1.3, m.t.pos.z);
    m.lastTp = tp.clone();
    let dir;
    if (guided) { dir = tmpB.subVectors(tp, m.pos).normalize(); dir.x += Math.sin(m.age * 7 + m.wob) * 0.012; dir.y += Math.cos(m.age * 5 + m.wob) * 0.01; dir.normalize(); m.dir = dir.clone(); }
    else { m.dir ||= tmpB.subVectors(tp, m.pos).normalize().clone(); m.dir.y -= dt * 0.15; dir = m.dir.normalize(); } // operator lost: it wanders off and crashes
    const step = (W.projectile?.speed || 240) * Math.min(1, 0.4 + m.age * 2) * dt;
    const next = m.pos.clone().addScaledVector(dir, step);
    // smoke trail + motor flare
    const n = Math.ceil(step / 0.5);
    for (let k = 0; k < n; k++) { const f = (k + 1) / n; g.fx.smoke.spawn({ x: m.pos.x + (next.x - m.pos.x) * f, y: m.pos.y + (next.y - m.pos.y) * f, z: m.pos.z + (next.z - m.pos.z) * f, vy: 0.2, life: 3 + Math.random(), size0: 0.25, size1: 1.8, r: 0.85, g: 0.84, b: 0.81, a0: 0.5, a1: 0, drag: 1.2, wind: g.fx.wind }); }
    g.fx.glow.spawn({ x: m.pos.x, y: m.pos.y, z: m.pos.z, life: 0.06, size0: 0.8, size1: 0.3, r: 1, g: 0.8, b: 0.4, a0: 3, a1: 0 });
    m.snd?.set(m.pos, 0.7);
    // obstruction: walls / buildings take the missile
    const occ = g.nav.occluded(m.pos.x, m.pos.y, m.pos.z, next.x, next.y, next.z, null, m.t);
    // swept test: at ~260 m/s the missile moves 13 m a frame, far more than the target's size
    let hitT = false;
    if (!m.t.destroyed) { const seg = tmpB.subVectors(next, m.pos), L2 = seg.lengthSq() || 1; const k = THREE.MathUtils.clamp(((tp.x - m.pos.x) * seg.x + (tp.y - m.pos.y) * seg.y + (tp.z - m.pos.z) * seg.z) / L2, 0, 1);
      const cx = m.pos.x + seg.x * k, cy = m.pos.y + seg.y * k, cz = m.pos.z + seg.z * k;
      if (Math.hypot(cx - tp.x, cz - tp.z) < Math.max(1.8, m.t.def.width * 0.55) && cy < m.t.def.height + 0.4) { hitT = true; next.set(cx, cy, cz); } }
    if (occ && !occ.foliage && !occ.smokeUntil && m.age > 0.15) return this.detonate(next, null, occ);
    if (hitT) return this.detonate(next, m.t);
    if (next.y < 0.05 || m.age > 12) return this.detonate(next.setY(Math.max(0.1, next.y)), null);
    m.pos.copy(next); m.mesh.position.copy(m.pos); m.mesh.lookAt(m.pos.clone().add(m.dir));
  }
  detonate(at, target, occ) {
    const m = this.missile, g = this.g; this.missile = null;
    (g.supportLog ||= []).push(`${Math.round(g.time)} ${this.sq.side[0]} ATGM ${target ? 'HIT ' + target.kind : occ ? 'wall' : 'ground'} y${at.y.toFixed(1)} a${m.age.toFixed(1)} d${Math.round(at.distanceTo(m.t.pos))}`);
    g.scene.remove(m.mesh); m.snd?.stop();
    if (target) { g.combat.hitVehicle(target, this.W, m.from, 'ce', m.gun, false, at.clone()); g.fx.explosion(at, 1.0); g.sfx('explosion_medium', at); g.fx.light(at, 0xffaa55, 30, 14, 0.08); }
    else { if (occ?.ref?.panels) g.combat.damageBuilding(occ.ref, g.combat.facadePoint(occ, m.pos, at), 40); g.combat.explode(at, 0.9, m.gun, [60, 160], 5); }
    if (!this.loaded && this.ammo > 0) this.reloadT = 8 / Math.max(0.5, this.efficiency());
  }
}

// ---------------------------------------------------------------- FPV team
// pilot (goggles, controller) + helper who launches. 3 drones. A drone climbs, flies to the target at ~110 km/h
// and dives in; it can miss, be shot down (hard), or be dodged (rarely). Vehicles: top/engine-deck hits are the
// most effective (often start a fire); anti-drone cages set many warheads off early.
export class FpvTeam {
  constructor(sq) { this.sq = sq; this.g = sq.game; this.drones = 3; this.drone = null; this.scanT = 1 + Math.random(); this.W = WEAPONS.fpv; }
  status() { return this.drone ? (this.drone.phase === 'launch' ? 'LAUNCHING DRONE' : 'DRONE AIRBORNE') : this.drones ? `${this.drones} DRONE${this.drones > 1 ? 'S' : ''} READY` : 'OUT OF DRONES'; }
  pilot() { return this.sq.effective[0]; }
  helper() { return this.sq.effective[1] || this.sq.effective[0]; }
  update(dt) {
    const sq = this.sq, g = this.g;
    for (const s of sq.soldiers) { s.supportClip = null; s.noRifle = false; }
    // targets throwing themselves aside (slides the man over a few frames rather than teleporting him)
    if (this.dodgers?.length) this.dodgers = this.dodgers.filter(o => { const k = Math.min(1, dt / Math.max(0.05, o.t)); o.m.pos.x += (o.x - o.m.pos.x) * k; o.m.pos.z += (o.z - o.m.pos.z) * k; o.t -= dt; return o.t > 0 && o.m.alive; });
    if (this.drone) this.flyDrone(dt);
    if (sq.mounted || sq.destroyed) return;
    const crew = sq.effective, moving = crew.some(s => (s.path && s.pathI < s.path.length) || s.pathReq);
    const p = this.pilot();
    if (this.drone && this.drone.phase !== 'launch') { p.supportClip = 'fpv_pilot'; p.supportAlt = ['crouch_idle']; p.noRifle = true; p.stance = 'crouch'; for (const s of crew) s.aimStopT = Math.max(s.aimStopT || 0, 0.3); }
    if (this.drone?.phase === 'launch') { const h = this.helper(); h.supportClip = 'fpv_launch'; h.supportAlt = ['crouch_idle']; h.noRifle = true; }
    if (this.drone || moving || !this.drones) return;
    if ((this.scanT -= dt) > 0) return;
    this.scanT = 1.5;
    // targets: ordered focus, then vehicles (prefer moving/exposed), then infantry in the open
    const from = p.pos; let best = null, bs = -1e9;
    for (const u of g.enemiesOf(sq.side)) {
      if (u.destroyed || !g.seen(sq.side, u, from)) continue;
      const c = u.type === 'vehicle' ? u.pos : u.center(); const d = c.distanceTo(from); if (d > this.W.range || d < 30) continue;
      if (u.type === 'squad' && (u.mounted || u.building)) continue;
      const taken = g.squads.some(o => o !== sq && o.side === sq.side && (o.support?.missile?.t === u || o.support?.drone?.target === u));
      const sc = (sq.focus === u ? 1000 : 0) - (taken ? 250 : 0) + (u.type === 'vehicle' ? (u.abandoned ? -300 : u.kind === 'tank' ? 300 : 260) : 60 + u.effective.length * 8) - d * 0.08;
      if (sc > bs) { bs = sc; best = u; }
    }
    if (best) this.launch(best);
  }
  launch(target) {
    const g = this.g, h = this.helper();
    this.drones--;
    const A = g.assets.gltf; let mesh = A.fpv_drone ? A.fpv_drone.scene.clone(true) : null;
    if (mesh) mesh.traverse(o => { if (o.isMesh) o.visible = !/_LOD1$/i.test(o.name); });
    if (!mesh) { mesh = new THREE.Group(); const m = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }); for (const r of [0.785, -0.785]) { const a = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.02, 0.03), m); a.rotation.y = r; mesh.add(a); } const w = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 8), new THREE.MeshStandardMaterial({ color: 0x4a4f3c })); w.rotation.x = Math.PI / 2; w.position.set(0, -0.04, 0.08); mesh.add(w); for (let i = 0; i < 4; i++) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.004, 10), new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.4 })); p.name = 'prop_' + i; p.position.set(Math.cos(i * 1.571 + 0.785) * 0.15, 0.02, Math.sin(i * 1.571 + 0.785) * 0.15); mesh.add(p); } }
    mesh.scale.setScalar(1.3); mesh.visible = false; g.scene.add(mesh);
    this.drone = { phase: 'launch', t: 1.1, target, aim: null, mesh, pos: h.pos.clone().setY(1.6), vel: new THREE.Vector3(), props: [0, 1, 2, 3].map(i => mesh.getObjectByName('prop_' + i)).filter(Boolean), pilot: this.pilot(), alt: (MAP.kind === 'rural' ? 18 : 32) + Math.random() * 10, age: 0 };
    if (this.sq.side === 'player') g.hud?.alert(`${this.sq.name}: FPV drone launched at ${target.name || 'infantry'}`);
  }
  // pick the impact point on the target: vehicles — engine deck / turret roof from above; infantry — a man
  aimPoint(t) {
    if (t.type === 'vehicle') {
      const c = Math.cos(t.heading), s = Math.sin(t.heading), r = Math.random();
      const lo = this.drone.aimLocal ||= [(Math.random() - .5) * t.def.width * 0.5, r < 0.55 ? -t.def.length * 0.3 : r < 0.85 ? 0 : (Math.random() - .5) * t.def.length * 0.6];
      const lx = lo[0], lz = lo[1];
      return new THREE.Vector3(t.pos.x + lx * c + lz * s, t.def.height + 0.1, t.pos.z - lx * s + lz * c);
    }
    const men = t.effective.filter(m => !m.inside); const m = men[Math.floor(Math.random() * men.length)] || t.effective[0];
    this.drone.man = m; return m ? m.pos.clone().setY(0.9) : t.center().setY(0.9);
  }
  flyDrone(dt) {
    const d = this.drone, g = this.g, t = d.target;
    d.age += dt;
    if (d.phase === 'launch') { d.t -= dt; if (d.t <= 0) { d.phase = 'climb'; d.mesh.visible = true; d.snd = g.audio.ok ? g.audio.loop('drone_buzz', d.pos, 0.8) : null; } return; }
    for (const p of d.props) p.rotation.y += dt * 90;
    // pilot down or team gone: link lost, the drone drops
    if (!d.pilot.effective && d.phase !== 'fall') { d.phase = 'fall'; }
    if (t.destroyed && d.phase !== 'fall') { // retarget something nearby or ditch
      const alt = g.enemiesOf(this.sq.side).filter(u => !u.destroyed && !(u.type === 'squad' && (u.mounted || u.building)) && g.seen(this.sq.side, u) && (u.type === 'vehicle' ? u.pos : u.center()).distanceTo(d.pos) < 600)
        .sort((a, b) => (b.type === 'vehicle') - (a.type === 'vehicle') || (a.type === 'vehicle' ? a.pos : a.center()).distanceTo(d.pos) - (b.type === 'vehicle' ? b.pos : b.center()).distanceTo(d.pos))[0];
      if (alt) { d.target = alt; d.aim = null; d.aimLocal = null; d.man = null; if (d.phase === 'dive') d.phase = 'cruise'; } else d.phase = 'fall';
    }
    const tgt = d.target;
    let want;
    if (d.phase === 'fall') { d.vel.y -= 9.8 * dt; d.vel.multiplyScalar(0.99); }
    else {
      const tc = tgt.type === 'vehicle' ? tgt.pos : (d.man?.effective ? d.man.pos : tgt.center());
      const hd = Math.hypot(tc.x - d.pos.x, tc.z - d.pos.z);
      // terminal attack: a steep dive (roof / engine deck), only once the drone can see down onto the target
      if (d.phase === 'cruise' && hd < 10 + d.alt * 0.5 && (hd < 9 || !g.nav.occluded(d.pos.x, d.pos.y, d.pos.z, tc.x, 1.5, tc.z, null, tgt.type === 'vehicle' ? tgt : tgt.building))) { d.phase = 'dive'; d.aim = this.aimPoint(tgt); d.miss = Math.random() < (tgt.type === 'vehicle' ? (Math.abs(tgt.speed || 0) > 3 ? 0.28 : 0.12) : 0.18); if (d.miss) d.aim.add(new THREE.Vector3((Math.random() - .5) * 12, 0, (Math.random() - .5) * 12)).setY(0); }
      if (d.phase === 'climb') { want = tmpA.set(0, 9, 0); if (d.pos.y > Math.min(d.alt, 16)) d.phase = 'cruise'; }
      else if (d.phase === 'cruise') { // fly level at altitude; climb over anything tall in the way
        const h = Math.hypot(tc.x - d.pos.x, tc.z - d.pos.z) || 1, vy = THREE.MathUtils.clamp((d.alt - d.pos.y) * 1.2, -5, 9);
        const ax = d.pos.x + (tc.x - d.pos.x) / h * Math.min(h, 30), az = d.pos.z + (tc.z - d.pos.z) / h * Math.min(h, 30);
        const blk = g.nav.occluded(d.pos.x, d.pos.y - 2, d.pos.z, ax, d.pos.y - 2, az, null, tgt.type === 'vehicle' ? tgt : null);
        if (blk && !blk.foliage && !blk.smokeUntil) d.alt = Math.min(60, Math.max(d.alt, blk.h + 6));
        const sp = d.pos.y < d.alt - 6 ? 12 : 30; want = tmpA.set((tc.x - d.pos.x) / h * sp, vy, (tc.z - d.pos.z) / h * sp);
      }
      else { // terminal dive, tracking the target
        if (tgt.type === 'vehicle' && !d.miss) { const p = this.aimPoint(tgt); d.aim.lerp(p, 0.04); }
        else if (d.man?.effective && !d.miss && !d.dodged) d.aim.set(d.man.pos.x, 0.9, d.man.pos.z);
        want = tmpA.subVectors(d.aim, d.pos).normalize().multiplyScalar(34);
      }
      d.vel.lerp(want, Math.min(1, dt * 2.5));
      this.reactions(d, dt);
      if (d.phase === 'fall') return this.moveDrone(d, dt);
    }
    this.moveDrone(d, dt);
  }
  moveDrone(d, dt) {
    const g = this.g;
    d.pos.addScaledVector(d.vel, dt); d.mesh.position.copy(d.pos);
    const v = d.vel.lengthSq() > 0.1 ? d.vel : null; if (v) { d.mesh.lookAt(d.pos.clone().add(v)); d.mesh.rotateX(-0.35); }
    d.snd?.set(d.pos, 0.8);
    const aimD = d.aim ? d.pos.distanceTo(d.aim) : 99;
    if (d.phase === 'dive' && (aimD < 1.4 || d.aim && d.vel.y < 0 && d.pos.y <= d.aim.y + 0.05 && Math.hypot(d.pos.x - d.aim.x, d.pos.z - d.aim.z) < 2.5)) return this.impact(d, d.aim.clone());
    if (d.pos.y <= 0.15 && d.phase !== 'climb') return this.impact(d, d.pos.clone().setY(0.15));
    if (d.age > 70) return this.impact(d, d.pos.clone().setY(0.15));
    const occ = g.nav.occluded(d.pos.x, d.pos.y, d.pos.z, d.pos.x + d.vel.x * dt, d.pos.y + d.vel.y * dt, d.pos.z + d.vel.z * dt, null, d.target);
    if (occ && !occ.foliage && !occ.smokeUntil && d.phase !== 'climb') this.impact(d, d.pos.clone());
  }
  // defenders: men near the drone's path try to shoot it down (hard); the targeted man dives or fires at it
  reactions(d, dt) {
    const g = this.g, enemy = d.target.side;
    for (const sq of g.squads) {
      if (sq.side !== enemy || sq.destroyed || sq.mounted) continue;
      for (const s of sq.effective) {
        if (s.inside === 'btr' || s.inBuilding && Math.random() < 0.5) continue;
        const dist = s.pos.distanceTo(d.pos); if (dist > 110) continue;
        if (dist < 70 && !s.supportClip && !s.inBuilding) {
          s.droneAlertT = 1.5; s.heading = Math.atan2(d.pos.x - s.pos.x, d.pos.z - s.pos.z);
          if (s.weapon.type !== 'at' && Math.random() < dt * 4) { const mz = s.muzzleWorld(tmpB); g.fx.muzzle(mz, tmpA.subVectors(d.pos, mz).normalize(), 0.8); if (g.camDist(mz) < 120) g.sfx(s.weapon.sound === 'mg' ? 'mg_near' : 'rifle_near', s.pos, { gain: 0.7 }); }
        }
        const p = (dist < 35 ? 0.03 : 0.01) * (s.weaponKey === 'pkm' ? 1.6 : 1) * (d.phase === 'dive' ? 1.4 : 1);
        if (Math.random() < p * dt * 4) { if (Math.random() < 0.25) { d.phase = 'fall'; d.vel.multiplyScalar(0.4); d.vel.y = 2; if (sq.side === 'player') g.hud?.alert(`${sq.name} shot down an FPV drone`, 'good'); else if (this.sq.side === 'player') g.hud?.alert(`${this.sq.name}: drone shot down`, 'bad'); return; } }
      }
    }
    // the targeted soldier sees it coming in the last seconds
    if (d.phase === 'dive' && d.man && d.man.effective && !d.reacted && d.pos.distanceTo(d.aim) < 22) {
      d.reacted = true; const m = d.man;
      if (Math.random() < 0.55) { m.dodgeT = 1.2; m.stance = 'prone'; const side = Math.random() < 0.5 ? 1 : -1, h = m.heading + side * Math.PI / 2;
        const nx = m.pos.x + Math.sin(h) * 2.2, nz = m.pos.z + Math.cos(h) * 2.2, i = g.nav.idx(nx, nz); if (i >= 0 && g.nav.passable(i, 0.3)) { m.path = null; (this.dodgers ||= []).push({ m, x: nx, z: nz, t: 0.45 }); }
        if (Math.random() < 0.22) d.dodged = true; }
      else { m.droneAlertT = 2; if (Math.random() < 0.08) { d.phase = 'fall'; d.vel.y = 3; } }
    }
  }
  impact(d, at) {
    const g = this.g; this.drone = null;
    g.scene.remove(d.mesh); d.snd?.stop();
    const t = d.target;
    (g.supportLog ||= []).push(`${Math.round(g.time)} ${this.sq.side[0]} FPV ${d.phase} y${at.y.toFixed(1)} d${Math.round(at.distanceTo(t.type === 'vehicle' ? t.pos : t.center()))} ${t.type === 'vehicle' ? t.kind : 'inf'}${d.miss ? ' miss' : ''}${d.dodged ? ' dodged' : ''}${t.cage ? ' cage' : ''}`);
    if (d.phase === 'dive' && t.type === 'vehicle' && !t.destroyed && !d.miss && at.distanceTo(t.pos) < t.def.length * 0.7) {
      const from = at.clone().addScaledVector(d.vel.clone().normalize(), -4);
      if (t.cage && Math.random() < t.cage) { // anti-drone cage: warhead goes off on the screen
        g.combat.hitVehicle(t, { ...this.W, pen: this.W.pen * 0.12, dmg: [20, 50] }, from, 'ce', d.pilot, false, at);
        if (t.side === 'player') g.hud?.alert(`${t.name}: FPV drone stopped by the cage`, '');
      } else g.combat.hitVehicle(t, this.W, from, 'ce', d.pilot, false, at);
      g.fx.explosion(at, 0.6); g.sfx('explosion_small', at);
    } else g.combat.explode(at, 0.55, d.pilot, [60, 170], 5.5);
  }
}
