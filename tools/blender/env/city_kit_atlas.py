"""Second panel-kit atlas 'kit_city' (2048^2, albedo JPEG / normal PNG / ORM PNG) used by the city additions
(brick 1-447 walls, shopfronts, shop signs, roof pieces, collapse piles). Second material of panel_kit.glb.

Layout (pixels, origin top-left):
  x 0..1800, y 0..1884 : 5 x 6 facade cells 360 x 314 (= 3.2 x 2.8 m, ~112 px/m)
        cells  0..23  brick: index = colour*12 + state*4 + type   (colour white/red; state intact/damaged/holed;
                      type window/balcony/blank_end/entrance). *_destroyed reuses the holed cell.
        cells 24..29  shopfront: 24 + type*3 + state (shopfront, shopfront_shutter)
  x 0..1800, y 1884..2048 : 10 shop-sign slots 360 x 82
  x 1800..2048 : detail regions (REG)
"""
import os
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont
from texlib import (spectral, norm01, smoothstep, blur, colorize, srgb, lerp, to8, rng, voronoi, bake_shade, cavity_ao)
import texlib
from kit_design import W, H, T
from city_kit_design import (COURSE, PITCH, HALF, HEADER_EVERY, COLOURS, BTYPES, OPEN_BRICK, LINTEL_H, LINTEL_EXT,
                             SHOP_TYPES, OPEN_SHOP, SIGNS, SIGN_H, brick_hole, shop_hole)
import kit_atlas as KA

S = 2048
CW, CH = 360, 314
PX, PY = CW / W, CH / H

REG = {
    'brick_sec_white': (1800, 0, 2048, 124), 'brick_sec_red': (1800, 124, 2048, 248),
    'rubble': (1800, 248, 2048, 496), 'shutter': (1800, 496, 2048, 744), 'shop_glass': (1800, 744, 2048, 992),
}
SMALL = ['brick_white', 'brick_red', 'alu', 'reveal', 'sign_metal', 'lightbox', 'tile_granite', 'louvre',
         'conc_vent', 'roof_door', 'antenna', 'rust', 'dust', 'cable', 'tarp', 'mastic']
for i, n in enumerate(SMALL):
    x0 = 1800 + (i % 2) * 124; y0 = 992 + (i // 2) * 124
    REG[n] = (x0, y0, x0 + 124, y0 + 124)
REG['spare'] = (1800, 1984, 2048, 2048)
FONT_B = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FONT_C = '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf'
FONT_S = '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'
FONT_L = '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'


def cell_index_brick(colour, btype, state):
    st = {'intact': 0, 'damaged': 1, 'holed': 2, 'destroyed': 2}[state]
    return COLOURS.index(colour) * 12 + st * 4 + BTYPES.index(btype)


def cell_index_shop(stype, state):
    st = {'intact': 0, 'damaged': 1, 'holed': 2, 'destroyed': 2}[state]
    return 24 + SHOP_TYPES.index(stype) * 3 + st


def cell_rect(i):
    c, r = i % 5, i // 5
    return (c * CW, r * CH, c * CW + CW, r * CH + CH)


def sign_rect(k):
    """Full slot and the art sub-rect (aspect = sign length / SIGN_H)."""
    x0, y0 = (k % 5) * 360, 1884 + (k // 5) * 82
    L = SIGNS[k][3]
    asp = L / SIGN_H
    hh = min(82.0, 360.0 / asp); ww = hh * asp
    ax0 = x0 + (360 - ww) / 2; ay0 = y0 + (82 - hh) / 2
    return (x0, y0, x0 + 360, y0 + 82), (ax0, ay0, ax0 + ww, ay0 + hh)


def _shape(rect):
    x0, y0, x1, y1 = rect; return (y1 - y0, x1 - x0)


def mrow(y):
    return (H - y) * PY


def mcol(x):
    return x * PX


def poly_mask(shape, P):
    m = np.zeros(shape, np.float32)
    pts = np.array([[mcol(x) * 4, mrow(y) * 4] for x, y in P], np.int32)
    cv2.fillPoly(m, [pts], 1.0, lineType=cv2.LINE_AA, shift=2)
    return m


def rect_mask(shape, rc):
    x0, y0, x1, y1 = rc
    return poly_mask(shape, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)])


def dist_outside(mask):
    inv = (mask < 0.5).astype(np.uint8)
    return cv2.distanceTransform(inv, cv2.DIST_L2, 5).astype(np.float32)


# ------------------------------------------------------------------ brick
BRICK = {
    'white': dict(stops=[(0, '#b3ad9f'), (0.4, '#c3bdb0'), (0.75, '#cbc5b8'), (1, '#d3cec2')], mortar='#a29d91',
                  chip='#e6e2d8', inner='#8f897d', dirt='#6d675c'),
    'red': dict(stops=[(0, '#5e2c20'), (0.25, '#7f3a28'), (0.6, '#974832'), (0.85, '#a95a3d'), (1, '#b26b4c')],
                mortar='#aaa192', chip='#c07a5a', inner='#6b3424', dirt='#4a3428'),
}


def brick_pattern(xm, ym, seed, joint=0.011):
    """Returns (brick mask 0..1, per-brick tone 0..1, per-brick id) for metre coords (any shape)."""
    j = np.floor(ym / COURSE).astype(np.int32)
    fy = ym - j * COURSE
    header = (j % HEADER_EVERY) == 0
    pitch = np.where(header, HALF, PITCH)
    off = np.where(header, np.where((j // HEADER_EVERY) % 2 == 0, 0.0, HALF * 0.5), np.where(j % 2 == 0, 0.0, HALF))
    xx = xm - off
    k = np.floor(xx / pitch).astype(np.int32)
    fx = xx - k * pitch
    m = (smoothstep(joint * 0.4, joint, fy) * smoothstep(joint * 0.4, joint, fx) *
         smoothstep(COURSE, COURSE - joint * 0.25, fy) * smoothstep(pitch, pitch - joint * 0.25, fx))
    bid = (k * 7919 + j * 104729 + seed * 31) % 99991
    tone = ((bid * 0.6180339) % 1.0).astype(np.float32)
    return m.astype(np.float32), tone, bid


def stepped_crack(shape, start, seed, n=24, up=1):
    """Crack running along mortar joints in a stair-step (classic masonry settlement / blast crack)."""
    r = rng(seed); m = np.zeros(shape, np.float32)
    x, y = start; pts = [(mcol(x), mrow(y))]
    sx = r.choice([-1, 1])
    for k in range(n):
        if r.random() < 0.55:
            y += COURSE * up
        else:
            x += sx * HALF * r.choice([1, 1, 2])
        if r.random() < 0.08:
            sx = -sx
        pts.append((mcol(x), mrow(y)))
    texlib._draw_poly(m, pts, 1.4, False)
    return np.clip(m, 0, 1)


def paint_brick(colour, t, state, seed, voids=None):
    r = rng(seed); C = BRICK[colour]
    h, w = CH, CW
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ym = H - (yy + 0.5) / PY; xm = (xx + 0.5) / PX
    low = spectral(0, 2.2, seed + 1, fmin=1, fmax=16, shape=(h, w))
    mid = spectral(0, 1.4, seed + 2, fmin=6, fmax=150, shape=(h, w))
    fine = spectral(0, 0.6, seed + 3, fmin=60, shape=(h, w))
    bm, tone, bid = brick_pattern(xm, ym, 3 + COLOURS.index(colour))
    tone = np.clip(tone * 0.75 + 0.1 * fine + 0.05 * norm01(low), 0, 1)
    bcol = colorize(tone, C['stops'])
    if colour == 'red':   # a few over-fired dark bricks
        dark = (((bid * 0.377) % 1.0) > 0.93).astype(np.float32)
        bcol = lerp(bcol, srgb('#4a2219'), dark * 0.6)
    mortar = srgb(C['mortar']) * (0.92 + 0.08 * norm01(mid))[..., None] + np.zeros((h, w, 3), np.float32)
    alb = lerp(mortar, bcol * (0.95 + 0.05 * fine[..., None]), bm)
    hgt = bm * 1.4 - 0.6 + fine * 0.2
    rough = 0.82 + 0.1 * (1 - bm)
    # precast lintels over openings (flush, grey concrete, slightly darker bearing joints)
    lint = np.zeros((h, w), np.float32)
    ops = OPEN_BRICK[t]
    if ops:
        xs0 = min(rc[0] for _, rc in ops) - LINTEL_EXT; xs1 = max(rc[2] for _, rc in ops) + LINTEL_EXT
        y1 = max(rc[3] for _, rc in ops)
        lint = rect_mask((h, w), (max(0.0, xs0), y1, min(W, xs1), min(H, y1 + LINTEL_H)))
        conc = colorize(norm01(mid * 0.6 + fine * 0.4), [(0, '#8c877e'), (1, '#a8a398')])
        alb = lerp(alb, conc, lint); hgt = lerp(hgt, 0.4 + fine * 0.3, lint); rough = lerp(rough, 0.9, lint)
        # joint between lintel blocks
        for xj in (xs0 + 0.01, (xs0 + xs1) / 2, xs1 - 0.01):
            jm = np.exp(-((xm - xj) / 0.012) ** 2) * lint
            alb = lerp(alb, srgb('#55514a'), jm * 0.7)
    # weathering: grime gradient from the bottom, rain streaks from sills, soot of old chimney/vents at top
    alb = lerp(alb, srgb(C['dirt']), smoothstep(0.7, 0.0, ym)[..., None] * 0.25 * (0.6 + 0.4 * norm01(mid))[..., None])
    streak = np.zeros((h, w), np.float32)
    for kind, (x0, y0, x1, y1) in ops:
        if kind == 'window':
            for xe in (x0 + 0.04, x1 - 0.04, (x0 + x1) / 2):
                L = r.uniform(0.3, max(0.35, y0 - 0.05)) * PY; xs = mcol(xe + r.normal(0, 0.05)); wd = r.uniform(3, 7)
                streak += np.exp(-((xx - xs) / wd) ** 2) * ((yy > mrow(y0)) & (yy < mrow(y0) + L)) * np.clip(1 - (yy - mrow(y0)) / L, 0, 1)
            streak += smoothstep(mrow(y0) + 14, mrow(y0), yy) * ((xx > mcol(x0)) & (xx < mcol(x1))) * (yy > mrow(y0)) * 0.5
    vst = blur(spectral(0, 1.2, seed + 5, fmin=8, fmax=160, shape=(h, w)), (30, 1.0), wrap=False)
    streak += np.clip(vst * 1.1 - 0.5, 0, 1) * 0.3
    alb = lerp(alb, srgb(C['dirt']), np.clip(streak, 0, 1) * 0.4)
    # repointing patches (lighter cement) on intact walls
    patch = smoothstep(1.3, 1.9, spectral(0, 2.4, seed + 6, fmin=2, fmax=30, shape=(h, w))) * (1 - bm)
    alb = lerp(alb, srgb('#bdb7aa'), patch * 0.6)
    open_mask = np.zeros((h, w), np.float32)
    for kind, rc in ops:
        open_mask = np.maximum(open_mask, rect_mask((h, w), rc))
    soot = np.zeros((h, w), np.float32)
    if state != 'intact':
        n = {'damaged': 80, 'holed': 160, 'destroyed': 160}[state]
        pit = np.zeros((h, w), np.float32); ring = np.zeros((h, w), np.float32)
        for k in range(n):
            if state == 'damaged':
                x, y = r.uniform(0.1, W - 0.1), r.uniform(0.1, H - 0.1)
            else:
                a = r.uniform(0, 2 * np.pi); d = abs(r.normal(0, 0.9)) + 0.5
                x, y = W * 0.55 + np.cos(a) * d, H * 0.5 + np.sin(a) * d * 0.8
                if voids is not None:
                    _a = np.concatenate(voids); x, y = _a[:, 0].mean() + np.cos(a) * d, np.clip(_a[:, 1].mean(), 0.6, H - 0.6) + np.sin(a) * d * 0.8
            rr = r.uniform(0.8, 3.2)
            texlib.stamp_disc(pit, mcol(x), mrow(y), rr, 1, 1.0)
            texlib.stamp_disc(ring, mcol(x), mrow(y), rr * r.uniform(1.8, 3.2), 1, 1.5)
        ring = np.clip(ring - pit, 0, 1) * smoothstep(-0.3, 0.6, fine)
        alb = lerp(alb, srgb(C['chip']), ring * 0.7)
        alb = lerp(alb, srgb('#26221f'), pit * 0.85)
        hgt -= pit * 2.5 + ring * 0.8
        # missing face bricks: whole brick faces knocked off -> recessed darker inner brick
        nb = 6 if state == 'damaged' else 14
        ids = r.choice(np.unique(bid[(bm > 0.5) & (open_mask < 0.5)]), nb, replace=False)
        miss = np.isin(bid, ids).astype(np.float32) * (bm > 0.2)
        alb = lerp(alb, srgb(C['inner']) * (0.8 + 0.2 * norm01(fine))[..., None], miss)
        hgt -= miss * 2.0
        # stair-step cracks along the joints from opening corners (or wall centre)
        cr = np.zeros((h, w), np.float32)
        corners = []
        for kind, (x0, y0, x1, y1) in ops:
            corners += [((x0, y1), 1), ((x1, y1), 1), ((x0, y0), -1), ((x1, y0), -1)]
        if not corners:
            corners = [((1.2, 1.0), 1), ((2.0, 1.6), -1), ((1.6, 2.2), 1)]
        for k, (p, up) in enumerate(corners):
            if r.random() < 0.6:
                cr = np.maximum(cr, stepped_crack((h, w), p, seed + 40 + k, int(r.uniform(12, 30)), up))
        alb = lerp(alb, srgb('#1e1b18'), cr * 0.85); hgt -= cr * 2
        for kind, (x0, y0, x1, y1) in ops:
            cx = (x0 + x1) / 2; half = (x1 - x0) / 2
            dy = np.clip(ym - y1 + 0.05, 0, None)
            width = half * (0.85 + dy * 0.9) * (1 + 0.15 * mid)
            plume = smoothstep(width, width * 0.4, np.abs(xm - cx + mid * 0.08)) * (ym > y1 - 0.08) * np.exp(-dy * 0.35)
            plume *= 0.7 + 0.3 * norm01(blur(spectral(0, 1.6, seed + 8, fmin=4, fmax=100, shape=(h, w)), (6, 1), wrap=False))
            side = (np.exp(-((xm - x0) / 0.06) ** 2) + np.exp(-((xm - x1) / 0.06) ** 2)) * (ym > y0) * (ym < y1 + 0.1) * 0.6
            if not (state == 'damaged' and kind == 'door'):
                soot = np.maximum(soot, plume + side)
        if state == 'damaged' and t == 'blank_end':
            soot = np.maximum(soot, smoothstep(1.2, 0.0, np.abs(xm - 1.9 + mid * 0.2)) * smoothstep(0.4, 2.8, ym) * 0.35)
    if state in ('holed', 'destroyed'):
        polys = voids if voids is not None else [brick_hole(t)]
        hm = np.zeros((h, w), np.float32)
        for _p in polys:
            hm = np.maximum(hm, poly_mask((h, w), _p))
        hp = np.concatenate(polys)
        d = dist_outside(hm) / PX
        cy = hp[:, 1].mean(); cx = hp[:, 0].mean(); top = hp[:, 1].max()
        sc = np.exp(-d / 0.3) + smoothstep(1.3, 0.2, np.abs(xm - cx + mid * 0.1)) * (ym > top - 0.3) * np.exp(-np.clip(ym - top, 0, None) * 0.45) * 0.85
        if voids is not None and state == 'destroyed':
            sc = np.exp(-d / 0.12) * 0.8 * (0.6 + 0.4 * norm01(mid)) + np.exp(-d / 0.5) * 0.25
        soot = np.maximum(soot, np.clip(sc * (0.8 + 0.2 * norm01(mid)), 0, 1))
        cr = np.zeros((h, w), np.float32)
        for k in range(10):
            i = r.integers(0, len(hp)); p = hp[i]
            cr = np.maximum(cr, stepped_crack((h, w), (p[0], p[1]), seed + 70 + k, int(r.uniform(8, 22)), 1 if p[1] > cy else -1))
        alb = lerp(alb, srgb('#16130f'), cr * 0.9); hgt -= cr * 2.5
        ringm = ((d < 0.18 + 0.15 * norm01(mid)) * (bm > 0.2)).astype(np.float32)
        alb = lerp(alb, srgb(C['inner']), ringm * 0.6); hgt -= ringm
        inside = hm
        burnt = colorize(norm01(fine * 0.5 + mid * 0.5), [(0, '#221f1c'), (1, '#45403a')])
        alb = lerp(alb, burnt, inside); rough = np.maximum(rough, inside * 0.95)
    soot = np.clip(soot, 0, 1)
    alb = lerp(alb, colorize(norm01(fine), [(0, '#131210'), (1, '#2a2622')]), soot * 0.9)
    rough = lerp(rough, 0.97, soot)
    alb = alb * (0.95 + 0.05 * low[..., None])
    alb = alb * bake_shade(hgt, 0.6, 0.12, wrap=False)
    return alb, hgt, np.clip(rough, 0, 1)


# ------------------------------------------------------------------ shopfront cladding
def paint_shop(t, state, seed, voids=None):
    r = rng(seed)
    h, w = CH, CW
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ym = H - (yy + 0.5) / PY; xm = (xx + 0.5) / PX
    low = spectral(0, 2.2, seed + 1, fmin=1, fmax=16, shape=(h, w))
    mid = spectral(0, 1.4, seed + 2, fmin=6, fmax=150, shape=(h, w))
    fine = spectral(0, 0.6, seed + 3, fmin=60, shape=(h, w))
    fascia = (ym > 2.08).astype(np.float32)
    if t == 'shopfront':
        # 600x300 porcelain stoneware tiles, grey-beige, with dark grout; composite fascia white with a blue band
        tx = np.floor(xm / 0.6 + (np.floor(ym / 0.3) % 2) * 0.5); ty = np.floor(ym / 0.3)
        fx = xm / 0.6 + (np.floor(ym / 0.3) % 2) * 0.5 - tx; fy = ym / 0.3 - ty
        tid = ((tx * 7919 + ty * 104729) % 9973 * 0.618) % 1.0
        grout = np.maximum(smoothstep(0.985, 1.0, fx) + smoothstep(0.015, 0.0, fx), smoothstep(0.97, 1.0, fy) + smoothstep(0.03, 0.0, fy))
        tile = colorize(np.clip(tid * 0.6 + 0.2 * norm01(fine), 0, 1), [(0, '#7e776c'), (1, '#9d958a')])
        alb = lerp(tile, srgb('#3d3a35'), np.clip(grout, 0, 1) * 0.8)
        hgt = 1 - np.clip(grout, 0, 1) * 1.5
        rough = 0.5 + np.clip(grout, 0, 1) * 0.4
        comp = srgb('#d9dbd8') * (0.95 + 0.05 * norm01(mid))[..., None] + np.zeros((h, w, 3), np.float32)
        band = ((ym > 2.12) & (ym < 2.22)).astype(np.float32)
        comp = lerp(comp, srgb('#2d5c9a'), band)
        seams = ((np.abs(((xm + 0.4) % 1.25) - 0.0) < 0.012) | (np.abs(ym - 2.5) < 0.01)).astype(np.float32)
        comp = lerp(comp, srgb('#6c6e6c'), seams)
        alb = lerp(alb, comp, fascia); hgt = lerp(hgt, 0.5 - seams * 1.5, fascia); rough = lerp(rough, 0.45, fascia)
    else:
        # horizontal vinyl siding, pale green, over the old plaster; dark red composite fascia
        lap = (ym % 0.2) / 0.2
        alb = colorize(norm01(mid * 0.5 + fine * 0.2), [(0, '#9fb39a'), (1, '#b5c6ad')]) * (0.85 + 0.15 * lap)[..., None]
        hgt = lap * 2 - 1; rough = np.full((h, w), 0.55, np.float32)
        plinth = (ym < 0.4).astype(np.float32)
        alb = lerp(alb, colorize(norm01(mid), [(0, '#5e5a54'), (1, '#77726a')]), plinth); hgt = lerp(hgt, fine * 0.3, plinth)
        comp = srgb('#7a2626') * (0.9 + 0.1 * norm01(mid))[..., None] + np.zeros((h, w, 3), np.float32)
        alb = lerp(alb, comp, fascia); hgt = lerp(hgt, 0.5, fascia); rough = lerp(rough, 0.5, fascia)
    # dirt: splash zone at the bottom, streaks, posters / stickers glued around the door
    alb = lerp(alb, srgb('#4d463c'), smoothstep(0.5, 0.0, ym)[..., None] * 0.45)
    vst = blur(spectral(0, 1.2, seed + 5, fmin=8, fmax=160, shape=(h, w)), (30, 1.0), wrap=False)
    alb = lerp(alb, srgb('#5a554c'), np.clip(vst * 1.1 - 0.5, 0, 1) * 0.3)
    img = Image.fromarray(to8(alb)); d = ImageDraw.Draw(img)
    for k in range(5):   # torn paper adverts (white/yellow rectangles) on the piers
        x = r.uniform(0.02, 0.18 if t == 'shopfront' else 0.15); y = r.uniform(0.5, 1.7)
        if t == 'shopfront' and r.random() < 0.5:
            x = r.uniform(1.13, 1.2)
        ww, hh = r.uniform(0.08, 0.16), r.uniform(0.1, 0.2)
        col = tuple(int(c) for c in r.choice([(225, 222, 205), (230, 215, 120), (200, 205, 210)]))
        d.rectangle([mcol(x), mrow(y + hh), mcol(x + ww), mrow(y)], fill=col)
    alb = np.asarray(img).astype(np.float32) / 255
    ops = OPEN_SHOP[t]
    soot = np.zeros((h, w), np.float32)
    if state != 'intact':
        pit = np.zeros((h, w), np.float32)
        for k in range(70 if state == 'damaged' else 130):
            x, y = r.uniform(0.05, W - 0.05), r.uniform(0.05, H - 0.05)
            texlib.stamp_disc(pit, mcol(x), mrow(y), r.uniform(0.8, 3.0), 1, 1.0)
        alb = lerp(alb, srgb('#26231f'), pit * 0.85); hgt -= pit * 2
        for kind, (x0, y0, x1, y1) in ops:
            cx = (x0 + x1) / 2; half = (x1 - x0) / 2
            dy = np.clip(ym - y1 + 0.05, 0, None)
            plume = smoothstep(half * (0.8 + dy), half * 0.3, np.abs(xm - cx + mid * 0.08)) * (ym > y1 - 0.08) * np.exp(-dy * 0.5)
            soot = np.maximum(soot, plume * (0.6 + 0.4 * norm01(mid)))
    if state in ('holed', 'destroyed'):
        polys = voids if voids is not None else [shop_hole(t)]
        hm = np.zeros((h, w), np.float32)
        for _p in polys:
            hm = np.maximum(hm, poly_mask((h, w), _p))
        d = dist_outside(hm) / PX
        soot = np.maximum(soot, np.clip(np.exp(-d / 0.12) * 0.8 + np.exp(-d / 0.5) * 0.25 if (voids is not None and state == 'destroyed') else np.exp(-d / 0.35), 0, 1))
        burnt = colorize(norm01(fine * 0.5 + mid * 0.5), [(0, '#221f1c'), (1, '#45403a')])
        alb = lerp(alb, burnt, hm)
    soot = np.clip(soot, 0, 1)
    alb = lerp(alb, colorize(norm01(fine), [(0, '#131210'), (1, '#2a2622')]), soot * 0.9)
    rough = lerp(rough, 0.97, soot)
    alb = alb * (0.95 + 0.05 * low[..., None]) * bake_shade(hgt, 0.6, 0.1, wrap=False)
    return alb, hgt, np.clip(rough, 0, 1)


# ------------------------------------------------------------------ shop signs
SIGN_STYLE = {   # bg, fg, font, border, kind
    'pharmacy': ('#f1f2ee', '#1f8a3c', FONT_B, '#1f8a3c', 'lightbox'),
    'blue': ('#1f4f9a', '#f5e15a', FONT_B, '#e8e8e8', 'lightbox'),
    'bread': ('#7a4a22', '#f2dfb0', FONT_S, '#f2dfb0', 'plate'),
    'red': ('#b3241f', '#f4f1ea', FONT_L, '#f4f1ea', 'plate'),
    'pink': ('#c43c7c', '#ffffff', FONT_B, '#ffffff', 'lightbox'),
    'green': ('#2f6b37', '#f4f4ee', FONT_C, '#d8c25a', 'plate'),
    'cafe': ('#2a1d17', '#f0a53a', FONT_S, '#f0a53a', 'lightbox'),
    'flowers': ('#f3f0ea', '#c4243c', FONT_S, '#2f7a3a', 'lightbox'),
    'veg': ('#5b8f2b', '#fff6c8', FONT_C, '#f2c23a', 'plate'),
    'orange': ('#e07a1f', '#2a1c12', FONT_B, '#2a1c12', 'lightbox'),
}


def paint_sign(k, seed):
    key, text, style, L = SIGNS[k]
    slot, art = sign_rect(k)
    sh = _shape(slot)
    bg, fg, font, border, kind = SIGN_STYLE[style]
    sc = 4  # supersample
    img = Image.new('RGB', (sh[1] * sc, sh[0] * sc), (60, 60, 60)); d = ImageDraw.Draw(img)
    ax0, ay0, ax1, ay1 = [v - o for v, o in zip(art, (slot[0], slot[1], slot[0], slot[1]))]
    A = [ax0 * sc, ay0 * sc, ax1 * sc, ay1 * sc]
    d.rectangle(A, fill=bg)
    bw = (ay1 - ay0) * sc * 0.06
    d.rectangle([A[0] + bw, A[1] + bw, A[2] - bw, A[3] - bw], outline=border, width=max(2, int(bw * 0.5)))
    hh = (ay1 - ay0) * sc; ww = (ax1 - ax0) * sc
    x_text0 = A[0] + bw * 2.5
    if style == 'pharmacy':   # green cross pictogram
        cs = hh * 0.62; cx, cy = A[0] + hh * 0.55, (A[1] + A[3]) / 2
        th = cs / 3
        d.rectangle([cx - cs / 2, cy - th / 2, cx + cs / 2, cy + th / 2], fill=fg)
        d.rectangle([cx - th / 2, cy - cs / 2, cx + th / 2, cy + cs / 2], fill=fg)
        x_text0 = A[0] + hh * 1.05
    if style == 'flowers':
        for j in range(3):
            cx, cy, rr = A[0] + hh * (0.35 + 0.22 * j), A[1] + hh * (0.45 + 0.1 * (j % 2)), hh * 0.12
            d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=('#c4243c', '#e8b324', '#c4243c')[j])
        x_text0 = A[0] + hh * 1.0
    avail = A[2] - bw * 2.5 - x_text0
    size = int(hh * 0.66)
    f = ImageFont.truetype(font, size)
    while d.textlength(text, font=f) > avail and size > 8:
        size -= 2; f = ImageFont.truetype(font, size)
    tw = d.textlength(text, font=f)
    bb = d.textbbox((0, 0), text, font=f)
    ty = (A[1] + A[3]) / 2 - (bb[1] + bb[3]) / 2
    d.text((x_text0 + (avail - tw) / 2, ty), text, fill=fg, font=f)
    img = img.resize((sh[1], sh[0]), Image.LANCZOS)
    alb = np.asarray(img).astype(np.float32) / 255
    h, w = sh
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.4, seed, fmin=3, fmax=60, shape=sh); f2 = spectral(0, 0.6, seed + 1, fmin=30, shape=sh)
    # sun fading + grime from the top edge + dirt streaks
    alb = lerp(alb, srgb('#d8d4c8'), 0.12 + 0.08 * norm01(n))
    alb = lerp(alb, srgb('#3d362c'), smoothstep(0.6, 1.8, n) * 0.35)
    alb = lerp(alb, srgb('#4a4239'), smoothstep(art[1] - slot[1] + (art[3] - art[1]) * 0.25, art[1] - slot[1], yy)[..., None] * 0.3)
    rough = np.full(sh, 0.45 if kind == 'lightbox' else 0.6, np.float32)
    hgt = f2 * 0.2
    if kind == 'plate':  # painted sheet metal: rust at the edges and screw heads
        e = np.minimum(np.minimum(xx - (art[0] - slot[0]), (art[2] - slot[0]) - xx), np.minimum(yy - (art[1] - slot[1]), (art[3] - slot[1]) - yy))
        rust = smoothstep(6, 0, e) * smoothstep(-0.2, 0.8, n)
        alb = lerp(alb, srgb('#6e3f22'), np.clip(rust, 0, 1) * 0.8); rough = lerp(rough, 0.85, np.clip(rust, 0, 1))
    return slot, alb, hgt, rough


# ------------------------------------------------------------------ detail regions
def paint_region(name, rect, seed):
    h, w = _shape(rect); r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.3, seed, fmin=2, fmax=60, shape=(h, w)); f = spectral(0, 0.5, seed + 1, fmin=30, shape=(h, w))
    rough = np.full((h, w), 0.85, np.float32); metal = np.zeros((h, w), np.float32); hgt = f * 0.3
    if name.startswith('brick_sec_'):
        col = name.split('_')[-1]
        # broken through-section: u along the edge (2 m), v = depth. Brick ends + mortar joints both ways
        um = xx / w * 2.0; vm = yy / h * T
        jb = (np.abs(((um + 0.5 * (np.floor(vm / 0.125) % 2) * 0.13) % 0.13) - 0.065) > 0.058) | (np.abs((vm % 0.125) - 0.0625) > 0.056)
        tone = r.random(1000)[((np.floor(um / 0.13) * 13 + np.floor(vm / 0.125) * 7).astype(int)) % 1000]
        b = colorize(np.clip(tone * 0.7 + 0.15 * norm01(f), 0, 1), BRICK[col]['stops'])
        b = lerp(b, srgb(BRICK[col]['inner']), 0.3)
        alb = lerp(b, srgb(BRICK[col]['mortar']) * 0.85, jb.astype(np.float32))
        hgt = (1 - jb) * 1.5 + f * 0.8
        alb = lerp(alb, srgb('#1d1a17'), np.clip(0.4 + 0.4 * n, 0, 1) * 0.55)    # dust + soot
        rough[:] = 0.95
    elif name == 'rubble':
        # tileable dusty debris ground: chunks of concrete, brick bits, plaster, dust
        F1, F2, ids = voronoi(0, 700, seed + 2, shape=(h, w))
        kind = r.random(700)[ids]; tone = r.random(700)[ids]
        grey = colorize(tone, [(0, '#5f5b54'), (0.5, '#78736b'), (1, '#8e897f')])
        col = np.where((kind < 0.82)[..., None], grey,
                       np.where((kind < 0.9)[..., None], colorize(tone, [(0, '#6a4a3c'), (1, '#7c5a48')]),
                                np.where((kind < 0.96)[..., None], srgb('#a39d91') + np.zeros((h, w, 3)), srgb('#3e3a35') + np.zeros((h, w, 3)))))
        edge = smoothstep(3.0, 0.5, F2 - F1)
        alb = lerp(col, srgb('#3a3631'), edge * 0.6)
        dust = smoothstep(-0.6, 1.0, n)
        alb = lerp(alb, srgb('#8a857b'), dust * 0.5)
        hgt = (1 - edge) * 3 + f; rough[:] = 0.97
    elif name == 'shutter':
        # galvanised roller shutter slats (55 mm), rust, dents, a graffiti scrawl
        slat = (yy % 13.6) / 13.6
        prof = np.sin(slat * np.pi * 2) * 0.5 + 0.5
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#7f817c'), (1, '#9ea09a')]) * (0.82 + 0.18 * prof)[..., None]
        alb = lerp(alb, srgb('#6a3c1f'), smoothstep(0.6, 1.6, n) * smoothstep(0.3, 1.0, yy / h) * 0.7)
        alb = lerp(alb, srgb('#3a3a38'), (slat < 0.08)[..., None] * 0.6)
        img = Image.fromarray(to8(alb)); d = ImageDraw.Draw(img)
        pts = [(w * 0.15, h * 0.55)]
        for k in range(14):
            pts.append((pts[-1][0] + r.uniform(6, 16), h * 0.55 + r.normal(0, 14)))
        alb = np.asarray(img).astype(np.float32) / 255
        hgt = prof * 2; metal[:] = 0.55; rough[:] = 0.55
    elif name == 'shop_glass':
        # dark shop interior: shelves with goods, a counter, posters on the glass, sky reflection
        alb = colorize(norm01(n), [(0, '#0e1012'), (1, '#1c2124')]) + np.zeros((h, w, 3), np.float32)
        for k in range(4):
            y0 = int(h * (0.25 + 0.17 * k))
            alb[y0:y0 + 3] = srgb('#55534c')
            goods = r.random(w // 6)
            for j, g in enumerate(goods):
                if g > 0.35:
                    c = srgb(['#6b4a2a', '#7a2e2a', '#2d4a6b', '#b8a46a', '#4a6b3a'][int(g * 13) % 5]) * 0.6
                    alb[max(0, y0 - int(8 + g * 10)):y0, j * 6:j * 6 + 5] = c
        img = Image.fromarray(to8(alb)); d = ImageDraw.Draw(img)
        d.rectangle([w * 0.62, h * 0.08, w * 0.92, h * 0.3], fill=(214, 200, 60))
        d.text((w * 0.64, h * 0.13), 'ЗНИЖКИ', fill=(170, 30, 30), font=ImageFont.truetype(FONT_B, 13))
        d.rectangle([w * 0.06, h * 0.06, w * 0.34, h * 0.16], fill=(230, 230, 228))
        d.text((w * 0.075, h * 0.075), 'ВІДЧИНЕНО', fill=(30, 110, 50), font=ImageFont.truetype(FONT_B, 10))
        alb = np.asarray(img).astype(np.float32) / 255
        alb = lerp(alb, srgb('#8a97a2'), smoothstep(h * 0.9, 0, yy + xx * 0.4)[..., None] * 0.28)
        alb = lerp(alb, srgb('#6f6a60'), smoothstep(0.5, 1.5, f) * 0.25)
        rough[:] = 0.08
    elif name in ('brick_white', 'brick_red'):
        col = name.split('_')[1]
        xm = xx / w * 1.0; ym = (h - yy) / h * 1.0 * (36 / 35.99)
        bm, tone, _ = brick_pattern(xm, ym, 11)
        alb = lerp(srgb(BRICK[col]['mortar']) + np.zeros((h, w, 3)), colorize(tone, BRICK[col]['stops']), bm)
        alb = lerp(alb, srgb(BRICK[col]['dirt']), smoothstep(0.3, 1.5, n) * 0.25)
        hgt = bm * 1.5
    elif name == 'alu':
        alb = colorize(norm01(n), [(0, '#8d9091'), (1, '#b4b7b6')]); metal[:] = 0.7; rough[:] = 0.4
        alb = lerp(alb, srgb('#55524b'), smoothstep(0.8, 1.8, f) * 0.4)
    elif name == 'reveal':
        alb = colorize(norm01(n), [(0, '#b9b4a8'), (1, '#d6d1c4')]); alb = lerp(alb, srgb('#6d675c'), smoothstep(0.7, 1.8, f) * 0.4)
    elif name == 'sign_metal':
        alb = colorize(norm01(n), [(0, '#6c6f70'), (1, '#8b8e8d')]); alb = lerp(alb, srgb('#6e3f22'), smoothstep(0.7, 1.6, f) * 0.6)
        metal[:] = 0.5; rough[:] = 0.6
    elif name == 'lightbox':
        tube = (np.abs((yy % 40) - 20) < 3).astype(np.float32)
        alb = lerp(srgb('#2a2a28') + np.zeros((h, w, 3)), srgb('#cfcfc8'), tube); alb = lerp(alb, srgb('#111111'), smoothstep(0.3, 1.5, n) * 0.6)
    elif name == 'tile_granite':
        g = (r.random((h, w)) ** 6).astype(np.float32)
        alb = colorize(norm01(n * 0.3 + f * 0.3), [(0, '#6d655c'), (1, '#8b8278')]) + g[..., None] * 0.15; rough[:] = 0.45
    elif name == 'louvre':
        sl = (yy % 16) / 16
        alb = colorize(norm01(n), [(0, '#5b5f5c'), (1, '#777b77')]) * (0.6 + 0.4 * sl)[..., None]
        alb = lerp(alb, srgb('#6e3f22'), smoothstep(0.6, 1.6, f) * 0.6); hgt = sl * 3; metal[:] = 0.4; rough[:] = 0.6
    elif name == 'conc_vent':
        alb = colorize(norm01(n + f * 0.4), [(0, '#7c7870'), (1, '#9a958b')])
        alb = lerp(alb, srgb('#3d3a35'), smoothstep(0.8, 1.8, n) * 0.5)
    elif name == 'roof_door':
        alb = srgb('#5e6a5c') * (0.85 + 0.15 * norm01(n))[..., None] + np.zeros((h, w, 3))
        alb = lerp(alb, srgb('#6e3f22'), smoothstep(0.4, 1.4, f) * 0.7); metal[:] = 0.4; rough[:] = 0.6
        img = Image.fromarray(to8(alb)); d = ImageDraw.Draw(img)
        d.polygon([(w * 0.5, h * 0.1), (w * 0.85, h * 0.45), (w * 0.15, h * 0.45)], fill=(220, 190, 30), outline=(20, 20, 20))
        d.line([(w * 0.52, h * 0.18), (w * 0.44, h * 0.3), (w * 0.56, h * 0.3), (w * 0.48, h * 0.42)], fill=(20, 20, 20), width=3)
        alb = np.asarray(img).astype(np.float32) / 255
    elif name == 'antenna':
        alb = colorize(norm01(n), [(0, '#7e807e'), (1, '#a3a6a3')]); metal[:] = 0.8; rough[:] = 0.45
    elif name == 'rust':
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#3d2418'), (0.5, '#6a3a20'), (1, '#8a5a3a')]); metal[:] = 0.3; rough[:] = 0.85
    elif name == 'dust':
        alb = colorize(norm01(n + f * 0.6), [(0, '#7f7a72'), (1, '#a39e94')]); rough[:] = 0.97
    elif name == 'cable':
        alb = colorize(norm01(n), [(0, '#151514'), (1, '#262624')]); rough[:] = 0.6
    elif name == 'tarp':
        alb = colorize(norm01(n), [(0, '#2a4e7a'), (1, '#3c679a')]); alb = lerp(alb, srgb('#2a2620'), smoothstep(0.5, 1.6, f) * 0.5); rough[:] = 0.8
    elif name == 'mastic':
        alb = colorize(norm01(f), [(0, '#1e1d1b'), (1, '#33312d')]); rough[:] = 0.75
    else:
        alb = colorize(norm01(n), [(0, '#555555'), (1, '#777777')])
    return alb.astype(np.float32), hgt.astype(np.float32), np.clip(rough, 0, 1), metal


def build_atlas():
    A = KA.Atlas()
    for ci, col in enumerate(COLOURS):
        for si, st in enumerate(['intact', 'damaged', 'holed']):
            for ti, t in enumerate(BTYPES):
                alb, hgt, rough = paint_brick(col, t, st, 3000 + ci * 100 + si * 10 + ti)
                A.put(cell_rect(cell_index_brick(col, t, st)), alb, hgt, rough)
    for ti, t in enumerate(SHOP_TYPES):
        for si, st in enumerate(['intact', 'damaged', 'holed']):
            alb, hgt, rough = paint_shop(t, st, 3300 + ti * 10 + si)
            A.put(cell_rect(cell_index_shop(t, st)), alb, hgt, rough)
    for k in range(len(SIGNS)):
        slot, alb, hgt, rough = paint_sign(k, 3400 + k)
        A.put(slot, alb, hgt, rough)
    for i, (name, rect) in enumerate(REG.items()):
        alb, hgt, rough, metal = paint_region(name, rect, 3500 + i)
        A.put(rect, alb, hgt, rough, metal)
    return A.save('kit_atlas_city')


if __name__ == '__main__':
    import time; t0 = time.time()
    p = build_atlas(); print(p, time.time() - t0)
