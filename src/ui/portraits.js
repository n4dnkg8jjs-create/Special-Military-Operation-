import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { WEAPON_ASSET } from '../game/soldier.js';

// Unit card art (deck cards, unit card): a true side profile of the unit's own models, the way WARNO's cards show the
// vehicle. Rendered once per kind of unit with the game's renderer into a small offscreen target (orthographic camera on
// the unit's left side, so the front faces right; neutral studio light + the battle's sky light), read back, cached as an
// image URL. No per-frame work: portraitHTML() is a cache lookup after the first call for a key.
//   vehicles: the GLB as the game builds it (LOD0, no wreck parts, hidden helpers off)
//   infantry: a few of the faction's soldier models posed from the game's own clips with their weapons / kit
//     squad: rifle, PKM, RPG-7, rifle · assault: optic rifles + PKM (assault presets) · crew: pistols (crew presets)
//     ATGM team: the deployed Kornet / Stugna-P with its gunner on the seat · FPV team: pilot in goggles + the drone
const W = 640, H = 256, OW = 320, OH = 128;   // render 2x, keep 320x128 (2.5:1, the card plate's shape)
const cache = new Map();
// linear -> soft shoulder -> sRGB byte, for linear values 0..3 in 4096 steps
const LUT = new Uint8Array(4096).map((_, i) => { let v = i / 1365; v = Math.min(1, v / (1 + v * 0.18) * 1.18); return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255); });
let R = null;   // { game, rt, scene, cam, buf, cv }

function setup(game) {
  if (R?.game === game) return R;
  const r = game?.renderer?.r; if (!r || !game.assets?.gltf) return null;
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, depthBuffer: true });
  const scene = new THREE.Scene();
  scene.environment = game.scene?.environment || null; scene.environmentIntensity = 0.55;
  scene.add(new THREE.HemisphereLight(0xe4e9ee, 0x45443d, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 2.6); key.position.set(-6, 7, 2.5); scene.add(key);
  const rim = new THREE.DirectionalLight(0xdfe6ff, 0.6); rim.position.set(4, 3, -6); scene.add(rim);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const cv = document.createElement('canvas'); cv.width = OW; cv.height = OH;
  const big = document.createElement('canvas'); big.width = W; big.height = H;
  R = { game, rt, scene, cam, buf: new Float32Array(W * H * 4), cv, big };
  return R;
}

// ---- model builders
const hideHelpers = o => o.traverse(x => { if (x.userData?.hidden || /_LOD\d$/i.test(x.name) || /_wreck$/i.test(x.name) || /\(fresh\)$/.test(x.name)) x.visible = false; });
function vehicleModel(g) { const m = g.scene.clone(true); hideHelpers(m); return m; }

function clip(game, name) {
  const A = game.assets.gltf;
  for (const g of [A.soldier_anims, A.soldier_ua, A.soldier_ru]) { const c = g?.animations?.find(a => a.name === name); if (c) return c; }
  return null;
}
// one soldier: the faction's model with one preset (combo) shown, posed at time t of a clip, weapon in hand
function soldierModel(game, faction, { pre = '', n = 0, wk = 'ak74m', pose = 'aim_stand', t = 0.4, leader = false, kit = null } = {}) {
  const A = game.assets.gltf, g = A[faction.soldierAsset]; if (!g) return null;
  const m = SkeletonUtils.clone(g.scene);
  const combos = []; m.traverse(o => { const k = o.name.match(/^((?:assault_|crew_)?combo_\d+)$/); if (k) combos.push(k[1]); });
  const pool = combos.filter(c => (c.match(/^(assault_|crew_)/)?.[1] || '') === pre), lead = c => m.getObjectByName(c)?.userData?.preset?.comms_role === 'leader';
  const byRole = pool.filter(c => lead(c) === leader), list = byRole.length ? byRole : pool.length ? pool : combos;
  const combo = list.length ? list[n % list.length] : null;
  m.traverse(o => {
    if (!o.isMesh) return;
    let on = true, inCombo = false;
    for (let p = o; p && p !== m; p = p.parent) {
      const nm = p.name.replace(/\.\d+$/, '');
      if (/_LOD\d$/i.test(nm) || /^sling/i.test(nm) || /^(body|helmet)_[B-Z]$/.test(nm)) on = false;
      if (combo && (nm === combo || nm === combo + '_tape')) inCombo = true;
    }
    if (combo) on = on && inCombo;   // a preset (combo) replaces every per-part node
    o.visible = on; o.frustumCulled = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((mt, i) => { if (mt && /^tape/i.test(mt.name)) { const c = mt.clone(); c.color.set(faction.tape); if (Array.isArray(o.material)) o.material[i] = c; else o.material = c; } });
  });
  const sock = m.getObjectByName('weapon_socket');
  const put = (gk, par, node) => { const s = A[gk]; const src = s && (node ? s.scene.getObjectByName(node) : s.scene); if (!src || !par) return null; const w = src.clone(true); w.position.set(0, 0, 0); w.quaternion.identity(); hideHelpers(w); par.add(w); return w; };
  if (wk && WEAPON_ASSET[wk]) put(WEAPON_ASSET[wk], sock);
  if (kit === 'fpv') {
    const head = m.getObjectByName('Head') || m.getObjectByName('head'), gog = A.fpv_goggles?.scene.clone(true);
    if (gog && head) { const ha = gog.getObjectByName('head_attach'); if (ha) gog.position.copy(ha.position).negate(); hideHelpers(gog); head.add(gog); }
    put('fpv_controller', sock);
  }
  const c = clip(game, pose);
  if (c) { const mx = new THREE.AnimationMixer(m); mx.clipAction(c).play(); mx.update(Math.min(t, Math.max(0, c.duration - 0.01))); }
  return m;
}

// what to put in front of the camera for unit u (and the cache key)
function build(game, u) {
  const A = game.assets.gltf, F = u.faction || {};
  if (u.type === 'vehicle') {
    const k = u.assetKey || u.def?.asset; const g = k && A[k];
    if (g) return { key: 'v:' + k, obj: vehicleModel(g) };
    return u.model ? { key: 'v:' + (u.kind || 'x') + ':' + F.id, obj: u.model.clone(true) } : null;
   }
  const g = new THREE.Group(), men = [];
  const add = (o, z, x = 0, ry = 0) => { if (!o) return; o.position.set(x, 0, z); o.rotation.y = ry; g.add(o); men.push(o); };
  const rifle = F.id === 'RU' ? 'ak12' : 'ak74o', S = (o) => soldierModel(game, F, o);
  let key = `i:${F.id}:`;
  if (u.crew) { key += 'crew'; add(S({ pre: 'crew_', n: 0, wk: 'pm', pose: 'pistol_idle', leader: true }), 0.5); add(S({ pre: 'crew_', n: 1, wk: 'pm', pose: 'pistol_aim', t: 0.3 }), -0.5, 0.5); }
  else if (u.kind === 'atgm') {
    key += 'atgm';
    const L = A[F.id === 'RU' ? 'kornet' : 'stugna'];
    if (L) {
      const l = L.scene.clone(true); hideHelpers(l); const fold = l.getObjectByName('folded'); if (fold) fold.visible = false;
      const seat = l.getObjectByName('seat')?.position || new THREE.Vector3(0, 0, -0.75);
      l.position.set(-seat.x, 0, 0.4 - seat.z); g.add(l);
      add(S({ wk: null, pose: 'atgm_aim', t: 0.3, leader: true }), 0.4);
    }
    add(S({ wk: 'ak74m', pose: 'idle_rifle', n: 2 }), -1.1, 0.8);
  } else if (u.kind === 'fpv') {
    key += 'fpv';
    add(S({ wk: 'ak74m', pose: 'idle_rifle', t: 0.7, n: 1 }), -0.9, 0.7);
    add(S({ wk: null, pose: 'fpv_pilot', t: 0.5, kit: 'fpv', leader: true }), 0.1);
    const d = A.fpv_drone?.scene.clone(true); if (d) { hideHelpers(d); d.position.set(0, 1.3, 1.0); d.rotation.set(0.3, 0, 0); g.add(d); }
  } else if (u.assault) {
    key += 'assault';
    add(S({ pre: 'assault_', n: 0, wk: rifle, pose: 'aim_stand', t: 0.3, leader: true }), 1.5);
    add(S({ pre: 'assault_', n: 1, wk: rifle, pose: 'idle_rifle', t: 0.6 }), 0.4, 0.6);
    add(S({ pre: 'assault_', n: 2, wk: 'pkm', pose: 'idle_rifle', t: 1.1 }), -0.7, 0);
  } else {
    key += 'squad';
    add(S({ n: 0, wk: 'ak74m', pose: 'aim_stand', t: 0.3, leader: true }), 1.7);
    add(S({ n: 1, wk: 'pkm', pose: 'idle_rifle', t: 0.2 }), 0.65, 0.7);
    add(S({ n: 2, wk: 'rpg7', pose: 'idle_rifle', t: 0.9 }), -0.4, 0);
    add(S({ n: 3, wk: 'ak74m', pose: 'idle_rifle', t: 1.4 }), -1.45, 0.7);
  }
  return men.length ? { key, obj: g } : null;
}

// visible meshes only (skinned meshes in their posed bounds)
function bounds(obj) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3(), b = new THREE.Box3();
  obj.traverseVisible(o => {
    if (!o.isMesh) return;
    if (o.isSkinnedMesh) { o.computeBoundingBox(); b.copy(o.boundingBox).applyMatrix4(o.matrixWorld); }
    else { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); b.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld); }
    box.union(b);
  });
  return box;
}

function render(game, obj) {
  const S = setup(game); if (!S) return null;
  const r = game.renderer.r, { scene, cam, rt } = S;
  scene.add(obj);
  const box = bounds(obj); if (box.isEmpty()) { scene.remove(obj); return null; }
  // side view from -X looking +X: screen right = +Z (the unit's front), up = +Y; fit the box with a margin, feet on the bottom
  const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
  const half = Math.max(sz.z / 2 * 1.03, sz.y * 1.04 * (W / H) / 2), hh = half * H / W;
  cam.left = -half; cam.right = half; cam.top = hh; cam.bottom = -hh; cam.near = 0.1; cam.far = sz.x + 20;
  cam.position.set(box.min.x - 10, box.min.y - sz.y * 0.03 + hh, c.z); cam.lookAt(cam.position.x + 1, cam.position.y, cam.position.z); cam.updateProjectionMatrix();
  const prev = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha(), ac = r.autoClear, sh = r.shadowMap.autoUpdate;
  try {
    r.shadowMap.autoUpdate = false; r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.autoClear = true; r.clear(); r.render(scene, cam);
    r.readRenderTargetPixels(rt, 0, 0, W, H, S.buf);
  } finally { r.setRenderTarget(prev); r.setClearColor(cc, ca); r.autoClear = ac; r.shadowMap.autoUpdate = sh; scene.remove(obj); }
  obj.traverse(o => { if (o.isSkinnedMesh) o.skeleton?.dispose(); });
  // linear float -> soft shoulder -> sRGB bytes, flipped (GL rows are bottom-up), then a smooth 2:1 downscale
  const big = S.big, bx = big.getContext('2d'), img = bx.createImageData(W, H), d = img.data, f = S.buf;
  const enc = v => v <= 0 ? 0 : LUT[Math.min(4095, (v * 1365) | 0)];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = ((H - 1 - y) * W + x) * 4, o = (y * W + x) * 4, a = f[i + 3];
    if (a <= 0.002) { d[o + 3] = 0; continue; }
    const k = 1 / Math.min(1, a);   // (un-premultiply the edges)
    d[o] = enc(f[i] * k); d[o + 1] = enc(f[i + 1] * k); d[o + 2] = enc(f[i + 2] * k); d[o + 3] = Math.round(Math.min(1, a) * 255);
  }
  bx.putImageData(img, 0, 0);
  const x = S.cv.getContext('2d'); x.clearRect(0, 0, OW, OH); x.imageSmoothingQuality = 'high'; x.drawImage(big, 0, 0, OW, OH);
  // a short blob: URL (not a long data: URL) so the unit card's markup stays small
  const b64 = S.cv.toDataURL('image/png').split(',')[1], bin = atob(b64), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([u8], { type: 'image/png' }));
}

// image URL of unit u's portrait ('' when it can't be made: no renderer / models), rendered on first use
export function portraitURL(game, u) {
  if (!u) return '';
  const k0 = u._ptKey; if (k0 && cache.has(k0)) return cache.get(k0);
  let url = '';
  try {
    if (!setup(game)) return '';
    const b = build(game, u); if (!b) return '';
    u._ptKey = b.key;
    if (cache.has(b.key)) { b.obj.traverse(o => { if (o.isSkinnedMesh) o.skeleton?.dispose(); }); return cache.get(b.key); }
    url = render(game, b.obj) || '';
    cache.set(b.key, url);
  } catch (e) { console.warn('portrait', e); }
  return url;
}
export function portraitHTML(game, u) { const s = portraitURL(game, u); return s ? `<img class="pt" src="${s}" alt="" draggable="false">` : '<i class="pt"></i>'; }
// render every unit's portrait up front (battle start), so the first click on an enemy doesn't hitch
export function warmPortraits(game) { for (const u of [...(game.squads || []), ...(game.vehicles || [])]) portraitURL(game, u); }
