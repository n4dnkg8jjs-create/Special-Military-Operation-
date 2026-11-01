"""Shell-crater decal atlas (look v2) -> assets/textures/crater_{albedo.png (RGBA), normal.jpg}
2 x 2 atlas, each cell = one crater decal footprint (the game scales the decal quad to the crater + ejecta size):
  0 fresh 152 mm crater: scorched, wet bowl, fresh loess / chernozem clods, long ejecta rays
  1 old crater: rim slumped, weeds back on the rim, standing water in the bottom
  2 mortar / small-shell splash: shallow scoop, star-shaped spray, soot
  3 crater in a ploughed / grassy field: churned clods thrown far, ragged
Run: nice -n 10 python3 tools/blender/env/crater_tex.py   (numpy + scipy + PIL only, ~20 s)
"""
import os
import numpy as np
from PIL import Image
from scipy import ndimage
from texlib import REPO, rng, normal_from_height, smoothstep, to8

C = 512                      # cell size (px)
OUT = os.path.join(REPO, 'assets', 'textures')


def fbm(shape, seed, scales=(64, 24, 9, 3), weights=(0.5, 0.28, 0.14, 0.08)):
    r = rng(seed); h, w = shape; acc = np.zeros(shape, np.float32)
    for s, wt in zip(scales, weights):
        n = r.random((h // s + 3, w // s + 3)).astype(np.float32)
        acc += wt * ndimage.zoom(n, s, order=3)[:h, :w]
    return acc


def crater(seed, kind):
    r = rng(seed)
    yy, xx = np.mgrid[0:C, 0:C].astype(np.float32)
    dx, dy = (xx - C / 2) / (C / 2), (yy - C / 2) / (C / 2)
    rad = np.hypot(dx, dy); ang = np.arctan2(dy, dx)
    n1 = fbm((C, C), seed + 1); n2 = fbm((C, C), seed + 2, (32, 12, 5, 2)); n3 = fbm((C, C), seed + 3, (8, 4, 2, 1))
    # ragged radius: angular noise
    k = r.integers(5, 11)
    wob = sum(r.uniform(0.02, 0.07) * np.cos(ang * (i + 2) + r.uniform(0, 6.28)) for i in range(k))
    R0 = {0: 0.42, 1: 0.44, 2: 0.28, 3: 0.4}[kind]
    rr = rad / (R0 * (1 + wob + (n1 - 0.5) * 0.25))
    # height (mm-ish units): bowl, raised rim, ejecta blanket
    bowl = -np.clip(1 - rr ** 2, 0, 1) * {0: 1.0, 1: 0.7, 2: 0.35, 3: 0.85}[kind]
    rim = np.exp(-((rr - 1.05) / 0.22) ** 2) * {0: 0.55, 1: 0.35, 2: 0.25, 3: 0.5}[kind]
    rays = np.zeros_like(rad)
    nr = {0: 26, 1: 14, 2: 34, 3: 20}[kind]
    for i in range(nr):
        a0 = r.uniform(-np.pi, np.pi); wdt = r.uniform(0.04, 0.14); L = r.uniform(1.4, 2.8 if kind != 1 else 1.9)
        da = np.angle(np.exp(1j * (ang - a0)))
        rays += np.exp(-(da / wdt) ** 2) * smoothstep(L, 1.0, rr) * (rr > 0.9) * r.uniform(0.4, 1.0)
    rays = np.clip(rays, 0, 1)
    # clods: scattered lumps, dense near the rim, sparse out along the rays
    clod = np.zeros_like(rad)
    ncl = {0: 900, 1: 380, 2: 600, 3: 1300}[kind]
    for i in range(ncl):
        a = r.uniform(-np.pi, np.pi); d = 1.0 + abs(r.normal(0, 0.45 if kind != 2 else 0.7))
        d *= R0 * C / 2; cx, cy = C / 2 + np.cos(a) * d, C / 2 + np.sin(a) * d
        s = r.uniform(1.2, 5.5 if kind != 2 else 3.0) * (1.3 if kind == 3 else 1.0)
        x0, x1 = int(max(0, cx - s * 2)), int(min(C, cx + s * 2 + 1)); y0, y1 = int(max(0, cy - s * 2)), int(min(C, cy + s * 2 + 1))
        if x1 <= x0 or y1 <= y0: continue
        sub = np.exp(-(((xx[y0:y1, x0:x1] - cx) ** 2 + (yy[y0:y1, x0:x1] - cy) ** 2) / (s * s)))
        clod[y0:y1, x0:x1] = np.maximum(clod[y0:y1, x0:x1], sub * r.uniform(0.5, 1.0))
    hgt = bowl + rim + rays * 0.12 + clod * 0.35 + (n3 - 0.5) * 0.12
    # ---- colour (linear-ish sRGB values 0..1)
    chern = np.array([0.19, 0.16, 0.13]); loess = np.array([0.55, 0.47, 0.35]); soot = np.array([0.05, 0.045, 0.04])
    ash = np.array([0.33, 0.32, 0.3]); wet = np.array([0.1, 0.09, 0.075]); weed = np.array([0.36, 0.34, 0.22])
    col = np.zeros((C, C, 3), np.float32) + chern
    sub_m = np.clip(smoothstep(0.45, 0.75, n2) * (rr < 1.4) + clod * (n3 > 0.55) * 0.8, 0, 1)
    col = col * (1 - sub_m[..., None] * 0.75) + loess * sub_m[..., None] * 0.75                   # upturned subsoil
    col *= (0.75 + 0.5 * n3)[..., None]
    if kind in (0, 2):
        sm = np.clip(smoothstep(1.3 if kind == 0 else 1.6, 0.2, rr) * (0.6 + 0.6 * n1) + rays * 0.5, 0, 1)
        col = col * (1 - sm[..., None] * 0.85) + soot * sm[..., None] * 0.85
        am = smoothstep(0.62, 0.8, n2) * (rr < 1.2) * 0.4
        col = col * (1 - am[..., None]) + ash * am[..., None]
    if kind == 1:
        wm = smoothstep(0.55, 0.75, n1) * smoothstep(0.85, 1.25, rr) * smoothstep(2.0, 1.4, rr)
        col = col * (1 - wm[..., None] * 0.7) + weed * wm[..., None] * 0.7
    bot = smoothstep(0.75, 0.15, rr)
    col = col * (1 - bot[..., None] * 0.6) + wet * bot[..., None] * 0.6                             # damp bowl
    if kind == 1:
        pond = smoothstep(0.46, 0.4, rr + (n1 - 0.5) * 0.15)
        col = col * (1 - pond[..., None]) + np.array([0.05, 0.055, 0.05]) * pond[..., None]
        hgt = np.where(pond > 0.5, np.minimum(hgt, hgt.min() * 0.0 + np.percentile(hgt, 2)), hgt)
    # shading baked lightly (so it still reads under flat light)
    gy, gx = np.gradient(ndimage.gaussian_filter(hgt, 1.2))
    col *= np.clip(1 + (-gx * 0.5 - gy * 0.6) * 9, 0.6, 1.35)[..., None]
    # alpha: solid bowl + rim, ragged blanket, rays + clods out to the cell edge
    alpha = np.clip(smoothstep(1.55 if kind != 2 else 1.25, 0.95, rr + (n1 - 0.5) * 0.5) + rays * 0.85 + clod, 0, 1)
    alpha *= smoothstep(1.0, 0.86, rad)                                                            # never reach the edge
    return np.clip(col, 0, 1), np.clip(alpha, 0, 1), hgt


def main():
    alb = np.zeros((C * 2, C * 2, 4), np.float32); H = np.zeros((C * 2, C * 2), np.float32)
    for i, (seed, kind) in enumerate([(11, 0), (23, 1), (37, 2), (53, 3)]):
        c, a, h = crater(seed, kind); y, x = (i // 2) * C, (i % 2) * C
        alb[y:y + C, x:x + C, :3] = c; alb[y:y + C, x:x + C, 3] = a; H[y:y + C, x:x + C] = h
    Image.fromarray(to8(alb), 'RGBA').save(os.path.join(OUT, 'crater_albedo.png'), optimize=True)
    nrm = normal_from_height(H * 18.0, 1.0, wrap=False)
    Image.fromarray(nrm if nrm.dtype == np.uint8 else to8(nrm)).convert('RGB').save(os.path.join(OUT, 'crater_normal.jpg'), quality=88)
    print('crater atlas written')


if __name__ == '__main__':
    main()
