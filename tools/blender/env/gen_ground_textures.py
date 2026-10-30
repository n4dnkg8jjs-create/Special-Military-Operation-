"""Seamless 2048^2 ground texture sets -> assets/textures/<name>_{albedo.jpg,normal.png,orm.png}.
Run: nice -n 10 python3 tools/blender/env/gen_ground_textures.py [names...]
Physical scale (as used by src/world/city.js): asphalt tile = 7 m, concrete = 4 m, dirt = 6 m, rubble = 2.5 m,
brick = 2.08 x 2.10 m (8 bricks x 28 courses of 250x65 silicate brick + 10 mm joints).
"""
import os, sys, time
import numpy as np
import cv2
from texlib import *

S = 2048
OUT = os.path.join(REPO, 'assets', 'textures')


def cells_by_id(ids, values):
    return values[ids]


def faceted_stones(n, seed, rmin, rmax, warp=0.0, shape=(S, S)):
    """Angular broken stones: each Voronoi cell gets a random tilted plane, clipped by distance to its border.
    Returns height (0 = gap/ground), cell id, edge distance."""
    h, w = shape
    r = rng(seed)
    pts = np.stack([r.random(n) * w, r.random(n) * h], -1)
    F1, F2, ids = voronoi(S, n, seed, warp=warp, shape=shape, jitter_pts=pts)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = pts[ids, 0], pts[ids, 1]
    dx = (xx - cx + w / 2) % w - w / 2
    dy = (yy - cy + h / 2) % h - h / 2
    a = r.normal(0, 0.35, n)[ids]
    b = r.normal(0, 0.35, n)[ids]
    base = r.uniform(rmin, rmax, n)[ids]
    plane = base + a * dx + b * dy
    edge = F2 - F1
    keep = r.random(n)[ids]
    hgt = np.minimum(plane, edge * 1.4)
    return np.clip(hgt, 0, None), ids, edge, keep


def tex_asphalt():
    t0 = time.time()
    r = rng(11)
    low = spectral(S, 2.2, 1, fmin=1, fmax=40)
    mid = spectral(S, 1.6, 2, fmin=8, fmax=400)
    fine = spectral(S, 0.6, 3, fmin=100)
    # aggregate stones (radius 2-6 px ~ 7-20 mm)
    n = 70000
    pts = np.stack([r.random(n) * S, r.random(n) * S], -1)
    F1, F2, ids = voronoi(S, n, 12, warp=1.2, jitter_pts=pts)
    rad = r.uniform(1.2, 4.0, n)
    stone = np.clip(1.0 - F1 / rad[ids], 0, 1) ** 0.6
    stone_tone = r.uniform(0.0, 1.0, n)[ids]
    worn = smoothstep(-0.6, 1.2, low * 0.7 + mid * 0.3)          # where binder is worn and stones show
    exposed = stone * smoothstep(0.25, 0.6, stone) * (0.15 + 0.75 * worn) * (r.random(n)[ids] < 0.7)
    binder = colorize(norm01(mid * 0.5 + fine * 0.25 + low * 0.25), [(0, '#2e2d2b'), (0.5, '#43413d'), (1, '#575450')])
    stonecol = colorize(stone_tone, [(0, '#5d5a55'), (0.4, '#7f7a72'), (0.75, '#9b958b'), (0.9, '#7b6656'), (1, '#b1aca3')])
    alb = lerp(binder, stonecol, np.clip(exposed * 1.3, 0, 1))
    hgt = stone * 1.2 * (0.4 + 0.6 * worn) + fine * 0.15 + mid * 0.6
    rough = 0.9 - exposed * 0.12
    # alligator cracking zones + long cracks
    zone = smoothstep(0.0, 0.8, spectral(S, 2.5, 21, fmin=1, fmax=12))
    gator = crack_lines(S, 1400, 22, width=1.6, warp=10.0)
    longc = random_walk_cracks((S, S), 14, 23, length=(150, 500), step=3.0, width=2.0, branch=0.6)
    crack = np.clip(gator * zone + longc, 0, 1)
    crack_w = blur(crack, 2.5)
    hgt -= crack * 3.0
    hgt += np.clip(crack_w - crack, 0, 1) * 0.6           # slightly raised lips
    alb = lerp(alb, srgb('#1a1917'), crack * 0.85)
    rough = np.maximum(rough, crack * 0.97)
    # crack sealant bands on some long cracks (glossy tar, ~3 cm wide)
    seal = blur(random_walk_cracks((S, S), 5, 31, length=(250, 600), step=3.0, width=7.0, branch=0.0), 1.0)
    seal = smoothstep(0.3, 0.6, seal)
    alb = lerp(alb, srgb('#1c1b1a'), seal * 0.9)
    rough = lerp(rough, 0.55, seal)
    hgt = lerp(hgt, hgt * 0.2 + 0.4, seal)
    # repair patches (rectangles, wrapped), darker & smoother, tar seam around
    patch = np.zeros((S, S), np.float32); seam = np.zeros((S, S), np.float32)
    for k in range(5):
        w, h = r.integers(220, 620), r.integers(160, 480)
        x, y = r.integers(0, S), r.integers(0, S)
        box = cv2.boxPoints(((float(x), float(y)), (float(w), float(h)), float(r.uniform(-4, 4)))).astype(np.int32)
        for oy in (-S, 0, S):
            for ox in (-S, 0, S):
                bb = box + [ox, oy]
                cv2.fillPoly(patch, [bb], 1.0)
                cv2.polylines(seam, [bb], True, 1.0, 5, lineType=cv2.LINE_AA)
    patch = np.clip(patch, 0, 1); seam = np.clip(seam, 0, 1)
    pmid = spectral(S, 1.5, 61, fmin=10, fmax=500)
    pnoise = colorize(norm01(fine * 0.35 + pmid * 0.65), [(0, '#232220'), (0.6, '#33322f'), (1, '#45433f')])
    pstone = np.clip(1.0 - F1 / (rad[ids] * 0.6), 0, 1) * (r.random(n)[ids] < 0.35) * smoothstep(-0.5, 1.0, pmid)
    patch_alb = lerp(pnoise, stonecol * 0.8, pstone)
    alb = lerp(alb, patch_alb, patch)
    alb = alb * bake_shade(hgt, 0.6, 0.18)
    hgt = lerp(hgt, 0.5 + fine * 0.1 + stone * 0.3, patch)
    rough = lerp(rough, 0.8, patch)
    alb = lerp(alb, srgb('#141413'), seam * 0.9)
    rough = lerp(rough, 0.5, seam)
    # potholes with exposed gravel
    pot = np.zeros((S, S), np.float32)
    for k in range(3):
        cx, cy, rr = r.uniform(0, S), r.uniform(0, S), r.uniform(40, 110)
        stamp_disc(pot, cx, cy, rr, 1.0, soft=rr * 0.5, wrap=True)
    pot = smoothstep(0.1, 0.9, pot * (0.8 + 0.4 * norm01(spectral(S, 1.5, 41, fmin=20))))
    gravel = colorize(stone_tone, [(0, '#3d3b37'), (1, '#77726a')])
    alb = lerp(alb, lerp(srgb('#2a2622'), gravel, stone), pot)
    hgt -= pot * 6.0
    hgt += pot * stone * 1.0
    # oil / soot stains and dust
    oil = smoothstep(0.9, 1.8, spectral(S, 2.4, 51, fmin=3, fmax=60)) * 0.6
    alb = lerp(alb, srgb('#1b1a19'), oil)
    rough = lerp(rough, 0.6, oil)
    dust = smoothstep(0.0, 1.5, low) * 0.18 + np.clip(blur(-hgt, 3) - (-hgt), 0, 1) * 0.0
    alb = lerp(alb, srgb('#7a7366'), dust)
    # shrapnel scars: light chipped spots
    scar = np.zeros((S, S), np.float32)
    for k in range(260):
        stamp_disc(scar, r.uniform(0, S), r.uniform(0, S), r.uniform(1.5, 5), 1.0, 1.2, wrap=True)
    alb = lerp(alb, srgb('#77736b'), scar * 0.6)
    hgt -= scar * 1.0
    ao = cavity_ao(hgt, 5, 0.25) * cavity_ao(hgt, 30, 0.08)
    nrm = normal_from_height(hgt, 1.2)
    save_set(OUT, 'asphalt', alb, nrm, ao, np.clip(rough, 0, 1))
    print('asphalt', time.time() - t0)


def tex_concrete():
    """Cast concrete pavement / yard slabs, 4 m tile, saw joints every 2 m."""
    t0 = time.time(); r = rng(101)
    low = spectral(S, 2.3, 102, fmin=1, fmax=30)
    mid = spectral(S, 1.4, 103, fmin=6, fmax=300)
    fine = spectral(S, 0.5, 104, fmin=200)
    sand = r.random((S, S)).astype(np.float32)
    base = colorize(norm01(low * 0.5 + mid * 0.35 + fine * 0.15), [(0, '#7a766e'), (0.45, '#938e85'), (0.8, '#a39e94'), (1, '#b0aba0')])
    alb = base * (0.94 + 0.12 * sand[..., None] ** 2)
    # exposed fine aggregate where surface is worn
    n = 40000
    F1, F2, ids = voronoi(S, n, 105, warp=1.0)
    rad = r.uniform(1.0, 3.6, n)[ids]
    agg = np.clip(1 - F1 / rad, 0, 1)
    worn = smoothstep(-0.4, 1.4, low * 0.6 + mid * 0.4)
    tone = r.random(n)[ids]
    alb = lerp(alb, colorize(tone, [(0, '#6d6961'), (0.6, '#a8a297'), (1, '#c2bcb0')]), agg * worn * 0.8)
    hgt = low * 1.5 + mid * 0.5 + fine * 0.1 + agg * worn * 0.5
    # pores
    pores = (r.random((S, S)) < 0.0035).astype(np.float32)
    pores = np.clip(blur(pores, 0.8) * 6, 0, 1)
    hgt -= pores * 1.2; alb = lerp(alb, srgb('#4a4741'), pores * 0.6)
    # saw joints every 1024 px (2 m), offset 512; chipped edges
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    jn = spectral(S, 1.8, 106, fmin=10, fmax=200)
    def joint_d(c):
        return np.abs(((c - 512) % 1024) - 512)
    jd = np.minimum(joint_d(xx + jn * 2), joint_d(yy + jn * 2))
    chip = np.clip(spectral(S, 1.2, 107, fmin=30) * 1.5 - 0.6, 0, 3)
    jw = 3.5 + chip * 4
    joint = 1 - smoothstep(jw - 1.5, jw + 1.5, jd)
    hgt -= joint * 6.0
    alb = lerp(alb, srgb('#3d3a34'), joint * 0.85)
    # dirt and moss creeping out of joints
    jb = blur(joint, 14)
    alb = lerp(alb, srgb('#5c5644'), np.clip(jb * 2.0, 0, 0.55))
    moss = np.clip(jb * 3, 0, 1) * smoothstep(0.3, 1.2, spectral(S, 2, 108, fmin=4, fmax=120))
    alb = lerp(alb, srgb('#4b5132'), moss * 0.45)
    # cracks
    cr = random_walk_cracks((S, S), 18, 109, length=(80, 400), step=2.5, width=1.6, branch=0.5)
    hgt -= cr * 2.5; alb = lerp(alb, srgb('#34312c'), cr * 0.8)
    # stains: rust, oil, water
    stain = smoothstep(0.8, 1.9, spectral(S, 2.4, 110, fmin=2, fmax=50))
    alb = lerp(alb, srgb('#5a554c'), stain * 0.5)
    rust = smoothstep(1.3, 2.4, spectral(S, 2.2, 111, fmin=4, fmax=80))
    alb = lerp(alb, srgb('#7a5a40'), rust * 0.35)
    # shrapnel pockmarks: dark pit + lighter fresh concrete halo
    pit = np.zeros((S, S), np.float32); halo = np.zeros((S, S), np.float32)
    for k in range(120):
        cx, cy, rr = r.uniform(0, S), r.uniform(0, S), r.uniform(2, 9)
        stamp_disc(pit, cx, cy, rr, 1, 1.5, wrap=True); stamp_disc(halo, cx, cy, rr * 2.2, 1, rr, wrap=True)
    alb = lerp(alb, srgb('#bdb7ab'), np.clip(halo - pit, 0, 1) * 0.45)
    alb = lerp(alb, srgb('#55524c'), pit * 0.7)
    hgt -= pit * 3
    rough = np.clip(0.9 - agg * worn * 0.08 + joint * 0.05, 0, 1)
    ao = cavity_ao(hgt, 4, 0.25) * cavity_ao(hgt, 24, 0.06)
    save_set(OUT, 'concrete', alb, normal_from_height(hgt, 1.0), ao, rough)
    print('concrete', time.time() - t0)


def tex_brick():
    """White silicate (sand-lime) brick, stretcher bond, 8 x 28 courses."""
    t0 = time.time(); r = rng(201)
    nb, nc = 8, 28
    bw, ch = S / nb, S / nc
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    jit = spectral(S, 1.6, 202, fmin=20, fmax=300) * 0.7
    row = np.floor((yy + jit) / ch).astype(np.int32) % nc
    off = (row % 2) * (bw / 2)
    xs = (xx + jit + off) % S
    col = np.floor(xs / bw).astype(np.int32) % nb
    lx = xs - col * bw
    ly = (yy + jit) % S - np.floor((yy + jit) % S / ch) * ch
    joint = 10.0  # px ~ 10 mm
    dx = np.minimum(lx, bw - lx); dy = np.minimum(ly, ch - ly)
    # per-brick chipped edges
    brick_id = row * nb + col
    chipn = spectral(S, 1.3, 203, fmin=40)
    edge = np.minimum(dx, dy) - joint / 2 - np.clip(chipn * 1.6 - 1.2, 0, 3)
    mask = smoothstep(-0.5, 1.5, edge)
    bev = smoothstep(0, 4, edge)
    tone = r.random(nb * nc)[brick_id]
    tint = r.random(nb * nc)[brick_id]
    fine = spectral(S, 0.4, 204, fmin=300)
    speck = (r.random((S, S)) ** 30).astype(np.float32)
    bcol = colorize(tone, [(0, '#a7a297'), (0.5, '#c4bfb3'), (0.85, '#d2cdc1'), (1, '#b8ad97')])
    bcol = lerp(bcol, srgb('#bba98a'), (tint > 0.85) * 0.5)        # a few yellowish bricks
    bcol *= (0.95 + 0.08 * fine[..., None])
    bcol = lerp(bcol, srgb('#6d6a64'), speck * 0.8)
    mortar = colorize(norm01(spectral(S, 1.0, 205, fmin=50)), [(0, '#8a857b'), (1, '#a49e92')])
    alb = lerp(mortar, bcol, mask)
    # spalled bricks (frost / shrapnel): missing face area, darker rough inside
    spall = np.zeros((S, S), np.float32)
    for k in range(40):
        stamp_disc(spall, r.uniform(0, S), r.uniform(0, S), r.uniform(6, 30), 1, 6, wrap=True)
    spall *= smoothstep(0.2, 0.6, norm01(spectral(S, 1.2, 206, fmin=30))) * mask
    alb = lerp(alb, srgb('#8f8a80'), spall * 0.7)
    # soot and grime gradient bands (runs down from above: vertical streaks)
    streak = blur(spectral(S, 1.5, 207, fmin=2, fmax=200), (0.5, 0.5)) if False else None
    sx = spectral(S, 1.2, 208, fmin=6, fmax=200, shape=(S, S))
    vert = blur(sx, 0.1)
    vstreak = ndimage.gaussian_filter(sx, (60, 1.5), mode='wrap')
    grime = smoothstep(0.4, 1.4, vstreak * 2.0) * 0.18 + smoothstep(0.7, 1.8, spectral(S, 2.3, 209, fmin=1, fmax=20)) * 0.3
    alb = lerp(alb, srgb('#4a4640'), np.clip(grime, 0, 0.6))
    hgt = mask * 4 + bev * 1.0 + fine * 0.3 - spall * 3.5 + chipn * 0.2 * mask
    alb = alb * bake_shade(hgt, 0.5, 0.25)
    rough = 0.92 - mask * 0.04
    ao = cavity_ao(hgt, 4, 0.3)
    save_set(OUT, 'brick', alb, normal_from_height(hgt, 0.8), ao, rough)
    print('brick', time.time() - t0)


def tex_dirt():
    """Trampled mud / dry dirt with pebbles, straw, wet patches; 6 m tile."""
    t0 = time.time(); r = rng(301)
    low = spectral(S, 2.4, 302, fmin=1, fmax=24)
    mid = spectral(S, 1.7, 303, fmin=6, fmax=300)
    fine = spectral(S, 0.7, 304, fmin=150)
    wet = smoothstep(-0.6, 1.4, low * 0.8 + mid * 0.35)
    dry = colorize(norm01(mid * 0.6 + fine * 0.4), [(0, '#6a5a46'), (0.5, '#7d6c55'), (1, '#93826a')])
    wetc = colorize(norm01(mid * 0.6 + fine * 0.4), [(0, '#352b20'), (1, '#4c3e2e')])
    alb = lerp(dry, wetc, wet * 0.85)
    hgt = low * 3 + mid * 1.4 + fine * 0.25
    # dry cracked mud plates in dry areas
    cr = crack_lines(S, 2600, 305, width=0.9, warp=4.0) * smoothstep(0.3, 1.0, spectral(S, 2, 307, fmin=2, fmax=30))
    dmask = smoothstep(0.55, 0.1, wet)
    alb = lerp(alb, srgb('#3a2f24'), cr * dmask * 0.35)
    hgt -= cr * dmask * 1.5
    # boot / tread imprints: small lozenge stamps
    imp = np.zeros((S, S), np.float32)
    for k in range(26):
        cx, cy = r.uniform(0, S), r.uniform(0, S); ang = r.uniform(0, 180)
        box = cv2.boxPoints(((cx, cy), (r.uniform(40, 55), r.uniform(100, 130)), ang)).astype(np.int32)
        for oy in (-S, 0, S):
            for ox in (-S, 0, S):
                cv2.fillPoly(imp, [box + [ox, oy]], 1.0)
        # lugs: thin bars across the sole
        for j in range(7):
            t = (j - 3) / 3.5 * 52
            a = np.radians(ang)
            p0 = (cx - np.sin(a) * t - np.cos(a) * 22, cy + np.cos(a) * t - np.sin(a) * 22)
            p1 = (cx - np.sin(a) * t + np.cos(a) * 22, cy + np.cos(a) * t + np.sin(a) * 22)
            cv2.line(imp, (int(p0[0]), int(p0[1])), (int(p1[0]), int(p1[1])), 1.6, 5)
    imp = np.clip(imp, 0, 1.6) / 1.6
    imp = blur(imp, 1.5) * wet
    hgt -= imp * 2
    # pebbles
    n = 9000
    pts = np.stack([r.random(n) * S, r.random(n) * S], -1)
    F1, F2, ids = voronoi(S, n, 306, warp=2.0, jitter_pts=pts)
    rad = r.uniform(2, 11, n) * (r.random(n) < 0.35)
    peb = np.clip(1 - F1 / np.maximum(rad[ids], 1e-3), 0, 1) ** 0.5 * (rad[ids] > 0)
    ptone = r.random(n)[ids]
    alb = lerp(alb, colorize(ptone, [(0, '#5a544b'), (0.5, '#7d766b'), (0.8, '#8f877a'), (1, '#6e5444')]) * (0.6 + 0.5 * peb)[..., None], smoothstep(0.05, 0.3, peb) * 0.9)
    hgt += peb * 3.5
    # straw / dead grass blades
    straw = np.zeros((S, S), np.float32)
    for k in range(7000):
        x, y = r.uniform(0, S), r.uniform(0, S)
        L = r.uniform(12, 50); a = r.uniform(0, np.pi)
        cv2.line(straw, (int(x * 4), int(y * 4)), (int((x + np.cos(a) * L) * 4), int((y + np.sin(a) * L) * 4)), r.uniform(0.5, 1.0), 1, cv2.LINE_AA, shift=2)
    straw = np.clip(straw, 0, 1) * smoothstep(0.8, 0.3, wet)
    scol = colorize(norm01(fine), [(0, '#6e6040'), (1, '#a8975f')])
    alb = lerp(alb, scol, straw * 0.85)
    hgt += straw * 1.2
    # puddles in the lowest wet areas
    pud = smoothstep(1.2, 1.6, -(low * 0.9 + mid * 0.1)) * wet
    alb = lerp(alb, srgb('#241d16'), pud * 0.7)
    hgt = lerp(hgt, np.full_like(hgt, -4.0), pud)
    rough = np.clip(0.95 - wet * 0.25 - pud * 0.6, 0.08, 1)
    alb = alb * bake_shade(hgt, 0.5, 0.3)
    ao = cavity_ao(hgt, 6, 0.15)
    save_set(OUT, 'dirt', alb, normal_from_height(hgt, 1.0), ao, rough)
    print('dirt', time.time() - t0)


def tex_rubble():
    """Ground strewn with concrete gravel, silicate & red brick bits, glass, dust. 2.5 m tile."""
    t0 = time.time(); r = rng(401)
    dust_n = spectral(S, 1.4, 402, fmin=4, fmax=300)
    fine = spectral(S, 0.6, 403, fmin=150)
    dust = colorize(norm01(dust_n * 0.7 + fine * 0.3), [(0, '#6c665d'), (0.5, '#857f75'), (1, '#9c968a')])
    hgt = dust_n * 1.5 + fine * 0.3
    alb = dust.copy(); rough = np.full((S, S), 0.95, np.float32); metal = np.zeros((S, S), np.float32)
    # layer 1: large angular chunks (concrete with occasional painted / tiled face)
    for seed, n, rmin, rmax, keepp in ((404, 900, 10, 24, 0.4), (405, 5000, 4, 10, 0.45), (406, 22000, 1.5, 5, 0.55)):
        hs, ids, edge, keep = faceted_stones(n, seed, rmin, rmax, warp=4.0)
        m = (keep < keepp)
        hs = hs * m
        sel = hs > 0.5
        n_ = ids.max() + 1
        kind = rng(seed + 1).random(n_)[ids]
        tone = rng(seed + 2).random(n_)[ids]
        conc = colorize(tone, [(0, '#77726a'), (0.5, '#99938a'), (1, '#b3ada2')])
        redb = colorize(tone, [(0, '#7a4b3a'), (1, '#8f604a')])
        whiteb = colorize(tone, [(0, '#b2ad a2'.replace(' ', '')), (1, '#cdc8bb')])
        asph = colorize(tone, [(0, '#4a4844'), (1, '#5d5b56')])
        c = np.where((kind < 0.72)[..., None], conc, np.where((kind < 0.8)[..., None], redb, np.where((kind < 0.94)[..., None], whiteb, asph)))
        c = c * (0.85 + 0.2 * norm01(fine)[..., None]) * (0.85 + 0.15 * np.clip(edge / 6, 0, 1))[..., None]
        top = hs > hgt
        alb = np.where((top & sel)[..., None], c, alb)
        hgt = np.where(top, np.maximum(hgt, hs), hgt)
    # glass shards: tiny bright specks, low roughness
    gl = (r.random((S, S)) < 0.0008).astype(np.float32)
    gl = np.clip(blur(gl, 0.7) * 5, 0, 1)
    alb = lerp(alb, srgb('#9fb0ad'), gl * 0.7); rough = lerp(rough, 0.1, gl)
    # rebar / wire bits: thin dark rusty lines
    wire = np.zeros((S, S), np.float32)
    for k in range(70):
        x, y, a, L = r.uniform(0, S), r.uniform(0, S), r.uniform(0, np.pi), r.uniform(30, 160)
        pts = [(x + np.cos(a) * L * t + np.sin(t * 6) * 3, y + np.sin(a) * L * t) for t in np.linspace(0, 1, 8)]
        _draw = __import__('texlib')._draw_poly; _draw(wire, pts, 2.0, True)
    alb = lerp(alb, srgb('#4a2c1c'), wire * 0.9); hgt += wire * 2.5; rough = lerp(rough, 0.7, wire); metal = np.maximum(metal, wire * 0.5)
    # wood splinters
    wood = np.zeros((S, S), np.float32)
    for k in range(60):
        x, y, a = r.uniform(0, S), r.uniform(0, S), r.uniform(0, np.pi)
        box = cv2.boxPoints(((x, y), (r.uniform(40, 140), r.uniform(5, 14)), np.degrees(a))).astype(np.int32)
        cv2.fillPoly(wood, [box], 1.0)
    alb = lerp(alb, colorize(norm01(fine), [(0, '#4a3a2a'), (1, '#6e5639')]), wood * 0.9); hgt += wood * 3
    # fine dust settling into gaps
    gap = np.clip(blur(hgt, 3) - hgt, 0, 3) / 3
    alb = lerp(alb, srgb('#8d877b'), gap * 0.5)
    dcov = smoothstep(-1.0, 1.5, spectral(S, 1.8, 410, fmin=3, fmax=200)) * 0.45
    alb = lerp(alb, srgb('#8a8478'), dcov)
    alb = alb * bake_shade(hgt, 0.35, 0.35) * 0.82
    ao = cavity_ao(hgt, 4, 0.12) * cavity_ao(hgt, 16, 0.05)
    save_set(OUT, 'rubble', alb, normal_from_height(hgt, 0.7), ao, rough, metal)
    print('rubble', time.time() - t0)


if __name__ == '__main__':
    names = sys.argv[1:] or ['asphalt', 'concrete', 'brick', 'dirt', 'rubble']
    for n in names:
        globals()['tex_' + n]()
