"""Courtyard regions of the modern atlas (row 10 of modern_atlas.GRID): HPL playground panels, sandbox sand, rubber
safety tiles (green / terracotta), garage gates (painted swing gate | galvanised roll-up), roofing felt, and a
'yard_misc' sheet of small parts (swing seats, route sign, timetable, padlock, garage numbers, spring coil, rules
board, bin bag, HPL edge colours, bus-stop citylight, kiosk AC front, bench slat, chain).
paint(name, shape, seed) -> (albedo, height, rough, metal) like modern_atlas.paint; HPL / YARD give sub-rects.
"""
import numpy as np
from PIL import Image, ImageDraw
from texlib import spectral, norm01, colorize, srgb, lerp, smoothstep, blur, rng, stamp_disc
import modern_market_atlas as MKA

NAMES = {'pg_hpl', 'pg_sand', 'pg_mat', 'pg_mat2', 'gar_door', 'roof_felt', 'yard_misc'}
HPL_COLS = {'orange': (232, 116, 42), 'lime': (140, 198, 63), 'blue': (42, 127, 196), 'yellow': (242, 194, 48),
            'purple': (138, 79, 168), 'red': (216, 56, 46), 'teal': (30, 160, 150), 'green': (46, 140, 70)}
# pg_hpl: 4 x 2 panel designs (s0, t0, s1, t1); row 0 (top) / row 1
_HPL = ['porthole', 'tictac', 'flowers', 'wheel', 'abc', 'holds', 'circles', 'stripes']
HPL = {k: ((i % 4) / 4 + 0.004, 0.5 - (i // 4) * 0.5 + 0.008, (i % 4 + 1) / 4 - 0.004, 1 - (i // 4) * 0.5 - 0.008) for i, k in enumerate(_HPL)}
_P = 232.0
_YARD_PX = {
    'seat': (0, 0, 58, 29), 'cradle': (58, 0, 116, 29), 'route': (116, 0, 145, 29), 'timetable': (145, 0, 174, 58),
    'padlock': (174, 0, 203, 29), 'num': (203, 0, 232, 29), 'spring': (0, 29, 58, 58), 'rules': (58, 29, 116, 87),
    'bag': (116, 29, 145, 58), 'chain': (174, 29, 232, 58),
    'e_orange': (0, 58, 14, 87), 'e_lime': (14, 58, 29, 87), 'e_blue': (29, 58, 43, 87), 'e_yellow': (43, 58, 58, 87),
    'citylight': (116, 58, 174, 145), 'ac': (174, 58, 232, 116), 'slat': (0, 87, 116, 101), 'slat_g': (0, 101, 116, 116),
    'kiosk_sign': (0, 116, 116, 145), 'shutter_box': (174, 116, 232, 145), 'ash_bin': (0, 145, 29, 174),
    'grass_edge': (29, 145, 116, 174), 'rust': (116, 145, 174, 174), 'tile': (174, 145, 232, 174),
    'notice': (0, 174, 58, 232), 'bars': (58, 174, 116, 232), 'graffiti': (116, 174, 232, 232)}
YARD = {k: MKA._norm(v) for k, v in _YARD_PX.items()}


def _arr(img):
    return np.asarray(img.convert('RGB')).astype(np.float32) / 255


def paint(name, shape, seed):
    h, w = shape; r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.3, seed, fmin=2, fmax=60, shape=shape)
    f = spectral(0, 0.5, seed + 1, fmin=30, shape=shape)
    rough = np.full(shape, 0.8, np.float32); metal = np.zeros(shape, np.float32); hgt = f * 0.2
    if name == 'pg_hpl':
        alb, hgt, rough = _hpl(shape, seed)
    elif name == 'pg_sand':
        grain = r.random(shape).astype(np.float32)
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#a8916a'), (1, '#c8b086')]) * (0.9 + 0.2 * grain)[..., None]
        prints = np.zeros(shape, np.float32)
        for k in range(14):
            stamp_disc(prints, r.uniform(0, w), r.uniform(0, h), r.uniform(4, 9), 1, 3, wrap=True)
        alb = lerp(alb, srgb('#8d7756'), prints[..., None] * 0.35)
        alb = lerp(alb, srgb('#6b6a4a'), smoothstep(1.0, 2.0, spectral(0, 1.6, seed + 3, fmin=2, fmax=20, shape=shape))[..., None] * 0.2)
        hgt = grain * 0.5 - prints * 1.5 + n * 0.5; rough[:] = 0.95
    elif name in ('pg_mat', 'pg_mat2'):
        # 0.5 m rubber-crumb safety tiles, region 2 x 2 m (4 x 4 tiles)
        tp = w / 4
        lx, ly = xx % tp, yy % tp
        joint = ((lx < 1.5) | (ly < 1.5)).astype(np.float32)
        ti = (xx // tp).astype(int) + 4 * (yy // tp).astype(int)
        crumb = r.random(shape).astype(np.float32)
        if name == 'pg_mat':
            base = np.zeros(shape + (3,), np.float32) + srgb('#3f7a46')
            tv = 1 + rng(seed + 9).uniform(-0.06, 0.06, 16)
            base = base * tv[ti][..., None]
        else:
            base = np.zeros(shape + (3,), np.float32) + srgb('#9a4a38')
            base[ti % 7 == 3] = srgb('#8a4232')
        alb = base * (0.78 + 0.32 * crumb)[..., None]
        alb = lerp(alb, srgb('#1e1e1c'), joint[..., None] * 0.7)
        alb = lerp(alb, srgb('#6a665a'), smoothstep(0.8, 1.9, n)[..., None] * 0.25)
        hgt = crumb * 0.5 - joint * 2; rough[:] = 0.95
    elif name == 'gar_door':
        alb, hgt, rough, metal = _gar(shape, seed)
    elif name == 'roof_felt':
        strip = (np.abs((yy % (h / 2)) - 2) < 2.5).astype(np.float32)
        alb = colorize(norm01(f * 0.6 + n * 0.4), [(0, '#2a2725'), (1, '#3c3733')])
        alb = lerp(alb, srgb('#5e5a52'), (r.random(shape) > 0.93)[..., None] * 0.35)     # sand dressing
        alb = lerp(alb, srgb('#151413'), strip[..., None] * 0.7)
        for k in range(4):     # bitumen patches
            x0, y0 = r.uniform(0, w - 60), r.uniform(0, h - 50); pw, ph = r.uniform(30, 70), r.uniform(25, 50)
            m = ((xx > x0) & (xx < x0 + pw) & (yy > y0) & (yy < y0 + ph)).astype(np.float32)
            alb = lerp(alb, srgb('#161514'), m[..., None] * 0.8); hgt = hgt + m * 0.8
        moss = smoothstep(1.0, 1.9, spectral(0, 1.8, seed + 5, fmin=2, fmax=30, shape=shape))
        alb = lerp(alb, srgb('#4a5530'), moss[..., None] * 0.45)
        alb = lerp(alb, srgb('#6a5a46'), smoothstep(0.9, 1.9, n)[..., None] * 0.2)
        hgt = hgt + strip * 1.5; rough[:] = 0.9
    elif name == 'yard_misc':
        alb, hgt, rough, metal = _yard(shape, seed)
    else:
        raise KeyError(name)
    return alb.astype(np.float32), np.asarray(hgt, np.float32), np.clip(rough, 0, 1).astype(np.float32), \
        np.asarray(metal, np.float32) + np.zeros(shape, np.float32)


def _hpl(shape, seed):
    h, w = shape; ss = 3; W, H = w * ss, h * ss
    img = Image.new('RGB', (W, H), (200, 200, 200)); d = MKA._D(img)
    hm = Image.new('L', (W, H), 128); dh = MKA._D(hm)
    cols = ['orange', 'lime', 'blue', 'yellow', 'purple', 'red', 'teal', 'green']
    r = rng(seed)
    for i, k in enumerate(_HPL):
        cx0 = (i % 4) * W / 4; cy0 = (i // 4) * H / 2; cw, ch = W / 4, H / 2
        X = lambda s: cx0 + s * cw
        Y = lambda t: cy0 + t * ch
        c = HPL_COLS[cols[i]]
        d.rectangle([X(0), Y(0), X(1), Y(1)], fill=c)
        d.rectangle([X(0), Y(0), X(1), Y(1)], outline=tuple(int(v * 0.7) for v in c), width=ss * 3)
        dark = (34, 30, 28)
        if k == 'porthole':
            d.ellipse([X(0.2), Y(0.2), X(0.8), Y(0.8)], fill=dark); dh.ellipse([X(0.2), Y(0.2), X(0.8), Y(0.8)], fill=40)
            d.ellipse([X(0.17), Y(0.17), X(0.83), Y(0.83)], outline=(250, 250, 245), width=ss * 3)
        elif k == 'tictac':
            for a in range(3):
                for b in range(3):
                    x0, y0 = X(0.15 + a * 0.24), Y(0.15 + b * 0.24)
                    d.rectangle([x0, y0, x0 + cw * 0.2, y0 + ch * 0.2], fill=(245, 245, 240))
                    if (a + b) % 2:
                        d.line([x0 + 6, y0 + 6, x0 + cw * 0.2 - 6, y0 + ch * 0.2 - 6], fill=(216, 56, 46), width=ss * 3)
                        d.line([x0 + cw * 0.2 - 6, y0 + 6, x0 + 6, y0 + ch * 0.2 - 6], fill=(216, 56, 46), width=ss * 3)
                    else:
                        d.ellipse([x0 + 6, y0 + 6, x0 + cw * 0.2 - 6, y0 + ch * 0.2 - 6], outline=(42, 127, 196), width=ss * 3)
        elif k == 'flowers':
            for q in range(5):
                fx, fy = X(r.uniform(0.15, 0.85)), Y(r.uniform(0.2, 0.85)); rr = cw * r.uniform(0.06, 0.1)
                pc = [(242, 194, 48), (250, 250, 245), (216, 56, 46)][q % 3]
                for a in range(6):
                    ang = a / 6 * 2 * np.pi
                    d.ellipse([fx + np.cos(ang) * rr - rr * 0.6, fy + np.sin(ang) * rr - rr * 0.6, fx + np.cos(ang) * rr + rr * 0.6, fy + np.sin(ang) * rr + rr * 0.6], fill=pc)
                d.ellipse([fx - rr * 0.5, fy - rr * 0.5, fx + rr * 0.5, fy + rr * 0.5], fill=(140, 80, 30))
        elif k == 'wheel':
            d.ellipse([X(0.25), Y(0.22), X(0.75), Y(0.72)], outline=dark, width=ss * 7)
            d.line([X(0.5), Y(0.22), X(0.5), Y(0.72)], fill=dark, width=ss * 5); d.line([X(0.25), Y(0.47), X(0.75), Y(0.47)], fill=dark, width=ss * 5)
            d.ellipse([X(0.44), Y(0.41), X(0.56), Y(0.53)], fill=(216, 56, 46))
            dh.ellipse([X(0.25), Y(0.22), X(0.75), Y(0.72)], outline=230, width=ss * 7)
        elif k == 'abc':
            from PIL import ImageFont
            fnt = ImageFont.truetype(MKA.FONT_B, int(ch * 0.32))
            for q, (t, cc) in enumerate((('А', (216, 56, 46)), ('Б', (42, 127, 196)), ('В', (46, 140, 70)))):
                d.text((X(0.2 + q * 0.3), Y(0.45 + (q % 2) * 0.12)), t, fill=cc, font=fnt, anchor='mm')
        elif k == 'holds':
            for q in range(14):
                hx, hy = X(r.uniform(0.1, 0.9)), Y(r.uniform(0.08, 0.92)); rr = cw * r.uniform(0.035, 0.06)
                hc = [(216, 56, 46), (242, 194, 48), (42, 127, 196), (46, 140, 70)][q % 4]
                d.ellipse([hx - rr, hy - rr * 0.8, hx + rr, hy + rr * 0.8], fill=hc); dh.ellipse([hx - rr, hy - rr * 0.8, hx + rr, hy + rr * 0.8], fill=230)
        elif k == 'circles':
            for a in range(3):
                for b in range(2):
                    x0, y0 = X(0.12 + a * 0.28), Y(0.2 + b * 0.36)
                    d.ellipse([x0, y0, x0 + cw * 0.2, y0 + ch * 0.25], fill=dark); dh.ellipse([x0, y0, x0 + cw * 0.2, y0 + ch * 0.25], fill=40)
        elif k == 'stripes':
            for q in range(5):
                d.rectangle([X(0), Y(q / 5), X(1), Y(q / 5 + 0.1)], fill=(245, 245, 240))
    img = img.resize((w, h), Image.LANCZOS); alb = _arr(img)
    n = spectral(0, 1.3, seed + 4, fmin=2, fmax=40, shape=shape)
    alb = lerp(alb, srgb('#7a7468'), smoothstep(0.9, 1.9, n)[..., None] * 0.15)
    hgt = (np.asarray(hm.resize((w, h), Image.LANCZOS), np.float32) / 255 - 0.5) * 3
    return alb, hgt, np.full(shape, 0.45, np.float32)


def _gar(shape, seed):
    """Left half: old painted swing double gate (brown, rust, wicket, hasp + padlock, number); right half: galvanised
    roll-up door with ribs and bottom lock."""
    h, w = shape; r = rng(seed); hw = w // 2
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.4, seed, fmin=2, fmax=40, shape=shape)
    rust = smoothstep(0.6, 1.8, spectral(0, 1.5, seed + 2, fmin=3, fmax=60, shape=shape))
    paint = colorize(norm01(spectral(0, 0.6, seed + 1, fmin=20, shape=shape)), [(0, '#5a3626'), (1, '#6c4230')])
    rustc = colorize(norm01(n), [(0, '#4a2a18'), (0.6, '#7a4524'), (1, '#9a6038')])
    left = lerp(paint, rustc, (rust * (0.5 + 0.5 * smoothstep(h * 0.4, h, yy)))[..., None] * 0.85)
    ribs = 0.5 + 0.5 * np.sin(yy / h * 2 * np.pi * 26)
    galv = colorize(norm01(spectral(0, 0.6, seed + 3, fmin=20, shape=shape)), [(0, '#8a8f90'), (1, '#a5aaab')]) * (0.82 + 0.25 * ribs)[..., None]
    galv = lerp(galv, srgb('#6d6250'), smoothstep(h * 0.75, h, yy)[..., None] * 0.4)
    alb = np.where((xx < hw)[..., None], left, galv)
    img = Image.fromarray((np.clip(alb, 0, 1) * 255).astype(np.uint8)); d = MKA._D(img)
    d.line([hw / 2, 0, hw / 2, h], fill=(30, 22, 18), width=3)
    d.rectangle([hw * 0.56, h * 0.28, hw * 0.92, h * 0.97], outline=(40, 28, 20), width=2)      # wicket
    d.rectangle([hw * 0.44, h * 0.5, hw * 0.56, h * 0.54], fill=(40, 40, 40))                  # hasp
    d.rectangle([hw * 0.47, h * 0.54, hw * 0.53, h * 0.6], fill=(150, 130, 60))                 # padlock
    for y in (0.12, 0.88):
        for x in (0.02, 0.98):
            d.rectangle([hw * x - 3, h * y - 6, hw * x + 3, h * y + 6], fill=(50, 40, 34))         # hinges
    d.ellipse([hw * 0.1, h * 0.06, hw * 0.3, h * 0.2], fill=(235, 232, 220))
    d.text((hw * 0.2, h * 0.13), str(17 + seed % 30), fill=(30, 30, 30), font=MKA._f(14), anchor='mm')
    d.rectangle([hw + 2, h - 10, w - 2, h - 2], fill=(150, 154, 154)); d.rectangle([hw + hw / 2 - 5, h - 18, hw + hw / 2 + 5, h - 8], fill=(40, 40, 40))
    d.rectangle([hw, 0, hw + 5, h], fill=(70, 72, 72)); d.rectangle([w - 5, 0, w, h], fill=(70, 72, 72))
    alb = np.asarray(img, np.float32) / 255
    hgt = np.where(xx < hw, rust * 0.5, ribs * 1.5)
    metal = np.where(xx < hw, 0.2 + rust * 0.2, 0.6); rough = np.where(xx < hw, 0.6 + rust * 0.3, 0.45)
    return alb, hgt, rough, metal


def _yard(shape, seed):
    h, w = shape; ss = 4; W, H = w * ss, h * ss
    img = Image.new('RGB', (W, H), (90, 90, 90)); d = MKA._D(img)
    hm = Image.new('L', (W, H), 128); dh = MKA._D(hm)
    mt = Image.new('L', (W, H), 0); dm = MKA._D(mt)
    rg = Image.new('L', (W, H), 180); dr = MKA._D(rg)
    k = W / _P; r = rng(seed)
    for nm, px in _YARD_PX.items():
        x0, y0, x1, y1 = (v * k for v in px); bw, bh = x1 - x0, y1 - y0
        X = lambda s: x0 + s * bw
        Y = lambda t: y0 + t * bh
        R_ = lambda a, b, c, e: [X(a), Y(b), X(c), Y(e)]
        if nm == 'seat':
            d.rectangle(R_(0, 0, 1, 1), fill=(26, 26, 26)); d.rectangle(R_(0.03, 0.15, 0.97, 0.85), fill=(38, 38, 38))
            for q in range(8):
                d.line([X(0.08 + q * 0.12), Y(0.25), X(0.08 + q * 0.12), Y(0.75)], fill=(20, 20, 20), width=int(k))
            dr.rectangle(R_(0, 0, 1, 1), fill=220)
        elif nm == 'cradle':
            d.rectangle(R_(0, 0, 1, 1), fill=(216, 56, 46)); d.rectangle(R_(0.2, 0.3, 0.4, 0.9), fill=(30, 30, 30)); d.rectangle(R_(0.6, 0.3, 0.8, 0.9), fill=(30, 30, 30))
        elif nm == 'route':
            d.rectangle(R_(0, 0, 1, 1), fill=(24, 84, 170)); d.rectangle(R_(0.1, 0.1, 0.9, 0.9), outline=(250, 250, 250), width=int(k))
            MKA._text_fit(d, R_(0.15, 0.15, 0.85, 0.85), 'А', (255, 255, 255))
        elif nm == 'timetable':
            d.rectangle(R_(0, 0, 1, 1), fill=(240, 240, 236)); d.rectangle(R_(0, 0, 1, 0.15), fill=(24, 84, 170))
            for q in range(10):
                d.line([X(0.1), Y(0.22 + q * 0.07), X(0.9 - (q % 3) * 0.15), Y(0.22 + q * 0.07)], fill=(60, 60, 60), width=int(k))
        elif nm == 'padlock':
            d.rectangle(R_(0, 0, 1, 1), fill=(60, 60, 58)); d.rectangle(R_(0.2, 0.4, 0.8, 0.95), fill=(170, 150, 70)); d.arc(R_(0.3, 0.05, 0.7, 0.6), 180, 360, fill=(170, 172, 170), width=int(k * 1.5))
            dm.rectangle(R_(0, 0, 1, 1), fill=200)
        elif nm == 'num':
            d.rectangle(R_(0, 0, 1, 1), fill=(236, 234, 224)); MKA._text_fit(d, R_(0.1, 0.1, 0.9, 0.9), '24', (30, 30, 30))
        elif nm == 'spring':
            d.rectangle(R_(0, 0, 1, 1), fill=(40, 42, 44))
            for q in range(10):
                d.rectangle(R_(0, q / 10, 1, q / 10 + 0.05), fill=(150, 154, 156))
            dm.rectangle(R_(0, 0, 1, 1), fill=180)
        elif nm == 'rules':
            d.rectangle(R_(0, 0, 1, 1), fill=(42, 127, 196)); d.rectangle(R_(0.06, 0.06, 0.94, 0.94), fill=(245, 245, 240))
            MKA._text_fit(d, R_(0.1, 0.1, 0.9, 0.24), 'ПРАВИЛА', (42, 127, 196), True)
            for q in range(7):
                d.line([X(0.12), Y(0.32 + q * 0.08), X(0.88 - (q % 2) * 0.2), Y(0.32 + q * 0.08)], fill=(70, 70, 70), width=int(k))
        elif nm == 'bag':
            d.rectangle(R_(0, 0, 1, 1), fill=(22, 22, 24)); d.ellipse(R_(0.2, 0.15, 0.6, 0.5), fill=(60, 62, 66)); dr.rectangle(R_(0, 0, 1, 1), fill=60)
        elif nm == 'chain':
            d.rectangle(R_(0, 0, 1, 1), fill=(60, 62, 64))
            for q in range(12):
                d.ellipse(R_(q / 12, 0.2, q / 12 + 0.11, 0.8), outline=(180, 184, 186), width=int(k * 0.8))
            dm.rectangle(R_(0, 0, 1, 1), fill=220); dr.rectangle(R_(0, 0, 1, 1), fill=100)
        elif nm.startswith('e_'):
            c = HPL_COLS[nm[2:]]; d.rectangle(R_(0, 0, 1, 1), fill=c); dr.rectangle(R_(0, 0, 1, 1), fill=110)
        elif nm == 'citylight':
            d.rectangle(R_(0, 0, 1, 1), fill=(40, 42, 44)); d.rectangle(R_(0.06, 0.04, 0.94, 0.96), fill=(250, 214, 40))
            d.rectangle(R_(0.06, 0.04, 0.94, 0.5), fill=(24, 84, 170))
            MKA._text_fit(d, R_(0.1, 0.12, 0.9, 0.3), 'РАЗОМ', (250, 214, 40))
            MKA._text_fit(d, R_(0.1, 0.56, 0.9, 0.72), 'ДОНОРИ', (24, 84, 170), True)
            MKA._text_fit(d, R_(0.1, 0.76, 0.9, 0.88), 'КРОВІ', (24, 84, 170), True)
            dr.rectangle(R_(0, 0, 1, 1), fill=60)
        elif nm == 'ac':
            d.rectangle(R_(0, 0, 1, 1), fill=(222, 222, 218)); d.ellipse(R_(0.12, 0.1, 0.72, 0.9), fill=(40, 42, 44))
            for q in range(6):
                d.line([X(0.12), Y(0.1 + q * 0.16), X(0.72), Y(0.1 + q * 0.16)], fill=(180, 180, 176), width=int(k * 0.7))
            d.rectangle(R_(0.78, 0.1, 0.92, 0.9), fill=(200, 200, 196))
        elif nm in ('slat', 'slat_g'):
            base = (150, 96, 54) if nm == 'slat' else (70, 120, 70)
            d.rectangle(R_(0, 0, 1, 1), fill=base)
            for q in range(20):
                y = Y(r.uniform(0.1, 0.9)); d.line([X(0), y, X(1), y + r.uniform(-2, 2)], fill=tuple(int(v * r.uniform(0.75, 1.1)) for v in base), width=int(k * 0.6))
            dr.rectangle(R_(0, 0, 1, 1), fill=200)
        elif nm == 'kiosk_sign':
            d.rectangle(R_(0, 0, 1, 1), fill=(250, 250, 246)); d.rectangle(R_(0, 0.82, 1, 1), fill=(30, 150, 70))
            cx, cy, s_ = X(0.1), Y(0.42), bh * 0.25
            d.rectangle([cx - s_ / 3, cy - s_, cx + s_ / 3, cy + s_], fill=(30, 150, 70)); d.rectangle([cx - s_, cy - s_ / 3, cx + s_, cy + s_ / 3], fill=(30, 150, 70))
            MKA._text_fit(d, R_(0.2, 0.12, 0.98, 0.74), 'АПТЕКА', (26, 132, 62))
            dr.rectangle(R_(0, 0, 1, 1), fill=60)
        elif nm == 'shutter_box':
            d.rectangle(R_(0, 0, 1, 1), fill=(200, 202, 200))
            for q in range(8):
                d.line([X(0), Y(q / 8), X(1), Y(q / 8)], fill=(150, 152, 150), width=int(k))
            dm.rectangle(R_(0, 0, 1, 1), fill=150)
        elif nm == 'ash_bin':
            d.rectangle(R_(0, 0, 1, 1), fill=(60, 64, 66)); d.rectangle(R_(0, 0, 1, 0.2), fill=(150, 154, 156))
        elif nm == 'grass_edge':
            d.rectangle(R_(0, 0, 1, 1), fill=(84, 96, 52))
            for q in range(80):
                x = X(r.random()); d.line([x, Y(1), x + r.uniform(-3, 3), Y(r.uniform(0.2, 0.8))], fill=(70 + int(r.uniform(0, 40)), 100 + int(r.uniform(0, 40)), 50), width=int(k * 0.6))
        elif nm == 'rust':
            d.rectangle(R_(0, 0, 1, 1), fill=(110, 62, 34))
            for q in range(40):
                x, y = X(r.random()), Y(r.random()); d.ellipse([x - 4, y - 3, x + 4, y + 3], fill=(140, 84, 44) if q % 2 else (80, 46, 28))
        elif nm == 'tile':
            d.rectangle(R_(0, 0, 1, 1), fill=(120, 118, 112))
            for q in range(4):
                d.line([X(q / 4), Y(0), X(q / 4), Y(1)], fill=(80, 78, 74), width=int(k)); d.line([X(0), Y(q / 4), X(1), Y(q / 4)], fill=(80, 78, 74), width=int(k))
        elif nm == 'notice':
            d.rectangle(R_(0, 0, 1, 1), fill=(200, 196, 180))
            for q in range(6):
                xa, ya = X(r.uniform(0, 0.6)), Y(r.uniform(0, 0.7))
                d.rectangle([xa, ya, xa + bw * 0.35, ya + bh * 0.25], fill=(240, 238, 228))
                for l_ in range(3):
                    d.line([xa + 4, ya + 8 + l_ * 10, xa + bw * 0.3, ya + 8 + l_ * 10], fill=(80, 80, 80), width=int(k * 0.6))
        elif nm == 'bars':
            d.rectangle(R_(0, 0, 1, 1), fill=(36, 36, 38))
            for q in range(7):
                d.rectangle(R_(0.05 + q * 0.14, 0, 0.09 + q * 0.14, 1), fill=(120, 124, 126))
            d.rectangle(R_(0, 0.45, 1, 0.5), fill=(120, 124, 126))
        elif nm == 'graffiti':
            d.rectangle(R_(0, 0, 1, 1), fill=(210, 208, 200))
            for q, (t, c) in enumerate((('ЗСУ', (30, 70, 170)), ('СЛАВА', (40, 40, 40)))):
                MKA._text_fit(d, R_(0.05, 0.1 + q * 0.42, 0.95, 0.48 + q * 0.42), t, c)
    img = img.resize((w, h), Image.LANCZOS)
    alb = _arr(img)
    hgt = (np.asarray(hm.resize((w, h), Image.LANCZOS), np.float32) / 255 - 0.5) * 3
    rough = np.asarray(rg.resize((w, h), Image.LANCZOS), np.float32) / 255
    metal = np.asarray(mt.resize((w, h), Image.LANCZOS), np.float32) / 255
    return alb, hgt, rough, metal
