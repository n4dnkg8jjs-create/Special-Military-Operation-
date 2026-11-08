import * as THREE from 'three';

// Unconfirmed contacts (tier 1 of game.spotFor's three: hidden / contact / identified). An enemy unit the player's side
// knows is there but has not identified - seen on the drone picture of the open ground, heard firing, lost from sight a
// moment ago - is not drawn at all: a "?" on a hostile label tab (the same red tab + white APP-6 diamond as the unit labels)
// floats at its ESTIMATED position (unit.qx / qz: a grid ref with an error; it moves with the unit while the side's drones
// watch it, sits still on a fix by ear), one per squad / vehicle, never per man. It fades in / out (~0.3 s), eases toward a
// new fix, and dims as the report gets older (gone after game.js CONTACT_TTL). Identified units (unit.spotted) have their
// model and banner instead; hidden ones (tier 0) nothing at all.
// One draw call: an InstancedBufferGeometry quad billboarded in the vertex shader, sized by camera distance (about a
// constant screen size, bounded), drawn over the terrain (no depth test) so it never sinks into a hill or a roof.
// No per-frame allocations: instance data lives in one preallocated Float32Array.

const MAX = 128, HOSTILE = 0xa32f28;   // = style.css --w-hod (the hostile label tab)
const VS = `
  attribute vec4 aData;            // xyz: anchor above the unit, w: opacity
  uniform float uTime, uPx;        // uPx: world size per metre of view depth for ~constant screen size
  varying vec2 vUv; varying float vA;
  void main() {
    vec4 mv = viewMatrix * vec4(aData.xyz, 1.0);
    float d = max(1.0, -mv.z), s = clamp(d * uPx, 1.5, 22.0);
    float bob = sin(uTime * 2.2 + aData.x * 0.37 + aData.z * 0.11) * 0.06 * s;
    mv.xy += vec2(position.x, position.y + 0.12 + bob / s) * s;
    gl_Position = projectionMatrix * mv;
    vUv = uv; vA = aData.w * (0.88 + 0.12 * sin(uTime * 3.1 + aData.z * 0.5));
  }`;
const FS = `
  uniform sampler2D map; uniform vec3 uColor;
  varying vec2 vUv; varying float vA;
  void main() {
    vec4 t = texture2D(map, vUv);
    // r: the hostile tab (filled in uColor), g: the white NATO frame + "?", black: keyline, a: coverage
    vec3 c = mix(vec3(0.03, 0.04, 0.05), uColor, t.r);
    c = mix(c, vec3(0.95), t.g);
    float a = t.a * vA; if (a < 0.01) discard;
    gl_FragColor = vec4(c, a);
  }`;

// the same vocabulary as the hostile unit labels (style.css .banner.h .tab): a red tab with a black keyline, the white
// APP-6 hostile frame (diamond) and a "?" in it
function glyphTexture() {
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S; const x = cv.getContext('2d');
  const m = S / 2, w = 52, h = 40, r = 27;
  x.fillStyle = 'rgba(0,0,0,0.8)'; x.fillRect(m - w - 5, m - h - 5, (w + 5) * 2, (h + 5) * 2);   // keyline
  x.fillStyle = '#f00'; x.fillRect(m - w, m - h, w * 2, h * 2);                                   // tab (r)
  x.strokeStyle = '#ff0'; x.lineWidth = 6; x.lineJoin = 'miter';                                  // white parts (r + g)
  x.beginPath(); x.moveTo(m, m - r); x.lineTo(m + r, m); x.lineTo(m, m + r); x.lineTo(m - r, m); x.closePath(); x.stroke();
  x.fillStyle = '#ff0'; x.font = '800 38px "Barlow Condensed", "Arial Narrow", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('?', m, m + 2);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
  return t;
}

export class ContactMarkers {
  constructor(game) {
    this.g = game; this.n = 0; this.slots = new Array(MAX).fill(null); this.v = new THREE.Vector3();
    this.tipT = 0; this.tipU = null;
    if (!game.scene) return;
    const geo = new THREE.InstancedBufferGeometry(), q = new THREE.PlaneGeometry(1, 1); q.translate(0, 0.5, 0);
    geo.index = q.index; geo.setAttribute('position', q.attributes.position); geo.setAttribute('uv', q.attributes.uv);
    this.data = new Float32Array(MAX * 4);
    this.attr = new THREE.InstancedBufferAttribute(this.data, 4); this.attr.setUsage(THREE.DynamicDrawUsage); geo.setAttribute('aData', this.attr);
    geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { map: { value: glyphTexture() }, uColor: { value: new THREE.Color(HOSTILE) }, uTime: { value: 0 }, uPx: { value: 0.03 } } });
    this.mesh = new THREE.Mesh(geo, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 12; this.mesh.name = 'contactMarkers';
    game.scene.add(this.mesh);
  }
  // is u an enemy the player knows only as an unconfirmed contact right now? (a squad aboard / a medevac crew in its cab:
  // its vehicle carries the "?")
  static unconfirmed(u) {
    if (u.side === 'player' || u.destroyed || u.tier !== 1) return false;
    if (u.type === 'squad') return !u.mounted && !(u.medevac && u.effective.every(s => s.inCab || s.inside === 'btr'));
    return u.mstate !== 'away';
  }
  // where the marker sits: over the estimated position (eased toward a new fix), above the ground / a roof-high vehicle
  anchor(u, out, k) {
    if (u.qx == null) return null;
    if (u._qx == null || (u._qA || 0) < 0.02 || Math.hypot(u._qx - u.qx, u._qz - u.qz) > 60) { u._qx = u.qx; u._qz = u.qz; }
    else { u._qx += (u.qx - u._qx) * k; u._qz += (u.qz - u._qz) * k; }
    const gh = this.g.city?.groundHeight?.(u._qx, u._qz) || 0;
    return out.set(u._qx, Math.max(0, gh) + (u.type === 'vehicle' ? 5.2 : 3.0), u._qz);
  }
  update(dt) {
    if (!this.mesh) return;
    const g = this.g, cam = g.renderer.camera, a = this.data, k = Math.min(1, dt * 3.5);
    this.mat.uniforms.uTime.value += dt;
    // ~32 px tall on screen whatever the zoom (bounded), from the vertical field of view and the viewport height
    this.mat.uniforms.uPx.value = 2 * Math.tan(cam.fov * Math.PI / 360) * 32 / Math.max(300, innerHeight);
    let n = 0; const now = g.time, km = Math.min(1, dt * 2.5);
    const each = u => {
      const on = ContactMarkers.unconfirmed(u);
      let f = u._qA || 0; f = on ? Math.min(1, f + k) : Math.max(0, f - k); u._qA = f;
      if (f <= 0.01 || n >= MAX || (u.destroyed && !on)) return;
      if (!this.anchor(u, this.v, km)) return;
      const age = now - (u.qt ?? now), dim = age < 10 ? 1 : Math.max(0.35, 1 - (age - 10) / 15 * 0.65);   // an old report: fainter
      const i = n * 4; a[i] = this.v.x; a[i + 1] = this.v.y; a[i + 2] = this.v.z; a[i + 3] = f * dim; this.slots[n++] = u;
    };
    for (const u of g.squads) each(u);
    for (const u of g.vehicles) each(u);
    for (let i = n; i < this.n; i++) this.slots[i] = null;
    this.n = n; this.mesh.geometry.instanceCount = n;
    if (n) this.attr.needsUpdate = true;   // (128 x vec4: a full upload is trivial; no update ranges - they pile up when nothing renders)
    this.hover(dt);
  }
  // screen position of a marker's centre (scratch vector, no allocation); null when off screen / behind the camera
  screenAt(i) {
    const cam = this.g.renderer.camera, a = this.data, v = this.v;
    v.set(a[i * 4], a[i * 4 + 1], a[i * 4 + 2]);
    const d = v.distanceTo(cam.position), s = Math.min(22, Math.max(1.5, d * this.mat.uniforms.uPx.value));
    v.y += s * 0.62; v.project(cam);
    if (v.z > 1) return null;
    return [(v.x * 0.5 + 0.5) * innerWidth, (-v.y * 0.5 + 0.5) * innerHeight];
  }
  // the unconfirmed contact whose "?" is under the cursor (for clicks / hover)
  pick(x, y, r = 20) {
    let best = null, bd = r;
    for (let i = 0; i < this.n; i++) {
      const u = this.slots[i]; if (!u || !ContactMarkers.unconfirmed(u) || (u._qA || 0) < 0.3) continue;
      const p = this.screenAt(i); if (!p) continue;
      const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = u; }
    }
    return best;
  }
  // hover: a small "Unconfirmed contact" tip next to the cursor (checked 10x a second, not every frame)
  hover(dt) {
    this.tipT -= dt; if (this.tipT > 0) return; this.tipT = 0.1;
    const inp = this.g.input, m = inp?.lastMouse;
    const u = m && !inp.drag ? (this.pick(m[0], m[1]) || inp.contactAt?.(m[0], m[1])) : null;
    let el = this.tip;
    if (!u) { if (el && this.tipU) { el.style.display = 'none'; this.tipU = null; } return; }
    if (!el) {
      el = this.tip = document.createElement('div'); el.id = 'contactTip';   // look: style.css #contactTip
      el.innerHTML = '<span class="tab">?</span><span class="tx"><b>Unconfirmed contact</b><span>Not identified · right-click: area fire / close in · FPV team: fly a drone over to look</span></span>';
      document.body.appendChild(el);
    }
    this.tipU = u; el.style.display = 'flex'; el.style.transform = `translate(${Math.round(m[0] + 16)}px,${Math.round(m[1] + 14)}px)`; el.style.left = '0'; el.style.top = '0';
  }
}
