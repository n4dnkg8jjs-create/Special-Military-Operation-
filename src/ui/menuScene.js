import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { tapeMaterial } from '../game/tapeTex.js';
import { charObject } from '../game/vehicle.js';
import { coilGeo, wireMats, pixHook, COIL_L } from '../world/battlefieldDetail.js';
import { Flames } from '../fx/flames.js';

// The main menu's scene, in 3-D (v2: the whole view, not a layer of models over the painting). Drawn on its own canvas over the
// painted backdrop (backdrop.js), which keeps the sky - cloud deck, the glow of the last light, artillery flashes, smoke columns,
// embers, ash - and stops drawing its flat town once this scene is up:
//   * a hilltop at dusk: the viewer sits a few metres behind a low earth berm; beyond it the ground falls away to a plain with a
//     road across it 180 m off, where the convoys pass (the game's vehicle models, LOD1, timed by the backdrop's convoy logic)
//   * the town beyond the road, built here from simple solids: a street of private houses (gabled roofs, chimneys) among
//     poplars and garden trees, an Orthodox church (bell tower with a tented spire, drum and onion domes, crosses), five- and
//     nine-storey panel blocks and a point block behind, a few lit windows, a power line along the road, anti-tank hedgehogs
//     on the verge
//   * two Ukrainian soldiers behind the berm, nearest the viewer: one kneeling at the parapet, rifle in his hands, looking over
//     the crest at the road; the other sitting with his back against the berm, knees up, rifle across them
// Lit as the painting was: last light low on the horizon to the right, cold dark sky behind the viewer, haze over the distance.
// The soldier and vehicle files (~55 MB) are fetched after the menu is up and the scene fades in when ready; until then, and if
// anything fails, the painted backdrop is all there is. NOT THE DEFAULT ANY MORE: the menu is the 2-D painting again; ?menu3d builds this scene. Stopped and freed when the menu goes.

const VFOV = 30, D2R = Math.PI / 180, PITCH = 0.0536;          // camera looks up 3 deg: horizon at 60 % of the height, as painted
const FY = -1.72, PLAIN = -9.6, ROAD_Z = -180;                 // hilltop floor / plain / road, below and beyond the eye (origin)
const VEH = { btr: ['btr82a', 'assets/vehicles/btr82a.glb'], bmp: ['bmp3', 'assets/vehicles/bmp3.glb'], tank: ['t72b3', 'assets/vehicles/t72b3.glb'] };
const ENV = 'assets/env/';
const SOLDIER = 'assets/soldiers/soldier_ua.glb', ANIMS = 'assets/soldiers/soldier_anims.glb', RIFLE = 'assets/soldiers/ak74m_optic.glb';
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---- ground: flat hilltop round the viewer, falling to the plain; the berm stands on the hilltop
const hill = z => FY + (PLAIN - FY) * sstep(-14, -120, z);
// the trench line: straight in front of the two men, then (left of them) it turns toward the viewer and runs out of the bottom
// of the screen; crestD = its slope dz/dx, crestN = the unit normal to the men's side
const TURN = [0.35, -1.75, 6.6];   /* (v6: the bend starts right beside the watcher and is sharp - a parapet across the whole view hid the road) */
const CZ = -7.5;   /* (v11: the trench 1.5 m nearer - its floor is below the frame now, no bare square of it in view; the rear bank is gone again: it hid the men) */
const crestZ = x => CZ + TURN[2] * sstep(TURN[0], TURN[1], x);
const crestD = x => { const t = (x - TURN[0]) / (TURN[1] - TURN[0]); return t <= 0 || t >= 1 ? 0 : -6 * t * (1 - t); };
const crestN = x => { const f = crestD(x), l = Math.hypot(f, 1); return [-f / l, 1 / l, l]; };
const crestH = x => 0.86 + (x > 8.2 || x < -12 ? 0.05 * Math.sin(x * 1.3 + 0.4) : 0);
// steep to the men, easy to the enemy; between REV[0] and REV[1] the inner face is cut vertical and revetted with logs
const REV = [0.95, 7.8], WALL = 0.2;   /* (v9: the bend and the stretch beyond it are bare earth - kit pieces are straight and crossed each other there) */
const bermAt = (x, z) => { const d = (z - crestZ(x)) / crestN(x)[2], k = Math.min(sstep(REV[0] - 1.2, REV[0], x), 1 - sstep(REV[1], REV[1] + 1.2, x)), w = 0.95 - (0.95 - 0.07) * k, d0 = WALL * k; return crestH(x) * (d >= d0 ? 1 - sstep(0, w, d - d0) : d >= 0 ? 1 : 1 - sstep(0, 2.3, -d)); };

export class MenuScene {
  constructor(backdrop) {
    this.day = true; this.bd = backdrop; backdrop.use3d = true;   /* (v12: the backdrop paints no 2-D town while this loads - a plain dark sky, then this scene fades in complete) */ this.ready = false; this.running = false; this.loading = null; this.veh = {}; this.pool = new Map(); this.men = []; this.full = false;
  }
  // ---------------------------------------------------------------- life cycle
  start() {
    if (this.running) return; this.running = true;
    if (!this.canvas) {
      const c = this.canvas = document.createElement('canvas'); c.id = 'menu3d'; c.setAttribute('aria-hidden', 'true');
      c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:19;pointer-events:none;opacity:0;transition:opacity 1.1s ease';
      this.bd.c.after(c);
    }
    this.canvas.style.display = 'block';
    this.loading ||= this.load().catch(e => { console.warn('menu 3-D scene unavailable', e); this.failed = true; this.bd.use3d = false; });
    if (this.ready && this.complete) this.show();
  }
  stop() {
    if (!this.running) return; this.running = false; clearTimeout(this._full); this.full = false;
    if (this.canvas) { this.canvas.style.opacity = '0'; this.canvas.style.display = 'none'; }
    this.bd.scene3d = null;
    if (this.renderer) {   // free the GPU side: the battle is about to make its own context
      this.scene.traverse(o => { if (o.isMesh || o.isSprite || o.isLine) { o.geometry?.dispose?.(); for (const m of [].concat(o.material || [])) { for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) m[k]?.dispose?.(); m.dispose?.(); } } });
      this.renderer.dispose(); this.renderer.forceContextLoss?.(); this.renderer = null; this.scene = null; this.ready = false; this.complete = false; this.fl = null; this.glows = this.flames = this.smokes = null; this._dressed = false; this._rpg = null; this._fk = null; this.loading = null; this.pool.clear(); this.men = []; this.veh = {};
      removeEventListener('resize', this._rs);
      this.canvas.remove(); this.canvas = null;
    }
  }
  // (the painting's town goes once the fade is through: until then both are on screen)
  show() {
    if (!this.running || !this.ready || !this.complete) return; this.bd.scene3d = this;
    requestAnimationFrame(() => requestAnimationFrame(() => { if (this.canvas) this.canvas.style.opacity = '1'; }));
  }
  // ---------------------------------------------------------------- build
  async load() {
    const L = new GLTFLoader(), get = u => L.loadAsync(u);
    const [sg, ag, rifle, fort] = await Promise.all([get(SOLDIER), get(ANIMS), get(RIFLE), get(ENV + 'fortifications.glb').catch(() => null)]);
    const pend = [get('assets/soldiers/rpg22.glb').then(g => { this._rpg = g; if (this.running && this.scene && this._dressed) this.launcher(this.scene, g); }).catch(() => { })];   /* (set down by a ray onto the bags: after dress()) */
    if (!this.running) return;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    r.setClearColor(0x000000, 0); r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.87;
    const scene = this.scene = new THREE.Scene();
    // v7: day, but a heavy overcast one - a low grey deck, flat light from the front (the men are seen against it), haze
    const HZ = 0x5b6062;   /* (v9: the gloom back - darker haze, less light, dark wet ground) */
    scene.fog = new THREE.FogExp2(HZ, 0.0033);
    { // the sky is painted once and shown as the scene's background: horizon at 60 % of the height, as the camera has it
      const c = document.createElement('canvas'); c.width = 1024; c.height = 512; const x = c.getContext('2d'), R = rng(9), g = x.createLinearGradient(0, 0, 0, 512);
      g.addColorStop(0, '#3b4146'); g.addColorStop(0.3, '#4b5156'); g.addColorStop(0.5, '#5b6062'); g.addColorStop(1, '#5b6062');   /* (v11: the haze is the sky's own tone at the horizon - far blocks sink into it instead of standing out white) */ x.fillStyle = g; x.fillRect(0, 0, 1024, 512);
      for (let i = 0; i < 46; i++) { const px = R() * 1024, py = R() * 290, w = 110 + R() * 230, d = R() < 0.55; x.save(); x.translate(px, py); x.scale(1, 0.4 + py / 900); const q = x.createRadialGradient(0, 0, 0, 0, 0, w); q.addColorStop(0, d ? 'rgba(56,60,64,.24)' : 'rgba(152,154,152,.15)'); q.addColorStop(1, 'rgba(100,104,106,0)'); x.fillStyle = q; x.fillRect(-w, -w, w * 2, w * 2); x.restore(); }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; scene.background = t; }
    scene.add(new THREE.HemisphereLight(0x9aa3ac, 0x3b3832, 1.45));
    const sun = new THREE.DirectionalLight(0xcfcdc6, 0.75); sun.position.set(60, 120, -260); scene.add(sun);          // what gets through the cloud: high, from the town's side
    const fill = new THREE.DirectionalLight(0x7f8a96, 0.25); fill.position.set(-40, 60, 60); scene.add(fill);
    // the two men: in the trench's shade from our side; a little warmth from the fires ahead
    const rim = new THREE.SpotLight(0xffa868, 26, 20, 0.27, 0.95, 1.4); rim.position.set(8.5, 0.2, -12.7); rim.target.position.set(2.2, -1.25, -6.6); scene.add(rim, rim.target);
    this.rim = rim;
    this.cam = new THREE.PerspectiveCamera(VFOV, 16 / 9, 1.2, 1400); this.cam.rotation.order = 'YXZ'; this.cam.rotation.x = PITCH;
    this.resize(); addEventListener('resize', this._rs = () => this.resize());
    this.ground(scene);
    if (fort) this.dress(scene, fort);
    this._dressed = true; if (this._rpg) this.launcher(scene, this._rpg);
    this.soldiers(scene, sg, ag, rifle);
    this.clock = performance.now(); this.ready = true;
    window.__menu3d = { men: this.men.length, veh: 0 }; window.__menuScene = this;
    pend.push(this.town(scene, get).catch(e => console.warn('menu town', e)));   /* ~31 MB of the game's environment models: the painted town stays until they are in */
    // ---- vehicles (the flat sprites stay for a kind until its model is in)
    for (const [k, [, url]] of Object.entries(VEH)) pend.push(get(url).then(g => {
      if (!this.running || !this.scene) return;
      const src = g.scene;   // the far-detail meshes only (as the game shows them at range), no wreck parts
      src.traverse(o => { if (/_wreck$/i.test(o.name) || o.userData?.hidden) o.visible = false; });
      src.traverse(o => { if (/_LOD1$/i.test(o.name)) { o.visible = true; const b = src.getObjectByName(o.name.replace(/_LOD1$/i, '')); if (b) b.visible = false; } });
      const box = new THREE.Box3().setFromObject(src); this.veh[k] = { src, len: box.max.z - box.min.z };
      // knocked-out vehicles: swerved off the carriageway onto the verge and stopped at an angle, burning - the game's own
      // look of a vehicle that has just caught fire (charObject: paint blistering and blackening outward from the fire, embers)
      for (const [kind, x, dz, yaw, roll, tur] of [['btr', -46, 6.4, -Math.PI / 2 + 0.62, 0.07, 0.5], ['tank', 58, -6.8, Math.PI / 2 + 0.55, -0.05, -0.9], ['bmp', -124, 7.2, Math.PI / 2 - 0.7, 0.06, 0.3]]) {
        if (kind !== k) continue;
        const w = src.clone(true);
        w.traverse(o => { if (!o.isMesh) return; let n = o, off = !!o.userData?.hidden; while (n && !off) { if (/_(wreck|LOD1)$/i.test(n.name)) off = true; n = n.parent; } o.visible = !off; });
        /* (v9: the convoy copy shows the far-detail meshes and hides their full-detail nodes - on the T-72 / BMP that is the whole
           `turret` node, so the hulks, which show full detail, had no turret: every group visible again, the meshes decide) */
        w.traverse(o => { if (!o.isMesh) o.visible = true; });
        const tn = w.getObjectByName('turret'); if (tn) tn.rotation.y = tur;
        w.position.set(x, PLAIN + 0.02, ROAD_Z + dz); w.rotation.set(0.02, yaw, roll, 'YXZ'); this.scene.add(w); w.updateMatrixWorld(true);
        charObject(w, { value: 1 }, { burn: { value: 0.62 }, fire: { value: new THREE.Vector3(x, PLAIN + 1.9, ROAD_Z + dz) }, rust: { value: 0 } });
        this.addFire(this.scene, x, PLAIN + 2.1, ROAD_Z + dz, 1.5, 1);
      }
      window.__menu3d.veh++;
    }).catch(e => console.warn('menu vehicle', k, e)));
    /* (v12) shown only when all of it is in and its shaders are built: no half-built scene, no pop-in, no stutter in the fade */
    Promise.allSettled(pend).then(() => { if (!this.running || !this.scene) return; this.complete = true; try { this.renderer.compile(this.scene, this.cam); } catch { /* */ } this.show(); });
  }
  // ---------------------------------------------------------------- the land (at once) and the town (when its files are in)
  ground(scene) {
    // dug earth: clods, stones and damp patches painted once into a small tiling texture (colour + bump)
    const soil = (() => {
      const N = 512, c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d'), R = rng(77);
      x.fillStyle = '#7b6a55'; x.fillRect(0, 0, N, N);
      const blob = (n, r0, r1, cols, al, soft) => { for (let i = 0; i < n; i++) { const px = R() * N, py = R() * N, r = r0 + R() * (r1 - r0), col = cols[Math.floor(R() * cols.length)]; x.globalAlpha = al * (0.4 + R() * 0.6);
        for (const [ox, oy] of [[0, 0], [N, 0], [-N, 0], [0, N], [0, -N]]) { if (soft) { const g = x.createRadialGradient(px + ox, py + oy, 0, px + ox, py + oy, r); g.addColorStop(0, col); g.addColorStop(1, col + '00'); x.fillStyle = g; x.fillRect(px + ox - r, py + oy - r, r * 2, r * 2); } else { x.fillStyle = col; x.beginPath(); x.ellipse(px + ox, py + oy, r, r * (0.5 + R() * 0.5), R() * 3, 0, 7); x.fill(); } } } };
      blob(90, 40, 120, ['#5e5040', '#8a7860', '#6d5d49', '#514434'], 0.5, true);     /* damp and dry patches, no edges */
      blob(2600, 0.6, 2.2, ['#3d3328', '#9c8b72', '#4a3e30', '#877660', '#2f271e'], 0.8, false);   /* grain */
      blob(260, 2, 5, ['#4a3f31', '#93826a', '#5c4e3d'], 0.55, false);                 /* clods */
      blob(40, 1.5, 4, ['#b5ad9d', '#8d877c'], 0.85, false);                           /* a few stones */
      x.globalAlpha = 1; const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
    })();
    const sb = soil.clone(); sb.colorSpace = THREE.NoColorSpace; sb.needsUpdate = true;
    const far = soil.clone(); far.repeat.set(260, 220); far.needsUpdate = true;
    const earth = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.86, 0.84, 0.72), roughness: 1, map: far }), berm = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.92, 0.82, 0.7), roughness: 1, map: soil, bumpMap: sb, bumpScale: 1.6 });
    this.soilMat = berm;
    // terrain (coarse) + the hilltop patch with the berm (fine); the patch's rim is sunk under the terrain
    const tg = new THREE.PlaneGeometry(1500, 1300, 100, 130); tg.rotateX(-Math.PI / 2); tg.translate(0, 0, -560);
    let P = tg.attributes.position;
    for (let i = 0; i < P.count; i++) { const x = P.getX(i), z = P.getZ(i); P.setY(i, hill(z) - ((Math.abs(x) < 196 && z < -11.6 && z > -164) || (x > -38 && x < 22 && z >= -11.6 && z < -0.6) ? 4 : 0)); }   /* (v9: sunk under the whole of both fine sheets - it lay over their shell holes near the trench and hid every bowl) */
    tg.computeVertexNormals(); scene.add(new THREE.Mesh(tg, earth));
    // the open ground down to the road: its own finer sheet over the coarse one, cratered (bowl, thrown-up lip, darker fresh earth)
    { const R = rng(31), CR = this.craters = []; for (let i = 0; i < 46; i++) { const z = -20 - R() ** 0.8 * 140, r = 1.6 + R() * R() * 4.2; CR.push([(R() - 0.5) * (120 + -z * 1.1), z, r, 0.25 + r * 0.22]); }
      for (const [x, z, r] of [[-12, -22, 2.6], [-24, -30, 3.4], [-6, -34, 2.2], [-38, -26, 2.8], [-18, -46, 4.2], [-46, -44, 3.0], [-4, -58, 3.6], [-30, -66, 4.6], [-62, -34, 3.2], [-14, -84, 5.0], [-52, -78, 3.8], [14, -31, 2.4], [31, -47, 3.0], [3, -38, 3.0], [-8, -47, 3.6], [10, -53, 4.2], [-2, -66, 4.8], [19, -71, 3.6], [-21, -73, 4.0], [6, -90, 5.2], [-13, -106, 5.6], [25, -101, 4.4], [-35, -97, 5.0], [1, -124, 5.4], [33, -62, 3.2], [-9, -17, 2.0], [-17, -19, 2.6], [8, -22, 1.8]]) CR.push([x, z, r, r * 0.34]);
      const fg = new THREE.PlaneGeometry(420, 158, 420, 158); fg.rotateX(-Math.PI / 2); fg.translate(0, 0, -93); const F = fg.attributes.position, col = new Float32Array(F.count * 3), uv = fg.attributes.uv;
      for (let i = 0; i < F.count; i++) {
        const x = F.getX(i), z = F.getZ(i); let h = 0, dk = 0, lt = 0;
        for (const [cx, cz, r, dp] of CR) { const d = Math.hypot(x - cx, z - cz) / r; if (d < 1.9) { h += d < 1 ? -dp * (1 - d * d) + 0.3 * dp * d * d : 0.3 * dp * Math.max(0, 1 - (d - 1) / 0.9) ** 2; dk = Math.max(dk, 1 - Math.min(1, d / 1.05)); if (d > 0.95 && d < 1.7) lt = Math.max(lt, 1 - Math.abs(d - 1.25) / 0.45); } }
        const e = Math.min(sstep(-210, -200, x), 1 - sstep(200, 210, x), sstep(-172, -168, z), 1 - sstep(-11.4, -10, z));
        F.setY(i, hill(z) + (0.06 * sstep(-13, -16, z) + h + Math.sin(x * 0.31 + z * 0.17) * Math.sin(z * 0.23) * 0.12 * sstep(-12, -16, z) + (Math.sin(x * 1.9 + z * 1.3) * Math.sin(z * 2.3 - x * 0.7) * 0.05 + Math.sin(x * 4.3 + z * 2.9) * 0.015) * sstep(-11, -12.5, z)) * e - 0.3 * (1 - e));   /* (v13: lumpy from its first metre - a dead-level strip just beyond the parapet read as a pale flat band) */
        /* dark wet bowl, pale thrown-out spoil round it; between the holes last year's grass, flattened and yellow-grey, in patches on the mud */
        const gr = sstep(0.05, 0.5, Math.sin(x * 0.11 + 1.3) * Math.sin(z * 0.09 + 0.4) + 0.5 * Math.sin(x * 0.37 - z * 0.23) + 0.25 * Math.sin(x * 1.1 + z * 0.9)) * (1 - Math.min(1, dk * 3 + Math.max(0, lt) * 2)) * sstep(-15, -26, z);
        const k = (1 - dk * 0.8) * (1 + Math.max(0, lt) * 0.45); col[i * 3] = k * (1 + 0.42 * gr); col[i * 3 + 1] = k * (0.97 + 0.5 * gr); col[i * 3 + 2] = k * (0.93 + 0.1 * gr); uv.setXY(i, x / 3.1, z / 3.1);
      }
      fg.setAttribute('color', new THREE.BufferAttribute(col, 3)); fg.computeVertexNormals();
      // standing water in the bigger shell holes (dark, a little of the sky in it)
      { const big = CR.filter(c => c[2] > 2.3), wm = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x4a5052, roughness: 0.35, metalness: 0 }), big.filter(c => c[1] < -40).length), M = new THREE.Matrix4();
        big.filter(c => c[1] < -40).forEach(([cx, cz, r, dp], i) => wm.setMatrixAt(i, M.compose(new THREE.Vector3(cx, hill(cz) + 0.06 - dp * 0.62, cz), new THREE.Quaternion(), new THREE.Vector3(r * 0.6, 1, r * 0.6)))); wm.frustumCulled = false; scene.add(wm); }
      const fm = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.92, 0.82, 0.7), roughness: 1, map: soil, bumpMap: sb, bumpScale: 1.6, vertexColors: true });   /* (v12: exactly the hilltop patch's earth - the seam between the two sheets showed as a change of texture beside the trench) */   /* (v9: dark wet earth; the grass patches come from the vertex colours) */ scene.add(new THREE.Mesh(fg, fm)); }
    const NEAR = [[-6.4, -11.2, 1.7, 0.7], [-10.5, -7.6, 2.1, 0.85], [-7.4, -5.6, 1.2, 0.5], [-14.8, -11.4, 2.5, 1.0], [-17, -6.5, 1.6, 0.6], [-4.6, -8.2, 0.9, 0.35], [11.5, -11.6, 1.6, 0.5], [-23, -9.5, 2.2, 0.8], [-29, -5.8, 1.5, 0.55], [-33, -10.6, 2.6, 0.95]];   /* shell holes outside the parapet */
    const NX = 420, NZ = 250, bg = new THREE.PlaneGeometry(68, 14, NX, NZ); bg.rotateX(-Math.PI / 2); bg.translate(-8, 0, -6);   /* (v9: out to x -42 on the left, where the eye falls on near ground over the low parapet) */
    P = bg.attributes.position; const pcol = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), z = P.getZ(i), e = Math.min(sstep(-42, -39, x), 1 - sstep(23, 26, x), sstep(-13, -12, z), 1 - sstep(0, 1, z));
      /* lumps of spoil on the crest and the outer slope, trodden floor */
      const d = z - crestZ(x), lump = (Math.sin(x * 4.3 + z * 2.9) + Math.sin(x * 9.1 - z * 6.7) * 0.5) * 0.012 + (d < 0.1 ? (Math.sin(x * 2.7 + 1) * Math.sin(z * 3.9) * 0.05 + Math.sin(x * 11.3 + z * 7.7) * 0.02) * sstep(0.1, -0.5, d) : 0);
      let cr = 0, dk = 0, lt = 0; for (const [cx, cz, r, dp] of NEAR) { const q = Math.hypot(x - cx, z - cz) / r; if (q < 1.9) { cr += q < 1 ? -dp * (1 - q * q) + 0.2 * dp * q * q : 0.2 * dp * Math.max(0, 1 - (q - 1) / 0.9) ** 2; dk = Math.max(dk, 1 - Math.min(1, q / 1.05)); if (q > 0.95 && q < 1.7) lt = Math.max(lt, 1 - Math.abs(q - 1.25) / 0.45); } }
      { const k = (1 - dk * 0.7) * (1 + lt * 0.3); pcol[i * 3] = k; pcol[i * 3 + 1] = k * 0.97; pcol[i * 3 + 2] = k * 0.93; }
      P.setY(i, FY + (bermAt(x, z) + 0.035 + lump + cr) * e - 0.25 * (1 - e));
    }
    // texture coordinates by distance over the surface (the plane's own are a top-down projection: the earth smeared down the cut face)
    { const uv = bg.attributes.uv; for (let ix = 0; ix <= NX; ix++) { let acc = 0; for (let iz = 0; iz <= NZ; iz++) { const i = iz * (NX + 1) + ix; if (iz) { const j = i - (NX + 1); acc += Math.hypot(P.getZ(i) - P.getZ(j), P.getY(i) - P.getY(j)); } uv.setXY(i, P.getX(i) / 2.2, acc / 2.2); } } }
    bg.setAttribute('color', new THREE.BufferAttribute(pcol, 3)); berm.vertexColors = true;
    bg.computeVertexNormals(); scene.add(new THREE.Mesh(bg, berm));
    /* (v12: no standing water in the holes by the trench - seen edge-on from it the flat discs read as a shiny patch in the dirt) */
    const road = new THREE.Mesh(new THREE.BoxGeometry(1500, 0.06, 7.5), new THREE.MeshStandardMaterial({ color: 0x2a2824, roughness: 0.95 })); road.position.set(0, PLAIN + 0.03, ROAD_Z); scene.add(road);
    // dust behind the convoy: soft sprites
    this.dust = Array.from({ length: 44 }, () => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.dot('120,108,92'), depthWrite: false, transparent: true, opacity: 0 })); sp.visible = false; sp.userData.life = 9; scene.add(sp); return sp; });
  }
  // the position's furniture, from the game's own fortification pieces (assets/env/fortifications.glb), muddied: log revetment
  // along the whole cut face (round the bend too), two courses of sandbags on the parapet with a gap where the watcher looks out,
  // duckboards on the floor, ammunition crates; clods of earth and smears of mud on all of it
  dress(scene, fort) {
    const R = rng(4), dirt = new Map(), mud = new THREE.Color(0x5b4c3a);
    const dirty = (m, k = 0.8, l = 0.3) => { const key = m.uuid + k; let d = dirt.get(key); if (!d) { d = m.clone(); d.color.multiplyScalar(k).lerp(mud, l); d.roughness = 1; dirt.set(key, d); } return d; };
    const P = (name, x, y, z, ry = 0, rx = 0) => {
      const t = fort.scene.getObjectByName(name); if (!t) return;
      const o = t.clone(true); o.position.set(0, 0, 0); const g = new THREE.Group(); g.add(o); g.position.set(x, y, z); g.rotation.set(rx, ry, 0, 'YXZ'); scene.add(g);
      const bag = /sandbag/.test(name), dm = m => dirty(m, bag ? 1.9 : 0.8, bag ? 0.1 : 0.3);
      g.traverse(q => { if (q.isMesh) { q.frustumCulled = false; q.material = Array.isArray(q.material) ? q.material.map(dm) : dm(q.material); } if (/_lod1$/i.test(q.name)) q.visible = false; });
      return g;
    };
    /* (v14) everything stood in the trench is registered with its box and the height it is meant to rest on: clipCheck() below */
    const props = this.props = [], reg = (name, o, on = null, soft = false) => { o.updateWorldMatrix(true, true); const box = new THREE.Box3().setFromObject(o); props.push({ name, box, on, soft }); return box; };
    // a point d metres to the men's side of the crest at x, and the yaw that faces a piece out of the wall
    const at = (x, d) => { const [nx, nz] = crestN(x); return [x + nx * d, crestZ(x) + nz * d, Math.atan2(nx, nz)]; };
    const face = () => WALL;                                                                   /* the cut face's distance from the crest line */
    for (let x = REV[1] - 0.9; x > 2.6; x -= 1.74) {   /* (none into the bend: a straight piece turned with the wall there and stuck out across the corner; the slumped pile covers the wall's end) */ const [px, pz, ry] = at(x, face(x) + 0.15); P('rv_logs', px, FY + 0.02, pz, ry, -0.02); }
    // (v12) sandbags. Woven polypropylene sacks, filled three-quarters, mouth tied in a choke at one end and sewn flat at the
    // other; thrown down by hand: none square to its neighbour, each slumped onto what is under it, creased across where it
    // bends over an edge. Four different sacks (lumps, sag, which end is tied), each laid with its own turn, tilt and overlap;
    // weave, creases, stains and the damp underside are a texture (colour + bump). Lower course on the levelled crest, an upper
    // one bonded over the joints and sunk well into it; a gap where the watcher looks out; one course where the RPG-22 lies
    { const tex = (() => { const N = 256, mk = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; }, cc = mk(), bc = mk(), x = cc.getContext('2d'), y = bc.getContext('2d'), Q = rng(57);
        x.fillStyle = '#9a927a'; x.fillRect(0, 0, N, N); y.fillStyle = '#808080'; y.fillRect(0, 0, N, N);
        for (let i = 0; i < N; i += 4) { x.fillStyle = 'rgba(40,36,28,0.16)'; x.fillRect(i, 0, 1, N); x.fillRect(0, i, N, 1); x.fillStyle = 'rgba(255,250,235,0.07)'; x.fillRect(i + 2, 0, 1, N); y.fillStyle = 'rgba(0,0,0,0.3)'; y.fillRect(i, 0, 1, N); y.fillRect(0, i, N, 1); y.fillStyle = 'rgba(255,255,255,0.2)'; y.fillRect(i + 2, 0, 1, N); y.fillRect(0, i + 2, N, 1); }   /* the weave */
        for (let i = 0; i < 26; i++) { const px = Q() * N, py = Q() * N, r = 14 + Q() * 46, g = x.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, `rgba(${Q() < 0.5 ? '70,58,42' : '120,112,92'},${0.18 + Q() * 0.2})`); g.addColorStop(1, 'rgba(70,58,42,0)'); x.fillStyle = g; x.fillRect(px - r, py - r, 2 * r, 2 * r); }   /* earth stains, bleached patches */
        { const g = x.createLinearGradient(0, 0, 0, N); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.72, 'rgba(30,26,20,0)'); g.addColorStop(1, 'rgba(30,26,20,0.5)'); x.fillStyle = g; x.fillRect(0, 0, N, N); }   /* damp and dirt low down */
        /* (v13: no drawn creases - they read as scratches. The sack's form is in its shape; the cloth darkens towards its edges and seams, as a filled bag's does where it turns under) */
        { const g = x.createRadialGradient(N / 2, N / 2, N * 0.18, N / 2, N / 2, N * 0.74); g.addColorStop(0, 'rgba(20,17,12,0)'); g.addColorStop(0.7, 'rgba(20,17,12,0.22)'); g.addColorStop(1, 'rgba(20,17,12,0.6)'); x.fillStyle = g; x.fillRect(0, 0, N, N); }
        /* (v14) roughness: the polypropylene tapes of the weave catch a little light where they are clean; mud, damp and the worn gaps between them are dead matt */
        const rc = mk(), z = rc.getContext('2d'); z.fillStyle = '#e6e6e6'; z.fillRect(0, 0, N, N); for (let i = 0; i < N; i += 4) { z.fillStyle = '#a2a2a2'; z.fillRect(i + 1, 0, 2, N); z.fillRect(0, i + 1, N, 2); z.fillStyle = '#ffffff'; z.fillRect(i, 0, 1, N); z.fillRect(0, i, N, 1); }
        for (let i = 0; i < 30; i++) { const px = Q() * N, py = Q() * N, r = 16 + Q() * 50, g = z.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, 'rgba(255,255,255,0.85)'); g.addColorStop(1, 'rgba(255,255,255,0)'); z.fillStyle = g; z.fillRect(px - r, py - r, 2 * r, 2 * r); }
        { const g = z.createLinearGradient(0, 0, 0, N); g.addColorStop(0.6, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,0.9)'); z.fillStyle = g; z.fillRect(0, 0, N, N); }
        const map = new THREE.CanvasTexture(cc), bump = new THREE.CanvasTexture(bc), rough = new THREE.CanvasTexture(rc); map.colorSpace = THREE.SRGBColorSpace; for (const t of [map, bump, rough]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; } return { map, bump, rough }; })();
      const bagM = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, roughnessMap: tex.rough, map: tex.map, bumpMap: tex.bump, bumpScale: 0.9 });
      const sack = seed => { const Q = rng(seed), g = new THREE.BoxGeometry(2, 2, 2, 14, 6, 8), p = g.attributes.position, tie = Q() < 0.5 ? 1 : -1, a1 = Q() * 6, a2 = Q() * 6, sag = 0.05 + Q() * 0.12, fill = 0.82 + Q() * 0.22;
        for (let i = 0; i < p.count; i++) { let x = p.getX(i), y = p.getY(i), z = p.getZ(i); const n = (x ** 6 + y ** 4 + z ** 4) ** 0.25 || 1, k = 1 / Math.max(1, n * 0.92); x *= k; y *= k; z *= k;
          const t = Math.max(0, x * tie - 0.62) / 0.38, sw = Math.max(0, -x * tie - 0.74) / 0.26;                              /* towards the tied mouth / the sewn end */
          const neck = 1 - 0.62 * t * t * (3 - 2 * t) + 0.16 * Math.max(0, t - 0.8) / 0.2;                                    /* the choke, the ruff of sacking beyond the string */
          y *= neck * (1 - 0.55 * sw * sw) * fill * (1 + 0.16 * (1 - x * x) * (1 - z * z)); z *= neck * (1 - 0.1 * sw * sw);
          if (y > 0) y *= 1 + 0.1 * Math.sin(x * 4.1 + a1) * Math.sin(z * 3.3 + a2) + 0.05 * Math.sin(x * 9.3 + a2);        /* lumps of the fill under the cloth */
          y -= sag * x * x * (y > -0.2 ? 1 : 0.3);                                                                            /* the ends droop */
          z += 0.05 * Math.sin(x * 2.6 + a1) * (1 - sw); p.setXYZ(i, x, y, z); }
        g.computeVertexNormals(); return g; };
      const BL = 0.56, BH = 0.075, y0 = x => FY + crestH(x) + 0.035 + BH * 0.8, G = [sack(11), sack(23), sack(37), sack(52)], lists = G.map(() => []);
      /* one sack: centre, yaw of the wall there (the bend turns them), course k (0 = on the crest / the floor) */
      const bag = (px, py, pz, ry, k, loose = 1) => { const v = Math.floor(R() * 4), sh = 0.8 + R() * 0.3, ol = R() < 0.28;
        lists[v].push([new THREE.Matrix4().compose(new THREE.Vector3(px, py + (R() - 0.5) * 0.008, pz), new THREE.Quaternion().setFromEuler(new THREE.Euler((R() - 0.5) * (0.06 + k * 0.08) * loose, ry + (R() - 0.5) * (0.16 + k * 0.14) * loose + (R() < 0.5 ? Math.PI : 0), (R() - 0.5) * (0.04 + k * 0.06) * loose, 'YXZ')), new THREE.Vector3(BL / 2 * (0.97 + R() * 0.09), BH * (0.9 + R() * 0.25), 0.15 * (0.92 + R() * 0.16))),
          ol ? [0.5 * sh, 0.54 * sh, 0.36 * sh] : [0.9 * sh, 0.85 * sh, 0.7 * sh]]); };
      const lay = (x, k) => { const [px, pz, ry] = at(x + (R() - 0.5) * 0.05, face(x) - 0.27 + (R() - 0.5) * 0.06 - k * 0.025); bag(px, y0(x) + k * (1.55 * BH), pz, ry, k); };
      const run = (x0, x1, k, skip = 0.1) => { for (let x = x0; x > x1; x -= BL * (0.9 + R() * 0.09) / crestN(x)[2]) if (R() >= skip) lay(x, k); };
      /* the parapet: one course along the whole revetted stretch (a gap where the watcher looks out), a second bonded over its
         joints on both sides of the men and at the far end, a third on part of that; where the RPG-22 lies it stays one course */
      for (let x = REV[1] - 0.2; x > 2.2; x -= BL * (0.9 + R() * 0.08)) { lay(x, 0); this.bagLeft = x; }
      run(REV[1] - 0.2 - BL / 2, 5.05, 1); run(REV[1] - 0.5, 6.0, 2, 0.15);
      run(3.75, 2.5, 1, 0);
      /* (v14) the corner: bags built up round the bend where the wall has no revetment - three courses, stepped, following the turn */
      run(0.62, -1.75, 0, 0); run(0.62 - BL / 2, -1.5, 1, 0); run(0.2, -1.05, 2, 0.1);
      this.bagRuns = [[2.2, REV[1]], [-1.75, 0.62]];
      /* spare filled sacks stacked on the duckboards against the far stretch of the wall: three, two on their joints, one on top */
      this.bagStack = (x0, yb, zc) => { [[0, 0], [1, 0], [2, 0], [0.5, 1], [1.5, 1], [1, 2]].forEach(([i, k]) => bag(x0 + i * BL * 1.02, yb + BH * 0.8 + k * 1.55 * BH, zc + (R() - 0.5) * 0.03, 0, k, 0.5)); };
      this.bagFlush = () => {
      lists.forEach((L, v) => { if (!L.length) return; const im = new THREE.InstancedMesh(G[v], bagM, L.length), c = new THREE.Color(); L.forEach(([M, col], i) => { im.setMatrixAt(i, M); im.setColorAt(i, c.setRGB(col[0], col[1], col[2])); }); im.frustumCulled = false; scene.add(im); }); };
      this.bagTop = x => y0(x) + BH * 0.95; this.bagDim = [BL, BH]; }
    // (v14) Everything below is placed from measured boxes, not from guessed sizes (v13: the kit's crate stack is 1.1 m wide and
    // stood in the sitting man's arm; the magazines lay 15 cm over its lid; the plywood stood inside the foot of the earth face,
    // which is not plumb: it runs out 7 cm - and a mesh cell - towards the men at the floor).
    const FL = FY + 0.035, wood = (() => { const N = 256, c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d'), Q = rng(91);
      x.fillStyle = '#d9c08e'; x.fillRect(0, 0, N, N);
      for (let i = 0; i < 520; i++) { const y = Q() * N, w = 30 + Q() * 200, x0 = Q() * N; x.fillStyle = `rgba(${Q() < 0.5 ? '96,66,34' : '214,186,138'},${0.05 + Q() * 0.13})`; x.fillRect(x0, y, w, 1 + Q() * 1.6); x.fillRect(x0 - N, y, w, 1 + Q() * 1.6); }   /* veneer grain */
      for (let i = 0; i < 7; i++) { const px = Q() * N, py = Q() * N, r = 3 + Q() * 6; x.fillStyle = 'rgba(70,46,24,0.55)'; x.beginPath(); x.ellipse(px, py, r * 1.7, r, 0, 0, 7); x.fill(); }   /* knots */
      for (let i = 0; i < 14; i++) { const px = Q() * N, py = N * (0.35 + Q() * 0.65), r = 14 + Q() * 44, g = x.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, `rgba(58,46,34,${0.25 + Q() * 0.3})`); g.addColorStop(1, 'rgba(58,46,34,0)'); x.fillStyle = g; x.fillRect(px - r, py - r, 2 * r, 2 * r); }   /* damp, mud thrown up */
      { const g = x.createLinearGradient(0, 0, 0, N); g.addColorStop(0.62, 'rgba(44,34,24,0)'); g.addColorStop(1, 'rgba(44,34,24,0.6)'); x.fillStyle = g; x.fillRect(0, 0, N, N); }
      x.strokeStyle = 'rgba(40,30,20,0.7)'; x.lineWidth = 3; x.strokeRect(1, 1, N - 2, N - 2);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; })();
    const plyM = new THREE.MeshStandardMaterial({ map: wood, color: 0xffffff, roughness: 0.88, emissive: 0x2a2418, emissiveMap: wood })   /* (pale new board: it has to read against the wet earth at dusk) */, stakeM = new THREE.MeshStandardMaterial({ map: wood, color: 0x6f6252, roughness: 1 });
    const solid = (name, geo, mat, x, y, z, ry = 0, rx = 0, on = null) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, 0, 'YXZ'); m.frustumCulled = false; scene.add(m); reg(name, m, on); return m; };
    // a cut sheet of plywood stood against the earth between the two men, its foot dug in, leaning back on the wall; two stakes
    // driven into the floor in front of it hold it there. The face it shows stands 13 cm clear of the cut (see above).
    { const sx = 2.1, sd = WALL + 0.135, H = 0.9, lean = 0.055, zc = crestZ(sx) + sd;
      solid('plywood', new THREE.BoxGeometry(1.22, H, 0.018), plyM, sx, FL - 0.05 + H / 2, zc, 0, -lean);
      this.plyFront = zc + 0.009 + 0.012;   /* (its face at the height the rifle's fore-end meets it) */
      for (const dx of [-0.42, 0.44]) solid('stake', new THREE.BoxGeometry(0.05, 1.05, 0.05), stakeM, sx + dx, FL - 0.2 + 0.525, zc + 0.009 + lean * H / 2 + 0.03, 0.2 * dx); }
    // duckboards along the foot of the wall (the kit's piece), measured: the crates and the spare sacks stand on them
    const boards = []; for (let x = 6.4; x > REV[0] + 0.9; x -= 2.17) { const [px, pz, ry] = at(x, face(x) + 0.24 + 0.77 - 0.2); boards.push(reg('duckboard', P('floor_planks', px, FY + 0.045, pz, ry), null, true)); }
    const boardAt = x => boards.find(b => x > b.min.x + 0.05 && x < b.max.x - 0.05) || boards[0];
    this.boardTop = boards.length ? Math.max(...boards.map(b => b.max.y)) : FL;
    // ammunition: three wooden 5.45 crates (48.8 x 35 x 16.3 cm, as issued: 2160 rounds in two tins) on the duckboards well to
    // the right of the sitting man - two side by side, one across them - and loaded magazines left on the top one
    { const N = 256, c = document.createElement('canvas'); c.width = N; c.height = N / 2; const x = c.getContext('2d'), Q = rng(123);
      x.fillStyle = '#4b5237'; x.fillRect(0, 0, N, N / 2);
      for (let i = 0; i < 260; i++) { x.fillStyle = `rgba(${Q() < 0.5 ? '30,34,22' : '104,110,80'},${0.05 + Q() * 0.12})`; x.fillRect(Q() * N, Q() * N / 2, 20 + Q() * 90, 1); }      /* brushed paint over the grain */
      x.fillStyle = 'rgba(18,20,14,0.85)'; for (const y of [42, 85]) x.fillRect(0, y, N, 2);                                                                              /* three boards */
      x.fillStyle = 'rgba(40,44,30,0.9)'; for (const px of [10, N - 34]) { x.fillRect(px, 0, 24, N / 2); x.fillStyle = 'rgba(16,18,12,0.9)'; x.fillRect(px, 0, 1, N / 2); x.fillRect(px + 23, 0, 1, N / 2); x.fillStyle = 'rgba(40,44,30,0.9)'; }   /* end battens */
      x.fillStyle = 'rgba(12,12,10,0.85)'; x.font = 'bold 15px monospace'; x.fillText('5,45 \u041f\u0421 \u0433\u0441', 52, 28); x.font = '11px monospace'; x.fillText('2160 \u0448\u0442', 52, 66); x.fillText('\u0411\u0420\u0423\u0422\u0422\u041e 29 \u043a\u0433', 52, 112); x.fillText('17-83-270', 150, 66);   /* stencils */
      for (let i = 0; i < 40; i++) { x.fillStyle = `rgba(150,140,112,${0.1 + Q() * 0.25})`; x.fillRect(Q() * N, Q() * N / 2, 2 + Q() * 9, 1 + Q() * 1.5); }                 /* knocks through to the wood */
      { const g = x.createLinearGradient(0, 0, 0, N / 2); g.addColorStop(0.55, 'rgba(60,48,34,0)'); g.addColorStop(1, 'rgba(60,48,34,0.6)'); x.fillStyle = g; x.fillRect(0, 0, N, N / 2); }   /* mud low down */
      const ct = new THREE.CanvasTexture(c); ct.colorSpace = THREE.SRGBColorSpace; ct.anisotropy = 8;
      const crM = new THREE.MeshStandardMaterial({ map: ct, color: 0xd8d8d0, roughness: 0.92 }), CG = new THREE.BoxGeometry(0.488, 0.163, 0.35), cx = 4.08, bd = boardAt(cx), by = bd.max.y, cz = bd.min.z + 0.05 + 0.175;
      solid('crate', CG, crM, cx - 0.255, by + 0.0815, cz, 0.03, 0, by); solid('crate', CG, crM, cx + 0.255, by + 0.0815, cz + 0.01, -0.04, 0, by);
      const top = solid('crate', CG, crM, cx + 0.03, by + 0.163 + 0.0815, cz + 0.005, 0.11, 0, by + 0.163), ty = by + 0.326;
      const mg = new THREE.BoxGeometry(0.2, 0.028, 0.062, 8, 1, 1); { const q = mg.attributes.position; for (let i = 0; i < q.count; i++) { const mx = q.getX(i); q.setZ(i, q.getZ(i) + 0.9 * mx * mx); } mg.computeVertexNormals(); }   /* the AK magazine's curve */
      [[-0.15, 0.07, 0.4, 0x15130f], [0.02, -0.105, -0.5, 0x15130f], [0.17, 0.07, 1.3, 0x4a2412]].forEach(([dx, dz, yaw, col]) => solid('magazine', mg, new THREE.MeshStandardMaterial({ color: col, roughness: 0.6 }), top.position.x + dx, ty + 0.014, top.position.z + dz, yaw, 0, ty));
      /* and an opened tin of the same lot on the end sack of the parapet beside the watcher, pressed into it, a magazine on it */
      { const tx = this.bagLeft ?? 2.3, [px, pz] = at(tx, face(tx) - 0.27), ys = this.bagTop(tx) - 0.014, TG = new THREE.BoxGeometry(0.357, 0.103, 0.153);
        solid('ammo tin', TG, new THREE.MeshStandardMaterial({ map: ct, color: 0xb9beb4, roughness: 0.6, metalness: 0.1 }), px, ys + 0.0515, pz, 0.12);
        solid('magazine', mg, new THREE.MeshStandardMaterial({ color: 0x15130f, roughness: 0.6 }), px + 0.02, ys + 0.103 + 0.014, pz + 0.01, 0.9, 0, ys + 0.103); }
      /* the spare sacks, further along the same boards */
      const b2 = boardAt(6.3); this.bagStack(5.85, b2.max.y, b2.min.z + 0.2); }
    this.bagFlush();
    // clods fallen from the wall and the parapet, mud trodden onto the boards
    // (v9) the earth that came out of the wall where the revetment ends: one slumped pile at the foot of the bare face, its toe
    // spread on the floor - a heap, not scattered lumps (the clods below are the few that rolled off it)
    { const N = 26, K = 40, pos = [], uv = [], col = [], idx = [], px = -0.05, pz = crestZ(-0.05) + 0.72, hx = 0.72, hz = 0.8, hh = 0.42,   /* (v14: it ran under the kneeling man's leg - smaller, further round the bend) */ nz = (a, b) => Math.sin(a * 3.1 + b * 1.7) * 0.5 + Math.sin(a * 7.3 - b * 5.1) * 0.25 + Math.sin(a * 13.7 + b * 11.3) * 0.12;
      for (let i = 0; i <= N; i++) for (let j = 0; j < K; j++) { const r = i / N, a = j / K * 6.2832, lob = 1 + 0.16 * Math.sin(a * 3 + 0.7) + 0.09 * Math.sin(a * 5 + 2.1), x = px + Math.cos(a) * r * hx * lob, z = pz + Math.sin(a) * r * hz * lob - 0.22 * (1 - r) /* (leaning into the wall) */;
        const y = FY + 0.03 + hh * Math.pow(1 - r * r, 0.85) * (0.8 + 0.3 * nz(x * 0.9, z * 1.1) + 0.12 * nz(x * 2.9, z * 2.1)) * (1 + 0.25 * Math.cos(a - 1.2)) + 0.025 * nz(x * 4.3, z * 3.7) * (1 - r * r) - 0.05 * r * r;   /* (v13: broad and lumpy, higher against the wall - it stood there as a smooth cone) */
        pos.push(x, y, z); uv.push(x / 2.2, z / 2.2 + y); const k = 0.82 + 0.3 * (y - FY) + 0.08 * nz(x * 1.9, z * 2.4); col.push(k, k * 0.97, k * 0.93); }
      for (let i = 0; i < N; i++) for (let j = 0; j < K; j++) { const a = i * K + j, b = i * K + (j + 1) % K, c = a + K, d = b + K; idx.push(a, b, c, b, d, c); }   /* (facing up: wound the other way it was lit from inside and showed as a black dome) */
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setIndex(idx); g.computeVertexNormals();
      const pile = new THREE.Mesh(g, this.soilMat); pile.frustumCulled = false; scene.add(pile); props.push({ name: 'earth pile', box: new THREE.Box3(new THREE.Vector3(px - hx * 0.8, FY, pz - hz * 0.8), new THREE.Vector3(px + hx * 0.8, FY + hh * 0.6, pz + hz * 0.8)), on: null, soft: true }); }
    const clG = new THREE.IcosahedronGeometry(1, 1); clG.setAttribute('color', new THREE.BufferAttribute(new Float32Array(clG.attributes.position.count * 3).fill(0.9), 3));   /* (the soil material takes vertex colours: without them the clods were black) */
    const cl = new THREE.InstancedMesh(clG, this.soilMat, 260), M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    cl.count = 22;
    for (let i = 0; i < 22; i++) {
      const x = i < 16 ? -0.9 + R() * 2.0 : 1.0 + R() * 6.6, top = false, d = top ? face(x) - 0.62 - R() * 0.5 : face(x) + 0.26 + R() * R() * 1.6, [px, pz] = at(x, d), r = 0.008 + R() * R() * 0.03;
      const y = top ? FY + crestH(x) + 0.03 + r * 0.4 : FY + 0.04 + r * 0.4;   /* (on the earth floor; none perched on the duckboards' level where there are no boards any more) */
      cl.setMatrixAt(i, M.compose(new THREE.Vector3(px, y, pz), q.setFromEuler(e.set(R() * 3, R() * 3, R() * 3)), new THREE.Vector3(r * (1 + R()), r * 0.7, r * (1 + R()))));
    }
    cl.frustumCulled = false; scene.add(cl);
    const mm = new THREE.MeshStandardMaterial({ map: this.dot('92,76,58'), color: 0xffffff, transparent: true, opacity: 0.9, roughness: 1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const sm = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mm, 34);
    for (let i = 0; i < 34; i++) { const x = 1.2 + R() * 6, d = face(x) + 0.3 + R() * 1.4, [px, pz] = at(x, d); sm.setMatrixAt(i, M.compose(new THREE.Vector3(px, FY + 0.112, pz), q.setFromEuler(e.set(0, R() * 6, 0)), new THREE.Vector3(0.35 + R() * 0.5, 1, 0.25 + R() * 0.35))); }
    sm.frustumCulled = false; sm.renderOrder = 1; scene.add(sm);
  }
  // (v14, dev) the clipping check: every registered piece against the height it should rest on, against the other pieces, and
  // against the two men (their bones, with a limb's thickness). Returns the list of faults; [] = clean. window.__menuScene.clipCheck()
  clipCheck() {
    const out = [], B = this.props || [], v = new THREE.Vector3(), I = new THREE.Box3();
    for (const p of B) if (p.on != null && Math.abs(p.box.min.y - p.on) > 0.02) out.push(`${p.name}: ${(p.box.min.y - p.on > 0 ? 'floats ' : 'sunk ')}${Math.abs(p.box.min.y - p.on).toFixed(3)} m`);
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) { const a = B[i], b = B[j]; if (a.soft || b.soft || !a.box.intersectsBox(b.box)) continue; I.copy(a.box).intersect(b.box); const d = I.max.clone().sub(I.min); if (Math.min(d.x, d.y, d.z) > 0.012) out.push(`${a.name} x ${b.name}: ${(Math.min(d.x, d.y, d.z) * 100).toFixed(1)} cm into each other`); }
    (this.men || []).forEach((s, k) => { const hit = new Map(); s.m.updateWorldMatrix(true, true); s.m.traverse(o => { if (!o.isBone || /twist|socket|_end$/i.test(o.name)) return; o.getWorldPosition(v); for (const p of B) { if (p.name === 'duckboard') continue; I.copy(p.box).expandByScalar(0.06); if (I.containsPoint(v)) hit.set(p.name, (hit.get(p.name) || []).concat(o.name)); } }); for (const [n, l] of hit) out.push(`man ${k} (${k ? 'sitting' : 'kneeling'}) x ${n}: ${l.slice(0, 4).join(', ')}`);
      const w = s.m.getObjectByName('weapon_socket')?.children[0]; if (w) { I.setFromObject(w).expandByScalar(-0.03); for (const p of B) if (!p.soft && I.intersectsBox(p.box)) out.push(`man ${k}'s rifle x ${p.name}`); } });
    return out;
  }
  // an RPG-22 laid ready on the parapet beside the men (on the sandbags, along the trench)
  launcher(scene, g) {
    const o = g.scene.clone(true); o.traverse(q => { if (q.isMesh) { q.frustumCulled = false; if (/_LOD1$/i.test(q.name)) q.visible = false; } });
    // (v11: it still floated - the ray that looked for the bags' top found something else first.) Its place is known: the stretch
    // of the parapet left one course high. The tube is 9.2 cm across about the model's own axis, sling below and sights above:
    // rolled a quarter turn so both lie to the sides, the tube's wall rests on the bags (sunk 4 mm into the sacking)
    const x = 4.3, grp = new THREE.Group(); o.rotation.z = Math.PI / 2; grp.add(o);
    grp.position.set(x, (this.bagTop ? this.bagTop(x) : FY + crestH(x) + 0.17) + 0.046 - 0.004, crestZ(x) + WALL - 0.27); grp.rotation.set(0, Math.PI / 2 + 0.1, 0); scene.add(grp);
  }
  // a fire: flames (flickering additive tongues), their glow, dark smoke going up on the wind; `big`: through a roof / a wreck
  addFire(scene, x, y, z, sz, big = 0, quiet = 0) {
    const K = this._fk || (this._fk = (() => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 128; const q = c.getContext('2d'), g = q.createRadialGradient(32, 96, 2, 32, 80, 60);
      g.addColorStop(0, 'rgba(255,240,190,1)'); g.addColorStop(0.25, 'rgba(255,170,60,.9)'); g.addColorStop(0.6, 'rgba(220,80,20,.45)'); g.addColorStop(1, 'rgba(120,30,10,0)');
      q.fillStyle = g; q.beginPath(); q.moveTo(32, 2); q.bezierCurveTo(58, 50, 62, 96, 32, 126); q.bezierCurveTo(2, 96, 6, 50, 32, 2); q.fill();
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      return { glow: new THREE.SpriteMaterial({ map: this.dot('255,150,60'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }),
        flame: new THREE.SpriteMaterial({ map: t, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }), smoke: new THREE.SpriteMaterial({ map: this.dot('26,24,22'), depthWrite: false, transparent: true, opacity: 0 }) };
    })());
    this.glows ||= []; this.flames ||= []; this.smokes ||= [];
    const gl = new THREE.Sprite(K.glow.clone()); gl.position.set(x, y + 0.4, z + 0.6); gl.userData.s = sz * (big ? 4.2 : 2.4); scene.add(gl); this.glows.push(gl);
    /* (v11) the flames are the game's own (fx/flames.js: noise-eaten tongues, slow licking, smoke wisps at the tips) - the menu's were paper cut-outs flapping */
    this.fl ||= new Flames(scene, 96); this.fl.add(new THREE.Vector3(x, y - (big ? 0.5 : 0.9), z + 0.2), sz * (big ? 0.85 : 0.5), { n: big ? 4 : 2 });
    if (!quiet) for (let k = 0; k < 6; k++) { const sm = new THREE.Sprite(K.smoke.clone()); sm.userData = { x, y: y + 1, z: z - 1, s: sz * 2.2, ph: k / 6, sp: 0.085 + Math.random() * 0.03 }; scene.add(sm); this.smokes.push(sm); }
  }
  dot(rgb) {
    const k = '_dot' + rgb; if (this[k]) return this[k];
    const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, `rgba(${rgb},1)`); g.addColorStop(0.35, `rgba(${rgb},.45)`); g.addColorStop(1, `rgba(${rgb},0)`); x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return (this[k] = t);
  }
  // The town is the game's own models (v3: the first 3-D town was plain solids): the private houses, fences, church, sub-station
  // and lamp of assets/env/city.glb, the leafy trees, barn, water tower, sheds and wells of farmland.glb, utility poles of
  // wires.glb, and five- and nine-storey blocks put together from the panel kit (panel_kit.glb: plinth, window / balcony /
  // entrance / blank end panels, balconies, parapet, roof huts) the way src/world/buildings.js does, a few flats shelled.
  // Every model is drawn instanced (one InstancedMesh per sub-mesh of a model).
  async town(scene, get) {
    const [city, farm, wires, kit] = await Promise.all([get(ENV + 'city.glb'), get(ENV + 'farmland.glb'), get(ENV + 'wires.glb'), get(ENV + 'panel_kit.glb')]);
    if (!this.running || this.scene !== scene) return;
    const R = rng(1917), M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0), V = (x, y, z) => new THREE.Vector3(x, y, z);
    this.fires = []; this.soot = [];
    const bins = new Map(), find = (...n) => { for (const g of [city, farm, wires, kit]) for (const k of n) { const o = g.scene.getObjectByName(k); if (o) return o; } return null; };
    const put = (t, x, y, z, ry = 0, sc = 1) => { if (!t) return; (bins.get(t) || bins.set(t, []).get(t)).push(new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, ry), V(sc, sc, sc))); };
    const T = n => find(n), far = n => find(n + '_lod1', n);
    // ---- private houses: three streets behind the road, fences along the fronts, sheds, wells, garden trees
    const houses = ['house_a', 'house_b', 'house_c', 'house_d', 'house_e'].map(T).filter(Boolean), gard = ['tree_oak_leafy', 'tree_walnut_leafy', 'tree_acacia_leafy'];
    const street = (z, x0, x1, near) => {
      for (let x = x0; x <= x1; x += 21 + R() * 8) {
        if (Math.abs(x - 30) < 34 && z < ROAD_Z - 50 && z > ROAD_Z - 110) continue;                      /* the church's yard */
        const hz = z - R() * 5;
        put(houses[Math.floor(R() * houses.length)], x, PLAIN, hz, Math.floor(R() * 4) * Math.PI / 2 + (R() - 0.5) * 0.08);
        if (R() < 0.07) this.fires.push([x + (R() - 0.5) * 3, PLAIN + 4.4, hz, 2.8, 1]);   /* a house on fire: through the roof */
        if (R() < 0.55) put(T('shed_wood'), x + 7 + R() * 3, PLAIN, hz - 6 - R() * 4, R() * 6.28);
        if (R() < 0.2) put(T('well_village'), x - 6, PLAIN, hz + 3);
        for (let k = 0, n = 1 + Math.floor(R() * 3); k < n; k++) put((near ? T : far)(gard[Math.floor(R() * 3)]), x + (R() - 0.5) * 20, PLAIN, hz - 4 - R() * 14, R() * 6.28, 0.8 + R() * 0.45);
      }
      for (let x = x0 - 9; x <= x1 + 9; x += 18.05) put(T(R() < 0.5 ? 'fence_house_picket' : R() < 0.6 ? 'fence_house_plain' : 'fence_house_plain_brown'), x, PLAIN, z + 9.5);
    };
    street(ROAD_Z - 24, -300, 300, true); street(ROAD_Z - 58, -310, 310, false); street(ROAD_Z - 92, -300, 300, false);
    for (let x = -340; x <= 340; x += 30 + R() * 34) put(far('tree_poplar_leafy'), x, PLAIN, ROAD_Z - 41 - R() * 5, R() * 6.28, 0.9 + R() * 0.3);
    for (let x = -320; x <= 320; x += 55 + R() * 60) put(T('tree_poplar_leafy'), x, PLAIN, ROAD_Z - 11 - R() * 2, R() * 6.28, 0.9 + R() * 0.25);
    // ---- the church in its yard, the farm on the town's edge, the sub-station
    put(T('church_small'), 30, PLAIN, ROAD_Z - 80, Math.PI / 2, 1.25);
    for (const [dx, dz] of [[-24, 6], [-18, -16], [22, 10], [27, -12], [2, 18], [-8, -22]]) put(far('tree_oak_leafy'), 30 + dx, PLAIN, ROAD_Z - 80 + dz, R() * 6.28, 0.9 + R() * 0.3);
    put(T('barn_kolkhoz'), -262, PLAIN, ROAD_Z - 40, 0.2); put(T('water_tower'), -235, PLAIN, ROAD_Z - 62); put(T('machine_shed'), -292, PLAIN, ROAD_Z - 66, 1.4);
    put(T('substation_a'), 150, PLAIN, ROAD_Z - 118, 0.1);
    // ---- utility poles along the near verge (their wires: three sagging lines between the cross-arms)
    const wire = [];
    for (let x = -330; x <= 330; x += 44) {
      put(T('utility_pole'), x, PLAIN, ROAD_Z + 7.5);
      if (x < 330) for (const dz of [-0.75, -0.35, 0.35, 0.75]) for (let k = 0; k < 8; k++) { const u0 = k / 8, u1 = (k + 1) / 8, sag = u => -1.0 * 4 * u * (1 - u); wire.push(x + 44 * u0, PLAIN + 8.16 + sag(u0), ROAD_Z + 7.5 + dz, x + 44 * u1, PLAIN + 8.16 + sag(u1), ROAD_Z + 7.5 + dz); }
    }
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    scene.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x0c0c0c, transparent: true, opacity: 0.8 })));
    // ---- concertina wire on the open ground: the game's own coil (world/battlefieldDetail.js: geometry, ribbon shader, per-coil
    // rust / crush / tear in the instance colour), loose - tangled heaps of crushed lengths, some thrown into shell holes, and a
    // few short runs lying where they were dragged, their ends sprung
    { const coils = [], cols = [], E = new THREE.Euler();
      const gy = (x, z) => { let h = 0; for (const [cx, cz, r, dp] of this.craters || []) { const d = Math.hypot(x - cx, z - cz) / r; if (d < 1.9) h += d < 1 ? -dp * (1 - d * d) + 0.3 * dp * d * d : 0.3 * dp * Math.max(0, 1 - (d - 1) / 0.9) ** 2; } return hill(z) + 0.06 + h; };
      const coil = (x, z, yaw, len, crush, tear, dy = 0, tilt = 0) => { coils.push(new THREE.Matrix4().compose(V(x, gy(x, z) + dy, z), new THREE.Quaternion().setFromEuler(E.set(0, yaw, tilt, 'YXZ')), V(len / COIL_L, 1, 1))); cols.push(new THREE.Color(0.15 + R() * 0.45, crush, tear)); };
      const heap = (x, z, k) => { for (let i = 0; i < k; i++) { const a = R() * 6.283, len = 2.2 + R() * 2.6; coil(x + (R() - 0.5) * 1.6 - Math.cos(a) * len / 2, z + (R() - 0.5) * 1.6 + Math.sin(a) * len / 2, a, len, 0.45 + R() * 0.5, 0.99, i * 0.1, (R() - 0.5) * 0.3); } };
      const CR = (this.craters || []).filter(c => c[1] > -125 && Math.abs(c[0]) < 95 && c[2] > 2);
      for (let i = 0; i < Math.min(6, CR.length); i++) { const c = CR[(i * 3) % CR.length]; heap(c[0], c[1], 3 + Math.floor(R() * 3)); }
      for (const [x, z] of [[-30, -31], [-58, -62], [44, -84], [-88, -104], [-16, -25], [-9, -41], [-40, -52]]) heap(x, z, 3 + Math.floor(R() * 3));
      for (const [x, z, yaw, n] of [[-50, -38, 0.12, 3], [6, -76, -0.2, 3], [-24, -120, 0.05, 4], [72, -58, 0.3, 2], [-44, -27, -0.1, 3]]) for (let i = 0; i < n; i++) coil(x + i * 5.9 * Math.cos(yaw), z - i * 5.9 * Math.sin(yaw), yaw + (R() - 0.5) * 0.12, 6, R() < 0.25 ? 0.4 : R() * 0.1, n === 1 ? 0.99 : i === 0 ? 0.05 : i === n - 1 ? 0.92 : R() < 0.2 ? 0.3 + R() * 0.4 : 0);
      /* (v14) the position's own wire, 12-14 m out from the parapet where the eye falls on the field: two rows of concertina on
         steel pickets, shelled - lengths crushed, a gap blown through, sprung ends; heaps of it thrown aside; a row of
         hedgehogs beyond. (The loose coils further out were all there was: at 30-100 m in this light nobody saw them.) */
      const pk = [], belt = (x0, z0, n, yaw, gap) => { for (let i = 0; i < n; i++) { const x = x0 + i * 5.9 * Math.cos(yaw), z = z0 - i * 5.9 * Math.sin(yaw); if (i === gap) { heap(x + 3, z + 1.5, 3); continue; } coil(x, z, yaw + (R() - 0.5) * 0.1, 6, R() < 0.3 ? 0.35 + R() * 0.3 : R() * 0.08, i === gap - 1 ? 0.9 : i === gap + 1 ? 0.06 : 0); for (const t of [0, 3]) pk.push([x + t * Math.cos(yaw), z - t * Math.sin(yaw)]); } };
      belt(-39, -20.2, 11, 0.03, 4); belt(-36, -21.7, 10, 0.025, 6);
      heap(-9.5, -16.4, 5); heap(4.2, -17.3, 4); heap(-21, -15.6, 4); heap(-30, -17.8, 3);
      const wm = new THREE.InstancedMesh(coilGeo(1), wireMats()[0], coils.length); coils.forEach((M, i) => { wm.setMatrixAt(i, M); wm.setColorAt(i, cols[i]); }); wm.frustumCulled = false; pixHook(wm); scene.add(wm);
      const steel = new THREE.MeshStandardMaterial({ color: 0x2b241e, roughness: 0.85, metalness: 0.3 });
      const pm = new THREE.InstancedMesh(new THREE.BoxGeometry(0.035, 1.25, 0.035).translate(0, 0.5, 0), steel, pk.length); pk.forEach(([x, z], i) => pm.setMatrixAt(i, new THREE.Matrix4().compose(V(x, gy(x, z) - 0.02, z), new THREE.Quaternion().setFromEuler(E.set((R() - 0.5) * 0.3, R() * 6, (R() - 0.5) * 0.3)), V(1, 0.85 + R() * 0.25, 1)))); pm.frustumCulled = false; scene.add(pm);
      /* hedgehogs: three 1.5 m lengths of I-beam bolted at right angles, standing on three ends (the rotation that stands the cube diagonal up) */
      { const q0 = new THREE.Quaternion().setFromUnitVectors(V(1, 1, 1).normalize(), V(0, 1, 0)), parts = [[0, 0, 0], [0, 0, Math.PI / 2], [Math.PI / 2, 0, 0]].map(([rx, ry, rz]) => new THREE.BoxGeometry(0.12, 1.5, 0.1).applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz))).applyQuaternion(q0));
        const HG = [[-17, -25.5], [-11.5, -27], [-5.5, -25.2], [1, -27.4], [7.5, -25.8], [-24, -27.2], [14, -27]], hm = parts.map(g => new THREE.InstancedMesh(g, steel, HG.length));
        HG.forEach(([x, z], i) => { const M = new THREE.Matrix4().compose(V(x, gy(x, z) + 0.41, z), new THREE.Quaternion().setFromEuler(E.set((R() - 0.5) * 0.12, R() * 6.28, (R() - 0.5) * 0.12)), V(1, 1, 1)); for (const m of hm) m.setMatrixAt(i, M); }); for (const m of hm) { m.frustumCulled = false; scene.add(m); } } }
    // ---- panel blocks: front facade (to the viewer) and both ends from kit pieces, a roof slab and a dark core behind them
    const W = 3.2, H = 2.8, dark = new THREE.MeshBasicMaterial({ color: 0x060606 }), roofM = new THREE.MeshStandardMaterial({ color: 0x1b1a19, roughness: 0.9 });
    const block = (xc, zf, bays, floors, kind, hit = 0) => {
      const x0 = xc - bays * W / 2, x1 = x0 + bays * W, yb = PLAIN + 0.9, D = 4, top = yb + floors * H, K = n => T(n), pre = kind === 'wall' ? 'wall' : kind;
      // shell hits: a flat or two blown open (panels gone, the floor slab hanging), the cells round them holed and cracked,
      // soot up the wall above every one that burnt; a few more flats burnt out without a hole
      const hits = []; for (let k = 0; k < hit; k++) hits.push([1 + Math.floor(R() * (bays - 2)), 1 + Math.floor(R() * (floors - 1)), R() < 0.8]);
      for (let i = 0; i < bays; i++) {
        put(K('plinth'), x0 + i * W, PLAIN, zf);
        for (let f = 0; f < floors; f++) {
          let d = 99, burn = false; for (const [hb, hf, fire] of hits) { const q = Math.hypot(i - hb, (f - hf) * 1.25); if (q < d) { d = q; burn = fire; } }
          const y = yb + f * H, ent = f === 0 && i % 6 === 2, bal = !ent && f > 0 && i % 4 === 1, gut = d > 2.7 && R() < 0.035;
          const st = d < 0.7 ? '_destroyed' : d < 1.6 ? '_holed' : d < 2.7 || gut ? '_damaged' : '_intact';
          put(K(`${pre}_${ent ? 'entrance' : bal ? 'balcony' : 'window'}${st}`) || K(`${pre}_window${st}`) || K(`${pre}_window_intact`), x0 + i * W, y, zf);
          if (ent) put(K('entrance_canopy'), x0 + i * W, y, zf);
          if (bal && st === '_intact') put(K(R() < 0.4 ? 'balcony_slab_glazed' : R() < 0.5 ? 'balcony_slab_open' : 'balcony_slab'), x0 + i * W, y, zf);
          if (d < 0.7 && burn) this.fires.push([x0 + (i + 0.5) * W, y + 1.5, zf + 0.4, 2.6 + R() * 1.6]);
          else if (d < 1.8 && burn && R() < 0.45) this.fires.push([x0 + (i + 0.5) * W, y + 1.5, zf + 0.3, 1.3 + R() * 0.8, 0, 1]);   /* the fire in the flats next door */
          if (d < 0.7 && f === 0 || (d < 0.7 && R() < 0.5)) put(K(R() < 0.5 ? 'collapse_pile_large' : 'collapse_pile_small'), x0 + (i + 0.5) * W, PLAIN, zf + 1.6, R() * 6);
          if ((d < 2.2 && (burn || R() < 0.5)) || gut) this.soot.push([x0 + (i + 0.5) * W + (R() - 0.5) * 0.3, y + 2.2 + (d < 0.7 ? 0.6 : 0), zf + 0.06, 2.2 + R() * 1.2, 2.6 + R() * 2.4]);
        }
        put(K(kind === 'wall' ? 'roof_parapet' : `${kind}_parapet`) || K('roof_parapet'), x0 + i * W, top, zf);
      }
      for (let j = 0; j < D; j++) {
        put(K('plinth'), x1, PLAIN, zf - j * W, Math.PI / 2); put(K('plinth'), x0, PLAIN, zf - (j + 1) * W, -Math.PI / 2);
        for (let f = 0; f < floors; f++) { put(K(`${pre}_blank_end_intact`), x1, yb + f * H, zf - j * W, Math.PI / 2); put(K(`${pre}_blank_end_intact`), x0, yb + f * H, zf - (j + 1) * W, -Math.PI / 2); }
      }
      const core = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 - 0.7, top - PLAIN, D * W - 0.5), dark); core.position.set(xc, (top + PLAIN) / 2, zf - 0.4 - (D * W - 0.5) / 2); scene.add(core);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 - 0.2, 0.3, D * W - 0.2), roofM); roof.position.set(xc, top + 0.15, zf - D * W / 2); scene.add(roof);
      if (floors > 5) for (let k = 0, n = Math.max(1, Math.round(bays / 7)); k < n; k++) put(K('roof_machine_room'), x0 + ((k + 0.5) / n) * (x1 - x0) - 1.6, top + 0.3, zf - 4);
      for (let k = 0; k < bays / 5; k++) put(K(R() < 0.6 ? 'roof_vent' : 'roof_antenna'), x0 + R() * (x1 - x0 - 3.2), top + 0.3, zf - 3 - R() * 5);
    };
    for (const [x, z, bays, fl, kind, hit] of [[-250, -150, 18, 5, 'brick', 1], [-168, -172, 22, 5, 'brick_red', 1], [-92, -158, 14, 9, 'wall', 1], [-150, -236, 24, 9, 'wall', 1], [-40, -228, 20, 5, 'brick', 1],
      [86, -166, 18, 9, 'wall', 1], [150, -196, 22, 5, 'brick_red', 0], [120, -252, 18, 9, 'wall', 1], [222, -172, 20, 9, 'wall', 1], [292, -204, 22, 5, 'brick', 0], [20, -292, 28, 9, 'wall', 1], [-262, -262, 22, 9, 'wall', 0],
      [182, -238, 6, 14, 'wall', 0], [-206, -216, 6, 14, 'wall', 0]]) block(x, ROAD_Z + z, bays, fl, kind, hit ? 1 + Math.floor(R() * 2.6) : R() < 0.5 ? 1 : 0);
    for (let k = 0; k < 60; k++) { const x = (R() - 0.5) * 660, z = ROAD_Z - 128 - R() * 160; put(far(R() < 0.4 ? 'tree_poplar_leafy' : gard[Math.floor(R() * 3)]), x, PLAIN, z, R() * 6.28, 0.9 + R() * 0.4); }
    // ---- one InstancedMesh per sub-mesh of every placed model (foliage dulled: under this light the leaf cards' gloss made
    // the trees sparkle like plastic)
    const rel = new THREE.Matrix4(), inv = new THREE.Matrix4(), dull = new Map();
    // (v8: unlit - one flat tone per tree, as foliage reads at 200 m under an overcast; lit, every leaf card took its own shade)
    const kitSet = new Set(); kit.scene.traverse(o => kitSet.add(o)); const dim = new Map();
    const matOf = (t, m) => { if (kitSet.has(t)) { let d = dim.get(m); if (!d) { d = m.clone(); d.color.multiplyScalar(0.5).lerp(new THREE.Color(0x4a4c4c), 0.2); dim.set(m, d); } return d; }   /* (pale concrete panels a kilometre off under a dark sky: grey, not white) */
      if (!/^(tree_|bush)/.test(t.name)) return m; let d = dull.get(m); if (!d) { d = new THREE.MeshBasicMaterial({ map: m.map, alphaTest: m.alphaTest || (m.transparent ? 0.4 : 0), side: m.side, color: m.color.clone().multiplyScalar(m.map ? 0.27 : 0.22).lerp(new THREE.Color(0x1f241d), 0.25), fog: true });   /* (v9: they glowed - a tree line under a low overcast is a dark mass) */ d.name = m.name; dull.set(m, d); } return d; };
    for (const [t, Ms] of bins) {
      t.updateWorldMatrix(true, true); inv.copy(t.matrixWorld).invert();
      t.traverse(o => {
        if (!o.isMesh || o.visible === false) return;
        rel.multiplyMatrices(inv, o.matrixWorld);
        const im = new THREE.InstancedMesh(o.geometry, Array.isArray(o.material) ? o.material.map(m => matOf(t, m)) : matOf(t, o.material), Ms.length); im.frustumCulled = false;
        Ms.forEach((M, i) => im.setMatrixAt(i, M4.multiplyMatrices(M, rel))); im.instanceMatrix.needsUpdate = true; scene.add(im);
      });
    }
    // soot up the walls over the burnt flats: ragged black fans, widest at the window head
    if (this.soot.length) {
      const c = document.createElement('canvas'); c.width = 64; c.height = 128; const x = c.getContext('2d'), g = x.createLinearGradient(0, 128, 0, 0); g.addColorStop(0, 'rgba(0,0,0,.95)'); g.addColorStop(0.35, 'rgba(0,0,0,.7)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g;
      x.beginPath(); x.moveTo(6, 128); for (let k = 0; k <= 10; k++) x.lineTo(6 + k * 5.2 + (R() - 0.5) * 5, 128 - (k % 2 ? 70 : 118) * (0.6 + R() * 0.4) * Math.sin((k + 0.5) / 11 * Math.PI) ** 0.4); x.lineTo(58, 128); x.fill();
      const st = new THREE.CanvasTexture(c), sm = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ map: st, transparent: true, depthWrite: false, opacity: 0.92, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: true }), this.soot.length);
      this.soot.forEach(([x_, y_, z_, w, h], i) => sm.setMatrixAt(i, M4.compose(V(x_, y_, z_), Q.identity(), V(w, h, 1)))); sm.frustumCulled = false; scene.add(sm);
    }
    for (const [x, y, z, sz, roof, quiet] of this.fires) this.addFire(scene, x, y, z, sz, roof, quiet);
    /* (v14) shells falling in the town again: a flash, the burst of dirt and smoke thrown up, the cloud leaning away on the wind
       and thinning out over ten seconds; one every few seconds somewhere among the houses and blocks, now and then a pair */
    { const fm = new THREE.SpriteMaterial({ map: this.dot('255,214,160'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, opacity: 0 }), sm = new THREE.SpriteMaterial({ map: this.dot('46,42,38'), depthWrite: false, transparent: true, opacity: 0 });
      this.blasts = Array.from({ length: 5 }, () => { const f = new THREE.Sprite(fm.clone()), c = new THREE.Sprite(sm.clone()), d = new THREE.Sprite(sm.clone()); for (const q of [f, c, d]) { q.visible = false; scene.add(q); } return { f, c, d, t: 99 }; }); this.blastT = 2.5; }
    this.townIn = true; this._full = setTimeout(() => { this.full = true; }, 1800);   /* the painted town goes now */
    if (window.__menu3d) window.__menu3d.town = bins.size;
  }
  soldiers(scene, sg, ag, rifle) {
    const clipOf = n => ag.animations.find(a => a.name === n);
    const man = (x, d, yaw, clip, combo, t0, ts) => {
      const m = SkeletonUtils.clone(sg.scene), keep = new Set([combo, combo + '_tape']), z = crestZ(x) + d;
      m.traverse(o => { if (o.isMesh && [].concat(o.material).some(q => /^tape/i.test(q?.name || ''))) { o.material = tapeMaterial(o.material.clone()); o.material.color.setHex(0xf2c81a); } });
      m.traverse(o => { if (!o.isMesh) return; o.frustumCulled = false; let n = o, hit = null; while (n) { if (keep.has(n.name.replace(/_LOD1$/, ''))) { hit = n; break; } n = n.parent; } o.visible = !!hit && !/_LOD1$/.test(hit.name); });
      m.position.set(x, FY + 0.105, z); m.rotation.y = yaw; scene.add(m);   /* (on the duckboards) */
      const mixer = new THREE.AnimationMixer(m), a = clipOf(clip) || clipOf('crouch_idle'); if (a) { const act = mixer.clipAction(a); act.timeScale = ts; act.play(); act.time = t0; }
      const w = rifle.scene.clone(true); w.traverse(o => { if (o.isMesh && /_LOD1$/i.test(o.name)) o.visible = false; }); m.getObjectByName('weapon_socket')?.add(w);
      const B = n => m.getObjectByName(n);
      return { m, mixer, yaw, spine: B('Spine1'), spine0: B('Spine'), neck: B('Neck'), head: B('Head'), ph: Math.random() * 6 };
    };
    // the watcher: kneeling 0.8 m behind the crest, body a quarter left so the rifle in his hands lies along the berm, head turned
    // back over the crest to the road; the other: sitting at the foot of the berm with his back on it, a little toward his mate
    const a = man(1.45, 1.02, Math.PI + 0.62, 'crouch_idle', 'combo_0', 0.4, 0.7); a.watch = true;
    // (v3: 'ride_sit_deck' is a man perched on a hull with his rifle upright between his knees - on the ground he hovered and held
    // it like a staff. This is the game's sitting-on-the-ground pose: back against the slope, one knee up, one leg out, a hand on
    // the knee; his rifle stands propped against the berm at his side)
    const b = man(2.85, 0.76, -0.3, 'wounded_sit', 'combo_2', 0.0, 0.0001); b.sit = true;
    const rw = b.m.getObjectByName('weapon_socket')?.children[0];
    if (rw) {
      // butt on the duckboard 0.66 m out from the logs, the fore-end resting on them: 18 deg off the vertical, magazine to the viewer
      const bx = 2.85 - 0.7, bz = (this.plyFront ?? crestZ(bx) + WALL + 0.24) + 0.025 + 0.29, by = (this.boardTop ?? FY + 0.105) + 0.005,   /* (v14: against the plywood sheet that stands there now, butt on the boards) */ zm = new THREE.Vector3(0, 0.949, -0.316), ym = new THREE.Vector3(0, -0.316, -0.949), xm = new THREE.Vector3().crossVectors(ym, zm);
      scene.add(rw); rw.matrix.makeBasis(xm, ym, zm); rw.matrix.decompose(rw.position, rw.quaternion, rw.scale); rw.scale.set(1, 1, 1); rw.position.set(bx, by, bz).addScaledVector(zm, 0.34).addScaledVector(ym, 0.04);
      rw.traverse(o => { o.frustumCulled = false; });
    }
    this.men = [a, b];
  }
  resize() {
    if (!this.renderer) return; const w = innerWidth, h = innerHeight;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5)); this.renderer.setSize(w, h, false);
    this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
  }
  has(kind) { return !!this.veh[kind]; }
  // ---------------------------------------------------------------- frame (after the backdrop has drawn)
  render() {
    if (!this.ready || !this.running || !this.renderer) return;
    const now = performance.now(), dt = Math.min(0.1, (now - this.clock) / 1000); this.clock = now; this.t = (this.t || 0) + dt;
    const bd = this.bd, t = this.t, tanH = Math.tan(VFOV / 2 * D2R) * this.cam.aspect;
    // the viewer shifts a little with the pointer (the painting's parallax, now a real one)
    this.cam.position.set((bd.px || 0) * 0.35 + Math.sin(t * 0.05) * 0.12, -(bd.py || 0) * 0.08, 0); this.cam.rotation.y = -(bd.px || 0) * 0.006;
    this.onCam?.(this.cam);   /* (dev: a close-up for checking the men) */
    // the two men: the clip, then life on top (breath, small shifts of weight, the watcher's eyes along the road, the sitter's head)
    for (const s of this.men) {
      s.mixer.update(dt);
      const br = Math.sin(t * 1.25 + s.ph), sw = Math.sin(t * 0.43 + s.ph * 1.7), sw2 = Math.sin(t * 0.71 + s.ph), look = Math.sin(t * 0.17 + s.ph) * 0.5 + Math.sin(t * 0.07 + s.ph * 2) * 0.5;
      /* (v9) a slight sway of the whole man: weight shifting on the knee / against the wall, never still */
      s.m.rotation.set(Math.sin(t * 0.37 + s.ph * 1.3) * 0.013 + br * 0.004, s.yaw + Math.sin(t * 0.23 + s.ph) * 0.02, Math.sin(t * 0.51 + s.ph * 0.7) * (s.watch ? 0.018 : 0.01), 'YXZ');
      if (s.watch) {
        s.spine0?.rotateX(0.16 + br * 0.006); s.spine?.rotateX(0.12 + br * 0.02); s.spine?.rotateY(-0.2 + sw * 0.035); s.spine?.rotateZ(sw2 * 0.015);
        s.neck?.rotateY(-0.16); s.neck?.rotateX(-0.14); s.head?.rotateY(-0.24 + look * 0.2); s.head?.rotateX(-0.12 + sw2 * 0.02);
      } else {
        s.spine?.rotateX(br * 0.02); s.spine?.rotateZ(sw2 * 0.014);
        s.neck?.rotateX(0.62); s.head?.rotateX(0.68 + br * 0.015 + sw * 0.02); s.head?.rotateZ(0.06 * sw2);   /* head down, chin on his chest: resting (the clip throws it back) */
      }
    }
    // the convoy: the backdrop's timing (v.x in its pixels across the view) on the 3-D road
    const [ox] = bd._mo || [0], W = bd.W, seen = new Set(), half = tanH * -ROAD_Z;
    for (const v of bd.convoy || []) {
      const K = this.veh[v.k]; if (!K) continue;
      let o = this.pool.get(v);
      if (!o) { o = K.src.clone(true); this.scene.add(o); this.pool.set(v, o); }
      seen.add(v);
      const img = bd.vehSprites[v.k], nx = (v.x + ox + img.width / 2) / W * 2 - 1;
      o.position.set(nx * half, PLAIN + 0.06 + Math.sin(t * 9 + v.ph) * 0.015, ROAD_Z + (v.dir > 0 ? 1.7 : -1.7));
      o.rotation.y = v.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      if (Math.random() < dt * 7) { const d = this.dust.find(q => q.userData.life >= q.userData.max || !q.visible); if (d) { d.visible = true; d.userData.life = 0; d.userData.max = 2.2 + Math.random() * 1.8; d.userData.vx = -v.dir * (0.6 + Math.random()); d.position.set(o.position.x - v.dir * (K.len / 2 + 0.5), PLAIN + 0.7, o.position.z + (Math.random() - 0.5) * 2); d.userData.r = 1.6 + Math.random(); } }
    }
    for (const [v, o] of this.pool) if (!seen.has(v)) { this.scene.remove(o); this.pool.delete(v); }
    for (const d of this.dust) { if (!d.visible) continue; const u = d.userData; u.life += dt; if (u.life >= u.max) { d.visible = false; continue; } const k = u.life / u.max; d.position.x += u.vx * dt; d.position.y += 0.5 * dt; const r = u.r * (1 + k * 3.2); d.scale.set(r * 1.6, r, 1); d.material.opacity = 0.34 * Math.min(1, u.life / 0.3) * (1 - k); }
    let fl0 = 1;
    for (const [i, g] of (this.glows || []).entries()) { const f = 0.82 + 0.12 * Math.sin(t * 2.3 + i * 3) + 0.06 * Math.sin(t * 5.1 + i * 1.7); g.scale.set(g.userData.s * f * 1.15, g.userData.s * f * 0.8, 1); g.material.opacity = 0.3 * f; if (!i) fl0 = f; }
    this.fl?.update(dt, t, this.cam.position, this.scene.fog?.density);
    for (const m of this.smokes || []) { const u = m.userData, k = (t * u.sp + u.ph) % 1; m.position.set(u.x + k * k * 26, u.y + k * 34, u.z); const r = u.s * (1 + k * 4.5); m.scale.set(r, r, 1); m.material.opacity = 0.5 * Math.min(1, k * 6) * (1 - k); }
    if (this.blasts) {
      this.blastT -= dt;
      if (this.blastT <= 0) { const B = this.blasts.find(q => q.t > 11); this.blastT = Math.random() < 0.25 ? 0.5 + Math.random() * 0.6 : 3 + Math.random() * 6;
        if (B) { B.t = 0; B.x = (Math.random() - 0.5) * 520; B.z = ROAD_Z - 22 - Math.random() * 170; B.s = 0.8 + Math.random() * 0.7; for (const q of [B.f, B.c, B.d]) q.visible = true; } }
      for (const B of this.blasts) { if (B.t > 11) { if (B.f.visible) for (const q of [B.f, B.c, B.d]) q.visible = false; continue; } B.t += dt; const u = B.t, s = B.s;
        B.f.position.set(B.x, PLAIN + 3, B.z + 1); B.f.scale.setScalar(11 * s * (1 + u * 2)); B.f.material.opacity = u < 0.06 ? 1 : Math.max(0, 1 - (u - 0.06) / 0.35);
        /* the dirt thrown straight up (fast, falls back), then the smoke that stays and drifts */
        const k = Math.min(1, u / 0.7), up = 1 - (1 - k) * (1 - k); B.d.position.set(B.x, PLAIN + 2 + 6 * s * up - Math.max(0, u - 0.9) * 2.2, B.z); B.d.scale.set(5 * s * (0.6 + up), 11 * s * (0.4 + up), 1); B.d.material.opacity = 0.85 * Math.min(1, u / 0.08) * Math.max(0, 1 - Math.max(0, u - 0.8) / 1.6);
        const g = Math.min(1, u / 10); B.c.position.set(B.x + g * 12, PLAIN + 4 * s + g * 16, B.z - 0.5); const r = s * (6 + 15 * Math.sqrt(g)); B.c.scale.set(r * 1.25, r, 1); B.c.material.opacity = 0.7 * Math.min(1, u / 0.25) * (1 - g) * (1 - g); }
    }
    if (this.rim) this.rim.intensity = 26 * (0.85 + 0.15 * fl0);
   /* the fires' light on the two men flickers with them */
    this.renderer.render(this.scene, this.cam);
  }
}
