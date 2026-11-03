import * as THREE from 'three';
import * as Fallback from '../engine/fallback.js';
import { VEHICLES, WEAPONS, TUNING } from '../config.js';
import { angDiff, Squad } from './squad.js';
import { initArmor } from './armor.js';
import { hasClip } from './soldier.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CREW_ROLES } from '../config.js';
import { SpgMixin } from './artillery.js';
import { applyVehicleKits } from './vehicleKit.js';

let NEXT = 1000;
const tmp = new THREE.Vector3();

// Burnt-out look for wrecks: paint burnt off to charcoal and grey-white ash, heat-blued steel, only faint rust,
// glowing embers while the fire is still going. Applied on top of whatever the wreck texture is.
export function charMaterial(m, emberUniform = { value: 0 }) {
  if (!m || m.userData?.charred) return m;
  const n = m.clone(); n.userData = { charred: true }; n.roughness = 0.95; n.metalness = 0.12; if (n.color) n.color.setRGB(1, 1, 1);
  n.emissive = new THREE.Color(0xff5a1a); n.emissiveIntensity = 1;
  n.onBeforeCompile = sh => {
    sh.uniforms.uEmber = emberUniform;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCharP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvCharP = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vCharP; uniform float uEmber;
      float ch(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      float cn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(ch(i), ch(i+vec3(1,0,0)), f.x), mix(ch(i+vec3(0,1,0)), ch(i+vec3(1,1,0)), f.x), f.y),
                   mix(mix(ch(i+vec3(0,0,1)), ch(i+vec3(1,0,1)), f.x), mix(ch(i+vec3(0,1,1)), ch(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
        float n1 = cn(vCharP * 2.2) * 0.65 + cn(vCharP * 7.0) * 0.35, n2 = cn(vCharP * 1.3 + 17.0), n3 = cn(vCharP * 9.0 + 5.0);
        vec3 soot = vec3(0.05, 0.047, 0.044) * (0.7 + lum * 0.8);
        vec3 ash = vec3(0.46, 0.45, 0.43) * (0.75 + 0.25 * n3);
        vec3 steel = vec3(0.17, 0.18, 0.21);
        vec3 rust = vec3(0.23, 0.12, 0.06);
        vec3 c = soot;
        c = mix(c, ash, smoothstep(0.6, 0.78, n1) * 0.85);
        c = mix(c, steel, smoothstep(0.68, 0.82, n2) * 0.6);
        c = mix(c, rust, smoothstep(0.82, 0.92, n3) * 0.35);
        diffuseColor.rgb = c;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= uEmber * smoothstep(0.78, 0.92, cn(vCharP * 4.0 + 3.0)) * (0.6 + 0.4 * sin(vCharP.x * 13.0 + vCharP.z * 7.0));`);
  };
  n.customProgramCacheKey = () => 'charred';
  return n;
}
export function charObject(o, u) { const cache = new Map(), f = m => cache.get(m) || cache.set(m, charMaterial(m, u)).get(m); o.traverse(x => { if (x.isMesh) x.material = Array.isArray(x.material) ? x.material.map(f) : f(x.material); }); }

export class Vehicle {
  constructor(game, side, faction, kind) {
    this.game = game; this.id = NEXT++; this.side = side; this.faction = faction; this.kind = kind; this.type = 'vehicle';
    this.def = VEHICLES[kind === 'ifv' || kind === 'spg' ? `${kind}_${faction.id.toLowerCase()}` : kind];
    this.name = kind === 'btr' ? faction.btrName : kind === 'ifv' ? faction.ifvName : kind === 'spg' ? faction.spgName : faction.tankName;
    this.hp = this.def.hp; this.pos = new THREE.Vector3(); this.heading = 0; this.speed = 0; this.path = null; this.pathI = 0;
    this.turretYaw = 0; this.gunPitch = 0; this.target = null; this.coaxTarget = null;
    this.destroyed = false; this.immobile = false; this.gunDisabled = false; this.burning = 0; this.crew = 3;
    this.passengers = null; this.selected = false; this.spotted = side === 'player'; this.morale = 100;
    this.holdFire = false; this.stats = { kills: 0 };
    this.weapons = kind === 'spg'
      ? [{ key: this.def.gun, ammo: this.def.ammo, cd: 0 }, { key: this.def.mg || 'pkt', ammo: this.def.mg ? 300 : 0, cd: 0, burst: 0, coax: true }]
      : kind === 'ifv'
      ? [{ key: this.def.main, ammo: this.def.mainAmmo, cd: 0, burst: 0 }, { key: 'pkt', ammo: 2200, cd: 0, burst: 0, coax: true }]
      : kind === 'btr'
      ? [{ key: faction.id === 'RU' ? 'a72' : 'kpvt', ammo: 0, cd: 0, burst: 0 }, { key: 'pkt', ammo: 2000, cd: 0, burst: 0, coax: true }]
      : [{ key: 'a46', ammo: 39, ap: 15, he: 24, cd: 0, loaded: true }, { key: 'pkt', ammo: 2000, cd: 0, burst: 0, coax: true }];
    if (kind === 'btr') this.weapons[0].ammo = WEAPONS[this.weapons[0].key].mag;
    if (kind === 'ifv') { this.atgm = { key: this.def.atgm, ammo: this.def.atgmAmmo, cd: 0 }; if (this.def.gun100) this.gun100 = { ammo: this.def.gun100, cd: 0 }; }
    this.supply = this.def.supply ? { ...this.def.supply } : null;
    this.build();
    // anti-drone "cope cage" over the turret: most tanks by 2024, some BTRs. Sets off a share of FPV warheads early.
    // the tank models already carry their anti-drone screen; BTRs get a welded cage on some vehicles
    if (kind === 'tank') this.cage = 0.55;
    else if (kind === 'btr' && !this.fallback && this.turret && Math.random() < 0.35) this.addCage();
    this.immob = {}; initArmor(this);
    applyVehicleKits(this);   // campaign tech-tree upgrades (cope cage, ERA, ...) on vehicles spawned mid-battle; deployCampaign's are fitted in applyMods
    if (kind === 'spg') { this.spgInit(); if (this.crewList && this.def.crew > 3) this.crewList.push({ role: 'loader', hp: 100 }, { role: 'loader', hp: 100 }); this.crew = this.crewList?.length ?? 3; }
    this.thinkT = Math.random();
  }
  get alive() { return !this.destroyed; }
  get effective() { return !this.destroyed; }
  center(out = new THREE.Vector3()) { return out.copy(this.pos); }
  ammoFrac() { const w = this.weapons[0]; return w.ammo / (this.kind === 'tank' ? 39 : this.kind === 'ifv' ? this.def.mainAmmo : this.kind === 'spg' ? this.def.ammo : WEAPONS[w.key].mag); }
  moraleState() { return this.destroyed ? 'DESTROYED' : this.burning ? 'ON FIRE' : this.immobile ? 'IMMOBILISED' : this.gunDisabled ? 'GUN DAMAGED' : this.crew < (this.def.crew || 3) ? 'CREW HIT' : this.kind === 'spg' ? this.spgStatus() : 'OPERATIONAL'; }
  build() {
    const A = this.game.assets, key = this.kind === 'btr' ? this.faction.btrAsset : this.kind === 'ifv' ? this.faction.ifvAsset : this.kind === 'spg' ? this.faction.spgAsset : this.faction.tankAsset, g = A.gltf[key];
    this.assetKey = key; this.vman = A.manifest?.vehicles?.vehicles?.[key] || {};
    const root = this.root = new THREE.Group();
    if (g) { this.model = g.scene.clone(true); }
    else { this.model = Fallback.vehicle(this.kind, this.faction.id === 'RU' ? 0x4c5338 : 0x4f5536); this.fallback = true; }
    root.add(this.model);
    const N = n => this.model.getObjectByName(n);
    this.hull = N('hull') || this.model; this.turret = N('turret'); this.gun = N('gun_pivot'); this.muzzle = N('muzzle'); this.coax = N('coax_muzzle') || this.muzzle;
    this.exhaustN = N('exhaust');
    this.wheels = []; this.roadwheels = []; this.trackMats = [];
    this.model.traverse(o => {
      if (/^(wheel_|roadwheel_|sprocket_|idler_)/i.test(o.name)) (o.name.startsWith('wheel') ? this.wheels : this.roadwheels).push(o);
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach((m, i) => { if (/track/i.test(m.name) && m.map) { const c = m.clone(); c.map = m.map.clone(); c.map.wrapS = THREE.RepeatWrapping; if (c.normalMap) { c.normalMap = m.normalMap.clone(); c.normalMap.wrapS = THREE.RepeatWrapping; } if (c.alphaMap) { c.alphaMap = m.alphaMap.clone(); c.alphaMap.wrapS = THREE.RepeatWrapping; } if (Array.isArray(o.material)) o.material[i] = c; else o.material = c; this.trackMats.push(c); } });
      }
      if (o.userData?.hidden) o.visible = false;
      if (/_wreck$/i.test(o.name)) { o.visible = false; (this.wreckParts ||= []).push(o); }
      if (/_LOD1$/i.test(o.name)) { o.visible = false; (this.lod1 ||= []).push(o); }
    });
    this.lod0 = []; if (this.lod1) for (const l of this.lod1) { const b = this.model.getObjectByName(l.name.replace(/_LOD1$/i, '')); if (b) this.lod0.push(b); }
    this.baseTurretRot = this.turret ? this.turret.rotation.y : 0; this.baseGunRot = this.gun ? this.gun.rotation.x : 0;
    this.game.scene.add(root);
  }
  addCage() {
    // fit to the turret's actual roof: robust extents from the turret vertices (ignoring antennas / the gun), posts welded to the roof
    const t = this.turret, gun = this.gun, v = new THREE.Vector3(), xs = [], ys = [], zs = [];
    this.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    t.traverse(o => {
      if (!o.isMesh || /_LOD1$|_wreck$|antenna|aerial/i.test(o.name)) return; let p = o; while (p && p !== t) { if (p === gun) return; p = p.parent; }
      const pos = o.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / 1500));
      for (let i = 0; i < pos.count; i += step) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).applyMatrix4(inv); xs.push(v.x); ys.push(v.y); zs.push(v.z); }
    });
    if (xs.length < 20) return;
    const q = (a, f) => { const s_ = [...a].sort((p, r) => p - r); return s_[Math.floor(f * (s_.length - 1))]; };
    const roof = q(ys, 0.9), x0 = q(xs, 0.03) - 0.18, x1 = q(xs, 0.97) + 0.18, z0 = q(zs, 0.03) - 0.25, z1 = q(zs, 0.97) + 0.2;
    const top = roof + 0.42, base = roof - 0.02, geos = [];
    const bar = (ax, ay, az, bx, by, bz, r = 0.02) => {
      const a = new THREE.Vector3(ax, ay, az), c = new THREE.Vector3(bx, by, bz), L = a.distanceTo(c);
      const g = new THREE.BoxGeometry(r * 2, r * 2, L); g.lookAt(new THREE.Vector3().subVectors(c, a)); g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2); geos.push(g);
    };
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, ix = (x1 - x0) * 0.32, iz = (z1 - z0) * 0.32;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(cx + sx * ix, base, cz + sz * iz, cx + sx * (x1 - x0) / 2, top, cz + sz * (z1 - z0) / 2, 0.026);   // splayed posts from the roof
    for (const z of [z0, z1]) bar(x0, top, z, x1, top, z, 0.025);
    for (const x of [x0, x1]) bar(x, top, z0, x, top, z1, 0.025);
    const nx = Math.round((x1 - x0) / 0.3), nz = Math.round((z1 - z0) / 0.42);
    for (let i = 1; i < nx; i++) { const x = x0 + (x1 - x0) * i / nx; bar(x, top, z0, x, top, z1, 0.015); }
    for (let i = 1; i < nz; i++) { const z = z0 + (z1 - z0) * i / nz; bar(x0, top, z, x1, top, z, 0.013); }
    const m = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ color: 0x3e4130, roughness: 0.85, metalness: 0.3 }));
    m.name = 'drone_cage'; m.castShadow = true;
    this.root.add(m); t.attach(m); this.cage = 0.4; this.cageMesh = m;
  }
  // desant seats: model empties ride_seat_N (+Z = facing, extras.seat_type) or a fallback layout
  seats() {
    if (this._seats) return this._seats;
    const list = [];
    for (let i = 1; i <= 10; i++) { const o = this.model.getObjectByName(`ride_seat_${i}`); if (o) list.push({ obj: o, type: o.userData?.seat_type || 'edge' }); }
    if (!list.length) {
      const L = this.kind === 'btr' ? [[1.25, 2.05, -0.2, 1], [-1.25, 2.05, -0.2, -1], [1.25, 2.05, -1.2, 1], [-1.25, 2.05, -1.2, -1], [1.25, 2.05, -2.2, 1], [-1.25, 2.05, -2.2, -1], [0.55, 2.1, -3.0, 0], [-0.55, 2.1, -3.0, 0]]
        : [[1.5, 1.85, -1.4, 1], [-1.5, 1.85, -1.4, -1], [0.7, 1.75, -2.6, 0], [-0.7, 1.75, -2.6, 0], [1.4, 1.75, -2.9, 1], [-1.4, 1.75, -2.9, -1]];
      for (const [x, y, z, side] of L) { const o = new THREE.Object3D(); o.position.set(x, y, z); o.rotation.y = side ? side * Math.PI / 2 : Math.PI; (this.hull || this.model).add(o); list.push({ obj: o, type: side ? 'edge' : 'deck' }); }
    }
    // BMP-3: the whole 8-man desant rides on top (nobody inside, so the rear doors stay shut) — one more deck seat
    if (this.def.asset === 'bmp3' && list.length < 8) {
      const dk = list.filter(st => st.type === 'deck'), ref = dk.reduce((a, st) => (!a || st.obj.position.x < a.obj.position.x ? st : a), null);
      if (ref) { const o = new THREE.Object3D(); o.position.copy(ref.obj.position); o.position.x -= 0.62; o.quaternion.copy(ref.obj.quaternion); ref.obj.parent.add(o); list.push({ obj: o, type: 'deck' }); }
    }
    // the rear-most row of deck seats: men there sit on the back edge facing the rear, legs over the stern, rather
    // than facing the gun (re-seated on the hull's rear edge, sitting as on the side edges)
    const deck = list.filter(st => st.type === 'deck');
    if (deck.length) {
      this.root.updateMatrixWorld(true);
      const zs = deck.map(st => st.obj.getWorldPosition(new THREE.Vector3()).applyMatrix4(new THREE.Matrix4().copy(this.root.matrixWorld).invert()).z), zMin = Math.min(...zs);
      const box = new THREE.Box3(), inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert(), v = new THREE.Vector3();
      (this.hull || this.model).traverse(o => { if (!o.isMesh || /_LOD1$|_wreck$/i.test(o.name) || !o.visible) return; const pa = o.geometry.attributes.position, step = Math.max(1, Math.floor(pa.count / 400)); for (let i = 0; i < pa.count; i += step) box.expandByPoint(v.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld).applyMatrix4(inv)); });
      deck.forEach((st, k) => {
        if (zs[k] > zMin + 0.25) return;
        const p = st.obj.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
        // per hull (from the GLB surfaces, tools/blender/soldiers/clips_vehicle.py dismount_jump_rear_*): [z, y] of the seat point on the
        // stern edge - BTR engine-deck box, BMP-3 / Bradley roof edge (the generic rule left them floating behind it), T-72 fuel drums
        const RE = { btr82a: [-3.62, 1.95], btr80_ua: [-3.62, 1.95], bmp3: [-3.24, null], bradley_ua: [-3.02, 1.98], t72b3: [-3.62, 1.745], t72av_ua: [-3.62, 1.745] }[this.assetKey];
        const o = new THREE.Object3D(); o.position.set(p.x, RE ? RE[1] ?? p.y : p.y, RE ? RE[0] : Math.max(p.z - 0.6, box.min.z + 0.12)); o.rotation.y = Math.PI;
        this.root.add(o); st.obj = o; st.type = 'edge';
      });
    }
    return this._seats = list;
  }
  seatCount() { return this.seats().length; }
  seatType(i) { return this.seats()[i % this.seatCount()].type; }
  seatWorld(i) {
    const st = this.seats()[i % this.seatCount()]; this.root.updateMatrixWorld(true);
    const pos = st.obj.getWorldPosition(new THREE.Vector3()), d = new THREE.Vector3(0, 0, 1).applyQuaternion(st.obj.getWorldQuaternion(new THREE.Quaternion()));
    return { pos, heading: Math.atan2(d.x, d.z) };
  }
  // BMP-3 rear doors (and roof hatches) / Bradley ramp swing open while men get on or off
  animDoors(dt) {
    if (!this.doorNodes) this.doorNodes = [['door_rear_L', 'y', -1.75], ['door_rear_R', 'y', 1.75], ['roof_door_L', 'x', 1.65], ['roof_door_R', 'x', 1.65], ['ramp', 'x', -2.221]]
      .map(([n, ax, a]) => ({ o: this.model.getObjectByName(n), ax, a })).filter(d => d.o);
    const boarding = this.def.asset === 'bradley_ua' && this.order?.type !== 'move' && this.game.squads?.some(q => q.order?.type === 'mount' && q.carrier === this && !q.mounted);
    const want = (this.game.time < (this.doorT || 0) || boarding) && Math.abs(this.speed) < 1 ? 1 : 0;
    const k = this.doorK ?? 0, rate = this.def.asset === 'bradley_ua' ? 0.55 : 1.4;   // the ramp is hydraulic and slow
    this.doorK = want > k ? Math.min(1, k + dt * rate) : Math.max(0, k - dt * rate);
    if (this.doorK === k) return;
    const e = this.doorK * this.doorK * (3 - 2 * this.doorK);
    for (const d of this.doorNodes) d.o.rotation[d.ax] = d.a * e;
    if ((k === 0 && this.doorK > 0) || (k === 1 && this.doorK < 1)) this.game.sfx('hatch', this.pos);
  }
  place(x, z, h) { this.pos.set(x, 0, z); this.heading = h; this.sync(); }
  doorPos(i, outside = false) {
    if (this.kind === 'ifv') {   // rear doors / ramp: exit_rear empty (ground point, +Z away from the vehicle), men fan out from it
      const e = this.model.getObjectByName('exit_rear'); this.root.updateMatrixWorld(true);
      const f = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading)), r = new THREE.Vector3(f.z, 0, -f.x);
      const p = e ? e.getWorldPosition(new THREE.Vector3()) : this.pos.clone().addScaledVector(f, -this.def.length / 2 - 1);
      return p.addScaledVector(r, ((i % 3) - 1) * 0.7).addScaledVector(f, outside ? -(i >> 1) * 0.5 : 0.8);
    }
    const side = i % 2 ? 1 : -1; const f = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading)), r = new THREE.Vector3(f.z, 0, -f.x);
    const w = this.def.width / 2 + (outside ? 1.4 + (i >> 1) * 0.6 : 0.8);
    return this.pos.clone().addScaledVector(r, side * w).addScaledVector(f, this.kind === 'btr' ? -0.6 - (i >> 1) * 0.7 : -3);
  }
  orderMove(x, z, facing = null, fast = false) {
    if (this.destroyed || this.immobile) return;
    this.order = { type: 'move', x, z, facing }; this.fast = fast;
    this.goal = [x, z]; this.game.requestPath(this, this.pos.x, this.pos.z, x, z, this.kind === 'btr' ? 1.8 : 2.0, this.def.wheeled ? 'wheeled' : 'tracked');
  }
  orderAttack(t) { this.focus = t; this.order = { type: 'attack', target: t }; const d = this.pos.distanceTo(t.center ? t.center() : t.pos); if (d > 400) { const p = this.pos.clone().lerp(t.center ? t.center() : t.pos, 1 - 350 / d); this.orderMove(p.x, p.z); } }
  halt() { this.path = null; this.order = null; this.goal = null; this.reverseT = 0; this.fireAt = null; if (this.spg) this.spg.mission = null; }
  update(dt) {
    this.firedT = (this.firedT ?? 99) + dt;
    this.animLids(dt);
    if (this.destroyed) { this.updateWreck(dt); return; }
    this.drive(dt);
    this.aimAndFire(dt);
    if (this.kind === 'ifv') this.animDoors(dt);
    // fire progression
    if (this.ember) this.ember.value = this.fire && !this.fire.dead ? Math.max(0.15, 1 - this.burning / 200) * (0.8 + 0.2 * Math.sin(this.burning * 5.3)) : Math.max(0, this.ember.value - dt * 0.02);
    // crew: a replacement takes the driver's seat after a while; the commander takes over a dead gunner's sight
    if (this.driverSwapT > 0 && (this.driverSwapT -= dt) <= 0 && this.crewList?.some(c => c.hp > 0)) { this.immob.driver = false; this.immobile = Object.values(this.immob).some(Boolean); if (this.side === 'player') this.game.hud?.alert(`${this.name}: crew swapped seats, mobile again`); }
    if (this.crewList) { const gun = this.crewList.find(c => c.role === 'gunner'), cmd = this.crewList.find(c => c.role === 'commander'); this.gunnerDown = gun.hp <= 0; if (gun.hp <= 0 && cmd.hp <= 0) this.gunDisabled = true; }
    // a burning vehicle: whoever survived the hit tries to get out of the hatches
    if (this.burning > 0 && !this.abandoned && this.firefight !== false) this.fightFire(dt);
    if (this.burning > 0 && !this.abandoned && !this.firefight) { this.bailAt ??= this.burning + 2 + Math.random() * 5; if (this.burning >= this.bailAt) this.bailCrew(0.82); }
    if (this.burning > 0) {
      this.burning += dt;
      this.hp -= dt * (this.kind === 'tank' ? 10 : this.kind === 'ifv' ? 18 : 25) * (this.firefight ? 0.3 : 1);
      if (this.burning > 3 && this.passengers) this.game.bailOut(this, 0.25);
      if (this.hp <= 0 || (this.kind === 'tank' && this.burning > 25 && Math.random() < dt * 0.1)) this.knockOut(this.kind === 'tank' && Math.random() < 0.6);
    }
    this.fx(dt);
    this.sync();
  }
  drive(dt) {
    const def = this.def;
    let targetSpeed = 0, turn = 0;
    if (this.path && this.pathI < this.path.length && !this.immobile && !this.spgHold) {
      // pure pursuit: steer at a point a look-ahead distance down the route (projected from where the hull is), so
      // corners are rounded off on the road instead of overshooting a waypoint and swinging back, and a hull pushed
      // off the line steers back onto it
      const P = this.path, px = this.pos.x, pz = this.pos.z;
      let t = 0, ax = px, az = pz, bx, bz;
      for (;;) {
        const b = P[this.pathI], a = this.pathI > 0 ? P[this.pathI - 1] : null; ax = a ? a[0] : px; az = a ? a[1] : pz; bx = b[0]; bz = b[1];
        const sx = bx - ax, sz = bz - az, L2 = sx * sx + sz * sz;
        t = L2 > 1e-6 ? ((px - ax) * sx + (pz - az) * sz) / L2 : 1;
        const lastW = this.pathI === P.length - 1;
        if (!lastW && (t >= 1 || Math.hypot(bx - px, bz - pz) < 3)) { this.pathI++; continue; }
        break;
      }
      const last = this.pathI === P.length - 1, tc = Math.max(0, Math.min(1, t));
      const qx = ax + (bx - ax) * tc, qz = az + (bz - az) * tc;
      const dEnd = Math.hypot(P[P.length - 1][0] - px, P[P.length - 1][1] - pz);
      if (last && Math.hypot(bx - px, bz - pz) < 1.5) { this.pathI++; this.path = null; }
      let rem = 3.5 + Math.abs(this.speed) * 0.55, cx = qx, cz = qz, j = this.pathI;
      for (let fx = qx, fz = qz; j < P.length; j++) { const d = Math.hypot(P[j][0] - fx, P[j][1] - fz); if (d >= rem) { cx = fx + (P[j][0] - fx) * rem / d; cz = fz + (P[j][1] - fz) * rem / d; break; } rem -= d; fx = cx = P[j][0]; fz = cz = P[j][1]; }
      const off = Math.hypot(px - qx, pz - qz); if (off > 8) { cx = bx; cz = bz; }   // knocked well off the line: head for the next waypoint
      const want = Math.atan2(cx - px, cz - pz), err = angDiff(want, this.heading);
      turn = THREE.MathUtils.clamp(err * 2.2, -1, 1);
      const cornering = Math.abs(err) > 0.6 ? (def.wheeled ? 0.35 : 0) : Math.abs(err) > 0.3 ? 0.7 : 1;
      // brake ahead of a sharp bend at the next waypoint (and for the end of the route)
      let bend = 1;
      if (!last) { const n = P[this.pathI + 1], a1 = Math.atan2(bx - ax, bz - az), a2 = Math.atan2(n[0] - bx, n[1] - bz), ang = Math.abs(angDiff(a2, a1)), dB = Math.hypot(bx - px, bz - pz); if (ang > 0.35) { const vc = def.speed * Math.max(0.3, 1 - ang / 2.2); const vmax = Math.sqrt(vc * vc + 2 * def.accel * 1.6 * Math.max(0, dB - 3)); bend = Math.min(1, vmax / def.speed); } }
      targetSpeed = def.speed * (this.fast ? 1 : 0.7) * cornering * Math.min(bend, Math.min(1, dEnd / 10 + 0.15));
      // rubble slows; roads are fast, open fields slower (wheels more than tracks)
      const nav = this.game.nav, ci = nav.idx(px, pz), c = nav.cost[ci] || 1; if (c > 2) targetSpeed *= 0.55;
      if (this.slope > 0.06) targetSpeed *= Math.max(0.3, 1 - this.slope * 2.2);   // grinding up a rubble heap
      const rd = nav.roadAt(px, pz); targetSpeed *= rd === 2 ? (def.wheeled ? 1.3 : 1.15) : rd === 1 ? (def.wheeled ? 1.1 : 1.05) : def.wheeled ? 0.78 : 0.9;
      // friendly vehicles: wait behind one that is moving; go round one that is parked (or stuck) in the way
      const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
      for (const o of this.game.vehicles) if (o !== this && !o.destroyed) {
        const ox = o.pos.x - px, oz = o.pos.z - pz, od = Math.hypot(ox, oz), ahead = ox * sh + oz * ch;
        if (od > def.radius + o.def.radius + 3 || ahead <= 0) continue;
        const parked = Math.abs(o.speed) < 0.5 && (!o.path || (o.wdT || 0) > 2);
        if (!parked) { targetSpeed *= 0.15; continue; }
        const side = (ox * ch - oz * sh) > 0 ? -1 : 1;   // pass on the side away from it
        turn = THREE.MathUtils.clamp(turn + side * 0.8, -1, 1); targetSpeed *= 0.45;
      }
    } else if (this.order?.facing != null && !this.immobile) { const err = angDiff(this.order.facing, this.heading); if (Math.abs(err) > 0.05) turn = THREE.MathUtils.clamp(err * 2, -1, 1) * (def.wheeled ? 0 : 1); }
    if (this.crew < 2) targetSpeed *= 0.5;
    // an FPV drone coming for us (support.js sets droneThreat each frame it chases): a moving vehicle weaves at full speed,
    // swapping lock every second or so, and in the drone's terminal dive breaks hard away from the side it comes in on
    const th = this.droneThreat;
    if (th && this.game.time - th.t < 0.3 && TUNING.droneEvade !== false && this.path && !this.immobile && !this.spgHold && this.crew >= 2 && !(this.reverseT > 0) && this.speed > 1.5) {
      if (!this.evadeLog?.has(th.id)) { (this.evadeLog ||= new Set()).add(th.id); if (this.side === 'player') this.game.hud?.alert(`${this.name}: FPV drone inbound — evading`, 'bad'); }
      this.evadeT = (this.evadeT || 0) + dt;
      if (!(this.evadeT < this.evadeSw)) { this.evadeDir = -(this.evadeDir || 1); this.evadeSw = this.evadeT + 0.8 + Math.random() * 0.9; }
      let dir = this.evadeDir;
      if (th.phase === 'dive' && th.dist < 50) { const dx = th.x - this.pos.x, dz = th.z - this.pos.z, side = Math.cos(this.heading) * dx - Math.sin(this.heading) * dz; const away = side > 0 ? -1 : 1; dir = th.dist < 22 ? -away : away; }   // break away, then a late juke back the other way
      turn = THREE.MathUtils.clamp(turn + dir * 0.9, -1, 1);
      targetSpeed = Math.max(targetSpeed, def.speed * (def.wheeled ? 0.9 : 0.85));
    } else if (this.evadeT) { this.evadeT = 0; this.evadeSw = 0; }
    // stuck recovery: back up with opposite lock for a moment, then replan
    if (this.reverseT > 0) { this.reverseT -= dt; targetSpeed = -def.speed * 0.25; turn = -(this.revTurn || 1); if (this.reverseT <= 0 && this.goal) this.game.requestPath(this, this.pos.x, this.pos.z, this.goal[0], this.goal[1], this.kind === 'tank' ? 2.0 : 1.8, this.def.wheeled ? 'wheeled' : 'tracked'); }
    else if (this.path && !this.immobile && !this.spgHold) {
      this.wdT = (this.wdT || 0) + dt;
      if (this.wdT > 3) { const moved = this.wdP ? Math.hypot(this.pos.x - this.wdP[0], this.pos.z - this.wdP[1]) : 9; this.wdP = [this.pos.x, this.pos.z]; this.wdT = 0; if (moved < 1.2) { this.reverseT = 1.6; this.revTurn = Math.sign(turn || 1); } }
    } else { this.wdT = 0; this.wdP = null; }
    const acc = targetSpeed > this.speed ? def.accel : def.accel * 2;
    this.speed += THREE.MathUtils.clamp(targetSpeed - this.speed, -acc * dt, acc * dt);
    const tr = def.wheeled ? turn * def.turnRate * Math.min(1, Math.abs(this.speed) / 3) : turn * def.turnRate;
    this.heading += tr * dt;
    this.angVel = tr;
    const nx = this.pos.x + Math.sin(this.heading) * this.speed * dt, nz = this.pos.z + Math.cos(this.heading) * this.speed * dt;
    // hull footprint: centre plus a probe at the leading edge (front when driving, rear when reversing)
    // trenches stop wheeled vehicles (tracks cross them), AT ditches / dragon's teeth / forest stop everyone
    const nav = this.game.nav, tracked = !def.wheeled, free = nav.vehPassable ? (x, z) => nav.vehPassable(x, z, tracked) : (x, z) => { const k = nav.idx(x, z); return k >= 0 && nav.cost[k] !== 255; };
    const lead = (this.speed >= 0 ? 1 : -1) * def.length * 0.45, fx = nx + Math.sin(this.heading) * lead, fz = nz + Math.cos(this.heading) * lead;
    if (free(nx, nz) && free(fx, fz)) { this.pos.x = nx; this.pos.z = nz; }
    else { this.speed *= 0.3; if (this.path && !(this.reverseT > 0) && this.speed >= 0) { this.blockT = (this.blockT || 0) + dt; if (this.blockT > 0.8) { this.blockT = 0; this.reverseT = 1.4; this.revTurn = Math.sign(turn || 1); } } }
    if (!free(this.pos.x, this.pos.z)) { const [ex, ez] = nav.nearestFree(this.pos.x, this.pos.z, this.kind === 'tank' ? 2.0 : 1.8, 12); this.pos.x = ex; this.pos.z = ez; }
    this.dist = (this.dist || 0) + this.speed * dt;
    if (Math.abs(this.speed) > 0.4) this.game.city.crushCheck(this, this.game);
    // suspension pitch from acceleration
    const accel = (this.speed - (this.lastSpeed ?? 0)) / Math.max(dt, 1e-3); this.lastSpeed = this.speed;
    // ground: sample under the nose, tail and both sides so the hull pitches and rolls over rubble heaps,
    // parapets and trench lips (city.groundHeight), and sits at the right height
    const gh = this.game.city.groundHeight;
    let tp = 0, tr_ = 0;
    if (gh) {
      const L = def.length * 0.42, W = def.width * 0.4, sh = Math.sin(this.heading), ch = Math.cos(this.heading);
      const hF = gh(this.pos.x + sh * L, this.pos.z + ch * L), hB = gh(this.pos.x - sh * L, this.pos.z - ch * L);
      const hR = gh(this.pos.x + ch * W, this.pos.z - sh * W), hL = gh(this.pos.x - ch * W, this.pos.z + sh * W);
      // tracks bridge a trench: the hull rests on the higher contact points rather than dropping into the cut
      const y = Math.max((hF + hB) / 2, (hL + hR) / 2, gh(this.pos.x, this.pos.z) * (def.wheeled ? 1 : 0.3));
      this.pos.y = THREE.MathUtils.lerp(this.pos.y || 0, y, Math.min(1, dt * 8));
      tp = Math.atan2(hB - hF, 2 * L); tr_ = Math.atan2(hR - hL, 2 * W);
      this.slope = (hF - hB) / (2 * L);
    }
    this.pitch = THREE.MathUtils.lerp(this.pitch || 0, THREE.MathUtils.clamp(-accel * 0.012, -0.05, 0.05) + tp, Math.min(1, dt * 5));
    this.roll = THREE.MathUtils.lerp(this.roll || 0, THREE.MathUtils.clamp(-this.angVel * this.speed * 0.01, -0.04, 0.04) + tr_, Math.min(1, dt * 5));
  }
  aimAndFire(dt) {
    if (this.abandoned) { this.target = null; return; }
    if (this.stunT > 0) { this.stunT -= dt; return; }
    this.thinkT -= dt;
    if (this.thinkT <= 0) { this.thinkT = 0.6; this.game.combat.vehicleTargets(this); }
    if (this.kind === 'spg') { for (const w of this.weapons) w.cd -= dt; this.spgUpdate(dt); return; }
    const main = this.weapons[0], t = this.target;
    const gp = !t && !this.holdFire ? this.game.combat.groundPoint(this) : null;     // fire-at-ground order
    // turret slew
    if (this.turret) {
      let want = this.turretYaw;
      if (t) { const tp = t.pos; want = angDiff(Math.atan2(tp.x - this.pos.x, tp.z - this.pos.z), this.heading); }
      else if (gp) want = angDiff(Math.atan2(gp.x - this.pos.x, gp.z - this.pos.z), this.heading);
      else want = this.turretYaw * (1 - dt * 0.3);
      // riders on the deck: keep the barrel out of them (BTR front arc, T-72 locked forward)
      const riders = this.passengers?.mounted && this.passengers.soldiers.some(s => s.inside === 'ride');
      if (riders) { const arc = this.kind === 'tank' ? 0.12 : this.kind === 'ifv' ? 0.5 : 0.7; want = THREE.MathUtils.clamp(want, -arc, arc); }
      const rate = this.def.turretSpeed * (this.gunDisabled ? 0.3 : 1) * (this.turretJam ? 0.15 : 1);
      const d = angDiff(want, this.turretYaw); this.turretYaw += THREE.MathUtils.clamp(d, -rate * dt, rate * dt);
      this.turretSlewing = Math.abs(d) > 0.02;
      if (t) { const dist = Math.hypot(t.pos.x - this.pos.x, t.pos.z - this.pos.z); const dh = (t.aimY ?? 1) - 2.2; this.gunPitch = THREE.MathUtils.lerp(this.gunPitch, THREE.MathUtils.clamp(Math.atan2(dh, dist), -0.1, 0.35), Math.min(1, dt * 3)); }
    }
    for (const w of this.weapons) w.cd -= dt;
    if (gp && !this.gunDisabled) { this.groundFire(gp, dt); return; }
    if (!t || this.holdFire || this.gunDisabled) { this.coaxFire(dt); return; }
    const aligned = Math.abs(angDiff(angDiff(Math.atan2(t.pos.x - this.pos.x, t.pos.z - this.pos.z), this.heading), this.turretYaw)) < 0.04;
    if (!aligned) { this.coaxFire(dt); return; }
    const W = WEAPONS[main.key];
    if (this.kind === 'ifv') {
      const C = this.game.combat, dist = Math.hypot(t.pos.x - this.pos.x, t.pos.z - this.pos.z);
      if (this.atgm) this.atgm.cd -= dt; if (this.gun100) this.gun100.cd -= dt;
      // heavy armour: halt-and-shoot ATGM; the autocannon is pointless against a tank
      if (t.type === 'vehicle' && t.kind === 'tank') {
        const A = this.atgm, AW = A && WEAPONS[A.key];
        if (A && A.ammo > 0 && !this.atgmDisabled && A.cd <= 0 && Math.abs(this.speed) < 1.5 && dist <= AW.range && !this.missileOut) {
          A.ammo--; A.fired = (A.fired || 0) + 1;
          A.cd = A.key === 'tow2' ? (A.fired % 2 === 0 ? 40 : 7) : AW.reload;      // TOW: 2 in the launcher, reloaded through the roof hatch
          C.fireVehicleMissile(this, t, AW);
        }
        this.coaxFire(dt); return;
      }
      // BMP-3: 100 mm HE-Frag against men in buildings, trenches or bunched up, and against light vehicles
      const G = this.gun100;
      if (G && G.ammo > 0 && G.cd <= 0 && (t.type === 'vehicle' || t.inBuilding || (t.squad && t.squad.effective.filter(o => o.pos.distanceTo(t.pos) < 8).length >= 3))) {
        G.ammo--; G.cd = 60 / WEAPONS.a70.rof + Math.random() * 2; C.fireTankGun(this, t, 'he', WEAPONS.a70); this.recoil = 1;
      }
    }
    if (this.kind === 'tank') {
      if (main.cd <= 0 && main.ammo > 0) {
        const vsArmor = t.type === 'vehicle';
        const round = vsArmor && main.ap > 0 ? 'ap' : main.he > 0 ? 'he' : 'ap';
        if (main[round] <= 0) return;
        main[round]--; main.ammo--;
        main.cd = (W.reload + (this.crew < 3 ? 6 : 0)) * (main.ammo < 17 ? 1.0 : 1.0) + (main.ammo === 17 ? 15 : 0);
        this.game.combat.fireTankGun(this, t, round);
        this.recoil = 1;
      }
    } else if (main.ammo > 0) {
      if (main.burst <= 0 && main.cd <= 0) { main.burst = Math.round(THREE.MathUtils.randFloat(...W.burst)); }
      if (main.burst > 0 && main.cd <= 0) {
        main.burst--; main.ammo--; main.cd = 60 / W.rof;
        if (main.burst === 0) main.cd = THREE.MathUtils.randFloat(...W.burstGap);
        this.game.combat.fireVehicleGun(this, main, t);
        this.recoil = 0.4;
      }
    }
    this.coaxFire(dt);
  }
  // area fire on a clicked point: tank HE + coax, BTR cannon / HMG bursts + coax
  groundFire(p, dt) {
    const g = this.game, C = g.combat, dist = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
    const aligned = Math.abs(angDiff(angDiff(Math.atan2(p.x - this.pos.x, p.z - this.pos.z), this.heading), this.turretYaw)) < 0.05;
    this.gunPitch = THREE.MathUtils.lerp(this.gunPitch, THREE.MathUtils.clamp(Math.atan2(-1.8, dist), -0.1, 0.35), Math.min(1, dt * 3));
    if (!aligned) return;
    const main = this.weapons[0], W = WEAPONS[main.key];
    const from = () => (this.muzzle ? this.muzzle.getWorldPosition(new THREE.Vector3()) : this.pos.clone().setY(2.2));
    if (this.kind === 'tank') {
      if (main.cd <= 0 && main.he > 0 && dist < W.range) {
        main.he--; main.ammo--; main.cd = W.reload + (this.crew < 3 ? 6 : 0);
        const f = from(), tp = p.clone().setY(0.3); tp.x += (Math.random() - .5) * (2 + dist * 0.02); tp.z += (Math.random() - .5) * (2 + dist * 0.02);
        const occ = g.nav.occluded(f.x, f.y, f.z, tp.x, tp.y, tp.z, null, null), dir = tp.clone().sub(f).normalize();
        g.fx.muzzleBlastTank(f, dir); g.sfx('tankgun', this.pos); g.cam.addShake(Math.max(0, 0.6 - g.camDist(this.pos) / 250)); g.fx.tracer(f, tp, 1600, [1, 0.8, 0.5]);
        C.projectiles.push({ kind: 'he', pos: f.clone(), target: tp, t: null, speed: 850, owner: this, side: this.side, weapon: W, occ, hit: false });
        this.recoil = 1; this.firedT = 0;
      }
    } else if (main.ammo > 0 && dist < W.range) {
      if (main.burst <= 0 && main.cd <= 0) main.burst = Math.round(THREE.MathUtils.randFloat(...W.burst));
      if (main.burst > 0 && main.cd <= 0) {
        main.burst--; main.ammo--; main.cd = main.burst === 0 ? THREE.MathUtils.randFloat(...W.burstGap) * 1.2 : 60 / W.rof; this.recoil = 0.4; this.firedT = 0;
        const f = from();
        if (W.type === 'autocannon') {
          const end = p.clone(); const m = 1 + dist * 0.02; end.x += (Math.random() - .5) * m * 2; end.z += (Math.random() - .5) * m * 2;
          if (g.camDist(this.pos) < 300) g.fx.muzzle(f, end.clone().sub(f).normalize(), 1.6); g.sfx('cannon30', this.pos);
          if (g.camDist(this.pos) < 500) g.fx.tracer(f, end, 900, [1, 0.6, 0.3]);
          C.projectiles.push({ kind: 'he30', pos: f.clone(), target: end, t: null, speed: 960, owner: this, side: this.side, weapon: W, hit: false });
        } else { C.groundRound(this, f, p, W, this.side, this); g.sfx(W.sound === 'hmg' ? 'hmg' : 'mg_near', this.pos); }
      }
    }
    const w = this.weapons[1];
    if (w && w.ammo > 0 && dist < 700) {
      const Wc = WEAPONS.pkt;
      if (w.burst <= 0 && w.cd <= 0) w.burst = Math.round(THREE.MathUtils.randFloat(...Wc.burst));
      if (w.burst > 0 && w.cd <= 0) { w.burst--; w.ammo--; w.cd = w.burst === 0 ? THREE.MathUtils.randFloat(...Wc.burstGap) * 1.3 : 60 / Wc.rof;
        const f = this.coax ? this.coax.getWorldPosition(new THREE.Vector3()) : this.pos.clone().setY(2.1); C.groundRound(this, f, p, Wc, this.side, this); g.sfx('mg_near', this.pos); }
    }
  }
  coaxFire(dt) {
    const w = this.weapons[1], t = this.coaxTarget; if (!t || this.holdFire || w.ammo <= 0) return;
    const aligned = Math.abs(angDiff(angDiff(Math.atan2(t.pos.x - this.pos.x, t.pos.z - this.pos.z), this.heading), this.turretYaw)) < 0.12; if (!aligned) return;
    const W = WEAPONS.pkt;
    if (w.burst <= 0 && w.cd <= 0) w.burst = Math.round(THREE.MathUtils.randFloat(...W.burst));
    if (w.burst > 0 && w.cd <= 0) { w.burst--; w.ammo--; w.cd = w.burst === 0 ? THREE.MathUtils.randFloat(...W.burstGap) : 60 / W.rof; this.game.combat.fireVehicleGun(this, w, t, true); }
  }
  fx(dt) {
    const g = this.game, ex = this.exhaustN ? this.exhaustN.getWorldPosition(tmp) : tmp.set(this.pos.x - Math.sin(this.heading) * this.def.length * 0.45, 1.6, this.pos.z - Math.cos(this.heading) * this.def.length * 0.45);
    const load = Math.min(1, Math.abs(this.speed) / this.def.speed + (this.speed > (this.lastSpeed2 || 0) ? 0.3 : 0)); this.lastSpeed2 = this.speed;
    g.fx.exhaust(ex, load);
    g.fx.vehicleDust(this.pos, Math.abs(this.speed));
    // engine audio
    if (!this.engine && g.audio.ok && g.camDist(this.pos) < 260) { const k = this.def.wheeled ? 'btr_engine' : 'tank_engine'; this.engine = g.audio.loop(k + '_idle', this.pos, 0.7); this.engineDrive = g.audio.loop(k + '_drive', this.pos, 0); if (!this.def.wheeled) this.tracks = g.audio.loop('track_clank', this.pos, 0); }
    if (this.engine) {
      const s = Math.abs(this.speed) / this.def.speed;
      this.engine.set(this.pos, 0.8 * (1 - s * 0.6), 1 + s * 0.15);
      this.engineDrive?.set(this.pos, s * 0.9 + (this.turretSlewing ? 0.05 : 0), 0.85 + s * 0.3);
      this.tracks?.set(this.pos, Math.min(1, s * 1.4), 0.7 + s * 0.6);
      if (g.camDist(this.pos) > 320) { this.engine.stop(); this.engineDrive?.stop(); this.tracks?.stop(); this.engine = this.engineDrive = this.tracks = null; }
    }
  }
  sync() {
    const r = this.root; r.position.copy(this.pos); r.rotation.set(this.pitch || 0, this.heading, this.roll || 0, 'YXZ');
    if (this.turret) this.turret.rotation.y = this.baseTurretRot + this.turretYaw;
    if (this.gun) { this.recoil = Math.max(0, (this.recoil || 0) - 0.05); this.gun.rotation.x = this.baseGunRot - this.gunPitch; this.gun.position.z = (this.gunBaseZ ??= this.gun.position.z) - (this.recoil || 0) * (this.kind === 'tank' ? 0.3 : this.kind === 'spg' ? 0.7 : 0.05); }
    const d = this.dist || 0;
    for (const w of this.wheels) w.rotation.x = d / 0.56;
    const rg = this.vman.running_gear_radii_m || {};
    for (const w of this.roadwheels) w.rotation.x = d / (/sprocket/i.test(w.name) ? rg.sprocket || 0.33 : /idler/i.test(w.name) ? rg.idler || 0.31 : rg.roadwheel || 0.375);
    for (const m of this.trackMats) { m.map.offset.x = -d / (this.vman.track_link_pitch_m || 0.1416); if (m.normalMap) m.normalMap.offset.x = m.map.offset.x; if (m.alphaMap) m.alphaMap.offset.x = m.map.offset.x; }
    // LOD
    if (this.lod1?.length) { const far = this.game.camDist(this.pos) > 110; if (far !== this.far) { this.far = far; for (const o of this.lod1) o.visible = far && !this.destroyed; for (const o of this.lod0) o.visible = !far; } }
    r.visible = this.side === 'player' || this.spotted || this.destroyed;
  }
  // ------------------------------------------------------------ damage
  // surviving crew climb out of the hatches (hatch_exit) and fight on with pistols
  bailCrew(survival = 0.82) {
    if (this.abandoned) return; this.abandoned = true;
    const g = this.game, alive = (this.crewList || []).filter(c => c.hp > 0);
    const out = alive.filter(() => Math.random() < survival);
    for (const c of alive) if (!out.includes(c)) c.hp = 0;
    this.crew = 0; this.target = null; this.path = null;
    if (!out.length) return;
    const roles = out.map(c => CREW_ROLES.find(r => r.role.toLowerCase().includes(c.role === 'driver' ? 'driver' : c.role)) || CREW_ROLES[2]);
    const sq = new Squad(g, this.side, this.faction, `${this.name} crew`, 'crew', roles); sq.name = `${this.name} crew`;
    const right = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading)), fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    // hatch_exit clips: each man's root goes out from his own hatch (hatch_<role> rim empties), facing away from the
    // vehicle in the frame the hatch sits in — the turret's frame for turret hatches, so a traversed turret sends the
    // commander / gunner out over the side the turret now faces — staggered one after another; the lid swings open
    // (hatch_lid_<role>) as he pushes it
    this.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const old = this.kind === 'tank' ? { commander: [0.45, -0.3], gunner: [-0.45, -0.3], driver: [0, 2.6] } : { commander: [0.45, 2.6], driver: [-0.45, 2.6], gunner: [0, 1.2] };
    const frameOf = obj => { let p = obj; while (p && p !== this.root) { if (p === this.turret) return this.turret; p = p.parent; } return null; };
    const lids = this.vman.hatch_lids || {};
    sq.soldiers.forEach((s, i) => {
      const role = out[i].role, e = this.model.getObjectByName('hatch_' + role);
      let hw, fr = right.clone(), ff = fwd.clone(), lx;
      if (e) {
        hw = e.getWorldPosition(new THREE.Vector3());
        const T = frameOf(e);
        if (T) { const q = T.getWorldQuaternion(new THREE.Quaternion()); fr = new THREE.Vector3(1, 0, 0).applyQuaternion(q).setY(0).normalize(); ff = new THREE.Vector3(0, 0, 1).applyQuaternion(q).setY(0).normalize(); const tp = T.getWorldPosition(new THREE.Vector3()); lx = (hw.x - tp.x) * fr.x + (hw.z - tp.z) * fr.z; }
        else lx = hw.clone().applyMatrix4(inv).x;
      } else { const h = old[role] || [0, 0]; hw = new THREE.Vector3(this.pos.x + right.x * h[0] + fwd.x * h[1], 0, this.pos.z + right.z * h[0] + fwd.z * h[1]); lx = h[0]; }
      const side = lx < -0.05 || (Math.abs(lx) <= 0.05 && i % 2) ? -1 : 1;
      // clip frame: the tank hatch rim sits 1.92 m inboard and 0.25 m forward of the end root, the BTR rim 1.70 m inboard
      const tank = this.kind === 'tank', exitD = tank ? 1.92 : 1.70, aft = tank ? 0.25 : 0;
      const [x, z] = g.nav.nearestFree(hw.x + fr.x * side * exitD - ff.x * aft, hw.z + fr.z * side * exitD - ff.z * aft, 0.4, 4); s.pos.set(x, 0, z); s.heading = Math.atan2(fr.x * side, fr.z * side);
      s.hatchWait = 0.6 + i * 1.4 + Math.random() * 0.5; s.inside = 'btr'; s.stance = 'stand';
      s.hatchClip = this.kind === 'btr' && hasClip('hatch_exit_btr') ? 'hatch_exit_btr' : hasClip('hatch_exit_tank') ? 'hatch_exit_tank' : 'hatch_exit';
      const lid = Object.entries(lids).find(([, L]) => L.role === role);
      if (lid) s.hatchOpen = () => this.openLid(lid[0], lid[1]);
      if (out[i].hp < 60) { s.state = 'light'; s.hp = out[i].hp; }
      s.sync();
    });
    g.squads.push(sq);
    // move away from the burning hulk to cover
    const away = this.pos.clone().addScaledVector(fwd, -12);
    setTimeout(() => { if (!sq.destroyed) sq.orderMove(away.x, away.z, this.heading, 8, true); }, 2200);
    if (this.side === 'player') { g.playerUnits?.push(sq); g.hud?.rebuildCards(); g.hud?.alert(`${this.name}: ${out.length} crew bailed out`, 'bad'); }
    else g.commander?.adoptCrew?.(sq);
  }
  // a fire that isn't too bad: the crew fights it from inside with the hand extinguishers / the fixed fire system
  // (a sign above the vehicle shows it); it goes out, or it gets worse and they bail out
  fightFire(dt) {
    const g = this.game, alive = (this.crewList || []).filter(c => c.hp > 0), frac = this.hp / this.def.hp;
    if (this.firefight == null) {
      if (alive.length < 2 || frac < 0.45 || Math.random() > (this.kind === 'tank' ? 0.8 : 0.6)) { this.firefight = false; return; }
      this.firefight = { t: 0, dur: 7 + Math.random() * 7 };
      if (this.side === 'player') g.hud?.alert(`${this.name}: fire on board — crew fighting it`);
    }
    const F = this.firefight; F.t += dt;
    this.bannerNote = `FIGHTING FIRE ${Math.min(99, Math.round(F.t / F.dur * 100))}%`;
    if (this.hp / this.def.hp < 0.3 || F.t >= F.dur) {
      const ok = this.hp / this.def.hp >= 0.3 && Math.random() < 0.55 + 0.4 * (this.hp / this.def.hp);
      this.bannerNote = null;
      if (ok) { this.burning = 0; this.bailAt = null; this.firefight = null; if (this.side === 'player') g.hud?.alert(`${this.name}: fire put out`, 'good'); }
      else { this.firefight = false; this.bailAt = this.burning; if (this.side === 'player') g.hud?.alert(`${this.name}: the fire is out of control — crew bailing out`, 'bad'); }
    }
  }
  // swing a hatch lid open (manifest hatch_lids: hinge node, local axis, open angle)
  openLid(name, L) {
    const o = this.model.getObjectByName(name); if (!o) return;
    (this.lidAnim ||= []).push({ o, ax: L.axis || 'x', from: o.rotation[L.axis || 'x'], to: L.open, t: 0 });
  }
  animLids(dt) {
    if (!this.lidAnim?.length) return;
    for (const a of this.lidAnim) { a.t = Math.min(1, a.t + dt / 0.45); const e = 1 - (1 - a.t) ** 3; a.o.rotation[a.ax] = a.from + (a.to - a.from) * e; }
    this.lidAnim = this.lidAnim.filter(a => a.t < 1);
  }
  // swap the model to its wreck (also used by the versus joiner's puppet vehicles)
  showWreck() {
    if (this.wreckParts?.length) {
      if (this.hull && this.hull !== this.model) this.hull.visible = false;
      else this.model.traverse(o => { if (o.isMesh && !/_wreck/i.test(o.name) && !/_wreck/i.test(o.parent?.name || '')) o.visible = false; });
      for (const w of this.wreckParts) { w.visible = true; w.traverse(o => { o.visible = !/_LOD1$/i.test(o.name); }); charObject(w, this.ember ||= { value: 1 }); }
    } else charObject(this.model, this.ember ||= { value: 1 });
  }
  knockOut(catastrophic = false) {
    if (this.destroyed) return;
    const crewSurv = catastrophic ? 0 : 0.6;   // the crew's chance to get out; men in the troop compartment get the same (game.passengersOnKill)
    if (!catastrophic && !this.abandoned) this.bailCrew(crewSurv); else this.abandoned = true;
    this.destroyed = true; this.target = null; this.path = null; this.speed = 0; this.burning = Math.max(this.burning, 0.01); this.bannerNote = null;
    const g = this.game;
    if (this.passengers) g.passengersOnKill(this, crewSurv, catastrophic);
    g.onVehicleLost(this);
    this.showWreck();
    if (catastrophic && this.turret) {
      // ammunition cook-off: turret thrown into the air
      const tw = (this.wreckParts || []).find(w => /turret/i.test(w.name)) || this.turret;
      const p = tw.getWorldPosition(new THREE.Vector3()); const q = tw.getWorldQuaternion(new THREE.Quaternion());
      g.scene.attach(tw); tw.position.copy(p); tw.quaternion.copy(q);
      this.flyer = { obj: tw, v: new THREE.Vector3((Math.random() - .5) * 6, 14 + Math.random() * 8, (Math.random() - .5) * 6), w: new THREE.Vector3((Math.random() - .5) * 4, (Math.random() - .5) * 3, (Math.random() - .5) * 4) };
      g.fx.explosion(this.pos.clone().setY(1.5), 2.6); g.sfx('explosion_large', this.pos); g.cam.addShake(Math.max(0, 1 - g.camDist(this.pos) / 200));
    } else { g.fx.explosion(this.pos.clone().setY(1.2), 1.2); g.sfx('explosion_medium', this.pos); }
    this.fire = g.fx.emitter(this.pos.clone().setY(1.6), 'fire', this.kind === 'tank' ? 1.5 : 1.2, 120 + Math.random() * 120);
    this.fireSound = g.audio.ok ? g.audio.loop('fire_vehicle_loop', this.pos, 0.8) || g.audio.loop('fire_loop', this.pos, 0.8) : null;
    g.nav.circle(this.pos.x, this.pos.z, this.def.radius + 0.3, 255); g.nav.circle(this.pos.x, this.pos.z, this.def.radius + 1.2, 7, true);
    g.nav.rect(this.pos.x, this.pos.z, this.def.width / 2, this.def.length / 2, this.heading, 255, 0.15);   // the whole hull (the circle missed bow and stern: paths ran through the wreck)
    g.nav.addOccluder(this.pos.x, this.pos.z, this.def.width / 2, this.def.length / 2, this.heading, 2.2, this);
    this.engine?.stop(); this.engineDrive?.stop(); this.tracks?.stop(); this.engine = null;
    this.wreck = true;
  }
  updateWreck(dt) {
    const f = this.flyer;
    if (f && !f.rest) {
      f.v.y -= 9.8 * dt; f.obj.position.addScaledVector(f.v, dt); f.obj.rotation.x += f.w.x * dt; f.obj.rotation.z += f.w.z * dt; f.obj.rotation.y += f.w.y * dt;
      if (f.obj.position.y < 0.6 && f.v.y < 0) { f.obj.position.y = 0.6; f.v.multiplyScalar(0.2); f.v.y = Math.abs(f.v.y) * 0.3; f.w.multiplyScalar(0.3); if (f.v.length() < 1) { f.rest = true; this.game.fx.dustCloud(f.obj.position, 4, 1, 10); this.game.sfx('debris', f.obj.position); } }
    }
    if (this.fire && this.fire.dead && this.fireSound) { this.fireSound.stop(); this.fireSound = null; this.game.fx.emitter(this.pos.clone().setY(1.2), 'smoulder', 1, 200); }
    this.root.visible = true;
  }
}
Object.defineProperties(Vehicle.prototype, Object.getOwnPropertyDescriptors(SpgMixin));   // keeps the spgHold getter a getter
