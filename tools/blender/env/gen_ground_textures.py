"""Seamless 2048^2 ground texture sets -> assets/textures/<name>_{albedo.jpg,normal.png,orm.png}
(asphalt / concrete / curb are written as final JPGs by road_tex.py).
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
    """Old Soviet-era street asphalt, 7 m tile: aggregate, ravelling, saw-cut repairs of different age, crack sealing
    (tar snakes), open cracks, oil drips, dust, shrapnel gouges. Built in road_tex.py; writes the final JPGs directly
    (albedo + normal 2048^2, ORM 1024^2) - no PNG->JPG step needed."""
    import road_tex as RT
    t0 = time.time(); RT.tex_asphalt(S, 7.0)
    print('asphalt', time.time() - t0)


def tex_concrete():
    """Pavement, 4 m tile: grey 200 x 100 mm concrete pavers in running bond (road_tex.py; final JPGs)."""
    import road_tex as RT
    t0 = time.time(); RT.tex_concrete(S, 4.0)
    print('concrete', time.time() - t0)


def tex_curb():
    """Precast kerb stone for city.js curbs (BoxGeometry 0.98 x 0.2 x 0.22, default UVs) -> curb_*.jpg 1024^2 (ORM 512^2)."""
    import road_tex as RT
    t0 = time.time(); RT.tex_curb(1024)
    print('curb', time.time() - t0)


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
    """Dry dusty Ukrainian chernozem / loam, 6 m tile (341 px/m): crumb aggregates, clods, patches of cracked
    dry crust, grit / gravel / stones, straw bits, twigs, leaf flakes, a few damp darkened spots. Low macro
    contrast (no repeating blotches) - the city / farmland ground shaders add anti-tiling and macro tint.
    Layers live in soil_tex.py (shared with gen_farm_ground.tex_track)."""
    import soil_tex as ST
    t0 = time.time()
    L = ST.soil((S, S), S / 6.0, 3100, crust=0.4, damp=0.05)
    alb, hp, ao = ST.finish(L['alb'], L['hgt'], L['mm'], shade=0.25)
    save_set(OUT, 'dirt', alb, normal_from_height(hp, 0.9), ao, L['rough'], nblur=0.5)
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
    names = sys.argv[1:] or ['asphalt', 'concrete', 'curb', 'brick', 'dirt', 'rubble']
    for n in names:
        globals()['tex_' + n]()
