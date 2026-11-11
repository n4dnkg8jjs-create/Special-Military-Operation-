"""BTR-82A (RU, BPPU turret, 2A72 30 mm + PKTM) and BTR-80 (UA, BPU-1 turret, KPVT 14.5 mm + PKT).

Reference data (see assets/vehicles/manifest.json for sources):
  length 7.65 m, width 2.90 m, height 2.41 m (BTR-80 turret roof) / ~2.80 m (BTR-82A sights),
  ground clearance 0.475 m, wheel track 2.41 m, tyres KI-80 13.00x18 (dia ~1.12 m),
  axle spacing 1.35 + 1.95 + 1.35 m, side doors between axles 2 and 3 (split: upper opens forward,
  lower folds down as a step), round ball-mount firing ports, the forward pair in angled recesses so
  they fire forward, 902V Tucha 81 mm launchers (6, rear of the BPU-1 turret).
Shape (from photographs): boat hull with a horizontal crease at ~wheel-top height, upper sides sloping
  ~39 deg inward to a narrow flat roof, lower sides sloping in to the belly; bow = lower wedge + long
  shallow glacis with the folded trim vane + steeper windscreen plate with two big windows behind
  top-hinged armoured shutters; squared-off engine compartment at the rear.
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
import seats as S

# models_v12: profile re-measured on a BTR-80 5-view drawing + BTR-82A photos (previews/models_v12/PROGRESS.md): wheelbase
# 1.37 + 1.75 + 1.37 m (was 1.35 + 1.95 + 1.35), nose at crease height, ONE shallow upper glacis from the nose to the roof front
# just ahead of the driver / commander hatches (trim vane on its lower half, windscreens on its top half), level roof from
# there back, nearly vertical upper rear plate.  The rear axle / stern stay where they were (vehicle.js stern seat z -3.62).
AXLES = [1.965, 0.595, -1.155, -2.525]
TRACK = 2.41
WR = 0.555          # loaded tyre radius
WZ = 0.548          # hub height
ROOF = 1.92
BELLY = 0.475

# hull cross-section helpers (mid-body, right side)
CH_X, CH_Z = 1.45, 1.27            # crease (widest line)
RF_X = 1.00                        # roof edge half-width
BL_X = 0.62                        # belly half width
NOSE = (3.53, 1.43)                # models_v15: was (3.46, 1.37) - side photo (4) silhouette + BTR-80 drawing
                                   # y, z of the bow edge / knee (glacis / lower glacis junction, ~crease height)
                                   # models_v13: calibrated side photo (24 mm, see previews/models_v13/PROGRESS.md): knee AX1+1.50
                                   # (was +1.71: the drawing's tip is the folded vane lip), lower glacis ~62 deg from horizontal (both photos agree)
WS_TOP = (2.425, ROOF)             # upper glacis top edge = roof front (vision blocks just behind it)
WS_BOT = (2.88, 1.53)              # models_v15: vane plate now ~6 deg (drawing: nearly flat), was (2.86, 1.53) ~15 deg
                                   # models_v14: REAL break line (photos): steep windscreen plate (~42 deg) from the roof front down to
                                   # here, then the shallow upper glacis (~15 deg) carrying the folded trim vane to the knee
WSF_X = 0.93                       # roof front edge half width
CF_Y = 2.35                        # crease front end (cheeks ahead of it)
SF_Y = 1.635                       # side plate top-front corner (side plate front edge leans back)
LG_BOT = (3.07, 0.62)              # models_v15: y 3.06 -> 3.07 (lower glacis ~60 deg with the moved knee)
                                   # lower glacis bottom edge (y, z)  (models_v13: was (2.735, 0.58), 39 deg)
LG_X = 0.74                        # lower glacis bottom half width (main hull)
LGB_X = 0.80                       # bow piece -- lower glacis bottom edge half width (models_v13: was 1.16; plate ~rectangular)
LGC_X = 1.18                       # models_v13: lower cheek bottom-rear corner half width (ahead of wheel 1, photo)
LGF = 0.45                         # models_v13: belly front edge this far behind the lower glacis bottom edge (shallow bottom facet; was 0.13)
REAR_TOP = -3.64                   # roof rear edge
REAR_LOW = (-3.85, 1.30)           # upper rear plate lower edge = rear corner at crease height (models_v13: was z 1.17)
REAR_X = 1.24                      # rear plate half width at REAR_LOW (models_v13: rear photo, was 1.10)
REAR_LB = (-3.74, 0.78)            # models_v13: lower rear plate bottom edge (plate ~11 deg from vertical, side photo)
REAR_BELLY = -3.35                 # belly rear edge (models_v13: was -3.50; short chamfer up to REAR_LB)
CR_Y = -3.05                       # crease rear end
TY = 0.86                          # turret ring centre (y), ~0.27 m ahead of axle 2 (drawing: AX1 - 1.12)
DOOR_Y = -0.28                     # side door centre (between axles 2 and 3)
HATCH_Y = 2.00                     # driver / commander hatch centre (y)
TROOP_Y = -0.55                    # troop roof hatches (y)
HATCH_FRONT = (0.56, 0.52)         # driver / commander roof hatch (w, l)
HATCH_TROOP = (0.52, 0.62)         # troop roof hatches behind the turret
GUNNER_HATCH = (0.12, -0.28, 0.58, 0.26)   # BPPU turret roof hatch (turret local x, y, z, lid radius)
RECESS = (1.15, 1.70)              # forward firing-port recess (y range)
NOSE_X = 0.86                      # bow edge half width (models_v13: calibrated front-3/4 photo, ~rectangular lower glacis)
VANE_W = (0.84, 0.90)              # trim vane half width (hinge edge, top edge)
HL_X = 1.08                        # round lamp clusters on the upper cheeks (x)
VB_X = 0.80                        # windscreen corner vision blocks (x)
WIN_X = 0.31                       # windscreen centres (x)

HATCH_X = 0.42                     # driver / commander hatch centre (|x|)
IS80 = False                       # models_v17: set by setup_variant('btr80_ua')

# models_v17: the BTR-80 (UA) is its OWN model again - the pre-v12 hull (git 2888b1d: narrow roof, old wheelbase, stern, hatches,
# seats, exhaust, BPU-1 turret) - and shares ONLY THE BOW with the BTR-82A: roof -> steep vision-port plate -> shallow (vane) plate
# -> knee -> steep lower glacis + lower cheeks (bow piece), and the cheek-polygon cleanup in hull_shell().  The bow is positioned on
# the BTR-80 by its front axle (the 82A bow was calibrated on photos relative to wheel 1), knee / plate heights kept absolute.
BTR80 = dict(AXLES=[2.125, 0.775, -1.175, -2.525], ROOF=1.96, RF_X=0.90, WS_TOP=(2.36, 1.96), REAR_TOP=-3.30,
             REAR_LOW=(-3.84, 1.34), TY=0.95, DOOR_Y=-0.2, RECESS=(1.20, 1.80), HATCH_Y=1.98, TROOP_Y=-0.40, HATCH_X=0.45,
             IS80=True)

def bow_for(ax1, ws_top):
    """Shared bow (models_v15/v16 BTR-82A, calibrated photos) for a hull whose front axle is at y = ax1 and whose roof front edge
    is ws_top (y, z): knee + lower glacis + crease front ride with the axle, the steep plate keeps the 82A's ~40.6 deg slope
    from the roof front down to the 82A's break height (z 1.53), then the shallow vane plate runs on to the knee."""
    d = ax1 - 1.965
    zb = 1.53
    ws_bot = (ws_top[0] + (ws_top[1] - zb) / math.tan(math.atan2(1.92 - 1.53, 2.88 - 2.425)), zb)
    return dict(NOSE=(3.53 + d, 1.43), LG_BOT=(3.07 + d, 0.62), CF_Y=2.35 + d, WS_BOT=ws_bot)

def setup_variant(variant):
    """models_v17: BTR-82A = the module defaults; BTR-80 (UA) = its pre-v12 hull constants (BTR80) + the shared bow (bow_for)."""
    global GUNNER_HATCH, N_UP
    if variant == 'btr80_ua':
        g = globals()
        g.update(BTR80)
        g.update(bow_for(BTR80['AXLES'][0], BTR80['WS_TOP']))
        N_UP = V((ROOF - CH_Z, 0, CH_X - RF_X)).normalized()
    if variant == 'btr82a':
        # models_v17: the gunner's hatch is the hinged lid on top of the rear box (Arzamas (40): lid with handle and hinge line).
        GUNNER_HATCH = (0.03, -0.90, RX_Z, 0.34, 0.28)     # models_v17: lid on top of the rear box, hinged on its left edge

def x_upper(z):  # upper side plate x at height z
    return CH_X - (z - CH_Z) * (CH_X - RF_X) / (ROOF - CH_Z)
def x_lower(z):
    return BL_X + (z - BELLY) * (CH_X - BL_X) / (CH_Z - BELLY)
N_UP = V((ROOF - CH_Z, 0, CH_X - RF_X)).normalized()      # outward normal of upper side (right)
N_LO = V((CH_Z - BELLY, 0, -(CH_X - BL_X))).normalized()  # outward normal of lower side (right)

def on_upper(y, z, off=0.0, side=1):
    p = V((x_upper(z) * side, y, z)) + V((N_UP.x * side, 0, N_UP.z)) * off
    return p

def frame_upper(side=1):
    n = V((N_UP.x * side, 0, N_UP.z))
    return L.frame_from_normal(n, V((0, 0, 1)))

def frame_lower(side=1):
    n = V((N_LO.x * side, 0, N_LO.z))
    return L.frame_from_normal(n, V((0, 0, 1)))

def plate_M(n, s):
    """Right-handed frame on a side plate: local x = +Y (forward), y = up the plate, z = outward normal."""
    n = V((n.x * s, 0, n.z)).normalized()
    xx = V((0, 1, 0))
    yy = n.cross(xx) * -1
    if yy.z < 0:
        yy = -yy
    M = Matrix((xx, yy, n)).transposed().to_4x4()
    if M.to_3x3().determinant() < 0:
        M = Matrix((xx * -1, yy, n)).transposed().to_4x4()
    return M

def front_plate(p_lo, p_hi):
    """Normal / up-the-plate unit vectors of a transverse front plate given (y, z) of its lower & upper edge."""
    u = V((0, p_hi[0] - p_lo[0], p_hi[1] - p_lo[1])).normalized()
    n = V((0, -u.z, u.y)) if u.y < 0 else V((0, u.z, -u.y))
    if n.y < 0:
        n = -n
    return n, u

def frame_nu(n, u):
    """Frame with local z = n, y = u, x = y cross z."""
    x = u.cross(n).normalized()
    return Matrix((x, u, n)).transposed().to_4x4()

# =============================================================================================== hull
def hull_shell():
    # models_v12: convex hull of the re-measured profile points (every plate planar): one upper glacis plane from the bow
    # edge to the roof front, cheeks between it and the side plates, lower glacis + lower cheeks, level roof, near-vertical
    # upper rear plate, inward-sloped lower rear plate.  Wheel arches + forward firing-port recesses are boolean cuts.
    pts = []
    if IS80:
        # models_v17 BTR-80: its pre-v12 hull (narrow roof RF_X 0.90 back to the roof front edge, old stern) with the shared bow
        for s in (1, -1):
            pts += [(s * BL_X, -3.18, BELLY), (s * BL_X, LG_BOT[0] - LGF, BELLY),               # belly
                    (s * LG_X, LG_BOT[0], LG_BOT[1]),                                              # lower glacis bottom
                    (s * CH_X, -3.12, CH_Z), (s * CH_X, CF_Y, CH_Z),                               # crease
                    (s * NOSE_X, NOSE[0], NOSE[1]),                                                # knee (bow edge)
                    (s * RF_X, WS_TOP[0], ROOF), (s * RF_X, REAR_TOP, ROOF),                       # roof
                    (s * 1.16, REAR_LOW[0], REAR_LOW[1])]
    for s in ((1, -1) if not IS80 else ()):
        pts += [(s * BL_X, REAR_BELLY, BELLY), (s * BL_X, LG_BOT[0] - LGF, BELLY),          # belly
                (s * LG_X, LG_BOT[0], LG_BOT[1]),                                              # lower glacis bottom
                (s * CH_X, CR_Y, CH_Z), (s * CH_X, CF_Y, CH_Z),                                # crease (widest line)
                (s * NOSE_X, NOSE[0], NOSE[1]),                                                # bow edge
                (s * WSF_X, WS_TOP[0], ROOF), (s * RF_X, SF_Y, ROOF), (s * RF_X, REAR_TOP + 0.06, ROOF),   # roof
                (s * (RF_X - 0.06), REAR_TOP, ROOF - 0.03),                                    # small rear roof chamfer
                (s * REAR_X, REAR_LOW[0], REAR_LOW[1]),                                        # rear plate corner
                (s * (BL_X + (REAR_LB[1] - BELLY) * (CH_X - BL_X) / (CH_Z - BELLY) - 0.02), REAR_LB[0], REAR_LB[1])]                                 # lower rear plate bottom
    b = hull(pts)
    # models_v12 (front photos + 5-view front elevation): the lower glacis WIDENS downward -- nose edge +-0.88, bottom edge
    # nearly the track width -- with lower cheek facets back to the crease, so the bow reads as a broad blunt wedge wrapping the
    # front of wheel 1.  Not convex with the narrow lower sides behind it -> separate convex piece, boolean-united, then the
    # wheel-arch cut shapes its back into the front arch.
    bp_ = []
    for s in (1, -1):
        bp_ += [(s * NOSE_X, NOSE[0], NOSE[1]), (s * LGB_X, LG_BOT[0], LG_BOT[1]), (s * BL_X, LG_BOT[0] - LGF, BELLY),
                (s * CH_X, CF_Y, CH_Z), (s * CH_X, AXLES[0] + 0.15, CH_Z), (s * LGC_X, AXLES[0] + 0.15, LG_BOT[1] + 0.06),
                (s * BL_X, AXLES[0] + 0.15, BELLY)]
    bow = hull(bp_)
    me_b = bow.to_mesh('_bow')
    ob_b = L.link(bpy.data.objects.new('_bow', me_b))
    b.mods([('BOOLEAN', dict(operation='UNION', object=ob_b, solver='EXACT'))])
    bpy.data.objects.remove(ob_b)
    cut = B(mat='rolled')
    for y in AXLES:
        for s in (1, -1):
            cut.add(cyl(0.68, 0.9, 40, 'x', c=(s * (TRACK / 2 + 0.25), y, WZ)))
    # forward firing-port recesses: wedge cut into the upper side so the port faces forward-outward
    for s in (1, -1):
        rp = []
        for z in (CH_Z + 0.14, ROOF - 0.12):
            xs = x_upper(z)
            for (dx, y) in ((-0.26, RECESS[0]), (0.5, RECESS[0]), (0.5, RECESS[1]), (0.03, RECESS[1])):
                rp.append((s * (xs + dx), y, z))
        cut.add(hull(rp))
    # models_v14: two-plane bow (concave break at WS_BOT): remove everything above both the steep windscreen plane and the
    # shallow vane plane (their intersection half-space is convex)
    us = V((0, WS_TOP[0] - WS_BOT[0], ROOF - WS_BOT[1])).normalized()
    ul = V((0, NOSE[0] - WS_BOT[0], NOSE[1] - WS_BOT[1])).normalized()
    A2 = V((0, WS_BOT[0], WS_BOT[1])) + us * 1.2
    K2 = V((0, WS_BOT[0], WS_BOT[1])) + ul * 1.6
    bc = []
    for s in (1, -1):
        for (yy, zz) in ((A2.y, A2.z), (WS_BOT[0], WS_BOT[1]), (K2.y, K2.z), (K2.y, 3.6), (A2.y, 3.6)):
            bc.append((s * 2.5, yy, zz))
    cut.add(hull(bc))
    me_cut = cut.to_mesh('_cut')
    ob_cut = L.link(bpy.data.objects.new('_cut', me_cut))
    b.mods([('BOOLEAN', dict(operation='DIFFERENCE', object=ob_cut, solver='EXACT'))])
    bpy.data.objects.remove(ob_cut)
    b.bevel(0.02, 2, 25)
    # models_v16: the booleans + bevel leave near-duplicate vertices (<1 mm apart) and big CONCAVE n-gons (bow cheeks: roof corner ->
    # crease -> nose -> WS_BOT break point); the exporter's triangulation folded the cheek polygon (a reversed coplanar triangle over
    # the cheek - the grey patch on the UA camo).  Weld the near-duplicates and ear-clip the n-gons here.
    bmesh.ops.remove_doubles(b.bm, verts=b.bm.verts[:], dist=0.0004)
    bmesh.ops.triangulate(b.bm, faces=[f for f in b.bm.faces if len(f.verts) > 4], quad_method='BEAUTY', ngon_method='EAR_CLIP')
    # (fresh bmesh: the welded one has holes in its element pools, and B.add() relies on new verts landing at the END of the table)
    me_ = bpy.data.meshes.new('_shell'); b.bm.to_mesh(me_); b.bm.free()
    b.bm = bmesh.new(); b.bm.from_mesh(me_); bpy.data.meshes.remove(me_)
    return b

def glacis_frame():
    """Upper glacis plane: (origin at the bow edge centre, n, u) with u = up the plate."""
    n, u = front_plate(NOSE, WS_TOP)
    return V((0, NOSE[0], NOSE[1])), n, u

def lower_glacis_frame():
    """Lower glacis plane: (origin at the bottom edge centre, n (forward-down), u = up the plate toward the bow edge)."""
    u = V((0, NOSE[0] - LG_BOT[0], NOSE[1] - LG_BOT[1])).normalized()
    n = V((0, u.z, -u.y))
    if n.y < 0:
        n = -n
    return V((0, LG_BOT[0], LG_BOT[1])), n, u

def lower_glacis_details(H, lamp_boxes):
    """models_v17: shared bow (BTR-82A + BTR-80): tow hooks, access cover and lugs on the steep lower glacis; the BTR-82A also
    carries its headlights in armoured boxes on top of it (the BTR-80 keeps its lamp clusters on the vane corners)."""
    lo, ln, lu_ = lower_glacis_frame()
    MLG = frame_nu(ln, lu_)
    lg_len = (V((0, NOSE[0], NOSE[1])) - lo).length
    for s in (1, -1):
        for x in ((0.48, 0.70) if lamp_boxes else ()):                       # headlights in armoured boxes on top of the lower glacis
            hb = box(0.15, 0.15, 0.10, c=(0, 0, 0.05), bev=0.01, segs=1)
            hb.add(box(0.11, 0.10, 0.012, c=(0, -0.005, 0.102), mat='glass'))
            hb.add(box(0.17, 0.03, 0.05, c=(0, 0.075, 0.09), bev=0.005, segs=1))          # hood
            for xx in (-0.03, 0.03):
                hb.add(box(0.012, 0.10, 0.012, c=(xx, -0.005, 0.11)))                    # armour slats
            H.add(hb, L.place(MLG, lo + V((s * x, 0, 0)) + lu_ * (lg_len - 0.12)))
        H.add(tow_hook().rot('X', -60), L.place(MLG, lo + V((s * 0.52, 0, 0)) + lu_ * 0.38 + ln * 0.02))
    acc = box(0.42, 0.24, 0.02, c=(0, 0, 0.01), bev=0.006, segs=1)                      # lower bow access cover
    acc.add(rail([(-0.08, -0.06, 0.02), (-0.08, -0.06, 0.06), (0.08, -0.06, 0.06), (0.08, -0.06, 0.02)], r=0.009, rad=0.02))
    H.add(acc, L.place(MLG, lo + lu_ * (lg_len - 0.38)))
    for x in (-0.3, 0.3):
        H.add(lathe([(0.03, -0.015), (0.055, -0.015), (0.055, 0.015), (0.03, 0.015)], 12, 'x', cap=False), L.place(MLG, lo + V((x, 0, 0)) + lu_ * 0.12 + ln * 0.04))

def weld_line(pts, r=0.007):
    return tube(pts, r, 5, 'rolled', caps=True)

def hatch_rect(w, l, t=0.035, c=(0, 0, 0), hinge='y-', rad=0.06):
    """Rectangular roof hatch lying on z=c.z, with hinges and handle."""
    hw, hl = w / 2, l / 2
    poly = []
    for (cx, cy, a0) in ((hw - rad, hl - rad, 0), (-hw + rad, hl - rad, 90), (-hw + rad, -hl + rad, 180), (hw - rad, -hl + rad, 270)):
        for k in range(4):
            a = math.radians(a0 + k * 30)
            poly.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
    b = prism(poly, t, 'z', bev=0.008, segs=1, c=t / 2)
    # rim/coaming
    ring = prism([(x * 1.08 + 0, y * 1.08) for x, y in poly], 0.02, 'z', c=0.01)
    b.add(ring)
    # hinges along one edge
    hy = -hl if hinge == 'y-' else hl
    for sx in (-0.6, 0.6):
        b.add(cyl(0.028, 0.12, 10, 'x', c=(sx * hw, hy - 0.02 * (1 if hinge == 'y+' else -1) * -1, 0.03)))
        b.add(box(0.1, 0.09, 0.012, c=(sx * hw, hy * 0.82, t + 0.006)))
    b.add(rail([(-0.12, hl * -hy / abs(hy) * 0.55, t), (-0.12, hl * -hy / abs(hy) * 0.55, t + 0.06),
                (0.12, hl * -hy / abs(hy) * 0.55, t + 0.06), (0.12, hl * -hy / abs(hy) * 0.55, t)], r=0.01, rad=0.03))
    b.add(cyl(0.03, 0.02, 10, c=(0, 0, t + 0.01)))   # lock boss
    b.move(*c)
    return b

def periscope_block(w=0.20, h=0.11, d=0.07):
    """TNPO-style prism block: armoured housing + glass face (local: +Y view direction, base at z=0)."""
    b = hull([(-w / 2, -d / 2, 0), (w / 2, -d / 2, 0), (-w / 2, d / 2, 0), (w / 2, d / 2, 0),
              (-w / 2, -d / 2, h), (w / 2, -d / 2, h), (-w / 2, d / 2 - 0.02, h * 0.75), (w / 2, d / 2 - 0.02, h * 0.75)],
             bev=0.006, segs=1)
    gl = box(w * 0.8, 0.01, h * 0.38, c=(0, d / 2 + 0.002, h * 0.38), mat='glass')
    b.add(gl)
    b.add(box(w * 0.96, 0.05, 0.012, c=(0, d / 2 + 0.02, h * 0.62)))   # brow
    return b

def headlight_cluster(side):
    b = B()
    # bracket
    b.add(box(0.36, 0.1, 0.03, c=(0, 0, 0.015), bev=0.006, segs=1))
    # main headlight
    hl = lathe([(0, -0.07), (0.07, -0.07), (0.085, -0.02), (0.088, 0.05), (0.08, 0.06)], 20, 'y')
    hl.add(lathe([(0.0, 0.07), (0.075, 0.058)], 20, 'y', mat='light', cap=False))
    hl.add(cyl(0.075, 0.004, 20, 'y', c=(0, 0.0625, 0), mat='light'))   # lights_v1: lens disc y 0.0605-0.0645, clear of the housing cap (y 0.06), was coplanar -> z-fight
    hl.move(-0.06 * side, 0.0, 0.12)
    b.add(hl)
    # blackout/marker light
    ml = cyl(0.04, 0.06, 12, 'y', c=(0.11 * side, 0.0, 0.1))
    ml.add(cyl(0.032, 0.006, 12, 'y', c=(0.11 * side, 0.032, 0.1), mat='light'))
    b.add(ml)
    b.add(box(0.03, 0.04, 0.09, c=(-0.06 * side, -0.01, 0.045)))
    b.add(box(0.03, 0.04, 0.07, c=(0.11 * side, -0.01, 0.035)))
    # guard cage (bent rods)
    for x in (-0.19, 0.0, 0.17):
        b.add(rail([(x, -0.04, 0.03), (x, 0.13, 0.08), (x, 0.13, 0.22), (x, -0.02, 0.26)], r=0.009, rad=0.04, foot=False))
    b.add(tube([(-0.19, 0.13, 0.15), (0.17, 0.13, 0.15)], 0.008, 6))
    return b

def tow_hook():
    b = B()
    b.add(box(0.12, 0.06, 0.16, c=(0, 0, 0), bev=0.01, segs=1))
    b.add(tube(fillet_path([(0, 0.02, 0.05), (0, 0.16, 0.05), (0, 0.18, -0.06), (0, 0.12, -0.1)], 0.05, 4), 0.022, 8))
    return b

def firing_port():
    """Ball mount: armoured round cover plate + ball + cover flap hinge (local +Z out of plate)."""
    b = lathe([(0, 0.035), (0.05, 0.034), (0.09, 0.022), (0.115, 0.012), (0.12, 0.0), (0, 0)], 20, 'z')
    b.add(lathe([(0, 0.06), (0.04, 0.055), (0.055, 0.03), (0.055, 0.02)], 14, 'z', cap=False))
    b.add(cyl(0.018, 0.04, 8, 'z', c=(0, 0, 0.07), mat='gunmetal'))
    for a in range(6):
        ang = a * math.tau / 6
        b.add(bolt(0.009, 0.007), Matrix.Translation((0.1 * math.cos(ang), 0.1 * math.sin(ang), 0.012)))
    return b

def door(upper_h=0.55, lower_h=0.4, w=0.7):
    """Two-part side door: upper part in upper side plane, lower in lower plane. Returns parts in
    local frames: (upper B in upper-plate frame, lower B in lower-plate frame).  Frame: x along hull (+Y fwd),
    y up-the-plate, z out of plate."""
    up = prism([(-w / 2, 0.02), (w / 2, 0.02), (w / 2 - 0.03, upper_h), (-w / 2 + 0.03, upper_h)], 0.03, 'z', c=0.015,
               bev=0.008, segs=1)
    # hinges at front edge (opens forward)
    for yy in (0.12, upper_h - 0.12):
        up.add(cyl(0.024, 0.11, 10, 'y', c=(w / 2 + 0.01, yy, 0.025)))
        up.add(box(0.12, 0.07, 0.012, c=(w / 2 - 0.05, yy, 0.034)))
    up.add(rail([(-w / 2 + 0.08, upper_h * 0.45, 0.03), (-w / 2 + 0.08, upper_h * 0.45, 0.08),
                 (-w / 2 + 0.08, upper_h * 0.75, 0.08), (-w / 2 + 0.08, upper_h * 0.75, 0.03)], r=0.01, rad=0.025))
    lo = prism([(-w / 2 + 0.03, -lower_h), (w / 2 - 0.03, -lower_h), (w / 2, -0.02), (-w / 2, -0.02)], 0.03, 'z', c=0.015,
               bev=0.008, segs=1)
    for xx in (-w * 0.3, w * 0.3):
        lo.add(cyl(0.022, 0.1, 10, 'x', c=(xx, -lower_h + 0.0, 0.02)))
    lo.add(box(0.36, 0.05, 0.03, c=(0, -lower_h * 0.45, 0.04), bev=0.006, segs=1))  # step tread bar
    return up, lo

def louvre_panel(w, l, n=9):
    """Engine deck air intake: frame + angled armoured slats (local, on z=0, slats across x)."""
    b = B()
    t = 0.03
    b.add(box(w + 0.08, 0.05, 0.05, c=(0, l / 2 + 0.02, 0.025), bev=0.008, segs=1))
    b.add(box(w + 0.08, 0.05, 0.05, c=(0, -l / 2 - 0.02, 0.025), bev=0.008, segs=1))
    b.add(box(0.05, l, 0.05, c=(w / 2 + 0.02, 0, 0.025), bev=0.008, segs=1))
    b.add(box(0.05, l, 0.05, c=(-w / 2 - 0.02, 0, 0.025), bev=0.008, segs=1))
    # dark recess floor
    b.add(box(w, l, 0.01, c=(0, 0, -0.06), mat='gunmetal'))
    for i in range(n):
        y = -l / 2 + (i + 0.5) * l / n
        s = box(w, 0.012, l / n * 1.15, c=(0, 0, 0)).rot('X', 50).move(0, y, 0.0)
        b.add(s)
    return b

def exhaust_box(side):
    """Exhaust muffler cover on the rear upper hull side (perforated cover + pipe)."""
    b = hull([(0, -0.35, 0), (0, 0.35, 0), (0, -0.35, 0.32), (0, 0.35, 0.32),
              (0.13 * side, -0.32, 0.03), (0.13 * side, 0.32, 0.03), (0.13 * side, -0.32, 0.28), (0.13 * side, 0.32, 0.28)],
             bev=0.012, segs=2)
    for i in range(5):
        b.add(box(0.012, 0.5, 0.02, c=(0.135 * side, 0, 0.07 + i * 0.045), mat='gunmetal'))
    b.add(cyl(0.05, 0.12, 12, 'y', c=(0.08 * side, -0.4, 0.12), mat='gunmetal'))
    return b

def tool_shovel():
    b = box(0.9, 0.035, 0.035, bev=0.01, segs=1, mat='wood')
    blade = hull([(0.45, -0.1, -0.012), (0.75, -0.08, -0.012), (0.45, 0.1, -0.012), (0.75, 0.08, -0.012),
                  (0.45, -0.1, 0.0), (0.75, -0.08, 0.0), (0.45, 0.1, 0.0), (0.75, 0.08, 0.0), (0.8, 0, -0.006)], mat='bare')
    b.add(blade.move(0, 0, 0.006))
    return b

def antenna_base():
    b = lathe([(0, 0), (0.07, 0), (0.07, 0.03), (0.04, 0.05), (0.035, 0.18), (0.02, 0.2), (0, 0.2)], 12, 'z')
    b.add(cyl(0.008, 0.5, 6, 'z', c=(0, 0, 0.45), mat='gunmetal'))
    return b

def tow_cable(p0, p1, sag=0.0, loops=True):
    pts = [V(p0).lerp(V(p1), t) + V((0, 0, -sag * math.sin(math.pi * t))) for t in np.linspace(0, 1, 14)]
    b = tube(pts, 0.016, 6, 'bare')
    # eyes
    for p, d in ((V(p0), -1), (V(p1), 1)):
        eye = lathe([(0.04, -0.012), (0.06, -0.012), (0.06, 0.012), (0.04, 0.012)], 12, 'z', mat='bare', cap=False)
        eye.add(lathe([(0.06, 0.012), (0.04, 0.012)], 12, 'z', mat='bare', cap=False))
        b.add(eye.rot('X', 90), Matrix.Translation(p + (V(p1) - V(p0)).normalized() * d * 0.05))
    return b

def align_y(d):
    """Rotation matrix taking local +Y to direction d."""
    return V((0, 1, 0)).rotation_difference(V(d).normalized()).to_matrix().to_4x4()

def tucha_tube():
    tb = lathe([(0, -0.1), (0.044, -0.1), (0.044, 0.1), (0.037, 0.1), (0.037, -0.06), (0, -0.06)], 12, 'y')
    tb.add(cyl(0.05, 0.02, 12, 'y', c=(0, 0.085, 0)))
    tb.add(cyl(0.05, 0.02, 12, 'y', c=(0, -0.07, 0)))
    return tb

def exhaust_muffler(side):
    """Exhaust silencer cover on the rear upper side plate (built in the plate frame: x fwd, y up-plate, z out)."""
    b = hull([(-0.36, -0.02, 0), (0.36, -0.02, 0), (-0.36, 0.36, 0), (0.36, 0.36, 0),
              (-0.33, 0.01, 0.15), (0.33, 0.01, 0.15), (-0.33, 0.33, 0.13), (0.33, 0.33, 0.13)], bev=0.012, segs=2)
    for i in range(5):
        b.add(box(0.56, 0.022, 0.014, c=(0.02, 0.06 + i * 0.06, 0.148), mat='gunmetal'))
    b.add(box(0.04, 0.34, 0.03, c=(0.26, 0.17, 0.15)))
    b.add(box(0.04, 0.34, 0.03, c=(-0.22, 0.17, 0.15)))
    # tail pipe out of the rear end, angled down
    b.add(tube([(-0.30, 0.12, 0.08), (-0.46, 0.10, 0.09), (-0.54, 0.02, 0.10)], 0.045, 10, 'gunmetal'))
    b.add(cyl(0.05, 0.03, 10, 'x', c=(-0.33, 0.12, 0.08), mat='gunmetal').rot('Y', 0))
    return b

def windscreen(open_):
    """Two driver/commander windows high on the upper glacis (just under the roof front edge), each behind a top-hinged
    armoured shutter (open = propped on struts).  models_v12: windows at x +-0.31 (drawing), sized to the 0.51 m windscreen zone."""
    n, u = front_plate(WS_BOT, WS_TOP)
    M = frame_nu(n, u)                          # local x = -X, y = up the plate, z = out
    o0 = V((0, WS_BOT[0], WS_BOT[1]))
    W = B()
    for s in (1, -1):
        loc = B()
        # window: dark glass set into a frame
        loc.add(box(0.40, 0.22, 0.02, c=(0, 0, -0.002), mat='glass'))
        loc.add(box(0.47, 0.04, 0.035, c=(0, 0.13, 0.012), bev=0.008, segs=1))
        loc.add(box(0.47, 0.04, 0.035, c=(0, -0.13, 0.012), bev=0.008, segs=1))
        for x in (-0.215, 0.215):
            loc.add(box(0.04, 0.30, 0.035, c=(x, 0, 0.012), bev=0.008, segs=1))
        loc.add(box(0.022, 0.22, 0.022, c=(0, 0, 0.004)))          # centre mullion
        # shutter (hinge axis along local x at the window top)
        sh = box(0.50, 0.40, 0.032, c=(0, -0.20, 0.016), bev=0.008, segs=1)
        for y in (-0.10, -0.29):
            sh.add(box(0.44, 0.028, 0.024, c=(0, y, 0.043), bev=0.005, segs=1))
        sh.add(box(0.11, 0.05, 0.034, c=(0.13, -0.2, 0.04), bev=0.006, segs=1))
        sh.add(box(0.08, 0.012, 0.02, c=(0.13, -0.2, 0.06), mat='glass'))   # small vision slit
        sh.add(rail([(-0.10, -0.35, 0.032), (-0.10, -0.35, 0.075), (0.05, -0.35, 0.075), (0.05, -0.35, 0.032)], r=0.009, rad=0.02))
        for x in (-0.17, 0.17):
            sh.add(cyl(0.022, 0.11, 10, 'x', c=(x, 0.0, 0.0)))
            sh.add(box(0.10, 0.07, 0.012, c=(x, -0.045, 0.034)))
        hinge = V((0, 0.19, 0.03))
        ang = -80 if open_ else 0
        Rm = Matrix.Rotation(math.radians(ang), 4, 'X')
        loc.add(sh, Matrix.Translation(hinge) @ Rm)
        for x in (-0.17, 0.17):
            loc.add(box(0.09, 0.045, 0.03, c=(x, 0.21, 0.012), bev=0.006, segs=1))   # hull hinge blocks
        if open_:
            for x in (-0.23, 0.23):
                p0 = V((x * 1.02, -0.10, 0.03))
                p1 = Matrix.Translation(hinge) @ Rm @ V((x, -0.30, 0.0))
                loc.add(tube([p0, p1], 0.011, 6, 'bare'))
                loc.add(cyl(0.02, 0.03, 8, 'z', c=tuple(p0)))
        o = o0 + V((s * WIN_X, 0, 0)) + u * 0.27
        W.add(loc, L.place(M, o))
        # small vision block on the outer corner of the windscreen zone
        vb = box(0.11, 0.10, 0.06, c=(0, 0, 0.03), bev=0.01, segs=1)
        vb.add(box(0.08, 0.05, 0.01, c=(0, 0.0, 0.062), mat='glass'))
        vb.add(box(0.14, 0.02, 0.03, c=(0, 0.06, 0.065)))
        W.add(vb, L.place(M, o0 + V((s * VB_X, 0, 0)) + u * 0.30))
    return W

def trim_vane():
    """Folded trim vane (wave breaker) lying on the glacis, hinged at the bow edge."""
    n, u = front_plate(NOSE, WS_BOT)
    M = frame_nu(n, u)
    tv = B()
    w0, w1 = VANE_W
    k = w1 / 0.84                    # models_v12: ~1.07 (vane spans the glacis, drawing)
    tv.add(prism([(-w0, 0.10), (w0, 0.10), (w1, 0.74), (-w1, 0.74)], 0.03, 'z', c=0.055, bev=0.008, segs=1))
    # models_v12: folded, the vane shows its flat outer face (BTR-82A photos): a smooth plate with a flanged rim, two shallow
    # pressed panels and a tubular hand rail along the bow edge -- not the tall stiffener grid (that is on the hidden face)
    tv.add(box(2 * w1, 0.03, 0.022, c=(0, 0.735, 0.064), bev=0.005, segs=1))
    tv.add(box(2 * w0 + 0.02, 0.03, 0.02, c=(0, 0.115, 0.064), bev=0.005, segs=1))
    for sx in (-1, 1):
        tv.add(prism([(sx * 0.06, 0.20), (sx * 0.52 * k, 0.20), (sx * 0.56 * k, 0.66), (sx * 0.06, 0.66)], 0.012, 'z', c=0.076, bev=0.004, segs=1))
    rl = [(-0.86 * k, 0.16, 0.055), (-0.84 * k, 0.12, 0.10), (-0.70 * k, 0.10, 0.115), (0.70 * k, 0.10, 0.115), (0.84 * k, 0.12, 0.10), (0.86 * k, 0.16, 0.055)]   # models_v15: lower (side photo)
    tv.add(tube(rl, 0.017, 8))
    # stand-off brackets to the plate
    for x in (-0.55 * k, 0.55 * k):
        for y in (0.2, 0.65):
            tv.add(box(0.06, 0.06, 0.05, c=(x, y, 0.025)))
    # bow hinges
    for x in (-0.55 * k, -0.2 * k, 0.2 * k, 0.55 * k):
        tv.add(cyl(0.03, 0.15, 10, 'x', c=(x, 0.06, 0.04)))
        tv.add(box(0.12, 0.08, 0.02, c=(x, 0.03, 0.01)))
    # folded actuating struts along the vane edges
    for x in (-0.8 * k, 0.8 * k):
        tv.add(tube([(x, 0.14, 0.03), (x * 1.06, 0.66, 0.05)], 0.016, 6, 'bare'))
    # models_v13: shorter upper glacis -> fit the vane between the bow edge and the windscreen zone
    zl = (V((0, WS_BOT[0], WS_BOT[1])) - V((0, NOSE[0], NOSE[1]))).length
    tv.scale(1, min(1.0, (zl - 0.025) / 0.74), 1)
    return L.place(M, V((0, NOSE[0], NOSE[1]))), tv, (n, u)

def windscreen_80(open_):
    """BTR-80 (pre-v12 model, models_v17 kept): two big driver/commander windows with top-hinged armoured shutters (open = propped
    on struts) on the steep vision-port plate."""
    n, u = front_plate(WS_BOT, WS_TOP)
    M = frame_nu(n, u)                          # local x = -X, y = up the plate, z = out
    o0 = V((0, WS_BOT[0], WS_BOT[1]))
    W = B()
    for s in (1, -1):
        loc = B()
        # window: dark glass set into a frame
        loc.add(box(0.52, 0.27, 0.02, c=(0, 0, -0.002), mat='glass'))
        loc.add(box(0.60, 0.045, 0.035, c=(0, 0.157, 0.012), bev=0.008, segs=1))
        loc.add(box(0.60, 0.045, 0.035, c=(0, -0.157, 0.012), bev=0.008, segs=1))
        for x in (-0.282, 0.282):
            loc.add(box(0.045, 0.36, 0.035, c=(x, 0, 0.012), bev=0.008, segs=1))
        loc.add(box(0.025, 0.27, 0.025, c=(0, 0, 0.004)))          # centre mullion
        # shutter (hinge axis along local x at the window top)
        sh = box(0.64, 0.40, 0.032, c=(0, -0.20, 0.016), bev=0.008, segs=1)
        for y in (-0.10, -0.29):
            sh.add(box(0.56, 0.03, 0.026, c=(0, y, 0.044), bev=0.005, segs=1))
        sh.add(box(0.12, 0.05, 0.035, c=(0.18, -0.2, 0.04), bev=0.006, segs=1))
        sh.add(box(0.09, 0.012, 0.02, c=(0.18, -0.2, 0.06), mat='glass'))   # small vision slit
        sh.add(rail([(-0.12, -0.36, 0.032), (-0.12, -0.36, 0.08), (0.06, -0.36, 0.08), (0.06, -0.36, 0.032)], r=0.009, rad=0.02))
        for x in (-0.22, 0.22):
            sh.add(cyl(0.024, 0.13, 10, 'x', c=(x, 0.0, 0.0)))
            sh.add(box(0.12, 0.08, 0.012, c=(x, -0.05, 0.034)))
        hinge = V((0, 0.21, 0.03))
        ang = -80 if open_ else 0
        Rm = Matrix.Rotation(math.radians(ang), 4, 'X')
        loc.add(sh, Matrix.Translation(hinge) @ Rm)
        for x in (-0.22, 0.22):
            loc.add(box(0.1, 0.05, 0.03, c=(x, 0.235, 0.012), bev=0.006, segs=1))   # hull hinge blocks
        if open_:
            for x in (-0.3, 0.3):
                p0 = V((x * 1.02, -0.10, 0.03))
                p1 = Matrix.Translation(hinge) @ Rm @ V((x, -0.30, 0.0))
                loc.add(tube([p0, p1], 0.011, 6, 'bare'))
                loc.add(cyl(0.02, 0.03, 8, 'z', c=tuple(p0)))
        o = o0 + V((s * 0.45, 0, 0)) + u * 0.34 + n * 0.0
        W.add(loc, L.place(M, o))
        # small vision block on the outer corner of the windscreen plate
        vb = box(0.11, 0.10, 0.06, c=(0, 0, 0.03), bev=0.01, segs=1)
        vb.add(box(0.08, 0.05, 0.01, c=(0, 0.0, 0.062), mat='glass'))
        vb.add(box(0.14, 0.02, 0.03, c=(0, 0.06, 0.065)))
        W.add(vb, L.place(M, o0 + V((s * 0.86, 0, 0)) + u * 0.30))
    return W

def trim_vane_80():
    """BTR-80 (pre-v12 model): folded trim vane with its stiffener grid, hinged at the bow edge.  models_v17: lies on the shared
    bow's shallow plate (knee -> WS_BOT), fitted to its length."""
    n, u = front_plate(NOSE, WS_BOT)
    M = frame_nu(n, u)
    tv = B()
    tv.add(prism([(-0.70, 0.10), (0.70, 0.10), (0.84, 0.74), (-0.84, 0.74)], 0.03, 'z', c=0.055, bev=0.008, segs=1))
    # perimeter angle + vertical stiffeners + top rib
    tv.add(box(1.68, 0.035, 0.05, c=(0, 0.735, 0.085), bev=0.006, segs=1))
    tv.add(box(1.42, 0.035, 0.04, c=(0, 0.115, 0.08), bev=0.006, segs=1))
    for x in (-0.54, -0.18, 0.18, 0.54):
        tv.add(box(0.035, 0.6, 0.045, c=(x, 0.42, 0.085), bev=0.006, segs=1))
    tv.add(box(1.5, 0.03, 0.035, c=(0, 0.42, 0.08), bev=0.005, segs=1))
    # stand-off brackets to the plate
    for x in (-0.55, 0.55):
        for y in (0.2, 0.65):
            tv.add(box(0.06, 0.06, 0.05, c=(x, y, 0.025)))
    # bow hinges
    for x in (-0.55, -0.2, 0.2, 0.55):
        tv.add(cyl(0.03, 0.15, 10, 'x', c=(x, 0.06, 0.04)))
        tv.add(box(0.12, 0.08, 0.02, c=(x, 0.03, 0.01)))
    # folded actuating struts along the vane edges
    for x in (-0.8, 0.8):
        tv.add(tube([(x, 0.14, 0.03), (x * 1.08, 0.66, 0.05)], 0.016, 6, 'bare'))
    tv.add(rail([(-0.12, 0.6, 0.07), (-0.12, 0.6, 0.12), (0.12, 0.6, 0.12), (0.12, 0.6, 0.07)], r=0.01, rad=0.02))
    zl = (V((0, WS_BOT[0], WS_BOT[1])) - V((0, NOSE[0], NOSE[1]))).length
    tv.scale(1, min(1.0, (zl - 0.03) / 0.74), 1)
    return L.place(M, V((0, NOSE[0], NOSE[1]))), tv, (n, u)

# =============================================================================================== wheels
def tyre_wheel():
    """KI-80 13.00x18 tyre on steel rim, outward = +X, hub at origin: chunky directional lugs wrapping the
    shoulders, domed hub with the central tyre-inflation valve and hose."""
    segs = 40
    prof = [(0.235, -0.125), (0.30, -0.152), (0.39, -0.166), (0.46, -0.162), (0.505, -0.15), (0.53, -0.13),
            (0.543, -0.095), (0.548, -0.04), (0.549, 0.0), (0.548, 0.04), (0.543, 0.095), (0.53, 0.13),
            (0.505, 0.15), (0.46, 0.162), (0.39, 0.166), (0.30, 0.152), (0.235, 0.125)]
    prof = [(r, h, 'tyre') for r, h in prof]
    tyre = lathe(prof, segs, 'x', mat='tyre', cap=False)
    for s in (-1, 1):
        rib = lathe([(0.33, s * 0.158, 'tyre'), (0.335, s * 0.17, 'tyre'), (0.345, s * 0.17, 'tyre'), (0.35, s * 0.16, 'tyre')], segs, 'x', mat='tyre', cap=False)
        tyre.add(rib)
    n = 18
    R = 0.548
    def lug(theta, side):
        # (t along circumference, h axial from centre) footprint; lug wraps over the shoulder
        L_ = [(-0.035, 0.018), (0.03, 0.018), (0.085, 0.172), (0.02, 0.172)]
        bm = bmesh.new()
        top, bot = [], []
        for t, hh in L_:
            for d, lst in ((-0.004, bot), (0.046, top)):
                tt = t * (0.86 if d > 0 else 1.0)
                a = theta + tt / R
                k = hh / 0.172
                rr = R + d - 0.052 * k ** 3 - (0.012 * k if d > 0 else 0)  # follow crown + shoulder roll-off
                lst.append(bm.verts.new((side * hh, rr * math.cos(a), rr * math.sin(a))))
        bm.faces.new(bot[::-1]); bm.faces.new(top)
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((bot[i], bot[j], top[j], top[i]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        return B(bm, 'tyre')
    lugs = B(mat='tyre')
    for i in range(n):
        th = math.tau * i / n
        lugs.add(lug(th, 1))
        lugs.add(lug(th + math.tau / n / 2, -1))
    lugs.bevel(0.006, 1, 30)
    tyre.add(lugs)
    # centre tread blocks between the chevrons
    for i in range(n):
        th = math.tau * (i + 0.25) / n
        blk = box(0.05, 0.05, 0.026, mat='tyre', bev=0.005, segs=1)
        blk.xf(Matrix.Rotation(th - math.pi / 2, 4, 'X'))
        tyre.add(blk, Matrix.Translation((0, (R + 0.008) * math.cos(th), (R + 0.008) * math.sin(th))))
    # rim: bead seat, flange, disc, domed hub
    rim = lathe([(0.25, 0.125, 'rim'), (0.236, 0.118, 'rim'), (0.228, 0.10, 'rim'), (0.225, 0.05, 'rim'), (0.205, 0.045, 'rim'),
                 (0.19, 0.07, 'rim'), (0.165, 0.09, 'rim'), (0.15, 0.10, 'rim'), (0.13, 0.13, 'rim'), (0.11, 0.155, 'rim'),
                 (0.08, 0.175, 'rim'), (0.045, 0.188, 'rim'), (0.0, 0.192, 'rim')], 32, 'x', mat='rim', cap=False)
    rim.add(lathe([(0.25, -0.125, 'rim'), (0.236, -0.118, 'rim'), (0.228, -0.10, 'rim'), (0.225, -0.03, 'rim'), (0.0, -0.03, 'rim')], 32, 'x', mat='rim', cap=False))
    rim.add(cyl(0.1, 0.16, 16, 'x', c=(-0.105, 0, 0), mat='gunmetal'))      # hub / wheel-reduction housing (vehicles_v5: the wheel floated 2.8 cm off the hull)
    for i in range(10):
        a = math.tau * i / 10
        rim.add(bolt(0.017, 0.024, 6, 'rim').rot('Y', 90), Matrix.Translation((0.088, 0.172 * math.cos(a), 0.172 * math.sin(a))))
    # central tyre-inflation valve on the dome + hose to the rim edge + guard lugs
    rim.add(lathe([(0, 0.0), (0.035, 0.0), (0.035, 0.035), (0.025, 0.05), (0, 0.055)], 12, 'x', mat='bare', c=(0.185, 0, 0)))
    rim.add(tube(fillet_path([(0.2, 0, 0.02), (0.205, 0, 0.06), (0.15, 0, 0.13), (0.1, 0, 0.2), (0.095, 0, 0.225)], 0.03, 4), 0.012, 6, 'bare'))
    for a in range(5):
        ang = a * math.tau / 5 + 0.3
        rim.add(box(0.03, 0.03, 0.05).rot('X', math.degrees(ang)), Matrix.Translation((0.145, 0.12 * math.cos(ang), 0.12 * math.sin(ang))))
    if not IS80:
        # models_v18 (BTR-82A, L11 / R60): wheel-reduction hub cap reads as a big ribbed dome - 8 radial ribs on the dome,
        # a raised ring round the bolt circle and drain plugs on the rim disc (BTR-80 UA wheel unchanged)
        bv = L.bvh_of(rim)
        for i in range(8):
            a = math.tau * (i + 0.5) / 8
            rb = box(0.022, 0.012, 0.075)
            rb.rot('X', math.degrees(a) - 90)
            rim.add(L.snap(rb.move(0.25, 0.10 * math.cos(a), 0.10 * math.sin(a)), None, d=(-1, 0, 0), max_d=0.2, sink=0.008, bvh=bv))
        rim.add(lathe([(0.205, 0.05, 'rim'), (0.215, 0.062, 'rim'), (0.215, 0.075, 'rim'), (0.2, 0.08, 'rim')], 32, 'x', mat='rim', cap=False))
        for i in range(3):
            a = math.tau * i / 3 + 0.5
            rim.add(L.snap(cyl(0.018, 0.02, 8, 'x', mat='gunmetal').move(0.2, 0.21 * math.cos(a), 0.21 * math.sin(a)), None, d=(-1, 0, 0), max_d=0.2, sink=0.005, bvh=bv))
    tyre.add(rim)
    return tyre

# =============================================================================================== turrets
def turret_bpu1():
    """BTR-80 BPU-1: small welded truncated-cone turret, KPVT + coax PKT through a front slot, 1PZ-2 sight,
    3 + 3 902V launchers on the rear.  Local origin = ring centre on the hull roof."""
    t = B()
    pts = []
    nseg = 16
    for i in range(nseg):
        a = math.tau * (i + 0.5) / nseg
        pts.append((0.70 * math.cos(a), 0.70 * math.sin(a), 0.03))
        pts.append((0.50 * math.cos(a), 0.50 * math.sin(a), 0.36))
    body = hull(pts, bev=0.012, segs=1, angle=25)
    t.add(body)
    t.add(lathe([(0.0, 0.36), (0.5, 0.36), (0.49, 0.375), (0.40, 0.395), (0.0, 0.40)], 32, 'z'))   # roof
    t.add(lathe([(0.74, 0.0), (0.77, 0.0), (0.77, 0.035), (0.70, 0.05)], 40, 'z', cap=False))   # ring guard
    # frontal gun housing: vertical slot face with cheeks
    emb = hull([(-0.30, 0.36, 0.04), (0.30, 0.36, 0.04), (-0.30, 0.36, 0.37), (0.30, 0.36, 0.37),
                (-0.25, 0.70, 0.05), (0.25, 0.70, 0.05), (-0.23, 0.62, 0.36), (0.23, 0.62, 0.36)], bev=0.014, segs=2)
    t.add(emb)
    t.add(box(0.30, 0.03, 0.27, c=(0.01, 0.685, 0.21), mat='gunmetal'))       # slot (dark)
    for x in (-0.17, 0.19):
        t.add(box(0.03, 0.05, 0.29, c=(x, 0.685, 0.205), bev=0.006, segs=1))   # slot guides
    # 1PZ-2 sight head (front left of the roof) with hood
    sx, sy = -0.26, 0.20
    sh = lathe([(0, 0), (0.1, 0), (0.1, 0.06), (0.085, 0.09), (0.0, 0.09)], 16, 'z', c=(sx, sy, 0.39))
    sh.add(box(0.14, 0.12, 0.12, c=(sx, sy + 0.04, 0.53), bev=0.015, segs=2))
    sh.add(box(0.1, 0.01, 0.06, c=(sx, sy + 0.103, 0.53), mat='glass'))
    sh.add(box(0.17, 0.12, 0.014, c=(sx, sy + 0.08, 0.6), bev=0.004, segs=1))
    sh.add(box(0.03, 0.1, 0.07, c=(sx - 0.075, sy + 0.08, 0.565)))
    sh.add(box(0.03, 0.1, 0.07, c=(sx + 0.075, sy + 0.08, 0.565)))
    t.add(sh)
    # TNPO periscopes around the cone top, looking outward
    bv = L.bvh_of(t)
    for ang in (35, 145, 215, 325):
        a = math.radians(ang + 90)
        loc, nn = L.drop_on(bv, 0.42 * math.cos(a), 0.42 * math.sin(a))
        if loc is None:
            continue
        M = Matrix.Translation(loc - V((0, 0, 0.01))) @ Matrix.Rotation(a - math.pi / 2, 4, 'Z')
        t.add(periscope_block(0.13, 0.08, 0.06), M)
    # armoured fan cover at the rear of the roof
    t.add(lathe([(0, 0.07), (0.08, 0.065), (0.11, 0.04), (0.11, 0.0)], 16, 'z', c=(0.12, -0.26, 0.39)))
    # 902V Tucha: two groups of 3 tubes on brackets on the rear wall, firing forward-up over the turret
    for s_ in (1, -1):
        for i in range(3):
            a = math.radians(270 + s_ * (24 + i * 14))
            p = V((0.71 * math.cos(a), 0.71 * math.sin(a), 0.2))
            d = V((s_ * (0.12 + 0.1 * i), 1.0, 1.25))
            t.add(tucha_tube(), Matrix.Translation(p) @ align_y(d))
            br = box(0.12, 0.05, 0.16, c=(0, 0, 0), bev=0.006, segs=1)
            t.add(br, Matrix.Translation(V((0.68 * math.cos(a), 0.68 * math.sin(a), 0.12))) @ Matrix.Rotation(a + math.pi / 2, 4, 'Z'))
        a0, a1 = math.radians(270 + s_ * 20), math.radians(270 + s_ * 56)
        t.add(tube([(0.7 * math.cos(a0), 0.7 * math.sin(a0), 0.06), (0.7 * math.cos((a0 + a1) / 2), 0.7 * math.sin((a0 + a1) / 2), 0.06),
                    (0.7 * math.cos(a1), 0.7 * math.sin(a1), 0.06)], 0.02, 6))
    # roof bolts
    for i in range(14):
        a = math.tau * i / 14
        t.add(bolt(0.011, 0.009), Matrix.Translation((0.44 * math.cos(a), 0.44 * math.sin(a), 0.37)))
    return t

def gun_bpu1():
    """KPVT 14.5 mm + coax PKT on a common cradle with a curved mantlet shield.  Origin = trunnion."""
    g = B()
    g.add(cyl(0.16, 0.36, 22, 'x', c=(0.01, 0.0, 0.0)))                     # cylindrical mantlet
    g.add(box(0.34, 0.12, 0.12, c=(0.01, 0.1, 0.0), bev=0.02, segs=2))      # gun shield block
    kx = -0.05
    # KPVT: barrel casing, barrel, perforated muzzle brake
    g.add(lathe([(0, 0.1), (0.058, 0.1), (0.058, 0.58), (0.05, 0.62), (0.03, 0.64), (0, 0.64)], 16, 'y', mat='gunmetal', c=(kx, 0, 0)))
    for i in range(4):
        g.add(cyl(0.062, 0.022, 16, 'y', c=(kx, 0.2 + i * 0.11, 0), mat='gunmetal'))
    g.add(cyl(0.021, 0.95, 12, 'y', c=(kx, 1.1, 0), mat='gunmetal'))
    g.add(cyl(0.026, 0.06, 12, 'y', c=(kx, 1.6, 0), mat='gunmetal'))
    for i in range(5):            # alternating rings = slotted/perforated flash hider at range
        g.add(cyl(0.034 if i % 2 == 0 else 0.026, 0.03, 12, 'y', c=(kx, 1.645 + i * 0.03, 0), mat='gunmetal'))
    # PKT coax to the right
    px = 0.13
    g.add(cyl(0.032, 0.2, 10, 'y', c=(px, 0.18, -0.02), mat='gunmetal'))
    g.add(cyl(0.011, 0.36, 8, 'y', c=(px, 0.46, -0.02), mat='gunmetal'))
    g.add(cyl(0.017, 0.05, 8, 'y', c=(px, 0.66, -0.02), mat='gunmetal'))
    return g, (kx, 1.78, 0.0), (px, 0.69, -0.02)

GUN_Y, GUN_Z = -0.18, 0.56     # trunnion (turret local; models_v16 height, -6 deg clears the front block - see TURRET_SPEC.md)
# models_v17 BPPU, rebuilt from photos (previews/models_v17/TURRET_SPEC.md) - turret local, z up from the ring plane
SK_R0, SK_R1, SK_Z = 0.76, 0.50, 0.21       # skirt: ring radius, top radius, top height (v16 dome: r 0.86, top 0.40)
SK_FY = (0.67, 0.95)                        # skirt front facet: y at z 0, dy per dz
SK_TOP = (0.66, 0.50, 0.74)                 # lower body top outline: half width, front, rear
FB_Z, FB_Y = 0.40, 0.445                    # front-left box: top height, top front edge y
FB_XI, FB_XO = -0.15, -0.45                 # its inner / outer x
LH_X = (-0.38, -0.68)                       # left housing: inner / outer x (outer face outside the lower body)
LH_K = 1.10                                 # left housing front edge: z = -LH_K * (y - LH_Y0)
LH_Y0 = 0.0
LH_TOP = (-0.60, -0.74, 0.665)              # top front y, top rear y, top z
LH_REAR = -0.80                             # rear face bottom y
RB_X = (0.36, 0.62)                         # right box (PKTM + sight box) x range
RB_Y = (-0.85, -0.245)                      # its y range (back, front face)
RB_Z = (0.235, 0.59)                        # its bottom / top
RX_Y, RX_Z = (-0.74, -1.06), 0.665          # rear box: front / back y, top z (L11: -0.76 .. -1.05, top 0.67-0.69)
RX_X = (-0.30, 0.32)
RX_BOT = (0.33, 0.20)                       # rear box bottom z at its front / back (hangs lower at the back)
PK_X = 0.49                                 # PKTM axis x (in the right box)

def lh_front_y(z):
    """y of the left housing's sloped front edge at height z."""
    return LH_Y0 - z / LH_K

def turret_bppu():
    """BTR-82A BPPU, models_v17 rebuild from photos (TURRET_SPEC.md):
      - a LOW skirt (truncated cone r 0.76 -> 0.645, 0.20 high) with a flat front facet, on the hull ring,
      - a raised FRONT BLOCK (top 0.40) across the front carrying the gun mount, the two 902V groups and two framed vision
        blocks on its top front edge, with side-looking framed vision blocks low on both sides behind it,
      - the external 2A72 mount on the centre line (cradle cheeks; mantlet / barrel / PKTM = gun_2a72()),
      - LEFT HOUSING: a big faceted block whose front edge rises at ~48 deg from the deck to 0.655, short flat top, near
        vertical rear face; flat outer face with the large access door; lower facets falling to the skirt; lifting eye and a
        red-lens lamp at its rear top,
      - RIGHT BOX: the PKTM / sight box (prow front, ridged top, round boss on the outer face) on a round pedestal,
      - SIGHT HEAD (TKN-4GA-02) on a short stalk over the receiver behind the trunnion, curved shield plate left of the gun,
      - REAR BOX hanging out behind the base at the housing-top height (bottom sloping down to the rear) with the hinged
        top lid (gunner's hatch) and two small boxes, hand rails down to the skirt on both sides, wind-sensor mast.
    Origin = ring centre on the hull roof; turret local z up, y forward, x right."""
    t = B()
    # ---- lower body: from the ring circle (r 0.76) up to a rounded-rectangle top deck at z 0.21 (front edge y 0.46, sides
    # x +-0.66, rear y -0.72; rounded front corners read as a cone in the front / 3/4 photos), flat front facet
    pts = [(0, 0, -0.03)]
    for k in range(24):
        a = math.tau * k / 24 + math.pi / 24
        for (r, z) in ((SK_R0 - 0.02, -0.03), (SK_R0, 0.0)):
            pts.append((r * math.cos(a), min(r * math.sin(a), SK_FY[0]), z))
    for k in range(40):                                                    # top outline: superellipse, exponent 3
        a = math.tau * k / 40
        c, s_ = math.cos(a), math.sin(a)
        ry = SK_TOP[1] if s_ > 0 else SK_TOP[2]
        e = 3.0
        rr = (abs(c / SK_TOP[0]) ** e + abs(s_ / ry) ** e) ** (-1 / e)
        pts.append((rr * c, min(rr * s_, SK_FY[0] - SK_FY[1] * SK_Z), SK_Z))
    t.add(hull(pts, bev=0.008, segs=1, angle=12))
    t.add(lathe([(SK_R0 + 0.01, -0.03), (SK_R0 + 0.03, -0.03), (SK_R0 + 0.03, 0.015), (SK_R0 - 0.01, 0.025)], 40, 'z', cap=False))   # ring guard lip
    fy0 = SK_FY[0]
    for (x, z) in ((-0.24, 0.05), (0.24, 0.05), (-0.27, 0.15), (0.27, 0.15)):                     # bolts on the front facet
        t.add(bolt(0.013, 0.01), Matrix.Translation((x, fy0 - SK_FY[1] * z + 0.004, z)) @ Matrix.Rotation(math.atan2(1, SK_FY[1]) - math.pi / 2, 4, 'X') @ Matrix.Rotation(-math.pi / 2, 4, 'X'))
    # ---- front-left box (in front of the left housing, carries the left 902V group) and the right launcher wedge
    fb = []
    for xx in (FB_XI, FB_XO):
        fb += [(xx, FB_Y + 0.03, SK_Z - 0.03), (xx, FB_Y, FB_Z), (xx, 0.22, FB_Z), (xx, 0.10, SK_Z + 0.02), (xx, 0.10, SK_Z - 0.03)]
    t.add(hull(fb, bev=0.010, segs=1, angle=15))
    t.add(weld_line([(FB_XI - 0.02, FB_Y - 0.004, FB_Z - 0.002), (FB_XO + 0.02, FB_Y - 0.004, FB_Z - 0.002)], 0.006))
    rw = []
    for xx in (0.13, 0.40):
        rw += [(xx, 0.45, SK_Z - 0.03), (xx, 0.42, SK_Z + 0.05), (xx, -0.02, 0.33), (xx, -0.14, 0.33), (xx, -0.14, SK_Z - 0.03)]
    t.add(hull(rw, bev=0.010, segs=1, angle=15))
    # ---- gun mount cradle cheeks (mantlet / barrel / PKTM: gun_2a72 on gun_pivot)
    ty_, tz_ = GUN_Y, GUN_Z
    for sx in (-1, 1):
        cp = []
        for xx in (sx * 0.150, sx * 0.205):
            cp += [(xx, 0.16, SK_Z), (xx, 0.08, 0.46), (xx, ty_ + 0.10, tz_ + 0.06), (xx, ty_ - 0.08, tz_ + 0.10),
                   (xx, -0.42, tz_ + 0.04), (xx, -0.42, SK_Z), (xx, 0.0, SK_Z)]
        t.add(hull(cp, bev=0.008, segs=1))
        t.add(cyl(0.05, 0.012, 14, 'x', c=(sx * 0.211, ty_, tz_)))                                   # trunnion cap
        for (yy, zz) in ((ty_ - 0.06, tz_ - 0.07), (ty_ + 0.06, tz_ - 0.07), (ty_, tz_ + 0.07)):
            t.add(bolt(0.010, 0.008), Matrix.Translation((sx * 0.218, yy, zz)) @ Matrix.Rotation(sx * math.pi / 2, 4, 'Y'))
    # receiver housing behind the mantlet, into the rear box
    t.add(hull([(x, y, z) for x in (-0.15, 0.15) for (y, z) in ((-0.30, SK_Z), (-0.30, tz_ - 0.03), (-0.40, 0.60), (RX_Y[0] - 0.02, 0.60), (RX_Y[0] - 0.02, SK_Z))],
               bev=0.010, segs=1))
    # ---- left housing
    yi, yo = LH_X
    lt_f, lt_r, lt_z = LH_TOP
    lh = []
    for xx in (yi, yo):
        lh += [(xx, lh_front_y(SK_Z), SK_Z), (xx, lt_f, lt_z), (xx, lt_r, lt_z), (xx, LH_REAR + 0.03, 0.30)]
    lh += [(yi, LH_REAR + 0.02, SK_Z), (yi, -0.30, SK_Z)]
    lh += [(yo + 0.01, lh_front_y(0.04), 0.04), (yi, lh_front_y(0.04), 0.04), (yo + 0.02, LH_REAR + 0.06, 0.04), (yi, LH_REAR + 0.06, 0.04)]   # outer face down to the ring (L11, A128)
    t.add(hull(lh, bev=0.012, segs=1, angle=12))
    t.add(weld_line([(yo + 0.004, lt_f + 0.01, lt_z - 0.004), (yi - 0.004, lt_f + 0.01, lt_z - 0.004)], 0.006))
    # access door on the outer face (parallel to the front edge), latch lugs at its front edge, hinge at the rear
    d0, d1, dz0, dz1 = 0.07, -0.72, 0.29, 0.585
    door = [(lh_front_y(dz0) - d0, dz0), (d1, dz0), (d1, dz1), (lh_front_y(dz1) - d0, dz1)]
    Md = Matrix(((0, 0, -1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1)))                       # local (y, z, out) -> (-x, ...)
    t.add(prism(door, 0.012, 'z', c=0.006, bev=0.004, segs=1).xf(Md).move(yo, 0, 0))
    for zz in (0.36, 0.52):
        yy = lh_front_y(zz) - d0 - 0.005
        t.add(box(0.03, 0.06, 0.035, c=(yo - 0.02, yy, zz), bev=0.005, segs=1))
        t.add(cyl(0.011, 0.07, 6, 'y', c=(yo - 0.035, yy + 0.02, zz)))
    t.add(cyl(0.016, 0.20, 8, 'z', c=(yo - 0.018, d1 - 0.015, 0.44)))                                 # door hinge
    t.add(bolt(0.012, 0.01), Matrix.Translation((yo - 0.001, -0.40, 0.22)) @ Matrix.Rotation(-math.pi / 2, 4, 'Y'))
    # lifting eye on the top rear, red-lens lamp on the rear top corner (looking left)
    eye = prism([(-0.05, 0.0), (0.05, 0.0), (0.04, 0.07), (0.0, 0.09), (-0.04, 0.07)], 0.02, 'z', c=0.0, bev=0.004, segs=1)
    eye.add(cyl(0.022, 0.03, 10, 'z', c=(0, 0.055, 0), mat='gunmetal'))
    t.add(eye.xf(Matrix.Rotation(math.pi / 2, 4, 'X') @ Matrix.Rotation(math.pi / 2, 4, 'Z')).move(-0.42, lt_r + 0.02, lt_z))
    lamp = cyl(0.062, 0.09, 14, 'x', c=(0, 0, 0))
    lamp.add(cyl(0.066, 0.015, 14, 'x', c=(-0.05, 0, 0)))
    for zz in (-0.022, 0.022):
        lamp.add(box(0.006, 0.075, 0.03, c=(-0.058, 0, zz), mat='glass'))
    lamp.add(box(0.06, 0.04, 0.10, c=(0.06, 0, -0.03), bev=0.006, segs=1))
    t.add(lamp.move(yo - 0.06, lt_r - 0.02, 0.52))
    # ---- side-looking framed vision blocks low on both sides behind the front block ('viewing ports'), front blocks
    for sx in (-1, 1):
        vb = box(0.07, 0.15, 0.10, c=(0, 0, 0.05), bev=0.008, segs=1)
        vb.add(box(0.012, 0.11, 0.06, c=(sx * 0.036, 0, 0.055), mat='glass'))
        vb.add(box(0.02, 0.16, 0.014, c=(sx * 0.04, 0, 0.105)))                                         # frame top / brow
        vb.add(box(0.02, 0.014, 0.10, c=(sx * 0.04, 0.072, 0.05)))
        vb.add(box(0.02, 0.014, 0.10, c=(sx * 0.04, -0.072, 0.05)))
        t.add(vb.move(sx * (0.47 if sx < 0 else 0.43), 0.17 if sx < 0 else 0.06, SK_Z - 0.02))
    for (x, y_, ang) in ((0.20, 0.42, 0.0), (-0.50, 0.33, 30.0)):
        fv = box(0.14, 0.07, 0.085, c=(0, 0, 0.0425), bev=0.008, segs=1)
        fv.add(box(0.11, 0.012, 0.05, c=(0, 0.036, 0.045), mat='glass'))
        fv.add(box(0.15, 0.05, 0.012, c=(0, 0.03, 0.09)))
        for xx in (-0.06, 0.06):
            fv.add(box(0.012, 0.012, 0.085, c=(xx, 0.04, 0.0425)))
        t.add(fv.rot('Z', ang).move(x, y_, SK_Z - 0.01))
    # ---- 902V Tucha: 3 + 3 tubes on brackets on the front block, either side of the gun, forward-up; per group one outer
    # tube at mid height and two inner tubes stacked
    for s_ in (1, -1):
        base = V((0.255, -0.04, 0.31)) if s_ > 0 else V((-0.29, -0.15, 0.30))   # L11: left tube mouths y 0.02 z 0.55
        br = hull([(-0.10, -0.12, 0), (0.10, -0.12, 0), (-0.10, 0.10, 0), (0.10, 0.10, 0),
                   (-0.09, -0.11, 0.10), (0.09, -0.11, 0.10), (-0.09, 0.0, 0.07), (0.09, 0.0, 0.07)], bev=0.008, segs=1)
        d = V((s_ * 0.12, 1.0, 1.05))
        for (dx, dz, dy) in ((s_ * 0.065, 0.12, -0.02), (-s_ * 0.05, 0.075, 0.03), (-s_ * 0.05, 0.175, -0.07)):
            q = V((dx, dy, dz))
            br.add(tucha_tube(), Matrix.Translation(q) @ align_y(d))
            br.add(box(0.035, 0.05, dz - 0.02, c=(dx, dy - 0.03, (dz - 0.02) / 2 + 0.03)))
        t.add(br.move(*base))
    # ---- right box (PKTM + sight box) on its pedestal
    x0, x1 = RB_X
    yb, yf = RB_Y
    zb, zt = RB_Z
    xm = (x0 + x1) / 2
    rb = hull([(x0, yb, zb), (x1 - 0.02, yb, zb), (x0, yf - 0.06, zb), (x1 - 0.02, yf - 0.06, zb),     # bottom
               (x0, yf + 0.025, 0.40), (x1, yf + 0.025, 0.40),                                          # prow edge
               (x0, yf, zt - 0.015), (x1 - 0.015, yf, zt - 0.015), (x0, yb + 0.02, zt - 0.015), (x1 - 0.015, yb + 0.02, zt - 0.015),
               (x1, yb, 0.40), (x1, yf - 0.10, 0.40),                                                   # outer face bulge
               (xm, yf - 0.02, zt + 0.02), (xm, yb + 0.04, zt + 0.02)],                                  # ridge
              bev=0.010, segs=1, angle=10)
    t.add(rb)
    t.add(cyl(0.065, 0.022, 16, 'x', c=(x1 + 0.006, (yb + yf) / 2 - 0.04, 0.42)))                     # round boss (outer face)
    t.add(cyl(0.045, 0.012, 16, 'x', c=(x1 + 0.02, (yb + yf) / 2 - 0.04, 0.42), mat='gunmetal'))
    for (yy, zz) in ((yb + 0.05, zt - 0.06), (yf - 0.10, zt - 0.06), (yb + 0.05, zb + 0.05)):
        t.add(bolt(0.011, 0.009), Matrix.Translation((x1 + 0.001, yy, zz)) @ Matrix.Rotation(math.pi / 2, 4, 'Y'))
    t.add(box(0.13, 0.02, 0.09, c=(PK_X, yf + 0.03, GUN_Z), bev=0.005, segs=1))                        # PKTM port frame
    t.add(hull([(x0 + 0.02, yb + 0.04, zb + 0.005), (x1 - 0.03, yb + 0.04, zb + 0.005), (x0 + 0.02, yf - 0.08, zb + 0.005), (x1 - 0.03, yf - 0.08, zb + 0.005),
               (0.30, -0.62, 0.03), (0.52, -0.52, 0.03), (0.30, -0.22, 0.03), (0.55, -0.22, 0.03)], bev=0.010, segs=1))   # support under the right box (R60)
    t.add(cyl(0.13, 0.06, 20, 'z', c=(xm - 0.02, -0.52, 0.215)))                                      # pedestal (traverse ring)
    t.add(cyl(0.145, 0.025, 20, 'z', c=(xm - 0.02, -0.52, 0.235)))
    t.add(rail([(x1 + 0.03, -0.70, 0.45), (x1 + 0.07, -0.70, 0.32), (x1 + 0.10, -0.55, 0.12), (0.66, -0.40, 0.09)], r=0.013, rad=0.05, foot=False))
    # ---- sight head (TKN-4GA-02) on its stalk behind the trunnion, curved shield plate left of the gun
    hx = -0.05
    t.add(cyl(0.045, 0.12, 12, 'z', c=(hx, -0.30, 0.63)))                                             # stalk
    hd = hull([(hx - 0.11, -0.31, 0.68), (hx + 0.11, -0.31, 0.68), (hx - 0.11, -0.08, 0.68), (hx + 0.11, -0.08, 0.68),
               (hx - 0.10, -0.30, 0.84), (hx + 0.10, -0.30, 0.84), (hx - 0.10, -0.10, 0.83), (hx + 0.10, -0.10, 0.83)], bev=0.012, segs=1)
    hd.add(box(0.15, 0.012, 0.08, c=(hx, -0.074, 0.755), mat='glass'))                                 # entrance window
    hd.add(box(0.21, 0.06, 0.014, c=(hx, -0.065, 0.84), bev=0.004, segs=1))                            # brow
    for sx in (-1, 1):
        hd.add(box(0.012, 0.05, 0.12, c=(hx + sx * 0.11, -0.08, 0.76)))                                # side cheeks of the window
        hd.add(bolt(0.010, 0.008), Matrix.Translation((hx + sx * 0.111, -0.25, 0.77)) @ Matrix.Rotation(sx * math.pi / 2, 4, 'Y'))
    hd.add(box(0.08, 0.10, 0.04, c=(hx + 0.04, -0.24, 0.86), bev=0.006, segs=1))                      # top cover
    t.add(hd)
    # pointed blade plate standing on the left 902V group, leaning forward like the tubes (L11 close-up, F09 / BM2 'fin')
    bl = prism([(0.0, 0.0), (0.07, 0.0), (0.24, 0.20), (0.27, 0.27), (0.20, 0.24), (0.0, 0.05)], 0.012, 'z', c=0.0, bev=0.003, segs=1)
    t.add(bl.xf(Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1)))).move(-0.19, -0.10, 0.44))
    # ---- rear box (hangs out behind the base), lid = gunner's hatch (hatch_lid_gunner, see btr_lids)
    xa, xb = RX_X
    yfr, ybk = RX_Y
    rx = hull([(x, y, z) for x in (xa, xb) for (y, z) in ((yfr, RX_BOT[0]), (ybk, RX_BOT[1]), (ybk, RX_Z - 0.02), (yfr, RX_Z))], bev=0.012, segs=1)
    t.add(rx)
    t.add(hull([(x, y, z) for x in (xa + 0.03, xb - 0.03) for (y, z) in ((yfr + 0.06, SK_Z), (yfr + 0.06, RX_BOT[0] + 0.02), (-0.95, 0.26), (-0.70, SK_Z - 0.05))], bev=0.01, segs=1))   # neck onto the skirt
    for x in (xa - 0.001, xb + 0.001):
        sgn = -1 if x < 0 else 1
        for (yy, zz) in ((yfr - 0.04, RX_Z - 0.05), (ybk + 0.04, RX_Z - 0.06), (ybk + 0.04, RX_BOT[1] + 0.05), (yfr - 0.04, RX_BOT[0] + 0.04)):
            t.add(bolt(0.012, 0.009), Matrix.Translation((x, yy, zz)) @ Matrix.Rotation(sgn * math.pi / 2, 4, 'Y'))
    for x in (xa + 0.06, xb - 0.06):                                                                   # small boxes on the rear corners
        t.add(box(0.10, 0.10, 0.08, c=(x, ybk + 0.07, RX_Z + 0.035), bev=0.008, segs=1))
    t.add(box(0.30, 0.025, 0.06, c=(0.03, ybk - 0.012, RX_Z - 0.10), bev=0.005, segs=1))              # rear stiffener strip
    gx, gy, gz, gw, gl = GUNNER_HATCH
    t.add(L.rect_coaming(gw, gl, rad=0.04).move(gx, gy, gz))
    return t

def gun_2a72():
    """2A72 30 mm on the rotating mantlet + the PKTM in its armoured sleeve in the right box (it elevates with the cannon -
    BMP-1AM / BTR-82A photos show both barrels parallel).  Muzzle ~2.2 m ahead of the trunnion (v15 calibrated photos).
    Origin = trunnion."""
    g = B()
    gx = -0.02
    g.add(cyl(0.115, 0.30, 20, 'x', c=(0.0, 0.0, 0.0)))                                    # mantlet drum
    g.add(hull([(-0.13, 0.04, -0.085), (0.13, 0.04, -0.085), (-0.13, 0.04, 0.085), (0.13, 0.04, 0.085),
                (-0.10, 0.19, -0.065), (0.10, 0.19, -0.065), (-0.10, 0.19, 0.065), (0.10, 0.19, 0.065)], bev=0.012, segs=1))   # front armour
    g.add(lathe([(0.0, 0.0), (0.058, 0.0), (0.058, 0.05), (0.052, 0.07), (0.052, 0.50), (0.06, 0.51), (0.06, 0.55), (0.046, 0.57), (0.0, 0.57)],
                18, 'y', mat='rolled', c=(gx, 0.17, 0.0)))                                 # recoil sleeve + end ring
    g.add(cyl(0.055, 0.02, 18, 'y', c=(gx, 0.36, 0.0)))
    g.add(cyl(0.024, 1.46, 14, 'y', c=(gx, 1.44, 0.0), mat='gunmetal'))                   # barrel
    g.add(lathe([(0.0, 0.0), (0.03, 0.0), (0.038, 0.02), (0.038, 0.09), (0.03, 0.11), (0.0, 0.11)], 14, 'y', mat='gunmetal', c=(gx, 1.20, 0.0)))   # mid collar
    g.add(lathe([(0.0, 0.0), (0.03, 0.0), (0.037, 0.015), (0.037, 0.12), (0.033, 0.14), (0.0, 0.14)], 14, 'y', mat='gunmetal', c=(gx, 2.06, 0.0)))  # muzzle device
    # PKTM: sleeve out of the right box front face, jacket, barrel, flash hider
    px = PK_X
    g.add(hull([(px - 0.05, -0.08, -0.04), (px + 0.05, -0.08, -0.04), (px - 0.05, -0.08, 0.04), (px + 0.05, -0.08, 0.04),
                (px - 0.04, 0.02, -0.03), (px + 0.04, 0.02, -0.03), (px - 0.04, 0.02, 0.03), (px + 0.04, 0.02, 0.03)], bev=0.008, segs=1))
    g.add(cyl(0.026, 0.16, 12, 'y', c=(px, 0.10, 0.0), mat='gunmetal'))
    g.add(cyl(0.011, 0.14, 8, 'y', c=(px, 0.25, 0.0), mat='gunmetal'))
    g.add(cyl(0.016, 0.04, 8, 'y', c=(px, 0.33, 0.0), mat='gunmetal'))
    return g, (gx, 2.20, 0.0), (px, 0.35, 0.0)

# =============================================================================================== build
SEAT_SPECS = (     # models_v17: BTR-80 (UA) - its own narrow roof again (pre-v12 seats)
    [dict(x=s * 0.56, y=y, face=(s, 0), type='edge') for y in (-0.45, -1.25, -1.95) for s in (1, -1)] +
    [dict(x=s * 0.30, y=-2.85, face=(0, 1), type='deck') for s in (1, -1)])

# models_v11: BTR-82A roof is 2.08 m wide -> side riders sit 14 cm further out (legs over the edge as before)
SEAT_SPECS_82 = (
    [dict(x=s * 0.70, y=y, face=(s, 0), type='edge') for y in (-0.53, -1.25, -1.95) for s in (1, -1)] +   # models_v18: front pair -0.45 -> -0.53 (rear box sweep margin was -0.004)
    [dict(x=s * 0.30, y=-2.85, face=(0, 1), type='deck') for s in (1, -1)])

def btr_lids(variant, hullE, turE, tz):
    """Openable lids: driver / commander (front hinge, stand up ahead of the crew), troop hatches (rear hinge), BTR-82A
    gunner (BPPU roof, rear hinge).  The BPU-1 (BTR-80) turret has no roof hatch: its gunner leaves through the right
    troop hatch (hatch_lid_gunner / hatch_gunner there)."""
    is82 = variant == 'btr82a'
    lids = []
    for s, role in ((1, 'commander'), (-1, 'driver')):
        p, piv, ax = L.rect_lid(*HATCH_FRONT, hinge='y+')
        lids.append(VB.hatch_lid(role, p, piv, ax, hullE, Matrix.Translation((s * HATCH_X, HATCH_Y, ROOF)), open_deg=92))
        L.node_empty('hatch_' + role, hullE, (s * HATCH_X, HATCH_Y, ROOF + 0.05), 0.12)
    for s, tag in ((1, 'R'), (-1, 'L')):
        role = 'gunner' if (not is82 and s > 0) else 'cargo_' + tag
        p, piv, ax = L.rect_lid(*HATCH_TROOP, hinge='y-')
        lids.append(VB.hatch_lid(role, p, piv, ax, hullE, Matrix.Translation((s * 0.45, TROOP_Y, ROOF)), open_deg=100,
                                 role_tag=role, note='right troop hatch (BPU-1 turret has no roof hatch)' if role == 'gunner' else ''))
        L.node_empty('hatch_' + role, hullE, (s * 0.45, TROOP_Y, ROOF + 0.05), 0.12)
    if is82:
        gx, gy, gz, gw, gl = GUNNER_HATCH
        p, piv, ax = L.rect_lid(gw, gl, t=0.03, hinge='x-', rad=0.04)   # models_v16: rear deck, hinged on its left (outboard) edge
        lids.append(VB.hatch_lid('gunner', p, piv, ax, turE, Matrix.Translation((gx, TY + gy, tz + gz)), open_deg=100))
        L.node_empty('hatch_gunner', turE, (gx, TY + gy, tz + gz + 0.05), 0.12)
    return lids

def hull_btr82a(is82=True):
    """BTR-82A hull (models_v12-v16)."""
    H = hull_shell()
    shell_bvh = L.bvh_of(H)
    def hit(o, d):
        h = shell_bvh.ray_cast(V(o), V(d).normalized())
        return h[0], h[1]
    # ---- weld seams along main plate joints
    for s in (1, -1):
        H.add(weld_line([(s * (RF_X - 0.004), REAR_TOP + 0.08, ROOF - 0.004), (s * (RF_X - 0.004), SF_Y, ROOF - 0.004),
                         (s * (WSF_X - 0.01), WS_TOP[0] - 0.03, ROOF - 0.004)]))
    H.add(weld_line([(-WSF_X + 0.04, WS_TOP[0] - 0.01, ROOF - 0.003), (WSF_X - 0.04, WS_TOP[0] - 0.01, ROOF - 0.003)]))
    H.add(weld_line([(-NOSE_X + 0.04, NOSE[0] - 0.005, NOSE[1]), (NOSE_X - 0.04, NOSE[0] - 0.005, NOSE[1])]))
    H.add(weld_line([(-RF_X + 0.08, REAR_TOP - 0.01, ROOF - 0.03), (RF_X - 0.08, REAR_TOP - 0.01, ROOF - 0.03)]))
    H.add(weld_line([(-REAR_X + 0.03, REAR_LOW[0] + 0.01, REAR_LOW[1]), (REAR_X - 0.03, REAR_LOW[0] + 0.01, REAR_LOW[1])]))
    H.add(box(1.75, 0.02, 0.012, c=(0, -1.32, ROOF + 0.003)))       # engine deck plate seam

    # ---- crease: pronounced ledge along the widest line (and on along the cheek top edge to the bow) + rubber fender lips
    for s in (1, -1):
        H.add(box(0.09, CF_Y - CR_Y, 0.045, c=(s * (CH_X + 0.02), (CF_Y + CR_Y) / 2, CH_Z - 0.02), bev=0.008, segs=1))
        H.add(tube([(s * (CH_X + 0.02), CF_Y, CH_Z - 0.02), (s * (NOSE_X + 0.03), NOSE[0] - 0.06, NOSE[1] - 0.025)], 0.022, 6))
        for y in AXLES:
            mg = box(0.012, 0.9, 0.08, c=(0, 0, -0.04), mat='tyre', bev=0.004, segs=1)       # rubber fender lip
            mg.add(box(0.03, 0.92, 0.025, c=(0, 0, 0.0), mat='rolled'))
            for yy in (-0.3, 0.0, 0.3):
                mg.add(bolt(0.01, 0.008, 6, 'rolled').rot('Y', 90 * s), Matrix.Translation((s * 0.012, yy, -0.012)))
            xx = CH_X + 0.055
            H.add(mg.rot('Y', s * -8), Matrix.Translation((s * xx, y, CH_Z - 0.045)))
        # tubular V steps hanging under the ledge between wheels 1-2 and 3-4 (photos)
        for (ya, yb) in ((AXLES[0], AXLES[1]), (AXLES[2], AXLES[3])):
            ym = (ya + yb) / 2
            zb = 0.86
            xl = x_lower(zb) + 0.06
            H.add(tube([(s * (CH_X - 0.05), ym + 0.20, CH_Z - 0.04), (s * xl, ym, zb), (s * (CH_X - 0.05), ym - 0.20, CH_Z - 0.04)], 0.016, 6))
            H.add(box(0.05, 0.12, 0.02, c=(s * xl, ym, zb - 0.01)))

    # ---- front: windscreens + shutters, trim vane, round lamp clusters on the cheeks, headlight boxes, hooks
    H.add(windscreen(open_=not is82))
    Mv, tv, (gn, gu) = trim_vane()
    H.add(tv, Mv)
    for s in (1, -1):
        loc, nrm = hit((s * HL_X, 2.52, 3.0), (0, 0, -1))
        if loc is not None:
            ped = hull([(-0.16, -0.08, -0.12), (0.16, -0.08, -0.12), (-0.16, 0.08, -0.12), (0.16, 0.08, -0.12),
                        (-0.16, -0.08, 0.03), (0.16, -0.08, 0.03), (-0.16, 0.08, 0.03), (0.16, 0.08, 0.03)], bev=0.01, segs=1)
            H.add(ped, Matrix.Translation(loc))
            H.add(headlight_cluster(s), Matrix.Translation(loc + V((0, 0.10, -0.10))))   # lamps hang ahead of the bracket (photos: z ~1.5-1.75)
    lower_glacis_details(H, lamp_boxes=True)
    # ---- roof front: driver (left) + commander (right) hatches (lids = openable nodes, see btr_lids), vision blocks ahead
    for s in (1, -1):
        H.add(L.rect_coaming(*HATCH_FRONT).move(s * 0.42, HATCH_Y, ROOF))
        for i in range(2):
            M = Matrix.Translation((s * (0.26 + i * 0.3), WS_TOP[0] - 0.05, ROOF - 0.02)) @ Matrix.Rotation(math.radians(s * -14 * i), 4, 'Z')
            H.add(periscope_block(0.17, 0.1, 0.07), M)
        # cheek periscope looking forward-outward
        H.add(periscope_block(0.15, 0.09, 0.06), Matrix.Translation((s * (RF_X - 0.12), 1.95, ROOF - 0.015)) @ Matrix.Rotation(-s * 0.9, 4, 'Z'))
    # models_v15 (BTR-82A front / front-3/4 photos): searchlight on a post on the roof front right, ahead of the commander's hatch
    if is82:
        lp = V((0.42, 2.40, ROOF + 0.30))
        sl = lathe([(0, -0.09), (0.085, -0.09), (0.11, -0.04), (0.115, 0.05), (0.105, 0.065)], 20, 'y')
        sl.add(cyl(0.098, 0.006, 20, 'y', c=(0, 0.0685, 0), mat='light'))   # lights_v1: lens y 0.0655-0.0715, clear of the housing cap (y 0.065), was coplanar -> z-fight
        sl.add(lathe([(0.108, 0.06), (0.12, 0.07), (0.12, 0.085), (0.105, 0.085)], 20, 'y', cap=False))
        for a_ in range(4):
            ang = a_ * math.pi / 2 + math.pi / 4
            sl.add(box(0.012, 0.03, 0.012, c=(0.12 * math.cos(ang), 0.08, 0.12 * math.sin(ang))))
        sl.add(cyl(0.02, 0.27, 8, 'x', c=(0, -0.01, 0)))                                  # trunnion pins
        for sx in (-1, 1):
            sl.add(box(0.014, 0.05, 0.16, c=(sx * 0.135, -0.01, -0.07), bev=0.004, segs=1))   # fork
        sl.add(box(0.29, 0.05, 0.03, c=(0, -0.01, -0.15), bev=0.006, segs=1))
        H.add(sl.move(*lp))
        H.add(cyl(0.032, 0.17, 10, 'z', c=(lp.x, lp.y - 0.01, ROOF + 0.07)))               # post
        H.add(cyl(0.06, 0.03, 12, 'z', c=(lp.x, lp.y - 0.01, ROOF + 0.005)))               # base flange
        H.add(tube([(lp.x - 0.05, lp.y - 0.08, lp.z - 0.05), (lp.x - 0.06, lp.y - 0.10, ROOF + 0.10), (lp.x - 0.10, lp.y - 0.14, ROOF + 0.01)], 0.010, 6, 'bare'))
    # turret ring collar
    H.add(lathe([(0.75, 0), (0.81, 0), (0.81, 0.025), (0.77, 0.035)], 40, 'z', c=(0, TY, ROOF)))   # models_v17: BPPU base r 0.76 (was 0.80-0.85)
    # troop hatches behind the turret (lids = openable nodes)
    for s in (1, -1):
        H.add(L.rect_coaming(*HATCH_TROOP).move(s * 0.45, TROOP_Y, ROOF))
    # engine deck: two louvred grilles on raised frames, central access hatch, filler caps, antennas
    for s in (1, -1):
        H.add(box(0.70, 1.28, 0.04, c=(s * 0.52, -2.36, ROOF + 0.02), bev=0.01, segs=1))
        H.add(louvre_panel(0.56, 1.15, 11), Matrix.Translation((s * 0.52, -2.36, ROOF + 0.04)))
        H.add(lathe([(0, 0.04), (0.06, 0.04), (0.07, 0.02), (0.07, 0)], 16, 'z', c=(s * 0.25, -1.55, ROOF - 0.01)))
        H.add(antenna_base(), Matrix.Translation((s * 0.78, -3.30, ROOF)))
    H.add(hatch_rect(0.28, 1.12, t=0.03, c=(0, -2.36, ROOF), hinge='y+', rad=0.03))
    H.add(hatch_rect(0.9, 0.36, t=0.025, c=(0, -1.6, ROOF), hinge='y+', rad=0.03))

    # ---- sides
    for s in (1, -1):
        MU = plate_M(N_UP, s); ML = plate_M(N_LO, s)
        mir = (lambda b: b.scale(-1, 1, 1)) if s < 0 else (lambda b: b)   # keep local +x = forward on both sides
        # split side door between axles 2 and 3: upper part opens forward, lower part folds down as a step (narrower,
        # it sits in the gap between the tyres)
        up, _ = door(upper_h=0.52, lower_h=0.44, w=0.74)
        _, lo_ = door(upper_h=0.52, lower_h=0.44, w=0.58)
        cu = V((s * x_upper(CH_Z + 0.012), DOOR_Y, CH_Z + 0.012))
        H.add(mir(up), L.place(MU, cu))
        H.add(mir(lo_), L.place(ML, cu))
        # door frame strips (dark gaps read at distance)
        H.add(mir(box(0.8, 0.02, 0.012, c=(0, 0.535, 0.004), mat='gunmetal')), L.place(MU, cu))
        H.add(mir(box(0.64, 0.02, 0.012, c=(0, -0.455, 0.004), mat='gunmetal')), L.place(ML, cu))
        # firing ports (ball mounts + hinged armoured covers) with roof periscopes above
        for yy in (0.40, -1.00):
            fp = firing_port()
            fp.add(cyl(0.1, 0.022, 16, 'z', c=(0, 0.2, 0.012)))           # cover flap swung up
            fp.add(cyl(0.02, 0.12, 8, 'x', c=(0, 0.125, 0.02)))
            H.add(fp, L.place(MU, on_upper(yy, 1.6, 0.0, s)))
            H.add(periscope_block(0.16, 0.09, 0.06), Matrix.Translation((s * (RF_X - 0.07), yy, ROOF - 0.01)) @ Matrix.Rotation(-s * math.pi / 2, 4, 'Z'))
        # forward port inside the angled recess (transverse face at RECESS[0], looking forward)
        zr = 1.62
        xr = s * (x_upper(zr) - 0.12)
        fp = firing_port().scale(0.72)
        H.add(fp, L.place(L.frame_from_normal(V((0, 1, 0))), V((xr, RECESS[0] + 0.002, zr))))
        H.add(periscope_block(0.15, 0.09, 0.06), Matrix.Translation((s * (RF_X - 0.12), RECESS[0] + 0.12, ROOF - 0.01)) @ Matrix.Rotation(-s * 0.35, 4, 'Z'))
        # louvred exhaust silencer on the rear quarter
        H.add(mir(exhaust_muffler(s)), L.place(MU, on_upper(-2.72, CH_Z + 0.06, 0.0, s)))
        # tow cable behind the door, grab handles
        c0 = on_upper(-1.16, 1.63, 0.035, s); c1 = on_upper(-2.30, 1.63, 0.035, s)
        H.add(tow_cable(c0, c1, 0.0))
        for yy in (-0.85, -1.6):
            H.add(box(0.06, 0.05, 0.06), L.place(MU, on_upper(yy, 1.84, 0.02, s)))
        H.add(rail([on_upper(-0.62, 1.79, 0.0, s), on_upper(-0.62, 1.79, 0.06, s), on_upper(0.04, 1.79, 0.06, s), on_upper(0.04, 1.79, 0.0, s)], r=0.012, rad=0.03))
        # models_v18 (L11): second long grab rail along the roof edge over the forward firing ports, footholds under it
        H.add(rail([on_upper(0.30, 1.80, 0.0, s), on_upper(0.30, 1.80, 0.06, s), on_upper(1.10, 1.80, 0.06, s), on_upper(1.10, 1.80, 0.0, s)], r=0.012, rad=0.03))
        # side marker light at the front corner
        loc, nrm = hit((s * 2.5, 2.30, 1.42), (-s, 0, 0))
        if loc is not None:
            ml = cyl(0.04, 0.06, 10, 'z', c=(0, 0, 0.0))
            ml.add(cyl(0.032, 0.008, 10, 'z', c=(0, 0, 0.032), mat='light'))
            H.add(ml, L.place(L.frame_from_normal(nrm), loc))
        # rear mud flaps behind wheels 1 and 4
        for yy in (AXLES[0] - 0.7, AXLES[3] - 0.7):
            H.add(box(0.34, 0.012, 0.3, c=(s * 1.2, yy, 0.86), mat='skirt', bev=0.004, segs=1))
    # tools: shovel (right) + crowbar & axe (left) low on the upper side ahead of the door
    H.add(tool_shovel(), L.place(plate_M(N_UP, 1), on_upper(0.62, 1.37, 0.03, 1)))
    for yy in (0.3, 0.9):
        H.add(box(0.04, 0.06, 0.05), L.place(plate_M(N_UP, 1), on_upper(yy, 1.37, 0.02, 1)))
        H.add(box(0.04, 0.06, 0.05), L.place(plate_M(N_UP, -1), on_upper(yy, 1.37, 0.02, -1)))
    H.add(tube([on_upper(0.2, 1.38, 0.03, -1), on_upper(1.02, 1.38, 0.03, -1)], 0.015, 6, 'bare'))
    ax = box(0.6, 0.03, 0.03, mat='wood', bev=0.008, segs=1)
    ax.add(box(0.05, 0.14, 0.02, c=(0.3, 0.04, 0), mat='bare'))
    H.add(ax, L.place(plate_M(N_UP, -1), on_upper(0.6, 1.47, 0.03, -1)))

    # ---- rear: near-vertical upper plate (access hatch, tail lights, round covers, two raised side panels), inward-sloped
    # lower plate (water-jet flap, tow hooks, pintle)
    ru = V((0, REAR_TOP - REAR_LOW[0], ROOF - REAR_LOW[1])).normalized()
    rn = V((0, -ru.z, ru.y))
    MR = frame_nu(rn, ru)
    r0 = V((0, REAR_LOW[0], REAR_LOW[1]))
    rmid = r0 + ru * 0.46
    hp = box(0.52, 0.30, 0.03, c=(0, 0, 0.015), bev=0.008, segs=1)
    hp.add(rail([(-0.09, -0.08, 0.03), (-0.09, -0.08, 0.08), (0.09, -0.08, 0.08), (0.09, -0.08, 0.03)], r=0.01, rad=0.02))
    hp.add(cyl(0.025, 0.12, 10, 'x', c=(0, 0.16, 0.02)))
    H.add(hp, L.place(MR, rmid + ru * 0.08))
    for s in (1, -1):
        rl = box(0.20, 0.10, 0.08, c=(0, 0, 0.04), bev=0.01, segs=1)                 # tail light
        rl.add(box(0.15, 0.07, 0.012, c=(0, 0, 0.082), mat='light'))
        H.add(rl, L.place(MR, r0 + V((s * 0.80, 0, 0)) + ru * 0.62))
        H.add(lathe([(0, 0.03), (0.09, 0.03), (0.105, 0.015), (0.105, 0)], 16, 'z'), L.place(MR, r0 + V((s * 0.52, 0, 0)) + ru * 0.62))   # round cover
        sp = hull([(-0.30, -0.18, 0), (0.30, -0.18, 0), (-0.30, 0.18, 0), (0.30, 0.18, 0),
                   (-0.28, -0.16, 0.05), (0.28, -0.16, 0.05), (-0.28, 0.17, 0.045), (0.28, 0.17, 0.045)], bev=0.01, segs=1)
        for (hx, hy) in ((-0.15, 0.08), (0.12, 0.08), (0.0, -0.06)):
            sp.add(cyl(0.022, 0.01, 8, 'z', c=(hx, hy, 0.05), mat='gunmetal'))
        H.add(sp, L.place(MR, r0 + V((s * 0.62, 0, 0)) + ru * 0.22))
        H.add(L.snap(tow_hook().rot('Z', 180).rot('X', 20).move(s * 0.62, REAR_LOW[0] - 0.3, 1.0), H, d=(0, 1, 0), max_d=0.5, sink=0.01))
    lu = V((0, REAR_LOW[0] - REAR_LB[0], REAR_LOW[1] - REAR_LB[1])).normalized()
    ln_ = V((0, -lu.z, lu.y))
    if ln_.y > 0:
        ln_ = -ln_
    ML_ = frame_nu(ln_, lu)
    wjc = V((0, REAR_LB[0], REAR_LB[1])) + lu * 0.24
    wj = lathe([(0, 0.0), (0.2, 0.0), (0.22, 0.03), (0.21, 0.05), (0, 0.05)], 24, 'z')
    wj.add(box(0.5, 0.06, 0.04, c=(0, 0.2, 0.03), bev=0.008, segs=1))
    for x in (-0.15, 0.15):
        wj.add(cyl(0.025, 0.1, 10, 'x', c=(x, 0.24, 0.03)))
    H.add(wj, L.place(ML_, wjc))
    pin = box(0.12, 0.16, 0.08, c=(0, -3.98, 0.92), bev=0.01, segs=1)           # tow pintle housing
    pin.add(tube(fillet_path([(0, -4.02, 0.95), (0, -4.11, 0.95), (0, -4.11, 0.85)], 0.04, 3), 0.025, 8))
    H.add(L.snap(pin, H, d=(0, 1, 0), max_d=0.5, sink=0.01))

    if is82:
        # models_v13 (calibrated left-side photo + right-side photo): NO tarp roll / roof tube on the rear deck (they made the
        # stern read raised).  One long stowage tube per side lies along the roof edge on the upper side plate, its top only
        # ~5 cm over the roof: a wedge-shaped front cap, then a ribbed tube tapering toward the stern (r 0.135 -> 0.095).
        # It starts behind the last side riders (seats 5 / 6, y -1.95).
        y0, y1, ycap = -2.18, -3.64, 0.30
        r0, r1 = 0.135, 0.095
        zc = ROOF - 0.17
        for s in (1, -1):
            MU = plate_M(N_UP, s)
            pf = on_upper(y0 - ycap, zc, r0 + 0.012, s)          # tube front (behind the cap)
            pr = on_upper(y1, zc, r1 + 0.012, s)                 # stern end
            ax = pr - pf
            Lt = ax.length
            prof = [(0, 0.0), (r1 * 0.85, 0.0), (r1, 0.012)]
            nr = 11
            for k in range(nr + 1):
                t = Lt * k / nr
                r = r1 + (r0 - r1) * (t / Lt)
                if 0 < k < nr:
                    prof += [(r, t - 0.018), (r + 0.010, t - 0.010), (r + 0.010, t + 0.010), (r, t + 0.018)]
            prof += [(r0, Lt), (0, Lt)]
            tb = lathe(prof, 16, 'y')                             # local +Y from the stern end toward the front
            H.add(tb, Matrix.Translation(pr) @ align_y(-ax))
            # wedge cap (pyramid frustum, flat top) ahead of the tube
            cap = hull([(-r0, 0, -r0), (r0, 0, -r0), (-r0, 0, r0 * 0.95), (r0, 0, r0 * 0.95),
                        (-0.05, ycap, -0.04), (0.05, ycap, -0.04), (-0.07, ycap * 0.8, r0 * 0.75), (0.07, ycap * 0.8, r0 * 0.75)],
                       bev=0.008, segs=1)
            H.add(cap, Matrix.Translation(pf) @ align_y(-ax))
            # two strap brackets to the side plate
            for f in (0.22, 0.80):
                pc = pr + (pf - pr) * f
                rr = r1 + (r0 - r1) * f
                H.add(lathe([(rr + 0.002, -0.022), (rr + 0.009, -0.022), (rr + 0.009, 0.022), (rr + 0.002, 0.022)], 16, 'y',
                            mat='bare', cap=False), Matrix.Translation(pc) @ align_y(-ax))
                yy = pc.y
                H.add(box(0.06, 0.05, 0.12), L.place(MU, on_upper(yy, zc - 0.05, 0.03, s)))
    return H

def hull_btr80():
    """models_v17: BTR-80 (UA) hull = the pre-v12 model (git 2888b1d build()) with the shared bow: only the front section
    (welds, crease lip to the knee, vane fitted to the shorter vane plate, lamps on its top corners, lower-glacis details) changed."""
    H = hull_shell()
    shell_bvh = L.bvh_of(H)
    def hit(o, d):
        h = shell_bvh.ray_cast(V(o), V(d).normalized())
        return h[0], h[1]
    # ---- weld seams along main plate joints
    for s in (1, -1):
        H.add(weld_line([(s * (RF_X - 0.004), REAR_TOP + 0.05, ROOF - 0.004), (s * (RF_X - 0.03), WS_TOP[0] - 0.03, ROOF - 0.004)]))
    H.add(weld_line([(-0.86, WS_TOP[0] - 0.01, ROOF - 0.003), (0.86, WS_TOP[0] - 0.01, ROOF - 0.003)]))
    # models_v17: shared bow - break line (steep plate / vane plate) and knee welds, break width from the shell
    loc, _ = hit((2.5, WS_BOT[0] + 0.005, WS_BOT[1] - 0.004), (-1, 0, 0))
    xb = (loc.x if loc is not None else 1.02) - 0.03
    H.add(weld_line([(-xb, WS_BOT[0] + 0.005, WS_BOT[1] - 0.004), (xb, WS_BOT[0] + 0.005, WS_BOT[1] - 0.004)]))
    H.add(weld_line([(-NOSE_X + 0.04, NOSE[0] - 0.005, NOSE[1]), (NOSE_X - 0.04, NOSE[0] - 0.005, NOSE[1])]))
    H.add(weld_line([(-0.88, REAR_TOP - 0.01, ROOF - 0.004), (0.88, REAR_TOP - 0.01, ROOF - 0.004)]))
    H.add(weld_line([(-1.12, REAR_LOW[0] + 0.01, REAR_LOW[1]), (1.12, REAR_LOW[0] + 0.01, REAR_LOW[1])]))
    H.add(box(1.75, 0.02, 0.012, c=(0, -1.32, ROOF + 0.003)))       # engine deck plate seam

    # ---- crease: fender lip along the widest line + rubber mudguards over the wheels
    for s in (1, -1):
        H.add(box(0.075, CF_Y + 3.095, 0.022, c=(s * (CH_X + 0.02), (CF_Y - 3.095) / 2, CH_Z - 0.01), bev=0.006, segs=1))
        # models_v17: lip on along the lower cheek edge from the crease front to the knee (shared bow)
        H.add(tube([(s * (CH_X + 0.03), CF_Y - 0.05, CH_Z - 0.012), (s * (NOSE_X + 0.03), NOSE[0] - 0.06, NOSE[1] - 0.025)], 0.02, 6))
        for y in AXLES:
            mg = box(0.012, 0.9, 0.08, c=(0, 0, -0.04), mat='tyre', bev=0.004, segs=1)       # rubber fender lip
            mg.add(box(0.03, 0.92, 0.025, c=(0, 0, 0.0), mat='rolled'))
            for yy in (-0.3, 0.0, 0.3):
                mg.add(bolt(0.01, 0.008, 6, 'rolled').rot('Y', 90 * s), Matrix.Translation((s * 0.012, yy, -0.012)))
            xx = CH_X + 0.045
            H.add(mg.rot('Y', s * -8), Matrix.Translation((s * xx, y, CH_Z - 0.02)))

    # ---- front: windscreens + shutters, trim vane, headlights, hooks
    H.add(windscreen_80(open_=True))
    Mv, tv, (gn, gu) = trim_vane_80()
    H.add(tv, Mv)
    zl = (V((0, WS_BOT[0], WS_BOT[1])) - V((0, NOSE[0], NOSE[1]))).length
    for s in (1, -1):
        p = V((s * 0.84, NOSE[0], NOSE[1])) + gu * (zl - 0.10)        # models_v17: top corners of the (shorter) vane plate
        ped = hull([(-0.2, -0.06, -0.08), (0.2, -0.06, -0.08), (-0.2, 0.08, -0.08), (0.2, 0.08, -0.08),
                    (-0.2, -0.06, 0.03), (0.2, -0.06, 0.03), (-0.2, 0.08, 0.03), (0.2, 0.08, 0.03)])
        H.add(ped, Matrix.Translation(p))
        H.add(headlight_cluster(s), Matrix.Translation(p + V((0, 0, 0.03))))
    lower_glacis_details(H, lamp_boxes=False)                          # models_v17: shared bow (hooks, cover, lugs)
    # ---- roof front: driver (left) + commander (right) hatches (lids = openable nodes, see btr_lids), periscopes ahead
    for s in (1, -1):
        H.add(L.rect_coaming(*HATCH_FRONT).move(s * 0.45, 1.98, ROOF))
        for i in range(2):
            M = Matrix.Translation((s * (0.28 + i * 0.3), WS_TOP[0] - 0.04, ROOF - 0.02)) @ Matrix.Rotation(math.radians(s * -14 * i), 4, 'Z')
            H.add(periscope_block(0.17, 0.1, 0.07), M)
        # cheek periscope looking forward-outward
        H.add(periscope_block(0.15, 0.09, 0.06), Matrix.Translation((s * (RF_X - 0.1), 2.12, ROOF - 0.015)) @ Matrix.Rotation(-s * 0.9, 4, 'Z'))
    # turret ring collar
    H.add(lathe([(0.80, 0), (0.85, 0), (0.85, 0.03), (0.78, 0.045)], 40, 'z', c=(0, TY, ROOF)))
    # troop hatches behind the turret (lids = openable nodes)
    for s in (1, -1):
        H.add(L.rect_coaming(*HATCH_TROOP).move(s * 0.45, -0.40, ROOF))
    # engine deck: two louvred grilles, central access hatch, filler caps, antennas
    for s in (1, -1):
        H.add(louvre_panel(0.56, 1.15, 11), Matrix.Translation((s * 0.52, -2.36, ROOF)))
        H.add(lathe([(0, 0.04), (0.06, 0.04), (0.07, 0.02), (0.07, 0)], 16, 'z', c=(s * 0.25, -1.55, ROOF - 0.01)))
        H.add(antenna_base(), Matrix.Translation((s * 0.78, -3.12, ROOF)))
    H.add(hatch_rect(0.28, 1.12, t=0.03, c=(0, -2.36, ROOF), hinge='y+', rad=0.03))
    H.add(hatch_rect(0.9, 0.36, t=0.025, c=(0, -1.6, ROOF), hinge='y+', rad=0.03))

    # ---- sides
    for s in (1, -1):
        MU = plate_M(N_UP, s); ML = plate_M(N_LO, s)
        mir = (lambda b: b.scale(-1, 1, 1)) if s < 0 else (lambda b: b)   # keep local +x = forward on both sides
        up, lo = door(upper_h=0.52, lower_h=0.44, w=0.74)
        cu = V((s * x_upper(CH_Z + 0.012), DOOR_Y, CH_Z + 0.012))
        H.add(mir(up), L.place(MU, cu))
        H.add(mir(lo), L.place(ML, cu))
        # door frame strips (dark gaps read at distance)
        H.add(mir(box(0.8, 0.02, 0.012, c=(0, 0.535, 0.004), mat='gunmetal')), L.place(MU, cu))
        H.add(mir(box(0.8, 0.02, 0.012, c=(0, -0.455, 0.004), mat='gunmetal')), L.place(ML, cu))
        # firing ports (ball mounts + hinged armoured covers) with roof periscopes above
        for yy in (0.45, -0.95):
            fp = firing_port()
            fp.add(cyl(0.1, 0.022, 16, 'z', c=(0, 0.2, 0.012)))           # cover flap swung up
            fp.add(cyl(0.02, 0.12, 8, 'x', c=(0, 0.125, 0.02)))
            H.add(fp, L.place(MU, on_upper(yy, 1.6, 0.0, s)))
            H.add(periscope_block(0.16, 0.09, 0.06), Matrix.Translation((s * (RF_X - 0.07), yy, ROOF - 0.01)) @ Matrix.Rotation(-s * math.pi / 2, 4, 'Z'))
        # forward port inside the angled recess (transverse face at RECESS[0], looking forward)
        zr = 1.62
        xr = s * (x_upper(zr) - 0.12)
        fp = firing_port().scale(0.72)
        H.add(fp, L.place(L.frame_from_normal(V((0, 1, 0))), V((xr, RECESS[0] + 0.002, zr))))
        H.add(periscope_block(0.15, 0.09, 0.06), Matrix.Translation((s * (RF_X - 0.12), RECESS[0] + 0.12, ROOF - 0.01)) @ Matrix.Rotation(-s * 0.35, 4, 'Z'))
        # exhaust silencer on the rear quarter
        H.add(mir(exhaust_muffler(s)), L.place(MU, on_upper(-2.85, CH_Z + 0.06, 0.0, s)))
        # tow cable behind the door, grab handles
        c0 = on_upper(-0.72, 1.86, 0.035, s); c1 = on_upper(-2.42, 1.86, 0.035, s)
        H.add(tow_cable(c0, c1, 0.0))
        for yy in (-0.85, -1.6, -2.3):
            H.add(box(0.06, 0.05, 0.06), L.place(MU, on_upper(yy, 1.86, 0.02, s)))
        H.add(rail([on_upper(-0.52, 1.79, 0.0, s), on_upper(-0.52, 1.79, 0.06, s), on_upper(0.12, 1.79, 0.06, s), on_upper(0.12, 1.79, 0.0, s)], r=0.012, rad=0.03))
        # side marker light at the front corner
        loc, nrm = hit((s * 2.5, 2.42, 1.42), (-s, 0, 0))
        if loc is not None:
            ml = cyl(0.04, 0.06, 10, 'z', c=(0, 0, 0.0))
            ml.add(cyl(0.032, 0.008, 10, 'z', c=(0, 0, 0.032), mat='light'))
            H.add(ml, L.place(L.frame_from_normal(nrm), loc))
        # rear mud flaps behind wheels 1 and 4
        for yy in (AXLES[0] - 0.7, AXLES[3] - 0.7):
            H.add(box(0.34, 0.012, 0.3, c=(s * 1.2, yy, 0.86), mat='skirt', bev=0.004, segs=1))
    # tools: shovel (right) + crowbar & axe (left) low on the upper side ahead of the door
    H.add(tool_shovel(), L.place(plate_M(N_UP, 1), on_upper(0.72, 1.37, 0.03, 1)))
    for yy in (0.4, 1.0):
        H.add(box(0.04, 0.06, 0.05), L.place(plate_M(N_UP, 1), on_upper(yy, 1.37, 0.02, 1)))
        H.add(box(0.04, 0.06, 0.05), L.place(plate_M(N_UP, -1), on_upper(yy, 1.37, 0.02, -1)))
    H.add(tube([on_upper(0.3, 1.38, 0.03, -1), on_upper(1.12, 1.38, 0.03, -1)], 0.015, 6, 'bare'))
    ax = box(0.6, 0.03, 0.03, mat='wood', bev=0.008, segs=1)
    ax.add(box(0.05, 0.14, 0.02, c=(0.3, 0.04, 0), mat='bare'))
    H.add(ax, L.place(plate_M(N_UP, -1), on_upper(0.7, 1.47, 0.03, -1)))

    # ---- rear: upper plate (access hatch, lights), lower plate (water-jet flap, tow hooks)
    ru = V((0, REAR_TOP - REAR_LOW[0], ROOF - REAR_LOW[1])).normalized()
    rn = V((0, -ru.z, ru.y))
    MR = frame_nu(rn, ru)
    rmid = V((0, REAR_LOW[0], REAR_LOW[1])) + ru * 0.42
    hp = box(1.1, 0.42, 0.03, c=(0, 0, 0.015), bev=0.008, segs=1)
    for x in (-0.36, 0.36):
        hp.add(rail([(x - 0.09, -0.1, 0.03), (x - 0.09, -0.1, 0.08), (x + 0.09, -0.1, 0.08), (x + 0.09, -0.1, 0.03)], r=0.01, rad=0.02))
        hp.add(cyl(0.025, 0.12, 10, 'x', c=(x, 0.22, 0.02)))
    H.add(hp, L.place(MR, rmid))
    for s in (1, -1):
        p = V((s * 0.92, REAR_LOW[0], REAR_LOW[1])) + ru * 0.2
        rl = box(0.18, 0.08, 0.1, c=(0, 0, 0.05), bev=0.01, segs=1)
        rl.add(box(0.13, 0.06, 0.012, c=(0, 0, 0.1), mat='light'))
        for x in (-0.1, 0.1):
            rl.add(rail([(x, -0.06, 0.0), (x, -0.06, 0.16), (x, 0.06, 0.16), (x, 0.06, 0.0)], r=0.008, rad=0.03, foot=False))
        H.add(rl, L.place(MR, p))
        H.add(tow_hook().rot('Z', 180).rot('X', 20), Matrix.Translation((s * 0.62, REAR_LOW[0] + 0.12, 1.12)))
    lu = V((0, REAR_LOW[0] - (-3.18), REAR_LOW[1] - BELLY)).normalized()
    ln_ = V((0, -lu.z, lu.y))
    if ln_.y > 0:
        ln_ = -ln_
    ML_ = frame_nu(ln_, lu)
    wjc = V((0, -3.18, BELLY)) + lu * 0.42
    wj = lathe([(0, 0.0), (0.2, 0.0), (0.22, 0.03), (0.21, 0.05), (0, 0.05)], 24, 'z')
    wj.add(box(0.5, 0.06, 0.04, c=(0, 0.2, 0.03), bev=0.008, segs=1))
    for x in (-0.15, 0.15):
        wj.add(cyl(0.025, 0.1, 10, 'x', c=(x, 0.24, 0.03)))
    H.add(wj, L.place(ML_, wjc))
    pin = box(0.12, 0.2, 0.08, c=(0, -3.8, 1.05), bev=0.01, segs=1)           # tow pintle housing
    pin.add(tube(fillet_path([(0, -3.86, 1.08), (0, -3.98, 1.08), (0, -3.98, 0.98)], 0.04, 3), 0.025, 8))
    H.add(L.snap(pin, H, d=(0, 1, 0), max_d=0.3, sink=0.01))                   # vehicles_v5: onto the rear plate (4.6 cm gap)

    return H

def build(variant):
    t0 = time.time()
    L.reset()
    is82 = variant == 'btr82a'
    setup_variant(variant)
    root = L.node_empty('root')
    hullE = L.node_empty('hull', root, (0, 0, 0))

    H = hull_btr80() if IS80 else hull_btr82a(is82)
    print('  hull tris', H.tris(), '%.1fs' % (time.time() - t0))
    full_bvh = L.bvh_of(H)
    hull_mesh = L.node_mesh('hull_geo', H, hullE, (0, 0, 0))

    # ---------------------------------------------------------------------------- turret + gun
    tz = ROOF + 0.04
    if is82:
        TU = turret_bppu(); G, mz, cx = gun_2a72(); trun = (0, GUN_Y, GUN_Z); elev = 70   # models_v16: z 0.50 -> 0.56 (depression); v15 set back (was (0, 0.42, 0.56))
    else:
        TU = turret_bpu1(); G, mz, cx = gun_bpu1(); trun = (0, 0.6, 0.22); elev = 60
    TU.move(0, TY, tz)
    turE = L.node_empty('turret', hullE, (0, TY, tz))
    tur_mesh = L.node_mesh('turret_geo', TU, turE, (0, TY, tz))
    tp = (trun[0], TY + trun[1], tz + trun[2])
    gunE = L.node_empty('gun_pivot', turE, tp)
    G.move(*tp)
    gun_mesh = L.node_mesh('gun_geo', G, gunE, tp)
    L.node_empty('muzzle', gunE, (tp[0] + mz[0], tp[1] + mz[1], tp[2] + mz[2]), 0.1)
    L.node_empty('coax_muzzle', gunE, (tp[0] + cx[0], tp[1] + cx[1], tp[2] + cx[2]), 0.1)
    if is82:
        L.node_empty('smoke_launchers', turE, (0, TY - 0.02, tz + 0.48))     # models_v14: tube groups either side of the gun
    else:
        L.node_empty('smoke_launchers', turE, (0, TY - 0.6, tz + 0.3))

    # ---------------------------------------------------------------------------- wheels
    W = tyre_wheel()
    Wl = L.B.__new__(L.B); Wl.bm = W.bm.copy(); Wl.scale(-1, 1, 1)
    meR = None; meL = None
    wheel_objs = []
    for side, tag in ((1, 'R'), (-1, 'L')):
        for i, y in enumerate(AXLES):
            c = (side * TRACK / 2, y, WZ)
            e = L.node_empty(f'wheel_{tag}{i + 1}', hullE, c)
            if side == 1:
                if meR is None:
                    part = L.B.__new__(L.B); part.bm = W.bm.copy(); part.move(*c)
                    o = L.node_mesh(f'wheel_{tag}{i + 1}_geo', part, e, c); meR = o.data
                else:
                    o = L.node_mesh(f'wheel_{tag}{i + 1}_geo', None, e, c, mesh=meR)
            else:
                if meL is None:
                    part = L.B.__new__(L.B); part.bm = Wl.bm.copy(); part.move(*c)
                    o = L.node_mesh(f'wheel_{tag}{i + 1}_geo', part, e, c); meL = o.data
                else:
                    o = L.node_mesh(f'wheel_{tag}{i + 1}_geo', None, e, c, mesh=meL)
            wheel_objs.append(o)
    meR.name = 'wheel_R'; meL.name = 'wheel_L'

    # ---------------------------------------------------------------------------- empties
    if IS80:
        L.node_empty('exhaust', hullE, tuple(on_upper(-3.4, CH_Z + 0.16, 0.12, -1)))                  # BTR-80: pre-v12 (left)
    else:
        L.node_empty('exhaust', hullE, tuple(on_upper(-3.26, CH_Z + 0.14, 0.10, 1)))                  # BTR-82A: rear right (models_v11)
    L.node_empty('dismount_L', hullE, (-1.95, DOOR_Y, 0.0))
    L.node_empty('dismount_R', hullE, (1.95, DOOR_Y, 0.0))
    L.node_empty('commander_hatch', hullE, (HATCH_X, HATCH_Y, ROOF + 0.05))
    lids = btr_lids(variant, hullE, turE, tz)
    lid_objs = [l_['mesh'] for l_ in lids]
    seats = S.place_seats(hullE, SEAT_SPECS_82 if is82 else SEAT_SPECS, full_bvh)
    blen = math.hypot(mz[1], mz[2])
    clr = S.clearance(seats, (0, TY, tz), [tur_mesh], tp, blen, elev)
    print('  seats', [(s['name'], round(s['x'], 2), round(s['y'], 2), round(s['z'], 3)) for s in seats])
    print('  clearance', clr)

    print('  geometry done %.1fs' % (time.time() - t0))
    lod0 = [hull_mesh, tur_mesh, gun_mesh] + lid_objs + wheel_objs
    return dict(root=root, hull=hullE, turret=turE, gun=gunE, lod0=lod0, gun_obj=gun_mesh, tur_obj=tur_mesh,
                atlas=[hull_mesh, tur_mesh, gun_mesh] + lid_objs + [wheel_objs[0], wheel_objs[4]],
                tp=tp, TY=TY, tz=tz, seats=seats, clearance=clr, lids=lids,
                hull_lids=[l_['mesh'] for l_ in lids if l_['entry']['parent'] == 'hull'],
                tur_lids=[l_['mesh'] for l_ in lids if l_['entry']['parent'] == 'turret'])

def decals_ua(P, N):
    """White crosses (common Ukrainian field ID marks).  Positions in authoring frame -> export frame."""
    m = np.zeros(P.shape[:2], np.float32)
    E = lambda p: (-p[0], -p[1], p[2])
    for s_ in (1, -1):
        c = (s_ * x_upper(1.6), -1.72, 1.6)
        n = (s_ * N_UP.x, 0, N_UP.z)
        m += T.decal_mask(P, N, E(c), E(n), (0, 0, 1), T.cross_shape(0.17, 0.04))
    ru = V((0, REAR_TOP - REAR_LOW[0], ROOF - REAR_LOW[1])).normalized()
    c = V((0, REAR_LOW[0], REAR_LOW[1])) + ru * 0.42
    m += T.decal_mask(P, N, E(tuple(c + V((0.0, -0.05, 0.0)))), E((0, -ru.z, ru.y)), (0, 0, 1), T.cross_shape(0.15, 0.036))
    # roof cross (air ID) on the engine deck access hatch area
    m += T.decal_mask(P, N, E((0, -1.0, ROOF)), E((0, 0, 1)), (0, -1, 0), T.cross_shape(0.22, 0.05))
    return m

def wreck_btr(d):
    """Burnt-out hull sitting on its rims (tyres burnt away) + separate burnt turret with drooped gun."""
    root = d['root']
    drop = WZ - 0.25
    VB.set_lids(d['lids'], 1.0)          # wrecks show the hatches open (crew bailed out)
    hw = VB.join_copies('hull_wreck', [o for o in d['lod0'] if o.name.startswith(('hull_geo', 'wheel_'))] + d['hull_lids'], root,
                        (0, 0, 0), drop_slots=('tyre', 'glass', 'light'), drop_z=drop)
    # models_v13: the re-measured 82A hull is denser; keep the burnt hull within the old triangle budget (<= 17.0k)
    hw.data.calc_loop_triangles()
    nt = len(hw.data.loop_triangles)
    if nt > 17000:
        mod = hw.modifiers.new('wreck_dec', 'DECIMATE'); mod.decimate_type = 'COLLAPSE'; mod.ratio = 16900 / nt
        bpy.context.view_layer.objects.active = hw
        with bpy.context.temp_override(object=hw, active_object=hw):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    g = d['gun_obj']
    g.rotation_euler = (math.radians(6), 0, 0)
    bpy.context.view_layer.update()
    tp = d['turret'].matrix_world.translation.copy()
    tw = VB.join_copies('turret_wreck', [d['tur_obj'], g] + d['tur_lids'], root, tuple(tp), drop_slots=('glass', 'light'))
    g.rotation_euler = (0, 0, 0)
    VB.set_lids(d['lids'], 0.0)
    tw.location.z -= drop
    bpy.context.view_layer.update()
    return [hw, tw]

def decals_ru(P, N):
    return np.zeros(P.shape[:2], np.float32)

def main(variant):
    d = build(variant)
    scheme = 'ru_btr82' if variant == 'btr82a' else 'ua_btr'          # models_v11: was ru_green
    dec = decals_ru if variant == 'btr82a' else decals_ua
    # exhaust soot: outlets at the rear end of both silencers (authoring frame), streaking back/down
    if IS80:
        VB.SOOT[:] = [(tuple(on_upper(-3.3, CH_Z + 0.2, 0.1, s)), 0.42) for s in (1, -1)]     # BTR-80: pre-v12 silencers
    else:
        VB.SOOT[:] = [(tuple(on_upper(-3.26, CH_Z + 0.16, 0.1, s)), 0.42) for s in (1, -1)]
    info = VB.finalize(d, variant, scheme, dec, wreck_btr)
    info['ride_seats'] = S.manifest_entries(d['seats'])
    info['ride_clearance'] = d['clearance']
    info['hatch_lids'], anim = VB.lid_manifest(d['lids'])
    anim.update({'turret': 'yaw about local Y', 'gun_pivot': 'pitch about local X; elevate = rotation.x NEGATIVE',
                 'wheel_*': 'spin about local X (hub)'})
    info['animated_nodes'] = anim
    roles = sorted(n[len('hatch_lid_'):] for n in info['hatch_lids'])
    info['empties'] = {'muzzle': 'main gun', 'coax_muzzle': 'coax MG', 'smoke_launchers': 'turret',
                       'hatch_commander / commander_hatch': 'commander roof hatch rim centre (hull, front right)',
                       'hatch_driver': 'driver roof hatch rim centre (hull, front left)',
                       'hatch_gunner': ('BPPU turret roof hatch rim centre (turret)' if variant == 'btr82a'
                                        else 'right troop roof hatch rim centre (hull) - the BPU-1 turret has no roof hatch'),
                       'hatch_cargo_*': 'troop roof hatch rim centres behind the turret (hull)',
                       'exhaust': ('right silencer outlet' if variant == 'btr82a' else 'left silencer outlet'), 'dismount_L / dismount_R': 'side door ground points',
                       'ride_seat_1..8': 'desant seats'}
    with open(os.path.join(VB.CACHE, variant + '_info.json'), 'w') as f:
        json.dump(info, f, indent=1)
    if '--no-manifest' not in sys.argv:
        import build_all
        build_all.merge_manifest([variant])
    print(json.dumps({k: v for k, v in info.items() if k not in ('nodes', 'hierarchy', 'node_bboxes')})[:3000])
    return info

if __name__ == '__main__':
    main([a for a in sys.argv[1:] if not a.startswith('--')][-1])
