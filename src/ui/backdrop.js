// Animated menu / loading backdrop: a procedural dusk horizon over a ruined town — layered skyline
// silhouettes with mouse parallax, drifting cloud deck, smoke columns rising behind the buildings,
// distant artillery flashes, embers and ash. Everything is generated (no imagery).
// Cost: static layers are pre-rendered once per resize; a frame is ~6 drawImage calls plus ~150
// small sprites, drawn at reduced resolution and capped at 30 fps (12 fps while loading), and the
// loop stops entirely when neither the menu nor the loading screen is visible.

function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function noise1(seed) { const r = rng(seed), g = Array.from({ length: 256 }, r); return x => { const i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f); return g[i & 255] * (1 - s) + g[(i + 1) & 255] * s; }; }
function noise2(seed) {
  const r = rng(seed), N = 64, g = new Float32Array(N * N).map(() => r());
  const at = (i, j) => g[((j % N + N) % N) * N + ((i % N + N) % N)], sm = t => t * t * (3 - 2 * t);
  const v = (x, y) => { const i = Math.floor(x), j = Math.floor(y), fx = sm(x - i), fy = sm(y - j); const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1); return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy; };
  return (x, y) => v(x, y) * 0.5 + v(x * 2.03 + 17, y * 2.03 + 5) * 0.27 + v(x * 4.1 + 3, y * 4.1 + 29) * 0.15 + v(x * 8.3 + 7, y * 8.3 + 1) * 0.08;
}
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; };

export class Backdrop {
  constructor(canvas) {
    this.c = canvas; this.x = canvas.getContext('2d', { alpha: false });
    this.mx = 0; this.my = 0; this.px = 0; this.py = 0; this.t = 0; this.last = 0; this.acc = 0;
    this.running = false; this.mode = 'menu';
    this.reduced = matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    addEventListener('mousemove', e => { this.mx = e.clientX / innerWidth * 2 - 1; this.my = e.clientY / innerHeight * 2 - 1; }, { passive: true });
    let rt = 0; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (this.running) { this.build(); this.draw(0); } }, 150); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.running) this.kick(); });
  }
  // ---------------------------------------------------------------- static layers
  build() {
    const cssW = this.c.clientWidth || innerWidth, cssH = this.c.clientHeight || innerHeight; this.cssW = cssW; this.cssH = cssH;
    const s = Math.min(1, (devicePixelRatio || 1) * 0.6, 1280 / Math.max(cssW, 1)) * (this.lowRes ? 0.7 : 1);   // backing scale: soft is fine, the scene is hazy
    const W = Math.round(cssW * s), H = Math.round(cssH * s); this.c.width = W; this.c.height = H;
    this.W = W; this.H = H; const U = Math.min(W, H * 1.78) / 100;   // layout unit ~1% of a 16:9 width
    this.U = U; const M = this.M = Math.round(U * 4);               // parallax margin
    const hz = this.hz = H * 0.6;
    // sky
    const sky = mk(W, H), sx = sky.getContext('2d');
    let g = sx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#0a0d0f'); g.addColorStop(0.3, '#15191a'); g.addColorStop(0.5, '#2b2925'); g.addColorStop(0.6, '#4d4033'); g.addColorStop(0.68, '#2c261f'); g.addColorStop(1, '#0a0b0b');
    sx.fillStyle = g; sx.fillRect(0, 0, W, H);
    g = sx.createRadialGradient(W * 0.7, hz, 0, W * 0.7, hz, W * 0.55); g.addColorStop(0, 'rgba(200,122,58,.55)'); g.addColorStop(0.3, 'rgba(150,96,52,.25)'); g.addColorStop(1, 'rgba(60,44,30,0)');
    sx.fillStyle = g; sx.fillRect(0, 0, W, H);
    this.sky = sky;
    // cloud deck (low-res fbm, upscaled smooth, tiled horizontally)
    const CW = 320, CH = 110, cl = mk(CW, CH), cx = cl.getContext('2d'), id = cx.createImageData(CW, CH), n = noise2(3);
    for (let j = 0; j < CH; j++) for (let i = 0; i < CW; i++) {
      const u = i / CW, k = j * CW + i;
      // periodic in x so the deck can scroll
      const a = n(Math.cos(u * Math.PI * 2) * 1.6 + 5, j / CH * 2.6 + Math.sin(u * Math.PI * 2) * 1.6);
      const d = Math.max(0, Math.min(1, (a - 0.42) * 3.2)) * (0.35 + 0.65 * (1 - j / CH));
      const lit = j / CH; id.data[k * 4] = 34 + lit * 40; id.data[k * 4 + 1] = 33 + lit * 28; id.data[k * 4 + 2] = 32 + lit * 18; id.data[k * 4 + 3] = d * 200;
    }
    cx.putImageData(id, 0, 0); this.cloud = cl;
    // skyline layers
    const r = rng(1917);
    this.far = this.layer(W + M * 2, H, (x, w, h) => {
      const base = hz + U * 1.2;
      // farthest row: low, hazy roofline
      x.fillStyle = '#2b2925';
      for (let X = -U * 2; X < w;) { const bw = U * (1.5 + r() * 3.5), bh = U * (1.5 + r() * 3.5); x.fillRect(X, base - bh, bw, bh + 2); X += bw + U * r() * 0.6; }
      // panel blocks: flat roofs, some shelled open, window grid, the odd burning window
      const blocks = [];
      for (let X = -U * 2; X < w;) {
        const f = X / w, bw = U * (2.6 + r() * 4.2), bh = U * (3.5 + r() * 6.5) * (f > 0.4 ? 1 : 0.75); X += bw + U * (0.6 + r() * 2.2);
        if (r() < 0.12) continue; blocks.push([X - bw, bw, bh]);
      }
      for (const [x0, bw, bh] of blocks) {
        const top = base - bh; x.fillStyle = '#1b1c1d';
        x.beginPath(); x.moveTo(x0, base); x.lineTo(x0, top);
        if (r() < 0.4) { const a = x0 + bw * (0.2 + r() * 0.4), b = a + bw * (0.2 + r() * 0.3), d = bh * (0.15 + r() * 0.35); x.lineTo(a, top); x.lineTo(a + (b - a) * 0.3, top + d); x.lineTo(a + (b - a) * 0.6, top + d * 0.6); x.lineTo(b, top + d * 1.1); x.lineTo(b, top); }
        x.lineTo(x0 + bw, top); x.lineTo(x0 + bw, base); x.closePath(); x.fill();
        // windows: barely-lighter cells, a few lit / burning
        const cw = U * 0.42, ch = U * 0.5, cols = Math.floor(bw / (cw * 1.7)), rows = Math.floor(bh / (ch * 1.6));
        for (let j = 1; j < rows; j++) for (let i = 0; i < cols; i++) {
          const wx = x0 + (i + 0.5) * bw / cols - cw / 2, wy = top + j * bh / rows - ch / 2; if (wy < top + ch) continue;
          const q = r(); x.fillStyle = q < 0.012 ? 'rgba(214,128,56,.85)' : q < 0.03 ? 'rgba(170,140,100,.35)' : 'rgba(255,255,255,.035)';
          x.fillRect(wx, wy, cw, ch);
        }
      }
      // a construction crane far right — a generic town silhouette
      x.strokeStyle = '#1b1c1d'; x.lineWidth = U * 0.22; x.beginPath(); const cxp = w * 0.83; x.moveTo(cxp, base); x.lineTo(cxp, base - U * 14); x.lineTo(cxp - U * 8, base - U * 13.4); x.moveTo(cxp + U * 2.2, base - U * 13.7); x.lineTo(cxp, base - U * 14); x.moveTo(cxp - U * 6.5, base - U * 13.45); x.lineTo(cxp - U * 6.5, base - U * 11); x.stroke();
      x.fillStyle = '#1b1c1d'; x.fillRect(0, base, w, h - base);
    });
    this.mid = this.layer(W + M * 2, H, (x, w, h) => {
      const base = hz + U * 5.5; x.fillStyle = '#121415'; x.strokeStyle = '#121415';
      // low houses with pitched (sometimes broken) roofs, bare trees, utility poles with sagging wires
      for (let X = -U * 3; X < w;) {
        const kind = r(); X += U * (1 + r() * 3);
        if (kind < 0.42) {
          const bw = U * (3 + r() * 3), bh = U * (2 + r() * 2), rf = U * (1.2 + r() * 1.6);
          x.beginPath(); x.moveTo(X, base); x.lineTo(X, base - bh); x.lineTo(X + bw * 0.5, base - bh - rf);
          if (r() < 0.4) { x.lineTo(X + bw * 0.62, base - bh - rf * 0.4); x.lineTo(X + bw * 0.75, base - bh - rf * 0.7); }
          x.lineTo(X + bw, base - bh); x.lineTo(X + bw, base); x.closePath(); x.fill(); X += bw;
        } else if (kind < 0.8) {
          const th = U * (4 + r() * 7); this.tree(x, X, base, th, U, r); X += U * (1 + r() * 2);
        } else X += U * 2;
      }
      // poles + wires
      x.lineWidth = Math.max(1, U * 0.18); const poles = []; for (let X = w * 0.04; X < w; X += U * (11 + r() * 4)) poles.push(X);
      for (const p of poles) { x.beginPath(); x.moveTo(p, base); x.lineTo(p + U * 0.2, base - U * 9); x.stroke(); x.beginPath(); x.moveTo(p - U * 1.2, base - U * 8.4); x.lineTo(p + U * 1.6, base - U * 8.6); x.stroke(); }
      x.lineWidth = Math.max(0.7, U * 0.07);
      for (let i = 0; i < poles.length - 1; i++) for (const o of [-1, 1.4]) { if (r() < 0.12) continue; const a = poles[i] + o * U, b = poles[i + 1] + o * U, y = base - U * 8.5; x.beginPath(); x.moveTo(a, y); x.quadraticCurveTo((a + b) / 2, y + U * 1.6, b, y); x.stroke(); }
      // ground plane with a soft haze line
      x.fillRect(0, base, w, h - base);
    });
    this.fg = this.layer(W + M * 2, H, (x, w, h) => {
      const n1 = noise1(77), base = hz + U * 12;
      x.fillStyle = '#08090a'; x.beginPath(); x.moveTo(0, h);
      for (let X = 0; X <= w; X += U * 0.8) x.lineTo(X, base - n1(X / (U * 9)) * U * 5 - (X / w > 0.55 ? U * 2.2 : 0) + n1(X / U * 0.9 + 40) * U * 0.7);
      x.lineTo(w, h); x.closePath(); x.fill();
      x.strokeStyle = '#08090a'; x.lineCap = 'round';
      const ground = X => base - n1(X / (U * 9)) * U * 5 - (X / w > 0.55 ? U * 2.2 : 0);
      // burnt-out armoured hull on the ridge (generic silhouette)
      const hx = w * 0.69, hy = ground(hx) + U * 0.6;
      x.beginPath(); x.moveTo(hx - U * 6, hy); x.lineTo(hx - U * 5.4, hy - U * 1.9); x.lineTo(hx + U * 5.2, hy - U * 1.9); x.lineTo(hx + U * 6.2, hy - U * 0.6); x.lineTo(hx + U * 5.8, hy); x.closePath(); x.fill();
      x.beginPath(); x.moveTo(hx - U * 2.6, hy - U * 1.9); x.lineTo(hx - U * 2, hy - U * 3.1); x.lineTo(hx + U * 1.6, hy - U * 3.2); x.lineTo(hx + U * 2.4, hy - U * 1.9); x.closePath(); x.fill();
      x.lineWidth = U * 0.42; x.beginPath(); x.moveTo(hx + U * 1.6, hy - U * 2.6); x.lineTo(hx + U * 7.5, hy - U * 1.5); x.stroke();
      // anti-tank hedgehogs + a wire fence
      const hog = (px, sz) => { const y = ground(px) + sz * 0.15; x.lineWidth = sz * 0.16; x.beginPath(); x.moveTo(px - sz * 0.6, y); x.lineTo(px + sz * 0.45, y - sz); x.moveTo(px + sz * 0.6, y); x.lineTo(px - sz * 0.4, y - sz * 0.95); x.moveTo(px - sz * 0.15, y + sz * 0.05); x.lineTo(px + sz * 0.1, y - sz * 1.05); x.stroke(); };
      for (const [fx, sz] of [[0.5, 2.6], [0.555, 2.1], [0.6, 2.9], [0.86, 2.4], [0.93, 3.2]]) hog(w * fx, U * sz);
      x.lineWidth = Math.max(1, U * 0.16);
      for (let X = w * 0.36; X < w; X += U * 4.5) { const y = ground(X); x.beginPath(); x.moveTo(X, y + U * 0.4); x.lineTo(X + U * 0.3, y - U * 2.3); x.stroke(); }
      x.lineWidth = Math.max(0.6, U * 0.06); for (const k of [1.2, 2]) { x.beginPath(); for (let X = w * 0.36; X < w; X += U * 1.5) { const y = ground(X) - U * k + Math.sin(X * 0.3) * U * 0.15; X === w * 0.36 ? x.moveTo(X, y) : x.lineTo(X, y); } x.stroke(); }
    });
    // haze bands between layers
    const haze = (y0, y1, a) => { const c = mk(1, H), x = c.getContext('2d'), g = x.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, 'rgba(96,76,58,0)'); g.addColorStop(0.6, `rgba(96,76,58,${a})`); g.addColorStop(1, 'rgba(96,76,58,0)'); x.fillStyle = g; x.fillRect(0, 0, 1, H); return c; };
    this.haze1 = haze(hz - U * 6, hz + U * 3, 0.2); this.haze2 = haze(hz + U * 2, hz + U * 8, 0.16);
    // sprites
    const blob = (rad, col, a) => { const c = mk(rad * 2, rad * 2), x = c.getContext('2d'), g = x.createRadialGradient(rad, rad, 0, rad, rad, rad); g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(0.55, `rgba(${col},${a * 0.45})`); g.addColorStop(1, `rgba(${col},0)`); x.fillStyle = g; x.fillRect(0, 0, rad * 2, rad * 2); return c; };
    this.smokeS = blob(48, '66,61,56', 0.5); this.smokeL = blob(48, '128,96,68', 0.34); this.glowS = blob(48, '255,140,60', 0.55); this.flashS = blob(64, '255,196,140', 0.5);
    // smoke sources: [x fraction of the far layer, base y, strength]
    this.sources = [[0.6, hz + U * 1, 1], [0.765, hz + U * 1.5, 1.4], [0.9, hz + U * 2.5, 0.8], [0.44, hz + U * 0.8, 0.55]];
    this.smoke = []; this.embers = []; this.ash = []; this.flashes = []; this.nextFlash = 1.5;
    const ar = rng(5); for (let i = 0; i < 70; i++) this.ash.push({ x: ar() * W, y: ar() * H, v: 0.2 + ar() * 0.8, s: 0.6 + ar() * 1.6, p: ar() * 6 });
    // pre-warm the smoke so columns are fully grown on the first frame
    for (let i = 0; i < 260; i++) this.step(1 / 15);
  }
  layer(w, h, paint) { const c = mk(w, h), x = c.getContext('2d'); paint(x, w, h); return c; }
  tree(x, px, base, th, U, r) {
    x.lineCap = 'round';
    const br = (X, Y, len, ang, wdt, d) => { const X2 = X + Math.sin(ang) * len, Y2 = Y - Math.cos(ang) * len; x.lineWidth = Math.max(0.6, wdt); x.beginPath(); x.moveTo(X, Y); x.lineTo(X2, Y2); x.stroke(); if (d > 0) { const k = 2 + (r() < 0.4 ? 1 : 0); for (let i = 0; i < k; i++) br(X2, Y2, len * (0.55 + r() * 0.2), ang + (r() - 0.5) * 1.3, wdt * 0.62, d - 1); } };
    br(px, base, th * 0.42, (r() - 0.5) * 0.12, U * 0.32, 4);
  }
  // ---------------------------------------------------------------- simulation
  step(dt) {
    const U = this.U, W = this.W, M = this.M;
    this.t += dt;
    for (const [fx, by, k] of this.sources) {
      if (this.smoke.length < 170 && Math.random() < dt * 5 * k) this.smoke.push({ x: fx * (W + M * 2) + (Math.random() - 0.5) * U, y: by, vx: (0.4 + Math.random() * 0.5) * U, vy: -(1.6 + Math.random() * 1.2) * U * (0.8 + k * 0.2), r: U * (0.9 + Math.random() * 0.6) * k, g: U * (1.1 + Math.random() * 0.5) * (0.7 + k * 0.3), life: 0, max: 8 + Math.random() * 5, lit: Math.random() < 0.5 });
      if (Math.random() < dt * 3 * k) this.embers.push({ x: fx * (W + M * 2), y: by, vx: (Math.random() - 0.3) * U * 1.2, vy: -(2 + Math.random() * 3) * U, life: 0, max: 1.5 + Math.random() * 2.5 });
    }
    for (const p of this.smoke) { p.life += dt; p.x += (p.vx + p.life * 0.18 * U) * dt; p.y += p.vy * dt; p.vy *= 1 - 0.06 * dt; p.r += p.g * dt; }
    this.smoke = this.smoke.filter(p => p.life < p.max);
    for (const p of this.embers) { p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx += 0.6 * U * dt; }
    this.embers = this.embers.filter(p => p.life < p.max);
    for (const a of this.ash) { a.y += a.v * U * 0.6 * dt; a.x += (0.5 + Math.sin(this.t * 0.7 + a.p)) * U * 0.25 * dt; if (a.y > this.H) { a.y = -4; a.x = Math.random() * W; } if (a.x > W) a.x -= W; }
    this.nextFlash -= dt;
    if (this.nextFlash <= 0) { this.nextFlash = 1.8 + Math.random() * 5; const n = Math.random() < 0.3 ? 3 : 1; for (let i = 0; i < n; i++) this.flashes.push({ x: (0.42 + Math.random() * 0.55) * (W + M * 2), t: -i * 0.18, d: 0.35 + Math.random() * 0.35, s: 0.6 + Math.random() * 0.9 }); }
    for (const f of this.flashes) f.t += dt;
    this.flashes = this.flashes.filter(f => f.t < f.d);
  }
  // ---------------------------------------------------------------- frame
  draw() {
    const x = this.x, W = this.W, H = this.H, M = this.M, U = this.U, hz = this.hz;
    // eased parallax: mouse + a slow drift
    this.px += (this.mx - this.px) * 0.04; this.py += (this.my - this.py) * 0.04;
    const dx = this.px + Math.sin(this.t * 0.05) * 0.35, dy = this.py * 0.5;
    const off = k => [-M + -dx * M * k, -dy * U * 1.2 * k];
    x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1;
    x.drawImage(this.sky, 0, 0);
    // flashes light the cloud base and the horizon behind the skyline
    x.globalCompositeOperation = 'lighter';
    let fl = 0;
    for (const f of this.flashes) { if (f.t < 0) continue; const a = (1 - f.t / f.d) ** 2 * f.s; fl = Math.max(fl, a); const [ox, oy] = off(0.25); const R = U * 22 * f.s; x.globalAlpha = Math.min(1, a); x.drawImage(this.flashS, f.x + ox - R, hz + oy - R * 0.55, R * 2, R * 1.1); }
    x.globalCompositeOperation = 'source-over';
    // clouds: scroll slowly, two copies for the wrap
    const cw = W * 1.6, ch = H * 0.62, cx0 = -((this.t * U * 0.35) % cw) - dx * M * 0.1;
    x.globalAlpha = 0.9 + fl * 0.1; x.drawImage(this.cloud, cx0, -H * 0.02, cw, ch); x.drawImage(this.cloud, cx0 + cw, -H * 0.02, cw, ch);
    x.globalAlpha = 1;
    let [ox, oy] = off(0.25); x.drawImage(this.far, ox, oy);
    x.drawImage(this.haze1, 0, 0, W, H);
    // smoke columns between the far and mid layers; fire glow at their base
    x.globalCompositeOperation = 'lighter';
    for (const [fx, by, k] of this.sources) { const fl2 = 0.55 + 0.25 * Math.sin(this.t * 7 * k + fx * 40) + 0.15 * Math.sin(this.t * 13 + k); x.globalAlpha = Math.max(0, fl2) * Math.min(1, k); const R = U * 3.2 * k; x.drawImage(this.glowS, fx * (W + M * 2) + ox - R, by + oy - R * 0.7, R * 2, R * 1.4); }
    x.globalCompositeOperation = 'source-over';
    [ox, oy] = off(0.3);
    for (const p of this.smoke) {
      const a = Math.min(1, p.life / 1.2) * (1 - p.life / p.max);
      x.globalAlpha = a; const R = p.r; x.drawImage(p.lit && p.life < 2 ? this.smokeL : this.smokeS, p.x + ox - R, p.y + oy - R, R * 2, R * 2);
    }
    x.globalAlpha = 1;
    [ox, oy] = off(0.5); x.drawImage(this.mid, ox, oy);
    x.drawImage(this.haze2, 0, 0, W, H);
    // embers
    x.globalCompositeOperation = 'lighter'; [ox, oy] = off(0.3);
    for (const p of this.embers) { const a = 1 - p.life / p.max; x.globalAlpha = a * (0.6 + 0.4 * Math.sin(p.life * 20)); x.fillStyle = '#ff9a4a'; x.fillRect(p.x + ox, p.y + oy, Math.max(1, U * 0.18), Math.max(1, U * 0.18)); }
    x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1;
    [ox, oy] = off(1); x.drawImage(this.fg, ox, oy);
    // ash in front of everything
    x.fillStyle = 'rgba(190,180,165,.5)';
    for (const a of this.ash) { x.globalAlpha = 0.35 + 0.3 * Math.sin(this.t + a.p); x.fillRect(a.x - dx * M * 1.3, a.y, a.s, a.s); }
    x.globalAlpha = 1;
  }
  // ---------------------------------------------------------------- loop control
  start(mode = 'menu') {
    this.mode = mode;
    if (this.running) return; this.running = true;
    if (!this.W || this.cssW !== (this.c.clientWidth || innerWidth) || this.cssH !== (this.c.clientHeight || innerHeight)) this.build();
    this.draw(); if (!this.reduced) this.kick();
  }
  stop() { this.running = false; cancelAnimationFrame(this.raf); }
  kick() {
    cancelAnimationFrame(this.raf); this.last = performance.now();
    const loop = now => {
      if (!this.running || document.hidden) return;
      const dt = Math.min(0.1, (now - this.last) / 1000); this.last = now; this.acc += dt;
      const frame = 1 / (this.mode === 'loading' ? 12 : 30);
      if (this.acc >= frame * (this.slow ? 2 : 1)) {
        const t0 = performance.now(); this.step(Math.min(this.acc, 0.2)); this.draw(); this.acc = 0;
        // slow machine: halve the rate, then drop the resolution once
        this.cost = (this.cost ?? 4) * 0.9 + (performance.now() - t0) * 0.1;
        if (this.cost > 14 && !this.slow) this.slow = true;
        else if (this.cost > 14 && !this.lowRes) { this.lowRes = true; this.build(); this.cost = 4; }
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
}
