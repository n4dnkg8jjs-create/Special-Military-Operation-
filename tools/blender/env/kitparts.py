"""Reusable kit geometry (no bpy needed except tessellation via mathutils): panels, frames, rebar,
broken chunks, furniture. All in glTF space, panel coords x 0..W, y 0..H, z 0 (outside face) .. -T."""
import math
import numpy as np
from meshlib import (MB, Region, Fit, Proj, slab, side_uv, rng, noise1d, newell, xform, mat_trs, rot_axis,
                     cw, ccw, point_in_poly, seg_intersections, blob, resample_closed)
from kit_design import W, H, T, CHAMFER, LAYER_OUT, LAYER_INS, OPEN, hole_poly, stub_outline
import kit_atlas as KA

R = {k: Region(*v) for k, v in KA.REG.items()}


def facade_region(t, state):
    x0, y0, x1, y1 = KA.cell_rect(t, state)
    return Region(x0, y0, x1, y1, pad=0)


def fit(name, size=(0.5, 0.5), seed=0, stretch=False):
    return Fit(R[name], size, seed, stretch)


def len_uv(name, length=1.0):
    reg = R[name]
    return lambda s, L: reg.uv(s, (L / length) % 1.0)


# ------------------------------------------------------------------ panel slabs
LV_INTACT = [0.0, -CHAMFER, -T]
LV_BROKEN = [0.0, -0.03, -LAYER_OUT, -LAYER_OUT - 0.005, -LAYER_INS + 0.005, -LAYER_INS, -0.27, -T]
_BASE = [0.10, 0.05, 0.03, 0.055, 0.055, 0.03, 0.05, 0.10]
_AMP = [0.07, 0.03, 0.035, 0.03, 0.03, 0.035, 0.03, 0.06]


def clean_off(ch):
    return lambda k, i: (ch, 0.0) if k == 0 else (0.0, 0.0)


def broken_off(n, seed, broken=None, ch=CHAMFER, scale=1.0, levels=8):
    r = rng(seed)
    sm = [noise1d(n, seed + k, 3) for k in range(levels)]
    jit = r.normal(0, 1, (levels, n)); dzj = r.normal(0, 0.005, (levels, n))
    base = _BASE if levels == 8 else [0.08, 0.02, 0.0, 0.07][:levels]
    amp = _AMP if levels == 8 else [0.06, 0.03, 0.03, 0.05][:levels]

    def f(k, i):
        if broken is not None and not broken[i]:
            return (ch, 0.0) if k == 0 else (0.0, 0.0)
        d = (base[k] + amp[k] * (0.9 * sm[k][i] + 0.2 * jit[k][i])) * scale
        dz = 0.0 if k in (0, levels - 1) else dzj[k][i]
        return (max(d, -0.015), dz)
    return f


def panel_uv_side(t, state, loop_kinds, broken_masks=None):
    """loop_kinds: per loop 'outer' | 'reveal' | 'broken' | 'mixed' (mixed uses broken_masks)."""
    fac = Proj(facade_region(t, state), (1, 0, 0), (0, 1, 0), (0, 0), (W, H))
    sect = side_uv(R['section'], 2.0); sectc = side_uv(R['section_clean'], 2.0); rev = side_uv(R['concrete'], 2.0)

    def f(a, b, fa, fb, li, k, P, i):
        kind = loop_kinds[li]
        if kind == 'mixed':
            m = broken_masks[li]; n = len(m)
            kind = 'broken' if (m[i] or m[(i + 1) % n]) else 'outer'
        if kind == 'broken':
            return sect(a, b, fa, fb, li)
        if k == 0:
            return fac(P, np.array([0, 0, 1.0]))
        return rev(a, b, fa, fb, li)
    return f


def wall_slab(mb, t, state, openings, hole=None, stub=None, seed=0):
    """openings: list of rects to cut cleanly; hole: broken loop polygon (CCW given); stub: (outline, broken mask)."""
    fac = Proj(facade_region(t, state), (1, 0, 0), (0, 1, 0), (0, 0), (W, H))
    back = Proj(R['interior'], (1, 0, 0), (0, 1, 0), (0, 0), (W, H))
    loops, kinds, masks = [], [], []
    broken_state = hole is not None or stub is not None
    levels = LV_BROKEN if broken_state else LV_INTACT
    if stub is not None:
        P, bm = stub
        loops.append({'pts': ccw(P), 'off': broken_off(len(P), seed, bm)}); kinds.append('mixed'); masks.append(bm)
    else:
        outer = np.array([(0, 0), (W, 0), (W, H), (0, H)], float)
        loops.append({'pts': outer, 'off': clean_off(CHAMFER)}); kinds.append('outer'); masks.append(None)
    for (x0, y0, x1, y1) in openings:
        rect = cw(np.array([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], float))
        loops.append({'pts': rect, 'off': clean_off(0.015)}); kinds.append('reveal'); masks.append(None)
    if hole is not None:
        if isinstance(hole, dict):
            Hh = np.asarray(hole['poly'], float)[::-1]; bm = np.asarray(hole['broken'])[::-1]   # CCW -> CW
            loops.append({'pts': Hh, 'off': broken_off(len(Hh), seed + 7, bm, ch=0.015)}); kinds.append('mixed'); masks.append(bm)
        else:
            Hh = cw(np.asarray(hole, float))
            loops.append({'pts': Hh, 'off': broken_off(len(Hh), seed + 7)}); kinds.append('broken'); masks.append(None)
    rings = slab(mb, loops, levels, fac, back, panel_uv_side(t, state, kinds, masks))
    return rings, levels


# ------------------------------------------------------------------ rebar
def rebar_bar(mb, pts, rad=0.0085, sides=3):
    mb.tube(pts, rad, sides, len_uv('rebar', 0.6), smooth=True)


def rebar_from_edges(mb, solid_test, edge_poly_by_depth, seed, nmax, spacing=0.2, bridge=True,
                     xr=(0.05, W - 0.05), yr=(0.05, H - 0.05), edge_mask=None, bend_out=0.6):
    """Grid reinforcement cut by broken edges. edge_poly_by_depth: {z: Nx2 polygon of the broken loop at that depth}.
    solid_test(x, y) -> True where concrete remains. Bars are emitted where grid lines cross the polygon."""
    r = rng(seed); cands = []
    for z, poly in edge_poly_by_depth.items():
        lines = [((x, yr[0]), (x, yr[1])) for x in np.arange(spacing, W - 0.01, spacing)] + \
                [((xr[0], y), (xr[1], y)) for y in np.arange(spacing, H - 0.01, spacing)]
        for a, b in lines:
            hits = seg_intersections(poly, a, b)
            d = np.array(b, float) - np.array(a, float); d /= np.linalg.norm(d)
            if edge_mask is not None:
                n_ = len(edge_mask)
                hits = [h for h in hits if edge_mask[h[2]] and edge_mask[(h[2] + 1) % n_]]
            for t, p, _ in hits:
                fwd = p + d * 0.05; bwd = p - d * 0.05
                sf, sb = solid_test(*fwd), solid_test(*bwd)
                if sf == sb:
                    continue
                into_void = d if sb else -d
                cands.append((z, np.array(p), into_void, a, b, hits))
    r.shuffle(cands)
    used = 0; done_bridge = set()
    for z, p, dv, a, b, hits in cands:
        if used >= nmax:
            break
        # bridging bar across a narrow gap
        if bridge and r.random() < 0.3:
            # find the next crossing along dv
            others = [q for _, q, _ in hits if np.dot(q - p, dv) > 0.15]
            if others:
                q = min(others, key=lambda q: np.dot(q - p, dv)); span = np.dot(q - p, dv)
                key = (round(z, 3), round(min(p[0], q[0]), 2), round(min(p[1], q[1]), 2))
                if span < 1.5 and key not in done_bridge:
                    done_bridge.add(key)
                    bulge = r.uniform(0.1, 0.35) * (1 if r.random() < 0.75 else -0.5)
                    sag = r.uniform(0.0, 0.25) if abs(dv[0]) > 0.5 else 0.0
                    pts = []
                    for s in np.linspace(-0.04, span + 0.04, 6):
                        u = np.clip(s / span, 0, 1); w = math.sin(math.pi * u)
                        xy = p + dv * s
                        pts.append((xy[0] + r.normal(0, 0.01), xy[1] - sag * w + r.normal(0, 0.01), z + bulge * w))
                    rebar_bar(mb, pts); used += 1
                    continue
        L = r.uniform(0.12, 0.55)
        out = np.array([0, 0, 1.0]) * (bend_out if z > -0.15 else -0.4 * bend_out)
        side = np.array([-dv[1], dv[0], 0]) * r.normal(0, 0.4)
        droop = np.array([0, -1.0, 0]) * (r.uniform(0.2, 0.8) if abs(dv[0]) > 0.5 else 0.1)
        bend = out + side + droop + np.array([0, 0, r.normal(0, 0.3)])
        bend /= np.linalg.norm(bend) + 1e-9
        d3 = np.array([dv[0], dv[1], 0.0]); p3 = np.array([p[0], p[1], z])
        k = r.uniform(0.3, 0.9)
        pts = [p3 - d3 * 0.04, p3 + d3 * L * 0.25, p3 + d3 * L * 0.6 + bend * L * 0.25 * k,
               p3 + d3 * L * (1 - 0.3 * k) + bend * L * 0.7 * k]
        rebar_bar(mb, pts); used += 1
    return used


# ------------------------------------------------------------------ chunks / shards / cloth
def chunk(mb, centre, size, seed, region='section', rot=None, flat=0.6, M=None):
    """Irregular broken concrete chunk: a jittered, slightly sheared box (12 tris)."""
    r = rng(seed)
    sx, sy, sz = size
    c = np.array(centre, float)
    pts = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], float) * [sx / 2, sy / 2, sz / 2]
    pts += r.normal(0, 1, pts.shape) * np.array([sx, sy, sz]) * 0.16
    rx, ry, rz = rot if rot is not None else r.uniform(-0.6, 0.6, 3) * [1, 3, 1]
    Mr = mat_trs(c, (rx, ry, rz))
    if M is not None:
        Mr = M @ Mr
    P = xform(pts, Mr)
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    f = Fit(R[region], (0.6, 0.3), seed)
    for fc in faces:
        Q = P[list(fc)]
        # split into 2 tris so warped quads stay planar
        for tri in ((0, 1, 2), (0, 2, 3)):
            T3 = Q[list(tri)]
            mb.poly(T3, f)


def shards(mb, rect, z, seed, n=6, region='glass_broken'):
    """Glass shards stuck in a sash: triangles based on the rect edges, double sided."""
    x0, y0, x1, y1 = rect; r = rng(seed)
    f = Fit(R[region], (0.3, 0.3), seed)
    for k in range(n):
        e = r.integers(0, 4)
        if e == 0:   # bottom
            a = r.uniform(x0, x1 - 0.06); L = r.uniform(0.05, min(0.3, x1 - a)); base = [(a, y0), (a + L, y0)]; apex = (a + r.uniform(0, L), y0 + r.uniform(0.05, 0.25))
        elif e == 1:  # top
            a = r.uniform(x0, x1 - 0.06); L = r.uniform(0.05, min(0.3, x1 - a)); base = [(a + L, y1), (a, y1)]; apex = (a + r.uniform(0, L), y1 - r.uniform(0.05, 0.3))
        elif e == 2:  # left
            a = r.uniform(y0, y1 - 0.06); L = r.uniform(0.05, min(0.3, y1 - a)); base = [(x0, a + L), (x0, a)]; apex = (x0 + r.uniform(0.04, 0.2), a + r.uniform(0, L))
        else:
            a = r.uniform(y0, y1 - 0.06); L = r.uniform(0.05, min(0.3, y1 - a)); base = [(x1, a), (x1, a + L)]; apex = (x1 - r.uniform(0.04, 0.2), a + r.uniform(0, L))
        P = [(base[0][0], base[0][1], z), (base[1][0], base[1][1], z), (apex[0], apex[1], z + r.normal(0, 0.01))]
        mb.poly(P, f); mb.poly(P[::-1], f)


def cloth(mb, top_pts, drop_fn, rows, seed, region='rag', double=True):
    """Hanging cloth: top_pts (C points), drop_fn(s, t, p_top) -> point for row t in 0..1."""
    r = rng(seed)
    grid = []
    for i in range(rows):
        t = i / (rows - 1)
        grid.append([drop_fn(j / (len(top_pts) - 1), t, np.array(p, float)) for j, p in enumerate(top_pts)])
    reg = R[region]
    mb.ribbon(grid, lambda s, t: reg.uv(s, 1 - t), double=double, smooth=True)


# ------------------------------------------------------------------ windows / doors
def frame_box(mb, mn, mx, faces, region, seed=0, M=None):
    mb.box(mn, mx, Fit(R[region], (0.6, 0.6), seed), faces=faces, M=M)


def glass_quad(mb, x0, y0, x1, y1, z, sub=None, region='glass', M=None):
    reg = R[region]
    if sub:
        reg = reg.sub(*sub)
    P = np.array([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)])
    if M is not None:
        P = xform(P, M)
    mb.poly(P, lambda P_, n: [reg.uv(0, 0), reg.uv(1, 0), reg.uv(1, 1), reg.uv(0, 1)])


def sash(mb, x0, y0, x1, y1, zf, region, sw=0.05, depth=0.045, glass='full', seed=0, M=None, sub=None):
    """Sash ring (4 members, visible faces) + glass. glass: 'full' | 'none' | 'shards'."""
    fz0, fz1 = zf - depth, zf
    frame_box(mb, (x0, y0, fz0), (x1, y0 + sw, fz1), '+z+y', region, seed, M)
    frame_box(mb, (x0, y1 - sw, fz0), (x1, y1, fz1), '+z-y+y', region, seed + 1, M)
    frame_box(mb, (x0, y0 + sw, fz0), (x0 + sw, y1 - sw, fz1), '+z+x-x', region, seed + 2, M)
    frame_box(mb, (x1 - sw, y0 + sw, fz0), (x1, y1 - sw, fz1), '+z-x+x', region, seed + 3, M)
    gz = zf - 0.02
    if glass == 'full':
        glass_quad(mb, x0 + sw, y0 + sw, x1 - sw, y1 - sw, gz, sub=sub, M=M)
    elif glass == 'shards':
        tmp = MB(); shards(tmp, (x0 + sw, y0 + sw, x1 - sw, y1 - sw), gz, seed + 5, n=4)
        mb.merge(tmp, M)


def window_unit(mb, rect, style, state, seed, zf=-0.105):
    """Soviet double-casement window (wood) or replacement PVC, in an opening rect.
    state: intact | damaged. Returns nothing. Faces only where visible from the street / through glass."""
    x0, y0, x1, y1 = rect; r = rng(seed)
    reg = 'wood_paint' if style == 'wood' else 'pvc'
    fw = 0.07 if style == 'wood' else 0.065; d = 0.07
    z0, z1 = zf - d, zf
    # outer frame
    frame_box(mb, (x0, y0, z0), (x1, y0 + fw, z1), '+z+y', reg, seed)
    frame_box(mb, (x0, y1 - fw, z0), (x1, y1, z1), '+z-y', reg, seed + 1)
    frame_box(mb, (x0, y0 + fw, z0), (x0 + fw, y1 - fw, z1), '+z+x', reg, seed + 2)
    frame_box(mb, (x1 - fw, y0 + fw, z0), (x1, y1 - fw, z1), '+z-x', reg, seed + 3)
    xm = x0 + (x1 - x0) * (0.47 if style == 'wood' else 0.5)
    frame_box(mb, (xm - 0.035, y0 + fw, z0), (xm + 0.035, y1 - fw, z1), '+z+x-x', reg, seed + 4)
    yt = y1 - 0.42
    frame_box(mb, (x0 + fw, yt - 0.03, z0), (xm - 0.035, yt + 0.03, z1), '+z+y-y', reg, seed + 5)
    # sill flashing (galvanised, sloped, inside the reveal so the panel bbox stays z <= 0)
    f = Fit(R['galv'], (1.0, 0.3), seed)
    mb.poly([(x0, y0 + 0.012, -0.004), (x1, y0 + 0.012, -0.004), (x1, y0 + 0.03, zf - 0.005), (x0, y0 + 0.03, zf - 0.005)], f)
    # sashes
    L1 = (x0 + fw, y0 + fw, xm - 0.035, yt - 0.03)
    F1 = (x0 + fw, yt + 0.03, xm - 0.035, y1 - fw)
    R1 = (xm + 0.035, y0 + fw, x1 - fw, y1 - fw)
    zs = zf + 0.012
    gsub = [(0, 0, 0.45, 0.72), (0, 0.72, 0.45, 1), (0.45, 0, 1, 1)]
    if state == 'intact':
        for k, rc in enumerate((L1, F1, R1)):
            sash(mb, *rc, zs, reg, seed=seed + 10 + k * 7, sub=gsub[k])
    else:
        # left sash: glass blown out, shards remain; fortochka gone; right sash torn off its upper hinge, swung in
        sash(mb, *L1, zs, reg, glass='shards', seed=seed + 10)
        tmp = MB(); sash(tmp, R1[0] - R1[0], R1[1] - R1[1], R1[2] - R1[0], R1[3] - R1[1], 0.0, reg, glass='shards', seed=seed + 20)
        ang = r.uniform(1.0, 1.35)
        M = mat_trs((R1[2], R1[1], zs - 0.05)) @ mat_trs((0, 0, 0), (0, 0, r.uniform(-0.12, -0.05))) @ mat_trs((0, 0, 0), (0, -ang, 0)) @ mat_trs((-(R1[2] - R1[0]), 0, 0))
        mb.merge(tmp, M)
        shards(mb, F1, zs - 0.02, seed + 30, n=3)


def balcony_door_unit(mb, rect, style, state, seed, zf=-0.105):
    x0, y0, x1, y1 = rect
    reg = 'wood_paint' if style == 'wood' else 'pvc'
    fw = 0.065; d = 0.07; z0, z1 = zf - d, zf
    frame_box(mb, (x0, y0, z0), (x1, y0 + fw, z1), '+z+y', reg, seed)
    frame_box(mb, (x0, y1 - fw, z0), (x1, y1, z1), '+z-y', reg, seed + 1)
    frame_box(mb, (x0, y0 + fw, z0), (x0 + fw, y1 - fw, z1), '+z+x', reg, seed + 2)
    frame_box(mb, (x1 - fw, y0 + fw, z0), (x1, y1 - fw, z1), '+z-x', reg, seed + 3)
    ix0, iy0, ix1, iy1 = x0 + fw, y0 + fw, x1 - fw, y1 - fw
    def leaf(m, glass):
        # door leaf: lower solid infill panel + glazed upper part
        sw = 0.07
        frame_box(m, (0, 0, -0.05), (ix1 - ix0, sw, 0), '+z+y-z', reg, seed + 5)
        frame_box(m, (0, iy1 - iy0 - sw, -0.05), (ix1 - ix0, iy1 - iy0, 0), '+z-y-z', reg, seed + 6)
        frame_box(m, (0, sw, -0.05), (sw, iy1 - iy0 - sw, 0), '+z+x-z', reg, seed + 7)
        frame_box(m, (ix1 - ix0 - sw, sw, -0.05), (ix1 - ix0, iy1 - iy0 - sw, 0), '+z-x-z', reg, seed + 8)
        frame_box(m, (sw, sw, -0.035), (ix1 - ix0 - sw, 0.8, -0.015), '+z-z+y', reg, seed + 9)
        if glass == 'full':
            glass_quad(m, sw, 0.8, ix1 - ix0 - sw, iy1 - iy0 - sw, -0.025, sub=(0.2, 0, 0.8, 1))
        elif glass == 'shards':
            shards(m, (sw, 0.8, ix1 - ix0 - sw, iy1 - iy0 - sw), -0.025, seed + 11, n=4)
    tmp = MB()
    if state == 'intact':
        leaf(tmp, 'full'); mb.merge(tmp, mat_trs((ix0, iy0, zf + 0.01)))
    else:
        leaf(tmp, 'shards')
        # blown outward onto the balcony, hanging from the lower hinge only
        M = mat_trs((ix0, iy0, zf + 0.01)) @ mat_trs((0, 0, 0), (0, -1.15, 0)) @ mat_trs((0, 0, 0), (0, 0, -0.06))
        mb.merge(tmp, M)


def entrance_door_unit(mb, rect, state, seed, zf=-0.08):
    x0, y0, x1, y1 = rect; r = rng(seed)
    fw = 0.06; d = 0.08
    for (mn, mx, fc) in (((x0, y1 - fw, zf - d), (x1, y1, zf), '+z-y'), ((x0, y0, zf - d), (x0 + fw, y1 - fw, zf), '+z+x'),
                         ((x1 - fw, y0, zf - d), (x1, y1 - fw, zf), '+z-x')):
        frame_box(mb, mn, mx, fc, 'metal_grey', seed)
    # fixed side panel (right) + main leaf (left hinge)
    xs = x1 - fw - 0.34
    frame_box(mb, (xs, y0, zf - 0.05), (x1 - fw, y1 - fw, zf - 0.01), '+z-x', 'metal_grey', seed + 1)
    lw, lh = xs - (x0 + fw), y1 - fw - y0
    leaf = MB()
    door = R['door']
    leaf.box((0, 0, -0.05), (lw, lh, 0), lambda P, n: [door.uv((p[0]) / lw, p[1] / lh) for p in P], faces='+z-z')
    leaf.box((0, 0, -0.05), (lw, lh, 0), Fit(R['metal_grey'], (0.3, 2.2), seed), faces='+x-x+y')
    if state == 'intact':
        mb.merge(leaf, mat_trs((x0 + fw, y0, zf - 0.005)))
    elif state == 'damaged':
        M = mat_trs((x0 + fw, y0, zf - 0.005)) @ mat_trs((0, 0, 0), (0, r.uniform(-0.9, -0.6), 0))
        mb.merge(leaf, M)
    elif state == 'holed':
        # torn from the top hinge, hanging outwards and twisted
        M = mat_trs((x0 + fw, y0 + 0.05, 0.2)) @ mat_trs((0, 0, 0), (-0.35, -0.5, -0.25))
        mb.merge(leaf, M)
    else:
        # lying on the rubble in front of the entrance
        M = mat_trs((x0 - 0.1, 0.12, 2.45)) @ mat_trs((0, 0, 0), (-1.45, 0.25, 0.08))
        mb.merge(leaf, M)


def radiator(mb, x, y, z, w=0.9, h=0.55, d=0.13, M=None, pipes=True, seed=0):
    """Cast-iron MS-140 radiator, section fins in the normal map. Local origin = bottom-left-front."""
    reg = R['radiator']
    Mx = mat_trs((x, y, z)) if M is None else M
    tmp = MB()
    tmp.box((0, 0, -d), (w, h, 0), lambda P, n: [reg.uv(p[0] / w, p[1] / h) for p in P])
    if pipes:
        for px in (0.04, w - 0.04):
            tmp.tube([(px, h - 0.05, -d / 2), (px - 0.03 if px < 0.5 else px + 0.03, h - 0.05, -d / 2), (px - 0.06 if px < 0.5 else px + 0.06, h + 0.25, -d / 2 - 0.02)], 0.012, 4, len_uv('metal_grey'))
    mb.merge(tmp, Mx)
