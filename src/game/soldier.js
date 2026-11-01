import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import * as Fallback from '../engine/fallback.js';
import { WEAPONS, TUNING, ARMOR } from '../config.js';

export const WEAPON_ASSET = { ak74m: 'ak74m', ak12: 'ak12', ak74o: 'ak74m_optic', pkm: 'pkm', rpg7: 'rpg7', rpg22: 'rpg22', pm: 'pm' };
// a crewman with a pistol uses the pistol clips when they exist, otherwise the rifle ones
const PISTOL_CLIP = { aim_stand: 'pistol_aim', fire_stand: 'pistol_fire', idle_rifle: 'pistol_idle', walk_rifle: 'pistol_walk', run_rifle: 'pistol_run', aim_crouch: 'pistol_crouch_aim', fire_crouch: 'pistol_fire', crouch_idle: 'pistol_crouch_aim', reload_stand: 'pistol_aim', reload_crouch: 'pistol_crouch_aim' };

// One infantryman: visual (skinned MakeHuman mesh + gear + weapon), animation state machine and combat state.
const CLIP_SPEED = { walk_rifle: 1.45, run_rifle: 3.9, crouch_walk: 1.0, prone_crawl: 0.45, wounded_crawl: 0.3, limp_walk: 0.9, drag_wounded: 0.8 };
let SHARED = null, SHARED_EVENTS = {};

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
    const once = /^(death|fire_launcher|launcher_raise|reload|throw|hit|dismount|hatch_exit|atgm_setup|atgm_fire|atgm_reload|atgm_pack|fpv_launch|dodge_dive)/.test(name);
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
      else this.weaponTo(/^throw_grenade/.test(name) ? 'L' : /^(drag_wounded|wounded_|being_dragged|treat_wounded)/.test(name) || /^(atgm_|fpv_launch|fpv_pilot)/.test(asked) ? 'back' : 'R');
    }
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
    this.scene.add(w); w.position.set(p.x + (Math.random() - .5) * 0.6, 0.04, p.z + (Math.random() - .5) * 0.6);
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
    const sp = this.vel.length();
    const st = this.stance;
    let clip, ts = 1, alt = [];
    if (this.state === 'dead') { clip = this.deathClip; }
    else if (this.state === 'critical' || this.state === 'stable') {
      if (this.dragger && this.dragger.dragPhase === 'drag') { clip = 'being_dragged'; alt = ['wounded_ground']; }
      else if (this.state === 'stable') { clip = 'wounded_sit'; alt = ['wounded_ground']; }
      else if (sp > 0.05) { clip = 'wounded_crawl'; ts = sp / CLIP_SPEED.wounded_crawl; }
      else clip = 'wounded_ground';
    } else if (this.inside === 'ride') { clip = this.target ? 'ride_aim' : (this.seatType === 'deck' ? 'ride_sit_deck' : 'ride_sit_edge'); alt = ['ride_sit_edge', 'crouch_idle']; }
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
    else if (this.throwT > 0) { clip = this.throwWindow ? 'throw_grenade_window' : 'throw_grenade'; alt = ['throw_grenade']; }
    else if (this.stackT > 0) { clip = 'cqb_stack'; alt = ['crouch_idle']; }
    else if (this.dodgeT > 0) { clip = this.dodgeClip || 'dodge_dive'; alt = ['dodge_dive', 'pinned_prone', 'prone_idle']; }
    else if (this.supportClip && sp < 0.15) { clip = this.supportClip; ts = this.supportTs || 1; alt = this.supportAlt || ['crouch_idle']; }
    else if (this.droneAlertT > 0 && sp < 0.15 && !this.ducking && this.weaponKey !== 'rpg7') { clip = 'drone_shoot'; alt = ['aim_stand']; }
    else if (sp > 0.15) {
      if (st === 'prone') { clip = 'prone_crawl'; alt = ['crouch_walk']; }
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
    if (this.mixer) {
      this.play(clip, this.state === 'dead' ? 0.12 : 0.3, ts, alt);
      // animation LOD: update distant soldiers less often
      this.animAcc = (this.animAcc || 0) + dt;
      const every = this.inView === false ? 0.5 : camDist > 160 ? 0.12 : camDist > 90 ? 0.06 : 0;
      if (this.animAcc >= every) { this.mixer.update(this.animAcc); this.animAcc = 0; if (camDist < 60) this.magTick(); }
      // recoil kick (procedural additive on spine)
      if (this.kick > 0 && this.spine) { this.spine.rotation.x -= this.kick * 0.06; this.kick = Math.max(0, this.kick - dt * 12); }
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
    this.root.visible = this.visible && this.inside !== 'btr' && this.state !== 'evac' && this.inView !== false;
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
  die(kind) {
    this.state = 'dead'; this.target = null; this.path = null; this.vel.set(0, 0, 0);
    this.deathClip = kind || pick(['death_front', 'death_back', 'death_crumple'], Math.random());
    if (this.dragging) { this.dragging.dragger = null; this.dragging = null; }
    if (this.dragger) { this.dragger.dragging = null; this.dragger = null; }
  }
  dispose() { this.scene.remove(this.root); }
}
