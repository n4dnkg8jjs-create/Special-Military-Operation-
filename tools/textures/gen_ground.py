# Ground texture sets for the terrain splat shader (ground look v6), all generated here from noise -- no third-party
# images (ASSETS_SPEC: self-made content only).  Every map tiles seamlessly (periodic FFT noise, periodic Voronoi,
# wrapped strokes).
#
#   assets/textures/ground/<name>_c.jpg   albedo, sRGB, 1024^2 (cavity AO baked in lightly)
#   assets/textures/ground/<name>_n.png   RGBA 512^2, linear: R,G = surface slope along +u / +v (tangent normal x / y,
#                                         0.5 = flat), B = height (0..1, used for height-blending between materials),
#                                         A = roughness
#
# Normal convention: n = normalize(vec3(2R-1, 1, 2G-1)) in WORLD space for a ground sampled at uv = (x, z) / tile
# (three.js flipY: image row 0 is the top = v 1, so +v / +z runs UP the image).  The ground shader (src/world/ground.js)
# decodes it that way; it is NOT a standard tangent-space normal map.
#
# usage: python3 tools/textures/gen_ground.py [names...]
import sys, os
import numpy as np
from PIL import Image, ImageDraw
from scipy.spatial import cKDTree
from scipy.ndimage import gaussian_filter

N = 1024
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'textures', 'ground')


def rng(seed): return np.random.default_rng(seed)


def fnoise(n, f0, f1, seed, beta=1.0):
    """periodic band-limited fractal noise, frequencies f0..f1 cycles per tile, amplitude ~ f^-beta, -> 0..1"""
    r = rng(seed)
    fx = np.fft.fftfreq(n) * n
    F = np.sqrt(fx[None, :] ** 2 + fx[:, None] ** 2)
    amp = np.where((F >= f0) & (F <= f1), 1.0 / np.maximum(F, 1e-6) ** beta, 0.0)
    ph = np.exp(2j * np.pi * r.random((n, n)))
    img = np.real(np.fft.ifft2(amp * ph))
    img -= img.min(); img /= img.max()
    return img


def stretch(a, lo=0.02, hi=0.98):
    a0, a1 = np.quantile(a, lo), np.quantile(a, hi)
    return np.clip((a - a0) / (a1 - a0 + 1e-9), 0, 1)


def voronoi(n, count, seed, warp=0.0):
    """periodic F1, F2 (pixels) and cell id; warp = domain-warp amplitude (pixels) so cells are lumpy, not tiles"""
    r = rng(seed)
    pts = r.random((count, 2)) * n
    t = cKDTree(pts, boxsize=n)
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    if warp:
        xx = xx + (fnoise(n, 3, 40, seed + 91, 1.0) - 0.5) * warp
        yy = yy + (fnoise(n, 3, 40, seed + 92, 1.0) - 0.5) * warp
    q = np.stack([xx.ravel() + 0.5, yy.ravel() + 0.5], 1) % n
    d, i = t.query(q, k=2)
    return d[:, 0].reshape(n, n), d[:, 1].reshape(n, n), i[:, 0].reshape(n, n)


def smooth(a, s): return gaussian_filter(a, s, mode='wrap')


def lerp(a, b, t): return a + (b - a) * t


def col(c): return np.array(c, dtype=np.float32)


def mixc(base, c, t):
    t = t[..., None] if np.ndim(t) == 2 else t
    return base * (1 - t) + np.asarray(c) * t


class Canvas:
    """wrapped stroke painter: colour (RGB float) + height (float), painter's order"""
    def __init__(self, n, rgb, h):
        self.n = n
        self.c = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8), 'RGB')
        self.h = Image.fromarray((np.clip(h, 0, 1) * 65535 / 256).astype(np.int32), 'I')  # 0..255.99 in 'I'
        self.dc, self.dh = ImageDraw.Draw(self.c), ImageDraw.Draw(self.h)

    def line(self, pts, w, rgb, h):
        n = self.n
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        offs_x = [0] + ([n] if min(xs) < w else []) + ([-n] if max(xs) > n - w else [])
        offs_y = [0] + ([n] if min(ys) < w else []) + ([-n] if max(ys) > n - w else [])
        c = tuple(int(np.clip(v, 0, 1) * 255) for v in rgb); hv = int(np.clip(h, 0, 1) * 255)
        for ox in offs_x:
            for oy in offs_y:
                p = [(x + ox, y + oy) for x, y in pts]
                self.dc.line(p, fill=c, width=max(1, int(round(w))))
                self.dh.line(p, fill=hv, width=max(1, int(round(w))))

    def ellipse(self, x, y, rx, ry, rgb, h):
        n = self.n
        c = tuple(int(np.clip(v, 0, 1) * 255) for v in rgb); hv = int(np.clip(h, 0, 1) * 255)
        for ox in (0, n, -n):
            for oy in (0, n, -n):
                if ox and not (x + ox - rx < n and x + ox + rx > 0): continue
                if oy and not (y + oy - ry < n and y + oy + ry > 0): continue
                bb = [x + ox - rx, y + oy - ry, x + ox + rx, y + oy + ry]
                self.dc.ellipse(bb, fill=c); self.dh.ellipse(bb, fill=hv)

    def poly(self, pts, rgb, h):
        n = self.n
        c = tuple(int(np.clip(v, 0, 1) * 255) for v in rgb); hv = int(np.clip(h, 0, 1) * 255)
        for ox in (0, n, -n):
            for oy in (0, n, -n):
                p = [(x + ox, y + oy) for x, y in pts]
                if max(q[0] for q in p) < 0 or min(q[0] for q in p) > n or max(q[1] for q in p) < 0 or min(q[1] for q in p) > n: continue
                self.dc.polygon(p, fill=c); self.dh.polygon(p, fill=hv)

    def get(self):
        return np.asarray(self.c).astype(np.float32) / 255, np.asarray(self.h).astype(np.float32) / 255


def blades(cv, r, count, length, width, colfn, hfn, dens=None, angle=None, droop=0.35):
    """grass / weed blades: short tapered strokes, random lean, painted bottom -> top"""
    n = cv.n
    xs, ys = r.random(count) * n, r.random(count) * n
    if dens is not None:
        keep = r.random(count) < dens[ys.astype(int) % n, xs.astype(int) % n]
        xs, ys = xs[keep], ys[keep]
    order = np.argsort(r.random(len(xs)))
    for i in order:
        x, y = xs[i], ys[i]
        a = r.random() * 2 * np.pi if angle is None else angle + r.normal() * 0.35
        L = length * (0.5 + r.random())
        bend = (r.random() - 0.5) * droop
        p = [(x, y)]
        for s in (0.5, 1.0):
            aa = a + bend * s * 2
            p.append((p[-1][0] + np.cos(aa) * L * 0.5, p[-1][1] + np.sin(aa) * L * 0.5))
        t = r.random()
        cv.line(p, width * (0.7 + 0.6 * r.random()), colfn(t, x, y), hfn(t, x, y))


# brightness match: the grade was tuned on the old sets' final ground colours (old ground shader output)
GAIN = {'dirt': 1.15, 'grass': 1.32, 'fallow': 1.25, 'stubble': 1.12, 'rubble': 1.3, 'plowed': 1.0, 'mud': 1.0}


def finish(name, alb, h, rough, nstr, ao_amt=0.35, n_out=512):
    """normals from height (wrapped central differences), cavity AO into the albedo, write the pair"""
    os.makedirs(OUT, exist_ok=True)
    h = np.clip(h, 0, 1).astype(np.float32)
    # cavity: darker in the crevices between clods / blades
    cav = np.clip((smooth(h, 6) - h) * 4.0, 0, 1)
    alb = alb * (1 - ao_amt * cav)[..., None] * (1 - 0.12 * ao_amt * (1 - smooth(h, 20)))[..., None]
    alb = alb * GAIN.get(name, 1.0)
    Image.fromarray((np.clip(alb, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB').save(os.path.join(OUT, name + '_c.jpg'), quality=90)
    hs = smooth(h, 0.7)
    dx = (np.roll(hs, -1, 1) - np.roll(hs, 1, 1)) * 0.5   # +u (columns)
    dv = -(np.roll(hs, -1, 0) - np.roll(hs, 1, 0)) * 0.5  # +v runs up the image
    nx, nz = -dx * nstr, -dv * nstr
    L = np.sqrt(nx * nx + nz * nz + 1)
    nx, nz = nx / L, nz / L
    rgba = np.stack([nx * 0.5 + 0.5, nz * 0.5 + 0.5, h, np.clip(np.broadcast_to(rough, h.shape), 0.35, 1)], -1)
    im = Image.fromarray((np.clip(rgba, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGBA')
    if n_out != N: im = im.resize((n_out, n_out), Image.LANCZOS)
    im.save(os.path.join(OUT, name + '_n.png'), optimize=True)
    print(name, 'albedo mean', alb.reshape(-1, 3).mean(0).round(3), 'h', round(float(h.mean()), 3), 'rough', round(float(np.mean(rough)), 3))


# ---------------------------------------------------------------- soil base shared by several sets
def soil(seed, dry=1.0):
    r = rng(seed)
    lo = fnoise(N, 2, 12, seed + 1, 1.2)
    md = fnoise(N, 10, 60, seed + 2, 1.0)
    hi = fnoise(N, 50, 300, seed + 3, 0.6)
    F1, F2, cid = voronoi(N, 2600, seed + 4, warp=26)
    crk = stretch(fnoise(N, 2, 10, seed + 6, 1.0))         # cracks only in patches (dried crust), elsewhere crumbly
    clod = 1 - (1 - np.clip((F2 - F1) / 14.0, 0, 1) ** 0.7) * (0.25 + 0.75 * np.clip((crk - 0.45) * 2.5, 0, 1))
    dome = np.clip(1 - F1 / 22.0, 0, 1) ** 0.8            # each clod a soft dome
    cr = rng(seed + 5).random(2600)[cid]                   # per-clod random
    h = 0.18 * clod + 0.14 * dome * (0.5 + cr) + 0.26 * md + 0.2 * lo + 0.16 * hi + 0.06 * cr
    h = stretch(h)
    dark, light = col([0.235, 0.205, 0.17]), col([0.43, 0.385, 0.32])   # chernozem / dusty loess crust
    t = np.clip(0.25 + 0.55 * stretch(lo * 0.5 + md * 0.3 + cr * 0.2) * dry + 0.25 * (h - 0.5), 0, 1)
    alb = lerp(dark, light, t[..., None])
    alb *= (0.88 + 0.24 * hi)[..., None]
    return alb, h, lo, md, hi, clod, r


def pebbles(cv, r, count, size, palette, hbase=0.75):
    n = cv.n
    for _ in range(count):
        x, y = r.random() * n, r.random() * n
        s = size * (0.4 + r.random() ** 2 * 1.6)
        k = r.integers(5, 8); a0 = r.random() * 6.28
        pts = [(x + np.cos(a0 + j / k * 6.28) * s * (0.6 + 0.4 * r.random()), y + np.sin(a0 + j / k * 6.28) * s * (0.55 + 0.45 * r.random())) for j in range(k)]
        c = np.array(palette[r.integers(len(palette))]) * (0.8 + 0.35 * r.random())
        cv.poly(pts, c, min(1, hbase + 0.2 * r.random()))


# ---------------------------------------------------------------- sets
def dirt():
    alb, h, lo, md, hi, clod, r = soil(101)
    # dried straw / chaff bits and a few pale pebbles
    cv = Canvas(N, alb, h)
    pebbles(cv, r, 900, 2.6, [[0.5, 0.47, 0.42], [0.42, 0.4, 0.36], [0.55, 0.5, 0.42]], 0.72)
    blades(cv, r, 1600, 9, 1.2, lambda t, x, y: lerp(col([0.42, 0.37, 0.27]), col([0.6, 0.54, 0.4]), t), lambda t, x, y: 0.62 + 0.15 * t)
    a, hh = cv.get()
    h = np.maximum(h, hh * (hh > 0.6))
    rough = 0.93 - 0.06 * (1 - lo)
    finish('dirt', a, h, rough, 9.0)


def mud():
    # wet, kneaded chernozem: smeared tyre / boot prints, glossy water films in the low spots
    r = rng(202)
    lo = fnoise(N, 2, 10, 203, 1.3)
    md = fnoise(N, 8, 50, 204, 1.0)
    hi = fnoise(N, 40, 260, 205, 0.7)
    # smeared streaks: anisotropic noise (stretched along one diagonal, wrapped)
    st = fnoise(N, 6, 90, 206, 0.8)
    st = smooth(st, 1.5)
    sm = np.roll(st, 3, 1) * 0.5 + st * 0.5
    h = stretch(0.4 * lo + 0.25 * md + 0.2 * sm + 0.15 * hi)
    # smeared tyre / track scuffs: soft pressed-in lanes (a blurred stroke mask, not hard cuts)
    cv = Canvas(N, np.zeros((N, N, 3)), np.zeros((N, N)))
    for _ in range(45):
        x, y, a = r.random() * N, r.random() * N, r.random() * 6.28
        L = 80 + r.random() * 200
        cv.line([(x, y), (x + np.cos(a) * L, y + np.sin(a) * L)], 14 + r.random() * 18, [0, 0, 0], 0.6 + 0.4 * r.random())
    _, dent = cv.get()
    h = h - 0.16 * smooth(dent, 5)
    h = stretch(h)
    wet = np.clip((0.42 - h) / 0.2, 0, 1)                  # water films in the lows
    alb = lerp(col([0.16, 0.135, 0.11]), col([0.28, 0.245, 0.2]), np.clip(h * 0.7 + 0.2 * hi + 0.05, 0, 1)[..., None])
    alb = mixc(alb, [0.3, 0.27, 0.22], np.clip((h - 0.75) * 3, 0, 1) * 0.6 * lo)   # drying crust on the tops
    alb = mixc(alb, alb * 0.82, wet)
    rough = 0.82 - 0.38 * wet - 0.12 * (1 - h)
    finish('mud', alb, h, rough, 7.0, ao_amt=0.25)


def grass():
    # late-autumn steppe sward: dead straw, grey-green wormwood, some olive regrowth, soil showing between tussocks
    salb, sh, lo, md, hi, clod, r = soil(301, dry=0.8)
    tuft = stretch(fnoise(N, 6, 40, 302, 1.0))
    patch = stretch(fnoise(N, 2, 8, 303, 1.2))
    dens = np.clip(0.35 + 0.9 * (tuft - 0.35), 0.05, 1.0)
    cv = Canvas(N, salb * 0.8, sh * 0.2)
    def gcol(t, x, y):
        p = patch[int(y) % N, int(x) % N]
        straw = lerp(col([0.44, 0.4, 0.28]), col([0.6, 0.55, 0.4]), t)
        olive = lerp(col([0.3, 0.32, 0.19]), col([0.46, 0.47, 0.29]), t)
        grey = lerp(col([0.4, 0.41, 0.35]), col([0.55, 0.56, 0.49]), t)
        c = lerp(straw, olive, 0.4 + 0.5 * p) if r.random() > 0.2 else grey
        return c * (0.75 + 0.35 * t)
    # dead thatch mat underneath (dark grey-brown, matted)
    blades(cv, r, 30000, 14, 1.6, lambda t, x, y: lerp(col([0.27, 0.26, 0.17]), col([0.4, 0.38, 0.25]), t), lambda t, x, y: 0.25 + 0.2 * t, dens=np.clip(dens + 0.45, 0, 1), droop=0.4)
    blades(cv, r, 60000, 15, 1.7, gcol, lambda t, x, y: 0.45 + 0.5 * t * (0.6 + 0.4 * tuft[int(y) % N, int(x) % N]), dens=dens, droop=0.6)
    # second pass: longer lodged straw lying flat
    blades(cv, r, 2500, 34, 1.6, lambda t, x, y: lerp(col([0.48, 0.43, 0.31]), col([0.64, 0.58, 0.43]), t), lambda t, x, y: 0.55 + 0.35 * t, dens=dens, droop=0.25)
    a, h = cv.get()
    a = a * (0.9 + 0.2 * hi)[..., None]
    h = stretch(smooth(h, 0.6) * 0.8 + 0.2 * tuft)
    finish('grass', a, h, 0.95 - 0.04 * hi, 6.0, ao_amt=0.45)


def fallow():
    # weedy fallow: bare dusty soil with sparse dead weeds, thistle / wormwood clumps, a few lodged stems
    salb, sh, lo, md, hi, clod, r = soil(401, dry=1.0)
    patch = stretch(fnoise(N, 3, 16, 402, 1.1))
    dens = np.clip((patch - 0.3) * 1.6, 0.0, 1.0) ** 1.3
    cv = Canvas(N, salb, sh * 0.5)
    blades(cv, r, 15000, 16, 1.8, lambda t, x, y: lerp(col([0.42, 0.38, 0.28]), col([0.6, 0.55, 0.41]), t) if r.random() > 0.25 else lerp(col([0.38, 0.4, 0.34]), col([0.52, 0.54, 0.46]), t), lambda t, x, y: 0.5 + 0.45 * t, dens=dens, droop=0.7)
    # rosettes of dead weeds (darker brown stars)
    for _ in range(260):
        x, y = r.random() * N, r.random() * N
        if r.random() > dens[int(y) % N, int(x) % N] + 0.15: continue
        c = col([0.27, 0.22, 0.16]) * (0.8 + 0.5 * r.random())
        for k in range(r.integers(5, 9)):
            a = r.random() * 6.28; L = 10 + r.random() * 16
            cv.line([(x, y), (x + np.cos(a) * L, y + np.sin(a) * L)], 3, c, 0.75)
    a, h = cv.get()
    h = stretch(smooth(h, 0.6))
    finish('fallow', a, h, 0.94, 7.0, ao_amt=0.4)


def plowed():
    # autumn ploughing: furrow slices along v (8 per tile = 0.5 m at 4 m), big shiny-cut clods, dark chernozem
    r = rng(501)
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32)
    wob = (fnoise(N, 1, 6, 502, 1.2) - 0.5) * 30
    u = (xx + wob) / N * 8
    ph = u - np.floor(u)
    # asymmetric furrow profile: the mouldboard throws the slice over to one side
    prof = np.where(ph < 0.62, np.sin(ph / 0.62 * np.pi / 2), np.cos((ph - 0.62) / 0.38 * np.pi / 2))
    F1, F2, cid = voronoi(N, 3200, 503, warp=22)
    clod = np.clip((F2 - F1) / 12.0, 0, 1) ** 0.6 * 0.6 + 0.4 * np.clip(1 - F1 / 20.0, 0, 1)
    cr = rng(504).random(3200)[cid]
    md = fnoise(N, 10, 80, 505, 0.9); hi = fnoise(N, 60, 300, 506, 0.6); lo = fnoise(N, 2, 10, 507, 1.2)
    h = stretch(0.5 * prof + 0.25 * clod * (0.6 + 0.4 * cr) + 0.12 * md + 0.06 * hi + 0.07 * lo)
    alb = lerp(col([0.12, 0.1, 0.085]), col([0.3, 0.26, 0.21]), np.clip(0.15 + 0.7 * h + 0.25 * (cr - 0.5) * clod, 0, 1)[..., None])
    alb = mixc(alb, [0.36, 0.32, 0.26], np.clip((h - 0.72) * 3.5, 0, 1) * (0.4 + 0.6 * lo))   # dried crests
    alb *= (0.9 + 0.2 * hi)[..., None]
    cv = Canvas(N, alb, h)
    blades(cv, r, 700, 14, 1.4, lambda t, x, y: lerp(col([0.38, 0.33, 0.23]), col([0.55, 0.49, 0.35]), t), lambda t, x, y: 0.7 + 0.2 * t, droop=0.5)   # buried stubble poking out
    a, h2 = cv.get()
    finish('plowed', a, np.maximum(h, h2 * (h2 > 0.68)), 0.9 - 0.08 * (1 - h), 10.0, ao_amt=0.5)


def stubble():
    # harvested wheat: stubble rows along v (24 per tile = 0.17 m), straw litter, weeds coming up, pale dusty soil
    salb, sh, lo, md, hi, clod, r = soil(601, dry=1.2)
    salb = salb * 1.05 + 0.02
    cv = Canvas(N, salb, sh * 0.35)
    # flat straw litter (chopped by the combine), random directions
    blades(cv, r, 9000, 22, 1.6, lambda t, x, y: lerp(col([0.55, 0.49, 0.36]), col([0.73, 0.66, 0.5]), t), lambda t, x, y: 0.42 + 0.2 * t, droop=0.15)
    # stubble stalks: short stubs in the rows, seen from above as bright dots with a dark shadowed tip
    rows = 24
    for i in range(rows):
        x0 = (i + 0.5) / rows * N
        y = r.random() * 6
        while y < N:
            x = x0 + r.normal() * 3.0
            c = lerp(col([0.6, 0.53, 0.38]), col([0.8, 0.73, 0.56]), r.random())
            cv.ellipse(x, y, 2.2, 2.2, c, 0.92 + 0.08 * r.random())
            y += 4 + r.random() * 6
    # green weed seedlings / volunteer wheat
    blades(cv, r, 900, 10, 2.0, lambda t, x, y: lerp(col([0.28, 0.32, 0.18]), col([0.42, 0.45, 0.27]), t), lambda t, x, y: 0.6 + 0.2 * t, droop=0.8)
    a, h = cv.get()
    finish('stubble', a, stretch(smooth(h, 0.5)), 0.94, 6.0, ao_amt=0.45)


def rubble():
    # town ground: compacted grey-brown dust, gravel, brick / concrete / tile crumbs, glass glints damped
    salb, sh, lo, md, hi, clod, r = soil(701, dry=1.3)
    g = np.mean(salb, -1, keepdims=True)
    base = lerp(salb, g * col([1.04, 1.0, 0.95]), 0.55) * 1.05
    cv = Canvas(N, base, sh * 0.45)
    pebbles(cv, r, 6000, 2.6, [[0.44, 0.43, 0.41], [0.5, 0.49, 0.46], [0.36, 0.35, 0.33], [0.55, 0.52, 0.47]], 0.6)
    pebbles(cv, r, 700, 6.0, [[0.6, 0.58, 0.54], [0.5, 0.49, 0.47], [0.46, 0.3, 0.24], [0.52, 0.36, 0.28]], 0.75)   # concrete / brick chunks
    pebbles(cv, r, 120, 13.0, [[0.58, 0.56, 0.52], [0.48, 0.32, 0.25]], 0.85)
    a, h = cv.get()
    h = stretch(smooth(h, 0.6))
    finish('rubble', a, h, 0.9, 8.0, ao_amt=0.5)


SETS = {'dirt': dirt, 'mud': mud, 'grass': grass, 'fallow': fallow, 'plowed': plowed, 'stubble': stubble, 'rubble': rubble}
if __name__ == '__main__':
    for k in (sys.argv[1:] or SETS):
        SETS[k]()
