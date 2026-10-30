"""Collapse pieces for the engine's section-collapse event (in panel_kit.glb, materials kit_panel + kit_city):
  collapse_pile_large  ~13 x 13 m, 4-7 m tall: pancaked floor slabs stacked / slid off a rubble mound, rebar,
                       broken facade panels (standing remnant + leaning + lying), balcony, furniture, chunks
  collapse_pile_small  ~7 x 7 m
  slab_hanging         floor slab hanging diagonally from the floor above on its top rebar
Piles: origin on the ground at the footprint centre, +Z = the facade side the building fell towards."""
import math
import numpy as np
from meshlib import MB, Region, Fit, Proj, slab, side_uv, rng, noise1d, newell, xform, mat_trs, rot_axis, ccw, resample_closed
from kit_design import W, H, T
from kitparts import R, rebar_bar, chunk, broken_off, len_uv, cloth
from kit_city_parts import R2, M1, chunk2, slab_m


class Mound:
    def __init__(self, half, Hm, seed, flat=2.0):
        self.half, self.Hm, self.flat = half, Hm, flat
        r = rng(seed)
        self.out = 1 + noise1d(32, seed, 3) * 0.12
        self.bumps = [(r.uniform(-half * 0.5, half * 0.5), r.uniform(-half * 0.5, half * 0.5), r.uniform(0.25, 0.5) * half, r.uniform(-0.2, 0.35) * Hm) for _ in range(6)]
        self.n = spectral2(seed)

    def h(self, x, z):
        a = math.atan2(z, x) % (2 * math.pi); k = a / (2 * math.pi) * 32
        i = int(k) % 32; f = k - int(k)
        rad = self.half * (self.out[i] * (1 - f) + self.out[(i + 1) % 32] * f)
        rr = max(abs(x), abs(z)) * 0.55 + math.hypot(x, z) * 0.45
        rr /= rad
        if rr >= 1:
            return -0.03
        v = self.Hm * (1 - rr ** self.flat)
        for bx, bz, br, bh in self.bumps:
            d = math.hypot(x - bx, z - bz) / br
            if d < 1:
                v += bh * (1 - d * d) ** 2 * (1 - rr)
        return max(-0.03, v + self.n(x, z) * 0.12 * (1 - rr))

    def build(self, mb, step=1.0):
        n = int(round(2 * self.half / step))
        xs = np.linspace(-self.half, self.half, n + 1)
        G = [[(x, self.h(x, z), z) for x in xs] for z in xs]
        reg = R2['rubble']
        for j in range(n):
            for i in range(n):
                q = [G[j + 1][i], G[j + 1][i + 1], G[j][i + 1], G[j][i]]
                if max(p[1] for p in q) < -0.02:
                    continue
                uv = [reg.uv(0, 0), reg.uv(1, 0), reg.uv(1, 1), reg.uv(0, 1)]
                for tri in ((0, 1, 2), (0, 2, 3)):
                    mb.poly([q[t] for t in tri], lambda P, nn, tri=tri: [uv[t] for t in tri], mat=M1)


def spectral2(seed):
    r = rng(seed)
    ph = r.uniform(0, 6.28, 6); fr = r.uniform(0.6, 1.8, 6); dirs = r.uniform(0, 3.14, 6)
    return lambda x, z: sum(math.sin((x * math.cos(d) + z * math.sin(d)) * f + p) for p, f, d in zip(ph, fr, dirs)) / 3


def floor_slab(w, d, seed, broken_sides=(0, 1, 2), th=0.22, top='floor'):
    """Broken floor slab (local: x 0..w across, z 0..-d inward, top at y=th). broken_sides: 0 front(z=0), 1 right, 2 back, 3 left."""
    r = rng(seed)
    corners = [(0, 0), (w, 0), (w, d), (0, d)]
    pts, bm = [], []
    for e in range(4):
        a, b = np.array(corners[e], float), np.array(corners[(e + 1) % 4], float)
        L = np.linalg.norm(b - a); n = max(2, int(L / 0.45))
        nrm = np.array([-(b - a)[1], (b - a)[0]]) / L  # left normal (inward for CCW)
        for k in range(n):
            t = k / n; p = a + (b - a) * t
            if e in broken_sides and 0 < k:
                p = p + nrm * abs(r.normal(0.18, 0.15))
            pts.append(p); bm.append(e in broken_sides and k > 0)
    P = np.array(pts); bm = np.array(bm)
    topu = Proj(R[top if top != 'dust' else 'floor'], (1, 0, 0), (0, 1, 0), (0, 0), (max(w, 3.2), max(d, 3.2)))
    bot = Proj(R['ceiling'], (1, 0, 0), (0, 1, 0), (0, 0), (max(w, 3.2), max(d, 3.2)))
    sect, sectc = side_uv(R['section'], 2.0), side_uv(R['section_clean'], 2.0)
    def sd(a, b, fa, fb, li, k, P_, i):
        n = len(bm)
        return (sect if (bm[i] or bm[(i + 1) % n]) else sectc)(a, b, fa, fb, li)
    tmp = MB()
    if top == 'dust':
        topu = Proj(R2['dust'], (1, 0, 0), (0, 1, 0), (0, 0), (max(w, 3.2), max(d, 3.2)))
    slab_m(tmp, [{'pts': ccw(P), 'off': broken_off(len(P), seed, bm, ch=0.0, levels=3, scale=0.6)}], [0, -0.06, -th], topu, bot, sd,
           front_mat=M1 if top == 'dust' else 0, back_mat=0, side_mat=0)
    mb = MB()
    mb.merge(tmp, np.array([[1, 0, 0, 0], [0, 0, 1, th], [0, -1, 0, 0], [0, 0, 0, 1.0]]))
    edge = [np.array([p[0], th * 0.4, -p[1]]) for p, b_ in zip(P, bm) if b_]
    return mb, edge


def hang_rebar(mb, pts, M, seed, n=6, length=(0.3, 1.0)):
    r = rng(seed)
    if not pts:
        return
    for k in range(n):
        p = pts[r.integers(0, len(pts))]
        q = xform(np.array([p]), M)[0]
        L = r.uniform(*length)
        d = np.array([r.normal(0, 0.3), -1.0, r.normal(0, 0.3)]); d /= np.linalg.norm(d)
        out = q - np.array([0, 0, 0]); out[1] = 0; out /= (np.linalg.norm(out) + 1e-6)
        rebar_bar(mb, [q - out * 0.05, q + out * 0.15, q + out * 0.25 + d * L * 0.5, q + out * 0.3 + d * L])


def kit_piece(fn, *a):
    import build_kit as BK
    return getattr(BK, fn)(*a)


def scatter_chunks(mb, mound, n, half, seed, regions=('section', 'section_clean')):
    r = rng(seed)
    for k in range(n):
        x, z = r.uniform(-half, half), r.uniform(-half, half)
        y = mound.h(x, z)
        if y < 0.0:
            continue
        sz = r.uniform(0.2, 0.7)
        if k % 5 == 4:
            chunk2(mb, (x, y + sz * 0.15, z), (sz, sz * 0.35, sz * 0.8), seed + k, 'dust')
        else:
            chunk(mb, (x, y + sz * 0.15, z), (sz, sz * 0.4, sz * 0.8), seed + k, region=regions[k % len(regions)])


def collapse_pile(name, half, Hm, layers, seed, panels, extras):
    mb = MB(name); r = rng(seed)
    mound = Mound(half, Hm, seed)
    mound.build(mb, step=1.0 if half > 4 else 0.875)
    # pancaked slabs: (w, d, cx, y, cz, yaw, tilt_x, tilt_z, top)
    for i, (w, d, cx, y, cz, yaw, tx, tz, top) in enumerate(layers):
        sm, edge = floor_slab(w, d, seed + 10 + i, broken_sides=(0, 1, 2, 3), top=top)
        M = mat_trs((cx, y, cz), (tx, yaw, tz)) @ mat_trs((-w / 2, 0, d / 2))
        mb.merge(sm, M)
        hang_rebar(mb, edge, M, seed + 30 + i, n=5)
        # crushed layer under the slab: dark gap filler chunks so the stack reads as pancaked storeys
        for k in range(4):
            px, pz = r.uniform(-w / 2.5, w / 2.5), r.uniform(-d / 2.5, d / 2.5)
            q = xform(np.array([[px + w / 2, -0.15, -(pz + d / 2)]]), M)[0]
            chunk(mb, (q[0], q[1], q[2]), (r.uniform(0.4, 0.9), 0.25, r.uniform(0.4, 0.8)), seed + 50 + i * 5 + k, region='section')
    for (fn, args, M) in panels:
        mb.merge(kit_piece(fn, *args), M)
    for (fn, M) in extras:
        mb.merge(kit_piece(fn), M)
    return mb, mound


def collapse_pile_large():
    s = 7100
    layers = [  # bottom -> top; slabs 3.2 wide (precast), crushed stack slid towards +Z
        (6.4, 5.6, -0.6, 0.9, -0.8, 0.05, 0.03, -0.04, 'dust'),
        (6.2, 5.8, 0.2, 1.65, -0.4, -0.08, -0.05, 0.03, 'dust'),
        (6.4, 5.4, -0.3, 2.35, 0.1, 0.12, 0.06, 0.05, 'floor'),
        (5.8, 5.6, 0.5, 3.0, 0.4, -0.03, -0.04, -0.06, 'dust'),
        (6.0, 5.0, 0.1, 3.75, -0.1, 0.2, 0.08, 0.04, 'roofing'),
        (3.2, 5.6, 4.0, 1.7, 1.2, 0.3, 0.05, -0.42, 'dust'),        # slid off to the right, resting on the mound
        (3.2, 4.8, -4.2, 1.3, 1.8, -0.4, 0.38, 0.35, 'floor'),         # tipped towards the street
        (3.2, 3.6, 1.0, 1.25, 4.4, 0.15, 0.32, -0.05, 'dust'),
    ]
    panels = [
        # standing remnant of the facade at the back (gives the 6-7 m silhouette)
        ('build_wall', ('wall_blank_end', 'destroyed'), mat_trs((-4.6, 4.0, -4.3), (0.04, 0.25, 0.02))),
        ('build_wall', ('wall_window', 'damaged'), mat_trs((-2.0, 3.85, -3.4), (-0.05, 0.05, 0.03))),
        ('build_wall', ('wall_window', 'holed'), mat_trs((1.4, 3.9, -3.0), (-0.25, -0.08, 0.0))),
        # panels lying / leaning on the pile
        ('build_wall', ('wall_balcony', 'intact'), mat_trs((-5.6, 0.6, 3.7), (-1.15, 0.3, 0.05))),
        ('build_wall', ('wall_window', 'damaged'), mat_trs((2.6, 1.8, 3.6), (-1.3, -0.35, 0.12))),
        ('build_wall', ('wall_window', 'destroyed'), mat_trs((3.8, 3.3, -2.3), (-0.6, 0.6, -0.1))),
        ('build_balcony_hanging', (), mat_trs((-3.0, 2.0, 2.6), (0.3, 0.2, 0.25))),
        ('build_slab_floor', (True,), mat_trs((-1.0, 4.3, 1.5), (0.1, 1.2, -0.1))),
    ]
    extras = [('build_wardrobe', mat_trs((2.2, 4.0, -1.0), (0.2, 0.7, 0.15))),
              ('build_bed', mat_trs((-2.0, 3.98, 1.0), (0.05, -0.4, 0.1))),
              ('build_table', mat_trs((4.2, 2.3, 3.4), (0.3, 1.2, 0.2))),
              ('build_radiator_debris', mat_trs((-3.4, 2.2, 4.8), (0.4, 0.3, 0))),
              ('build_radiator_debris', mat_trs((0.4, 4.05, -1.6), (0.0, 1.0, 0))),
              ('build_table', mat_trs((-5.0, 1.0, -1.0), (0.6, 0.2, 0.4)))]
    mb, mound = collapse_pile('collapse_pile_large', 6.5, 2.0, layers, s, panels, extras)
    scatter_chunks(mb, mound, 70, 6.2, s + 200)
    # torn curtains / bedding draped over slab edges
    cloth(mb, [(-1.5 + 0.3 * j, 3.95, 2.9) for j in range(4)], lambda sv, tv, p: (p[0] + 0.1 * math.sin(tv * 3), p[1] - tv * 1.4, p[2] + tv * 0.3), 4, s + 300, region='fabric')
    cloth(mb, [(3.0, 3.05, -0.5 + 0.3 * j) for j in range(4)], lambda sv, tv, p: (p[0] + tv * 0.3, p[1] - tv * 1.1, p[2] + 0.08 * math.sin(sv * 5)), 4, s + 301, region='rag')
    return mb


def collapse_pile_small():
    s = 7300
    layers = [
        (3.2, 4.4, -0.3, 0.55, -0.2, 0.1, 0.04, -0.05, 'dust'),
        (3.2, 4.0, 0.2, 1.1, 0.1, -0.15, -0.06, 0.06, 'floor'),
        (3.2, 3.6, 0.0, 1.62, -0.3, 0.25, 0.05, 0.05, 'roofing'),
        (3.2, 3.4, 2.1, 0.8, 1.4, 0.5, 0.25, -0.35, 'dust'),
    ]
    panels = [
        ('build_wall', ('wall_window', 'destroyed'), mat_trs((-2.6, 1.6, -1.6), (-0.1, 0.35, 0.05))),
        ('build_wall', ('wall_blank_end', 'damaged'), mat_trs((-3.0, 0.45, 2.6), (-1.2, 0.25, 0.08))),
        ('build_wall', ('wall_window', 'damaged'), mat_trs((0.2, 1.75, -1.8), (-0.12, -0.2, 0.0))),
    ]
    extras = [('build_wardrobe', mat_trs((0.6, 1.85, 0.2), (0.1, 1.0, 0.1))),
              ('build_radiator_debris', mat_trs((1.6, 0.6, 2.4), (0.3, 0.5, 0)))]
    mb, mound = collapse_pile('collapse_pile_small', 3.5, 0.9, layers, s, panels, extras)
    scatter_chunks(mb, mound, 34, 3.3, s + 200)
    cloth(mb, [(-0.6 + 0.3 * j, 1.86, 1.6) for j in range(3)], lambda sv, tv, p: (p[0], p[1] - tv * 0.9, p[2] + tv * 0.25), 4, s + 300, region='fabric')
    return mb


def slab_hanging():
    """Floor slab of the storey above, torn off at the facade side and hanging diagonally on its top rebar from the
    interior support line. Slab-floor frame (x 0..3.2 across, -z inward): hinge = slab top at y = H, z = -W;
    free edge rests on the floor below (y ~ 0) at z ~ -1.6. 3.2 x 3.2 x 0.22 slab."""
    mb = MB('slab_hanging'); s = 7500; r = rng(s)
    th = 0.22
    sm, edge = floor_slab(W, W - 0.08, s, broken_sides=(0,), th=th)
    # sm: x 0..W, top at y=th, z 0..-d (z=0 = broken facade edge). Hinge line = back edge top (z=-d, y=th)
    d = W - 0.08
    ang = math.asin((H - 0.05) / d)
    # move hinge to origin, rotate the facade edge down (about +X axis, negative angle drops +z side... )
    M = mat_trs((0, H, -W)) @ rot_axis((1, 0, 0), ang) @ mat_trs((0, -th, d))
    # check direction: the free edge (z=0 local) must end lower than the hinge
    test = xform(np.array([[1.0, th, 0.0]]), M)[0]
    if test[1] > H:
        M = mat_trs((0, H, -W)) @ rot_axis((1, 0, 0), -ang) @ mat_trs((0, -th, d))
    M = M @ rot_axis((0, 0, 1), 0.04, origin=(W / 2, th, -d))
    mb.merge(sm, M)
    # top rebar mesh bent over the hinge into the remaining slab (stubs at y = H)
    for k, x in enumerate(np.linspace(0.2, W - 0.2, 9)):
        a = xform(np.array([[x, th - 0.03, -d + 0.25]]), M)[0]
        b = np.array([x + r.normal(0, 0.03), H + th - 0.03, -W - 0.15])
        mid = (a + b) / 2 + np.array([0, 0.12, 0.1])
        rebar_bar(mb, [a, mid, b, b + np.array([0, 0, -0.25])])
    # bottom bars torn at the facade edge, chunks at the foot
    hang_rebar(mb, edge, M, s + 3, n=6, length=(0.2, 0.6))
    for k in range(5):
        foot = xform(np.array([[r.uniform(0.2, W - 0.2), 0, 0.2]]), M)[0]
        sz = r.uniform(0.2, 0.45)
        chunk(mb, (foot[0], sz * 0.2, foot[2] + r.uniform(0.0, 0.5)), (sz, sz * 0.4, sz * 0.8), s + 10 + k)
    return mb


def build_all():
    return [collapse_pile_large(), collapse_pile_small(), slab_hanging()]
