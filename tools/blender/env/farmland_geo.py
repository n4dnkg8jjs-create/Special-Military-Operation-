"""Farm buildings, machinery, village yard props and earthworks for farmland.glb (material 0 = farmland_atlas,
material 1 = farmland_foliage for wattle / torn greenhouse film).  glTF space: +Y up, metres, origin at the ground
centre of the footprint, front = +Z, long axes along X where the brief asks for it.  Weathering / soot / burn
darkening is baked into per-vertex colour (TMB.VC) so the shared atlas regions stay tileable.
"""
import math
import numpy as np
from shapely.geometry import Polygon, box as sbox
from meshlib import MB, Region, Fit, newell, xform, mat_trs, rot_axis, rng, blob
import farmland_trees as FT          # sets G.R to the farmland atlas regions, TMB, card()
import city_geo as G
from city_geo import tquad, tbox, fbox, wall, lathe, prism, quad, chunk

TMB, FR, LEAF = FT.TMB, FT.FR, FT.LEAF
PI = math.pi


def T(x=0.0, y=0.0, z=0.0):
    return mat_trs((x, y, z))


def RY(a, t=(0, 0, 0)):
    return mat_trs(t, (0, a, 0))


def RS(name, s0, t0, s1, t1):
    return G.R[name].sub(s0, t0, s1, t1)


def tint(mb, fn, start=0):
    """Per-vertex colour multiplier fn(p) -> scalar or rgb for vertices start.. (weathering / soot / burn)."""
    V = np.array(mb.V)
    for i in range(start, len(V)):
        k = fn(V[i])
        k = np.array([k, k, k]) if np.isscalar(k) else np.asarray(k, float)
        prev = mb.VC.get(i, np.ones(3))
        mb.VC[i] = prev * np.clip(k, 0, 1.5)


def soot_blob(c, r, k=0.25):
    c = np.asarray(c, float)
    return lambda p: 1 - (1 - k) * math.exp(-float(np.sum((p - c) ** 2)) / (r * r))


def ground_ao(h=0.6, k=0.7):
    return lambda p: k + (1 - k) * min(1.0, max(0.0, p[1] / h))


def cyl(mb, p0, p1, r, sides, reg, seg=1.0, cap=False):
    G.tube(mb, [p0, p1], r, sides, reg, seg=seg, cap=cap)


def beam(mb, a, b, w, h, reg, tile=(1.0, 1.0), up=(0, 1, 0)):
    """Rectangular beam from a to b (cross-section w x h, 'up' orientation), 4 sides + ends."""
    a = np.asarray(a, float); b = np.asarray(b, float); d = b - a; L = float(np.linalg.norm(d)); d /= L
    up = np.asarray(up, float); s = np.cross(d, up)
    if np.linalg.norm(s) < 1e-6:
        s = np.cross(d, [1, 0, 0])
    s /= np.linalg.norm(s); u = np.cross(s, d)
    M = np.eye(4); M[:3, 0] = d; M[:3, 1] = u; M[:3, 2] = s; M[:3, 3] = a
    tile = (max(tile[0], 2.5), max(tile[1], 1.0))    # thin members: long texture repeats keep the tri count down
    tbox(mb, (0, -h / 2, -w / 2), (L, h / 2, w / 2), reg, tile, M=M)


def slab_roof(mb, a, b, wid, th, top_reg, top_tile, under_reg, edge_reg=None):
    """Mono-pitch roof sheet with real thickness: a = front-left top corner, b = back-left top corner, width along +X.
    Top (faces up), underside, and the four edges -- no open seams, no paper-thin floating sheets."""
    a = np.asarray(a, float); b = np.asarray(b, float); X = np.array([wid, 0, 0.0]); dn = np.array([0, -th, 0.0])
    Lv = float(np.linalg.norm(a - b))
    tquad(mb, b + X, (-1, 0, 0), a - b, wid, Lv, top_reg, top_tile)                       # top, normal up
    tquad(mb, a + X + dn, (-1, 0, 0), b - a, wid, Lv, under_reg, (3, 3))                 # underside, normal down
    er = edge_reg or under_reg
    for P in ([a, a + X, a + X + dn, a + dn], [b + X, b, b + dn, b + X + dn], [b, a, a + dn, b + dn], [a + X, b + X, b + X + dn, a + X + dn]):
        P = np.array(P)
        c = P.mean(0); n = newell(P); cen = (a + b + X) / 2 + dn / 2
        if n @ (c - cen) < 0:
            P = P[::-1]
        quad(mb, P, er)


def disc(mb, c, nrm, r, n, reg, rad_uv=0.5):
    c = np.asarray(c, float); nrm = np.asarray(nrm, float); nrm /= np.linalg.norm(nrm)
    a = np.cross(nrm, [0, 1, 0] if abs(nrm[1]) < 0.9 else [1, 0, 0]); a /= np.linalg.norm(a); b = np.cross(nrm, a)
    rg = G.R[reg] if isinstance(reg, str) else reg
    P = [c + (a * math.cos(t) + b * math.sin(t)) * r for t in np.linspace(0, 2 * PI, n, endpoint=False)]
    uv = [rg.uv(0.5 + rad_uv * math.cos(t), 0.5 + rad_uv * math.sin(t)) for t in np.linspace(0, 2 * PI, n, endpoint=False)]
    if np.dot(newell(np.array(P)), nrm) < 0:
        P = P[::-1]; uv = uv[::-1]
    mb.face(mb.vs(P), uv)


def lathe_bands(mb, r0, y0, y1, segs, reg, around=3, band=1.0, M=None, r1=None):
    """Cylinder (or cone r0->r1) built from stacked bands so the region repeats every `band` metres up it."""
    r1 = r0 if r1 is None else r1
    n = max(1, int(round((y1 - y0) / band)))
    for i in range(n):
        ya, yb = y0 + (y1 - y0) * i / n, y0 + (y1 - y0) * (i + 1) / n
        ra, rb = r0 + (r1 - r0) * i / n, r0 + (r1 - r0) * (i + 1) / n
        lathe(mb, [(ra, ya), (rb, yb)], segs, reg, M=M, around=around)


# ====================================================================== hay
def haybale(name, burnt=False, seed=1):
    """Round bale 1.5 m dia x 1.2 m, axis along X, sat on the ground (slightly flattened contact)."""
    mb = TMB(name); r = rng(seed)
    R, W, n = 0.75, 1.2, 16
    side = 'hay_burnt' if burnt else 'hay_side'; end = 'hay_burnt' if burnt else 'hay_end'
    rings = []
    xs = [-W / 2, -W / 2 + 0.06, 0, W / 2 - 0.06, W / 2]
    rs = [R * 0.93, R, R * 1.02, R, R * 0.93]
    ids = []
    for x, rr in zip(xs, rs):
        ring = []
        for k in range(n):
            a = 2 * PI * k / n
            j = 1 + (r.normal(0, 0.05) if burnt else r.normal(0, 0.012))
            y = R + math.sin(a) * rr * j; z = math.cos(a) * rr * j
            if burnt:
                y = R * 0.82 + math.sin(a) * rr * j * (0.82 if math.sin(a) > 0 else 1.0)
            y = max(y, 0.0)
            ring.append((x, y, z))
        rings.append(mb.vs(ring))
    rg = G.R[side]
    for i in range(len(xs) - 1):
        for k in range(n):
            k2 = (k + 1) % n
            u0 = (k % (n // 2)) / (n // 2); u1 = u0 + 1.0 / (n // 2)
            mb.face((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]),
                    [rg.uv(u0, i / 4), rg.uv(u1, i / 4), rg.uv(u1, (i + 1) / 4), rg.uv(u0, (i + 1) / 4)], True)
    eg = G.R[end]
    for i, sgn in ((0, -1), (len(xs) - 1, 1)):
        ring = rings[i]
        P = np.array([mb.V[q] for q in ring]); c = P.mean(0) + [sgn * 0.03, 0, 0]
        ci = mb.v(c)
        for k in range(n):
            k2 = (k + 1) % n
            tri = (ring[k], ring[k2], ci) if sgn > 0 else (ring[k2], ring[k], ci)
            uv = [eg.uv(0.5 + 0.5 * (mb.V[t][2] - c[2]) / R, 0.5 + 0.5 * (mb.V[t][1] - c[1]) / R) for t in tri]
            mb.face(tri, uv, False)
    if burnt:   # ash ring on the ground + charred straw tufts
        ring = []
        for k in range(10):
            a = 2 * PI * k / 10; rr = 0.95 * r.uniform(0.85, 1.15)
            ring.append((math.cos(a) * rr * 1.1, 0.015, math.sin(a) * rr))
        P = np.array(ring); mb.poly(P[::-1] if newell(P)[1] < 0 else P, G.fit('ash', (2.5, 2.5)))
        tint(mb, lambda p: 0.75 + 0.25 * min(1, p[1] / 1.2))
    else:
        tint(mb, ground_ao(0.5, 0.65))
    return mb


def haystack(name='haystack', seed=7):
    """Traditional Ukrainian stog: loaf-shaped stack ~4.6 m high, 4 m base, rounded top with a pole, a few
    weighting poles / a rope net hanging down, loose straw skirt at the foot."""
    mb = TMB(name); r = rng(seed)
    prof = [(1.75, 0.0), (2.05, 0.5), (2.1, 1.3), (1.95, 2.3), (1.6, 3.2), (1.05, 3.9), (0.45, 4.4), (0.08, 4.62)]
    lathe(mb, prof, 14, 'straw', around=3, jitter=lambda i, k: 1 + 0.06 * math.sin(k * 1.7 + i) + r.normal(0, 0.025))
    lathe(mb, [(2.6, 0.01), (2.0, 0.25), (1.8, 0.5)], 14, 'straw', around=3, jitter=lambda i, k: 1 + r.normal(0, 0.08))
    cyl(mb, (0, 3.6, 0), (0.05, 5.3, 0.03), 0.05, 4, 'wood_grey')
    for k in range(4):   # crossed weighting poles tied over the top
        a = k * PI / 4 + 0.3
        p0 = np.array([math.cos(a) * 1.95, 1.9, math.sin(a) * 1.95]); p1 = np.array([0, 4.62, 0]); p2 = -p0 * [1, 0, 1] + [0, 1.9, 0]
        G.tube(mb, [p0, (p0 + p1) / 2 * [1.12, 1.0, 1.12] + [0, 0.2, 0], p1 + [0, 0.05, 0]], 0.035, 4, 'wood_grey', seg=2)
        G.tube(mb, [p1 + [0, 0.05, 0], (p2 + p1) / 2 * [1.12, 1.0, 1.12] + [0, 0.2, 0], p2], 0.035, 4, 'wood_grey', seg=2)
    tint(mb, lambda p: (0.62 + 0.38 * min(1, p[1] / 2.5)) * (0.9 + 0.1 * math.sin(p[0] * 2 + p[2])))
    return mb


# ====================================================================== kolkhoz cowshed
def barn(name, damaged=False, seed=20):
    """Kolkhoz cowshed (korivnyk), 60 x 12 m, long axis X: white silicate-brick walls on a concrete plinth with
    brick pilasters every 6 m, a row of small high windows, asbestos-slate pitched roof (20 deg) on an
    overhang, ridge vents, end walls with big double plank gates and a man-door.  Damaged: 3 roof bays caved in
    (sheets hanging, trusses exposed, debris inside), shell holes through the +Z wall, scorched gable, one gate gone."""
    mb = TMB(name); r = rng(seed)
    L, D, He, th = 60.0, 12.0, 3.4, 0.38
    pitch = math.radians(20); ta = math.tan(pitch)
    yr = He + D / 2 * ta
    ov = 0.45
    win_w, win_h, sill = 1.5, 0.9, 2.05
    holes_front = [blob(-8.5, 1.6, 1.1, 0.95, 16, seed + 1, 0.35, 0.4), blob(5.0, 2.3, 0.8, 0.7, 14, seed + 2, 0.3, 0.3),
                   blob(17.5, 1.2, 1.4, 1.1, 18, seed + 3, 0.35, 0.5)] if damaged else []
    # ---- plinth (concrete, proud 4 cm)
    for M, Lw in ((T(0, 0, D / 2 + 0.04), L + 0.08), (RY(PI, (0, 0, -D / 2 - 0.04)), L + 0.08), (RY(PI / 2, (L / 2 + 0.04, 0, 0)), D + 0.08), (RY(-PI / 2, (-L / 2 - 0.04, 0, 0)), D + 0.08)):
        tquad(mb, (-Lw / 2, 0, 0), (1, 0, 0), (0, 1, 0), Lw, 0.5, 'concrete', (2.0, 0.5), M=M)
        tquad(mb, (-Lw / 2, 0.5, 0), (1, 0, 0), (0, 0, -1), Lw, 0.06, 'concrete', (2.0, 0.5), M=M)
    # ---- long walls with windows
    xs = np.arange(-L / 2 + 3, L / 2 - 2, 3.0)
    for side, M in ((1, T(0, 0, D / 2)), (-1, RY(PI, (0, 0, -D / 2)))):
        wins = []
        for x in xs:
            if abs((x + L / 2) % 6) < 0.1:     # pilaster positions
                continue
            wins.append((x - win_w / 2, sill, x + win_w / 2, sill + win_h))
        doors = [(-14.6, 0.5, -13.4, 2.6), (13.4, 0.5, 14.6, 2.6)]
        holes = wins + doors
        if side > 0:
            holes = [h for h in holes if not any(Polygon(b).intersects(sbox(*h)) for b in holes_front)] + holes_front
        wall(mb, (-L / 2, 0.5, L / 2, He), th, 'brick_white', (1.0, 1.0), holes=holes, M=M, back='plaster_white' if damaged else False, cap='none')
        for (x0, y0, x1, y1) in wins:
            if side > 0 and any(Polygon(b).intersects(sbox(x0, y0, x1, y1)) for b in holes_front):
                continue
            tquad(mb, (x0, y0, -0.22), (1, 0, 0), (0, 1, 0), x1 - x0, y1 - y0, RS('window_barn', 0, 0, 1, 1), (x1 - x0, y1 - y0), M=M)
            tquad(mb, (x0 - 0.06, y0 - 0.08, 0.04), (1, 0, 0), (0, 0, -1), x1 - x0 + 0.12, 0.3, 'concrete', (2, 1), M=M)    # sill
            tquad(mb, (x0 - 0.06, y0 - 0.08, 0.04), (1, 0, 0), (0, 1, 0), x1 - x0 + 0.12, 0.08, 'concrete', (2, 1), M=M)
        for (x0, y0, x1, y1) in doors:
            tquad(mb, (x0, y0, -0.12), (1, 0, 0), (0, 1, 0), x1 - x0, y1 - y0, RS('door_blue', 0, 0, 1, 1), (x1 - x0, y1 - y0), M=M)
            tquad(mb, (x0 - 0.3, y1 + 0.12, 0.5), (1, 0, 0), (0, 0, -1), x1 - x0 + 0.6, 0.5, 'concrete', (2, 1), M=M)
        # pilasters
        for x in np.arange(-L / 2, L / 2 + 0.1, 6.0):
            if side > 0 and any(Polygon(b).intersects(sbox(x - 0.3, 0.5, x + 0.3, He)) for b in holes_front):
                continue
            tbox(mb, (x - 0.26, 0.5, 0), (x + 0.26, He, 0.13), 'brick_white', (1, 1), faces='+x-x+z', M=M)
        # eaves cornice band (concrete lintel strip)
        tbox(mb, (-L / 2, He - 0.25, 0), (L / 2, He, 0.06), 'concrete', (3, 0.5), faces='+z-y', M=M)
    # ---- end walls (gables) with double gates
    gw, gh = 3.6, 3.0
    for sx, M in ((1, RY(PI / 2, (L / 2, 0, 0))), (-1, RY(-PI / 2, (-L / 2, 0, 0)))):
        Lw = D
        outline = [(-Lw / 2, 0.5), (Lw / 2, 0.5), (Lw / 2, He), (0, yr), (-Lw / 2, He)]
        gate = (-gw / 2, 0.5, gw / 2, 0.5 + gh)
        holes = [gate, (3.3, 0.5, 4.3, 2.6)]
        reg = 'brick_white'
        wall(mb, outline, th, reg, (1.0, 1.0), holes=holes, M=M, back='plaster_white' if damaged else False, cap='none')
        tquad(mb, (-gw / 2 - 0.15, 0.5 + gh, 0.008), (1, 0, 0), (0, 1, 0), gw + 0.3, 0.3, 'concrete', (2, 0.5), M=M)   # lintel
        gone = damaged and sx > 0
        if not gone:
            tquad(mb, (-gw / 2, 0.5, -0.18), (1, 0, 0), (0, 1, 0), gw, gh, RS('gate_barn', 0, 0, 1, 1), (gw, gh), M=M)
        else:   # one leaf torn off, lying in front; the other hanging open
            tquad(mb, (0, 0.5, -0.18), (1, 0, 0), (0, 1, 0), gw / 2, gh, RS('gate_barn', 0.5, 0, 1, 1), (gw / 2, gh), M=M @ T(gw / 2, 0, 0) @ RY(-1.9) @ T(-gw / 2, 0, 0))
            Mg = M @ T(-0.5, 0.06, 3.0) @ mat_trs((0, 0, 0), (-PI / 2 + 0.08, 0.4, 0))
            tquad(mb, (-gw / 4, 0, 0), (1, 0, 0), (0, 1, 0), gw / 2, gh, RS('gate_barn', 0, 0, 0.5, 1), (gw / 2, gh), M=Mg, double=False)
        tquad(mb, (3.3, 0.5, -0.12), (1, 0, 0), (0, 1, 0), 1.0, 2.1, RS('door_blue', 0, 0, 1, 1), (1.0, 2.1), M=M)
        # gable vent louvre
        tquad(mb, (-0.6, He + 0.6, 0.008), (1, 0, 0), (0, 1, 0), 1.2, 0.7, RS('grille', 0, 0, 1, 1), (1.2, 0.7), M=M)
    # ---- roof
    rise, run = ta, 1.0
    slope_len = (D / 2 + ov) / math.cos(pitch)
    ye = He + 0.035 - ov * ta      # sheet (3 cm incl. underside) resting on the wall heads / gable tops (was +0.12: roof hovered 9 cm up)
    bays = [(-L / 2 - 0.4 + i * 6.08, -L / 2 - 0.4 + (i + 1) * 6.08) for i in range(10)]
    lost = {('+', 3), ('+', 4), ('+', 5), ('-', 4)} if damaged else set()
    sag = {('-', 3), ('-', 5)} if damaged else set()
    for sgn in (1, -1):
        key = '+' if sgn > 0 else '-'
        dv = np.array([0, math.sin(pitch), -sgn * math.cos(pitch)])
        for i, (x0, x1) in enumerate(bays):
            if (key, i) in lost:
                continue
            o = np.array([x0 if sgn > 0 else x1, ye, sgn * (D / 2 + ov)])
            du = np.array([1.0 if sgn > 0 else -1.0, 0, 0])
            Lu = x1 - x0
            M = None
            if (key, i) in sag:   # sheets cracked and sagging into the bay
                M = rot_axis(du, sgn * 0.18 * (1 if i == 3 else -1), origin=o + du * (Lu if i == 3 else 0))
            ncol = int(round(Lu / 1.13))
            for c_ in range(ncol):
                old = damaged and r.random() < 0.3      # intact roof: uniform sheets (odd old columns read as stripes)
                tquad(mb, o + du * Lu * c_ / ncol, du, dv, Lu / ncol, slope_len, 'slate_old' if old else 'slate', (Lu / ncol, 1.75), M=M)
            # underside (dark), visible from below / through damage
            P = [o, o + dv * slope_len, o + dv * slope_len + du * Lu, o + du * Lu]
            P = [p - np.array([0, 0.03, 0]) for p in P]
            if M is not None:
                P = list(xform(np.array(P), M))
            mb.poly(P, G.fit('interior_dark', (6, 6)))
        # fascia board along the eave
        tquad(mb, (-sgn * (L / 2 + 0.4), ye - 0.18, sgn * (D / 2 + ov)), (sgn, 0, 0), (0, 1, 0), L + 0.8, 0.18, 'wood_grey', (2, 0.5))
    # ridge cap + vents
    cap_y = He + 0.035 + D / 2 * ta
    for i, (x0, x1) in enumerate(bays):
        if damaged and i in (3, 4, 5):
            continue
        for sgn in (1, -1):
            o = np.array([x0, cap_y + 0.02, 0]); du = np.array([1.0, 0, 0]); dv = np.array([0, -math.sin(0.5), sgn * math.cos(0.5)])
            if sgn > 0:
                o = o + du * (x1 - x0); du = -du
            tquad(mb, o, du, dv, x1 - x0, 0.3, 'slate', (1.13, 1.75))
        if i % 2 == 1:
            xc = (x0 + x1) / 2
            tbox(mb, (xc - 0.5, cap_y - 0.25, -0.5), (xc + 0.5, cap_y + 0.55, 0.5), 'wood_grey', (1, 1), faces='+x-x+z-z')   # vent box down into the roof
            tquad(mb, (xc - 0.65, cap_y + 0.45, 0.75), (1, 0, 0), (0, 0.3, -0.75), 1.3, 0.81, 'slate', (1.13, 1.75))   # vent cap on the box (was 5 cm above it)
            tquad(mb, (xc + 0.65, cap_y + 0.5, -0.75), (-1, 0, 0), (0, 0.3, 0.75), 1.3, 0.81, 'slate', (1.13, 1.75))
    # gable verge boards
    for sx in (1, -1):
        for sgn in (1, -1):
            a = np.array([sx * (L / 2 + 0.4), ye - 0.18, sgn * (D / 2 + ov)]); b = np.array([sx * (L / 2 + 0.4), cap_y, 0])
            beam(mb, a, b, 0.04, 0.2, 'wood_grey', (2, 0.5))
    if damaged:
        _barn_damage(mb, r, L, D, He, ye, pitch, bays, holes_front)
    else:
        tint(mb, lambda p: (0.78 + 0.22 * min(1, p[1] / 1.6)) * (1 - 0.1 * max(0, 1 - abs(p[2]) / 6.2) * (p[1] > He + 0.05)))
    # interior floor (straw bedding / manure) -- visible through the gates / damage
    if damaged:
        tquad(mb, (-L / 2, 0.03, D / 2 - th), (1, 0, 0), (0, 0, -1), L, D - 2 * th, 'straw_bedding', (2.0, 2.0))
    return mb


def _barn_damage(mb, r, L, D, He, ye, pitch, bays, holes_front):
    th = 0.38
    # trusses left standing in the open bays (timber rafters + tie beam), some broken
    for i in (3, 4, 5, 6):
        x = bays[i][0] + 0.04
        broken = i == 4
        a = np.array([x, He, D / 2 - th]); b = np.array([x, He + D / 2 * math.tan(pitch) + 0.1, 0]); c = np.array([x, He, -D / 2 + th])
        if not broken:
            beam(mb, a, b, 0.14, 0.2, 'wood_grey', (2, 0.5)); beam(mb, b, c, 0.14, 0.2, 'wood_grey', (2, 0.5))
        else:
            beam(mb, c, c + (b - c) * 0.55, 0.14, 0.2, 'wood_grey', (2, 0.5))
            m = a + (b - a) * 0.4
            beam(mb, a, m, 0.14, 0.2, 'wood_grey', (2, 0.5))
            beam(mb, m, m + np.array([0.4, -2.2, -1.2]), 0.12, 0.18, 'wood_grey', (2, 0.5))
        beam(mb, a + [0, 0.1, 0], c + [0, 0.1, 0], 0.16, 0.18, 'wood_grey', (2, 0.5))
    # purlins spanning the hole (some snapped)
    for z in (4.2, 1.8):
        beam(mb, (bays[3][0], He + (D / 2 - z) * math.tan(pitch) + 0.05, z), (bays[3][0] + 7.0, He + (D / 2 - z) * math.tan(pitch) - 0.6, z), 0.1, 0.12, 'wood_grey', (2, 0.5))
        beam(mb, (bays[6][0], He + (D / 2 - z) * math.tan(pitch) + 0.05, z), (bays[6][0] - 4.5, He + (D / 2 - z) * math.tan(pitch) - 1.1, z + 0.4), 0.1, 0.12, 'wood_grey', (2, 0.5))
    # hanging / fallen slate sheets
    from meshfix import drop
    sheets = []
    for k in range(9):
        x = r.uniform(bays[3][0] + 0.5, bays[5][1] - 1.5); z = r.uniform(-4.5, 5.0)
        y = r.uniform(0.15, 2.5)
        M = mat_trs((x, y, z), (r.uniform(-1.2, 1.2) * 0.45, r.uniform(0, PI), r.uniform(-0.9, 0.9) * 0.45))
        part = TMB('sheet')
        tquad(part, (0, 0, 0), (1, 0, 0), (0, 0, 1), 1.13, 1.75, 'slate_old', (1.13, 1.75), M=M)
        tquad(part, (1.13, 0, 0), (-1, 0, 0), (0, 0, 1), 1.13, 1.75, 'interior_dark', (3, 3), M=M)
        sheets.append(part)
    # debris heap on the floor under the hole
    for k in range(26):
        x = r.uniform(bays[3][0], bays[5][1]); z = r.uniform(-4.5, 4.5)
        s = r.uniform(0.3, 1.0)
        part = TMB('chunk')
        chunk(part, (x, s * 0.25 + 0.3, z), (s * 1.5, s * 0.5, s), 900 + k, 'slate_old' if k % 3 else 'brick_white')
        drop(mb, part, sink=0.04, ground=0.0)
    for part in sheets:       # fallen sheets come to rest on the heap / the floor (were hanging in mid-air)
        drop(mb, part, sink=0.01, ground=0.0)
    # spill of bricks / rubble outside each shell hole, sooty rim
    for hb in holes_front:
        P = np.asarray(hb); cx, cy = P.mean(0)
        for k in range(7):
            s = r.uniform(0.15, 0.4)
            part = TMB('chunk')
            chunk(part, (cx + r.normal(0, 0.8), s * 0.3 + 0.3, D / 2 + r.uniform(0.2, 1.6)), (s * 1.4, s * 0.6, s), 950 + k + int(cx * 10), 'brick_white')
            drop(mb, part, sink=0.03, ground=0.0, step_up=True)
    # scorch: soot around holes, on the +X gable, and over the caved-in bays
    fns = [soot_blob((float(np.asarray(hb).mean(0)[0]), float(np.asarray(hb).mean(0)[1]) + 0.8, D / 2), 2.2, 0.2) for hb in holes_front]
    fns.append(soot_blob((L / 2, 4.5, 0), 4.5, 0.25))
    fns.append(soot_blob(((bays[3][0] + bays[5][1]) / 2, He + 1, 0), 9.0, 0.35))
    def f(p):
        k = 0.78 + 0.22 * min(1, p[1] / 1.6)
        for fn in fns:
            k *= fn(p)
        return k
    tint(mb, f)


# ====================================================================== machine shed
def machine_shed(name='machine_shed', seed=30):
    """Open steel-frame machinery shed 30 x 15 m, long axis X: 6 portal frames (I-section columns, trussed
    rafters), purlins, corrugated galvanised roof (sheets missing over two bays, a few torn / hanging, rusty),
    the back (-Z) wall clad to 2.4 m, concrete floor slab, an old trailer axle and oil drums left inside."""
    mb = TMB(name); r = rng(seed)
    L, D, He = 30.0, 15.0, 5.6
    pitch = math.radians(12); ta = math.tan(pitch)
    yr = He + D / 2 * ta
    tquad(mb, (-L / 2 - 0.5, 0.06, D / 2 + 0.5), (1, 0, 0), (0, 0, -1), L + 1, D + 1, 'concrete', (2, 2))
    for sgn in (1, -1):    # slab edge
        tquad(mb, (-sgn * (L / 2 + 0.5), 0, sgn * (D / 2 + 0.5)), (sgn, 0, 0), (0, 1, 0), L + 1, 0.06, 'concrete', (2, 1))
    xs = np.linspace(-L / 2, L / 2, 6)
    for i, x in enumerate(xs):
        for sgn in (1, -1):
            z = sgn * D / 2
            lean = (0.25 if (i == 4 and sgn > 0) else 0.0)
            # I column: web + 2 flanges as thin boxes
            top = np.array([x + lean, He, z])
            beam(mb, (x, 0.06, z), top, 0.3, 0.02 + 0.28, 'steel_rust', (1, 1), up=(1, 0, 0))
            tbox(mb, (x - 0.25, 0.06, z - 0.25), (x + 0.25, 0.3, z + 0.25), 'concrete', (1, 1), faces='+x-x+y+z-z')
        # rafter truss: top chord, bottom chord, diagonals
        for sgn in (1, -1):
            a = np.array([x, He, sgn * D / 2]); b = np.array([x, yr, 0]); c = np.array([x, He, 0])
            beam(mb, a, b, 0.16, 0.22, 'steel_rust', (1, 1))
            beam(mb, a, c + [0, 0, 0], 0.08, 0.08, 'steel_rust', (1, 1))
            for t in (0.33, 0.66):
                p = a + (b - a) * t; q = a + (c - a) * (t + 0.17)
                beam(mb, p, q, 0.06, 0.06, 'steel_rust', (1, 1))
        beam(mb, (x, He, 0), (x, yr, 0), 0.08, 0.08, 'steel_rust', (1, 1))
    # purlins + roof sheets
    nz = 5
    for sgn in (1, -1):
        for j in range(nz + 1):
            z = sgn * (D / 2 + 0.3) * (1 - j / nz) if j > 0 else sgn * (D / 2 - 0.06)     # eave purlin sits on the rafter ends
            y = He + (D / 2 - abs(z)) * ta + 0.14
            if j < nz:
                beam(mb, (-L / 2 - 0.3, y, z), (L / 2 + 0.3, y, z), 0.1, 0.14, 'steel_rust', (1, 1))
        dv = np.array([0, math.sin(pitch), -sgn * math.cos(pitch)])
        slope_len = (D / 2 + 0.3) / math.cos(pitch)
        ye = He + 0.23 - 0.3 * ta      # sheet underside on the purlin tops (was 1-3 cm above them)
        for i in range(5):
            x0, x1 = xs[i] - (0.3 if i == 0 else 0), xs[i + 1] + (0.3 if i == 4 else 0)
            missing = (i == 2 and sgn > 0) or (i == 3)
            n_sh = int(round((x1 - x0) / 2.0))
            for k in range(n_sh):
                xa, xb = x0 + (x1 - x0) * k / n_sh, x0 + (x1 - x0) * (k + 1) / n_sh
                if missing and r.random() < 0.85:
                    if r.random() < 0.35:   # hanging torn sheet
                        o = np.array([xa if sgn > 0 else xb, ye - 0.025 + slope_len * 0.6 * math.sin(pitch), sgn * (D / 2 + 0.3 - slope_len * 0.6 * math.cos(pitch))])
                        M = rot_axis((1, 0, 0), sgn * r.uniform(1.0, 1.4), origin=o)
                        du = np.array([1.0 if sgn > 0 else -1.0, 0, 0])
                        tquad(mb, o, du, dv, xb - xa, r.uniform(1.2, 2.6), 'corr_rust', (xb - xa, 2.0), M=M, double=True)
                    continue
                o = np.array([xa if sgn > 0 else xb, ye, sgn * (D / 2 + 0.3)]); du = np.array([1.0 if sgn > 0 else -1.0, 0, 0])
                reg = 'corr_rust' if r.random() < 0.4 else 'tin_galv'
                Ls = slope_len if not (missing or r.random() < 0.06) else slope_len * r.uniform(0.3, 0.7)
                tquad(mb, o, du, dv, xb - xa, Ls, reg, (xb - xa, 2.0))
                P = [o - [0, 0.02, 0], o + dv * Ls - [0, 0.02, 0], o + dv * Ls + du * (xb - xa) - [0, 0.02, 0], o + du * (xb - xa) - [0, 0.02, 0]]
                mb.poly(P, G.fit('steel_rust', (2, 2)))
    # back wall cladding (-Z), 2.4 m, corrugated
    tquad(mb, (L / 2, 0.06, -D / 2 - 0.155), (-1, 0, 0), (0, 1, 0), L, 2.4, 'corr_rust', (1.0, 2.4), double=True)
    # props left inside: oil drums, a tyre
    for k, (x, z) in enumerate(((-12.5, -6.3), (-11.7, -6.2), (-12.1, -5.5), (8.0, -6.0))):
        G.lathe(mb, [(0.0, 0.06), (0.29, 0.06), (0.29, 0.94), (0.0, 0.94)], 10, 'metal_rust_paint', M=T(x, 0, z), around=2)
    G.lathe(mb, [(0.35, 0.06), (0.55, 0.12), (0.6, 0.28), (0.55, 0.44), (0.35, 0.5)], 12, 'rubber', M=T(3, 0, -5.8))
    tint(mb, lambda p: 0.75 + 0.25 * min(1, p[1] / 2.0))
    return mb


# ====================================================================== grain silo / elevator
def grain_silo(name='grain_silo', seed=40):
    """Kolkhoz grain store: two corrugated galvanised bins (6 m dia, 9 m wall, conical roofs with vents and
    manholes), a square bucket-elevator leg rising to 17 m between them with a head house, spouts down to each
    bin roof, caged ladders, concrete pads.  Footprint ~14.5 x 7 m along X."""
    mb = TMB(name); r = rng(seed)
    Rb, Hb = 3.0, 9.0
    for sx in (-1, 1):
        cx = sx * 3.9
        lathe(mb, [(Rb + 0.25, 0.0), (Rb + 0.25, 0.3), (Rb, 0.3)], 20, 'concrete', M=T(cx, 0, 0), around=6)
        lathe_bands(mb, Rb, 0.3, Hb, 20, 'silo_steel', around=6, band=1.0, M=T(cx, 0, 0))
        lathe(mb, [(Rb + 0.08, Hb - 0.07), (Rb * 0.18, Hb + 2.1), (0.0, Hb + 2.2)], 20, 'tin_galv', M=T(cx, 0, 0), around=6)   # eave on the wall head
        lathe(mb, [(0.35, Hb + 2.1), (0.35, Hb + 2.55), (0.5, Hb + 2.6), (0.0, Hb + 2.75)], 8, 'tin_galv', M=T(cx, 0, 0))
        # ladder up the side
        for dz in (-0.22, 0.22):
            cyl(mb, (cx + sx * (Rb + 0.25), 0.3, dz), (cx + sx * (Rb + 0.25), Hb + 0.4, dz), 0.025, 4, 'steel_rust', seg=3)
        for y in np.arange(0.6, Hb, 0.3 * 3):
            cyl(mb, (cx + sx * (Rb + 0.25), y, -0.22), (cx + sx * (Rb + 0.25), y, 0.22), 0.015, 3, 'steel_rust')
        # rust streak tint
    # elevator leg (box tower 1.0 x 0.7) to 17 m + head house
    tbox(mb, (-0.5, 0, -0.35), (0.5, 15.5, 0.35), 'tin_galv', (1.0, 2.0), faces='+x-x+z-z')
    tbox(mb, (-1.0, 15.5, -0.8), (1.0, 17.2, 0.8), 'corr_rust', (1.0, 1.7), faces='+x-x+z-z')
    for sgn in (1, -1):
        tquad(mb, (-sgn * 1.15, 17.2, sgn * 0.95), (sgn, 0, 0), (0, 0.35, -sgn * 0.95), 2.3, 1.02, 'tin_galv', (1, 2))
    for sgn in (1, -1):
        P = [(sgn * 1.0, 17.2, 0.8), (sgn * 1.0, 17.2, -0.8), (sgn * 1.0, 17.55, 0)]
        mb.poly(P if sgn > 0 else P[::-1], G.fit('corr_rust', (1.6, 0.4)))
    # spouts from the head down to each bin roof
    for sx in (-1, 1):
        G.tube(mb, [(sx * 0.9, 16.2, 0), (sx * 3.9, Hb + 2.4, 0)], 0.14, 6, 'steel_rust', seg=2)
    # ground hopper / pit cover and caged ladder on the leg
    tbox(mb, (-1.4, 0, 0.35), (1.4, 0.9, 2.2), 'concrete', (1, 1), faces='+x-x+y+z')
    tquad(mb, (-1.2, 0.91, 2.0), (1, 0, 0), (0, 0, -1), 2.4, 1.5, RS('grille', 0, 0, 1, 1), (2.4, 1.5))
    for dx in (-0.25, 0.25):
        cyl(mb, (dx, 0.9, 0.62), (dx, 15.5, 0.62), 0.025, 4, 'steel_rust', seg=3)
    for y in np.arange(1.2, 15.5, 0.9):
        cyl(mb, (-0.25, y, 0.62), (0.25, y, 0.62), 0.015, 3, 'steel_rust')
        if y > 2.5:
            G.tube(mb, [(-0.4, y, 0.34), (-0.4, y, 1.1), (0.4, y, 1.1), (0.4, y, 0.34)], 0.015, 3, 'steel_rust', seg=3)
    tint(mb, lambda p: (0.72 + 0.28 * min(1, p[1] / 3.0)) * (0.92 + 0.08 * math.sin(p[0] * 3.1 + p[2] * 2.3)))
    return mb


# ====================================================================== Rozhnovsky water tower
def water_tower(name, damaged=False, seed=50):
    """Rozhnovsky water tower (bashnya Rozhnovskogo), ~18 m: riveted steel shaft (1.8 m dia, 13 m) on a concrete
    footing with a door, wider tank (3.6 m dia x 3.4 m) with a conical roof, hatch and vent, external ladder and a
    rim walkway.  Damaged: tank shot through (holed plates, a torn panel peeled outward), walkway rail bent,
    ladder broken off below the tank, leaning ~2 deg, rust/water streaks."""
    mb = TMB(name); r = rng(seed)
    Rs, Hs, Rt, Ht = 0.9, 13.2, 1.8, 3.4
    tank = 'tank_holed' if damaged else 'tank_rust'
    lathe(mb, [(1.5, 0.0), (1.5, 0.45), (1.1, 0.6), (Rs - 0.02, 0.66)], 16, 'concrete', around=4)
    lathe_bands(mb, Rs, 0.6, Hs, 16, 'tank_rust', around=3, band=1.05)
    lathe(mb, [(Rs, Hs), (Rt * 0.95, Hs + 0.5), (Rt, Hs + 0.7)], 20, 'tank_rust', around=4)
    lathe_bands(mb, Rt, Hs + 0.7, Hs + 0.7 + Ht, 20, tank, around=6, band=1.1)
    lathe(mb, [(Rt + 0.1, Hs + 0.7 + Ht - 0.065), (0.25, Hs + 0.7 + Ht + 1.0), (0.0, Hs + 0.7 + Ht + 1.05)], 20, 'tank_rust', around=4)
    yt = Hs + 0.7 + Ht + 1.05
    lathe(mb, [(0.12, yt - 0.1), (0.12, yt + 0.4), (0.25, yt + 0.45), (0.0, yt + 0.55)], 6, 'steel_rust')
    # door at the base
    tquad(mb, (-0.45, 0.65, Rs + 0.02), (1, 0, 0), (0, 1, 0), 0.9, 1.9, RS('door_blue', 0, 0, 1, 1), (0.9, 1.9))
    # walkway ring at the tank base + railing posts
    yw = Hs + 0.75
    lathe(mb, [(Rt, yw), (Rt + 0.6, yw), (Rt + 0.6, yw + 0.06), (Rt, yw + 0.06)], 20, RS('grille', 0, 0, 1, 1), around=6)
    posts = 16
    rail = []
    for k in range(posts):
        a = 2 * PI * k / posts
        bend = 0.35 if (damaged and 3 <= k <= 6) else 0.0
        p0 = np.array([math.cos(a) * (Rt + 0.58), yw + 0.06, math.sin(a) * (Rt + 0.58)])
        p1 = p0 + np.array([math.cos(a) * bend, 1.0 - bend * 0.8, math.sin(a) * bend])
        cyl(mb, p0, p1, 0.02, 3, 'steel_rust')
        rail.append(p1)
    for k in range(posts):
        if damaged and k == 4:
            continue
        cyl(mb, rail[k], rail[(k + 1) % posts], 0.02, 3, 'steel_rust')
    # ladder up the shaft (+X side) and on to the tank roof
    ytop = (Hs * 0.45) if damaged else yw
    for dz in (-0.22, 0.22):
        cyl(mb, (Rs + 0.2, 0.65, dz), (Rs + 0.2, ytop, dz), 0.025, 4, 'steel_rust', seg=3)
        cyl(mb, (Rt + 0.62, yw + 0.06, dz), (Rt + 0.2, Hs + 0.7 + Ht + 0.1, dz), 0.025, 4, 'steel_rust', seg=3)
    for y in np.arange(0.95, ytop, 0.6):
        cyl(mb, (Rs + 0.2, y, -0.22), (Rs + 0.2, y, 0.22), 0.015, 3, 'steel_rust')
    for y in np.arange(1.5, ytop - 0.3, 3.0):      # wall brackets: the ladder is fixed to the shaft (was free-standing)
        for dz in (-0.22, 0.22):
            cyl(mb, (Rs - 0.03, y, dz * 0.8), (Rs + 0.2, y, dz), 0.015, 3, 'steel_rust')
    if damaged:   # broken ladder piece lying at the foot, peeled tank plate
        lying = TMB('ladder')
        for dz in (-0.22, 0.22):
            cyl(lying, (Rs + 0.6, 0.025, dz - 1.6), (Rs + 1.9, 0.3, dz + 1.7), 0.025, 4, 'steel_rust', seg=3)
        a0 = 2.4
        c = np.array([math.cos(a0) * Rt * 0.985, Hs + 0.7 + Ht * 0.45, math.sin(a0) * Rt * 0.985])
        nrm = np.array([math.cos(a0), 0, math.sin(a0)]); tg = np.array([-math.sin(a0), 0, math.cos(a0)])
        P = [c - tg * 0.5 - [0, 0.5, 0], c + tg * 0.5 - [0, 0.5, 0], c + tg * 0.5 + nrm * 0.7 + [0, 0.1, 0], c - tg * 0.4 + nrm * 0.55 + [0, 0.3, 0]]
        mb.poly(P, G.fit('tank_rust', (1.2, 1.2))); mb.poly(P[::-1], G.fit('steel_rust', (1.2, 1.2)))
        disc(mb, c + nrm * 0.01, nrm, 0.45, 8, 'interior_dark')
    tint(mb, lambda p: (0.75 + 0.25 * min(1, p[1] / 2.0)))
    if damaged:
        mb.transform(rot_axis((0, 0, 1), math.radians(2.0)))
        tint(lying, lambda p: 0.75)
        mb.merge(lying)       # the broken-off ladder lies on the ground (not tilted with the tower)
    return mb


# ====================================================================== tractors / combine / trailer
def wheel(mb, c, R, w, rim_r, tyre=True, burnt=False, segs=16, rim='mtz_red', axis=(1, 0, 0)):
    """Tractor wheel about local X at c: tread band (chevron lugs) + rubber sidewalls + painted rim disc + hub.
    burnt: tyre gone, only the steel rim + bead wires remain (wheel sits lower, on the rim)."""
    c = np.asarray(c, float)
    M = T(*c) @ mat_trs((0, 0, 0), (0, 0, -PI / 2))     # lathe axis +Y -> +X
    if tyre and not burnt:
        lathe(mb, [(R * 0.96, -w / 2), (R, -w * 0.38), (R, w * 0.38), (R * 0.96, w / 2)], segs, 'tyre_tread', M=M, around=2)
        lathe(mb, [(rim_r, -w / 2 + 0.03), (R * 0.82, -w / 2 - 0.01), (R * 0.96, -w / 2)], segs, 'rubber', M=M, around=2)
        lathe(mb, [(R * 0.96, w / 2), (R * 0.82, w / 2 + 0.01), (rim_r, w / 2 - 0.03)], segs, 'rubber', M=M, around=2)
    reg = 'burnt_metal' if burnt else rim
    e = 0.03 if (tyre and not burnt) else 0.05
    lathe(mb, [(rim_r, -w / 2 + e), (rim_r, w / 2 - e)], segs, reg, M=M, around=1)
    if burnt:      # bare rim: the barrel is seen from both sides -> 8 mm steel wall with an inner face and edge rings
        ri = rim_r - 0.008
        lathe(mb, [(rim_r, w / 2 - e), (ri, w / 2 - e), (ri, -w / 2 + e), (rim_r, -w / 2 + e)], segs, reg, M=M, around=1)
    for s in (1, -1):
        y = s * (w / 2 - 0.08)
        prof = [(rim_r, y), (rim_r * 0.55, y * 0.5), (0.12, y * 0.5), (0.0, y * 0.5 + s * 0.05)]
        lathe(mb, prof if s > 0 else prof[::-1], segs, reg, M=M)
    if burnt:   # bead wire rings sagging
        G.tube(mb, [c + np.array([0, math.cos(t) * rim_r * 1.0, math.sin(t) * rim_r * 1.0]) for t in np.linspace(0, 2 * PI, 13)], 0.012, 3, 'steel_rust', seg=4)


def mtz80(name, burnt=False, seed=60):
    """MTZ-80 'Belarus' wheeled tractor (3.85 x 1.97 x 2.78 m), front = +Z: blue hood / frame, red wheel
    rims, white-grey cab with glazing, big 1.53 m rear and 0.97 m front tyres, rear fenders, exhaust stack,
    3-point hitch.  Burnt: paint gone to rust / soot, tyres burnt off (sits on the rims), glazing gone,
    cab interior and seat charred."""
    mb = TMB(name); r = rng(seed)
    blue = 'burnt_metal' if burnt else 'mtz_blue'; cabr = 'burnt_metal' if burnt else 'mtz_cab'
    dark = 'burnt_metal' if burnt else 'metal_dark'
    drop = 0.13 if burnt else 0.0
    Rr, Rf = 0.765, 0.485
    zr, zf = -0.95, 1.4                                     # rear / front axle positions
    yr_, yf = Rr - drop * 1.6, Rf - drop
    if burnt:      # tyres burnt off: it sits on the steel rims (was floating 4-6 cm above the ground)
        yr_, yf = 0.52 - 0.01, 0.3 - 0.01
    # chassis / engine block / transmission
    tbox(mb, (-0.38, yf - 0.15, zr), (0.38, yf + 0.38, zf + 0.85), dark, (1, 1))
    tbox(mb, (-0.5, yr_ - 0.35, zr - 0.55), (0.5, yr_ + 0.35, zr + 0.6), dark, (1, 1))
    # hood (tapers to the front), grille face
    y0h, y1h = yf + 0.38, 1.62 - drop
    P = np.array([[-0.42, y0h, 0.05], [0.42, y0h, 0.05], [0.4, y0h, 2.25], [-0.4, y0h, 2.25]])
    for xs in (1, -1):
        q = [(xs * 0.42, y0h, 0.05), (xs * 0.4, y0h, 2.25), (xs * 0.36, y1h - 0.05, 2.25), (xs * 0.38, y1h, 0.05)]
        mb.poly(q if xs < 0 else q[::-1], G.fit(blue, (2.2, 0.8)))
    mb.poly([(-0.38, y1h, 0.05), (-0.36, y1h - 0.05, 2.25), (0.36, y1h - 0.05, 2.25), (0.38, y1h, 0.05)][::-1], G.fit('burnt_ash' if burnt else blue, (0.8, 2.2)))
    mb.poly([(0.42, y0h, 0.05), (-0.42, y0h, 0.05), (-0.38, y1h, 0.05), (0.38, y1h, 0.05)], G.fit(dark, (0.8, 0.8)))   # hood rear (firewall)
    face = RS('mtz_face', 0, 0.5, 1, 1) if not burnt else 'burnt_metal'
    mb.poly([(-0.4, y0h, 2.25), (0.4, y0h, 2.25), (0.36, y1h - 0.05, 2.25), (-0.36, y1h - 0.05, 2.25)], G.uvq(face, ((0.12, 0.05), (0.88, 0.05), (0.85, 0.95), (0.15, 0.95))) if not burnt else G.fit('burnt_metal', (1, 1)))
    # side panels with louvres / badge
    if not burnt:     # louvre / badge panels laid on the slanted, tapering hood sides (5 mm proud)
        def hx(y, z):
            return 0.42 - 0.02 * (z - 0.05) / 2.2 - 0.04 * (y - y0h) / (y1h - y0h) + 0.005
        for xs in (1, -1):
            zz = (0.9, 1.9) if xs > 0 else (1.9, 0.9); ya, yb = y0h + 0.12, y0h + 0.67
            P = [(xs * hx(ya, zz[0]), ya, zz[0]), (xs * hx(ya, zz[1]), ya, zz[1]), (xs * hx(yb, zz[1]), yb, zz[1]), (xs * hx(yb, zz[0]), yb, zz[0])]
            quad(mb, P, RS('mtz_face', 0, 0, 1, 0.5))
    # headlights on the grille sides
    for xs in (1, -1):
        G.lathe(mb, [(0.0, 0.0), (0.09, 0.0), (0.09, 0.08), (0.0, 0.1)], 8, 'chrome' if False else 'paint_white', M=T(xs * 0.28, y0h - 0.05, 2.3) @ mat_trs((0, 0, 0), (PI / 2, 0, 0)))
    # front axle beam + weights
    tbox(mb, (-0.75, yf - 0.1, zf - 0.1), (0.75, yf + 0.08, zf + 0.12), dark, (1, 1))
    tbox(mb, (-0.45, yf - 0.25, zf + 0.85), (0.45, yf + 0.25, zf + 1.05), dark, (1, 1))
    # wheels
    tw = 0.82
    for xs in (1, -1):
        wheel(mb, (xs * 0.82, yr_, zr), Rr, 0.42, 0.52, burnt=burnt, segs=18)
        wheel(mb, (xs * tw, yf, zf), Rf, 0.25, 0.3, burnt=burnt, segs=14)
    cyl(mb, (-0.74, yr_, zr), (0.74, yr_, zr), 0.09, 8, dark, cap=True)        # rear axle housing into both hubs
    cyl(mb, (-0.78, yf, zf), (0.78, yf, zf), 0.05, 6, dark, cap=True)         # front stub axles
    # rear fenders (arched strip + flat top) and platform
    for xs in (1, -1):
        x0, x1 = xs * 0.58, xs * 1.08
        pts = [(math.cos(a) * (Rr + 0.12), math.sin(a) * (Rr + 0.12)) for a in np.linspace(math.radians(10), math.radians(165), 9)]
        for (za, ya), (zb, yb) in zip(pts[:-1], pts[1:]):
            A = (x0, yr_ + ya, zr + za); B = (x1, yr_ + ya, zr + za); C = (x1, yr_ + yb, zr + zb); D = (x0, yr_ + yb, zr + zb)
            q = [A, D, C, B] if xs > 0 else [B, C, D, A]
            mb.poly(q, G.fit(('burnt_ash' if burnt and ya > 0.5 * (Rr + 0.12) else blue), (0.6, 0.6)))
            mb.poly(q[::-1], G.fit(dark, (0.6, 0.6)))
    tbox(mb, (-0.58, yr_ + 0.35, zr - 0.5), (0.58, yr_ + 0.42, zr + 0.75), RS('grille', 0, 0, 1, 1) if not burnt else 'burnt_metal', (1.2, 1.3))
    # cab: 4 posts + roof + glazing (+ door handles); burnt: frame only, roof sagging
    cy0, cy1 = yr_ + 0.42, 2.78 - drop * 1.5
    cz0, cz1 = zr - 0.6, zr + 0.75
    for (x, z) in ((-0.55, cz0), (0.55, cz0), (-0.55, cz1), (0.55, cz1)):
        tbox(mb, (x - 0.035, cy0, z - 0.035), (x + 0.035, cy1 + (0.05 if burnt else 0.0), z + 0.035), cabr, (1, 1), faces='+x-x+z-z+y')
    rf = 0.06 if not burnt else 0.03
    Mroof = None if not burnt else rot_axis((1, 0, 0), 0.06, origin=(0, cy1, cz1))
    tbox(mb, (-0.66, cy1, cz0 - 0.1), (0.66, cy1 + 0.12, cz1 + 0.1), cabr, (1.4, 1.4), M=Mroof, regs={'+y': 'burnt_ash'} if burnt else None)
    if not burnt:
        for P in ([(-0.52, cy0 + 0.35, cz1), (0.52, cy0 + 0.35, cz1), (0.52, cy1, cz1), (-0.52, cy1, cz1)],
                  [(0.52, cy0 + 0.35, cz0), (-0.52, cy0 + 0.35, cz0), (-0.52, cy1, cz0), (0.52, cy1, cz0)],
                  [(0.55, cy0, cz1 - 0.04), (0.55, cy0, cz0 + 0.04), (0.55, cy1, cz0 + 0.04), (0.55, cy1, cz1 - 0.04)],
                  [(-0.55, cy0, cz0 + 0.04), (-0.55, cy0, cz1 - 0.04), (-0.55, cy1, cz1 - 0.04), (-0.55, cy1, cz0 + 0.04)]):
            mb.poly(P, G.fit('glass_dark', (1.2, 1.3), stretch=True))
            mb.poly(P[::-1], G.fit('glass_dark', (1.2, 1.3), stretch=True))
    # seat + steering wheel
    tbox(mb, (-0.22, cy0, cz0 + 0.25), (0.22, cy0 + 0.45, cz0 + 0.6), 'rubber' if not burnt else 'ash', (1, 1))     # seat on its pedestal
    Msw = T(0, cy0 + 0.98, cz1 - 0.13) @ mat_trs((0, 0, 0), (0.9, 0, 0))
    G.tube(mb, [(0, cy0 - 0.01, cz1 - 0.45), (0, cy0 + 0.98, cz1 - 0.13)], 0.025, 4, dark)                          # column floor -> wheel hub
    G.lathe(mb, [(0.2, -0.02), (0.22, 0.0), (0.2, 0.02)], 10, 'rubber' if not burnt else 'burnt_metal', M=Msw)
    for sp in ((0.21, 0, 0), (-0.21, 0, 0), (0, 0, -0.21)):                                                         # spokes
        G.tube(mb, [xform(np.array([(0, 0, 0)]), Msw)[0], xform(np.array([sp]), Msw)[0]], 0.012, 3, dark)
    # exhaust stack + air intake in front of the cab
    cyl(mb, (0.25, y1h - 0.05, 0.55), (0.25, 2.55 - drop, 0.55), 0.05, 6, 'steel_rust' if not burnt else 'burnt_metal', seg=2, cap=True)
    cyl(mb, (-0.25, y1h - 0.05, 0.55), (-0.25, 2.2 - drop, 0.55), 0.07, 6, dark, seg=2, cap=True)
    # 3-point hitch at the rear
    for xs in (1, -1):
        beam(mb, (xs * 0.3, yr_ - 0.2, zr - 0.55), (xs * 0.4, yr_ - 0.45, zr - 1.3), 0.05, 0.08, dark, (1, 1))
    beam(mb, (0, yr_ + 0.05, zr - 0.55), (0, yr_ - 0.15, zr - 1.25), 0.05, 0.08, dark, (1, 1))
    if burnt:
        tint(mb, lambda p: 0.62 + 0.38 * min(1, p[1] / 1.8) * (0.85 + 0.15 * math.sin(p[2] * 3 + p[0] * 5)))
    else:
        tint(mb, lambda p: 0.8 + 0.2 * min(1, p[1] / 1.5))
    return mb


def combine_niva_burnt(name='combine_niva_burnt', seed=70):
    """Burnt-out SK-5 'Niva' combine harvester (body 7.4 x 3.0 x 3.9 m, front = +Z) with its 4.1 m grain header
    still attached: blistered red paint over rust / soot, tyres burnt off, cab glazing gone, grain-tank lid
    sprung, unloading auger folded along the left side, threshing-drum housing split open."""
    mb = TMB(name); r = rng(seed)
    red, burnt, dark = 'burnt_paint', 'burnt_metal', 'burnt_metal'
    zf, zr = 1.7, -2.6
    Rf, Rr = 0.82, 0.5
    yf, yr_ = 0.62 - 0.01, 0.36 - 0.01      # on the bare rims (were 6-8 cm above the ground)
    # main body (thresher): box with sloped front
    prof = [(-1.45, 0.75, -3.4), (1.45, 0.75, -3.4)]
    tbox(mb, (-1.4, 0.75, -3.5), (1.4, 2.7, 1.2), red, (1.2, 1.2), regs={'+y': 'burnt_ash'})
    # front feeder housing sloping down to the header
    q = [(-0.6, 0.9, 1.2), (0.6, 0.9, 1.2), (0.6, 0.5, 3.4), (-0.6, 0.5, 3.4)]
    for xs in (1, -1):
        mb.poly([(xs * 0.6, 0.9, 1.2), (xs * 0.6, 0.5, 3.4), (xs * 0.6, 1.1, 3.4), (xs * 0.6, 1.9, 1.2)][::(1 if xs < 0 else -1)], G.fit(red, (2.3, 1.4)))
    mb.poly([(-0.6, 1.9, 1.2), (-0.6, 1.1, 3.4), (0.6, 1.1, 3.4), (0.6, 1.9, 1.2)][::-1], G.fit('burnt_ash', (1.2, 2.3)))
    # header: 4.1 m wide trough with reel (bats bent) and divider points
    hz0, hz1 = 3.3, 5.0
    tquad(mb, (-2.05, 0.3, hz1), (1, 0, 0), (0, 0, -1), 4.1, hz1 - hz0, burnt, (1.2, 1.2))
    tquad(mb, (2.05, 0.3, hz0), (-1, 0, 0), (0, 1, 0), 4.1, 1.0, red, (1.2, 1.0))
    tquad(mb, (-2.05, 0.3, hz0 + 0.01), (1, 0, 0), (0, 1, 0), 4.1, 1.0, burnt, (1.2, 1.0))
    for xs in (1, -1):
        mb.poly([(xs * 2.05, 0.3, hz0), (xs * 2.05, 0.3, hz1 + 0.3), (xs * 2.05, 0.75, hz1), (xs * 2.05, 1.3, hz0)][::(1 if xs > 0 else -1)], G.fit(red, (2, 1)))
        mb.poly([(xs * 2.05, 0.3, hz0), (xs * 2.05, 0.3, hz1 + 0.3), (xs * 2.05, 0.75, hz1), (xs * 2.05, 1.3, hz0)][::(-1 if xs > 0 else 1)], G.fit(burnt, (2, 1)))
    cyl(mb, (-2.05, 0.49, hz0 + 0.35), (2.05, 0.49, hz0 + 0.35), 0.18, 8, burnt, seg=1.2)        # auger, end plate to end plate, in the trough
    rc = np.array([0, 1.45, hz0 + 0.9])
    cyl(mb, rc + [-1.95, 0, 0], rc + [1.95, 0, 0], 0.05, 6, burnt, seg=1.5, cap=True)       # reel shaft
    for k in range(5):   # reel bats on spider arms
        a = k * 2 * PI / 5
        p = np.array([0, 1.45 + math.sin(a) * 0.55, hz0 + 0.9 + math.cos(a) * 0.55])
        sag = np.array([0, -0.25 if k == 2 else 0.0, 0])
        G.tube(mb, [p + [-1.9, 0, 0], p + [0, 0, 0] + sag, p + [1.9, 0, 0]], 0.03, 3, burnt, seg=1.5)
        for xs in (1, -1):
            G.tube(mb, [rc + [xs * 1.88, 0, 0], p + [xs * 1.88, 0, 0]], 0.02, 3, burnt, seg=1.0)
    for xs in (1, -1):   # reel support arms down to the top of the header back wall
        cyl(mb, (xs * 1.97, 1.45, hz0 + 0.9), (xs * 1.97, 1.28, hz0 + 0.02), 0.04, 4, burnt, seg=2)
    # grain tank on top (open, lid sprung) + cab front-left
    tbox(mb, (-1.3, 2.7, -2.0), (1.0, 3.6, 0.6), red, (1.2, 1.2), faces='+x-x+z-z')
    tquad(mb, (-1.3, 2.75, 0.6), (1, 0, 0), (0, 0, -1), 2.3, 2.6, 'ash', (1.2, 1.2))
    tquad(mb, (-1.3, 3.6, -2.0), (1, 0, 0), (0, 0.6, -0.8), 2.3, 1.2, 'burnt_ash', (1.2, 1.2), double=True)
    cx0, cx1, cz0, cz1, cy0, cy1 = -1.35, -0.1, 0.6, 1.8, 2.3, 3.75
    for (x, z) in ((cx0, cz0), (cx1, cz0), (cx0, cz1), (cx1, cz1)):
        tbox(mb, (x - 0.04, cy0, z - 0.04), (x + 0.04, cy1, z + 0.04), burnt, (1, 1), faces='+x-x+z-z')
    tbox(mb, (cx0 - 0.1, cy1, cz0 - 0.05), (cx1 + 0.1, cy1 + 0.1, cz1 + 0.15), burnt, (1.4, 1.4), M=rot_axis((0, 0, 1), -0.05, origin=(cx0, cy1, 0)), regs={'+y': 'burnt_ash'})
    tquad(mb, (cx0, cy0, cz1), (1, 0, 0), (0, 0, -1), cx1 - cx0, cz1 - cz0, 'ash', (1.2, 1.2))
    tquad(mb, (cx0, 1.9, cz1), (1, 0, 0), (0, 1, 0), cx1 - cx0, 0.4, red, (1.2, 0.4))
    # unloading auger folded along the left side
    G.tube(mb, [(-1.55, 3.0, -2.2), (-1.55, 3.25, 0.2), (-1.55, 3.3, 1.6)], 0.16, 8, burnt, seg=1.2)   # against the body side
    cyl(mb, (-1.55, 3.3, 1.6), (-1.55, 2.9, 1.9), 0.12, 6, burnt)
    # split drum housing on the right (open panel hanging)
    tquad(mb, (1.41, 1.2, 0.2), (0, 0, -1), (0, 1, 0), 1.6, 1.1, 'interior_dark', (1.2, 1.2))
    tquad(mb, (1.41, 1.2, 0.2), (0.6, -0.3, -0.75), (0, 1, 0), 1.6, 1.1, red, (1.2, 1.2), double=True)
    # straw walker hood at the back + engine compartment louvres
    tquad(mb, (-1.3, 2.7, -3.5), (1, 0, 0), (0, -0.5, -0.8), 2.6, 1.0, red, (1.2, 1.2), double=True)
    tquad(mb, (1.405, 2.0, -0.8), (0, 0, -1), (0, 1, 0), 1.4, 0.6, RS('grille', 0, 0, 1, 1), (1.4, 0.6))
    # wheels: big front drive wheels on rims, small rear steer wheels
    for xs in (1, -1):
        wheel(mb, (xs * 1.55, yf, zf - 0.3), Rf, 0.55, 0.62, burnt=True, segs=18)
        wheel(mb, (xs * 1.15, yr_, zr), Rr, 0.3, 0.36, burnt=True, segs=12)
        tbox(mb, (xs * 0.9 - 0.06, yr_, zr - 0.06), (xs * 0.9 + 0.06, 0.78, zr + 0.06), dark, (1, 1))     # steering-axle king posts
    tbox(mb, (-1.1, yr_ - 0.06, zr - 0.06), (1.1, yr_ + 0.06, zr + 0.06), dark, (1, 1))                     # rear steering axle
    tint(mb, lambda p: 0.62 + 0.38 * min(1, p[1] / 2.6) * (0.85 + 0.15 * math.sin(p[2] * 2.1 + p[0] * 3.3)))
    return mb


def trailer(name='trailer_farm', seed=80):
    """2PTS-4 tractor tipping trailer: steel bed 4.5 x 2.3 m with 0.6 m drop sides (faded blue-grey, rusty),
    two axles of 0.9 m wheels, A-frame drawbar to +Z, tail lights, some spilled grain / straw in the bed."""
    mb = TMB(name); r = rng(seed)
    Lb, Wb, yb = 4.5, 2.3, 1.05
    tbox(mb, (-Wb / 2, yb, -Lb / 2), (Wb / 2, yb + 0.08, Lb / 2), 'trailer_blue', (1.2, 1.2), faces='+y-y')
    tquad(mb, (-Wb / 2 + 0.05, yb + 0.09, Lb / 2 - 0.05), (1, 0, 0), (0, 0, -1), Wb - 0.1, Lb - 0.1, 'straw_bedding', (2, 2))
    for (o, du, Lu) in (((-Wb / 2, yb, Lb / 2), (1, 0, 0), Wb), ((Wb / 2, yb, -Lb / 2), (-1, 0, 0), Wb), ((Wb / 2, yb, Lb / 2), (0, 0, -1), Lb), ((-Wb / 2, yb, -Lb / 2), (0, 0, 1), Lb)):
        tquad(mb, o, du, (0, 1, 0), Lu, 0.62, 'trailer_blue', (1.15, 0.62), double=True)
        tquad(mb, np.array(o) + [0, 0.62, 0], du, np.cross(du, (0, 1, 0)) * -1, Lu, 0.05, 'metal_dark', (1, 1))
    # chassis rails, axles, wheels
    for xs in (1, -1):
        tbox(mb, (xs * 0.55 - 0.07, yb - 0.25, -Lb / 2 + 0.1), (xs * 0.55 + 0.07, yb, Lb / 2 - 0.1), 'metal_dark', (1, 1), faces='+x-x-y+z-z')
    for z in (-1.1, 0.9):
        cyl(mb, (-1.0, 0.45, z), (1.0, 0.45, z), 0.05, 6, 'metal_dark')
        for xs in (1, -1):   # leaf-spring hangers: axle up to the chassis rails
            tbox(mb, (xs * 0.55 - 0.05, 0.41, z - 0.07), (xs * 0.55 + 0.05, yb - 0.24, z + 0.07), 'metal_dark', (1, 1))
        for xs in (1, -1):
            wheel(mb, (xs * 0.98, 0.45, z), 0.45, 0.28, 0.25, segs=14, rim='trailer_blue')
    # drawbar
    for xs in (1, -1):
        beam(mb, (xs * 0.5, yb - 0.15, Lb / 2 - 0.2), (0, 0.65, Lb / 2 + 1.5), 0.08, 0.1, 'metal_dark', (1, 1))
    lathe(mb, [(0.0, -0.03), (0.09, -0.03), (0.09, 0.03), (0.0, 0.03)], 8, 'metal_dark', M=T(0, 0.65, Lb / 2 + 1.55))
    cyl(mb, (0.09, 0.0, Lb / 2 + 1.2), (0.09, 0.67, Lb / 2 + 1.2), 0.03, 4, 'metal_dark', cap=True)   # prop stand: ground to drawbar
    for xs in (1, -1):
        tbox(mb, (xs * 0.95 - 0.08, yb - 0.1, -Lb / 2 - 0.02), (xs * 0.95 + 0.08, yb + 0.04, -Lb / 2), 'mtz_red', (1, 1))
    tint(mb, lambda p: 0.75 + 0.25 * min(1, p[1] / 1.4))
    return mb


# ====================================================================== village yard
def well_village(name='well_village', seed=90):
    """Village well (krynytsia): concrete-ring shaft 1.1 m dia / 0.85 m high with a plank lid, two posts carrying
    a windlass drum with a crank and chain + zinc bucket, little gabled plank roof (2.1 m)."""
    mb = TMB(name); r = rng(seed)
    lathe(mb, [(0.55, 0.0), (0.55, 0.85), (0.47, 0.85), (0.47, 0.6)], 14, 'concrete', around=3)
    tbox(mb, (-0.47, 0.84, -0.47), (0.0, 0.88, 0.47), 'wood_grey', (1, 1), faces='+x-x+y+z-z')
    disc(mb, (0.0, 0.62, 0), (0, 1, 0), 0.475, 14, 'interior_dark')      # dark water / shaft, centred, closes the ring
    for xs in (1, -1):
        tbox(mb, (xs * 0.66 - 0.06, 0, -0.06), (xs * 0.66 + 0.06, 2.1, 0.06), 'wood_grey', (1, 1.75), faces='+x-x+z-z+y')
    cyl(mb, (-0.6, 1.25, 0), (0.6, 1.25, 0), 0.1, 8, 'wood_raw', seg=1.2, cap=True)
    G.tube(mb, [(0.6, 1.25, 0), (0.85, 1.25, 0), (0.85, 1.0, 0.05), (1.0, 1.0, 0.05)], 0.018, 4, 'metal_dark', seg=1)
    cyl(mb, (-0.1, 1.15, 0.1), (-0.1, 0.95, 0.1), 0.006, 3, 'metal_dark')
    lathe(mb, [(0.0, 0.0), (0.11, 0.0), (0.14, 0.26), (0.0, 0.26)], 8, 'tin_galv', M=T(-0.1, 0.88, 0.1))
    # roof
    yr, ye = 2.15, 1.7
    for sgn in (1, -1):
        tquad(mb, (-sgn * 0.8, ye, sgn * 0.65), (sgn, 0, 0), (0, yr - ye, -sgn * 0.65), 1.6, math.hypot(yr - ye, 0.65), 'wood_grey', (1, 1), double=True)
    yg = ye + (yr - ye) * 0.05 / 0.65 - 0.004
    for xs in (1, -1):   # gables touch the roof boards (were 3 cm below them)
        P = [(xs * 0.67, yg, 0.6), (xs * 0.67, yg, -0.6), (xs * 0.67, yr - 0.004, 0)]
        mb.poly(P if xs > 0 else P[::-1], G.fit('wood_grey', (1.2, 0.5)))
        mb.poly(P[::-1] if xs > 0 else P, G.fit('wood_grey', (1.2, 0.5)))
    tbox(mb, (-0.8, yr - 0.12, -0.03), (0.8, yr - 0.026, 0.03), 'wood_raw', (1.6, 0.1))     # ridge beam
    tint(mb, ground_ao(0.6, 0.7))
    return mb


def shed_wood(name='shed_wood', seed=100):
    """Yard shed (saraj) 4 x 3 m, 2.3 m walls of weathered vertical boards on a low brick plinth, mono-pitch
    asbestos-slate roof falling to the back, plank door with a padlock hasp, a small window."""
    mb = TMB(name); r = rng(seed)
    W, D, H0, H1 = 4.0, 3.0, 2.15, 2.55
    tbox(mb, (-W / 2, 0, -D / 2), (W / 2, 0.2, D / 2), 'brick_red', (1, 1), faces='+x-x+z-z+y')
    t_, hz = 0.04, lambda z: H0 + (H1 - H0) * (z + D / 2) / D      # wall height at world z
    a_, b_ = -D / 2 + t_, D / 2 - t_
    outlines = {'front': [(-W / 2, 0.2), (W / 2, 0.2), (W / 2, H1), (-W / 2, H1)], 'back': [(-W / 2, 0.2), (W / 2, 0.2), (W / 2, H0), (-W / 2, H0)],
                'right': [(a_, 0.2), (b_, 0.2), (b_, hz(-b_)), (a_, hz(-a_))], 'left': [(a_, 0.2), (b_, 0.2), (b_, hz(b_)), (a_, hz(a_))]}
    Ms = {'front': T(0, 0, D / 2), 'back': RY(PI, (0, 0, -D / 2)), 'right': RY(PI / 2, (W / 2, 0, 0)), 'left': RY(-PI / 2, (-W / 2, 0, 0))}
    for k, M in Ms.items():
        holes = [(0.2, 0.2, 1.2, 2.05)] if k == 'front' else [(-0.4, 1.2, 0.2, 1.7)] if k == 'right' else []
        wall(mb, outlines[k], 0.04, 'wood_grey', (1.0, 2.2), holes=holes, M=M, back='wood_grey', org=(0, 0.2))
    tquad(mb, (0.2, 0.2, D / 2 - 0.02), (1, 0, 0), (0, 1, 0), 1.0, 1.85, 'wood_grey', (1.0, 2.2), M=RY(0.0) @ T(0, 0, 0))
    tquad(mb, (-0.4, 1.2, -0.03), (1, 0, 0), (0, 1, 0), 0.6, 0.5, RS('window_barn', 0.1, 0.1, 0.5, 0.5), (0.6, 0.5), M=Ms['right'])
    # roof: falls from front (H1) to back (H0), overhang 0.3
    ov = 0.3
    th = 0.025      # roof sheet + battens, underside resting on the wall tops (was a paper sheet 3 cm above them)
    a = np.array([-W / 2 - ov, H1 + th + ov * (H1 - H0) / D, D / 2 + ov]); b = np.array([-W / 2 - ov, H0 + th - ov * (H1 - H0) / D, -D / 2 - ov])
    slab_roof(mb, a, b, W + 2 * ov, th, 'slate_old', (1.13, 1.75), 'interior_dark', 'wood_grey')
    tint(mb, ground_ao(0.7, 0.65))
    return mb


def outhouse(name='outhouse', seed=110):
    """Yard privy: 1.1 x 1.25 m plank box, 2.15 m, mono-pitch felt roof, door with the cut-out window."""
    mb = TMB(name); r = rng(seed)
    W, D, H0, H1 = 1.1, 1.25, 2.0, 2.2
    Ms = {'front': T(0, 0, D / 2), 'back': RY(PI, (0, 0, -D / 2)), 'right': RY(PI / 2, (W / 2, 0, 0)), 'left': RY(-PI / 2, (-W / 2, 0, 0))}
    t_, hz = 0.03, lambda z: H0 + (H1 - H0) * (z + D / 2) / D
    a_, b_ = -D / 2 + t_, D / 2 - t_
    outl = {'front': [(-W / 2, 0), (W / 2, 0), (W / 2, H1), (-W / 2, H1)], 'back': [(-W / 2, 0), (W / 2, 0), (W / 2, H0), (-W / 2, H0)],
            'right': [(a_, 0), (b_, 0), (b_, hz(-b_)), (a_, hz(-a_))], 'left': [(a_, 0), (b_, 0), (b_, hz(b_)), (a_, hz(a_))]}
    for k, M in Ms.items():
        holes = [(-0.08, 1.6, 0.08, 1.75)] if k == 'front' else []
        wall(mb, outl[k], 0.03, 'wood_grey' if k != 'front' else 'wood_green', (1.0, 2.2), holes=holes, M=M, back='wood_grey')
    tquad(mb, (-0.38, 1.0, D / 2 + 0.005), (1, 0, 0), (0, 0, 0) + np.array([0, 1, 0]), 0.03, 0.12, 'metal_dark', (1, 1))
    th = 0.025; sl = (H1 - H0) / D      # roof boards resting on the walls (the old sheet floated 2-4 cm above them)
    a = np.array([-W / 2 - 0.12, H1 + th + 0.15 * sl, D / 2 + 0.15]); b = np.array([-W / 2 - 0.12, H0 + th - 0.15 * sl, -D / 2 - 0.15])
    slab_roof(mb, a, b, W + 0.24, th, 'felt_roof', (1, 1), 'wood_grey')
    tint(mb, ground_ao(0.5, 0.7))
    return mb


def woodpile(name='woodpile', seed=120):
    """Stacked split firewood 2.5 x 0.9 x 1.1 m between end stakes, an old slate sheet on top, a few loose
    logs and a chopping block with an axe-scarred top."""
    mb = TMB(name); r = rng(seed)
    L, Dd, H = 2.5, 0.9, 1.1
    def top(x):
        return H - 0.12 * abs(x / (L / 2)) ** 2 + 0.04 * math.sin(x * 5)
    xs = np.linspace(-L / 2, L / 2, 7)
    for sgn in (1, -1):   # end-grain faces front/back
        for x0, x1 in zip(xs[:-1], xs[1:]):
            P = [(x0, 0, sgn * Dd / 2), (x1, 0, sgn * Dd / 2), (x1, top(x1), sgn * Dd / 2), (x0, top(x0), sgn * Dd / 2)]
            if sgn < 0:
                P = P[::-1]
            mb.poly(P, lambda P_, n_: [G.R['logs_end'].uv(((p[0] + L / 2) / 1.0) % 1.0 if False else (p[0] - x0) / (x1 - x0) * 0.4 + 0.3 * (sgn > 0), p[1] / 1.1) for p in P_])
    for x0, x1 in zip(xs[:-1], xs[1:]):   # top
        P = [(x0, top(x0), Dd / 2), (x1, top(x1), Dd / 2), (x1, top(x1), -Dd / 2), (x0, top(x0), -Dd / 2)]
        mb.poly(P, G.fit('bark_oak', (0.5, 0.9), stretch=True))
    for sgn in (1, -1):
        tbox(mb, (sgn * (L / 2 + 0.04) - 0.04, 0, -Dd / 2 - 0.05), (sgn * (L / 2 + 0.04) + 0.04, 1.3, -Dd / 2 + 0.03), 'wood_grey', (1, 1.3), faces='+x-x+z-z')
        tbox(mb, (sgn * (L / 2 + 0.04) - 0.04, 0, Dd / 2 - 0.03), (sgn * (L / 2 + 0.04) + 0.04, 1.3, Dd / 2 + 0.05), 'wood_grey', (1, 1.3), faces='+x-x+z-z')
        P = [(sgn * L / 2, 0, Dd / 2), (sgn * L / 2, 0, -Dd / 2), (sgn * L / 2, top(sgn * L / 2), -Dd / 2), (sgn * L / 2, top(sgn * L / 2), Dd / 2)]
        mb.poly(P if sgn > 0 else P[::-1], G.fit('bark_acacia', (0.9, 1.1), stretch=True))
    M = mat_trs((0.1, H + 0.15, 0), (0.0, 0.1, 0.06))
    part = TMB('slate')
    tbox(part, (-0.65, -0.012, -0.55), (0.65, 0.0, 0.55), 'slate_old', (1.13, 1.75), M=M)
    from meshfix import drop
    drop(mb, part, sink=0.01)        # the slate sheet lies on the stack (was hovering above the lower end logs)
    for k in range(4):
        p0 = np.array([r.uniform(-1.2, 1.2), 0.08, r.uniform(0.6, 1.3)]); d = np.array([math.cos(r.uniform(0, PI)), 0, math.sin(r.uniform(0, PI))])
        cyl(mb, p0, p0 + d * r.uniform(0.35, 0.5), 0.07, 5, 'bark_oak', cap=True)
    lathe(mb, [(0.25, 0.0), (0.24, 0.45), (0.0, 0.46)], 8, 'bark_oak', M=T(1.7, 0, 0.8))
    tint(mb, ground_ao(0.4, 0.6))
    return mb


def greenhouse_frame(name='greenhouse_frame', seed=130):
    """Garden tunnel greenhouse 3 x 6 m (along Z), arched galvanised pipe hoops every 1 m, ridge + side
    rails, torn polyethylene film on part of it (foliage material, alpha), a few shreds flapping."""
    mb = TMB(name); r = rng(seed)
    W, Lg, Hh = 3.0, 6.0, 2.0
    def arch(z, n=9):
        return [np.array([math.cos(a) * W / 2, math.sin(a) * Hh, z]) for a in np.linspace(0, PI, n)]
    zs = np.linspace(-Lg / 2, Lg / 2, 7)
    for z in zs:
        G.tube(mb, arch(z), 0.022, 4, 'tin_galv', seg=1.5)
    for a in (0.0, PI / 2, PI, PI * 0.25, PI * 0.75):
        p = np.array([math.cos(a) * W / 2, math.sin(a) * Hh, 0])
        cyl(mb, p + [0, 0, -Lg / 2], p + [0, 0, Lg / 2], 0.018, 4, 'tin_galv', seg=1.5)
    # film panels on 3 of the 6 bays (+ torn hanging pieces): two-sided alpha strips
    film = FR('film')
    for i in (0, 1, 3):
        z0, z1 = zs[i], zs[i + 1]
        A0, A1 = arch(z0, 7), arch(z1, 7)
        for j in range(6):
            if i == 3 and j in (2, 3):
                continue
            P = [A0[j] * [1.01, 1.01, 1], A1[j] * [1.01, 1.01, 1], A1[j + 1] * [1.01, 1.01, 1], A0[j + 1] * [1.01, 1.01, 1]]
            uv = [film.uv(j / 6, (i % 2) * 0.5), film.uv(j / 6, (i % 2) * 0.5 + 0.5), film.uv((j + 1) / 6, (i % 2) * 0.5 + 0.5), film.uv((j + 1) / 6, (i % 2) * 0.5)]
            for PP, uu in ((P, uv), (P[::-1], uv[::-1])):
                mb.face(mb.vs(PP), uu, False, LEAF)
    for k in range(3):   # loose shreds hanging from the ridge
        z = r.uniform(0, 2.5); x = r.uniform(-0.6, 0.6) * 0      # torn strips hang from the ridge rail
        p = np.array([x, math.sqrt(max(0.0, 1 - (x / (W / 2)) ** 2)) * Hh, z])
        P = [p + [-0.25, 0, 0], p + [0.25, 0, 0], p + [0.3, -1.2, 0.2], p + [-0.2, -1.4, 0.15]]
        uv = [film.uv(0.1, 0.9), film.uv(0.3, 0.9), film.uv(0.3, 0.2), film.uv(0.1, 0.2)]
        mb.face(mb.vs(P), uv, False, LEAF); mb.face(mb.vs(P[::-1]), uv[::-1], False, LEAF)
    # raised beds inside
    tbox(mb, (-1.2, 0, -2.8), (-0.3, 0.2, 2.8), 'soil', (1, 1), faces='+x-x+y+z-z')
    tbox(mb, (0.3, 0, -2.8), (1.2, 0.2, 2.8), 'soil', (1, 1), faces='+x-x+y+z-z')
    return mb


def fence_wattle(name='fence_wattle', seed=140):
    """Woven wattle fence (pleten) segment 3 m along X, 0.95 m: alpha-textured weave (both sides) between real
    stakes, a clay pot on one stake."""
    mb = TMB(name); r = rng(seed)
    reg = FR('wattle')
    for z, flip in ((0.0, False), (0.0, True)):
        P = [(-1.5, 0, z), (1.5, 0, z), (1.5, 1.0, z), (-1.5, 1.0, z)]
        uv = [reg.uv(0, 0), reg.uv(1, 0), reg.uv(1, 1), reg.uv(0, 1)]
        if flip:
            P = P[::-1]; uv = uv[::-1]
        mb.face(mb.vs(P), uv, False, LEAF)
    for x in (-1.5, 0.0, 1.5):
        cyl(mb, (x, -0.05, 0.0), (x + r.normal(0, 0.02), 1.15, r.normal(0, 0.02)), 0.04, 5, 'bark_acacia', seg=1.2, cap=True)
    lathe(mb, [(0.0, 0.0), (0.06, 0.0), (0.1, 0.12), (0.08, 0.2), (0.05, 0.2)], 8, 'brick_red', M=T(0.0, 1.15, 0) @ mat_trs((0, 0, 0), (PI, 0, 0)) @ T(0, -0.2, 0))
    return mb


def fence_wood_village(name='fence_wood_village', seed=150):
    """Village picket fence (shtakhetnyk) segment 3 m along X: two posts, two rails, 15 pointed pickets
    (faded green paint over grey wood, one missing, one hanging askew)."""
    mb = TMB(name); r = rng(seed)
    for x in (-1.5, 1.5):
        tbox(mb, (x - 0.05, 0, -0.1), (x + 0.05, 1.3, 0.0), 'wood_grey', (1, 1.3), faces='+x-x+y+z-z')
    for y in (0.3, 1.0):
        tbox(mb, (-1.5, y, -0.07), (1.5, y + 0.08, -0.0205), 'wood_grey', (1.5, 0.5), faces='+y-y+z-z')
    n = 15
    for k in range(n):
        if k == 9:
            continue
        x = -1.5 + (k + 0.5) * 3.0 / n
        h = 1.2 + r.normal(0, 0.02)
        M = T(x, 0.05, 0) if k != 4 else T(x, 0.05, 0) @ mat_trs((0, 0.2, 0), (0, 0, 0.18))
        P = np.array([(-0.04, 0, 0.0), (0.04, 0, 0.0), (0.04, h - 0.06, 0.0), (0.0, h, 0.0), (-0.04, h - 0.06, 0.0)])
        reg = 'wood_green' if r.random() < 0.75 else 'wood_grey'
        f = Fit(G.R[reg], (0.4, 1.3), seed + k)
        mb.poly(xform(P, M), f)
        mb.poly(xform(P[::-1] + [0, 0, -0.02], M), f)
        for i in range(len(P)):     # picket edges (2 cm board)
            a, b = P[i], P[(i + 1) % len(P)]
            mb.poly(xform(np.array([b, a, a + [0, 0, -0.02], b + [0, 0, -0.02]]), M), Fit(G.R['wood_grey'], (0.1, 1.3), seed + k))
    tint(mb, ground_ao(0.4, 0.7))
    return mb


def gate_village(name='gate_village', seed=160):
    """Village yard gate 3 m along X: two steel posts with caps, two green sheet-steel leaves with embossed
    sunburst (one leaf slightly ajar), bolt bar."""
    mb = TMB(name); r = rng(seed)
    for x in (-1.5, 1.5):
        tbox(mb, (x - 0.06, 0, -0.06), (x + 0.06, 1.95, 0.06), 'metal_rust_paint', (1, 2), faces='+x-x+z-z')
        tbox(mb, (x - 0.09, 1.95, -0.09), (x + 0.09, 2.0, 0.09), 'metal_dark', (1, 1))
    H = 1.75
    for k, (x0, ry) in enumerate(((-1.44, 0.0), (1.44, -0.35))):
        sgn = 1 if k == 0 else -1
        M = T(x0, 0.12, 0) @ RY(ry if k else 0.0)
        reg = RS('gate_green', 0, 0, 0.5, 1) if k == 0 else RS('gate_green', 0.5, 0, 1, 1)
        P = np.array([(0, 0, 0), (sgn * 1.42, 0, 0), (sgn * 1.42, H, 0), (0, H, 0)])
        if sgn < 0:
            P = P[[1, 0, 3, 2]]
        uvs = ((0, 0), (1, 0), (1, 1), (0, 1))
        quad(mb, xform(P, M), reg, uvs)
        quad(mb, xform(P[::-1] + [0, 0, -0.02], M), reg, uvs[::-1])
        for i in range(4):      # leaf edges (2 cm sheet + frame)
            a, b = P[i], P[(i + 1) % 4]
            quad(mb, xform(np.array([b, a, a + [0, 0, -0.02], b + [0, 0, -0.02]]), M), 'metal_dark')
    tint(mb, ground_ao(0.5, 0.75))
    return mb


def bus_stop_village(name='bus_stop_village', seed=170):
    """Soviet rural bus shelter: precast concrete back wall (3.6 x 2.6 m) with a smalt mosaic of a rising sun
    over wheat, two side walls, cantilevered flat roof slab, a bench, painted lower band, chips / pocks."""
    mb = TMB(name); r = rng(seed)
    W, H, D = 3.6, 2.6, 1.6
    tbox(mb, (-W / 2, 0, -D / 2 - 0.15), (W / 2, H, -D / 2), 'conc_painted', (W, H), faces='+x-x-z+y+z', regs={'-z': 'concrete'})   # +z: no holes beside the mosaic
    tquad(mb, (-W / 2 + 0.2, 0.9, -D / 2 + 0.008), (1, 0, 0), (0, 1, 0), W - 0.4, H - 1.1, RS('mosaic', 0, 0, 1, 1), (W - 0.4, H - 1.1))
    tquad(mb, (-W / 2, 0, -D / 2 + 0.008), (1, 0, 0), (0, 1, 0), W, 0.9, RS('conc_painted', 0, 0, 1, 0.3), (W, 0.9))
    tquad(mb, (-W / 2, 2.4, -D / 2 + 0.008), (1, 0, 0), (0, 1, 0), W, 0.2, 'conc_painted', (W, 0.2))
    for sx in (1, -1):
        tbox(mb, (sx * W / 2 - 0.08, 0, -D / 2), (sx * W / 2 + 0.08, H, D / 2 - 0.4), 'conc_painted', (1.2, H))
    tbox(mb, (-W / 2 - 0.25, H, -D / 2 - 0.25), (W / 2 + 0.25, H + 0.16, D / 2 + 0.3), 'concrete', (2, 2))
    tbox(mb, (-W / 2 + 0.2, 0.42, -D / 2), (W / 2 - 0.2, 0.47, -D / 2 + 0.4), 'wood_green', (1.2, 0.4))
    for x in (-1.2, 0, 1.2):
        tbox(mb, (x - 0.04, 0, -D / 2 + 0.05), (x + 0.04, 0.42, -D / 2 + 0.35), 'metal_dark', (1, 1), faces='+x-x+z-z')
    tquad(mb, (-W / 2 - 0.3, 0.01, D / 2 + 0.3), (1, 0, 0), (0, 0, -1), W + 0.6, D + 0.5, 'concrete', (2, 2))
    tint(mb, lambda p: (0.8 + 0.2 * min(1, p[1] / 1.0)) * (0.82 if (p[1] < H and abs(p[2]) < D / 2 and abs(p[0]) < W / 2 - 0.1 and p[1] > 0.02) else 1.0))
    return mb


def cross_roadside(name='cross_roadside', seed=180):
    """Roadside wooden cross (prydorozhnyi khrest), 2.7 m: dark oak post and arms, small gabled tin roof over the
    crossing, an embroidered rushnyk draped over the arms, a low picket surround."""
    mb = TMB(name); r = rng(seed)
    tbox(mb, (-0.07, 0, -0.07), (0.07, 2.7, 0.07), 'cross_wood', (0.4, 1.4))
    tbox(mb, (-0.6, 1.85, -0.06), (0.6, 1.97, 0.06), 'cross_wood', (0.6, 0.4))
    tbox(mb, (-0.3, 0.6, -0.05), (0.3, 0.68, 0.05), 'cross_wood', (0.6, 0.4), M=rot_axis((0, 0, 1), -0.35, origin=(0, 0.64, 0)))
    for sgn in (1, -1):
        tquad(mb, (-0.75 if sgn > 0 else 0.75, 2.05, sgn * 0.3), (sgn, 0, 0), (0, 0.25, -sgn * 0.3), 1.5, 0.39, 'tin_galv', (1, 1), double=True)
    # rushnyk: towel hanging from each arm end + across
    rs = RS('rushnyk', 0, 0, 1, 1)
    for sx in (1, -1):
        P = [(sx * 0.42, 1.98, 0.064), (sx * 0.58, 1.98, 0.064), (sx * 0.6, 1.2, 0.08), (sx * 0.4, 1.2, 0.08)]     # draped on the arm face
        uv = [rs.uv(0.2, 1), rs.uv(0.5, 1), rs.uv(0.5, 0), rs.uv(0.2, 0)]
        if sx < 0:
            P = [P[1], P[0], P[3], P[2]]; uv = [uv[1], uv[0], uv[3], uv[2]]
        mb.poly(P, lambda P_, n_, uv=uv: uv); mb.poly(P[::-1], lambda P_, n_, uv=uv: uv[::-1])
    for k in range(8):
        a = k * 2 * PI / 8
        cyl(mb, (math.cos(a) * 0.65, 0, math.sin(a) * 0.65), (math.cos(a) * 0.65, 0.5, math.sin(a) * 0.65), 0.025, 4, 'paint_white')
    G.tube(mb, [(math.cos(a) * 0.65, 0.42, math.sin(a) * 0.65) for a in np.linspace(0, 2 * PI, 9)], 0.02, 3, 'paint_white', seg=1)
    return mb


# ====================================================================== earthworks
def earth_surface(mb, f, x0, x1, z0, z1, nx, nz, reg, tile=2.0):
    """Height-field surface y = f(x, z) over a rect, projected UVs (region repeats every `tile` m)."""
    rg = G.R[reg]
    X = np.linspace(x0, x1, nx + 1); Z = np.linspace(z0, z1, nz + 1)
    for i in range(nx):
        for j in range(nz):
            P = [(X[i], f(X[i], Z[j + 1]), Z[j + 1]), (X[i + 1], f(X[i + 1], Z[j + 1]), Z[j + 1]), (X[i + 1], f(X[i + 1], Z[j]), Z[j]), (X[i], f(X[i], Z[j]), Z[j])]
            ox, oz = math.floor(X[i] / tile) * tile, math.floor(Z[j] / tile) * tile
            uv = [rg.uv((p[0] - ox) / tile, (p[2] - oz) / tile) for p in P]
            mb.face(mb.vs(P), uv, True)


def berm_earth(name='berm_earth', seed=190):
    """Bulldozed earth berm ~8 x 2.2 x 1.0 m along X (vehicle revetment / road block), raw chernozem with
    clods, a sod crust and dry weeds on the older end, tread marks on the flank."""
    mb = TMB(name); r = rng(seed)
    ph = r.uniform(0, 6, 4)
    def f(x, z):
        u = x / 4.2; w = z / 1.15
        base = max(0.0, 1 - u ** 6) * max(0.0, 1 - w * w) ** 0.8
        n = 0.08 * math.sin(x * 2.3 + ph[0]) * math.sin(z * 3.1 + ph[1]) + 0.05 * math.sin(x * 5.1 + ph[2])
        return max(0.0, base * (1.0 + n) - 0.01) + 0.005
    earth_surface(mb, f, -4.6, 4.6, -1.3, 1.3, 20, 7, 'soil', 2.0)
    for k in range(10):
        x = r.uniform(-3.8, 3.8); z = r.uniform(-0.9, 0.9)
        s = r.uniform(0.15, 0.35)
        part = TMB('clod')
        chunk(part, (x, f(x, z) + s * 0.15, z), (s * 1.3, s * 0.6, s), 990 + k, 'soil')
        from meshfix import drop
        drop(mb, part, sink=0.04)
    tint(mb, lambda p: 0.8 + 0.25 * min(1, p[1] / 0.9))
    return mb


def trench_segment(name='trench_segment', seed=200):
    """Fighting trench segment 6 m along X for a flat game ground: dark trench floor (just above y=0) with
    duckboards, 0.9 m wide, wattle/board revetted walls rising into spoil parapets either side (front = +Z
    parapet higher, with a sandbag lip and firing step notches), parados behind.  Ends open so segments chain."""
    mb = TMB(name); r = rng(seed)
    hw = 0.48
    ph = r.uniform(0, 6, 6)
    # floor
    tquad(mb, (-3.0, 0.03, hw), (1, 0, 0), (0, 0, -1), 6.0, 2 * hw, RS('trench_floor', 0, 0, 1, 1), (2.0, 2 * hw))
    # revetment walls (planks / wattle) up to the parapet crest
    for sgn in (1, -1):
        Htop = 0.62 if sgn > 0 else 0.45
        o = np.array([3.0 if sgn > 0 else -3.0, 0.03, sgn * hw]); du = np.array([-1.0 if sgn > 0 else 1.0, 0, 0])
        tquad(mb, o, du, (0, 1, 0), 6.0, Htop - 0.03, 'wood_grey', (1.5, 0.8))
        for x in np.arange(-3.0, 3.01, 1.5):   # revetment stakes
            cyl(mb, (x, 0.03, sgn * (hw + 0.02)), (x, Htop + 0.08, sgn * (hw + 0.02)), 0.04, 4, 'bark_acacia', cap=True)
    # parapets: spoil mounds
    def parapet(sgn, H, Wd):
        def f(x, z):
            t = (abs(z) - hw) / Wd
            if t < 0:
                return H
            prof = H * (0.88 + 0.12 * t / 0.25) if t < 0.25 else H * max(0.0, 1 - ((t - 0.25) / 0.75) ** 2) ** 0.8
            return max(0.006, prof * (1 + 0.1 * math.sin(x * 1.7 + ph[0] + sgn) + 0.06 * math.sin(x * 4.3 + ph[1])))
        z0, z1 = (hw, hw + Wd) if sgn > 0 else (-hw - Wd, -hw)
        earth_surface(mb, f, -3.0, 3.0, z0, z1, 12, 5, 'soil' if sgn > 0 else 'sod', 2.0)
    parapet(1, 0.62, 1.7); parapet(-1, 0.45, 1.3)
    # sandbag lip on the front parapet: rows of bag boxes
    for k in range(9):
        x = -2.8 + k * 0.7 + r.normal(0, 0.04)
        if k == 4:
            continue   # firing notch
        M = mat_trs((x, 0.62, hw + 0.28), (0, r.normal(0, 0.08), 0))
        tbox(mb, (-0.32, 0, -0.2), (0.32, 0.16, 0.2), RS('sandbag', 0, 0, 0.5, 0.17), (0.64, 0.16), M=M)
        if k % 2 == 0:
            tbox(mb, (-0.32, 0.16, -0.18), (0.32, 0.3, 0.18), RS('sandbag', 0.5, 0.17, 1, 0.34), (0.64, 0.14), M=M @ T(0.18, 0, 0))
    def f(p):
        if abs(abs(p[2]) - 0.48) < 0.07 and p[1] < 0.7:
            return 0.16 + 0.12 * min(1, p[1] / 0.6)  # revetment boards: damp, in the trench's shadow (VC is linear)
        if p[1] < 0.06:
            return 0.5
        return 0.7 + 0.3 * min(1, p[1] / 0.6)
    tint(mb, f)
    return mb


def dugout_entrance(name='dugout_entrance', seed=210):
    """Dugout / bunker entrance (blindazh): earth-covered log roof mound ~2.6 x 3 m, a dark doorway framed by
    logs with sandbag cheeks, steps leading down (dark), a camouflage of sod on top, roof facing +Z."""
    mb = TMB(name); r = rng(seed)
    def f(x, z):
        u = x / 1.6; w = (z + 0.2) / 1.6
        return max(0.006, 0.95 * max(0.0, 1 - u ** 4) * max(0.0, 1 - w ** 4))
    earth_surface(mb, f, -1.7, 1.7, -1.8, 1.4, 10, 9, 'sod', 2.0)
    # doorway frame (front, +Z face at z = 1.0): 2 posts + lintel log, dark opening
    zf = 1.0
    tquad(mb, (-0.45, 0.02, zf - 0.05), (1, 0, 0), (0, 1, 0), 0.9, 0.85, 'interior_dark', (1, 1))
    for x in (-0.52, 0.52):
        cyl(mb, (x, 0, zf), (x, 0.92, zf), 0.08, 6, 'bark_acacia', cap=True)
    cyl(mb, (-0.75, 0.92, zf + 0.02), (0.75, 0.92, zf + 0.02), 0.09, 6, 'bark_acacia', cap=True)
    for k in range(4):   # roof log ends sticking out, bedded in the mound (outer ones were hovering 18 cm above it)
        x = -1.2 + k * 0.8; y0 = min(0.82, f(x, zf - 0.6) - 0.03)
        cyl(mb, (x, y0, zf - 0.6), (x, y0 + 0.06, zf + 0.15), 0.08, 5, 'bark_acacia', cap=True)
    # steps down (dark trench floor wedge in front)
    tquad(mb, (-0.45, 0.025, zf + 1.4), (1, 0, 0), (0, 0, -1), 0.9, 1.4, RS('trench_floor', 0, 0, 1, 1), (0.9, 1.4))
    for sgn in (1, -1):
        for k in range(4):
            M = mat_trs((sgn * 0.72, 0.0 + (k % 2) * 0.16 + (k // 2) * 0.32, zf + 0.25 + (k // 2) * 0.0), (0, PI / 2, 0))
            tbox(mb, (-0.3, 0, -0.18), (0.3, 0.16, 0.18), RS('sandbag', 0, 0, 0.5, 0.17), (0.6, 0.16), M=M @ T(-0.35 * (k % 2), 0, 0))
    tint(mb, lambda p: 0.7 + 0.3 * min(1, p[1] / 0.8))
    return mb


# ====================================================================== list / manifest text
def all_items():
    return [haybale('haybale_round'), haybale('haybale_round_burnt', burnt=True, seed=3), haystack(),
            barn('barn_kolkhoz'), barn('barn_kolkhoz_damaged', damaged=True), machine_shed(), grain_silo(),
            water_tower('water_tower'), water_tower('water_tower_damaged', damaged=True),
            mtz80('tractor_mtz80'), mtz80('tractor_mtz80_burnt', burnt=True), combine_niva_burnt(), trailer(),
            well_village(), shed_wood(), outhouse(), woodpile(), greenhouse_frame(), fence_wattle(), fence_wood_village(),
            gate_village(), bus_stop_village(), cross_roadside(),
            berm_earth(), trench_segment(), dugout_entrance()]


NOTES = ('Two materials: farmland_atlas (2048^2 opaque, tools/blender/env/farmland_atlas.py, shares city_atlas regions/seeds for '
         'brick/slate/tin/wood/concrete) and farmland_foliage (2048^2 RGBA, alphaMode MASK 0.5, double sided, farmland_foliage.py: leaf '
         'clusters, twig sprays, far-LOD crown clumps, crop parts, wattle weave, greenhouse film). Every node is a top-level mesh, origin on '
         'the ground at the footprint centre, +Y up, metres, front = +Z; nodes are laid out on a grid in the file (farmland.js instancing '
         'ignores the layout transform). Foliage vertices carry bent normals (custom split normals, outward from the crown ellipsoid) and '
         'COLOR_0 (baked crown self-shadow); buildings / wrecks carry COLOR_0 for ground AO, soot and scorch, so materials load with '
         'vertexColors. Trees/bushes: each <name>_lod1 has the same origin and silhouette (trunk prism + crown clump cards on the dense '
         'far_* cells), 50-230 tris, meant for > ~190 m. Crops (sunflower_dead_clump, corn_dry_clump, weeds_tall_clump) are foliage-only '
         'alpha cards for heavy instancing. Linear pieces lie along +X centred on the origin: fence_wattle / fence_wood_village / '
         'gate_village 3.0 m, trench_segment 6.0 m (ends open so segments chain), berm_earth ~9 m. barn_kolkhoz(_damaged) 60.9 x 12.9 m, '
         'machine_shed 31 x 16 m (long axes X). trench_segment: dark floor at y=0.03 between revetted walls, parapets up to 0.62 m (+Z) / '
         '0.45 m (-Z), sandbag lip on the +Z parapet. Vehicles face +Z.')
REFS = ('Photo record of Kharkiv / Kherson / Zaporizhzhia oblast farmland 2022-24: black locust (Robinia) + Lombardy poplar + oak '
        'shelterbelts (lesopolosa) with elder / dog-rose understory, shell-stripped half-dead acacias; kolkhoz cowsheds of white silicate '
        'brick with asbestos-slate roofs and plank end gates (many with caved-in roofs after shelling), open steel machinery sheds, '
        'corrugated grain bins with bucket elevators, Rozhnovsky water towers, MTZ-80/82 Belarus tractors, burnt SK-5 Niva combines in '
        'fields, 2PTS-4 trailers, round bales and traditional stogs, village yards with wattle (pleten) and picket fences, sheet-steel '
        'sunburst gates, concrete-ring wells with windlass roofs, Soviet mosaic bus shelters, roadside crosses with rushnyky, trench lines '
        'and dugouts with wattle / plank revetments and sandbag lips.')
