import * as THREE from 'three';
import { City, MAP, MAP_SIZE, BOUNDS, ROADS, onRoad, mulberry, catenary } from './city.js';
import { BLOCK } from './nav.js';
import { instance, trs } from './instancer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Map 2 — Ukrainian steppe farmland: big open fields cut by acacia/poplar windbreaks ("lesopolosa"),
// two villages strung along their roads, a kolkhoz farm, cratered everywhere.
// Field grid: boundaries follow the windbreaks and tracks in maps.js.
const XS = [-452, -395, -359.5, -124.5, -20, 10, 103.5, 180, 224.5, 359.5, 390, 452];
const ZS = [-452, -335, -294.5, -175, -143.5, -22, 63.5, 190, 305.5, 335, 452];
const T_PLOW = 0, T_STUB = 1, T_FALLOW = 2, T_SUN = 3, T_CORN = 4;

export class Farmland extends City {
  constructor(scene, assets, quality) {
    super(scene, assets, quality);
    this.rng = mulberry(4417);
    this.streetDebris = 0;
    this.grassMax = quality === 'low' ? 30000 : quality === 'medium' ? 60000 : 85000; this.grassCull = 260;
    this.nav.maxIter = 320000;
    this.CS = 2; this.CN = Math.ceil(MAP_SIZE / this.CS); this.conceal = new Uint8Array(this.CN * this.CN).fill(255);
    this.place = {};
  }
  build() {
    this.layoutFields();
    this.ground(); this.roads();
    this.placeBuildings(); this.facadeDecals();
    this.farm(); this.villages(); this.treelines();
    this.rubbleAndDebris();
    this.poles(); this.props(); this.defences();
    this.crops();
    this.flush();
    this.craters(); this.paintGround(); this.skyline();
    this.buildCrushables();
    this.nav.finalize();
  }
  // ---------------------------------------------------------------- helpers
  concealAt(x, z) { const i = Math.floor((x + MAP_SIZE / 2) / this.CS), j = Math.floor((z + MAP_SIZE / 2) / this.CS); if (i < 0 || j < 0 || i >= this.CN || j >= this.CN) return 1; return this.conceal[j * this.CN + i] / 255; }
  concealRect(x0, z0, x1, z1, v) {
    const o = MAP_SIZE / 2, a = Math.max(0, Math.floor((Math.min(x0, x1) + o) / this.CS)), b = Math.min(this.CN - 1, Math.floor((Math.max(x0, x1) + o) / this.CS));
    const c = Math.max(0, Math.floor((Math.min(z0, z1) + o) / this.CS)), d = Math.min(this.CN - 1, Math.floor((Math.max(z0, z1) + o) / this.CS));
    for (let j = c; j <= d; j++) for (let i = a; i <= b; i++) { const k = j * this.CN + i; this.conceal[k] = Math.min(this.conceal[k], v); }
  }
  fieldIndex(x, z) {
    let i = 0; while (i < XS.length - 2 && x >= XS[i + 1]) i++;
    let j = 0; while (j < ZS.length - 2 && z >= ZS[j + 1]) j++;
    return j * (XS.length - 1) + i;
  }
  overlapsBuilding(x, z, hx, hz, pad = 1) { return this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + hx + pad && Math.abs(lz) < b.D / 2 + hz + pad; }); }
  inVillage(x, z, pad = 0) {
    for (const v of MAP.villages) {
      if (v.street === 'x') { if (x > v.from - pad && x < v.to + pad && z > v.z0 - v.depth - pad && z < v.z1 + v.depth + pad) return v; }
      else if (z > v.from - pad && z < v.to + pad && x > v.x0 - v.depth - pad && x < v.x1 + v.depth + pad) return v;
    }
    return null;
  }
  inFarm(x, z, pad = 0) { const f = MAP.farm; return Math.abs(x - f.x) < 95 + pad && Math.abs(z - f.z) < 62 + pad; }
  // template lookup in farmland.glb (or city/trees/props.glb), with a procedural stand-in so the map always builds
  tpl(name) {
    this._tpl ||= {};
    if (name in this._tpl) return this._tpl[name];
    let t = null;
    for (const k of ['farmland', 'city', 'trees', 'props']) { const g = this.assets.gltf[k]; const o = g?.scene.getObjectByName(name); if (o) { t = o; break; } }
    // until farmland.glb has its own windbreak trees, borrow the detailed city trees (never blobs up close)
    const alias = { tree_acacia_leafy: 'leafy_summer_chestnut', tree_oak_leafy: 'leafy_summer_chestnut', tree_walnut_leafy: 'leafy_summer_chestnut', tree_poplar_leafy: 'leafy_summer_birch', tree_acacia_shelled: 'tree_chestnut_broken' };
    if (!t && alias[name]) { const o = this.assets.gltf.trees?.scene.getObjectByName(alias[name]); if (o) t = o; }
    if (!t) t = fallbackTpl(name);
    if (t) { t.userData.bb = new THREE.Box3().setFromObject(t); }
    return (this._tpl[name] = t);
  }
  hasReal(name) { return !!this.assets.gltf.farmland?.scene.getObjectByName(name); }
  // queue an instanced placement; nav footprint, optional occluder, crushable fences
  put(name, x, z, ry = 0, o = {}) {
    const t = this.tpl(name); if (!t) return false;
    const s = o.s || 1, bb = t.userData.bb, hx = (bb.max.x - bb.min.x) / 2 * s, hz = (bb.max.z - bb.min.z) / 2 * s;
    if (o.check !== false) {
      if (onRoad(x, z, o.roadPad ?? Math.max(hx, hz) * 0.5)) return false;
      const ci = this.nav.idx(x, z); if (ci < 0 || this.nav.cost[ci] === BLOCK) return false;
      if (this.overlapsBuilding(x, z, hx, hz, 0.5)) return false;
    }
    const M = trs(x, o.y || 0, z, ry, s, o.rx || 0, o.rz || 0);
    if (o.crush) { (this.crushables ||= []).push({ t, M, x, z, ry, hx, hz, crush: o.crush, type: o.crush === 'tank' ? 'po2' : 'fenceH' }); this.nav.rect(x, z, hx, hz, ry, o.crush === 'any' ? 3 : 7, 0.1); return true; }
    const key = name + (o.group || '');
    (this.place[key] ||= { t, m: [], opts: o.inst || {}, lodName: o.lod }).m.push(M);
    if (o.cost !== 0) {
      const ns = o.navScale || 1;
      if (o.circle) this.nav.circle(x, z, o.circle, o.cost ?? BLOCK, !!o.low);
      else { this.nav.rect(x, z, hx * ns, hz * ns, ry, o.cost ?? BLOCK, 0.15); if (o.low) this.nav.setRect(x, z, hx * ns, hz * ns, ry, o.cost ?? 6, 1); }
    }
    if (o.occ) this.nav.addOccluder(x, z, hx * 0.95, hz * 0.95, ry, typeof o.occ === 'number' ? o.occ : (bb.max.y - bb.min.y) * s * 0.9, null);
    return true;
  }
  flush() {
    for (const [, v] of Object.entries(this.place)) {
      if (!v.m.length) continue;
      const lod = v.lodName ? this.tpl(v.lodName) : null;
      instance(this.scene, v.t, v.m, { ...v.opts, lod: lod || v.opts.lod });
    }
    this.place = {};
  }
  // ---------------------------------------------------------------- fields
  layoutFields() {
    const R = this.rng, nx = XS.length - 1, nz = ZS.length - 1;
    this.fields = [];
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x0 = XS[i], x1 = XS[i + 1], z0 = ZS[j], z1 = ZS[j + 1], w = x1 - x0, d = z1 - z0;
      let type;
      if (Math.min(w, d) < 45) type = T_FALLOW;
      else { const r = R(); type = r < 0.22 ? T_PLOW : r < 0.44 ? T_STUB : r < 0.66 ? T_FALLOW : r < 0.86 ? T_SUN : T_CORN; }
      this.fields.push({ x0, x1, z0, z1, type, rowsX: w > d });
    }
    // fixed picks so both sides get some tall-crop cover on the approaches
    const set = (x, z, t) => { this.fields[this.fieldIndex(x, z)].type = t; };
    set(-250, 250, T_SUN); set(60, 250, T_STUB); set(280, 250, T_SUN); set(-250, -80, T_SUN); set(280, -80, T_CORN); set(-80, -80, T_PLOW);
    set(-250, -240, T_STUB); set(280, -240, T_FALLOW); set(-60, 120, T_FALLOW); set(160, 120, T_SUN); set(-250, 400, T_FALLOW); set(-250, -400, T_FALLOW);
    // pre-roll crater positions (artillery-churned belts along the windbreaks, scatter in the open)
    this.craterList = [];
    const tl = MAP.treelines;
    for (let i = 0; i < 520; i++) {
      let x, z;
      if (R() < 0.55) { const [a, b, c, d] = tl[Math.floor(R() * tl.length)]; const f = R(); const off = (R() - .5) * 60; x = a + (c - a) * f + (b === d ? 0 : off); z = b + (d - b) * f + (b === d ? off : 0); }
      else { x = (R() - .5) * (MAP_SIZE - 30); z = (R() - .5) * (MAP_SIZE - 30); }
      if (Math.abs(z) > 372 && R() < 0.8) continue; // staging grounds mostly clean
      if (onRoad(x, z, 2)) continue;
      const big = R() < 0.12;
      this.craterList.push([x, z, big ? 5 + R() * 4 : 1.6 + R() * 3]);
    }
  }
  nearCrater(x, z, pad = 0.6) { for (const [cx, cz, s] of this.craterList) if (Math.abs(cx - x) < s && Math.abs(cz - z) < s && Math.hypot(cx - x, cz - z) < s * pad) return true; return false; }
  // ---------------------------------------------------------------- ground
  ground() {
    const S = MAP_SIZE + 900, g = new THREE.PlaneGeometry(S, S, 1, 1); g.rotateX(-Math.PI / 2);
    const T = this.assets.tex, tex = k => { const t = T[k]?.map; if (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping; } return t || null; };
    const nrm = T.dirt?.normalMap ? T.dirt.normalMap.clone() : null; if (nrm) { nrm.needsUpdate = true; nrm.repeat.set(S / 6, S / 6); }
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, normalMap: nrm, normalScale: new THREE.Vector2(0.7, 0.7) });
    const has = { PLOW: !!tex('plowed'), STUB: !!tex('stubble'), FALLOW: !!tex('fallow') };
    const U = this.groundUniforms = { tDirt: { value: tex('dirt') }, tGrass: { value: tex('grass') || tex('dirt') }, tPlow: { value: tex('plowed') || tex('dirt') }, tStub: { value: tex('stubble') || tex('dirt') }, tFallow: { value: tex('fallow') || tex('grass') || tex('dirt') }, tSplat: { value: null }, tRows: { value: null }, splatSize: { value: MAP_SIZE } };
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        ${has.PLOW ? '#define HAS_PLOW' : ''}
        ${has.STUB ? '#define HAS_STUB' : ''}
        ${has.FALLOW ? '#define HAS_FALLOW' : ''}
        varying vec3 vWPos; uniform sampler2D tDirt, tGrass, tPlow, tStub, tFallow, tSplat, tRows; uniform float splatSize;
        float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(gh(i), gh(i+vec2(1,0)), f.x), mix(gh(i+vec2(0,1)), gh(i+vec2(1,1)), f.x), f.y); }
        vec3 tile(sampler2D t, vec2 p){
          vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p * 0.87 + vec2(0.31, 0.57);
          float n = vn(p * 0.35) * 0.7 + vn(p * 1.3) * 0.3;
          return mix(texture2D(t, p).rgb, texture2D(t, q).rgb, smoothstep(0.38, 0.62, n)); }
        vec3 tileRows(sampler2D t, vec2 p){ // rows must stay aligned: offset-only anti-tiling along the rows
          float n = vn(p * vec2(0.6, 0.12));
          return mix(texture2D(t, p).rgb, texture2D(t, p + vec2(0.0, 0.43)).rgb, smoothstep(0.35, 0.65, n)); }`)
        .replace('#include <map_fragment>', `
          vec2 wp = vWPos.xz;
          vec2 wob = vec2(vn(wp * 0.15) - 0.5, vn(wp * 0.15 + 31.0) - 0.5) * 4.0;
          vec2 suv = clamp((wp + wob) / splatSize + 0.5, 0.001, 0.999);
          vec4 sp = texture2D(tSplat, suv);
          float rowsX = texture2D(tRows, clamp(wp / splatSize + 0.5, 0.001, 0.999)).r;
          vec2 fp = rowsX > 0.5 ? wp.yx : wp;
          vec3 dirt = tile(tDirt, wp / 6.0);
          vec3 grass = tile(tGrass, wp / 3.5);
          float gl = dot(grass, vec3(0.299, 0.587, 0.114)), dl = dot(dirt, vec3(0.299, 0.587, 0.114));
          grass = mix(vec3(gl), grass, 0.75) * vec3(1.0, 1.0, 0.84) * clamp(dl / max(gl, 0.02), 1.0, 1.45);
          #ifdef HAS_FALLOW
            vec3 fallow = mix(tile(tFallow, wp / 4.0), grass, 0.38 * smoothstep(0.3, 0.7, vn(wp * 0.09)) + 0.12);
          #else
            vec3 fallow = mix(grass, dirt * vec3(1.05, 1.02, 0.9), smoothstep(0.5, 0.8, vn(wp * 0.4)) * 0.45);
          #endif
          #ifdef HAS_PLOW
            vec3 plow = tileRows(tPlow, fp / 4.0);
          #else
            float fur = mix(0.5 + 0.5 * sin(fp.x * 7.854 + vn(fp * vec2(0.5, 0.05)) * 2.0), 0.5, clamp(fwidth(fp.x * 1.25) * 2.5, 0.0, 1.0));
            vec3 plow = dirt * vec3(0.46, 0.42, 0.38) * (0.62 + 0.55 * fur) * (0.85 + 0.3 * vn(wp * 3.1));
          #endif
          #ifdef HAS_STUB
            vec3 stub = tileRows(tStub, fp / 4.0);
          #else
            float row = mix(smoothstep(0.25, 0.5, abs(fract(fp.x * 5.55) - 0.5) * 2.0), 0.6, clamp(fwidth(fp.x * 5.55) * 2.0, 0.0, 1.0));
            vec3 straw = vec3(0.70, 0.60, 0.40) * (0.8 + 0.4 * vn(fp * vec2(12.0, 1.5)));
            vec3 stub = mix(dirt * vec3(1.08, 1.0, 0.86), straw, (1.0 - row) * 0.75 + 0.15);
          #endif
          float fine = vn(wp * 1.7);
          vec3 col = dirt;
          col = mix(col, fallow, smoothstep(0.0, 1.0, clamp(sp.r * 1.6 - 0.3 + (fine - 0.5) * 0.4, 0.0, 1.0)));
          col = mix(col, plow, smoothstep(0.0, 1.0, clamp(sp.g * 1.6 - 0.3 + (fine - 0.5) * 0.3, 0.0, 1.0)));
          col = mix(col, stub, smoothstep(0.0, 1.0, clamp(sp.b * 1.6 - 0.3 + (fine - 0.5) * 0.3, 0.0, 1.0)));
          col = mix(col, dirt * vec3(1.1, 1.05, 0.96), sp.a * 0.9);   // packed tracks, yards, verges
          col *= 0.88 + 0.24 * (vn(wp * 0.012) * 0.6 + vn(wp * 0.05) * 0.4);
          diffuseColor.rgb *= col;`);
    };
    const ground = new THREE.Mesh(g, m); ground.receiveShadow = true; ground.name = 'ground'; this.scene.add(ground);
    this.groundMesh = ground;
  }
  // splat: R fallow/grass, G ploughed soil, B stubble, A packed dirt; rows texture: field row direction
  paintGround() {
    const N = 1536, k = N / MAP_SIZE, o = MAP_SIZE / 2, out = new Uint8Array(N * N * 4), R = this.rng;
    const ttrack = ROADS.filter(r => r.type === 'track'), paved = ROADS.filter(r => r.type !== 'track');
    // per-pixel mask layers from canvas: verges/yards (A) and gardens (G)
    const layer = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; };
    const yards = layer(), yx = yards.getContext('2d'); yx.filter = `blur(${1.5 * k}px)`; yx.fillStyle = '#fff';
    const gard = layer(), gx = gard.getContext('2d'); gx.filter = `blur(${1.2 * k}px)`; gx.fillStyle = '#fff';
    const verge = layer(), vx = verge.getContext('2d'); vx.filter = `blur(${3 * k}px)`; vx.strokeStyle = '#fff'; vx.lineCap = 'round';
    const P = (x, z) => [(x + o) * k, (z + o) * k];
    for (const r of ttrack) { yx.globalAlpha = 0.75; yx.fillRect(...P(r.x0 - 1.5, r.z0 - 1.5), (r.x1 - r.x0 + 3) * k, (r.z1 - r.z0 + 3) * k); }
    for (const r of paved) { yx.globalAlpha = 0.55; yx.fillRect(...P(r.x0 - 3, r.z0 - 3), (r.x1 - r.x0 + 6) * k, (r.z1 - r.z0 + 6) * k); }
    for (const b of this.buildings) { yx.save(); yx.translate(...P(b.x, b.z)); yx.rotate(-b.rot); yx.globalAlpha = 0.7; yx.fillRect((-b.L / 2 - 6) * k, (-b.D / 2 - 6) * k, (b.L + 12) * k, (b.D + 12) * k); yx.restore(); }
    for (const y of this.yardRects || []) { yx.globalAlpha = y[4] ?? 0.65; yx.fillRect(...P(y[0], y[1]), (y[2] - y[0]) * k, (y[3] - y[1]) * k); }
    for (const g of this.gardenRects || []) { gx.globalAlpha = 0.9; gx.fillRect(...P(g[0], g[1]), (g[2] - g[0]) * k, (g[3] - g[1]) * k); }
    vx.fillStyle = '#fff'; for (const l of this.lawnRects || []) { vx.globalAlpha = 0.9; vx.fillRect(...P(l[0], l[1]), (l[2] - l[0]) * k, (l[3] - l[1]) * k); }  // grassy house yards
    for (const [x0, z0, x1, z1] of MAP.treelines) { vx.lineWidth = 22 * k; vx.globalAlpha = 1; vx.beginPath(); vx.moveTo(...P(x0, z0)); vx.lineTo(...P(x1, z1)); vx.stroke(); }
    // wheel ruts / trampled lanes across fields
    yx.strokeStyle = '#fff'; yx.lineCap = 'round';
    for (let i = 0; i < 26; i++) { const x0 = (R() - .5) * MAP_SIZE, z0 = (R() - .5) * MAP_SIZE, a = Math.floor(R() * 4) * Math.PI / 2 + (R() - .5) * 0.5, L = 60 + R() * 160; yx.globalAlpha = 0.35 + R() * 0.25; yx.lineWidth = 2.6 * k; yx.beginPath(); yx.moveTo(...P(x0, z0)); yx.quadraticCurveTo(...P(x0 + Math.cos(a) * L * 0.5 + (R() - .5) * 30, z0 + Math.sin(a) * L * 0.5 + (R() - .5) * 30), ...P(x0 + Math.cos(a) * L, z0 + Math.sin(a) * L)); yx.stroke(); }
    const Y = yx.getImageData(0, 0, N, N).data, G = gx.getImageData(0, 0, N, N).data, V = vx.getImageData(0, 0, N, N).data;
    const nx = XS.length - 1;
    for (let j = 0; j < N; j++) {
      const z = j / k - o;
      for (let i = 0; i < N; i++) {
        const x = i / k - o, p = (j * N + i) * 4;
        // jitter the field lookup so boundaries are ragged, not ruled
        const jx = x + (this.noise2(x / 9, z / 9, 7) - 0.5) * 7, jz = z + (this.noise2(x / 9, z / 9, 8) - 0.5) * 7;
        const f = this.fields[this.fieldIndex(jx, jz)];
        const n1 = this.noise2(x / 22, z / 22, 1), n2 = this.noise2(x / 6, z / 6, 2);
        let r = 0, g = 0, b = 0, a = 0;
        if (f.type === T_PLOW) { g = 1; r = Math.max(0, n1 - 0.72) * 2.5; }
        else if (f.type === T_STUB) { b = 1; r = Math.max(0, n1 - 0.65) * 1.8; }
        else if (f.type === T_FALLOW) { r = 0.75 + n2 * 0.4; a = Math.max(0, 0.35 - n1) * 1.2; }
        else { g = 0.55 + n2 * 0.25; r = 0.25 + n1 * 0.35; } // sunflower / maize: weedy soil between the rows
        const ver = V[p] / 255, yd = Y[p] / 255, gd = G[p] / 255;
        r = Math.max(r * (1 - ver), ver * (0.85 + n2 * 0.3)); g *= 1 - ver; b *= 1 - ver;
        if (gd > 0) { g = Math.max(g * (1 - gd), gd * (0.75 + n2 * 0.3)); r *= 1 - gd * 0.7; b *= 1 - gd; }
        a = Math.max(a, yd); r *= 1 - yd * 0.6; g *= 1 - yd * 0.8; b *= 1 - yd * 0.8;
        out[p] = Math.min(255, r * 255); out[p + 1] = Math.min(255, g * 255); out[p + 2] = Math.min(255, b * 255); out[p + 3] = Math.min(255, a * 255);
      }
    }
    const t = new THREE.DataTexture(out, N, N, THREE.RGBAFormat); t.flipY = false; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    this.groundUniforms.tSplat.value = t; this.splatData = out; this.splatN = N;
    // row direction (nearest-sampled)
    const RN = 512, rows = new Uint8Array(RN * RN * 4), rk = RN / MAP_SIZE;
    for (let j = 0; j < RN; j++) for (let i = 0; i < RN; i++) { const f = this.fields[this.fieldIndex(i / rk - o, j / rk - o)]; rows[(j * RN + i) * 4] = f.rowsX ? 255 : 0; }
    const rt = new THREE.DataTexture(rows, RN, RN, THREE.RGBAFormat); rt.flipY = false; rt.magFilter = rt.minFilter = THREE.NearestFilter; rt.needsUpdate = true;
    this.groundUniforms.tRows.value = rt;
    this.grassClumps();
  }
  // ---------------------------------------------------------------- roads & tracks
  roads() {
    const asphalt = this.mat('asphalt', 1, { color: 0xc9c5bc, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const T = this.assets.tex, trackTex = T.track?.map || T.dirt?.map;
    const a = document.createElement('canvas'); a.width = 64; a.height = 4; { const x = a.getContext('2d'), gr = x.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, '#000'); gr.addColorStop(0.18, '#fff'); gr.addColorStop(0.82, '#fff'); gr.addColorStop(1, '#000'); x.fillStyle = gr; x.fillRect(0, 0, 64, 4); }
    const alpha = new THREE.CanvasTexture(a); alpha.wrapT = THREE.RepeatWrapping;
    const trackMat = new THREE.MeshStandardMaterial({ map: trackTex ? trackTex.clone() : null, alphaMap: alpha, transparent: true, depthWrite: false, roughness: 1, color: T.track ? 0xffffff : 0xb0a28a, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    if (trackMat.map) { trackMat.map.wrapS = trackMat.map.wrapT = THREE.RepeatWrapping; trackMat.map.needsUpdate = true; }
    const strip = (w, len, texW) => { const g = new THREE.PlaneGeometry(w, len); g.rotateX(-Math.PI / 2); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i), uv.getY(i) * len / texW); return g; };
    for (const r of ROADS) this.nav.markRoad(r.x0 - (r.type === 'track' ? 0.6 : 0), r.z0 - (r.type === 'track' ? 0.6 : 0), r.x1 + (r.type === 'track' ? 0.6 : 0), r.z1 + (r.type === 'track' ? 0.6 : 0), r.type === 'track' ? 1 : 2);
    for (const r of ROADS) {
      const w = r.x1 - r.x0, d = r.z1 - r.z0, horiz = w > d, len = horiz ? w : d, wid = horiz ? d : w;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      if (r.type === 'track') {
        const m = new THREE.Mesh(strip(wid + 1.2, len, 4.5), trackMat); m.position.set(cx, 0.035, cz); if (horiz) m.rotation.y = Math.PI / 2; m.receiveShadow = true; m.renderOrder = 1; this.scene.add(m);
      } else {
        const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 7, uv.getY(i) * d / 7);
        const m = new THREE.Mesh(g, asphalt); m.position.set(cx, 0.05, cz); m.receiveShadow = true; this.scene.add(m);
        const dash = new THREE.MeshStandardMaterial({ color: 0xc9c5b8, roughness: 0.9, transparent: true, opacity: 0.5, polygonOffset: true, polygonOffsetFactor: -3 });
        const mats = []; for (let t = -len / 2 + 2; t < len / 2; t += 12) if (this.rng() > 0.35) mats.push(horiz ? trs(cx + t, 0.06, cz, 0) : trs(cx, 0.06, cz + t, Math.PI / 2));
        const dg = new THREE.PlaneGeometry(3, 0.12); dg.rotateX(-Math.PI / 2); instance(this.scene, new THREE.Mesh(dg, dash), mats, { shadows: false });
      }
    }
  }
  // ---------------------------------------------------------------- kolkhoz farm (objective B)
  farm() {
    const { x: fx, z: fz } = MAP.farm, R = this.rng;
    const big = { inst: { lodDist: 520 } };
    this.put('barn_kolkhoz', fx, fz - 27, 0, { occ: true, ...big });
    this.put('barn_kolkhoz_damaged', fx, fz + 28, 0, { occ: true, ...big });
    this.put('machine_shed', fx + 72, fz, Math.PI / 2, { cost: 6, navScale: 0.35 });
    this.put('grain_silo', fx - 68, fz - 4, 0, { occ: true });
    this.put('water_tower_damaged', fx - 62, fz + 40, 0.4, { circle: 3.2 });
    this.put('water_tower', fx + 60, fz - 52, 0, { circle: 3.2 });
    this.put('tractor_mtz80_burnt', fx - 18, fz + 4, 0.7, { cost: BLOCK, low: true });
    this.put('tractor_mtz80', fx + 30, fz - 6, 2.2, { cost: BLOCK });
    this.put('combine_niva_burnt', fx + 50, fz + 30, 1.4, { cost: BLOCK });
    this.put('trailer_farm', fx + 14, fz + 10, 0.2, { cost: 6, low: true });
    for (let i = 0; i < 9; i++) this.put(R() < 0.25 ? 'haybale_round_burnt' : 'haybale_round', fx + 30 + (i % 3) * 2.2 + (R() - .5) * 0.6, fz + 52 + Math.floor(i / 3) * 2.4, R() * 0.3, { cost: 7, low: true });
    for (const [x, z] of [[fx - 40, fz - 48], [fx + 85, fz + 48], [fx - 85, fz - 40]]) this.put('haystack', x, z, R() * 6, { circle: 2.6, cost: BLOCK });
    // concrete fence along the north side of the yard (only tanks push through)
    for (let x = fx - 92; x < fx + 92; x += 4) if (R() < 0.8 && Math.abs(x - fx) > 7) this.put('fence_po2_a', x, fz - 58, 0, { crush: 'tank' });
    this.yardRects = [[fx - 95, fz - 60, fx + 95, fz + 62, 0.8]];
    this.concealRect(fx - 95, fz - 60, fx + 95, fz + 62, 255);
  }
  // ---------------------------------------------------------------- villages
  villages() {
    const R = this.rng; this.gardenRects ||= []; this.yardRects ||= [];
    const fences = ['fence_wattle', 'fence_wood_village'];
    const houseNames = ['house_a', 'house_b', 'house_c', 'house_d', 'house_e'].filter(n => this.tpl(n));
    const trees = ['tree_walnut_leafy', 'leafy_summer_chestnut', 'tree_acacia_leafy', 'leafy_summer_birch'];
    this.houseSpots = [];
    for (const v of MAP.villages) {
      const along = v.street === 'x';
      for (let t = v.from + 12; t < v.to - 10; t += 22 + R() * 6) for (const side of [-1, 1]) {
        if (R() < 0.1) continue;
        // local -> world: u along the street, w outward from the street edge
        const W = (u, w) => along ? [u, side < 0 ? v.z0 - w : v.z1 + w] : [side < 0 ? v.x0 - w : v.x1 + w, u];
        const face = along ? (side < 0 ? 0 : Math.PI) : (side < 0 ? Math.PI / 2 : -Math.PI / 2);
        const [hx, hz] = W(t + (R() - .5) * 3, 8.5 + R() * 2.5);
        if (this.overlapsBuilding(hx, hz, 12, 12, 0)) continue;
        if (onRoad(hx, hz, 5)) continue;
        const destroyed = R() < 0.18;
        if (!destroyed) { if (!this.put(houseNames[Math.floor(R() * houseNames.length)], hx, hz, face + (R() - .5) * 0.08, { occ: 3.2 })) continue; }
        else { const rt = this.rubbleTemplates(); (this._houseRubble ||= []).push([rt[Math.floor(R() * rt.length)], trs(hx, 0, hz, R() * 6, 1.25 + R() * 0.4)]); this.nav.circle(hx, hz, 4.5, 6, true); }
        this.houseSpots.push([hx, hz, destroyed]);
        // street fence with a gate, side fences around the front yard
        const fn = fences[Math.floor(R() * 2)], fr = along ? 0 : Math.PI / 2;
        for (let u = -10.5; u <= 10.5; u += 3) { if (R() < 0.22) continue; const [x, z] = W(t + u, 1.6); if (Math.abs(u) < 2) { this.put('gate_village', x, z, fr, { crush: 'any', check: false }); continue; } this.put(fn, x, z, fr + (R() - .5) * 0.06, { crush: 'any', check: false }); }
        for (const su of [-12, 12]) for (let w = 3.2; w < 20; w += 3) { if (R() < 0.3) continue; const [x, z] = W(t + su, w); this.put(fn, x, z, fr + Math.PI / 2, { crush: 'any', check: false }); }
        // back yard: outbuildings, well, woodpile, then the vegetable garden and a fruit/walnut tree
        const yb = [['shed_wood', 22, 6], ['outhouse', 27, -7], ['woodpile', 20, -5], ['well_village', 18, 7], ['greenhouse_frame', 31, 4]];
        for (const [n, w, u] of yb) if (R() < (n === 'shed_wood' ? 0.85 : 0.5)) { const [x, z] = W(t + u + (R() - .5) * 2, w + (R() - .5) * 2); this.put(n, x, z, face + (R() < 0.5 ? 0 : Math.PI / 2), { cost: n === 'woodpile' ? 7 : BLOCK, low: n === 'woodpile' }); }
        const [gx0, gz0] = W(t - 11, 34), [gx1, gz1] = W(t + 11, v.depth);
        this.gardenRects.push([Math.min(gx0, gx1), Math.min(gz0, gz1), Math.max(gx0, gx1), Math.max(gz0, gz1)]);
        const [yx0, yz0] = W(t - 11, 2), [yx1, yz1] = W(t + 11, 33);
        (this.lawnRects ||= []).push([Math.min(yx0, yx1), Math.min(yz0, yz1), Math.max(yx0, yx1), Math.max(yz0, yz1)]);
        for (let q = 0; q < 2; q++) if (R() < 0.75) { const [x, z] = W(t + (R() - .5) * 18, 14 + R() * 24); const n = trees[Math.floor(R() * trees.length)]; this.put(n, x, z, R() * 6, { s: 0.85 + R() * 0.3, circle: 0.5, lod: this.tpl(n + '_lod1') ? n + '_lod1' : null, inst: { lodDist: 200, cullDist: 900 } }); }
        this.concealRect(...W(t - 11, 2), ...W(t + 11, v.depth), 190);
      }
      // a roadside cross and a bus stop at the village edge
      const [cx, cz] = along ? [v.from - 6, v.z1 + 4] : [v.x1 + 4, v.to + 6]; this.put('cross_roadside', cx, cz, along ? Math.PI : -Math.PI / 2, { circle: 0.4 });
      const [bx, bz] = along ? [(v.from + v.to) / 2 + 40, v.z0 - 4] : [v.x0 - 4, (v.from + v.to) / 2 - 30]; this.put('bus_stop_village', bx, bz, along ? 0 : Math.PI / 2, { roadPad: 0 });
    }
    for (const [t, M] of this._houseRubble || []) instance(this.scene, t, [M]);
    // a church at the west end of Novomykolaivka, cars in the yards
    this.put('church_small', -300, 98, Math.PI, { occ: true });
    for (const [hx, hz, d] of this.houseSpots) if (!d && R() < 0.22) this.put(R() < 0.6 ? 'car_parked_lada' : 'car_vaz2107_burnt', hx + (R() - .5) * 10, hz + (R() < .5 ? 7 : -7), R() * 6, { cost: BLOCK });
  }
  // ---------------------------------------------------------------- windbreaks
  treelines() {
    const R = this.rng;
    const kinds = [['tree_acacia_leafy', 0.48], ['tree_oak_leafy', 0.14], ['tree_poplar_leafy', 0.14], ['tree_acacia_shelled', 0.24]];
    const pick = () => { let r = R(); for (const [n, w] of kinds) { if ((r -= w) < 0) return n; } return kinds[0][0]; };
    const lodOf = n => this.tpl(n + '_lod1') ? n + '_lod1' : null;
    for (const [x0, z0, x1, z1] of MAP.treelines) {
      const L = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / L, uz = (z1 - z0) / L, nx = -uz, nz = ux, rot = Math.atan2(-uz, ux);
      let gap = 0, run = null;
      const close = () => { if (run && run[1] - run[0] > 6) { const a = (run[0] + run[1]) / 2, hl = (run[1] - run[0]) / 2; const o = this.nav.addOccluder(x0 + ux * a, z0 + uz * a, hl, 5.5, rot, 9, null); o.foliage = true; } run = null; };
      for (let t = 2; t < L; t += 4.2 + R() * 2.4) {
        const cx = x0 + ux * t, cz = z0 + uz * t;
        if (Math.abs(cx) > MAP_SIZE / 2 - 3 || Math.abs(cz) > MAP_SIZE / 2 - 3) { close(); continue; }
        if (onRoad(cx, cz, 7) || this.inVillage(cx, cz, 2) || this.inFarm(cx, cz, 4)) { close(); continue; }
        if (gap > 0) { gap -= 5; close(); continue; }
        if (R() < 0.03) { gap = 6 + R() * 16; close(); continue; }
        if (!run) run = [t, t]; run[1] = t + 3;
        for (const off of [-3.4, 0.2, 3.6]) {
          const o2 = off + (R() - .5) * 1.4, px = cx + nx * o2 + ux * (R() - .5) * 2, pz = cz + nz * o2 + uz * (R() - .5) * 2;
          if (off === 0.2 || R() < 0.12) { if (R() < 0.75) { const b = R() < 0.5 ? 'bush_a' : 'bush_b'; this.put(b, px, pz, R() * 6, { s: 0.8 + R() * 0.6, circle: 1.1, cost: 4, check: false, lod: lodOf(b), inst: { lodDist: 140, cullDist: 700, lodShadows: false } }); } continue; }
          const n = pick(); if (!this.put(n, px, pz, R() * 6, { s: 0.8 + R() * 0.4, circle: 0.45, check: false, lod: lodOf(n), inst: { lodDist: 165, cullDist: 1200 } })) continue;
        }
        // undergrowth litter & fallen limbs
        if (R() < 0.05) this.put('fallen_trunk', cx + nx * (R() - .5) * 8, cz + nz * (R() - .5) * 8, R() * 6, { cost: 5, low: true, check: false });
        this.concealRect(cx - 6.5 - Math.abs(ux) * 3, cz - 6.5 - Math.abs(uz) * 3, cx + 6.5 + Math.abs(ux) * 3, cz + 6.5 + Math.abs(uz) * 3, 105);
      }
      close();
    }
  }
  // ---------------------------------------------------------------- crops
  crops() {
    const R = this.rng, cap = this.quality === 'low' ? 7000 : this.quality === 'medium' ? 12000 : 16000;
    const inst = { shadows: this.quality === 'high', cullDist: this.quality === 'high' ? 300 : 230 };
    for (const f of this.fields) {
      if (f.type !== T_SUN && f.type !== T_CORN && f.type !== T_FALLOW) continue;
      const name = f.type === T_SUN ? 'sunflower_dead_clump' : f.type === T_CORN ? 'corn_dry_clump' : 'weeds_tall_clump';
      const along = f.type === T_FALLOW ? 3.4 : f.type === T_SUN ? 1.8 : 1.6, across = f.type === T_FALLOW ? 3.4 : f.type === T_SUN ? 1.55 : 1.35;
      const w = f.x1 - f.x0, d = f.z1 - f.z0, area = w * d;
      const n = area / (along * across), keep = Math.min(1, cap / n);
      for (let a = f.x0 + 6; a < f.x1 - 6; a += f.rowsX ? along : across) for (let b = f.z0 + 6; b < f.z1 - 6; b += f.rowsX ? across : along) {
        if (R() > keep) continue;
        const x = a + (R() - .5) * (f.type === T_FALLOW ? 3 : 0.5), z = b + (R() - .5) * (f.type === T_FALLOW ? 3 : 0.5);
        const pn = this.noise2(x / 26, z / 26, 11);
        if (pn < (f.type === T_FALLOW ? 0.45 : 0.22) || (pn < 0.35 && R() < 0.5)) continue; // trampled / burnt patches
        if (onRoad(x, z, 2.5) || this.inVillage(x, z) || this.inFarm(x, z) || this.nearCrater(x, z, 0.9)) continue;
        const ci = this.nav.idx(x, z); if (ci < 0 || this.nav.cost[ci] !== 1) continue;
        this.put(name, x, z, R() * 6.28, { s: 0.8 + R() * 0.45, cost: 0, check: false, inst, rx: (R() - .5) * 0.12, rz: (R() - .5) * 0.12 });
      }
      if (f.type !== T_FALLOW) this.concealRect(f.x0 + 6, f.z0 + 6, f.x1 - 6, f.z1 - 6, 140);
      else this.concealRect(f.x0 + 6, f.z0 + 6, f.x1 - 6, f.z1 - 6, 215);
    }
  }
  // ---------------------------------------------------------------- power lines along the paved roads
  poles() {
    const T = this.templatesFrom('wires', { pole: /^(utility_)?pole|utility/i, concertina: /concertina|razor/i });
    this.wireT = T;
    let pole = T.pole?.[0];
    if (!pole) { const conc = new THREE.MeshStandardMaterial({ color: 0x99958b, roughness: 0.9 }); pole = new THREE.Group(); const p = new THREE.Mesh(new THREE.BoxGeometry(0.22, 9.5, 0.22), conc); p.position.y = 4.75; pole.add(p); const a = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.1), conc); a.position.y = 9; pole.add(a); }
    const att = (() => { const pts = []; pole.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(pole.matrixWorld).invert(); pole.traverse(o => { if (!o.isMesh && /attach|wire|insul/i.test(o.name)) pts.push(o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv)); }); if (!pts.length) { const b = new THREE.Box3().setFromObject(pole); pts.push(new THREE.Vector3(0.7, b.max.y - b.min.y - 0.5, 0), new THREE.Vector3(-0.7, b.max.y - b.min.y - 0.5, 0)); } return pts; })();
    const lines = [], mats = [];
    const run = (x0, z0, x1, z1, rotY) => {
      const n = Math.floor(Math.hypot(x1 - x0, z1 - z0) / 42), tops = [];
      for (let i = 0; i <= n; i++) {
        const x = x0 + (x1 - x0) * i / n, z = z0 + (z1 - z0) * i / n;
        if (onRoad(x, z, -0.5) || Math.abs(x) > MAP_SIZE / 2 - 4 || Math.abs(z) > MAP_SIZE / 2 - 4) { tops.push(null); continue; }
        const broken = this.rng() < 0.15, M = trs(x, 0, z, rotY, 1, broken ? (this.rng() - .5) * 0.6 : (this.rng() - .5) * 0.05, (this.rng() - .5) * 0.06); mats.push(M);
        this.nav.circle(x, z, 0.4, BLOCK); tops.push(broken ? null : att.map(a => a.clone().applyMatrix4(M)));
      }
      for (let i = 0; i < tops.length - 1; i++) { const a = tops[i], b = tops[i + 1]; if (!a) continue; for (let q = 0; q < a.length; q++) { if (this.rng() < 0.1) continue; if (b && b[q]) lines.push(catenary(a[q], b[q], 1.4 + this.rng() * 0.6)); else { const e = a[q].clone().add(new THREE.Vector3((x1 - x0) / n * 0.35, 0, (z1 - z0) / n * 0.35)); e.y = 0.05; lines.push(catenary(a[q], e, 0.8)); } } }
    };
    run(-MAP_SIZE / 2 + 6, 56, MAP_SIZE / 2 - 6, 56, 0); run(111.5, -MAP_SIZE / 2 + 6, 111.5, MAP_SIZE / 2 - 6, Math.PI / 2);
    instance(this.scene, pole, mats);
    if (lines.length) { const g = mergeGeometries(lines.map(p => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(p), 12, 0.012, 3))); this.scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x1c1b19, roughness: 0.6, metalness: 0.4 }))); }
  }
  // ---------------------------------------------------------------- props: wrecks along the roads, field debris
  props() {
    const T = this.templatesFrom('props', { car: /car|sedan|vaz|lada|zhiguli/i, bus: /bus(?!_?stop)|paz|minibus/i, hedgehog: /hedgehog/i, sandbag: /sandbag/i, tyre: /tyre|tire/i, crater: /crater/i });
    this.propT = T; const R = this.rng;
    const one = (list, x, z, ry, cost = BLOCK) => { if (!list) return; const t = list[Math.floor(R() * list.length)]; const k = 'p_' + t.name; (this.place[k] ||= { t, m: [], opts: {} }).m.push(trs(x, 0, z, ry)); const bb = t.userData.bb ||= new THREE.Box3().setFromObject(t); this.nav.rect(x, z, (bb.max.x - bb.min.x) / 2, (bb.max.z - bb.min.z) / 2, ry, cost, 0.2); };
    // burnt-out cars on the regional roads (shot up on the move), a bus at the village
    for (let i = 0; i < 14; i++) { const r = ROADS.filter(r => r.type !== 'track')[i % 2], horiz = (r.x1 - r.x0) > (r.z1 - r.z0); const t = R(), sd = R() < 0.5;
      const x = horiz ? r.x0 + t * (r.x1 - r.x0) : (sd ? r.x0 + 1.2 : r.x1 - 1.2), z = horiz ? (sd ? r.z0 + 1.2 : r.z1 - 1.2) : r.z0 + t * (r.z1 - r.z0);
      if (Math.abs(x) > BOUNDS - 10 || Math.abs(z) > BOUNDS - 10 || Math.abs(z) > 360) continue;
      one(T.car, x + (horiz ? 0 : (sd ? -3 : 3) * R()), z + (horiz ? (sd ? -3 : 3) * R() : 0), (horiz ? Math.PI / 2 : 0) + (R() - .5) * 0.9); }
    if (T.bus) one(T.bus, -60, 70.5, Math.PI / 2 + 0.2);
    for (let i = 0; i < 30; i++) { const x = (R() - .5) * (MAP_SIZE - 80), z = (R() - .5) * 700, ci = this.nav.idx(x, z); if (ci >= 0 && this.nav.cost[ci] === 1 && !onRoad(x, z, 2) && T.tyre) one(T.tyre, x, z, R() * 6, 0); }
  }
  // ---------------------------------------------------------------- field fortifications facing north
  defences() {
    const R = this.rng;
    // trench line in front of Novomykolaivka and around the farm, sandbag nests, hedgehogs on the road
    const trench = (x0, x1, z) => { for (let x = x0; x < x1; x += 6) { const zz = z + (Math.floor((x - x0) / 18) % 2 ? 1.6 : -1.6); this.put('trench_segment', x, zz, 0, { cost: 6, low: true, check: false }); } };
    trench(-250, -96, 10); trench(205, 320, 42);
    for (const [x, z] of [[-150, 13], [-210, 12], [-110, 12], [230, 44], [290, 44]]) this.put('dugout_entrance', x, z - 4, Math.PI, { cost: BLOCK });
    for (const [x, z, r] of [[-175, 70.5, 0], [-160, 70.5, 0], [-120, 56, Math.PI], [255, 52, 0], [270, 52, 0], [210, 75, Math.PI / 2]]) this.putSandbag(x, z, r);
    for (const [x0, z0, x1, z1] of [[-336, 56, -336, 71], [96, 40, 111, 40], [96, -60, 111, -60]]) for (let f = 0; f <= 1.001; f += 0.25) this.putProp('hedgehog', x0 + (x1 - x0) * f, z0 + (z1 - z0) * f, R() * 3, BLOCK);
    for (let i = 0; i < 6; i++) this.put('berm_earth', -300 + i * 120 + R() * 30, -360 + R() * 10, (R() - .5) * 0.3, { cost: 6, low: true });
    for (let i = 0; i < 6; i++) this.put('berm_earth', -300 + i * 120 + R() * 30, 362 + R() * 10, Math.PI + (R() - .5) * 0.3, { cost: 6, low: true });
    // concertina belts in front of the trenches
    const C = this.wireT?.concertina?.[0];
    if (C) { const bb = new THREE.Box3().setFromObject(C), len = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z), alongX = (bb.max.x - bb.min.x) >= (bb.max.z - bb.min.z), m = [];
      const belt = (x0, z0, x1, z1) => { const d = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(d / len), ang = Math.atan2(x1 - x0, z1 - z0) + (alongX ? -Math.PI / 2 : 0); for (let i = 0; i < n; i++) { if (R() < 0.15) continue; const f = (i + 0.5) / n, x = x0 + (x1 - x0) * f, z = z0 + (z1 - z0) * f; m.push(trs(x, 0, z, ang)); this.nav.circle(x, z, 0.9, 5); } };
      belt(-250, 2, -100, 2); belt(205, 32, 320, 32); instance(this.scene, C, m); }
  }
  putProp(type, x, z, ry, cost) { const list = this.propT?.[type]; if (!list) return; const t = list[0]; (this.place['pp_' + type] ||= { t, m: [], opts: {} }).m.push(trs(x, 0, z, ry)); const bb = t.userData.bb ||= new THREE.Box3().setFromObject(t); this.nav.rect(x, z, (bb.max.x - bb.min.x) / 2, (bb.max.z - bb.min.z) / 2, ry, cost, 0.1); }
  putSandbag(x, z, r) { this.putProp('sandbag', x, z, r, 7); const i = this.nav.idx(x, z); if (i >= 0) this.nav.low[i] = 1; }
  // ---------------------------------------------------------------- craters (pre-rolled in layoutFields)
  craters() {
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    mat.map = craterTex(); const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
    this.craterCap = 1400; this.craterMesh = new THREE.InstancedMesh(g, mat, this.craterCap); this.craterMesh.count = 0; this.craterMesh.receiveShadow = true; this.craterMesh.frustumCulled = false; this.scene.add(this.craterMesh);
    for (const c of this.pendingCraters || []) this.addCrater(...c); this.pendingCraters = null;
    const T = this.propT?.crater, big = [];
    for (const [x, z, s] of this.craterList) {
      this.addCrater(x, z, s * 2.1);
      if (s > 4.5 && T) { big.push(trs(x, 0, z, this.rng() * 6, s / 4.5)); this.nav.circle(x, z, s * 0.8, 3, true); }
      else if (s > 2.5) this.nav.circle(x, z, s * 0.5, 2, true);
    }
    if (T && big.length) instance(this.scene, T[0], big);
  }
  // distant tree belts and village roofs on the horizon instead of a city skyline
  skyline() {
    const m = new THREE.MeshStandardMaterial({ color: 0x4a5236, roughness: 1 }), geo = new THREE.IcosahedronGeometry(1, 1); geo.translate(0, 0.6, 0);
    const mats = [];
    for (let i = 0; i < 420; i++) {
      const a = this.rng() * Math.PI * 2, r = MAP_SIZE * 0.62 + this.rng() * 420;
      const belt = Math.floor(a / 0.05), L = 6 + this.rng() * 5;
      mats.push(new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng() * 3), new THREE.Vector3(L, 6 + this.rng() * 7, L)));
    }
    const im = new THREE.InstancedMesh(geo, m, mats.length); mats.forEach((M, i) => im.setMatrixAt(i, M)); im.castShadow = false; this.scene.add(im);
  }
  minimapBase(x, k, o) {
    const cols = ['#4a3f31', '#6b6141', '#4b5034', '#574a33', '#5d5739'];
    for (const f of this.fields) { x.fillStyle = cols[f.type]; x.fillRect((f.x0 + o) * k, (f.z0 + o) * k, (f.x1 - f.x0) * k, (f.z1 - f.z0) * k); }
    x.fillStyle = '#5e5643'; for (const g of this.gardenRects || []) x.fillRect((g[0] + o) * k, (g[1] + o) * k, (g[2] - g[0]) * k, (g[3] - g[1]) * k);
  }
  minimapOver(x, k, o) {
    x.strokeStyle = '#2d3f22'; x.lineWidth = Math.max(2, 10 * k); for (const [a, b, c, d] of MAP.treelines) { x.beginPath(); x.moveTo((a + o) * k, (b + o) * k); x.lineTo((c + o) * k, (d + o) * k); x.stroke(); }
    x.fillStyle = '#a89f8c'; for (const [hx, hz, d] of this.houseSpots || []) x.fillRect((hx + o) * k - 1.5, (hz + o) * k - 1.5, 3, 3);
    const f = MAP.farm; x.fillStyle = '#9a9384'; x.fillRect((f.x - 30 + o) * k, (f.z - 33 + o) * k, 60 * k, 12 * k); x.fillRect((f.x - 30 + o) * k, (f.z + 22 + o) * k, 60 * k, 12 * k);
  }
}

function craterTex() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  for (let i = 0; i < 1100; i++) { const a = Math.random() * 6.28, r = 40 + Math.pow(Math.random(), 0.7) * 86; const v = 30 + Math.random() * 50; x.fillStyle = `rgba(${v + 12},${v + 6},${v},${0.18 + Math.random() * 0.45})`; x.beginPath(); x.arc(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, 0.7 + Math.random() * 3, 0, 7); x.fill(); }
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 72);
  g.addColorStop(0, 'rgba(18,15,12,0.9)'); g.addColorStop(0.45, 'rgba(34,28,22,0.8)'); g.addColorStop(0.8, 'rgba(60,50,40,0.4)'); g.addColorStop(1, 'rgba(60,50,40,0)');
  x.fillStyle = g; x.beginPath(); for (let i = 0; i <= 40; i++) { const a = i / 40 * 6.28, r = 60 + (Math.random() - .5) * 20; i ? x.lineTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r) : x.moveTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r); } x.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------------------------------------------------------------- procedural stand-ins (used until farmland.glb exists)
const _fbm = {};
function M(color, extra = {}) { return (_fbm[color] ||= new THREE.MeshStandardMaterial({ color, roughness: 0.95, ...extra })); }
function grp(...meshes) { const g = new THREE.Group(); for (const m of meshes) { m.castShadow = m.receiveShadow = true; g.add(m); } return g; }
function box(w, h, d, c, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M(c)); m.position.set(x, y + h / 2, z); return m; }
function cyl(r0, r1, h, c, x = 0, y = 0, z = 0, seg = 8) { const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, seg), M(c)); m.position.set(x, y + h / 2, z); return m; }
function blob(r, c, x, y, z, sy = 1) { const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), M(c, { flatShading: true })); m.position.set(x, y, z); m.scale.y = sy; return m; }
function fallbackTpl(name) {
  const n = name.replace(/_lod1$/, '');
  const leaf = 0x56603a, bark = 0x4b4239;
  if (/poplar/.test(n)) return grp(cyl(0.15, 0.3, 6, bark), blob(2.2, leaf, 0, 11, 0, 4));
  if (/shelled/.test(n)) return grp(cyl(0.12, 0.28, 7, bark), blob(1.8, 0x5f6040, 1, 7, 0, 0.8));
  if (/^tree_|leafy/.test(n)) return grp(cyl(0.14, 0.3, 4, bark), blob(3.3, leaf, 0, 6.5, 0, 0.85), blob(2.2, 0x5e683f, 1.6, 5.5, 0.8));
  if (/^bush/.test(n)) return grp(blob(1.3, 0x5a6038, 0, 0.9, 0, 0.8));
  if (/sunflower/.test(n)) return grp(...[0, 1, 2, 3, 4].map(i => { const m = cyl(0.02, 0.025, 1.6, 0x4a3b28, Math.cos(i * 1.3) * 0.35, 0, Math.sin(i * 1.3) * 0.35, 4); return m; }), ...[0, 1, 2, 3, 4].map(i => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.04, 7), M(0x2e241a)); m.position.set(Math.cos(i * 1.3) * 0.35, 1.55, Math.sin(i * 1.3) * 0.35 + 0.08); m.rotation.x = 1.2; return m; }));
  if (/corn/.test(n)) return grp(...[0, 1, 2, 3].map(i => cyl(0.02, 0.03, 2.0, 0x8c7a52, Math.cos(i * 1.6) * 0.3, 0, Math.sin(i * 1.6) * 0.3, 4)));
  if (/weeds/.test(n)) return grp(blob(0.5, 0x6d6a45, 0, 0.35, 0, 1.2));
  if (/haybale/.test(n)) { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 1.2, 12), M(/burnt/.test(n) ? 0x2b2620 : 0xa88f5a)); m.rotation.z = Math.PI / 2; m.position.y = 0.75; return grp(m); }
  if (/haystack/.test(n)) { const m = new THREE.Mesh(new THREE.ConeGeometry(2.4, 4.5, 10), M(0x9a8455)); m.position.y = 2.25; return grp(m); }
  if (/barn_kolkhoz/.test(n)) { const g = grp(box(60, 4.2, 12, 0xbdb7a6)); const sh = new THREE.Shape(); sh.moveTo(-6.6, 0); sh.lineTo(6.6, 0); sh.lineTo(0, 2.6); sh.closePath(); const rg = new THREE.ExtrudeGeometry(sh, { depth: 61, bevelEnabled: false }); rg.rotateY(Math.PI / 2); rg.translate(-30.5, 4.2, 0); const r = new THREE.Mesh(rg, M(/damaged/.test(n) ? 0x4e4c47 : 0x8b8d86)); r.castShadow = true; g.add(r); return g; }
  if (/machine_shed/.test(n)) { const g = grp(box(30, 0.3, 15, 0x6d6e68, 0, 6)); for (let i = 0; i < 6; i++) for (const s of [-1, 1]) g.add(box(0.3, 6, 0.3, 0x55554f, -15 + i * 6, 0, s * 7.2)); return g; }
  if (/grain_silo/.test(n)) return grp(cyl(3, 3, 18, 0xa7a49b, -4), cyl(3, 3, 18, 0xa7a49b, 3), box(2, 3, 2, 0x77756e, 0, 17));
  if (/water_tower/.test(n)) return grp(cyl(1.0, 1.0, 14, 0x6b5a4a), cyl(2.6, 2.6, 4, 0x6e5a49, 0, 14));
  if (/tractor|combine/.test(n)) return grp(box(1.9, 1.6, 3.8, /burnt/.test(n) ? 0x2c2622 : 0x3c5a8a, 0, 0.5), box(1.3, 1.2, 1.3, 0x333333, 0, 2.1, -0.6));
  if (/trailer/.test(n)) return grp(box(2.3, 1.1, 5, 0x6a5a40, 0, 0.6));
  if (/well/.test(n)) return grp(box(1.2, 0.9, 1.2, 0x7d6e58), box(1.6, 0.1, 1.6, 0x4c4440, 0, 2));
  if (/shed_wood/.test(n)) return grp(box(4, 2.4, 3, 0x6e5e48), box(4.4, 0.2, 3.4, 0x6f716b, 0, 2.4));
  if (/outhouse/.test(n)) return grp(box(1.1, 2.1, 1.1, 0x6e5e48));
  if (/woodpile/.test(n)) return grp(box(2.5, 1.1, 0.9, 0x7a6248));
  if (/greenhouse/.test(n)) return grp(box(3, 2, 6, 0xb8c0b6));
  if (/fence|gate/.test(n)) return grp(box(3, 1.3, 0.07, /gate/.test(n) ? 0x4f6a5a : 0x6e5e48));
  if (/bus_stop/.test(n)) return grp(box(3.5, 2.6, 0.25, 0xb2ada3, 0, 0, -0.8), box(3.6, 0.2, 1.8, 0x9a958c, 0, 2.6));
  if (/cross/.test(n)) return grp(box(0.15, 2.6, 0.15, 0x5e4a36), box(1.0, 0.12, 0.12, 0x5e4a36, 0, 1.9));
  if (/berm/.test(n)) return grp(box(8, 1.0, 2.2, 0x5a4a38));
  if (/trench/.test(n)) return grp(box(6, 0.55, 0.8, 0x5a4a38, 0, 0, -1.1), box(6, 0.5, 0.7, 0x5a4a38, 0, 0, 1.1), box(6, 0.02, 1.4, 0x2a231b));
  if (/dugout/.test(n)) return grp(box(2.4, 0.8, 2.6, 0x4f4233));
  return null;
}
