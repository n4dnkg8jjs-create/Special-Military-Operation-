"""Panel-kit texture atlas (2048^2): albedo JPEG, normal PNG, ORM PNG. One material for every kit piece.

Layout (pixels, origin top-left):
  rows 0..1343   : 3 x 4 facade cells 512x448 (= 3.2 x 2.8 m, 160 px/m): row = intact / damaged / holed(+destroyed),
                   column = wall_window, wall_balcony, wall_blank_end, wall_entrance
  y 1344..2047   : detail regions (see REG below)
"""
import os
import numpy as np
import cv2
from texlib import (spectral, norm01, smoothstep, blur, colorize, srgb, lerp, to8, normal_from_height,
                    cavity_ao, random_walk_cracks, stamp_disc, rng, voronoi, CACHE, quantize_normal, bake_shade)
from PIL import Image
from kit_design import W, H, T, OPEN, TYPES, hole_poly, LAYER_OUT, LAYER_INS

S = 2048
CW, CH = 512, 448
PPM = CW / W  # 160 px per metre on facades

REG = {
    'section':      (0, 1344, 512, 1600),     # broken edge through-section, sooty (x along 2 m, y = depth 0..T)
    'section_clean': (0, 1600, 512, 1728),    # clean concrete core / panel sides
    'concrete':     (0, 1728, 512, 2048),     # precast concrete (slabs, balcony, canopy, parapet, stairs) ~2 x 1.25 m
    'interior':     (512, 1344, 1024, 1792),  # room face of exterior wall 3.2 x 2.8 m (wallpaper)
    'floor':        (512, 1792, 768, 2048),   # linoleum floor
    'ceiling':      (768, 1792, 1024, 2048),  # whitewashed ceiling
    'glass':        (1024, 1344, 1280, 1600), # window glass with tulle curtain behind
    'door':         (1280, 1344, 1536, 1600), # steel entrance door
    'asbestos':     (1024, 1600, 1280, 1856), # corrugated asbestos-cement sheet (shifer)
    'roofing':      (1280, 1600, 1536, 1856), # bitumen roofing felt
    'veneer':       (1024, 1856, 1280, 2048), # furniture laminate / chipboard
    'stair':        (1280, 1856, 1536, 2048), # terrazzo stair concrete
    'plinth':       (1536, 1856, 2048, 2048), # painted plinth with basement vent
}
SMALL = ['wood_paint', 'pvc', 'rebar', 'radiator', 'osb', 'rag', 'galv', 'rail_paint',
         'brick_red', 'wallpaper2', 'insulation', 'fabric', 'glass_broken', 'soot', 'rubber', 'metal_grey']
for i, n in enumerate(SMALL):
    x0 = 1536 + (i % 4) * 128; y0 = 1344 + (i // 4) * 128
    REG[n] = (x0, y0, x0 + 128, y0 + 128)


def cell_rect(t, state):
    row = {'intact': 0, 'damaged': 1, 'holed': 2, 'destroyed': 2}[state]
    col = TYPES.index(t)
    return (col * CW, row * CH, col * CW + CW, row * CH + CH)


class Atlas:
    def __init__(self):
        self.alb = np.zeros((S, S, 3), np.float32) + 0.5
        self.hgt = np.zeros((S, S), np.float32)    # in pixel units
        self.rough = np.full((S, S), 0.9, np.float32)
        self.metal = np.zeros((S, S), np.float32)
        self.ao = np.ones((S, S), np.float32)

    def put(self, rect, alb, hgt, rough, metal=None, ao=None):
        x0, y0, x1, y1 = rect
        self.alb[y0:y1, x0:x1] = alb
        self.hgt[y0:y1, x0:x1] = hgt
        self.rough[y0:y1, x0:x1] = rough
        if metal is not None:
            self.metal[y0:y1, x0:x1] = metal
        self.ao[y0:y1, x0:x1] = ao if ao is not None else cavity_ao(hgt, 3, 0.3, wrap=False)

    def save(self, prefix):
        alb = self.alb
        nrm = normal_from_height(self.hgt, 1.0, wrap=False)
        paths = (os.path.join(CACHE, prefix + '_albedo.jpg'), os.path.join(CACHE, prefix + '_normal.png'),
                 os.path.join(CACHE, prefix + '_orm.png'))
        Image.fromarray(to8(alb)).save(paths[0], quality=90, optimize=True)
        nrm = to8(blur(nrm.astype(np.float32) / 255.0, 0.5, wrap=False))
        Image.fromarray(quantize_normal(nrm, 6)).save(paths[1], optimize=True, compress_level=9)
        orm = to8(blur(np.stack([self.ao, self.rough, self.metal], -1), 0.5, wrap=False))
        Image.fromarray(quantize_normal(orm, 6)).save(paths[2], optimize=True, compress_level=9)
        # half-res copy for rubble / debris GLBs (keeps those files small)
        for p in paths:
            im = Image.open(p); im = im.resize((S // 2, S // 2), Image.LANCZOS)
            q = p.replace('kit_atlas', 'kit_atlas_1k')
            im.save(q, quality=88, optimize=True) if q.endswith('.jpg') else im.save(q, optimize=True, compress_level=9)
        return paths


def mrow(y):  # metres (up) -> row in cell
    return (H - y) * PPM


def mcol(x):
    return x * PPM


def poly_mask(shape, P, val=1.0):
    m = np.zeros(shape, np.float32)
    pts = np.array([[mcol(x) * 4, mrow(y) * 4] for x, y in P], np.int32)
    cv2.fillPoly(m, [pts], val, lineType=cv2.LINE_AA, shift=2)
    return m


def rect_mask(shape, r, pad=0.0):
    x0, y0, x1, y1 = r
    return poly_mask(shape, [(x0 - pad, y0 - pad), (x1 + pad, y0 - pad), (x1 + pad, y1 + pad), (x0 - pad, y1 + pad)])


def dist_outside(mask):
    """distance (px) from the masked area (0 inside)."""
    inv = (mask < 0.5).astype(np.uint8)
    return cv2.distanceTransform(inv, cv2.DIST_L2, 5).astype(np.float32)


# ------------------------------------------------------------------ facades
def paint_facade(t, state, seed, voids=None):
    """voids: optional list of Nx2 outlines (metres) replacing hole_poly(t) for the holed/destroyed scorch, tile loss and
    cracks (used by kit_damage_atlas for the *_holed_v2.. / *_destroyed_v2.. variant cells)."""
    r = rng(seed)
    h, w = CH, CW
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ym = H - yy / PPM; xm = xx / PPM            # metres
    low = spectral(0, 2.2, seed + 1, fmin=1, fmax=20, shape=(h, w))
    mid = spectral(0, 1.4, seed + 2, fmin=6, fmax=200, shape=(h, w))
    fine = spectral(0, 0.6, seed + 3, fmin=80, shape=(h, w))
    # --- concrete under the tiles (seen where tiles fell off): grey with ceramsite pores and comb adhesive
    conc = colorize(norm01(mid * 0.6 + fine * 0.4), [(0, '#8a867f'), (0.5, '#9b968d'), (1, '#aca79c')])
    comb = 0.5 + 0.5 * np.sin(yy * 1.4 + mid * 2)
    conc = conc * (0.92 + 0.08 * comb[..., None])
    # --- ceramic tile skin: 48 mm tiles + 4 mm grout -> pitch 8.3 px
    pitch = 0.052 * PPM
    tx = (xx + 0.3) / pitch; ty = (yy + 0.3) / pitch
    fx = tx - np.floor(tx); fy = ty - np.floor(ty)
    tid = (np.floor(tx).astype(np.int32) * 7919 + np.floor(ty).astype(np.int32) * 104729) % 9973
    tv = (tid * 0.61803) % 1.0
    grout = np.maximum(smoothstep(0.86, 0.97, fx), smoothstep(0.86, 0.97, fy))
    tile_base = srgb('#cdc5b3') if t != 'wall_blank_end' else srgb('#c4bcab')
    tile = tile_base * (0.94 + 0.1 * tv[..., None]) * (0.97 + 0.03 * fine[..., None])
    # decorative band of pale blue tiles below windows (window + balcony panels) -> reads as storey stripes
    if t in ('wall_window', 'wall_balcony'):
        band = ((ym > 0.32) & (ym < 0.78)).astype(np.float32)
        tile = lerp(tile, srgb('#93a9b2') * (0.93 + 0.12 * tv[..., None]), band)
    odd = (tv > 0.985).astype(np.float32)           # odd replacement tiles
    tile = lerp(tile, srgb('#b9b39f'), odd * 0.8)
    tile = lerp(tile, srgb('#9a958a'), grout * 0.55)
    # tile loss (fallen tiles): patches aligned to the tile grid
    loss_amt = {'intact': 0.0, 'damaged': 0.07, 'holed': 0.1, 'destroyed': 0.1}[state]
    ln = spectral(0, 2.6, seed + 4, fmin=1.5, fmax=14, shape=(h, w)) + 0.25 * spectral(0, 1.0, seed + 9, fmin=20, fmax=120, shape=(h, w))
    tile_cell_noise = ln[np.clip((np.floor(ty) * pitch).astype(int), 0, h - 1), np.clip((np.floor(tx) * pitch).astype(int), 0, w - 1)]
    thr = np.quantile(tile_cell_noise, 1 - loss_amt) if loss_amt > 0 else 1e9
    lost = (tile_cell_noise > thr).astype(np.float32)
    alb = lerp(tile, conc, lost)
    hgt = (1 - lost) * (1.2 - grout * 0.9) + fine * 0.15 + lost * (comb * 0.15 - 0.3)
    rough = 0.55 + grout * 0.3 + lost * 0.35 + 0.05 * fine
    # --- openings: soot/water staining around them
    open_mask = np.zeros((h, w), np.float32)
    for kind, rc in OPEN[t]:
        open_mask = np.maximum(open_mask, rect_mask((h, w), rc))
    # rain streaks below window sill ends and from the top joint
    streak = np.zeros((h, w), np.float32)
    for kind, (x0, y0, x1, y1) in OPEN[t]:
        if kind == 'window':
            for xe in (x0 + 0.03, x1 - 0.03):
                for k in range(3):
                    xs = mcol(xe + r.normal(0, 0.04)); L = r.uniform(0.4, y0 - 0.02) * PPM
                    wdt = r.uniform(3, 9)
                    streak += np.exp(-((xx - xs) / wdt) ** 2) * ((yy > mrow(y0)) & (yy < mrow(y0) + L)) * np.clip(1 - (yy - mrow(y0)) / L, 0, 1)
            # sill drip band right below the opening
            streak += smoothstep(mrow(y0) + 22, mrow(y0), yy) * ((xx > mcol(x0)) & (xx < mcol(x1))) * (yy > mrow(y0)) * 0.6
    vstreak = blur(spectral(0, 1.2, seed + 5, fmin=8, fmax=200, shape=(h, w)), (40, 1.0), wrap=False)
    streak += np.clip(vstreak * 1.2 - 0.4, 0, 1) * 0.35 * smoothstep(0.0, 0.5, ym / H)
    alb = lerp(alb, srgb('#5d574d'), np.clip(streak, 0, 1) * 0.45)
    # rust from joint steel at the top corners
    for xc in (0.18, W - 0.18):
        rs = np.exp(-((xx - mcol(xc)) / 3.5) ** 2) * smoothstep(mrow(H - 0.9), mrow(H), yy) * (yy > 0)
        alb = lerp(alb, srgb('#7a5236'), rs * r.uniform(0.2, 0.5))
    # --- panel joints (sealant mastic) along all 4 edges
    edge = np.minimum(np.minimum(xx, w - 1 - xx), np.minimum(yy, h - 1 - yy))
    jn = spectral(0, 1.5, seed + 6, fmin=10, fmax=200, shape=(h, w))
    jw = 4.5 + jn * 1.2
    joint = 1 - smoothstep(jw - 1, jw + 1, edge)
    seal = colorize(norm01(jn), [(0, '#2e2d2b'), (0.6, '#3f3d39'), (1, '#55524b')])
    # patched joints: lighter newer sealant blobs spreading on the facade
    patchj = (1 - smoothstep(jw + 2, jw + 9, edge)) * smoothstep(0.8, 1.4, spectral(0, 2, seed + 7, fmin=3, fmax=60, shape=(h, w)))
    alb = lerp(alb, srgb('#504c45'), patchj * 0.8)
    alb = lerp(alb, seal, joint)
    hgt = lerp(hgt, -1.0 + jn * 0.2, joint)
    rough = lerp(rough, 0.75, np.maximum(joint, patchj))
    # dark leak stains below joint crosses
    for xc in (0, w):
        leak = np.exp(-((xx - xc) / 14) ** 2) * smoothstep(0, 60, yy) * smoothstep(200, 0, yy) * 0.25
        alb = lerp(alb, srgb('#4c4840'), leak)
    soot = np.zeros((h, w), np.float32)
    # --- damage
    if state != 'intact':
        # shrapnel pockmarks: dark pit, chipped light ring, tiles missing locally
        n = {'damaged': 70, 'holed': 150, 'destroyed': 150}[state]
        pit = np.zeros((h, w), np.float32); ring = np.zeros((h, w), np.float32)
        centre = (W * 0.5, H * 0.55)
        if voids is not None and state != 'damaged':
            _a = np.concatenate(voids); centre = (float(_a[:, 0].mean()), float(np.clip(_a[:, 1].mean(), 0.6, H - 0.6)))
        for k in range(n):
            if state == 'damaged':
                x, y = r.uniform(0.1, W - 0.1), r.uniform(0.1, H - 0.1)
            else:
                a = r.uniform(0, 2 * np.pi); d = abs(r.normal(0, 0.9)) + 0.6
                x, y = centre[0] + np.cos(a) * d, centre[1] + np.sin(a) * d * 0.8
            rr = r.uniform(1.0, 4.5)
            stamp_disc(pit, mcol(x), mrow(y), rr, 1, 1.0)
            stamp_disc(ring, mcol(x), mrow(y), rr * r.uniform(2.0, 3.5), 1, 2.0)
        ring = np.clip(ring - pit, 0, 1)
        ring = ring * smoothstep(-0.3, 0.6, spectral(0, 0.8, seed + 11, fmin=40, shape=(h, w)))
        alb = lerp(alb, conc * 1.12, ring * 0.75)
        alb = lerp(alb, srgb('#2b2926'), pit * 0.85)
        hgt -= pit * 3.0 + ring * 1.0
        rough = np.maximum(rough, (ring + pit) * 0.92)
        # cracks: from opening corners diagonally + random
        cr = np.zeros((h, w), np.float32)
        import texlib
        corners = []
        for kind, (x0, y0, x1, y1) in OPEN[t]:
            corners += [(x0, y0, -1, -1), (x1, y0, 1, -1), (x0, y1, -1, 1), (x1, y1, 1, 1)]
        if not corners:
            corners = [(W * 0.5, H * 0.5, 1, 1), (W * 0.5, H * 0.5, -1, -1)]
        for (cx, cy, sx, sy) in corners:
            if r.random() < 0.65:
                pts = [(mcol(cx), mrow(cy))]; a = np.arctan2(-sy, sx) + r.normal(0, 0.35)
                for k in range(int(r.uniform(25, 70))):
                    a += r.normal(0, 0.3); pts.append((pts[-1][0] + np.cos(a) * 2.5, pts[-1][1] + np.sin(a) * 2.5))
                texlib._draw_poly(cr, pts, 1.6, False)
        cr = np.clip(cr, 0, 1)
        alb = lerp(alb, srgb('#2a2824'), cr * 0.8); hgt -= cr * 2
        # soot: fire plumes above openings (rising, widening, fading), plus incoming plume at the bottom
        for kind, (x0, y0, x1, y1) in OPEN[t]:
            if kind == 'door' and t == 'wall_balcony' and state == 'damaged':
                continue
            cxm = (x0 + x1) / 2; half = (x1 - x0) / 2
            dy = np.clip(ym - y1 + 0.05, 0, None)
            width = half * (0.85 + dy * 0.9) * (1 + 0.15 * mid)
            plume = smoothstep(width, width * 0.4, np.abs(xm - cxm + mid * 0.08)) * (ym > y1 - 0.08) * np.exp(-dy * 0.35)
            plume *= (0.75 + 0.25 * norm01(blur(spectral(0, 1.6, seed + 8, fmin=4, fmax=120, shape=(h, w)), (6, 1), wrap=False)))
            # licks on reveal sides
            side = (np.exp(-((xm - x0) / 0.06) ** 2) + np.exp(-((xm - x1) / 0.06) ** 2)) * (ym > y0) * (ym < y1 + 0.1) * 0.6
            soot = np.maximum(soot, plume + side)
        if state == 'damaged' and t in ('wall_window', 'wall_balcony'):
            dyb = ym
            soot = np.maximum(soot, smoothstep(0.55, 0.0, ym) * smoothstep(1.0, 0.3, np.abs(xm - W / 2)) * 0.45)
        if state == 'damaged' and t == 'wall_blank_end':
            soot = np.maximum(soot, smoothstep(1.2, 0.0, np.abs(xm - 2.1 + mid * 0.2)) * smoothstep(0.5, 2.8, ym) * 0.35)
    if state in ('holed', 'destroyed'):
        polys = voids if voids is not None else [hole_poly(t)]
        hm = np.zeros((h, w), np.float32)
        for _p in polys:
            hm = np.maximum(hm, poly_mask((h, w), _p))
        hp = np.concatenate(polys)
        d = dist_outside(hm) / PPM   # metres from hole edge
        # blast scorch: radial + plume upward
        cy = hp[:, 1].mean(); cx = hp[:, 0].mean(); top = hp[:, 1].max()
        sc = np.exp(-d / 0.35) + smoothstep(1.4, 0.2, np.abs(xm - cx + mid * 0.1)) * (ym > top - 0.3) * np.exp(-np.clip(ym - top, 0, None) * 0.4) * 0.9
        if voids is not None and state == 'destroyed':   # blown-out variant: remnants keep patchy soot, not a black ring
            sc = np.exp(-d / 0.13) * 0.8 * (0.6 + 0.4 * norm01(mid)) + np.exp(-d / 0.5) * 0.25
        sc *= 0.8 + 0.2 * norm01(mid)
        soot = np.maximum(soot, np.clip(sc, 0, 1))
        # tiles blown off in a ring around the hole
        ringlost = (d < (0.12 if (voids is not None and state == 'destroyed') else 0.25) + 0.2 * norm01(ln)).astype(np.float32)
        alb = lerp(alb, conc * 0.9, ringlost); hgt = lerp(hgt, comb * 0.15 - 0.6, ringlost); rough = np.maximum(rough, ringlost * 0.92)
        # radiating cracks from the hole edge
        cr = np.zeros((h, w), np.float32)
        import texlib
        for k in range(12):
            i = r.integers(0, len(hp)); p = hp[i]; a = np.arctan2(-(p[1] - cy), p[0] - cx) + r.normal(0, 0.3)
            pts = [(mcol(p[0]), mrow(p[1]))]
            for j in range(int(r.uniform(20, 60))):
                a += r.normal(0, 0.25); pts.append((pts[-1][0] + np.cos(a) * 3, pts[-1][1] + np.sin(a) * 3))
            texlib._draw_poly(cr, pts, 1.8, False)
        cr = np.clip(cr, 0, 1); alb = lerp(alb, srgb('#1f1d1b'), cr * 0.85); hgt -= cr * 2.5
        # area inside the hole: heavily burnt broken concrete (visible on destroyed stubs that use this cell)
        inside = hm
        burnt = colorize(norm01(fine * 0.5 + mid * 0.5), [(0, '#262422'), (1, '#4a4641')])
        alb = lerp(alb, burnt, inside); hgt = lerp(hgt, fine * 0.8 - 1, inside); rough = np.maximum(rough, inside * 0.95)
    soot = np.clip(soot, 0, 1)
    sootcol = colorize(norm01(fine), [(0, '#141312'), (1, '#2a2725')])
    alb = lerp(alb, sootcol, soot * 0.92)
    rough = lerp(rough, 0.97, soot)
    # general weathering tone
    alb = alb * (0.96 + 0.04 * low[..., None])
    alb = alb * bake_shade(hgt, 0.6, 0.15, wrap=False)
    return alb, hgt, np.clip(rough, 0, 1)


# ------------------------------------------------------------------ detail regions
def _shape(rect):
    x0, y0, x1, y1 = rect; return (y1 - y0, x1 - x0)


def paint_section(rect, sooty, seed):
    h, w = _shape(rect); r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dep = yy / h * T     # depth metres (row 0 = outside face)
    fine = spectral(0, 0.7, seed, fmin=30, shape=(h, w)); mid = spectral(0, 1.5, seed + 1, fmin=4, fmax=100, shape=(h, w))
    conc = colorize(norm01(fine * 0.6 + mid * 0.4), [(0, '#5f5b55'), (0.5, '#7b766d'), (1, '#938d83')])
    # ceramsite granules (expanded clay: rounded, brown-orange, porous)
    F1, F2, ids = voronoi(0, 900, seed + 2, shape=(h, w))
    rad = r.uniform(2, 7, 900)[ids]
    gran = np.clip(1 - F1 / rad, 0, 1)
    gmask = smoothstep(0.05, 0.25, gran) * (r.random(900)[ids] < 0.6)
    gcol = colorize(r.random(900)[ids], [(0, '#6d4a35'), (0.6, '#8a5f43'), (1, '#5a4a3f')])
    conc = lerp(conc, gcol, gmask * 0.8)
    hc = fine * 0.8 + gran * 2.0
    # insulation band (mineral wool: fibrous ochre)
    fib = blur(r.random((h, w)).astype(np.float32), (0.6, 4.0), wrap=False)
    wool = colorize(norm01(fib + 0.4 * mid), [(0, '#4f4636'), (0.5, '#6f6247'), (1, '#8d7b55')])
    ins = smoothstep(LAYER_OUT - 0.004, LAYER_OUT + 0.004, dep) * smoothstep(LAYER_INS + 0.004, LAYER_INS - 0.004, dep)
    alb = lerp(conc, wool, ins)
    hgt = lerp(hc, fib * 3 - 2.5, ins)
    # tile skin and plaster/wallpaper lines
    tile = smoothstep(0.008, 0.004, dep)
    alb = lerp(alb, srgb('#cbc3b1'), tile)
    pl = smoothstep(T - 0.012, T - 0.006, dep)
    alb = lerp(alb, srgb('#c9c2b0'), pl)
    alb = lerp(alb, srgb('#a89a72'), smoothstep(T - 0.004, T - 0.001, dep))
    rough = np.full((h, w), 0.95, np.float32)
    if sooty:
        s = np.clip(0.55 + 0.35 * mid + 0.4 * (1 - dep / T) * 0.5, 0, 1)
        alb = lerp(alb, srgb('#1d1b19'), s * 0.65)
    alb = alb * bake_shade(hgt, 0.7, 0.25, wrap=False)
    return alb, hgt, rough


def paint_concrete(rect, seed, tone='#8e8a82'):
    h, w = _shape(rect)
    fine = spectral(0, 0.6, seed, fmin=40, shape=(h, w)); mid = spectral(0, 1.6, seed + 1, fmin=3, fmax=120, shape=(h, w))
    base = srgb(tone)
    alb = base * (0.88 + 0.12 * norm01(mid)[..., None]) * (0.95 + 0.05 * fine[..., None])
    pores = (rng(seed).random((h, w)) < 0.004).astype(np.float32)
    alb = lerp(alb, srgb('#4b4843'), blur(pores, 0.6, False) * 3)
    # formwork lines / stains
    st = smoothstep(0.6, 1.6, spectral(0, 2.0, seed + 2, fmin=2, fmax=40, shape=(h, w)))
    alb = lerp(alb, srgb('#5c5850'), st * 0.4)
    hgt = fine * 0.4 + mid * 0.5 - pores * 2
    return alb, hgt, np.full((h, w), 0.9, np.float32)


def paint_interior(rect, seed):
    h, w = _shape(rect); r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ym = H - yy / PPM
    # floral damask wallpaper: motif repeat 0.32 x 0.36 m
    rw, rh = int(0.21 * PPM), int(0.25 * PPM)
    motif = np.zeros((rh, rw), np.float32)
    for k in range(5):
        a = k * np.pi * 2 / 5
        cv2.ellipse(motif, (rw // 2, rh // 2), (int(rw * 0.18), int(rh * 0.07)), np.degrees(a), 0, 360, 1.0, -1, cv2.LINE_AA)
    cv2.circle(motif, (rw // 2, rh // 2), int(rw * 0.05), 0.5, -1, cv2.LINE_AA)
    for (cx, cy) in ((0, 0), (rw, 0), (0, rh), (rw, rh)):
        cv2.ellipse(motif, (cx, cy), (int(rw * 0.12), int(rh * 0.05)), 30, 0, 360, 0.7, -1, cv2.LINE_AA)
    cv2.line(motif, (rw // 2, rh // 2 + int(rh * 0.1)), (rw // 2 + int(rw * 0.2), rh), 0.6, 1, cv2.LINE_AA)
    tiled = np.tile(motif, (h // rh + 2, w // rw + 2))[:h, :w]
    paper = lerp(srgb('#a89c7e'), srgb('#857e62'), tiled * 0.45)
    # vertical stripes in the paper
    paper = paper * (0.96 + 0.04 * np.sin(xx * 0.9)[..., None])
    # roll seams every 0.53 m, slightly lifted
    seam = np.exp(-(((xx % int(0.53 * PPM)) - 0) / 1.2) ** 2)
    paper = lerp(paper, srgb('#d4c9a8'), seam * 0.5)
    # torn / peeled patches showing plaster and old newspaper underlay
    tear = smoothstep(1.0, 1.4, spectral(0, 1.8, seed + 1, fmin=3, fmax=80, shape=(h, w)))
    plaster = colorize(norm01(spectral(0, 1, seed + 2, fmin=20, shape=(h, w))), [(0, '#a7a194'), (1, '#c8c2b4')])
    alb = lerp(paper, plaster, tear)
    # skirting board
    sk = (ym < 0.07).astype(np.float32)
    alb = lerp(alb, srgb('#4d3424'), sk)
    # damp stains and soot from above
    damp = smoothstep(0.9, 1.7, spectral(0, 2.2, seed + 3, fmin=2, fmax=40, shape=(h, w)))
    alb = lerp(alb, srgb('#7a6a48'), damp * 0.35)
    soot = smoothstep(1.5, 2.8, ym) * 0.45 * (0.7 + 0.3 * norm01(spectral(0, 1.5, seed + 4, fmin=3, fmax=80, shape=(h, w))))
    alb = lerp(alb, srgb('#26231f'), soot)
    hgt = tiled * 0.3 + seam * 0.5 - tear * 0.4 + sk * 1.5
    rough = 0.85 - sk * 0.3
    return alb, hgt, rough


def paint_floor(rect, seed):
    h, w = _shape(rect); r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    # printed parquet linoleum (herringbone-ish blocks)
    bw = 10
    blk = ((np.floor(xx / bw) + np.floor(yy / (bw * 4))) % 2)
    grain = spectral(0, 1.0, seed, fmin=20, shape=(h, w))
    alb = lerp(srgb('#4f4035'), srgb('#66533f'), norm01(blk * 0.5 + grain * 0.3))
    alb = alb * (0.92 + 0.08 * norm01(blur(r.random((h, w)).astype(np.float32), (0.3, 3), False)))[..., None]
    dust = smoothstep(-0.5, 1.5, spectral(0, 1.8, seed + 1, fmin=2, fmax=60, shape=(h, w)))
    alb = lerp(alb, srgb('#7d786e'), dust * 0.45)
    # debris specks
    sp = (r.random((h, w)) < 0.01).astype(np.float32)
    alb = lerp(alb, srgb('#b0aa9e'), sp * 0.7)
    hgt = sp * 2 + grain * 0.2
    return alb, hgt, 0.75 + dust * 0.2


def paint_ceiling(rect, seed):
    h, w = _shape(rect)
    n = spectral(0, 1.4, seed, fmin=3, fmax=100, shape=(h, w))
    alb = colorize(norm01(n), [(0, '#b9b4a9'), (1, '#d3cec3')])
    stain = smoothstep(0.8, 1.6, spectral(0, 2.2, seed + 1, fmin=2, fmax=40, shape=(h, w)))
    alb = lerp(alb, srgb('#8d7d5a'), stain * 0.45)
    soot = smoothstep(0.0, 1.5, spectral(0, 2.0, seed + 2, fmin=1, fmax=30, shape=(h, w))) * 0.6
    alb = lerp(alb, srgb('#2a2622'), soot)
    return alb, n * 0.2, np.full((h, w), 0.92, np.float32)


def paint_glass(rect, seed):
    h, w = _shape(rect); r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    # dark room behind + tulle curtain (sheer, pleated, lace border) + sky reflection gradient
    pleat = 0.5 + 0.5 * np.sin(xx * 0.45 + spectral(0, 2, seed, fmin=1, fmax=10, shape=(h, w)) * 1.5)
    lace = ((np.sin(xx * 0.9) * np.sin(yy * 0.9)) > 0.6).astype(np.float32) * (yy > h * 0.85)
    curtain = np.clip(pleat * 0.6 + lace * 0.5, 0, 1) * smoothstep(w * 0.75, w * 0.6, xx)
    alb = lerp(srgb('#121517'), srgb('#4d5254'), curtain * 0.7)
    refl = smoothstep(h, 0, yy) * 0.25
    alb = lerp(alb, srgb('#7d8a94'), refl)
    dirt = smoothstep(0.5, 1.5, spectral(0, 2, seed + 1, fmin=2, fmax=50, shape=(h, w)))
    alb = lerp(alb, srgb('#6f6a60'), dirt * 0.25)
    # crisscross paper tape (blast protection)
    tape = (np.exp(-((xx - yy * w / h) / 3) ** 2) + np.exp(-((xx - (h - yy) * w / h) / 3) ** 2))
    alb = lerp(alb, srgb('#b8b09a'), np.clip(tape, 0, 1) * 0.85)
    rough = 0.08 + dirt * 0.25 + np.clip(tape, 0, 1) * 0.8
    return alb, curtain * 0.2, rough


def paint_door(rect, seed):
    h, w = _shape(rect); r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    base = srgb('#5a3b2b')
    n = spectral(0, 1.2, seed, fmin=4, fmax=120, shape=(h, w))
    alb = base * (0.9 + 0.1 * norm01(n))[..., None]
    rust = smoothstep(0.7, 1.6, spectral(0, 1.8, seed + 1, fmin=3, fmax=80, shape=(h, w))) + smoothstep(h * 0.8, h, yy) * 0.6
    alb = lerp(alb, srgb('#6b3d1f'), np.clip(rust, 0, 1) * 0.7)
    # frame and panel embossing
    fr = ((xx < 10) | (xx > w - 10) | (yy < 8)).astype(np.float32)
    pnl = ((np.abs(xx - w / 2) < w * 0.32) & (np.abs(yy - h * 0.3) < h * 0.18)) | ((np.abs(xx - w / 2) < w * 0.32) & (np.abs(yy - h * 0.72) < h * 0.18))
    hgt = fr * 2 + pnl * 1.0
    # intercom panel + handle
    ic = ((np.abs(xx - w * 0.82) < 10) & (np.abs(yy - h * 0.48) < 18)).astype(np.float32)
    alb = lerp(alb, srgb('#9b9a96'), ic); hgt += ic * 2
    hd = ((np.abs(xx - w * 0.85) < 3) & (np.abs(yy - h * 0.55) < 14)).astype(np.float32)
    alb = lerp(alb, srgb('#2a2a2a'), hd); hgt += hd * 3
    # stickers / graffiti
    gr = smoothstep(1.4, 2.0, spectral(0, 1.0, seed + 2, fmin=8, fmax=100, shape=(h, w)))
    alb = lerp(alb, srgb('#d9d4c4'), gr * 0.6)
    return alb, hgt, 0.65 + rust * 0.25, np.clip(0.4 - rust * 0.3, 0, 1)


def paint_asbestos(rect, seed):
    h, w = _shape(rect)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    corr = np.sin(xx / w * 2 * np.pi * 8)       # 8 waves across the region
    n = spectral(0, 1.4, seed, fmin=4, fmax=120, shape=(h, w))
    alb = colorize(norm01(n), [(0, '#7d7b74'), (1, '#9d9a91')])
    lich = smoothstep(1.0, 1.8, spectral(0, 1.6, seed + 1, fmin=6, fmax=100, shape=(h, w)))
    alb = lerp(alb, srgb('#6e6b4e'), lich * 0.6)
    streak = blur(spectral(0, 1, seed + 2, fmin=10, shape=(h, w)), (20, 1), False)
    alb = lerp(alb, srgb('#4e4b45'), np.clip(streak, 0, 1) * 0.4)
    alb = alb * (0.88 + 0.12 * (corr * 0.5 + 0.5))[..., None]
    return alb, corr * 4 + n * 0.3, np.full((h, w), 0.93, np.float32)


def paint_roofing(rect, seed):
    h, w = _shape(rect); r = rng(seed)
    n = spectral(0, 1.0, seed, fmin=10, shape=(h, w))
    gran = (r.random((h, w)) ** 6).astype(np.float32)
    alb = colorize(norm01(n), [(0, '#232220'), (1, '#3a3834')]) + gran[..., None] * 0.15
    yy = np.mgrid[0:h, 0:w][0]
    seam = (np.abs((yy % 85) - 0) < 3).astype(np.float32)
    alb = lerp(alb, srgb('#151413'), seam)
    bub = smoothstep(1.2, 1.8, spectral(0, 1.6, seed + 1, fmin=5, fmax=60, shape=(h, w)))
    return alb, gran * 1.0 + seam * 1.5 + bub * 2, 0.8 - seam * 0.2


def paint_veneer(rect, seed):
    h, w = _shape(rect); r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    grain = np.sin(yy * 0.35 + spectral(0, 2, seed, fmin=2, fmax=30, shape=(h, w)) * 6)
    alb = lerp(srgb('#3f2618'), srgb('#6b4429'), grain * 0.5 + 0.5)
    # right third: chipboard core (broken edges)
    cb = (xx > w * 0.7).astype(np.float32)
    chip = colorize(r.random((h, w)).astype(np.float32), [(0, '#8a7350'), (1, '#c4a978')])
    alb = lerp(alb, chip, cb)
    return alb, grain * 0.3 + cb * r.random((h, w)) * 1.5, 0.55 + cb * 0.4


def paint_stair(rect, seed):
    h, w = _shape(rect); r = rng(seed)
    n = spectral(0, 0.8, seed, fmin=20, shape=(h, w))
    chips = (r.random((h, w)) ** 8).astype(np.float32)
    alb = colorize(norm01(n), [(0, '#6a645b'), (1, '#86807a')]) + chips[..., None] * srgb('#5a3a2a') * 0.6
    return alb, n * 0.3, np.full((h, w), 0.8, np.float32)


def paint_plinth(rect, seed):
    h, w = _shape(rect)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.4, seed, fmin=3, fmax=150, shape=(h, w))
    alb = colorize(norm01(n), [(0, '#4e4740'), (1, '#6a6056')])
    peel = smoothstep(0.8, 1.5, spectral(0, 1.8, seed + 1, fmin=4, fmax=100, shape=(h, w)))
    alb = lerp(alb, srgb('#8b867c'), peel)
    splash = smoothstep(h * 0.6, h, yy) * 0.4
    alb = lerp(alb, srgb('#3d352b'), splash)
    return alb, n * 0.4 - peel * 0.8, np.full((h, w), 0.92, np.float32)


def paint_small(name, rect, seed):
    h, w = _shape(rect); r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.2, seed, fmin=4, fmax=60, shape=(h, w)); f = spectral(0, 0.5, seed + 1, fmin=30, shape=(h, w))
    metal = np.zeros((h, w), np.float32); rough = np.full((h, w), 0.8, np.float32); hgt = f * 0.2
    if name == 'wood_paint':
        grain = np.sin(yy * 0.5 + n * 4)
        wood = lerp(srgb('#5e4a35'), srgb('#7b6447'), grain * 0.5 + 0.5)
        paint = srgb('#d2cec2') * (0.9 + 0.1 * norm01(f))[..., None]
        peel = smoothstep(0.6, 1.2, n)
        alb = lerp(paint, wood, peel); alb = lerp(alb, srgb('#8e897d'), smoothstep(-1, 1.5, f) * 0.2)
        rough = 0.75 + peel * 0.15; hgt = (1 - peel) * 0.8 + grain * 0.2
    elif name == 'pvc':
        alb = srgb('#e2e1dc') * (0.95 + 0.04 * norm01(n))[..., None] + np.zeros((h, w, 3)); rough[:] = 0.45
        alb = lerp(alb, srgb('#9c998f'), smoothstep(0.8, 1.8, n) * 0.4)
    elif name == 'rebar':
        rib = (np.sin(yy * 1.2) > 0.4).astype(np.float32)
        alb = lerp(srgb('#5a3420'), srgb('#7b4a2c'), norm01(n)) * (0.85 + 0.15 * rib[..., None])
        alb = lerp(alb, srgb('#2f2a26'), smoothstep(0.8, 1.8, f) * 0.6)
        metal[:] = 0.55; rough[:] = 0.75; hgt = rib * 1.5
    elif name == 'radiator':
        fin = (np.sin(xx * 0.55) > -0.2).astype(np.float32)
        alb = lerp(srgb('#8f887a'), srgb('#c9c2ae'), fin) * (0.9 + 0.1 * norm01(n))[..., None]
        alb = lerp(alb, srgb('#7b4a2a'), smoothstep(0.9, 1.8, n) * 0.6)
        hgt = fin * 3; rough[:] = 0.7; metal[:] = 0.15
    elif name == 'osb':
        F1, F2, ids = voronoi(0, 220, seed + 3, shape=(h, w))
        tone = r.random(220)[ids]
        alb = colorize(tone, [(0, '#6b5a43'), (0.5, '#86704f'), (1, '#9a8260')])
        alb = lerp(alb, srgb('#5a4228'), smoothstep(2.0, 0.5, F2 - F1) * 0.6)
        hgt = tone * 0.6; rough[:] = 0.85
    elif name == 'rag':
        flower = ((np.sin(xx * 0.4) * np.sin(yy * 0.4 + np.sin(xx * 0.2))) > 0.5).astype(np.float32)
        alb = lerp(srgb('#5e594f'), srgb('#6e4239'), flower * 0.5) * (0.85 + 0.15 * norm01(f))[..., None]
        alb = lerp(alb, srgb('#1f1c19'), np.clip(smoothstep(0.0, 1.4, n) * 0.8 + smoothstep(0.5, 0, yy / h) * 0.3, 0, 0.85))
        rough[:] = 0.95
    elif name == 'galv':
        alb = colorize(norm01(n), [(0, '#8c8d8a'), (1, '#a9aba6')]); alb = lerp(alb, srgb('#7a5434'), smoothstep(1.0, 1.8, f) * 0.6)
        metal[:] = 0.8; rough[:] = 0.5
    elif name == 'rail_paint':
        alb = srgb('#4d6a5b') * (0.9 + 0.1 * norm01(n))[..., None] + np.zeros((h, w, 3))
        alb = lerp(alb, srgb('#6b3f22'), smoothstep(0.7, 1.6, f) * 0.7); metal[:] = 0.3; rough[:] = 0.7
    elif name == 'brick_red':
        row = (yy // 16) % 2; bx = ((xx + row * 16) % 32) < 30; by = (yy % 16) < 14
        alb = lerp(srgb('#8f8a80'), srgb('#7a4636') * (0.8 + 0.25 * norm01(f))[..., None], (bx & by).astype(np.float32))
        hgt = (bx & by) * 2.0
    elif name == 'wallpaper2':
        stripe = (np.sin(xx * 0.5) > 0.3).astype(np.float32)
        alb = lerp(srgb('#8fa1ad'), srgb('#c4c7c0'), stripe); alb = lerp(alb, srgb('#2c2925'), smoothstep(0.5, 1.8, n) * 0.4)
    elif name == 'insulation':
        fib = blur(r.random((h, w)).astype(np.float32), (0.5, 3), False)
        alb = colorize(norm01(fib + n * 0.3), [(0, '#5a5040'), (1, '#8f7f5c')]); hgt = fib * 3; rough[:] = 1.0
    elif name == 'fabric':
        weave = (np.sin(xx * 2.0) * np.sin(yy * 2.0))
        alb = lerp(srgb('#6c5a4a'), srgb('#8d7a63'), norm01(n)) * (0.95 + 0.05 * weave)[..., None]; rough[:] = 1.0
        alb = lerp(alb, srgb('#2a2622'), smoothstep(0.8, 1.6, f) * 0.6)
    elif name == 'glass_broken':
        alb = colorize(norm01(n), [(0, '#2a3236'), (1, '#4a565b')]); rough[:] = 0.06
        alb = lerp(alb, srgb('#151413'), smoothstep(0.6, 1.6, f) * 0.5)
    elif name == 'soot':
        alb = colorize(norm01(n), [(0, '#0f0e0d'), (1, '#24211e')]); rough[:] = 0.98
    elif name == 'rubber':
        alb = colorize(norm01(n), [(0, '#1a1a19'), (1, '#2b2a28')]); rough[:] = 0.85
    else:  # metal_grey
        alb = colorize(norm01(n), [(0, '#55534f'), (1, '#77756f')]); metal[:] = 0.6; rough[:] = 0.6
        alb = lerp(alb, srgb('#6b4426'), smoothstep(0.9, 1.7, f) * 0.6)
    return alb, hgt, rough, metal


def build_atlas():
    A = Atlas()
    for si, state in enumerate(['intact', 'damaged', 'holed']):
        for ti, t in enumerate(TYPES):
            alb, hgt, rough = paint_facade(t, state, 1000 + si * 10 + ti)
            A.put(cell_rect(t, state), alb, hgt * 1.0, rough)
    a, hh, rr = paint_section(REG['section'], True, 2001); A.put(REG['section'], a, hh, rr)
    a, hh, rr = paint_section(REG['section_clean'], False, 2002); A.put(REG['section_clean'], a, hh, rr)
    a, hh, rr = paint_concrete(REG['concrete'], 2003); A.put(REG['concrete'], a, hh, rr)
    a, hh, rr = paint_interior(REG['interior'], 2004); A.put(REG['interior'], a, hh, rr)
    a, hh, rr = paint_floor(REG['floor'], 2005); A.put(REG['floor'], a, hh, rr)
    a, hh, rr = paint_ceiling(REG['ceiling'], 2006); A.put(REG['ceiling'], a, hh, rr)
    a, hh, rr = paint_glass(REG['glass'], 2007); A.put(REG['glass'], a, hh, rr, ao=np.ones(_shape(REG['glass']), np.float32))
    a, hh, rr, mm = paint_door(REG['door'], 2008); A.put(REG['door'], a, hh, rr, mm)
    a, hh, rr = paint_asbestos(REG['asbestos'], 2009); A.put(REG['asbestos'], a, hh, rr)
    a, hh, rr = paint_roofing(REG['roofing'], 2010); A.put(REG['roofing'], a, hh, rr)
    a, hh, rr = paint_veneer(REG['veneer'], 2011); A.put(REG['veneer'], a, hh, rr)
    a, hh, rr = paint_stair(REG['stair'], 2012); A.put(REG['stair'], a, hh, rr)
    a, hh, rr = paint_plinth(REG['plinth'], 2013); A.put(REG['plinth'], a, hh, rr)
    for i, n in enumerate(SMALL):
        a, hh, rr, mm = paint_small(n, REG[n], 2100 + i); A.put(REG[n], a, hh, rr, mm)
    return A.save('kit_atlas')


if __name__ == '__main__':
    import time; t0 = time.time()
    p = build_atlas(); print(p, time.time() - t0)
