"""City props atlas (2048^2, 256 px grid) for city.glb: heating-pipe foil, PO-2 fence relief, private-house plaster /
brick / slate / tin, fences, church plaster + domes, Soviet cars, bins, lamps, billboards, Ukrainian road signs,
market pavilions. Albedo JPEG, normal PNG, ORM PNG in _cache/city_atlas_*.
"""
import os
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont
from texlib import (spectral, norm01, colorize, srgb, lerp, to8, normal_from_height, smoothstep, blur, CACHE,
                    quantize_normal, voronoi, rng, cavity_ao, bake_shade, stamp_disc)
import texlib

S = 2048
C = 256
GRID = [
    ['foil', 'pipe_rust', 'felt_wrap', 'concrete', 'po2', 'po2+', 'brick_red', 'brick_white'],
    ['plaster_white', 'plaster_blue', 'plaster_yellow', 'plaster_burnt', 'slate', 'tin_green', 'tin_red', 'tin_galv'],
    ['prof_brown', 'prof_green', 'picket', 'wood_raw', 'charred', 'window_house', 'door_house', 'gate'],
    ['church_plaster', 'dome_gold', 'dome_blue', 'dome_green', 'church_window', 'church_door', 'icon', 'wool'],
    ['car_white', 'car_blue', 'car_red', 'car_beige', 'car_glass', 'tyre', 'chrome', 'car_front'],
    ['bin_green', 'metal_grey', 'hv_sign', 'louvre', 'pav_panel', 'shutter', 'lamp_conc', 'paint_white'],
    ['billboard_a', 'billboard_a+', 'billboard_b', 'billboard_b+', 'road_signs', 'sign_dir', 'bench_wood', 'soot'],
    ['pav_signs', 'pav_signs+', 'tarp', 'rubber', 'glass_dark', 'cable', 'metal_rust_paint', 'ground'],
]
REG = {}
for j, row in enumerate(GRID):
    i = 0
    while i < len(row):
        n = row[i]
        w = 1
        while i + w < len(row) and row[i + w] == n + '+':
            w += 1
        REG[n] = (i * C, j * C, (i + w) * C, j * C + C)
        i += w
FONT_B = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FONT_C = '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf'
FONT_S = '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'
ROAD_SIGNS = ['give_way', 'crossing', 'children', 'no_entry']   # quadrants of 'road_signs' (TL, TR, BL, BR)


def _shape(r):
    x0, y0, x1, y1 = r; return (y1 - y0, x1 - x0)


def _pil(alb):
    return Image.fromarray(to8(alb))


def _arr(img):
    return np.asarray(img.convert('RGB')).astype(np.float32) / 255


def chip_paint(shape, seed, col, under='#6b4a32', amt=0.5):
    n = spectral(0, 1.3, seed, fmin=3, fmax=60, shape=shape); f = spectral(0, 0.5, seed + 1, fmin=30, shape=shape)
    chip = smoothstep(1.2 - amt, 1.6 - amt * 0.5, n)
    alb = lerp(srgb(col) * (0.88 + 0.12 * norm01(f))[..., None] + np.zeros(shape + (3,)), srgb(under), chip)
    alb = lerp(alb, srgb('#3b2a1e'), smoothstep(1.0, 1.8, f) * 0.35)
    return alb, chip, n, f


def brick(shape, col, seed, rows=13):
    h, w = shape; r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ch = h / rows; bw = w / 4
    row = (yy // ch).astype(int); off = (row % 2) * bw / 2
    fx = (xx + off) % bw; fy = yy % ch
    m = ((fx > 2.2) & (fy > 2.2)).astype(np.float32)
    bid = (((xx + off) // bw).astype(int) * 31 + row * 17) % 97
    tone = (bid * 0.618) % 1.0
    stops = {'red': [(0, '#6e3325'), (0.5, '#91452f'), (1, '#a85a3e')], 'white': [(0, '#b2ac9f'), (0.5, '#c4beb1'), (1, '#d1ccc0')]}[col]
    mort = {'red': '#a39a8b', 'white': '#9e998d'}[col]
    alb = lerp(srgb(mort) + np.zeros((h, w, 3)), colorize(tone, stops), m)
    n = spectral(0, 1.4, seed, fmin=2, fmax=40, shape=shape)
    alb = lerp(alb, srgb('#4d463c'), smoothstep(0.5, 1.8, n) * 0.3)
    return alb, m * 1.5, np.full(shape, 0.85, np.float32), np.zeros(shape, np.float32)


def paint(name, rect, seed):
    shape = _shape(rect); h, w = shape; r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.3, seed, fmin=2, fmax=60, shape=shape); f = spectral(0, 0.5, seed + 1, fmin=30, shape=shape)
    rough = np.full(shape, 0.85, np.float32); metal = np.zeros(shape, np.float32); hgt = f * 0.3
    if name == 'foil':
        # aluminium foil / thin galvanised cladding over mineral wool: crinkles, seams every 0.5 m (u = around, v = along)
        crk = spectral(0, 0.9, seed + 2, fmin=20, fmax=200, shape=shape)
        seam = (np.abs((yy % (h / 2)) - 2) < 3).astype(np.float32)
        alb = colorize(norm01(crk * 0.6 + n * 0.4), [(0, '#7d807f'), (0.5, '#a5a8a6'), (1, '#c6c8c4')])
        alb = lerp(alb, srgb('#5e5f5b'), seam * 0.6)
        dirt = smoothstep(0.3, 1.0, yy * 0 + np.abs(np.sin(xx / w * np.pi)) * 0 + smoothstep(0.55, 1.0, xx / w))  # lower side of pipe dirty
        alb = lerp(alb, srgb('#5a5446'), dirt * 0.4)
        tear = smoothstep(1.3, 1.7, spectral(0, 2.0, seed + 3, fmin=2, fmax=30, shape=shape))
        wool = colorize(norm01(f), [(0, '#8d7a3e'), (1, '#c4a85a')])
        alb = lerp(alb, wool, tear)
        hgt = crk * 0.8 - seam * 1.5 - tear * 1.0; metal = 0.75 * (1 - tear); rough = 0.35 + 0.5 * tear + 0.15 * norm01(crk)
    elif name == 'pipe_rust':
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#3a2318'), (0.4, '#5e3520'), (0.8, '#7d4a2a'), (1, '#8c6a50')])
        scale_ = smoothstep(0.8, 1.4, f); alb = lerp(alb, srgb('#2a1a12'), scale_ * 0.5)
        hgt = f * 0.8 + n * 0.3; metal[:] = 0.35; rough[:] = 0.85
    elif name == 'felt_wrap':
        alb = colorize(norm01(f), [(0, '#1d1c1a'), (1, '#36332e')])
        band = (np.abs((yy % (h / 3)) - 4) < 2.5).astype(np.float32)
        alb = lerp(alb, srgb('#7a6a55'), band * 0.8); alb = lerp(alb, srgb('#8f8a7c'), smoothstep(0.5, 1.6, n) * 0.4)
        hgt = f * 0.4 + band; rough[:] = 0.8
    elif name == 'concrete':
        alb = colorize(norm01(n + f * 0.5), [(0, '#7a766e'), (1, '#a29e95')])
        alb = lerp(alb, srgb('#4c4943'), smoothstep(0.8, 1.8, spectral(0, 2.0, seed + 3, fmin=2, fmax=30, shape=shape)) * 0.4)
        hgt = f * 0.5; rough[:] = 0.9
    elif name == 'po2':
        # PO-2 fence panel 4 x 2 m: diamond lattice of pyramidal 'pillows' inside a flat frame
        um = xx / w * 4.0; vm = (h - yy) / h * 2.0
        p = 0.25
        a = (um / p + vm / p); b = (um / p - vm / p)
        fa = a - np.floor(a) - 0.5; fb = b - np.floor(b) - 0.5
        pyr = 1 - 2 * np.maximum(np.abs(fa), np.abs(fb))
        frame = ((um < 0.12) | (um > 3.88) | (vm < 0.12) | (vm > 1.88)).astype(np.float32)
        hgt = pyr * 4.0 * (1 - frame) + frame * 4.5 + f * 0.4
        conc = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#78746c'), (1, '#9d998f')])
        alb = conc * bake_shade(hgt, 0.9, 0.35, wrap=False)
        alb = lerp(alb, srgb('#3e3a33'), smoothstep(0.35, 0.0, vm)[..., None] * 0.35)   # splash dirt
        alb = lerp(alb, srgb('#5a5242'), smoothstep(1.0, 1.9, spectral(0, 2.0, seed + 3, fmin=2, fmax=40, shape=shape)) * 0.45)
        # a bit of graffiti
        img = _pil(alb); d = ImageDraw.Draw(img)
        d.text((w * 0.58, h * 0.42), 'ЖЕКА', fill=(52, 70, 120), font=ImageFont.truetype(FONT_B, 34))
        alb = _arr(img); rough[:] = 0.92
    elif name in ('brick_red', 'brick_white'):
        return brick(shape, name.split('_')[1], seed)
    elif name.startswith('plaster_'):
        col = {'plaster_white': '#d9d6cc', 'plaster_blue': '#9fb8c9', 'plaster_yellow': '#d8c48a', 'plaster_burnt': '#6d665c'}[name]
        alb = srgb(col) * (0.9 + 0.1 * norm01(n))[..., None] + np.zeros(shape + (3,))
        crack = texlib.random_walk_cracks(shape, 4, seed + 5, length=(30, 90), width=1.0, wrap=True)
        peel = smoothstep(1.1, 1.5, spectral(0, 2.0, seed + 6, fmin=2, fmax=40, shape=shape))
        under = brick(shape, 'white' if name != 'plaster_yellow' else 'red', seed)[0]
        alb = lerp(alb, under * 0.9, peel); alb = lerp(alb, srgb('#4a443b'), crack * 0.6)
        alb = lerp(alb, srgb('#6e675a'), smoothstep(0.3, 0.0, (h - yy) / h)[..., None] * 0.35)
        hgt = (1 - peel) * 1.0 - crack * 1.5 + f * 0.3; rough[:] = 0.92
        if name == 'plaster_burnt':
            soot = smoothstep(-0.5, 1.0, n + (h - yy) / h)
            alb = lerp(alb, srgb('#171513'), np.clip(soot, 0, 1) * 0.85)
    elif name == 'slate':
        # corrugated asbestos-cement sheet: 8 waves per 1 m width, lichen / moss, sheet overlaps every ~1.1 m
        wave = np.sin(xx / w * 2 * np.pi * 8)
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#7f7c74'), (1, '#9c998f')]) * (0.85 + 0.15 * (wave * 0.5 + 0.5))[..., None]
        lap = (np.abs((yy % (h * 0.5)) - h * 0.5 + 3) < 3).astype(np.float32)
        alb = lerp(alb, srgb('#4b4a44'), lap * 0.7)
        moss = smoothstep(0.9, 1.6, spectral(0, 1.6, seed + 4, fmin=3, fmax=60, shape=shape))
        alb = lerp(alb, srgb('#5d6440'), moss * 0.6); alb = lerp(alb, srgb('#c9c27a'), (r.random(shape) > 0.997)[..., None] * 0.6)
        hgt = wave * 2.5 - lap; rough[:] = 0.92
    elif name.startswith('tin_') or name.startswith('prof_'):
        col = {'tin_green': '#3f6a4a', 'tin_red': '#7b3328', 'tin_galv': '#9a9d9a', 'prof_brown': '#5c3a26', 'prof_green': '#3b5e3c'}[name]
        rib = (xx % (w / 5)) / (w / 5)
        prof = np.where(rib < 0.3, 1.0, np.where(rib < 0.4, 1 - (rib - 0.3) / 0.1, np.where(rib < 0.9, 0.0, (rib - 0.9) / 0.1)))
        alb, chip, _, _ = chip_paint(shape, seed, col, '#6e3f22', 0.3 if name != 'tin_galv' else 0.1)
        if name == 'tin_galv':
            alb = lerp(alb, srgb('#6a5a48'), smoothstep(0.8, 1.6, f) * 0.5); metal[:] = 0.7
        else:
            metal = chip * 0.4
        alb = alb * (0.8 + 0.2 * prof)[..., None]
        hgt = prof * 3 + f * 0.2; rough = 0.55 + chip * 0.3
    elif name == 'picket':
        board = (xx // (w / 6)).astype(int); gap = ((xx % (w / 6)) < 5).astype(np.float32)
        grain = np.sin(yy * 0.3 + n * 3 + board * 2)
        alb, chip, _, _ = chip_paint(shape, seed, '#7d9bb0', '#7a6a55', 0.6)
        alb = lerp(alb, srgb('#4a3e30'), (grain * 0.5 + 0.5)[..., None] * chip[..., None] * 0.4)
        alb = lerp(alb, srgb('#1e1a16'), gap); hgt = (1 - gap) * 2 + grain * 0.3; rough[:] = 0.85
    elif name == 'wood_raw':
        board = (yy // (h / 5)).astype(int); gap = ((yy % (h / 5)) < 4).astype(np.float32)
        grain = np.sin(xx * 0.25 + n * 4 + board * 1.7)
        alb = lerp(srgb('#5d5246'), srgb('#857a6b'), grain * 0.3 + 0.5 + 0.15 * norm01(f)); alb = lerp(alb, srgb('#1e1a16'), gap)
        hgt = (1 - gap) * 2 + grain * 0.4
    elif name == 'charred':
        F1, F2, ids = voronoi(0, 90, seed + 2, shape=shape)
        cr = smoothstep(3, 0.5, F2 - F1)
        alb = colorize(norm01(n), [(0, '#0d0c0b'), (1, '#2a2522')]); alb = lerp(alb, srgb('#6a3a20'), cr * smoothstep(0.5, 1.5, f) * 0.6)
        hgt = (1 - cr) * 2; rough[:] = 0.95
    elif name == 'window_house':
        # village window: white-painted wooden double frame with a fortochka, net curtain, blue carved trim
        alb = srgb('#2d4a72') * (0.9 + 0.1 * norm01(n))[..., None] + np.zeros(shape + (3,))
        img = _pil(alb); d = ImageDraw.Draw(img)
        x0, y0, x1, y1 = w * 0.12, h * 0.1, w * 0.88, h * 0.9
        d.rectangle([x0, y0, x1, y1], fill=(222, 220, 212))
        for (a, b, c, e) in ((x0 + 10, y0 + 10, w / 2 - 5, y0 + h * 0.25), (x0 + 10, y0 + h * 0.25 + 8, w / 2 - 5, y1 - 10), (w / 2 + 5, y0 + 10, x1 - 10, y1 - 10)):
            d.rectangle([a, b, c, e], fill=(26, 32, 36))
            d.rectangle([a, b + (e - b) * 0.05, c, e], fill=(70, 74, 72))
        d.polygon([(x0 - 10, y0), (w / 2, y0 - 22), (x1 + 10, y0)], fill=(45, 74, 114))
        alb = _arr(img); alb = lerp(alb, srgb('#5d5a52'), smoothstep(0.6, 1.6, n) * 0.3)
        glass = ((alb.sum(-1) < 0.9) & (yy > h * 0.12) & (yy < h * 0.88)).astype(np.float32)
        rough = 0.8 - glass * 0.7; hgt = (1 - glass) * 1.5
    elif name == 'door_house':
        alb, chip, _, _ = chip_paint(shape, seed, '#6b3b24', '#5a4a3a', 0.5)
        img = _pil(alb); d = ImageDraw.Draw(img)
        for (a, b, c, e) in ((0.15, 0.08, 0.85, 0.45), (0.15, 0.52, 0.85, 0.92)):
            d.rectangle([w * a, h * b, w * c, h * e], outline=(40, 22, 14), width=4)
        d.rectangle([w * 0.75, h * 0.5, w * 0.8, h * 0.56], fill=(160, 150, 120))
        alb = _arr(img)
    elif name == 'gate':
        alb, chip, _, _ = chip_paint(shape, seed, '#2f4e6e', '#6e3f22', 0.4)
        img = _pil(alb); d = ImageDraw.Draw(img)
        d.ellipse([w * 0.3, h * 0.05, w * 0.7, h * 0.45], outline=(200, 160, 60), width=6)
        for k in range(12):
            a = k / 12 * 2 * np.pi
            d.line([(w * 0.5 + np.cos(a) * w * 0.2, h * 0.25 + np.sin(a) * h * 0.2), (w * 0.5 + np.cos(a) * w * 0.32, h * 0.25 + np.sin(a) * h * 0.3)], fill=(200, 160, 60), width=4)
        alb = _arr(img); metal = chip * 0.3; rough[:] = 0.6
    elif name == 'church_plaster':
        alb = srgb('#e2e0d8') * (0.93 + 0.07 * norm01(n))[..., None] + np.zeros(shape + (3,))
        pit = np.zeros(shape, np.float32)
        for k in range(55):
            stamp_disc(pit, r.uniform(0, w), r.uniform(0, h), r.uniform(1.0, 3.5), 1, 1.0)
        alb = lerp(alb, srgb('#8c867a'), blur(pit, 1.5, False) * 0.7); alb = lerp(alb, srgb('#2d2a26'), pit * 0.8)
        alb = lerp(alb, srgb('#8f8a7c'), smoothstep(0.7, 1.7, f) * 0.25)
        hgt = -pit * 2 + f * 0.2; rough[:] = 0.9
    elif name.startswith('dome_'):
        if name == 'dome_gold':
            alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#8a6a22'), (0.6, '#c49a3a'), (1, '#e0bf62')]); metal[:] = 0.95; rough[:] = 0.3
            seams = (np.abs((xx % (w / 8)) - 1) < 1.5).astype(np.float32); alb = lerp(alb, srgb('#6a501a'), seams * 0.5)
            hgt = seams * -1.0
        else:
            col = '#2e5a8c' if name == 'dome_blue' else '#3e7a5a'
            alb, chip, _, _ = chip_paint(shape, seed, col, '#6e5a3a', 0.2)
            if name == 'dome_blue':   # gold stars
                img = _pil(alb); d = ImageDraw.Draw(img)
                for k in range(22):
                    cx, cy, s_ = r.uniform(0, w), r.uniform(0, h), r.uniform(5, 9)
                    pts = [(cx + np.cos(a) * (s_ if i % 2 == 0 else s_ * 0.45), cy + np.sin(a) * (s_ if i % 2 == 0 else s_ * 0.45)) for i, a in enumerate(np.linspace(-np.pi / 2, 1.5 * np.pi, 11)[:-1])]
                    d.polygon(pts, fill=(214, 176, 72))
                alb = _arr(img)
            metal[:] = 0.4; rough[:] = 0.5
        pit = np.zeros(shape, np.float32)
        for k in range(30):
            stamp_disc(pit, r.uniform(0, w), r.uniform(h * 0.2, h), r.uniform(1.0, 3.0), 1, 1.0)
        alb = lerp(alb, srgb('#151413'), pit * 0.85); hgt = hgt - pit * 2
    elif name == 'church_window':
        alb = srgb('#e2e0d8') + np.zeros(shape + (3,))
        img = _pil(alb); d = ImageDraw.Draw(img)
        d.rectangle([w * 0.25, h * 0.32, w * 0.75, h * 0.95], fill=(20, 26, 32)); d.ellipse([w * 0.25, h * 0.07, w * 0.75, h * 0.57], fill=(20, 26, 32))
        d.line([(w * 0.5, h * 0.1), (w * 0.5, h * 0.95)], fill=(200, 200, 196), width=4)
        for yk in (0.45, 0.65, 0.82):
            d.line([(w * 0.25, h * yk), (w * 0.75, h * yk)], fill=(200, 200, 196), width=3)
        d.rectangle([w * 0.18, h * 0.95, w * 0.82, h * 1.0], fill=(170, 166, 158))
        alb = _arr(img); glass = (alb.sum(-1) < 0.5).astype(np.float32); rough = 0.85 - glass * 0.75
    elif name == 'church_door':
        alb, chip, _, _ = chip_paint(shape, seed, '#5a3a22', '#3a2a1a', 0.3)
        img = _pil(alb); d = ImageDraw.Draw(img)
        d.line([(w / 2, 0), (w / 2, h)], fill=(30, 20, 12), width=4)
        for k in range(4):
            d.rectangle([w * 0.1, h * (0.08 + k * 0.22), w * 0.42, h * (0.25 + k * 0.22)], outline=(150, 120, 60), width=3)
            d.rectangle([w * 0.58, h * (0.08 + k * 0.22), w * 0.9, h * (0.25 + k * 0.22)], outline=(150, 120, 60), width=3)
        alb = _arr(img)
    elif name == 'icon':
        # stylised icon above the entrance: gold ground, halo, dark robed figure (no likeness)
        alb = colorize(norm01(n), [(0, '#a8842e'), (1, '#d1ac52')])
        img = _pil(alb); d = ImageDraw.Draw(img)
        d.ellipse([w * 0.3, h * 0.08, w * 0.7, h * 0.42], fill=(232, 200, 110), outline=(120, 80, 30), width=3)
        d.ellipse([w * 0.4, h * 0.15, w * 0.6, h * 0.36], fill=(170, 120, 90))
        d.polygon([(w * 0.5, h * 0.33), (w * 0.2, h * 0.95), (w * 0.8, h * 0.95)], fill=(110, 30, 30))
        d.polygon([(w * 0.5, h * 0.36), (w * 0.33, h * 0.95), (w * 0.67, h * 0.95)], fill=(40, 50, 90))
        d.rectangle([0, 0, w - 1, h - 1], outline=(240, 236, 226), width=10)
        alb = _arr(img); metal = 0.3 * (alb[..., 0] > alb[..., 2] + 0.25); rough[:] = 0.6
    elif name == 'wool':
        fib = blur(r.random(shape).astype(np.float32), (0.6, 3), False)
        alb = colorize(norm01(fib + n * 0.3), [(0, '#8a7438'), (1, '#c8aa58')]); hgt = fib * 3; rough[:] = 1.0
    elif name.startswith('car_') and name not in ('car_glass', 'car_front'):
        col = {'car_white': '#c9c8c0', 'car_blue': '#3a5f86', 'car_red': '#8c2a22', 'car_beige': '#b7a780'}[name]
        alb, chip, _, _ = chip_paint(shape, seed, col, '#6e3a1e', 0.25)
        rust_low = smoothstep(h * 0.75, h, yy) * smoothstep(0.0, 1.0, n + 0.5)
        alb = lerp(alb, srgb('#5e3018'), np.clip(rust_low, 0, 1) * 0.8)
        alb = lerp(alb, srgb('#8a857a'), smoothstep(0.6, 1.6, f) * 0.15)   # dust
        metal = 0.3 * (1 - chip); rough = 0.45 + chip * 0.4 + rust_low * 0.3
    elif name == 'car_glass':
        alb = colorize(norm01(n), [(0, '#1b2226'), (1, '#3c464b')]); alb = lerp(alb, srgb('#7f8a90'), smoothstep(h, 0, yy)[..., None] * 0.3)
        alb = lerp(alb, srgb('#8d887c'), smoothstep(0.6, 1.5, f) * 0.35); rough[:] = 0.1
    elif name == 'tyre':
        alb = colorize(norm01(n), [(0, '#151515'), (1, '#2a2928')]); rad = np.sqrt((xx - w / 2) ** 2 + (yy - h / 2) ** 2)
        hub = (rad < w * 0.28).astype(np.float32)
        alb = lerp(alb, srgb('#5d5d58'), hub); alb = lerp(alb, srgb('#7a4a2a'), hub * smoothstep(0.4, 1.4, f) * 0.6)
        metal = hub * 0.5; rough[:] = 0.85
    elif name == 'chrome':
        alb = colorize(norm01(n), [(0, '#7d7f80'), (1, '#c3c5c4')]); alb = lerp(alb, srgb('#6e3f22'), smoothstep(0.8, 1.6, f) * 0.5)
        metal[:] = 0.9; rough[:] = 0.3
    elif name == 'car_front':
        # top half: front (grille + 2 round headlights), bottom half: rear (tail lights + plate)
        alb = srgb('#2a2a28') + np.zeros(shape + (3,))
        img = _pil(alb); d = ImageDraw.Draw(img)
        d.rectangle([w * 0.25, h * 0.12, w * 0.75, h * 0.36], fill=(150, 150, 146))
        for k in range(8):
            d.line([(w * 0.25, h * (0.14 + k * 0.028)), (w * 0.75, h * (0.14 + k * 0.028))], fill=(40, 40, 38), width=2)
        for cx in (0.13, 0.87):
            d.ellipse([w * cx - 22, h * 0.24 - 22, w * cx + 22, h * 0.24 + 22], fill=(200, 200, 186), outline=(140, 140, 136), width=4)
        d.rectangle([w * 0.03, h * 0.62, w * 0.25, h * 0.78], fill=(150, 30, 26)); d.rectangle([w * 0.75, h * 0.62, w * 0.97, h * 0.78], fill=(150, 30, 26))
        d.rectangle([w * 0.33, h * 0.64, w * 0.67, h * 0.76], fill=(220, 220, 214), outline=(20, 20, 20))
        alb = _arr(img); metal[:] = 0.3; rough[:] = 0.4
    elif name == 'bin_green':
        alb, chip, _, _ = chip_paint(shape, seed, '#3e5e3a', '#6e3f22', 0.45)
        img = _pil(alb); d = ImageDraw.Draw(img)
        d.text((w * 0.25, h * 0.35), '17', fill=(220, 218, 205), font=ImageFont.truetype(FONT_B, 40))
        alb = _arr(img); alb = lerp(alb, srgb('#5e3018'), smoothstep(h * 0.6, h, yy)[..., None] * 0.5)
        metal = chip * 0.4; rough[:] = 0.7
    elif name in ('metal_grey', 'paint_white', 'metal_rust_paint'):
        col = {'metal_grey': '#7a8079', 'paint_white': '#d4d2c8', 'metal_rust_paint': '#4f6a7a'}[name]
        alb, chip, _, _ = chip_paint(shape, seed, col, '#6e3f22', 0.5 if name != 'metal_rust_paint' else 0.9)
        metal = chip * 0.4 + 0.1; rough = 0.6 + chip * 0.2
    elif name == 'hv_sign':
        alb = srgb('#7a8079') + np.zeros(shape + (3,))
        img = _pil(alb); d = ImageDraw.Draw(img)
        d.polygon([(w * 0.5, h * 0.06), (w * 0.94, h * 0.7), (w * 0.06, h * 0.7)], fill=(232, 196, 30), outline=(20, 20, 20), width=6)
        d.line([(w * 0.53, h * 0.2), (w * 0.43, h * 0.45), (w * 0.57, h * 0.45), (w * 0.47, h * 0.66)], fill=(200, 20, 20), width=8)
        f2 = ImageFont.truetype(FONT_C, 26)
        for k, t in enumerate(('НЕ ВЛАЗЬ!', 'УБ\'Є!')):
            tw = d.textlength(t, font=f2); d.text(((w - tw) / 2, h * (0.73 + k * 0.12)), t, fill=(200, 20, 20), font=f2)
        alb = _arr(img); alb = lerp(alb, srgb('#5a4a3a'), smoothstep(0.7, 1.6, n) * 0.35)
    elif name == 'louvre':
        sl = (yy % 18) / 18
        alb = colorize(norm01(n), [(0, '#5b5f5c'), (1, '#777b77')]) * (0.5 + 0.5 * sl)[..., None]
        alb = lerp(alb, srgb('#6e3f22'), smoothstep(0.6, 1.6, f) * 0.6); hgt = sl * 3; metal[:] = 0.4; rough[:] = 0.6
    elif name == 'pav_panel':
        alb = srgb('#dcdcd6') * (0.93 + 0.07 * norm01(n))[..., None] + np.zeros(shape + (3,))
        rib = ((xx % 32) < 3).astype(np.float32); band = ((yy > h * 0.42) & (yy < h * 0.5)).astype(np.float32)
        alb = lerp(alb, srgb('#2d5c9a'), band); alb = lerp(alb, alb * 0.8, rib)
        alb = lerp(alb, srgb('#6a6458'), smoothstep(0.7, 1.7, f) * 0.3); alb = lerp(alb, srgb('#5a4c3c'), smoothstep(h * 0.8, h, yy)[..., None] * 0.4)
        hgt = rib * 1.5; metal[:] = 0.2; rough[:] = 0.5
    elif name == 'shutter':
        slat = (yy % 12) / 12; prof = np.sin(slat * np.pi * 2) * 0.5 + 0.5
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#7f817c'), (1, '#9ea09a')]) * (0.82 + 0.18 * prof)[..., None]
        alb = lerp(alb, srgb('#6a3c1f'), smoothstep(0.6, 1.6, n) * 0.6); hgt = prof * 2; metal[:] = 0.5; rough[:] = 0.55
    elif name == 'lamp_conc':
        alb = colorize(norm01(n * 0.5 + f * 0.5), [(0, '#86827a'), (1, '#a8a49a')])
        streak = blur(spectral(0, 1.2, seed + 5, fmin=8, fmax=120, shape=shape), (0.5, 20), wrap=True)
        alb = lerp(alb, srgb('#6e4a30'), np.clip(streak - 0.6, 0, 1) * 0.6); rough[:] = 0.85
    elif name.startswith('billboard_'):
        img = Image.new('RGB', (w, h), (240, 240, 236)); d = ImageDraw.Draw(img)
        if name == 'billboard_a':   # windows/doors ad, generic
            d.rectangle([0, 0, w, h], fill=(28, 92, 160)); d.rectangle([0, h * 0.68, w, h], fill=(248, 206, 40))
            d.text((w * 0.05, h * 0.08), 'ВІКНА · ДВЕРІ', fill=(255, 255, 255), font=ImageFont.truetype(FONT_B, 54))
            d.text((w * 0.05, h * 0.38), 'ЗНИЖКИ ДО -30%', fill=(248, 206, 40), font=ImageFont.truetype(FONT_B, 36))
            d.text((w * 0.05, h * 0.74), '050 000-00-00', fill=(28, 40, 70), font=ImageFont.truetype(FONT_B, 40))
            d.rectangle([w * 0.72, h * 0.1, w * 0.95, h * 0.62], fill=(230, 236, 240), outline=(255, 255, 255), width=8)
            d.line([(w * 0.835, h * 0.1), (w * 0.835, h * 0.62)], fill=(255, 255, 255), width=6)
        else:  # civic poster: 'МІЙ ДІМ — МОЄ МІСТО'
            d.rectangle([0, 0, w, h], fill=(236, 230, 214)); d.rectangle([0, 0, w * 0.32, h], fill=(64, 130, 76))
            d.ellipse([w * 0.06, h * 0.25, w * 0.26, h * 0.75], fill=(248, 206, 40))
            d.text((w * 0.36, h * 0.15), 'МІЙ ДІМ —', fill=(40, 60, 46), font=ImageFont.truetype(FONT_B, 52))
            d.text((w * 0.36, h * 0.48), 'МОЄ МІСТО', fill=(196, 50, 40), font=ImageFont.truetype(FONT_B, 52))
        alb = _arr(img)
        # torn paper: patches peeled to the grey backing, weather fading, streaks
        tear = smoothstep(1.0, 1.4, spectral(0, 2.2, seed + 7, fmin=2, fmax=30, shape=shape))
        alb = lerp(alb, srgb('#cfcabd'), 0.18); alb = lerp(alb, colorize(norm01(f), [(0, '#8a877e'), (1, '#a9a69c')]), tear)
        alb = lerp(alb, srgb('#5a5448'), np.clip(blur(spectral(0, 1.2, seed + 8, fmin=8, fmax=200, shape=shape), (25, 1), True) - 0.8, 0, 1) * 0.4)
        rough[:] = 0.8; hgt = tear * 0.8
    elif name == 'road_signs':
        img = Image.new('RGB', (w, h), (150, 150, 150)); d = ImageDraw.Draw(img); q = w // 2
        # give way (inverted triangle), crossing (blue square), children (warning triangle), no entry (red disc)
        d.polygon([(6, 8), (q - 6, 8), (q / 2, q - 8)], fill=(200, 30, 30)); d.polygon([(26, 20), (q - 26, 20), (q / 2, q - 36)], fill=(245, 245, 240))
        d.rectangle([q + 6, 6, w - 6, q - 6], fill=(30, 80, 170)); d.polygon([(q + 18, q - 22), (w - 18, q - 22), (q + q / 2, 22)], fill=(245, 245, 240))
        d.ellipse([q + q / 2 - 7, 46, q + q / 2 + 7, 60], fill=(20, 20, 20)); d.line([(q + q / 2, 60), (q + q / 2 - 8, 88)], fill=(20, 20, 20), width=6)
        for k in range(4):
            d.rectangle([q + 34 + k * 16, q - 30, q + 44 + k * 16, q - 24], fill=(20, 20, 20))
        d.polygon([(q / 2, q + 8), (q - 6, w - 10), (6, w - 10)], fill=(200, 30, 30)); d.polygon([(q / 2, q + 30), (q - 26, w - 22), (26, w - 22)], fill=(245, 245, 240))
        d.ellipse([q / 2 - 18, q + 62, q / 2 - 8, q + 72], fill=(20, 20, 20)); d.ellipse([q / 2 + 6, q + 58, q / 2 + 16, q + 68], fill=(20, 20, 20))
        d.line([(q / 2 - 13, q + 72), (q / 2 - 16, w - 30)], fill=(20, 20, 20), width=5); d.line([(q / 2 + 11, q + 68), (q / 2 + 16, w - 30)], fill=(20, 20, 20), width=5)
        d.ellipse([q + 8, q + 8, w - 8, w - 8], fill=(200, 30, 30)); d.rectangle([q + 24, q + q / 2 - 10, w - 24, q + q / 2 + 10], fill=(245, 245, 240))
        alb = _arr(img); alb = lerp(alb, srgb('#7a7468'), smoothstep(0.7, 1.7, n) * 0.3); rough[:] = 0.4; metal[:] = 0.2
        pit = np.zeros(shape, np.float32)
        for k in range(14):
            stamp_disc(pit, r.uniform(0, w), r.uniform(0, h), r.uniform(1.5, 3), 1, 1.0)
        alb = lerp(alb, srgb('#151413'), pit)
    elif name == 'sign_dir':
        img = Image.new('RGB', (w, h), (30, 80, 170)); d = ImageDraw.Draw(img)
        d.rectangle([5, 5, w - 6, h - 6], outline=(245, 245, 240), width=5)
        fnt = ImageFont.truetype(FONT_C, 30)
        for k, (t, arr) in enumerate((('ЦЕНТР', '↑'), ('ВОКЗАЛ', '→'), ('ЛІКАРНЯ', '←'))):
            d.text((22, 24 + k * 74), t, fill=(245, 245, 240), font=fnt)
            d.text((w - 64, 18 + k * 74), arr, fill=(245, 245, 240), font=ImageFont.truetype(FONT_B, 40))
        alb = _arr(img); alb = lerp(alb, srgb('#6a6458'), smoothstep(0.7, 1.7, n) * 0.3); rough[:] = 0.4
    elif name == 'bench_wood':
        board = (yy // (h / 4)).astype(int); gap = ((yy % (h / 4)) < 4).astype(np.float32)
        alb, chip, _, _ = chip_paint(shape, seed, '#4f7a46', '#6a5a46', 0.7)
        alb = lerp(alb, srgb('#1e1a16'), gap); hgt = (1 - gap) * 2
    elif name == 'soot':
        alb = colorize(norm01(n), [(0, '#0f0e0d'), (1, '#24211e')]); rough[:] = 0.98
    elif name == 'pav_signs':
        img = Image.new('RGB', (w, h), (40, 40, 40)); d = ImageDraw.Draw(img)
        specs = [('ПРОДУКТИ', (190, 30, 30), (255, 255, 255)), ('КАВА · ЧАЙ', (60, 34, 20), (240, 170, 60)),
                 ('ОВОЧІ', (60, 130, 50), (255, 250, 220)), ('ЗАПЧАСТИНИ', (30, 70, 140), (250, 220, 60))]
        for k, (t, bg, fg) in enumerate(specs):
            y0 = k * h / 4
            d.rectangle([2, y0 + 2, w - 3, y0 + h / 4 - 3], fill=bg)
            fnt = ImageFont.truetype(FONT_B, 40)
            tw = d.textlength(t, font=fnt); d.text(((w - tw) / 2, y0 + 10), t, fill=fg, font=fnt)
        alb = _arr(img); alb = lerp(alb, srgb('#cfcabd'), 0.12); alb = lerp(alb, srgb('#3a342a'), smoothstep(0.6, 1.7, n) * 0.35); rough[:] = 0.5
    elif name == 'tarp':
        alb = colorize(norm01(n), [(0, '#2a4e7a'), (1, '#3c679a')]); alb = lerp(alb, srgb('#2a2620'), smoothstep(0.5, 1.6, f) * 0.5)
    elif name == 'rubber':
        alb = colorize(norm01(n), [(0, '#1a1a19'), (1, '#2b2a28')])
    elif name == 'glass_dark':
        alb = colorize(norm01(n), [(0, '#1b2226'), (1, '#353f44')]); rough[:] = 0.1
    elif name == 'cable':
        alb = colorize(norm01(n), [(0, '#151514'), (1, '#262624')]); rough[:] = 0.6
    elif name == 'ground':
        alb = colorize(norm01(n + f * 0.5), [(0, '#4a4136'), (1, '#6d6150')]); alb = lerp(alb, srgb('#55603a'), smoothstep(0.6, 1.5, f) * 0.5)
        rough[:] = 0.97
    else:
        alb = colorize(norm01(n), [(0, '#555555'), (1, '#777777')])
    return alb.astype(np.float32), hgt.astype(np.float32), np.clip(rough, 0, 1).astype(np.float32), metal.astype(np.float32)


def build():
    alb = np.zeros((S, S, 3), np.float32) + 0.5; hgt = np.zeros((S, S), np.float32)
    rough = np.full((S, S), 0.85, np.float32); metal = np.zeros((S, S), np.float32); ao = np.ones((S, S), np.float32)
    for i, (name, rc) in enumerate(REG.items()):
        a, hh, rr, mm = paint(name, rc, 8000 + i * 7)
        x0, y0, x1, y1 = rc
        alb[y0:y1, x0:x1] = a; hgt[y0:y1, x0:x1] = hh; rough[y0:y1, x0:x1] = rr; metal[y0:y1, x0:x1] = mm
        ao[y0:y1, x0:x1] = cavity_ao(hh, 3, 0.3, wrap=False)
    paths = [os.path.join(CACHE, f'city_atlas_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    Image.fromarray(to8(alb)).save(paths[0], quality=90, optimize=True)
    nrm = to8(blur(normal_from_height(hgt, 1.0, wrap=False).astype(np.float32) / 255.0, 0.5, wrap=False))
    Image.fromarray(quantize_normal(nrm, 6)).save(paths[1], optimize=True, compress_level=9)
    orm = to8(blur(np.stack([ao, rough, metal], -1), 0.5, wrap=False))
    Image.fromarray(quantize_normal(orm, 6)).save(paths[2], optimize=True, compress_level=9)
    return paths


if __name__ == '__main__':
    import time; t0 = time.time()
    print(build(), time.time() - t0)
