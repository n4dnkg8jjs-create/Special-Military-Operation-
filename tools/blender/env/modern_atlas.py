"""Modern microdistrict atlas (2048^2, 256 px grid) for modern.glb, material 'modern_atlas', plus the 1024^2 RGBA
alpha atlas 'modern_alpha' (anti-drone netting, cracked / shot-out glazing).
Regions shared with the city / farmland look are painted by city_atlas.paint() / farmland_atlas.paint() with the same
seeds.  Car regions (512x256) hold side view (t 0.4..1), top view (s 0..0.5, t 0..0.4), front (s 0.5..0.75) and rear
(s 0.75..1) of one model, projected by modern_geo.CarUV from the CARS spec below (front = +X).
Output: _cache/modern_atlas_{albedo.jpg,normal.png,orm.png}, _cache/modern_alpha_{albedo.png,normal.png,orm.png}.
Run standalone to repaint.
"""
import os
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont
from texlib import (spectral, norm01, colorize, srgb, lerp, to8, normal_from_height, smoothstep, blur, CACHE,
                    quantize_normal, voronoi, rng, cavity_ao, bake_shade, stamp_disc)
import texlib
import city_atlas as CA
import farmland_atlas as FA
import burnt_tex as B
from meshlib import blob



def _sorted_box(fn):
    def g(self, xy, *a, **k):
        if len(xy) == 4 and not isinstance(xy[0], (tuple, list)):
            x0, y0, x1, y1 = xy; xy = [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]
        elif len(xy) == 2 and isinstance(xy[0], (tuple, list)):
            (x0, y0), (x1, y1) = xy; xy = [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]
        return fn(self, xy, *a, **k)
    return g


class _Draw(ImageDraw.ImageDraw):
    """ImageDraw that accepts boxes with corners in any order (car layouts are written in metres)."""
    rectangle = _sorted_box(ImageDraw.ImageDraw.rectangle)
    ellipse = _sorted_box(ImageDraw.ImageDraw.ellipse)


def Draw(img):
    return _Draw(img)


S = 2048
C = 256
PAD = 12     # gutter: every region is painted 12 px smaller and wrap-padded, UVs inset by the same amount, so tiled
             # regions repeat seamlessly and mip levels up to ~3-4 sample the region's own wrapped texels, not neighbours
GRID = [
    ['facade_peach', 'facade_mint', 'facade_soot', 'plinth', 'window_pvc', 'window_taped', 'window_burnt', 'door_board'],
    ['roof_metal', 'roof_membrane', 'sandwich', 'sandwich_burnt', 'brick_red', 'brick_white', 'concrete', 'fbs'],
    ['sign_products', 'sign_products+', 'sign_market', 'sign_market+', 'glass_shop', 'glass_shop_broken', 'pharm_panel', 'ad_poster'],
    ['car_hatch', 'car_hatch+', 'car_suv', 'car_suv+', 'car_van', 'car_van+', 'decals', 'car_glass'],
    ['car_hatch_burnt', 'car_hatch_burnt+', 'car_suv_burnt', 'car_suv_burnt+', 'car_van_burnt', 'car_van_burnt+', 'interior_burnt', 'rim_burnt'],
    ['bus_burnt', 'bus_burnt+', 'bus_burnt+', 'bus_burnt+', 'steel_galv', 'steel_dark', 'plastic_play', 'rubber_mat'],
    ['wood_slats', 'garage_door', 'garage_burnt', 'interior_dark', 'asphalt', 'steel_rust', 'tyre_car', 'bin_euro'],
    ['sandbag', 'ash', 'soot', 'glass_dark', 'metal_grey', 'paint_white', 'ground', 'lamp_parts'],
]
REG = {}
for j, row in enumerate(GRID):
    i = 0
    while i < len(row):
        n = row[i]; w = 1
        while i + w < len(row) and row[i + w] == n + '+':
            w += 1
        REG[n] = (i * C, j * C, (i + w) * C, j * C + C)
        i += w
SHARED_CA = {'brick_red', 'brick_white', 'concrete', 'soot', 'glass_dark', 'metal_grey', 'paint_white', 'ground'}
SHARED_FA = {'sandbag', 'ash'}
FONT_B = CA.FONT_B
FONT_C = CA.FONT_C

# ------------------------------------------------------------------ car spec (shared with modern_geo)
# lower body sections (x, y_bottom, y_top, half_width) front -> rear; greenhouse: base ring at 'belt' from gx[0] (front)
# to gx[1] (rear), roof ring at H from gx[2] to gx[3]; gw = (half width at belt, at roof); r = wheel radius;
# axles = (front x, rear x); doors = x of door seams; paint = body colour.
CARS = {
    'hatch': dict(L=4.07, W=1.68, H=1.43, r=0.29, axles=(1.22, -1.30), belt=0.88, gx=(0.95, -1.80, 0.12, -1.52), gw=(0.80, 0.62),
                  low=[(2.035, 0.30, 0.62, 0.76), (1.95, 0.22, 0.72, 0.82), (1.45, 0.20, 0.82, 0.84), (0.95, 0.20, 0.88, 0.84),
                       (-1.35, 0.20, 0.90, 0.84), (-1.85, 0.22, 0.90, 0.82), (-2.035, 0.30, 0.86, 0.76)],
                  doors=(0.92, -0.16, -1.22), paint='#6e1f24', name='hatch'),
    'suv': dict(L=4.32, W=1.80, H=1.65, r=0.34, axles=(1.33, -1.34), belt=1.02, gx=(1.05, -2.06, 0.22, -1.98), gw=(0.88, 0.72),
                low=[(2.16, 0.36, 0.78, 0.82), (2.06, 0.30, 0.90, 0.88), (1.55, 0.30, 0.98, 0.90), (1.05, 0.30, 1.02, 0.90),
                     (-1.60, 0.30, 1.03, 0.90), (-2.06, 0.32, 1.02, 0.88), (-2.16, 0.38, 0.96, 0.82)],
                doors=(1.02, -0.12, -1.25), paint='#8d9196', name='suv'),
    'van': dict(L=5.93, W=1.99, H=2.62, r=0.35, axles=(2.02, -1.64), belt=1.12, gx=(2.12, -2.96, 1.06, -2.94), gw=(0.99, 0.93),
                low=[(2.965, 0.36, 0.78, 0.92), (2.88, 0.30, 0.98, 0.97), (2.45, 0.30, 1.08, 0.99), (2.12, 0.30, 1.12, 0.99),
                     (-2.80, 0.32, 1.12, 0.99), (-2.965, 0.36, 1.10, 0.96)],
                doors=(2.10, 1.10, 0.25, -1.0), paint='#e4e5e1', name='van'),
    'bus': dict(L=12.0, W=2.55, H=3.05, r=0.50, axles=(3.55, -2.35), belt=1.05, gx=(5.97, -5.97, 5.86, -5.92), gw=(1.27, 1.21),
                low=[(6.0, 0.30, 0.95, 1.22), (5.97, 0.28, 1.05, 1.275), (-5.97, 0.28, 1.05, 1.275), (-6.0, 0.30, 0.98, 1.22)],
                doors=((4.75, 5.8), (0.2, 1.4), (-3.9, -2.7)), paint='#c8c5bc', name='bus'),
}


class CarPx:
    """Pixel mapping of a car region of size (h, w): side / top / front / rear areas (see module doc)."""
    def __init__(self, spec, h, w):
        self.c = spec; self.h = h; self.w = w; self.L = spec['L']; self.W = spec['W']; self.H = spec['H']

    def sx(self, x):
        return (x + self.L / 2) / self.L * self.w

    def sy(self, y):
        return (1 - (0.4 + 0.6 * y / self.H)) * self.h

    def tx(self, x):
        return 0.5 * (x + self.L / 2) / self.L * self.w

    def tz(self, z):
        return (1 - 0.4 * (z + self.W / 2) / self.W) * self.h

    def fz(self, z, rear=False):
        if rear:
            return (0.75 + 0.25 * (z + self.W / 2) / self.W) * self.w
        return (0.5 + 0.25 * (self.W / 2 - z) / self.W) * self.w

    def fy(self, y):
        return (1 - 0.4 * y / self.H) * self.h


def _pil(a):
    return Image.fromarray(to8(a))


def _arr(img):
    return np.asarray(img.convert('RGB')).astype(np.float32) / 255


def car_paint(name, shape, seed, burnt=False):
    """Intact: body colour with door seams, handles, glazing, lights, plastic bumpers; burnt: burnt_steel with soot
    plumes over the wheel arches / window openings, ash on the bonnet and roof, gutted lights."""
    spec = CARS[name]; h, w = shape; P = CarPx(spec, h, w)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    L, W, H = spec['L'], spec['W'], spec['H']; belt = spec['belt']; gx = spec['gx']
    lines = Image.new('L', (w, h), 0); dl = Draw(lines)           # dark seams (both looks)
    glass = Image.new('L', (w, h), 0); dg = Draw(glass)            # glazing mask
    plast = Image.new('L', (w, h), 0); dp = Draw(plast)            # black plastic trim
    lamps = Image.new('RGB', (w, h), (0, 0, 0)); dla = Draw(lamps)
    lampm = Image.new('L', (w, h), 0); dlm = Draw(lampm)
    x0f, x1f = L / 2, -L / 2
    big = name in ('van', 'bus')
    # ---- side view
    m = 0.05
    if name == 'bus':
        # window band: big panes between pillars, doors (glazed) down to the floor
        dg.rectangle([P.sx(-5.9), P.sy(H - 0.38), P.sx(5.9), P.sy(belt + 0.04)], fill=255)
        for x in np.arange(-5.9, 5.95, 1.32):
            dp.rectangle([P.sx(x) - 3, P.sy(H - 0.38), P.sx(x) + 3, P.sy(belt)], fill=255)
        for a, b in spec['doors']:
            dg.rectangle([P.sx(a), P.sy(H - 0.45), P.sx(b), P.sy(0.38)], fill=255)
            dl.rectangle([P.sx(a) - 1, P.sy(H - 0.42), P.sx(b) + 1, P.sy(0.34)], outline=255, width=2)
            dl.line([(P.sx((a + b) / 2), P.sy(H - 0.42)), (P.sx((a + b) / 2), P.sy(0.34))], fill=255, width=2)
        dp.rectangle([0, P.sy(H) - 1, w, P.sy(H - 0.3)], fill=180)                  # roof edge trim
        dp.rectangle([0, P.sy(0.42), w, P.sy(0.26)], fill=200)                      # skirt
        dla.rectangle([P.sx(5.9), P.sy(0.85), P.sx(6.0), P.sy(0.65)], fill=(230, 160, 40)); dlm.rectangle([P.sx(5.9), P.sy(0.85), P.sx(6.0), P.sy(0.65)], fill=255)
    else:
        # greenhouse trapezoid (side glass), pillars
        xa, xd, xb, xc = gx
        if name == 'van':
            # cab door window + one sliding-door window, rest is panel
            dg.polygon([(P.sx(xa - 0.12), P.sy(belt + m)), (P.sx(1.25), P.sy(belt + m)), (P.sx(1.25), P.sy(2.05)), (P.sx(xb + 0.45), P.sy(2.05))], fill=255)
            dg.rectangle([P.sx(-0.05), P.sy(2.0), P.sx(0.95), P.sy(belt + 0.1)], fill=255)
            dl.line([(P.sx(1.1), P.sy(0.3)), (P.sx(1.1), P.sy(2.2))], fill=255, width=2)
            for x in spec['doors'][2:]:
                dl.line([(P.sx(x), P.sy(0.32)), (P.sx(x), P.sy(H - 0.12))], fill=255, width=2)
            dl.line([(P.sx(2.1), P.sy(0.42)), (P.sx(2.1), P.sy(belt))], fill=255, width=2)
            dp.rectangle([P.sx(-1.0) + 2, P.sy(1.06), P.sx(0.25) - 2, P.sy(1.0)], fill=255)   # slide rail
        else:
            ft = lambda f: (xa + (xb - xa) * f, belt + (H - belt) * f)
            rt = lambda f: (xd + (xc - xd) * f, belt + (H - belt) * f)
            pa, pb = ft(0.06), ft(0.9); pd, pc = rt(0.06), rt(0.9)
            dg.polygon([(P.sx(pa[0] - 0.05), P.sy(pa[1])), (P.sx(pb[0] - 0.05), P.sy(pb[1])), (P.sx(pc[0] + 0.08), P.sy(pc[1])), (P.sx(pd[0] + 0.12), P.sy(pd[1]))], fill=255)
            bx = spec['doors'][1]
            dp.polygon([(P.sx(bx) - 4, P.sy(belt)), (P.sx(bx) + 4, P.sy(belt)), (P.sx(bx - 0.06) + 4, P.sy(H - 0.06)), (P.sx(bx - 0.06) - 4, P.sy(H - 0.06))], fill=255)
            cx = spec['doors'][2] - 0.1
            dp.polygon([(P.sx(cx) - 3, P.sy(belt)), (P.sx(cx) + 3, P.sy(belt)), (P.sx(cx + 0.05) + 3, P.sy(H - 0.08)), (P.sx(cx + 0.05) - 3, P.sy(H - 0.08))], fill=200)
            for x in spec['doors']:
                dl.line([(P.sx(x), P.sy(0.3)), (P.sx(x - 0.04), P.sy(belt))], fill=255, width=2)
            dl.line([(P.sx(spec['doors'][0]), P.sy(0.3)), (P.sx(spec['doors'][-1]), P.sy(0.3))], fill=180, width=1)
            for x in spec['doors'][:2]:
                dp.rectangle([P.sx(x - 0.22), P.sy(belt - 0.1), P.sx(x - 0.08), P.sy(belt - 0.13)], fill=255)   # handles
            if name == 'suv':   # black plastic arch cladding + sill, roof rails
                for ax in spec['axles']:
                    dp.ellipse([P.sx(ax - spec['r'] - 0.16), P.sy(spec['r'] + 0.42), P.sx(ax + spec['r'] + 0.16), P.sy(spec['r'] - 0.42)], fill=255)
                dp.rectangle([P.sx(-1.6), P.sy(0.48), P.sx(1.5), P.sy(0.30)], fill=255)
        # bumpers (plastic, lower front / rear corners)
        dp.rectangle([P.sx(x0f - 0.25), P.sy(0.62 if not big else 0.75), w, P.sy(0.25)], fill=170)
        dp.rectangle([0, P.sy(0.6 if not big else 0.7), P.sx(x1f + 0.22), P.sy(0.25)], fill=170)
        # lights on the side corners
        dla.rectangle([P.sx(x0f - 0.18), P.sy(0.84 if not big else 1.05), w, P.sy(0.66 if not big else 0.85)], fill=(200, 200, 196)); dlm.rectangle([P.sx(x0f - 0.18), P.sy(0.84 if not big else 1.05), w, P.sy(0.66 if not big else 0.85)], fill=255)
        dla.rectangle([0, P.sy(0.92 if not big else 1.2), P.sx(x1f + 0.07), P.sy(0.7 if not big else 0.8)], fill=(150, 26, 24)); dlm.rectangle([0, P.sy(0.92 if not big else 1.2), P.sx(x1f + 0.07), P.sy(0.7 if not big else 0.8)], fill=255)
    for ax in spec['axles']:   # wheel arch shadow
        rr = spec['r'] + 0.06
        dl.ellipse([P.sx(ax - rr), P.sy(spec['r'] + rr), P.sx(ax + rr), P.sy(spec['r'] - rr)], fill=255)
    # ---- top view: bonnet / windscreen / roof / rear glass
    zl, zr = P.tz(W / 2 - 0.06), P.tz(-W / 2 + 0.06)
    xa, xd, xb, xc = gx
    if name == 'bus':
        for k, (x0_, x1_) in enumerate(((-5.0, -3.6), (-1.2, 0.4), (2.0, 3.6))):    # roof pods (HVAC, batteries)
            dl.rectangle([P.tx(x0_), P.tz(0.7), P.tx(x1_), P.tz(-0.7)], outline=255, width=2)
    elif name == 'van':
        dl.line([(P.tx(xb), zl), (P.tx(xb), zr)], fill=255, width=2)
    else:
        # glass lands in the top projection when its face normal is y-dominant (run > rise), else front / rear
        if (xa - xb) > (H - belt):
            dg.polygon([(P.tx(xa - 0.03), P.tz(spec['gw'][0] - 0.06)), (P.tx(xb + 0.03), P.tz(spec['gw'][1] - 0.04)),
                        (P.tx(xb + 0.03), P.tz(-spec['gw'][1] + 0.04)), (P.tx(xa - 0.03), P.tz(-spec['gw'][0] + 0.06))], fill=255)
        if (xc - xd) > (H - belt):
            dg.polygon([(P.tx(xc - 0.03), P.tz(spec['gw'][1] - 0.05)), (P.tx(xd + 0.05), P.tz(spec['gw'][0] - 0.07)),
                        (P.tx(xd + 0.05), P.tz(-spec['gw'][0] + 0.07)), (P.tx(xc - 0.03), P.tz(-spec['gw'][1] + 0.05))], fill=255)
        dl.line([(P.tx(xa + 0.55), P.tz(0.7)), (P.tx(L / 2 - 0.15), P.tz(0.62))], fill=150, width=1)    # bonnet seams
        dl.line([(P.tx(xa + 0.55), P.tz(-0.7)), (P.tx(L / 2 - 0.15), P.tz(-0.62))], fill=150, width=1)
        if name == 'suv':
            for zz in (0.62, -0.62):
                dp.rectangle([P.tx(xc + 0.1), P.tz(zz) - 3, P.tx(xb - 0.1), P.tz(zz) + 3], fill=255)
    # ---- front / rear faces
    fy = P.fy
    if name == 'bus':
        dg.rectangle([P.fz(1.15), fy(H - 0.2), P.fz(-1.15), fy(1.0)], fill=255)
        dp.rectangle([P.fz(1.1), fy(H - 0.22), P.fz(-1.1), fy(H - 0.5)], fill=255)        # destination display
        for zz in (0.95, -0.95):
            dla.rectangle([P.fz(zz) - 9, fy(0.75), P.fz(zz) + 9, fy(0.55)], fill=(205, 205, 200)); dlm.rectangle([P.fz(zz) - 9, fy(0.75), P.fz(zz) + 9, fy(0.55)], fill=255)
            dla.rectangle([P.fz(zz, True) - 8, fy(1.2), P.fz(zz, True) + 8, fy(0.7)], fill=(150, 26, 24)); dlm.rectangle([P.fz(zz, True) - 8, fy(1.2), P.fz(zz, True) + 8, fy(0.7)], fill=255)
        dg.rectangle([P.fz(1.0, True), fy(H - 0.3), P.fz(-1.0, True), fy(1.9)], fill=200)
        dl.rectangle([P.fz(1.15, True), fy(1.6), P.fz(-1.15, True), fy(0.5)], outline=255, width=2)   # engine flap
    else:
        top_ = spec['low'][0][2]
        # grille + headlights + plate
        dp.rectangle([P.fz(0.42 if not big else 0.55), fy(top_ - 0.05), P.fz(-0.42 if not big else -0.55), fy(top_ - 0.22)], fill=255)
        for zz in (W / 2 - 0.22, -W / 2 + 0.22):
            dla.rectangle([P.fz(zz) - 11, fy(top_ + 0.02), P.fz(zz) + 11, fy(top_ - 0.12)], fill=(210, 212, 210)); dlm.rectangle([P.fz(zz) - 11, fy(top_ + 0.02), P.fz(zz) + 11, fy(top_ - 0.12)], fill=255)
            dla.rectangle([P.fz(zz, True) - 9, fy(spec['low'][-1][2] - 0.04), P.fz(zz, True) + 9, fy(spec['low'][-1][2] - 0.24)], fill=(150, 26, 24)); dlm.rectangle([P.fz(zz, True) - 9, fy(spec['low'][-1][2] - 0.04), P.fz(zz, True) + 9, fy(spec['low'][-1][2] - 0.24)], fill=255)
        dp.rectangle([P.fz(W / 2), fy(0.5), P.fz(-W / 2), fy(0.2)], fill=160)
        dp.rectangle([P.fz(W / 2, True), fy(0.5), P.fz(-W / 2, True), fy(0.2)], fill=160)
        for rear in (False, True):
            dla.rectangle([P.fz(0.26, rear), fy(0.46), P.fz(-0.26, rear), fy(0.36)], fill=(226, 226, 222)); dlm.rectangle([P.fz(0.26, rear), fy(0.46), P.fz(-0.26, rear), fy(0.36)], fill=255)
        if name == 'van':
            dg.rectangle([P.fz(spec['gw'][1] - 0.06), fy(2.0), P.fz(-spec['gw'][1] + 0.06), fy(belt + 0.1)], fill=255)      # windscreen (front-projected)
            dg.rectangle([P.fz(0.9, True), fy(2.25), P.fz(0.06, True), fy(1.35)], fill=255)
            dg.rectangle([P.fz(-0.06, True), fy(2.25), P.fz(-0.9, True), fy(1.35)], fill=255)
            dl.line([(P.fz(0, True), fy(2.5)), (P.fz(0, True), fy(0.5))], fill=255, width=2)
        else:
            if (xa - xb) <= (H - belt):
                dg.rectangle([P.fz(spec['gw'][1] - 0.04), fy(H - 0.06), P.fz(-spec['gw'][1] + 0.04), fy(belt + 0.05)], fill=255)
            if (xc - xd) <= (H - belt):             # near-vertical tailgate glass in the rear projection
                dg.rectangle([P.fz(spec['gw'][1] - 0.04, True), fy(H - 0.06), P.fz(-spec['gw'][1] + 0.04, True), fy(belt + 0.05)], fill=255)
            dl.line([(P.fz(W / 2 - 0.1, True), fy(belt - 0.02)), (P.fz(-W / 2 + 0.1, True), fy(belt - 0.02))], fill=200, width=2)
    lines = np.asarray(lines, np.float32) / 255; glass = np.asarray(glass, np.float32) / 255
    plast = np.asarray(plast, np.float32) / 255; lampm = np.asarray(lampm, np.float32) / 255; lampc = np.asarray(lamps, np.float32) / 255
    n = spectral(0, 1.3, seed, fmin=3, fmax=60, shape=shape); f = spectral(0, 0.5, seed + 1, fmin=30, shape=shape)
    side = (yy < 0.6 * h).astype(np.float32)
    if not burnt:
        col = srgb(spec['paint'])
        alb = col * (0.92 + 0.08 * norm01(f))[..., None] + np.zeros(shape + (3,))
        # dust low on the body, a little grime
        alb = lerp(alb, srgb('#8a8070'), (smoothstep(P.sy(0.7), P.sy(0.25), yy) * side)[..., None] * 0.35)
        alb = lerp(alb, srgb('#5a554c'), smoothstep(0.9, 1.8, n) * 0.15)
        alb = lerp(alb, srgb('#26282a'), plast * 0.92)
        gl = colorize(norm01(n * 0.3 + f * 0.2) * 0.6 + norm01(-yy) * 0.4, [(0, '#16191c'), (0.6, '#2a3238'), (1, '#55636c')])
        alb = lerp(alb, gl, glass)
        alb = lerp(alb, lampc, lampm)
        alb = lerp(alb, srgb('#111111'), lines * 0.85)
        rough = 0.35 + plast * 0.45 - glass * 0.25 + lines * 0.3
        metal = 0.25 * (1 - plast) * (1 - glass)
        hgt = -lines * 2 + glass * 0.3
        if name == 'bus':
            alb = lerp(alb, srgb('#2e6fae'), ((yy > P.sy(0.95)) & (yy < P.sy(0.8)) & (yy < 0.6 * h)).astype(np.float32)[..., None] * 0.9)
    else:
        soot = np.zeros(shape, np.float32)
        soot += smoothstep(P.sy(0.65), P.sy(0.25), yy) * side * 0.7            # sills / skirts
        soot += smoothstep(P.sy(belt - 0.12), P.sy(belt + 0.05), yy) * smoothstep(P.sy(belt + 0.4), P.sy(belt + 0.05), yy) * side * 0.45
        for ax in spec['axles']:
            B.plume(soot, P.sx(ax), P.sy(spec['r'] + 0.3), (spec['r'] * 2.4) / L * w, P.sy(spec['r']) - P.sy(belt + 0.25), 0.85)
        # plumes above the window openings onto the roof edge / pillars
        top_band = smoothstep(P.sy(H - 0.25), P.sy(H), yy) * side
        soot += top_band * 0.55
        # top view: black around the window openings, ash on the bonnet and roof centre
        tv = (yy >= 0.6 * h) & (xx < 0.5 * w)
        edge = smoothstep(0.55, 0.95, np.abs((yy - P.tz(0)) / (0.2 * h)))
        soot += edge * tv * 0.6
        fr = (yy >= 0.6 * h) & (xx >= 0.5 * w)
        soot += fr * 0.35
        soot = np.clip(soot * (0.7 + 0.3 * norm01(spectral(0, 1.6, seed + 13, fmin=3, fmax=60, shape=shape))), 0, 1)
        keep = np.zeros(shape, np.float32)
        keep += smoothstep(P.sy(0.4), P.sy(0.55), yy) * smoothstep(P.sy(belt - 0.05), P.sy(0.6), yy) * side
        keep *= smoothstep(0.55, 1.0, norm01(spectral(0, 1.8, seed + 12, fmin=3, fmax=40, shape=shape)))
        alb, hgt, rough, metal = B.burnt_steel(shape, seed, ash=0.55, rust=0.06, paint=srgb(spec['paint']) * 0.75,
                                               paint_keep=keep * 0.8, low_soot=soot, wrap=False)
        # glazing gone: window areas black (only seen on frames), lamps gutted, plastic burnt off
        alb = lerp(alb, srgb('#0e0d0c'), np.clip(glass + lampm * 0.8 + plast * 0.5, 0, 1) * 0.9)
        alb = lerp(alb, srgb('#0b0a0a'), lines * 0.85)
        hgt = hgt - lines * 2
    return alb.astype(np.float32), hgt.astype(np.float32), np.clip(rough, 0, 1).astype(np.float32), np.asarray(metal, np.float32) + np.zeros(shape, np.float32)


def _sign(shape, text, bg, fg, seed, size=None, logo=None):
    h, w = shape
    img = Image.new('RGB', (w, h), bg); d = Draw(img)
    size = size or int(h * 0.62)
    f = ImageFont.truetype(FONT_B, size)
    tw = d.textlength(text, font=f)
    while tw > w * 0.9:
        size -= 4; f = ImageFont.truetype(FONT_B, size); tw = d.textlength(text, font=f)
    d.text(((w - tw) / 2, (h - size) / 2 - size * 0.12), text, fill=fg, font=f)
    d.rectangle([0, 0, w - 1, h - 1], outline=(220, 220, 214), width=6)
    return img


def paint(name, rect, seed):
    if name in SHARED_CA:
        cseed = 8000 + list(CA.REG).index(name) * 7
        return CA.paint(name, rect, cseed)
    if name in SHARED_FA:
        return FA.paint(name, rect, 9100 + list(FA.REG).index(name) * 7)
    x0, y0, x1, y1 = rect; shape = (y1 - y0, x1 - x0); h, w = shape; r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.3, seed, fmin=2, fmax=60, shape=shape); f = spectral(0, 0.5, seed + 1, fmin=30, shape=shape)
    rough = np.full(shape, 0.85, np.float32); metal = np.zeros(shape, np.float32); hgt = f * 0.3
    if name in ('facade_peach', 'facade_mint', 'facade_soot'):
        # insulated EIFS render ('koroid' bark-beetle texture) in 2010s pastel; region = 3 x 3.3 m, tiles seamlessly.
        col = {'facade_peach': '#e3b98f', 'facade_mint': '#b7d1bf', 'facade_soot': '#e3b98f'}[name]
        groove = blur((r.random(shape) > 0.985).astype(np.float32), (2.5, 0.5), True)
        alb = srgb(col) * (0.93 + 0.07 * norm01(n))[..., None] * (1 - 0.12 * np.clip(groove * 3, 0, 1))[..., None]
        alb = lerp(alb, srgb('#7d7262'), smoothstep(0.9, 1.9, spectral(0, 1.4, seed + 3, fmin=2, fmax=20, shape=shape)) * 0.12)
        hgt = -groove * 2 + f * 0.4; rough[:] = 0.92
        if name == 'facade_soot':
            # overlay above a burnt-out window (quad 2.1 x 2.4 m): soot plume rising from the bottom centre, fading
            # to the clean render at the edges so it blends into facade_peach
            m = np.zeros(shape, np.float32)
            B.plume(m, w / 2, h - 2, w * 0.62, h * 1.05, 1.15)
            m = np.clip(m * (0.75 + 0.35 * norm01(spectral(0, 1.4, seed + 5, fmin=3, fmax=40, shape=shape))), 0, 1)
            edge = smoothstep(0, w * 0.12, xx) * smoothstep(w, w * 0.88, xx) * smoothstep(0, h * 0.15, yy)
            alb = lerp(alb, srgb('#151312'), (m * edge) ** 0.8 * 0.95)
    elif name == 'plinth':
        # plinth cladding: dark grey granite-look porcelain tiles 0.6 x 0.3 m (region = 1.2 x 0.6 m)
        tw_, th_ = w / 2, h / 2
        gx_ = ((xx % tw_) < 2) | ((yy % th_) < 2)
        tile = ((xx // tw_) * 3 + (yy // th_) * 7) % 5
        alb = colorize(np.clip(norm01(f) * 0.6 + tile / 10, 0, 1), [(0, '#3f3e3b'), (1, '#5f5d58')])
        alb = lerp(alb, srgb('#9a978f'), (r.random(shape) > 0.97)[..., None] * 0.3)
        alb = lerp(alb, srgb('#2a2926'), gx_.astype(np.float32)[..., None])
        alb = lerp(alb, srgb('#6f6556'), smoothstep(h * 0.6, h, yy)[..., None] * 0.3)
        hgt = (1 - gx_) * 1.5; rough = 0.5 + gx_ * 0.4
    elif name in ('window_pvc', 'window_taped', 'window_burnt'):
        # 1.5 x 1.5 m two-light white PVC window (fixed + tilt/turn), reveal 'shadow' rim, sill;
        # taped: paper-tape asterisks on the glass (blast tape); burnt: frame melted away, black gutted room
        img = Image.new('RGB', (w, h), (205, 203, 196)); d = Draw(img)
        fr = 16
        d.rectangle([0, 0, w, h], fill=(232, 232, 228))
        panes = [(fr, fr, w // 2 - 6, h - fr), (w // 2 + 6, fr, w - fr, h - fr)]
        for (a, b, c, e) in panes:
            d.rectangle([a, b, c, e], fill=(48, 58, 66))
            d.polygon([(a, b), (a + (c - a) * 0.55, b), (a, b + (e - b) * 0.7)], fill=(78, 92, 102))
            # curtains / kids' paper cut-outs
            d.rectangle([a + 4, b + 4, a + (c - a) * 0.22, e - 4], fill=(186, 176, 150))
        d.rectangle([w // 2 - 6, 0, w // 2 + 6, h], fill=(226, 226, 222))
        alb = _arr(img)
        glass = np.zeros(shape, np.float32)
        for (a, b, c, e) in panes:
            glass[b:e, a:c] = 1
        if name == 'window_taped':
            tape = Image.new('L', (w, h), 0); dt = Draw(tape)
            for (a, b, c, e) in panes:
                cx, cy = (a + c) / 2, (b + e) / 2
                dt.line([(a + 3, b + 3), (c - 3, e - 3)], fill=255, width=7); dt.line([(c - 3, b + 3), (a + 3, e - 3)], fill=255, width=7)
                dt.line([(cx, b + 3), (cx, e - 3)], fill=255, width=7); dt.line([(a + 3, cy), (c - 3, cy)], fill=255, width=7)
            tape = np.asarray(tape, np.float32) / 255 * glass
            alb = lerp(alb, srgb('#d8d0b8'), tape * 0.92)
        alb = lerp(alb, srgb('#8a8478'), smoothstep(0.8, 1.7, n) * 0.18)
        rough = 0.5 - glass * 0.35; hgt = (1 - glass) * 1.0
        if name == 'window_burnt':
            dark = colorize(norm01(n * 0.5 + f * 0.5), [(0, '#070706'), (1, '#1a1816')])
            charf = np.clip(1 - glass, 0, 1) * smoothstep(0.3, 1.2, spectral(0, 1.2, seed + 3, fmin=4, fmax=40, shape=shape))
            alb = lerp(dark, colorize(norm01(f), [(0, '#1e1c1a'), (1, '#45423e')]), charf)
            alb = lerp(alb, srgb('#0d0c0b'), smoothstep(h * 0.5, 0, yy)[..., None] * 0.5)
            rough[:] = 0.95; hgt = charf
    elif name == 'door_board':
        # left half: brown metal entrance door 1.2 x 2.2 m with a small wired-glass light; right half: OSB board-up
        img = Image.new('RGB', (w, h), (92, 58, 40)); d = Draw(img)
        hw_ = w // 2
        d.rectangle([0, 0, hw_ - 1, h], fill=(96, 62, 42))
        d.rectangle([10, 10, hw_ - 10, h - 6], outline=(70, 44, 30), width=3)
        d.rectangle([28, 34, hw_ - 28, 110], fill=(42, 52, 58))
        d.rectangle([hw_ - 26, 130, hw_ - 16, 160], fill=(170, 166, 156))
        img2 = _pil(lerp(colorize(norm01(spectral(0, 0.8, seed + 5, fmin=20, fmax=160, shape=(h, w - hw_))), [(0, '#8a6a42'), (0.5, '#b08a58'), (1, '#c9a46c')]),
                         srgb('#5a4a36'), smoothstep(0.9, 1.8, spectral(0, 1.4, seed + 6, fmin=2, fmax=20, shape=(h, w - hw_))) * 0.3))
        dd = Draw(img2)
        for k in range(3):   # strands / flakes
            dd.line([(0, h * (0.33 * k + 0.02)), (w - hw_, h * (0.33 * k + 0.02))], fill=(60, 48, 36), width=3)
        dd.text((20, h * 0.45), 'ДІТИ', fill=(210, 210, 205), font=ImageFont.truetype(FONT_B, 28))
        img.paste(img2, (hw_, 0))
        alb = _arr(img); alb = lerp(alb, srgb('#4a4036'), smoothstep(0.8, 1.7, n) * 0.25)
        rough[:] = 0.7
    elif name == 'roof_metal':
        # standing-seam / profiled metal roofing, dark brown (RAL 8017), seams every 0.5 m; region = 2 x 2 m
        seam = np.abs(((xx / w * 4) % 1) - 0.5) * 2
        prof = smoothstep(0.92, 1.0, seam)
        alb = colorize(norm01(f * 0.5 + n * 0.5), [(0, '#3e2c24'), (1, '#4f3a2f')]) * (0.9 + 0.2 * prof)[..., None]
        alb = lerp(alb, srgb('#6e6458'), smoothstep(0.6, 1.8, spectral(0, 1.6, seed + 3, fmin=2, fmax=30, shape=shape)) * 0.18)
        hgt = prof * 3; metal[:] = 0.35; rough = 0.55 - prof * 0.1
    elif name == 'roof_membrane':
        # flat roof bitumen membrane, grey slate chips, overlap seams every 1 m; region 2 x 2 m
        lap = (np.abs((yy % (h / 2)) - 3) < 3).astype(np.float32)
        alb = colorize(norm01(f * 0.7 + n * 0.3), [(0, '#3d3c39'), (1, '#55534f')])
        alb = lerp(alb, srgb('#77746e'), (r.random(shape) > 0.9)[..., None] * 0.3)
        alb = lerp(alb, srgb('#2a2927'), lap * 0.6)
        alb = lerp(alb, srgb('#6a6658'), smoothstep(0.7, 1.7, n) * 0.25)
        hgt = lap * 1.2 + f * 0.2; rough[:] = 0.9
    elif name in ('sandwich', 'sandwich_burnt'):
        # horizontal insulated sandwich panels (light grey RAL 9002) 1 m high with micro-ribs; region 3 x 3 m
        rib = (np.sin(yy / h * 2 * np.pi * 15) * 0.5 + 0.5)
        joint = (np.abs((yy % (h / 3)) - 2) < 2.5).astype(np.float32)
        alb = colorize(norm01(f), [(0, '#c9cac5'), (1, '#dcddd8')]) * (0.94 + 0.06 * rib)[..., None]
        alb = lerp(alb, srgb('#55565a'), joint * 0.7)
        streak = np.clip(blur(spectral(0, 1.2, seed + 5, fmin=8, fmax=120, shape=shape), (25, 0.6), True) - 0.6, 0, 1)
        alb = lerp(alb, srgb('#7a7468'), streak * 0.35)
        hgt = rib * 0.6 - joint * 2; metal[:] = 0.2; rough[:] = 0.6
        if name == 'sandwich_burnt':
            # facing steel burnt to ash-white / black, foam core charred where the skin split
            bal, bh, br, bm = B.burnt_steel(shape, seed + 7, ash=0.5, rust=0.05, contrast=0.6, freq=0.7)
            split = smoothstep(1.2, 1.8, spectral(0, 1.8, seed + 8, fmin=2, fmax=24, shape=shape))
            alb = lerp(bal * (0.92 + 0.08 * rib)[..., None], srgb('#0c0b0a'), split)
            alb = lerp(alb, srgb('#1a1918'), joint * 0.8)
            hgt = bh + rib * 0.4 - joint * 2 - split; metal = bm; rough = br
    elif name == 'fbs':
        # FBS foundation block 2.4 x 0.6 x 0.6 (region = one 2.4 x 0.6 face on top half, 0.6 x 0.6 end in the bottom-left)
        alb = colorize(norm01(n + f * 0.5), [(0, '#7b776e'), (1, '#9c978c')])
        pits = np.zeros(shape, np.float32)
        for k in range(80):
            stamp_disc(pits, r.uniform(0, w), r.uniform(0, h), r.uniform(0.8, 2.5), 1, 1)
        alb = lerp(alb, srgb('#55524b'), pits * 0.8)
        edge = smoothstep(6, 0, np.minimum(np.minimum(xx, w - 1 - xx), np.minimum(yy % (h / 2), h / 2 - 1 - yy % (h / 2))))
        alb = lerp(alb, srgb('#5d5a52'), edge * 0.4)
        alb = lerp(alb, srgb('#4c4a40'), smoothstep(0.9, 1.8, spectral(0, 1.6, seed + 3, fmin=2, fmax=20, shape=shape)) * 0.35)
        img = _pil(alb); d = Draw(img)
        d.text((w * 0.08, h * 0.12), 'ФБС 24.6.6', fill=(70, 66, 60), font=ImageFont.truetype(FONT_C, 16))
        alb = _arr(img); hgt = -pits * 2 + f * 0.5 - edge; rough[:] = 0.93
    elif name in ('sign_products', 'sign_market'):
        img = _sign(shape, 'ПРОДУКТИ', (176, 28, 30), (255, 255, 250), seed) if name == 'sign_products' else \
            _sign(shape, 'МАРКЕТ', (24, 84, 150), (250, 214, 60), seed)
        alb = _arr(img)
        alb = lerp(alb, srgb('#5a5040'), smoothstep(0.9, 1.8, n) * 0.25)
        rough[:] = 0.4; metal[:] = 0.1
    elif name in ('glass_shop', 'glass_shop_broken'):
        # aluminium curtain-wall bay 2 x 3.5 m: transom at 2.6 m, dark-tinted glazing with sky reflection, promo posters;
        # broken: panes shot out -> dark interior with jagged shard rims, one boarded with OSB
        img = Image.new('RGB', (w, h), (150, 152, 152)); d = Draw(img)
        fr = 7
        tr = int(h * 0.26)
        lights = [(fr, fr, w - fr, tr - fr // 2), (fr, tr + fr // 2, w - fr, h - fr)]
        for i, (a, b, c, e) in enumerate(lights):
            d.rectangle([a, b, c, e], fill=(46, 56, 62))
            d.polygon([(a, b), (a + (c - a) * 0.6, b), (a, b + (e - b) * 0.5)], fill=(84, 98, 106))
        d.rectangle([fr + 18, tr + 40, w - fr - 120, tr + 140], fill=(220, 40, 40))
        d.text((fr + 26, tr + 70), '-30%', fill=(255, 250, 240), font=ImageFont.truetype(FONT_B, 34))
        alb = _arr(img)
        glass = np.zeros(shape, np.float32)
        for (a, b, c, e) in lights:
            glass[b:e, a:c] = 1
        rough = 0.6 - glass * 0.5; metal = (1 - glass) * 0.6; hgt = (1 - glass) * 1.5
        if name == 'glass_shop_broken':
            hole = np.zeros(shape, np.float32)
            for (a, b, c, e) in lights:
                pts = [(a + r.uniform(0, 0.15) * (c - a), b + r.uniform(0, 0.2) * (e - b)) for _ in range(1)]
                poly = []
                cx, cy = (a + c) / 2, (b + e) / 2
                for k in range(22):
                    ang = k / 22 * 2 * np.pi
                    rad = r.uniform(0.62, 0.98)
                    poly.append((cx + np.cos(ang) * (c - a) / 2 * rad, cy + np.sin(ang) * (e - b) / 2 * rad))
                hm = Image.new('L', (w, h), 0); Draw(hm).polygon(poly, fill=255)
                hole = np.maximum(hole, np.asarray(hm, np.float32) / 255)
            crack = texlib.random_walk_cracks(shape, 14, seed + 4, length=(20, 80), width=1.0, wrap=False) * glass
            dark = colorize(norm01(n), [(0, '#0a0a0a'), (1, '#1d1c1a')])
            alb = lerp(alb, srgb('#c9d0d2'), crack * 0.6)
            alb = lerp(alb, dark, hole)
            rough = np.maximum(rough, hole * 0.95)
    elif name == 'pharm_panel':
        # top half: 'АПТЕКА' fascia (green on white, green cross), bottom half: white composite panel with a green band
        alb = np.zeros(shape + (3,), np.float32) + srgb('#ecedea')
        img = _pil(alb); d = Draw(img)
        d.rectangle([0, 0, w, h // 2], fill=(244, 246, 242))
        cx, cy, s_ = 40, h // 4, 26
        d.rectangle([cx - s_ // 3, cy - s_, cx + s_ // 3, cy + s_], fill=(30, 150, 70)); d.rectangle([cx - s_, cy - s_ // 3, cx + s_, cy + s_ // 3], fill=(30, 150, 70))
        fnt = ImageFont.truetype(FONT_B, 40)
        d.text((76, cy - 26), 'АПТЕКА', fill=(26, 132, 62), font=fnt)
        d.rectangle([0, h // 2 + 64, w, h // 2 + 80], fill=(30, 150, 70))
        for x in (w // 3, 2 * w // 3):
            d.line([(x, h // 2), (x, h)], fill=(180, 182, 178), width=2)
        alb = _arr(img); alb = lerp(alb, srgb('#7a7468'), smoothstep(0.9, 1.8, n) * 0.2)
        rough[:] = 0.45; metal[:] = 0.2
    elif name == 'ad_poster':
        # pasted-over poster collage for the advertising column (u wraps around the column, v = 2.4 m height)
        img = Image.new('RGB', (w, h), (210, 205, 190)); d = Draw(img)
        fnt = ImageFont.truetype(FONT_C, 17); fb = ImageFont.truetype(FONT_C, 19)
        specs = [((0, 0, 92, 120), (30, 30, 34), 'КОНЦЕРТ', (240, 200, 60)), ((92, 0, 180, 90), (230, 230, 225), 'ЗДАМ\nКВАРТИРУ', (30, 30, 30)),
                 ((180, 0, 256, 130), (0, 87, 183), 'РАЗОМ', (255, 215, 0)), ((0, 120, 120, 256), (240, 236, 220), 'РОБОТА\nВОДІЙ', (180, 20, 20)),
                 ((120, 90, 256, 190), (200, 60, 40), 'ЦИРК', (255, 250, 240)), ((120, 190, 256, 256), (60, 120, 70), 'ДОНОР\nКРОВІ', (255, 255, 255))]
        for (a, b, c, e), bg, t, fg in specs:
            d.rectangle([a + 2, b + 2, c - 2, e - 2], fill=bg)
            d.multiline_text((a + 8, b + 10), t, fill=fg, font=fb if len(t) < 8 else fnt, spacing=2)
        alb = _arr(img)
        torn = smoothstep(1.0, 1.6, spectral(0, 1.6, seed + 3, fmin=3, fmax=40, shape=shape))
        alb = lerp(alb, srgb('#c9c3b2'), torn * 0.8)
        alb = lerp(alb, srgb('#6a6458'), smoothstep(0.8, 1.8, n) * 0.25); rough[:] = 0.9
    elif name in ('car_hatch', 'car_suv', 'car_van'):
        return car_paint(name[4:], shape, seed)
    elif name in ('car_hatch_burnt', 'car_suv_burnt', 'car_van_burnt'):
        return car_paint(name[4:-6], shape, seed, burnt=True)
    elif name == 'bus_burnt':
        return car_paint('bus', shape, seed, burnt=True)
    elif name == 'decals':
        # quadrants: TL red cross on white (medevac), TR green pharmacy cross (lit box face), BL red/white boom stripes,
        # BR yellow/black hazard chevrons
        img = Image.new('RGB', (w, h), (240, 240, 236)); d = Draw(img)
        q = w // 2
        cx, cy, s_ = q // 2, q // 2, 46
        d.rectangle([cx - s_ // 3, cy - s_, cx + s_ // 3, cy + s_], fill=(205, 30, 30)); d.rectangle([cx - s_, cy - s_ // 3, cx + s_, cy + s_ // 3], fill=(205, 30, 30))
        d.rectangle([q, 0, w, q], fill=(18, 18, 18))
        cx = q + q // 2
        d.rectangle([cx - s_ // 3, cy - s_, cx + s_ // 3, cy + s_], fill=(40, 200, 90)); d.rectangle([cx - s_, cy - s_ // 3, cx + s_, cy + s_ // 3], fill=(40, 200, 90))
        for k in range(4):
            d.rectangle([k * q // 4, q, k * q // 4 + q // 8, w], fill=(200, 30, 30))
        for k in range(-4, 8):
            d.polygon([(q + k * 32, h), (q + k * 32 + 16, h), (q + k * 32 + 16 + 64, q), (q + k * 32 + 64, q)], fill=(230, 190, 20))
        d.rectangle([q, q, q + 2, h], fill=(18, 18, 18))
        alb = _arr(img)
        alb[q:, q:] = lerp(srgb('#151515') + np.zeros((h - q, w - q, 3)), alb[q:, q:], (alb[q:, q:].sum(-1) > 1.2)[..., None].astype(np.float32))
        alb = lerp(alb, srgb('#6a6458'), smoothstep(1.0, 1.8, n) * 0.2); rough[:] = 0.5
    elif name == 'car_glass':
        alb = colorize(norm01(n), [(0, '#1a1e21'), (1, '#39444a')]); alb = lerp(alb, srgb('#7f8a90'), smoothstep(h, 0, yy)[..., None] * 0.25)
        rough[:] = 0.1
    elif name == 'interior_burnt':
        spring = ((np.sin(xx * 0.5) > 0.6) | (np.sin(yy * 0.5) > 0.6)).astype(np.float32)
        alb = colorize(norm01(n), [(0, '#0f0e0d'), (0.7, '#211f1d'), (1, '#383532')])
        alb = lerp(alb, srgb('#7d7973'), smoothstep(0.7, 1.7, f) * 0.45)
        alb = lerp(alb, colorize(norm01(f), [(0, '#45423f'), (0.8, '#5e5953'), (1, '#6a4a34')]), spring * 0.8)
        hgt = spring * 2; metal = spring * 0.35; rough[:] = 0.92
    elif name in ('rim_burnt', 'tyre_car'):
        # top 3/4: wheel face disc; bottom 1/4: tread / rim band (u around)
        cx, cy, R = w / 2, h * 0.375, h * 0.36
        d_ = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
        ang = np.arctan2(yy - cy, xx - cx)
        if name == 'tyre_car':
            alb = colorize(norm01(n), [(0, '#141414'), (1, '#262524')])
            rim = d_ < R * 0.62
            spokes = (np.cos(ang * 5) > 0.35) | (d_ < R * 0.2)
            alloy = colorize(norm01(f), [(0, '#8d9093'), (1, '#b9bcbe')])
            alb = np.where((rim & spokes)[..., None], alloy, alb)
            alb = np.where((rim & ~spokes)[..., None], srgb('#1b1c1d'), alb)
            alb = lerp(alb, srgb('#3a3a38'), (np.abs(d_ - R * 0.82) < 3).astype(np.float32)[..., None] * 0.5)
            band = yy > h * 0.75
            lug = ((xx % 14) < 8) & band
            alb = np.where(band[..., None], colorize(norm01(n), [(0, '#151515'), (1, '#2a2928')]) * (1 + 0.15 * lug)[..., None], alb)
            alb = lerp(alb, srgb('#6a6050'), smoothstep(0.5, 1.5, f) * 0.2)
            metal = (rim & spokes).astype(np.float32) * 0.8; rough = 0.85 - metal * 0.5; hgt = lug * 2 + (rim & spokes) * 1.5
        else:
            alb, hgt, rough, metal = B.burnt_steel(shape, seed, ash=0.35, rust=0.1, wrap=False)
            ring = (np.abs(d_ - R * 0.95) < 5) | (np.abs(d_ - R * 0.25) < 4)
            holes = (d_ > R * 0.35) & (d_ < R * 0.62) & (np.cos(ang * 6) > 0.8)
            alb = lerp(alb, srgb('#3e3c39'), ring.astype(np.float32) * 0.7)
            alb = lerp(alb, srgb('#080808'), holes.astype(np.float32))
            alb = lerp(alb, srgb('#0d0c0b'), (d_ > R).astype(np.float32) * (yy < h * 0.75) * 0.8)
    elif name == 'steel_galv':
        alb = colorize(norm01(f * 0.5 + n * 0.5), [(0, '#8c908f'), (1, '#b4b8b5')])
        spang = blur((r.random(shape) > 0.7).astype(np.float32), 2.0, True)
        alb = alb * (0.95 + 0.08 * spang)[..., None]
        alb = lerp(alb, srgb('#6e6a5e'), smoothstep(0.9, 1.8, n) * 0.25)
        metal[:] = 0.7; rough = 0.45 + 0.1 * spang
    elif name == 'steel_dark':
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#262829'), (1, '#3c3f40')])
        alb = lerp(alb, srgb('#6a6458'), smoothstep(1.0, 1.8, n) * 0.25); metal[:] = 0.5; rough[:] = 0.55
    elif name == 'plastic_play':
        # quadrants: TL red, TR yellow, BL blue, BR green -- powder-coated steel / rotomoulded plastic, sun-faded
        q = w // 2
        cols = {(0, 0): '#c7332b', (1, 0): '#e8b923', (0, 1): '#2d64b0', (1, 1): '#4a9a3c'}
        alb = np.zeros(shape + (3,), np.float32)
        for (i, j), c in cols.items():
            alb[j * q:(j + 1) * q, i * q:(i + 1) * q] = srgb(c)
        alb = alb * (0.9 + 0.1 * norm01(f))[..., None]
        alb = lerp(alb, srgb('#d8d4c8'), smoothstep(0.9, 1.9, n) * 0.18)
        rough[:] = 0.45
    elif name == 'rubber_mat':
        # poured EPDM rubber crumb safety surface: left half terracotta, right half green, crumb speckle
        q = w // 2
        base = np.where((xx < q)[..., None], srgb('#9a4a3a'), srgb('#3f7a4a'))
        crumb = r.random(shape).astype(np.float32)
        alb = base * (0.8 + 0.3 * crumb)[..., None]
        alb = lerp(alb, srgb('#5a5650'), smoothstep(0.9, 1.9, n) * 0.25)
        hgt = crumb * 0.6; rough[:] = 0.95
    elif name == 'wood_slats':
        board = (yy // (h / 5)).astype(int); gap = ((yy % (h / 5)) < 5).astype(np.float32)
        grain = np.sin(xx * 0.12 + n * 4 + board * 2.1)
        alb = colorize(norm01(grain * 0.4 + f * 0.4 + rng(seed + 2).random(8)[board % 8][..., None][..., 0] * 0.4), [(0, '#6a4428'), (0.5, '#8c5c36'), (1, '#a47044')])
        alb = lerp(alb, srgb('#16120e'), gap)
        alb = lerp(alb, srgb('#7a7468'), smoothstep(0.8, 1.7, n) * 0.25)
        hgt = (1 - gap) * 2 + grain * 0.3; rough[:] = 0.8
    elif name in ('garage_door', 'garage_burnt'):
        # double-leaf steel garage gate 2.6 x 2.2 m with a wicket, painted (green / brown), number; burnt: soot, ash, warped
        col = '#3e5a46'
        alb, chip, _, _ = CA.chip_paint(shape, seed, col, '#6e3f22', 0.5)
        img = _pil(alb); d = Draw(img)
        d.line([(w // 2, 0), (w // 2, h)], fill=(30, 36, 32), width=4)
        d.rectangle([w * 0.58, h * 0.25, w * 0.9, h * 0.97], outline=(34, 44, 38), width=3)
        for x in (w * 0.25, w * 0.75):
            d.rectangle([x - 6, h * 0.45, x + 6, h * 0.55], fill=(60, 60, 58))
        d.text((w * 0.12, h * 0.08), '23', fill=(220, 218, 205), font=ImageFont.truetype(FONT_B, 34))
        alb = _arr(img); alb = lerp(alb, srgb('#5e3018'), smoothstep(h * 0.75, h, yy)[..., None] * smoothstep(0, 1, n + 0.5)[..., None] * 0.6)
        metal = chip * 0.4; rough = 0.6 + chip * 0.2
        if name == 'garage_burnt':
            soot = smoothstep(h * 1.0, h * 0.0, yy) * 0.3 + smoothstep(h * 0.5, 0, yy) * 0.4
            bal, bh, br, bm = B.burnt_steel(shape, seed + 3, ash=0.45, rust=0.08, low_soot=soot, wrap=False)
            alb = lerp(bal, srgb('#0d0c0b'), (np.abs(xx - w / 2) < 3).astype(np.float32)); hgt = bh; rough = br; metal = bm
    elif name == 'interior_dark':
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#171614'), (1, '#33302b')])
        alb = lerp(alb, srgb('#55504a'), smoothstep(0.8, 1.6, n) * 0.3); rough[:] = 0.95
    elif name == 'asphalt':
        agg = (r.random(shape) ** 6).astype(np.float32)
        alb = colorize(norm01(f), [(0, '#2e2d2b'), (1, '#46443f')]) + agg[..., None] * 0.12
        alb = lerp(alb, srgb('#5a5650'), smoothstep(0.9, 1.8, n) * 0.3); hgt = agg; rough[:] = 0.9
    elif name == 'steel_rust':
        alb = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#3a2318'), (0.4, '#5e3520'), (0.8, '#7d4a2a'), (1, '#8c6a50')])
        alb = lerp(alb, srgb('#3a3632'), smoothstep(0.6, 1.4, spectral(0, 1.8, seed + 4, fmin=3, fmax=40, shape=shape)) * 0.5)
        hgt = f * 0.6; metal[:] = 0.4; rough[:] = 0.8
    elif name == 'bin_euro':
        # 1100 l euro container: grey HDPE body with vertical ribs (top 3/4), dark green lid (bottom quarter)
        rib = ((xx % 32) < 5).astype(np.float32)
        body = colorize(norm01(f), [(0, '#6c716f'), (1, '#808684')]) * (0.9 + 0.1 * rib)[..., None]
        lid = colorize(norm01(f), [(0, '#2e4a34'), (1, '#3c5c42')])
        alb = np.where((yy > h * 0.75)[..., None], lid, body)
        alb = lerp(alb, srgb('#4a4436'), smoothstep(h * 0.5, h * 0.75, yy)[..., None] * (yy < h * 0.75)[..., None] * 0.4)
        img = _pil(alb); d = Draw(img)
        d.text((w * 0.3, h * 0.25), '1100', fill=(220, 220, 215), font=ImageFont.truetype(FONT_B, 30))
        alb = _arr(img); alb = lerp(alb, srgb('#3a3428'), smoothstep(0.8, 1.7, n) * 0.25)
        hgt = rib * 1.5; rough[:] = 0.6
    elif name == 'lamp_parts':
        # quadrants: TL LED head underside (lens array), TR headlight/indicator glass, BL black housing, BR chrome
        q = w // 2
        alb = np.zeros(shape + (3,), np.float32) + srgb('#2a2c2e')
        led = ((xx % 16 < 9) & (yy % 16 < 9) & (xx < q) & (yy < q))
        alb[:q, :q] = srgb('#3a3e42'); alb = np.where(led[..., None], srgb('#e8ecea'), alb)
        alb[:q, q:] = srgb('#c9cdcc')
        alb[q:, :q] = srgb('#1e1f20')
        alb[q:, q:] = colorize(norm01(n[q:, q:]), [(0, '#7d7f80'), (1, '#c3c5c4')])
        rough[:q, :] = 0.2; rough[q:, :q] = 0.6; rough[q:, q:] = 0.25; metal[q:, q:] = 0.9
    else:
        alb = colorize(norm01(n), [(0, '#555555'), (1, '#777777')])
    return alb.astype(np.float32), np.asarray(hgt, np.float32), np.clip(rough, 0, 1).astype(np.float32), np.asarray(metal, np.float32) + np.zeros(shape, np.float32)


def build():
    alb = np.zeros((S, S, 3), np.float32) + 0.5; hgt = np.zeros((S, S), np.float32)
    rough = np.full((S, S), 0.85, np.float32); metal = np.zeros((S, S), np.float32); ao = np.ones((S, S), np.float32)
    g = PAD
    wp = lambda a: np.pad(a, ((g, g), (g, g)) + ((0, 0),) * (a.ndim - 2), mode='wrap')
    for i, (name, rc) in enumerate(REG.items()):
        x0, y0, x1, y1 = rc
        a, hh, rr, mm = paint(name, (x0 + g, y0 + g, x1 - g, y1 - g), 12000 + i * 7)
        alb[y0:y1, x0:x1] = wp(a); hgt[y0:y1, x0:x1] = wp(hh); rough[y0:y1, x0:x1] = wp(rr); metal[y0:y1, x0:x1] = wp(mm)
        ao[y0:y1, x0:x1] = wp(cavity_ao(hh, 3, 0.3, wrap=True))
    paths = [os.path.join(CACHE, f'modern_atlas_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    Image.fromarray(to8(alb)).save(paths[0], quality=90, optimize=True)
    nrm = to8(blur(normal_from_height(hgt, 1.0, wrap=False).astype(np.float32) / 255.0, 0.5, wrap=False))
    Image.fromarray(quantize_normal(nrm, 6)).save(paths[1], optimize=True, compress_level=9)
    orm = to8(blur(np.stack([ao, rough, metal], -1), 0.5, wrap=False))
    Image.fromarray(quantize_normal(orm, 6)).save(paths[2], optimize=True, compress_level=9)
    return paths


# ------------------------------------------------------------------ alpha atlas (1024^2 RGBA, MASK 0.5, double sided)
SA = 1024
AREG = {'net': (0, 0, 512, 512), 'net_torn': (512, 0, 1024, 512), 'glass_crack_a': (0, 512, 512, 1024), 'glass_crack_b': (512, 512, 1024, 1024)}


def paint_alpha(name, shape, seed):
    h, w = shape; r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.3, seed, fmin=2, fmax=40, shape=shape)
    if name.startswith('net'):
        # knotted polyamide fishing net used as anti-drone cover: ~0.12 m diamond mesh (region = 2 x 2 m), dark olive
        # cord with knots, a few strips of camo scrim tied in; torn: big rips + sagging loose cords
        img = Image.new('L', (w, h), 0); d = Draw(img)
        p = w / 16
        for k in range(-16, 33):     # cords drawn thick so the mesh survives alpha-tested mip levels at RTS distance
            d.line([(k * p, 0), (k * p + h, h)], fill=255, width=6)
            d.line([(k * p, 0), (k * p - h, h)], fill=255, width=6)
        cord = np.asarray(img, np.float32) / 255
        knots = np.zeros(shape, np.float32)
        for i in range(-1, 17):
            for j in range(-1, 33):
                stamp_disc(knots, i * p + (j % 2) * p / 2, j * p / 2, 4.5, 1, 1)
        a = np.clip(cord + knots, 0, 1)
        col = colorize(norm01(n), [(0, '#2c3324'), (1, '#4a5238')])
        scrim = np.zeros(shape, np.float32)
        for k in range(5):
            x0 = r.uniform(0, w); wd = r.uniform(14, 30)
            scrim = np.maximum(scrim, (np.abs(((xx - x0 + (yy - h / 2) * r.uniform(-0.3, 0.3)) + w / 2) % w - w / 2) < wd).astype(np.float32)
                               * (yy > r.uniform(0, h * 0.4)) * (yy < r.uniform(h * 0.6, h)))
        scrim *= (blur(r.random(shape).astype(np.float32), 1.5, True) > 0.5)
        col = lerp(col, colorize(norm01(spectral(0, 2.0, seed + 3, fmin=4, fmax=40, shape=shape)), [(0, '#3b4a2a'), (0.5, '#6a6a44'), (1, '#4a3a28')]), scrim)
        a = np.maximum(a, scrim)
        if name == 'net_torn':
            rip = np.zeros(shape, np.float32)
            for k in range(3):
                bl = blob(r.uniform(w * 0.2, w * 0.8), r.uniform(h * 0.2, h * 0.8), r.uniform(40, 80), r.uniform(30, 70), 18, seed + k, 0.4, 0.5)
                hm = Image.new('L', (w, h), 0); Draw(hm).polygon([tuple(p_) for p_ in bl], fill=255)
                rip = np.maximum(rip, np.asarray(hm, np.float32) / 255)
            a = a * (1 - rip)
            loose = np.zeros(shape, np.float32)
            for k in range(14):
                x0 = r.uniform(0, w); y0 = r.uniform(h * 0.2, h * 0.8)
                pts = [(x0 + np.sin(t * 3 + k) * 8, y0 + t * r.uniform(30, 80)) for t in np.linspace(0, 1, 6)]
                Draw(img2 := Image.new('L', (w, h), 0)).line(pts, fill=255, width=3)
                loose = np.maximum(loose, np.asarray(img2, np.float32) / 255)
            a = np.maximum(a, loose * rip)
        hgt = a * 2
        rough = np.full(shape, 0.95, np.float32)
    else:
        # shot-out / cracked tempered glazing panel: dark grey-green glass, crazing around impacts, missing areas
        col = colorize(norm01(n), [(0, '#3d4a4c'), (1, '#5f6e70')]) * 1.0
        col = lerp(col, srgb('#9aa8aa'), smoothstep(h, 0, yy)[..., None] * 0.25)
        a = np.ones(shape, np.float32)
        nimp = 3 if name == 'glass_crack_a' else 6
        crack = np.zeros(shape, np.float32); hole = np.zeros(shape, np.float32)
        for k in range(nimp):
            cx, cy = r.uniform(w * 0.15, w * 0.85), r.uniform(h * 0.15, h * 0.85)
            rr = r.uniform(18, 50) if name == 'glass_crack_a' else r.uniform(60, 150)
            poly = [(cx + np.cos(t) * rr * r.uniform(0.5, 1.2), cy + np.sin(t) * rr * r.uniform(0.5, 1.2)) for t in np.linspace(0, 2 * np.pi, 14, endpoint=False)]
            hm = Image.new('L', (w, h), 0); Draw(hm).polygon(poly, fill=255)
            hole = np.maximum(hole, np.asarray(hm, np.float32) / 255)
            cm = Image.new('L', (w, h), 0); dc = Draw(cm)
            for j in range(18):
                ang = r.uniform(0, 2 * np.pi); L = r.uniform(rr * 1.2, rr * 3.5)
                pts = [(cx, cy)]
                for s in range(5):
                    ang += r.normal(0, 0.25)
                    pts.append((pts[-1][0] + np.cos(ang) * L / 5, pts[-1][1] + np.sin(ang) * L / 5))
                dc.line(pts, fill=255, width=2)
            for rad in (rr * 1.4, rr * 2.1):
                dc.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], outline=180, width=1)
            crack = np.maximum(crack, np.asarray(cm, np.float32) / 255)
        if name == 'glass_crack_b':     # most of the pane gone, jagged shards left in the frame
            edge = np.minimum(np.minimum(xx, w - 1 - xx), np.minimum(yy, h - 1 - yy))
            jag = 30 + 40 * norm01(spectral(0, 1.5, seed + 5, fmin=3, fmax=30, shape=shape))
            hole = np.maximum(hole, (edge > jag).astype(np.float32) * (spectral(0, 2, seed + 6, fmin=1, fmax=6, shape=shape) > -0.6))
        col = lerp(col, srgb('#d6dcdc'), crack * 0.75)
        a = a * (1 - hole)
        frame = (np.minimum(np.minimum(xx, w - 1 - xx), np.minimum(yy, h - 1 - yy)) < 6).astype(np.float32)
        col = lerp(col, srgb('#8f9493'), frame); a = np.maximum(a, frame)
        hgt = crack * 1.0
        rough = 0.15 + crack * 0.4 + frame * 0.3
    return col.astype(np.float32), a.astype(np.float32), hgt.astype(np.float32), np.asarray(rough, np.float32)


def build_alpha():
    alb = np.zeros((SA, SA, 3), np.float32) + 0.3; al = np.zeros((SA, SA), np.float32)
    hgt = np.zeros((SA, SA), np.float32); rough = np.full((SA, SA), 0.9, np.float32)
    g = PAD
    wp = lambda a: np.pad(a, ((g, g), (g, g)) + ((0, 0),) * (a.ndim - 2), mode='wrap')
    for i, (name, (x0, y0, x1, y1)) in enumerate(AREG.items()):
        c, a, hh, rr = paint_alpha(name, (y1 - y0 - 2 * g, x1 - x0 - 2 * g), 13000 + i * 11)
        alb[y0:y1, x0:x1] = wp(c); al[y0:y1, x0:x1] = wp(a); hgt[y0:y1, x0:x1] = wp(hh); rough[y0:y1, x0:x1] = wp(rr)
    # bleed colour into transparent texels so mip-maps do not halo
    m = al > 0.5
    bl = blur(alb * m[..., None], 3, False) / (blur(m.astype(np.float32), 3, False)[..., None] + 1e-4)
    alb = np.where(m[..., None], alb, np.clip(bl, 0, 1))
    paths = [os.path.join(CACHE, f'modern_alpha_{s}') for s in ('albedo.png', 'normal.png', 'orm.png')]
    Image.fromarray(np.concatenate([to8(alb), to8(al)[..., None]], -1), 'RGBA').save(paths[0], optimize=True)
    Image.fromarray(quantize_normal(to8(normal_from_height(hgt, 1.0, wrap=False).astype(np.float32) / 255.0), 6)).save(paths[1], optimize=True)
    Image.fromarray(to8(np.stack([np.ones_like(rough), rough, np.zeros_like(rough)], -1))).save(paths[2], optimize=True)
    return paths


if __name__ == '__main__':
    import time; t0 = time.time()
    print(build(), build_alpha(), time.time() - t0)
