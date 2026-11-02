"""Builds assets/env/modern.glb: a Soviet microdistrict as it looks in Ukraine 2022-24 (renovated, then war-damaged) --
kindergarten, boiler house, supermarket, pharmacy pavilion, garages, modern street furniture, modern cars + burnt
wrecks, checkpoint / sandbagged windows / anti-drone net tunnel.
Two materials: modern_atlas (2048^2 opaque, modern_atlas.py) and modern_alpha (1024^2 RGBA, alpha MASK 0.5, double
sided: netting, cracked glazing).  Every asset is an empty named <asset id> holding one child mesh <asset id>_geo
(KHR_mesh_quantization puts its dequantisation transform on the child, so template instancing that strips the root
transform stays correct).  Origin = ground centre of the footprint (bbox centre in x/z, shared by an asset and its
_damaged / _burnt twin), +Y up, long axis along X, cars front = +X.
Geometry QA: every mesh goes through meshfix.unfight (z-fighting) + meshfix.fix_mb (winding / holes) before export
(NO_MESHFIX=1 skips both); check with python3 check_assets.py ../../../assets/env/modern.glb
Run:  cd tools/blender/env && nice -n 10 python3 build_modern.py      -> assets/env/modern.glb + modern_manifest.json,
      then ./optimize_modern.sh  (WebP + quantisation)
      python3 build_modern.py car_ bus_                              -> previews/_test/modern_test.glb (subset, 'name$' exact)
      REBUILD_ATLAS=1 ... repaints both atlases (otherwise cached in _cache/).
"""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import bpy
from meshlib import reset_scene, make_material, REPO, mat_trs
from meshfix import fix_mb, unfight
import modern_atlas as MA
import modern_geo as MG
import modern_props as MP

BUDGET = {'kindergarten': 8000, 'boiler_house': 8000, 'supermarket': 10000, 'garage_row': 8000, 'car_': 4000, 'bus_': 3000,
          'playground': 5000, 'checkpoint': 1500, 'pharmacy': 1500, 'kiosk': 1500, 'outdoor_gym': 1800, 'bus_stop': 1200, 'waste_pad': 1500, 'bench': 400}


def atlases():
    a = [os.path.join(MA.CACHE, f'modern_atlas_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    if os.environ.get('REPAINT'):
        a = MA.build(os.environ['REPAINT'].split(','))
    elif not all(os.path.exists(p) for p in a) or os.environ.get('REBUILD_ATLAS'):
        a = MA.build()
    f = [os.path.join(MA.CACHE, f'modern_alpha_{s}') for s in ('albedo.png', 'normal.png', 'orm.png')]
    if not all(os.path.exists(p) for p in f) or os.environ.get('REBUILD_ATLAS'):
        f = MA.build_alpha()
    return a, f


def to_blender(mb, mats, loc):
    # flush trims / frames / plates off their walls (z-fighting), then winding / sidedness repair (holes, inside-out
    # shells, open sheets seen from behind) -- the alpha material (1: netting, glazing) is double sided already
    if not os.environ.get('NO_MESHFIX'):
        unfight(mb, skip_mats=(1,))
        fix_mb(mb, skip_mats=(1,))
    used = sorted(set(f[3] for f in mb.F))
    ob = mb.to_object(mb.name, mats, smooth_angle=35, location=loc)
    me = ob.data
    VC = getattr(mb, 'VC', None) or {}
    if VC:
        ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'CORNER')
        cols = []
        for f in mb.F:
            for vi in f[0]:
                c = VC.get(vi)
                cols += [float(c[0]), float(c[1]), float(c[2]), 1.0] if c is not None else [1.0, 1.0, 1.0, 1.0]
        ca.data.foreach_set('color', cols)
        me.color_attributes.active_color = ca
    if used == [0] and len(me.materials) > 1:
        me.materials.pop(index=1)
    elif used == [1]:
        me.materials.pop(index=0)
        me.polygons.foreach_set('material_index', [0] * len(me.polygons))
    return ob


def items():
    """(mesh, group) -- assets of one group share the recentring shift (intact + damaged twins swap in place)."""
    return MG.all_items() + MP.all_items()


def main(only=None):
    a, f = atlases()
    reset_scene()
    m_atlas = make_material('modern_atlas', *a)
    m_alpha = make_material('modern_alpha', *f, alpha_clip=0.5, double=True)
    its = items()
    shifts = {}
    for mb, grp in its:
        if grp not in shifts:
            mn, mx = mb.bounds(); shifts[grp] = (-(mn[0] + mx[0]) / 2, -(mn[2] + mx[2]) / 2)
    if only:
        its = [(m, g) for m, g in its if any(m.name.startswith(o) if not o.endswith('$') else m.name == o[:-1] for o in only)]
    info = {}
    x = 0.0; zrow = 0.0; rowdepth = 0.0
    for mb, grp in its:
        sx, sz = shifts[grp]
        mb.transform(mat_trs((sx, 0, sz)))
        mn, mx = mb.bounds(); sz_ = mx - mn
        if x + sz_[0] > 120:
            x = 0.0; zrow -= rowdepth + 5; rowdepth = 0.0
        loc = (x - mn[0], 0, zrow - mx[2])
        x += sz_[0] + 4; rowdepth = max(rowdepth, sz_[2])
        ob = to_blender(mb, [m_atlas, m_alpha], loc)
        ob.name = mb.name + '_geo'; ob.data.name = mb.name
        e = bpy.data.objects.new(mb.name, None); bpy.context.scene.collection.objects.link(e)
        e.location = ob.location.copy(); ob.parent = e; ob.location = (0, 0, 0)
        lim = next((v for k, v in BUDGET.items() if k in mb.name), 800)
        info[mb.name] = {'size': [round(float(v), 2) for v in sz_], 'tris': mb.tris(),
                         'bbox_min': [round(float(v), 2) for v in mn], 'bbox_max': [round(float(v), 2) for v in mx],
                         'notes': MG.NODE_NOTES.get(mb.name) or MP.NODE_NOTES.get(mb.name, '')}
        print(f'{mb.name:26s} {mb.tris():6d} tris  size {np.round(sz_, 2)}{"  OVER BUDGET" if mb.tris() > lim else ""}')
    out = os.path.join(REPO, 'assets', 'env', 'modern.glb') if not only else os.path.join(REPO, 'previews', '_test', 'modern_test.glb')
    out = os.environ.get('OUT') or out   # OUT=/tmp/x.glb: QA build elsewhere (manifest still written unless NO_MANIFEST)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, export_apply=True, export_image_format='AUTO',
                              export_materials='EXPORT', export_cameras=False, export_lights=False, export_texcoords=True,
                              export_normals=True, export_vertex_color='ACTIVE', export_all_vertex_colors=False)
    print(os.path.basename(out), round(os.path.getsize(out) / 1e6, 2), 'MB')
    if not only and not os.environ.get('NO_MANIFEST'):
        man = {'file': 'modern.glb', 'nodes': info, 'notes': MG.NOTES, 'refs': MG.REFS}
        with open(os.path.join(REPO, 'assets', 'env', 'modern_manifest.json'), 'w') as fh:
            json.dump(man, fh, indent=1, ensure_ascii=False)
    return info


if __name__ == '__main__':
    import time; t0 = time.time()
    main(sys.argv[1:] or None)
    print('done', round(time.time() - t0, 1), 's')
