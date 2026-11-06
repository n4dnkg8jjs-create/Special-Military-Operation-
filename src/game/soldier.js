import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import * as Fallback from '../engine/fallback.js';
import { WEAPONS, TUNING, ARMOR } from '../config.js';
import { Ragdoll, samplePose, ragdollSlot } from './ragdoll.js';
import { DamageSkin, damageTick } from './soldierDamage.js';

export const WEAPON_ASSET = { ak74m: 'ak74m', ak12: 'ak12', ak74o: 'ak74m_optic', pkm: 'pkm', rpg7: 'rpg7', rpg22: 'rpg22', pm: 'pm' };
// a crewman with a pistol uses the pistol clips when they exist, otherwise the rifle ones
const PISTOL_CLIP = { aim_stand: 'pistol_aim', fire_stand: 'pistol_fire', idle_rifle: 'pistol_idle', walk_rifle: 'pistol_walk', run_rifle: 'pistol_run', aim_crouch: 'pistol_crouch_aim', fire_crouch: 'pistol_fire', crouch_idle: 'pistol_crouch_aim', reload_stand: 'pistol_aim', reload_crouch: 'pistol_crouch_aim' };

// One infantryman: visual (skinned MakeHuman mesh + gear + weapon), animation state machine and combat state.
const CLIP_SPEED = { walk_rifle: 1.45, run_rifle: 3.9, crouch_walk: 1.0, prone_crawl: 0.45, high_crawl: 0.7, wounded_crawl: 0.3, limp_walk: 0.9, drag_wounded: 0.8 };
let SHARED = null, SHARED_EVENTS = {};
const _dv = new THREE.Vector3();

export function prepareSoldierAssets(assets) {
  const a = assets.gltf.soldier_anims || assets.gltf.soldier_ua || assets.gltf.soldier_ru;
  const clips = {};
  for (const c of a?.animations || []) clips[c.name] = c;
  for (const g of [assets.gltf.soldier_ua, assets.gltf.soldier_ru]) for (const c of g?.animations || []) clips[c.name] ||= c;
  const man = assets.manifest.soldiers || {};
  const mc = man.soldier_anims?.clips || man.clips || {};
  for (const [k, v] of Object.entries(mc)) if (v && v.ground_speed_mps > 0) CLIP_SPEED[k] = v.ground_speed_mps;
  SHARED_EVENTS = Object.fromEntries(Object.entries(mc).map(([k, v]) => [k, v.events || {}]));
  SHARED = { clips, manifest: man, assets };
}

// duration of a clip from the shared set (falls back to def when the clip is missing)
export function clipDuration(name, def) { return SHARED?.clips[name]?.duration || def; }
export function hasClip(name) { return !!SHARED?.clips[name]; }
export function clipEvents(name) { return SHARED_EVENTS[name] || {}; }

function pick(arr, r) { return arr[Math.floor(r * arr.length) % arr.length]; }

export class Soldier {
  constructor(squad, idx, role, faction, scene) {
    this.squad = squad; this.idx = idx; this.role = role; this.faction = faction; this.scene = scene;
    this.assault = !!squad.assault;
    const wk = role.weapon === 'primary' ? (faction.id === 'RU' ? 'ak12' : 'ak74o') : role.weapon;
    this.weaponKey = wk; this.weapon = WEAPONS[wk];
    this.grenades = role.grenades ?? 2; this.rpg22 = role.rpg22 || 0; this.armor = ARMOR[role.armor || 'standard'];
    this.mags = role.mags; this.inMag = this.weapon.mag; this.sideKey = role.side; this.sideMags = role.sideMags || 0;
    this.rpgCarried = role.carriesRpg || 0;
    this.hp = TUNING.soldierHp; this.state = 'ok'; // ok | light | critical | stable | dead | evac
    this.stance = 'stand'; this.suppression = 0; this.pos = new THREE.Vector3(); this.heading = 0; this.vel = new THREE.Vector3();
    this.path = null; this.pathI = 0; this.goal = null; this.goalHeading = null; this.speedMul = 1;
    this.target = null; this.fireCd = Math.random(); this.burstLeft = 0; this.reloadT = 0; this.aimT = 0; this.scanT = Math.random() * 0.5;
    this.bleed = 0; this.dragger = null; this.dragging = null; this.treatT = 0;
    this.inside = null; // 'btr' | building slot
    this.visible = true; this.rand = Math.random(); this.animJit = 0.9 + Math.random() * 0.2;
    this.buildVisual();
  }
  get alive() { return this.state !== 'dead' && this.state !== 'evac'; }
  get effective() { return this.state === 'ok' || this.state === 'light'; }
  buildVisual() {
    const A = SHARED.assets, key = this.faction.soldierAsset, g = A.gltf[key];
    const root = this.root = new THREE.Group(); root.name = 'soldier';
    if (g) {
      const m = SkeletonUtils.clone(g.scene); root.add(m); this.model = m;
      // variants: one body (MakeHuman A/B/C), one helmet, random gear, gloves on some
      const r = () => Math.random();
      const pickOf = (pre) => { const set = new Set(); m.traverse(o => { const mm = o.name.match(new RegExp(`^${pre}_([A-Z])(_LOD1)?$`)); if (mm) set.add(mm[1]); }); return [...set][Math.floor(r() * set.size)]; };
      const body = pickOf('body'), helmet = pickOf('helmet');
      // pre-merged single-material presets (combo_N / assault_combo_N) are far cheaper to draw
      const combos = []; m.traverse(o => { const mm = o.name.match(/^((?:assault_|crew_)?combo_\d+)$/); if (mm) combos.push(mm[1]); });
      const pre = this.squad.crew && combos.some(c => c.startsWith('crew_')) ? 'crew_' : this.assault && combos.some(c => c.startsWith('assault_')) ? 'assault_' : '';
      const pool = combos.filter(c => (c.match(/^(assault_|crew_)/)?.[1] || '') === pre);
      const combo = pool.length ? pool[Math.floor(r() * pool.length)] : null;
      const gloves = this.assault || r() < 0.4, backpack = r() < (this.role.weapon === 'rpg7' ? 0.9 : this.assault ? 0.7 : 0.3), knee = this.assault || r() < 0.45;
      const legL = this.faction.id === 'UA' ? r() < 0.35 : r() < 0.15;
      const vis = core => {
        if (/^(assault_|crew_)?combo_\d+(_tape)?$/.test(core)) return !!combo && (core === combo || core === combo + '_tape');
        if (combo) return false; // a combo replaces every per-part node
        let mm = core.match(/^body_([A-Z])$/); if (mm) return mm[1] === body;
        mm = core.match(/^helmet_([A-Z])$/); if (mm) return mm[1] === helmet;
        if (core === 'gloves') return gloves; if (core === 'hands') return !gloves;
        if (core === 'backpack') return backpack; if (core === 'pouches_back') return !backpack && r() < 0.4;
        if (core === 'kneepads') return knee; if (core === 'legband_L') return legL;
        return true;
      };
      const meshes = [], names = new Set(), decided = {};
      m.traverse(o => { if (o.isMesh) { meshes.push(o); names.add(o.name.replace(/\.\d+$/, '')); } });
      this.lods = [];
      for (const o of meshes) {
        o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
        // skinned sub-primitives are children named like the node; walk up to the named node
        let n = o; while (n.parent && n.parent !== m && !/^(body|helmet|hands|gloves|boots|vest|pouches|backpack|kneepads|armband|legband|combo_|assault_combo_|crew_combo_)/.test(n.name)) n = n.parent;
        const base = n.name.replace(/\.\d+$/, ''), core = base.replace(/_LOD\d$/, '');
        o.userData.variantOn = decided[core] ??= vis(core);
        o.userData.lod = /_LOD1$/.test(base) ? 1 : (names.has(core + '_LOD1') || m.getObjectByName(core + '_LOD1')) ? 0 : -1;
        o.visible = o.userData.variantOn && o.userData.lod !== 1;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((mt, i) => { if (/^tape/i.test(mt.name) || /armband|legband|_tape$/i.test(core)) { const c = mt.clone(); c.color.set(this.faction.tape); c.roughness = 0.4; if (Array.isArray(o.material)) o.material[i] = c; else o.material = c; } });
        if (o.userData.lod !== -1) this.lods.push(o);
      }
      if (!this.lods.length) this.lods = null;
      this.dmg = new DamageSkin(meshes.filter(o => o.userData.variantOn), this.faction.id);   // v6: wounds / blood / mud / bandages (soldierDamage.js)
      // rifle sling for this preset (rifle on the back hangs from sling_socket; sling_node shown while it is there)
      const pr = combo ? m.getObjectByName(combo)?.userData?.preset : null;
      this.slingSock = (pr?.sling_socket && m.getObjectByName(pr.sling_socket)) || m.getObjectByName('weapon_socket_sling') || null;
      this.slingNode = (pr?.sling_node && m.getObjectByName(pr.sling_node)) || (this.slingSock ? m.getObjectByName('sling_back') : null);
      if (this.slingNode) this.slingNode.traverse(o => { if (o.isMesh) o.visible = false; });
      this.mixer = new THREE.AnimationMixer(m);
      this.actions = {}; this.cur = null;
      this.spine = m.getObjectByName('Spine1') || m.getObjectByName('Spine') || m.getObjectByName('spine_02');
      this.sockets = { R: m.getObjectByName('weapon_socket'), L: m.getObjectByName('weapon_socket_L'), back: m.getObjectByName('weapon_socket_back'), mag: m.getObjectByName('mag_socket_L') };
      this.attachWeapon();
      this.attachSupportKit();
      if (A.gltf.rpg22 && this.rpg22) this.rpg22Tpl = A.gltf.rpg22.scene;
      if (this.sideKey && A.gltf[this.sideKey]) { const back = m.getObjectByName('weapon_socket_back'); if (back) back.add(A.gltf[this.sideKey].scene.clone()); }
      this.play('idle_rifle', 0);
    } else {
      const fb = Fallback.soldier(this.faction.tape); root.add(fb); this.model = fb; this.fallback = true;
    }
    this.scene.add(root);
  }
  attachWeapon() {
    const A = SHARED.assets, wg = A.gltf[WEAPON_ASSET[this.weaponKey]] || A.gltf.ak74m;
    if (!this.sockets?.R || !wg) return;
    const w = wg.scene.clone(); this.sockets.R.add(w); this.weaponObj = w; this.muzzleObj = w.getObjectByName('muzzle');
    this.wLod = [[], []]; w.traverse(o => { if (o.isMesh) (/_LOD1$/i.test(o.name) ? this.wLod[1] : this.wLod[0]).push(o); }); for (const o of this.wLod[1]) o.visible = false; if (!this.wLod[1].length) this.wLod = null;
    w.traverse(o => { if (o.isMesh) o.castShadow = true; });
    this.mag = w.getObjectByName('magazine'); this.magHome = this.mag ? { parent: this.mag.parent, pos: this.mag.position.clone(), quat: this.mag.quaternion.clone() } : null;
    this.wSock = 'R'; this.far = undefined;
  }
  // swap the carried weapon (ATGM survivor leaving the launcher and drawing his Makarov)
  setWeapon(wk) {
    if (this.weaponKey === wk || !WEAPONS[wk]) return;
    this.weaponKey = wk; this.weapon = WEAPONS[wk]; this.inMag = this.weapon.mag; this.mags = 2; this.reloadT = 0; this.sideKey = null;
    if (this.weaponObj) this.weaponObj.parent?.remove(this.weaponObj);
    this.weaponObj = null; this.muzzleObj = null; this.mag = null; this.wLod = null; this.wSock = null;
    if (!this.dropped) this.attachWeapon();
    for (const o of this.kitObjs || []) if (o.userData.atgmKit || o.userData.atgmFolded) o.parent?.remove(o);
    this.curName = null;
  }
  // ATGM tubes on the bearer's / loader's back, FPV goggles on the pilot, controller carried on the chest
  attachSupportKit() {
    const A = SHARED.assets, r = this.role, m = this.model; this.kitObjs = [];
    const node = (gk, n) => { const g = A.gltf[gk]; const o = g && (n ? g.scene.getObjectByName(n) : g.scene); return o ? o.clone(true) : null; };
    const put = (o, sock, pos, rot, tag) => { if (!o || !sock) return null; o.traverse(x => { if (x.isMesh) { x.castShadow = true; if (/_LOD1$/i.test(x.name)) x.visible = false; } }); o.position.set(...pos); o.rotation.set(...rot); o.userData[tag] = true; sock.add(o); this.kitObjs.push(o); return o; };
    const back = this.sockets.back || m.getObjectByName('Spine2') || m.getObjectByName('Spine1');
    // spare TLC on the loader's / bearer's back (authored in the weapon_socket_back frame: identity), folded tripod on the gunner's
    if (r.atgm === 'bearer' || r.atgm === 'loader') {
      const tn = this.faction.id === 'RU' ? 'tube_kornet' : 'tube_stugna';
      const t = node('atgm_tube_carried', tn); if (t) { t.position.set(0, 0, 0); t.quaternion.identity(); }
      put(t || this.tubeStandIn(), back, [0, 0, 0], [0, 0, 0], 'atgmKit');
    }
    if (r.atgm === 'gunner') { const f = node(this.faction.id === 'RU' ? 'kornet' : 'stugna', 'folded'); if (f) { f.visible = true; put(f, back, [0, 0, 0], [0, 0, 0], 'atgmFolded'); } }
    if (r.fpv === 'pilot') {
      const head = m.getObjectByName('Head') || m.getObjectByName('head');
      const dk = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.55 });
      let gog = node('fpv_goggles'), ha = gog?.getObjectByName('head_attach');
      if (!gog) { // stand-in goggles: visor box + strap
        gog = new THREE.Group(); const v = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.07, 0.08), dk); v.position.set(0, 0.09, 0.1); gog.add(v);
        const st = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.008, 4, 16), dk); st.rotation.x = Math.PI / 2; st.position.set(0, 0.09, 0.0); gog.add(st);
      }
      if (head) put(gog, head, ha ? ha.position.clone().negate().toArray() : [0, 0, 0], [0, 0, 0], 'fpvKit');
      let ctl = node('fpv_controller');
      if (!ctl) { // stand-in radio: body, two sticks, antenna
        ctl = new THREE.Group(); const b = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, 0.11), dk); ctl.add(b);
        for (const x of [-0.05, 0.05]) { const k = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.04, 5), dk); k.position.set(x, 0.035, 0); ctl.add(k); }
        const an = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.12, 4), dk); an.position.set(0.07, 0.04, 0.05); an.rotation.x = -0.6; ctl.add(an);
      }
      this.fpvController = put(ctl, this.sockets.R, [0, 0, 0], [0, 0, 0], 'fpvKit'); if (this.fpvController) this.fpvController.visible = false;
    }
  }
  tubeStandIn() { const g = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 1.2, 10), new THREE.MeshStandardMaterial({ color: 0x4b5039, roughness: 0.8 })); g.rotation.x = 0; return g; }
  // ------------------------------------------------------------ animation
  action(name) {
    if (!this.mixer) return null;
    if (this.actions[name]) return this.actions[name];
    const c = SHARED.clips[name]; if (!c) return null;
    const a = this.mixer.clipAction(c);
    const once = /^(death|fire_launcher|launcher_raise|reload|throw|hit|dismount|hatch_exit|atgm_setup|atgm_fire|atgm_reload|atgm_pack|fpv_launch|dodge_dive|prone_down|prone_up|medevac_cab|medevac_lift|medevac_load|wounded_lifted|wounded_load)/.test(name);
    if (once) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    return this.actions[name] = a;
  }
  play(name, fade = 0.25, timeScale = 1, alt = []) {
    if (this.weaponKey === 'pm' && PISTOL_CLIP[name] && this.action(PISTOL_CLIP[name])) name = PISTOL_CLIP[name];
    const asked = name;
    let a = this.action(name);
    for (let i = 0; !a && i < alt.length; i++) { name = alt[i]; a = this.action(name); }
    if (!a) return;
    // looping clips: every man runs at his own slightly different rate and phase, so a squad never moves (or turns its
    // heads) in lock-step
    const loop = a.loop !== THREE.LoopOnce;
    a.timeScale = timeScale * (loop && !/(walk|run|crawl|drag)/.test(name) ? this.animJit : 1);
    if (this.curName === name) return;
    a.reset(); a.enabled = true; a.setEffectiveWeight(1);
    if (this.cur && fade > 0) a.crossFadeFrom(this.cur, fade, true); else if (this.cur) this.cur.stop();
    if (!/^(death)/.test(name)) a.time = loop ? Math.random() * (a.getClip().duration || 1) : 0;
    a.play(); this.cur = a; this.curName = name;
    // weapon follows the clip: off-hand while throwing, slung while dragging / wounded, dropped on death
    if (this.weaponObj && !this.dropped) {
      if (/^death/.test(name)) setTimeout(() => this.dropWeapon(), ((SHARED_EVENTS[name]?.drop_weapon ?? 0.2) * 1000));
      else if (name === 'fpv_pilot' && SHARED_EVENTS.fpv_pilot?.rifle_ground?.t && this.weaponObj) {
        const rg = SHARED_EVENTS.fpv_pilot.rifle_ground; this.model.add(this.weaponObj); this.weaponObj.position.fromArray(rg.t); this.weaponObj.quaternion.fromArray(rg.q); this.wSock = 'ground'; this.showSling(false);
      }
      else this.weaponTo(/^throw_grenade/.test(name) ? 'L' : /^(drag_wounded|wounded_|being_dragged|treat_wounded|medevac_)/.test(name) || /^(atgm_|fpv_launch|fpv_pilot)/.test(asked) ? 'back' : 'R');
    }
  }
  // v7: the grenade in the right hand (weapon_socket) from the throw clip's pin pull to its release (events); combat.startThrow /
  // grenadeHeld fly it from the hand at the release
  handGrenadeTick() {
    const ev = SHARED_EVENTS[this.curName] || {}, t = this.cur?.time ?? 0;
    const on = this.throwT > 0 && this.state !== 'dead' && /^throw_grenade/.test(this.curName || '') && t >= (ev.pin_pull ?? 0.1) && t < (ev.release ?? ev.release_approx ?? 0.8);
    if (on && !this.handGrenade && this.sockets?.R) {
      const A = SHARED.assets.gltf, tpl = (this.rand < 0.5 ? A.grenade_rgd5 : A.grenade_f1) || A.grenade_f1 || A.grenade_rgd5;
      if (tpl) { const o = this.handGrenade = tpl.scene.clone(); o.traverse(x => { if (x.isMesh) { x.castShadow = true; if (/_LOD1$/i.test(x.name)) x.visible = false; } }); this.sockets.R.add(o); }
    }
    if (this.handGrenade && this.handGrenade.visible !== on) this.handGrenade.visible = on;
  }
  // RPG-22: shoulder a disposable launcher, fire, throw the empty tube away
  raiseLauncher() {
    if (!this.rpg22Tpl || this.launcherObj) return;
    this.launcherObj = this.rpg22Tpl.clone(); this.launcherObj.traverse(o => { if (o.isMesh) o.castShadow = true; });
    if (this.weaponObj) this.weaponObj.visible = false;
    (this.sockets?.R || this.root).add(this.launcherObj);
    this.muzzleObjSaved = this.muzzleObj; this.muzzleObj = this.launcherObj.getObjectByName('muzzle') || this.muzzleObj;
  }
  discardLauncher() {
    const l = this.launcherObj; if (!l) return; this.launcherObj = null;
    const p = l.getWorldPosition(new THREE.Vector3()); this.scene.add(l);
    l.position.set(p.x + (Math.random() - .5), 0.05, p.z + (Math.random() - .5)); l.rotation.set(0, Math.random() * 6.28, Math.PI / 2); l.updateMatrixWorld(true);
    if (this.weaponObj) this.weaponObj.visible = true; this.muzzleObj = this.muzzleObjSaved || this.muzzleObj;
  }
  weaponTo(k) {
    if (this.wSock === k || !this.sockets[k]) return;
    // slung on the back: the rifle hangs on its sling (preset-specific socket over whatever gear is on the back) and the sling shows
    let sock = this.sockets[k];
    if (k === 'back' && this.slingSock) sock = this.slingSock;
    sock.add(this.weaponObj); this.weaponObj.position.set(0, 0, 0); this.weaponObj.quaternion.identity(); this.wSock = k;
    this.showSling(k === 'back' && !!this.slingSock);
  }
  showSling(on) { if (this.slingNode && this.slingOn !== on) { this.slingOn = on; this.slingNode.traverse(o => { if (o.isMesh) o.visible = on; }); } }
  dropWeapon() {
    if (this.dropped || !this.weaponObj) return; this.dropped = true; this.showSling(false);
    const w = this.weaponObj; const p = w.getWorldPosition(new THREE.Vector3());
    const gh = this.squad?.game?.city?.groundHeight, wx = p.x + (Math.random() - .5) * 0.6, wz = p.z + (Math.random() - .5) * 0.6;
    this.scene.add(w); w.position.set(wx, (this.inBuilding || !gh ? this.pos.y : gh(wx, wz)) + 0.04, wz);
    w.rotation.set(0, Math.random() * Math.PI * 2, Math.PI / 2 * (Math.random() < .5 ? 1 : -1)); w.updateMatrixWorld(true);
    this.droppedWeapon = w;
  }
  magTick() {
    if (!this.mag || !this.sockets.mag || !this.cur) return;
    const ev = SHARED_EVENTS[this.curName]; const t = this.cur.time;
    const out = ev && ev.mag_out != null && t >= ev.mag_out && t < ev.mag_in;
    if (out && this.mag.parent !== this.sockets.mag) { this.sockets.mag.add(this.mag); this.mag.position.set(0, 0, 0); this.mag.quaternion.identity(); }
    else if (!out && this.mag.parent !== this.magHome.parent) { this.magHome.parent.add(this.mag); this.mag.position.copy(this.magHome.pos); this.mag.quaternion.copy(this.magHome.quat); }
  }
  animate(dt, camDist) {
    damageTick(this, dt);
    if (this.state === 'dead' && this.deathTick(dt, camDist)) return;
    const sp = this.vel.length();
    const st = this.stance;
    let clip, ts = 1, alt = [];
    // v5: getting down / up is a real move (prone_down / prone_up, ~0.9 s, the man holds still meanwhile) instead of a 0.3 s
    // cross-fade that swung the whole body about the hips through the ground; not for dives, wounded, riders, or a man who
    // flips stance again within 1.5 s (just the cross-fade then)
    this.stanceAge = (this.stanceAge || 0) + dt;
    if (st !== this.lastSt) {
      const was = this.lastSt; this.lastSt = st;
      if (was && this.stanceAge > 1.5 && (was === 'prone') !== (st === 'prone') && (this.state === 'ok' || this.state === 'light') && !this.inside && !(this.dodgeT > 0) && this.mixer) {
        const n = st === 'prone' ? 'prone_down' : 'prone_up';
        if (hasClip(n)) { this.proneTrans = n; this.proneTransT = clipDuration(n, 0.9); this.aimStopT = Math.max(this.aimStopT || 0, this.proneTransT * 0.85); }
      } else this.proneTransT = 0;
      this.stanceAge = 0;
    }
    if (this.proneTransT > 0) this.proneTransT -= dt;
    if (this.state === 'dead') { clip = this.deathClip; }
    else if (this.state === 'critical' || this.state === 'stable') {
      if (this.dragger && this.dragger.dragPhase === 'drag') { clip = 'being_dragged'; alt = ['wounded_ground']; }
      else if (this.state === 'stable') { clip = 'wounded_sit'; alt = ['wounded_ground']; }
      else if (sp > 0.05) { clip = 'wounded_crawl'; ts = sp / CLIP_SPEED.wounded_crawl; }
      else clip = 'wounded_ground';
    } else if (this.inside === 'ride') {
      if (this.deckWalk) { clip = 'crouch_walk'; ts = THREE.MathUtils.clamp(sp / (CLIP_SPEED.crouch_walk || 1), 0.5, 1.8); alt = ['walk_rifle']; }   // crossing the deck to jump off the other side
      else { clip = this.dmWait != null ? 'ride_sit_edge' : this.target ? 'ride_aim' : (this.seatType === 'deck' ? 'ride_sit_deck' : 'ride_sit_edge'); alt = ['ride_sit_edge', 'crouch_idle']; }   // about to jump: the jump clip's frame 0
    }
    else if (this.hatchT > 0) { clip = this.hatchClip || 'hatch_exit'; alt = ['hatch_exit', 'dismount_jump', 'crouch_idle']; if (this.weaponObj) this.weaponObj.visible = this.hatchT < 0.5; }
    else if (this.jumpT > 0) { clip = this.jumpClip || 'dismount_jump'; alt = ['dismount_jump', 'crouch_idle']; }
    else if (this.launcherT > 0) {
      const k = this.stance === 'stand' ? '' : '_kneel', aim = 'aim_launcher' + k;
      if (this.launchFired) { clip = 'fire_launcher' + k; alt = ['fire_launcher', aim]; }
      else if (this.launcherT > 1.9) { clip = 'launcher_raise' + k; alt = ['launcher_raise', aim, 'aim_launcher']; }
      else { clip = aim; alt = ['aim_launcher', 'aim_stand']; }
    }
    else if (this.dragging && this.dragPhase === 'treat') { clip = 'treat_wounded'; alt = ['crouch_idle']; }
    else if (this.dragging && this.dragPhase === 'drag') { clip = 'drag_wounded'; ts = Math.max(0.3, sp / CLIP_SPEED.drag_wounded); alt = ['crouch_walk', 'walk_rifle']; }
    else if (this.hitT > 0) { clip = 'hit_react'; }
    else if (this.throwT > 0) { clip = this.throwClip || (this.throwWindow ? 'throw_grenade_window' : 'throw_grenade_over'); alt = ['throw_grenade_over', 'throw_grenade']; }   // v7: combat.startThrow picks the clip
    else if (this.stackT > 0) { clip = 'cqb_stack'; alt = ['crouch_idle']; }
    else if (this.dodgeT > 0) { clip = this.dodgeClip || 'dodge_dive'; alt = ['dodge_dive', 'pinned_prone', 'prone_idle']; }
    else if (this.proneTransT > 0 && !this.dragging && sp < 0.4) { clip = this.proneTrans; alt = [st === 'prone' ? 'prone_idle' : 'crouch_idle']; }
    else if (this.supportClip && sp < 0.15) { clip = this.supportClip; ts = this.supportTs || 1; alt = this.supportAlt || ['crouch_idle']; }
    else if (this.droneAlertT > 0 && sp < 0.15 && !this.ducking && this.weaponKey !== 'rpg7') { clip = 'drone_shoot'; alt = ['aim_stand']; }
    else if (sp > 0.15) {
      // prone: low crawl (flat, slow) or, moving faster (squad.js: longer bounds while not under heavy fire), the high crawl on
      // forearms and knees; hysteresis so the two don't flicker while the speed settles
      if (st === 'prone') { this.hiCrawl = sp > 0.6 ? true : sp < 0.5 ? false : !!this.hiCrawl; clip = this.hiCrawl && hasClip('high_crawl') ? 'high_crawl' : 'prone_crawl'; alt = ['prone_crawl', 'crouch_walk']; }
      else if (this.state === 'light' && this.legWound) clip = 'limp_walk';
      else if (st === 'crouch' && sp < 2.2) clip = 'crouch_walk';
      else if (sp > 2.4) clip = 'run_rifle'; else clip = 'walk_rifle';
      ts = THREE.MathUtils.clamp(sp / (CLIP_SPEED[clip] || 1.4), 0.5, 1.8);
      alt.push('walk_rifle');
    } else if (this.reloadT > 0) { clip = st === 'stand' ? 'reload_stand' : 'reload_crouch'; alt = ['reload_stand', 'aim_crouch']; }
    else if (this.ducking) { if (st === 'prone') { clip = 'pinned_prone'; alt = ['prone_idle']; } else { clip = 'cover_duck'; alt = ['suppressed_cower', 'crouch_idle']; } }
    else if (this.peek && this.target) { const L = this.peek < 0 ? 'left' : 'right', c = st === 'stand' ? '' : 'crouch_'; clip = (this.firingT > 0 ? 'fire_peek_' : 'peek_') + c + L; alt = this.firingT > 0 ? ['peek_' + c + L, st === 'stand' ? 'aim_stand' : 'aim_crouch'] : [st === 'stand' ? 'aim_stand' : 'aim_crouch']; }
    else if ((this.target || this.groundAim) && this.firingT > 0) { clip = st === 'prone' ? 'fire_prone' : st === 'crouch' ? 'fire_crouch' : 'fire_stand'; alt = [st === 'prone' ? 'aim_prone' : st === 'crouch' ? 'aim_crouch' : 'aim_stand']; }
    else if (this.target || this.groundAim) { clip = st === 'prone' ? 'aim_prone' : st === 'crouch' ? 'aim_crouch' : 'aim_stand'; alt = ['aim_stand', 'idle_rifle']; }
    else { clip = st === 'prone' ? 'prone_idle' : st === 'crouch' ? 'crouch_idle' : 'idle_rifle'; alt = ['idle_rifle']; }
    // v5: a man lying on a slope lies along it (pitch the model about the hips to the ground under head and feet) instead of
    // poking his head into the rise or floating over a dip
    if (this.mixer && this.model && this.state !== 'dead') {
      let px = 0;
      if (st === 'prone' && (this.state === 'ok' || this.state === 'light') && !this.inside && !(this.proneTransT > 0) && !(this.dodgeT > 0)) {
        const gh = this.squad?.game?.city?.groundHeight;
        if (gh) { const fx = Math.sin(this.heading) * 0.8, fz = Math.cos(this.heading) * 0.8; px = THREE.MathUtils.clamp(-Math.atan2(gh(this.pos.x + fx, this.pos.z + fz) - gh(this.pos.x - fx, this.pos.z - fz), 1.6), -0.35, 0.35); }
      }
      if (px || this.model.rotation.x) { this.model.rotation.x += (px - this.model.rotation.x) * Math.min(1, dt * 5); if (Math.abs(this.model.rotation.x) < 1e-4 && !px) this.model.rotation.x = 0; }
    }
    if (this.netClip && this.state !== 'dead') { clip = this.netClip; alt = ['idle_rifle']; ts = this.netTs || 1; }   // versus joiner: the host's exact clip
    if (this.mixer) {
      this.play(clip, this.state === 'dead' ? 0.12 : 0.3, ts, alt);
      if (this.netClip && this.cur && this.netClipT != null && Math.abs(this.cur.time - this.netClipT) > 0.35) this.cur.time = this.netClipT;
      // animation LOD: update distant soldiers less often
      this.animAcc = (this.animAcc || 0) + dt;
      // (not drawn - off screen, or an enemy nobody has spotted / a man in a cellar - is the same as off screen)
      const every = this.inView === false || this.visible === false ? 0.5 : camDist > 160 ? 0.12 : camDist > 90 ? 0.06 : 0;
      if (this.animAcc >= every) { const adv = this.animAcc; this.mixer.update(adv); this.animAcc = 0; if (camDist < 60) this.magTick(); if (this.state === 'dead') this.deathSample(adv); }
      // recoil kick (procedural additive on spine)
      if (this.kick > 0 && this.spine) { this.spine.rotation.x -= this.kick * 0.06; this.kick = Math.max(0, this.kick - dt * 12); }
      if (this.throwT > 0 || this.handGrenade) this.handGrenadeTick();
      if (this.lods) { const far = camDist > 70; if (far !== this.far) { this.far = far; for (const o of this.lods) o.visible = o.userData.variantOn && o.userData.lod === (far ? 1 : 0); if (this.wLod) { for (const o of this.wLod[0]) o.visible = !far; for (const o of this.wLod[1]) o.visible = far; } } }
    } else {
      // fallback pose
      const m = this.model;
      const h = this.state === 'dead' || this.state === 'critical' || this.state === 'stable' ? 0 : st === 'prone' ? 0.15 : st === 'crouch' ? 0.7 : 1;
      m.scale.y += (h * 0.999 + 0.001 - m.scale.y) * Math.min(1, dt * 6);
      if (this.state === 'dead' || this.state === 'critical' || this.state === 'stable') { m.rotation.x = -Math.PI / 2 * 0.95; m.scale.y = 1; m.position.y = 0.2; }
      else { m.rotation.x = 0; m.position.y = sp > 0.1 ? Math.abs(Math.sin(performance.now() * 0.012 * sp)) * 0.06 : 0; }
    }
    this.firingT = Math.max(0, (this.firingT || 0) - dt);
    // corner peek cycle: lean out, fire, lean back into cover, repeat
    if (this.peek && this.target && this.state !== 'dead') { this.peekT = (this.peekT ?? 0) - dt; if (this.peekT <= 0) { this.peekOut = !this.peekOut; this.peekT = this.peekOut ? 1.5 + Math.random() * 1.5 : 0.9 + Math.random() * 1.3; } }
    else { this.peekOut = false; if (!this.target || this.vel.lengthSq() > 0.2) this.peek = 0; }
    this.peekAmt = (this.peekAmt || 0) + (((this.peek && this.peekOut) ? 1 : 0) - (this.peekAmt || 0)) * Math.min(1, dt * 6);
    this.hitT = Math.max(0, (this.hitT || 0) - dt); this.throwT = Math.max(0, (this.throwT || 0) - dt); this.jumpT = Math.max(0, (this.jumpT || 0) - dt); this.hatchT = Math.max(0, (this.hatchT || 0) - dt); this.stackT = Math.max(0, (this.stackT || 0) - dt); this.dodgeT = Math.max(0, (this.dodgeT || 0) - dt); this.droneAlertT = Math.max(0, (this.droneAlertT || 0) - dt);
    if (this.fpvController) { const on = this.supportClip === 'fpv_pilot'; if (this.fpvController.visible !== on) this.fpvController.visible = on; }
  }
  sync() {
    this.root.position.copy(this.pos);
    if (this.peekAmt > 0.01 && this.peekVec) { this.root.position.x += this.peekVec[0] * this.peekAmt * 0.45; this.root.position.z += this.peekVec[1] * this.peekAmt * 0.45; }
    this.root.rotation.y = this.heading;
    // v7 bail-out (vehicle.bailCrew): the hatch clip's root is warped from the vehicle's real hatch rim (start) to the landing spot on
    // the terrain (end), blended during the jump (events jump -> ground)
    const W = this.hatchWarp;
    if (W && this.inside !== 'btr') {
      if (this.hatchT > 0 && (this.state === 'ok' || this.state === 'light')) {   // (downed on the way: the wounded clip plays at the landing spot, not up on the hull)
        const t = this.curName === W.clip && this.cur ? this.cur.time : 0, k = 1 - THREE.MathUtils.smoothstep(t, W.t0, W.t1);
        this.root.position.x += W.dx * k; this.root.position.y += W.dy * k; this.root.position.z += W.dz * k;
      } else this.hatchWarp = null;   // done (or killed on the way: the body drops at the landing spot)
    }
    this.root.visible = this.visible && (this.inside !== 'btr' || this.inCab) && (this.state !== 'evac' || !!this.onBed) && this.inView !== false;   // onBed: on the medevac pickup
  }
  muzzleWorld(out = new THREE.Vector3()) {
    if (this.muzzleObj) return this.muzzleObj.getWorldPosition(out);
    const h = this.stance === 'prone' ? 0.3 : this.stance === 'crouch' ? 1.0 : 1.45;
    return out.set(this.pos.x + Math.sin(this.heading) * 0.7, this.pos.y + h, this.pos.z + Math.cos(this.heading) * 0.7);
  }
  get inBuilding() { return !!this.inside && typeof this.inside === 'object'; }
  get bld() { return this.inBuilding ? this.inside.panel.b : null; }
  get aboard() { return this.inside === 'btr' || this.inside === 'ride'; }
  headHeight() { if (this.inside === 'ride') return 1.0; return this.state !== 'ok' && this.state !== 'light' ? 0.3 : this.stance === 'prone' ? (this.ducking ? 0.22 : 0.35) : this.stance === 'crouch' ? (this.ducking ? 0.75 : 1.05) : 1.55; }
  // ------------------------------------------------------------ death
  // die(kind, { from, blast, power, head }): from = shooter / explosion position (Vector3), blast = explosion, power = damage dealt,
  // head = headshot.  The clip follows the hit direction relative to his facing, his stance and speed; the corpse is then handed to
  // the ragdoll (ragdoll.js) so it settles onto the real terrain (near the camera only): at the clip's 'ragdoll' event, earlier when the
  // ground under the falling body is uneven, at once (with an impulse) for blasts; on level ground the authored clip ends it instead.
  die(kind, info = {}) {
    const wasDown = this.state === 'critical' || this.state === 'stable', speed = this.vel.length();
    this.state = 'dead'; this.target = null; this.path = null; this.vel.set(0, 0, 0); this.jumpT = 0;   // (deathTick never ticks jumpT down)
    // leaning out of a corner: the body is where it was drawn (sync() adds the peek offset to the root) - no jump when it lapses
    if (this.peekAmt > 0.01 && this.peekVec && !this.aboard) { this.pos.x += this.peekVec[0] * this.peekAmt * 0.45; this.pos.z += this.peekVec[1] * this.peekAmt * 0.45; }
    this.peek = 0; this.peekAmt = 0; this.peekOut = false;
    this.deathRide = this.inside === 'ride' ? this.pos.y : null;   // deck height: squad.updateRiders drops him beside the vehicle
    this.deathInfo = { ...(info || {}), from: info?.from?.clone?.() || null }; this.deathT = 0; this.corpseDone = false; this.ragdoll = null; this._pp0 = this._pp1 = null;
    { const gh = this.squad?.game?.city?.groundHeight; if (gh && !this.inside && this.squad.game.city.trenchInfo?.(this.pos.x, this.pos.z)) this.alignTrench(gh); }
    this.deathClip = this.pickDeath(kind, this.deathInfo, wasDown, speed);
    const ev = SHARED_EVENTS[this.deathClip] || {};
    this.ragdollAt = ev.ragdoll != null && ev.ragdoll >= 0 ? ev.ragdoll : null;
    if (this.deathInfo.blast && this.ragdollAt != null) this.ragdollAt = Math.min(this.ragdollAt, 0.12);
    // v7: killed while a medic has him on the shoulder / is sliding him onto the pickup bed (the casualty clips put the body up to
    // 1.6 m above his root): he falls off (ragdoll from that pose) instead of the lying death clip snapping him to the medic's feet
    this.carriedDeath = /^(wounded_lifted|wounded_carry_walk|wounded_load_bed)/.test(this.curName || '') && !this.inBuilding ? (this.dragger?.squad?.medevac?.pos || this.dragger?.pos || this.pos).clone() : null;
    if (this.dragging) { this.dragging.dragger = null; this.dragging = null; }
    if (this.dragger) { this.dragger.dragging = null; this.dragger = null; }
  }
  pickDeath(kind, info, wasDown, speed) {
    const has = n => !!SHARED?.clips[n], r = Math.random();
    if (wasDown && has('death_bleedout')) return 'death_bleedout';         // lying casualty: no standing-up death clip
    if (!has('death_fall_back')) return kind || pick(['death_front', 'death_back', 'death_crumple'], r);   // old clip set
    if (kind && kind !== 'death_crumple' && has(kind)) return kind;
    const f = info.from;
    let rel = null;      // bearing of the hit relative to his facing: 0 = from the front, +PI/2 = from his left
    if (f && Math.hypot(f.x - this.pos.x, f.z - this.pos.z) > 0.2) { rel = Math.atan2(f.x - this.pos.x, f.z - this.pos.z) - this.heading; rel = Math.atan2(Math.sin(rel), Math.cos(rel)); }
    if (this.inBuilding) return info.blast || r < 0.5 ? 'death_window_back' : 'death_window_slump';
    if (this.inside === 'ride') return 'death_headshot';
    if (info.blast) {
      if (rel == null || Math.abs(rel) < 0.9) { if (rel != null) this.heading += rel; return 'death_blast'; }   // turned to face it: thrown back, away from it
      if (Math.abs(rel) > 2.3) return 'death_fall_forward';
      return rel > 0 ? 'death_spin_L' : 'death_spin_R';
    }
    if (this.stance === 'prone') return 'death_prone';
    if (this.stance === 'crouch') return 'death_crouch';
    if (info.head) return 'death_headshot';
    if (speed > 2.4) return 'death_run';
    if (rel == null) return pick(['death_fall_back', 'death_sit_slump', 'death_knees', 'death_fall_forward', 'death_crumple'], r);
    const ar = Math.abs(rel);
    if (ar < 0.85) return r < 0.45 ? 'death_fall_back' : r < 0.75 ? 'death_sit_slump' : r < 0.9 ? 'death_knees' : 'death_crumple';
    if (ar > 2.3) return r < 0.75 ? 'death_fall_forward' : 'death_knees';
    return rel > 0 ? 'death_spin_L' : 'death_spin_R';
  }
  // per frame while dead; true = handled (ragdoll running / corpse frozen: the clip is not updated)
  deathTick(dt, camDist) {
    if (this.corpseDone) { this.lodTick(camDist); return true; }
    if (this.ragdoll) { this.ragdoll.update(dt); return true; }
    if (!this.mixer) return false;
    this.deathT += dt;
    const gh = this.squad?.game?.city?.groundHeight;
    if (this.carriedDeath) {
      const from = this.carriedDeath; this.carriedDeath = null;
      if (this.canRagdoll(camDist) && ragdollSlot()) { this.dropFrom = from; this._pp0 = this._pp1 = null; this.play(this.deathClip, 0); this.startRagdoll(); this.dropFrom = null; return true; }
      // no ragdoll (far away / capped): the lying clip plays where his body was, on the ground
      const hips = this.hipsBone ||= this.model.getObjectByName('Hips');
      if (hips) { this.model.updateWorldMatrix(true, true); const hp = hips.getWorldPosition(_dv); this.pos.x = hp.x; this.pos.z = hp.z; }
      if (gh) this.pos.y = gh(this.pos.x, this.pos.z);
      this.root.position.copy(this.pos);
    }
    if (this.deathRide != null && this.inside !== 'ride') {
      // squad.updateRiders has put the dead rider on the ground beside the vehicle (y = 0): real ground there; near the camera he
      // falls from deck height (the ragdoll drops him), otherwise he simply lies there
      // it picks a spot within +-1.5 m of the seat: move it out of the hull footprint (to the nearer side) so the body is not inside the vehicle
      const v = this.squad?.carrier, deck = this.deathRide; this.deathRide = null;
      if (v?.pos && v.def) {
        const fx = Math.sin(v.heading), fz = Math.cos(v.heading), dx = this.pos.x - v.pos.x, dz = this.pos.z - v.pos.z;
        const along = dx * fx + dz * fz; let side = dx * fz - dz * fx; const hw = v.def.width / 2 + 0.4, hl = v.def.length / 2 + 0.3;
        if (Math.abs(along) < hl && Math.abs(side) < hw) { side = (side >= 0 ? 1 : -1) * (hw + Math.random() * 0.5); this.pos.x = v.pos.x + along * fx + side * fz; this.pos.z = v.pos.z + along * fz - side * fx; }
      }
      const y = gh ? gh(this.pos.x, this.pos.z) : 0;
      this.pos.y = y; this.root.position.copy(this.pos);
      if (this.canRagdoll(camDist) && deck > y + 0.5 && ragdollSlot()) {
        this.pos.y = Math.min(deck, y + 1.6); this.root.position.copy(this.pos); this._pp0 = this._pp1 = null;
        this.deathFromDeck = true; this.startRagdoll(); this.deathFromDeck = false; return true;
      }
    }
    // v7: killed in the air / above the ground (mid-jump off a deck, on the hatch rim, a ramp, a dead casualty's root left up):
    // nothing re-grounds a dead man's root, the body lay at that height ('floating'). It falls (ragdoll) or is put on the ground.
    if (this.deathT < 0.5 && gh && !this.aboard && !this.onBed && !this.hatchWarp && !this.ragdoll && !this.inStructure()) {
      const y0 = gh(this.pos.x, this.pos.z);
      if (this.pos.y > y0 + 0.3 && this.squad.game.city.trenchInfo?.(this.pos.x, this.pos.z)) { this.pos.y = y0; this.alignTrench(gh); }   // up on the fire step: onto the floor, along the trench
      else if (this.pos.y > y0 + 0.3) {
        if (this.canRagdoll(camDist) && ragdollSlot()) { this.root.position.copy(this.pos); this._pp0 = this._pp1 = null; this.play(this.deathClip, 0); this.startRagdoll(); return true; }
        this.pos.y = y0;
      }
    }
    if (this.ragdollAt != null && this._pp1 && this._pp0 && this.canRagdoll(camDist)) {   // two samples: hand-off velocity
      let go = this.deathT >= this.ragdollAt;
      // the clip assumes flat ground at the root's height: once the body leans out over a trench edge, a slope or a heap (> 0.25 m
      // above / below the root) the ragdoll takes over at once and lets it fall onto the real surface
      let uneven = false;
      if (!go && this.deathT > 0.3 && gh && !this.inStructure()) {   // (inside, clearing an upper floor / in a cellar: stays on that floor)
        const hips = this.hipsBone ||= this.model.getObjectByName('Hips');
        if (hips) { const hp = hips.getWorldPosition(_dv); if (Math.abs(gh(hp.x, hp.z) - this.pos.y) > 0.25) go = uneven = true; }
      }
      // level ground under the body now and under the clip's rest pose: the authored clip is the better ending - no ragdoll
      if (go && !uneven && !this.deathInfo.blast && this.levelUnder(gh)) this.ragdollAt = null;
      else if (go && ragdollSlot()) { this.startRagdoll(); return true; }
    }
    if (this.deathT > clipDuration(this.deathClip, 2.5) + 0.25) { this.finalizeCorpse(); return true; }
    return false;
  }
  // is the ground within 8 cm of the root height under every joint of the current pose and of the clip's last frame?
  levelUnder(gh) {
    if (!gh || !this.cur || !this._pp1) return false;
    const y = this.pos.y, ok = P => P.every(p => Math.abs(gh(p.x, p.z) - y) < 0.08);
    if (!ok(this._pp1)) return false;
    const a = this.cur, t0 = a.time; a.time = a.getClip().duration; this.mixer.update(0);
    const end = samplePose(this.model); a.time = t0; this.mixer.update(0);
    return ok(end);
  }
  // v7: a man dying in a trench lies along it (the lying clips assume open ground: across the trench his limbs went into the walls)
  alignTrench(gh) {
    const p = this.pos, y = gh(p.x, p.z); let best = null, bs = 1e9;
    for (let k = 0; k < 8; k++) { const a = this.heading + k * Math.PI / 4, r = Math.abs(gh(p.x + Math.sin(a) * 0.9, p.z + Math.cos(a) * 0.9) - y) + Math.abs(gh(p.x - Math.sin(a) * 0.9, p.z - Math.cos(a) * 0.9) - y); if (r < bs - 0.05) { bs = r; best = a; } }
    if (best != null) this.heading = best;
  }
  canRagdoll(camDist) { return camDist < 90 && !this.inStructure() && !this.aboard && !!this.squad?.game?.city?.groundHeight; }
  // v7: inside a block / house (also a man knocked down at a window: combat.hitSoldier clears his slot, `inside`): the terrain
  // height field is not his floor - no ragdoll onto it, no re-grounding (the dead fell through the floors to the ground)
  inStructure() {
    if (this.inBuilding || this.cqb || this.cellar) return true;
    const g = this.squad?.game; if (!g) return false;
    return !!(g.city?.buildingAt?.(this.pos.x, this.pos.z, 0.3) || g.houses?.at?.(this.pos.x, this.pos.z, 0.2));
  }
  // pose after each clip update while a ragdoll hand-off is pending (two frames: velocity at the hand-off)
  deathSample(dt) {
    if (this.ragdollAt == null || this.corpseDone || this.ragdoll || this.deathT < Math.min(0.22, this.ragdollAt - 0.2)) return;   // from 0.22 s: early hand-off over uneven ground
    const t = this._pp0; this._pp0 = this._pp1; this._pp1 = samplePose(this.model, t); this._ppDt = dt;
  }
  startRagdoll() {
    const g = this.squad.game, info = this.deathInfo, cur = samplePose(this.model);
    const away = new THREE.Vector3();
    if (info.from) { away.set(this.pos.x - info.from.x, 0, this.pos.z - info.from.z); if (away.lengthSq() > 1e-4) away.normalize(); else away.set(0, 0, 0); }
    const opt = { ground: g.city.groundHeight, start: cur, prev: this._pp0, prevDt: this._ppDt || 1 / 60, drive: 0.03, onSleep: rd => this.freezeRagdoll(rd) };
    if (info.blast) {
      const k = THREE.MathUtils.clamp((info.power || 80) / 140, 0.3, 1.2);
      // death_blast is itself the launch (the clip's velocity carries on): the damage only adds / takes off a little; the other clips
      // (blast from a side / behind) barely move at the hand-off: the impulse throws them
      opt.impulse = this.deathClip === 'death_blast' ? away.clone().multiplyScalar((k - 0.6) * 2).setY((k - 0.6) * 0.8) : away.clone().multiplyScalar(1.0 + 2.0 * k).setY(0.4 + 1.0 * k);
      opt.spin = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), away).multiplyScalar((this.deathClip === 'death_blast' ? 0.8 : 3) * k);   // tumble away from it: omega x up = away, the head goes over backwards (death_blast already rotates)
      opt.drive = 0.015;
    } else if (info.from) opt.push = away.clone().multiplyScalar(0.9);
    if (this.dropFrom) {   // v7: off the medic's shoulder / the tailgate, away from him / the truck
      const o = new THREE.Vector3(this.pos.x - this.dropFrom.x, 0, this.pos.z - this.dropFrom.z), hp = this.model.getObjectByName('Hips')?.getWorldPosition(new THREE.Vector3());
      if (hp) o.set(hp.x - this.dropFrom.x, 0, hp.z - this.dropFrom.z);
      opt.impulse = (o.lengthSq() > 1e-4 ? o.normalize() : o.set(Math.random() - .5, 0, Math.random() - .5).normalize()).multiplyScalar(0.7).setY(0.2); opt.push = null;
    }
    if (this.deathFromDeck) {   // off the deck, away from the hull
      const v = this.squad?.carrier, o = v?.pos ? new THREE.Vector3(this.pos.x - v.pos.x, 0, this.pos.z - v.pos.z) : new THREE.Vector3(Math.random() - .5, 0, Math.random() - .5);
      opt.impulse = (o.lengthSq() > 1e-4 ? o.normalize() : o.set(1, 0, 0)).multiplyScalar(0.8 + Math.random() * 0.6).setY(0.5);
    }
    this.ragdoll = new Ragdoll(this.model, opt);
    // shape target: the clip's authored rest pose (its last frame), then back to the ragdoll pose at once
    const a = this.cur; if (a) { a.time = a.getClip().duration; this.mixer.update(0); this.ragdoll.setTarget(samplePose(this.model)); }
    this.ragdoll.writeBones();
    this._pp0 = this._pp1 = null;
  }
  freezeRagdoll(rd) {
    // the corpse's logical position = where the pelvis came to rest (on the ground under it); bones re-expressed for the new root
    if (this.ragdoll !== rd) return;
    rd.pelvisGround(this.pos); this.root.position.copy(this.pos); this.root.updateWorldMatrix(true, true);
    rd.writeBones(); this.ragdoll = null; this.corpseDone = true;
  }
  // no ragdoll (far away, inside a building, ragdolls capped): the clip has ended - stop updating it; the logical position moves
  // to where the body lies (root motion), the skeleton is re-expressed for it; ground height re-read there (outside buildings)
  finalizeCorpse() {
    this.corpseDone = true;
    const hips = this.model?.getObjectByName?.('Hips');
    if (!hips || this.aboard || this.inStructure()) return;   // (inside: on that floor, as the clip ends)
    this.model.updateWorldMatrix(true, true);
    const hw = hips.getWorldPosition(new THREE.Vector3()), gh = this.squad?.game?.city?.groundHeight;
    const ny = gh ? gh(hw.x, hw.z) : this.pos.y;
    hw.y += ny - this.pos.y;
    this.pos.set(hw.x, ny, hw.z); this.root.position.copy(this.pos); this.root.updateWorldMatrix(true, true);
    hips.parent.worldToLocal(hw); hips.position.copy(hw);
    if (gh) this.restOnGround(gh);
  }
  // v7: a corpse that ended its death clip without a ragdoll (far from the camera, ragdolls capped) lay as the clip left it - on
  // flat ground at the root's height: on a slope / verge / heap one end floated and the other sank (and it stays like that when
  // the camera comes closer). Tilt it onto the local ground plane (slopes up to ~25 deg; not across a trench wall), then settle
  // it so its lowest joints rest on the surface.
  restOnGround(gh) {
    const p = this.pos, d = 0.6, gx = (gh(p.x + d, p.z) - gh(p.x - d, p.z)) / (2 * d), gz = (gh(p.x, p.z + d) - gh(p.x, p.z - d)) / (2 * d);
    if (gx * gx + gz * gz > 0.0009 && gx * gx + gz * gz < 0.22) {
      const n = new THREE.Vector3(-gx, 1, -gz).normalize(), qT = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
      const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.heading);
      this.model.quaternion.premultiply(qy.clone().invert().multiply(qT).multiply(qy));
      this.root.updateWorldMatrix(true, true);
    }
    const cl = [], v = new THREE.Vector3(), g0 = gh(p.x, p.z);
    // (joints over a step in the ground - a trench wall / lip, a heap edge - don't count: the body is not lifted onto it)
    this.model.traverse(o => { if (o.isBone && !/Finger|Thumb|End$/i.test(o.name)) { o.getWorldPosition(v); const gy = gh(v.x, v.z); if (Math.abs(gy - g0) < 0.3) cl.push(v.y - gy); } });
    if (cl.length < 4) return;
    cl.sort((a, b) => a - b);
    const dy = THREE.MathUtils.clamp(0.05 - (cl[1] + cl[2] + cl[3]) / 3, -0.3, 0.3);   // lowest joints ~5 cm up (inside the body)
    if (Math.abs(dy) > 0.02) { this.pos.y += dy; this.root.position.copy(this.pos); this.root.updateWorldMatrix(true, true); }
  }
  lodTick(camDist) {
    if (!this.lods) return; const far = camDist > 70; if (far === this.far) return; this.far = far;
    for (const o of this.lods) o.visible = o.userData.variantOn && o.userData.lod === (far ? 1 : 0);
    if (this.wLod) { for (const o of this.wLod[0]) o.visible = !far; for (const o of this.wLod[1]) o.visible = far; }
  }
  dispose() { this.scene.remove(this.root); }
}
