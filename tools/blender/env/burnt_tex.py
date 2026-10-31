"""Shared painter for burnt-out vehicle steel (props_atlas, farmland_atlas, modern_atlas).

Reference look (photo record of burnt cars / buses / tractors 2022-24, first weeks after the fire): the paint is burnt
off to black-charcoal soot and chalky grey-white ash / burnt primer (large light blotches on roofs, bonnets and upper
door skins), with bare dull-grey steel and heat-tint (blue-grey / violet / straw) halos where the ash flaked, warped
panel creases, and only *small* rust-brown streaks running down from seams and edges.  Soot is densest low down and
around the openings (window frames, wheel arches) and rises in plumes above them.

burnt_steel(shape, seed, ...) -> (albedo rgb float32, height, roughness, metal) -- tileable unless wrap=False.
plume(mask, x, y, w, h)       -> stamps an upward-spreading soot plume (y = image row of the opening top).
"""
import numpy as np
import cv2
from texlib import spectral, norm01, colorize, srgb, lerp, smoothstep, blur, rng

CHAR = [(0, '#111010'), (0.5, '#1d1c1b'), (1, '#2f2d2b')]
STEEL = [(0, '#3f3e3c'), (1, '#64625e')]
ASH = [(0, '#7e7a74'), (0.55, '#a29e97'), (1, '#c3bfb7')]


def burnt_steel(shape, seed, ash=0.5, rust=0.08, heat=0.5, paint=None, paint_keep=None, wrap=True, low_soot=None,
                contrast=1.0, bias=0.0, freq=1.0):
    """ash: share of the surface covered by grey-white ash / burnt primer (0..1); rust: share of rust streaks;
    heat: strength of the heat-tint halos; paint: optional rgb of surviving blistered paint, paint_keep: mask (0..1)
    where it survives (usually low on the doors); low_soot: optional 0..1 mask of extra soot (e.g. bottom rows).
    contrast / bias squeeze / shift the soot->ash ramp: small tiled swatches (1 m regions repeated over a vehicle)
    want contrast ~0.5 so they do not read as camouflage; light 'ash' swatches use bias > 0."""
    h, w = shape; r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    big = spectral(0, 2.2, seed, fmin=max(1.0, 1.5 * freq), fmax=10 * freq, shape=shape)
    mid = spectral(0, 1.4, seed + 1, fmin=5 * freq, fmax=60 * freq, shape=shape)
    fine = spectral(0, 0.6, seed + 2, fmin=40, shape=shape)
    field = big + 0.35 * mid + 0.08 * fine
    thr = np.quantile(field, 1.0 - ash)
    # continuous ramp: charcoal -> dark steel -> (heat tint) -> grey ash -> chalky ash, so the surface is mottled
    # rather than a black/white cow pattern
    tt = np.clip((field - thr) / 3.2 + 0.06 * fine, -0.5, 0.5) * contrast + 0.5 + bias   # 0.5 = edge of the ash patches
    tt = np.clip(tt, 0, 1)
    ash_m = smoothstep(0.42, 0.8, tt)
    steel_m = np.clip(1 - np.abs(tt - 0.4) / 0.12, 0, 1)
    alb = colorize(tt, [(0, '#131211'), (0.2, '#1d1c1a'), (0.34, '#33312e'), (0.47, '#4f4a44'), (0.6, '#6c6760'),
                        (0.8, '#8a857d'), (1, '#a39e95')])
    alb = alb * (0.9 + 0.2 * norm01(fine * 0.7 + mid * 0.3))[..., None]
    # powdery mottling / flaked spots inside the ash
    pow_ = smoothstep(0.6, 1.8, spectral(0, 0.9, seed + 3, fmin=20, fmax=160, shape=shape))
    alb = lerp(alb, srgb('#b3aea5'), pow_ * ash_m * 0.3)
    flake = smoothstep(1.5, 2.4, spectral(0, 1.2, seed + 7, fmin=12, fmax=90, shape=shape)) * ash_m
    alb = lerp(alb, srgb('#2e2c2a'), flake * 0.45)
    # heat tint on the flaked steel band (blue-grey / violet / straw), low saturation
    hue = norm01(spectral(0, 2.2, seed + 4, fmin=1, fmax=8, shape=shape))
    tint = colorize(hue, [(0, '#4c5870'), (0.4, '#5a4f63'), (0.7, '#675f4e'), (1, '#7d6e4c')])
    ring = steel_m * heat
    alb = lerp(alb, tint, ring * 0.6)
    # rust: a few soft streaks running down from spots (seams / drips), kept to a small share
    rust_m = np.zeros(shape, np.float32)
    if rust > 0:
        spots = np.zeros(shape, np.float32)
        n_sp = int(rust * h * w / 900)
        for _ in range(n_sp):
            cx, cy = r.uniform(0, w), r.uniform(0, h); L = r.uniform(0.06, 0.25) * h; wd = r.uniform(1.5, 4.5)
            cv2.line(spots, (int(cx), int(cy)), (int(cx + r.normal(0, 2)), int(cy + L)), float(r.uniform(0.5, 1.0)), int(wd), cv2.LINE_AA)
        rust_m = blur(spots, (3.0, 1.6), wrap) * 1.4
        rust_m = np.clip(rust_m * smoothstep(-1.5, 0.5, mid), 0, 1)
        rcol = colorize(norm01(fine), [(0, '#3f2619'), (0.6, '#5c3622'), (1, '#6e4329')])
        alb = lerp(alb, rcol, rust_m * 0.75)
    soot_m = 1 - ash_m
    if low_soot is not None:
        alb = lerp(alb, colorize(norm01(fine), CHAR), np.clip(low_soot, 0, 1) * 0.9)
        soot_m = np.clip(soot_m + low_soot, 0, 1)
    if paint is not None and paint_keep is not None:
        blis = smoothstep(0.3, 1.4, spectral(0, 0.8, seed + 6, fmin=30, fmax=200, shape=shape))
        pc = np.asarray(paint, np.float32) * (0.75 + 0.25 * norm01(fine))[..., None]
        pc = lerp(pc, srgb('#2a2622'), blis * 0.6)
        alb = lerp(alb, pc, np.clip(paint_keep, 0, 1) * (1 - rust_m))
    # warped-panel creases: a few long soft lines
    crease = np.zeros(shape, np.float32)
    for _ in range(3):
        x0, y0 = r.uniform(0, w), r.uniform(0, h); a = r.uniform(-0.6, 0.6); L = r.uniform(0.3, 0.8) * w
        cv2.line(crease, (int(x0), int(y0)), (int(x0 + np.cos(a) * L), int(y0 + np.sin(a) * L)), 1.0, 2, cv2.LINE_AA)
    crease = blur(crease, 2.5, wrap)
    alb = alb * (1 - 0.25 * np.clip(crease * 3, 0, 1))[..., None]
    hgt = fine * 0.5 + mid * 0.3 - ash_m * 0.2 + crease * 1.5 + rust_m * 0.4
    rough = np.clip(0.9 - steel_m * 0.25 + ash_m * 0.06, 0, 1).astype(np.float32)
    metal = np.clip(steel_m * 0.45 + ring * 0.2 - ash_m * 0.1, 0, 1).astype(np.float32)
    return alb.astype(np.float32), hgt.astype(np.float32), rough, metal


def plume(mask, x, y, w, h, k=1.0):
    """Soot plume rising from an opening whose top edge is at row y, centred at column x, width w: spreads and fades
    over h rows above.  Adds into mask (0..1)."""
    H, W = mask.shape
    y0 = int(max(0, y - h)); y1 = int(min(H, y + 4))
    if y1 <= y0:
        return mask
    yy, xx = np.mgrid[y0:y1, 0:W].astype(np.float32)
    t = np.clip((y - yy) / max(h, 1), 0, 1)                     # 0 at the opening, 1 at the top of the plume
    half = w * (0.5 + 0.6 * t)
    lat = np.clip(1 - np.abs(xx - x) / half, 0, 1) ** 0.8
    v = lat * (1 - t) ** 1.3 * k
    mask[y0:y1] = np.clip(mask[y0:y1] + v, 0, 1)
    return mask
