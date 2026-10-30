"""BTR-82A (RU, BPPU turret, 2A72 30 mm + PKTM) and BTR-80 (UA, BPU-1 turret, KPVT 14.5 mm + PKT).

Reference data (see assets/vehicles/manifest.json for sources):
  length 7.65 m, width 2.90 m, height 2.41 m (BTR-80 turret roof) / ~2.80 m (BTR-82A sights),
  ground clearance 0.475 m, wheel track 2.41 m, tyres KI-80 13.00x18 (dia ~1.12 m),
  axle spacing 1.35 + 1.95 + 1.35 m, side doors between axles 2 and 3 (split: upper opens forward,
  lower folds down as a step), 3 ball-mount firing ports per side, 902V Tucha 81 mm launchers.
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

AXLES = [2.125, 0.775, -1.175, -2.525]
TRACK = 2.41
WR = 0.555          # loaded tyre radius
WZ = 0.548          # hub height
ROOF = 2.0
BELLY = 0.475

# hull cross-section helpers (mid-body, right side)
CH_X, CH_Z = 1.45, 1.27            # chine
RF_X = 0.98                        # roof edge half-width
BL_X = 0.62                        # belly half width
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

# =============================================================================================== hull
def hull_shell():
    pts = []
    for s in (1, -1):
        pts += [(s * BL_X, -3.22, BELLY), (s * BL_X, 2.92, BELLY),
                (s * 1.36, -3.56, CH_Z), (s * CH_X, -3.05, CH_Z), (s * CH_X, 1.25, CH_Z),
                (s * 1.30, 2.55, 1.22), (s * 1.02, 3.35, 1.12),
                (s * 1.22, -3.84, 1.36),
                (s * 0.72, 3.84, 1.04),
                (s * 1.08, 2.72, 1.62),
                (s * RF_X, -3.26, ROOF), (s * RF_X, 2.30, ROOF)]
    b = hull(pts)
    # wheel wells: boolean difference with cylinders
    cut = B(mat='rolled')
    for y in AXLES:
        for s in (1, -1):
            cut.add(cyl(0.67, 0.9, 40, 'x', c=(s * (TRACK / 2 + 0.25), y, WZ)))
    # inner well box connecting front pairs (steering clearance)
    me_cut = cut.to_mesh('_cut')
    ob_cut = L.link(bpy.data.objects.new('_cut', me_cut))
    b.mods([('BOOLEAN', dict(operation='DIFFERENCE', object=ob_cut, solver='EXACT'))])
    bpy.data.objects.remove(ob_cut)
    b.bevel(0.022, 2, 25)
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
    up.add(firing_port().scale(0.8).move(-0.02, upper_h * 0.55, 0.03))
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

# =============================================================================================== wheels
def tyre_wheel():
    """KI-80 13.00x18 tyre on steel rim, outward = +X. Hub at origin."""
    segs = 40
    prof = [(0.235, -0.125), (0.30, -0.152), (0.39, -0.166), (0.46, -0.162), (0.505, -0.15), (0.532, -0.13),
            (0.547, -0.095), (0.552, -0.04), (0.553, 0.0), (0.552, 0.04), (0.547, 0.095), (0.532, 0.13),
            (0.505, 0.15), (0.46, 0.162), (0.39, 0.166), (0.30, 0.152), (0.235, 0.125)]
    prof = [(r, h, 'tyre') for r, h in prof]
    tyre = lathe(prof, segs, 'x', mat='tyre', cap=False)
    # sidewall rib rings
    for s in (-1, 1):
        rib = lathe([(0.33, s * 0.158, 'tyre'), (0.335, s * 0.168, 'tyre'), (0.345, s * 0.168, 'tyre'), (0.35, s * 0.16, 'tyre')], segs, 'x', mat='tyre', cap=False)
        tyre.add(rib)
    # tread lugs: directional chevron, 2 staggered rows
    n = 22
    R = 0.551
    def lug(theta, side):
        # local (t along circumference, h axial, d radial)
        L_ = [(-0.028, 0.012), (0.028, 0.012), (0.062, 0.15), (0.012, 0.15)]
        vs = []
        bm = bmesh.new()
        top, bot = [], []
        for t, hh in L_:
            for d, lst in ((0.0, bot), (0.026, top)):
                shrink = 0.004 if d > 0 else 0
                tt = t * (1 - shrink * 5)
                a = theta + tt / R
                rr = R + d - (0.012 * (hh / 0.15) ** 2)   # follow crown curvature
                lst.append(bm.verts.new((side * hh, rr * math.cos(a), rr * math.sin(a))))
        bm.faces.new(bot[::-1]); bm.faces.new(top)
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((bot[i], bot[j], top[j], top[i]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        b = B(bm, 'tyre')
        return b
    lugs = B(mat='tyre')
    for i in range(n):
        th = math.tau * i / n
        lugs.add(lug(th, 1))
        lugs.add(lug(th + math.tau / n / 2, -1))
    lugs.bevel(0.005, 1, 30)
    tyre.add(lugs)
    # rim: bead seat, flange, dished disc, hub, tyre-inflation valve housing
    rim = lathe([(0.25, 0.125, 'rim'), (0.236, 0.118, 'rim'), (0.228, 0.10, 'rim'), (0.225, 0.04, 'rim'), (0.20, 0.035, 'rim'),
                 (0.17, 0.06, 'rim'), (0.13, 0.075, 'rim'), (0.12, 0.09, 'rim'), (0.10, 0.10, 'rim'), (0.075, 0.105, 'rim'),
                 (0.07, 0.14, 'rim'), (0.06, 0.15, 'rim'), (0.0, 0.152, 'rim')], 32, 'x', mat='rim', cap=False)
    rim.add(lathe([(0.25, -0.125, 'rim'), (0.236, -0.118, 'rim'), (0.228, -0.10, 'rim'), (0.225, -0.03, 'rim'), (0.0, -0.03, 'rim')], 32, 'x', mat='rim', cap=False))
    # wheel nuts
    for i in range(10):
        a = math.tau * i / 10
        rim.add(bolt(0.016, 0.022, 6, 'rim').rot('Y', 90), Matrix.Translation((0.085, 0.112 * math.cos(a), 0.112 * math.sin(a))))
    # central tyre inflation fitting: cap + elbow pipe + guard
    rim.add(lathe([(0, 0.0), (0.045, 0.0), (0.045, 0.04), (0.03, 0.06), (0, 0.065)], 12, 'x', mat='rim', c=(0.15, 0, 0)))
    rim.add(tube(fillet_path([(0.19, 0, 0.02), (0.22, 0, 0.02), (0.22, 0, 0.12), (0.17, 0, 0.19)], 0.03, 4), 0.011, 6, 'bare'))
    for a in range(6):
        ang = a * math.tau / 6
        rim.add(box(0.03, 0.025, 0.045).rot('X', math.degrees(ang)), Matrix.Translation((0.11, 0.165 * math.cos(ang), 0.165 * math.sin(ang))))
    tyre.add(rim)
    return tyre

# =============================================================================================== turrets
def turret_bpu1():
    """BTR-80 BPU-1: conical turret, KPVT 14.5 mm + coax PKT, 1PZ-2 sight, rear smoke dischargers.
    Turret local: origin at ring centre on hull roof."""
    t = B()
    # conical body: ring base r .72 -> roof r .55 at h .44, front slightly flattened for the gun slot
    pts = []
    for i in range(16):
        a = math.tau * i / 16
        pts.append((0.74 * math.cos(a), 0.74 * math.sin(a), 0.02))
        pts.append((0.56 * math.cos(a), 0.56 * math.sin(a), 0.44))
    body = hull(pts).subsurf(1)
    body.bevel(0.01, 1, 35)
    bv = L.bvh_of(body)
    t.add(body)
    t.add(cyl(0.79, 0.06, 32, 'z', c=(0, 0, 0.03)))     # ring collar
    # gun embrasure housing (armoured block in front)
    emb = hull([(-0.28, 0.45, 0.06), (0.28, 0.45, 0.06), (-0.28, 0.45, 0.4), (0.28, 0.45, 0.4),
                (-0.22, 0.74, 0.12), (0.22, 0.74, 0.12), (-0.22, 0.72, 0.36), (0.22, 0.72, 0.36)], bev=0.015, segs=2)
    t.add(emb)
    # roof hatch (round) + periscopes
    hz = L.drop_on(bv, 0.12, -0.12)[0].z - 0.01
    hat = lathe([(0, 0.06), (0.2, 0.055), (0.24, 0.03), (0.25, 0.0)], 24, 'z', c=(0.12, -0.12, hz))
    hat.add(cyl(0.035, 0.12, 8, 'x', c=(0.12, -0.36, hz + 0.03)))
    hat.add(rail([(0.02, -0.0, hz + 0.06), (0.02, 0.0, hz + 0.1), (0.22, 0.0, hz + 0.1), (0.22, 0.0, hz + 0.06)], r=0.01, rad=0.025))
    t.add(hat)
    # 1PZ-2 sight head, front left
    sh = lathe([(0, 0), (0.1, 0), (0.1, 0.1), (0.085, 0.16), (0.0, 0.17)], 16, 'z', c=(-0.32, 0.28, 0.42))
    sh.add(box(0.12, 0.08, 0.1, c=(-0.32, 0.36, 0.55), bev=0.012, segs=2))
    sh.add(box(0.1, 0.01, 0.06, c=(-0.32, 0.405, 0.55), mat='glass'))
    sh.add(box(0.15, 0.1, 0.012, c=(-0.32, 0.38, 0.61)))
    t.add(sh)
    # periscopes around the roof edge, looking outward (dropped onto the roof surface)
    for ang in (-40, 40, 150, 210):
        a = math.radians(90 + ang)
        loc, n = L.drop_on(bv, 0.4 * math.cos(a), 0.4 * math.sin(a))
        M = Matrix.Translation(loc - V((0, 0, 0.015))) @ Matrix.Rotation(a - math.pi / 2, 4, 'Z')
        t.add(periscope_block(0.14, 0.08, 0.06), M)
    # 902V smoke dischargers: two clusters of 3 on brackets welded to the rear turret wall
    for s in (1, -1):
        a = math.radians(270 + s * 42)
        r = 0.66
        bx, by = r * math.cos(a), r * math.sin(a)
        rotz = a - math.pi / 2
        M = Matrix.Translation((bx, by, 0.26)) @ Matrix.Rotation(rotz, 4, 'Z')
        br = box(0.34, 0.1, 0.03, c=(0, 0.02, 0), bev=0.006, segs=1)
        br.add(box(0.03, 0.09, 0.12, c=(-0.15, -0.03, -0.05)))
        br.add(box(0.03, 0.09, 0.12, c=(0.15, -0.03, -0.05)))
        for i in range(3):
            tb = lathe([(0, -0.09), (0.045, -0.09), (0.045, 0.1), (0.038, 0.1), (0.038, -0.06), (0, -0.06)], 12, 'y')
            # tubes point forward-outward and up (launch over the turret)
            tb.rot('X', 40).rot('Z', s * 150)
            tb.move((i - 1) * 0.1, 0.06, 0.07)
            br.add(tb)
        t.add(br, M)
    # bolts on roof
    for i in range(12):
        a = math.tau * i / 12
        loc, n = L.drop_on(bv, 0.3 * math.cos(a), 0.3 * math.sin(a))
        if loc is not None:
            t.add(bolt(0.012, 0.01), L.place(L.frame_from_normal(n), loc))
    return t

def gun_bpu1():
    """KPVT + PKT on common cradle. Local origin = trunnion (gun_pivot)."""
    g = B()
    # cradle / mantlet face
    g.add(box(0.36, 0.12, 0.2, c=(0.0, 0.0, 0.0), bev=0.02, segs=2))
    # KPVT: barrel jacket (heavy perforated shroud) then barrel + flash hider
    kx = -0.06
    jacket = lathe([(0, 0), (0.06, 0), (0.06, 0.36), (0.05, 0.4), (0.05, 0.62), (0.03, 0.66), (0, 0.66)], 16, 'y', mat='gunmetal')
    g.add(jacket.move(kx, 0.06, 0))
    for i in range(6):
        g.add(cyl(0.064, 0.025, 16, 'y', c=(kx, 0.12 + i * 0.05, 0), mat='gunmetal'))
    g.add(cyl(0.022, 1.0, 12, 'y', c=(kx, 1.15, 0), mat='gunmetal'))
    g.add(lathe([(0.0, 0), (0.035, 0.0), (0.035, 0.16), (0.03, 0.17), (0.0, 0.17)], 12, 'y', mat='gunmetal', c=(kx, 1.6, 0)))
    # PKT coax to the right
    px = 0.13
    g.add(cyl(0.035, 0.2, 10, 'y', c=(px, 0.15, -0.01), mat='gunmetal'))
    g.add(cyl(0.012, 0.42, 8, 'y', c=(px, 0.45, -0.01), mat='gunmetal'))
    g.add(cyl(0.018, 0.06, 8, 'y', c=(px, 0.68, -0.01), mat='gunmetal'))
    muzzle = (kx, 1.77, 0.0)
    coax = (px, 0.71, -0.01)
    return g, muzzle, coax

def turret_bppu():
    """BTR-82A BPPU: larger welded turret, 2A72 30 mm + PKTM, TKN-4GA / 1PZ-9 sights, 3+3 smoke tubes."""
    t = B()
    # lower faceted collar (frustum) + upper armoured box
    pts = []
    for i in range(12):
        a = math.tau * (i + 0.5) / 12
        pts.append((0.8 * math.cos(a), 0.8 * math.sin(a), 0.0))
        pts.append((0.7 * math.cos(a), 0.7 * math.sin(a), 0.3))
    t.add(hull(pts, bev=0.02, segs=2))
    up = hull([(-0.62, -0.62, 0.28), (0.62, -0.62, 0.28), (-0.66, 0.42, 0.28), (0.66, 0.42, 0.28),
               (-0.5, 0.76, 0.32), (0.5, 0.76, 0.32),
               (-0.55, -0.58, 0.66), (0.55, -0.58, 0.66), (-0.56, 0.36, 0.66), (0.56, 0.36, 0.66),
               (-0.42, 0.62, 0.6), (0.42, 0.62, 0.6)], bev=0.022, segs=2)
    t.add(up)
    t.add(cyl(0.84, 0.06, 36, 'z', c=(0, 0, 0.03)))
    # gun slot frame on front
    t.add(box(0.5, 0.06, 0.24, c=(0.0, 0.72, 0.44), bev=0.012, segs=1))
    # commander's TKN-4GA head (left) and gunner's 1PZ-9 (right) on roof
    for sx, hgt in ((-0.32, 0.26), (0.3, 0.2)):
        s = lathe([(0, 0), (0.12, 0), (0.12, 0.06), (0.1, 0.08), (0.0, 0.08)], 16, 'z', c=(sx, 0.2, 0.66))
        s.add(box(0.2, 0.22, hgt, c=(sx, 0.24, 0.72 + hgt / 2), bev=0.02, segs=2))
        s.add(box(0.16, 0.01, hgt * 0.45, c=(sx, 0.355, 0.73 + hgt * 0.55), mat='glass'))
        s.add(box(0.24, 0.12, 0.015, c=(sx, 0.32, 0.74 + hgt)))
        t.add(s)
    # hatch
    t.add(lathe([(0, 0.05), (0.22, 0.045), (0.26, 0.02), (0.27, 0.0)], 24, 'z', c=(0.05, -0.25, 0.66)))
    t.add(rail([(-0.05, -0.25, 0.71), (-0.05, -0.25, 0.75), (0.15, -0.25, 0.75), (0.15, -0.25, 0.71)], r=0.01, rad=0.025))
    t.add(cyl(0.035, 0.14, 8, 'x', c=(0.05, -0.52, 0.69)))
    # wind sensor mast + antenna at rear
    t.add(cyl(0.012, 0.35, 6, 'z', c=(-0.45, -0.45, 0.83), mat='gunmetal'))
    t.add(cyl(0.03, 0.05, 8, 'z', c=(-0.45, -0.45, 1.0)))
    # 902V smoke dischargers: row of 3 per side on the upper front corners, facing forward and up
    for s in (1, -1):
        br = box(0.36, 0.14, 0.03, bev=0.006, segs=1)
        for i in range(3):
            tb = lathe([(0, -0.1), (0.045, -0.1), (0.045, 0.11), (0.038, 0.11), (0.038, -0.07), (0, -0.07)], 12, 'y')
            tb.rot('X', 18).rot('Z', -s * (8 + 8 * i))
            tb.move((i - 1) * 0.11, 0.02, 0.06)
            br.add(tb)
        t.add(br, Matrix.Translation((s * 0.52, 0.42, 0.64)) @ Matrix.Rotation(math.radians(-s * 15), 4, 'Z'))
    # stowage box on turret rear
    t.add(box(1.0, 0.25, 0.3, c=(0, -0.78, 0.38), bev=0.015, segs=2))
    for x in (-0.3, 0.3):
        t.add(rail([(x, -0.9, 0.42), (x, -0.95, 0.42), (x, -0.95, 0.32), (x, -0.9, 0.32)], r=0.008, rad=0.02))
    # bolts
    for x in np.linspace(-0.45, 0.45, 6):
        for y in (-0.45, 0.25):
            t.add(bolt(0.012, 0.01), Matrix.Translation((x, y, 0.66)))
    return t

def gun_2a72():
    g = B()
    g.add(box(0.46, 0.16, 0.22, c=(0.0, 0.0, 0.0), bev=0.025, segs=2))       # mantlet
    # 2A72: recoil sleeve / barrel jacket then thin barrel and muzzle brake
    g.add(lathe([(0, 0), (0.075, 0), (0.075, 0.08), (0.065, 0.1), (0.065, 0.78), (0.055, 0.82), (0.0, 0.82)], 18, 'y', mat='rolled', c=(0, 0.06, 0)))
    for i in range(3):
        g.add(cyl(0.072, 0.03, 18, 'y', c=(0, 0.25 + i * 0.22, 0)))
    g.add(cyl(0.026, 1.45, 14, 'y', c=(0, 1.58, 0), mat='gunmetal'))
    g.add(lathe([(0.0, 0), (0.038, 0), (0.042, 0.03), (0.042, 0.2), (0.036, 0.22), (0, 0.22)], 14, 'y', mat='gunmetal', c=(0, 2.26, 0)))
    for i in range(3):
        g.add(box(0.012, 0.03, 0.09, c=(0.0, 2.33 + i * 0.045, 0), mat='gunmetal').rot('Y', 90, (0, 2.33, 0)))
    # PKTM coax right
    px = 0.21
    g.add(cyl(0.03, 0.18, 10, 'y', c=(px, 0.12, 0.0), mat='gunmetal'))
    g.add(cyl(0.012, 0.36, 8, 'y', c=(px, 0.38, 0.0), mat='gunmetal'))
    g.add(cyl(0.017, 0.06, 8, 'y', c=(px, 0.58, 0.0), mat='gunmetal'))
    return g, (0, 2.48, 0), (px, 0.61, 0.0)

# =============================================================================================== build
def build(variant):
    t0 = time.time()
    L.reset()
    is82 = variant == 'btr82a'
    name = variant
    root = L.node_empty('root')
    hullE = L.node_empty('hull', root, (0, 0, 0))

    H = hull_shell()
    # ---- weld seams along main plate joints
    for s in (1, -1):
        H.add(weld_line([(s * CH_X, -3.0, CH_Z + 0.004), (s * CH_X, 1.2, CH_Z + 0.004)]))
        H.add(weld_line([(s * (RF_X - 0.005), -3.2, ROOF - 0.004), (s * (RF_X - 0.005), 2.25, ROOF - 0.004)]))
    H.add(weld_line([(-1.1, 2.73, 1.623), (1.1, 2.73, 1.623)]))
    H.add(weld_line([(-1.0, 2.29, ROOF - 0.003), (1.0, 2.29, ROOF - 0.003)]))
    H.add(weld_line([(-0.95, 3.83, 1.045), (0.95, 3.83, 1.045)]))
    H.add(weld_line([(-1.0, -3.27, ROOF - 0.003), (1.0, -3.27, ROOF - 0.003)]))
    H.add(weld_line([(-1.2, -3.83, 1.36), (1.2, -3.83, 1.36)]))
    # roof plate seam lines (engine deck plate edges)
    H.add(box(2.1, 0.02, 0.012, c=(0, -1.55, ROOF + 0.004)))

    # ---- front: windscreen armour shutters, periscopes, trim vane, headlights, hooks
    gl_n = V((0, 0.664, 0.747))
    Mws = L.frame_from_normal(gl_n, V((0, 0, 1)))
    for s in (1, -1):
        c = V((s * 0.47, 2.55, 1.81)) + gl_n * 0.02
        sh = box(0.78, 0.34, 0.035, bev=0.008, segs=1)
        sh.add(cyl(0.025, 0.7, 10, 'x', c=(0, 0.19, 0.0)))
        for x in (-0.28, 0.0, 0.28):
            sh.add(box(0.06, 0.05, 0.015, c=(x, 0.15, 0.02)))
        sh.add(rail([(-0.1, -0.08, 0.017), (-0.1, -0.08, 0.06), (0.1, -0.08, 0.06), (0.1, -0.08, 0.017)], r=0.009, rad=0.02))
        sh.add(box(0.1, 0.012, 0.03, c=(0.22, -0.02, 0.025), mat='glass'))   # vision slit block
        H.add(sh, L.place(Mws.to_3x3().to_4x4(), c))
    for s in (1, -1):
        for i in range(3):
            M = Matrix.Translation((s * (0.3 + i * 0.2), 2.28, ROOF - 0.02)) @ Matrix.Rotation(math.radians(s * -10 * (i - 1)), 4, 'Z')
            H.add(periscope_block(0.17, 0.1, 0.07), M)
    # upper glacis plane
    up_n = V((0, 0.482, 0.876))
    Mg = L.frame_from_normal(up_n, V((0, 0, 1)))
    def on_glacis(x, y):
        z = 1.04 + (3.84 - y) * 0.55
        return V((x, y, z))
    # trim vane folded on glacis
    tv = B()
    tv.add(prism([(-0.7, -0.36), (0.7, -0.36), (0.86, 0.36), (-0.86, 0.36)], 0.025, 'z', c=0.0125, bev=0.008, segs=1))
    for x in (-0.52, -0.18, 0.18, 0.52):
        tv.add(box(0.03, 0.66, 0.04, c=(x, 0, 0.04), bev=0.006, segs=1))
    tv.add(box(1.66, 0.04, 0.04, c=(0, 0.33, 0.04), bev=0.006, segs=1))
    tv.add(rail([(-0.15, 0.1, 0.025), (-0.15, 0.1, 0.08), (0.15, 0.1, 0.08), (0.15, 0.1, 0.025)], r=0.01, rad=0.02))
    for x in (-0.55, -0.18, 0.18, 0.55):
        tv.add(cyl(0.03, 0.16, 10, 'x', c=(x, -0.38, 0.02)))
    H.add(tv, L.place(Mg.to_3x3().to_4x4(), on_glacis(0, 3.42) + up_n * 0.06))
    for s in (1, -1):
        p = on_glacis(s * 0.86, 3.0)
        H.add(headlight_cluster(s), Matrix.Translation(p) @ Matrix.Rotation(math.radians(-6), 4, 'X'))
    for s in (1, -1):
        H.add(tow_hook().rot('X', -25), Matrix.Translation((s * 0.55, 3.72, 0.9)))
    # winch cable port
    H.add(box(0.3, 0.06, 0.16, c=(0, 3.62, 0.86), bev=0.01, segs=1).rot('X', -40, (0, 3.62, 0.86)))
    # front lower glacis bolted access plate
    H.add(box(1.0, 0.012, 0.3, c=(0, 3.38, 0.75), bev=0.004, segs=1).rot('X', 56, (0, 3.38, 0.75)))
    # ---- roof hatches: driver (left) + commander (right)
    for s in (1, -1):
        H.add(hatch_rect(0.62, 0.58, c=(s * 0.5, 2.0, ROOF), hinge='y+'))
    # turret ring collar
    TY = 0.95
    H.add(lathe([(0.82, 0), (0.86, 0), (0.86, 0.035), (0.8, 0.05)], 40, 'z', c=(0, TY, ROOF)))
    # troop hatches behind turret
    for s in (1, -1):
        H.add(hatch_rect(0.55, 0.62, c=(s * 0.48, -0.42, ROOF), hinge='y-'))
    # engine deck: louvre intakes, access hatch, filler caps
    for s in (1, -1):
        H.add(louvre_panel(0.68, 1.0, 10), Matrix.Translation((s * 0.55, -2.35, ROOF)))
    H.add(hatch_rect(0.32, 1.1, t=0.03, c=(0, -2.35, ROOF), hinge='y+', rad=0.03))
    for s in (1, -1):
        H.add(lathe([(0, 0.04), (0.07, 0.04), (0.08, 0.02), (0.08, 0)], 16, 'z', c=(s * 0.98, -1.75, ROOF - 0.01)))
        H.add(antenna_base(), Matrix.Translation((s * 0.9, -3.05, ROOF)))
    # roof grab rails along edges
    for s in (1, -1):
        H.add(rail([(s * 1.0, -1.2, ROOF), (s * 1.0, -1.2, ROOF + 0.07), (s * 1.0, -0.2, ROOF + 0.07), (s * 1.0, -0.2, ROOF)], r=0.012, rad=0.04))
        H.add(rail([(s * 1.0, 1.2, ROOF), (s * 1.0, 1.2, ROOF + 0.07), (s * 1.0, 1.7, ROOF + 0.07), (s * 1.0, 1.7, ROOF)], r=0.012, rad=0.04))
    # ---- sides: doors, ports, periscopes, exhausts, tools, cable
    for s in (1, -1):
        Mu = frame_upper(s)
        Ml = frame_lower(s)
        up, lo = door()
        # local frame: x_local = along hull. frame_from_normal gives x = up x n.
        # Build explicit matrices so that local +x = +Y(fwd), +y = up-the-plate, +z = normal
        def plate_M(n, s):
            n = V((n.x * s, 0, n.z)).normalized()
            xx = V((0, 1, 0))
            yy = n.cross(xx) * -1
            if yy.z < 0:
                yy = -yy
            M = Matrix((xx, yy, n)).transposed().to_4x4()
            if M.to_3x3().determinant() < 0:
                M = Matrix((xx * -1, yy, n)).transposed().to_4x4()
            return M
        MU = plate_M(N_UP, s); ML = plate_M(N_LO, s)
        dy = -0.2
        cu = V((s * x_upper(CH_Z + 0.01), dy, CH_Z + 0.01))
        H.add(up if s == 1 else up.scale(1, 1, 1), L.place(MU.to_3x3().to_4x4(), cu))
        H.add(lo, L.place(ML.to_3x3().to_4x4(), cu))
        # firing ports + periscopes above
        for yy in (1.0, -1.05, -1.75):
            pz = 1.62
            H.add(firing_port(), L.place(MU.to_3x3().to_4x4(), on_upper(yy, pz, 0.0, s)))
            H.add(periscope_block(0.16, 0.09, 0.06), Matrix.Translation((s * (RF_X - 0.06), yy, ROOF - 0.01)) @ Matrix.Rotation(-s * math.pi / 2, 4, 'Z'))
        # forward firing port in the angled cab side
        H.add(firing_port(), L.place(MU.to_3x3().to_4x4(), on_upper(1.85, 1.6, 0.0, s)))
        H.add(periscope_block(0.16, 0.09, 0.06), Matrix.Translation((s * (RF_X - 0.06), 1.85, ROOF - 0.01)) @ Matrix.Rotation(-s * math.pi / 2 + s * 0.4, 4, 'Z'))
        # exhaust muffler, rear upper side
        H.add(exhaust_box(s), L.place(MU.to_3x3().to_4x4() if False else Matrix.Identity(4), on_upper(-2.85, 1.4, 0.0, s)))
        # tow cable on upper side plate
        c0 = on_upper(0.55, 1.88, 0.04, s); c1 = on_upper(-2.3, 1.88, 0.04, s)
        H.add(tow_cable(c0, c1, 0.0))
        for yy in (0.4, -0.9, -2.15):
            H.add(box(0.06, 0.05, 0.06), L.place(MU.to_3x3().to_4x4(), on_upper(yy, 1.88, 0.02, s)))
        # side marker light + mirror bracket stub
        H.add(cyl(0.04, 0.05, 10, 'x', c=(s * (x_upper(1.5) + 0.02), 2.35, 1.5)))
        H.add(cyl(0.032, 0.008, 10, 'x', c=(s * (x_upper(1.5) + 0.047), 2.35, 1.5), mat='light'))
        # mud flaps behind wheel 1 and 4
        for yy in (AXLES[0] - 0.68, AXLES[3] - 0.68):
            H.add(box(0.36, 0.012, 0.32, c=(s * 1.2, yy, 0.82), mat='skirt', bev=0.004, segs=1))
    # tools: shovel + crowbar on right upper side
    sh = tool_shovel()
    H.add(sh, L.place(plate_M(N_UP, 1), on_upper(1.25, 1.45, 0.03, 1)))
    for yy in (0.95, 1.55):
        H.add(box(0.04, 0.06, 0.05), L.place(plate_M(N_UP, 1), on_upper(yy, 1.45, 0.02, 1)))
    H.add(tube([on_upper(0.4, 1.48, 0.03, -1), on_upper(1.5, 1.48, 0.03, -1)], 0.014, 6, 'bare'))
    # ---- rear: plates, lights, water-jet flap, tow pintle, rear hatch
    for s in (1, -1):
        rl = box(0.16, 0.06, 0.1, c=(s * 0.98, -3.72, 1.55), bev=0.01, segs=1)
        rl.add(box(0.12, 0.01, 0.06, c=(s * 0.98, -3.755, 1.55), mat='light'))
        for x in (-0.09, 0.09):
            rl.add(rail([(s * 0.98 + x, -3.62, 1.47), (s * 0.98 + x, -3.84, 1.5), (s * 0.98 + x, -3.84, 1.64), (s * 0.98 + x, -3.66, 1.66)], r=0.008, rad=0.03, foot=False))
        H.add(rl)
        H.add(tow_hook().rot('Z', 180).rot('X', 20), Matrix.Translation((s * 0.6, -3.66, 0.95)))
    # water jet outlet with flap
    wj = lathe([(0, 0.0), (0.2, 0.0), (0.22, 0.03), (0.21, 0.06), (0, 0.06)], 24, 'y', c=(0, -3.62, 0.85))
    wj.rot('X', -38, (0, -3.62, 0.85))
    H.add(wj)
    H.add(lathe([(0.0, 0), (0.06, 0), (0.06, 0.12), (0.0, 0.12)], 12, 'y', c=(0, -3.86, 1.2)).rot('X', 180, (0, -3.86, 1.2)))
    # rear upper plate hatch (engine access)
    H.add(box(1.2, 0.03, 0.42, c=(0, -3.58, 1.72), bev=0.008, segs=1).rot('X', -50, (0, -3.58, 1.72)))
    for x in (-0.4, 0.4):
        H.add(rail([(x - 0.1, -3.6, 1.62), (x - 0.1, -3.66, 1.62), (x + 0.1, -3.66, 1.62), (x + 0.1, -3.6, 1.62)], r=0.01, rad=0.02))

    if is82:
        # BTR-82A: spall-liner era: additional roof periscope, rear stowage box & tarpaulin roll
        H.add(box(0.9, 0.35, 0.32, c=(0, -3.0, ROOF + 0.16), bev=0.02, segs=2))
        H.add(cyl(0.13, 1.6, 16, 'x', c=(0, -1.5, ROOF + 0.13), mat='canvas'))
        for x in (-0.5, 0.0, 0.5):
            H.add(lathe([(0.134, -0.02), (0.14, -0.02), (0.14, 0.02), (0.134, 0.02)], 16, 'x', c=(x, -1.5, ROOF + 0.13), mat='bare', cap=False))
    print('  hull tris', H.tris(), '%.1fs' % (time.time() - t0))
    hull_mesh = L.node_mesh('hull_geo', H, hullE, (0, 0, 0))

    # ---------------------------------------------------------------------------- turret + gun
    tz = ROOF + 0.05
    if is82:
        TU = turret_bppu(); G, mz, cx = gun_2a72(); trun = (0, 0.66, 0.44)
    else:
        TU = turret_bpu1(); G, mz, cx = gun_bpu1(); trun = (0, 0.62, 0.24)
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
        L.node_empty('smoke_launchers', turE, (0, TY + 0.1, tz + 0.75))
    else:
        L.node_empty('smoke_launchers', turE, (0, TY - 0.45, tz + 0.42))

    # ---------------------------------------------------------------------------- wheels
    W = tyre_wheel()
    Wl = L.B.__new__(L.B); Wl.bm = W.bm.copy(); Wl.scale(-1, 1, 1)
    meR = None; meL = None
    wheel_objs = []
    for side, tag in ((1, 'R'), (-1, 'L')):
        # authoring right = +X; tag 'R' is vehicle right
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
    L.node_empty('exhaust', hullE, tuple(on_upper(-3.25, 1.52, 0.16, -1)))
    L.node_empty('dismount_L', hullE, (-1.95, -0.2, 0.0))
    L.node_empty('dismount_R', hullE, (1.95, -0.2, 0.0))
    L.node_empty('commander_hatch', hullE, (0.5, 2.0, ROOF + 0.05))

    print('  geometry done %.1fs' % (time.time() - t0))
    lod0 = [hull_mesh, tur_mesh, gun_mesh] + wheel_objs
    return dict(root=root, hull=hullE, turret=turE, gun=gunE, lod0=lod0, gun_obj=gun_mesh, tur_obj=tur_mesh,
                atlas=[hull_mesh, tur_mesh, gun_mesh, wheel_objs[0], wheel_objs[4]],
                tp=tp, TY=TY, tz=tz)

def decals_ua(P, N):
    """White crosses (common Ukrainian field ID marks).  Positions in authoring frame -> export frame."""
    m = np.zeros(P.shape[:2], np.float32)
    E = lambda p: (-p[0], -p[1], p[2])
    for s_ in (1, -1):
        c = (s_ * x_upper(1.6), -2.25, 1.6)
        n = (s_ * N_UP.x, 0, N_UP.z)
        m += T.decal_mask(P, N, E(c), E(n), (0, 0, 1), T.cross_shape(0.17, 0.04))
    m += T.decal_mask(P, N, E((0, -3.55, 1.7)), E((0, -0.74, 0.67)), (0, 0, 1), T.cross_shape(0.16, 0.038))
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
    scheme = 'ru_green' if variant == 'btr82a' else 'ua_green'
    dec = decals_ru if variant == 'btr82a' else decals_ua
    info = VB.finalize(d, variant, scheme, dec, wreck_btr)
    print(json.dumps({k: v for k, v in info.items() if k != 'nodes'}))
    return info

if __name__ == '__main__':
    main(sys.argv[-1])
