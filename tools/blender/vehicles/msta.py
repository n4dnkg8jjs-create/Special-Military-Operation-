"""2S19M2 Msta-S 152 mm self-propelled howitzer (Russian service 2022-24 look).

Reference data (sources: arty_specs.SOURCES -> assets/vehicles/manifest.json):
  hull 7.15 m, 11.92 m gun forward, width 3.38 m over tracks (3.58 m with skirts), turret roof 2.99 m,
  clearance 0.45 m, 580 mm track on ~2.8 m centres; T-80 running gear: 6 x 670 mm road wheels, 5 return
  rollers, T-80 idler + rear drive sprocket; V-84A diesel (exhaust on the left rear fender like the T-72);
  armour 15 mm welded steel hull/turret/roof (small arms + splinters).
  2A64 152 mm L/47 (7.14 m tube) with two-chamber muzzle brake and bore evacuator, two recoil/recuperator
  cylinders above the barrel on the cradle, -4..+68 deg, 360 deg traverse.  Turret: big welded box, commander
  cupola on the right with a remote 12.7 mm mount (NSVT/Kord), gunner's 1P22 panoramic sight front-left,
  2 x 6 902V 81 mm smoke tubes on the front cheeks, crew door in the right turret side, rear ammunition
  hatch with the folded projectile conveyor (ground feed), A-frame travel lock on the glacis, dozer blade.
Authoring frame: X right, Y forward, Z up (see vlib).
"""
import sys, os, math, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
import numpy as np
from mathutils import Vector as V, Matrix
import vlib as L
from vlib import B, box, hull, prism, lathe, cyl, tube, rail, bolt, fillet_path
import vtex as T
import vbuild as VB
import t72
from btr import periscope_block, hatch_rect, louvre_panel, headlight_cluster, tow_hook, tow_cable, antenna_base

NAME = 'msta_s'
TRK_X = 1.40
TRK_W = 0.58
RW_R = 0.335                    # T-80 road wheel 670 mm
BAND = 0.06
RW_Z = RW_R + BAND
RW_Y = [2.28, 1.42, 0.56, -0.31, -1.18, -2.24]
IDL = (3.13, 0.58, 0.27)        # front idler y, z, r
SPR = (-3.17, 0.64, 0.32)       # rear drive sprocket
RR_Y = [1.86, 0.99, 0.12, -0.75, -1.71]
RR_Z, RR_R = 0.835, 0.095
BELLY = 0.45
DECK = 1.52
SUP_X = 1.30
LOW_X = 1.08
FEN_Z = 1.08
FEN_X = 1.69
NOSE = (3.50, 0.98)
GL_TOP = (2.30, DECK)
REAR_Y = -3.42
TUR_Y = -0.40                   # turret ring centre
CMD_LID = (0.64, -0.25, 0.23)    # commander's cupola lid centre (x, y) + radius: kept clear of the remote MG pedestal
TZ = DECK + 0.02                # turret base
ROOF = 2.99                     # turret roof
TRUN = (0.0, 0.95, 2.50)        # gun trunnion (authoring world)
MUZ_L = 7.50                    # trunnion -> muzzle face (muzzle 11.9 m ahead of the hull rear)
ELEV = (-4, 68)

# turret plan outlines (x half-width, y) at base and roof; front centre face / cheeks / sides / rear chamfers
# base ring -> shoulder ring (near-vertical walls) -> roof ring (sloped upper band all round)
TB = [(0.70, 1.62), (1.56, 0.62), (1.58, 0.2), (1.58, -2.40), (1.10, -2.95)]
TS = [(0.68, 1.50), (1.54, 0.56), (1.56, 0.15), (1.56, -2.38), (1.08, -2.92)]
TT = [(0.50, 1.12), (1.27, 0.40), (1.30, 0.1), (1.30, -2.24), (0.86, -2.70)]
SHOULDER = TZ + 1.02
REAR_T = -2.95                  # turret rear wall (base)
NOTCH = (0.46, 1.06)            # gun recess between the cheeks: half width, back face y

def side_x(z):
    """turret side half-width at height z"""
    if z <= SHOULDER:
        return TB[2][0] - (TB[2][0] - TS[2][0]) * (z - TZ) / (SHOULDER - TZ)
    return TS[2][0] - (TS[2][0] - TT[2][0]) * (z - SHOULDER) / (ROOF - SHOULDER)

def ring(pts, z):
    out = []
    for x, y in pts:
        out.append((x, y, z))
    for x, y in reversed(pts):
        out.append((-x, y, z))
    return out

# ================================================================================================ helpers
def glacis_pt(x, t, off=0.0):
    y = NOSE[0] + (GL_TOP[0] - NOSE[0]) * t
    z = NOSE[1] + (GL_TOP[1] - NOSE[1]) * t
    return V((x, y, z)) + glacis_n() * off

def glacis_n():
    """Outward (forward-up) unit normal of the upper glacis."""
    d = V((0, GL_TOP[0] - NOSE[0], GL_TOP[1] - NOSE[1])).normalized()
    return V((0, d.z, -d.y))

def face_frame(n, up=(0, 0, 1)):
    return L.frame_from_normal(V(n), V(up))

def perforated_box(w, h, d, nx=6, ny=2, hole=0.022):
    """Armoured box with a perforated front (local +Z out), centred, base at z=0."""
    b = box(w, h, d, c=(0, 0, d / 2), bev=0.01, segs=1)
    for i in range(nx):
        for j in range(ny):
            x = (i - (nx - 1) / 2) * (w - 0.08) / max(nx - 1, 1)
            y = (j - (ny - 1) / 2) * (h - 0.07) / max(ny - 1, 1)
            b.add(cyl(hole, 0.012, 8, 'z', c=(x, y, d + 0.001), mat='gunmetal'))
    b.add(box(w + 0.04, 0.03, 0.02, c=(0, h / 2 + 0.01, d + 0.01)))
    return b

def smoke_tube():
    tb = lathe([(0, -0.1), (0.047, -0.1), (0.047, 0.11), (0.04, 0.11), (0.04, -0.06), (0, -0.06)], 12, 'y')
    tb.add(cyl(0.052, 0.02, 12, 'y', c=(0, 0.09, 0)))
    return tb

def align_y(d):
    return V((0, 1, 0)).rotation_difference(V(d).normalized()).to_matrix().to_4x4()

# ================================================================================================ running gear
def road_wheel_t80():
    """T-80 670 mm double road wheel: pressed dished discs with a ring of lightening holes, rubber tyres.
    Axis X, outward +X, origin at the hub."""
    segs = 30
    def disc(sign):
        prof = [(0.0, 0.19), (0.06, 0.188), (0.08, 0.175), (0.10, 0.15), (0.20, 0.14), (0.25, 0.135),
                (0.272, 0.15), (0.285, 0.165, 'tyre'), (0.31, 0.168, 'tyre'), (0.33, 0.16, 'tyre'), (0.336, 0.145, 'tyre'),
                (0.337, 0.11, 'tyre'), (0.335, 0.08, 'tyre'), (0.322, 0.068, 'tyre'), (0.295, 0.065, 'tyre'), (0.275, 0.07),
                (0.25, 0.06), (0.18, 0.055), (0.11, 0.05), (0.07, 0.045), (0.0, 0.045)]
        pr = [(p[0], p[1] * sign, p[2] if len(p) > 2 else 'rim') for p in prof]
        if sign < 0:
            pr = pr[::-1]
            pr = [(pr[i][0], pr[i][1], pr[i + 1][2] if i + 1 < len(pr) else 'rim') for i in range(len(pr))]
        return lathe(pr, segs, 'x', mat='rim', cap=False)
    w = disc(1)
    w.add(disc(-1))
    # lightening holes (dark recessed discs) on the outer disc
    for i in range(8):
        a = math.tau * i / 8
        w.add(cyl(0.032, 0.012, 10, 'x', c=(0.142, 0.19 * math.cos(a), 0.19 * math.sin(a)), mat='gunmetal'))
        w.add(lathe([(0.032, -0.006), (0.04, -0.004), (0.04, 0.004), (0.032, 0.006)], 10, 'x', mat='rim', cap=False,
                    c=(0.146, 0.19 * math.cos(a), 0.19 * math.sin(a))))
    bv = L.bvh_of(w)
    w.add(L.snap(lathe([(0, 0.0), (0.075, 0.0), (0.075, 0.028), (0.052, 0.046), (0.0, 0.05)], 16, 'x', mat='rim', c=(0.2, 0, 0)), None, bvh=bv))
    for i in range(6):
        a = math.tau * i / 6
        w.add(L.snap(bolt(0.01, 0.011, 6, 'rim').rot('Y', 90).move(0.21, 0.1 * math.cos(a), 0.1 * math.sin(a)), None, bvh=bv))
    return w

def idler_t80():
    w = B(mat='rim')
    r = IDL[2]
    for xo in (0.075, -0.075):
        s = 1 if xo > 0 else -1
        w.add(lathe([(0.0, xo + 0.04 * s), (0.1, xo + 0.03 * s), (0.2, xo + 0.012 * s), (r - 0.02, xo + 0.03 * s), (r, xo + 0.03 * s),
                     (r, xo - 0.03 * s), (r - 0.03, xo - 0.03 * s), (0.0, xo - 0.03 * s)], 30, 'x', mat='rim'))
    bv = L.bvh_of(w)
    for xo in (0.075, -0.075):
        s = 1 if xo > 0 else -1
        for i in range(6):
            a = math.tau * i / 6
            w.add(L.snap(cyl(0.04, 0.01, 10, 'x', c=(xo + 0.06 * s, 0.15 * math.cos(a), 0.15 * math.sin(a)), mat='gunmetal'), None, d=(-s, 0, 0), bvh=bv))
    w.add(L.snap(lathe([(0, 0.0), (0.065, 0.0), (0.065, 0.05), (0.04, 0.07), (0, 0.07)], 14, 'x', mat='rim', c=(0.13, 0, 0)), None, bvh=bv))
    return w

def sprocket_t80():
    s = t72.sprocket()
    s.scale(1.0, SPR[2] / 0.335, SPR[2] / 0.335)
    return s

def track_band(side):
    """t72's track band laid around the Msta-S running gear; U rescaled to the real link count (pitch ~0.14 m)."""
    saved = {k: getattr(t72, k) for k in ('TRK_X', 'TRK_W', 'RW_R', 'RW_Z', 'RW_Y', 'IDL', 'SPR', 'RR_Y', 'RR_Z', 'RR_R', 'BAND')}
    for k in saved:
        setattr(t72, k, globals()[k])
    try:
        b, pitch, Ltot = t72.track_band(side)
    finally:
        for k, v in saved.items():
            setattr(t72, k, v)
    links = int(round(Ltot / 0.14))
    f = links / 97.0
    uv = b.bm.loops.layers.uv.active
    for fc in b.bm.faces:
        for lp in fc.loops:
            lp[uv].uv.x *= f
    return b, Ltot / links, Ltot, links

# ================================================================================================ hull
def hull_body():
    pts = []
    for s in (1, -1):
        pts += [(s * LOW_X, -3.22, BELLY), (s * LOW_X, 3.0, BELLY), (s * LOW_X, NOSE[0], NOSE[1] - 0.05),
                (s * LOW_X, REAR_Y, 0.66), (s * LOW_X, REAR_Y + 0.06, FEN_Z), (s * LOW_X, NOSE[0] - 0.02, FEN_Z - 0.02)]
    H = hull(pts, bev=0.02, segs=2)
    up = []
    for s in (1, -1):
        up += [(s * SUP_X, NOSE[0], NOSE[1]), (s * SUP_X, NOSE[0] - 0.05, NOSE[1] - 0.1),
               (s * SUP_X, GL_TOP[0], GL_TOP[1]), (s * SUP_X, REAR_Y + 0.05, DECK - 0.02),
               (s * SUP_X, REAR_Y, FEN_Z), (s * SUP_X, 2.9, FEN_Z)]
    H.add(hull(up, bev=0.022, segs=2))
    # fenders with the T-80 style front mudguard
    for s in (1, -1):
        f = prism([(REAR_Y + 0.04, FEN_Z), (3.1, FEN_Z), (3.44, FEN_Z - 0.17), (3.48, FEN_Z - 0.23), (3.40, FEN_Z - 0.23),
                   (3.08, FEN_Z - 0.012), (REAR_Y + 0.04, FEN_Z - 0.012)], FEN_X - SUP_X + 0.02, 'x', c=s * (SUP_X + FEN_X) / 2)
        f.bevel(0.004, 1, 30)
        H.add(f)
        H.add(box(0.5, 0.012, 0.24, c=(s * TRK_X, 3.43, FEN_Z - 0.36), mat='skirt', bev=0.004, segs=1))   # front mud flap
        H.add(box(0.5, 0.012, 0.22, c=(s * TRK_X, REAR_Y + 0.02, FEN_Z - 0.14), mat='skirt', bev=0.004, segs=1))
    # weld seams
    for s in (1, -1):
        H.add(tube([(s * SUP_X, GL_TOP[0] - 0.01, DECK - 0.005), (s * SUP_X, REAR_Y + 0.07, DECK - 0.025)], 0.007, 5))
        H.add(tube([(s * SUP_X, NOSE[0] - 0.01, NOSE[1] + 0.005), (s * SUP_X, GL_TOP[0] - 0.01, GL_TOP[1])], 0.007, 5))
    H.add(tube([(-SUP_X, GL_TOP[0], DECK + 0.003), (SUP_X, GL_TOP[0], DECK + 0.003)], 0.008, 5))
    H.add(tube([(-SUP_X, NOSE[0] + 0.005, NOSE[1]), (SUP_X, NOSE[0] + 0.005, NOSE[1])], 0.009, 5))
    # ---- suspension: torsion arms, bump stops, dampers, final drives, idler cranks, return rollers
    for s in (1, -1):
        for i, y in enumerate(RW_Y):
            d = 1 if i < 3 else -1
            hub = V((s * (TRK_X - 0.22), y, RW_Z))
            piv = V((s * (LOW_X + 0.02), y + 0.32 * d, RW_Z + 0.15))
            H.add(tube([piv, hub], 0.048, 8, 'rim'))
            H.add(cyl(0.08, 0.07, 12, 'x', c=tuple(piv), mat='rim'))
            H.add(box(0.06, 0.12, 0.09, c=(s * (LOW_X + 0.03), y + 0.12 * d, RW_Z + 0.34)))
        for i in (0, 1, 5):
            y = RW_Y[i]
            H.add(tube([(s * (LOW_X + 0.1), y + (0.28 if i < 3 else -0.28), RW_Z + 0.40), (s * (LOW_X + 0.12), y, RW_Z + 0.1)], 0.034, 8, 'gunmetal'))
        H.add(cyl(0.19, 0.18, 20, 'x', c=(s * (LOW_X + 0.07), SPR[0], SPR[1]), bev=0.015))
        H.add(cyl(0.11, 0.2, 16, 'x', c=(s * (LOW_X + 0.08), IDL[0] - 0.05, IDL[1] + 0.02), bev=0.01))
        H.add(box(0.07, 0.34, 0.1, c=(s * (LOW_X + 0.08), IDL[0] - 0.22, IDL[1] + 0.05), bev=0.01, segs=1).rot('X', -20, (0, IDL[0] - 0.22, IDL[1] + 0.05)))
        for y in RR_Y:
            H.add(cyl(0.045, 0.15, 10, 'x', c=(s * (LOW_X + 0.08), y, RR_Z)))
            H.add(lathe([(0.0, -0.1), (RR_R - 0.01, -0.1, 'tyre'), (RR_R, -0.085, 'tyre'), (RR_R, 0.085, 'tyre'), (RR_R - 0.01, 0.1), (0.045, 0.11), (0.0, 0.12)],
                        16, 'x', mat='rim', c=(s * TRK_X, y, RR_Z)))
    return H

def side_skirts():
    """2S19M2 steel side skirts hanging from the fender edge, round lightening holes along the bottom."""
    S = B()
    ys = np.linspace(REAR_Y + 0.12, 3.02, 6)
    z0, z1 = FEN_Z + 0.005, 0.64
    for s in (1, -1):
        x = s * (FEN_X + 0.006)
        for i in range(len(ys) - 1):
            ya, yb = ys[i] + 0.008, ys[i + 1] - 0.008
            S.add(box(0.012, yb - ya, z0 - z1, c=(x, (ya + yb) / 2, (z0 + z1) / 2), bev=0.004, segs=1))
            S.add(box(0.016, yb - ya, 0.035, c=(x + s * 0.006, (ya + yb) / 2, z1 + 0.02)))        # stiffening lip
            for yy in np.linspace(ya + 0.3, yb - 0.3, 2):
                S.add(cyl(0.075, 0.016, 14, 'x', c=(x + s * 0.002, yy, z1 + 0.14), mat='gunmetal'))   # hole (dark)
            for yy in np.linspace(ya + 0.06, yb - 0.06, 5):
                S.add(bolt(0.011, 0.007, 6).rot('Y', 90 * s), Matrix.Translation((x + s * 0.006, yy, z0 - 0.03)))
        # front skirt piece angled in front of the idler
        S.add(box(0.012, 0.35, 0.3, c=(x, 3.18, FEN_Z - 0.17), bev=0.004, segs=1).rot('X', -25, (x, 3.18, FEN_Z - 0.17)))
    return S

def hull_details(H):
    # driver's hatch + 3 periscopes, splash board, headlights, dozer blade, tow hooks
    H.add(L.round_coaming(0.29, hinge=(1, 0)).move(0, 1.98, DECK))          # lid: hatch_lid_driver (swings right)
    H.add(rail([(-0.1, 1.85, DECK + 0.05), (-0.1, 1.85, DECK + 0.1), (0.1, 1.85, DECK + 0.1), (0.1, 1.85, DECK + 0.05)], r=0.01, rad=0.025))
    for a in (-25, 0, 25):
        H.add(periscope_block(0.16, 0.09, 0.07), Matrix.Translation((math.sin(math.radians(a)) * 0.3, 2.26 + 0.0 * a, DECK - 0.02)) @ Matrix.Rotation(math.radians(-a), 4, 'Z'))
    Mg = L.frame_from_normal(glacis_n(), V((0, 0, 1)))
    for s in (1, -1):
        H.add(box(0.75, 0.03, 0.13, bev=0.006, segs=1).rot('Z', s * 22).move(s * 0.22, 0, 0.06), L.place(Mg, glacis_pt(0, 0.66)))
    # glacis lifting eyes + armour plate seams + track tension access caps
    for s in (1, -1):
        H.add(lathe([(0.03, -0.014), (0.055, -0.014), (0.055, 0.014), (0.03, 0.014)], 12, 'x', cap=False), L.place(Mg, glacis_pt(s * 0.95, 0.4, 0.04)))
        H.add(cyl(0.07, 0.03, 14, 'z', c=(0, 0, 0.015)), L.place(Mg, glacis_pt(s * 0.62, 0.2)))
    # headlight clusters on the fender fronts
    for s in (1, -1):
        H.add(headlight_cluster(s), Matrix.Translation((s * 1.5, 3.05, FEN_Z - 0.01)))
    # self-entrenching dozer blade folded on the lower front plate
    lg_n = V((0, 0.85, -0.53)).normalized()
    pz = (NOSE[1] + BELLY) / 2 + 0.03
    py = (NOSE[0] + 3.0) / 2 + 0.06
    db = prism([(-1.05, -0.24), (1.05, -0.24), (1.1, 0.24), (-1.1, 0.24)], 0.03, 'z', c=0.015, bev=0.008, segs=1)
    for x in (-0.75, -0.25, 0.25, 0.75):
        db.add(box(0.04, 0.44, 0.06, c=(x, 0, 0.045), bev=0.006, segs=1))
    db.add(box(2.1, 0.05, 0.06, c=(0, 0.19, 0.045), bev=0.006, segs=1))
    H.add(db, L.place(L.frame_from_normal(lg_n, V((0, 0, 1))), V((0, py, pz)) + lg_n * 0.02))
    for s in (1, -1):
        H.add(tow_hook().rot('X', -10), Matrix.Translation((s * 0.78, NOSE[0] + 0.02, NOSE[1] - 0.13)))
    # turret ring guard on the deck front
    H.add(lathe([(1.2, 0), (1.25, 0), (1.25, 0.03), (1.18, 0.05)], 48, 'z', c=(0, TUR_Y, DECK)))
    # deck strips visible between the turret and the fender edge: grab rails, filler caps, fender stowage boxes
    for s in (1, -1):
        for y in (0.9, -0.6, -2.1):
            H.add(cyl(0.05, 0.03, 12, 'z', c=(s * 1.42, y, FEN_Z + 0.015)))
        H.add(box(0.26, 0.6, 0.16, c=(s * 1.53, 1.75, FEN_Z + 0.08), bev=0.012, segs=1))       # front fender box
        H.add(box(0.28, 0.62, 0.02, c=(s * 1.53, 1.75, FEN_Z + 0.165)))
    # engine deck strip behind the turret: cooling louvres + access hatch hinges
    H.add(louvre_panel(1.7, 0.32, 5), Matrix.Translation((-0.15, -3.2, DECK - 0.01)))
    H.add(hatch_rect(0.5, 0.3, t=0.02, c=(1.0, -3.2, DECK - 0.01), hinge='y+', rad=0.03))
    # V-84 exhaust louvre on the left fender (rear)
    ex = box(0.36, 0.55, 0.2, c=(-1.5, -2.55, FEN_Z + 0.1), bev=0.012, segs=1)
    for i in range(5):
        ex.add(box(0.012, 0.5, 0.02, c=(-1.5 - 0.185, -2.55, FEN_Z + 0.04 + i * 0.033), mat='gunmetal'))
    H.add(ex)
    # tow cable along the right fender edge
    H.add(tow_cable((SUP_X + 0.1, 1.2, FEN_Z + 0.03), (SUP_X + 0.1, -2.6, FEN_Z + 0.03), 0.0))
    # ---- rear plate: shelf/curved plate, round access cover, tow hooks, lights, spare track links, drums brackets
    H.add(prism([(-0.02, 0.0), (0.0, 0.0), (0.0, 0.22), (-0.12, 0.3), (-0.3, 0.32), (-0.3, 0.30), (-0.13, 0.28), (-0.02, 0.21)],
                2.1, 'x', c=0.0).move(0, REAR_Y - 0.04, DECK - 0.36))
    H.add(lathe([(0, 0.03), (0.2, 0.025), (0.22, 0.0)], 24, 'y', c=(0, REAR_Y - 0.02, 0.86)).rot('X', 0))
    for i in range(8):
        a = math.tau * i / 8
        H.add(bolt(0.011, 0.008).rot('X', -90), Matrix.Translation((0.17 * math.cos(a), REAR_Y - 0.03, 0.86 + 0.17 * math.sin(a))))
    for s in (1, -1):
        H.add(tow_hook().rot('Z', 180), Matrix.Translation((s * 0.82, REAR_Y - 0.02, 0.72)))
        rl = box(0.14, 0.05, 0.08, c=(s * 1.1, REAR_Y - 0.03, DECK - 0.14), bev=0.008, segs=1)
        rl.add(box(0.1, 0.01, 0.05, c=(s * 1.1, REAR_Y - 0.06, DECK - 0.14), mat='light'))
        H.add(rl)
        for i in range(2):
            H.add(box(0.48, 0.05, 0.14, c=(s * 0.55, REAR_Y - 0.04, 0.98 + i * 0.16), mat='gunmetal', bev=0.01, segs=1))
    return H

# ================================================================================================ turret
def turret_body():
    """Welded box turret (world coords).  Faces: narrow front centre (gun slot), big front cheeks, slab sides,
    chamfered rear corners, flat rear wall; slight tumblehome."""
    T_ = hull(ring(TB, TZ) + ring(TS, SHOULDER) + ring(TT, ROOF))
    # gun recess between the forward-projecting cheeks + elevation slot through the roof front
    cut = box(2 * NOTCH[0], 1.4, ROOF - TZ, c=(0, NOTCH[1] + 0.7, (TZ + 0.14 + ROOF + 0.2) / 2))
    cut.add(box(0.7, 0.5, 0.6, c=(0, NOTCH[1] - 0.2, ROOF + 0.05)))
    me_cut = cut.to_mesh('_cut')
    ob_cut = L.link(bpy.data.objects.new('_cut', me_cut))
    n0 = len(T_.bm.faces)
    T_.mods([('BOOLEAN', dict(operation='DIFFERENCE', object=ob_cut, solver='EXACT', use_self=True))])
    bpy.data.objects.remove(ob_cut)
    assert len(T_.bm.faces) >= n0, 'turret boolean failed'
    T_.bevel(0.025, 2, 20)
    # dark gun slot in the recess back face, guides, roof-slot cover (canvas)
    T_.add(box(0.62, 0.04, 0.95, c=(0, NOTCH[1] + 0.005, TZ + 0.75), mat='gunmetal'))
    for s in (1, -1):
        T_.add(box(0.06, 0.1, 1.2, c=(s * 0.38, NOTCH[1] + 0.04, TZ + 0.75), bev=0.01, segs=1))
    T_.add(box(0.66, 0.46, 0.03, c=(0, NOTCH[1] - 0.2, ROOF - 0.12), mat='canvas'))
    # weld seams along the corners (base -> shoulder -> roof)
    for k in range(1, len(TB)):
        for s in (1, -1):
            pts = [V((s * TB[k][0], TB[k][1], TZ + 0.02)), V((s * TS[k][0], TS[k][1], SHOULDER)), V((s * TT[k][0], TT[k][1], ROOF - 0.02))]
            T_.add(tube(pts, 0.008, 5))
    # shoulder seam all round
    sh = [V((x, y, SHOULDER)) for x, y in reversed(TS)] + [V((-x, y, SHOULDER)) for x, y in TS]
    T_.add(tube(sh[1:-1], 0.008, 5))
    return T_

def cheek_frame(s):
    """Frame on the front cheek plate of side s: local z = outward normal, y = up-the-plate, x along the plate."""
    p0b, p1b = V((s * TB[0][0], TB[0][1], TZ)), V((s * TB[1][0], TB[1][1], TZ))
    p0t, p1t = V((s * TS[0][0], TS[0][1], SHOULDER)), V((s * TS[1][0], TS[1][1], SHOULDER))
    u = (p1b - p0b).normalized()
    up = ((p0t + p1t) / 2 - (p0b + p1b) / 2).normalized()
    n = u.cross(up).normalized()
    if n.y < 0:
        n = -n
    x = up.cross(n).normalized()
    M = Matrix((x, up, n)).transposed().to_4x4()
    centre = (p0b + p1b) / 2
    return M, centre, (p1b - p0b).length, ((p0t + p1t) / 2 - centre).length

def turret_details(T_):
    # ---- front cheeks: 2 x 6 902V smoke tubes (two rows of three) + perforated armoured covers
    for s in (1, -1):
        M, c, wlen, hlen = cheek_frame(s)
        for r in range(2):
            for k in range(3):
                lx = (k - 1) * 0.22 * s
                p = c + M.to_3x3() @ V((lx, hlen * (0.78 - r * 0.15), 0.06))
                d = M.to_3x3() @ V((s * 0.15 * (k - 1), 0.85, 0.55))
                T_.add(smoke_tube(), Matrix.Translation(p) @ align_y(d))
            T_.add(box(0.75, 0.05, 0.08, bev=0.008, segs=1), L.place(M, c + M.to_3x3() @ V((0, hlen * (0.74 - r * 0.15), 0.03))))
        for r in range(2):
            T_.add(perforated_box(0.58, 0.16, 0.08, 8, 2), L.place(M, c + M.to_3x3() @ V((0.0, hlen * (0.38 - r * 0.16), 0.0))))
        # lifting eye
        T_.add(lathe([(0.03, -0.012), (0.05, -0.012), (0.05, 0.012), (0.03, 0.012)], 12, 'x', cap=False), L.place(M, c + M.to_3x3() @ V((s * 0.3, hlen * 0.96, 0.03))))
    # ---- gunner's 1P22 panoramic sight + 1P23 direct-fire sight head (front left)
    sx, sy = -0.9, 0.45
    T_.add(box(0.36, 0.38, 0.14, c=(sx, sy, ROOF + 0.07), bev=0.02, segs=2))
    T_.add(lathe([(0, 0), (0.12, 0), (0.12, 0.12), (0.1, 0.16), (0, 0.16)], 16, 'z', c=(sx, sy, ROOF + 0.13)))
    T_.add(box(0.2, 0.16, 0.16, c=(sx, sy + 0.02, ROOF + 0.36), bev=0.015, segs=2))
    T_.add(box(0.14, 0.012, 0.07, c=(sx, sy + 0.105, ROOF + 0.37), mat='glass'))
    T_.add(box(0.24, 0.12, 0.012, c=(sx, sy + 0.06, ROOF + 0.45)))
    T_.add(box(0.22, 0.3, 0.24, c=(-0.5, 0.92, ROOF + 0.02), bev=0.02, segs=2))     # 1P23 head on the roof front
    T_.add(box(0.15, 0.012, 0.08, c=(-0.5, 1.075, ROOF + 0.06), mat='glass'))
    # gunner hatch + periscopes
    T_.add(L.round_coaming(0.31).move(-0.8, -0.32, ROOF))                     # lid: hatch_lid_gunner (front hinge)
    T_.add(periscope_block(0.15, 0.09, 0.06), Matrix.Translation((-1.08, -0.3, ROOF - 0.01)) @ Matrix.Rotation(math.pi / 2, 4, 'Z'))
    # ---- commander's cupola (right) with the remote 12.7 mm mount
    cx, cy = 0.8, -0.25
    cu = lathe([(0, 0.0), (0.44, 0.0), (0.44, 0.07), (0.4, 0.15), (0.36, 0.17), (0.0, 0.17)], 32, 'z', c=(cx, cy, ROOF))
    cu.add(L.round_coaming(CMD_LID[2], hinge=(-1, 0)).move(CMD_LID[0], CMD_LID[1], ROOF + 0.17))   # lid: hatch_lid_commander (left hinge, clear of the MG mount)
    for ang in (30, 70, 110, 150, 200):
        a = math.radians(ang)
        cu.add(periscope_block(0.13, 0.08, 0.06), Matrix.Translation((cx + 0.38 * math.cos(a), cy + 0.38 * math.sin(a), ROOF + 0.1)) @ Matrix.Rotation(a - math.pi / 2, 4, 'Z'))
    cu.add(box(0.24, 0.2, 0.18, c=(cx, cy + 0.3, ROOF + 0.26), bev=0.02, segs=2))        # commander's day/night sight
    cu.add(box(0.16, 0.012, 0.07, c=(cx, cy + 0.405, ROOF + 0.28), mat='glass'))
    # remote MG mount: pedestal, cradle with the Kord, ammo box, sight
    mx, my, mz = cx + 0.12, cy - 0.12, ROOF + 0.32
    cu.add(cyl(0.07, 0.16, 12, 'z', c=(mx, my, ROOF + 0.24)))
    cu.add(box(0.2, 0.36, 0.14, c=(mx, my + 0.02, mz + 0.06), bev=0.015, segs=2))
    cu.add(box(0.1, 0.62, 0.12, c=(mx - 0.13, my + 0.1, mz + 0.12), mat='gunmetal', bev=0.01, segs=1))
    cu.add(cyl(0.021, 0.95, 8, 'y', c=(mx - 0.13, my + 0.85, mz + 0.14), mat='gunmetal'))
    cu.add(lathe([(0, 0), (0.032, 0), (0.03, 0.1), (0.0, 0.1)], 8, 'y', mat='gunmetal', c=(mx - 0.13, my + 1.3, mz + 0.14)))
    cu.add(box(0.14, 0.24, 0.17, c=(mx + 0.07, my + 0.02, mz + 0.16), bev=0.01, segs=1))   # ammo box
    cu.add(cyl(0.05, 0.1, 12, 'y', c=(mx + 0.07, my + 0.2, mz + 0.27), mat='rolled'))       # MG sight
    cu.add(cyl(0.04, 0.01, 12, 'y', c=(mx + 0.07, my + 0.255, mz + 0.27), mat='glass'))
    T_.add(cu)
    # ---- loaders' roof hatch, ventilators, antennas, GLONASS mushroom, wind sensor
    T_.add(L.rect_coaming(0.55, 0.6, rad=0.04).move(0.55, -1.45, ROOF))     # lids: hatch_lid_loader_roof_R / _L
    T_.add(L.rect_coaming(0.55, 0.6, rad=0.04).move(-0.55, -1.6, ROOF))
    for (x, y) in ((0.0, -0.8), (-0.25, -2.35)):
        T_.add(lathe([(0, 0.09), (0.1, 0.085), (0.14, 0.05), (0.14, 0.0)], 16, 'z', c=(x, y, ROOF)))
    for s in (1, -1):
        T_.add(antenna_base(), Matrix.Translation((s * 1.0, REAR_T + 0.5, ROOF)))
    T_.add(lathe([(0, 0), (0.05, 0), (0.05, 0.12), (0.14, 0.13), (0.15, 0.16), (0.1, 0.19), (0, 0.2)], 16, 'z', c=(-0.95, -2.0, ROOF)))
    T_.add(cyl(0.012, 0.42, 6, 'z', c=(0.3, -2.5, ROOF + 0.21), mat='gunmetal'))
    T_.add(cyl(0.035, 0.06, 8, 'z', c=(0.3, -2.5, ROOF + 0.44)))
    for x in np.linspace(-1.1, 1.1, 7):
        for y in (0.25, REAR_T + 0.2):
            T_.add(bolt(0.012, 0.009), Matrix.Translation((x * (0.9 if y > 0 else 0.8), y, ROOF)))
    # roof edge grab rails
    for s in (1, -1):
        T_.add(rail([(s * 1.15, -0.6, ROOF), (s * 1.15, -0.6, ROOF + 0.06), (s * 1.15, -1.3, ROOF + 0.06), (s * 1.15, -1.3, ROOF)], r=0.011, rad=0.03))
    # ---- sides: ledge, right-side crew door, stowage boxes, placard, rails
    for s in (1, -1):
        xs = side_x(SHOULDER - 0.04)
        T_.add(box(0.05, 2.9, 0.04, c=(s * (xs + 0.02), -0.9, SHOULDER - 0.04), bev=0.008, segs=1))
        for y in (0.2, -1.2, -2.3):
            T_.add(lathe([(0.03, -0.012), (0.05, -0.012), (0.05, 0.012), (0.03, 0.012)], 12, 'y', cap=False), Matrix.Translation((s * (side_x(SHOULDER + 0.1) + 0.03), y, SHOULDER + 0.1)))
    # right side crew door (vertical, hinged at the front)
    dz, dy = TZ + 0.52, -1.45
    xr = side_x(dz) + 0.005
    dr = box(0.035, 0.72, 0.8, c=(xr + 0.017, dy, dz), bev=0.01, segs=1)
    dr.add(box(0.012, 0.8, 0.88, c=(xr + 0.002, dy, dz), mat='gunmetal'))
    for zz in (dz - 0.25, dz + 0.25):
        dr.add(cyl(0.025, 0.12, 10, 'z', c=(xr + 0.035, dy + 0.38, zz)))
        dr.add(box(0.012, 0.14, 0.08, c=(xr + 0.04, dy + 0.31, zz)))
    dr.add(rail([(xr + 0.035, dy - 0.25, dz - 0.1), (xr + 0.09, dy - 0.25, dz - 0.1), (xr + 0.09, dy - 0.25, dz + 0.12), (xr + 0.035, dy - 0.25, dz + 0.12)], r=0.01, rad=0.025))
    dr.add(box(0.03, 0.14, 0.1, c=(xr + 0.05, dy - 0.1, dz + 0.25), bev=0.006, segs=1))
    T_.add(dr)
    # right side: panels/rectangular covers ahead of the door, left side: big stowage boxes + tools
    T_.add(box(0.03, 0.55, 0.42, c=(xr + 0.012, -0.45, TZ + 0.85), bev=0.008, segs=1))
    T_.add(box(0.03, 0.45, 0.35, c=(xr + 0.012, -2.15, TZ + 0.55), bev=0.008, segs=1))
    xl = -side_x(TZ + 0.4)
    for (y, ln, h) in ((-0.45, 1.0, 0.5), (-1.7, 1.1, 0.5)):
        bx = box(0.22, ln, h, c=(xl - 0.11, y, TZ + 0.38), bev=0.012, segs=2)
        bx.add(box(0.24, ln + 0.02, 0.025, c=(xl - 0.115, y, TZ + 0.38 + h / 2)))
        for yy in (y - ln / 2 + 0.15, y + ln / 2 - 0.15):
            bx.add(box(0.03, 0.05, 0.06, c=(xl - 0.225, yy, TZ + 0.38 + h / 2 - 0.05)))
        T_.add(bx)
    T_.add(tube([(xl - 0.04, 0.2, TZ + 0.69), (xl - 0.04, -2.3, TZ + 0.69)], 0.015, 6, 'bare'))   # crowbar
    sh = box(1.0, 0.035, 0.035, mat='wood', bev=0.01, segs=1).rot('Z', 90)
    T_.add(sh, Matrix.Translation((xl - 0.05, -1.6, TZ + 0.71)))
    # ---- rear wall: two-leaf ammunition hatch + folded projectile conveyor, lights, rails
    ry = REAR_T + 0.02
    T_.add(box(0.9, 0.04, 0.82, c=(0.25, ry - 0.02, TZ + 0.52), bev=0.01, segs=1))
    T_.add(box(0.012, 0.045, 0.8, c=(0.25, ry - 0.045, TZ + 0.52), mat='gunmetal'))
    for xx in (-0.17, 0.67):
        for zz in (TZ + 0.25, TZ + 0.8):
            T_.add(cyl(0.025, 0.12, 10, 'z', c=(xx, ry - 0.05, zz)))
    for xx in (0.1, 0.4):
        T_.add(rail([(xx, ry - 0.04, TZ + 0.45), (xx, ry - 0.1, TZ + 0.45), (xx, ry - 0.1, TZ + 0.65), (xx, ry - 0.04, TZ + 0.65)], r=0.01, rad=0.02))
    # conveyor (folded upright on the rear wall, left of the hatch): two side rails + rollers + motor box
    cxo = -0.62
    for s in (1, -1):
        T_.add(box(0.05, 0.08, 1.6, c=(cxo + s * 0.17, ry - 0.2, TZ + 0.9), bev=0.008, segs=1))
    for k in range(9):
        T_.add(cyl(0.03, 0.32, 8, 'x', c=(cxo, ry - 0.2, TZ + 0.2 + k * 0.17), mat='bare'))
    T_.add(box(0.42, 0.22, 0.22, c=(cxo, ry - 0.14, TZ + 0.12), bev=0.015, segs=1))
    T_.add(box(0.12, 0.2, 0.14, c=(cxo, ry - 0.12, TZ + 1.72), bev=0.01, segs=1))
    for zz in (TZ + 0.4, TZ + 1.3):
        T_.add(box(0.5, 0.18, 0.05, c=(cxo, ry - 0.09, zz)))
    for s in (1, -1):
        rl = box(0.12, 0.05, 0.08, c=(s * 0.85, ry - 0.03, TZ + 0.9), bev=0.008, segs=1)
        rl.add(box(0.09, 0.01, 0.05, c=(s * 0.85, ry - 0.06, TZ + 0.9), mat='light'))
        T_.add(rl)
    T_.add(box(2.1, 0.05, 0.04, c=(0, ry - 0.03, SHOULDER - 0.04), bev=0.008, segs=1))      # rear shoulder lip
    return T_

def cope_cage(TU=None):
    """2023-24 anti-drone 'mangal' over the turret: square-tube posts, frame, slats + side bars.
    Post feet are dropped onto the real turret surface (vehicles_v5: the cage floated 27 cm over the sloped roof edges)."""
    C = B(mat='cage')
    top = ROOF + 0.85
    bv = L.bvh_of(TU) if TU is not None else None
    posts = [(-1.18, 0.5), (1.18, 0.5), (-1.2, -1.1), (1.2, -1.1), (-0.8, -2.55), (0.8, -2.55)]
    for (x, y) in posts:
        zf = ROOF
        if bv is not None:
            loc, nrm, idx, dist = bv.ray_cast(V((x, y, top)), V((0, 0, -1)), 3.0)
            if loc is not None:
                zf = loc.z
        C.add(tube([(x, y, zf - 0.01), (x * 1.04, y, top)], 0.022, 4, 'cage'))
        C.add(box(0.12, 0.12, 0.012, c=(x, y, zf + 0.004), mat='cage'))
    fr = [(-1.5, 1.7), (1.5, 1.7), (1.56, -3.15), (-1.56, -3.15)]
    for i in range(4):
        a, b_ = fr[i], fr[(i + 1) % 4]
        C.add(tube([(a[0], a[1], top), (b_[0], b_[1], top)], 0.02, 4, 'cage'))
    for y in np.arange(-3.0, 1.65, 0.31):
        C.add(box(3.08, 0.012, 0.05, c=(0, y, top + 0.03), mat='cage'))
    for x in (-0.75, 0.0, 0.75):
        C.add(box(0.03, 4.85, 0.03, c=(x, -0.72, top + 0.005), mat='cage'))
    for x in np.arange(-1.4, 1.45, 0.28):        # front drop over the mantlet area
        C.add(tube([(x, 1.7, top), (x, 2.0, top - 0.3)], 0.01, 4, 'cage'))
    C.add(tube([(-1.45, 2.0, top - 0.3), (1.45, 2.0, top - 0.3)], 0.014, 4, 'cage'))
    for s in (1, -1):
        for y in np.arange(-3.05, 1.65, 0.3):
            C.add(tube([(s * 1.55, y, top), (s * 1.55, y, top - 0.4)], 0.008, 4, 'cage'))
        C.add(tube([(s * 1.55, -3.1, top - 0.4), (s * 1.55, 1.65, top - 0.4)], 0.012, 4, 'cage'))
    return C

def gun_2a64():
    """2A64 152 mm L/47.  Local origin = trunnion, barrel along +Y.  Cradle with coaxial mantlet drum, gun shield,
    two recoil/recuperator cylinders above the barrel, bore evacuator, two-chamber muzzle brake."""
    G = B()
    G.add(cyl(0.48, 0.84, 36, 'x', c=(0, 0, 0)))                                    # mantlet drum (coaxial with trunnions)
    G.add(box(0.8, 0.14, 0.7, c=(0, 0.52, 0.02), bev=0.03, segs=2))                # gun shield
    for s in (1, -1):
        G.add(bolt(0.016, 0.012).rot('X', -90), Matrix.Translation((s * 0.32, 0.59, 0.27)))
        G.add(bolt(0.016, 0.012).rot('X', -90), Matrix.Translation((s * 0.32, 0.59, -0.24)))
    # cradle sleeve + recuperators
    G.add(lathe([(0.0, 0.58), (0.24, 0.58), (0.24, 0.8), (0.215, 0.84), (0.215, 2.25), (0.235, 2.28), (0.235, 2.36), (0.0, 2.36)], 24, 'y'))
    for s in (1, -1):
        G.add(lathe([(0.0, 0.58), (0.095, 0.58), (0.095, 2.4), (0.085, 2.46), (0.05, 2.5), (0.0, 2.5)], 16, 'y', c=(s * 0.15, 0, 0.27)))
        for y in (1.1, 1.9):
            G.add(box(0.12, 0.06, 0.14, c=(s * 0.13, y, 0.17), bev=0.01, segs=1))
    G.add(box(0.3, 1.5, 0.05, c=(0, 1.55, 0.2), bev=0.01, segs=1))
    # barrel tube, bore evacuator, collar, muzzle brake
    prof = [(0.0, 2.36), (0.158, 2.36), (0.155, 3.5), (0.17, 3.56), (0.205, 3.66), (0.205, 4.48), (0.18, 4.58), (0.146, 4.64),
            (0.14, 5.6), (0.13, 6.62), (0.15, 6.64), (0.15, 6.72), (0.128, 6.74), (0.128, 6.84), (0.0, 6.84)]
    G.add(lathe(prof, 28, 'y'))
    for i in range(8):            # evacuator ball-valve plugs ring
        a = math.tau * i / 8
        G.add(cyl(0.018, 0.012, 8, 'y', c=(0.19 * math.cos(a), 3.69, 0.19 * math.sin(a))))
    mb = B()
    def ringr(y0, y1, r=0.2):
        return lathe([(0.075, y0), (r - 0.012, y0), (r, y0 + 0.012), (r, y1 - 0.012), (r - 0.012, y1), (0.075, y1), (0.075, y0)], 28, 'y', cap=False)
    mb.add(lathe([(0.0, 6.84), (0.16, 6.84), (0.2, 6.9), (0.2, 7.0), (0.075, 7.0), (0.0, 7.0)], 28, 'y'))
    mb.add(ringr(7.18, 7.3))
    mb.add(ringr(7.43, MUZ_L))
    for s in (1, -1):              # top / bottom straps between the baffles (side ports open)
        mb.add(box(0.2, MUZ_L - 7.0, 0.07, c=(0, (7.0 + MUZ_L) / 2, s * 0.17), bev=0.012, segs=1))
    mb.add(lathe([(0.075, 6.99), (0.075, MUZ_L)], 20, 'y', mat='gunmetal', cap=False))      # bore liner (dark)
    mb.add(lathe([(0.0, 6.99), (0.075, 6.99)], 20, 'y', mat='gunmetal', cap=False))
    G.add(mb)
    return G

# ================================================================================================ travel lock
def travel_lock():
    """A-frame travel lock on the glacis (raised = travel).  Returns (part in world coords, hinge point, fold deg)."""
    gn = glacis_n()
    feet_t = 0.32
    apex = V((0, 2.82, 2.20))       # saddle top meets the cradle sleeve with the gun at -3.5 deg
    TL = B()
    for s in (1, -1):
        f = glacis_pt(s * 0.55, feet_t, 0.04)
        TL.add(tube([f, apex + V((s * 0.09, 0, -0.05))], 0.035, 8))
        TL.add(cyl(0.05, 0.16, 12, 'x', c=tuple(f)))
        TL.add(box(0.2, 0.14, 0.03, c=(0, 0, 0.015)), L.place(L.frame_from_normal(gn), glacis_pt(s * 0.55, feet_t, 0.0)))
    mid = [glacis_pt(s * 0.55, feet_t, 0.04).lerp(apex, 0.45) for s in (1, -1)]
    TL.add(tube(mid, 0.025, 8))
    # cradle at the apex: U clamp
    TL.add(box(0.46, 0.14, 0.06, c=tuple(apex + V((0, 0, -0.06))), bev=0.01, segs=1))
    for s in (1, -1):
        TL.add(box(0.05, 0.14, 0.2, c=tuple(apex + V((s * 0.25, 0, 0.04))), bev=0.008, segs=1))
    hinge = glacis_pt(0, feet_t, 0.04)
    return TL, hinge

# ================================================================================================ build
def msta_lids(hullE, turE):
    """Openable crew lids (all coords world/authoring like the rest of this script)."""
    lids = []
    p, piv, ax = L.round_lid(CMD_LID[2], 0.045, hinge=(-1, 0))
    lids.append(VB.hatch_lid('commander', p, piv, ax, turE, Matrix.Translation((CMD_LID[0], CMD_LID[1], ROOF + 0.17)), open_deg=100,
                             note='cupola lid hinged on its left edge (the remote 12.7 mm mount sits on the right of the cupola)'))
    p, piv, ax = L.round_lid(0.31, 0.05, hinge=(0, 1))
    lids.append(VB.hatch_lid('gunner', p, piv, ax, turE, Matrix.Translation((-0.8, -0.32, ROOF)), open_deg=95))
    for tag, (x, y) in (('R', (0.55, -1.45)), ('L', (-0.55, -1.6))):
        p, piv, ax = L.rect_lid(0.55, 0.6, t=0.03, hinge='y-', rad=0.04)
        lids.append(VB.hatch_lid('loader_roof_' + tag, p, piv, ax, turE, Matrix.Translation((x, y, ROOF)), open_deg=100,
                                 role_tag='loader'))
    p, piv, ax = L.round_lid(0.29, 0.05, hinge=(1, 0))
    piv = V((0.29 + 0.014, 0.0, 0.0))
    lids.append(VB.hatch_lid('driver', p, piv, (0, 0, 1), hullE, Matrix.Translation((0, 1.98, DECK)), open_deg=180, sign=-1,
                             note='swing hatch: pivots about a vertical axis on its right edge and ends up lying on the deck to the right of the opening'))
    return lids

def build():
    t0 = time.time()
    L.reset()
    root = L.node_empty('root')
    hullE = L.node_empty('hull', root, (0, 0, 0))
    H = hull_body()
    hull_details(H)
    H.add(side_skirts())
    print('  hull tris', H.tris(), '%.1fs' % (time.time() - t0))
    hull_mesh = L.node_mesh('hull_geo', H, hullE, (0, 0, 0))
    # ---- travel lock (separate node so the game can fold it)
    TL, hinge = travel_lock()
    tlE = L.node_empty('travel_lock', hullE, tuple(hinge))
    tl_mesh = L.node_mesh('travel_lock_geo', TL, tlE, tuple(hinge))
    # ---- turret
    tz = TZ
    TU = turret_body()
    turret_details(TU)
    turE = L.node_empty('turret', hullE, (0, TUR_Y, tz))
    CG = cope_cage(TU)   # before node_mesh: it frees TU's bmesh, and the cage posts are snapped onto the turret
    tur_mesh = L.node_mesh('turret_geo', TU, turE, (0, TUR_Y, tz))
    cage_mesh = L.node_mesh('cope_cage', CG, turE, (0, TUR_Y, tz))
    gunE = L.node_empty('gun_pivot', turE, TRUN)
    G = gun_2a64()
    G.move(*TRUN)
    gun_mesh = L.node_mesh('gun_geo', G, gunE, TRUN)
    L.node_empty('muzzle', gunE, (TRUN[0], TRUN[1] + MUZ_L, TRUN[2]), 0.1)
    L.node_empty('smoke_launchers', turE, (0, 1.15, tz + 1.15))
    L.node_empty('commander_hatch', turE, (0.87, -0.3, ROOF + 0.2))
    L.node_empty('hatch_commander', turE, (0.87, -0.3, ROOF + 0.2))
    L.node_empty('hatch_gunner', turE, (-0.8, -0.32, ROOF + 0.05))
    L.node_empty('hatch_loader_roof_R', turE, (0.55, -1.45, ROOF + 0.05))
    L.node_empty('hatch_loader_roof_L', turE, (-0.55, -1.6, ROOF + 0.05))
    L.node_empty('hatch_loader', turE, (0.55, -1.45, ROOF + 0.05))        # crew role 'loader' -> right loader roof hatch (game looks up hatch_<role>)
    L.node_empty('hatch_side_R', turE, (side_x(tz + 0.52) + 0.04, -1.45, tz + 0.52))
    L.node_empty('hatch_ammo_rear', turE, (0.25, REAR_T - 0.04, tz + 0.68))
    L.node_empty('ammo_feed', turE, (-0.62, REAR_T - 0.3, tz + 0.2))
    L.node_empty('mg_muzzle', turE, (0.92 + 0.12 - 0.13, -0.25 - 0.12 + 1.4, ROOF + 0.32 + 0.14), 0.08)
    # ---- running gear
    parts = {'road': road_wheel_t80(), 'spr': sprocket_t80(), 'idl': idler_t80()}
    meshes = {}
    rg_objs = []
    def wheel(name, key, side, c):
        e = L.node_empty(name, hullE, c)
        mk = key + ('R' if side > 0 else 'L')
        if mk not in meshes:
            p = L._bcopy(parts[key])
            if side < 0:
                p.scale(-1, 1, 1)
            p.move(*c)
            o = L.node_mesh(name + '_geo', p, e, c)
            o.data.name = mk
            meshes[mk] = o.data
        else:
            o = L.node_mesh(name + '_geo', None, e, c, mesh=meshes[mk])
        rg_objs.append(o)
    for side, tag in ((1, 'R'), (-1, 'L')):
        for i, y in enumerate(RW_Y):
            wheel(f'roadwheel_{tag}{i + 1}', 'road', side, (side * TRK_X, y, RW_Z))
        wheel(f'sprocket_{tag}', 'spr', side, (side * TRK_X, SPR[0], SPR[1]))
        wheel(f'idler_{tag}', 'idl', side, (side * TRK_X, IDL[0], IDL[1]))
    tracks = []
    for side, tag in ((1, 'R'), (-1, 'L')):
        tb, pitch, Ltot, links = track_band(side)
        tracks.append(L.node_mesh(f'track_{tag}', tb, hullE, (0, 0, 0), sharp=80))
    # ---- hull empties
    L.node_empty('exhaust', hullE, (-1.72, -2.55, FEN_Z + 0.1))
    L.node_empty('hatch_driver', hullE, (0, 1.98, DECK + 0.05))
    L.node_empty('dismount_L', hullE, (-2.2, 0.5, 0.0))
    L.node_empty('dismount_R', hullE, (2.2, -1.45, 0.0))
    lids = msta_lids(hullE, turE)
    lid_objs = [l_['mesh'] for l_ in lids]
    print('  geometry done %.1fs' % (time.time() - t0))
    lod0 = [hull_mesh, tl_mesh, tur_mesh, cage_mesh, gun_mesh] + lid_objs + rg_objs + tracks
    uniq, seen = [], set()
    for o in [hull_mesh, tl_mesh, tur_mesh, cage_mesh, gun_mesh] + lid_objs + rg_objs:
        if o.data.name not in seen:
            uniq.append(o); seen.add(o.data.name)
    return dict(root=root, hull=hullE, turret=turE, gun=gunE, lod0=lod0, gun_obj=gun_mesh, tur_obj=tur_mesh,
                cage_obj=cage_mesh, tl_obj=tl_mesh, atlas=uniq, tracks=tracks, pitch=pitch, track_len=Ltot, links=links,
                lids=lids, tur_lids=[l_['mesh'] for l_ in lids if l_['entry']['parent'] == 'turret'])

def wreck(d):
    root = d['root']
    VB.set_lids(d['lids'], 1.0)          # wrecks show the hatches open (crew bailed out)
    hw = VB.join_copies('hull_wreck', [o for o in d['lod0'] if o not in (d['tur_obj'], d['gun_obj'], d['cage_obj']) + tuple(d['tur_lids'])], root,
                        (0, 0, 0), drop_slots=('glass', 'light'), drop_z=0.04)
    g = d['gun_obj']
    g.rotation_euler = (math.radians(3), 0, 0)
    bpy.context.view_layer.update()
    tp = d['turret'].matrix_world.translation.copy()
    tw = VB.join_copies('turret_wreck', [d['tur_obj'], g] + d['tur_lids'], root, tuple(tp), drop_slots=('glass', 'light'))
    g.rotation_euler = (0, 0, 0)
    tw.location.z -= 0.04
    VB.set_lids(d['lids'], 0.0)
    return [hw, tw]

def z_shape(w, h, t):
    """Russian 'Z' marking: top bar, bottom bar, diagonal (u = right, v = up)."""
    def f(u, v):
        top = (np.abs(v - (h / 2 - t / 2)) < t / 2) & (np.abs(u) < w / 2)
        bot = (np.abs(v + (h / 2 - t / 2)) < t / 2) & (np.abs(u) < w / 2)
        # diagonal from top-right to bottom-left
        a = np.array([w / 2 - t * 0.6, h / 2 - t]); b = np.array([-w / 2 + t * 0.6, -h / 2 + t])
        d = b - a; dn = d / np.linalg.norm(d); nrm = np.array([-dn[1], dn[0]])
        dist = np.abs((u - a[0]) * nrm[0] + (v - a[1]) * nrm[1])
        along = ((u - a[0]) * dn[0] + (v - a[1]) * dn[1])
        diag = (dist < t * 0.62) & (along > -t) & (along < np.linalg.norm(d) + t)
        return (top | bot | diag).astype(np.float32)
    return f

def decals(P, N):
    m = np.zeros(P.shape[:2], np.float32)
    E = lambda p: (-p[0], -p[1], p[2])
    for s in (1, -1):
        xs = side_x(TZ + 0.8)
        # on the left side the Z goes on the bare plate between the stowage boxes and the roof
        c = (s * (xs + 0.005), -0.6 if s > 0 else -0.5, TZ + (0.87 if s < 0 else 0.78))
        m += T.decal_mask(P, N, E(c), E((s, 0, 0)), (0, 0, 1), z_shape(0.5, 0.36, 0.07) if s > 0 else z_shape(0.42, 0.27, 0.06))
    m += T.decal_mask(P, N, E((0.25, REAR_T - 0.03, TZ + 0.55)), E((0, -1, 0)), (0, 0, 1), z_shape(0.32, 0.24, 0.05))
    return m

def flat_preview_materials():
    """Quick geometry iteration: flat colours per slot instead of the baked atlas."""
    cols = dict(rolled=(0.07, 0.09, 0.05), cast=(0.07, 0.09, 0.05), skirt=(0.05, 0.06, 0.04), gunmetal=(0.03, 0.03, 0.03),
                rim=(0.07, 0.09, 0.05), tyre=(0.02, 0.02, 0.02), wood=(0.2, 0.12, 0.06), canvas=(0.18, 0.16, 0.09),
                era=(0.07, 0.09, 0.05), bare=(0.2, 0.2, 0.2), cage=(0.08, 0.08, 0.06), decal=(1, 1, 1),
                glass=(0.01, 0.015, 0.02), light=(0.8, 0.8, 0.7), track=(0.05, 0.05, 0.05))
    out = {}
    for s, c in cols.items():
        out[s] = T.principled('flat_' + s, color=c, rough=0.7, metal=0.0)
    return out

def quick_export(d, out):
    mp = flat_preview_materials()
    done = set()
    for o in d['lod0']:
        if o.data.name in done:
            continue
        T.remap_slots(o, mp)
        done.add(o.data.name)
    VB.export(d['root'], out)

def main(argv):
    quick = '--quick' in argv
    dev = '--dev' in argv
    d = build()
    if quick:
        out = os.path.join(VB.REPO, 'previews', 'vehicles_arty', '_quick_' + NAME + '.glb')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        quick_export(d, out)
        return
    tm = t72.track_textures(NAME)
    VB.SOOT[:] = [((-1.5, -2.6, FEN_Z + 0.12), 0.5)]
    out = os.path.join(VB.REPO, 'previews', 'vehicles_arty', '_dev_' + NAME + '.glb') if dev else None
    if dev and os.environ.get('VEH_OUT'):
        out = os.path.join(os.environ['VEH_OUT'], NAME + '.glb')
    info = VB.finalize(d, NAME, 'ru_green', decals, wreck, track_mats=tm, out=out)
    info['track_link_pitch_m'] = round(d['pitch'], 4)
    info['track_length_m'] = round(d['track_len'], 3)
    info['track_links'] = d['links']
    info['hatch_lids'], info['lid_animation'] = VB.lid_manifest(d['lids'])
    with open(os.path.join(VB.CACHE, NAME + '_info.json'), 'w') as f:
        json.dump(info, f, indent=1)
    print(json.dumps({k: v for k, v in info.items() if k not in ('hierarchy', 'node_bboxes')}))
    if not dev:
        import arty_specs
        arty_specs.write_manifest([NAME])
    return info

if __name__ == '__main__':
    main(sys.argv[1:])
