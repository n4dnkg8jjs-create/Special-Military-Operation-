import * as THREE from 'three';
import { WAR_GROUND_DECL, warGroundGLSL, warGroundHooks } from './wear.js';

// Ground look v6: one splat shader for every map (city / Avdiivka = urban, farmland / Robotyne = rural), used by
// City.groundMat and Farmland.groundMat (ground plane + trench / relief terrain mesh).
//
//   materials  generated sets (tools/textures/gen_ground.py -> assets/textures/ground/<name>_c.jpg + _n.png): albedo,
//              and one RGBA "NHR" map: slope x / z (world-space, see gen_ground.py), height, roughness.
//   weights    the painted splat (+ war map mud / wet) gives a weight per material, broken up by blend noise
//   height     the weights are resolved with the per-material height maps (score = height * HS + weight, everything
//   blending   within DEPTH of the best score shows): grass gives way to dirt between the tussocks, mud fills the
//              cracks / ruts / low spots first, gravel pokes through dust, instead of a linear cross-fade
//   anti-      two offset samples per texture picked by a slow noise (I. Quilez' "texture repetition" #3), the
//   tiling     cross-over between them follows the height too; textureGrad with the world derivatives so the branchy
//              per-material sampling below is legal and keeps its mips
//   normals    the blended slope perturbs the (world) normal (trench walls / spoil included); roughness and height
//              per material; puddles / wet ground from the war map stay on top (wear.js hooks)
//
// Cost: dirt is always sampled (4 taps), every other material only where its weight is > 0 (4 taps each; most pixels
// have 1-3 materials).  Shader-visible strings that other code patches (real.js tSoft, City.trenchTopMat) are kept:
// 'uniform sampler2D tDirt,', 'float tdep = smoothstep(0.05, 0.55, -vWPos.y);', the variables wp / dirt / col / vn and
// the final 'diffuseColor.rgb *= col;'.
export const GROUND_SETS = ['dirt', 'grass', 'mud', 'rubble', 'fallow', 'plowed', 'stubble'];
// tile size (m) per set
const TILE = { dirt: 6.0, grass: 3.2, mud: 5.0, rubble: 4.5, fallow: 4.5, plowed: 4.0, stubble: 4.0 };
// slope (normal) strength per set
const NSTR = { dirt: 0.8, grass: 0.7, mud: 0.8, rubble: 0.9, fallow: 0.8, plowed: 0.6, stubble: 0.7 };

const one = (r, g, b, a, srgb) => { const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t; };
const black = () => one(0, 0, 0, 255);

// [colour, nhr] textures of a set, with stand-ins (old texture set's albedo, flat NHR) if the files are missing
function setTex(T, name) {
  const g = T.ground?.[name];
  const c = g?.c || T[name === 'plowed' ? 'plowed' : name]?.map || one(84, 74, 60, 255, true);
  const n = g?.n || one(128, 128, 128, 235);
  for (const t of [c, n]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return [c, n];
}

const HEAD = `
  float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(gh(i), gh(i+vec2(1,0)), f.x), mix(gh(i+vec2(0,1)), gh(i+vec2(1,1)), f.x), f.y); }
  vec2 gDX, gDY;                         // world derivatives of wp (taken in uniform control flow)
  vec2 gSlope = vec2(0.0); float gRough = 1.0;
  // anti-tiled sample of one set: c = albedo + height, n = slope xy, height, roughness
  void gSample(sampler2D tc, sampler2D tn, vec2 uv, vec2 dx, vec2 dy, float seed, float rows, out vec4 c, out vec4 n) {
    float k = vn(uv * 0.21 + seed) * 5.0 + vn(uv * 0.67 - seed) * 2.0;
    float ia = floor(k), f = fract(k);
    vec2 oa = sin(vec2(3.0, 7.0) * (ia + seed)), ob = sin(vec2(3.0, 7.0) * (ia + 1.0 + seed));
    oa.x *= 1.0 - rows; ob.x *= 1.0 - rows;      // row crops: shift only along the rows
    vec4 na = textureGrad(tn, uv + oa, dx, dy), nb = textureGrad(tn, uv + ob, dx, dy);
    float b = smoothstep(0.2, 0.8, f + (nb.b - na.b) * 0.7);
    vec3 ca = textureGrad(tc, uv + oa, dx, dy).rgb, cb = textureGrad(tc, uv + ob, dx, dy).rgb;
    n = mix(na, nb, b); c = vec4(mix(ca, cb, b), n.b);
  }`;

// one material: sample when weight > 0 (or always), into c<ID> / n<ID>
function sampleGLSL(id, set, w, { uv = 'wp', swap = false, rows = false, always = false } = {}) {
  const t = TILE[set], tex = { dirt: 'tDirt', grass: 'tGrass', mud: 'tMud', rubble: 'tRubble', fallow: 'tFallow', plowed: 'tPlow', stubble: 'tStub' }[set];
  const dx = swap ? `(${swap} > 0.5 ? gDX.yx : gDX)` : 'gDX', dy = swap ? `(${swap} > 0.5 ? gDY.yx : gDY)` : 'gDY', seed = (GROUND_SETS.indexOf(set) * 1.37 + 0.4).toFixed(2);
  return `
          vec4 c${id} = vec4(0.3, 0.27, 0.22, 0.5), n${id} = vec4(0.5, 0.5, 0.5, 0.95);
          ${always ? '' : `if (${w} > 0.003)`} gSample(${tex}, ${tex}N, ${uv} / ${t.toFixed(2)}, ${dx} / ${t.toFixed(2)}, ${dy} / ${t.toFixed(2)}, ${seed}, ${rows ? '1.0' : '0.0'}, c${id}, n${id});
          ${swap ? `if (${swap} > 0.5) n${id}.xy = n${id}.yx;` : ''}
          n${id}.xy = (n${id}.xy * 2.0 - 1.0) * ${NSTR[set].toFixed(2)};`;
}
// height blend of [id, weight, colour expr, slope expr, height expr, roughness expr]
function blendGLSL(L) {
  // score = weight + texture height (cm-scale detail) + a per-material clump noise (0.3-1.5 m patches): the texture
  // height alone only ever gives a hairline edge at RTS range, the clump noise makes the tongues / islands
  const HS = '0.38', NS = '0.55', DEPTH = '0.42';
  let s = '\n          float gMx = -1.0;';
  L.forEach(([id, w, , , h], i) => { const o = (i * 7.31 + 1.7).toFixed(2); s += `\n          float s${id} = (${h}) * ${HS} + ${w} + (vn(wp * 0.85 + ${o}) * 0.6 + vn(wp * 2.6 - ${o}) * 0.4 - 0.5) * ${NS}; if (${w} > 0.003) gMx = max(gMx, s${id});`; });
  for (const [id, w] of L) s += `\n          float b${id} = max(s${id} - gMx + ${DEPTH}, 0.0) * min(${w} * 30.0, 1.0);`;
  s += `\n          float bSum = max(1e-4, ${L.map(l => 'b' + l[0]).join(' + ')});`;
  s += `\n          vec3 col = (${L.map(l => `(${l[2]}) * b${l[0]}`).join(' + ')}) / bSum;`;
  s += `\n          gSlope = (${L.map(l => `(${l[3]}) * b${l[0]}`).join(' + ')}) / bSum;`;
  s += `\n          gRough = (${L.map(l => `(${l[5]}) * b${l[0]}`).join(' + ')}) / bSum;`;
  return s;
}

// ground material for a City / Farmland host: rural = farmland splat layout (R fallow/grass, G ploughed, B stubble,
// A packed; tRows row direction), else urban (R lawn, G rubble / gravel, B mud, A trampled paths)
export function groundMaterial(host, terrain, rural, MAPSZ) {
  const T = host.assets.tex;
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0 });
  m.defines = terrain ? { TERRAIN_MESH: '' } : { GROUND_HOLE: '' };
  const key = (rural ? 'farm_' : 'city_') + (terrain ? 'terrain' : 'ground') + '_v6';
  m.customProgramCacheKey = () => key;
  const tx = {}; for (const s of GROUND_SETS) [tx[s], tx[s + 'N']] = setTex(T, s);
  const U = host.groundUniforms ||= { tSplat: { value: null }, tRows: { value: null }, splatSize: { value: MAPSZ }, tHole: { value: black() }, tWar: { value: black() } };
  const names = { dirt: 'tDirt', grass: 'tGrass', mud: 'tMud', rubble: 'tRubble', fallow: 'tFallow', plowed: 'tPlow', stubble: 'tStub' };
  for (const s of GROUND_SETS) { U[names[s]] ||= { value: tx[s] }; U[names[s] + 'N'] ||= { value: tx[s + 'N'] }; }
  U.tRows ||= { value: null }; if (!U.tRows.value) U.tRows.value = black();
  if (!U.tSplat.value) U.tSplat.value = black();
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vWPos; uniform sampler2D tDirt, tGrass, tRubble, tMud, tFallow, tPlow, tStub, tSplat, tHole, tRows;
        uniform sampler2D tDirtN, tGrassN, tRubbleN, tMudN, tFallowN, tPlowN, tStubN; uniform float splatSize;
        ${WAR_GROUND_DECL}
        ${HEAD}`)
      .replace('#include <map_fragment>', `
          vec2 wp = vWPos.xz;
          gDX = dFdx(wp); gDY = dFdy(wp);
          #ifdef GROUND_HOLE
            vec2 huv = wp / splatSize + 0.5;
            if (huv.x > 0.0 && huv.y > 0.0 && huv.x < 1.0 && huv.y < 1.0 && texture2D(tHole, huv).r > 0.5) discard;
          #endif
          vec4 warE = texture2D(tWar, clamp(wp / splatSize + 0.5, 0.001, 0.999)) * (1.0 - smoothstep(splatSize * 0.5 - 4.0, splatSize * 0.5 + 4.0, max(abs(wp.x), abs(wp.y))));
          float fine = vn(wp * 1.3), clump = vn(wp * 0.45) * 0.6 + vn(wp * 2.1) * 0.4;   // blend noise: clumps, then tussocks
          float mac = vn(wp * 0.006) * 0.55 + vn(wp * 0.021) * 0.3 + vn(wp * 0.08) * 0.15;  // macro: damp hollows / dry rises
          ${rural ? RURAL_W : URBAN_W}
          ${sampleGLSL('D', 'dirt', 'wD', { always: true })}
          vec3 dirt = cD.rgb;
          ${sampleGLSL('G', 'grass', 'wG')}
          ${sampleGLSL('M', 'mud', 'wM')}
          ${sampleGLSL('R', 'rubble', 'wR')}
          ${rural ? `${sampleGLSL('F', 'fallow', 'wF')}
          ${sampleGLSL('P', 'plowed', 'wPl', { uv: 'fp', swap: 'rowsX', rows: true })}
          ${sampleGLSL('S', 'stubble', 'wS', { uv: 'fp', swap: 'rowsX', rows: true })}` : ''}
          // late-autumn drift: drier straw / greyer wormwood patches over the sward
          float dryN = vn(wp * 0.018) * 0.6 + vn(wp * 0.07) * 0.4;
          float gL = dot(cG.rgb, vec3(0.299, 0.587, 0.114));
          cG.rgb = mix(cG.rgb, mix(vec3(gL) * vec3(1.14, 1.02, 0.74), vec3(gL) * vec3(0.98, 1.0, 0.92), smoothstep(0.55, 0.8, vn(wp * 0.045 + 7.0))), 0.05 + 0.2 * dryN);
          cG.rgb = max(vec3(0.0), vec3(gL) + (cG.rgb - vec3(gL)) * 1.4) * 1.08;   // keep the sward reading as grass (olive / straw) at RTS range
          ${blendGLSL(rural ? [
            ['D', 'wD', 'cD.rgb', 'nD.xy', 'cD.a', 'max(nD.a, 0.88)'],
            ['K', 'wK', 'mix(cD.rgb * vec3(1.1, 1.06, 0.98), vec3(dot(cD.rgb, vec3(0.33))) * vec3(1.3, 1.24, 1.1), 0.3)', 'nD.xy * 0.45', 'cD.a * 0.6 + 0.15', '0.97'],
            ['G', 'wG', 'cG.rgb', 'nG.xy', 'cG.a', 'max(nG.a, 0.88)'],
            ['F', 'wF', 'cF.rgb', 'nF.xy', 'cF.a', 'max(nF.a, 0.88)'],
            ['P', 'wPl', 'cP.rgb', 'nP.xy', 'cP.a', 'max(nP.a, 0.88)'],
            ['S', 'wS', 'cS.rgb', 'nS.xy', 'cS.a', 'max(nS.a, 0.88)'],
            ['R', 'wR', 'mix(cR.rgb, vec3(dot(cR.rgb, vec3(0.33))) * vec3(1.05, 1.0, 0.92), 0.4)', 'nR.xy', 'cR.a', 'max(nR.a, 0.88)'],
            ['M', 'wM', 'cM.rgb * vec3(1.08, 1.0, 0.9)', 'nM.xy', 'cM.a * 0.7', 'max(nM.a, 0.62)'],
            ['C', 'wC', 'cD.rgb * vec3(0.74, 0.7, 0.65) * (0.85 + 0.3 * vn(wp * 3.1))', 'nD.xy * 1.4', 'cD.a', '0.97'],
          ] : [
            ['D', 'wD', 'cD.rgb', 'nD.xy', 'cD.a', 'max(nD.a, 0.88)'],
            ['K', 'wK', 'cD.rgb * vec3(1.12, 1.08, 1.0)', 'nD.xy * 0.45', 'cD.a * 0.6 + 0.15', '0.97'],
            ['G', 'wG', 'cG.rgb', 'nG.xy', 'cG.a', 'max(nG.a, 0.88)'],
            ['R', 'wR', 'cR.rgb', 'nR.xy', 'cR.a', 'max(nR.a, 0.88)'],
            ['M', 'wM', 'cM.rgb * vec3(1.08, 1.0, 0.9)', 'nM.xy', 'cM.a * 0.7', 'max(nM.a, 0.62)'],
            ['C', 'wC', 'cD.rgb * vec3(0.74, 0.7, 0.65) * (0.85 + 0.3 * vn(wp * 3.1))', 'nD.xy * 1.4', 'cD.a', '0.97'],
          ])}
          // macro variation: damp darker hollows / dry light loess rises, per-plot tone (+ exposure match with the old
          // ground: the new sets carry cavity AO and real slope shading, which both darken on average)
          col *= (0.86 + 0.26 * mac) * 1.1;
          col = mix(col, col * vec3(1.07, 1.03, 0.92), smoothstep(0.6, 0.85, vn(wp * 0.009 + 3.0)) * 0.45);
          ${rural ? 'col *= 0.95 + 0.1 * vn(floor(wp / 40.0) * 1.7 + rowT.r);' : ''}
          #ifdef TERRAIN_MESH
            float tdep = smoothstep(0.05, 0.55, -vWPos.y);
            col = mix(col, dirt * vec3(0.5, 0.45, 0.4) * (0.85 + 0.3 * vn(wp * 2.3)), tdep);
            gSlope *= 1.0 - 0.5 * tdep;
          #endif
          ${warGroundGLSL(!rural, { mudTex: true, churnTex: true })}
          diffuseColor.rgb *= col;`);
    // war hooks first: their puddle-flattening / wet roughness lines must come after the material normal / roughness
    sh.fragmentShader = warGroundHooks(sh.fragmentShader)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 gN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);   // view -> world (rotation only)
          vec3 pn = normalize(gN + vec3(gSlope.x, 0.0, gSlope.y));
          normal = normalize((viewMatrix * vec4(pn, 0.0)).xyz);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor *= gRough;`);
  };
  return m;
}

// ---- material weights (sequential layering -> weights that sum to 1: each layer scales the ones below by 1 - a)
const LAYER = (w, a, below) => `${below.map(b => `${b} *= 1.0 - (${a});`).join(' ')} ${w} = ${a};`;
const URBAN_W = `
          vec2 wob = vec2(vn(wp * 0.21) - 0.5, vn(wp * 0.21 + 31.0) - 0.5) * 2.2;   // break up blurred mask edges
          vec4 sp = texture2D(tSplat, clamp((wp + wob) / splatSize + 0.5, 0.002, 0.998));
          float outside = smoothstep(splatSize * 0.5 - 6.0, splatSize * 0.5 + 4.0, max(abs(wp.x), abs(wp.y)));
          sp = mix(sp, vec4(smoothstep(0.35, 0.6, vn(wp * 0.03)) * 0.85, 0.0, 0.0, 0.25), outside);
          float wD = 1.0, wK = 0.0, wG = 0.0, wR = 0.0, wM = 0.0, wC = 0.0;
          ${LAYER('wK', 'sp.a * (0.75 + 0.25 * fine)', ['wD'])}
          ${LAYER('wG', 'clamp(sp.r * 1.25 - 0.1 + (clump - 0.5) * 0.45, 0.0, 1.0) * (1.0 - sp.a * 0.8)', ['wD', 'wK'])}
          ${LAYER('wR', 'clamp(sp.g * 1.4 - 0.18 + (fine - 0.5) * 0.4, 0.0, 1.0)', ['wD', 'wK', 'wG'])}
          ${LAYER('wM', 'clamp(max(sp.b * 1.15 - 0.2, smoothstep(0.3, 0.9, warE.b) * 0.6) + (vn(wp * 0.7) - 0.5) * 0.5, 0.0, 0.9)', ['wD', 'wK', 'wG', 'wR'])}
          // shell-churned earth (war map G): broken clods eat into whatever is there in ragged tongues
          ${LAYER('wC', 'smoothstep(0.3, 1.0, warE.g + (clump - 0.5) * 0.45 + (vn(wp * 0.21 + 4.0) - 0.5) * 0.5) * 0.45', ['wD', 'wK', 'wG', 'wR', 'wM'])}`;
const RURAL_W = `
          vec2 wob = vec2(vn(wp * 0.15) - 0.5, vn(wp * 0.15 + 31.0) - 0.5) * 4.0;
          vec4 sp = texture2D(tSplat, clamp((wp + wob) / splatSize + 0.5, 0.001, 0.999));
          // beyond the map: more fields (big noise patches of fallow / stubble / ploughed) instead of smeared edge pixels
          float outside = smoothstep(splatSize * 0.5 - 8.0, splatSize * 0.5 + 6.0, max(abs(wp.x), abs(wp.y)));
          float fn = vn(floor(wp / 140.0) * 1.37);
          vec4 farSp = fn < 0.4 ? vec4(0.9, 0.0, 0.0, 0.0) : fn < 0.7 ? vec4(0.1, 0.0, 1.0, 0.0) : vec4(0.05, 1.0, 0.0, 0.0);
          sp = mix(sp, farSp, outside);
          vec4 rowT = texture2D(tRows, clamp((wp + wob * 0.6) / splatSize + 0.5, 0.001, 0.999));
          float rowsX = rowT.r;
          // headlands: the outer ~10 m of every field is worked across the rows (tractor turning strip)
          float head = 1.0 - smoothstep(0.42, 0.55, rowT.g + (vn(wp * 0.11) - 0.5) * 0.2);
          if (head > 0.5) rowsX = 1.0 - rowsX;
          rowsX = step(0.5, rowsX);
          vec2 fp = rowsX > 0.5 ? wp.yx : wp;
          float gq = smoothstep(0.42, 0.68, vn(wp * 0.035 + 5.0) * 0.7 + clump * 0.3);   // grassy sward vs weedy fallow
          float wD = 1.0, wK = 0.0, wG = 0.0, wF = 0.0, wPl = 0.0, wS = 0.0, wR = 0.0, wM = 0.0, wC = 0.0;
          float aF = smoothstep(0.0, 1.0, clamp(sp.r * 1.6 - 0.3 + (clump - 0.5) * 0.45, 0.0, 1.0));
          ${LAYER('wF', 'aF', ['wD'])} wG = wF * gq; wF *= 1.0 - gq;
          ${LAYER('wPl', 'smoothstep(0.0, 1.0, clamp(sp.g * 1.6 - 0.3 + (fine - 0.5) * 0.3, 0.0, 1.0))', ['wD', 'wF', 'wG'])}
          ${LAYER('wS', 'smoothstep(0.0, 1.0, clamp(sp.b * 1.6 - 0.3 + (fine - 0.5) * 0.3, 0.0, 1.0))', ['wD', 'wF', 'wG', 'wPl'])}
          // packed tracks, yards, verges: compacted dusty soil with gravel showing through in patches
          float aK = clamp(sp.a * 0.95 + (fine - 0.5) * 0.25 * sp.a, 0.0, 1.0);
          ${LAYER('wK', 'aK', ['wD', 'wF', 'wG', 'wPl', 'wS'])}
          wR = wK * smoothstep(0.55, 0.85, vn(wp * 0.25 + 3.0) * 0.7 + fine * 0.3) * 0.7; wK -= wR;
          // mud: vehicle-churned (war map A), wet ground (war B), damp hollows; it fills the low spots first
          float aM = clamp(smoothstep(0.25, 0.8, warE.a + (clump - 0.5) * 0.35 + (vn(wp * 0.21 + 4.0) - 0.5) * 0.3) * 0.85 + smoothstep(0.4, 0.95, warE.b) * 0.45 + smoothstep(0.3, 0.16, mac) * 0.18, 0.0, 0.95);
          ${LAYER('wM', 'aM', ['wD', 'wF', 'wG', 'wPl', 'wS', 'wK', 'wR'])}
          ${LAYER('wC', 'smoothstep(0.3, 1.0, warE.g + (clump - 0.5) * 0.45 + (vn(wp * 0.21 + 4.0) - 0.5) * 0.5) * 0.45', ['wD', 'wF', 'wG', 'wPl', 'wS', 'wK', 'wR', 'wM'])}`;
