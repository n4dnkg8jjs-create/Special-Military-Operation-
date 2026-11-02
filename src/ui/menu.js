// Main-menu backdrop: a 1:50k staff map — contour lines, a kilometre grid with references and a
// grease-pencil tactical overlay (front line, axis of advance, objective, unit symbols).
// Drawn once per resize on #menuBg; static, so it costs nothing while the menu is open.

function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function noise2(seed) {
  const r = rng(seed), N = 64, g = new Float32Array(N * N).map(() => r());
  const at = (i, j) => g[((j % N + N) % N) * N + ((i % N + N) % N)], sm = t => t * t * (3 - 2 * t);
  const v = (x, y) => { const i = Math.floor(x), j = Math.floor(y), fx = sm(x - i), fy = sm(y - j); const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1); return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy; };
  return (x, y) => v(x, y) * 0.55 + v(x * 2.1 + 17, y * 2.1 + 5) * 0.3 + v(x * 4.3 + 3, y * 4.3 + 29) * 0.15;
}

export function drawMenuBackdrop(c) {
  const dpr = Math.min(2, devicePixelRatio || 1), W = c.clientWidth || innerWidth, H = c.clientHeight || innerHeight;
  c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  // ground
  const bg = x.createRadialGradient(W * 0.3, H * 0.2, 0, W * 0.4, H * 0.4, Math.max(W, H) * 0.9);
  bg.addColorStop(0, '#1b241e'); bg.addColorStop(1, '#0b100d'); x.fillStyle = bg; x.fillRect(0, 0, W, H);
  // contours (marching squares over value noise)
  const n = noise2(7), cell = 12, sc = 1 / (rem * 14), cols = Math.ceil(W / cell) + 1, rows = Math.ceil(H / cell) + 1;
  const f = new Float32Array(cols * rows); for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) f[j * cols + i] = n(i * cell * sc + 3.7, j * cell * sc + 1.3);
  const levels = 16;
  for (let L = 1; L < levels; L++) {
    const iso = 0.18 + L * 0.042; x.beginPath();
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
      const a = f[j * cols + i], b = f[j * cols + i + 1], d = f[(j + 1) * cols + i], e = f[(j + 1) * cols + i + 1];
      const idx = (a > iso) | (b > iso) << 1 | (e > iso) << 2 | (d > iso) << 3; if (idx === 0 || idx === 15) continue;
      const X = i * cell, Y = j * cell, lerp = (p, q) => (iso - p) / (q - p);
      const T = [X + cell * lerp(a, b), Y], R = [X + cell, Y + cell * lerp(b, e)], B = [X + cell * lerp(d, e), Y + cell], Lf = [X, Y + cell * lerp(a, d)];
      const seg = (p, q) => { x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); };
      switch (idx) { case 1: case 14: seg(Lf, T); break; case 2: case 13: seg(T, R); break; case 3: case 12: seg(Lf, R); break; case 4: case 11: seg(R, B); break; case 6: case 9: seg(T, B); break; case 7: case 8: seg(Lf, B); break; case 5: seg(Lf, T); seg(R, B); break; case 10: seg(T, R); seg(B, Lf); break; }
    }
    x.strokeStyle = L % 5 === 0 ? 'rgba(176,160,120,.16)' : 'rgba(150,170,140,.075)'; x.lineWidth = L % 5 === 0 ? 1.1 : 0.8; x.stroke();
  }
  // kilometre grid with references along the top and left edges
  const g = rem * 9, ox = (W % g) / 2, oy = (H % g) / 2, e0 = 37, n0 = 54;
  x.strokeStyle = 'rgba(190,210,185,.07)'; x.lineWidth = 1; x.beginPath();
  for (let X = ox; X < W; X += g) { x.moveTo(Math.round(X) + .5, 0); x.lineTo(Math.round(X) + .5, H); }
  for (let Y = oy; Y < H; Y += g) { x.moveTo(0, Math.round(Y) + .5); x.lineTo(W, Math.round(Y) + .5); }
  x.stroke();
  x.fillStyle = 'rgba(190,210,185,.28)'; x.font = `600 ${Math.round(rem * 0.68)}px "Barlow SC", sans-serif`; x.textBaseline = 'top';
  let k = 0; for (let X = ox; X < W - 10; X += g) x.fillText(String(e0 + k++).padStart(2, '0'), Math.round(X) + 4, 4);
  k = 0; for (let Y = oy; Y < H - 10; Y += g) x.fillText(String(n0 - k++), 4, Math.round(Y) + 4);
  // grease-pencil overlay, mostly right of the title column
  const r = rng(11), U = W / 100, V = H / 100;
  x.lineCap = 'round'; x.lineJoin = 'round';
  // enemy forward line: red, scalloped
  x.strokeStyle = 'rgba(234,90,75,.42)'; x.lineWidth = 2; x.beginPath();
  const fl = [[38, 15], [50, 20], [60, 17], [71, 23], [83, 19], [100, 25]].map(([a, b]) => [a * U, b * V]);
  x.moveTo(...fl[0]); for (let i = 1; i < fl.length; i++) x.lineTo(...fl[i]); x.stroke();
  for (let i = 0; i < fl.length - 1; i++) { const [a, b] = fl[i], [c2, d] = fl[i + 1], len = Math.hypot(c2 - a, d - b), nn = Math.floor(len / 26); for (let s = 0; s < nn; s++) { const t = (s + .5) / nn, px = a + (c2 - a) * t, py = b + (d - b) * t, ang = Math.atan2(d - b, c2 - a); x.beginPath(); x.arc(px, py, 5, ang + Math.PI, ang + Math.PI * 2); x.stroke(); } }
  // friendly axis of advance: blue double-line arrow
  const ax = [[46, 102], [53, 90], [62, 82], [70, 77]].map(([a, b]) => [a * U, b * V]);
  const off = (pts, d) => pts.map((p, i) => { const q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)], dx = q[0] - o[0], dy = q[1] - o[1], l = Math.hypot(dx, dy) || 1; return [p[0] - dy / l * d, p[1] + dx / l * d]; });
  const w = rem * 1.6; x.strokeStyle = 'rgba(92,178,230,.38)'; x.lineWidth = 2;
  for (const s of [-1, 1]) { const o = off(ax, w * s); x.beginPath(); x.moveTo(...o[0]); for (const p of o.slice(1)) x.lineTo(...p); x.stroke(); }
  const tip = ax[ax.length - 1], pr = ax[ax.length - 2], an = Math.atan2(tip[1] - pr[1], tip[0] - pr[0]);
  x.beginPath(); for (const s of [-1, 1]) { x.moveTo(tip[0] + Math.cos(an) * w * 1.6, tip[1] + Math.sin(an) * w * 1.6); x.lineTo(tip[0] + Math.cos(an + s * Math.PI / 2) * w * 2, tip[1] + Math.sin(an + s * Math.PI / 2) * w * 2); } x.stroke();
  // objective outline
  x.strokeStyle = 'rgba(223,228,214,.3)'; x.setLineDash([6, 5]); x.lineWidth = 1.6; x.beginPath();
  for (let i = 0; i <= 24; i++) { const a = i / 24 * Math.PI * 2, rr = rem * 2.6 * (1 + 0.18 * Math.sin(a * 3 + 1)); const px = 86 * U + Math.cos(a) * rr * 1.3, py = 9 * V + Math.sin(a) * rr; i ? x.lineTo(px, py) : x.moveTo(px, py); }
  x.stroke(); x.setLineDash([]);
  x.fillStyle = 'rgba(223,228,214,.38)'; x.font = `700 ${Math.round(rem * 1.1)}px "Stencil", "Barlow SC", sans-serif`; x.textBaseline = 'middle'; x.textAlign = 'center'; x.fillText('OBJ A', 86 * U, 9 * V);
  x.font = `600 ${Math.round(rem * .75)}px "Barlow SC", sans-serif`; x.fillStyle = 'rgba(234,90,75,.5)'; x.textAlign = 'left'; x.fillText('FLOT', fl[2][0] + 6, fl[2][1] - 12);
  // unit symbols
  const sym = (px, py, friend, inner) => { x.lineWidth = 1.6; x.strokeStyle = friend ? 'rgba(92,178,230,.5)' : 'rgba(234,90,75,.5)'; x.fillStyle = friend ? 'rgba(92,178,230,.07)' : 'rgba(234,90,75,.07)'; x.beginPath(); const s = rem * 0.8; if (friend) x.rect(px - s * 1.5, py - s, s * 3, s * 2); else { x.moveTo(px, py - s * 1.4); x.lineTo(px + s * 1.4, py); x.lineTo(px, py + s * 1.4); x.lineTo(px - s * 1.4, py); x.closePath(); } x.fill(); x.stroke(); x.beginPath(); const h = friend ? [s * 1.5, s] : [s * .7, s * .7]; if (inner !== 'tank') { x.moveTo(px - h[0], py - h[1]); x.lineTo(px + h[0], py + h[1]); x.moveTo(px + h[0], py - h[1]); x.lineTo(px - h[0], py + h[1]); } if (inner !== 'inf') x.ellipse(px, py, h[0] * .6, h[1] * .5, 0, 0, 7); x.stroke(); };
  sym(58 * U, 92 * V, true, 'mech'); sym(66 * U, 95 * V, true, 'tank'); sym(90 * U, 86 * V, true, 'inf');
  sym(57 * U, 8 * V, false, 'inf'); sym(70 * U, 12 * V, false, 'mech');
  void r;
}

const c = document.getElementById('menuBg');
if (c) {
  const draw = () => { if (!document.getElementById('menu')?.classList.contains('hidden')) drawMenuBackdrop(c); };
  let t = 0; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(draw, 120); });
  draw(); document.fonts?.ready.then(draw);
}
