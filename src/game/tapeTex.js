import * as THREE from 'three';

// Identification tape on arms, legs and helmets (the soldier models' 'tape' material: a flat colour): one small texture that
// makes it read as wound tape - the turns' overlapping edges running a little off-square, creases across the width, the edges
// darker where the tape bites into the cloth, scuffs. Grey-scale, multiplied by the material's colour (yellow, blue, white...).
// The band meshes' UVs: u along the band (0..~1.9 for two turns), v 0..0.25 across its width.
let _t = null;
export function tapeTextures() {
  if (_t) return _t;
  const W = 256, H = 64, mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const col = mk(), x = col.getContext('2d'), bmp = mk(), y = bmp.getContext('2d');
  let a = 12345; const R = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  x.fillStyle = '#e9e9e9'; x.fillRect(0, 0, W, H); y.fillStyle = '#808080'; y.fillRect(0, 0, W, H);
  // creases across the width
  for (let i = 0; i < 70; i++) { const px = R() * W, w = 1 + R() * 2.5, d = R(); x.fillStyle = `rgba(${d < 0.5 ? '40,40,40' : '255,255,255'},${0.05 + R() * 0.1})`; x.fillRect(px, R() * H * 0.3, w, H * (0.5 + R() * 0.5)); y.fillStyle = d < 0.5 ? 'rgba(0,0,0,.25)' : 'rgba(255,255,255,.22)'; y.fillRect(px, 0, w, H); }
  // the turns: overlapping edges, slightly diagonal
  for (const [x0, k] of [[40, 0.12], [118, -0.08], [201, 0.1]]) { x.strokeStyle = 'rgba(30,30,30,.4)'; x.lineWidth = 1.6; x.beginPath(); x.moveTo(x0, 0); x.lineTo(x0 + H * k * 4, H); x.stroke(); x.strokeStyle = 'rgba(255,255,255,.35)'; x.beginPath(); x.moveTo(x0 + 2.2, 0); x.lineTo(x0 + 2.2 + H * k * 4, H); x.stroke(); y.strokeStyle = 'rgba(0,0,0,.6)'; y.lineWidth = 2; y.beginPath(); y.moveTo(x0, 0); y.lineTo(x0 + H * k * 4, H); y.stroke(); }
  // a second turn's edge along the band, the edges themselves shaded
  x.fillStyle = 'rgba(30,30,30,.22)'; x.fillRect(0, H * 0.46, W, 1.4); y.fillStyle = 'rgba(0,0,0,.4)'; y.fillRect(0, H * 0.46, W, 2);
  for (const [y0, y1] of [[0, H * 0.2], [H, H * 0.8]]) { const g = x.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, 'rgba(0,0,0,.6)'); g.addColorStop(0.45, 'rgba(0,0,0,.16)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0)); const g2 = y.createLinearGradient(0, y0, 0, y1); g2.addColorStop(0, 'rgba(0,0,0,.7)'); g2.addColorStop(1, 'rgba(0,0,0,0)'); y.fillStyle = g2; y.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0)); }
  // scuffs and dirt
  for (let i = 0; i < 160; i++) { x.fillStyle = `rgba(60,50,40,${0.04 + R() * 0.1})`; x.beginPath(); x.ellipse(R() * W, R() * H, 1 + R() * 5, 1 + R() * 2.5, R() * 3, 0, 7); x.fill(); }
  // (v2: in a battle - daylight, 10-40 m - the band still read as a flat stripe of pure colour: the marks above are too fine.)
  // Bolder, larger marks: the tape dulled and blotched with dirt, deep creases where the arm bends, both edges dark and frayed,
  // the overlap of the turns a clear line.
  for (let i = 0; i < 16; i++) { const px = R() * W, py = R() * H, r = 10 + R() * 26, g = x.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, `rgba(72,60,46,${0.22 + R() * 0.3})`); g.addColorStop(1, 'rgba(72,60,46,0)'); x.fillStyle = g; x.fillRect(px - r, py - r, 2 * r, 2 * r); }
  for (let i = 0; i < 22; i++) { const px = R() * W, w = 2 + R() * 3; x.fillStyle = `rgba(20,20,20,${0.16 + R() * 0.22})`; x.fillRect(px, 0, w, H); x.fillStyle = 'rgba(255,255,255,0.22)'; x.fillRect(px + w, 0, 1.2, H); y.fillStyle = 'rgba(0,0,0,.5)'; y.fillRect(px, 0, w, H); }
  for (const yy of [0, H - 7]) { x.fillStyle = 'rgba(18,16,14,0.5)'; x.fillRect(0, yy, W, 7); for (let i = 0; i < 60; i++) { x.fillStyle = 'rgba(18,16,14,0.5)'; x.fillRect(R() * W, yy === 0 ? 7 : H - 7 - 3, 2 + R() * 5, 3); } }
  x.fillStyle = 'rgba(20,20,20,.45)'; x.fillRect(0, H * 0.46, W, 2.4);
  x.fillStyle = 'rgba(96,88,74,0.16)'; x.fillRect(0, 0, W, H);
  const map = new THREE.CanvasTexture(col); map.colorSpace = THREE.SRGBColorSpace; const bump = new THREE.CanvasTexture(bmp);
  for (const t of [map, bump]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, 4); t.anisotropy = 4; }
  return (_t = { map, bump });
}
export function tapeMaterial(m) { const T = tapeTextures(); m.map = T.map; m.bumpMap = T.bump; m.bumpScale = 2.2; m.roughness = 0.72; m.needsUpdate = true; return m; }
