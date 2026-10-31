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

AXLES = [2.125, 0.775, -1.175, -2.525]
TRACK = 2.41
WR = 0.555          # loaded tyre radius
WZ = 0.548          # hub height
ROOF = 1.96
BELLY = 0.475

# hull cross-section helpers (mid-body, right side)
CH_X, CH_Z = 1.45, 1.27            # crease (widest line)
RF_X = 0.90                        # roof edge half-width
BL_X = 0.62                        # belly half width
NOSE = (3.86, 1.07)                # y, z of the bow edge
WS_BOT = (2.80, 1.50)              # windscreen plate lower edge (y, z)
WS_TOP = (2.36, ROOF)              # windscreen plate upper edge = roof front
REAR_TOP = -3.30                   # roof rear edge
REAR_LOW = (-3.84, 1.34)           # upper rear plate lower edge
TY = 0.95                          # turret ring centre (y)
DOOR_Y = -0.2                      # side door centre
RECESS = (1.20, 1.80)              # forward firing-port recess (y range)

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
    # every plate is exactly planar: side plate = all points with x = x_upper(z); cheek = triangle crease-front /
    # windscreen corner / bow corner; glacis, windscreen and rear plates are symmetric trapezoids.
    WS_X = x_upper(WS_BOT[1])
    pts = []
    for s in (1, -1):
        pts += [(s * BL_X, -3.18, BELLY), (s * BL_X, 2.98, BELLY),
                (s * CH_X, -3.12, CH_Z), (s * CH_X, 2.25, CH_Z),
                (s * 0.76, NOSE[0], NOSE[1]),
                (s * WS_X, WS_BOT[0], WS_BOT[1]),
                (s * RF_X, WS_TOP[0], ROOF), (s * RF_X, REAR_TOP, ROOF),
                (s * 1.16, REAR_LOW[0], REAR_LOW[1])]
    b = hull(pts)
    cut = B(mat='rolled')
    for y in AXLES:
        for s in (1, -1):
            cut.add(cyl(0.68, 0.9, 40, 'x', c=(s * (TRACK / 2 + 0.25), y, WZ)))
    # concave step between the shallow glacis and the steeper windscreen plate (convex hull can't express it)
    gd = V((0, NOSE[0] - WS_BOT[0], NOSE[1] - WS_BOT[1]))
    wd = V((0, WS_TOP[0] - WS_BOT[0], WS_TOP[1] - WS_BOT[1]))
    p_n = V((0, WS_BOT[0], WS_BOT[1])) + gd * 1.45
    p_t = V((0, WS_BOT[0], WS_BOT[1])) + wd * 1.3
    prof = [(p_n.y, p_n.z), (WS_BOT[0], WS_BOT[1]), (p_t.y, p_t.z), (p_t.y, 2.8), (p_n.y, 2.8)]
    cut.add(hull([(x, y, z) for (y, z) in prof for x in (-2.0, 2.0)]))
    # forward firing-port recesses: wedge cut into the upper side so the port faces forward-outward
    for s in (1, -1):
        rp = []
        for z in (CH_Z + 0.14, ROOF - 0.12):
            xs = x_upper(z)
            for (dx, y) in ((-0.26, RECESS[0]), (0.5, RECESS[0]), (0.5, RECESS[1]), (0.03, RECESS[1])):
                rp.append((s * (xs + dx), y, z))
        cut.add(hull(rp))
    me_cut = cut.to_mesh('_cut')
    ob_cut = L.link(bpy.data.objects.new('_cut', me_cut))
    b.mods([('BOOLEAN', dict(operation='DIFFERENCE', object=ob_cut, solver='EXACT'))])
    bpy.data.objects.remove(ob_cut)
    b.bevel(0.02, 2, 25)
    return b

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
    hl.add(cyl(0.075, 0.004, 20, 'y', c=(0, 0.058, 0), mat='light'))
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
    """Two driver/commander windows with top-hinged armoured shutters (open = propped on struts)."""
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

def trim_vane():
    """Folded trim vane (wave breaker) lying on the glacis, hinged at the bow edge."""
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
    for i in range(10):
        a = math.tau * i / 10
        rim.add(bolt(0.017, 0.024, 6, 'rim').rot('Y', 90), Matrix.Translation((0.088, 0.172 * math.cos(a), 0.172 * math.sin(a))))
    # central tyre-inflation valve on the dome + hose to the rim edge + guard lugs
    rim.add(lathe([(0, 0.0), (0.035, 0.0), (0.035, 0.035), (0.025, 0.05), (0, 0.055)], 12, 'x', mat='bare', c=(0.185, 0, 0)))
    rim.add(tube(fillet_path([(0.2, 0, 0.02), (0.205, 0, 0.06), (0.15, 0, 0.13), (0.1, 0, 0.2), (0.095, 0, 0.225)], 0.03, 4), 0.012, 6, 'bare'))
    for a in range(5):
        ang = a * math.tau / 5 + 0.3
        rim.add(box(0.03, 0.03, 0.05).rot('X', math.degrees(ang)), Matrix.Translation((0.145, 0.12 * math.cos(ang), 0.12 * math.sin(ang))))
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

def turret_bppu():
    """BTR-82A BPPU: larger welded faceted turret, 2A72 + PKTM, gunner's combined day/night sight box,
    3 + 3 902V launchers on the rear corners, rear stowage box.  Origin = ring centre on the hull roof."""
    t = B()
    pts = []
    # conical lower body (inherited from the BPU-1 family) carrying an angular welded superstructure
    for i in range(16):
        a = math.tau * (i + 0.5) / 16
        pts.append((0.84 * math.cos(a), 0.84 * math.sin(a), 0.0))
        pts.append((0.64 * math.cos(a), 0.64 * math.sin(a), 0.30))
    t.add(hull(pts, bev=0.015, segs=1, angle=25))
    bot = [(-0.40, 0.74), (0.40, 0.74), (0.66, 0.30), (0.66, -0.42), (0.48, -0.66), (-0.48, -0.66), (-0.66, -0.42), (-0.66, 0.30)]
    top = [(-0.30, 0.56), (0.30, 0.56), (0.54, 0.24), (0.56, -0.40), (0.42, -0.58), (-0.42, -0.58), (-0.56, -0.40), (-0.54, 0.24)]
    up = hull([(x, y, 0.20) for x, y in bot] + [(x, y, 0.58) for x, y in top], bev=0.022, segs=2, angle=20)
    t.add(up)
    # front gun slot
    t.add(box(0.44, 0.04, 0.3, c=(0.03, 0.70, 0.34), mat='gunmetal'))
    # gunner's combined sight (left front) - armoured box with front shutter, and day periscope (right)
    sx = -0.32
    s1 = box(0.26, 0.34, 0.28, c=(sx, 0.18, 0.72), bev=0.02, segs=2)
    s1.add(box(0.2, 0.012, 0.12, c=(sx, 0.352, 0.74), mat='glass'))
    s1.add(box(0.28, 0.14, 0.018, c=(sx, 0.38, 0.88)).rot('X', -25, (sx, 0.33, 0.87)))
    s1.add(box(0.3, 0.08, 0.02, c=(sx, 0.35, 0.87)))
    s1.add(box(0.2, 0.24, 0.06, c=(sx, 0.16, 0.6)))
    t.add(s1)
    s2 = lathe([(0, 0), (0.09, 0), (0.09, 0.08), (0.0, 0.08)], 14, 'z', c=(0.32, 0.22, 0.58))
    s2.add(box(0.15, 0.14, 0.12, c=(0.32, 0.26, 0.72), bev=0.015, segs=2))
    s2.add(box(0.11, 0.01, 0.06, c=(0.32, 0.335, 0.73), mat='glass'))
    t.add(s2)
    # gunner's hatch + periscopes
    t.add(lathe([(0, 0.05), (0.22, 0.045), (0.25, 0.02), (0.26, 0.0)], 24, 'z', c=(0.12, -0.28, 0.58)))
    t.add(rail([(0.02, -0.28, 0.63), (0.02, -0.28, 0.67), (0.22, -0.28, 0.67), (0.22, -0.28, 0.63)], r=0.01, rad=0.025))
    t.add(cyl(0.035, 0.14, 8, 'x', c=(0.12, -0.54, 0.6)))
    for (px, py, ang) in ((-0.5, -0.1, 90), (0.52, 0.0, -90)):
        t.add(periscope_block(0.14, 0.08, 0.06), Matrix.Translation((px, py, 0.575)) @ Matrix.Rotation(math.radians(ang), 4, 'Z'))
    # wind sensor mast + antenna base at the rear
    t.add(cyl(0.012, 0.32, 6, 'z', c=(-0.42, -0.45, 0.74), mat='gunmetal'))
    t.add(cyl(0.03, 0.05, 8, 'z', c=(-0.42, -0.45, 0.92)))
    t.add(antenna_base(), Matrix.Translation((0.40, -0.48, 0.58)))
    # 902V smoke launchers: 3 per rear corner on a bracket, pointing forward-up-outward
    for s_ in (1, -1):
        nrm = V((s_ * 0.79, -0.62, 0))
        ang = math.atan2(nrm.y, nrm.x)
        c0 = V((s_ * 0.66, -0.52, 0.40))
        tang = V((-nrm.y, nrm.x, 0)) * (1 if s_ > 0 else -1)      # along the corner face, pointing forward
        br = box(0.06, 0.40, 0.14, bev=0.006, segs=1)
        t.add(br, Matrix.Translation(c0) @ Matrix.Rotation(ang, 4, 'Z'))
        for i in range(3):
            p = c0 + nrm * 0.07 + tang * ((i - 1) * 0.12) + V((0, 0, 0.06))
            d = V((s_ * (0.25 + 0.08 * i), 1.0, 0.75))
            t.add(tucha_tube(), Matrix.Translation(p) @ align_y(d))
    # stowage box on the turret rear
    t.add(box(0.92, 0.24, 0.30, c=(0, -0.80, 0.34), bev=0.015, segs=2))
    t.add(box(0.94, 0.26, 0.025, c=(0, -0.80, 0.49), bev=0.005, segs=1))
    for x in (-0.3, 0.3):
        t.add(rail([(x, -0.92, 0.42), (x, -0.96, 0.42), (x, -0.96, 0.3), (x, -0.92, 0.3)], r=0.008, rad=0.02))
    # roof bolts / weld seams
    for x in np.linspace(-0.4, 0.4, 5):
        for y in (-0.48, 0.42):
            t.add(bolt(0.012, 0.01), Matrix.Translation((x, y, 0.58)))
    return t

def gun_2a72():
    g = B()
    g.add(box(0.50, 0.18, 0.28, c=(0.0, 0.02, 0.0), bev=0.03, segs=2))       # mantlet
    g.add(box(0.30, 0.10, 0.16, c=(-0.04, 0.14, 0.0), bev=0.02, segs=2))     # barrel collar housing
    # 2A72: recoil jacket then long thin barrel and slotted muzzle brake
    g.add(lathe([(0, 0), (0.07, 0), (0.07, 0.06), (0.06, 0.08), (0.06, 0.72), (0.045, 0.76), (0.0, 0.76)], 18, 'y', mat='rolled', c=(-0.04, 0.12, 0)))
    for i in range(3):
        g.add(cyl(0.066, 0.025, 18, 'y', c=(-0.04, 0.32 + i * 0.2, 0)))
    g.add(cyl(0.025, 1.52, 14, 'y', c=(-0.04, 1.62, 0), mat='gunmetal'))
    g.add(lathe([(0.0, 0), (0.036, 0), (0.04, 0.02), (0.04, 0.16), (0.034, 0.18), (0, 0.18)], 14, 'y', mat='gunmetal', c=(-0.04, 2.37, 0)))
    for i in range(3):
        g.add(box(0.09, 0.022, 0.012, c=(-0.04, 2.42 + i * 0.04, 0), mat='gunmetal'))
    # PKTM coax right
    px = 0.2
    g.add(cyl(0.03, 0.18, 10, 'y', c=(px, 0.18, -0.03), mat='gunmetal'))
    g.add(cyl(0.012, 0.36, 8, 'y', c=(px, 0.44, -0.03), mat='gunmetal'))
    g.add(cyl(0.017, 0.06, 8, 'y', c=(px, 0.64, -0.03), mat='gunmetal'))
    return g, (-0.04, 2.56, 0), (px, 0.67, -0.03)

# =============================================================================================== build
SEAT_SPECS = (
    [dict(x=s * 0.56, y=y, face=(s, 0), type='edge') for y in (-0.45, -1.25, -1.95) for s in (1, -1)] +
    [dict(x=s * 0.30, y=-2.85, face=(0, 1), type='deck') for s in (1, -1)])

def build(variant):
    t0 = time.time()
    L.reset()
    is82 = variant == 'btr82a'
    root = L.node_empty('root')
    hullE = L.node_empty('hull', root, (0, 0, 0))

    H = hull_shell()
    shell_bvh = L.bvh_of(H)
    def hit(o, d):
        h = shell_bvh.ray_cast(V(o), V(d).normalized())
        return h[0], h[1]
    # ---- weld seams along main plate joints
    for s in (1, -1):
        H.add(weld_line([(s * (RF_X - 0.004), REAR_TOP + 0.05, ROOF - 0.004), (s * (RF_X - 0.03), WS_TOP[0] - 0.03, ROOF - 0.004)]))
    H.add(weld_line([(-0.86, WS_TOP[0] - 0.01, ROOF - 0.003), (0.86, WS_TOP[0] - 0.01, ROOF - 0.003)]))
    H.add(weld_line([(-1.02, WS_BOT[0] + 0.005, WS_BOT[1] - 0.004), (1.02, WS_BOT[0] + 0.005, WS_BOT[1] - 0.004)]))
    H.add(weld_line([(-0.74, NOSE[0] - 0.005, NOSE[1]), (0.74, NOSE[0] - 0.005, NOSE[1])]))
    H.add(weld_line([(-0.88, REAR_TOP - 0.01, ROOF - 0.004), (0.88, REAR_TOP - 0.01, ROOF - 0.004)]))
    H.add(weld_line([(-1.12, REAR_LOW[0] + 0.01, REAR_LOW[1]), (1.12, REAR_LOW[0] + 0.01, REAR_LOW[1])]))
    H.add(box(1.75, 0.02, 0.012, c=(0, -1.32, ROOF + 0.003)))       # engine deck plate seam

    # ---- crease: fender lip along the widest line + rubber mudguards over the wheels
    for s in (1, -1):
        H.add(box(0.075, 5.33, 0.022, c=(s * (CH_X + 0.02), -0.43, CH_Z - 0.01), bev=0.006, segs=1))
        k = 0.62
        H.add(tube([(s * (CH_X + 0.03), 2.2, CH_Z - 0.012), (s * (CH_X - 0.69 * k / 1.61 * 1.0 + 0.03), 2.25 + k, CH_Z - 0.24 * k / 1.61 - 0.012)], 0.02, 6))
        for y in AXLES:
            mg = box(0.012, 0.9, 0.08, c=(0, 0, -0.04), mat='tyre', bev=0.004, segs=1)       # rubber fender lip
            mg.add(box(0.03, 0.92, 0.025, c=(0, 0, 0.0), mat='rolled'))
            for yy in (-0.3, 0.0, 0.3):
                mg.add(bolt(0.01, 0.008, 6, 'rolled').rot('Y', 90 * s), Matrix.Translation((s * 0.012, yy, -0.012)))
            xx = CH_X + 0.045
            H.add(mg.rot('Y', s * -8), Matrix.Translation((s * xx, y, CH_Z - 0.02)))

    # ---- front: windscreens + shutters, trim vane, headlights, hooks
    H.add(windscreen(open_=not is82))
    Mv, tv, (gn, gu) = trim_vane()
    H.add(tv, Mv)
    for s in (1, -1):
        p = V((s * 0.84, NOSE[0], NOSE[1])) + gu * 0.98
        ped = hull([(-0.2, -0.06, -0.08), (0.2, -0.06, -0.08), (-0.2, 0.08, -0.08), (0.2, 0.08, -0.08),
                    (-0.2, -0.06, 0.03), (0.2, -0.06, 0.03), (-0.2, 0.08, 0.03), (0.2, 0.08, 0.03)])
        H.add(ped, Matrix.Translation(p))
        H.add(headlight_cluster(s), Matrix.Translation(p + V((0, 0, 0.03))))
    for s in (1, -1):
        H.add(tow_hook().rot('X', -30), Matrix.Translation((s * 0.52, NOSE[0] - 0.14, NOSE[1] - 0.14)))
    # lower bow: lugs + access plate
    lb_ang = math.degrees(math.atan2(NOSE[1] - BELLY, NOSE[0] - 2.98))
    H.add(box(1.0, 0.012, 0.36, c=(0, 3.435, 0.75), bev=0.004, segs=1).rot('X', -(90 - lb_ang), (0, 3.435, 0.75)))
    for x in (-0.3, 0.3):
        H.add(lathe([(0.03, -0.015), (0.055, -0.015), (0.055, 0.015), (0.03, 0.015)], 12, 'x', cap=False, c=(x, 3.6, 0.88)))
    # ---- roof front: driver (left) + commander (right) hatches, periscopes in front of them
    for s in (1, -1):
        H.add(hatch_rect(0.56, 0.52, c=(s * 0.45, 1.98, ROOF), hinge='y-'))
        for i in range(2):
            M = Matrix.Translation((s * (0.28 + i * 0.3), WS_TOP[0] - 0.04, ROOF - 0.02)) @ Matrix.Rotation(math.radians(s * -14 * i), 4, 'Z')
            H.add(periscope_block(0.17, 0.1, 0.07), M)
        # cheek periscope looking forward-outward
        H.add(periscope_block(0.15, 0.09, 0.06), Matrix.Translation((s * (RF_X - 0.1), 2.12, ROOF - 0.015)) @ Matrix.Rotation(-s * 0.9, 4, 'Z'))
    # turret ring collar
    H.add(lathe([(0.80, 0), (0.85, 0), (0.85, 0.03), (0.78, 0.045)], 40, 'z', c=(0, TY, ROOF)))
    # troop hatches behind the turret
    for s in (1, -1):
        H.add(hatch_rect(0.52, 0.62, c=(s * 0.45, -0.40, ROOF), hinge='y-'))
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
    H.add(box(0.12, 0.2, 0.08, c=(0, -3.8, 1.05), bev=0.01, segs=1))           # tow pintle housing
    H.add(tube(fillet_path([(0, -3.86, 1.08), (0, -3.98, 1.08), (0, -3.98, 0.98)], 0.04, 3), 0.025, 8))

    if is82:
        # tarp roll strapped across the rear edge of the roof, stowage box on the rear plate
        H.add(cyl(0.13, 1.5, 16, 'x', c=(0, -3.17, ROOF + 0.13), mat='canvas'))
        for x in (-0.5, 0.0, 0.5):
            H.add(lathe([(0.134, -0.02), (0.14, -0.02), (0.14, 0.02), (0.134, 0.02)], 16, 'x', c=(x, -3.17, ROOF + 0.13), mat='bare', cap=False))
        sb = box(0.9, 0.3, 0.26, c=(0, 0, 0.15), bev=0.015, segs=2)
        sb.add(box(0.92, 0.32, 0.02, c=(0, 0, 0.28)))
        H.add(sb, L.place(MR, rmid + ru * 0.02 + V((0, 0, 0))))
    print('  hull tris', H.tris(), '%.1fs' % (time.time() - t0))
    full_bvh = L.bvh_of(H)
    hull_mesh = L.node_mesh('hull_geo', H, hullE, (0, 0, 0))

    # ---------------------------------------------------------------------------- turret + gun
    tz = ROOF + 0.04
    if is82:
        TU = turret_bppu(); G, mz, cx = gun_2a72(); trun = (0, 0.62, 0.34); elev = 70
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
        L.node_empty('smoke_launchers', turE, (0, TY - 0.46, tz + 0.5))
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
    L.node_empty('exhaust', hullE, tuple(on_upper(-3.4, CH_Z + 0.16, 0.12, -1)))
    L.node_empty('dismount_L', hullE, (-1.95, DOOR_Y, 0.0))
    L.node_empty('dismount_R', hullE, (1.95, DOOR_Y, 0.0))
    L.node_empty('commander_hatch', hullE, (0.45, 1.98, ROOF + 0.05))
    seats = S.place_seats(hullE, SEAT_SPECS, full_bvh)
    blen = math.hypot(mz[1], mz[2])
    clr = S.clearance(seats, (0, TY, tz), [tur_mesh], tp, blen, elev)
    print('  seats', [(s['name'], round(s['x'], 2), round(s['y'], 2), round(s['z'], 3)) for s in seats])
    print('  clearance', clr)

    print('  geometry done %.1fs' % (time.time() - t0))
    lod0 = [hull_mesh, tur_mesh, gun_mesh] + wheel_objs
    return dict(root=root, hull=hullE, turret=turE, gun=gunE, lod0=lod0, gun_obj=gun_mesh, tur_obj=tur_mesh,
                atlas=[hull_mesh, tur_mesh, gun_mesh, wheel_objs[0], wheel_objs[4]],
                tp=tp, TY=TY, tz=tz, seats=seats, clearance=clr)

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
    hw = VB.join_copies('hull_wreck', [o for o in d['lod0'] if o.name.startswith(('hull_geo', 'wheel_'))], root,
                        (0, 0, 0), drop_slots=('tyre', 'glass', 'light'), drop_z=drop)
    g = d['gun_obj']
    g.rotation_euler = (math.radians(6), 0, 0)
    bpy.context.view_layer.update()
    tp = d['turret'].matrix_world.translation.copy()
    tw = VB.join_copies('turret_wreck', [d['tur_obj'], g], root, tuple(tp), drop_slots=('glass', 'light'))
    g.rotation_euler = (0, 0, 0)
    tw.location.z -= drop
    bpy.context.view_layer.update()
    return [hw, tw]

def decals_ru(P, N):
    return np.zeros(P.shape[:2], np.float32)

def main(variant):
    d = build(variant)
    scheme = 'ru_green' if variant == 'btr82a' else 'ua_btr'
    dec = decals_ru if variant == 'btr82a' else decals_ua
    # exhaust soot: outlets at the rear end of both silencers (authoring frame), streaking back/down
    VB.SOOT[:] = [(tuple(on_upper(-3.3, CH_Z + 0.2, 0.1, s)), 0.42) for s in (1, -1)]
    info = VB.finalize(d, variant, scheme, dec, wreck_btr)
    info['ride_seats'] = S.manifest_entries(d['seats'])
    info['ride_clearance'] = d['clearance']
    with open(os.path.join(VB.CACHE, variant + '_info.json'), 'w') as f:
        json.dump(info, f, indent=1)
    print(json.dumps({k: v for k, v in info.items() if k not in ('nodes', 'hierarchy', 'node_bboxes')}))
    return info

if __name__ == '__main__':
    main(sys.argv[-1])
