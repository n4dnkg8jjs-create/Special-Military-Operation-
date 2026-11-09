// Power-line wires (streets v2): continuous camera-facing ribbons instead of 3-sided 12 mm tubes (sub-pixel at RTS
// distance -> broken, dotted lines).  Every polyline sample is two vertices on the wire's centre line; the vertex shader
// opens them sideways (square to the wire and the view ray) to the real width, never under ~1.4 px (wider and a little
// fainter instead: alpha blend, no dither / alpha test), so a span reads as one thin unbroken line at any zoom.
// Wires near the ground (downed spans, slack lengths) are resampled every metre and kept on top of the terrain / the
// paved surface under them (never through the asphalt, never floating over a hump).
import * as THREE from 'three';

const U = { uPix: { value: 0.0015 }, uHW: { value: 0.012 } }, _v2 = new THREE.Vector2();

function wireMat(color) {
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true });
  m.name = 'power_wire'; m.customProgramCacheKey = () => 'power_wire_v1';
  m.onBeforeCompile = sh => {
    sh.uniforms.uPix = U.uPix; sh.uniforms.uHW = U.uHW;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 aTan; uniform float uPix; uniform float uHW; varying float vFade; varying float vSide;`)
      .replace('#include <project_vertex>', `
        vec4 wc = modelMatrix * vec4(transformed, 1.0);
        vec3 wt = normalize(mat3(modelMatrix) * aTan.xyz);
        vec3 toC = cameraPosition - wc.xyz; float dist = length(toC); toC /= max(dist, 1e-4);
        vec3 sdv = cross(wt, toC); float sl = length(sdv); sdv = sl > 1e-4 ? sdv / sl : vec3(0.0, 1.0, 0.0);
        float w = max(uHW, dist * uPix * 0.7);   // (half width: >= ~0.7 px each side)
        vFade = uHW / w; vSide = aTan.w;
        wc.xyz += sdv * aTan.w * w;
        vec4 mvPosition = viewMatrix * wc;
        gl_Position = projectionMatrix * mvPosition;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vFade; varying float vSide;`)
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>
        diffuseColor.a *= mix(0.6, 1.0, clamp(vFade, 0.0, 1.0)) * (1.0 - 0.45 * smoothstep(0.55, 1.0, abs(vSide)));`);
  };
  return m;
}

// lines: [[THREE.Vector3...]], ground(x, z) -> surface y under the wire
export function buildWires(scene, lines, ground, { color = 0x1c1b19, hw = 0.012 } = {}) {
  const pos = [], tan = [], idx = [];
  const v = new THREE.Vector3();
  for (const L0 of lines) {
    if (!L0 || L0.length < 2) continue;
    // resample: 1 m where the wire is within 1.5 m of the ground, 4 m aloft; clamp onto the ground
    const P = [];
    for (let i = 0; i < L0.length - 1; i++) {
      const a = L0[i], b = L0[i + 1], d = a.distanceTo(b), low = Math.min(a.y - ground(a.x, a.z), b.y - ground(b.x, b.z)) < 1.5;
      const n = Math.max(1, Math.ceil(d / (low ? 1 : 4)));
      for (let k = 0; k < n; k++) { v.copy(a).lerp(b, k / n); P.push(v.clone()); }
    }
    P.push(L0[L0.length - 1].clone());
    for (const p of P) { const g = ground(p.x, p.z) + 0.03; if (p.y < g) p.y = g; }
    const b0 = pos.length / 3;
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)]; let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z; const l = Math.hypot(tx, ty, tz) || 1; tx /= l; ty /= l; tz /= l;
      for (const s of [-1, 1]) { pos.push(P[i].x, P[i].y, P[i].z); tan.push(tx, ty, tz, s); }
      if (i) { const k = b0 + (i - 1) * 2; idx.push(k, k + 1, k + 3, k, k + 3, k + 2); }
    }
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aTan', new THREE.Float32BufferAttribute(tan, 4));
  g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeBoundingSphere(); if (g.boundingSphere) g.boundingSphere.radius += 2;
  U.uHW.value = hw;
  const m = new THREE.Mesh(g, wireMat(color)); m.name = 'power_wires'; m.frustumCulled = false; m.renderOrder = 3; m.matrixAutoUpdate = false;
  m.onBeforeRender = (r, s, cam) => { if (!cam.isPerspectiveCamera) return; r.getDrawingBufferSize(_v2); U.uPix.value = 2 * Math.tan(cam.fov * Math.PI / 360) / Math.max(1, _v2.y); };
  scene.add(m);
  return m;
}
