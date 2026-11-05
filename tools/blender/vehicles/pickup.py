"""Civilian double-cab pickup (generic Toyota Hilux / Mitsubishi L200 class, no badges) used as the basic wounded-evacuation
vehicle (src/game/medevac.js): dirty white paint, red crosses, steel bull bar, roof rack with the spare wheel and a jerrycan,
open bed with room for three casualties lying lengthwise (tailgate down).  v2 (vehicles_v5): lofted, curved body panels with
real door / bonnet / tailgate shut lines, a full cab interior (dashboard, steering wheel, seats with headrests, gear lever,
door cards, floor mats, clutter) seen through see-through glass and the open doors, visible suspension underneath.

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
Glass is a separate mesh per node (glass_geo under hull, door_XX_glass under each door) with a blended (see-through) material.
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
from vlib import B, box, hull, prism, lathe, cyl, tube, rail, bolt, fillet_path, SI
import vtex as T
import vbuild as VB

NAME = 'pickup'
AXF, AXR = 1.64, -1.44          # axle stations (wheelbase 3.08)
TRACK = 1.54
WR, WW = 0.388, 0.265           # 265/65 R17
WZ = 0.388                      # hub height (sits on the tyre)
RA = 0.47                       # wheel-arch radius
BW = 0.895                      # half body width
SILL = 0.47
BELT = 1.18
FRONT, REAR = 2.53, -2.60       # body front face / bed rear face
CAB_F, CAB_R = 1.17, -0.98      # windscreen base / cab rear wall (belt line)
ROOF_Z = 1.79
ROOF_F, ROOF_R = 0.50, -0.91
GH_X0, GH_X1 = 0.86, 0.70       # greenhouse half width at the belt / at the roof
BED_Y = (-1.01, REAR)
BED_FLOOR, BED_TOP = 0.88, 1.33
BED_IN = 0.77                   # inner half width of the bed
TG_Z = 0.90                     # tailgate hinge height
DOORS = {'F': (1.11, 0.05), 'R': (-0.01, -0.90)}     # door y extents (front edge = hinge, rear edge)
GAP = 0.004                     # shut-line half gap
FLOOR_Z = 0.53                  # cab floor (top of the mats)
SEATS = [(-0.40, 0.38, 0.84), (0.40, 0.38, 0.84), (0.40, -0.52, 0.86)]       # LHD: driver front left (H points)


def gh_x(z):
    """greenhouse side x at height z (sloping inward to the roof)"""
    return GH_X0 - (z - BELT) / (ROOF_Z - BELT) * (GH_X0 - GH_X1)


def a_pillar_y(z):
    return CAB_F - (z - BELT) / (ROOF_Z - BELT) * (CAB_F - ROOF_F)


def c_pillar_y(z):
    return CAB_R + (z - BELT) / (ROOF_Z - BELT) * (ROOF_R - CAB_R)


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
    """rubber surround / frame: square beams along a closed polyline"""
    b = B(mat=mat)
    n = len(pts)
    for i in range(n):
        p0, p1 = V(pts[i]), V(pts[(i + 1) % n])
        d = (p1 - p0).normalized()
        b.add(beam(p0 - d * w * 0.5, p1 + d * w * 0.5, w, w, mat=mat, up=(0, 0, 1) if abs(d.z) < 0.9 else (1, 0, 0)))
    return b


def quad_slab(pts, thick, mat='rolled', bev=None, nrm=None):
    """planar polygon pts (3D, loop) extruded by thick along -normal (normal from the winding or `nrm`)"""
    pts = [V(p) for p in pts]
    n_ = V(nrm) if nrm else (pts[1] - pts[0]).cross(pts[2] - pts[1]).normalized()
    bm = bmesh.new()
    a = [bm.verts.new(p) for p in pts]
    b_ = [bm.verts.new(p - n_ * thick) for p in pts]
    bm.faces.new(a); bm.faces.new(b_[::-1])
    for i in range(len(pts)):
        j = (i + 1) % len(pts)
        bm.faces.new((a[j], a[i], b_[i], b_[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    r = B(bm, mat)
    if bev:
        r.bevel(bev, 1, 30)
    return r


def glass_pane(pts, t=0.006):
    return quad_slab(pts, t, 'glass')


def set_mat_where(b, mat, pred):
    i = SI[mat]
    for f in b.bm.faces:
        if pred(f.calc_center_median(), f.normal):
            f.material_index = i
    return b


def boolean(b, cutters, op='DIFFERENCE'):
    """exact boolean of part b with cutter parts (cut faces keep the cutter's material index)"""
    me = b.to_mesh('_bo')
    ob = L.link(bpy.data.objects.new('_bo', me))
    objs = []
    for c in cutters:
        cm = c.to_mesh('_ct')
        co = L.link(bpy.data.objects.new('_ct', cm))
        objs.append(co)
        m = ob.modifiers.new('b', 'BOOLEAN')
        m.operation = op; m.solver = 'EXACT'; m.object = co
        if hasattr(m, 'material_mode'):
            m.material_mode = 'TRANSFER'
    for s in VB.SLOTS:
        mt = bpy.data.materials.get('S_' + s) or bpy.data.materials.new('S_' + s)
        me.materials.append(mt)
    for co in objs:
        for s in VB.SLOTS:
            co.data.materials.append(bpy.data.materials.get('S_' + s))
    dg = bpy.context.evaluated_depsgraph_get()
    nb = bmesh.new()
    nb.from_object(ob, dg)
    for co in objs:
        bpy.data.objects.remove(co)
    bpy.data.objects.remove(ob)
    b.bm.free()
    b.bm = nb
    return b


def loft(stations, close0=True, close1=True, mat='rolled', mirror=True, closed_ring=True):
    """stations: [(y, [(x, z), ...])] half sections from the bottom centre round to the top centre (x >= 0);
    mirror=True builds the full ring (both halves).  Returns a part with outward normals."""
    bm = bmesh.new()
    rings = []
    for y, half in stations:
        if mirror:
            ring = [(x, z) for x, z in half] + [(-x, z) for x, z in half[::-1][1:-1]]
        else:
            ring = half
        rings.append([bm.verts.new((x, y, z)) for x, z in ring])
    n = len(rings[0])
    m = n if closed_ring else n - 1
    for i in range(len(rings) - 1):
        a, b_ = rings[i], rings[i + 1]
        for k in range(m):
            j = (k + 1) % n
            bm.faces.new((a[k], a[j], b_[j], b_[k]))
    if close0 and closed_ring:
        bm.faces.new(rings[0])
    if close1 and closed_ring:
        bm.faces.new(rings[-1][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return B(bm, mat)


def arch_cutter(yc, r, x0, x1, segs=32):
    return cyl(r, x1 - x0, segs, 'x', c=((x0 + x1) / 2, yc, WZ), mat='skirt')


def strip_on(fn, pts_xy, w=0.006, lift=0.0015, mat='decal'):
    """thin ribbon (shut line) lying on a surface z = fn(x, y) along the 2D polyline pts_xy"""
    bm = bmesh.new()
    P = [V((x, y, fn(x, y) + lift)) for x, y in pts_xy]
    L_, R_ = [], []
    for i, p in enumerate(P):
        d = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]); d.z = 0; d.normalize()
        s = V((-d.y, d.x, 0)) * w / 2
        L_.append(bm.verts.new(p + s)); R_.append(bm.verts.new(p - s))
    for i in range(len(P) - 1):
        bm.faces.new((L_[i], R_[i], R_[i + 1], L_[i + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.z < 0:
            f.normal_flip()
    return B(bm, mat)


# ================================================================================================ body sections
NSIDE = 9            # side samples (door bottom .. shoulder start)
I_SIDE0 = 4          # index of the first side point (door bottom edge)


def front_dims(y):
    """front clip + cab lower body at station y: (zb, ztop, w, crown, shoulder radius)"""
    if y <= CAB_F:
        return SILL, BELT, BW, 0.0, 0.045
    t = (y - CAB_F) / (FRONT - CAB_F)
    ztop = BELT - 0.075 * t ** 1.4 - 0.06 * max(0.0, (y - 2.36) / (FRONT - 2.36)) ** 2
    w = BW - 0.05 * max(0.0, (y - 1.85) / (FRONT - 1.85)) ** 2
    zb = SILL if y < 2.2 else SILL + 0.06 * (y - 2.2) / (FRONT - 2.2)
    return zb, ztop, w, 0.028 * min(1.0, t * 3), 0.07


def half_section(zb, ztop, w, crown, sh, ext=0.0):
    """half cross-section from the bottom centre round to the top centre.  The side bulges at the waist (character
    line ~0.86 m) and rolls into the top over a shoulder of radius sh."""
    pts = [(0.0, zb), (0.55 * w, zb), (w - 0.05, zb), (w - 0.012, zb + 0.016)]
    zs = ztop - sh
    xs = lambda z: w * (1 - 0.018 * ((z - 0.86) / 0.36) ** 2) - (0.012 if z > 0.95 else 0) * ((z - 0.95) / 0.2) ** 2 + ext
    for i in range(NSIDE):
        z = zb + 0.035 + (zs - zb - 0.035) * i / (NSIDE - 1)
        pts.append((xs(z), z))
    xe = xs(zs)
    for a in (25, 50, 70, 90):
        r = math.radians(a)
        pts.append((xe - sh + sh * math.cos(r), zs + sh * math.sin(r)))
    x_in = xe - sh
    for f in (0.66, 0.33, 0.0):
        pts.append((x_in * f, ztop + crown * (1 - f * f)))
    return pts


I_TOP = I_SIDE0 + NSIDE + 4      # first top point (after the shoulder)


def front_surface_z(x, y):
    zb, ztop, w, crown, sh = front_dims(y)
    xi = w - sh
    f = min(1.0, abs(x) / max(xi, 1e-3))
    return ztop + crown * (1 - f * f)


FRONT_YS = [CAB_R, -0.94, -0.90, -0.6, -0.3, -0.01, 0.05, 0.35, 0.7, 1.11, CAB_F, 1.35, 1.6, 1.85, 2.05, 2.22, 2.36, 2.45, FRONT - 0.035, FRONT]


def lower_body():
    """front clip + cab lower body: lofted shell, front arches cut, cab top and door apertures open, 2 cm skin"""
    st = []
    for y in FRONT_YS:
        zb, ztop, w, crown, sh = front_dims(y)
        if y >= FRONT - 0.04:          # nose: roll the front corners in
            k = 0.985 if y < FRONT else 0.955
            hs = [(x * k, z) for x, z in half_section(zb + (0.01 if y < FRONT else 0.03), ztop - (0.004 if y < FRONT else 0.016), w, crown, sh)]
        else:
            hs = half_section(zb, ztop, w, crown, sh)
        st.append((y, hs))
    b = loft(st)
    b = boolean(b, [arch_cutter(AXF, RA, 0.45, 1.2), arch_cutter(AXF, RA, -1.2, -0.45)])
    b.set_mat('rolled')
    dels = []
    for f in b.bm.faces:
        c = f.calc_center_median(); n = f.normal
        # cab top (interior opening under the greenhouse)
        if CAB_R + 1e-3 < c.y < CAB_F - 1e-3 and c.z > BELT - 0.004 and n.z > 0.8:
            dels.append(f); continue
        for y0, y1 in DOORS.values():
            if y1 < c.y < y0 and abs(c.x) > 0.55 and SILL + 0.035 < c.z < BELT + 0.01 and abs(n.z) < 0.95:
                dels.append(f); break
    bmesh.ops.delete(b.bm, geom=dels, context='FACES')
    b.solidify(0.02, -1)
    # arch liners: faces lying on the arch cylinder -> black plastic
    set_mat_where(b, 'skirt', lambda c, n: abs(math.hypot(c.y - AXF, c.z - WZ) - RA) < 0.012 and abs(c.x) > 0.3)
    b.bevel(0.005, 1, 40)
    return b


def door_skin(side, which):
    """outer door panel: the body loft strip over the door aperture (shrunk by the shut-line gap), 2 cm thick"""
    y0, y1 = DOORS[which]
    ys = np.linspace(y1 + GAP, y0 - GAP, 7)
    st = []
    for y in ys:
        hs = half_section(*front_dims(y))
        seg = hs[I_SIDE0:I_SIDE0 + NSIDE + 4]
        seg[0] = (seg[0][0], seg[0][1] + GAP)
        st.append((y, [(side * x, z) for x, z in seg]))
    bm = bmesh.new()
    rings = [[bm.verts.new((x, y, z)) for x, z in pts] for y, pts in st]
    for i in range(len(rings) - 1):
        for k in range(len(rings[0]) - 1):
            bm.faces.new((rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k]))
    for f in bm.faces:
        if (f.normal.x * side) < 0:
            f.normal_flip()
    b = B(bm, 'rolled').solidify(0.022, -1)
    b.bevel(0.004, 1, 40)
    return b


def bed_body():
    """bed side walls (lofted closed sections, rear arch cut), floor + liner, bulkhead, tail lamps, rail caps"""
    y0, y1 = BED_Y
    Bd = B()
    for s in (1, -1):
        st = []
        for y in np.linspace(y0, y1, 8):
            zb = SILL + 0.04
            w = BW - 0.004
            out = []
            for i in range(7):
                z = zb + 0.02 + (BED_TOP - 0.05 - zb - 0.02) * i / 6
                out.append((w * (1 - 0.018 * ((z - 0.86) / 0.36) ** 2) - (0.012 if z > 0.95 else 0) * ((z - 0.95) / 0.2) ** 2, z))
            xe = out[-1][0]
            ring = [(BED_IN + 0.012, zb), (w - 0.04, zb), (w - 0.01, zb + 0.012)] + out + \
                   [(xe - 0.01, BED_TOP - 0.012), (xe - 0.035, BED_TOP), (BED_IN + 0.02, BED_TOP), (BED_IN, BED_TOP - 0.02), (BED_IN, BED_FLOOR + 0.08), (BED_IN + 0.012, BED_FLOOR - 0.04)]
            st.append((y, [(s * x, z) for x, z in ring]))
        w_ = loft(st, mirror=False)
        w_ = boolean(w_, [arch_cutter(AXR, RA, s * 0.5 - 0.6, s * 0.5 + 0.6)])
        w_.set_mat('rolled')
        set_mat_where(w_, 'canvas', lambda c, n: abs(c.x) < BED_IN + 0.004 and abs(n.x) > 0.7)
        set_mat_where(w_, 'skirt', lambda c, n: abs(math.hypot(c.y - AXR, c.z - WZ) - RA) < 0.012)
        w_.bevel(0.005, 1, 40)
        Bd.add(w_)
        # rail cap (black plastic) along the top, with stake-pocket covers
        Bd.add(box(BW - BED_IN - 0.02, y0 - y1 - 0.02, 0.022, c=(s * (BED_IN + BW) / 2 - s * 0.012, (y0 + y1) / 2, BED_TOP + 0.009), mat='skirt', bev=0.008, segs=2))
        for yy in (y0 - 0.12, y1 + 0.12):
            Bd.add(box(0.05, 0.04, 0.006, c=(s * (BED_IN + BW) / 2, yy, BED_TOP + 0.022), mat='decal'))
        # (no inner wheel-arch humps: the bed floor at 0.88 m is above the arch top at 0.86 m, so three litters fit side by side)
        # tie-down hooks
        for yy in (y0 - 0.2, y1 + 0.25):
            Bd.add(rail([(s * (BED_IN + 0.002), yy - 0.05, BED_FLOOR + 0.33), (s * (BED_IN - 0.035), yy - 0.05, BED_FLOOR + 0.33),
                         (s * (BED_IN - 0.035), yy + 0.05, BED_FLOOR + 0.33), (s * (BED_IN + 0.002), yy + 0.05, BED_FLOOR + 0.33)], r=0.008, rad=0.015, mat='bare', foot=False))
        # tail-lamp cluster on the rear end of the wall: housing, red / amber / clear lenses
        xc = s * (BED_IN + BW) / 2
        Bd.add(box(0.11, 0.05, 0.40, c=(xc, y1 - 0.02, 1.08), mat='skirt', bev=0.012, segs=2))
        Bd.add(box(0.095, 0.02, 0.17, c=(xc, y1 - 0.05, 1.17), mat='era', bev=0.008, segs=2))
        Bd.add(box(0.095, 0.02, 0.08, c=(xc, y1 - 0.05, 1.04), mat='light', bev=0.008, segs=2))
        Bd.add(box(0.095, 0.02, 0.08, c=(xc, y1 - 0.05, 0.945), mat='cage', bev=0.008, segs=2))
        # tailgate hinge pin + bracket on the wall foot, check-cable anchor
        Bd.add(cyl(0.016, 0.05, 10, 'x', c=(s * (BED_IN - 0.005), y1 + 0.025, TG_Z), mat='bare'))
        Bd.add(box(0.02, 0.07, 0.09, c=(s * (BED_IN + 0.01), y1 + 0.03, TG_Z + 0.02), mat='bare', bev=0.005, segs=1))
        Bd.add(cyl(0.012, 0.03, 8, 'x', c=(s * (BED_IN - 0.012), y1 + 0.04, BED_TOP - 0.06), mat='bare'))
        # bed sill under the wall, rear corner step
        Bd.add(box(0.06, y0 - y1, 0.06, c=(s * (BED_IN + 0.04), (y0 + y1) / 2, SILL + 0.06), mat='gunmetal'))
    # floor (liner) with ribs, front bulkhead (liner on the inside), rear sill below the tailgate
    Bd.add(box(2 * BED_IN, y0 - y1 - 0.05, 0.05, c=(0, (y0 + y1) / 2 - 0.025, BED_FLOOR - 0.025), mat='canvas'))
    for i in range(10):
        x = -BED_IN + 0.1 + i * (2 * BED_IN - 0.2) / 9
        Bd.add(box(0.045, y0 - y1 - 0.14, 0.016, c=(x, (y0 + y1) / 2, BED_FLOOR + 0.008), bev=0.007, segs=1, mat='canvas'))
    Bd.add(box(2 * BED_IN + 0.02, 0.05, BED_TOP - SILL - 0.05, c=(0, y0 - 0.025, (BED_TOP + SILL + 0.05) / 2), bev=0.012, segs=1))
    Bd.add(box(2 * BED_IN, 0.02, BED_TOP - BED_FLOOR - 0.02, c=(0, y0 - 0.058, (BED_TOP + BED_FLOOR) / 2), mat='canvas', bev=0.006, segs=1))
    Bd.add(box(2 * BED_IN + 0.01, 0.055, TG_Z - SILL - 0.06, c=(0, y1 + 0.028, (TG_Z + SILL + 0.06) / 2 - 0.003), bev=0.008, segs=1))
    Bd.add(box(2 * BW - 0.06, y0 - y1, 0.03, c=(0, (y0 + y1) / 2, SILL + 0.06), mat='gunmetal'))      # bed underside pan
    for yy in np.linspace(y0 - 0.15, y1 + 0.15, 4):                                                 # cross sills
        Bd.add(box(2 * BED_IN, 0.05, 0.31, c=(0, yy, 0.70), mat='gunmetal'))
    return Bd


# ================================================================================================ greenhouse
def roof_z(x):
    f = min(1.0, abs(x) / GH_X1)
    return ROOF_Z + 0.035 * (1 - f * f) - 0.025 * max(0.0, (abs(x) - GH_X1 + 0.06) / 0.085) ** 2


def greenhouse(glass):
    """pillars, roof (lofted, crowned), windscreen + rear window in rubber, cowl, wipers, headliner. Glass -> `glass` part."""
    G = B()
    # roof panel: loft along y of a crowned section, 2.5 cm thick
    st = []
    for y in np.linspace(ROOF_R - 0.02, ROOF_F + 0.03, 7):
        xs = np.linspace(GH_X1 + 0.025, 0, 7)
        top = [(x, roof_z(x)) for x in xs]
        st.append((y, [(GH_X1 + 0.012, ROOF_Z - 0.04)] + top))
    rp = []
    for y, h in st:
        ring = h + [(-x, z) for x, z in h[::-1][1:]]
        rp.append((y, ring))
    roof = loft(rp, mirror=False)
    roof.bevel(0.012, 2, 30)
    G.add(roof)
    # headliner (interior grey) just under the roof, sun visors, rear-view mirror, dome light
    G.add(box(2 * GH_X1 - 0.04, ROOF_F - ROOF_R + 0.02, 0.02, c=(0, (ROOF_F + ROOF_R) / 2, ROOF_Z - 0.045), mat='cast', bev=0.008, segs=1))
    for s in (1, -1):
        G.add(box(0.36, 0.02, 0.16, c=(s * 0.36, ROOF_F - 0.07, ROOF_Z - 0.115), mat='cast', bev=0.008, segs=1).rot('X', 12, (0, ROOF_F - 0.07, ROOF_Z - 0.115)))
    G.add(box(0.05, 0.03, 0.04, c=(0, ROOF_F - 0.03, ROOF_Z - 0.07), mat='skirt'))
    G.add(box(0.24, 0.025, 0.07, c=(0, ROOF_F - 0.05, ROOF_Z - 0.12), mat='skirt', bev=0.012, segs=2))
    G.add(box(0.2, 0.005, 0.05, c=(0, ROOF_F - 0.064, ROOF_Z - 0.12), mat='light'))
    G.add(box(0.14, 0.08, 0.015, c=(0, -0.25, ROOF_Z - 0.06), mat='light', bev=0.006, segs=1))
    for s in (1, -1):
        # A pillar (painted outside, trim inside), B pillar, C pillar, drip rail
        G.add(beam((s * (GH_X0 - 0.005), CAB_F + 0.01, BELT - 0.01), (s * (GH_X1 + 0.01), ROOF_F + 0.01, ROOF_Z - 0.01), 0.075, 0.06, up=(s, 0, 0.3), bev=0.016))
        G.add(beam((s * (GH_X0 - 0.06), CAB_F - 0.02, BELT - 0.01), (s * (GH_X1 - 0.04), ROOF_F - 0.02, ROOF_Z - 0.04), 0.07, 0.03, mat='cast', up=(s, 0, 0.3), bev=0.008))
        bz = [(0.05 - GAP, BELT), (-0.01 + GAP, BELT), (-0.01 + GAP, ROOF_Z - 0.02), (0.05 - GAP, ROOF_Z - 0.02)]
        G.add(quad_slab([(s * (gh_x(z) + 0.01), y, z) for y, z in bz], 0.08 if True else 0, mat='rolled', nrm=(s, 0, 0), bev=0.006))
        G.add(box(0.13, 0.12, ROOF_Z - FLOOR_Z - 0.08, c=(s * (GH_X0 - 0.05), 0.02, (ROOF_Z + FLOOR_Z) / 2 - 0.04), mat='cast', bev=0.012, segs=1))
        cp = [(-0.90 - GAP, BELT), (c_pillar_y(BELT), BELT), (c_pillar_y(ROOF_Z - 0.02), ROOF_Z - 0.02), (-0.90 - GAP, ROOF_Z - 0.02)]
        G.add(quad_slab([(s * (gh_x(z) + 0.012), y, z) for y, z in cp], 0.05, mat='rolled', nrm=(s, 0, 0), bev=0.008))
        G.add(beam((s * (GH_X1 + 0.03), ROOF_F, ROOF_Z - 0.015), (s * (GH_X1 + 0.03), ROOF_R, ROOF_Z - 0.015), 0.022, 0.03, bev=0.008))
    # windscreen: curved glass (wrap), rubber surround, header
    wa, wb = V((0, CAB_F, BELT + 0.012)), V((0, ROOF_F + 0.02, ROOF_Z - 0.02))
    up = (wb - wa).normalized(); nrm = V((0, up.z, -up.y))
    if nrm.y < 0:
        nrm = -nrm
    rows = []
    for f in (0.0, 0.5, 1.0):
        p = wa.lerp(wb, f)
        hw = gh_x(p.z) - 0.045
        rows.append([p + V((hw * u, 0, 0)) - nrm * (0.03 * u * u) for u in np.linspace(-1, 1, 7)])
    bm = bmesh.new()
    vv = [[bm.verts.new(p) for p in r] for r in rows]
    for i in range(2):
        for k in range(6):
            bm.faces.new((vv[i][k], vv[i][k + 1], vv[i + 1][k + 1], vv[i + 1][k]))
    ws = B(bm, 'glass').solidify(0.006, 0)
    glass.add(ws)
    edge = rows[0] + [r[-1] for r in rows[1:]] + rows[-1][::-1][1:] + [r[0] for r in rows[::-1][1:-1]]
    G.add(tube([p + nrm * 0.004 for p in edge], 0.014, 5, 'skirt', closed=True))
    G.add(box(2 * GH_X1 - 0.02, 0.06, 0.03, c=(0, ROOF_F + 0.0, ROOF_Z - 0.03), mat='rolled', bev=0.01, segs=1))
    # cowl panel with vent slots, wipers
    G.add(hull([(-GH_X0 + 0.04, CAB_F + 0.02, BELT - 0.01), (GH_X0 - 0.04, CAB_F + 0.02, BELT - 0.01), (-GH_X0 + 0.04, CAB_F + 0.2, BELT - 0.02),
                (GH_X0 - 0.04, CAB_F + 0.2, BELT - 0.02), (-GH_X0 + 0.06, CAB_F + 0.03, BELT + 0.02), (GH_X0 - 0.06, CAB_F + 0.03, BELT + 0.02),
                (-GH_X0 + 0.06, CAB_F + 0.19, BELT + 0.005), (GH_X0 - 0.06, CAB_F + 0.19, BELT + 0.005)], mat='skirt', bev=0.006, segs=1))
    for i in range(12):
        G.add(box(0.05, 0.08, 0.006, c=(-0.55 + i * 0.1, CAB_F + 0.11, BELT + 0.012), mat='decal').rot('X', -6, (0, CAB_F + 0.11, BELT + 0.012)))
    for xp in (-0.38, 0.22):
        piv = V((xp, CAB_F + 0.1, BELT + 0.02))
        G.add(cyl(0.018, 0.025, 10, 'z', c=piv, mat='skirt'))
        # parked: arm + blade lying along the bottom of the glass
        bl0 = wa.lerp(wb, 0.07) + V((xp + 0.02, 0, 0)) + nrm * 0.016
        bl1 = bl0 + V((0.5, 0, 0))
        mid = (bl0 + bl1) / 2 + nrm * 0.012
        G.add(beam(piv + V((0, 0, 0.015)), mid, 0.014, 0.01, mat='skirt', up=nrm))
        G.add(beam(bl0, bl1, 0.022, 0.014, mat='skirt', up=nrm))
    # rear wall above the belt with the rear window
    rz0, rz1 = BELT + 0.1, ROOF_Z - 0.09
    ry = lambda z: c_pillar_y(z) + 0.0
    wx0, wx1 = 0.5, 0.42
    G.add(quad_slab([(-GH_X0 + 0.01, ry(BELT), BELT), (GH_X0 - 0.01, ry(BELT), BELT), (GH_X0 - 0.01, ry(rz0), rz0), (-GH_X0 + 0.01, ry(rz0), rz0)], 0.03, nrm=(0, -1, 0), bev=0.006))
    G.add(quad_slab([(-GH_X1, ry(rz1), rz1), (GH_X1, ry(rz1), rz1), (GH_X1, ry(ROOF_Z), ROOF_Z - 0.01), (-GH_X1, ry(ROOF_Z), ROOF_Z - 0.01)], 0.03, nrm=(0, -1, 0), bev=0.006))
    for s in (1, -1):
        G.add(quad_slab([(s * wx0, ry(rz0), rz0), (s * gh_x(rz0), ry(rz0), rz0), (s * gh_x(rz1), ry(rz1), rz1), (s * wx1, ry(rz1), rz1)], 0.03, nrm=(0, -1, 0)))
    rw = [V((-wx0, ry(rz0) + 0.012, rz0)), V((wx0, ry(rz0) + 0.012, rz0)), V((wx1, ry(rz1) + 0.012, rz1)), V((-wx1, ry(rz1) + 0.012, rz1))]
    glass.add(glass_pane(rw[::-1], 0.006))
    G.add(frame_loop([p - V((0, 0.004, 0)) for p in rw], 0.022))
    # rear wall inner trim + third brake light
    G.add(box(2 * GH_X0 - 0.1, 0.02, BELT - FLOOR_Z + 0.06, c=(0, CAB_R + 0.03, (BELT + FLOOR_Z) / 2 + 0.02), mat='cast', bev=0.006, segs=1))
    G.add(box(0.3, 0.035, 0.035, c=(0, ry(ROOF_Z - 0.03) - 0.02, ROOF_Z - 0.035), mat='era', bev=0.008, segs=1))
    return G


# ================================================================================================ front end
def front_end(glass):
    F = B()
    fy = FRONT
    # grille: rounded black frame, five slats, a vertical divider, dark mesh behind; bonnet front lip above it
    gpts = [(-0.44, 0.74), (0.44, 0.74), (0.47, 0.96), (-0.47, 0.96)]
    F.add(frame_loop([V((x, fy + 0.012, z)) for x, z in gpts], 0.04, 'skirt'))
    F.add(box(0.88, 0.012, 0.21, c=(0, fy + 0.002, 0.85), mat='decal'))
    for i in range(5):
        z = 0.775 + i * 0.038
        w_ = 0.86 + (z - 0.74) * 0.25
        F.add(box(w_, 0.03, 0.016, c=(0, fy + 0.015, z), mat='skirt', bev=0.005, segs=1))
    F.add(box(0.02, 0.03, 0.2, c=(0, fy + 0.016, 0.85), mat='skirt', bev=0.005, segs=1))
    F.add(box(0.95, 0.03, 0.03, c=(0, fy + 0.008, 0.975), mat='bare', bev=0.01, segs=1))       # chrome strip (no badge)
    # headlamps: wrap-around housings, chrome reflector bowls, projector, DRL strip, amber indicator, clear cover
    for s in (1, -1):
        hp = []
        for (x, y, z) in [(0.48, fy + 0.01, 0.975), (0.80, fy - 0.15, 0.985), (0.81, fy - 0.17, 0.88), (0.48, fy + 0.01, 0.86),
                          (0.48, fy - 0.05, 0.975), (0.78, fy - 0.22, 0.985), (0.79, fy - 0.24, 0.88), (0.48, fy - 0.05, 0.86)]:
            hp.append((s * x, y, z))
        F.add(hull(hp, mat='skirt'))
        for xc, r_ in ((0.57, 0.048), (0.69, 0.042)):
            yc = fy + 0.01 - (xc - 0.48) * 0.47
            F.add(lathe([(0, 0.0), (0.02, 0.004, 'bare'), (r_, 0.03, 'bare'), (r_ + 0.006, 0.034)], 18, 'y', mat='bare', c=(s * xc, yc - 0.032, 0.92), cap=False))
            F.add(cyl(0.018, 0.02, 12, 'y', c=(s * xc, yc - 0.02, 0.92), mat='light'))
        F.add(beam((s * 0.5, fy + 0.012, 0.872), (s * 0.78, fy - 0.15, 0.885), 0.012, 0.012, mat='light'))
        F.add(beam((s * 0.775, fy - 0.135, 0.955), (s * 0.80, fy - 0.19, 0.955), 0.03, 0.04, mat='cage'))
        cov = [(s * 0.475, fy + 0.025, 0.982), (s * 0.815, fy - 0.15, 0.992), (s * 0.825, fy - 0.17, 0.875), (s * 0.475, fy + 0.025, 0.853),
               (s * 0.47, fy + 0.012, 0.982), (s * 0.80, fy - 0.15, 0.99), (s * 0.81, fy - 0.17, 0.877), (s * 0.47, fy + 0.012, 0.855)]
        glass.add(hull(cov, mat='glass'))
        # side repeater on the fender
        F.add(box(0.008, 0.05, 0.02, c=(s * (BW - 0.015), 1.85, 0.93), mat='cage', bev=0.003, segs=1))
    # bumper: painted upper bar wrapping round the corners, black lower apron, fog lamps, intake, plate holder
    bp = []
    for s in (1, -1):
        bp += [(s * 0.6, fy + 0.11, 0.56), (s * 0.6, fy + 0.11, 0.74), (s * (BW - 0.01), fy - 0.22, 0.58), (s * (BW - 0.01), fy - 0.24, 0.75),
               (s * 0.6, fy - 0.03, 0.55), (s * 0.6, fy - 0.03, 0.76), (s * (BW - 0.03), fy - 0.30, 0.6), (s * (BW - 0.03), fy - 0.30, 0.75)]
    F.add(hull(bp, mat='rolled', bev=0.03, segs=2))
    lp = []
    for s in (1, -1):
        lp += [(s * 0.6, fy + 0.10, 0.42), (s * 0.6, fy + 0.10, 0.57), (s * (BW - 0.04), fy - 0.22, 0.46), (s * (BW - 0.04), fy - 0.22, 0.58),
               (s * 0.6, fy - 0.1, 0.40), (s * 0.6, fy - 0.1, 0.57), (s * (BW - 0.05), fy - 0.32, 0.46), (s * (BW - 0.05), fy - 0.32, 0.58)]
    F.add(hull(lp, mat='skirt', bev=0.02, segs=2))
    F.add(box(0.7, 0.02, 0.07, c=(0, fy + 0.105, 0.49), mat='decal'))
    F.add(box(0.52, 0.015, 0.12, c=(0, fy + 0.118, 0.65), mat='skirt', bev=0.004, segs=1))
    for s in (1, -1):
        F.add(box(0.13, 0.03, 0.08, c=(s * 0.7, fy + 0.03, 0.50), mat='decal', bev=0.01, segs=1).rot('Z', s * 28, (s * 0.7, fy + 0.03, 0.5)))
        F.add(cyl(0.032, 0.02, 14, 'y', c=(s * 0.7, fy + 0.04, 0.50), mat='light').rot('Z', s * 28, (s * 0.7, fy + 0.03, 0.5)))
    F.add(box(1.0, 0.5, 0.012, c=(0, fy - 0.28, 0.42), mat='gunmetal'))          # skid plate
    # bonnet: scoop, shut lines, washer jets
    sz = lambda y: front_surface_z(0, y)
    F.add(hull([(-0.27, 1.95, sz(1.95) - 0.01), (0.27, 1.95, sz(1.95) - 0.01), (-0.23, 1.5, sz(1.5) - 0.01), (0.23, 1.5, sz(1.5) - 0.01),
                (-0.21, 1.62, sz(1.62) + 0.045), (0.21, 1.62, sz(1.62) + 0.045), (-0.24, 1.9, sz(1.9) + 0.01), (0.24, 1.9, sz(1.9) + 0.01)], bev=0.015, segs=2))
    F.add(box(0.34, 0.02, 0.028, c=(0, 1.605, sz(1.62) + 0.025), mat='decal').rot('X', -8, (0, 1.605, sz(1.62) + 0.025)))
    for s in (1, -1):
        F.add(strip_on(front_surface_z, [(s * 0.79, y) for y in np.linspace(CAB_F + 0.21, FRONT - 0.035, 14)], 0.005))
        F.add(box(0.025, 0.03, 0.014, c=(s * 0.28, CAB_F + 0.3, sz(CAB_F + 0.3) + 0.004), mat='skirt'))
    F.add(strip_on(front_surface_z, [(x, CAB_F + 0.21) for x in np.linspace(-0.79, 0.79, 12)], 0.005))
    return F


def bull_bar():
    R_ = B()
    y = FRONT + 0.2
    for s in (1, -1):
        R_.add(rail([(s * 0.36, y - 0.15, 0.42), (s * 0.36, y, 0.45), (s * 0.36, y, 1.0), (s * 0.42, y - 0.06, 1.05)], r=0.03, rad=0.06, mat='gunmetal', foot=False))
        R_.add(rail([(s * 0.36, y, 0.62), (s * 0.70, y - 0.17, 0.65), (s * 0.80, y - 0.30, 0.64)], r=0.024, rad=0.08, mat='gunmetal', foot=False))
        R_.add(box(0.1, 0.13, 0.12, c=(s * 0.36, y - 0.08, 0.68), mat='gunmetal', bev=0.01, segs=1))   # mount plate into the bumper
        R_.add(box(0.06, 0.2, 0.06, c=(s * 0.36, y - 0.2, 0.47), mat='gunmetal', bev=0.008, segs=1))   # lower mount to the chassis horn
    R_.add(rail([(-0.42, y - 0.06, 1.05), (-0.3, y + 0.02, 1.08), (0.3, y + 0.02, 1.08), (0.42, y - 0.06, 1.05)], r=0.03, rad=0.12, mat='gunmetal', foot=False))
    for x in (-0.18, 0.0, 0.18):
        R_.add(tube([(x, y + 0.015, 0.45), (x, y + 0.02, 1.09)], 0.016, 8, 'gunmetal'))
    R_.add(box(0.78, 0.05, 0.1, c=(0, y, 0.45), mat='gunmetal', bev=0.012, segs=1))
    for s in (1, -1):    # spot lamps on the hoop
        R_.add(lathe([(0, -0.05), (0.06, -0.04), (0.065, 0.0), (0.06, 0.02)], 16, 'y', mat='skirt', c=(s * 0.26, y + 0.04, 1.15), cap=True))
        R_.add(cyl(0.055, 0.008, 16, 'y', c=(s * 0.26, y + 0.065, 1.15), mat='light'))
        R_.add(box(0.03, 0.03, 0.05, c=(s * 0.26, y + 0.03, 1.1), mat='gunmetal'))
    return R_


def flares_and_trim():
    Fl = B()
    for s in (1, -1):
        for yc in (AXF, AXR):
            pts = []
            a0 = math.asin((SILL - 0.02 - WZ) / (RA + 0.035))
            for a in np.linspace(math.pi - a0, a0, 22):
                pts.append(V((s * (BW - 0.005), yc + (RA + 0.035) * math.cos(a), WZ + (RA + 0.035) * math.sin(a))))
            Fl.add(tube(pts, 0.035, 6, 'skirt').scale(1, 1, 1))
            Fl.add(box(0.24, 0.012, 0.22, c=(s * (TRACK / 2 + 0.03), yc - RA - 0.07, SILL - 0.08), mat='skirt', bev=0.004, segs=1))
            Fl.add(box(0.05, 0.05, 0.05, c=(s * (TRACK / 2 + 0.03), yc - RA - 0.06, SILL + 0.01), mat='gunmetal'))
        # side step: tube on two outriggers between the arches
        Fl.add(rail([(s * 0.6, AXF - RA - 0.04, 0.38), (s * (BW + 0.05), AXF - RA - 0.1, 0.36), (s * (BW + 0.05), AXR + RA + 0.1, 0.36), (s * 0.6, AXR + RA + 0.04, 0.38)], r=0.032, rad=0.1, mat='bare', foot=False))
        for yy in (0.6, -0.5):
            Fl.add(box(BW - 0.45 + 0.06, 0.06, 0.05, c=(s * (0.45 + BW + 0.06) / 2, yy, 0.38), mat='gunmetal'))
        Fl.add(box(0.03, 2.0, 0.018, c=(s * (BW + 0.05), (AXF + AXR) / 2 - 0.06, 0.393), mat='skirt'))      # step tread strip
    return Fl


def roof_rack():
    R_ = B()
    zr = ROOF_Z + 0.16
    for s in (1, -1):
        R_.add(rail([(s * 0.66, ROOF_F + 0.05, zr - 0.02), (s * 0.66, ROOF_F, zr), (s * 0.66, ROOF_R, zr), (s * 0.66, ROOF_R - 0.05, zr - 0.02)], r=0.02, rad=0.05, mat='gunmetal', foot=False))
        for y in (ROOF_F - 0.05, -0.2, ROOF_R + 0.05):
            R_.add(box(0.05, 0.08, 0.15, c=(s * 0.67, y, ROOF_Z + 0.075), mat='gunmetal', bev=0.01, segs=1))
            R_.add(box(0.09, 0.09, 0.03, c=(s * (GH_X1 + 0.01), y, ROOF_Z - 0.0), mat='gunmetal', bev=0.006, segs=1))      # gutter clamp
    for y in np.linspace(ROOF_F, ROOF_R, 6):
        R_.add(tube([(-0.66, y, zr), (0.66, y, zr)], 0.016, 8, 'gunmetal'))
    # 20 l jerrycan strapped beside the spare: pressed X panels, three handles, spout
    jz = zr + 0.016 + 0.083
    can = box(0.165, 0.47, 0.35, c=(0, 0, 0), mat='rolled', bev=0.02, segs=2)
    for sx in (1, -1):
        can.add(beam((sx * 0.083, -0.17, -0.12), (sx * 0.083, 0.17, 0.12), 0.008, 0.03, up=(sx, 0, 0)))
        can.add(beam((sx * 0.083, -0.17, 0.12), (sx * 0.083, 0.17, -0.12), 0.008, 0.03, up=(sx, 0, 0)))
    for yy in (-0.12, 0.0, 0.12):
        can.add(box(0.03, 0.06, 0.04, c=(0, yy, 0.19), mat='rolled', bev=0.008, segs=1))
    can.add(cyl(0.025, 0.05, 10, 'z', c=(0, 0.19, 0.19), mat='rolled'))
    can.rot('Y', 90)
    R_.add(can.move(0.40, -0.35, jz))
    R_.add(box(0.36, 0.03, 0.01, c=(0.40, -0.35, jz + 0.088), mat='canvas'))
    for dx in (-0.178, 0.178):
        R_.add(box(0.01, 0.03, 0.17, c=(0.40 + dx, -0.35, jz), mat='canvas'))
    return R_


# ================================================================================================ doors / tailgate
def door(side, which):
    """door: lofted outer skin, painted window frame with the black B-pillar applique, door card + armrest + pull,
    window sill trim, outer handle in a recess, hinges, mirror (front).  Returns (part, glass part, hinge point)."""
    y0, y1 = DOORS[which]
    s = side
    D = door_skin(s, which)
    zt = ROOF_Z - 0.035
    sx = lambda z, o=0.0: s * (gh_x(z) + o)
    if which == 'F':
        wp = [(y1 + GAP, BELT + 0.005), (y0 - GAP, BELT + 0.005), (a_pillar_y(zt) - 0.05, zt), (y1 + GAP, zt)]
    else:
        wp = [(y1 + GAP, BELT + 0.005), (y0 - GAP, BELT + 0.005), (y0 - GAP, zt), (y1 + GAP, zt)]
    loop = [V((sx(z), y, z)) for y, z in wp]
    fw = 0.034
    for i in range(4):
        p0, p1 = loop[i], loop[(i + 1) % 4]
        d = (p1 - p0).normalized()
        black = (which == 'F' and i == 3) or (which == 'R' and i == 1)      # B-pillar side: black applique
        mt = 'skirt' if black else 'rolled'
        if i == 0:
            continue                                                   # bottom member = door top (skin shoulder)
        D.add(beam(p0 - d * fw * 0.5, p1 + d * fw * 0.5, fw, 0.035, mat=mt, up=(s, 0, 0) if abs(d.z) < 0.9 else (s, 0, 0), bev=0.006))
    # glass (inset in the frame), rubber channel along the bottom
    gp = [V((sx(z, -0.006), y, z)) for y, z in [(wp[0][0] + 0.02, BELT + 0.01), (wp[1][0] - 0.02, BELT + 0.01),
                                               (wp[2][0] - (0.03 if which == 'F' else 0.02), zt - 0.025), (wp[3][0] + 0.02, zt - 0.025)]]
    G = glass_pane(gp if s > 0 else gp[::-1], 0.006)
    D.add(beam(V((sx(BELT + 0.012, 0.004), y1 + 0.02, BELT + 0.012)), V((sx(BELT + 0.012, 0.004), y0 - 0.02, BELT + 0.012)), 0.014, 0.016, mat='skirt'))
    # inner window-sill trim + door card (interior plastic) with armrest, pull handle, speaker, map pocket
    yi0, yi1 = y0 - 0.035, y1 + 0.035
    D.add(box(0.06, yi0 - yi1, 0.035, c=(s * 0.835, (yi0 + yi1) / 2, BELT - 0.01), mat='skirt', bev=0.008, segs=1))
    D.add(box(0.045, yi0 - yi1, BELT - 0.6, c=(s * 0.8375, (yi0 + yi1) / 2, (BELT + 0.56) / 2 - 0.02), mat='cast', bev=0.01, segs=1))
    D.add(box(0.07, (yi0 - yi1) * 0.55, 0.05, c=(s * 0.79, (yi0 + yi1) / 2 - 0.03, 0.85), mat='cast', bev=0.015, segs=2))
    D.add(box(0.03, 0.12, 0.03, c=(s * 0.80, yi1 + 0.12, 0.95), mat='bare', bev=0.008, segs=1))
    D.add(cyl(0.065, 0.012, 16, 'x', c=(s * 0.81, yi0 - 0.12, 0.66), mat='decal'))
    D.add(box(0.04, (yi0 - yi1) * 0.6, 0.1, c=(s * 0.80, (yi0 + yi1) / 2 + 0.02, 0.64), mat='cast', bev=0.01, segs=1))
    D.add(box(0.03, 0.08, 0.04, c=(s * 0.80, yi1 + 0.2, 1.0), mat='skirt', bev=0.006, segs=1))       # lock knob / inner release
    # outer handle in a recess, key lock on the front doors
    hy = y1 + 0.14
    hz = BELT - 0.11
    xs_ = half_section(*front_dims(hy))
    xo = max(x for x, z in xs_ if abs(z - hz) < 0.08)
    D.add(box(0.01, 0.17, 0.055, c=(s * (xo - 0.002), hy, hz), mat='decal', bev=0.003, segs=1))
    D.add(box(0.025, 0.15, 0.03, c=(s * (xo + 0.008), hy, hz + 0.004), mat='skirt', bev=0.008, segs=2))
    if which == 'F':
        D.add(cyl(0.012, 0.012, 10, 'x', c=(s * (xo + 0.006), hy + 0.11, hz + 0.005), mat='bare'))
    # hinges on the front edge
    for z in (0.66, 0.98):
        D.add(cyl(0.013, 0.07, 10, 'z', c=(s * (BW + 0.012), y0 + 0.0, z), mat='gunmetal'))
        D.add(box(0.02, 0.05, 0.06, c=(s * (BW - 0.004), y0 - 0.02, z), mat='gunmetal'))
    if which == 'F':
        # mirror: sail on the window corner, arm, housing, glass
        mz = BELT + 0.08
        my = y0 - 0.1
        D.add(hull([(s * (gh_x(BELT) - 0.01), my + 0.06, BELT + 0.0), (s * (gh_x(BELT) - 0.01), my - 0.08, BELT + 0.0), (s * (gh_x(BELT + 0.12) - 0.01), my + 0.0, BELT + 0.12),
                    (s * (gh_x(BELT) + 0.03), my + 0.04, BELT + 0.01), (s * (gh_x(BELT) + 0.03), my - 0.06, BELT + 0.01), (s * (gh_x(BELT + 0.1) + 0.03), my, BELT + 0.1)], mat='skirt', bev=0.006, segs=1))
        D.add(beam((s * (gh_x(BELT) + 0.02), my, mz - 0.02), (s * (BW + 0.13), my - 0.03, mz), 0.04, 0.035, mat='skirt', bev=0.01))
        mh = []
        for (x, y, z) in [(0.08, -0.0, -0.09), (0.30, -0.03, -0.085), (0.08, 0.0, 0.09), (0.29, -0.03, 0.09),
                          (0.085, -0.1, -0.08), (0.28, -0.12, -0.075), (0.085, -0.1, 0.08), (0.27, -0.12, 0.08)]:
            mh.append((s * (BW + x), my + y + 0.02, mz + z))
        D.add(hull(mh, mat='skirt', bev=0.025, segs=2))
        D.add(box(0.18, 0.006, 0.15, c=(s * (BW + 0.185), my - 0.105, mz + 0.002), mat='light'))
        D.add(box(0.05, 0.01, 0.015, c=(s * (BW + 0.27), my - 0.09, mz - 0.06), mat='cage'))      # indicator
    hinge = (s * (BW + 0.012), y0, 0.8)
    return D, G, hinge


def tailgate():
    y1 = REAR
    TG = B()
    h = BED_TOP - TG_Z - 0.01
    zc = TG_Z + h / 2 + 0.005
    TG.add(box(2 * BED_IN - 0.012, 0.05, h, c=(0, y1 + 0.025, zc), bev=0.014, segs=2))
    for z0_, z1_ in ((TG_Z + 0.05, TG_Z + 0.2), (TG_Z + 0.25, BED_TOP - 0.06)):          # pressed panels
        TG.add(box(2 * BED_IN - 0.16, 0.01, z1_ - z0_, c=(0, y1 - 0.002, (z0_ + z1_) / 2), bev=0.004, segs=1))
    TG.add(box(0.24, 0.02, 0.07, c=(0, y1 - 0.005, BED_TOP - 0.1), mat='skirt', bev=0.01, segs=2))       # handle bezel
    TG.add(box(0.16, 0.02, 0.025, c=(0, y1 - 0.014, BED_TOP - 0.107), mat='skirt', bev=0.006, segs=1))
    TG.add(box(2 * BED_IN - 0.08, 0.012, h - 0.08, c=(0, y1 + 0.054, zc), mat='canvas', bev=0.004, segs=1))   # inner liner
    for s in (1, -1):
        TG.add(cyl(0.02, 0.05, 10, 'x', c=(s * (BED_IN - 0.04), y1 + 0.025, TG_Z), mat='gunmetal'))            # hinge cups
        TG.add(cyl(0.01, 0.03, 8, 'x', c=(s * (BED_IN - 0.02), y1 + 0.04, BED_TOP - 0.06), mat='bare'))        # check-cable pin
        TG.add(tube([(s * (BED_IN - 0.02), y1 + 0.04, BED_TOP - 0.06), (s * (BED_IN - 0.02), y1 + 0.03, BED_TOP - 0.18)], 0.005, 5, 'bare'))
        TG.add(box(0.03, 0.03, 0.05, c=(s * (BED_IN - 0.02), y1 + 0.025, BED_TOP - 0.05), mat='bare'))           # latch
    return TG, (0, y1 + 0.025, TG_Z)


# ================================================================================================ interior
def seat(xc, yh, zh, width=0.5, rear=False):
    """bucket seat around H point (xc, yh, zh): cushion with bolsters, reclined backrest, headrest on two posts, runners"""
    S = B()
    w = width / 2
    zc = zh - 0.03
    cush = hull([(xc - w, yh - 0.1, zc - 0.1), (xc + w, yh - 0.1, zc - 0.1), (xc - w, yh + 0.42, zc - 0.08), (xc + w, yh + 0.42, zc - 0.08),
                 (xc - w + 0.02, yh - 0.1, zc), (xc + w - 0.02, yh - 0.1, zc), (xc - w + 0.02, yh + 0.40, zc + 0.04), (xc + w - 0.02, yh + 0.40, zc + 0.04)],
                mat='cast', bev=0.035, segs=3)
    S.add(cush)
    for sx in (-1, 1):   # cushion side bolsters
        S.add(box(0.07, 0.42, 0.05, c=(xc + sx * (w - 0.04), yh + 0.15, zc + 0.03), mat='cast', bev=0.025, segs=2))
    # backrest, reclined ~17 deg
    rk = math.radians(17)
    bb = V((xc, yh - 0.13, zc - 0.06))
    bt = bb + V((0, -math.sin(rk), math.cos(rk))) * 0.6
    back = beam(bb, bt, 2 * w - 0.02, 0.12, mat='cast', up=(0, 1, 0.3), bev=0.035)
    S.add(back)
    for sx in (-1, 1):
        S.add(beam(bb + V((sx * (w - 0.035), 0.04, 0.05)), bt + V((sx * (w - 0.035), 0.04, -0.1)), 0.07, 0.1, mat='cast', up=(0, 1, 0.3), bev=0.025))
    # headrest + posts
    for sx in (-0.07, 0.07):
        S.add(cyl(0.007, 0.12, 6, 'z', c=(xc + sx, bt.y - 0.005, bt.z + 0.04), mat='bare'))
    S.add(box(0.26, 0.09, 0.17, c=(xc, bt.y - 0.01, bt.z + 0.17), mat='cast', bev=0.035, segs=2))
    if not rear:
        # base frame + runners down to the floor, recline lever
        S.add(box(2 * w - 0.12, 0.42, zc - 0.1 - FLOOR_Z + 0.005, c=(xc, yh + 0.15, (zc - 0.1 + FLOOR_Z) / 2), mat='gunmetal'))
        for sx in (-1, 1):
            S.add(box(0.03, 0.55, 0.03, c=(xc + sx * (w - 0.1), yh + 0.15, FLOOR_Z + 0.015), mat='bare'))
        S.add(box(0.02, 0.1, 0.02, c=(xc + (w + 0.005) * (1 if xc > 0 else -1), yh - 0.05, zc - 0.05), mat='skirt'))
    return S


def interior():
    I = B()
    # floor (carpet), transmission tunnel, rubber mats, kick panels
    I.add(box(1.72, CAB_F - CAB_R - 0.08, 0.045, c=(0, (CAB_F + CAB_R) / 2 - 0.02, FLOOR_Z - 0.0225), mat='cast'))
    I.add(hull([(-0.15, 0.25, FLOOR_Z - 0.01), (0.15, 0.25, FLOOR_Z - 0.01), (-0.15, 1.1, FLOOR_Z - 0.01), (0.15, 1.1, FLOOR_Z - 0.01),
                (-0.1, 0.25, 0.66), (0.1, 0.25, 0.66), (-0.1, 1.1, 0.72), (0.1, 1.1, 0.72)], mat='cast', bev=0.03, segs=2))
    for x in (-0.45, 0.45):
        I.add(box(0.5, 0.42, 0.012, c=(x, 0.78, FLOOR_Z + 0.006), mat='skirt', bev=0.004, segs=1))
        I.add(box(0.5, 0.32, 0.012, c=(x, -0.12, FLOOR_Z + 0.006), mat='skirt', bev=0.004, segs=1))
    # firewall / toe board
    I.add(hull([(-0.85, 1.0, FLOOR_Z - 0.01), (0.85, 1.0, FLOOR_Z - 0.01), (-0.85, 1.2, FLOOR_Z - 0.01), (0.85, 1.2, FLOOR_Z - 0.01),
                (-0.85, 1.2, 0.8), (0.85, 1.2, 0.8), (-0.85, 1.12, 0.8), (0.85, 1.12, 0.8)], mat='cast'))
    # dashboard: main moulding, top pad, driver binnacle, centre stack, vents, glovebox, gauges
    dash = []
    for s in (1, -1):
        dash += [(s * 0.84, 0.93, 0.74), (s * 0.84, 0.90, 1.02), (s * 0.84, 0.97, 1.09), (s * 0.84, 1.18, 1.12), (s * 0.84, 1.16, 0.74)]
    I.add(hull(dash, mat='cast', bev=0.03, segs=2))
    I.add(hull([(-0.82, 0.92, 1.06), (0.82, 0.92, 1.06), (-0.82, 1.19, 1.13), (0.82, 1.19, 1.13), (-0.82, 0.95, 1.105), (0.82, 0.95, 1.105),
                (-0.82, 1.17, 1.145), (0.82, 1.17, 1.145)], mat='skirt', bev=0.02, segs=2))
    I.add(hull([(-0.58, 0.94, 1.08), (-0.22, 0.94, 1.08), (-0.58, 1.06, 1.08), (-0.22, 1.06, 1.08), (-0.56, 0.95, 1.18), (-0.24, 0.95, 1.18),
                (-0.55, 1.05, 1.17), (-0.25, 1.05, 1.17)], mat='skirt', bev=0.02, segs=2))
    for xg in (-0.47, -0.33):
        I.add(cyl(0.055, 0.01, 18, 'y', c=(xg, 0.935, 1.03), mat='decal'))
        I.add(cyl(0.05, 0.004, 18, 'y', c=(xg, 0.93, 1.03), mat='light').scale(1, 1, 1))
        I.add(beam((xg, 0.925, 1.03), (xg + 0.03, 0.925, 1.06), 0.006, 0.004, mat='era'))
    I.add(box(0.28, 0.06, 0.32, c=(0, 0.905, 0.92), mat='skirt', bev=0.015, segs=2))        # centre stack
    I.add(box(0.2, 0.01, 0.11, c=(0, 0.872, 0.99), mat='decal', bev=0.004, segs=1))           # radio / screen
    for i in range(4):
        I.add(cyl(0.012, 0.012, 10, 'y', c=(-0.075 + i * 0.05, 0.872, 0.9), mat='bare'))       # knobs
    for xv in (-0.75, -0.07, 0.07, 0.75):
        I.add(box(0.1, 0.012, 0.06, c=(xv, 0.885 if abs(xv) < 0.5 else 0.91, 1.07 if abs(xv) < 0.5 else 1.0), mat='decal', bev=0.005, segs=1))
    I.add(beam((0.22, 0.905, 0.86), (0.7, 0.905, 0.86), 0.006, 0.006, mat='decal'))              # glovebox shut line
    I.add(beam((0.22, 0.905, 0.98), (0.7, 0.9, 0.98), 0.006, 0.006, mat='decal'))
    I.add(box(0.08, 0.02, 0.03, c=(0.46, 0.895, 0.95), mat='skirt'))
    # steering wheel + column (LHD: driver on the left)
    C = V((-0.40, 0.80, 1.06))
    n = V((0, -0.92, 0.39)).normalized()
    u = V((1, 0, 0)); v_ = n.cross(u).normalized()
    ring = [C + (u * math.cos(a) + v_ * math.sin(a)) * 0.185 for a in np.linspace(0, math.tau, 24, endpoint=False)]
    I.add(tube(ring, 0.017, 8, 'skirt', closed=True))
    I.add(lathe([(0, 0.0), (0.065, 0.0), (0.06, 0.035), (0, 0.045)], 16, 'z', mat='skirt').xf(L.place(L.frame_from_normal(n), C - n * 0.02)))
    for a in (0, 180, 270):
        r_ = math.radians(a)
        p = C + (u * math.cos(r_) + v_ * math.sin(r_)) * 0.18
        I.add(beam(C, p, 0.05 if a == 270 else 0.035, 0.018, mat='skirt', up=n))
    I.add(beam(C - n * 0.03, C - n * 0.30 + V((0, 0, -0.06)), 0.07, 0.07, mat='skirt', up=(0, 0, 1), bev=0.02))
    I.add(beam(C - n * 0.08 + V((0.07, 0, 0.02)), C - n * 0.08 + V((0.2, 0, 0.0)), 0.012, 0.02, mat='skirt'))     # stalks
    I.add(beam(C - n * 0.08 + V((-0.07, 0, 0.02)), C - n * 0.08 + V((-0.2, 0, 0.0)), 0.012, 0.02, mat='skirt'))
    for i, x in enumerate((-0.5, -0.4, -0.3)):          # pedals
        I.add(box(0.06 if i else 0.1, 0.015, 0.08, c=(x, 1.04, 0.64), mat='skirt').rot('X', 20, (x, 1.04, 0.64)))
        I.add(beam((x, 1.06, 0.68), (x, 1.12, 0.86), 0.015, 0.015, mat='bare'))
    # gear lever + transfer lever + handbrake, centre console with cup holders + armrest
    I.add(lathe([(0.0, 0.0), (0.07, 0.0), (0.045, 0.06), (0.012, 0.11), (0, 0.11)], 12, 'z', mat='skirt', c=(0, 0.78, 0.66)))
    I.add(beam((0, 0.78, 0.7), (0, 0.74, 0.86), 0.014, 0.014, mat='bare'))
    I.add(lathe([(0, -0.02), (0.022, -0.012), (0.026, 0.01), (0.015, 0.03), (0, 0.032)], 12, 'z', mat='skirt', c=(0, 0.735, 0.875)))
    I.add(lathe([(0.0, 0.0), (0.04, 0.0), (0.03, 0.04), (0, 0.05)], 10, 'z', mat='skirt', c=(0.07, 0.68, 0.655)))
    I.add(beam((0.07, 0.68, 0.68), (0.06, 0.65, 0.78), 0.012, 0.012, mat='bare'))
    I.add(cyl(0.017, 0.035, 10, 'z', c=(0.06, 0.648, 0.79), mat='era'))
    I.add(box(0.26, 0.45, 0.24, c=(0, 0.36, FLOOR_Z + 0.12), mat='cast', bev=0.02, segs=2))
    I.add(box(0.24, 0.3, 0.06, c=(0, 0.3, FLOOR_Z + 0.27), mat='cast', bev=0.025, segs=2))
    I.add(beam((-0.03, 0.5, 0.735), (-0.03, 0.58, 0.79), 0.03, 0.06, mat='skirt', bev=0.008))          # handbrake
    for x in (-0.05, 0.05):
        I.add(cyl(0.035, 0.005, 14, 'z', c=(x, 0.62, FLOOR_Z + 0.242), mat='decal'))
    # seats: two front buckets, rear bench (three headrests), seat belts on the B pillars
    for x, y, z in SEATS[:2]:
        I.add(seat(x, y, z))
    rb = seat(0.0, -0.52, 0.86, width=1.56, rear=True)
    I.add(rb)
    for x in (-0.45, 0.45):
        for sx in (-0.07, 0.07):
            I.add(cyl(0.007, 0.12, 6, 'z', c=(x + sx, -0.85, 1.43), mat='bare'))
        I.add(box(0.26, 0.09, 0.15, c=(x, -0.855, 1.54), mat='cast', bev=0.035, segs=2))
    I.add(box(1.5, 0.45, 0.3, c=(0, -0.43, FLOOR_Z + 0.15), mat='cast', bev=0.02, segs=1))      # bench base
    for s in (1, -1):
        I.add(beam((s * 0.742, 0.02, 1.62), (s * 0.742, 0.02, 0.62), 0.045, 0.006, mat='skirt'))
        I.add(beam((s * 0.80, -0.88, 1.62), (s * 0.80, -0.70, 0.84), 0.045, 0.006, mat='skirt'))
        I.add(box(0.02, 0.03, 0.06, c=(s * 0.735, 0.02, 1.6), mat='bare'))
        # A-pillar grab handle, door aperture seals
        I.add(rail([(s * 0.76, CAB_F - 0.12, 1.42), (s * 0.72, CAB_F - 0.17, 1.44), (s * 0.72, CAB_F - 0.27, 1.52), (s * 0.76, CAB_F - 0.32, 1.54)], r=0.012, rad=0.03, mat='skirt', foot=False))
    # ---- clutter: trauma bag on the rear left seat, helmet on the rear centre, handheld radio on the dash, IFAK on the console
    bag = box(0.42, 0.27, 0.24, c=(0, 0, 0), mat='era', bev=0.04, segs=2)
    bag.add(box(0.2, 0.06, 0.012, c=(0, 0, 0.122), mat='rolled'))
    bag.add(box(0.06, 0.2, 0.012, c=(0, 0, 0.122), mat='rolled'))
    bag.add(box(0.36, 0.008, 0.012, c=(0, 0.06, 0.118), mat='skirt'))
    for x in (-0.08, 0.08):
        bag.add(rail([(x, -0.05, 0.12), (x, -0.05, 0.17), (x, 0.05, 0.17), (x, 0.05, 0.12)], r=0.008, rad=0.03, mat='skirt', foot=False))
    bag.add(box(0.2, 0.012, 0.14, c=(0, -0.14, -0.01), mat='era', bev=0.01, segs=1))
    I.add(bag.rot('Z', 12).move(-0.42, -0.45, 0.83 + 0.12))
    hel = lathe([(0.0, 0.17), (0.07, 0.165), (0.12, 0.13), (0.15, 0.07), (0.16, 0.0), (0.165, -0.005), (0.15, -0.005), (0.14, 0.0)], 18, 'z', mat='gunmetal', cap=False)
    hel.scale(1, 1.15, 0.95)
    hel.add(box(0.05, 0.04, 0.03, c=(0, 0.17, 0.11), mat='skirt'))
    hel.add(tube([(-0.13, 0.0, 0.0), (-0.08, -0.06, -0.05), (0.0, -0.08, -0.06), (0.08, -0.06, -0.05), (0.13, 0.0, 0.0)], 0.008, 5, 'skirt'))
    I.add(hel.rot('Z', -25).rot('X', 8).move(0.0, -0.43, 0.83))
    rad = box(0.065, 0.035, 0.18, c=(0, 0, 0), mat='skirt', bev=0.008, segs=1)
    rad.add(cyl(0.012, 0.16, 8, 'z', c=(0.015, 0, 0.17), mat='skirt'))
    rad.add(cyl(0.012, 0.02, 8, 'z', c=(-0.015, 0, 0.1), mat='bare'))
    rad.add(box(0.045, 0.004, 0.035, c=(0, -0.019, 0.05), mat='decal'))
    I.add(rad.rot('X', 90).rot('Z', 30).move(0.45, 1.05, 1.155))
    ifak = box(0.16, 0.1, 0.18, c=(0, 0, 0), mat='era', bev=0.02, segs=2)
    ifak.add(box(0.06, 0.02, 0.012, c=(0, 0.0, 0.09), mat='rolled'))
    ifak.add(box(0.02, 0.06, 0.012, c=(0, 0.0, 0.09), mat='rolled'))
    I.add(ifak.rot('Z', 70).move(0.0, 0.3, FLOOR_Z + 0.30 + 0.09))
    # interior side trims below the windows between the doors / at the rear quarter (seen with the doors open)
    for s in (1, -1):
        I.add(box(0.05, 0.12, BELT - FLOOR_Z, c=(s * 0.835, -0.92 + 0.05, (BELT + FLOOR_Z) / 2), mat='cast'))
        I.add(box(0.13, 0.06, BELT - FLOOR_Z - 0.02, c=(s * 0.81, 1.135, (BELT + FLOOR_Z) / 2), mat='cast'))        # kick panel / A-pillar foot
        I.add(box(0.06, CAB_F - CAB_R - 0.1, 0.06, c=(s * 0.84, (CAB_F + CAB_R) / 2, FLOOR_Z + 0.0), mat='skirt'))     # sill scuff plate
    return I


# ================================================================================================ chassis / running gear
def coil(p0, p1, r, wire, turns=6, mat='bare'):
    p0, p1 = V(p0), V(p1)
    ax = (p1 - p0); ln = ax.length; ax.normalize()
    M = L.frame_from_normal(ax)
    u = M.col[0].xyz; v_ = M.col[1].xyz
    pts = [p0 + ax * (ln * t / (turns * 12)) + (u * math.cos(t * math.tau / 12) + v_ * math.sin(t * math.tau / 12)) * r for t in range(turns * 12 + 1)]
    return tube(pts, wire, 5, mat)


def chassis():
    C_ = B()
    # ladder frame: boxed rails with a kick-up over the rear axle, crossmembers, body mounts
    for s in (1, -1):
        x = s * 0.44
        path = [(x, 2.35, 0.47), (x, 1.2, 0.46), (x, -0.9, 0.44), (x, -1.05, 0.5), (x, -1.85, 0.5), (x, -2.0, 0.47), (x, -2.5, 0.47)]
        for i in range(len(path) - 1):
            C_.add(beam(path[i], path[i + 1], 0.07, 0.16, mat='gunmetal'))
        for yy in (2.0, 1.2, 0.3, -0.7, -1.4, -2.2):
            zt = 0.47 + 0.08 if yy > -0.9 or yy < -1.95 else 0.5 + 0.08
            C_.add(box(s * 0.0 + 0.12, 0.08, 0.05, c=(s * 0.53, yy, zt - 0.02), mat='gunmetal'))
            C_.add(cyl(0.035, 0.03, 10, 'z', c=(s * 0.56, yy, zt + 0.01), mat='skirt'))
    for y, z in ((2.25, 0.47), (1.25, 0.46), (0.15, 0.45), (-1.3, 0.5), (-2.45, 0.47)):
        C_.add(box(0.82, 0.07, 0.09, c=(0, y, z), mat='gunmetal'))
    # front IFS: lower + upper wishbones, knuckles, coil-over, CV shafts, front diff, steering rack, sway bar, skid plate
    for s in (1, -1):
        kx = s * (TRACK / 2 - 0.13)
        C_.add(beam((s * 0.42, AXF + 0.16, 0.36), (kx, AXF, WZ - 0.1), 0.05, 0.035, mat='gunmetal'))
        C_.add(beam((s * 0.42, AXF - 0.16, 0.36), (kx, AXF, WZ - 0.1), 0.05, 0.035, mat='gunmetal'))
        C_.add(beam((s * 0.47, AXF + 0.1, 0.62), (kx - s * 0.02, AXF, WZ + 0.14), 0.04, 0.03, mat='gunmetal'))
        C_.add(beam((s * 0.47, AXF - 0.1, 0.62), (kx - s * 0.02, AXF, WZ + 0.14), 0.04, 0.03, mat='gunmetal'))
        C_.add(box(0.06, 0.1, 0.3, c=(kx + s * 0.015, AXF, WZ + 0.02), mat='gunmetal', bev=0.01, segs=1))
        C_.add(lathe([(0, 0), (0.07, 0), (0.07, 0.03), (0, 0.03)], 14, 'x', mat='bare', c=(kx + s * 0.04 - (0.015 if s > 0 else 0.015), AXF, WZ)))
        C_.add(coil((s * 0.55, AXF - 0.05, WZ - 0.05), (s * 0.5, AXF - 0.05, 0.78), 0.055, 0.011, 6))
        C_.add(cyl(0.025, 0.42, 8, 'z', c=(s * 0.525, AXF - 0.05, 0.56), mat='gunmetal'))
        C_.add(tube([(s * 0.12, AXF, WZ), (kx, AXF, WZ)], 0.025, 8, 'gunmetal'))
        C_.add(lathe([(0, -0.04), (0.04, -0.04), (0.045, 0.0), (0.04, 0.04), (0, 0.04)], 10, 'x', mat='skirt', c=(s * 0.2, AXF, WZ)))
        C_.add(tube([(s * 0.3, AXF + 0.2, 0.43), (kx, AXF + 0.13, WZ - 0.02)], 0.012, 6, 'bare'))     # tie rod
        C_.add(box(0.06, 0.06, 0.3, c=(s * 0.44, AXF - 0.05, 0.63), mat='gunmetal'))                     # shock tower bracket
    C_.add(lathe([(0, -0.12), (0.11, -0.1), (0.13, 0.0), (0.11, 0.1), (0, 0.12)], 14, 'x', mat='gunmetal', c=(0.03, AXF, WZ)))
    C_.add(cyl(0.03, 0.6, 8, 'x', c=(0, AXF + 0.2, 0.43), mat='gunmetal'))
    C_.add(tube([(-0.45, AXF + 0.38, 0.44), (0.45, AXF + 0.38, 0.44)], 0.014, 6, 'bare'))
    C_.add(box(1.0, 0.75, 0.012, c=(0, AXF + 0.15, 0.335), mat='gunmetal'))
    for s in (1, -1):
        C_.add(box(0.05, 0.75, 0.06, c=(s * 0.44, AXF + 0.15, 0.37), mat='gunmetal'))
    # engine + gearbox + transfer case + propshaft
    C_.add(box(0.5, 0.8, 0.45, c=(0, 1.75, 0.72), mat='gunmetal', bev=0.04, segs=1))
    C_.add(box(0.3, 0.5, 0.18, c=(0, 1.75, 0.45), mat='gunmetal', bev=0.02, segs=1))           # sump
    C_.add(lathe([(0.0, 0.0), (0.2, 0.0), (0.16, 0.5), (0.13, 0.75), (0, 0.75)], 14, 'y', mat='gunmetal', c=(0, 1.35, 0.6)).rot('Y', 0))
    C_.add(box(0.28, 0.3, 0.25, c=(0.0, 0.42, 0.5), mat='gunmetal', bev=0.02, segs=1))
    C_.add(tube([(0.0, 0.28, 0.47), (0.03, AXR + 0.14, WZ + 0.03)], 0.035, 8, 'gunmetal'))
    C_.add(tube([(0.0, 0.57, 0.47), (0.03, AXF - 0.11, WZ)], 0.03, 8, 'gunmetal'))
    # rear live axle: banjo housing, axle tubes, drums' backing plates, leaf springs with hangers + shackles, U-bolts, shocks
    C_.add(cyl(0.045, TRACK - 0.22, 12, 'x', c=(0, AXR, WZ), mat='gunmetal'))
    C_.add(lathe([(0, -0.13), (0.12, -0.11), (0.155, 0.0), (0.13, 0.1), (0.07, 0.15), (0, 0.15)], 16, 'y', c=(0.03, AXR, WZ), mat='gunmetal'))
    for s in (1, -1):
        C_.add(lathe([(0, 0), (0.15, 0), (0.15, 0.03), (0, 0.03)], 16, 'x', mat='gunmetal', c=(s * (TRACK / 2 - 0.12) - (0.03 if s > 0 else 0), AXR, WZ)))
        x = s * 0.47
        leaf = []
        for k in range(3):
            ln = 1.3 - k * 0.32
            pts = [(x, AXR + ln / 2 * math.cos(a), WZ - 0.06 - k * 0.012 + 0.12 * (1 - math.sin(a)) * (1 if k == 0 else 0.6)) for a in np.linspace(0.15, math.pi - 0.15, 10)]
            for i in range(len(pts) - 1):
                C_.add(beam(pts[i], pts[i + 1], 0.06, 0.011, mat='gunmetal'))
        C_.add(box(0.07, 0.07, 0.12, c=(x, AXR + 0.66, 0.49), mat='gunmetal'))                         # front hanger
        C_.add(beam((x, AXR - 0.63, 0.47), (x, AXR - 0.7, 0.53), 0.07, 0.03, mat='gunmetal'))          # shackle
        for dy in (-0.05, 0.05):
            C_.add(tube([(x - 0.04, AXR + dy, WZ - 0.12), (x - 0.04, AXR + dy, WZ + 0.06), (x + 0.04, AXR + dy, WZ + 0.06), (x + 0.04, AXR + dy, WZ - 0.12)], 0.007, 5, 'bare'))
        C_.add(box(0.1, 0.16, 0.025, c=(x, AXR, WZ - 0.11), mat='gunmetal'))
        C_.add(tube([(s * 0.56, AXR - 0.12, WZ - 0.04), (s * 0.5, AXR - 0.25, 0.53)], 0.022, 8, 'gunmetal'))
        C_.add(box(0.06, 0.06, 0.05, c=(s * 0.5, AXR - 0.25, 0.545), mat='gunmetal'))
    # fuel tank, exhaust with muffler, rear step bumper + hitch + plate
    C_.add(box(0.36, 0.7, 0.24, c=(-0.21, -0.68, 0.42), mat='gunmetal', bev=0.02, segs=1))
    C_.add(tube([(0.2, 1.3, 0.42), (0.22, 0.6, 0.36), (0.25, -0.2, 0.33)], 0.03, 8, 'bare'))
    C_.add(cyl(0.09, 0.55, 14, 'y', c=(0.25, -0.5, 0.36), mat='bare'))
    C_.add(tube([(0.25, -0.78, 0.36), (0.3, -1.0, 0.38), (0.62, -1.1, 0.38), (0.62, -1.95, 0.42), (0.66, -2.08, 0.4)], 0.028, 8, 'bare'))
    for y in (-0.3, -1.5):
        C_.add(box(0.03, 0.03, 0.06, c=(0.62 if y < -1 else 0.25, y, 0.43 if y < -1 else 0.42), mat='skirt'))
    C_.add(box(2 * BW - 0.08, 0.15, 0.16, c=(0, REAR - 0.075, SILL + 0.03), mat='bare', bev=0.03, segs=2))
    C_.add(box(1.0, 0.1, 0.015, c=(0, REAR - 0.1, SILL + 0.112), mat='skirt'))
    for s in (1, -1):
        C_.add(box(0.06, 0.25, 0.06, c=(s * 0.44, REAR + 0.1, SILL + 0.03), mat='gunmetal'))
    C_.add(box(0.07, 0.25, 0.07, c=(0, REAR - 0.17, SILL - 0.06), mat='gunmetal', bev=0.01, segs=1))
    C_.add(box(0.05, 0.09, 0.025, c=(0, REAR - 0.31, SILL - 0.04), mat='bare'))
    C_.add(lathe([(0, 0), (0.025, 0), (0.025, 0.04), (0.03, 0.05), (0.025, 0.09), (0, 0.095)], 12, 'z', c=(0, REAR - 0.31, SILL - 0.025), mat='bare'))
    C_.add(box(0.4, 0.015, 0.11, c=(0, REAR - 0.005, 0.795), mat='decal'))                       # plate holder (blank)
    C_.add(box(0.06, 0.03, 0.02, c=(0, REAR - 0.01, 0.86), mat='light'))
    return C_


# ================================================================================================ wheel
def wheel():
    """265/65 R17 all-terrain tyre on a 6-spoke rim with a brake disc behind it; outward = +X, hub at the origin."""
    segs = 40
    prof = [(0.222, -0.112), (0.27, -0.128), (0.33, -0.133), (0.365, -0.127), (0.381, -0.11), (0.386, -0.07),
            (0.388, 0.0), (0.386, 0.07), (0.381, 0.11), (0.365, 0.127), (0.33, 0.133), (0.27, 0.128), (0.222, 0.112)]
    t = lathe([(r, h, 'tyre') for r, h in prof], segs, 'x', mat='tyre', cap=False)
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
    for s in (-1, 1):
        t.add(lathe([(0.30, s * 0.131, 'tyre'), (0.302, s * 0.137, 'tyre'), (0.318, s * 0.137, 'tyre'), (0.32, s * 0.131, 'tyre')], segs, 'x', mat='tyre', cap=False))
    rim = lathe([(0.224, 0.112, 'rim'), (0.214, 0.104, 'rim'), (0.21, 0.08, 'rim'), (0.21, 0.03, 'rim'), (0.19, 0.025, 'rim'),
                 (0.16, 0.05, 'rim'), (0.10, 0.07, 'rim'), (0.06, 0.08, 'rim'), (0.0, 0.085, 'rim')], 36, 'x', mat='rim', cap=False)
    rim.add(lathe([(0.224, -0.112, 'rim'), (0.214, -0.104, 'rim'), (0.21, -0.08, 'rim'), (0.21, -0.03, 'rim'), (0.0, -0.03, 'rim')], 36, 'x', mat='rim', cap=False))
    for i in range(6):
        a = math.tau * i / 6 + 0.26
        h = cyl(0.04, 0.01, 12, 'x', mat='decal').scale(1, 1.0, 1.45).rot('X', math.degrees(a) - 90)
        rim.add(h.move(0.062, 0.15 * math.cos(a), 0.15 * math.sin(a)))
    for i in range(6):
        a = math.tau * i / 6
        rim.add(bolt(0.012, 0.018, 6, 'bare').rot('Y', 90), Matrix.Translation((0.083, 0.07 * math.cos(a), 0.07 * math.sin(a))))
    rim.add(lathe([(0, 0.0), (0.035, 0.0), (0.035, 0.02), (0.022, 0.03), (0, 0.032)], 12, 'x', mat='bare', c=(0.085, 0, 0)))
    rim.add(cyl(0.006, 0.03, 6, 'x', c=(0.09, 0.0, 0.195), mat='skirt'))       # valve stem
    rim.add(lathe([(0.03, 0), (0.165, 0), (0.165, 0.028), (0.03, 0.028)], 28, 'x', mat='bare', c=(-0.055, 0, 0)))   # brake disc / drum face
    t.add(rim)
    return t


# ================================================================================================ casualty-evacuation bed kit
LIT_X = (-0.50, 0.0, 0.50)       # litter centres (stretcher_1..3 slots)
LIT_Y = (-1.16, -2.48)           # litter length (grips included) inside the bulkhead plate and the closed tailgate
LIT_Z = BED_FLOOR + 0.035        # canvas top = the casualty's floor (wounded_on_bed root plane)
HOOP_Y = (-1.07, -1.80, -2.52)   # canopy hoops (front = roll bar)
HOOP_X = (BED_IN + BW) / 2 - 0.01
HOOP_Z = 1.99                    # top of the hoops (20 cm over the cab roof)
TARP_Y = (-1.07, -1.80)          # olive tarp over the front half (sun / rain / IR), the rear half open for loading


def sag_sheet(x0, x1, y0, y1, z, sag, nx=10, ny=8, mat='wood', drop=0.0, thick=0.004):
    """canvas sheet over x0..x1 / y0..y1 at height z, sagging between its edges, side flaps hanging `drop` at x0 / x1"""
    bm = bmesh.new(); grid = []
    xs = list(np.linspace(x0, x1, nx + 1))
    for j in range(ny + 1):
        y = y0 + (y1 - y0) * j / ny; row = []
        for i, x in enumerate(xs):
            u = (x - x0) / (x1 - x0); v = j / ny
            row.append(bm.verts.new((x, y, z - sag * math.sin(math.pi * u) * (0.35 + 0.65 * math.sin(math.pi * v)))))
        if drop > 0:   # side flaps: two more rows down the sides
            row = [bm.verts.new((x0 - 0.01, y, z - drop))] + row + [bm.verts.new((x1 + 0.01, y, z - drop))]
        grid.append(row)
    for j in range(ny):
        for i in range(len(grid[0]) - 1):
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    b = B(bm, mat)
    b.solidify(thick)
    return b


def bed_kit():
    """Field conversion for casualty evacuation (Ukrainian volunteer / brigade casevac pickups 2023-25, see
    previews/vehicles_v6/REFERENCES.md): welded roll bar + two canopy hoops on the bed rails, olive tarp over the front
    half with blanket rolls, jerrycans and a white red-cross air panel strapped on top, three folding litters lashed to
    the bed floor, steel plates on the bed walls, oxygen bottle and trauma bags on the roll bar, IV bag on the middle
    hoop, red-cross flag on the rear hoop, LED light bar."""
    K = B()
    # ---- hoops: bent tube from rail cap to rail cap, clamp plates on the rail caps
    for k, y in enumerate(HOOP_Y):
        r = 0.026 if k == 0 else 0.02
        K.add(rail([(-HOOP_X, y, BED_TOP + 0.02), (-HOOP_X, y, HOOP_Z - 0.03), (-HOOP_X + 0.06, y, HOOP_Z), (HOOP_X - 0.06, y, HOOP_Z),
                    (HOOP_X, y, HOOP_Z - 0.03), (HOOP_X, y, BED_TOP + 0.02)], r=r, rad=0.09, segs=8, mat='gunmetal', foot=False))
        for sx in (1, -1):
            K.add(box(0.11, 0.1, 0.012, c=(sx * HOOP_X, y, BED_TOP + 0.024), mat='gunmetal'))
            K.add(box(0.012, 0.1, 0.07, c=(sx * (BW - 0.004), y, BED_TOP - 0.02), mat='gunmetal'))   # clamp jaw over the outer wall
    # roll-bar diagonal brace + top rails joining the hoops
    K.add(tube([(-HOOP_X + 0.05, HOOP_Y[0], BED_TOP + 0.1), (HOOP_X - 0.1, HOOP_Y[0], HOOP_Z - 0.04)], 0.018, 8, 'gunmetal'))
    for sx in (1, -1):
        K.add(tube([(sx * (HOOP_X - 0.06), HOOP_Y[0], HOOP_Z), (sx * (HOOP_X - 0.06), HOOP_Y[2], HOOP_Z)], 0.017, 8, 'gunmetal'))
    # ---- tarp over the front half (sags between the hoops, side flaps), rolled-up rear tarp on the middle hoop
    K.add(sag_sheet(-HOOP_X - 0.02, HOOP_X + 0.02, TARP_Y[0] + 0.03, TARP_Y[1] - 0.03, HOOP_Z + 0.022, 0.045, drop=0.3))
    K.add(cyl(0.065, 2 * HOOP_X, 12, 'x', c=(0, HOOP_Y[1] - 0.08, HOOP_Z + 0.07), mat='wood'))
    for sx in (-0.55, 0.0, 0.55):
        K.add(cyl(0.072, 0.03, 12, 'x', c=(sx, HOOP_Y[1] - 0.08, HOOP_Z + 0.07), mat='skirt'))   # tie straps
    # ---- on the tarp: blanket rolls, two jerrycans, the white air-recognition panel (red cross from decals())
    zt = HOOP_Z + 0.03
    K.add(cyl(0.085, 0.62, 12, 'y', c=(-0.66, -1.43, zt + 0.07), mat='cast'))                       # grey wool blanket roll
    for yy in (-1.25, -1.61):
        K.add(cyl(0.09, 0.025, 12, 'y', c=(-0.66, yy, zt + 0.07), mat='skirt'))
    K.add(box(0.2, 0.26, 0.05, c=(-0.66, -1.43, zt + 0.175), mat='cage', bev=0.01, segs=1))          # folded rescue blanket (gold / orange foil)
    for k, x in enumerate((0.15, 0.53)):
        can = box(0.165, 0.47, 0.35, c=(0, 0, 0), mat='wood', bev=0.02, segs=2)
        for sx in (1, -1):
            can.add(beam((sx * 0.083, -0.17, -0.12), (sx * 0.083, 0.17, 0.12), 0.008, 0.03, mat='wood', up=(sx, 0, 0)))
            can.add(beam((sx * 0.083, -0.17, 0.12), (sx * 0.083, 0.17, -0.12), 0.008, 0.03, mat='wood', up=(sx, 0, 0)))
        for yy in (-0.12, 0.0, 0.12):
            can.add(box(0.03, 0.06, 0.04, c=(0, yy, 0.19), mat='wood', bev=0.008, segs=1))
        can.rot('Y', 90)
        K.add(can.move(x, -1.43, zt + 0.083))
    K.add(box(0.76, 0.012, 0.012, c=(0.34, -1.3, zt + 0.172), mat='skirt'))
    K.add(box(0.76, 0.012, 0.012, c=(0.34, -1.56, zt + 0.172), mat='skirt'))
    K.add(box(0.46, 0.46, 0.006, c=(-0.3, -1.45, zt + 0.003), mat='rolled'))                     # air panel (white, decal cross)
    # ---- litters: aluminium poles, olive canvas, stirrup feet, lashing straps to the floor rings
    for x in LIT_X:
        for sx in (1, -1):
            K.add(tube([(x + sx * 0.225, LIT_Y[0], LIT_Z), (x + sx * 0.225, LIT_Y[1], LIT_Z)], 0.016, 8, 'bare'))
            for y in (LIT_Y[0] + 0.25, LIT_Y[1] - 0.25):
                K.add(box(0.03, 0.03, LIT_Z - BED_FLOOR - 0.01, c=(x + sx * 0.225, y, (LIT_Z + BED_FLOOR) / 2 - 0.006), mat='bare'))
                K.add(beam((x + sx * 0.225, y + 0.04, LIT_Z + 0.012), (x + sx * 0.255, y + 0.07, BED_FLOOR + 0.004), 0.03, 0.004, mat='skirt', up=(0, 0, 1)))
            for y in LIT_Y:
                K.add(cyl(0.02, 0.07, 8, 'y', c=(x + sx * 0.225, y - (0.035 if y == LIT_Y[0] else -0.035) * -1, LIT_Z), mat='skirt'))   # grips
        K.add(box(0.43, LIT_Y[0] - LIT_Y[1] - 0.12, 0.005, c=(x, sum(LIT_Y) / 2, LIT_Z - 0.006), mat='wood'))
        for y in (LIT_Y[0] + 0.06, LIT_Y[1] - 0.06):                                              # spreader bars
            K.add(tube([(x - 0.225, y, LIT_Z - 0.012), (x + 0.225, y, LIT_Z - 0.012)], 0.009, 6, 'bare'))
    # ---- steel plates (field armour) on the inner bed walls, bolted
    for sx in (1, -1):
        K.add(box(0.008, BED_Y[0] - BED_Y[1] - 0.12, BED_TOP - BED_FLOOR - 0.12, c=(sx * (BED_IN - 0.005), sum(BED_Y) / 2, (BED_TOP + BED_FLOOR) / 2 + 0.03), mat='gunmetal'))
        for y in np.linspace(BED_Y[0] - 0.15, BED_Y[1] + 0.15, 4):
            for z in (BED_FLOOR + 0.14, BED_TOP - 0.06):
                K.add(cyl(0.012, 0.012, 6, 'x', c=(sx * (BED_IN - 0.012), y, z), mat='bare'))
    K.add(box(2 * BED_IN - 0.04, 0.008, BED_TOP - BED_FLOOR - 0.12, c=(0, BED_Y[0] - 0.072, (BED_TOP + BED_FLOOR) / 2 + 0.03), mat='gunmetal'))
    # ---- oxygen bottle (white, black valve + regulator) strapped upright to the right roll-bar post, inside the bed
    ox, oy = HOOP_X - 0.04, HOOP_Y[0] - 0.1
    K.add(cyl(0.065, 0.52, 14, 'z', c=(ox - 0.02, oy, BED_TOP + 0.02 + 0.26), mat='rolled'))
    K.add(cyl(0.05, 0.06, 12, 'z', c=(ox - 0.02, oy, BED_TOP + 0.02 + 0.55), mat='rolled', r2=0.03))
    K.add(box(0.05, 0.05, 0.08, c=(ox - 0.02, oy, BED_TOP + 0.66), mat='skirt'))
    K.add(cyl(0.022, 0.02, 10, 'y', c=(ox - 0.02, oy - 0.03, BED_TOP + 0.67), mat='bare'))
    for z in (BED_TOP + 0.15, BED_TOP + 0.42):
        K.add(cyl(0.069, 0.025, 14, 'z', c=(ox - 0.02, oy, z), mat='skirt'))
    K.add(box(0.035, 0.07, 0.03, c=(ox + 0.02, oy + 0.06, BED_TOP + 0.42), mat='skirt'))
    K.add(box(0.012, 0.012, 0.014, c=(ox - 0.02, oy, BED_TOP + 0.022), mat='skirt'))
    # bottle foot cup on the rail cap
    K.add(cyl(0.072, 0.03, 14, 'z', c=(ox - 0.02, oy, BED_TOP + 0.035), mat='gunmetal'))
    # ---- trauma bags: red bag on the left roll-bar post, olive bag on the middle hoop (straps over the tube)
    K.add(box(0.13, 0.26, 0.32, c=(-HOOP_X + 0.075, HOOP_Y[0] - 0.15, BED_TOP + 0.4), mat='era', bev=0.03, segs=2))
    K.add(box(0.14, 0.03, 0.03, c=(-HOOP_X + 0.07, HOOP_Y[0] - 0.15, BED_TOP + 0.58), mat='skirt'))
    K.add(box(0.012, 0.18, 0.16, c=(-HOOP_X + 0.145, HOOP_Y[0] - 0.15, BED_TOP + 0.34), mat='rolled'))   # white patch (decal cross)
    for z in (BED_TOP + 0.3, BED_TOP + 0.5):
        K.add(box(0.15, 0.025, 0.012, c=(-HOOP_X + 0.03, HOOP_Y[0] - 0.03, z), mat='skirt'))
    K.add(box(0.11, 0.3, 0.24, c=(-HOOP_X + 0.07, HOOP_Y[1] + 0.2, BED_TOP + 0.3), mat='wood', bev=0.025, segs=2))
    K.add(box(0.06, 0.03, 0.22, c=(-HOOP_X + 0.035, HOOP_Y[1] + 0.07, BED_TOP + 0.22), mat='skirt'))
    # ---- IV bag on a hook under the middle hoop, line down to the litter
    K.add(rail([(0.18, HOOP_Y[1], HOOP_Z - 0.02), (0.18, HOOP_Y[1], HOOP_Z - 0.09), (0.21, HOOP_Y[1], HOOP_Z - 0.12)], r=0.005, rad=0.02, mat='bare', foot=False))
    K.add(box(0.1, 0.025, 0.16, c=(0.2, HOOP_Y[1], HOOP_Z - 0.22), mat='rolled', bev=0.01, segs=2))
    K.add(tube([(0.2, HOOP_Y[1], HOOP_Z - 0.3), (0.21, HOOP_Y[1] - 0.05, HOOP_Z - 0.55), (0.24, HOOP_Y[1] - 0.15, BED_TOP + 0.05)], 0.004, 4, 'bare'))
    # ---- red-cross flag on a pole clamped to the rear hoop (right)
    fx, fy = HOOP_X - 0.01, HOOP_Y[2]
    K.add(tube([(fx + 0.03, fy, BED_TOP + 0.3), (fx + 0.03, fy, HOOP_Z + 0.62)], 0.012, 6, 'bare'))
    for z in (BED_TOP + 0.35, HOOP_Z - 0.05):
        K.add(box(0.06, 0.04, 0.03, c=(fx + 0.015, fy, z), mat='gunmetal'))
    bm = bmesh.new(); rows = []
    for j in range(3):
        z = HOOP_Z + 0.6 - j * 0.15; row = []
        for i in range(6):
            y = fy - i * 0.09
            row.append(bm.verts.new((fx + 0.03 + 0.035 * math.sin(i * 1.3 + j * 0.2), y, z - 0.012 * i)))
        rows.append(row)
    for j in range(2):
        for i in range(5):
            bm.faces.new((rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]))
    fl = B(bm, 'rolled'); fl.solidify(0.004); K.add(fl)
    # ---- LED light bar on the roll bar top (work light for night loading) + amber strobe
    K.add(box(0.7, 0.07, 0.07, c=(0, HOOP_Y[0] + 0.02, HOOP_Z + 0.06), mat='skirt', bev=0.012, segs=2))
    K.add(box(0.66, 0.01, 0.045, c=(0, HOOP_Y[0] + 0.057, HOOP_Z + 0.06), mat='light'))
    for sx in (1, -1):
        K.add(box(0.03, 0.05, 0.05, c=(sx * 0.3, HOOP_Y[0] + 0.01, HOOP_Z + 0.012), mat='gunmetal'))
    K.add(cyl(0.035, 0.07, 12, 'z', c=(-0.5, HOOP_Y[0], HOOP_Z + 0.055), mat='cage'))
    # ---- mud flaps (rubber) behind the rear wheels
    for sx in (1, -1):
        K.add(box(0.26, 0.012, 0.3, c=(sx * (TRACK / 2), AXR - RA - 0.05, SILL - 0.08), mat='skirt'))
    return K


# ================================================================================================ build
def build():
    t0 = time.time()
    L.reset()
    root = L.node_empty('root')
    hullE = L.node_empty('hull', root, (0, 0, 0))
    GL = B(mat='glass')
    H = lower_body()
    print('  lower body', H.tris(), '%.1fs' % (time.time() - t0))
    H.add(bed_body())
    print('  bed', H.tris(), '%.1fs' % (time.time() - t0))
    H.add(greenhouse(GL))
    H.add(front_end(GL))
    H.add(bull_bar())
    H.add(flares_and_trim())
    H.add(roof_rack())
    H.add(bed_kit())
    H.add(chassis())
    I = interior()
    print('  interior tris', I.tris())
    H.add(I)
    # spare wheel lying flat on the roof rack + ratchet straps
    Wp = wheel()
    zr = ROOF_Z + 0.16 + 0.016
    sp = L._bcopy(Wp); sp.rot('Y', 90); sp.move(-0.18, -0.15, zr + WW / 2 + 0.003)
    H.add(sp)
    for a in (0, 90):
        st = box(0.04, 2 * WR + 0.03, 0.01, c=(0, 0, 0), mat='canvas').move(0, 0, WW / 2 + 0.007).rot('Z', a)
        H.add(st.move(-0.18, -0.15, zr + WW / 2 + 0.003))
        for sgn in (1, -1):
            dv = V((0, sgn * (WR + 0.01), 0)); dv.rotate(Matrix.Rotation(math.radians(a), 3, 'Z'))
            H.add(beam(V((-0.18, -0.15, zr + WW + 0.012)) + dv, V((-0.18, -0.15, zr - 0.005)) + dv * 1.02, 0.04, 0.01, mat='canvas', up=dv))
    print('  hull tris', H.tris(), '%.1fs' % (time.time() - t0))
    hull_mesh = L.node_mesh('hull_geo', H, hullE, (0, 0, 0))
    glass_objs = [L.node_mesh('glass_geo', GL, hullE, (0, 0, 0))]
    # ---- doors (hinge empties, glass child mesh) + tailgate
    door_objs, doors_man = [], {}
    for s, tag in ((-1, 'L'), (1, 'R')):
        for w in ('F', 'R'):
            p, g, hp = door(s, w)
            nm = f'door_{w}{tag}'
            e = L.node_empty(nm, hullE, hp, 0.1)
            door_objs.append(L.node_mesh(nm + '_geo', p, e, hp))
            glass_objs.append(L.node_mesh(nm + '_glass', g, e, hp))
            doors_man[nm] = dict(axis='y', open=round((-1 if tag == 'L' else 1) * math.radians(68 if w == 'F' else 72), 3), parent='hull',
                                 side='left' if tag == 'L' else 'right', note='hinge on the front edge')
    tp, th = tailgate()
    tgE = L.node_empty('tailgate', hullE, th, 0.1)
    tg_obj = L.node_mesh('tailgate_geo', tp, tgE, th)
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
    for i, p in enumerate(SEATS):
        e = L.node_empty(f'ride_seat_{i + 1}', hullE, p, 0.12)
        e['seat_type'] = 'cab'
    for s, tag in ((-1, 'L'), (1, 'R')):
        for w in ('F', 'R'):
            y0, y1 = DOORS[w]
            L.node_empty(f'cab_door_{w}{tag}', hullE, (s * (BW + 0.15), (y0 + y1) / 2, 0.0), 0.1)
        L.node_empty(f'dismount_{tag}', hullE, (s * (BW + 0.75), 0.55, 0.0), 0.1)
    stretchers = []
    for i, x in enumerate(LIT_X):
        e = L.node_empty(f'stretcher_{i + 1}', hullE, (x, -1.80, LIT_Z), 0.12)
        stretchers.append(e)
    lp = L.node_empty('load_point', hullE, (0.0, REAR - 0.85, 0.0), 0.12)
    print('  geometry done %.1fs' % (time.time() - t0))
    lod0 = [hull_mesh] + door_objs + [tg_obj] + wheel_objs + glass_objs
    return dict(root=root, hull=hullE, lod0=lod0, atlas=[hull_mesh] + door_objs + [tg_obj, wheel_objs[0], wheel_objs[2]],
                doors=door_objs, tg=tg_obj, wheels=wheel_objs, doors_man=doors_man, stretchers=stretchers, load_point=lp,
                bake_hide=glass_objs, glass=glass_objs, nolod=glass_objs)


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
                        drop_slots=('tyre', 'glass', 'light', 'decal', 'wood'), drop_z=drop)
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
    # bed kit: air-recognition panel on the tarp, patch on the red trauma bag (white cross there: handled as a red
    # cross on white by the panel being 'rolled'), the flag on the rear hoop (both faces)
    m += T.decal_mask(P, N, E((-0.3, -1.45, HOOP_Z + 0.036)), E((0, 0, 1)), E((0, 1, 0)), T.cross_shape(0.19, 0.06))
    m += T.decal_mask(P, N, E((-HOOP_X + 0.151, HOOP_Y[0] - 0.15, BED_TOP + 0.34)), E((1, 0, 0)), (0, 0, 1), T.cross_shape(0.065, 0.022))
    for s in (1, -1):
        m += T.decal_mask(P, N, E((HOOP_X + 0.02 + s * 0.04, HOOP_Y[2] - 0.22, HOOP_Z + 0.43)), E((s, 0, 0)), (0, 0, 1), T.cross_shape(0.1, 0.032))
    return m


VB.SCHEMES['civ_white'] = dict(base=(206, 206, 198), base2=(194, 195, 188), camo=None, dust=(158, 150, 132), mud=(112, 100, 84),
                               wear=0.7, dust_amt=0.5, mud_amt=0.62, fade=(222, 221, 214), rough_base=0.36, decal_rgb=(168, 22, 20),
                               kind_colors={'skirt': ((30, 30, 29), 0.72, 0.0), 'canvas': ((26, 26, 25), 0.92, 0.0),
                                            'era': ((150, 18, 14), 0.3, 0.0), 'cage': ((205, 110, 22), 0.2, 0.0),
                                            'cast': ((62, 62, 59), 0.7, 0.0), 'wood': ((86, 88, 58), 0.95, 0.0)},
                               clean_kinds=('cast',))


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
              markings='red crosses on the front doors, bed sides, bonnet and tailgate, a white red-cross air panel on the bed tarp and a red-cross flag on the rear hoop; dirty white civilian paint, no badges',
              sources=['https://www.toyota.com.au/hilux/specs (Hilux double cab: 5325 x 1855 x 1815 mm, wheelbase 3085 mm, track 1540 mm, 265/65R17)',
                       'https://www.mitsubishi-motors.com/en/products/l200 (L200 double cab: 5305 x 1815 x 1780 mm, wheelbase 3000 mm, bed 1520 x 1470 mm)'],
              game=dict(hp_suggestion=160, speed_kmh=dict(road=110, off_road=45), game_speed=16.5, accel=5.0, turn_rate=1.35,
                        note='unarmoured: rifle fire disables it, any AT round destroys it'))


def main(argv):
    dev = '--dev' in argv
    d = build()
    orient_empties(d)
    VB.SOOT[:] = [((0.66, -2.1, 0.4), 0.18)]
    out = os.path.join(VB.REPO, 'previews', 'vehicles_v6', '_dev_' + NAME + '.glb') if dev else None
    info = VB.finalize(d, NAME, 'civ_white', decals, wreck, out=out, lod_ratio=0.3, glass_alpha=0.3)
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
