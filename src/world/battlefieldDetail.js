// Battlefield detail: razor-wire obstacles, war debris and shell-damaged foliage, placed from the finished layout of any
// map (trench systems, craters, wrecks, burnt / destroyed houses, check points, the war map of wear.js).
//
// Modelled on the 2023-25 photo / drone record of the Zaporizhzhia and Donbas fronts (and NOT on WW1 wire: no long
// multi-strand barbed fences on rows of pickets across the fields):
//  - wire: stretched BTO-22 / "Egoza" concertina (0.9 m coils, blades 22 mm long every 35 mm round a 2.5 mm core,
//    clipped so the stretched loops form the diamond lattice), laid on the ground and staked down at the coil joints:
//    one or two coils side by side 13-17 m in front of the fire trenches (single at squad outposts), ends bent back round
//    the flanks; a coil in front of the rows of dragon's teeth (the Surovikin-line belts); run out over the verges from
//    the hedgehog road blocks; heaps of pulled-up wire and unused rolls at the engineers' dump by a dugout and at the
//    check-point posts; torn lengths dragged off and dropped between the belt and the trench.  Coils are torn by shell
//    hits beside them (gaps, sprung ends lying low), the ends of every stretch sprung, a few crushed flat; each coil is
//    fitted to the ground under it (no floating ends: broken ground gets shorter coils, or a gap) and every belt, heap
//    and stake keeps clear of roads, tracks, trenches and their spoil, teeth, hedgehogs, wrecks, buildings, trees,
//    bushes, crater bowls and each other (nav grid + solids + own occupancy grid).
//  - debris, as cause-and-effect groups rather than a sprinkle: sandbag rows on the parapet lip, spent cases and empty
//    tins thrown out of the MG pits and bays, crates / tins / tubes / kit stacked by the dugout doors, a trail of
//    rations, bottles and tins along the communication trenches, spent AT tubes where the team fired from a flank, a
//    shot-down FPV drone in front; fragments and clods of thrown soil round the crater rims, Grad motors stuck in a few
//    big craters, mortar tails in small ones; the thrown track lying out behind a knocked-out tank in line with the hull,
//    road wheels by it, ERA tiles round the turret ring; bricks / timber on the side of a ruined house the shell came
//    from and its roof sheets blown downwind; window frames, slabs and rebar under each blown-out panel of the blocks;
//    fallen branches only under shelled trees.
//  - foliage (farmland belts, via treeFate() / treeTilt(), called by farmland.js treelines() while it places them):
//    stripped trees (the leafy templates minus their foliage -- what world/treeDamage.js leaves after a barrage), a
//    third of them leaning; snapped low (stump + top lying beside it), snapped high (broken trunk still standing),
//    uprooted (root plate) -- every fall away from the burst that did it, +-50 deg; charred shrubs; scorched patches
//    painted into the war map's scorch channel.
//
// Rendering (all static, built once):
//  - concertina: ONE instanced coil template (3 LODs: 36 / 18 / 7 samples per loop, the far one every third loop) with
//    per-instance crush / tear / rust in the instance colour, read by the wire shader (no per-variant templates);
//  - heaps, rolls, loose coils: merged per 180 m cell (near + far copy), same wire material;
//  - wire material: camera-facing ribbons expanded in the vertex shader, never thinner than ~1 px (phone-wire AA: wider
//    and fainter instead, so belts read as the grey haze they are at 200 m, without shimmer); blade / barb outline cut in
//    the fragment shader from the arc length (fading to its mean coverage when a blade is under a pixel); cylinder normal
//    across the ribbon, zinc / rust from the per-instance rust and noise, Kajiya-Kay glint along the wire + random blade
//    flats flashing; alpha-blended, no depth write (no AO / depth artefacts), no shadow;
//  - debris + stakes: one opaque vertex-coloured material (grime map, dent / scratch normal map, roughness map, per-vertex
//    metalness / roughness), merged per 180 m cell (near: all,
//    far: the big pieces), near copy in the static shadow cache;
//  - every cell registered in instancer.js LODS (updateLods switches near / far / off).
// Gameplay: wire belts are a men-only obstacle (nav.wire, WIRE_COST: routes on foot go through the passages left every
// 22-38 m, the gaps where a coil would not sit on the ground, and torn coils); vehicles ignore wire and press a coil
// flat when they cross it (City.crushCheck -> it.wire: instance crush colour, the cells become a lane; synced as the
// fences are, net/battle.js 'ck').  Heaps of rolls cost 4 for everyone.  Debris is decorative, and no piece may reach
// into / over a trench or float (fits(): rolled back otherwise).  Everything deterministic per map (own RNG from the map id: no draw from world.rng).
import * as THREE from 'three';
import { MAP, MAP_SIZE, onRoad, mulberry } from './city.js';
import { instance, trs, LODS, PLACED, simplified } from './instancer.js';
import { WIRE_COST } from './nav.js';
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
// which way a shelled tree goes: away from the nearest crater within ~25 m (else the nearest fire hotspot / position
// within ~150 m), +- ~50 deg; nothing near: any way (position hash)
function fallDir(w, x, z) {
  const G = w._bfCrG ||= (() => { const m = new Map(); for (const c of craters(w)) { const k = Math.floor(c[0] / 16) * 4096 + Math.floor(c[1] / 16); (m.get(k) || m.set(k, []).get(k)).push(c); } return m; })();
  let best = null, bd = 25;
  for (let i = Math.floor((x - 25) / 16); i <= Math.floor((x + 25) / 16); i++) for (let j = Math.floor((z - 25) / 16); j <= Math.floor((z + 25) / 16); j++) for (const c of G.get(i * 4096 + j) || []) { const d = Math.hypot(c[0] - x, c[1] - z) - c[2]; if (d < bd && d > 0.3) { bd = d; best = c; } }
  if (!best) { bd = 150; for (const [hx, hz] of w.hotspots || []) { const d = Math.hypot(hx - x, hz - z); if (d < bd && d > 3) { bd = d; best = [hx, hz]; } } }
  const spread = (hash2(x, z, 22) - 0.5) * 1.8;
  return best ? Math.atan2(z - best[1], x - best[0]) + spread : hash2(x, z, 23) * TAU;
}
// farmland.js treelines(): the template to place for a belt tree / bush at (x, z), by the shelling intensity and a
// position hash (no world.rng draw):
//  - unchanged (leafy), stripped (leaves blown off; some leaning, treeTilt()), charred shrub;
//  - snapped low: a stump, the top lying beside it (merged log, the detail step); snapped high: a broken trunk still
//    standing (trees.glb tree_poplar_broken / tree_birch_snapped), a shorter top beside it; uprooted: the whole tree
//    down with its root plate (fallen_trunk), nothing left standing (returns null: farmland's put() skips it).
// Every fall goes away from the burst that did it (fallDir), so a shelled stretch reads as one event, not a pattern.
export function treeFate(w, name, x, z) {
  if (OFF || !w.tpl || !w.put) return name;
  const h = heatAt(w, x, z); if (h < 0.3) return name;
  const u = hash2(x, z, 11);
  if (/^bush_[ab]$/.test(name)) { if (u < sstep(0.35, 0.95, h) * 0.7) { const n = charredTpl(w, 'bush_a'); if (n) { (w._bfScorch ||= []).push([x, z, 2.6, 0.45]); return n; } } return name; }
  const sp = SHATTER[name]; if (!sp) return name;
  const pSnap = sstep(0.5, 1, h) * 0.3, pStrip = sstep(0.3, 0.85, h) * 0.7;
  if (u < pSnap && realTpl(w, 'stump_1')) {
    const a = fallDir(w, x, z), k = hash2(x, z, 13), sc = (sp === 'poplar' ? 1.2 : 1) * (0.75 + hash2(x, z, 14) * 0.5);
    if (hash2(x, z, 16) < 0.4) (w._bfScorch ||= []).push([x, z, 3, 0.3]);
    if (k < 0.45) { (w._bfTops ||= []).push([x, z, a, sc]); return 'stump_1'; }
    if (k < 0.78) { w._tpl ||= {}; for (const n of ['tree_poplar_broken_lod1', 'tree_birch_snapped_lod1']) if (!(n in w._tpl)) w._tpl[n] = null;   // (no leafy stand-in as their far LOD)
      const t = realTpl(w, 'tree_poplar_broken') ? 'tree_poplar_broken' : 'stump_1';   /* (not tree_birch_snapped: its top hangs in the air) */ (w._bfTops ||= []).push([x, z, a, sc * 0.6]); return t; }
    // uprooted: the trunk without the template's flat soil disc; the root plate itself (torn soil and sod, tangled roots,
    // hanging clods) and the hole it came out of are written by the detail pass (rootPlate, w._bfRoots)
    const bare = bareTrunkTpl(w);
    { const cx = x + Math.cos(a) * 2.5, cz = z + Math.sin(a) * 2.5; let bad = false;   // (v9: the lying trunk clear of trenches, track beds, paving -- else snapped low instead)
      for (let t = -6; t <= 6 && !bad; t += 0.8) for (const [ux, uz] of [[Math.cos(a), Math.sin(a)], [-Math.sin(a), Math.cos(a)]]) { const px = cx + ux * t, pz = cz + uz * t; bad = bad || w.terrain.cutSDF(px, pz) < 0.8 || (w.railGap && w.railGap(px, pz) < 2.6) || (w.paved && w.paved.paved(px, pz) < 0.3); }
      if (bad) { (w._bfTops ||= []).push([x, z, a, sc]); return 'stump_1'; } }
    if (bare && w.put(bare, x + Math.cos(a) * 2.5, z + Math.sin(a) * 2.5, -a + (hash2(x, z, 17) - 0.5) * 0.3, { cost: 5, low: true, check: false, s: sc, inst: { cullDist: 420 } })) { const P = w.place?.[bare]; if (P?.m.length) (w._bfRoots ||= []).push(P.m[P.m.length - 1].clone()); }
    return null;
  }
  if (u < pSnap + pStrip) { const n = shatteredTpl(w, sp); if (n) { if (hash2(x, z, 18) < 0.3) (w._bfScorch ||= []).push([x, z, 3.5, 0.25]); return n; } }
  return name;
}
// fallen_trunk (trees.glb) without its 'soil' sub-mesh: a flat 2 m disc standing at the root end that read as a cardboard
// cut-out; the frame of the root plate it had (template-local) is kept for rootPlate()
function bareTrunkTpl(w) {
  const name = 'fallen_trunk_bare'; w._tpl ||= {};
  if (!(name in w._tpl)) {
    const base = realTpl(w, 'fallen_trunk'); let t = null;
    if (base) {
      t = base.clone(true); const rm = []; t.traverse(o => { if (o.isMesh && (Array.isArray(o.material) ? o.material : [o.material]).some(m => /soil/i.test(m?.name || ''))) rm.push(o); });
      for (const o of rm) o.removeFromParent(); t.name = name; t.userData = {};
      t.position.set(0, 0, 0); t.updateMatrixWorld(true); t.userData.bb = new THREE.Box3().setFromObject(t);
    }
    w._tpl[name] = t; w._tpl[name + '_lod1'] = null;
  }
  return w._tpl[name] ? name : null;
}
// farmland.js treelines(): put() rotation extras for the tree treeFate() chose -- about a third of the stripped trees
// lean (0.1-0.45 rad) away from the burst; ry = the yaw put() is given (the lean is in the tree's own frame)
export function treeTilt(w, name, x, z, ry) {
  if (OFF || !name || !/_shattered$|_broken$|_snapped$/.test(name)) return {};
  const k = hash2(x, z, 19); if (k > 0.38) return {};
  const a = fallDir(w, x, z), th = 0.1 + hash2(x, z, 20) * 0.35, dx = Math.cos(a), dz = Math.sin(a);
  const lx = dx * Math.cos(ry) - dz * Math.sin(ry), lz = dx * Math.sin(ry) + dz * Math.cos(ry);
  return { rx: lz * th, rz: -lx * th };
}

// ================================================================ wire: material
const WU = { uPix: { value: 0.0015 } }, _v2 = new THREE.Vector2();
// world size of one pixel at unit distance, for the vertex shader's minimum width
function pixHook(o) { o.onBeforeRender = (r, s, cam) => { if (!cam.isPerspectiveCamera) return; r.getDrawingBufferSize(_v2); WU.uPix.value = 2 * Math.tan(cam.fov * Math.PI / 360) / Math.max(1, _v2.y); }; }
const COIL_L = 6, COIL_R = 0.46;   // (6 m template: coils of 2-6 m, each fitted to the ground under it)
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
          float fx = tp.x / ${COIL_L.toFixed(1)};
          if (wP.b > 0.12 && wP.b < 0.88) {   // torn mid-coil: loops gone in the gap, the sprung ends lie low and splay
            float d = abs(fx - wP.b); if (d < 0.07) hide = 1.0;
            float k = 1.0 - smoothstep(0.07, 0.24, d); k = k * k * (3.0 - 2.0 * k); yk *= 1.0 - 0.8 * k; zk *= 1.0 + 0.5 * k;
          } else if (wP.b > 0.01) {   // end of a stretch (b < .12: start, .88-.98: end, > .98: both): the last loops are
            // pulled down to the end picket -- the coil collapses over ~1 m, its loops sinking to the ground and splaying
            float d = 1.0; if (wP.b < 0.12 || wP.b > 0.98) d = fx; if (wP.b > 0.88) d = min(d, 1.0 - fx);
            float Lm = length(instanceMatrix[0].xyz) * ${COIL_L.toFixed(1)}, k = 1.0 - smoothstep(0.0, min(0.4, 1.2 / max(Lm, 1.0)), d);   // (over ~1.2 m)
            k = k * k * (3.0 - 2.0 * k); yk *= 1.0 - 0.86 * k; zk *= 1.0 + 0.4 * k;
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
    const nu = 3, nv = shifer ? 16 : 12, L = shifer ? 1.75 : 2.0, W = shifer ? 1.13 : 1.15, waves = shifer ? 8 : 6, amp = shifer ? 0.024 : 0.018;
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
// colour carrying its surface: metalness, roughness multiplier (default: matte paint / wood / cloth / soil)
function mcol(hex, r, metal, rough, v = 0.1) { const c = col(hex, r, v); c.m = [metal, rough]; return c; }
const MAT0 = [0.02, 1];
const newDB = () => ({ p: [], n: [], c: [], u: [], m: [], i: [] });
// piece writer: begin() sets the piece frame (on the ground), parts are written into the near (and far) buffer of the
// cell the piece is in, transformed to world space, with a little ground occlusion near the bottom
class Debris {
  constructor() { this.cells = new Map(); this.M = new THREE.Matrix4(); this.pieces = 0; this.CS = 180; }
  cell(x, z) { const i = Math.floor(x / this.CS), j = Math.floor(z / this.CS), k = i + ',' + j; let c = this.cells.get(k); if (!c) this.cells.set(k, c = { near: newDB(), far: newDB(), x: (i + 0.5) * this.CS, z: (j + 0.5) * this.CS }); return c; }
  // undo the last piece(s): buffer lengths before them (mark) -> truncate (rollback)
  mark() { const L = b => b ? [b, b.p.length, b.n.length, b.c.length, b.u.length, b.m.length, b.i.length] : null; return [L(this.nb), L(this.fb), this.pieces]; }
  rollback(m) { for (const e of [m[0], m[1]]) if (e) { const [b, p, n, c, u, mm, i] = e; b.p.length = p; b.n.length = n; b.c.length = c; b.u.length = u; b.m.length = mm; b.i.length = i; } this.pieces = m[2]; }
  begin(x, y, z, ry = 0, rx = 0, rz = 0, s = 1, far = false) { this.M.copy(trs(x, y, z, ry, s, rx, rz)); const c = this.cell(x, z); this.nb = c.near; this.fb = far ? c.far : null; this.y0 = y; this._m = this.mark(); this.pieces++; return this; }
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
      // contact darkening: occluded by the ground near the bottom of the piece, more on faces turned down
      const ao = (0.6 + 0.4 * sstep(0, 0.22, wy - this.y0)) * (0.82 + 0.18 * Math.min(1, _nv.y + 1));
      b.c.push(color.r * ao, color.g * ao, color.b * ao); b.m.push(...(color.m || MAT0));
      // box-projected detail UVs (2.2 per metre: grime / dents / scratches at the scale of a crate)
      const ay = Math.abs(_nv.y), ax = Math.abs(_nv.x), az = Math.abs(_nv.z);
      if (ay > 0.7) b.u.push(wx * 2.2, wz * 2.2); else if (ax > az) b.u.push(wz * 2.2, wy * 2.2); else b.u.push(wx * 2.2, wy * 2.2);
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
  crates2(D, r) { PC.crate(D, r); const L = lm(0, 0.264, 0, 0, (r() - 0.5) * 0.25, 0, 1, 1, 1), M0 = D.M.clone(); D.M.multiply(L); PC.crate(D, r); D.M.copy(M0); D.M.multiply(lm(0.05, 0, 0.42, 0, (r() - 0.5) * 0.4, 0, 1, 1, 1)); PC.crate(D, r); D.M.copy(M0); },
  clod(D, r) { const s = 0.07 + r() * 0.16; D.part(G.ico, lm(0, s * 0.18, 0, r() * 3, r() * 6, r() * 3, s, s * 0.55, s * 0.8), col(pick(r, [0x3e352b, 0x4a3f31, 0x5a4c3a, 0x352d25]), r)); },
  zinc(D, r) { D.box(0, 0.075, 0, 0.36, 0.15, 0.24, mcol(0x5c6150, r, 0.25, 0.7)); if (r() < 0.6) D.box(0.04, 0.17, 0.06, 0.3, 0.004, 0.16, mcol(0x8a8d82, r, 0.8, 0.45), 0, 0.5 + r() * 0.8); },
  tube(D, r) { const t = pick(r, TUBES), c = col(t.c, r);
    D.cyl(0, t.r, 0, t.r, t.l, c, 0, 0, Math.PI / 2, 1, 8, true);
    for (const sx of [-1, 1]) D.cyl(sx * (t.l / 2 - t.e / 2), t.r, 0, t.r * t.k, t.e, c.clone().multiplyScalar(0.82), 0, 0, Math.PI / 2, 1, 8);
    if (t.s) D.box(t.l * 0.1, t.r * 2 + 0.025, 0, 0.12, 0.05, 0.045, col(0x2a2b26, r)); },
  gradTail(D, r) {   // 122 mm 9M22 motor section stuck nose-first, four flip-out wrap-around fins at the top
    const c = mcol(pick(r, [0x4a3324, 0x3b302a, 0x56412f]), r, 0.35, 0.95), L = 0.9 + r() * 0.7;
    D.cyl(0, L / 2 - 0.3, 0, 0.061, L + 0.6, c, 0, 0, 0, 1, 10);
    D.cyl(0, L + 0.02, 0, 0.05, 0.06, col(0x231e1a, r), 0, 0, 0, 1, 10);
    for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + 0.3; D.box(Math.cos(a) * 0.105, L - 0.12, -Math.sin(a) * 0.105, 0.09, 0.2, 0.004, c.clone().multiplyScalar(0.8), a + 0.35); }
    D.cyl(0, 0.015, 0, 0.2, 0.05, col(0x3e352b, r), 0, 0, 0, 0.5, 8); },
  mortarTail(D, r) { const c = mcol(0x3f4236, r, 0.4, 0.8); D.cyl(0, 0.16, 0, 0.032, 0.34, c, 0, 0, 0, 1, 8); for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; D.box(Math.cos(a) * 0.05, 0.28, -Math.sin(a) * 0.05, 0.06, 0.12, 0.003, c, a); } D.cyl(0, 0.015, 0, 0.13, 0.04, col(0x3e352b, r), 0, 0, 0, 0.5, 8); },
  case152(D, r) { const brass = r() < 0.35, c = mcol(brass ? 0x9c7a3a : 0x5e5d48, r, brass ? 0.85 : 0.5, brass ? 0.5 : 0.65); D.cyl(0, 0.084, 0, 0.083, 0.42, c, 0, 0, Math.PI / 2, 0.88, 10); D.cyl(0.215, 0.09, 0, 0.092, 0.015, c.clone().multiplyScalar(0.9), 0, 0, Math.PI / 2, 1, 10); },
  sandbag(D, r) { D.part(pick(r, G.bags), lm(0, 0.07, 0, 0, (r() - 0.5) * 0.3, 0, 0.6, 0.16, 0.36), col(pick(r, [0xb8b2a2, 0xa9a08a, 0x6c6a4a, 0x9a8761]), r)); if (r() < 0.6) D.part(G.ico, lm(0.3 + r() * 0.2, 0.0, (r() - 0.5) * 0.4, 0, r() * 6, 0, 0.35, 0.07, 0.28), col(0x3f362b, r)); },
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
    D.part(pick(r, shifer ? G.sheetS : G.sheetM), lm(0, 0.035, 0, (r() - 0.5) * 0.12, 0, (r() - 0.5) * 0.12, s, 1, s), shifer ? col(pick(r, [0x8e8c84, 0x9b998f, 0x7f7d76]), r) : mcol(pick(r, [0x8b908e, 0x45584a, 0x6b3b2e, 0x7e8482]), r, 0.55, 0.6)); },
  brick(D, r) { D.box(0, 0.035, 0, 0.25, 0.065, 0.12, col(r() < 0.6 ? 0x8c4b37 : 0xb7b2a5, r), 0, (r() - 0.5) * 0.3, (r() - 0.5) * 0.3); },
  chunk(D, r) { const s = 0.15 + r() * 0.35; D.part(G.ico, lm(0, s * 0.3, 0, r() * 3, r() * 6, r() * 3, s, s * 0.7, s * 0.85), col(pick(r, [0x8d8a83, 0x7a776f, 0x9a968c]), r)); },
  rebar(D, r) { const s = 0.2 + r() * 0.3; D.part(G.ico, lm(0, s * 0.3, 0, r() * 3, r() * 6, r() * 3, s, s * 0.6, s), col(0x8d8a83, r)); for (let k = 0; k < 2 + (r() * 2 | 0); k++) D.cyl(0, s * 0.4, 0, 0.007, 0.5 + r() * 0.6, mcol(0x4a3426, r, 0.4, 0.95), 0.6 + r() * 0.8, r() * 6, 0.4, 1, 5); },
  window(D, r) { const c = col(r() < 0.7 ? 0xd8d6cf : 0x6b5a46, r), w = 1.1 + r() * 0.4, h = 1.2 + r() * 0.3;
    D.box(0, 0.03, -h / 2, w, 0.06, 0.07, c); if (r() < 0.7) D.box(0, 0.03, h / 2, w, 0.06, 0.07, c); D.box(-w / 2, 0.03, 0, 0.07, 0.06, h, c); if (r() < 0.6) D.box(w / 2, 0.03, 0, 0.07, 0.06, h, c); D.box(0, 0.025, 0, 0.05, 0.05, h, c); },
  helmet(D, r) { const up = r() < 0.4; D.part(G.hemi, lm(0, up ? 0.12 : 0, 0, up ? Math.PI : 0, r() * 6, 0, 0.135, 0.12, 0.15), col(pick(r, [0x4d4e38, 0x5c5a42, 0x3f4433]), r)); },
  carrier(D, r) { const c = col(pick(r, [0x6b664b, 0x50553c, 0x5c5c46]), r); D.box(0, 0.035, 0, 0.32, 0.07, 0.4, c); D.box(0, 0.09, 0.08, 0.28, 0.05, 0.14, c.clone().multiplyScalar(0.9)); D.box(0.1, 0.085, -0.1, 0.08, 0.05, 0.1, c); },
  pack(D, r) { const c = col(pick(r, [0x55573d, 0x4b4a3a, 0x5f5a45]), r); D.part(pick(r, G.bags), lm(0, 0.11, 0, 0, 0, 0, 0.36, 0.22, 0.5), c); D.box(0, 0.2, -0.12, 0.26, 0.08, 0.16, c); },
  mat(D, r) { D.cyl(0, 0.08, 0, 0.08, 0.6, col(pick(r, [0x3d5240, 0x34506a, 0x5a5b44]), r), 0, 0, Math.PI / 2, 1, 8); },
  tyre(D, r) { D.part(G.torus, lm(0, 0.1, 0, Math.PI / 2, 0, (r() - 0.5) * 0.2, 0.3, 0.3, 0.3), col(0x1f1e1d, r)); },
  wheel(D, r) { D.cyl(0, 0.09, 0, 0.37, 0.18, mcol(0x2e2c28, r, 0.3, 0.85), (r() - 0.5) * 0.2, 0, (r() - 0.5) * 0.2, 1, 14); D.cyl(0, 0.181, 0, 0.2, 0.012, col(0x3d3b35, r), 0, 0, 0, 1, 10); },
  links(D, r) { const n = 8 + (r() * 12 | 0), c = mcol(0x2f2b26, r, 0.45, 0.85); let a = 0, x = 0, z = 0; for (let k = 0; k < n; k++) { D.box(x, 0.02, z, 0.15, 0.035, 0.55, c, a); a += (r() - 0.5) * 0.25; x += Math.cos(a) * 0.155; z -= Math.sin(a) * 0.155; } },
  era(D, r) { D.box(0, 0.03, 0, 0.25, 0.06, 0.14, col(0x3f4733, r), 0, (r() - 0.5) * 0.4, (r() - 0.5) * 0.4); },
  frag(D, r) { const n = 3 + (r() * 5 | 0); for (let k = 0; k < n; k++) { const s = 0.04 + r() * 0.09; D.part(G.tet, lm((r() - 0.5) * 0.9, s * 0.15, (r() - 0.5) * 0.9, r() * 3, r() * 6, r() * 3, s, s * 0.3, s * 0.6), mcol(0x2f2925, r, 0.5, 0.8)); } },
  casings(D, r) { const n = 10 + (r() * 14 | 0); for (let k = 0; k < n; k++) D.part(G.tet, lm((r() - 0.5) * 1.4, 0.004, (r() - 0.5) * 1.4, 0, r() * 6, 0, 0.022, 0.006, 0.006), mcol(pick(r, [0xa8823d, 0x6f6a4a]), r, 0.85, 0.45)); },
  fpv(D, r) { const c = col(0x1c1c1c, r); D.box(0, 0.02, 0, 0.26, 0.012, 0.03, c, 0.785); D.box(0, 0.02, 0, 0.26, 0.012, 0.03, c, -0.785);
    for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + 0.785; D.cyl(Math.cos(a) * 0.12, 0.035, -Math.sin(a) * 0.12, 0.014, 0.025, col(0x3a3a3a, r), 0, 0, 0, 1, 6); }
    D.box(0.02, 0.045, 0, 0.1, 0.035, 0.04, col(0x2a2f3a, r)); if (r() < 0.5) D.cyl(-0.05, 0.05, 0.06, 0.04, 0.25, col(0x4b5232, r), 0, 0.5, Math.PI / 2, 0.7, 8); },
  bottle(D, r) { D.cyl(0, 0.04, 0, 0.04, 0.26, mcol(pick(r, [0xa9b5a6, 0x6b8f6a, 0x8a9aa8]), r, 0, 0.35), 0, r() * 6, Math.PI / 2, 0.88, 6); },
  ration(D, r) { D.box(0, 0.02, 0, 0.22, 0.04, 0.14, col(pick(r, [0x8c7d5a, 0x4d6a3f, 0x6e6545]), r), r() * 6); },
};
// A tree's root plate torn out of the ground, standing on edge at the trunk's foot (local frame: the plate in the XY plane,
// +z towards the trunk = the old ground surface with its sod, -z the underside the roots come out of): a lumpy disc of
// soil, the sod skin, 5-6 thick tapering main roots (broken, pale ends), a dozen thin ones, clods hanging off the bottom
// rim.  ~400 triangles, merged into the debris cell.
function rootPlate(D, r) {
  const soil = col(pick(r, [0x4a3a2b, 0x544232, 0x3f3226]), r), dark = soil.clone().multiplyScalar(0.72), sod = col(pick(r, [0x4f5532, 0x5a5636, 0x48502f]), r), bark = col(pick(r, [0x4a4038, 0x3f3a34]), r), pale = col(0xa08a68, r);
  const R0 = 0.85 + r() * 0.35;
  D.cyl(0, 0, -0.08, R0, 0.42, soil, -Math.PI / 2, 0, 0, 0.88, 10);                 // the soil body (narrower on the root side)
  D.cyl(0, 0, 0.15, R0 * 1.04, 0.07, sod, Math.PI / 2, 0, 0, 1, 10);                // sod skin of the old surface
  for (let k = 0; k < 7; k++) { const a = k / 7 * TAU + r() * 0.6, rr = R0 * (0.55 + r() * 0.45), s = 0.18 + r() * 0.22; D.part(G.ico, lm(Math.cos(a) * rr, Math.sin(a) * rr, -0.22 - r() * 0.15, r() * 3, r() * 6, r() * 3, s * 1.3, s, s), r() < 0.5 ? soil : dark); }   // lumps on the underside / rim
  const dirTo = (dx, dy, dz) => { const L = Math.hypot(dx, dy, dz) || 1; dx /= L; dy /= L; dz /= L; return [Math.atan2(dz, dy), -Math.asin(Math.max(-1, Math.min(1, dx)))]; };   // (rx, rz) taking +y onto d (Euler YXZ, ry = 0)
  const root = (x0, y0, z0, dx, dy, dz, len, rad, seg, end) => {
    const [rx, rz] = dirTo(dx, dy, dz), L = Math.hypot(dx, dy, dz) || 1, ux = dx / L, uy = dy / L, uz = dz / L;
    D.cyl(x0 + ux * len / 2, y0 + uy * len / 2, z0 + uz * len / 2, rad, len, bark, rx, 0, rz, 0.35, seg, true);
    if (end) D.box(x0 + ux * len, y0 + uy * len, z0 + uz * len, rad * 1.1, rad * 2.2, rad * 1.1, pale, 0, rx, rz);   // the broken, pale end
  };
  const nMain = 5 + (r() * 2 | 0);
  for (let k = 0; k < nMain; k++) { const a = k / nMain * TAU + (r() - 0.5) * 0.7; root(Math.cos(a) * R0 * 0.3, Math.sin(a) * R0 * 0.3, -0.2, Math.cos(a), Math.sin(a), -0.35 - r() * 0.5, R0 * 0.7 + 0.5 + r() * 0.8, 0.05 + r() * 0.04, 6, r() < 0.7); }
  for (let k = 0; k < 14; k++) { const a = r() * TAU, rr = Math.sqrt(r()) * R0 * 0.8; root(Math.cos(a) * rr, Math.sin(a) * rr, -0.24, (r() - 0.5) * 1.2 + Math.cos(a) * 0.4, (r() - 0.5) * 1.2 + Math.sin(a) * 0.4 - 0.3, -1, 0.25 + r() * 0.7, 0.012 + r() * 0.016, 5, false); }
  for (let k = 0; k < 4; k++) { const x = (r() - 0.5) * R0 * 1.2, s = 0.12 + r() * 0.16; D.part(G.ico, lm(x, -R0 * (0.75 + r() * 0.25), -0.3 - r() * 0.2, r() * 3, r() * 6, r() * 3, s, s * 1.4, s), dark); }   // clods hanging off the bottom rim
}
let grimeTex = null, dentTex = null;
// Debris surface: vertex colour (albedo + contact darkening) x a tiling grime map; a dent / scratch normal map and a
// roughness map from the same procedural canvases; per-vertex metalness and roughness (aMat: brass cases, galvanised
// sheet, rusty iron, plastic, paint, wood) -- one material, one draw call per cell.
function debrisMaterial() {
  if (!grimeTex) {   // tiling grime: soft blotches, specks, scratches (multiplies the vertex colours; G = roughness)
    const S = 256, cv = document.createElement('canvas'); cv.width = cv.height = S; const x = cv.getContext('2d'), R = mulberry(515);
    x.fillStyle = '#e4e0d8'; x.fillRect(0, 0, S, S);
    for (let i = 0; i < 260; i++) { const px = R() * S, py = R() * S, r = 4 + R() * 28, g = x.createRadialGradient(px, py, 0, px, py, r), v = 120 + R() * 110 | 0; g.addColorStop(0, `rgba(${v},${v - 6},${v - 14},${0.18 + R() * 0.2})`); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { x.save(); x.translate(ox, oy); x.fillRect(px - r, py - r, r * 2, r * 2); x.restore(); } }
    for (let i = 0; i < 1800; i++) { const v = R() < 0.5 ? 70 + R() * 60 | 0 : 235; x.fillStyle = `rgba(${v},${v - 4},${v - 10},${0.25 + R() * 0.4})`; x.fillRect(R() * S, R() * S, 1 + R() * 2, 1 + R() * 2); }
    x.strokeStyle = 'rgba(250,248,240,0.25)'; for (let i = 0; i < 40; i++) { x.lineWidth = 0.5 + R(); x.beginPath(); const px = R() * S, py = R() * S; x.moveTo(px, py); x.lineTo(px + (R() - 0.5) * 40, py + (R() - 0.5) * 40); x.stroke(); }
    grimeTex = new THREE.CanvasTexture(cv); grimeTex.colorSpace = THREE.SRGBColorSpace; grimeTex.wrapS = grimeTex.wrapT = THREE.RepeatWrapping; grimeTex.anisotropy = 4;
    // dents, chips, scratches and a fine grain: a tiling height field -> tangent-space normal map
    const N = 256, hgt = new Float32Array(N * N), D2 = mulberry(616), at = (i, j) => hgt[((j + N) % N) * N + ((i + N) % N)];
    const bump = (cx, cy, r, a) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const d = Math.hypot(i, j) / r; if (d < 1) hgt[((cy + j + N) % N) * N + ((cx + i + N) % N)] += a * (1 - d * d) ** 2; } };
    for (let k = 0; k < 160; k++) bump(D2() * N | 0, D2() * N | 0, 3 + (D2() * 12 | 0), (D2() - 0.65) * 2.2);   // dents (mostly in) and lumps
    for (let k = 0; k < 70; k++) { let px = D2() * N, py = D2() * N; const a = D2() * TAU, L = 10 + D2() * 50; for (let t = 0; t < L; t++) { hgt[(((py | 0) % N + N) % N) * N + (((px | 0) % N + N) % N)] -= 0.8; px += Math.cos(a); py += Math.sin(a); } }   // scratches
    for (let k = 0; k < N * N; k++) hgt[k] += (D2() - 0.5) * 0.25;   // grain
    const img = new ImageData(N, N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const dx = (at(i + 1, j) - at(i - 1, j)) * 0.5, dy = (at(i, j + 1) - at(i, j - 1)) * 0.5, l = Math.hypot(dx, dy, 1), o = (j * N + i) * 4;
      img.data[o] = (-dx / l * 0.5 + 0.5) * 255; img.data[o + 1] = (-dy / l * 0.5 + 0.5) * 255; img.data[o + 2] = (1 / l * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
    }
    const cn = document.createElement('canvas'); cn.width = cn.height = N; cn.getContext('2d').putImageData(img, 0, 0);
    dentTex = new THREE.CanvasTexture(cn); dentTex.wrapS = dentTex.wrapT = THREE.RepeatWrapping; dentTex.anisotropy = 4;
  }
  const m = new THREE.MeshStandardMaterial({ map: grimeTex, roughnessMap: grimeTex, normalMap: dentTex, normalScale: new THREE.Vector2(0.55, 0.55), vertexColors: true, roughness: 1, metalness: 1 }); m.name = 'bf_debris';
  m.customProgramCacheKey = () => 'bf_debris_v2';
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aMat; varying vec2 vMat;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vMat;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp((0.55 + 0.6 * roughnessFactor) * vMat.y, 0.25, 1.0);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vMat.x;');
  };
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
  const coils = [], coilCols = [], coilEnds = [], scorch = w._bfScorch || [], stats = { coils: 0, heaps: 0, pickets: 0, pieces: 0 }, spots = {};
  const mark = (k, x, z) => { const a = spots[k] ||= []; if (a.length < 40) a.push([Math.round(x), Math.round(z)]); };   // (a few of each, for tests / screenshots: window.__bf.spots)
  const navLine = (ax, az, bx, bz, hw, cost) => { if (!nav) return; const L = Math.hypot(bx - ax, bz - az); for (let t = 0; t <= L; t += 0.8) nav.circle(ax + (bx - ax) * t / L, az + (bz - az) * t / L, hw, cost); };

  // ---------------------------------------------------------------- pieces & clusters
  const tiltAt = (x, z, ry) => { const gx = (H(x + 0.3, z) - H(x - 0.3, z)) / 0.6, gz = (H(x, z + 0.3) - H(x, z - 0.3)) / 0.6, c = Math.cos(ry), s = Math.sin(ry); return [-Math.atan(gx * s + gz * c), Math.atan(gx * c - gz * s)]; };
  // a written piece must neither reach into / over a trench or pit (any vertex in the cut) nor float: the vertices at its
  // underside stay within ~15 cm of the ground under them (spoil lips, crater rims, parapets) -- else it is taken back out
  const fits = (m, buried = false) => {
    const b = m[0][0], v0 = m[0][1], v1 = b.p.length; if (v1 <= v0) return true;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y0 = 1e9;
    for (let i = v0; i < v1; i += 3) { const x = b.p[i], y = b.p[i + 1], z = b.p[i + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; if (y < y0) y0 = y; }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, rad = Math.hypot(x1 - x0, z1 - z0) / 2, nv = (v1 - v0) / 3, st = Math.max(1, Math.floor(nv / 48)) * 3;
    const nearCut = T.cutSDF(cx, cz) < rad + 0.4;
    for (let i = v0; i < v1; i += st) {
      const x = b.p[i], y = b.p[i + 1], z = b.p[i + 2];
      if (nearCut && T.cutSDF(x, z) < 0.04) return false;
      if (!buried && y < y0 + 0.06 && y - H(x, z) > 0.15) return false;
    }
    return true;
  };
  const guard = (f, buried = false) => { const m0 = D._m; f(); const m = D._m; if (m === m0 || fits(m, buried)) return true; D.rollback(m); return false; };   // (D._m: set by the piece's begin())
  const piece = (name, x, z, far, ry = R() * TAU) => {
    const r = R; let ok;
    if (name === 'gradTail' || name === 'mortarTail') { const tilt = name === 'gradTail' ? 0.25 + R() * 0.6 : R() * 0.5; ok = guard(() => { D.begin(x, H(x, z) - 0.02, z, ry, tilt, 0, 1, far); PC[name](D, r); }, true); }
    else { const [rx, rz] = tiltAt(x, z, ry); ok = guard(() => { D.begin(x, H(x, z) - 0.008, z, ry, rx, rz, 1, far); PC[name](D, r); }); }
    if (ok) stats.pieces++; return ok;
  };

  // ---------------------------------------------------------------- own occupancy (0.5 m cells): wire, stakes and heaps never overlap
  const OC = 0.5, occ = new Set(), okey = (i, j) => i * 65536 + j;
  const claim = (x, z, r) => { for (let i = Math.floor((x - r) / OC); i <= Math.floor((x + r) / OC); i++) for (let j = Math.floor((z - r) / OC); j <= Math.floor((z + r) / OC); j++) occ.add(okey(i, j)); };
  const taken = (x, z, r) => { for (let i = Math.floor((x - r) / OC); i <= Math.floor((x + r) / OC); i++) for (let j = Math.floor((z - r) / OC); j <= Math.floor((z + r) / OC); j++) if (occ.has(okey(i, j))) return true; return false; };
  // anything solid on the nav grid within r: hedgehogs, poles, wrecks (blocked), sandbags / fallen trunks / bushes / rubble (cost >= 4)
  const navHard = (x, z, r) => { if (!nav) return false; for (let dx = -r; dx <= r + 1e-6; dx += 0.5) for (let dz = -r; dz <= r + 1e-6; dz += 0.5) { const i = nav.idx(x + dx, z + dz); if (i >= 0 && nav.cost[i] >= 4) return true; } return false; };
  // clear ground for wire: off roads / tracks, clear of trenches and their spoil, teeth, buildings, props, trees, crater bowls
  const clear = (x, z, r) => inMap(x, z) && !onRoad(x, z, r + 0.8) && T.cutSDF(x, z) > r + 1.2 && !inBuilding(x, z, r + 0.6) && !(w.solidHit && w.solidHit(x, z, r, r, 0, 0.25))
    && !toothNear(x, z, r + 1.0) && !(w.nearTrail && w.nearTrail(x, z, r + 0.5)) && !craterNear(x, z, 0.3) && !navHard(x, z, r) && !taken(x, z, r);
  // lip: right at a trench edge (parapet sandbags, cases thrown out of a bay): only clear of the cut itself
  const piece2 = (name, x, z, far, ry, lip = false) => { if ((lip ? inMap(x, z) && !onRoad(x, z, 0.5) && T.cutSDF(x, z) > 0.28 && !inBuilding(x, z, 0.2) && !(w.solidHit && w.solidHit(x, z, 0.2, 0.2, 0, 0.05)) : free(x, z, 0.22)) && !taken(x, z, 0.15)) return piece(name, x, z, far, ry); return false; };

  // ---------------------------------------------------------------- stakes / coils
  const PCOL = [0x4b3123, 0x3c3832, 0x55392a];
  const picket = (x, z, h = 1.1, lean = 0.06) => {   // angle-iron stake, driven in
    const ry = R() * TAU, rx = (R() - 0.5) * lean * 2, rz = (R() - 0.5) * lean * 2, y = H(x, z) - 0.05;
    D.begin(x, y, z, ry, rx, rz, 1, true); const c = mcol(pick(R, PCOL), R, 0.4, 0.95);
    D.box(0.0225, h / 2, 0, 0.05, h, 0.005, c); D.box(0, h / 2, 0.0225, 0.005, h, 0.05, c); stats.pickets++; claim(x, z, 0.2);
  };
  // ground under a coil from a to b (centre and both flanks): the coil is a straight body, so it only goes where the
  // ground is near-planar along it -- returns the fitted end heights, or null (it would float over a hollow / sink in a hump)
  const fitGround = (ax, az, bx, bz, hw) => {
    const L = Math.hypot(bx - ax, bz - az), nx = -(bz - az) / L, nz = (bx - ax) / L, n = Math.max(4, Math.ceil(L / 0.5)), hs = [];
    for (let k = 0; k <= n; k++) { const t = k / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t; hs.push([H(x, z), H(x + nx * hw, z + nz * hw), H(x - nx * hw, z - nz * hw)]); }
    const ya = (hs[0][0] + hs[0][1] + hs[0][2]) / 3, yb = (hs[n][0] + hs[n][1] + hs[n][2]) / 3;
    let dev = 0, side = 0;
    for (let k = 0; k <= n; k++) { const yl = ya + (yb - ya) * k / n; for (const h of hs[k]) dev = Math.max(dev, Math.abs(h - yl)); side += hs[k][1] - hs[k][2]; }
    return dev < 0.12 ? { ya, yb, cross: side / (n + 1) / (2 * hw) } : null;
  };
  const coil = (ax, az, bx, bz, g, o = {}) => {   // one stretched coil instance from a to b, resting on the fitted ground
    const L = Math.hypot(bx - ax, bz - az), ang = Math.atan2(-(bz - az), bx - ax), rz = Math.atan2(g.yb - g.ya, L), rx = -Math.atan(g.cross);
    const M = trs(ax, g.ya - 0.035, az, ang, 1, rx, rz).multiply(new THREE.Matrix4().makeScale(L / COIL_L / Math.cos(rz), o.sy ?? (0.88 + R() * 0.16), o.sz ?? (0.92 + R() * 0.14)));
    coils.push(M); coilCols.push(new THREE.Color(Math.min(1, Math.max(0, o.rust ?? R() * 0.5)), o.crush ?? (R() < 0.1 ? 0.3 + R() * 0.4 : R() * 0.1), o.tear ?? 0)); stats.coils++;
    coilEnds.push([ax, az, bx, bz]);
    // nav (men only, vehicles ignore wire): the coil is a real obstacle on foot; a tear in it is a gap a man can get through
    const t = o.tear ?? 0;
    if (nav) { if (t > 0.12 && t < 0.88) { nav.wireSeg(ax, az, ax + (bx - ax) * (t - 0.09), az + (bz - az) * (t - 0.09), 0.55, WIRE_COST.belt); nav.wireSeg(ax + (bx - ax) * (t + 0.09), az + (bz - az) * (t + 0.09), bx, bz, 0.55, WIRE_COST.belt); } else nav.wireSeg(ax, az, bx, bz, 0.55, WIRE_COST.belt); }
  };
  // walk a polyline at 0.5 m; split into runs where ok(x, z, ux, uz) holds (>= minRun m)
  const runsOf = (poly, ok, minRun = 3) => {
    const out = []; let cur = [];
    for (let i = 1; i < poly.length; i++) {
      const [ax, az] = poly[i - 1], [bx, bz] = poly[i], L = Math.hypot(bx - ax, bz - az); if (L < 1e-3) continue; const ux = (bx - ax) / L, uz = (bz - az) / L;
      for (let t = i === 1 ? 0 : 0.5; t <= L; t += 0.5) { const x = ax + ux * t, z = az + uz * t; if (ok(x, z, ux, uz)) cur.push([x, z]); else { if (cur.length * 0.5 >= minRun) out.push(cur); cur = []; } }
    }
    if (cur.length * 0.5 >= minRun) out.push(cur);
    return out;
  };
  // the whole width of a belt must be clear (one coil 0.95 m, two side by side 1.95 m)
  const beltOk = rows => (x, z, ux, uz) => { const hw = rows === 2 ? 0.95 : 0.48; for (const o of rows === 2 ? [-0.55, 0, 0.55] : [0]) if (!clear(x - uz * o, z + ux * o, hw - Math.abs(o) + 0.05)) return false; return true; };
  // lay a belt along a valid run: 1 = a single coil (outposts, teeth, verges), 2 = two coils side by side (lines, strongpoints).
  // Stretched concertina staked down at the coil joints only (no fence of pickets); at the ends of every stretch the
  // last loops are sprung and lie low; a stretch over broken ground is cut into shorter coils or left open.
  const belt = (run, rows, rust0) => {
    const L = (run.length - 1) * 0.5; if (L < 2) return 0;
    const at = s => run[Math.min(run.length - 1, Math.max(0, Math.round(s / 0.5)))];
    const dir = s => { const a = at(Math.max(0, s - 1)), b = at(Math.min(L, s + 1)); const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
    let laid = 0;
    // passages: a 1.6-2.4 m gap every 22-38 m (both rows at the same place) -- the way out for the position's own patrols /
    // the gap left for the next coil, so a belt never seals a stretch of front for men on foot
    const passages = []; if (L > 14) for (let p = 6 + R() * 9; p < L - 5; p += 22 + R() * 16) { const wd = 1.6 + R() * 0.8; passages.push([p, p + wd]); }
    // mark a coil as the end of its stretch (the shader drops its last loops to the ground): .97 end, .99 both ends
    const endOf = p => { if (!p) return; const b = p.col.b; if (b === 0) p.col.b = 0.97; else if (b < 0.12) p.col.b = 0.99; };
    for (let row = 0; row < rows; row++) {
      const lat = rows === 2 ? (row ? 0.48 : -0.48) : 0;
      let s = 0, open = true, prevEnd = null;
      while (s < L - 1.5) {
        let e = Math.min(L, s + (row && s === 0 ? 2 + R() * 2 : 3.5 + R() * 2.5)); if (L - e < 1.8) e = L;
        const ps = passages.find(([p0, p1]) => p1 > s && p0 < e);
        if (ps) { if (ps[0] - s >= 1.8) e = ps[0]; else { endOf(prevEnd); open = true; prevEnd = null; s = ps[1]; continue; } }
        let g = null, a, b;
        for (let tries = 0; tries < 3 && e - s >= 1.8; tries++) {
          const [ux, uz] = dir((s + e) / 2); a = at(s); b = at(e); a = [a[0] - uz * lat, a[1] + ux * lat]; b = [b[0] - uz * lat, b[1] + ux * lat];
          g = fitGround(a[0], a[1], b[0], b[1], 0.42); if (g) break; e = s + (e - s) * 0.6;
        }
        if (!g) { endOf(prevEnd); open = true; prevEnd = null; s += 1; continue; }   // hollow / hump: a gap, the coil before it ends sprung
        let tear = open ? 0.03 : 0;
        const cr = craterNear((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 2.2 + (e - s) / 2);   // torn where a shell landed beside it
        if (!tear && cr) { const t = ((cr[0] - a[0]) * (b[0] - a[0]) + (cr[1] - a[1]) * (b[1] - a[1])) / ((e - s) * (e - s)); if (t > 0.15 && t < 0.85) tear = t; }
        if (!tear && R() < 0.05) tear = 0.25 + R() * 0.5;
        coil(a[0], a[1], b[0], b[1], g, { rust: rust0 + (R() - 0.5) * 0.25, tear });
        prevEnd = { col: coilCols[coilCols.length - 1] }; open = false; laid++;
        if (row === 0) { const [ux, uz] = dir(s); const p = at(s); picket(p[0] + (R() - 0.5) * 0.2, p[1] + (R() - 0.5) * 0.2, 1.0 + R() * 0.2); }
        s = e;
      }
      endOf(prevEnd);
      if (row === 0 && !open) { const p = at(L); picket(p[0], p[1], 1.0 + R() * 0.2); }
    }
    const hw = rows === 2 ? 1.0 : 0.55;
    for (let s = 0; s <= L; s += 0.5) { const p = at(s); claim(p[0], p[1], hw); }
    return laid;
  };

  // ---------------------------------------------------------------- 1. concertina in front of the positions
  // (2023-25: a belt 13-25 m out in front of the fire trenches -- inside hand-grenade range of nothing, in sight of the
  // MG -- often with the ends bent back round the flanks; single coils at squad outposts)
  const systems = w.trenchSystems || [];
  for (const sy of systems) {
    const fl = Math.hypot(sy.front[0], sy.front[1]) || 1, fx = sy.front[0] / fl, fz = sy.front[1] / fl, sx = -fz, sz = fx;
    const pts = [...(sy.lines || []).flat(), ...(sy.slots || []).map(s => [s.x, s.z])]; if (pts.length < 2) continue;
    // profile across the front: most forward trench point per 4 m bin of the lateral coordinate
    const bins = new Map(); let lo = 1e9, hi = -1e9;
    for (const [x, z] of pts) { const s = x * sx + z * sz, f = x * fx + z * fz, b = Math.floor(s / 4); bins.set(b, Math.max(bins.get(b) ?? -1e9, f)); lo = Math.min(lo, b); hi = Math.max(hi, b); }
    const kind = sy.kind || 'line', rows = kind === 'line' || (kind !== 'outpost' && R() < 0.4) ? 2 : 1, d0 = kind === 'line' ? 13 : kind === 'outpost' ? 13 : 17;   // (lines: between the trench and the dragon's-teeth rows 23 m out)
    const ext = kind === 'outpost' ? 3 : 4, rust0 = R() * 0.55, prof = [];
    for (let b = lo - ext; b <= hi + ext; b++) {
      let f = bins.get(b);
      if (f == null) { let l = null, r = null; for (let k = 1; k < 8 && (l == null || r == null); k++) { if (l == null && bins.has(b - k)) l = [k, bins.get(b - k)]; if (r == null && bins.has(b + k)) r = [k, bins.get(b + k)]; } f = l && r ? (l[1] * r[0] + r[1] * l[0]) / (l[0] + r[0]) : (l || r)?.[1]; if (f == null) continue; if (b < lo || b > hi) f -= (b < lo ? lo - b : b - hi) * 4 * 0.75; }   // wings bend back
      prof.push([b, f]);
    }
    for (let it = 0; it < 3; it++) for (let i = 1; i < prof.length - 1; i++) prof[i][1] = Math.max(prof[i][1], (prof[i - 1][1] + prof[i + 1][1]) / 2);   // no pockets between bays
    const parts = []; for (const e of prof) { const P = parts[parts.length - 1]; if (P && e[0] - P[P.length - 1][0] === 1) P.push(e); else parts.push([e]); }   // no wire across a hole in the profile
    for (const part of parts) {
      if (part.length < 2) continue;
      const poly = part.map(([b, f]) => { const s = (b + 0.5) * 4, d = d0 + (hash2(b, sy.id ?? 0, 3) - 0.5) * 3; return [sx * s + fx * (f + d), sz * s + fz * (f + d)]; });
      for (const run of runsOf(poly, beltOk(rows), 3)) if (belt(run, rows, rust0)) mark('belt' + rows, run[run.length >> 1][0], run[run.length >> 1][1]);
    }
  }
  // ---------------------------------------------------------------- 2. a coil in front of the rows of dragon's teeth (the Surovikin-line belts)
  for (const f of MAP.fortifications || []) {
    if (f.type !== 'teeth' || !f.pts || f.pts.length < 2) continue;
    const [a, b] = [f.pts[0], f.pts[f.pts.length - 1]], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L;
    let side = 1, bd = 1e9; const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    for (const sy of systems) { const d = Math.hypot(sy.center[0] - mx, sy.center[1] - mz); if (d < bd) { bd = d; side = -Math.sign((sy.center[0] - mx) * nx + (sy.center[1] - mz) * nz) || 1; } }
    const off = ((f.rows || 1) * 1.6 + 3.5) * side, poly = f.pts.map(p => [p[0] + nx * off, p[1] + nz * off]);
    for (const run of runsOf(poly, beltOk(1), 3)) belt(run, 1, 0.25 + R() * 0.4);
  }
  // ---------------------------------------------------------------- 3. check points: coils out over the verges beside the hedgehog block
  const hogs = [];
  for (const P of PLACED) if (/hedgehog/i.test(P.template?.name || '')) for (const M of P.matrices) hogs.push([M.elements[12], M.elements[14]]);
  const used = new Set(), groups = [];
  for (let i = 0; i < hogs.length; i++) { if (used.has(i)) continue; const g = [i]; used.add(i); for (let q = 0; q < g.length; q++) for (let j = 0; j < hogs.length; j++) if (!used.has(j) && Math.hypot(hogs[j][0] - hogs[g[q]][0], hogs[j][1] - hogs[g[q]][1]) < 5.5) { used.add(j); g.push(j); } if (g.length >= 2) groups.push(g.map(k => hogs[k])); }
  const checkpoints = [];
  for (const g of groups) {
    let a = g[0], b = g[1], best = 0; for (const p of g) for (const q of g) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d > best) { best = d; a = p; b = q; } }
    const L = best || 1, ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L, rust = 0.2 + R() * 0.5;
    for (const [p, sd] of [[a, -1], [b, 1]]) {   // from just beyond the last hedgehog out over the verge: no driving round the block
      const poly = [[p[0] + ux * sd * 2.2, p[1] + uz * sd * 2.2], [p[0] + ux * sd * (10 + R() * 6), p[1] + uz * sd * (10 + R() * 6)]];
      for (const run of runsOf(poly, beltOk(1), 2.5)) { belt(run, 1, rust); break; }
    }
    checkpoints.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ux, uz, L]); mark('checkpoint', (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  // ---------------------------------------------------------------- 4. heaps of wire / unused rolls (by the dugouts, at the check points), loose torn coils
  const heap = (x, z, kind) => {
    if (!free(x, z, 1.4, 1.5) || !clear(x, z, 1.5)) return false;
    const seed = R() * 1e9 | 0, ry = R() * TAU, y0 = H(x, z), c = wcell(x, z), rust = R() * 0.7, cl = [rust, 0, 0];
    for (const lod of [0, 1]) {
      const r = mulberry(seed), curves = [], S = 0.75 + r() * 0.45, samples = lod ? 9 : 22, every = lod ? 2 : 1, hw = lod ? 0.02 : 0.012, buf = lod ? c.far : c.near;
      if (kind !== 'rolls') {   // tangle: pulled-up coil fragments, any which way, slumped into a mound
        const nf = 5 + (r() * 4 | 0);
        for (let f = 0; f < nf; f++) {
          const fr = coilPts(r, 3 + (r() * 8 | 0), 0.28 + r() * 0.18, 0.05 + r() * 0.14, samples, every, []), ax = (r() - 0.5) * 1.4, ay = r() * TAU, cx = (r() - 0.5) * 1.3 * S, cy = 0.15 + r() * 0.4, cz = (r() - 0.5) * 0.9 * S, bend = (r() - 0.5) * 0.5;
          for (const pts of fr) curves.push([pts.map(p => { const q = rotP([p[0] - 0.4, p[1] + bend * p[0] * p[0], p[2]], ax, ay); return [q[0] + cx, q[1] + cy, q[2] + cz]; }), true]);
        }
      }
      if (kind !== 'tangle') {   // packed rolls (closed coils, ~0.5 m long), lying side by side or stood on end; a third on top of the first
        const nr = 1 + (r() * 3 | 0), at = [];
        for (let q = 0; q < nr; q++) {
          const up = q < 2 ? r() < 0.4 : at[0][2], ay = q === 2 ? at[0][3] : r() * TAU, ox = q === 2 ? at[0][0] : (kind === 'rolls' ? q * 1.0 - 0.5 : 1.5 + q * 0.95), oz = q === 2 ? at[0][1] : (r() - 0.5) * 0.3;
          at.push([ox, oz, up, ay]);
          const fr = coilPts(r, 20, 0.45, 0.026, samples, lod ? 4 : 2, []), lift = q === 2 ? (up ? 0.52 : 0.88) : 0;
          for (const pts of fr) curves.push([pts.map(p => { const q2 = up ? [p[1], p[0], p[2]] : [p[2], p[1], p[0] - 0.26], rr = up ? rotP(q2, 0, ay) : q2; return [rr[0] + ox, rr[1] + (up ? 0.02 : 0.45) + lift, rr[2] + oz]; }), false]);
        }
      }
      const cr = Math.cos(ry), sr = Math.sin(ry);
      for (const [pts, squash] of curves) {
        buf.curve(pts.map(([px, py, pz]) => {
          const d2 = (px * px) / (1.4 * S * 1.4 * S) + (pz * pz) / (1.0 * S * 1.0 * S), dome = 0.85 * S * Math.max(0, 1 - d2);
          if (py > dome && squash) py = dome + (py - dome) * 0.25;
          const wx = x + px * cr + pz * sr, wz = z - px * sr + pz * cr, g = H(wx, wz);
          let wy = y0 + py; if (wy < g + 0.02) wy = g + 0.02 + (wy - g - 0.02) * 0.1;
          return [wx, Math.max(g + 0.012, wy), wz];
        }), hw * (kind === 'rolls' || every > 1 ? 1.4 : 1), 0, cl);
      }
    }
    claim(x, z, 1.8); if (nav) nav.circle(x, z, 1.5, 4);
    mark('heap', x, z); stats.heaps++; return true;
  };
  const loose = (x, z) => {   // a torn length of coil dragged off and dropped: a few metres of loops, flattened, along a bent line
    const seed = R() * 1e9 | 0, ry = R() * TAU, r0 = mulberry(seed), n = 8 + (r0() * 10 | 0), sp = 0.2 + r0() * 0.12, Lf = n * sp, bend = (r0() - 0.5) * 1.2;
    const P = (u, zz = 0) => { const px = (u - 0.5) * Lf, z2 = zz + bend * Math.sin(u * Math.PI) * 1.5; return [x + px * Math.cos(ry) + z2 * Math.sin(ry), z - px * Math.sin(ry) + z2 * Math.cos(ry)]; };
    for (let u = 0; u <= 1.0001; u += 0.1) { const [px, pz] = P(u); if (!clear(px, pz, 0.5)) return; }
    const c = wcell(x, z), cl = [0.3 + R() * 0.5, 0, 0];
    for (const lod of [0, 1]) {
      const r = mulberry(seed); r(); r(); r(); r(); const fr = coilPts(r, n, 0.42, sp, lod ? 9 : 22, lod ? 2 : 1, []);
      for (const pts of fr) (lod ? c.far : c.near).curve(pts.map(p => {
        const u = p[0] / Lf, y = p[1] * (0.45 + 0.2 * Math.sin(u * 9)) + 0.2, [wx, wz] = P(u, p[2]), g = H(wx, wz); return [wx, Math.max(g + 0.012, g + y), wz];
      }), lod ? 0.02 : 0.012, 0, cl);
    }
    for (let u = 0; u <= 1.0001; u += 0.1) { const [px, pz] = P(u); claim(px, pz, 0.6); if (nav && u > 0.05) { const [qx, qz] = P(u - 0.1); nav.wireSeg(qx, qz, px, pz, 0.6, WIRE_COST.loose); } }
  };
  for (const sy of systems) {
    const fl = Math.hypot(sy.front[0], sy.front[1]) || 1, fx = sy.front[0] / fl, fz = sy.front[1] / fl, line = (sy.lines || []).flat();
    // the engineers' dump by a dugout: rolls and pulled-up wire waiting to be laid / repaired
    const nH = sy.kind === 'line' ? 2 : sy.kind === 'outpost' ? (R() < 0.5 ? 1 : 0) : 1;
    for (let k = 0, tries = 0; k < nH && tries < 14; tries++) {
      const d = sy.dugouts?.length ? pick(R, sy.dugouts) : null, base = d ? [d.x, d.z] : line.length ? pick(R, line) : sy.center, back = d ? 3 + R() * 5 : 6 + R() * 10, a = R() * TAU;
      if (heap(base[0] - fx * back + Math.cos(a) * 3, base[1] - fz * back + Math.sin(a) * 3, R() < 0.35 ? 'rolls' : R() < 0.5 ? 'tangle' : 'mix')) k++;
    }
    // a torn length between the belt and the trench (dragged clear of a gap, blown out of the belt)
    if (sy.kind !== 'outpost' && line.length) for (let k = 0; k < 1 + (R() * 2 | 0); k++) { const p = pick(R, line), d = 6 + R() * 7; loose(p[0] + fx * d + (R() - 0.5) * 6, p[1] + fz * d + (R() - 0.5) * 6); }
  }
  for (const [x, z, ux, uz, L] of checkpoints) {   // the post beside the block: a roll or two, sandbags, the ammo
    const sd = R() < 0.5 ? -1 : 1, nx = -uz, nz = ux, along = (L / 2 + 4 + R() * 3) * sd;
    if (R() < 0.7) heap(x + ux * along + nx * (4 + R() * 3), z + uz * along + nz * (4 + R() * 3), R() < 0.6 ? 'rolls' : 'mix');
    const px = x + ux * along - nx * (3 + R() * 2), pz = z + uz * along - nz * (3 + R() * 2), ry = Math.atan2(-uz, ux);
    for (let i = 0; i < 4; i++) piece2('sandbag', px + nx * (i - 1.5) * 0.55, pz + nz * (i - 1.5) * 0.55, false, ry + Math.PI / 2 + (R() - 0.5) * 0.3);   // a low sandbag wall facing the road
    for (const [name, k] of [['crates2', 1], ['zinc', 2], ['tube', R() < 0.6 ? 2 : 0], ['jerrycan', 1]]) for (let i = 0; i < k; i++) piece2(name, px - ux * sd * (1.2 + R() * 1.5) + (R() - 0.5) * 1.2, pz - uz * sd * (1.2 + R() * 1.5) + (R() - 0.5) * 1.2, name !== 'zinc');
    mark('post', px, pz);
  }
  // ---------------------------------------------------------------- 5. debris: each heap of junk where something put it there
  const unit = v => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
  const tight = (names, x, z, rad, far = true, lip = false) => { let n = 0; for (const name of names) { for (let t = 0; t < 4; t++) { const d = rad * Math.sqrt(R()), a = R() * TAU; if (piece2(name, x + Math.cos(a) * d, z + Math.sin(a) * d, far && !/ration|bottle|casings|frag|zinc|clod/.test(name), undefined, lip)) { n++; break; } } } return n; };
  const W8 = (tbl) => { let s = 0; for (const [, p] of tbl) s += p; let u = R() * s; for (const [k, p] of tbl) if ((u -= p) < 0) return k; return tbl[0][0]; };
  for (const sy of systems) {
    const [fx, fz] = unit(sy.front);
    // the parapet: short rows of sandbags on the front lip of the fire trenches, some burst
    for (const l of sy.lines || []) for (let i = 2; i < l.length - 2; i += 6 + (R() * 7 | 0)) {
      if (R() < 0.4) continue;
      const [tx, tz] = unit([l[i + 1][0] - l[i - 1][0], l[i + 1][1] - l[i - 1][1]]);
      let d = 0.6; while (d < 3 && T.cutSDF(l[i][0] + fx * d, l[i][1] + fz * d) < 0.4) d += 0.2; if (d >= 3) continue;
      const cx = l[i][0] + fx * (d + 0.1), cz = l[i][1] + fz * (d + 0.1), n = 2 + (R() * 3 | 0), ry = Math.atan2(-tz, tx);
      for (let k = 0; k < n; k++) piece2('sandbag', cx + tx * (k - n / 2) * 0.56, cz + tz * (k - n / 2) * 0.56, false, ry + (R() - 0.5) * 0.25, true);
      mark('parapet', cx, cz);
    }
    // the firing bays and MG pits: spent cases and empty ammo tins thrown out on the lip
    for (const s of sy.slots || []) {
      if (!(s.kind === 'mg' || R() < 0.3)) continue;
      const [sfx, sfz] = unit([s.fx, s.fz]); let d = 0.6; while (d < 2.5 && T.cutSDF(s.x + sfx * d, s.z + sfz * d) < 0.3) d += 0.2;
      const side = R() < 0.5 ? -1 : 1, x = s.x + sfx * (d + 0.2) - sfz * side * 0.6, z = s.z + sfz * (d + 0.2) + sfx * side * 0.6;
      tight(s.kind === 'mg' ? ['casings', 'zinc', 'zinc'] : ['casings', R() < 0.4 ? 'zinc' : 'ration'], x, z, 0.6, true, true);
    }
    // the dugouts: stores stacked by the door (crates, tins, tubes, a jerrycan), the kit of the men inside
    for (const dg of sy.dugouts || []) {
      const [dx, dz] = unit(dg.dir || [-fx, -fz]), [px, pz] = dg.door || [dg.x, dg.z];
      for (const sd of [-1, 1]) {
        if (R() < 0.35) continue;
        const x = px + dx * 1.6 - dz * sd * 2.3, z = pz + dz * 1.6 + dx * sd * 2.3;
        tight(R() < 0.5 ? ['crates2', 'zinc', 'zinc', 'tube', 'ration'] : ['crate', 'crate', 'jerrycan', 'zinc', 'bottle', R() < 0.5 ? 'pack' : 'mat'], x, z, 1.1, true, true);
        mark('stores', x, z);
      }
    }
    // the communication trenches: a trail of litter along them (rations, bottles, tins, a burst bag, planks)
    for (const c of sy.comms || []) for (let i = 1, side = 1; i < c.length; i++) {
      const [ax, az] = c[i - 1], [bx, bz] = c[i], L = Math.hypot(bx - ax, bz - az); if (L < 0.5) continue; const ux = (bx - ax) / L, uz = (bz - az) / L;
      for (let t = 2 + R() * 4; t < L; t += 4 + R() * 5) {
        side = -side; let d = 0.7; const x0 = ax + ux * t, z0 = az + uz * t;
        while (d < 2.5 && T.cutSDF(x0 - uz * side * d, z0 + ux * side * d) < 0.3) d += 0.2;
        piece2(W8([['ration', 3], ['bottle', 3], ['zinc', 2], ['plank', 1], ['sandbag', 1], ['casings', 1]]), x0 - uz * side * (d + 0.2), z0 + ux * side * (d + 0.2), false, undefined, true);
      }
    }
    // spent tubes where the AT team fired from (a flank of the position), a shot-down FPV drone in front
    if (sy.kind !== 'outpost' || R() < 0.5) { const l = (sy.lines || [])[0]; if (l?.length) { const p = R() < 0.5 ? l[0] : l[l.length - 1]; let d = 1; while (d < 4 && T.cutSDF(p[0] - fx * d, p[1] - fz * d) < 0.3) d += 0.25; const x = p[0] - fx * (d + 0.6), z = p[1] - fz * (d + 0.6); tight(['tube', 'tube', R() < 0.6 ? 'tube' : 'crate', 'crate'], x, z, 1.4, true, true); mark('tubes', x, z); } }
    if (R() < 0.45) { const a = R() * TAU, d = sy.radius * 0.5 + 8 + R() * 10; tight(['fpv', 'frag'], sy.center[0] + fx * d + Math.cos(a) * 6, sy.center[1] + fz * d + Math.sin(a) * 6, 0.8); }
  }
  // craters: fragments and clods of thrown soil round the rim; Grad motors stuck where a salvo came down, mortar tails
  let nCr = 0;
  for (const c of crs) {
    if (nCr > 320) break; const h = heatAt(w, c[0], c[1]); if (h < 0.3 || R() > 0.32 * h) continue;
    const r = c[2], n = 4 + (R() * 5 | 0), a0 = R() * TAU;
    for (let k = 0; k < n; k++) { const a = a0 + k / n * TAU + (R() - 0.5) * 0.6, d = r * (0.95 + R() * 0.55); piece2('clod', c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d, false); }
    if (R() < 0.7) { const a = R() * TAU, d = r * (1.1 + R() * 0.6); piece2('frag', c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d, false); }
    if (rural && r > 1.2 && R() < 0.12) { const a = R() * TAU, d = r * (0.3 + R() * 0.5); if (piece2('gradTail', c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d, true)) mark('grad', c[0], c[1]); }
    else if (r < 1.4 && R() < 0.1) piece2('mortarTail', c[0] + (R() - 0.5) * r, c[1] + (R() - 0.5) * r, false);
    nCr++;
  }
  // knocked-out armour: the thrown track lying out behind it in line with the hull, road wheels by it, ERA tiles and
  // fragments blown round the turret ring
  const wreckM = []; for (const P of PLACED) if (/_hull_wreck_static$/.test(P.template?.name || '')) for (const M of P.matrices) wreckM.push(M);
  for (const [x, z] of w.wreckSpots || []) {
    const M = wreckM.find(m => Math.abs(m.elements[12] - x) < 0.6 && Math.abs(m.elements[14] - z) < 0.6), e = M?.elements;
    const [ax, az] = e ? unit([e[8], e[10]]) : unit([Math.cos(R() * TAU), 1]), side = R() < 0.5 ? -1 : 1, back = R() < 0.6 ? -1 : 1;
    const sx = x + ax * back * 3.6 - az * side * 1.5, sz = z + az * back * 3.6 + ax * side * 1.5;
    if (free(sx, sz, 0.3) && guard(() => { D.begin(sx, H(sx, sz) - 0.01, sz, Math.atan2(-az * back, ax * back), 0, 0, 1, true); PC.links(D, R); })) stats.pieces++;
    for (let k = 0; k < 1 + (R() * 2 | 0); k++) piece2('wheel', x - az * side * (2.6 + R() * 1.5) + ax * (R() - 0.5) * 5, z + ax * side * (2.6 + R() * 1.5) + az * (R() - 0.5) * 5, true);
    for (let k = 0; k < 3 + (R() * 4 | 0); k++) { const a = R() * TAU, d = 2.4 + R() * 3.5; piece2(R() < 0.6 ? 'era' : 'frag', x + Math.cos(a) * d, z + Math.sin(a) * d, false); }
    mark('wreck', x, z);
  }
  // wrecked / burnt houses: bricks, timber and broken slates thrown out on the side the shell came from... the roof
  // sheets carried off downwind
  const WIND = [0.62, -0.78], houses = [];
  for (const [x, z, d] of w.houseSpots || []) if (d) houses.push([x, z, 5]);
  for (const [x, z, r] of w.burntSpots || []) if (r <= 10) houses.push([x, z, r * 0.6 + 2.5]);
  for (const [x, z, r] of houses) {
    const hit = hash2(x, z, 31) * TAU, n = 5 + (R() * 5 | 0);
    for (let k = 0; k < n; k++) { const a = hit + (R() - 0.5) * 1.6, d = r + 0.5 + R() * R() * 5, nm = W8([['brick', 4], ['plank', 2], ['beam', 1], ['chunk', 1], ['sheet', 1]]); piece2(nm, x + Math.cos(a) * d, z + Math.sin(a) * d, nm === 'beam'); }   // (far copy: the beams only -- bricks / chunks are sub-pixel at 50+ m)
    for (let k = 0; k < 1 + (R() * 3 | 0); k++) { const d = r + 1 + R() * 6, o = (R() - 0.5) * r * 1.4; piece2('sheet', x + WIND[0] * d - WIND[1] * o, z + WIND[1] * d + WIND[0] * o, true); }
    mark('house', x + Math.cos(hit) * r, z + Math.sin(hit) * r);
  }
  for (const b of w.buildings || []) {   // panel blocks: under each blown-out panel, the frames, slabs and rebar it dropped
    if (!b.toWorld || !b.panels || !b.panelCenter || !b.outward) continue;
    const ps = b.panels.filter(p => p.state >= 2 && p.floor <= 5); let n = 0;
    for (const p of ps) {
      if (n > 5 || R() < 0.5) continue; const c = b.panelCenter(p), o = b.outward(p), d = 2 + R() * 3 + p.floor * 0.4;
      if (tight(['window', 'chunk', 'rebar', R() < 0.5 ? 'plank' : 'brick'], c.x + o.x * d, c.z + o.z * d, 1.6, false)) n++;   // (near only: small stuff)
    }
  }
  // fallen branches under the shelled / stripped trees (only there)
  const treeAt = [];
  for (const P of PLACED) { const n = P.template?.name || ''; if (!/^(tree_|stump_)/.test(n) || /_lod\d*$|_mid$/.test(n) || !/shattered|shelled|stump|stripped|broken|snapped/.test(n)) continue; for (const M of P.matrices) treeAt.push([M.elements[12], M.elements[14]]); }
  let nBr = 0;
  for (const [x, z] of treeAt) {
    if (nBr > 300) break; if (R() > 0.12 + 0.3 * heatAt(w, x, z)) continue;
    const a = R() * TAU, d = 1 + R() * 2.5; tight(['branch', 'branch', R() < 0.5 ? 'branch' : 'frag'], x + Math.cos(a) * d, z + Math.sin(a) * d, 1.2); nBr++;
    if (R() < 0.2) scorch.push([x, z, 2.5 + R() * 2, 0.3]);
  }
  // tops of the snapped belt trees (treeFate), lying from their stumps the way the blast threw them
  for (const [x, z] of w._bfTops || []) mark('stump', x, z);
  for (const [x, z, a, k] of w._bfTops || []) { const px = x + Math.cos(a) * 0.4, pz = z + Math.sin(a) * 0.4; if (T.cutSDF(px, pz) < 1) continue; { let bad = false; for (let t = 0; t <= 7.5 * k + 0.6 && !bad; t += 0.8) bad = T.cutSDF(px + Math.cos(a) * t, pz - Math.sin(a) * t) < 0.8 || T.cutSDF(px + Math.cos(a) * t, pz + Math.sin(a) * t) < 0.8; if (bad) continue; }   /* (v9: not across a trench) */ if (w.railGap) { let bad = false; for (let t = 0; t <= 7.5 * k + 0.6 && !bad; t += 0.8) bad = w.railGap(px + Math.cos(a) * t, pz - Math.sin(a) * t) < 2.6 || w.railGap(px + Math.cos(a) * t, pz + Math.sin(a) * t) < 2.6; if (bad) continue; }   /* (streets v4: never across a track bed) */ if (w.paved) { let bad = false; for (let t = 0; t <= 7.5 * k + 0.6 && !bad; t += 0.8) bad = w.paved.paved(px + Math.cos(a) * t, pz - Math.sin(a) * t) < 0.3 || w.paved.paved(px + Math.cos(a) * t, pz + Math.sin(a) * t) < 0.3; if (bad) continue; }   /* (streets v2: never across a pavement / kerb) */ if (guard(() => { D.begin(px, H(px, pz) - 0.03, pz, -a, 0, (R() - 0.5) * 0.06, 1, k > 0.8); PC.log(D, R, k); })) stats.pieces++; }   // (far copy: the big trunks only)
  // root plates of the uprooted belt trees (treeFate): at the trunk's root end (template z -4.4, its plate normal along the
  // trunk), the hole beside it on the far side
  const RP0 = new THREE.Matrix4().makeTranslation(0.08, 1.13, -4.38), HV = new THREE.Vector3();
  for (const M of w._bfRoots || []) {
    const Mp = M.clone().multiply(RP0), e = Mp.elements; D.begin(e[12], e[13], e[14], 0, 0, 0, 1, true); D.M.copy(Mp); D.y0 = H(e[12], e[14]); rootPlate(D, R); stats.pieces++;
    HV.set(0.08, 0, -5.7).applyMatrix4(M); if (T.cutSDF(HV.x, HV.z) > 2.5) w.addCrater?.(HV.x, HV.z, 2.4 + R() * 0.8, 0);
    mark('roots', e[12], e[14]);
  }
  // map-specific debris (w.bfExtra: e.g. ruins.js -- the real-place maps' ruins): written into the same per-cell buffers
  // (no extra draw calls), with their own RNG (bf's stream is not touched), after everything above has claimed its ground
  for (const f of w.bfExtra || []) try { f({ D, PC, H, free, claim, taken, scorch, stats, mark, inBuilding, guard }); } catch (e) { console.warn('bfExtra', e); }
  // ---------------------------------------------------------------- 6. scorched patches (war map scorch channel)
  for (let i = 0, made = 0; i < 900 && made < (rural ? 90 : 30); i++) { const x = (R() - 0.5) * MAP_SIZE * 0.95, z = (R() - 0.5) * MAP_SIZE * 0.95, h = heatAt(w, x, z); if (h < 0.5 || R() > h * 0.5 || onRoad(x, z, 1)) continue; scorch.push([x, z, 2 + R() * 5, 0.3 + R() * 0.35]); made++; }
  paintScorch(w, scorch);

  // ---------------------------------------------------------------- 7. meshes
  const [mI, mV] = wireMats();
  if (coils.length) {
    const t = [0, 1, 2].map(l => { const m = new THREE.Mesh(coilGeo(l), mI); m.name = 'bf_concertina' + (l ? '_lod' + l : ''); return m; });
    instance(scene, t[0], coils, { mid: t[1], lod: t[2], nearDist: 35, lodDist: 110, cullDist: 460, shadows: false, colors: coilCols, cell: 120 });
    for (const [ms] of PLACED[PLACED.length - 1].parts) for (const m of ms) pixHook(m);
    // run over by a vehicle (City.crushCheck: any vehicle; host side, synced like the fences -- net/battle.js 'ck'): the
    // coil is pressed flat (instance colour G = crush, read by the wire shader) and the ground it covered is a lane for men
    const map = coils.map(() => []), _c = new THREE.Color();
    for (const [ms, idx] of PLACED[PLACED.length - 1].parts) idx.forEach((gi, j) => { for (const m of ms) map[gi].push([m, j]); });
    const crush = it => {
      for (const [m, j] of map[it.coil]) { m.getColorAt(j, _c); _c.g = 1; m.setColorAt(j, _c); m.instanceColor.needsUpdate = true; }
      const [ax, az, bx, bz] = coilEnds[it.coil]; nav?.wireSeg(ax, az, bx, bz, 0.7, WIRE_COST.crushed, true);
    };
    coilEnds.forEach(([ax, az, bx, bz], i) => {
      const it = { t: null, M: new THREE.Matrix4(), x: (ax + bx) / 2, z: (az + bz) / 2, ry: Math.atan2(-(bz - az), bx - ax), hx: Math.hypot(bx - ax, bz - az) / 2, hz: 0.5, crush: 'any', type: 'wire', coil: i, wire: crush };
      (w.crushables ||= []).push(it);
      if (w.crushGrid) { const k = Math.floor(it.x / 10) + ',' + Math.floor(it.z / 10); (w.crushGrid.get(k) || w.crushGrid.set(k, []).get(k)).push(it); }   // (city map: its crushables were built before this pass)
    });
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
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2)); g.setAttribute('aMat', new THREE.Float32BufferAttribute(b.m, 2));
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
export function paintScorch(w, spots) {
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
// (debris writer, piece library and helpers for map-specific dressing: ruins.js)
export { Debris, PC, geos, G as DG, lm, col, mcol, hash2, seedOf, debrisMaterial, shatteredTpl };
