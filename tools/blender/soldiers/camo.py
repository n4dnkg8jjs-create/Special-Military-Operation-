"""Procedural camouflage patterns (numpy).  Palettes are sRGB hex, documented in manifest.json.

px_per_m: texture texels per metre of fabric (from the UV layout) so pixel sizes are physical.
"""
import numpy as np
from scipy import ndimage
from tex import value_noise, hexc

# Ratnik EMR ("tsifra") summer: light green-grey ground with dark green, brown and black pixel clusters
EMR = dict(bg='#7d8463', green='#4b5638', brown='#5c4a36', black='#262520')
EMR_PIXEL_M = 0.0045
# MM-14 (Ukraine, 2014): five-tone digital: light beige, light green, swamp green, grey-green, dark grey
MM14 = dict(beige='#a59b78', light_green='#7c805b', swamp='#53573a', grey_green='#666754', dark='#36352d')
MM14_PIXEL_M = 0.006
# MultiCam-style (UA tops/vests/helmet covers): organic, 6 tones
MULTICAM = dict(base='#8f8566', tan='#a29576', green='#6f6e52', brown='#6e5940', dark='#463a2c', cream='#bdb397')
COYOTE = '#7f6646'
RANGER_GREEN = '#4c5341'


def _quant(field, fracs):
    """thresholds giving the requested area fractions for the top values"""
    return np.quantile(field, 1 - np.asarray(fracs))


def up(pal, idx, cell, res):
    r = np.minimum((np.arange(res) / cell).astype(int), idx.shape[0] - 1)
    c = np.minimum((np.arange(res) / cell).astype(int), idx.shape[1] - 1)
    return pal[idx[r][:, c]]


def emr(res, px_per_m, seed=1):
    rng = np.random.default_rng(seed)
    cell = max(EMR_PIXEL_M * px_per_m, 1.0)
    gh, gw = int(np.ceil(res / cell)) + 1, int(np.ceil(res / cell)) + 1
    blob = 0.11 * px_per_m / cell  # blob scale in pixels (~11 cm)
    f_green = value_noise((gh, gw), blob, rng, 4, 0.6) + 0.12 * rng.standard_normal((gh, gw))
    f_brown = value_noise((gh, gw), blob * 0.8, rng, 4, 0.6) + 0.12 * rng.standard_normal((gh, gw))
    f_black = f_brown * 0.7 + value_noise((gh, gw), blob * 0.3, rng, 2, 0.6) * 0.6 + 0.12 * rng.standard_normal((gh, gw))
    idx = np.zeros((gh, gw), np.uint8)
    idx[f_green > np.quantile(f_green, 1 - 0.28)] = 1
    idx[f_brown > np.quantile(f_brown, 1 - 0.27)] = 2
    blk = (f_black > np.quantile(f_black, 1 - 0.09)) & (idx > 0)
    idx[blk] = 3
    pal = np.array([hexc(EMR[k]) for k in ('bg', 'green', 'brown', 'black')])
    return up(pal, idx, cell, res)


def mm14(res, px_per_m, seed=2):
    rng = np.random.default_rng(seed)
    cell = max(MM14_PIXEL_M * px_per_m, 1.0)
    g = int(np.ceil(res / cell)) + 1
    blob = 0.13 * px_per_m / cell
    # MM-14 shapes are elongated horizontally-ish, layered
    def fld(s, sx=1.0):
        a = value_noise((g, int(g * sx) + 2), s, rng, 3, 0.55)
        a = ndimage.zoom(a, (1, 1 / sx), order=1)[:g, :g]
        return a + 0.12 * rng.standard_normal((g, g))
    idx = np.zeros((g, g), np.uint8)  # 0 = light green base
    f = fld(blob, 1.6); idx[f > np.quantile(f, 1 - 0.20)] = 1   # beige
    f = fld(blob, 1.4); idx[f > np.quantile(f, 1 - 0.24)] = 2   # swamp green
    f = fld(blob * 0.8, 1.3); idx[f > np.quantile(f, 1 - 0.16)] = 3   # grey green
    f = fld(blob * 0.5, 1.2); idx[(f > np.quantile(f, 1 - 0.12)) & (idx >= 2)] = 4  # dark
    pal = np.array([hexc(MM14[k]) for k in ('light_green', 'beige', 'swamp', 'grey_green', 'dark')])
    return up(pal, idx, cell, res)


def multicam(res, px_per_m, seed=3):
    rng = np.random.default_rng(seed)
    s = px_per_m  # texels per metre
    base = value_noise((res, res), 0.35 * s, rng, 2, 0.5)
    pal = {k: hexc(v) for k, v in MULTICAM.items()}
    t = np.clip(base * 0.8 + 0.5, 0, 1)[..., None]
    img = pal['tan'] * (1 - t) + pal['base'] * t
    g = value_noise((res, res), 0.25 * s, rng, 3, 0.5)
    gm = np.clip((g - 0.35) * 6, 0, 1)[..., None]
    img = img * (1 - gm) + pal['green'] * gm
    def blobs(scale, frac, col, warp=0.4):
        f = value_noise((res, res), scale * s, rng, 3, 0.55)
        w = value_noise((res, res), scale * s * 0.5, rng, 2, 0.5)
        f = f + warp * w
        th = np.quantile(f[::8, ::8], 1 - frac)
        m = np.clip((f - th) * 25, 0, 1)[..., None]
        return img * (1 - m) + pal[col] * m, f > th
    img, mb = blobs(0.06, 0.16, 'brown', 0.6)
    img, _ = blobs(0.025, 0.07, 'dark', 0.9)
    img, _ = blobs(0.018, 0.05, 'cream', 1.0)
    return img


def solid(res, hexcol, seed=4, var=0.04):
    rng = np.random.default_rng(seed)
    c = hexc(hexcol)
    n = value_noise((res, res), res / 6, rng, 3, 0.6)
    return np.clip(c[None, None, :] * (1 + var * n[..., None]), 0, 1)


def weave(res, px_per_m, rng=None):
    """fine rip-stop grid height (0..1) - 5 mm rip-stop squares + thread noise"""
    yy, xx = np.mgrid[0:res, 0:res].astype(np.float32)
    per = max(0.005 * px_per_m, 3)
    rip = (np.abs(((xx / per) % 1) - 0.5) > 0.42) | (np.abs(((yy / per) % 1) - 0.5) > 0.42)
    thread = np.sin(xx * 2.2) * np.sin(yy * 2.2)
    return rip.astype(np.float32) * 0.6 + thread * 0.2


# ---------------------------------------------------------------- seamless tiles for gear (periodic noise)
def pnoise(shape, sigma, rng, octaves=3, persist=0.55):
    out = np.zeros(shape, np.float32); amp = 1; tot = 0
    for o in range(octaves):
        s = max(sigma / (2 ** o), 0.6)
        f = ndimage.gaussian_filter(rng.standard_normal(shape).astype(np.float32), s, mode='wrap')
        f /= f.std() + 1e-9
        out += amp * f; tot += amp; amp *= persist
    return out / tot


def emr_tile(res=1024, tile_m=0.5, seed=11):
    rng = np.random.default_rng(seed)
    n = int(round(tile_m / EMR_PIXEL_M))
    blob = 0.11 / EMR_PIXEL_M / 2.2
    fg = pnoise((n, n), blob, rng, 4, 0.6) + 0.12 * rng.standard_normal((n, n))
    fb = pnoise((n, n), blob * 0.8, rng, 4, 0.6) + 0.12 * rng.standard_normal((n, n))
    fk = fb * 0.7 + pnoise((n, n), blob * 0.3, rng, 2) * 0.6 + 0.12 * rng.standard_normal((n, n))
    idx = np.zeros((n, n), np.uint8)
    idx[fg > np.quantile(fg, 1 - 0.28)] = 1
    idx[fb > np.quantile(fb, 1 - 0.27)] = 2
    idx[(fk > np.quantile(fk, 1 - 0.09)) & (idx > 0)] = 3
    pal = np.array([hexc(EMR[k]) for k in ('bg', 'green', 'brown', 'black')])
    return up(pal, idx, res / n, res)


def mm14_tile(res=1024, tile_m=0.5, seed=12):
    rng = np.random.default_rng(seed)
    n = int(round(tile_m / MM14_PIXEL_M))
    blob = 0.13 / MM14_PIXEL_M / 2.2
    def fld(s, frac):
        f = ndimage.zoom(pnoise((n, n // 2 * 2), s, rng, 3), 1, order=1)
        f = f + 0.12 * rng.standard_normal((n, n))
        return f > np.quantile(f, 1 - frac)
    idx = np.zeros((n, n), np.uint8)
    idx[fld(blob, 0.2)] = 1; idx[fld(blob, 0.24)] = 2; idx[fld(blob * 0.8, 0.16)] = 3
    d = fld(blob * 0.5, 0.12); idx[d & (idx >= 2)] = 4
    pal = np.array([hexc(MM14[k]) for k in ('light_green', 'beige', 'swamp', 'grey_green', 'dark')])
    return up(pal, idx, res / n, res)


def multicam_tile(res=1024, tile_m=0.5, seed=13):
    rng = np.random.default_rng(seed)
    s = res / tile_m
    pal = {k: hexc(v) for k, v in MULTICAM.items()}
    t = np.clip(pnoise((res, res), 0.12 * s, rng, 2) * 0.4 + 0.5, 0, 1)[..., None]
    img = pal['tan'] * (1 - t) + pal['base'] * t
    gm = np.clip((pnoise((res, res), 0.08 * s, rng, 3) - 0.4) * 3, 0, 1)[..., None]
    img = img * (1 - gm) + pal['green'] * gm
    for sc, frac, col, warp in ((0.025, 0.16, 'brown', 0.6), (0.011, 0.07, 'dark', 0.9), (0.008, 0.05, 'cream', 1.0)):
        f = pnoise((res, res), sc * s, rng, 3) + warp * pnoise((res, res), sc * s * 0.5, rng, 2)
        th = np.quantile(f[::8, ::8], 1 - frac)
        m = np.clip((f - th) * 25, 0, 1)[..., None]
        img = img * (1 - m) + pal[col] * m
    return img


def solid_tile(res, hexcol, seed=14, var=0.05):
    rng = np.random.default_rng(seed)
    n = pnoise((res, res), res / 10, rng, 3)
    return np.clip(hexc(hexcol)[None, None, :] * (1 + var * n[..., None]), 0, 1)


def cordura_tile(res=1024, tile_m=0.5, seed=15):
    """height map of 500D cordura weave + slight crumple, periodic; returns (height, ao_mult)"""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:res, 0:res].astype(np.float32)
    per = 4.0  # weave period in texels (~2 mm at 0.5 m tiles)
    k = 2 * np.pi / per
    weave = np.sin(xx * k) * np.sin(yy * k) * 0.5 + 0.5 * np.sin((xx + yy) * k * 0.5) * 0.2
    crumple = pnoise((res, res), res / 40, rng, 3)
    h = weave * 0.04 + crumple * 0.5
    return h
