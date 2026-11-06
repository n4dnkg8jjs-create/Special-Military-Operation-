import * as THREE from 'three';
import { simplifier } from './instancer.js';
import { CAPS, markStatic } from '../engine/renderer.js';

// Soviet large-panel apartment blocks assembled from kit panels drawn with InstancedMesh.
// Each panel has a damage state (0 intact, 1 damaged, 2 holed, 3 destroyed) that shells can raise at runtime.
export const STATES = ['intact', 'damaged', 'holed', 'destroyed'];

// Pool of InstancedMeshes keyed by (piece, spatial cell), kept compact with swap-remove.
// Cells give each InstancedMesh a tight bounding sphere so off-screen / out-of-shadow-range
// blocks are culled from both the main and the shadow pass.
let CELL = 90;
// real-place maps (larger, many more blocks) use bigger cells: fewer InstancedMeshes / draw calls, coarser culling
export function setKitCell(c) { CELL = c; }
export class KitPool {
  constructor(scene, kit) { this.scene = scene; this.kit = kit; this.req = new Map(); this.groups = new Map(); this.dirty = new Set(); }
  static cellOf(x, z) { return `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`; }
  key(piece, cell) { return piece + '|' + cell; }
  request(piece, n = 1, cell = '0,0') { const k = this.key(piece, cell); this.req.set(k, (this.req.get(k) || 0) + n); }
  build() {
    for (const [k, cap] of this.req) {
      const piece = k.split('|')[0];
      const parts = this.kit.pieces[piece]; if (!parts) { console.warn('kit piece missing', piece); continue; }
      const meshes = parts.map(p => {
        const m = new THREE.InstancedMesh(p.geometry, p.material, cap);
        m.count = 0; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = true; m.visible = false;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.name = piece; m.matrixAutoUpdate = false; this.scene.add(m); return m;   // (static object transform: instances carry the placement)
      });
      this.groups.set(k, { meshes, owners: [], cap });
    }
  }
  add(piece, matrix, owner, color) {
    const cell = owner.cell || '0,0', k = this.key(piece, cell);
    const g = this.groups.get(k); if (!g) return -1;
    const i = g.owners.length; if (i >= g.cap) return -1;
    for (const m of g.meshes) { m.setMatrixAt(i, matrix); if (color) m.setColorAt(i, color); m.count = i + 1; m.visible = true; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    g.owners.push(owner); owner.slot = i; owner.poolKey = k; this.dirty.add(g);
    return i;
  }
  remove(piece, owner) {
    const g = this.groups.get(owner.poolKey || this.key(piece, owner.cell || '0,0')); if (!g || owner.slot < 0) return;
    const i = owner.slot, last = g.owners.length - 1, mtx = new THREE.Matrix4(), col = new THREE.Color();
    if (i !== last) {
      const moved = g.owners[last];
      for (const m of g.meshes) { m.getMatrixAt(last, mtx); m.setMatrixAt(i, mtx); if (m.instanceColor) { m.getColorAt(last, col); m.setColorAt(i, col); } }
      g.owners[i] = moved; moved.slot = i;
    }
    g.owners.pop(); owner.slot = -1;
    for (const m of g.meshes) { m.count = g.owners.length; m.visible = m.count > 0; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    this.dirty.add(g);
  }
  setMatrix(owner, matrix) {
    const g = this.groups.get(owner.poolKey); if (!g || owner.slot < 0) return;
    for (const m of g.meshes) { m.setMatrixAt(owner.slot, matrix); m.instanceMatrix.needsUpdate = true; } this.dirty.add(g);
  }
  // recompute bounding spheres of groups that changed (call once per frame / after edits)
  finish() { for (const g of this.dirty) for (const m of g.meshes) if (m.count) { m.computeBoundingSphere(); m.boundingSphere.radius += 3; } this.dirty.clear(); }
}

// ---- KitBatch: same API as KitPool, drawn with BatchedMesh (WEBGL_multi_draw): ONE draw call per (cell, material)
// for every kit piece / damage state / variant in the cell, instead of one per (piece, state, variant, part, cell)
// (the city drew ~60 InstancedMeshes per cell, x2 with the shadow pass).  All cells share one vertex / index buffer per
// material (every piece geometry stored once, like instancing).  Per instance: cached world bounding sphere for culling
// against the camera / shadow frustum, and a distance LOD: damaged / holed / destroyed pieces (800-1700 triangles of
// rubble edges, rebar, crumbs) switch to a meshopt-simplified copy (absolute error FAR_ERR) beyond FAR_D (~0.15 px
// there), and the shadow pass draws the SHADOW_ERR copy (sub-texel: the shadow map has ~6-11 cm texels and a ~17 cm
// depth bias).  Intact pieces (~150 triangles, nothing to simplify) keep their mesh.  Same materials, same per-instance
// colour: the image is the same as with instancing.  Without WEBGL_multi_draw (three would issue one draw per instance)
// the KitPool path is used.
let FAR_D = 130, FAR_ERR = 0.02, SHADOW_ERR = 0.03;
const WHITE = new THREE.Color(1, 1, 1), _bs = new THREE.Sphere();
class KitBM extends THREE.BatchedMesh {
  constructor(cap, src, material) {
    super(cap, 1, 2, material);
    this.geometry.dispose(); this.geometry = src.geometry;   // share the master's packed geometry (never initialised here)
    this._geometryInfo = src._geometryInfo; this._geometryCount = src._geometryCount; this._geometryInitialized = true;
    this._maxVertexCount = src._maxVertexCount; this._maxIndexCount = src._maxIndexCount; this._nextVertexStart = src._nextVertexStart; this._nextIndexStart = src._nextIndexStart;
    this.src = src; this.kv = 0; this.sph = new Float32Array(cap * 4); this.perObjectFrustumCulled = true; this.sortObjects = false;
    this.matrixAutoUpdate = false; this.castShadow = this.receiveShadow = true; this.visible = false;
  }
  grow(n) { this.setInstanceCount(n); const s = new Float32Array(n * 4); s.set(this.sph.subarray(0, Math.min(this.sph.length, s.length))); this.sph = s; }
  place(id, m, gid) {   // matrix + cached world-space bounding sphere of the instance
    this.setMatrixAt(id, m); this.kv++; const s = this.src.spheres[gid]; _bs.copy(s).applyMatrix4(m);
    const o = id * 4; this.sph[o] = _bs.center.x; this.sph[o + 1] = _bs.center.y; this.sph[o + 2] = _bs.center.z; this.sph[o + 3] = _bs.radius;
  }
  // replaces BatchedMesh's per-pass draw list (r187 internals: _instanceInfo, _geometryInfo, _multiDraw*, _indirectTexture):
  // cached spheres instead of matrix decode per instance, no sort, LOD / shadow geometry per instance
  _updateDrawParameters(camera, geometry) {
    const shadow = !!camera.isOrthographicCamera, info = this._instanceInfo, gi = this._geometryInfo, src = this.src, lod = shadow ? src.shadowOf : src.farOf;
    const starts = this._multiDrawStarts, counts = this._multiDrawCounts, ind = this._indirectTexture.image.data, sph = this.sph;
    const bpe = geometry.getIndex().array.BYTES_PER_ELEMENT;
    _frustum.setFromProjectionMatrix(_pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem, camera.reversedDepth);
    const pl = _frustum.planes, cx = camera.matrixWorld.elements[12], cy = camera.matrixWorld.elements[13], cz = camera.matrixWorld.elements[14], far2 = FAR_D * FAR_D;
    let n = 0;
    for (let i = 0, l = info.length; i < l; i++) {
      const it = info[i]; if (!it.active || !it.visible) continue;
      const o = i * 4, x = sph[o], y = sph[o + 1], z = sph[o + 2], r = -sph[o + 3];
      if (pl[0].normal.x * x + pl[0].normal.y * y + pl[0].normal.z * z + pl[0].constant < r || pl[1].normal.x * x + pl[1].normal.y * y + pl[1].normal.z * z + pl[1].constant < r
        || pl[2].normal.x * x + pl[2].normal.y * y + pl[2].normal.z * z + pl[2].constant < r || pl[3].normal.x * x + pl[3].normal.y * y + pl[3].normal.z * z + pl[3].constant < r
        || pl[4].normal.x * x + pl[4].normal.y * y + pl[4].normal.z * z + pl[4].constant < r || pl[5].normal.x * x + pl[5].normal.y * y + pl[5].normal.z * z + pl[5].constant < r) continue;
      let g = it.geometryIndex;
      if (shadow) g = lod[g]; else if ((x - cx) * (x - cx) + (y - cy) * (y - cy) + (z - cz) * (z - cz) > far2) g = lod[g];
      const G = gi[g]; starts[n] = G.start * bpe; counts[n] = G.count; ind[n] = i; n++;
    }
    this._indirectTexture.needsUpdate = true; this._multiDrawCount = n; this._multiDrawBytesPerElement = bpe; this._visibilityChanged = false;
  }
}
const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4();
// float, non-interleaved, indexed position / normal / uv copy (BatchedMesh needs identical attribute layouts)
function plainGeo(src) {
  const g = new THREE.BufferGeometry(), n = src.attributes.position.count;
  for (const [k, s] of [['position', 3], ['normal', 3], ['uv', 2]]) {
    const a = src.attributes[k], d = new Float32Array(n * s);
    if (a) for (let i = 0; i < n; i++) for (let c = 0; c < s; c++) d[i * s + c] = a.getComponent(i, c);
    g.setAttribute(k, new THREE.BufferAttribute(d, s));
  }
  if (!src.attributes.normal) g.computeVertexNormals();
  g.setIndex(src.index ? Array.from(src.index.array) : [...Array(n).keys()]);
  return g;
}
function simplifyIndex(g, err) {
  const S = simplifier(); if (!S || g.index.count < 600) return null;   // (intact pieces: ~150 triangles, nothing to gain)
  const [res] = S.simplify(new Uint32Array(g.index.array), g.attributes.position.array, 3, 0, err, ['ErrorAbsolute']);
  if (res.length > g.index.count * 0.9) return null;
  const c = new THREE.BufferGeometry(); for (const k of ['position', 'normal', 'uv']) c.setAttribute(k, g.attributes[k]); c.setIndex(Array.from(res)); return c;
}
// the weathering shader (wear.js) derives world position / normal from instanceMatrix only: add the batching matrix
function batchAware(m) {
  if (m.userData.batchAware) return; m.userData.batchAware = true;
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    if (/varying vec3 vWxP/.test(sh.vertexShader) && /varying vec3 vWxN/.test(sh.vertexShader)) sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#ifdef USE_BATCHING
      { vec4 bwp = batchingMatrix * vec4(transformed, 1.0); vWxP = (modelMatrix * bwp).xyz; vWxN = normalize(mat3(modelMatrix) * (mat3(batchingMatrix) * objectNormal)); }
      #endif
      #include <project_vertex>`);
  };
  m.needsUpdate = true;
}
export class KitBatch {
  constructor(scene, kit) { this.scene = scene; this.kit = kit; this.req = new Map(); this.masters = new Map(); this.cells = new Map(); this.dirty = new Set(); this.batched = true; }
  static cellOf(x, z) { return KitPool.cellOf(x, z); }
  request(piece, n = 1, cell = '0,0') { const k = piece + '|' + cell; this.req.set(k, (this.req.get(k) || 0) + n); }
  build() {
    // geometry per material: every part of every requested piece (+ its far / shadow LOD copies)
    const pieces = new Set(), capBy = new Map();
    for (const [k, n] of this.req) {
      const [piece, cell] = k.split('|'); const parts = this.kit.pieces[piece]; if (!parts) { console.warn('kit piece missing', piece); continue; }
      pieces.add(piece); for (const p of parts) { const ck = cell + '|' + p.material.uuid; capBy.set(ck, (capBy.get(ck) || 0) + n); }
    }
    const geos = new Map();   // material -> [[part geometry, plain, far, shadow]]
    for (const piece of pieces) for (const p of this.kit.pieces[piece]) {
      if (p.geometry.userData.kbG) continue;
      const g = plainGeo(p.geometry), far = simplifyIndex(g, FAR_ERR), sh = simplifyIndex(g, SHADOW_ERR);
      p.geometry.userData.kbG = true; (geos.get(p.material) || geos.set(p.material, []).get(p.material)).push([p.geometry, g, far, sh]);
    }
    for (const [mat, list] of geos) {
      let nv = 0, ni = 0; for (const [, g, f, s] of list) { nv += g.attributes.position.count; ni += g.index.count + (f ? f.index.count : 0) + (s ? s.index.count : 0); }
      const M = new THREE.BatchedMesh(1, nv, ni, mat); M.ids = new Map(); M.farOf = []; M.shadowOf = []; M.spheres = [];
      for (const [orig, g, f, s] of list) {
        g.computeBoundingSphere(); const id = M.addGeometry(g); M.ids.set(orig, id);
        // LOD copies share the vertex range: reserve no vertices, only the simplified index list (addGeometry would copy
        // the vertices again; setGeometryAt-free path: write the indices behind the main ones)
        const lods = [f, s].map(x => x ? this.addIndexOnly(M, id, x) : id);
        for (const q of [id, ...lods]) M.spheres[q] = g.boundingSphere;
        M.farOf[id] = lods[0]; M.shadowOf[id] = lods[1]; M.farOf[lods[0]] = lods[0]; M.shadowOf[lods[1]] = lods[1];
      }
      for (const a of [...Object.values(M.geometry.attributes), M.geometry.index]) { a.clearUpdateRanges(); a.needsUpdate = true; }   // (first upload: whole buffers)
      this.masters.set(mat, M); batchAware(mat);
    }
    this.capBy = capBy;
  }
  // an extra "geometry" entry that indexes an existing geometry's vertices with another (simplified) index list
  addIndexOnly(M, base, g) {
    const info = M._geometryInfo[base], idx = M.geometry.getIndex(), start = M._nextIndexStart, src = g.index.array;
    for (let i = 0; i < src.length; i++) idx.array[start + i] = src[i] + info.vertexStart;
    idx.needsUpdate = true; M._nextIndexStart += src.length;
    const id = M._geometryInfo.length;
    M._geometryInfo.push({ ...info, indexStart: start, indexCount: src.length, reservedIndexCount: src.length, start, count: src.length, boundingBox: null, boundingSphere: null });
    M._geometryCount++;
    return id;
  }
  bm(cell, mat) {
    const k = cell + '|' + mat.uuid; let b = this.cells.get(k); if (b) return b;
    const M = this.masters.get(mat); if (!M) return null;
    b = new KitBM(Math.max(8, this.capBy.get(k) || 64), M, mat); b.name = 'kit|' + cell + '|' + (mat.name || ''); this.scene.add(b); this.cells.set(k, b); markStatic(b);
    return b;
  }
  add(piece, matrix, owner, color) {
    const parts = this.kit.pieces[piece]; if (!parts) return -1;
    const ids = [];
    for (const p of parts) {
      const b = this.bm(owner.cell || '0,0', p.material); if (!b) continue; const gid = b.src.ids.get(p.geometry); if (gid == null) continue;
      if (b.instanceCount >= b.maxInstanceCount) b.grow(Math.ceil(b.maxInstanceCount * 1.5) + 8);
      const id = b.addInstance(gid); b.place(id, matrix, gid); b.setColorAt(id, color || WHITE); ids.push(b, id); this.dirty.add(b);
    }
    owner.ids = ids; owner.slot = ids.length ? 0 : -1; owner.poolKey = piece;
    return owner.slot;
  }
  remove(piece, owner) {
    const ids = owner.ids; if (!ids || owner.slot < 0) return;
    for (let i = 0; i < ids.length; i += 2) { ids[i].deleteInstance(ids[i + 1]); ids[i].kv++; this.dirty.add(ids[i]); }
    owner.ids = null; owner.slot = -1;
  }
  setMatrix(owner, matrix) {
    const ids = owner.ids; if (!ids || owner.slot < 0) return;
    for (let i = 0; i < ids.length; i += 2) { const b = ids[i], id = ids[i + 1]; b.place(id, matrix, b.getGeometryIdAt(id)); this.dirty.add(b); }
  }
  finish() {
    for (const b of this.dirty) { b.visible = b.instanceCount > 0; if (b.visible) { b.computeBoundingSphere(); b.boundingSphere.radius += 3; } }
    this.dirty.clear();
  }
}
// choose the pool: BatchedMesh path when the context has WEBGL_multi_draw (?kitbatch=0 / localStorage smo_kitbatch=0: off)
export function makeKitPool(scene, kit) {
  let on = CAPS.multiDraw;
  try { const q = new URLSearchParams(location.search).get('kitbatch'); if (q != null) on = on && q !== '0'; else if (localStorage.getItem('smo_kitbatch') === '0') on = false; } catch {}
  return on ? new KitBatch(scene, kit) : new KitPool(scene, kit);
}

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), tmpS = new THREE.Vector3(1, 1, 1), Y = new THREE.Vector3(0, 1, 0);

export class Building {
  // opts: {x, z, rot, modules, floors, depthModules, sections, kind: 'khrushchyovka'|'nine'|'school'|'shop', seed}
  constructor(opts, kit) {
    Object.assign(this, { depthModules: 4, sections: 3, kind: 'khrushchyovka' }, opts);
    this.kit = kit; const W = kit.W, H = kit.H;
    this.L = this.modules * W; this.D = this.depthModules * W; this.height = this.floors * H + 0.6;
    this.panels = []; this.slots = []; this.occupants = new Set(); this.garrisonCap = 0;
    this.cos = Math.cos(this.rot); this.sin = Math.sin(this.rot);
    this.rng = mulberry(this.seed || (Math.abs(this.x * 31 + this.z * 17) | 0) + 1);
    this.tint = new THREE.Color().setHSL(0.09 + this.rng() * 0.04, 0.05 + this.rng() * 0.08, 0.86 + this.rng() * 0.1);
    if (opts.tint != null) this.tint = new THREE.Color(opts.tint).offsetHSL(0, 0, (this.rng() - 0.5) * 0.04); // renovated, insulated facade
    this.layout();
  }
  // local -> world
  toWorld(lx, ly, lz, out = new THREE.Vector3()) { return out.set(this.x + lx * this.cos + lz * this.sin, ly, this.z - lx * this.sin + lz * this.cos); }
  toLocal(wx, wz) { const dx = wx - this.x, dz = wz - this.z; return [dx * this.cos - dz * this.sin, dx * this.sin + dz * this.cos]; }
  // kit piece for a wall role, honouring the building's construction type with fallback
  piece(role) {
    const has = n => !!this.kit.pieces[n + '_intact'];
    if (this.kind === 'brick') { const b = role.replace(/^wall_/, 'brick_'); if (has(b)) return b; }
    return role;
  }
  layout() {
    const { W, H } = this.kit, L = this.L, D = this.D, r = this.rng;
    const hasShop = !!this.kit.pieces.wall_shopfront_intact;
    const secW = Math.floor(this.modules / this.sections);
    const entranceCols = new Set(); for (let s = 0; s < this.sections; s++) entranceCols.add(Math.min(this.modules - 1, s * secW + Math.floor(secW / 2)));
    const balconyPattern = this.kind === 'school' || this.kind === 'shop' ? () => false : this.kind === 'tower' ? (c) => (c % 2 === 1) : (c) => (c % 3 === 1);
    for (let f = 0; f < this.floors; f++) {
      for (let c = 0; c < this.modules; c++) {
        // front (+Z local, street side): windows & balconies
        const fb = f > 0 && balconyPattern(c);
        const shop = f === 0 && this.shops && hasShop && (c % 4 !== 3);
        this.panels.push({ side: 'front', col: c, floor: f, type: shop ? 'wall_shopfront' : this.piece(fb ? 'wall_balcony' : 'wall_window'), state: 0, balcony: fb, shop, rot: 0, px: -L / 2 + c * W, pz: D / 2 });
        // back (-Z local, courtyard side): entrances at ground floor
        const ent = f === 0 && entranceCols.has(c);
        this.panels.push({ side: 'back', col: c, floor: f, type: this.piece(ent ? 'wall_entrance' : 'wall_window'), state: 0, entrance: ent, rot: Math.PI, px: -L / 2 + (c + 1) * W, pz: -D / 2 });
      }
      for (let j = 0; j < this.depthModules; j++) {
        const endT = this.kind === 'tower' ? this.piece('wall_window') : this.piece('wall_blank_end');
        this.panels.push({ side: 'right', col: j, floor: f, type: endT, state: 0, rot: Math.PI / 2, px: L / 2, pz: D / 2 - j * W });
        this.panels.push({ side: 'left', col: j, floor: f, type: endT, state: 0, rot: -Math.PI / 2, px: -L / 2, pz: -D / 2 + j * W });
      }
    }
    this.cell = KitPool.cellOf(this.x, this.z);
    for (const p of this.panels) { p.b = this; p.slot = -1; p.acc = null; p.hp = 100; p.cell = this.cell; }
    // garrison slots: windows on floors 0..2 facing out
    for (const p of this.panels) {
      if (p.floor > 2 || p.type === 'wall_blank_end' || p.entrance) continue;
      if ((p.col + p.floor) % 2) continue;
      this.slots.push({ panel: p, occupant: null });
    }
    this.garrisonCap = Math.min(this.slots.length, 24);
    // entrance sections (load-bearing units that can collapse independently)
    const sw = Math.max(1, Math.floor(this.modules / this.sections));
    this.secCols = []; for (let i = 0; i < this.sections; i++) this.secCols.push([i * sw, i === this.sections - 1 ? this.modules - 1 : (i + 1) * sw - 1]);
    this.collapsedSecs = new Set(); this.goneCols = new Set();
    // entrance world positions (courtyard side doors)
    this.entrances = [...entranceCols].map(c => this.toWorld(-L / 2 + (c + 0.5) * W, 0, -D / 2 - 2.0));
  }
  // Pre-damage pattern for the "already shelled" look.
  predamage(intensity) {
    const r = this.rng;
    // a few impact clusters
    const n = Math.round(intensity * (3 + this.modules * this.floors / 14));
    for (let i = 0; i < n; i++) {
      const p = this.panels[Math.floor(r() * this.panels.length)];
      const sev = r() < 0.25 ? 3 : r() < 0.5 ? 2 : 1;
      for (const q of this.panels) if (q.side === p.side && Math.abs(q.col - p.col) <= 1 && Math.abs(q.floor - p.floor) <= 1) {
        const d = Math.abs(q.col - p.col) + Math.abs(q.floor - p.floor);
        q.state = Math.max(q.state, Math.max(0, sev - d - (r() < 0.4 ? 1 : 0)));
      }
    }
    // general soot / broken glass
    for (const p of this.panels) if (p.state === 0 && r() < 0.35 * intensity) p.state = 1;
    // collapsed top corner on some
    if (r() < 0.45 * intensity) {
      const side = r() < 0.5 ? 'left' : 'right';
      const endCol = side === 'right' ? this.modules - 1 : 0;
      for (const p of this.panels) {
        const near = (p.side === side) || ((p.side === 'front' || p.side === 'back') && Math.abs(p.col - endCol) <= 1);
        // the top storey at the corner is gone entirely; the one below is blown out (no stacked jagged half-walls)
        if (near && p.floor === this.floors - 1) { p.state = 3; p.gone = true; }
        else if (near && p.floor === this.floors - 2) p.state = 3;
      }
      this.collapsedCorner = side;
    }
    // structural plausibility: a blown-out panel cracks the panels above it (nothing intact floats over a hole)
    const at = new Map(); for (const p of this.panels) at.set(p.side + ':' + p.col + ':' + p.floor, p);
    // shell holes don't stack in neat columns: break up vertical runs of identical holes, crack what's above
    const top = this.floors - 1, cornerZone = p => this.collapsedCorner && p.floor >= this.floors - 2 && (p.side === this.collapsedCorner || Math.abs(p.col - (this.collapsedCorner === 'right' ? this.modules - 1 : 0)) <= 1);
    for (const p of this.panels) {
      if (p.state < 2 || cornerZone(p)) continue;
      const below = at.get(p.side + ':' + p.col + ':' + (p.floor - 1));
      if (below && below.state >= 2 && !cornerZone(below) && r() < 0.75) p.state = Math.max(1, p.state - (r() < 0.6 ? 2 : 1));
    }
    for (const p of this.panels) if (p.state === 3 && p.floor < top && !cornerZone(p)) { const a = at.get(p.side + ':' + p.col + ':' + (p.floor + 1)); if (a) a.state = Math.max(a.state, 1); }
    this.panelMap = at;
  }
  // Pancake a vertical slice of the building (all floors) between cols a..b.
  pancake(a, b) {
    for (const p of this.panels) if ((p.side === 'front' || p.side === 'back') && p.col >= a && p.col <= b) { p.state = 3; if (p.floor > 0) p.gone = true; }
    this.pancaked = [a, b];
  }
  requestKit(pool) {
    const c = this.cell;
    for (const p of this.panels) { p.var ??= Math.floor(this.rng() * 3); for (let k = 0; k < STATES.length; k++) pool.request(this.pieceName(p, k), 1, c); }
    for (const sl of this.slots) for (let k = 0; k < 2; k++) { const n = `${sl.panel.type}_${STATES[k]}_open`; if (this.kit.pieces[n]) pool.request(n, 1, c); }   // v7: openWindow
    // lived-in variety: many Soviet balconies were glazed in by their owners over the decades
    for (const p of this.panels) if (p.balcony) { const r = this.rng(); p.balPiece = r < 0.45 && this.kit.pieces.balcony_slab_glazed ? 'balcony_slab_glazed' : r < 0.6 && this.kit.pieces.balcony_slab_open ? 'balcony_slab_open' : 'balcony_slab'; pool.request(p.balPiece, 1, c); if (p.balPiece === 'balcony_slab_glazed') pool.request(this.kit.pieces.balcony_slab_open ? 'balcony_slab_open' : 'balcony_slab', 1, c); }
    for (const p of this.panels) if (p.entrance) pool.request('entrance_canopy', 1, c);
    this.signs = this.signs || this.panels.filter(p => p.shop && p.col % 3 === 0).map((p, i) => ({ p, name: this.signNames?.[i % this.signNames.length] }));
    for (const sg of this.signs) if (sg.name) pool.request(sg.name, 1, c);
    if (this.floors >= 9 && this.kit.pieces.roof_machine_room) pool.request('roof_machine_room', this.sections, c);
    pool.request('roof_parapet', 2 * this.modules + 2 * this.depthModules, c);
  }
  panelMatrix(p, out) {
    const { H } = this.kit;
    this.toWorld(p.px, p.floor * H, p.pz, tmpV);
    tmpQ.setFromAxisAngle(Y, this.rot + p.rot);
    return out.compose(tmpV, tmpQ, tmpS);
  }
  place(pool) {
    this.pool = pool;
    const col = new THREE.Color();
    for (const p of this.panels) {
      if (p.gone) continue;
      col.copy(this.tint).offsetHSL(0, 0, (this.rng() - 0.5) * 0.04);
      if (p.state > 0) col.multiplyScalar(p.state === 1 ? 0.86 + this.rng() * 0.14 : 0.7 + this.rng() * 0.22); // uneven soot / weathering
      p.color = col.clone();
      pool.add(this.pieceName(p), this.panelMatrix(p, tmpM), p, p.color);
      if (p.balcony && p.state < 2) { p.acc = { slot: -1, cell: this.cell }; if (p.state === 1 && p.balPiece === 'balcony_slab_glazed') p.balPiece = this.kit.pieces.balcony_slab_open ? 'balcony_slab_open' : 'balcony_slab'; pool.add(p.balPiece || 'balcony_slab', tmpM, p.acc, p.color); }
      if (p.entrance) {
        p.acc = { slot: -1, cell: this.cell }; const m2 = tmpM.clone(); m2.multiply(new THREE.Matrix4().makeTranslation(0, this.kit.H * 0.8, 0));
        pool.add('entrance_canopy', m2, p.acc, p.color);
      }
    }
    // shop signs above shopfronts, lift machine rooms on tall blocks
    for (const sg of this.signs || []) if (sg.name) { sg.slot = -1; sg.cell = this.cell; const m2 = this.panelMatrix(sg.p, new THREE.Matrix4()).multiply(new THREE.Matrix4().makeTranslation(0, this.kit.H * 0.764, 0)); pool.add(sg.name, m2, sg, null); }
    if (this.floors >= 9 && this.kit.pieces.roof_machine_room) for (const [a, b] of this.secCols) { const o = { slot: -1, cell: this.cell }; const w = this.toWorld(-this.L / 2 + ((a + b + 1) / 2) * this.kit.W, this.floors * this.kit.H + 0.2, 0); pool.add('roof_machine_room', new THREE.Matrix4().compose(w, new THREE.Quaternion().setFromAxisAngle(Y, this.rot), tmpS.set(1, 1, 1)), o, null); (this.machines ||= []).push({ o, a, b }); }
    // roof parapets
    const { W, H } = this.kit, top = this.floors * H;
    this.parapets = [];
    const addPar = (lx, lz, rot, col) => { const o = { slot: -1, cell: this.cell, col }; this.toWorld(lx, top, lz, tmpV); tmpQ.setFromAxisAngle(Y, this.rot + rot); tmpM.compose(tmpV, tmpQ, tmpS); pool.add('roof_parapet', tmpM, o, this.tint); this.parapets.push(o); };
    for (let c = 0; c < this.modules; c++) {
      if (!this.isDestroyedTop('front', c)) addPar(-this.L / 2 + c * W, this.D / 2, 0, c);
      if (!this.isDestroyedTop('back', c)) addPar(-this.L / 2 + (c + 1) * W, -this.D / 2, Math.PI, c);
    }
    // gable ends too (the roof slab edge was left bare there): shortened by the parapet depth at the corners, where
    // the long-side parapets already run, so the two never overlap (coplanar copings would z-fight)
    const ps = this.kit.pieces.roof_parapet?.size, pl = ps?.x || W, pd = Math.min(0.5, ps?.z || 0.3), M2 = new THREE.Matrix4(), S2 = new THREE.Matrix4();
    for (let j = 0; j < this.depthModules; j++) for (const [side, px, pz, rot, dir, col] of [['right', this.L / 2, this.D / 2, Math.PI / 2, -1, this.modules - 1], ['left', -this.L / 2, -this.D / 2, -Math.PI / 2, 1, 0]]) {
      if (this.isDestroyedTop(side, j)) continue;
      const s0 = j === 0 ? pd : 0, len = W - s0 - (j === this.depthModules - 1 ? pd : 0); if (len < 0.2) continue;
      const o = { slot: -1, cell: this.cell, col }; this.toWorld(px, top, pz + dir * j * W, tmpV); tmpQ.setFromAxisAngle(Y, this.rot + rot); tmpM.compose(tmpV, tmpQ, tmpS);
      tmpM.multiply(M2.makeTranslation(s0, 0, 0)).multiply(S2.makeScale(len / pl, 1, 1));
      pool.add('roof_parapet', tmpM, o, this.tint); this.parapets.push(o);
    }
  }
  isDestroyedTop(side, col) { const p = this.panels.find(q => q.side === side && q.col === col && q.floor === this.floors - 1); return p && (p.state === 3 || p.gone); }
  // Interior: floor slabs + dark volume per column so holes read as rooms.
  buildInterior(slabMesh, darkMesh, counters) {
    const { W, H } = this.kit, inset = 1.2, D = this.D;
    this.interior = [];
    for (let c = 0; c < this.modules; c++) for (let f = 0; f < this.floors; f++) {
      const gone = this.pancaked && c >= this.pancaked[0] && c <= this.pancaked[1];
      const topGone = this.collapsedCorner && f >= this.floors - 2 && (this.collapsedCorner === 'right' ? c >= this.modules - 2 : c <= 1);
      if (gone || topGone) continue;
      const cx = -this.L / 2 + (c + 0.5) * W;
      this.toWorld(cx, f * H + H - 0.11, 0, tmpV); tmpQ.setFromAxisAngle(Y, this.rot);
      tmpM.compose(tmpV, tmpQ, tmpS.set(W, 0.22, D - 0.2)); (this.intIdx ||= {})[c] ||= []; this.intIdx[c].push(['slab', counters.slab]); slabMesh.setMatrixAt(counters.slab++, tmpM);
      this.toWorld(cx, f * H + H / 2, 0, tmpV);
      tmpM.compose(tmpV, tmpQ, tmpS.set(W - 0.02, H - 0.24, D - inset * 2)); this.intIdx[c].push(['dark', counters.dark]); darkMesh.setMatrixAt(counters.dark++, tmpM);
      tmpS.set(1, 1, 1);
    }
    // roof, per module column (missing over collapsed parts).  Inset into the wall thickness: a roof slab flush with the
    // facades would share their outer plane over its 10 cm below the wall top and z-fight there (a flickering band under
    // the parapet); the parapet covers the slab edge.
    const ins = Math.min(0.2, (this.kit.T || 0.3) * 0.6);
    for (let c = 0; c < this.modules; c++) {
      const gone = this.pancaked && c >= this.pancaked[0] && c <= this.pancaked[1];
      const corner = this.collapsedCorner && (this.collapsedCorner === 'right' ? c >= this.modules - 2 : c <= 1);
      if (gone || corner) continue;
      const a = Math.max(-this.L / 2 + ins, -this.L / 2 + c * W - 0.005), b = Math.min(this.L / 2 - ins, -this.L / 2 + (c + 1) * W + 0.005);
      this.toWorld((a + b) / 2, this.floors * H + 0.05, 0, tmpV); tmpQ.setFromAxisAngle(Y, this.rot);
      tmpM.compose(tmpV, tmpQ, tmpS.set(b - a, 0.3, this.D - 2 * ins)); ((this.intIdx ||= {})[c] ||= []).push(['roof', counters.roofs.length]); counters.roofs.push(tmpM.clone()); tmpS.set(1, 1, 1);
    }
  }
  // damage variants (_v2/_v3) keep a facade from repeating the same hole over and over
  pieceName(p, st = p.state) {
    const base = `${p.type}_${STATES[st]}`;
    if (p.open && st <= 1 && this.kit.pieces[base + '_open']) return base + '_open';   // v7: glass knocked out (openWindow)
    if (st >= 2 && p.var) { const v = `${base}_v${p.var + 1}`; if (this.kit.pieces[v]) return v; }
    return base;
  }
  setGone(p) {
    if (p.gone) return false;
    if (p.slot >= 0) this.pool.remove(this.pieceName(p), p);
    if (p.acc && p.acc.slot >= 0) this.pool.remove(p.balcony ? (p.balPiece || 'balcony_slab') : 'entrance_canopy', p.acc);
    p.gone = true; p.state = 3; return true;
  }
  setState(p, s) {
    if (p.gone || s <= p.state) return false;
    this.pool.remove(this.pieceName(p), p);
    p.state = Math.min(3, s);
    this.pool.add(this.pieceName(p), this.panelMatrix(p, tmpM), p, p.color);
    if (p.balcony && p.acc && p.state >= 2 && p.acc.slot >= 0) this.pool.remove(p.balPiece || 'balcony_slab', p.acc);
    return true;
  }
  // v7: a man takes this window: the glass (and a glazed balcony) is knocked out so he can fire - and be seen - through it
  openWindow(p) {
    if (p.open || p.gone || !this.pool) return;
    if (p.state >= 2) { p.open = true; return; }
    const was = this.pieceName(p); p.open = true; const now = this.pieceName(p);
    if (now !== was && p.slot >= 0) { this.pool.remove(was, p); if (this.pool.add(now, this.panelMatrix(p, tmpM), p, p.color) < 0) { p.open = false; this.pool.add(was, this.panelMatrix(p, tmpM), p, p.color); } }
    if (p.balcony && p.acc && p.acc.slot >= 0 && p.balPiece === 'balcony_slab_glazed' && this.kit.pieces.balcony_slab_open) {
      this.pool.remove('balcony_slab_glazed', p.acc); p.balPiece = 'balcony_slab_open'; this.pool.add('balcony_slab_open', this.panelMatrix(p, tmpM), p.acc, p.color);
    }
    this.pool.finish?.();
  }
  // Find the panel nearest to a world-space point on the facade.
  panelAt(wx, wy, wz) {
    const [lx, lz] = this.toLocal(wx, wz), { W, H } = this.kit;
    const f = Math.max(0, Math.min(this.floors - 1, Math.floor(wy / H)));
    const dF = Math.abs(lz - this.D / 2), dB = Math.abs(lz + this.D / 2), dR = Math.abs(lx - this.L / 2), dL = Math.abs(lx + this.L / 2);
    const m = Math.min(dF, dB, dR, dL); let side, col;
    if (m === dF) { side = 'front'; col = Math.floor((lx + this.L / 2) / W); }
    else if (m === dB) { side = 'back'; col = Math.floor((lx + this.L / 2) / W); }
    else if (m === dR) { side = 'right'; col = Math.floor((this.D / 2 - lz) / W); }
    else { side = 'left'; col = Math.floor((lz + this.D / 2) / W); }
    return this.panels.find(p => p.side === side && p.col === col && p.floor === f) || null;
  }
  // Apply blast damage at a point; returns list of panels that changed state.
  damageAt(wx, wy, wz, power) {
    const hit = this.panelAt(wx, wy, wz); if (!hit) return [];
    const changed = [];
    for (const p of this.panels) {
      if (p.side !== hit.side) continue;
      const d = Math.hypot(p.col - hit.col, p.floor - hit.floor); if (d > 1.6) continue;
      p.hp -= power * (d < 0.5 ? 1 : 0.35 / d);
      const s = p.hp < -80 ? 3 : p.hp < 10 ? 2 : p.hp < 70 ? 1 : 0;
      if (this.setState(p, s)) changed.push(p);
    }
    // progressive collapse: destroyed panel with destroyed panel below weakens everything above
    for (const p of changed) if (p.state === 3) {
      const below = this.panels.find(q => q.side === p.side && q.col === p.col && q.floor === p.floor - 1);
      if (below && below.state === 3) {
        // unsupported: this panel and everything above it falls
        for (const q of this.panels) if (q.side === p.side && q.col === p.col && q.floor >= p.floor && !q.gone) { this.setGone(q); q.fell = true; changed.push(q); }
      } else if (p.floor === 0) for (const q of this.panels) if (q.side === p.side && q.col === p.col && q.floor === 1 && q.state < 2) { this.setState(q, 2); changed.push(q); }
    }
    return changed;
  }
  // Section collapse check: lower floors of a section badly destroyed, or the section shot to pieces.
  checkCollapse() {
    const out = [];
    this.secCols.forEach(([a, b], si) => {
      if (this.collapsedSecs.has(si)) return;
      let low = 0, lowBad = 0, all = 0, score = 0;
      for (const p of this.panels) {
        if (p.side !== 'front' && p.side !== 'back') continue; if (p.col < a || p.col > b) continue;
        all++; score += p.gone ? 3 : p.state;
        if (p.floor <= 1) { low++; if (p.state === 3 || p.gone) lowBad++; }
      }
      if ((low && lowBad / low >= 0.38) || (all && score / (3 * all) >= 0.5)) out.push(si);
    });
    return out;
  }
  panelsOfSection(si) {
    const [a, b] = this.secCols[si], first = si === 0, last = si === this.secCols.length - 1;
    return this.panels.filter(p => !p.gone && (((p.side === 'front' || p.side === 'back') && p.col >= a && p.col <= b) || (p.side === 'left' && first) || (p.side === 'right' && last)));
  }
  panelCenter(p, out = new THREE.Vector3()) {
    const { W, H } = this.kit; const L = this.L, D = this.D;
    let lx, lz; const c = p.col + 0.5;
    if (p.side === 'front') { lx = -L / 2 + c * W; lz = D / 2; } else if (p.side === 'back') { lx = -L / 2 + c * W; lz = -D / 2; }
    else if (p.side === 'right') { lx = L / 2; lz = D / 2 - c * W; } else { lx = -L / 2; lz = -D / 2 + c * W; }
    return this.toWorld(lx, p.floor * H + H * 0.5, lz, out);
  }
  outward(p) { const a = this.rot + p.rot; return new THREE.Vector3(Math.sin(a), 0, Math.cos(a)); }
  // Window position for a garrisoned soldier (standing on the floor, just inside the window)
  slotPos(slot, out = new THREE.Vector3()) {
    const p = slot.panel; this.panelCenter(p, out); const o = this.outward(p);
    out.addScaledVector(o, -0.75); out.y = p.floor * this.kit.H + 0.02; return out;
  }
}

function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
