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
import { MAPS } from '../../world/maps.js';

export const COL = { own: '#4f8fe0', enemy: '#e0503f', contested: '#e0a33a', accent: '#d8b25a', front: '#f2e6c4', water: '#41606e' };
const KY = 110.57, KX = lat => 111.32 * Math.cos(lat * Math.PI / 180);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
function rng(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hash = s => { let h = 2166136261; for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
// v6: true to scale. Footprints at their real size (HEX 1: OSM outlines / 9-12 m village houses), heights x1.5 (VEX) so
// the one-storey villages still stand off the ground at strategic zoom; trees are real-sized crowns (7-10 m) at the
// same vertical exaggeration. Road / river / ditch widths are their real widths with a minimum on-screen width (see
// paintGroundV6). (Before v6: footprints x1.6, heights x2.6, 13-29 m wide / 27-59 m tall trees, 100 m wide roads.)
const VEX = 1.5, HEX = 1.0;
// ground texture resolution: ~8 m per pixel, at most 4096 px a side (the grown UA grid: ~10 m / px)
const GROUND_MPX = 8, GROUND_MAX = 4096;

// season palettes for the fields (Feb 2023 is late winter; the counteroffensive runs through high summer)
function season(date) {
  const m = +String(date).slice(5, 7);
  if (m === 12 || m <= 2) return { base: '#77786c', fields: ['#86887b', '#7a7c6f', '#919285', '#6f7064', '#8d8a7c'], tree: '#3c4033', wood: '#363b2f', grass: '#7c7f70', yard: '#5e5f50', name: 'winter' };
  if (m <= 4) return { base: '#5d5a42', fields: ['#655f45', '#56583d', '#6e6648', '#4d5236', '#5f6a3e'], tree: '#33402a', wood: '#2e3a26', grass: '#58613a', yard: '#454c31', name: 'spring' };
  if (m <= 6) return { base: '#56643a', fields: ['#5d6c3c', '#6a733f', '#4f6034', '#7a7845', '#617043'], tree: '#2c4024', wood: '#273a21', grass: '#5a6b36', yard: '#3f4f2b', name: 'summer' };
  if (m <= 8) return { base: '#857a4a', fields: ['#9a8c52', '#8a7f4a', '#a4945a', '#6f6e40', '#958653'], tree: '#33432a', wood: '#2c3d25', grass: '#7d7a48', yard: '#525a32', name: 'harvest' };
  return { base: '#675c41', fields: ['#6f6244', '#5f5a3e', '#7a6a48', '#58553b', '#6a5f40'], tree: '#3d3e2c', wood: '#363727', grass: '#666040', yard: '#4a4932', name: 'autumn' };
}

export class StrategicMap {
  constructor(container, C, osm = null, geo = null) {
    this.C = C; this.def = C.def; this.osm = osm; this.geo = geo?.geo || geo; this.el = container;
    this.on = {}; this.sel = null; this.hover = null; this.reachSet = null; this.showSupply = false; this.path = null;
    const A = this.def.aor, [latS, lonW, latN, lonE] = A.bbox;
    this.lat0 = (latS + latN) / 2; this.lon0 = (lonW + lonE) / 2; this.kx = KX(this.lat0);
    this.x0 = this.X(lonW); this.x1 = this.X(lonE); this.z0 = this.Z(latN); this.z1 = this.Z(latS);
    this.cw = (this.x1 - this.x0) / A.cols; this.ch = (this.z1 - this.z0) / A.rows;
    // v5: the grid can grow past the original AOR (growth.js): column / row numbers start at col0 / row0 (RU: negative
    // columns west of the original grid); the map is rebuilt for each grid version (C.gridV)
    this.col0 = A.col0 || 0; this.row0 = A.row0 || 0; this.gridV = C.gridV || 0;
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
    const tb0 = performance.now();
    this.buildTheatre(); this.buildAor(); this.buildBuildings(); this.buildOverlay(); this.buildDynamic();
    this.buildMs = Math.round(performance.now() - tb0);
    // camera state (target on the ground, distance in km, yaw, pitch = elevation angle)
    const c = this.aorCenter();
    this.cam = { x: c.x, z: c.z, dist: 26, yaw: 0.18, pitch: 0.92 };
    this.tcam = { ...this.cam };
    this.keys = new Set(); this.mouse = { x: -1, y: -1, in: false };
    this.bindInput();
    this.resize(); this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(container);
    this.setDate(C.date, false);
    this.refresh();
    this.t0 = performance.now(); this.last = this.t0; this.anims ||= []; this.fxFreeze = false;
    const loop = now => { if (this.dead) return; this.raf = requestAnimationFrame(loop); this.frame(Math.min(0.1, (now - this.last) / 1000), now); this.last = now; };
    this.raf = requestAnimationFrame(loop);
  }
  // ------------------------------------------------------------------ projection (km, x east, z south)
  X(lon) { return (lon - this.lon0) * this.kx; }
  Z(lat) { return -(lat - this.lat0) * KY; }
  V(ll, y = 0) { return new THREE.Vector3(this.X(ll[1]), y, this.Z(ll[0])); }
  cellCenter(id) { const c = this.C.cell(id); return new THREE.Vector3(this.x0 + (c.col - this.col0 + 0.5) * this.cw, 0, this.z0 + (c.row - this.row0 + 0.5) * this.ch); }
  cellAtWorld(x, z) { const col = Math.floor((x - this.x0) / this.cw) + this.col0, row = Math.floor((z - this.z0) / this.ch) + this.row0; return this.C.cellAt(col, row)?.id || null; }
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
    const wk = this.x1 - this.x0, hk = this.z1 - this.z0, v6 = !!this.geo?.ways;
    let W = v6 ? Math.round(wk * 1000 / GROUND_MPX) : 2048, H = Math.round(W * hk / wk);
    if (Math.max(W, H) > GROUND_MAX) { const k = GROUND_MAX / Math.max(W, H); W = Math.round(W * k); H = Math.round(H * k); }
    this.gW = W; this.gH = H;
    this.groundCv = document.createElement('canvas'); this.groundCv.width = W; this.groundCv.height = H;
    // painted once per season and uploaded as a texture: a CPU canvas (no GPU read-back of the ~50 MB ground on upload)
    this.groundCv.getContext('2d', { willReadFrequently: true });
    this.groundTex = new THREE.CanvasTexture(this.groundCv); this.groundTex.colorSpace = THREE.SRGBColorSpace; this.groundTex.anisotropy = 8;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(this.x1 - this.x0, this.z1 - this.z0), new THREE.MeshLambertMaterial({ map: this.groundTex }));
    m.rotation.x = -Math.PI / 2; m.position.set((this.x0 + this.x1) / 2, 0, (this.z0 + this.z1) / 2); this.scene.add(m); this.ground = m;
    // soft dark rim so the AOR reads as the lit, detailed area of the map
    const rim = new THREE.Mesh(new THREE.PlaneGeometry(this.x1 - this.x0 + 8, this.z1 - this.z0 + 8), new THREE.MeshBasicMaterial({ map: rimTexture(), transparent: true, depthWrite: false }));
    rim.rotation.x = -Math.PI / 2; rim.position.set((this.x0 + this.x1) / 2, -0.02, (this.z0 + this.z1) / 2); this.scene.add(rim);
    // DEM hillshade (geo_v6.py: relief_*.jpg), blended over the land cover: decoded by ui.js before the map is built
    // (geo.reliefImgs), else loaded here and the ground repainted when it arrives
    this.reliefImgs = [...(this.geo?.reliefImgs || [])];
    this.windbreaks = []; this.paintGround();
    if (!this.geo?.reliefImgs) for (const r of this.geo?.reliefs || (this.geo?.relief ? [this.geo.relief] : [])) {
      const img = new Image(); img.onload = () => { if (this.dead) return; this.reliefImgs.push({ img, bbox: r.bbox }); this.season = null; this.paintGround(); this.dirty = true; };
      img.src = new URL(r.url, document.baseURI).href;
    }
  }
  gP(lat, lon) { return [(this.X(lon) - this.x0) / (this.x1 - this.x0) * this.gW, (this.Z(lat) - this.z0) / (this.z1 - this.z0) * this.gH]; }
  paintGround() {
    const sea = season(this.C.date); if (this.season === sea.name) return; this.season = sea.name;
    if (this.geo?.ways) { this.paintGroundV6(sea); this.groundTex.needsUpdate = true; return; }
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
    const cellPx = c => [(c.col - this.col0) * cpx, (c.row - this.row0) * cpy];
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
      for (const c of cells) if (c.road) for (const n of this.C.neighbors(c.id)) { const d = this.C.cell(n); if (!d.road || (d.col !== c.col && d.row !== c.row)) continue; g.strokeStyle = c.road === 2 && d.road === 2 ? '#d9cfb2' : '#b0a78e'; g.lineWidth = c.road === 2 && d.road === 2 ? 4 : 2.5; g.beginPath(); g.moveTo((c.col - this.col0 + 0.5) * cpx, (c.row - this.row0 + 0.5) * cpy); g.lineTo((d.col - this.col0 + 0.5) * cpx, (d.row - this.row0 + 0.5) * cpy); g.stroke(); }
    }
    this.groundTex.needsUpdate = true;
  }
  // v6: the ground as it is (geo_v6.py): real field parcels with their furrow direction, woods and the shelter belts at
  // their real width, meadows, orchards, yards and garden plots, water, DEM hillshade, then the road and rail network
  // by class, rivers / streams and the mapped fortifications. Widths in metres, with a minimum on-screen width.
  paintGroundV6(sea) {
    const g = this.groundCv.getContext('2d'), W = this.gW, H = this.gH, G = this.geo, kmPx = W / (this.x1 - this.x0), mPx = kmPx / 1000;
    const ring = r => { r.forEach((p, i) => { const [a, b] = this.gP(p[0], p[1]); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.closePath(); };
    const poly = e => { g.beginPath(); for (const r of (e.r || [e])) ring(r); };
    const line = pts => { g.beginPath(); pts.forEach((p, i) => { const [a, b] = this.gP(p[0], p[1]); i ? g.lineTo(a, b) : g.moveTo(a, b); }); };
    const px = (m, min) => Math.max(min, m * mPx);
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.setLineDash([]);
    // ground OSM has no land use for (fallow, steppe, the inside of villages): the base colour, broken up softly
    g.fillStyle = sea.base; g.fillRect(0, 0, W, H);
    const R = rng(17);
    for (let i = 0; i < 260; i++) { g.globalAlpha = 0.18; g.fillStyle = sea.fields[Math.floor(R() * sea.fields.length)]; g.beginPath(); g.ellipse(R() * W, R() * H, (0.3 + R() * 0.9) * kmPx, (0.2 + R() * 0.5) * kmPx, R() * 3, 0, 7); g.fill(); }
    g.globalAlpha = 1;
    // fields: one colour per parcel (crop / stubble / fallow), furrows along the parcel's long side
    const fur = document.createElement('canvas'); fur.width = fur.height = 4; const fg = fur.getContext('2d'); fg.fillStyle = 'rgba(0,0,0,0.07)'; fg.fillRect(0, 0, 4, 1); fg.fillStyle = 'rgba(255,250,230,0.03)'; fg.fillRect(0, 2, 4, 1);
    const pat = g.createPattern(fur, 'repeat');
    (G.fields || []).forEach((e, i) => {
      const h = hash('f' + i), r = e.r ? e.r[0] : e; poly(e);
      g.fillStyle = sea.fields[h % sea.fields.length]; g.fill('evenodd');
      let best = 0, ang = 0; for (let k = 1; k < r.length; k++) { const [a, b] = this.gP(r[k - 1][0], r[k - 1][1]), [c, d] = this.gP(r[k][0], r[k][1]), L = Math.hypot(c - a, d - b); if (L > best) { best = L; ang = Math.atan2(d - b, c - a); } }
      pat.setTransform(new DOMMatrix().rotateSelf(0, 0, ang * 180 / Math.PI)); g.fillStyle = pat; g.globalAlpha = 0.55 + ((h >>> 8) & 3) * 0.15; g.fill('evenodd'); g.globalAlpha = 1;
      g.strokeStyle = 'rgba(38,34,24,0.32)'; g.lineWidth = 0.8; g.stroke();
    });
    g.fillStyle = sea.grass; for (const e of G.grass || []) { poly(e); g.fill('evenodd'); }
    g.fillStyle = '#4f5a3a'; g.globalAlpha = 0.85; for (const e of G.wet || []) { poly(e); g.fill('evenodd'); } g.globalAlpha = 1;
    // orchards / vineyards / allotments: rows of small crowns
    for (const e of G.orchards || []) { poly(e); g.fillStyle = sea.grass; g.fill('evenodd'); g.save(); g.clip('evenodd'); g.fillStyle = sea.tree; const r = e.r ? e.r[0] : e, xs = [], ys = []; for (const p of r) { const [a, b] = this.gP(p[0], p[1]); xs.push(a); ys.push(b); } const st = Math.max(1.6, 6 * mPx); for (let x = Math.min(...xs); x < Math.max(...xs); x += st) for (let y = Math.min(...ys); y < Math.max(...ys); y += st) g.fillRect(x, y, st * 0.55, st * 0.55); g.restore(); }
    // built-up land use, then the village garden plots behind every house (inferred plots: the strip away from the street)
    const BU = { res: 'rgba(118,114,98,0.62)', ind: 'rgba(122,119,110,0.85)', farm: 'rgba(118,108,88,0.75)', cem: 'rgba(70,80,62,0.8)' };
    for (const e of G.built || []) { const p = e.p || e; poly(p); g.fillStyle = BU[e.k] || BU.res; g.fill('evenodd'); }
    g.fillStyle = sea.yard; g.globalAlpha = 0.75;
    for (const q of G.plots || []) {
      const [la, lo, w, , a, sd = 1] = q, [cx, cy] = this.gP(la, lo), nx = -Math.sin(a) * sd, ny = -Math.cos(a) * sd;   // canvas y = south
      const fw = Math.max(w + 18, 26) * mPx, dd = 70 * mPx, ox = cx + nx * dd * 0.42, oy = cy + ny * dd * 0.42;
      g.setTransform(Math.cos(-a), Math.sin(-a), -Math.sin(-a), Math.cos(-a), ox, oy); g.fillRect(-fw / 2, -dd / 2, fw, dd); g.setTransform(1, 0, 0, 1, 0, 0);
    }
    g.globalAlpha = 0.5; g.fillStyle = sea.yard;
    for (const b of this.osm?.buildings || []) if (b[6] === 0) { const [a, c] = this.gP(b[0], b[1]); g.beginPath(); g.arc(a, c, 22 * mPx, 0, 7); g.fill(); }
    g.globalAlpha = 1;
    // woods and shelter belts, scrub, water
    g.fillStyle = sea.wood; for (const e of G.woods || []) { poly(e); g.fill('evenodd'); }
    g.fillStyle = sea.tree; g.globalAlpha = 0.7; for (const e of G.scrub || []) { poly(e); g.fill('evenodd'); } g.globalAlpha = 1;
    g.strokeStyle = sea.wood; g.lineCap = g.lineJoin = 'round'; g.lineWidth = px(9, 1.2); for (const t of G.treeRows || []) { line(t); g.stroke(); }
    g.fillStyle = COL.water; for (const e of G.water || []) { poly(e); g.fill('evenodd'); }
    // relief: DEM hillshade (128 = flat) blended over the land cover
    if (this.reliefImgs?.length) {
      g.globalCompositeOperation = 'overlay'; g.globalAlpha = 0.6;
      for (const { img, bbox: [s0, w0, n0, e0] } of this.reliefImgs) { const [a, b] = this.gP(n0, w0), [c, d] = this.gP(s0, e0); g.drawImage(img, a, b, c - a, d - b); }
      g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    }
    // water lines
    g.lineCap = g.lineJoin = 'round'; g.strokeStyle = COL.water;
    for (const r of G.streams || []) { g.globalAlpha = r.w === 'stream' || r.w === 'canal' ? 0.95 : 0.55; g.lineWidth = r.w === 'canal' ? px(8, 1.2) : r.w === 'stream' ? px(4, 1) : px(2, 0.7); line(r.pts); g.stroke(); }
    g.globalAlpha = 1; g.lineWidth = px(18, 2.2); for (const r of G.rivers || []) { line(r.pts); g.stroke(); }
    // roads by class: real carriageway + verge width, with a minimum on-screen width (main roads ~1.6x at 8 m / px)
    const RC = { track: [3, 0.8, 'rgba(150,136,104,0.5)', 0], service: [3.5, 0.8, 'rgba(172,162,136,0.75)', 0], residential: [6, 1, 'rgba(176,166,138,0.9)', 0], unclassified: [6, 1.2, '#b8ad90', 0], tertiary: [8, 1.7, '#c4b99a', 1], secondary: [11, 2.2, '#d2c8a8', 1], primary: [14, 2.8, '#ddd2b4', 1] };
    const order = ['track', 'service', 'residential', 'unclassified', 'tertiary', 'secondary', 'primary'], ways = G.ways || [];
    for (const pass of [0, 1]) for (const c of order) {
      const [wm, mn, col, casing] = RC[c]; if (!pass && !casing) continue;
      g.strokeStyle = pass ? col : 'rgba(30,28,22,0.6)'; g.lineWidth = px(wm, mn) + (pass ? 0 : 1.2);
      for (const w of ways) if (w.c === c) { line(w.pts); g.stroke(); }
    }
    // rail (disused lines lighter), ties dashed
    for (const r of G.rail || []) { if (r.state === 'abandoned') continue; const dim = r.state === 'disused'; line(r.pts); g.strokeStyle = dim ? 'rgba(70,64,52,0.55)' : 'rgba(52,47,38,0.95)'; g.lineWidth = px(6, 1.6); g.stroke(); g.strokeStyle = 'rgba(190,180,160,0.5)'; g.lineWidth = 0.7; g.setLineDash([2, 2]); g.stroke(); g.setLineDash([]); }
    // fortifications as mapped: anti-tank ditches (~6 m) with the spoil berm, trenches, dragon's teeth; bunkers
    for (const f of G.forts || []) {
      line(f.pts);
      if (f.kind === 'teeth') { g.strokeStyle = 'rgba(225,220,205,0.85)'; g.lineWidth = px(3, 1.2); g.setLineDash([1.2, 1.4]); g.stroke(); g.setLineDash([]); continue; }
      g.strokeStyle = 'rgba(26,20,13,0.92)'; g.lineWidth = f.kind === 'trench' ? px(2, 1.1) : px(6, 1.6); g.stroke();
      g.strokeStyle = 'rgba(205,185,145,0.38)'; g.lineWidth = 0.6; g.stroke();
    }
    g.fillStyle = 'rgba(26,20,13,0.95)'; const bs = px(6, 2.4); for (const b of G.bunkers || []) { const [a, c] = this.gP(b[0], b[1]); g.fillRect(a - bs / 2, c - bs / 2, bs, bs); }
  }
  // ------------------------------------------------------------------ 3D settlements and trees
  buildBuildings() {
    const A = this.def.aor, [latS, lonW, latN, lonE] = A.bbox, inAor = (la, lo) => la >= latS && la <= latN && lo >= lonW && lo <= lonE;
    const list = [];   // [x, z, w(km), d(km), angle, h(km), kind, cellId]
    // water mask (reservoirs, ponds): no procedural houses or trees standing in the water
    const wet = [...(this.osm?.water || []), ...(this.geo?.water || [])].map(w => { const pts = (w.r ? w.r[0] : w).map(p => [this.X(p[1]), this.Z(p[0])]), xs = pts.map(p => p[0]), zs = pts.map(p => p[1]); return { pts, x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) }; });
    const inWater = (x, z) => wet.some(w => x >= w.x0 && x <= w.x1 && z >= w.z0 && z <= w.z1 && pip([x, z], w.pts));
    for (const b of this.osm?.buildings || []) if (inAor(b[0], b[1])) list.push([this.X(b[1]), this.Z(b[0]), b[2] / 1000, b[3] / 1000, b[4], b[5] / 1000, b[6]]);
    // v6: houses on the village streets OSM has no footprints for (geo_v6.py plots: one-storey, 5 m to the ridge)
    for (const q of this.geo?.plots || []) if (inAor(q[0], q[1])) list.push([this.X(q[1]), this.Z(q[0]), q[2] / 1000, q[3] / 1000, q[4], 0.005, 0]);
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
    const v6 = !!this.geo?.ways, TMAX = v6 ? 50000 : 18000;
    const inside = (x, z) => x > this.x0 && x < this.x1 && z > this.z0 && z < this.z1;
    const trees = [], RT = rng(9), add = (x, z) => { if (trees.length < TMAX && (!v6 || inside(x, z)) && !inWater(x, z)) trees.push([x, z, 0.75 + RT() * 0.4]); };
    const along = (ax, az, bx, bz, step) => { const L = Math.hypot(bx - ax, bz - az), n = Math.floor(L / step); for (let i = 0; i <= n; i++) add(lerp(ax, bx, i / Math.max(1, n)) + (RT() - 0.5) * (v6 ? 0.003 : 0.01), lerp(az, bz, i / Math.max(1, n)) + (RT() - 0.5) * (v6 ? 0.003 : 0.01)); };
    if (v6) {
      // v6: every wood and shelter belt filled with real-sized crowns on a jittered grid: belts (< 60 m wide) at ~11 m,
      // woods at ~24 m (their dark ground carries the rest); spacing grows evenly if the total would pass TMAX
      const W6 = (this.geo.woods || []).map(e => { const r = (e.r ? e.r[0] : e).map(p => [this.X(p[1]), this.Z(p[0])]); let A = 0, P = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { A += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); P += Math.hypot(r[i][0] - r[j][0], r[i][1] - r[j][1]); } A = Math.abs(A) / 2; const sp = 2 * A / (P || 1) < 0.06 ? 0.011 : 0.024; return { r, A, sp }; })
        .filter(w => w.r.some(([x, z]) => inside(x, z)));
      const rowsL = (this.geo.treeRows || []).reduce((a, t) => a + t.length, 0);
      const est = W6.reduce((a, w) => a + w.A / (w.sp * w.sp), 0) + rowsL * 20, k = Math.sqrt(Math.max(1, est / (TMAX * 0.95)));
      for (const w of W6) { const xs = w.r.map(p => p[0]), zs = w.r.map(p => p[1]), sp = w.sp * k; for (let x = Math.min(...xs) + sp / 2; x < Math.max(...xs); x += sp) for (let z = Math.min(...zs) + sp / 2; z < Math.max(...zs); z += sp) { const jx = x + (RT() - 0.5) * sp * 0.7, jz = z + (RT() - 0.5) * sp * 0.7; if (pip([jx, jz], w.r)) add(jx, jz); } }
      for (const t of this.geo.treeRows || []) for (let i = 1; i < t.length; i++) along(this.X(t[i - 1][1]), this.Z(t[i - 1][0]), this.X(t[i][1]), this.Z(t[i][0]), 0.009 * k);
    } else {
    for (const t of this.osm?.treeRows || []) for (let i = 1; i < t.length; i++) along(this.X(t[i - 1][1]), this.Z(t[i - 1][0]), this.X(t[i][1]), this.Z(t[i][0]), 0.03);
    for (const w of this.osm?.woods || []) { const pts = w.map(p => [this.X(p[1]), this.Z(p[0])]); const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]); const bx0 = Math.min(...xs), bx1 = Math.max(...xs), bz0 = Math.min(...zs), bz1 = Math.max(...zs); const n = Math.min(400, Math.ceil((bx1 - bx0) * (bz1 - bz0) / 0.0016)); for (let i = 0; i < n; i++) { const x = lerp(bx0, bx1, RT()), z = lerp(bz0, bz1, RT()); if (pip([x, z], pts)) add(x, z); } }
    // woods and tree belts of the AOR extract (sampled, densest first: belts are thin and long)
    for (const w of this.geo?.woods || []) { if (trees.length >= 18000) break; const pts = w.map(p => [this.X(p[1]), this.Z(p[0])]); const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]); const bx0 = Math.min(...xs), bx1 = Math.max(...xs), bz0 = Math.min(...zs), bz1 = Math.max(...zs); const area = (bx1 - bx0) * (bz1 - bz0), n = Math.min(260, Math.ceil(area / 0.0012)); let got = 0; for (let i = 0; i < n * 3 && got < n; i++) { const x = lerp(bx0, bx1, RT()), z = lerp(bz0, bz1, RT()); if (pip([x, z], pts)) { add(x, z); got++; } } }
    for (const [ax, az, bx, bz] of this.windbreaks) { if (!inside(ax, az) && !inside(bx, bz)) continue; along(ax, az, bx, bz, 0.038); }
    for (const c of A.cells) if (c.terrain === 'forest' || c.terrain === 'balka') { const cc = this.cellCenter(c.id), r = rng(hash(c.id)); for (let i = 0; i < 160; i++) add(cc.x + (r() - 0.5) * this.cw * 0.8, cc.z + (r() - 0.5) * this.ch * (c.terrain === 'balka' ? 0.3 : 0.8)); }
    }
    // crown: 9 m across, 17 m tall at k = 1 (x VEX); pre-v6 a 22 m wide / 29 m tall crown without VEX
    const tg = v6 ? new THREE.OctahedronGeometry(0.0045, 0) : new THREE.OctahedronGeometry(0.011, 0); if (v6) { tg.scale(1, 1.9, 1); tg.translate(0, 0.0045 * 1.9 * 0.85, 0); } else { tg.scale(1, 1.3, 1); tg.translate(0, 0.012, 0); }
    const IT = new THREE.InstancedMesh(tg, new THREE.MeshLambertMaterial({ color: '#ffffff' }), Math.max(1, trees.length));
    trees.forEach(([x, z, k], i) => { if (!inside(x, z)) { m.makeScale(0, 0, 0); IT.setMatrixAt(i, m); return; } p.set(x, 0, z); s.set(k, k * (v6 ? VEX : 1.6), k); q.identity(); m.compose(p, q, s); IT.setMatrixAt(i, m); IT.setColorAt(i, col.set(this.treeColor(RT()))); });
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
    g.clearRect(0, 0, W, H); g.save(); g.translate(-this.col0 * cx, -this.row0 * cy);
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
    g.restore(); this.ovTex.needsUpdate = true;
    // front line along the cell borders (3D, crisp at every zoom)
    const seg = [];
    for (const c of A.cells) { const o = C.owner[c.id] === 'player'; for (const [dc, dr] of [[1, 0], [0, 1]]) { const n = C.cellAt(c.col + dc, c.row + dr); if (!n || (C.owner[n.id] === 'player') === o) continue;
      const x = this.x0 + (c.col - this.col0 + 1) * this.cw, z = this.z0 + (c.row - this.row0 + 1) * this.ch;
      if (dc) seg.push(x, 0.01, z - this.ch, x, 0.01, z); else seg.push(x - this.cw, 0.01, z, x, 0.01, z); } }
    if (this.cellFront) { this.scene.remove(this.cellFront, this.cellFrontG); this.cellFront.geometry.dispose(); this.cellFrontG.geometry.dispose(); }
    if (seg.length) { const g1 = new LineSegmentsGeometry(); g1.setPositions(seg); const g2 = new LineSegmentsGeometry(); g2.setPositions(seg); this.cellFront = new LineSegments2(g1, this.cellFrontMat); this.cellFrontG = new LineSegments2(g2, this.cellFrontGlow); this.cellFront.renderOrder = 4; this.cellFrontG.renderOrder = 3; this.scene.add(this.cellFrontG, this.cellFront); }
  }
  paintHighlight() {
    this.dirty = true;
    const C = this.C, A = this.def.aor, g = this.hlCv.getContext('2d'), s = 48; g.clearRect(0, 0, this.hlCv.width, this.hlCv.height); g.save(); g.translate(-this.col0 * s, -this.row0 * s);
    if (this.reachSet) for (const [id, kind] of this.reachSet) { const c = C.cell(id); if (!c) continue; g.fillStyle = kind === 'attack' ? 'rgba(224,80,63,0.22)' : 'rgba(150,200,255,0.16)'; g.fillRect(c.col * s, c.row * s, s, s); g.strokeStyle = kind === 'attack' ? 'rgba(255,120,100,0.75)' : 'rgba(170,210,255,0.55)'; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.strokeRect(c.col * s + 2, c.row * s + 2, s - 4, s - 4); g.setLineDash([]); }
    this.paintTargeting(g, s);
    if (this.selCell) { const c = C.cell(this.selCell); if (c) { g.strokeStyle = 'rgba(216,178,90,1)'; g.lineWidth = 3; g.strokeRect(c.col * s + 1.5, c.row * s + 1.5, s - 3, s - 3); } }
    if (this.hover) { const c = C.cell(this.hover); if (c) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(c.col * s, c.row * s, s, s); g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2; g.strokeRect(c.col * s + 1, c.row * s + 1, s - 2, s - 2); } }
    g.restore(); this.hlTex.needsUpdate = true;
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
  // ------------------------------------------------------------------ v7: fire missions (ArtyFx) and recon UAVs
  // A fire mission as the player orders it (ui.js targetClick): muzzle flashes and smoke at the battery's gun line, shell
  // tracers / rocket trails along the arcs, staggered bursts in the target square (pattern by mission: suppression spread
  // over the square, interdiction walking along the road, counter-battery a tight sheaf on the found guns), craters for
  // the rest of the week. `mission` may still be a colour (old callers): suppression.
  get afx() {
    if (this._afx) return this._afx;
    const fx = this._afx = new ArtyFx(this.scene);
    // shell arcs as fat dashed lines (2 px, readable on the pale winter ground); materials registered for resize
    fx.lineFactory = (pts, color) => { const g = new LineGeometry(); g.setPositions(pts); const m = this.lineMat(color, 2, 0, true); m.transparent = true; m.depthTest = true; m.dashSize = 0.2; m.gapSize = 0.14; m.resolution.set(this.W * this.renderer.getPixelRatio(), this.H * this.renderer.getPixelRatio()); const l = new Line2(g, m); l.computeLineDistances(); l.renderOrder = 10; return l; };
    fx.lineDispose = l => { l.geometry.dispose(); l.material.dispose(); const i = this.lineMats.indexOf(l.material); if (i >= 0) this.lineMats.splice(i, 1); };
    return fx;
  }
  strike(cellId, mission = 'suppress', bat = null, res = null) {
    if (!this.C.cell(cellId)) return;
    if (typeof mission !== 'string' || mission[0] === '#') mission = 'suppress';
    const C = this.C, key = `${C.turn}|player|${mission}|${cellId}|${bat?.id}`;
    this.syncFires(); this.fxLive.add(key); this.afx.decals.delete(key);
    this.fireMission({ side: 'player', kind: mission, bkind: bat?.kind, from: bat?.cell, cell: cellId, key, hits: res?.hits || 0 });
    this.dirty = true;
  }
  fxAdvance(s) { if (this.fxPending?.length) { for (const o of this.fxPending) this.fireMission(o); this.fxPending = null; } const n = Math.round(s * 30); for (let i = 0; i < n; i++) this.afx.update(1 / 30); this.dirty = true; }
  // unit vector (x, z) from the front towards `side`'s rear
  rearDir(side) {
    const C = this.C, k = `${C.turn}|${side}`; if (this._rear?.k === k) return this._rear.d;
    let ox = 0, oz = 0, on = 0, ex = 0, ez = 0, en = 0;
    for (const c of C.def.aor.cells) { const p = this.cellCenter(c.id); if (C.owner[c.id] === 'player') { ox += p.x; oz += p.z; on++; } else { ex += p.x; ez += p.z; en++; } }
    let d = on && en ? [ox / on - ex / en, oz / on - ez / en] : [0, this.def.aor.enemyEdge === 'north' ? 1 : -1]; if (side !== 'player') d = [-d[0], -d[1]];
    const L = Math.hypot(d[0], d[1]) || 1; d = [d[0] / L, d[1] / L]; this._rear = { k, d }; return d;
  }
  // the longest stretch of the best road class inside a square, as [[x, z], ...] (falls back to the grid's road links)
  roadInCell(cellId) {
    this._roads ||= new Map(); if (this._roads.has(cellId)) return this._roads.get(cellId);
    const c = this.C.cell(cellId), p = this.cellCenter(cellId), hw = this.cw / 2 - 0.03, hh = this.ch / 2 - 0.03, inside = (x, z) => Math.abs(x - p.x) < hw && Math.abs(z - p.z) < hh;
    const W = { primary: 6, secondary: 5, tertiary: 4, unclassified: 3, residential: 1.5, track: 1, service: 0.5 };
    let best = null, bs = 0;
    for (const w of this.geo?.ways || []) { const cw = W[w.c]; if (!cw) continue; let run = [];
      const done = () => { if (run.length > 1) { let L = 0; for (let i = 1; i < run.length; i++) L += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]); if (L * cw > bs) { bs = L * cw; best = run; } } run = []; };
      for (const q of w.pts) { const x = this.X(q[1]), z = this.Z(q[0]); if (inside(x, z)) run.push([x, z]); else done(); } done(); }
    if (!best || bs < 0.4) {
      const n = this.C.neighbors(cellId).map(id => this.C.cell(id)).find(d => d?.road && (d.col === c.col || d.row === c.row));
      const dir = n ? [n.col - c.col, n.row - c.row] : [1, 0]; best = [[p.x - dir[0] * hw, p.z - dir[1] * hh], [p.x + dir[0] * hw, p.z + dir[1] * hh]];
    }
    this._roads.set(cellId, best); return best;
  }
  // where the rounds of a mission fall: [{ x, z, t (fire time from the start), g (gun) }], deterministic per key
  impactPlan(o, D, T, dir, perp, r) {
    const cs = Math.min(this.cw, this.ch), gs = () => (r() + r() + r() - 1.5) * 2, out = [], mlrs = D.tube === 'mlrs', clampC = (x, z) => [clamp(x, T.x - cs * 0.47, T.x + cs * 0.47), clamp(z, T.z - cs * 0.47, T.z + cs * 0.47)];
    if (o.kind === 'interdict') {
      const road = this.roadInCell(o.cell), seg = []; let L = 0; for (let i = 1; i < road.length; i++) { const l = Math.hypot(road[i][0] - road[i - 1][0], road[i][1] - road[i - 1][1]); seg.push([L, l]); L += l; }
      const at = f => { let s = f * L; for (let i = 0; i < seg.length; i++) if (s <= seg[i][0] + seg[i][1] || i === seg.length - 1) { const k = clamp((s - seg[i][0]) / (seg[i][1] || 1), 0, 1); return [road[i][0] + (road[i + 1][0] - road[i][0]) * k, road[i][1] + (road[i + 1][1] - road[i][1]) * k]; } return road[0]; };
      const N = mlrs ? 22 : D.guns * 2 + 2, rev = r() < 0.5;
      for (let i = 0; i < N; i++) { const f = clamp((i + 0.5 + (r() - 0.5) * 0.7) / N, 0.02, 0.98), [x, z] = at(rev ? 1 - f : f); out.push({ x: x + (r() - 0.5) * 0.05, z: z + (r() - 0.5) * 0.05, t: i * (mlrs ? 0.11 : 0.42) + r() * 0.08, g: i }); }
      return out;
    }
    if (o.kind === 'counterbattery') {
      const B = (o.side === 'player' ? this.C.batteries('enemy') : this.C.batteries('player')).find(b => b.cell === o.cell);
      const rb = rng(hash((B?.id || 'x') + o.cell)), bc = [T.x + (rb() - 0.5) * 0.4 * cs, T.z + (rb() - 0.5) * 0.4 * cs], aims = [-1, 0, 1].map(i => [bc[0] + perp[0] * i * 0.09, bc[1] + perp[1] * i * 0.09]);
      o.cbAims = aims;
      const V = D.volleys + 1, G = mlrs ? 12 : D.guns;
      for (let v = 0; v < V; v++) for (let g = 0; g < G; g++) { const a = aims[(g + v) % 3], [x, z] = clampC(a[0] + gs() * 0.045, a[1] + gs() * 0.045); out.push({ x, z, t: mlrs ? (v * G + g) * 0.1 : v * 1.5 + g * 0.08 + r() * 0.1, g }); }
      return out;
    }
    // suppression: an aim point in the square, a dispersion ellipse long along the line of fire, each volley walked
    const sl = cs * (mlrs ? 0.25 : D.tube === 'mortar' ? 0.11 : 0.15), sc = cs * (mlrs ? 0.15 : D.tube === 'mortar' ? 0.09 : 0.12), aim = [T.x + (r() - 0.5) * 0.25 * cs, T.z + (r() - 0.5) * 0.25 * cs];
    const V = mlrs ? 1 : D.volleys, G = mlrs ? 32 : D.guns;
    for (let v = 0; v < V; v++) { const wv = (v - (V - 1) / 2) * 0.12 * cs, ax = aim[0] + perp[0] * wv + dir[0] * (r() - 0.5) * 0.1 * cs, az = aim[1] + perp[1] * wv + dir[1] * (r() - 0.5) * 0.1 * cs;
      for (let g = 0; g < G; g++) { const l = gs() * sl, w = gs() * sc, [x, z] = clampC(ax + dir[0] * l + perp[0] * w, az + dir[1] * l + perp[1] * w); out.push({ x, z, t: mlrs ? g * 0.1 + r() * 0.04 : v * 1.7 + g * 0.09 + r() * 0.12, g }); } }
    return out;
  }
  // o: { side, kind (mission), bkind (battery kind), from (battery square or null = hidden guns beyond the line), cell, key, hits, delay }
  fireMission(o) {
    const fx = this.afx, D = KIND_FX[o.bkind] || KIND_FX.how122, cs = Math.min(this.cw, this.ch), r = rng(hash(o.key || o.cell));
    const T = this.cellCenter(o.cell), hidden = !o.from || !this.C.cell(o.from);
    let A; if (hidden) { const rd = this.rearDir(o.side === 'player' ? 'player' : 'enemy'), km = D.tube === 'mortar' ? 5 : 11; A = { x: T.x + rd[0] * km + (r() - 0.5) * 3, z: T.z + rd[1] * km + (r() - 0.5) * 3 }; } else A = this.cellCenter(o.from);
    const rb = rng(hash(o.key + 'g')), bc = hidden ? [A.x, A.z] : [A.x + (rb() - 0.5) * 0.4 * cs, A.z + (rb() - 0.5) * 0.4 * cs];
    const dx = T.x - bc[0], dz = T.z - bc[1], L = Math.hypot(dx, dz) || 1, dir = [dx / L, dz / L], perp = [-dir[1], dir[0]];
    const n = D.guns, sp = D.tube === 'mlrs' ? 0.13 : D.tube === 'mortar' ? 0.05 : 0.085;
    const guns = [...Array(n)].map((_, i) => [bc[0] + perp[0] * (i - (n - 1) / 2) * sp + (rb() - 0.5) * 0.03, bc[1] + perp[1] * (i - (n - 1) / 2) * sp + (rb() - 0.5) * 0.03]);
    const pts = this.impactPlan(o, D, T, dir, perp, r), mlrs = D.tube === 'mlrs';
    const flight = D.tube === 'mortar' ? 1.2 + L * 0.13 : mlrs ? 1.1 + L * 0.07 : 1.4 + L * 0.08, h = L * (D.tube === 'mortar' ? 0.42 : mlrs ? 0.13 : 0.2);
    const t0 = o.delay || 0, ik = D.k;
    if (!hidden) fx.at(t0, () => fx.arcLine([bc[0], 0.02, bc[1]], [T.x, 0, T.z], h, o.side === 'player' ? 0xffd27a : 0xff8a70, flight + Math.max(...pts.map(p => p.t)) + 2));
    let last = 0; for (const p of pts) last = Math.max(last, p.t + flight);
    // what the mission is aimed at, faintly on the ground while it lasts: the road under interdiction (a glowing band
    // along it), the found guns under counter-battery fire (a ring)
    const warm = o.side === 'player' ? [1, 0.62, 0.25] : [1, 0.35, 0.25];
    if (o.kind === 'interdict') fx.at(t0, () => { const road = this.roadInCell(o.cell); for (let i = 1; i < road.length; i++) { const [a, b] = [road[i - 1], road[i]], l = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.ceil(l / 0.04); for (let j = 0; j < n; j++) { const f = j / n; fx.add({ x: a[0] + (b[0] - a[0]) * f, y: 0.004, z: a[1] + (b[1] - a[1]) * f, life: last + 5, s0: 0.1, s1: 0.1, tile: 4, mode: 1, c0: warm, a0: 0.5, fin: 0.06, fpow: 2.5, add: true }); } } });
    if (o.kind === 'counterbattery' && o.cbAims) fx.at(t0, () => { const a = o.cbAims[1]; fx.add({ x: a[0], y: 0.004, z: a[1], life: last + 5, s0: 0.42, s1: 0.36, tile: 7, mode: 1, c0: warm, a0: 0.55, fin: 0.05, fpow: 2.2, add: true }); });
    for (const p of pts) {
      const g = guns[p.g % n], fl = flight * (0.96 + r() * 0.08);
      fx.at(t0 + p.t, () => {
        if (!hidden) mlrs ? fx.rocketLaunch(g[0], g[1], dir, D.k) : fx.muzzle(g[0], g[1], dir, D.tube, D.k);
        fx.proj.push({ a: [g[0], 0.015, g[1]], b: [p.x, 0, p.z], h, dur: fl, t: 0, len: L + 1.5 * h, step: mlrs ? 0.025 : 0.05, rocket: mlrs, tracer: hidden ? 0.4 : 0.6, s: D.k, hit: () => fx.impact(p.x, p.z, ik, mlrs ? 'rocket' : 'shell', o.key) });
      });
    }
    // counter-battery hits: secondary explosions (ammunition cooking off) and black smoke over the guns
    if (o.hits && o.cbAims) for (let i = 0; i < 2 + o.hits; i++) { const a = o.cbAims[i % 3]; fx.at(t0 + last + 0.5 + i * 0.9 + r() * 0.4, () => fx.impact(a[0] + (Math.random() - 0.5) * 0.04, a[1] + (Math.random() - 0.5) * 0.04, 1.2, 'secondary', o.key)); }
  }
  // per week: craters / scorch of this week's fire missions (both sides, from C.fireLog), wind, and — when a new week
  // starts — the enemy's fire of the turn resolution played over the player's squares (staggered)
  syncFires() {
    const C = this.C, fx = this.afx, cur = (C.fireLog || []).filter(l => l.turn === C.turn), keyOf = l => `${l.turn}|${l.side}|${l.kind}|${l.cell}|${l.battery}`, keys = new Set(cur.map(keyOf));
    if (this.fxTurn !== C.turn) {
      const first = this.fxTurn == null; this.fxTurn = C.turn; this.fxLive = new Set();
      const wr = rng(hash('wind' + C.turn)), wa = wr() * 6.283, ws = 0.005 + wr() * 0.007; fx.wind = [Math.cos(wa) * ws, Math.sin(wa) * ws];
      if (!first) {
        const found = new Set((C.foundBatteries?.() || []).map(b => b.id));
        // queued: played once no modal (the weekly report) covers the map — see frame()
        this.fxPending = cur.filter(l => l.side === 'enemy' && C.cell(l.cell)).slice(0, 10).map((l, i) => { const k = keyOf(l), B = C.battery(l.battery); this.fxLive.add(k); fx.decals.delete(k);
          return { side: 'enemy', kind: l.kind, bkind: l.bkind || B?.kind, from: l.from !== undefined ? l.from : found.has(l.battery) ? B?.cell : null, cell: l.cell, key: k, delay: 0.6 + i * 2.6 }; });   // (versus: l.bkind / l.from, versus.js resolveFires)
      }
    }
    for (const k of [...fx.decals.keys()]) if (!keys.has(k) && !this.fxLive.has(k)) { fx.decals.delete(k); fx.decalDirty = true; }
    for (const l of cur) { const k = keyOf(l); if (fx.decals.has(k) || this.fxLive.has(k) || !C.cell(l.cell)) continue;
      const B = C.battery(l.battery), D = KIND_FX[l.bkind || B?.kind] || KIND_FX.how122, T = this.cellCenter(l.cell), fc = l.from !== undefined ? l.from : B?.cell, A = fc && C.cell(fc) ? this.cellCenter(fc) : { x: T.x, z: T.z + 1 };
      const L = Math.hypot(T.x - A.x, T.z - A.z) || 1, dir = [(T.x - A.x) / L, (T.z - A.z) / L], r = rng(hash(k)), r2 = rng(hash(k + 'd'));
      fx.decals.set(k, []);
      for (const p of this.impactPlan({ side: l.side, kind: l.kind, cell: l.cell }, D, T, dir, [-dir[1], dir[0]], r)) {
        const s = D.k;
        fx.addDecal(k, { x: p.x, y: 0.002, z: p.z, s: (0.045 + r2() * 0.02) * s * 1.35, rot: r2() * 6.28, tile: 8, mode: 1, r: 1, g: 1, b: 1, a: 0.92 });
        if (r2() < 0.6) fx.addDecal(k, { x: p.x, y: 0.0015, z: p.z, s: (0.12 + r2() * 0.06) * s * 1.35, rot: r2() * 6.28, tile: 9, mode: 1, r: 1, g: 1, b: 1, a: 0.75 });
      }
    }
    if (fx.decalDirty) { fx.writeDecals(); this.dirty = true; }
  }
  // ---- recon UAVs: sorties of this week (own: C.uavLog; enemy: C.uav.enemy.log) — [{ cell, type, side, lost, cells }].
  // A new sortie is launched from its own side's rear and joins a banked orbit over the target at altitude; at the end
  // of the week (uavDepart) every drone leaves the orbit towards its own rear, climbing, and fades out. Motion is a
  // function of the UAV clock (this.uavT): heading, bank and pitch come from the path's derivatives.
  setUavs(list) {
    this.uavGroup ||= (() => { const g = new THREE.Group(); this.scene.add(g); return g; })();
    this.uavT ??= 0; this.uavs ||= [];
    const seen = {}; list = (list || []).filter(u => !(u.lost && !u.cells?.length)).map(u => { const b = `${u.side || 'player'}|${u.type}|${u.cell}`; seen[b] = (seen[b] ?? -1) + 1; return { ...u, id: `${b}|${seen[b]}` }; });
    const key = JSON.stringify(list.map(u => [u.id, (u.cells || []).length]));
    if (key === this.uavKey) return; this.uavKey = key;
    const launch = !!this.uavInit; this.uavInit = true;
    const want = new Set(list.map(u => u.id));
    for (const u of [...this.uavs]) if (!u.leave && !want.has(u.id)) this.removeUav(u);
    let i = 0; for (const u of list) if (!this.uavs.some(x => x.id === u.id && !x.leave)) this.uavs.push(this.makeUav(u, launch, i++));
    this.dirty = true;
  }
  makeUav(u, launch, i) {
    const own = (u.side || 'player') === 'player', side = own ? this.def.id : (this.def.id === 'UA' ? 'RU' : 'UA'), quad = u.type === 'quad';
    const obj = uavModel(side, u.type), c = this.cellCenter(u.cell), tint = own ? '#9fe6ff' : '#ffb2a2';
    const R = quad ? 0.3 : side === 'RU' ? 0.8 : 0.62, alt = quad ? 0.2 : side === 'RU' ? 0.74 : 0.56, w = (quad ? 0.14 : side === 'RU' ? 0.25 : 0.3) * (hash(u.id) % 2 ? -1 : 1);
    const d = { id: u.id, obj, c, R, alt, w, quad, own, ph: (hash(u.id) % 628) / 100, t0: this.uavT, s0: obj.scale.x, mats: obj.userData.mats, props: [], gimbal: obj.getObjectByName('gimbal'), strobe: obj.getObjectByName('strobe') };
    obj.traverse(o => { if (o.name === 'prop' || o.name === 'rotor') d.props.push(o); });
    // the squares the drone sees (own sorties): a square outline
    const cells = own ? (u.cells || [u.cell]).map(id => this.C.cell(id)).filter(Boolean) : [];
    if (cells.length) {
      const c0 = Math.min(...cells.map(x => x.col)), c1 = Math.max(...cells.map(x => x.col)), r0 = Math.min(...cells.map(x => x.row)), r1 = Math.max(...cells.map(x => x.row));
      const x0 = this.x0 + (c0 - this.col0) * this.cw, x1 = this.x0 + (c1 - this.col0 + 1) * this.cw, z0 = this.z0 + (r0 - this.row0) * this.ch, z1 = this.z0 + (r1 - this.row0 + 1) * this.ch;
      const ag = new LineGeometry(); ag.setPositions([x0, 0.02, z0, x1, 0.02, z0, x1, 0.02, z1, x0, 0.02, z1, x0, 0.02, z0]);
      this.uavAreaMat ||= this.lineMat('#7fd6ff', 2, 0.6, true); d.area = new Line2(ag, this.uavAreaMat); d.area.computeLineDistances(); d.area.renderOrder = 8; this.uavGroup.add(d.area);
    }
    // soft ground shadow (blurred silhouette, offset along the sun), sensor footprint + faint view frustum
    const S = uavShadow(obj); d.shadow = new THREE.Mesh(new THREE.PlaneGeometry(S.w, S.d).rotateX(Math.PI / 2).translate(S.x, 0, S.z), new THREE.MeshBasicMaterial({ color: 0x000000, map: S.tex, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide })); d.shadow.renderOrder = 3;
    d.fp = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: footprintTex(), color: tint, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })); d.fp.renderOrder = 9;
    const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(24), 3));
    d.fr = new THREE.LineSegments(fg, new THREE.LineBasicMaterial({ color: tint, transparent: true, opacity: 0, depthWrite: false })); d.fr.frustumCulled = false; d.fr.renderOrder = 9;
    this.uavGroup.add(obj, d.shadow, d.fp, d.fr);
    if (launch) {
      const rd = this.rearDir(own ? 'player' : 'enemy'), dist = quad ? 2.6 : 5, dur = quad ? 7 : 9, t1 = this.uavT + i * 1.5;
      const P0 = [c.x + rd[0] * dist + (Math.random() - 0.5) * 1.5, 0.02, c.z + rd[1] * dist + (Math.random() - 0.5) * 1.5], E = this.uavOrbit(d, t1 + dur), E2 = this.uavOrbit(d, t1 + dur + 0.05), E1 = this.uavOrbit(d, t1 + dur - 0.05), V = [0, 1, 2].map(k => (E2[k] - E1[k]) / 0.1);
      const tdx = c.x - P0[0], tdz = c.z - P0[2], tl = Math.hypot(tdx, tdz) || 1;
      d.launch = { t0: t1, dur, P: [P0, [P0[0] + tdx / tl * dist * 0.35, alt * 0.7, P0[2] + tdz / tl * dist * 0.35], E.map((v, k) => v - V[k] * dur / 3), E] };
    }
    this.placeUav(d, this.uavT, 0); return d;
  }
  uavOrbit(d, t) {
    const a = d.ph + d.w * (t - d.t0);
    return d.quad ? [d.c.x + d.R * Math.cos(a), d.alt + 0.008 * Math.sin(t * 1.3 + d.ph), d.c.z + d.R * 0.65 * Math.sin(a)] : [d.c.x + d.R * Math.cos(a), d.alt + 0.012 * Math.sin(t * 0.8 + d.ph), d.c.z + d.R * Math.sin(a)];
  }
  uavPos(d, t) {
    const bez = (P, k) => { k = clamp(k, 0, 1); const m = 1 - k; return [0, 1, 2].map(i => m * m * m * P[0][i] + 3 * m * m * k * P[1][i] + 3 * m * k * k * P[2][i] + k * k * k * P[3][i]); };
    if (d.leave && t >= d.leave.t0) return bez(d.leave.P, (t - d.leave.t0) / d.leave.dur);
    if (d.launch && t < d.launch.t0 + d.launch.dur) return bez(d.launch.P, (t - d.launch.t0) / d.launch.dur);
    return this.uavOrbit(d, t);
  }
  removeUav(d) { this.uavGroup.remove(d.obj, d.shadow, d.fp, d.fr); if (d.area) this.uavGroup.remove(d.area); d.area?.geometry.dispose(); d.shadow.geometry.dispose(); d.fr.geometry.dispose(); d.obj.traverse(o => o.geometry?.dispose()); this.uavs.splice(this.uavs.indexOf(d), 1); }
  // end of the week: every drone breaks off towards its own rear, climbing, and fades out
  uavDepart() {
    for (const d of this.uavs || []) if (!d.leave) {
      const t = this.uavT, P0 = this.uavPos(d, t), a = this.uavPos(d, t - 0.05), b = this.uavPos(d, t + 0.05), V = [0, 1, 2].map(k => (b[k] - a[k]) / 0.1), rd = this.rearDir(d.own ? 'player' : 'enemy'), dur = 7;
      const P3 = [P0[0] + rd[0] * 7, P0[1] + 0.6, P0[2] + rd[1] * 7];
      d.leave = { t0: t, dur, P: [P0, P0.map((v, k) => v + V[k] * dur / 3), [P3[0] - rd[0] * 2.5, P3[1], P3[2] - rd[1] * 2.5], P3] };
      if (d.area) { this.uavGroup.remove(d.area); d.area.geometry.dispose(); d.area = null; }
    }
    this.uavKey = null; this.dirty = true;
  }
  uavAdvance(s) { this.uavT = (this.uavT || 0) + s; for (const d of [...(this.uavs || [])]) if (this.placeUav(d, this.uavT, 0)) this.removeUav(d); this.dirty = true; }
  placeUav(d, t, dt) {
    const P = this.uavPos(d, t), A = this.uavPos(d, t - 0.06), B = this.uavPos(d, t + 0.06), vx = (B[0] - A[0]) / 0.12, vy = (B[1] - A[1]) / 0.12, vz = (B[2] - A[2]) / 0.12, vh = Math.hypot(vx, vz);
    const hd = (t1, t2) => { const p = this.uavPos(d, t1), q = this.uavPos(d, t2); return Math.atan2(q[0] - p[0], q[2] - p[2]); };
    let yr = hd(t + 0.04, t + 0.16) - hd(t - 0.16, t - 0.04); yr = Math.atan2(Math.sin(yr), Math.cos(yr)) / 0.2;
    const yaw = Math.atan2(vx, vz);
    const roll = d.quad ? clamp(-yr * 0.5, -0.22, 0.22) : clamp(-yr * 1.25, -0.6, 0.6), pitch = d.quad ? clamp(vh * 2.4, 0, 0.32) : clamp(-Math.atan2(vy, vh + 1e-6), -0.35, 0.35);
    const o = d.obj; o.position.set(P[0], P[1], P[2]); o.rotation.set(pitch, yaw, roll, 'YXZ');
    const sc = clamp(this.cam.dist / 3.2, 1, 5); o.scale.setScalar(d.s0 * sc); d.shadow.scale.setScalar(d.s0 * sc);
    // visibility: fade in at the launch, out at the end of the departure
    let vis = 1, orbit = !(d.launch && t < d.launch.t0 + d.launch.dur) && !d.leave;
    if (d.launch && t < d.launch.t0 + d.launch.dur) vis = clamp((t - d.launch.t0) / 0.8, 0, 1);
    if (d.leave) vis = 1 - clamp(((t - d.leave.t0) / d.leave.dur - 0.5) / 0.5, 0, 1);
    o.visible = vis > 0.01;
    for (const m of d.mats) { m.userData.o0 ??= m.opacity; m.opacity = m.userData.o0 * vis; }
    for (const p of d.props) p.rotation.z += dt * 31;
    if (d.strobe) d.strobe.visible = ((t + d.ph) % 1.4) < 0.09;
    // shadow on the ground along the sun (DirectionalLight from (-0.6, 1, 0.4)), softer and fainter with height
    d.shadow.position.set(P[0] + 0.6 * P[1], 0.003, P[2] - 0.4 * P[1]); d.shadow.rotation.y = yaw; d.shadow.material.opacity = (d.quad ? 0.4 : 0.26) * vis;
    // gimbal on the look point (sweeping the observed square in orbit, ahead and down in transit) + footprint
    const lp = orbit ? [d.c.x + Math.sin(t * 0.19 + d.ph) * (d.quad ? 0.18 : 0.32) * this.cw, 0, d.c.z + Math.cos(t * 0.15 + d.ph) * (d.quad ? 0.15 : 0.28) * this.ch] : [P[0] + vx / (vh || 1) * 0.8, 0, P[2] + vz / (vh || 1) * 0.8];
    o.updateMatrixWorld(true);
    const gp = new THREE.Vector3(); if (d.gimbal) { d.gimbal.lookAt(lp[0], lp[1], lp[2]); d.gimbal.getWorldPosition(gp); } else gp.set(P[0], P[1], P[2]);
    d.fpA = clamp((d.fpA ?? 0) + (orbit ? dt : -dt) * 0.8, 0, 1);
    const fa = d.fpA * vis; d.fp.visible = d.fr.visible = fa > 0.01;
    if (fa > 0.01) {
      const lx = lp[0] - gp.x, lz = lp[2] - gp.z, rng3 = Math.hypot(lx, gp.y, lz), fw = rng3 * (d.quad ? 0.5 : 0.36), fd = rng3 * (d.quad ? 0.38 : 0.27), ly = Math.atan2(lx, lz);
      d.fp.position.set(lp[0], 0.006, lp[2]); d.fp.rotation.y = ly; d.fp.scale.set(fw, 1, fd * 1.25); d.fp.material.opacity = 0.55 * fa;
      const f = [Math.sin(ly), Math.cos(ly)], rt = [f[1], -f[0]], pa = d.fr.geometry.attributes.position.array; let k = 0;
      for (const [a, b] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) { pa[k++] = gp.x; pa[k++] = gp.y; pa[k++] = gp.z; pa[k++] = lp[0] + rt[0] * a * fw / 2 + f[0] * b * fd * 0.62; pa[k++] = 0.006; pa[k++] = lp[2] + rt[1] * a * fw / 2 + f[1] * b * fd * 0.62; }
      d.fr.geometry.attributes.position.needsUpdate = true; d.fr.material.opacity = 0.2 * fa;
    }
    if (d.area) d.area.material.opacity = 0.6;
    return d.leave && t >= d.leave.t0 + d.leave.dur;
  }
  animUavs(dt) {
    if (!this.uavs?.length) return false;
    if (!this.uavHold) this.uavT += Math.min(dt, 0.1);
    for (const d of [...this.uavs]) if (this.placeUav(d, this.uavT, this.uavHold ? 0 : dt)) this.removeUav(d);
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
    if ((this.C.gridV || 0) !== this.gridV && this.on.regrid) { this.on.regrid(); return; }   // v5: the grid has grown: rebuild
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
      const us = C.tfUnits(f), mpMax = C.tfMpMax(f), sp = C.spotStatus?.(f.id);
      if (sp?.spotted) e.classList.add('spotted');
      e.innerHTML = `<div class="c2-tok-ech">${echelon(us.length)}</div>${natoSvg(us)}<div class="c2-tok-n">${esc(f.name)}</div><div class="c2-tok-mp">${pips(f.mp, mpMax)}${(f.supply ?? 1) < 0.5 ? '<b class="c2-oos">NO SUPPLY</b>' : ''}${f.attacked ? '<b class="c2-used">ATTACKED</b>' : ''}${sp?.spotted ? '<b class="c2-spot">◉ SPOTTED</b>' : ''}</div><div class="c2-stem"></div>`;
      e.title = `${f.name}: ${us.length} units · MP ${fmt(f.mp)}/${mpMax} · ${f.stance}${sp?.spotted ? ` — SPOTTED: a formation this big (signature ${sp.sig}) is seen by the enemy up to ${sp.depth} squares behind the line; expect artillery and drones` : ''}`;
      if (sp?.spotted) this.spotRing(p, COL.enemy);
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
    // v5: enemy formations spotted because of their size (single player; versus: C.foes with .spotted)
    const spBy = {}; for (const f of C.spottedEnemy?.() || []) (spBy[f.cell] ||= []).push(f);
    for (const [cell, fs] of Object.entries(spBy)) fs.forEach((f, i) => {
      const p = this.cellCenter(cell); p.z += this.ch * 0.12; p.y = 0.02; const sx = (i - (fs.length - 1) / 2) * 46;
      const e = document.createElement('div'); e.className = 'c2-tok foe spotted' + (i ? ' compact' : '');
      const units = Array.from({ length: Math.min(6, f.n) }, (_, k) => ({ kind: f.kind === 'tank' ? 'tank' : k % 3 === 2 ? 'tank' : 'mech', veh: { kind: f.kind === 'tank' || k % 3 === 2 ? 'tank' : 'ifv' } }));
      e.innerHTML = `<div class="c2-tok-ech foe">${echelon(f.n)}</div>${natoSvg(units, 34, 34, true)}<div class="c2-tok-n foe">${esc(f.name)}</div><div class="c2-tok-mp"><b class="c2-spot">◉ SPOTTED</b></div><div class="c2-stem foe"></div>`;
      e.title = `Spotted without reconnaissance: ${f.name} — about ${f.n} companies massed here (signature ${f.sig}). Big formations give themselves away: a target for your guns and drones.`;
      e.addEventListener('pointerdown', ev => { ev.stopPropagation(); if (ev.button === 0) this.on.cell?.(cell); else if (ev.button === 2) { ev.preventDefault(); this.on.order?.(cell); } });
      e.addEventListener('contextmenu', ev => ev.preventDefault()); e.addEventListener('wheel', ev => this.onWheel(ev), { passive: false }); e.addEventListener('pointermove', ev => this.hoverAt(ev.clientX, ev.clientY));
      this.labels.appendChild(e); this.badges.push({ e, pos: p, foe: true, sx });
      if (!i) this.spotRing(this.cellCenter(cell), COL.accent);
    });
    // versus: the other player's task forces this side can see (hostile frames)
    const foeBy = {}; for (const f of C.foes || []) (foeBy[f.cell] ||= []).push(f);
    for (const [cell, fs] of Object.entries(foeBy)) fs.forEach((f, i) => {
      const p = this.cellCenter(cell); p.z -= this.ch * 0.05; p.y = 0.02; const sx = (i - (fs.length - 1) / 2) * 46;
      const e = document.createElement('div'); e.className = 'c2-tok foe' + (i ? ' compact' : '') + (f.spotted ? ' spotted' : '');
      e.innerHTML = `<div class="c2-tok-ech foe">${echelon(f.n)}</div>${natoSvg(f.units || [], 34, 34, true)}<div class="c2-tok-n foe">Enemy · ${f.n} unit${f.n === 1 ? '' : 's'}</div>${f.spotted ? '<div class="c2-tok-mp"><b class="c2-spot">◉ SPOTTED</b></div>' : ''}<div class="c2-stem foe"></div>`;
      if (f.spotted && !i) this.spotRing(this.cellCenter(cell), COL.accent);
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
    for (const g of (C.def.goal || C.def.vsGoal)?.cells || []) { const c = C.cell(g.cell); if (!c) continue; const p = this.cellCenter(g.cell); p.x += this.cw * 0.3; p.z -= this.ch * 0.34; p.y = 0.03;
      const e = document.createElement('div'); e.className = 'c2-goalm' + (C.owner[g.cell] === 'player' ? ' held' : ''); e.innerHTML = `<i>★</i><span>${g.pts}</span>`; e.title = `Operation goal: ${g.name || C.cellName(g.cell)} (${g.pts} pts)${C.owner[g.cell] === 'player' ? ' — held' : ''}`; this.labels.appendChild(e); this.badges.push({ e, pos: p }); }
    for (const b of C.batteries?.('player') || []) { const c = C.cell(b.cell); if (!c) continue; const p = this.cellCenter(b.cell); p.x -= this.cw * 0.3; p.z -= this.ch * 0.3; p.y = 0.03;
      const e = document.createElement('div'); e.className = 'c2-bat own' + (b.down ? ' down' : b.acted === C.turn ? ' used' : '') + (this.targeting?.bat === b.id ? ' sel' : ''); e.innerHTML = `<svg viewBox="0 0 24 18" width="22" height="16"><rect x="1" y="1" width="22" height="16" fill="${COL.own}" stroke="#0d1520" stroke-width="1.6"/><circle cx="12" cy="9" r="3" fill="#0d1520"/></svg>`; e.title = `${b.name}${b.down ? ' (being rebuilt)' : b.acted === C.turn ? ' (acted this week)' : ''}`; this.labels.appendChild(e); this.badges.push({ e, pos: p }); }
    for (const b of C.foundBatteries?.() || []) { const p = this.cellCenter(b.cell); p.x += this.cw * 0.28; p.z += this.ch * 0.1; p.y = 0.03;
      const e = document.createElement('div'); e.className = 'c2-bat foe'; e.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M12 1 L23 12 L12 23 L1 12 Z" fill="${COL.enemy}" stroke="#1a0c0a" stroke-width="1.6"/><circle cx="12" cy="12" r="3" fill="#1a0c0a"/></svg>`; e.title = `Enemy battery found: ${b.name || b.kind}`; this.labels.appendChild(e); this.badges.push({ e, pos: p }); }
    this.drawSupply(C.supplyNet?.player);
    this.setUavs([...(C.uavLog || []).filter(l => l.turn === C.turn).map(l => ({ cell: l.cell, type: l.type, side: 'player', lost: l.lost, cells: l.cells })),
      ...(C.uav?.enemy?.log || []).filter(l => l.turn === C.turn && !l.lost && C.cell(l.cell)).map(l => ({ cell: l.cell, type: l.type, side: 'enemy', cells: [l.cell] }))]);
    this.syncFires();
    // squares that just opened fade in
    const jo = C.justOpened?.length ? C.justOpened.join(',') + '@' + C.turn : null;
    if (jo && jo !== this.fadeKey) { this.fadeKey = jo; const F = this.fade = { cells: new Set(C.justOpened), k: 0 };   // overlapping fades: each steps its own object, only the current one is cleared
      (this.anims ||= []).push({ t: 0, dur: 2.2, step: k => { F.k = k; if (this.fade === F) this.paintOverlay(); }, done: () => { if (this.fade === F) { this.fade = null; this.paintOverlay(); } } }); }
    if (this.path) this.showPath(this.path, true);
    // place the new markers now (not on the next frame: they would flash in the top-left corner for a frame)
    if (this.camera && this.W) { this.updateCamera(); this.placeLabels(performance.now()); }
  }
  // a pulsing ring on the ground around a spotted formation
  spotRing(p, color) {
    const R = Math.min(this.cw, this.ch) * 0.42, m = new THREE.Mesh(new THREE.RingGeometry(R * 0.9, R, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthTest: false, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.position.set(p.x, 0.012, p.z); m.renderOrder = 6; m.userData.pulse = true; this.dyn.add(m);
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
  setSelectedCell(id) { this.selCell = id; this.paintHighlight(); this.showBattleArea(id); }
  // v6: the ground a battle on this square is fought over. The RTS battle maps are 1.28-1.4 km squares (a company's
  // attack sector) inside the 2 km grid square: drawn at their real place on the square whose real ground they are
  // (Robotyne / Avdiivka: >= 25% of the frame on the square), otherwise centred on the square (stand-in ground).
  battleFrame(id) {
    const c = id && this.C.cell(id), M = c && MAPS[this.C.battleMap ? this.C.battleMap(id) : c.battleMap]; if (!M) return null;   /* (battlemap.js: the real map only on its own square) */
    const size = (M.sizeM || 1400) / 1000, cc = this.cellCenter(id); let x = cc.x, z = cc.z, real = false;
    if (M.geo) { x = this.X(M.geo.lon); z = this.Z(M.geo.lat); real = true; }
    return { x, z, size, real, name: M.name, id: M.id, cellKm: Math.round(this.cw * 10) / 10 };
  }
  showBattleArea(id) {
    if (this.baLine) { this.scene.remove(this.baLine); this.baLine.geometry.dispose(); this.baLine = null; }
    if (this.baItem) { this.baItem.e.remove(); this.baItem = null; }
    const f = this.battleFrame(id); if (!f) { this.dirty = true; return; }
    const h = f.size / 2, g = new LineGeometry(); g.setPositions([[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].flatMap(([a, b]) => [f.x + a, 0.024, f.z + b]));
    this.baMat ||= this.lineMat('#f2e6c4', 1.8, 0.85, true); this.baMat.dashSize = 0.08; this.baMat.gapSize = 0.06; this.baMat.color.set(f.real ? '#bfe6a0' : '#f2e6c4');
    const l = new Line2(g, this.baMat); l.computeLineDistances(); l.renderOrder = 6; this.scene.add(l); this.baLine = l;
    this.baItem = this.label(new THREE.Vector3(f.x - h, 0.03, f.z - h), `battle area ${fmt(f.size)} km${f.real ? ' · real ground' : ` · ${esc(f.name)} stand-in`}`, 'c2-barea', { ax: 0, ay: 1.1 });
    this.dirty = true;
  }
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
    const flying = this.animUavs(dt);
    // v7: artillery effects (stepped by hand when frozen: fxAdvance), one more frame after the last particle died
    if (this.fxPending?.length && !document.querySelector('.c2-modal')) { for (const o of this.fxPending) this.fireMission(o); this.fxPending = null; }
    const fxOn = this._afx && !this.fxFreeze && this._afx.busy ? this._afx.update(dt) : false; if (this.fxWas && !fxOn) this.dirty = true; this.fxWas = fxOn;
    // v6: the slow re-render tick only while something pulses (the denser true-scale map is ~1M triangles: no idle redraws)
    const pulsing = this.dyn.children.some(o => o.userData.pulse) || this.badges.some(b => b.until);
    if (sig === this.lastSig && !this.dirty && !flying && !fxOn && !this.anims.length && (!pulsing || now - (this.lastRender || 0) < 140)) return;
    this.lastSig = sig; this.dirty = false; this.lastRender = now;
    this.updateCamera();
    // pulses
    const pulse = 0.55 + 0.35 * Math.sin(now / 260);
    for (const o of this.dyn.children) if (o.userData.pulse) o.material.opacity = pulse;
    if (this.pathMat.dashed) this.pathMat.dashOffset = -now / 900;
    this._afx?.setView(this.camera, this.H * this.renderer.getPixelRatio(), clamp(this.cam.dist / 6, 1, 3.5));
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
    if (this.baItem) put(this.baItem, d < 30);
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
// ---------------------------------------------------------------------------------------------- v7: recon UAV models
// Procedural, no markings, built in metres (forward = +Z, up = +Y, port = +X) and scaled to the map (km) with ONE
// exaggeration for the fixed wings (UAV_EXAG: Orlan-10 3.1 m span -> 217 m, Leleka-100 2.0 m -> 140 m) and a larger
// one for the 0.35 m quadcopter (UAV_EXAG_QUAD) so it stays readable; StrategicMap adds a minimum on-screen size.
//  UA 'wing': Leleka-100-style blended flying wing (swept, tapered, upturned wingtip fins, rear pusher prop, chin gimbal)
//  RU 'wing': Orlan-10-style high-wing monoplane (slim fuselage tapering into a tail boom, nose tractor prop, tailplane +
//             swept fin + ventral fin, gimbal ball under the fuselage, parachute hatch, whip antennas)
//  'quad':    DJI-Mavic-class folding quadcopter (rounded body, splayed arms, 4 rotors, front 3-axis gimbal camera)
// Details: lofted NACA-section wings, matte composite materials (camouflage on the Leleka in the shader), propeller
// discs with a motion-blur texture, gimbal (aimed at the target by the map), antennas, nav lights + strobe.
export const UAV_EXAG = 70, UAV_EXAG_QUAD = 190;
const nacaT = u => 5 * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);
// lofted lifting surface through airfoil sections S = [{ o: [x,y,z] leading edge, c: chord, t: thickness ratio }]
// chord along `cd`, thickness along `nd`; ends capped
function loftGeo(S, nd = [0, 1, 0], cd = [0, 0, -1], n = 9) {
  const us = []; for (let i = 0; i <= n; i++) us.push((1 - Math.cos(i / n * Math.PI)) / 2);
  const ring = []; for (let i = n; i >= 0; i--) ring.push([us[i], 1]); for (let i = 1; i < n; i++) ring.push([us[i], -1]);
  const R = ring.length, pos = [], idx = [];
  for (const s of S) for (const [u, sg] of ring) { const hh = nacaT(u) * s.t * s.c * sg; for (let k = 0; k < 3; k++) pos.push(s.o[k] + cd[k] * u * s.c + nd[k] * hh); }
  // winding so that the faces point outwards whatever the station order / thickness axis
  const sd = new THREE.Vector3().fromArray(S[S.length - 1].o).sub(new THREE.Vector3().fromArray(S[0].o)), flip = new THREE.Vector3(-cd[0], -cd[1], -cd[2]).cross(sd).dot(new THREE.Vector3(...nd)) < 0;
  const tri = (a, b, c) => flip ? idx.push(a, c, b) : idx.push(a, b, c);
  for (let j = 0; j < S.length - 1; j++) for (let i = 0; i < R; i++) { const a = j * R + i, b = j * R + (i + 1) % R, c = a + R, d = b + R; tri(a, b, c); tri(b, d, c); }
  for (const j of [0, S.length - 1]) { const le = j * R + n; for (let i = 0; i < R; i++) { const a = j * R + i, b = j * R + (i + 1) % R; if (a === le || b === le) continue; j ? tri(le, a, b) : tri(le, b, a); } }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
// body of revolution along Z from a profile [[r, z], ...] (nose first); sy squashes the section vertically
function latheZ(prof, sx = 1, sy = 1, seg = 18) {
  const g = new THREE.LatheGeometry(prof.map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-4), -z)), seg); g.rotateX(-Math.PI / 2); g.scale(sx, sy, 1); g.computeVertexNormals(); return g;
}
// matte composite with an optional procedural camouflage (object-space noise, crisp blotches)
function uavMat(base, camo = null, opt = {}) {
  const m = new THREE.MeshStandardMaterial({ color: base, roughness: opt.rough ?? 0.82, metalness: opt.metal ?? 0.04, transparent: true, side: opt.side ?? THREE.FrontSide });
  if (camo) {
    m.onBeforeCompile = sh => {
      sh.uniforms.cA = { value: new THREE.Color(camo[0]) }; sh.uniforms.cB = { value: new THREE.Color(camo[1]) }; sh.uniforms.cS = { value: camo[2] || 4 };
      sh.vertexShader = 'varying vec3 vCam;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvCam = position;');
      sh.fragmentShader = `varying vec3 vCam; uniform vec3 cA, cB; uniform float cS;
float h3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vn(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }
` + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
{ vec3 q = vCam * cS; float n = vn(q) * 0.62 + vn(q * 2.7 + 7.1) * 0.38;
  diffuseColor.rgb = n > 0.6 ? cA : (n < 0.36 ? cB : diffuseColor.rgb); }`);
    };
    m.customProgramCacheKey = () => 'uavcamo';
  }
  return m;
}
let _propTex = null, _glowTex = null;
// motion-blurred two-blade propeller disc: faint ghost blades (conic gradient), brighter tip ring, clear hub
function propTex() {
  if (_propTex) return _propTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const g = cv.getContext('2d');
  const cg = g.createConicGradient(0, 64, 64);
  for (let i = 0; i <= 16; i++) { const a = i / 16, b = Math.abs(((a * 2) % 1) - 0.5) * 2; cg.addColorStop(a, `rgba(30,32,34,${(0.12 + 0.42 * Math.pow(1 - b, 3)).toFixed(3)})`); }
  g.fillStyle = cg; g.beginPath(); g.arc(64, 64, 62, 0, 7); g.fill();
  g.globalCompositeOperation = 'destination-out'; const rg = g.createRadialGradient(64, 64, 4, 64, 64, 64); rg.addColorStop(0, 'rgba(0,0,0,1)'); rg.addColorStop(0.16, 'rgba(0,0,0,0.6)'); rg.addColorStop(0.5, 'rgba(0,0,0,0.25)'); rg.addColorStop(0.92, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(0,0,0,1)'); g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = 'source-over'; g.strokeStyle = 'rgba(70,72,74,0.35)'; g.lineWidth = 3; g.beginPath(); g.arc(64, 64, 58, 0, 7); g.stroke();
  _propTex = new THREE.CanvasTexture(cv); _propTex.colorSpace = THREE.SRGBColorSpace; return _propTex;
}
function glowTex() {
  if (_glowTex) return _glowTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d'), rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.2, 'rgba(255,255,255,0.8)'); rg.addColorStop(0.5, 'rgba(255,255,255,0.18)'); rg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
  _glowTex = new THREE.CanvasTexture(cv); return _glowTex;
}
// sensor footprint on the ground: faint fill, corner brackets, a small centre cross
let _fpTex = null;
function footprintTex() {
  if (_fpTex) return _fpTex;
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const g = cv.getContext('2d');
  const rg = g.createRadialGradient(64, 64, 10, 64, 64, 80); rg.addColorStop(0, 'rgba(255,255,255,0.16)'); rg.addColorStop(1, 'rgba(255,255,255,0.03)'); g.fillStyle = rg; g.fillRect(4, 4, 120, 120);
  g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 3; const b = 22;
  for (const [x, y, sx, sy] of [[4, 4, 1, 1], [124, 4, -1, 1], [124, 124, -1, -1], [4, 124, 1, -1]]) { g.beginPath(); g.moveTo(x + sx * b, y); g.lineTo(x, y); g.lineTo(x, y + sy * b); g.stroke(); }
  g.lineWidth = 2; g.beginPath(); g.moveTo(56, 64); g.lineTo(72, 64); g.moveTo(64, 56); g.lineTo(64, 72); g.stroke();
  _fpTex = new THREE.CanvasTexture(cv); return _fpTex;
}
export function uavModel(side, type, cell = 2) {
  const g = new THREE.Group(), mats = [], add = (geo, mat, name) => { const m = new THREE.Mesh(geo, mat); if (name) m.name = name; g.add(m); return m; };
  const M = (...a) => { const m = uavMat(...a); mats.push(m); return m; };
  const dark = M('#26282a', null, { rough: 0.6 }), glass = M('#0b0f14', null, { rough: 0.15, metal: 0.3 }), grey = M('#3c3f42', null, { rough: 0.55, metal: 0.2 });
  const cyl = (r0, r1, h, s = 10) => new THREE.CylinderGeometry(r0, r1, h, s);
  // propeller: hub + spinner, blades (hidden in flight) and the blurred disc; axis = local +Z of the 'prop' group
  const prop = (x, y, z, D, axis = 'z', name = 'prop') => {
    const p = new THREE.Group(); p.name = name; p.position.set(x, y, z); if (axis === 'y') p.rotation.x = -Math.PI / 2; g.add(p);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(D / 2, 32), new THREE.MeshBasicMaterial({ map: propTex(), transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.9 })); disc.name = 'disc'; mats.push(disc.material); p.add(disc);
    for (const s of [-1, 1]) { const b = new THREE.Mesh(new THREE.BoxGeometry(D * 0.46, D * 0.07, D * 0.012), dark); b.position.x = s * D * 0.24; b.rotation.x = s * 0.35; b.name = 'blade'; b.visible = false; p.add(b); }
    p.add(new THREE.Mesh(cyl(D * 0.05, D * 0.07, D * 0.08).rotateX(Math.PI / 2), dark));
    return p;
  };
  const light = (x, y, z, col, name, sz) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: col, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); s.position.set(x, y, z); s.scale.setScalar(sz); if (name) s.name = name; mats.push(s.material); g.add(s); add(new THREE.SphereGeometry(sz * 0.12, 6, 4), new THREE.MeshBasicMaterial({ color: col })).position.set(x, y, z); };
  // gimbal: yoke + ball + lens (lens on local +Z; the map aims the 'gimbal' group at the target)
  const gimbal = (x, y, z, r, ballMat) => {
    const gg = new THREE.Group(); gg.name = 'gimbal'; gg.position.set(x, y, z); g.add(gg);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), ballMat); gg.add(ball);
    const lens = new THREE.Mesh(cyl(r * 0.42, r * 0.42, r * 0.3, 14).rotateX(Math.PI / 2), glass); lens.position.z = r * 0.88; gg.add(lens);
    const ir = new THREE.Mesh(cyl(r * 0.2, r * 0.2, r * 0.2, 10).rotateX(Math.PI / 2), glass); ir.position.set(r * 0.55, r * 0.35, r * 0.78); gg.add(ir);
    add(cyl(r * 0.55, r * 0.75, r * 0.5, 12), ballMat).position.set(x, y + r * 0.9, z);   // mount
    return gg;
  };
  let span, E = UAV_EXAG;
  if (type === 'quad') {
    // DJI Mavic 3 class: 0.35 m diagonal unfolded, 9.4" props; dark grey plastic
    E = UAV_EXAG_QUAD; span = 0.35;
    const body = M('#45494d', null, { rough: 0.5, metal: 0.1 }), top = M('#55595e', null, { rough: 0.45 });
    add(latheZ([[0, 0.115], [0.03, 0.11], [0.045, 0.09], [0.05, 0.03], [0.048, -0.04], [0.04, -0.09], [0.02, -0.11], [0, -0.112]], 1.0, 0.72, 20), body);
    add(new THREE.BoxGeometry(0.06, 0.012, 0.12).translate(0, 0.034, -0.02), top);   // battery top
    for (const s of [-1, 1]) { add(cyl(0.007, 0.007, 0.004, 10).rotateX(Math.PI / 2).translate(s * 0.016, 0.006, 0.112), glass); add(cyl(0.006, 0.006, 0.004, 10).rotateZ(Math.PI / 2).translate(s * 0.046, 0.0, 0.02), glass); }  // vision sensors
    // arms: front pair forward-outward at body height, rear pair lower and backward
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const front = sz > 0, ax = sx * 0.035, az = front ? 0.07 : -0.06, mx = sx * 0.125, mz = front ? 0.125 : -0.105, my = front ? 0.012 : -0.008;
      const L = Math.hypot(mx - ax, mz - az), arm = add(new THREE.BoxGeometry(0.016, 0.012, L), body); arm.position.set((ax + mx) / 2, my, (az + mz) / 2); arm.rotation.y = Math.atan2(mx - ax, mz - az);
      add(cyl(0.014, 0.016, 0.022, 14), dark).position.set(mx, my + 0.012, mz);
      if (front) add(cyl(0.003, 0.003, 0.035, 6), body).position.set(mx, my - 0.02, mz);   // landing leg
      prop(mx, my + 0.026, mz, 0.24, 'y', 'rotor');
      light(mx, my - 0.004, mz + (front ? 0.012 : -0.012), front ? '#ff4a3a' : '#5dff7a', front ? null : 'strobe', 0.03);
    }
    const gb = gimbal(0, -0.022, 0.12, 0.018, grey); gb.children[0].scale.set(1.25, 1, 1.1);
  } else if (side === 'RU') {
    // Orlan-10: 3.1 m span, ~2 m long, light grey composite
    span = 3.1; const body = M('#a3a6a0', ['#8e918b', '#b3b5ae', 1.3]);
    add(latheZ([[0, 0.98], [0.035, 0.97], [0.07, 0.93], [0.095, 0.84], [0.11, 0.7], [0.118, 0.45], [0.116, 0.15], [0.1, -0.1], [0.072, -0.32], [0.045, -0.52], [0.032, -0.8], [0.024, -1.0], [0, -1.02]], 0.86, 1.0, 20), body);
    // high wing on a fairing; constant-chord centre, tapered outer panels with a little dihedral
    add(new THREE.BoxGeometry(0.12, 0.05, 0.3).translate(0, 0.11, 0.07), body);
    const W = []; for (const x of [-1.55, -1.2, -0.62, 0, 0.62, 1.2, 1.55]) { const ax = Math.abs(x), out = Math.max(0, ax - 0.62); W.push({ o: [x, 0.145 + out * 0.07, 0.24 - out * 0.03], c: 0.3 - out * 0.09, t: 0.13 - out * 0.02 }); }
    add(loftGeo(W, [0, 1, 0], [0, 0, -1], 9), body);
    // empennage on the boom: tailplane, swept fin, ventral fin
    add(loftGeo([-0.36, 0, 0.36].map(x => ({ o: [x, 0.02, -0.76 - Math.abs(x) * 0.08], c: 0.17 - Math.abs(x) * 0.08, t: 0.09 }))), body);
    add(loftGeo([0, 0.14, 0.27].map(y => ({ o: [0, 0.02 + y, -0.72 - y * 0.55], c: 0.24 - y * 0.42, t: 0.09 })), [1, 0, 0]), body);
    add(loftGeo([0, -0.08].map(y => ({ o: [0, -0.01 + y, -0.82 + y * 0.4], c: 0.12 + y * 0.4, t: 0.09 })), [1, 0, 0]), body);
    add(new THREE.CapsuleGeometry(0.05, 0.16, 4, 10).rotateX(Math.PI / 2).scale(1, 0.55, 1).translate(0, 0.13, -0.22), body);   // parachute hatch
    add(cyl(0.012, 0.012, 0.09, 8).rotateX(Math.PI / 2).translate(0, -0.075, 0.85), dark);   // exhaust
    for (const z of [-0.36, -0.5]) add(cyl(0.003, 0.002, 0.22, 5).rotateX(-0.25).translate(0, 0.2, z), dark);   // whip antennas
    add(new THREE.BoxGeometry(0.004, 0.06, 0.05).translate(0, -0.13, -0.15), dark);   // blade antenna
    add(cyl(0.025, 0.025, 0.01, 12).translate(0, 0.165, 0.3), M('#d9dad5'));   // GPS puck
    gimbal(0, -0.125, 0.3, 0.065, M('#7e817b', null, { rough: 0.5 }));
    prop(0, 0, 1.0, 0.56);
    add(cyl(0.0, 0.04, 0.08, 12).rotateX(Math.PI / 2).translate(0, 0, 1.02), grey);   // spinner
    light(1.55, 0.18, 0.12, '#ff3b30', null, 0.16); light(-1.55, 0.18, 0.12, '#38ff6a', null, 0.16); light(0, 0.3, -0.98, '#ffffff', 'strobe', 0.18);
  } else {
    // Leleka-100: 2 m span, ~1.2 m long electric flying wing; olive-grey camouflage
    span = 2.0; const body = M('#6f7461', ['#545846', '#8b8e78', 3.2]);
    add(latheZ([[0, 0.52], [0.04, 0.5], [0.07, 0.44], [0.088, 0.32], [0.092, 0.12], [0.085, -0.12], [0.07, -0.3], [0.045, -0.42], [0.03, -0.47], [0, -0.48]], 1.15, 0.72, 20), body);
    const W = []; for (const x of [-1, -0.82, -0.5, -0.2, 0, 0.2, 0.5, 0.82, 1]) { const ax = Math.abs(x); W.push({ o: [x, ax * 0.035, 0.31 - ax * 0.5 + (ax < 0.2 ? 0 : 0)], c: ax < 0.2 ? 0.66 - ax * 0.9 : 0.48 - (ax - 0.2) * 0.33, t: ax < 0.2 ? 0.16 : 0.12 - ax * 0.02 }); }
    add(loftGeo(W, [0, 1, 0], [0, 0, -1], 9), body);
    for (const s of [-1, 1]) add(loftGeo([0, 0.09, 0.18].map(y => ({ o: [s * (1.0 + y * 0.04), 0.035 + y, -0.19 - y * 0.6], c: 0.22 - y * 0.5, t: 0.08 })), [1, 0, 0]), body);   // wingtip fins
    add(cyl(0.035, 0.05, 0.1, 12).rotateX(Math.PI / 2).translate(0, 0.01, -0.5), grey);   // motor
    add(cyl(0.003, 0.002, 0.16, 5).rotateX(-0.3).translate(0, 0.1, -0.12), dark);   // antenna
    add(cyl(0.022, 0.022, 0.008, 12).translate(0, 0.07, 0.12), M('#c9cbc2'));   // GPS puck
    gimbal(0, -0.068, 0.34, 0.052, M('#4e5244', null, { rough: 0.5 }));
    prop(0, 0.01, -0.57, 0.42);
    light(1.0, 0.04, -0.16, '#ff3b30', null, 0.13); light(-1.0, 0.04, -0.16, '#38ff6a', null, 0.13); light(0, 0.06, -0.44, '#ffffff', 'strobe', 0.14);
  }
  g.scale.setScalar(E / 1000);
  g.userData = { span: span * E / 1000, mats, type, side, E };
  return g;
}
// blurred top-down silhouette of a model (soft ground shadow), cached per model kind
const _shadowTex = {};
function uavShadow(obj) {
  const key = obj.userData.side + obj.userData.type; if (_shadowTex[key]) return _shadowTex[key];
  const box = new THREE.Box3(), v = new THREE.Vector3(); obj.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert(), tris = [];
  obj.traverse(o => { if (!o.isMesh || !o.visible || o.material.map) return; const p = o.geometry.attributes.position, ix = o.geometry.index, m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld), pts = [];
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m); pts.push([v.x, v.z]); box.expandByPoint(v); }
    const n = ix ? ix.count : p.count; for (let i = 0; i < n; i += 3) tris.push([0, 1, 2].map(k => pts[ix ? ix.getX(i + k) : i + k])); });
  for (const o of obj.children) if (o.name === 'prop' || o.name === 'rotor') { const d = o.children[0].geometry.parameters.radius; box.expandByPoint(v.set(o.position.x - d, 0, o.position.z - d)); box.expandByPoint(v.set(o.position.x + d, 0, o.position.z + d)); }
  const pad = 0.15 * Math.max(box.max.x - box.min.x, box.max.z - box.min.z), x0 = box.min.x - pad, z0 = box.min.z - pad, w = box.max.x - box.min.x + 2 * pad, d = box.max.z - box.min.z + 2 * pad;
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S; const g = cv.getContext('2d'); g.filter = 'blur(3px)'; g.fillStyle = '#000';
  const P = ([x, z]) => [(x - x0) / w * S, (1 - (z - z0) / d) * S];
  const tmp = document.createElement('canvas'); tmp.width = tmp.height = S; const t = tmp.getContext('2d'); t.fillStyle = '#000';
  for (const tr of tris) { t.beginPath(); tr.forEach((p, i) => { const [a, b] = P(p); i ? t.lineTo(a, b) : t.moveTo(a, b); }); t.fill(); }
  for (const o of obj.children) if (o.name === 'rotor') { const r = o.children[0].geometry.parameters.radius / w * S, [a, b] = P([o.position.x, o.position.z]); t.globalAlpha = 0.35; t.beginPath(); t.arc(a, b, r, 0, 7); t.fill(); t.globalAlpha = 1; }
  g.drawImage(tmp, 0, 0);
  const tex = new THREE.CanvasTexture(cv); return (_shadowTex[key] = { tex, x: x0 + w / 2, z: z0 + d / 2, w, d });
}
// ---------------------------------------------------------------------------------------------- v7: artillery effects
// One particle system for every fire mission on the map: two instanced billboard pools (alpha-blended smoke / dust and
// additive flashes / fire / tracers; a quad per particle, positions, sizes, colours written into instanced attributes
// each frame) and one static decal layer (craters and scorch marks, rebuilt only when it changes). Sizes are in km and
// exaggerated like the UAV models (a 152 mm burst ~100 m across), tracer heads keep a minimum size on screen.
// update() returns false once nothing is alive, so the map stops rendering when the fire is over.
const FXV = `attribute vec3 iPos; attribute vec4 iCol; attribute vec4 iP; uniform float uPx, uK; varying vec2 vUv; varying vec4 vCol;
void main() {
  float sz = iP.x * uK, s = sin(iP.y), c = cos(iP.y); vec2 q = position.xy; vec4 mv;
  if (iP.w > 0.5 && iP.w < 1.5) { vec2 r = vec2(q.x * c - q.y * s, q.x * s + q.y * c) * sz; mv = modelViewMatrix * vec4(iPos + vec3(r.x, 0.0, -r.y), 1.0); }
  else { mv = modelViewMatrix * vec4(iPos, 1.0); if (iP.w > 1.5) sz = max(sz, uPx * 2.6 * -mv.z); vec2 r = vec2(q.x * c - q.y * s, q.x * s + q.y * c) * sz; mv.xy += r; }
  gl_Position = projectionMatrix * mv;
  float t = iP.z; vUv = (vec2(mod(t, 4.0), 3.0 - floor(t / 4.0)) + uv) / 4.0; vCol = iCol;
}`;
const FXF = `uniform sampler2D map; varying vec2 vUv; varying vec4 vCol;
void main() { vec4 t = texture2D(map, vUv); float a = t.a * vCol.a; if (a < 0.004) discard; gl_FragColor = vec4(vCol.rgb * t.rgb, a); }`;
let _fxAtlas = null;
// 4x4 atlas of 128 px tiles: 0-3 shaded smoke puffs, 4 soft glow, 5 star flash, 6 spark, 7 shock ring, 8 crater,
// 9 scorch, 10 fireball, 11 clod
function fxAtlas() {
  if (_fxAtlas) return _fxAtlas;
  const cv = document.createElement('canvas'); cv.width = cv.height = 512; const g = cv.getContext('2d'), T = 128;
  const tile = (i, fn) => { const ox = (i % 4) * T, oy = Math.floor(i / 4) * T; g.save(); g.beginPath(); g.rect(ox, oy, T, T); g.clip(); g.translate(ox, oy); fn(rng(17 + i * 31)); g.restore(); };
  const blob = (x, y, R, rgba0, rgba1 = null) => { const gr = g.createRadialGradient(x, y, 0, x, y, R); gr.addColorStop(0, rgba0); gr.addColorStop(1, rgba1 || rgba0.replace(/[\d.]+\)$/, '0)')); g.fillStyle = gr; g.fillRect(x - R, y - R, 2 * R, 2 * R); };
  for (let i = 0; i < 4; i++) tile(i, r => { for (let k = 0; k < 34; k++) { const a = r() * 6.283, d = 24 * Math.sqrt(r()), x = 64 + Math.cos(a) * d, y = 66 + Math.sin(a) * d * 0.85, R = 12 + r() * 22, l = Math.round(250 - (y - 30) * 1.05 - r() * 20); blob(x, y, R, `rgba(${l},${l},${l},${(0.22 + r() * 0.2).toFixed(2)})`); } });
  tile(4, () => { blob(64, 64, 62, 'rgba(255,255,255,1)'); blob(64, 64, 20, 'rgba(255,255,255,0.9)'); });
  tile(5, r => { blob(64, 64, 60, 'rgba(255,255,255,0.75)'); g.fillStyle = 'rgba(255,255,255,0.85)'; for (let k = 0; k < 7; k++) { const a = k / 7 * 6.283 + r() * 0.4, L = 40 + r() * 22; g.beginPath(); g.moveTo(64 + Math.cos(a) * L, 64 + Math.sin(a) * L); g.lineTo(64 + Math.cos(a + 1.57) * 5, 64 + Math.sin(a + 1.57) * 5); g.lineTo(64 + Math.cos(a - 1.57) * 5, 64 + Math.sin(a - 1.57) * 5); g.fill(); } blob(64, 64, 18, 'rgba(255,255,255,1)'); });
  tile(6, () => { blob(64, 64, 30, 'rgba(255,255,255,1)'); blob(64, 64, 10, 'rgba(255,255,255,1)'); });
  tile(7, () => { const gr = g.createRadialGradient(64, 64, 30, 64, 64, 62); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.75, 'rgba(255,255,255,0.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, T, T); });
  tile(8, r => {   // crater: ejecta rays, light rim, dark bowl
    for (let k = 0; k < 26; k++) { const a = r() * 6.283, L = 30 + r() * 30, w = 2 + r() * 5; g.strokeStyle = `rgba(${70 + r() * 30 | 0},${62 + r() * 24 | 0},${52 + r() * 20 | 0},${(0.25 + r() * 0.35).toFixed(2)})`; g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); g.moveTo(64, 64); g.lineTo(64 + Math.cos(a) * L, 64 + Math.sin(a) * L); g.stroke(); }
    blob(64, 64, 34, 'rgba(48,40,32,0.85)'); for (let k = 0; k < 10; k++) { const a = r() * 6.283; blob(64 + Math.cos(a) * 20, 64 + Math.sin(a) * 20, 9 + r() * 6, 'rgba(150,132,104,0.55)'); } blob(64, 64, 16, 'rgba(22,18,14,0.95)'); });
  tile(9, r => { for (let k = 0; k < 16; k++) { const a = r() * 6.283, d = 22 * Math.sqrt(r()); blob(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 18 + r() * 18, `rgba(24,20,16,${(0.18 + r() * 0.18).toFixed(2)})`); } });
  tile(10, r => { for (let k = 0; k < 18; k++) { const a = r() * 6.283, d = 20 * Math.sqrt(r()), x = 64 + Math.cos(a) * d, y = 64 + Math.sin(a) * d; blob(x, y, 14 + r() * 20, `rgba(255,${150 + r() * 70 | 0},${40 + r() * 50 | 0},0.5)`); } blob(64, 64, 22, 'rgba(255,240,190,0.95)'); });
  tile(11, r => { g.fillStyle = 'rgba(40,32,24,0.95)'; g.beginPath(); for (let k = 0; k < 9; k++) { const a = k / 9 * 6.283, L = 22 + r() * 22; k ? g.lineTo(64 + Math.cos(a) * L, 64 + Math.sin(a) * L) : g.moveTo(64 + Math.cos(a) * L, 64 + Math.sin(a) * L); } g.fill(); });
  _fxAtlas = new THREE.CanvasTexture(cv); _fxAtlas.generateMipmaps = true; _fxAtlas.minFilter = THREE.LinearMipmapLinearFilter; return _fxAtlas;
}
function fxMaterial(additive) {
  return new THREE.ShaderMaterial({ vertexShader: FXV, fragmentShader: FXF, uniforms: { map: { value: fxAtlas() }, uPx: { value: 0.001 }, uK: { value: 1 } }, transparent: true, depthWrite: false, depthTest: true, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
}
class FxLayer {
  constructor(N, additive, order) {
    this.N = N; const q = new THREE.PlaneGeometry(1, 1), g = new THREE.InstancedBufferGeometry(); g.index = q.index; g.setAttribute('position', q.attributes.position); g.setAttribute('uv', q.attributes.uv);
    const A = (n, k) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(N * k), k); a.setUsage(THREE.DynamicDrawUsage); g.setAttribute(n, a); return a; };
    this.aPos = A('iPos', 3); this.aCol = A('iCol', 4); this.aP = A('iP', 4); g.instanceCount = 0; this.geo = g;
    this.mesh = new THREE.Mesh(g, fxMaterial(additive)); this.mesh.frustumCulled = false; this.mesh.renderOrder = order; this.ps = [];
  }
  write(list) {
    const n = Math.min(this.N, list.length), P = this.aPos.array, C = this.aCol.array, Q = this.aP.array;
    for (let i = 0; i < n; i++) { const p = list[i]; P[i * 3] = p.x; P[i * 3 + 1] = p.y; P[i * 3 + 2] = p.z; C[i * 4] = p.r; C[i * 4 + 1] = p.g; C[i * 4 + 2] = p.b; C[i * 4 + 3] = p.a; Q[i * 4] = p.s; Q[i * 4 + 1] = p.rot; Q[i * 4 + 2] = p.tile; Q[i * 4 + 3] = p.mode; }
    this.geo.instanceCount = n; for (const a of [this.aPos, this.aCol, this.aP]) { a.needsUpdate = true; a.clearUpdateRanges?.(); a.addUpdateRange?.(0, n * a.itemSize); }
  }
}
const KIND_FX = { mortar120: { k: 0.82, tube: 'mortar', guns: 4, volleys: 3 }, how122: { k: 0.9, tube: 'how', guns: 6, volleys: 3 }, d30: { k: 0.9, tube: 'how', guns: 6, volleys: 3 }, how152: { k: 1, tube: 'how', guns: 6, volleys: 3 }, msta: { k: 1, tube: 'how', guns: 6, volleys: 3 }, m777: { k: 1, tube: 'how', guns: 4, volleys: 3 }, grad: { k: 1.05, tube: 'mlrs', guns: 2, volleys: 1 } };
export class ArtyFx {
  constructor(scene) {
    this.smoke = new FxLayer(9000, false, 11); this.glow = new FxLayer(4000, true, 12); this.decal = new FxLayer(3000, false, 2);
    this.decal.mesh.material.polygonOffset = true; this.decal.mesh.material.polygonOffsetFactor = -2;
    scene.add(this.decal.mesh, this.smoke.mesh, this.glow.mesh);
    this.parts = []; this.proj = []; this.events = []; this.lines = []; this.time = 0; this.wind = [0.006, 0.002]; this.decals = new Map(); this.decalDirty = false; this.scene = scene;
  }
  get busy() { return this.parts.length > 0 || this.proj.length > 0 || this.events.length > 0 || this.lines.length > 0; }
  at(dt, fn) { this.events.push({ t: this.time + dt, fn }); }
  // a particle: p { x y z vx vy vz life s0 s1 tile mode c0 c1 a0 fin fpow drag rise grav wind rot vrot ground }
  add(p) { if (this.parts.length > 12000) return null; p.age = 0; p.rot ??= Math.random() * 6.283; p.vrot ??= 0; p.c1 ||= p.c0; p.fin ??= 0.08; p.fpow ??= 1.4; p.drag ??= 0; p.rise ??= 0; p.grav ??= 0; p.wind ??= 0; p.vx ??= 0; p.vy ??= 0; p.vz ??= 0; p.mode ??= 0; p.add = !!p.add; p.r = p.g = p.b = p.a = p.s = 0; this.parts.push(p); return p; }
  update(dt) {
    dt = Math.min(dt, 0.1); this.time += dt;
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].t <= this.time) { const e = this.events[i]; this.events.splice(i, 1); e.fn(); }
    // projectiles: a ballistic arc a -> b, apex h; trail dots / rocket smoke every `step` km along the path
    for (let i = this.proj.length - 1; i >= 0; i--) {
      const q = this.proj[i]; q.t += dt; if (q.t < 0) continue;
      const k = Math.min(1, q.t / q.dur), pos = k2 => [q.a[0] + (q.b[0] - q.a[0]) * k2, q.a[1] + (q.b[1] - q.a[1]) * k2 + 4 * q.h * k2 * (1 - k2), q.a[2] + (q.b[2] - q.a[2]) * k2];
      const k0 = q.k ?? 0, L = q.len * (k - k0), n = Math.min(q.rocket ? 24 : 10, Math.ceil(L / q.step));
      for (let j = 1; j <= n; j++) { const kk = k0 + (k - k0) * j / n, [x, y, z] = pos(kk), age = (1 - j / n) * dt;
        if (q.rocket) { if (kk > 0.38) continue; const tp = this.add({ x, y, z, vx: (Math.random() - 0.5) * 0.006, vy: 0.002, vz: (Math.random() - 0.5) * 0.006, life: 3.5 + Math.random() * 2.5, s0: 0.035 * q.s, s1: 0.11 * q.s, tile: Math.random() * 4 | 0, c0: [0.95, 0.94, 0.92], c1: [0.8, 0.8, 0.79], a0: 0.6, fin: 0.02, fpow: 1.6, drag: 0.6, wind: 1, vrot: (Math.random() - 0.5) * 0.4 }); if (tp) tp.age = age;
          this.add({ x, y, z, life: 0.18, s0: 0.02 * q.s, s1: 0.012 * q.s, tile: 4, mode: 2, c0: [1, 0.62, 0.25], a0: 0.8, fin: 0.01, add: true }); }
        else { this.add({ x, y, z, life: 0.5, s0: 0.012, s1: 0.007, tile: 6, mode: 2, c0: [1, 0.5, 0.16], a0: q.tracer, fin: 0.01, fpow: 1.5 }); this.add({ x, y, z, life: 0.25, s0: 0.016, s1: 0.01, tile: 4, mode: 2, c0: [1, 0.75, 0.45], a0: q.tracer * 0.6, fin: 0.01, add: true }); }
      }
      q.k = k;
      if ((q.rocket && k < 0.4) || q.tracer > 0.3) { const [x, y, z] = pos(k); this.add({ x, y, z, life: 0.05, s0: 0.035 * q.s, s1: 0.035 * q.s, tile: 4, mode: 2, c0: q.rocket ? [1, 0.85, 0.55] : [1, 0.8, 0.55], a0: 1, fin: 0.01, add: true }); }
      if (k >= 1) { this.proj.splice(i, 1); q.hit?.(); }
    }
    // particles
    const [wx, wz] = this.wind, sm = [], gl = [];
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]; p.age += dt; const k = p.age / p.life; if (k >= 1) { this.parts[i] = this.parts[this.parts.length - 1]; this.parts.pop(); continue; }
      if (p.drag) { const d = Math.exp(-p.drag * dt); p.vx *= d; p.vy *= d; p.vz *= d; }
      p.vy += (p.rise - p.grav) * dt; p.x += (p.vx + wx * p.wind * Math.min(1, p.y * 6 + 0.3)) * dt; p.y += p.vy * dt; p.z += (p.vz + wz * p.wind * Math.min(1, p.y * 6 + 0.3)) * dt;
      if (p.y < 0.001 && p.grav) { p.y = 0.001; p.vy = 0; p.vx *= 0.3; p.vz *= 0.3; }
      p.rot += p.vrot * dt;
      const e = 1 - (1 - k) * (1 - k), cc = Math.min(1, k * (p.cs || 1.6));
      p.s = p.s0 + (p.s1 - p.s0) * e; p.r = p.c0[0] + (p.c1[0] - p.c0[0]) * cc; p.g = p.c0[1] + (p.c1[1] - p.c0[1]) * cc; p.b = p.c0[2] + (p.c1[2] - p.c0[2]) * cc;
      p.a = p.a0 * Math.min(1, k / p.fin) * Math.pow(1 - k, p.fpow);
      (p.add ? gl : sm).push(p);
    }
    this.smoke.write(sm); this.glow.write(gl);
    for (let i = this.lines.length - 1; i >= 0; i--) { const l = this.lines[i]; l.t += dt; const k = l.t / l.dur; if (k >= 1) { this.scene.remove(l.obj); if (this.lineDispose) this.lineDispose(l.obj); else { l.obj.geometry.dispose(); l.obj.material.dispose(); } this.lines.splice(i, 1); continue; } l.obj.material.opacity = l.a * Math.min(1, k / 0.1) * (1 - k); }
    if (this.decalDirty) this.writeDecals();
    return this.busy;
  }
  // k: size boost when the camera is far out (the effects stay readable on the strategic view; decals grow less)
  setView(camera, H, k = 1) { const v = 2 * Math.tan(camera.fov * Math.PI / 360) / H; for (const L of [this.smoke, this.glow, this.decal]) { L.mesh.material.uniforms.uPx.value = v; L.mesh.material.uniforms.uK.value = L === this.decal ? Math.sqrt(k) : k; } }
  writeDecals() { const all = []; for (const l of this.decals.values()) all.push(...l); this.decal.write(all); this.decalDirty = false; }
  addDecal(key, d) { if (!this.decals.has(key)) this.decals.set(key, []); this.decals.get(key).push(d); this.decalDirty = true; }
  // ---- building blocks
  muzzle(x, z, dir, kind, k = 1) {
    const [dx, dz] = dir, mort = kind === 'mortar', R = Math.random;
    this.add({ x: x + dx * 0.012, y: 0.012, z: z + dz * 0.012, life: 0.13, s0: 0.05 * k, s1: 0.08 * k, tile: 5, mode: 2, c0: [1, 0.92, 0.7], a0: 1, fin: 0.01, fpow: 1, add: true });
    this.add({ x, y: 0.01, z, life: 0.32, s0: 0.07 * k, s1: 0.11 * k, tile: 4, c0: [1, 0.55, 0.2], a0: 0.75, fin: 0.02, add: true });
    for (let i = 0; i < (mort ? 2 : 4); i++) { const v = 0.05 + R() * 0.06; this.add({ x, y: 0.012, z, vx: dx * v + (R() - 0.5) * 0.03, vy: 0.03 + R() * 0.03, vz: dz * v + (R() - 0.5) * 0.03, life: 3.5 + R() * 2.5, s0: 0.02 * k, s1: (0.08 + R() * 0.04) * k, tile: R() * 4 | 0, c0: [0.85, 0.84, 0.8], c1: [0.72, 0.72, 0.7], a0: mort ? 0.4 : 0.55, fin: 0.04, drag: 1.6, rise: 0.003, wind: 1, vrot: (R() - 0.5) * 0.4 }); }
    if (!mort) for (let i = 0; i < 5; i++) { const a = R() * 6.283, v = 0.03 + R() * 0.03; this.add({ x, y: 0.004, z, vx: Math.cos(a) * v, vy: 0.004, vz: Math.sin(a) * v, life: 2 + R() * 1.5, s0: 0.02 * k, s1: 0.06 * k, tile: R() * 4 | 0, c0: [0.62, 0.55, 0.44], a0: 0.35, fin: 0.05, drag: 2.4, wind: 0.6 }); }
  }
  rocketLaunch(x, z, dir, k = 1) {
    const [dx, dz] = dir, R = Math.random;
    this.add({ x, y: 0.01, z, life: 0.25, s0: 0.05 * k, s1: 0.08 * k, tile: 10, c0: [1, 0.8, 0.5], a0: 0.9, fin: 0.02, add: true });
    for (let i = 0; i < 3; i++) { const v = 0.04 + R() * 0.05; this.add({ x, y: 0.008, z, vx: -dx * v + (R() - 0.5) * 0.04, vy: 0.01 + R() * 0.02, vz: -dz * v + (R() - 0.5) * 0.04, life: 6 + R() * 4, s0: 0.03 * k, s1: (0.11 + R() * 0.06) * k, tile: R() * 4 | 0, c0: [0.8, 0.77, 0.7], c1: [0.7, 0.69, 0.66], a0: 0.4, fin: 0.04, drag: 1.2, rise: 0.002, wind: 1 }); }
  }
  impact(x, z, k = 1, kind = 'shell', key = null) {
    k *= 1.35; const R = Math.random, rk = kind === 'rocket', sec = kind === 'secondary';
    this.add({ x, y: 0.01, z, life: 0.16, s0: 0.07 * k, s1: 0.12 * k, tile: 5, mode: 2, c0: [1, 0.93, 0.75], a0: 1, fin: 0.01, fpow: 1, add: true });
    this.add({ x, y: 0.02 * k, z, vy: 0.03, life: rk || sec ? 0.9 : 0.6, s0: 0.06 * k, s1: (rk || sec ? 0.15 : 0.12) * k, tile: 10, c0: [1, 0.85, 0.55], c1: [0.9, 0.35, 0.1], a0: 0.95, fin: 0.03, fpow: 1.8, add: true, cs: 1.5 });
    this.add({ x, y: 0.003, z, life: 0.4, s0: 0.02 * k, s1: 0.26 * k, tile: 7, mode: 1, c0: [1, 0.9, 0.75], a0: 0.22, fin: 0.02, fpow: 1, add: true });
    for (let i = 0; i < 7; i++) { const a = R() * 6.283, v = 0.08 + R() * 0.12; this.add({ x, y: 0.01, z, vx: Math.cos(a) * v * 0.6, vy: 0.08 + R() * 0.12, vz: Math.sin(a) * v * 0.6, life: 0.6 + R() * 0.5, s0: 0.006, s1: 0.004, tile: 6, mode: 2, c0: [1, 0.75, 0.4], a0: 0.9, fin: 0.01, grav: 0.35, add: true }); }
    for (let i = 0; i < 6; i++) { const a = R() * 6.283, v = 0.04 + R() * 0.07; this.add({ x, y: 0.01, z, vx: Math.cos(a) * v * 0.5, vy: 0.07 + R() * 0.1, vz: Math.sin(a) * v * 0.5, life: 0.9 + R() * 0.5, s0: 0.008 * k, s1: 0.008 * k, tile: 11, c0: [0.3, 0.25, 0.2], a0: 0.95, fin: 0.01, fpow: 0.4, grav: 0.32, vrot: 4 }); }
    // the dust / smoke column: dark earth at the root, lighter as it rises, leaning with the wind
    const dark = sec ? [0.12, 0.11, 0.1] : [0.3, 0.26, 0.21], light = sec ? [0.25, 0.24, 0.23] : [0.72, 0.7, 0.66];
    for (let i = 0; i < 3; i++) this.add({ x: x + (R() - 0.5) * 0.04 * k, y: 0.03 * k, z: z + (R() - 0.5) * 0.04 * k, vx: (R() - 0.5) * 0.03, vy: 0.03 * k, vz: (R() - 0.5) * 0.03, life: 2.6 + R() * 1.5, s0: 0.06 * k, s1: (0.22 + R() * 0.06) * k, tile: R() * 4 | 0, c0: dark.map(c => c * 0.8), c1: light, a0: 0.9, fin: 0.02, fpow: 1.6, drag: 1.4, wind: 0.6, vrot: (R() - 0.5) * 0.5, cs: 1 });
    for (let i = 0; i < (sec ? 7 : 5); i++) this.add({ x: x + (R() - 0.5) * 0.03 * k, y: 0.015, z: z + (R() - 0.5) * 0.03 * k, vx: (R() - 0.5) * 0.02, vy: (0.05 + R() * 0.06 + i * 0.03) * k, vz: (R() - 0.5) * 0.02, life: (sec ? 14 : 6) + R() * 4, s0: 0.045 * k, s1: (0.17 + R() * 0.07 + i * 0.02) * k, tile: R() * 4 | 0, c0: dark, c1: light, a0: 0.82, fin: 0.03, fpow: 1.2, drag: 0.9, rise: sec ? 0.004 : 0.001, wind: 1, vrot: (R() - 0.5) * 0.3, cs: 1.2 });
    for (let i = 0; i < 6; i++) { const a = R() * 6.283, v = 0.06 + R() * 0.05; this.add({ x, y: 0.006, z, vx: Math.cos(a) * v, vy: 0.006, vz: Math.sin(a) * v, life: 4 + R() * 2.5, s0: 0.04 * k, s1: (0.14 + R() * 0.06) * k, tile: R() * 4 | 0, c0: [0.52, 0.46, 0.38], c1: [0.7, 0.67, 0.62], a0: 0.7, fin: 0.04, drag: 1.8, wind: 0.8, vrot: (R() - 0.5) * 0.3 }); }
    for (let i = 0; i < 2; i++) this.add({ x: x + (R() - 0.5) * 0.04, y: 0.06 * k, z: z + (R() - 0.5) * 0.04, vy: 0.012, life: 16 + R() * 8, s0: 0.1 * k, s1: (0.32 + R() * 0.1) * k, tile: R() * 4 | 0, c0: [0.7, 0.69, 0.67], a0: 0.4, fin: 0.25, fpow: 1.1, drag: 0.4, rise: 0.0006, wind: 1.2, vrot: (R() - 0.5) * 0.15 });
    if (key) { this.addDecal(key, { x, y: 0.002, z, s: (0.045 + R() * 0.02) * k, rot: R() * 6.28, tile: 8, mode: 1, r: 1, g: 1, b: 1, a: 0.92 }); if (R() < 0.6 || sec) this.addDecal(key, { x: x + (R() - 0.5) * 0.02, y: 0.0015, z: z + (R() - 0.5) * 0.02, s: (0.12 + R() * 0.06) * k * (sec ? 1.8 : 1), rot: R() * 6.28, tile: 9, mode: 1, r: 1, g: 1, b: 1, a: 0.75 }); }
  }
  arcLine(a, b, h, color, dur) {
    const pts = []; for (let i = 0; i <= 48; i++) { const k = i / 48; pts.push(a[0] + (b[0] - a[0]) * k, a[1] + 4 * h * k * (1 - k), a[2] + (b[2] - a[2]) * k); }
    let l; if (this.lineFactory) l = this.lineFactory(pts, color);
    else { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); l = new THREE.Line(g, new THREE.LineDashedMaterial({ color, dashSize: 0.22, gapSize: 0.14, transparent: true, opacity: 0, depthWrite: false })); l.computeLineDistances(); l.renderOrder = 10; }
    this.scene.add(l); this.lines.push({ obj: l, t: 0, dur, a: 0.75 });
  }
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
