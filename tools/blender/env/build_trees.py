"""Builds assets/env/trees.glb: shrapnel-stripped urban trees (pollarded poplar, horse chestnut, birch with a
snapped trunk...), two leafy late-summer trees (alpha leaf cards), stumps and a fallen uprooted trunk.
Node names are chosen to match src/world/city.js regexes without double-classification:
  bare: tree_*  | leafy: leafy_summer_*  | stump: stump_*  | fallen: fallen_trunk
Run: cd tools/blender/env && nice -n 10 python3 build_trees.py
"""
import os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import cv2
from PIL import Image
from meshlib import *
from texlib import spectral, norm01, colorize, srgb, lerp, to8, normal_from_height, smoothstep, blur, CACHE, quantize_normal, voronoi

TEX = {}


# ------------------------------------------------------------------ textures
def save_tex(name, alb, hgt, rough, strength=1.0, alpha=None):
    a = os.path.join(CACHE, f'{name}_albedo.' + ('png' if alpha is not None else 'jpg'))
    if alpha is not None:
        Image.fromarray(to8(np.concatenate([alb, alpha[..., None]], -1)), 'RGBA').save(a, optimize=True)
    else:
        Image.fromarray(to8(alb)).save(a, quality=88, optimize=True)
    n = os.path.join(CACHE, f'{name}_normal.png')
    Image.fromarray(quantize_normal(normal_from_height(hgt, strength), 6)).save(n, optimize=True)
    o = os.path.join(CACHE, f'{name}_orm.png')
    Image.fromarray(quantize_normal(to8(np.stack([np.clip(1 - np.clip(-hgt, 0, None) * 0.08, 0.4, 1), rough, np.zeros_like(rough)], -1)), 6)).save(o, optimize=True)
    TEX[name] = (a, n, o)


def bark_textures():
    S = 512
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    # poplar: grey-green, smooth upper bark with diamond lenticels, fissured (handled by same tile)
    n1 = spectral(S, 1.6, 11, fmin=2, fmax=120); n2 = spectral(S, 0.8, 12, fmin=30)
    fiss = blur(spectral(S, 1.4, 13, fmin=3, fmax=60), (6, 0.8))
    fiss = smoothstep(0.4, 1.2, np.abs(fiss))
    dia = np.zeros((S, S), np.float32)
    r = rng(14)
    for k in range(70):
        cx, cy, w, h = r.uniform(0, S), r.uniform(0, S), r.uniform(10, 30), r.uniform(5, 12)
        pts = np.array([[cx - w, cy], [cx, cy - h], [cx + w, cy], [cx, cy + h]], np.int32)
        for ox in (-S, 0, S):
            for oy in (-S, 0, S):
                cv2.fillPoly(dia, [pts + [ox, oy]], 1.0, cv2.LINE_AA)
    alb = colorize(norm01(n1 * 0.6 + n2 * 0.4), [(0, '#6c6c5c'), (0.5, '#8a8a76'), (1, '#a3a28c')])
    alb = lerp(alb, srgb('#2d2a24'), np.clip(dia * 0.9 + fiss * 0.6, 0, 1))
    alb = lerp(alb, srgb('#5f6a45'), smoothstep(0.8, 1.6, n1) * 0.4)   # algae
    save_tex('bark_poplar', alb, n2 * 0.6 - dia * 3 - fiss * 4, 0.9 + 0 * n1, 0.8)
    # horse chestnut: dark grey-brown with flaking plates
    F1, F2, ids = voronoi(S, 90, 21, warp=6.0)
    plate = smoothstep(0.0, 6.0, F2 - F1)
    tone = rng(22).random(90)[ids]
    alb = colorize(norm01(tone * 0.6 + spectral(S, 1.0, 23, fmin=10) * 0.2), [(0, '#3a332c'), (0.5, '#4f463d'), (1, '#625850')])
    alb = lerp(srgb('#1c1916'), alb, plate)
    save_tex('bark_chestnut', alb, plate * 4 + tone * 2 + spectral(S, 0.7, 24, fmin=40) * 0.4, np.full((S, S), 0.92, np.float32), 0.8)
    # birch: white, black horizontal lenticels, black fissured base patches
    n = spectral(S, 1.4, 31, fmin=2, fmax=100)
    alb = colorize(norm01(n), [(0, '#bdb8ac'), (1, '#e0dcd2')])
    len_ = np.zeros((S, S), np.float32)
    for k in range(160):
        cx, cy, w = r.uniform(0, S), r.uniform(0, S), r.uniform(8, 40)
        for ox in (-S, 0, S):
            cv2.line(len_, (int(cx - w + ox), int(cy)), (int(cx + w + ox), int(cy)), 1.0, int(r.uniform(1, 4)), cv2.LINE_AA)
    blk = smoothstep(0.9, 1.5, spectral(S, 1.8, 32, fmin=2, fmax=40))
    alb = lerp(alb, srgb('#1e1c19'), np.clip(len_ * 0.85 + blk * 0.9, 0, 1))
    alb = lerp(alb, srgb('#8f877a'), smoothstep(0.5, 1.5, -n) * 0.3)
    save_tex('bark_birch', alb, -len_ * 2 - blk * 3 + n * 0.3, 0.75 + blk * 0.2, 0.8)
    # exposed / splintered wood (broken ends, shrapnel scars)
    S2 = 256
    yy, xx = np.mgrid[0:S2, 0:S2].astype(np.float32)
    grain = np.sin(xx * 0.6 + spectral(S2, 2, 41, fmin=2, fmax=30) * 4)
    alb = lerp(srgb('#8d7356'), srgb('#c2a47c'), grain * 0.5 + 0.5)
    alb = lerp(alb, srgb('#2a241d'), smoothstep(0.6, 1.4, spectral(S2, 1.5, 42, fmin=3, fmax=40)) * 0.6)  # scorch
    save_tex('wood_inner', alb, grain * 1.5, np.full((S2, S2), 0.85, np.float32), 1.0)
    # soil for root plates
    soil = colorize(norm01(spectral(S2, 1.2, 51, fmin=4)), [(0, '#2e261d'), (1, '#55473a')])
    save_tex('soil', soil, spectral(S2, 1.2, 51, fmin=4) * 2, np.full((S2, S2), 0.95, np.float32), 1.0)


def leaf_texture():
    """1024^2 RGBA: 4 quadrants = chestnut cluster A/B, birch cluster A/B (late summer: some yellowing)."""
    S = 1024; q = 512
    alb = np.zeros((S, S, 3), np.float32); alpha = np.zeros((S, S), np.float32); hgt = np.zeros((S, S), np.float32)
    r = rng(61)
    def leaf_poly(cx, cy, L, Wd, ang, serr=0.0, n=14):
        t = np.linspace(0, 1, n)
        # obovate outline (widest towards the tip)
        w = Wd * np.sin(np.pi * t ** 0.8) * (0.6 + 0.4 * t)
        if serr:
            w *= 1 + serr * (np.arange(n) % 2)
        left = np.stack([t * L, w], -1); right = np.stack([t * L, -w], -1)[::-1]
        P = np.concatenate([left, right])
        c, s = math.cos(ang), math.sin(ang)
        P = P @ np.array([[c, s], [-s, c]]) + [cx, cy]
        return P.astype(np.int32)
    def colour():
        k = r.random()
        if k < 0.62:
            return srgb('#3d4d22') * r.uniform(0.8, 1.2)
        if k < 0.85:
            return srgb('#5f6a2b') * r.uniform(0.85, 1.15)
        if k < 0.95:
            return srgb('#8a7a2e') * r.uniform(0.9, 1.1)
        return srgb('#6b4a26')
    for quad in range(4):
        ox, oy = (quad % 2) * q, (quad // 2) * q
        A = np.zeros((q, q), np.float32); C = np.zeros((q, q, 3), np.float32); Hh = np.zeros((q, q), np.float32)
        chestnut = quad < 2
        # twig
        tw = [(q * 0.5, q * 0.98)]
        for k in range(8):
            tw.append((tw[-1][0] + r.normal(0, 10), tw[-1][1] - q * 0.1))
        for a, b in zip(tw[:-1], tw[1:]):
            cv2.line(A, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), 1.0, 4, cv2.LINE_AA)
            cv2.line(C, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), tuple(float(v) for v in srgb('#3b3026')), 4, cv2.LINE_AA)
        if chestnut:
            for k in range(7):          # palmate leaves: 5-7 leaflets from a point
                base = tw[r.integers(2, 8)]
                cx, cy = base[0] + r.normal(0, 60), base[1] + r.normal(0, 40)
                cx, cy = np.clip(cx, 120, q - 120), np.clip(cy, 120, q - 120)
                rot0 = r.uniform(0, 2 * np.pi); col = colour()
                for j in range(7):
                    ang = rot0 + (j - 3) * 0.42
                    L = r.uniform(90, 130) * (1 - abs(j - 3) * 0.13)
                    P = leaf_poly(cx, cy, L, L * 0.2, ang, serr=0.05)
                    shade = r.uniform(0.8, 1.15)
                    cv2.fillPoly(A, [P], 1.0, cv2.LINE_AA)
                    cv2.fillPoly(C, [P], tuple(float(v) for v in col * shade), cv2.LINE_AA)
                    cv2.fillPoly(Hh, [P], r.uniform(0.5, 1.0), cv2.LINE_AA)
                    tip = (int(cx + math.cos(ang) * L), int(cy - math.sin(ang) * L))
                    cv2.line(C, (int(cx), int(cy)), (int(cx + math.cos(ang) * L * 0.9), int(cy + math.sin(ang) * L * 0.9)), tuple(float(v) for v in col * 1.35), 1, cv2.LINE_AA)
        else:
            for k in range(70):          # birch: many small ovate leaves on drooping twigs
                base = tw[r.integers(1, 8)]
                cx, cy = base[0] + r.normal(0, 90), base[1] + r.normal(0, 70)
                cx, cy = np.clip(cx, 40, q - 40), np.clip(cy, 40, q - 40)
                ang = r.uniform(0, 2 * np.pi); L = r.uniform(30, 45); col = colour()
                P = leaf_poly(cx, cy, L, L * 0.38, ang, serr=0.1, n=10)
                cv2.fillPoly(A, [P], 1.0, cv2.LINE_AA)
                cv2.fillPoly(C, [P], tuple(float(v) for v in col * r.uniform(0.85, 1.2)), cv2.LINE_AA)
                cv2.fillPoly(Hh, [P], r.uniform(0.5, 1.0), cv2.LINE_AA)
        n = spectral(q, 1.0, 70 + quad, fmin=20)
        C = C * (0.9 + 0.1 * n[..., None])
        alb[oy:oy + q, ox:ox + q] = C; alpha[oy:oy + q, ox:ox + q] = A; hgt[oy:oy + q, ox:ox + q] = Hh * 3
    # bleed colour into transparent pixels so mipmaps don't fringe black
    m = alpha > 0.5
    fill = blur(alb * alpha[..., None], 8, wrap=False) / (blur(alpha, 8, wrap=False)[..., None] + 1e-4)
    alb = np.where(m[..., None], alb, fill)
    save_tex('leaves', np.clip(alb, 0, 1), blur(hgt, 1.0, wrap=False), np.full((S, S), 0.75, np.float32), 0.6, alpha=alpha)


# ------------------------------------------------------------------ geometry helpers
def bark_uv(circ=1.0):
    return lambda s, L: (s, L / circ)


def branch_tube(mb, pts, r0, r1, sides, mat, circ=1.0):
    n = len(pts)
    rad = np.linspace(r0, r1, n)
    mb.tube(pts, rad, sides, bark_uv(circ), smooth=True, mat=mat)


def curve(p0, d, L, nseg, rnd, droop=0.0, wobble=0.08, up_bias=0.0):
    pts = [np.array(p0, float)]; d = np.array(d, float); d /= np.linalg.norm(d)
    for i in range(nseg):
        d = d + rnd.normal(0, wobble, 3) + np.array([0, -droop + up_bias, 0]) * (1.0 / nseg)
        d /= np.linalg.norm(d)
        pts.append(pts[-1] + d * L / nseg)
    return np.array(pts)


def splinter_end(mb, p, d, r, rnd, mat_wood, n=5):
    """Jagged broken end: a ring of spiky splinter triangles (both sides) + an inner disc."""
    d = np.asarray(d, float); d /= np.linalg.norm(d)
    a = np.cross(d, [0, 1, 0] if abs(d[1]) < 0.9 else [1, 0, 0]); a /= np.linalg.norm(a); b = np.cross(d, a)
    f = Fit_wood
    ring = [p + (a * math.cos(t) + b * math.sin(t)) * r for t in np.linspace(0, 2 * np.pi, n, endpoint=False)]
    for i in range(n):
        q0, q1 = ring[i], ring[(i + 1) % n]
        tip = (q0 + q1) / 2 * 0.7 + p * 0.3 + d * r * rnd.uniform(0.3, 1.6) + rnd.normal(0, r * 0.3, 3)
        mb.poly([q0, q1, tip], f, mat=mat_wood); mb.poly([q1, q0, tip], f, mat=mat_wood)
    mb.poly(ring[::-1], f, mat=mat_wood)


class _FitWood:
    def __call__(self, P, n):
        return [(0.1 + 0.8 * (i % 2), 0.1 + 0.8 * (i // 2 % 2)) for i in range(len(P))]


Fit_wood = _FitWood()

BARK, WOOD, LEAF = 0, 1, 2


SPEC = {
    # per level (0 = trunk): children count, start t, branching angle (deg), length ratio, radius ratio, droop, wobble
    'poplar':   dict(kids=[16, 4, 3], start=[0.22, 0.3, 0.3], ang=[28, 32, 35], lr=[0.38, 0.5, 0.45], rr=[0.5, 0.55, 0.6], droop=[0, 0.05, 0.15, 0.3], wob=[0.025, 0.08, 0.12, 0.15], r=0.32),
    'chestnut': dict(kids=[11, 5, 3], start=[0.35, 0.25, 0.3], ang=[42, 45, 50], lr=[0.55, 0.5, 0.45], rr=[0.62, 0.55, 0.6], droop=[0, 0.25, 0.45, 0.5], wob=[0.03, 0.1, 0.14, 0.18], r=0.34),
    'birch':    dict(kids=[14, 5, 4], start=[0.3, 0.25, 0.3], ang=[48, 40, 30], lr=[0.36, 0.5, 0.55], rr=[0.5, 0.55, 0.6], droop=[0, 0.35, 1.1, 1.6], wob=[0.04, 0.1, 0.15, 0.2], r=0.17),
}
SEGS = [10, 5, 3, 2]; SIDES = [8, 6, 4, 3]


def _rot_towards(d, ang, az):
    d = d / np.linalg.norm(d)
    a = np.cross(d, [0, 1, 0] if abs(d[1]) < 0.95 else [1, 0, 0]); a /= np.linalg.norm(a); b = np.cross(d, a)
    perp = a * math.cos(az) + b * math.sin(az)
    return d * math.cos(ang) + perp * math.sin(ang)


def grow(mb, sp, p, d, L, r0, level, r, stripped, leaves, circ, maxlevel=3):
    P = SPEC[sp]
    pts = curve(p, d, L, SEGS[level], r, droop=P['droop'][level], wobble=P['wob'][level])
    n = len(pts)
    taper = 0.25 if level == 0 else 0.3
    rad = r0 * np.linspace(1.0, taper, n)
    if level == 0:
        rad[0] *= 1.35; rad[1] *= 1.08
    fate = 'ok'
    if stripped and level >= 1:
        q = r.random()
        if level == 1:
            fate = 'snapped' if q < 0.38 else ('hanging' if q < 0.5 else 'ok')
        elif level == 2:
            fate = 'snapped' if q < 0.3 else ('gone' if q < 0.45 else 'ok')
        else:
            fate = 'gone' if q < 0.55 else 'ok'
    if fate == 'gone':
        return
    if fate == 'snapped':
        cut = max(2, int(n * r.uniform(0.3, 0.7)))
        pts = pts[:cut]; rad = rad[:cut]
        mb.tube(pts, rad, SIDES[level], bark_uv(circ), smooth=True, mat=BARK)
        splinter_end(mb, pts[-1], pts[-1] - pts[-2], rad[-1], r, WOOD, n=4 if level < 2 else 3)
        return
    if fate == 'hanging':
        h = max(2, n // 2)
        mb.tube(pts[:h + 1], rad[:h + 1], SIDES[level], bark_uv(circ), smooth=True, mat=BARK)
        hang = curve(pts[h], np.array([r.normal(0, 0.3), -1.0, r.normal(0, 0.3)]), L * 0.5, 3, r, wobble=0.15)
        mb.tube(hang, np.linspace(rad[h] * 0.8, rad[-1], len(hang)), SIDES[level], bark_uv(circ), smooth=True, mat=BARK)
        splinter_end(mb, pts[h], pts[h] - pts[h - 1], rad[h], r, WOOD, n=3)
        return
    mb.tube(pts, rad, SIDES[level], bark_uv(circ), smooth=True, mat=BARK)
    if level >= maxlevel:
        leaves.append(pts)
        return
    k = P['kids'][level]
    if stripped and level >= 1:
        k = max(1, int(k * 0.8))
    base_az = r.uniform(0, 2 * np.pi)
    for j in range(k):
        t = P['start'][level] + (1 - P['start'][level]) * (j + r.uniform(0.2, 0.8)) / k
        i = min(n - 2, int(t * (n - 1))); f = t * (n - 1) - i
        q0 = pts[i] * (1 - f) + pts[i + 1] * f
        rq = rad[i] * (1 - f) + rad[i + 1] * f
        dloc = pts[i + 1] - pts[i]
        ang = math.radians(P['ang'][level] + r.normal(0, 8))
        cd = _rot_towards(dloc, ang, base_az + j * 2.39996)
        Lc = L * P['lr'][level] * (1.2 - 0.6 * t) * r.uniform(0.8, 1.15)
        grow(mb, sp, q0, cd, Lc, max(0.006, rq * P['rr'][level]), level + 1, r, stripped, leaves, circ, maxlevel)
    if level == 0 and sp == 'chestnut':
        # decurrent crown: the trunk forks into leaders
        for j in range(3):
            cd = _rot_towards(pts[-1] - pts[-2], math.radians(28 + r.normal(0, 6)), j * 2.1 + r.normal(0, 0.3))
            grow(mb, sp, pts[-1] - (pts[-1] - pts[-2]) * 0.3, cd, L * 0.75, rad[-1] * 1.1, 1, r, stripped, leaves, circ, maxlevel)


def tree(name, species, seed, height, stripped=True, broken_top=False, leafy=False, pollard=False):
    mb = MB(name); r = rng(seed)
    circ = {'poplar': 1.0, 'chestnut': 1.2, 'birch': 0.8}[species]
    leaves = []
    r0 = SPEC[species]['r'] * height / 13
    trunk_L = height * {'poplar': 0.95, 'chestnut': 0.48, 'birch': 0.95}[species]
    if pollard:
        # city-pollarded poplar: thick trunk cut at ~8 m, knuckled head with a broom of thin vertical shoots
        r0 *= 1.6
        pts = curve((0, -0.15, 0), (r.normal(0, 0.03), 1, r.normal(0, 0.03)), height * 0.6, 8, r, wobble=0.03)
        rad = r0 * np.linspace(1.0, 0.62, len(pts)); rad[0] *= 1.3
        mb.tube(pts, rad, 9, bark_uv(circ), smooth=True, mat=BARK)
        top, td = pts[-1], pts[-1] - pts[-2]
        for k in range(6):
            d = _rot_towards(td, math.radians(r.uniform(25, 55)), k * 1.05 + r.normal(0, 0.2))
            kn = curve(top - td * 0.1, d, r.uniform(0.5, 1.3), 3, r, wobble=0.12)
            kr = rad[-1] * r.uniform(0.45, 0.6)
            mb.tube(kn, np.linspace(kr, kr * 1.15, len(kn)), 7, bark_uv(circ), smooth=True, mat=BARK)
            mb.poly([kn[-1] + [kr, 0.02, 0], kn[-1] + [-kr * 0.5, 0.05, kr * 0.8], kn[-1] + [-kr * 0.5, 0.03, -kr * 0.8]], Fit_wood, mat=WOOD)
            for j in range(r.integers(4, 8)):
                if stripped and r.random() < 0.35:
                    continue
                sd = np.array([r.normal(0, 0.18), 1, r.normal(0, 0.18)])
                L = r.uniform(1.5, 4.5) * (0.5 if stripped and r.random() < 0.4 else 1)
                sh = curve(kn[-1] + r.normal(0, kr * 0.4, 3), sd, L, 4, r, wobble=0.06)
                mb.tube(sh, np.linspace(0.035, 0.008, len(sh)), 4, bark_uv(circ), smooth=True, mat=BARK)
                if not stripped or r.random() < 0.3:
                    for m_ in range(2):
                        tw = curve(sh[r.integers(1, len(sh))], sd + r.normal(0, 0.6, 3), L * 0.35, 2, r, wobble=0.15)
                        mb.tube(tw, np.linspace(0.01, 0.004, len(tw)), 3, bark_uv(circ), smooth=True, mat=BARK)
        trunk = pts; trad = rad
    else:
        if broken_top:
            trunk_L *= r.uniform(0.55, 0.7) if species != 'chestnut' else 1.0
        grow(mb, species, np.array([0, -0.15, 0]), np.array([r.normal(0, 0.03), 1, r.normal(0, 0.03)]), trunk_L, r0, 0, r,
             stripped, leaves, circ, maxlevel=3)
        if broken_top and species != 'chestnut':
            pass
        trunk = np.array([[0, y, 0] for y in np.linspace(0, trunk_L, 8)]); trad = r0 * np.linspace(1.0, 0.3, 8)
    if broken_top:
        # remove everything above a break height and add a splintered top
        hb = trunk_L * r.uniform(0.75, 0.9) if species != 'chestnut' else trunk_L * 1.05
        V = np.array(mb.V); keep = []
        for f in mb.F:
            if V[list(f[0]), 1].max() <= hb + (0.0 if f[3] == BARK else 0.5):
                keep.append(f)
        mb.F = keep
        rb = r0 * (1 - 0.7 * hb / trunk_L)
        splinter_end(mb, np.array([0, hb - 0.05, 0]), (0, 1, 0), rb, r, WOOD, n=7)
    if leafy:
        quads = [(0, 0, 0.5, 0.5), (0.5, 0, 1.0, 0.5)] if species == 'chestnut' else [(0, 0.5, 0.5, 1.0), (0.5, 0.5, 1.0, 1.0)]
        for p2 in leaves:
            for k in range(2):
                if species == 'birch' and r.random() < 0.3:
                    continue
                c = p2[-1] * (0.4 + 0.6 * r.random()) + p2[0] * 0 + r.normal(0, 0.25, 3) if False else p2[min(len(p2) - 1, 1 + k)] + r.normal(0, 0.25, 3)
                size = r.uniform(1.0, 1.5) if species == 'chestnut' else r.uniform(0.8, 1.2)
                u0, v0, u1, v1 = quads[r.integers(0, 2)]
                yaw = r.uniform(0, np.pi)
                for cross in (0, np.pi / 2):
                    a = np.array([math.cos(yaw + cross), r.normal(0, 0.2), math.sin(yaw + cross)]); a /= np.linalg.norm(a)
                    up = np.array([r.normal(0, 0.3), -1 if species == 'birch' else 1, r.normal(0, 0.3)]); up /= np.linalg.norm(up)
                    Pq = [c - a * size / 2 - up * size * 0.4, c + a * size / 2 - up * size * 0.4, c + a * size / 2 + up * size * 0.6, c - a * size / 2 + up * size * 0.6]
                    uv = [(u0, 1 - v1), (u1, 1 - v1), (u1, 1 - v0), (u0, 1 - v0)]
                    mb.face(mb.vs(Pq), uv, True, LEAF)
    if stripped:
        for k in range(r.integers(2, 5)):
            t = r.uniform(0.05, 0.6); i = int(t * (len(trunk) - 1))
            p = trunk[i]; rr = trad[i] * 1.03; az = r.uniform(0, 2 * np.pi)
            nrm = np.array([math.cos(az), 0, math.sin(az)]); tang = np.array([-math.sin(az), 0, math.cos(az)])
            w, h = rr * r.uniform(0.4, 0.9), r.uniform(0.15, 0.5)
            Pq = [p + nrm * rr - tang * w / 2, p + nrm * rr + tang * w / 2, p + nrm * rr + tang * w / 2 + [0, h, 0], p + nrm * rr - tang * w / 2 + [0, h, 0]]
            mb.poly(Pq, Fit_wood, mat=WOOD)
    return mb


def snapped_tree(name, species, seed, height):
    """Trunk snapped at 1.5-3 m, upper part fallen over but still attached by a splintered hinge."""
    r = rng(seed)
    full = tree(name, species, seed, height, stripped=True)
    hb = r.uniform(1.6, 2.6)
    mb = MB(name)
    # split by vertex height: faces fully below hb stay; others rotate about the hinge
    ang = r.uniform(1.25, 1.45); az = r.uniform(0, 2 * np.pi)
    axis = np.array([math.cos(az), 0, math.sin(az)])
    M = rot_axis(axis, ang, origin=(0, hb, 0))
    V = np.array(full.V)
    Vrot = xform(V, M)
    for idx, uv, sm, mt in full.F:
        ys = V[list(idx), 1]
        use = Vrot if ys.min() > hb - 0.05 else V
        if ys.min() < hb - 0.05 and ys.max() > hb + 0.05:
            continue   # drop faces spanning the break (replaced by splinters)
        ids = mb.vs(use[list(idx)])
        mb.face(ids, uv, sm, mt)
    rb = 0.16 * height / 14 * (0.8 if species == 'birch' else 1.6)
    splinter_end(mb, np.array([0, hb - 0.05, 0]), (0, 1, 0), rb, r, WOOD, n=7)
    top = xform(np.array([[0, hb + 0.05, 0]]), M)[0]
    splinter_end(mb, top, xform(np.array([[0, hb - 1, 0]]), M)[0] - top, rb, r, WOOD, n=7)
    # trunk stub between ground and break (the original segment faces spanning hb were dropped)
    stub = curve((0, hb - 0.4, 0), (0, 1, 0), 0.45, 2, r, wobble=0.0)
    mb.tube(stub, rb, 8, bark_uv(0.8), smooth=True, mat=BARK)
    # clamp anything that would end below ground
    V = np.array(mb.V); V[:, 1] = np.maximum(V[:, 1], 0.02 + 0 * V[:, 1]) if False else V[:, 1]; mb.V = list(V)
    return mb


def stump(name, seed, r0=0.28, h=0.7):
    mb = MB(name); r = rng(seed)
    pts = curve((0, -0.1, 0), (r.normal(0, 0.1), 1, r.normal(0, 0.1)), h, 3, r, wobble=0.05)
    rad = np.array([r0 * 1.4, r0 * 1.1, r0, r0 * 0.95])
    mb.tube(pts, rad, 9, bark_uv(1.0), smooth=True, mat=BARK)
    splinter_end(mb, pts[-1], pts[-1] - pts[-2], r0 * 0.95, r, WOOD, n=8)
    # surface roots
    for k in range(5):
        az = k * 1.3 + r.normal(0, 0.3)
        d = np.array([math.cos(az), -0.25, math.sin(az)])
        rp = curve((0, 0.12, 0), d, r.uniform(0.6, 1.2), 3, r, wobble=0.1)
        branch_tube(mb, rp, r0 * 0.4, 0.02, 5, BARK, 1.0)
    return mb


def fallen(name, seed, L=8.5):
    mb = MB(name); r = rng(seed)
    pts = curve((0, 0.3, -L / 2), (0.05, 0.02, 1), L, 10, r, wobble=0.02)
    rad = np.linspace(0.3, 0.12, len(pts))
    mb.tube(pts, rad, 8, bark_uv(1.0), smooth=True, mat=BARK)
    splinter_end(mb, pts[-1], pts[-1] - pts[-2], 0.12, r, WOOD, n=5)
    # root plate (uprooted): flattened disc of soil + roots at the base
    c = pts[0] - np.array([0, 0, 0.15])
    ring = []
    n = 12
    for k in range(n):
        a = 2 * np.pi * k / n
        ring.append(c + np.array([math.cos(a) * 1.1 * r.uniform(0.8, 1.15), 0.9 + math.sin(a) * 1.0 * r.uniform(0.8, 1.1), r.normal(0, 0.05)]))
    soilmat = 3
    cc = c + np.array([0, 0.9, -0.15])
    for k in range(n):
        q0, q1 = ring[k], ring[(k + 1) % n]
        mb.poly([cc, q1, q0], lambda P, nn: [(0.5 + (p[0] - cc[0]) / 2.4, 0.5 + (p[1] - cc[1]) / 2.4) for p in P], mat=soilmat)
        mb.poly([cc + [0, 0, 0.3], q0 + [0, 0, 0.15], q1 + [0, 0, 0.15]], lambda P, nn: [(0.5 + (p[0] - cc[0]) / 2.4, 0.5 + (p[1] - cc[1]) / 2.4) for p in P], mat=soilmat)
        mb.poly([q0, q1, q1 + [0, 0, 0.15], q0 + [0, 0, 0.15]], lambda P, nn: [(0.1, 0.1), (0.9, 0.1), (0.9, 0.3), (0.1, 0.3)], mat=soilmat)
    for k in range(7):
        a = r.uniform(0, 2 * np.pi)
        rp = curve(cc + [math.cos(a) * 0.5, math.sin(a) * 0.5, -0.1], (math.cos(a), math.sin(a), -0.6), r.uniform(0.6, 1.3), 3, r, wobble=0.2)
        branch_tube(mb, rp, 0.05, 0.01, 4, BARK, 1.0)
    # snapped branch stubs
    for k in range(6):
        t = r.uniform(0.3, 0.95); i = int(t * (len(pts) - 1))
        d = np.array([r.normal(0, 1), r.uniform(0.2, 1), r.normal(0, 0.4)])
        b = curve(pts[i], d, r.uniform(0.3, 1.8), 3, r, wobble=0.1)
        branch_tube(mb, b, rad[i] * 0.4, 0.02, 5, BARK, 1.0)
        splinter_end(mb, b[-1], b[-1] - b[-2], 0.02, r, WOOD, n=3)
    return mb


def main():
    bark_textures(); leaf_texture()
    reset_scene()
    mats = {}
    for sp in ('poplar', 'chestnut', 'birch'):
        mats[sp] = make_material('bark_' + sp, *TEX['bark_' + sp])
    mats['wood'] = make_material('wood_splintered', *TEX['wood_inner'])
    mats['leaves'] = make_material('leaves_late_summer', *TEX['leaves'], alpha_clip=0.5, double=True)
    mats['soil'] = make_material('soil', *TEX['soil'])
    items = [
        (tree('tree_poplar_stripped', 'poplar', 1, 15.0, stripped=True, pollard=True), 'poplar'),
        (tree('tree_poplar_broken', 'poplar', 2, 16.0, stripped=True, broken_top=True), 'poplar'),
        (tree('tree_chestnut_stripped', 'chestnut', 3, 11.0, stripped=True), 'chestnut'),
        (tree('tree_chestnut_broken', 'chestnut', 4, 10.0, stripped=True, broken_top=True), 'chestnut'),
        (tree('tree_birch_stripped', 'birch', 5, 12.0, stripped=True), 'birch'),
        (snapped_tree('tree_birch_snapped', 'birch', 6, 11.0), 'birch'),
        (tree('leafy_summer_chestnut', 'chestnut', 7, 11.5, stripped=False, leafy=True), 'chestnut'),
        (tree('leafy_summer_birch', 'birch', 8, 12.5, stripped=False, leafy=True), 'birch'),
        (stump('stump_1', 9, 0.28, 0.75), 'poplar'),
        (stump('stump_2', 10, 0.22, 0.4), 'chestnut'),
        (fallen('fallen_trunk', 11), 'poplar'),
    ]
    info = {}
    for i, (mb, sp) in enumerate(items):
        ob = mb.to_object(mb.name, [mats[sp], mats['wood'], mats['leaves'], mats['soil']], smooth_angle=70, location=(i * 9.0, 0, 0))
        # drop unused material slots
        used = sorted(set(f[3] for f in mb.F))
        mn, mx = mb.bounds()
        info[mb.name] = {'tris': mb.tris(), 'bbox_min': [round(float(v), 2) for v in mn], 'bbox_max': [round(float(v), 2) for v in mx]}
        print(f'{mb.name:26s} {mb.tris():6d} tris  h={mx[1]:.1f}')
    size = export_glb(os.path.join(REPO, 'assets', 'env', 'trees.glb'))
    print('trees.glb', size / 1e6)
    update_manifest('trees', {'file': 'trees.glb', 'nodes': info,
                              'notes': 'Top-level nodes laid out 9 m apart along +X (game uses each node as a template). Origin at trunk base. '
                                       'Names avoid matching two city.js classes: bare=tree_*, leafy=leafy_summer_*, stump_*, fallen_trunk. '
                                       'Materials: bark_<species> (tiling), wood_splintered, leaves_late_summer (alpha MASK 0.5, double sided), soil.'})


if __name__ == '__main__':
    main()
