"""Farmland atlas (2048^2, 256 px grid) for farmland.glb, material 'farmland_atlas': kolkhoz silicate brick / slate /
corrugated steel, village boards, wattle stakes, hay, chernozem, trench mud, sandbags, MTZ-80 blue paint + red rims +
tractor tread, burnt vehicle metal, Rozhnovsky tower plates, silo steel, roadside mosaic, rushnyk, tree barks.
Regions shared with the city look are painted by city_atlas.paint() (same seeds -> same look).
Output: _cache/farmland_atlas_{albedo.jpg,normal.png,orm.png}.  Run standalone to repaint.
"""
import os
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont
from texlib import (spectral, norm01, colorize, srgb, lerp, to8, normal_from_height, smoothstep, blur, CACHE,
                    quantize_normal, voronoi, rng, cavity_ao, bake_shade, stamp_disc)
import texlib
import city_atlas as CA

S = 2048
C = 256
GRID = [
    ['brick_white', 'brick_white_soot', 'concrete', 'conc_panel', 'slate', 'slate_old', 'tin_galv', 'corr_rust'],
    ['wood_raw', 'wood_grey', 'wood_green', 'picket', 'logs_end', 'bark_acacia', 'charred', 'plaster_white'],
    ['hay_side', 'hay_end', 'hay_burnt', 'straw', 'soil', 'trench_floor', 'sandbag', 'sod'],
    ['mtz_blue', 'mtz_red', 'tyre_tread', 'metal_dark', 'burnt_metal', 'niva_red', 'grille', 'glass_dark'],
    ['window_barn', 'gate_barn', 'door_blue', 'gate_green', 'mosaic', 'conc_painted', 'rushnyk', 'cross_wood'],
    ['tank_rust', 'tank_holed', 'silo_steel', 'silo_conc', 'metal_rust_paint', 'felt_roof', 'steel_rust', 'paint_white'],
    ['ground', 'ash', 'soot', 'rubber', 'brick_red', 'cable', 'mtz_cab', 'mtz_face'],
    ['plaster_soot', 'burnt_paint', 'trailer_blue', 'interior_dark', 'straw_bedding', 'bark_oak', 'bark_poplar', 'bark_walnut'],
]
REG = {}
for j, row in enumerate(GRID):
    for i, n in enumerate(row):
        REG[n] = (i * C, j * C, (i + 1) * C, j * C + C)
SHARED = {'brick_white', 'concrete', 'slate', 'tin_galv', 'wood_raw', 'charred', 'glass_dark', 'metal_rust_paint',
          'paint_white', 'ground', 'soot', 'rubber', 'brick_red', 'cable', 'plaster_white', 'picket'}
FONT_B = CA.FONT_B
FONT_C = CA.FONT_C


def _pil(a):
    return Image.fromarray(to8(a))


def _arr(img):
    return np.asarray(img.convert('RGB')).astype(np.float32) / 255


def strands(shape, n, seed, ang=0.0, spread=0.3, L=(10, 40), wrap=True, width=1):
    """Thin straw / hay strands. Returns (mask 0..1, tone per pixel 0..1)."""
    h, w = shape; r = rng(seed)
    m = np.zeros(shape, np.float32); t = np.zeros(shape, np.float32)
    for _ in range(n):
        x, y = r.uniform(0, w), r.uniform(0, h); l = r.uniform(*L); a = ang + r.normal(0, spread)
        v = r.uniform(0.3, 1.0); x2, y2 = x + np.cos(a) * l, y + np.sin(a) * l
        offs = [(ox, oy) for ox in (-w, 0, w) for oy in (-h, 0, h)] if wrap else [(0, 0)]
        for ox, oy in offs:
            p0 = (int((x + ox) * 4), int((y + oy) * 4)); p1 = (int((x2 + ox) * 4), int((y2 + oy) * 4))
            cv2.line(m, p0, p1, 1.0, width, cv2.LINE_AA, shift=2)
            cv2.line(t, p0, p1, v, width, cv2.LINE_AA, shift=2)
    return np.clip(m, 0, 1), t


def paint(name, rect, seed):
    if name in SHARED:
        return CA.paint(name, rect, seed)
    x0, y0, x1, y1 = rect; shape = (y1 - y0, x1 - x0); h, w = shape; r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.3, seed, fmin=2, fmax=60, shape=shape); f = spectral(0, 0.5, seed + 1, fmin=30, shape=shape)
    rough = np.full(shape, 0.88, np.float32); metal = np.zeros(shape, np.float32); hgt = f * 0.3
    if name == 'brick_white_soot':
        alb, hgt, rough, metal = CA.brick(shape, 'white', seed)
        sl = spectral(0, 2.0, seed + 11, fmin=1, fmax=12, shape=shape)
        soot = np.clip(smoothstep(0.0, 1.0, sl * 0.25 + (h - yy) / h * 1.3 - 0.35), 0, 1) ** 1.5
        alb = lerp(alb, srgb('#1a1714'), soot * 0.88)
        alb = lerp(alb, srgb('#6a4a30'), smoothstep(0.9, 1.6, f) * (1 - soot) * 0.25)
        rough = rough * 0 + 0.95
    elif name == 'conc_panel':
        alb = colorize(norm01(n + f * 0.4), [(0, '#7d796f'), (1, '#a39f94')])
        seam = (np.abs(yy - h * 0.02) < 3).astype(np.float32) + (np.abs(xx - w * 0.5) < 2).astype(np.float32)
        streak = np.clip(blur(spectral(0, 1.2, seed + 5, fmin=8, fmax=120, shape=shape), (25, 0.6), True) - 0.5, 0, 1)
        alb = lerp(alb, srgb('#5a4a3a'), streak * 0.5); alb = lerp(alb, srgb('#3a3631'), np.clip(seam, 0, 1) * 0.8)
        hgt = f * 0.4 - np.clip(seam, 0, 1) * 2; rough[:] = 0.92
    elif name == 'slate_old':
        alb, hgt, rough, metal = CA.paint('slate', rect, seed)
        moss = smoothstep(0.3, 1.4, spectral(0, 1.6, seed + 9, fmin=3, fmax=80, shape=shape))
        alb = lerp(alb * 0.82, srgb('#4f5634'), moss * 0.55)
        alb = lerp(alb, srgb('#b9b06a'), (r.random(shape) > 0.99)[..., None] * 0.5 * moss[..., None])
        alb = lerp(alb, srgb('#2e2c28'), smoothstep(0.8, 1.6, f) * 0.3)
    elif name == 'corr_rust':
        wave = np.sin(xx / w * 2 * np.pi * 13)
        rust = smoothstep(-0.6, 0.8, n + 0.4 * smoothstep(h * 0.4, h, yy))
        galv = colorize(norm01(f), [(0, '#7f827e'), (1, '#a3a6a1')])
        rcol = colorize(norm01(f * 0.5 + n * 0.5), [(0, '#3d2216'), (0.5, '#6a3820'), (1, '#94582e')])
        alb = lerp(galv, rcol, rust) * (0.78 + 0.22 * (wave * 0.5 + 0.5))[..., None]
        alb = lerp(alb, srgb('#2a1a12'), smoothstep(1.0, 1.8, spectral(0, 2.0, seed + 3, fmin=3, fmax=40, shape=shape)) * 0.5)
        hgt = wave * 2.5 + f * 0.3; metal = 0.75 * (1 - rust) + 0.3 * rust; rough = 0.45 + 0.45 * rust
    elif name == 'wood_grey':
        board = (xx // (w / 5)).astype(int); gap = ((xx % (w / 5)) < 4).astype(np.float32)
        grain = np.sin(yy * 0.07 + n * 5 + board * 2.3 + np.sin(xx * 0.4) * 0.5)
        btone = rng(seed + 2).random(8)[board % 8]
        alb = colorize(norm01(grain * 0.4 + f * 0.3 + btone[..., None][..., 0] * 0.6), [(0, '#4d4842'), (0.5, '#6f6a61'), (1, '#8d877c')])
        knot = np.zeros(shape, np.float32)
        for k in range(5):
            stamp_disc(knot, r.uniform(0, w), r.uniform(0, h), r.uniform(3, 6), 1, 2)
        alb = lerp(alb, srgb('#2a2620'), knot * 0.7); alb = lerp(alb, srgb('#191613'), gap)
        alb = lerp(alb, srgb('#3d3a2a'), smoothstep(h * 0.75, h, yy)[..., None] * 0.35)
        hgt = (1 - gap) * 2 + grain * 0.5 - knot; rough[:] = 0.92
    elif name == 'wood_green':
        board = (yy // (h / 6)).astype(int); gap = ((yy % (h / 6)) < 3).astype(np.float32)
        grain = np.sin(xx * 0.08 + n * 4 + board * 1.7)
        alb, chip, _, _ = CA.chip_paint(shape, seed, '#4f7148', '#6a5f50', 0.65)
        alb = lerp(alb, srgb('#3d362c'), (grain * 0.5 + 0.5)[..., None] * chip[..., None] * 0.5)
        alb = lerp(alb, srgb('#1a1714'), gap); hgt = (1 - gap) * 2 + grain * 0.3 * chip; rough[:] = 0.8
    elif name == 'logs_end':
        # stacked split firewood seen end-on: wedge / round sections with rings, bark rim, dark gaps
        alb = np.zeros(shape + (3,), np.float32) + srgb('#1b1612'); hgt = np.zeros(shape, np.float32)
        img = Image.new('RGB', (w, h), (27, 22, 18)); d = ImageDraw.Draw(img)
        hm = Image.new('L', (w, h), 0); dh = ImageDraw.Draw(hm)
        rows = 7
        for j in range(rows + 1):
            cy = j * h / rows + r.uniform(-4, 4)
            x = -r.uniform(0, 20)
            while x < w + 20:
                rad = r.uniform(12, 21)
                cx = x + rad
                tone = r.uniform(0.75, 1.1)
                base = np.array([168, 132, 92]) * tone
                kind = r.random()
                if kind < 0.5:   # half / quarter split: polygon wedge
                    a0 = r.uniform(0, 2 * np.pi); span = r.choice([np.pi, np.pi / 2, np.pi * 0.66])
                    pts = [(cx, cy)] + [(cx + np.cos(a) * rad, cy + np.sin(a) * rad) for a in np.linspace(a0, a0 + span, 8)]
                    d.polygon(pts, fill=tuple(int(c) for c in base)); dh.polygon(pts, fill=200)
                    d.line(pts[1:], fill=(60, 44, 32), width=3)
                else:
                    d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=(62, 48, 36)); dh.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=210)
                    d.ellipse([cx - rad + 3, cy - rad + 3, cx + rad - 3, cy + rad - 3], fill=tuple(int(c) for c in base))
                    for k in range(2, int(rad - 3), 4):
                        d.ellipse([cx - k, cy - k, cx + k, cy + k], outline=tuple(int(c * 0.85) for c in base), width=1)
                    if r.random() < 0.6:
                        d.line([(cx, cy), (cx + rad * 0.9, cy + r.uniform(-4, 4))], fill=(40, 30, 22), width=2)
                x += rad * 2 + r.uniform(-2, 4)
        alb = _arr(img); hgt = np.asarray(hm, np.float32) / 255 * 3
        alb = lerp(alb, srgb('#5c574e'), smoothstep(0.6, 1.6, n) * 0.45)   # greyed weathering
        rough[:] = 0.92
    elif name.startswith('bark_'):
        # u = around the stem (periodic), v = along it. Ridges meander slowly; plates broken by short cross cracks.
        sp = name[5:]
        u = xx / w
        smooth = spectral(0, 3.0, seed + 2, fmin=1, fmax=5, shape=shape)
        streak = blur(spectral(0, 1.0, seed + 3, fmin=2, fmax=90, shape=shape), (10, 0.8), True)
        streak /= streak.std() + 1e-6
        cross = blur(spectral(0, 1.0, seed + 5, fmin=2, fmax=90, shape=shape), (0.8, 6), True)
        cross /= cross.std() + 1e-6
        k = {'acacia': 6, 'oak': 7, 'poplar': 5, 'walnut': 6}[sp]
        mid = blur(spectral(0, 2.0, seed + 6, fmin=3, fmax=40, shape=shape), (16, 2.5), True); mid /= mid.std() + 1e-6
        ph1 = k * u + 0.12 * smooth + 0.16 * mid + 0.06 * streak
        d1 = np.abs(ph1 - np.floor(ph1) - 0.5) * 2                    # 0 ridge centre .. 1 furrow
        ph2 = (k + 1) * u - 0.12 * smooth - 0.16 * mid + 0.3 + 0.06 * streak
        d2 = np.abs(ph2 - np.floor(ph2) - 0.5) * 2
        crack = smoothstep(1.1, 1.8, cross)
        if sp == 'acacia':     # black locust: deep, interlacing rope-like ridges
            fur = np.minimum(smoothstep(0.35, 0.75, d1), smoothstep(0.3, 0.8, d2) * 0.6 + 0.4)
            fur = np.clip(fur + crack * 0.5, 0, 1)
            stops = [(0, '#231d18'), (0.45, '#4f463d'), (0.8, '#6c6256'), (1, '#80766a')]
        elif sp == 'oak':      # blocky fissured plates
            fur = np.clip(smoothstep(0.45, 0.8, d1) + crack * 0.8, 0, 1)
            stops = [(0, '#1f1b17'), (0.45, '#3f3a33'), (0.8, '#58524a'), (1, '#6c665d')]
        elif sp == 'poplar':
            fur = np.clip(smoothstep(0.55, 0.9, d1) + crack * 0.5, 0, 1)
            stops = [(0, '#2a2722'), (0.45, '#55554a'), (0.8, '#6f705f'), (1, '#83846f')]
        else:                  # walnut: pale grey, shallow diamond furrows
            fur = np.clip(np.maximum(smoothstep(0.7, 0.95, d1), smoothstep(0.75, 0.97, d2) * 0.8) + crack * 0.3, 0, 1)
            stops = [(0, '#5a564f'), (0.45, '#8a867c'), (0.8, '#a29e94'), (1, '#b3afa4')]
        plate = 1 - fur
        tone = np.clip(plate * 0.8 + norm01(blur(n, 1.2)) * 0.2 + streak * 0.04, 0, 1)
        alb = colorize(tone, stops)
        alb = lerp(alb, srgb('#56603c'), smoothstep(0.9, 1.7, spectral(0, 1.8, seed + 4, fmin=2, fmax=20, shape=shape)) * 0.28)  # lichen
        hgt = plate * 4 + streak * 0.3
        rough[:] = 0.95
    elif name == 'hay_side':
        # outer wrap of an old round bale: strands wound around (u), sun-greyed top, darker damp bottom (v)
        base = colorize(norm01(n), [(0, '#6e6244'), (1, '#8f7f56')])
        m1, t1 = strands(shape, 2600, seed + 3, ang=0.0, spread=0.18, L=(14, 50))
        m2, t2 = strands(shape, 900, seed + 4, ang=0.0, spread=0.6, L=(8, 25))
        col_a = colorize(t1, [(0, '#5d5440'), (0.5, '#a39066'), (1, '#c9b47e')])
        col_b = colorize(t2, [(0, '#4a4232'), (1, '#8a8a7a')])
        alb = lerp(base, col_a, m1 * 0.9); alb = lerp(alb, col_b, m2 * 0.6)
        grey = smoothstep(-0.5, 1.2, spectral(0, 2.0, seed + 5, fmin=2, fmax=20, shape=shape))
        alb = lerp(alb, srgb('#77736a'), grey * 0.35)
        twine = (np.abs((yy % (h / 5)) - 3) < 1.2).astype(np.float32)
        alb = lerp(alb, srgb('#b8b2a0'), twine * 0.5)
        hgt = m1 * 1.5 + m2 + n * 0.5; rough[:] = 1.0
    elif name == 'hay_end':
        cx, cy = w / 2, h / 2
        dx, dy = xx - cx, yy - cy; rad = np.sqrt(dx * dx + dy * dy) + 1e-3; ang = np.arctan2(dy, dx)
        spiral = np.sin(rad * 0.55 - ang * 1.0 + n * 1.2)
        base = colorize(norm01(spiral * 0.5 + f * 0.5), [(0, '#4e4430'), (0.5, '#8a7a52'), (1, '#b09c6a')])
        m, t = strands(shape, 2200, seed + 6, ang=0, spread=3.0, L=(5, 18))
        alb = lerp(base, colorize(t, [(0, '#5d5440'), (1, '#c4ae78')]), m * 0.6)
        alb = lerp(alb, srgb('#3a3326'), smoothstep(w * 0.42, w * 0.5, rad)[..., None] * 0.6)   # dark rim, bleeds edge
        alb = lerp(alb, srgb('#77736a'), smoothstep(0.5, 1.5, spectral(0, 2, seed + 7, fmin=2, fmax=20, shape=shape)) * 0.3)
        hgt = spiral * 1.2 + m; rough[:] = 1.0
    elif name == 'hay_burnt':
        F1, F2, ids = voronoi(0, 70, seed + 2, shape=shape, warp=4)
        cr = smoothstep(3, 0.5, F2 - F1)
        alb = colorize(norm01(n), [(0, '#0e0d0c'), (1, '#2b2724')])
        ashm = smoothstep(0.4, 1.4, spectral(0, 1.6, seed + 3, fmin=3, fmax=60, shape=shape))
        alb = lerp(alb, srgb('#8a857d'), ashm * 0.7)
        m, t = strands(shape, 900, seed + 4, ang=0, spread=0.4, L=(8, 30))
        alb = lerp(alb, colorize(t, [(0, '#3d342a'), (1, '#7a6a48')]), m * smoothstep(0.6, 1.5, -n) * 0.8)
        alb = lerp(alb, srgb('#7a3a1a'), cr * smoothstep(0.8, 1.6, f) * 0.5)
        hgt = (1 - cr) * 1.5 + m * 0.5; rough[:] = 0.98
    elif name == 'straw':
        base = colorize(norm01(n), [(0, '#5a5040'), (1, '#7f7256')])
        m, t = strands(shape, 3200, seed + 3, ang=np.pi / 2, spread=0.7, L=(10, 40))
        alb = lerp(base, colorize(t, [(0, '#4e4636'), (0.6, '#968661'), (1, '#b8a679')]), m * 0.85)
        grey = smoothstep(-0.3, 1.3, spectral(0, 2.0, seed + 5, fmin=2, fmax=24, shape=shape))
        alb = lerp(alb, srgb('#6e6a62'), grey * 0.45)
        alb = lerp(alb, srgb('#3b3a2a'), smoothstep(0.9, 1.7, n) * 0.35)   # mould
        hgt = m * 1.5 + n * 0.5; rough[:] = 1.0
    elif name == 'soil':
        F1, F2, ids = voronoi(0, 140, seed + 2, shape=shape, warp=3)
        clod = smoothstep(0, 6, F2 - F1) * (rng(seed + 3).random(140)[ids] * 0.5 + 0.5)
        alb = colorize(norm01(clod * 0.6 + n * 0.3 + f * 0.3), [(0, '#1d1814'), (0.45, '#2f2721'), (0.8, '#4a3f35'), (1, '#5c5044')])
        alb = lerp(alb, srgb('#6a5a44'), smoothstep(1.0, 1.8, spectral(0, 1.8, seed + 4, fmin=3, fmax=60, shape=shape)) * 0.35)  # clay
        hgt = clod * 3 + f * 0.4; rough[:] = 0.97
    elif name == 'trench_floor':
        mud = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#16120f'), (0.6, '#241e18'), (1, '#33291f')])
        wet = smoothstep(0.4, 1.3, spectral(0, 2.0, seed + 3, fmin=2, fmax=30, shape=shape))
        alb = lerp(mud, srgb('#0d0b0a'), wet * 0.6)
        # duckboards across the trench (u = along the trench, v = across)
        plank = np.zeros(shape, np.float32)
        for k in range(4):
            xc = (k + 0.5) * w / 4 + r.uniform(-6, 6)
            plank = np.maximum(plank, (np.abs(xx - xc - (yy - h / 2) * r.uniform(-0.05, 0.05)) < 12).astype(np.float32) * (yy > h * 0.22) * (yy < h * 0.78))
        rails = ((np.abs(yy - h * 0.3) < 5) | (np.abs(yy - h * 0.7) < 5)).astype(np.float32)
        wood = colorize(norm01(f), [(0, '#3a3128'), (1, '#5a4c3c')])
        alb = lerp(alb, wood * 0.7, rails * 0.8); alb = lerp(alb, wood, plank)
        hgt = plank * 2 + rails - wet; rough = 0.95 - wet * 0.6 - plank * 0.0
    elif name == 'sandbag':
        rows = 6; bw = w / 2
        row = (yy // (h / rows)).astype(int); off = (row % 2) * bw / 2
        fx = ((xx + off) % bw) / bw; fy = (yy % (h / rows)) / (h / rows)
        pill = np.clip(1 - ((fx - 0.5) / 0.52) ** 4 - ((fy - 0.5) / 0.55) ** 4, 0, 1) ** 0.4
        bid = ((xx + off) // bw).astype(int) * 7 + row * 13
        tone = (bid * 0.37) % 1.0
        weave = (np.sin(xx * 2.2) * np.sin(yy * 2.2)) * 0.5 + 0.5
        col = colorize(np.clip(tone * 0.6 + norm01(n) * 0.4, 0, 1), [(0, '#5a5236'), (0.5, '#776c48'), (1, '#8e8560')])
        alb = col * (0.55 + 0.45 * pill)[..., None] * (0.92 + 0.08 * weave)[..., None]
        alb = lerp(alb, srgb('#2e2820'), smoothstep(0.6, 1.6, f) * 0.3)
        hgt = pill * 4 + weave * 0.2; rough[:] = 0.97
    elif name == 'sod':
        base = colorize(norm01(n), [(0, '#3e3528'), (1, '#5a5038')])
        m, t = strands(shape, 2500, seed + 3, ang=-np.pi / 2, spread=0.9, L=(4, 14))
        alb = lerp(base, colorize(t, [(0, '#4a4430'), (0.5, '#6e6646'), (1, '#8e8262')]), m * 0.75)
        alb = lerp(alb, srgb('#2e261e'), smoothstep(0.7, 1.6, f) * 0.4)
        hgt = m + n * 0.5; rough[:] = 0.97
    elif name in ('mtz_blue', 'niva_red', 'trailer_blue', 'mtz_red', 'mtz_cab'):
        col = {'mtz_blue': '#24508a', 'niva_red': '#9c2a1f', 'trailer_blue': '#3e6a78', 'mtz_red': '#a8281c', 'mtz_cab': '#c9c8bf'}[name]
        alb, chip, _, _ = CA.chip_paint(shape, seed, col, '#6e3f22', 0.35)
        dust = smoothstep(-0.5, 1.5, spectral(0, 1.4, seed + 7, fmin=2, fmax=60, shape=shape) + (yy / h) * 1.2 - 0.6)
        alb = lerp(alb, srgb('#8a7f68'), dust * 0.35)
        alb = lerp(alb, srgb('#2a2620'), smoothstep(1.2, 1.9, f) * 0.3)   # oil
        if name == 'trailer_blue':
            rib = ((xx % (w / 4)) < 10).astype(np.float32)
            alb = alb * (1 - rib * 0.25)[..., None]; hgt = rib * 2
        metal = 0.1 + chip * 0.4; rough = 0.55 + chip * 0.25 + dust * 0.2
    elif name == 'tyre_tread':
        # u = around the circumference (x, region repeats twice per turn), v = across the tyre (y).
        # Chevron lugs of a tractor drive tyre, dried mud between them.
        img = Image.new('L', (w, h), 0); d = ImageDraw.Draw(img)
        N = 10; p = w / N
        for k in range(-1, N + 2):
            x = k * p
            for side in (-1, 1):
                x0 = x + (p / 2 if side > 0 else 0)
                yc, ye = h / 2 + side * 6, h / 2 + side * h * 0.5
                d.polygon([(x0, yc), (x0 + p * 0.38, yc), (x0 + p * 0.38 + p * 0.9, ye), (x0 + p * 0.9, ye)], fill=255)
        lug = blur(np.asarray(img, np.float32) / 255, 0.8, wrap=False)
        rub = colorize(norm01(n), [(0, '#151515'), (1, '#2a2928')])
        mud = colorize(norm01(f), [(0, '#3e352a'), (1, '#5d5141')])
        alb = lerp(lerp(rub * 0.6, mud, smoothstep(0.2, 1.4, blur(n, 3)) * 0.6), rub * 1.3, lug)
        hgt = lug * 4; rough[:] = 0.9
    elif name == 'metal_dark':
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#1e1e1d'), (1, '#3e3d3a')])
        alb = lerp(alb, srgb('#5c3a22'), smoothstep(0.9, 1.6, f) * 0.5); alb = lerp(alb, srgb('#7a705c'), smoothstep(0.8, 1.6, n) * 0.25)
        metal[:] = 0.5; rough[:] = 0.6
    elif name in ('burnt_metal', 'burnt_paint'):
        rustn = spectral(0, 1.6, seed + 2, fmin=2, fmax=60, shape=shape)
        # burnt-out steel: charcoal soot over most of it, dull brown-orange heat rust in patches, grey-white ash
        alb = colorize(norm01(rustn * 0.6 + f * 0.4), [(0, '#2a1d16'), (0.4, '#4a2c1e'), (0.75, '#6a3e26'), (1, '#7e5236')])
        soot = smoothstep(-0.6, 0.6, spectral(0, 1.8, seed + 3, fmin=2, fmax=40, shape=shape))
        alb = lerp(alb, colorize(norm01(f), [(0, '#141312'), (1, '#2a2826')]), soot * 0.85)
        ashm = smoothstep(1.0, 1.7, spectral(0, 1.4, seed + 4, fmin=3, fmax=60, shape=shape))
        alb = lerp(alb, srgb('#8d887f'), ashm * 0.55)
        if name == 'burnt_paint':   # blistered paint patches left (colour stays readable: red Niva / blue MTZ)
            keep = smoothstep(0.5, 1.2, spectral(0, 2.0, seed + 5, fmin=2, fmax=20, shape=shape))
            paintc = colorize(norm01(f), [(0, '#4a1d16'), (1, '#6d2a1e')])
            alb = lerp(alb, paintc, keep * 0.8)
            alb = lerp(alb, srgb('#2a2420'), (r.random(shape) > 0.985)[..., None] * keep[..., None])
        hgt = f * 0.8 + rustn * 0.3; metal = 0.25 * (1 - soot); rough = 0.85 + 0.1 * soot
    elif name == 'grille':
        sl = ((yy % 10) < 5).astype(np.float32)
        alb = colorize(norm01(n), [(0, '#151515'), (1, '#2a2928')]) * (0.6 + 0.4 * sl)[..., None]
        alb = lerp(alb, srgb('#5a3a22'), smoothstep(0.7, 1.6, f) * 0.5); hgt = sl * 2; metal[:] = 0.4; rough[:] = 0.7
    elif name == 'window_barn':
        # kolkhoz barn window: concrete lintel/sill reveal, steel/wood frame 3x2 panes, dirty glass, some broken
        img = Image.new('RGB', (w, h), (150, 146, 136)); d = ImageDraw.Draw(img)
        fx0, fy0, fx1, fy1 = 0.08 * w, 0.1 * h, 0.92 * w, 0.9 * h
        d.rectangle([fx0, fy0, fx1, fy1], fill=(62, 60, 55))
        cols, rws = 3, 2
        for i in range(cols):
            for j in range(rws):
                a = fx0 + 8 + i * (fx1 - fx0 - 8) / cols; b = fy0 + 8 + j * (fy1 - fy0 - 8) / rws
                c = fx0 + (i + 1) * (fx1 - fx0 - 8) / cols; e = fy0 + (j + 1) * (fy1 - fy0 - 8) / rws
                broken = r.random() < 0.35
                d.rectangle([a, b, c, e], fill=(18, 20, 22) if broken else (64, 72, 72))
                if not broken:
                    d.polygon([(a, b), (a + (c - a) * 0.5, b), (a, b + (e - b) * 0.6)], fill=(86, 94, 92))
                else:
                    d.polygon([(a, b), (a + (c - a) * r.uniform(0.2, 0.5), b), (a, b + (e - b) * r.uniform(0.2, 0.5))], fill=(80, 88, 86))
        alb = _arr(img); alb = lerp(alb, srgb('#5a5446'), smoothstep(0.6, 1.6, n) * 0.35)
        glass = ((alb.sum(-1) < 1.0) & (yy > fy0 + 6) & (yy < fy1 - 6)).astype(np.float32)
        rough = 0.85 - glass * 0.6; hgt = (1 - glass) * 1.5
    elif name == 'gate_barn':
        # double wooden gate of planks with Z bracing, faded red-brown paint, grey wood where worn; covers both leaves
        board = (xx // (w / 12)).astype(int); gap = ((xx % (w / 12)) < 3).astype(np.float32)
        grain = np.sin(yy * 0.08 + n * 4 + board * 2.1)
        alb, chip, _, _ = CA.chip_paint(shape, seed, '#6e3a2a', '#6f6a61', 0.75)
        alb = lerp(alb, srgb('#3d362c'), (grain * 0.5 + 0.5)[..., None] * chip[..., None] * 0.4)
        img = _pil(alb); d = ImageDraw.Draw(img)
        for (a, b) in ((0, w / 2 - 2), (w / 2 + 2, w)):
            for yb in (0.12, 0.5, 0.88):
                d.rectangle([a, h * yb - 7, b, h * yb + 7], fill=(78, 48, 36))
            d.line([(a + 6, h * 0.86), (b - 6, h * 0.53)], fill=(78, 48, 36), width=12)
            d.line([(a + 6, h * 0.48), (b - 6, h * 0.15)], fill=(78, 48, 36), width=12)
        d.rectangle([w / 2 - 2, 0, w / 2 + 2, h], fill=(18, 15, 12))
        alb = _arr(img); alb = lerp(alb, srgb('#1a1714'), gap * 0.9)
        alb = lerp(alb, srgb('#3a3326'), smoothstep(h * 0.8, h, yy)[..., None] * 0.5)
        hgt = (1 - gap) * 2 + grain * 0.3
    elif name == 'door_blue':
        board = (xx // (w / 6)).astype(int); gap = ((xx % (w / 6)) < 3).astype(np.float32)
        alb, chip, _, _ = CA.chip_paint(shape, seed, '#3c6a96', '#6f6a61', 0.6)
        img = _pil(alb); d = ImageDraw.Draw(img)
        for yb in (0.15, 0.85):
            d.rectangle([4, h * yb - 8, w - 4, h * yb + 8], fill=(50, 90, 128))
        d.line([(8, h * 0.82), (w - 8, h * 0.18)], fill=(50, 90, 128), width=14)
        d.rectangle([w * 0.82, h * 0.48, w * 0.88, h * 0.54], fill=(40, 36, 30))
        alb = _arr(img); alb = lerp(alb, srgb('#1a1714'), gap * 0.9); hgt = (1 - gap) * 2
    elif name == 'gate_green':
        # steel sheet village gate painted green, embossed rising-sun rays in the top corners of each leaf (two leaves)
        alb, chip, _, _ = CA.chip_paint(shape, seed, '#3d6b45', '#6e3f22', 0.4)
        img = _pil(alb); d = ImageDraw.Draw(img)
        emb = Image.new('L', (w, h), 0); de = ImageDraw.Draw(emb)
        for (cx, sgn) in ((w / 2, -1), (w / 2, 1)):
            for k in range(9):
                a = np.pi + k / 8 * np.pi / 2 if sgn < 0 else -k / 8 * np.pi / 2
                a = (np.pi / 2) * (k / 8) * sgn
                ex = cx + np.sin(a) * w * 0.48 * 1.0; ey = h * 0.06 + np.cos(a) * h * 0.45
                de.line([(cx, h * 0.06), (ex, ey)], fill=255, width=5)
            de.pieslice([cx - 30, h * 0.06 - 30, cx + 30, h * 0.06 + 30], 0, 180, fill=255)
        for y in (0.04, 0.5, 0.96):
            de.rectangle([0, h * y - 4, w, h * y + 4], fill=255)
        de.rectangle([w / 2 - 3, 0, w / 2 + 3, h], fill=0)
        e = blur(np.asarray(emb, np.float32) / 255, 1.2, wrap=False)
        alb = _arr(img) * (1 + 0.12 * e)[..., None]
        alb = lerp(alb, srgb('#1e1c18'), (np.abs(xx - w / 2) < 2).astype(np.float32))
        hgt = e * 2.5; metal = chip * 0.4; rough = 0.6 + chip * 0.2
    elif name == 'mosaic':
        # Soviet roadside bus-stop smalt mosaic: rising sun over a wheat field, ears of wheat, sky blue
        img = Image.new('RGB', (w, h), (64, 120, 170)); d = ImageDraw.Draw(img)
        d.rectangle([0, h * 0.55, w, h], fill=(214, 168, 60))
        for k in range(14):
            a = np.pi + k / 13 * np.pi
            d.polygon([(w / 2, h * 0.55), (w / 2 + np.cos(a - 0.05) * w, h * 0.55 + np.sin(a - 0.05) * w), (w / 2 + np.cos(a + 0.05) * w, h * 0.55 + np.sin(a + 0.05) * w)],
                      fill=(240, 200, 80) if k % 2 else (90, 150, 196))
        d.pieslice([w / 2 - 50, h * 0.55 - 50, w / 2 + 50, h * 0.55 + 50], 180, 360, fill=(226, 80, 40))
        for k in range(5):
            x = w * (0.12 + k * 0.19)
            d.line([(x, h), (x + 8, h * 0.62)], fill=(150, 100, 30), width=4)
            for j in range(6):
                yk = h * (0.64 + j * 0.035)
                d.ellipse([x + 4 - 6, yk - 4, x + 4 + 6, yk + 6], fill=(236, 190, 70))
        tiles = np.asarray(img, np.float32) / 255
        tx = ((xx % 8) < 1) | ((yy % 8) < 1)
        jitter = rng(seed + 9).random((h // 8 + 1, w // 8 + 1))[(yy // 8).astype(int), (xx // 8).astype(int)]
        alb = tiles * (0.85 + 0.25 * jitter)[..., None]
        alb = lerp(alb, srgb('#6e6a62'), tx.astype(np.float32) * 0.7)
        lost = smoothstep(1.1, 1.6, spectral(0, 1.8, seed + 3, fmin=2, fmax=30, shape=shape))   # tiles fallen off -> concrete
        alb = lerp(alb, colorize(norm01(f), [(0, '#77736a'), (1, '#99958c')]), lost)
        hgt = (1 - tx) * 1.0 * (1 - lost) - lost * 0.5; rough = 0.35 + lost * 0.55 + tx * 0.4
    elif name == 'conc_painted':
        alb = srgb('#cfd6d4') * (0.9 + 0.1 * norm01(n))[..., None] + np.zeros(shape + (3,))
        band = (yy > h * 0.7).astype(np.float32)
        alb = lerp(alb, srgb('#6a93b4'), band)
        peel = smoothstep(1.0, 1.5, spectral(0, 2.0, seed + 6, fmin=2, fmax=40, shape=shape))
        alb = lerp(alb, colorize(norm01(f), [(0, '#7a766e'), (1, '#9d998f')]), peel)
        streak = np.clip(blur(spectral(0, 1.2, seed + 5, fmin=8, fmax=120, shape=shape), (25, 0.6), True) - 0.4, 0, 1)
        alb = lerp(alb, srgb('#5a5040'), streak * 0.4)
        hgt = (1 - peel) * 0.8; rough[:] = 0.9
    elif name == 'rushnyk':
        # embroidered linen towel (vertical strip): red / black cross-stitch bands, fringe at the bottom
        alb = srgb('#e6e1d4') * (0.92 + 0.08 * norm01(f))[..., None] + np.zeros(shape + (3,))
        img = _pil(alb); d = ImageDraw.Draw(img)
        for yb in (0.12, 0.62):
            y0b = h * yb
            for i in range(0, w, 16):
                d.polygon([(i + 8, y0b), (i + 16, y0b + 10), (i + 8, y0b + 20), (i, y0b + 10)], fill=(170, 30, 30))
            for i in range(8, w, 32):
                d.rectangle([i, y0b + 28, i + 14, y0b + 60], fill=(30, 26, 24))
                d.polygon([(i + 7, y0b + 66), (i + 18, y0b + 80), (i + 7, y0b + 94), (i - 4, y0b + 80)], fill=(170, 30, 30))
        for i in range(0, w, 5):
            d.line([(i, h * 0.95), (i + 1, h)], fill=(200, 194, 180), width=2)
        alb = _arr(img); alb = lerp(alb, srgb('#8a8070'), smoothstep(0.7, 1.7, n) * 0.35)
        rough[:] = 0.95
    elif name == 'cross_wood':
        grain = np.sin(xx * 0.18 + n * 5)
        alb = colorize(norm01(grain * 0.4 + f * 0.6), [(0, '#2a1d14'), (0.5, '#3e2c1e'), (1, '#57402c')])
        alb = lerp(alb, srgb('#6a655c'), smoothstep(0.5, 1.6, n) * 0.35)
        hgt = grain * 0.5; rough[:] = 0.8
    elif name in ('tank_rust', 'tank_holed'):
        # riveted steel plates (1.4 x 1 m in a 1 m region: one seam each way), silver paint mostly gone to rust streaks
        seam_y = (np.abs(yy - h * 0.5) < 2).astype(np.float32); seam_x = (np.abs(xx - w * 0.3) < 2).astype(np.float32)
        riv = np.zeros(shape, np.float32)
        for x in np.arange(4, w, 14):
            stamp_disc(riv, x, h * 0.5 - 6, 2.2, 1, 1); stamp_disc(riv, x, h * 0.5 + 6, 2.2, 1, 1)
        for y in np.arange(4, h, 14):
            stamp_disc(riv, w * 0.3 - 6, y, 2.2, 1, 1)
        silver = colorize(norm01(f), [(0, '#8a8c88'), (1, '#a9aba5')])
        rust = colorize(norm01(n * 0.5 + f * 0.5), [(0, '#3a2016'), (0.5, '#6a3820'), (1, '#9a5a30')])
        streak = np.clip(blur(spectral(0, 1.1, seed + 5, fmin=6, fmax=140, shape=shape), (30, 1.0), True) * 1.2 + n * 0.5, -2, 2)
        rmask = smoothstep(-0.4, 0.6, streak)
        alb = lerp(silver, rust, rmask)
        alb = lerp(alb, srgb('#2a1a12'), (seam_y + seam_x)[..., None] * 0.6)
        alb = alb * (1 + riv * 0.2)[..., None]
        hgt = riv * 2 - (seam_x + seam_y) + f * 0.4
        metal = 0.6 * (1 - rmask) + 0.2; rough = 0.45 + 0.45 * rmask
        if name == 'tank_holed':
            hole = np.zeros(shape, np.float32); rim = np.zeros(shape, np.float32)
            for k in range(14):
                cx, cy, rr = r.uniform(10, w - 10), r.uniform(10, h - 10), r.uniform(3, 10)
                stamp_disc(rim, cx, cy, rr * 1.8, 1, rr * 0.6); stamp_disc(hole, cx, cy, rr, 1, 1.5)
            alb = lerp(alb, srgb('#b07040'), np.clip(rim - hole, 0, 1)[..., None] * 0.6)
            alb = lerp(alb, srgb('#080707'), hole); hgt = hgt + rim * 1.5 - hole * 4; rough = np.maximum(rough, hole)
    elif name == 'silo_steel':
        # corrugated galvanised bin wall: horizontal waves (along v), vertical bolt seams, zinc bloom + streaks
        wave = np.sin(yy / h * 2 * np.pi * 10)
        alb = colorize(norm01(f * 0.5 + n * 0.5), [(0, '#8e928f'), (1, '#b8bcb6')]) * (0.82 + 0.18 * (wave * 0.5 + 0.5))[..., None]
        seam = (np.abs(xx - w * 0.5) < 3).astype(np.float32)
        bolts = ((np.abs(xx - w * 0.5 - 5) < 2) & ((yy % 13) < 3)).astype(np.float32)
        streak = np.clip(blur(spectral(0, 1.1, seed + 5, fmin=6, fmax=140, shape=shape), (35, 1.0), True), -2, 2)
        alb = lerp(alb, srgb('#6a5a48'), smoothstep(0.6, 1.4, streak) * 0.45)
        alb = lerp(alb, srgb('#5d605c'), seam * 0.5); alb = lerp(alb, srgb('#2a2a28'), bolts)
        hgt = wave * 2.5 + seam; metal = 0.8 - smoothstep(0.6, 1.4, streak) * 0.4; rough = 0.4 + 0.3 * norm01(f)
    elif name == 'silo_conc':
        lift = (np.abs((yy % (h / 2)) - 2) < 1.5).astype(np.float32)
        alb = colorize(norm01(n + f * 0.4), [(0, '#7f7a70'), (1, '#a8a397')])
        streak = np.clip(blur(spectral(0, 1.1, seed + 5, fmin=6, fmax=140, shape=shape), (40, 1.0), True), -2, 2)
        alb = lerp(alb, srgb('#4a463e'), smoothstep(0.3, 1.4, streak) * 0.5); alb = lerp(alb, srgb('#5a554c'), lift * 0.5)
        hgt = f * 0.5 - lift; rough[:] = 0.92
    elif name == 'felt_roof':
        alb = colorize(norm01(f * 0.7 + n * 0.3), [(0, '#1a1a19'), (1, '#33322f')])
        grit = (r.random(shape) > 0.9).astype(np.float32)
        alb = lerp(alb, srgb('#5a5850'), grit * 0.35)
        lap = (np.abs((yy % (h / 1.0)) - h + 6) < 4).astype(np.float32)
        alb = lerp(alb, srgb('#0e0e0d'), lap * 0.8)
        alb = lerp(alb, srgb('#4a4d34'), smoothstep(0.9, 1.7, n) * 0.4)
        hgt = grit * 0.4 + lap * 1.5; rough[:] = 0.9
    elif name == 'steel_rust':
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#3a2318'), (0.4, '#5e3520'), (0.8, '#7d4a2a'), (1, '#8c6a50')])
        alb = lerp(alb, srgb('#4d5a5e'), smoothstep(0.6, 1.4, spectral(0, 1.8, seed + 4, fmin=3, fmax=40, shape=shape)) * 0.7)  # old grey primer
        hgt = f * 0.6; metal[:] = 0.4; rough[:] = 0.8
    elif name == 'ash':
        alb = colorize(norm01(n * 0.7 + f * 0.3), [(0, '#1a1816'), (0.6, '#4a4641'), (1, '#8a857c')])
        hgt = n * 0.5 + f * 0.3; rough[:] = 0.98
    elif name == 'mtz_face':
        # top half: MTZ-80 radiator grille face (white-framed grille, round headlights below the hood);
        # bottom half: hood side panel with louvres + 'БЕЛАРУС' badge on blue paint
        alb, chip, _, _ = CA.chip_paint(shape, seed, '#24508a', '#6e3f22', 0.3)
        img = _pil(alb); d = ImageDraw.Draw(img)
        d.rectangle([w * 0.18, h * 0.04, w * 0.82, h * 0.44], fill=(200, 200, 194))
        d.rectangle([w * 0.24, h * 0.08, w * 0.76, h * 0.40], fill=(28, 28, 28))
        for k in range(12):
            y = h * (0.09 + k * 0.026); d.line([(w * 0.24, y), (w * 0.76, y)], fill=(70, 70, 68), width=2)
        for k in range(10):
            yk = h * (0.58 + k * 0.03); d.line([(w * 0.62, yk), (w * 0.94, yk)], fill=(18, 36, 60), width=3)
        d.rectangle([w * 0.06, h * 0.64, w * 0.5, h * 0.74], fill=(205, 205, 198))
        fnt = ImageFont.truetype(FONT_C, 19)
        d.text((w * 0.075, h * 0.648), 'БЕЛАРУС', fill=(28, 52, 100), font=fnt)
        alb = _arr(img); alb = lerp(alb, srgb('#8a7f68'), smoothstep(-0.5, 1.5, n)[..., None] * 0.25)
        metal = chip * 0.3; rough[:] = 0.6
    elif name == 'plaster_soot':
        alb, hgt, rough, metal = CA.paint('plaster_white', rect, seed)
        sl = spectral(0, 2.0, seed + 11, fmin=1, fmax=12, shape=shape)
        soot = np.clip(smoothstep(0.0, 1.0, sl * 0.25 + (h - yy) / h * 1.3 - 0.35), 0, 1) ** 1.5
        alb = lerp(alb, srgb('#191613'), soot * 0.88)
    elif name == 'interior_dark':
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#1c1a17'), (1, '#3a3631')])
        alb = lerp(alb, srgb('#55504a'), smoothstep(0.8, 1.6, n) * 0.4); rough[:] = 0.95
    elif name == 'straw_bedding':
        base = colorize(norm01(n), [(0, '#2e271d'), (1, '#4a3f2e')])
        m, t = strands(shape, 2200, seed + 3, ang=0, spread=3.0, L=(8, 26))
        alb = lerp(base, colorize(t, [(0, '#4e4636'), (1, '#9a8a62')]), m * 0.7)
        alb = lerp(alb, srgb('#1e1a14'), smoothstep(0.6, 1.5, f) * 0.5)
        hgt = m + n * 0.4; rough[:] = 0.98
    else:
        alb = colorize(norm01(n), [(0, '#555555'), (1, '#777777')])
    return alb.astype(np.float32), hgt.astype(np.float32), np.clip(rough, 0, 1).astype(np.float32), metal.astype(np.float32)


def build():
    alb = np.zeros((S, S, 3), np.float32) + 0.5; hgt = np.zeros((S, S), np.float32)
    rough = np.full((S, S), 0.85, np.float32); metal = np.zeros((S, S), np.float32); ao = np.ones((S, S), np.float32)
    for i, (name, rc) in enumerate(REG.items()):
        # shared regions use the city seed so the village matches city.glb
        seed = 8000 + list(CA.REG).index(name) * 7 if name in SHARED and name in CA.REG else 9100 + i * 7
        a, hh, rr, mm = paint(name, rc, seed)
        x0, y0, x1, y1 = rc
        alb[y0:y1, x0:x1] = a; hgt[y0:y1, x0:x1] = hh; rough[y0:y1, x0:x1] = rr; metal[y0:y1, x0:x1] = mm
        ao[y0:y1, x0:x1] = cavity_ao(hh, 3, 0.3, wrap=False)
    paths = [os.path.join(CACHE, f'farmland_atlas_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    Image.fromarray(to8(alb)).save(paths[0], quality=90, optimize=True)
    nrm = to8(blur(normal_from_height(hgt, 1.0, wrap=False).astype(np.float32) / 255.0, 0.5, wrap=False))
    Image.fromarray(quantize_normal(nrm, 6)).save(paths[1], optimize=True, compress_level=9)
    orm = to8(blur(np.stack([ao, rough, metal], -1), 0.5, wrap=False))
    Image.fromarray(quantize_normal(orm, 6)).save(paths[2], optimize=True, compress_level=9)
    return paths


if __name__ == '__main__':
    import time; t0 = time.time()
    print(build(), time.time() - t0)
