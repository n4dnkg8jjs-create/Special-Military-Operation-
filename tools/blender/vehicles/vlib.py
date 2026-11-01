"""Procedural hard-surface vehicle toolkit (bpy 5.x as a Python module).

Authoring frame used by every vehicle script:  X = vehicle right, Y = forward, Z = up, metres,
origin on the ground at the footprint centre.  `finalize_frame()` rotates everything 180 deg about Z
so that after the glTF Y-up conversion the model faces +Z with its right side on -X (three.js default).

Geometry is accumulated in bmesh "parts" (B class) that are bevelled / subdivided through temporary
objects + modifiers (same code path as the UI), then merged into one mesh per hierarchy node.
"""
import bpy, bmesh, math, random
import numpy as np
from mathutils import Vector, Matrix, Euler
from mathutils.bvhtree import BVHTree

TAU = math.tau
V = Vector

# --------------------------------------------------------------------------------------------- scene
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    return sc

def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob

# --------------------------------------------------------------------------------------------- materials
# Atlas "kinds": every painted / rubber / wooden part shares one baked atlas material per vehicle.
# During baking each kind gets its own temporary material so the procedural texture composer can
# tell them apart; afterwards they are merged into one glTF material.
# 'decal' is used for the dark interior seen through open hatches (vbuild.compose_paint paints it near-black)
KINDS = ['rolled', 'cast', 'skirt', 'gunmetal', 'rim', 'tyre', 'wood', 'canvas', 'era', 'bare',
         'cage', 'decal']
SLOTS = KINDS + ['glass', 'light', 'track']
SI = {k: i for i, k in enumerate(SLOTS)}

def kind_value(k):
    return (KINDS.index(k) + 0.5) / 16.0

# --------------------------------------------------------------------------------------------- bmesh part
class B:
    """Wrapper around a bmesh with chainable transforms.  All new faces get material slot `mat`."""
    def __init__(self, bm=None, mat='rolled'):
        self.bm = bm or bmesh.new()
        self.set_mat(mat)

    def set_mat(self, mat):
        i = SI[mat]
        for f in self.bm.faces:
            f.material_index = i
        return self

    def copy(self):
        return B(self.bm.copy(), None) if False else _bcopy(self)

    def xf(self, M):
        bmesh.ops.transform(self.bm, matrix=M, verts=self.bm.verts)
        return self

    def move(self, x=0, y=0, z=0):
        return self.xf(Matrix.Translation((x, y, z)))

    def rot(self, ax, deg, about=(0, 0, 0)):
        p = V(about)
        M = Matrix.Translation(p) @ Matrix.Rotation(math.radians(deg), 4, ax) @ Matrix.Translation(-p)
        return self.xf(M)

    def scale(self, sx, sy=None, sz=None):
        sy = sx if sy is None else sy
        sz = sx if sz is None else sz
        M = Matrix.Diagonal((sx, sy, sz, 1))
        self.xf(M)
        if sx * sy * sz < 0:
            bmesh.ops.reverse_faces(self.bm, faces=self.bm.faces)
        return self

    def mirror_x(self, keep=True):
        """Return self + mirrored copy (about x=0)."""
        m = _bcopy(self)
        m.scale(-1, 1, 1)
        if keep:
            self.add(m)
            return self
        return m

    def add(self, other, M=None):
        if isinstance(other, B):
            other = other.bm
        me = bpy.data.meshes.new('_tmp')
        other.to_mesh(me)
        nv = len(self.bm.verts)
        self.bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        if M is not None:
            self.bm.verts.ensure_lookup_table()
            bmesh.ops.transform(self.bm, matrix=M, verts=self.bm.verts[nv:])
        return self

    def add_mesh(self, me, M=None, mat=None):
        nv = len(self.bm.verts)
        nf = len(self.bm.faces)
        self.bm.from_mesh(me)
        self.bm.verts.ensure_lookup_table()
        self.bm.faces.ensure_lookup_table()
        if M is not None:
            bmesh.ops.transform(self.bm, matrix=M, verts=self.bm.verts[nv:])
            if M.to_3x3().determinant() < 0:
                bmesh.ops.reverse_faces(self.bm, faces=self.bm.faces[nf:])
        if mat is not None:
            for f in self.bm.faces[nf:]:
                f.material_index = SI[mat]
        return self

    def to_mesh(self, name='part'):
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        return me

    # modifiers -------------------------------------------------------------------------------
    def mods(self, specs):
        me = bpy.data.meshes.new('_mod')
        self.bm.to_mesh(me)
        ob = link(bpy.data.objects.new('_mod', me))
        for t, kw in specs:
            m = ob.modifiers.new(t, t)
            for k, v in kw.items():
                setattr(m, k, v)
        dg = bpy.context.evaluated_depsgraph_get()
        nb = bmesh.new()
        nb.from_object(ob, dg)
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(me)
        self.bm.free()
        self.bm = nb
        return self

    def bevel(self, w=0.02, segs=2, angle=30, profile=0.5, clamp=True):
        return self.mods([('BEVEL', dict(width=w, segments=segs, limit_method='ANGLE',
                                         angle_limit=math.radians(angle), profile=profile,
                                         use_clamp_overlap=clamp, miter_outer='MITER_ARC'))])

    def subsurf(self, lv=1, crease_edges=None):
        return self.mods([('SUBSURF', dict(levels=lv, render_levels=lv, uv_smooth='PRESERVE_BOUNDARIES'))])

    def solidify(self, t, offset=-1):
        return self.mods([('SOLIDIFY', dict(thickness=t, offset=offset, use_even_offset=True))])

    def tris(self):
        return sum(len(f.verts) - 2 for f in self.bm.faces)


def _bcopy(b):
    n = B.__new__(B)
    n.bm = b.bm.copy()
    return n

# --------------------------------------------------------------------------------------------- primitives
def box(sx, sy, sz, c=(0, 0, 0), mat='rolled', bev=None, segs=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    b = B(bm, mat).scale(sx, sy, sz).move(*c)
    if bev:
        b.bevel(bev, segs)
    return b

def hull(points, mat='rolled', bev=None, segs=2, angle=30):
    """Convex hull of points, coplanar triangles dissolved into clean n-gons."""
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in points]
    r = bmesh.ops.convex_hull(bm, input=vs, use_existing_faces=False)
    g = list({id(e): e for e in r['geom_interior'] + r['geom_unused']}.values())
    if g:
        bmesh.ops.delete(bm, geom=g, context='VERTS')
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.5), verts=bm.verts, edges=bm.edges)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    b = B(bm, mat)
    if bev:
        b.bevel(bev, segs, angle)
    return b

def prism(poly, d, axis='z', mat='rolled', bev=None, segs=2, c=0.0, angle=30):
    """Extrude 2D polygon `poly` (list of (u,v)) by depth d centred on c along axis.
    axis z: poly in (x,y); axis x: poly in (y,z); axis y: poly in (x,z)."""
    bm = bmesh.new()
    def P(u, v, w):
        if axis == 'z':
            return (u, v, w)
        if axis == 'x':
            return (w, u, v)
        return (u, w, v)
    n = len(poly)
    lo = [bm.verts.new(P(u, v, c - d / 2)) for u, v in poly]
    hi = [bm.verts.new(P(u, v, c + d / 2)) for u, v in poly]
    bm.faces.new(lo[::-1])
    bm.faces.new(hi)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    b = B(bm, mat)
    if bev:
        b.bevel(bev, segs, angle)
    return b

def _axis_matrix(axis):
    if axis == 'z':
        return Matrix.Identity(4)
    if axis == 'x':
        return Matrix.Rotation(math.radians(90), 4, 'Y')
    if axis == 'y':
        return Matrix.Rotation(math.radians(-90), 4, 'X')
    return axis

def lathe(profile, segs=24, axis='z', mat='rolled', c=(0, 0, 0), cap=True, smooth_seams=True,
          phase=0.0, uv_scale=None):
    """Revolve profile [(r, h), ...] around +axis (h along axis).  Points with r==0 collapse to poles.
    Each profile vertex may carry a 3rd element: material name for the faces starting at it."""
    bm = bmesh.new()
    rings = []
    for p in profile:
        r, h = p[0], p[1]
        if r <= 1e-6:
            rings.append([bm.verts.new((0, 0, h))])
        else:
            rings.append([bm.verts.new((r * math.cos(TAU * i / segs + phase), r * math.sin(TAU * i / segs + phase), h))
                          for i in range(segs)])
    for k in range(len(rings) - 1):
        a, b_ = rings[k], rings[k + 1]
        m = profile[k][2] if len(profile[k]) > 2 else mat
        for i in range(segs):
            j = (i + 1) % segs
            if len(a) == 1 and len(b_) == 1:
                continue
            if len(a) == 1:
                f = bm.faces.new((a[0], b_[i], b_[j]))
            elif len(b_) == 1:
                f = bm.faces.new((a[i], b_[0], a[j]))
            else:
                f = bm.faces.new((a[i], b_[i], b_[j], a[j]))
            f.material_index = SI[m]
    if cap:
        if len(rings[0]) > 1:
            f = bm.faces.new(rings[0][::-1]); f.material_index = SI[profile[0][2] if len(profile[0]) > 2 else mat]
        if len(rings[-1]) > 1:
            f = bm.faces.new(rings[-1]); f.material_index = SI[profile[-2][2] if len(profile[-2]) > 2 else mat]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    b = B.__new__(B); b.bm = bm
    b.xf(_axis_matrix(axis))
    b.move(*c)
    return b

def cyl(r, h, segs=16, axis='z', c=(0, 0, 0), mat='rolled', r2=None, bev=None, bsegs=2):
    r2 = r if r2 is None else r2
    b = lathe([(0, -h / 2), (r, -h / 2), (r2, h / 2), (0, h / 2)], segs, axis, mat, c)
    if bev:
        b.bevel(bev, bsegs, 30)
    return b

def tube(path, r, segs=8, mat='rolled', closed=False, caps=True, r_list=None):
    """Sweep a circle along a polyline (parallel-transport frames)."""
    pts = [V(p) for p in path]
    n = len(pts)
    bm = bmesh.new()
    tans = []
    for i in range(n):
        if closed:
            t = (pts[(i + 1) % n] - pts[i - 1])
        elif i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = (pts[i + 1] - pts[i]).normalized() + (pts[i] - pts[i - 1]).normalized()
        tans.append(t.normalized())
    up = V((0, 0, 1)) if abs(tans[0].z) < 0.9 else V((1, 0, 0))
    nrm = tans[0].cross(up).normalized()
    rings = []
    for i in range(n):
        if i > 0:
            q = tans[i - 1].rotation_difference(tans[i])
            nrm = (q @ nrm).normalized()
        bin_ = tans[i].cross(nrm)
        # mitre scale at corners
        sc = 1.0
        if 0 < i < n - 1 or closed:
            a = (pts[(i + 1) % n] - pts[i]).normalized() if (i < n - 1 or closed) else tans[i]
            cosh = max(0.5, tans[i].dot(a))
            sc = 1.0 / cosh
        rr = r_list[i] if r_list else r
        ring = []
        for k in range(segs):
            ang = TAU * k / segs
            d = nrm * math.cos(ang) + bin_ * math.sin(ang)
            # scale only the component in the bend plane
            ring.append(bm.verts.new(pts[i] + d * rr))
        rings.append(ring)
    m = len(rings) if closed else len(rings) - 1
    for i in range(m):
        a, b_ = rings[i], rings[(i + 1) % n]
        for k in range(segs):
            j = (k + 1) % segs
            bm.faces.new((a[k], a[j], b_[j], b_[k]))
    if caps and not closed:
        bm.faces.new(rings[0][::-1])
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return B(bm, mat)

def fillet_path(pts, rad, steps=3):
    """Round the interior corners of a polyline."""
    pts = [V(p) for p in pts]
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        a, b_, c = pts[i - 1], pts[i], pts[i + 1]
        d1 = (a - b_); d2 = (c - b_)
        l1, l2 = d1.length, d2.length
        rr = min(rad, l1 * 0.45, l2 * 0.45)
        p1 = b_ + d1.normalized() * rr
        p2 = b_ + d2.normalized() * rr
        for s in range(steps + 1):
            t = s / steps
            out.append(p1 * (1 - t) ** 2 + b_ * 2 * t * (1 - t) + p2 * t * t)
    out.append(pts[-1])
    return out

def rail(pts, r=0.012, rad=0.05, segs=6, mat='rolled', foot=True):
    """Bent grab handle / hand rail with small weld feet at the ends."""
    b = tube(fillet_path(pts, rad), r, segs, mat)
    if foot:
        for p in (pts[0], pts[-1]):
            b.add(cyl(r * 1.9, 0.012, 8, c=p, mat=mat))
    return b

def bolt(r=0.012, h=0.008, segs=6, mat='rolled'):
    return lathe([(0, 0), (r, 0), (r, h * 0.6), (r * 0.7, h), (0, h)], segs, 'z', mat, phase=math.pi / segs)

def frame_from_normal(n, up=V((0, 0, 1))):
    """Matrix whose local Z aligns with n."""
    n = V(n).normalized()
    if abs(n.dot(up)) > 0.98:
        up = V((0, 1, 0))
    x = up.cross(n).normalized()
    y = n.cross(x)
    M = Matrix((x, y, n)).transposed()
    return M.to_4x4()

def place(M3, loc):
    M = M3.copy()
    M.translation = V(loc)
    return M

# --------------------------------------------------------------------------------------------- objects
FLIP = Matrix.Rotation(math.pi, 4, 'Z')

def fl(p):
    """authoring -> Blender export frame (180 deg about Z)."""
    return (-p[0], -p[1], p[2])

def node_empty(name, parent=None, loc=(0, 0, 0), size=0.2, world=True):
    """loc given in authoring frame, world coords (converted to parent-local)."""
    ob = link(bpy.data.objects.new(name, None))
    ob.empty_display_size = size
    _place(ob, parent, loc)
    return ob

def _place(ob, parent, loc):
    w = V(fl(loc))
    if parent:
        ob.parent = parent
        w = w - parent.matrix_world.translation
    ob.location = w
    ob.matrix_world  # noqa
    bpy.context.view_layer.update()

def node_mesh(name, part, parent=None, loc=(0, 0, 0), mesh=None, sharp=40, wn=True):
    """Create mesh object.  `part` is in authoring WORLD coords; `loc` (authoring world) becomes the
    object origin (pivot).  With `mesh` given, reuse that (already pivot-local, flipped) mesh data."""
    if mesh is None:
        me = bpy.data.meshes.new(name)
        part.move(-loc[0], -loc[1], -loc[2])
        part.xf(FLIP)
        part.bm.to_mesh(me)
        part.bm.free()
        for _ in SLOTS:
            pass
        mats = [bpy.data.materials.get('S_' + s) or _slot_mat(s) for s in SLOTS]
        for m in mats:
            me.materials.append(m)
        finish_normals(me, sharp, wn)
    else:
        me = mesh
    ob = link(bpy.data.objects.new(name, me))
    _place(ob, parent, loc)
    return ob

def _slot_mat(s):
    m = bpy.data.materials.new('S_' + s)
    return m

def finish_normals(me, sharp=40, wn=True):
    """Smooth shading, sharp edges above `sharp` deg, weighted normals (face area)."""
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    for f in bm.faces:
        f.smooth = True
    lim = math.radians(sharp)
    for e in bm.edges:
        if len(e.link_faces) != 2:
            e.smooth = False
        else:
            f1, f2 = e.link_faces
            e.smooth = not (f1.normal.angle(f2.normal, 0) > lim or f1.material_index != f2.material_index)
    bm.to_mesh(me)
    bm.free()
    if wn:
        ob = link(bpy.data.objects.new('_wn', me))
        m = ob.modifiers.new('wn', 'WEIGHTED_NORMAL')
        m.mode = 'FACE_AREA'; m.weight = 50; m.keep_sharp = True
        bpy.context.view_layer.objects.active = ob
        with bpy.context.temp_override(object=ob, active_object=ob):
            bpy.ops.object.modifier_apply(modifier='wn')
        bpy.data.objects.remove(ob)

def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)

def bvh_of(part):
    bm = part.bm.copy()
    bmesh.ops.triangulate(bm, faces=bm.faces)
    t = BVHTree.FromBMesh(bm)
    bm.free()
    return t

def drop_on(bvh, x, y, ztop=5.0):
    """Ray straight down onto a surface: returns (location, normal) or (None, None)."""
    hit = bvh.ray_cast(V((x, y, ztop)), V((0, 0, -1)))
    return hit[0], hit[1]

# --------------------------------------------------------------------------------------------- misc
def rng(seed):
    return random.Random(seed)

# --------------------------------------------------------------------------------------------- hatch lids
# Openable crew hatches: the lid is its own mesh under a hinge empty (see vbuild.hatch_lid); the fixed body keeps
# a coaming ring + a dark opening plate (visible only while the lid is open) + the hinge brackets.
def round_lid(r, h=0.045, hinge=(0, 1), segs=24, handle=True, mat='rolled'):
    """Domed round lid lying on z=0 (closed), centred on the origin.  hinge = 2D direction (local xy) from the centre
    to the hinge edge.  Returns (part, pivot, axis): pivot = point on the hinge axis, axis = hinge line direction."""
    b = lathe([(0, h), (r * 0.86, h * 0.89), (r * 0.96, h * 0.44), (r, 0)], segs, 'z', mat=mat)
    # underside stiffener ring + rubber seal step (seen when the lid stands open)
    b.add(lathe([(r * 0.72, -0.001), (r * 0.72, -0.022), (r * 0.64, -0.022), (r * 0.64, -0.001)], segs, 'z', mat=mat, cap=False))
    hd = V((hinge[0], hinge[1], 0)).normalized()
    t = V((-hd.y, hd.x, 0))
    piv = hd * (r + 0.014) + V((0, 0, 0.022))
    for s in (-1, 1):
        c = hd * (r + 0.014) + t * (s * r * 0.38) + V((0, 0, 0.022))
        kn = cyl(0.023, 0.1, 10, 'x', mat=mat)
        kn.xf(Matrix((hd.cross(V((0, 0, 1))), hd, V((0, 0, 1)))).transposed().to_4x4())
        b.add(kn.move(*c))
        # strap from the knuckle onto the lid
        a0 = hd * (r + 0.005) + t * (s * r * 0.38)
        a1 = hd * (r * 0.62) + t * (s * r * 0.38)
        b.add(hull([a0 + t * 0.03 + V((0, 0, 0.0)), a0 - t * 0.03, a0 + t * 0.03 + V((0, 0, 0.03)), a0 - t * 0.03 + V((0, 0, 0.03)),
                    a1 + t * 0.03 + V((0, 0, h * 0.86)), a1 - t * 0.03 + V((0, 0, h * 0.86)),
                    a1 + t * 0.03 + V((0, 0, h * 0.86 + 0.012)), a1 - t * 0.03 + V((0, 0, h * 0.86 + 0.012))], mat=mat))
    if handle:
        p = -hd * (r * 0.42)
        b.add(rail([p - t * 0.1 + V((0, 0, h * 0.8)), p - t * 0.1 + V((0, 0, h * 0.8 + 0.045)),
                    p + t * 0.1 + V((0, 0, h * 0.8 + 0.045)), p + t * 0.1 + V((0, 0, h * 0.8))], r=0.009, rad=0.02, mat=mat))
    b.add(cyl(0.028, 0.02, 10, c=(0, 0, h + 0.004), mat=mat))      # lock boss
    return b, piv, t

def round_coaming(r, hinge=(0, 1), segs=24, h=0.022, mat='rolled', depth=0.01):
    """Fixed hatch ring for round_lid(r): raised ring outside the lid edge, dark opening plate inside, hinge brackets.
    depth = how far the ring reaches below z=0 (use more on curved cast roofs so it meets the surface all round)."""
    b = lathe([(r * 1.005, -depth), (r * 1.12, -depth), (r * 1.12, h * 0.6), (r * 1.07, h), (r * 1.005, h)], segs, 'z', mat=mat, cap=False)
    b.add(cyl(r * 1.0, 0.006, segs, c=(0, 0, 0.001), mat='decal'))       # 'decal' kind = dark hatch interior
    hd = V((hinge[0], hinge[1], 0)).normalized()
    t = V((-hd.y, hd.x, 0))
    for s in (-1, 1):
        c = hd * (r + 0.02) + t * (s * (r * 0.38 + 0.072)) + V((0, 0, 0.014))
        br = box(0.035, 0.055, 0.052, mat=mat)
        br.xf(Matrix((hd.cross(V((0, 0, 1))), hd, V((0, 0, 1)))).transposed().to_4x4())
        b.add(br.move(*c))
    return b

def rect_lid(w, l, t=0.035, hinge='y-', rad=0.06, mat='rolled'):
    """Rectangular roof hatch lid (same look as btr.hatch_rect without its ring), lying on z=0 closed, centred on the
    origin; hinge edge 'y-' (rear) / 'y+' (front) / 'x-' / 'x+'.  Returns (part, pivot, axis)."""
    hw, hl = w / 2, l / 2
    poly = []
    for (cx, cy, a0) in ((hw - rad, hl - rad, 0), (-hw + rad, hl - rad, 90), (-hw + rad, -hl + rad, 180), (hw - rad, -hl + rad, 270)):
        for k in range(4):
            a = math.radians(a0 + k * 30)
            poly.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
    b = prism(poly, t, 'z', bev=0.008, segs=1, c=t / 2, mat=mat)
    b.add(prism([(x * 0.86, y * 0.86) for x, y in poly], 0.02, 'z', c=-0.011, mat=mat))       # underside pan / seal step
    ax = hinge[0]
    sg = 1 if hinge[1] == '+' else -1
    # build for a y-edge hinge, rotate for x-edge hinges
    if ax == 'x':
        hw, hl = hl, hw
    hy = sg * hl
    for sx in (-0.6, 0.6):
        kn = cyl(0.026, 0.12, 10, 'x', c=(sx * hw, hy + sg * 0.02, 0.026), mat=mat)
        st = box(0.09, hl * 0.55, 0.012, c=(sx * hw, hy - sg * hl * 0.25, t + 0.006), mat=mat)
        if ax == 'x':
            kn.rot('Z', -90 * 1); st.rot('Z', -90)
        b.add(kn); b.add(st)
    ry = -sg * hl * 0.55
    hd_rail = rail([(-0.12, ry, t), (-0.12, ry, t + 0.06), (0.12, ry, t + 0.06), (0.12, ry, t)], r=0.01, rad=0.03, mat=mat)
    if ax == 'x':
        hd_rail.rot('Z', -90)
    b.add(hd_rail)
    b.add(cyl(0.03, 0.02, 10, c=(0, 0, t + 0.01), mat=mat))
    piv = V((0, hy + sg * 0.02, 0.026))
    axis = V((1, 0, 0))
    if ax == 'x':
        piv = Matrix.Rotation(math.radians(-90), 3, 'Z') @ piv
        axis = V((0, 1, 0))
    return b, piv, axis

def rect_coaming(w, l, rad=0.06, mat='rolled'):
    """Fixed ring around rect_lid(w, l): raised frame + dark opening plate."""
    hw, hl = w / 2, l / 2
    poly = []
    for (cx, cy, a0) in ((hw - rad, hl - rad, 0), (-hw + rad, hl - rad, 90), (-hw + rad, -hl + rad, 180), (hw - rad, -hl + rad, 270)):
        for k in range(4):
            a = math.radians(a0 + k * 30)
            poly.append((cx + rad * math.cos(a), cy + rad * math.sin(a)))
    b = prism([(x * 1.08 + math.copysign(0.012, x), y * 1.08 + math.copysign(0.012, y)) for x, y in poly], 0.022, 'z', c=0.001, mat=mat)
    b.add(prism([(x * 0.99, y * 0.99) for x, y in poly], 0.004, 'z', c=0.0135, mat='decal'))
    return b
