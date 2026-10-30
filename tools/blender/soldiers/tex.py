"""UV-space rasteriser + procedural texture helpers (numpy only)."""
import numpy as np
from scipy import ndimage


def raster(uv, tri, attrs, res, tri_attrs=None):
    """uv: (n,2) glTF uv (v down). attrs: dict name->(n,k) per-vertex arrays to interpolate.
    tri_attrs: dict name->(t,) per-triangle ints. Returns dict of (res,res,k) maps + 'mask' + 'tri'."""
    H = W = res
    out = {k: np.zeros((H, W, np.asarray(a).reshape(len(uv), -1).shape[1]), np.float32) for k, a in attrs.items()}
    flat = {k: np.asarray(a, np.float32).reshape(len(uv), -1) for k, a in attrs.items()}
    tid = np.full((H, W), -1, np.int32)
    P = uv * [W, H] - 0.5
    for t, (a, b, c) in enumerate(tri):
        pa, pb, pc = P[a], P[b], P[c]
        x0 = int(np.floor(min(pa[0], pb[0], pc[0]))) - 1; x1 = int(np.ceil(max(pa[0], pb[0], pc[0]))) + 1
        y0 = int(np.floor(min(pa[1], pb[1], pc[1]))) - 1; y1 = int(np.ceil(max(pa[1], pb[1], pc[1]))) + 1
        x0 = max(x0, 0); y0 = max(y0, 0); x1 = min(x1, W - 1); y1 = min(y1, H - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        v0 = pb - pa; v1 = pc - pa
        den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-12:
            continue
        dx = xs - pa[0]; dy = ys - pa[1]
        l1 = (dx * v1[1] - v1[0] * dy) / den
        l2 = (v0[0] * dy - dx * v0[1]) / den
        l0 = 1 - l1 - l2
        eps = 0.6 / max(abs(den) ** 0.5, 1)  # conservative-ish rasterisation to close seams
        m = (l0 >= -eps) & (l1 >= -eps) & (l2 >= -eps)
        if not m.any():
            continue
        yy, xx = ys[m], xs[m]
        w0, w1, w2 = l0[m], l1[m], l2[m]
        # don't let conservative edge pixels overwrite interior pixels of other tris
        inner = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        free = (tid[yy, xx] < 0) | inner
        yy, xx, w0, w1, w2 = yy[free], xx[free], w0[free], w1[free], w2[free]
        s = w0 + w1 + w2
        w0, w1, w2 = w0 / s, w1 / s, w2 / s
        tid[yy, xx] = t
        for k, A in flat.items():
            out[k][yy, xx] = w0[:, None] * A[a] + w1[:, None] * A[b] + w2[:, None] * A[c]
    out['mask'] = tid >= 0
    out['tri'] = tid
    if tri_attrs:
        for k, a in tri_attrs.items():
            a = np.asarray(a)
            m = np.where(tid >= 0, a[np.maximum(tid, 0)], -1)
            out[k] = m
    return out


def dilate(img, mask, iters=8):
    """push colours outward from mask into empty texels (avoid seams with mipmaps)"""
    img = img.copy()
    if img.ndim == 2:
        img = img[..., None]; sq = True
    else:
        sq = False
    m = mask.copy()
    for _ in range(iters):
        acc = np.zeros_like(img); cnt = np.zeros(m.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            sm = np.roll(np.roll(m, dy, 0), dx, 1)
            si = np.roll(np.roll(img, dy, 0), dx, 1)
            acc += si * sm[..., None]; cnt += sm
        new = (~m) & (cnt > 0)
        img[new] = acc[new] / cnt[new][:, None]
        m = m | new
    if not m.all():
        # fill rest with mean
        img[~m] = img[m].mean(0) if m.any() else 0
    return img[..., 0] if sq else img


def height_to_normal(h, strength=1.0):
    """h in metres-ish units scaled by strength (texel units). glTF convention (+Y up = toward top of image)."""
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    n = np.stack([-gx * strength, gy * strength, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return (n * 0.5 + 0.5)


def value_noise(shape, cell, rng, octaves=1, persist=0.5):
    """tileless smooth value noise (bicubic-upsampled random grid), sum of octaves, ~N(0,1)-ish"""
    H, W = shape
    out = np.zeros(shape, np.float32); amp = 1.0; tot = 0
    for o in range(octaves):
        c = max(cell / (2 ** o), 1)
        gh, gw = int(np.ceil(H / c)) + 3, int(np.ceil(W / c)) + 3
        g = rng.standard_normal((gh, gw)).astype(np.float32)
        z = ndimage.zoom(g, (c, c), order=3)[:H, :W]
        out += amp * z; tot += amp; amp *= persist
    return out / tot


def noise3(P, scale, seed=0, octaves=3):
    """cheap 3D value-ish noise from sums of random-direction sinusoids (works on any (...,3) array)"""
    rng = np.random.default_rng(seed)
    out = np.zeros(P.shape[:-1], np.float32)
    amp = 1.0; tot = 0
    for o in range(octaves):
        f = (2 ** o) / scale
        for k in range(4):
            d = rng.standard_normal(3); d /= np.linalg.norm(d)
            ph = rng.uniform(0, 2 * np.pi)
            out += amp * np.sin((P @ d) * f * 2 * np.pi + ph)
        tot += amp * 2; amp *= 0.5
    return out / tot


def srgb_to_lin(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def hexc(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])
