"""Photo-real dry soil layers (Ukrainian chernozem / loam, dusty, late summer) shared by
gen_ground_textures.tex_dirt (6 m city/farm base soil) and gen_farm_ground.tex_track (dirt-road strip).

Everything is authored in metres on an isotropic pixel grid (ppm = pixels per metre) and is periodic in both
axes (FFT noise, wrapped Voronoi, wrapped strokes). Callers resample afterwards if the final texture is
anisotropic (the track strip).  Design rules (game camera 30-250 m, shader anti-tiling + macro tint):
  * no large, high-contrast blotches (the old dirt had 1-3 m dark/wet clouds that repeated visibly every 6 m);
    macro variation is kept to a few percent - the ground shaders add their own macro tint
  * detail lives at 0.5-30 cm: crumb aggregates, clods, crust plates with cracks, pebbles, straw, twigs
  * height is built from shapes (domes, tilted crust plates, crack grooves), not per-pixel noise, so the
    normal map is strong but not noisy
"""
import numpy as np
import cv2
from scipy.spatial import cKDTree
from texlib import norm01, smoothstep, blur, colorize, srgb, lerp, rng


# ------------------------------------------------------------------ periodic noise / cells in pixel units
def spec(shape, seed, lmin, lmax, beta=2.0):
    """Periodic band-limited fractal noise: wavelengths lmin..lmax pixels (isotropic per pixel), unit std."""
    h, w = shape
    r = rng(seed)
    F = np.fft.rfft2(r.standard_normal((h, w)).astype(np.float32))
    fy = np.fft.fftfreq(h)[:, None]; fx = np.fft.rfftfreq(w)[None, :]
    f = np.sqrt(fx * fx + fy * fy); f[0, 0] = 1.0
    amp = f ** (-beta / 2.0)
    fmin, fmax = 1.0 / lmax, 1.0 / max(lmin, 1.0)
    amp *= 1.0 / (1.0 + np.exp(-(f - fmin) / (fmin * 0.25)))       # soft high-pass
    amp *= np.exp(-(f / fmax) ** 4)
    amp[0, 0] = 0
    out = np.fft.irfft2(F * amp, s=(h, w)).astype(np.float32)
    out -= out.mean(); out /= out.std() + 1e-8
    return out


def warp_xy(shape, seed, amount, lam):
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    return xx + spec(shape, seed, lam * 0.4, lam) * amount, yy + spec(shape, seed + 1, lam * 0.4, lam) * amount


def cells(shape, cell_px, seed, warp=0.0, lam=None, density=1.0):
    """Wrapped Voronoi with mean cell size cell_px. Returns F1, F2, ids, points."""
    h, w = shape
    r = rng(seed)
    n = max(8, int(h * w / (cell_px * cell_px) * density))
    pts = np.stack([r.random(n) * w, r.random(n) * h], -1)
    tree = cKDTree(pts, boxsize=[w, h])
    if warp > 0:
        xx, yy = warp_xy(shape, seed + 7, warp, lam or cell_px * 4)
    else:
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    q = np.stack([np.mod(xx, w).ravel(), np.mod(yy, h).ravel()], -1)
    q = np.minimum(q, [w - 1e-3, h - 1e-3])
    d, i = tree.query(q, k=2, workers=4)
    return d[:, 0].reshape(h, w).astype(np.float32), d[:, 1].reshape(h, w).astype(np.float32), i[:, 0].reshape(h, w), pts


def wrap_lines(m, segs, val=1.0, width=1):
    """Draw anti-aliased polylines with wrap-around (segs: list of Nx2 arrays in px)."""
    h, w = m.shape
    for P in segs:
        P = np.asarray(P, np.float32)
        xs, ys = P[:, 0], P[:, 1]
        oxs = [0] + ([w] if xs.min() < 0 else []) + ([-w] if xs.max() >= w else [])
        oys = [0] + ([h] if ys.min() < 0 else []) + ([-h] if ys.max() >= h else [])
        for ox in oxs:
            for oy in oys:
                q = ((P + [ox, oy]) * 4).astype(np.int32)
                cv2.polylines(m, [q], False, val, width, cv2.LINE_AA, shift=2)


def wrap_fill(m, poly, val=1.0):
    h, w = m.shape
    P = np.asarray(poly, np.float32)
    for ox in (-w, 0, w):
        for oy in (-h, 0, h):
            Q = P + [ox, oy]
            if Q[:, 0].max() < 0 or Q[:, 0].min() >= w or Q[:, 1].max() < 0 or Q[:, 1].min() >= h:
                continue
            cv2.fillPoly(m, [(Q * 4).astype(np.int32)], val, cv2.LINE_AA, shift=2)


# ------------------------------------------------------------------ soil
SOIL = dict(   # dry dusty chernozem-loam: greyish dark brown, sun-bleached dust on top
    dark='#45392e', mid='#665746', light='#807059', dust='#9a8b74', damp='#3a2f24', crack='#2a2119',
    straw=[(0, '#6f6246'), (0.5, '#8f7f5a'), (1, '#ad9b72')],
    pebble=[(0, '#5d5850'), (0.3, '#7e786d'), (0.55, '#958d7f'), (0.75, '#a89a83'), (0.88, '#b9b2a4'), (1, '#7a5a44')],
)


def soil(shape, ppm, seed, crust=0.5, damp=0.08, pebbles=1.0, straw=1.0, litter=1.0, clod=1.0, P=SOIL):
    """Returns dict(alb HxWx3 linear-ish sRGB floats, hgt (mm), rough, masks...) for an isotropic grid.
    crust: fraction of the area covered by cracked dry crust plates; damp: fraction of damp darkened spots."""
    h, w = shape
    mm = 1000.0 / ppm                     # mm per pixel
    px = lambda m: m * ppm                # metres -> px
    r = rng(seed)
    S = lambda k, a, b, beta=2.0: spec(shape, seed + k, px(a), px(b), beta)
    macro = S(1, 0.8, 3.0, 2.2)          # very gentle tone drift
    mid = S(2, 0.12, 0.8, 1.8)
    fine = S(3, 0.006, 0.05, 1.2)
    grain = S(4, 0.0, 0.008, 0.5)
    # ---------------- zone fields (soft, low contrast; thresholds pick sparse, irregular areas)
    zone_c = S(5, 0.35, 1.6, 2.0) * 0.8 + S(6, 0.1, 0.35, 1.6) * 0.35
    q = np.quantile(zone_c, 1 - crust) if crust > 0 else 1e9
    crustm = smoothstep(q - 0.25, q + 0.25, zone_c) if crust > 0 else np.zeros(shape, np.float32)
    zone_d = S(7, 0.15, 0.7, 2.2) * 0.85 + S(8, 0.04, 0.15, 1.6) * 0.35
    qd = np.quantile(zone_d, 1 - damp) if damp > 0 else 1e9
    dampm = smoothstep(qd - 0.12, qd + 0.35, zone_d) if damp > 0 else np.zeros(shape, np.float32)
    dring = np.exp(-((zone_d - qd + 0.05) / 0.08) ** 2) * (damp > 0)      # darker drying front at the spot edge
    loose = 1 - crustm                     # crumbly tilled / trampled soil elsewhere
    # ---------------- crumb aggregates (2-12 mm) and clods (2-7 cm)
    F1, F2, ids, _ = cells(shape, px(0.011), seed + 10, warp=px(0.002), lam=px(0.02))
    e = F2 - F1
    crumb = np.clip(e / px(0.004), 0, 1) ** 0.6
    ctone = r.random(ids.max() + 1).astype(np.float32)[ids]
    cht = (0.4 + 0.6 * r.random(ids.max() + 1).astype(np.float32))[ids]
    F1b, F2b, idb, _ = cells(shape, px(0.045), seed + 11, warp=px(0.008), lam=px(0.08))
    nb = idb.max() + 1
    keep = (r.random(nb) < 0.35 * clod)
    bigr = r.uniform(0.012, 0.03, nb)
    clodm = np.clip(1 - F1b / px(bigr[idb]), 0, 1) * keep[idb]
    clodm = clodm ** 0.55 * smoothstep(0.0, px(0.004), F2b - F1b)
    btone = r.random(nb).astype(np.float32)[idb]
    hgt = crumb * cht * 3.2 * loose + clodm * 9.0 * loose + mid * 2.5 + macro * 4.0 + fine * 0.35
    # ---------------- dry crust plates: tilted, edges curled up, cracks between (plates 6-25 cm)
    F1c, F2c, idc, ptc = cells(shape, px(0.10), seed + 12, warp=px(0.007), lam=px(0.12))
    nc = idc.max() + 1
    ec = F2c - F1c
    crack_w = px(0.0032) * (0.7 + 0.6 * r.random(nc).astype(np.float32)[idc])
    crack = np.exp(-(ec / crack_w) ** 2)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dx = (xx - ptc[idc, 0] + w / 2) % w - w / 2; dy = (yy - ptc[idc, 1] + h / 2) % h - h / 2
    tilt = (r.normal(0, 1, nc)[idc] * dx + r.normal(0, 1, nc)[idc] * dy) / px(0.13) * 1.3
    curl = np.exp(-ec / px(0.012)) * 2.2
    # finer secondary cracks splitting the plates
    F1s, F2s, ids2, _ = cells(shape, px(0.04), seed + 13, warp=px(0.004), lam=px(0.05))
    crack2 = np.exp(-((F2s - F1s) / px(0.0013)) ** 2) * (r.random(ids2.max() + 1) < 0.55)[ids2]
    plate = tilt + curl - crack * 6.0 - crack2 * 2.0 + fine * 0.25
    hgt = lerp(hgt, plate + mid * 2.0 + macro * 4.0, crustm)
    # ---------------- colour
    base = colorize(np.clip(0.5 + 0.22 * mid + 0.18 * fine + 0.12 * (ctone - 0.5) * loose, 0, 1),
                    [(0, P['dark']), (0.45, P['mid']), (0.8, P['light']), (1, P['dust'])])
    # sun-dried tops are dusty / paler, crumb gaps darker
    top = smoothstep(0.3, 1.0, crumb * cht) * loose
    alb = lerp(base, srgb(P['dust']) * (0.92 + 0.08 * grain[..., None]), top * 0.2)
    alb = alb * (1 - 0.15 * (1 - crumb) * loose)[..., None]
    cl = colorize(np.clip(btone * 0.6 + 0.2 + 0.2 * fine, 0, 1), [(0, P['dark']), (0.5, P['mid']), (1, P['light'])])
    alb = lerp(alb, cl * (0.8 + 0.35 * clodm)[..., None], smoothstep(0.05, 0.35, clodm) * 0.9)
    # crust: smoother, slightly paler silty skin, dark cracks, light curled edges
    skin = colorize(np.clip(0.55 + 0.25 * mid + 0.1 * fine, 0, 1), [(0, P['mid']), (0.6, P['light']), (1, P['dust'])])
    skin = skin * (0.94 + 0.06 * np.tanh(tilt * 0.5))[..., None]
    alb = lerp(alb, skin, crustm * 0.7)
    alb = lerp(alb, srgb(P['dust']), np.clip(curl / 2.2, 0, 1) * crustm * 0.25)
    alb = lerp(alb, srgb(P['crack']), np.clip(crack * 0.95 + crack2 * 0.5, 0, 1) * crustm)
    trod = S(9, 0.4, 2.5, 2.0)          # medium-scale tone patches (trampled / dusty vs. darker humus), low contrast
    alb = alb * (0.95 + 0.05 * macro[..., None] + 0.045 * np.tanh(trod)[..., None]) * (0.97 + 0.03 * grain[..., None])
    # ---------------- pebbles: grit 1.5-4 mm, gravel 5-12 mm, rare stones 15-35 mm
    pebm = np.zeros(shape, np.float32); pebc = np.zeros(shape + (3,), np.float32); pebh = np.zeros(shape, np.float32)
    for k, (cellm, pr, rr) in enumerate(((0.025, 0.30, (0.0015, 0.004)), (0.07, 0.22, (0.004, 0.011)), (0.35, 0.18, (0.012, 0.03)))):
        G1, G2, gid, _ = cells(shape, px(cellm), seed + 20 + k, warp=px(rr[1] * 0.35), lam=px(rr[1] * 2))
        ng = gid.max() + 1
        on = r.random(ng) < pr * pebbles
        rad = r.uniform(*rr, ng)
        d = np.clip(1 - G1 / px(rad[gid]), 0, 1) * on[gid]
        m = smoothstep(0.0, 0.25, d)
        tone = r.random(ng).astype(np.float32)[gid]
        col = colorize(tone, P['pebble']) * (0.75 + 0.35 * np.sqrt(d))[..., None]
        sel = m > pebm
        pebc[sel] = col[sel]; pebm = np.maximum(pebm, m)
        pebh = np.maximum(pebh, np.sqrt(d) * rad[gid] * 1000 * 0.55)
    # contact shadow ring around pebbles
    ring = np.clip(blur(pebm, 1.6) - pebm, 0, 1)
    alb = alb * (1 - ring * 0.55)[..., None]
    alb = lerp(alb, pebc, pebm * 0.95)
    hgt = hgt + pebh
    # ---------------- straw bits, dark twigs, leaf flakes
    strawm = np.zeros(shape, np.float32); strawt = np.zeros(shape, np.float32)
    n = int(w * h / ppm ** 2 * 140 * straw)
    segs, tones = [], []
    for _ in range(n):
        x, y = r.uniform(0, w), r.uniform(0, h); L = px(r.uniform(0.012, 0.06)); a = r.uniform(0, np.pi)
        b = a + r.normal(0, 0.25)
        P3 = np.array([(x, y), (x + np.cos(a) * L * 0.5, y + np.sin(a) * L * 0.5), (x + np.cos(a) * L * 0.5 + np.cos(b) * L * 0.5, y + np.sin(a) * L * 0.5 + np.sin(b) * L * 0.5)])
        v = r.uniform(0.25, 1.0)
        wrap_lines(strawm, [P3], 1.0, 1); wrap_lines(strawt, [P3], v, 1)
    strawm = np.clip(strawm, 0, 1) * (1 - dampm * 0.6)
    strawt = np.clip(strawt, 0, 1)
    alb = alb * (1 - blur(strawm, 1.2) * 0.25)[..., None]          # tiny shadow
    alb = lerp(alb, colorize(strawt, P['straw']), strawm * 0.7)
    hgt += strawm * 1.4
    twig = np.zeros(shape, np.float32)
    for _ in range(int(w * h / ppm ** 2 * 30 * litter)):
        x, y = r.uniform(0, w), r.uniform(0, h); L = px(r.uniform(0.03, 0.12)); a = r.uniform(0, 2 * np.pi)
        pts = [(x, y)]
        for k in range(3):
            a += r.normal(0, 0.35); pts.append((pts[-1][0] + np.cos(a) * L / 3, pts[-1][1] + np.sin(a) * L / 3))
        wrap_lines(twig, [np.array(pts)], 1.0, 2 if r.random() < 0.3 else 1)
    twig = np.clip(twig, 0, 1)
    alb = lerp(alb, srgb('#2e261e'), twig * 0.75); hgt += twig * 1.8
    leaf = np.zeros(shape, np.float32); ltone = np.zeros(shape, np.float32)
    for _ in range(int(w * h / ppm ** 2 * 10 * litter)):
        x, y = r.uniform(0, w), r.uniform(0, h); s_ = px(r.uniform(0.008, 0.025)); a = r.uniform(0, 2 * np.pi)
        k = r.integers(5, 8); ang = a + np.linspace(0, 2 * np.pi, k, endpoint=False)
        rad = s_ * r.uniform(0.5, 1.0, k) * np.where(np.arange(k) % 2 == 0, 1.0, 0.55)
        poly = np.stack([x + np.cos(ang) * rad, y + np.sin(ang) * rad * 0.7], -1)
        wrap_fill(leaf, poly, 1.0); wrap_fill(ltone, poly, r.uniform(0.2, 1.0))
    leaf = np.clip(leaf, 0, 1)
    alb = lerp(alb, colorize(np.clip(ltone, 0, 1), [(0, '#4a3a28'), (0.5, '#6e5636'), (1, '#8f7a4c')]), leaf * 0.85)
    hgt += leaf * 0.8
    # ---------------- damp spots: darker, slightly more saturated, smoothed relief, glossier
    alb = lerp(alb, alb * np.array([0.78, 0.76, 0.74], np.float32), dampm * 0.9)
    alb = lerp(alb, srgb(P['damp']), dring * 0.07)
    hgt = lerp(hgt, blur(hgt, 2.5) * 0.6 - 1.5, dampm * 0.7)
    rough = 0.93 - 0.02 * crustm + 0.04 * top - dampm * 0.32 - pebm * 0.12 + 0.03 * grain
    return dict(alb=np.clip(alb, 0, 1), hgt=hgt.astype(np.float32), rough=np.clip(rough, 0.3, 1).astype(np.float32),
                mm=mm, crust=crustm, damp=dampm, pebble=pebm, straw=strawm, crack=crack * crustm)


def finish(alb, hgt_mm, mm, nstrength=1.0, shade=0.22, ao_r=(3, 12)):
    """hgt in mm -> pixel-unit height; returns (albedo with gentle baked relief + AO, height_px, ao)."""
    from texlib import cavity_ao, bake_shade
    hp = hgt_mm / mm
    ao = cavity_ao(hp, ao_r[0], 0.35) * cavity_ao(hp, ao_r[1], 0.08)
    alb = alb * bake_shade(hp, 0.6, shade) * (0.78 + 0.22 * ao)[..., None]
    return np.clip(alb, 0, 1), hp, ao
