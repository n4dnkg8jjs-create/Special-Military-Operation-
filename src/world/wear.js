import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// War wear for both maps (look v2): a second splat map ("war map") painted from the finished layout, and shader
// injections that read it -- the ground (scorched / churned earth, vehicle mud, wet ground and puddles), the roads
// (ragged broken edges, potholes, repair patches, shell scars, tracked-in mud and dust), the dirt tracks (muddy ruts
// with standing water) and the buildings (ground-splash grime, rain streaks, dust, soot on wrecked walls).
//
// War map channels (RGBA8, covers MAP_SIZE, same orientation as the ground splat):
//   R scorch  -- burnt ground: burnt houses / vehicles, shell bursts, burnt stubble and tree belts
//   G churn   -- shell-churned earth: crater fields, the ground around held positions, no-man's land
//   B wet     -- damp ground / puddles: crater bottoms, ruts, low spots, yards
//   A mud     -- (rural) vehicle-churned mud along tracks, at junctions, in yards; (urban) brick / concrete dust + litter

// ---------------------------------------------------------------- GLSL
// noise helpers with their own names (the host shaders define gh / vn already)
export const WAR_NOISE = `
  float wh1(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float wn1(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(wh1(i), wh1(i+vec2(1,0)), f.x), mix(wh1(i+vec2(0,1)), wh1(i+vec2(1,1)), f.x), f.y); }
  float wfbm(vec2 p){ return wn1(p) * 0.5 + wn1(p * 2.03 + 7.1) * 0.3 + wn1(p * 4.11 + 3.3) * 0.2; }`;

// ground: call after the host shader has its final `col` (vec3), `dirt` (soil texel) and `wp` (world xz).
// Needs uniforms tWar, splatSize and `float gWet, gPud;` declared (WAR_GROUND_DECL).
export const WAR_GROUND_DECL = `uniform sampler2D tWar; float gWet = 0.0, gPud = 0.0;` + WAR_NOISE;
// opt.mudTex: the host blends a real mud texture from war A / B itself (ground.js), skip the flat mud tint here
export const warGroundGLSL = (urban, opt = {}) => `
  {
    vec2 wuv = clamp((wp + vec2(wn1(wp * 0.37) - 0.5, wn1(wp * 0.37 + 17.0) - 0.5) * 1.6) / splatSize + 0.5, 0.001, 0.999);
    vec4 war = texture2D(tWar, wuv);
    float inMap = 1.0 - smoothstep(splatSize * 0.5 - 4.0, splatSize * 0.5 + 4.0, max(abs(wp.x), abs(wp.y)));
    war *= inMap;
    float nA = wfbm(wp * 0.55), nB = wn1(wp * 3.1), nC = wn1(wp * 9.7);
    // shell-churned earth: dark broken clods, lighter upturned subsoil (loess) flecks, crumbs
    float nW = wfbm(wp * 0.21 + 4.0);   // metre-scale break-up of the soft war-map ramps
    float ch = smoothstep(0.12, 0.95, war.g + (nA - 0.5) * 0.6 + (nW - 0.5) * 0.55);
    float clod = wn1(wp * 3.1 + 2.0) * 0.7 + nC * 0.3;
    vec3 cb = col;   // relative to what is there: churned earth is darker, with lighter subsoil flecks
    vec3 churn = cb * mix(vec3(0.74, 0.66, 0.56), vec3(1.0, 0.93, 0.82), smoothstep(0.4, 0.75, clod));   // warm turned soil, not grey
    churn = mix(churn, cb * vec3(1.15, 1.08, 0.94), smoothstep(0.66, 0.88, wfbm(wp * 0.6 + 9.0)) * 0.35);   // loess / subsoil thrown up
    churn *= 0.85 + 0.3 * nB;
    col = mix(col, churn, ch * ${opt.churnTex ? '0.4' : '0.6'});   // churnTex: the host already blends churned clods (ground.js)
    ${urban ? `
    // brick / concrete dust and small debris
    float du = smoothstep(0.3, 0.9, war.a + (nB - 0.5) * 0.55 + (nA - 0.5) * 0.3);
    vec3 dust = mix(vec3(0.23, 0.22, 0.205), vec3(0.26, 0.2, 0.16), step(0.72, wn1(wp * 4.0))) * (0.8 + 0.35 * nC);
    col = mix(col, dust, du * 0.35);
    col = mix(col, vec3(0.12, 0.115, 0.11), du * step(0.85, wh1(floor(wp * 6.0))) * 0.6);` : opt.mudTex ? '' : `
    // vehicle mud: dark compacted soil, lug prints
    float md = smoothstep(0.15, 0.75, war.a + (nB - 0.5) * 0.45 + (nA - 0.5) * 0.25);
    vec3 mud = dirt * vec3(0.5, 0.45, 0.39) * (0.8 + 0.4 * wn1(wp * vec2(4.0, 1.3)));
    col = mix(col, mud, md * 0.72);`}
    // scorch: charcoal, grey-white ash patches, burnt stubble ends at the edge of the burn
    float isl = wfbm(wp * 0.09 + 13.0);   // unburnt islands / fingers of the burn
    float sc = smoothstep(0.25, 0.75, war.r + (nA - 0.5) * 0.5 + (isl - 0.5) * 0.55 + (nW - 0.5) * 0.4 + (nB - 0.5) * 0.15);
    vec3 burnt = mix(vec3(0.06, 0.055, 0.05), vec3(0.12, 0.115, 0.108), smoothstep(0.55, 0.85, wfbm(wp * 0.35 + 5.0)) * 0.6);   // charcoal, a little grey ash
    burnt = mix(burnt, col * vec3(0.42, 0.36, 0.3), smoothstep(0.55, 0.8, wn1(wp * 2.4 + 1.0)) * 0.35) * (0.8 + 0.4 * nC);   // half-burnt stalks
    float rim = smoothstep(0.0, 0.25, sc) * (1.0 - smoothstep(0.35, 0.7, sc));
    col = mix(col, col * vec3(0.55, 0.47, 0.38), rim * 0.6);   // singed, browned edge of the burn
    col = mix(col, burnt, smoothstep(0.2, 0.95, sc) * smoothstep(0.2, 0.95, sc) * 0.7);   // gradual: charcoal only in the heart of the burn
    // damp ground and standing water
    gWet = smoothstep(0.25, 0.9, war.b + (nA - 0.5) * 0.4 + (nW - 0.5) * 0.3);
    gPud = smoothstep(0.74, 0.8, war.b * 0.7 + wn1(wp * 0.31 + 3.0) * 0.3 + wn1(wp * 1.7) * 0.1) * smoothstep(0.6, 0.75, war.b);
    col *= 1.0 - 0.18 * gWet;
    // murky, silty water: brown-grey body (the env map adds the overcast sky on top at low roughness)
    col = mix(col, col * 0.45 + vec3(0.012, 0.013, 0.014), gPud * 0.9);
  }`;
// roughness / normal hooks for the ground (puddles are mirror-flat)
export function warGroundHooks(fs) {
  return fs.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, 0.75, gWet * 0.55); roughnessFactor = mix(roughnessFactor, 0.4, gPud);`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      normal = normalize(mix(normal, normalize(vNormal), gPud));`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      reflectedLight.indirectSpecular *= 1.0 - 0.9 * gPud; reflectedLight.directSpecular *= 1.0 - 0.92 * gPud;   // muddy water: dull sheen, no sun glare`);
}

// ---------------------------------------------------------------- war map painting
// city: City / Farmland instance (after craters + buildings + fortifications). Returns the DataTexture.
export function paintWar(city, MAP_SIZE, opt = {}) {
  const N = opt.N || 1024, k = N / MAP_SIZE, o = MAP_SIZE / 2, R = city.rng;
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.strokeStyle = '#fff'; x.lineCap = 'round'; x.lineJoin = 'round'; return x; };
  const L = { r: mk(), g: mk(), b: mk(), a: mk() };
  const P = (x, z) => [(x + o) * k, (z + o) * k];
  // soft ragged blob: radial fade (dense core, feathered rim) inside a noisy outline, plus a few smaller satellite
  // splotches, so churn / scorch / mud patches break up into the ground instead of reading as flat polygons
  const blob1 = (ctx, x, z, r, alpha, ragged) => {
    const [cx, cz] = P(x, z), R0 = r * (1 + ragged * 0.5) * k;
    const g = ctx.createRadialGradient(cx, cz, 0, cx, cz, Math.max(1, R0));
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.45, 'rgba(255,255,255,0.85)'); g.addColorStop(0.8, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save(); ctx.fillStyle = g; ctx.globalAlpha = Math.min(1, alpha); ctx.beginPath(); const n = 28, ph = R() * 6.28;
    for (let i = 0; i <= n; i++) { const a = i / n * 6.28, rr = r * (1 - ragged * 0.5 + ragged * city.noise2(Math.cos(a + ph) * 1.8 + x * 0.1, Math.sin(a + ph) * 1.8 + z * 0.1, 21)) * (1 + ragged * 0.5); const [px, pz] = P(x + Math.cos(a) * rr, z + Math.sin(a) * rr); i ? ctx.lineTo(px, pz) : ctx.moveTo(px, pz); }
    ctx.fill(); ctx.restore();
  };
  const blob = (ctx, x, z, r, alpha, ragged = 0.45) => {
    blob1(ctx, x, z, r, alpha, ragged);
    if (r > 1.2) { const m = 2 + Math.floor(R() * 3); for (let i = 0; i < m; i++) { const a = R() * 6.28, d = r * (0.55 + R() * 0.5), rs = r * (0.18 + R() * 0.25); blob1(ctx, x + Math.cos(a) * d, z + Math.sin(a) * d, rs, alpha * (0.5 + R() * 0.4), 0.6); } }
  };
  const api = { L, P, k, blob, line(ctx, pts, w, alpha) { ctx.globalAlpha = alpha; ctx.lineWidth = w * k; ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(...P(p[0], p[1])) : ctx.moveTo(...P(p[0], p[1]))); ctx.stroke(); } };
  // craters: churned ring, scorched core on the big ones, water in the bottom
  const cm = city.craterMesh, M = new THREE.Matrix4(), v = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  if (cm) for (let i = 0; i < cm.count; i++) {
    cm.getMatrixAt(i, M); M.decompose(v, q, s); const r = s.x * 0.5;   // decal radius
    blob(L.g, v.x, v.z, r * 0.95, 0.38);
    if (r > 1.6) blob(L.r, v.x, v.z, r * 0.5, 0.2 + Math.min(0.25, r * 0.03));   // scorched core only on the big ones, never a black disc
    if (R() < (opt.craterWet ?? 0.3)) blob(L.b, v.x, v.z, r * 0.3, 0.8, 0.3);
  }
  // held positions: the ground all round a strongpoint is churned and trampled
  for (const t of city.trenchSystems || []) {
    blob(L.g, t.center[0], t.center[1], t.radius + 18, 0.28, 0.6);
    for (const d of t.dugouts || []) blob(L.a, d.x, d.z, 5, 0.45);
  }
  opt.extra?.(api);
  // blur once per layer, pack
  const read = (ctx, px) => { const c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d'); x.filter = `blur(${px}px)`; x.drawImage(ctx.canvas, 0, 0); return x.getImageData(0, 0, N, N).data; };
  // wide blur (ground look v6): the ground shaders push these soft ramps around with noise, so the edges come out
  // ragged at several scales instead of following the painted polygons
  const r = read(L.r, 2.2 * k + 0.5), g = read(L.g, 2.8 * k + 0.5), b = read(L.b, 1.6 * k + 0.5), a = read(L.a, 2.4 * k + 0.5);
  const out = new Uint8Array(N * N * 4);
  for (let i = 0, n = N * N; i < n; i++) { const p = i * 4; out[p] = r[p]; out[p + 1] = g[p]; out[p + 2] = b[p]; out[p + 3] = a[p]; }
  const t = new THREE.DataTexture(out, N, N, THREE.RGBAFormat); t.flipY = false; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  city.warData = out; city.warN = N;
  return t;
}
// CPU lookup of the war map (0..1 per channel) at world (x, z)
export function warAt(city, MAP_SIZE, x, z, ch) {
  const d = city.warData; if (!d) return 0; const N = city.warN, i = Math.floor((x / MAP_SIZE + 0.5) * N), j = Math.floor((z / MAP_SIZE + 0.5) * N);
  if (i < 0 || j < 0 || i >= N || j >= N) return 0; return d[(j * N + i) * 4 + ch] / 255;
}
export const blackTex = () => { const t = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat); t.needsUpdate = true; return t; };

// ---------------------------------------------------------------- roads
// Per-vertex road frame for the wear shader: aRoad = (across [m from the centre line], half width, along-x flag).
export function roadFrame(geo, halfW, horiz) {
  const pos = geo.attributes.position, a = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) { const across = horiz ? pos.getZ(i) : pos.getX(i); a[i * 3] = Math.sign(across) * halfW; a[i * 3 + 1] = halfW; a[i * 3 + 2] = horiz ? 1 : 0; }
  geo.setAttribute('aRoad', new THREE.BufferAttribute(a, 3)); return geo;
}
// Asphalt wear. opts: rural (ragged, crumbling edges, gravel shoulder, heavier potholing) | urban (gutter dirt at the
// kerb, debris dust). U: shared uniforms {tWar, splatSize}. The host material keeps its own albedo / normal / ORM.
export function roadWear(mat, U, { rural = false, damage = 1 } = {}) {
  mat.customProgramCacheKey = () => 'roadwear_' + (rural ? 'r' : 'u') + damage;
  mat.onBeforeCompile = sh => {
    sh.uniforms.tWar = U.tWar; sh.uniforms.splatSize = U.splatSize;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aRoad; varying vec3 vRoad; varying vec3 vRW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRoad = aRoad; vRW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vRoad; varying vec3 vRW; uniform sampler2D tWar; uniform float splatSize; float rPud = 0.0, rWet = 0.0, rHole = 0.0;
      ${WAR_NOISE}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        vec2 wp = vRW.xz; float hw = vRoad.y, edge = hw - abs(vRoad.x);
        vec2 al = vRoad.z > 0.5 ? wp : wp.yx;   // x = along the road, y = across
        vec4 war = texture2D(tWar, clamp(wp / splatSize + 0.5, 0.001, 0.999));
        float D = ${damage.toFixed(2)};
        float n1 = wfbm(wp * 0.6), n2 = wn1(wp * 2.7), n3 = wn1(wp * 11.0);
        vec3 c = diffuseColor.rgb;
        float lum = dot(c, vec3(0.3, 0.59, 0.11));
        c = mix(c, vec3(lum) * vec3(1.02, 1.0, 0.96), 0.35);                 // sun-bleached, oxidised binder
        // repair patches of different age (axis-aligned, sharp edged)
        vec2 pc = floor(al / vec2(4.3, 2.1) + vec2(0.0, 0.5));
        float pr = wh1(pc * 1.37 + 3.0), pa = wh1(pc + 9.1);
        vec2 pf = fract(al / vec2(4.3, 2.1) + vec2(0.0, 0.5));
        float patchM = step(0.01, D) * step(0.86, pr) * step(0.12, pf.x) * step(pf.x, 0.88) * step(0.15, pf.y) * step(pf.y, 0.85);
        c = mix(c, c * mix(0.62, 1.15, pa), patchM * 0.8);
        // wheel paths: polished, slightly darker strips in each lane
        float lanes = ${rural ? 'hw > 2.6 ? 1.0 : 0.0' : '1.0'};
        float wpth = exp(-pow((abs(vRoad.x) - hw * 0.5) / 0.6, 2.0)) * lanes * step(0.01, D);
        c *= 1.0 - 0.07 * wpth;
        // tyre marks / skids and oil drips
        c *= 1.0 - 0.12 * smoothstep(0.7, 0.9, wn1(vec2(al.x * 0.05, al.y * 3.0))) * wpth;
        c = mix(c, vec3(0.06), smoothstep(0.8, 0.95, wn1(wp * 1.3 + 4.0)) * (1.0 - wpth) * 0.35);
        // dust film, heavier towards the edges / kerb (wind-blown soil, sand from the verges)
        float dustE = 1.0 - smoothstep(0.0, ${rural ? '1.6' : '0.9'}, edge + (n2 - 0.5) * 0.8);
        vec3 dustC = mix(vec3(lum), vec3(0.36, 0.33, 0.28), 0.6) * (0.8 + 0.35 * n3);
        c = mix(c, dustC, clamp(dustE * ${rural ? '0.75' : '0.6'} + smoothstep(0.45, 0.85, n1) * 0.18, 0.0, 1.0));
        ${rural ? `
        // crumbling edge: broken asphalt lumps and gravel shoulder where the edge has gone
        float crumble = 0.55 * wfbm(al * vec2(0.35, 1.0)) + 0.35 * n3;
        if (edge < crumble * D - 0.05) discard;
        c = mix(c, c * 0.72, smoothstep(0.35, 0.0, edge - crumble * D) * 0.6);` : ''}
        // potholes (rarer in the town), each with a broken rim and muddy water
        float ph = wn1(wp * 0.38 + 11.0) * 0.6 + wn1(wp * 1.3) * 0.28 + n3 * 0.12;
        float thr = ${rural ? '0.79' : '0.84'} - 0.06 * D;
        rHole = smoothstep(thr, thr + 0.02, ph) * step(0.35, edge) * step(0.01, D);
        float rimH = smoothstep(thr - 0.05, thr, ph) * (1.0 - rHole) * step(0.01, D);
        c = mix(c, c * 0.62, rimH * 0.7);
        c = mix(c, vec3(0.2, 0.18, 0.15) * (0.7 + 0.5 * n3), rHole);
        // shell scars from the war map (churned / cratered cells), cracked and gravelly
        float sc = smoothstep(0.3, 0.75, war.g + (n1 - 0.5) * 0.4);
        c = mix(c, c * vec3(0.7, 0.68, 0.64) * (0.8 + 0.5 * n3), sc * 0.75);
        c = mix(c, vec3(0.05, 0.045, 0.04), smoothstep(0.35, 0.8, war.r + (n1 - 0.5) * 0.4) * 0.8);
        ${rural ? `
        // tracked-in mud: smeared along the road from the field tracks and the fields
        float mud = smoothstep(0.2, 0.7, war.a + (wn1(vec2(al.x * 0.12, al.y * 0.9)) - 0.5) * 0.5) * (0.5 + 0.5 * wpth);
        c = mix(c, vec3(0.2, 0.17, 0.13) * (0.75 + 0.5 * n2), mud * 0.85);` : `
        // brick / concrete dust and grit from the shelled blocks
        float du = smoothstep(0.3, 0.85, war.a + (n2 - 0.5) * 0.45 + (n1 - 0.5) * 0.3);
        c = mix(c, mix(vec3(0.3, 0.29, 0.27), vec3(0.32, 0.25, 0.2), step(0.7, wn1(wp * 3.0))) * (0.8 + 0.35 * n3), du * 0.45);
        c = mix(c, vec3(0.1, 0.095, 0.09), du * step(0.82, wh1(floor(wp * 7.0))) * 0.55);
        // leaf litter / mud at the kerb
        c = mix(c, vec3(0.24, 0.2, 0.15) * (0.7 + 0.6 * n3), (1.0 - smoothstep(0.0, 0.45, edge)) * 0.5);`}
        rWet = clamp(smoothstep(0.2, 0.8, war.b) * 0.8 + rHole, 0.0, 1.0);
        rPud = max(rHole * smoothstep(0.45, 0.7, n2 + war.b * 0.5), smoothstep(0.7, 0.75, war.b * 0.7 + wn1(wp * 0.4 + 2.0) * 0.35) * step(0.5, war.b));
        c *= 1.0 - 0.3 * rWet;
        c = mix(c, c * 0.45 + vec3(0.012, 0.013, 0.014), rPud * 0.9);
        diffuseColor.rgb = c;
      }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, 0.6, rWet * 0.6); roughnessFactor = mix(roughnessFactor, 0.4, rPud);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      normal = normalize(mix(normal, normalize(vNormal), rPud));`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      reflectedLight.indirectSpecular *= 1.0 - 0.9 * rPud; reflectedLight.directSpecular *= 1.0 - 0.92 * rPud;`);
  };
  return mat;
}

// Dirt track strips (u across the strip 0..1, ruts at u ~0.36 / 0.64; v along): darker, muddier, water in the ruts.
export function trackWear(mat, U) {
  mat.customProgramCacheKey = () => 'trackwear';
  const base = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    base?.(sh, r);
    sh.uniforms.tWar = U.tWar; sh.uniforms.splatSize = U.splatSize;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vTW; varying vec2 vTUv;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTW = (modelMatrix * vec4(transformed, 1.0)).xyz; vTUv = uv;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vTW; varying vec2 vTUv; uniform sampler2D tWar; uniform float splatSize; float tPud = 0.0, tWet = 0.0;
      ${WAR_NOISE}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        vec2 wp = vTW.xz; float u = vTUv.x, v = vTUv.y;
        vec4 war = texture2D(tWar, clamp(wp / splatSize + 0.5, 0.001, 0.999));
        float n1 = wfbm(wp * 0.5), n3 = wn1(wp * 9.0);
        float rut = exp(-pow((u - 0.36) / 0.06, 2.0)) + exp(-pow((u - 0.64) / 0.06, 2.0));
        float hump = exp(-pow((u - 0.5) / 0.07, 2.0));
        vec3 c = diffuseColor.rgb;
        c = mix(c, c * vec3(0.62, 0.58, 0.52), rut * 0.55);                              // churned, darker wheel ruts
        float mud = smoothstep(0.1, 0.7, war.a * 0.9 + n1 * 0.35 + war.b * 0.3);
        c = mix(c, vec3(0.17, 0.145, 0.115) * (0.75 + 0.5 * n3), mud * (0.35 + 0.55 * rut) * 0.9);
        tWet = clamp(rut * (0.35 + war.b * 0.5 + mud * 0.4), 0.0, 1.0);
        tPud = rut * smoothstep(0.7, 0.76, wn1(vec2(v * 1.3, u * 3.0) + wp * 0.01) * 0.6 + war.b * 0.3 + mud * 0.2);
        c *= 1.0 - 0.32 * tWet;
        c = mix(c, c * 0.45 + vec3(0.012, 0.013, 0.014), tPud * 0.9);
        c = mix(c, c * vec3(1.06, 1.02, 0.92), hump * 0.3 * (1.0 - mud));               // drier, grassy centre hump
        c = mix(c, vec3(0.05, 0.045, 0.04), smoothstep(0.35, 0.8, war.r + (n1 - 0.5) * 0.4) * 0.8);
        diffuseColor.rgb = c;
      }`)
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
      {
        // ragged verge instead of the straight alpha ramp: grass tufts and crumbled edge eat into the strip, the strip
        // frays out into the field in tongues of mud / wheel spill (ground look v6)
        float e = min(vTUv.x, 1.0 - vTUv.x);
        float rag = wfbm(vTW.xz * 0.7) * 0.65 + wn1(vTW.xz * 3.7) * 0.35;
        diffuseColor.a = smoothstep(0.0, 1.0, clamp((e - 0.015 - rag * 0.15) / 0.07, 0.0, 1.0));
      }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      roughnessFactor = mix(roughnessFactor, 0.65, tWet * 0.5); roughnessFactor = mix(roughnessFactor, 0.4, tPud);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      normal = normalize(mix(normal, normalize(vNormal), tPud));`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      reflectedLight.indirectSpecular *= 1.0 - 0.9 * tPud; reflectedLight.directSpecular *= 1.0 - 0.92 * tPud;`);
  };
  return mat;
}

// ---------------------------------------------------------------- building / prop weathering
// Ground-splash grime at the wall foot, rain / soot streaks down vertical faces, dust on horizontal tops, a general
// dirt + desaturation pass; `soot` adds heavier smoke-blackening rising up the walls (wrecked / burnt pieces).
export function weatherMaterial(m, { amount = 1, soot = 0, key = 'w' } = {}) {
  if (!m || m.userData?.weathered || !m.isMeshStandardMaterial) return m;
  m.userData.weathered = true;
  const prevKey = m.customProgramCacheKey?.bind(m), base = m.onBeforeCompile;
  m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '_wx_' + key;
  m.onBeforeCompile = (sh, r) => {
    base?.(sh, r);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWxP; varying vec3 vWxN;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec4 wxp = vec4(transformed, 1.0); vec3 wxn = objectNormal;
          #ifdef USE_INSTANCING
            wxp = instanceMatrix * wxp; wxn = mat3(instanceMatrix) * wxn;
          #endif
          vWxP = (modelMatrix * wxp).xyz; vWxN = normalize(mat3(modelMatrix) * wxn);
        }`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vWxP; varying vec3 vWxN; ${WAR_NOISE}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        float A = ${amount.toFixed(2)}, S = ${soot.toFixed(2)};
        vec3 c = diffuseColor.rgb; float up = vWxN.y, vert = 1.0 - abs(up);
        float hz = dot(vWxP.xz, vec2(0.71, 0.71)) + vWxP.x * 0.3;   // coordinate along the wall
        float lum = dot(c, vec3(0.3, 0.59, 0.11));
        c = mix(c, vec3(lum) * vec3(1.0, 0.98, 0.94), 0.18 * A);                 // weathered, faded paint / plaster
        // ground splash: mud and dust kicked up the wall foot
        float gs = 1.0 - smoothstep(0.05, 0.75 + wn1(vec2(hz * 1.3, 0.0)) * 0.8, vWxP.y);
        c = mix(c, c * vec3(0.6, 0.55, 0.48), gs * vert * 0.75 * A);
        // rain / soot streaks running down from sills and joints
        float st = wn1(vec2(hz * 3.1, vWxP.y * 0.22)) * 0.7 + wn1(vec2(hz * 11.0, vWxP.y * 0.5)) * 0.3;
        c *= 1.0 - 0.22 * smoothstep(0.55, 0.85, st) * vert * A;
        // large blotchy dirt / damp patches
        c *= 1.0 - 0.14 * smoothstep(0.45, 0.8, wfbm(vec2(hz, vWxP.y) * 0.35)) * A;
        // dust settled on tops / ledges
        c = mix(c, c * vec3(1.12, 1.08, 0.98) + vec3(0.025, 0.022, 0.018), smoothstep(0.75, 1.0, up) * 0.35 * A);
        // smoke blackening rising from below (burnt pieces)
        float sb = S * clamp(0.35 + 0.65 * smoothstep(0.3, 0.75, wn1(vec2(hz * 1.4, vWxP.y * 0.35)) + 0.25 * smoothstep(1.0, 6.0, vWxP.y)), 0.0, 1.0);
        c = mix(c, vec3(0.04, 0.037, 0.034), sb * 0.85);
        diffuseColor.rgb = c;
      }`);
  };
  m.needsUpdate = true;
  return m;
}
// weather every env asset material once (env GLBs only: never vehicles / soldiers)
export function weatherEnv(assets) {
  if (assets._weathered) return; assets._weathered = true;
  const amt = { panel_kit: 1, city: 1, farmland: 0.9, modern: 0.8, props: 0.7, fortifications: 0.5, wires: 0.4 };
  for (const [k, a] of Object.entries(amt)) {
    const g = assets.gltf[k]; if (!g) continue;
    g.scene.traverse(o => { if (!o.isMesh || /crater/i.test(o.name) || /crater/i.test(o.parent?.name || '')) return; for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || m.transparent || m.alphaTest > 0 || /foliage|leaf|glass/i.test(m.name || '')) continue;
      weatherMaterial(m, { amount: a, soot: /damage/i.test(m.name || '') ? 0.35 : 0, key: k + (/damage/i.test(m.name || '') ? 'd' : '') });
    } });
  }
  for (const k of assets.rubbleKeys || []) assets.gltf[k]?.scene.traverse(o => { if (o.isMesh && !o.material.transparent) weatherMaterial(o.material, { amount: 0.8, soot: 0.15, key: 'rub' }); });
  // late summer: foliage a little drier / more olive (tree and crop cards; multiplies the atlas colour once)
  const dry = new THREE.Color(0.94, 0.91, 0.76);
  for (const k of ['trees', 'farmland', 'city', 'fortifications']) assets.gltf[k]?.scene.traverse(o => { if (!o.isMesh) return; for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
    if (!m || m.userData?.dried || !m.color || !(m.alphaTest > 0 || /foliage|leaf|leaves|crown|bush/i.test(m.name || ''))) continue;
    m.userData.dried = true; m.color.multiply(dry);
    if (m.alphaTest > 0 && m.map) alphaCoverage(m);
  } });
}
// Alpha-tested cards (leaves, crops, wattle) lose coverage in the smaller mips: the averaged alpha drops under the cut-off
// and crowns / belts thin out into sparse speckle at RTS distances.  Scale alpha up with the mip level actually sampled
// (from the UV derivatives), so the card keeps its silhouette at distance (A. Golus' mip coverage fix).
export function alphaCoverage(m) {
  if (m.userData.alphaCov) return; m.userData.alphaCov = true;
  const prev = m.onBeforeCompile, key = m.customProgramCacheKey ? m.customProgramCacheKey.bind(m) : null;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <alphatest_fragment>', `
      #if defined( USE_MAP ) && defined( USE_ALPHATEST )
      {
        vec2 acUv = vMapUv * vec2(textureSize(map, 0));
        vec2 acDx = dFdx(acUv), acDy = dFdy(acUv);
        float acMip = max(0.0, 0.5 * log2(max(dot(acDx, acDx), dot(acDy, acDy))));
        diffuseColor.a *= 1.0 + min(acMip, 6.0) * 0.22;
      }
      #endif
      #include <alphatest_fragment>`);
  };
  m.customProgramCacheKey = () => (key ? key() : '') + '_acov';
  m.needsUpdate = true;
}

// de-quantised / de-interleaved float copy of a geometry (env GLBs are quantised: int16 normalised positions with the
// scale in the node matrix -- applying a matrix to those in place clamps them to +-1)
export function floatGeo(src) {
  const g = new THREE.BufferGeometry();
  for (const [k, a] of Object.entries(src.attributes)) {
    const n = a.count, s = a.itemSize, d = new Float32Array(n * s);
    for (let i = 0; i < n; i++) for (let c = 0; c < s; c++) d[i * s + c] = a.getComponent(i, c);
    g.setAttribute(k, new THREE.BufferAttribute(d, s));
  }
  if (src.index) g.setIndex(Array.from(src.index.array));
  return g;
}
// ---------------------------------------------------------------- burnt-out, roofless house (derived from an intact one)
// Drops the roof (sloped faces above the eaves), keeps walls and gables, chars the whole shell (double sided so the
// inside of the walls shows through the empty window holes / missing roof), plus a burnt floor slab inside.
export function burntHouse(tpl) {
  tpl.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(tpl.matrixWorld).invert(), geos = [];
  let mat = null;
  tpl.traverse(o => { if (!o.isMesh) return; const g = floatGeo(o.geometry).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)); geos.push(g.index ? g.toNonIndexed() : g); mat ||= Array.isArray(o.material) ? o.material[0] : o.material; });
  if (!geos.length) return null;
  const all = geos.length > 1 ? mergeGeometries(geos.map(g => { for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k); return g; })) : geos[0];
  if (!all) return null;
  all.computeBoundingBox(); const bb = all.boundingBox, H = bb.max.y - bb.min.y;
  // eave height: the wall top -- highest y where most vertical-facing faces stop
  const pos = all.attributes.position, nrm = all.attributes.normal, keep = [];
  const eave = bb.min.y + Math.min(3.3, H * 0.55);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    const top = Math.max(a.y, b.y, c.y), low = Math.min(a.y, b.y, c.y);
    const sloped = Math.abs(n.y) > 0.35;
    if (low > eave - 0.15 && sloped) continue;          // roof sheets / underside
    if (top > eave + 0.3 && sloped) continue;
    keep.push(i);
  }
  // with the roof gone, whatever sat on it (ridge vents, dormers, chimney stacks standing on the slope, roof windows)
  // would hang in the air: keep only the pieces (position-welded islands) that come down to the eaves / walls
  {
    const key = v => Math.round(v.x * 500) + ',' + Math.round(v.y * 500) + ',' + Math.round(v.z * 500), ids = new Map(), par = [];
    const find = q => { while (par[q] !== q) { par[q] = par[par[q]]; q = par[q]; } return q; };
    const vid = v => { const k = key(v); let q = ids.get(k); if (q === undefined) { q = par.length; par.push(q); ids.set(k, q); } return q; };
    const tv = keep.map(i => [0, 1, 2].map(t => vid(a.fromBufferAttribute(pos, i + t))));
    for (const [p0, p1, p2] of tv) { const r = find(p0); par[find(p1)] = r; par[find(p2)] = r; }
    const low = new Map(); keep.forEach((i, j) => { const r = find(tv[j][0]); let m = low.get(r) ?? 1e9; for (let t = 0; t < 3; t++) m = Math.min(m, pos.getY(i + t)); low.set(r, m); });
    const kept = keep.filter((i, j) => low.get(find(tv[j][0])) < eave + 0.3); keep.length = 0; keep.push(...kept);
  }
  // footprint of the walls (vertical faces between knee and eave height): the floor slab stays inside them (the
  // template bbox includes roof overhangs, porches and steps)
  const wb = new THREE.Box3();
  for (const i of keep) { a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2); n.subVectors(c, b).cross(a.clone().sub(b)).normalize(); if (Math.abs(n.y) > 0.3) continue; for (const v of [a, b, c]) if (v.y > bb.min.y + 1.0 && v.y < eave - 0.2) wb.expandByPoint(v); }
  const g2 = new THREE.BufferGeometry();
  for (const k of Object.keys(all.attributes)) {
    const src = all.attributes[k], d = new Float32Array(keep.length * 3 * src.itemSize);
    keep.forEach((i, j) => { for (let t = 0; t < 3; t++) for (let e = 0; e < src.itemSize; e++) d[(j * 3 + t) * src.itemSize + e] = src.getComponent(i + t, e); });
    g2.setAttribute(k, new THREE.BufferAttribute(d, src.itemSize));
  }
  const m = charred(mat, true);
  const grp = new THREE.Group(); grp.name = (tpl.name || 'house') + '_burnt';
  const shell = new THREE.Mesh(g2, m); shell.castShadow = shell.receiveShadow = true; shell.name = grp.name + '_shell'; grp.add(shell);
  // charred floor / fallen roof debris inside the shell
  const fb = wb.isEmpty() ? bb : wb, fl = new THREE.BoxGeometry((fb.max.x - fb.min.x) * 0.92, 0.5, (fb.max.z - fb.min.z) * 0.92); fl.translate((fb.max.x + fb.min.x) / 2, bb.min.y + 0.25, (fb.max.z + fb.min.z) / 2);
  const floor = new THREE.Mesh(fl, charred(null)); floor.receiveShadow = true; floor.name = grp.name + '_floor'; grp.add(floor);
  return grp;
}
const _char = new Map();
export function charred(src, doubleSide = false) {
  const key = (src?.uuid || 'none') + doubleSide; if (_char.has(key)) return _char.get(key);
  const m = src ? src.clone() : new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 1 });
  m.userData = { weathered: true }; m.roughness = 0.97; m.metalness = 0; m.vertexColors = false; if (m.color) m.color.setRGB(1, 1, 1); if (doubleSide) m.side = THREE.DoubleSide;
  m.customProgramCacheKey = () => 'charred_env' + (src ? 1 : 0);
  if (!src) m.defines = { CHAR_FLOOR: '' };
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vChP;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        { vec4 p = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            p = instanceMatrix * p;
          #endif
          vChP = (modelMatrix * p).xyz; }`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vChP; ${WAR_NOISE}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        float hz = vChP.x * 0.8 + vChP.z * 0.6;
        #ifdef CHAR_FLOOR
          float fa = wfbm(vChP.xz * 0.6), fb = wn1(vChP.xz * 3.0);
          diffuseColor.rgb = mix(vec3(0.05, 0.046, 0.042), vec3(0.15, 0.14, 0.13), smoothstep(0.55, 0.85, fa) * 0.7) * (0.75 + 0.5 * fb);
        #else
        float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
        float soot = clamp(0.45 + 0.55 * smoothstep(0.2, 0.7, wn1(vec2(hz * 1.2, vChP.y * 0.45))) + 0.2 * smoothstep(0.8, 2.6, vChP.y), 0.0, 1.0);
        vec3 c = mix(vec3(lum) * vec3(0.95, 0.9, 0.84), vec3(0.035, 0.032, 0.03), soot * 0.88);
        c = mix(c, vec3(0.34, 0.33, 0.31), smoothstep(0.7, 0.86, wn1(vec2(hz * 4.0, vChP.y * 3.0))) * 0.4);   // ash-grey bloom
        if (!gl_FrontFacing) c *= 0.6;
        diffuseColor.rgb = c;
        #endif
      }`);
  };
  _char.set(key, m); return m;
}

// ---------------------------------------------------------------- knocked-out armour (static map dressing)
// Uses the vehicles' own *_wreck nodes (hull_wreck / turret_wreck), merged per material and charred, so each wreck
// type is 1-3 draw calls per instancer cell. Returns { name: { hull: Group, turret: Group|null, h: turret ring y } }.
export function wreckTemplates(assets, keys) {
  const out = {};
  for (const k of keys) {
    const g = assets.gltf[k]; if (!g) continue;
    const root = g.scene; root.updateMatrixWorld(true);
    const part = name => {
      const node = root.getObjectByName(name); if (!node) return null;
      const by = new Map();
      node.traverse(o => { if (!o.isMesh || /_LOD1$/i.test(o.name) || /glass|lens/i.test(o.material?.name || '')) return; const geo = floatGeo(o.geometry).applyMatrix4(o.matrixWorld); const keepA = ['position', 'normal', 'uv']; for (const a of Object.keys(geo.attributes)) if (!keepA.includes(a)) geo.deleteAttribute(a); if (!geo.attributes.uv) return; const mm = Array.isArray(o.material) ? o.material[0] : o.material; (by.get(mm) || by.set(mm, []).get(mm)).push(geo.index ? geo.toNonIndexed() : geo); });
      if (!by.size) return null;
      const grp = new THREE.Group(); grp.name = k + '_' + name + '_static';
      for (const [mm, list] of by) { const mg = mergeGeometries(list); if (!mg) continue; const mesh = new THREE.Mesh(mg, wreckChar(mm)); mesh.castShadow = mesh.receiveShadow = true; mesh.name = grp.name; grp.add(mesh); }
      return grp.children.length ? grp : null;
    };
    const hull = part('hull_wreck'); if (!hull) continue;
    out[k] = { hull, turret: part('turret_wreck') };
  }
  return out;
}
const _wc = new Map();
function wreckChar(src) {
  if (_wc.has(src)) return _wc.get(src);
  const m = src.clone(); m.userData = { weathered: true }; m.roughness = 0.95; m.metalness = 0.15; m.vertexColors = false; if (m.color) m.color.setRGB(1, 1, 1);
  m.customProgramCacheKey = () => 'wreck_static';
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWkP;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvWkP = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vWkP; ${WAR_NOISE}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
      {
        float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
        float n1 = wn1(vWkP.xz * 2.2 + vWkP.y * 1.3) * 0.65 + wn1(vWkP.xy * 7.0) * 0.35, n2 = wn1(vWkP.zy * 1.3 + 17.0), n3 = wn1(vWkP.xz * 9.0 + 5.0);
        vec3 c = vec3(0.055, 0.05, 0.046) * (0.75 + lum * 0.7);
        c = mix(c, vec3(0.19, 0.185, 0.175) * (0.8 + 0.3 * n3), smoothstep(0.66, 0.86, n1) * 0.55);   // ash / heat-bleached paint
        c = mix(c, vec3(0.2, 0.11, 0.06) * (0.8 + 0.4 * n3), smoothstep(0.55, 0.85, n2) * 0.55);       // months out: rust coming through
        c = mix(c, vec3(0.14, 0.135, 0.11), smoothstep(0.82, 0.95, n3) * 0.3);
        diffuseColor.rgb = c;
      }`);
  };
  _wc.set(src, m); return m;
}

// ---------------------------------------------------------------- crater decals (atlas, per-instance cell)
export function craterMesh(scene, T, fallbackMap, cap, tint = 0x9c9182) {
  const atlas = !!T?.map;
  const m = new THREE.MeshStandardMaterial({ map: atlas ? T.map : fallbackMap, normalMap: atlas ? T.normalMap : null, normalScale: new THREE.Vector2(1.2, 1.2), color: atlas ? tint : 0xffffff, transparent: true, depthWrite: false, roughness: 0.95, opacity: atlas ? 1 : 0.85, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
  g.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
  if (atlas) {
    m.customProgramCacheKey = () => 'crater_atlas_v6b';
    m.onBeforeCompile = sh => {
      // ground look v6: the decal's outer fringe is eroded by world-space noise (no round stamp edge, no two craters
      // alike) and its tone drifts a little, so it settles into the ground instead of sitting on it
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vCrW; varying vec2 vCrUv; ${WAR_NOISE}`).replace('#include <map_fragment>', `#include <map_fragment>
        {
          float cn = wn1(vCrW.xz * 1.6) * 0.6 + wn1(vCrW.xz * 5.1 + 3.0) * 0.4;
          // feathered outer half: alpha falls off gradually from 0.22 to 0.5 of the decal radius, ragged with noise
          float rd = length(vCrUv - 0.5) + (cn - 0.5) * 0.14;
          diffuseColor.a *= smoothstep(0.0, 0.7, diffuseColor.a + (cn - 0.55) * 0.45) * (1.0 - smoothstep(0.22, 0.5, rd));
          diffuseColor.rgb *= 0.9 + 0.18 * cn;
          diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.92, 0.84, 0.72), diffuseColor.rgb, smoothstep(0.25, 0.7, diffuseColor.a));   // dust fringe: warm soil, not grey
        }`);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aCell; varying vec3 vCrW; varying vec2 vCrUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCrW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz; vCrUv = uv;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>
        vec2 cOff = vec2(mod(aCell, 2.0), 1.0 - floor(aCell / 2.0)) * 0.5;
        #ifdef USE_MAP
          vMapUv = vMapUv * 0.5 + cOff;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv = vNormalMapUv * 0.5 + cOff;
        #endif`);
    };
  }
  const im = new THREE.InstancedMesh(g, m, cap); im.count = 0; im.receiveShadow = true; im.frustumCulled = false; im.userData.atlas = atlas; scene.add(im);
  return im;
}
