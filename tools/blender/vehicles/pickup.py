"""Double-cab pickup (generic Toyota Hilux AN120/130 / Mitsubishi L200 6G / Nissan Navara D23 class, no badges) converted for
casualty evacuation (src/game/medevac.js), as used by both sides in 2023-25 (previews/vehicles_v7/REFERENCES.md): a flat
ranger-green brush repaint, white panels with red crosses (front doors, canopy sides, bonnet, canopy roof, tailgate), a
fibreglass hardtop canopy over the bed (side windows, small front window, rear lift door with a big glass that opens together with
the tailgate), black plastic flares / bumper / grille, black wheels with all-terrain tyres, a low roof rack with the spare wheel.
Inside the canopy three litters lie on the bed floor (stretcher_1..3 slots).  v4 (vehicles_v7): modern high-belt proportions,
z-slice lofted greenhouse + canopy shells with boolean-cut window apertures, door frames split from the same shell (true
shut lines), densely sampled body sections, swept fender flares; the bull bar, flag, light bar, hoops, tarp and bed clutter
of v3 are gone.

Reference data (Hilux AN120 double cab 2016-24 / L200 Triton 2015-24, public spec sheets):
  length 5.33 m, width 1.855 m, height 1.815 m, wheelbase 3.085 m, track 1.54 m, 265/65 R17 tyres (dia 0.776 m),
  ground clearance 0.29 m, bed 1.52 x 1.51 m (1.10 m between the arches), bed floor ~0.86 m, bed walls 0.48 m,
  belt line ~1.25 m (window sill), kerb mass ~2.1 t.
Authoring frame: X right, Y forward, Z up (see vlib); finalize_frame flips it to the glTF / three.js frame.

Animatable nodes (glTF names):
  door_FL / door_FR / door_RL / door_RR  - hinge empties on the front edge of each door, open = rotation.y (see manifest doors)
  tailgate                              - hinge empty on the bottom edge, open = rotation.x
  canopy_door                           - canopy rear lift door, hinge empty on the roof's rear edge, open = rotation.x
  steer_L1 / steer_R1                   - front wheel steering empties (rotation.y), parents of wheel_L1 / wheel_R1
  wheel_L1 / wheel_R1 / wheel_L2 / wheel_R2 - spin empties (rotation.x = distance / wheel_radius_m)
Glass is a separate mesh per node (glass_geo under hull, door_XX_glass under each door, canopy_door_glass) with a blended
(see-through) material.  Faction identification meshes (own materials, not in the atlas): id_tape (tape bands on the canopy
roof and tailgate, tinted to the faction's tape colour at runtime) and id_ru (white V marks, shown only on Russian trucks).
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

# --atgm: the anti-tank 'technical' (assets/vehicles/pickup_atgm.glb): the same truck in its factory white, no hardtop canopy,
# no roof rack, no casevac markings; a plywood firing deck in the bed with an `atgm_mount` empty (the game stands the team's
# Kornet / Stugna-P launcher on its tripod there: tube 1.26 m over the deck = 2.14 m over the ground, 0.35 m clear of the cab
# roof), `tlc_1` / `tlc_2` empties for spare missile containers on the deck along the bed walls (the spare wheel stays under the bed: nothing else on the deck).
ATGM = '--atgm' in sys.argv
NAME = 'pickup_atgm' if ATGM else 'pickup'
MOUNT_Y = -1.70                 # launcher origin in the bed (Stugna tripod reaches 0.68 m forward, its control unit 0.82 m back)
AXF, AXR = 1.64, -1.44          # axle stations (wheelbase 3.08)
TRACK = 1.54
WR, WW = 0.388, 0.265           # 265/65 R17
WZ = 0.388                      # hub height (sits on the tyre)
RA = 0.47                       # wheel-arch radius
BW = 0.895                      # half body width
SILL = 0.47
BELT = 1.25                     # window sill / bonnet rear edge (modern high belt line)
SH = 0.06                       # body shoulder radius
FRONT, REAR = 2.55, -2.60       # body front face / bed rear face
CAB_F, CAB_R = 1.17, -0.98      # windscreen base / cab rear wall (belt line)
ROOF_Z = 1.79
ROOF_F, ROOF_R = 0.45, -0.95
GH_X0, GH_X1 = 0.822, 0.69      # greenhouse half width at the belt (inboard of the shoulder) / at the roof
GH_RF, GH_RR = 0.10, 0.05       # greenhouse plan corner radii (front: the windscreen wraps round)
ZT_DOOR = ROOF_Z - 0.06         # top edge of the door frames (roof side rail above)
ZB_WIN, ZT_WIN = BELT + 0.025, ROOF_Z - 0.11
BED_Y = (-1.01, REAR)
BED_FLOOR, BED_TOP = 0.88, 1.33
BED_IN = 0.77                   # inner half width of the bed
TG_Z = 0.90                     # tailgate hinge height
WELL_IN = 0.59                  # half width of the under-bed structure between the rear wheels (tyre inner face 0.6375)
DOORS = {'F': (1.11, 0.05), 'R': (-0.01, -0.86)}     # door y extents (front edge = hinge, rear edge)
GAP = 0.004                     # shut-line half gap
FLOOR_Z = 0.53                  # cab floor (top of the mats)
SEATS = [(-0.40, 0.38, 0.84), (0.40, 0.38, 0.84), (0.40, -0.52, 0.86)]       # LHD: driver front left (H points)
# hardtop canopy (fibreglass shell on the bed rails)
CAN_Z0 = BED_TOP + 0.02
CAN_TOP = ROOF_Z + 0.012
CAN_F0, CAN_F1 = -1.025, -0.995 # front face y at the bottom / top (parallel to the cab rear)
CAN_R0, CAN_R1 = REAR + 0.012, REAR + 0.065   # rear face y at the bottom / top (lift door raked forward)
CAN_X0, CAN_X1 = 0.812, 0.735   # half width at the bottom (flush with the bed wall top) / at the roof
CAN_RF, CAN_RR = 0.06, 0.05


def gh_x(z):
    """greenhouse side x at height z (sloping inward to the roof)"""
    return GH_X0 - (z - BELT) / (ROOF_Z - BELT) * (GH_X0 - GH_X1)


def a_pillar_y(z):
    return CAB_F - (z - BELT) / (ROOF_Z - BELT) * (CAB_F - ROOF_F)


def c_pillar_y(z):
    return CAB_R + (z - BELT) / (ROOF_Z - BELT) * (ROOF_R - CAB_R)


def can_x(z):
    return CAN_X0 - (z - CAN_Z0) / (CAN_TOP - CAN_Z0) * (CAN_X0 - CAN_X1)


def can_fy(z):
    return CAN_F0 + (z - CAN_Z0) / (CAN_TOP - CAN_Z0) * (CAN_F1 - CAN_F0)


def can_ry(z):
    return CAN_R0 + (z - CAN_Z0) / (CAN_TOP - CAN_Z0) * (CAN_R1 - CAN_R0)


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
NSIDE = 15           # side samples (door bottom .. shoulder start)
NSH = 6              # shoulder samples
I_SIDE0 = 4          # index of the first side point (door bottom edge)


def side_x(w, z):
    """body side x at height z: slight barrel bulge round 0.86 m, tumblehome above the 0.98 m character line"""
    x = w * (1 - 0.02 * ((z - 0.86) / 0.36) ** 2)
    if z > 0.98:
        x -= 0.03 * ((z - 0.98) / 0.25) ** 2
    return x


def front_dims(y):
    """front clip + cab lower body at station y: (zb, ztop, w, crown, shoulder radius)"""
    if y <= CAB_F:
        return SILL, BELT, BW, 0.0, SH
    t = (y - CAB_F) / (FRONT - CAB_F)
    ztop = BELT - 0.065 * t ** 1.5 - 0.08 * max(0.0, (y - 2.28) / (FRONT - 2.28)) ** 2
    w = BW - 0.13 * max(0.0, (y - 2.05) / (FRONT - 2.05)) ** 2.4          # plan-view rounding of the nose corners
    zb = SILL if y < 2.15 else SILL + 0.09 * ((y - 2.15) / (FRONT - 2.15)) ** 1.5
    return zb, ztop, w, 0.03 * min(1.0, t * 3), SH + 0.015 * min(1.0, t * 2)


def half_section(zb, ztop, w, crown, sh, ext=0.0):
    """half cross-section from the bottom centre round to the top centre (rocker tuck-under, side, shoulder, crowned top)"""
    pts = [(0.0, zb), (0.55 * w, zb), (w - 0.05, zb), (w - 0.012, zb + 0.016)]
    zs = ztop - sh
    for i in range(NSIDE):
        z = zb + 0.035 + (zs - zb - 0.035) * i / (NSIDE - 1)
        pts.append((side_x(w, z) + ext, z))
    xe = side_x(w, zs) + ext
    for a in (15, 30, 45, 60, 75, 90):
        r = math.radians(a)
        pts.append((xe - sh + sh * math.cos(r), zs + sh * math.sin(r)))
    x_in = xe - sh
    for f in (0.75, 0.5, 0.25, 0.0):
        pts.append((x_in * f, ztop + crown * (1 - f * f)))
    return pts


def front_surface_z(x, y):
    zb, ztop, w, crown, sh = front_dims(y)
    xi = side_x(w, ztop - sh) - sh
    f = min(1.0, abs(x) / max(xi, 1e-3))
    return ztop + crown * (1 - f * f)


FRONT_YS = [CAB_R, -0.92, -0.86, -0.6, -0.3, -0.01, 0.05, 0.35, 0.7, 1.11, CAB_F, 1.3, 1.45, 1.6, 1.75, 1.9, 2.02, 2.12,
            2.21, 2.29, 2.36, 2.42, 2.47, 2.51, FRONT - 0.018, FRONT]


def lower_body():
    """front clip + cab lower body: lofted shell, front arches cut, cab top and door apertures open, 2 cm skin"""
    st = []
    for y in FRONT_YS:
        zb, ztop, w, crown, sh = front_dims(y)
        if y >= FRONT - 0.02:          # nose: roll the front edges in
            k = 0.988 if y < FRONT else 0.962
            hs = [(x * k, z) for x, z in half_section(zb + (0.008 if y < FRONT else 0.03), ztop - (0.004 if y < FRONT else 0.018), w, crown, sh)]
        else:
            hs = half_section(zb, ztop, w, crown, sh)
        st.append((y, hs))
    b = loft(st)
    b = boolean(b, [arch_cutter(AXF, RA, 0.45, 1.2), arch_cutter(AXF, RA, -1.2, -0.45)])
    b.set_mat('rolled')
    xin = side_x(BW, BELT - SH) - SH          # inner edge of the shoulder (flat top inboard of it)
    dels = []
    for f in b.bm.faces:
        c = f.calc_center_median(); n = f.normal
        # cab top (interior opening under the greenhouse)
        if CAB_R + 1e-3 < c.y < CAB_F - 1e-3 and c.z > BELT - 0.004 and abs(c.x) < xin - 0.004:
            dels.append(f); continue
        for y0, y1 in DOORS.values():
            if y1 < c.y < y0 and abs(c.x) > xin - 0.004 and SILL + 0.035 < c.z < BELT + 0.01:
                dels.append(f); break
    bmesh.ops.delete(b.bm, geom=dels, context='FACES')
    b.solidify(0.02, -1)
    # arch liners: faces lying on the arch cylinder -> black plastic
    set_mat_where(b, 'skirt', lambda c, n: abs(math.hypot(c.y - AXF, c.z - WZ) - RA) < 0.012 and abs(c.x) > 0.3)
    b.bevel(0.004, 1, 40)
    return b


def door_skin(side, which):
    """outer door panel: the body loft strip over the door aperture (shrunk by the shut-line gap), 2.2 cm thick"""
    y0, y1 = DOORS[which]
    ys = np.linspace(y1 + GAP, y0 - GAP, 9)
    st = []
    for y in ys:
        hs = half_section(*front_dims(y))
        seg = hs[I_SIDE0:I_SIDE0 + NSIDE + NSH]
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


# ================================================================================================ shells (greenhouse, canopy)
def rrect(hw, yf, yr, rf, rr, nF=8, nC=8, nS=14):
    """plan ring: rounded rectangle |x| <= hw, yr <= y <= yf, corner radii rf (front) / rr (rear); fixed vertex count"""
    rf = max(0.004, min(rf, hw * 0.95)); rr = max(0.004, min(rr, hw * 0.95))
    P = []
    for i in range(nF):
        P.append((-(hw - rf) + 2 * (hw - rf) * i / nF, yf))
    for i in range(nC):
        a = math.pi / 2 - math.pi / 2 * i / nC
        P.append((hw - rf + rf * math.cos(a), yf - rf + rf * math.sin(a)))
    for i in range(nS):
        P.append((hw, (yf - rf) + ((yr + rr) - (yf - rf)) * i / nS))
    for i in range(nC):
        a = -math.pi / 2 * i / nC
        P.append((hw - rr + rr * math.cos(a), yr + rr + rr * math.sin(a)))
    for i in range(nF):
        P.append(((hw - rr) - 2 * (hw - rr) * i / nF, yr))
    for i in range(nC):
        a = -math.pi / 2 - math.pi / 2 * i / nC
        P.append((-(hw - rr) + rr * math.cos(a), yr + rr + rr * math.sin(a)))
    for i in range(nS):
        P.append((-hw, (yr + rr) + ((yf - rf) - (yr + rr)) * i / nS))
    for i in range(nC):
        a = math.pi - math.pi / 2 * i / nC
        P.append((-(hw - rf) + rf * math.cos(a), yf - rf + rf * math.sin(a)))
    return P


def zshell(rows, re, crown, thick, mat='rolled', inner='cast'):
    """shell lofted through horizontal plan rings rows=[(z, hw, yf, yr, rf, rr)] (bottom open), with a rounded roof edge of
    radius re above the last row and a crowned roof cap; solidified `thick` inward, inner faces -> `inner` material."""
    z, hw, yf, yr, rf, rr = rows[-1]
    rings = [(r[0], rrect(*r[1:])) for r in rows]
    for a in (18, 36, 54, 72, 90):
        d = re * (1 - math.cos(math.radians(a)))
        rings.append((z + re * math.sin(math.radians(a)), rrect(hw - d, yf - d, yr + d, rf - d, rr - d)))
    ztop = z + re
    last = rrect(hw - re, yf - re, yr + re, rf - re, rr - re)
    yc = (yf + yr) / 2
    for s in (0.8, 0.58, 0.34):
        rings.append((ztop + crown * (1 - s * s), [(x * s, yc + (y - yc) * s) for x, y in last]))
    bm = bmesh.new()
    vr = [[bm.verts.new((x, y, zz)) for x, y in ring] for zz, ring in rings]
    n = len(vr[0])
    for i in range(len(vr) - 1):
        for k in range(n):
            j = (k + 1) % n
            bm.faces.new((vr[i][k], vr[i][j], vr[i + 1][j], vr[i + 1][k]))
    bm.faces.new(vr[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    fx = max(bm.faces, key=lambda f: f.calc_center_median().x)
    if fx.normal.x < 0:
        for f in bm.faces:
            f.normal_flip()
    b = B(bm, mat).solidify(thick, -1)
    cen = V((0, yc, (rows[0][0] + ztop) / 2))
    set_mat_where(b, inner, lambda c, nn: nn.dot(V((c.x, c.y - yc, (c.z - cen.z) * 0.3))) < 0)
    return b


def rpoly(pts, r, steps=4):
    """closed 2D polygon with rounded corners (r: one radius or one per corner)"""
    n = len(pts); out = []
    P = [V((p[0], p[1], 0)) for p in pts]
    for i in range(n):
        a, b_, c = P[i - 1], P[i], P[(i + 1) % n]
        rr = r[i] if isinstance(r, (list, tuple)) else r
        d1, d2 = a - b_, c - b_
        rr = min(rr, d1.length * 0.45, d2.length * 0.45)
        p1 = b_ + d1.normalized() * rr; p2 = b_ + d2.normalized() * rr
        for s in range(steps + 1):
            t = s / steps
            q = p1 * (1 - t) ** 2 + b_ * 2 * t * (1 - t) + p2 * t * t
            out.append((q.x, q.y))
    return out


def plane_cutter(fn, g, back):
    """half-space box behind the plane y = fn(z) + g (towards y = back)"""
    pts = []
    for z in (CAN_Z0 - 0.2, CAN_TOP + 0.2):
        for x in (-1.3, 1.3):
            pts += [(x, fn(z) + g, z), (x, back, z)]
    return hull(pts, mat='rolled')


# ---- greenhouse openings (y, z) / (x, z) outlines; `g` grows them (glass panes overlap the aperture by g)
def win_front(g=0.0):
    wy = lambda z: a_pillar_y(z) - GH_RF - 0.035
    return rpoly([(0.095 - g, ZB_WIN - g), (wy(ZB_WIN) + g, ZB_WIN - g), (wy(ZT_WIN) + g, ZT_WIN + g), (0.095 - g, ZT_WIN + g)], [0.02, 0.02, 0.05, 0.035])


def win_rear(g=0.0):
    return rpoly([(-0.80 - g, ZB_WIN - g), (-0.055 + g, ZB_WIN - g), (-0.055 + g, ZT_WIN + g), (-0.79 - g, ZT_WIN + g)], [0.03, 0.02, 0.035, 0.06])


def win_screen(g=0.0):
    zb, zt = BELT + 0.035 - g, ROOF_Z - 0.10 + g
    hw = lambda z: gh_x(z) - 0.07 + g
    return rpoly([(-hw(zb), zb), (hw(zb), zb), (hw(zt), zt), (-hw(zt), zt)], [0.03, 0.03, 0.06, 0.06])


def win_back(g=0.0):
    zb, zt = BELT + 0.09 - g, ROOF_Z - 0.13 + g
    return rpoly([(-0.50 - g, zb), (0.50 + g, zb), (0.45 + g, zt), (-0.45 - g, zt)], 0.05)


def door_outline(which, g):
    """door aperture outline (y, z) in the greenhouse side; g > 0 grows it (body cutter), g < 0 shrinks it (door piece)"""
    y0, y1 = DOORS[which]
    zb = BELT - 0.1
    if which == 'F':
        fy = lambda z: a_pillar_y(z) - GH_RF - 0.006
        zk = BELT + 0.03
        return [(y1 - g, zb), (y0 + g, zb), (y0 + g, zk - 0.02), (fy(zk) + g, zk), (fy(ZT_DOOR + g) + g, ZT_DOOR + g), (y1 - g, ZT_DOOR + g)]
    return [(y1 - g, zb), (y0 + g, zb), (y0 + g, ZT_DOOR + g), (y1 - g, ZT_DOOR + g)]


def pane(poly2d, fn3d, t=0.006):
    return glass_pane([fn3d(u, v) for u, v in poly2d], t)


def greenhouse(glass):
    """Cab greenhouse: one shell (A/B/C pillars, roof side rails, crowned roof, windscreen header) lofted through plan rings,
    window apertures cut by exact booleans, the four door frames split off along true shut lines.  Returns (body part,
    {(side, which): (door frame piece, door glass)}).  Windscreen / rear glass -> `glass`."""
    rows = [(z, gh_x(z), a_pillar_y(z), c_pillar_y(z), GH_RF, GH_RR) for z in np.linspace(BELT - 0.03, ZT_DOOR, 9)]
    S = zshell(rows, 0.06, 0.03, 0.025)
    ys0, ys1 = a_pillar_y(BELT + 0.035), a_pillar_y(ROOF_Z - 0.10)
    yb = c_pillar_y((BELT + ROOF_Z) / 2)
    cut = [prism(win_screen(), ys0 - ys1 + 0.26, 'y', mat='skirt', c=(ys0 + ys1) / 2),
           prism(win_back(), 0.3, 'y', mat='skirt', c=yb)]
    for s in (1, -1):
        cut += [prism(win_front(), 0.32, 'x', mat='skirt', c=s * 0.78), prism(win_rear(), 0.32, 'x', mat='skirt', c=s * 0.78)]
    S = boolean(S, cut)
    doors = {}
    for s in (1, -1):
        for w in ('F', 'R'):
            piece = boolean(L._bcopy(S), [prism(door_outline(w, -GAP), 0.4, 'x', c=s * 0.78)], 'INTERSECT')
            ystrip = (lambda c: c.y < 0.095) if w == 'F' else (lambda c: c.y > -0.055)
            set_mat_where(piece, 'skirt', lambda c, n, ys=ystrip, s=s: ys(c) and n.x * s > 0.5 and c.z > ZB_WIN - 0.03)   # black B-pillar appliques
            sx = lambda z, s=s: s * (gh_x(z) - 0.012)
            gp = pane(win_front(0.012) if w == 'F' else win_rear(0.012), lambda y, z, sx=sx: (sx(z), y, z))
            doors[(s, w)] = (piece, gp)
    S = boolean(S, [prism(door_outline(w, GAP), 0.4, 'x', c=s * 0.78) for s in (1, -1) for w in ('F', 'R')])
    set_mat_where(S, 'skirt', lambda c, n: -0.02 < c.y < 0.06 and abs(c.x) > 0.6 and BELT < c.z < ZT_DOOR and n.x * c.x > 0)
    G = B()
    G.add(S)
    glass.add(pane(win_screen(0.012), lambda x, z: (x, a_pillar_y(z) - 0.02, z)))
    glass.add(pane(win_back(0.012), lambda x, z: (x, c_pillar_y(z) + 0.013, z)))
    # headliner (interior grey) under the roof, sun visors, rear-view mirror, dome light
    G.add(box(2 * GH_X1 - 0.08, ROOF_F - ROOF_R - 0.12, 0.02, c=(0, (ROOF_F + ROOF_R) / 2 - 0.02, ROOF_Z - 0.04), mat='cast', bev=0.008, segs=1))
    for s in (1, -1):
        G.add(box(0.36, 0.02, 0.15, c=(s * 0.34, ROOF_F - 0.06, ROOF_Z - 0.105), mat='cast', bev=0.008, segs=1).rot('X', 12, (0, ROOF_F - 0.06, ROOF_Z - 0.105)))
    G.add(box(0.05, 0.03, 0.11, c=(0, ROOF_F - 0.01, ROOF_Z - 0.04), mat='skirt'))
    G.add(box(0.24, 0.025, 0.07, c=(0, ROOF_F - 0.02, ROOF_Z - 0.115), mat='skirt', bev=0.012, segs=2))
    G.add(box(0.2, 0.005, 0.05, c=(0, ROOF_F - 0.034, ROOF_Z - 0.115), mat='light'))
    G.add(box(0.14, 0.08, 0.015, c=(0, -0.25, ROOF_Z - 0.055), mat='light', bev=0.006, segs=1))
    # A-pillar grab handles, B-pillar inner trims, rear wall trim
    for s in (1, -1):
        G.add(beam((s * (gh_x(BELT) - 0.05), 0.02, BELT - 0.02), (s * (gh_x(ROOF_Z - 0.09) - 0.05), 0.02, ROOF_Z - 0.09), 0.1, 0.04, mat='cast', up=(s, 0, 0), bev=0.01))
        G.add(box(0.05, 0.1, BELT - FLOOR_Z, c=(s * 0.80, 0.02, (BELT + FLOOR_Z) / 2), mat='cast', bev=0.01, segs=1))
    G.add(box(2 * GH_X0 - 0.12, 0.02, BELT - FLOOR_Z + 0.04, c=(0, CAB_R + 0.035, (BELT + FLOOR_Z) / 2 + 0.0), mat='cast', bev=0.006, segs=1))
    # cowl panel with vent slots, wipers parked along the bottom of the glass
    G.add(hull([(-GH_X0 + 0.04, CAB_F + 0.02, BELT - 0.01), (GH_X0 - 0.04, CAB_F + 0.02, BELT - 0.01), (-GH_X0 + 0.04, CAB_F + 0.2, BELT - 0.02),
                (GH_X0 - 0.04, CAB_F + 0.2, BELT - 0.02), (-GH_X0 + 0.06, CAB_F + 0.03, BELT + 0.02), (GH_X0 - 0.06, CAB_F + 0.03, BELT + 0.02),
                (-GH_X0 + 0.06, CAB_F + 0.19, BELT + 0.006), (GH_X0 - 0.06, CAB_F + 0.19, BELT + 0.006)], mat='skirt', bev=0.006, segs=1))
    for i in range(12):
        G.add(box(0.05, 0.08, 0.006, c=(-0.55 + i * 0.1, CAB_F + 0.11, BELT + 0.014), mat='decal').rot('X', -6, (0, CAB_F + 0.11, BELT + 0.014)))
    wa, wb = V((0, a_pillar_y(BELT + 0.03), BELT + 0.03)), V((0, a_pillar_y(ROOF_Z - 0.1), ROOF_Z - 0.1))
    up = (wb - wa).normalized(); nrm = V((0, up.z, -up.y))
    if nrm.y < 0:
        nrm = -nrm
    for xp in (-0.40, 0.20):
        piv = V((xp, CAB_F + 0.1, BELT + 0.02))
        G.add(cyl(0.018, 0.025, 10, 'z', c=piv, mat='skirt'))
        bl0 = wa.lerp(wb, 0.06) + V((xp + 0.02, 0, 0)) + nrm * 0.014
        bl1 = bl0 + V((0.52, 0, 0))
        mid = (bl0 + bl1) / 2 + nrm * 0.012
        G.add(beam(piv + V((0, 0, 0.015)), mid, 0.014, 0.01, mat='skirt', up=nrm))
        G.add(beam(bl0, bl1, 0.022, 0.014, mat='skirt', up=nrm))
    return G, doors


def canopy(glass):
    """Fibreglass hardtop over the bed (sits on the rail caps, flush with the bed walls): side windows, small front window,
    rear lift door (split off the shell along a plane parallel to the rear face) with a large glass, handle, third brake
    light.  Returns (shell part, lift-door part, lift-door glass, hinge point, BVH of the shell)."""
    zr0 = CAN_TOP - 0.045
    rows = [(z, can_x(z), can_fy(z), can_ry(z), CAN_RF, CAN_RR) for z in np.linspace(CAN_Z0, zr0, 7)]
    S = zshell(rows, 0.045, 0.018, 0.014)
    bvh = L.bvh_of(S)
    fy0, fy1 = can_fy(CAN_Z0), can_fy(zr0)
    ry_m = can_ry((CAN_Z0 + zr0) / 2)
    side_w = rpoly([(-1.98, CAN_Z0 + 0.075), (-1.13, CAN_Z0 + 0.075), (-1.13, zr0 - 0.035), (-1.98, zr0 - 0.035)], 0.045)
    front_w = rpoly([(-0.42, CAN_Z0 + 0.12), (0.42, CAN_Z0 + 0.12), (0.40, zr0 - 0.06), (-0.40, zr0 - 0.06)], 0.04)
    rear_w = rpoly([(-0.62, CAN_Z0 + 0.085), (0.62, CAN_Z0 + 0.085), (0.58, zr0 - 0.03), (-0.58, zr0 - 0.03)], 0.06)
    cut = [prism(front_w, 0.2, 'y', mat='skirt', c=(fy0 + fy1) / 2), prism(rear_w, 0.2, 'y', mat='skirt', c=ry_m)]
    for s in (1, -1):
        cut.append(prism(side_w, 0.3, 'x', mat='skirt', c=s * 0.75))
    S = boolean(S, cut)
    rf = lambda z: can_ry(z) + 0.035
    door = boolean(L._bcopy(S), [plane_cutter(rf, -GAP, REAR - 0.6)], 'INTERSECT')
    S = boolean(S, [plane_cutter(rf, GAP, REAR - 0.6)])
    for s in (1, -1):
        glass.add(pane(rpoly([(-1.98 - 0.012, CAN_Z0 + 0.063), (-1.13 + 0.012, CAN_Z0 + 0.063), (-1.13 + 0.012, zr0 - 0.023), (-1.98 - 0.012, zr0 - 0.023)], 0.05),
                       lambda y, z, s=s: (s * (can_x(z) - 0.007), y, z)))
    glass.add(pane(rpoly([(-0.432, CAN_Z0 + 0.108), (0.432, CAN_Z0 + 0.108), (0.412, zr0 - 0.048), (-0.412, zr0 - 0.048)], 0.045),
                   lambda x, z: (x, can_fy(z) - 0.007, z)))
    dg = pane(rpoly([(-0.632, CAN_Z0 + 0.073), (0.632, CAN_Z0 + 0.073), (0.592, zr0 - 0.018), (-0.592, zr0 - 0.018)], 0.065),
              lambda x, z: (x, can_ry(z) + 0.007, z))
    # lift door: handle bezel + lock at the bottom centre, third brake light at the top, rubber seal along the bottom
    zh = CAN_Z0 + 0.045
    door.add(box(0.2, 0.02, 0.045, c=(0, can_ry(zh) - 0.006, zh), mat='skirt', bev=0.008, segs=2))
    door.add(cyl(0.011, 0.012, 10, 'y', c=(0.13, can_ry(zh) - 0.008, zh), mat='bare'))
    door.add(box(0.36, 0.022, 0.028, c=(0, can_ry(zr0 + 0.01) - 0.004, zr0 + 0.008), mat='era', bev=0.008, segs=1))
    door.add(box(2 * can_x(CAN_Z0) - 0.14, 0.03, 0.012, c=(0, can_ry(CAN_Z0) + 0.02, CAN_Z0 + 0.004), mat='skirt'))
    hinge = (0, rf(CAN_TOP), CAN_TOP - 0.004)
    # clamps under the rail caps
    for s in (1, -1):
        for y in (-1.25, -1.85, -2.40):
            S.add(box(0.03, 0.06, 0.07, c=(s * (BED_IN + 0.02), y, BED_TOP - 0.03), mat='gunmetal', bev=0.006, segs=1))
    return S, door, dg, hinge, bvh


def ribbon(bvh, pts, d, w, lift=0.0025, mat='rolled'):
    """thin strip (tape / painted mark) conforming to a surface: rays from `pts` along `d` onto the BVH"""
    D = V(d).normalized()
    hits = []
    for p in pts:
        loc, nrm, _, _ = bvh.ray_cast(V(p), D, 3.0)
        if loc is not None:
            if nrm.dot(D) > 0:
                nrm = -nrm
            hits.append((loc + nrm * lift, nrm))
    bm = bmesh.new()
    Lv, Rv = [], []
    for i, (p, n) in enumerate(hits):
        t = hits[min(i + 1, len(hits) - 1)][0] - hits[max(i - 1, 0)][0]
        s = t.cross(n).normalized() * w / 2
        Lv.append(bm.verts.new(p + s)); Rv.append(bm.verts.new(p - s))
    for i in range(len(hits) - 1):
        f = bm.faces.new((Lv[i], Rv[i], Rv[i + 1], Lv[i + 1]))
        if f.normal.dot(hits[i][1]) < 0:
            f.normal_flip()
    return B(bm, mat)


# ================================================================================================ front end
def front_end(glass):
    """grille (big trapezoid, black), slim swept headlamps under the bonnet lip, wrap-round bumper with fog-lamp pockets and a
    black lower apron, skid plate, bonnet shut lines + washer jets"""
    F = B()
    fy = FRONT
    zg0, zg1 = 0.80, 1.06
    gp = rpoly([(-0.43, zg0), (0.43, zg0), (0.50, zg1), (-0.50, zg1)], 0.035)
    F.add(tube([(x, fy + 0.016, z) for x, z in gp], 0.026, 6, 'skirt', closed=True))
    F.add(box(0.96, 0.014, zg1 - zg0, c=(0, fy + 0.002, (zg0 + zg1) / 2), mat='decal'))
    for i in range(4):
        z = zg0 + 0.045 + i * (zg1 - zg0 - 0.09) / 3
        w_ = 0.84 + (z - zg0) * 0.55
        F.add(box(w_, 0.035, 0.032, c=(0, fy + 0.018, z), mat='skirt', bev=0.008, segs=2))
    F.add(box(0.03, 0.035, zg1 - zg0 - 0.04, c=(0, fy + 0.02, (zg0 + zg1) / 2), mat='skirt', bev=0.008, segs=1))
    # headlamps: slim housings laid on the rounded nose corner (plan curve of the body), from the grille to the fender
    def nose_pt(x, off):
        """point on the nose plan curve at |x| (y on the surface), pushed `off` along the plan normal"""
        y = FRONT if x <= 0.74 else 2.05 + (FRONT - 2.05) * ((BW - x) / 0.13) ** (1 / 2.4)
        y = min(y, FRONT)
        x2 = x + 0.004
        y2 = FRONT if x2 <= 0.74 else min(FRONT, 2.05 + (FRONT - 2.05) * ((BW - x2) / 0.13) ** (1 / 2.4))
        t = V((x2 - x, y2 - y, 0)).normalized(); n = V((-t.y, t.x, 0))
        if n.y < 0 and n.x < 0:
            n = -n
        if n.length < 0.5 or (n.x < 0 and n.y < 0):
            n = V((0, 1, 0))
        return V((x, y, 0)) + n * off
    for s in (1, -1):
        xs_ = (0.51, 0.62, 0.72, 0.78, 0.82, 0.845)
        hp, cov = [], []
        for i, x in enumerate(xs_):
            zt_, zb_ = 1.085 - 0.004 * i, 0.985 + 0.012 * i
            for off, lst, k in ((0.012, hp, 1.0), (-0.05, hp, 1.0), (0.02, cov, 1.0), (0.006, cov, 1.0)):
                p = nose_pt(x, off)
                lst += [(s * p.x, p.y, zt_ + (0.004 if lst is cov else 0)), (s * p.x, p.y, zb_ - (0.004 if lst is cov else 0))]
        F.add(hull(hp, mat='skirt'))
        glass.add(hull(cov, mat='glass'))
        for x, r_ in ((0.58, 0.036), (0.68, 0.032)):
            p = nose_pt(x, 0.0)
            F.add(lathe([(0, 0.0), (0.02, 0.004, 'bare'), (r_, 0.026, 'bare'), (r_ + 0.005, 0.03)], 18, 'y', mat='bare', c=(s * x, p.y - 0.018, 1.04), cap=False))
            F.add(cyl(0.015, 0.02, 12, 'y', c=(s * x, p.y - 0.004, 1.04), mat='light'))
        p0, p1 = nose_pt(0.52, 0.014), nose_pt(0.80, 0.014)
        F.add(beam((s * p0.x, p0.y, 1.0), (s * p1.x, p1.y, 1.012), 0.012, 0.012, mat='light'))          # DRL strip
        p2 = nose_pt(0.835, 0.013)
        F.add(box(0.02, 0.06, 0.03, c=(s * p2.x, p2.y, 1.06), mat='cage').rot('Z', -s * 50, (s * p2.x, p2.y, 1.06)))   # indicator
        F.add(box(0.008, 0.05, 0.02, c=(s * (side_x(BW, 0.98) + 0.002), 1.95, 0.98), mat='cage', bev=0.003, segs=1))    # side repeater
    # bumper: painted upper shell wrapping round the corners (convex hull of a curved point cloud), black lower apron
    bp, lp = [], []
    for s in (1, -1):
        for x, dy in ((0.0, 0.12), (0.35, 0.115), (0.6, 0.09), (0.76, 0.03), (0.86, -0.08), (0.89, -0.2)):
            bp += [(s * x, fy + dy, 0.60), (s * x, fy + dy - 0.012, 0.79), (s * x * 0.98, fy + dy - 0.17, 0.59), (s * x * 0.98, fy + dy - 0.17, 0.80)]
            lp += [(s * x * 0.97, fy + dy - 0.01, 0.44), (s * x * 0.97, fy + dy, 0.61), (s * x * 0.95, fy + dy - 0.2, 0.43), (s * x * 0.95, fy + dy - 0.2, 0.61)]
    F.add(hull(bp, mat='rolled', bev=0.03, segs=3, angle=20))
    F.add(hull(lp, mat='skirt', bev=0.02, segs=2, angle=20))
    F.add(box(0.62, 0.02, 0.07, c=(0, fy + 0.112, 0.52), mat='decal', bev=0.01, segs=1))           # lower intake
    F.add(box(0.42, 0.012, 0.1, c=(0, fy + 0.13, 0.69), mat='skirt', bev=0.004, segs=1))           # plate holder (blank)
    for s in (1, -1):
        F.add(box(0.15, 0.03, 0.09, c=(s * 0.66, fy + 0.085, 0.53), mat='decal', bev=0.015, segs=2).rot('Z', s * 22, (s * 0.66, fy + 0.085, 0.53)))
        F.add(cyl(0.034, 0.02, 16, 'y', c=(s * 0.66, fy + 0.095, 0.53), mat='light').rot('Z', s * 22, (s * 0.66, fy + 0.085, 0.53)))
        F.add(box(0.24, 0.04, 0.012, c=(s * 0.64, fy + 0.08, 0.603), mat='skirt', bev=0.004, segs=1))
    F.add(box(1.0, 0.5, 0.012, c=(0, fy - 0.26, 0.44), mat='gunmetal'))          # skid plate
    sz = lambda y: front_surface_z(0, y)
    for s in (1, -1):
        F.add(strip_on(front_surface_z, [(s * 0.76, y) for y in np.linspace(CAB_F + 0.21, FRONT - 0.04, 16)], 0.005))
        F.add(box(0.025, 0.03, 0.014, c=(s * 0.28, CAB_F + 0.3, sz(CAB_F + 0.3) + 0.004), mat='skirt'))
    F.add(strip_on(front_surface_z, [(x, CAB_F + 0.21) for x in np.linspace(-0.76, 0.76, 14)], 0.005))
    return F


def flares_and_trim():
    """swept fender flares round all four arches (black plastic, 4 cm proud), mud flaps, tube side steps"""
    Fl = B()
    sec = [(-0.01, -0.03), (-0.01, 0.022), (0.03, 0.04), (0.07, 0.03), (0.085, -0.012), (0.06, -0.03)]     # (radial, lateral)
    for s in (1, -1):
        for yc, xb in ((AXF, side_x(BW, 0.9)), (AXR, side_x(BW - 0.004, 0.9))):
            a0 = math.asin((SILL - 0.01 - WZ) / (RA + 0.04))
            bm = bmesh.new(); rings = []
            for a in np.linspace(math.pi - a0, a0, 34):
                rings.append([bm.verts.new((s * (xb + lat), yc + (RA + rad) * math.cos(a), WZ + (RA + rad) * math.sin(a))) for rad, lat in sec])
            m = len(sec)
            for i in range(len(rings) - 1):
                for k in range(m):
                    j = (k + 1) % m
                    bm.faces.new((rings[i][k], rings[i][j], rings[i + 1][j], rings[i + 1][k]))
            bm.faces.new(rings[0]); bm.faces.new(rings[-1][::-1])
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            Fl.add(B(bm, 'skirt'))
            # mud flap behind the wheel + bracket
            Fl.add(box(0.26, 0.012, 0.24, c=(s * (TRACK / 2 + 0.02), yc - RA - 0.06, SILL - 0.1), mat='skirt', bev=0.004, segs=1))
            Fl.add(box(0.05, 0.05, 0.05, c=(s * (TRACK / 2 + 0.02), yc - RA - 0.06, SILL + 0.0), mat='gunmetal'))
        # side step: oval tube on two outriggers between the arches
        Fl.add(rail([(s * 0.6, AXF - RA - 0.06, 0.38), (s * (BW + 0.03), AXF - RA - 0.1, 0.36), (s * (BW + 0.03), AXR + RA + 0.1, 0.36), (s * 0.6, AXR + RA + 0.06, 0.38)], r=0.03, rad=0.1, segs=10, mat='skirt', foot=False))
        for yy in (0.6, -0.5):
            Fl.add(box(BW - 0.45 + 0.04, 0.06, 0.05, c=(s * (0.45 + BW + 0.04) / 2, yy, 0.38), mat='gunmetal'))
        Fl.add(box(0.05, 2.0, 0.012, c=(s * (BW + 0.03), (AXF + AXR) / 2 - 0.06, 0.393), mat='rim'))      # step tread strip
    return Fl


def roof_rack():
    """low tubular rack on gutter feet over the cab roof (spare wheel strapped on it in build())"""
    R_ = B()
    zr = ROOF_Z + 0.10
    yf, yr = ROOF_F - 0.07, ROOF_R + 0.06
    for s in (1, -1):
        R_.add(rail([(s * 0.6, yf + 0.04, zr - 0.03), (s * 0.6, yf, zr), (s * 0.6, yr, zr), (s * 0.6, yr - 0.04, zr - 0.03)], r=0.018, rad=0.05, segs=8, mat='gunmetal', foot=False))
        for y in (yf - 0.06, (yf + yr) / 2, yr + 0.06):
            R_.add(box(0.04, 0.06, zr - ROOF_Z + 0.01, c=(s * 0.6, y, (zr + ROOF_Z) / 2 - 0.005), mat='gunmetal', bev=0.008, segs=1))
            R_.add(box(0.08, 0.08, 0.02, c=(s * 0.6, y, ROOF_Z + 0.005), mat='skirt', bev=0.006, segs=1))
    for y in np.linspace(yf - 0.02, yr + 0.02, 5):
        R_.add(tube([(-0.6, y, zr), (0.6, y, zr)], 0.015, 8, 'gunmetal'))
    return R_


# ================================================================================================ doors / tailgate
def door(side, which, frame, glass_p):
    """door: lofted outer skin + the greenhouse frame piece above the belt, door card + armrest + pull, window sill trim,
    outer handle in a recess, hinges, mirror (front).  Returns (part, glass part, hinge point)."""
    y0, y1 = DOORS[which]
    s = side
    D = door_skin(s, which)
    D.add(frame)
    # inner window-sill trim + door card (interior plastic) with armrest, pull handle, speaker, map pocket
    yi0, yi1 = y0 - 0.035, y1 + 0.035
    D.add(box(0.04, yi0 - yi1, 0.03, c=(s * 0.775, (yi0 + yi1) / 2, BELT - 0.015), mat='skirt', bev=0.008, segs=1))
    D.add(box(0.035, yi0 - yi1 - 0.02, BELT - 0.66, c=(s * 0.825, (yi0 + yi1) / 2, (BELT - 0.08 + 0.58) / 2), mat='cast', bev=0.01, segs=1))
    D.add(box(0.07, (yi0 - yi1) * 0.55, 0.05, c=(s * 0.79, (yi0 + yi1) / 2 - 0.03, 0.88), mat='cast', bev=0.015, segs=2))
    D.add(box(0.03, 0.12, 0.03, c=(s * 0.80, yi1 + 0.12, 0.98), mat='bare', bev=0.008, segs=1))
    D.add(cyl(0.065, 0.012, 16, 'x', c=(s * 0.81, yi0 - 0.12, 0.66), mat='decal'))
    D.add(box(0.04, (yi0 - yi1) * 0.6, 0.1, c=(s * 0.80, (yi0 + yi1) / 2 + 0.02, 0.64), mat='cast', bev=0.01, segs=1))
    D.add(box(0.03, 0.08, 0.04, c=(s * 0.80, yi1 + 0.2, 1.04), mat='skirt', bev=0.006, segs=1))
    # outer handle in a recess, key lock on the front doors
    hy = y1 + 0.14
    hz = BELT - 0.12
    xo = side_x(front_dims(hy)[2], hz)
    D.add(box(0.01, 0.17, 0.055, c=(s * (xo - 0.002), hy, hz), mat='decal', bev=0.003, segs=1))
    D.add(box(0.025, 0.15, 0.03, c=(s * (xo + 0.008), hy, hz + 0.004), mat='skirt', bev=0.008, segs=2))
    if which == 'F':
        D.add(cyl(0.012, 0.012, 10, 'x', c=(s * (xo + 0.006), hy + 0.11, hz + 0.005), mat='bare'))
    # hinges on the front edge
    for z in (0.66, 1.0):
        D.add(cyl(0.013, 0.07, 10, 'z', c=(s * (side_x(BW, z) + 0.012), y0 + 0.0, z), mat='gunmetal'))
        D.add(box(0.02, 0.05, 0.06, c=(s * (side_x(BW, z) - 0.004), y0 - 0.02, z), mat='gunmetal'))
    if which == 'F':
        # mirror: sail on the door top in front of the window, arm, housing, glass
        mz = BELT + 0.09
        my = y0 - 0.075
        gx = gh_x(BELT)
        D.add(hull([(s * (gx - 0.005), my + 0.06, BELT - 0.005), (s * (gx - 0.005), my - 0.08, BELT - 0.005), (s * (gx - 0.01), my + 0.0, BELT + 0.12),
                    (s * (gx + 0.03), my + 0.04, BELT + 0.0), (s * (gx + 0.03), my - 0.06, BELT + 0.0), (s * (gx + 0.025), my, BELT + 0.1)], mat='rolled', bev=0.006, segs=1))
        D.add(beam((s * (gx + 0.02), my, mz - 0.02), (s * (BW + 0.13), my - 0.03, mz), 0.04, 0.035, mat='skirt', bev=0.01))
        mh = []
        for (x, y, z) in [(0.08, -0.0, -0.09), (0.30, -0.03, -0.085), (0.08, 0.0, 0.09), (0.29, -0.03, 0.09),
                          (0.085, -0.1, -0.08), (0.28, -0.12, -0.075), (0.085, -0.1, 0.08), (0.27, -0.12, 0.08)]:
            mh.append((s * (BW + x), my + y + 0.02, mz + z))
        D.add(hull(mh, mat='rolled', bev=0.025, segs=3))
        D.add(box(0.18, 0.006, 0.15, c=(s * (BW + 0.185), my - 0.105, mz + 0.002), mat='light'))
        D.add(box(0.05, 0.01, 0.015, c=(s * (BW + 0.27), my - 0.09, mz - 0.06), mat='cage'))      # indicator
    hinge = (s * (BW + 0.012), y0, 0.8)
    return D, glass_p, hinge


def bed_body():
    """bed side walls (lofted closed sections, rear arch cut), floor + liner, bulkhead, tail lamps, rail caps"""
    y0, y1 = BED_Y
    Bd = B()
    for s in (1, -1):
        st = []
        for y in np.linspace(y0, y1, 10):
            zb = SILL + 0.04
            w = BW - 0.004
            out = []
            for i in range(13):
                z = zb + 0.02 + (BED_TOP - 0.035 - zb - 0.02) * i / 12
                out.append((side_x(w, z), z))
            xe = out[-1][0]
            ring = [(BED_IN + 0.012, zb), (w - 0.04, zb), (w - 0.01, zb + 0.012)] + out + \
                   [(xe - 0.004, BED_TOP - 0.018), (xe - 0.014, BED_TOP - 0.005), (xe - 0.03, BED_TOP), (BED_IN + 0.02, BED_TOP), (BED_IN, BED_TOP - 0.02), (BED_IN, BED_FLOOR + 0.08), (BED_IN + 0.012, BED_FLOOR - 0.04)]
            st.append((y, [(s * x, z) for x, z in ring]))
        w_ = loft(st, mirror=False)
        w_ = boolean(w_, [arch_cutter(AXR, RA, s * 0.5 - 0.6, s * 0.5 + 0.6)])
        w_.set_mat('rolled')
        set_mat_where(w_, 'canvas', lambda c, n: abs(c.x) < BED_IN + 0.004 and abs(n.x) > 0.7)
        set_mat_where(w_, 'skirt', lambda c, n: abs(math.hypot(c.y - AXR, c.z - WZ) - RA) < 0.012)
        w_.bevel(0.005, 1, 40)
        Bd.add(w_)
        # rail cap (black plastic) along the top, with stake-pocket covers
        xe = side_x(BW - 0.004, BED_TOP - 0.035)
        Bd.add(box(xe - BED_IN - 0.012, y0 - y1 - 0.02, 0.022, c=(s * (BED_IN + xe - 0.012) / 2, (y0 + y1) / 2, BED_TOP + 0.009), mat='skirt', bev=0.006, segs=2))
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
        for ya, yb in ((y0, AXR + RA + 0.012), (AXR - RA - 0.012, y1)):      # (in two pieces: it stops at the wheel arch - one full-length beam ran through the tyre)
            Bd.add(box(0.06, ya - yb, 0.06, c=(s * (BED_IN + 0.04), (ya + yb) / 2, SILL + 0.06), mat='gunmetal'))
    # floor (liner) with ribs, front bulkhead (liner on the inside), rear sill below the tailgate
    Bd.add(box(2 * BED_IN, y0 - y1 - 0.05, 0.05, c=(0, (y0 + y1) / 2 - 0.025, BED_FLOOR - 0.025), mat='canvas'))
    for i in range(10):
        x = -BED_IN + 0.1 + i * (2 * BED_IN - 0.2) / 9
        Bd.add(box(0.045, y0 - y1 - 0.14, 0.016, c=(x, (y0 + y1) / 2, BED_FLOOR + 0.008), bev=0.007, segs=1, mat='canvas'))
    Bd.add(box(2 * BED_IN + 0.02, 0.05, BED_TOP - SILL - 0.05, c=(0, y0 - 0.025, (BED_TOP + SILL + 0.05) / 2), bev=0.012, segs=1))
    Bd.add(box(2 * BED_IN, 0.02, BED_TOP - BED_FLOOR - 0.02, c=(0, y0 - 0.058, (BED_TOP + BED_FLOOR) / 2), mat='canvas', bev=0.006, segs=1))
    Bd.add(box(2 * BED_IN + 0.01, 0.055, TG_Z - SILL - 0.06, c=(0, y1 + 0.028, (TG_Z + SILL + 0.06) / 2 - 0.003), bev=0.008, segs=1))
    # bed underside pan + cross sills: full width ahead of / behind the rear wheels, between the tyres (inner faces at 0.64) across the arch
    ya, yb = AXR + RA + 0.012, AXR - RA - 0.012
    for f, r_, hw in ((y0, ya, BW - 0.03), (ya, yb, WELL_IN), (yb, y1, BW - 0.03)):
        Bd.add(box(2 * hw, f - r_, 0.03, c=(0, (f + r_) / 2, SILL + 0.06), mat='gunmetal'))
    for yy in np.linspace(y0 - 0.15, y1 + 0.15, 4):
        Bd.add(box(2 * (WELL_IN if yb - 0.03 < yy < ya + 0.03 else BED_IN), 0.05, 0.31, c=(0, yy, 0.70), mat='gunmetal'))
    return Bd


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


STEER = {}                       # steering wheel part / hub centre / axis (towards the driver), filled by interior()


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
    # (v6: rim, hub and spokes are a part of their own - node steer_wheel at the hub, turned about STEER_AXIS by the game)
    SW = B()
    SW.add(tube(ring, 0.017, 8, 'skirt', closed=True))
    SW.add(lathe([(0, 0.0), (0.065, 0.0), (0.06, 0.035), (0, 0.045)], 16, 'z', mat='skirt').xf(L.place(L.frame_from_normal(n), C - n * 0.02)))
    for a in (0, 180, 270):
        r_ = math.radians(a)
        p = C + (u * math.cos(r_) + v_ * math.sin(r_)) * 0.18
        SW.add(beam(C, p, 0.05 if a == 270 else 0.035, 0.018, mat='skirt', up=n))
    STEER['part'], STEER['c'], STEER['n'] = SW, tuple(C), tuple(n)
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
        I.add(beam((s * (gh_x(1.62) - 0.07), 0.02, 1.62), (s * 0.742, 0.02, 0.62), 0.045, 0.006, mat='skirt'))      # seat belts (inside the B / C pillar trims)
        I.add(beam((s * (gh_x(1.62) - 0.06), -0.84, 1.62), (s * 0.72, -0.70, 0.84), 0.045, 0.006, mat='skirt'))
        I.add(box(0.02, 0.03, 0.06, c=(s * (gh_x(1.6) - 0.05), 0.02, 1.6), mat='bare'))
    # ---- clutter: trauma bag on the rear left seat, helmet on the rear centre, handheld radio on the dash, IFAK on the console
    bag = box(0.42, 0.27, 0.24, c=(0, 0, 0), mat='era', bev=0.04, segs=2)
    bag.add(box(0.2, 0.06, 0.012, c=(0, 0, 0.122), mat='rolled'))
    bag.add(box(0.06, 0.2, 0.012, c=(0, 0, 0.122), mat='rolled'))
    bag.add(box(0.36, 0.008, 0.012, c=(0, 0.06, 0.118), mat='skirt'))
    for x in (-0.08, 0.08):
        bag.add(rail([(x, -0.05, 0.12), (x, -0.05, 0.17), (x, 0.05, 0.17), (x, 0.05, 0.12)], r=0.008, rad=0.03, mat='skirt', foot=False))
    bag.add(box(0.2, 0.012, 0.14, c=(0, -0.14, -0.01), mat='era', bev=0.01, segs=1))
    if not ATGM:                 # (--atgm: no medical kit in the cab)
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
    if not ATGM:
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
LIT_Y = (-1.16, -2.48)           # litter length (grips included) inside the bulkhead and the closed tailgate
LIT_Z = BED_FLOOR + 0.035        # canvas top = the casualty's floor (wounded_on_bed root plane)


def bed_kit():
    """Inside the canopy: three folding litters lashed to the bed floor (aluminium poles, olive canvas, stirrup feet), a red
    trauma bag and an olive aid bag strapped to the canopy front wall over the litters' head ends."""
    K = B()
    for x in LIT_X:
        for sx in (1, -1):
            K.add(tube([(x + sx * 0.225, LIT_Y[0], LIT_Z), (x + sx * 0.225, LIT_Y[1], LIT_Z)], 0.016, 8, 'bare'))
            for y in (LIT_Y[0] - 0.25, LIT_Y[1] + 0.25):
                K.add(box(0.03, 0.03, LIT_Z - BED_FLOOR - 0.01, c=(x + sx * 0.225, y, (LIT_Z + BED_FLOOR) / 2 - 0.006), mat='bare'))
                K.add(beam((x + sx * 0.225, y + 0.04, LIT_Z + 0.012), (x + sx * 0.255, y + 0.07, BED_FLOOR + 0.004), 0.03, 0.004, mat='skirt', up=(0, 0, 1)))
            for y in LIT_Y:
                K.add(cyl(0.02, 0.07, 8, 'y', c=(x + sx * 0.225, y - (0.035 if y == LIT_Y[0] else -0.035) * -1, LIT_Z), mat='skirt'))   # grips
        K.add(box(0.43, LIT_Y[0] - LIT_Y[1] - 0.12, 0.005, c=(x, sum(LIT_Y) / 2, LIT_Z - 0.006), mat='wood'))
        for y in (LIT_Y[0] + 0.06, LIT_Y[1] - 0.06):                                              # spreader bars
            K.add(tube([(x - 0.225, y, LIT_Z - 0.012), (x + 0.225, y, LIT_Z - 0.012)], 0.009, 6, 'bare'))
    # bags hung on the bulkhead above the bed rail (inside the canopy, seen through the side windows)
    yb = can_fy(BED_TOP + 0.17) - 0.014 - 0.072          # back of the bags against the canopy front wall
    K.add(box(0.36, 0.14, 0.26, c=(-0.36, yb, BED_TOP + 0.17), mat='era', bev=0.03, segs=2))
    K.add(box(0.16, 0.006, 0.05, c=(-0.36, yb - 0.072, BED_TOP + 0.2), mat='rolled'))
    K.add(box(0.05, 0.006, 0.16, c=(-0.36, yb - 0.072, BED_TOP + 0.2), mat='rolled'))
    K.add(box(0.30, 0.12, 0.22, c=(0.38, yb + 0.01, BED_TOP + 0.15), mat='wood', bev=0.03, segs=2))
    for x in (-0.36, 0.38):
        K.add(box(0.04, 0.16, 0.012, c=(x, yb + 0.005, BED_TOP + 0.31), mat='skirt'))
    return K


def bed_deck():
    """--atgm: 18 mm plywood firing deck screwed to the bed floor on two 40 mm box-section bearers, edge strips, four
    eye bolts for the lashings"""
    K = B()
    y0, y1 = BED_Y[0] - 0.03, BED_Y[1] + 0.06
    for y in (y0 - 0.25, y1 + 0.25):
        K.add(box(2 * BED_IN - 0.06, 0.04, 0.04, c=(0, y, BED_FLOOR + 0.02), mat='gunmetal'))
    K.add(box(2 * BED_IN - 0.03, y0 - y1, 0.018, c=(0, (y0 + y1) / 2, BED_FLOOR + 0.049), mat='wood'))
    for s in (1, -1):
        K.add(box(0.03, y0 - y1, 0.006, c=(s * (BED_IN - 0.035), (y0 + y1) / 2, BED_FLOOR + 0.061), mat='gunmetal'))
        for y in (y0 - 0.12, y1 + 0.12):
            K.add(cyl(0.012, 0.03, 8, 'z', c=(s * (BED_IN - 0.09), y, BED_FLOOR + 0.073), mat='bare'))
    return K


def id_marks(bvh_body, bvh_can):
    """faction identification (own materials, toggled / tinted by medevac.js): id_tape = two tape bands across the canopy
    roof (faction tape colour), id_ru = white V marks on both front fenders and the bonnet front (Russian trucks only)"""
    tape = B()
    if bvh_can is None:          # (--atgm: no canopy - two bands across the bonnet instead)
        for y in (1.42, 1.72):
            tape.add(ribbon(bvh_body, [(x, y, 2.5) for x in np.linspace(-0.62, 0.62, 15)], (0, 0, -1), 0.05))
    else:
        for y in (-1.24, -2.36):
            tape.add(ribbon(bvh_can, [(x, y, 2.5) for x in np.linspace(-0.68, 0.68, 15)], (0, 0, -1), 0.05))
    ru = B()
    def vee(c, w, h, axis, s=1):
        u, v = c
        arms = [[(u - w / 2 + w / 2 * t, v + h / 2 - h * t) for t in np.linspace(0, 1, 5)],
                [(u + w / 2 * t, v - h / 2 + h * t) for t in np.linspace(0, 1, 5)]]
        for arm in arms:
            if axis == 'x':      # vertical side surface: (y, z) seen from outside
                ru.add(ribbon(bvh_body, [(s * 1.5, a, b) for a, b in arm], (-s, 0, 0), 0.04))
            else:                # horizontal (bonnet): (x, y)
                ru.add(ribbon(bvh_body, [(a, b, 2.5) for a, b in arm], (0, 0, -1), 0.045))
    for s in (1, -1):
        vee((1.58, 1.07), 0.22, 0.17, 'x', s)
    vee((0.0, 2.33), 0.26, -0.16, 'z')
    return tape, ru


# ================================================================================================ build
def build():
    t0 = time.time()
    L.reset()
    root = L.node_empty('root')
    hullE = L.node_empty('hull', root, (0, 0, 0))
    GL = B(mat='glass')
    H = lower_body()
    bvh_body = L.bvh_of(H)
    print('  lower body', H.tris(), '%.1fs' % (time.time() - t0))
    H.add(bed_body())
    G, gh_doors = greenhouse(GL)
    H.add(G)
    print('  greenhouse', H.tris(), '%.1fs' % (time.time() - t0))
    bvh_can = None
    if not ATGM:
        C, cdoor, cglass, chinge, bvh_can = canopy(GL)
        H.add(C)
        print('  canopy', H.tris(), '%.1fs' % (time.time() - t0))
    H.add(front_end(GL))
    H.add(flares_and_trim())
    if ATGM:
        H.add(bed_deck())
    else:
        H.add(roof_rack())
        H.add(bed_kit())
    H.add(chassis())
    I = interior()
    print('  interior tris', I.tris())
    H.add(I)
    # spare wheel lying flat on the roof rack + ratchet straps
    Wp = wheel()
    zr = ROOF_Z + 0.10 + 0.015
    spc = (0.0, (ROOF_F + ROOF_R) / 2 - 0.12)
    sp = L._bcopy(Wp); sp.rot('Y', 90); sp.move(spc[0], spc[1], zr + WW / 2 + 0.002)
    if not ATGM:                 # (--atgm: no spare in the bed - the tripod's front legs stand where it stood; it is under the bed, as on the stock truck)
        H.add(sp)
    for a in (() if ATGM else (0, 90)):
        st = box(0.04, 2 * WR + 0.03, 0.01, c=(0, 0, 0), mat='canvas').move(0, 0, WW / 2 + 0.007).rot('Z', a)
        H.add(st.move(spc[0], spc[1], zr + WW / 2 + 0.002))
        for sgn in (1, -1):
            dv = V((0, sgn * (WR + 0.01), 0)); dv.rotate(Matrix.Rotation(math.radians(a), 3, 'Z'))
            H.add(beam(V((spc[0], spc[1], zr + WW + 0.012)) + dv, V((spc[0], spc[1], zr - 0.005)) + dv * 1.02, 0.04, 0.01, mat='canvas', up=dv))
    print('  hull tris', H.tris(), '%.1fs' % (time.time() - t0))
    tape, ru = id_marks(bvh_body, bvh_can)
    hull_mesh = L.node_mesh('hull_geo', H, hullE, (0, 0, 0))
    glass_objs = [L.node_mesh('glass_geo', GL, hullE, (0, 0, 0))]
    # ---- doors (hinge empties, glass child mesh) + tailgate + canopy lift door
    door_objs, doors_man = [], {}
    for s, tag in ((-1, 'L'), (1, 'R')):
        for w in ('F', 'R'):
            p, g, hp = door(s, w, *gh_doors[(s, w)])
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
    swE = L.node_empty('steer_wheel', hullE, STEER['c'], 0.06)
    sw_obj = L.node_mesh('steer_wheel_geo', STEER['part'], swE, STEER['c'])
    cd_obj = None
    if not ATGM:
        cdE = L.node_empty('canopy_door', hullE, chinge, 0.1)
        cd_obj = L.node_mesh('canopy_door_geo', cdoor, cdE, chinge)
        glass_objs.append(L.node_mesh('canopy_door_glass', cglass, cdE, chinge))
        doors_man['canopy_door'] = dict(axis='x', open=round(math.radians(85), 3), parent='hull', note='canopy rear lift door, hinge on the roof rear edge, swings up and back (opens together with the tailgate)')
    # ---- faction identification meshes: own materials (not in the atlas), never decimated
    idm = []
    for nm, part, col in (('id_tape', tape, (0.85, 0.85, 0.82)), ('id_ru', ru, (0.85, 0.85, 0.82))):
        o = L.node_mesh(nm, part, hullE, (0, 0, 0))
        mt = T.principled('pickup_' + nm, color=col, rough=0.75, metal=0.0)
        o.data.materials.clear(); o.data.materials.append(mt)
        for poly in o.data.polygons:
            poly.material_index = 0
        idm.append(o)
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
    lp = None
    if ATGM:
        L.node_empty('atgm_mount', hullE, (0.0, MOUNT_Y, BED_FLOOR + 0.058), 0.15)          # on the deck, +Z = the truck's front
        for i, (x, y) in enumerate(((-(BED_IN - 0.16), -1.95), (BED_IN - 0.16, -1.95))):   # spare TLCs on the deck along both walls
            L.node_empty(f'tlc_{i + 1}', hullE, (x, y, BED_FLOOR + 0.075), 0.1)
        L.node_empty('load_point', hullE, (0.0, REAR - 0.85, 0.0), 0.12)
    else:
        for i, x in enumerate(LIT_X):
            e = L.node_empty(f'stretcher_{i + 1}', hullE, (x, -1.80, LIT_Z), 0.12)
            stretchers.append(e)
        lp = L.node_empty('load_point', hullE, (0.0, REAR - 0.85, 0.0), 0.12)
    print('  geometry done %.1fs' % (time.time() - t0))
    tail = [tg_obj, sw_obj] + ([cd_obj] if cd_obj else [])
    lod0 = [hull_mesh] + door_objs + tail + wheel_objs + glass_objs
    return dict(root=root, hull=hullE, lod0=lod0, atlas=[hull_mesh] + door_objs + tail + [wheel_objs[0], wheel_objs[2]],
                doors=door_objs, tg=tg_obj, sw=sw_obj, cd=cd_obj, wheels=wheel_objs, doors_man=doors_man, stretchers=stretchers, load_point=lp,
                bake_hide=glass_objs + idm, glass=glass_objs, nolod=glass_objs, idm=idm)


def orient_empties(d):
    """three.js reads local +Z of an empty as its facing.  After the authoring->export flip (180 deg about Z) and the
    glTF Y-up conversion, an unrotated empty faces the vehicle's FRONT (+Z glTF).  Stretcher slots face the tailgate
    (rotate 180 deg about the up axis), load_point faces the truck (forward: no rotation)."""
    for e in d['stretchers']:
        e.rotation_euler = (0, 0, math.pi)
    bpy.context.view_layer.update()


def wreck(d):
    """Burnt-out pickup on its rims (tyres, glass, lamp lenses, litter canvas and the cabin trim gone), doors sprung."""
    root = d['root']
    drop = WZ - 0.235
    for o in d['doors']:
        e = o.parent
        ent = d['doors_man'][e.name]
        e.rotation_euler = (0, 0, ent['open'] * 0.25)
    bpy.context.view_layer.update()
    hw = VB.join_copies('hull_wreck', [d['lod0'][0]] + d['doors'] + [d['tg'], d['sw']] + ([d['cd']] if d['cd'] else []) + d['wheels'], root, (0, 0, 0),
                        drop_slots=('tyre', 'glass', 'light', 'decal', 'wood'), drop_z=drop)
    for o in d['doors']:
        o.parent.rotation_euler = (0, 0, 0)
    bpy.context.view_layer.update()
    return [hw]


def rect_shape(hu, hv, r=0.025):
    """rounded rectangle |u| <= hu, |v| <= hv (corner radius r)"""
    def f(u, v):
        du = np.maximum(np.abs(u) - (hu - r), 0); dv = np.maximum(np.abs(v) - (hv - r), 0)
        return ((np.abs(u) <= hu) & (np.abs(v) <= hv) & (du * du + dv * dv <= r * r)).astype(np.float32)
    return f


def decals(P, N):
    """White panels with red crosses (painted / magnetic casevac signs): both front doors, both canopy sides behind the
    windows, the tailgate, the bonnet and the canopy roof.  Returns layers [(sRGB, mask, patchy)] for vbuild."""
    if ATGM:
        return []                # plain civilian white: no signs
    E = lambda p: (-p[0], -p[1], p[2])
    white = np.zeros(P.shape[:2], np.float32); red = np.zeros_like(white)
    def sign(c, n, up, hu, hv, arm, hw):
        nonlocal white, red
        white += T.decal_mask(P, N, E(c), E(n), E(up), rect_shape(hu, hv))
        red += T.decal_mask(P, N, E(c), E(n), E(up), T.cross_shape(arm, hw))
    zc = 0.86
    for s in (1, -1):
        sign((s * (side_x(BW, zc) + 0.01), 0.60, zc), (s, 0, 0), (0, 0, 1), 0.23, 0.17, 0.13, 0.042)
        zz = CAN_Z0 + 0.21
        sign((s * (can_x(zz) + 0.004), -2.27, zz), (s * 0.986, 0, 0.168), (0, 0, 1), 0.18, 0.16, 0.115, 0.038)
    sign((0, REAR - 0.03, 1.105), (0, -1, 0), (0, 0, 1), 0.26, 0.15, 0.115, 0.038)
    sign((0, 1.90, front_surface_z(0, 1.90)), (0, 0.06, 1), (0, 1, 0), 0.26, 0.24, 0.17, 0.055)
    sign((0, -1.80, CAN_TOP + 0.018), (0, 0, 1), (0, 1, 0), 0.52, 0.52, 0.36, 0.11)
    return [((226, 226, 218), np.clip(white, 0, 1), False), ((172, 24, 22), np.clip(red, 0, 1), True)]


# flat ranger-green brush repaint (both sides' casevac pickups), black plastic trim, black wheels
VB.SCHEMES['medevac_green'] = dict(base=(74, 82, 57), base2=(66, 74, 51), camo=None, dust=(150, 140, 118), mud=(96, 84, 66),
                                   wear=0.75, dust_amt=0.8, mud_amt=0.9, fade=(98, 104, 80), rough_base=0.62,
                                   kind_colors={'skirt': ((28, 28, 27), 0.7, 0.0), 'canvas': ((26, 26, 25), 0.92, 0.0),
                                                'era': ((150, 18, 14), 0.3, 0.0), 'cage': ((205, 110, 22), 0.2, 0.0),
                                                'cast': ((60, 60, 57), 0.7, 0.0), 'wood': ((86, 88, 58), 0.95, 0.0),
                                                'rim': ((30, 30, 29), 0.5, 0.3)},
                                   clean_kinds=('cast',))


# --atgm: factory white under road dust and mud (the commonest pickup colour in the war zone), plywood deck, black trim
VB.SCHEMES['technical_white'] = dict(base=(222, 222, 214), base2=(206, 206, 198), camo=None, dust=(150, 140, 118), mud=(96, 84, 66),
                                     wear=0.6, dust_amt=1.25, mud_amt=1.3, fade=(232, 232, 226), rough_base=0.5,
                                     kind_colors={'skirt': ((28, 28, 27), 0.7, 0.0), 'canvas': ((26, 26, 25), 0.92, 0.0),
                                                  'era': ((150, 18, 14), 0.3, 0.0), 'cage': ((205, 110, 22), 0.2, 0.0),
                                                  'cast': ((60, 60, 57), 0.7, 0.0), 'wood': ((152, 128, 92), 0.9, 0.0),
                                                  'rim': ((30, 30, 29), 0.5, 0.3)},
                                     clean_kinds=('cast',))


def write_armor():
    """pickup_armor.json: sheet steel only (0.7-0.8 mm body panels, ~2-3 mm frame); the cab is not protected at all."""
    J = {
        'model': NAME, 'vehicle': 'civilian double-cab pickup (' + ('anti-tank missile carrier' if ATGM else 'casualty evacuation') + ')',
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
              markings='flat ranger-green repaint; white panels with red crosses on the front doors, canopy sides, tailgate, bonnet and canopy roof; faction ID meshes id_tape (canopy roof tape bands, tinted to the faction tape colour at runtime) and id_ru (white V marks, Russian trucks only); no badges', variants='shared by UA and RU (medevac.js tints id_tape, shows id_ru for RU)',
              sources=['https://www.toyota.com.au/hilux/specs (Hilux double cab: 5325 x 1855 x 1815 mm, wheelbase 3085 mm, track 1540 mm, 265/65R17)',
                       'https://www.mitsubishi-motors.com/en/products/l200 (L200 double cab: 5305 x 1815 x 1780 mm, wheelbase 3000 mm, bed 1520 x 1470 mm)'],
              game=dict(hp_suggestion=160, speed_kmh=dict(road=110, off_road=45), game_speed=16.5, accel=5.0, turn_rate=1.35,
                        note='unarmoured: rifle fire disables it, any AT round destroys it'))


def main(argv):
    dev = '--dev' in argv
    d = build()
    orient_empties(d)
    if '--geo' in argv:        # fast geometry check: slot-coloured GLB, no bakes (python3 pickup.py --geo [out.glb])
        cols = dict(rolled=(0.2, 0.25, 0.14), skirt=(0.03, 0.03, 0.03), glass=(0.05, 0.07, 0.08), cast=(0.2, 0.2, 0.2), tyre=(0.04, 0.04, 0.04),
                    rim=(0.05, 0.05, 0.05), gunmetal=(0.08, 0.08, 0.08), bare=(0.3, 0.3, 0.3), canvas=(0.03, 0.03, 0.03), wood=(0.25, 0.25, 0.12),
                    era=(0.5, 0.02, 0.02), light=(0.8, 0.8, 0.7), decal=(0.01, 0.01, 0.01), cage=(0.8, 0.4, 0.05))
        for k, c in cols.items():
            m = bpy.data.materials.get('S_' + k)
            if m:
                m.diffuse_color = (*c, 1.0); m.use_nodes = True
                m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*c, 1.0)
        out = [a for a in argv if a.endswith('.glb')]
        VB.export(d['root'], out[0] if out else '/tmp/v7geo.glb')
        print('GEO tris', sum(L.tri_count(o) for o in d['lod0']), {o.name: L.tri_count(o) for o in d['lod0'][:1] + d['doors'][:1]})
        return
    VB.SOOT[:] = [((0.66, -2.1, 0.4), 0.18)]
    out = os.path.join(VB.REPO, 'previews', 'vehicles_v7', '_dev_' + NAME + '.glb') if dev else None
    info = VB.finalize(d, NAME, 'technical_white' if ATGM else 'medevac_green', decals, wreck, out=out, lod_ratio=0.3, glass_alpha=0.3)
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
    if ATGM:
        v.update(name='Pickup (ATGM carrier)', kind='atgmtruck', crew=3, passengers=0, casualty_slots=0,
                 markings='factory white under dust and mud, no signs; faction ID meshes id_tape (two tape bands across the bonnet, tinted at runtime) and id_ru (white V marks, Russian trucks)',
                 game=dict(hp_suggestion=160, game_speed=16.5, accel=5.0, turn_rate=1.35, note='unarmoured; fires its ATGM halted only'))
        v['real_dimensions_m'] = dict(v['real_dimensions_m'], height_over_rack=None, launcher_line_m=2.14)
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
    if ATGM:
        v['atgm_mount'] = {'node': 'atgm_mount', 'note': 'on the plywood deck in the bed, +Z = the truck front: parent the Kornet / Stugna-P launcher (assets/soldiers/kornet.glb / stugna.glb, tripod deployed) here; tlc_1 / tlc_2 = spare missile containers on the deck along the bed walls'}
    nb = STEER['n']
    v['steering_wheel'] = {'node': 'steer_wheel', 'axis': [round(-nb[0], 4), round(nb[2], 4), round(nb[1], 4)], 'radius_m': 0.185,
                           'note': 'origin at the hub; node-local axis points at the driver: rotate about it by +angle for a left turn (anticlockwise as he sees it)'}
    v['casualty_slots'] = {} if ATGM else {'nodes': ['stretcher_1', 'stretcher_2', 'stretcher_3'], 'note': 'origin on the bed floor; local +Z points to the tailgate, so a casualty lying on his back with the head along -Z lies head towards the cab',
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
