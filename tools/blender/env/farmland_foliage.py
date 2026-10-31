"""Foliage atlas (2048^2 RGBA, alpha-tested) for farmland.glb, material 'farmland_foliage' (alphaMode MASK 0.5,
double sided): late-summer leaf clusters (black locust / Lombardy poplar / oak / walnut / elder / dog rose / dying
locust), fallow weeds, dead sunflower and dry maize parts, a woven wattle (pleten) panel, torn greenhouse film, and
the far-LOD crown clump cells (far_*) and wide twig sprays (spray_*) for the outer crown.
Output: _cache/farmland_foliage_{albedo.png,normal.png,orm.png}.
"""
import os, math
import numpy as np
import cv2
from PIL import Image
from texlib import spectral, norm01, colorize, srgb, lerp, to8, normal_from_height, smoothstep, blur, CACHE, quantize_normal, rng

S = 2048
FREG = {
    'acacia': (0, 0, 512, 512), 'poplar': (512, 0, 1024, 512), 'oak': (1024, 0, 1536, 512), 'walnut': (1536, 0, 2048, 512),
    'elder': (0, 512, 512, 1024), 'rose': (512, 512, 1024, 1024), 'acacia_dry': (1024, 512, 1536, 1024), 'weeds': (1536, 512, 2048, 1024),
    'sf_stalk': (0, 1024, 128, 1536), 'sf_stalk2': (128, 1024, 256, 1536), 'corn_a': (256, 1024, 448, 1536), 'corn_b': (448, 1024, 640, 1536),
    'sf_head': (640, 1024, 768, 1152), 'sf_back': (768, 1024, 896, 1152), 'sf_leaf': (640, 1152, 768, 1280), 'corn_ear': (768, 1152, 896, 1280),
    'sf_leaf2': (640, 1280, 768, 1408), 'corn_leaf': (768, 1280, 896, 1408), 'grass_tuft': (640, 1408, 896, 1536),
    'thistle': (896, 1024, 1024, 1280), 'ragweed': (896, 1280, 1024, 1536),
    'wattle': (1024, 1024, 2048, 1344), 'film': (1024, 1344, 2048, 1536),
}
# far-LOD crown clumps (256^2, dense rounded leaf masses that survive mipmapping at 200+ m) in the bottom quarter
FAR_SPECIES = ['acacia', 'poplar', 'oak', 'walnut', 'elder', 'rose', 'acacia_dry']
for _k, _n in enumerate(FAR_SPECIES):
    FREG['far_' + _n] = (_k * 256, 1536, _k * 256 + 256, 1792)
FREG['far_trunkless'] = (7 * 256, 1536, 2048, 1792)   # spare
# second leaf-cluster variants (512 x 256 'sprays': wide, flat twig sprays for the outer crown)
for _k, _n in enumerate(['acacia', 'poplar', 'oak', 'walnut']):
    FREG['spray_' + _n] = (_k * 512, 1792, _k * 512 + 512, 2048)
SS = 2   # supersampling for drawing


class Canvas:
    def __init__(self, w, h, seed):
        self.w, self.h = w * SS, h * SS; self.r = rng(seed)
        self.C = np.zeros((self.h, self.w, 3), np.float32); self.A = np.zeros((self.h, self.w), np.float32)
        self.H = np.zeros((self.h, self.w), np.float32)

    def poly(self, P, col, hgt=1.0, alpha=1.0):
        Q = (np.asarray(P, np.float32) * SS * 16).astype(np.int32)
        cv2.fillPoly(self.C, [Q], tuple(float(c) for c in col), cv2.LINE_AA, shift=4)
        cv2.fillPoly(self.A, [Q], float(alpha), cv2.LINE_AA, shift=4)
        cv2.fillPoly(self.H, [Q], float(hgt), cv2.LINE_AA, shift=4)

    def line(self, pts, col, width, hgt=1.0):
        P = (np.asarray(pts, np.float32) * SS * 16).astype(np.int32)
        wd = max(1, int(round(width * SS)))
        for a, b in zip(P[:-1], P[1:]):
            cv2.line(self.C, tuple(a), tuple(b), tuple(float(c) for c in col), wd, cv2.LINE_AA, shift=4)
            cv2.line(self.A, tuple(a), tuple(b), 1.0, wd, cv2.LINE_AA, shift=4)
            cv2.line(self.H, tuple(a), tuple(b), float(hgt), wd, cv2.LINE_AA, shift=4)

    def taper(self, pts, w0, w1, col, hgt=1.0, shade=True):
        """Tapered stalk / branch as a polygon strip (light from the left)."""
        P = np.asarray(pts, np.float32); n = len(P)
        T = np.gradient(P, axis=0); T /= (np.linalg.norm(T, axis=1, keepdims=True) + 1e-6)
        N = np.stack([-T[:, 1], T[:, 0]], -1)
        W = np.linspace(w0, w1, n)[:, None] / 2
        L = P + N * W; R = P - N * W
        self.poly(np.concatenate([L, R[::-1]]), col, hgt)
        if shade and w0 > 3:
            self.poly(np.concatenate([P + N * W * 0.15, R[::-1] * 0.6 + P[::-1] * 0.4]), np.asarray(col) * 0.7, hgt * 0.9)

    def out(self):
        def ds(a):
            return cv2.resize(a, (self.w // SS, self.h // SS), interpolation=cv2.INTER_AREA)
        A = np.clip(ds(self.A), 0, 1)
        C = ds(self.C)
        # colours were drawn with alpha-agnostic AA into black: un-premultiply
        C = np.where(A[..., None] > 1e-3, C / np.maximum(A[..., None], 1e-3), 0)
        return np.clip(C, 0, 1), A, ds(self.H)


def leaf_shape(L, W, kind='ovate', n=14, serr=0.0, r=None):
    t = np.linspace(0, 1, n)
    if kind == 'ovate':
        w = W * np.sin(np.pi * t ** 0.9) * (1.0 - 0.25 * t)
    elif kind == 'obovate':
        w = W * np.sin(np.pi * t ** 0.75) * (0.6 + 0.4 * t)
    elif kind == 'lanceolate':
        w = W * np.sin(np.pi * t ** 0.8) ** 0.8 * (1 - 0.35 * t)
    elif kind == 'rhombic':
        w = W * np.where(t < 0.35, t / 0.35, (1 - t) / 0.65) ** 0.9
    elif kind == 'heart':
        w = W * np.sin(np.pi * t ** 0.65) * (1.15 - 0.4 * t)
    elif kind == 'lobed':   # oak: 4-5 rounded lobes each side
        w = W * (0.55 + 0.45 * np.abs(np.sin(t * np.pi * 4.5))) * np.sin(np.pi * t ** 0.7)
    elif kind == 'oval':
        w = W * np.sqrt(np.clip(1 - (2 * t - 1) ** 2, 0, 1))
    else:
        w = W * np.sin(np.pi * t)
    if serr:
        w = w * (1 + serr * ((np.arange(n) % 2) - 0.5))
    left = np.stack([t * L, w], -1); right = np.stack([t * L, -w], -1)[::-1]
    return np.concatenate([left, right])


def place(P, cx, cy, ang, curl=0.0):
    P = P.copy()
    if curl:
        P[:, 1] *= (1 - curl * (P[:, 0] / (P[:, 0].max() + 1e-6)) ** 2)
    c, s = math.cos(ang), math.sin(ang)
    return P @ np.array([[c, s], [-s, c]]) + [cx, cy]


def pick(r, pal):
    """pal: list of (weight, hex, jitter)"""
    w = np.array([p[0] for p in pal], float); w /= w.sum()
    p = pal[r.choice(len(pal), p=w)]
    return srgb(p[1]) * r.uniform(1 - p[2], 1 + p[2])


# ------------------------------------------------------------------ leaf clusters
SPECIES = {
    #            leaflet L,W px  kind        compound: n pairs  palette
    'acacia': dict(L=15, W=7, kind='oval', pairs=(4, 8), rachis=1.1, n=330, twig='#3e352c',
                   pal=[(0.45, '#4f6227', 0.12), (0.3, '#647532', 0.1), (0.15, '#7d8a3c', 0.08), (0.1, '#968a3a', 0.1)], pods=5),
    'acacia_dry': dict(L=13, W=6, kind='oval', pairs=(2, 5), rachis=1.0, n=70, twig='#3a3029',
                       pal=[(0.35, '#8a8240', 0.12), (0.35, '#a08a42', 0.12), (0.2, '#7a5a2e', 0.12), (0.1, '#6b7232', 0.1)], pods=22, sparse=True),
    'poplar': dict(L=26, W=13, kind='rhombic', pairs=None, n=1100, twig='#4a4236', up=True,
                   pal=[(0.5, '#3b4a24', 0.12), (0.3, '#4c5c2c', 0.1), (0.12, '#6d7550', 0.1), (0.08, '#8a8236', 0.1)]),
    'oak': dict(L=40, W=14, kind='lobed', pairs=None, n=650, twig='#3a3026',
                pal=[(0.55, '#3c4721', 0.12), (0.3, '#4d5a28', 0.1), (0.1, '#66682e', 0.1), (0.05, '#7d6a30', 0.1)], acorns=12),
    'walnut': dict(L=36, W=15, kind='ovate', pairs=(2, 4), rachis=1.4, n=140, twig='#5a554c',
                   pal=[(0.5, '#56632a', 0.1), (0.3, '#687434', 0.1), (0.15, '#7f8a3e', 0.1), (0.05, '#9a8a3c', 0.1)], nuts=12),
    'elder': dict(L=30, W=10, kind='lanceolate', pairs=(2, 2), rachis=1.3, n=170, twig='#5a5040', serr=0.15,
                  pal=[(0.6, '#3e4d26', 0.12), (0.3, '#506030', 0.1), (0.1, '#6f7238', 0.1)], berries=6),
    'rose': dict(L=11, W=6, kind='oval', pairs=(2, 3), rachis=0.9, n=330, twig='#6a3a2a', serr=0.2,
                 pal=[(0.55, '#4b5a2c', 0.12), (0.3, '#5e6a34', 0.1), (0.15, '#7a6a34', 0.12)], hips=40),
}


def cluster(name, w, h, seed):
    sp = SPECIES[name]; cv = Canvas(w, h, seed); r = cv.r
    # twig skeleton: main twig from bottom centre, side twigs
    main = [(w * 0.5 + r.normal(0, 8), h * 0.99)]
    up = sp.get('up', False)
    nseg = 9
    for k in range(nseg):
        x, y = main[-1]
        main.append((np.clip(x + r.normal(0, 9), w * 0.2, w * 0.8), y - h * 0.105))
    twigs = [main]
    for k in range(7 if not up else 9):
        i = r.integers(2, nseg)
        bx, by = main[i]
        side = -1 if k % 2 else 1
        ang = math.radians(r.uniform(25, 60) if up else r.uniform(35, 80)) * side
        L = r.uniform(0.25, 0.45) * h
        pts = [(bx, by)]
        a = -math.pi / 2 + ang
        for j in range(5):
            a += r.normal(0, 0.15)
            pts.append((pts[-1][0] + math.cos(a) * L / 5, pts[-1][1] + math.sin(a) * L / 5))
        twigs.append(pts)
    tcol = srgb(sp['twig'])
    for t in twigs:
        cv.taper(t, 5.5 if t is main else 3.5, 1.5, tcol, 0.6)
    pts_all = np.concatenate([np.asarray(t) for t in twigs])
    sparse = sp.get('sparse', False)
    nleaf = sp['n']
    cx0, cy0 = w / 2, h / 2
    for k in range(nleaf):
        # leaves concentrate in a rounded clump (ellipse inside the cell) around the twigs; sparse species leave gaps
        for _try in range(20):
            base = pts_all[r.integers(len(pts_all))]
            jitter = 60 if not sparse else 35
            bx = base[0] + r.normal(0, jitter * 0.6); by = base[1] + r.normal(0, jitter * 0.5)
            e = ((bx - cx0) / (w * 0.36)) ** 2 + ((by - cy0) / (h * 0.36)) ** 2
            if e < 1.0 and r.random() > e ** 3 * 0.7:
                break
        bx = np.clip(bx, 30, w - 30); by = np.clip(by, 30, h - 30)
        depth = k / nleaf
        shade = 0.62 + 0.38 * depth + r.normal(0, 0.05)
        col = pick(r, sp['pal']) * shade
        ang = r.uniform(0, 2 * np.pi) if not up else -math.pi / 2 + r.normal(0, 0.7)
        if sp.get('pairs'):
            npair = r.integers(sp['pairs'][0], sp['pairs'][1] + 1)
            L, W = sp['L'] * r.uniform(0.85, 1.15), sp['W'] * r.uniform(0.85, 1.15)
            rl = L * sp['rachis'] * (npair + 0.7)
            for _t in range(8):   # keep the whole compound leaf inside the rounded clump
                ex, ey = bx + math.cos(ang) * rl, by + math.sin(ang) * rl
                if ((ex - cx0) / (w * 0.42)) ** 2 + ((ey - cy0) / (h * 0.42)) ** 2 < 1.0:
                    break
                ang = math.atan2(cy0 - by, cx0 - bx) + r.normal(0, 0.9)
            cv.line([(bx, by), (ex, ey)], col * 0.75, 1.3, 0.8)
            for j in range(npair + 1):
                t = (j + 0.6) / (npair + 0.7)
                px, py = bx + (ex - bx) * t, by + (ey - by) * t
                if j == npair:
                    P = place(leaf_shape(L, W / 2, sp['kind'], serr=sp.get('serr', 0)), ex, ey, ang)
                    cv.poly(P, col * r.uniform(0.9, 1.1), r.uniform(0.6, 1.0)); continue
                for s in (-1, 1):
                    a2 = ang + s * math.radians(r.uniform(55, 80))
                    P = place(leaf_shape(L, W / 2, sp['kind'], serr=sp.get('serr', 0)), px, py, a2, curl=r.uniform(0, 0.3))
                    cv.poly(P, col * r.uniform(0.88, 1.12), r.uniform(0.6, 1.0))
        else:
            L, W = sp['L'] * r.uniform(0.8, 1.2), sp['W'] * r.uniform(0.8, 1.2)
            P = place(leaf_shape(L, W / 2, sp['kind'], serr=sp.get('serr', 0)), bx, by, ang, curl=r.uniform(0, 0.4))
            cv.poly(P, col, r.uniform(0.6, 1.0))
            cv.line([(bx, by), (bx + math.cos(ang) * L * 0.85, by + math.sin(ang) * L * 0.85)], col * 1.25, 1, 1.0)
    # fruit
    for k in range(sp.get('pods', 0)):            # black locust pods: flat dark-brown, hanging
        b = pts_all[r.integers(len(pts_all))]
        x, y = b[0] + r.normal(0, 50), b[1] + r.normal(0, 40)
        a = math.pi / 2 + r.normal(0, 0.5)
        P = place(leaf_shape(r.uniform(26, 38), 2.6, 'lanceolate', n=10), x, y, a)
        cv.poly(P, srgb('#3e2a1c') * r.uniform(0.8, 1.2), 0.9)
    for k in range(sp.get('acorns', 0)):
        b = pts_all[r.integers(len(pts_all))]; x, y = b[0] + r.normal(0, 40), b[1] + r.normal(0, 40)
        cv.poly(place(leaf_shape(9, 3.5, 'oval', 10), x, y, math.pi / 2), srgb('#6a6a30'), 1.0)
    for k in range(sp.get('nuts', 0)):
        b = pts_all[r.integers(len(pts_all))]; x, y = b[0] + r.normal(0, 50), b[1] + r.normal(0, 50)
        Q = np.array([(x + math.cos(a) * 7, y + math.sin(a) * 7) for a in np.linspace(0, 2 * np.pi, 12, endpoint=False)])
        cv.poly(Q, srgb('#6c7a38'), 1.0); cv.poly((Q - [x, y]) * 0.45 + [x - 2, y - 2], srgb('#8a9850'), 1.0)
    for k in range(sp.get('berries', 0)):          # elder: flat umbel of black berries on purple-red stalks
        b = pts_all[r.integers(len(pts_all))]; x, y = b[0] + r.normal(0, 40), b[1] + r.normal(0, 30)
        for j in range(9):
            a = math.pi + j / 8 * math.pi
            ex, ey = x + math.cos(a) * 22, y + math.sin(a) * 10 - 8
            cv.line([(x, y + 14), (ex, ey)], srgb('#4a2a2a'), 0.8)
            for q in range(5):
                cv.poly(np.array([(ex + r.normal(0, 4) + math.cos(t) * 2.6, ey + r.normal(0, 3) + math.sin(t) * 2.6) for t in np.linspace(0, 6.28, 7)]),
                        srgb('#140f16') * r.uniform(0.7, 1.2), 1.0)
    for k in range(sp.get('hips', 0)):             # dog rose hips: glossy red ovals
        b = pts_all[r.integers(len(pts_all))]; x, y = b[0] + r.normal(0, 60), b[1] + r.normal(0, 50)
        a = r.uniform(0, 6.28)
        cv.poly(place(leaf_shape(10, 3.6, 'oval', 10), x, y, a), srgb('#a8241a') * r.uniform(0.8, 1.15), 1.0)
    C, A, H = cv.out()
    # depth darkening towards the bottom of the cluster (self-shadow) and a soft vignette in alpha
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    C = C * (0.85 + 0.15 * (1 - yy / h))[..., None]
    A = np.maximum(ellipse_mask(A, seed, 0.53, 0.52, rag_amt=0.0), A * (np.abs(xx - w / 2) < w * 0.03) * (yy > h * 0.8))   # keep the twig stub
    return C, A, H


def far_clump(name, w, h, seed):
    """Dense, rounded leaf mass for far-LOD cards: ragged outline, leaves of the species, darker underside/core."""
    sp = SPECIES[name]; cv = Canvas(w, h, seed); r = cv.r
    cx, cy = w / 2, h * 0.5
    nb = 7   # outline = union of a few lobes
    lobes = [(cx + r.normal(0, w * 0.12), cy + r.normal(0, h * 0.1), r.uniform(0.22, 0.32) * w) for _ in range(nb)]
    lobes.append((cx, cy, 0.3 * w))
    def inside(x, y):
        return max(1 - ((x - lx) ** 2 + (y - ly) ** 2) / (lr * lr) for lx, ly, lr in lobes)
    sparse = sp.get('sparse', False)
    scale = 0.55 if name in ('oak', 'walnut', 'poplar', 'elder') else 0.8
    leaf_area = 0.45 * sp['L'] * sp['W'] * scale * scale
    n = int(0.3 * w * h / leaf_area * (1.2 if sparse else 4.0))
    for k in range(n):
        for _t in range(30):
            x, y = r.uniform(4, w - 4), r.uniform(4, h - 4)
            v = inside(x, y)
            if v > 0 and r.random() < (0.35 if sparse else 1.0):
                break
        depth = k / n
        lit = np.clip(0.5 + 0.4 * depth + 0.2 * (cy - y) / h - 0.12 * (x - cx) / w, 0.38, 1.0) * 0.92
        col = pick(r, sp['pal']) * lit * r.uniform(0.9, 1.08)
        L, W = sp['L'] * scale * r.uniform(0.8, 1.2), sp['W'] * scale * r.uniform(0.8, 1.2)
        P = place(leaf_shape(L, W / 2, sp['kind'], n=8), x, y, r.uniform(0, 2 * np.pi))
        cv.poly(P, col, r.uniform(0.6, 1.0))
    C, A, H = cv.out()
    return C, ellipse_mask(A, seed, 0.5, 0.5, rag_amt=1.6), H


def ellipse_mask(A, seed, rx=0.47, ry=0.46, cy=0.5, rag_amt=1.0):
    """Fade alpha out towards a ragged ellipse so nothing is clipped by the straight cell border."""
    h, w = A.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ang = np.arctan2(yy / h - cy, xx / w - 0.5)
    r_ = rng(seed + 77); ph = r_.uniform(0, 6.28, 4)
    rag = 1 + rag_amt * 0.09 * np.sin(ang * 3 + ph[0]) + rag_amt * (0.07 * np.sin(ang * 5 + ph[1]) + 0.05 * np.sin(ang * 9 + ph[2]) + 0.03 * np.sin(ang * 17 + ph[3]))
    e = np.sqrt(((xx / w - 0.5) / rx) ** 2 + ((yy / h - cy) / ry) ** 2) / rag
    return A * np.clip((1 - e) / 0.04, 0, 1)


def spray(name, w, h, seed):
    """Wide, flat twig spray (outer-crown card, 2:1): a branchlet running across with leaves on both sides."""
    sp = SPECIES[name]; cv = Canvas(w, h, seed); r = cv.r
    main = [(w * 0.02, h * 0.62)]
    for k in range(10):
        x, y = main[-1]
        main.append((x + w * 0.096, np.clip(y + r.normal(0, 6) - h * 0.012, h * 0.3, h * 0.75)))
    twigs = [main]
    for k in range(8):
        i = r.integers(1, 9); bx, by = main[i]; s = -1 if k % 2 else 1
        pts = [(bx, by)]; a = -0.15 + s * r.uniform(0.4, 0.9)
        for j in range(4):
            a += r.normal(0, 0.12); L = r.uniform(0.18, 0.3) * w / 4
            pts.append((pts[-1][0] + math.cos(a) * L, pts[-1][1] + math.sin(a) * L))
        twigs.append(pts)
    tcol = srgb(sp['twig'])
    for t in twigs:
        cv.taper(t, 4.5 if t is main else 3.0, 1.2, tcol, 0.6)
    pts_all = np.concatenate([np.asarray(t) for t in twigs])
    nleaf = int(sp['n'] * (0.35 if sp.get('pairs') else 0.55))
    for k in range(nleaf):
        for _t in range(20):
            b = pts_all[r.integers(len(pts_all))]
            bx, by = b[0] + r.normal(0, 26), b[1] + r.normal(0, 22)
            if ((bx - w / 2) / (w * 0.47)) ** 2 + ((by - h / 2) / (h * 0.44)) ** 2 < 1:
                break
        depth = k / nleaf
        col = pick(r, sp['pal']) * (0.66 + 0.34 * depth + r.normal(0, 0.05))
        ang = r.uniform(0, 2 * np.pi) if not sp.get('up') else -math.pi / 2 + r.normal(0, 0.8)
        if sp.get('pairs'):
            npair = r.integers(sp['pairs'][0], sp['pairs'][1] + 1)
            L, W = sp['L'] * r.uniform(0.75, 1.0), sp['W'] * r.uniform(0.75, 1.0)
            rl = L * sp['rachis'] * (npair + 0.7)
            ex, ey = bx + math.cos(ang) * rl, by + math.sin(ang) * rl
            cv.line([(bx, by), (ex, ey)], col * 0.75, 1.3, 0.8)
            for j in range(npair + 1):
                t = (j + 0.6) / (npair + 0.7)
                px, py = bx + (ex - bx) * t, by + (ey - by) * t
                if j == npair:
                    cv.poly(place(leaf_shape(L, W / 2, sp['kind'], serr=sp.get('serr', 0)), ex, ey, ang), col, r.uniform(0.6, 1.0)); continue
                for s2 in (-1, 1):
                    P = place(leaf_shape(L, W / 2, sp['kind'], serr=sp.get('serr', 0)), px, py, ang + s2 * math.radians(r.uniform(55, 80)), curl=r.uniform(0, 0.3))
                    cv.poly(P, col * r.uniform(0.88, 1.12), r.uniform(0.6, 1.0))
        else:
            L, W = sp['L'] * r.uniform(0.8, 1.2), sp['W'] * r.uniform(0.8, 1.2)
            cv.poly(place(leaf_shape(L, W / 2, sp['kind'], serr=sp.get('serr', 0)), bx, by, ang, curl=r.uniform(0, 0.4)), col, r.uniform(0.6, 1.0))
            cv.line([(bx, by), (bx + math.cos(ang) * L * 0.85, by + math.sin(ang) * L * 0.85)], col * 1.25, 1, 1.0)
    C, A, H = cv.out()
    return C, ellipse_mask(A, seed, 0.5, 0.49, rag_amt=0.3), H


# ------------------------------------------------------------------ crops / weeds
def sf_stalk(w, h, seed):
    """Dead sunflower stalk: tall, ribbed, dark grey-brown, with shrivelled black leaves hanging from petioles."""
    cv = Canvas(w, h, seed); r = cv.r
    xs = w / 2 + np.cumsum(r.normal(0, 0.6, 12)); ys = np.linspace(h * 0.995, h * 0.01, 12)
    pts = np.stack([xs, ys], -1)
    cv.taper(pts, 13, 8, srgb('#4a3d2e'), 0.8)
    cv.line(pts + [-2, 0], srgb('#6a5a44'), 1.5, 0.9)
    for k in range(7):
        t = r.uniform(0.25, 0.92); i = int(t * 11)
        y = ys[i]; x = xs[i]; s = -1 if k % 2 else 1
        tip = (x + s * r.uniform(14, 30), y + r.uniform(4, 30))
        cv.line([(x, y), (x + s * 8, y - 6), tip], srgb('#3a2e22'), 2.0, 0.7)
        L = r.uniform(40, 80)
        P = place(leaf_shape(L, r.uniform(8, 16), 'heart', 12), tip[0], tip[1], math.pi / 2 + s * r.uniform(0.1, 0.5), curl=r.uniform(0.3, 0.7))
        cv.poly(P, srgb('#2e241a') * r.uniform(0.7, 1.3), 0.8)
        cv.line([tip, (tip[0] + s * 3, tip[1] + L * 0.8)], srgb('#4e3e2c'), 1, 0.9)
    return cv.out()


def sf_head(w, h, seed, back=False):
    cv = Canvas(w, h, seed); r = cv.r
    cx, cy, R = w / 2, h / 2, w * 0.48
    ring = np.array([(cx + math.cos(a) * R * (1 + 0.06 * math.sin(a * 13)), cy + math.sin(a) * R * (1 + 0.06 * math.sin(a * 13))) for a in np.linspace(0, 2 * np.pi, 40, endpoint=False)])
    if not back:
        cv.poly(ring, srgb('#3e3020'), 0.6)                          # withered bracts / petal remains
        for k in range(26):
            a = r.uniform(0, 6.28)
            P = place(leaf_shape(R * 0.35, 3, 'lanceolate', 8), cx + math.cos(a) * R * 0.72, cy + math.sin(a) * R * 0.72, a, curl=0.3)
            cv.poly(P, srgb('#5a4630') * r.uniform(0.7, 1.2), 0.7)
        disc = ring * 0.0 + (ring - [cx, cy]) * 0.74 + [cx, cy]
        cv.poly(disc, srgb('#1f1913'), 1.0)
        # seed spiral (fibonacci phyllotaxis)
        for i in range(260):
            rad = R * 0.72 * math.sqrt(i / 260); a = i * 2.39996
            x, y = cx + math.cos(a) * rad, cy + math.sin(a) * rad
            cv.poly(np.array([(x + math.cos(t) * 1.6, y + math.sin(t) * 1.6) for t in np.linspace(0, 6.28, 6)]), srgb('#3a3226') * r.uniform(0.7, 1.4), 1.2)
    else:
        cv.poly(ring, srgb('#3a3122'), 0.6)
        for k in range(40):
            a = r.uniform(0, 6.28); rr = r.uniform(0.3, 0.9) * R
            P = place(leaf_shape(R * 0.4, 5, 'ovate', 8), cx + math.cos(a) * rr * 0.5, cy + math.sin(a) * rr * 0.5, a)
            cv.poly(P, srgb('#4c4430') * r.uniform(0.6, 1.2), 0.8)
        cv.poly(np.array([(cx + math.cos(t) * 8, cy + math.sin(t) * 8) for t in np.linspace(0, 6.28, 10)]), srgb('#3a2e22'), 1.0)
    return cv.out()


def dry_leaf(w, h, seed, kind='sf'):
    cv = Canvas(w, h, seed); r = cv.r
    if kind == 'sf':     # sunflower leaf hanging, shrivelled
        P = place(leaf_shape(h * 0.92, w * 0.32, 'heart', 16), w / 2, h * 0.04, math.pi / 2, curl=0.45)
        cv.poly(P, srgb('#3a2c1e'), 0.8)
        cv.line([(w / 2, h * 0.04), (w / 2 + 2, h * 0.9)], srgb('#5a4a36'), 1.5, 1.0)
        for k in range(5):
            y = h * (0.15 + k * 0.15)
            for s in (-1, 1):
                cv.line([(w / 2, y), (w / 2 + s * w * 0.22, y + 16)], srgb('#4e3e2c'), 1, 1.0)
        for k in range(8):
            cv.poly(np.array([(r.uniform(w * 0.3, w * 0.7) + math.cos(t) * 5, r.uniform(h * 0.2, h * 0.8) + math.sin(t) * 4) for t in np.linspace(0, 6.28, 7)]), srgb('#22190f'), 0.7)
    elif kind == 'corn':  # long dry maize leaf
        pts = [(w * 0.1, h * 0.1)]
        for k in range(10):
            pts.append((pts[-1][0] + w * 0.08, pts[-1][1] + h * 0.07 + k * 0.3))
        P = np.array(pts)
        cv.taper(P, 12, 2, srgb('#a8946a'), 0.8, shade=False)
        cv.line(P, srgb('#c4b28a'), 1.5, 1.0)
    elif kind == 'ear':   # maize ear in a dry husk, hanging
        P = place(leaf_shape(h * 0.85, w * 0.17, 'ovate', 14), w / 2, h * 0.06, math.pi / 2)
        cv.poly(P, srgb('#9a8660'), 0.9)
        for k in range(4):
            Q = place(leaf_shape(h * 0.8, w * 0.07, 'lanceolate', 10), w / 2 + r.normal(0, 6), h * 0.08, math.pi / 2 + r.normal(0, 0.12))
            cv.poly(Q, srgb('#b5a47a') * r.uniform(0.85, 1.1), 1.0)
        cv.line([(w / 2, h * 0.88), (w / 2 + 5, h * 0.99)], srgb('#4a3a24'), 3, 1.0)
    return cv.out()


def corn_stalk(w, h, seed):
    """Dry maize stalk with drooping, shredded leaves (bleached tan-grey)."""
    cv = Canvas(w, h, seed); r = cv.r
    xs = w / 2 + np.cumsum(r.normal(0, 0.5, 12)); ys = np.linspace(h * 0.995, h * 0.02, 12)
    pts = np.stack([xs, ys], -1)
    cv.taper(pts, 9, 4, srgb('#8f7f60'), 0.8)
    for k in range(4, 12, 2):   # nodes
        cv.line([(xs[k] - 5, ys[k]), (xs[k] + 5, ys[k])], srgb('#6a5a3e'), 2, 1.0)
    for k in range(9):
        t = 0.15 + k * 0.09; i = min(11, int(t * 11)); x, y = xs[i], ys[i]
        s = -1 if k % 2 else 1
        L = r.uniform(0.5, 0.9) * w * 0.9
        a = -math.pi / 2 + s * r.uniform(0.5, 0.9)
        lp = [(x, y)]
        for j in range(8):
            a += s * r.uniform(0.12, 0.3) * (1.4 if j < 3 else 0.7)
            a = min(a, math.pi * 0.62) if s > 0 else max(a, -math.pi * 1.62)      # arch over and droop
            lp.append((lp[-1][0] + math.cos(a) * L / 8, lp[-1][1] + math.sin(a) * L / 8))
        lp = np.array(lp); lp[:, 0] = np.clip(lp[:, 0], 3, w - 3)
        col = srgb(['#a39272', '#8f8064', '#b3a588', '#7d6f58'][k % 4]) * r.uniform(0.85, 1.1)
        cv.taper(lp, r.uniform(8, 13), 1.5, col, 0.8, shade=False)
        cv.line(lp, col * 1.15, 1, 1.0)
        if r.random() < 0.5:   # shredded strip
            cv.taper(lp[3:] + [0, 6], 3, 1, col * 0.8, 0.7, shade=False)
    if seed % 2 == 0:   # tassel remains at the top
        for k in range(5):
            cv.line([(xs[-1], ys[-1] + 6), (xs[-1] + r.normal(0, 12), ys[-1] - r.uniform(8, 20))], srgb('#8a7550'), 1.5)
    return cv.out()


def weeds(w, h, seed, kind='mix'):
    """Fallow-field weeds: ragweed / wormwood / thistle mix, dry olive-tan, ~1 m tall."""
    cv = Canvas(w, h, seed); r = cv.r
    pal = [(0.35, '#7a7044', 0.1), (0.3, '#958656', 0.1), (0.2, '#646640', 0.1), (0.15, '#5a4a30', 0.1)]
    nst = {'mix': 28, 'thistle': 4, 'ragweed': 6}[kind]
    for k in range(nst):
        x0 = w * 0.5 + r.normal(0, w * 0.12); top = h * r.uniform(0.04, 0.35)
        lean = r.normal(0, w * 0.12)
        pts = np.array([(x0 + lean * t * t, h * 0.99 - (h * 0.99 - top) * t) for t in np.linspace(0, 1, 8)])
        col = pick(r, pal)
        cv.taper(pts, 4 if kind != 'mix' else 3.5, 1.2, col * 0.8, 0.7)
        isth = (kind == 'thistle') or (kind == 'mix' and k % 4 == 0)
        for j in range(1, 7):
            px, py = pts[j] + r.normal(0, 1.5, 2); s = -1 if j % 2 else 1
            if isth:   # spiny thistle leaf
                L = r.uniform(18, 30) * (1.3 - j * 0.12); a = -math.pi / 2 + s * 1.1
                P = place(leaf_shape(L, 5, 'lobed', 14, serr=0.5), px, py, a)
                cv.poly(P, srgb('#6a6c48') * r.uniform(0.8, 1.1), 0.8)
            else:      # finely dissected ragweed / wormwood leaf
                a0 = -math.pi / 2 + s * r.uniform(0.6, 1.2)
                L = r.uniform(20, 34) * (1.3 - j * 0.1)
                ex, ey = px + math.cos(a0) * L, py + math.sin(a0) * L
                cv.line([(px, py), (ex, ey)], col, 1.2, 0.8)
                for q in range(5):
                    t = (q + 1) / 6; qx, qy = px + (ex - px) * t, py + (ey - py) * t
                    for s2 in (-1, 1):
                        a2 = a0 + s2 * 0.9
                        P = place(leaf_shape(L * 0.38 * (1.2 - t * 0.5), 2.2, 'lobed', 10, serr=0.4), qx, qy, a2)
                        cv.poly(P, col * r.uniform(0.85, 1.15), 0.8)
        # tops: thistle heads / ragweed seed spikes
        tx, ty = pts[-1]
        if isth:
            for q in range(r.integers(1, 4)):
                hx, hy = tx + r.normal(0, 6), ty + r.normal(0, 5)
                cv.poly(np.array([(hx + math.cos(t) * 5, hy + 4 + math.sin(t) * 6) for t in np.linspace(0, 6.28, 9)]), srgb('#4a3a28'), 1.0)
                for q2 in range(9):   # pappus fluff
                    a = -math.pi / 2 + r.normal(0, 0.7)
                    cv.line([(hx, hy), (hx + math.cos(a) * 9, hy + math.sin(a) * 9)], srgb('#c9c2ae'), 1.0, 1.0)
        else:
            for q in range(r.integers(3, 7)):
                a = -math.pi / 2 + r.normal(0, 0.5); L = r.uniform(12, 30)
                ex, ey = tx + math.cos(a) * L, ty + math.sin(a) * L
                cv.line([(tx, ty + 10), (ex, ey)], col * 1.1, 1.0, 0.9)
                for t in np.linspace(0.3, 1, 6):
                    qx, qy = tx + (ex - tx) * t, ty + 10 + (ey - ty - 10) * t
                    cv.poly(np.array([(qx + math.cos(u) * 1.6, qy + math.sin(u) * 1.6) for u in np.linspace(0, 6.28, 5)]), srgb('#8a7a4a') * r.uniform(0.8, 1.2), 1.0)
    if kind == 'mix':   # dry grass at the base
        for k in range(60):
            x = w * 0.5 + r.normal(0, w * 0.18); L = r.uniform(30, 90)
            a = -math.pi / 2 + r.normal(0, 0.35)
            cv.line([(x, h * 0.99), (x + math.cos(a) * L, h * 0.99 + math.sin(a) * L)], pick(r, pal) * 1.1, 1.2, 0.6)
    return cv.out()


def grass_tuft(w, h, seed):
    cv = Canvas(w, h, seed); r = cv.r
    for k in range(120):
        x = r.uniform(w * 0.05, w * 0.95); L = r.uniform(0.3, 0.95) * h
        a = -math.pi / 2 + r.normal(0, 0.3); bend = r.normal(0, 0.15)
        pts = [(x, h * 0.99)]
        for j in range(4):
            a += bend
            pts.append((pts[-1][0] + math.cos(a) * L / 4, pts[-1][1] + math.sin(a) * L / 4))
        col = srgb(['#8a7e50', '#a4935e', '#6c6a40', '#b8a874'][k % 4]) * r.uniform(0.8, 1.1)
        cv.taper(np.array(pts), 2.2, 0.6, col, 0.7, shade=False)
    return cv.out()


def wattle(w, h, seed):
    """Woven pleten: horizontal willow/hazel rods weaving in front of / behind vertical stakes; grey-brown weathered,
    some rods broken, ragged top. u = along the fence (3 m), v = up (0.94 m)."""
    cv = Canvas(w, h, seed); r = cv.r
    stakes = np.linspace(0, w, 9)[:-1] + w / 16          # 8 stakes per 3 m (periodic)
    for x in stakes:
        cv.taper(np.array([(x + r.normal(0, 1.5), h * 1.0), (x + r.normal(0, 1.5), 0)]), 13, 11, srgb('#4e4438'), 0.5)
    rod_h = 9.5
    nrows = int(h * 0.93 / rod_h)
    for j in range(nrows):
        y0 = h - 4 - j * rod_h - rod_h / 2
        if j > nrows - 3 and r.random() < 0.5:
            continue
        phase = j % 2
        xs = np.linspace(-8, w + 8, 120)
        ys = y0 + r.normal(0, 0.4) + 1.6 * np.sin((xs - stakes[0]) / (w / 8) * np.pi + phase * np.pi)
        tone = r.uniform(0.75, 1.15)
        base = srgb(['#6e6250', '#7f7260', '#5e5444', '#8a7c66'][j % 4]) * tone
        P = np.stack([xs, ys], -1)
        if r.random() < 0.08:    # broken rod: gap
            cut = r.uniform(0.1, 0.9) * w
            for seg in (P[P[:, 0] < cut - 12], P[P[:, 0] > cut + 12]):
                if len(seg) > 2:
                    cv.taper(seg, rod_h * 0.95, rod_h * 0.8, base, 1.0)
            continue
        cv.taper(P, rod_h * 0.98, rod_h * 0.9, base, 1.0)
        cv.line(P + [0, -rod_h * 0.22], base * 1.3, 1.5, 1.1)
    # ragged top: a few rod ends sticking up / out
    for k in range(10):
        x = r.uniform(0, w); y = h * 0.08 + r.uniform(0, 15)
        a = -math.pi / 2 + r.normal(0, 0.9)
        cv.line([(x, y), (x + math.cos(a) * r.uniform(15, 40), y + math.sin(a) * r.uniform(15, 40))], srgb('#6a5e4c'), 3, 0.9)
    C, A, H = cv.out()
    n = spectral(0, 1.6, seed, fmin=2, fmax=40, shape=C.shape[:2])
    C = lerp(C, srgb('#5a5a4a'), smoothstep(0.5, 1.6, n) * 0.35)     # lichen / grey weathering
    C = lerp(C, srgb('#2e281f'), smoothstep(0.6, 1.0, np.mgrid[0:C.shape[0], 0:1][0] / C.shape[0]) * 0.5)   # damp base
    return C, A, H


def film(w, h, seed):
    """Torn greenhouse polyethylene: milky, algae / dust streaks, ragged holes and hanging shreds (periodic in u)."""
    r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 2.0, seed, fmin=2, fmax=30, shape=(h, w)); f = spectral(0, 0.8, seed + 1, fmin=20, shape=(h, w))
    C = colorize(norm01(f * 0.3 + n * 0.7), [(0, '#8c918a'), (1, '#b4b8b0')])
    streak = np.clip(blur(spectral(0, 1.1, seed + 5, fmin=6, fmax=140, shape=(h, w)), (12, 1.0), True), -2, 2)
    C = lerp(C, srgb('#7d8566'), smoothstep(0.5, 1.5, streak) * 0.45)
    C = lerp(C, srgb('#8a8070'), smoothstep(h * 0.6, h, yy)[..., None] * 0.4)
    tear = spectral(0, 2.4, seed + 7, fmin=2, fmax=60, shape=(h, w)) + blur(spectral(0, 1.0, seed + 8, fmin=4, fmax=80, shape=(h, w)), (6, 0.5), True) * 0.6
    A = (tear < 0.75).astype(np.float32)
    A = blur(A, 0.6)
    H = (C.mean(-1) * 0.2 + f * 0.05).astype(np.float32)
    return C, A, H


# ------------------------------------------------------------------ build
def paint_all():
    alb = np.zeros((S, S, 3), np.float32); alpha = np.zeros((S, S), np.float32); hgt = np.zeros((S, S), np.float32)
    for i, (name, (x0, y0, x1, y1)) in enumerate(FREG.items()):
        w, h = x1 - x0, y1 - y0; seed = 7100 + i * 13
        if name.startswith('far_'):
            if name[4:] not in SPECIES:
                continue
            C, A, H = far_clump(name[4:], w, h, seed)
        elif name.startswith('spray_'):
            C, A, H = spray(name[6:], w, h, seed)
        elif name in SPECIES:
            C, A, H = cluster(name, w, h, seed)
        elif name.startswith('sf_stalk'):
            C, A, H = sf_stalk(w, h, seed)
        elif name.startswith('corn_') and name not in ('corn_ear', 'corn_leaf'):
            C, A, H = corn_stalk(w, h, seed)
        elif name == 'sf_head':
            C, A, H = sf_head(w, h, seed)
        elif name == 'sf_back':
            C, A, H = sf_head(w, h, seed, back=True)
        elif name.startswith('sf_leaf'):
            C, A, H = dry_leaf(w, h, seed, 'sf')
        elif name == 'corn_leaf':
            C, A, H = dry_leaf(w, h, seed, 'corn')
        elif name == 'corn_ear':
            C, A, H = dry_leaf(w, h, seed, 'ear')
        elif name in ('weeds', 'thistle', 'ragweed'):
            C, A, H = weeds(w, h, seed, {'weeds': 'mix', 'thistle': 'thistle', 'ragweed': 'ragweed'}[name])
        elif name == 'grass_tuft':
            C, A, H = grass_tuft(w, h, seed)
        elif name == 'wattle':
            C, A, H = wattle(w, h, seed)
        elif name == 'film':
            C, A, H = film(w, h, seed)
        # keep a 2 px transparent border so neighbours never bleed through mip filtering into each other
        A[:2] = 0; A[-2:] = 0; A[:, :2] = 0; A[:, -2:] = 0
        if name in ('wattle', 'film'):
            A[:2] = A[2:4]; A[-2:] = A[-4:-2]   # rows only (these tile along u)
            A[:, :2] = 1 * A[:, 2:4]; A[:, -2:] = A[:, -4:-2]
        alb[y0:y1, x0:x1] = C; alpha[y0:y1, x0:x1] = A; hgt[y0:y1, x0:x1] = H
    return alb, alpha, hgt


def save(alb, alpha, hgt):
    # bleed colour into transparent texels (no dark fringes under mipmapping / alpha test)
    m = alpha > 0.5
    fill = blur(alb * alpha[..., None], 6, wrap=False) / (blur(alpha, 6, wrap=False)[..., None] + 1e-4)
    fill2 = blur(alb * alpha[..., None], 24, wrap=False) / (blur(alpha, 24, wrap=False)[..., None] + 1e-4)
    fill = np.where((blur(alpha, 6, wrap=False) > 0.02)[..., None], fill, fill2)
    out = np.where(m[..., None], alb, fill)
    paths = [os.path.join(CACHE, f'farmland_foliage_{s}') for s in ('albedo.png', 'normal.png', 'orm.png')]
    Image.fromarray(to8(np.concatenate([np.clip(out, 0, 1), alpha[..., None]], -1)), 'RGBA').save(paths[0], optimize=True)
    nrm = normal_from_height(blur(hgt, 0.8, wrap=False) * 3, 0.8, wrap=False)
    Image.fromarray(quantize_normal(nrm, 6)).save(paths[1], optimize=True)
    ao = np.clip(0.55 + 0.45 * np.clip(hgt, 0, 1), 0, 1)
    orm = np.stack([ao, np.full_like(ao, 0.95), np.zeros_like(ao)], -1)
    Image.fromarray(quantize_normal(to8(orm), 6)).save(paths[2], optimize=True)
    return paths


def cache_paths():
    return [os.path.join(CACHE, f'farmland_foliage_{s}') for s in ('albedo.png', 'normal.png', 'orm.png')]


def base_path():
    return os.path.join(CACHE, 'farmland_foliage_base.npz')


def build_base():
    """Paint everything except impostors; store raw layers so impostors can be pasted later."""
    alb, alpha, hgt = paint_all()
    np.savez_compressed(base_path(), alb=alb.astype(np.float16), alpha=alpha.astype(np.float16), hgt=hgt.astype(np.float16))
    return alb, alpha, hgt


def load_base():
    d = np.load(base_path())
    return d['alb'].astype(np.float32), d['alpha'].astype(np.float32), d['hgt'].astype(np.float32)


if __name__ == '__main__':
    import time; t0 = time.time()
    a, al, hh = build_base()
    print(save(a, al, hh), time.time() - t0)
