"""Civilian double-cab pickup (generic Toyota Hilux / Mitsubishi L200 class, no badges) used as the basic wounded-evacuation
vehicle (src/game/medevac.js): dirty white paint, red crosses, steel bull bar, roof rack with the spare wheel, open bed
with room for three casualties lying lengthwise (tailgate down).

Reference data (Hilux AN120 double cab 2016-24 / L200 Triton 2015-24, public spec sheets):
  length 5.33 m, width 1.855 m, height 1.815 m (1.95 m over the roof rack), wheelbase 3.085 m, track 1.54 m,
  265/65 R17 tyres (dia 0.776 m), ground clearance 0.29 m, bed 1.52 x 1.51 m (1.10 m between the arches),
  bed floor ~0.86 m above the ground, bed walls 0.48 m, kerb mass ~2.1 t, 0-100 km/h ~11 s.
Authoring frame: X right, Y forward, Z up (see vlib); finalize_frame flips it to the glTF / three.js frame.

Animatable nodes (glTF names):
  door_FL / door_FR / door_RL / door_RR  - hinge empties on the front edge of each door, open = rotation.y (see manifest doors)
  tailgate                              - hinge empty on the bottom edge, open = rotation.x
  steer_L1 / steer_R1                   - front wheel steering empties (rotation.y), parents of wheel_L1 / wheel_R1
  wheel_L1 / wheel_R1 / wheel_L2 / wheel_R2 - spin empties (rotation.x = distance / wheel_radius_m)
Empties: ride_seat_1..3 (cab seats, seat_type 'cab'), cab_door_* (doorway centre outside each door),
  dismount_L / dismount_R (ground points beside the front doors), stretcher_1..3 (bed floor, +Z towards the tailgate:
  a casualty lies head towards the cab), load_point (ground behind the open tailgate, +Z facing the truck), exhaust.
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

NAME = 'pickup'
AXF, AXR = 1.64, -1.44          # axle stations (wheelbase 3.08)
TRACK = 1.54
WR, WW = 0.388, 0.265           # 265/65 R17
WZ = 0.388                      # hub height (sits on the tyre)
RA = 0.465                      # wheel-arch radius
BW = 0.895                      # half body width
SILL = 0.47
BELT = 1.13
FRONT, REAR = 2.53, -2.60       # body front face / bed rear face
CAB_F, CAB_R = 1.17, -0.98      # windscreen base / cab rear wall (belt line)
ROOF_Z = 1.79
ROOF_F, ROOF_R = 0.50, -0.91
GH_X0, GH_X1 = 0.86, 0.69       # greenhouse half width at the belt / at the roof
BED_Y = (-1.03, REAR)
BED_FLOOR, BED_TOP = 0.88, 1.33
BED_IN = 0.77                   # inner half width of the bed
TG_Z = 0.90                     # tailgate hinge height
DOORS = {'F': (1.11, 0.05), 'R': (-0.01, -0.90)}     # door y extents (front edge = hinge, rear edge)


def gh_x(z):
    """greenhouse side x at height z (sloping inward to the roof)"""
    return GH_X0 - (z - BELT) / (ROOF_Z - BELT) * (GH_X0 - GH_X1)


def a_pillar_y(z):
    return CAB_F - (z - BELT) / (ROOF_Z - BELT) * (CAB_F - ROOF_F)


def beam(p0, p1, w, h, mat='rolled', up=(0, 0, 1), bev=None):
    """box of cross-section w x h from p0 to p1 (h along `up` projected)"""
    p0, p1 = V(p0), V(p1)
    d = (p1 - p0); ln = d.length; d.normalize()
    u = V(up); u = (u - d * u.dot(d)).normalized()
    x = d.cross(u)
    M = Matrix((x, d, u)).transposed().to_4x4()
    M.translation = (p0 + p1) / 2
    b = box(w, ln, h, mat=mat, bev=bev, segs=1)
    return b.xf(M)


def frame_loop(pts, w=0.022, mat='skirt'):
    """rubber surround / frame: square beams along a closed polyline (tube() twists on sharp closed corners)"""
    b = B(mat=mat)
    n = len(pts)
    for i in range(n):
        p0, p1 = V(pts[i]), V(pts[(i + 1) % n])
        d = (p1 - p0).normalized()
        b.add(beam(p0 - d * w * 0.5, p1 + d * w * 0.5, w, w, mat=mat, up=(0, 0, 1) if abs(d.z) < 0.9 else (1, 0, 0)))
    return b


def side_slab(poly_yz, side, off, thick, mat='rolled', bev=None):
    """thin solid lying on the greenhouse / body side: poly in (y, z); x follows gh_x(z) above the belt, BW below; `off` out"""
    bm = bmesh.new()
    def xo(z, o):
        base = gh_x(z) if z > BELT + 1e-4 else BW
        return side * (base + o)
    outer = [bm.verts.new((xo(z, off + thick / 2), y, z)) for y, z in poly_yz]
    inner = [bm.verts.new((xo(z, off - thick / 2), y, z)) for y, z in poly_yz]
    n = len(poly_yz)
    bm.faces.new(outer); bm.faces.new(inner[::-1])
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((outer[i], inner[i], inner[j], outer[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    b = B(bm, mat)
    if bev:
        b.bevel(bev, 1, 30)
    return b


def arch_pts(yc, zc, r, z_cut, n=16, rev=False):
    a0 = math.asin(max(-1, min(1, (z_cut - zc) / r)))
    aa = np.linspace(math.pi - a0, a0, n)
    if rev:
        aa = aa[::-1]
    return [(yc + r * math.cos(a), zc + r * math.sin(a)) for a in aa]


# ================================================================================================ wheel
def wheel():
    """265/65 R17 all-terrain tyre on a 6-spoke steel-look rim; outward = +X, hub at the origin."""
    segs = 40
    hw = WW / 2
    prof = [(0.222, -0.112), (0.27, -0.128), (0.33, -0.133), (0.365, -0.127), (0.381, -0.11), (0.386, -0.07),
            (0.388, 0.0), (0.386, 0.07), (0.381, 0.11), (0.365, 0.127), (0.33, 0.133), (0.27, 0.128), (0.222, 0.112)]
    t = lathe([(r, h, 'tyre') for r, h in prof], segs, 'x', mat='tyre', cap=False)
    # all-terrain tread blocks: two staggered rows + shoulder lugs
    R = 0.386
    n = 26
    blk = B(mat='tyre')
    for i in range(n):
        th = math.tau * i / n
        for row, (x0, w, l) in enumerate(((0.05, 0.075, 0.07), (-0.05, 0.075, 0.07))):
            a = th + (math.tau / n / 2 if row else 0)
            b = box(w, l, 0.016, mat='tyre', bev=0.004, segs=1)
            b.xf(Matrix.Rotation(a - math.pi / 2, 4, 'X'))
            blk.add(b, Matrix.Translation((x0, (R + 0.004) * math.cos(a), (R + 0.004) * math.sin(a))))
        for s in (-1, 1):
            a = th + math.tau / n / 4 * s
            b = box(0.045, 0.06, 0.03, mat='tyre', bev=0.004, segs=1)
            b.xf(Matrix.Rotation(a - math.pi / 2, 4, 'X'))
            blk.add(b, Matrix.Translation((s * 0.118, (R - 0.012) * math.cos(a), (R - 0.012) * math.sin(a))))
    t.add(blk)
    for s in (-1, 1):   # sidewall lettering band (raised ring)
        t.add(lathe([(0.30, s * 0.131, 'tyre'), (0.302, s * 0.137, 'tyre'), (0.318, s * 0.137, 'tyre'), (0.32, s * 0.131, 'tyre')], segs, 'x', mat='tyre', cap=False))
    rim = lathe([(0.224, 0.112, 'rim'), (0.214, 0.104, 'rim'), (0.21, 0.08, 'rim'), (0.21, 0.03, 'rim'), (0.19, 0.025, 'rim'),
                 (0.16, 0.05, 'rim'), (0.10, 0.07, 'rim'), (0.06, 0.08, 'rim'), (0.0, 0.085, 'rim')], 36, 'x', mat='rim', cap=False)
    rim.add(lathe([(0.224, -0.112, 'rim'), (0.214, -0.104, 'rim'), (0.21, -0.08, 'rim'), (0.21, -0.03, 'rim'), (0.0, -0.03, 'rim')], 36, 'x', mat='rim', cap=False))
    for i in range(6):          # spoke windows (dark holes)
        a = math.tau * i / 6 + 0.26
        h = cyl(0.04, 0.01, 12, 'x', mat='gunmetal').scale(1, 1.0, 1.45).rot('X', math.degrees(a) - 90)
        rim.add(h.move(0.064, 0.15 * math.cos(a), 0.15 * math.sin(a)))
    for i in range(6):
        a = math.tau * i / 6
        rim.add(bolt(0.012, 0.018, 6, 'bare').rot('Y', 90), Matrix.Translation((0.083, 0.07 * math.cos(a), 0.07 * math.sin(a))))
    rim.add(lathe([(0, 0.0), (0.035, 0.0), (0.035, 0.02), (0.022, 0.03), (0, 0.032)], 12, 'x', mat='bare', c=(0.085, 0, 0)))
    t.add(rim)
    return t


# ================================================================================================ body
def lower_body():
    """front + cab lower body: side profile extruded across the width, front arch cut in, bonnet crown + shoulder bevel"""
    poly = [(CAB_R, SILL + 0.02)]
    poly += arch_pts(AXF, WZ, RA, SILL, 18)
    poly += [(2.40, SILL + 0.02), (FRONT, 0.56), (FRONT + 0.03, 0.80), (FRONT, 0.99), (2.44, 1.06), (1.80, 1.10), (CAB_F, BELT),
             (CAB_R + 0.04, BELT), (CAB_R, BELT - 0.04)]
    b = prism(poly, 2 * BW, 'x', mat='rolled')
    # plan-view rounding: taper the nose
    for v in b.bm.verts:
        if v.co.y > 2.0:
            k = (v.co.y - 2.0) / (FRONT + 0.03 - 2.0)
            v.co.x *= 1 - 0.07 * k ** 2
        if v.co.z > 1.0 and v.co.y > CAB_F - 0.02:      # bonnet crown: edges fall away
            v.co.z -= 0.03 * (abs(v.co.x) / BW) ** 2
    b.bevel(0.045, 3, 25)
    return b


def bed_body():
    B_ = B()
    y0, y1 = BED_Y
    for s in (1, -1):
        prof = [(y0, SILL + 0.04), (y0, BED_TOP), (y1, BED_TOP), (y1, SILL + 0.06)]
        ap = arch_pts(AXR, WZ, RA, SILL + 0.05, 16)
        prof += ap[::1] if ap[0][0] < ap[-1][0] else ap[::-1]
        w = prism(prof, BW - BED_IN, 'x', c=s * (BED_IN + BW) / 2, mat='rolled')
        w.bevel(0.03, 2, 25)
        B_.add(w)
        # top rail cap (rounded) + stake pockets
        B_.add(box(BW - BED_IN + 0.02, y0 - y1 + 0.01, 0.035, c=(s * (BED_IN + BW) / 2, (y0 + y1) / 2, BED_TOP + 0.012), bev=0.014, segs=2))
        for yy in (y0 - 0.12, y1 + 0.12):
            B_.add(box(0.06, 0.045, 0.006, c=(s * (BED_IN + BW) / 2, yy, BED_TOP + 0.031), mat='decal'))
        # inner wheel-arch hump
        B_.add(hull([(s * BED_IN, AXR + 0.42, BED_FLOOR), (s * BED_IN, AXR - 0.42, BED_FLOOR), (s * (BED_IN - 0.2), AXR + 0.4, BED_FLOOR),
                     (s * (BED_IN - 0.2), AXR - 0.4, BED_FLOOR), (s * BED_IN, AXR + 0.3, BED_FLOOR + 0.25), (s * BED_IN, AXR - 0.3, BED_FLOOR + 0.25),
                     (s * (BED_IN - 0.2), AXR + 0.28, BED_FLOOR + 0.24), (s * (BED_IN - 0.2), AXR - 0.28, BED_FLOOR + 0.24)], bev=0.03, segs=2))
        # tie-down hooks
        for yy in (y0 - 0.2, y1 + 0.25):
            B_.add(rail([(s * (BED_IN - 0.005), yy - 0.05, BED_FLOOR + 0.32), (s * (BED_IN - 0.04), yy - 0.05, BED_FLOOR + 0.32),
                         (s * (BED_IN - 0.04), yy + 0.05, BED_FLOOR + 0.32), (s * (BED_IN - 0.005), yy + 0.05, BED_FLOOR + 0.32)], r=0.008, rad=0.015, mat='bare'))
        # tail-lamp clusters on the rear corners (red 'era' kind, amber 'cage' kind)
        B_.add(box(0.13, 0.04, 0.34, c=(s * (BW - 0.075), y1 - 0.01, 1.08), bev=0.012, segs=2, mat='era'))
        B_.add(box(0.13, 0.042, 0.07, c=(s * (BW - 0.075), y1 - 0.012, 0.88), bev=0.01, segs=1, mat='cage'))
        B_.add(box(0.15, 0.03, 0.44, c=(s * (BW - 0.075), y1 + 0.003, 1.06), bev=0.01, segs=1, mat='skirt'))
    # bed floor (bed liner) with ribs, front bulkhead, rear sill
    B_.add(box(2 * BED_IN, y0 - y1, 0.05, c=(0, (y0 + y1) / 2, BED_FLOOR - 0.025), mat='canvas'))
    for i in range(9):
        x = -BED_IN + 0.12 + i * (2 * BED_IN - 0.24) / 8
        B_.add(box(0.05, y0 - y1 - 0.08, 0.018, c=(x, (y0 + y1) / 2, BED_FLOOR + 0.009), bev=0.008, segs=1, mat='canvas'))
    B_.add(box(2 * BW, 0.06, BED_TOP - SILL - 0.04, c=(0, y0 + 0.03, (BED_TOP + SILL + 0.04) / 2), bev=0.015, segs=1))
    B_.add(box(2 * BED_IN, 0.06, 0.42, c=(0, y1 + 0.03, SILL + 0.27), bev=0.01, segs=1))
    B_.add(box(2 * BW, y0 - y1, 0.04, c=(0, (y0 + y1) / 2, SILL + 0.1), mat='gunmetal'))      # bed underside pan
    return B_


def greenhouse():
    G = B()
    # dark cabin volume (shows through the open doors, behind the glass)
    pts = []
    for s in (1, -1):
        pts += [(s * GH_X0, CAB_F - 0.01, BELT - 0.01), (s * GH_X0, CAB_R + 0.03, BELT - 0.01), (s * GH_X1, ROOF_F, ROOF_Z), (s * GH_X1, ROOF_R, ROOF_Z),
                (s * (GH_X0 - 0.02), CAB_F - 0.05, 0.62), (s * (GH_X0 - 0.02), CAB_R + 0.05, 0.62)]
    G.add(hull(pts, mat='decal'))
    # roof panel
    rp = []
    for s in (1, -1):
        rp += [(s * (GH_X1 + 0.025), ROOF_F + 0.02, ROOF_Z - 0.01), (s * (GH_X1 + 0.025), ROOF_R - 0.02, ROOF_Z - 0.01),
               (s * (GH_X1 - 0.01), ROOF_F - 0.02, ROOF_Z + 0.04), (s * (GH_X1 - 0.01), ROOF_R + 0.02, ROOF_Z + 0.04)]
    G.add(hull(rp, bev=0.02, segs=2, angle=20))
    for i in range(4):   # roof stiffening ribs
        y = ROOF_F - 0.25 - i * 0.3
        G.add(box(2 * GH_X1 - 0.2, 0.05, 0.012, c=(0, y, ROOF_Z + 0.04), bev=0.005, segs=1))
    for s in (1, -1):
        # A pillar, B pillar, C pillar (wide, rear quarter)
        G.add(beam((s * (GH_X0 + 0.01), CAB_F, BELT), (s * (GH_X1 + 0.01), ROOF_F, ROOF_Z), 0.07, 0.06, up=(s, 0, 0.2), bev=0.015))
        G.add(side_slab([(0.05, BELT), (-0.03, BELT), (-0.03, ROOF_Z), (0.05, ROOF_Z)], s, 0.012, 0.03, bev=0.008))
        G.add(side_slab([(-0.78, BELT), (CAB_R - 0.02, BELT), (CAB_R + 0.04, ROOF_Z), (ROOF_R + 0.13, ROOF_Z)], s, 0.012, 0.03, bev=0.008))
        # roof rail strip (drip rail)
        G.add(beam((s * (GH_X1 + 0.02), ROOF_F, ROOF_Z), (s * (GH_X1 + 0.02), ROOF_R, ROOF_Z), 0.03, 0.03, bev=0.008))
        # belt moulding (black)
        G.add(beam((s * (BW + 0.003), CAB_F - 0.02, BELT + 0.005), (s * (BW + 0.003), CAB_R + 0.02, BELT + 0.005), 0.025, 0.02, mat='skirt'))
    # windscreen (glass pane + black rubber surround) and header / cowl
    wa, wb = V((0, CAB_F, BELT + 0.005)), V((0, ROOF_F, ROOF_Z))
    up = (wb - wa).normalized(); nrm = V((0, up.z, -up.y))
    if nrm.y < 0:
        nrm = -nrm
    ws = []
    for f in (0.04, 0.96):
        p = wa.lerp(wb, f)
        for s in (1, -1):
            ws.append(p + V((s * (gh_x(p.z) - 0.05), 0, 0)) + nrm * 0.008)
    ws = [ws[0], ws[1], ws[3], ws[2]]
    bm = bmesh.new(); vs = [bm.verts.new(v) for v in ws]; bm.faces.new(vs)
    gl = B(bm, 'glass').solidify(0.008, 0)
    G.add(gl)
    G.add(frame_loop(ws, 0.024))          # (ws is already in loop order)
    G.add(box(2 * GH_X0 - 0.1, 0.18, 0.03, c=(0, CAB_F + 0.06, BELT + 0.01), mat='skirt', bev=0.008, segs=1))     # cowl panel
    # wipers
    for s in (1, -1):
        G.add(tube([V((s * 0.35 - 0.2, CAB_F + 0.02, BELT + 0.04)), V((s * 0.35 + 0.15, CAB_F - 0.22, BELT + 0.25))], 0.007, 4, 'skirt'))
    # rear window with frame
    rz0, rz1 = BELT + 0.12, ROOF_Z - 0.08
    for z0_, z1_, mat in ((rz0, rz1, 'glass'),):
        y_ = CAB_R + 0.035 - 0.012
        rw = box(1.05, 0.01, z1_ - z0_, c=(0, y_ - 0.004 + (z0_ - BELT) * 0.0, (z0_ + z1_) / 2), mat=mat)
        G.add(rw)
    G.add(frame_loop([V((-0.53, CAB_R + 0.015, rz0)), V((0.53, CAB_R + 0.015, rz0)), V((0.53, CAB_R + 0.015, rz1)), V((-0.53, CAB_R + 0.015, rz1))], 0.026))
    G.add(box(2 * GH_X0 - 0.06, 0.03, rz0 - BELT + 0.01, c=(0, CAB_R + 0.03, (rz0 + BELT) / 2), bev=0.01, segs=1))
    G.add(box(2 * GH_X1, 0.03, ROOF_Z - rz1 + 0.01, c=(0, CAB_R + 0.045, (rz1 + ROOF_Z) / 2), bev=0.01, segs=1))
    # third brake light
    G.add(box(0.3, 0.03, 0.03, c=(0, CAB_R + 0.03, ROOF_Z - 0.04), mat='era', bev=0.006, segs=1))
    return G


def front_end():
    F = B()
    # grille (black, horizontal slats), headlights, bumper, fog lamps, bonnet scoop, bonnet shut line
    gy = FRONT + 0.035
    F.add(box(1.06, 0.03, 0.27, c=(0, gy - 0.01, 0.85), mat='skirt', bev=0.02, segs=2))
    for i in range(5):
        F.add(box(1.0, 0.035, 0.022, c=(0, gy + 0.005, 0.75 + i * 0.05), mat='skirt', bev=0.006, segs=1))
    F.add(box(1.0, 0.012, 0.24, c=(0, gy - 0.02, 0.85), mat='decal'))
    for s in (1, -1):
        hl = hull([(s * 0.56, gy - 0.02, 0.97), (s * 0.84, gy - 0.18, 0.99), (s * 0.84, gy - 0.16, 0.86), (s * 0.56, gy - 0.02, 0.86),
                   (s * 0.56, gy - 0.07, 0.97), (s * 0.82, gy - 0.22, 0.98), (s * 0.82, gy - 0.2, 0.87), (s * 0.56, gy - 0.07, 0.86)], mat='light')
        F.add(hl)
        F.add(cyl(0.045, 0.02, 16, 'y', c=(s * 0.66, gy - 0.025, 0.92), mat='bare'))
        F.add(box(0.07, 0.03, 0.03, c=(s * 0.80, gy - 0.16, 0.88), mat='cage'))
    # bumper (black plastic, wraps round the corners)
    bp = []
    for s in (1, -1):
        bp += [(s * 0.62, FRONT + 0.13, 0.42), (s * 0.62, FRONT + 0.13, 0.70), (s * (BW + 0.01), FRONT - 0.18, 0.44), (s * (BW + 0.01), FRONT - 0.2, 0.72),
               (s * 0.6, FRONT - 0.05, 0.40), (s * 0.6, FRONT - 0.05, 0.72)]
    F.add(hull(bp, mat='skirt', bev=0.03, segs=2))
    F.add(box(0.8, 0.02, 0.08, c=(0, FRONT + 0.14, 0.5), mat='decal'))          # lower air intake
    for s in (1, -1):
        F.add(cyl(0.04, 0.02, 14, 'y', c=(s * 0.7, FRONT + 0.07, 0.5), mat='light'))
        F.add(box(0.06, 0.12, 0.05, c=(s * 0.3, FRONT + 0.1, 0.42), mat='gunmetal'))      # tow eyes / bar mounts
    # bonnet scoop + shut line
    F.add(hull([(-0.28, 1.95, 1.095), (0.28, 1.95, 1.095), (-0.24, 1.55, 1.12), (0.24, 1.55, 1.12), (-0.22, 1.66, 1.17), (0.22, 1.66, 1.17), (-0.25, 1.92, 1.12), (0.25, 1.92, 1.12)], bev=0.015, segs=2))
    F.add(box(0.36, 0.02, 0.03, c=(0, 1.665, 1.155), mat='decal'))
    F.add(beam((-BW * 0.93, CAB_F + 0.18, 1.12), (BW * 0.93, CAB_F + 0.18, 1.12), 0.006, 0.01, mat='decal'))
    # washer jets
    for s in (1, -1):
        F.add(box(0.025, 0.03, 0.015, c=(s * 0.3, CAB_F + 0.3, 1.125), mat='skirt'))
    return F


def bull_bar():
    R_ = B()
    y = FRONT + 0.2
    for s in (1, -1):
        R_.add(rail([(s * 0.36, y - 0.15, 0.42), (s * 0.36, y, 0.45), (s * 0.36, y, 1.0), (s * 0.42, y - 0.06, 1.05)], r=0.03, rad=0.06, mat='gunmetal', foot=False))
        R_.add(rail([(s * 0.36, y, 0.62), (s * 0.78, y - 0.2, 0.65), (s * 0.86, y - 0.34, 0.62)], r=0.024, rad=0.08, mat='gunmetal', foot=False))
        R_.add(box(0.08, 0.06, 0.1, c=(s * 0.36, y - 0.04, 0.68), mat='gunmetal', bev=0.01, segs=1))   # mount plate
    R_.add(rail([(-0.42, y - 0.06, 1.05), (-0.3, y + 0.02, 1.08), (0.3, y + 0.02, 1.08), (0.42, y - 0.06, 1.05)], r=0.03, rad=0.12, mat='gunmetal', foot=False))
    for x in (-0.18, 0.0, 0.18):
        R_.add(tube([(x, y + 0.015, 0.47), (x, y + 0.02, 1.07)], 0.016, 8, 'gunmetal'))
    R_.add(box(0.76, 0.05, 0.1, c=(0, y, 0.45), mat='gunmetal', bev=0.012, segs=1))
    return R_


def flares_and_trim():
    Fl = B()
    for s in (1, -1):
        for yc in (AXF, AXR):
            pts = [V((s * (BW + 0.02), y, z)) for y, z in arch_pts(yc, WZ, RA + 0.03, SILL - 0.01, 18)]
            fl = tube(pts, 0.04, 6, 'skirt')
            fl.scale(1, 1, 1)
            Fl.add(fl)
            # arch liner (dark, inside the arch)
            liner = lathe([(RA + 0.005, -0.32), (RA + 0.005, 0.0)], 24, 'x', mat='decal', cap=False)
            for v in list(liner.bm.verts):
                pass
            # cut lower half of the liner
            bmesh.ops.delete(liner.bm, geom=[v for v in liner.bm.verts if v.co.z < -0.02], context='VERTS')
            liner.move(s * (BW - 0.02) if s > 0 else s * (BW - 0.02) + 0.32, yc, WZ)
            Fl.add(liner)
            # mud flap behind the wheel
            Fl.add(box(0.25, 0.012, 0.22, c=(s * (TRACK / 2 + 0.03), yc - RA - 0.06, SILL - 0.06), mat='skirt', bev=0.004, segs=1))
        # side step (tube) between the arches
        Fl.add(rail([(s * 0.75, AXF - RA - 0.02, 0.38), (s * (BW + 0.06), AXF - RA - 0.1, 0.36), (s * (BW + 0.06), AXR + RA + 0.08, 0.36), (s * 0.75, AXR + RA + 0.02, 0.38)], r=0.032, rad=0.1, mat='bare', foot=False))
    return Fl


def roof_rack():
    R_ = B()
    zr = ROOF_Z + 0.16
    for s in (1, -1):
        R_.add(rail([(s * 0.62, ROOF_F + 0.05, zr - 0.02), (s * 0.62, ROOF_F, zr), (s * 0.62, ROOF_R, zr), (s * 0.62, ROOF_R - 0.05, zr - 0.02)], r=0.02, rad=0.05, mat='gunmetal', foot=False))
        for y in (ROOF_F - 0.05, -0.2, ROOF_R + 0.05):
            R_.add(box(0.05, 0.08, 0.17, c=(s * 0.63, y, ROOF_Z + 0.08), mat='gunmetal', bev=0.01, segs=1))
    for y in np.linspace(ROOF_F, ROOF_R, 6):
        R_.add(tube([(-0.62, y, zr), (0.62, y, zr)], 0.016, 8, 'gunmetal'))
    # jerrycan strapped beside the spare
    R_.add(box(0.35, 0.47, 0.17, c=(0.45, -0.3, zr + 0.1), mat='rolled', bev=0.02, segs=2))
    R_.add(box(0.37, 0.025, 0.012, c=(0.45, -0.3, zr + 0.187), mat='canvas'))
    R_.add(box(0.12, 0.05, 0.03, c=(0.45, -0.06, zr + 0.17), mat='rolled', bev=0.01, segs=1))      # spout
    return R_


def chassis():
    C_ = B()
    for s in (1, -1):
        C_.add(box(0.07, 4.6, 0.16, c=(s * 0.42, -0.05, 0.47), mat='gunmetal', bev=0.008, segs=1))
    for y in (2.1, 0.9, -0.3, -1.9, -2.45):
        C_.add(box(0.84, 0.08, 0.1, c=(0, y, 0.47), mat='gunmetal'))
    # front IFS: control arms + skid plate; rear live axle with diff + leaf springs
    for s in (1, -1):
        C_.add(beam((s * 0.42, AXF + 0.1, 0.38), (s * (TRACK / 2 - 0.12), AXF, WZ - 0.04), 0.06, 0.03, mat='gunmetal'))
        C_.add(beam((s * 0.42, AXF - 0.12, 0.48), (s * (TRACK / 2 - 0.12), AXF, WZ + 0.08), 0.05, 0.03, mat='gunmetal'))
        C_.add(cyl(0.035, 0.32, 8, 'z', c=(s * (TRACK / 2 - 0.2), AXF, WZ + 0.2), mat='bare'))
        C_.add(beam((s * 0.42, AXR + 0.6, 0.42), (s * 0.42, AXR - 0.6, 0.42), 0.06, 0.05, mat='gunmetal', up=(0, 0.2, 1)))
    C_.add(box(1.0, 0.7, 0.012, c=(0, AXF + 0.2, 0.33), mat='gunmetal'))
    C_.add(cyl(0.05, TRACK - 0.2, 10, 'x', c=(0, AXR, WZ), mat='gunmetal'))
    C_.add(lathe([(0, -0.1), (0.12, -0.08), (0.14, 0.0), (0.11, 0.09), (0, 0.11)], 14, 'y', c=(0.05, AXR, WZ), mat='gunmetal'))
    C_.add(cyl(0.035, 2.0, 8, 'y', c=(0.05, (AXF + AXR) / 2, 0.36), mat='gunmetal'))          # propshaft
    C_.add(box(0.6, 0.5, 0.22, c=(-0.12, -0.75, 0.42), mat='gunmetal', bev=0.02, segs=1))     # fuel tank
    C_.add(tube([(0.25, 0.9, 0.36), (0.3, -0.5, 0.33), (0.62, -1.0, 0.34), (0.62, -1.95, 0.4), (0.66, -2.05, 0.4)], 0.03, 8, 'bare'))   # exhaust
    C_.add(box(0.3, 0.6, 0.22, c=(0.0, 1.6, 0.6), mat='gunmetal'))       # sump / engine underside
    # rear bumper: step bumper + tow hitch + number-plate light
    C_.add(box(2 * BW - 0.06, 0.14, 0.17, c=(0, REAR - 0.07, SILL + 0.02), mat='bare', bev=0.03, segs=2))
    C_.add(box(0.6, 0.1, 0.02, c=(0, REAR - 0.1, SILL + 0.112), mat='skirt'))
    C_.add(box(0.08, 0.2, 0.06, c=(0, REAR - 0.22, SILL - 0.05), mat='gunmetal', bev=0.01, segs=1))
    C_.add(lathe([(0, 0), (0.025, 0), (0.025, 0.04), (0.03, 0.05), (0.025, 0.09), (0, 0.095)], 12, 'z', c=(0, REAR - 0.3, SILL - 0.02), mat='bare'))
    return C_


def door(side, which):
    """door slab (outer skin + window frame + glass + handle), in authoring world coords; returns (part, hinge point)"""
    y0, y1 = DOORS[which]           # y0 = front edge (hinge), y1 = rear edge
    s = side
    D = B()
    zb = SILL + 0.035
    if which == 'R':
        prof = [(y0, zb), (y0, BELT - 0.005), (y1 + 0.05, BELT - 0.005), (y1, BELT - 0.06), (y1, zb + 0.08), (y1 + 0.1, zb)]
    else:
        prof = [(y0, zb + 0.06), (y0, BELT - 0.005), (y1, BELT - 0.005), (y1, zb)]
    D.add(side_slab(prof, s, 0.012, 0.035, bev=0.008))
    # window: glass pane following the greenhouse slope + black rubber surround
    zt = ROOF_Z - 0.06
    if which == 'F':
        wpoly = [(y1 + 0.02, BELT + 0.02), (y0 - 0.04, BELT + 0.02), (a_pillar_y(zt) - 0.02, zt), (y1 + 0.02, zt)]
    else:
        wpoly = [(y1 + 0.1, BELT + 0.02), (y0 - 0.04, BELT + 0.02), (y0 - 0.04, zt), (y1 + 0.16, zt)]
    D.add(side_slab(wpoly, s, 0.006, 0.008, mat='glass'))
    sx = lambda z, o=0.012: s * (gh_x(z) + o) if z > BELT + 1e-4 else s * (BW + o)
    loop = [V((sx(z), y, z)) for y, z in wpoly]
    D.add(frame_loop(loop, 0.022))
    # handle + key lock, crease line
    hy = y1 + 0.12 if which == 'F' else y1 + 0.18
    D.add(box(0.03, 0.15, 0.04, c=(s * (BW + 0.035), hy, BELT - 0.12), mat='skirt', bev=0.01, segs=1))
    D.add(box(0.02, (y0 - y1) * 0.94, 0.012, c=(s * (BW + 0.03), (y0 + y1) / 2, 0.86), bev=0.004, segs=1))
    if which == 'F':
        # mirror on the front corner of the front door
        mz = BELT + 0.06
        D.add(box(0.12, 0.08, 0.06, c=(s * (BW + 0.06), y0 - 0.12, mz), mat='skirt', bev=0.01, segs=1))
        mh = hull([(s * (BW + 0.1), y0 - 0.1, mz - 0.1), (s * (BW + 0.3), y0 - 0.12, mz - 0.09), (s * (BW + 0.1), y0 - 0.1, mz + 0.1), (s * (BW + 0.3), y0 - 0.12, mz + 0.1),
                   (s * (BW + 0.1), y0 - 0.2, mz - 0.08), (s * (BW + 0.28), y0 - 0.22, mz - 0.07), (s * (BW + 0.1), y0 - 0.2, mz + 0.08), (s * (BW + 0.28), y0 - 0.22, mz + 0.08)],
                  mat='skirt', bev=0.02, segs=2)
        D.add(mh)
        D.add(box(0.17, 0.006, 0.16, c=(s * (BW + 0.195), y0 - 0.23, mz + 0.005), mat='glass'))
    hinge = (s * (BW + 0.02), y0, 0.8)
    return D, hinge


def tailgate():
    y1 = REAR
    TG = B()
    TG.add(box(2 * BED_IN + 0.06, 0.05, BED_TOP - TG_Z - 0.02, c=(0, y1 - 0.025, (BED_TOP + TG_Z) / 2), bev=0.015, segs=2))
    TG.add(box(2 * BED_IN - 0.1, 0.012, BED_TOP - TG_Z - 0.12, c=(0, y1 - 0.054, (BED_TOP + TG_Z) / 2), bev=0.004, segs=1))   # pressed panel
    TG.add(box(0.2, 0.025, 0.05, c=(0, y1 - 0.06, BED_TOP - 0.08), mat='skirt', bev=0.008, segs=1))                         # handle
    TG.add(box(2 * BED_IN, 0.012, BED_TOP - TG_Z - 0.06, c=(0, y1 + 0.006, (BED_TOP + TG_Z) / 2), mat='canvas'))              # inner liner
    for s in (1, -1):
        TG.add(tube([(s * (BED_IN - 0.02), y1 + 0.01, BED_TOP - 0.04), (s * (BED_IN + 0.04), y1 + 0.02, BED_TOP - 0.06)], 0.006, 4, 'bare'))   # check cable stub
    return TG, (0, y1 - 0.025, TG_Z)


# ================================================================================================ build
def build():
    t0 = time.time()
    L.reset()
    root = L.node_empty('root')
    hullE = L.node_empty('hull', root, (0, 0, 0))
    H = lower_body()
    H.add(bed_body())
    H.add(greenhouse())
    H.add(front_end())
    H.add(bull_bar())
    H.add(flares_and_trim())
    H.add(roof_rack())
    H.add(chassis())
    # dark door openings (seen with a door open) on the body side under each door slab
    for s in (1, -1):
        for w in ('F', 'R'):
            y0, y1 = DOORS[w]
            H.add(box(0.008, y0 - y1 - 0.04, BELT - SILL - 0.1, c=(s * (BW + 0.002), (y0 + y1) / 2, (BELT + SILL) / 2 + 0.02), mat='decal'))
    print('  hull tris', H.tris(), '%.1fs' % (time.time() - t0))
    # spare wheel lying flat on the roof rack
    Wp = wheel()
    sp = L._bcopy(Wp); sp.rot('Y', 90); sp.move(-0.18, -0.15, ROOF_Z + 0.16 + WW / 2 + 0.02)
    H.add(sp)
    for a in (0, 90):     # ratchet straps over it
        st = box(0.04, 2 * WR + 0.06, 0.012, c=(0, 0, 0), mat='canvas').move(0, 0, WW / 2 + 0.01).rot('Z', a)
        H.add(st.move(-0.18, -0.15, ROOF_Z + 0.16 + WW / 2 + 0.02))
    hull_mesh = L.node_mesh('hull_geo', H, hullE, (0, 0, 0))
    # ---- doors (hinge empties) + tailgate
    door_objs, doors_man = [], {}
    for s, tag in ((-1, 'L'), (1, 'R')):
        for w in ('F', 'R'):
            p, hp = door(s, w)
            nm = f'door_{w}{tag}'
            e = L.node_empty(nm, hullE, hp, 0.1)
            door_objs.append(L.node_mesh(nm + '_geo', p, e, hp))
            # glTF frame: x = vehicle left, z forward; door hangs rearward (-z) from its front-edge hinge; rotation about +y by
            # angle a moves (0,0,-1) to (-sin a, 0, -cos a): left door (glTF +x side) opens with a < 0, right door with a > 0
            doors_man[nm] = dict(axis='y', open=round((-1 if tag == 'L' else 1) * math.radians(68 if w == 'F' else 72), 3), parent='hull',
                                 side='left' if tag == 'L' else 'right', note='hinge on the front edge')
    tp, th = tailgate()
    tgE = L.node_empty('tailgate', hullE, th, 0.1)
    tg_obj = L.node_mesh('tailgate_geo', tp, tgE, th)
    # glTF: tailgate extends +y from the bottom hinge; rotation about +x by a moves (0,1,0) to (0, cos a, sin a) -> rearward (-z) needs a < 0
    doors_man['tailgate'] = dict(axis='x', open=round(-math.radians(90), 3), parent='hull', note='hinge on the bottom edge, opens down to a flat loading shelf at bed-floor height')
    # ---- wheels: front pair under steering empties
    Wl = L._bcopy(Wp); Wl.scale(-1, 1, 1)
    meR = meL = None
    wheel_objs = []
    for side, tag in ((1, 'R'), (-1, 'L')):
        for i, y in enumerate((AXF, AXR)):
            c = (side * TRACK / 2, y, WZ)
            par = hullE
            if i == 0:
                par = L.node_empty(f'steer_{tag}1', hullE, c, 0.15)
            e = L.node_empty(f'wheel_{tag}{i + 1}', par, c)
            src = Wp if side > 0 else Wl
            me = meR if side > 0 else meL
            if me is None:
                part = L._bcopy(src); part.move(*c)
                o = L.node_mesh(f'wheel_{tag}{i + 1}_geo', part, e, c)
                if side > 0:
                    meR = o.data
                else:
                    meL = o.data
            else:
                o = L.node_mesh(f'wheel_{tag}{i + 1}_geo', None, e, c, mesh=me)
            wheel_objs.append(o)
    meR.name = 'wheel_R'; meL.name = 'wheel_L'
    # ---- empties
    L.node_empty('exhaust', hullE, (0.66, -2.08, 0.4))
    seats = [(-0.40, 0.38, 0.84), (0.40, 0.38, 0.84), (0.40, -0.52, 0.86)]       # LHD: driver front left
    for i, p in enumerate(seats):
        e = L.node_empty(f'ride_seat_{i + 1}', hullE, p, 0.12)
        e['seat_type'] = 'cab'
    for s, tag in ((-1, 'L'), (1, 'R')):
        for w in ('F', 'R'):
            y0, y1 = DOORS[w]
            L.node_empty(f'cab_door_{w}{tag}', hullE, (s * (BW + 0.15), (y0 + y1) / 2, 0.0), 0.1)
        L.node_empty(f'dismount_{tag}', hullE, (s * (BW + 0.75), 0.55, 0.0), 0.1)
    # stretcher slots: +Z (authoring -Y... see below) - built facing the tailgate: an empty's local +Z after the frame flip
    stretchers = []
    for i, x in enumerate((-0.47, 0.0, 0.47)):
        e = L.node_empty(f'stretcher_{i + 1}', hullE, (x, -1.80, BED_FLOOR + 0.005), 0.12)
        stretchers.append(e)
    lp = L.node_empty('load_point', hullE, (0.0, REAR - 0.85, 0.0), 0.12)
    print('  geometry done %.1fs' % (time.time() - t0))
    lod0 = [hull_mesh] + door_objs + [tg_obj] + wheel_objs
    return dict(root=root, hull=hullE, lod0=lod0, atlas=[hull_mesh] + door_objs + [tg_obj, wheel_objs[0], wheel_objs[2]],
                doors=door_objs, tg=tg_obj, wheels=wheel_objs, doors_man=doors_man, stretchers=stretchers, load_point=lp)


def orient_empties(d):
    """three.js reads local +Z of an empty as its facing.  After the authoring->export flip (180 deg about Z) and the
    glTF Y-up conversion, an unrotated empty faces the vehicle's FRONT (+Z glTF).  Stretcher slots face the tailgate
    (rotate 180 deg about the up axis), load_point faces the truck (forward: no rotation)."""
    for e in d['stretchers']:
        e.rotation_euler = (0, 0, math.pi)
    bpy.context.view_layer.update()


def wreck(d):
    """Burnt-out pickup on its rims (tyres, glass, lamp lenses and the cabin volume gone), doors sprung, bed walls sagging."""
    root = d['root']
    drop = WZ - 0.235
    for o in d['doors']:
        e = o.parent
        ent = d['doors_man'][e.name]
        a = ent['open'] * 0.25
        e.rotation_euler = (0, 0, a)
    bpy.context.view_layer.update()
    hw = VB.join_copies('hull_wreck', [d['lod0'][0]] + d['doors'] + [d['tg']] + d['wheels'], root, (0, 0, 0),
                        drop_slots=('tyre', 'glass', 'light', 'decal'), drop_z=drop)
    for o in d['doors']:
        o.parent.rotation_euler = (0, 0, 0)
    bpy.context.view_layer.update()
    return [hw]


def decals(P, N):
    """Red crosses: both front doors, bonnet, tailgate, roof (casualty-evacuation marking used on volunteer pickups)."""
    m = np.zeros(P.shape[:2], np.float32)
    E = lambda p: (-p[0], -p[1], p[2])
    for s in (1, -1):
        m += T.decal_mask(P, N, E((s * (BW + 0.03), 0.58, 0.82)), E((s, 0, 0)), (0, 0, 1), T.cross_shape(0.16, 0.05))
        m += T.decal_mask(P, N, E((s * (BW - 0.02 + 0.03), -1.82, 1.08)), E((s, 0, 0)), (0, 0, 1), T.cross_shape(0.13, 0.042))
    m += T.decal_mask(P, N, E((0, 2.2, 1.09)), E((0, 0.08, 1)), (0, 1, 0), T.cross_shape(0.17, 0.055))
    m += T.decal_mask(P, N, E((0, REAR - 0.05, 1.12)), E((0, -1, 0)), (0, 0, 1), T.cross_shape(0.12, 0.04))
    return m


VB.SCHEMES['civ_white'] = dict(base=(206, 206, 198), base2=(194, 195, 188), camo=None, dust=(158, 150, 132), mud=(112, 100, 84),
                               wear=0.6, dust_amt=0.42, mud_amt=0.45, fade=(222, 221, 214), rough_base=0.36, decal_rgb=(168, 22, 20),
                               kind_colors={'skirt': ((30, 30, 29), 0.72, 0.0), 'canvas': ((26, 26, 25), 0.92, 0.0),
                                            'era': ((150, 18, 14), 0.18, 0.0), 'cage': ((205, 110, 22), 0.2, 0.0)})


def write_armor():
    """pickup_armor.json: sheet steel only (0.7-0.8 mm body panels, ~2-3 mm frame); the cab is not protected at all."""
    J = {
        'model': NAME, 'vehicle': 'civilian double-cab pickup (casualty evacuation)',
        'summary': 'Unarmoured: 0.7-0.8 mm body panels, glass, a ladder frame. Every small-arms round penetrates; any HEAT / '
                   'autocannon round destroys it. Tyres are soft-skinned; the engine bay and fuel tank catch fire easily.',
        'frame': 'armor.js: metres, x right, y up, z forward, origin on the ground at the hull centre; faces in mm RHA-equivalent vs a horizontal shot',
        'zones': [
            {'name': 'cab', 'min': [-0.9, 0.47, -0.98], 'max': [0.9, 1.85, 1.17], 'faces': {f: {'ke': 1, 'ce': 1} for f in ('front', 'side', 'rear', 'top', 'bottom')}},
            {'name': 'bonnet', 'min': [-0.9, 0.4, 1.17], 'max': [0.9, 1.15, 2.75], 'faces': {f: {'ke': 2, 'ce': 2} for f in ('front', 'side', 'top', 'bottom')}},
            {'name': 'bed', 'min': [-0.9, 0.47, -2.6], 'max': [0.9, 1.33, -1.03], 'faces': {f: {'ke': 1, 'ce': 1} for f in ('side', 'rear', 'front', 'bottom')}},
            {'name': 'wheels_l', 'min': [-0.92, 0.0, -1.85], 'max': [-0.62, 0.78, 2.05], 'faces': {f: {'ke': 3, 'ce': 3} for f in ('side', 'front', 'rear')}},
            {'name': 'wheels_r', 'min': [0.62, 0.0, -1.85], 'max': [0.92, 0.78, 2.05], 'faces': {f: {'ke': 3, 'ce': 3} for f in ('side', 'front', 'rear')}},
        ],
        'parts': [
            {'name': 'driver', 'crew': 'driver', 'min': [-0.7, 0.6, -0.05], 'max': [-0.1, 1.6, 0.85]},
            {'name': 'commander', 'crew': 'commander', 'min': [0.1, 0.6, -0.05], 'max': [0.7, 1.6, 0.85]},
            {'name': 'gunner', 'crew': 'gunner', 'min': [-0.7, 0.6, -0.95], 'max': [0.7, 1.6, -0.05]},
            {'name': 'casualties', 'troops': True, 'min': [-0.77, 0.88, -2.55], 'max': [0.77, 1.3, -1.05]},
            {'name': 'engine', 'engine': True, 'fuel': 0.35, 'min': [-0.6, 0.45, 1.3], 'max': [0.6, 1.1, 2.5]},
            {'name': 'fuel', 'fuel': 0.6, 'min': [-0.42, 0.31, -1.0], 'max': [0.18, 0.53, -0.5]},
        ],
    }
    with open(os.path.join(VB.OUT, NAME + '_armor.json'), 'w') as f:
        json.dump(J, f, indent=1)


STATIC = dict(faction='any', name='Pickup (casualty evacuation)', kind='medevac', wheeled=True, crew=1, passengers=2, casualty_slots=3,
              real_dimensions_m=dict(length=5.33, width=1.855, height=1.815, height_over_rack=1.98, wheelbase=3.085, wheel_track=1.54,
                                     ground_clearance=0.29, tyre='265/65 R17 (dia 0.776 m)', bed_inner=[1.52, 1.51], bed_floor_height=0.88),
              markings='red crosses on the front doors, bed sides, bonnet and tailgate; dirty white civilian paint, no badges',
              sources=['https://www.toyota.com.au/hilux/specs (Hilux double cab: 5325 x 1855 x 1815 mm, wheelbase 3085 mm, track 1540 mm, 265/65R17)',
                       'https://www.mitsubishi-motors.com/en/products/l200 (L200 double cab: 5305 x 1815 x 1780 mm, wheelbase 3000 mm, bed 1520 x 1470 mm)'],
              game=dict(hp_suggestion=160, speed_kmh=dict(road=110, off_road=45), game_speed=16.5, accel=5.0, turn_rate=1.35,
                        note='unarmoured: rifle fire disables it, any AT round destroys it'))


def main(argv):
    dev = '--dev' in argv
    d = build()
    orient_empties(d)
    VB.SOOT[:] = [((0.66, -2.1, 0.4), 0.18)]
    out = os.path.join(VB.REPO, 'previews', 'medevac', '_dev_' + NAME + '.glb') if dev else None
    info = VB.finalize(d, NAME, 'civ_white', decals, wreck, out=out, lod_ratio=0.3)
    info['doors'] = d['doors_man']
    info['wheel_radius_m'] = WR
    info['steering'] = {'nodes': ['steer_L1', 'steer_R1'], 'axis': 'y', 'max_rad': 0.6, 'note': 'positive = steer to the vehicle left'}
    with open(os.path.join(VB.CACHE, NAME + '_info.json'), 'w') as f:
        json.dump(info, f, indent=1)
    print(json.dumps({k: v for k, v in info.items() if k not in ('hierarchy', 'node_bboxes')}))
    if not dev:
        write_armor()
        write_manifest(info)
    return info


def write_manifest(info):
    import fcntl
    man_path = os.path.join(VB.REPO, 'assets', 'vehicles', 'manifest.json')
    v = dict(STATIC)
    v['file'] = f'assets/vehicles/{NAME}.glb'
    v['file_mb'] = info['file_mb']
    v['tris'] = dict(lod0=info['lod0_tris'], lod1=info['lod1_tris'], **info['wreck_tris'])
    v['model_bbox_m'] = dict(min=info['bbox_lod0'][0], max=info['bbox_lod0'][1], size=[round(b - a, 3) for a, b in zip(*info['bbox_lod0'])])
    v['materials'] = info['materials']
    v['armor_file'] = f'assets/vehicles/{NAME}_armor.json'
    v['doors'] = info['doors']
    v['door_animation'] = ('door_* / tailgate are hinge empties under hull (closed = rotation 0); set node.rotation[axis] = open (radians) to open, '
                           'interpolate from 0. Front doors open 68 deg, rear 72 deg, tailgate 90 deg down (flat, at bed-floor height).')
    v['wheel_radius_m'] = info['wheel_radius_m']
    v['steering'] = info['steering']
    v['ride_seats'] = {'count': 3, 'seat_type': 'cab', 'note': 'ride_seat_1 driver (front left, LHD), 2 front passenger, 3 rear right; origin = H-point on the cushion, +Z forward'}
    v['casualty_slots'] = {'nodes': ['stretcher_1', 'stretcher_2', 'stretcher_3'], 'note': 'origin on the bed floor; local +Z points to the tailgate, so a casualty lying on his back with the head along -Z lies head towards the cab',
                           'load_point': 'ground behind the open tailgate, +Z faces the truck (medic loading position)'}
    v['hierarchy'] = info['hierarchy']
    with open(man_path + '.lock', 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        man = json.load(open(man_path))
        man.setdefault('vehicles', {})[NAME] = v
        tmp = man_path + '.tmp_pickup'
        with open(tmp, 'w') as f:
            json.dump(man, f, indent=1)
        os.replace(tmp, man_path)
    print('wrote', man_path, NAME)


if __name__ == '__main__':
    main(sys.argv[1:])
