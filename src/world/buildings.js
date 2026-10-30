import * as THREE from 'three';

// Soviet large-panel apartment blocks assembled from kit panels drawn with InstancedMesh.
// Each panel has a damage state (0 intact, 1 damaged, 2 holed, 3 destroyed) that shells can raise at runtime.
export const STATES = ['intact', 'damaged', 'holed', 'destroyed'];

// Pool of InstancedMeshes keyed by piece name, kept compact with swap-remove.
export class KitPool {
  constructor(scene, kit) { this.scene = scene; this.kit = kit; this.req = new Map(); this.groups = new Map(); }
  request(piece, n = 1) { this.req.set(piece, (this.req.get(piece) || 0) + n); }
  build() {
    for (const [piece, cap] of this.req) {
      const parts = this.kit.pieces[piece]; if (!parts) { console.warn('kit piece missing', piece); continue; }
      const meshes = parts.map(p => {
        const m = new THREE.InstancedMesh(p.geometry, p.material, cap);
        m.count = 0; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.name = piece; this.scene.add(m); return m;
      });
      this.groups.set(piece, { meshes, owners: [], cap });
    }
  }
  add(piece, matrix, owner, color) {
    const g = this.groups.get(piece); if (!g) return -1;
    const i = g.owners.length; if (i >= g.cap) return -1;
    for (const m of g.meshes) { m.setMatrixAt(i, matrix); if (color) m.setColorAt(i, color); m.count = i + 1; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    g.owners.push(owner); owner.slot = i; return i;
  }
  remove(piece, owner) {
    const g = this.groups.get(piece); if (!g || owner.slot < 0) return;
    const i = owner.slot, last = g.owners.length - 1, mtx = new THREE.Matrix4(), col = new THREE.Color();
    if (i !== last) {
      const moved = g.owners[last];
      for (const m of g.meshes) { m.getMatrixAt(last, mtx); m.setMatrixAt(i, mtx); if (m.instanceColor) { m.getColorAt(last, col); m.setColorAt(i, col); } }
      g.owners[i] = moved; moved.slot = i;
    }
    g.owners.pop(); owner.slot = -1;
    for (const m of g.meshes) { m.count = g.owners.length; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
  }
  finish() { for (const g of this.groups.values()) for (const m of g.meshes) { m.computeBoundingSphere(); } }
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
    this.layout();
  }
  // local -> world
  toWorld(lx, ly, lz, out = new THREE.Vector3()) { return out.set(this.x + lx * this.cos + lz * this.sin, ly, this.z - lx * this.sin + lz * this.cos); }
  toLocal(wx, wz) { const dx = wx - this.x, dz = wz - this.z; return [dx * this.cos - dz * this.sin, dx * this.sin + dz * this.cos]; }
  layout() {
    const { W, H } = this.kit, L = this.L, D = this.D, r = this.rng;
    const secW = Math.floor(this.modules / this.sections);
    const entranceCols = new Set(); for (let s = 0; s < this.sections; s++) entranceCols.add(Math.min(this.modules - 1, s * secW + Math.floor(secW / 2)));
    const balconyPattern = this.kind === 'school' || this.kind === 'shop' ? () => false : (c) => (c % 3 === 1);
    for (let f = 0; f < this.floors; f++) {
      for (let c = 0; c < this.modules; c++) {
        // front (+Z local, street side): windows & balconies
        const fb = f > 0 && balconyPattern(c);
        this.panels.push({ side: 'front', col: c, floor: f, type: fb ? 'wall_balcony' : 'wall_window', state: 0, balcony: fb, rot: 0, px: -L / 2 + c * W, pz: D / 2 });
        // back (-Z local, courtyard side): entrances at ground floor
        const ent = f === 0 && entranceCols.has(c);
        this.panels.push({ side: 'back', col: c, floor: f, type: ent ? 'wall_entrance' : 'wall_window', state: 0, entrance: ent, rot: Math.PI, px: -L / 2 + (c + 1) * W, pz: -D / 2 });
      }
      for (let j = 0; j < this.depthModules; j++) {
        this.panels.push({ side: 'right', col: j, floor: f, type: 'wall_blank_end', state: 0, rot: Math.PI / 2, px: L / 2, pz: D / 2 - j * W });
        this.panels.push({ side: 'left', col: j, floor: f, type: 'wall_blank_end', state: 0, rot: -Math.PI / 2, px: -L / 2, pz: -D / 2 + j * W });
      }
    }
    for (const p of this.panels) { p.b = this; p.slot = -1; p.acc = null; p.hp = 100; }
    // garrison slots: windows on floors 0..2 facing out
    for (const p of this.panels) {
      if (p.floor > 2 || p.type === 'wall_blank_end' || p.entrance) continue;
      if ((p.col + p.floor) % 2) continue;
      this.slots.push({ panel: p, occupant: null });
    }
    this.garrisonCap = Math.min(this.slots.length, 24);
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
        if (near && p.floor >= this.floors - 2) p.state = 3;
      }
      this.collapsedCorner = side;
    }
  }
  // Pancake a vertical slice of the building (all floors) between cols a..b.
  pancake(a, b) {
    for (const p of this.panels) if ((p.side === 'front' || p.side === 'back') && p.col >= a && p.col <= b) { p.state = 3; if (p.floor > 0) p.gone = true; }
    this.pancaked = [a, b];
  }
  requestKit(pool) {
    for (const p of this.panels) for (const s of STATES) pool.request(`${p.type}_${s}`);
    for (const p of this.panels) if (p.balcony) pool.request('balcony_slab');
    for (const p of this.panels) if (p.entrance) pool.request('entrance_canopy');
    pool.request('roof_parapet', 2 * this.modules + 2 * this.depthModules);
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
      p.color = col.clone();
      pool.add(`${p.type}_${STATES[p.state]}`, this.panelMatrix(p, tmpM), p, p.color);
      if (p.balcony && p.state < 2) { p.acc = { slot: -1 }; pool.add('balcony_slab', tmpM, p.acc, p.color); }
      if (p.entrance) {
        p.acc = { slot: -1 }; const m2 = tmpM.clone(); m2.multiply(new THREE.Matrix4().makeTranslation(0, this.kit.H * 0.8, 0));
        pool.add('entrance_canopy', m2, p.acc, p.color);
      }
    }
    // roof parapets
    const { W, H } = this.kit, top = this.floors * H;
    this.parapets = [];
    const addPar = (lx, lz, rot) => { const o = { slot: -1 }; this.toWorld(lx, top, lz, tmpV); tmpQ.setFromAxisAngle(Y, this.rot + rot); tmpM.compose(tmpV, tmpQ, tmpS); pool.add('roof_parapet', tmpM, o, this.tint); this.parapets.push(o); };
    for (let c = 0; c < this.modules; c++) {
      if (!this.isDestroyedTop('front', c)) addPar(-this.L / 2 + c * W, this.D / 2, 0);
      if (!this.isDestroyedTop('back', c)) addPar(-this.L / 2 + (c + 1) * W, -this.D / 2, Math.PI);
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
      tmpM.compose(tmpV, tmpQ, tmpS.set(W, 0.22, D - 0.2)); slabMesh.setMatrixAt(counters.slab++, tmpM);
      this.toWorld(cx, f * H + H / 2, 0, tmpV);
      tmpM.compose(tmpV, tmpQ, tmpS.set(W - 0.02, H - 0.24, D - inset * 2)); darkMesh.setMatrixAt(counters.dark++, tmpM);
      tmpS.set(1, 1, 1);
    }
    // roof, per module column (missing over collapsed parts)
    for (let c = 0; c < this.modules; c++) {
      const gone = this.pancaked && c >= this.pancaked[0] && c <= this.pancaked[1];
      const corner = this.collapsedCorner && (this.collapsedCorner === 'right' ? c >= this.modules - 2 : c <= 1);
      if (gone || corner) continue;
      this.toWorld(-this.L / 2 + (c + 0.5) * W, this.floors * H + 0.05, 0, tmpV); tmpQ.setFromAxisAngle(Y, this.rot);
      tmpM.compose(tmpV, tmpQ, tmpS.set(W + 0.01, 0.3, this.D)); counters.roofs.push(tmpM.clone()); tmpS.set(1, 1, 1);
    }
  }
  setGone(p) {
    if (p.gone) return false;
    if (p.slot >= 0) this.pool.remove(`${p.type}_${STATES[p.state]}`, p);
    if (p.acc && p.acc.slot >= 0) this.pool.remove(p.balcony ? 'balcony_slab' : 'entrance_canopy', p.acc);
    p.gone = true; p.state = 3; return true;
  }
  setState(p, s) {
    if (p.gone || s <= p.state) return false;
    this.pool.remove(`${p.type}_${STATES[p.state]}`, p);
    p.state = Math.min(3, s);
    this.pool.add(`${p.type}_${STATES[p.state]}`, this.panelMatrix(p, tmpM), p, p.color);
    if (p.balcony && p.acc && p.state >= 2 && p.acc.slot >= 0) this.pool.remove('balcony_slab', p.acc);
    return true;
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
