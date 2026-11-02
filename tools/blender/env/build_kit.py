"""Builds assets/env/panel_kit.glb (Soviet large-panel kit, 4 damage states) + manifest section.
Run: cd tools/blender/env && nice -n 10 python3 build_kit.py [--no-atlas]
"""
import os, sys, math, json, re
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from meshlib import *
from kit_design import *
from kitparts import *
import kit_atlas as KA
from meshfix import fix_mb, unfight

OUT = os.environ.get('OUT') or os.path.join(REPO, 'assets', 'env', 'panel_kit.glb')   # OUT=/tmp/x.glb NO_MANIFEST=1: QA build
SEEDS = {t: 100 * (i + 1) for i, t in enumerate(TYPES)}


# ------------------------------------------------------------------ walls
def build_wall(t, state):
    mb = MB(f'{t}_{state}')
    s = SEEDS[t] + STATES.index(state) * 13
    r = rng(s)
    opens = [rc for _, rc in OPEN[t]]
    if state in ('intact', 'damaged'):
        wall_slab(mb, t, state, opens, seed=s)
        for kind, rc in OPEN[t]:
            if kind == 'window':
                window_unit(mb, rc, 'wood' if t == 'wall_window' else 'pvc', state, s + 1)
            elif kind == 'door':
                balcony_door_unit(mb, rc, 'pvc', state, s + 2)
            else:
                entrance_door_unit(mb, rc, state, s + 3)
        if state == 'damaged':
            if t == 'wall_window':
                x0, y0, x1, y1 = OPEN[t][0][1]
                top = [(x0 + 0.14 + 0.09 * j, y1 - 0.1, -0.2) for j in range(3)]
                def drop(sv, tv, p, x0=x0, y0=y0, y1=y1):
                    # torn curtain hanging inside the broken pane, its lower end sucked out over the sill
                    y = p[1] + (y0 + 0.12 - p[1]) * tv
                    z = -0.2 + 0.24 * max(0.0, (tv - 0.55) / 0.45) ** 1.5
                    return (p[0] + 0.05 * math.sin(tv * 5 + sv * 3) + 0.06 * tv, y, z + 0.02 * math.sin(sv * 6 + tv * 4))
                cloth(mb, top, drop, 7, s + 4)
            if t == 'wall_balcony':
                x0, y0, x1, y1 = OPEN[t][1][1]
                mb.box((x0 + 0.03, y0 + 0.03, -0.1), (x1 - 0.03, y0 + 0.92, -0.085), Fit(R['osb'], (1.25, 0.9), s), faces='+z+y-y+x-x')
    elif state == 'holed':
        hd = hole_poly(t, full=True); hp = hd['poly']
        rings, lv = wall_slab(mb, t, state, [rc for _, rc in hd['remaining']], hole=hd, seed=s)
        ring = rings[-1]
        bm_cw = np.asarray(hd['broken'])[::-1]
        for zi, nb in ((2, 12), (5, 10)):
            poly = ring[zi][:, :2]
            zc = (lv[zi] + lv[zi - 1]) / 2 if zi == 2 else (lv[zi] + lv[zi + 1]) / 2
            rebar_from_edges(mb, lambda x, y, poly=poly: not point_in_poly((x, y), poly), {zc: poly}, s + zi, nb, edge_mask=bm_cw)
        for kind, rc in hd['remaining']:
            if kind == 'window':
                window_unit(mb, rc, 'wood' if t == 'wall_window' else 'pvc', 'damaged', s + 1)
        if 'window' in hd['merged']:
            # what is left of the window: head member, upper-left stile and the fortochka with shards
            x0, y0, x1, y1 = hd['rects'][hd['merged'].index('window')]
            reg = 'wood_paint' if t == 'wall_window' else 'pvc'
            frame_box(mb, (x0, y1 - 0.07, -0.175), (x1, y1, -0.105), '+z-y', reg, s)
            frame_box(mb, (x0, y1 - 0.75, -0.175), (x0 + 0.07, y1 - 0.07, -0.105), '+z+x-y', reg, s + 1)
            xm = x0 + (x1 - x0) * 0.47
            sash(mb, x0 + 0.07, y1 - 0.39, xm - 0.035, y1 - 0.07, -0.093, reg, glass='shards', seed=s + 2)
        lo = ring[0][np.argsort(ring[0][:, 1])[:8]]
        cx, cy = hp[:, 0].mean(), hp[:, 1].mean()
        # chunks resting on the lower broken lip
        for k in range(4):
            p = lo[r.integers(0, len(lo))]
            sz = r.uniform(0.1, 0.22)
            chunk(mb, (p[0] + r.normal(0, 0.1), p[1] + sz * 0.3, -r.uniform(0.08, 0.25)), (sz, sz * 0.6, sz * 0.8), s + 40 + k)
        if t in ('wall_window', 'wall_balcony'):
            radiator(mb, 0, 0, 0, M=mat_trs((cx - 0.45, 0.12, -T - 0.03)) @ mat_trs((0, 0, 0), (0.15, 0, -0.22)), seed=s)
        # rag curtain hanging from the top lip
        tp = ring[0][np.argmax(ring[0][:, 1])]
        top = [(tp[0] - 0.2 + 0.12 * j, tp[1] - 0.06, -0.24) for j in range(3)]
        cloth(mb, top, lambda sv, tv, p: (p[0] + 0.06 * math.sin(tv * 4 + sv * 2), p[1] - tv * 0.6, p[2] + 0.04 * math.sin(sv * 5 + tv * 3)), 5, s + 50)
        if t == 'wall_balcony':
            balcony_stub(mb, s)
        if t == 'wall_entrance':
            entrance_door_unit(mb, OPEN[t][0][1], 'holed', s)
    else:
        P, bm = stub_outline(t)
        rings, lv = wall_slab(mb, t, state, [], stub=(P, bm), seed=s)
        ring = rings[0]
        for zi, nb in ((2, 11), (5, 10)):
            poly = ring[zi][:, :2]
            zc = (lv[zi] + lv[zi - 1]) / 2 if zi == 2 else (lv[zi] + lv[zi + 1]) / 2
            rebar_from_edges(mb, lambda x, y, poly=poly: point_in_poly((x, y), poly), {zc: poly}, s + zi, nb, bridge=False, bend_out=0.8)
        # chunks on the stub top and on the floor inside
        tops = ring[0][2:-1]
        for k in range(3):
            p = tops[r.integers(0, len(tops))]
            sz = r.uniform(0.12, 0.25)
            chunk(mb, (p[0], p[1] + sz * 0.2, -r.uniform(0.08, 0.22)), (sz, sz * 0.5, sz * 0.8), s + 60 + k)
        for k in range(5):
            sz = r.uniform(0.15, 0.4)
            chunk(mb, (r.uniform(0.3, W - 0.3), sz * 0.2, -T - r.uniform(0.15, 0.7)), (sz, sz * 0.45, sz * 0.8), s + 70 + k,
                  region='section_clean' if k % 2 else 'section')
        if t in ('wall_window', 'wall_balcony'):
            radiator(mb, 0, 0, 0, M=mat_trs((1.0, 0.07, -T - 0.25)) @ mat_trs((0, 0, 0), (-1.2, 0.3, 0)), pipes=False)
        if t == 'wall_entrance':
            entrance_door_unit(mb, OPEN[t][0][1], 'destroyed', s)
    return mb


def balcony_stub(mb, s):
    """Broken-off root of the balcony slab sticking out of a holed balcony panel (the full balcony_slab is
    removed by the game at state >= holed)."""
    r = rng(s + 5)
    xs = np.linspace(2.95, 0.25, 9)
    depth = 0.25 + 0.12 * np.sin(xs * 3.0) + r.normal(0, 0.05, len(xs))
    outline = [(0.25, 0.0), (2.95, 0.0)] + [(x, d) for x, d in zip(xs, depth)]
    bm = [False, False] + [True] * len(xs); bm[2] = False; bm[-1] = False
    tmp = MB()
    conc = Fit(R['concrete'], (2.0, 1.25), s)
    sect = side_uv(R['section_clean'], 2.0)
    loop = {'pts': np.array(outline), 'off': broken_off(len(outline), s, np.array(bm), ch=0.0, levels=4)}
    slab(tmp, [loop], [0, -0.03, -0.11, -0.14], conc, conc, lambda a, b, fa, fb, li, k, P, i: sect(a, b, fa, fb, li))
    # local (x, d, depth) -> world (x, -depth, d): slab top at y = 0.14, bottom 0
    M = np.array([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1.0]])
    mb.merge(tmp, M)
    for k in range(4):
        x = r.uniform(0.4, 2.8); d = 0.25
        rebar_bar(mb, [(x, 0.03, d - 0.05), (x, 0.03, d + 0.1), (x + r.normal(0, 0.05), -0.25, d + 0.25), (x + r.normal(0, 0.1), -0.6 - r.random() * 0.3, d + 0.3)])


# ------------------------------------------------------------------ slabs, parapet, plinth, stairs
def build_slab_floor(broken=False):
    D, Th = W, 0.22
    mb = MB('slab_floor_broken' if broken else 'slab_floor')
    top = Proj(R['floor'], (1, 0, 0), (0, 1, 0), (0, 0), (W, D))
    bot = Proj(R['ceiling'], (1, 0, 0), (0, 1, 0), (0, 0), (W, D))
    sectc = side_uv(R['section_clean'], 2.0); sect = side_uv(R['section'], 2.0)
    # local: x across, y = distance from facade inward (0..D), depth = thickness; world = (x, Th + z, -y)
    M = np.array([[1, 0, 0, 0], [0, 0, 1, Th], [0, -1, 0, 0], [0, 0, 0, 1.0]])
    if not broken:
        loop = {'pts': np.array([(0, 0), (W, 0), (W, D), (0, D)], float), 'off': clean_off(0.012)}
        tmp = MB(); slab(tmp, [loop], [0, -0.012, -Th], top, bot, lambda a, b, fa, fb, li, k, P, i: sectc(a, b, fa, fb, li))
        mb.merge(tmp, M)
        return mb
    r = rng(77)
    xs = np.linspace(0, W, 7)
    brk = 1.45 + 0.25 * np.sin(xs * 1.7) + r.normal(0, 0.08, len(xs))
    # A: fixed part (brk..D)
    A = [(x, b) for x, b in zip(xs, brk)] + [(W, D), (0, D)]
    bmA = [True] * len(xs) + [False, False]
    bmA[0] = bmA[-3] = False
    B = [(0, 0), (W, 0)] + [(x, b) for x, b in zip(xs[::-1], brk[::-1])]
    bmB = [False, False] + [True] * len(xs)
    bmB[2] = bmB[-1] = False
    def uvs(bm):
        def f(a, b, fa, fb, li, k, P, i):
            n = len(bm)
            return (sect if (bm[i] and bm[(i + 1) % n]) else sectc)(a, b, fa, fb, li)
        return f
    tA = MB(); slab(tA, [{'pts': ccw(np.array(A)), 'off': broken_off(len(A), 5, np.array(bmA), ch=0.0, levels=3, scale=0.6)}], [0, -0.05, -Th], top, bot, uvs(bmA))
    mb.merge(tA, M)
    tB = MB(); slab(tB, [{'pts': ccw(np.array(B)), 'off': broken_off(len(B), 6, np.array(bmB), ch=0.0, levels=3, scale=0.6)}], [0, -0.05, -Th], top, bot, uvs(bmB))
    hz = -float(brk.max())
    Mh = rot_axis((1, 0, 0), 0.62, origin=(0, 0.02, hz))
    mb.merge(tB, Mh @ M)
    # rebar holding the hanging half (bottom reinforcement)
    for x in (0.5, 1.6, 2.7):
        bz = -float(np.interp(x, xs, brk))
        p0 = np.array([x, 0.03, bz - 0.15]); p1 = np.array([x, 0.0, bz + 0.05])
        p2 = xform(np.array([[x, 0.03, bz + 0.2]]), Mh)[0]
        rebar_bar(mb, [p0, p1, (p1 + p2) / 2 + [0, -0.06, 0], p2], sides=3)
    return mb


def build_parapet():
    mb = MB('roof_parapet'); Hp = 0.72
    conc = Proj(R['concrete'], (1, 0, 0), (0, 1, 0), (0, 0), (W, 1.25))
    sectc = side_uv(R['section_clean'], 2.0)
    loop = {'pts': np.array([(0, 0), (W, 0), (W, Hp), (0, Hp)], float), 'off': lambda k, i: (CHAMFER, 0) if (k == 0 and i in (2, 3)) else (0, 0)}
    slab(mb, [loop], [0, -CHAMFER, -T], conc, conc, lambda a, b, fa, fb, li, k, P, i: sectc(a, b, fa, fb, li))
    # galvanised cap with a drip on the roof side (outer edge flush with the facade plane)
    g = Fit(R['galv'], (1.6, 0.4), 3)
    mb.poly([(0, Hp + 0.03, 0), (W, Hp + 0.03, 0), (W, Hp + 0.02, -T - 0.05), (0, Hp + 0.02, -T - 0.05)], g)
    mb.poly([(0, Hp + 0.02, -T - 0.05), (W, Hp + 0.02, -T - 0.05), (W, Hp - 0.06, -T - 0.06), (0, Hp - 0.06, -T - 0.06)], g)
    mb.poly([(W, Hp - 0.06, -T - 0.06), (0, Hp - 0.06, -T - 0.06), (0, Hp + 0.02, -T - 0.05), (W, Hp + 0.02, -T - 0.05)], g)
    # roofing felt upturn on the roof side + fillet
    rf = Fit(R['roofing'], (1.6, 0.6), 4)
    mb.poly([(W, 0.18, -T - 0.002), (0, 0.18, -T - 0.002), (0, 0.48, -T - 0.002), (W, 0.48, -T - 0.002)], rf)
    mb.poly([(W, 0.18, -T - 0.14), (0, 0.18, -T - 0.14), (0, 0.32, -T - 0.002), (W, 0.32, -T - 0.002)], rf)
    # old TV antenna bracket clamp + broken mast stub
    mb.tube([(2.4, 0.3, -T - 0.08), (2.4, 1.6, -T - 0.08), (2.45, 1.9, -T - 0.12)], 0.02, 5, len_uv('metal_grey'))
    mb.tube([(2.4, 1.3, -T - 0.08), (2.0, 1.45, -T - 0.08)], 0.008, 3, len_uv('metal_grey'))
    mb.tube([(2.4, 1.3, -T - 0.08), (2.8, 1.42, -T - 0.08)], 0.008, 3, len_uv('metal_grey'))
    return mb


def build_plinth():
    mb = MB('plinth'); Hp, Tp = 0.9, 0.45
    pl = Proj(R['plinth'], (1, 0, 0), (0, 1, 0), (0, 0), (W, Hp))
    sectc = side_uv(R['section_clean'], 2.0)
    outer = {'pts': np.array([(0, 0), (W, 0), (W, Hp), (0, Hp)], float), 'off': clean_off(0.02)}
    vent = {'pts': cw(np.array([(1.35, 0.32), (1.85, 0.32), (1.85, 0.6), (1.35, 0.6)], float)), 'off': clean_off(0.0)}
    slab(mb, [outer, vent], [0, -0.02, -Tp], pl, Proj(R['concrete'], (1, 0, 0), (0, 1, 0), (0, 0), (W, 1.25)), lambda a, b, fa, fb, li, k, P, i: pl(P, None) if k == 0 else sectc(a, b, fa, fb, li))
    for k in range(6):  # vent grille bars
        x = 1.38 + k * 0.088
        mb.box((x, 0.32, -0.12), (x + 0.012, 0.6, -0.1), Fit(R['rail_paint'], (0.1, 0.3), k), faces='+z+x-x')
    glass_quad(mb, 1.35, 0.32, 1.85, 0.6, -0.3, region='soot')
    return mb


def build_stair():
    mb = MB('stair_core'); rise, tread, n = 0.1556, 0.3, 9
    st = R['stair']; conc = Fit(R['concrete'], (2.0, 1.25), 1)
    def flight(x0, x1, z_start, y_start, direction):
        # direction -1: climbs towards -z? we climb towards the facade (+z) for flight 1 and away for flight 2
        pts_side = []
        for k in range(n):
            y = y_start + k * rise; za = z_start + direction * k * tread; zb = za + direction * tread
            # riser (faces the person walking up)
            P = [(x0, y, za), (x1, y, za), (x1, y + rise, za), (x0, y + rise, za)]
            mb.poly(P[::-1] if direction > 0 else P, Fit(st, (1.4, 0.3), k))
            # tread
            P = [(x0, y + rise, za), (x1, y + rise, za), (x1, y + rise, zb), (x0, y + rise, zb)]
            mb.poly(P if direction < 0 else P[::-1], Fit(st, (1.4, 0.3), k + 20))
        # sloped soffit
        za, zb = z_start, z_start + direction * n * tread
        ya, yb = max(0.0, y_start - 0.18), y_start + n * rise - 0.18
        P = [(x0, ya, za), (x1, ya, za), (x1, yb, zb), (x0, yb, zb)]
        mb.poly(P if direction > 0 else P[::-1], conc)
        # stepped side stringers (both sides)
        prof = [(z_start, max(0.0, y_start - 0.18)), (z_start, y_start)] if y_start > 0.1 else [(z_start, 0.0)]
        for k in range(n):
            za = z_start + direction * k * tread
            prof += [(za, y_start + (k + 1) * rise), (za + direction * tread, y_start + (k + 1) * rise)]
        prof += [(zb, yb)]
        for x, flip in ((x0, True), (x1, False)):
            P = [(x, yy, zz) for zz, yy in prof]
            # fan triangulation of the (simple, monotone) profile
            from meshlib import tessellate
            tris = tessellate([np.array([(zz, yy) for zz, yy in prof])])
            for tri in tris:
                Q = [P[i] for i in tri]
                nrm = newell(np.array(Q))
                want = -1 if flip else 1
                if nrm[0] * want < 0:
                    Q = Q[::-1]
                mb.poly(Q, conc)
    # flight 1: from the floor landing (z = -4.2) up towards the facade to the mid landing (y = 1.4)
    flight(0.12, 1.52, -4.2, 0.0, +1)
    # flight 2: from the mid landing back to the next floor (y = 2.8 at z = -4.2)
    flight(1.68, 3.08, -1.5, 1.4, -1)
    # mid landing slab against the facade (stairwell windows sit at this half-level)
    mb.box((0.0, 1.24, -1.5), (W, 1.4, 0.0), Fit(st, (1.6, 1.6), 3), faces='+y-y+z-z+x-x')
    # railings: balusters + wooden handrail on the inner edges of both flights
    for (x, z_start, y_start, d) in ((1.52, -4.2, 0.0, 1), (1.68, -1.5, 1.4, -1)):
        top = []
        for k in range(0, n, 2):
            z = z_start + d * (k + 0.5) * tread; y = y_start + (k + 1) * rise
            mb.tube([(x, y, z), (x, y + 0.9, z)], 0.008, 3, len_uv('metal_grey'), smooth=False)
        p0 = (x, y_start + rise + 0.9, z_start + d * 0.15); p1 = (x, y_start + n * rise + 0.9, z_start + d * (n - 0.3) * tread)
        mb.tube([p0, p1], 0.025, 4, len_uv('veneer', 2.0), smooth=False)
    return mb


# ------------------------------------------------------------------ accessories
def corrugated(mb, x0, x1, y0, y1, z, axis='x', period=0.2, amp=0.018, seed=0):
    """Corrugated asbestos-cement sheet strip (double-sided), waves along the strip."""
    reg = R['asbestos']
    L = abs(x1 - x0); nseg = max(2, int(round(L / (period / 2))))
    rows = []
    for yy in (y0, y1):
        row = []
        for k in range(nseg + 1):
            u = k / nseg; a = x0 + (x1 - x0) * u
            off = amp * (1 if k % 2 == 0 else -1)
            row.append((a, yy, z + off) if axis == 'x' else (z + off, yy, a))
        rows.append(row)
    mb.ribbon(rows, lambda s, t: reg.uv((s * L / 1.6) % 1.0001, t), double=True, smooth=False)


def build_balcony(kind='mixed', name='balcony_slab'):
    mb = MB(name); r = rng(sum(map(ord, name)))
    x0, x1, D, Th = 0.15, W - 0.15, 1.05, 0.14
    conc = Fit(R['concrete'], (2.0, 1.25), 2, stretch=False)
    sectc = side_uv(R['concrete'], 2.0)
    tmp = MB()
    loop = {'pts': np.array([(x0, 0), (x1, 0), (x1, D), (x0, D)], float), 'off': lambda k, i: (0.012, 0) if (k == 0 and i >= 1) else (0, 0)}
    slab(tmp, [loop], [0, -0.012, -Th], conc, conc, lambda a, b, fa, fb, li, k, P, i: sectc(a, b, fa, fb, li))
    mb.merge(tmp, np.array([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1.0]]))   # top at y = Th
    rail = 'rail_paint'
    # steel railing: posts (angle sections), top rail
    for (px, pz) in ((x0 + 0.03, D - 0.03), (x1 - 0.03, D - 0.03), ((x0 + x1) / 2, D - 0.03), (x0 + 0.03, 0.5), (x1 - 0.03, 0.5)):
        mb.box((px - 0.02, Th, pz - 0.02), (px + 0.02, 1.0, pz + 0.02), Fit(R[rail], (0.1, 1.0), int(px * 10)), faces='+x-x+z-z')
    mb.box((x0, 0.97, D - 0.05), (x1, 1.02, D), Fit(R[rail], (1.0, 0.1), 5), faces='+y+z-z-y')
    mb.box((x0, 0.97, 0.02), (x0 + 0.05, 1.02, D - 0.05), Fit(R[rail], (1.0, 0.1), 6), faces='+y+x-x')
    mb.box((x1 - 0.05, 0.97, 0.02), (x1, 1.02, D - 0.05), Fit(R[rail], (1.0, 0.1), 7), faces='+y+x-x')
    # corrugated asbestos-cement parapet sheets, one front sheet slightly displaced (blast)
    corrugated(mb, x0 + 0.02, (x0 + x1) / 2, Th - 0.08, 0.98, D - 0.07)
    corrugated(mb, (x0 + x1) / 2, x1 - 0.02, Th - 0.06, 0.96, D - 0.08)
    corrugated(mb, 0.03, D - 0.09, Th - 0.08, 0.98, x0 + 0.07, axis='z')
    corrugated(mb, 0.03, D - 0.09, Th - 0.08, 0.98, x1 - 0.07, axis='z')
    if kind in ('mixed', 'glazed'):
        # residents' glazing: mismatched wooden frames + one white PVC section + a plywood pane
        y0g, y1g = 1.02, 2.62
        zf = D - 0.06
        posts = np.linspace(x0 + 0.03, x1 - 0.03, 5)
        for k, px in enumerate(posts):
            mb.box((px - 0.03, y0g, zf - 0.06), (px + 0.03, y1g, zf), Fit(R['wood_paint'], (0.2, 1.6), k), faces='+z-z+x-x')
        mb.box((x0, y0g, zf - 0.07), (x1, y0g + 0.05, zf), Fit(R['wood_paint'], (1.5, 0.2), 9), faces='+z+y-z')
        mb.box((x0, y1g - 0.05, zf - 0.07), (x1, y1g, zf), Fit(R['wood_paint'], (1.5, 0.2), 10), faces='+z-y-z+y')
        for k in range(4):
            a, b = posts[k] + 0.03, posts[k + 1] - 0.03
            style = ['wood', 'pvc', 'wood', 'board'][k] if kind == 'mixed' else 'wood'
            if style == 'board':
                mb.box((a, y0g + 0.05, zf - 0.04), (b, y1g - 0.6, zf - 0.025), Fit(R['osb'], (0.7, 1.0), k), faces='+z-z')
                shards(mb, (a, y1g - 0.6, b, y1g - 0.05), zf - 0.035, 90 + k, 3)
                continue
            reg = 'pvc' if style == 'pvc' else 'wood_paint'
            gl = 'full' if (k != 2 or kind == 'glazed') else 'shards'
            sash(mb, a, y0g + 0.05, b, y1g - 0.05, zf - 0.005, reg, sw=0.045, depth=0.04, glass=gl, seed=200 + k, sub=(0.1 * k, 0, 0.1 * k + 0.6, 1))
            if gl == 'full':
                # inner face of the glass so it reads from inside / above too
                reg2 = R['glass']
                P = [(b - 0.045, y0g + 0.095, zf - 0.03), (a + 0.045, y0g + 0.095, zf - 0.03), (a + 0.045, y1g - 0.095, zf - 0.03), (b - 0.045, y1g - 0.095, zf - 0.03)]
                mb.poly(P, lambda P_, n: [reg2.uv(0, 0), reg2.uv(1, 0), reg2.uv(1, 1), reg2.uv(0, 1)])
        # side glazing (one side, other side boarded with asbestos sheet)
        mb.box((x0 + 0.02, y0g, 0.05), (x0 + 0.06, y1g, D - 0.08), Fit(R['wood_paint'], (1.0, 1.6), 11), faces='+y')
        sash(mb, 0, 0, D - 0.15, y1g - y0g, 0, 'wood_paint', sw=0.045, glass='full', seed=300,
             M=mat_trs((x0 + 0.04, y0g, 0.08)) @ mat_trs((0, 0, 0), (0, -math.pi / 2, 0)) @ mat_trs((0, 0, 0)))
        corrugated(mb, 0.05, D - 0.08, y0g, y1g, x1 - 0.06, axis='z', amp=0.015)
    else:
        # open balcony: washing line, crate, old ski, plant pots
        mb.tube([(x0 + 0.05, 1.6, 0.25), (x1 - 0.05, 1.55, 0.27)], 0.004, 3, len_uv('rubber'))
        mb.tube([(x0 + 0.05, 1.6, 0.6), (x1 - 0.05, 1.56, 0.62)], 0.004, 3, len_uv('rubber'))
        cloth(mb, [(0.9 + 0.12 * j, 1.57, 0.26) for j in range(4)], lambda s, t, p: (p[0], p[1] - t * 0.55, p[2] + 0.02 * math.sin(s * 9)), 3, 31)
    # clutter on the slab: crate, jars box, tyre-like ring
    mb.box((x1 - 0.55, Th, 0.08), (x1 - 0.12, Th + 0.35, 0.45), Fit(R['osb'], (0.5, 0.4), 12), faces='+y+z-x+x')
    mb.box((x0 + 0.1, Th, 0.1), (x0 + 0.45, Th + 0.25, 0.4), Fit(R['veneer'], (0.4, 0.3), 13), faces='+y+z+x')
    # soot / rust drip on the slab front is in the concrete texture; drainage spout
    mb.tube([(x1 - 0.2, 0.05, D - 0.02), (x1 - 0.2, 0.04, D + 0.08)], 0.02, 4, len_uv('galv'))
    return mb


def build_balcony_hanging():
    """Balcony slab torn from the wall, hanging by its top reinforcement. Hinge at local y = HINGE above bbox min."""
    base = build_balcony('open', 'tmp')
    mb = MB('balcony_hanging'); r = rng(5)
    # rotate the whole balcony down about the hinge at the wall face (z=0, y=0.14) by ~72 degrees, twist a bit
    M = rot_axis((1, 0, 0), 1.25, origin=(0, 0.14, 0)) @ rot_axis((0, 0, 1), 0.12, origin=(W / 2, 0.14, 0))
    sub = MB(); sub.V = list(base.V); sub.F = list(base.F)
    mb.merge(sub, M)
    # rebar from the wall (z=0) to the slab root
    for x in (0.4, 0.9, 1.5, 2.1, 2.6):
        a = np.array([x, 0.08, -0.05]); b = xform(np.array([[x, 0.08, 0.15]]), M)[0]
        rebar_bar(mb, [a, (a + b) / 2 + [0, 0.05, 0.12], b + [0, 0, 0.02], b])
    return mb


def build_canopy():
    mb = MB('entrance_canopy')
    x0, x1, D, Th = 0.45, W - 0.45, 1.25, 0.12
    conc = Fit(R['concrete'], (2.0, 1.25), 8)
    sectc = side_uv(R['concrete'], 2.0)
    tmp = MB()
    loop = {'pts': np.array([(x0, 0), (x1, 0), (x1, D), (x0, D)], float), 'off': lambda k, i: (0.01, 0) if k == 0 else (0, 0)}
    slab(tmp, [loop], [0, -0.01, -Th], conc, Proj(R['roofing'], (1, 0, 0), (0, 1, 0), (0, 0), (W, 1.3)), lambda a, b, fa, fb, li, k, P, i: sectc(a, b, fa, fb, li))
    mb.merge(tmp, np.array([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1.0]]))
    # roofing felt lip and a bit of debris on top
    rf = Fit(R['roofing'], (2.3, 0.2), 1)
    mb.box((x0, Th, D - 0.04), (x1, Th + 0.06, D), rf, faces='+y+z-z+x-x')
    chunk(mb, (x0 + 0.6, Th + 0.05, 0.6), (0.25, 0.1, 0.2), 81)
    chunk(mb, (x1 - 0.5, Th + 0.04, 0.4), (0.18, 0.08, 0.15), 82, region='section_clean')
    # steel tie rods to the wall above
    for x in (x0 + 0.08, x1 - 0.08):
        mb.tube([(x, Th + 0.02, D - 0.08), (x, 0.95, 0.02)], 0.012, 4, len_uv('metal_grey'))
    # lamp housing under the canopy edge (hangs only 0.08 below)
    mb.box((W / 2 - 0.1, -0.06, 0.2), (W / 2 + 0.1, 0.0, 0.38), Fit(R['metal_grey'], (0.2, 0.2), 3), faces='-y+x-x+z')
    return mb


# ------------------------------------------------------------------ interior partition + furniture debris
def build_partition(state):
    mb = MB('partition_wall_' + state); Hp, Tp = H - 0.22, 0.08
    wp = Proj(R['interior'], (1, 0, 0), (0, 1, 0), (0, 0), (W, H))
    sectc = side_uv(R['section_clean'], 2.0)
    outer = np.array([(0, 0), (1.9, 0), (1.9, 2.0), (2.7, 2.0), (2.7, 0), (W, 0), (W, Hp), (0, Hp)], float)
    loops = [{'pts': outer, 'off': clean_off(0.0)}]
    lv = [0, -Tp]
    if state == 'holed':
        hp = cw(blob(0.95, 1.3, 0.55, 0.6, 26, 707, rough=0.3, spikes=0.3))
        loops.append({'pts': hp, 'off': broken_off(len(hp), 708, ch=0.0, levels=4, scale=0.5)})
        lv = [0, -0.015, -0.065, -Tp]
    slab(mb, loops, lv, wp, wp, lambda a, b, fa, fb, li, k, P, i: sectc(a, b, fa, fb, li))
    if state == 'holed':
        r = rng(709)
        for k in range(4):
            sz = r.uniform(0.1, 0.22)
            chunk(mb, (0.95 + r.normal(0, 0.4), sz * 0.25, r.choice([-0.4, 0.3]) + r.normal(0, 0.1)), (sz, sz * 0.4, sz * 0.7), 710 + k, region='section_clean')
    return mb


def build_wardrobe():
    """Soviet three-door wardrobe toppled forward, one door torn off."""
    mb = MB('debris_wardrobe'); v = Fit(R['veneer'], (1.0, 2.0), 1)
    Wd, Hd, Dd, t = 1.2, 1.9, 0.55, 0.018
    tmp = MB()
    for (mn, mx) in (((0, 0, 0), (Wd, t, Dd)), ((0, Hd - t, 0), (Wd, Hd, Dd)), ((0, 0, 0), (t, Hd, Dd)), ((Wd - t, 0, 0), (Wd, Hd, Dd)),
                     ((0, 0, 0), (Wd, Hd, 0.004)), ((Wd / 2 - t / 2, 0, 0), (Wd / 2 + t / 2, Hd, Dd))):
        tmp.box(mn, mx, v)
    tmp.box((0.02, 0.02, Dd), (Wd / 2 - 0.01, Hd - 0.02, Dd + t), v)
    # lying on its front, slightly tilted on debris
    mb.merge(tmp, mat_trs((0, 0.06, 0), (-math.pi / 2 + 0.08, 0.3, 0)))
    door = MB(); door.box((0, 0, 0), (Wd / 2 - 0.02, Hd - 0.04, t), v)
    mb.merge(door, mat_trs((1.0, 0.03, 0.6), (-math.pi / 2, 0, 0.4)))
    return mb


def build_bed():
    mb = MB('debris_bed'); m = Fit(R['metal_grey'], (1, 1), 2)
    L, Wb, h = 1.95, 0.85, 0.45
    for x in (0, Wb):
        mb.tube([(x, 0, 0), (x, h, 0), (x, h, L), (x, 0.25, L + 0.02)], 0.015, 4, len_uv('metal_grey'), smooth=False)
    for z in (0, L):
        mb.tube([(0, h, z), (Wb, h, z)], 0.015, 4, len_uv('metal_grey'))
        for k in range(6):
            x = 0.07 + k * (Wb - 0.14) / 5
            mb.tube([(x, h, z), (x, h + (0.45 if z == 0 else 0.3), z)], 0.008, 3, len_uv('metal_grey'))
        mb.tube([(0, h + (0.45 if z == 0 else 0.3), z), (Wb, h + (0.45 if z == 0 else 0.3), z)], 0.015, 4, len_uv('metal_grey'))
    # sagging mattress, half slid off
    rows = []
    for i in range(5):
        t = i / 4; z = t * L
        y = h + 0.12 - 0.08 * math.sin(t * math.pi)
        rows.append([(x, y + (0.0 if t < 0.8 else -(t - 0.8) * 1.5), z + 0.02) for x in np.linspace(0.02, Wb + 0.25 * t, 4)])
    mb.ribbon(rows, lambda s, t: R['fabric'].uv(s, t), double=True)
    return mb


def build_table():
    mb = MB('debris_table'); v = Fit(R['veneer'], (1.0, 1.0), 3)
    tmp = MB(); tmp.box((0, 0.72, 0), (1.1, 0.75, 0.7), v)
    for (x, z) in ((0.05, 0.05), (1.0, 0.05), (0.05, 0.6)):
        tmp.box((x, 0, z), (x + 0.045, 0.72, z + 0.045), v, faces='+x-x+z-z')
    # broken leg -> table tipped over on one corner
    mb.merge(tmp, rot_axis((1, 0, 1), 0.5, origin=(1.05, 0, 0.65)))
    # chair on its side
    ch = MB(); ch.box((0, 0.43, 0), (0.42, 0.46, 0.42), v)
    ch.box((0, 0.46, 0.38), (0.42, 0.9, 0.42), v)
    for (x, z) in ((0, 0), (0.38, 0), (0, 0.38), (0.38, 0.38)):
        ch.box((x, 0, z), (x + 0.035, 0.43, z + 0.035), v, faces='+x-x+z-z')
    mb.merge(ch, mat_trs((1.5, 0.21, 0.2), (0, 0.6, math.pi / 2)))
    return mb


def build_radiator_debris():
    mb = MB('debris_radiator')
    radiator(mb, 0, 0, 0, w=1.0, M=mat_trs((0, 0.13, 0), (-math.pi / 2, 0.3, 0)), pipes=True)
    return mb


# ------------------------------------------------------------------ main
def main():
    no_atlas = '--no-atlas' in sys.argv
    paths = [os.path.join(KA.CACHE, f'kit_atlas_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    if not no_atlas or not os.path.exists(paths[0]):
        paths = KA.build_atlas()
    import city_kit_atlas as CKA, kit_city_parts as KCP, kit_collapse as KCO
    paths2 = [os.path.join(KA.CACHE, f'kit_atlas_city_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    if not no_atlas or not os.path.exists(paths2[0]):
        paths2 = CKA.build_atlas()
    import kit_damage_atlas as KDA, kit_damage as KDM
    paths3 = [os.path.join(KA.CACHE, f'kit_atlas_damage_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    if not no_atlas or not os.path.exists(paths3[0]):
        paths3 = KDA.build_atlas()
    reset_scene()
    mat = make_material('kit_panel', *paths)
    mat2 = make_material('kit_city', *paths2)
    mat3 = make_material('kit_damage', *paths3)
    pieces = []
    for t in TYPES:
        for s in STATES:
            mb = build_wall(t, s)
            if s == 'destroyed':     # structural frame (ceiling-slab edge, transverse wall ends, floor screed)
                KDM.structure_v1(mb, 'panel', SEEDS[t] + 3 * 13, None)
            pieces.append(mb)
    pieces += [build_slab_floor(False), build_slab_floor(True), build_parapet(), build_plinth(), build_stair(),
               build_balcony('mixed', 'balcony_slab'), build_balcony('open', 'balcony_slab_open'),
               build_balcony('glazed', 'balcony_slab_glazed'), build_balcony_hanging(), build_canopy(),
               build_partition('intact'), build_partition('holed'),
               build_wardrobe(), build_bed(), build_table(), build_radiator_debris()]
    for mb in KCP.build_all():
        if mb.name.endswith('_destroyed'):
            KDM.structure_v1(mb, 'brick' if mb.name.startswith('brick') else 'shop', sum(map(ord, mb.name)),
                             'red' if mb.name.startswith('brick_red') else 'white')
        pieces.append(mb)
    pieces += KCO.build_all()
    pieces += KDM.build_all()     # <type>_holed_v2/_v3, <type>_destroyed_v2/_v3 (material kit_damage)
    for mb in pieces:   # loose debris sits on the floor
        if mb.name.startswith('debris_'):
            mn, mx = mb.bounds(); mb.transform(mat_trs((0, -mn[1], 0)))
    info = {}
    budgets = {'intact': 600, 'damaged': 600, 'holed': 1800, 'destroyed': 1700}
    col_index = None
    x_cursor = 0.0
    rowz = {}
    for i, mb in enumerate(pieces):
        name = mb.name
        mn, mx = mb.bounds()
        # lay pieces out in rows (states along z) so the file is browsable; the game undoes node translation
        def split(n):
            m = re.match(r'^(.*)_(intact|damaged|holed|destroyed)(?:_(v\d))?$', n)
            if not m:
                return n, None, 0
            row = STATES.index(m.group(2)) if not m.group(3) else 4 + 2 * ['holed', 'destroyed'].index(m.group(2)) + ['v2', 'v3'].index(m.group(3))
            return m.group(1), m.group(2), row
        base, st, row = split(name)
        if col_index is None:
            col_index = list(dict.fromkeys([split(p.name)[0] for p in pieces]))
        col = col_index.index(base)
        loc = (col * 4.5, 0, -row * 5.0)
        # z-fighting (layered broken edges / plates / frames lying flush on another island) and winding / inside-out
        # shells; no reversed twins (pieces are instanced on every block: triangle budget unchanged)
        if not os.environ.get('NO_MESHFIX'):
            V0 = [np.array(v, float) for v in mb.V]; b0 = mb.bounds()
            unfight(mb)
            if st == 'intact' and any(np.abs(np.asarray(x) - np.asarray(y)).max() > 1e-6 for x, y in zip(b0, mb.bounds())):
                mb.V[:] = V0; print(f'  unfight {name}: would change the intact frame (game normalisation) -> skipped')
            fix_mb(mb, double=False, verbose=False)
        mb.to_object(name, [mat, mat2, mat3], location=loc)
        tris = mb.tris()
        b = (st and tris > budgets[st]) or tris > {'collapse_pile_large': 12000, 'collapse_pile_small': 6000, 'slab_hanging': 2000}.get(name, 1e9)
        info[name] = {'bbox_min': [round(float(v), 3) for v in mn], 'bbox_max': [round(float(v), 3) for v in mx], 'tris': tris}
        print(f'{name:28s} tris {tris:5d}{"  OVER BUDGET" if b else ""}  bbox {np.round(mn, 2)} {np.round(mx, 2)}')
    size = export_glb(OUT)
    print('panel_kit.glb', size / 1e6, 'MB')
    if os.environ.get('NO_MANIFEST'):
        return info
    update_manifest('kit', {'width': W, 'height': H, 'thickness': T})
    update_manifest('panel_kit', {
        'file': 'panel_kit.glb', 'material': 'kit_panel (2048^2 atlas: albedo, normal, ORM) + kit_city (second 2048^2 atlas, used by the '
                    'brick_*, wall_shopfront*, sign_*, roof_*, collapse_* pieces; see tools/blender/env/city_kit_atlas.py) + kit_damage '
                    '(third 2048^2 atlas: facade cells of the *_holed_v2/_v3, *_destroyed_v2/_v3 variants; tools/blender/env/kit_damage_atlas.py)',
        'damage_variants': {
            'pattern': '<type>_<holed|destroyed>_<v2|v3>; the plain <type>_holed / <type>_destroyed pieces are variant v1',
            'types': [p for p, *_ in __import__('kit_damage_design').all_types()],
            'normalisation': 'same frame as <type>_intact: the game must use the *_intact offset for the variants too (buildKit regex '
                             '/_(intact|damaged|holed|destroyed)(_v\\d+)?$/ when computing the base name)',
            'holed_v2': 'off-centre shell hole + corner bite + spalled face (panel: outer concrete leaf gone, mineral wool exposed with the '
                        'outer mesh across it; brick: outer half-brick wythe gone); rebar bent inwards (hit from outside)',
            'holed_v3': 'hole through the spandrel / half-panel blow-out / big off-centre hole; panels also get a through-crack (split '
                        'piece displaced ~2 cm outwards where it separates); rebar bent outwards (interior blast)',
            'destroyed_v2': 'blown-out panel: wide ragged remnant column on one side, thin ragged lintel band snapped through in places, '
                            'low kerb; panel fragment hanging on its bars below the band; balcony root stub on balcony types',
            'destroyed_v3': 'blown-out panel: wide lintel band, spandrel remnant rising towards a column on the other side; panel fragment '
                            'swung out on its bars from the column edge',
            'structure': 'every *_destroyed piece (v1 too) is framed by the ceiling-slab edge (y H-0.228..H+0.004, ragged front ~5-11 cm '
                         'behind the facade, torn bars hanging) and a floor screed edge at y 0..0.02 (z -0.05..-1.2); large-panel '
                         'pieces also show the transverse wall ends (x 0..0.08 and W-0.08..W, z -0.3..-1.25, wallpapered room faces). '
                         'The slab band covers the interior slab box of buildings.js buildInterior() at the facade.',
        },
        'coords': 'glTF Y-up. Wall pieces: x 0..W, y 0..H, z 0 (outside face, +Z normal) .. -T (room side). '
                  'Accessories (balcony*, entrance_canopy) start at the wall face z=0 and extend to +Z.',
        'pieces': info,
        'notes': {
            'wall_*_intact': 'exactly fills [0,W]x[0,H]x[-T,0] -> game normalisation offset is zero',
            'damage_states': 'all four states share the intact frame; damaged/holed/destroyed may protrude to +Z (curtains, rebar, '
                             'door leaves, balcony stub) and -Z (room-side debris, radiators) by design',
            'wall_balcony_holed': 'includes the broken-off root of the balcony slab (game removes balcony_slab at state>=2)',
            'balcony_slab': 'mixed corrugated asbestos parapet + residents\' glazing (wood/PVC/boarded). Variants balcony_slab_open, '
                            'balcony_slab_glazed are extra (same placement rules) for the game to randomise',
            'balcony_hanging': 'hinge (wall face, slab top) is at local y = bbox_max.y - 0.14 relative to bbox min; game normalises minY=0 '
                               'so place it at floor_y - (bbox height - 0.14) to keep the hinge at the slab line',
            'entrance_canopy': 'slab bottom at bbox minY+0.06 (lamp housing hangs 6 cm below the slab)',
            'roof_parapet': 'height 0.72 m + galvanised cap; roofing upturn on the room side (-Z)',
            'slab_floor': '3.2 x 0.22 x 3.2 m (x, y, -z). Top = linoleum, bottom = whitewashed ceiling. slab_floor_broken: '
                          'outer half hinged down 35 deg on its bottom rebar',
            'stair_core': '3.2 wide x 2.8 high x 4.5 deep: flight up from z=-4.2 (floor landing provided by slab_floor) to the '
                          'half-landing at y=1.4 against the facade, second flight back up to y=2.8',
            'plinth': '3.2 x 0.9 x 0.45 basement plinth with vent grille, same pivot rules as walls',
            'partition_wall_*': 'interior gypsum partition 3.2 x 2.58 x 0.08 with doorway; _intact/_holed',
            'debris_*': 'loose furniture debris (wardrobe, bed, table+chair, radiator), origin on the floor',
            'brick_<type>_<state>, brick_red_<type>_<state>': 'series 1-447 brick walls, types window/balcony/blank_end/entrance, '
                'same 3.2 x 2.8 x 0.3 frame, openings and 4 damage states as wall_*; brick_* = white silicate brick, brick_red_* = red '
                'ceramic brick (two piece sets, same geometry, different atlas cells). Reuse balcony_slab*/entrance_canopy/plinth. '
                'Holes are stair-stepped along the brick courses; masonry mesh wires instead of rebar',
            'brick_parapet, brick_red_parapet': 'brick roof parapet 0.69 m with corbelled course + galvanised cap; wall frame (maxZ = 0)',
            'wall_shopfront_<state>, wall_shopfront_shutter_<state>': 'ground-floor shop panel (converted flat): tiled piers + glazed '
                'door + 2x2 display window / one wide opening with a steel roller shutter (closed when intact, half-raised and torn when '
                'damaged, ripped out when holed). Fascia y 2.08..2.8 is left for a sign_* piece. Same frame and states as wall_*',
            'sign_<shop>_intact|_damaged': 'shop sign mounted on the fascia: place in panel coords with its bottom at y = 2.14 on a '
                'wall_shopfront* panel. Authored in the accessory frame (centred on x = W/2, starts at the wall face z = 0, extends +Z '
                'up to 0.17) -> normalise like balcony/entrance_canopy (add ^sign_ to the accessory regex in buildKit). Shops: apteka, '
                'produkty, khlib, magazyn, perukarnia, gospodarchi, kafe, kvity, ovochi, zootovary. _damaged = right bracket torn, '
                'hanging tilted (shares the _intact offset)',
            'roof_machine_room, roof_vent, roof_antenna': 'roof-top pieces, origin at their footprint centre on the roof surface (y = 0), '
                '+Z front (machine-room door). Place on the roof slab of 9+ storey blocks (machine room above a stair core). buildKit '
                'normalises them to minX=0/minY=0/maxZ=0: add bbox_min.x / bbox_max.z back to recentre',
            'collapse_pile_large, collapse_pile_small': 'section-collapse rubble: pancaked floor slabs on a rubble mound with rebar, '
                'standing facade remnants, leaning/lying panels, balcony, furniture. Origin = footprint centre on the ground, +Z = '
                'side the section fell towards (street). large ~13 x 13 m, small ~7 x 7 m (see bbox)',
            'slab_hanging': 'slab_floor frame (x 0..3.2, -z inward): floor slab of the storey above hanging diagonally from its '
                'interior support line (hinge = slab top at y = H, z = -W) down to the floor below (free edge y ~ 0.05, z ~ -1.6). '
                'With the generic minX/minY/maxZ normalisation the hinge sits at (x, H - bbox_min.y, -W - bbox_max.z)',
        },
    })
    return info


if __name__ == '__main__':
    main()
