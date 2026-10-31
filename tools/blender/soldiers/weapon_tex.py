"""Weapon atlas texturing: one 0..1 atlas per weapon (smart-UV), Cycles data bake (AO + bevel-node edge mask), numpy
rasterised position / normal / material-kind maps, then procedural PBR synthesis (base colour, ORM, tangent normal from a
height field).  Surface details (rivets, vents, stamped ribs, checkering, stencils, serials...) are `Fx` objects defined in
gun space (metres), so they do not depend on the UV layout.

Conventions: arrays are in glTF image orientation (row 0 = v 0 = top of the image), positions in gun space (GL, Y up)."""
import os, time
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
import bpy
from PIL import Image, ImageDraw, ImageFont
import tex as TX

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
FONT_C = '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf'


# ------------------------------------------------------------------------------------------------ noise
_GRID = {}


def _grid(seed, n=64):
    k = (seed, n)
    if k not in _GRID:
        _GRID[k] = np.random.default_rng(seed).random((n, n, n)).astype(np.float32)
    return _GRID[k]


def noise3(P, freq, seed=0):
    """trilinear value noise in [0,1]; freq scalar or (3,) per axis, cycles/metre"""
    g = _grid(seed)
    c = (P * np.asarray(freq, np.float32)).reshape(-1, 3).T
    return ndimage.map_coordinates(g, c, order=1, mode='grid-wrap', prefilter=False).reshape(P.shape[:-1])


def fbm(P, freq, octaves=4, seed=0, gain=0.5, lac=2.03):
    s = 0.0; a = 1.0; tot = 0.0; f = np.asarray(freq, np.float32)
    for o in range(octaves):
        s = s + a * noise3(P, f, seed + o * 17); tot += a; a *= gain; f = f * lac
    return s / tot


def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def lin(hexs):
    return TX.srgb_to_lin(TX.hexc(hexs)).astype(np.float32)


def lin2srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


# ------------------------------------------------------------------------------------------------ material kinds
# col: base colour, rough/metal, w*: worn-through look on exposed edges, wear: edge wear amount, mott: colour mottling,
# rn: roughness noise, micro: micro height amplitude (m) at micro_f (1/m), dirt: cavity grime, grain: wood grain axis
K = {
    'steel':     dict(col='#2e3032', rough=0.42, metal=0.70, wcol='#8d9092', wrough=0.28, wmetal=1.0, wear=0.9, mott=0.10, rn=0.10, micro=0.00002, micro_f=900, dirt=0.5),
    'enamel':    dict(col='#232425', rough=0.48, metal=0.25, wcol='#7f8285', wrough=0.30, wmetal=1.0, wear=1.0, mott=0.06, rn=0.08, micro=0.00002, micro_f=1200, dirt=0.5),
    'steel_dark': dict(col='#1f2022', rough=0.5, metal=0.55, wcol='#6f7275', wrough=0.32, wmetal=1.0, wear=0.7, mott=0.08, rn=0.1, micro=0.00002, micro_f=900, dirt=0.5),
    'bare':      dict(col='#6b6e70', rough=0.30, metal=1.0, wcol='#9a9da0', wrough=0.22, wmetal=1.0, wear=0.6, mott=0.12, rn=0.12, micro=0.00001, micro_f=900, dirt=0.4),
    'plum':      dict(col='#3b2523', rough=0.50, metal=0.0, wcol='#5a3a35', wrough=0.38, wmetal=0.0, wear=0.55, mott=0.08, rn=0.08, micro=0.00003, micro_f=1500, dirt=0.6),
    'polymer':   dict(col='#1d1d1d', rough=0.58, metal=0.0, wcol='#3a3a38', wrough=0.42, wmetal=0.0, wear=0.5, mott=0.06, rn=0.08, micro=0.00003, micro_f=1500, dirt=0.6),
    'mag_plum':  dict(col='#552b20', rough=0.42, metal=0.0, wcol='#74422f', wrough=0.33, wmetal=0.0, wear=0.5, mott=0.10, rn=0.08, micro=0.00002, micro_f=1300, dirt=0.6),
    'mag_black': dict(col='#1b1a19', rough=0.5, metal=0.0, wcol='#373533', wrough=0.38, wmetal=0.0, wear=0.5, mott=0.06, rn=0.08, micro=0.00002, micro_f=1300, dirt=0.6),
    'wood':      dict(col='#7a4326', rough=0.42, metal=0.0, wcol='#a3693f', wrough=0.55, wmetal=0.0, wear=0.8, mott=0.12, rn=0.08, micro=0.00002, micro_f=600, dirt=0.6, grain='z'),
    'olive':     dict(col='#4a4f33', rough=0.62, metal=0.0, wcol='#5c5f5f', wrough=0.35, wmetal=0.9, wear=0.9, mott=0.08, rn=0.08, micro=0.00002, micro_f=900, dirt=0.6),
    'olive_dark': dict(col='#343826', rough=0.6, metal=0.0, wcol='#56595a', wrough=0.35, wmetal=0.9, wear=0.8, mott=0.08, rn=0.08, micro=0.00002, micro_f=900, dirt=0.6),
    'warhead':   dict(col='#4f5636', rough=0.55, metal=0.0, wcol='#7a7c78', wrough=0.3, wmetal=1.0, wear=0.6, mott=0.07, rn=0.08, micro=0.00001, micro_f=900, dirt=0.5),
    'cast':      dict(col='#4c5232', rough=0.66, metal=0.0, wcol='#4a4a46', wrough=0.45, wmetal=0.85, wear=1.0, mott=0.10, rn=0.10, micro=0.00012, micro_f=700, dirt=0.7),
    'glass':     dict(col='#0b1216', rough=0.04, metal=0.0, wcol='#0b1216', wrough=0.04, wmetal=0.0, wear=0.0, mott=0.0, rn=0.0, micro=0.0, micro_f=1, dirt=0.0),
    'glass_amber': dict(col='#2a1608', rough=0.04, metal=0.0, wcol='#2a1608', wrough=0.04, wmetal=0.0, wear=0.0, mott=0.0, rn=0.0, micro=0.0, micro_f=1, dirt=0.0),
    'brass':     dict(col='#a5803d', rough=0.30, metal=1.0, wcol='#c9a35a', wrough=0.22, wmetal=1.0, wear=0.4, mott=0.10, rn=0.10, micro=0.0, micro_f=1, dirt=0.4),
    'fibre':     dict(col='#475030', rough=0.68, metal=0.0, wcol='#5b6340', wrough=0.55, wmetal=0.0, wear=0.5, mott=0.07, rn=0.06, micro=0.00002, micro_f=800, dirt=0.6),
    'fibre_dark': dict(col='#30351f', rough=0.64, metal=0.0, wcol='#454b30', wrough=0.5, wmetal=0.0, wear=0.5, mott=0.06, rn=0.06, micro=0.00002, micro_f=800, dirt=0.6),
    'rubber':    dict(col='#171716', rough=0.85, metal=0.0, wcol='#262624', wrough=0.75, wmetal=0.0, wear=0.3, mott=0.05, rn=0.05, micro=0.00004, micro_f=1600, dirt=0.4),
    'webbing':   dict(col='#47462f', rough=0.95, metal=0.0, wcol='#5a5940', wrough=0.95, wmetal=0.0, wear=0.3, mott=0.10, rn=0.03, micro=0.0, micro_f=1, dirt=0.5, weave=True),
    'alu':       dict(col='#1c1d1e', rough=0.40, metal=0.6, wcol='#9c9fa2', wrough=0.25, wmetal=1.0, wear=1.0, mott=0.05, rn=0.06, micro=0.00001, micro_f=1200, dirt=0.4),
    'bore':      dict(col='#080808', rough=0.85, metal=0.2, wcol='#080808', wrough=0.85, wmetal=0.2, wear=0.0, mott=0.0, rn=0.0, micro=0.0, micro_f=1, dirt=0.0),
    'red':       dict(col='#8a1f17', rough=0.5, metal=0.0, wcol='#5c5f5f', wrough=0.35, wmetal=0.9, wear=0.6, mott=0.06, rn=0.06, micro=0.0, micro_f=1, dirt=0.4),
}
KIND_ID = {k: i for i, k in enumerate(K)}


# ------------------------------------------------------------------------------------------------ Fx (surface details)
def frame(n, up=(0, 1, 0)):
    """orthonormal (u, v, n) columns for a decal facing n (v ~ up)"""
    n = np.asarray(n, float); n = n / np.linalg.norm(n)
    up = np.asarray(up, float)
    if abs(up @ n) > 0.95:
        up = np.array([0, 0, 1.0]) if abs(n[2]) < 0.95 else np.array([1.0, 0, 0])
    u = np.cross(up, n); u /= np.linalg.norm(u)
    v = np.cross(n, u)
    return np.stack([u, v, n], 1)


class Fx:
    """oriented-box region decal.  c: centre, R: (3,3) columns (u, v, n), half: (hu, hv, hn) half sizes (m).
    facing: min N.n (None = any; negative values allow both sides via abs when two_sided).  kinds: restrict to kinds.
    fn(lu, lv, ln) -> dict(h=, col=(m,3), a=, rough=, ra=, metal=, ma=, wear=) on the selected texels; lu, lv in [-1, 1]."""

    def __init__(self, c, R, half, fn, facing=0.3, kinds=None, two_sided=False):
        self.c = np.asarray(c, float); self.R = np.asarray(R, float); self.half = np.asarray(half, float)
        self.fn = fn; self.facing = facing; self.kinds = kinds; self.two_sided = two_sided

    def apply(self, T):
        P, N, Kk, valid = T['P'], T['N'], T['K'], T['valid']
        lo = (self.c - np.abs(self.R) @ self.half) - 1e-4; hi = (self.c + np.abs(self.R) @ self.half) + 1e-4
        m = valid & np.all((P >= lo) & (P <= hi), -1)
        if self.kinds is not None:
            m &= np.isin(Kk, [KIND_ID[k] for k in self.kinds])
        if not m.any():
            return
        idx = np.nonzero(m)
        d = (P[idx] - self.c) @ self.R
        nd = N[idx] @ self.R[:, 2]
        ok = (np.abs(d) <= self.half + 1e-6).all(1)
        if self.facing is not None:
            ok &= (np.abs(nd) if self.two_sided else nd) >= self.facing
        if not ok.any():
            return
        idx = (idx[0][ok], idx[1][ok]); d = d[ok]
        r = self.fn(d[:, 0] / self.half[0], d[:, 1] / self.half[1], d[:, 2] / max(self.half[2], 1e-9))
        if 'h' in r:
            T['H'][idx] += r['h']
        if 'hset' in r:   # blend height toward a value (e.g. flatten)
            a = r.get('hseta', 1.0); T['H'][idx] = T['H'][idx] * (1 - a) + r['hset'] * a
        if 'col' in r:
            a = np.broadcast_to(np.asarray(r.get('a', 1.0), np.float32), idx[0].shape)[:, None]
            T['C'][idx] = T['C'][idx] * (1 - a) + np.asarray(r['col'], np.float32) * a
        if 'mul' in r:
            T['C'][idx] *= np.asarray(r['mul'], np.float32).reshape(-1, 1) if np.ndim(r['mul']) else r['mul']
        for key, tk in (('rough', 'R'), ('metal', 'M')):
            if key in r:
                a = np.broadcast_to(np.asarray(r.get(key[0] + 'a', 1.0), np.float32), idx[0].shape)
                T[tk][idx] = T[tk][idx] * (1 - a) + r[key] * a
        if 'wear' in r:
            T['WB'][idx] = np.maximum(T['WB'][idx], r['wear'])
        if 'nowear' in r:
            T['NW'][idx] = np.maximum(T['NW'][idx], r['nowear'])


def _soft(x, w):
    """1 inside (x<0), 0 outside, linear ramp of width w"""
    return np.clip(0.5 - x / max(w, 1e-9), 0, 1)


def fx_dots(pts, r, n, depth=0.0004, kinds=None, shape='dome', col=None, colA=0.0, facing=0.5, rough=None, wear=0.0):
    """rivets (dome), holes (hole, depth>0 = into the surface), dimples.  pts: list of gun-space points on the surface,
    n: their common outward normal."""
    pts = np.asarray(pts, float); R = frame(n)
    out = []
    for p in pts:
        def fn(lu, lv, ln, r=r):
            d = np.sqrt(lu ** 2 + lv ** 2)
            if shape == 'dome':
                h = depth * np.sqrt(np.clip(1 - d * d, 0, 1))
            elif shape == 'hole':
                h = -depth * _soft(d - 0.85, 0.15)
            else:   # ring (screw head edge / pin)
                h = depth * np.clip(1 - np.abs(d - 0.75) / 0.25, 0, 1)
            res = dict(h=h)
            if col is not None:
                res['col'] = lin(col) if isinstance(col, str) else col
                res['a'] = colA * _soft(d - 0.9, 0.1)
            if rough is not None:
                res['rough'] = rough; res['ra'] = _soft(d - 0.9, 0.1)
            if wear:
                res['wear'] = wear * _soft(d - 0.8, 0.2)
            return res
        out.append(Fx(p, R, (r, r, max(r, 0.004)), fn, facing=facing, kinds=kinds))
    return out


def fx_rect(c, n, up, w, h, depth=0.0005, radius=0.3, kinds=None, col=None, colA=0.0, facing=0.4, mode='recess', edge=0.12,
            rough=None, metal=None, thick=0.006, wear=0.0):
    """rectangular recess / raised pad / dark slot.  w, h: full size along u (up x n) and v (up). radius: corner radius as a
    fraction of the shorter half side.  mode: recess | raised | flat (colour only) | frame (raised rim)"""
    R = frame(n, up)
    hw, hh = w / 2, h / 2

    def fn(lu, lv, ln):
        # rounded-rect signed distance in metres
        rr = radius * min(hw, hh)
        qx = np.abs(lu * hw) - (hw - rr); qy = np.abs(lv * hh) - (hh - rr)
        sd = np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2) + np.minimum(np.maximum(qx, qy), 0) - rr
        e = edge * min(hw, hh)
        inside = _soft(sd + e * 0.5, e)
        res = {}
        if mode == 'recess':
            res['h'] = -depth * inside
        elif mode == 'raised':
            res['h'] = depth * inside
        elif mode == 'frame':
            res['h'] = depth * np.clip(1 - np.abs(sd + e) / e, 0, 1)
        if col is not None:
            res['col'] = lin(col) if isinstance(col, str) else col; res['a'] = colA * inside
        if rough is not None:
            res['rough'] = rough; res['ra'] = inside
        if metal is not None:
            res['metal'] = metal; res['ma'] = inside
        if wear:
            res['wear'] = wear * inside
        return res
    return Fx(c, R, (hw, hh, thick), fn, facing=facing, kinds=kinds)


def fx_line(p0, p1, n, width, depth=0.0004, kinds=None, profile='groove', col=None, colA=0.0, facing=0.3, thick=0.008, wear=0.0):
    """groove / raised rib / painted line along p0->p1 on a surface with outward normal n"""
    p0 = np.asarray(p0, float); p1 = np.asarray(p1, float)
    d = p1 - p0; L = np.linalg.norm(d); t = d / L
    n = np.asarray(n, float); n = n - t * (t @ n); n /= np.linalg.norm(n)
    v = np.cross(n, t)
    R = np.stack([t, v, n], 1)
    hw = width / 2

    def fn(lu, lv, ln):
        a = np.abs(lv)
        res = {}
        if profile == 'groove':
            res['h'] = -depth * np.clip(1 - a, 0, 1) ** 0.6
        elif profile == 'rib':
            res['h'] = depth * np.sqrt(np.clip(1 - a * a, 0, 1))
        elif profile == 'step':
            res['h'] = depth * _soft(a - 0.8, 0.2)
        if col is not None:
            res['col'] = lin(col) if isinstance(col, str) else col; res['a'] = colA * _soft(a - 0.85, 0.15)
        if wear:
            res['wear'] = wear * np.clip(1 - a, 0, 1)
        return res
    return Fx((p0 + p1) / 2, R, (L / 2 + hw, hw, thick), fn, facing=facing, kinds=kinds)


def fx_pattern(c, n, up, w, h, fn2, depth=0.0003, kinds=None, facing=0.35, thick=0.01, col=None, colA=None, rough=None, two_sided=False):
    """procedural pattern in a rectangle: fn2(x_m, y_m) -> height in [0,1] (x along u, y along v, metres from centre)"""
    R = frame(n, up); hw, hh = w / 2, h / 2

    def fn(lu, lv, ln):
        p = fn2(lu * hw, lv * hh)
        fade = np.clip((1 - np.abs(lu)) * hw / 0.0015, 0, 1) * np.clip((1 - np.abs(lv)) * hh / 0.0015, 0, 1)
        res = dict(h=depth * p * fade)
        if col is not None:
            res['col'] = lin(col) if isinstance(col, str) else col
            res['a'] = (colA if colA is not None else 1.0) * p * fade
        if rough is not None:
            res['rough'] = rough; res['ra'] = fade * 0.8
        return res
    return Fx(c, R, (hw, hh, thick), fn, facing=facing, kinds=kinds, two_sided=two_sided)


def fx_text(text, c, n, up, height, col='#d9d4c4', colA=0.9, depth=0.0, kinds=None, facing=0.35, font=FONT, thick=0.006,
            stencil=False, spacing=0.0, wear=0.25):
    """painted (colA) and/or stamped (depth<0) / raised (depth>0) text.  height = cap height (m).  The text reads along u
    (= up x n), so for a decal on the left side (+X normal) of a gun with +Z forward, use up=(0,1,0) -> reads toward -Z.."""
    fnt = ImageFont.truetype(font, 96)
    bb = fnt.getbbox(text)
    tw, th = bb[2] - bb[0] + int(spacing * 96 * max(len(text) - 1, 0)), bb[3] - bb[1]
    img = Image.new('L', (tw + 24, th + 24), 0)
    dr = ImageDraw.Draw(img)
    if spacing:
        x = 12 - bb[0]
        for ch in text:
            dr.text((x, 12 - bb[1]), ch, fill=255, font=fnt); x += fnt.getlength(ch) + spacing * 96
    else:
        dr.text((12 - bb[0], 12 - bb[1]), text, fill=255, font=fnt)
    a = np.asarray(img, np.float32) / 255
    if stencil:   # stencil bridges
        cols = a.shape[1]
        for k in range(1, max(len(text), 1) * 2):
            pass
    a = ndimage.gaussian_filter(a, 0.8)
    Himg, Wimg = a.shape
    scale = height / th
    w, h = Wimg * scale, Himg * scale
    R = frame(n, up)
    rng = np.random.default_rng(len(text) * 7 + int(abs(c[0]) * 1e4))
    chip = ndimage.zoom(rng.random((max(Himg // 12, 2), max(Wimg // 12, 2))), (Himg / max(Himg // 12, 2), Wimg / max(Wimg // 12, 2)), order=1)[:Himg, :Wimg]

    def fn(lu, lv, ln):
        x = (lu * 0.5 + 0.5) * (Wimg - 1); y = (0.5 - lv * 0.5) * (Himg - 1)
        v = ndimage.map_coordinates(a, [y, x], order=1, mode='constant')
        res = {}
        if colA > 0:
            cv = ndimage.map_coordinates(chip, [np.clip(y, 0, chip.shape[0] - 1), np.clip(x, 0, chip.shape[1] - 1)], order=1)
            res['col'] = lin(col) if isinstance(col, str) else col
            res['a'] = colA * v * np.clip((cv - wear) / 0.15, 0, 1)
        if depth:
            res['h'] = depth * v
        return res
    return Fx(c, R, (w / 2, h / 2, thick), fn, facing=facing, kinds=kinds)


def fx_cyl_bands(axis_c, axis_d, z0, z1, r, col, colA=1.0, kinds=None, depth=0.0, rmax=None):
    """painted band around a cylinder (z along axis from axis_c)"""
    axis_d = np.asarray(axis_d, float); axis_d /= np.linalg.norm(axis_d)
    R = frame(axis_d)    # n along axis
    R = np.stack([R[:, 0], R[:, 1], axis_d], 1)
    rr = rmax or r * 1.3
    c = np.asarray(axis_c, float) + axis_d * (z0 + z1) / 2

    def fn(lu, lv, ln):
        res = dict(col=lin(col) if isinstance(col, str) else col, a=colA * np.clip((1 - np.abs(ln)) * (z1 - z0) / 2 / 0.0005, 0, 1))
        if depth:
            res['h'] = depth * np.ones_like(lu)
        return res
    return Fx(c, R, (rr, rr, (z1 - z0) / 2), fn, facing=None, kinds=kinds)


# ------------------------------------------------------------------------------------------------ maps
def raster_maps(uv, tri, pos, nrm, kind_tri, res):
    r = TX.raster(uv, tri, {'P': pos, 'N': nrm}, res, tri_attrs={'K': kind_tri})
    N = r['N']; N /= np.maximum(np.linalg.norm(N, axis=-1, keepdims=True), 1e-8)
    return dict(P=r['P'], N=N, K=r['K'].astype(np.int32), valid=r['mask'])


def _bake_material(edge_r, ao_d):
    m = bpy.data.materials.new('_wbake'); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial'); em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(em.outputs[0], out.inputs[0])
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    ao = nt.nodes.new('ShaderNodeAmbientOcclusion'); ao.samples = 16; ao.inputs['Distance'].default_value = ao_d
    bev = nt.nodes.new('ShaderNodeBevel'); bev.samples = 8; bev.inputs['Radius'].default_value = edge_r
    dot = nt.nodes.new('ShaderNodeVectorMath'); dot.operation = 'DOT_PRODUCT'
    nt.links.new(bev.outputs[0], dot.inputs[0]); nt.links.new(geo.outputs['Normal'], dot.inputs[1])
    # convexity: bevel normal vs. a slightly larger-radius bevel tells convex from concave poorly; use pointiness instead
    comb = nt.nodes.new('ShaderNodeCombineColor')
    nt.links.new(ao.outputs['AO'], comb.inputs[0]); nt.links.new(dot.outputs['Value'], comb.inputs[1])
    nt.links.new(geo.outputs['Pointiness'], comb.inputs[2])
    nt.links.new(comb.outputs[0], em.inputs['Color'])
    tn = nt.nodes.new('ShaderNodeTexImage'); tn.name = 'bake_target'
    nt.nodes.active = tn
    return m, tn


def bake_ao_edge(ob, res, edge_r=0.0012, ao_d=0.05, samples=4):
    """Cycles EMIT bake on the (unwrapped) joined object: R = AO, G = bevel-normal . normal (1 flat, <1 near edges),
    B = pointiness (>0.5 convex).  Returns arrays in glTF orientation."""
    t = time.time()
    m, tn = _bake_material(edge_r, ao_d)
    ob.data.materials.clear(); ob.data.materials.append(m)
    img = bpy.data.images.new('_wbake_img', res, res, alpha=True, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'; img.generated_color = (0, 0, 0, 0)
    tn.image = img
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = samples; sc.cycles.use_denoising = False
    sc.render.threads_mode = 'FIXED'; sc.render.threads = 2
    sc.render.bake.margin = 4; sc.render.bake.margin_type = 'EXTEND'; sc.render.bake.use_clear = True
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    ob.select_set(True); bpy.context.view_layer.objects.active = ob
    bpy.ops.object.bake(type='EMIT')
    a = np.empty(res * res * 4, np.float32); img.pixels.foreach_get(a)
    a = a.reshape(res, res, 4)[::-1].copy()
    bpy.data.images.remove(img)
    print('   bake %d %.1fs' % (res, time.time() - t))
    return dict(AO=a[..., 0], E=a[..., 1], PT=a[..., 2])


def height_to_normal(Hm, P, valid, N=None):
    """height (m) -> glTF tangent-space normal (+X = +u right, +Y = up in the image = -row)."""
    du = np.linalg.norm(P[:, 1:] - P[:, :-1], axis=-1)
    dv = np.linalg.norm(P[1:, :] - P[:-1, :], axis=-1)
    okd = valid[:, 1:] & valid[:, :-1]
    med = np.median(du[okd]) if okd.any() else 1e-3
    okx = okd & (du < med * 2.5) & (du > med * 0.2)
    oky = valid[1:, :] & valid[:-1, :] & (dv < med * 2.5) & (dv > med * 0.2)
    if N is not None:
        okx &= (N[:, 1:] * N[:, :-1]).sum(-1) > 0.9
        oky &= (N[1:, :] * N[:-1, :]).sum(-1) > 0.9
    gx = np.where(okx, (Hm[:, 1:] - Hm[:, :-1]) / med, 0)
    gy = np.where(oky, (Hm[1:, :] - Hm[:-1, :]) / med, 0)
    hx = np.zeros_like(Hm); hy = np.zeros_like(Hm)
    hx[:, :-1] += gx; hx[:, 1:] += gx; hx *= 0.5
    hy[:-1, :] += gy; hy[1:, :] += gy; hy *= 0.5
    n = np.stack([-hx, hy, np.ones_like(Hm)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5, med


def dilate(arr, valid):
    if valid.all():
        return arr
    idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    return arr[idx[0], idx[1]]


def synth(T, fx=(), seed=1, kinds=K, wear_scale=1.0, dirt_scale=1.0):
    """T: dict P, N, K, valid, AO, E, PT.  Returns uint8 albedo (sRGB), orm, normal and stats."""
    P, N, Kk, valid = T['P'], T['N'], T['K'], T['valid']
    Hh, Ww = Kk.shape
    names = list(kinds)
    tab = {f: np.zeros(len(names), np.float32) for f in ('rough', 'metal', 'wrough', 'wmetal', 'wear', 'mott', 'rn', 'micro', 'micro_f', 'dirt')}
    col = np.zeros((len(names), 3), np.float32); wcol = np.zeros((len(names), 3), np.float32)
    for i, k in enumerate(names):
        d = kinds[k]
        col[i] = lin(d['col']); wcol[i] = lin(d['wcol'])
        for f in tab:
            tab[f][i] = d[f]
    ki = np.clip(Kk, 0, len(names) - 1)
    g = {f: tab[f][ki] for f in tab}
    C = col[ki].copy(); WC = wcol[ki]
    n1 = fbm(P, 60.0, 3, seed) - 0.5
    n2 = fbm(P, 220.0, 3, seed + 5) - 0.5
    C *= (1 + 2.0 * g['mott'][..., None] * (n1[..., None] * 1.4 + n2[..., None] * 0.6))
    R = g['rough'] + g['rn'] * (n2 * 1.6 + n1)
    M = g['metal'].copy()
    # micro surface (cast / moulded / orange peel) as height
    Hm = np.zeros((Hh, Ww), np.float32)
    mf = g['micro_f']
    for f0 in np.unique(mf):
        sel = mf == f0
        if f0 <= 1:
            continue
        Hm[sel] = (fbm(P[sel][None], f0, 2, seed + 11)[0] - 0.5) * 2
    Hm *= g['micro']
    # wood grain along z: long streaks + rings
    for i, k in enumerate(names):
        if kinds[k].get('grain'):
            sel = ki == i
            if not sel.any():
                continue
            Q = P[sel]
            gr = fbm(Q[None] * np.array([1, 1, 0.04]), 160.0, 3, seed + 21)[0]
            ring = np.sin(gr * 40.0) * 0.5 + 0.5
            fine = fbm(Q[None] * np.array([1, 1, 0.08]), 900.0, 2, seed + 29)[0]
            C[sel] *= (0.78 + 0.32 * ring[:, None] + 0.15 * (fine[:, None] - 0.5))
            R[sel] += 0.05 * (ring - 0.5)
            Hm[sel] += 0.00003 * (ring - 0.5) + 0.00002 * (fine - 0.5)
    for i, k in enumerate(names):   # woven webbing: ribs across the strap (straps run mostly along z) + twill wobble
        if kinds[k].get('weave'):
            sel = ki == i
            if not sel.any():
                continue
            Q = P[sel]
            w = 0.5 + 0.5 * np.sin(Q[:, 2] * 2 * np.pi / 0.0017 + 2.5 * np.sin((Q[:, 0] + Q[:, 1]) * 2 * np.pi / 0.004))
            Hm[sel] += 0.00010 * w
            C[sel] *= (0.86 + 0.22 * w)[:, None]
    TT = dict(P=P, N=N, K=Kk, valid=valid, H=Hm, C=C, R=R, M=M, WB=np.zeros((Hh, Ww), np.float32), NW=np.zeros((Hh, Ww), np.float32))
    for f in fx:
        f.apply(TT)
    Hm, C, R, M = TT['H'], TT['C'], TT['R'], TT['M']
    # edge wear: convex edges (bevel mask + pointiness), broken up by noise, plus explicit handling-wear zones
    AO = T['AO']; E = T['E']; PT = T['PT']
    edge = sstep(0.97, 0.72, E) * sstep(0.50, 0.58, PT)
    brk = fbm(P, 140.0, 4, seed + 3)
    chips = sstep(0.50, 0.66, brk + 0.25 * (fbm(P, 600.0, 2, seed + 9) - 0.5))
    wear = np.clip(edge * chips * 1.4, 0, 1) * g['wear'] * wear_scale
    hz = TT['WB'] * sstep(0.35, 0.7, fbm(P, 90.0, 3, seed + 13) + 0.2)
    wear = np.clip(np.maximum(wear, hz * g['wear']) * (1 - TT['NW']), 0, 1)
    C = C * (1 - wear[..., None]) + WC * wear[..., None]
    R = R * (1 - wear) + g['wrough'] * wear
    M = M * (1 - wear) + g['wmetal'] * wear
    Hm = Hm - 0.00004 * wear      # chipped paint edge sits a hair lower
    # cavity grime + dust on up-facing surfaces
    cav = np.clip((1 - AO) * 1.6, 0, 1) * g['dirt'] * dirt_scale
    dust = sstep(0.4, 0.95, N[..., 1]) * sstep(0.45, 0.7, fbm(P, 35.0, 3, seed + 41)) * 0.25 * g['dirt'] * dirt_scale
    grime = lin('#2a261e')
    C = C * (1 - cav[..., None] * 0.55) + grime * cav[..., None] * 0.25
    C = C * (1 - dust[..., None]) + lin('#6e6552') * dust[..., None]
    R = np.clip(R + cav * 0.15 + dust * 0.3, 0.03, 1.0)
    M = np.clip(M * (1 - dust), 0, 1)
    # bake a little AO into the albedo so stamped detail reads under direct light too
    C = C * (0.72 + 0.28 * AO[..., None])
    nrm, texel = height_to_normal(Hm, P, valid, N)
    alb = (lin2srgb(np.clip(C, 0, 1)) * 255 + 0.5).astype(np.uint8)
    orm = np.stack([np.clip(0.35 + 0.65 * AO, 0, 1), np.clip(R, 0, 1), np.clip(M, 0, 1)], -1)
    orm = (orm * 255 + 0.5).astype(np.uint8)
    nrm = (nrm * 255 + 0.5).astype(np.uint8)
    alb = dilate(alb, valid); orm = dilate(orm, valid); nrm = dilate(nrm, valid)
    return alb, orm, nrm, dict(texel_m=float(texel), px_per_m=float(1 / max(texel, 1e-9)), fill=float(valid.mean()))
