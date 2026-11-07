// Battlefield detail: razor-wire obstacles, war debris and shell-damaged foliage, placed from the finished layout of any
// map (trench systems, craters, wrecks, burnt / destroyed houses, check points, the war map of wear.js).
//
// Modelled on the 2023-25 photo / drone record of the Zaporizhzhia and Donbas fronts:
//  - wire: belts of BTO-22 / "Egoza" concertina (0.9 m coils stretched to ~10 m, blades 22 mm long every 35 mm round a
//    2.5 mm core, clipped so the stretched loops form the diamond lattice) 15-30 m in front of the fire trenches -- single
//    coils at outposts, double / triple concertina on angle-iron pickets in front of lines; a barbed-wire fence (4 strands
//    on angle iron) behind some belts; coils along the rows of dragon's teeth; wire draped over the hedgehog road blocks
//    and run out over the verges beside them; coils torn by shell hits / breaching (gaps, sprung ends lying low), crushed
//    flat where vehicles drove over; tangled heaps of pulled-up wire and unused rolls behind the positions; loose torn
//    coils lying in the grass.  Galvanised (fresh, sparkling) to rusty brown.
//  - debris: ammo crates (some open, lids thrown off), zinc tins, spent RPG-26 / NLAW / AT4 / Stugna / Javelin tubes,
//    torn sandbags spilling soil, jerrycans, ration packs, bottles, helmets, plate carriers, packs, sleeping mats, cartridge
//    cases, 152 mm cases, Grad rocket motors stuck in the ground nose-first (fins up), mortar tail fins, shell fragments,
//    FPV drone wrecks, splintered planks / charred beams / roof sheets (asbestos-cement "shifer", profiled steel) and
//    bricks round wrecked houses, track runs / road wheels / ERA tiles round knocked-out armour, fallen branches.
//  - foliage (farmland belts, via treeFate(): called by farmland.js treelines() while it places them): leafless, stripped
//    trees (the leafy templates minus their foliage -- what world/treeDamage.js leaves after a barrage), snapped trunks
//    (stump + fallen top) and charred shrubs along the belts near positions / shelled ground; scorched patches painted
//    into the war map's scorch channel.
//
// Rendering (all static, built once):
//  - concertina: ONE instanced coil template (3 LODs: 36 / 18 / 7 samples per loop, the far one every third loop) with
//    per-instance crush / tear / rust in the instance colour, read by the wire shader (no per-variant templates);
//  - heaps, rolls, loose coils, barbed fences: merged per 180 m cell (near + far copy), same wire material;
//  - wire material: camera-facing ribbons expanded in the vertex shader, never thinner than ~1 px (phone-wire AA: wider
//    and fainter instead, so belts read as the grey haze they are at 200 m, without shimmer); blade / barb outline cut in
//    the fragment shader from the arc length (fading to its mean coverage when a blade is under a pixel); cylinder normal
//    across the ribbon, zinc / rust from the per-instance rust and noise, Kajiya-Kay glint along the wire + random blade
//    flats flashing; alpha-blended, no depth write (no AO / depth artefacts), no shadow;
//  - debris + pickets: one opaque vertex-coloured material (+ a small grime texture), merged per 180 m cell (near: all,
//    far: the big pieces), near copy in the static shadow cache;
//  - every cell registered in instancer.js LODS (updateLods switches near / far / off).
// Gameplay: wire belts / fences / heaps cost 3-4 on the nav grid (slower, avoided by routes, no cover, never on roads);
// debris is decorative.  Everything deterministic per map (own RNG from the map id: no draw from world.rng).
import * as THREE from 'three';
import { MAP, MAP_SIZE, ROADS, onRoad, mulberry } from './city.js';
import { instance, trs, LODS, PLACED, simplified } from './instancer.js';
import { markStatic } from '../engine/renderer.js';
import { alphaCoverage, warAt } from './wear.js';

const TAU = Math.PI * 2;
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function hash2(x, z, s = 0) {
  let h = Math.imul(Math.round(x * 8) | 0, 0x27d4eb2d) ^ Math.imul((Math.round(z * 8) | 0) + Math.imul(s, 0x9e3779b9), 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca77); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function seedOf(s) { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
const pick = (r, a) => a[Math.floor(r() * a.length)];
// ?bf=0 (or localStorage smo_bf=0): build the maps without any of this (A/B, perf comparisons)
const OFF = (() => { try { const q = new URLSearchParams(location.search).get('bf'); return q != null ? q === '0' : localStorage.getItem('smo_bf') === '0'; } catch { return false; } })();

// ================================================================ shelling intensity (0..1) over the map
// Trench lines, fire hotspots, burnt belts, field fires, wrecks and crater density, on a 4 m grid; once the war map is
// painted (wear.js paintWar) its churn / scorch raise it further.
const HC = 4;
function craters(w) {
  if (w._bfCr && w._bfCrN === (w.craterMesh?.count || 0)) return w._bfCr;
  const out = [], cm = w.craterMesh;
  if (cm && cm.count) { const M = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); for (let i = 0; i < cm.count; i++) { cm.getMatrixAt(i, M); M.decompose(p, q, s); out.push([p.x, p.z, s.x * 0.42]); } }
  else for (const [x, z, s] of w.craterList || []) out.push([x, z, s]);
  w._bfCrN = cm?.count || 0; return (w._bfCr = out);
}
function heat(w) {
  if (w._bfHeat) return w._bfHeat;
  const N = Math.ceil(MAP_SIZE / HC), g = new Float32Array(N * N), o = MAP_SIZE / 2;
  const st = (x, z, r, v, add = false) => {
    const i0 = Math.max(0, Math.floor((x - r + o) / HC)), i1 = Math.min(N - 1, Math.floor((x + r + o) / HC)), j0 = Math.max(0, Math.floor((z - r + o) / HC)), j1 = Math.min(N - 1, Math.floor((z + r + o) / HC));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot((i + 0.5) * HC - o - x, (j + 0.5) * HC - o - z); if (d >= r) continue;
      const f = v * (1 - d / r), k = j * N + i; g[k] = add ? g[k] + f : Math.max(g[k], f);
    }
  };
  const KW = { line: 1, strongpoint: 0.85, outpost: 0.72 };
  for (const s of w.trenchSystems || []) { const v = KW[s.kind] ?? 0.8; let n = 0; for (const l of s.lines || []) for (let i = 0; i < l.length; i += 3) { st(l[i][0], l[i][1], 75, v); n++; } if (!n) st(s.center[0], s.center[1], s.radius + 60, v); }
  for (const [x, z, k] of w.hotspots || []) st(x, z, 40 + 15 * k, 0.9);
  for (const [a, b, c, d] of w.burntBelts || []) { const L = Math.hypot(c - a, d - b) || 1; for (let t = 0; t <= L; t += 8) st(a + (c - a) * t / L, b + (d - b) * t / L, 20, 0.85); }
  for (const [x, z, r] of w.burns || []) st(x, z, r * 1.1, 0.5);
  for (const [x, z] of w.wreckSpots || []) st(x, z, 28, 0.6);
  for (const c of craters(w)) st(c[0], c[1], 14, 0.1 * Math.min(2.5, c[2] / 1.5), true);
  for (let k = 0; k < g.length; k++) g[k] = Math.min(1, g[k]);
  return (w._bfHeat = { g, N, o });
}
export function heatAt(w, x, z) {
  const H = heat(w), i = Math.floor((x + H.o) / HC), j = Math.floor((z + H.o) / HC);
  let h = i < 0 || j < 0 || i >= H.N || j >= H.N ? 0 : H.g[j * H.N + i];
  if (w.warData) h = Math.max(h, warAt(w, MAP_SIZE, x, z, 1) * 0.9, warAt(w, MAP_SIZE, x, z, 0) * 0.75);
  return h;
}

// ================================================================ shelled trees (farmland belts)
const isLeaf = m => !!m && (m.alphaTest > 0 || m.transparent || /leaf|leaves|foliage/i.test(m.name || ''));
// (two stripped templates only -- every template is a set of InstancedMeshes per cell: draw calls)
const SHATTER = { tree_acacia_leafy: 'acacia', tree_walnut_leafy: 'acacia', tree_acacia_shelled: 'acacia', tree_oak_leafy: 'acacia', tree_poplar_leafy: 'poplar' };
function realTpl(w, name) { for (const k of ['farmland', 'fortifications', 'trees', 'city']) { const o = w.assets?.gltf?.[k]?.scene.getObjectByName(name); if (o) return o; } return null; }
// stripped tree: the leafy template without its foliage sub-mesh (what treeDamage.js does to a crown under fire)
function shatteredTpl(w, sp) {
  const name = 'tree_' + sp + '_shattered'; w._tpl ||= {};
  if (!(name in w._tpl)) {
    const base = realTpl(w, 'tree_' + sp + '_leafy'); let t = null;
    if (base) {
      t = base.clone(true); const rm = []; t.traverse(o => { if (o.isMesh && (Array.isArray(o.material) ? o.material : [o.material]).some(isLeaf)) rm.push(o); });
      for (const o of rm) o.removeFromParent(); let any = false; t.traverse(o => { if (o.isMesh) any = true; });
      if (any) { t.name = name; t.userData = {}; t.userData.bb = new THREE.Box3().setFromObject(t); } else t = null;
    }
    w._tpl[name] = t; w._tpl[name + '_lod1'] = t ? simplified(t, 0.3, 0.02) || null : null;
  }
  return w._tpl[name] ? name : null;
}
// charred shrub: same cards, burnt black-brown, thinned (higher alpha cut-off)
const charMats = new Map();
function charMat(m) {
  if (charMats.has(m)) return charMats.get(m);
  const c = m.clone(); c.name = (m.name || '') + '_charred';
  // scorched: the leaves gone dry brown / black (texture x dark umber), thinned out to the twigs; charred stems
  if (isLeaf(m)) { c.color.setRGB(0.36, 0.25, 0.16); c.alphaTest = Math.max(0.72, m.alphaTest || 0); c.userData.alphaCov = false; if (c.map) alphaCoverage(c); }
  else c.color.multiplyScalar(0.3);
  charMats.set(m, c); return c;
}
function charredTpl(w, bush) {
  const name = 'charred_' + bush; w._tpl ||= {};
  if (!(name in w._tpl)) {
    const mk = (src, n) => { if (!src) return null; const t = src.clone(true); t.traverse(o => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(charMat) : charMat(o.material); }); t.name = n; t.userData = {}; t.userData.bb = new THREE.Box3().setFromObject(t); return t; };
    w._tpl[name] = mk(realTpl(w, bush), name); w._tpl[name + '_lod1'] = w._tpl[name] ? mk(realTpl(w, bush + '_lod1'), name + '_lod1') : null;
  }
  return w._tpl[name] ? name : null;
}
// farmland.js treelines(): the template to place for a belt tree / bush at (x, z) -- unchanged, stripped, snapped (a
// stump; the fallen top is placed here) or charred, by the shelling intensity and a position hash (no world.rng draw)
export function treeFate(w, name, x, z) {
  if (OFF || !w.tpl || !w.put) return name;
  const h = heatAt(w, x, z); if (h < 0.3) return name;
  const u = hash2(x, z, 11);
  if (/^bush_[ab]$/.test(name)) { if (u < sstep(0.35, 0.95, h) * 0.7) { const n = charredTpl(w, 'bush_a'); if (n) { (w._bfScorch ||= []).push([x, z, 2.6, 0.45]); return n; } } return name; }
  const sp = SHATTER[name]; if (!sp) return name;
  const pSnap = sstep(0.5, 1, h) * 0.26, pStrip = sstep(0.3, 0.85, h) * 0.72;
  if (u < pSnap && realTpl(w, 'stump_1')) {
    (w._bfTops ||= []).push([x, z, hash2(x, z, 12) * TAU, /poplar/.test(name) ? 1.25 : 1]);   // the top lies beside the stump (merged log, detail step)
    if (hash2(x, z, 16) < 0.4) (w._bfScorch ||= []).push([x, z, 3, 0.3]);
    return 'stump_1';
  }
  if (u < pSnap + pStrip) { const n = shatteredTpl(w, sp); if (n) { if (hash2(x, z, 17) < 0.3) (w._bfScorch ||= []).push([x, z, 3.5, 0.25]); return n; } }
  return name;
}

// ================================================================ wire: material
const WU = { uPix: { value: 0.0015 } }, _v2 = new THREE.Vector2();
// world size of one pixel at unit distance, for the vertex shader's minimum width
function pixHook(o) { o.onBeforeRender = (r, s, cam) => { if (!cam.isPerspectiveCamera) return; r.getDrawingBufferSize(_v2); WU.uPix.value = 2 * Math.tan(cam.fov * Math.PI / 360) / Math.max(1, _v2.y); }; }
const COIL_L = 10, COIL_R = 0.46;
let WIRE_I = null, WIRE_V = null;
function wireMaterial(vertexColors) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.72, roughness: 0.48, envMapIntensity: 0.6, transparent: true, depthWrite: false, side: THREE.DoubleSide, vertexColors });
  m.name = 'bf_wire'; m.forceSinglePass = true;   // (thin ribbons: no separate back-face pass for the double-sided blend)
  m.customProgramCacheKey = () => 'bf_wire_v1';
  m.onBeforeCompile = sh => {
    sh.uniforms.uPix = WU.uPix;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aTan; attribute vec2 aArc; uniform float uPix;
        varying vec3 vWArc; varying float vWFade; varying vec3 vWTan; varying vec3 vWN0; varying vec3 vWSd; varying float vWRust;
        float bfH(float n){ return fract(sin(n) * 43758.5453); }
        float bfN(float x){ float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(bfH(i), bfH(i + 1.0), f); }`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <project_vertex>', `
        vec3 wP = vec3(0.0);
        #if defined( USE_INSTANCING_COLOR )
          wP = instanceColor.rgb;
        #elif defined( USE_COLOR )
          wP = color.rgb;
        #endif
        vec3 tp = transformed, tl = aTan.xyz; float hw = abs(aTan.w), hide = 0.0;
        #ifdef USE_INSTANCING
        {   // per coil (instance colour = rust, crush, tear position); template frame: x along the coil 0..${COIL_L}, axis at y = ${COIL_R}
          float sd = bfH(dot(instanceMatrix[3].xz, vec2(1.731, 3.117)));
          float n = bfN(tp.x * 0.45 + sd * 37.0), c = wP.g * (0.55 + 0.45 * n);
          float yk = 1.0 - c * 0.62, zk = 1.0 + c * 0.55;   // crushed: driven over / blast-flattened, lower and wider, unevenly
          yk *= 1.0 - 0.1 * bfN(tp.x * 0.8 + sd * 11.0) * smoothstep(0.25, 0.85, tp.y);   // the top settles between the pickets
          if (wP.b > 0.01) {   // torn: loops gone in the gap, the sprung ends lie low and splay
            float d = abs(tp.x / ${COIL_L.toFixed(1)} - wP.b); if (d < 0.07) hide = 1.0;
            float k = 1.0 - smoothstep(0.07, 0.2, d); yk *= 1.0 - 0.55 * k; zk *= 1.0 + 0.45 * k;
          }
          tp.y *= yk; tp.z *= zk; tl.y *= yk; tl.z *= zk; tl = normalize(tl);
          tp.z += c * (n - 0.5) * 0.35 * tp.y;
        }
        #endif
        vec4 wc = vec4(tp, 1.0); vec3 wt = tl;
        #ifdef USE_INSTANCING
          wc = instanceMatrix * wc; wt = mat3(instanceMatrix) * wt;
        #endif
        wc = modelMatrix * wc; wt = normalize(mat3(modelMatrix) * wt);
        vec3 toC = cameraPosition - wc.xyz; float dist = length(toC); toC /= max(dist, 1e-4);
        vec3 sdv = cross(wt, toC); float sl = length(sdv); sdv = sl > 1e-4 ? sdv / sl : vec3(0.0, 1.0, 0.0);
        float w = max(hw, dist * uPix * 0.5);   // never under ~1 px wide: wider and fainter instead (phone-wire AA)
        vWFade = hide > 0.5 ? 0.0 : hw / w;
        wc.xyz += sdv * sign(aTan.w) * w * (1.0 - hide);
        vWArc = vec3(aArc.x, sign(aTan.w), aArc.y); vWRust = wP.r;
        vec3 n0 = normalize(toC - wt * dot(toC, wt));
        vWTan = normalize((viewMatrix * vec4(wt, 0.0)).xyz); vWN0 = normalize((viewMatrix * vec4(n0, 0.0)).xyz); vWSd = normalize((viewMatrix * vec4(sdv, 0.0)).xyz);
        vec4 mvPosition = viewMatrix * wc;
        gl_Position = projectionMatrix * mvPosition;`)
      .replace('#include <worldpos_vertex>', 'vec4 worldPosition = wc;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWArc; varying float vWFade; varying vec3 vWTan; varying vec3 vWN0; varying vec3 vWSd; varying float vWRust;
        float bfH2(float n){ return fract(sin(n) * 43758.5453); }
        float bfN2(float x){ float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(bfH2(i), bfH2(i + 1.0), f); }
        float wRust = 0.0;`)
      .replace('#include <color_fragment>', `{
        float rn = bfN2(vWArc.x * 1.3 + vWRust * 31.0) * 0.6 + bfN2(vWArc.x * 7.0) * 0.4;
        wRust = clamp(vWRust * 1.2 + (rn - 0.5) * 0.8 * smoothstep(0.02, 0.3, vWRust), 0.0, 1.0);
        vec3 zinc = vec3(0.33, 0.335, 0.33) * (0.75 + 0.3 * bfN2(vWArc.x * 3.0 + 5.0));   // hot-dip zinc after months outdoors: dull grey
        vec3 rust = mix(vec3(0.24, 0.12, 0.055), vec3(0.37, 0.21, 0.11), bfN2(vWArc.x * 11.0));
        diffuseColor.rgb = mix(zinc, rust, wRust);
      }`)
      .replace('#include <alphamap_fragment>', `{
        float s = abs(vWArc.y), fw = fwidth(vWArc.x), a = 1.0, avg = 0.5;
        if (vWArc.z < 0.5) {   // BTO-22 razor tape: blades 22 mm long every 35 mm, two barb points each, round a 2.5 mm core
          float u = fract(vWArc.x / 0.035), blade = step(u, 0.63);
          float b1 = max(0.0, 1.0 - abs(u - 0.1) / 0.09), b2 = max(0.0, 1.0 - abs(u - 0.53) / 0.09);
          float e = max(0.22, blade * (0.42 + 0.58 * max(b1, b2)));
          a = 1.0 - smoothstep(e - 0.1, e + 0.1, s); avg = 0.46;
          a = mix(a, avg, smoothstep(0.01, 0.03, fw));
        } else if (vWArc.z < 1.5) {   // barbed wire: two twisted strands, 4-point barbs every 10 cm
          float u = fract(vWArc.x / 0.1), e = max(0.42, step(u, 0.07));
          a = 1.0 - smoothstep(e - 0.12, e + 0.12, s); avg = 0.47;
          a = mix(a, avg, smoothstep(0.03, 0.09, fw));
          diffuseColor.rgb *= 0.8 + 0.3 * abs(sin(vWArc.x * 209.0));
        }
        a = mix(avg, a, smoothstep(0.5, 1.0, vWFade));
        diffuseColor.a *= clamp(a * vWFade * mix(1.6, 1.0, vWFade), 0.0, 1.0);
        if (diffuseColor.a < 0.003) discard;
      }`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        { float ss = clamp(vWArc.y, -1.0, 1.0); normal = normalize(normalize(vWN0) * sqrt(max(0.0, 1.0 - ss * ss)) + normalize(vWSd) * ss); nonPerturbedNormal = normal; }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.88, wRust);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.2, wRust);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
        {   // glints: the highlight runs along the wire where its tangent is square to the half vector (Kajiya-Kay), and
            // single blade flats flash (one random facet per blade); directLight = the (shadowed) sun after the light loop
          vec3 H = normalize(directLight.direction + normalize(vViewPosition));
          float th = dot(normalize(vWTan), H), sth = sqrt(max(0.0, 1.0 - th * th));
          float k = pow(sth, 80.0) * 0.22;
          float hb = bfH2(floor(vWArc.x / 0.035) * 7.31 + vWArc.z * 3.0);
          k += step(vWArc.z, 0.5) * step(0.95, hb) * pow(sth, 14.0) * 0.8;
          reflectedLight.directSpecular += directLight.color * k * (1.0 - wRust) * (0.25 + 0.75 * smoothstep(0.15, 0.7, vWFade));
        }
        #endif`);
  };
  return m;
}
function wireMats() { WIRE_I ||= wireMaterial(false); WIRE_V ||= wireMaterial(true); return [WIRE_I, WIRE_V]; }

// ribbon geometry: every polyline sample becomes 2 vertices (same centre point, side -1 / +1); the shader opens them
class WireBuf {
  constructor() { this.p = []; this.t = []; this.a = []; this.c = []; this.i = []; }
  curve(pts, hw, type, col = null) {
    const n = pts.length; if (n < 2) return;
    const b = this.p.length / 3; let s = 0;
    for (let k = 0; k < n; k++) {
      const A = pts[Math.max(0, k - 1)], B = pts[Math.min(n - 1, k + 1)];
      let tx = B[0] - A[0], ty = B[1] - A[1], tz = B[2] - A[2]; const L = Math.hypot(tx, ty, tz) || 1; tx /= L; ty /= L; tz /= L;
      if (k) s += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1], pts[k][2] - pts[k - 1][2]);
      for (const sd of [-1, 1]) { this.p.push(pts[k][0], pts[k][1], pts[k][2]); this.t.push(tx, ty, tz, sd * hw); this.a.push(s, type); if (col) this.c.push(col[0], col[1], col[2]); }
    }
    for (let k = 0; k < n - 1; k++) { const q = b + k * 2; this.i.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); }
  }
  get empty() { return !this.i.length; }
  geo() {
    const g = new THREE.BufferGeometry(), nv = this.p.length / 3;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3)); g.setAttribute('aTan', new THREE.Float32BufferAttribute(this.t, 4));
    g.setAttribute('aArc', new THREE.Float32BufferAttribute(this.a, 2)); if (this.c.length) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(new THREE.BufferAttribute(nv > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i), 1)); g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}
// One stretched coil, 10 m along +x.  Loop k is a ring of radius ~R round the axis whose x swings +-spacing/2 three
// times round the ring, alternately in phase with its neighbours: the clip points of a stretched concertina, seen from
// the side as the diamond lattice.  Bottom flattened where it lies on the ground.
function coilGeo(lod) {
  const R = mulberry(9133), spacing = 0.235, loops = Math.round(COIL_L / spacing), wb = new WireBuf(), ph0 = 0.4;
  // (far: 7 samples on every third loop, three times as wide -- the same coverage at > 110 m, ~140 triangles a coil)
  const samples = [36, 18, 7][lod], every = lod === 2 ? 3 : 1, hw = 0.012 * (lod === 2 ? 2.6 : 1);
  for (let k = 0; k < loops; k++) {
    // (field-laid coils are untidy: loops of uneven size, leaning and twisted out of square, unevenly spaced)
    const rk = COIL_R * (0.86 + R() * 0.18), ph = ph0 + (R() - 0.5) * 0.2, xk = (k + 0.5 + (R() - 0.5) * 0.35) * spacing, lean = (R() - 0.5) * 0.4, yaw = (R() - 0.5) * 0.45, sq = 0.9 + R() * 0.12, wob = R() * TAU;
    if (k % every) continue;
    const pts = [];
    for (let i = 0; i <= samples; i++) {
      const th = i / samples * TAU + ph;
      let y = COIL_R + rk * Math.sin(th) * sq * (1 + 0.05 * Math.sin(2 * th + wob)), z = rk * Math.cos(th) * (1 + 0.04 * Math.sin(3 * th + wob));
      const x = xk + spacing * 0.55 * Math.cos(3 * th + k * Math.PI) + lean * (y - COIL_R) + yaw * z;
      if (y < 0.03) y = 0.03 + (y - 0.03) * 0.15;
      pts.push([x, y, z]);
    }
    wb.curve(pts, hw, 0);
  }
  return wb.geo();
}
// local-frame coil fragment (n loops, radius r, spacing sp) for heaps / rolls / loose coils
function coilPts(R, n, r, sp, samples, every, out) {
  const ph0 = R() * TAU;
  for (let k = 0; k < n; k++) {
    const rk = r * (0.9 + R() * 0.2), ph = ph0 + (R() - 0.5) * 0.3, wob = R() * TAU;
    if (k % every) continue;
    const pts = [];
    for (let i = 0; i <= samples; i++) { const th = i / samples * TAU + ph; pts.push([(k + 0.5) * sp + sp * 0.5 * Math.cos(3 * th + k * Math.PI), rk * Math.sin(th) * (1 + 0.06 * Math.sin(2 * th + wob)), rk * Math.cos(th)]); }
    out.push(pts);
  }
  return out;
}
const rotP = (p, ax, ay) => { // rotate about z (tilt) then y (yaw)
  const cz = Math.cos(ax), sz = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
  const x = p[0] * cz - p[1] * sz, y = p[0] * sz + p[1] * cz, z = p[2];
  return [x * cy + z * sy, y, -x * sy + z * cy];
};

// ================================================================ debris: geometry
const G = {};
function geos() {
  if (G.box) return G;
  G.box = new THREE.BoxGeometry(1, 1, 1);
  G.cyl = {}; for (const seg of [5, 6, 8, 10, 14]) for (const t of [1, 0.88, 0.7, 0.5, 0.35]) { G.cyl[seg + '_' + t] = new THREE.CylinderGeometry(t, 1, 1, seg, 1); G.cyl[seg + '_' + t + 'o'] = new THREE.CylinderGeometry(t, 1, 1, seg, 1, true); }
  G.ico = new THREE.IcosahedronGeometry(1, 0); G.tet = new THREE.TetrahedronGeometry(1, 0);
  G.hemi = new THREE.SphereGeometry(1, 9, 4, 0, TAU, 0, Math.PI / 2);
  G.torus = new THREE.TorusGeometry(1, 0.33, 5, 10);
  // torn, slumped sandbags / soft packs: a subdivided box, flattened, bulged and crumpled
  G.bags = [0, 1, 2, 3].map(s => { const R = mulberry(77 + s), g = new THREE.BoxGeometry(1, 1, 1, 3, 1, 2), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { let x = p.getX(i), y = p.getY(i), z = p.getZ(i); const b = 1 - (x * x * 1.6 + z * z * 1.6); y = y * (0.55 + 0.45 * b) + (R() - 0.5) * 0.18; x *= 0.92 + R() * 0.12; z *= 0.9 + R() * 0.14; if (s % 2 && x > 0.2 && y > 0) y -= 0.35 * (x - 0.2); p.setXYZ(i, x, Math.max(-0.5, y), z); }
    g.computeVertexNormals(); return g; });
  // roof sheets: asbestos-cement "shifer" (8 waves over 1.13 m, 1.75 m long) and profiled steel (trapezoid ribs);
  // bent, with a broken corner: top + bottom skins
  const sheet = (R, shifer) => {
    const nu = 4, nv = shifer ? 24 : 18, L = shifer ? 1.75 : 2.0, W = shifer ? 1.13 : 1.15, waves = shifer ? 8 : 6, amp = shifer ? 0.024 : 0.018;
    const curl = (R() - 0.3) * (shifer ? 0.12 : 0.6), twist = (R() - 0.5) * 0.25, cut = [R() * 0.6 + 0.2, R() < 0.6 ? 0.25 + R() * 0.4 : 9];
    const pos = [], idx = [], uv = [];
    for (const side of [0, 1]) for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
      const u = i / nu, v = j / nv, ph = v * waves * TAU;
      const wv = shifer ? Math.sin(ph) * amp : (Math.max(-0.6, Math.min(0.6, Math.sin(ph))) / 0.6) * amp;
      const y = wv + curl * (u - 0.5) * (u - 0.5) * L + twist * (u - 0.5) * (v - 0.5) - side * 0.006;
      pos.push((u - 0.5) * L, y, (v - 0.5) * W); uv.push(u, v);
    }
    const row = nv + 1, half = (nu + 1) * row, broken = (u, v) => u + v * cut[0] > 1 + cut[1] * 0.5;
    for (const side of [0, 1]) for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      if (broken((i + 0.5) / nu, (j + 0.5) / nv)) continue;
      const a = side * half + i * row + j, b = a + row, c = a + 1, d = b + 1;
      if (side) idx.push(a, c, b, c, d, b); else idx.push(a, b, c, c, b, d);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); return g;
  };
  G.sheetS = [0, 1, 2, 3].map(s => sheet(mulberry(311 + s), true)); G.sheetM = [0, 1, 2, 3].map(s => sheet(mulberry(411 + s), false));
  return G;
}
const _m4 = new THREE.Matrix4(), _nm = new THREE.Matrix3(), _nv = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p3 = new THREE.Vector3(), _s3 = new THREE.Vector3();
function lm(x, y, z, rx, ry, rz, sx, sy, sz) { return new THREE.Matrix4().compose(_p3.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s3.set(sx, sy, sz)); }
function col(hex, r, v = 0.1) { return new THREE.Color(hex).multiplyScalar(1 - v + r() * 2 * v); }
const newDB = () => ({ p: [], n: [], c: [], u: [], i: [] });
// piece writer: begin() sets the piece frame (on the ground), parts are written into the near (and far) buffer of the
// cell the piece is in, transformed to world space, with a little ground occlusion near the bottom
class Debris {
  constructor() { this.cells = new Map(); this.M = new THREE.Matrix4(); this.pieces = 0; this.CS = 180; }
  cell(x, z) { const i = Math.floor(x / this.CS), j = Math.floor(z / this.CS), k = i + ',' + j; let c = this.cells.get(k); if (!c) this.cells.set(k, c = { near: newDB(), far: newDB(), x: (i + 0.5) * this.CS, z: (j + 0.5) * this.CS }); return c; }
  begin(x, y, z, ry = 0, rx = 0, rz = 0, s = 1, far = false) { this.M.copy(trs(x, y, z, ry, s, rx, rz)); const c = this.cell(x, z); this.nb = c.near; this.fb = far ? c.far : null; this.y0 = y; this.pieces++; return this; }
  part(geo, L, color) { _m4.multiplyMatrices(this.M, L); this.push(this.nb, geo, _m4, color); if (this.fb) this.push(this.fb, geo, _m4, color); }
  box(x, y, z, w, h, d, c, ry = 0, rx = 0, rz = 0) { this.part(G.box, lm(x, y, z, rx, ry, rz, w, h, d), c); }
  // cylinder centred at (x, y, z), axis = local y rotated by (rx, ry, rz); taper = top / bottom radius
  cyl(x, y, z, r, len, c, rx = 0, ry = 0, rz = 0, taper = 1, seg = 8, open = false) { this.part(G.cyl[seg + '_' + taper + (open ? 'o' : '')] || G.cyl['8_1'], lm(x, y, z, rx, ry, rz, r, len, r), c); }
  push(b, geo, M, color) {
    _nm.getNormalMatrix(M);
    const P = geo.attributes.position, N = geo.attributes.normal, I = geo.index, base = b.p.length / 3, e = M.elements;
    for (let i = 0; i < P.count; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12], wy = e[1] * x + e[5] * y + e[9] * z + e[13], wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      _nv.set(N.getX(i), N.getY(i), N.getZ(i)).applyMatrix3(_nm).normalize();
      b.p.push(wx, wy, wz); b.n.push(_nv.x, _nv.y, _nv.z);
      const ao = 0.64 + 0.36 * sstep(0, 0.2, wy - this.y0);
      b.c.push(color.r * ao, color.g * ao, color.b * ao);
      const ay = Math.abs(_nv.y), ax = Math.abs(_nv.x), az = Math.abs(_nv.z);
      if (ay > 0.7) b.u.push(wx * 0.9, wz * 0.9); else if (ax > az) b.u.push(wz * 0.9, wy * 0.9); else b.u.push(wx * 0.9, wy * 0.9);
    }
    if (I) for (let i = 0; i < I.count; i++) b.i.push(base + I.getX(i)); else for (let i = 0; i < P.count; i++) b.i.push(base + i);
  }
}
// ---- pieces (local frame: origin on the ground, +y up)
const TUBES = [
  { l: 0.77, r: 0.036, e: 0.05, k: 1.25, c: 0x4f5a3a },          // RPG-26 / RPG-22
  { l: 1.02, r: 0.062, e: 0.17, k: 1.45, c: 0x55603f, s: 1 },    // NLAW
  { l: 1.0, r: 0.044, e: 0.1, k: 1.6, c: 0x5d5a3d, s: 1 },       // AT4
  { l: 1.25, r: 0.075, e: 0.08, k: 1.2, c: 0x434c37 },           // Stugna-P / Kornet transport-launch container
  { l: 1.2, r: 0.068, e: 0.14, k: 1.6, c: 0x6b6648 },            // Javelin
];
const PC = {
  crate(D, r) { const c = col(pick(r, [0x4d5434, 0x565c3b, 0x5f5f42, 0x4a4f33]), r), dk = c.clone().multiplyScalar(0.72);
    D.box(0, 0.12, 0, 0.6, 0.24, 0.34, c); D.box(-0.31, 0.125, 0, 0.025, 0.25, 0.37, dk); D.box(0.31, 0.125, 0, 0.025, 0.25, 0.37, dk);
    if (r() < 0.55) { D.box(0, 0.241, 0, 0.56, 0.004, 0.3, col(0x2b281f, r)); D.box((r() - 0.5) * 0.5, 0.012, 0.36 + r() * 0.3, 0.6, 0.024, 0.34, c, (r() - 0.5) * 0.8); }
    else D.box(0, 0.252, 0, 0.6, 0.024, 0.34, c); },
  zinc(D, r) { D.box(0, 0.075, 0, 0.36, 0.15, 0.24, col(0x5c6150, r)); if (r() < 0.6) D.box(0.04, 0.17, 0.06, 0.3, 0.004, 0.16, col(0x7c7f72, r), 0, 0.5 + r() * 0.8); },
  tube(D, r) { const t = pick(r, TUBES), c = col(t.c, r);
    D.cyl(0, t.r, 0, t.r, t.l, c, 0, 0, Math.PI / 2, 1, 8, true);
    for (const sx of [-1, 1]) D.cyl(sx * (t.l / 2 - t.e / 2), t.r, 0, t.r * t.k, t.e, c.clone().multiplyScalar(0.82), 0, 0, Math.PI / 2, 1, 8);
    if (t.s) D.box(t.l * 0.1, t.r * 2 + 0.025, 0, 0.12, 0.05, 0.045, col(0x2a2b26, r)); },
  gradTail(D, r) {   // 122 mm 9M22 motor section stuck nose-first, four flip-out wrap-around fins at the top
    const c = col(pick(r, [0x4a3324, 0x3b302a, 0x56412f]), r), L = 0.9 + r() * 0.7;
    D.cyl(0, L / 2 - 0.3, 0, 0.061, L + 0.6, c, 0, 0, 0, 1, 10);
    D.cyl(0, L + 0.02, 0, 0.05, 0.06, col(0x231e1a, r), 0, 0, 0, 1, 10);
    for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + 0.3; D.box(Math.cos(a) * 0.105, L - 0.12, -Math.sin(a) * 0.105, 0.09, 0.2, 0.004, c.clone().multiplyScalar(0.8), a + 0.35); }
    D.cyl(0, 0.015, 0, 0.2, 0.05, col(0x3e352b, r), 0, 0, 0, 0.5, 8); },
  mortarTail(D, r) { const c = col(0x3f4236, r); D.cyl(0, 0.16, 0, 0.032, 0.34, c, 0, 0, 0, 1, 8); for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; D.box(Math.cos(a) * 0.05, 0.28, -Math.sin(a) * 0.05, 0.06, 0.12, 0.003, c, a); } D.cyl(0, 0.015, 0, 0.13, 0.04, col(0x3e352b, r), 0, 0, 0, 0.5, 8); },
  case152(D, r) { const c = col(r() < 0.35 ? 0x9c7a3a : 0x5e5d48, r); D.cyl(0, 0.084, 0, 0.083, 0.42, c, 0, 0, Math.PI / 2, 0.88, 10); D.cyl(0.215, 0.09, 0, 0.092, 0.015, c.clone().multiplyScalar(0.9), 0, 0, Math.PI / 2, 1, 10); },
  sandbag(D, r) { D.part(pick(r, G.bags), lm(0, 0.07, 0, 0, r() * 6, 0, 0.6, 0.16, 0.36), col(pick(r, [0xb8b2a2, 0xa9a08a, 0x6c6a4a, 0x9a8761]), r)); if (r() < 0.6) D.part(G.ico, lm(0.3 + r() * 0.2, 0.0, (r() - 0.5) * 0.4, 0, r() * 6, 0, 0.35, 0.07, 0.28), col(0x3f362b, r)); },
  jerrycan(D, r) { const c = col(pick(r, [0x3f4a32, 0x6e2a22, 0x495038]), r);
    if (r() < 0.6) { D.box(0, 0.085, 0, 0.47, 0.17, 0.35, c); D.box(0.25, 0.085, 0.1, 0.04, 0.05, 0.06, c); }
    else { D.box(0, 0.235, 0, 0.165, 0.47, 0.35, c); D.box(0, 0.49, 0.08, 0.05, 0.04, 0.16, c); } },
  plank(D, r) { const L = 1.2 + r() * 2.2, c = col(r() < 0.3 ? 0x231d19 : pick(r, [0x7d6c55, 0x8a8173, 0x6a5b48]), r), w = 0.11 + r() * 0.08;
    D.box(0, 0.015, 0, L, 0.025, w, c); for (let k = 0; k < 3; k++) D.box(L / 2 + 0.06, 0.015, (k - 1) * w * 0.32, 0.14 + r() * 0.12, 0.02, w * 0.22, c, (r() - 0.5) * 0.3); },
  beam(D, r) { const L = 2 + r() * 2.5, c = col(r() < 0.5 ? 0x1f1a16 : 0x6e5d48, r); D.box(0, 0.075, 0, L, 0.15, 0.15, c, 0, 0, (r() - 0.5) * 0.06); for (let k = 0; k < 3; k++) D.box(L / 2 + 0.08, 0.075 + (k - 1) * 0.04, (r() - 0.5) * 0.08, 0.2 + r() * 0.15, 0.04, 0.04, col(0xa08a68, r), (r() - 0.5) * 0.4); },
  // snapped tree top lying from its stump along +x: tapered trunk, broken limbs, splintered butt
  log(D, r, k = 1) { const L = (4 + r() * 3.5) * k, r0 = 0.11 + r() * 0.08, c = col(pick(r, [0x4a4038, 0x3f3a34, 0x544a3e]), r);
    D.cyl(L / 2 + 0.3, r0 * 0.9, 0, r0, L, c, 0, 0, -Math.PI / 2, 0.35, 8, true);   // (thin end towards +x)
    for (let i = 0; i < 3 + (r() * 3 | 0); i++) { const t = 0.3 + (0.35 + r() * 0.6) * L, l = (0.8 + r() * 1.8) * k, a = (r() < 0.5 ? 1 : -1) * (0.5 + r() * 0.7), up = r() * 0.6, ca = Math.cos(up) * l / 2;
      D.cyl(t + Math.cos(a) * ca, r0 * 0.8 + Math.sin(up) * l / 2, Math.sin(a) * ca, r0 * 0.35, l, c, 0, Math.PI - a, Math.PI / 2 - up, 0.35, 5, true); }
    const wd = col(0xa08a68, r); for (let i = 0; i < 4; i++) D.box(0.18 + r() * 0.1, r0 * (0.5 + r()), (r() - 0.5) * r0 * 1.4, 0.35 + r() * 0.3, r0 * 0.5, r0 * 0.45, wd, (r() - 0.5) * 0.4, 0, (r() - 0.5) * 0.5); },
  branch(D, r) { const L = 1.4 + r() * 2.6, c = col(pick(r, [0x4a3f34, 0x5a4d40, 0x3c342c]), r), r0 = 0.03 + r() * 0.045;
    D.cyl(0, r0, 0, r0, L, c, 0, 0, Math.PI / 2, 0.35, 6, true);
    const n = 2 + (r() * 3 | 0); for (let k = 0; k < n; k++) { const t = (r() - 0.35) * L * 0.8, l = 0.4 + r() * 1.1, a = (r() < 0.5 ? 1 : -1) * (0.4 + r() * 0.7); D.cyl(t - Math.cos(a) * l / 2, r0 * 0.7, Math.sin(a) * l / 2, r0 * 0.5, l, c, 0, a, Math.PI / 2, 0.35, 5, true); }
    D.box(L / 2, r0, 0, 0.12, r0 * 1.7, r0 * 1.7, col(0xa08a68, r)); },
  sheet(D, r, shifer = r() < 0.55) { const s = 0.6 + r() * 0.5;
    D.part(pick(r, shifer ? G.sheetS : G.sheetM), lm(0, 0.035, 0, (r() - 0.5) * 0.12, 0, (r() - 0.5) * 0.12, s, 1, s), col(shifer ? pick(r, [0x8e8c84, 0x9b998f, 0x7f7d76]) : pick(r, [0x8b908e, 0x45584a, 0x6b3b2e, 0x7e8482]), r)); },
  brick(D, r) { D.box(0, 0.035, 0, 0.25, 0.065, 0.12, col(r() < 0.6 ? 0x8c4b37 : 0xb7b2a5, r), 0, (r() - 0.5) * 0.3, (r() - 0.5) * 0.3); },
  chunk(D, r) { const s = 0.15 + r() * 0.35; D.part(G.ico, lm(0, s * 0.3, 0, r() * 3, r() * 6, r() * 3, s, s * 0.7, s * 0.85), col(pick(r, [0x8d8a83, 0x7a776f, 0x9a968c]), r)); },
  rebar(D, r) { const s = 0.2 + r() * 0.3; D.part(G.ico, lm(0, s * 0.3, 0, r() * 3, r() * 6, r() * 3, s, s * 0.6, s), col(0x8d8a83, r)); for (let k = 0; k < 2 + (r() * 2 | 0); k++) D.cyl(0, s * 0.4, 0, 0.007, 0.5 + r() * 0.6, col(0x4a3426, r), 0.6 + r() * 0.8, r() * 6, 0.4, 1, 5); },
  window(D, r) { const c = col(r() < 0.7 ? 0xd8d6cf : 0x6b5a46, r), w = 1.1 + r() * 0.4, h = 1.2 + r() * 0.3;
    D.box(0, 0.03, -h / 2, w, 0.06, 0.07, c); if (r() < 0.7) D.box(0, 0.03, h / 2, w, 0.06, 0.07, c); D.box(-w / 2, 0.03, 0, 0.07, 0.06, h, c); if (r() < 0.6) D.box(w / 2, 0.03, 0, 0.07, 0.06, h, c); D.box(0, 0.025, 0, 0.05, 0.05, h, c); },
  helmet(D, r) { const up = r() < 0.4; D.part(G.hemi, lm(0, up ? 0.12 : 0, 0, up ? Math.PI : 0, r() * 6, 0, 0.135, 0.12, 0.15), col(pick(r, [0x4d4e38, 0x5c5a42, 0x3f4433]), r)); },
  carrier(D, r) { const c = col(pick(r, [0x6b664b, 0x50553c, 0x5c5c46]), r); D.box(0, 0.035, 0, 0.32, 0.07, 0.4, c); D.box(0, 0.09, 0.08, 0.28, 0.05, 0.14, c.clone().multiplyScalar(0.9)); D.box(0.1, 0.085, -0.1, 0.08, 0.05, 0.1, c); },
  pack(D, r) { const c = col(pick(r, [0x55573d, 0x4b4a3a, 0x5f5a45]), r); D.part(pick(r, G.bags), lm(0, 0.11, 0, 0, 0, 0, 0.36, 0.22, 0.5), c); D.box(0, 0.2, -0.12, 0.26, 0.08, 0.16, c); },
  mat(D, r) { D.cyl(0, 0.08, 0, 0.08, 0.6, col(pick(r, [0x3d5240, 0x34506a, 0x5a5b44]), r), 0, 0, Math.PI / 2, 1, 8); },
  tyre(D, r) { D.part(G.torus, lm(0, 0.1, 0, Math.PI / 2, 0, (r() - 0.5) * 0.2, 0.3, 0.3, 0.3), col(0x1f1e1d, r)); },
  wheel(D, r) { D.cyl(0, 0.09, 0, 0.37, 0.18, col(0x2e2c28, r), (r() - 0.5) * 0.2, 0, (r() - 0.5) * 0.2, 1, 14); D.cyl(0, 0.181, 0, 0.2, 0.012, col(0x3d3b35, r), 0, 0, 0, 1, 10); },
  links(D, r) { const n = 8 + (r() * 12 | 0), c = col(0x2f2b26, r); let a = 0, x = 0, z = 0; for (let k = 0; k < n; k++) { D.box(x, 0.02, z, 0.15, 0.035, 0.55, c, a); a += (r() - 0.5) * 0.25; x += Math.cos(a) * 0.155; z -= Math.sin(a) * 0.155; } },
  era(D, r) { D.box(0, 0.03, 0, 0.25, 0.06, 0.14, col(0x3f4733, r), 0, (r() - 0.5) * 0.4, (r() - 0.5) * 0.4); },
  frag(D, r) { const n = 3 + (r() * 5 | 0); for (let k = 0; k < n; k++) { const s = 0.04 + r() * 0.09; D.part(G.tet, lm((r() - 0.5) * 0.9, s * 0.15, (r() - 0.5) * 0.9, r() * 3, r() * 6, r() * 3, s, s * 0.3, s * 0.6), col(0x2f2925, r)); } },
  casings(D, r) { const n = 10 + (r() * 14 | 0); for (let k = 0; k < n; k++) D.part(G.tet, lm((r() - 0.5) * 1.4, 0.004, (r() - 0.5) * 1.4, 0, r() * 6, 0, 0.022, 0.006, 0.006), col(pick(r, [0xa8823d, 0x6f6a4a]), r)); },
  fpv(D, r) { const c = col(0x1c1c1c, r); D.box(0, 0.02, 0, 0.26, 0.012, 0.03, c, 0.785); D.box(0, 0.02, 0, 0.26, 0.012, 0.03, c, -0.785);
    for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + 0.785; D.cyl(Math.cos(a) * 0.12, 0.035, -Math.sin(a) * 0.12, 0.014, 0.025, col(0x3a3a3a, r), 0, 0, 0, 1, 6); }
    D.box(0.02, 0.045, 0, 0.1, 0.035, 0.04, col(0x2a2f3a, r)); if (r() < 0.5) D.cyl(-0.05, 0.05, 0.06, 0.04, 0.25, col(0x4b5232, r), 0, 0.5, Math.PI / 2, 0.7, 8); },
  bottle(D, r) { D.cyl(0, 0.04, 0, 0.04, 0.26, col(pick(r, [0xa9b5a6, 0x6b8f6a, 0x8a9aa8]), r), 0, r() * 6, Math.PI / 2, 0.88, 6); },
  ration(D, r) { D.box(0, 0.02, 0, 0.22, 0.04, 0.14, col(pick(r, [0x8c7d5a, 0x4d6a3f, 0x6e6545]), r), r() * 6); },
};
// cluster recipes: [piece, min, max, in far LOD]
const MIX = {
  litter: [['crate', 1, 3, 1], ['zinc', 1, 4], ['sandbag', 0, 2], ['tube', 0, 2, 1], ['jerrycan', 0, 1, 1], ['ration', 1, 4], ['bottle', 0, 3], ['casings', 0, 1], ['plank', 0, 1, 1], ['helmet', 0, 1]],
  tubes: [['tube', 2, 5, 1], ['crate', 0, 1, 1], ['ration', 0, 2]],
  sandbags: [['sandbag', 3, 6], ['plank', 0, 1, 1], ['zinc', 0, 1]],
  kit: [['helmet', 1, 1], ['carrier', 0, 1], ['pack', 1, 1, 1], ['mat', 0, 1], ['bottle', 0, 2], ['ration', 0, 2]],
  cases: [['case152', 6, 14], ['crate', 1, 2, 1]],
  shell: [['frag', 1, 2], ['branch', 0, 1, 1]],
  grad: [['gradTail', 1, 1, 1], ['frag', 1, 2]],
  mortar: [['mortarTail', 1, 1], ['frag', 0, 1]],
  house: [['sheet', 2, 6, 1], ['plank', 1, 4, 1], ['beam', 0, 2, 1], ['brick', 3, 9], ['chunk', 0, 2]],
  urban: [['chunk', 2, 6, 1], ['brick', 2, 6], ['window', 0, 1, 1], ['rebar', 0, 2, 1], ['sheet', 0, 1, 1], ['plank', 0, 2, 1]],
  wreck: [['links', 0, 1, 1], ['wheel', 0, 2, 1], ['era', 1, 4], ['frag', 1, 3], ['tyre', 0, 1, 1]],
  branches: [['branch', 2, 5, 1]],
  fpv: [['fpv', 1, 1], ['frag', 0, 1]],
  verge: [['tube', 0, 2, 1], ['crate', 0, 1, 1], ['sandbag', 0, 1], ['tyre', 0, 1, 1], ['branch', 0, 1, 1], ['jerrycan', 0, 1, 1]],
};
let grimeTex = null;
function debrisMaterial() {
  if (!grimeTex) {   // tiling grime: soft blotches, specks, scratches (multiplies the vertex colours)
    const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S; const x = cv.getContext('2d'), R = mulberry(515);
    x.fillStyle = '#e4e0d8'; x.fillRect(0, 0, S, S);
    for (let i = 0; i < 260; i++) { const px = R() * S, py = R() * S, r = 4 + R() * 28, g = x.createRadialGradient(px, py, 0, px, py, r), v = 120 + R() * 110 | 0; g.addColorStop(0, `rgba(${v},${v - 6},${v - 14},${0.18 + R() * 0.2})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { x.save(); x.translate(ox, oy); x.fillRect(px - r, py - r, r * 2, r * 2); x.restore(); } }
    for (let i = 0; i < 1800; i++) { const v = R() < 0.5 ? 70 + R() * 60 | 0 : 235; x.fillStyle = `rgba(${v},${v - 4},${v - 10},${0.25 + R() * 0.4})`; x.fillRect(R() * S, R() * S, 1 + R() * 2, 1 + R() * 2); }
    x.strokeStyle = 'rgba(250,248,240,0.25)'; for (let i = 0; i < 40; i++) { x.lineWidth = 0.5 + R(); x.beginPath(); const px = R() * S, py = R() * S; x.moveTo(px, py); x.lineTo(px + (R() - 0.5) * 40, py + (R() - 0.5) * 40); x.stroke(); }
    grimeTex = new THREE.CanvasTexture(cv); grimeTex.colorSpace = THREE.SRGBColorSpace; grimeTex.wrapS = grimeTex.wrapT = THREE.RepeatWrapping; grimeTex.anisotropy = 4;
  }
  const m = new THREE.MeshStandardMaterial({ map: grimeTex, vertexColors: true, roughness: 0.84, metalness: 0.06 }); m.name = 'bf_debris';
  return m;
}

// ================================================================ the builder
export function battlefieldDetail(w, opt = {}) {
  if (OFF) return null;
  const t0 = performance.now();
  try { build(w, opt); } catch (e) { console.warn('battlefieldDetail', e); }
  (w.buildTimes ||= {}).detail = Math.round(performance.now() - t0);
  return w.bfStats;
}
function build(w, opt) {
  geos();
  const T = w.terrain, nav = w.nav, scene = w.scene, half = MAP_SIZE / 2 - 5;
  const R = mulberry(seedOf((MAP.id || MAP.name || 'map') + ':bf:' + (MAP.seed ?? '')));
  const H = (x, z) => T.heightAt(x, z), rural = MAP.kind === 'rural';
  const crs = craters(w), crGrid = new Map(), CG = 16;
  for (const c of crs) { const k = Math.floor(c[0] / CG) * 4096 + Math.floor(c[1] / CG); (crGrid.get(k) || crGrid.set(k, []).get(k)).push(c); }
  const craterNear = (x, z, pad) => { for (let i = Math.floor((x - 20) / CG); i <= Math.floor((x + 20) / CG); i++) for (let j = Math.floor((z - 20) / CG); j <= Math.floor((z + 20) / CG); j++) for (const c of crGrid.get(i * 4096 + j) || []) if (Math.hypot(c[0] - x, c[1] - z) < c[2] + pad) return c; return null; };
  const teeth = new Map(); for (const t of T.teeth || []) { const k = Math.floor(t[0] / 8) * 4096 + Math.floor(t[1] / 8); (teeth.get(k) || teeth.set(k, []).get(k)).push(t); }
  const toothNear = (x, z, r) => { for (let i = Math.floor((x - r) / 8); i <= Math.floor((x + r) / 8); i++) for (let j = Math.floor((z - r) / 8); j <= Math.floor((z + r) / 8); j++) for (const t of teeth.get(i * 4096 + j) || []) if (Math.abs(t[0] - x) < r && Math.abs(t[1] - z) < r) return true; return false; };
  const inBuilding = (x, z, pad) => (w.buildings || []).some(b => { if (!b.toLocal) return false; const [lx, lz] = b.toLocal(x, z); return Math.abs(lx) < b.L / 2 + pad && Math.abs(lz) < b.D / 2 + pad; });
  const inMap = (x, z) => Math.abs(x) < half && Math.abs(z) < half;
  // free ground for a debris piece / wire run
  const free = (x, z, r = 0.3, road = 0.4) => inMap(x, z) && !onRoad(x, z, road + r) && T.cutSDF(x, z) > r + 0.35 && !inBuilding(x, z, r) && !(w.solidHit && w.solidHit(x, z, r, r, 0, 0.05));
  const D = new Debris(), WB = new Map(), CSW = 180;
  const wcell = (x, z) => { const i = Math.floor(x / CSW), j = Math.floor(z / CSW), k = i + ',' + j; let c = WB.get(k); if (!c) WB.set(k, c = { near: new WireBuf(), far: new WireBuf(), x: (i + 0.5) * CSW, z: (j + 0.5) * CSW }); return c; };
  const coils = [], coilCols = [], scorch = w._bfScorch || [], stats = { coils: 0, heaps: 0, fences: 0, pickets: 0, pieces: 0 }, spots = {};
  const mark = (k, x, z) => { const a = spots[k] ||= []; if (a.length < 40) a.push([Math.round(x), Math.round(z)]); };   // (a few of each, for tests / screenshots: window.__bf.spots)
  const navLine = (ax, az, bx, bz, hw, cost) => { if (!nav) return; const L = Math.hypot(bx - ax, bz - az); for (let t = 0; t <= L; t += 0.8) nav.circle(ax + (bx - ax) * t / L, az + (bz - az) * t / L, hw, cost); };

  // ---------------------------------------------------------------- pieces & clusters
  const tiltAt = (x, z, ry) => { const gx = (H(x + 0.3, z) - H(x - 0.3, z)) / 0.6, gz = (H(x, z + 0.3) - H(x, z - 0.3)) / 0.6, c = Math.cos(ry), s = Math.sin(ry); return [-Math.atan(gx * s + gz * c), Math.atan(gx * c - gz * s)]; };
  const piece = (name, x, z, far, ry = R() * TAU) => {
    const r = R; if (name === 'gradTail' || name === 'mortarTail') { const tilt = name === 'gradTail' ? 0.25 + R() * 0.6 : R() * 0.5; D.begin(x, H(x, z) - 0.02, z, ry, tilt, 0, 1, far); }
    else { const [rx, rz] = tiltAt(x, z, ry); D.begin(x, H(x, z) - 0.008, z, ry, rx, rz, 1, far); }
    PC[name](D, r); stats.pieces++;
  };
  const cluster = (kind, x, z, rad = 2.5) => {
    mark(kind, x, z);
    for (const [name, a, b, far] of MIX[kind]) {
      const n = a + Math.floor(R() * (b - a + 1));
      for (let i = 0; i < n; i++) { const d = rad * Math.sqrt(R()), an = R() * TAU, px = x + Math.cos(an) * d, pz = z + Math.sin(an) * d; if (free(px, pz, 0.25)) piece(name, px, pz, !!far); }
    }
  };
  const pickCluster = (tbl) => { let s = 0; for (const [, p] of tbl) s += p; let u = R() * s; for (const [k, p] of tbl) if ((u -= p) < 0) return k; return tbl[0][0]; };

  // ---------------------------------------------------------------- pickets / fences / coils
  const PCOL = [0x4b3123, 0x3c3832, 0x55392a];
  const picket = (x, z, h = 1.3, lean = 0.06) => {   // angle iron, driven in; returns its world matrix (for the wire ties)
    const ry = R() * TAU, rx = (R() - 0.5) * lean * 2, rz = (R() - 0.5) * lean * 2, y = H(x, z) - 0.05;
    D.begin(x, y, z, ry, rx, rz, 1, true); const c = col(pick(R, PCOL), R);
    D.box(0.0225, h / 2, 0, 0.05, h, 0.005, c); D.box(0, h / 2, 0.0225, 0.005, h, 0.05, c); stats.pickets++;
    return trs(x, y, z, ry, 1, rx, rz);
  };
  const coil = (ax, az, bx, bz, o = {}) => {   // one stretched coil instance from a to b
    const L = Math.hypot(bx - ax, bz - az); if (L < 1.2) return;
    const ang = Math.atan2(-(bz - az), bx - ax), ya = H(ax, az), yb = H(bx, bz), ym = H((ax + bx) / 2, (az + bz) / 2);
    const y = Math.min(ya, yb, ym) - 0.04 + (o.lift || 0), rz = Math.atan2(yb - ya, L) * 0.8;
    const M = trs(ax, y, az, ang, 1, 0, rz).multiply(new THREE.Matrix4().makeScale(L / COIL_L, o.sy ?? (0.88 + R() * 0.16), o.sz ?? (0.92 + R() * 0.14)));
    coils.push(M); coilCols.push(new THREE.Color(Math.min(1, Math.max(0, o.rust ?? R() * 0.5)), o.crush ?? (R() < 0.12 ? 0.35 + R() * 0.45 : R() * 0.12), o.tear ?? 0)); stats.coils++;
  };
  // barbed-wire strands between two pickets (tie heights along each picket); a snapped strand hangs to the ground
  const STRAND = [0.22, 0.52, 0.82, 1.12];
  const strands = (MA, MB, rust) => {
    const c = wcell(MA.elements[12], MA.elements[14]), cl = [rust, 0, 0], v = new THREE.Vector3();
    for (const h of STRAND) {
      const A = v.set(0, h, 0).applyMatrix4(MA).toArray(), B = new THREE.Vector3(0, h, 0).applyMatrix4(MB).toArray(), sag = 0.03 + R() * 0.05;
      if (R() < 0.07) {   // snapped
        for (const [P, Q] of [[A, B], [B, A]]) { const f = 0.3 + R() * 0.25, ex = P[0] + (Q[0] - P[0]) * f, ez = P[2] + (Q[2] - P[2]) * f, pts = [], pf = [];
          for (let k = 0; k <= 8; k++) { const t = k / 8, gy = H(P[0] + (ex - P[0]) * t, P[2] + (ez - P[2]) * t) + 0.02; const p = [P[0] + (ex - P[0]) * t, Math.max(gy, P[1] + (gy - P[1]) * Math.pow(t, 0.7)), P[2] + (ez - P[2]) * t]; pts.push(p); if (k % 2 === 0) pf.push(p); }
          c.near.curve(pts, 0.0065, 1, cl); c.far.curve(pf, 0.01, 1, cl); }
        continue;
      }
      const pts = [], pf = []; for (let k = 0; k <= 10; k++) { const t = k / 10, p = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t - sag * 4 * t * (1 - t), A[2] + (B[2] - A[2]) * t]; pts.push(p); if (k % 5 === 0) pf.push(p); }
      c.near.curve(pts, 0.0065, 1, cl); c.far.curve(pf, 0.01, 1, cl);
    }
  };
  const fence = (pts, rust) => {   // pts: [[x, z], ...] valid run (>= 2 points ~3 m apart)
    let prev = null;
    for (const [x, z] of pts) { const M = picket(x, z, 1.32 + R() * 0.12, R() < 0.05 ? 0.5 : 0.07); if (prev) strands(prev, M, Math.min(1, rust + (R() - 0.5) * 0.15)); prev = M; }
    for (let i = 1; i < pts.length; i++) navLine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], 0.5, 3);
    stats.fences++;
  };
  // walk a polyline at 0.5 m, split into valid runs (>= minRun m)
  const runsOf = (poly, ok, minRun = 3) => {
    const out = []; let cur = [];
    for (let i = 1; i < poly.length; i++) {
      const [ax, az] = poly[i - 1], [bx, bz] = poly[i], L = Math.hypot(bx - ax, bz - az);
      for (let t = i === 1 ? 0 : 0.5; t <= L; t += 0.5) { const x = ax + (bx - ax) * t / L, z = az + (bz - az) * t / L; if (ok(x, z)) cur.push([x, z]); else { if (cur.length * 0.5 >= minRun) out.push(cur); cur = []; } }
    }
    if (cur.length * 0.5 >= minRun) out.push(cur);
    return out;
  };
  const beltOk = (x, z) => inMap(x, z) && !onRoad(x, z, 2.2) && T.cutSDF(x, z) > 1.8 && !inBuilding(x, z, 1.2) && !(w.solidHit && w.solidHit(x, z, 0.5, 0.5, 0, 0.1)) && !(w.nearTrail && w.nearTrail(x, z, 1.5)) && !toothNear(x, z, 1.4) && !craterNear(x, z, -0.2);
  // lay a belt along a valid run: style 1 single coil, 2 double, 3 triple concertina
  const belt = (run, style, rust0) => {
    const L = run.length * 0.5, offs = style === 1 ? [[0, 0]] : style === 2 ? [[-0.5, 0], [0.5, 0.5]] : [[-0.5, 0], [0.5, 0.33], [0, 0.66]];
    const at = s => { const i = Math.min(run.length - 1, Math.max(0, Math.round(s / 0.5))); return run[i]; };
    const dir = s => { const a = at(Math.max(0, s - 1)), b = at(Math.min(L, s + 1)); const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
    offs.forEach(([lat, stag], row) => {
      let s = row && L > 12 ? (stag * 9) % 9 : 0;
      if (s > 0) { const a = at(0), b = at(s), [ux, uz] = dir(s / 2); coil(a[0] - uz * lat, a[1] + ux * lat, b[0] - uz * lat, b[1] + ux * lat, { rust: rust0 + (R() - 0.5) * 0.2, lift: row === 2 ? 0.66 : 0, sy: row === 2 ? 0.9 : undefined }); }
      while (s < L - 1.2) {
        let e = Math.min(L, s + 7 + R() * 4); if (L - e < 3) e = L;
        const a = at(s), b = at(e), [ux, uz] = dir((s + e) / 2), ax = a[0] - uz * lat, az = a[1] + ux * lat, bx = b[0] - uz * lat, bz = b[1] + ux * lat;
        // torn where a shell landed beside it, or breached; otherwise random
        let tear = 0; const cr = craterNear((ax + bx) / 2, (az + bz) / 2, 2.5 + (e - s) / 2);
        if (cr) { const t = ((cr[0] - ax) * (bx - ax) + (cr[1] - az) * (bz - az)) / ((e - s) * (e - s)); if (t > 0.1 && t < 0.9) tear = t; }
        if (!tear && R() < 0.07) tear = 0.2 + R() * 0.6;
        coil(ax, az, bx, bz, { rust: Math.min(1, Math.max(0, rust0 + (R() - 0.5) * 0.25)), tear, lift: row === 2 ? 0.66 : 0, sy: row === 2 ? 0.9 : undefined, crush: row === 2 ? R() * 0.15 : undefined });
        s = e;
      }
    });
    // pickets: single coil -- screw pickets through it every ~4 m; double / triple -- two rows outside the coils
    const rows = style === 1 ? [0] : [-1.0, 1.0];
    rows.forEach((lat, ri) => { for (let s = ri * 1.6 + 0.5; s < L; s += style === 1 ? 4 : 3.2) { const p = at(s), [ux, uz] = dir(s); picket(p[0] - uz * lat, p[1] + ux * lat, style === 1 ? 1.15 : 1.3, R() < 0.06 ? 0.45 : 0.08); } });
    for (let s = 0; s < L; s += 1) { const p = at(s); if (nav) nav.circle(p[0], p[1], style === 1 ? 0.6 : 1.1, 3); }
  };

  // ---------------------------------------------------------------- 1. wire belts in front of the positions
  const systems = w.trenchSystems || [];
  for (const sy of systems) {
    const fl = Math.hypot(sy.front[0], sy.front[1]) || 1, fx = sy.front[0] / fl, fz = sy.front[1] / fl, sx = -fz, sz = fx;
    const pts = [...(sy.lines || []).flat(), ...(sy.slots || []).map(s => [s.x, s.z])]; if (pts.length < 2) continue;
    // profile across the front: most forward trench point per 4 m bin of the lateral coordinate
    const bins = new Map(); let lo = 1e9, hi = -1e9;
    for (const [x, z] of pts) { const s = x * sx + z * sz, f = x * fx + z * fz, b = Math.floor(s / 4); bins.set(b, Math.max(bins.get(b) ?? -1e9, f)); lo = Math.min(lo, b); hi = Math.max(hi, b); }
    const kind = sy.kind || 'line', style = kind === 'line' ? 3 : kind === 'outpost' ? 1 : 2, d0 = kind === 'line' ? 13 : kind === 'outpost' ? 13 : 18;   // (lines: between the trench and the dragon's-teeth rows 23 m out)
    const ext = kind === 'outpost' ? 3 : 4, rust0 = R() * 0.55, prof = [];
    for (let b = lo - ext; b <= hi + ext; b++) {
      let f = bins.get(b);
      if (f == null) { let l = null, r = null; for (let k = 1; k < 8 && (l == null || r == null); k++) { if (l == null && bins.has(b - k)) l = [k, bins.get(b - k)]; if (r == null && bins.has(b + k)) r = [k, bins.get(b + k)]; } f = l && r ? (l[1] * r[0] + r[1] * l[0]) / (l[0] + r[0]) : (l || r)?.[1]; if (f == null) continue; if (b < lo || b > hi) f -= (b < lo ? lo - b : b - hi) * 4 * 0.75; }   // wings bend back
      prof.push([b, f]);
    }
    for (let it = 0; it < 3; it++) for (let i = 1; i < prof.length - 1; i++) prof[i][1] = Math.max(prof[i][1], (prof[i - 1][1] + prof[i + 1][1]) / 2);   // no pockets between bays
    // split where the profile has a hole (separate trench groups): no wire across the gap
    const parts = []; for (const e of prof) { const P = parts[parts.length - 1]; if (P && e[0] - P[P.length - 1][0] === 1) P.push(e); else parts.push([e]); }
    const fenceOn = style >= 2 && R() < 0.65;
    for (const part of parts) {
      if (part.length < 2) continue;
      const poly = part.map(([b, f]) => { const s = (b + 0.5) * 4, d = d0 + (hash2(b, sy.id ?? 0, 3) - 0.5) * 4; return [sx * s + fx * (f + d), sz * s + fz * (f + d)]; });
      for (const run of runsOf(poly, beltOk, 3)) { belt(run, style, rust0); mark('belt' + style, run[run.length >> 1][0], run[run.length >> 1][1]); }
      // a barbed-wire fence behind the concertina (lines / strongpoints)
      if (fenceOn) {
        const fp = part.map(([b, f]) => { const s = (b + 0.5) * 4, d = d0 - 5 + (hash2(b, sy.id ?? 0, 4) - 0.5) * 2; return [sx * s + fx * (f + d), sz * s + fz * (f + d)]; });
        for (const run of runsOf(fp, beltOk, 6)) { const sp = []; for (let i = 0; i < run.length; i += 6) sp.push(run[i]); if (sp.length >= 2) fence(sp, Math.min(1, rust0 + 0.2)); }
      }
    }
  }
  // ---------------------------------------------------------------- 2. coils behind the rows of dragon's teeth
  for (const f of MAP.fortifications || []) {
    if (f.type !== 'teeth' || !f.pts || f.pts.length < 2) continue;
    const [a, b] = [f.pts[0], f.pts[f.pts.length - 1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L;
    // on the attackers' side of the rows (away from the nearest trench system): wire in front of the teeth
    let side = 1, bd = 1e9; const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    for (const sy of systems) { const d = Math.hypot(sy.center[0] - mx, sy.center[1] - mz); if (d < bd) { bd = d; side = -Math.sign((sy.center[0] - mx) * nx + (sy.center[1] - mz) * nz) || 1; } }
    const off = ((f.rows || 1) * 1.6 + 3.5) * side, poly = f.pts.map(p => [p[0] + nx * off, p[1] + nz * off]);
    for (const run of runsOf(poly, beltOk, 3)) belt(run, 1, 0.25 + R() * 0.4);
  }
  // ---------------------------------------------------------------- 3. check points: wire over the hedgehog rows, run out over the verges
  const hogs = [];
  for (const P of PLACED) if (/hedgehog/i.test(P.template?.name || '')) for (const M of P.matrices) hogs.push([M.elements[12], M.elements[14]]);
  const used = new Set(), groups = [];
  for (let i = 0; i < hogs.length; i++) { if (used.has(i)) continue; const g = [i]; used.add(i); for (let q = 0; q < g.length; q++) for (let j = 0; j < hogs.length; j++) if (!used.has(j) && Math.hypot(hogs[j][0] - hogs[g[q]][0], hogs[j][1] - hogs[g[q]][1]) < 5.5) { used.add(j); g.push(j); } if (g.length >= 2) groups.push(g.map(k => hogs[k])); }
  const checkpoints = [];
  for (const g of groups) {
    let a = g[0], b = g[1], best = 0; for (const p of g) for (const q of g) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d > best) { best = d; a = p; b = q; } }
    const L = best || 1, ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, rust = 0.2 + R() * 0.5;
    { const n = Math.max(1, Math.round((L + 1.6) / 8)), x0 = a[0] - ux * 0.8, z0 = a[1] - uz * 0.8, st = (L + 1.6) / n;   // draped over the hedgehogs (coils of <= ~9 m)
      for (let i = 0; i < n; i++) coil(x0 + ux * st * i, z0 + uz * st * i, x0 + ux * st * (i + 1), z0 + uz * st * (i + 1), { lift: 0.38, sy: 0.85, crush: 0.15 + R() * 0.2, rust }); }
    for (const [p, sd] of [[a, -1], [b, 1]]) {   // out over the verge, beside the carriageway
      const poly = [[p[0] + ux * sd * 1.5, p[1] + uz * sd * 1.5], [p[0] + ux * sd * (9 + R() * 7), p[1] + uz * sd * (9 + R() * 7)]];
      for (const run of runsOf(poly, beltOk, 2.5)) belt(run, 1, rust);
    }
    checkpoints.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ux, uz]); mark('checkpoint', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  // ---------------------------------------------------------------- 4. heaps of wire, unused rolls, loose torn coils
  const heap = (x, z, kind) => {
    if (!free(x, z, 1.4, 1.5)) return false;
    const seed = R() * 1e9 | 0, ry = R() * TAU, y0 = H(x, z), c = wcell(x, z), rust = R() * 0.7, cl = [rust, 0, 0];
    for (const lod of [0, 1]) {
      const r = mulberry(seed), curves = [], S = 0.8 + r() * 0.6, samples = lod ? 9 : 22, every = lod ? 2 : 1, hw = lod ? 0.02 : 0.012, buf = lod ? c.far : c.near;
      if (kind !== 'rolls') {   // tangle: pulled-up coil fragments, any which way, slumped into a mound
        const nf = 5 + (r() * 5 | 0);
        for (let f = 0; f < nf; f++) {
          const fr = coilPts(r, 3 + (r() * 9 | 0), 0.28 + r() * 0.2, 0.05 + r() * 0.16, samples, every, []), ax = (r() - 0.5) * 1.6, ay = r() * TAU, cx = (r() - 0.5) * 1.6 * S, cy = 0.15 + r() * 0.5, cz = (r() - 0.5) * 1.1 * S, bend = (r() - 0.5) * 0.5;
          for (const pts of fr) curves.push([pts.map(p => { const q = rotP([p[0] - 0.4, p[1] + bend * p[0] * p[0], p[2]], ax, ay); return [q[0] + cx, q[1] + cy, q[2] + cz]; }), true]);
        }
      }
      if (kind !== 'tangle') {   // packed rolls (closed coils, ~0.5 m long), lying or stood on end; a third one on top of the first
        const nr = 1 + (r() * 3 | 0), at = [];
        for (let q = 0; q < nr; q++) {
          const up = q < 2 ? r() < 0.4 : at[0][2], ay = r() * TAU, ox = q === 2 ? at[0][0] : (r() - 0.5) * 1.6 + (kind === 'rolls' ? q * 1.1 - 0.5 : 1.6), oz = q === 2 ? at[0][1] : (r() - 0.5) * 1.2;
          at.push([ox, oz, up]);
          const fr = coilPts(r, 20, 0.45, 0.026, samples, lod ? 4 : 2, []), lift = q === 2 ? (up ? 0.52 : 0.88) : 0;
          for (const pts of fr) curves.push([pts.map(p => { const q2 = up ? [p[1], p[0], p[2]] : [p[0] - 0.26, p[1], p[2]], rr = rotP(q2, 0, ay); return [rr[0] + ox, rr[1] + (up ? 0.02 : 0.45) + lift, rr[2] + oz]; }), false]);
        }
      }
      const cr = Math.cos(ry), sr = Math.sin(ry);
      for (const [pts, squash] of curves) {
        buf.curve(pts.map(([px, py, pz]) => {
          const d2 = (px * px) / (1.5 * S * 1.5 * S) + (pz * pz) / (1.1 * S * 1.1 * S), dome = 0.95 * S * Math.max(0, 1 - d2);
          if (py > dome && squash) py = dome + (py - dome) * 0.25;
          const wx = x + px * cr + pz * sr, wz = z - px * sr + pz * cr, g = H(wx, wz);
          let wy = y0 + py; if (wy < g + 0.02) wy = g + 0.02 + (wy - g - 0.02) * 0.1;
          return [wx, Math.max(g + 0.012, wy), wz];
        }), hw * (kind === 'rolls' || every > 1 ? 1.4 : 1), 0, cl);
      }
    }
    if (nav) nav.circle(x, z, 1.5, 4);
    mark('heap', x, z); stats.heaps++; return true;
  };
  const loose = (x, z) => {   // a torn coil lying in the grass: a few metres of loops, flattened, along a bent line
    if (!free(x, z, 1, 1)) return;
    const seed = R() * 1e9 | 0, ry = R() * TAU, c = wcell(x, z), cl = [0.3 + R() * 0.5, 0, 0];
    for (const lod of [0, 1]) {
      const r = mulberry(seed), n = 8 + (r() * 14 | 0), sp = 0.2 + r() * 0.15, fr = coilPts(r, n, 0.42, sp, lod ? 9 : 22, lod ? 2 : 1, []), bend = (r() - 0.5) * 1.6, Lf = n * sp;
      for (const pts of fr) (lod ? c.far : c.near).curve(pts.map(p => {
        const u = p[0] / Lf, y = p[1] * (0.45 + 0.2 * Math.sin(u * 9)) + 0.2, zz = p[2] + bend * Math.sin(u * Math.PI) * 1.5, px = p[0] - Lf / 2;
        const wx = x + px * Math.cos(ry) + zz * Math.sin(ry), wz = z - px * Math.sin(ry) + zz * Math.cos(ry), g = H(wx, wz); return [wx, Math.max(g + 0.012, g + y), wz];
      }), lod ? 0.02 : 0.012, 0, cl);
    }
    if (nav) nav.circle(x, z, 1.2, 3);
  };
  for (const sy of systems) {
    const fl = Math.hypot(sy.front[0], sy.front[1]) || 1, fx = sy.front[0] / fl, fz = sy.front[1] / fl, line = (sy.lines || []).flat();
    const nH = sy.kind === 'line' ? 2 + (R() * 2 | 0) : 1 + (R() < 0.5 ? 1 : 0);
    for (let k = 0, tries = 0; k < nH && tries < 12; tries++) {
      const base = sy.dugouts?.length && R() < 0.5 ? (() => { const d = pick(R, sy.dugouts); return [d.x, d.z]; })() : line.length ? pick(R, line) : sy.center, back = 6 + R() * 14;
      if (heap(base[0] - fx * back + (R() - 0.5) * 8, base[1] - fz * back + (R() - 0.5) * 8, R() < 0.25 ? 'rolls' : R() < 0.5 ? 'tangle' : 'mix')) k++;
    }
    const nL = sy.kind === 'outpost' ? 1 : 2 + (R() * 2 | 0);
    for (let k = 0; k < nL && line.length; k++) { const p = pick(R, line), d = 5 + R() * 14; loose(p[0] + fx * d + (R() - 0.5) * 10, p[1] + fz * d + (R() - 0.5) * 10); }
  }
  for (const [x, z, ux, uz] of checkpoints) {
    for (const sd of [-1, 1]) { const o = 6 + R() * 4; if (R() < 0.55) heap(x - uz * o * sd + ux * (R() - 0.5) * 6, z + ux * o * sd + uz * (R() - 0.5) * 6, R() < 0.5 ? 'rolls' : 'mix'); }
    // the post: sandbags, crates, tubes
    for (let k = 0; k < 2; k++) { const sd = R() < 0.5 ? -1 : 1, o = 5 + R() * 6; cluster(k ? 'litter' : pickCluster([['sandbags', 1], ['tubes', 1], ['litter', 1]]), x - uz * o * sd + ux * (R() - 0.5) * 8, z + ux * o * sd + uz * (R() - 0.5) * 8, 2.5); }
  }
  // ---------------------------------------------------------------- 5. debris
  // at the positions: behind the lines and along the parapets
  const POS = [['litter', 0.34], ['sandbags', 0.14], ['tubes', 0.14], ['kit', 0.1], ['cases', 0.06], ['fpv', 0.08], ['shell', 0.08], ['mortar', 0.06]];
  for (const sy of systems) {
    const fl = Math.hypot(sy.front[0], sy.front[1]) || 1, fx = sy.front[0] / fl, fz = sy.front[1] / fl, line = (sy.lines || []).flat();
    const n = sy.kind === 'line' ? 11 : sy.kind === 'outpost' ? 5 : 7;
    for (let k = 0; k < n; k++) {
      const p = line.length ? pick(R, line) : sy.center, rear = R() < 0.65, d = rear ? -(3 + R() * 16) : 1.5 + R() * 3;
      cluster(pickCluster(POS), p[0] + fx * d + (R() - 0.5) * 6, p[1] + fz * d + (R() - 0.5) * 6, 2.2);
    }
  }
  // shell fall: fragments / tails round the craters in the hot zones, Grad salvos across the shelled fields
  let nCr = 0;
  for (const c of crs) {
    if (nCr > 260) break; const h = heatAt(w, c[0], c[1]); if (h < 0.3 || R() > 0.17 * h) continue;
    const a = R() * TAU, d = c[2] * (1.1 + R() * 0.5), x = c[0] + Math.cos(a) * d, z = c[1] + Math.sin(a) * d;
    cluster(R() < 0.15 ? (rural ? 'grad' : 'mortar') : R() < 0.2 ? 'mortar' : 'shell', x, z, 1.4); nCr++;
  }
  const nField = Math.round(MAP_SIZE * MAP_SIZE / (rural ? 5200 : 9000));
  for (let i = 0, made = 0; i < nField && made < (rural ? 150 : 40); i++) {
    const x = (R() - 0.5) * MAP_SIZE * 0.96, z = (R() - 0.5) * MAP_SIZE * 0.96, h = heatAt(w, x, z);
    if (h < 0.4 || R() > h * 0.55) continue;
    const salvo = rural && R() < 0.7 ? 1 + (R() * 3 | 0) : 1;
    for (let k = 0; k < salvo; k++) { const px = x + (R() - 0.5) * 18, pz = z + (R() - 0.5) * 18; if (free(px, pz, 0.4)) { piece(rural ? 'gradTail' : 'mortarTail', px, pz, true); scorch.push([px, pz, 1.4 + R(), 0.35]); if (R() < 0.6) cluster('shell', px, pz, 1.2); } }
    made++;
  }
  // knocked-out armour: track runs, road wheels, ERA tiles, fragments
  for (const [x, z] of w.wreckSpots || []) for (let k = 0; k < 2 + (R() * 2 | 0); k++) { const a = R() * TAU, d = 4 + R() * 6; cluster(R() < 0.15 ? 'fpv' : 'wreck', x + Math.cos(a) * d, z + Math.sin(a) * d, 2.5); }
  // wrecked / burnt houses: roof sheets, timber, bricks (panel blocks: concrete, rebar, window frames)
  const houses = [];
  for (const [x, z, d] of w.houseSpots || []) if (d) houses.push([x, z, 6]);
  for (const [x, z, r] of w.burntSpots || []) if (r <= 10) houses.push([x, z, r * 0.7 + 3]);
  for (const [x, z, r] of houses) for (let k = 0; k < 2 + (R() * 3 | 0); k++) { const a = R() * TAU, d = r + R() * 4; cluster('house', x + Math.cos(a) * d, z + Math.sin(a) * d, 2.6); }
  for (const b of w.buildings || []) {
    if (!b.toWorld || !b.panels) continue;
    const dmg = b.panels.filter(p => p.state >= 2).length; if (!dmg && !b.pancaked && !b.collapsedCorner) continue;
    const n = Math.min(6, 1 + Math.round(dmg / 6) + (b.pancaked ? 2 : 0) + (b.collapsedCorner ? 1 : 0));
    for (let k = 0; k < n; k++) { const side = R() * 4 | 0, u = (R() - 0.5) * 0.9, o = 2.5 + R() * 5, p = side < 2 ? b.toWorld(u * b.L, 0, (side ? 1 : -1) * (b.D / 2 + o)) : b.toWorld((side === 2 ? 1 : -1) * (b.L / 2 + o), 0, u * b.D); cluster(R() < 0.7 ? 'urban' : 'house', p.x, p.z, 2.4); }
  }
  // road verges in the hot zones
  for (const r of ROADS || []) {
    if (!r || r.x0 == null) continue; const horiz = (r.x1 - r.x0) > (r.z1 - r.z0), len = horiz ? r.x1 - r.x0 : r.z1 - r.z0;
    for (let t = 6; t < len; t += 14) {
      const cx = horiz ? r.x0 + t : (r.x0 + r.x1) / 2, cz = horiz ? (r.z0 + r.z1) / 2 : r.z0 + t; if (!inMap(cx, cz)) continue;
      const h = heatAt(w, cx, cz); if (h < 0.45 || R() > 0.3 * h) continue;
      const sd = R() < 0.5 ? -1 : 1, o = (horiz ? r.z1 - r.z0 : r.x1 - r.x0) / 2 + 1.8 + R() * 2.5;
      cluster('verge', horiz ? cx : cx + sd * o, horiz ? cz + sd * o : cz, 1.6);
    }
  }
  // fallen branches under the shelled / stripped trees; a stump or two by the bare city trees
  const treeAt = [];
  for (const P of PLACED) { const n = P.template?.name || ''; if (!/^(tree_|leafy_summer_|stump_)/.test(n) || /_lod\d*$|_mid$/.test(n)) continue; const sh = /shattered|shelled|stump|stripped|broken|snapped/.test(n); for (const M of P.matrices) treeAt.push([M.elements[12], M.elements[14], sh]); }
  let nBr = 0;
  for (const [x, z, sh] of treeAt) {
    if (nBr > 320) break; const h = heatAt(w, x, z), p = sh ? 0.12 + 0.3 * h : h > 0.45 ? 0.12 * h : 0; if (!p || R() > p) continue;
    const a = R() * TAU, d = 1.5 + R() * 4; cluster('branches', x + Math.cos(a) * d, z + Math.sin(a) * d, 2.2); nBr++;
    if (sh && R() < 0.2) scorch.push([x, z, 2.5 + R() * 2, 0.3]);
  }
  // tops of the snapped belt trees (treeFate), lying beside their stumps
  for (const [x, z] of w._bfTops || []) mark('stump', x, z);
  for (const [x, z, a, k] of w._bfTops || []) { const px = x + Math.cos(a) * 0.4, pz = z + Math.sin(a) * 0.4; if (T.cutSDF(px, pz) < 1) continue; D.begin(px, H(px, pz) - 0.03, pz, -a, 0, (R() - 0.5) * 0.06, 1, true); PC.log(D, R, k); stats.pieces++; }
  // ---------------------------------------------------------------- 6. scorched patches (war map scorch channel)
  for (let i = 0, made = 0; i < 900 && made < (rural ? 90 : 30); i++) { const x = (R() - 0.5) * MAP_SIZE * 0.95, z = (R() - 0.5) * MAP_SIZE * 0.95, h = heatAt(w, x, z); if (h < 0.5 || R() > h * 0.5 || onRoad(x, z, 1)) continue; scorch.push([x, z, 2 + R() * 5, 0.3 + R() * 0.35]); made++; }
  paintScorch(w, scorch);

  // ---------------------------------------------------------------- 7. meshes
  const [mI, mV] = wireMats();
  if (coils.length) {
    const t = [0, 1, 2].map(l => { const m = new THREE.Mesh(coilGeo(l), mI); m.name = 'bf_concertina' + (l ? '_lod' + l : ''); return m; });
    instance(scene, t[0], coils, { mid: t[1], lod: t[2], nearDist: 35, lodDist: 110, cullDist: 460, shadows: false, colors: coilCols, cell: 120 });
    for (const [ms] of PLACED[PLACED.length - 1].parts) for (const m of ms) pixHook(m);
  }
  const lodCell = (near, far, cx, cz, CS, d1, d2) => { LODS.push({ near: near ? [near] : [], mid: null, far: far ? [far] : [], cx, cz, dm: d1, d1, d2, state: -1, hr: CS * 0.5 }); };
  let wireMeshes = 0;
  for (const c of WB.values()) {
    const mk = (b, nm) => { if (b.empty) return null; const m = new THREE.Mesh(b.geo(), mV); m.name = nm; m.castShadow = false; m.receiveShadow = true; m.matrixAutoUpdate = false; m.visible = false; pixHook(m); scene.add(m); wireMeshes++; return m; };
    lodCell(mk(c.near, 'bf_wire_near'), mk(c.far, 'bf_wire_far'), c.x, c.z, CSW, 40, 430);
  }
  const dm = debrisMaterial(); let debrisMeshes = 0, debrisTris = 0;
  for (const c of D.cells.values()) {
    const mk = (b, nm, shadow) => {
      if (!b.i.length) return null; const g = new THREE.BufferGeometry(), nv = b.p.length / 3;
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2));
      g.setIndex(new THREE.BufferAttribute(nv > 65535 ? new Uint32Array(b.i) : new Uint16Array(b.i), 1)); g.computeBoundingSphere();
      const m = new THREE.Mesh(g, dm); m.name = nm; m.castShadow = shadow; m.receiveShadow = true; m.matrixAutoUpdate = false; m.visible = false; scene.add(m); if (shadow) markStatic(m);
      debrisMeshes++; debrisTris += b.i.length / 3; return m;
    };
    lodCell(mk(c.near, 'bf_debris_near', true), mk(c.far, 'bf_debris_far', false), c.x, c.z, D.CS, 50, 360);
  }
  Object.assign(stats, { spots, wireMeshes, debrisMeshes, debrisTris: Math.round(debrisTris), cells: D.cells.size, scorch: scorch.length });
  w.bfStats = stats;
  if (typeof window !== 'undefined') window.__bf = stats;
}
// add soft, ragged scorch into the war map's R channel (wear.js paintWar data) and re-upload it
function paintScorch(w, spots) {
  const d = w.warData, N = w.warN; if (!d || !N || !spots.length) return;
  const k = N / MAP_SIZE;
  for (const [x, z, r, a] of spots) {
    const ci = (x / MAP_SIZE + 0.5) * N, cj = (z / MAP_SIZE + 0.5) * N, rr = r * k + 1;
    for (let j = Math.max(0, Math.floor(cj - rr)); j <= Math.min(N - 1, Math.ceil(cj + rr)); j++) for (let i = Math.max(0, Math.floor(ci - rr)); i <= Math.min(N - 1, Math.ceil(ci + rr)); i++) {
      const dd = Math.hypot(i + 0.5 - ci, j + 0.5 - cj) / rr; if (dd >= 1) continue;
      const p = (j * N + i) * 4; d[p] = Math.min(255, d[p] + a * (1 - dd * dd) * (0.6 + 0.4 * hash2(i, j, 5)) * 255);
    }
  }
  const t = w.groundUniforms?.tWar?.value; if (t && t.image?.data === d) t.needsUpdate = true;
}
