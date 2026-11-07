// Betaflight-style OSD for the FPV drone view (ui/droneFeed.js).
// An analog FPV picture carries the flight controller's OSD keyed into the video by a MAX7456-type chip: a fixed
// character grid of chunky white glyphs with a black outline, Betaflight's stock layout (link quality top left, flight
// time top right, pack voltage and mAh bottom left, altitude bottom right, crosshair and artificial horizon in the
// middle, warnings under the crosshair). This draws that on a transparent canvas laid over the feed:
//   * glyphs: a 5x7 bitmap font (+ Betaflight-like icons) rendered once into an atlas per pixel size p, white with a
//     p-pixel black outline; one drawImage per character after that.
//   * the canvas has the screen area's device-pixel size; p = whole device pixels per font pixel, so the glyphs stay
//     crisp (no CSS scaling, no filters).
//   * draw(state) is called ~15 Hz by droneFeed.js; it redraws only when the text or the horizon moved.
const F = {
  '0': '.###.#...##..###.#.###..##...#.###.', '1': '..#...##....#....#....#....#...###.', '2': '.###.#...#....#...#...#...#...#####',
  '3': '#####...#...#.....#.....##...#.###.', '4': '...#...##..#.#.#..#.#####...#....#.', '5': '######....####.....#....##...#.###.',
  '6': '..##..#...#....####.#...##...#.###.', '7': '#####....#...#...#...#....#....#...', '8': '.###.#...##...#.###.#...##...#.###.',
  '9': '.###.#...##...#.####....#...#..##..',
  A: '.###.#...##...#######...##...##...#', B: '####.#...##...#####.#...##...#####.', C: '.###.#...##....#....#....#...#.###.',
  D: '####.#...##...##...##...##...#####.', E: '######....#....####.#....#....#####', F: '######....#....####.#....#....#....',
  G: '.###.#...##....#.####...##...#.####', H: '#...##...##...#######...##...##...#', I: '.###...#....#....#....#....#...###.',
  J: '..###...#....#....#....##..#..##...', K: '#...##..#.#.#..##...#.#..#..#.#...#', L: '#....#....#....#....#....#....#####',
  M: '#...###.###.#.##.#.##...##...##...#', N: '#...##...###..##.#.##..###...##...#', O: '.###.#...##...##...##...##...#.###.',
  P: '####.#...##...#####.#....#....#....', Q: '.###.#...##...##...##.#.##..#..##.#', R: '####.#...##...#####.#.#..#..#.#...#',
  S: '.#####....#.....###.....#....#####.', T: '#####..#....#....#....#....#....#..', U: '#...##...##...##...##...##...#.###.',
  V: '#...##...##...##...##...#.#.#...#..', W: '#...##...##...##.#.##.#.##.#.#.#.#.', X: '#...##...#.#.#...#...#.#.#...##...#',
  Y: '#...##...#.#.#...#....#....#....#..', Z: '#####....#...#...#...#...#....#####',
  ' ': '...................................', '.': '..........................##...##..', ':': '......##...##.........##...##......',
  '%': '##...##..#...#...#...#...#..##...##', '/': '.........#...#...#...#...#.........', '-': '...............#####...............',
  '+': '.......#....#..#####..#....#.......', '<': '...#...#...#...#.....#.....#.....#.', '>': '.#.....#.....#.....#...#...#...#...',
  // icons (Betaflight glyph roles): b battery, u altitude
  b: '.###.######...##...################',
  u: '..#...###.#####..#....#....#....#..',
};
const GW = 5, GH = 7, CW = 6, CH = 9;   // glyph, cell (font pixels)

function atlas(p) {
  const keys = Object.keys(F), cw = (GW + 2) * p, ch = (GH + 2) * p, c = document.createElement('canvas');
  c.width = cw * keys.length; c.height = ch; const x = c.getContext('2d'), idx = {};
  keys.forEach((k, i) => {
    const s = F[k], ox = i * cw; idx[k] = ox;
    x.fillStyle = '#000';   // outline: every lit pixel grown by one font pixel
    for (let r = 0; r < GH; r++) for (let q = 0; q < GW; q++) if (s[r * GW + q] === '#') x.fillRect(ox + q * p, r * p, 3 * p, 3 * p);
    x.fillStyle = '#f4f4ef';
    for (let r = 0; r < GH; r++) for (let q = 0; q < GW; q++) if (s[r * GW + q] === '#') x.fillRect(ox + (q + 1) * p, (r + 1) * p, p, p);
  });
  return { c, idx, cw, ch };
}

export class Osd {
  constructor(canvas) { this.cv = canvas; this.x = canvas.getContext('2d'); this.p = 0; this.key = ''; }
  // canvas size in device pixels (whole numbers): called from droneFeed.layout()
  size(w, h, dpr) {
    const W = Math.round(w * dpr), H = Math.round(h * dpr); if (W === this.cv.width && H === this.cv.height && this.p) return;
    this.cv.width = W; this.cv.height = H; this.p = Math.max(1, Math.round(W / 190)); this.A = atlas(this.p); this.key = '';
  }
  clear() { if (this.key !== '') { this.x.clearRect(0, 0, this.cv.width, this.cv.height); this.key = ''; } }
  // text at cell column / row; col < 0 counts from the right edge (right-aligned), row < 0 from the bottom
  txt(s, col, row) {
    const { p } = this, W = this.cv.width, H = this.cv.height, mx = Math.round(W * 0.045), my = Math.round(H * 0.06), cw = CW * p, chh = CH * p;
    this.at(s, col >= 0 ? mx + col * cw : W - mx - (s.length - 1) * cw - GW * p, row >= 0 ? my + row * chh : H - my - (-row) * chh + (CH - GH) * p);
  }
  ctr(s, row) { const H = this.cv.height, my = Math.round(H * 0.06), chh = CH * this.p; this.at(s, this.cv.width / 2 - (s.length * CW - 1) * this.p / 2, row >= 0 ? my + row * chh : H - my - (-row) * chh + (CH - GH) * this.p); }
  // text with its first glyph's top-left pixel at (x, y), snapped to the font-pixel grid
  at(s, x, y) {
    const { p, A } = this; x = Math.round(x / p) * p; y = Math.round(y / p) * p;
    for (const ch of s) { const o = A.idx[ch] ?? A.idx[ch.toUpperCase()]; if (o != null && ch !== ' ') this.x.drawImage(A.c, o, 0, A.cw, A.ch, x - p, y - p, A.cw, A.ch); x += CW * p; }
  }
  bar(x, y, w, h) { const p = this.p, c = this.x; c.fillStyle = '#000'; c.fillRect(x - p, y - p, w + 2 * p, h + 2 * p); c.fillStyle = '#f4f4ef'; c.fillRect(x, y, w, h); }
  // s: { lq, rssi, time, volt, mah, alt, spd, dst, name, roll, pitch, warn }
  draw(s) {
    if (!this.p) return;
    const ah = Math.round(s.roll * 40) / 40, ap = Math.round(s.pitch * 60) / 60;   // (quantised: the horizon moves in steps, as on a char OSD)
    const key = `${s.lq}|${s.rssi}|${s.time}|${s.volt}|${s.mah}|${s.alt}|${s.spd}|${s.dst}|${s.name}|${ah}|${ap}|${s.warn}`; if (key === this.key) return; this.key = key;
    const c = this.x, W = this.cv.width, H = this.cv.height, p = this.p; c.clearRect(0, 0, W, H);
    // corners: Betaflight's stock layout
    this.txt(`LQ ${s.lq}`, 0, 0); this.txt(`${s.rssi}DBM`, 0, 1);
    this.ctr(s.name, 0);
    this.txt(s.time, -1, 0);
    this.txt(`${s.mah}MAH`, 0, -2); this.txt(`b${s.volt}V`, 0, -1);
    this.ctr(`${s.spd}KMH`, -1);
    this.txt(`TGT ${s.dst}M`, -1, -2); this.txt(`u${s.alt}M`, -1, -1);
    // crosshair
    const cx = Math.round(W / 2 / p) * p, cy = Math.round(H / 2 / p) * p;
    this.bar(cx - 7 * p, cy, 5 * p, p); this.bar(cx + 3 * p, cy, 5 * p, p); this.bar(cx, cy, p, p);
    // artificial horizon: dashes along the rolled line, offset by the airframe's pitch, snapped to the pixel grid
    const off = Math.max(-H * 0.2, Math.min(H * 0.2, ap * H * 0.45)), ca = Math.cos(ah), sa = Math.sin(ah), step = CW * p * 1.6;
    for (let i = -4; i <= 4; i++) {
      if (Math.abs(i) < 2) continue;
      const px = Math.round((cx + ca * i * step - sa * off) / p) * p, py = Math.round((cy + sa * i * step + ca * off) / p) * p;
      this.bar(px - 2 * p, py, 4 * p, p);
    }
    // side bars: ladders either side of the centre, < > on the centre rung
    const sx = Math.round(W * 0.3 / p) * p;
    for (let j = -2; j <= 2; j++) { if (!j) continue; const y = cy + j * CH * p; this.bar(cx - sx, y, 2 * p, p); this.bar(cx + sx - p, y, 2 * p, p); }
    const ox = this.A.cw; c.drawImage(this.A.c, this.A.idx['>'], 0, ox, this.A.ch, cx - sx - 2 * p, cy - 4 * p, ox, this.A.ch); c.drawImage(this.A.c, this.A.idx['<'], 0, ox, this.A.ch, cx + sx - 4 * p, cy - 4 * p, ox, this.A.ch);
    if (s.warn) this.at(s.warn, cx - (s.warn.length * CW - 1) * p / 2, cy + Math.round(CH * 2.3) * p);
  }
}
