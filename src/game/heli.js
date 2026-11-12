import * as THREE from 'three';

// Mi-24 strike (a Command Influence request in the campaign; `?hind=N` in a skirmish): one helicopter comes in low from the
// caller's own side, ripples its S-8 rockets into the target area, breaks away throwing flares and goes home. It is a real
// object over the battlefield the whole time, and it can be shot down:
//   * every enemy vehicle with an autocannon or heavy machine gun inside its reach fires at it, machine-gunners and riflemen
//     do when it passes close (tracers go up; a hit takes a bite out of its 1,000 points - the Mi-24's cabin and cockpit
//     are armoured against 12.7 mm, its engines, gearbox and tail are not)
//   * if the enemy still has infantry on the field there is a chance of a shoulder-launched missile on the way out; the
//     flares decoy about half of them
//   * hurt badly it breaks off early trailing smoke; at zero it goes down - tail rotor gone (it spins as it sinks), engines
//     dead (it falls nose-low), or burning - with what speed it had, hits the ground, blows up, sheds its blades and stays
//     there burning as a wreck. Whoever is under it gets the blast. The loss is reported to the campaign (LP penalty).
// The numbers: 58 m/s (210 km/h) at 35-45 m over the ground on the run-in, firing between 750 m and 380 m from the target,
// 20 rockets (one pod pair) in 1.5 s, sheaf about 55 m long and 25 m wide; S-8KOM warhead (3.6 kg, 0.9 kg HE) as a burst a
// little bigger than an 82 mm mortar bomb's.
// Not synchronised in multiplayer battles (not offered there).

const V3 = () => new THREE.Vector3();
const _a = V3(), _b = V3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
export const HELI = { hp: 1000, speed: 58, alt: 40, fireFrom: 750, fireTo: 380, rockets: 20, manpads: 0.14, flareDecoy: 0.55 };
const G = 9.81;

export class HeliSupport {
  constructor(game) {
    this.g = game; this.left = { player: 0, enemy: 0 }; this.active = []; this.wrecks = []; this.rockets = []; this.flares = []; this.lost = { player: 0, enemy: 0 }; this.sent = { player: 0, enemy: 0 };
    let n = 0; try { const q = new URLSearchParams(location.search).get('hind'); n = q === '' ? 1 : +q || 0; } catch { /* */ }
    if (n && !game.campaign && !game.opts?.net) { this.left.player = n; this.left.enemy = Math.max(1, Math.round(n / 2)); }
  }
  get ok() { return !!this.g.assets?.gltf?.mi24 && !this.g.opts?.net; }
  count(side = 'player') { return this.ok ? this.left[side] : 0; }
  // ------------------------------------------------------------------ call
  call(side, x, z) {
    const g = this.g; if (!this.ok || this.left[side] <= 0 || g.phase === 'deploy') return false;
    this.left[side]--; this.sent[side]++;
    // from the caller's own edge of the map, a little off the straight line; 1.4 km out so it is heard before it is over
    const H = g.medevac?.homeOf?.(side), hx = H ? H.x : 0, hz = H ? H.z : (side === 'player' ? 600 : -600);
    let dx = hx - x, dz = hz - z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    const off = (Math.random() - 0.5) * 0.5, c = Math.cos(off), s = Math.sin(off), ax = dx * c - dz * s, az = dx * s + dz * c, D = 1400;
    const h = { side, faction: side === 'player' ? g.playerFaction : g.enemyFaction, hp: HELI.hp, state: 'ingress', t: 0, target: V3().set(x, 0, z),
      pos: V3().set(x + ax * D, 0, z + az * D), heading: Math.atan2(-ax, -az), speed: HELI.speed, vy: 0, roll: 0, pitch: -0.1, rockets: HELI.rockets, fireAcc: 0, rpm: 1,
      turn: Math.random() < 0.5 ? 1 : -1, turned: 0, flareT: 0, aaT: 0, manpads: null, smoke: 0, home: V3().set(x + ax * D, 0, z + az * D), yawV: 0, rollV: 0, pitchV: 0 };
    h.pos.y = this.ground(h.pos.x, h.pos.z) + HELI.alt;
    this.build(h); this.active.push(h);
    h.snd = g.audio?.loop?.('tank_engine_drive_fast', h.pos, 1.6) || null;
    if (side === 'player') { g.hud?.alert('Mi-24 inbound: rocket run on the marked area, keep your men 100 m clear', 'good'); g.sfx('radio'); g.mortarMarker?.(x, z); }
    else if (g.hud) g.hud.alert('Enemy helicopter inbound!', 'bad');
    return true;
  }
  ground(x, z) { return this.g.city.groundHeight?.(x, z) ?? 0; }
  build(h) {
    const g = this.g, src = g.assets.gltf.mi24.scene, m = h.model = src.clone(true);
    m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } if (/_wreck$/i.test(o.name) || /_LOD1$/i.test(o.name)) o.visible = false; });
    h.rotor = m.getObjectByName('rotor_main'); h.tail = m.getObjectByName('rotor_tail'); h.wreck = m.getObjectByName('hull_wreck');
    const ua = h.faction?.id !== 'RU';
    for (const [n, c] of [['id_band_a', ua ? 0xf2c81a : 0xeeeeea], ['id_band_b', ua ? 0x2f62b4 : 0xeeeeea]]) { const o = m.getObjectByName(n); if (o?.material) { o.material = o.material.clone(); o.material.color.setHex(c); } }
    // the turning rotor: a faint disc over the blades (five blades at 240 rpm strobe on their own)
    if (h.rotor) { const d = new THREE.Mesh(new THREE.CircleGeometry(8.65, 40), new THREE.MeshBasicMaterial({ color: 0x15140f, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide })); d.rotation.x = -Math.PI / 2; d.position.y = 0.02; h.rotor.add(d); h.disc = d; }
    h.root = new THREE.Group(); h.root.add(m); g.scene.add(h.root);
    h.pods = ['rocket_L1', 'rocket_R1', 'rocket_L2', 'rocket_R2'].map(n => m.getObjectByName(n)).filter(Boolean);
    h.flareN = ['flare_L', 'flare_R'].map(n => m.getObjectByName(n)).filter(Boolean);
    h.exh = ['exhaust_L', 'exhaust_R'].map(n => m.getObjectByName(n)).filter(Boolean);
  }
  // ------------------------------------------------------------------ frame
  // the enemy's strike: once the battle has gone on a while, on the player's unit with the most of his others round it
  enemyCall(dt) {
    const g = this.g; if (this.left.enemy <= 0 || g.phase === 'deploy' || this.active.some(h => h.side === 'enemy')) return;
    this.eT = (this.eT ?? 150 + Math.random() * 150) - dt; if (this.eT > 0) return; this.eT = 200 + Math.random() * 160;
    const U = [...g.vehicles.filter(v => v.side === 'player' && !v.destroyed), ...g.squads.filter(q => q.side === 'player' && !q.destroyed && !q.mounted && !q.building && q.soldiers[0])].map(u => u.type === 'squad' ? u.center() : u.pos);
    if (!U.length) return; let best = U[0], bn = -1;
    for (const p of U) { const n = U.filter(q => q.distanceTo(p) < 45).length + Math.random(); if (n > bn) { bn = n; best = p; } }
    this.call('enemy', best.x, best.z);
  }
  update(dt) {
    this.enemyCall(dt);
    if (!this.active.length && !this.rockets.length && !this.flares.length && !this.wrecks.length) return;
    const g = this.g;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const h = this.active[i]; h.t += dt;
      if (h.state === 'falling') this.fall(h, dt); else this.fly(h, dt);
      if (h.gone) { this.active.splice(i, 1); continue; }
      h.root.position.copy(h.pos); h.root.rotation.set(0, 0, 0);
      h.root.quaternion.setFromEuler(_e.set(h.pitch, h.heading, h.roll, 'YXZ'));
      if (h.rotor) h.rotor.rotation.y += 25 * h.rpm * dt;
      if (h.tail) h.tail.rotation.x += 110 * h.rpm * dt;
      if (h.disc) h.disc.material.opacity = 0.07 * Math.max(0, h.rpm * 1.4 - 0.4);
      h.snd?.set(h.pos, 1.6 * (0.4 + 0.6 * h.rpm), 1.25 + 0.5 * h.rpm);
      if (h.smoke > 0 && (h.smokeAcc = (h.smokeAcc || 0) + dt) > 0.04) { h.smokeAcc = 0; const e = h.exh[0]?.getWorldPosition(_a) || h.pos; g.fx.smoke.spawn({ x: e.x, y: e.y, z: e.z, vy: 0.6, life: 3.5 + Math.random() * 2, size0: 1.2, size1: 6 + h.smoke * 5, r: 0.09, g: 0.085, b: 0.08, a0: 0.5 + 0.3 * h.smoke, a1: 0 }); if (h.fire) g.fx.glow.spawn({ x: e.x, y: e.y, z: e.z, life: 0.12, size0: 2.2, size1: 0.6, r: 1, g: 0.6, b: 0.2, a0: 2.2, a1: 0 }); }
    }
    this.flyRockets(dt); this.flyFlares(dt);
  }
  fly(h, dt) {
    const g = this.g, T = h.target, dx = T.x - h.pos.x, dz = T.z - h.pos.z, d = Math.hypot(dx, dz);
    let want = h.heading, bank = 0;
    if (h.state === 'ingress' || h.state === 'attack') {
      want = Math.atan2(dx, dz);
      if (h.state === 'ingress' && d < HELI.fireFrom) { h.state = 'attack'; if (h.side !== 'player' && g.hud) g.hud.alert('Enemy helicopter firing rockets!', 'bad'); }
      if (h.state === 'attack') {
        h.fireAcc += dt;
        while (h.rockets > 0 && h.fireAcc >= 0.075) { h.fireAcc -= 0.075; this.fireRocket(h); }
        if (d < HELI.fireTo || h.rockets <= 0 && h.fireAcc > 0.4) { h.state = 'break'; h.flareT = 0; }
      }
    } else if (h.state === 'break') {
      const rate = 0.42 * h.turn; h.heading += rate * dt; h.turned += Math.abs(rate) * dt; bank = -0.75 * h.turn;
      h.flareT -= dt; if (h.flareT <= 0) { h.flareT = 0.22; this.flare(h); }
      if (h.turned > 2.6) h.state = 'egress';
      want = h.heading;
    } else if (h.state === 'egress') {
      want = Math.atan2(h.home.x - h.pos.x, h.home.z - h.pos.z);
      if (h.t < 400 && h.flareT > -3) { h.flareT -= dt; if (h.flareT <= -0.6 - Math.random() * 0.4 && h.turned < 9) { h.flareT = 0; h.turned += 0.5; this.flare(h); } }
      if (Math.hypot(h.home.x - h.pos.x, h.home.z - h.pos.z) < 120) { this.remove(h); return; }
    }
    if (h.state !== 'break') { let dh = want - h.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); const r = THREE.MathUtils.clamp(dh * 1.2, -0.35, 0.35); h.heading += r * dt; bank = -r * 1.6; }
    h.roll += (bank - h.roll) * Math.min(1, dt * 2.2);
    const pt = h.state === 'attack' ? -0.16 : h.state === 'break' ? 0.1 : -0.08; h.pitch += (pt - h.pitch) * Math.min(1, dt * 1.5);
    h.pos.x += Math.sin(h.heading) * h.speed * dt; h.pos.z += Math.cos(h.heading) * h.speed * dt;
    const alt = this.ground(h.pos.x, h.pos.z) + (h.state === 'break' || h.state === 'egress' ? HELI.alt + 14 : HELI.alt) + Math.sin(h.t * 0.9) * 1.5;
    h.pos.y += THREE.MathUtils.clamp(alt - h.pos.y, -9 * dt, 9 * dt);
    this.groundFire(h, dt);
    if (h.hp <= 0) return this.shootDown(h);
    if (h.hp < HELI.hp * 0.45 && (h.state === 'ingress' || h.state === 'attack')) { h.state = 'egress'; h.smoke = Math.max(h.smoke, 0.5); if (h.side === 'player') g.hud?.alert('Mi-24 hit and breaking off!', 'bad'); }
  }
  // ---------------------------------------------------------------- weapons
  fireRocket(h) {
    const g = this.g, k = HELI.rockets - h.rockets, pod = h.pods[k % Math.max(1, h.pods.length)]; h.rockets--;
    const from = pod ? pod.getWorldPosition(V3()) : h.pos.clone();
    // the sheaf walks along the run through the aim point: long axis ~55 m, 25 m wide
    const fx = Math.sin(h.heading), fz = Math.cos(h.heading), along = (k / (HELI.rockets - 1) - 0.5) * 55 + (Math.random() - 0.5) * 14, across = (Math.random() + Math.random() - 1) * 12.5;
    const to = V3().set(h.target.x + fx * along + fz * across, 0, h.target.z + fz * along - fx * across); to.y = this.ground(to.x, to.z);
    const dir = to.clone().sub(from).normalize();
    this.rockets.push({ pos: from, dir, to, side: h.side, age: 0, speed: 180 });
    g.fx.glow.spawn({ x: from.x, y: from.y, z: from.z, life: 0.09, size0: 2.2, size1: 0.8, r: 1, g: 0.75, b: 0.4, a0: 2.5, a1: 0 });
    if (k % 3 === 0) g.sfx('rpg_launch', from, { gain: 0.9 });
  }
  flyRockets(dt) {
    const g = this.g;
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i]; r.age += dt; r.speed = Math.min(520, r.speed + 900 * dt);
      const step = r.speed * dt, left = r.pos.distanceTo(r.to), n = Math.max(1, Math.ceil(Math.min(step, left) / 1.7));
      /* a continuous grey trail (motor burns ~1.1 s: thick at first, then the thin smoke of the coasting rocket) */
      for (let k = 0; k < n; k++) { const f = (k + 1) / n * Math.min(step, left), th = r.age < 1.1 ? 1 : 0.45; g.fx.smoke.spawn({ x: r.pos.x + r.dir.x * f, y: r.pos.y + r.dir.y * f, z: r.pos.z + r.dir.z * f, vy: 0.25, life: 2.6 + Math.random() * 1.4, size0: 0.9 * th, size1: 3.4 * th, r: 0.5, g: 0.49, b: 0.47, a0: 0.5 * th, a1: 0 }); }
      if (r.age < 1.1) g.fx.glow.spawn({ x: r.pos.x, y: r.pos.y, z: r.pos.z, life: 0.05, size0: 1.1, size1: 0.4, r: 1, g: 0.8, b: 0.45, a0: 3, a1: 0 });
      // a building in the way takes it
      const nx = r.pos.x + r.dir.x * step, ny = r.pos.y + r.dir.y * step, nz = r.pos.z + r.dir.z * step;
      const occ = r.age > 0.2 ? g.nav.occluded?.(r.pos.x, r.pos.y, r.pos.z, nx, ny, nz, null, null) : null;
      if (step >= left || (occ && !occ.foliage && !occ.smokeUntil)) {
        const at = step >= left ? r.to.clone().setY(r.to.y + 0.15) : V3().set(nx, ny, nz);
        this.rockets.splice(i, 1);
        g.combat.blastSide = r.side; g.combat.explode(at, 1.5, null, [90, 250], 9); g.combat.blastSide = null;
        for (const v of g.vehicles) { if (v.destroyed) continue; const dv = v.pos.distanceTo(at); if (dv < 4.5) { v.hp -= (4.5 - dv) * (v.kind === 'tank' ? 55 : 150); if (v.hp <= 0) v.knockOut(false); } }
        continue;
      }
      r.pos.set(nx, ny, nz);
    }
  }
  flare(h) {
    const g = this.g;
    for (const n of h.flareN.length ? h.flareN : [null]) {
      const p = n ? n.getWorldPosition(V3()) : h.pos.clone(), sd = n?.name.endsWith('L') ? 1 : -1, c = Math.cos(h.heading), s = Math.sin(h.heading);
      this.flares.push({ pos: p, vel: V3().set(c * sd * 14 + s * h.speed * 0.5, -3, -s * sd * 14 + c * h.speed * 0.5), age: 0, life: 3.2 + Math.random() });
    }
    g.sfx('grenade_throw', h.pos, { gain: 0.5 });
  }
  flyFlares(dt) {
    const g = this.g;
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i]; f.age += dt; f.vel.y -= 5 * dt; f.vel.multiplyScalar(1 - 0.9 * dt); f.pos.addScaledVector(f.vel, dt);
      const k = 1 - f.age / f.life;
      g.fx.glow.spawn({ x: f.pos.x, y: f.pos.y, z: f.pos.z, life: 0.07, size0: 3.2 * k + 0.8, size1: 1, r: 1, g: 0.86, b: 0.6, a0: 4 * k, a1: 0 });
      if (Math.random() < dt * 22) g.fx.smoke.spawn({ x: f.pos.x, y: f.pos.y, z: f.pos.z, vy: 0.4, life: 2.5, size0: 0.4, size1: 2.2, r: 0.8, g: 0.8, b: 0.78, a0: 0.3, a1: 0 });
      if (f.age > f.life || f.pos.y < this.ground(f.pos.x, f.pos.z)) this.flares.splice(i, 1);
    }
  }
  // ---------------------------------------------------------------- being shot at
  groundFire(h, dt) {
    const g = this.g; h.aaT -= dt;
    if (h.aaT <= 0) {
      h.aaT = 0.25; h.shooters = [];
      for (const v of g.vehicles) {
        if (v.side === h.side || v.destroyed || v.abandoned || v.gunDisabled || (v.crew ?? 3) < 2) continue;
        const d = v.pos.distanceTo(h.pos), ac = v.kind === 'ifv' || (v.kind === 'btr' && v.faction?.id === 'RU'), hm = v.kind === 'btr' || v.kind === 'tank';
        if (ac && d < 1500) h.shooters.push({ u: v, w: 1.0 * (1 - d / 1700), dmg: [60, 130], key: 'cannon30', col: [1, 0.6, 0.3] });
        else if (hm && d < 900) h.shooters.push({ u: v, w: 0.55 * (1 - d / 1000), dmg: [30, 60], key: 'hmg', col: [1, 0.55, 0.25] });
      }
      let inf = 0;
      for (const sq of g.squads) {
        if (sq.side === h.side || sq.destroyed || sq.mounted || sq.medevac) continue; inf++;
        const c = sq.center?.() || sq.soldiers[0]?.pos; if (!c) continue; const d = c.distanceTo(h.pos); if (d > 520) continue;
        const n = sq.effective?.length || 0; if (n) h.shooters.push({ u: sq, pos: c, w: 0.05 * n * (1 - d / 560), dmg: [6, 14], key: 'mg_near', col: [1, 0.7, 0.4] });
      }
      // one shoulder-launched missile, at most, as it turns away over them
      if (!h.manpadsTried && inf > 0 && (h.state === 'break' || h.state === 'egress')) { h.manpadsTried = true; if (Math.random() < HELI.manpads * Math.min(1, inf / 3)) h.manpads = { t: 1.2 + Math.random() * 2.5 }; }
    }
    for (const s of h.shooters || []) {
      if (Math.random() < dt * 2.2) {   // tracers up at it
        const p = s.pos || s.u.pos; _a.set(p.x, (p.y || 0) + 2, p.z); _b.copy(h.pos).add(V3().set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14));
        g.fx.tracer(_a.clone(), _b.clone(), 800, s.col); if (Math.random() < 0.5) g.sfx(s.key, _a);
      }
      if (Math.random() < s.w * dt * 0.55) { h.hp -= s.dmg[0] + Math.random() * (s.dmg[1] - s.dmg[0]); g.fx.impact?.(h.pos, 'metal', 2); h.smoke = Math.max(h.smoke, 1 - h.hp / HELI.hp - 0.35); }
    }
    if (h.manpads) {
      const M = h.manpads; M.t -= dt;
      if (M.t <= 0 && !M.pos) { const sq = g.squads.find(q => q.side !== h.side && !q.destroyed && !q.mounted && q.soldiers[0]); if (!sq) { h.manpads = null; return; } M.pos = sq.center().clone().setY(1.6); M.age = 0; g.sfx('rpg_launch', M.pos, { gain: 1.2 }); if (h.side === 'player') g.hud?.alert('Missile launch! MANPADS on the Mi-24', 'bad'); M.decoy = Math.random() < HELI.flareDecoy ? (this.flares[this.flares.length - 1] || null) : null; }
      if (M.pos) {
        M.age += dt; const tgt = M.decoy && this.flares.includes(M.decoy) ? M.decoy.pos : (M.decoy ? null : h.pos), sp = Math.min(520, 120 + M.age * 420);
        if (!tgt) { M.pos.y += sp * dt * 0.3; M.pos.x += Math.sin(h.heading + 1) * sp * dt; M.pos.z += Math.cos(h.heading + 1) * sp * dt; if (M.age > 4) { g.fx.explosion(M.pos, 0.5, { air: true }); h.manpads = null; } }
        else { const dir = _a.copy(tgt).sub(M.pos), d = dir.length(); dir.normalize(); const st = sp * dt; if (d <= st + 3) { g.fx.explosion(M.pos.copy(tgt), 0.7, { air: true }); g.sfx('explosion_medium', M.pos); if (!M.decoy) { h.hp -= 650 + Math.random() * 500; h.fire = true; h.smoke = 1; } h.manpads = null; return; } M.pos.addScaledVector(dir, st); }
        g.fx.smoke.spawn({ x: M.pos.x, y: M.pos.y, z: M.pos.z, vy: 0.2, life: 3, size0: 0.4, size1: 2.4, r: 0.85, g: 0.85, b: 0.83, a0: 0.5, a1: 0 });
        g.fx.glow.spawn({ x: M.pos.x, y: M.pos.y, z: M.pos.z, life: 0.06, size0: 1.2, size1: 0.4, r: 1, g: 0.85, b: 0.6, a0: 3, a1: 0 });
      }
    }
  }
  // ---------------------------------------------------------------- going down
  shootDown(h) {
    const g = this.g; h.state = 'falling'; h.t = 0; h.smoke = 1; this.lost[h.side]++;
    h.mode = h.fire || Math.random() < 0.3 ? 'fire' : Math.random() < 0.55 ? 'tail' : 'engine'; h.fire = h.fire || h.mode === 'fire';
    h.vel = V3().set(Math.sin(h.heading) * h.speed, 0, Math.cos(h.heading) * h.speed);
    h.yawV = h.mode === 'tail' ? 0.4 * h.turn : (Math.random() - 0.5) * 0.3; h.rollV = (Math.random() - 0.5) * 0.5; h.pitchV = h.mode === 'tail' ? 0 : -0.12;
    g.fx.explosion(h.pos, 0.8, { air: true }); g.sfx('explosion_medium', h.pos);
    if (g.hud) g.hud.alert(h.side === 'player' ? 'Mi-24 shot down!' : 'Enemy Mi-24 shot down!', h.side === 'player' ? 'bad' : 'good');
    (g.supportLog ||= []).push(`${Math.round(g.time)} ${h.side[0]} HELI down (${h.mode})`);
  }
  fall(h, dt) {
    const g = this.g;
    // lift goes with the rotor: a tail-rotor loss keeps the main rotor turning (it sinks and spins), dead engines autorotate
    // badly this low, a burning one just falls
    const lift = h.mode === 'tail' ? Math.max(0.55, 0.9 - h.t * 0.08) : h.mode === 'engine' ? Math.max(0.35, 0.8 - h.t * 0.18) : Math.max(0.1, 0.6 - h.t * 0.3);
    h.rpm = Math.max(0.15, h.mode === 'tail' ? 1 - h.t * 0.04 : 1 - h.t * 0.22);
    h.vel.y -= G * (1 - lift) * dt; h.vel.x *= 1 - 0.25 * dt; h.vel.z *= 1 - 0.25 * dt;
    if (h.mode === 'tail') h.yawV = THREE.MathUtils.clamp(h.yawV + 1.1 * h.turn * dt, -4.2, 4.2);
    h.heading += h.yawV * dt; h.roll += h.rollV * dt; h.pitch += h.pitchV * dt;
    h.rollV += (Math.sin(h.t * 2.1) * 0.5 - h.roll * 0.6) * dt * (h.mode === 'tail' ? 1 : 0.4); h.pitchV += (h.mode === 'tail' ? (-0.1 - h.pitch) * 0.8 : -0.25) * dt;
    h.pitch = THREE.MathUtils.clamp(h.pitch, -1.1, 0.5); h.roll = THREE.MathUtils.clamp(h.roll, -1.2, 1.2);
    h.pos.addScaledVector(h.vel, dt);
    const gy = this.ground(h.pos.x, h.pos.z);
    if (h.pos.y - 0.9 <= gy) this.crash(h, gy);
  }
  crash(h, gy) {
    const g = this.g, at = V3().set(h.pos.x, gy + 0.6, h.pos.z), sp = h.vel.length();
    g.fx.explosion(at, 2.4); g.sfx('explosion_large', at); g.fx.light(at, 0xffa050, 90, 40, 0.3);
    g.combat.blastSide = null; g.combat.explode(at, 2.4, null, [140, 380], 13);
    for (const v of g.vehicles) { if (v.destroyed) continue; const d = v.pos.distanceTo(at); if (d < 7) { v.hp -= (7 - d) * 120; if (v.hp <= 0) v.knockOut(false); } }
    // blades and panels thrown off
    for (let k = 0; k < 14; k++) { const a = Math.random() * 6.283, s = 6 + Math.random() * 14 + sp * 0.2; g.fx.fragment?.('shard', at.x, at.y + 1, at.z, Math.cos(a) * s + h.vel.x * 0.3, 4 + Math.random() * 9, Math.sin(a) * s + h.vel.z * 0.3, 0.5 + Math.random() * 0.9); }
    // the wreck: where it stopped, canted, burning for the rest of the battle
    h.model.traverse(o => { if (o.isMesh) o.visible = false; });
    if (h.wreck) { h.wreck.visible = true; h.wreck.traverse(o => { if (o.isMesh) o.visible = true; }); }
    h.pos.y = gy - 0.45; h.root.position.copy(h.pos);
    h.root.quaternion.setFromEuler(_e.set(THREE.MathUtils.clamp(h.pitch, -0.25, 0.12), h.heading, THREE.MathUtils.clamp(h.roll, -0.5, 0.5) || 0.25, 'YXZ'));
    g.fx.vehFire?.(at.clone().setY(gy + 1.2), 1.6); g.fx.emitter?.(at.clone().setY(gy + 1.5), 'plume', 1.6, Infinity);
    h.snd?.stop?.(); h.snd = null; h.gone = true; this.wrecks.push(h);
    const TL = g.tickets && (h.side === 'player' ? 'player' : 'enemy'); if (TL && g.tickets[TL] != null) g.tickets[TL] = Math.max(0, g.tickets[TL] - 25);
  }
  remove(h) { h.snd?.stop?.(); this.g.scene.remove(h.root); h.gone = true; }
}
