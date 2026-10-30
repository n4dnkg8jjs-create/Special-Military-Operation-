"""Shared finishing pipeline: atlas bake + texture synthesis, LOD1, burnt wreck variants, glTF export."""
import bpy, bmesh, math, os, time, json
import numpy as np
from mathutils import Vector, Matrix
import vlib as L
import vtex as T
from vlib import SLOTS, KINDS, SI

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
OUT = os.path.join(REPO, 'assets', 'vehicles')
CACHE = '/tmp/vehicle_bake_cache'
os.makedirs(CACHE, exist_ok=True)

# --------------------------------------------------------------------------------------------- schemes
# colours are sRGB 0..255 reference swatches (approximations of field-worn paint seen in 2022-24 photos)
SCHEMES = {
    'ru_green': dict(base=(58, 68, 41), base2=(51, 60, 37), camo=None, dust=(138, 127, 106), mud=(66, 56, 44),
                     wear=1.0, dust_amt=1.0, fade=(86, 92, 64)),
    'ua_green': dict(base=(55, 65, 39), base2=(49, 58, 35), camo=[((31, 31, 28), 0.24), ((98, 84, 60), 0.14)],
                     dust=(136, 126, 106), mud=(64, 54, 42), wear=1.15, dust_amt=0.9, fade=(84, 90, 62)),
}

def kind_masks(K):
    ki = T.kind_index(K)
    return {k: (ki == i) for i, k in enumerate(KINDS)}

def compose_paint(d, scheme, decals=None, seed=1):
    """Return albedo (lin), rough, metal, height for the vehicle atlas."""
    t0 = time.time()
    S = SCHEMES[scheme]
    P, N, AO, E, valid = d['P'], d['N'], d['AO'], d['E'], d['valid']
    km = kind_masks(d['K'])
    h, w = valid.shape
    sh = (h, w, 3)
    C = lambda rgb: np.broadcast_to(T.srgb2lin(rgb), sh)
    z = P[..., 2]
    up = N[..., 2]
    ao = np.clip(AO, 0, 1)
    edge = np.clip((1 - E) * 4.0 - 0.15, 0, 1)
    paintable = km['rolled'] | km['cast'] | km['rim'] | km['era'] | km['skirt'] | km['cage']
    # ---------------- base paint
    n_big = T.fbm(P, 0.45, 4, seed)
    col = T.mix(C(S['base']), C(S['base2']), T.sstep(0.3, 0.7, n_big))
    if S['camo']:
        for ci, (c, frac) in enumerate(S['camo']):
            cn = T.fbm(P * np.array([1, 1, 1.4], np.float32), 0.5, 5, seed + 40 + ci * 7)
            thr = T.quantile_thr(cn, frac, valid)
            col = T.mix(col, C(c), T.sstep(thr, thr + 0.01, cn) * 0.96)
    col = col * (0.92 + 0.16 * T.fbm(P, 2.5, 3, seed + 5))[..., None]
    col = col * (0.93 + 0.14 * T.noise3(N * 1.7 + 5.0, 1.0, seed + 60))[..., None]     # per-plate tone (by facing)
    fade = np.clip(up, 0, 1) ** 1.5 * (0.15 + 0.25 * T.fbm(P, 1.1, 3, seed + 3))
    col = T.mix(col, C(S['fade']), fade)
    if decals is not None:
        dm = np.clip(decals(P, N), 0, 1) * paintable
        dm *= T.sstep(0.25, 0.4, T.fbm(P, 30, 2, seed + 50) + 0.25)    # hand-painted, slightly patchy
        col = T.mix(col, C((206, 206, 198)), dm * 0.92)
    rough = 0.6 + 0.1 * (T.fbm(P, 3.0, 3, seed + 6) - 0.5) - 0.12 * fade
    rough = rough.astype(np.float32)
    metal = np.zeros((h, w), np.float32)
    height = np.zeros((h, w), np.float32)
    # ---------------- other kinds
    tyre = km['tyre']
    if tyre.any():
        col[tyre] = T.srgb2lin((40, 40, 38)) * (0.85 + 0.3 * T.fbm(P[tyre], 9, 3, seed + 8))[:, None]
        rough[tyre] = 0.85
    gm = km['gunmetal']
    if gm.any():
        col[gm] = T.srgb2lin((46, 46, 44)) * (0.8 + 0.4 * T.fbm(P[gm], 6, 3, seed + 9))[:, None]
        rough[gm] = 0.45; metal[gm] = 0.7
    bare = km['bare']
    if bare.any():
        col[bare] = T.srgb2lin((88, 84, 78)) * (0.7 + 0.45 * T.fbm(P[bare], 5, 3, seed + 10))[:, None]
        rough[bare] = 0.5; metal[bare] = 0.75
    wood = km['wood']
    if wood.any():
        Pw = P[wood]
        g = T.fbm(Pw * np.array([0.05, 1, 1], np.float32), 30, 3, seed + 11)
        col[wood] = T.mix(np.broadcast_to(T.srgb2lin((96, 76, 54)), (wood.sum(), 3)),
                          np.broadcast_to(T.srgb2lin((52, 40, 30)), (wood.sum(), 3)), T.sstep(0.3, 0.7, g))
        rough[wood] = 0.9
        height[wood] = g * 0.003
    canvas = km['canvas']
    if canvas.any():
        col[canvas] = T.srgb2lin((92, 88, 64)) * (0.8 + 0.35 * T.fbm(P[canvas], 3, 3, seed + 12))[:, None]
        rough[canvas] = 0.95
    rough[km['skirt']] = 0.78
    # ---------------- cavity grime + streaks
    cav = np.clip(1 - ao, 0, 1)
    grime = C((38, 34, 27))
    col = T.mix(col, grime, np.clip(cav ** 1.3 * 0.9, 0, 0.8))
    vert = np.clip(1 - np.abs(up) * 1.4, 0, 1)
    streak = T.fbm(P * np.array([1, 1, 0.07], np.float32), 26, 3, seed + 13)
    streak_m = T.sstep(0.55, 0.72, streak) * vert * T.sstep(0.45, 0.65, T.fbm(P, 1.4, 2, seed + 14)) * paintable
    col = T.mix(col, grime, streak_m * 0.22)
    # ---------------- edge wear: rubbed lighter paint + discrete chips to dark steel
    en = T.fbm(P, 14, 3, seed + 17)
    rub = edge * T.sstep(0.35, 0.65, en) * paintable
    col = T.mix(col, col * 1.35 + 0.01, rub * 0.5)
    chipn = T.fbm(P, 38, 3, seed + 18)
    cthr = T.quantile_thr(chipn, 0.025, valid)
    chip = (T.sstep(cthr, cthr + 0.02, chipn + edge * 0.22 * S['wear']) * paintable).astype(np.float32)
    chip *= T.sstep(0.35, 0.55, T.fbm(P, 3, 2, seed + 30))          # chips cluster
    steel = C((58, 54, 50))
    rust_in = T.sstep(0.45, 0.7, T.fbm(P, 60, 2, seed + 19))
    chipcol = T.mix(steel, C((92, 52, 30)), rust_in * 0.8)
    col = T.mix(col, chipcol, chip * 0.92)
    rough = rough * (1 - chip) + 0.5 * chip
    metal = metal * (1 - chip) + 0.5 * chip * (1 - rust_in)
    height -= chip * 0.00035
    # ---------------- rust streaks below chips / hardware (subtle)
    rs = T.fbm(P * np.array([1, 1, 0.05], np.float32), 50, 3, seed + 15)
    rust_m = T.sstep(0.66, 0.82, rs) * vert * T.sstep(0.6, 0.8, T.fbm(P, 2.0, 3, seed + 16)) * paintable * S['wear']
    col = T.mix(col, C((104, 62, 34)), np.clip(rust_m * 0.4, 0, 1))
    # ---------------- dust & mud
    dn = T.fbm(P, 1.6, 4, seed + 20)
    dn2 = T.fbm(P, 7, 3, seed + 21)
    low = T.sstep(1.35, 0.5, z)
    dust_m = low * (0.35 + 0.55 * dn) + np.clip(up, 0, 1) ** 3 * (0.12 + 0.4 * dn2) + cav * np.clip(up, 0, 1) * 0.5
    wheelish = km['rim'] | tyre
    dust_m = np.where(wheelish, 0.18 + 0.25 * dn2 + cav * 0.35, dust_m)
    dust_m = np.where(gm | wood | canvas, dust_m * 0.4, dust_m)
    dust_m = np.clip(dust_m, 0, 1) * S['dust_amt']
    col = T.mix(col, C(S['dust']), np.clip(dust_m, 0, 1) * 0.62)
    rough = rough * (1 - dust_m * 0.7) + 0.92 * dust_m * 0.7
    metal *= (1 - dust_m)
    mudn = T.fbm(P, 11, 4, seed + 22)
    mud_m = T.sstep(0.95, 0.4, z) * T.sstep(0.5, 0.62, mudn + 0.3 * T.sstep(0.95, 0.3, z))
    mud_m = np.where(wheelish, T.sstep(0.52, 0.62, mudn) * 0.45, mud_m)
    col = T.mix(col, C(S['mud']), mud_m * 0.75)
    rough = rough * (1 - mud_m) + 0.8 * mud_m
    height += mud_m * 0.0008 * mudn
    # ---------------- micro surface
    height += T.fbm(P, 70, 2, seed + 23) * 0.00008
    cast = km['cast']
    if cast.any():
        height[cast] += T.fbm(P[cast], 24, 4, seed + 24) * 0.0012
    if tyre.any():
        height[tyre] += T.fbm(P[tyre], 140, 2, seed + 25) * 0.0002
    if canvas.any():
        Pc = P[canvas]
        height[canvas] += T.fbm(Pc, 7, 3, seed + 26) * 0.005 + T.fbm(Pc, 120, 1, seed + 27) * 0.0003
    col *= (0.62 + 0.38 * ao)[..., None]
    print('  compose paint %.1fs' % (time.time() - t0))
    return col.astype(np.float32), np.clip(rough, 0.05, 1), np.clip(metal, 0, 1), height

def compose_wreck(d, seed=7):
    """Burnt-out look: dark rust browns, soot, fire-bleached grey patches on top, scorched paint low down."""
    P, N, AO, E = d['P'], d['N'], d['AO'], d['E']
    km = kind_masks(d['K'])
    h, w = AO.shape
    sh = (h, w, 3)
    C = lambda rgb: np.broadcast_to(T.srgb2lin(rgb), sh)
    z = P[..., 2]; up = N[..., 2]
    ao = np.clip(AO, 0, 1)
    n1 = T.fbm(P, 3.0, 5, seed)
    n2 = T.fbm(P, 12, 4, seed + 1)
    n3 = T.fbm(P, 40, 3, seed + 6)
    col = T.mix(C((58, 38, 28)), C((104, 56, 32)), T.sstep(0.42, 0.7, n2))            # rust browns
    col = T.mix(col, C((126, 70, 36)), T.sstep(0.62, 0.72, n3) * 0.5)                  # fresh orange rust flecks
    col = T.mix(col, C((24, 21, 19)), T.sstep(0.5, 0.64, n1) * 0.75)                   # soot
    baked = T.sstep(0.52, 0.66, T.fbm(P, 2.2, 4, seed + 2)) * np.clip(up, 0, 1) ** 1.5
    col = T.mix(col, C((128, 124, 116)), baked * 0.6)                                  # ash / bleached paint
    surv = T.sstep(0.75, 0.45, z) * T.sstep(0.48, 0.6, T.fbm(P, 4, 3, seed + 3))
    col = T.mix(col, C((58, 60, 46)), surv * 0.55)                                     # scorched paint low down
    st = T.fbm(P * np.array([1, 1, 0.08], np.float32), 16, 3, seed + 4)
    col = T.mix(col, C((22, 19, 17)), T.sstep(0.55, 0.7, st) * np.clip(1 - np.abs(up), 0, 1) * 0.5)
    col = col * (0.85 + 0.3 * n3)[..., None]
    tyre = km['tyre']
    if tyre.any():
        col[tyre] = T.srgb2lin((22, 21, 20)) + T.srgb2lin((70, 68, 64)) * T.sstep(0.55, 0.75, n2[tyre])[:, None]
    col *= (0.5 + 0.5 * ao)[..., None]
    rough = np.clip(0.8 + 0.18 * n2, 0, 1).astype(np.float32)
    metal = np.clip(0.25 * T.sstep(0.6, 0.4, n1) * (1 - baked), 0, 1).astype(np.float32)
    height = T.fbm(P, 40, 3, seed + 5) * 0.0012
    return col.astype(np.float32), rough, metal, height

# --------------------------------------------------------------------------------------------- materials
def simple_materials():
    glass = T.principled('glass', color=(0.015, 0.02, 0.022), rough=0.06, metal=0.0)
    light = T.principled('light_lens', color=(0.55, 0.55, 0.5), rough=0.08, metal=0.1)
    return glass, light

def write_tex(name, arr, valid, fmt, colorspace, path):
    if valid is not None:
        arr = T.dilate(arr, valid)
    img = T.to_image(name, arr, colorspace=colorspace)
    if colorspace == 'sRGB':
        # Blender expects linear float for sRGB-tagged float buffers? we wrote 8-bit image: give sRGB values
        pass
    T.save_png_jpg(img, path, fmt)
    return img

def atlas_textures(prefix, d, scheme, decals=None, size_alb=2048, size_aux=1024, wreck=True):
    valid = d['valid']
    col, rough, metal, height = compose_paint(d, scheme, decals)
    alb = T.lin2srgb(col)
    nrm = T.height_to_normal(height, d['P'], valid, N=d['N'])
    orm = np.stack([np.ones_like(rough), rough, metal], -1)
    import scipy.ndimage as nd
    def down(a, s):
        if a.shape[0] == s:
            return a
        f = s / a.shape[0]
        return nd.zoom(a, (f, f, 1), order=1)
    v_aux = nd.zoom(valid.astype(np.float32), size_aux / valid.shape[0], order=0) > 0.5
    imgs = {}
    imgs['alb'] = write_tex(prefix + '_albedo', down(alb, size_alb), None if size_alb != valid.shape[0] else valid,
                            'JPEG', 'sRGB', f'{CACHE}/{prefix}_albedo.jpg')
    imgs['orm'] = write_tex(prefix + '_orm', down(T.dilate(orm, valid), size_aux), None, 'PNG', 'Non-Color',
                            f'{CACHE}/{prefix}_orm.png')
    imgs['nrm'] = write_tex(prefix + '_normal', down(T.dilate(nrm, valid), size_aux), None, 'PNG', 'Non-Color',
                            f'{CACHE}/{prefix}_normal.png')
    if wreck:
        wc, wr, wm, wh = compose_wreck(d)
        imgs['w_alb'] = write_tex(prefix + '_wreck_albedo', down(T.dilate(T.lin2srgb(wc), valid), 1024), None,
                                  'JPEG', 'sRGB', f'{CACHE}/{prefix}_wreck_albedo.jpg')
        worm = np.stack([np.ones_like(wr), wr, wm], -1)
        imgs['w_orm'] = write_tex(prefix + '_wreck_orm', down(T.dilate(worm, valid), 512), None, 'PNG', 'Non-Color',
                                  f'{CACHE}/{prefix}_wreck_orm.png')
    return imgs

# --------------------------------------------------------------------------------------------- LOD / wreck
def make_lod1(ob, ratio=0.28):
    me = ob.data.copy()
    me.name = ob.data.name + '_LOD1'
    tmp = L.link(bpy.data.objects.new('_lod', me))
    m = tmp.modifiers.new('dec', 'DECIMATE')
    m.decimate_type = 'COLLAPSE'; m.ratio = ratio; m.use_collapse_triangulate = True
    with bpy.context.temp_override(object=tmp, active_object=tmp):
        bpy.ops.object.modifier_apply(modifier='dec')
    bpy.data.objects.remove(tmp)
    me.validate(clean_customdata=False)
    lod = L.link(bpy.data.objects.new(ob.name + '_LOD1', me))
    lod.parent = ob.parent
    lod.matrix_parent_inverse = ob.matrix_parent_inverse.copy()
    lod.location = ob.location
    lod['hidden'] = True
    lod['lod'] = 1
    return lod

def join_copies(name, objs, parent, origin_world, drop_slots=(), drop_z=0.0, jitter=0.0, seed=3, decimate=0.45):
    """Join world-space copies of objs into one mesh object parented to `parent` with origin at origin_world."""
    bm = bmesh.new()
    for o in objs:
        me = o.data
        nv = len(bm.verts)
        nf = len(bm.faces)
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
        M = Matrix.Translation(-Vector(origin_world)) @ o.matrix_world
        bmesh.ops.transform(bm, matrix=M, verts=bm.verts[nv:])
    if drop_slots:
        ids = {SI[s] for s in drop_slots}
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in ids], context='FACES')
    if drop_z:
        bmesh.ops.translate(bm, vec=(0, 0, -drop_z), verts=bm.verts)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for s in SLOTS:
        me.materials.append(bpy.data.materials.get('S_' + s))
    # need material indices consistent: source meshes were already remapped? -> we join BEFORE remap
    ob = L.link(bpy.data.objects.new(name, me))
    ob.parent = parent
    ob.location = Vector(origin_world) - (parent.matrix_world.translation if parent else Vector())
    if decimate and decimate < 1:
        # protect the track bands (long U-scrolling UVs get mangled by collapse decimation)
        tid = SI['track']
        keep = sorted({v for p in me.polygons if p.material_index == tid for v in p.vertices})
        m = ob.modifiers.new('dec', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'; m.ratio = decimate; m.use_collapse_triangulate = True
        if keep:
            vg = ob.vertex_groups.new(name='keep')
            vg.add(keep, 1.0, 'REPLACE')
            m.vertex_group = 'keep'; m.invert_vertex_group = True; m.vertex_group_factor = 1000.0
        with bpy.context.temp_override(object=ob, active_object=ob):
            bpy.ops.object.modifier_apply(modifier='dec')
        me.validate(clean_customdata=False)
    return ob

# --------------------------------------------------------------------------------------------- export
def export(root, path):
    bpy.ops.object.select_all(action='DESELECT')
    for o in [root] + list(root.children_recursive):
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_extras=True,
                              export_yup=True, export_apply=False, export_tangents=False,
                              export_image_format='AUTO', export_materials='EXPORT', export_animations=False,
                              export_cameras=False, export_lights=False, export_vertex_color='NONE',
                              export_texcoords=True, export_normals=True)
    print('exported', path, '%.2f MB' % (os.path.getsize(path) / 1e6))

def stats(root):
    out = {}
    for o in [root] + list(root.children_recursive):
        if o.type == 'MESH':
            out[o.name] = L.tri_count(o)
    return out

# --------------------------------------------------------------------------------------------- finalize
def finalize(d, name, scheme, decals=None, wreck_fn=None, lod_ratio=0.3, track_mats=None, out=None):
    t0 = time.time()
    root = d['root']
    glass, light = simple_materials()
    T.atlas_unwrap(d['atlas'])
    print('  unwrap done %.1fs' % (time.time() - t0))
    data = T.bake_inputs(d['atlas'], 2048, 1024)
    print('  bakes done %.1fs' % (time.time() - t0))
    imgs = atlas_textures(name, data, scheme, decals)
    print('  textures done %.1fs' % (time.time() - t0))
    paint = T.principled(name + '_paint', imgs['alb'], imgs['orm'], imgs['nrm'])
    wreckm = T.principled(name + '_wreck', imgs['w_alb'], imgs['w_orm'], imgs['nrm'])
    tm, tw = track_mats if track_mats else (None, None)
    wobjs = wreck_fn(d) if wreck_fn else []
    mp = {k: paint for k in KINDS}
    mp.update(glass=glass, light=light, track=tm)
    done = set()
    for o in d['lod0']:
        if o.data.name in done:
            continue
        T.remap_slots(o, mp)
        done.add(o.data.name)
    wm = {k: wreckm for k in KINDS}
    wm.update(glass=wreckm, light=wreckm, track=tw)
    for o in wobjs:
        T.remap_slots(o, wm)
        o['hidden'] = True
    # LOD1 (shared meshes decimated once)
    lodmesh = {}
    lods = []
    for o in d['lod0']:
        key = o.data.name
        if key in lodmesh:
            lo = L.link(bpy.data.objects.new(o.name + '_LOD1', lodmesh[key]))
            lo.parent = o.parent; lo.location = o.location; lo['hidden'] = True; lo['lod'] = 1
        else:
            lo = make_lod1(o, lod_ratio)
            lodmesh[key] = lo.data
        lods.append(lo)
    for o in wobjs:
        pass
    # bounding boxes (export frame -> glTF: x, z, -y)
    def bbox(objs):
        import mathutils
        pts = []
        for o in objs:
            for c in o.bound_box:
                w = o.matrix_world @ mathutils.Vector(c)
                pts.append((w.x, w.z, -w.y))
        a = np.array(pts)
        return [np.round(a.min(0), 3).tolist(), np.round(a.max(0), 3).tolist()]
    bboxes = {o.name: bbox([o]) for o in d['lod0']}
    bb_all = bbox(d['lod0'])
    out = out or os.path.join(OUT, name + '.glb')
    export(root, out)
    st = stats(root)
    lod0 = sum(L.tri_count(o) for o in d['lod0'])
    lod1 = sum(L.tri_count(o) for o in lods)
    wr = {o.name: L.tri_count(o) for o in wobjs}
    print('  LOD0 tris', lod0, 'LOD1 tris', lod1, 'wreck', wr, '%.1fs' % (time.time() - t0))
    def tree(o):
        r = {'name': o.name, 'type': 'mesh' if o.type == 'MESH' else 'empty'}
        if o.get('hidden'):
            r['hidden'] = True
        if o.type == 'MESH':
            r['tris'] = L.tri_count(o)
        t = o.matrix_world.translation
        r['pos'] = [round(t.x, 3), round(t.z, 3), round(-t.y, 3)]
        ch = sorted(o.children, key=lambda c: c.name)
        if ch:
            r['children'] = [tree(c) for c in ch]
        return r
    info = dict(lod0_tris=lod0, lod1_tris=lod1, wreck_tris=wr, file_mb=round(os.path.getsize(out) / 1e6, 2),
                bbox_lod0=bb_all, node_bboxes=bboxes, hierarchy=tree(root),
                materials=sorted({m.name for o in [root] + list(root.children_recursive) if o.type == 'MESH' for m in o.data.materials if m}))
    with open(os.path.join(CACHE, name + '_info.json'), 'w') as f:
        json.dump(info, f, indent=1)
    return info
