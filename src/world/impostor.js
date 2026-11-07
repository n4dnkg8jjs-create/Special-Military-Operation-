// Far-distance impostors for the big leafy trees (leafy_summer_birch / _chestnut: 6-8k triangles each, no authored
// lod; the leaf cards are alpha-tested, so a far tree costs overdraw as well as triangles).
//
// At load the template is captured from 16 azimuths x 4 elevations (0..60 deg) into two atlases: albedo + coverage
// (sRGB) and tree-space normal + roughness.  Far away each tree is ONE camera-facing quad (2 triangles) drawn with a
// MeshStandardMaterial: the shader picks the four captured views around the actual view direction and blends them, and
// the captured normals go through three's own lighting (sun, hemisphere, environment, fog, shadow lookups), so the
// impostor is lit like the mesh.  Shadow lookups sit on the camera-facing surface of the crown (the quad goes through
// the crown centre: there the crown would shadow itself).  Impostors cast no shadow: the static shadow cache
// (engine/renderer.js) draws a mesh level of the same trees whatever the camera distance; without the cache (shadows on,
// ?shadowcache=0) impostors are off.  The instances keep the trees' placement matrices (world/treeDamage.js zeroes a
// felled tree in every level, this one included).  ?impostors=0 / localStorage smo_impostors=0: off.
import * as THREE from 'three';
import { ENGINE } from '../engine/renderer.js';

const NA = 16, NE = 4, EL_MAX = Math.PI / 3, F = 128;
export function impostorsOn() {
  if (!ENGINE.r) return false;
  try { const q = new URLSearchParams(location.search).get('impostors'); if (q != null) return q !== '0'; if (localStorage.getItem('smo_impostors') === '0') return false; } catch { /* no DOM */ }
  return !ENGINE.shadows || ENGINE.shadowCache;   // (shadows without the cache: the far trees would lose their shadows)
}
const isCut = m => m.alphaTest > 0 || m.transparent;
const cache = new WeakMap();

const capVS = `out vec2 vUv; out vec3 vN;
  void main() { vUv = uv; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const capFS = `precision highp float; in vec2 vUv; in vec3 vN; uniform sampler2D map, orm; uniform vec3 color; uniform float cut, rough, mode, hasMap, hasOrm;
  layout(location = 0) out vec4 o;
  void main() {
    vec4 a = hasMap > 0.5 ? texture(map, vUv) : vec4(1.0);
    if (cut > 0.0 && a.a < cut) discard;
    if (mode < 0.5) { o = vec4(a.rgb * color, 1.0); return; }
    vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
    o = vec4(n * 0.5 + 0.5, rough * (hasOrm > 0.5 ? texture(orm, vUv).g : 1.0));   // (alpha 1 texels: = premultiplied by coverage)
  }`;

// template -> impostor template (an Object3D holding one quad mesh) or null
export function treeImpostor(template) {
  if (cache.has(template)) return cache.get(template);
  let out = null;
  try { out = impostorsOn() ? bake(template) : null; } catch (e) { console.warn('impostor bake', template.name, e); out = null; }
  cache.set(template, out);
  return out;
}

function bake(template) {
  const r = ENGINE.r; if (!r) return null;
  template.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(template.matrixWorld).invert();
  const cap = new THREE.Scene(), meshes = [];
  let hasLeaf = false;
  template.traverse(o => {
    if (!o.isMesh || o.isSkinnedMesh) return;
    const rel = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const src = Array.isArray(o.material) ? o.material[0] : o.material;
    if (isCut(src)) hasLeaf = true;
    const mk = mode => new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: capVS, fragmentShader: capFS, side: isCut(src) || src.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide,
      uniforms: { map: { value: src.map || null }, orm: { value: src.roughnessMap || null }, color: { value: (src.color || new THREE.Color(1, 1, 1)).clone() }, cut: { value: isCut(src) ? (src.alphaTest || 0.5) : 0 }, rough: { value: src.roughness ?? 1 }, mode: { value: mode }, hasMap: { value: src.map ? 1 : 0 }, hasOrm: { value: src.roughnessMap ? 1 : 0 } },
    });
    const m = new THREE.Mesh(o.geometry, mk(0)); m.matrixAutoUpdate = false; m.matrix.copy(rel); m.userData.mats = [m.material, mk(1)]; cap.add(m); meshes.push(m);
  });
  if (!hasLeaf || !meshes.length) return null;
  cap.updateMatrixWorld(true);
  // bounding sphere (tree space) from the vertices
  const box = new THREE.Box3(); for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrix)); }
  const C = box.getCenter(new THREE.Vector3()); let R2 = 0; const v = new THREE.Vector3();
  for (const m of meshes) { const p = m.geometry.attributes.position; for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m.matrix); R2 = Math.max(R2, v.distanceToSquared(C)); } }
  const R = Math.sqrt(R2) * 1.01;
  // atlases
  const W = NA * F, H = NE * F;
  const mkRT = srgb => { const t = new THREE.WebGLRenderTarget(W, H, { generateMipmaps: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true }); t.texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.texture.anisotropy = 4; return t; };
  const rtA = mkRT(true), rtN = mkRT(false);
  const cam = new THREE.OrthographicCamera(-R, R, R, -R, 0.01, R * 4);
  const prevRT = r.getRenderTarget(), prevAC = r.autoClear, cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha(), prevSM = r.shadowMap.autoUpdate;
  r.autoClear = false; r.shadowMap.autoUpdate = false;
  try {
    for (const [rt, mode] of [[rtA, 0], [rtN, 1]]) {
      for (const m of meshes) m.material = m.userData.mats[mode];
      rt.viewport.set(0, 0, W, H); rt.scissor.set(0, 0, W, H); rt.scissorTest = false;
      r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear(true, true, false);   // (both atlases hold coverage-premultiplied values: clean mips / blends)
      for (let e = 0; e < NE; e++) for (let a = 0; a < NA; a++) {
        const az = a / NA * Math.PI * 2, el = e / (NE - 1) * EL_MAX;
        const d = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
        cam.position.copy(C).addScaledVector(d, R * 2); cam.up.set(0, 1, 0); cam.lookAt(C); cam.updateMatrixWorld(true);
        rt.viewport.set(a * F, e * F, F, F); rt.scissor.set(a * F, e * F, F, F); rt.scissorTest = true;
        r.setRenderTarget(rt); r.clear(false, true, false); r.render(cap, cam);
      }
      rt.scissorTest = false; rt.viewport.set(0, 0, W, H); rt.scissor.set(0, 0, W, H);
      rt.texture.generateMipmaps = true; r.setRenderTarget(rt); r.render(new THREE.Scene(), cam);   // (an empty render: three builds the mip chain after it)
    }
  } finally { r.setRenderTarget(prevRT); r.autoClear = prevAC; r.setClearColor(cc, ca); r.shadowMap.autoUpdate = prevSM; for (const m of meshes) for (const x of m.userData.mats) x.dispose(); }

  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, name: 'tree_impostor' });
  const U = { tImpA: { value: rtA.texture }, tImpN: { value: rtN.texture }, impC: { value: C }, impR: { value: R }, impCut: { value: 0.5 } };
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
      uniform vec3 impC; uniform float impR; out vec2 vImpQ; flat out vec4 vImpF; out vec2 vImpT; out mat3 vImpRot;`)
      .replace('#include <beginnormal_vertex>', `
      mat4 impM = modelMatrix * instanceMatrix; mat3 impB = mat3(impM); float impS = length(impB[0]);
      vec3 impW = (impM * vec4(impC, 1.0)).xyz, impToCam = normalize(cameraPosition - impW);
      vec3 impD = normalize(transpose(impB) * impToCam), impUp = normalize(transpose(impB) * vec3(0.0, 1.0, 0.0));
      vec3 impX = normalize(cross(impUp, impD)), impY = cross(impD, impX);
      float impAz = atan(impD.x, impD.z) / 6.2831853 * ${NA}.0; impAz = mod(impAz + ${NA}.0, ${NA}.0);
      float impEl = clamp(asin(clamp(dot(impD, impUp), -1.0, 1.0)) / ${(EL_MAX / (NE - 1)).toFixed(6)}, 0.0, ${NE - 1}.0);
      float impA0 = floor(impAz), impE0 = min(floor(impEl), ${NE - 2}.0);
      vImpF = vec4(impA0, mod(impA0 + 1.0, ${NA}.0), impE0, impE0 + 1.0); vImpT = vec2(impAz - impA0, impEl - impE0);
      vImpQ = position.xy * 0.5 + 0.5; vImpRot = impB / max(impS, 1e-6);
      vec3 objectNormal = impD;
      #ifdef USE_TANGENT
        vec3 objectTangent = vec3( tangent.xyz );
      #endif`)
      .replace('#include <begin_vertex>', `vec3 transformed = impC + (impX * position.x + impY * position.y) * impR;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      #ifdef USE_SHADOWMAP
        worldPosition.xyz += impToCam * impR * impS * 0.55;   // (shadow lookups on the camera-facing side of the crown)
      #endif`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      uniform sampler2D tImpA, tImpN; uniform float impCut; in vec2 vImpQ; flat in vec4 vImpF; in vec2 vImpT; in mat3 vImpRot;
      vec2 impUV(float a, float e) { return vec2((a + vImpQ.x) / ${NA}.0, (e + vImpQ.y) / ${NE}.0); }
      // (mip bias -1: a far tree is only ~10-40 px tall; one level sharper keeps the trunk and the crown's leaf
      // texture instead of a soft blob -- the mesh it replaces is rasterised per pixel too)
      vec4 impS4(sampler2D t) {
        vec4 a = mix(texture(t, impUV(vImpF.x, vImpF.z), -1.0), texture(t, impUV(vImpF.y, vImpF.z), -1.0), vImpT.x);
        vec4 b = mix(texture(t, impUV(vImpF.x, vImpF.w), -1.0), texture(t, impUV(vImpF.y, vImpF.w), -1.0), vImpT.x);
        return mix(a, b, vImpT.y); }`)
      .replace('#include <map_fragment>', `vec4 impAlb = impS4(tImpA);
      // coverage held up in the smaller mips (as wear.js alphaCoverage does for the leaf cards themselves)
      vec2 impTs = vImpQ * vec2(textureSize(tImpA, 0)) / vec2(${NA}.0, ${NE}.0);
      float impMip = max(0.0, 0.5 * log2(max(dot(dFdx(impTs), dFdx(impTs)), dot(dFdy(impTs), dFdy(impTs)))) - 1.0);
      if (impAlb.a * (1.0 + min(impMip, 6.0) * 0.22) < impCut) discard;
      diffuseColor.rgb *= impAlb.rgb / max(impAlb.a, 1e-3);
      vec4 impNr = impS4(tImpN);`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness * clamp(impNr.a / max(impAlb.a, 0.05), 0.3, 1.0);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      normal = normalize((viewMatrix * vec4(vImpRot * normalize(impNr.xyz / max(impAlb.a, 1e-3) * 2.0 - 1.0), 0.0)).xyz);`);
  };
  mat.customProgramCacheKey = () => 'tree_impostor_v1';
  const g = new THREE.PlaneGeometry(2, 2); g.boundingSphere = new THREE.Sphere(C.clone(), R); g.boundingBox = new THREE.Box3().setFromCenterAndSize(C, new THREE.Vector3(R * 2, R * 2, R * 2));
  const q = new THREE.Mesh(g, mat); q.name = (template.name || 'tree') + '_imp';
  const t = new THREE.Object3D(); t.name = q.name; t.add(q); t.userData.impostor = true;
  return t;
}
