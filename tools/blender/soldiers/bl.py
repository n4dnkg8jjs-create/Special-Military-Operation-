"""Thin bpy helpers: numpy <-> Blender mesh, decimate, seam-based unwrap, extraction to GL arrays.
Blender is Z-up; we keep our own Y-up data and convert (x, y, z)_gl -> (x, -z, y)_blender on the way in.
"""
import numpy as np
import bpy, bmesh


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def to_bl(p):
    p = np.asarray(p, float)
    return np.stack([p[:, 0], -p[:, 2], p[:, 1]], 1)


def from_bl(p):
    p = np.asarray(p, float)
    return np.stack([p[:, 0], p[:, 2], -p[:, 1]], 1)


def make_obj(name, V, faces, attrs=None, face_attrs=None, uv=None, smooth=True):
    """V in GL coords; faces list/array of index lists; attrs: dict name->(n,k) float point attrs."""
    me = bpy.data.meshes.new(name)
    me.from_pydata(to_bl(V).tolist(), [], [list(map(int, f)) for f in faces])
    me.update()
    if attrs:
        for k, a in attrs.items():
            a = np.asarray(a, np.float32)
            if a.ndim == 1:
                at = me.attributes.new(k, 'FLOAT', 'POINT'); at.data.foreach_set('value', a)
            else:
                for c in range(a.shape[1]):
                    at = me.attributes.new(f'{k}_{c}', 'FLOAT', 'POINT'); at.data.foreach_set('value', a[:, c].copy())
    if face_attrs:
        for k, a in face_attrs.items():
            at = me.attributes.new(k, 'INT', 'FACE'); at.data.foreach_set('value', np.asarray(a, np.int32))
    if uv is not None:
        # uv: per-loop array
        lay = me.uv_layers.new(name='UVMap')
        lay.data.foreach_set('uv', np.asarray(uv, np.float32).reshape(-1))
    if smooth:
        me.shade_smooth()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for m in list(bpy.data.meshes):
        bpy.data.meshes.remove(m)


def activate(ob):
    for o in bpy.context.view_layer.objects:
        if o is not None:
            o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)


def apply_mods(ob):
    activate(ob)
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def decimate(ob, ratio, sym=False):
    m = ob.modifiers.new('dec', 'DECIMATE')
    m.decimate_type = 'COLLAPSE'; m.ratio = ratio
    if sym:
        m.use_symmetry = True; m.symmetry_axis = 'X'
    apply_mods(ob)


def unwrap_with_labels(ob, face_label, margin=0.004, method='ANGLE_BASED'):
    """mark seams between faces of different labels and unwrap + pack"""
    me = ob.data
    bm = bmesh.new(); bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    lab = np.asarray(face_label)
    for e in bm.edges:
        fs = e.link_faces
        if len(fs) == 2 and lab[fs[0].index] != lab[fs[1].index]:
            e.seam = True
        elif len(fs) < 2:
            e.seam = True
    bm.to_mesh(me); bm.free()
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    activate(ob)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.unwrap(method=method, margin=margin)
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(margin=margin, rotate=True)
    bpy.ops.object.mode_set(mode='OBJECT')


def smart_uv(ob, angle=66, margin=0.01):
    activate(ob)
    if not ob.data.uv_layers:
        ob.data.uv_layers.new(name='UVMap')
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=np.radians(angle), island_margin=margin)
    bpy.ops.object.mode_set(mode='OBJECT')


def extract(ob, attrs=(), split_normals=True, apply=True):
    """Return GL arrays: pos, nrm, uv, tri, plus point attrs (split per GL vertex) and face attrs per tri.
    One GL vertex per unique (vertex, uv, normal)."""
    if apply:
        dg = bpy.context.evaluated_depsgraph_get()
        oe = ob.evaluated_get(dg)
        me = oe.to_mesh()
    else:
        me = ob.data
    me.calc_loop_triangles()
    nv = len(me.vertices); nl = len(me.loops)
    co = np.zeros(nv * 3, np.float32); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    lv = np.zeros(nl, np.int32); me.loops.foreach_get('vertex_index', lv)
    ln = np.zeros(nl * 3, np.float32)
    me.corner_normals.foreach_get('vector', ln)
    ln = ln.reshape(-1, 3)
    if me.uv_layers:
        luv = np.zeros(nl * 2, np.float32); me.uv_layers.active.data.foreach_get('uv', luv); luv = luv.reshape(-1, 2)
    else:
        luv = np.zeros((nl, 2), np.float32)
    nt = len(me.loop_triangles)
    tl = np.zeros(nt * 3, np.int32); me.loop_triangles.foreach_get('loops', tl); tl = tl.reshape(-1, 3)
    tp = np.zeros(nt, np.int32); me.loop_triangles.foreach_get('polygon_index', tp)
    key = np.concatenate([lv[:, None].astype(np.float64), np.round(luv, 5), np.round(ln, 3) if split_normals else np.zeros((nl, 1))], 1)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    pos = from_bl(co[lv[first]])
    nrm = from_bl(ln[first])
    uv = luv[first].copy(); uv[:, 1] = 1 - uv[:, 1]  # glTF v down
    tri = inv[tl]
    out = dict(pos=pos, nrm=nrm, uv=uv, tri=tri, src=lv[first], poly=tp)
    for a in attrs:
        names = [k for k in me.attributes.keys() if k == a or k.startswith(a + '_')]
        names = sorted(names, key=lambda s: int(s.rsplit('_', 1)[1]) if s != a and s.rsplit('_', 1)[1].isdigit() else -1)
        cols = []
        for k in names:
            at = me.attributes[k]
            buf = np.zeros(len(at.data), np.float32 if at.data_type == 'FLOAT' else np.int32)
            at.data.foreach_get('value', buf)
            cols.append(buf)
        arr = np.stack(cols, 1)
        dom = me.attributes[names[0]].domain
        out[a] = arr[lv[first]] if dom == 'POINT' else arr[tp]
    if apply:
        oe.to_mesh_clear()
    return out
