"""Geometry helpers for city.glb (city_atlas regions): tiled quads/boxes, walls with holes (shapely), tubes with
segment-wise UVs, lathes. glTF space (Y up, +Z front). Everything is material 0 (city_atlas)."""
import math
import numpy as np
from shapely.geometry import box as sbox, Polygon, Point
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from meshlib import MB, Region, Fit, newell, xform, mat_trs, rot_axis, tessellate, rng, noise1d, blob
import city_atlas as CA

R = {k: Region(*v) for k, v in CA.REG.items()}


def reg_of(r):
    return R[r] if isinstance(r, str) else r


def RS(name, s0, t0, s1, t1):
    return R[name].sub(s0, t0, s1, t1)


def fit(name, size=(1.0, 1.0), seed=0, stretch=False):
    return Fit(reg_of(name), size, seed, stretch)


def uvq(reg, uvs=((0, 0), (1, 0), (1, 1), (0, 1))):
    """uv function returning fixed (s,t) corners mapped into region."""
    rg = reg_of(reg)
    out = [rg.uv(*a) for a in uvs]
    ff = Fit(rg, (1, 1), 0, stretch=True)
    return lambda P, n: out[:len(P)] if len(P) <= len(out) else ff(np.asarray(P, float), n)


def quad(mb, P, reg, uvs=((0, 0), (1, 0), (1, 1), (0, 1)), double=False, M=None):
    P = np.asarray(P, float)
    if M is not None:
        P = xform(P, M)
    mb.poly(P, uvq(reg, uvs))
    if double:
        mb.poly(P[::-1], uvq(reg, list(uvs)[::-1]))


def tquad(mb, o, du, dv, Lu, Lv, reg, tile=(1.0, 1.0), M=None, double=False, off=(0.0, 0.0)):
    """Planar rect o + du*a + dv*b (a in 0..Lu, b in 0..Lv) split so `reg` repeats every tile metres.
    Normal = du x dv."""
    rg = reg_of(reg)
    o = np.asarray(o, float); du = np.asarray(du, float); dv = np.asarray(dv, float)
    du = du / np.linalg.norm(du); dv = dv / np.linalg.norm(dv)
    nu, nv = max(1, int(math.ceil(Lu / tile[0] - 1e-6))), max(1, int(math.ceil(Lv / tile[1] - 1e-6)))
    for i in range(nu):
        for j in range(nv):
            a0, a1 = i * tile[0], min(Lu, (i + 1) * tile[0]); b0, b1 = j * tile[1], min(Lv, (j + 1) * tile[1])
            P = np.array([o + du * a0 + dv * b0, o + du * a1 + dv * b0, o + du * a1 + dv * b1, o + du * a0 + dv * b1])
            s1, t1 = (a1 - a0) / tile[0], (b1 - b0) / tile[1]
            so, to = off
            uvs = [(so, to), (so + s1, to), (so + s1, to + t1), (so, to + t1)]
            quad(mb, P, rg, uvs, double, M)


def tbox(mb, mn, mx, reg, tile=(1.0, 1.0), faces='all', M=None, regs=None):
    """Box with tiled faces. regs: optional {face: region} overrides."""
    x0, y0, z0 = mn; x1, y1, z1 = mx
    F = {'+x': ((x1, y0, z1), (0, 0, -1), (0, 1, 0), z1 - z0, y1 - y0), '-x': ((x0, y0, z0), (0, 0, 1), (0, 1, 0), z1 - z0, y1 - y0),
         '+y': ((x0, y1, z1), (1, 0, 0), (0, 0, -1), x1 - x0, z1 - z0), '-y': ((x0, y0, z0), (1, 0, 0), (0, 0, 1), x1 - x0, z1 - z0),
         '+z': ((x0, y0, z1), (1, 0, 0), (0, 1, 0), x1 - x0, y1 - y0), '-z': ((x1, y0, z0), (-1, 0, 0), (0, 1, 0), x1 - x0, y1 - y0)}
    for k, (o, du, dv, Lu, Lv) in F.items():
        if faces != 'all' and k not in faces:
            continue
        if Lu < 1e-6 or Lv < 1e-6:
            continue
        rg = (regs or {}).get(k, reg)
        tquad(mb, o, du, dv, Lu, Lv, rg, tile, M)


def fbox(mb, mn, mx, reg, faces='all', M=None):
    """Box with every face mapped to the whole region (stretched)."""
    x0, y0, z0 = mn; x1, y1, z1 = mx
    F = {'+x': [(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)], '-x': [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)],
         '+y': [(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)], '-y': [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)],
         '+z': [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], '-z': [(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)]}
    for k, P in F.items():
        if faces != 'all' and k not in faces:
            continue
        quad(mb, P, reg, M=M)


def _polys(g):
    if g.is_empty:
        return []
    if g.geom_type == 'Polygon':
        return [g]
    if hasattr(g, 'geoms'):
        return [p for x in g.geoms for p in _polys(x)]
    return []


def _shape(s):
    if isinstance(s, (tuple, list)) and len(s) == 4 and np.isscalar(s[0]):
        return sbox(*s)
    return Polygon(np.asarray(s, float)).buffer(0)


def wall(mb, outline, th, reg, tile=(1.0, 1.0), holes=(), M=None, back=None, side=None, cap='auto', org=(0.0, 0.0),
         side_tile=None, back_tile=None):
    """Wall slab in local XY: front face z=0 (+Z), back z=-th. outline: (x0,y0,x1,y1) or Nx2 polygon; holes likewise.
    Front/back are tiled (tile anchored at org); sides of holes always built (reveals), outline edges unless cap='none'
    ('auto' skips the bottom edge). back=None -> same region; back=False -> no back face."""
    ol = _shape(outline)
    hs = [_shape(h) for h in holes]
    solid = ol.difference(unary_union(hs)) if hs else ol
    if solid.is_empty:
        return
    tmp = MB()
    side = reg if side is None else side
    side_tile = side_tile or tile
    minx, miny, maxx, maxy = solid.bounds
    for rg, z, sgn, tl in ((reg, 0.0, 1, tile), (reg if back is None else back, -th, -1, back_tile or tile)):
        if rg is False or rg is None:
            continue
        rg = reg_of(rg); tu, tv = tl; ox, oy = org
        for i in range(int(math.floor((minx - ox) / tu + 1e-6)), int(math.ceil((maxx - ox) / tu - 1e-6))):
            for j in range(int(math.floor((miny - oy) / tv + 1e-6)), int(math.ceil((maxy - oy) / tv - 1e-6))):
                cx0, cy0 = ox + i * tu, oy + j * tv
                cell = sbox(cx0, cy0, cx0 + tu, cy0 + tv).intersection(solid)
                for p in _polys(cell):
                    if p.area < 1e-6:
                        continue
                    p = orient(p.simplify(1e-5), 1.0)
                    loops = [np.array(p.exterior.coords)[:-1]] + [np.array(r.coords)[:-1] for r in p.interiors]
                    allp = np.concatenate(loops)
                    try:
                        tris = tessellate(loops)
                    except Exception:
                        continue
                    for tri in tris:
                        P = np.array([[allp[t][0], allp[t][1], z] for t in tri])
                        if np.linalg.norm(np.cross(P[1] - P[0], P[2] - P[0])) < 1e-9:
                            continue
                        if newell(P)[2] * sgn < 0:
                            P = P[::-1]
                        uv = [rg.uv((q[0] - cx0) / tu if sgn > 0 else 1 - (q[0] - cx0) / tu, (q[1] - cy0) / tv) for q in P]
                        tmp.poly(P, lambda P_, n_, uv=uv: uv)
    if th > 0:
        olb = ol.exterior
        oly0 = ol.bounds[1]
        for p in _polys(solid):
            p = orient(p, 1.0)
            for ring in [p.exterior] + list(p.interiors):
                C = np.array(ring.coords)
                for a, b in zip(C[:-1], C[1:]):
                    L = float(np.linalg.norm(b - a))
                    if L < 1e-5:
                        continue
                    mid = (a + b) / 2
                    if olb.distance(Point(mid)) < 1e-6:
                        if cap == 'none':
                            continue
                        if cap == 'auto' and abs(a[1] - oly0) < 1e-6 and abs(b[1] - oly0) < 1e-6:
                            continue
                    # outward = right of a->b (CCW exterior, CW holes); quad from b to a so du x dv points outward
                    o = (b[0], b[1], 0.0); du = (a[0] - b[0], a[1] - b[1], 0.0)
                    tquad(tmp, o, du, (0, 0, -1), L, th, side, (side_tile[0], max(side_tile[1], th)))
    mb.merge(tmp, M)


def resample(path, seg):
    P = np.asarray(path, float); out = [P[0]]
    L0 = 0.0
    for a, b in zip(P[:-1], P[1:]):
        d = float(np.linalg.norm(b - a))
        if d < 1e-9:
            continue
        # cut at multiples of seg (cumulative)
        k = math.floor(L0 / seg + 1e-6) + 1
        while k * seg < L0 + d - 1e-6:
            t = (k * seg - L0) / d
            out.append(a + (b - a) * t); k += 1
        out.append(b); L0 += d
    return np.array(out)


def tube(mb, path, r, sides, reg, seg=1.0, around=1.0, cap=False, M=None, smooth=True, flat=None):
    """Tube along polyline, resampled at multiples of seg so the region repeats every seg metres along it."""
    rg = reg_of(reg)
    P = resample(path, seg) if np.isscalar(r) else np.asarray(path, float)
    tmp = MB()
    tmp.tube(P, r, sides, lambda s, l: (0.0, 0.0), smooth=smooth, cap=cap, flat=flat)
    L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    k = 0
    for i in range(len(P) - 1):
        m = L[i] / seg; t0 = m - math.floor(m + 1e-6); t1 = min(1.0, t0 + (L[i + 1] - L[i]) / seg)
        for s in range(sides):
            idx, uv, sm, mt = tmp.F[k]
            tmp.F[k] = (idx, [rg.uv(s / sides * around, t0), rg.uv((s + 1) / sides * around, t0),
                              rg.uv((s + 1) / sides * around, t1), rg.uv(s / sides * around, t1)], sm, mt)
            k += 1
    for j in range(k, len(tmp.F)):
        idx, uv, sm, mt = tmp.F[j]
        tmp.F[j] = (idx, [rg.uv(0.5, 0.5)] * len(idx), sm, mt)
    mb.merge(tmp, M)


def lathe(mb, prof, segs, reg, M=None, smooth=True, around=1.0, jitter=None, t_range=(0.0, 1.0)):
    """Surface of revolution about +Y. prof: list of (r, y) from bottom to top. jitter(i, k) -> radial scale."""
    rg = reg_of(reg)
    prof = np.asarray(prof, float)
    L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(prof, axis=0), axis=1))]); L /= L[-1]
    tmp = MB()
    rings = []
    for i, (rr, y) in enumerate(prof):
        ring = []
        for k in range(segs):
            a = 2 * math.pi * k / segs
            j = jitter(i, k) if jitter else 1.0
            ring.append(tmp.v((rr * j * math.cos(a), y, rr * j * math.sin(a))))
        rings.append(ring)
    t0_, t1_ = t_range
    for i in range(len(prof) - 1):
        for k in range(segs):
            k2 = (k + 1) % segs
            ids = [rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2]]
            uvs = [rg.uv(k / segs * around, t0_ + (t1_ - t0_) * L[i]), rg.uv(k / segs * around, t0_ + (t1_ - t0_) * L[i + 1]),
                   rg.uv((k + 1) / segs * around, t0_ + (t1_ - t0_) * L[i + 1]), rg.uv((k + 1) / segs * around, t0_ + (t1_ - t0_) * L[i])]
            if prof[i + 1][0] < 1e-6:
                ids = [ids[0], ids[1], ids[3]]; uvs = [uvs[0], uvs[1], uvs[3]]
            elif prof[i][0] < 1e-6:
                ids = [ids[0], ids[1], ids[2]]; uvs = [uvs[0], uvs[1], uvs[2]]
            tmp.face(ids, uvs, smooth)
    mb.merge(tmp, M)


def prism(mb, poly2, y0, y1, reg, tile=(1.0, 1.0), M=None, top=None, bottom=False, sides=True):
    """Vertical prism from a CCW 2D outline in (x, z) (seen from above, z towards viewer = +Z)."""
    P = np.asarray(poly2, float)
    tmp = MB()
    if sides:
        for a, b in zip(P, np.roll(P, -1, 0)):
            L = float(np.linalg.norm(b - a))
            if L < 1e-6:
                continue
            tquad(tmp, (a[0], y0, a[1]), (b[0] - a[0], 0, b[1] - a[1]), (0, 1, 0), L, y1 - y0, reg, tile)
    if top is not None:
        T3 = np.array([[p[0], y1, p[1]] for p in P])
        if newell(T3)[1] < 0:
            T3 = T3[::-1]
        tmp.poly(T3, fit(top, (max(np.ptp(P[:, 0]), 0.1), max(np.ptp(P[:, 1]), 0.1)), stretch=True))
    if bottom:
        B3 = np.array([[p[0], y0, p[1]] for p in P])
        if newell(B3)[1] > 0:
            B3 = B3[::-1]
        tmp.poly(B3, fit(reg, (1, 1)))
    mb.merge(tmp, M)


def chunk(mb, centre, size, seed, reg, rot=None, M=None):
    """Irregular box-ish lump (rubble, debris)."""
    r = rng(seed)
    sx, sy, sz = size
    pts = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], float) * [sx / 2, sy / 2, sz / 2]
    pts += r.normal(0, 1, pts.shape) * np.array([sx, sy, sz]) * 0.14
    rx, ry, rz = rot if rot is not None else r.uniform(-0.5, 0.5, 3) * [1, 3, 1]
    Mr = mat_trs(centre, (rx, ry, rz))
    if M is not None:
        Mr = M @ Mr
    P = xform(pts, Mr)
    f = Fit(reg_of(reg), (0.6, 0.6), seed)
    for fc in [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]:
        Q = P[list(fc)]
        c = Q.mean(0); n = newell(Q)
        if np.dot(n, c - P.mean(0)) < 0:
            Q = Q[::-1]
        mb.poly(Q[[0, 1, 2]], f); mb.poly(Q[[0, 2, 3]], f)


def loose_bricks(mb, cx, cz, rad, n, colour, seed, y0=0.0, M=None):
    r = rng(seed)
    reg = R['brick_' + colour]
    for k in range(n):
        a = r.uniform(0, 2 * np.pi); d = rad * math.sqrt(r.random())
        y = y0 + 0.035 + max(0.0, (1 - d / rad)) * rad * 0.3 * r.random()
        Mr = mat_trs((cx + math.cos(a) * d, y, cz + math.sin(a) * d), (r.uniform(-0.4, 0.4), r.uniform(0, 3.14), r.uniform(-0.4, 0.4)))
        if M is not None:
            Mr = M @ Mr
        mb.box((-0.125, -0.033, -0.06), (0.125, 0.033, 0.06), Fit(reg, (0.5, 0.15), seed + k), faces='+x-x+y+z-z', M=Mr)


def ribbon(mb, rows, reg, double=True, uv_rect=(0, 0, 1, 1)):
    rg = reg_of(reg); s0, t0, s1, t1 = uv_rect
    mb.ribbon(rows, lambda s, t: rg.uv(s0 + (s1 - s0) * s, t0 + (t1 - t0) * t), double=double, smooth=True)


def sheet(mb, w, h, nu, nv, reg, M, bend=None, seed=0, double=True, uv_rect=(0, 0, 1, 1)):
    """Thin sheet (w x h in local XY from (0,0)) deformed by bend(u, v) -> (dx, dy, dz)."""
    rows = []
    for j in range(nv + 1):
        row = []
        for i in range(nu + 1):
            u, v = i / nu, j / nv
            p = np.array([u * w, v * h, 0.0])
            if bend:
                p = p + np.asarray(bend(u, v), float)
            row.append(xform(p[None], M)[0])
        rows.append(row)
    ribbon(mb, rows, reg, double, uv_rect)
