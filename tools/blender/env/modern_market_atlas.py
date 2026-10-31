"""Supermarket regions of the modern atlas (rows 8+ of the 2048 x 4096 modern_atlas, see modern_atlas.GRID):
two-tone cladding (light-grey horizontal sandwich panels + anthracite ACM cassettes), red ACM fascia (intact / shot-up
halves), aluminium shopfront bays with interior shelving silhouettes, shot-out / OSB-boarded bay, galvanised roller
shutter, light-grey PVC roof membrane, gondola shelving (damaged interior), and two 'misc' sheets of small parts
(ATM, parcel locker, trolleys, exit door, HVAC louvres / fans, smoke-vent dome, lightbox logo, box-letter colours, LED
flood, chequer plate, rubber, cardboard, hazard stripes, sign / shelter / hours boards, vestibule glass + doors,
payment terminal, electrical cabinet, wall louvre, ceiling tile).
paint(name, shape, seed) -> (albedo sRGB float, height, roughness, metal) like modern_atlas.paint.
MISC / MISC2: sub-rects (s0, t0, s1, t1) in normalised region coords (t up) used by modern_market.py.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from texlib import spectral, norm01, colorize, srgb, lerp, smoothstep, blur, rng, stamp_disc
import texlib
import burnt_tex as B

FONT_B = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FONT_C = '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf'
NAMES = {'sm_clad', 'sm_acm', 'sm_fascia', 'sm_glass', 'sm_glass_dmg', 'sm_shutter', 'sm_roof', 'sm_interior', 'sm_misc', 'sm_misc2'}

# misc sheets: pixel boxes on a 232 x 232 painted area (y down) -> normalised sub-rects
_P = 232.0
_MISC_PX = {
    'atm': (0, 0, 58, 116), 'locker': (58, 0, 174, 116), 'trolley': (174, 0, 232, 58), 'door_exit': (174, 58, 232, 116),
    'louvre': (0, 116, 116, 174), 'fan': (116, 116, 174, 174), 'dome': (174, 116, 232, 174),
    'logo': (0, 174, 58, 232), 'letter_face': (58, 174, 87, 203), 'letter_side': (87, 174, 116, 203),
    'flood': (58, 203, 87, 232), 'chequer': (87, 203, 116, 232), 'citylight': (116, 174, 174, 232),
    'hazard': (174, 174, 232, 203), 'rubber': (174, 203, 203, 232), 'cardboard': (203, 203, 232, 232)}
_MISC2_PX = {
    'sign_super': (0, 0, 232, 46), 'hours': (0, 46, 46, 104), 'ukryttya': (46, 46, 116, 75), 'red_cross': (46, 75, 81, 104),
    'mat': (81, 75, 116, 104), 'cond_side': (116, 46, 232, 104), 'vest_glass': (0, 104, 58, 232), 'vest_door': (58, 104, 116, 232),
    'terminal': (116, 104, 145, 162), 'el_cabinet': (145, 104, 174, 162), 'vent': (174, 104, 232, 162),
    'ceiling': (116, 162, 174, 232), 'osb_plain': (174, 162, 232, 232)}


def _norm(px):
    x0, y0, x1, y1 = px
    i = 0.6   # half-texel inset so bilinear lookups stay inside the item
    return ((x0 + i) / _P, 1 - (y1 - i) / _P, (x1 - i) / _P, 1 - (y0 + i) / _P)


MISC = {k: _norm(v) for k, v in _MISC_PX.items()}
MISC2 = {k: _norm(v) for k, v in _MISC2_PX.items()}


class _SDraw(ImageDraw.ImageDraw):
    """ImageDraw accepting boxes with corners in any order."""
    def rectangle(self, xy, *a, **k):
        x0, y0, x1, y1 = [float(v) for v in xy]
        return super().rectangle([min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)], *a, **k)

    def ellipse(self, xy, *a, **k):
        x0, y0, x1, y1 = [float(v) for v in xy]
        return super().ellipse([min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)], *a, **k)


def _D(img):
    return _SDraw(img)


def _arr(img):
    return np.asarray(img.convert('RGB')).astype(np.float32) / 255


def _f(size, cond=False):
    return ImageFont.truetype(FONT_C if cond else FONT_B, max(4, int(size)))


def _text_fit(d, box, text, fill, cond=False, size=None, anchor='mm'):
    x0, y0, x1, y1 = box
    s = size or (y1 - y0)
    f = _f(s, cond)
    while d.textlength(text, font=f) > (x1 - x0) * 0.94 and s > 5:
        s -= 1; f = _f(s, cond)
    d.text(((x0 + x1) / 2, (y0 + y1) / 2), text, fill=fill, font=f, anchor=anchor)


def _grime(shape, seed, k=0.12, col='#5d574c'):
    n = spectral(0, 1.5, seed, fmin=2, fmax=24, shape=shape)
    return smoothstep(0.6, 1.9, n)[..., None] * k, srgb(col)


def paint(name, shape, seed):
    h, w = shape; r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.3, seed, fmin=2, fmax=60, shape=shape)
    f = spectral(0, 0.5, seed + 1, fmin=30, shape=shape)
    rough = np.full(shape, 0.8, np.float32); metal = np.zeros(shape, np.float32); hgt = f * 0.2

    if name == 'sm_clad':
        # light-grey (RAL 7035) horizontal sandwich panels 1 m high, micro-ribbed; region 3 x 3 m, fasteners every 1.5 m
        pw = h / 3.0
        ph = (yy % pw) / pw
        k = (yy // pw).astype(int)
        rib = 0.5 + 0.5 * np.sin(2 * np.pi * yy / (pw / 10))
        joint = (ph < 0.03).astype(np.float32); lip = ((ph >= 0.03) & (ph < 0.06)).astype(np.float32)
        tone = np.array([1.0, 0.975, 1.012])[k % 3]
        alb = colorize(norm01(n * 0.5 + f * 0.5), [(0, '#aeb1ae'), (1, '#bfc2bf')]) * (tone * (0.97 + 0.03 * rib))[..., None]
        alb = lerp(alb, srgb('#4c4f52'), joint[..., None] * 0.85)
        alb = lerp(alb, srgb('#d6d8d4'), lip[..., None] * 0.5)
        alb = lerp(alb, srgb('#8f8d86'), smoothstep(0.82, 1.0, ph)[..., None] * 0.12)     # grime on each panel lip
        streak = np.clip(blur(spectral(0, 1.2, seed + 5, fmin=8, fmax=120, shape=shape), (30, 0.7), True) - 0.5, 0, 1)
        alb = lerp(alb, srgb('#77736a'), streak[..., None] * 0.35)
        fast = np.zeros(shape, np.float32)
        for xf in (w * 0.01, w * 0.51):
            for j in range(3):
                for pf in (0.14, 0.86):
                    stamp_disc(fast, xf + 2, j * pw + pf * pw, 1.1, 1, 0.8, wrap=True)
        alb = lerp(alb, srgb('#55575a'), fast[..., None] * 0.7)
        g, gc = _grime(shape, seed + 7, 0.1); alb = lerp(alb, gc, g)
        hgt = rib * 0.35 - joint * 2.5 + lip * 0.6 - fast; metal[:] = 0.25; rough = 0.5 + 0.1 * norm01(n)

    elif name == 'sm_acm':
        # anthracite (RAL 7016) ACM cassettes 1.5 x 1.0 m with open joints; region 3 x 2 m (2 x 2 cassettes)
        cw, ch = w / 2, h / 2
        lx, ly = xx % cw, yy % ch
        ci = (xx // cw).astype(int) + 2 * (yy // ch).astype(int)
        tone = (1 + r.uniform(-0.05, 0.05, 4))[ci]
        sheen = np.zeros(shape, np.float32)
        for c in range(4):
            g = spectral(0, 3.0, seed + 10 + c, fmin=1, fmax=4, shape=shape)
            sheen += (ci == c) * g * 0.04
        alb = colorize(norm01(f * 0.6 + n * 0.4), [(0, '#4b5054'), (1, '#575c61')]) * (tone + sheen)[..., None]
        joint = ((lx < 3) | (ly < 3)).astype(np.float32)
        fold = (((ly >= 3) & (ly < 5)) | ((lx >= 3) & (lx < 4))).astype(np.float32)
        alb = lerp(alb, srgb('#121315'), joint[..., None] * 0.95)
        alb = lerp(alb, srgb('#6b7074'), fold[..., None] * 0.45)
        streak = np.clip(blur(spectral(0, 1.2, seed + 5, fmin=8, fmax=120, shape=shape), (25, 0.6), True) - 0.7, 0, 1)
        alb = lerp(alb, srgb('#6e6a60'), streak[..., None] * 0.3)
        hgt = -joint * 3 + fold * 0.5 + sheen * 4; metal[:] = 0.45; rough = 0.42 + 0.08 * norm01(n)

    elif name == 'sm_fascia':
        # red (RAL 3020, sun-faded) ACM fascia cassettes, region 3 x 1.5 m per half: top half intact, bottom half shot up
        h2 = h // 2
        alb = np.zeros(shape + (3,), np.float32); hgt = np.zeros(shape, np.float32)
        for half in (0, 1):
            ys = slice(half * h2, (half + 1) * h2 if half == 0 else h)
            sy = yy[ys] - half * h2; sx = xx[ys]; hh = sy.max() + 1
            ci = (sx // (w / 2)).astype(int)
            tone = (1 + np.array([0.02, -0.03]))[ci]
            base = colorize(norm01(n[ys] * 0.4 + f[ys] * 0.6), [(0, '#9c2722'), (1, '#b0302a')]) * tone[..., None]
            base = base * (1.04 - 0.08 * (sy / hh))[..., None]
            joint = (((sx % (w / 2)) < 3) | (sy < 2) | (sy > hh - 3)).astype(np.float32)
            base = lerp(base, srgb('#1c1312'), joint[..., None] * 0.9)
            base = lerp(base, srgb('#7a6a5a'), smoothstep(0.9, 1.9, spectral(0, 1.5, seed + 3 + half, fmin=2, fmax=20, shape=sy.shape))[..., None] * 0.12)
            hh_ = -joint * 2.5
            if half == 1:
                soot = smoothstep(hh * 0.3, hh, sy) * 0.55 + smoothstep(0.4, 1.8, spectral(0, 1.6, seed + 9, fmin=2, fmax=16, shape=sy.shape)) * 0.4
                base = lerp(base, srgb('#141210'), np.clip(soot, 0, 0.9)[..., None])
                mx0 = mx1 = -1
                holes = np.zeros(sy.shape, np.float32); rims = np.zeros(sy.shape, np.float32)
                for k in range(70):
                    cx = r.uniform(0, w); cy = r.uniform(4, hh - 4)
                    if mx0 <= cx < mx1:
                        continue
                    rr = r.uniform(1.0, 2.4) if k < 60 else r.uniform(3, 5)
                    stamp_disc(rims, cx, cy, rr + 1.6, 1, 1.0, wrap=True)
                    stamp_disc(holes, cx, cy, rr, 1, 0.7, wrap=True)
                base = lerp(base, srgb('#c8c6c0'), (rims * (1 - holes))[..., None] * 0.75)
                base = lerp(base, srgb('#0b0a0a'), holes[..., None])
                hh_ = hh_ - holes * 2 + rims * 0.5
            alb[ys] = base; hgt[ys] = hh_
        metal[:] = 0.35; rough[:] = 0.45

    elif name == 'sm_glass':
        alb = _shop_glass(shape, seed)
        rim = np.zeros(shape, np.float32)
        bw = w / 4
        rim[(xx % bw < 2) | (xx % bw > bw - 3) | (yy < 2) | (yy > h - 3)] = 1
        alb = lerp(alb, srgb('#16181a'), rim[..., None])
        hgt = rim * 1.0; rough = 0.08 + rim * 0.5; metal[:] = 0.1

    elif name == 'sm_glass_dmg':
        hw = w // 2
        alb = np.zeros(shape + (3,), np.float32)
        # left: shot-out bay -- jagged shard rim round the frame, charred interior beyond
        L = (slice(None), slice(0, hw))
        sh = (h, hw)
        dark = colorize(norm01(spectral(0, 1.4, seed + 2, fmin=2, fmax=40, shape=sh)), [(0, '#0a0a09'), (1, '#24221f')])
        img = Image.new('L', (hw * 2, h * 2), 0); d = _D(img)
        sil = Image.new('L', (hw * 2, h * 2), 0); ds = _D(sil)
        for k in range(5):     # shelf silhouettes in the dark
            y = h * 2 * (0.55 + 0.08 * k)
            ds.line([(0, y), (hw * 2, y - 6)], fill=140, width=3)
        ds.rectangle([hw * 0.4, h * 1.0, hw * 0.9, h * 2], fill=60)
        pts = []
        cx, cy = hw, h
        for k in range(40):
            a = k / 40 * 2 * np.pi
            ex = abs(np.cos(a)) * hw * 2 / 2; ey = abs(np.sin(a)) * h * 2 / 2
            # distance to the frame along the ray, minus a jagged shard margin
            t = min((hw - 4) / max(1e-3, abs(np.cos(a))), (h - 4) / max(1e-3, abs(np.sin(a))))
            t -= r.uniform(4, 30) * (1.0 if r.random() < 0.7 else 2.2)
            pts.append((cx + np.cos(a) * t, cy + np.sin(a) * t))
        d.polygon(pts, fill=255)
        hole = np.asarray(img.resize((hw, h), Image.LANCZOS), np.float32) / 255
        silm = np.asarray(sil.resize((hw, h), Image.LANCZOS), np.float32) / 255
        glass = colorize(norm01(spectral(0, 1.4, seed + 3, fmin=2, fmax=40, shape=sh)), [(0, '#3d4a4c'), (1, '#68787a')])
        cr = texlib.random_walk_cracks(sh, 26, seed + 4, length=(15, 60), width=0.9, wrap=False)
        glass = lerp(glass, srgb('#d5dcdc'), cr[..., None] * 0.7)
        inside = lerp(dark, srgb('#3a3732'), silm[..., None] * 0.6)
        left = lerp(glass, inside, hole[..., None])
        left = lerp(left, srgb('#0d0c0b'), smoothstep(h * 0.6, 0, yy[:, :hw])[..., None] * 0.35)
        alb[:, :hw] = left
        hgt[:, :hw] = (1 - hole) * 1.0 + cr * 0.4; rough[:, :hw] = 0.95 * hole + 0.15 * (1 - hole)
        # right: OSB board-up (2 sheets, seam at 2.5 m of 3.15) with screws + spray-painted 'ПРАЦЮЄМО'
        sw = w - hw; sh2 = (h, sw)
        alb[:, hw:], hgt[:, hw:] = _osb(sh2, seed + 6, text='ПРАЦЮЄМО', seam=1 - 2.5 / 3.15)
        rough[:, hw:] = 0.85

    elif name == 'sm_shutter':
        # galvanised roller shutter 3.0 x 3.0 m: 77 mm slats, side guides, bottom bar + rubber, lock, stencil
        sl = h / 39.0
        p = (yy % sl) / sl
        prof = np.where(p < 0.15, 0.4, np.where(p < 0.55, 1.0, np.where(p < 0.85, 0.75, 0.15)))
        base = colorize(norm01(f * 0.5 + n * 0.5), [(0, '#8e9393'), (1, '#a9adac')])
        alb = base * (0.82 + 0.22 * prof)[..., None]
        streak = np.clip(blur(spectral(0, 1.2, seed + 5, fmin=8, fmax=120, shape=shape), (25, 0.6), True) - 0.5, 0, 1)
        alb = lerp(alb, srgb('#6f6a60'), streak[..., None] * 0.35)
        alb = lerp(alb, srgb('#5e5446'), smoothstep(h * 0.7, h, yy)[..., None] * 0.35)
        guide = ((xx < 8) | (xx > w - 9)).astype(np.float32)
        alb = lerp(alb, srgb('#55595b'), guide[..., None])
        bar = (yy > h - 11).astype(np.float32); rub = (yy > h - 4).astype(np.float32)
        alb = lerp(alb, srgb('#b6b9b8'), bar[..., None]); alb = lerp(alb, srgb('#141414'), rub[..., None])
        img = Image.fromarray((np.clip(alb, 0, 1) * 255).astype(np.uint8)); d = _D(img)
        d.rectangle([w / 2 - 6, h - 30, w / 2 + 6, h - 14], fill=(40, 40, 40))
        d.rectangle([w * 0.25, h - 22, w * 0.34, h - 17], fill=(60, 62, 62)); d.rectangle([w * 0.66, h - 22, w * 0.75, h - 17], fill=(60, 62, 62))
        d.text((w / 2, h * 0.52), 'НЕ ЗАСТАВЛЯТИ', fill=(170, 40, 34), font=_f(14, True), anchor='mm')
        alb = _arr(img)
        rust = smoothstep(1.3, 2.0, spectral(0, 1.2, seed + 8, fmin=6, fmax=80, shape=shape)) * smoothstep(h * 0.5, h, yy)
        alb = lerp(alb, srgb('#6e4126'), rust[..., None] * 0.6)
        hgt = prof * 1.5 - guide + bar; metal[:] = 0.6; rough = 0.45 + rust * 0.4

    elif name == 'sm_roof':
        # light-grey PVC membrane 4 x 4 m, sheets 2 m wide (welded seams along U), ponding stains, repair patches
        alb = colorize(norm01(f * 0.5 + n * 0.5), [(0, '#7a7e7d'), (1, '#8d9190')])
        sp = h / 2
        ps = yy % sp
        seam = ((ps > 2) & (ps < 7)).astype(np.float32); edge = ((ps >= 7) & (ps < 8.5)).astype(np.float32)
        alb = lerp(alb, srgb('#a9acaa'), seam[..., None] * 0.6); alb = lerp(alb, srgb('#4a4d4c'), edge[..., None] * 0.7)
        pond = spectral(0, 2.6, seed + 4, fmin=1, fmax=6, shape=shape)
        ring = np.exp(-((pond - 1.1) / 0.12) ** 2)
        alb = lerp(alb, srgb('#6e6a5e'), (smoothstep(1.1, 1.8, pond) * 0.25 + ring * 0.3)[..., None])
        for k in range(3):
            x0, y0 = r.uniform(0, w - 30), r.uniform(0, h - 30); s = r.uniform(14, 28)
            m = ((xx > x0) & (xx < x0 + s) & (yy > y0) & (yy < y0 + s * 0.8)).astype(np.float32)
            alb = lerp(alb, srgb('#a9acaa'), m[..., None] * 0.6)
            hgt = hgt + m * 0.6
        dirt = smoothstep(0.7, 1.9, spectral(0, 1.4, seed + 6, fmin=3, fmax=40, shape=shape))
        alb = lerp(alb, srgb('#5a554a'), dirt[..., None] * 0.28)
        hgt = hgt + seam * 1.2 - edge; rough[:] = 0.72

    elif name == 'sm_interior':
        # gondola shelving 2 x 2 m: pegboard back, 5 shelves with product packs (some shelves stripped)
        alb = np.zeros(shape + (3,), np.float32) + srgb('#5a5c5e')
        img = Image.fromarray((alb * 255).astype(np.uint8)); d = _D(img)
        pal = [(196, 56, 46), (230, 196, 70), (60, 120, 180), (235, 235, 228), (80, 150, 80), (210, 120, 50), (150, 60, 120), (40, 40, 44), (190, 170, 130)]
        levels = 5; top = h * 0.07; bot = h * 0.93; lh = (bot - top) / levels
        d.rectangle([0, 0, w, top], fill=(150, 152, 150))
        d.text((w * 0.5, top / 2), '₴ 39.90   ₴ 54.50', fill=(200, 40, 30), font=_f(top * 0.7, True), anchor='mm')
        for lv in range(levels):
            y1 = top + lh * (lv + 1); y0 = y1 - lh
            x = 2
            empty = r.random() < 0.18
            while x < w - 2:
                pw = r.uniform(6, 22)
                ph = lh * r.uniform(0.45, 0.85)
                if not empty or r.random() < 0.15:
                    c = pal[r.integers(len(pal))]
                    k = r.uniform(0.75, 1.0)
                    cc = tuple(int(v * k) for v in c)
                    nrep = int(r.integers(1, 4))
                    for q in range(nrep):
                        xa = x + q * pw / nrep
                        d.rectangle([xa + 0.5, y1 - ph, xa + pw / nrep - 0.5, y1 - 4], fill=cc)
                        d.rectangle([xa + 0.5, y1 - ph, xa + pw / nrep - 0.5, y1 - ph + 2], fill=tuple(min(255, v + 40) for v in cc))
                x += pw + r.uniform(0.5, 2)
            d.rectangle([0, y1 - 4, w, y1], fill=(196, 198, 196))
            d.rectangle([0, y1 - 1, w, y1], fill=(90, 90, 90))
        d.rectangle([0, bot, w, h], fill=(70, 72, 74))
        alb = _arr(img)
        alb = lerp(alb, srgb('#3a3834'), smoothstep(0.8, 1.8, n)[..., None] * 0.2)
        hgt = norm01(alb.mean(-1)) * 1.5; rough[:] = 0.6

    elif name in ('sm_misc', 'sm_misc2'):
        alb, hgt, rough, metal = _misc(name, shape, seed)
    else:
        raise KeyError(name)
    return alb.astype(np.float32), np.asarray(hgt, np.float32), np.clip(rough, 0, 1).astype(np.float32), \
        np.asarray(metal, np.float32) + np.zeros(shape, np.float32)


def _osb(shape, seed, text=None, seam=None, soot=0.0):
    h, w = shape; r = rng(seed)
    flake = blur(r.random((h, w)).astype(np.float32), (0.6, 2.2), True)
    big = spectral(0, 0.9, seed + 1, fmin=10, fmax=120, shape=shape)
    alb = colorize(norm01(flake * 0.6 + norm01(big) * 0.4), [(0, '#7d5f38'), (0.45, '#a8834f'), (1, '#c9a46a')])
    alb = lerp(alb, srgb('#5e4a32'), smoothstep(0.9, 1.9, spectral(0, 1.4, seed + 2, fmin=2, fmax=20, shape=shape))[..., None] * 0.35)
    img = Image.fromarray((np.clip(alb, 0, 1) * 255).astype(np.uint8)); d = _D(img)
    if seam is not None:
        y = int(h * seam); d.line([(0, y), (w, y)], fill=(70, 52, 34), width=2)
    for yv in np.arange(6, h, 18):
        for xv in (4, w - 5):
            d.ellipse([xv - 1, yv - 1, xv + 1, yv + 1], fill=(60, 60, 58))
    if text:
        t = Image.new('L', (h, w), 0); dt = _D(t)
        _text_fit(dt, (h * 0.06, w * 0.1, h * 0.94, w * 0.9), text, 255, size=w * 0.5)
        t = t.rotate(90, expand=True).filter(__import__('PIL.ImageFilter', fromlist=['x']).GaussianBlur(0.8))
        m = np.asarray(t, np.float32) / 255
        a = _arr(img); a = lerp(a, srgb('#151515'), m[..., None] * 0.9)
        return a, norm01(flake) * 0.6
    return _arr(img), norm01(flake) * 0.6


def _shop_glass(shape, seed):
    """Four 1.5 x 3.15 m storefront bays seen from outside: store interior (LED ceiling, category boards, gondolas
    with product rows, checkout, fridges, promo poster + blast tape) under a dark glass tint with sky reflection."""
    h, w = shape; r = rng(seed)
    ss = 3; W, H = w * ss, h * ss
    img = Image.new('RGB', (W, H), (120, 122, 120)); d = _D(img)
    bw = W / 4
    pal = [(196, 56, 46), (230, 196, 70), (60, 120, 180), (235, 235, 228), (80, 150, 80), (210, 120, 50), (150, 60, 120), (190, 170, 130)]
    my = lambda m: H * (1 - m / 3.15)        # metres above the bay bottom (0.45 m above ground) -> px
    for b in range(4):
        x0 = b * bw; x1 = x0 + bw
        # ceiling + LED strips, back wall
        d.rectangle([x0, 0, x1, my(1.9)], fill=(150, 152, 150))
        d.rectangle([x0, 0, x1, my(2.85)], fill=(178, 180, 178))
        for k, yv in enumerate((3.05, 2.95, 2.88)):
            d.rectangle([x0 + bw * 0.05 + k * 6, my(yv) - 3, x1 - bw * 0.05 - k * 6, my(yv) + 3], fill=(250, 252, 248))
        # floor
        d.rectangle([x0, my(-0.45 + 0.35), x1, H], fill=(176, 170, 158))
        if b == 0:      # aisle: two gondola end caps, aisle between receding
            d.polygon([(x0 + bw * 0.38, my(0.0)), (x0 + bw * 0.62, my(0.0)), (x0 + bw * 0.56, my(1.0)), (x0 + bw * 0.44, my(1.0))], fill=(196, 190, 178))
            for (a, c) in ((x0 + 3, x0 + bw * 0.38), (x0 + bw * 0.62, x1 - 3)):
                _gondola(d, a, my(1.55), c, my(-0.1), r, pal)
            d.rectangle([x0 + bw * 0.3, my(2.45), x0 + bw * 0.7, my(2.15)], fill=(40, 120, 60))
            d.text((x0 + bw * 0.5, my(2.3)), 'ОВОЧІ', fill=(250, 250, 240), font=_f(bw * 0.09), anchor='mm')
        elif b == 1:    # checkout: counter, lit lane number, shelves behind
            _gondola(d, x0 + 3, my(1.7), x1 - 3, my(0.4), r, pal)
            d.rectangle([x0 + bw * 0.1, my(0.55), x0 + bw * 0.9, my(-0.1)], fill=(54, 56, 60))
            d.rectangle([x0 + bw * 0.1, my(0.6), x0 + bw * 0.9, my(0.52)], fill=(150, 152, 156))
            d.rectangle([x0 + bw * 0.62, my(1.1), x0 + bw * 0.8, my(0.65)], fill=(30, 32, 36))
            d.rectangle([x0 + bw * 0.18, my(2.2), x0 + bw * 0.42, my(1.85)], fill=(200, 40, 34))
            d.text((x0 + bw * 0.3, my(2.02)), '3', fill=(255, 255, 255), font=_f(bw * 0.12), anchor='mm')
        elif b == 2:    # promo poster pasted on the glass + blast tape
            _gondola(d, x0 + 3, my(1.6), x1 - 3, my(-0.1), r, pal)
            d.rectangle([x0 + bw * 0.08, my(2.35), x1 - bw * 0.08, my(0.7)], fill=(250, 214, 40))
            d.text((x0 + bw * 0.5, my(2.05)), 'АКЦІЯ', fill=(200, 30, 30), font=_f(bw * 0.16), anchor='mm')
            d.text((x0 + bw * 0.5, my(1.35)), '-30%', fill=(200, 30, 30), font=_f(bw * 0.26), anchor='mm')
        else:           # fridges: lit glass doors, dairy
            for k in range(2):
                a = x0 + 4 + k * (bw - 8) / 2; c = a + (bw - 8) / 2 - 3
                d.rectangle([a, my(2.05), c, my(-0.1)], fill=(214, 226, 232))
                for lv in range(5):
                    yv = my(0.1 + lv * 0.38)
                    for q in range(5):
                        cc = pal[(lv * 3 + q + k) % len(pal)]
                        d.rectangle([a + 3 + q * (c - a - 6) / 5, yv - 14, a + (q + 0.8) * (c - a - 6) / 5, yv], fill=cc)
                d.rectangle([a, my(2.05), c, my(1.85)], fill=(40, 90, 160))
    # blast tape on bay 2 (paper tape asterisk)
    t = Image.new('L', (W, H), 0); dt = _D(t)
    a, c = 2 * bw + 6, 3 * bw - 6
    for (p, q) in (((a, 6), (c, H - 6)), ((c, 6), (a, H - 6)), (((a + c) / 2, 6), ((a + c) / 2, H - 6))):
        dt.line([p, q], fill=255, width=ss * 4)
    img = img.resize((w, h), Image.LANCZOS)
    tape = np.asarray(t.resize((w, h), Image.LANCZOS), np.float32) / 255
    inside = _arr(img)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    # glass: dark tint + sky reflection (brighter at the top, a soft diagonal sheen per bay)
    alb = lerp(inside, srgb('#27313a'), 0.42)
    alb = alb + (smoothstep(h * 0.55, 0, yy) * 0.10)[..., None] * srgb('#b8c6d0')
    lb = (xx % (w / 4)) / (w / 4)
    sheen = np.exp(-((lb - 0.35 - (yy / h) * 0.3) / 0.12) ** 2) * 0.07
    alb = alb + sheen[..., None]
    alb = lerp(alb, srgb('#d8ccae'), tape[..., None] * 0.85)
    return np.clip(alb, 0, 1)


def _gondola(d, x0, y0, x1, y1, r, pal):
    """Shelving unit front (y0 top, y1 bottom in px) with 4 shelves of product packs."""
    d.rectangle([x0, y0, x1, y1], fill=(84, 86, 88))
    lv = 4; lh = (y1 - y0) / lv
    for k in range(lv):
        yb = y0 + lh * (k + 1)
        x = x0 + 1
        while x < x1 - 2:
            pw = r.uniform(5, 14); ph = lh * r.uniform(0.5, 0.85)
            c = pal[r.integers(len(pal))]; kk = r.uniform(0.7, 1.0)
            d.rectangle([x, yb - ph, min(x1 - 1, x + pw - 1), yb - 2], fill=tuple(int(v * kk) for v in c))
            x += pw
        d.rectangle([x0, yb - 3, x1, yb], fill=(200, 202, 200))


def _misc(name, shape, seed):
    h, w = shape; ss = 4
    W, H = w * ss, h * ss
    img = Image.new('RGB', (W, H), (90, 90, 90)); d = _D(img)
    hm = Image.new('L', (W, H), 128); dh = _D(hm)
    mt = Image.new('L', (W, H), 0); dm = _D(mt)
    rg = Image.new('L', (W, H), 180); dr = _D(rg)
    k = W / _P
    B = lambda px: tuple(v * k for v in px)
    items = _MISC_PX if name == 'sm_misc' else _MISC2_PX
    for nm, px in items.items():
        x0, y0, x1, y1 = B(px); bw, bh = x1 - x0, y1 - y0
        X = lambda s: x0 + s * bw
        Y = lambda t: y0 + t * bh
        R_ = lambda a, b, c, e: [X(a), Y(b), X(c), Y(e)]
        if nm == 'atm':
            d.rectangle(R_(0, 0, 1, 1), fill=(170, 174, 176)); d.rectangle(R_(0, 0, 1, 0.12), fill=(30, 90, 170))
            _text_fit(d, R_(0.05, 0.02, 0.95, 0.1), 'БАНКОМАТ', (255, 255, 255), True)
            d.rectangle(R_(0.15, 0.2, 0.85, 0.45), fill=(40, 44, 48)); d.rectangle(R_(0.2, 0.24, 0.8, 0.41), fill=(70, 140, 170))
            d.rectangle(R_(0.2, 0.52, 0.6, 0.68), fill=(60, 62, 64))
            for i in range(3):
                for j in range(4):
                    d.rectangle(R_(0.23 + i * 0.12, 0.535 + j * 0.035, 0.31 + i * 0.12, 0.56 + j * 0.035), fill=(190, 190, 190))
            d.rectangle(R_(0.66, 0.54, 0.82, 0.57), fill=(20, 20, 20)); d.rectangle(R_(0.2, 0.74, 0.8, 0.77), fill=(20, 20, 20))
            d.rectangle(R_(0, 0.85, 1, 1), fill=(120, 124, 126)); dm.rectangle(R_(0, 0, 1, 1), fill=120); dr.rectangle(R_(0, 0, 1, 1), fill=110)
        elif nm == 'locker':
            d.rectangle(R_(0, 0, 1, 1), fill=(210, 212, 210))
            for i in range(6):
                for j in range(7):
                    if 2 <= i <= 3 and 2 <= j <= 4:
                        continue
                    hh = 1 / 7 * (1.0 if j % 3 else 1.0)
                    d.rectangle(R_(i / 6 + 0.006, j / 7 + 0.006, (i + 1) / 6 - 0.006, (j + 1) / 7 - 0.006), fill=(222, 120, 40) if (i + j) % 5 else (200, 102, 32))
                    d.rectangle(R_(i / 6 + 0.13, j / 7 + 0.06, i / 6 + 0.15, j / 7 + 0.09), fill=(60, 60, 60))
            d.rectangle(R_(2 / 6, 2 / 7, 4 / 6, 5 / 7), fill=(60, 62, 66)); d.rectangle(R_(0.38, 0.32, 0.62, 0.48), fill=(90, 160, 190))
            _text_fit(d, R_(0.36, 0.55, 0.64, 0.62), 'ПОШТОМАТ', (240, 240, 240), True)
            d.rectangle(R_(0.45, 0.64, 0.55, 0.68), fill=(20, 20, 20))
            dm.rectangle(R_(0, 0, 1, 1), fill=90); dr.rectangle(R_(0, 0, 1, 1), fill=120)
        elif nm == 'trolley':
            d.rectangle(R_(0, 0, 1, 1), fill=(46, 48, 50))
            for i in range(26):
                d.line([X(i / 25), Y(0.1), X(i / 25), Y(0.78)], fill=(170, 175, 178), width=int(k * 0.6))
            for j in range(9):
                d.line([X(0), Y(0.1 + j * 0.085), X(1), Y(0.1 + j * 0.085)], fill=(170, 175, 178), width=int(k * 0.6))
            d.rectangle(R_(0, 0.02, 1, 0.1), fill=(200, 40, 40))
            d.rectangle(R_(0, 0.8, 1, 0.86), fill=(150, 154, 156))
            for i in range(4):
                d.ellipse(R_(0.08 + i * 0.25, 0.86, 0.2 + i * 0.25, 0.99), fill=(20, 20, 20))
            dm.rectangle(R_(0, 0, 1, 0.86), fill=200); dr.rectangle(R_(0, 0, 1, 1), fill=90)
        elif nm == 'door_exit':
            d.rectangle(R_(0, 0, 1, 1), fill=(120, 124, 124)); d.rectangle(R_(0.05, 0.12, 0.95, 1), fill=(150, 153, 152))
            d.rectangle(R_(0.2, 0.0, 0.8, 0.09), fill=(30, 150, 70)); _text_fit(d, R_(0.22, 0.01, 0.78, 0.08), 'ВИХІД', (255, 255, 255), True)
            d.rectangle(R_(0.1, 0.55, 0.9, 0.58), fill=(60, 60, 60)); d.rectangle(R_(0.08, 0.95, 0.92, 1), fill=(90, 80, 70))
            dm.rectangle(R_(0, 0, 1, 1), fill=110); dr.rectangle(R_(0, 0, 1, 1), fill=140)
        elif nm == 'louvre':
            d.rectangle(R_(0, 0, 1, 1), fill=(186, 188, 186))
            for j in range(14):
                d.rectangle(R_(0.04, 0.08 + j * 0.06, 0.62, 0.11 + j * 0.06), fill=(70, 74, 76))
                dh.rectangle(R_(0.04, 0.08 + j * 0.06, 0.62, 0.11 + j * 0.06), fill=40)
            d.rectangle(R_(0.66, 0.08, 0.96, 0.92), outline=(120, 122, 122), width=int(k))
            d.rectangle(R_(0.88, 0.45, 0.92, 0.55), fill=(50, 50, 50))
            d.rectangle(R_(0.7, 0.12, 0.85, 0.2), fill=(240, 240, 235)); d.line([X(0.7), Y(0.16), X(0.85), Y(0.16)], fill=(200, 30, 30), width=int(k))
            dm.rectangle(R_(0, 0, 1, 1), fill=110); dr.rectangle(R_(0, 0, 1, 1), fill=120)
        elif nm == 'fan':
            d.rectangle(R_(0, 0, 1, 1), fill=(176, 178, 176)); d.ellipse(R_(0.06, 0.06, 0.94, 0.94), fill=(28, 30, 32))
            cx, cy, rr = X(0.5), Y(0.5), bw * 0.44
            for q in range(4):
                d.ellipse([cx - rr * q / 4, cy - rr * q / 4, cx + rr * q / 4, cy + rr * q / 4], outline=(140, 142, 142), width=int(k * 0.7))
            for q in range(12):
                a = q / 12 * 2 * np.pi
                d.line([cx, cy, cx + np.cos(a) * rr, cy + np.sin(a) * rr], fill=(120, 122, 122), width=int(k * 0.6))
            d.ellipse([cx - rr * 0.15, cy - rr * 0.15, cx + rr * 0.15, cy + rr * 0.15], fill=(60, 60, 60))
            dh.ellipse(R_(0.06, 0.06, 0.94, 0.94), fill=60); dm.rectangle(R_(0, 0, 1, 1), fill=120)
        elif nm == 'dome':
            d.rectangle(R_(0, 0, 1, 1), fill=(150, 154, 152)); d.ellipse(R_(0.08, 0.08, 0.92, 0.92), fill=(205, 214, 216))
            d.ellipse(R_(0.2, 0.15, 0.55, 0.45), fill=(236, 240, 240)); dr.rectangle(R_(0, 0, 1, 1), fill=60); dh.ellipse(R_(0.08, 0.08, 0.92, 0.92), fill=200)
        elif nm == 'logo':
            d.rectangle(R_(0, 0, 1, 1), fill=(176, 36, 32)); d.rounded_rectangle(R_(0.08, 0.08, 0.92, 0.92), radius=bw * 0.12, fill=(250, 250, 246))
            col = (176, 36, 32)
            d.polygon([(X(0.22), Y(0.38)), (X(0.78), Y(0.38)), (X(0.7), Y(0.66)), (X(0.3), Y(0.66))], fill=col)
            d.line([X(0.14), Y(0.3), X(0.24), Y(0.3), X(0.32), Y(0.7), X(0.7), Y(0.7)], fill=col, width=int(bw * 0.05))
            for s in (0.36, 0.64):
                d.ellipse([X(s) - bw * 0.05, Y(0.78) - bw * 0.05, X(s) + bw * 0.05, Y(0.78) + bw * 0.05], fill=col)
            for s in (0.38, 0.5, 0.62):
                d.line([X(s), Y(0.42), X(s - 0.02), Y(0.62)], fill=(250, 250, 246), width=int(bw * 0.025))
            dr.rectangle(R_(0, 0, 1, 1), fill=70)
        elif nm == 'letter_face':
            d.rectangle(R_(0, 0, 1, 1), fill=(244, 243, 236)); dr.rectangle(R_(0, 0, 1, 1), fill=60)
        elif nm == 'letter_side':
            d.rectangle(R_(0, 0, 1, 1), fill=(64, 66, 70)); dm.rectangle(R_(0, 0, 1, 1), fill=150); dr.rectangle(R_(0, 0, 1, 1), fill=100)
        elif nm == 'flood':
            d.rectangle(R_(0, 0, 1, 1), fill=(36, 38, 40)); d.rectangle(R_(0.12, 0.15, 0.88, 0.85), fill=(220, 224, 222))
            for i in range(4):
                for j in range(3):
                    d.ellipse(R_(0.17 + i * 0.18, 0.2 + j * 0.22, 0.29 + i * 0.18, 0.34 + j * 0.22), fill=(250, 250, 240))
            dr.rectangle(R_(0, 0, 1, 1), fill=60)
        elif nm == 'chequer':
            d.rectangle(R_(0, 0, 1, 1), fill=(128, 130, 128))
            for i in range(8):
                for j in range(8):
                    xx, yy = X((i + 0.5) / 8), Y((j + 0.5) / 8); s = bw * 0.035
                    if (i + j) % 2:
                        d.line([xx - s, yy - s, xx + s, yy + s], fill=(168, 170, 168), width=int(k))
                        dh.line([xx - s, yy - s, xx + s, yy + s], fill=200, width=int(k))
                    else:
                        d.line([xx - s, yy + s, xx + s, yy - s], fill=(168, 170, 168), width=int(k))
                        dh.line([xx - s, yy + s, xx + s, yy - s], fill=200, width=int(k))
            dm.rectangle(R_(0, 0, 1, 1), fill=180); dr.rectangle(R_(0, 0, 1, 1), fill=110)
        elif nm == 'citylight':
            d.rectangle(R_(0, 0, 1, 1), fill=(46, 48, 50)); d.rectangle(R_(0.06, 0.05, 0.94, 0.95), fill=(240, 236, 222))
            d.ellipse(R_(0.15, 0.3, 0.85, 0.7), fill=(196, 140, 70)); d.ellipse(R_(0.22, 0.36, 0.78, 0.62), fill=(214, 166, 92))
            _text_fit(d, R_(0.1, 0.08, 0.9, 0.22), 'ХЛІБ', (176, 36, 32))
            _text_fit(d, R_(0.1, 0.74, 0.9, 0.9), 'ЩОДНЯ СВІЖИЙ', (60, 60, 60), True)
            dr.rectangle(R_(0, 0, 1, 1), fill=70)
        elif nm == 'hazard':
            d.rectangle(R_(0, 0, 1, 1), fill=(20, 20, 20))
            for q in range(-6, 14):
                x = X(q / 8)
                d.polygon([(x, Y(1)), (x + bw / 16, Y(1)), (x + bw / 16 + bh, Y(0)), (x + bh, Y(0))], fill=(232, 190, 30))
        elif nm == 'rubber':
            d.rectangle(R_(0, 0, 1, 1), fill=(24, 24, 24))
            for j in range(4):
                d.rectangle(R_(0, 0.1 + j * 0.24, 1, 0.16 + j * 0.24), fill=(40, 40, 40))
            dr.rectangle(R_(0, 0, 1, 1), fill=230)
        elif nm == 'cardboard':
            d.rectangle(R_(0, 0, 1, 1), fill=(150, 116, 74))
            rr = rng(seed + 3)
            for j in range(16):
                y = Y(rr.uniform(0, 1)); d.line([X(0), y, X(1), y + rr.uniform(-4, 4)], fill=(120, 92, 58) if j % 2 else (178, 146, 100), width=int(k * 1.2))
            for s in (0.3, 0.7):
                d.line([X(s), Y(0), X(s), Y(1)], fill=(40, 40, 40), width=int(k))
            dr.rectangle(R_(0, 0, 1, 1), fill=240)
        elif nm == 'sign_super':
            d.rectangle(R_(0, 0, 1, 1), fill=(250, 250, 246)); d.rectangle(R_(0, 0.86, 1, 1), fill=(176, 36, 32))
            _text_fit(d, R_(0.03, 0.08, 0.97, 0.8), 'СУПЕРМАРКЕТ', (176, 36, 32))
            dr.rectangle(R_(0, 0, 1, 1), fill=70)
        elif nm == 'hours':
            d.rectangle(R_(0, 0, 1, 1), fill=(40, 42, 46))
            _text_fit(d, R_(0.08, 0.06, 0.92, 0.2), 'ГРАФІК', (250, 250, 250), True)
            for j, t in enumerate(('ПН-НД', '8:00', '22:00')):
                _text_fit(d, R_(0.1, 0.3 + j * 0.2, 0.9, 0.45 + j * 0.2), t, (240, 210, 60) if j else (230, 230, 230), True)
        elif nm == 'ukryttya':
            d.rectangle(R_(0, 0, 1, 1), fill=(24, 84, 170)); d.rectangle(R_(0.03, 0.06, 0.97, 0.94), outline=(250, 250, 250), width=int(k))
            _text_fit(d, R_(0.06, 0.12, 0.72, 0.88), 'УКРИТТЯ', (255, 255, 255))
            d.polygon([(X(0.76), Y(0.3)), (X(0.9), Y(0.5)), (X(0.76), Y(0.7))], fill=(255, 255, 255))
        elif nm == 'red_cross':
            d.rectangle(R_(0, 0, 1, 1), fill=(240, 240, 236))
            d.rectangle(R_(0.38, 0.12, 0.62, 0.88), fill=(200, 30, 30)); d.rectangle(R_(0.12, 0.38, 0.88, 0.62), fill=(200, 30, 30))
        elif nm == 'mat':
            d.rectangle(R_(0, 0, 1, 1), fill=(38, 38, 38))
            for j in range(10):
                d.line([X(0), Y(j / 10), X(1), Y(j / 10)], fill=(56, 56, 56), width=int(k))
            dr.rectangle(R_(0, 0, 1, 1), fill=240)
        elif nm == 'cond_side':
            d.rectangle(R_(0, 0, 1, 1), fill=(178, 180, 178))
            d.rectangle(R_(0.03, 0.12, 0.97, 0.9), fill=(70, 76, 78))
            for i in range(60):
                d.line([X(0.03 + i * 0.0157), Y(0.12), X(0.03 + i * 0.0157), Y(0.9)], fill=(120, 126, 128), width=int(k * 0.5))
            for q in (0.03, 0.5, 0.97):
                d.rectangle(R_(q - 0.01, 0.1, q + 0.01, 0.92), fill=(160, 162, 160))
            dh.rectangle(R_(0.03, 0.12, 0.97, 0.9), fill=60); dm.rectangle(R_(0, 0, 1, 1), fill=150)
        elif nm == 'vest_glass':
            d.rectangle(R_(0, 0, 1, 1), fill=(70, 80, 86))
            d.rectangle(R_(0, 0.78, 1, 1), fill=(120, 116, 106)); d.rectangle(R_(0.1, 0.84, 0.9, 0.98), fill=(40, 40, 40))
            d.rectangle(R_(0.6, 0.35, 0.92, 0.82), fill=(60, 70, 110))     # ATM inside the vestibule
            d.rectangle(R_(0.06, 0.5, 0.3, 0.82), fill=(50, 60, 40)); d.ellipse(R_(0.0, 0.3, 0.36, 0.6), fill=(60, 90, 50))
            d.rectangle(R_(0, 0, 1, 0.1), fill=(150, 154, 152))
            dr.rectangle(R_(0, 0, 1, 1), fill=30)
        elif nm == 'vest_door':
            d.rectangle(R_(0, 0, 1, 1), fill=(62, 72, 78)); d.rectangle(R_(0, 0.8, 1, 1), fill=(110, 106, 96))
            d.rectangle(R_(0.49, 0, 0.51, 1), fill=(150, 154, 156))
            for j in range(6):
                for i in range(8):
                    d.ellipse(R_(0.05 + i * 0.115, 0.46 + j * 0.02, 0.08 + i * 0.115, 0.475 + j * 0.02), fill=(200, 205, 205))
            _text_fit(d, R_(0.08, 0.3, 0.45, 0.4), 'ВХІД', (240, 240, 240), True); _text_fit(d, R_(0.55, 0.3, 0.92, 0.4), 'ВХІД', (240, 240, 240), True)
            d.rectangle(R_(0, 0, 1, 0.04), fill=(150, 154, 156)); dr.rectangle(R_(0, 0, 1, 1), fill=30)
        elif nm == 'terminal':
            d.rectangle(R_(0, 0, 1, 1), fill=(222, 184, 40)); d.rectangle(R_(0.15, 0.1, 0.85, 0.45), fill=(30, 32, 36))
            d.rectangle(R_(0.2, 0.14, 0.8, 0.41), fill=(80, 150, 200)); d.rectangle(R_(0.3, 0.55, 0.7, 0.62), fill=(30, 30, 30))
            _text_fit(d, R_(0.05, 0.7, 0.95, 0.82), 'ОПЛАТА', (40, 40, 40), True); dr.rectangle(R_(0, 0, 1, 1), fill=90)
        elif nm == 'el_cabinet':
            d.rectangle(R_(0, 0, 1, 1), fill=(176, 178, 174)); d.line([X(0.5), Y(0.02), X(0.5), Y(0.98)], fill=(110, 110, 110), width=int(k))
            d.polygon([(X(0.3), Y(0.12)), (X(0.42), Y(0.12)), (X(0.36), Y(0.24))], fill=(240, 200, 30))
            d.rectangle(R_(0.44, 0.45, 0.48, 0.55), fill=(40, 40, 40)); dm.rectangle(R_(0, 0, 1, 1), fill=100)
        elif nm == 'vent':
            d.rectangle(R_(0, 0, 1, 1), fill=(150, 154, 154))
            for j in range(10):
                d.rectangle(R_(0.06, 0.08 + j * 0.088, 0.94, 0.13 + j * 0.088), fill=(46, 48, 50))
                dh.rectangle(R_(0.06, 0.08 + j * 0.088, 0.94, 0.13 + j * 0.088), fill=50)
            dm.rectangle(R_(0, 0, 1, 1), fill=140)
        elif nm == 'ceiling':
            d.rectangle(R_(0, 0, 1, 1), fill=(206, 204, 196))
            for q in (0, 0.5):
                d.line([X(q), Y(0), X(q), Y(1)], fill=(150, 150, 146), width=int(k)); d.line([X(0), Y(q), X(1), Y(q)], fill=(150, 150, 146), width=int(k))
            rr = rng(seed + 5)
            for _ in range(160):
                x, y = X(rr.random()), Y(rr.random()); d.point((x, y), fill=(170, 168, 160))
        elif nm == 'osb_plain':
            pass
    img = img.resize((w, h), Image.LANCZOS)
    alb = _arr(img)
    if name == 'sm_misc2':
        x0, y0, x1, y1 = [int(round(v)) for v in _MISC2_PX['osb_plain']]
        x0, x1 = int(x0 * w / _P), int(x1 * w / _P); y0, y1 = int(y0 * h / _P), int(y1 * h / _P)
        a, _ = _osb((y1 - y0, x1 - x0), seed + 11, seam=None)
        alb[y0:y1, x0:x1] = a
    hgt = (np.asarray(hm.resize((w, h), Image.LANCZOS), np.float32) / 255 - 0.5) * 3
    rough = np.asarray(rg.resize((w, h), Image.LANCZOS), np.float32) / 255
    metal = np.asarray(mt.resize((w, h), Image.LANCZOS), np.float32) / 255
    return alb, hgt, rough, metal
