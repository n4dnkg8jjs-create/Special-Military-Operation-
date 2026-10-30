"""Procedural texture helpers (numpy only, no bpy) for the environment assets.

All generators return float32 arrays. Images are row 0 = top (PIL convention); normal maps are
tangent-space OpenGL (+Y up = green), which is what glTF expects.
Everything that should tile is generated periodically (FFT noise, wrapped Voronoi, np.roll gradients).
"""
import os
import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
CACHE = os.path.join(HERE, '_cache')
os.makedirs(CACHE, exist_ok=True)


def rng(seed):
    return np.random.default_rng(seed)


# ------------------------------------------------------------------ noise
def spectral(size, beta=2.0, seed=0, fmin=1.0, fmax=None, shape=None):
    """Periodic fractal noise via FFT filtering of white noise. beta=2 ~ brownian, 1 ~ pink.
    fmin/fmax in cycles per image. Returns zero-mean, unit-std array."""
    h, w = shape if shape else (size, size)
    r = rng(seed)
    white = r.standard_normal((h, w)).astype(np.float32)
    F = np.fft.rfft2(white)
    fy = np.fft.fftfreq(h)[:, None] * h
    fx = np.fft.rfftfreq(w)[None, :] * w
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1.0
    amp = f ** (-beta / 2.0)
    amp[f < fmin] = 0.0
    if fmax:
        amp *= np.exp(-(f / fmax) ** 4)
    amp[0, 0] = 0.0
    out = np.fft.irfft2(F * amp, s=(h, w)).astype(np.float32)
    out -= out.mean()
    out /= (out.std() + 1e-8)
    return out


def norm01(a):
    lo, hi = float(a.min()), float(a.max())
    return ((a - lo) / (hi - lo + 1e-8)).astype(np.float32)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def blur(a, s, wrap=True):
    if np.isscalar(s) and s <= 0:
        return a
    mode = 'wrap' if wrap else 'nearest'
    if a.ndim == 3:
        return np.stack([ndimage.gaussian_filter(a[..., i], s, mode=mode) for i in range(a.shape[2])], -1)
    return ndimage.gaussian_filter(a, s, mode=mode)


def warp_coords(size, amount, seed, beta=2.5, fmin=2, shape=None):
    h, w = shape if shape else (size, size)
    dx = spectral(size, beta, seed, fmin=fmin, shape=(h, w)) * amount
    dy = spectral(size, beta, seed + 1, fmin=fmin, shape=(h, w)) * amount
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    return xx + dx, yy + dy


def voronoi(size, n, seed, warp=0.0, warp_seed=None, shape=None, jitter_pts=None):
    """Periodic Voronoi. Returns (F1, F2, cell_id) in pixel units."""
    h, w = shape if shape else (size, size)
    r = rng(seed)
    pts = jitter_pts if jitter_pts is not None else np.stack([r.random(n) * w, r.random(n) * h], -1)
    tree = cKDTree(pts, boxsize=[w, h])
    if warp > 0:
        xx, yy = warp_coords(size, warp, warp_seed or seed + 99, shape=(h, w))
    else:
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    q = np.stack([np.mod(xx, w).ravel(), np.mod(yy, h).ravel()], -1)
    q = np.minimum(q, [w - 1e-3, h - 1e-3])
    d, i = tree.query(q, k=2, workers=2)
    F1 = d[:, 0].reshape(h, w).astype(np.float32)
    F2 = d[:, 1].reshape(h, w).astype(np.float32)
    return F1, F2, i[:, 0].reshape(h, w)


def crack_lines(size, n_cells, seed, width=1.2, warp=6.0, shape=None):
    """Network of thin cracks = Voronoi cell borders (F2-F1 small), domain-warped. 1 at crack."""
    F1, F2, _ = voronoi(size, n_cells, seed, warp=warp, shape=shape)
    e = F2 - F1
    return np.exp(-(e / width) ** 2).astype(np.float32)


def random_walk_cracks(shape, n, seed, length=(40, 200), step=2.0, width=1.0, branch=0.3, wrap=True):
    """Drawn polyline cracks (random walks) rendered into a mask. Good for concrete cracks."""
    h, w = shape
    r = rng(seed)
    m = np.zeros((h, w), np.float32)
    import cv2
    for _ in range(n):
        x, y = r.random() * w, r.random() * h
        ang = r.random() * 2 * np.pi
        L = int(r.uniform(*length))
        pts = [(x, y)]
        for k in range(L):
            ang += r.normal(0, 0.35)
            x += np.cos(ang) * step
            y += np.sin(ang) * step
            pts.append((x, y))
            if r.random() < branch / L * 3:
                bx, by, ba = x, y, ang + r.choice([-1, 1]) * r.uniform(0.5, 1.2)
                bp = [(bx, by)]
                for j in range(int(L * 0.3)):
                    ba += r.normal(0, 0.35)
                    bx += np.cos(ba) * step
                    by += np.sin(ba) * step
                    bp.append((bx, by))
                _draw_poly(m, bp, width * 0.7, wrap)
        _draw_poly(m, pts, width, wrap)
    return np.clip(m, 0, 1)


def _draw_poly(m, pts, width, wrap):
    import cv2
    h, w = m.shape
    p = np.array(pts, np.float32)
    offs = [(0, 0)]
    if wrap:
        offs = [(ox, oy) for ox in (-w, 0, w) for oy in (-h, 0, h)]
    for ox, oy in offs:
        q = p + [ox, oy]
        if q[:, 0].max() < 0 or q[:, 0].min() > w or q[:, 1].max() < 0 or q[:, 1].min() > h:
            continue
        # taper: draw with decreasing thickness toward ends
        n = len(q)
        for k in range(n - 1):
            t = min(k, n - 1 - k) / max(1, n * 0.25)
            th = max(1, int(round(width * min(1.0, 0.35 + t))))
            cv2.line(m, (int(q[k, 0] * 4), int(q[k, 1] * 4)), (int(q[k + 1, 0] * 4), int(q[k + 1, 1] * 4)), 1.0, th, lineType=cv2.LINE_AA, shift=2)


def stamp_disc(m, cx, cy, r, val=1.0, soft=1.0, op='max', wrap=False):
    """Soft disc stamp (in place)."""
    h, w = m.shape
    x0, x1 = int(cx - r - 3), int(cx + r + 4)
    y0, y1 = int(cy - r - 3), int(cy + r + 4)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    v = val * np.clip((r - d) / soft + 0.5, 0, 1)
    if wrap:
        yy %= h; xx %= w
    else:
        ok = (yy >= 0) & (yy < h) & (xx >= 0) & (xx < w)
        yy, xx, v = yy[ok], xx[ok], v[ok]
    if op == 'max':
        np.maximum.at(m, (yy, xx), v)
    elif op == 'add':
        np.add.at(m, (yy, xx), v)
    elif op == 'min':
        np.minimum.at(m, (yy, xx), v)


# ------------------------------------------------------------------ maps
def normal_from_height(hm, strength=1.0, wrap=True):
    """Height in 'pixels' units * strength -> OpenGL tangent normal, uint8 RGB."""
    if wrap:
        dx = (np.roll(hm, -1, 1) - np.roll(hm, 1, 1)) * 0.5
        dy = (np.roll(hm, -1, 0) - np.roll(hm, 1, 0)) * 0.5
    else:
        dy, dx = np.gradient(hm)
    nx = -dx * strength
    ny = dy * strength          # row increases downward; +Y (green) is up
    nz = np.ones_like(hm)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    n = np.stack([nx / l, ny / l, nz / l], -1)
    return to8(n * 0.5 + 0.5)


def cavity_ao(hm, radius=6, strength=1.0, wrap=True):
    """Cheap AO: how far below the local average the height is."""
    b = blur(hm, radius, wrap)
    ao = 1.0 - np.clip((b - hm) * strength, 0, 1)
    return ao.astype(np.float32)


def to8(a):
    return (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)


def srgb(c):
    """hex or tuple 0-255 -> float array 0..1"""
    if isinstance(c, str):
        c = c.lstrip('#')
        c = tuple(int(c[i:i + 2], 16) for i in (0, 2, 4))
    return np.array(c, np.float32) / 255.0


def lerp(a, b, t):
    if np.ndim(t) == 2 and np.ndim(a) == 3 or (np.ndim(t) == 2 and np.ndim(b) >= 1 and np.shape(b)[-1:] == (3,)):
        t = t[..., None]
    return a + (b - a) * t


def colorize(t, stops):
    """Map scalar 0..1 field through colour stops [(pos, '#hex'), ...] -> HxWx3."""
    pos = np.array([s[0] for s in stops], np.float32)
    cols = np.stack([srgb(s[1]) for s in stops])
    out = np.empty(t.shape + (3,), np.float32)
    for c in range(3):
        out[..., c] = np.interp(t, pos, cols[:, c])
    return out


def save_rgb(path, a, quality=90):
    img = Image.fromarray(to8(a) if a.dtype != np.uint8 else a, 'RGB')
    if path.endswith('.jpg'):
        img.save(path, quality=quality, optimize=True, subsampling=0 if quality >= 92 else 2)
    else:
        img.save(path, optimize=True, compress_level=9)


def save_rgba(path, a):
    Image.fromarray(to8(a) if a.dtype != np.uint8 else a, 'RGBA').save(path, optimize=True, compress_level=9)


def save_set(dirpath, name, albedo, normal_u8, ao, rough, metal=None, quality=90, nblur=0.7, nbits=6, obits=6):
    """Writes <name>_albedo.jpg, <name>_normal.png, <name>_orm.png (R=AO, G=rough, B=metal).
    Normal/ORM PNGs are lightly pre-filtered and LSB-quantised: per-pixel noise is invisible after
    mipmapping but makes PNG deflate useless (10 MB -> ~4.5 MB per 2048^2 normal map)."""
    os.makedirs(dirpath, exist_ok=True)
    if metal is None:
        metal = np.zeros_like(rough)
    save_rgb(os.path.join(dirpath, f'{name}_albedo.jpg'), albedo, quality)
    if nblur:
        normal_u8 = to8(blur(normal_u8.astype(np.float32) / 255.0, nblur))
    Image.fromarray(quantize_normal(normal_u8, nbits), 'RGB').save(os.path.join(dirpath, f'{name}_normal.png'), optimize=True, compress_level=9)
    orm = to8(blur(np.stack([ao, rough, metal], -1), 0.6))
    Image.fromarray(quantize_normal(orm, obits), 'RGB').save(os.path.join(dirpath, f'{name}_orm.png'), optimize=True, compress_level=9)
    return [os.path.join(dirpath, f'{name}_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]


def quantize_normal(n_u8, bits=7):
    """Drop LSBs of a normal map so PNG deflate compresses better (invisible at 7 bits)."""
    s = 8 - bits
    return ((n_u8 >> s) << s) + (1 << (s - 1) if s else 0)


def bake_shade(hgt, strength=1.0, amount=0.25, light=(-0.5, 0.6, 0.62), wrap=True):
    """Subtle baked directional relief multiplier (keeps ground readable at distance)."""
    if wrap:
        dx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * 0.5
        dy = (np.roll(hgt, -1, 0) - np.roll(hgt, 1, 0)) * 0.5
    else:
        dy, dx = np.gradient(hgt)
    nx, ny, nz = -dx * strength, dy * strength, np.ones_like(hgt)
    l = np.sqrt(nx * nx + ny * ny + 1)
    L = np.array(light) / np.linalg.norm(light)
    d = (nx * L[0] + ny * L[1] + nz * L[2]) / l
    return (1.0 + (d - L[2]) * amount).astype(np.float32)[..., None]
