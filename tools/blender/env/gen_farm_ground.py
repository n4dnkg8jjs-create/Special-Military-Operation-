"""Seamless 1024^2 farmland ground sets for src/world/farmland.js -> assets/textures/<name>_{albedo,normal,orm}.jpg
(same layout as grass_*: albedo + normal 1024^2, ORM 512^2, all JPEG; normal = OpenGL tangent space).
  plowed   autumn-ploughed chernozem: moldboard furrows along V (11 per tile), clods, dry crust on the ridge tops; 1 tile = 4 m
  stubble  harvested wheat field: 26 drill rows of pale stubble along V (15 cm), chopped straw litter + a swath band, dry soil; 4 m
  fallow   overgrown weedy fallow (ragweed / wormwood / couch grass), olive-tan, patches of bare soil, no rows; 4 m
  track    dirt farm track strip: U spans the 6.2 m strip width (two compacted tyre ruts at u = 0.36 / 0.64 with tread marks,
           grassy centre hump, verges), V = 4.5 m along the track (seamless along V)
Run: cd tools/blender/env && nice -n 10 python3 gen_farm_ground.py [names...]
"""
import os, sys, time
import numpy as np
import cv2
from PIL import Image
from texlib import (spectral, norm01, colorize, srgb, lerp, to8, normal_from_height, smoothstep, blur, voronoi, rng,
                    cavity_ao, bake_shade, crack_lines, REPO)

S = 1024
OUT = os.path.join(REPO, 'assets', 'textures')


def save(name, alb, hgt, rough, nstrength=1.0, ao_k=0.15):
    ao = cavity_ao(hgt, 5, ao_k)
    alb = alb * bake_shade(hgt, 0.5, 0.25)
    Image.fromarray(to8(alb)).save(os.path.join(OUT, f'{name}_albedo.jpg'), quality=90, optimize=True)
    nrm = normal_from_height(hgt, nstrength)
    nrm = to8(blur(nrm.astype(np.float32) / 255.0, 0.6))
    Image.fromarray(nrm).save(os.path.join(OUT, f'{name}_normal.jpg'), quality=90, optimize=True)
    orm = to8(np.stack([ao, np.clip(rough, 0, 1), np.zeros_like(ao)], -1))
    Image.fromarray(orm).resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, f'{name}_orm.jpg'), quality=90, optimize=True)


def strokes(n, seed, L, ang, spread, width=1, wrap=True, shape=(S, S), mask=None, val=(0.4, 1.0), curve=0.0):
    """Wrapped anti-aliased line strokes -> (coverage, tone). mask(x, y) -> probability to keep."""
    h, w = shape; r = rng(seed)
    m = np.zeros(shape, np.float32); t = np.zeros(shape, np.float32)
    for _ in range(n):
        x, y = r.uniform(0, w), r.uniform(0, h)
        if mask is not None and r.random() > mask(x, y):
            continue
        l = r.uniform(*L); a = ang + r.normal(0, spread); v = r.uniform(*val)
        pts = [(x, y)]
        for k in range(3 if curve else 1):
            a += r.normal(0, curve)
            pts.append((pts[-1][0] + np.cos(a) * l / (3 if curve else 1), pts[-1][1] + np.sin(a) * l / (3 if curve else 1)))
        for ox in ((-w, 0, w) if wrap else (0,)):
            for oy in ((-h, 0, h) if wrap else (0,)):
                for p0, p1 in zip(pts[:-1], pts[1:]):
                    q0 = (int((p0[0] + ox) * 4), int((p0[1] + oy) * 4)); q1 = (int((p1[0] + ox) * 4), int((p1[1] + oy) * 4))
                    cv2.line(m, q0, q1, 1.0, width, cv2.LINE_AA, shift=2)
                    cv2.line(t, q0, q1, v, width, cv2.LINE_AA, shift=2)
    return np.clip(m, 0, 1), t


def clods(seed, n, rmin, rmax, warp=2.0):
    r = rng(seed)
    pts = np.stack([r.random(n) * S, r.random(n) * S], -1)
    F1, F2, ids = voronoi(S, n, seed, warp=warp, jitter_pts=pts)
    rad = r.uniform(rmin, rmax, n)
    body = np.clip(1 - F1 / rad[ids], 0, 1)
    edge = smoothstep(0.0, 3.0, F2 - F1)
    return body ** 0.6 * edge, r.random(n)[ids], ids


# ---------------------------------------------------------------- plowed chernozem
def tex_plowed():
    t0 = time.time()
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    u = xx / S
    wob = spectral(S, 3.0, 401, fmin=1, fmax=6) * 0.06 + blur(spectral(S, 1.5, 402, fmin=2, fmax=60), (8, 1)) * 0.02
    K = 11
    f = (u * K + wob) % 1.0
    # turned slice: long gentle face, steep drop into the furrow
    ridge = np.where(f < 0.72, smoothstep(0.0, 0.72, f), 1 - smoothstep(0.72, 1.0, f))
    ridge = ridge ** 0.8
    c1, tone1, _ = clods(403, 2600, 6, 16, warp=3.0)
    c2, tone2, _ = clods(404, 9000, 2.5, 6, warp=1.5)
    low = spectral(S, 2.2, 405, fmin=1, fmax=10)
    mid = spectral(S, 1.4, 406, fmin=8, fmax=200)
    hgt = ridge * 9 + c1 * 3.0 * (0.4 + 0.6 * ridge) + c2 * 1.2 + mid * 0.6 + low * 1.5
    # moisture: furrow bottoms darker / wetter, ridge tops dry and greyer
    dry = np.clip(ridge * 0.8 + c1 * 0.25 + low * 0.15, 0, 1)
    base = colorize(norm01(mid * 0.5 + tone2 * 0.3 + tone1 * 0.2), [(0, '#1d1814'), (0.5, '#2b241e'), (1, '#3a3129')])
    crust = colorize(norm01(mid * 0.4 + tone1 * 0.6), [(0, '#3f362d'), (0.6, '#52473c'), (1, '#625649')])
    alb = lerp(base, crust, smoothstep(0.45, 1.0, dry) * 0.85)
    alb = lerp(alb, srgb('#16120f'), smoothstep(0.25, 0.0, ridge) * 0.55)
    # clod shadows / highlights
    alb = alb * (0.85 + 0.25 * c1)[..., None]
    # crop residue: a few buried straw / maize stalk bits, pale chalk pebbles
    sm, st = strokes(500, 407, (8, 30), 0.0, 3.0, val=(0.5, 1.0))
    alb = lerp(alb, colorize(st, [(0, '#5e5440'), (1, '#8f7f5c')]), sm * 0.7 * (0.3 + 0.7 * ridge)[..., None][..., 0])
    peb, ptone, _ = clods(408, 3000, 1.5, 3.5, warp=0)
    pm = smoothstep(0.2, 0.6, peb) * (ptone > 0.93)
    alb = lerp(alb, srgb('#8d8576'), pm * 0.8)
    hgt += pm * 1.5
    rough = np.clip(0.97 - (1 - dry) * 0.12, 0, 1)
    save('plowed', alb, hgt, rough, 0.9, 0.12)
    print('plowed', round(time.time() - t0, 1))


# ---------------------------------------------------------------- wheat stubble
def tex_stubble():
    t0 = time.time(); r = rng(501)
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    low = spectral(S, 2.4, 502, fmin=1, fmax=12)
    mid = spectral(S, 1.5, 503, fmin=8, fmax=250)
    soil = colorize(norm01(mid * 0.6 + low * 0.4), [(0, '#5a4c3b'), (0.5, '#6d5d49'), (1, '#837059')])
    cr = crack_lines(S, 900, 504, width=0.8, warp=3.0) * smoothstep(0.0, 1.0, low + 0.5)
    soil = lerp(soil, srgb('#3e3428'), cr * 0.4)
    hgt = mid * 0.8 + low * 1.0 - cr * 0.8
    # drill rows: 26 per tile along V; stubble stalks = short pale dashes with a dark shadow on one side
    rows = 26
    wob = spectral(S, 3.0, 505, fmin=1, fmax=5) * 3.0
    stub = np.zeros((S, S), np.float32); shad = np.zeros((S, S), np.float32); tone = np.zeros((S, S), np.float32)
    for k in range(rows):
        x0 = (k + 0.5) * S / rows
        for j in range(int(S / 3.2)):
            y = j * 3.2 + r.uniform(-1.2, 1.2)
            if r.random() < 0.12:
                continue
            x = x0 + wob[int(y) % S, int(x0) % S] + r.normal(0, 2.2)
            l = r.uniform(2.0, 5.5); a = -np.pi / 2 + r.normal(0, 0.7); v = r.uniform(0.4, 1.0)
            for ox in (-S, 0, S):
                for oy in (-S, 0, S):
                    p0 = (int((x + ox) * 4), int((y + oy) * 4)); p1 = (int((x + ox + np.cos(a) * l) * 4), int((y + oy + np.sin(a) * l) * 4))
                    cv2.line(shad, (p0[0] + 8, p0[1] + 6), (p1[0] + 8, p1[1] + 6), 1.0, 2, cv2.LINE_AA, shift=2)
                    cv2.line(stub, p0, p1, 1.0, 2, cv2.LINE_AA, shift=2)
                    cv2.line(tone, p0, p1, v, 2, cv2.LINE_AA, shift=2)
    stub = np.clip(stub, 0, 1); shad = np.clip(shad, 0, 1) * (1 - stub)
    straw_c = colorize(np.clip(tone, 0, 1), [(0, '#8f7c52'), (0.5, '#b8a272'), (1, '#d1bd8b')])
    alb = lerp(soil, soil * 0.6, shad * 0.7)
    # chopped straw litter: dense in a diffuse swath band (combine spreader), sparse elsewhere
    band = smoothstep(0.55, 0.15, np.abs(((xx / S + 0.2 + wob / S * 4) % 1.0) - 0.5) * 2) * 0.8 + 0.2
    lm, lt = strokes(16000, 506, (5, 22), r.uniform(0, 3), 1.6, mask=lambda x, y: band[int(y) % S, int(x) % S], val=(0.2, 1.0))
    alb = lerp(alb, colorize(lt, [(0, '#7a6a48'), (0.6, '#a7925f'), (1, '#c4ae7c')]), lm * 0.8)
    alb = lerp(alb, straw_c, stub)
    # a few green weed rosettes (field bindweed / shepherd's purse)
    for k in range(40):
        cx, cy, rr = r.uniform(0, S), r.uniform(0, S), r.uniform(5, 14)
        for j in range(9):
            a = j * 0.7 + r.normal(0, 0.2)
            pts = np.array([[cx, cy], [cx + np.cos(a - 0.25) * rr, cy + np.sin(a - 0.25) * rr], [cx + np.cos(a) * rr * 1.2, cy + np.sin(a) * rr * 1.2], [cx + np.cos(a + 0.25) * rr, cy + np.sin(a + 0.25) * rr]])
            msk = np.zeros((S, S), np.float32); cv2.fillPoly(msk, [(pts * 4).astype(np.int32)], 1.0, cv2.LINE_AA, shift=2)
            alb = lerp(alb, srgb('#55602f') * r.uniform(0.8, 1.15), msk * 0.9)
    hgt += stub * 2.5 + lm * 0.8 - shad * 0.6
    rough = np.full((S, S), 0.95, np.float32)
    save('stubble', alb, hgt, rough, 1.0, 0.12)
    print('stubble', round(time.time() - t0, 1))


# ---------------------------------------------------------------- weedy fallow
def tex_fallow():
    t0 = time.time(); r = rng(601)
    low = spectral(S, 2.6, 602, fmin=1, fmax=8)
    mid = spectral(S, 1.6, 603, fmin=6, fmax=120)
    fine = spectral(S, 0.8, 604, fmin=100)
    soil = colorize(norm01(mid * 0.6 + fine * 0.4), [(0, '#4a3f31'), (1, '#6a5b46')])
    bare = smoothstep(0.9, 1.6, -(low * 0.8 + mid * 0.4))
    veg = colorize(norm01(low * 0.5 + mid * 0.5), [(0, '#5a5a3a'), (0.4, '#6d6844'), (0.7, '#857a50'), (1, '#9a8b5e')])
    alb = lerp(veg * 0.8, soil, bare)
    hgt = mid * 0.8 + low * 1.5
    # couch-grass / dry grass blades (mostly upright, seen from above as short strokes)
    dens = lambda x, y: 1 - bare[int(y) % S, int(x) % S] * 0.85
    g1, t1 = strokes(52000, 605, (6, 18), -np.pi / 2, 1.2, mask=dens)
    alb = lerp(alb, colorize(t1, [(0, '#5e5a38'), (0.35, '#7a7247'), (0.7, '#9b8d5c'), (1, '#b3a273')]), g1 * 0.85)
    # wormwood / ragweed clumps: grey-green radial tufts
    clump = np.zeros((S, S), np.float32); ctone = np.zeros((S, S), np.float32)
    for k in range(260):
        cx, cy = r.uniform(0, S), r.uniform(0, S)
        if bare[int(cy), int(cx)] > 0.5:
            continue
        rr = r.uniform(10, 28); v = r.uniform(0.3, 1.0)
        for j in range(int(rr * 1.6)):
            a = r.uniform(0, 2 * np.pi); l = rr * r.uniform(0.4, 1.0)
            for ox in (-S, 0, S):
                for oy in (-S, 0, S):
                    p0 = (int((cx + ox) * 4), int((cy + oy) * 4)); p1 = (int((cx + ox + np.cos(a) * l) * 4), int((cy + oy + np.sin(a) * l) * 4))
                    cv2.line(clump, p0, p1, 1.0, 2, cv2.LINE_AA, shift=2); cv2.line(ctone, p0, p1, v, 2, cv2.LINE_AA, shift=2)
    clump = np.clip(clump, 0, 1)
    alb = lerp(alb, colorize(np.clip(ctone, 0, 1), [(0, '#5d6048'), (0.5, '#777a5e'), (1, '#8e8f72')]), clump * 0.8)
    # dead stalk litter (thistle / sunflower volunteers)
    sm, st = strokes(1400, 606, (20, 60), r.uniform(0, 3), 3.0, width=2, val=(0.3, 1.0))
    alb = lerp(alb, colorize(st, [(0, '#4c4232'), (1, '#7e6e52')]), sm * 0.7)
    alb = alb * (0.88 + 0.2 * norm01(low))[..., None]
    hgt += g1 * 1.5 + clump * 2.5 + sm
    rough = np.full((S, S), 0.96, np.float32)
    save('fallow', alb, hgt, rough, 1.0, 0.15)
    print('fallow', round(time.time() - t0, 1))


# ---------------------------------------------------------------- dirt farm track
def tex_track():
    """Dirt farm track strip, authored on an isotropic 227.6 px/m grid (6.2 m x 4.5 m = 1411 x 1024 px) and
    resampled to 1024^2 (U = strip width, V = along the track, seamless along V). Same soil as dirt_* (soil_tex.py)
    plus: two compacted tyre ruts (u = 0.36 / 0.64, ~0.42 m wide, 6-9 cm deep) with tractor-lug chevrons and
    car-tyre tread imprints (periods divide 4.5 m), damp darkened puddle patches and dried mud crust in the rut
    floors, loose berms pushed up beside the ruts, grassy / weedy centre hump and verges, pebbles and straw."""
    import soil_tex as ST
    t0 = time.time(); r = rng(701)
    Lm, Wm = 4.5, 6.2
    ppm = S / Lm; h = S; w = int(round(Wm * ppm))
    L = ST.soil((h, w), ppm, 7100, crust=0.25, damp=0.03, pebbles=1.3, straw=0.8)
    mm = L['mm']
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    xm = xx / ppm; ym = yy / ppm
    # periodic (along V) wander of the wheel paths; both ruts move together, gauge breathes a little
    def per1d(seed, lam_m, amp):
        n = ST.spec((h, 8), seed, lam_m * ppm * 0.5, lam_m * ppm, 2.2)[:, 0]
        return (n / (np.abs(n).max() + 1e-6) * amp).astype(np.float32)[:, None]
    wv = per1d(702, 4.5, 0.05) + per1d(703, 1.5, 0.012)
    gauge = per1d(704, 2.2, 0.025)
    mid = ST.spec((h, w), 705, 0.05 * ppm, 0.6 * ppm, 1.8)
    fine = ST.spec((h, w), 706, 2, 0.04 * ppm, 1.2)
    c = [Wm * 0.36 + wv - gauge, Wm * 0.64 + wv + gauge]
    hw = 0.21 + 0.03 * ST.spec((h, 8), 707, 0.3 * ppm, 1.5 * ppm)[:, :1] * 0.5
    rut = np.zeros((h, w), np.float32); berm = np.zeros((h, w), np.float32); dist = np.full((h, w), 9.0, np.float32)
    for cc in c:
        d = np.abs(xm - cc); dist = np.minimum(dist, d)
        rut = np.maximum(rut, smoothstep(hw + 0.06, hw - 0.04, d))
        berm = np.maximum(berm, np.exp(-((d - hw - 0.12) / 0.09) ** 2))
    berm *= (1 - rut)
    centre = smoothstep(0.52, 0.28, np.abs(xm - (c[0] + c[1]) / 2))           # hump between the ruts
    verge = smoothstep(1.55, 0.75, np.minimum(xm, Wm - xm))
    # rut floor: compacted, smooth, slightly darker; rounded cross profile
    prof = np.maximum(np.cos(np.clip(dist / (hw + 0.05), 0, 1) * np.pi / 2), 0) ** 1.5
    floor = blur(L['hgt'], 2.0) * 0.35 + mid * 1.2
    hgt = lerp(L['hgt'], floor, rut * 0.85) - prof * rut * 55.0 + berm * (22 + 10 * mid) + centre * 30.0 + verge * 12.0
    alb = L['alb'].copy()
    # compacted rut floor: smooth, pale and dusty (pulverised surface), loose darker crumbs on the berms
    packed = lerp(blur(alb, 2.0), srgb(ST.SOIL['dust']) * 0.92, 0.45) * (0.94 + 0.06 * mid[..., None]) * (0.97 + 0.04 * fine[..., None])
    alb = lerp(alb, packed, rut * 0.9)
    alb = alb * (1 - berm * 0.12)[..., None]
    # tyre imprints: tractor lugs (chevrons, 22 per 4.5 m) in places, car tread (fine blocks) elsewhere
    lugs = np.zeros((h, w), np.float32); car = np.zeros((h, w), np.float32)
    nl = 22; pitch = h / nl
    for side, cc in enumerate(c):
        for j in range(nl):
            y0 = j * pitch + side * pitch * 0.37
            x0 = float(cc[int(y0) % h, 0]) * ppm
            for s_ in (-1, 1):
                p0 = (x0 + s_ * 0.02 * ppm, y0); p1 = (x0 + s_ * 0.19 * ppm, y0 + 0.07 * ppm)
                ST.wrap_lines(lugs, [np.array([p0, p1])], 1.0, int(0.035 * ppm * 4) // 4 or 1)
        nc_ = 150; cp = h / nc_
        for j in range(nc_):
            y0 = j * cp
            x0 = float(cc[int(y0) % h, 0]) * ppm + 0.03 * ppm * (1 if side else -1)
            for k in range(-3, 4):
                xa = x0 + k * 0.026 * ppm + (0.008 * ppm if j % 2 else 0)
                ST.wrap_fill(car, np.array([(xa - 0.008 * ppm, y0), (xa + 0.008 * ppm, y0), (xa + 0.008 * ppm, y0 + cp * 0.55), (xa - 0.008 * ppm, y0 + cp * 0.55)]), 1.0)
    vis = ST.spec((h, 8), 708, 0.4 * ppm, 2.0 * ppm)[:, :1]
    lug_on = smoothstep(-0.2, 0.4, vis) * rut; car_on = smoothstep(0.3, -0.3, vis) * rut * 0.8
    lugs = blur(np.clip(lugs, 0, 1), 1.0) * lug_on * smoothstep(-0.6, 0.2, fine * 0.5 + mid * 0.5)
    car = blur(np.clip(car, 0, 1), 0.7) * car_on * smoothstep(-0.8, 0.0, mid)
    hgt -= lugs * 14.0 + car * 4.0
    alb = alb * (1 - lugs * 0.32 - car * 0.2)[..., None]
    edge = np.clip(blur(lugs, 2.0) - lugs, 0, 1)            # soil squeezed up between the lugs catches the light
    alb = lerp(alb, srgb(ST.SOIL['dust']), edge * 0.5)
    # damp / puddle-darkened patches and dried mud crust in the rut floors
    pz = ST.spec((h, w), 709, 0.15 * ppm, 1.2 * ppm, 2.2)
    pud = smoothstep(0.6, 1.6, pz) * smoothstep(0.4, 0.9, rut)
    dried = smoothstep(0.1, 0.6, pz) * (1 - pud) * rut
    cr = np.exp(-((lambda F: F[1] - F[0])(ST.cells((h, w), 0.06 * ppm, 710, warp=0.004 * ppm, lam=0.03 * ppm)) / (0.002 * ppm)) ** 2)
    alb = lerp(alb, blur(L['alb'], 1.5) * np.array([0.74, 0.72, 0.7], np.float32), pud * 0.85)
    alb = lerp(alb, srgb('#2a2119'), cr * dried * 0.7)
    hgt = lerp(hgt, blur(hgt, 3.0), pud) - cr * dried * 5.0
    # grass + weeds on the hump and verges (late-summer olive / straw), sparse tufts on the shoulders
    gmask = np.clip(centre * 0.95 + verge + 0.04 * smoothstep(0.3, 1.0, mid), 0, 1) * (1 - rut) * (1 - berm * 0.5)
    g1, t1 = strokes(int(26000 * w / S), 711, (5, 16), -np.pi / 2, 1.3, shape=(h, w), mask=lambda x, y: gmask[int(y) % h, int(x) % w])
    g2, t2 = strokes(int(9000 * w / S), 712, (3, 9), 0.0, 3.0, shape=(h, w), mask=lambda x, y: gmask[int(y) % h, int(x) % w])
    gcol = colorize(t1, [(0, '#4e5233'), (0.35, '#666640'), (0.7, '#857c4f'), (1, '#a39467')])
    under = colorize(norm01(mid), [(0, '#3f3f2a'), (1, '#5a5638')])
    alb = lerp(alb, under, gmask * 0.55)
    alb = lerp(alb, gcol, g1 * 0.9)
    alb = lerp(alb, colorize(t2, [(0, '#57502f'), (1, '#8a7a50')]), g2 * 0.7)
    hgt += (g1 * 6.0 + g2 * 3.0) * gmask
    alb, hp, ao = ST.finish(alb, hgt, mm, shade=0.25)
    rough = np.clip(L['rough'] - rut * 0.04 - pud * 0.35, 0.25, 1)
    nrm = normal_from_height(hp, 0.9).astype(np.float32) / 127.5 - 1
    nrm = blur(nrm, 0.5)
    rs = lambda a: cv2.resize(a, (S, S), interpolation=cv2.INTER_AREA)
    nrm = rs(nrm); nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True) + 1e-6
    Image.fromarray(to8(rs(alb))).save(os.path.join(OUT, 'track_albedo.jpg'), quality=90, optimize=True)
    Image.fromarray(to8(nrm * 0.5 + 0.5)).save(os.path.join(OUT, 'track_normal.jpg'), quality=90, optimize=True)
    orm = to8(np.stack([rs(ao), rs(rough), np.zeros((h, S), np.float32)], -1))
    Image.fromarray(orm).resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, 'track_orm.jpg'), quality=90, optimize=True)
    print('track', round(time.time() - t0, 1))


if __name__ == '__main__':
    names = sys.argv[1:] or ['plowed', 'stubble', 'fallow', 'track']
    for n in names:
        globals()['tex_' + n]()
