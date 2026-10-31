"""Builds assets/env/farmland.glb: Ukrainian steppe farmland set for src/world/farmland.js -- windbreak trees +
far LODs, crops, kolkhoz farm buildings and machinery, village yard props, earthworks.
Two materials: farmland_atlas (2048^2 opaque, farmland_atlas.py) and farmland_foliage (2048^2 RGBA alpha MASK 0.5,
double sided, farmland_foliage.py).  Node names = asset ids, origin = ground centre of the footprint, +Y up, metres.
Run:  cd tools/blender/env && nice -n 10 python3 build_farmland.py            -> assets/env/farmland.glb (+ manifest)
      python3 build_farmland.py tree_ bush_                                -> previews/_test/farmland_test.glb (subset)
      COMPARE=1 python3 build_farmland.py tree_acacia_leafy                -> subset + leafy_summer_chestnut/birch from trees.glb
      REBUILD_ATLAS=1 ...  repaints both atlases (otherwise cached in _cache/).
"""
import os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import bpy
from meshlib import reset_scene, make_material, update_manifest, REPO, MB
import farmland_atlas as FA
import farmland_foliage as FF
import farmland_trees as FT
import farmland_geo as FG

BUDGET = {'tree_': 5000, 'bush_': 2000, 'sunflower': 250, 'corn': 250, 'weeds': 250, 'barn_': 12000, '_lod1': 300}


def atlases():
    a = [os.path.join(FA.CACHE, f'farmland_atlas_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    if not all(os.path.exists(p) for p in a) or os.environ.get('REBUILD_ATLAS'):
        a = FA.build()
    f = FF.cache_paths()
    if not all(os.path.exists(p) for p in f) or os.environ.get('REBUILD_ATLAS'):
        alb, al, hh = FF.build_base(); f = FF.save(alb, al, hh)
    return a, f


def to_blender(mb, mats, loc):
    used = sorted(set(f[3] for f in mb.F))
    ob = mb.to_object(mb.name, mats, smooth_angle=40, location=loc)
    me = ob.data
    VN = getattr(mb, 'VN', None) or {}
    VC = getattr(mb, 'VC', None) or {}
    if VN:
        loops = []
        for f in mb.F:
            for vi in f[0]:
                n = VN.get(vi)
                loops.append((n[0], -n[2], n[1]) if n is not None else (0.0, 0.0, 0.0))
        # custom normals only take effect on smooth faces
        sm = [bool(f[2]) or f[0][0] in VN for f in mb.F]
        me.polygons.foreach_set('use_smooth', sm)
        me.normals_split_custom_set(loops)
    if VC:
        ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'CORNER')
        cols = []
        for f in mb.F:
            for vi in f[0]:
                c = mb.VC.get(vi)
                cols += [float(c[0]), float(c[1]), float(c[2]), 1.0] if c is not None else [1.0, 1.0, 1.0, 1.0]
        ca.data.foreach_set('color', cols)
        me.color_attributes.active_color = ca
    # drop unused material slots (keeps glTF primitives to what is used)
    if len(used) == 1 and used[0] == 0 and len(me.materials) > 1:
        me.materials.pop(index=1)
    return ob


def items():
    return FT.vegetation() + FG.all_items()


def main(only=None):
    a, f = atlases()
    reset_scene()
    m_atlas = make_material('farmland_atlas', *a)
    m_fol = make_material('farmland_foliage', *f, alpha_clip=0.5, double=True)
    its = items()
    if only:
        its = [m for m in its if any(m.name.startswith(o) if not o.endswith('$') else m.name == o[:-1] for o in only)]
    info = {}
    x = 0.0; zrow = 0.0; rowdepth = 0.0
    for mb in its:
        mn, mx = mb.bounds(); sz = mx - mn
        if x + sz[0] > 90:
            x = 0.0; zrow -= rowdepth + 4; rowdepth = 0.0
        loc = (x - mn[0], 0, zrow - mx[2])
        x += sz[0] + 3; rowdepth = max(rowdepth, sz[2])
        ob = to_blender(mb, [m_atlas, m_fol], loc)
        # top-level empty carries the asset name; the mesh is its child. KHR_mesh_quantization (gltf-transform quantize)
        # writes the dequantisation scale/offset onto the *mesh* node, which farmland.js instancing then keeps
        # (it only strips the template root's own transform).
        ob.name = mb.name + '_geo'; ob.data.name = mb.name
        e = bpy.data.objects.new(mb.name, None); bpy.context.scene.collection.objects.link(e)
        e.location = ob.location.copy(); ob.parent = e; ob.location = (0, 0, 0)
        info[mb.name] = {'tris': mb.tris(), 'size': [round(float(v), 2) for v in sz],
                         'bbox_min': [round(float(v), 2) for v in mn], 'bbox_max': [round(float(v), 2) for v in mx]}
        lim = next((v for k, v in BUDGET.items() if k in mb.name), 8000)
        print(f'{mb.name:28s} {mb.tris():6d} tris  size {np.round(sz, 2)}{"  OVER BUDGET" if mb.tris() > lim else ""}')
    if os.environ.get('COMPARE'):
        # rebuild the city leafy trees in-process (same code/seeds as build_trees.py) for side-by-side QA
        import build_trees as BT
        BT.bark_textures(); BT.leaf_texture()
        bm = {sp: make_material('bark_' + sp, *BT.TEX['bark_' + sp]) for sp in ('chestnut', 'birch')}
        wm = make_material('wood_splintered', *BT.TEX['wood_inner'])
        lm = make_material('leaves_late_summer', *BT.TEX['leaves'], alpha_clip=0.5, double=True)
        for k, (nm, sp, seed, h) in enumerate((('leafy_summer_chestnut', 'chestnut', 7, 11.5), ('leafy_summer_birch', 'birch', 8, 12.5))):
            BT.tree(nm, sp, seed, h, stripped=False, leafy=True).to_object(nm, [bm[sp], wm, lm], smooth_angle=70, location=(-9 - 10 * k, 0, 4))
    out = os.path.join(REPO, 'assets', 'env', 'farmland.glb') if not only else os.path.join(REPO, 'previews', '_test', 'farmland_test.glb')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, export_apply=True, export_image_format='AUTO',
                              export_materials='EXPORT', export_cameras=False, export_lights=False, export_texcoords=True,
                              export_normals=True, export_vertex_color='ACTIVE', export_all_vertex_colors=False)
    print(os.path.basename(out), round(os.path.getsize(out) / 1e6, 2), 'MB')
    if not only:
        update_manifest('farmland', manifest_section(info))
    return info


def manifest_section(info):
    return {'file': 'farmland.glb', 'nodes': info, 'notes': FG.NOTES, 'refs': FG.REFS}


if __name__ == '__main__':
    import time; t0 = time.time()
    main(sys.argv[1:] or None)
    print('done', round(time.time() - t0, 1), 's')
