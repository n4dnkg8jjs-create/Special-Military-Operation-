"""Church atlas (1024^2, 256 px cells) -- second material 'church_atlas' used only by church_small in city.glb.
White lime plaster (clean / shrapnel-pocked / soot plume), exposed 19th-c. red brick, pale-blue recessed panels,
green standing-seam roof sheet, gilding (intact / stripped), blue-with-gold-stars dome sheet, arched windows
(intact / broken), carved double door, portal icon + bell bronze, bare rusty steel (dome ribs), interior plaster with
faded frescoes, floor boards / charred timber. Albedo JPEG, normal PNG, ORM PNG in _cache/church_atlas_*.
Tileable cells (wall, pock, brick, trim, tin, gold, gold_strip, blue, steel, inner, wood) use periodic noise.
"""
import os
import numpy as np
from PIL import Image, ImageDraw
from texlib import (spectral, norm01, colorize, srgb, lerp, to8, normal_from_height, smoothstep, blur, CACHE,
                    quantize_normal, rng, cavity_ao, stamp_disc)

S = 1024
C = 256
GRID = [
    ['cp_wall', 'cp_pock', 'cp_brick', 'cp_trim'],
    ['cp_tin', 'cp_gold', 'cp_gold_strip', 'cp_blue'],
    ['cp_win', 'cp_win_broken', 'cp_door', 'cp_icon'],
    ['cp_soot', 'cp_steel', 'cp_inner', 'cp_wood'],
]
REG = {}
for j, row in enumerate(GRID):
    for i, n in enumerate(row):
        REG[n] = (i * C, j * C, (i + 1) * C, j * C + C)

WALL = '#e8e5dc'     # warm lime-white
# window / door art aspect: geometry maps the arched opening's bbox onto the whole cell
WIN_ARCH = 0.55 / 2.5    # arch radius / total height of the window art (w 1.1 x h 2.5)
DOOR_ARCH = 0.85 / 3.0
ICON_ARCH = 0.5 / 1.3


def _pil(a):
    return Image.fromarray(to8(a))


def _arr(img):
    return np.asarray(img.convert('RGB')).astype(np.float32) / 255


def plaster(shape, seed, col=WALL, grime=0.25):
    n = spectral(0, 1.3, seed, fmin=2, fmax=60, shape=shape); f = spectral(0, 0.6, seed + 1, fmin=20, shape=shape)
    alb = srgb(col) * (0.95 + 0.05 * norm01(n))[..., None] + np.zeros(shape + (3,))
    alb = lerp(alb, srgb('#b9b3a3'), smoothstep(0.6, 1.8, n) * grime)
    alb = lerp(alb, srgb('#cfc9ba'), smoothstep(0.8, 1.6, f) * 0.25)
    hgt = f * 0.25 + n * 0.15
    return alb, hgt, n, f


def arch_mask(w, h, x0, y0, x1, y1, ry_frac, img_draw, fill):
    """Draw an arched (semicircular-topped) shape inside the pixel box; ry_frac = arch height / box height."""
    ry = (y1 - y0) * ry_frac
    img_draw.rectangle([x0, y0 + ry, x1, y1], fill=fill)
    img_draw.ellipse([x0, y0, x1, y0 + 2 * ry], fill=fill)


def window_art(shape, seed, broken=False):
    h, w = shape; r = rng(seed)
    img = Image.new('RGB', (w, h), (232, 229, 220)); d = ImageDraw.Draw(img)
    # outer frame (white painted timber), glass, muntins
    arch_mask(w, h, 0, 0, w - 1, h - 1, WIN_ARCH, d, (214, 211, 202))
    m = 14
    glass = (22, 28, 34)
    arch_mask(w, h, m, m * 0.6, w - 1 - m, h - 1 - m * 0.5, WIN_ARCH * 0.93, d, glass)
    if not broken:
        # sky reflection gradient on the glass
        a = _arr(img)
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        refl = np.clip(1 - np.abs((xx - w * 0.3) - (yy - h * 0.2) * 0.4) / (w * 0.25), 0, 1) * 0.10
        isg = (a.sum(-1) < 0.4)
        a[isg] += refl[isg][:, None] * np.array([0.6, 0.7, 0.8])
        img = _pil(a); d = ImageDraw.Draw(img)
    mc = (226, 223, 214)
    d.line([(w / 2, m), (w / 2, h - m)], fill=mc, width=6)
    ry = h * WIN_ARCH
    for yk in (ry, ry + (h - ry) * 0.36, ry + (h - ry) * 0.68):
        d.line([(m, yk), (w - m, yk)], fill=mc, width=5)
    for a_ in (np.pi * 0.25, np.pi * 0.75):     # radial muntins in the arch
        d.line([(w / 2, ry), (w / 2 + np.cos(a_) * w / 2, ry - np.sin(a_) * ry)], fill=mc, width=4)
    if broken:
        # most panes gone: black holes with jagged shard edges; a few cracked panes stay
        a = _arr(img)
        holes = np.zeros(shape, np.float32)
        for k in range(9):
            cx, cy = r.uniform(m, w - m), r.uniform(ry * 0.5, h - m)
            pts = []
            for t in np.linspace(0, 2 * np.pi, 13)[:-1]:
                rr = r.uniform(18, 60)
                pts.append((cx + np.cos(t) * rr, cy + np.sin(t) * rr * 1.4))
            im = Image.new('L', (w, h), 0); ImageDraw.Draw(im).polygon(pts, fill=255)
            holes = np.maximum(holes, np.asarray(im, np.float32) / 255)
        isg = (a.sum(-1) < 0.4)
        a = np.where((holes > 0.5)[..., None] & isg[..., None], np.array([0.02, 0.02, 0.025]), a)
        # cracks on the remaining glass
        img = _pil(a); d = ImageDraw.Draw(img)
        for k in range(14):
            x, y = r.uniform(m, w - m), r.uniform(ry, h - m)
            for s in range(4):
                t = r.uniform(0, 2 * np.pi); L = r.uniform(10, 40)
                d.line([(x, y), (x + np.cos(t) * L, y + np.sin(t) * L)], fill=(120, 128, 132), width=1)
        # one muntin snapped
        d.line([(w / 2, h * 0.62), (w / 2 + 20, h * 0.75)], fill=(5, 5, 6), width=8)
        # soot on the frame
        a = _arr(img); yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        soot = np.clip(1 - yy / (h * 0.6), 0, 1) * 0.55
        a = lerp(a, srgb('#1a1715'), soot)
        return a
    return _arr(img)


def door_art(shape, seed):
    h, w = shape; r = rng(seed)
    n = spectral(0, 1.3, seed, fmin=3, fmax=60, shape=shape)
    base = colorize(norm01(n), [(0, '#233a2c'), (1, '#2f4d3a')])      # dark green painted oak
    img = Image.new('RGB', (w, h), (230, 227, 218)); d = ImageDraw.Draw(img)
    arch_mask(w, h, 0, 0, w - 1, h - 1, DOOR_ARCH, d, (40, 64, 48))
    a = _arr(img); isd = a[..., 1] < 0.5
    a[isd] = base[isd]
    img = _pil(a); d = ImageDraw.Draw(img)
    gold = (178, 142, 64); dark = (18, 26, 20)
    ry = h * DOOR_ARCH
    d.line([(w / 2, ry * 0.15), (w / 2, h)], fill=dark, width=5)
    for side in (0, 1):
        x0 = w * (0.08 if side == 0 else 0.56); x1 = w * (0.44 if side == 0 else 0.92)
        for k, (ya, yb) in enumerate(((0.36, 0.56), (0.60, 0.76), (0.80, 0.95))):
            d.rectangle([x0, h * ya, x1, h * yb], outline=gold, width=3)
            d.rectangle([x0 + 8, h * ya + 8, x1 - 8, h * yb - 8], outline=dark, width=2)
        # carved cross panel in the upper leaf
        cx = (x0 + x1) / 2
        d.line([(cx, h * 0.17), (cx, h * 0.33)], fill=gold, width=4)
        d.line([(cx - 14, h * 0.22), (cx + 14, h * 0.22)], fill=gold, width=4)
        d.line([(cx - 9, h * 0.29), (cx + 9, h * 0.27)], fill=gold, width=3)
        # studs
        for y in np.linspace(h * 0.37, h * 0.95, 6):
            d.ellipse([x0 - 3, y - 3, x0 + 3, y + 3], fill=(120, 110, 90))
    d.ellipse([w * 0.43, h * 0.62, w * 0.47, h * 0.66], fill=gold); d.ellipse([w * 0.53, h * 0.62, w * 0.57, h * 0.66], fill=gold)
    a = _arr(img)
    # scuffs, shrapnel splinter holes
    pit = np.zeros(shape, np.float32)
    for k in range(18):
        stamp_disc(pit, r.uniform(0, w), r.uniform(h * 0.3, h), r.uniform(1.5, 3.5), 1, 1.0)
    a = lerp(a, srgb('#c9b48a'), blur(pit, 2, False) * 0.6); a = lerp(a, srgb('#0d0b09'), pit)
    return a, -pit


def paint(name, rect, seed):
    x0, y0, x1, y1 = rect; shape = (y1 - y0, x1 - x0); h, w = shape; r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.3, seed, fmin=2, fmax=60, shape=shape); f = spectral(0, 0.6, seed + 1, fmin=20, shape=shape)
    rough = np.full(shape, 0.88, np.float32); metal = np.zeros(shape, np.float32); hgt = f * 0.2
    if name == 'cp_wall':
        alb, hgt, _, _ = plaster(shape, seed)
        # a few hairline cracks
        img = _pil(alb); d = ImageDraw.Draw(img)
        for k in range(3):
            x, y = r.uniform(0, w), r.uniform(0, h)
            for s in range(6):
                nx, ny = x + r.uniform(-14, 14), y + r.uniform(6, 22)
                d.line([(x, y), (nx, ny)], fill=(168, 162, 150), width=1); x, y = nx, ny
        alb = _arr(img)
    elif name == 'cp_pock':
        alb, hgt, _, _ = plaster(shape, seed, grime=0.4)
        pit = np.zeros(shape, np.float32); halo = np.zeros(shape, np.float32); brk = np.zeros(shape, np.float32)
        for k in range(60):
            cx, cy = r.uniform(0, w), r.uniform(0, h)
            rr = r.uniform(0.8, 2.2) if k < 50 else r.uniform(2.5, 4.0)
            for ox in (-w, 0, w):
                for oy in (-h, 0, h):
                    # chipped, irregular halo (render spalled to the grey base coat)
                    for j in range(3):
                        stamp_disc(halo, cx + ox + r.uniform(-2, 2) * rr, cy + oy + r.uniform(-2, 2) * rr, rr * r.uniform(1.2, 2.2), 1, 1.5)
                    stamp_disc(pit, cx + ox, cy + oy, rr, 1, 1.0)
                    if k >= 50:
                        stamp_disc(brk, cx + ox, cy + oy, rr * 1.5, 1, 1.0)
        alb = lerp(alb, srgb('#b3ad9f'), halo * 0.6)
        alb = lerp(alb, srgb('#7d4a36'), brk * 0.65)            # bigger hits go through to the brick
        alb = lerp(alb, srgb('#2c2824'), pit * 0.85)
        # streaky grime from the blast side
        alb = lerp(alb, srgb('#8e8778'), smoothstep(0.4, 1.8, spectral(0, 1.6, seed + 9, fmin=1, fmax=12, shape=shape)) * 0.35)
        hgt = hgt - pit * 3 - halo * 0.8
    elif name == 'cp_brick':
        rows = 16; ch = h / rows; bw = w / 4
        row = (yy // ch).astype(int); off = (row % 2) * bw / 2
        fx = (xx + off) % bw; fy = yy % ch
        m = ((fx > 2.5) & (fy > 2.5)).astype(np.float32)
        bid = (((xx + off) // bw).astype(int) * 31 + row * 17) % 97
        tone = (bid * 0.618) % 1.0
        alb = lerp(srgb('#a8a090') + np.zeros(shape + (3,)), colorize(tone, [(0, '#6a2e20'), (0.5, '#8c3f2a'), (1, '#a3553a')]), m)
        alb = lerp(alb, srgb('#3a2e26'), smoothstep(0.5, 1.8, n) * 0.35)
        # lime plaster remnants clinging to the brick
        rem = smoothstep(1.0, 1.4, spectral(0, 2.0, seed + 5, fmin=2, fmax=30, shape=shape))
        alb = lerp(alb, srgb('#cfcabd'), rem * 0.8)
        hgt = m * 1.6 + rem * 1.2 + f * 0.3; rough[:] = 0.92
    elif name == 'cp_trim':
        alb, hgt, _, _ = plaster(shape, seed, col='#9db6cc', grime=0.18)    # pale blue recessed panels
    elif name == 'cp_tin':
        # green standing-seam roof: 4 seams per cell (0.5 m at a 2 m tile), seams along t (down the slope)
        seam_x = (xx % (w / 4))
        seam = np.exp(-((seam_x - 3) ** 2) / 4.0)
        alb = colorize(norm01(n * 0.5 + f * 0.5), [(0, '#2f5a3c'), (0.6, '#3d6e4a'), (1, '#4b7d56')])
        streak = smoothstep(0.7, 1.6, spectral(0, 2.0, seed + 3, fmin=2, fmax=40, shape=(h, w)) * 0.6 + norm01(blur(r.random((h, w)).astype(np.float32), (14, 0.5))) * 1.2)
        alb = lerp(alb, srgb('#6d5a3e'), streak * 0.35)        # rust runs
        alb = lerp(alb, srgb('#9fb8a2'), seam[..., None] * 0.35)
        alb = lerp(alb, srgb('#1d3324'), np.exp(-((seam_x - 7) ** 2) / 6.0)[..., None] * 0.4)
        hgt = seam * 4 + f * 0.2; rough[:] = 0.55; metal[:] = 0.45
    elif name == 'cp_gold':
        alb = colorize(norm01(n * 0.5 + f * 0.5), [(0, '#9c7426'), (0.55, '#cfa443'), (1, '#efd27a')])
        gore = np.exp(-(((xx % (w / 8)) - 1.5) ** 2) / 3.0)
        alb = lerp(alb, srgb('#6b4f19'), gore[..., None] * 0.55)
        hgt = -gore * 1.5; rough[:] = 0.22; metal[:] = 1.0
    elif name == 'cp_gold_strip':
        g = colorize(norm01(n * 0.5 + f * 0.5), [(0, '#9c7426'), (0.55, '#cfa443'), (1, '#e5c56c')])
        steel = colorize(norm01(f), [(0, '#5a5852'), (0.6, '#77746c'), (1, '#7a6250')])
        keep = smoothstep(-0.55, -0.05, spectral(0, 1.8, seed + 7, fmin=2, fmax=24, shape=shape))
        alb = lerp(steel, g, keep)
        rust = smoothstep(0.6, 1.6, spectral(0, 1.4, seed + 8, fmin=4, fmax=60, shape=shape)) * (1 - keep)
        alb = lerp(alb, srgb('#6a3a20'), rust * 0.7)
        dent = np.zeros(shape, np.float32)
        for k in range(12):
            cx, cy, rr = r.uniform(0, w), r.uniform(0, h), r.uniform(6, 16)
            for ox in (-w, 0, w):
                stamp_disc(dent, cx + ox, cy, rr, 1, rr * 0.8)
        hole = np.zeros(shape, np.float32)
        for k in range(16):
            stamp_disc(hole, r.uniform(0, w), r.uniform(0, h), r.uniform(1.5, 3.5), 1, 1.0)
        alb = lerp(alb, srgb('#2a2622'), dent * 0.25); alb = lerp(alb, srgb('#0c0b0a'), hole)
        gore = np.exp(-(((xx % (w / 8)) - 1.5) ** 2) / 3.0)
        alb = lerp(alb, srgb('#3a2e1c'), gore[..., None] * 0.5)
        hgt = -dent * 3 - hole * 2 - gore; rough = 0.25 + 0.6 * (1 - keep); metal = 0.35 + 0.65 * keep
    elif name == 'cp_blue':
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#1f4778'), (0.6, '#2a5a92'), (1, '#3567a0')])
        chip = smoothstep(1.3, 1.9, spectral(0, 1.4, seed + 3, fmin=3, fmax=60, shape=shape))
        alb = lerp(alb, srgb('#5a5040'), chip * 0.7)
        img = _pil(alb); d = ImageDraw.Draw(img)
        for k in range(10):
            cx, cy, s_ = r.uniform(10, w - 10), r.uniform(10, h - 10), r.uniform(7, 11)
            pts = [(cx + np.cos(a) * (s_ if i % 2 == 0 else s_ * 0.42), cy + np.sin(a) * (s_ if i % 2 == 0 else s_ * 0.42) * 1.0)
                   for i, a in enumerate(np.linspace(-np.pi / 2, 1.5 * np.pi, 11)[:-1])]
            d.polygon(pts, fill=(222, 182, 78))
        alb = _arr(img); star = (alb[..., 0] > alb[..., 2] + 0.2).astype(np.float32)
        gore = np.exp(-(((xx % (w / 8)) - 1.5) ** 2) / 3.0)
        alb = lerp(alb, srgb('#16304f'), gore[..., None] * 0.5)
        hgt = -gore + star * 0.5; rough = 0.45 - 0.2 * star; metal = 0.3 + 0.6 * star
    elif name == 'cp_win':
        alb = window_art(shape, seed); glass = (alb.sum(-1) < 0.45).astype(np.float32)
        rough = 0.85 - glass * 0.8; metal[:] = 0.0; hgt = (1 - glass) * 1.5
    elif name == 'cp_win_broken':
        alb = window_art(shape, seed, broken=True); dark = (alb.sum(-1) < 0.2).astype(np.float32)
        rough = 0.9 - (alb.sum(-1) < 0.45) * (1 - dark) * 0.8; hgt = (1 - (alb.sum(-1) < 0.45)) * 1.5
    elif name == 'cp_door':
        alb, hh = door_art(shape, seed); rough[:] = 0.7; hgt = hh * 2 + f * 0.2
    elif name == 'cp_icon':
        # upper 2/3: arched mosaic icon over the portal (stylised, no likeness); lower 1/4: bell bronze
        hi = int(h * 0.66); bi = int(h * 0.30)
        a = np.zeros(shape + (3,), np.float32)
        g = colorize(norm01(n[:hi]), [(0, '#a8842e'), (1, '#dbb65a')])
        img = Image.new('RGB', (w, hi), (232, 229, 220)); d = ImageDraw.Draw(img)
        arch_mask(w, hi, 0, 0, w - 1, hi - 1, ICON_ARCH, d, (200, 160, 70))
        ia = _arr(img); isg = ia[..., 2] < 0.5
        ia[isg] = g[isg]
        img = _pil(ia); d = ImageDraw.Draw(img)
        cx = w / 2
        d.ellipse([cx - 40, hi * 0.12, cx + 40, hi * 0.12 + 80], fill=(236, 206, 118), outline=(120, 80, 30), width=3)
        d.ellipse([cx - 22, hi * 0.12 + 18, cx + 22, hi * 0.12 + 62], fill=(168, 118, 86))
        d.polygon([(cx, hi * 0.40), (cx - 70, hi * 0.98), (cx + 70, hi * 0.98)], fill=(112, 30, 34))
        d.polygon([(cx, hi * 0.45), (cx - 38, hi * 0.98), (cx + 38, hi * 0.98)], fill=(36, 52, 96))
        d.rectangle([0, 0, w - 1, hi - 1], outline=(232, 229, 220), width=2)
        a[:hi] = _arr(img)
        a[hi:] = srgb(WALL)
        bz = colorize(norm01(n[h - bi:]), [(0, '#3d3420'), (0.5, '#5c4c2a'), (1, '#6f6a48')])
        pat = smoothstep(0.6, 1.5, f[h - bi:]); bz = lerp(bz, srgb('#4f7a64'), pat * 0.5)
        a[h - bi:] = bz
        alb = a
        metal[:hi] = 0.4 * (alb[:hi, :, 0] > alb[:hi, :, 2] + 0.25); metal[h - bi:] = 0.8; rough[:hi] = 0.5; rough[h - bi:] = 0.5
    elif name == 'cp_soot':
        # soot plume rising from a burnt-out window (bottom centre), fading to clean plaster at the cell edges
        alb, hgt, _, _ = plaster(shape, seed)
        u = (xx - w / 2) / (w / 2); v = (h - yy) / h               # v=0 bottom, 1 top
        width = 0.35 + 0.55 * v
        turb = spectral(0, 2.2, seed + 4, fmin=1, fmax=8, shape=shape) * 0.12
        plume = np.clip(1 - np.abs(u + turb) / width, 0, 1) ** 0.8 * np.clip(1 - v * 0.92, 0, 1) ** 1.1
        edge = np.clip(np.minimum.reduce([xx / 24, (w - 1 - xx) / 24, yy / 30]), 0, 1)
        sx = np.convolve(r.random(w + 16), np.ones(9) / 9, 'same')[8:w + 8]
        streaks = np.broadcast_to(norm01(sx.astype(np.float32))[None, :], shape)
        dens = np.clip(plume * (0.75 + 0.45 * streaks) * 1.25, 0, 1) * edge
        alb = lerp(alb, srgb('#141210'), dens * 0.92)
        rough[:] = 0.9
    elif name == 'cp_steel':
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#2a1d15'), (0.4, '#4a2e1e'), (0.8, '#6e4228'), (1, '#55524c')])
        hgt = f * 0.6 + n * 0.3; rough[:] = 0.85; metal[:] = 0.4
    elif name == 'cp_inner':
        # interior plaster: dark, smoke-stained, faded fresco colour fields
        alb = colorize(norm01(n), [(0, '#2e2a24'), (1, '#4a4338')])
        img = _pil(alb); d = ImageDraw.Draw(img)
        for k, col in enumerate([(92, 72, 44), (54, 60, 74), (82, 50, 42), (96, 84, 56)]):
            x = r.uniform(0, w * 0.7); y = r.uniform(0, h * 0.7)
            d.rectangle([x, y, x + r.uniform(40, 90), y + r.uniform(60, 120)], fill=col)
            d.ellipse([x + 10, y + 6, x + 40, y + 36], fill=(112, 96, 58))
        alb = _arr(img); alb = lerp(alb, srgb('#221e1a'), smoothstep(-0.5, 1.2, f) * 0.6)
        alb = lerp(alb, srgb('#151311'), np.clip(1 - yy / (h * 0.7), 0, 1) * 0.35)
        rough[:] = 0.95
    elif name == 'cp_wood':
        top = yy < h / 2
        boards = ((xx % (w / 6)) < 2).astype(np.float32)
        grain = norm01(blur(r.random(shape).astype(np.float32), (8, 0.5)))
        raw = colorize(grain * 0.6 + norm01(n) * 0.4, [(0, '#5a4430'), (1, '#8a6c4a')])
        raw = lerp(raw, srgb('#2a2017'), boards * 0.8)
        char = colorize(norm01(n * 0.5 + grain * 0.5), [(0, '#0f0d0c'), (0.7, '#1e1a17'), (1, '#3a2e22')])
        cr = (np.abs(((yy * 0.6 + xx * 0.05) % 9) - 4.5) < 0.6).astype(np.float32)
        char = lerp(char, srgb('#000000'), cr * 0.6)
        alb = np.where(top[..., None], raw, char); hgt = np.where(top, grain - boards * 2, cr * -1.5 + grain)
        rough[:] = 0.9
    else:
        alb = colorize(norm01(n), [(0, '#555555'), (1, '#777777')])
    return alb.astype(np.float32), np.asarray(hgt, np.float32), np.clip(rough, 0, 1).astype(np.float32), np.asarray(metal, np.float32)


def build():
    alb = np.zeros((S, S, 3), np.float32) + 0.5; hgt = np.zeros((S, S), np.float32)
    rough = np.full((S, S), 0.85, np.float32); metal = np.zeros((S, S), np.float32); ao = np.ones((S, S), np.float32)
    for i, (name, rc) in enumerate(REG.items()):
        a, hh, rr, mm = paint(name, rc, 9100 + i * 7)
        x0, y0, x1, y1 = rc
        alb[y0:y1, x0:x1] = a; hgt[y0:y1, x0:x1] = hh; rough[y0:y1, x0:x1] = rr; metal[y0:y1, x0:x1] = mm
        ao[y0:y1, x0:x1] = cavity_ao(hh, 3, 0.3, wrap=False)
    paths = [os.path.join(CACHE, f'church_atlas_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    Image.fromarray(to8(alb)).save(paths[0], quality=92, optimize=True)
    nrm = to8(blur(normal_from_height(hgt, 1.0, wrap=False).astype(np.float32) / 255.0, 0.5, wrap=False))
    Image.fromarray(quantize_normal(nrm, 6)).save(paths[1], optimize=True, compress_level=9)
    orm = to8(blur(np.stack([ao, rough, metal], -1), 0.5, wrap=False))
    Image.fromarray(quantize_normal(orm, 6)).save(paths[2], optimize=True, compress_level=9)
    return paths


if __name__ == '__main__':
    import time; t0 = time.time()
    print(build(), time.time() - t0)
