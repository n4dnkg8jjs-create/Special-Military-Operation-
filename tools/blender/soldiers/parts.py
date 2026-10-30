"""Head / hands / boots meshes (decimated on variant A, bound to the base topology for other variants)."""
import numpy as np
import bpy
import bl, body as BD, meshutil as MU, mhbody as M


def _sub_with_uv(B, fsel, V):
    o = B.o
    src, F = BD.submesh(o['f'], fsel)
    uv = []
    for fi in fsel:
        for t in o['ft'][fi]:
            uv.append(o['vt'][t])
    return src, F, np.array(uv)


def decimated_part(B, fsel, ratio, name, V=None, sym=True, repack=True, extra=None):
    """returns dict(gl arrays for variant A, src->fullres binding, full-res tri list)"""
    V = B.vA if V is None else V
    src, F, uv = _sub_with_uv(B, fsel, V)
    P = V[src]
    bl.reset()
    ob = bl.make_obj(name, P, F, uv=uv)
    if ratio < 1:
        bl.decimate(ob, ratio, sym=sym)
    if repack:
        bl.activate(ob)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.select_all(action='SELECT')
        bpy.ops.uv.average_islands_scale()
        bpy.ops.uv.pack_islands(margin=0.008, rotate=True)
        bpy.ops.object.mode_set(mode='OBJECT')
    m = bl.extract(ob)
    T = MU.triangulate(F)
    binding = BD.bind(m['pos'], P, T)
    m['binding'] = binding; m['full_src'] = src; m['full_T'] = T
    m['W'] = BD.interp_bind(binding, B.W[src], T)
    return m


def variant_positions(part, V):
    P = V[part['full_src']]
    pos = BD.eval_bind(part['binding'], P, part['full_T'])
    return pos


def normals_for(pos, tri):
    return MU.weld_normals(pos, MU.vertex_normals(pos, tri), 1e-5)


def _ellipsoid(bm, c, r, axes, segs=16, rings=10):
    import bmesh
    from mathutils import Matrix
    res = bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    m = np.eye(4)
    m[:3, :3] = np.stack([axes[i] * r[i] for i in range(3)], 1)
    m[:3, 3] = c
    bmesh.ops.transform(bm, matrix=Matrix(m.tolist()), verts=res['verts'])


def _cyl(bm, a, b, r0, r1, segs=16):
    import bmesh
    from mathutils import Matrix
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r0, radius2=r1, depth=1.0)
    ax = (b - a) / np.linalg.norm(b - a)
    x = np.cross(ax, [0, 0, 1.0]); 
    if np.linalg.norm(x) < 1e-3: x = np.array([1.0, 0, 0])
    x /= np.linalg.norm(x); y = np.cross(ax, x)
    m = np.eye(4); m[:3, 0] = x; m[:3, 1] = y; m[:3, 2] = ax * np.linalg.norm(b - a); m[:3, 3] = (a + b) / 2
    bmesh.ops.transform(bm, matrix=Matrix(m.tolist()), verts=res['verts'])


def build_boot_blender(B, side, top_y=0.232, sole_y=0.02):
    """boot upper from the MakeHuman foot: cap, voxel-remesh (fuses toes), smooth, inflate, cut.
    returns Blender object (open top & bottom loops) in Blender coords"""
    import bmesh
    from mathutils import Vector
    sets = BD.face_sets(B)
    sx = 1 if side == 'Left' else -1
    fs = [fi for fi in B.body_faces if B.vA[B.o['f'][fi], 1].max() < top_y + 0.06 and B.vA[B.o['f'][fi], 0].mean() * sx > 0]
    src, F = BD.submesh(B.o['f'], fs)
    P = B.vA[src].copy()
    ob = bl.make_obj('boot_' + side, P, F)
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.holes_fill(bm, edges=bm.edges[:], sides=0)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data); bm.free()
    r = ob.modifiers.new('rm', 'REMESH'); r.mode = 'VOXEL'; r.voxel_size = 0.007
    s = ob.modifiers.new('sm', 'LAPLACIANSMOOTH'); s.iterations = 20; s.lambda_factor = 1.0; s.use_volume_preserve = True
    d = ob.modifiers.new('dp', 'DISPLACE'); d.strength = 0.0085; d.mid_level = 0.0
    s2 = ob.modifiers.new('sm2', 'SMOOTH'); s2.iterations = 6; s2.factor = 0.5
    bl.apply_mods(ob)
    # square-ish toe box: flatten the top of the forefoot a little, widen the sole area
    sk = B.skel
    A = sk.head[sk.idx[side + 'Foot']]; T = sk.head[sk.idx[side + 'ToeBase']]
    me = ob.data
    co = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', co)
    V = bl.from_bl(co.reshape(-1, 3))
    fw = (V[:, 2] - A[2])
    toe = np.clip((fw - 0.06) / 0.08, 0, 1)
    V[:, 1] = np.where(toe > 0, np.minimum(V[:, 1], 0.02 + (0.085 - 0.03 * toe)) * toe + V[:, 1] * (1 - toe), V[:, 1])
    low = np.clip((0.06 - V[:, 1]) / 0.04, 0, 1)
    c = np.array([A[0], 0, A[2]])
    # foot centre line (heel -> toe) for widening
    cx = A[0] + (T[0] - A[0]) * np.clip(fw / max(T[2] - A[2], 1e-3), 0, 1.3)
    V[:, 0] += (V[:, 0] - cx) * (0.22 * low + 0.1 * toe)
    V[:, 2] += np.clip(fw - 0.12, 0, None) * 0.15 + 0.004 * toe
    me.vertices.foreach_set('co', bl.to_bl(V).reshape(-1))
    me.update()
    bm = bmesh.new(); bm.from_mesh(me)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=Vector((0, 0, top_y)), plane_no=Vector((0, 0, 1)), clear_outer=True)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, plane_co=Vector((0, 0, sole_y)), plane_no=Vector((0, 0, -1)), clear_outer=True)
    bm.to_mesh(me); bm.free()
    me.shade_smooth()
    bl.decimate(ob, 0.12)
    return ob


def boot_sole(ob, lip=0.0035, sole_y=0.02):
    """append a rubber sole slab below the open bottom loop of the boot upper; returns (pos, faces) GL"""
    import bmesh
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bedges = [e for e in bm.edges if e.is_boundary]
    # bottom loop = boundary verts with lowest z
    verts = {v for e in bedges for v in e.verts}
    zmin = min(v.co.z for v in verts)
    loopv = [v for v in verts if v.co.z < zmin + 0.004]
    # order by angle around centroid
    c = np.mean([np.array(v.co) for v in loopv], 0)
    loopv.sort(key=lambda v: np.arctan2(v.co.y - c[1], v.co.x - c[0]))
    L = np.array([bl.from_bl(np.array([v.co]))[0] for v in loopv])
    bm.free()
    cg = L.mean(0)
    rad = L - cg; rad[:, 1] = 0
    rn = rad / np.maximum(np.linalg.norm(rad, axis=1, keepdims=True), 1e-9)
    rings = [L + rn * lip * 0.6 + [0, 0.002, 0], L + rn * lip + [0, -0.004, 0], L + rn * lip * 0.9 + [0, -sole_y + 0.004, 0], L + rn * lip * 0.6 + [0, -sole_y, 0]]
    rings[1][:, 1] = sole_y - 0.004; rings[2][:, 1] = 0.004; rings[3][:, 1] = 0.0
    n = len(L)
    pos = np.concatenate([L] + rings + [np.array([[cg[0], 0.0, cg[2]]])])
    faces = []
    for r in range(4):
        for k in range(n):
            a = r * n + k; b = r * n + (k + 1) % n
            faces.append([a, b, b + n, a + n])
    cen = len(pos) - 1
    for k in range(n):
        faces.append([4 * n + (k + 1) % n, 4 * n + k, cen])
    return pos, faces
