"""Builds assets/env/rubble_1..6.glb: piles of actual broken panel fragments, floor slabs, bricks, rebar, wood,
insulation, furniture bits on a low dust mound. Shared 1024^2 debris atlas = half-res kit atlas whose top two
facade rows are replaced by rubble ground / silicate brick / plank textures.
Run: cd tools/blender/env && nice -n 10 python3 build_rubble.py
"""
import os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from PIL import Image
from meshfix import fix_mb, settle_islands
from meshlib import *
from kitparts import R, chunk, rebar_bar, broken_off, side_uv, radiator, shards, cloth, frame_box, facade_region, len_uv
from kit_design import W, H, T, TYPES
import kit_atlas as KA
from texlib import CACHE, spectral, colorize, norm01, srgb, lerp, to8, normal_from_height, smoothstep, blur, rng as trng

# extra regions (2048-equivalent pixel coords, same as kit atlas layout)
R['ground'] = Region(0, 448, 896, 1344)
R['silicate'] = Region(896, 448, 1792, 1344)
R['planks'] = Region(1792, 448, 2048, 1344)
for _i, _t in enumerate(TYPES):
    R['fac%d' % _i] = facade_region(_t, 'intact')


def build_debris_atlas():
    kit = [os.path.join(CACHE, f'kit_atlas_1k_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    tex = os.path.join(REPO, 'assets', 'textures')
    out = [os.path.join(CACHE, f'debris_atlas_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    # planks: weathered boards (painted and bare), 128 x 448
    h, w = 448, 128
    r = trng(5)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    grain = np.sin(xx * 0.9 + spectral(0, 2, 6, fmin=2, fmax=40, shape=(h, w)) * 3)
    board = (xx // 32).astype(int)
    tone = r.random(4)[board]
    alb = lerp(srgb('#4a3a2a'), srgb('#7a6448'), (grain * 0.5 + 0.5) * 0.5 + tone[..., None] * 0.5 if False else (grain * 0.25 + 0.5 + tone * 0.3 - 0.15))
    paint = (board == 1) | (board == 3)
    alb = np.where(paint[..., None], lerp(alb, srgb('#8f9a8a'), smoothstep(-0.5, 1.0, spectral(0, 1.5, 7, fmin=4, fmax=60, shape=(h, w))) * 0.8), alb)
    gap = ((xx % 32) < 2).astype(np.float32)
    alb = lerp(alb, srgb('#1e1a16'), gap)
    p_alb = to8(alb); p_nrm = normal_from_height(grain * 0.4 - gap * 3, 1.0, wrap=False)
    p_orm = to8(np.stack([1 - gap * 0.5, np.full((h, w), 0.85), np.zeros((h, w))], -1))
    for i, (src, gsuf) in enumerate(zip(kit, ('albedo.jpg', 'normal.png', 'orm.png'))):
        im = Image.open(src).convert('RGB')
        tp = lambda n: os.path.join(tex, n) if os.path.exists(os.path.join(tex, n)) else os.path.join(tex, n[:-4] + '.jpg')   # ground maps may be JPG now
        g0 = Image.open(tp(f'rubble_{gsuf}')).convert('RGB').resize((150, 150), Image.LANCZOS)
        g1 = Image.new('RGB', (448, 448))
        for gx in range(3):
            for gy in range(3):
                g1.paste(g0, (gx * 150, gy * 150))
        g2 = Image.open(tp(f'brick_{gsuf}')).convert('RGB').resize((448, 448), Image.LANCZOS)
        if i == 0:
            g1 = Image.fromarray((np.asarray(g1).astype(np.float32) * np.array([0.78, 0.76, 0.74])).astype(np.uint8))
        im.paste(g1, (0, 224)); im.paste(g2, (448, 224))
        im.paste(Image.fromarray([p_alb, p_nrm, p_orm][i]), (896, 224))
        if out[i].endswith('.jpg'):
            im.save(out[i], quality=88, optimize=True)
        else:
            im.save(out[i], optimize=True, compress_level=9)
    return out


class Mound:
    def __init__(self, R_, H_, seed, flat=1.5, rings=9, sectors=28):
        self.R, self.H, self.seed, self.flat = R_, H_, seed, flat
        r = rng(seed)
        self.outline = 1 + noise1d(sectors, seed, 3) * 0.22
        self.bumps = [(r.uniform(-R_ * 0.5, R_ * 0.5), r.uniform(-R_ * 0.5, R_ * 0.5), r.uniform(0.3, 0.8) * R_, r.uniform(-0.25, 0.35) * H_) for _ in range(5)]
        self.rings, self.sectors = rings, sectors
        self.jit = rng(seed + 1)

    def rad(self, a):
        k = (a / (2 * math.pi)) * self.sectors
        i = int(math.floor(k)) % self.sectors; f = k - math.floor(k)
        return self.R * (self.outline[i] * (1 - f) + self.outline[(i + 1) % self.sectors] * f)

    def h(self, x, z):
        a = math.atan2(z, x) % (2 * math.pi); rr = math.hypot(x, z) / self.rad(a)
        if rr >= 1:
            return 0.0
        v = self.H * (1 - rr ** self.flat)
        for bx, bz, br, bh in self.bumps:
            d = math.hypot(x - bx, z - bz) / br
            if d < 1:
                v += bh * (1 - d * d) ** 2 * (1 - rr)
        return max(0.0, v)

    def build(self, mb):
        reg = R['ground']; Rr = 3.5
        uv = lambda P, n: [reg.uv(0.5 + p[0] / (2 * Rr), 0.5 + p[2] / (2 * Rr)) for p in P]
        rings = []
        centre = mb.v((0, self.h(0, 0) - 0.05, 0))
        for i in range(1, self.rings + 1):
            t = i / self.rings
            row = []
            for j in range(self.sectors):
                a = 2 * math.pi * j / self.sectors + (i % 2) * math.pi / self.sectors
                rr = self.rad(a) * t
                x, z = math.cos(a) * rr, math.sin(a) * rr
                y = self.h(x * 0.999, z * 0.999) - 0.06 if i < self.rings else -0.02
                if i < self.rings:
                    y += self.jit.normal(0, 0.02 + 0.04 * self.H) * t
                    x += self.jit.normal(0, 0.02); z += self.jit.normal(0, 0.02)
                row.append(mb.v((x, y, z)))
            rings.append(row)
        S = self.sectors
        for j in range(S):
            tri = (centre, rings[0][(j + 1) % S], rings[0][j])
            P = np.array([mb.V[k] for k in tri])
            if newell(P)[1] < 0:
                tri = tri[::-1]; P = P[::-1]
            mb.face(tri, uv(P, None), True)
        for i in range(self.rings - 1):
            for j in range(S):
                a, b = rings[i][j], rings[i][(j + 1) % S]; c, d = rings[i + 1][(j + 1) % S], rings[i + 1][j]
                for tri in ((a, b, c), (a, c, d)):
                    P = np.array([mb.V[k] for k in tri])
                    if newell(P)[1] < 0:
                        tri = tri[::-1]; P = P[::-1]
                    mb.face(tri, uv(P, None), True)


def slab_fragment(mb, size, thick, seed, M, kind='panel', rebar=True):
    """Irregular fragment of an exterior panel (tile face + wallpaper back) or floor slab (linoleum/ceiling)."""
    r = rng(seed)
    sx, sy = size
    n = r.integers(6, 10)
    a = np.sort(r.uniform(0, 2 * np.pi, n))
    rad = r.uniform(0.75, 1.0, n)
    P = np.stack([np.cos(a) * sx / 2 * rad, np.sin(a) * sy / 2 * rad], -1)
    P = resample_closed(ccw(P), 0.22)
    if kind == 'panel':
        t = TYPES[r.integers(0, 4)]
        fr = facade_region(t, 'intact')
        ox, oy = r.uniform(0.2, W - sx - 0.2 if sx < W - 0.4 else 0.2), r.uniform(0.2, H - sy - 0.2 if sy < H - 0.4 else 0.2)
        front = Proj(fr, (1, 0, 0), (0, 1, 0), (-ox - sx / 2, -oy - sy / 2), (W, H))
        back = Proj(R['interior'], (1, 0, 0), (0, 1, 0), (-ox - sx / 2, -oy - sy / 2), (W, H))
        sect = side_uv(R['section'], 2.0)
        lv = [0.0, -0.03, -0.075, -0.08, -0.19, -0.195, -0.27, -0.30]
        off = broken_off(len(P), seed, levels=8, scale=0.5)
    else:
        front = Proj(R['floor'], (1, 0, 0), (0, 1, 0), (-sx, -sy), (2 * sx + 0.01, 2 * sy + 0.01))
        back = Proj(R['ceiling'], (1, 0, 0), (0, 1, 0), (-sx, -sy), (2 * sx + 0.01, 2 * sy + 0.01))
        sect = side_uv(R['section_clean'], 2.0)
        lv = [0.0, -0.04, -0.18, -thick]
        off = broken_off(len(P), seed, levels=4, scale=0.5)
    tmp = MB()
    slab(tmp, [{'pts': P, 'off': off}], lv, front, back, lambda a_, b_, fa, fb, li, k, Q, i: sect(a_, b_, fa, fb, li))
    if rebar:
        for k in range(r.integers(1, 4)):
            i = r.integers(0, len(P)); p = P[i]; d = p / (np.linalg.norm(p) + 1e-9)
            z = -0.05 if r.random() < 0.5 else -thick + 0.05
            L = r.uniform(0.15, 0.5)
            bend = np.array([r.normal(0, 0.5), r.normal(0, 0.5), r.normal(0, 0.8)])
            p3 = np.array([p[0], p[1], z]); d3 = np.array([d[0], d[1], 0])
            rebar_bar(tmp, [p3 - d3 * 0.1, p3 + d3 * L * 0.3, p3 + d3 * L * 0.7 + bend * L * 0.3, p3 + d3 * L + bend * L * 0.6])
    mb.merge(tmp, M)


def brick(mb, M, seed, red=False, clump=1):
    reg = R['brick_red'] if red else R['silicate']
    L, Hh, D = 0.25, 0.065, 0.12
    r = rng(seed)
    for k in range(clump):
        off = mat_trs((0, k * (Hh + 0.01), (k % 2) * 0.06))
        f = Fit(reg, (0.52, 0.52), seed + k) if not red else Fit(reg, (0.3, 0.3), seed + k)
        tmp = MB()
        # chipped: jitter corners slightly
        tmp.box((-L / 2, 0, -D / 2), (L / 2, Hh, D / 2), f)
        V = np.array(tmp.V); V += r.normal(0, 0.006, V.shape); tmp.V = list(V)
        mb.merge(tmp, M @ off)


def plank(mb, M, length, seed, w=0.12, t=0.03):
    mb.box((0, 0, -w / 2), (length, t, w / 2), Fit(R['planks'], (0.25, 1.75), seed), M=M)


def lump(mb, M, size, seed, region='insulation'):
    chunk(mb, (0, 0, 0), size, seed, region=region, rot=(0, 0, 0), M=M)


def scatter_on(mound, r, rmax):
    for _ in range(50):
        a = r.uniform(0, 2 * np.pi); d = math.sqrt(r.random()) * rmax
        x, z = math.cos(a) * d, math.sin(a) * d
        return x, z, mound.h(x, z)


def build_pile(name, seed, R_, H_, n_slabs, n_chunks, n_bricks, red_frac=0.25, slab_kinds=('panel', 'floor'),
               tent=False, flat=1.6, extras=('radiator', 'frame', 'wood', 'insulation', 'rag'), mound=True, big=None):
    mb = MB(name); r = rng(seed)
    m = Mound(R_, H_, seed, flat=flat)
    if mound:
        m.build(mb)
    # big fragments resting on the slope, partially buried
    for k in range(n_slabs):
        x, z, y = scatter_on(m, r, R_ * 0.55)
        kind = slab_kinds[k % len(slab_kinds)]
        sx, sy = (r.uniform(1.0, 2.6), r.uniform(0.8, 1.9)) if big is None else big
        thick = 0.3 if kind == 'panel' else 0.22
        # orient: lie roughly along the slope, tilted
        yaw = r.uniform(0, 2 * np.pi); tilt = r.uniform(0.25, 1.1)
        Mf = mat_trs((x, y + 0.02, z)) @ mat_trs((0, 0, 0), (0, yaw, 0)) @ mat_trs((0, 0, 0), (-math.pi / 2 + tilt * r.choice([-1, 1]), 0, r.normal(0, 0.25)))
        slab_fragment(mb, (sx, sy), thick, seed * 31 + k, Mf, kind)
    if tent:
        # two floor slabs collapsed against each other ("pancake tent")
        for side in (-1, 1):
            Mf = mat_trs((side * 0.9, 0.0, 0)) @ mat_trs((0, 0, 0), (0, math.pi / 2, 0)) @ mat_trs((0, 0, 0), (-math.pi / 2 + side * 0.0, 0, 0)) @ \
                 rot_axis((1, 0, 0), side * 0.55)
            slab_fragment(mb, (2.6, 1.9), 0.22, seed + 900 + side, mat_trs((0, 0.75, side * 0.75)) @ rot_axis((1, 0, 0), side * 1.0) @ mat_trs((0, 0, 0), (0, 0, 0)), 'floor')
    regs = ['concrete', 'section', 'concrete', 'concrete', 'fac2', 'section', 'concrete', 'section_clean', 'concrete', 'section']
    for k in range(n_chunks):
        x, z, y = scatter_on(m, r, R_ * 1.0)
        s = (r.uniform(0.06, 0.2) if r.random() < 0.6 else r.uniform(0.2, 0.55)) * (1 - 0.45 * math.hypot(x, z) / R_)
        chunk(mb, (x, y + s * 0.12, z), (s, s * r.uniform(0.35, 0.7), s * r.uniform(0.6, 1.0)), seed * 7 + k,
              region=regs[k % len(regs)])
    for k in range(n_bricks):
        x, z, y = scatter_on(m, r, R_ * 1.05)
        red = r.random() < red_frac
        Mb = mat_trs((x, y - 0.01, z), (r.normal(0, 0.35), r.uniform(0, 6.3), r.normal(0, 0.35)))
        brick(mb, Mb, seed * 13 + k, red, clump=1 if r.random() < 0.75 else r.integers(2, 4))
    # loose bent rebar
    for k in range(r.integers(1, 4)):
        x, z, y = scatter_on(m, r, R_ * 0.8)
        a = r.uniform(0, 2 * np.pi); L = r.uniform(0.6, 1.5)
        d = np.array([math.cos(a), 0, math.sin(a)])
        p0 = np.array([x, y + 0.03, z])
        pts = [p0, p0 + d * L * 0.35 + [0, r.uniform(0.0, 0.15), 0], p0 + d * L * 0.7 + [r.normal(0, 0.2), r.uniform(0.05, 0.3), r.normal(0, 0.2)], p0 + d * L + [r.normal(0, 0.3), r.uniform(-0.1, 0.3), r.normal(0, 0.3)]]
        rebar_bar(mb, pts)
    if 'wood' in extras:
        for k in range(r.integers(2, 5)):
            x, z, y = scatter_on(m, r, R_ * 0.9)
            plank(mb, mat_trs((x, y + 0.02, z), (r.normal(0, 0.3), r.uniform(0, 6.3), r.normal(0, 0.4))), r.uniform(0.6, 1.8), seed + k)
    if 'frame' in extras:
        x, z, y = scatter_on(m, r, R_ * 0.6)
        tmp = MB()
        frame_box(tmp, (0, 0, -0.07), (1.4, 0.07, 0), '+z-z+y-y', 'wood_paint', seed)
        frame_box(tmp, (0, 0.07, -0.07), (0.07, 1.2, 0), '+z-z+x-x', 'wood_paint', seed + 1)
        frame_box(tmp, (0.65, 0.07, -0.07), (0.72, 1.2, 0), '+z-z+x-x', 'wood_paint', seed + 2)
        shards(tmp, (0.07, 0.07, 0.65, 1.0), -0.035, seed + 3, 3)
        mb.merge(tmp, mat_trs((x, y + 0.1, z), (-1.2, r.uniform(0, 6.3), 0.2)))
    if 'insulation' in extras:
        for k in range(2):
            x, z, y = scatter_on(m, r, R_ * 0.8)
            lump(mb, mat_trs((x, y + 0.05, z), (r.normal(0, 0.4), r.uniform(0, 6), r.normal(0, 0.4))), (r.uniform(0.3, 0.6), 0.1, r.uniform(0.25, 0.5)), seed + 50 + k)
    if 'radiator' in extras:
        x, z, y = scatter_on(m, r, R_ * 0.6)
        radiator(mb, 0, 0, 0, w=0.8, M=mat_trs((x, y + 0.05, z), (-1.3, r.uniform(0, 6), 0.3)), pipes=False)
    if 'rag' in extras:
        x, z, y = scatter_on(m, r, R_ * 0.6)
        top = [(x + 0.15 * j, y + 0.05, z) for j in range(4)]
        cloth(mb, top, lambda s, t, p: (p[0] + 0.05 * math.sin(t * 5), p[1] + 0.06 * math.sin(s * 7 + t * 3), p[2] + t * 0.6), 4, seed + 70, region='fabric')
    if 'chair' in extras:
        x, z, y = scatter_on(m, r, R_ * 0.7)
        v = Fit(R['veneer'], (0.6, 0.6), seed)
        tmp = MB(); tmp.box((0, 0.43, 0), (0.42, 0.46, 0.42), v); tmp.box((0, 0.46, 0.38), (0.42, 0.9, 0.42), v)
        for (px, pz) in ((0, 0), (0.38, 0), (0, 0.38)):
            tmp.box((px, 0, pz), (px + 0.035, 0.43, pz + 0.035), v, faces='+x-x+z-z')
        mb.merge(tmp, mat_trs((x, y + 0.2, z), (0.3, r.uniform(0, 6), 1.4)))
    return mb


def main():
    paths = build_debris_atlas()
    files = []
    specs = [
        # name, seed, radius, height, slabs, chunks, bricks, kwargs
        ('rubble_1', 11, 3.4, 1.2, 7, 110, 50, dict(red_frac=0.15, extras=('radiator', 'frame', 'wood', 'insulation', 'rag', 'chair'))),
        ('rubble_2', 22, 2.6, 0.8, 2, 60, 110, dict(red_frac=0.35, slab_kinds=('panel',), extras=('wood', 'insulation', 'frame'))),
        ('rubble_3', 33, 3.0, 0.6, 2, 70, 30, dict(tent=True, slab_kinds=('floor',), extras=('radiator', 'wood', 'rag', 'chair'))),
        ('rubble_4', 44, 2.0, 0.22, 1, 60, 40, dict(red_frac=0.2, flat=3.0, extras=('wood', 'frame', 'insulation'))),
        ('rubble_5', 55, 1.8, 0.2, 1, 30, 10, dict(slab_kinds=('panel',), flat=3.0, big=(2.6, 2.0), extras=('wood',))),
        ('rubble_6', 66, 1.8, 0.1, 0, 20, 90, dict(red_frac=0.3, flat=4.0, extras=('wood',))),
    ]
    info = {}
    for name, seed, R_, H_, ns, nc, nb, kw in specs:
        reset_scene()
        mat = make_material('debris', *paths)
        mb = build_pile(name, seed, R_, H_, ns, nc, nb, **kw)
        settle_islands(mb)       # no debris pieces hovering above the pile
        fix_mb(mb)
        ob = mb.to_object(name, [mat])
        out = os.path.join(REPO, 'assets', 'env', name + '.glb')
        size = export_glb(out)
        mn, mx = mb.bounds()
        info[name] = {'tris': mb.tris(), 'bbox_min': [round(float(v), 2) for v in mn], 'bbox_max': [round(float(v), 2) for v in mx], 'bytes': size}
        print(name, mb.tris(), 'tris', round(size / 1e6, 2), 'MB', np.round(mn, 2), np.round(mx, 2))
        files.append(name)
    update_manifest('rubble_files', files)
    update_manifest('rubble', {'notes': 'origin = ground centre of the pile, +Y up. One mesh per file, material "debris" (1024^2 atlas). '
                               'rubble_1 big panel-fragment pile, rubble_2 brick-heavy pile, rubble_3 collapsed floor slabs "tent", '
                               'rubble_4 low street debris, rubble_5 loose panel slab with rebar, rubble_6 brick scatter.', 'files': info})


if __name__ == '__main__':
    main()
