"""Geometry for modern.glb (material 0 = modern_atlas, material 1 = modern_alpha): a Soviet microdistrict as it looks in
Ukraine 2022-24 -- renovated kindergarten, district boiler house, supermarket box, pharmacy pavilion, garages, modern
street furniture, modern cars, and war additions (checkpoint, sandbagged windows, anti-drone net tunnel), plus
damaged / burnt variants.  glTF space: +Y up, metres, origin = ground centre of the footprint, long axis along X
(cars / bus: front = +X).  Ambient occlusion, soot and burn darkening are baked into per-vertex colour (TMB.VC, linear
multiplier) so the shared atlas regions stay tileable.  Helpers shared with the city / farmland builders (city_geo:
tquad / tbox / wall / tube / lathe ...) resolve region names through G.R, pointed at the modern atlas here.
"""
import math
import numpy as np
from shapely.geometry import Polygon, Point, box as sbox
from meshlib import MB, Region, Fit, newell, xform, mat_trs, rot_axis, rng, blob
import modern_atlas as MA
import city_geo as G

G.R = {k: Region(*v, pad=MA.PAD) for k, v in MA.REG.items()}
from city_geo import tquad, tbox, fbox, wall, lathe, prism, quad, chunk, tube   # noqa: E402

AR = {k: Region(*v, S=MA.SA, pad=MA.PAD) for k, v in MA.AREG.items()}
OPA, ALP = 0, 1
PI = math.pi
CARS = MA.CARS


class TMB(MB):
    """MB + per-vertex linear colour multiplier (VC) -> glTF COLOR_0."""
    def __init__(self, name='mesh'):
        super().__init__(name); self.VC = {}; self.VN = {}

    def merge(self, other, M=None):
        off = len(self.V)
        super().merge(other, M)
        if isinstance(other, TMB):
            for k, v in other.VC.items():
                self.VC[k + off] = v
        return self


def T(x=0.0, y=0.0, z=0.0):
    return mat_trs((x, y, z))


def RY(a, t=(0, 0, 0)):
    return mat_trs(t, (0, a, 0))


def RS(name, s0, t0, s1, t1):
    return G.R[name].sub(s0, t0, s1, t1)


WHITE = lambda: RS('pharm_panel', 0.4, 0.27, 0.6, 0.47)        # clean white composite / PVC trim
RED = lambda: RS('plastic_play', 0.05, 0.55, 0.45, 0.95)
YEL = lambda: RS('plastic_play', 0.55, 0.55, 0.95, 0.95)
BLUE = lambda: RS('plastic_play', 0.05, 0.05, 0.45, 0.45)
GREEN = lambda: RS('plastic_play', 0.55, 0.05, 0.95, 0.45)


def tint(mb, fn, start=0):
    """Per-vertex colour multiplier fn(p) -> scalar or rgb for vertices start.. (AO / soot / burn).  Linear values:
    0.5 only darkens ~25 % perceptually, use 0.15-0.3 for real soot."""
    V = np.array(mb.V)
    for i in range(start, len(V)):
        k = fn(V[i])
        k = np.array([k, k, k]) if np.isscalar(k) else np.asarray(k, float)
        prev = mb.VC.get(i, np.ones(3))
        mb.VC[i] = prev * np.clip(k, 0, 1.5)


def soot_blob(c, r, k=0.2, up=1.0):
    """Soot around c, stretched upwards by `up` (plumes rise)."""
    c = np.asarray(c, float)
    def f(p):
        d = p - c
        dy = d[1] / up if d[1] > 0 else d[1] * 1.6
        return 1 - (1 - k) * math.exp(-(d[0] ** 2 + d[2] ** 2 + dy ** 2) / (r * r))
    return f


def ground_ao(h=0.8, k=0.55):
    return lambda p: k + (1 - k) * min(1.0, max(0.0, p[1] / h))


def frame(o, X, Y=(0, 1, 0)):
    X = np.asarray(X, float); Y = np.asarray(Y, float)
    X = X / np.linalg.norm(X); Y = Y - X * np.dot(X, Y); Y /= np.linalg.norm(Y); Z = np.cross(X, Y)
    M = np.eye(4); M[:3, 0] = X; M[:3, 1] = Y; M[:3, 2] = Z; M[:3, 3] = o
    return M


def edge_frame(a, b):
    """Wall frame on the ground edge a -> b (x, z): local X along the edge, Y up, Z = X x Y (outward for a CW-from-
    above traversal, i.e. walk with the building on your left)."""
    a3 = np.array([a[0], 0.0, a[1]]); b3 = np.array([b[0], 0.0, b[1]])
    return frame(a3, b3 - a3), float(np.linalg.norm(b3 - a3))


def outward_edges(poly):
    """Edges of a footprint polygon (x, z) oriented so edge_frame's +Z points out of the building."""
    P = [tuple(map(float, p)) for p in poly]; sp = Polygon(P)
    out = []
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]
        d = np.array([b[0] - a[0], b[1] - a[1]]); nrm = np.array([-d[1], d[0]]) / np.linalg.norm(d)   # = local Z (x, z)
        mid = (np.array(a) + np.array(b)) / 2
        if sp.contains(Point(*(mid + nrm * 0.05))):
            a, b = b, a
        out.append((a, b))
    return out


def beam(mb, a, b, w, h, reg, tile=(2.5, 1.0), up=(0, 1, 0), faces='all'):
    a = np.asarray(a, float); b = np.asarray(b, float); d = b - a; L = float(np.linalg.norm(d)); d /= L
    up = np.asarray(up, float); s = np.cross(d, up)
    if np.linalg.norm(s) < 1e-6:
        s = np.cross(d, [1, 0, 0])
    s /= np.linalg.norm(s); u = np.cross(s, d)
    M = np.eye(4); M[:3, 0] = d; M[:3, 1] = u; M[:3, 2] = s; M[:3, 3] = a
    tbox(mb, (0, -h / 2, -w / 2), (L, h / 2, w / 2), reg, tile, M=M, faces=faces)


def cyl(mb, p0, p1, r, sides, reg, seg=50.0, cap=False):
    G.tube(mb, [p0, p1], r, sides, reg, seg=seg, cap=cap)


def disc(mb, c, nrm, r, n, reg, rad_uv=0.5, centre=(0.5, 0.5), mat=OPA):
    c = np.asarray(c, float); nrm = np.asarray(nrm, float); nrm /= np.linalg.norm(nrm)
    a = np.cross(nrm, [0, 1, 0] if abs(nrm[1]) < 0.9 else [1, 0, 0]); a /= np.linalg.norm(a); b = np.cross(nrm, a)
    rg = G.R[reg] if isinstance(reg, str) else reg
    ts = np.linspace(0, 2 * PI, n, endpoint=False)
    P = [c + (a * math.cos(t) + b * math.sin(t)) * r for t in ts]
    uv = [rg.uv(centre[0] + rad_uv * math.cos(t), centre[1] + rad_uv * math.sin(t)) for t in ts]
    if np.dot(newell(np.array(P)), nrm) < 0:
        P = P[::-1]; uv = uv[::-1]
    mb.face(mb.vs(P), uv, False, mat)


def aquad(mb, P, reg, uvs=((0, 0), (1, 0), (1, 1), (0, 1))):
    """Alpha-material quad (double sided material, so one face)."""
    rg = AR[reg] if isinstance(reg, str) else reg
    mb.face(mb.vs([np.asarray(p, float) for p in P]), [rg.uv(*u) for u in uvs], False, ALP)


def agrid(mb, f, u0, u1, v0, v1, reg, tile=(2.0, 2.0), cell=1.0):
    """Alpha sheet over the (u, v) rectangle, point = f(u, v); cells never straddle a texture tile so the 2 m net
    region repeats."""
    rg = AR[reg] if isinstance(reg, str) else reg
    def cuts(a, b, t):
        xs = [a]
        k = math.floor(a / t) + 1
        while k * t < b - 1e-6:
            xs.append(k * t); k += 1
        xs.append(b)
        out = []
        for p, q in zip(xs[:-1], xs[1:]):
            n = max(1, int(math.ceil((q - p) / cell - 1e-6)))
            out += [p + (q - p) * i / n for i in range(n)]
        return out + [b]
    us, vs_ = cuts(u0, u1, tile[0]), cuts(v0, v1, tile[1])
    for i in range(len(us) - 1):
        for j in range(len(vs_) - 1):
            a, b, c, d = (us[i], vs_[j]), (us[i + 1], vs_[j]), (us[i + 1], vs_[j + 1]), (us[i], vs_[j + 1])
            tu0 = math.floor((us[i] + 1e-6) / tile[0]) * tile[0]; tv0 = math.floor((vs_[j] + 1e-6) / tile[1]) * tile[1]
            uv = [rg.uv((p[0] - tu0) / tile[0], (p[1] - tv0) / tile[1]) for p in (a, b, c, d)]
            mb.face(mb.vs([f(*p) for p in (a, b, c, d)]), uv, False, ALP)


def rubble(mb, cx, cz, rad, n, seed, regs=('concrete', 'brick_white', 'facade_peach'), hmax=1.2, y0=0.0):
    """Rubble mound: low irregular cone + scattered chunks."""
    r = rng(seed)
    segs, rings = 9, 3
    ids = []
    for i in range(rings + 1):
        t = i / rings; row = []
        for k in range(segs):
            a = 2 * PI * k / segs
            rr = rad * (1 - t) * (1 + r.normal(0, 0.12)) if i < rings else 0.0
            y = y0 + hmax * (1 - (1 - t) ** 1.6) * (1 + r.normal(0, 0.1)) if i > 0 else y0 + 0.02
            row.append(mb.v((cx + math.cos(a) * rr, y, cz + math.sin(a) * rr)))
        ids.append(row)
    rg = G.R['concrete']
    for i in range(rings):
        for k in range(segs):
            k2 = (k + 1) % segs
            for tri in ((ids[i][k], ids[i + 1][k], ids[i][k2]), (ids[i][k2], ids[i + 1][k], ids[i + 1][k2])):
                P = np.array([mb.V[t] for t in tri])
                if np.linalg.norm(np.cross(P[1] - P[0], P[2] - P[0])) < 1e-8:
                    continue
                if newell(P)[1] < 0:
                    tri = tri[::-1]; P = P[::-1]
                mb.face(tri, [rg.uv(0.5 + (p[0] - cx) / (2.5 * rad), 0.5 + (p[2] - cz) / (2.5 * rad)) for p in P], True)
    for k in range(n):
        a = r.uniform(0, 2 * PI); d = rad * math.sqrt(r.random()) * 1.1
        s = r.uniform(0.25, 0.9)
        y = y0 + hmax * max(0.0, 1 - d / rad) * 0.8
        chunk(mb, (cx + math.cos(a) * d, y + s * 0.2, cz + math.sin(a) * d), (s, s * r.uniform(0.3, 0.7), s * r.uniform(0.5, 1)), seed + k, regs[k % len(regs)])


# ====================================================================== building helpers
def facade_wall(mb, a, b, y0, y1, reg, tile, holes=(), th=0.3, back=False, side='concrete', outline=None, cut=()):
    """Wall on edge a->b from y0 to y1 (or a custom local outline), holes in local (x, y).  cut = extra shapes removed
    from the outline (collapse)."""
    M, L = edge_frame(a, b)
    ol = outline if outline is not None else (0.0, y0, L, y1)
    hs = list(holes) + list(cut)
    wall(mb, ol, th, reg, tile, holes=hs, M=M, back=back, side=side, cap='none')
    return M, L


def window_set(mb, M, x0, y0, w, h, kind='pvc', depth=0.12, sill=True):
    reg = {'pvc': 'window_pvc', 'taped': 'window_taped', 'burnt': 'window_burnt', 'board': RS('door_board', 0.5, 0, 1, 1)}.get(kind, kind)
    tquad(mb, (x0, y0, -depth), (1, 0, 0), (0, 1, 0), w, h, reg, (w, h), M=M)
    if sill:
        tbox(mb, (x0 - 0.06, y0 - 0.05, -depth), (x0 + w + 0.06, y0, 0.07), WHITE() if kind != 'burnt' else 'soot', (w + 0.2, 0.3), M=M, faces='+y+z-x+x')


def slab(mb, poly_xz, y, th, reg, tile=(3.0, 3.0), holes=(), back='concrete'):
    """Horizontal slab (top at y) from a footprint polygon (x, z); holes likewise (x, z)."""
    M = frame((0, y, 0), (1, 0, 0), (0, 0, -1))       # local (u, v) = (x, -z), +Z local = up
    tr = lambda P: [(p[0], -p[1]) for p in P] if not isinstance(P, tuple) or len(P) != 4 or not np.isscalar(P[0]) else (P[0], -P[3], P[2], -P[1])
    wall(mb, tr(poly_xz), th, reg, tile, holes=[tr(h) for h in holes], M=M, back=back, side='concrete', cap='all')


def roof_plane(mb, o, eave_dir, slope_dir, Lu, Lv, reg, tile=(2.0, 2.0), th=0.16, holes=(), back='interior_dark', M_extra=None):
    """Sloped roof plane: origin o at an eave corner, eave_dir along the eave (length Lu), slope_dir up the slope
    (length Lv).  Built with wall() so holes get thick reveals."""
    X = np.asarray(eave_dir, float); Y = np.asarray(slope_dir, float)
    Z = np.cross(X / np.linalg.norm(X), Y / np.linalg.norm(Y))
    o = np.asarray(o, float)
    if Z[1] < 0:
        o = o + X / np.linalg.norm(X) * Lu; X = -X
        holes = [[(Lu - p[0], p[1]) for p in hh] for hh in holes]
    M = frame(o, X, Y)
    if M_extra is not None:
        M = M_extra @ M
    wall(mb, (0, 0, Lu, Lv), th, reg, tile, holes=holes, M=M, back=back, side='steel_dark', cap='all')
    return M


def gable_roof(mb, x0, x1, z0, z1, ye, pitch, ridge='z', ov=0.5, reg='roof_metal', holes=None, back='interior_dark',
               sag=None):
    """Two roof planes over the rectangle; ridge along 'z' or 'x'.  holes: {0|1: [poly in plane coords]}."""
    t = math.tan(pitch); holes = holes or {}
    if ridge == 'z':
        hw = (x1 - x0) / 2 + ov; Lv = hw / math.cos(pitch); Lu = z1 - z0 + 2 * ov; yb = ye - ov * t
        xc = (x0 + x1) / 2
        roof_plane(mb, (x0 - ov, yb, z0 - ov), (0, 0, 1), (math.cos(pitch), math.sin(pitch), 0), Lu, Lv, reg, holes=holes.get(0, ()), back=back)
        roof_plane(mb, (x1 + ov, yb, z0 - ov), (0, 0, 1), (-math.cos(pitch), math.sin(pitch), 0), Lu, Lv, reg, holes=holes.get(1, ()), back=back)
        return yb + hw * t
    hw = (z1 - z0) / 2 + ov; Lv = hw / math.cos(pitch); Lu = x1 - x0; yb = ye - ov * t
    roof_plane(mb, (x0, yb, z1 + ov), (1, 0, 0), (0, math.sin(pitch), -math.cos(pitch)), Lu, Lv, reg, holes=holes.get(0, ()), back=back)
    roof_plane(mb, (x0, yb, z0 - ov), (1, 0, 0), (0, math.sin(pitch), math.cos(pitch)), Lu, Lv, reg, holes=holes.get(1, ()), back=back)
    return yb + hw * t


def steps(mb, M, xc, w, y_top, n=3, d=0.3):
    for k in range(n):
        y = y_top * (n - k) / n
        tbox(mb, (xc - w / 2 - 0.1 * k, 0, 0), (xc + w / 2 + 0.1 * k, y, d * (k + 1) + 0.05), 'concrete', (1.5, 1.0), M=M, faces='+x-x+y+z')


def window_sandbag_stack(mb, M=None, seed=5, W=1.8, H=2.3, D=0.7):
    """Sandbags piled against a 1.5 m ground-floor window: back face at local z = -D/2 (against the wall), front +Z;
    battered so the depth tapers from D at the bottom to ~D/2 at the top; small embrasure gap near the top."""
    r = rng(seed); tmp = TMB()
    bh = 0.16; rows = int(round(H / bh))
    for j in range(rows):
        y = j * bh; t = j / max(1, rows - 1)
        depth = D * (1 - 0.5 * t)
        zb = -D / 2; zf = zb + depth
        header = j % 2 == 0
        bl, bw = (0.34, 0.56) if header else (0.56, 0.34)       # length along X, along Z
        nz = max(1, int(round(depth / bw)))
        xs = []
        x = -W / 2 - (0.0 if j % 4 < 2 else bl / 2)
        while x < W / 2 - 0.06:
            x0, x1 = max(x, -W / 2), min(x + bl, W / 2)
            if not (j >= rows - 2 and abs((x0 + x1) / 2) < 0.28) and x1 - x0 > 0.08:      # embrasure near the top
                xs.append((x0, x1))
            x += bl
        for i, (x0, x1) in enumerate(xs):
            for kz in range(nz):
                z = zf - (kz + 0.5) * (depth / nz)
                M2 = mat_trs(((x0 + x1) / 2 + r.normal(0, 0.015), y, z + r.normal(0, 0.012)), (r.normal(0, 0.03), r.normal(0, 0.07), r.normal(0, 0.03)))
                hx = (x1 - x0) / 2
                v0 = (j % 6) / 6
                sub = RS('sandbag', 0, v0, 0.5, v0 + 1 / 6) if header else RS('sandbag', 0.5, v0, 1, v0 + 1 / 6)
                faces = '+y' + ('+z' if kz == 0 else '') + ('-x' if i == 0 or xs[i - 1][1] < x0 - 0.01 else '') + ('+x' if i == len(xs) - 1 or xs[i + 1][0] > x1 + 0.01 else '')
                fbox(tmp, (-hx * 0.99, 0, -depth / nz / 2 * 0.99), (hx * 0.99, bh * 1.1, depth / nz / 2 * 0.99), sub, faces=faces, M=M2)
    tint(tmp, ground_ao(0.6, 0.6))
    mb.merge(tmp, M)


def window_sandbags(name='window_sandbags', seed=5):
    mb = TMB(name)
    window_sandbag_stack(mb, None, seed)
    return mb


# ====================================================================== kindergarten
KG_POLY = [(-21, -12), (-9, -12), (-9, -5.5), (9, -5.5), (9, -12), (21, -12), (21, 12), (9, 12), (9, 5.5), (-9, 5.5), (-9, 12), (-21, 12)]


def kindergarten(name, damaged=False, seed=300):
    """Typical 2-storey Soviet dytsadok (1970s type project), H-plan 42 x 24 m: two group-room wings joined by the
    entrance block.  Renovated in the 2010s: EIFS insulation in peach render with a mint inter-floor band, white PVC
    windows, dark grey plinth tiles, brown metal gable roofs.  Wartime: ground-floor windows blast-taped, four of them
    sandbagged.  Damaged: shell hole through the centre roof, burnt-out windows with soot plumes, the +X/+Z wing
    corner collapsed down to a rubble mound (slabs hanging, rooms exposed)."""
    mb = TMB(name); r = rng(seed)
    plinth, st, He = 0.6, 3.3, 7.2
    pitch = math.radians(18)
    win_w, win_h = 1.5, 1.5
    sills = (plinth + 0.85, plinth + st + 0.85)
    sandbag_slots = {(0, 2), (0, 5), (6, 1), (8, 3)}            # (edge index, window index) on the ground floor
    burnt = {(7, 0, 1), (7, 1, 1), (2, 1, 0), (6, 2, 1), (6, 3, 0), (8, 1, 1)} if damaged else set()   # (edge, win, floor)
    corner = blob(0, 0, 6.2, 7.5, 18, seed + 1, 0.3, 0.6) if damaged else None   # collapse footprint around (21, 12)
    collapse_c = np.array([21.0, 12.0])
    edges = outward_edges(KG_POLY)
    soot_pts = []
    for ei, (a, b) in enumerate(edges):
        M, L = edge_frame(a, b)
        n = int((L - 1.2) // 3.0)
        xs = [L / 2 + (k - (n - 1) / 2) * 3.0 for k in range(n)]
        doors = []
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        if abs(mid[1] - 5.5) < 0.1 and abs(mid[0]) < 0.1:                 # main entrance, centre front
            doors = [L / 2]
        if abs(abs(mid[0]) - 9) < 0.1 and mid[1] > 5:                      # side entrances in the courtyard
            doors = [L / 2]
        holes = []; wins = []
        for fl in (0, 1):
            for k, x in enumerate(xs):
                if fl == 0 and any(abs(x - d) < 1.6 for d in doors):
                    continue
                wins.append((fl, k, x))
                holes.append((x - win_w / 2, sills[fl], x + win_w / 2, sills[fl] + win_h))
        for d in doors:
            holes.append((d - 0.8, plinth, d + 0.8, plinth + 2.3))
        cut = []
        back = 'interior_dark' if damaged and min(a[0], b[0]) >= 8.9 else False     # wing opened by the collapse
        if damaged:
            # walls whose line runs through the collapsed corner lose a jagged notch, deepest at the corner
            A3 = M[:3, 3]; X3 = M[:3, 0]; Z3 = M[:3, 2]
            dc = np.array([collapse_c[0] - A3[0], 0.0, collapse_c[1] - A3[2]])
            xc = float(dc @ X3)
            if abs(float(dc @ Z3)) < 0.5 and -0.5 <= xc <= L + 0.5:
                sgn = -1 if xc > L / 2 else 1               # direction from the corner into the wall
                jag = []
                for k in range(9):
                    t = k / 8
                    yy_ = plinth + 0.3 + (He - plinth) * (1 - t) ** 0.7 * 0.95 + r.normal(0, 0.35) * (0 < k < 8)
                    jag.append((xc + sgn * 6.0 * (1 - t), He + 1 if k == 0 else max(-0.2, yy_)))
                cut.append(jag + [(xc - sgn * 1.0, -0.5), (xc - sgn * 1.0, He + 1)])
                back = 'interior_dark'
        tile = (3.0, 3.3)
        facade_wall(mb, a, b, plinth, He, 'facade_peach', tile, holes=holes, th=0.35, back=back, side='concrete', cut=cut)
        cutp = [Polygon(c).buffer(0) for c in cut]
        def inside_cut(x0, y0, x1, y1):
            return any(p.intersects(sbox(x0, y0, x1, y1)) for p in cutp)
        # plinth band + inter-floor mint band (proud) -- skip where collapsed
        for (yb0, yb1, reg, dz) in ((0.0, plinth, 'plinth', 0.04), (plinth + st - 0.08, plinth + st + 0.22, 'facade_mint', 0.03), (He - 0.3, He, 'facade_mint', 0.03)):
            segs = [(0.0, L)]
            if cutp:
                full = sbox(0, yb0, L, yb1).difference(cutp[0])
                segs = []
                for g in ([full] if full.geom_type == 'Polygon' else list(full.geoms)):
                    if g.area > 0.05:
                        bx = g.bounds; segs.append((bx[0], bx[2]))
            for s0, s1 in segs:
                dsegs = [(s0, s1)]
                if reg == 'plinth':
                    for d in doors:
                        dsegs = [q for (p0, p1) in dsegs for q in ((p0, min(p1, d - 0.8)), (max(p0, d + 0.8), p1)) if q[1] - q[0] > 0.05]
                for p0, p1 in dsegs:
                    tbox(mb, (p0, yb0, 0), (p1, yb1, dz), reg, (1.2 if reg == 'plinth' else 3.0, 0.6 if reg == 'plinth' else 3.3), M=M, faces='+z+y-y')
        for fl, k, x in wins:
            x0, y0 = x - win_w / 2, sills[fl]
            if inside_cut(x0 - 0.2, y0 - 0.2, x0 + win_w + 0.2, y0 + win_h + 0.2):
                continue
            kind = 'taped' if fl == 0 or (k + ei) % 3 == 0 else 'pvc'
            if (ei, k, fl) in burnt:
                kind = 'burnt'
                tquad(mb, (x0 - 0.3, y0 + win_h - 0.05, 0.018), (1, 0, 0), (0, 1, 0), win_w + 0.6, 2.2 if fl == 0 else 1.6, 'facade_soot', (win_w + 0.6, 2.4), M=M)
                soot_pts.append(xform(np.array([[x, y0 + win_h, 0.0]]), M)[0])
            window_set(mb, M, x0, y0, win_w, win_h, kind)
            if fl == 0 and (ei, k) in sandbag_slots:
                window_sandbag_stack(mb, M @ T(x, 0, 0.35 + 0.02), seed + ei * 10 + k)
        for d in doors:
            if inside_cut(d - 1, 0, d + 1, 3):
                continue
            tquad(mb, (d - 0.75, plinth, -0.1), (1, 0, 0), (0, 1, 0), 0.75, 2.25, RS('door_board', 0, 0, 0.5, 1), (0.75, 2.25), M=M)
            tquad(mb, (d, plinth, -0.1), (1, 0, 0), (0, 1, 0), 0.75, 2.25, RS('door_board', 0, 0, 0.5, 1), (0.75, 2.25), M=M)
            steps(mb, M, d, 2.2, plinth, 3, 0.32)
            tbox(mb, (d - 1.6, plinth + 2.55, 0), (d + 1.6, plinth + 2.7, 1.7), WHITE(), (3.2, 1.7), M=M, faces='+x-x+y-y+z')   # canopy
    # gables of the wings (triangles above the eave at z = +-12) and roofs
    rise_w = 6 * math.tan(pitch)
    for xs_ in (-15, 15):
        for zs in (12, -12):
            a, b = ((xs_ - 6, zs), (xs_ + 6, zs)) if zs > 0 else ((xs_ + 6, zs), (xs_ - 6, zs))
            M, L = edge_frame(a, b)
            cut = []
            if damaged and xs_ > 0 and zs > 0:
                continue                       # gable of the collapsed corner gone
            wall(mb, [(0, He), (L, He), (L / 2, He + rise_w)], 0.3, 'facade_peach', (3.0, 3.3), M=M, back=False, side='concrete', cap='none')
            tquad(mb, (L / 2 - 0.5, He + 0.5, 0.02), (1, 0, 0), (0, 1, 0), 1.0, 0.6, RS('steel_dark', 0, 0, 1, 1), (1.0, 0.6), M=M)   # vent
    holes_w = {}
    if damaged:
        # roof of the +X wing torn open over the collapse (plane on the +X side, near z=+12)
        Lv = 6.5 / math.cos(pitch)     # plane coords: u = z + 12.5 along the eave, v up the slope
        holes_w = {1: [[(26.5, -1.0), (26.5, Lv + 1), (19.5, Lv + 1), (18.2, 6.0), (19.4, 4.6), (17.6, 3.1), (18.9, 1.6), (17.2, 0.2), (17.8, -1.0)]],
                   0: [[(26.5, 2.4), (26.5, Lv + 1), (20.5, Lv + 1), (21.6, 6.2), (20.4, 4.8), (22.5, 3.6), (23.5, 2.5)]]}
    for xs_ in (-15, 15):
        hh = holes_w if (damaged and xs_ > 0) else {}
        gable_roof(mb, xs_ - 6, xs_ + 6, -12, 12, He, pitch, ridge='z', ov=0.5, holes=hh)
    hc = {}
    if damaged:
        hc = {0: [[(9.0 + q[0], 3.0 + q[1]) for q in blob(0, 0, 2.3, 1.9, 14, seed + 7, 0.35, 0.5)]]}
        soot_pts.append(np.array([-6.0, He + 1.0, 2.5]))
    gable_roof(mb, -15, 15, -5.5, 5.5, He, pitch, ridge='x', ov=0.5, holes=hc)
    if damaged:
        # attic floor under the roof hole, charred rafters across it
        tquad(mb, (-10, He + 0.02, 5.4), (1, 0, 0), (0, 0, -1), 8.0, 7.0, 'interior_dark', (4, 4))
        for x in (-7.4, -6.2, -5.0):
            beam(mb, (x, He + 0.1, 5.5), (x + r.normal(0, 0.2), He + 1.6, 0.4), 0.1, 0.16, 'soot')
        # collapsed corner: inner partition + exposed slabs + rubble
        cxz = collapse_c
        tquad(mb, (9.0, plinth, 4.6), (1, 0, 0), (0, 1, 0), 12.0, He - plinth, 'interior_dark', (3, 3))      # partition seen through the breach
        for y in (plinth + st, He):
            sl = [(9.0, 4.6), (21.0, 4.6), (21.0, 12.0), (9.0, 12.0)]
            hole = [(cxz[0] + p[0] * 1.0, cxz[1] + p[1] * 1.0) for p in corner]
            slab(mb, sl, y, 0.22, 'concrete', (3.0, 3.0), holes=[hole])
        # hanging slab pieces and the rubble mound
        tbox(mb, (-2.0, -0.11, -1.4), (2.0, 0.11, 1.4), 'concrete', (3, 3), M=mat_trs((17.6, 2.4, 9.4), (0.55, 0.6, 0.25)))
        tbox(mb, (-1.6, -0.11, -1.2), (1.6, 0.11, 1.2), 'concrete', (3, 3), M=mat_trs((19.5, 4.6, 7.2), (-0.3, 0.2, 0.7)))
        rubble(mb, 18.6, 9.6, 3.6, 24, seed + 9, regs=('concrete', 'facade_peach', 'brick_white', 'plinth'), hmax=2.0)
        rubble(mb, 20.6, 6.4, 2.0, 8, seed + 10, regs=('concrete', 'facade_peach'), hmax=1.0)
        soot_pts += [np.array([19.0, 5.0, 9.0])]
    # AO near the ground, soot
    tint(mb, ground_ao(1.2, 0.62))
    for p in soot_pts:
        tint(mb, soot_blob(p, 1.6, 0.25, up=2.0))
    return mb


# ====================================================================== boiler house
def chimney(mb, base, H=30.0, r0=0.62, r1=0.42, segs=12, broken_at=None, seed=0):
    """Self-supporting steel flue stack on a concrete plinth, galvanised with red / white aviation bands at the top,
    service rings every 5 m.  broken_at: height of a jagged tear (the part above is not built here)."""
    r = rng(seed); bx, bz = base
    tbox(mb, (bx - 1.1, 0, bz - 1.1), (bx + 1.1, 0.8, bz + 1.1), 'concrete', (2.2, 0.8), faces='+x-x+z-z+y')
    top = broken_at if broken_at else H
    rad = lambda y: r0 + (r1 - r0) * y / H
    bands = [(0.8, H - 6.0, 'steel_galv')] + [(H - 6.0 + 1.5 * k, H - 4.5 + 1.5 * k, RED() if k % 2 == 0 else WHITE()) for k in range(4)]
    for y0, y1, reg in bands:
        if y0 >= top:
            break
        y1 = min(y1, top)
        n = max(1, int(round((y1 - y0) / 6.0)))
        for i in range(n):
            a, b = y0 + (y1 - y0) * i / n, y0 + (y1 - y0) * (i + 1) / n
            jit = None
            if broken_at and abs(b - top) < 1e-6:
                ph = r.uniform(0, 6, 3)
                jit = lambda ii, kk, ph=ph: 1.0 + (0.25 * math.sin(kk * 1.7 + ph[0]) if ii == 1 else 0.0)
                prof = [(rad(a), a), (rad(b) * 1.0, b)]
                tmp = TMB()
                lathe(tmp, prof, segs, reg, around=1.0)
                # tear: pull top ring vertices down irregularly
                ring_ids = list(range(segs, 2 * segs))
                for kk, vi in enumerate(ring_ids):
                    v = tmp.V[vi]
                    tmp.V[vi] = np.array([v[0] * (1 + 0.15 * math.sin(kk * 2.3 + ph[1])), v[1] - abs(math.sin(kk * 1.3 + ph[0])) * 1.6, v[2]])
                mb.merge(tmp, T(bx, 0, bz))
            else:
                lathe(mb, [(rad(a), a), (rad(b), b)], segs, reg, M=T(bx, 0, bz), around=1.0)
    for y in np.arange(5.0, top - 0.5, 5.0):       # service rings
        lathe(mb, [(rad(y) + 0.02, y), (rad(y) + 0.09, y + 0.04), (rad(y) + 0.09, y + 0.12), (rad(y) + 0.02, y + 0.14)], segs, 'steel_dark', M=T(bx, 0, bz))
    if not broken_at:
        lathe(mb, [(r1, H), (r1 + 0.06, H), (r1 + 0.06, H + 0.25), (r1 - 0.05, H + 0.25)], segs, 'soot', M=T(bx, 0, bz))
    # ladder rails
    for s in (-0.2, 0.2):
        cyl(mb, (bx + rad(1) + 0.18, 0.8, bz + s), (bx + rad(top) + 0.18, top - 0.3, bz + s), 0.02, 3, 'steel_dark')
    return rad


def boiler_house(name, damaged=False, seed=320):
    """District boiler house (rayonna kotelnya): 18 x 12 m red-brick hall, 6.2 m high, flat bitumen roof with brick
    parapet, tall modernised windows, steel gate, side door; 30 m steel chimney on a concrete plinth beside it,
    braced by two tiers of three guy wires to concrete anchors; insulated flue duct from the hall to the stack.
    Damaged: stack torn off at 17 m -- the upper section fell across the hall roof (roof caved in under it), snapped
    guys hanging, front wall breached, windows blown out with soot plumes, rubble."""
    mb = TMB(name); r = rng(seed)
    L, D, Hh = 18.0, 12.0, 6.2
    poly = [(-L / 2, -D / 2), (L / 2, -D / 2), (L / 2, D / 2), (-L / 2, D / 2)]
    cx, cz = L / 2 + 3.2, -1.5            # chimney position
    soot_pts = []
    breach = blob(-3.0, 2.0, 1.9, 1.7, 16, seed + 1, 0.3, 0.5) if damaged else None
    for ei, (a, b) in enumerate(outward_edges(poly)):
        M, Lw = edge_frame(a, b)
        nrm = M[:3, 2]
        holes = []; wins = []
        front = nrm[2] > 0.9; back_ = nrm[2] < -0.9; east = nrm[0] > 0.9; west = nrm[0] < -0.9
        if front or back_:
            for k in range(4):
                x = Lw / 2 + (k - 1.5) * 4.0
                wins.append(x); holes.append((x - 1.0, 1.6, x + 1.0, 4.8))
        if west:
            holes.append((Lw / 2 - 1.9, 0.0, Lw / 2 + 1.9, 3.8))            # gate
        if east:
            holes.append((2.0, 0.0, 3.0, 2.2))                               # door
            wins.append(Lw - 3.5); holes.append((Lw - 4.5, 1.6, Lw - 2.5, 4.8))
        cut = []
        bk = 'interior_dark' if damaged else False      # interior seen through the roof hole / breach
        if damaged and front:
            cut = [[(Lw / 2 + p[0], p[1]) for p in breach]]
            bk = 'interior_dark'
        facade_wall(mb, a, b, 0.0, Hh + 0.5, 'brick_red', (1.0, 1.0), holes=holes, th=0.5, back=bk, side='brick_red', cut=cut)
        cp = [Polygon(c).buffer(0) for c in cut]
        tbox(mb, (0, Hh + 0.5, -0.5), (Lw, Hh + 0.6, 0.04), 'concrete', (2.0, 0.6), M=M, faces='+y+z-z')     # parapet coping
        tbox(mb, (0, 0, 0), (Lw, 0.45, 0.03), 'concrete', (2.0, 0.45), M=M, faces='+z+y')                     # plinth
        for x in wins:
            if any(p.intersects(sbox(x - 1.2, 1.4, x + 1.2, 5.0)) for p in cp):
                continue
            k_ = 'burnt' if damaged and r.random() < 0.6 else 'pvc'
            window_set(mb, M, x - 1.0, 1.6, 2.0, 3.2, k_, depth=0.2)
            tbox(mb, (x - 1.1, 4.8, 0), (x + 1.1, 5.05, 0.03), 'concrete', (2.2, 0.3), M=M, faces='+z-y')      # lintel
            if k_ == 'burnt':
                soot_pts.append(xform(np.array([[x, 4.8, 0.2]]), M)[0])
        if west:
            gr = 'garage_door' if not damaged else 'garage_burnt'
            tquad(mb, (Lw / 2 - 1.9, 0.0, -0.2), (1, 0, 0), (0, 1, 0), 3.8, 3.8, gr, (3.8, 3.8), M=M)
        if east:
            tquad(mb, (2.0, 0.0, -0.15), (1, 0, 0), (0, 1, 0), 1.0, 2.2, RS('door_board', 0, 0, 0.5, 1), (1.0, 2.2), M=M)
    # roof
    hole = None
    if damaged:
        hole = [(2.5 + p[0], 0.5 + p[1]) for p in blob(0, 0, 5.0, 3.0, 16, seed + 3, 0.35, 0.4)]
        hole = [(x * math.cos(0.35) - z * math.sin(0.35) + 2.0, x * math.sin(0.35) + z * math.cos(0.35)) for x, z in [(p[0] - 2.5, p[1] - 0.5) for p in hole]]
    slab(mb, [(-L / 2 + 0.5, -D / 2 + 0.5), (L / 2 - 0.5, -D / 2 + 0.5), (L / 2 - 0.5, D / 2 - 0.5), (-L / 2 + 0.5, D / 2 - 0.5)], Hh, 0.3,
         'roof_membrane', (2.0, 2.0), holes=[hole] if hole else (), back='interior_dark')
    for (x, z) in ((-5.0, 2.0), (4.0, -3.0)):
        if not damaged or x < 0:
            tbox(mb, (x - 0.6, Hh, z - 0.6), (x + 0.6, Hh + 0.9, z + 0.6), 'steel_galv', (1.2, 0.9), faces='+x-x+z-z+y')
    # flue duct from the hall to the stack + stack + guys
    yd = 4.4
    cyl(mb, (L / 2 - 0.2, yd, cz), (cx - 0.5, yd, cz), 0.42, 10, 'steel_galv', seg=4.0)
    for x in (L / 2 + 1.2, L / 2 + 2.4):
        beam(mb, (x, 0, cz), (x, yd - 0.4, cz), 0.16, 0.16, 'steel_dark')
    brk = 17.0 if damaged else None
    rad = chimney(mb, (cx, cz), 30.0, broken_at=brk, seed=seed + 4)
    anchors = [(cx + 8.0 * math.cos(a), cz + 8.0 * math.sin(a)) for a in (0.0, 2 * PI / 3, 4 * PI / 3)]
    for ax, az in anchors:
        tbox(mb, (ax - 0.4, 0, az - 0.4), (ax + 0.4, 0.5, az + 0.4), 'concrete', (0.8, 0.5), faces='+x-x+z-z+y')
    for k, h in enumerate((14.0, 25.0)):
        for i, (ax, az) in enumerate(anchors):
            d = np.array([ax - cx, 0, az - cz]); d /= np.linalg.norm(d)
            att = np.array([cx, h, cz]) + d * rad(h)
            if not damaged:
                cyl(mb, att, (ax, 0.5, az), 0.014, 3, 'steel_dark')
            elif h < brk and i != 1:
                cyl(mb, att, (ax, 0.5, az), 0.014, 3, 'steel_dark')
            else:   # snapped: slack wire hanging from the stack down to the ground
                p_end = np.array([cx, 0.05, cz]) + d * r.uniform(2.5, 4.5) + np.array([r.normal(0, 0.5), 0, r.normal(0, 0.5)])
                top_ = att if h < brk else np.array([cx, brk - 0.5, cz]) + d * rad(brk)
                mid = (top_ + p_end) / 2 + d * 0.8 - np.array([0, (top_[1] - p_end[1]) * 0.1, 0])
                G.tube(mb, [top_, mid, p_end], 0.014, 3, 'steel_dark', seg=50)
    if damaged:
        # fallen upper stack section lying across the roof (13 m), crushing it
        p0 = np.array([cx - 1.4, Hh + 1.05, cz + 0.4]); p1 = np.array([cx - 14.0, Hh - 1.6, cz + 4.6])
        dvec = p1 - p0; Lc = float(np.linalg.norm(dvec))
        Mf = frame(p0, dvec, (0, 1, 0)) @ mat_trs((0, 0, 0), (0, 0, -PI / 2))
        lathe(mb, [(0.5, 0.0), (0.46, Lc - 6.0)], 12, 'steel_galv', M=Mf)
        for k in range(4):
            lathe(mb, [(0.46 - 0.003 * k, Lc - 6.0 + 1.5 * k), (0.45 - 0.003 * k, Lc - 4.5 + 1.5 * k)], 12, RED() if k % 2 == 0 else WHITE(), M=Mf)
        lathe(mb, [(0.5, 0.0), (0.0, 0.0)], 12, 'soot', M=Mf)
        rubble(mb, -3.0, D / 2 + 1.2, 2.0, 10, seed + 6, regs=('brick_red', 'concrete'), hmax=0.8)
        rubble(mb, -1.0, 0.5, 3.0, 12, seed + 7, regs=('brick_red', 'concrete', 'roof_membrane'), hmax=1.0)
        soot_pts += [np.array([-3.0, 3.0, D / 2]), np.array([1.5, Hh, 1.0]), np.array([cx, brk, cz])]
        # interior floor (seen through the breach / roof hole)
        tquad(mb, (-L / 2 + 0.5, 0.03, D / 2 - 0.5), (1, 0, 0), (0, 0, -1), L - 1, D - 1, 'interior_dark', (4, 4))
    tint(mb, ground_ao(1.2, 0.6))
    for p in soot_pts:
        tint(mb, soot_blob(p, 1.8, 0.22, up=2.2))
    return mb


# ====================================================================== supermarket
def supermarket(name, damaged=False, seed=340):
    """Single-storey 2010s supermarket box 40 x 22 m, 5.2 m to the parapet: light-grey sandwich-panel walls on a
    dark plinth, 28 m aluminium-glass storefront on the +Z side with sliding entrance, dark fascia with unbranded
    'ПРОДУКТИ' / 'МАРКЕТ' signs, steel entrance canopy over the parking edge (+Z, 5 m deep), loading door at the
    back, rooftop HVAC.  Intact: a third of the glazing shot out, two bays boarded with OSB.  Damaged: storefront
    blown in (mullions bent / torn out, glass gone), shelving visible, roof sagging and holed, sign hanging, canopy
    half collapsed, debris."""
    mb = TMB(name); r = rng(seed)
    L, D, H = 40.0, 22.0, 5.2
    gx0, gx1, gh = -14.0, 14.0, 3.6
    poly = [(-L / 2, -D / 2), (L / 2, -D / 2), (L / 2, D / 2), (-L / 2, D / 2)]
    soot_pts = []
    for (a, b) in outward_edges(poly):
        M, Lw = edge_frame(a, b)
        nrm = M[:3, 2]; front = nrm[2] > 0.9; back_ = nrm[2] < -0.9
        holes = []
        if front:
            holes = [(Lw / 2 + gx0, 0.2, Lw / 2 + gx1, gh)]
        if back_:
            holes = [(Lw / 2 - 2.0, 0.0, Lw / 2 + 2.0, 3.4)]
        facade_wall(mb, a, b, 0.0, H, 'sandwich', (3.0, 3.0), holes=holes, th=0.25, back='interior_dark' if damaged else False, side='steel_dark')
        tbox(mb, (0, 0, 0), (Lw, 0.5, 0.03), 'plinth', (1.2, 0.6), M=M, faces='+z+y')
        tbox(mb, (0, H, -0.25), (Lw, H + 0.08, 0.05), 'steel_dark', (3.0, 1.0), M=M, faces='+y+z')
        if back_:
            tquad(mb, (Lw / 2 - 2.0, 0.0, -0.12), (1, 0, 0), (0, 1, 0), 4.0, 3.4, 'garage_door', (4.0, 3.4), M=M)
            tbox(mb, (Lw / 2 - 2.6, 3.5, 0), (Lw / 2 + 2.6, 3.65, 1.4), 'steel_dark', (2, 2), M=M)
        if front:
            # fascia band over the storefront + signs
            tbox(mb, (Lw / 2 + gx0 - 0.5, gh, 0), (Lw / 2 + gx1 + 0.5, H, 0.12), 'steel_dark', (3.0, 2.0), M=M, faces='+z+y-y+x-x')
            sg = [(Lw / 2 - 11.0, 8.0, 'sign_products'), (Lw / 2 + 3.5, 7.0, 'sign_market')]
            for k, (x0, w, reg) in enumerate(sg):
                Ms = M
                if damaged and k == 0:   # hanging from its right end
                    Ms = M @ rot_axis((0, 0, 1), 0.42, origin=(x0 + w, gh + 1.45, 0.2))
                tbox(mb, (x0, gh + 0.15, 0.12), (x0 + w, gh + 1.45, 0.3), 'steel_dark', (3, 2), M=Ms, faces='+x-x+y-y')
                tquad(mb, (x0, gh + 0.15, 0.3), (1, 0, 0), (0, 1, 0), w, 1.3, reg, (w, 1.3), M=Ms)
            # storefront bays (2 m), mullions
            nb = int((gx1 - gx0) / 2.0)
            boarded = {3, 10}
            for i in range(nb):
                x0 = Lw / 2 + gx0 + i * 2.0
                if damaged:
                    if r.random() < 0.25:     # odd shard-rimmed pane left in the frame
                        aquad(mb, xform(np.array([[x0 + 0.05, 0.3, -0.08], [x0 + 1.95, 0.3, -0.08], [x0 + 1.95, gh - 0.1, -0.08], [x0 + 0.05, gh - 0.1, -0.08]]), M), 'glass_crack_b')
                else:
                    if i in boarded:
                        tquad(mb, (x0, 0.2, -0.06), (1, 0, 0), (0, 1, 0), 2.0, gh - 0.2, RS('door_board', 0.5, 0, 1, 1), (2.0, gh - 0.2), M=M)
                    else:
                        reg = 'glass_shop_broken' if r.random() < 0.33 else 'glass_shop'
                        tquad(mb, (x0, 0.2, -0.1), (1, 0, 0), (0, 1, 0), 2.0, gh - 0.2, reg, (2.0, gh - 0.2), M=M)
            for i in range(nb + 1):
                x = Lw / 2 + gx0 + i * 2.0
                if damaged and r.random() < 0.45 and 0 < i < nb:
                    # bent / torn mullion
                    ang = r.uniform(0.25, 0.9) * r.choice([-1, 1])
                    Mb = M @ rot_axis((1, 0, 0), -abs(ang), origin=(x, 0.2, 0)) @ rot_axis((0, 0, 1), ang * 0.3, origin=(x, 0.2, 0))
                    tbox(mb, (x - 0.04, 0.2, -0.08), (x + 0.04, gh * r.uniform(0.5, 0.95), 0.0), 'steel_dark', (1, 3.6), M=Mb, faces='+x-x+z-z')
                else:
                    tbox(mb, (x - 0.04, 0.2, -0.1), (x + 0.04, gh, 0.0), 'steel_dark', (1, 3.6), M=M, faces='+x-x+z')
            if not damaged:
                tbox(mb, (Lw / 2 + gx0, 2.75, -0.1), (Lw / 2 + gx1, 2.85, 0.0), 'steel_dark', (3, 1), M=M, faces='+z+y-y')     # transom
    # roof: flat membrane inside the parapet (sagging grid when damaged)
    nx, nz = 10, 6
    def roof_y(x, z):
        if not damaged:
            return H - 0.4
        s = math.exp(-((x - 3.0) / 9.0) ** 2 - (z / 6.0) ** 2)
        return H - 0.4 - 1.3 * s
    hole = blob(5.0, 1.0, 2.6, 2.0, 14, seed + 2, 0.35, 0.5) if damaged else None
    holep = Polygon(hole).buffer(0) if damaged else None
    rg = G.R['roof_membrane']
    for i in range(nx):
        for j in range(nz):
            x0 = -L / 2 + 0.25 + (L - 0.5) * i / nx; x1 = -L / 2 + 0.25 + (L - 0.5) * (i + 1) / nx
            z0 = -D / 2 + 0.25 + (D - 0.5) * j / nz; z1 = -D / 2 + 0.25 + (D - 0.5) * (j + 1) / nz
            if damaged and holep.intersects(sbox(x0, z0, x1, z1)) and holep.intersection(sbox(x0, z0, x1, z1)).area > 0.35 * (x1 - x0) * (z1 - z0):
                continue
            P = [(x0, roof_y(x0, z1), z1), (x1, roof_y(x1, z1), z1), (x1, roof_y(x1, z0), z0), (x0, roof_y(x0, z0), z0)]
            mb.poly(P, Fit(rg, (2.0, 2.0), i * 7 + j))
            if damaged:
                mb.poly(P[::-1], Fit(G.R['interior_dark'], (4.0, 4.0), i * 7 + j))
    for (x, z) in ((-12, -4), (-6, -5), (10, -6), (15, 3)):
        if damaged and abs(x - 3) < 8:
            continue
        tbox(mb, (x - 1.0, roof_y(x, z), z - 0.7), (x + 1.0, roof_y(x, z) + 1.1, z + 0.7), 'steel_galv', (2.0, 1.1), faces='+x-x+z-z+y')
    # entrance canopy (5 m deep over the parking edge)
    cz0, cz1, cy = D / 2, D / 2 + 5.0, 3.5
    cols = [(-10.0, cz1 - 0.3), (-3.3, cz1 - 0.3), (3.3, cz1 - 0.3), (10.0, cz1 - 0.3)]
    for k, (x, z) in enumerate(cols):
        if damaged and k == 3:
            beam(mb, (x + 0.3, 0.1, z + 0.4), (x + 3.2, 0.25, z + 1.2), 0.2, 0.2, 'steel_dark')          # knocked down
            continue
        tbox(mb, (x - 0.1, 0, z - 0.1), (x + 0.1, cy, z + 0.1), 'steel_dark', (1, 3.5), faces='+x-x+z-z')
    Mc = None
    if damaged:
        Mc = rot_axis((0, 0, 1), 0.38, origin=(4.5, cy, 0))
    tmp = TMB()
    tbox(tmp, (-11.0, cy, cz0), (11.0, cy + 0.35, cz1), 'steel_dark', (3.0, 3.0), faces='+x-x+z-y')
    tbox(tmp, (-11.0, cy + 0.35, cz0), (11.0, cy + 0.36, cz1), 'roof_membrane', (2.0, 2.0), faces='+y')
    if damaged:
        # split the canopy: left part stays, right part hinges down at x = 4.5
        left = TMB(); right = TMB()
        tbox(left, (-11.0, cy, cz0), (4.5, cy + 0.35, cz1), 'steel_dark', (3.0, 3.0), faces='+x-x+z-y')
        tbox(left, (-11.0, cy + 0.35, cz0), (4.5, cy + 0.36, cz1), 'roof_membrane', (2.0, 2.0), faces='+y')
        tbox(right, (4.5, cy, cz0), (11.0, cy + 0.35, cz1), 'steel_dark', (3.0, 3.0), faces='+x-x+z-y')
        tbox(right, (4.5, cy + 0.35, cz0), (11.0, cy + 0.36, cz1), 'roof_membrane', (2.0, 2.0), faces='+y')
        mb.merge(left); mb.merge(right, rot_axis((0, 0, 1), -0.5, origin=(4.5, cy, 0)))
    else:
        mb.merge(tmp)
    if damaged:
        # interior: floor, shelving rows, debris, glass shards outside
        tquad(mb, (-L / 2 + 0.25, 0.03, D / 2 - 0.25), (1, 0, 0), (0, 0, -1), L - 0.5, D - 0.5, 'interior_dark', (4, 4))
        for k in range(6):
            z = D / 2 - 5.0 - k * 2.4
            ang = r.normal(0, 0.06) + (0.5 if k == 0 else 0.0)
            tbox(mb, (-12.0, 0, -0.35), (12.0, 1.9, 0.35), 'steel_dark', (3.0, 2.0), M=mat_trs((r.normal(0, 0.5), 0, z), (0, ang, 0 if k else 0.0)), faces='+x-x+y+z-z')
        rubble(mb, -6.0, D / 2 - 2.5, 2.2, 10, seed + 5, regs=('sandwich_burnt', 'concrete', 'steel_dark'), hmax=0.7)
        rubble(mb, 4.0, D / 2 - 6.0, 3.0, 12, seed + 6, regs=('sandwich', 'roof_membrane', 'concrete'), hmax=1.0)
        for k in range(30):
            x, z = r.uniform(-14, 14), r.uniform(D / 2 + 0.2, D / 2 + 3.5)
            s_ = r.uniform(0.15, 0.4)
            mb.poly([(x, 0.012, z), (x + s_, 0.012, z + 0.05), (x + s_ * 0.6, 0.012, z + s_ * 0.8)], G.fit('glass_dark', (0.4, 0.4)))
        for k in range(5):     # sandwich-panel sheets blown off
            x, z = r.uniform(-15, 15), r.uniform(D / 2 + 1.0, D / 2 + 4.5)
            tquad(mb, (0, 0, 0), (1, 0, 0), (0, 0, -1), 2.6, 1.0, 'sandwich', (3.0, 1.0), M=mat_trs((x, 0.06, z), (r.normal(0, 0.15), r.uniform(0, 3), r.normal(0, 0.15))), double=True)
        soot_pts += [np.array([-4.0, 2.5, D / 2]), np.array([6.0, 2.0, D / 2]), np.array([5.0, H, 1.0])]
    tint(mb, ground_ao(1.0, 0.62))
    for p in soot_pts:
        tint(mb, soot_blob(p, 2.5, 0.25, up=1.6))
    return mb


# ====================================================================== pharmacy pavilion / burnt kiosk
def pharmacy_kiosk(name, burnt=False, seed=360):
    """Modern 6 x 4 m aluminium / glass pharmacy pavilion (MAF) on a low plinth: white composite lower panels with a
    green band, glazed band, 'АПТЕКА' fascia, flat roof, glazed door at the front, double-sided green-cross light
    box on a bracket.  Burnt (kiosk_modern_burnt): glazing gone, panels burnt to ash-white / black, fascia charred,
    roof sagging, shelves gutted, cross box blackened and hanging."""
    mb = TMB(name); r = rng(seed)
    W, D, H = 6.0, 4.0, 3.1
    y0, y1, y2 = 0.15, 0.9, 2.6
    tbox(mb, (-W / 2 - 0.1, 0, -D / 2 - 0.1), (W / 2 + 0.1, y0, D / 2 + 0.1), 'concrete', (1.5, 0.5), faces='+x-x+z-z+y')
    pan = RS('pharm_panel', 0.02, 0.02, 0.98, 0.48) if not burnt else RS('sandwich_burnt', 0, 0, 1, 0.33)
    fas = RS('pharm_panel', 0.0, 0.52, 1.0, 1.0) if not burnt else RS('sandwich_burnt', 0, 0.4, 1, 0.75)
    post = 'steel_dark' if not burnt else 'soot'
    for (a, b) in outward_edges([(-W / 2, -D / 2), (W / 2, -D / 2), (W / 2, D / 2), (-W / 2, D / 2)]):
        M, Lw = edge_frame(a, b); front = M[:3, 2][2] > 0.9
        tquad(mb, (0, y0, 0), (1, 0, 0), (0, 1, 0), Lw, y1 - y0, pan, (Lw if Lw < 5 else Lw / 2, y1 - y0), M=M)
        tquad(mb, (0, y2, 0), (1, 0, 0), (0, 1, 0), Lw, H - y2, fas, (Lw, H - y2) if not burnt else (2.0, H - y2), M=M)
        nb = int(round(Lw / 1.5))
        for i in range(nb):
            x0 = i * Lw / nb
            door = front and i == nb // 2
            if not burnt:
                reg = 'car_glass'
                yb = y1 if not door else y0
                tquad(mb, (x0, yb, -0.06), (1, 0, 0), (0, 1, 0), Lw / nb, y2 - yb, reg, (Lw / nb, y2 - yb), M=M)
            tbox(mb, (x0 - 0.04, y0, -0.06), (x0 + 0.04, y2, 0.0), post, (1, 2.5), M=M, faces='+x-x+z')
        tbox(mb, (0, y1 - 0.05, -0.06), (Lw, y1 + 0.03, 0.02), post, (2, 1), M=M, faces='+z+y')
    # interior back walls (visible through glass) and roof
    Mr = None if not burnt else rot_axis((1, 0, 0), 0.0, origin=(0, H, 0))
    tmp = TMB()
    if not burnt:
        tbox(tmp, (-W / 2 - 0.15, H, -D / 2 - 0.15), (W / 2 + 0.15, H + 0.12, D / 2 + 0.15), 'steel_dark', (2.0, 2.0), faces='+x-x+z-z-y')
        tbox(tmp, (-W / 2 - 0.15, H + 0.12, -D / 2 - 0.15), (W / 2 + 0.15, H + 0.13, D / 2 + 0.15), 'roof_membrane', (2.0, 2.0), faces='+y')
        mb.merge(tmp)
        for (a, b) in outward_edges([(-W / 2 + 0.3, -D / 2 + 0.3), (W / 2 - 0.3, -D / 2 + 0.3), (W / 2 - 0.3, D / 2 - 0.3), (-W / 2 + 0.3, D / 2 - 0.3)]):
            M, Lw = edge_frame(b, a)       # facing inwards
            tquad(mb, (0, y0, 0), (1, 0, 0), (0, 1, 0), Lw, y2 - y0, 'interior_dark', (2, 2.5), M=M)
        tquad(mb, (-W / 2, y2 - 0.01, -D / 2), (1, 0, 0), (0, 0, 1), W, D, WHITE(), (W, D))       # ceiling
    else:
        # roof sagging into the middle, torn at the back
        nx, nz = 4, 3
        sag = lambda x, z: H - 0.55 * math.exp(-(x / 2.0) ** 2 - (z / 1.5) ** 2)
        for i in range(nx):
            for j in range(nz):
                if (i, j) in ((3, 0), (2, 0)):
                    continue
                xa, xb = -W / 2 - 0.1 + (W + 0.2) * i / nx, -W / 2 - 0.1 + (W + 0.2) * (i + 1) / nx
                za, zb = -D / 2 - 0.1 + (D + 0.2) * j / nz, -D / 2 - 0.1 + (D + 0.2) * (j + 1) / nz
                P = [(xa, sag(xa, zb), zb), (xb, sag(xb, zb), zb), (xb, sag(xb, za), za), (xa, sag(xa, za), za)]
                mb.poly(P, G.fit('ash', (2, 2))); mb.poly(P[::-1], G.fit('soot', (2, 2)))
        tquad(mb, (-W / 2 + 0.1, y0 + 0.02, D / 2 - 0.1), (1, 0, 0), (0, 0, -1), W - 0.2, D - 0.2, 'ash', (2, 2))
        for k in range(3):     # gutted shelving
            x = -2.0 + k * 2.0
            tbox(mb, (x - 0.7, y0, -D / 2 + 0.3), (x + 0.7, 1.9 - 0.3 * (k == 1), -D / 2 + 0.75), 'interior_burnt', (1.4, 1.8), M=rot_axis((1, 0, 0), 0.25 * (k == 2), origin=(0, y0, -D / 2 + 0.3)), faces='+x-x+y+z')
        for (a, b) in outward_edges([(-W / 2 + 0.05, -D / 2 + 0.05), (W / 2 - 0.05, -D / 2 + 0.05), (W / 2 - 0.05, D / 2 - 0.05), (-W / 2 + 0.05, D / 2 - 0.05)]):
            M, Lw = edge_frame(b, a)
            tquad(mb, (0, y0, 0), (1, 0, 0), (0, 1, 0), Lw, H - y0, 'soot', (2, 2.5), M=M)
        for k in range(20):
            x, z = r.uniform(-3.2, 3.2), r.uniform(D / 2 + 0.15, D / 2 + 1.1)
            s_ = r.uniform(0.1, 0.3)
            mb.poly([(x, 0.012, z), (x + s_, 0.012, z + 0.05), (x + s_ * 0.6, 0.012, z + s_ * 0.8)], G.fit('ash', (0.4, 0.4)))
    # green cross light box on a bracket at the front-right corner
    bx, bz = W / 2 + 0.05, D / 2 - 0.3
    beam(mb, (bx, H - 0.3, bz), (bx + 0.55, H - 0.3, bz), 0.06, 0.06, post)
    Mx = T(bx + 0.55, H - 0.75, bz)
    if burnt:
        Mx = T(bx + 0.55, H - 0.3, bz) @ rot_axis((0, 0, 1), 0.5, origin=(0, 0, 0)) @ T(0, -0.45, 0)
    tbox(mb, (-0.4, -0.4, -0.08), (0.4, 0.4, 0.08), post, (1, 1), M=Mx, faces='+x-x+y-y')
    cross = RS('decals', 0.52, 0.52, 0.98, 0.98) if not burnt else 'soot'
    tquad(mb, (-0.4, -0.4, 0.08), (1, 0, 0), (0, 1, 0), 0.8, 0.8, cross, (0.8, 0.8), M=Mx)
    tquad(mb, (0.4, -0.4, -0.08), (-1, 0, 0), (0, 1, 0), 0.8, 0.8, cross, (0.8, 0.8), M=Mx)
    tint(mb, ground_ao(0.8, 0.6))
    if burnt:
        tint(mb, lambda p: 0.55 + 0.45 * min(1, abs(p[1] - 1.2) / 2.0))
    return mb


# ====================================================================== garage row
def garage_row(name='garage_row', seed=380):
    """Row of six cooperative garages (GSK), 20 x 6 m: white silicate-brick walls, felt-covered slab roof falling to
    the back, painted steel double gates.  Two gates open (leaves swung out, dark interiors), one garage burnt out
    (gate leaves blistered and one fallen, soot plume up the front, roof slab cracked and sagging into it)."""
    mb = TMB(name); r = rng(seed)
    n, gw, D = 6, 3.3, 6.0
    L = n * gw
    Hf, Hb = 2.75, 2.45
    x0 = -L / 2
    opened = {1: (1.75, 1.9), 4: (2.2, 0.8)}
    burnt = 3
    soot_pts = []
    holes = [(i * gw + 0.35, 0.0, (i + 1) * gw - 0.35, 2.25) for i in range(n)]
    M, Lw = edge_frame((x0, D / 2), (x0 + L, D / 2))
    wall(mb, [(0, 0), (L, 0), (L, Hf), (0, Hf)], 0.3, 'brick_white', (1.0, 1.0), holes=holes, M=M, back='interior_dark', side='brick_white', cap='none')
    for (a, b, h0, h1) in (((x0 + L, D / 2), (x0 + L, -D / 2), Hf, Hb), ((x0, -D / 2), (x0, D / 2), Hb, Hf), ((x0 + L, -D / 2), (x0, -D / 2), Hb, Hb)):
        Mw, Lw2 = edge_frame(a, b)
        wall(mb, [(0, 0), (Lw2, 0), (Lw2, h1), (0, h0)], 0.3, 'brick_white', (1.0, 1.0), M=Mw, back=False, side='brick_white', cap='none')
    for i in range(1, n):      # party walls (only seen through open gates)
        x = x0 + i * gw
        tquad(mb, (x - 0.06, 0, D / 2 - 0.3), (0, 0, -1), (0, 1, 0), D - 0.6, 2.4, 'interior_dark', (3, 2.5))
        tquad(mb, (x + 0.06, 0, -D / 2 + 0.3), (0, 0, 1), (0, 1, 0), D - 0.6, 2.4, 'interior_dark', (3, 2.5))
    tquad(mb, (x0 + 0.3, 0.02, D / 2 - 0.3), (1, 0, 0), (0, 0, -1), L - 0.6, D - 0.6, 'interior_dark', (3, 3))
    tquad(mb, (x0 + 0.3, 0, -D / 2 + 0.3), (1, 0, 0), (0, 1, 0), L - 0.6, Hb - 0.1, 'interior_dark', (3, 2.5))
    for i in range(n):
        gx0 = i * gw + 0.35; gwid = gw - 0.7
        if i in opened:
            for s, ang in ((0, opened[i][0]), (1, opened[i][1])):
                hx = gx0 if s == 0 else gx0 + gwid
                Mg = M @ rot_axis((0, 1, 0), ang if s == 0 else -ang, origin=(hx, 0, 0.02))
                tquad(mb, (gx0 if s == 0 else gx0 + gwid / 2, 0.02, 0.02), (1, 0, 0), (0, 1, 0), gwid / 2, 2.2, RS('garage_door', 0.5 * s, 0, 0.5 * s + 0.5, 1), (gwid / 2, 2.2), M=Mg, double=True)
        elif i == burnt:
            tquad(mb, (gx0, 0.02, -0.08), (1, 0, 0), (0, 1, 0), gwid / 2, 2.2, RS('garage_burnt', 0, 0, 0.5, 1), (gwid / 2, 2.2), M=M @ rot_axis((0, 1, 0), 0.35, origin=(gx0, 0, 0)), double=True)
            Mf = M @ mat_trs((gx0 + gwid * 0.8, 0.05, 1.3), (-PI / 2 + 0.06, 0.3, 0))
            tquad(mb, (-gwid / 4, 0, 0), (1, 0, 0), (0, 1, 0), gwid / 2, 2.2, RS('garage_burnt', 0.5, 0, 1, 1), (gwid / 2, 2.2), M=Mf, double=True)
            soot_pts.append(xform(np.array([[gx0 + gwid / 2, 2.2, 0.1]]), M)[0])
        else:
            tquad(mb, (gx0, 0.0, -0.1), (1, 0, 0), (0, 1, 0), gwid, 2.25, 'garage_door', (gwid, 2.25), M=M)
    # roof slab per garage (felt top, concrete edge), burnt one cracked and sagging
    for i in range(n):
        xa, xb = x0 + i * gw - (0.25 if i == 0 else 0), x0 + (i + 1) * gw + (0.25 if i == n - 1 else 0)
        Mr = None
        if i == burnt:
            Mr = rot_axis((1, 0, 0), 0.0, origin=(0, 0, 0))
        P = lambda x, z, dy=0.0: (x, Hb + (Hf - Hb) * (z + D / 2) / D + 0.12 + dy, z)
        if i == burnt:
            zc = 0.4
            for (za, zb_, da, db) in ((-D / 2 - 0.1, zc, 0.0, -0.55), (zc, D / 2 + 0.25, -0.55, 0.0)):
                Q = [P(xa, zb_, db), P(xb, zb_, db), P(xb, za, da), P(xa, za, da)]
                mb.poly(Q, G.fit('roof_membrane', (2, 2))); mb.poly(Q[::-1], G.fit('soot', (2, 2)))
        else:
            Q = [P(xa, D / 2 + 0.25), P(xb, D / 2 + 0.25), P(xb, -D / 2 - 0.1), P(xa, -D / 2 - 0.1)]
            mb.poly(Q, Fit(G.R['roof_membrane'], (2.0, 2.0), i))
        tquad(mb, (xa, Hf + 0.0, D / 2 + 0.25), (1, 0, 0), (0, 1, 0), xb - xa, 0.14, 'concrete', (3, 1))      # slab edge
    if True:
        # burnt garage interior: black
        tquad(mb, (x0 + burnt * gw + 0.1, 0.03, D / 2 - 0.35), (1, 0, 0), (0, 0, -1), gw - 0.2, D - 0.7, 'ash', (2, 2))
    tint(mb, ground_ao(0.8, 0.6))
    for p in soot_pts:
        tint(mb, soot_blob(p, 1.4, 0.12, up=2.0))
    return mb


def all_items():
    out = [(kindergarten('kindergarten'), 'kg'), (kindergarten('kindergarten_damaged', True), 'kg'),
           (boiler_house('boiler_house'), 'bh'), (boiler_house('boiler_house_damaged', True), 'bh'),
           (supermarket('supermarket'), 'sm'), (supermarket('supermarket_damaged', True), 'sm'),
           (pharmacy_kiosk('pharmacy_kiosk'), 'pk'), (pharmacy_kiosk('kiosk_modern_burnt', True), 'pk'),
           (garage_row(), 'gr'), (window_sandbags(), 'ws')]
    return out


NODE_NOTES = {
    'kindergarten': 'H-plan 42 x 24 m, 2 storeys (eave 7.2 m, ridge 9.15 m); main entrance +Z (centre block), two courtyard side entrances; 4 ground-floor windows sandbagged, ground floor blast-taped.',
    'kindergarten_damaged': 'same footprint; shell hole in the centre roof, 6 burnt-out windows with soot plumes, +X/+Z wing corner collapsed to a rubble mound (slabs hanging, interior exposed).',
    'boiler_house': '18 x 12 m brick hall (6.2 m + parapet) at x<0 of the footprint; 30 m steel stack with 2 tiers of 3 guy wires to anchors 8 m out (the footprint includes the anchors).',
    'boiler_house_damaged': 'stack torn at 17 m, upper section lying across the caved-in hall roof, snapped guys hanging, front breach, burnt windows.',
    'supermarket': '40 x 22 m box, 5.2 m, storefront on +Z with signs, entrance canopy 22 x 5 m over the parking edge (+Z); some glazing shot out / boarded.',
    'supermarket_damaged': 'storefront blown in, shelves visible, roof sagging + holed, sign hanging, canopy half collapsed, glass / panel debris.',
    'pharmacy_kiosk': '6 x 4 x 3.1 m glass pavilion, door +Z, green-cross box at the front-right corner.',
    'kiosk_modern_burnt': 'burnt-out twin of pharmacy_kiosk (same footprint).',
    'garage_row': '6 garages 3.3 x 6 m (row 19.8 x 6), gates to +Z; 2 open, one burnt with a sagging roof.',
    'window_sandbags': 'stack for a 1.5 m ground-floor window: 1.8 m wide, 2.3 m high, 0.7 m deep at the base; back face at z = -0.35 goes against the facade (place with the stack centre 0.37 m in front of the wall).',
}
NOTES = ('Two materials: modern_atlas (2048^2 opaque, tools/blender/env/modern_atlas.py; brick / concrete / glass / ground regions '
         'shared with city_atlas, sandbag / ash with farmland_atlas) and modern_alpha (1024^2 RGBA, alphaMode MASK 0.5, double sided: '
         'anti-drone netting, cracked glazing).  Each asset = empty <id> + child mesh <id>_geo (quantised; instancing must keep the '
         'child transform).  Origin = ground centre of the footprint bbox (shared by intact / damaged twins), +Y up, long axis along X; '
         'cars / bus front = +X.  COLOR_0 = baked AO / soot multiplier (linear).  Burnt vehicles use burnt_tex.py: charcoal soot + '
         'grey-white ash, heat-tinted bare steel, small rust streaks, tyres burnt to the rims, glass gone, gutted interiors.')
REFS = ('Photo record 2022-24 of Kharkiv (Saltivka, Pivnichna Saltivka), Mariupol, Irpin / Bucha, Chernihiv, Kherson microdistricts: '
        'renovated 1970s type-project kindergartens (H / P plans, EIFS insulation in pastel render, white PVC windows, added metal '
        'gable roofs) with taped and sandbagged windows and shell damage; district boiler houses with guyed steel stacks; ATB / '
        'Silpo-type single-storey retail boxes with shot-out storefronts; MAF pharmacy pavilions; GSK garage rows; street-workout '
        'sets and modern playgrounds; Lanos / Sens hatchbacks, compact crossovers, Sprinter vans incl. volunteer medevac vans; '
        'burnt-out cars and city buses (Bogdan / Electron 12 m); FBS-block checkpoints with tyres, sandbags and hedgehogs; '
        'anti-drone net tunnels over frontline roads (Kostiantynivka / Kramatorsk / Kherson 2024-25).')
