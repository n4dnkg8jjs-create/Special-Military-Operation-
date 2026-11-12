// Shelled trees.  A HE burst near trees (shell, mortar bomb, tank HE, RPG, a vehicle cooking off: every fx.explosion)
// blows leaves off the crowns around it, throws splinters and branches, and close / repeated hits snap the trunk: a
// stump is left and the top falls away from the burst.  Damage accumulates per tree, so a treeline under steady fire
// is shredded into bare poles and stumps.
//
// Performance: no per-tree objects in the scene.  The trees stay in their instancer.js InstancedMeshes; a stripped
// crown is the leaf sub-mesh instance scaled down / zeroed, a snapped tree has all its instances zeroed (every LOD level
// + the coarse far blocks, via PLACED[].parts), and only the touched 16-float ranges are uploaded.  Leaves (<= 600
// quads), wood fragments (<= 200), stumps and fallen tops are fixed-size pooled InstancedMeshes; the per-frame update
// writes into preallocated typed arrays and is skipped entirely while nothing is in flight.  Trees near a burst are
// found through an 8 m bucket grid built once.
//
// Gameplay: a thinned crown needs more leaves to hide a man (its foliage occluder's see-through depth grows), a
// stripped / felled one no longer hides anyone (occluder dead), tree-line belts lose depth with the share of their
// trees stripped, the concealment grid (rural maps) lightens under a stripped crown, and a snapped trunk only stops
// rounds up to the stump.  All of it is a deterministic function of the bursts (position rounded to 1 cm, power), so a
// versus joiner replaying the host's explosion events gets the same state; visuals use Math.random freely.
import * as THREE from 'three';
import { PLACED } from './instancer.js';
import { TRUNKS } from './vegetation.js';
import { MAP_SIZE } from './city.js';

const TREE = /^(tree_|leafy_summer_|bush_)/, NOT_TREE = /fallen|stump|_lod\d*$|_mid$|row$/;
const LEAF_CAP = 900, WOOD_CAP = 200, TOP_CAP = 40, STUMP_CAP = 400, GC = 8, BR3_CAP = 16, BRC_CAP = 70, BRV = 4;   // (branches: per variant, 3D in flight / flat cards at rest)
const BIG_TRUNK = 0.4, WHEEL_TRUNK = 0.12, LIGHT_TRUNK = 0.04;   // (WHEEL_TRUNK: a heavy 8x8 pushes over saplings up to this; a light truck / pickup only brush (LIGHT_TRUNK); bigger trees: wheeled vehicles drive round)   // trunk-shape radius (vegetation.js trunkShape, bark + lower limbs: ~1.6-2x the bole) of a tree a tank cannot push over; ~10-30 % of the trees per map
const isLeafMat = m => !!m && (m.alphaTest > 0 || m.transparent || /leaf|leaves|foliage/i.test(m.name || ''));
const leafOf = im => (Array.isArray(im.material) ? im.material.some(isLeafMat) : isLeafMat(im.material));
const key2 = (x, z) => (Math.round(x * 20) + 60000) * 200000 + Math.round(z * 20) + 60000;
const hash = (a, b) => { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

// average colour of a material's albedo (opaque texels only for cut-out cards) x material colour: the leaves thrown
// off match the map's foliage (late-summer green, dried olive, autumn brown...) without a season table
function albedo(m, cutout, fallback) {
  const c = new THREE.Color(fallback);
  try {
    const img = m?.map?.image; if (!img || !(img.width > 0)) return m?.color ? c.multiply(m.color) : c;
    const cv = document.createElement('canvas'); cv.width = cv.height = 24; const x = cv.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, 24, 24); const d = x.getImageData(0, 0, 24, 24).data; let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { if (cutout && d[i + 3] < 128) continue; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    if (n > 8) c.setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
    if (m.color) c.multiply(m.color);
  } catch { /* tainted / compressed texture: keep the fallback */ }
  return c;
}
function leafTexture() {
  const S = 64, cv = document.createElement('canvas'); cv.width = cv.height = S; const x = cv.getContext('2d');
  x.fillStyle = '#fff'; x.beginPath(); x.moveTo(S * 0.5, S * 0.04);
  x.bezierCurveTo(S * 0.95, S * 0.3, S * 0.86, S * 0.72, S * 0.5, S * 0.9); x.bezierCurveTo(S * 0.14, S * 0.72, S * 0.05, S * 0.3, S * 0.5, S * 0.04); x.fill();
  x.fillRect(S * 0.48, S * 0.86, S * 0.04, S * 0.12);   // stalk
  x.strokeStyle = 'rgba(150,150,150,1)'; x.lineWidth = 2; x.beginPath(); x.moveTo(S * 0.5, S * 0.1); x.lineTo(S * 0.5, S * 0.88); x.stroke();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// template facts (template-local space = the space PLACED matrices map from)
function tplInfo(tpl) {
  tpl.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(tpl.matrixWorld).invert(), rel = new THREE.Matrix4(), leaf = new THREE.Box3(), all = new THREE.Box3(), b = new THREE.Box3();
  let leafMat = null, barkMat = null;
  tpl.traverse(o => {
    if (!o.isMesh || o.isSkinnedMesh) return; if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    rel.multiplyMatrices(inv, o.matrixWorld); b.copy(o.geometry.boundingBox).applyMatrix4(rel); all.union(b);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some(isLeafMat)) { leaf.union(b); leafMat ||= mats.find(isLeafMat); } else barkMat ||= mats[0];
  });
  const crown = leaf.isEmpty() ? all : leaf, c = crown.getCenter(new THREE.Vector3()), sz = crown.getSize(new THREE.Vector3());
  return { leafy: !!leafMat, bush: /^bush_/.test(tpl.name || ''), down: /_snapped$|_broken$/.test(tpl.name || ''), c, r: Math.max(0.6, Math.max(sz.x, sz.z) * 0.5), ry: Math.max(0.6, sz.y * 0.5), h: Math.max(1, all.max.y),
    leafCol: leafMat ? albedo(leafMat, true, 0x56602f) : null, barkCol: albedo(barkMat, false, 0x4d4339) };
}

// ---- branches blown off a crown: one procedural skeleton per variant (main limb along +x 0..1, side twigs, leaf clusters
// on the leafy variants), built twice from the same 2D layout -- a thin 3D mesh (in flight: it tumbles) and a flat
// alpha-cut card drawn from the same strokes / colours (at rest on the ground, or far from the camera): the swap happens
// when the piece lies flat, so the silhouette and colour do not change.
function branchSkel(seed, leafy) {
  let a = seed; const r = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const segs = [], leaves = [], bend = (r() - 0.5) * 0.25;
  let px = 0, pz = 0, ang = (r() - 0.5) * 0.2;
  for (let i = 0; i < 4; i++) { const L = 0.25, nx = px + Math.cos(ang) * L, nz = pz + Math.sin(ang) * L, r0 = 0.03 * (1 - i * 0.2), r1 = 0.03 * (1 - (i + 1) * 0.2); segs.push([px, pz, nx, nz, r0, Math.max(0.006, r1)]); px = nx; pz = nz; ang += bend; }
  const tw = 3 + (r() * 3 | 0);
  for (let k = 0; k < tw; k++) {
    const t = 0.25 + r() * 0.6, sd = k % 2 ? 1 : -1, bx = t, bz = Math.sin(t * 3) * 0.02 + bend * t, ta = sd * (0.5 + r() * 0.5), L = 0.15 + r() * 0.22, ex = bx + Math.cos(ta) * L, ez = bz + Math.sin(ta) * L;
    segs.push([bx, bz, ex, ez, 0.012, 0.005]);
    if (leafy) for (let q = 0; q < 3; q++) { const u = 0.45 + q * 0.27; leaves.push([bx + (ex - bx) * u + (r() - 0.5) * 0.05, bz + (ez - bz) * u + (r() - 0.5) * 0.05, 0.05 + r() * 0.04]); }
  }
  if (leafy) for (let q = 0; q < 4; q++) leaves.push([px - q * 0.06 + (r() - 0.5) * 0.04, pz + (r() - 0.5) * 0.08, 0.05 + r() * 0.04]);
  return { segs, leaves };
}
const BR_BARK = new THREE.Color(0.30, 0.25, 0.20), BR_LEAF = new THREE.Color(0.30, 0.36, 0.17), BR_Z = 0.35;   // (card covers z -0.35..0.35)
function branchGeo(S) {
  const pos = [], col = [], push = (g, c) => { const p = g.attributes.position; for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); col.push(c.r, c.g, c.b); } };
  for (const [x0, z0, x1, z1, r0, r1] of S.segs) {
    const L = Math.hypot(x1 - x0, z1 - z0), g = new THREE.CylinderGeometry(r1, r0, L, 4, 1).toNonIndexed(); g.rotateZ(-Math.PI / 2); g.rotateY(-Math.atan2(z1 - z0, x1 - x0)); g.translate((x0 + x1) / 2, r0, (z0 + z1) / 2); push(g, BR_BARK);
  }
  for (const [x, z, s] of S.leaves) { const g = new THREE.PlaneGeometry(s * 2, s * 1.4).toNonIndexed(); g.rotateX(-Math.PI / 2); g.rotateY(Math.random() * 6.28); g.translate(x, 0.025, z); push(g, BR_LEAF); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals(); return g;
}
function branchCard(S) {
  const W = 256, Hh = Math.round(256 * BR_Z * 2), cv = document.createElement('canvas'); cv.width = W; cv.height = Hh; const x = cv.getContext('2d');
  const P = (u, v) => [u * W, (v + BR_Z) / (2 * BR_Z) * Hh], css = c => `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
  x.lineCap = 'round'; x.strokeStyle = css(BR_BARK.clone().convertLinearToSRGB());
  for (const [x0, z0, x1, z1, r0, r1] of S.segs) { x.lineWidth = Math.max(1.5, (r0 + r1) * W); x.beginPath(); x.moveTo(...P(x0, z0)); x.lineTo(...P(x1, z1)); x.stroke(); }
  x.fillStyle = css(BR_LEAF.clone().convertLinearToSRGB());
  for (const [u, v, s] of S.leaves) { const [px, py] = P(u, v); x.beginPath(); x.ellipse(px, py, s * W, s * 0.7 * W, 0.6, 0, 6.283); x.fill(); }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
export function setupTreeDamage(g) {
  const T = new TreeDamage(g);
  if (g.fx) { g.fx.onBlast = (pos, p) => T.blast(pos.x, pos.y, pos.z, p); g.fx.onUpdate = dt => T.update(dt); }
  return T;
}

export class TreeDamage {
  constructor(g) {
    this.g = g; this.scene = g.scene;
    const ids = [], infoOf = new Map();
    // ---- trees: one entry per placement, its instance slots in every LOD level
    let N = 0; const list = [];
    for (const P of PLACED) {
      const n = P.template?.name || ''; if (!TREE.test(n) || NOT_TREE.test(n) || !P.parts) continue;
      let I = infoOf.get(P.template); if (!I) { I = tplInfo(P.template); I.tpl = P.template; I.mid = P.opts?.mid || null; infoOf.set(P.template, I); }
      list.push({ P, I, base: N }); N += P.matrices.length;
    }
    this.N = N; this.list = list;
    this.tP = new Array(N); this.tI = new Array(N); this.tInfo = new Array(N);
    this.x = new Float32Array(N); this.y = new Float32Array(N); this.z = new Float32Array(N); this.s = new Float32Array(N);
    this.f = new Float32Array(N).fill(1); this.D = new Float32Array(N); this.st = new Uint8Array(N);
    const cnt = new Int32Array(N + 1), sc = new THREE.Vector3(), q = new THREE.Quaternion(), v = new THREE.Vector3();
    for (const L of list) {
      L.P.matrices.forEach((M, i) => { const t = L.base + i; M.decompose(v, q, sc); this.tP[t] = L.P; this.tI[t] = i; this.tInfo[t] = L.I; this.x[t] = v.x; this.y[t] = v.y; this.z[t] = v.z; this.s[t] = (sc.x + sc.y + sc.z) / 3; if (!L.I.leafy) this.f[t] = 0; });
      for (const [meshes, idx] of L.P.parts) for (let j = 0; j < idx.length; j++) cnt[L.base + idx[j] + 1] += meshes.length;
    }
    for (let t = 0; t < N; t++) cnt[t + 1] += cnt[t];
    this.slotStart = cnt; const S = cnt[N]; this.slotIm = new Array(S); this.slotJ = new Int32Array(S); this.slotLeaf = new Uint8Array(S);
    const fill = cnt.slice(0, N);
    for (const L of list) for (const [meshes, idx] of L.P.parts) for (let j = 0; j < idx.length; j++) for (const im of meshes) { const k = fill[L.base + idx[j]]++; this.slotIm[k] = im; this.slotJ[k] = j; this.slotLeaf[k] = leafOf(im) ? 1 : 0; }
    this.orig = new Map();
    // ---- bucket grid
    this.grid = new Map();
    for (let t = 0; t < N; t++) { const k = Math.floor(this.x[t] / GC) * 4096 + Math.floor(this.z[t] / GC); let l = this.grid.get(k); if (!l) this.grid.set(k, l = []); l.push(t); }
    // ---- gameplay links: own foliage occluder (vegetation.js), tree-line belts it stands in, trunk record
    const nav = g.nav || g.city?.nav, veg = new Map(); this.nav = nav;
    if (nav?.occGrid) for (const l of nav.occGrid.values()) for (const o of l) if (o.veg) veg.set(key2(o.cx, o.cz), o);
    const trunks = new Map(); for (const l of TRUNKS.grid.values()) for (const tr of l) trunks.set(key2(tr.x, tr.z), tr);
    this.occ = new Array(N).fill(null); this.belts = new Array(N).fill(null); this.trunk = new Array(N).fill(null);
    for (let t = 0; t < N; t++) {
      const k = key2(this.x[t], this.z[t]); this.occ[t] = veg.get(k) || null; this.trunk[t] = trunks.get(k) || null;
      if (this.occ[t]) this.occ[t]._d0 = this.occ[t].depth;
      if (!nav?.occGrid || !this.tInfo[t].leafy) continue;
      const l = nav.occGrid.get(Math.floor(this.x[t] / nav.occCell) * 4096 + Math.floor(this.z[t] / nav.occCell)); if (!l) continue;
      for (const o of l) {
        if (!o.foliage || o.veg) continue; const dx = this.x[t] - o.cx, dz = this.z[t] - o.cz, lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos;
        if (Math.abs(lx) < o.hx && Math.abs(lz) < o.hz) { (this.belts[t] ||= []).push(o); o._n = (o._n || 0) + 1; o._lost ||= 0; o._d0 ??= o.depth || 9; }
      }
    }
    this.buildPools();
    this.stats = { blasts: 0, stripped: 0, snapped: 0, crushed: 0 };
    this.vehicleTrees();
    if (typeof window !== 'undefined') window.__trees = this;
  }
  // ------------------------------------------------------------------------------------------------ vehicles vs trees
  // A tank pushes over most trees; a big trunk (radius >= BIG_TRUNK) it cannot: those cells become no-go for every
  // vehicle (nav.veh = 2), so routes go round them. Anything smaller is knocked down by a vehicle driving into it
  // (crush, from vehicle.update): the tree falls the way the hull is moving and leaves a stump.
  vehicleTrees() {
    const nav = this.nav; this.tr = new Float32Array(this.N); if (!nav || !this.N) return;
    let big = 0;
    for (let t = 0; t < this.N; t++) {
      const r = this.trunk[t] ? this.trunk[t].r : 0.18 * this.s[t]; this.tr[t] = r;
      if (r >= BIG_TRUNK) { nav.setVeh(this.x[t], this.z[t], r + 0.35, r + 0.35, 0, 2); big++; }
      else if (r >= WHEEL_TRUNK) { nav.setVeh(this.x[t], this.z[t], r + 0.3, r + 0.3, 0, 1); big++; }   // wheeled vehicles can't push it over: round it
    }
    this.stats.bigTrunks = big;
    // deep woods: single trunks leave hull-wide gaps on the grid, but a wood is a maze of trunks, stumps, brush and
    // fallen timber a vehicle wedges itself in. Standing trees counted per 8 m cell over a 24 m window: an open grove /
    // tree row stays drivable, a wood is closed to wheeled vehicles (layer 1: tracked cross only at a heavy cost), its
    // interior to every vehicle (layer 2) -- routes go round the woods instead of into them. Roads through keep open.
    { const C = 8, cnt = new Map(), key = (i, j) => i + ',' + j; nav.veh ||= new Uint8Array(nav.n * nav.n);
      for (let t = 0; t < this.N; t++) if (this.tr[t] >= WHEEL_TRUNK * 0.75) { const k = key(Math.floor(this.x[t] / C), Math.floor(this.z[t] / C)); cnt.set(k, (cnt.get(k) || 0) + 1); }
      let wood = 0;
      for (const k of cnt.keys()) {
        const [i, j] = k.split(',').map(Number); let n = 0;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) n += cnt.get(key(i + a, j + b)) || 0;
        const val = n >= 17 ? 2 : n >= 10 ? 1 : 0; if (!val) continue; wood++;
        for (let z = j * C + nav.cell / 2; z < (j + 1) * C; z += nav.cell) for (let x = i * C + nav.cell / 2; x < (i + 1) * C; x += nav.cell) {
          const q = nav.idx(x, z); if (q < 0 || nav.road?.[q]) continue; nav.veh[q] = Math.max(nav.veh[q], val);
        }
      }
      this.stats.woodCells = wood; if (wood) big++;
    }
    if (big) { nav.vehDirty = true; nav.finalize(); }
  }
  // A hull stopped by a trunk it can push over (same limits as crush): the tree goes down at once and its trunk's cells open
  // in the nav grid (a stump is rough going, not a wall) - tracked armour hung up in front of every sapling its route or its
  // nose came within a cell of. Returns true when something was felled at / next to x, z.
  pushOver(v, x, z) {
    if (!this.N || !v.def) return false;
    const light = v.kind === 'medevac' || (v.def.mass ?? 99) < 5 || /pickup/i.test(v.def.asset || ''), lim = light ? LIGHT_TRUNK : v.def.wheeled || v.kind === 'btr' ? WHEEL_TRUNK : BIG_TRUNK;
    const nav = this.nav, s = Math.sin(v.heading), c = Math.cos(v.heading), dir = (v.speed || 0) >= 0 ? 1 : -1, gx = Math.floor(x / GC), gz = Math.floor(z / GC); let hit = false;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const t of this.grid.get((gx + i) * 4096 + gz + j) || []) {
      if (this.tr[t] >= lim || Math.hypot(this.x[t] - x, this.z[t] - z) > 1.5) continue;
      if (this.st[t] !== 2) { this.snap(t, this.x[t] - s * dir, this.z[t] - c * dir, 0.5, 5); this.stats.crushed++; if (this.g.camDist?.(v.pos) < 160) this.g.sfx?.('debris', v.pos); }
      if (nav) { for (let pz = this.z[t] - 0.5; pz <= this.z[t] + 0.5; pz += nav.cell) for (let px = this.x[t] - 0.5; px <= this.x[t] + 0.5; px += nav.cell) { const q = nav.idx(px, pz); if (q >= 0 && nav.cost[q] === 255) { nav.cost[q] = 3; hit = true; } } }
    }
    if (hit && nav) nav.refreshArea(x - 2, z - 2, x + 2, z + 2, 6);
    return hit;
  }
  crush(v) {
    if (!this.N || !v.def) return;
    // what this hull can push over: tracked armour anything below BIG_TRUNK, a heavy 8x8 (BTR, Bohdana) saplings, a pickup
    // nothing that is a tree (only brush) -- a 2 t truck stops dead against a trunk, it doesn't fell it
    const light = v.kind === 'medevac' || (v.def.mass ?? 99) < 5 || /pickup/i.test(v.def.asset || ''), lim = light ? LIGHT_TRUNK : v.def.wheeled || v.kind === 'btr' ? WHEEL_TRUNK : BIG_TRUNK;
    const L = v.def.length * 0.5, W = v.def.width * 0.5, c = Math.cos(v.heading), s = Math.sin(v.heading), dir = (v.speed || 0) >= 0 ? 1 : -1;
    const gx = Math.floor(v.pos.x / GC), gz = Math.floor(v.pos.z / GC);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const l = this.grid.get((gx + i) * 4096 + gz + j); if (!l) continue;
      for (const t of l) {
        if (this.st[t] === 2 || this.tr[t] >= lim) continue;
        const dx = this.x[t] - v.pos.x, dz = this.z[t] - v.pos.z, r = this.tr[t];
        if (Math.abs(dx * c - dz * s) > W + r || Math.abs(dx * s + dz * c) > L + r) continue;
        this.snap(t, this.x[t] - s * dir, this.z[t] - c * dir, 0.5, 5); this.stats.crushed++;
        if (this.g.camDist?.(v.pos) < 160) this.g.sfx?.('debris', v.pos);
      }
    }
  }
  // ------------------------------------------------------------------------------------------------ pools
  buildPools() {
    const sc = this.scene;
    // leaves: alpha-cut double-sided quads, tinted per instance with the crown's colour
    const lg = new THREE.PlaneGeometry(1, 1);
    this.leafMesh = new THREE.InstancedMesh(lg, new THREE.MeshLambertMaterial({ map: leafTexture(), alphaTest: 0.45, side: THREE.DoubleSide }), LEAF_CAP);
    this.wood = null;
    const wg = new THREE.CylinderGeometry(0.5, 0.32, 1, 5, 1); wg.rotateZ(Math.PI / 2);   // along x, unit length / thickness
    this.woodMesh = new THREE.InstancedMesh(wg, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), WOOD_CAP);
    this.woodMesh.castShadow = true;
    const z = new THREE.Matrix4().makeScale(0, 0, 0), white = new THREE.Color(1, 1, 1);
    for (const [m, cap] of [[this.leafMesh, LEAF_CAP], [this.woodMesh, WOOD_CAP]]) {
      for (let i = 0; i < cap; i++) { m.setMatrixAt(i, z); m.setColorAt(i, white); }
      m.count = 0; m.frustumCulled = false; m.visible = false; m.receiveShadow = true; m.name = m === this.leafMesh ? 'td_leaves' : 'td_wood'; sc.add(m);
    }
    const mk = (n) => ({ cap: n, px: new Float32Array(n), py: new Float32Array(n), pz: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n), vz: new Float32Array(n),
      a: new Float32Array(n), b: new Float32Array(n), wa: new Float32Array(n), wb: new Float32Array(n), sx: new Float32Array(n), sy: new Float32Array(n), t: new Float32Array(n), life: new Float32Array(n), fl: new Float32Array(n), mode: new Uint8Array(n), head: 0, hw: 0, alive: 0 });
    this.L = mk(LEAF_CAP); this.W = mk(WOOD_CAP);
    // branches: per variant a 3D pool (in flight) and a card pool (lying flat / far); 0-1 bare, 2-3 leafy
    this.BR = [];
    for (let v = 0; v < BRV; v++) {
      const S = branchSkel(911 + v * 37, v >= 2), m3 = new THREE.InstancedMesh(branchGeo(S), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide, flatShading: true }), BR3_CAP);
      const cg = new THREE.PlaneGeometry(1, BR_Z * 2); cg.rotateX(-Math.PI / 2); cg.translate(0.5, 0.012, 0);
      const mc = new THREE.InstancedMesh(cg, new THREE.MeshStandardMaterial({ map: branchCard(S), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.95 }), BRC_CAP);
      for (const [m, cap] of [[m3, BR3_CAP], [mc, BRC_CAP]]) { for (let i = 0; i < cap; i++) { m.setMatrixAt(i, z); m.setColorAt(i, white); } m.count = 0; m.frustumCulled = false; m.visible = false; m.receiveShadow = true; m.name = 'td_branch'; sc.add(m); }
      m3.castShadow = true;
      this.BR.push({ m3, mc, P: mk(BR3_CAP), C: { head: 0, n: 0 } });
    }
    // stumps (trees.glb), fallen tops: lazily per template
    const G = this.g.assets?.gltf?.trees?.scene;
    this.stumpT = ['stump_1', 'stump_2'].map(n => G?.getObjectByName(n)).filter(Boolean).map(t => this.dynPool(t, STUMP_CAP, true));
    for (const p of this.stumpT) { const pa = []; let top = 0; p.tpl.traverse(o => { if (!o.isMesh) return; const a = o.geometry.attributes.position; for (let i = 0; i < a.count; i++) { const y = a.getY(i); top = Math.max(top, y); if (y > 0.1 && y < 0.4) pa.push([a.getX(i), a.getZ(i)]); } });
      let cx = 0, cz = 0; for (const [x, z2] of pa) { cx += x; cz += z2; } cx /= pa.length || 1; cz /= pa.length || 1; const rs = pa.map(([x, z2]) => Math.hypot(x - cx, z2 - cz)).sort((a, b) => a - b);
      p.r = Math.max(0.1, rs[Math.floor(rs.length * 0.5)] || 0.3); p.h = top || 0.8; p.cx = cx; p.cz = cz; }
    this.tops = new Map();
    this._m = new THREE.Matrix4(); this._m2 = new THREE.Matrix4(); this._m3 = new THREE.Matrix4(); this._inv = new THREE.Matrix4(); this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._s = new THREE.Vector3(); this._c = new THREE.Color();
  }
  // InstancedMeshes for every (non-leaf) sub-mesh of a template, fixed capacity, slots used round-robin
  dynPool(tpl, cap, stat) {
    tpl.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(tpl.matrixWorld).invert(), parts = [];
    tpl.traverse(o => {
      if (!o.isMesh || o.isSkinnedMesh) return; const mats = Array.isArray(o.material) ? o.material : [o.material]; if (mats.some(isLeafMat)) return;
      // double-sided: open branch-tube ends and the snapped butt are seen from inside once the tree lies on its side
      const ds = m => (this._dsMat ||= new Map()).get(m) || this._dsMat.set(m, Object.assign(m.clone(), { side: THREE.DoubleSide })).get(m);
      const mat = Array.isArray(o.material) ? o.material.map(ds) : ds(o.material);
      const im = new THREE.InstancedMesh(o.geometry, mat, cap); im.count = 0; im.visible = false; im.frustumCulled = false; im.castShadow = im.receiveShadow = true; im.name = 'td_' + (tpl.name || 'tree');
      this.scene.add(im); parts.push({ im, rel: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld) });
    });
    return { tpl, parts, cap, head: 0, n: 0, items: stat ? null : [] };
  }
  poolPut(pool, slot, W) {
    for (const p of pool.parts) { this._m3.multiplyMatrices(W, p.rel); p.im.setMatrixAt(slot, this._m3); const a = p.im.instanceMatrix; a.addUpdateRange(slot * 16, 16); a.needsUpdate = true; if (p.im.count <= slot) p.im.count = slot + 1; p.im.visible = true; }
  }
  // ------------------------------------------------------------------------------------------------ instance edits
  slotOrig(k) {
    let o = this.orig.get(k); if (o) return o;
    const im = this.slotIm[k], j = this.slotJ[k]; o = im.instanceMatrix.array.slice(j * 16, j * 16 + 16); this.orig.set(k, o); return o;
  }
  writeSlot(k, e) { const im = this.slotIm[k], j = this.slotJ[k], a = im.instanceMatrix; a.array.set(e, j * 16); a.addUpdateRange(j * 16, 16); a.needsUpdate = true; }
  // crown scaled about its centre (f = remaining foliage; 0: leaf instances removed: a bare tree)
  setFoliage(t, f) {
    const I = this.tInfo[t], M = this.tP[t].matrices[this.tI[t]], s0 = this.slotStart[t], s1 = this.slotStart[t + 1];
    const D = this._m;
    // (a crown squeezed to 40 % read as a dark ball of leaves: now it thins only a little, and goes bare below ~45 %)
    if (f < 0.45) f = 0;
    if (f > 0) { const k = 0.82 + 0.18 * f; this._inv.copy(M).invert(); D.copy(M).multiply(this._m2.makeTranslation(I.c.x, I.c.y, I.c.z)).multiply(this._m3.makeScale(k, k, k)).multiply(this._m2.makeTranslation(-I.c.x, -I.c.y, -I.c.z)).multiply(this._inv); }
    for (let k = s0; k < s1; k++) {
      if (!this.slotLeaf[k]) continue;
      const o = this.slotOrig(k);
      if (f <= 0) this.writeSlot(k, ZERO); else { this._m2.fromArray(o).premultiply(D); this.writeSlot(k, this._m2.elements); }
    }
  }
  hideTree(t) { for (let k = this.slotStart[t]; k < this.slotStart[t + 1]; k++) { this.slotOrig(k); this.writeSlot(k, ZERO); } }
  // ------------------------------------------------------------------------------------------------ gameplay
  cover(t, f0, f1) {
    if (f1 >= f0) return;
    const o = this.occ[t];
    if (o) { if (f1 <= 0) o.dead = true; else if (o._d0) o.depth = o._d0 / Math.max(0.25, f1); }
    const B = this.belts[t];
    if (B) for (const b of B) { b._lost += f0 - f1; const fr = Math.min(1, b._lost / b._n); b.depth = b._d0 * (1 + 3 * fr * fr); if (fr > 0.85) b.dead = true; }
    const C = this.g.city; if (f1 <= 0 && C?.conceal && C.CS && C.CN) {
      const r = this.tInfo[t].r * this.s[t] * 0.7, h = MAP_SIZE / 2, x = this.x[t], z = this.z[t];
      for (let j = Math.max(0, Math.floor((z - r + h) / C.CS)); j <= Math.min(C.CN - 1, Math.floor((z + r + h) / C.CS)); j++)
        for (let i = Math.max(0, Math.floor((x - r + h) / C.CS)); i <= Math.min(C.CN - 1, Math.floor((x + r + h) / C.CS)); i++) { const k = j * C.CN + i; if (C.conceal[k] < 170) C.conceal[k] = 170; }
    }
  }
  // ------------------------------------------------------------------------------------------------ bursts
  blast(bx, by, bz, power) {
    if (!(power >= 0.3) || !this.N) return;
    bx = Math.round(bx * 100) / 100; bz = Math.round(bz * 100) / 100; by = Math.round(by * 100) / 100;
    const R = 9 * Math.sqrt(power), RL = R * 1.4, reach = RL + 6;
    const cam = this.g.renderer?.camera?.position, cd = cam ? Math.hypot(cam.x - bx, cam.z - bz) : 0;
    const vis = cd < 420 ? (cd < 220 ? 1 : 0.45) : 0;   // particle budget by camera distance (state changes always)
    let leafBudget = Math.round(420 * vis), woodBudget = Math.round(70 * vis);
    this.stats.blasts++;
    for (let gx = Math.floor((bx - reach) / GC); gx <= Math.floor((bx + reach) / GC); gx++) for (let gz = Math.floor((bz - reach) / GC); gz <= Math.floor((bz + reach) / GC); gz++) {
      const l = this.grid.get(gx * 4096 + gz); if (!l) continue;
      for (const t of l) {
        if (this.st[t] === 2) continue;
        const I = this.tInfo[t], s = this.s[t], dh = Math.hypot(this.x[t] - bx, this.z[t] - bz);
        const up = by - this.y[t]; if (up > I.h * s + 4) continue;   // burst high above (a roof): leave it
        const dL = Math.max(0, dh - I.r * s * 0.6), qL = dL < RL ? power * Math.pow(1 - dL / RL, 1.2) : 0;
        const q = dh < R ? power * Math.pow(1 - dh / R, 1.5) : 0;
        if (!qL && !q) continue;
        // leaves
        const f0 = this.f[t];
        if (f0 > 0 && qL > 0) {
          let f1 = f0 - qL * (I.bush ? 0.7 : 0.9); if (f1 < 0.25) f1 = 0;
          if (f0 - f1 > 0.015) {
            this.f[t] = f1; this.setFoliage(t, f1); this.cover(t, f0, f1); if (f1 === 0) this.stats.stripped++;
            if (leafBudget > 0) { const n = Math.min(leafBudget, Math.round((f0 - f1) * (I.bush ? 18 : 48) * Math.min(2, I.r * s / 2.5) * (0.6 + vis * 0.4))); leafBudget -= n; this.leaves(t, n, bx, by, bz, qL); }
          }
        }
        if (I.bush) continue;
        // trunk
        if (q > 0) {
          this.D[t] += q;
          const thr = 0.8 * Math.min(1.5, Math.max(0.7, s));
          // (streets v2: an already snapped tree -- its top lying in the template -- is not snapped again: the whole
          // template would fall over and its lying top end up standing / floating in the air; splinters only)
          if (!I.down && (q >= thr || this.D[t] >= 2.6 * thr / 0.8)) { const w = woodBudget > 0 ? Math.min(woodBudget, 18) : 0; woodBudget -= w; this.snap(t, bx, bz, q, w); }
          else if (q > 0.22 && woodBudget > 0) { const w = Math.min(woodBudget, Math.round(2 + q * 6)); woodBudget -= w; this.splinters(t, w, bx, by, bz, q, false); }
        }
      }
    }
  }
  snap(t, bx, bz, q, nWood) {
    const I = this.tInfo[t], s = this.s[t], f0 = this.f[t];
    this.st[t] = 2; this.stats.snapped++;
    if (f0 > 0) { this.f[t] = 0; this.cover(t, f0, 0); if (nWood) this.leaves(t, Math.round(f0 * 30), bx, this.y[t], bz, q); }
    else if (this.occ[t]) this.occ[t].dead = true;
    this.hideTree(t);
    let dx = this.x[t] - bx, dz = this.z[t] - bz, d = Math.hypot(dx, dz);
    if (d < 0.05) { const a = hash(t, 7) * 6.283; dx = Math.cos(a); dz = Math.sin(a); } else { dx /= d; dz /= d; }
    // stump
    let hs = 0.9 * s;
    const tr = this.trunk[t], rTree = tr ? tr.r : 0.25 * s;
    if (this.stumpT.length) {
      const P = this.stumpT[/birch|poplar/.test(I.tpl.name) ? 0 : this.stumpT.length - 1], k = Math.min(1.6, Math.max(0.3, rTree / P.r * 1.15));
      hs = P.h * k * 0.85;
      this._q.setFromAxisAngle(this._v.set(0, 1, 0), hash(t, 3) * 6.283); this._m.compose(this._v2.set(this.x[t], this.y[t], this.z[t]), this._q, this._s.set(k, k, k));
      const slot = P.head; P.head = (P.head + 1) % P.cap; this.poolPut(P, slot, this._m);
    }
    if (tr) tr.y1 = Math.min(tr.y1, tr.y0 + 0.3 + hs);
    // falling top
    let top = this.tops.get(I.tpl);
    if (!top) { top = this.dynPool(I.tpl, TOP_CAP, false); this.tops.set(I.tpl, top); }   // (full bark mesh: the simplified one had holes - tops looked see-through)
    const slot = top.head; top.head = (top.head + 1) % top.cap;
    const it = top.items[slot] || (top.items[slot] = { M: new THREE.Matrix4() });
    it.t = t; it.th = 0; it.w = 0.25 + Math.min(1.2, q) * 0.5; it.dx = dx; it.dz = dz; it.hs = hs; it.L = Math.max(2, I.h * s); it.rest = false; it.slot = slot; it.age = 0;
    // lands on the ground along its length: the fall stops where the trunk first meets the terrain on its way down (a
    // slope falling away: past horizontal; a bank, a heap: earlier), not at a fixed angle that floats it over a dip
    { const ter = this.g.city?.terrain, gh = this.g.city?.groundHeight; let th = Math.PI / 2;
      if (ter || gh) { th = 2.2; for (const f of [0.3, 0.5, 0.7, 0.9]) { const d = it.L * f, px = this.x[t] + dx * (0.7 + d), pz = this.z[t] + dz * (0.7 + d), g = gh ? gh(px, pz) : ter.heightAt(px, pz); th = Math.min(th, Math.atan2(d, g - this.y[t])); } }
      it.thf = Math.max(1.0, Math.min(2.0, th + (hash(t, 11) - 0.5) * 0.04)); }
    it.M.copy(this.tP[t].matrices[this.tI[t]]);
    this.topPose(top, it);
    (this.falling ||= []).includes(top) || this.falling.push(top);
    if (nWood) this.splinters(t, nWood, bx, this.y[t] + 0.5, bz, Math.max(q, 0.8), true);
    // dust from the crown hitting the ground comes with the burst's own dust; a light extra puff where it lands
    if (nWood && this.g.fx) this.g.fx.dustCloud(this._v.set(this.x[t] + dx * it.L * 0.6, this.y[t] + 0.5, this.z[t] + dz * it.L * 0.6), it.L * 0.5, 1.5, 6, [0.5, 0.46, 0.38]);
  }
  topPose(top, it) {
    const t = it.t, x = this.x[t], y = this.y[t], z = this.z[t];
    // pivot: on the stump top, sliding down to the ground and forward as the tree lands
    const k = Math.min(1, Math.max(0, (it.th - 0.8) / (it.thf - 0.8)));
    const px = x + it.dx * k * 0.7, py = y + it.hs * (1 - k) + 0.25 * k, pz = z + it.dz * k * 0.7;
    const lift = Math.min(1, it.th / 0.5);   // the tree's foot moves up onto the pivot over the first ~30 deg
    this._q.setFromAxisAngle(this._v.set(it.dz, 0, -it.dx), it.th);
    this._m.makeRotationFromQuaternion(this._q); this._m.setPosition(px, py, pz);
    this._m2.makeTranslation(-x, -y - it.hs * (1 - lift), -z); this._m.multiply(this._m2).multiply(it.M);
    this.poolPut(top, it.slot, this._m);
  }
  // ------------------------------------------------------------------------------------------------ particles
  spawn(B) { const i = B.head; B.head = (B.head + 1) % B.cap; if (B.mode[i] === 0) B.alive++; if (i >= B.hw) B.hw = i + 1; return i; }
  leaves(t, n, bx, by, bz, q) {
    if (n <= 0) return;
    const I = this.tInfo[t], s = this.s[t], M = this.tP[t].matrices[this.tI[t]], B = this.L, R = Math.random, col = I.leafCol || this._c.setHex(0x56602f), c = this._c2 ||= new THREE.Color();
    const cw = this._v.copy(I.c).applyMatrix4(M), cr = I.r * s * 0.8, cy = I.ry * s * 0.8, floor = this.y[t];
    const sp = 3 + Math.min(2.2, q) * 7;
    for (let k = 0; k < n; k++) {
      const i = this.spawn(B), a = R() * 6.283, rr = Math.sqrt(R()) * cr;
      const x = cw.x + Math.cos(a) * rr, y = cw.y + (R() - 0.5) * 2 * cy, z = cw.z + Math.sin(a) * rr;
      let dx = x - bx, dy = y - by, dz = z - bz; const d = Math.hypot(dx, dy, dz) || 1; dx /= d; dy /= d; dz /= d;
      const v = sp * (0.4 + R() * 0.8);
      // blasted up and out of the crown (a column of leaves over the burst), then fluttering down for half a minute
      B.px[i] = x; B.py[i] = y; B.pz[i] = z; B.vx[i] = dx * v + (R() - .5) * 3; B.vy[i] = Math.max(0.35, dy + 0.5) * v + 3 + R() * 6; B.vz[i] = dz * v + (R() - .5) * 3;
      B.a[i] = R() * 6.28; B.b[i] = R() * 6.28; B.wa[i] = (R() - .5) * 14; B.wb[i] = (R() - .5) * 10; const sz = (I.bush ? 0.14 : 0.2) + R() * 0.14; B.sx[i] = sz * 0.75; B.sy[i] = sz;   // (leaf + leafy twig clusters: readable at RTS distances)
      B.t[i] = 0; B.life[i] = 20 + R() * 15; B.fl[i] = floor + 0.02; B.mode[i] = 1;
      const v2 = 0.7 + R() * 0.5; c.copy(col).multiplyScalar(v2); if (R() < 0.18) c.lerp(this._c.setRGB(0.42, 0.33, 0.16), 0.6); this.leafMesh.setColorAt(i, c);
    }
    this.leafMesh.instanceColor.needsUpdate = true; this.leafMesh.visible = true;
  }
  splinters(t, n, bx, by, bz, q, big) {
    if (n <= 0) return;
    const I = this.tInfo[t], s = this.s[t], B = this.W, R = Math.random, c = this._c2 ||= new THREE.Color(), H = Math.max(2, I.h * s);
    for (let k = 0; k < n; k++) {
      if (R() < (big ? 0.35 : 0.2)) { this.branch(t, bx, bz, q); continue; }
      const i = this.spawn(B), branch = false, y = this.y[t] + (branch ? H * (0.45 + R() * 0.45) : 0.3 + R() * Math.min(3, H * 0.4));
      const a = R() * 6.283, x = this.x[t] + Math.cos(a) * 0.2, z = this.z[t] + Math.sin(a) * 0.2;
      let dx = x - bx, dz = z - bz; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
      const v = (branch ? 3 : 7) + R() * (branch ? 6 : 13) * Math.min(1.6, q + 0.4);
      B.px[i] = x; B.py[i] = y; B.pz[i] = z; B.vx[i] = dx * v + (R() - .5) * 4; B.vy[i] = 2 + R() * (branch ? 4 : 8); B.vz[i] = dz * v + (R() - .5) * 4;
      B.a[i] = R() * 6.28; B.b[i] = R() * 6.28; B.wa[i] = (R() - .5) * (branch ? 8 : 26); B.wb[i] = (R() - .5) * (branch ? 6 : 20);
      if (branch) { B.sx[i] = 0.6 + R() * 1.3; B.sy[i] = 0.04 + R() * 0.07; c.copy(I.barkCol).multiplyScalar(0.8 + R() * 0.4); }
      else { B.sx[i] = 0.12 + R() * 0.45; B.sy[i] = 0.02 + R() * 0.035; c.setRGB(0.62 + R() * 0.12, 0.5 + R() * 0.1, 0.33 + R() * 0.08, THREE.SRGBColorSpace); if (R() < 0.3) c.copy(I.barkCol); }
      B.t[i] = 0; B.life[i] = 28 + R() * 20; B.fl[i] = 0; B.mode[i] = 1;
      this.woodMesh.setColorAt(i, c);
    }
    this.woodMesh.instanceColor.needsUpdate = true; this.woodMesh.visible = true;
  }
  // a branch blown off the crown: thrown as a 3D piece (tumbling), set down flat, then swapped to its flat card (same
  // layout and colours) -- or a card from the start beyond ~150 m from the camera
  branch(t, bx, bz, q) {
    const I = this.tInfo[t], s = this.s[t], R = Math.random, H = Math.max(2, I.h * s), v = (I.leafy && this.f[t] > 0 ? 2 : 0) + (R() < 0.5 ? 1 : 0), B = this.BR[v];
    const a = R() * 6.283, x = this.x[t] + Math.cos(a) * I.r * s * 0.4, z = this.z[t] + Math.sin(a) * I.r * s * 0.4, y = this.y[t] + H * (0.5 + R() * 0.4), L = 0.9 + R() * 1.6;
    let dx = x - bx, dz = z - bz; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    const cam = this.g.renderer?.camera?.position, far = cam && Math.hypot(cam.x - x, cam.z - z) > 150, c = this._c2 ||= new THREE.Color(); c.setScalar(0.8 + R() * 0.4);
    if (far) { this.card(B, x, this.y[t], z, R() * 6.283, L, c); return; }   // (a few pixels at that range: straight to the ground)
    const P = B.P, i = P.head; P.head = (P.head + 1) % P.cap; if (P.mode[i]) P.alive--; if (i >= P.hw) P.hw = i + 1; P.alive++;
    const sp = 3 + R() * 5 * Math.min(1.6, q + 0.4);
    P.px[i] = x; P.py[i] = y; P.pz[i] = z; P.vx[i] = dx * sp + (R() - 0.5) * 2; P.vy[i] = 2 + R() * 4; P.vz[i] = dz * sp + (R() - 0.5) * 2;
    P.a[i] = R() * 6.28; P.b[i] = R() * 6.28; P.wa[i] = (R() - 0.5) * 6; P.wb[i] = (R() - 0.5) * 5; P.sx[i] = L; P.t[i] = 0; P.mode[i] = 1; P.fl[i] = R() * 6.283;
    B.m3.setColorAt(i, c); B.m3.instanceColor.needsUpdate = true; B.m3.visible = true;
  }
  card(B, x, y, z, yaw, L, c) {
    const C = B.C, i = C.head; C.head = (C.head + 1) % BRC_CAP; if (i >= C.n) C.n = i + 1;
    const ter = this.g.city?.terrain, gy = ter ? ter.heightAt(x, z) : y;
    this._q.setFromAxisAngle(this._v.set(0, 1, 0), yaw); this._m.compose(this._v2.set(x, gy, z), this._q, this._s.set(L, L, L));
    B.mc.setMatrixAt(i, this._m); B.mc.setColorAt(i, c); B.mc.count = C.n; B.mc.visible = true;
    const a = B.mc.instanceMatrix; a.addUpdateRange(i * 16, 16); a.needsUpdate = true; B.mc.instanceColor.needsUpdate = true;
  }
  stepBranches(dt) {
    const ter = this.g.city?.terrain, m = this._m, q = this._q, e = this._e, v = this._v, s = this._s, c = this._c3 ||= new THREE.Color();
    for (const B of this.BR) {
      const P = B.P; if (!P.alive) continue; let dirty = false;
      for (let i = 0; i < P.hw; i++) {
        const md = P.mode[i]; if (!md) continue; P.t[i] += dt;
        const gy = ter ? ter.heightAt(P.px[i], P.pz[i]) : 0;
        if (md === 1) {   // flying, tumbling
          P.vy[i] -= 9.8 * dt; P.px[i] += P.vx[i] * dt; P.py[i] += P.vy[i] * dt; P.pz[i] += P.vz[i] * dt; P.a[i] += P.wa[i] * dt; P.b[i] += P.wb[i] * dt;
          if (P.py[i] <= gy + 0.02 && P.vy[i] < 0) { P.mode[i] = 2; P.t[i] = 0; P.py[i] = gy + 0.02; P.life[i] = P.a[i]; P.wa[i] = P.b[i]; }   // (keep the landing attitude to ease out of)
        }
        let pitch = P.a[i], roll = P.b[i];
        if (P.mode[i] === 2) {   // settling: slides a little, eases flat over 0.35 s, then becomes the card
          const k = Math.min(1, P.t[i] / 0.35), f = 1 - k * k * (3 - 2 * k), slow = Math.exp(-6 * dt); P.vx[i] *= slow; P.vz[i] *= slow; P.px[i] += P.vx[i] * dt; P.pz[i] += P.vz[i] * dt; P.py[i] = gy + 0.02;
          pitch = Math.atan2(Math.sin(P.life[i]), Math.cos(P.life[i])) * f; roll = Math.atan2(Math.sin(P.wa[i]), Math.cos(P.wa[i])) * f;
          if (k >= 1) { B.m3.getColorAt(i, c); this.card(B, P.px[i], P.py[i], P.pz[i], P.fl[i], P.sx[i], c); P.mode[i] = 0; P.alive--; m.makeScale(0, 0, 0); B.m3.setMatrixAt(i, m); dirty = true; continue; }
        }
        m.compose(v.set(P.px[i], P.py[i], P.pz[i]), q.setFromEuler(e.set(pitch, P.fl[i], roll, 'YXZ')), s.set(P.sx[i], P.sx[i], P.sx[i]));
        B.m3.setMatrixAt(i, m); dirty = true;
      }
      if (dirty) { B.m3.count = P.hw; const a = B.m3.instanceMatrix; a.clearUpdateRanges(); a.addUpdateRange(0, P.hw * 16); a.needsUpdate = true; }
      if (!P.alive) { P.hw = 0; B.m3.count = 0; B.m3.visible = false; }
    }
  }
  update(dt) {
    if (!(dt > 0)) return;
    if (this.BR?.some(B => B.P.alive)) this.stepBranches(dt);
    if (this.L.alive) this.stepLeaves(dt);
    if (this.W.alive) this.stepWood(dt);
    if (this.falling?.length) this.stepTops(dt);
  }
  stepLeaves(dt) {
    const B = this.L, m = this._m, q = this._q, e = this._e, v = this._v, s = this._s, wind = this.g.fx?.wind || [0, 0], im = this.leafMesh; let dirty = false;
    const kh = Math.exp(-2.4 * dt);
    for (let i = 0; i < B.hw; i++) {
      const md = B.mode[i]; if (!md) continue;
      B.t[i] += dt; const tt = B.t[i];
      if (md === 1) {
        B.vx[i] = wind[0] * 0.8 + (B.vx[i] - wind[0] * 0.8) * kh; B.vz[i] = wind[1] * 0.8 + (B.vz[i] - wind[1] * 0.8) * kh;
        B.vy[i] += (-9.8 - 4.5 * B.vy[i]) * dt;   // terminal ~2.2 m/s
        const fl = Math.sin(tt * 3.1 + B.a[i]) * 0.9;   // flutter
        B.px[i] += (B.vx[i] + fl * Math.cos(B.b[i])) * dt; B.py[i] += B.vy[i] * dt; B.pz[i] += (B.vz[i] + fl * Math.sin(B.b[i])) * dt;
        B.a[i] += B.wa[i] * dt; B.b[i] += B.wb[i] * dt;
        if (B.py[i] <= B.fl[i] + 3) { const gy = (this.g.city?.terrain ? this.g.city.terrain.heightAt(B.px[i], B.pz[i]) : B.fl[i] - 0.02) + 0.02; if (B.py[i] <= gy) { B.py[i] = gy; B.mode[i] = 2; B.a[i] = -Math.PI / 2; B.t[i] = 0; } }   // (on the ground where it comes down, not the tree's foot level)
      } else if (tt < B.life[i] - 1.5) continue;   // resting on the ground: nothing to write
      let k = 1; if (md === 2) { k = Math.max(0, (B.life[i] - tt) / 1.5); if (tt >= B.life[i]) { B.mode[i] = 0; B.alive--; k = 0; } }
      if (k <= 0) m.makeScale(0, 0, 0);
      else m.compose(v.set(B.px[i], B.py[i], B.pz[i]), q.setFromEuler(e.set(B.a[i], B.b[i], md === 2 ? 0 : B.a[i] * 0.5, 'YXZ')), s.set(B.sx[i] * k, B.sy[i] * k, 1));
      im.setMatrixAt(i, m); dirty = true;
    }
    if (dirty) { im.count = B.hw; const a = im.instanceMatrix; a.clearUpdateRanges(); a.addUpdateRange(0, B.hw * 16); a.needsUpdate = true; }
    if (!B.alive) { B.hw = 0; im.count = 0; im.visible = false; }
  }
  stepWood(dt) {
    const B = this.W, m = this._m, q = this._q, e = this._e, v = this._v, s = this._s, ter = this.g.city?.terrain, im = this.woodMesh; let dirty = false;
    const kd = Math.exp(-0.15 * dt);
    for (let i = 0; i < B.hw; i++) {
      const md = B.mode[i]; if (!md) continue;
      B.t[i] += dt; const tt = B.t[i];
      if (md === 1) {
        B.vy[i] -= 9.8 * dt; B.vx[i] *= kd; B.vz[i] *= kd;
        B.px[i] += B.vx[i] * dt; B.py[i] += B.vy[i] * dt; B.pz[i] += B.vz[i] * dt; B.a[i] += B.wa[i] * dt; B.b[i] += B.wb[i] * dt;
        const gy = (ter ? ter.heightAt(B.px[i], B.pz[i]) : 0) + B.sy[i] * 0.5;
        if (B.py[i] < gy) {
          B.py[i] = gy; B.vy[i] *= -0.25; B.vx[i] *= 0.4; B.vz[i] *= 0.4; B.wa[i] *= 0.35; B.wb[i] *= 0.35;
          if (Math.abs(B.vy[i]) < 1.2) { B.mode[i] = 2; B.vy[i] = 0; B.fl[i] = gy; }   // lies flat (its long axis horizontal)
        }
      } else if (tt < B.life[i] - 2) continue;
      let k = 1, sink = 0;
      if (md === 2 && tt > B.life[i] - 2) { k = Math.max(0, (B.life[i] - tt) / 2); sink = (1 - k) * B.sy[i]; if (tt >= B.life[i]) { B.mode[i] = 0; B.alive--; k = 0; } }
      if (k <= 0) m.makeScale(0, 0, 0);
      else m.compose(v.set(B.px[i], B.py[i] - sink, B.pz[i]), q.setFromEuler(e.set(B.a[i], B.b[i], md === 2 ? 0 : B.a[i] * 0.6, 'YZX')), s.set(B.sx[i] * k, B.sy[i], B.sy[i]));
      im.setMatrixAt(i, m); dirty = true;
    }
    if (dirty) { im.count = B.hw; const a = im.instanceMatrix; a.clearUpdateRanges(); a.addUpdateRange(0, B.hw * 16); a.needsUpdate = true; }
    if (!B.alive) { B.hw = 0; im.count = 0; im.visible = false; }
  }
  stepTops(dt) {
    for (let p = this.falling.length - 1; p >= 0; p--) {
      const top = this.falling[p]; let any = false;
      for (const it of top.items) {
        if (!it || it.rest) continue; any = true;
        it.age += dt; it.w += (1.5 * 9.8 / it.L) * Math.sin(it.th + 0.06) * dt; it.th += it.w * dt;
        if (it.th >= it.thf) { it.th = it.thf; it.w = -it.w * 0.18; if (Math.abs(it.w) < 0.08) it.rest = true; }
        if (it.age > 12) it.rest = true;
        this.topPose(top, it);
      }
      if (!any) this.falling.splice(p, 1);
    }
  }
}
const ZERO = new Float32Array(16);
