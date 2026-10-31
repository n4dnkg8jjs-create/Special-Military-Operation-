"""Mesh building helpers. Geometry is authored in glTF/three.js space (Y up, +Z = outside/forward)
in numpy, then converted to Blender (Z up) only when an object is created: blender = (x, -z, y).
"""
import math, os, json
import numpy as np

try:
    import bpy, mathutils
    from mathutils import Vector
except ImportError:  # texture-only use
    bpy = None

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))


def rng(seed):
    return np.random.default_rng(seed)


# ------------------------------------------------------------------ atlas regions
class Region:
    """Pixel rect in an atlas (x0,y0 top-left, x1,y1) -> UV mapping. s,t in 0..1 (t up)."""
    def __init__(self, x0, y0, x1, y1, S=2048, pad=3):
        self.px = (x0, y0, x1, y1); self.S = S
        self.u0 = (x0 + pad) / S; self.u1 = (x1 - pad) / S
        self.v0 = 1 - (y1 - pad) / S; self.v1 = 1 - (y0 + pad) / S

    def uv(self, s, t):
        s = min(max(s, 0.0), 1.0); t = min(max(t, 0.0), 1.0)
        return (self.u0 + s * (self.u1 - self.u0), self.v0 + t * (self.v1 - self.v0))

    def sub(self, s0, t0, s1, t1):
        """Sub-region in normalised coords (t up)."""
        r = Region.__new__(Region); r.S = self.S; r.px = self.px
        du, dv = self.u1 - self.u0, self.v1 - self.v0
        r.u0, r.u1 = self.u0 + s0 * du, self.u0 + s1 * du
        r.v0, r.v1 = self.v0 + t0 * dv, self.v0 + t1 * dv
        return r


def _axes_for_normal(n):
    """Pick 2 projection axes (a, b) for planar mapping given a face normal; b is 'up' where possible."""
    ax = np.abs(n)
    if ax[1] >= ax[0] and ax[1] >= ax[2]:      # horizontal face -> x, z
        return np.array([1.0, 0, 0]), np.array([0, 0, -1.0 if n[1] > 0 else 1.0])
    up = np.array([0, 1.0, 0])
    a = np.cross(up, n); a /= (np.linalg.norm(a) + 1e-9)
    return a, up


class Fit:
    """Planar 'fit' mapping of a face into a region whose texture represents size_m metres.
    Faces larger than the region are scaled down to fit; small faces get a random offset."""
    def __init__(self, region, size_m=(1.0, 1.0), seed=0, stretch=False):
        self.r = region; self.size = size_m; self.rng = rng(seed); self.stretch = stretch

    def __call__(self, P, n):
        a, b = _axes_for_normal(n)
        A = P @ a; B = P @ b
        A = A - A.min(); B = B - B.min()
        ea, eb = A.max() / self.size[0], B.max() / self.size[1]
        k = 1.0
        if self.stretch:
            sa, sb = 1.0 / max(ea, 1e-6), 1.0 / max(eb, 1e-6)
            return [self.r.uv(x * sa / self.size[0], y * sb / self.size[1]) for x, y in zip(A, B)]
        k = 1.0 / max(1.0, ea, eb)
        oa = self.rng.random() * max(0.0, 1 - ea * k); ob = self.rng.random() * max(0.0, 1 - eb * k)
        return [self.r.uv(oa + x * k / self.size[0], ob + y * k / self.size[1]) for x, y in zip(A, B)]


class Proj:
    """Absolute planar projection: s = (P.a - o_a)/sa, t = (P.b - o_b)/sb into region."""
    def __init__(self, region, a, b, origin=(0, 0), scale=(1, 1)):
        self.r = region; self.a = np.array(a, float); self.b = np.array(b, float); self.o = origin; self.s = scale

    def __call__(self, P, n):
        return [self.r.uv((p @ self.a - self.o[0]) / self.s[0], (p @ self.b - self.o[1]) / self.s[1]) for p in P]


# ------------------------------------------------------------------ mesh builder
class MB:
    def __init__(self, name='mesh'):
        self.name = name
        self.V = []          # list of xyz (glTF space)
        self.F = []          # list of (idx tuple, uv list, smooth, mat)

    # -- primitives
    def v(self, p):
        self.V.append(np.asarray(p, float)); return len(self.V) - 1

    def vs(self, pts):
        i0 = len(self.V); self.V.extend(np.asarray(p, float) for p in pts); return list(range(i0, i0 + len(pts)))

    def face(self, idx, uv, smooth=False, mat=0):
        self.F.append((tuple(idx), list(uv), smooth, mat))

    def poly(self, pts, uvfn, smooth=False, mat=0):
        """Planar polygon from explicit points (CCW seen from the normal side). uvfn(P, n) -> uvs."""
        P = np.asarray(pts, float)
        n = newell(P)
        idx = self.vs(P)
        self.face(idx, uvfn(P, n), smooth, mat)
        return idx

    def quad(self, a, b, c, d, uvfn, mat=0, smooth=False):
        return self.poly([a, b, c, d], uvfn, smooth, mat)

    def box(self, mn, mx, uvfn, faces='all', mat=0, M=None):
        """Axis aligned box (optionally transformed by 4x4 M). faces: string of +x -x +y -y +z -z to keep."""
        x0, y0, z0 = mn; x1, y1, z1 = mx
        F = {
            '+x': [(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)],
            '-x': [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)],
            '+y': [(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)],
            '-y': [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)],
            '+z': [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)],
            '-z': [(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)],
        }
        for k, pts in F.items():
            if faces != 'all' and k not in faces:
                continue
            P = np.array(pts, float)
            if M is not None:
                P = xform(P, M)
            self.poly(P, uvfn, False, mat)

    def tube(self, path, radius, sides, uvfn_len, smooth=True, mat=0, cap=False, twist=0.0, flat=None):
        """Tube along a polyline. radius scalar or per-point. uvfn_len(s_around, length_m) -> uv.
        flat: optional (w_scale, h_scale) to make an elliptic/flattened section."""
        P = np.asarray(path, float); n = len(P)
        R = np.broadcast_to(np.asarray(radius, float), (n,))
        T = np.gradient(P, axis=0); T /= (np.linalg.norm(T, axis=1, keepdims=True) + 1e-12)
        # parallel transport frame
        up = np.array([0, 1.0, 0]) if abs(T[0][1]) < 0.9 else np.array([1.0, 0, 0])
        N0 = np.cross(T[0], up); N0 /= np.linalg.norm(N0) + 1e-12
        Ns = [N0]
        for i in range(1, n):
            v = np.cross(Ns[-1], T[i]); Nn = np.cross(T[i], v); l = np.linalg.norm(Nn)
            Ns.append(Nn / l if l > 1e-9 else Ns[-1])
        L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
        rings = []
        fw, fh = flat if flat else (1, 1)
        for i in range(n):
            Bv = np.cross(T[i], Ns[i])
            ring = []
            for k in range(sides):
                a = 2 * math.pi * k / sides + twist * i
                ring.append(P[i] + R[i] * (math.cos(a) * Ns[i] * fw + math.sin(a) * Bv * fh))
            rings.append(self.vs(ring))
        for i in range(n - 1):
            for k in range(sides):
                k2 = (k + 1) % sides
                idx = (rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k])
                uv = [uvfn_len(k / sides, L[i]), uvfn_len((k + 1) / sides, L[i]), uvfn_len((k + 1) / sides, L[i + 1]), uvfn_len(k / sides, L[i + 1])]
                self.face(idx, uv, smooth, mat)
        if cap:
            for i, rev in ((0, True), (n - 1, False)):
                idx = rings[i][::-1] if rev else rings[i]
                self.face(idx, [uvfn_len(0.5, L[i])] * sides, False, mat)
        return rings

    def ribbon(self, rows, uvfn_st, double=True, smooth=True, mat=0):
        """Grid surface from rows (list of lists of points, rows along t, columns along s).
        Faces both ways if double (duplicated verts, so normals stay correct)."""
        R = len(rows); C = len(rows[0])
        for side in ((0, 1) if double else (0,)):
            ids = [self.vs(r) for r in rows]
            for i in range(R - 1):
                for j in range(C - 1):
                    a, b, c, d = ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j]
                    uv = [uvfn_st(j / (C - 1), i / (R - 1)), uvfn_st((j + 1) / (C - 1), i / (R - 1)),
                          uvfn_st((j + 1) / (C - 1), (i + 1) / (R - 1)), uvfn_st(j / (C - 1), (i + 1) / (R - 1))]
                    if side == 0:
                        self.face((a, b, c, d), uv, smooth, mat)
                    else:
                        self.face((d, c, b, a), uv[::-1], smooth, mat)

    def merge(self, other, M=None):
        off = len(self.V)
        V = np.array(other.V) if other.V else np.zeros((0, 3))
        if M is not None and len(V):
            V = xform(V, M)
        self.V.extend(V)
        for idx, uv, sm, mt in other.F:
            self.face([i + off for i in idx], uv, sm, mt)
        return self

    def transform(self, M):
        if self.V:
            V = xform(np.array(self.V), M)
            self.V = list(V)
        return self

    def tris(self):
        return sum(len(f[0]) - 2 for f in self.F)

    def bounds(self):
        V = np.array(self.V); return V.min(0), V.max(0)

    # -- to blender
    def to_object(self, name, mats, smooth_angle=40.0, collection=None, location=(0, 0, 0)):
        V = np.array(self.V, float)
        VB = np.stack([V[:, 0], -V[:, 2], V[:, 1]], -1) if len(V) else V
        me = bpy.data.meshes.new(name)
        faces = [f[0] for f in self.F]
        me.from_pydata(VB.tolist(), [], faces)
        uv = me.uv_layers.new(name='UVMap')
        flat = [c for f in self.F for corner in f[1] for c in corner]
        uv.data.foreach_set('uv', flat)
        me.polygons.foreach_set('use_smooth', [bool(f[2]) for f in self.F])
        me.polygons.foreach_set('material_index', [int(f[3]) for f in self.F])
        if any(f[2] for f in self.F):
            try:
                me.set_sharp_from_angle(angle=math.radians(smooth_angle))
            except Exception:
                pass
        me.validate(clean_customdata=False)
        me.update()
        ob = bpy.data.objects.new(name, me)
        for m in mats:
            me.materials.append(m)
        (collection or bpy.context.scene.collection).objects.link(ob)
        lx, ly, lz = location
        ob.location = (lx, -lz, ly)
        return ob


def newell(P):
    n = np.zeros(3)
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]
        n += [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]
    l = np.linalg.norm(n)
    return n / l if l > 1e-12 else np.array([0, 0, 1.0])


def xform(P, M):
    P = np.asarray(P, float)
    return P @ M[:3, :3].T + M[:3, 3]


def mat_trs(t=(0, 0, 0), r=(0, 0, 0), s=1.0, order='XYZ'):
    """4x4 from translation, euler (radians, applied X then Y then Z by default), uniform/xyz scale."""
    rx, ry, rz = r
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    mats = {'X': Rx, 'Y': Ry, 'Z': Rz}
    R = np.eye(3)
    for ch in order:
        R = mats[ch] @ R
    S = np.diag(np.broadcast_to(np.asarray(s, float), (3,)))
    M = np.eye(4); M[:3, :3] = R @ S; M[:3, 3] = t
    return M


def rot_axis(axis, ang, origin=(0, 0, 0)):
    axis = np.asarray(axis, float); axis /= np.linalg.norm(axis)
    x, y, z = axis; c, s = math.cos(ang), math.sin(ang); C = 1 - c
    R = np.array([[c + x * x * C, x * y * C - z * s, x * z * C + y * s],
                  [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
                  [z * x * C - y * s, z * y * C + x * s, c + z * z * C]])
    o = np.asarray(origin, float)
    M = np.eye(4); M[:3, :3] = R; M[:3, 3] = o - R @ o
    return M


# ------------------------------------------------------------------ 2D polygon utils
def tessellate(loops):
    """loops: list of Nx2 arrays (first = outer, rest = holes). Returns triangles as index triples into
    the concatenation of loops."""
    vl = [[Vector((float(p[0]), float(p[1]), 0.0)) for p in L] for L in loops]
    return mathutils.geometry.tessellate_polygon(vl)


def poly_area(P):
    P = np.asarray(P); x, y = P[:, 0], P[:, 1]
    return 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)


def ccw(P):
    return P if poly_area(P) > 0 else P[::-1]


def cw(P):
    return P if poly_area(P) < 0 else P[::-1]


def resample_closed(P, step):
    P = np.asarray(P, float); out = []
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]
        n = max(1, int(math.ceil(np.linalg.norm(b - a) / step)))
        for k in range(n):
            out.append(a + (b - a) * k / n)
    return np.array(out)


def noise1d(n, seed, octaves=3, closed=True):
    """Smooth periodic 1D noise of length n, roughly -1..1."""
    r = rng(seed); out = np.zeros(n)
    for o in range(octaves):
        k = 2 ** (o + 1)
        pts = r.uniform(-1, 1, k + 1)
        if closed:
            pts[-1] = pts[0]
        x = np.linspace(0, k, n, endpoint=not closed)
        out += np.interp(x, np.arange(k + 1), pts) * (0.55 ** o)
    return out


def blob(cx, cy, rx, ry, n, seed, rough=0.25, spikes=0.0):
    """Irregular closed blob (CCW) for shell holes."""
    r = rng(seed)
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    rad = 1 + noise1d(n, seed, 4) * rough + r.normal(0, rough * 0.25, n)
    if spikes:
        k = r.integers(0, n, 3)
        for j in k:
            rad += spikes * np.exp(-((np.arange(n) - j + n / 2) % n - n / 2) ** 2 / 2.0)
    return np.stack([cx + np.cos(a) * rx * rad, cy + np.sin(a) * ry * rad], -1)


def point_in_poly(p, P):
    x, y = p; inside = False; n = len(P)
    for i in range(n):
        x1, y1 = P[i]; x2, y2 = P[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1:
            inside = not inside
    return inside


def seg_intersections(P, a, b):
    """Intersections of segment a-b with closed polygon P -> list of (t, point)."""
    out = []; a = np.asarray(a, float); b = np.asarray(b, float); d = b - a
    for i in range(len(P)):
        p, q = np.asarray(P[i], float), np.asarray(P[(i + 1) % len(P)], float); e = q - p
        den = d[0] * e[1] - d[1] * e[0]
        if abs(den) < 1e-12:
            continue
        w = p - a
        t = (w[0] * e[1] - w[1] * e[0]) / den
        u = (w[0] * d[1] - w[1] * d[0]) / den
        if 0 <= t <= 1 and 0 <= u <= 1:
            out.append((t, a + d * t, i))
    return sorted(out, key=lambda x: x[0])


# ------------------------------------------------------------------ the slab builder
def slab(mb, loops, levels, uv_front, uv_back, uv_side, mat=0, smooth_side=False):
    """Extrude a planar outline (in the XY plane) through depth (towards -Z).
    loops: list of dicts {pts: Nx2 (outer CCW / holes CW), off: per-vertex function(level_index, vertex_index) -> (d_in, dz)}
      d_in offsets the vertex towards the solid (left of travel), dz shifts depth.
    levels: list of z (0 ... -T). Front face uses level 0, back uses the last level.
    uv_front/back: fn(P, n); uv_side(s_along_m, frac_depth, loop_index, seg_len) -> uv.
    Returns dict of ring vertex ids per loop."""
    out = []
    ring_pos = []
    for li, L in enumerate(loops):
        P = np.asarray(L['pts'], float); n = len(P)
        # vertex inward (towards solid) normals = left normals of travel direction
        d_prev = P - np.roll(P, 1, 0); d_next = np.roll(P, -1, 0) - P
        def left(d):
            l = np.linalg.norm(d, axis=1, keepdims=True) + 1e-12
            return np.stack([-d[:, 1], d[:, 0]], -1) / l
        nl = left(d_prev) + left(d_next); nl /= (np.linalg.norm(nl, axis=1, keepdims=True) + 1e-12)
        rings = []
        for k, z in enumerate(levels):
            pts = []
            for i in range(n):
                din, dz = L['off'](k, i) if L.get('off') else (0.0, 0.0)
                xy = P[i] + nl[i] * din
                pts.append((xy[0], xy[1], z + dz))
            rings.append(np.array(pts))
        ring_pos.append(rings)
    # front face
    front_loops = [r[0][:, :2] for r in ring_pos]
    back_loops = [r[-1][:, :2] for r in ring_pos]
    allfront = np.concatenate([r[0] for r in ring_pos]); allback = np.concatenate([r[-1] for r in ring_pos])
    ids_f = mb.vs(allfront); ids_b = mb.vs(allback)
    for tri in tessellate(front_loops):
        P = allfront[list(tri)]
        n = newell(P)
        if n[2] < 0:
            tri = tri[::-1]; P = allfront[list(tri)]
        mb.face([ids_f[i] for i in tri], uv_front(P, np.array([0, 0, 1.0])), False, mat)
    for tri in tessellate(back_loops):
        P = allback[list(tri)]
        n = newell(P)
        if n[2] > 0:
            tri = tri[::-1]; P = allback[list(tri)]
        mb.face([ids_b[i] for i in tri], uv_back(P, np.array([0, 0, -1.0])), False, mat)
    # sides between levels: for each loop edge, quads level k -> k+1
    # uv_side(u0, u1, frac_a, frac_b, loop_index) -> 4 uvs; u in metres along the loop
    T = abs(levels[-1] - levels[0])
    for li, rings in enumerate(ring_pos):
        n = len(rings[0])
        ids = [mb.vs(r) for r in rings]
        base = rings[0]
        seg = np.linalg.norm(np.roll(base, -1, 0) - base, axis=1)
        cum = np.concatenate([[0], np.cumsum(seg)])
        for k in range(len(levels) - 1):
            fa = abs(levels[k] - levels[0]) / T; fb = abs(levels[k + 1] - levels[0]) / T
            for i in range(n):
                j = (i + 1) % n
                q = [ids[k][i], ids[k][j], ids[k + 1][j], ids[k + 1][i]]
                P = np.array([mb.V[t] for t in q])
                uv = uv_side(cum[i], cum[i] + seg[i], fa, fb, li, k, P, i)
                nrm = newell(P)
                d = np.array([P[1][0] - P[0][0], P[1][1] - P[0][1]])
                right = np.array([d[1], -d[0]])
                if nrm[0] * right[0] + nrm[1] * right[1] < 0:
                    q = q[::-1]; uv = uv[::-1]
                mb.face(q, uv, smooth_side, mat)
    return ring_pos


# ------------------------------------------------------------------ blender scene / materials / export
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)


def load_image(path, colorspace='sRGB'):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = colorspace
    return img


def _gltf_output_group():
    g = bpy.data.node_groups.get('glTF Material Output')
    if g:
        return g
    g = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
    g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    g.nodes.new('NodeGroupInput')
    return g


def make_material(name, albedo=None, normal=None, orm=None, color=(0.8, 0.8, 0.8, 1), rough=0.9, metal=0.0,
                  alpha_clip=None, double=False, normal_strength=1.0, emissive=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree; N = nt.nodes; Lk = nt.links
    bsdf = N.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = color
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if albedo:
        t = N.new('ShaderNodeTexImage'); t.image = load_image(albedo, 'sRGB'); t.location = (-600, 300)
        Lk.new(t.outputs['Color'], bsdf.inputs['Base Color'])
        if alpha_clip is not None:
            rnd = N.new('ShaderNodeMath'); rnd.operation = 'ROUND'   # glTF exporter reads this as alphaMode MASK, cutoff 0.5
            Lk.new(t.outputs['Alpha'], rnd.inputs[0]); Lk.new(rnd.outputs[0], bsdf.inputs['Alpha'])
            m.blend_method = 'CLIP' if hasattr(m, 'blend_method') else None
            try:
                m.alpha_threshold = alpha_clip
            except Exception:
                pass
            try:
                m.surface_render_method = 'DITHERED'
            except Exception:
                pass
    if normal:
        t = N.new('ShaderNodeTexImage'); t.image = load_image(normal, 'Non-Color'); t.location = (-600, -300)
        nm = N.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = normal_strength
        Lk.new(t.outputs['Color'], nm.inputs['Color']); Lk.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    if orm:
        t = N.new('ShaderNodeTexImage'); t.image = load_image(orm, 'Non-Color'); t.location = (-900, 0)
        sep = N.new('ShaderNodeSeparateColor')
        Lk.new(t.outputs['Color'], sep.inputs['Color'])
        Lk.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
        Lk.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
        g = N.new('ShaderNodeGroup'); g.node_tree = _gltf_output_group()
        Lk.new(sep.outputs['Red'], g.inputs['Occlusion'])
    if emissive:
        bsdf.inputs['Emission Color'].default_value = emissive
        bsdf.inputs['Emission Strength'].default_value = 1.0
    m.use_backface_culling = not double
    return m


def add_empty(name, pos, parent=None):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.1
    x, y, z = pos
    e.location = (x, -z, y)
    bpy.context.scene.collection.objects.link(e)
    if parent is not None:
        e.parent = parent
    return e


def export_glb(path, selection=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    kw = dict(filepath=path, export_format='GLB', export_yup=True, export_apply=True,
              export_image_format='AUTO', export_materials='EXPORT', export_cameras=False,
              export_lights=False, export_extras=False, export_texcoords=True, export_normals=True)
    if selection is not None:
        bpy.ops.object.select_all(action='DESELECT')
        for o in selection:
            o.select_set(True)
        kw['use_selection'] = True
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError:
        kw.pop('export_extras', None)
        bpy.ops.export_scene.gltf(**kw)
    return os.path.getsize(path)


def update_manifest(section, data):
    if os.environ.get('NO_MANIFEST'):      # QA iterations: leave assets/env/manifest.json alone
        print('NO_MANIFEST set: manifest section', section, 'not written'); return
    p = os.path.join(REPO, 'assets', 'env', 'manifest.json')
    m = {}
    if os.path.exists(p):
        with open(p) as f:
            m = json.load(f)
    if section is None:
        m.update(data)
    else:
        m[section] = data
    with open(p, 'w') as f:
        json.dump(m, f, indent=1)


def bbox_dict(mb):
    mn, mx = mb.bounds()
    return {'min': [round(float(v), 3) for v in mn], 'max': [round(float(v), 3) for v in mx], 'tris': mb.tris()}


def side_uv(region, length_m, depth_flip=True):
    """uv_side for slab(): u wraps every length_m metres inside the region, v = depth fraction."""
    def f(a, b, fa, fb, li, *rest):
        L = b - a
        u0 = (a % length_m) / length_m; du = L / length_m
        if u0 + du > 1:
            u0 = max(0.0, 1 - du)
        u1 = min(1.0, u0 + du)
        ta, tb = (1 - fa, 1 - fb) if depth_flip else (fa, fb)
        return [region.uv(u0, ta), region.uv(u1, ta), region.uv(u1, tb), region.uv(u0, tb)]
    return f
