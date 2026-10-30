"""Props atlas (2048^2) for props.glb. 256 px grid; big regions span several cells."""
import os, math
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont
from texlib import (spectral, norm01, colorize, srgb, lerp, to8, normal_from_height, smoothstep, blur, CACHE,
                    quantize_normal, voronoi, rng, cavity_ao, bake_shade)

S = 2048
C = 256
REG = {
    'car_body': (0, 0, 512, 512), 'bus_body': (512, 0, 1024, 512), 'mosaic': (1024, 0, 1536, 512), 'crater': (1536, 0, 2048, 512),
    'kiosk_sign': (0, 1024, 512, 1280), 'kiosk_panel': (512, 1024, 768, 1280),
}
_cells = ['interior_burnt', 'rim', 'tyre', 'glass_dark', 'bag_green', 'bag_white', 'bag_jute', 'steel_rust',
          'garage_door', 'garage_door2', 'silicate', 'concrete', 'roofing', 'paint_red', 'paint_yellow', 'paint_blue']
for i, n in enumerate(_cells):
    REG[n] = ((i % 8) * C, 512 + (i // 8) * C, (i % 8) * C + C, 512 + (i // 8) * C + C)
for i, n in enumerate(['shutter', 'busstop_sign', 'wood', 'soil', 'asphalt_chunk']):
    x0 = 768 + i * C
    REG[n] = (x0, 1024, x0 + C, 1280)
for i, n in enumerate(['ash', 'paint_green', 'steel_paint', 'tarp', 'chrome_burnt']):
    REG[n] = (i * C, 1280, i * C + C, 1536)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

# car side-view mapping constants (shared with build_props)
CAR_L, CAR_H = 4.14, 1.0
BUS_L, BUS_H = 7.0, 2.4


def _shape(r):
    x0, y0, x1, y1 = r; return (y1 - y0, x1 - x0)


def burnt_metal(shape, seed, paint=None, paint_mask=None):
    h, w = shape
    n = spectral(0, 1.5, seed, fmin=3, fmax=120, shape=shape); f = spectral(0, 0.6, seed + 1, fmin=40, shape=shape)
    rust = colorize(norm01(n * 0.7 + f * 0.3), [(0, '#2e2622'), (0.3, '#4f3528'), (0.55, '#6a4a36'), (0.75, '#5c534b'), (1, '#9a958c')])
    soot = smoothstep(-0.2, 1.2, spectral(0, 1.8, seed + 2, fmin=2, fmax=60, shape=shape))
    alb = lerp(rust, colorize(norm01(f), [(0, '#141312'), (1, '#2a2826')]), soot * 0.75)
    ash = smoothstep(0.5, 1.6, spectral(0, 1.3, seed + 3, fmin=5, fmax=80, shape=shape))
    alb = lerp(alb, srgb('#a9a69e'), ash * 0.55)
    if paint is not None:
        alb = lerp(alb, paint * (0.8 + 0.2 * norm01(f))[..., None], paint_mask)
    rough = 0.85 - soot * 0.0 + ash * 0.1
    metal = np.clip(0.35 - soot * 0.25 - ash * 0.2, 0, 1)
    hgt = f * 0.5 + n * 0.3
    return alb, hgt, rough, metal


def paint_car(shape):
    h, w = shape
    alb, hgt, rough, metal = burnt_metal(shape, 11)
    A = np.zeros(shape, np.float32)  # dark lines mask
    pz = lambda z: int((2.07 - z) / CAR_L * w)
    py = lambda y: int((1.0 - y) / 1.0 * 256)
    # side view (rows 0..256): door gaps, arches, handles, sill rust, faded paint remnant low on the doors
    for z in (0.72, -0.25, -1.18):
        cv2.line(A, (pz(z), py(0.25)), (pz(z), py(0.86)), 1.0, 2)
    cv2.line(A, (pz(1.9), py(0.62)), (pz(-1.95), py(0.62)), 0.6, 1)
    for zc in (1.21, -1.21):
        cv2.ellipse(A, (pz(zc), py(0.17)), (int(0.4 / CAR_L * w), int(0.42 * 256)), 0, 180, 360, 1.0, -1)
    for z in (0.5, -0.45):
        cv2.rectangle(A, (pz(z), py(0.72)), (pz(z) + 10, py(0.70)), 1.0, -1)
    paint_m = np.zeros(shape, np.float32)
    paint_m[py(0.55):py(0.3), :] = 1
    paint_m *= smoothstep(0.2, 0.9, norm01(spectral(0, 1.6, 12, fmin=4, fmax=60, shape=shape)))
    alb = lerp(alb, srgb('#b9b3a0'), paint_m * 0.6)   # ghost of the original beige paint
    # top view (rows 256..448): hood/trunk lid outlines, scorched roof
    tz = lambda z: int((2.07 - z) / CAR_L * w)
    tx = lambda x: int(256 + (x + 0.8) / 1.6 * 192)
    cv2.rectangle(A, (tz(1.98), tx(-0.7)), (tz(0.78), tx(0.7)), 0.8, 2)
    cv2.rectangle(A, (tz(-1.28), tx(-0.7)), (tz(-2.0), tx(0.7)), 0.8, 2)
    # front / rear (rows 448..512): grille + headlights (front left half), tail lights (rear right half)
    fx = lambda x, half: int((x + 0.8) / 1.6 * 256) + (0 if half == 0 else 256)
    fy = lambda y: int(448 + (0.9 - y) / 0.7 * 64)
    for xc in (-0.55, 0.55):
        cv2.rectangle(A, (fx(xc - 0.15, 0), fy(0.72)), (fx(xc + 0.15, 0), fy(0.6)), 1.0, -1)
        cv2.rectangle(A, (fx(xc - 0.2, 1), fy(0.75)), (fx(xc + 0.2, 1), fy(0.62)), 0.8, -1)
    cv2.rectangle(A, (fx(-0.35, 0), fy(0.72)), (fx(0.35, 0), fy(0.58)), 0.7, -1)
    alb = lerp(alb, srgb('#0f0e0d'), A * 0.9)
    hgt = hgt - A * 2
    return alb, hgt, rough, metal


def paint_bus(shape):
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    pm = np.zeros(shape, np.float32)
    # PAZ livery remnants: yellow lower body + white upper band survive at the bottom edge / front
    pm[int(256 * (1 - 1.15 / BUS_H)):256, :] = 1.0
    pm *= smoothstep(0.1, 0.8, norm01(spectral(0, 1.4, 21, fmin=3, fmax=50, shape=shape))) * smoothstep(80, 256, yy)
    alb, hgt, rough, metal = burnt_metal(shape, 22, srgb('#c99a2a'), pm * 0.75)
    A = np.zeros(shape, np.float32)
    pz = lambda z: int((3.5 - z) / BUS_L * w)
    py = lambda y: int((BUS_H - y) / BUS_H * 256)
    for zc in (2.25, -1.4):
        cv2.ellipse(A, (pz(zc), py(0.45)), (int(0.6 / BUS_L * w), int(0.55 / BUS_H * 256)), 0, 180, 360, 1.0, -1)
    for z in np.arange(3.2, -3.4, -0.5):
        cv2.line(A, (pz(z), py(0.4)), (pz(z), py(1.15)), 0.35, 1)
    cv2.line(A, (0, py(1.15)), (w, py(1.15)), 0.6, 2)
    # front face (rows 256..512 left half): grille, headlights, destination box
    fx = lambda x: int((x + 1.25) / 2.5 * 256); fy = lambda y: int(256 + (2.9 - y) / 2.9 * 256)
    cv2.rectangle(A, (fx(-0.6), fy(0.85)), (fx(0.6), fy(0.55)), 0.8, -1)
    for xc in (-0.95, 0.95):
        cv2.circle(A, (fx(xc), fy(0.75)), 9, 1.0, -1)
    cv2.rectangle(A, (fx(-0.9), fy(2.75)), (fx(0.9), fy(2.45)), 1.0, -1)
    alb = lerp(alb, srgb('#0f0e0d'), A * 0.9)
    return alb, hgt - A * 2, rough, metal


def paint_mosaic(shape, seed=31):
    """Soviet smalt mosaic: stylised sun, wheat ears and a dove over blue ground, 12 px tesserae; shrapnel-chipped."""
    h, w = shape
    img = Image.new('RGB', (w, h), (58, 92, 130))
    d = ImageDraw.Draw(img)
    for k in range(14):                                    # sun rays
        a = k / 14 * 2 * math.pi
        d.polygon([(w * 0.72, h * 0.3), (w * 0.72 + math.cos(a) * w * 0.4, h * 0.3 + math.sin(a) * w * 0.4),
                   (w * 0.72 + math.cos(a + 0.12) * w * 0.4, h * 0.3 + math.sin(a + 0.12) * w * 0.4)], fill=(200, 150, 60) if k % 2 else (220, 190, 110))
    d.ellipse([w * 0.6, h * 0.18, w * 0.84, h * 0.42], fill=(214, 96, 50))
    for k in range(5):                                     # wheat ears
        x = w * (0.12 + k * 0.08)
        d.line([(x, h * 0.95), (x + 20, h * 0.35)], fill=(170, 130, 50), width=6)
        for j in range(7):
            y = h * 0.38 + j * 18
            d.ellipse([x + 20 - j * 3 - 12, y, x + 20 - j * 3 + 2, y + 16], fill=(230, 190, 90))
            d.ellipse([x + 20 - j * 3 + 2, y + 8, x + 20 - j * 3 + 16, y + 24], fill=(210, 170, 70))
    d.polygon([(w * 0.35, h * 0.62), (w * 0.55, h * 0.5), (w * 0.62, h * 0.58), (w * 0.5, h * 0.66), (w * 0.42, h * 0.72)], fill=(236, 236, 228))
    d.rectangle([0, h * 0.86, w, h], fill=(120, 60, 45))
    a = np.asarray(img).astype(np.float32) / 255
    t = 12
    yy, xx = np.mgrid[0:h, 0:w]
    ty, tx = (yy // t) * t + t // 2, (xx // t) * t + t // 2
    a = a[np.clip(ty, 0, h - 1), np.clip(tx, 0, w - 1)]
    r = rng(seed)
    tv = r.uniform(0.85, 1.12, (h // t + 1, w // t + 1))[yy // t, xx // t]
    a = a * tv[..., None]
    grout = (((yy % t) < 2) | ((xx % t) < 2)).astype(np.float32)
    a = lerp(a, srgb('#6b675e'), grout)
    chips = np.zeros(shape, np.float32)
    for k in range(60):
        cv2.circle(chips, (int(r.uniform(0, w)), int(r.uniform(0, h))), int(r.uniform(4, 22)), 1.0, -1)
    chips *= smoothstep(-0.3, 0.6, spectral(0, 1.0, seed + 1, fmin=20, shape=shape))
    a = lerp(a, srgb('#8a857a'), chips)
    soot = smoothstep(0.6, 1.6, spectral(0, 1.8, seed + 2, fmin=2, fmax=40, shape=shape))
    a = lerp(a, srgb('#1e1c1a'), soot * 0.6)
    hgt = (1 - grout) * 1.5 - chips * 2
    return a, hgt, 0.35 + grout * 0.5 + chips * 0.5, np.zeros(shape, np.float32)


def paint_crater(shape, seed=41):
    """Radial crater map: u,v = 0.5 + (x, z) / (2 R_rim * 1.4). Black-brown scorched pit, ejecta rays."""
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dx, dy = (xx - w / 2) / (w / 2), (yy - h / 2) / (h / 2)
    r = np.sqrt(dx * dx + dy * dy) * 1.4; a = np.arctan2(dy, dx)
    n = spectral(0, 1.3, seed, fmin=3, fmax=100, shape=shape)
    soil = colorize(norm01(n), [(0, '#2c241c'), (0.5, '#4a3d30'), (1, '#6a5a48')])
    pit = smoothstep(0.75, 0.2, r + n * 0.08)
    alb = lerp(soil, colorize(norm01(n), [(0, '#0f0d0b'), (1, '#2a221b')]), pit)
    rays = (np.sin(a * 23 + n * 2) * 0.5 + 0.5) ** 3 * smoothstep(0.8, 1.0, r) * smoothstep(1.4, 1.0, r)
    alb = lerp(alb, srgb('#7a6a55'), rays * 0.6)
    clods = (rng(seed).random(shape) ** 40).astype(np.float32)
    alb = lerp(alb, srgb('#8a7a66'), blur(clods, 1.0, False) * 4 * smoothstep(0.5, 1.2, r))
    hgt = -pit * 3 + n * 0.8 + rays
    return alb, hgt, 0.95 - pit * 0.05, np.zeros(shape, np.float32)


def sign(shape, text, bg, fg, size, seed=0):
    h, w = shape
    img = Image.new('RGB', (w, h), bg); d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT, size)
    tw = d.textlength(text, font=f)
    d.text(((w - tw) / 2, (h - size) / 2 - size * 0.1), text, fill=fg, font=f)
    a = np.asarray(img).astype(np.float32) / 255
    n = spectral(0, 1.4, seed, fmin=3, fmax=60, shape=shape)
    a = lerp(a, srgb('#5c4a38'), smoothstep(0.7, 1.6, n) * 0.6)
    a = lerp(a, srgb('#1b1a18'), smoothstep(0.9, 1.9, spectral(0, 1.8, seed + 1, fmin=2, fmax=30, shape=shape)) * 0.7)
    return a, n * 0.2, np.full(shape, 0.6, np.float32), np.zeros(shape, np.float32)


def swatch(name, shape, seed):
    h, w = shape; r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.3, seed, fmin=3, fmax=60, shape=shape); f = spectral(0, 0.5, seed + 1, fmin=30, shape=shape)
    rough = np.full(shape, 0.85, np.float32); metal = np.zeros(shape, np.float32); hgt = f * 0.3
    if name == 'interior_burnt':
        spring = ((np.sin(xx * 0.5) > 0.6) | (np.sin(yy * 0.5) > 0.6)).astype(np.float32)
        alb = lerp(colorize(norm01(n), [(0, '#151413'), (1, '#3a3632')]), srgb('#5a3a26'), spring * 0.8); hgt = spring * 2; metal = spring * 0.4
    elif name == 'rim':
        alb, hgt, rough, metal = burnt_metal(shape, seed)
        ring = np.abs(np.sqrt((xx - w / 2) ** 2 + (yy - h / 2) ** 2) - w * 0.3) < 6
        alb = lerp(alb, srgb('#2a2522'), ring.astype(np.float32) * 0.7)
    elif name == 'tyre':
        lug = ((((xx // 18) + (yy // 26)) % 2) == 0) & ((yy % 26) < 20)
        alb = colorize(norm01(n), [(0, '#141414'), (1, '#262524')]) + lug[..., None] * 0.02
        hgt = lug * 3.0 + f * 0.2; rough[:] = 0.9
    elif name == 'glass_dark':
        alb = colorize(norm01(n), [(0, '#1d2326'), (1, '#3b4448')]); rough[:] = 0.1
        alb = lerp(alb, srgb('#6f6a60'), smoothstep(0.6, 1.6, f) * 0.4)
    elif name in ('bag_green', 'bag_white', 'bag_jute'):
        weave = (np.sin(xx * 1.6) * np.sin(yy * 1.6))
        base = {'bag_green': ('#3f4a32', '#58644a'), 'bag_white': ('#a8a597', '#cfcbbd'), 'bag_jute': ('#6b5539', '#8c7350')}[name]
        alb = colorize(norm01(n * 0.7 + weave * 0.2), [(0, base[0]), (1, base[1])])
        alb = lerp(alb, srgb('#4a3f33'), smoothstep(0.3, 1.5, -n) * 0.45)      # dirt
        stitch = (np.abs(yy - h * 0.92) < 2).astype(np.float32)
        alb = lerp(alb, srgb('#2e2a24'), stitch * 0.6)
        hgt = weave * 0.5 + n * 0.5; rough[:] = 0.95
    elif name == 'steel_rust':
        alb, hgt, rough, metal = burnt_metal(shape, seed)
        alb = lerp(alb, srgb('#4a2a18'), 0.3)
    elif name in ('garage_door', 'garage_door2'):
        col = '#3f5a3c' if name == 'garage_door' else '#5a3a2a'
        alb = srgb(col) * (0.85 + 0.15 * norm01(n))[..., None] + np.zeros((h, w, 3))
        rust = smoothstep(0.4, 1.4, spectral(0, 1.6, seed + 2, fmin=3, fmax=60, shape=shape)) + smoothstep(h * 0.75, h, yy) * 0.6
        alb = lerp(alb, srgb('#6e3e20'), np.clip(rust, 0, 1) * 0.75)
        rib = ((xx % 64) < 4).astype(np.float32)
        alb = lerp(alb, alb * 0.7, rib); hgt = rib * 2 + n * 0.2; metal = np.clip(0.4 - rust * 0.3, 0, 1); rough = 0.6 + rust * 0.3
        img = Image.fromarray(to8(alb)); d = ImageDraw.Draw(img)
        d.text((w * 0.35, h * 0.12), '47' if name == 'garage_door' else '112', fill=(225, 222, 210), font=ImageFont.truetype(FONT, 46))
        alb = np.asarray(img).astype(np.float32) / 255
    elif name == 'silicate':
        row = (yy // 16) % 2; bx = ((xx + row * 32) % 64) < 61; by = (yy % 16) < 14
        m = (bx & by).astype(np.float32)
        alb = lerp(srgb('#8e897f'), colorize(norm01(n + f), [(0, '#b0aa9e'), (1, '#cdc7ba')]), m)
        alb = lerp(alb, srgb('#2a2724'), smoothstep(0.6, 1.8, spectral(0, 2, seed + 3, fmin=2, fmax=30, shape=shape)) * 0.5)
        hgt = m * 2
    elif name == 'concrete':
        alb = colorize(norm01(n + f * 0.5), [(0, '#7f7b73'), (1, '#a39f96')]); rough[:] = 0.9
    elif name == 'roofing':
        alb = colorize(norm01(f), [(0, '#1f1e1c'), (1, '#36342f')]); rough[:] = 0.8
    elif name.startswith('paint_') or name == 'steel_paint':
        col = {'paint_red': '#a3392b', 'paint_yellow': '#c9a133', 'paint_blue': '#3b5f8e', 'paint_green': '#4d7a43', 'steel_paint': '#7d8a8f'}[name]
        chip = smoothstep(0.5, 1.2, n)
        alb = lerp(srgb(col) * (0.9 + 0.1 * norm01(f))[..., None], srgb('#6b4a32'), chip)
        alb = lerp(alb, srgb('#3b2a1e'), smoothstep(1.0, 1.8, f) * 0.5)
        metal = chip * 0.5; rough = 0.55 + chip * 0.3; hgt = (1 - chip) * 0.6
    elif name == 'shutter':
        slat = (np.sin(yy * 0.4) > 0.7).astype(np.float32)
        alb = lerp(srgb('#7e807b'), srgb('#5a5c57'), slat); alb = lerp(alb, srgb('#6e4122'), smoothstep(0.5, 1.5, n) * 0.6)
        hgt = slat * 1.5; metal[:] = 0.5; rough[:] = 0.6
    elif name == 'wood':
        g = np.sin(yy * 0.5 + n * 4)
        alb = lerp(srgb('#4a3a2a'), srgb('#7a6448'), g * 0.5 + 0.5); hgt = g * 0.4
        alb = lerp(alb, srgb('#5b6f4a'), smoothstep(0.8, 1.6, f) * 0.3)
    elif name == 'soil':
        alb = colorize(norm01(n + f * 0.5), [(0, '#2f271e'), (1, '#5c4c3b')]); rough[:] = 0.95; hgt = n * 1.5
    elif name == 'asphalt_chunk':
        top = (yy < h * 0.6).astype(np.float32)
        agg = (r.random(shape) ** 8).astype(np.float32)
        alb = lerp(colorize(norm01(f), [(0, '#3c3a36'), (1, '#55524d')]), colorize(norm01(n), [(0, '#4a443c'), (1, '#6e665a')]), 1 - top)
        alb = alb + agg[..., None] * 0.2; hgt = agg * 1.5
    elif name == 'chrome_burnt':
        alb = colorize(norm01(n), [(0, '#3a3532'), (1, '#6d6762')]); metal[:] = 0.7; rough[:] = 0.5
    elif name == 'ash':
        alb = colorize(norm01(n + f), [(0, '#1a1918'), (0.6, '#4a4743'), (1, '#8d8a84')]); rough[:] = 0.98
    elif name == 'tarp':
        alb = colorize(norm01(n), [(0, '#3d4a3a'), (1, '#55654f')]); rough[:] = 0.9
    else:
        alb = colorize(norm01(n), [(0, '#555'), (1, '#777')])
    return alb, hgt, rough, metal


def build():
    alb = np.zeros((S, S, 3), np.float32) + 0.4; hgt = np.zeros((S, S), np.float32)
    rough = np.full((S, S), 0.8, np.float32); metal = np.zeros((S, S), np.float32)
    def put(name, res):
        x0, y0, x1, y1 = REG[name]
        a, hh, ro, me = res
        alb[y0:y1, x0:x1] = a; hgt[y0:y1, x0:x1] = hh; rough[y0:y1, x0:x1] = ro; metal[y0:y1, x0:x1] = me
    put('car_body', paint_car(_shape(REG['car_body'])))
    put('bus_body', paint_bus(_shape(REG['bus_body'])))
    put('mosaic', paint_mosaic(_shape(REG['mosaic'])))
    put('crater', paint_crater(_shape(REG['crater'])))
    put('kiosk_sign', sign(_shape(REG['kiosk_sign']), 'ПРЕСА', (232, 230, 220), (32, 70, 140), 118, 51))
    put('busstop_sign', sign(_shape(REG['busstop_sign']), 'А', (230, 200, 40), (25, 25, 25), 170, 52))
    x0, y0, x1, y1 = REG['kiosk_panel']
    a, hh, ro, me = swatch('steel_paint', _shape(REG['kiosk_panel']), 53)
    a = lerp(a, srgb('#2d5c9a'), (np.mgrid[0:256, 0:256][0] < 60)[..., None] * 0.8)
    put('kiosk_panel', (a, hh, ro, me))
    for i, n in enumerate([k for k in REG if k not in ('car_body', 'bus_body', 'mosaic', 'crater', 'kiosk_sign', 'busstop_sign', 'kiosk_panel')]):
        put(n, swatch(n, _shape(REG[n]), 100 + i))
    ao = cavity_ao(hgt, 3, 0.3, wrap=False)
    alb = alb * bake_shade(hgt, 0.5, 0.15, wrap=False)
    paths = [os.path.join(CACHE, f'props_atlas_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    Image.fromarray(to8(alb)).save(paths[0], quality=90, optimize=True)
    nrm = to8(blur(normal_from_height(hgt, 1.0, wrap=False).astype(np.float32) / 255, 0.5, wrap=False))
    Image.fromarray(quantize_normal(nrm, 6)).save(paths[1], optimize=True, compress_level=9)
    Image.fromarray(quantize_normal(to8(np.stack([ao, rough, metal], -1)), 6)).save(paths[2], optimize=True, compress_level=9)
    return paths


if __name__ == '__main__':
    print(build())
