"""Geometry for the city additions to panel_kit.glb: brick 1-447 walls (white silicate + red brick piece sets),
shopfront ground-floor panels, shop signs, roof pieces. Material 0 = kit_panel (kit atlas), 1 = kit_city.
Same panel frame as the large-panel kit: x 0..W, y 0..H, z 0 (outside face) .. -T (room side)."""
import math
import numpy as np
from meshlib import MB, Region, Fit, Proj, slab, side_uv, rng, noise1d, newell, xform, mat_trs, rot_axis, cw, ccw, \
    point_in_poly, seg_intersections
from kit_design import W, H, T
from kitparts import R, len_uv, rebar_bar, chunk, shards, cloth, frame_box, glass_quad, sash, window_unit, \
    balcony_door_unit, entrance_door_unit, radiator
from city_kit_design import (COURSE, PITCH, HALF, COLOURS, BTYPES, STATES, OPEN_BRICK, SHOP_TYPES, OPEN_SHOP, SIGNS,
                             SIGN_H, SIGN_Y, brick_hole, brick_stub, shop_hole, shop_stub)
import city_kit_atlas as CA

R2 = {k: Region(*v) for k, v in CA.REG.items()}
M1 = 1   # material index of kit_city


def cell_region(i):
    x0, y0, x1, y1 = CA.cell_rect(i)
    return Region(x0, y0, x1, y1, pad=0)


def fit2(name, size=(0.5, 0.5), seed=0, stretch=False):
    return Fit(R2[name], size, seed, stretch)


def len2(name, length=1.0):
    reg = R2[name]
    return lambda s, L: reg.uv(s, (L / length) % 1.0)


def tquad(mb, o, du, dv, Lu, Lv, reg, tile=(1.0, 1.0), mat=M1, M=None):
    """Planar rectangle o + du*a + dv*b (a in 0..Lu, b in 0..Lv) split so that `reg` repeats every tile metres."""
    o = np.asarray(o, float); du = np.asarray(du, float); dv = np.asarray(dv, float)
    nu, nv = max(1, int(math.ceil(Lu / tile[0] - 1e-6))), max(1, int(math.ceil(Lv / tile[1] - 1e-6)))
    for i in range(nu):
        for j in range(nv):
            a0, a1 = i * tile[0], min(Lu, (i + 1) * tile[0]); b0, b1 = j * tile[1], min(Lv, (j + 1) * tile[1])
            P = np.array([o + du * a0 + dv * b0, o + du * a1 + dv * b0, o + du * a1 + dv * b1, o + du * a0 + dv * b1])
            if M is not None:
                P = xform(P, M)
            uv = [reg.uv(0, 0), reg.uv((a1 - a0) / tile[0], 0), reg.uv((a1 - a0) / tile[0], (b1 - b0) / tile[1]), reg.uv(0, (b1 - b0) / tile[1])]
            mb.poly(P, lambda P_, n_, uv=uv: uv, mat=mat)


def tbox(mb, mn, mx, reg, tile=(1.0, 1.0), faces='all', mat=M1, M=None):
    x0, y0, z0 = mn; x1, y1, z1 = mx
    F = {'+x': ((x1, y0, z1), (0, 0, -1), (0, 1, 0), z1 - z0, y1 - y0), '-x': ((x0, y0, z0), (0, 0, 1), (0, 1, 0), z1 - z0, y1 - y0),
         '+y': ((x0, y1, z1), (1, 0, 0), (0, 0, -1), x1 - x0, z1 - z0), '-y': ((x0, y0, z0), (1, 0, 0), (0, 0, 1), x1 - x0, z1 - z0),
         '+z': ((x0, y0, z1), (1, 0, 0), (0, 1, 0), x1 - x0, y1 - y0), '-z': ((x1, y0, z0), (-1, 0, 0), (0, 1, 0), x1 - x0, y1 - y0)}
    for k, (o, du, dv, Lu, Lv) in F.items():
        if faces != 'all' and k not in faces:
            continue
        tquad(mb, o, du, dv, Lu, Lv, reg, tile, mat, M)


def slab_m(mb, loops, levels, front, back, side, front_mat=M1, back_mat=0, side_mat=M1):
    """meshlib.slab with separate materials for the front (outside face), back (room face) and sides."""
    tmp = MB()
    slab(tmp, loops, levels, front, back, side, mat=side_mat)
    z0, zb = levels[0], levels[-1]
    for idx, (vi, uv, sm, mt) in enumerate(tmp.F):
        P = np.array([tmp.V[i] for i in vi])
        if np.all(np.abs(P[:, 2] - zb) < 1e-6) and newell(P)[2] < -0.5:
            mt = back_mat
        elif np.all(np.abs(P[:, 2] - z0) < 1e-6) and newell(P)[2] > 0.5:
            mt = front_mat
        tmp.F[idx] = (vi, uv, sm, mt)
    mb.merge(tmp)


def chunk2(mb, centre, size, seed, region, mat=M1, rot=None, M=None):
    """kitparts.chunk with a region/material of choice."""
    r = rng(seed)
    sx, sy, sz = size
    pts = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], float) * [sx / 2, sy / 2, sz / 2]
    pts += r.normal(0, 1, pts.shape) * np.array([sx, sy, sz]) * 0.16
    rx, ry, rz = rot if rot is not None else r.uniform(-0.6, 0.6, 3) * [1, 3, 1]
    Mr = mat_trs(centre, (rx, ry, rz))
    if M is not None:
        Mr = M @ Mr
    P = xform(pts, Mr)
    reg = R2[region] if mat == M1 else R[region]
    f = Fit(reg, (0.6, 0.3), seed)
    for fc in [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]:
        Q = P[list(fc)]
        for tri in ((0, 1, 2), (0, 2, 3)):
            mb.poly(Q[list(tri)], f, mat=mat)


def loose_brick(mb, centre, rot, colour, seed, M=None):
    Mr = mat_trs(centre, rot)
    if M is not None:
        Mr = M @ Mr
    mb.box((-0.125, -0.033, -0.06), (0.125, 0.033, 0.06), Fit(R2['brick_sec_' + colour], (0.5, 0.15), seed), faces='all', mat=M1, M=Mr)


def brick_heap(mb, cx, cz, rad, n, colour, seed, y0=0.0):
    r = rng(seed)
    for k in range(n):
        a = r.uniform(0, 2 * np.pi); d = rad * math.sqrt(r.random())
        y = y0 + 0.035 + max(0.0, (1 - d / rad)) * rad * 0.35 * r.random()
        loose_brick(mb, (cx + math.cos(a) * d, y, cz + math.sin(a) * d), (r.uniform(-0.4, 0.4), r.uniform(0, 3.14), r.uniform(-0.4, 0.4)), colour, seed + k)


def _wire(mb, p, d, seed):
    r = rng(seed)
    L = r.uniform(0.12, 0.35)
    p3 = np.array([p[0], p[1], -0.15]); d3 = np.array([d[0], d[1], 0.0])
    out = np.array([0, -0.3, r.uniform(0.2, 0.8)])
    rebar_bar(mb, [p3 - d3 * 0.03, p3 + d3 * L * 0.4, p3 + d3 * L * 0.8 + out * L * 0.5], rad=0.004, sides=3)


# ================================================================== brick walls
def brick_name(colour, t, state):
    return ('brick_' if colour == 'white' else 'brick_red_') + f'{t}_{state}'


def brick_off(n, seed, broken, nlev):
    r = rng(seed)
    sm = [noise1d(n, seed + k, 3) for k in range(nlev)]
    jit = r.normal(0, 1, (nlev, n))

    def f(k, i):
        if broken is not None and not broken[i]:
            return (0.0, 0.0)
        if k == 0:
            return (0.0, 0.0)
        if k == nlev - 1:
            return (0.03 + 0.025 * sm[k][i] + 0.01 * jit[k][i], 0.0)
        return (0.012 + 0.022 * sm[k][i] + 0.008 * jit[k][i], 0.006 * jit[k][(i + 3) % n])
    return f


LV_B = [0.0, -0.1, -0.2, -T]


def brick_wall(colour, t, state):
    mb = MB(brick_name(colour, t, state))
    s = 4000 + COLOURS.index(colour) * 100 + BTYPES.index(t) * 20 + STATES.index(state) * 3
    r = rng(s)
    fac = Proj(cell_region(CA.cell_index_brick(colour, t, state)), (1, 0, 0), (0, 1, 0), (0, 0), (W, H))
    back = Proj(R['interior'], (1, 0, 0), (0, 1, 0), (0, 0), (W, H))
    s_out = side_uv(R2['brick_' + colour], 1.0); s_rev = side_uv(R2['reveal'], 1.0); s_brk = side_uv(R2['brick_sec_' + colour], 2.0)
    wood = 'wood' if colour == 'white' else 'pvc'
    loops = []; kinds = []; masks = []
    if state in ('intact', 'damaged'):
        loops.append({'pts': np.array([(0, 0), (W, 0), (W, H), (0, H)], float)}); kinds.append('outer'); masks.append(None)
        for _, (x0, y0, x1, y1) in OPEN_BRICK[t]:
            loops.append({'pts': cw(np.array([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], float))}); kinds.append('reveal'); masks.append(None)
        levels = [0.0, -T]
    elif state == 'holed':
        hd = brick_hole(t, full=True)
        loops.append({'pts': np.array([(0, 0), (W, 0), (W, H), (0, H)], float)}); kinds.append('outer'); masks.append(None)
        for _, (x0, y0, x1, y1) in hd['remaining']:
            loops.append({'pts': cw(np.array([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], float))}); kinds.append('reveal'); masks.append(None)
        Hh = np.asarray(hd['poly'])[::-1]; bm = np.asarray(hd['broken'])[::-1]
        loops.append({'pts': Hh, 'off': brick_off(len(Hh), s + 7, bm, 4)}); kinds.append('mixed'); masks.append(bm)
        levels = LV_B
    else:
        P, bm = brick_stub(t)
        loops.append({'pts': ccw(P), 'off': brick_off(len(P), s + 7, bm, 4)}); kinds.append('mixed'); masks.append(bm)
        levels = LV_B

    def side(a, b, fa, fb, li, k, P, i):
        kind = kinds[li]
        if kind == 'mixed':
            m = masks[li]; n = len(m)
            kind = 'broken' if (m[i] or m[(i + 1) % n]) else ('reveal' if li > 0 else 'outer')
        return {'broken': s_brk, 'reveal': s_rev, 'outer': s_out}[kind](a, b, fa, fb, li)
    slab_m(mb, loops, levels, fac, back, side)

    if state in ('intact', 'damaged'):
        for kind, rc in OPEN_BRICK[t]:
            if kind == 'window':
                window_unit(mb, rc, wood if t == 'window' else 'pvc', state, s + 1, zf=-0.13)
            elif kind == 'door':
                balcony_door_unit(mb, rc, 'pvc', state, s + 2, zf=-0.13)
            else:
                entrance_door_unit(mb, rc, state, s + 3, zf=-0.1)
        if state == 'damaged':
            if t == 'window':
                x0, y0, x1, y1 = OPEN_BRICK[t][0][1]
                top = [(x0 + 0.16 + 0.09 * j, y1 - 0.1, -0.22) for j in range(3)]
                cloth(mb, top, lambda sv, tv, p: (p[0] + 0.05 * math.sin(tv * 5 + sv * 3) + 0.05 * tv, p[1] + (y0 + 0.12 - p[1]) * tv,
                                                   -0.22 + 0.26 * max(0.0, (tv - 0.55) / 0.45) ** 1.5), 7, s + 4)
            if t == 'balcony':
                x0, y0, x1, y1 = OPEN_BRICK[t][1][1]
                mb.box((x0 + 0.03, y0 + 0.03, -0.12), (x1 - 0.03, y0 + 0.95, -0.105), Fit(R['osb'], (1.25, 0.9), s), faces='+z+y-y+x-x')
    elif state == 'holed':
        ring_poly = hd['poly']
        # remaining openings get damaged joinery
        for kind, rc in hd['remaining']:
            if kind == 'window':
                window_unit(mb, rc, wood if t == 'window' else 'pvc', 'damaged', s + 1, zf=-0.13)
        if 'window' in hd['merged']:
            x0, y0, x1, y1 = hd['rects'][hd['merged'].index('window')]
            reg = 'wood_paint' if (t == 'window' and colour == 'white') else 'pvc'
            frame_box(mb, (x0, y1 - 0.07, -0.2), (x1, y1, -0.13), '+z-y', reg, s)
            frame_box(mb, (x0, y1 - 0.8, -0.2), (x0 + 0.07, y1 - 0.07, -0.13), '+z+x-y', reg, s + 1)
            xm = x0 + (x1 - x0) * 0.47
            sash(mb, x0 + 0.07, y1 - 0.4, xm - 0.035, y1 - 0.07, -0.118, reg, glass='shards', seed=s + 2)
        if t == 'entrance':
            entrance_door_unit(mb, OPEN_BRICK[t][0][1], 'holed', s, zf=-0.1)
        if t == 'balcony':
            from build_kit import balcony_stub
            balcony_stub(mb, s)
        # bricks: hanging loose from the top lip, heaped on the bottom lip and on the floor inside/outside
        P = ring_poly; cy = P[:, 1].mean()
        top_pts = P[P[:, 1] > cy + 0.15]; low_pts = P[(P[:, 1] < cy - 0.1) & (P[:, 1] > 0.1)]
        for k in range(min(3, len(top_pts))):
            p = top_pts[r.integers(0, len(top_pts))]
            loose_brick(mb, (p[0] + r.uniform(-0.05, 0.05), p[1] - 0.02, r.uniform(-0.08, -0.02)), (r.uniform(0.2, 0.6), 0, r.uniform(-0.5, 0.5)), colour, s + 40 + k)
        for k in range(min(7, len(low_pts))):
            p = low_pts[r.integers(0, len(low_pts))]
            loose_brick(mb, (p[0] + r.normal(0, 0.06), p[1] + 0.035, r.uniform(-0.25, -0.05)), (r.uniform(-0.3, 0.3), r.uniform(0, 3), 0), colour, s + 50 + k)
        cx = P[:, 0].mean()
        brick_heap(mb, cx, -T - 0.5, 0.6, 14, colour, s + 60)
        # masonry reinforcement mesh every 5 courses, torn at the hole edge
        k = 0
        for j in range(5, 36, 5):
            y = j * COURSE + 0.001
            for (_, p, ei) in seg_intersections(P, (0.0, y), (W, y)):
                if not hd['broken'][ei]:
                    continue
                dvx = 1.0 if point_in_poly((p[0] + 0.05, y), P) else -1.0
                if k < 9:
                    _wire(mb, p, (dvx, 0.0), s + 80 + k); k += 1
        if t in ('window', 'balcony'):
            radiator(mb, 0, 0, 0, M=mat_trs((cx - 0.45, 0.12, -T - 0.03)) @ mat_trs((0, 0, 0), (0.15, 0, -0.22)), seed=s)
        tp = P[np.argmax(P[:, 1])]
        top = [(tp[0] - 0.2 + 0.12 * j, tp[1] - 0.06, -0.26) for j in range(3)]
        cloth(mb, top, lambda sv, tv, p: (p[0] + 0.06 * math.sin(tv * 4 + sv * 2), p[1] - tv * 0.6, p[2] + 0.04 * math.sin(sv * 5 + tv * 3)), 5, s + 90)
    else:
        P, bm = brick_stub(t)
        tops = P[2:-1]
        for k in range(6):
            p = tops[r.integers(0, len(tops))]
            loose_brick(mb, (p[0] + r.normal(0, 0.05), p[1] + 0.035, r.uniform(-0.25, -0.05)), (0, r.uniform(0, 3), r.uniform(-0.3, 0.3)), colour, s + 60 + k)
        brick_heap(mb, 1.0, -T - 0.7, 0.9, 26, colour, s + 70)
        brick_heap(mb, 2.3, -T - 0.6, 0.7, 14, colour, s + 71)
        for k in range(4):
            sz = r.uniform(0.2, 0.45)
            chunk2(mb, (r.uniform(0.4, 2.8), sz * 0.25, -T - r.uniform(0.2, 1.0)), (sz, sz * 0.4, sz * 0.7), s + 75 + k, 'brick_sec_' + colour)
        if t in ('window', 'balcony'):
            radiator(mb, 0, 0, 0, M=mat_trs((1.0, 0.07, -T - 0.25)) @ mat_trs((0, 0, 0), (-1.2, 0.3, 0)), pipes=False)
        if t == 'entrance':
            entrance_door_unit(mb, OPEN_BRICK[t][0][1], 'destroyed', s, zf=-0.1)
    return mb


def brick_parapet(colour):
    """Brick roof parapet with a corbelled cornice course and galvanised cap (0.75 m), panel frame."""
    mb = MB('brick_parapet' if colour == 'white' else 'brick_red_parapet')
    body = MB()
    reg = R2['brick_' + colour]
    Hp = 0.66
    tbox(body, (0, 0, -T + 0.05), (W, Hp, 0), reg, faces='+z-z+y')
    tbox(body, (0, 0.16, 0), (W, 0.24, 0.05), reg, faces='+z+y-y')      # corbel course
    tbox(body, (0, Hp - 0.08, 0), (W, Hp, 0.03), reg, faces='+z-y')
    g = Fit(R['galv'], (1.6, 0.4), 3)
    body.poly([(0, Hp + 0.03, 0.05), (W, Hp + 0.03, 0.05), (W, Hp + 0.02, -T), (0, Hp + 0.02, -T)], g)
    body.poly([(0, Hp - 0.04, 0.06), (W, Hp - 0.04, 0.06), (W, Hp + 0.03, 0.05), (0, Hp + 0.03, 0.05)], g)
    rf = Fit(R['roofing'], (1.6, 0.6), 4)
    body.poly([(W, 0.0, -T + 0.048), (0, 0.0, -T + 0.048), (0, 0.4, -T + 0.048), (W, 0.4, -T + 0.048)], rf)
    mb.merge(body, mat_trs((0, 0, -0.06)))
    return mb


# ================================================================== shopfronts
def shop_name(t, state):
    return f'wall_{t}_{state}'


def alu_frame(mb, rc, zf, d=0.08, fw=0.06, faces_in=True, mullions=(), transom=None, seed=0):
    x0, y0, x1, y1 = rc
    a = fit2('alu', (0.6, 0.6), seed)
    mb.box((x0, y0, zf - d), (x1, y0 + fw, zf), a, faces='+z+y', mat=M1)
    mb.box((x0, y1 - fw, zf - d), (x1, y1, zf), a, faces='+z-y', mat=M1)
    mb.box((x0, y0 + fw, zf - d), (x0 + fw, y1 - fw, zf), a, faces='+z+x', mat=M1)
    mb.box((x1 - fw, y0 + fw, zf - d), (x1, y1 - fw, zf), a, faces='+z-x', mat=M1)
    for xm in mullions:
        mb.box((xm - fw / 2, y0 + fw, zf - d), (xm + fw / 2, y1 - fw, zf), a, faces='+z+x-x', mat=M1)
    if transom:
        mb.box((x0 + fw, transom - fw / 2, zf - d), (x1 - fw, transom + fw / 2, zf), a, faces='+z+y-y', mat=M1)


def shop_glass(mb, x0, y0, x1, y1, z, sub=None):
    reg = R2['shop_glass'] if sub is None else R2['shop_glass'].sub(*sub)
    mb.poly([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], lambda P, n: [reg.uv(0, 0), reg.uv(1, 0), reg.uv(1, 1), reg.uv(0, 1)], mat=M1)


def display_window(mb, rc, state, seed, zf=-0.07):
    x0, y0, x1, y1 = rc; r = rng(seed)
    xm = (x0 + x1) / 2; tr = y1 - 0.38
    alu_frame(mb, rc, zf, mullions=(xm,), transom=tr, seed=seed)
    # granite sill inside the reveal
    mb.box((x0, y0 - 0.03, -0.06), (x1, y0, 0.0), fit2('tile_granite', (1.7, 0.1), seed), faces='+y+z', mat=M1)
    panes = [(x0 + 0.06, y0 + 0.06, xm - 0.03, tr - 0.03), (xm + 0.03, y0 + 0.06, x1 - 0.06, tr - 0.03),
             (x0 + 0.06, tr + 0.03, xm - 0.03, y1 - 0.06), (xm + 0.03, tr + 0.03, x1 - 0.06, y1 - 0.06)]
    subs = [(0, 0, 0.5, 0.78), (0.5, 0, 1, 0.78), (0, 0.78, 0.5, 1), (0.5, 0.78, 1, 1)]
    gz = zf - 0.04
    for k, (a, b, c, d) in enumerate(panes):
        if state == 'intact' or (state == 'damaged' and k == 2):
            shop_glass(mb, a, b, c, d, gz, subs[k])
        else:
            shards(mb, (a, b, c, d), gz, seed + k, n=3)
    if state == 'damaged':
        # lower right pane boarded with OSB after the glass went
        a, b, c, d = panes[1]
        mb.box((a - 0.02, b - 0.02, gz + 0.012), (c + 0.02, d + 0.02, gz + 0.03), Fit(R['osb'], (1.25, 1.25), seed), faces='+z+x-x+y', mat=0)
        # broken glass on the sill / pavement
        for k in range(3):
            P = [(x0 + r.uniform(0, 1.5), y0 + 0.002, -0.05 + r.uniform(0, 0.04)), (x0 + r.uniform(0, 1.5), y0 + 0.002, -0.02), (x0 + r.uniform(0, 1.5), y0 + 0.003, -0.04)]
            f = Fit(R['glass_broken'], (0.3, 0.3), seed + k)
            mb.poly(P if newell(np.array(P))[1] > 0 else P[::-1], f)


def shop_door(mb, rc, state, seed, zf=-0.07):
    x0, y0, x1, y1 = rc; r = rng(seed)
    alu_frame(mb, (x0, y0, x1, y1), zf, seed=seed)
    lw, lh = x1 - x0 - 0.12, y1 - y0 - 0.06
    leaf = MB()
    a = fit2('alu', (0.6, 0.6), seed + 1)
    leaf.box((0, 0, -0.05), (lw, 0.32, 0), a, faces='+z-z+y', mat=M1)
    leaf.box((0, lh - 0.08, -0.05), (lw, lh, 0), a, faces='+z-z-y+y', mat=M1)
    leaf.box((0, 0.32, -0.05), (0.07, lh - 0.08, 0), a, faces='+z-z+x-x', mat=M1)
    leaf.box((lw - 0.07, 0.32, -0.05), (lw, lh - 0.08, 0), a, faces='+z-z+x-x', mat=M1)
    leaf.box((lw - 0.16, 0.9, 0.0), (lw - 0.13, 1.25, 0.04), Fit(R['metal_grey'], (0.1, 0.4), 2), faces='+z+x-x')
    if state == 'intact':
        shop_glass(leaf, 0.07, 0.32, lw - 0.07, lh - 0.08, -0.025, (0.1, 0.1, 0.4, 0.9))
        mb.merge(leaf, mat_trs((x0 + 0.06, y0 + 0.02, zf - 0.01)))
    else:
        shards(leaf, (0.07, 0.32, lw - 0.07, lh - 0.08), -0.025, seed + 3, n=4)
        ang = r.uniform(0.7, 1.2) if state == 'damaged' else 1.45
        M = mat_trs((x0 + 0.06, y0 + 0.02, zf - 0.01)) @ mat_trs((0, 0, 0), (0, ang, 0))
        if state in ('holed', 'destroyed'):
            M = mat_trs((x0 + 0.1, 0.06, 0.5)) @ mat_trs((0, 0, 0), (-1.5, 0.3, 0.05))
        mb.merge(leaf, M)


def shutter_curtain(mb, x0, x1, y0, y1, z, seed, bend=0.0, tear=None):
    """Roller shutter curtain (slats in the texture). bend: outward curl of the lower edge (m)."""
    reg = R2['shutter']
    if bend == 0.0 and tear is None:
        tquad(mb, (x0, y0, z), (1, 0, 0), (0, 1, 0), x1 - x0, y1 - y0, reg, (1.0, 1.0))
        return
    r = rng(seed)
    rows = []
    nr = 6; nc = 7
    for i in range(nr):
        t = i / (nr - 1); y = y1 - (y1 - y0) * t
        row = []
        for j in range(nc):
            s = j / (nc - 1); x = x0 + (x1 - x0) * s
            curl = bend * max(0.0, (t - 0.55) / 0.45) ** 2 * (1 + 0.5 * math.sin(s * 5 + seed))
            dy = 0.0
            if tear is not None:
                dy = tear * max(0.0, t - 0.5) * (0.5 + 0.5 * math.sin(s * 7 + seed)) * r.uniform(0.6, 1.0)
            row.append((x, y + dy, z + curl))
        rows.append(row)
    L, Hh = x1 - x0, y1 - y0
    mb.ribbon(rows, lambda s_, t_: reg.uv((s_ * L) % 1.0001, ((1 - t_) * Hh) % 1.0001), double=True, smooth=False, mat=M1)


def shop_wall(t, state):
    mb = MB(shop_name(t, state))
    s = 5000 + SHOP_TYPES.index(t) * 40 + STATES.index(state) * 7
    r = rng(s)
    fac = Proj(cell_region(CA.cell_index_shop(t, state)), (1, 0, 0), (0, 1, 0), (0, 0), (W, H))
    back = Proj(R['interior'], (1, 0, 0), (0, 1, 0), (0, 0), (W, H))
    s_out = side_uv(R2['reveal'], 1.0); s_rev = side_uv(R2['tile_granite'], 1.0); s_brk = side_uv(R2['brick_sec_white'], 2.0)
    loops, kinds, masks = [], [], []
    ops = OPEN_SHOP[t]
    if state in ('intact', 'damaged'):
        loops.append({'pts': np.array([(0, 0), (W, 0), (W, H), (0, H)], float)}); kinds.append('outer'); masks.append(None)
        for _, (x0, y0, x1, y1) in ops:
            loops.append({'pts': cw(np.array([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], float))}); kinds.append('reveal'); masks.append(None)
        levels = [0.0, -T]
    elif state == 'holed':
        hd = shop_hole(t, full=True)
        loops.append({'pts': np.array([(0, 0), (W, 0), (W, H), (0, H)], float)}); kinds.append('outer'); masks.append(None)
        for _, (x0, y0, x1, y1) in hd['remaining']:
            loops.append({'pts': cw(np.array([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], float))}); kinds.append('reveal'); masks.append(None)
        Hh = np.asarray(hd['poly'])[::-1]; bm = np.asarray(hd['broken'])[::-1]
        loops.append({'pts': Hh, 'off': brick_off(len(Hh), s + 7, bm, 4)}); kinds.append('mixed'); masks.append(bm)
        levels = LV_B
    else:
        P, bm = shop_stub(t)
        loops.append({'pts': ccw(P), 'off': brick_off(len(P), s + 7, bm, 4)}); kinds.append('mixed'); masks.append(bm)
        levels = LV_B

    def side(a, b, fa, fb, li, k, P, i):
        kind = kinds[li]
        if kind == 'mixed':
            m = masks[li]; n = len(m)
            kind = 'broken' if (m[i] or m[(i + 1) % n]) else ('reveal' if li > 0 else 'outer')
        return {'broken': s_brk, 'reveal': s_rev, 'outer': s_out}[kind](a, b, fa, fb, li)
    slab_m(mb, loops, levels, fac, back, side)

    if t == 'shopfront':
        door_rc, disp_rc = ops[0][1], ops[1][1]
        if state in ('intact', 'damaged'):
            shop_door(mb, door_rc, state, s + 1)
            display_window(mb, disp_rc, state, s + 2)
        elif state == 'holed':
            shop_door(mb, door_rc, 'holed', s + 1)
            x0, y0, x1, y1 = disp_rc
            # twisted remnant of the display frame
            a = fit2('alu', (0.6, 0.6), s)
            mb.box((x0, y0, -0.15), (x0 + 0.06, y1, -0.07), a, faces='+z+x', mat=M1)
            tmp = MB(); tmp.box((0, 0, -0.04), (x1 - x0, 0.06, 0.04), a, faces='+z+y-y', mat=M1)
            mb.merge(tmp, mat_trs((x0, y1 - 0.06, -0.1)) @ mat_trs((0, 0, 0), (0.25, 0.15, -0.35)))
            mb.box((x0, y0 - 0.03, -0.06), (x1, y0, 0.0), fit2('tile_granite', (1.7, 0.1), s), faces='+y+z', mat=M1)
        else:
            shop_door(mb, door_rc, 'destroyed', s + 1)
    else:
        x0, y0, x1, y1 = ops[0][1]
        a = fit2('alu', (0.6, 0.6), s)
        box_y = y1 - 0.24
        if state in ('intact', 'damaged'):
            # shutter box at the head + guide rails in the reveal
            mb.box((x0, box_y, -0.26), (x1, y1, -0.02), a, faces='+z-y', mat=M1)
            for gx in (x0, x1 - 0.05):
                mb.box((gx, y0, -0.09), (gx + 0.05, box_y, -0.03), a, faces='+z+x-x', mat=M1)
            if state == 'intact':
                shutter_curtain(mb, x0 + 0.03, x1 - 0.03, y0 + 0.02, box_y, -0.06, s)
            else:
                shutter_curtain(mb, x0 + 0.03, x1 - 0.03, 0.85, box_y, -0.06, s, bend=0.45, tear=-0.3)
                # behind: shop window with blown glass
                alu_frame(mb, (x0 + 0.06, y0, x1 - 0.06, box_y), -0.16, mullions=((x0 + x1) / 2,), seed=s + 5)
                shards(mb, (x0 + 0.12, y0 + 0.06, (x0 + x1) / 2 - 0.03, box_y - 0.06), -0.2, s + 6, n=4)
                shards(mb, ((x0 + x1) / 2 + 0.03, y0 + 0.06, x1 - 0.12, box_y - 0.06), -0.2, s + 7, n=4)
        elif state == 'holed':
            # curtain ripped from the box, draped out over the pavement
            rows = []
            for i in range(7):
                tt = i / 6
                rows.append([(x0 + 0.2 + 2.3 * sj + 0.1 * math.sin(tt * 4 + sj * 5), max(0.03, 1.85 - tt * 2.2) + 0.08 * math.sin(sj * 6),
                              -0.05 + max(0.0, tt - 0.6) * 1.8 + 0.06 * math.sin(sj * 9)) for sj in np.linspace(0, 1, 6)])
            reg = R2['shutter']
            mb.ribbon(rows, lambda s_, t_: reg.uv((s_ * 2.3) % 1.0001, (t_ * 2.0) % 1.0001), double=True, smooth=False, mat=M1)
            mb.box((x0, y0, -0.09), (x0 + 0.05, 1.4, -0.03), a, faces='+z+x-x', mat=M1)
        else:
            rows = []
            for i in range(5):
                tt = i / 4
                rows.append([(0.4 + 2.2 * sj, 0.05 + 0.25 * math.sin(tt * 3.1) * (0.6 + 0.4 * math.sin(sj * 7)), 0.3 + tt * 1.3) for sj in np.linspace(0, 1, 6)])
            reg = R2['shutter']
            mb.ribbon(rows, lambda s_, t_: reg.uv((s_ * 2.2) % 1.0001, (t_ * 1.3) % 1.0001), double=True, smooth=False, mat=M1)
    if state in ('holed', 'destroyed'):
        P = shop_hole(t) if state == 'holed' else shop_stub(t)[0]
        cx = P[:, 0].mean()
        for k in range(6):
            sz = r.uniform(0.12, 0.35)
            chunk2(mb, (float(np.clip(cx + r.normal(0, 0.7), 0.25, W - 0.25)), sz * 0.25, -T - 0.4 + r.normal(0, 0.15)), (sz, sz * 0.45, sz * 0.8), s + 20 + k, 'brick_sec_white')
        if state == 'destroyed':
            for k in range(4):
                sz = r.uniform(0.3, 0.5)
                chunk2(mb, (r.uniform(0.3, 2.9), sz * 0.25, -T - r.uniform(0.2, 1.1)), (sz, sz * 0.4, sz * 0.8), s + 30 + k, 'rubble')
    return mb


# ================================================================== signs
def sign_piece(k, state):
    key, text, style, L = SIGNS[k]
    kind = CA.SIGN_STYLE[style][4]
    mb = MB(f'sign_{key}_{state}')
    s = 6000 + k * 10 + (state == 'damaged'); r = rng(s)
    slot, art = CA.sign_rect(k)
    S = 2048.0
    art_reg = Region(*[int(round(v)) for v in art], pad=1)
    met = fit2('sign_metal', (1.0, 0.5), s)
    x0 = (W - L) / 2
    body = MB()
    if kind == 'lightbox':
        z0, z1 = 0.03, 0.17
        front = lambda P, n: [art_reg.uv((p[0] - x0) / L, p[1] / SIGN_H) for p in P]
        if state == 'intact':
            body.box((x0, 0, z0), (x0 + L, SIGN_H, z1), front, faces='+z', mat=M1)
        else:
            # front diffuser smashed on the right ~third: interior with tubes exposed
            xc = x0 + L * r.uniform(0.55, 0.7)
            pts = [(x0, 0, z1), (xc + 0.12, 0, z1), (xc - 0.05, SIGN_H * 0.45, z1), (xc + 0.08, SIGN_H, z1), (x0, SIGN_H, z1)]
            body.poly(pts, front, mat=M1)
            inner = fit2('lightbox', (1.0, 0.6), s)
            body.poly([(xc - 0.1, 0.02, z0 + 0.01), (x0 + L - 0.02, 0.02, z0 + 0.01), (x0 + L - 0.02, SIGN_H - 0.02, z0 + 0.01), (xc - 0.1, SIGN_H - 0.02, z0 + 0.01)], inner, mat=M1)
            for j in range(3):   # loose shards of the diffuser still in the frame
                yy = r.uniform(0.05, SIGN_H - 0.15)
                body.poly([(x0 + L - 0.03, yy, z1 - 0.01), (x0 + L - 0.03, yy + 0.12, z1 - 0.01), (x0 + L - r.uniform(0.15, 0.4), yy + 0.06, z1 - 0.01)], front, mat=M1)
            body.box((x0, 0, z0), (x0 + L, SIGN_H, z1), met, faces='-z', mat=M1)
        body.box((x0, 0, z0), (x0 + L, SIGN_H, z1), met, faces='+x-x+y-y', mat=M1)
    else:
        z0, z1 = 0.07, 0.095
        front = lambda P, n: [art_reg.uv((p[0] - x0) / L, p[1] / SIGN_H) for p in P]
        body.box((x0, 0, z0), (x0 + L, SIGN_H, z1), front, faces='+z', mat=M1)
        body.box((x0, 0, z0), (x0 + L, SIGN_H, z1), met, faces='-z+x-x+y-y', mat=M1)
    # brackets to the wall (two angle arms) — stay with the wall when the sign tilts
    for bx in (x0 + 0.25, x0 + L - 0.25):
        for by in (0.1, SIGN_H - 0.14):
            mb.box((bx - 0.02, by, 0.0), (bx + 0.02, by + 0.04, z0), met, faces='+x-x+y-y', mat=M1)
    if state == 'intact':
        mb.merge(body)
    else:
        # right bracket torn out: sign swings down around the upper-left bracket
        piv = (x0 + 0.25, SIGN_H - 0.12, z0)
        M = rot_axis((0, 0, 1), -r.uniform(0.2, 0.32), origin=piv) @ rot_axis((0, 1, 0), -0.08, origin=piv)
        mb.merge(body, M)
        # dangling cable
        e = xform(np.array([[x0 + L - 0.1, 0.05, (z0 + z1) / 2]]), M)[0]
        mb.tube([(x0 + L - 0.3, SIGN_H - 0.1, 0.01), (x0 + L - 0.25, SIGN_H - 0.6, 0.06), tuple(e)], 0.008, 3, len2('cable'), mat=M1)
    return mb


# ================================================================== roof pieces (origin: footprint centre on the roof surface)
def roof_machine_room():
    """Lift machine room of a 9/12-storey panel block: silicate-brick box on the roof with a steel door,
    louvre vents, cable entry, overhanging roof slab with felt. 4.4 x 3.0 x 2.9 m."""
    mb = MB('roof_machine_room')
    Wm, Dm, Hm = 4.4, 3.0, 2.9
    bw = R2['brick_white']
    x0, x1, z0, z1 = -Wm / 2, Wm / 2, -Dm / 2, Dm / 2
    # walls (front has the door opening 1.2..2.1)
    dx0, dx1, dh = 0.9, 1.8, 2.0
    tquad(mb, (x0, 0, z1), (1, 0, 0), (0, 1, 0), dx0 - x0, Hm, bw)
    tquad(mb, (dx1, 0, z1), (1, 0, 0), (0, 1, 0), x1 - dx1, Hm, bw)
    tquad(mb, (dx0, dh, z1), (1, 0, 0), (0, 1, 0), dx1 - dx0, Hm - dh, bw)
    tquad(mb, (x1, 0, z0), (-1, 0, 0), (0, 1, 0), Wm, Hm, bw)
    tquad(mb, (x1, 0, z1), (0, 0, -1), (0, 1, 0), Dm, Hm, bw)
    tquad(mb, (x0, 0, z0), (0, 0, 1), (0, 1, 0), Dm, Hm, bw)
    # door + reveal + threshold
    door = R2['roof_door']
    mb.poly([(dx0, 0, z1 - 0.12), (dx1, 0, z1 - 0.12), (dx1, dh, z1 - 0.12), (dx0, dh, z1 - 0.12)],
            lambda P, n: [door.uv(0, 0), door.uv(1, 0), door.uv(1, 1), door.uv(0, 1)], mat=M1)
    rv = fit2('reveal', (1.0, 1.0), 1)
    mb.box((dx0, 0, z1 - 0.12), (dx1, dh, z1), rv, faces='+x-x-y', mat=M1)
    mb.box((dx0 - 0.15, 0, z1), (dx1 + 0.15, 0.18, z1 + 0.35), fit2('conc_vent', (1.0, 0.4), 2), faces='+y+z+x-x', mat=M1)
    # louvres on both sides
    for (xa, sgn) in ((x1, 1), (x0, -1)):
        lv = R2['louvre']
        zA, zB = -0.5, 0.5
        P = [(xa + 0.01 * sgn, 1.6, zA), (xa + 0.01 * sgn, 1.6, zB), (xa + 0.01 * sgn, 2.3, zB), (xa + 0.01 * sgn, 2.3, zA)]
        if sgn < 0:
            P = P[::-1]
        mb.poly(P, lambda P_, n: [lv.uv(0, 0), lv.uv(1, 0), lv.uv(1, 1), lv.uv(0, 1)], mat=M1)
    # roof slab overhang + felt top
    conc = fit2('conc_vent', (2.0, 0.3), 3)
    mb.box((x0 - 0.15, Hm, z0 - 0.15), (x1 + 0.15, Hm + 0.16, z1 + 0.15), conc, faces='+x-x+z-z-y', mat=M1)
    rf = Proj(R['roofing'], (1, 0, 0), (0, 0, -1), (x0 - 0.15, -(z1 + 0.15)), (Wm + 0.3, Dm + 0.3))
    mb.poly([(x0 - 0.15, Hm + 0.16, z1 + 0.15), (x1 + 0.15, Hm + 0.16, z1 + 0.15), (x1 + 0.15, Hm + 0.16, z0 - 0.15), (x0 - 0.15, Hm + 0.16, z0 - 0.15)], rf)
    # felt upturn at the base and a cable conduit + light over the door
    mb.box((x0 - 0.02, 0, z0 - 0.02), (x1 + 0.02, 0.3, z1 + 0.02), Fit(R['roofing'], (2, 0.3), 5), faces='+x-x+z-z')
    mb.tube([(x0 + 0.3, Hm + 0.16, z1 - 0.3), (x0 + 0.3, Hm + 1.1, z1 - 0.3)], 0.03, 5, len_uv('galv'))
    mb.box((dx0 + 0.3, dh + 0.15, z1), (dx0 + 0.6, dh + 0.3, z1 + 0.12), Fit(R['metal_grey'], (0.3, 0.3), 6), faces='+z+x-x-y+y')
    return mb


def roof_vent():
    """Concrete ventilation shaft head on a flat roof: block with louvre slots, cap slab, two sewer vent pipes."""
    mb = MB('roof_vent')
    cv = R2['conc_vent']
    a, b, h = 0.7, 0.45, 1.25
    tbox(mb, (-a, 0, -b), (a, h, b), cv, (1.0, 1.0), faces='+x-x+z-z')
    lv = R2['louvre']
    for sgn in (1, -1):
        for xc in (-0.35, 0.35):
            z = sgn * (b + 0.005)
            P = [(xc - 0.22, 0.75, z), (xc + 0.22, 0.75, z), (xc + 0.22, 1.1, z), (xc - 0.22, 1.1, z)]
            if sgn < 0:
                P = [(p[0], p[1], p[2]) for p in P[::-1]]
            mb.poly(P, lambda P_, n: [lv.uv(0, 0), lv.uv(1, 0), lv.uv(1, 1), lv.uv(0, 1)], mat=M1)
    tbox(mb, (-a - 0.12, h, -b - 0.12), (a + 0.12, h + 0.12, b + 0.12), cv, (1.0, 1.0), faces='all')
    mb.box((-a - 0.02, 0, -b - 0.02), (a + 0.02, 0.25, b + 0.02), Fit(R['roofing'], (1.5, 0.3), 1), faces='+x-x+z-z')
    for (x, z, hh) in ((1.1, 0.2, 0.9), (1.3, -0.3, 0.7)):
        mb.tube([(x, 0, z), (x, hh, z)], 0.055, 6, len2('rust'), mat=M1, cap=True)
    return mb


def roof_antenna():
    """Collective TV antenna mast (galvanised) with three Yagi arrays and guy wires; top array bent by blast."""
    mb = MB('roof_antenna')
    ant = len2('antenna')
    Hm = 4.2
    mb.box((-0.3, 0, -0.3), (0.3, 0.08, 0.3), fit2('conc_vent', (0.6, 0.6), 1), faces='+y+x-x+z-z', mat=M1)
    mb.tube([(0, 0.08, 0), (0, Hm, 0), (0.15, Hm + 0.35, 0.05)], 0.035, 5, ant, mat=M1)
    for k, (y, L, yaw, droop) in enumerate(((2.2, 2.2, 0.3, 0.0), (3.1, 1.8, 0.9, 0.0), (3.95, 1.6, -0.4, 0.35))):
        d = np.array([math.cos(yaw), -droop, math.sin(yaw)]); d /= np.linalg.norm(d)
        p0 = np.array([0, y, 0]) - d * 0.3; p1 = p0 + d * L
        mb.tube([p0, p1], 0.014, 3, ant, smooth=False, mat=M1)
        perp = np.array([-d[2], 0, d[0]])
        for j in range(6 if k < 2 else 5):
            c = p0 + d * (0.15 + j * (L - 0.2) / 5)
            half = 0.55 - j * 0.06
            tw = perp * half + (np.array([0, -0.12, 0]) if (k == 2 and j > 2) else 0)
            mb.tube([c - perp * half, c + tw], 0.006, 3, ant, smooth=False, mat=M1)
    for a in (0.2, 2.3, 4.4):
        mb.tube([(0, Hm - 0.4, 0), (math.cos(a) * 2.6, 0.02, math.sin(a) * 2.6)], 0.004, 3, len2('cable'), smooth=False, mat=M1)
    return mb


# ================================================================== collections
def build_all():
    pieces = []
    for colour in COLOURS:
        for t in BTYPES:
            for st in STATES:
                pieces.append(brick_wall(colour, t, st))
        pieces.append(brick_parapet(colour))
    for t in SHOP_TYPES:
        for st in STATES:
            pieces.append(shop_wall(t, st))
    for k in range(len(SIGNS)):
        for st in ('intact', 'damaged'):
            pieces.append(sign_piece(k, st))
    pieces += [roof_machine_room(), roof_vent(), roof_antenna()]
    return pieces
