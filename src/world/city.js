import * as THREE from 'three';
import { NavGrid, BLOCK } from './nav.js';
import { Building, KitPool } from './buildings.js';
import { instance, trs } from './instancer.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { MAPS } from './maps.js';

// Active map: live bindings, set by setMap() before the world is built.
export let MAP, MAP_SIZE, BOUNDS, ROADS, OBJECTIVES, DEPLOY_ZONES, SPAWNS;
let BUILDINGS, E;
export function setMap(id) {
  MAP = MAPS[id] || MAPS.city;
  MAP_SIZE = MAP.sizeM; BOUNDS = MAP.bounds; ROADS = MAP.roads; OBJECTIVES = MAP.objectives;
  DEPLOY_ZONES = MAP.deployZones; SPAWNS = MAP.spawns; BUILDINGS = MAP.buildings; E = MAP_SIZE / 2 + 2;
  return MAP;
}
setMap('city');
const SIDEWALK = 3.2;

export function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export const onRoad = (x, z, pad = 0) => ROADS.some(r => x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad);

export class City {
  constructor(scene, assets, quality) {
    this.scene = scene; this.assets = assets; this.quality = quality;
    this.rng = mulberry(7031);
    this.nav = new NavGrid(MAP_SIZE, 1);
    this.buildings = []; this.dynamic = new THREE.Group(); scene.add(this.dynamic);
    this.burning = []; this.wrecks = [];
  }
  build() {
    this.lots = (MAP.yards?.lots || []).map(l => [...l]);
    this.ground(); this.roads();
    this.placeBuildings();
    this.rubbleAndDebris();
    this.trees(); this.poles(); this.props(); this.dressing(); this.modernDressing(); this.defences();
    this.craters(); this.paintGround(); this.skyline();
    this.nav.finalize();
  }
  // ---------------------------------------------------------------- ground
  mat(name, repeat, extra = {}) {
    const t = this.assets.tex[name] || {};
    const p = { roughness: 0.95, ...extra };
    for (const k of ['map', 'normalMap', 'roughnessMap', 'aoMap']) if (t[k]) { p[k] = t[k].clone(); p[k].needsUpdate = true; p[k].repeat.set(repeat, repeat); }
    if (p.roughnessMap) p.roughness = 1;
    return new THREE.MeshStandardMaterial(p);
  }
  // Ground: one large plane with a splat-mapped shader (dry grass, worn paths, rubble/gravel, mud)
  // and anti-tiling (two rotated samples blended by noise + macro tint), painted from the layout.
  ground() {
    const S = MAP_SIZE + 1400, g = new THREE.PlaneGeometry(S, S, 1, 1); g.rotateX(-Math.PI / 2);
    const T = this.assets.tex, tex = k => { const t = T[k]?.map; if (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping; } return t; };
    const nrm = T.dirt?.normalMap ? T.dirt.normalMap.clone() : null; if (nrm) { nrm.needsUpdate = true; nrm.repeat.set(S / 6, S / 6); }
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, normalMap: nrm, normalScale: new THREE.Vector2(0.8, 0.8) });
    const U = this.groundUniforms = { tDirt: { value: tex('dirt') }, tGrass: { value: tex('grass') || tex('dirt') }, tRubble: { value: tex('rubble') }, tSplat: { value: null }, splatSize: { value: MAP_SIZE } };
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vWPos; uniform sampler2D tDirt, tGrass, tRubble, tSplat; uniform float splatSize;
        float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(gh(i), gh(i+vec2(1,0)), f.x), mix(gh(i+vec2(0,1)), gh(i+vec2(1,1)), f.x), f.y); }
        vec3 tile(sampler2D t, vec2 p){ // anti-tiling: second sample rotated/offset, blended by low-frequency noise
          vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p * 0.87 + vec2(0.31, 0.57);
          float n = vn(p * 0.35) * 0.7 + vn(p * 1.3) * 0.3;
          return mix(texture2D(t, p).rgb, texture2D(t, q).rgb, smoothstep(0.38, 0.62, n)); }`)
        .replace('#include <map_fragment>', `
          vec2 wp = vWPos.xz;
          vec2 wob = vec2(vn(wp * 0.21) - 0.5, vn(wp * 0.21 + 31.0) - 0.5) * 2.2;   // break up blurred mask edges
          vec4 sp = texture2D(tSplat, clamp((wp + wob) / splatSize + 0.5, 0.002, 0.998));
          float outside = smoothstep(splatSize * 0.5 - 6.0, splatSize * 0.5 + 4.0, max(abs(wp.x), abs(wp.y)));
          sp = mix(sp, vec4(smoothstep(0.35, 0.6, vn(wp * 0.03)) * 0.85, 0.0, 0.0, 0.25), outside);
          vec3 dirt = tile(tDirt, wp / 6.0), grass = tile(tGrass, wp / 3.5), rub = tile(tRubble, wp / 5.0);
          // dry, sun-bleached grass: match the dirt's brightness, desaturate toward straw, let dirt show through
          float gl = dot(grass, vec3(0.299, 0.587, 0.114)), dl = dot(dirt, vec3(0.299, 0.587, 0.114));
          grass = mix(vec3(gl), grass, 0.7) * vec3(1.0, 1.0, 0.84);
          grass *= clamp(dl / max(gl, 0.02), 1.0, 1.45);
          grass = mix(grass, dirt * vec3(1.0, 0.98, 0.88), smoothstep(0.45, 0.75, vn(wp * 0.35)) * 0.4);
          // height blending: each layer's own luminance acts as height so transitions follow the texture
          float hd = dot(dirt, vec3(0.33)), hg = dot(grass, vec3(0.33)), hr = dot(rub, vec3(0.33));
          float fine = vn(wp * 1.7);
          float wg = smoothstep(0.0, 1.0, clamp(sp.r * 1.3 - 0.12 + (hg - hd) * 0.7 + (fine - 0.5) * 0.35 + (vn(wp * 0.45) - 0.5) * 0.3, 0.0, 1.0));
          float wr = smoothstep(0.0, 1.0, clamp(sp.g * 1.4 - 0.2 + (hr - 0.45) * 1.0 + (fine - 0.5) * 0.35, 0.0, 1.0));
          float wm = smoothstep(0.0, 1.0, clamp(sp.b * 1.6 - 0.3 + (0.5 - hd) * 1.2 + (vn(wp * 0.7) - 0.5) * 0.6, 0.0, 1.0));
          vec3 col = dirt;
          col = mix(col, dirt * vec3(1.12, 1.08, 1.0), sp.a);            // trampled paths
          col = mix(col, grass, wg * (1.0 - sp.a * 0.8));
          col = mix(col, rub, wr);
          col = mix(col, dirt * vec3(0.5, 0.46, 0.42), wm * 0.85);       // wet mud / scorched
          col *= 0.86 + 0.28 * (vn(wp * 0.015) * 0.6 + vn(wp * 0.06) * 0.4); // macro variation
          diffuseColor.rgb *= col;`);
    };
    const ground = new THREE.Mesh(g, m); ground.receiveShadow = true; ground.name = 'ground'; this.scene.add(ground);
    this.groundMesh = ground;
  }
  // value-noise helper for painting
  noise2(x, z, s) { const h = (a, b) => { const t = Math.sin(a * 127.1 + b * 311.7 + s * 17.3) * 43758.5453; return t - Math.floor(t); }; const i = Math.floor(x), j = Math.floor(z), f = x - i, g = z - j, u = f * f * (3 - 2 * f), v = g * g * (3 - 2 * g); return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v; }
  // paint the splat map from the finished layout (call after buildings, rubble and craters exist)
  paintGround() {
    const N = 1024, k = N / MAP_SIZE, o = MAP_SIZE / 2, layer = () => { const c = document.createElement('canvas'); c.width = c.height = N; return c; };
    const toPx = (x, z) => [(x + o) * k, (z + o) * k];
    const R = this.rng;
    // rubble/gravel around blocks, rubble piles and craters
    const rub = layer(), rx = rub.getContext('2d'); rx.filter = `blur(${5 * k}px)`; rx.fillStyle = '#fff';
    for (const b of this.buildings) { rx.save(); rx.translate(...toPx(b.x, b.z)); rx.rotate(-b.rot); rx.globalAlpha = 0.22 + R() * 0.15; rx.fillRect((-b.L / 2 - 3.5) * k, (-b.D / 2 - 3.5) * k, (b.L + 7) * k, (b.D + 7) * k); rx.restore(); }
    rx.globalAlpha = 0.6; const v = new THREE.Vector3();
    for (const list of this.rubbleInstances || []) for (const M of list) { v.setFromMatrixPosition(M); rx.beginPath(); for (let i = 0; i <= 10; i++) { const a = i / 10 * 6.28, rr = 2.2 + R() * 2.2; const [a1, b1] = toPx(v.x + Math.cos(a) * rr, v.z + Math.sin(a) * rr); i ? rx.lineTo(a1, b1) : rx.moveTo(a1, b1); } rx.fill(); }
    // worn paths: each entrance to the nearest road edge, plus along the courtyard face
    const pth = layer(), px = pth.getContext('2d'); px.filter = `blur(${1.2 * k}px)`; px.strokeStyle = '#fff'; px.lineCap = 'round';
    for (const b of this.buildings) {
      px.lineWidth = 2.4 * k; px.globalAlpha = 0.8;
      for (const e of b.entrances) {
        let best = null, bd = 1e9; for (const r of ROADS) { const cx = Math.max(r.x0 - SIDEWALK, Math.min(r.x1 + SIDEWALK, e.x)), cz = Math.max(r.z0 - SIDEWALK, Math.min(r.z1 + SIDEWALK, e.z)); const d = Math.hypot(cx - e.x, cz - e.z); if (d < bd) { bd = d; best = [cx, cz]; } }
        if (best && bd < 90) { px.beginPath(); px.moveTo(...toPx(e.x, e.z)); if (Math.abs(best[0] - e.x) > 0.5 && Math.abs(best[1] - e.z) > 0.5) px.lineTo(...toPx(e.x, best[1])); px.lineTo(...toPx(best[0], best[1])); px.stroke(); }
      }
      if (b.entrances.length > 1) { px.lineWidth = 3 * k; px.globalAlpha = 0.6; px.beginPath(); px.moveTo(...toPx(b.entrances[0].x, b.entrances[0].z)); for (const e of b.entrances) px.lineTo(...toPx(e.x, e.z)); px.stroke(); }
    }
    // mud: craters only (scorched, churned)
    const mud = layer(), mx = mud.getContext('2d'); mx.filter = `blur(${2 * k}px)`; mx.fillStyle = '#fff';
    const cm = this.craterMesh, M = new THREE.Matrix4(), sc = new THREE.Vector3(), q = new THREE.Quaternion();
    const blob = (ctx, x, z, r, alpha) => { ctx.globalAlpha = alpha; ctx.beginPath(); const n = 14, ph = R() * 6.28; for (let i = 0; i <= n; i++) { const a = i / n * 6.28, rr = r * (0.55 + 0.45 * this.noise2(Math.cos(a + ph) * 2 + x, Math.sin(a + ph) * 2 + z, 9) + (R() - .5) * 0.25); const [px2, pz2] = toPx(x + Math.cos(a) * rr, z + Math.sin(a) * rr); i ? ctx.lineTo(px2, pz2) : ctx.moveTo(px2, pz2); } ctx.fill(); };
    if (cm) for (let i = 0; i < cm.count; i++) { cm.getMatrixAt(i, M); M.decompose(v, q, sc); blob(mx, v.x, v.z, sc.x * 0.6, 0.5); blob(rx, v.x, v.z, sc.x * 0.9, 0.25); }
    // lawns: an ordered plan — the whole district is laid out as courtyard lawns and road verges, then we cut
    // out roads + pavements, a trampled apron around every block, straight footpaths and the dirt yards
    const lawn = layer(), lx = lawn.getContext('2d'); lx.fillStyle = '#fff'; lx.fillRect(0, 0, N, N);
    lx.globalCompositeOperation = 'destination-out'; lx.fillStyle = '#000'; lx.strokeStyle = '#000'; lx.lineCap = 'butt';
    for (const l of this.lots || []) lx.fillRect(...toPx(l[0] - 1, l[1] - 1), (l[2] - l[0] + 2) * k, (l[3] - l[1] + 2) * k);
    for (const r of ROADS) { const sw = (r.type === 'drive' ? 1.3 : SIDEWALK) + 0.6; lx.fillRect(...toPx(r.x0 - sw, r.z0 - sw), (r.x1 - r.x0 + sw * 2) * k, (r.z1 - r.z0 + sw * 2) * k); }
    for (const b of this.buildings) { lx.save(); lx.translate(...toPx(b.x, b.z)); lx.rotate(-b.rot); lx.fillRect((-b.L / 2 - 1.3) * k, (-b.D / 2 - 1.3) * k, (b.L + 2.6) * k, (b.D + 2.6) * k); lx.restore(); }
    for (const b of this.buildings) for (const e of b.entrances) {
      let best = null, bd = 1e9; for (const r of ROADS) { const cx = Math.max(r.x0 - SIDEWALK, Math.min(r.x1 + SIDEWALK, e.x)), cz = Math.max(r.z0 - SIDEWALK, Math.min(r.z1 + SIDEWALK, e.z)); const d = Math.hypot(cx - e.x, cz - e.z); if (d < bd) { bd = d; best = [cx, cz]; } }
      if (best && bd < 90) { lx.lineWidth = 1.7 * k; lx.beginPath(); lx.moveTo(...toPx(e.x, e.z)); if (Math.abs(best[0] - e.x) > 0.5 && Math.abs(best[1] - e.z) > 0.5) lx.lineTo(...toPx(e.x, best[1])); lx.lineTo(...toPx(best[0], best[1])); lx.stroke(); }
    }
    for (const [x, z, r, rot] of this.dirtYards || []) { lx.save(); lx.translate(...toPx(x, z)); lx.rotate(-rot); lx.fillRect(-r * k, -r * 0.7 * k, r * 2 * k, r * 1.4 * k); lx.restore(); }
    lx.globalCompositeOperation = 'source-over';
    const lawnB = layer(), lb = lawnB.getContext('2d'); lb.filter = `blur(${2.2 * k}px)`; lb.drawImage(lawn, 0, 0);
    const g1 = rx.getImageData(0, 0, N, N).data, g2 = px.getImageData(0, 0, N, N).data, g3 = mx.getImageData(0, 0, N, N).data, g4 = lb.getImageData(0, 0, N, N).data;
    const out = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = i / k - o, z = j / k - o, p = (j * N + i) * 4;
      const rubble = g1[p] / 255, path = g2[p] / 255, lw = g4[p] / 255;
      const n1 = this.noise2(x / 14, z / 14, 1);
      // lawns are full; only shell-churned / heavily walked spots wear through
      // soft, irregular lawn edges: grass thins out over a couple of metres instead of stopping on a line
      const edge = Math.min(1, Math.max(0, lw + (this.noise2(x / 3.5, z / 3.5, 6) - 0.5) * 0.45 * (1 - Math.abs(lw * 2 - 1))));
      let grass = Math.max(edge * (0.84 + n1 * 0.16), 0.22 * this.noise2(x / 6, z / 6, 3)) * (1 - rubble * 0.6) * (1 - path * 0.5);
      const mudv = g3[p] / 255 * (0.6 + this.noise2(x / 2, z / 2, 5) * 0.5);
      out[p] = grass * 255; out[p + 1] = Math.min(1, rubble * (0.35 + this.noise2(x / 4, z / 4, 4) * 0.8)) * 255; out[p + 2] = mudv * 255; out[p + 3] = Math.max(path, (1 - lw) * 0.5) * 255;
    }
    const t = new THREE.DataTexture(out, N, N, THREE.RGBAFormat); t.flipY = false; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    this.groundUniforms.tSplat.value = t; this.splatData = out; this.splatN = N;
    this.grassClumps();
  }
  // scattered dry-grass / weed clumps (crossed quads, alpha-tested) where the splat says grass
  grassClumps() {
    // blade atlas: thin tapered blades and seed heads on transparent background
    const c = document.createElement('canvas'); c.width = 256; c.height = 256; const x = c.getContext('2d');
    for (let i = 0; i < 160; i++) {
      const bx = 128 + (Math.random() - .5) * 220, h = 70 + Math.random() * 170, lean = (Math.random() - .5) * 70, w = 2 + Math.random() * 3;
      const g = Math.random(); const col = g < 0.5 ? [150 + Math.random() * 22, 150 + Math.random() * 18, 92 + Math.random() * 14] : [170 + Math.random() * 22, 158 + Math.random() * 18, 106 + Math.random() * 14];
      const gr = x.createLinearGradient(0, 256, 0, 256 - h); gr.addColorStop(0, `rgb(${col[0] * 0.78 | 0},${col[1] * 0.78 | 0},${col[2] * 0.72 | 0})`); gr.addColorStop(0.45, `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`); gr.addColorStop(1, `rgb(${Math.min(255, col[0] * 1.12) | 0},${Math.min(255, col[1] * 1.08) | 0},${col[2] * 1.05 | 0})`);
      x.fillStyle = gr;
      x.beginPath(); x.moveTo(bx - w, 256); x.quadraticCurveTo(bx + lean * 0.4 - w * 0.5, 256 - h * 0.55, bx + lean, 256 - h); x.quadraticCurveTo(bx + lean * 0.4 + w * 0.5, 256 - h * 0.55, bx + w, 256); x.fill();
      if (Math.random() < 0.12) { x.fillStyle = 'rgb(160,140,96)'; x.beginPath(); x.ellipse(bx + lean, 256 - h, 2.5, 7, lean * 0.01, 0, 7); x.fill(); }
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    const mat = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1, color: 0xffffff });
    const wind = this.windUniform = { value: 0 };
    mat.onBeforeCompile = sh => {
      sh.uniforms.uTime = wind;
      // double-sided cards: three.js flips the normal on back faces, which lit the far side of every clump
      // as a dark, almost black blade — keep the (upward) normal on both sides so all blades shade alike
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize( vNormal );');
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 ip = instanceMatrix[3].xyz;
            float sway = sin(uTime * 1.7 + ip.x * 0.35 + ip.z * 0.27) * 0.12 + sin(uTime * 3.1 + ip.x * 1.3) * 0.04;
            transformed.x += sway * position.y * position.y; transformed.z += sway * 0.6 * position.y * position.y;
          #endif`);
    };
    // three crossed quads per clump
    const qs = [0, 1, 2].map(i => { const q = new THREE.PlaneGeometry(1, 1); q.translate(0, 0.5, 0); q.rotateY(i * Math.PI / 3); return q; });
    const gg = mergeGeometries(qs); const nrm = gg.attributes.normal; for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0); // light like the ground
    const tpl = new THREE.Mesh(gg, mat);
    const N = this.splatN, k = N / MAP_SIZE, o = MAP_SIZE / 2, mats = [], cols = [];
    const maxN = this.grassMax || 80000;
    for (let i = 0; i < maxN * 3.2 && mats.length < maxN; i++) {
      const px = (this.rng() - .5) * MAP_SIZE, pz = (this.rng() - .5) * MAP_SIZE;
      const si = (Math.floor((pz + o) * k) * N + Math.floor((px + o) * k)) * 4; const gw = this.splatData[si] / 255;
      if (gw < 0.35 || this.rng() > gw) continue;
      if (onRoad(px, pz, SIDEWALK + 0.4) || (this.lots || []).some(l => px > l[0] && px < l[2] && pz > l[1] && pz < l[3])) continue; const ni = this.nav.idx(px, pz); if (ni < 0 || this.nav.cost[ni] !== 1) continue;
      const s = 0.35 + this.rng() * 0.55; mats.push(trs(px, 0, pz, this.rng() * 6.28, 1).multiply(new THREE.Matrix4().makeScale(s * 1.6, s, s * 1.6)));
      cols.push(new THREE.Color().setHSL(0.15 + (this.rng() - .5) * 0.03, 0.12 + this.rng() * 0.08, 0.9 + this.rng() * 0.08));
    }
    // the lawns carry on past the playable edge (thinner, patchy) so the grass doesn't stop on a line
    if (!this.noOuterGrass) {
      const half = MAP_SIZE / 2, extra = Math.round(maxN * 0.45);
      for (let i = 0, n = 0; i < extra * 4 && n < extra; i++) {
        const px = (this.rng() - .5) * (MAP_SIZE + 320), pz = (this.rng() - .5) * (MAP_SIZE + 320);
        if (Math.max(Math.abs(px), Math.abs(pz)) < half + 2) continue;
        if (Math.abs(pz) < 15 || Math.abs(px - 85) < 11 || Math.abs(px + 204) < 7 || Math.abs(px - 202) < 7 || Math.abs(Math.abs(pz) - 197) < 7) continue;
        if (this.noise2(px * 0.03, pz * 0.03, 12) < 0.4) continue;
        const s = 0.35 + this.rng() * 0.5; mats.push(trs(px, 0, pz, this.rng() * 6.28, 1).multiply(new THREE.Matrix4().makeScale(s * 1.6, s, s * 1.6)));
        cols.push(new THREE.Color().setHSL(0.15 + (this.rng() - .5) * 0.03, 0.12 + this.rng() * 0.08, 0.9 + this.rng() * 0.08)); n++;
      }
    }
    instance(this.scene, tpl, mats, { shadows: false, colors: cols, cullDist: this.grassCull || 340 });
  }
  roads() {
    const asphalt = this.mat('asphalt', 1, { color: 0xd8d4cc, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const walk = this.mat('concrete', 1, { color: 0xbab4a8, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const curbMat = this.assets.tex.curb ? this.mat('curb', 1, { color: 0xffffff }) : new THREE.MeshStandardMaterial({ color: 0x9d988c, roughness: 0.9 });
    const uvPlane = (w, d, scale) => { const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / scale, uv.getY(i) * d / scale); return g; };
    for (const r of ROADS) this.nav.markRoad(r.x0, r.z0, r.x1, r.z1, 2);
    for (const r of ROADS) {
      const w = r.x1 - r.x0, d = r.z1 - r.z0;
      const sw = r.type === 'drive' ? 1.3 : SIDEWALK, s = new THREE.Mesh(uvPlane(w + sw * 2, d + sw * 2, 4), walk); s.position.set((r.x0 + r.x1) / 2, 0.03, (r.z0 + r.z1) / 2); s.receiveShadow = true; this.scene.add(s);
    }
    for (const r of ROADS) {
      const w = r.x1 - r.x0, d = r.z1 - r.z0;
      const a = new THREE.Mesh(uvPlane(w, d, 7), asphalt); a.position.set((r.x0 + r.x1) / 2, 0.05, (r.z0 + r.z1) / 2); a.receiveShadow = true; this.scene.add(a);
      // lane markings (worn) — not on the single-lane courtyard driveways
      if (r.type === 'drive') continue;
      const horiz = w > d; const len = horiz ? w : d;
      const dash = new THREE.MeshStandardMaterial({ color: 0xc9c5b8, roughness: 0.9, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -3 });
      const mats = [];
      for (let t = -len / 2 + 2; t < len / 2; t += 9) if (this.rng() > 0.25) mats.push(horiz ? trs((r.x0 + r.x1) / 2 + t, 0.06, (r.z0 + r.z1) / 2, 0) : trs((r.x0 + r.x1) / 2, 0.06, (r.z0 + r.z1) / 2 + t, Math.PI / 2));
      const dg = new THREE.PlaneGeometry(3, 0.15); dg.rotateX(-Math.PI / 2);
      instance(this.scene, new THREE.Mesh(dg, dash), mats, { shadows: false });
    }
    // curbs along road edges, broken at intersections
    const curbs = [];
    for (const r of ROADS) {
      const horiz = (r.x1 - r.x0) > (r.z1 - r.z0);
      for (const edge of horiz ? [r.z0, r.z1] : [r.x0, r.x1]) {
        const from = horiz ? r.x0 : r.z0, to = horiz ? r.x1 : r.z1;
        for (let t = from; t < to; t += 1.0) {
          const x = horiz ? t + 0.5 : edge, z = horiz ? edge : t + 0.5;
          if (ROADS.some(o => o !== r && x > o.x0 - 0.5 && x < o.x1 + 0.5 && z > o.z0 - 0.5 && z < o.z1 + 0.5)) continue;
          if (this.rng() < 0.04) continue; // missing curb stones
          curbs.push(trs(x, 0.08, z, horiz ? 0 : Math.PI / 2, 1, 0, (this.rng() - .5) * 0.04));
        }
      }
    }
    const cg = new THREE.BoxGeometry(0.98, 0.2, 0.22);
    instance(this.scene, new THREE.Mesh(cg, curbMat), curbs);
  }
  // ---------------------------------------------------------------- buildings
  placeBuildings() {
    const kit = this.assets.kit;
    this.pool = new KitPool(this.scene, kit);
    const signNames = Object.keys(kit.pieces).filter(k => /^sign_.*_intact$/.test(k));
    for (const [x, z, rot, modules, floors, depthModules, sections, kind, dmg, extra] of BUILDINGS) {
      const b = new Building({ x, z, rot, modules, floors, depthModules, sections, kind, ...(extra || {}), signNames }, kit);
      b.predamage(dmg);
      this.buildings.push(b);
    }
    // a pancaked section on the nine-storey at (30,-68) and the one at (-150,-60)
    for (const [i, a, c] of MAP.pancakes || []) this.buildings[i]?.pancake(a, c);
    const aabb = b => { const c = Math.abs(Math.cos(b.rot)), sn = Math.abs(Math.sin(b.rot)); const hx = (b.L * c + b.D * sn) / 2, hz = (b.L * sn + b.D * c) / 2; return [b.x - hx, b.x + hx, b.z - hz, b.z + hz]; };
    this.buildings.forEach((b, i) => { const A = aabb(b);
      this.buildings.forEach((o, j) => { if (j <= i) return; const B = aabb(o); if (A[0] < B[1] && A[1] > B[0] && A[2] < B[3] && A[3] > B[2]) console.warn('building overlap', i, j); });
      for (const r of ROADS) if (A[0] < r.x1 + SIDEWALK && A[1] > r.x0 - SIDEWALK && A[2] < r.z1 + SIDEWALK && A[3] > r.z0 - SIDEWALK) console.warn('building on road', i, JSON.stringify(r)); });
    for (const b of this.buildings) b.requestKit(this.pool);
    this.pool.build();
    for (const b of this.buildings) b.place(this.pool);
    this.pool.finish();
    // interiors (instanced boxes)
    const cnt = this.buildings.reduce((a, b) => a + b.modules * b.floors, 0);
    const slabMat = new THREE.MeshStandardMaterial({ color: 0x8a857c, roughness: 0.95 });
    const wp = document.createElement('canvas'); wp.width = 64; wp.height = 64; { const x = wp.getContext('2d'); x.fillStyle = '#5a5246'; x.fillRect(0, 0, 64, 64); for (let i = 0; i < 64; i += 8) { x.fillStyle = i % 16 ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.05)'; x.fillRect(i, 0, 4, 64); } const g = x.createLinearGradient(0, 0, 0, 64); g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(0.6, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.25)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64); }
    const wpt = new THREE.CanvasTexture(wp); wpt.colorSpace = THREE.SRGBColorSpace;
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x8a8279, map: wpt, roughness: 1, envMapIntensity: 0.3 });
    const box = new THREE.BoxGeometry(1, 1, 1);
    const slab = new THREE.InstancedMesh(box, slabMat, cnt), dark = new THREE.InstancedMesh(box, darkMat, cnt);
    const counters = { slab: 0, dark: 0, roofs: [] };
    for (const b of this.buildings) b.buildInterior(slab, dark, counters);
    slab.count = counters.slab; dark.count = counters.dark; this.slabMesh = slab; this.darkMesh = dark; slab.castShadow = slab.receiveShadow = true; dark.receiveShadow = true;
    this.scene.add(slab, dark);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x3b3934, roughness: 0.9 });
    const roofs = new THREE.InstancedMesh(box, roofMat, Math.max(1, counters.roofs.length)); counters.roofs.forEach((m, i) => roofs.setMatrixAt(i, m));
    roofs.castShadow = roofs.receiveShadow = true; this.scene.add(roofs); this.roofMesh = roofs; this.falling = [];
    // nav + occluders (one per contiguous standing part; pancaked gap leaves a passage)
    for (const b of this.buildings) {
      const { W } = kit;
      const parts = b.pancaked ? [[0, b.pancaked[0] - 1], [b.pancaked[1] + 1, b.modules - 1]] : [[0, b.modules - 1]];
      b.occ = [];
      for (const [a, c] of parts) {
        if (c < a) continue;
        const lx = -b.L / 2 + ((a + c + 1) / 2) * W, hx = (c - a + 1) * W / 2;
        const ctr = b.toWorld(lx, 0, 0);
        this.nav.rect(ctr.x, ctr.z, hx, b.D / 2, b.rot, BLOCK, 0.3);
        b.occ.push(this.nav.addOccluder(ctr.x, ctr.z, hx, b.D / 2, b.rot, b.height, b));
      }
    }
  }
  // Facade decals that break up the repeating damage kit: soot plumes above burnt-out windows, shrapnel
  // pock-mark clusters on spandrels, big scorches on blank end walls. Placed only on solid wall areas
  // (window head 2.30 m .. next sill 3.66 m), hidden again when the panel they sit on goes.
  facadeDecals() {
    const kinds = ['soot', 'pocks', 'scorch', 'streak'], tex = kinds.map(decalTexture);
    const g = new THREE.PlaneGeometry(1, 1); g.translate(0, 0.5, 0);
    const meshes = tex.map(t => { const m = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ map: t, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), 2600); m.count = 0; m.receiveShadow = true; m.frustumCulled = false; this.scene.add(m); return m; });
    const { W, H } = this.assets.kit, R = this.rng, list = this.decals = [], q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), v = new THREE.Vector3(), sc = new THREE.Vector3();
    const add = (k, b, p, lx, y, w, h, dep) => {
      const m = meshes[k]; if (m.count >= 2600) return;
      const o = b.outward(p), c = b.panelCenter(p, new THREE.Vector3()), side = new THREE.Vector3(o.z, 0, -o.x);
      v.copy(c).addScaledVector(side, lx).addScaledVector(o, 0.02); v.y = p.floor * H + y;
      q.setFromAxisAngle(Y, b.rot + p.rot); sc.set(w, h, 1);
      const M = new THREE.Matrix4().compose(v, q, sc); const i = m.count++; m.setMatrixAt(i, M);
      list.push({ m, i, p, dep });
    };
    for (const b of this.buildings) {
      const at = b.panelMap || new Map();
      for (const p of b.panels) {
        if (p.gone || p.state === 3 || p.shop) continue;
        const up = at.get(p.side + ':' + p.col + ':' + (p.floor + 1));
        const blank = /blank/.test(p.type);
        if (blank) {
          if (p.state >= 1 && R() < 0.55) add(2, b, p, (R() - .5) * 1.2, 0.3 + R() * 1.0, 1.6 + R() * 1.6, 1.4 + R() * 1.3, null);
          if (R() < 0.35 + p.state * 0.2) add(1, b, p, (R() - .5) * 1.6, 0.4 + R() * 1.6, 0.9 + R() * 1.2, 0.8 + R() * 0.9, null);
          if (R() < 0.12) add(3, b, p, (R() - .5) * 2, 0.8, 0.5 + R() * 0.5, 1.8 + R() * 1.2, null);
          continue;
        }
        if (up && (up.state === 3 || up.gone)) continue;
        const band = up?.balcony ? 0.5 : 1.28;               // solid wall between this window head and the next sill
        if (p.state >= 2 && R() < 0.8) add(0, b, p, (R() - .5) * 0.3, 2.33, 1.2 + R() * 0.6, band, up);
        else if (p.state >= 1 && R() < 0.45) add(1, b, p, (R() - .5) * 1.2, 2.34, 0.8 + R() * 0.8, Math.min(band, 0.6 + R() * 0.6), up);
        else if (R() < 0.08) add(3, b, p, (R() - .5) * 2.4, 2.33, 0.35 + R() * 0.3, band, up);
      }
    }
    for (const m of meshes) { m.instanceMatrix.needsUpdate = true; }
  }
  // hide decals whose wall is gone (called from the game a few times a second)
  updateDecals() {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const d of this.decals || []) { if (d.off) continue; const b = d.p.b; if (d.p.gone || d.p.state === 3 || (d.dep && (d.dep.gone || d.dep.state === 3)) || (b && b.goneCols?.has(d.p.col) && (d.p.side === 'front' || d.p.side === 'back'))) { d.off = true; d.m.setMatrixAt(d.i, zero); d.m.instanceMatrix.needsUpdate = true; } }
  }
  // ---------------------------------------------------------------- rubble
  rubbleTemplates() {
    if (this._rt) return this._rt;
    const keys = this.assets.rubbleKeys || [];
    this._rt = keys.map(k => this.assets.gltf[k].scene);
    if (!this._rt.length) {
      // fallback: chunky pile of broken slabs
      const m = new THREE.MeshStandardMaterial({ color: 0x8e887d, roughness: 0.95, flatShading: true });
      for (let v = 0; v < 3; v++) {
        const g = new THREE.Group(), r = mulberry(v + 11);
        const mound = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 1), m); mound.scale.set(3, 1.1, 2.4); mound.position.y = -0.2; g.add(mound);
        for (let i = 0; i < 9; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.4 + r() * 1.6, 0.18, 0.4 + r() * 1.2), m); s.position.set((r() - .5) * 4, 0.3 + r() * 0.6, (r() - .5) * 3); s.rotation.set(r() * 1.2, r() * 3, r() * 1.2); g.add(s); }
        g.traverse(o => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
        this._rt.push(g);
      }
    }
    for (const t of this._rt) { const b = new THREE.Box3().setFromObject(t); t.userData.r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2; t.userData.h = b.max.y; }
    return this._rt;
  }
  rubbleAndDebris() {
    const T = this.rubbleTemplates(), place = T.map(() => []);
    const add = (x, z, s, ry, own = null) => {
      if (onRoad(x, z, -1) && this.rng() < 0.5) s *= 0.6;
      const k0 = Math.floor(this.rng() * T.length), rr = T[k0].userData.r * s;
      if (this.buildings.some(b => b !== own && (() => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + rr * 0.7 && Math.abs(lz) < b.D / 2 + rr * 0.7; })())) return;
      const k = k0; place[k].push(trs(x, 0, z, ry, s));
      const r = rr;
      this.nav.circle(x, z, r * 0.65, r * s > 2.5 ? 7 : 4, true);
    };
    for (const b of this.buildings) {
      // debris fans under destroyed/holed panels
      for (const p of b.panels) {
        if (p.state < 2 || p.floor > 3) continue;
        if (p.state === 2 && this.rng() < 0.6) continue;
        const c = b.panelCenter(p), o = b.outward(p);
        const sc = 0.6 + this.rng() * 0.5 + (p.state === 3 ? 0.4 : 0), off = T[0].userData.r * sc * 0.42 + this.rng() * 0.5;
        add(c.x + o.x * off, c.z + o.z * off, sc, this.rng() * 6.28, b);
      }
      if (b.pancaked) for (let c = b.pancaked[0]; c <= b.pancaked[1]; c++) for (let k = 0; k < 3; k++) {
        const w = b.toWorld(-b.L / 2 + (c + 0.5) * this.assets.kit.W + (this.rng() - .5) * 3, 0, (this.rng() - .5) * b.D * 1.4);
        add(w.x, w.z, 1.6 + this.rng() * 0.9, this.rng() * 6.28);
      }
      if (b.collapsedCorner) for (let k = 0; k < 3; k++) {
        const ex = (b.collapsedCorner === 'right' ? 1 : -1) * (b.L / 2 + 2 + this.rng() * 3);
        const w = b.toWorld(ex, 0, (this.rng() - .5) * b.D); add(w.x, w.z, 1.0 + this.rng() * 0.7, this.rng() * 6.28);
      }
    }
    // scattered debris on streets
    // loose debris lies along the foot of the walls it fell from, not in the middle of yards
    for (let i = 0; i < (this.streetDebris ?? 18) && this.buildings.length; i++) {
      const b = this.buildings[Math.floor(this.rng() * this.buildings.length)], side = Math.floor(this.rng() * 4), s = 0.35 + this.rng() * 0.4, rr = T[0].userData.r * s * 0.45;
      const u = (this.rng() - .5) * 0.9, w = side < 2 ? b.toWorld(u * b.L, 0, (side ? 1 : -1) * (b.D / 2 + rr)) : b.toWorld((side === 2 ? 1 : -1) * (b.L / 2 + rr), 0, u * b.D);
      add(w.x, w.z, s, this.rng() * 6.28, b);
    }
    T.forEach((t, k) => place[k].length && instance(this.scene, t, place[k]));
    this.rubbleInstances = place;
  }
  // Dynamic rubble when panels are destroyed during play.
  spawnRubble(x, z, s) {
    const T = this.rubbleTemplates(); const t = T[Math.floor(Math.random() * T.length)].clone();
    t.position.set(x, -0.6 * s, z); t.rotation.y = Math.random() * 6.28; t.scale.setScalar(s); t.userData.rise = 0.6 * s;
    this.dynamic.add(t); this.nav.circle(x, z, t.userData.r * s * 0.6, 4, true);
    return t;
  }
  // ---------------------------------------------------------------- vegetation
  templatesFrom(key, tests) {
    const g = this.assets.gltf[key]; const out = {};
    if (!g) return out;
    for (const c of g.scene.children) for (const [type, re] of Object.entries(tests)) if (re.test(c.name)) (out[type] ||= []).push(c);
    return out;
  }
  trees() {
    let T = this.templatesFrom('trees', { leafy: /leaf|green|summer|alive/i, stump: /stump/i, fallen: /fallen|log/i, bare: /strip|bare|broken|dead|poplar|chestnut|birch|tree/i });
    if (!T.bare) {
      const bark = new THREE.MeshStandardMaterial({ color: 0x4b4239, roughness: 1 });
      const mk = (seed, leafy) => { const g = new THREE.Group(), r = mulberry(seed);
        const h = 7 + r() * 5; const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.25, h, 7), bark); tr.position.y = h / 2; g.add(tr);
        for (let i = 0; i < 7; i++) { const l = 1.5 + r() * 2.5; const b = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.08, l, 5), bark); b.position.set(0, h * (0.45 + r() * 0.5), 0); b.rotation.set(0.6 + r() * 0.5, r() * 6.28, 0, 'YXZ'); b.translateY(l / 2); g.add(b); }
        if (leafy) { const f = new THREE.Mesh(new THREE.IcosahedronGeometry(2.6, 1), new THREE.MeshStandardMaterial({ color: 0x5d5f32, roughness: 1, flatShading: true })); f.position.y = h * 0.85; f.scale.y = 1.3; g.add(f); }
        g.traverse(o => o.isMesh && (o.castShadow = true)); return g; };
      T = { bare: [mk(1), mk(2), mk(3)], leafy: [mk(4, true)] };
    }
    const spots = [];
    // street trees: rows along both verges of every road (avenue limes/chestnuts, poplars on the driveways)
    for (const r of ROADS) {
      const horiz = (r.x1 - r.x0) > (r.z1 - r.z0), step = r.type === 'drive' ? 13 : 11, off = (horiz ? (r.z1 - r.z0) : (r.x1 - r.x0)) / 2 + SIDEWALK + 2.2;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, a0 = horiz ? r.x0 : r.z0, a1 = horiz ? r.x1 : r.z1;
      for (let t = a0 + 6; t < a1 - 6; t += step) for (const sd of [-1, 1]) {
        if (this.rng() > (r.w === 'avenue' ? 0.85 : 0.6)) continue;
        const x = horiz ? t + (this.rng() - .5) * 1.5 : cx + sd * off, z = horiz ? cz + sd * off : t + (this.rng() - .5) * 1.5;
        if (!onRoad(x, z, 1.5)) spots.push([x, z]);
      }
    }
    // courtyards
    for (let i = 0; i < 110; i++) { const x = (this.rng() - .5) * (MAP_SIZE - 40), z = (this.rng() - .5) * (MAP_SIZE - 40); if (!onRoad(x, z, 4)) spots.push([x, z]); }
    const by = {}, inLot = (x, z) => (this.lots || []).some(l => x > l[0] - 2 && x < l[2] + 2 && z > l[1] - 2 && z < l[3] + 2);
    for (const [x, z] of spots) {
      if (inLot(x, z)) continue;
      const i = this.nav.idx(x, z); if (i < 0 || this.nav.cost[i] === BLOCK) continue;
      if (this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + 3 && Math.abs(lz) < b.D / 2 + 3; })) continue;
      const roll = this.rng();
      const type = roll < 0.12 && T.leafy ? 'leafy' : roll < 0.22 && T.stump ? 'stump' : roll < 0.27 && T.fallen ? 'fallen' : 'bare';
      const list = T[type]; const k = Math.floor(this.rng() * list.length);
      (by[type + k] ||= { t: list[k], m: [] }).m.push(trs(x, 0, z, this.rng() * 6.28, 0.85 + this.rng() * 0.35));
      this.nav.circle(x, z, type === 'fallen' ? 1.2 : 0.5, type === 'fallen' ? 5 : BLOCK, true);
    }
    for (const v of Object.values(by)) instance(this.scene, v.t, v.m);
  }
  // ---------------------------------------------------------------- poles & wires
  poles() {
    const T = this.templatesFrom('wires', { pole: /^(utility_)?pole|utility/i, trolley: /trolley|tram/i, concertina: /concertina|razor/i, fence: /barb|fence/i });
    const conc = new THREE.MeshStandardMaterial({ color: 0x99958b, roughness: 0.9 });
    let pole = T.pole?.[0];
    if (!pole) { pole = new THREE.Group(); const p = new THREE.Mesh(new THREE.BoxGeometry(0.22, 9.5, 0.22), conc); p.position.y = 4.75; pole.add(p); const a = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.1), conc); a.position.y = 9; pole.add(a); pole.traverse(o => o.isMesh && (o.castShadow = true)); }
    const trolley = T.trolley?.[0] || pole;
    // attachment points: empties named attach*/wire* in the template, else top of pole
    const attachOf = t => { const pts = []; t.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(t.matrixWorld).invert(); t.traverse(o => { if (!o.isMesh && /attach|wire|insul/i.test(o.name)) pts.push(o.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv)); }); if (!pts.length) { const b = new THREE.Box3().setFromObject(t); pts.push(new THREE.Vector3(0.7, b.max.y - 0.5, 0), new THREE.Vector3(-0.7, b.max.y - 0.5, 0)); } return pts; };
    const lines = [];
    const run = (tpl, x0, z0, x1, z1, step, rotY, sag) => {
      const n = Math.floor(Math.hypot(x1 - x0, z1 - z0) / step), mats = [], att = attachOf(tpl), tops = [];
      for (let i = 0; i <= n; i++) {
        const x = x0 + (x1 - x0) * i / n, z = z0 + (z1 - z0) * i / n;
        if (onRoad(x, z, -0.5)) { tops.push(null); continue; }
        const broken = this.rng() < 0.12, tilt = broken ? (this.rng() - .5) * 0.5 : (this.rng() - .5) * 0.04;
        const M = trs(x, 0, z, rotY, 1, tilt, (this.rng() - .5) * 0.05); mats.push(M);
        this.nav.circle(x, z, 0.4, BLOCK);
        tops.push(broken ? null : att.map(a => a.clone().applyMatrix4(M)));
      }
      for (let i = 0; i < tops.length - 1; i++) {
        const a = tops[i], b = tops[i + 1];
        for (let k = 0; k < (a ? a.length : 0); k++) {
          if (!a || this.rng() < 0.08) continue;
          if (b && b[k]) lines.push(catenary(a[k], b[k], sag + this.rng() * 0.5));
          else { const end = a[k].clone().add(new THREE.Vector3((x1 - x0) / n * 0.4, 0, (z1 - z0) / n * 0.4)); end.y = 0.05; lines.push(catenary(a[k], end, 0.8)); } // snapped wire hanging to the ground
        }
      }
      instance(this.scene, tpl, mats);
    };
    run(trolley, -E + 5, -13.5, E - 5, -13.5, 32, 0, 0.6); run(trolley, -E + 5, 13.5, E - 5, 13.5, 32, Math.PI, 0.6);
    run(pole, 95.5, -E + 5, 95.5, E - 5, 36, -Math.PI / 2, 1.3);
    run(pole, -200, -119.5, -20, -119.5, 36, 0, 1.3); run(pole, -200, 113.5, -20, 113.5, 36, Math.PI, 1.3);
    run(pole, 92, -115.5, 198, -115.5, 36, 0, 1.3); run(pole, 92, 113.5, 198, 113.5, 36, Math.PI, 1.3);
    run(pole, -E + 5, -190, E - 5, -190, 36, 0, 1.5); run(pole, -E + 5, 190, E - 5, 190, 36, Math.PI, 1.5);
    // trolleybus contact wires spanning the avenue between the two pole rows
    for (let x = -E + 18; x < E - 5; x += 32) { if (this.rng() < 0.25) continue; lines.push(catenary(new THREE.Vector3(x, 6.6, -13.2), new THREE.Vector3(x, 6.6, 13.2), 0.35)); }
    for (const z of [-2.1, 2.1]) for (let x = -E + 18; x < E - 37; x += 32) { if (this.rng() < 0.3) continue; lines.push(catenary(new THREE.Vector3(x, 6.4, z), new THREE.Vector3(x + 32, 6.4, z), 0.25)); }
    const wireMat = new THREE.MeshStandardMaterial({ color: 0x1c1b19, roughness: 0.6, metalness: 0.4 });
    const tubes = lines.map(pts => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.012, 3));
    const merged = mergeGeometries(tubes); const wires = new THREE.Mesh(merged, wireMat); wires.castShadow = false; this.scene.add(wires);
    this.wireT = T;
  }
  // ---------------------------------------------------------------- props
  props() {
    const T = this.templatesFrom('props', { car: /car|sedan|vaz|lada|zhiguli/i, bus: /bus(?!_?stop)|paz|minibus/i, hedgehog: /hedgehog/i, sandbag: /sandbag/i, tyre: /tyre|tire/i, garage: /garage/i, busstop: /bus_?stop|shelter/i, playground: /playground|climb/i, kiosk: /kiosk/i, crater: /crater/i });
    this.propT = T;
    const steel = new THREE.MeshStandardMaterial({ color: 0x4a3a30, roughness: 0.95, metalness: 0.2 });
    if (!T.car) { const c = new THREE.Group(); const b = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.8, 4.1), steel); b.position.y = 0.65; c.add(b); const t = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.55, 2.0), steel); t.position.set(0, 1.3, -0.2); c.add(t); c.traverse(o => o.isMesh && (o.castShadow = true)); T.car = [c]; }
    if (!T.hedgehog) { const h = new THREE.Group(); for (let i = 0; i < 3; i++) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 2.0), new THREE.MeshStandardMaterial({ color: 0x3a2e25, metalness: 0.5, roughness: 0.7 })); r.position.y = 0.6; r.rotation.set(i === 0 ? 0.9 : 0, i === 1 ? 1.1 : 0, i === 2 ? 0.9 : 0); if (i === 2) r.rotation.y = -1.1; h.add(r); } h.traverse(o => o.isMesh && (o.castShadow = true)); T.hedgehog = [h]; }
    const placeList = {};
    const put = (type, x, z, ry, s = 1, navR = 1.5, cost = 6) => {
      const list = T[type]; if (!list) return;
      const k = Math.floor(this.rng() * list.length); (placeList[type + k] ||= { t: list[k], m: [] }).m.push(trs(x, 0, z, ry, s));
      if (navR) { const bb = list[k].userData.bb ||= new THREE.Box3().setFromObject(list[k]); const sx = (bb.max.x - bb.min.x) / 2 * s, sz = (bb.max.z - bb.min.z) / 2 * s; this.nav.rect(x, z, sx, sz, ry, cost, 0.2); for (let a = 0; a < 1; a++) { const idx = this.nav.idx(x, z); if (idx >= 0) this.nav.low[idx] = 1; } }
    };
    // a handful of shot-up wrecks on the arterials (not a scrapyard on every kerb)
    const arterials = ROADS.filter(r => r.type !== 'drive');
    for (let i = 0; i < 9; i++) {
      const r = arterials[Math.floor(this.rng() * arterials.length)], horiz = (r.x1 - r.x0) > (r.z1 - r.z0);
      const t = this.rng(); const side = this.rng() < 0.5;
      const x = horiz ? r.x0 + t * (r.x1 - r.x0) : (side ? r.x0 + 1.4 : r.x1 - 1.4);
      const z = horiz ? (side ? r.z0 + 1.4 : r.z1 - 1.4) : r.z0 + t * (r.z1 - r.z0);
      if (Math.abs(x) > BOUNDS || Math.abs(z) > BOUNDS) continue;
      put('car', x, z, (horiz ? Math.PI / 2 : 0) + (this.rng() - .5) * 0.5 + (this.rng() < .5 ? Math.PI : 0), 1, 1, BLOCK);
    }
    const free = (x, z, r) => !onRoad(x, z, r) && Math.abs(x) < BOUNDS - r && Math.abs(z) < BOUNDS - r && !this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + r && Math.abs(lz) < b.D / 2 + r; }) && [0, 1, 2, 3, 4, 5, 6, 7].every(a => { const i = this.nav.idx(x + Math.cos(a * 0.785) * r, z + Math.sin(a * 0.785) * r); return i >= 0 && this.nav.cost[i] < 5; });
    // courtyard = the entrance side of a block, ~14 m out
    const yards = [];
    for (const b of this.buildings) { if (b.kind === 'school' || b.kind === 'shop' || b.kind === 'tower') continue; for (const f of [-0.25, 0.25]) { const p = b.toWorld(f * b.L, 0, -b.D / 2 - 15); yards.push([p.x, p.z, b.rot]); } }
    const takeYard = (r) => { for (let i = 0; i < 40 && yards.length; i++) { const j = Math.floor(this.rng() * yards.length), [x, z, rot] = yards[j]; yards.splice(j, 1); if (free(x, z, r)) return [x, z, rot]; } return null; };
    if (!this.assets.gltf.modern) put('bus', 72, 3, 0.25, 1, 1, BLOCK);
    const modern = !!this.assets.gltf.modern;
    if (!modern && free(100, -16.5, 1)) put('busstop', 100, -16.5, Math.PI, 1, 1, BLOCK);
    // courtyard plan: playgrounds between the five-storey rows, garage cooperatives and dirt yards at the edges
    this.dirtYards = [];
    for (const [x, z, rot] of MAP.yards?.playgrounds || []) { if (free(x, z, 4)) { if (!modern) put('playground', x, z, rot, 1, 1, 6); this.dirtYards.push([x, z, 11, rot]); } }
    for (const [x, z, rot] of MAP.yards?.garages || []) { const dx = Math.cos(rot) * 3.6, dz = -Math.sin(rot) * 3.6; for (let i = 0; i < 6; i++) put('garage', x + dx * (i - 2.5), z + dz * (i - 2.5), rot, 1, 1, BLOCK); this.dirtYards.push([x, z, 14, rot]); }
    if (!modern) for (let i = 0; i < 45; i++) { const x = (this.rng() - .5) * (MAP_SIZE - 60), z = (this.rng() - .5) * (MAP_SIZE - 60); const idx = this.nav.idx(x, z); if (idx >= 0 && this.nav.cost[idx] < 5) put('tyre', x, z, this.rng() * 6, 1, 0); }
    for (const v of Object.values(placeList)) instance(this.scene, v.t, v.m);
    this.put = put; this._pl = placeList;
  }
  // ---------------------------------------------------------------- city dressing (city.glb)
  dressing() {
    const T = this.templatesFrom('city', { house: /^house_/i, fenceH: /^fence_house/i, po2: /^fence_po2/i, pipe: /^pipe_straight/i, pipeLoop: /^pipe_loop/i, sub: /^substation/i, church: /^church/i, pav: /^pavilion/i, bill: /^billboard/i, bench: /^bench/i, bin: /^bin/i, lamp: /^lamp/i, car: /^car_parked/i, road: /^sign_road/i, goal: /^goal/i, laundry: /^laundry/i });
    // procedural stand-in for private houses if city.glb isn't there yet
    if (!T.house) {
      const wall = new THREE.MeshStandardMaterial({ color: 0xbfb6a3, roughness: 0.95 }), roof = new THREE.MeshStandardMaterial({ color: 0x5f6a63, roughness: 0.6, metalness: 0.4 }), dark = new THREE.MeshStandardMaterial({ color: 0x1a1a19 });
      T.house = [0, 1, 2].map(k => { const g = new THREE.Group(), w = 7 + k, d = 6 + (k % 2) * 2, h = 2.9;
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wall); body.position.y = h / 2; g.add(body);
        const sh = new THREE.Shape(); sh.moveTo(-d / 2 - 0.4, 0); sh.lineTo(d / 2 + 0.4, 0); sh.lineTo(0, 2.1); sh.closePath();
        const rg = new THREE.ExtrudeGeometry(sh, { depth: w + 0.8, bevelEnabled: false }); rg.rotateY(Math.PI / 2); rg.translate(-(w + 0.8) / 2, h, 0);
        const r = new THREE.Mesh(rg, roof); g.add(r);
        for (let i = 0; i < 3; i++) { const win = new THREE.Mesh(new THREE.BoxGeometry(1, 1.2, 0.08), dark); win.position.set(-w / 3 + i * w / 3, 1.6, d / 2 + 0.02); g.add(win); }
        g.traverse(o => o.isMesh && (o.castShadow = o.receiveShadow = true)); return g; });
    }
    const place = {}, R = this.rng;
    const put = (type, x, z, ry, cost = BLOCK, s = 1) => {
      const list = T[type]; if (!list) return false;
      const k = Math.floor(R() * list.length), t = list[k];
      const bb = t.userData.bb ||= new THREE.Box3().setFromObject(t); const hx = (bb.max.x - bb.min.x) / 2 * s, hz = (bb.max.z - bb.min.z) / 2 * s;
      // refuse placements on roads or overlapping blocked cells
      if (onRoad(x, z, Math.max(hx, hz) * 0.6)) return false;
      const ci = this.nav.idx(x, z); if (ci < 0 || this.nav.cost[ci] === BLOCK) return false;
      if (this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + hx + 1 && Math.abs(lz) < b.D / 2 + hz + 1; })) return false;
      const M = trs(x, 0, z, ry, s);
      const crush = type === 'fenceH' || type === 'bench' || type === 'bin' ? 'any' : type === 'po2' ? 'tank' : null;
      if (crush) { (this.crushables ||= []).push({ t, M, x, z, ry, hx, hz, crush, type }); if (cost) this.nav.rect(x, z, hx, hz, ry, crush === 'any' ? Math.min(cost, 3) : cost, 0.15); return true; }
      (place[type + k] ||= { t, m: [] }).m.push(M);
      if (cost) this.nav.rect(x, z, hx, hz, ry, cost, 0.15);
      return true;
    };
    // private-house sectors (приватний сектор) at the four outer corners, lanes left clear for deployment
    for (const [x0, x1, z0, z1] of [[-252, -150, 206, 252], [150, 252, 206, 252], [-252, -150, -252, -206], [150, 252, -252, -206]]) {
      for (let x = x0 + 10; x < x1 - 6; x += 21) for (let z = z0 + 10; z < z1 - 6; z += 23) {
        if (R() < 0.15) continue;
        const ry = (R() < 0.5 ? 0 : Math.PI) + (R() - .5) * 0.15, hx = x + (R() - .5) * 4, hz = z + (R() - .5) * 4;
        if (!put('house', hx, hz, ry)) continue;
        if (T.fenceH) for (const [fx, fz, fr] of [[hx, hz + 9, 0], [hx - 9.5, hz, Math.PI / 2], [hx + 9.5, hz, Math.PI / 2]]) if (R() < 0.75) put('fenceH', fx, fz, fr + (R() - .5) * 0.06, 5);
        if (R() < 0.3) this.addCrater(hx + (R() - .5) * 12, hz + (R() - .5) * 12, 2 + R() * 3);
      }
    }
    // transformer substations (ТП): one per pair of residential blocks, on the courtyard side at the block end
    // next to the access driveway, squared to the block — as in a planned Soviet microdistrict
    let subN = 0;
    this.buildings.forEach((b, i) => {
      if (!/khrushchyovka|brick|nine/.test(b.kind) || i % 2) return;
      for (const sx of [1, -1]) { const p = b.toWorld(sx * (b.L / 2 + 4.5), 0, -(b.D / 2 + 5)); if (put('sub', p.x, p.z, b.rot + (sx > 0 ? 0 : Math.PI))) { subN++; break; } }
    });
    put('church', -107, 152, 0);
    // market: intact closed pavilions in a neat row (no half-collapsed burnt ones)
    if (T.pav) { const ok = T.pav.filter(t => /closed/i.test(t.name)); if (ok.length) T.pav = ok; }
    for (const [x, z, r] of MAP.yards?.markets || []) put('pav', x, z, r);
    // concrete ПО-2 fences around the school yard and garage rows
    if (T.po2) { for (let x = -86; x < -32; x += 4.0) put('po2', x, 86, 0, 7); }
    for (const [x, z] of [[-60, 78], [-36, 78]]) put('goal', x, z, Math.PI / 2, 6);
    // street furniture
    if (!this.assets.gltf.modern) for (let x = -E + 20; x < E - 20; x += 30) { put('lamp', x + 15, -16.6, 0, 0); put('lamp', x, 16.6, Math.PI, 0); }
    for (const b of this.buildings) for (const e of b.entrances) { if (this.assets.gltf.modern) { if (R() < 0.5) put('bench', e.x + 2.2, e.z, b.rot, 0); continue; } if (R() < 0.6) put('bench', e.x + (R() - .5) * 3, e.z + (R() - .5) * 2, b.rot, 0); if (R() < 0.35) put('bin', e.x + 4 * (R() < .5 ? 1 : -1), e.z, b.rot, 6); if (R() < 0.15) put('laundry', e.x + (R() - .5) * 10, e.z - 8, R() * 3, 0); }
    for (const v of Object.values(place)) instance(this.scene, v.t, v.m);
    this.buildCrushables();
  }
  // 2020s layer on the Soviet plan (modern.glb): renovated retail, boiler houses, garage cooperatives, new playgrounds
  // and street gym, LED lamps, parking bays of modern cars along the driveways, euro-bin pads, checkpoints and
  // anti-drone nets over the arterial approaches, a burnt-out city bus.
  modernDressing() {
    const g = this.assets.gltf.modern; if (!g) return;
    const R = this.rng, place = {};
    const tpl = n => { const o = g.scene.getObjectByName(n); if (o && !o.userData.bb) o.userData.bb = new THREE.Box3().setFromObject(o); return o; };
    const mput = (n, x, z, ry, { cost = BLOCK, road = true, occ = false } = {}) => {
      const t = tpl(n); if (!t) return false; const bb = t.userData.bb, hx = (bb.max.x - bb.min.x) / 2, hz = (bb.max.z - bb.min.z) / 2;
      if (road && onRoad(x, z, Math.min(hx, hz) * 0.8)) return false;
      if (this.buildings.some(b => { const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + Math.max(hx, hz) * 0.7 && Math.abs(lz) < b.D / 2 + Math.max(hx, hz) * 0.7; })) return false;
      (place[n] ||= { t, m: [] }).m.push(trs(x, 0, z, ry));
      if (cost) this.nav.rect(x, z, hx, hz, ry, cost, 0.15);
      if (occ) this.nav.addOccluder(x, z, hx * 0.95, hz * 0.95, ry, (bb.max.y - bb.min.y) * 0.8, null);
      return true;
    };
    // retail and services at the market crossroads
    // neighbourhood supermarket set back from the avenue behind its own car park (as ATB/Silpo boxes are)
    if (mput('supermarket_damaged', 117, -62, 0, { occ: true })) this.parkingLot(97, -44, 137, -17, mput);
    mput('pharmacy_kiosk', 104, 34, Math.PI); mput('kiosk_modern_burnt', 62, -18, 0, { road: false }); mput('bus_burnt_modern', 64, 4, 0.12, { road: false });
    for (const [x, z, r] of [[100, -15.8, Math.PI], [-60, 15.8, 0], [-150, -15.8, Math.PI], [160, 15.8, 0]]) mput('bus_stop_modern', x, z, r, { road: false, cost: 6 });
    // boiler houses and garage cooperatives at the microdistrict edges
    for (const [x, z, r] of this.mapYards('boilers')) mput(R() < 0.5 ? 'boiler_house_damaged' : 'boiler_house', x, z, r, { occ: true });
    for (const [x, z, r] of this.mapYards('garages')) mput('garage_row', x, z + (r ? -9 : 9), r);
    // new playgrounds + street-workout corners in the courtyards
    for (const [x, z, r] of this.mapYards('playgrounds')) { mput('playground_modern', x + 6, z, r, { cost: 6 }); mput('outdoor_gym', x - 9, z, r, { cost: 6 }); }
    // LED lamps along the arterials, ad columns at the crossroads
    for (let t = -E + 20; t < E - 20; t += 28) { mput('lamp_led', t, -16.2, 0, { road: false, cost: 0 }); mput('lamp_led', t + 14, 16.2, Math.PI, { road: false, cost: 0 }); }
    for (let t = -E + 20; t < E - 20; t += 32) { mput('lamp_led', 74.6, t, Math.PI / 2, { road: false, cost: 0 }); }
    mput('ad_column', 72, -17, 0, { road: false, cost: 5 }); mput('ad_column', 98, 18, 0, { road: false, cost: 5 });
    // parking bays along the courtyard driveways: hatchbacks, crossovers, vans; a few burnt out
    const cars = ['car_hatch_modern', 'car_suv_modern', 'car_hatch_modern', 'car_van'];
    for (const r of ROADS) {
      if (r.type !== 'drive') continue;
      const horiz = (r.x1 - r.x0) > (r.z1 - r.z0), side = R() < 0.5 ? -1 : 1, off = (horiz ? (r.z1 - r.z0) : (r.x1 - r.x0)) / 2 + 2.4;
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, a0 = horiz ? r.x0 : r.z0, a1 = horiz ? r.x1 : r.z1;
      for (let t = a0 + 14; t < a1 - 14; t += 2.9) {
        if (R() > 0.55) { t += 6; continue; }
        const burnt = R() < 0.22, n = cars[Math.floor(R() * cars.length)] + (burnt ? '_burnt' : '');
        const x = horiz ? t : cx + side * off, z = horiz ? cz + side * off : t;
        mput(n, x, z, (horiz ? Math.PI / 2 : 0) + (R() - .5) * 0.12 + (R() < 0.5 ? Math.PI : 0), { road: false });
      }
    }
    // euro-bin pads by the block entrances (one per block)
    for (const b of this.buildings) { const e = b.entrances[Math.floor(R() * b.entrances.length)]; if (!e || b.kind === 'tower' && R() < 0.5) continue; const o = b.toWorld(0, 0, 0); const dx = e.x - o.x, dz = e.z - o.z, d = Math.hypot(dx, dz) || 1; mput('waste_pad', e.x + dx / d * 7 + (R() - .5) * 6, e.z + dz / d * 7, b.rot, { cost: 6 }); }
    // wartime: checkpoints on the arterial entries, anti-drone netting over the approaches to the crossroads
    for (const [x, z, r] of [[85, -182, 0], [85, 182, 0], [-190, 0, Math.PI / 2], [190, 0, Math.PI / 2]]) mput('checkpoint_blocks', x + (r ? 0 : 3.5), z, r, { road: false, cost: 7 });
    // sandbagged ground-floor windows on the school, kindergartens and the avenue frontage
    const swin = tpl('window_sandbags');
    if (swin) for (const b of this.buildings) {
      if (!(b.kind === 'school' || (b.shops && Math.abs(b.z) < 30))) continue;
      for (const p of b.panels) {
        if (p.floor !== 0 || p.gone || p.entrance || p.shop || /blank/.test(p.type) || R() > 0.55) continue;
        const c = b.panelCenter(p), o = b.outward(p);
        (place.window_sandbags ||= { t: swin, m: [] }).m.push(trs(c.x + o.x * 0.37, 0, c.z + o.z * 0.37, b.rot + p.rot));
        const i = this.nav.idx(c.x + o.x * 0.8, c.z + o.z * 0.8); if (i >= 0) { this.nav.cost[i] = Math.max(this.nav.cost[i], 6); this.nav.low[i] = 1; }
      }
    }
    for (const v of Object.values(place)) instance(this.scene, v.t, v.m);
  }
  mapYards(k) { return MAP.yards?.[k] || []; }
  // asphalt car park with painted bays, a few cars (some burnt), lamps and a barrier at the entry
  parkingLot(x0, z0, x1, z1, mput) {
    const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 7, uv.getY(i) * d / 7);
    const asphalt = this.mat('asphalt', 1, { color: 0xbdb9b0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const lot = new THREE.Mesh(g, asphalt); lot.position.set(cx, 0.045, cz); lot.receiveShadow = true; this.scene.add(lot);
    const line = new THREE.PlaneGeometry(0.12, 5); line.rotateX(-Math.PI / 2);
    const lm = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.9, transparent: true, opacity: 0.6, polygonOffset: true, polygonOffsetFactor: -3 });
    const mats = [], R = this.rng, cars = ['car_hatch_modern', 'car_suv_modern', 'car_hatch_modern'];
    for (const row of [z0 + 3, z1 - 3]) for (let x = x0 + 2; x <= x1 - 2; x += 2.7) {
      mats.push(trs(x, 0.055, row, 0));
      if (x < x1 - 4 && R() < 0.4) mput(cars[Math.floor(R() * cars.length)] + (R() < 0.3 ? '_burnt' : ''), x + 1.35, row, Math.PI / 2 + (R() - .5) * 0.1 + (row < cz ? 0 : Math.PI), { road: false });
    }
    instance(this.scene, new THREE.Mesh(line, lm), mats, { shadows: false });
    mput('lamp_led', x0 + 1, cz, 0, { road: false, cost: 0 }); mput('lamp_led', x1 - 1, cz, Math.PI, { road: false, cost: 0 });
    mput('parking_barrier', x0 + 3, z1 - 0.5, 0, { road: false, cost: 0 });
    this.nav.markRoad(x0, z0, x1, z1, 2);
  }
  // Crushable street furniture: own InstancedMeshes (index per item kept) + a spatial grid
  buildCrushables() {
    const items = this.crushables || []; this.crushGrid = new Map();
    const byTpl = new Map(); for (const it of items) (byTpl.get(it.t) || byTpl.set(it.t, []).get(it.t)).push(it);
    for (const [t, list] of byTpl) {
      t.updateMatrixWorld(true); const inv = new THREE.Matrix4().copy(t.matrixWorld).invert();
      const meshes = [];
      t.traverse(o => { if (!o.isMesh) return; const rel = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld); const im = new THREE.InstancedMesh(o.geometry, o.material, list.length); im.castShadow = im.receiveShadow = true; meshes.push({ im, rel }); this.scene.add(im); });
      list.forEach((it, i) => { it.i = i; it.meshes = meshes; this.setCrushMatrix(it, it.M); });
      for (const { im } of meshes) im.computeBoundingSphere();
    }
    for (const it of items) { const k = Math.floor(it.x / 10) + ',' + Math.floor(it.z / 10); (this.crushGrid.get(k) || this.crushGrid.set(k, []).get(k)).push(it); }
  }
  setCrushMatrix(it, M) { const m = new THREE.Matrix4(); for (const { im, rel } of it.meshes) { im.setMatrixAt(it.i, m.multiplyMatrices(M, rel)); im.instanceMatrix.needsUpdate = true; } }
  // vehicles flatten wooden / thin-metal fences, benches and bins; tanks also topple concrete panels
  crushCheck(v, game) {
    if (!this.crushGrid) return;
    const cx = Math.floor(v.pos.x / 10), cz = Math.floor(v.pos.z / 10);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const list = this.crushGrid.get((cx + i) + ',' + (cz + j)); if (!list) continue;
      for (const it of list) {
        if (it.crushed || (it.crush === 'tank' && v.kind !== 'tank')) continue;
        const dx = v.pos.x - it.x, dz = v.pos.z - it.z, c = Math.cos(it.ry), s = Math.sin(it.ry);
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) > it.hx + v.def.width * 0.45 || Math.abs(lz) > it.hz + v.def.length * 0.45) continue;
        it.crushed = true;
        const side = lz > 0 ? -1 : 1; // falls away from the vehicle
        const fall = new THREE.Matrix4().multiplyMatrices(it.M, new THREE.Matrix4().makeRotationX(side * (1.35 + Math.random() * 0.2)));
        fall.multiply(new THREE.Matrix4().makeScale(1, it.type === 'po2' ? 1 : 0.85, it.type === 'po2' ? 1 : 0.5));
        this.setCrushMatrix(it, fall);
        this.nav.setRect(it.x, it.z, it.hx, it.hz + 0.2, it.ry, 1, 0);
        if (game) { game.fx.dustCloud(new THREE.Vector3(it.x, 0.3, it.z), Math.max(2, it.hx), 1, 5, [0.6, 0.56, 0.5]); game.sfx(it.type === 'po2' ? 'debris' : Math.random() < 0.5 ? 'impact_metal' : 'debris', new THREE.Vector3(it.x, 0.5, it.z), { gain: 0.8 }); }
      }
    }
  }
  // field fortifications at the objectives (facing north)
  defences() {
    const T = this.propT, placeList = {};
    const put = (type, x, z, ry) => {
      const list = T[type]; if (!list) return; const k = Math.floor(this.rng() * list.length);
      (placeList[type + k] ||= { t: list[k], m: [] }).m.push(trs(x, 0, z, ry, 1));
      const bb = list[k].userData.bb ||= new THREE.Box3().setFromObject(list[k]);
      const sx = (bb.max.x - bb.min.x) / 2, sz = (bb.max.z - bb.min.z) / 2;
      this.nav.rect(x, z, sx, sz, ry, type === 'hedgehog' ? BLOCK : 7, 0.1);
    };
    if (!T.sandbag) { const sb = new THREE.Group(); const m = new THREE.MeshStandardMaterial({ color: 0x7c7058, roughness: 1 }); for (let r = 0; r < 3; r++) for (let i = 0; i < 5; i++) { const b = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.4, 3, 8), m); b.rotation.z = Math.PI / 2; b.scale.set(1, 1, 0.75); b.position.set(-1.2 + i * 0.6 + (r % 2) * 0.3, 0.15 + r * 0.26, 0); sb.add(b); } sb.traverse(o => o.isMesh && (o.castShadow = true)); T.sandbag = [sb]; }
    // School: sandbagged positions along the avenue side and the gap between wings
    // Crossroads: barricade of hedgehogs across the intersection mouths + sandbag nests at corners
    for (let x = 80; x <= 90; x += 2.6) put('hedgehog', x, -14, this.rng() * 3);
    for (let z = -6; z <= 6; z += 2.6) put('hedgehog', 70, z, this.rng() * 3);
    for (const v of Object.values(placeList)) instance(this.scene, v.t, v.m);
    // concertina wire belts in front of both objectives
    const C = this.wireT?.concertina?.[0];
    const coil = C || (() => { const pts = []; for (let i = 0; i < 240; i++) { const a = i * 0.45; pts.push(new THREE.Vector3(Math.cos(a) * 0.45, 0.45 + Math.sin(a) * 0.45, i / 240 * 5 - 2.5)); } const g = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 480, 0.008, 3), new THREE.MeshStandardMaterial({ color: 0x6d6a64, metalness: 0.8, roughness: 0.4 })); const grp = new THREE.Group(); g.rotation.y = Math.PI / 2; grp.add(g); return grp; })();
    const bb = new THREE.Box3().setFromObject(coil); const len = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z); const alongX = (bb.max.x - bb.min.x) >= (bb.max.z - bb.min.z);
    const m = [];
    const belt = (x0, z0, x1, z1) => { const d = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(d / len), ang = Math.atan2(x1 - x0, z1 - z0) + (alongX ? -Math.PI / 2 : 0); for (let i = 0; i < n; i++) { const f = (i + 0.5) / n; const x = x0 + (x1 - x0) * f, z = z0 + (z1 - z0) * f; m.push(trs(x, 0, z, ang)); this.nav.circle(x, z, 0.9, 5); } };
    // (no concertina wire in the district)
  }
  craters() {
    const T = this.propT?.crater;
    const mat = new THREE.MeshStandardMaterial({ color: 0x2c2722, roughness: 1, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
    const tex = craterTexture(); mat.map = tex; mat.color.set(0xffffff);
    const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
    this.craterCap = MAP.kind === 'rural' ? 1400 : 400; this.craterMesh = new THREE.InstancedMesh(g, mat, this.craterCap); this.craterMesh.count = 0; this.craterMesh.receiveShadow = true; this.craterMesh.frustumCulled = false; this.scene.add(this.craterMesh);
    for (const c of this.pendingCraters || []) this.addCrater(...c); this.pendingCraters = null;
    for (let i = 0; i < 120; i++) { const x = (this.rng() - .5) * (MAP_SIZE - 40), z = (this.rng() - .5) * (MAP_SIZE - 40); this.addCrater(x, z, 2 + this.rng() * 4); }
    if (T) { const m = []; for (let i = 0; i < 18; i++) { const x = (this.rng() - .5) * (MAP_SIZE - 60), z = (this.rng() - .5) * (MAP_SIZE - 60); const idx = this.nav.idx(x, z); if (idx >= 0 && this.nav.cost[idx] < 5 && !onRoad(x, z, 4)) m.push(trs(x, 0, z, this.rng() * 6)); } instance(this.scene, T[0], m); }
  }
  addCrater(x, z, size) {
    if (!this.craterMesh) { (this.pendingCraters ||= []).push([x, z, size]); return; }
    const c = this.craterMesh; if (c.count >= this.craterCap) return;
    c.setMatrixAt(c.count++, trs(x, 0.07 + c.count * 0.0004, z, Math.random() * 6.28, size)); c.instanceMatrix.needsUpdate = true;
  }
  // distant city silhouette beyond the playable area
  // The city carries on past the playable area: more microdistricts as cheap facade-shaded blocks (panel joints,
  // window grid, balcony bands, flat roofs; a few burnt-out windows), the arterials continue, tree belts in between.
  skyline() {
    const half = MAP_SIZE / 2, R = this.rng, mats = [], cols = [], boxes = [];
    const clearOf = (x, z, hx, hz) => Math.abs(z) > hz + 22 && Math.abs(x - 85) > hx + 18 && Math.abs(x + 204) > hx + 14 && Math.abs(x - 202) > hx + 14 && Math.abs(z - 197) > hz + 12 && Math.abs(z + 197) > hz + 12;
    for (let gx = -760; gx < 760; gx += 120) for (let gz = -760; gz < 760; gz += 120) {
      const cx = gx + 60, cz = gz + 60;
      if (Math.max(Math.abs(cx), Math.abs(cz)) < half + 50) continue;
      const rows = 2 + Math.floor(R() * 2), along = R() < 0.5;
      for (let i = 0; i < rows; i++) {
        const tall = R() < 0.35, tower = R() < 0.12;
        const L = tower ? 19 : 38 + Math.floor(R() * 4) * 9.6, D = tower ? 19 : 12.8, H = tower ? 2.8 * (12 + Math.floor(R() * 5)) : 2.8 * (tall ? 9 : 5) + 0.6;
        const off = (i - (rows - 1) / 2) * 38 + (R() - .5) * 6;
        const x = cx + (along ? (R() - .5) * 20 : off), z = cz + (along ? off : (R() - .5) * 20);
        const [hx, hz] = along ? [L / 2, D / 2] : [D / 2, L / 2];
        if (Math.max(Math.abs(x) - hx, Math.abs(z) - hz) < half + 12 || !clearOf(x, z, hx, hz)) continue;
        mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), along ? 0 : Math.PI / 2), new THREE.Vector3(L, H, D)));
        cols.push(new THREE.Color().setHSL(0.09 + R() * 0.05, 0.06 + R() * 0.12, 0.5 + R() * 0.14));
        boxes.push([x, z, hx, hz]);
      }
    }
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
    m.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFP; varying vec3 vFN;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n#ifdef USE_INSTANCING\n vec3 isc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));\n vFP = position * isc; vFN = normal;\n#endif');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vFP; varying vec3 vFN;
        float fh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec3 an = abs(vFN);
          if (an.y > 0.5) { diffuseColor.rgb *= 0.32; }
          else {
            float u = an.x > 0.5 ? vFP.z : vFP.x, v = vFP.y;
            vec2 cell = vec2(floor(u / 3.2), floor(v / 2.8)); vec2 f = vec2(fract(u / 3.2), fract(v / 2.8));
            float joint = 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.025, f.x) * smoothstep(1.0, 0.975, f.x) * smoothstep(0.0, 0.03, f.y) * smoothstep(1.0, 0.97, f.y));
            float win = step(0.26, f.x) * step(f.x, 0.74) * step(0.31, f.y) * step(f.y, 0.82);
            float band = step(0.82, f.y) * step(mod(cell.y, 1.0), 0.5) * step(0.5, fh(vec2(floor(vFP.x * 0.01 + vFP.z * 0.013), 3.0)));
            float burnt = step(0.965, fh(cell + floor(vFP.xz * 0.02)));
            vec3 c = diffuseColor.rgb * joint;
            c = mix(c, vec3(0.42, 0.5, 0.56) * diffuseColor.rgb, band * 0.6);
            c = mix(c, mix(vec3(0.07, 0.075, 0.08), vec3(0.16, 0.17, 0.19), fh(cell * 1.7)), win);
            c = mix(c, vec3(0.03, 0.028, 0.025), burnt * smoothstep(0.1, 0.5, 1.0 - abs(f.x - 0.5) * 1.6));
            diffuseColor.rgb = c * (v < 0.6 ? 0.8 : 1.0);
          }`);
    };
    const im = new THREE.InstancedMesh(box, m, mats.length); mats.forEach((M, i) => { im.setMatrixAt(i, M); im.setColorAt(i, cols[i]); });
    im.castShadow = false; im.receiveShadow = true; this.scene.add(im);
    // arterials continue out of the district
    const asphalt = this.mat('asphalt', 1, { color: 0xd0ccc4, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const ext = (cx, cz, w, d) => { const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 7, uv.getY(i) * d / 7); const a = new THREE.Mesh(g, asphalt); a.position.set(cx, 0.05, cz); a.receiveShadow = true; this.scene.add(a); };
    for (const sgn of [-1, 1]) {
      ext(sgn * (half + 2 + 240), 0, 480, 20); ext(85, sgn * (half + 2 + 240), 14, 480);
      ext(-204, sgn * (half + 2 + 240), 8, 480); ext(202, sgn * (half + 2 + 240), 8, 480);
      ext(sgn * (half + 2 + 240), -197, 480, 8); ext(sgn * (half + 2 + 240), 197, 480, 8);
    }
    // tree belts between the outer blocks (cheap leafy lumps; fog does the rest)
    const tm = new THREE.MeshStandardMaterial({ color: 0x3c4527, roughness: 1, flatShading: true }), tg = new THREE.IcosahedronGeometry(1, 1); tg.translate(0, 0.85, 0);
    const tmats = [];
    for (let i = 0; i < 900; i++) {
      const x = (R() - .5) * 1500, z = (R() - .5) * 1500; if (Math.max(Math.abs(x), Math.abs(z)) < half + 15) continue;
      if (boxes.some(([bx, bz, hx, hz]) => Math.abs(x - bx) < hx + 4 && Math.abs(z - bz) < hz + 4) || Math.abs(z) < 16 || Math.abs(x - 85) < 12) continue;
      const s = 3 + R() * 2.5; tmats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(s, s * (1.1 + R() * 0.4), s)));
    }
    const ti = new THREE.InstancedMesh(tg, tm, tmats.length); tmats.forEach((M, i) => ti.setMatrixAt(i, M)); ti.castShadow = false; this.scene.add(ti);
  }
  // ---------------------------------------------------------------- section collapse
  rebuildOccluders(b) {
    for (const o of b.occ || []) o.dead = true;
    const { W } = this.assets.kit; b.occ = [];
    let a = null;
    for (let c = 0; c <= b.modules; c++) {
      const standing = c < b.modules && !b.goneCols.has(c) && !(b.pancaked && c >= b.pancaked[0] && c <= b.pancaked[1]);
      if (standing && a === null) a = c;
      if (!standing && a !== null) {
        const lx = -b.L / 2 + ((a + c) / 2) * W, hx = (c - a) * W / 2, ctr = b.toWorld(lx, 0, 0);
        b.occ.push(this.nav.addOccluder(ctr.x, ctr.z, hx, b.D / 2, b.rot, b.height, b)); a = null;
      }
    }
  }
  collapseSection(b, si, game) {
    if (b.collapsedSecs.has(si)) return; b.collapsedSecs.add(si);
    const { W, H } = this.assets.kit, [a, c] = b.secCols[si];
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    // panels drop and tumble, then vanish into the dust
    for (const p of b.panelsOfSection(si)) {
      const m = b.panelMatrix(p, new THREE.Matrix4());
      this.falling.push({ b, p, m, t: -p.floor * 0.12 - Math.random() * 0.25, v: 0, rx: (Math.random() - .5) * 0.6, rz: (Math.random() - .5) * 0.4, out: b.outward(p).multiplyScalar(0.6 + Math.random()) });
      if (p.acc && p.acc.slot >= 0) this.pool.remove(p.balcony ? (p.balPiece || 'balcony_slab') : 'entrance_canopy', p.acc);
    }
    for (let col = a; col <= c; col++) {
      b.goneCols.add(col);
      for (const [kind, i] of (b.intIdx?.[col] || [])) { const m = kind === 'slab' ? this.slabMesh : kind === 'dark' ? this.darkMesh : this.roofMesh; m.setMatrixAt(i, zero); m.instanceMatrix.needsUpdate = true; }
    }
    for (const o of b.parapets || []) if (o.slot >= 0 && o.col >= a && o.col <= c) this.pool.remove('roof_parapet', o);
    for (const sg of b.signs || []) if (sg.slot >= 0 && sg.p.col >= a && sg.p.col <= c) this.pool.remove(sg.name, sg);
    for (const mr of b.machines || []) if (mr.o.slot >= 0 && mr.a <= c && mr.b >= a) this.pool.remove('roof_machine_room', mr.o);
    // occupants of the section are caught in the collapse
    for (const sl of b.slots) if (sl.occupant && sl.panel.col >= a && sl.panel.col <= c && (sl.panel.side === 'front' || sl.panel.side === 'back' || sl.panel.side === (si === 0 ? 'left' : 'right'))) {
      const s = sl.occupant; sl.occupant = null; s.slotRef = null; s.inside = null; s.pos.y = 0;
      game.combat.hitSoldier(s, { dmg: [70, 220], type: 'blast' }, s.pos, true);
    }
    for (const sl of b.slots) if (sl.panel.col >= a && sl.panel.col <= c) sl.panel.gone = true;
    // footprint becomes a rubble mound (passable, low cover), LOS reopens
    const lx = -b.L / 2 + ((a + c + 1) / 2) * W, hx = (c - a + 1) * W / 2, ctr = b.toWorld(lx, 0, 0);
    this.nav.setRect(ctr.x, ctr.z, hx + 0.5, b.D / 2 + 0.5, b.rot, 6, 1);
    this.nav.finalize(); this.rebuildOccluders(b);
    const pile = this.assets.gltf.panel_kit?.scene.getObjectByName('collapse_pile_large') || null;
    const n = Math.max(1, Math.round(hx * 2 / 13));
    for (let i = 0; i < n; i++) {
      const p = b.toWorld(-b.L / 2 + (a + (i + 0.5) * (c - a + 1) / n) * W, 0, (Math.random() - .5) * 2);
      if (pile) { const m = pile.clone(); m.position.set(p.x, -4, p.z); m.rotation.y = b.rot + (Math.random() < .5 ? 0 : Math.PI); m.userData.rise = 4; m.scale.setScalar(Math.min(1.2, b.floors / 6 + 0.4)); this.dynamic.add(m); }
      else for (let k = 0; k < 3; k++) this.spawnRubble(p.x + (Math.random() - .5) * 8, p.z + (Math.random() - .5) * 8, 1.5 + Math.random());
    }
    this.cutFaces(b, a, c);
    // the event itself
    const top = b.toWorld(lx, b.floors * H * 0.5, 0);
    game.fx.collapseDust(top, hx * 2, b.D, b.floors * H);
    game.sfx('collapse', top); setTimeout(() => game.sfx('debris', top), 900);
    game.cam.addShake(Math.max(0, 1 - game.camDist(top) / 260));
    for (const sq of game.squads) if (!sq.destroyed && sq.center().distanceTo(top) < 60) { sq.addMorale(-10); sq.underFireT = 0; }
    game.hud?.alert(`A block section collapsed`, 'bad');
    b.collapsedAll = b.collapsedSecs.size === b.secCols.length;
  }
  // broken party walls on the faces exposed by a collapsed section (one merged mesh per collapse)
  cutFaces(b, a, c) {
    const { W, H } = this.assets.kit, kit = this.assets.kit.pieces, parts = new Map();
    const Y = new THREE.Vector3(0, 1, 0), m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const face = (xcut, sign) => {
      for (let f = 0; f < b.floors; f++) for (let j = 0; j < b.depthModules; j++) {
        // the cross wall left standing beside a collapsed section: intact-ish below, torn only at the top storey
        const r = Math.random(), name = f === b.floors - 1 ? 'wall_blank_end_destroyed' : r < 0.25 ? 'wall_blank_end_holed' : 'wall_blank_end_damaged';
        const piece = kit[name] || kit.wall_blank_end_holed; if (!piece) continue;
        const pz = sign > 0 ? b.D / 2 - j * W : -b.D / 2 + j * W;
        b.toWorld(xcut, f * H, pz, v); q.setFromAxisAngle(Y, b.rot + sign * Math.PI / 2); m.compose(v, q, one);
        for (const pt of piece) { const g = pt.geometry.clone().applyMatrix4(m); (parts.get(pt.material) || parts.set(pt.material, []).get(pt.material)).push(g); }
      }
    };
    if (a > 0 && !b.goneCols.has(a - 1)) face(-b.L / 2 + a * W, +1);
    if (c < b.modules - 1 && !b.goneCols.has(c + 1)) face(-b.L / 2 + (c + 1) * W, -1);
    for (const [mat, geos] of parts) { const g = mergeGeometries(geos.map(x => x.index ? x : x), false); if (!g) continue; const mesh = new THREE.Mesh(g, mat); mesh.castShadow = mesh.receiveShadow = true; this.dynamic.add(mesh); }
  }
  updateFalling(dt) {
    if (!this.falling.length) return;
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), e = new THREE.Euler();
    for (const f of this.falling) {
      f.t += dt; if (f.t < 0) continue;
      f.v += 9.8 * dt;
      f.m.decompose(pos, q, sc); pos.y -= f.v * dt; pos.addScaledVector(f.out, dt * 0.8);
      e.set(f.rx * dt, 0, f.rz * dt); q.multiply(new THREE.Quaternion().setFromEuler(e));
      f.m.compose(pos, q, sc); this.pool.setMatrix(f.p, f.m);
      if (pos.y < -3.5) { f.b.setGone(f.p); f.done = true; }
    }
    this.falling = this.falling.filter(f => !f.done);
  }
  // building lookup by world point (for damage)
  buildingAt(x, z, pad = 1.5) {
    for (const b of this.buildings) { const [lx, lz] = b.toLocal(x, z); if (Math.abs(lx) < b.L / 2 + pad && Math.abs(lz) < b.D / 2 + pad) return b; }
    return null;
  }
}

export function catenary(a, b, sag) {
  const pts = []; for (let i = 0; i <= 10; i++) { const t = i / 10; const p = a.clone().lerp(b, t); p.y -= sag * 4 * t * (1 - t); pts.push(p); } return pts;
}
function decalTexture(kind) {
  const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'); const r = Math.random;
  if (kind === 'soot') { // plume rising from a window head: dense at the bottom, feathering up
    for (let i = 0; i < 70; i++) { const px = 64 + (r() - .5) * 70 * (0.4 + i / 70), py = 128 - Math.pow(r(), 0.8) * 120, rr = 10 + r() * 22; const g = x.createRadialGradient(px, py, 0, px, py, rr); const a = 0.10 + 0.25 * (py / 128); g.addColorStop(0, `rgba(14,12,10,${a})`); g.addColorStop(1, 'rgba(14,12,10,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128); }
  } else if (kind === 'pocks') { // shrapnel/bullet pocks: dark core, pale chipped rim
    for (let i = 0; i < 60; i++) { const px = 64 + (r() - .5) * 116 * Math.sqrt(r()), py = 64 + (r() - .5) * 116 * Math.sqrt(r()), rr = 0.6 + Math.pow(r(), 2) * 2.6;
      x.fillStyle = `rgba(190,184,172,${0.18 + r() * 0.15})`; x.beginPath(); for (let k = 0; k <= 7; k++) { const a = k / 7 * 6.28, q = rr * (1.3 + r() * 0.6); k ? x.lineTo(px + Math.cos(a) * q, py + Math.sin(a) * q) : x.moveTo(px + Math.cos(a) * q, py + Math.sin(a) * q); } x.fill();
      x.fillStyle = `rgba(38,35,31,${0.55 + r() * 0.3})`; x.beginPath(); x.arc(px + 0.3, py + 0.3, rr * 0.8, 0, 7); x.fill(); }
  } else if (kind === 'scorch') { // shell strike on a blank wall: blast star + soot
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 62); g.addColorStop(0, 'rgba(10,9,8,0.75)'); g.addColorStop(0.5, 'rgba(25,22,19,0.45)'); g.addColorStop(1, 'rgba(25,22,19,0)'); x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 30; i++) { const a = r() * 6.28; x.strokeStyle = `rgba(15,13,11,${0.2 + r() * 0.3})`; x.lineWidth = 1 + r() * 2.5; x.beginPath(); x.moveTo(64 + Math.cos(a) * 12, 64 + Math.sin(a) * 12); x.lineTo(64 + Math.cos(a) * (35 + r() * 28), 64 + Math.sin(a) * (35 + r() * 28)); x.stroke(); }
  } else { // rust / water streaks running down from a joint
    for (let i = 0; i < 8; i++) { const px = 20 + r() * 88; const g = x.createLinearGradient(0, 0, 0, 128); g.addColorStop(0, 'rgba(70,52,36,0)'); g.addColorStop(0.1, 'rgba(70,52,36,0.35)'); g.addColorStop(1, 'rgba(70,52,36,0)'); x.fillStyle = g; x.fillRect(px, 0, 2 + r() * 5, 128); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
export function craterTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  // ejecta speckle on the rim first, then the scorched bowl
  for (let i = 0; i < 900; i++) { const a = Math.random() * 6.28, r = 45 + Math.pow(Math.random(), 0.6) * 80; const v = 40 + Math.random() * 60; x.fillStyle = `rgba(${v + 15},${v + 8},${v},${0.15 + Math.random() * 0.45})`; x.beginPath(); x.arc(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, 0.6 + Math.random() * 2.6, 0, 7); x.fill(); }
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 70);
  g.addColorStop(0, 'rgba(14,12,10,0.85)'); g.addColorStop(0.5, 'rgba(32,27,22,0.75)'); g.addColorStop(0.85, 'rgba(58,50,42,0.35)'); g.addColorStop(1, 'rgba(58,50,42,0)');
  x.fillStyle = g; x.beginPath();
  for (let i = 0; i <= 40; i++) { const a = i / 40 * 6.28, r = 62 + (Math.random() - .5) * 18; i ? x.lineTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r) : x.moveTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r); }
  x.fill();
  for (let i = 0; i < 26; i++) { const a = Math.random() * 6.28; x.strokeStyle = `rgba(20,17,14,${0.15 + Math.random() * 0.25})`; x.lineWidth = 1 + Math.random() * 3; x.beginPath(); x.moveTo(128 + Math.cos(a) * 50, 128 + Math.sin(a) * 50); x.lineTo(128 + Math.cos(a) * (80 + Math.random() * 40), 128 + Math.sin(a) * (80 + Math.random() * 40)); x.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
