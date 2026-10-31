"""Courtyard furniture for modern.glb, after the 2010s-2020s Ukrainian / Russian dvory: HPL + steel playground
complex, street-workout frame, glazed bus shelter, euro-bin pad, park bench, GSK garage row, and the pharmacy
pavilion extras.  Same conventions as modern_geo (material 0 = modern_atlas, 1 = modern_alpha, +Y up, X long axis).
"""
import math
import numpy as np
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient
from meshlib import Fit, newell, xform, mat_trs, rot_axis, rng, tessellate
import modern_atlas as MA
import modern_yard_atlas as MYA
import city_geo as G
from city_geo import tquad, tbox, fbox, lathe, chunk, wall
from modern_geo import (TMB, T, RS, tint, soot_blob, ground_ao, frame, edge_frame, beam, cyl, disc, aquad, PI, BLUE, YEL,
                        RED, GREEN)


def HP(k):
    return G.R['pg_hpl'].sub(*MYA.HPL[k])


def YD(k):
    return G.R['yard_misc'].sub(*MYA.YARD[k])


EDGE = {c: (lambda c=c: YD('e_' + c)) for c in ('orange', 'lime', 'blue', 'yellow')}
EDGE['red'] = RED
EDGE['green'] = GREEN


def extrude(mb, poly, th, face, side, M=None, back=True):
    """Flat 2D outline (x, y) extruded along local z from -th/2 to th/2: face region stretched over the outline bbox
    on both sides, side region on the rim."""
    pg = orient(Polygon(poly).buffer(0), 1.0)
    loops = [np.array(pg.exterior.coords)[:-1]] + [np.array(r.coords)[:-1] for r in pg.interiors]
    allp = np.concatenate(loops)
    mn, mx = allp.min(0), allp.max(0); ext = np.maximum(mx - mn, 1e-6)
    fr = G.reg_of(face); sr = G.reg_of(side)
    tmp = TMB()
    for tri in tessellate(loops):
        for z, sgn in ((th / 2, 1), (-th / 2, -1)):
            if sgn < 0 and not back:
                continue
            P = np.array([[allp[t][0], allp[t][1], z] for t in tri])
            if newell(P)[2] * sgn < 0:
                P = P[::-1]
            uv = [fr.uv((p[0] - mn[0]) / ext[0] if sgn > 0 else 1 - (p[0] - mn[0]) / ext[0], (p[1] - mn[1]) / ext[1]) for p in P]
            tmp.face(tmp.vs(P), uv)
    for lp in loops:
        for a, b in zip(lp, np.roll(lp, -1, 0)):
            P = np.array([[a[0], a[1], th / 2], [b[0], b[1], th / 2], [b[0], b[1], -th / 2], [a[0], a[1], -th / 2]])
            c = np.array([pg.centroid.x, pg.centroid.y, 0])
            if np.dot(newell(P), P.mean(0) - c) < 0:
                P = P[::-1]
            tmp.face(tmp.vs(P), [sr.uv(0.1, 0.1), sr.uv(0.9, 0.1), sr.uv(0.9, 0.9), sr.uv(0.1, 0.9)])
    mb.merge(tmp, M)


def post(mb, x, z, h, reg, r=0.05, y0=0.0, sides=8):
    cyl(mb, (x, y0, z), (x, y0 + h, z), r, sides, reg, seg=4.0)
    lathe(mb, [(0.0, h + 0.0), (r * 1.1, h), (r * 0.6, h + 0.06), (0.0, h + 0.07)], sides, reg, M=T(x, y0, z))


def mat_area(mb, x0, x1, z0, z1, reg, y=0.025):
    tquad(mb, (x0, y, z1), (1, 0, 0), (0, 0, -1), x1 - x0, z1 - z0, reg, (2.0, 2.0))


def kerb(mb, x0, x1, z0, z1, w=0.1, h=0.12):
    for (a, b, c, d) in ((x0 - w, x1 + w, z1, z1 + w), (x0 - w, x1 + w, z0 - w, z0), (x0 - w, x0, z0, z1), (x1, x1 + w, z0, z1)):
        tbox(mb, (a, 0, c), (b, h, d), 'concrete', (2.0, 1.0), faces='+x-x+z-z+y')


# ====================================================================== playground
def playground_modern(name='playground_modern', seed=410):
    """14 x 10 m playground: rubber-tile safety surface in a concrete kerb + low steel fence with a gate; play complex
    of two HPL towers (1.0 / 1.4 m decks, pyramid roofs) joined by a chain bridge, U-slide, rope climbing net,
    stepped ladder, climbing wall; steel A-frame double swing (flat seat + toddler cradle on chains), two spring
    riders, sandbox with a mushroom shade, carousel, see-saw, benches, bin and a rules board."""
    mb = TMB(name); r = rng(seed)
    Lx, Dz = 14.0, 10.0
    x0, x1, z0, z1 = -Lx / 2, Lx / 2, -Dz / 2, Dz / 2
    mat_area(mb, x0, 0.6, z0, z1, 'pg_mat')
    mat_area(mb, 0.6, x1, z0, z1, 'pg_mat2')
    kerb(mb, x0, x1, z0, z1)
    # low fence 0.9 m: posts every 2 m, two rails, flat bars every 0.5 m (gate gap on +Z)
    fence = [((x0 - 0.3, z0 - 0.3), (x1 + 0.3, z0 - 0.3)), ((x1 + 0.3, z0 - 0.3), (x1 + 0.3, z1 + 0.3)),
             ((x1 + 0.3, z1 + 0.3), (1.0, z1 + 0.3)), ((-0.6, z1 + 0.3), (x0 - 0.3, z1 + 0.3)), ((x0 - 0.3, z1 + 0.3), (x0 - 0.3, z0 - 0.3))]
    gal = 'steel_galv'; grn = EDGE['lime']()
    for (a, b) in fence:
        a = np.array(a); b = np.array(b); L = float(np.linalg.norm(b - a)); d = (b - a) / L
        nrm = np.array([-d[1], d[0]])
        for t in np.arange(0, L + 1e-6, 2.0):
            p = a + d * min(t, L)
            fbox(mb, (p[0] - 0.03, 0, p[1] - 0.03), (p[0] + 0.03, 0.95, p[1] + 0.03), grn, faces='+x-x+z-z+y')
        for y in (0.15, 0.85):
            beam(mb, (a[0], y, a[1]), (b[0], y, b[1]), 0.03, 0.04, grn)
        for t in np.arange(0.25, L, 0.5):
            p = a + d * t
            P = [(p[0] - d[0] * 0.015, 0.15, p[1] - d[1] * 0.015), (p[0] + d[0] * 0.015, 0.15, p[1] + d[1] * 0.015),
                 (p[0] + d[0] * 0.015, 0.85, p[1] + d[1] * 0.015), (p[0] - d[0] * 0.015, 0.85, p[1] - d[1] * 0.015)]
            G.quad(mb, P, grn, double=True)
    # ---- play complex: tower A (1.0 m deck) at (-4.6, -1.5), tower B (1.4 m deck) at (-1.6, -1.5)
    towers = [(-4.6, -1.8, 1.0, 'orange', 'blue'), (-1.4, -1.8, 1.4, 'red', 'yellow')]
    s = 0.62
    for k, (tx, tz, ph, c1, c2) in enumerate(towers):
        for dx, dz in ((-s, -s), (s, -s), (s, s), (-s, s)):
            post(mb, tx + dx, tz + dz, ph + 1.75, EDGE['blue']() if k == 0 else EDGE['yellow'](), r=0.05)
        tbox(mb, (tx - s, ph - 0.04, tz - s), (tx + s, ph, tz + s), 'wood_slats', (1.2, 1.2), faces='+y-y+x-x+z-z')
        apex = (tx, ph + 2.45, tz); y_ = ph + 1.75
        base = [(tx - s - 0.12, y_, tz - s - 0.12), (tx + s + 0.12, y_, tz - s - 0.12), (tx + s + 0.12, y_, tz + s + 0.12), (tx - s - 0.12, y_, tz + s + 0.12)]
        for i in range(4):
            tri = np.array([base[i], apex, base[(i + 1) % 4]])
            if np.dot(newell(tri), tri.mean(0) - np.array([tx, y_, tz])) < 0:
                tri = tri[::-1]
            reg = EDGE[c1 if i % 2 else 'yellow' if c1 != 'yellow' else 'orange']()
            mb.poly(tri, G.uvq(reg, ((0, 0), (0.5, 1), (1, 0)))); mb.poly(tri[::-1], G.uvq(reg, ((0, 0), (0.5, 1), (1, 0))))
        # HPL side panels (between the posts, 0.75 m high above the deck)
        designs = (('porthole', 'tictac'), ('wheel', 'circles'))[k]
        sides = [((tx - s, tz - s), (tx + s, tz - s), designs[0]), ((tx - s, tz + s), (tx - s, tz - s), designs[1])] if k == 0 else \
                [((tx - s, tz - s), (tx + s, tz - s), designs[0]), ((tx + s, tz - s), (tx + s, tz + s), designs[1])]
        for (a, b, dsg) in sides:
            M, Lw = edge_frame(a, b)
            extrude(mb, [(0.06, 0.05), (Lw - 0.06, 0.05), (Lw - 0.06, 0.8), (0.06, 0.8)], 0.019, HP(dsg), EDGE[c2](), M=M @ T(0, ph, 0))
    # bridge between the towers (chain rails + rubber slats)
    ax_, bx_ = -4.6 + s, -1.4 - s
    for i in range(6):
        t = (i + 0.5) / 6; x = ax_ + (bx_ - ax_) * t; y = 1.0 + 0.4 * t - 0.12 * math.sin(PI * t)
        fbox(mb, (x - 0.1, y - 0.04, -1.8 - 0.4), (x + 0.1, y, -1.8 + 0.4), YD('seat'), faces='+y-y+x-x+z-z')
    for zz in (-2.2, -1.4):
        pts = [(ax_ + (bx_ - ax_) * t, 1.75 + 0.4 * t - 0.15 * math.sin(PI * t), zz) for t in np.linspace(0, 1, 7)]
        G.tube(mb, pts, 0.015, 3, 'steel_galv', seg=10)
        for p in pts[1:-1]:
            G.quad(mb, [(p[0] - 0.012, p[1] - 0.75, zz), (p[0] + 0.012, p[1] - 0.75, zz), (p[0] + 0.012, p[1], zz), (p[0] - 0.012, p[1], zz)], YD('chain'), double=True)
    # U-slide from tower B to +X
    tx, tz, ph = -1.4, -1.8, 1.4
    rows = []
    n_ = 10
    for i in range(n_ + 1):
        t = i / n_
        x = tx + s + t * 3.4
        y = ph * (1 - t) ** 1.25 * (1 - 0.1 * t) + 0.28 * t ** 2
        row = [(x, y + dy + 0.02, tz + u) for (u, dy) in ((-0.3, 0.26), (-0.27, 0.04), (-0.2, -0.02), (0.0, -0.05), (0.2, -0.02), (0.27, 0.04), (0.3, 0.26))]
        rows.append(row)
    G.ribbon(mb, rows, EDGE['yellow'](), double=True)
    for t in (0.5, 0.95):
        x = tx + s + t * 3.4
        fbox(mb, (x - 0.04, 0, tz - 0.04), (x + 0.04, max(0.25, ph * (1 - t) ** 1.25 * (1 - 0.1 * t)), tz + 0.04), EDGE['blue'](), faces='+x-x+z-z')
    # rope climbing net on tower B's +Z side (inclined)
    nb_ = 5
    for i in range(nb_ + 1):
        u = i / nb_
        G.tube(mb, [(tx - s + 2 * s * u, 0.02, tz + s + 1.1), (tx - s + 2 * s * u, ph + 0.1, tz + s)], 0.016, 3, 'steel_dark', seg=10)
    for j in range(1, 6):
        v = j / 6
        G.tube(mb, [(tx - s, ph * v, tz + s + 1.1 * (1 - v)), (tx + s, ph * v, tz + s + 1.1 * (1 - v))], 0.016, 3, 'steel_dark', seg=10)
    for xx in (tx - s, tx + s):
        beam(mb, (xx, 0, tz + s + 1.15), (xx, 0.12, tz + s + 1.15), 0.06, 0.06, EDGE['blue']())
    # stepped ladder up tower A from -X, climbing wall on tower A's +Z side
    tx, tz, ph = -4.6, -1.8, 1.0
    for kk in range(4):
        y = 0.25 * (kk + 1)
        fbox(mb, (tx - s - 1.0 + kk * 0.25, y - 0.035, tz - 0.38), (tx - s - 0.78 + kk * 0.25, y, tz + 0.38), 'wood_slats', faces='+y-y+x-x+z-z')
    for zz in (tz - 0.42, tz + 0.42):
        extrude(mb, [(0, 0), (0.25, 0), (1.15, ph), (1.15, ph + 0.75), (0.95, ph + 0.75), (0.0, 0.2)], 0.02, EDGE['orange'](), EDGE['orange'](), M=frame((tx - s - 1.15, 0, zz), (1, 0, 0)))
    M, Lw = edge_frame((tx + s, tz + s), (tx - s, tz + s))
    extrude(mb, [(0.0, 0.0), (Lw, 0.0), (Lw, ph), (0.0, ph)], 0.025, HP('holds'), EDGE['lime'](), M=M @ rot_axis((1, 0, 0), -0.25) @ T(0, 0, 0.3))
    # ---- swing: A-frame double swing on the terracotta half (+X, -Z)
    sx, sz, sh = 3.6, -2.6, 2.3
    for xx in (sx - 1.8, sx + 1.8):
        for dz in (-0.85, 0.85):
            cyl(mb, (xx, sh, sz), (xx, 0, sz + dz), 0.05, 8, EDGE['blue'](), seg=4)
        beam(mb, (xx, 0.9, sz - 0.6), (xx, 0.9, sz + 0.6), 0.04, 0.04, EDGE['blue']())
    cyl(mb, (sx - 1.85, sh, sz), (sx + 1.85, sh, sz), 0.055, 8, EDGE['yellow'](), seg=4)
    for kk, x in enumerate((sx - 0.8, sx + 0.8)):
        ang = 0.18 if kk == 0 else -0.04
        ys = sh - math.cos(ang) * 1.85; zs = sz + math.sin(ang) * 1.85
        if kk == 0:
            fbox(mb, (x - 0.23, ys - 0.03, zs - 0.09), (x + 0.23, ys + 0.01, zs + 0.09), YD('seat'), faces='+y-y+x-x+z-z')
        else:
            fbox(mb, (x - 0.22, ys - 0.05, zs - 0.16), (x + 0.22, ys + 0.25, zs + 0.16), YD('cradle'), faces='+x-x+z-z+y')
        for dx in (-0.21, 0.21):
            p0 = np.array([x + dx, sh - 0.03, sz]); p1 = np.array([x + dx, ys + 0.01, zs])
            dd = p1 - p0; side = np.array([0.012, 0, 0])
            G.quad(mb, [p0 - side, p0 + side, p1 + side, p1 - side], YD('chain'), double=True)
    # ---- spring riders (extruded HPL horse / car on a coil spring)
    horse = [(-0.38, 0.0), (0.3, 0.0), (0.36, 0.1), (0.42, 0.34), (0.5, 0.42), (0.47, 0.5), (0.3, 0.45), (0.22, 0.3), (-0.2, 0.28), (-0.34, 0.4), (-0.44, 0.36), (-0.34, 0.2)]
    car_ = [(-0.45, 0.0), (0.45, 0.0), (0.48, 0.16), (0.3, 0.2), (0.18, 0.4), (-0.22, 0.4), (-0.34, 0.2), (-0.48, 0.16)]
    for (x, z, shp, c, rot) in ((2.0, 2.8, horse, 'yellow', 0.3), (4.4, 2.2, car_, 'blue', -0.4)):
        tbox(mb, (x - 0.25, 0.0, z - 0.25), (x + 0.25, 0.04, z + 0.25), 'steel_dark', faces='+y+x-x+z-z')
        G.tube(mb, [(x, 0.04, z), (x, 0.45, z)], 0.075, 8, YD('spring'), seg=0.41)
        Mx = T(x, 0.45, z) @ rot_axis((0, 1, 0), rot)
        extrude(mb, shp, 0.04, EDGE[c](), EDGE[c](), M=Mx @ T(0, 0.0, 0.11))
        extrude(mb, shp, 0.04, EDGE[c](), EDGE[c](), M=Mx @ T(0, 0.0, -0.11))
        fbox(mb, (-0.2, 0.18, -0.13), (0.15, 0.23, 0.13), YD('seat'), faces='+y+x-x+z-z', M=Mx)
        cyl(mb, xform(np.array([[0.25, 0.36, -0.17]]), Mx)[0], xform(np.array([[0.25, 0.36, 0.17]]), Mx)[0], 0.015, 5, 'steel_galv')
    # ---- sandbox with a mushroom shade
    bx, bz = -4.5, 2.6
    for (a, b, c, d) in ((-1.0, 1.0, 0.85, 1.0), (-1.0, 1.0, -1.0, -0.85), (-1.0, -0.85, -0.85, 0.85), (0.85, 1.0, -0.85, 0.85)):
        tbox(mb, (bx + a, 0, bz + c), (bx + b, 0.3, bz + d), 'wood_slats', (1.0, 0.3), faces='+x-x+z-z+y')
    for (a, c) in ((-1.0, -1.0), (0.6, 0.6)):
        tbox(mb, (bx + a, 0.3, bz + c), (bx + a + 0.4, 0.34, bz + c + 0.4), 'wood_slats', (0.5, 0.5), faces='+x-x+z-z+y')
    tquad(mb, (bx - 0.85, 0.22, bz + 0.85), (1, 0, 0), (0, 0, -1), 1.7, 1.7, 'pg_sand', (1.7, 1.7))
    post(mb, bx, bz, 2.0, EDGE['lime'](), r=0.06)
    lathe(mb, [(0.0, 2.55), (0.4, 2.42), (1.2, 2.05), (1.22, 2.0)], 8, EDGE['red'] if False else EDGE['orange'](), M=T(bx, 0, bz))
    lathe(mb, [(1.22, 2.0), (1.2, 2.05), (0.4, 2.42), (0.0, 2.55)][::-1], 8, EDGE['yellow'](), M=T(bx, -0.01, bz))
    for k in range(3):
        chunk(mb, (bx + r.uniform(-0.6, 0.6), 0.28, bz + r.uniform(-0.6, 0.6)), (0.25, 0.12, 0.2), seed + k, 'pg_sand')
    # ---- carousel + see-saw
    cx_, cz_ = -0.6, 2.8
    lathe(mb, [(0.0, 0.3), (0.9, 0.3), (0.93, 0.25), (0.9, 0.2), (0.0, 0.2)][::-1], 14, EDGE['red'](), M=T(cx_, 0, cz_))
    lathe(mb, [(0.0, 0.01), (0.2, 0.01), (0.12, 0.2)], 8, 'steel_dark', M=T(cx_, 0, cz_))
    for kk in range(4):
        a = kk * PI / 2 + 0.3
        p0 = (cx_ + math.cos(a) * 0.15, 0.3, cz_ + math.sin(a) * 0.15); p1 = (cx_ + math.cos(a) * 0.75, 0.3, cz_ + math.sin(a) * 0.75)
        G.tube(mb, [p0, (p0[0], 0.9, p0[2]), (p1[0], 0.9, p1[2]), p1], 0.02, 5, 'steel_galv', seg=10)
    lathe(mb, [(0.22, 0.9), (0.25, 0.93), (0.22, 0.96)], 10, EDGE['yellow'](), M=T(cx_, 0, cz_))
    ssx, ssz = 2.4, 4.0
    fbox(mb, (ssx - 0.08, 0, ssz - 0.2), (ssx + 0.08, 0.5, ssz + 0.2), EDGE['blue'](), faces='+x-x+z-z+y')
    Ms = T(ssx, 0.52, ssz) @ rot_axis((0, 0, 1), 0.2)
    fbox(mb, (-1.5, -0.03, -0.12), (1.5, 0.03, 0.12), EDGE['orange'](), faces='+y-y+x-x+z-z', M=Ms)
    for xx in (-1.25, 1.25):
        fbox(mb, (xx - 0.15, 0.03, -0.14), (xx + 0.15, 0.07, 0.14), YD('seat'), faces='+y+x-x+z-z', M=Ms)
        cyl(mb, xform(np.array([[xx + 0.22, 0.03, 0]]), Ms)[0], xform(np.array([[xx + 0.22, 0.32, 0]]), Ms)[0], 0.015, 5, 'steel_galv')
        cyl(mb, xform(np.array([[xx + 0.22, 0.32, -0.13]]), Ms)[0], xform(np.array([[xx + 0.22, 0.32, 0.13]]), Ms)[0], 0.015, 5, 'steel_galv')
    # ---- benches, bin, rules board
    bench(mb, T(-2.5, 0, z1 + 1.0) @ rot_axis((0, 1, 0), PI), 'slat_g')
    bench(mb, T(3.0, 0, z1 + 1.0) @ rot_axis((0, 1, 0), PI), 'slat_g')
    lathe(mb, [(0.0, 0.05), (0.2, 0.05), (0.22, 0.75), (0.2, 0.78)], 8, YD('ash_bin'), M=T(0.2, 0, z1 + 0.9))
    for xx in (-0.95, -0.35):
        fbox(mb, (xx - 0.03, 0, z1 + 0.6), (xx + 0.03, 1.9, z1 + 0.66), 'steel_dark', faces='+x-x+z-z+y')
    fbox(mb, (-1.0, 1.0, z1 + 0.66), (-0.3, 1.85, z1 + 0.69), YD('rules'), faces='+z', M=None)
    fbox(mb, (-1.0, 1.0, z1 + 0.64), (-0.3, 1.85, z1 + 0.66), 'steel_dark', faces='-z+y-y+x-x')
    tint(mb, ground_ao(0.5, 0.7))
    return mb


def bench(mb, M=None, slat='slat'):
    """Park bench 1.8 m: two cast-steel side frames, 4 seat slats, 2 back slats leaning back (seat faces +Z)."""
    tmp = TMB(); sl = YD(slat)
    for x in (-0.75, 0.75):
        extrude(tmp, [(-0.25, 0.0), (-0.18, 0.0), (-0.1, 0.38), (0.12, 0.38), (0.18, 0.0), (0.25, 0.0), (0.2, 0.44), (-0.22, 0.44),
                      (-0.32, 0.88), (-0.37, 0.87), (-0.27, 0.42)][::-1], 0.05, 'steel_dark', 'steel_dark', M=frame((x, 0, 0), (0, 0, -1)))
    for k in range(4):
        z = -0.22 + k * 0.12
        fbox(tmp, (-0.9, 0.44, z), (0.9, 0.48, z + 0.1), sl, faces='+y-y+z-z+x-x')
    for k in range(2):
        y = 0.56 + k * 0.17
        Mb = rot_axis((1, 0, 0), -0.22, origin=(0, y, -0.3))
        fbox(tmp, (-0.9, y, -0.33), (0.9, y + 0.12, -0.29), sl, faces='+z-z+y-y+x-x', M=Mb)
    mb.merge(tmp, M)


def bench_modern(name='bench_modern', seed=450):
    mb = TMB(name)
    bench(mb)
    tquad(mb, (-1.1, 0.012, 0.55), (1, 0, 0), (0, 0, -1), 2.2, 1.0, YD('tile'), (1.0, 0.5))
    lathe(mb, [(0.0, 0.05), (0.18, 0.05), (0.2, 0.62), (0.18, 0.65)], 8, YD('ash_bin'), M=T(1.25, 0, -0.05))
    tint(mb, ground_ao(0.4, 0.7))
    return mb


# ====================================================================== outdoor gym
def outdoor_gym(name='outdoor_gym', seed=420):
    """Street-workout frame on a 6 x 4 m rubber-tile mat: welded square-tube frame (2.4 m) with pull-up bars at
    three heights, monkey-bar ladder, Swedish wall bars, dip bars, parallel bars, inclined sit-up bench, push-up
    handles; powder-coated blue / yellow, galvanised bars."""
    mb = TMB(name)
    mat_area(mb, -3.0, 3.0, -2.0, 2.0, 'pg_mat')
    kerb(mb, -3.0, 3.0, -2.0, 2.0, 0.08, 0.1)
    B_, Y_ = EDGE['blue'](), EDGE['yellow']()
    sq = lambda x, z, h, reg: tbox(mb, (x - 0.05, 0, z - 0.05), (x + 0.05, h, z + 0.05), reg, (1, 2.5), faces='+x-x+z-z+y')
    bar = lambda a, b, rr=0.016: cyl(mb, a, b, rr, 6, 'steel_galv')
    # main frame: 3 bays along X at z = -1.2, pull-ups 2.0 / 2.3 / 2.6
    xs = (-2.6, -1.6, -0.6, 0.4)
    for x in xs:
        sq(x, -1.3, 2.6, B_)
    for (xa, xb, h) in ((-2.6, -1.6, 2.0), (-1.6, -0.6, 2.3), (-0.6, 0.4, 2.6)):
        bar((xa, h, -1.3), (xb, h, -1.3))
    tbox(mb, (-2.65, 2.6, -1.35), (0.45, 2.7, -1.25), Y_, (2, 1), faces='+x-x+z-z+y-y')
    # monkey bars from the frame towards +Z
    for z in (-1.0, 0.2):
        tbox(mb, (-0.65, 2.35, z - 0.04), (0.45, 2.43, z + 0.04), Y_, (2, 1), faces='+y-y+z-z+x-x')
    for x in (-0.6, 0.4):
        sq(x, 0.2, 2.43, B_)
    for k in range(8):
        z = -1.15 + k * 0.17
        bar((-0.6, 2.4, z), (0.4, 2.4, z))
    # Swedish wall bars
    for x in (1.0, 1.9):
        sq(x, -1.3, 2.5, Y_)
    for k in range(9):
        bar((1.0, 0.25 + k * 0.26, -1.3), (1.9, 0.25 + k * 0.26, -1.3), 0.018)
    # dip bars (V) + parallel bars
    for z in (0.7, 1.3):
        for x in (-2.5, -1.0):
            sq(x, z, 1.15, Y_)
        cyl(mb, (-2.5, 1.18, z), (-1.0, 1.18, z), 0.025, 6, 'steel_galv')
    for (a, b) in (((1.2, 0.6), (2.0, 0.85)), ((1.2, 1.3), (2.0, 1.05))):
        for p in (a, b):
            sq(p[0], p[1], 1.25, B_)
        cyl(mb, (a[0], 1.27, a[1]), (b[0], 1.27, b[1]), 0.025, 6, 'steel_galv')
    # inclined sit-up bench
    Mi = T(2.3, 0, -0.2) @ rot_axis((0, 1, 0), PI / 2)
    tbox(mb, (-0.75, 0.3, -0.18), (0.75, 0.36, 0.18), YD('slat'), (1.5, 0.36), faces='+y-y+x-x+z-z', M=Mi @ rot_axis((0, 0, 1), 0.3))
    for xx, hh in ((-0.6, 0.12), (0.6, 0.6)):
        tbox(mb, (xx - 0.04, 0, -0.04), (xx + 0.04, hh + 0.2, 0.04), B_, faces='+x-x+z-z', M=Mi)
    cyl(mb, xform(np.array([[-0.75, 0.3, -0.2]]), Mi)[0], xform(np.array([[-0.75, 0.3, 0.2]]), Mi)[0], 0.04, 6, 'tyre_car')
    # push-up handles
    for z in (-0.3, 0.3):
        for x in (-2.4, -1.8):
            G.tube(mb, [(x, 0, z), (x, 0.3, z), (x + 0.3, 0.3, z), (x + 0.3, 0, z)], 0.02, 5, 'steel_galv', seg=10)
    tint(mb, ground_ao(0.5, 0.7))
    return mb


# ====================================================================== bus stop
def bus_stop_modern(name='bus_stop_modern', seed=400):
    """Modern glazed shelter 4.2 x 1.6 m, 2.6 m: rectangular galvanised frame, roof with an anthracite fascia and
    stop name, three cracked / shot-out back glass panels, a lit citylight end panel and glass end panel, wooden
    bench on steel brackets, route sign on its own pole with timetable, litter bin, kerb + paving, glass crumbs."""
    mb = TMB(name); r = rng(seed)
    Lx, D, H = 4.2, 1.6, 2.55
    tquad(mb, (-Lx / 2 - 0.5, 0.012, D / 2 + 0.4), (1, 0, 0), (0, 0, -1), Lx + 1.0, D + 0.7, YD('tile'), (1.0, 0.5))
    tbox(mb, (-Lx / 2 - 0.5, 0, D / 2 + 0.4), (Lx / 2 + 1.2, 0.15, D / 2 + 0.55), 'concrete', (2, 1), faces='+x-x+z-z+y')
    for x in (-Lx / 2, -Lx / 6, Lx / 6, Lx / 2):
        tbox(mb, (x - 0.04, 0, -D / 2 - 0.06), (x + 0.04, H, -D / 2 + 0.04), 'steel_galv', (1, 2.5), faces='+x-x+z-z')
    for x in (-Lx / 2, Lx / 2):
        tbox(mb, (x - 0.04, 0, D / 2 - 0.08), (x + 0.04, H, D / 2), 'steel_galv', (1, 2.5), faces='+x-x+z-z')
        tbox(mb, (x - 0.04, H - 0.08, -D / 2), (x + 0.04, H, D / 2), 'steel_galv', (2, 1), faces='+x-x-y')
    tbox(mb, (-Lx / 2, 0.25, -D / 2 - 0.05), (Lx / 2, 0.3, -D / 2 + 0.03), 'steel_galv', (2, 1), faces='+y+z-z')
    tbox(mb, (-Lx / 2, 2.3, -D / 2 - 0.05), (Lx / 2, 2.35, -D / 2 + 0.03), 'steel_galv', (2, 1), faces='-y+z-z')
    # roof: slab + fascia with the stop name
    tbox(mb, (-Lx / 2 - 0.2, H, -D / 2 - 0.2), (Lx / 2 + 0.2, H + 0.18, D / 2 + 0.35), 'sm_acm', (3.0, 2.0), faces='+x-x+z-z-y')
    tbox(mb, (-Lx / 2 - 0.2, H + 0.18, -D / 2 - 0.2), (Lx / 2 + 0.2, H + 0.19, D / 2 + 0.35), 'roof_membrane', (2, 2), faces='+y')
    G.quad(mb, [(-0.2, H + 0.02, D / 2 + 0.352), (0.0, H + 0.02, D / 2 + 0.352), (0.0, H + 0.16, D / 2 + 0.352), (-0.2, H + 0.16, D / 2 + 0.352)], YD('route'))
    regs = ['glass_crack_a', 'glass_crack_b', 'glass_crack_a']
    for i in range(3):
        x0 = -Lx / 2 + 0.05 + i * Lx / 3; x1 = -Lx / 2 + (i + 1) * Lx / 3 - 0.05
        if i == 1:
            continue          # shot out completely, crumbs below
        aquad(mb, [(x0, 0.3, -D / 2), (x1, 0.3, -D / 2), (x1, 2.3, -D / 2), (x0, 2.3, -D / 2)], regs[i], uvs=((0, 0), (1, 0), (1, 1), (0, 1)) if i == 0 else ((1, 0), (0, 0), (0, 1), (1, 1)))
    aquad(mb, [(Lx / 2, 0.3, -D / 2 + 0.06), (Lx / 2, 0.3, D / 2 - 0.1), (Lx / 2, 2.3, D / 2 - 0.1), (Lx / 2, 2.3, -D / 2 + 0.06)], 'glass_crack_b', uvs=((1, 1), (0, 1), (0, 0), (1, 0)))
    # citylight end panel (-X): box with lit posters both sides
    tbox(mb, (-Lx / 2 - 0.07, 0.25, -D / 2 + 0.1), (-Lx / 2 + 0.07, 2.3, D / 2 - 0.12), 'steel_dark', (1.5, 2.1), faces='+y-y+z-z')
    zA, zB = -D / 2 + 0.17, D / 2 - 0.19
    xp = -Lx / 2 + 0.071; xm = -Lx / 2 - 0.071
    mb.poly([(xp, 0.32, zB), (xp, 0.32, zA), (xp, 2.23, zA), (xp, 2.23, zB)], G.uvq(YD('citylight')))       # faces +X
    mb.poly([(xm, 0.32, zA), (xm, 0.32, zB), (xm, 2.23, zB), (xm, 2.23, zA)], G.uvq(YD('citylight')))       # faces -X
    # bench on brackets
    for x in (-1.2, 0.0, 1.2):
        tbox(mb, (x - 0.025, 0.25, -D / 2 + 0.03), (x + 0.025, 0.46, -D / 2 + 0.45), 'steel_dark', faces='+x-x+y')
    for k in range(3):
        z = -D / 2 + 0.06 + k * 0.13
        fbox(mb, (-1.6, 0.46, z), (1.6, 0.5, z + 0.11), YD('slat'), faces='+y-y+z-z+x-x')
    # route sign pole + timetable, litter bin
    px_ = Lx / 2 + 0.7
    cyl(mb, (px_, 0, D / 2 + 0.1), (px_, 2.9, D / 2 + 0.1), 0.04, 8, 'steel_galv', seg=3)
    fbox(mb, (px_ - 0.25, 2.35, D / 2 + 0.14), (px_ + 0.25, 2.85, D / 2 + 0.16), YD('route'), faces='+z')
    fbox(mb, (px_ - 0.25, 2.35, D / 2 + 0.12), (px_ + 0.25, 2.85, D / 2 + 0.14), 'steel_galv', faces='-z+x-x+y')
    fbox(mb, (px_ - 0.2, 1.35, D / 2 + 0.14), (px_ + 0.2, 2.0, D / 2 + 0.16), YD('timetable'), faces='+z')
    lathe(mb, [(0.0, 0.05), (0.18, 0.05), (0.2, 0.7), (0.18, 0.73)], 8, YD('ash_bin'), M=T(Lx / 2 + 0.35, 0, -0.2))
    for k in range(40):
        x, z = r.uniform(-1.0, 0.6), r.uniform(-D / 2 - 0.6, D / 2 + 0.3)
        s_ = r.uniform(0.03, 0.1)
        mb.poly([(x, 0.016, z), (x + s_, 0.016, z + 0.02), (x + s_ * 0.5, 0.016, z + s_ * 0.8)], G.fit('glass_dark', (0.3, 0.3)))
    tint(mb, ground_ao(0.6, 0.6))
    return mb


# ====================================================================== waste pad
def waste_pad(name='waste_pad', seed=440):
    """Euro-bin pad 5.0 x 2.6 m: concrete slab, profiled-sheet enclosure on steel posts (U, open to +Z) under a
    mono-pitch roof on four posts, three 1100 l bins (the right one tipped out with its lid open), bin bags, a
    cardboard heap, old notices and graffiti on the back sheet."""
    import modern_props as MP
    import modern_market as MK
    mb = TMB(name); r = rng(seed)
    Lx, Dz, Hw = 5.0, 2.6, 1.6
    tbox(mb, (-Lx / 2, 0, -Dz / 2), (Lx / 2, 0.1, Dz / 2), 'concrete', (2.5, 2.6), faces='+x-x+z+y')
    fence = [((-Lx / 2, -Dz / 2), (Lx / 2, -Dz / 2)), ((-Lx / 2, Dz / 2 - 0.2), (-Lx / 2, -Dz / 2)), ((Lx / 2, -Dz / 2), (Lx / 2, Dz / 2 - 0.2))]
    for (a, b) in fence:
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        tquad(mb, (a[0], 0.15, a[1]), (b[0] - a[0], 0, b[1] - a[1]), (0, 1, 0), L, Hw, 'roof_metal', (2.0, 2.0), double=True)
    for (x, z) in ((-Lx / 2, -Dz / 2), (Lx / 2, -Dz / 2), (-Lx / 2, Dz / 2 - 0.2), (Lx / 2, Dz / 2 - 0.2)):
        tbox(mb, (x - 0.04, 0, z - 0.04), (x + 0.04, 2.3 if z > 0 else 2.0, z + 0.04), 'steel_dark', (1, 2.3), faces='+x-x+z-z')
    Mr = rot_axis((1, 0, 0), -0.12, origin=(0, 2.0, -Dz / 2))
    tquad(mb, (-Lx / 2 - 0.15, 2.02, Dz / 2 + 0.1), (1, 0, 0), (0, 0, -1), Lx + 0.3, Dz + 0.25, 'roof_metal', (2.0, 2.0), M=Mr @ T(0, 0, 0))
    tquad(mb, (Lx / 2 + 0.15, 2.0, Dz / 2 + 0.1), (-1, 0, 0), (0, 0, -1), Lx + 0.3, Dz + 0.25, 'steel_dark', (2.0, 2.0), M=Mr)
    beam(mb, (-Lx / 2, 2.0, Dz / 2 - 0.2), (Lx / 2, 2.0 + 0.0, Dz / 2 - 0.2), 0.06, 0.08, 'steel_dark')
    # posters / graffiti on the back sheet
    G.quad(mb, [(-2.2, 0.4, -Dz / 2 + 0.02), (-1.2, 0.4, -Dz / 2 + 0.02), (-1.2, 1.4, -Dz / 2 + 0.02), (-2.2, 1.4, -Dz / 2 + 0.02)], YD('notice'))
    G.quad(mb, [(0.6, 0.9, -Dz / 2 - 0.02), (-0.6, 0.9, -Dz / 2 - 0.02), (-0.6, 1.6, -Dz / 2 - 0.02), (0.6, 1.6, -Dz / 2 - 0.02)], YD('graffiti'))
    MP.euro_bin(mb, T(-1.55, 0.1, -0.35), seed)
    MP.euro_bin(mb, T(0.0, 0.1, -0.3), seed + 1, open_lid=0.6)
    MP.euro_bin(mb, T(1.6, 0.1 - 0.2, 0.0) @ rot_axis((1, 0, 0), PI / 2, origin=(0, 0, 0.535)) @ rot_axis((0, 1, 0), 0.25), seed + 2, open_lid=0.9)
    bagreg = YD('bag')
    for k in range(7):
        x, z = r.uniform(0.6, 2.6), r.uniform(1.0, 2.2)
        s_ = r.uniform(0.35, 0.55)
        lathe(mb, [(0.0, 0.0), (s_ * 0.5, 0.05), (s_ * 0.55, s_ * 0.4), (s_ * 0.3, s_ * 0.8), (0.04, s_ * 0.95), (0.0, s_)], 6, bagreg,
              M=mat_trs((x, 0.02, z), (r.normal(0, 0.2), r.uniform(0, 3), r.normal(0, 0.2))), jitter=lambda i, kk: 1 + 0.15 * math.sin(kk * 2.3 + i))
    for k in range(4):
        fbox(mb, (-0.35, 0, -0.25), (0.35, 0.08, 0.25), MK.MS('cardboard'), faces='+x-x+y+z-z',
             M=mat_trs((r.uniform(-2.4, -1.0), 0.02 + k * 0.08, r.uniform(1.4, 2.0)), (0, r.uniform(0, 3), 0)))
    tint(mb, ground_ao(0.6, 0.65))
    return mb


# ====================================================================== garage row
def garage_row(name='garage_row', seed=380):
    """Row of six GSK garages (20 x 6 m): silicate / red brick walls (one rendered + painted), felt-covered slab roof
    falling to the back with a drip edge and patches, concrete lintels, mixed gates (old painted swing gates with
    hasp + padlock and numbers, newer galvanised roll-up doors with a box), two open (dark interiors, shelving,
    a car tyre stack), one burnt out (blistered leaves, one fallen, soot, cracked sagging slab), a satellite dish and
    a stove-pipe flue, gutter on the back, downpipe, weeds along the front."""
    mb = TMB(name); r = rng(seed)
    n, gw, D = 6, 3.3, 6.0
    L = n * gw; Hf, Hb = 2.75, 2.45
    x0 = -L / 2
    opened = {1: (1.75, 1.9), 4: (2.2, 0.8)}
    burnt = 3
    kinds = {0: 'swing', 1: 'swing', 2: 'roll', 3: 'swing', 4: 'swing', 5: 'roll'}
    bricks = ['brick_white', 'brick_white', 'brick_red', 'brick_white', 'brick_white', 'brick_red']
    soot_pts = []
    M, Lw = edge_frame((x0, D / 2), (x0 + L, D / 2))
    for i in range(n):
        a, b = i * gw, (i + 1) * gw
        wall(mb, [(a, 0), (b, 0), (b, Hf), (a, Hf)], 0.3, bricks[i], (1.0, 1.0), holes=[(a + 0.35, 0.0, b - 0.35, 2.25)], M=M,
             back='interior_dark', side=bricks[i], cap='none')
        tbox(mb, (a + 0.25, 2.25, -0.3), (b - 0.25, 2.45, 0.02), 'concrete', (1.5, 0.3), M=M, faces='+z-y')      # lintel
    for (a, b, h0, h1) in (((x0 + L, D / 2), (x0 + L, -D / 2), Hf, Hb), ((x0, -D / 2), (x0, D / 2), Hb, Hf), ((x0 + L, -D / 2), (x0, -D / 2), Hb, Hb)):
        Mw, Lw2 = edge_frame(a, b)
        wall(mb, [(0, 0), (Lw2, 0), (Lw2, h1), (0, h0)], 0.3, 'brick_white', (1.0, 1.0), M=Mw, back=False, side='brick_white', cap='none')
    for i in range(1, n):
        x = x0 + i * gw
        tquad(mb, (x - 0.06, 0, D / 2 - 0.3), (0, 0, -1), (0, 1, 0), D - 0.6, 2.4, 'interior_dark', (3, 2.5))
        tquad(mb, (x + 0.06, 0, -D / 2 + 0.3), (0, 0, 1), (0, 1, 0), D - 0.6, 2.4, 'interior_dark', (3, 2.5))
    tquad(mb, (x0 + 0.3, 0.02, D / 2 - 0.3), (1, 0, 0), (0, 0, -1), L - 0.6, D - 0.6, 'interior_dark', (3, 3))
    tquad(mb, (x0 + 0.3, 0, -D / 2 + 0.3), (1, 0, 0), (0, 1, 0), L - 0.6, Hb - 0.1, 'interior_dark', (3, 2.5))
    swing_l = RS('gar_door', 0, 0, 0.25, 1); swing_r = RS('gar_door', 0.25, 0, 0.5, 1); roll = RS('gar_door', 0.5, 0, 1, 1)
    for i in range(n):
        gx0 = i * gw + 0.35; gwid = gw - 0.7
        if i in opened:
            for s, ang in ((0, opened[i][0]), (1, opened[i][1])):
                hx = gx0 if s == 0 else gx0 + gwid
                Mg = M @ rot_axis((0, 1, 0), ang if s == 0 else -ang, origin=(hx, 0, 0.02))
                tquad(mb, (gx0 if s == 0 else gx0 + gwid / 2, 0.02, 0.02), (1, 0, 0), (0, 1, 0), gwid / 2, 2.2, swing_l if s == 0 else swing_r, (gwid / 2, 2.2), M=Mg, double=True)
            # contents: shelving + tyre stack
            xi = x0 + i * gw
            tbox(mb, (xi + 0.3, 0, -D / 2 + 0.35), (xi + gw - 0.3, 1.8, -D / 2 + 0.75), 'interior_burnt', (2, 1.8), faces='+z+y+x-x')
            for k in range(4):
                lathe(mb, [(0.18, 0), (0.31, 0.02), (0.31, 0.18), (0.18, 0.2)], 10, 'tyre_car', M=T(xi + 0.7, k * 0.2 + 0.02, D / 2 - 1.2))
        elif i == burnt:
            tquad(mb, (gx0, 0.02, -0.08), (1, 0, 0), (0, 1, 0), gwid / 2, 2.2, RS('garage_burnt', 0, 0, 0.5, 1), (gwid / 2, 2.2), M=M @ rot_axis((0, 1, 0), 0.35, origin=(gx0, 0, 0)), double=True)
            Mf = M @ mat_trs((gx0 + gwid * 0.8, 0.05, 1.3), (-PI / 2 + 0.06, 0.3, 0))
            tquad(mb, (-gwid / 4, 0, 0), (1, 0, 0), (0, 1, 0), gwid / 2, 2.2, RS('garage_burnt', 0.5, 0, 1, 1), (gwid / 2, 2.2), M=Mf, double=True)
            soot_pts.append(xform(np.array([[gx0 + gwid / 2, 2.2, 0.1]]), M)[0])
        elif kinds[i] == 'roll':
            tquad(mb, (gx0, 0.0, -0.1), (1, 0, 0), (0, 1, 0), gwid, 2.25, roll, (gwid, 2.25), M=M)
            tbox(mb, (gx0 - 0.05, 2.25, 0), (gx0 + gwid + 0.05, 2.5, 0.25), YD('shutter_box'), (gwid, 0.25), M=M, faces='+z+y-y+x-x')
        else:
            tquad(mb, (gx0, 0.0, -0.1), (1, 0, 0), (0, 1, 0), gwid / 2, 2.25, swing_l, (gwid / 2, 2.25), M=M)
            tquad(mb, (gx0 + gwid / 2, 0.0, -0.1), (1, 0, 0), (0, 1, 0), gwid / 2, 2.25, swing_r, (gwid / 2, 2.25), M=M)
            tbox(mb, (gx0 + gwid / 2 - 0.05, 1.05, -0.1), (gx0 + gwid / 2 + 0.05, 1.2, -0.03), YD('padlock'), M=M, faces='+z+x-x+y-y')
        if i != burnt:
            tquad(mb, (gx0 + gwid + 0.06, 1.7, 0.01), (1, 0, 0), (0, 1, 0), 0.2, 0.2, YD('num'), (0.2, 0.2), M=M)
    # roof slabs: felt top, concrete edge + drip strip, burnt one cracked and sagging (explicit triangles)
    felt = G.R['roof_felt']; so = G.R['soot']
    for i in range(n):
        xa, xb = x0 + i * gw - (0.25 if i == 0 else 0), x0 + (i + 1) * gw + (0.25 if i == n - 1 else 0)
        P = lambda x, z, dy=0.0: (x, Hb + (Hf - Hb) * (z + D / 2) / D + 0.12 + dy, z)
        if i == burnt:
            zc = 0.4
            for (za, zb_, da, db) in ((-D / 2 - 0.1, zc, 0.0, -0.55), (zc, D / 2 + 0.25, -0.55, 0.0)):
                Q = np.array([P(xa, zb_, db), P(xb, zb_, db), P(xb, za, da), P(xa, za, da)])
                mb.poly(Q, Fit(felt, (2, 2), i)); mb.poly(Q[::-1], Fit(so, (2, 2), i))
        else:
            Q = [P(xa, D / 2 + 0.25), P(xb, D / 2 + 0.25), P(xb, -D / 2 - 0.1), P(xa, -D / 2 - 0.1)]
            mb.poly(Q, Fit(felt, (2.0, 2.0), i))
        tquad(mb, (xa, Hf, D / 2 + 0.25), (1, 0, 0), (0, 1, 0), xb - xa, 0.12, 'concrete', (3, 1))
        tquad(mb, (xa, Hf + 0.1, D / 2 + 0.27), (1, 0, 0), (0, 1, 0), xb - xa, 0.08, 'steel_galv', (3, 1))
    # gutter + downpipe at the back, dish, flue, weeds
    G.tube(mb, [(x0 - 0.2, Hb + 0.05, -D / 2 - 0.2), (x0 + L + 0.2, Hb + 0.0, -D / 2 - 0.2)], 0.06, 6, 'steel_galv', seg=4)
    cyl(mb, (x0 + L + 0.1, Hb, -D / 2 - 0.2), (x0 + L + 0.1, 0.1, -D / 2 - 0.2), 0.05, 6, 'steel_galv', seg=3)
    dish = T(x0 + 5.5 * gw - 1.0, Hb + 0.9, -1.5) @ rot_axis((0, 1, 0), 0.6) @ rot_axis((1, 0, 0), -0.6)
    lathe(mb, [(0.0, 0.08), (0.3, 0.04), (0.42, 0.0)], 10, 'paint_white' if 'paint_white' in G.R else 'steel_galv', M=dish)
    cyl(mb, (x0 + 5.5 * gw - 1.0, Hb + 0.4, -1.5), (x0 + 5.5 * gw - 1.0, Hb + 0.9, -1.5), 0.025, 4, 'steel_dark')
    cyl(mb, (x0 + 0.5 * gw, Hb + 0.2, -1.8), (x0 + 0.5 * gw, Hb + 1.2, -1.8), 0.07, 6, 'steel_rust', seg=3)
    lathe(mb, [(0.0, 1.32), (0.16, 1.22), (0.17, 1.2)], 6, 'steel_rust', M=T(x0 + 0.5 * gw, Hb, -1.8))
    for i in range(n + 1):
        xx = x0 + i * gw
        G.quad(mb, [(xx - 0.3, 0.0, D / 2 + 0.02), (xx + 0.3, 0.0, D / 2 + 0.02), (xx + 0.3, 0.35, D / 2 + 0.03), (xx - 0.3, 0.35, D / 2 + 0.03)], YD('grass_edge'), double=True)
    tquad(mb, (x0 + burnt * gw + 0.1, 0.03, D / 2 - 0.35), (1, 0, 0), (0, 0, -1), gw - 0.2, D - 0.7, 'ash', (2, 2))
    tint(mb, ground_ao(0.8, 0.6))
    for p in soot_pts:
        tint(mb, soot_blob(p, 1.4, 0.12, up=2.0))
    return mb


# ====================================================================== pharmacy pavilion extras
def kiosk_extras(mb, burnt=False, seed=0):
    """Details added to the 6 x 4 m pavilion: split-AC unit on a side bracket, lit 'АПТЕКА' box over the door,
    door handle bar, roller-shutter box, entrance step with anti-slip tiles, ash bin, notice sheet; burnt: the box
    blackened and hanging, AC melted, debris."""
    W, D, H = 6.0, 4.0, 3.1
    if not burnt:
        fbox(mb, (W / 2 + 0.02, 1.9, -1.2), (W / 2 + 0.32, 2.5, -0.35), YD('ac'), faces='+x', M=None)
        fbox(mb, (W / 2 + 0.02, 1.9, -1.2), (W / 2 + 0.32, 2.5, -0.35), 'paint_white' if 'paint_white' in G.R else 'steel_galv', faces='+y-y+z-z')
        G.tube(mb, [(W / 2 + 0.05, 1.95, -0.4), (W / 2 + 0.05, 0.4, -0.4)], 0.02, 4, 'steel_dark', seg=4)
        fbox(mb, (-1.0, 2.62, D / 2 + 0.02), (1.0, 3.0, D / 2 + 0.2), YD('kiosk_sign'), faces='+z')
        fbox(mb, (-1.0, 2.62, D / 2 + 0.02), (1.0, 3.0, D / 2 + 0.2), 'steel_dark', faces='+x-x+y-y')
        tbox(mb, (-0.55, 2.42, D / 2), (0.55, 2.6, D / 2 + 0.2), YD('shutter_box'), (1.1, 0.2), faces='+z-y+x-x')
        cyl(mb, (0.3, 0.9, D / 2 + 0.06), (0.3, 1.6, D / 2 + 0.06), 0.015, 5, 'steel_galv')
        fbox(mb, (-0.2, 0.9, D / 2 + 0.005), (0.2, 1.4, D / 2 + 0.01), YD('notice'), faces='+z')
    else:
        fbox(mb, (W / 2 + 0.02, 1.7, -1.2), (W / 2 + 0.32, 2.3, -0.35), 'soot', faces='+x+y-y+z-z', M=rot_axis((1, 0, 0), 0.3, origin=(W / 2, 2.3, -0.8)))
        fbox(mb, (-1.0, 2.62, D / 2 + 0.02), (1.0, 3.0, D / 2 + 0.2), 'soot', faces='+z+x-x+y-y', M=rot_axis((0, 0, 1), 0.25, origin=(1.0, 3.0, 0)))
        r = rng(seed + 7)
        for k in range(6):
            chunk(mb, (r.uniform(-3, 3), 0.1, D / 2 + r.uniform(0.3, 1.2)), (0.4, 0.06, 0.3), seed + 40 + k, 'sandwich_burnt' if k % 2 else 'soot')
    tbox(mb, (-0.8, 0, D / 2 + 0.1), (0.8, 0.15, D / 2 + 0.6), YD('tile') if not burnt else 'concrete', (0.5, 0.5), faces='+y+z+x-x')
    lathe(mb, [(0.0, 0.05), (0.16, 0.05), (0.18, 0.62), (0.16, 0.65)], 8, YD('ash_bin') if not burnt else 'soot', M=T(1.2, 0, D / 2 + 0.45))
