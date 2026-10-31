"""Damage-variant wall pieces for panel_kit.glb: <type>_holed_v2/_v3, <type>_destroyed_v2/_v3 for every wall type
(large panel wall_*, brick_*, brick_red_*, wall_shopfront*). Designs (outlines) in kit_damage_design.py, facade cells
in kit_damage_atlas.py (material index 2 = kit_damage; 0 = kit_panel, 1 = kit_city).

Same frame / pivot contract as the existing pieces: x 0..W, y 0..H, z 0 (outside face) .. -T; the game normalises
every damage state with the offset of <type>_intact (bbox minX=0, minY=0, maxZ=0), so variants may protrude.

Structure of the pieces
  holed     the remaining wall is extruded through the real layer depths (panel: tile skin / outer concrete /
            mineral wool / inner concrete, the broken edges step back at the insulation; brick: stepped courses),
            exposed rebar mesh cut at the broken edges (bent in for outside hits, out for interior blasts), mesh
            flaps, wool tufts, spalled face (outer layer gone, wool exposed / outer wythe gone), through-crack with
            the split-off piece displaced, joinery remnants in merged openings, chunks on the lower lip, rags.
  destroyed blown-out panel framed by structure: ceiling-slab edge band at the top (spalled front edge, torn bottom
            bars and panel ties hanging), ragged lintel band and kerb remnants, side remnant columns tied by bent
            bars, transverse wall ends with wallpapered room faces (panels), floor screed with debris, a panel
            fragment hanging on its rebar, radiators / door leaves / balcony stubs per type.
"""
import math
import numpy as np
from shapely.geometry import Point, Polygon
from shapely.geometry.polygon import orient
from shapely.prepared import prep
from meshlib import MB, Region, Fit, Proj, slab, side_uv, rng, noise1d, newell, xform, mat_trs, rot_axis, cw, ccw, \
    seg_intersections, point_in_poly
from kit_design import W, H, T, CHAMFER, LAYER_OUT, LAYER_INS, OPEN
from kitparts import R, rebar_bar, chunk, cloth, frame_box, sash, shards, window_unit, balcony_door_unit, \
    entrance_door_unit, radiator, len_uv
import kit_damage_design as KD
import kit_damage_atlas as KDA

M0, M1, M2 = 0, 1, 2
# broken-edge levels: face spall bevel -> outer concrete -> step into the mineral wool (recessed, slanting back out to
# the inner leaf) -> inner concrete -> room-side spall
LV_P = [0.0, -LAYER_OUT, -LAYER_OUT - 0.008, -LAYER_INS, -T]
_PB = [0.085, 0.035, 0.07, 0.04, 0.075]
_PA = [0.055, 0.03, 0.035, 0.03, 0.05]
LV_BR = [0.0, -0.1, -0.2, -T]
SLAB_T = 0.232


def R2():
    from kit_city_parts import R2 as _R2
    return _R2


# ------------------------------------------------------------------ ring classification / offsets
def _on_rect(x, y, rc, tol=2e-3):
    x0, y0, x1, y1 = rc
    if not (x0 - tol <= x <= x1 + tol and y0 - tol <= y <= y1 + tol):
        return False
    return min(abs(x - x0), abs(x - x1), abs(y - y0), abs(y - y1)) < tol


def _on_border(x, y, tol=2e-3):
    return min(abs(x), abs(x - W), abs(y), abs(y - H)) < tol


def classify(P, rects):
    c = []
    for x, y in P:
        if _on_border(x, y):
            c.append('B')
        elif any(_on_rect(x, y, rc) for rc in rects):
            c.append('R')
        else:
            c.append('X')
    n = len(P); e = []
    for i in range(n):
        a, b = c[i], c[(i + 1) % n]
        m = (P[i] + P[(i + 1) % n]) / 2
        if 'X' in (a, b):
            e.append('X')
        elif a == 'B' and b == 'B':
            e.append('B' if _on_border(*m) else 'X')
        elif 'R' in (a, b):
            e.append('R' if any(_on_rect(*m, rc) for rc in rects) or _on_border(*m) else 'X')
        else:
            e.append('B')
    return c, e


def panel_off(n, seed, vcls, ch_b=CHAMFER, ch_r=0.015):
    r = rng(seed)
    sm = [noise1d(n, seed + k, 3) for k in range(len(LV_P))]
    jit = r.normal(0, 1, (len(LV_P), n)); dz = r.normal(0, 0.004, (len(LV_P), n))

    def f(k, i):
        c = vcls[i]
        if c == 'B':
            return (ch_b, 0.0) if k == 0 else (0.0, 0.0)
        if c == 'R':
            return (ch_r, 0.0) if k == 0 else (0.0, 0.0)
        d = _PB[k] + _PA[k] * (0.9 * sm[k][i] + 0.25 * jit[k][i])
        return (max(d, -0.01), 0.0 if k in (0, len(LV_P) - 1) else dz[k][i])
    return f


def brick_off2(n, seed, vcls):
    from kit_city_parts import brick_off
    f0 = brick_off(n, seed, np.array([c == 'X' for c in vcls]), 4)
    return f0


# ------------------------------------------------------------------ wall body
class Ctx:
    def __init__(self, prefix, state, v):
        self.d = d = KD.design(prefix, state, v)
        self.prefix, self.state, self.v = prefix, state, v
        self.fam, self.t, self.colour = d['fam'], d['t'], d['colour']
        self.rects = [rc for _, rc in d['openings']]
        self.r = rng(d['seed']); self.s = d['seed']
        self.fac = Proj(KDA.cell_region(prefix, state, v), (1, 0, 0), (0, 1, 0), (0, 0), (W, H))
        self.back = Proj(R['interior'], (1, 0, 0), (0, 1, 0), (0, 0), (W, H))
        self.levels = LV_P if self.fam == 'panel' else LV_BR
        self.solid = d['solid']
        self.psolid = prep(d['solid'].buffer(0.004))
        self.rings = []          # (ring Nx3 at a level, edge class list, level index) for rebar
        self.frag_mat = M0


def side_fns(ctx):
    """(uv function, material) per edge class for the current family."""
    if ctx.fam == 'panel':
        sect = side_uv(R['section'], 2.0); rev = side_uv(R['concrete'], 2.0)
        return {'X': (sect, M0), 'B': (rev, M0), 'R': (rev, M0)}
    R2_ = R2()
    sec = side_uv(R2_['brick_sec_' + (ctx.colour or 'white')], 2.0)
    if ctx.fam == 'brick':
        return {'X': (sec, M1), 'B': (side_uv(R2_['brick_' + ctx.colour], 1.0), M1), 'R': (side_uv(R2_['reveal'], 1.0), M1)}
    return {'X': (sec, M1), 'B': (side_uv(R2_['reveal'], 1.0), M1), 'R': (side_uv(R2_['tile_granite'], 1.0), M1)}


def extrude_poly(ctx, poly, seed, fac=None, levels=None):
    """Extrude one shapely Polygon of the wall through the layer depths -> MB (materials assigned)."""
    poly = orient(poly.simplify(0.011 if ctx.fam == 'panel' else 0.006, preserve_topology=True), 1.0)
    loops_xy = [np.array(poly.exterior.coords)[:-1]] + [np.array(i.coords)[:-1] for i in poly.interiors]
    levels = levels or ctx.levels
    loops, ecls_all = [], []
    for li, P in enumerate(loops_xy):
        vc, ec = classify(P, ctx.rects)
        off = panel_off(len(P), seed + li * 17, vc) if (ctx.fam == 'panel' and len(levels) == len(LV_P)) else \
            (brick_off2(len(P), seed + li * 17, vc) if len(levels) == 4 and ctx.fam != 'panel' else panel_off_short(len(P), seed + li * 17, vc, len(levels)))
        loops.append({'pts': P, 'off': off}); ecls_all.append(ec)
    fns = side_fns(ctx)
    fac = fac or ctx.fac
    mats = []
    facemap = fac

    def side(a, b, fa, fb, li, k, P, i):
        ec = ecls_all[li][i]
        if ec in ('B', 'R') and k == 0 and ctx.fam == 'panel':
            mats.append(M2 if fac is ctx.fac else ctx.frag_mat); return facemap(P, np.array([0, 0, 1.0]))
        fn, m = fns[ec]
        mats.append(m)
        return fn(a, b, fa, fb, li)
    tmp = MB()
    rings = slab(tmp, loops, levels, fac, ctx.back, side)
    ns = len(mats); nf = len(tmp.F) - ns
    z0, zb = levels[0], levels[-1]
    front_mat = M2 if fac is ctx.fac else ctx.frag_mat
    for idx in range(len(tmp.F)):
        vi, uv, sm, mt = tmp.F[idx]
        if idx >= nf:
            mt = mats[idx - nf]
        else:
            Pz = np.array([tmp.V[j][2] for j in vi])
            mt = front_mat if np.all(np.abs(Pz - z0) < 0.02) and np.mean(Pz) > zb / 2 else M0
        tmp.F[idx] = (vi, uv, sm, mt)
    return tmp, rings, ecls_all


def panel_off_short(n, seed, vcls, nl):
    """Offsets for short (fragment) level sets: [0, -LAYER_OUT, -LAYER_INS, -T]."""
    r = rng(seed)
    sm = [noise1d(n, seed + k, 3) for k in range(nl)]
    base = [0.06, 0.03, 0.03, 0.05][:nl]

    def f(k, i):
        if vcls[i] != 'X':
            return (0.0, 0.0)
        return (max(base[k] + 0.03 * sm[k][i], 0.0), 0.0)
    return f


def build_body(ctx, mb):
    """Extrude all remaining pieces of the wall; displaced crack piece; collect rings for rebar."""
    pieces = KD.polys_of(ctx.solid)
    crack = ctx.d['crack']
    for pi, poly in enumerate(pieces):
        tmp, rings, ecls = extrude_poly(ctx, poly, ctx.s + 100 + pi * 7)
        M = None
        if crack is not None and crack.get('move') == pi:
            c = poly.centroid
            M = mat_trs((0.0, -0.012, 0.022)) @ rot_axis((0, 0, 1), ctx.r.choice([-1, 1]) * 0.012, origin=(c.x, c.y, 0)) @ \
                rot_axis((1, 0, 0), -0.015, origin=(c.x, c.y, -T))
        mb.merge(tmp, M)
        for li, rr in enumerate(rings):
            ctx.rings.append((rr, ecls[li], M))


# ------------------------------------------------------------------ rebar / wool / chunks
def edge_bars(ctx, mb, nmax, bend=-0.6, spacing=0.2, layers=None, seed=0):
    """Rebar cut at broken edges: grid lines (panel mesh / brick bed-joint wire) crossing broken ring edges."""
    r = rng(ctx.s + seed)
    fam = ctx.fam
    if layers is None:
        layers = [(1, -0.04), (3, -0.245)] if fam == 'panel' else [(1, -0.15)]
    cands = []
    for ring_levels, ecls, M in ctx.rings:
        for (lvl, z) in layers:
            ring = ring_levels[min(lvl, len(ring_levels) - 1)][:, :2]
            n = len(ring)
            if fam == 'panel':
                lines = [((x, 0.03), (x, H - 0.03), (0, 1)) for x in np.arange(spacing, W - 0.01, spacing)] + \
                        [((0.03, y), (W - 0.03, y), (1, 0)) for y in np.arange(spacing, H - 0.01, spacing)]
            else:
                from city_kit_design import COURSE
                lines = [((0.02, j * COURSE + 0.001), (W - 0.02, j * COURSE + 0.001), (1, 0)) for j in range(5, 36, 5)]
            for a, b, d in lines:
                for t_, p, ei in seg_intersections(ring, a, b):
                    if ecls[ei] != 'X':
                        continue
                    d = np.array(d, float)
                    fw, bw = p + d * 0.06, p - d * 0.06
                    sf, sb = ctx.psolid.contains(Point(*fw)), ctx.psolid.contains(Point(*bw))
                    if sf == sb:
                        continue
                    cands.append((np.array([p[0], p[1], z]), d if sb else -d, M))
    r.shuffle(cands)
    for p3, dv, M in cands[:nmax]:
        if fam == 'panel':
            L = r.uniform(0.12, 0.5)
            out = np.array([0, 0, 1.0]) * (bend if p3[2] > -0.15 else -0.5 * bend)
            droop = np.array([0, -1.0, 0]) * (r.uniform(0.2, 0.8) if abs(dv[0]) > 0.5 else 0.1)
            side = np.array([-dv[1], dv[0], 0]) * r.normal(0, 0.35)
            bd = out + droop + side + np.array([0, 0, r.normal(0, 0.25)]); bd /= np.linalg.norm(bd) + 1e-9
            d3 = np.array([dv[0], dv[1], 0.0]); k = r.uniform(0.3, 0.9)
            pts = [p3 - d3 * 0.04, p3 + d3 * L * 0.25, p3 + d3 * L * 0.6 + bd * L * 0.25 * k, p3 + d3 * L * (1 - 0.3 * k) + bd * L * 0.7 * k]
            rad = 0.0085
        else:
            L = r.uniform(0.1, 0.3)
            d3 = np.array([dv[0], dv[1], 0.0]); bd = np.array([0, -0.35, r.uniform(0.1, 0.7) * np.sign(bend + 1e-9)])
            pts = [p3 - d3 * 0.03, p3 + d3 * L * 0.45, p3 + d3 * L * 0.85 + bd * L * 0.5]
            rad = 0.004
        if M is not None:
            pts = xform(np.array(pts), M)
        rebar_bar(mb, pts, rad=rad)


def mesh_flap(mb, p, dv, out, seed, n=3, size=0.42):
    """Welded mesh torn out of the broken edge and bent: n x n bars curving away from p along dv and out of plane."""
    r = rng(seed)
    p = np.asarray(p, float); dv = np.array([dv[0], dv[1], 0.0]); dv /= np.linalg.norm(dv) + 1e-9
    sd = np.array([-dv[1], dv[0], 0.0])
    zc = np.array([0, 0, 1.0]) * out
    curl = r.uniform(0.9, 1.6)

    def pos(a, b):   # a along dv (0..1), b across (-0.5..0.5)
        ang = curl * a
        return p + dv * size * math.sin(ang) / curl + zc * size * (1 - math.cos(ang)) / curl + sd * b * size + \
            np.array([0, -1, 0]) * 0.12 * a * a + r.normal(0, 0.006, 3)
    for b in np.linspace(-0.5, 0.5, n):
        rebar_bar(mb, [pos(a, b) for a in np.linspace(-0.05, 1.0, 5)], rad=0.006)
    for a in np.linspace(0.3, 1.0, n - 1):
        rebar_bar(mb, [pos(a, b) for b in np.linspace(-0.55, 0.55, 3)], rad=0.006)


def wool_tuft(mb, p, dv, seed, size=0.16):
    """Torn mineral-wool lump hanging out of the insulation layer at a broken edge (bent double-sided ribbon)."""
    r = rng(seed)
    p = np.asarray(p, float); dv = np.array([dv[0], dv[1], 0.0]); dv /= np.linalg.norm(dv) + 1e-9
    sd = np.array([-dv[1], dv[0], 0.0])
    rows = []
    for i in range(3):
        t = i / 2
        c = p + dv * size * t * 0.8 + np.array([0, -0.06, 0.03]) * t * t + r.normal(0, 0.01, 3)
        rows.append([c + sd * size * (j - 0.5) * (0.9 - 0.3 * t) for j in (0, 0.5, 1)])
    reg = R['insulation']
    mb.ribbon(rows, lambda s, t: reg.uv(s, t), double=True, smooth=True)


def broken_edge_points(ctx, lvl=3, cls='X'):
    """(point xy, outward-into-void direction) samples along broken ring edges at a level."""
    out = []
    for ring_levels, ecls, M in ctx.rings:
        if M is not None:
            continue
        ring = ring_levels[min(lvl, len(ring_levels) - 1)][:, :2]
        n = len(ring)
        for i in range(n):
            if ecls[i] != cls:
                continue
            a, b = ring[i], ring[(i + 1) % n]
            m = (a + b) / 2; d = b - a; L = np.linalg.norm(d)
            if L < 1e-4:
                continue
            nr = np.array([d[1], -d[0]]) / L      # right of travel = away from solid (solid on the left)
            out.append((m, nr, L))
    return out


def scatter_lip_chunks(ctx, mb, n, region='section'):
    pts = [(m, nr) for m, nr, L in broken_edge_points(ctx, 0) if nr[1] > 0.6 and 0.05 < m[1] < H - 0.3]
    r = ctx.r
    for k in range(min(n, len(pts))):
        m, nr = pts[r.integers(0, len(pts))]
        sz = r.uniform(0.08, 0.2)
        if ctx.fam == 'panel':
            chunk(mb, (m[0] + r.normal(0, 0.04), m[1] + sz * 0.3, -r.uniform(0.08, 0.24)), (sz, sz * 0.55, sz * 0.8), ctx.s + 300 + k, region=region)
        else:
            from kit_city_parts import loose_brick
            loose_brick(mb, (m[0] + r.normal(0, 0.05), m[1] + 0.035, -r.uniform(0.05, 0.25)), (r.uniform(-0.3, 0.3), r.uniform(0, 3), 0), ctx.colour or 'white', ctx.s + 300 + k)


def floor_debris(ctx, mb, n, zr=(-1.25, -0.45)):
    r = ctx.r
    if ctx.fam != 'panel':
        n = max(1, n // 2)
    for k in range(n):
        sz = r.uniform(0.15, 0.42)
        x, z = r.uniform(0.35, W - 0.35), r.uniform(*zr)
        if ctx.fam == 'panel':
            chunk(mb, (x, sz * 0.2, z), (sz, sz * 0.42, sz * 0.8), ctx.s + 400 + k, region='section_clean' if k % 2 else 'section')
        else:
            from kit_city_parts import chunk2
            chunk2(mb, (x, sz * 0.2, z), (sz, sz * 0.4, sz * 0.7), ctx.s + 400 + k, 'brick_sec_' + (ctx.colour or 'white'))
    if ctx.fam != 'panel':
        from kit_city_parts import brick_heap
        brick_heap(mb, r.uniform(0.8, 2.4), -T - 0.6, 0.6, 8, ctx.colour or 'white', ctx.s + 450)


# ------------------------------------------------------------------ spalls (partial-depth damage)
def spall_plug(ctx, mb, sp):
    """Fill a spall hole behind the lost outer layer: panel -> wool face at the insulation depth with the inner
    leaf behind; brick -> inner wythe face 0.12 m back. Rebar of the outer layer bridges / dangles across."""
    poly = orient(sp.simplify(0.006), 1.0)
    P = np.array(poly.exterior.coords)[:-1]
    n = len(P)
    if ctx.fam == 'panel':
        zf = -LAYER_OUT - 0.012
        wool = Fit(R['insulation'], (0.5, 0.5), ctx.s)
        tmp = MB()
        loop = {'pts': P, 'off': lambda k, i: (0.0, 0.0)}
        slab(tmp, [loop], [zf, -T + 0.002], wool, ctx.back, side_uv(R['section_clean'], 2.0))
        mb.merge(tmp)
        # outer mesh bars across the spall, bulging outwards; a couple of torn ones
        r = ctx.r
        x0, y0, x1, y1 = sp.bounds
        for x in np.arange(np.ceil(x0 / 0.2) * 0.2, x1, 0.2):
            hits = seg_intersections(P, (x, y0 - 0.1), (x, y1 + 0.1))
            if len(hits) >= 2:
                a, b = hits[0][1], hits[-1][1]
                if r.random() < 0.7:
                    ys = np.linspace(a[1] - 0.03, b[1] + 0.03, 5)
                    bul = r.uniform(0.0, 0.06)
                    rebar_bar(mb, [(x + r.normal(0, 0.006), y, -0.04 + bul * math.sin(np.pi * (y - ys[0]) / (ys[-1] - ys[0]))) for y in ys], rad=0.006)
        for y in np.arange(np.ceil(y0 / 0.2) * 0.2, y1, 0.2):
            hits = seg_intersections(P, (x0 - 0.1, y), (x1 + 0.1, y))
            if len(hits) >= 2 and r.random() < 0.6:
                a, b = hits[0][1], hits[-1][1]
                xs = np.linspace(a[0] - 0.03, b[0] + 0.03, 5)
                rebar_bar(mb, [(x, y + r.normal(0, 0.006), -0.045 + 0.04 * math.sin(np.pi * (x - xs[0]) / (xs[-1] - xs[0]))) for x in xs], rad=0.006)
        c = sp.centroid
        wool_tuft(mb, (c.x + 0.05, c.y - 0.02, zf + 0.01), (0.2, -1.0), ctx.s + 7, 0.13)
    else:
        R2_ = R2()
        face = Proj(R2_['brick_' + (ctx.colour or 'white')], (1, 0, 0), (0, 1, 0), (0, 0), (1.0, 1.0))
        tmp = MB()
        loop = {'pts': P, 'off': lambda k, i: (0.0, 0.0)}
        # tile the 1 m brick region: map in 1 m windows
        x0, y0, _, _ = sp.bounds
        fm = lambda Q, nrm: [R2_['brick_' + (ctx.colour or 'white')].uv((q[0] - x0) % 1.0, (q[1] - y0) % 1.0) for q in Q]
        slab(tmp, [loop], [-0.12, -T + 0.002], fm, ctx.back, side_uv(R2_['brick_sec_' + (ctx.colour or 'white')], 2.0), mat=M1)
        for idx in range(len(tmp.F)):
            vi, uv, sm, mt = tmp.F[idx]
            Pz = np.array([tmp.V[j][2] for j in vi])
            tmp.F[idx] = (vi, uv, sm, M0 if np.all(Pz < -0.2) else M1)
        mb.merge(tmp)


# ------------------------------------------------------------------ joinery
def frame_remnants(ctx, mb, rc, reg, zf=-0.105, seed=0):
    """Remains of a window frame in an opening the shell hole merged with: members only along edges still in solid."""
    x0, y0, x1, y1 = rc
    sd = ctx.psolid
    fw = 0.07
    edges = [((x0, y1), (x1, y1), (0, 1)), ((x0, y0), (x0, y1), (-1, 0)), ((x1, y0), (x1, y1), (1, 0)), ((x0, y0), (x1, y0), (0, -1))]
    kept = []
    for ei, (a, b, nrm) in enumerate(edges):
        a, b = np.array(a, float), np.array(b, float)
        ts = np.linspace(0, 1, 9)
        ok = [sd.contains(Point(*(a + (b - a) * t + np.array(nrm) * 0.05))) for t in ts]
        runs, cur = [], None
        for t, o in zip(ts, ok):
            if o and cur is None:
                cur = [t, t]
            elif o:
                cur[1] = t
            elif cur is not None:
                runs.append(cur); cur = None
        if cur is not None:
            runs.append(cur)
        for t0, t1 in runs:
            if t1 - t0 < 0.2:
                continue
            p0, p1 = a + (b - a) * t0, a + (b - a) * t1
            if ei in (0, 3):
                yy = (p0[1] - fw, p0[1]) if ei == 0 else (p0[1], p0[1] + fw)
                frame_box(mb, (p0[0], yy[0], zf - 0.07), (p1[0], yy[1], zf), '+z' + ('-y' if ei == 0 else '+y'), reg, seed + ei)
            else:
                xx = (p0[0], p0[0] + fw) if ei == 1 else (p0[0] - fw, p0[0])
                frame_box(mb, (xx[0], p0[1], zf - 0.07), (xx[1], p1[1], zf), '+z' + ('+x' if ei == 1 else '-x'), reg, seed + ei)
            kept.append(ei)
    if 0 in kept and 1 in kept:
        xm = x0 + (x1 - x0) * 0.47
        sash(mb, x0 + fw, y1 - 0.4, xm - 0.035, y1 - fw, zf + 0.012, reg, glass='shards', seed=seed + 9)
    elif 0 in kept and 2 in kept:
        sash(mb, x1 - 0.55, y1 - 0.4, x1 - fw, y1 - fw, zf + 0.012, reg, glass='shards', seed=seed + 9)


def joinery(ctx, mb, merged_kinds_rects, remaining):
    fam, t = ctx.fam, ctx.t
    s = ctx.s
    if fam == 'shop':
        from kit_city_parts import shop_door, display_window
        for kind, rc in remaining:
            if kind == 'shopdoor':
                shop_door(mb, rc, 'damaged', s + 1)
            elif kind == 'display':
                display_window(mb, rc, 'damaged', s + 2)
        for kind, rc in merged_kinds_rects:
            if kind == 'shopdoor':
                shop_door(mb, rc, 'holed', s + 1)
            elif kind == 'display':
                frame_remnants(ctx, mb, rc, 'pvc', -0.07, s + 3)
            elif kind == 'shutter':
                x0, y0, x1, y1 = rc
                rows = []
                for i in range(6):
                    tt = i / 5
                    rows.append([(x0 + 0.3 + (x1 - x0 - 0.6) * sj + 0.08 * math.sin(tt * 4 + sj * 5), max(0.04, y1 - 0.25 - tt * 1.7) + 0.06 * math.sin(sj * 6),
                                  -0.06 + max(0.0, tt - 0.55) * 1.4 + 0.05 * math.sin(sj * 9)) for sj in np.linspace(0, 1, 6)])
                reg = R2()['shutter']
                mb.ribbon(rows, lambda s_, t_: reg.uv((s_ * 2.0) % 1.0001, (t_ * 1.7) % 1.0001), double=True, smooth=False, mat=M1)
        return
    zf = -0.105 if fam == 'panel' else -0.13
    wood = 'wood' if ((fam == 'panel' and t == 'wall_window') or (fam == 'brick' and t == 'window' and ctx.colour == 'white')) else 'pvc'
    for kind, rc in remaining:
        if kind == 'window':
            window_unit(mb, rc, wood, 'damaged', s + 1, zf=zf)
        elif kind == 'door':
            balcony_door_unit(mb, rc, 'pvc', 'damaged', s + 2, zf=zf)
        elif kind == 'entrance':
            entrance_door_unit(mb, rc, 'damaged', s + 3, zf=-0.08 if fam == 'panel' else -0.1)
    for kind, rc in merged_kinds_rects:
        if kind == 'window':
            frame_remnants(ctx, mb, rc, 'wood_paint' if wood == 'wood' else 'pvc', zf - 0.0, s + 4)
        elif kind == 'door':
            balcony_door_unit(mb, rc, 'pvc', 'damaged', s + 5, zf=zf)
        elif kind == 'entrance':
            entrance_door_unit(mb, rc, 'holed', s + 6, zf=-0.08 if fam == 'panel' else -0.1)


def opening_status(ctx):
    """Openings still fully framed by the wall (remaining) vs. merged into the damage."""
    remaining, merged = [], []
    for kind, rc in ctx.d['openings']:
        x0, y0, x1, y1 = rc
        probe = [(x0 - 0.05, (y0 + y1) / 2), (x1 + 0.05, (y0 + y1) / 2), ((x0 + x1) / 2, y1 + 0.05)]
        if y0 > 0.1:
            probe.append(((x0 + x1) / 2, y0 - 0.05))
        ok = all(ctx.psolid.contains(Point(*p)) for p in probe if 0 < p[0] < W and 0 < p[1] < H)
        (remaining if ok else merged).append((kind, rc))
    return remaining, merged


# ------------------------------------------------------------------ destroyed structure
def ceiling_band(mb, seed, fam='panel', colour=None):
    """Edge of the ceiling slab (the floor slab of the storey above) exposed where the facade panel is gone:
    0.232 m precast slab spanning between the transverse walls, spalled ragged front edge ~5-11 cm behind the facade,
    torn bottom bars and panel tie loops hanging from it."""
    r = rng(seed)
    n = 10
    xs = np.linspace(0, W, n + 1)
    d = 0.075 + 0.03 * noise1d(n + 1, seed, 3, closed=False) + r.normal(0, 0.01, n + 1)
    outline = np.array([(x, dd) for x, dd in zip(xs, d)] + [(W, 0.45), (0, 0.45)], float)
    vb = [True] * (n + 1) + [False, False]
    vb[0] = vb[n] = False
    sm = [noise1d(len(outline), seed + k, 3) for k in range(4)]

    def off(k, i):
        if not vb[i]:
            return (0.0, 0.0)
        return (max(0.0, [0.03, 0.015, 0.01, 0.035][k] + [0.025, 0.012, 0.01, 0.03][k] * sm[k][i]), 0.0)
    top = Proj(R['floor'], (1, 0, 0), (0, 1, 0), (0, 0), (W, W))
    bot = Proj(R['ceiling'], (1, 0, 0), (0, 1, 0), (0, 0), (W, W))
    conc = side_uv(R['concrete'], 2.0)
    tmp = MB()
    slab(tmp, [{'pts': outline, 'off': off}], [0, -0.012, -0.2, -SLAB_T], top, bot, lambda a, b, fa, fb, li, k, P, i: conc(a, b, fa, fb, li))
    Htop = H + 0.004
    M = np.array([[1, 0, 0, 0], [0, 0, 1, Htop], [0, -1, 0, 0], [0, 0, 0, 1.0]])
    mb.merge(tmp, M)
    yb = Htop - SLAB_T
    # torn bottom reinforcement + tie loops of the lost panel
    for k in range(4):
        x = r.uniform(0.25, W - 0.25); z0 = -float(np.interp(x, xs, d)) - 0.03
        L = r.uniform(0.25, 0.7)
        p0 = np.array([x, yb + 0.03, z0 - 0.1]); p1 = np.array([x, yb + 0.03, z0 + 0.02])
        dr = np.array([r.normal(0, 0.12), -1.0, r.uniform(0.0, 0.5)]); dr /= np.linalg.norm(dr)
        rebar_bar(mb, [p0, p1, p1 + dr * L * 0.5 + [0, 0, 0.05], p1 + dr * L])
    for k in range(1):
        x = r.uniform(0.4, W - 0.4); z0 = -float(np.interp(x, xs, d))
        rebar_bar(mb, [(x, yb + 0.12, z0 - 0.05), (x, yb + 0.12, z0 + 0.06), (x + 0.04, yb - 0.08, z0 + 0.1), (x + 0.1, yb - 0.12, z0 + 0.03)], rad=0.007)


def cross_walls(mb, seed):
    """Ends of the transverse bearing walls at the panel joints (half thickness each side) with wallpapered room faces."""
    r = rng(seed)
    z0, z1 = -T, -1.25
    y0, y1 = 0.0, H - SLAB_T
    conc = Fit(R['section_clean'], (0.3, 0.3), seed)
    for (xa, xb, sgn) in ((0.0, 0.08, 1), (W - 0.08, W, -1)):
        mb.poly([(xa, y0, z0), (xb, y0, z0), (xb, y1, z0), (xa, y1, z0)], Fit(R['stair'], (0.15, 1.2), seed + int(xa)))
        xf = xb if sgn > 0 else xa
        P = [(xf, y0, z0), (xf, y0, z1), (xf, y1, z1), (xf, y1, z0)] if sgn > 0 else [(xf, y0, z1), (xf, y0, z0), (xf, y1, z0), (xf, y1, z1)]
        wp = R['interior']
        mb.poly(P, lambda Q, n: [wp.uv(0.05 + 0.3 * (-q[2] - 0.3), q[1] / H) for q in Q])
        # torn ties out of the wall end
        for k in range(2):
            y = r.uniform(0.4, 2.2)
            xm = (xa + xb) / 2
            rebar_bar(mb, [(xm, y, z0 - 0.06), (xm, y, z0 + 0.02), (xm + sgn * 0.12, y - 0.1, z0 + 0.12)], rad=0.007)


def door_leaf(mb, M):
    """Steel entrance door leaf (0.84 x 2.06 m) placed by M (local origin = bottom-left-front of the leaf)."""
    door = R['door']; lw, lh = 0.84, 2.06
    leaf = MB()
    leaf.box((0, 0, -0.05), (lw, lh, 0), lambda P, n: [door.uv(p[0] / lw, p[1] / lh) for p in P], faces='+z-z')
    leaf.box((0, 0, -0.05), (lw, lh, 0), Fit(R['metal_grey'], (0.3, 2.2), 1), faces='+x-x+y-y')
    mb.merge(leaf, M)


def floor_screed(mb, seed):
    """Floor finish edge (screed + linoleum) at y = 0 inside the blown-out panel; debris rests on it."""
    fl = Proj(R['floor'], (1, 0, 0), (0, 0, -1), (0, 0.3), (W, W))
    mb.poly([(0.08, 0.02, -0.05), (W - 0.08, 0.02, -0.05), (W - 0.08, 0.02, -1.2), (0.08, 0.02, -1.2)][::-1][::-1], fl)
    mb.poly([(0.08, 0.0, -0.05), (W - 0.08, 0.0, -0.05), (W - 0.08, 0.02, -0.05), (0.08, 0.02, -0.05)], Fit(R['section_clean'], (2.0, 0.1), seed))


def fragment(ctx, mb, fr):
    """Panel fragment hanging on bundles of its own bars right under the lintel band (v2) or swung out from the edge
    of the side remnant column (v3)."""
    r = rng(ctx.s + 77)
    P = np.asarray(fr['poly'], float)
    hx, hy = fr['hinge']
    sd = ctx.psolid
    if fr['side'] == 'band':          # find the band's broken lower edge above the hinge, hang the piece right below it
        y = H - 0.01
        while y > 1.2 and sd.contains(Point(hx, y)):
            y -= 0.01
        y_edge = y + 0.01
        P = P + [0, y_edge - 0.025 - P[:, 1].max()]
        piv = (hx, y_edge - 0.02)
    else:                             # find the column's broken edge at the hinge height, hang the piece from it
        sg = 1 if fr['col'] == 'R' else -1
        x = W - 0.01 if sg > 0 else 0.01
        while 0.2 < x < W - 0.2 and sd.contains(Point(x, hy)):
            x -= 0.01 * sg
        x_edge = x + 0.01 * sg
        P = P + [x_edge - 0.025 * sg - (P[:, 0].max() if sg > 0 else P[:, 0].min()), 0]
        piv = (x_edge - 0.02 * sg, hy)
    poly = Polygon(P).buffer(0).simplify(0.022)
    # facade UV: a solid part of the blank-end 'damaged' cell (pockmarked skin, no openings / band) of the same family
    if ctx.fam == 'panel':
        import kit_atlas as KA
        x0, y0, x1, y1 = KA.cell_rect('wall_blank_end', 'damaged'); reg = Region(x0, y0, x1, y1, pad=0); ctx.frag_mat = M0
    else:
        import city_kit_atlas as CA
        x0, y0, x1, y1 = CA.cell_rect(CA.cell_index_brick(ctx.colour or 'white', 'blank_end', 'damaged')); reg = Region(x0, y0, x1, y1, pad=0); ctx.frag_mat = M1
    bx0, by0, bx1, by1 = poly.bounds
    fac = Proj(reg, (1, 0, 0), (0, 1, 0), (bx0 - 0.5, by0 - 1.0), (W, H))
    levels = [0.0, -LAYER_OUT, -LAYER_INS, -T] if ctx.fam == 'panel' else [0.0, -0.12, -T]
    tmp, rings, ecls = extrude_poly(ctx, poly, ctx.s + 900, fac=fac, levels=levels)
    px, py = piv
    if fr['side'] == 'band':
        M = rot_axis((1, 0, 0), -r.uniform(0.45, 0.75), origin=(px, py, -0.04)) @ rot_axis((0, 0, 1), r.uniform(-0.2, 0.2), origin=(px, py, 0))
        att = [(px + dx, py) for dx in (-0.16, 0.0, 0.15)]
        anchor = lambda a: np.array([a[0], a[1] + 0.06, 0])
    else:
        M = rot_axis((0, 1, 0), sg * r.uniform(0.55, 0.85), origin=(px, py, -0.04)) @ rot_axis((1, 0, 0), -0.12, origin=(px, py, 0))
        att = [(px, py - dy) for dy in (-0.12, 0.05, 0.22)]
        anchor = lambda a: np.array([a[0] + 0.06 * sg, a[1], 0])
    mb.merge(tmp, M)
    # bundles of bars from the remaining wall into the fragment (outer and inner leaf mesh)
    for k, a2 in enumerate(att):
        for z in (-0.04, -0.245):
            a = anchor(a2) + [0, 0, z]
            b = xform(np.array([[a2[0], a2[1], z]]), M)[0]
            for j in range(2 if k != 1 else 3):
                off = np.array([r.normal(0, 0.02), 0, r.normal(0, 0.01)])
                mid = (a + b) / 2 + np.array([0, -0.03, 0.04 if z > -0.1 else -0.02]) + off
                rebar_bar(mb, [a + off * 0.3, mid, b + off * 0.5], rad=0.009)


# ------------------------------------------------------------------ pieces
def build_piece(prefix, state, v):
    ctx = Ctx(prefix, state, v)
    mb = MB(f'{prefix}_{state}_{v}')
    build_body(ctx, mb)
    fam, t, r, s = ctx.fam, ctx.t, ctx.r, ctx.s
    inward = (v == 'v2')        # v2: outside hit (bars bent in); v3: interior blast (bars bent out)
    if state == 'holed':
        edge_bars(ctx, mb, 12 if fam == 'panel' else 6, bend=-0.7 if inward else 0.8)
        pts = broken_edge_points(ctx, 2)
        if fam == 'panel' and pts:
            for k in range(1):
                m, nr, L = pts[r.integers(0, len(pts))]
                mesh_flap(mb, (m[0], m[1], -0.04), nr, -1.0 if inward else 1.0, s + 30 + k, size=r.uniform(0.3, 0.45))
            for k in range(3):
                m, nr, L = pts[r.integers(0, len(pts))]
                wool_tuft(mb, (m[0], m[1], -0.135), nr, s + 40 + k, r.uniform(0.1, 0.18))
        for sp in ctx.d['spalls']:
            spall_plug(ctx, mb, sp)
        remaining, merged = opening_status(ctx)
        joinery(ctx, mb, merged, remaining)
        scatter_lip_chunks(ctx, mb, 4)
        top = [(m, nr) for m, nr, L in broken_edge_points(ctx, 0) if nr[1] < -0.6]
        if top and fam != 'shop':
            m, nr = top[r.integers(0, len(top))]
            tp = [(m[0] - 0.18 + 0.12 * j, m[1] - 0.05, -0.24) for j in range(3)]
            cloth(mb, tp, lambda sv, tv, p: (p[0] + 0.06 * math.sin(tv * 4 + sv * 2), p[1] - tv * 0.55, p[2] + 0.04 * math.sin(sv * 5 + tv * 3)), 5, s + 50)
        if t in ('wall_window', 'wall_balcony', 'window', 'balcony'):
            radiator(mb, 0, 0, 0, M=mat_trs((1.2 + r.uniform(-0.4, 0.4), 0.1, -T - 0.05)) @ mat_trs((0, 0, 0), (0.2, 0, r.uniform(-0.3, 0.3))), seed=s)
        if t in ('wall_balcony', 'balcony'):
            import build_kit as BK
            BK.balcony_stub(mb, s)
        if fam != 'panel':
            floor_debris(ctx, mb, 3)
    else:
        if fam == 'panel':
            ceiling_band(mb, s + 1)
            cross_walls(mb, s + 2)
        else:
            ceiling_band(mb, s + 1, fam, ctx.colour)
        floor_screed(mb, s + 3)
        edge_bars(ctx, mb, 8 if fam == 'panel' else 6, bend=-0.6 if inward else 0.8)
        pts = broken_edge_points(ctx, 2)
        if fam == 'panel' and pts:
            m, nr, L = pts[r.integers(0, len(pts))]
            mesh_flap(mb, (m[0], m[1], -0.04), nr, 1.0 if not inward else -1.0, s + 31, size=0.4)
            for k in range(2):
                m, nr, L = pts[r.integers(0, len(pts))]
                wool_tuft(mb, (m[0], m[1], -0.135), nr, s + 41 + k, r.uniform(0.12, 0.2))
        for fr in ctx.d['frags']:
            if fam == 'panel':          # (unreinforced masonry does not hang on bars)
                fragment(ctx, mb, fr)
        # bent starter bars from the kerb / floor (panel bottom joint) where the kerb is gone
        for k in range(4):
            x = r.uniform(0.3, W - 0.3)
            if ctx.psolid.contains(Point(x, 0.05)):
                continue
            rebar_bar(mb, [(x, -0.05, -0.12), (x, 0.06, -0.12), (x + r.normal(0, 0.05), 0.2, -0.05 + (0.15 if not inward else -0.15)), (x + r.normal(0, 0.1), 0.3, (0.3 if not inward else -0.35))], rad=0.0075)
        scatter_lip_chunks(ctx, mb, 3)
        floor_debris(ctx, mb, 4)
        remaining, merged = opening_status(ctx)
        if t in ('wall_window', 'wall_balcony', 'window', 'balcony'):
            radiator(mb, 0, 0, 0, M=mat_trs((0.9 + r.uniform(0, 0.8), 0.07, -T - 0.3)) @ mat_trs((0, 0, 0), (-1.25, r.uniform(-0.5, 0.5), 0)), pipes=False)
        if t in ('wall_balcony', 'balcony') and v == 'v2':
            import build_kit as BK
            BK.balcony_stub(mb, s)
        if t in ('wall_entrance', 'entrance'):
            # steel door leaf torn out with its frame: leaning on the kerb inside (v2) / thrown out onto the ground (v3)
            M = mat_trs((1.0, 0.05, -0.45), (0.62, 0.15, 0.05)) if v == 'v2' else mat_trs((0.6, 0.06, 1.7), (-1.5, 0.35, 0.0))
            door_leaf(mb, M)
        if fam == 'shop':
            # twisted aluminium frame members and broken glass on the floor
            a_ = R2()['alu']
            for k in range(3):
                mb.box((0, 0, -0.03), (r.uniform(0.8, 1.6), 0.06, 0.03), Fit(a_, (0.6, 0.6), s + k), faces='+y+z-z', mat=M1,
                       M=mat_trs((r.uniform(0.3, 1.8), 0.03 + 0.03 * k, r.uniform(-0.9, 0.6)), (0, r.uniform(0, 3.1), r.uniform(-0.1, 0.1))))
        # rag snagged on the band
        tp = [(1.0 + r.uniform(0, 1.2) + 0.12 * j, H - 0.45, -0.1) for j in range(3)]
        cloth(mb, tp, lambda sv, tv, p: (p[0] + 0.05 * math.sin(tv * 4 + sv * 2), p[1] - tv * 0.5, p[2] + tv * 0.12), 4, s + 51)
    return mb


def build_all():
    out = []
    for p, f, t, c in KD.all_types():
        for st in KD.DSTATES:
            for v in KD.VARIANTS:
                out.append(build_piece(p, st, v))
    return out


def structure_v1(mb, fam, seed, colour=None):
    """Structural framing added to the original *_destroyed (v1) pieces: ceiling-slab edge band, floor screed and
    (large panels) transverse wall ends, so a column of destroyed panels reads as slabs + walls, not floating stubs."""
    ceiling_band(mb, seed + 1, fam, colour)
    if fam == 'panel':
        cross_walls(mb, seed + 2)
    floor_screed(mb, seed + 3)
