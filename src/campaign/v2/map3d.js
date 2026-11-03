// Campaign v2 strategic screen — the 3D map (own renderer). Two layers:
//   THEATRE: the whole front, faded: dark ground, rivers, Russian-occupied area and the historical front line for the
//            current date (animated when the date changes), city / oblast / river labels.
//   AOR:     the brigade's area of responsibility in detail: season-tinted fields with windbreaks, woods, balkas,
//            rivers, roads and streets (OpenStreetMap extracts where available), small 3D towns, villages and
//            industrial blocks (real OSM footprints where available, procedural elsewhere), the grid (owner tint,
//            front line, fortifications, supply), NATO task-force tokens, enemy strength, objectives, enemy attack
//            arrows and the move / attack path preview.
// Camera: pan (WASD / arrows / drag / screen edge), zoom (wheel, towards the cursor), rotate (Q/E, middle or
// right-drag), all smoothed. Map data © OpenStreetMap contributors (ODbL).
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { atDate } from './state.js';

export const COL = { own: '#4f8fe0', enemy: '#e0503f', contested: '#e0a33a', accent: '#d8b25a', front: '#f2e6c4', water: '#41606e' };
const KY = 110.57, KX = lat => 111.32 * Math.cos(lat * Math.PI / 180);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
function rng(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hash = s => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
const VEX = 2.6, HEX = 1.6;   // building height / footprint exaggeration so towns read on the strategic map

// season palettes for the fields (Feb 2023 is late winter; the counteroffensive runs through high summer)
function season(date) {
  const m = +String(date).slice(5, 7);
  if (m === 12 || m <= 2) return { base: '#77786c', fields: ['#86887b', '#7a7c6f', '#919285', '#6f7064', '#8d8a7c'], tree: '#3c4033', wood: '#363b2f', name: 'winter' };
  if (m <= 4) return { base: '#5d5a42', fields: ['#655f45', '#56583d', '#6e6648', '#4d5236', '#5f6a3e'], tree: '#33402a', wood: '#2e3a26', name: 'spring' };
  if (m <= 6) return { base: '#56643a', fields: ['#5d6c3c', '#6a733f', '#4f6034', '#7a7845', '#617043'], tree: '#2c4024', wood: '#273a21', name: 'summer' };
  if (m <= 8) return { base: '#857a4a', fields: ['#9a8c52', '#8a7f4a', '#a4945a', '#6f6e40', '#958653'], tree: '#33432a', wood: '#2c3d25', name: 'harvest' };
  return { base: '#675c41', fields: ['#6f6244', '#5f5a3e', '#7a6a48', '#58553b', '#6a5f40'], tree: '#3d3e2c', wood: '#363727', name: 'autumn' };
}

export class StrategicMap {
  constructor(container, C, osm = null, geo = null) {
    this.C = C; this.def = C.def; this.osm = osm; this.geo = geo?.geo || geo; this.el = container;
    this.on = {}; this.sel = null; this.hover = null; this.reachSet = null; this.showSupply = false; this.path = null;
    const A = this.def.aor, [latS, lonW, latN, lonE] = A.bbox;
    this.lat0 = (latS + latN) / 2; this.lon0 = (lonW + lonE) / 2; this.kx = KX(this.lat0);
    this.x0 = this.X(lonW); this.x1 = this.X(lonE); this.z0 = this.Z(latN); this.z1 = this.Z(latS);
    this.cw = (this.x1 - this.x0) / A.cols; this.ch = (this.z1 - this.z0) / A.rows;
    // renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement; this.canvas.className = 'c2-canvas'; container.appendChild(this.canvas);
    this.labels = document.createElement('div'); this.labels.className = 'c2-labels'; container.appendChild(this.labels);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#0e0f0d');
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 5000);
    this.scene.add(new THREE.HemisphereLight('#dfe6f0', '#3a3a30', 1.6));
    const sun = new THREE.DirectionalLight('#fff2dc', 1.9); sun.position.set(-0.6, 1, 0.4); this.scene.add(sun);
    this.lineMats = [];
    this.buildTheatre(); this.buildAor(); this.buildBuildings(); this.buildOverlay(); this.buildDynamic();
    // camera state (target on the ground, distance in km, yaw, pitch = elevation angle)
    const c = this.aorCenter();
    this.cam = { x: c.x, z: c.z, dist: 26, yaw: 0.18, pitch: 0.92 };
    this.tcam = { ...this.cam };
    this.keys = new Set(); this.mouse = { x: -1, y: -1, in: false };
    this.bindInput();
    this.resize(); this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(container);
    this.setDate(C.date, false);
    this.refresh();
    this.t0 = performance.now(); this.last = this.t0; this.anims ||= [];
    const loop = now => { if (this.dead) return; this.raf = requestAnimationFrame(loop); this.frame(Math.min(0.1, (now - this.last) / 1000), now); this.last = now; };
    this.raf = requestAnimationFrame(loop);
  }
  // ------------------------------------------------------------------ projection (km, x east, z south)
  X(lon) { return (lon - this.lon0) * this.kx; }
  Z(lat) { return -(lat - this.lat0) * KY; }
  V(ll, y = 0) { return new THREE.Vector3(this.X(ll[1]), y, this.Z(ll[0])); }
  cellCenter(id) { const c = this.C.cell(id); return new THREE.Vector3(this.x0 + (c.col + 0.5) * this.cw, 0, this.z0 + (c.row + 0.5) * this.ch); }
  cellAtWorld(x, z) { const col = Math.floor((x - this.x0) / this.cw), row = Math.floor((z - this.z0) / this.ch); return this.C.cellAt(col, row)?.id || null; }
  // screen position (CSS px, relative to the viewport) of a cell centre or a world point; null if behind the camera
  screenOf(id, y = 0) { const p = typeof id === 'string' ? this.cellCenter(id) : id.clone(); p.y = y; this.updateCamera(); p.project(this.camera); if (p.z > 1) return null; const r = this.canvas.getBoundingClientRect(); return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height }; }
  aorCenter() { return { x: (this.x0 + this.x1) / 2, z: (this.z0 + this.z1) / 2 }; }
  // ------------------------------------------------------------------ theatre
  buildTheatre() {
    const T = this.def.theatre, [tS, tW, tN, tE] = T.bbox || [this.lat0 - 2, this.lon0 - 3, this.lat0 + 2, this.lon0 + 3];
    const x0 = this.X(tW), x1 = this.X(tE), z0 = this.Z(tN), z1 = this.Z(tS); this.tb = { x0, x1, z0, z1 };
    const W = 2048, H = Math.round(W * (z1 - z0) / (x1 - x0));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d');
    const P = ([la, lo]) => [(this.X(lo) - x0) / (x1 - x0) * W, (this.Z(la) - z0) / (z1 - z0) * H];
    const grd = g.createRadialGradient(W * 0.5, H * 0.5, 50, W * 0.5, H * 0.5, W * 0.8); grd.addColorStop(0, '#22251e'); grd.addColorStop(1, '#151612');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    // faint 50 km grid
    g.strokeStyle = 'rgba(232,228,216,0.045)'; g.lineWidth = 1; const pxKm = W / (x1 - x0);
    for (let x = Math.ceil(x0 / 50) * 50; x < x1; x += 50) { g.beginPath(); g.moveTo((x - x0) * pxKm, 0); g.lineTo((x - x0) * pxKm, H); g.stroke(); }
    for (let z = Math.ceil(z0 / 50) * 50; z < z1; z += 50) { g.beginPath(); g.moveTo(0, (z - z0) * pxKm); g.lineTo(W, (z - z0) * pxKm); g.stroke(); }
    // speckle (terrain texture)
    const R = rng(3); for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(${R() < 0.5 ? '255,250,230' : '0,0,0'},${0.02 + R() * 0.03})`; g.fillRect(R() * W, R() * H, 1 + R() * 3, 1 + R() * 3); }
    for (const r of T.rivers || []) { g.strokeStyle = '#2f4650'; g.lineWidth = (r.w || 1.4) * 2.2; g.lineJoin = g.lineCap = 'round'; g.beginPath(); r.pts.forEach((p, i) => { const [a, b] = P(p); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.stroke(); }
    for (const r of T.roads || []) { g.strokeStyle = 'rgba(200,190,160,0.12)'; g.lineWidth = 1.5; g.beginPath(); (r.pts || r).forEach((p, i) => { const [a, b] = P(p); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.stroke(); }
    for (const l of T.labels || []) if (l.kind === 'city') { const [a, b] = P(l.latlon); g.fillStyle = 'rgba(232,228,216,0.35)'; g.beginPath(); g.arc(a, b, 3, 0, 7); g.fill(); }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshBasicMaterial({ map: tex }));
    m.rotation.x = -Math.PI / 2; m.position.set((x0 + x1) / 2, -0.05, (z0 + z1) / 2); this.scene.add(m);
    // occupied area + front line (updated by setDate)
    this.occMat = new THREE.MeshBasicMaterial({ color: '#7a2a22', transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });
    this.occMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.occMat); this.occMesh.position.y = -0.03; this.scene.add(this.occMesh);
    this.frontMat = this.lineMat('#e0503f', 2.6, 0.95); this.frontGlowMat = this.lineMat('#e0503f', 9, 0.18);
    this.frontLine = null; this.frontGlow = null;
    // the AOR's outline on the theatre
    const o = [[this.x0, this.z0], [this.x1, this.z0], [this.x1, this.z1], [this.x0, this.z1], [this.x0, this.z0]];
    const lg = new LineGeometry(); lg.setPositions(o.flatMap(([x, z]) => [x, 0.02, z]));
    const ol = new Line2(lg, this.lineMat(COL.accent, 2, 0.9)); this.scene.add(ol);
    // HTML labels
    // (decluttered on screen: listed order = priority, cities before rivers before oblast names)
    const kr = { city: 0, river: 1, oblast: 2 };
    this.tLabels = (T.labels || []).map((l, i) => this.label(this.V(l.latlon), l.text, `c2-tl c2-tl-${l.kind || 'city'}`, { kind: l.kind, prio: (kr[l.kind || 'city'] ?? 1) * 1000 + i, ...(l.kind === 'oblast' || l.kind === 'river' ? { ax: 0.5, ay: 0.5 } : { ax: 0, dx: 6, ay: 0.5 }) })).sort((a, b) => a.prio - b.prio);
  }
  lineMat(color, width, opacity = 1, dashed = false) { const m = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, dashed, dashSize: 0.3, gapSize: 0.2, depthTest: false }); this.lineMats.push(m); return m; }
  // front line for a date: lines resampled to the same point count so they can be interpolated
  frontFor(date) { const F = this.def.theatre.fronts || []; const e = atDate(F, date); return e ? resample(e.line.map(p => [this.X(p[1]), this.Z(p[0])]), 240) : null; }
  setDate(date, animate = true) {
    const to = this.frontFor(date); if (!to) return;
    const from = this.frontNow || to;
    if (!animate || !this.frontNow) { this.applyFront(to); return; }
    this.anims.push({ t: 0, dur: 2.2, step: k => this.applyFront(from.map((p, i) => [lerp(p[0], to[i][0], k), lerp(p[1], to[i][1], k)])) });
  }
  applyFront(pts) {
    this.frontNow = pts;
    // segments inside the AOR are left out: there the grid's own front line is the truth
    const inA = (x, z) => x > this.x0 - 0.3 && x < this.x1 + 0.3 && z > this.z0 - 0.3 && z < this.z1 + 0.3, seg = [];
    for (let i = 1; i < pts.length; i++) { const [ax, az] = pts[i - 1], [bx, bz] = pts[i]; if (inA(ax, az) && inA(bx, bz)) continue; seg.push(ax, 0.03, az, bx, 0.03, bz); }
    if (!seg.length) seg.push(0, -1, 0, 0, -1, 0);
    if (this.frontLine) { this.scene.remove(this.frontLine, this.frontGlow); this.frontLine.geometry.dispose(); this.frontGlow.geometry.dispose(); }
    const g1 = new LineSegmentsGeometry(); g1.setPositions(seg); const g2 = new LineSegmentsGeometry(); g2.setPositions(seg);
    this.frontLine = new LineSegments2(g1, this.frontMat); this.frontGlow = new LineSegments2(g2, this.frontGlowMat); this.frontLine.renderOrder = 3; this.scene.add(this.frontGlow, this.frontLine);
    // occupied polygon: close the line along the theatre border on the side that holds the Russian-held reference point
    const ref = this.ruRef(); const poly = occupiedPoly(pts, this.tb, ref);
    if (poly) { const sh = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z))); const g = new THREE.ShapeGeometry(sh); g.rotateX(-Math.PI / 2); this.occMesh.geometry.dispose(); this.occMesh.geometry = g; }
  }
  ruRef() {
    const ruOwner = this.C.side === 'RU' ? 'player' : 'enemy';
    const c = this.def.aor.cells.find(x => this.C.owner[x.id] === ruOwner && !this.C.frontline(x.id)) || this.def.aor.cells.find(x => this.C.owner[x.id] === ruOwner);
    return c ? [this.cellCenter(c.id).x, this.cellCenter(c.id).z] : [this.tb.x1, this.tb.z1];
  }
  // ------------------------------------------------------------------ AOR ground (canvas texture, redrawn per season)
  buildAor() {
    const W = 2048, H = Math.round(W * (this.z1 - this.z0) / (this.x1 - this.x0));
    this.gW = W; this.gH = H;
    this.groundCv = document.createElement('canvas'); this.groundCv.width = W; this.groundCv.height = H;
    this.groundTex = new THREE.CanvasTexture(this.groundCv); this.groundTex.colorSpace = THREE.SRGBColorSpace; this.groundTex.anisotropy = 8;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(this.x1 - this.x0, this.z1 - this.z0), new THREE.MeshLambertMaterial({ map: this.groundTex }));
    m.rotation.x = -Math.PI / 2; m.position.set((this.x0 + this.x1) / 2, 0, (this.z0 + this.z1) / 2); this.scene.add(m); this.ground = m;
    // soft dark rim so the AOR reads as the lit, detailed area of the map
    const rim = new THREE.Mesh(new THREE.PlaneGeometry(this.x1 - this.x0 + 8, this.z1 - this.z0 + 8), new THREE.MeshBasicMaterial({ map: rimTexture(), transparent: true, depthWrite: false }));
    rim.rotation.x = -Math.PI / 2; rim.position.set((this.x0 + this.x1) / 2, -0.02, (this.z0 + this.z1) / 2); this.scene.add(rim);
    this.windbreaks = []; this.paintGround();
  }
  gP(lat, lon) { return [(this.X(lon) - this.x0) / (this.x1 - this.x0) * this.gW, (this.Z(lat) - this.z0) / (this.z1 - this.z0) * this.gH]; }
  paintGround() {
    const sea = season(this.C.date); if (this.season === sea.name) return; this.season = sea.name;
    const g = this.groundCv.getContext('2d'), W = this.gW, H = this.gH, kmPx = W / (this.x1 - this.x0), R = rng(17);
    const G = this.geo, keepBreaks = !this.windbreaks.length && !G?.woods?.length, drawBreaks = !G?.woods?.length;
    g.fillStyle = sea.base; g.fillRect(0, 0, W, H);
    // field patchwork on a rotated grid (~0.7 x 1.4 km blocks) with windbreak tree belts on many of the edges
    const ang = -0.32, ca = Math.cos(ang), sa = Math.sin(ang), fw = 0.7 * kmPx, fh = 1.35 * kmPx, D = Math.hypot(W, H);
    g.save(); g.translate(W / 2, H / 2); g.rotate(ang);
    for (let i = -Math.ceil(D / fw / 2); i <= D / fw / 2; i++) for (let j = -Math.ceil(D / fh / 2); j <= D / fh / 2; j++) {
      const x = i * fw, y = j * fh, split = R() < 0.35;
      g.fillStyle = sea.fields[Math.floor(R() * sea.fields.length)]; g.fillRect(x, y, split ? fw / 2 : fw, fh);
      if (split) { g.fillStyle = sea.fields[Math.floor(R() * sea.fields.length)]; g.fillRect(x + fw / 2, y, fw / 2, fh); }
      // furrow texture
      g.strokeStyle = 'rgba(0,0,0,0.05)'; g.lineWidth = 1; for (let k = 3; k < fw; k += 5) { g.beginPath(); g.moveTo(x + k, y); g.lineTo(x + k, y + fh); g.stroke(); }
      for (const [ax, ay, bx, by, p] of [[x, y, x + fw, y, 0.55], [x, y, x, y + fh, 0.35]]) if (R() < p && drawBreaks) {
        g.strokeStyle = sea.tree; g.lineWidth = 2.6; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
        if (keepBreaks) { const w = (px, py) => [this.x0 + (W / 2 + px * ca - py * sa) / kmPx, this.z0 + (H / 2 + px * sa + py * ca) / kmPx]; this.windbreaks.push([...w(ax, ay), ...w(bx, by)]); }
      }
    }
    g.restore();
    const cells = this.def.aor.cells, cpx = this.cw * kmPx, cpy = this.ch * kmPx;
    const cellPx = c => [(c.col) * cpx, (c.row) * cpy];
    for (const c of cells) {
      const [px, py] = cellPx(c), r = rng(hash(c.id));
      if (c.terrain === 'forest' && !G?.woods?.length) { g.fillStyle = sea.wood; for (let k = 0; k < 26; k++) { g.beginPath(); g.ellipse(px + cpx * (0.15 + r() * 0.7), py + cpy * (0.15 + r() * 0.7), cpx * (0.06 + r() * 0.12), cpy * (0.05 + r() * 0.1), r() * 3, 0, 7); g.fill(); } }
      if (c.terrain === 'balka') { g.strokeStyle = 'rgba(30,38,24,0.75)'; g.lineWidth = cpx * 0.09; g.lineCap = 'round'; g.beginPath(); let x = px, y = py + cpy * (0.3 + r() * 0.4); g.moveTo(x, y); for (let k = 1; k <= 6; k++) { x = px + cpx * k / 6; y += (r() - 0.5) * cpy * 0.25; g.lineTo(x, y); } g.stroke(); g.strokeStyle = sea.wood; g.lineWidth = cpx * 0.035; g.stroke(); }
      if (c.terrain === 'heights') { for (let k = 4; k >= 1; k--) { g.strokeStyle = `rgba(255,248,220,${0.05 + 0.03 * (4 - k)})`; g.lineWidth = 2; g.beginPath(); g.ellipse(px + cpx / 2, py + cpy / 2, cpx * 0.12 * k, cpy * 0.09 * k, 0.3, 0, 7); g.stroke(); } }
      if (c.terrain === 'water') { g.fillStyle = COL.water; g.fillRect(px, py, cpx, cpy); }
    }
    const O = this.osm, line = (pts, close = false) => { g.beginPath(); pts.forEach((p, i) => { const [a, b] = this.gP(p[0], p[1]); i ? g.lineTo(a, b) : g.moveTo(a, b); }); if (close) g.closePath(); };
    if (O) {
      g.fillStyle = sea.wood; for (const w of O.woods || []) { line(w, true); g.fill(); }
      g.fillStyle = COL.water; for (const w of O.water || []) { line(w, true); g.fill(); }
      g.strokeStyle = sea.tree; g.lineWidth = 3; g.lineCap = 'round'; for (const t of O.treeRows || []) { line(t); g.stroke(); }
    }
    if (G) {   // the AOR extract: woods and tree belts, water, built-up areas
      g.fillStyle = sea.wood; for (const w of G.woods || []) { line(w, true); g.fill(); }
      g.fillStyle = COL.water; for (const w of G.water || []) { line(w, true); g.fill(); }
      g.fillStyle = 'rgba(122,118,104,0.6)'; for (const w of G.built || []) { line(w, true); g.fill(); }
    }
    // settlement ground (yards and gardens) under the towns
    if (!G?.built?.length) for (const c of cells) if (c.settlement) { const [a, b] = this.gP(...(c.settlement.latlon || c.latlon)), s = c.settlement.size || 1, rr = (0.25 + s * 0.17) * kmPx;
      const gr = g.createRadialGradient(a, b, rr * 0.2, a, b, rr); gr.addColorStop(0, 'rgba(120,118,102,0.55)'); gr.addColorStop(1, 'rgba(120,118,102,0)'); g.fillStyle = gr; g.beginPath(); g.ellipse(a, b, rr * 1.2, rr, 0.4, 0, 7); g.fill(); }
    // rivers, streets, roads, rail
    g.lineJoin = g.lineCap = 'round';
    for (const c of cells) if (c.river && !(O?.rivers?.length)) { const [px, py] = cellPx(c); g.strokeStyle = COL.water; g.lineWidth = 6; g.beginPath(); g.moveTo(px, py + cpy / 2); g.lineTo(px + cpx, py + cpy / 2); g.stroke(); }
    if (G) {
      g.strokeStyle = COL.water; g.lineWidth = 1.6; for (const r of G.streams || []) { line(r.pts); g.stroke(); }
      g.lineWidth = 5.5; for (const r of G.rivers || []) { line(r.pts); g.stroke(); }
      g.strokeStyle = 'rgba(70,64,52,0.9)'; g.lineWidth = 2.5; g.setLineDash([7, 5]); for (const r of G.rail || []) { if (r.state === 'abandoned') continue; line(r.pts); g.stroke(); } g.setLineDash([]);
      g.strokeStyle = 'rgba(190,180,150,0.45)'; g.lineWidth = 1.1; for (const r of G.minor || []) { line(r.pts); g.stroke(); }
      if (O) for (const st of O.streets || []) { g.strokeStyle = st.k >= 2 ? '#a69e88' : 'rgba(170,162,140,0.75)'; g.lineWidth = st.k >= 2 ? 2 : 1.2; line(st.p); g.stroke(); }
      for (const pass of [0, 1]) for (const r of G.roads || []) { const hw = r.kind === 'highway'; g.strokeStyle = pass ? (hw ? '#d9cfb2' : '#bdb49a') : 'rgba(30,28,22,0.7)'; g.lineWidth = (hw ? 4.5 : 3) + (pass ? 0 : 2.5); line(r.pts); g.stroke(); }
      // real field fortifications (anti-tank ditches, trench lines) and bunkers
      for (const f of G.forts || []) { g.strokeStyle = 'rgba(28,22,15,0.9)'; g.lineWidth = f.kind === 'trench' ? 2.2 : 3; line(f.pts); g.stroke(); g.strokeStyle = 'rgba(200,180,140,0.35)'; g.lineWidth = 0.8; g.stroke(); }
      g.fillStyle = 'rgba(28,22,15,0.95)'; for (const b of G.bunkers || []) { const [a, c] = this.gP(b[0], b[1]); g.fillRect(a - 2, c - 2, 4, 4); }
    } else if (O) {
      for (const r of O.rivers || []) { g.strokeStyle = COL.water; g.lineWidth = r.small ? 2.5 : 6; line(r.p); g.stroke(); }
      g.strokeStyle = 'rgba(70,64,52,0.9)'; g.lineWidth = 3; g.setLineDash([7, 5]); for (const r of O.rail || []) { line(r); g.stroke(); } g.setLineDash([]);
      for (const s of O.streets || []) { g.strokeStyle = s.k >= 2 ? '#a69e88' : 'rgba(170,162,140,0.75)'; g.lineWidth = s.k >= 2 ? 2 : 1.2; line(s.p); g.stroke(); }
      for (const pass of [0, 1]) for (const r of O.roads || []) { g.strokeStyle = pass ? (r.k >= 3 ? '#d9cfb2' : '#bdb49a') : 'rgba(30,28,22,0.7)'; g.lineWidth = (r.k >= 3 ? 4.5 : 3) + (pass ? 0 : 2.5); line(r.p); g.stroke(); }
    } else {   // cell roads only
      for (const c of cells) if (c.road) for (const n of this.C.neighbors(c.id)) { const d = this.C.cell(n); if (!d.road || (d.col !== c.col && d.row !== c.row)) continue; g.strokeStyle = c.road === 2 && d.road === 2 ? '#d9cfb2' : '#b0a78e'; g.lineWidth = c.road === 2 && d.road === 2 ? 4 : 2.5; g.beginPath(); g.moveTo((c.col + 0.5) * cpx, (c.row + 0.5) * cpy); g.lineTo((d.col + 0.5) * cpx, (d.row + 0.5) * cpy); g.stroke(); }
    }
    this.groundTex.needsUpdate = true;
  }
  // ------------------------------------------------------------------ 3D settlements and trees
  buildBuildings() {
    const A = this.def.aor, [latS, lonW, latN, lonE] = A.bbox, inAor = (la, lo) => la >= latS && la <= latN && lo >= lonW && lo <= lonE;
    const list = [];   // [x, z, w(km), d(km), angle, h(km), kind, cellId]
    // water mask (reservoirs, ponds): no procedural houses or trees standing in the water
    const wet = [...(this.osm?.water || []), ...(this.geo?.water || [])].map(w => { const pts = w.map(p => [this.X(p[1]), this.Z(p[0])]), xs = pts.map(p => p[0]), zs = pts.map(p => p[1]); return { pts, x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) }; });
    const inWater = (x, z) => wet.some(w => x >= w.x0 && x <= w.x1 && z >= w.z0 && z <= w.z1 && pip([x, z], w.pts));
    for (const b of this.osm?.buildings || []) if (inAor(b[0], b[1])) list.push([this.X(b[1]), this.Z(b[0]), b[2] / 1000, b[3] / 1000, b[4], b[5] / 1000, b[6]]);
    // procedural towns where the OSM extracts have no footprints
    // procedural fill where the OSM footprints are missing or sparse (the extracts cover patches only)
    const osmN = list.length, grid = new Map(), key = (x, z) => `${Math.floor(x / 0.05)},${Math.floor(z / 0.05)}`;
    for (const b of list) { const k = key(b[0], b[1]); (grid.get(k) || grid.set(k, []).get(k)).push(b); }
    const crowded = (x, z) => { for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const b of grid.get(`${Math.floor(x / 0.05) + i},${Math.floor(z / 0.05) + j}`) || []) if (Math.hypot(b[0] - x, b[1] - z) < 0.03) return true; return false; };
    for (const c of A.cells) {
      const s = c.settlement; if (!s) continue; const p = this.V(s.latlon || c.latlon), r = 0.25 + (s.size || 1) * 0.2;
      let have = 0; for (let i = 0; i < osmN; i++) if (Math.abs(list[i][0] - p.x) < r && Math.abs(list[i][1] - p.z) < r) have++;
      const want = { hamlet: 25, village: 45, town: 90, industrial: 15 }[s.kind] * (s.size || 1);
      if (have >= want * 0.7) continue;
      const extra = []; procTown(extra, p.x, p.z, s, rng(hash(c.id + s.name)));
      for (const b of extra) if (!crowded(b[0], b[1]) && !inWater(b[0], b[1])) list.push(b);
    }
    this.buildingList = list;
    const body = new THREE.BoxGeometry(1, 1, 1); body.translate(0, 0.5, 0);
    const roof = prism(); const mat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    const N = list.length, houses = list.filter(b => b[6] === 0).length;
    const IB = new THREE.InstancedMesh(body, mat, Math.max(1, N)), IR = new THREE.InstancedMesh(roof, new THREE.MeshLambertMaterial({ color: '#ffffff', side: THREE.DoubleSide }), Math.max(1, houses));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    const R = rng(5); let ir = 0;
    const WALL = ['#d9d3c2', '#cfc7b1', '#e2dccb', '#c4bca6', '#d7cdb4'], ROOF = ['#7a5244', '#5d6468', '#8a6a4a', '#6b4a3c', '#566056', '#7c7e80'], BLOCK = ['#bdb8ac', '#aaa69b', '#c7c2b5'], IND = ['#8d8a82', '#7e7c76', '#9a958a'];
    list.forEach((b, i) => {
      let [x, z, w, d, a, h, k] = b; h = Math.max(0.003, h) * VEX;
      const bh = k === 0 ? h * 0.62 : h;
      w *= HEX; d *= HEX; q.setFromAxisAngle(up, a); p.set(x, 0, z); s.set(w, bh, d); m.compose(p, q, s); IB.setMatrixAt(i, m);
      IB.setColorAt(i, col.set((k === 0 ? WALL : k === 1 ? BLOCK : IND)[Math.floor(R() * 3)]));
      if (k === 0) { const sw = w >= d; q.setFromAxisAngle(up, a + (sw ? 0 : Math.PI / 2)); p.set(x, bh, z); s.set(sw ? w : d, h * 0.45, sw ? d : w); m.compose(p, q, s); IR.setMatrixAt(ir, m); IR.setColorAt(ir, col.set(ROOF[Math.floor(R() * ROOF.length)])); ir++; }
    });
    IR.count = ir; this.scene.add(IB, IR); this.bMesh = IB;
    // trees: OSM tree rows and woods, procedural windbreaks and forest cells
    const trees = [], RT = rng(9), add = (x, z) => { if (trees.length < 18000 && !inWater(x, z)) trees.push([x, z, 0.6 + RT() * 0.7]); };
    const along = (ax, az, bx, bz, step) => { const L = Math.hypot(bx - ax, bz - az), n = Math.floor(L / step); for (let i = 0; i <= n; i++) add(lerp(ax, bx, i / Math.max(1, n)) + (RT() - 0.5) * 0.01, lerp(az, bz, i / Math.max(1, n)) + (RT() - 0.5) * 0.01); };
    const inside = (x, z) => x > this.x0 && x < this.x1 && z > this.z0 && z < this.z1;
    for (const t of this.osm?.treeRows || []) for (let i = 1; i < t.length; i++) along(this.X(t[i - 1][1]), this.Z(t[i - 1][0]), this.X(t[i][1]), this.Z(t[i][0]), 0.03);
    for (const w of this.osm?.woods || []) { const pts = w.map(p => [this.X(p[1]), this.Z(p[0])]); const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]); const bx0 = Math.min(...xs), bx1 = Math.max(...xs), bz0 = Math.min(...zs), bz1 = Math.max(...zs); const n = Math.min(400, Math.ceil((bx1 - bx0) * (bz1 - bz0) / 0.0016)); for (let i = 0; i < n; i++) { const x = lerp(bx0, bx1, RT()), z = lerp(bz0, bz1, RT()); if (pip([x, z], pts)) add(x, z); } }
    // woods and tree belts of the AOR extract (sampled, densest first: belts are thin and long)
    for (const w of this.geo?.woods || []) { if (trees.length >= 18000) break; const pts = w.map(p => [this.X(p[1]), this.Z(p[0])]); const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]); const bx0 = Math.min(...xs), bx1 = Math.max(...xs), bz0 = Math.min(...zs), bz1 = Math.max(...zs); const area = (bx1 - bx0) * (bz1 - bz0), n = Math.min(260, Math.ceil(area / 0.0012)); let got = 0; for (let i = 0; i < n * 3 && got < n; i++) { const x = lerp(bx0, bx1, RT()), z = lerp(bz0, bz1, RT()); if (pip([x, z], pts)) { add(x, z); got++; } } }
    for (const [ax, az, bx, bz] of this.windbreaks) { if (!inside(ax, az) && !inside(bx, bz)) continue; along(ax, az, bx, bz, 0.038); }
    for (const c of A.cells) if (c.terrain === 'forest' || c.terrain === 'balka') { const cc = this.cellCenter(c.id), r = rng(hash(c.id)); for (let i = 0; i < 160; i++) add(cc.x + (r() - 0.5) * this.cw * 0.8, cc.z + (r() - 0.5) * this.ch * (c.terrain === 'balka' ? 0.3 : 0.8)); }
    const tg = new THREE.OctahedronGeometry(0.011, 0); tg.scale(1, 1.3, 1); tg.translate(0, 0.012, 0);
    const IT = new THREE.InstancedMesh(tg, new THREE.MeshLambertMaterial({ color: '#ffffff' }), Math.max(1, trees.length));
    trees.forEach(([x, z, k], i) => { if (!inside(x, z)) { m.makeScale(0, 0, 0); IT.setMatrixAt(i, m); return; } p.set(x, 0, z); s.set(k, k * 1.6, k); q.identity(); m.compose(p, q, s); IT.setMatrixAt(i, m); IT.setColorAt(i, col.set(this.treeColor(RT()))); });
    this.trees = IT; this.scene.add(IT);
  }
  treeColor(r) { const sea = season(this.C.date).name; const pal = sea === 'winter' ? ['#4a4d40', '#555848', '#3f4236'] : sea === 'autumn' ? ['#6a5a32', '#5a5030', '#4a5030'] : sea === 'harvest' ? ['#3d5230', '#4a5a34', '#34482a'] : ['#355a2a', '#3e6630', '#2f4f26']; return pal[Math.floor(r * pal.length)]; }
  // ------------------------------------------------------------------ grid overlay (owner tint, front, forts, supply, craters)
  buildOverlay() {
    const W = 2048, H = Math.round(W * (this.z1 - this.z0) / (this.x1 - this.x0));
    this.ovCv = document.createElement('canvas'); this.ovCv.width = W; this.ovCv.height = H;
    this.ovTex = new THREE.CanvasTexture(this.ovCv); this.ovTex.colorSpace = THREE.SRGBColorSpace; this.ovTex.anisotropy = 8;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(this.x1 - this.x0, this.z1 - this.z0), new THREE.MeshBasicMaterial({ map: this.ovTex, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set((this.x0 + this.x1) / 2, 0.004, (this.z0 + this.z1) / 2); m.renderOrder = 1; this.scene.add(m);
    // highlight layer (reach / hover / selection), cheap to redraw
    const A = this.def.aor; this.hlCv = document.createElement('canvas'); this.hlCv.width = A.cols * 48; this.hlCv.height = A.rows * 48;
    this.hlTex = new THREE.CanvasTexture(this.hlCv); this.hlTex.colorSpace = THREE.SRGBColorSpace;
    const h = new THREE.Mesh(new THREE.PlaneGeometry(this.x1 - this.x0, this.z1 - this.z0), new THREE.MeshBasicMaterial({ map: this.hlTex, transparent: true, depthWrite: false }));
    h.rotation.x = -Math.PI / 2; h.position.set((this.x0 + this.x1) / 2, 0.006, (this.z0 + this.z1) / 2); h.renderOrder = 2; this.scene.add(h);
    this.cellFrontMat = this.lineMat(COL.front, 3.2, 0.95); this.cellFrontGlow = this.lineMat(COL.enemy, 10, 0.22);
  }
  paintOverlay() {
    const C = this.C, A = this.def.aor, g = this.ovCv.getContext('2d'), W = this.ovCv.width, H = this.ovCv.height, cx = W / A.cols, cy = H / A.rows;
    g.clearRect(0, 0, W, H);
    for (const c of A.cells) {
      const o = C.owner[c.id], x = c.col * cx, y = c.row * cy, known = C.known(c.id);
      // closed squares (beyond the AOR so far): a dark veil; squares that just opened fade in (refresh -> this.fade)
      if (C.isOpen && !C.isOpen(c.id)) { g.fillStyle = 'rgba(9,10,8,0.8)'; g.fillRect(x, y, cx, cy); hatch(g, x, y, cx, cy, 'rgba(232,228,216,0.05)', 22); continue; }
      const fading = this.fade?.cells.has(c.id) ? 1 - this.fade.k : 0;
      if (o === 'player') { g.fillStyle = 'rgba(79,143,224,0.13)'; g.fillRect(x, y, cx, cy); if (this.showSupply || (C.supplied[c.id] ?? 1) < 1) { const s = C.supplied[c.id] ?? 0; if (this.showSupply) { g.fillStyle = s >= 1 ? 'rgba(143,176,105,0.22)' : s > 0 ? 'rgba(224,163,58,0.25)' : 'rgba(224,80,63,0.3)'; g.fillRect(x, y, cx, cy); } if (s < 1) hatch(g, x, y, cx, cy, s > 0 ? 'rgba(224,163,58,0.45)' : 'rgba(224,80,63,0.55)', 14); } }
      else if (o === 'contested') { g.fillStyle = 'rgba(224,163,58,0.16)'; g.fillRect(x, y, cx, cy); hatch(g, x, y, cx, cy, 'rgba(224,163,58,0.5)', 18); }
      else { g.fillStyle = known ? 'rgba(224,80,63,0.17)' : 'rgba(40,10,8,0.42)'; g.fillRect(x, y, cx, cy); }
      // no man's land: craters along the front
      if (C.frontline(c.id)) { const r = rng(hash(c.id) ^ C.turn); g.fillStyle = 'rgba(30,26,20,0.38)'; for (let k = 0; k < 40; k++) { g.beginPath(); g.arc(x + r() * cx, y + r() * cy, 1.5 + r() * 4, 0, 7); g.fill(); } }
      // fortifications: trench zigzags
      // fortifications: zigzag trench lines across the square, facing the enemy (one per level)
      const f = C.fort[c.id] || 0; if (f && (o === 'player' || known)) {
        const r = rng(hash(c.id) + 7), enemyBelow = o === 'player' ? C.neighbors(c.id).some(n => C.owner[n] !== 'player' && C.cell(n).row > c.row) : C.neighbors(c.id).some(n => C.owner[n] === 'player' && C.cell(n).row > c.row);
        for (let k = 0; k < f; k++) { const yy = enemyBelow ? y + cy * (0.82 - k * 0.13) : y + cy * (0.18 + k * 0.13), x0 = x + cx * (0.08 + r() * 0.08), x1 = x + cx * (0.92 - r() * 0.08), n = 11;
          for (const [col, wd] of [['rgba(25,20,14,0.85)', 4], [o === 'player' ? 'rgba(160,190,230,0.55)' : 'rgba(235,150,130,0.55)', 1.4]]) { g.strokeStyle = col; g.lineWidth = wd; g.beginPath(); for (let j = 0; j <= n; j++) { const xx = x0 + (x1 - x0) * j / n, yo = (j % 2 ? -1 : 1) * cy * 0.018 + Math.sin(j * 1.7 + k) * cy * 0.01; j ? g.lineTo(xx, yy + yo) : g.moveTo(xx, yy + yo); } g.stroke(); } } }
      // grid lines + reference
      g.strokeStyle = 'rgba(240,236,220,0.16)'; g.lineWidth = 1.2; g.strokeRect(x + 0.5, y + 0.5, cx - 1, cy - 1);
      g.fillStyle = 'rgba(240,236,220,0.34)'; g.font = `600 ${Math.round(cx * 0.065)}px "Barlow Condensed", "Arial Narrow", sans-serif`; g.fillText(C.gridRef(c.id), x + 5, y + cx * 0.075);
      if (fading > 0) { g.fillStyle = `rgba(9,10,8,${0.8 * fading})`; g.fillRect(x, y, cx, cy); g.strokeStyle = `rgba(216,178,90,${0.9 * (1 - Math.abs(0.5 - fading) * 2)})`; g.lineWidth = 3; g.strokeRect(x + 2, y + 2, cx - 4, cy - 4); }
    }
    // supply sources and forward depots
    for (const id of [...(A.supplySources || []), ...(C.depots || [])]) { const c = C.cell(id); if (!c || C.owner[id] !== 'player') continue; const x = (c.col + 0.5) * cx, y = (c.row + 0.85) * cy, dep = (C.depots || []).includes(id);
      g.fillStyle = dep ? 'rgba(143,176,105,0.95)' : 'rgba(143,176,105,0.6)'; g.strokeStyle = '#1b1d17'; g.lineWidth = 2; g.beginPath(); g.rect(x - 11, y - 7, 22, 14); g.fill(); g.stroke(); g.beginPath(); g.moveTo(x - 11, y + 2); g.lineTo(x + 11, y + 2); g.stroke(); }
    this.ovTex.needsUpdate = true;
    // front line along the cell borders (3D, crisp at every zoom)
    const seg = [];
    for (const c of A.cells) { const o = C.owner[c.id] === 'player'; for (const [dc, dr] of [[1, 0], [0, 1]]) { const n = C.cellAt(c.col + dc, c.row + dr); if (!n || (C.owner[n.id] === 'player') === o) continue;
      const x = this.x0 + (c.col + 1) * this.cw, z = this.z0 + (c.row + 1) * this.ch;
      if (dc) seg.push(x, 0.01, z - this.ch, x, 0.01, z); else seg.push(x - this.cw, 0.01, z, x, 0.01, z); } }
    if (this.cellFront) { this.scene.remove(this.cellFront, this.cellFrontG); this.cellFront.geometry.dispose(); this.cellFrontG.geometry.dispose(); }
    if (seg.length) { const g1 = new LineSegmentsGeometry(); g1.setPositions(seg); const g2 = new LineSegmentsGeometry(); g2.setPositions(seg); this.cellFront = new LineSegments2(g1, this.cellFrontMat); this.cellFrontG = new LineSegments2(g2, this.cellFrontGlow); this.cellFront.renderOrder = 4; this.cellFrontG.renderOrder = 3; this.scene.add(this.cellFrontG, this.cellFront); }
  }
  paintHighlight() {
    this.dirty = true;
    const C = this.C, A = this.def.aor, g = this.hlCv.getContext('2d'), s = 48; g.clearRect(0, 0, this.hlCv.width, this.hlCv.height);
    if (this.reachSet) for (const [id, kind] of this.reachSet) { const c = C.cell(id); if (!c) continue; g.fillStyle = kind === 'attack' ? 'rgba(224,80,63,0.22)' : 'rgba(150,200,255,0.16)'; g.fillRect(c.col * s, c.row * s, s, s); g.strokeStyle = kind === 'attack' ? 'rgba(255,120,100,0.75)' : 'rgba(170,210,255,0.55)'; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.strokeRect(c.col * s + 2, c.row * s + 2, s - 4, s - 4); g.setLineDash([]); }
    this.paintTargeting(g, s);
    if (this.selCell) { const c = C.cell(this.selCell); if (c) { g.strokeStyle = 'rgba(216,178,90,1)'; g.lineWidth = 3; g.strokeRect(c.col * s + 1.5, c.row * s + 1.5, s - 3, s - 3); } }
    if (this.hover) { const c = C.cell(this.hover); if (c) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(c.col * s, c.row * s, s, s); g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2; g.strokeRect(c.col * s + 1, c.row * s + 1, s - 2, s - 2); } }
    this.hlTex.needsUpdate = true;
  }
  // ------------------------------------------------------------------ v4: targeting, UAVs, supply lines, closed squares
  // Targeting overlay (fire missions / UAV sorties): T = { valid: Map(cellId -> 'ok' | 'bad'), color, from: cellId,
  // rangeKm, radius (cells affected around the hovered target), label } — painted on the highlight layer, plus a 3D
  // range ring around `from`.
  setTargeting(T) {
    this.targeting = T || null; this.paintHighlight();
    if (this.rangeRing) { this.scene.remove(this.rangeRing); this.rangeRing.geometry.dispose(); this.rangeRing = null; }
    if (T?.from && T.rangeKm) {
      const p = this.cellCenter(T.from), pts = []; for (let i = 0; i <= 96; i++) { const a = i / 96 * Math.PI * 2; pts.push(p.x + Math.cos(a) * T.rangeKm, 0.03, p.z + Math.sin(a) * T.rangeKm); }
      const g = new LineGeometry(); g.setPositions(pts); this.rangeMat ||= this.lineMat('#ffd27a', 2.6, 0.9, true); this.rangeMat.color.set(T.color || '#ffd27a');
      const l = new Line2(g, this.rangeMat); l.computeLineDistances(); l.renderOrder = 8; this.scene.add(l); this.rangeRing = l;
    }
  }
  paintTargeting(g, s) {
    const T = this.targeting, C = this.C; if (!T) return;
    const col = T.color || '#ffd27a', [r, gg, b] = [1, 3, 5].map(i => parseInt(col.slice(i, i + 2), 16));
    for (const [id, k] of T.valid || []) { const c = C.cell(id); if (!c) continue; g.fillStyle = k === 'ok' ? `rgba(${r},${gg},${b},0.16)` : 'rgba(0,0,0,0.18)'; g.fillRect(c.col * s, c.row * s, s, s); if (k === 'ok') { g.strokeStyle = `rgba(${r},${gg},${b},0.55)`; g.lineWidth = 1; g.strokeRect(c.col * s + 1.5, c.row * s + 1.5, s - 3, s - 3); } }
    if (T.from) { const c = C.cell(T.from); if (c) { g.fillStyle = `rgba(${r},${gg},${b},0.9)`; g.beginPath(); g.arc((c.col + 0.5) * s, (c.row + 0.5) * s, 5, 0, 7); g.fill(); } }
    const hc = this.hover && C.cell(this.hover);
    if (hc && T.valid?.get(this.hover) === 'ok') {
      const R = T.radius || 0; g.strokeStyle = `rgba(${r},${gg},${b},1)`; g.lineWidth = 3; g.setLineDash([6, 4]);
      g.strokeRect((hc.col - R) * s + 2, (hc.row - R) * s + 2, (2 * R + 1) * s - 4, (2 * R + 1) * s - 4); g.setLineDash([]);
      g.fillStyle = `rgba(${r},${gg},${b},0.22)`; g.fillRect(hc.col * s, hc.row * s, s, s);
      // crosshair
      const x = (hc.col + 0.5) * s, y = (hc.row + 0.5) * s; g.lineWidth = 2; g.beginPath(); g.arc(x, y, s * 0.28, 0, 7); g.moveTo(x - s * 0.42, y); g.lineTo(x + s * 0.42, y); g.moveTo(x, y - s * 0.42); g.lineTo(x, y + s * 0.42); g.stroke();
    }
  }
  // a fire mission landing: expanding rings and flashes on the target square
  strike(cellId, color = '#ff7a5a') {
    const p = this.cellCenter(cellId), R = Math.min(this.cw, this.ch) * 0.45, objs = [];
    for (let i = 0; i < 5; i++) { const m = new THREE.Mesh(new THREE.CircleGeometry(1, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthTest: false })); m.rotation.x = -Math.PI / 2; const a = i * 2.4, r = R * (0.2 + 0.6 * ((i * 37) % 10) / 10); m.position.set(p.x + Math.cos(a) * r, 0.03, p.z + Math.sin(a) * r); m.renderOrder = 9; this.scene.add(m); objs.push([m, i * 0.18]); }
    this.anims.push({ t: 0, dur: 2.2, step: k => { const t = k * 2.2; for (const [m, d] of objs) { const u = Math.max(0, Math.min(1, (t - d) / 0.9)); m.scale.setScalar(R * 0.08 + u * R * 0.35); m.material.opacity = u > 0 ? (1 - u) * 0.85 : 0; } this.dirty = true; }, done: () => { for (const [m] of objs) { this.scene.remove(m); m.geometry.dispose(); } } });
  }
  // ---- recon UAVs orbiting their target square (sorties flown this week: [{ cell, type, side, lost, cells }])
  setUavs(list) {
    this.uavGroup ||= (() => { const g = new THREE.Group(); this.scene.add(g); return g; })();
    const key = JSON.stringify((list || []).map(u => [u.cell, u.type, u.side, !!u.lost]));
    if (key === this.uavKey) return; this.uavKey = key;
    for (const u of this.uavs || []) if (!u.leaving) { this.uavGroup.remove(u.obj, u.ring, u.area); u.area?.geometry.dispose(); }
    this.uavs = (this.uavs || []).filter(u => u.leaving);
    (list || []).forEach((u, i) => {
      if (u.lost && !u.cells?.length) return;
      const own = (u.side || 'player') === 'player', side = own ? this.def.id : (this.def.id === 'UA' ? 'RU' : 'UA');
      const obj = uavModel(side, u.type, Math.min(this.cw, this.ch)); const c = this.cellCenter(u.cell);
      const R = Math.min(this.cw, this.ch) * (u.type === 'quad' ? 0.3 : 0.48), alt = Math.min(this.cw, this.ch) * (u.type === 'quad' ? 0.22 : 0.34);
      // observed area: a square outline over the squares the drone sees, and the sensor footprint under it
      const cells = (u.cells || [u.cell]).map(id => this.C.cell(id)).filter(Boolean);
      const c0 = Math.min(...cells.map(x => x.col)), c1 = Math.max(...cells.map(x => x.col)), r0 = Math.min(...cells.map(x => x.row)), r1 = Math.max(...cells.map(x => x.row));
      const x0 = this.x0 + c0 * this.cw, x1 = this.x0 + (c1 + 1) * this.cw, z0 = this.z0 + r0 * this.ch, z1 = this.z0 + (r1 + 1) * this.ch;
      const ag = new LineGeometry(); ag.setPositions([x0, 0.02, z0, x1, 0.02, z0, x1, 0.02, z1, x0, 0.02, z1, x0, 0.02, z0]);
      this.uavAreaMat ||= this.lineMat('#7fd6ff', 2.4, 0.85, true); this.uavAreaFoe ||= this.lineMat('#ff9c8c', 2.4, 0.85, true);
      const area = new Line2(ag, own ? this.uavAreaMat : this.uavAreaFoe); area.computeLineDistances(); area.renderOrder = 8;
      const ring = new THREE.Mesh(new THREE.RingGeometry(R * 0.96, R * 1.04, 64), new THREE.MeshBasicMaterial({ color: own ? '#7fd6ff' : '#ff9c8c', transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(c.x, 0.018, c.z); ring.renderOrder = 8; ring.userData.uavRing = true;
      this.uavGroup.add(obj, ring, area);
      this.uavs.push({ obj, ring, area, c, R, alt, ph: i * 1.7 + (hash(u.cell) % 100) / 16, w: (u.type === 'quad' ? 0.9 : 0.55) * (i % 2 ? -1 : 1), t0: performance.now(), lost: u.lost, own });
    });
    this.dirty = true;
  }
  // end of the week: the drones climb away towards their own rear and are gone
  uavDepart() {
    for (const u of this.uavs || []) if (!u.leaving) { u.leaving = performance.now(); u.from = u.obj.position.clone(); this.uavGroup.remove(u.ring, u.area); }
    this.uavKey = null;
  }
  animUavs(now) {
    if (!this.uavs?.length) return false;
    const rear = this.def.aor.enemyEdge === 'north' ? 1 : -1;
    for (const u of [...this.uavs]) {
      if (u.leaving) {
        const k = (now - u.leaving) / 2600; if (k >= 1) { this.uavGroup.remove(u.obj); this.uavs.splice(this.uavs.indexOf(u), 1); continue; }
        const e = k * k; u.obj.position.set(u.from.x + Math.sin(u.ph) * e * this.cw * 2, u.from.y + e * u.alt * 2.5, u.from.z + rear * -e * this.ch * 5);
        u.obj.rotation.set(0, Math.atan2(Math.sin(u.ph) * 2, rear * -5), 0); u.obj.traverse(o => { if (o.material) { o.material.transparent = true; o.material.opacity = 1 - k; } });
        continue;
      }
      const t = (now - u.t0) / 1000, a = u.ph + t * u.w;
      u.obj.position.set(u.c.x + Math.cos(a) * u.R, u.alt + Math.sin(t * 0.9 + u.ph) * u.alt * 0.04, u.c.z + Math.sin(a) * u.R);
      // heading along the orbit tangent, banked into the turn
      const dir = Math.sign(u.w); u.obj.rotation.set(0, -a - (dir > 0 ? 0 : Math.PI), 0, 'YXZ'); u.obj.rotateZ(dir * 0.38);
      const prop = u.obj.getObjectByName('prop'); if (prop) prop.rotation.z += 1.7;
      u.ring.material.opacity = 0.35 + 0.25 * Math.sin(t * 3);
      // keep the model readable from far away: a minimum on-screen size
      const s = Math.max(1, this.cam.dist / (Math.min(this.cw, this.ch) * 9)); u.obj.scale.setScalar((u.obj.userData.s0 ||= u.obj.scale.x) * Math.min(4, s));
    }
    return true;
  }
  // ---- supply network view: routes from hubs to own task forces / the front, hub markers, interdicted squares
  // net = { level, via, hubs: [{cell, name, kind, linked, cap}], interdicted: {cell: turn} } (supply.js computeNetwork)
  drawSupply(net) {
    if (this.supplyObjs) { for (const o of this.supplyObjs) { this.dyn.remove(o); o.geometry?.dispose(); } }
    this.supplyObjs = [];
    if (!this.showSupply || !net) return;
    const C = this.C, ends = new Set(C.forces.map(f => f.cell));
    for (const c of this.def.aor.cells) if (C.owner[c.id] === 'player' && C.frontline?.(c.id)) ends.add(c.id);
    this.supplyMat ||= this.lineMat('#a9d48a', 3, 0.85, true); this.supplyWeak ||= this.lineMat('#e8b85a', 2.4, 0.8, true);
    const seen = new Set();
    for (const id of ends) {
      const path = []; let cur = id, k = 0; while (cur && k++ < 60) { path.unshift(cur); cur = net.via?.[cur]; }
      if (path.length < 2) continue; const sig = path.join('>'); if (seen.has(sig)) continue; seen.add(sig);
      const g = new LineGeometry(); g.setPositions(path.flatMap(p => { const v = this.cellCenter(p); return [v.x, 0.025, v.z]; }));
      const l = new Line2(g, (net.level?.[id] ?? 1) >= 1 ? this.supplyMat : this.supplyWeak); l.computeLineDistances(); l.renderOrder = 7; this.dyn.add(l); this.supplyObjs.push(l);
    }
    const ICON = { railhead: '🚆', base: '▣', ammo: '◆', depot: '◆', source: '▲' };
    for (const hb of net.hubs || []) {
      const p = this.cellCenter(hb.cell); p.y = 0.03; const e = document.createElement('div');
      e.className = 'c2-hub ' + (hb.cap >= 1 ? 'ok' : hb.cap > 0 ? 'half' : 'cut') + (hb.kind ? ' ' + hb.kind : '');
      e.innerHTML = `<i>${ICON[hb.kind] || '◆'}</i><span>${esc(hb.name || hb.kind)}</span>`; e.title = `${hb.name || 'Supply hub'} — ${hb.kind || 'hub'}${hb.cap >= 1 ? ', working' : hb.cap > 0 ? ', reduced throughput' : ', cut off from the rear'}`;
      this.labels.appendChild(e); this.badges.push({ e, pos: p });
    }
    for (const id of Object.keys(net.interdicted || {})) { const p = this.cellCenter(id); p.y = 0.03; const e = document.createElement('div'); e.className = 'c2-intd'; e.textContent = '✕ interdicted'; this.labels.appendChild(e); this.badges.push({ e, pos: p }); }
  }
  // ------------------------------------------------------------------ dynamic: tokens, badges, arrows, path
  buildDynamic() {
    this.dyn = new THREE.Group(); this.scene.add(this.dyn);
    this.pathMat = this.lineMat('#ffffff', 3, 0.95, true); this.pathAtkMat = this.lineMat(COL.enemy, 4, 0.95);
    this.cellLabels = []; for (const c of this.def.aor.cells) if (c.settlement) this.cellLabels.push(this.label(this.V(c.settlement.latlon || c.latlon, 0.05), c.settlement.name, `c2-sl c2-sl${Math.min(5, c.settlement.size || 1)}`, { size: c.settlement.size || 1, ax: 0.5, ay: 1.6 }));
    this.cellLabels.sort((a, b) => b.size - a.size);
    this.tokens = []; this.badges = [];
  }
  label(pos, html, cls, meta = {}) { const e = document.createElement('div'); e.className = cls; e.innerHTML = html; this.labels.appendChild(e); return { e, pos, ...meta }; }
  clearDyn() {
    for (const t of [...this.tokens, ...this.badges]) t.e.remove(); this.tokens = []; this.badges = [];
    for (const o of [...this.dyn.children]) { this.dyn.remove(o); o.geometry?.dispose(); }
  }
  refresh() {
    this.dirty = true; const C = this.C; this.paintGround(); this.paintOverlay(); this.paintHighlight(); this.clearDyn();
    if (this.trees && this.treeSeason !== this.season) { this.treeSeason = this.season; const R = rng(9), col = new THREE.Color(); for (let i = 0; i < this.trees.count; i++) this.trees.setColorAt(i, col.set(this.treeColor(R()))); this.trees.instanceColor.needsUpdate = true; }
    // task forces
    const byCell = {}; for (const f of C.forces) (byCell[f.cell] ||= []).push(f);
    for (const [cell, fs] of Object.entries(byCell)) fs.forEach((f, i) => {
      // a stack: side by side with a fixed on-screen spacing (never on top of each other at any zoom); only the selected
      // task force (or the first one) shows its name, the others show it on hover
      const p = this.cellCenter(cell); p.y = 0.02; const sx = (i - (fs.length - 1) / 2) * 46;
      const lead = fs.some(x => x.id === this.sel) ? f.id === this.sel : i === 0;
      const e = document.createElement('div'); e.className = 'c2-tok own' + (f.id === this.sel ? ' sel' : '') + (fs.length >= 2 && !lead ? ' compact' : '') + (f.planned ? ' plan' : '') + (f.reserve ? ' res' : '') + ((f.supply ?? 1) < 0.5 ? ' oos' : '');
      if (lead && fs.length > 1) e.style.zIndex = '2';
      const us = C.tfUnits(f), mpMax = C.tfMpMax(f);
      e.innerHTML = `<div class="c2-tok-ech">${echelon(us.length)}</div>${natoSvg(us)}<div class="c2-tok-n">${esc(f.name)}</div><div class="c2-tok-mp">${pips(f.mp, mpMax)}${(f.supply ?? 1) < 0.5 ? '<b class="c2-oos">NO SUPPLY</b>' : ''}${f.attacked ? '<b class="c2-used">ATTACKED</b>' : ''}</div><div class="c2-stem"></div>`;
      e.title = `${f.name}: ${us.length} units · MP ${fmt(f.mp)}/${mpMax} · ${f.stance}`;
      e.addEventListener('pointerdown', ev => { ev.stopPropagation(); if (ev.button === 0) this.on.select?.(f.id); else if (ev.button === 2) { ev.preventDefault(); this.on.order?.(f.cell, f.id); } });
      e.addEventListener('contextmenu', ev => ev.preventDefault());
      e.addEventListener('wheel', ev => this.onWheel(ev), { passive: false });   // zoom and the route preview work with the cursor over a token too
      e.addEventListener('pointermove', ev => this.hoverAt(ev.clientX, ev.clientY));
      this.labels.appendChild(e); this.tokens.push({ e, pos: p, tok: true, tf: f.id, sx });
      // ground marker
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.13, 24), new THREE.MeshBasicMaterial({ color: f.id === this.sel ? COL.accent : COL.own, transparent: true, opacity: 0.9, depthTest: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(p.x, 0.01, p.z); ring.renderOrder = f.id === this.sel ? 6 : 5; this.dyn.add(ring);
    });
    // enemy strength (known cells) and unknown markers
    for (const c of this.def.aor.cells) {
      const o = C.owner[c.id]; if (o === 'player') continue;
      const known = C.known(c.id), g = C.garrison[c.id] || 0, p = this.cellCenter(c.id); p.y = 0.02;
      if (!known && !C.frontline(c.id)) continue;
      if (C.foes && C.foes.some(f => f.cell === c.id)) continue;   // versus: the hostile task force token stands here instead
      const e = document.createElement('div'); e.className = 'c2-en' + (known ? '' : ' unk') + (o === 'contested' ? ' cont' : '');
      e.innerHTML = known ? `<div class="c2-en-ech">${['', 'I', 'I+', 'II'][clamp(Math.round(g), 1, 3)]}</div><svg viewBox="0 0 30 30" width="22" height="22"><path d="M15 2 L28 15 L15 28 L2 15 Z" fill="${o === 'contested' ? COL.contested : COL.enemy}" stroke="#1a0c0a" stroke-width="1.6"/><path d="M9 9 L21 21 M21 9 L9 21" stroke="#1a0c0a" stroke-width="1.6"/></svg>` : `<svg viewBox="0 0 30 30" width="18" height="18"><path d="M15 2 L28 15 L15 28 L2 15 Z" fill="rgba(224,80,63,0.25)" stroke="rgba(224,80,63,0.7)" stroke-width="1.4" stroke-dasharray="3 2"/><text x="15" y="20" text-anchor="middle" font-size="13" fill="#e8b0a8" font-weight="700">?</text></svg>`;
      e.title = known ? `${C.cellName(c.id)}: enemy ${['', 'company', 'reinforced company', 'battalion'][clamp(Math.round(g), 1, 3)]}${C.fort[c.id] ? `, fortifications ${C.fort[c.id]}` : ''}` : `${C.cellName(c.id)}: enemy strength unknown — reconnoitre`;
      this.labels.appendChild(e); this.badges.push({ e, pos: p, enemy: true });
    }
    // versus: the other player's task forces this side can see (hostile frames)
    const foeBy = {}; for (const f of C.foes || []) (foeBy[f.cell] ||= []).push(f);
    for (const [cell, fs] of Object.entries(foeBy)) fs.forEach((f, i) => {
      const p = this.cellCenter(cell); p.z -= this.ch * 0.05; p.y = 0.02; const sx = (i - (fs.length - 1) / 2) * 46;
      const e = document.createElement('div'); e.className = 'c2-tok foe' + (i ? ' compact' : '');
      e.innerHTML = `<div class="c2-tok-ech foe">${echelon(f.n)}</div>${natoSvg(f.units || [], 34, 34, true)}<div class="c2-tok-n foe">Enemy · ${f.n} unit${f.n === 1 ? '' : 's'}</div><div class="c2-stem foe"></div>`;
      e.title = `Enemy task force: ${f.n} units (combat power ~${f.power})`;
      e.addEventListener('pointerdown', ev => { ev.stopPropagation(); if (ev.button === 0) this.on.cell?.(cell); else if (ev.button === 2) { ev.preventDefault(); this.on.order?.(cell); } });
      e.addEventListener('contextmenu', ev => ev.preventDefault()); e.addEventListener('wheel', ev => this.onWheel(ev), { passive: false }); e.addEventListener('pointermove', ev => this.hoverAt(ev.clientX, ev.clientY));
      this.labels.appendChild(e); this.badges.push({ e, pos: p, foe: true, sx });
    });
    // objectives of active directives
    const letters = {}; let li = 0;
    for (const a of C.directives) { const d = C.directiveDef(a.id); for (const t of d?.targets || []) { if (letters[t]) continue; letters[t] = d.kind === 'hold' || d.kind === 'survive' ? 'H' : d.kind === 'recon' ? 'R' : String.fromCharCode(65 + li++); } }
    for (const [t, L] of Object.entries(letters)) { const c = C.cell(t); if (!c) continue; const p = this.cellCenter(t); p.x -= this.cw * 0.3; p.z += this.ch * 0.36;
      const e = document.createElement('div'); e.className = 'c2-obj' + (C.owner[t] === 'player' ? ' held' : ''); e.innerHTML = `<span>${L}</span>`; e.title = `Directive objective: ${C.cellName(t)}`; this.labels.appendChild(e); this.badges.push({ e, pos: p }); }
    // brigade HQ
    { const hq = C.hq || this.def.start.hq; if (C.cell(hq)) { const p = this.cellCenter(hq); p.x += this.cw * 0.33; p.z += this.ch * 0.28; const e = document.createElement('div'); e.className = 'c2-hq'; e.innerHTML = 'HQ'; e.title = 'Brigade headquarters — reinforcements arrive here'; this.labels.appendChild(e); this.badges.push({ e, pos: p }); } }
    // enemy attacks being prepared
    for (const a of C.pendingAttacks) this.arrow(this.cellCenter(a.from), this.cellCenter(a.to), COL.enemy, `${['', 'company', 'reinf. company', 'battalion'][a.strength]} attack expected`);
    // v4: operation-goal squares, own / found enemy batteries, the supply network (Supply view), this week's UAVs
    for (const g of C.def.goal?.cells || []) { const c = C.cell(g.cell); if (!c) continue; const p = this.cellCenter(g.cell); p.x += this.cw * 0.3; p.z -= this.ch * 0.34; p.y = 0.03;
      const e = document.createElement('div'); e.className = 'c2-goalm' + (C.owner[g.cell] === 'player' ? ' held' : ''); e.innerHTML = `<i>★</i><span>${g.pts}</span>`; e.title = `Operation goal: ${g.name || C.cellName(g.cell)} (${g.pts} pts)${C.owner[g.cell] === 'player' ? ' — held' : ''}`; this.labels.appendChild(e); this.badges.push({ e, pos: p }); }
    for (const b of C.batteries?.('player') || []) { const c = C.cell(b.cell); if (!c) continue; const p = this.cellCenter(b.cell); p.x -= this.cw * 0.3; p.z -= this.ch * 0.3; p.y = 0.03;
      const e = document.createElement('div'); e.className = 'c2-bat own' + (b.down ? ' down' : b.acted === C.turn ? ' used' : '') + (this.targeting?.bat === b.id ? ' sel' : ''); e.innerHTML = `<svg viewBox="0 0 24 18" width="22" height="16"><rect x="1" y="1" width="22" height="16" fill="${COL.own}" stroke="#0d1520" stroke-width="1.6"/><circle cx="12" cy="9" r="3" fill="#0d1520"/></svg>`; e.title = `${b.name}${b.down ? ' (being rebuilt)' : b.acted === C.turn ? ' (acted this week)' : ''}`; this.labels.appendChild(e); this.badges.push({ e, pos: p }); }
    for (const b of C.foundBatteries?.() || []) { const p = this.cellCenter(b.cell); p.x += this.cw * 0.28; p.z += this.ch * 0.1; p.y = 0.03;
      const e = document.createElement('div'); e.className = 'c2-bat foe'; e.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 1 L23 12 L12 23 L1 12 Z" fill="${COL.enemy}" stroke="#1a0c0a" stroke-width="1.6"/><circle cx="12" cy="12" r="3" fill="#1a0c0a"/></svg>`; e.title = `Enemy battery found: ${b.name || b.kind}`; this.labels.appendChild(e); this.badges.push({ e, pos: p }); }
    this.drawSupply(C.supplyNet?.player);
    this.setUavs([...(C.uavLog || []).filter(l => l.turn === C.turn).map(l => ({ cell: l.cell, type: l.type, side: 'player', lost: l.lost, cells: l.cells }))]);
    // squares that just opened fade in
    const jo = C.justOpened?.length ? C.justOpened.join(',') + '@' + C.turn : null;
    if (jo && jo !== this.fadeKey) { this.fadeKey = jo; this.fade = { cells: new Set(C.justOpened), k: 0 }; (this.anims ||= []).push({ t: 0, dur: 2.2, step: k => { this.fade.k = k; this.paintOverlay(); }, done: () => { this.fade = null; this.paintOverlay(); } }); }
    if (this.path) this.showPath(this.path, true);
    // place the new markers now (not on the next frame: they would flash in the top-left corner for a frame)
    if (this.camera && this.W) { this.updateCamera(); this.placeLabels(performance.now()); }
  }
  arrow(a, b, color, text) {
    const d = new THREE.Vector3().subVectors(b, a); const L = d.length(); if (L < 1e-6) return; d.normalize();
    const w = Math.min(this.cw, this.ch) * 0.12, len = L * 0.72, sh = new THREE.Shape();
    sh.moveTo(0, -w / 2); sh.lineTo(len - w * 2.2, -w / 2); sh.lineTo(len - w * 2.2, -w * 1.4); sh.lineTo(len, 0); sh.lineTo(len - w * 2.2, w * 1.4); sh.lineTo(len - w * 2.2, w / 2); sh.lineTo(0, w / 2); sh.closePath();
    const g = new THREE.ShapeGeometry(sh); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthTest: false, side: THREE.DoubleSide })); m.renderOrder = 6;
    m.position.set(a.x + d.x * L * 0.14, 0.015, a.z + d.z * L * 0.14); m.rotation.y = Math.atan2(-d.z, d.x); m.userData.pulse = true; this.dyn.add(m);
    if (text) { const e = document.createElement('div'); e.className = 'c2-arrow-l'; e.textContent = text; this.labels.appendChild(e); this.badges.push({ e, pos: new THREE.Vector3().lerpVectors(a, b, 0.45) }); }
  }
  // move / attack preview: plan = Campaign2.plan() result
  showPath(plan, keep = false) {
    this.dirty = true;
    if (this.pathObj) { this.dyn.remove(this.pathObj); this.pathObj.geometry.dispose(); this.pathObj = null; }
    if (this.pathLbl) { this.pathLbl.e.remove(); this.badges = this.badges.filter(b => b !== this.pathLbl); this.pathLbl = null; }
    this.path = plan; if (!plan || !plan.path || plan.path.length < 2) return;
    const pts = plan.path.map(id => this.cellCenter(id));
    if (plan.attack) { const a = pts[pts.length - 1], b = pts[pts.length - 2]; pts[pts.length - 1] = new THREE.Vector3().lerpVectors(b, a, 0.62); }
    const g = new LineGeometry(); g.setPositions(pts.flatMap(p => [p.x, 0.02, p.z]));
    const l = new Line2(g, plan.attack ? this.pathAtkMat : this.pathMat); l.computeLineDistances(); l.renderOrder = 7; this.dyn.add(l); this.pathObj = l;
    const e = document.createElement('div'); e.className = 'c2-path-l' + (plan.ok ? '' : ' bad') + (plan.attack ? ' atk' : '');
    e.innerHTML = plan.ok ? (plan.attack ? `ATTACK · ${fmt(plan.cost)} MP` : `${fmt(plan.cost)} MP · ${fmt(plan.mpLeft)} left`) : esc(plan.why || 'Cannot move');
    this.labels.appendChild(e); this.pathLbl = { e, pos: pts[pts.length - 1].clone().setY(0.02) }; this.badges.push(this.pathLbl);
  }
  setSelection(tfId, reach = null) { this.sel = tfId; this.reachSet = reach; this.refresh(); }
  setSelectedCell(id) { this.selCell = id; this.paintHighlight(); }
  setHover(id) { if (this.hover === id) return; this.hover = id; this.paintHighlight(); }
  // a pulse on the theatre map for a real event (news)
  flashEvent(latlon, text) {
    const p = this.V(latlon); const e = document.createElement('div'); e.className = 'c2-evt'; e.innerHTML = `<i></i><span>${esc(text)}</span>`; this.labels.appendChild(e);
    const item = { e, pos: p, until: performance.now() + 9000 }; this.badges.push(item); this.dirty = true;
  }
  // ------------------------------------------------------------------ camera
  view(name) {
    const c = this.aorCenter(), tb = this.tb;
    if (name === 'theatre') return { x: (tb.x0 + tb.x1) / 2, z: (tb.z0 + tb.z1) / 2, dist: Math.max(tb.x1 - tb.x0, tb.z1 - tb.z0) * 1.05, yaw: 0, pitch: 1.25 };
    if (name === 'front') { const fs = this.C.forces; const ps = fs.map(f => this.cellCenter(f.cell)); const mx = ps.length ? ps.reduce((a, p) => a + p.x, 0) / ps.length : c.x, mz = ps.length ? ps.reduce((a, p) => a + p.z, 0) / ps.length : c.z; return { x: lerp(c.x, mx, 0.6), z: lerp(c.z, mz, 0.6), dist: Math.max(this.x1 - this.x0, this.z1 - this.z0) * 0.85, yaw: 0.12, pitch: 0.95 }; }
    return { x: c.x, z: c.z, dist: Math.max(this.x1 - this.x0, this.z1 - this.z0) * 1.15, yaw: 0, pitch: 1.05 };
  }
  flyTo(v, dur = 1.2, done = null) {
    this.stopFly();   // a new flight replaces the one in progress (two would fight over the camera)
    const from = { ...this.cam }; const to = { ...this.cam, ...v };
    this.tcam = { ...to }; this.flying = true;
    this.anims.push({ cam: true, t: 0, dur, step: k => { const e = ease(k); this.cam.x = lerp(from.x, to.x, e); this.cam.z = lerp(from.z, to.z, e); this.cam.dist = Math.exp(lerp(Math.log(from.dist), Math.log(to.dist), e)); this.cam.yaw = lerp(from.yaw, to.yaw, e); this.cam.pitch = lerp(from.pitch, to.pitch, e); }, done: () => { this.flying = false; Object.assign(this.tcam, to); done?.(); } });
  }
  jump(v) { this.stopFly(); Object.assign(this.cam, v); Object.assign(this.tcam, v); this.dirty = true; }
  stopFly() { if (!this.anims) return; this.anims = this.anims.filter(a => !a.cam); this.flying = false; }
  groundAt(sx, sy) {
    const r = this.canvas.getBoundingClientRect(), v = new THREE.Vector3(((sx - r.left) / r.width) * 2 - 1, -((sy - r.top) / r.height) * 2 + 1, 0.5).unproject(this.camera);
    const o = this.camera.position, d = v.sub(o).normalize(); if (d.y >= -1e-4) return null; const t = -o.y / d.y; return new THREE.Vector3(o.x + d.x * t, 0, o.z + d.z * t);
  }
  bindInput() {
    const cv = this.canvas; let drag = null;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      drag = { b: e.button, x: e.clientX, y: e.clientY, moved: false, g: this.groundAt(e.clientX, e.clientY), cam: { ...this.tcam } };
    });
    cv.addEventListener('pointermove', e => {
      this.mouse = { x: e.clientX, y: e.clientY, in: true };
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.hypot(dx, dy) > 5) drag.moved = true;
        if (drag.b === 0 && drag.moved && drag.g && !this.locked) { // ground-anchored pan
          const now = this.groundAt(e.clientX, e.clientY); if (now) { this.tcam.x += drag.g.x - now.x; this.tcam.z += drag.g.z - now.z; this.cam.x = this.tcam.x; this.cam.z = this.tcam.z; this.updateCamera(); }
        } else if ((drag.b === 1 || drag.b === 2) && drag.moved && !this.locked) { this.tcam.yaw = drag.cam.yaw - dx * 0.006; this.tcam.pitch = clamp(drag.cam.pitch + dy * 0.004, 0.35, 1.5); }
      }
      this.hoverAt(e.clientX, e.clientY);
    });
    cv.addEventListener('pointerup', e => {
      if (drag && !drag.moved) { const g = this.groundAt(e.clientX, e.clientY), id = g ? this.cellAtWorld(g.x, g.z) : null; if (drag.b === 0) this.on.cell?.(id); else if (drag.b === 2 && id) this.on.order?.(id); }
      drag = null;
    });
    cv.addEventListener('pointerleave', () => { this.mouse.in = false; });
    cv.addEventListener('wheel', this.onWheel = e => {
      e.preventDefault(); if (this.locked) return;
      const k = Math.pow(1.0015, e.deltaY), g = this.groundAt(e.clientX, e.clientY), nd = clamp(this.tcam.dist * k, 1.2, this.maxDist());
      if (g && nd < this.tcam.dist) { const f = 1 - nd / this.tcam.dist; this.tcam.x += (g.x - this.tcam.x) * f; this.tcam.z += (g.z - this.tcam.z) * f; }
      this.tcam.dist = nd;
    }, { passive: false });
    this.onKey = e => { if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return; const k = e.key.toLowerCase(); if (e.type === 'keydown') this.keys.add(k); else this.keys.delete(k); };
    window.addEventListener('keydown', this.onKey); window.addEventListener('keyup', this.onKey);
    this.onBlur = () => this.keys.clear(); window.addEventListener('blur', this.onBlur);
  }
  hoverAt(x, y) { const g = this.groundAt(x, y), id = g ? this.cellAtWorld(g.x, g.z) : null; if (id !== this.hover) { this.setHover(id); this.on.hover?.(id); } }
  maxDist() { const tb = this.tb; return Math.max(tb.x1 - tb.x0, tb.z1 - tb.z0) * 1.3; }
  updateCamera() {
    const c = this.cam, cp = Math.cos(c.pitch);
    this.camera.position.set(c.x + Math.sin(c.yaw) * cp * c.dist, Math.sin(c.pitch) * c.dist, c.z + Math.cos(c.yaw) * cp * c.dist);
    this.camera.near = Math.max(0.005, c.dist * 0.01); this.camera.far = c.dist * 30 + 50; this.camera.updateProjectionMatrix();
    this.camera.lookAt(c.x, 0, c.z);
  }
  resize() {
    const w = this.el.clientWidth || window.innerWidth, h = this.el.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h;
    const off = this.viewOffset || 0; if (off) this.camera.setViewOffset(w, h, -off, 0, w, h); else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio(); for (const m of this.lineMats) m.resolution.set(w * pr, h * pr);
    this.W = w; this.H = h; this.dirty = true;
  }
  frame(dt, now) {
    // animations
    for (const a of [...this.anims]) { a.t += dt; const k = Math.min(1, a.t / a.dur); a.step(k); if (k >= 1) { this.anims.splice(this.anims.indexOf(a), 1); a.done?.(); } }
    // keyboard / edge pan, rotate
    if (!this.locked && !this.flying) {
      const T = this.tcam, sp = T.dist * 0.9 * dt; let fx = 0, fz = 0;
      if (this.keys.has('w') || this.keys.has('arrowup')) fz -= 1; if (this.keys.has('s') || this.keys.has('arrowdown')) fz += 1;
      if (this.keys.has('a') || this.keys.has('arrowleft')) fx -= 1; if (this.keys.has('d') || this.keys.has('arrowright')) fx += 1;
      if (this.mouse.in && this.edgePan !== false) { const m = 6; if (this.mouse.x < m) fx -= 1; if (this.mouse.x > this.W - m) fx += 1; if (this.mouse.y < m) fz -= 1; if (this.mouse.y > this.H - m) fz += 1; }
      if (fx || fz) { const s = Math.sin(T.yaw), c = Math.cos(T.yaw); T.x += (fx * c + fz * s) * sp; T.z += (-fx * s + fz * c) * sp; }
      if (this.keys.has('q')) T.yaw += dt * 1.2; if (this.keys.has('e')) T.yaw -= dt * 1.2;
      if (this.keys.has('r') || this.keys.has('=') || this.keys.has('+')) T.dist = Math.max(1.2, T.dist * (1 - dt * 1.5)); if (this.keys.has('f') || this.keys.has('-')) T.dist = Math.min(this.maxDist(), T.dist * (1 + dt * 1.5));
      const tb = this.tb; T.x = clamp(T.x, tb.x0, tb.x1); T.z = clamp(T.z, tb.z0, tb.z1);
      const k = 1 - Math.exp(-dt * 10), C = this.cam;
      C.x = lerp(C.x, T.x, k); C.z = lerp(C.z, T.z, k); C.dist = Math.exp(lerp(Math.log(C.dist), Math.log(T.dist), k)); C.yaw = lerp(C.yaw, T.yaw, k); C.pitch = lerp(C.pitch, T.pitch, k);
    }
    // render on demand: camera moved, state changed, animations, or a slow tick for the pulsing markers
    const sig = `${this.cam.x.toFixed(4)},${this.cam.z.toFixed(4)},${this.cam.dist.toFixed(4)},${this.cam.yaw.toFixed(4)},${this.cam.pitch.toFixed(4)},${this.W},${this.H}`;
    const flying = this.animUavs(now);
    if (sig === this.lastSig && !this.dirty && !flying && !this.anims.length && now - (this.lastRender || 0) < 140) return;
    this.lastSig = sig; this.dirty = false; this.lastRender = now;
    this.updateCamera();
    // pulses
    const pulse = 0.55 + 0.35 * Math.sin(now / 260);
    for (const o of this.dyn.children) if (o.userData.pulse) o.material.opacity = pulse;
    if (this.pathMat.dashed) this.pathMat.dashOffset = -now / 900;
    this.renderer.render(this.scene, this.camera);
    this.placeLabels(now);
  }
  placeLabels(now) {
    const d = this.cam.dist, v = new THREE.Vector3(), W = this.W, H = this.H, placed = [];
    // name labels never overlap: a label whose box hits one already placed (higher priority) is hidden
    const free = (it, x, y) => {
      if (!it.w) { const was = it.e.style.display; it.e.style.display = ''; it.w = it.e.offsetWidth; it.h = it.e.offsetHeight; it.e.style.display = was; if (!it.w) return true; }
      const bx = x - it.w * (it.ax ?? 0) + (it.dx || 0), by = y - it.h * (it.ay ?? 0.5), b = [bx - 3, by - 1, bx + it.w + 3, by + it.h + 1];
      for (const p of placed) if (b[0] < p[2] && p[0] < b[2] && b[1] < p[3] && p[1] < b[3]) return false;
      placed.push(b); return true;
    };
    const put = (it, show, declutter = false) => {
      let x = 0, y = 0;
      if (show) { v.copy(it.pos).project(this.camera); show = v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1; x = (v.x + 1) / 2 * W + (it.sx || 0); y = (1 - v.y) / 2 * H; }
      if (show && declutter === true) show = free(it, x, y);
      if (!show) { if (it.vis !== false) { it.e.style.display = 'none'; it.vis = false; } return; }
      if (it.vis !== true) { it.e.style.display = ''; it.vis = true; }
      it.e.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
      // task force tokens are obstacles for the place names (a name under a token is hidden, not drawn through it)
      if (declutter === 'obstacle') { if (!it.w) { it.w = it.e.offsetWidth; it.h = it.e.offsetHeight; } if (it.w) placed.push([x - it.w / 2, y - it.h, x + it.w / 2, y - 18]); }
    };
    for (const t of this.tokens) put(t, d < 160, 'obstacle');
    for (const b of this.badges) if (b.foe) put(b, d < 160, 'obstacle');
    for (const l of this.cellLabels) put(l, d < 14 + l.size * 9, true);
    for (const l of this.tLabels) put(l, l.kind === 'oblast' ? d > 120 : l.kind === 'river' ? d > 50 : d > 32, true);
    for (const b of this.badges) { if (b.foe) continue; if (b.until && now > b.until) { b.e.remove(); this.badges.splice(this.badges.indexOf(b), 1); continue; } put(b, b.until ? true : b.enemy ? d < 70 : d < 160); }
  }
  dispose() { this.dead = true; cancelAnimationFrame(this.raf); this.ro?.disconnect(); window.removeEventListener('keydown', this.onKey); window.removeEventListener('keyup', this.onKey); window.removeEventListener('blur', this.onBlur); this.renderer.dispose(); this.canvas.remove(); this.labels.remove(); }
}

// ---------------------------------------------------------------------------------------------- helpers
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = v => (Math.round(v * 10) / 10).toString();
const pips = (mp, max) => { let s = ''; for (let i = 0; i < Math.ceil(max); i++) s += `<i class="${mp >= i + 1 - 1e-6 ? 'on' : mp > i + 1e-6 ? 'half' : ''}"></i>`; return s; };
// recon UAV for the strategic map (procedural, no markings): UA — a Leleka-100-style blended flying wing with wingtip
// fins and a pusher propeller; RU — an Orlan-10-style high-wing monoplane with a tractor propeller and tail fin;
// type 'quad' — a small quadcopter. Forward = +Z; built at real proportions (span 1) and scaled up for the map.
export function uavModel(side, type, cell) {
  const g = new THREE.Group(), M = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: 0.15 });
  const body = M(side === 'RU' ? '#7a7f70' : '#9aa1a8'), dark = M('#2b2d2f'), glass = M('#1c2630');
  const add = (geo, mat, x = 0, y = 0, z = 0, name) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); if (name) m.name = name; g.add(m); return m; };
  if (type === 'quad') {
    add(new THREE.BoxGeometry(0.16, 0.06, 0.22), dark);
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const arm = add(new THREE.BoxGeometry(0.03, 0.02, 0.26), dark, sx * 0.1, 0.01, sz * 0.1); arm.rotation.y = sx * sz * Math.PI / 4;
      const r = add(new THREE.CylinderGeometry(0.11, 0.11, 0.005, 20), new THREE.MeshBasicMaterial({ color: '#d0d4d8', transparent: true, opacity: 0.35 }), sx * 0.19, 0.04, sz * 0.19); r.name = 'rotor';
    }
    g.scale.setScalar(cell * 0.08 / 0.5); return g;
  }
  if (side === 'RU') {
    // Orlan-10 style: slim fuselage, high straight wing, tail boom with a tall fin and tailplane, nose propeller
    const fus = add(new THREE.CapsuleGeometry(0.06, 0.62, 4, 12), body); fus.rotation.x = Math.PI / 2;
    const wing = add(new THREE.BoxGeometry(1.55, 0.02, 0.2), body, 0, 0.07, 0.05);
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.02, 0.06, 0.18), body, s * 0.775, 0.09, 0.05);
    add(new THREE.CylinderGeometry(0.018, 0.012, 0.5, 8).rotateX(Math.PI / 2), body, 0, 0.02, -0.55);
    add(new THREE.BoxGeometry(0.5, 0.015, 0.12), body, 0, 0.03, -0.78);
    add(new THREE.BoxGeometry(0.015, 0.2, 0.14), body, 0, 0.12, -0.78);
    add(new THREE.SphereGeometry(0.045, 12, 8), glass, 0, -0.06, 0.15);   // camera turret
    const prop = add(new THREE.CircleGeometry(0.17, 24), new THREE.MeshBasicMaterial({ color: '#cfd3d6', transparent: true, opacity: 0.32, side: THREE.DoubleSide }), 0, 0, 0.42, 'prop');
    add(new THREE.BoxGeometry(0.34, 0.025, 0.01), dark, 0, 0, 0.415).parent = prop;
  } else {
    // Leleka-100 style: blended flying wing, swept leading edge, fins at the tips, pusher propeller
    const sh = new THREE.Shape(); sh.moveTo(0, 0.32); sh.lineTo(0.95, -0.12); sh.lineTo(0.95, -0.26); sh.lineTo(0.12, -0.18); sh.lineTo(0, -0.24); sh.lineTo(-0.12, -0.18); sh.lineTo(-0.95, -0.26); sh.lineTo(-0.95, -0.12); sh.closePath();
    const wing = new THREE.ExtrudeGeometry(sh, { depth: 0.03, bevelEnabled: false }); wing.rotateX(Math.PI / 2); wing.translate(0, 0.015, 0); add(wing, body);
    const pod = add(new THREE.CapsuleGeometry(0.07, 0.36, 4, 12), body, 0, 0.03, 0.02); pod.rotation.x = Math.PI / 2;
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.015, 0.16, 0.14), body, s * 0.94, 0.06, 0.18);
    add(new THREE.SphereGeometry(0.045, 12, 8), glass, 0, -0.06, 0.18);
    const prop = add(new THREE.CircleGeometry(0.16, 24), new THREE.MeshBasicMaterial({ color: '#cfd3d6', transparent: true, opacity: 0.32, side: THREE.DoubleSide }), 0, 0.03, -0.27, 'prop');
    add(new THREE.BoxGeometry(0.32, 0.025, 0.01), dark, 0, 0.03, -0.265).parent = prop;
  }
  // the props were built as group children; parent the blade to its disc so both spin
  const p = g.getObjectByName('prop'); for (const ch of [...g.children]) if (ch.parent === p && !p.children.includes(ch)) { g.remove(ch); p.add(ch); ch.position.set(0, 0, 0); }
  g.scale.setScalar(cell * 0.16 / 1.9);
  return g;
}
export function echelon(n) { return n <= 2 ? '•••' : n <= 6 ? 'I' : 'II'; }
// NATO-style friendly frame with an icon from the force's composition
export function natoSvg(units, w = 40, h = 28, hostile = false) {
  if (hostile) {   // APP-6 hostile frame (diamond) with the composition icon
    const k = { tank: 0, mech: 0, foot: 0 }; for (const u of units) { const vk = u.veh?.kind; if (vk === 'tank') k.tank++; else if (vk && vk !== 'spg') k.mech++; else k.foot++; }
    const inner = k.tank > k.mech + k.foot ? '<ellipse cx="20" cy="20" rx="8" ry="4.5" fill="none" stroke="#1a0c0a" stroke-width="2"/>' : `<path d="M11 11 L29 29 M29 11 L11 29" stroke="#1a0c0a" stroke-width="2"/>${k.mech || k.tank ? '<ellipse cx="20" cy="20" rx="6.5" ry="3.6" fill="none" stroke="#1a0c0a" stroke-width="2"/>' : ''}`;
    return `<svg class="c2-nato" viewBox="0 0 40 40" width="${w}" height="${h}"><path d="M20 1 L39 20 L20 39 L1 20 Z" fill="${COL.enemy}" stroke="#1a0c0a" stroke-width="2"/>${inner}</svg>`;
  }
  const k = { tank: 0, mech: 0, foot: 0, art: 0, uav: 0 };
  for (const u of units) { const vk = u.veh && !u.veh.lost ? u.veh.kind : null; if (vk === 'tank') k.tank++; else if (vk === 'spg') k.art++; else if (vk) k.mech++; else if (u.kind === 'fpv') k.uav++; else k.foot++; }
  const inner = []; const armour = k.tank >= Math.max(k.mech, k.foot) && k.tank > 0, mech = k.mech > 0;
  if (armour && !mech) inner.push('<ellipse cx="20" cy="14" rx="11" ry="6" fill="none" stroke="#0d1520" stroke-width="2"/>');
  else { inner.push('<path d="M3 3 L37 25 M37 3 L3 25" stroke="#0d1520" stroke-width="2"/>'); if (mech || k.tank) inner.push('<ellipse cx="20" cy="14" rx="9" ry="5" fill="none" stroke="#0d1520" stroke-width="2"/>'); }
  if (k.art && !k.mech && !k.tank && !k.foot) { inner.length = 0; inner.push('<circle cx="20" cy="14" r="4" fill="#0d1520"/>'); }
  return `<svg class="c2-nato" viewBox="0 0 40 28" width="${w}" height="${h}"><rect x="1" y="1" width="38" height="26" fill="${COL.own}" stroke="#0d1520" stroke-width="2"/>${inner.join('')}</svg>`;
}
function hatch(g, x, y, w, h, color, step) { g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.strokeStyle = color; g.lineWidth = 2; for (let k = -h; k < w; k += step) { g.beginPath(); g.moveTo(x + k, y + h); g.lineTo(x + k + h, y); g.stroke(); } g.restore(); }
function rimTexture() { const cv = document.createElement('canvas'); cv.width = cv.height = 256; const g = cv.getContext('2d'); const gr = g.createRadialGradient(128, 128, 60, 128, 128, 128); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.7, 'rgba(216,178,90,0.05)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256); const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; }
function prism() { const g = new THREE.BufferGeometry(); const v = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0, -0.5, 0, 0.5, 0.5, 0, 0.5]; const idx = [0, 3, 2, 0, 2, 1, 4, 5, 2, 4, 2, 3, 0, 4, 3, 1, 2, 5]; g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.setIndex(idx); const n = g.toNonIndexed(); n.computeVertexNormals(); return n; }
function pip(p, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, zi] = poly[i], [xj, zj] = poly[j]; if ((zi > p[1]) !== (zj > p[1]) && p[0] < (xj - xi) * (p[1] - zi) / (zj - zi) + xi) c = !c; } return c; }
export function resample(pts, n) {
  const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const tot = L[L.length - 1] || 1, out = []; let j = 0;
  for (let k = 0; k < n; k++) { const t = tot * k / (n - 1); while (j < L.length - 2 && L[j + 1] < t) j++; const f = (t - L[j]) / ((L[j + 1] - L[j]) || 1); out.push([lerp(pts[j][0], pts[j + 1]?.[0] ?? pts[j][0], f), lerp(pts[j][1], pts[j + 1]?.[1] ?? pts[j][1], f)]); }
  return out;
}
// polygon of the side of the front line that contains ref, closed along the rectangle tb
export function occupiedPoly(line, tb, ref) {
  if (!line || line.length < 2) return null;
  const per = ([x, z]) => { const dT = Math.abs(z - tb.z0), dR = Math.abs(x - tb.x1), dB = Math.abs(z - tb.z1), dL = Math.abs(x - tb.x0), m = Math.min(dT, dR, dB, dL);
    if (m === dT) return { p: [clamp(x, tb.x0, tb.x1), tb.z0], t: (clamp(x, tb.x0, tb.x1) - tb.x0) / (tb.x1 - tb.x0) };
    if (m === dR) return { p: [tb.x1, clamp(z, tb.z0, tb.z1)], t: 1 + (clamp(z, tb.z0, tb.z1) - tb.z0) / (tb.z1 - tb.z0) };
    if (m === dB) return { p: [clamp(x, tb.x0, tb.x1), tb.z1], t: 2 + (tb.x1 - clamp(x, tb.x0, tb.x1)) / (tb.x1 - tb.x0) };
    return { p: [tb.x0, clamp(z, tb.z0, tb.z1)], t: 3 + (tb.z1 - clamp(z, tb.z0, tb.z1)) / (tb.z1 - tb.z0) }; };
  const corners = [[tb.x1, tb.z0], [tb.x1, tb.z1], [tb.x0, tb.z1], [tb.x0, tb.z0]];   // t = 1, 2, 3, 4(0)
  const s = per(line[0]), e = per(line[line.length - 1]);
  const walk = dir => { const out = []; let t = e.t; const end = s.t; const steps = []; if (dir > 0) { let k = Math.floor(t) + 1; let target = end <= t ? end + 4 : end; while (k < target) { steps.push(k % 4); k++; } } else { let k = Math.ceil(t) - 1; let target = end >= t ? end - 4 : end; while (k > target) { steps.push(((k % 4) + 4) % 4); k--; } }
    for (const k of steps) out.push(corners[(k + 3) % 4]); return out; };
  const base = [...line, e.p];
  const A = [...base, ...walk(1), s.p], B = [...base, ...walk(-1), s.p];
  return pip(ref, A) ? A : pip(ref, B) ? B : A;
}
// procedural village / town / industrial block: houses along a few streets, blocks in towns, sheds in industry
function procTown(list, cx, cz, s, R) {
  const size = s.size || 1, kind = s.kind;
  if (kind === 'industrial') { const n = 6 + size * 5; for (let i = 0; i < n; i++) list.push([cx + (R() - 0.5) * 0.25 * size, cz + (R() - 0.5) * 0.2 * size, 0.04 + R() * 0.08, 0.02 + R() * 0.05, 0.3 + (R() < 0.5 ? 0 : Math.PI / 2), 0.007 + R() * 0.008, 2]); return; }
  const streets = 2 + Math.floor(size / 2) + Math.floor(R() * 2), len = 0.35 + size * 0.22;
  for (let k = 0; k < streets; k++) {
    const a = R() * Math.PI + k * Math.PI / streets, ca = Math.cos(a), sa = Math.sin(a), off = (R() - 0.5) * 0.25;
    for (let t = -len / 2; t < len / 2; t += 0.028 + R() * 0.01) for (const side of [-1, 1]) {
      if (R() < 0.18) continue; const d = side * (0.02 + R() * 0.006);
      const x = cx + ca * t - sa * (d + off), z = cz - sa * t - ca * (d + off);
      list.push([x, z, 0.008 + R() * 0.004, 0.006 + R() * 0.003, a, 0.005 + R() * 0.0015, 0]);
    }
  }
  if (kind === 'town') { const n = size * 6; for (let i = 0; i < n; i++) { const a = 0.4 + (R() < 0.5 ? 0 : Math.PI / 2); list.push([cx + (R() - 0.5) * 0.4, cz + (R() - 0.5) * 0.35, 0.06 + R() * 0.03, 0.012, a, 0.016, 1]); } }
}
