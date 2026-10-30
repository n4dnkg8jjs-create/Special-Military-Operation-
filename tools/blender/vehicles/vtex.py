"""Atlas UVs, Cycles data bakes (position / normal / AO / edge / kind) and numpy texture synthesis.

Pipeline: every atlas object is smart-unwrapped into one 0..1 atlas, Cycles bakes *data* maps once
(world position, world normal, ambient occlusion + bevel-node edge mask + material kind), and all
look-dependent textures (paint, chipping, dust, mud, rust streaks, burnt wreck, height->normal) are
then synthesised in numpy from those maps, so restyling never needs another bake.
"""
import bpy, bmesh, math, time, os
import numpy as np
from scipy import ndimage
from vlib import SLOTS, KINDS, SI, kind_value, link

# --------------------------------------------------------------------------------------------- noise
_GRID = {}
def _grid(seed, n=64):
    k = (seed, n)
    if k not in _GRID:
        r = np.random.default_rng(seed)
        g = r.random((n, n, n)).astype(np.float32)
        _GRID[k] = g
    return _GRID[k]

def noise3(P, freq, seed=0, n=64):
    """Value noise in [0,1], trilinear, periodic every n/freq metres. P: (...,3)."""
    g = _grid(seed, n)
    f = np.asarray(freq, np.float32)
    c = (P * f).reshape(-1, 3).T
    out = ndimage.map_coordinates(g, c, order=1, mode='grid-wrap', prefilter=False)
    return out.reshape(P.shape[:-1])

def fbm(P, freq, octaves=4, seed=0, gain=0.5, lac=2.03):
    s = 0.0; a = 1.0; tot = 0.0
    f = np.asarray(freq, np.float32)
    for o in range(octaves):
        s = s + a * noise3(P, f, seed + o * 17)
        tot += a; a *= gain; f = f * lac
    return s / tot

def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)

def mix(a, b, t):
    t = t[..., None] if np.ndim(t) == np.ndim(a) - 1 else t
    return a * (1 - t) + b * t

def srgb2lin(c):
    c = np.asarray(c, np.float32) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def lin2srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)

# --------------------------------------------------------------------------------------------- UV
def atlas_unwrap(objs, margin=0.0025, angle=60):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(udim_source='CLOSEST_UDIM', rotate=True, margin_method='FRACTION',
                            margin=margin, shape_method='AABB')
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')

def scale_uv_islands(ob, slot_names, factor):
    """Scale UVs of faces using given slots around their island centre (e.g. give tyres less space)."""
    pass

# --------------------------------------------------------------------------------------------- bakes
def _set_pass(pass_name):
    """Configure every S_<slot> material for a data pass."""
    for s in SLOTS:
        m = bpy.data.materials.get('S_' + s)
        if m is None:
            continue
        m.use_nodes = True
        nt = m.node_tree
        img_node = nt.nodes.get('bake_target')
        img = img_node.image if img_node else None
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        em = nt.nodes.new('ShaderNodeEmission')
        nt.links.new(em.outputs[0], out.inputs[0])
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        if pass_name == 'POS':
            nt.links.new(geo.outputs['Position'], em.inputs['Color'])
        elif pass_name == 'NRM':
            vm = nt.nodes.new('ShaderNodeVectorMath'); vm.operation = 'MULTIPLY_ADD'
            vm.inputs[1].default_value = (0.5, 0.5, 0.5); vm.inputs[2].default_value = (0.5, 0.5, 0.5)
            nt.links.new(geo.outputs['Normal'], vm.inputs[0]); nt.links.new(vm.outputs[0], em.inputs['Color'])
        elif pass_name == 'AOE':
            ao = nt.nodes.new('ShaderNodeAmbientOcclusion'); ao.samples = 12; ao.inputs['Distance'].default_value = 0.45
            bev = nt.nodes.new('ShaderNodeBevel'); bev.samples = 6; bev.inputs['Radius'].default_value = 0.012
            dot = nt.nodes.new('ShaderNodeVectorMath'); dot.operation = 'DOT_PRODUCT'
            nt.links.new(bev.outputs[0], dot.inputs[0]); nt.links.new(geo.outputs['Normal'], dot.inputs[1])
            comb = nt.nodes.new('ShaderNodeCombineColor')
            nt.links.new(ao.outputs['AO'], comb.inputs[0]); nt.links.new(dot.outputs['Value'], comb.inputs[1])
            k = kind_value(s) if s in KINDS else 0.99
            comb.inputs[2].default_value = k
            nt.links.new(comb.outputs[0], em.inputs['Color'])
        tn = nt.nodes.new('ShaderNodeTexImage'); tn.name = 'bake_target'; tn.image = img
        nt.nodes.active = tn

def _target(img):
    for s in SLOTS:
        m = bpy.data.materials.get('S_' + s)
        if m is None:
            continue
        tn = m.node_tree.nodes.get('bake_target')
        tn.image = img
        m.node_tree.nodes.active = tn

def _bake(objs, img, samples):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    sc.render.threads_mode = 'FIXED'; sc.render.threads = 2
    sc.render.bake.margin = 6
    sc.render.bake.margin_type = 'EXTEND'
    sc.render.bake.use_clear = True
    _target(img)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.bake(type='EMIT')

def _arr(img):
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)

def bake_inputs(objs, size=2048, aosize=1024, cache=None, occluders=()):
    """Returns dict with P (h,w,3) world pos [export frame], N, AO, E, K (upsampled), valid mask."""
    if cache and os.path.exists(cache):
        d = dict(np.load(cache))
        return d
    for o in objs:
        for s in SLOTS:
            pass
    for s in SLOTS:
        m = bpy.data.materials.get('S_' + s)
        if m:
            m.use_nodes = True
    t = time.time()
    out = {}
    for name, sz, smp, fl in (('POS', size, 1, True), ('NRM', size, 1, True), ('AOE', aosize, 3, False)):
        img = bpy.data.images.new('_bake_' + name, sz, sz, alpha=True, float_buffer=fl)
        img.colorspace_settings.name = 'Non-Color'
        img.generated_color = (0, 0, 0, 0)
        _set_pass(name)
        _bake(objs, img, smp)
        out[name] = _arr(img)
        bpy.data.images.remove(img)
        print('  bake', name, sz, '%.1fs' % (time.time() - t))
    P = out['POS'][..., :3]
    valid = out['POS'][..., 3] > 0.5
    N = out['NRM'][..., :3] * 2 - 1
    aoe = out['AOE']
    zoom = size / aosize
    up = lambda c: ndimage.zoom(c, zoom, order=1)
    AO = up(aoe[..., 0]); E = up(aoe[..., 1])
    K = ndimage.zoom(aoe[..., 2], zoom, order=0)
    # kind is better taken at full res: nearest from low res is fine away from seams
    d = dict(P=P.astype(np.float32), N=N.astype(np.float32), AO=AO.astype(np.float32),
             E=E.astype(np.float32), K=K.astype(np.float32), valid=valid)
    if cache:
        np.savez(cache, **d)
    return d

def kind_index(K):
    return np.clip(np.floor(K * 16).astype(np.int32), 0, 15)

# --------------------------------------------------------------------------------------------- images
def to_image(name, arr, alpha=None, colorspace='sRGB', linear_input=True):
    """arr (h,w,3) in linear (colour) or raw (data) values; Blender pixel order (row0 = v0)."""
    h, w = arr.shape[:2]
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, w, h, alpha=alpha is not None)
    img.colorspace_settings.name = colorspace
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = arr
    if alpha is not None:
        rgba[..., 3] = alpha
    img.pixels.foreach_set(rgba.ravel())
    img.update()
    return img

def save_png_jpg(img, path, fmt):
    img.filepath_raw = path
    img.file_format = fmt
    if fmt == 'JPEG':
        bpy.context.scene.render.image_settings.quality = 88
    img.save()
    img.reload()
    img.pack()

def dilate(arr, valid, n=8):
    """Fill invalid texels with nearest valid value."""
    if valid.all():
        return arr
    idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
    return arr[idx[0], idx[1]]

def height_to_normal(Hm, P, valid, strength=1.0, N=None):
    """Height in metres -> tangent-space normal (OpenGL, +Y = +V). Uses world texel size from P."""
    dPu = np.zeros(P.shape[:2], np.float32); dPv = np.zeros_like(dPu)
    du = np.linalg.norm(P[:, 1:] - P[:, :-1], axis=-1)
    dv = np.linalg.norm(P[1:, :] - P[:-1, :], axis=-1)
    med = np.median(du[valid[:, 1:] & valid[:, :-1]])
    hx = np.zeros_like(Hm); hy = np.zeros_like(Hm)
    okx = valid[:, 1:] & valid[:, :-1] & (du < med * 2.2) & (du > 1e-7)
    oky = valid[1:, :] & valid[:-1, :] & (dv < med * 2.2) & (dv > 1e-7)
    if N is not None:
        okx &= (N[:, 1:] * N[:, :-1]).sum(-1) > 0.97
        oky &= (N[1:, :] * N[:-1, :]).sum(-1) > 0.97
    gx = np.where(okx, (Hm[:, 1:] - Hm[:, :-1]) / np.maximum(du, 1e-7), 0)
    gy = np.where(oky, (Hm[1:, :] - Hm[:-1, :]) / np.maximum(dv, 1e-7), 0)
    hx[:, :-1] += gx; hx[:, 1:] += gx; hx *= 0.5
    hy[:-1, :] += gy; hy[1:, :] += gy; hy *= 0.5
    n = np.stack([-hx * strength, -hy * strength, np.ones_like(Hm)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5

# --------------------------------------------------------------------------------------------- materials
def principled(name, albedo=None, orm=None, normal=None, color=(0.5, 0.5, 0.5), rough=0.6, metal=0.0,
               alpha_clip=False, normal_strength=1.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bs = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bs.outputs[0], out.inputs[0])
    bs.inputs['Base Color'].default_value = (*color, 1)
    bs.inputs['Roughness'].default_value = rough
    bs.inputs['Metallic'].default_value = metal
    if albedo:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = albedo
        nt.links.new(t.outputs['Color'], bs.inputs['Base Color'])
        if alpha_clip:
            nt.links.new(t.outputs['Alpha'], bs.inputs['Alpha'])
            m.blend_method = 'CLIP' if hasattr(m, 'blend_method') else None
    if orm:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = orm
        sp = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(t.outputs['Color'], sp.inputs[0])
        nt.links.new(sp.outputs[1], bs.inputs['Roughness'])
        nt.links.new(sp.outputs[2], bs.inputs['Metallic'])
    if normal:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = normal
        nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = normal_strength
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs[0], bs.inputs['Normal'])
    return m

def remap_slots(ob, mapping):
    """mapping: slot name -> material (or None = keep S_ slot).  Collapses identical materials."""
    me = ob.data
    n = len(me.polygons)
    idx = np.empty(n, np.int32)
    me.polygons.foreach_get('material_index', idx)
    mats = []
    new_idx_for_slot = {}
    for i, s in enumerate(SLOTS):
        m = mapping.get(s)
        if m is None:
            continue
        if m not in mats:
            mats.append(m)
        new_idx_for_slot[i] = mats.index(m)
    used = np.unique(idx)
    lut = np.zeros(len(SLOTS), np.int32)
    for i in range(len(SLOTS)):
        lut[i] = new_idx_for_slot.get(i, 0)
    new = lut[idx]
    # drop unused materials
    keep = sorted(set(new.tolist()))
    remap = {k: j for j, k in enumerate(keep)}
    new = np.array([remap[k] for k in new], np.int32) if n else new
    me.materials.clear()
    for k in keep:
        me.materials.append(mats[k])
    me.polygons.foreach_set('material_index', new)
    me.update()

def decal_mask(P, N, center, normal, up, shape):
    """Planar decal: shape(u, v) -> mask, u/v metres in the decal plane (u = right, v = up)."""
    c = np.asarray(center, np.float32); n = np.asarray(normal, np.float32); n /= np.linalg.norm(n)
    upv = np.asarray(up, np.float32); upv = upv - n * upv.dot(n); upv /= np.linalg.norm(upv)
    rt = np.cross(upv, n)
    d = P - c
    u = d @ rt; v = d @ upv; w = d @ n
    facing = (N @ n) > 0.75
    near = np.abs(w) < 0.12
    return shape(u, v) * facing * near

def cross_shape(arm, half_w):
    def f(u, v):
        a = (np.abs(u) < arm) & (np.abs(v) < half_w)
        b = (np.abs(v) < arm) & (np.abs(u) < half_w)
        return (a | b).astype(np.float32)
    return f

def quantile_thr(x, frac, mask=None):
    """threshold so that `frac` of (masked) values lie above it."""
    v = x[mask] if mask is not None else x.ravel()
    if v.size > 400000:
        v = v[:: v.size // 400000]
    return float(np.quantile(v, 1 - frac))
