import * as THREE from 'three';

// Unconfirmed contacts. Enemy units are always drawn at their real position, but until the player's side has really
// identified one (unit.spotted: the detection meter in game.spotFor has filled / the unit is in line of sight), a "?"
// in a hostile diamond floats above it: one per squad / vehicle, never per man. It fades out (~0.3 s) when the contact
// is confirmed (the normal enemy banner takes over) and fades back in when contact is lost.
// Purely cosmetic: targeting, AI knowledge and engagement rules still go by spotting (game.seen / unit.spotted).
// One draw call: an InstancedBufferGeometry quad billboarded in the vertex shader, sized by camera distance (about a
// constant screen size, bounded), drawn over the terrain (no depth test) so it never sinks into a hill or a roof.
// No per-frame allocations: instance data lives in one preallocated Float32Array.

const MAX = 128, HOSTILE = 0xe2574a;
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
    // r: tinted parts (frame + glyph), g: dark backing, a: coverage
    vec3 c = mix(vec3(0.05, 0.06, 0.06), uColor * 1.08, t.r);
    float a = t.a * vA; if (a < 0.01) discard;
    gl_FragColor = vec4(c, a);
  }`;

function glyphTexture() {
  const S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S; const x = cv.getContext('2d');
  const dia = (r) => { x.beginPath(); x.moveTo(S / 2, S / 2 - r); x.lineTo(S / 2 + r, S / 2); x.lineTo(S / 2, S / 2 + r); x.lineTo(S / 2 - r, S / 2); x.closePath(); };
  // dark halo + backing (black in r), then the frame and the "?" in white (= tinted by uColor in the shader)
  x.fillStyle = 'rgba(0,0,0,0.45)'; dia(60); x.fill();
  x.fillStyle = 'rgba(0,0,0,0.72)'; dia(50); x.fill();
  x.lineJoin = 'round'; x.strokeStyle = '#fff'; x.lineWidth = 7; dia(50); x.stroke();
  x.fillStyle = '#fff'; x.font = '900 66px "Barlow Condensed", "Arial Black", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('?', S / 2, S / 2 + 4);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
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
  // is u an enemy the player sees only as an unconfirmed contact right now?
  static unconfirmed(u) {
    if (u.side === 'player' || u.destroyed || u.spotted || u.concealed) return false;
    if (u.type === 'squad') return !u.mounted && !u.medevac;
    return u.mstate !== 'away';
  }
  // an unspotted unit holed up in a building / cellar or in heavy foliage (forest, dense treeline belt: conceal < 0.45)
  // gives nothing away: not drawn at all and no "?" until it is spotted (or shows itself by firing). Used by the host
  // (game.spotFor) and the multiplayer joiner (net/battle.js).
  static concealed(u, g) {
    if (u.side === 'player' || u.destroyed || u.spotted) return false;
    const C = g.city, ca = C?.concealAt, heavy = (x, z) => !!ca && ca.call(C, x, z) < 0.45;
    if (u.type === 'vehicle') return heavy(u.pos.x, u.pos.z);
    let n = 0, hid = 0;
    for (const s of u.soldiers) { if (!s.alive || s.state === 'dead' || s.inside === 'btr') continue; n++; if (s.inBuilding || s.cellar || heavy(s.pos.x, s.pos.z)) hid++; }
    return n > 0 && hid >= n * 0.75;
  }
  // where the marker sits: above the squad leader / first man still standing, above a vehicle's roof
  anchor(u, out) {
    if (u.type === 'vehicle') { const p = u.pos; return out.set(p.x, (p.y || 0) + 5.2, p.z); }
    let s = u.leader; if (!s || !s.alive || s.inside === 'btr' || s.cellar) { s = null; for (const m of u.soldiers) if (m.alive && m.inside !== 'btr' && !m.cellar) { s = m; break; } }
    if (!s) return null;
    return out.set(s.pos.x, s.pos.y + 3.0, s.pos.z);
  }
  update(dt) {
    if (!this.mesh) return;
    const g = this.g, cam = g.renderer.camera, a = this.data, k = Math.min(1, dt * 3.5);
    this.mat.uniforms.uTime.value += dt;
    // ~38 px tall on screen whatever the zoom (bounded), from the vertical field of view and the viewport height
    this.mat.uniforms.uPx.value = 2 * Math.tan(cam.fov * Math.PI / 360) * 38 / Math.max(300, innerHeight);
    let n = 0;
    const each = u => {
      const on = ContactMarkers.unconfirmed(u);
      let f = u._qA || 0; f = on ? Math.min(1, f + k) : Math.max(0, f - k); u._qA = f;
      if (f <= 0.01 || n >= MAX || (u.destroyed && !on)) return;
      if (!this.anchor(u, this.v)) return;
      const i = n * 4; a[i] = this.v.x; a[i + 1] = this.v.y; a[i + 2] = this.v.z; a[i + 3] = f; this.slots[n++] = u;
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
      el = this.tip = document.createElement('div'); el.id = 'contactTip';
      Object.assign(el.style, { position: 'fixed', zIndex: 30, pointerEvents: 'none', padding: '.3rem .55rem', background: 'rgba(14,17,16,.88)', border: '1px solid rgba(226,87,74,.55)',
        borderLeft: '3px solid #e2574a', color: '#ece8de', font: '600 12px/1.25 "Barlow", system-ui, sans-serif', letterSpacing: '.02em', whiteSpace: 'nowrap' });
      el.innerHTML = '<b style="color:#e2574a;letter-spacing:.06em;text-transform:uppercase;font-size:11px">Unconfirmed contact</b><br><span style="opacity:.7">No line of sight · right-click: area fire / close in</span>';
      document.body.appendChild(el);
    }
    this.tipU = u; el.style.display = 'block'; el.style.transform = `translate(${Math.round(m[0] + 16)}px,${Math.round(m[1] + 14)}px)`; el.style.left = '0'; el.style.top = '0';
  }
}
