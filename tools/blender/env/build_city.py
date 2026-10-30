"""Builds assets/env/city.glb (one material 'city_atlas', see city_atlas.py): the street furniture and low-rise fabric of
a Donbas / Azov-coast city district (refs: Mariupol Livoberezhnyi & Primorskyi private sector, Bakhmut, Avdiivka
Khimik, Sievierodonetsk) -- above-ground district-heating mains with expansion loops, brick transformer kiosks,
PO-2 concrete fences, private one-storey houses (plaster / brick, tin or slate gable roofs, some burnt / roofless),
house fences, a small Orthodox church, market pavilions, billboards, benches, Soviet steel waste containers, concrete
street lamps, old parked Ladas / Moskvich / Volga, road signs, football goals, laundry poles.
Top-level node names match the city.js regexes (pipe_straight_*, pipe_loop, substation_*, fence_po2_*, house_*,
fence_house_*, church_small, pavilion_*, billboard_*, bench_*, bin_*, lamp_*, car_parked_*, sign_road_*, goal_*,
laundry_pole_*). Origin: ground (y=0) at the footprint centre, front = +Z. Linear pieces run along local X.
Run: cd tools/blender/env && nice -n 10 python3 build_city.py
"""
import os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from meshlib import (MB, Region, Fit, reset_scene, make_material, export_glb, update_manifest, mat_trs, rot_axis, xform,
                     newell, rng, noise1d, blob, REPO)
import city_atlas as CA
from city_geo import (R, RS, reg_of, fit, uvq, quad, tquad, tbox, fbox, wall, tube, lathe, prism, chunk, loose_bricks,
                      ribbon, sheet)

PI = math.pi


def T(x=0.0, y=0.0, z=0.0):
    return mat_trs((x, y, z))


def RY(a, t=(0, 0, 0)):
    return mat_trs(t, (0, a, 0))


def frame(o, X, Y):
    """4x4 with local X, Y axes (Z = X x Y) at origin o."""
    X = np.asarray(X, float); Y = np.asarray(Y, float)
    X = X / np.linalg.norm(X); Y = Y / np.linalg.norm(Y); Z = np.cross(X, Y)
    M = np.eye(4); M[:3, 0] = X; M[:3, 1] = Y; M[:3, 2] = Z; M[:3, 3] = o
    return M


def rect_hole(x0, y0, x1, y1):
    return (x0, y0, x1, y1)


# ====================================================================== district heating
PY, PR, PZ = 1.0, 0.23, (0.36, -0.36)


def pipe_support(mb, x, h=PY - PR):
    tbox(mb, (x - 0.18, 0, -0.75), (x + 0.18, h - 0.06, 0.75), 'concrete', (1, 1), faces='+x-x+y+z-z')
    for z in PZ:
        fbox(mb, (x - 0.12, h - 0.06, z - 0.17), (x + 0.12, h + 0.05, z + 0.17), 'metal_rust_paint', faces='+x-x+y+z-z')


def insul(mb, x0, x1, z, y=PY, reg='foil', r=PR, sides=10):
    tube(mb, [(x0, y, z), (x1, y, z)], r, sides, reg, seg=1.0)


def foil_flap(mb, x, z, seed, length=0.7, side=1):
    """Torn foil strip hanging from the pipe underside."""
    r = rng(seed)
    w = r.uniform(0.25, 0.45)
    M = T(x, PY - PR * 0.6, z + side * PR * 0.75)
    sheet(mb, w, length, 2, 4, 'foil', M @ mat_trs((0, 0, 0), (PI, 0, 0)),
          bend=lambda u, v: (0.05 * math.sin(v * 3 + seed), 0, side * (0.25 * v * v + 0.05 * math.sin(u * 5))), uv_rect=(0, 0, 0.5, 0.6))


def pipe_straight(name, kind, seed):
    mb = MB(name); r = rng(seed)
    for x in (-1.5, 1.5):
        pipe_support(mb, x)
    if kind == 'intact':
        for z in PZ:
            insul(mb, -3, 3, z)
    elif kind == 'torn':
        # foil stripped in places: compressed mineral wool exposed, flaps hanging, wool tufts on the ground
        insul(mb, -3, -0.6, PZ[0]); insul(mb, -0.6, 0.9, PZ[0], reg='wool', r=PR * 0.9, sides=9); insul(mb, 0.9, 3, PZ[0])
        insul(mb, -3, 1.6, PZ[1]); insul(mb, 1.6, 2.4, PZ[1], reg='wool', r=PR * 0.88, sides=9); insul(mb, 2.4, 3, PZ[1])
        foil_flap(mb, -0.55, PZ[0], seed, 0.8, 1); foil_flap(mb, 0.85, PZ[0], seed + 1, 0.5, 1)
        foil_flap(mb, 1.65, PZ[1], seed + 2, 0.6, -1)
        for k in range(5):
            chunk(mb, (r.uniform(-1.2, 2.5), 0.06, r.uniform(0.3, 1.2) * (1 if k % 2 else -1)), (0.3, 0.12, 0.25), seed + 10 + k, 'wool')
    else:  # burst: shrapnel / blast -- one main ruptured, steel exposed, ends sagging, insulation ripped off
        z0, z1 = PZ
        insul(mb, -3, -1.0, z0); insul(mb, 1.25, 3, z0)
        tube(mb, [(-1.0, PY, z0), (-0.5, PY - 0.02, z0), (-0.15, PY - 0.25, z0), (0.05, PY - 0.55, z0 + 0.12)], 0.11, 8, 'pipe_rust', seg=1.0)
        tube(mb, [(1.25, PY, z0), (0.8, PY - 0.03, z0), (0.45, PY - 0.2, z0 - 0.05), (0.25, PY - 0.32, z0 - 0.1)], 0.11, 8, 'pipe_rust', seg=1.0)
        # ripped wool collars at the insulation ends
        insul(mb, -1.0, -0.82, z0, reg='wool', r=PR * 1.05, sides=9); insul(mb, 1.07, 1.25, z0, reg='wool', r=PR * 1.05, sides=9)
        # second main: foil torn, wool showing
        insul(mb, -3, -0.4, z1); insul(mb, -0.4, 0.7, z1, reg='wool', r=PR * 0.9, sides=9); insul(mb, 0.7, 3, z1)
        foil_flap(mb, -0.35, z1, seed + 3, 0.9, -1); foil_flap(mb, 0.65, z1, seed + 4, 0.6, -1)
        # foil sheets and wool on the ground, burst crater wash
        for k in range(3):
            M = mat_trs((r.uniform(-1.5, 1.5), 0.03, r.uniform(0.6, 1.4)), (0, r.uniform(0, PI), 0))
            sheet(mb, 0.8, 0.6, 3, 2, 'foil', M @ mat_trs((-0.4, 0, 0.3), (-PI / 2, 0, 0)),
                  bend=lambda u, v, k=k: (0, 0, 0.12 * math.sin(u * 4 + k) * math.sin(v * 3)), uv_rect=(0, 0, 0.6, 0.6))
        for k in range(8):
            chunk(mb, (r.uniform(-1.5, 2.0), 0.07, r.uniform(-1.4, 1.4)), (0.35, 0.14, 0.3), seed + 20 + k, 'wool')
        for k in range(6):
            chunk(mb, (r.uniform(-0.8, 1.0), 0.08, r.uniform(-1.6, -0.6)), (0.3, 0.15, 0.3), seed + 40 + k, 'ground')
    return mb


def pipe_loop(name='pipe_loop', seed=30):
    """П-shaped expansion loop lifting both mains over a footpath (clear height ~4.7 m), 6 m along X."""
    mb = MB(name)
    top = 5.0
    def path(s):
        xa = 2.25 * s
        return [(-3.0, PY), (-2.6, PY), (-2.37, PY + 0.1), (-2.27, PY + 0.33), (-2.25, PY + 0.6), (-2.25, top - 0.6), (-2.23, top - 0.33),
                (-2.13, top - 0.1), (-1.9, top), (1.9, top), (2.13, top - 0.1), (2.23, top - 0.33), (2.25, top - 0.6), (2.25, PY + 0.6),
                (2.27, PY + 0.33), (2.37, PY + 0.1), (2.6, PY), (3.0, PY)]
    for z in PZ:
        P = [(x, y, z) for x, y in path(1)]
        tube(mb, P, PR, 10, 'foil', seg=1.0)
    # steel portal frames carrying the raised run, concrete footings, low sleepers at the ends
    for x in (-1.55, 1.55):
        for z in (-0.78, 0.78):
            fbox(mb, (x - 0.08, 0.35, z - 0.08), (x + 0.08, top - PR - 0.06, z + 0.08), 'metal_rust_paint', faces='+x-x+z-z')
            tbox(mb, (x - 0.25, 0, z - 0.25), (x + 0.25, 0.35, z + 0.25), 'concrete', (1, 1), faces='+x-x+y+z-z')
            tube(mb, [(x, 0.6, z), (x + (0.6 if x < 0 else -0.6), 0.6 + 0.9, z)], 0.035, 4, 'metal_rust_paint', smooth=False)
        fbox(mb, (x - 0.1, top - PR - 0.18, -0.9), (x + 0.1, top - PR - 0.04, 0.9), 'metal_rust_paint', faces='+x-x+y-y+z-z')
    for x in (-2.25, 2.25):
        tbox(mb, (x - 0.35, 0, -0.75), (x + 0.35, PY - PR - 0.02, 0.75), 'concrete', (1, 1), faces='+x-x+y+z-z')
    # torn foil at one bend, a warning plate
    foil_flap(mb, -2.0, PZ[0], seed, 0.6, 1)
    return mb


# ====================================================================== transformer kiosk
def substation(name, damaged=False, seed=40):
    mb = MB(name); r = rng(seed)
    W, D, Hh, th = 4.6, 3.4, 3.3, 0.38
    ins = 'plaster_white'
    doors = [(-1.95, 0.05, -0.55, 2.3), (0.55, 0.05, 1.95, 2.3)]
    louv_front = [(-1.75, 2.55, -0.75, 3.0), (0.75, 2.55, 1.75, 3.0)]
    # walls
    fh = list(doors) + list(louv_front)
    side_reg = 'brick_white'
    if damaged:
        hole = blob(1.2, 1.5, 1.35, 1.25, 22, seed, rough=0.3, spikes=0.35)
        from shapely.geometry import Polygon, box as sbox
        from shapely.ops import unary_union
        u = unary_union([Polygon(hole), sbox(*doors[1]), sbox(*louv_front[1])])
        fh = [doors[0], louv_front[0], np.array(u.exterior.coords)[:-1]]
        # right part of the front wall top knocked down
        outline = [(-W / 2, 0), (W / 2, 0), (W / 2, 2.4), (2.0, 2.65), (1.6, 3.0), (1.0, Hh - 0.1), (-W / 2, Hh)]
        wall(mb, outline, th, 'brick_white', holes=fh, M=T(0, 0, D / 2), back=ins, side='soot')
    else:
        wall(mb, (-W / 2, 0, W / 2, Hh), th, 'brick_white', holes=fh, M=T(0, 0, D / 2), back=ins)
    wall(mb, (-W / 2, 0, W / 2, Hh), th, 'brick_white', M=RY(PI, (0, 0, -D / 2)), back=ins,
         holes=[(-0.4, 2.3, 0.4, 2.8)])
    for s in (1, -1):
        out = (-(D / 2 - th), 0, D / 2 - th, Hh)
        if damaged and s > 0:
            out = [(-(D / 2 - th), 0), (D / 2 - th, 0), (D / 2 - th, Hh), (-0.6, 2.95), (-(D / 2 - th), 2.5)]
        wall(mb, out, th, 'brick_white', M=RY(s * PI / 2, (s * W / 2, 0, 0)), back=ins, holes=[(-0.45, 2.3, 0.45, 2.8)], cap='none' if not damaged else 'auto')
    # louvres / vents (recessed)
    for (x0, y0, x1, y1) in louv_front[:1 if damaged else 2]:
        quad(mb, [(x0, y0, D / 2 - 0.12), (x1, y0, D / 2 - 0.12), (x1, y1, D / 2 - 0.12), (x0, y1, D / 2 - 0.12)], 'louvre')
    quad(mb, [(0.4, 2.3, -D / 2 + 0.12), (-0.4, 2.3, -D / 2 + 0.12), (-0.4, 2.8, -D / 2 + 0.12), (0.4, 2.8, -D / 2 + 0.12)], 'louvre')
    for s in (1, -1):
        Ms = RY(s * PI / 2, (s * (W / 2 - 0.12), 0, 0))
        quad(mb, [(-0.45, 2.3, 0), (0.45, 2.3, 0), (0.45, 2.8, 0), (-0.45, 2.8, 0)], 'louvre', M=Ms)
    # plinth band and roof slab (bitumen top)
    for (mn, mx) in (((-W / 2 - 0.03, 0, D / 2 - 0.02), (W / 2 + 0.03, 0.32, D / 2 + 0.03)), ((-W / 2 - 0.03, 0, -D / 2 - 0.03), (W / 2 + 0.03, 0.32, -D / 2 + 0.02))):
        tbox(mb, mn, mx, 'concrete', (1, 1), faces='+z-z+y+x-x')
    for s in (1, -1):
        tbox(mb, (s * W / 2 - 0.03, 0, -D / 2), (s * W / 2 + 0.03, 0.32, D / 2), 'concrete', (1, 1), faces='+x-x+y')
    ov = 0.25
    if not damaged:
        tbox(mb, (-W / 2 - ov, Hh, -D / 2 - ov), (W / 2 + ov, Hh + 0.22, D / 2 + ov), 'concrete', (1, 1), faces='+x-x-y+z-z', regs={})
        tquad(mb, (-W / 2 - ov, Hh + 0.22, D / 2 + ov), (1, 0, 0), (0, 0, -1), W + 2 * ov, D + 2 * ov, 'rubber', (2, 2))
    else:
        # roof slab cracked: left part stays, right part dropped onto the transformer
        tbox(mb, (-W / 2 - ov, Hh, -D / 2 - ov), (0.55, Hh + 0.22, D / 2 + ov), 'concrete', (1, 1), faces='+x-x-y+z-z')
        tquad(mb, (-W / 2 - ov, Hh + 0.22, D / 2 + ov), (1, 0, 0), (0, 0, -1), W / 2 + ov + 0.55, D + 2 * ov, 'rubber', (2, 2))
        Mr = rot_axis((0, 0, 1), -0.42, (0.55, Hh + 0.1, 0))
        tbox(mb, (0.6, Hh, -D / 2 - ov), (W / 2 + ov, Hh + 0.22, D / 2 + ov), 'concrete', (1, 1), faces='+x-x-y+z-z', M=Mr)
        tquad(mb, (0.6, Hh + 0.22, D / 2 + ov), (1, 0, 0), (0, 0, -1), W / 2 + ov - 0.6, D + 2 * ov, 'rubber', (2, 2), M=Mr)
        for k in range(5):  # rebar from the crack
            y = Hh + 0.11; z = -D / 2 + 0.3 + k * 0.7
            tube(mb, [(0.55, y, z), (0.75 + r.uniform(0, 0.2), y - 0.15, z + r.uniform(-0.1, 0.1))], 0.008, 3, 'pipe_rust', smooth=False)
    # floor + transformer inside (visible through the openings when damaged)
    tquad(mb, (-W / 2 + th, 0.3, D / 2 - th), (1, 0, 0), (0, 0, -1), W - 2 * th, D - 2 * th, 'concrete', (1, 1))
    tx, tz = 0.9, -0.2
    fbox(mb, (tx - 0.7, 0.3, tz - 0.5), (tx + 0.7, 1.9, tz + 0.5), 'metal_grey', faces='+x-x+y+z-z')
    for s in (-1, 1):
        fbox(mb, (tx - 0.6, 0.45, tz + s * 0.5), (tx + 0.6, 1.7, tz + s * 0.62), 'louvre', faces='+x-x+y+z-z')
    for k in range(3):
        tube(mb, [(tx - 0.4 + k * 0.4, 1.9, tz), (tx - 0.4 + k * 0.4, 2.3, tz)], 0.06, 6, 'paint_white', cap=True)
    fbox(mb, (-1.7, 0.3, -D / 2 + th), (-0.3, 2.2, -D / 2 + th + 0.5), 'metal_grey', faces='+x-x+y+z')   # switchgear cabinet
    # doors
    if not damaged:
        for (x0, y0, x1, y1) in doors:
            xm = (x0 + x1) / 2; z = D / 2 - 0.06
            quad(mb, [(x0, y0, z), (xm - 0.01, y0, z), (xm - 0.01, y1, z), (x0, y1, z)], 'metal_grey', ((0, 0), (0.5, 0), (0.5, 1), (0, 1)))
            quad(mb, [(xm + 0.01, y0, z), (x1, y0, z), (x1, y1, z), (xm + 0.01, y1, z)], 'metal_grey', ((0.5, 0), (1, 0), (1, 1), (0.5, 1)))
            quad(mb, [(x0 + 0.1, 1.15, z + 0.01), (xm - 0.1, 1.15, z + 0.01), (xm - 0.1, 1.75, z + 0.01), (x0 + 0.1, 1.75, z + 0.01)], 'hv_sign')
    else:
        x0, y0, x1, y1 = doors[0]; z = D / 2 - 0.06; xm = (x0 + x1) / 2
        quad(mb, [(x0, y0, z), (xm, y0, z), (xm, y1, z), (x0, y1, z)], 'metal_grey', double=True)
        quad(mb, [(x0 + 0.1, 1.15, z + 0.01), (xm - 0.1, 1.15, z + 0.01), (xm - 0.1, 1.75, z + 0.01), (x0 + 0.1, 1.75, z + 0.01)], 'hv_sign')
        x0, y0, x1, y1 = doors[1]; xm = (x0 + x1) / 2   # right door: one leaf swung out on its hinge, sagging
        Mh = rot_axis((0, 1, 0), 1.9, (x1, 0, D / 2 + 0.02)) @ rot_axis((0, 0, 1), -0.08, (x1, y1, 0))
        quad(mb, [(xm, y0 + 0.1, D / 2 + 0.02), (x1, y0 + 0.1, D / 2 + 0.02), (x1, y1, D / 2 + 0.02), (xm, y1, D / 2 + 0.02)], 'metal_grey', double=True, M=Mh)
        # the other door blown off, lying in front, bent
        Md = mat_trs((1.3, 0.04, D / 2 + 1.6), (-PI / 2 + 0.08, 0.5, 0))
        sheet(mb, 1.4, 2.2, 2, 3, 'metal_grey', Md @ T(-0.7, -1.1, 0), bend=lambda u, v: (0, 0, 0.25 * math.sin(v * PI) * u), double=True)
        # brick heap below the hole, scorch on the ground
        loose_bricks(mb, 1.3, D / 2 + 0.6, 1.0, 60, 'white', seed)
        for k in range(10):
            chunk(mb, (r.uniform(0.3, 2.3), 0.1, D / 2 + r.uniform(0.2, 1.3)), (0.5, 0.25, 0.35), seed + 70 + k, 'brick_white')
    return mb


# ====================================================================== PO-2 concrete fence
def po2(name, kind='a', seed=50):
    mb = MB(name); r = rng(seed)
    y0, y1, th = 0.15, 2.15, 0.16
    M = T(0, 0, th / 2)
    front = R['po2']; ftile = (4, 2)
    if kind == 'b':
        front = RS('po2', 0, 0, 0.5, 1); ftile = (2, 2)   # the clean half twice (no graffiti)
    back = R['po2']
    for x in (-1.55, 1.55):   # foundation cups
        tbox(mb, (x - 0.22, 0, -0.22), (x + 0.22, 0.2, 0.22), 'concrete', (1, 1), faces='+x-x+y+z-z')
    if kind != 'broken':
        wall(mb, (-2, y0, 2, y1), th, front, ftile, M=M, back=back, back_tile=(4, 2), side='concrete', org=(-2, y0), cap='all')
        return mb
    # broken: left part still standing (jagged break), right part knocked flat, rebar at the break
    left = [(-2, y0), (0.35, y0), (0.05, 0.62), (0.42, 1.05), (-0.12, 1.5), (0.22, 1.85), (-0.05, y1), (-2, y1)]
    wall(mb, left, th, front, ftile, M=M, back=back, back_tile=(4, 2), side='concrete', org=(-2, y0), cap='all')
    right = [(0.42, y0 + 0.25), (2, y0 + 0.25), (2, y1), (0.12, y1), (0.4, 1.8), (0.0, 1.5), (0.5, 1.05), (0.15, 0.6)]
    Mf = rot_axis((1, 0, 0), 1.42, (0, 0.16, th + 0.1)) @ T(0.15, -0.1, th / 2)
    wall(mb, right, th, front, ftile, M=Mf, back=back, back_tile=(4, 2), side='concrete', org=(-2, y0), cap='all')
    for k in range(7):
        y = 0.3 + k * 0.27
        x = 0.1 + 0.15 * math.sin(k * 1.7)
        tube(mb, [(x, y, 0.08), (x + r.uniform(0.15, 0.4), y + r.uniform(-0.1, 0.1), 0.08 + r.uniform(-0.15, 0.25))], 0.007, 3, 'pipe_rust', smooth=False)
    for k in range(9):
        chunk(mb, (r.uniform(-0.2, 1.2), 0.07, r.uniform(-0.6, 0.9)), (0.22, 0.12, 0.18), seed + k, 'concrete')
    return mb


# ====================================================================== private houses
def window_trim(mb, x0, y0, x1, y1, M, z=0.012, bw=0.13, bt=0.2, bb=0.1, reg='window_house'):
    """Blue carved trim strips (nalichnik) around an opening, cut from the border of the window cell."""
    s0, s1, t0, t1 = 0.12, 0.88, 0.1, 0.9
    quad(mb, [(x0 - bw, y1, z), (x1 + bw, y1, z), (x1 + bw, y1 + bt, z), (x0 - bw, y1 + bt, z)], reg, ((0, t1), (1, t1), (1, 1), (0, 1)), M=M)
    quad(mb, [(x0 - bw, y0 - bb, z), (x1 + bw, y0 - bb, z), (x1 + bw, y0, z), (x0 - bw, y0, z)], reg, ((0, 0), (1, 0), (1, t0), (0, t0)), M=M)
    quad(mb, [(x0 - bw, y0, z), (x0, y0, z), (x0, y1, z), (x0 - bw, y1, z)], reg, ((0, t0), (s0, t0), (s0, t1), (0, t1)), M=M)
    quad(mb, [(x1, y0, z), (x1 + bw, y0, z), (x1 + bw, y1, z), (x1, y1, z)], reg, ((s1, t0), (1, t0), (1, t1), (s1, t1)), M=M)
    fbox(mb, (x0 - 0.05, y0 - 0.06, -0.05), (x1 + 0.05, y0, 0.07), 'tin_galv', faces='+y+z+x-x', M=M)


def house(name, w, d, wall_reg, roof_reg, seed, ridge='x', pitch=32, burnt=False, roof_hole=None, wall_hole=None,
          gable_reg=None, trim=True, broken_windows=(), boarded=(), chimney_reg='brick_red', inner='plaster_white'):
    """One-storey private house (pryvatnyi sektor). Plinth 0.45, walls to 3.2, gable roof. Front (+Z) = street side."""
    mb = MB(name); r = rng(seed)
    yp, ye, th = 0.45, 3.2, 0.4
    ov, ovg = 0.45, 0.35
    ta = math.tan(math.radians(pitch))
    span = d if ridge == 'x' else w            # dimension across the ridge
    yr = ye + span / 2 * ta
    gable_reg = gable_reg or wall_reg
    wtile = (2.4, ye - yp) if 'plaster' in wall_reg else (1.0, 1.0)
    worg = (0.0, yp) if 'plaster' in wall_reg else (0.0, 0.0)
    inner = 'charred' if burnt else inner
    # walls: (name, M, length, gable?)
    walls = {
        'front': (T(0, 0, d / 2), w, ridge == 'z'), 'back': (RY(PI, (0, 0, -d / 2)), w, ridge == 'z'),
        'right': (RY(PI / 2, (w / 2, 0, 0)), d - 2 * th, ridge == 'x'), 'left': (RY(-PI / 2, (-w / 2, 0, 0)), d - 2 * th, ridge == 'x')}
    # openings per wall (local x along wall, world y)
    win_w, win_h, sill = 1.15, 1.35, 1.35
    def wins(L, n, skip=()):
        xs = np.linspace(-L / 2, L / 2, n + 2)[1:-1]
        return [(x - win_w / 2, sill, x + win_w / 2, sill + win_h) for i, x in enumerate(xs) if i not in skip]
    nf = 3 if w > 7.5 else 2
    openings = {'front': wins(w, nf), 'back': wins(w, 2), 'right': wins(d - 2 * th, 2 if d > 7 else 1), 'left': wins(d - 2 * th, 1)}
    door = (-(d - 2 * th) / 2 + 0.6, yp, -(d - 2 * th) / 2 + 1.5, yp + 2.05)   # door on the left side wall, near the front
    openings['left'] = [o for o in openings['left'] if o[2] < door[0] - 0.3 or o[0] > door[2] + 0.3] or [(0.6, sill, 0.6 + win_w, sill + win_h)]
    for wname, (M, L, gable) in walls.items():
        if gable:
            outline = [(-L / 2, 0), (L / 2, 0), (L / 2, ye + (span / 2 - L / 2) * ta), (0, yr), (-L / 2, ye + (span / 2 - L / 2) * ta)]
        else:
            outline = [(-L / 2, 0), (L / 2, 0), (L / 2, ye), (-L / 2, ye)]
        if burnt and gable:   # gable top burnt / collapsed
            outline = [(-L / 2, 0), (L / 2, 0), (L / 2, ye + (span / 2 - L / 2) * ta), (L * 0.18, ye + 0.9), (0.05, ye + 0.35),
                       (-L * 0.2, ye + 0.75), (-L / 2, ye + (span / 2 - L / 2) * ta)]
        holes = list(openings[wname])
        if wname == 'left':
            holes.append(door)
        if wall_hole and wall_hole[0] == wname:
            _, cx, cy, rx, ry_ = wall_hole
            holes.append(blob(cx, cy, rx, ry_, 18, seed + 3, rough=0.3, spikes=0.3))
        # plaster wall body above the plinth; gable part optionally boards
        if gable and gable_reg != wall_reg:
            from shapely.geometry import Polygon, box as sbox
            body = Polygon(outline).intersection(sbox(-L / 2, yp, L / 2, ye))
            top = Polygon(outline).difference(sbox(-L / 2 - 1, -1, L / 2 + 1, ye))
            wall(mb, np.array(body.exterior.coords)[:-1], th, wall_reg, wtile, holes=holes, M=M, back=inner, cap='auto', side=wall_reg, org=worg)
            if not top.is_empty:
                wall(mb, np.array(top.exterior.coords)[:-1], 0.08, gable_reg, (1.0, 1.0), M=M @ T(0, 0, 0.02), back=False, cap='none')
        else:
            from shapely.geometry import Polygon, box as sbox
            body = Polygon(outline).intersection(sbox(-L / 2, yp, L / 2, 50))
            wall(mb, np.array(body.exterior.coords)[:-1], th, wall_reg, wtile, holes=holes, M=M, back=inner, cap='auto', side=wall_reg, org=worg)
        # window inserts + trim
        for k, (x0, y0, x1, y1) in enumerate(openings[wname]):
            key = (wname, k)
            if not burnt:
                zr = -0.1
                if key in boarded:
                    tquad(mb, (x0, y0, zr), (1, 0, 0), (0, 1, 0), x1 - x0, y1 - y0, 'wood_raw', (1.2, 1.2), M=M)
                else:
                    reg = RS('window_house', 0.12, 0.1, 0.88, 0.9) if key not in broken_windows else 'glass_dark'
                    quad(mb, [(x0, y0, zr), (x1, y0, zr), (x1, y1, zr), (x0, y1, zr)], reg, M=M)
                if trim:
                    window_trim(mb, x0, y0, x1, y1, M)
            else:
                fbox(mb, (x0 - 0.04, y0 - 0.05, -0.04), (x1 + 0.04, y0, 0.06), 'charred', faces='+y+z', M=M)
        if wname == 'left':
            x0, y0, x1, y1 = door
            if not burnt:
                quad(mb, [(x0, y0, -0.12), (x1, y0, -0.12), (x1, y1, -0.12), (x0, y1, -0.12)], 'door_house', M=M)
            tbox(mb, (x0 - 0.35, 0, 0), (x1 + 0.35, yp, 0.9), 'concrete', (1, 1), faces='+x-x+y+z', M=M)
            tbox(mb, (x0 - 0.35, 0, 0.9), (x1 + 0.35, yp * 0.5, 1.2), 'concrete', (1, 1), faces='+x-x+y+z', M=M)
            if not burnt:   # little tin canopy on two brackets
                Mc = M @ mat_trs((0, y1 + 0.35, 0), (0.35, 0, 0))
                tbox(mb, (x0 - 0.45, 0, 0), (x1 + 0.45, 0.04, 1.0), RS(roof_reg if 'tin' in roof_reg else 'tin_galv', 0, 0, 1, 1), (1, 1), faces='+y-y+z+x-x', M=Mc)
    # plinth
    tbox(mb, (-w / 2 - 0.04, 0, -d / 2 - 0.04), (w / 2 + 0.04, yp, d / 2 + 0.04), 'concrete', (1, 1), faces='+x-x+z-z+y')
    if burnt or wall_hole:
        tquad(mb, (-w / 2 + th, yp + 0.005, d / 2 - th), (1, 0, 0), (0, 0, -1), w - 2 * th, d - 2 * th, 'charred' if burnt else 'wood_raw', (1.5, 1.5))
    # roof
    hw = span / 2 + ov
    S = hw / math.cos(math.radians(pitch))
    Lr = (w if ridge == 'x' else d) + 2 * ovg
    a = math.radians(pitch)
    lift = 0.06
    if ridge == 'x':
        slopes = [frame((0, ye - ov * ta + lift, hw), (1, 0, 0), (0, math.sin(a), -math.cos(a))),
                  frame((0, ye - ov * ta + lift, -hw), (-1, 0, 0), (0, math.sin(a), math.cos(a)))]
    else:
        slopes = [frame((hw, ye - ov * ta + lift, 0), (0, 0, -1), (-math.cos(a), math.sin(a), 0)),
                  frame((-hw, ye - ov * ta + lift, 0), (0, 0, 1), (math.cos(a), math.sin(a), 0))]
    rtile = (1.0, 1.25)
    if not burnt:
        for k, Ms in enumerate(slopes):
            holes = []
            if roof_hole and roof_hole[0] == k:
                _, cx, cy, rx, ry_ = roof_hole
                holes = [blob(cx, cy, rx, ry_, 16, seed + 7, rough=0.35, spikes=0.25)]
            wall(mb, (-Lr / 2, 0, Lr / 2, S), 0.05, roof_reg, rtile, holes=holes, M=Ms, back='wood_raw', side='tin_galv', cap='all', org=(-Lr / 2, 0))
            if roof_hole and roof_hole[0] == k:   # rafters + battens visible through the hole
                for x in np.arange(-Lr / 2 + 0.5, Lr / 2, 0.9):
                    fbox(mb, (x - 0.04, ov / math.cos(a), -0.2), (x + 0.04, S - 0.05, -0.05), 'wood_raw', faces='+x-x-z', M=Ms)
                for y in np.arange(0.6, S, 0.5):
                    fbox(mb, (-Lr / 2 + 0.3, y, -0.05), (Lr / 2 - 0.3, y + 0.05, -0.02), 'wood_raw', faces='+y-y+z', M=Ms)
                # torn sheet curled up at the edge of the hole
                sheet(mb, rx * 1.2, ry_ * 0.9, 3, 3, roof_reg, Ms @ mat_trs((cx - rx * 0.6, cy + ry_ * 0.7, 0.02), (0.9, 0.2, 0)),
                      bend=lambda u, v: (0, 0, 0.3 * v * v), double=True)
        # ridge cap
        for s in (1, -1):
            if ridge == 'x':
                P = np.array([(-Lr / 2, yr + lift + 0.02, 0), (Lr / 2, yr + lift + 0.02, 0), (Lr / 2, yr + lift - 0.1, s * 0.2), (-Lr / 2, yr + lift - 0.1, s * 0.2)])
            else:
                P = np.array([(0, yr + lift + 0.02, Lr / 2), (0, yr + lift + 0.02, -Lr / 2), (s * 0.2, yr + lift - 0.1, -Lr / 2), (s * 0.2, yr + lift - 0.1, Lr / 2)])
            if newell(P)[1] < 0:
                P = P[::-1]
            quad(mb, P, RS('tin_galv', 0, 0, 1, 0.25))
        # chimney through the back slope
        cx = (w * 0.22) if ridge == 'x' else -0.9
        cz = -0.7 if ridge == 'x' else -d * 0.2
        tbox(mb, (cx - 0.27, ye, cz - 0.27), (cx + 0.27, yr + 0.75, cz + 0.27), chimney_reg, (1, 1), faces='+x-x+z-z+y')
        fbox(mb, (cx - 0.33, yr + 0.75, cz - 0.33), (cx + 0.33, yr + 0.82, cz + 0.33), 'concrete', faces='+x-x+z-z+y-y')
    else:
        # roof burnt off: a few charred rafters left, collapsed tin sheets inside and around
        for k, x in enumerate(np.arange(-Lr / 2 + 0.6, Lr / 2, 1.1)):
            if r.random() < 0.45:
                continue
            Ms = slopes[k % 2]
            L_ = S * r.uniform(0.35, 0.95)
            Mb = Ms @ rot_axis((1, 0, 0), r.uniform(-0.25, 0.1), (0, ov / math.cos(a), 0))
            fbox(mb, (x - 0.05, ov / math.cos(a), -0.2), (x + 0.05, ov / math.cos(a) + L_, -0.06), 'charred', faces='+x-x-y+y+z', M=Mb)
        Mrb = rot_axis((0, 0, 1), 0.12, (0, yr, 0))
        if ridge == 'z':
            Mrb = RY(PI / 2) @ Mrb
        fbox(mb, (-Lr / 2 + 0.6, yr - 0.35, -0.06), (Lr / 2 * 0.3, yr - 0.22, 0.06), 'charred', faces='+y-y+z-z', M=Mrb)
        for k in range(5):
            x = r.uniform(-w / 2 + 1, w / 2 - 1); z = r.uniform(-d / 2 + 1, d / 2 - 1) if k < 3 else (d / 2 + r.uniform(0.5, 1.0)) * (1 if k == 3 else -1)
            Mx = mat_trs((x, yp + 0.15 if k < 3 else 0.05, z), (-PI / 2 + r.uniform(-0.3, 0.3), r.uniform(0, PI), r.uniform(-0.2, 0.2)))
            sheet(mb, 1.8, 1.1, 3, 2, roof_reg, Mx @ T(-0.9, -0.55, 0), bend=lambda u, v, k=k: (0, 0, 0.25 * math.sin(u * PI * 1.3 + k) * v), double=True)
        for k in range(10):
            chunk(mb, (r.uniform(-w / 2 + 0.8, w / 2 - 0.8), yp + 0.1, r.uniform(-d / 2 + 0.8, d / 2 - 0.8)), (0.5, 0.2, 0.4), seed + 30 + k, 'charred')
    # debris for wall holes
    if wall_hole:
        wname, cx, cy, rx, ry_ = wall_hole
        M = walls[wname][0]
        loose_bricks(mb, cx, 0.9, 0.9, 40, 'red' if 'brick_red' in wall_reg else 'white', seed + 9, M=M)
        for k in range(6):
            chunk(mb, (cx + r.uniform(-1, 1), 0.1, r.uniform(0.3, 1.4)), (0.4, 0.2, 0.3), seed + 50 + k, wall_reg, M=M)
    return mb


# ====================================================================== house fences (18 m along X)
def post(mb, x, h, reg='metal_grey', s=0.06, z=0.0):
    fbox(mb, (x - s / 2, 0, z - s / 2), (x + s / 2, h, z + s / 2), reg, faces='+x-x+z-z+y')


def fence_prof(name, reg='prof_brown', broken=False, seed=60, gate=True):
    mb = MB(name); r = rng(seed)
    Hf = 2.0
    xs = [-9, -6.5, -4, -1.6, 1.6, 4, 6.5, 9] if gate else [-9, -6.75, -4.5, -2.25, 0, 2.25, 4.5, 6.75, 9]
    for x in xs:
        post(mb, x, Hf + 0.1, 'metal_rust_paint', 0.07, -0.05)
    for y in (0.35, 1.7):
        fbox(mb, (-9, y, -0.1), (9, y + 0.04, -0.06), 'metal_rust_paint', faces='+y-y-z+z')
    # sheets in 1.15 m strips; gate in the middle (blue sun gate leaves)
    segs = [(-9, -1.6), (1.6, 9)] if gate else [(-9, 9)]
    for (a, b) in segs:
        x = a
        while x < b - 1e-3:
            x1 = min(b, x + 1.15)
            k = int((x + 9) / 1.15)
            if broken and k in (2, 3, 9, 12):
                if k in (2, 12):  # sheet ripped and folded down
                    Mx = T(x, 0.3, 0.02) @ rot_axis((1, 0, 0), 1.0 + 0.3 * (k % 3), (0, 0, 0))
                    sheet(mb, x1 - x, 1.3, 2, 3, reg, Mx, bend=lambda u, v: (0, 0.05 * u, -0.2 * v * v), double=True)
                x = x1; continue
            holes = []
            if broken and k in (5, 7, 14):
                holes = [blob((x + x1) / 2 + r.uniform(-0.2, 0.2), r.uniform(0.6, 1.5), 0.22, 0.18, 10, seed + k, 0.4, 0.3)]
            lean = rot_axis((1, 0, 0), 0.25, (0, 0, 0)) if broken and k == 10 else np.eye(4)
            wall(mb, (x, 0.08, x1, Hf), 0.0, reg, (1.15, 1.0), holes=holes, M=lean, back=reg, cap='none', org=(-9, 0))
            x = x1
    # gate: two leaves + wicket, painted steel with the sun motif
    for s in ((-1, 1) if gate else ()):
        if broken and s > 0:
            M = rot_axis((0, 1, 0), 0.9, (1.6, 0, 0))
        else:
            M = np.eye(4)
        x0, x1 = (-1.6, -0.02) if s < 0 else (0.02, 1.6)
        quad(mb, [(x0, 0.1, 0.01), (x1, 0.1, 0.01), (x1, Hf - 0.05, 0.01), (x0, Hf - 0.05, 0.01)], 'gate', double=True, M=M)
    return mb


def fence_picket(name, seed=61):
    mb = MB(name); r = rng(seed)
    Hf = 1.35
    for x in np.arange(-9, 9.01, 2.5):
        tube(mb, [(x, 0, -0.06), (x, Hf + 0.05, -0.06)], 0.05, 5, 'wood_raw', seg=2.0, cap=False, smooth=False)
    for y in (0.3, 1.05):
        fbox(mb, (-9, y, -0.1), (9, y + 0.08, -0.02), 'wood_raw', faces='+y-y-z+z')
    x = -9 + 0.06
    k = 0
    while x < 9 - 0.05:
        if -1.2 < x < 1.2 or r.random() < 0.06:   # gateway gap, missing boards
            x += 0.16; k += 1; continue
        lean = r.normal(0, 0.03) + (0.5 if 4.5 < x < 5.2 else 0)
        h = Hf * r.uniform(0.93, 1.0)
        col = k % 6
        reg = RS('picket', col / 6 + 0.02, 0, (col + 1) / 6, 1)
        M = rot_axis((1, 0, 0), lean, (x, 0.3, 0)) if abs(lean) > 0.05 else np.eye(4)
        P = [(x - 0.055, 0.05, 0), (x + 0.055, 0.05, 0), (x + 0.055, h - 0.06, 0), (x, h, 0), (x - 0.055, h - 0.06, 0)]
        P = xform(np.array(P), M)
        mb.poly(P, lambda P_, n_: [reg.uv(0, 0), reg.uv(1, 0), reg.uv(1, 0.95), reg.uv(0.5, 1), reg.uv(0, 0.95)])
        Pb = P[::-1] + xform(np.array([[0, 0, -0.02]]), M)[0] - xform(np.array([[0, 0, 0]]), M)[0]
        mb.poly(Pb, lambda P_, n_: [reg.uv(0, 0.95), reg.uv(0.5, 1), reg.uv(1, 0.95), reg.uv(1, 0), reg.uv(0, 0)])
        x += 0.16; k += 1
    # a sagging wooden gate leaf in the gap
    M = rot_axis((0, 1, 0), 0.7, (-1.2, 0, 0))
    for i in range(6):
        xx = -1.15 + i * 0.17
        quad(mb, [(xx, 0.12, 0), (xx + 0.12, 0.12, 0), (xx + 0.12, Hf - 0.1, 0), (xx, Hf - 0.1, 0)], RS('picket', 0.02, 0, 1 / 6, 1), double=True, M=M)
    return mb


# ====================================================================== church
def onion(mb, base_y, r0, h, reg, x=0.0, z=0.0, segs=16, cross=True, jitter=None, tilt=None):
    prof = [(r0, 0), (r0 * 1.18, h * 0.12), (r0 * 1.32, h * 0.27), (r0 * 1.26, h * 0.42), (r0 * 0.98, h * 0.58),
            (r0 * 0.6, h * 0.73), (r0 * 0.28, h * 0.86), (r0 * 0.1, h * 0.96), (0.0, h)]
    M = T(x, base_y, z)
    if tilt is not None:
        M = M @ tilt
    lathe(mb, prof, segs, reg, M=M, jitter=jitter)
    # neck + orthodox cross
    if cross:
        Mc = M @ T(0, h, 0)
        ch = max(0.9, r0 * 1.3)
        tube(mb, [(0, -0.05, 0), (0, 0.18, 0)], r0 * 0.12, 8, 'dome_gold', cap=True, M=Mc)
        fbox(mb, (-0.03, 0.18, -0.03), (0.03, 0.18 + ch, 0.03), 'dome_gold', M=Mc)
        for (yy, ww, rz) in ((0.7, 0.45, 0), (0.88, 0.22, 0), (0.3, 0.3, 0.35)):
            fbox(mb, (-ww / 2, -0.025, -0.025), (ww / 2, 0.025, 0.025), 'dome_gold', M=Mc @ mat_trs((0, 0.18 + ch * yy, 0), (0, 0, rz)))


def church_small(name='church_small', seed=80):
    mb = MB(name); r = rng(seed)
    PL = 0.6                                     # plinth height
    tile = (2.0, 2.0)
    pl = 'church_plaster'
    # plinth
    tbox(mb, (-4.8, 0, -7.0), (4.8, PL, 7.2), 'concrete', (1, 1), faces='+x-x+z-z+y')
    # --- nave (chetverik): x -4.5..4.5, z -3.5..4.5, walls to 8.5
    Wn, z0, z1, Hn, th = 9.0, -3.5, 4.5, 8.5, 0.6
    Ln = z1 - z0
    arch = lambda cx, y0, w_, h_: [(cx - w_ / 2, y0), (cx + w_ / 2, y0)] + [(cx + w_ / 2 * math.cos(t), y0 + h_ - w_ / 2 + w_ / 2 * math.sin(t)) for t in np.linspace(0, PI, 7)] + [(cx - w_ / 2, y0)]
    def arch_poly(cx, y0, w_, h_):
        P = arch(cx, y0, w_, h_)[:-1]
        return P
    side_wins = [arch_poly(c, 3.2, 1.0, 2.6) for c in (-2.2, 0.0, 2.2)]
    hole = blob(-2.2, 3.6, 1.0, 1.3, 16, seed, rough=0.3, spikes=0.35)   # shell hole through a window on the right side
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    u = unary_union([Polygon(side_wins[0]), Polygon(hole)])
    right_holes = [np.array(u.exterior.coords)[:-1]] + side_wins[1:]
    for s, holes in ((1, right_holes), (-1, side_wins)):
        wall(mb, (-Ln / 2, PL, Ln / 2, Hn), th, pl, tile, holes=holes, M=RY(s * PI / 2, (s * Wn / 2, 0, (z0 + z1) / 2)), back='plaster_burnt', cap='none', side=pl if s < 0 else 'soot', side_tile=(1, 1))
    # front / back walls of the nave (front mostly hidden by the bell tower, back has the apse arch)
    wall(mb, (-Wn / 2, PL, Wn / 2, Hn), th, pl, tile, M=T(0, 0, z1), back='plaster_burnt', cap='none', holes=[(-1.2, PL, 1.2, 3.4)])
    wall(mb, (-Wn / 2, PL, Wn / 2, Hn), th, pl, tile, M=RY(PI, (0, 0, z0)), back='plaster_burnt', cap='none', holes=[arch_poly(0, PL, 3.4, 4.6)])
    for s in (1, -1):   # window inserts
        Ms = RY(s * PI / 2, (s * (Wn / 2 - 0.25), 0, (z0 + z1) / 2))
        for i, c in enumerate((-2.2, 0.0, 2.2)):
            if s > 0 and i == 0:
                continue
            quad(mb, [(c - 0.5, 3.2, 0), (c + 0.5, 3.2, 0), (c + 0.5, 5.8, 0), (c - 0.5, 5.8, 0)], RS('church_window', 0.25, 0.05, 0.75, 0.93), M=Ms)
    # interior floor (seen through the shell hole and the door)
    tquad(mb, (-Wn / 2 + th, PL + 0.01, z1), (1, 0, 0), (0, 0, -1), Wn - 2 * th, z1 - z0, 'wood_raw', (1.5, 1.5))
    # cornice
    tbox(mb, (-Wn / 2 - 0.2, Hn - 0.1, z0 - 0.2), (Wn / 2 + 0.2, Hn + 0.15, z1 + 0.2), 'paint_white', (1, 1), faces='+x-x+z-z-y')
    # nave roof: low hip (4 triangles) up to the drum base
    yb, ytop = Hn + 0.15, Hn + 1.5
    c = [(-Wn / 2 - 0.25, yb, z1 + 0.25), (Wn / 2 + 0.25, yb, z1 + 0.25), (Wn / 2 + 0.25, yb, z0 - 0.25), (-Wn / 2 - 0.25, yb, z0 - 0.25)]
    zc = (z0 + z1) / 2
    t = [(-2.1, ytop, zc + 2.1), (2.1, ytop, zc + 2.1), (2.1, ytop, zc - 2.1), (-2.1, ytop, zc - 2.1)]
    for i in range(4):
        P = [c[i], c[(i + 1) % 4], t[(i + 1) % 4], t[i]]
        P = np.array(P)
        if newell(P)[1] < 0:
            P = P[::-1]
        mb.poly(P, fit('tin_green', (4, 4), i))
    P = np.array(t)
    mb.poly(P if newell(P)[1] > 0 else P[::-1], fit('tin_green', (4, 4), 9))
    # --- drum (octagon) + main onion dome (blue with gold stars)
    oct_ = [(2.0 * math.cos(PI / 8 + k * PI / 4), 2.0 * math.sin(PI / 8 + k * PI / 4)) for k in range(8)]
    dy0, dy1 = ytop - 0.1, ytop + 3.2
    prism(mb, [(p[0], p[1] + zc) for p in oct_][::-1], dy0, dy1, pl, (2, 2))
    for k in range(8):   # narrow windows on alternate faces
        if k % 2:
            continue
        a = PI / 8 + k * PI / 4 + PI / 8
        cx, cz = 1.86 * math.cos(a), 1.86 * math.sin(a) + zc
        Mw = frame((cx, 0, cz), (math.sin(a), 0, -math.cos(a)), (0, 1, 0))
        quad(mb, [(-0.3, dy0 + 0.8, 0.02), (0.3, dy0 + 0.8, 0.02), (0.3, dy0 + 2.6, 0.02), (-0.3, dy0 + 2.6, 0.02)], RS('church_window', 0.25, 0.05, 0.75, 0.93), M=Mw)
    lathe(mb, [(2.25, dy1), (2.25, dy1 + 0.25), (2.05, dy1 + 0.3)], 8, 'paint_white', M=T(0, 0, zc))
    onion(mb, dy1 + 0.3, 1.75, 4.4, 'dome_blue', 0, zc, segs=18)
    # --- bell tower / narthex at the front: x -2.6..2.6, z 4.5..8 ; belfry with arched openings
    Wt, zt0, zt1, Ht = 5.2, 4.5, 7.6, 10.5
    door = arch_poly(0, PL, 1.6, 2.9)
    belfry = [arch_poly(0, 7.4, 1.6, 2.4)]
    wall(mb, (-Wt / 2, PL, Wt / 2, Ht), 0.5, pl, tile, holes=[door] + belfry, M=T(0, 0, zt1), back='plaster_burnt', cap='none', side=pl)
    for s in (1, -1):
        bel = [arch_poly(0, 7.4, 1.4, 2.4)]
        lower = [arch_poly(0, 2.6, 0.8, 1.8)]
        wall(mb, (-(zt1 - zt0) / 2, PL, (zt1 - zt0) / 2 + 0.0, Ht), 0.5, pl, tile, holes=bel + lower,
             M=RY(s * PI / 2, (s * Wt / 2, 0, (zt0 + zt1) / 2)), back='plaster_burnt', cap='none', side=pl)
        Ms = RY(s * PI / 2, (s * (Wt / 2 - 0.3), 0, (zt0 + zt1) / 2))
        quad(mb, [(-0.4, 2.6, 0), (0.4, 2.6, 0), (0.4, 4.4, 0), (-0.4, 4.4, 0)], RS('church_window', 0.25, 0.05, 0.75, 0.93), M=Ms)
    # tower back face above the nave roof
    wall(mb, (-Wt / 2, Hn, Wt / 2, Ht), 0.5, pl, tile, M=RY(PI, (0, 0, zt0 - 0.0)), back='plaster_burnt', cap='none')
    # door leaves, icon above the door, belfry floor + bell
    quad(mb, [(-0.8, PL, zt1 - 0.25), (0.8, PL, zt1 - 0.25), (0.8, PL + 2.9 - 0.8, zt1 - 0.25), (-0.8, PL + 2.9 - 0.8, zt1 - 0.25)], 'church_door', ((0, 0), (1, 0), (1, 0.78), (0, 0.78)))
    quad(mb, [(-0.55, PL + 3.3, zt1 + 0.02), (0.55, PL + 3.3, zt1 + 0.02), (0.55, PL + 4.6, zt1 + 0.02), (-0.55, PL + 4.6, zt1 + 0.02)], 'icon')
    tquad(mb, (-Wt / 2 + 0.5, 7.35, zt1 - 0.5), (1, 0, 0), (0, 0, -1), Wt - 1.0, zt1 - zt0 - 0.5, 'wood_raw', (1, 1))
    lathe(mb, [(0.5, 8.0), (0.46, 8.12), (0.32, 8.45), (0.25, 8.85), (0.12, 8.98), (0.0, 9.02)], 10, 'dome_gold', M=T(0, 0, (zt0 + zt1) / 2))
    tbox(mb, (-Wt / 2 - 0.15, Ht - 0.1, zt0 - 0.15), (Wt / 2 + 0.15, Ht + 0.15, zt1 + 0.15), 'paint_white', (1, 1), faces='+x-x+z-z-y')
    # tower roof (4-sided low pyramid) + small drum + gold onion (dented, shrapnel-holed)
    c = [(-Wt / 2 - 0.2, Ht + 0.15, zt1 + 0.2), (Wt / 2 + 0.2, Ht + 0.15, zt1 + 0.2), (Wt / 2 + 0.2, Ht + 0.15, zt0 - 0.2), (-Wt / 2 - 0.2, Ht + 0.15, zt0 - 0.2)]
    tc = (zt0 + zt1) / 2
    t = [(-0.9, Ht + 1.2, tc + 0.9), (0.9, Ht + 1.2, tc + 0.9), (0.9, Ht + 1.2, tc - 0.9), (-0.9, Ht + 1.2, tc - 0.9)]
    for i in range(4):
        P = np.array([c[i], c[(i + 1) % 4], t[(i + 1) % 4], t[i]])
        if newell(P)[1] < 0:
            P = P[::-1]
        mb.poly(P, fit('tin_green', (3, 3), 10 + i))
    prism(mb, [(0.85 * math.cos(k * PI / 4 + PI / 8), 0.85 * math.sin(k * PI / 4 + PI / 8) + tc) for k in range(8)][::-1], Ht + 1.1, Ht + 2.4, pl, (1.5, 1.5))
    jit = lambda i, k: 1.0 - (0.18 if (k in (3, 4) and 2 <= i <= 4) else 0.0)
    onion(mb, Ht + 2.4, 0.8, 2.2, 'dome_gold', 0, tc, segs=14, jitter=jit, tilt=rot_axis((0, 0, 1), 0.07))
    # apse: half cylinder + half cone roof
    Ra = 2.6
    lathe_half = []
    segs = 8
    za = z0 - 0.1
    for k in range(segs):
        a0, a1 = PI + k * PI / segs, PI + (k + 1) * PI / segs
        p0 = (Ra * math.cos(a0), za + Ra * math.sin(a0)); p1 = (Ra * math.cos(a1), za + Ra * math.sin(a1))
        L = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        tquad(mb, (p1[0], PL, p1[1]), (p0[0] - p1[0], 0, p0[1] - p1[1]), (0, 1, 0), L, 6.2 - PL, pl, (2, 2))
        if k in (2, 5):
            am = (a0 + a1) / 2
            Mw = frame((Ra * 1.01 * math.cos(am), 0, za + Ra * 1.01 * math.sin(am)), (math.sin(am), 0, -math.cos(am)), (0, 1, 0))
            quad(mb, [(-0.35, 2.6, 0), (0.35, 2.6, 0), (0.35, 4.6, 0), (-0.35, 4.6, 0)], RS('church_window', 0.25, 0.05, 0.75, 0.93), M=Mw)
        # half-cone roof
        q0 = (Ra + 0.25) * math.cos(a0), za + (Ra + 0.25) * math.sin(a0); q1 = (Ra + 0.25) * math.cos(a1), za + (Ra + 0.25) * math.sin(a1)
        P = np.array([(q0[0], 6.2, q0[1]), (q1[0], 6.2, q1[1]), (0, 7.6, za)])
        if newell(P)[1] < 0:
            P = P[::-1]
        mb.poly(P, fit('tin_green', (3, 3), 30 + k))
    # damage: soot plume above the hole, fallen roof sheet, rubble, a broken-off cross on the ground
    for k in range(3):
        Mx = mat_trs((Wn / 2 + r.uniform(0.8, 2.5), 0.05, zc + r.uniform(-3, 1)), (-PI / 2 + r.uniform(-0.2, 0.2), r.uniform(0, PI), 0))
        sheet(mb, 1.6, 0.9, 3, 2, 'tin_green', Mx @ T(-0.8, -0.45, 0), bend=lambda u, v, k=k: (0, 0, 0.2 * math.sin(u * 4 + k) * v), double=True)
    loose_bricks(mb, Wn / 2 + 1.0, zc - 2.2 + 0.0, 1.2, 50, 'red', seed)
    for k in range(10):
        chunk(mb, (Wn / 2 + r.uniform(0.3, 2.0), 0.1, zc - 2.2 + r.uniform(-1.2, 1.2)), (0.5, 0.3, 0.4), seed + 40 + k, pl)
    Mx = mat_trs((-Wn / 2 - 1.6, 0.05, zc + 1.5), (PI / 2, 0.7, 0))
    fbox(mb, (-0.03, 0, -0.03), (0.03, 1.3, 0.03), 'dome_gold', M=Mx)
    fbox(mb, (-0.25, 0.85, -0.025), (0.25, 0.9, 0.025), 'dome_gold', M=Mx)
    # tin roof torn on the nave: a patch with exposed battens
    Mp = frame((Wn / 2 - 1.0, yb + 0.25, zc - 2.6), (0, 0, 1), (-0.73, 0.68, 0))
    tquad(mb, (0, 0, 0.03), (1, 0, 0), (0, 1, 0), 1.8, 1.0, 'wood_raw', (1, 1), M=Mp)
    return mb


# ====================================================================== market pavilions
def pavilion(name, kind, sign_row, seed):
    mb = MB(name); r = rng(seed)
    W, D, Hh = 3.2, 2.6, 2.6
    wreg = 'pav_panel' if kind != 'burnt' else 'charred'
    ptile = (1.0, Hh)
    front_hole = [(-1.4, 0.1, 1.4, 2.2)]
    if kind == 'stall':   # open market stall: frame, counter, tarp roof
        for x in (-1.5, 1.5):
            for z in (-1.2, 1.2):
                post(mb, x, 2.4 if z > 0 else 2.1, 'metal_rust_paint', 0.05, z)
        Mt = frame((-1.65, 2.42, 1.4), (1, 0, 0), (0, 0.11, -1))
        sheet(mb, 3.3, 2.8, 4, 3, 'tarp', Mt, bend=lambda u, v: (0, 0, -0.12 * math.sin(u * PI) * math.sin(v * PI)), double=True)
        fbox(mb, (-1.5, 0, 0.9), (1.5, 0.95, 1.25), 'pav_panel', faces='+x-x+y+z-z')
        fbox(mb, (-1.5, 0.95, 0.85), (1.5, 1.0, 1.3), 'wood_raw', faces='+y-y+z+x-x')
        for k in range(10):   # crates
            x = -1.3 + (k % 5) * 0.55; zz = 0.98 if k < 5 else -0.9
            fbox(mb, (x - 0.22, 1.0 if k < 5 else 0, zz - 0.15), (x + 0.22, 1.25 if k < 5 else 0.28, zz + 0.15), 'wood_raw', faces='+x-x+y+z-z')
        quad(mb, [(-1.5, 2.45, 1.42), (1.5, 2.45, 1.42), (1.5, 2.85, 1.42), (-1.5, 2.85, 1.42)], RS('pav_signs', 0, (3 - sign_row) / 4, 1, (4 - sign_row) / 4), double=True)
        return mb
    wall(mb, (-W / 2, 0, W / 2, Hh), 0.06, wreg, ptile, holes=front_hole, M=T(0, 0, D / 2), back='metal_grey', side='metal_grey', cap='all')
    wall(mb, (-W / 2, 0, W / 2, Hh), 0.06, wreg, ptile, M=RY(PI, (0, 0, -D / 2)), back='metal_grey', side='metal_grey', cap='all')
    for s in (1, -1):
        holes = [(-0.5, 1.2, 0.5, 2.0)] if s > 0 else []
        wall(mb, (-D / 2 + 0.06, 0, D / 2 - 0.06, Hh), 0.06, wreg, ptile, holes=holes, M=RY(s * PI / 2, (s * W / 2, 0, 0)), back='metal_grey', side='metal_grey', cap='all')
        if s > 0:
            quad(mb, [(-0.5, 1.2, -0.03), (0.5, 1.2, -0.03), (0.5, 2.0, -0.03), (-0.5, 2.0, -0.03)], 'glass_dark', M=RY(PI / 2, (W / 2, 0, 0)))
    # roof with a slight overhang + a front canopy and the sign box on top
    sag = 0.35 if kind == 'burnt' else 0.0
    Mroof = rot_axis((0, 0, 1), 0.08, (W / 2, Hh, 0)) if kind == 'burnt' else np.eye(4)
    fbox(mb, (-W / 2 - 0.1, Hh, -D / 2 - 0.1), (W / 2 + 0.1, Hh + 0.12, D / 2 + 0.6), 'metal_grey', faces='+x-x+y-y+z-z', M=Mroof)
    sreg = RS('pav_signs', 0, (3 - sign_row) / 4, 1, (4 - sign_row) / 4)
    Ms = rot_axis((1, 0, 0), 0.0, (0, Hh, D / 2)) if kind != 'burnt' else rot_axis((0, 0, 1), -0.18, (-W / 2, Hh, 0))
    fbox(mb, (-W / 2, Hh + 0.12, D / 2 + 0.4), (W / 2, Hh + 0.7, D / 2 + 0.55), 'metal_grey', faces='+x-x+y-z', M=Ms)
    quad(mb, [(-W / 2, Hh + 0.12, D / 2 + 0.551), (W / 2, Hh + 0.12, D / 2 + 0.551), (W / 2, Hh + 0.7, D / 2 + 0.551), (-W / 2, Hh + 0.7, D / 2 + 0.551)], sreg, M=Ms)
    # shutter box + shutter curtain
    fbox(mb, (-1.45, 2.2, D / 2 - 0.02), (1.45, 2.42, D / 2 + 0.2), 'metal_grey', faces='+x-x+y-y+z')
    zf = D / 2 + 0.06
    if kind == 'closed':
        tquad(mb, (-1.4, 0.1, zf), (1, 0, 0), (0, 1, 0), 2.8, 2.1, 'shutter', (1.4, 1.05))
    else:
        top = 1.3 if kind == 'open' else 0.9
        rows = []
        for j in range(4):
            v = j / 3
            row = []
            for i in range(6):
                u = i / 5
                y = 2.2 - (2.2 - top) * v
                dz = (0.25 * math.sin(u * PI) * v * v) if kind == 'open' else 0.0
                row.append((-1.4 + 2.8 * u, y, zf + dz))
            rows.append(row)
        ribbon(mb, rows, 'shutter', double=True)
        # broken glass behind, counter and shelves inside
        quad(mb, [(-1.4, 0.1, D / 2 - 0.05), (1.4, 0.1, D / 2 - 0.05), (1.4, 0.95, D / 2 - 0.05), (-1.4, 0.95, D / 2 - 0.05)], 'glass_dark')
        fbox(mb, (-1.4, 0, D / 2 - 0.6), (1.4, 1.0, D / 2 - 0.1), 'pav_panel', faces='+y+z')
        for y in (0.6, 1.2, 1.8):
            fbox(mb, (-1.5, y, -D / 2 + 0.06), (1.5, y + 0.03, -D / 2 + 0.45), 'wood_raw', faces='+y-y+z')
        quad(mb, [(-1.5, 0.0, -D / 2 + 0.07), (1.5, 0.0, -D / 2 + 0.07), (1.5, Hh, -D / 2 + 0.07), (-1.5, Hh, -D / 2 + 0.07)], 'metal_grey')
        for k in range(8):
            chunk(mb, (r.uniform(-1.4, 1.4), 0.04, D / 2 + r.uniform(0.1, 1.2)), (0.25, 0.05, 0.2), seed + k, 'glass_dark')
    tquad(mb, (-W / 2 + 0.06, 0.02, D / 2 - 0.06), (1, 0, 0), (0, 0, -1), W - 0.12, D - 0.12, 'wood_raw' if kind != 'burnt' else 'charred', (1, 1))
    return mb


# ====================================================================== billboard
def billboard(name, front, back, torn=False, seed=90):
    mb = MB(name); r = rng(seed)
    y0, Wb, Hb = 4.2, 6.0, 3.0
    fbox(mb, (-0.17, 0, -0.17), (0.17, y0 + 0.4, 0.17), 'metal_grey', faces='+x-x+z-z')
    tbox(mb, (-0.5, 0, -0.5), (0.5, 0.25, 0.5), 'concrete', (1, 1), faces='+x-x+y+z-z')
    M = T(0, 0, 0) if not torn else rot_axis((0, 0, 1), 0.09, (0, y0, 0))
    # frame box and the two faces
    fbox(mb, (-Wb / 2 - 0.08, y0 - 0.08, -0.2), (Wb / 2 + 0.08, y0 + Hb + 0.08, 0.2), 'metal_grey', faces='+x-x+y-y', M=M)
    holes = [blob(1.5, 1.4, 1.1, 0.8, 14, seed, 0.4, 0.3), blob(-2.0, 0.6, 0.6, 0.4, 10, seed + 1, 0.4, 0.3)] if torn else []
    wall(mb, (-Wb / 2, 0, Wb / 2, Hb), 0.0, front, (Wb, Hb), holes=holes, M=M @ T(0, y0, 0.2), back=False, cap='none', org=(-Wb / 2, 0))
    wall(mb, (-Wb / 2, 0, Wb / 2, Hb), 0.0, back, (Wb, Hb), M=M @ RY(PI, (0, y0, -0.2)), back=False, cap='none', org=(-Wb / 2, 0))
    if torn:   # backing plate visible through the tears + a hanging paper strip
        tquad(mb, (-Wb / 2, y0, 0.12), (1, 0, 0), (0, 1, 0), Wb, Hb, 'metal_grey', (1.5, 1.5), M=M)
        sheet(mb, 0.9, 1.4, 2, 4, front, M @ T(0.9, y0 + 0.2 - 1.2, 0.24), bend=lambda u, v: (0.15 * (1 - v), 0, 0.2 * (1 - v) ** 2), double=True,
              uv_rect=(0.62, 0.15, 0.8, 0.6))
    # maintenance walkway + lamps on arms
    fbox(mb, (-Wb / 2, y0 - 0.12, 0.2), (Wb / 2, y0 - 0.08, 0.75), 'louvre', faces='+y-y+z', M=M)
    for x in (-1.8, 1.8):
        tube(mb, [(x, y0 + Hb + 0.05, 0.2), (x, y0 + Hb + 0.45, 0.7)], 0.025, 4, 'metal_grey', smooth=False, M=M)
        fbox(mb, (x - 0.2, y0 + Hb + 0.35, 0.65), (x + 0.2, y0 + Hb + 0.47, 0.9), 'metal_grey', M=M)
    return mb


# ====================================================================== bench, bin, lamp
def bench(name, kind='concrete', seed=100):
    mb = MB(name); r = rng(seed)
    L = 2.0
    if kind == 'concrete':
        for x in (-0.75, 0.75):
            P = [(x - 0.07, 0, 0.25), (x - 0.07, 0, -0.3), (x - 0.07, 0.42, -0.25), (x - 0.07, 0.95, -0.38), (x - 0.07, 0.95, -0.25), (x - 0.07, 0.45, -0.12), (x - 0.07, 0.42, 0.25)]
            wall(mb, [(-p[2], p[1]) for p in P], 0.14, 'concrete', (1, 1), M=RY(PI / 2, (x + 0.07, 0, 0)), cap='all')
    else:
        for x in (-0.85, 0.85):
            tube(mb, [(x, 0, 0.22), (x, 0.42, 0.22)], 0.025, 4, 'metal_rust_paint', smooth=False)
            tube(mb, [(x, 0, -0.25), (x, 0.42, -0.2), (x, 0.92, -0.33)], 0.025, 4, 'metal_rust_paint', smooth=False)
            tube(mb, [(x, 0.42, 0.26), (x, 0.42, -0.22)], 0.022, 4, 'metal_rust_paint', smooth=False)
    seat = [(0.18, 0), (0.05, 1), (-0.08, 2), (-0.21, 3)] if kind == 'concrete' else [(0.17, 0), (0.03, 1), (-0.11, 2)]
    for z, k in seat:
        if kind != 'concrete' and k == 1:
            Mx = rot_axis((0, 0, 1), -0.22, (-L / 2, 0.45, 0))
        else:
            Mx = np.eye(4)
        fbox(mb, (-L / 2, 0.42, z - 0.055), (L / 2, 0.46, z + 0.055), RS('bench_wood', 0, k / 4, 1, (k + 1) / 4), faces='+y-y+z-z+x-x', M=Mx)
    for y, k in ((0.62, 1), (0.82, 2)):
        if kind != 'concrete' and k == 2:
            continue
        zb = -0.25 - (y - 0.45) * 0.24
        fbox(mb, (-L / 2, y - 0.055, zb - 0.02), (L / 2, y + 0.055, zb + 0.02), RS('bench_wood', 0, k / 4, 1, (k + 1) / 4), faces='+y-y+z-z+x-x',
             M=rot_axis((1, 0, 0), -0.24, (0, y, zb)))
    return mb


def waste_bin(name, tipped=False, seed=110):
    """Soviet 0.75 m3 steel waste container: tapered open box, lifting trunnions, skids."""
    mb = MB(name); r = rng(seed)
    bx, bz, tx, tz, Hh = 0.55, 0.38, 0.66, 0.47, 1.05
    reg = 'bin_green' if not tipped else 'metal_rust_paint'
    b = [(-bx, 0.08, bz), (bx, 0.08, bz), (bx, 0.08, -bz), (-bx, 0.08, -bz)]
    t = [(-tx, Hh, tz), (tx, Hh, tz), (tx, Hh, -tz), (-tx, Hh, -tz)]
    tmp = MB()
    for i in range(4):
        P = np.array([b[i], b[(i + 1) % 4], t[(i + 1) % 4], t[i]])
        tmp.poly(P, uvq(reg)); tmp.poly(P[::-1] * [0.985, 1, 0.985] + [0, 0.0, 0], uvq('metal_rust_paint', ((0, 1), (1, 1), (1, 0), (0, 0))))
    P = np.array(b)
    tmp.poly(P[::-1], uvq('metal_rust_paint')); tmp.poly(P + [0, 0.02, 0], uvq('metal_rust_paint'))
    # rim band, trunnions, skids, rubbish inside
    for i in range(4):
        a, c = np.array(t[i]), np.array(t[(i + 1) % 4])
        d = c - a; n = np.cross(d, [0, 1, 0]); n = n / np.linalg.norm(n)
        Q = np.array([a + [0, -0.08, 0] - n * 0.02, c + [0, -0.08, 0] - n * 0.02, c - n * 0.02, a - n * 0.02])
        tmp.poly(Q if newell(Q) @ (-n) > 0 else Q[::-1], uvq('metal_grey'))
    for s in (-1, 1):
        tube(tmp, [(s * 0.6, 0.85, 0), (s * 0.78, 0.85, 0)], 0.05, 6, 'metal_grey', cap=True, smooth=False)
        fbox(tmp, (-0.62, 0, s * 0.3 - 0.04), (0.62, 0.08, s * 0.3 + 0.04), 'metal_rust_paint', faces='+x-x+y+z-z')
    if not tipped:
        for k in range(5):
            chunk(tmp, (r.uniform(-0.4, 0.4), 0.85 + r.uniform(0, 0.25), r.uniform(-0.25, 0.25)), (0.35, 0.3, 0.3), seed + k, ['cable', 'paint_white', 'tarp', 'wood_raw', 'rubber'][k])
        mb.merge(tmp)
    else:
        mb.merge(tmp, mat_trs((0, 0.47, -0.5), (PI / 2 + 0.05, 0.2, 0)))
        for k in range(9):
            chunk(mb, (r.uniform(-0.6, 0.6), 0.08, r.uniform(0.9, 1.8)), (0.3, 0.16, 0.25), seed + 10 + k, ['cable', 'paint_white', 'tarp', 'wood_raw', 'rubber', 'ground'][k % 6])
    return mb


def lamp(name, kind='intact', seed=120):
    """Concrete street lamp (SV-type tapered octagonal pole) with a curved steel arm and a cobra head, arm towards +Z."""
    mb = MB(name); r = rng(seed)
    Hp = 8.6
    lathe(mb, [(0.15, 0), (0.15, 0.6), (0.085, Hp)], 8, 'lamp_conc', smooth=False, around=1.0)
    lathe(mb, [(0.085, Hp), (0.0, Hp + 0.02)], 8, 'lamp_conc', smooth=False)
    fbox(mb, (-0.11, Hp - 0.45, -0.11), (0.11, Hp - 0.2, 0.11), 'metal_rust_paint')   # clamp
    if kind == 'intact':
        arm = [(0, Hp - 0.35, 0.05), (0, Hp + 0.2, 0.25), (0, Hp + 0.55, 0.7), (0, Hp + 0.7, 1.3), (0, Hp + 0.72, 2.0)]
        head_M = mat_trs((0, Hp + 0.72, 2.0), (0.06, 0, 0))
    else:   # arm bent down by blast, head hanging on its cable
        arm = [(0, Hp - 0.35, 0.05), (0, Hp + 0.2, 0.25), (0, Hp + 0.45, 0.7), (0.1, Hp + 0.3, 1.1), (0.2, Hp - 0.2, 1.3)]
        head_M = mat_trs((0.2, Hp - 1.0, 1.4), (1.3, 0.3, 0.2))
        tube(mb, [(0.2, Hp - 0.2, 1.3), (0.22, Hp - 0.6, 1.33), (0.2, Hp - 0.9, 1.4)], 0.008, 3, 'cable', smooth=False)
    tube(mb, arm, 0.035, 6, 'metal_grey', seg=1.0)
    # cobra head: tapered box, glass bowl underneath
    hb = [(-0.14, -0.04, -0.1), (0.14, -0.04, -0.1), (0.16, -0.06, 0.55), (-0.16, -0.06, 0.55)]
    ht = [(-0.1, 0.08, -0.1), (0.1, 0.08, -0.1), (0.12, 0.05, 0.5), (-0.12, 0.05, 0.5)]
    tmp = MB()
    for i in range(4):
        P = np.array([hb[i], hb[(i + 1) % 4], ht[(i + 1) % 4], ht[i]])
        c = P.mean(0)
        if newell(P) @ (c - np.array([0, 0.0, 0.22])) < 0:
            P = P[::-1]
        tmp.poly(P, uvq('metal_grey'))
    tmp.poly(np.array(ht)[::-1] if newell(np.array(ht))[1] < 0 else np.array(ht), uvq('metal_grey'))
    tmp.poly(np.array(hb) if newell(np.array(hb))[1] < 0 else np.array(hb)[::-1], uvq('glass_dark'))
    mb.merge(tmp, head_M)
    if kind != 'intact':   # spalled concrete near the base with rebar
        for k in range(4):
            a = r.uniform(0, 2 * PI)
            tube(mb, [(0.1 * math.cos(a), 1.0 + k * 0.15, 0.1 * math.sin(a)), (0.16 * math.cos(a), 1.1 + k * 0.15, 0.16 * math.sin(a))], 0.006, 3, 'pipe_rust', smooth=False)
        for k in range(5):
            chunk(mb, (r.uniform(-0.6, 0.6), 0.05, r.uniform(-0.6, 0.6)), (0.12, 0.07, 0.1), seed + k, 'lamp_conc')
    return mb


# ====================================================================== parked Soviet cars
CARS = {
    # L, W, wheelbase, sill, belt, roof, hood/trunk heights, greenhouse z (base front, base rear, top front, top rear)
    'lada': dict(L=4.07, W=1.61, wb=2.42, belt=0.86, roof=1.38, hood=0.83, trunk=0.86, g=(0.62, -1.12, 0.18, -0.85), r=0.29),
    'moskvich': dict(L=4.25, W=1.55, wb=2.40, belt=0.88, roof=1.46, hood=0.86, trunk=0.9, g=(0.66, -1.18, 0.2, -0.98), r=0.3),
    'volga': dict(L=4.74, W=1.80, wb=2.80, belt=0.9, roof=1.47, hood=0.88, trunk=0.92, g=(0.72, -1.3, 0.22, -0.98), r=0.33),
}


def car(name, model, paint, seed, flat=(), broken_glass=False):
    mb = MB(name); r = rng(seed)
    c = CARS[model]
    L, Wc, belt, roof = c['L'], c['W'], c['belt'], c['roof']
    hw = Wc / 2
    zf, zr = L / 2, -L / 2
    # lower body: loft of 6-point sections (x, y) along z
    def prof(bot, top, w):
        return [(-w, bot), (w, bot), (w + 0.015, bot + (top - bot) * 0.55), (w - 0.03, top), (-(w - 0.03), top), (-(w + 0.015), bot + (top - bot) * 0.55)]
    st = [(zf, prof(0.36, c['hood'] - 0.12, hw - 0.06)), (zf - 0.1, prof(0.26, c['hood'] - 0.02, hw - 0.01)), (zf - 0.6, prof(0.22, c['hood'], hw)),
          (c['g'][0], prof(0.22, belt, hw)), (c['g'][1], prof(0.22, belt, hw)), (zr + 0.55, prof(0.22, c['trunk'], hw)),
          (zr + 0.1, prof(0.27, c['trunk'] - 0.02, hw - 0.01)), (zr, prof(0.38, c['trunk'] - 0.1, hw - 0.06))]
    body = RS(paint, 0, 0, 1, 1)
    def body_uv(P, n):
        ax = np.abs(n)
        out = []
        for p in P:
            if ax[1] > 0.7:
                out.append(body.uv(0.5 + p[0] / Wc * 0.9, 0.55 + 0.4 * (p[2] / L)))
            else:
                s = 0.5 - p[2] / L if abs(n[0]) > 0.3 else 0.5 + p[0] / Wc
                out.append(body.uv(s, (p[1] - 0.2) / 0.75))
        return out
    rings = [[(x, y, z) for (x, y) in pr] for z, pr in st]
    N = 6
    for i in range(len(rings) - 1):
        for k in range(N):
            k2 = (k + 1) % N
            if k == 0:
                Q = np.array([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]])
                Q = Q if newell(Q)[1] < 0 else Q[::-1]
                mb.poly(Q, uvq('metal_rust_paint'))
                continue
            Q = np.array([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]])
            cc = Q.mean(0)
            if np.dot(newell(Q), [cc[0], cc[1] - 0.5, 0]) < 0:
                Q = Q[::-1]
            mb.poly(Q, body_uv)
    fr = RS('car_front', 0, 0.5, 1, 1); rr_ = RS('car_front', 0, 0, 1, 0.5)
    for ring, reg, sgn in ((rings[0], fr, 1), (rings[-1], rr_, -1)):
        P = np.array(ring)
        if newell(P)[2] * sgn < 0:
            P = P[::-1]
        ys = P[:, 1]; y0_, y1_ = ys.min(), ys.max()
        uv = [reg.uv(0.5 + sgn * p[0] / Wc, 0.15 + 0.85 * (p[1] - y0_) / (y1_ - y0_)) for p in P]
        mb.poly(P, lambda P_, n_, uv=uv: uv)
    # greenhouse: glass sides/screens, painted roof and pillars
    gbf, gbr, gtf, gtr = c['g']
    wb_, wt_ = hw - 0.04, hw - 0.17
    gb = [(-wb_, belt, gbf), (wb_, belt, gbf), (wb_, belt, gbr), (-wb_, belt, gbr)]
    gt = [(-wt_, roof, gtf), (wt_, roof, gtf), (wt_, roof, gtr), (-wt_, roof, gtr)]
    glass = 'glass_dark' if broken_glass else 'car_glass'
    for i in range(4):
        P = np.array([gb[i], gb[(i + 1) % 4], gt[(i + 1) % 4], gt[i]])
        cc = P.mean(0)
        if np.dot(newell(P), cc - np.array([0, belt, (gbf + gbr) / 2])) < 0:
            P = P[::-1]
        mb.poly(P, uvq(glass if not (broken_glass and i == 1) else 'rubber'))
    Pt = np.array(gt)
    mb.poly(Pt if newell(Pt)[1] > 0 else Pt[::-1], lambda P, n: [body.uv(0.5 + p[0] / Wc * 0.8, 0.6 + 0.3 * (p[2] - gtr) / (gtf - gtr)) for p in P])
    for s in (-1, 1):   # A, B, C pillars as painted strips just outside the glass
        for (zb, zt, wdt) in ((gbf, gtf, 0.07), ((gbf + gbr) / 2 + 0.05, (gtf + gtr) / 2 + 0.05, 0.08), (gbr, gtr, 0.12)):
            pb = np.array([s * (wb_ + 0.006), belt, zb]); pt = np.array([s * (wt_ + 0.006), roof, zt])
            d = np.array([0, 0, wdt])
            Q = np.array([pb - d, pb + d, pt + d, pt - d]) if s > 0 else np.array([pb + d, pb - d, pt - d, pt + d])
            if newell(Q)[0] * s < 0:
                Q = Q[::-1]
            mb.poly(Q, uvq(body))
    # bumpers (chrome), wheels
    for zz, sg in ((zf + 0.02, 1), (zr - 0.02, -1)):
        fbox(mb, (-hw + 0.02, 0.33, min(zz, zz - sg * 0.1)), (hw - 0.02, 0.45, max(zz, zz - sg * 0.1)), 'chrome', faces='+x-x+y-y' + ('+z' if sg > 0 else '-z'))
    wr = c['r']
    for sx in (-1, 1):
        for sz in (1, -1):
            z = sz * c['wb'] / 2 - 0.05
            fl = (sx, sz) in flat
            y = wr - (0.07 if fl else 0)
            sides = 10
            ring = [(0, y + wr * math.cos(2 * PI * k / sides) * (1 if not fl else 1), z + wr * math.sin(2 * PI * k / sides)) for k in range(sides)]
            xo, xi = sx * (hw + 0.03), sx * (hw - 0.17)
            if fl:
                ring = [(0, max(0.0, p[1]), p[2]) for p in ring]
            A = mb.vs([(xo, p[1], p[2]) for p in ring]); B = mb.vs([(xi, p[1], p[2]) for p in ring])
            tr = R['tyre']
            for k in range(sides):
                k2 = (k + 1) % sides
                idx = [A[k], A[k2], B[k2], B[k]]
                P = np.array([mb.V[i] for i in idx])
                cc = P.mean(0)
                if np.dot(newell(P), cc - np.array([cc[0], y, z])) < 0:
                    idx = idx[::-1]
                mb.face(idx, [tr.uv(0.02, 0.02), tr.uv(0.12, 0.02), tr.uv(0.12, 0.12), tr.uv(0.02, 0.12)], True)
            face = A if sx > 0 else A[::-1]
            Pf = np.array([mb.V[i] for i in face])
            if newell(Pf)[0] * sx < 0:
                face = face[::-1]
            mb.face(face, [tr.uv(0.5 + 0.5 * (mb.V[i][2] - z) / wr * (1 if sx > 0 else -1), 0.5 + 0.5 * (mb.V[i][1] - y) / wr) for i in face], False)
    # dark wheel arches/underside so the wheels read
    for sz in (1, -1):
        z = sz * c['wb'] / 2 - 0.05
        for sx in (-1, 1):
            x = sx * (hw + 0.017)
            P = [(x, 0.22, z - wr - 0.06), (x, 0.22, z + wr + 0.06), (x, 0.22 + wr * 0.9, z + wr * 0.7), (x, 0.22 + wr * 1.05, z), (x, 0.22 + wr * 0.9, z - wr * 0.7)]
            P = np.array(P)
            if newell(P)[0] * sx < 0:
                P = P[::-1]
            mb.poly(P, uvq('rubber'))
    return mb


# ====================================================================== road signs, goal, laundry
def sign_road(name, kind, seed=130):
    mb = MB(name)
    q = 128.0
    tube(mb, [(0, 0, 0), (0, 2.6, 0)], 0.03, 6, 'metal_grey', seg=2.6, cap=True)
    size = 0.75
    rect = {'give_way': (0, 0), 'crossing': (1, 0), 'children': (0, 1), 'no_entry': (1, 1)}
    if kind == 'dir':
        tube(mb, [(0.62, 0, 0), (0.62, 2.6, 0)], 0.03, 6, 'metal_grey', seg=2.6, cap=True)
        for x0 in (0.0,):
            P = np.array([(-0.1, 1.5, 0.04), (0.72, 1.5, 0.04), (0.72, 2.6, 0.04), (-0.1, 2.6, 0.04)])
            quad(mb, P, 'sign_dir'); quad(mb, P[::-1] - [0, 0, 0.01], 'metal_grey')
        return mb
    qx, qy = rect[kind]
    if kind == 'give_way':
        pts = [(6, 8), (q - 6, 8), (q / 2, q - 8)]
    elif kind == 'children':
        pts = [(q / 2, 8), (q - 6, q - 10), (6, q - 10)]
    elif kind == 'crossing':
        pts = [(6, 6), (q - 6, 6), (q - 6, q - 6), (6, q - 6)]
    else:
        pts = [(q / 2 + (q / 2 - 8) * math.cos(a), q / 2 + (q / 2 - 8) * math.sin(a)) for a in np.linspace(0, 2 * PI, 17)[:-1]]
    reg = R['road_signs']
    P = np.array([((px - q / 2) / q * size, 2.25 + (q / 2 - py) / q * size, 0.045) for px, py in pts])
    uv = [reg.uv((px + qx * q) / (2 * q), 1 - (py + qy * q) / (2 * q)) for px, py in pts]
    if newell(P)[2] < 0:
        P = P[::-1]; uv = uv[::-1]
    mb.poly(P, lambda P_, n_: uv)
    mb.poly(P[::-1] - [0, 0, 0.012], uvq('metal_grey', [(0.5, 0.5)] * len(P)))
    fbox(mb, (-0.05, 2.0, 0.025), (0.05, 2.5, 0.04), 'metal_grey', faces='+x-x+y-y+z')
    return mb


def goal(name, net=True, seed=140):
    """5 x 2 m mini-football goal (school yard), mouth towards +Z."""
    mb = MB(name); r = rng(seed)
    Wg, Hg, Dg = 5.0, 2.0, 1.2
    rg = 'paint_white'
    tube(mb, [(-Wg / 2, 0, 0), (-Wg / 2, Hg, 0), (Wg / 2, Hg, 0), (Wg / 2, 0, 0)], 0.04, 6, rg, seg=1.0)
    for s in (-1, 1):
        tube(mb, [(s * Wg / 2, Hg, 0), (s * Wg / 2, Hg - 0.3, -Dg * 0.4), (s * Wg / 2, 0.03, -Dg)], 0.025, 4, rg, seg=1.0, smooth=False)
        tube(mb, [(s * Wg / 2, 0.03, 0), (s * Wg / 2, 0.03, -Dg)], 0.025, 4, rg, seg=1.0, smooth=False)
    tube(mb, [(-Wg / 2, 0.03, -Dg), (Wg / 2, 0.03, -Dg)], 0.025, 4, rg, seg=1.0, smooth=False)
    tube(mb, [(-Wg / 2, Hg - 0.3, -Dg * 0.4), (Wg / 2, Hg - 0.3, -Dg * 0.4)], 0.025, 4, rg, seg=1.0, smooth=False)
    if net:   # torn net: sagging cords on the back, partly ripped
        for k in range(17):
            x = -Wg / 2 + k * Wg / 16
            if 3 <= k <= 6:
                continue
            tube(mb, [(x, Hg - 0.3, -Dg * 0.4), (x, Hg * 0.5 - 0.15, -Dg * 0.78), (x, 0.03, -Dg)], 0.006, 3, 'cable', smooth=False)
        for j in range(1, 6):
            t = j / 6
            y = (Hg - 0.3) * (1 - t) + 0.03 * t - 0.12 * math.sin(t * PI)
            zz = -Dg * 0.4 * (1 - t) - Dg * t
            pts = [(-Wg / 2, y, zz), (-Wg / 2 + 1.0, y - 0.05, zz), (-Wg / 2 + 1.7, y - 0.3 * (j % 2), zz + 0.1)]
            tube(mb, pts, 0.006, 3, 'cable', smooth=False)
            tube(mb, [(-Wg / 2 + 1.9 + 0.2 * (j % 2), y - 0.2, zz), (Wg / 2, y, zz)], 0.006, 3, 'cable', smooth=False)
    tbox(mb, (-Wg / 2 - 0.1, 0, -0.1), (-Wg / 2 + 0.1, 0.06, 0.1), 'concrete', (1, 1), faces='+x-x+y+z-z')
    return mb


def laundry_pole(name, clothes=True, seed=150):
    mb = MB(name); r = rng(seed)
    S = 3.2
    for s in (-1, 1):
        bend = (s > 0 and not clothes)
        top = (s * S + (0.35 if bend else 0), 2.25 - (0.15 if bend else 0), 0)
        tube(mb, [(s * S, 0, 0), (s * S, 1.2, 0), top], 0.035, 6, 'metal_rust_paint', seg=1.0)
        tube(mb, [(top[0], top[1], -0.65), (top[0], top[1], 0.65)], 0.03, 6, 'metal_rust_paint', seg=1.0, cap=True)
    zs = [-0.55, -0.18, 0.18, 0.55]
    for k, z in enumerate(zs):
        if not clothes and k == 2:
            tube(mb, [(-S, 2.25, z), (-S + 1.5, 1.2, z + 0.1), (-S + 2.0, 0.02, z + 0.3)], 0.006, 3, 'cable', smooth=False)
            continue
        xr = S + (0.35 if not clothes else 0)
        yr = 2.25 - (0.15 if not clothes else 0)
        pts = [(-S + 2 * S * t + (xr - S) * t, 2.25 * (1 - t) + yr * t - 0.18 * math.sin(t * PI), z) for t in np.linspace(0, 1, 7)]
        tube(mb, pts, 0.006, 3, 'cable', smooth=False)
        if clothes:
            for j in range(3):
                if r.random() < 0.35:
                    continue
                x = -S + 0.8 + j * 1.9 + r.uniform(-0.3, 0.3)
                t = (x + S) / (2 * S)
                y = 2.25 - 0.18 * math.sin(t * PI)
                w, h = r.uniform(0.5, 0.9), r.uniform(0.45, 0.8)
                reg = ['tarp', 'paint_white', 'plaster_blue', 'car_red', 'plaster_yellow'][(k + j) % 5]
                sheet(mb, w, h, 2, 2, reg, T(x - w / 2, y - h, z), bend=lambda u, v, k=k: (0, 0, 0.05 * math.sin(u * 5 + k) * (1 - v)), double=True,
                      uv_rect=(0.1, 0.1, 0.6, 0.6))
    return mb


# ====================================================================== main
def items():
    out = []
    out += [pipe_straight('pipe_straight_a', 'intact', 1), pipe_straight('pipe_straight_torn', 'torn', 2), pipe_straight('pipe_straight_burst', 'burst', 3), pipe_loop()]
    out += [substation('substation_a', False, 40), substation('substation_damaged', True, 41)]
    out += [po2('fence_po2_a', 'a', 50), po2('fence_po2_b', 'b', 51), po2('fence_po2_broken', 'broken', 52)]
    out += [house('house_a', 8.4, 6.8, 'plaster_white', 'tin_green', 60, ridge='x', gable_reg='wood_raw', boarded={('right', 0)}),
            house('house_b', 9.0, 7.2, 'brick_red', 'slate', 61, ridge='x', roof_hole=(0, 2.0, 2.4, 1.1, 0.8), broken_windows={('front', 0), ('front', 2)},
                  trim=False, chimney_reg='brick_red', inner='plaster_blue'),
            house('house_c', 8.0, 7.0, 'plaster_burnt', 'tin_galv', 62, ridge='x', burnt=True, trim=False),
            house('house_d', 7.0, 9.2, 'plaster_blue', 'tin_red', 63, ridge='z', wall_hole=('right', 2.3, 1.6, 0.9, 0.75), broken_windows={('right', 0)},
                  chimney_reg='brick_white'),
            house('house_e', 7.6, 7.0, 'plaster_yellow', 'slate', 64, ridge='z', gable_reg='plaster_yellow', broken_windows={('front', 1)})]
    out += [fence_prof('fence_house_prof', 'prof_brown', False, 70), fence_picket('fence_house_picket', 71), fence_prof('fence_house_broken', 'prof_green', True, 72, gate=False),
            fence_prof('fence_house_plain', 'prof_green', False, 73, gate=False), fence_prof('fence_house_plain_brown', 'prof_brown', False, 74, gate=False)]
    out += [church_small()]
    out += [pavilion('pavilion_closed', 'closed', 0, 80), pavilion('pavilion_open', 'open', 1, 81), pavilion('pavilion_burnt', 'burnt', 3, 82), pavilion('pavilion_stall', 'stall', 2, 83)]
    out += [billboard('billboard_a', RS('billboard_a', 0, 0, 1, 1), RS('billboard_b', 0, 0, 1, 1), False, 90),
            billboard('billboard_b', RS('billboard_b', 0, 0, 1, 1), RS('billboard_a', 0, 0, 1, 1), False, 91),
            billboard('billboard_torn', RS('billboard_a', 0, 0, 1, 1), RS('billboard_b', 0, 0, 1, 1), True, 92)]
    out += [bench('bench_concrete', 'concrete', 100), bench('bench_steel', 'steel', 101)]
    out += [waste_bin('bin_a', False, 110), waste_bin('bin_tipped', True, 111)]
    out += [lamp('lamp_a', 'intact', 120), lamp('lamp_broken', 'broken', 121)]
    out += [car('car_parked_lada', 'lada', 'car_white', 130), car('car_parked_lada_red', 'lada', 'car_red', 131, flat={(1, 1)}),
            car('car_parked_moskvich', 'moskvich', 'car_blue', 132, broken_glass=True), car('car_parked_volga', 'volga', 'car_beige', 133, flat={(-1, -1)})]
    out += [sign_road('sign_road_give_way', 'give_way'), sign_road('sign_road_crossing', 'crossing'), sign_road('sign_road_children', 'children'),
            sign_road('sign_road_no_entry', 'no_entry'), sign_road('sign_road_dir', 'dir')]
    out += [goal('goal_a', True, 140), goal('goal_b', False, 141)]
    out += [laundry_pole('laundry_pole_a', True, 150), laundry_pole('laundry_pole_b', False, 151)]
    return out


BUDGET = {'house_': 6000, 'church': 20000, 'car_parked': 2000}


def main(only=None):
    paths = [os.path.join(CA.CACHE, f'city_atlas_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    if not all(os.path.exists(p) for p in paths) or os.environ.get('REBUILD_ATLAS'):
        paths = CA.build()
    reset_scene()
    mat = make_material('city_atlas', *paths)
    info = {}
    its = items()
    if only:
        its = [m for m in its if any(m.name.startswith(o) for o in only)]
    x = 0.0; row = 0; zrow = 0.0; rowdepth = 0.0
    for i, mb in enumerate(its):
        mn, mx = mb.bounds()
        sz = mx - mn
        if x + sz[0] > 60:
            x = 0.0; zrow -= rowdepth + 4; rowdepth = 0.0
        loc = (x - mn[0], 0, zrow - mx[2])
        x += sz[0] + 3; rowdepth = max(rowdepth, sz[2])
        mb.to_object(mb.name, [mat], smooth_angle=35, location=loc)
        info[mb.name] = {'tris': mb.tris(), 'bbox_min': [round(float(v), 2) for v in mn], 'bbox_max': [round(float(v), 2) for v in mx]}
        lim = next((v for k, v in BUDGET.items() if mb.name.startswith(k)), 8000)
        flag = '  OVER BUDGET' if mb.tris() > lim else ''
        print(f'{mb.name:26s} {mb.tris():6d} tris  size {np.round(sz, 2)}{flag}')
    out = os.path.join(REPO, 'assets', 'env', 'city.glb' if not only else '_city_test.glb')
    if only:
        out = os.path.join(REPO, 'previews', '_test', 'city_test.glb')
    size = export_glb(out)
    print(os.path.basename(out), size / 1e6, 'MB')
    if not only:
        update_manifest('city', {'file': 'city.glb', 'nodes': info, 'refs':
            'Photo record of Mariupol (Livoberezhnyi / Primorskyi private sector, Azovstal-side districts), Bakhmut, Avdiivka (Khimik), '
            'Sievierodonetsk: above-ground foil-clad heating mains on concrete sleepers with П-shaped expansion loops over paths, white silicate '
            'brick transformer kiosks with louvred steel doors, ПО-2 diamond-relief concrete fences, one-storey plastered / brick houses with '
            'tin or asbestos-slate gable roofs and blue carved window trims, profiled-sheet and picket fences with painted gates, small '
            'white Orthodox churches with blue starred / gilded onion domes, MAF market pavilions with roller shutters, concrete SV lamp posts.',
            'notes':
            'One material (city_atlas 2048^2, tools/blender/env/city_atlas.py). Every node is a top-level mesh, origin on the ground at the '
            'footprint centre, front = +Z, nodes laid out on a grid in the file (city.js instancing ignores the layout transform). '
            'Linear pieces run along local X: pipe_straight_* 6.0 m (mains at z = +-0.36, axis y = 1.0, supports at x = +-1.5 so segments '
            'tile every 6 m), pipe_loop 6.0 m (raised to 5 m over a footpath), fence_po2_* 4.0 m panel (+0.1 m gap at the 4.1 m pitch), '
            'fence_house_* 18 m with a gate at the centre. house_* plinth 0.45 + walls to 3.2 m, gable roofs; house_c is burnt and roofless, '
            'house_b has a roof hole, house_d a shell hole in its right wall (fit inside a 19 x 18 m plot, fences at z+9 / x+-9.5). '
            'lamp_* arm reaches +Z 2 m at 9.3 m. car_parked_* length along Z (front +Z). sign_road_* plate faces +Z.'})


if __name__ == '__main__':
    import time; t0 = time.time()
    main(sys.argv[1:] or None)
    print('done', round(time.time() - t0, 1), 's')
