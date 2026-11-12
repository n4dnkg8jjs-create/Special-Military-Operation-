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
      // Soviet-era microdistrict: long five-storey khrushchyovka slabs, nine-storey panel blocks, sixteen-storey point
      // towers; flat roofs with antennas and lift rooms, regular window grids, balcony bands, stairwell columns,
      // shelled corners and burnt-out flats. Plus an Orthodox church with onion domes and a heating-plant chimney.
      const fires = this.fires = [], B = '#1e1f20'; this.blockList = [];
      const church = w * 0.585, stack = w * 0.935;
      const kinds = [['khrush', 0.55], ['panel9', 0.37], ['tower', 0.08]];
      const pick = () => { let q = r(); for (const [k, p] of kinds) if ((q -= p) < 0) return k; return 'khrush'; };
      for (let X = -U * 2; X < w;) {
        if (Math.abs(X - church) < U * 7 || Math.abs(X - stack) < U * 2.5) { X += U * 2; continue; }
        const k = pick(), fh = U * 0.92;   // floor height
        const floors = k === 'khrush' ? 5 : k === 'panel9' ? 9 : 10 + Math.floor(r() * 3);
        const bw = k === 'khrush' ? U * (9 + r() * 6) : k === 'panel9' ? U * (6 + r() * 6) : U * (3.6 + r() * 1.2);
        const bh = floors * fh + U * 0.4, x0 = X, top = base - bh; (this.blockList ||= []).push({ x0, bw, top, floors, fh });
        X += bw + U * (0.8 + r() * 2.4);
        if (x0 + bw < 0) continue;
        // shell damage: a stepped bite out of one top corner, sometimes a collapsed section
        const bite = r() < 0.35 ? { left: r() < 0.5, w: bw * (0.12 + r() * 0.22), d: fh * (1 + Math.floor(r() * 3)) } : null;
        x.fillStyle = B; x.beginPath(); x.moveTo(x0, base);
        if (bite && bite.left) { x.lineTo(x0, top + bite.d); x.lineTo(x0 + bite.w * 0.4, top + bite.d * 0.55); x.lineTo(x0 + bite.w * 0.7, top + bite.d * 0.8); x.lineTo(x0 + bite.w, top); }
        else x.lineTo(x0, top);
        if (bite && !bite.left) { x.lineTo(x0 + bw - bite.w, top); x.lineTo(x0 + bw - bite.w * 0.6, top + bite.d * 0.7); x.lineTo(x0 + bw - bite.w * 0.25, top + bite.d * 0.45); x.lineTo(x0 + bw, top + bite.d); }
        else x.lineTo(x0 + bw, top);
        x.lineTo(x0 + bw, base); x.closePath(); x.fill();
        // roof furniture: lift room(s), antennas
        const lifts = k === 'khrush' ? 0 : k === 'panel9' ? 1 + Math.floor(bw / (U * 5)) : 1;
        for (let i = 0; i < lifts; i++) { const lx = x0 + bw * ((i + 0.5) / lifts) - U * 0.6; if (bite && (bite.left ? lx < x0 + bite.w : lx > x0 + bw - bite.w - U * 1.2)) continue; x.fillRect(lx, top - U * 0.9, U * 1.2, U * 0.9); }
        x.strokeStyle = B; x.lineWidth = Math.max(0.6, U * 0.07);
        for (let i = 0, n = Math.floor(bw / (U * 2.5)); i < n; i++) if (r() < 0.5) { const ax = x0 + bw * (i + 0.3 + r() * 0.4) / n; if (bite && (bite.left ? ax < x0 + bite.w : ax > x0 + bw - bite.w)) continue; const ah = U * (0.8 + r() * 1.2); x.beginPath(); x.moveTo(ax, top); x.lineTo(ax, top - ah); x.moveTo(ax - U * 0.35, top - ah * 0.75); x.lineTo(ax + U * 0.35, top - ah * 0.75); x.stroke(); }
        // facade: window grid per floor, stairwell columns (half-floor offset), balcony bands on some sections
        const cols = Math.max(2, Math.round(bw / (U * 0.95))), cw = bw / cols, stairs = k === 'tower' ? [] : Array.from({ length: Math.max(1, Math.round(bw / (U * 4.2))) }, (_, i) => Math.floor((i + 0.5) * cols / Math.max(1, Math.round(bw / (U * 4.2)))));
        const burnt = new Set(); if (r() < (x0 > w * 0.42 ? 0.8 : 0.3)) { const n = 1 + Math.floor(r() * 3); for (let i = 0; i < n; i++) burnt.add(`${Math.floor(r() * cols)},${1 + Math.floor(r() * (floors - 1))}`); }
        for (let f = 0; f < floors; f++) for (let c = 0; c < cols; c++) {
          const wx = x0 + c * cw + cw * 0.22, wy = base - (f + 1) * fh + fh * 0.28, ww = cw * 0.56, wh = fh * 0.46;
          if (bite && wy < top + bite.d && (bite.left ? wx < x0 + bite.w : wx + ww > x0 + bw - bite.w)) continue;
          if (stairs.includes(c)) { x.fillStyle = 'rgba(255,255,255,.03)'; x.fillRect(x0 + c * cw + cw * 0.38, wy + fh * 0.45, cw * 0.24, wh * 0.7); continue; }
          if (burnt.has(`${c},${f}`)) {   // burnt-out flat: black hole with a scorch plume up the facade, maybe still burning
            x.fillStyle = '#060606'; x.fillRect(wx - cw * 0.12, wy - fh * 0.08, ww + cw * 0.24, wh + fh * 0.16);
            const g = x.createLinearGradient(0, wy, 0, wy - fh * 2.2); g.addColorStop(0, 'rgba(0,0,0,.6)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(wx - cw * 0.1, wy - fh * 2.2, ww + cw * 0.2, fh * 2.2);
            if (fires.length < 8 && x0 > w * 0.4 && r() < 0.75) fires.push({ x: wx + ww / 2, y: wy + wh, s: U * (1.0 + r() * 0.6) });
            continue;
          }
          const q = r(); x.fillStyle = q < 0.015 ? 'rgba(196,150,96,.5)' : q < 0.04 ? 'rgba(150,130,104,.22)' : 'rgba(255,255,255,.04)';
          x.fillRect(wx, wy, ww, wh);
        }
        if (k !== 'tower' && r() < 0.6) { x.fillStyle = 'rgba(255,255,255,.025)'; for (let f = 1; f < floors; f++) x.fillRect(x0 + bw * 0.05, base - f * fh - fh * 0.08, bw * 0.9, fh * 0.07); }
      }
      // make sure a few flats are visibly burning right of the title
      for (const b of this.blockList.filter(b => b.x0 > w * 0.56 && b.x0 + b.bw < w * 0.99).sort(() => r() - 0.5)) {
        if (fires.filter(f => f.x > w * 0.56).length >= 4) break; if (fires.some(f => Math.abs(f.x - (b.x0 + b.bw / 2)) < b.bw)) continue;
        const f0 = 2 + Math.floor(r() * (b.floors - 3)), fx = b.x0 + b.bw * (0.2 + r() * 0.6), fy = base - f0 * b.fh;
        x.fillStyle = '#060606'; x.fillRect(fx - U * 0.5, fy - b.fh * 0.6, U * 1.0, b.fh * 0.6);
        const g = x.createLinearGradient(0, fy - b.fh * 0.6, 0, fy - b.fh * 2.6); g.addColorStop(0, 'rgba(0,0,0,.6)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(fx - U * 0.6, fy - b.fh * 2.6, U * 1.2, b.fh * 2);
        fires.push({ x: fx, y: fy, s: U * (1.1 + r() * 0.6) });
      }
      // Orthodox church: nave, bell tower with tented roof, onion domes on drums, crosses
      { const cx = church, cb = base; x.fillStyle = B; x.strokeStyle = B;
        x.fillRect(cx - U * 4.5, cb - U * 4.2, U * 9, U * 4.2);
        const onion = (ox, oy, r0) => { x.beginPath(); x.moveTo(ox - r0 * 0.55, oy); x.bezierCurveTo(ox - r0 * 1.25, oy - r0 * 0.9, ox - r0 * 0.25, oy - r0 * 1.5, ox, oy - r0 * 2.15); x.bezierCurveTo(ox + r0 * 0.25, oy - r0 * 1.5, ox + r0 * 1.25, oy - r0 * 0.9, ox + r0 * 0.55, oy); x.closePath(); x.fill(); x.lineWidth = Math.max(0.7, r0 * 0.09); x.beginPath(); x.moveTo(ox, oy - r0 * 2.1); x.lineTo(ox, oy - r0 * 3); x.moveTo(ox - r0 * 0.3, oy - r0 * 2.7); x.lineTo(ox + r0 * 0.3, oy - r0 * 2.7); x.moveTo(ox - r0 * 0.22, oy - r0 * 2.35); x.lineTo(ox + r0 * 0.22, oy - r0 * 2.48); x.stroke(); };
        x.fillRect(cx - U * 1.3, cb - U * 7.3, U * 2.6, U * 3.2); onion(cx, cb - U * 7.3, U * 1.25);
        for (const sx of [-1, 1]) { x.fillRect(cx + sx * U * 3.2 - U * 0.6, cb - U * 5.6, U * 1.2, U * 1.5); onion(cx + sx * U * 3.2, cb - U * 5.6, U * 0.7); }
        x.fillRect(cx - U * 8, cb - U * 8.5, U * 2.2, U * 8.5); x.beginPath(); x.moveTo(cx - U * 8.2, cb - U * 8.5); x.lineTo(cx - U * 6.9, cb - U * 11.2); x.lineTo(cx - U * 5.6, cb - U * 8.5); x.fill(); onion(cx - U * 6.9, cb - U * 11, U * 0.45);
        x.fillStyle = 'rgba(255,255,255,.035)'; for (const wx of [-2.6, -0.4, 1.8]) x.fillRect(cx + wx * U, cb - U * 3.2, U * 0.6, U * 1.6); }
      // heating-plant chimney (banded) with its own smoke
      { x.fillStyle = B; x.beginPath(); x.moveTo(stack - U * 1.1, base); x.lineTo(stack - U * 0.55, base - U * 19); x.lineTo(stack + U * 0.55, base - U * 19); x.lineTo(stack + U * 1.1, base); x.fill();
        x.fillStyle = 'rgba(255,255,255,.03)'; for (const h0 of [0.25, 0.5, 0.75]) x.fillRect(stack - U * 1.1, base - U * 19 * h0, U * 2.2, U * 0.5);
        this.stackTop = [stack, base - U * 19]; }
      x.fillStyle = B; x.fillRect(0, base, w, h - base);
    });
    this.mid = this.layer(W + M * 2, H, (x, w, h) => {
      const base = hz + U * 5.5; x.fillStyle = '#121415'; x.strokeStyle = '#121415';
      // private sector: one-storey houses with hipped tin roofs and brick chimneys, solid gates and fences, the
      // yellow gas pipe arching over driveways, tall Lombardy poplars and bare fruit trees
      const gas = [];
      for (let X = -U * 3; X < w;) {
        const kind = r(); X += U * (0.8 + r() * 2.2);
        if (kind < 0.5) {
          const bw = U * (3.2 + r() * 2.4), bh = U * (1.9 + r() * 0.7), rf = U * (1.1 + r() * 0.7), inset = bw * 0.18;
          x.beginPath(); x.moveTo(X, base); x.lineTo(X, base - bh); x.lineTo(X - U * 0.25, base - bh);   // eave
          if (r() < 0.25) { x.lineTo(X + inset, base - bh - rf); x.lineTo(X + bw * 0.45, base - bh - rf); x.lineTo(X + bw * 0.55, base - bh - rf * 0.35); x.lineTo(X + bw * 0.68, base - bh - rf * 0.8); x.lineTo(X + bw - inset, base - bh - rf); }   // shell-holed roof
          else { x.lineTo(X + inset, base - bh - rf); x.lineTo(X + bw - inset, base - bh - rf); }
          x.lineTo(X + bw + U * 0.25, base - bh); x.lineTo(X + bw, base - bh); x.lineTo(X + bw, base); x.closePath(); x.fill();
          x.fillRect(X + bw * (0.25 + r() * 0.4), base - bh - rf - U * 0.7, U * 0.45, U * 1.1);   // chimney
          x.fillStyle = 'rgba(255,255,255,.035)'; x.fillRect(X + bw * 0.2, base - bh * 0.7, U * 0.6, U * 0.7); x.fillRect(X + bw * 0.62, base - bh * 0.7, U * 0.6, U * 0.7); x.fillStyle = '#121415';
          const fx = X + bw; X += bw;
          // fence + gate to the next plot, the gas pipe arching over the drive
          const fw = U * (2 + r() * 2); x.fillRect(fx, base - U * 1.2, fw, U * 1.2); if (r() < 0.6) gas.push([fx + fw * 0.3, fx + fw * 0.85]); X += fw;
        } else if (kind < 0.72 && Math.abs(X - w * 0.585) > U * 9) {   // Lombardy poplar: tall, narrow (not in front of the church)
          const th = U * (8 + r() * 5), tw = U * (0.9 + r() * 0.6); x.beginPath(); x.moveTo(X, base); x.bezierCurveTo(X - tw, base - th * 0.3, X - tw * 0.6, base - th * 0.8, X, base - th); x.bezierCurveTo(X + tw * 0.6, base - th * 0.8, X + tw, base - th * 0.3, X, base); x.fill(); X += U * 1.2;
        } else if (kind < 0.9) { const th = U * (3.5 + r() * 4); this.tree(x, X, base, th, U, r); X += U * (1 + r() * 2); }
        else X += U * 2;
      }
      // gas pipe: a run along the fences at ~2 m, arching up over each driveway (very typical of the region)
      x.lineWidth = Math.max(0.8, U * 0.12); x.strokeStyle = '#121415';
      for (const [a0, a1] of gas) { const y = base - U * 1.5, hy = base - U * 3.6; x.beginPath(); x.moveTo(a0 - U * 1.5, y); x.lineTo(a0, y); x.lineTo(a0, hy); x.lineTo(a1, hy); x.lineTo(a1, y); x.lineTo(a1 + U * 1.5, y); x.stroke(); }
      // poles + wires
      x.lineWidth = Math.max(1, U * 0.18); const poles = []; for (let X = w * 0.04; X < w; X += U * (11 + r() * 4)) poles.push(X);
      for (const p of poles) { x.beginPath(); x.moveTo(p, base); x.lineTo(p + U * 0.2, base - U * 9); x.stroke(); x.beginPath(); x.moveTo(p - U * 1.2, base - U * 8.4); x.lineTo(p + U * 1.6, base - U * 8.6); x.stroke(); }
      x.lineWidth = Math.max(0.7, U * 0.07);
      for (let i = 0; i < poles.length - 1; i++) for (const o of [-1, 1.4]) { if (r() < 0.12) continue; const a = poles[i] + o * U, b = poles[i + 1] + o * U, y = base - U * 8.5; x.beginPath(); x.moveTo(a, y); x.quadraticCurveTo((a + b) / 2, y + U * 1.6, b, y); x.stroke(); }
      // ground plane with a soft haze line
      x.fillRect(0, base, w, h - base);
      // the road the convoys use: a slightly paler band along the foot of the private sector
      x.fillStyle = 'rgba(120,108,92,.10)'; x.fillRect(0, base + U * 0.25, w, U * 0.75); x.fillStyle = '#121415';
      this.roadY = base + U * 0.85;
    });
    this.fg = this.layer(W + M * 2, H, (x, w, h) => {
      const n1 = noise1(77), base = hz + U * 12, sm = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
      // the same function draws the ridge outline and places everything on it, so nothing floats
      const ground = X => base - n1(X / (U * 9)) * U * 5 - sm((X / w - 0.5) / 0.12) * U * 2.2 + n1(X / U * 0.9 + 40) * U * 0.7;
      x.fillStyle = '#08090a'; x.beginPath(); x.moveTo(0, h);
      for (let X = 0; X <= w; X += U * 0.5) x.lineTo(X, ground(X));
      x.lineTo(w, h); x.closePath(); x.fill();
      x.strokeStyle = '#08090a'; x.lineCap = 'round';
      const footY = (px, half) => Math.max(ground(px - half), ground(px), ground(px + half));   // lowest point under the object
      // burnt-out armoured hull on the ridge (generic silhouette)
      const hx = w * 0.69, hy = footY(hx, U * 5.5) + U * 0.5;
      x.beginPath(); x.moveTo(hx - U * 6, hy); x.lineTo(hx - U * 5.4, hy - U * 1.9); x.lineTo(hx + U * 5.2, hy - U * 1.9); x.lineTo(hx + U * 6.2, hy - U * 0.6); x.lineTo(hx + U * 5.8, hy); x.closePath(); x.fill();
      x.beginPath(); x.moveTo(hx - U * 2.6, hy - U * 1.9); x.lineTo(hx - U * 2, hy - U * 3.1); x.lineTo(hx + U * 1.6, hy - U * 3.2); x.lineTo(hx + U * 2.4, hy - U * 1.9); x.closePath(); x.fill();
      x.lineWidth = U * 0.42; x.beginPath(); x.moveTo(hx + U * 1.6, hy - U * 2.6); x.lineTo(hx + U * 7.5, hy - U * 1.5); x.stroke();
      // anti-tank hedgehogs + a wire fence
      const hog = (px, sz) => { const y = footY(px, sz * 0.6) + sz * 0.12; x.lineWidth = sz * 0.16; x.beginPath(); x.moveTo(px - sz * 0.6, y); x.lineTo(px + sz * 0.45, y - sz); x.moveTo(px + sz * 0.6, y); x.lineTo(px - sz * 0.4, y - sz * 0.95); x.moveTo(px - sz * 0.15, y + sz * 0.05); x.lineTo(px + sz * 0.1, y - sz * 1.05); x.stroke(); };
      for (const [fx, sz] of [[0.5, 2.6], [0.555, 2.1], [0.6, 2.9], [0.86, 2.4], [0.93, 3.2]]) hog(w * fx, U * sz);
      x.lineWidth = Math.max(1, U * 0.16);
      for (let X = w * 0.36; X < w; X += U * 4.5) { const y = ground(X) + U * 0.3; x.beginPath(); x.moveTo(X, y + U * 0.4); x.lineTo(X + U * 0.3, y - U * 2.3); x.stroke(); }
      x.lineWidth = Math.max(0.6, U * 0.06); for (const k of [1.2, 2]) { x.beginPath(); for (let X = w * 0.36; X < w; X += U * 1.5) { const y = ground(X) - U * k + Math.sin(X * 0.3) * U * 0.15; X === w * 0.36 ? x.moveTo(X, y) : x.lineTo(X, y); } x.stroke(); }
    });
    // haze bands between layers
    const haze = (y0, y1, a) => { const c = mk(1, H), x = c.getContext('2d'), g = x.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, 'rgba(96,76,58,0)'); g.addColorStop(0.6, `rgba(96,76,58,${a})`); g.addColorStop(1, 'rgba(96,76,58,0)'); x.fillStyle = g; x.fillRect(0, 0, 1, H); return c; };
    this.haze1 = haze(hz - U * 6, hz + U * 3, 0.2); this.haze2 = haze(hz + U * 2, hz + U * 8, 0.16);
    // sprites
    const blob = (rad, col, a) => { const c = mk(rad * 2, rad * 2), x = c.getContext('2d'), g = x.createRadialGradient(rad, rad, 0, rad, rad, rad); g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(0.55, `rgba(${col},${a * 0.45})`); g.addColorStop(1, `rgba(${col},0)`); x.fillStyle = g; x.fillRect(0, 0, rad * 2, rad * 2); return c; };
    this.smokeS = blob(48, '52,49,46', 0.55); this.smokeL = blob(48, '150,92,52', 0.36); this.steamS = blob(48, '70,67,63', 0.32); this.glowS = blob(48, '255,140,60', 0.55); this.flashS = blob(64, '255,196,140', 0.5);
    // smoke sources: [x fraction of the far layer, base y, strength]
    // flame sprite: white-yellow core fading through orange to transparent, teardrop shaped
    { const fw = 32, fh = 96, c = mk(fw, fh), x = c.getContext('2d');
      const g = x.createRadialGradient(fw / 2, fh * 0.82, 0, fw / 2, fh * 0.82, fh * 0.8); g.addColorStop(0, 'rgba(255,240,200,1)'); g.addColorStop(0.18, 'rgba(255,190,90,.95)'); g.addColorStop(0.45, 'rgba(240,110,30,.55)'); g.addColorStop(1, 'rgba(160,40,10,0)');
      x.fillStyle = g; x.beginPath(); x.moveTo(fw / 2, 0); x.bezierCurveTo(fw * 0.62, fh * 0.35, fw, fh * 0.6, fw * 0.92, fh * 0.82); x.bezierCurveTo(fw * 0.85, fh, fw * 0.15, fh, fw * 0.08, fh * 0.82); x.bezierCurveTo(0, fh * 0.6, fw * 0.38, fh * 0.35, fw / 2, 0); x.fill(); this.flameS = c; }
    // smoke rises from the biggest burning flats, a couple of ground fires and the heating-plant chimney
    const FW = W + M * 2, big = (this.fires || []).slice().sort((a, b) => b.s - a.s).slice(0, 3);
    this.sources = [...big.map(f => [f.x / FW, f.y - U * 0.4, 0.75 + f.s / U * 0.4]), [0.62, hz + U * 1.2, 1.3], [0.47, hz + U * 1, 0.7]];
    if (this.stackTop) this.sources.push([this.stackTop[0] / FW, this.stackTop[1], 0.6, 'stack']);
    this.smoke = []; this.embers = []; this.ash = []; this.flashes = []; this.nextFlash = 1.5;
    // 2-D armour silhouettes for the passing convoys (generic shapes: BTR-80 type APC, T-72 type tank, BMP-2 type IFV)
    this.vehSprites = {}; const VK = U * 1.45, C = '#0b0c0d';
    const veh = (len, paint) => {
      const c = mk(len * VK + 4, 2.6 * VK + 4), x = c.getContext('2d'); x.translate(2, 2.6 * VK + 2); x.scale(VK, VK);
      // firelight rim along the top edges: paint once offset up in amber, then the dark body over it
      x.save(); x.translate(0.02, -0.07); x.fillStyle = x.strokeStyle = 'rgba(190,120,64,.4)'; paint(x); x.restore();
      x.fillStyle = C; x.strokeStyle = C; paint(x); return c; };
    const poly = (x, pts) => { x.beginPath(); x.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) x.lineTo(pts[i], pts[i + 1]); x.closePath(); x.fill(); };
    const wheel = (x, cx, r0) => { x.beginPath(); x.arc(cx, -r0, r0, 0, 7); x.fill(); };
    this.vehSprites.btr = veh(4.0, x => { for (const wx of [0.55, 1.2, 2.3, 2.95]) wheel(x, wx, 0.36); poly(x, [0.05, -0.45, 0, -1.05, 0.35, -1.4, 2.7, -1.42, 3.75, -0.95, 3.55, -0.5]); x.fillRect(1.45, -1.78, 0.75, 0.38); x.lineWidth = 0.09; x.beginPath(); x.moveTo(2.1, -1.62); x.lineTo(3.25, -1.66); x.stroke(); });
    this.vehSprites.tank = veh(5.6, x => { poly(x, [0.1, -0.12, 0, -0.55, 0.25, -0.72, 3.25, -0.72, 3.55, -0.5, 3.4, -0.12]); poly(x, [0, -0.66, 0.05, -0.95, 3.2, -0.95, 3.6, -0.72]); x.beginPath(); x.ellipse(1.55, -0.95, 0.85, 0.42, 0, Math.PI, 0); x.fill(); x.fillRect(1.25, -1.47, 0.35, 0.12); x.lineWidth = 0.11; x.beginPath(); x.moveTo(2.2, -1.12); x.lineTo(5.4, -1.2); x.stroke(); });
    this.vehSprites.bmp = veh(4.4, x => { poly(x, [0.1, -0.12, 0, -0.5, 0.2, -0.62, 3.0, -0.62, 3.3, -0.4, 3.15, -0.12]); poly(x, [0, -0.58, 0.02, -1.0, 2.2, -1.06, 3.4, -0.72, 3.4, -0.58]); x.beginPath(); x.ellipse(1.35, -1.04, 0.55, 0.3, 0, Math.PI, 0); x.fill(); x.lineWidth = 0.07; x.beginPath(); x.moveTo(1.7, -1.18); x.lineTo(3.05, -1.36); x.stroke(); });
    this.convoy = []; this.dust = []; this.nextConvoy = 3 + Math.random() * 3;
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
    for (const [fx, by, k, kind] of this.sources) {
      if (kind === 'stack') { if (this.smoke.length < 190 && Math.random() < dt * 2.5) this.smoke.push({ x: fx * (W + M * 2), y: by, vx: 0.7 * U, vy: -1.0 * U, r: U * 0.5, g: U * 0.75, life: 0, max: 9 + Math.random() * 4, steam: true }); continue; }
      if (this.smoke.length < 170 && Math.random() < dt * 5 * k) this.smoke.push({ x: fx * (W + M * 2) + (Math.random() - 0.5) * U, y: by, vx: (0.4 + Math.random() * 0.5) * U, vy: -(1.6 + Math.random() * 1.2) * U * (0.8 + k * 0.2), r: U * (0.9 + Math.random() * 0.6) * k, g: U * (1.1 + Math.random() * 0.5) * (0.7 + k * 0.3), life: 0, max: 8 + Math.random() * 5, lit: Math.random() < 0.5 });
    }
    // embers: thrown up by every fire in bursts, carried by the wind with turbulence, cooling yellow → orange → dull red
    for (const f of this.fires || []) if (this.embers.length < 140 && Math.random() < dt * (1.2 + f.s / U * 2.5) * (Math.random() < 0.08 ? 6 : 1))
      this.embers.push({ x: f.x + (Math.random() - 0.5) * f.s, y: f.y - f.s * 0.5, vx: (Math.random() - 0.2) * U * 0.8, vy: -(1.2 + Math.random() * 2.4) * U, life: 0, max: 1.6 + Math.random() * 2.8, sz: 0.5 + Math.random() * Math.random() * 1.6, ph: Math.random() * 9 });
    for (const p of this.smoke) { p.life += dt; p.x += (p.vx + p.life * 0.18 * U) * dt; p.y += p.vy * dt; p.vy *= 1 - 0.06 * dt; p.r += p.g * dt; }
    this.smoke = this.smoke.filter(p => p.life < p.max);
    for (const p of this.embers) { p.life += dt; p.vx += (0.5 + Math.sin(this.t * 2.3 + p.ph) * 1.4) * U * dt; p.vy += (0.35 + Math.cos(this.t * 3.1 + p.ph * 1.7) * 0.5) * U * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    this.embers = this.embers.filter(p => p.life < p.max);
    for (const a of this.ash) { a.y += a.v * U * 0.6 * dt; a.x += (0.5 + Math.sin(this.t * 0.7 + a.p)) * U * 0.25 * dt; if (a.y > this.H) { a.y = -4; a.x = Math.random() * W; } if (a.x > W) a.x -= W; }
    // convoys: every 30-70 s two to four vehicles drive along the road, kicking up dust
    if (this.vehSprites) {
      this.nextConvoy -= dt;
      if (this.nextConvoy <= 0 && !this.convoy.length) {
        this.nextConvoy = 30 + Math.random() * 40;
        const mixes = [['btr', 'btr', 'tank'], ['bmp', 'btr'], ['tank', 'bmp', 'btr', 'btr'], ['btr', 'btr'], ['tank', 'tank', 'bmp']], mix = mixes[Math.floor(Math.random() * mixes.length)];
        const dir = Math.random() < 0.5 ? 1 : -1, FW = W + M * 2, sp = U * (4.2 + Math.random() * 1.6);
        mix.forEach((k, i) => this.convoy.push({ k, dir, sp, x: dir > 0 ? -U * 6 - i * U * 7.5 : FW + U * 2 + i * U * 7.5, ph: Math.random() * 6 }));
      }
      for (const v of this.convoy) {
        v.x += v.dir * v.sp * dt;
        const len = this.vehSprites[v.k].width, rear = v.dir > 0 ? v.x : v.x + len;
        if (this.dust.length < 90 && Math.random() < dt * 9) this.dust.push({ x: rear - v.dir * U * 0.3, y: this.roadY - U * 0.25, vx: -v.dir * U * (0.3 + Math.random() * 0.5) + U * 0.3, vy: -U * (0.15 + Math.random() * 0.35), r: U * (0.3 + Math.random() * 0.3), g: U * (0.5 + Math.random() * 0.4), life: 0, max: 2.5 + Math.random() * 2 });
        if (Math.random() < dt * 3) this.dust.push({ x: rear, y: this.roadY - U * 1.1, vx: -v.dir * U * 0.4 + U * 0.25, vy: -U * 0.5, r: U * 0.15, g: U * 0.35, life: 0, max: 1.8, exh: true });
      }
      const FW = W + M * 2; this.convoy = this.convoy.filter(v => v.dir > 0 ? v.x < FW + U * 40 : v.x > -U * 40);
      for (const d of this.dust) { d.life += dt; d.x += d.vx * dt; d.y += d.vy * dt; d.r += d.g * dt; }
      this.dust = this.dust.filter(d => d.life < d.max);
    }
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
    // flames in the burning flats: a flickering glow on the facade plus a few licking tongues
    x.globalCompositeOperation = 'lighter';
    for (const [i, f] of (this.fires || []).entries()) {
      const fl = 0.7 + 0.2 * Math.sin(this.t * 11 + i * 3) + 0.1 * Math.sin(this.t * 23 + i), R = f.s * 3.2 * fl;
      x.globalAlpha = 0.55 * fl; x.drawImage(this.glowS, f.x + ox - R, f.y + oy - R * 0.9, R * 2, R * 1.6);
      for (let k = 0; k < 4; k++) { const ph = this.t * (7 + k * 2.3) + i * 5 + k * 1.9, fh = f.s * (1.2 + 0.55 * Math.sin(ph) + 0.25 * Math.sin(ph * 2.7)), fw = f.s * (0.42 + 0.12 * Math.sin(ph * 1.3));
        x.globalAlpha = 0.75; x.drawImage(this.flameS, f.x + ox + (k - 1.5) * f.s * 0.22 + Math.sin(ph * 0.7) * f.s * 0.08 - fw / 2, f.y + oy - fh, fw, fh); }
    }
    x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1;
    x.drawImage(this.haze1, 0, 0, W, H);
    // smoke columns between the far and mid layers; fire glow at their base
    x.globalCompositeOperation = 'lighter';
    for (const [fx, by, k, kind] of this.sources) { if (kind === 'stack') continue; const fl2 = 0.55 + 0.25 * Math.sin(this.t * 7 * k + fx * 40) + 0.15 * Math.sin(this.t * 13 + k); x.globalAlpha = Math.max(0, fl2) * Math.min(1, k); const R = U * 3.2 * k; x.drawImage(this.glowS, fx * (W + M * 2) + ox - R, by + oy - R * 0.7, R * 2, R * 1.4); }
    x.globalCompositeOperation = 'source-over';
    [ox, oy] = off(0.3);
    for (const p of this.smoke) {
      const a = Math.min(1, p.life / 1.2) * (1 - p.life / p.max);
      x.globalAlpha = a; const R = p.r; x.drawImage(p.steam ? this.steamS : p.lit && p.life < 2 ? this.smokeL : this.smokeS, p.x + ox - R, p.y + oy - R, R * 2, R * 2);
    }
    x.globalAlpha = 1;
    [ox, oy] = off(0.5); x.drawImage(this.mid, ox, oy); this._mo = [ox, oy];   // (menuScene.js: the 3-D convoy rides this layer's parallax)
    if (this.convoy?.length || this.dust?.length) {
      for (const d of this.dust) { const a = Math.min(1, d.life / 0.4) * (1 - d.life / d.max); x.globalAlpha = a * (d.exh ? 0.5 : 0.65); const R = d.r; x.drawImage(d.exh ? this.smokeS : this.steamS, d.x + ox - R, d.y + oy - R, R * 2, R * 2); }
      x.globalAlpha = 1;
      for (const v of this.convoy) {
        if (this.scene3d?.has(v.k)) continue;   // drawn as the 3-D model by the menu's 3-D layer
        const img = this.vehSprites[v.k], bob = Math.sin(this.t * 9 + v.ph) * U * 0.03, y = this.roadY - img.height + 2 + bob + oy;
        if (v.dir > 0) x.drawImage(img, v.x + ox, y);
        else { x.save(); x.translate(v.x + ox + img.width, y); x.scale(-1, 1); x.drawImage(img, 0, 0); x.restore(); }
      }
    }
    x.drawImage(this.haze2, 0, 0, W, H);
    // embers
    x.globalCompositeOperation = 'lighter'; [ox, oy] = off(0.25); x.lineCap = 'round';
    for (const p of this.embers) {
      const u = p.life / p.max, a = (1 - u) * (0.65 + 0.35 * Math.sin(p.life * 17 + p.ph));
      x.strokeStyle = u < 0.25 ? '#ffe39a' : u < 0.6 ? '#ff9a3c' : '#c8461c'; x.globalAlpha = Math.max(0, a); x.lineWidth = Math.max(0.8, U * 0.12 * p.sz * (1 - u * 0.5));
      x.beginPath(); x.moveTo(p.x + ox - p.vx * 0.05, p.y + oy - p.vy * 0.05); x.lineTo(p.x + ox, p.y + oy); x.stroke();
    }
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
        this.scene3d?.render();
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
}
