"""Mid-distance LODs (<name>_mid, ~450-700 tris) for the farmland trees, used between the
full models (< ~60 m) and the *_lod1 crown clumps (> ~190 m) so the forest block and the long windbreaks stay cheap.
The near trees are regenerated with the same species / seeds as build_farmland.py (farmland_trees.vegetation()), so a
<name>_mid shares the crown centre, AO and silhouette of the tree in farmland.glb; it is farmland_trees.lod1() with
~3x the crown clumps plus the main limbs.  Materials: farmland_atlas + farmland_foliage (same cached atlases).
These are exported into assets/env/fortifications.glb by build_fortifications.py (shared atlases, one download);
running this file standalone writes assets/env/forest.glb for QA only.
Run:  cd tools/blender/env && nice -n 10 python3 build_fortifications.py
"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import bpy
from meshlib import reset_scene, make_material, update_manifest, REPO
import farmland_trees as FT
import build_farmland as BF
from meshfix import fix_mb

SPECS = [('tree_acacia_leafy', 'acacia', 211, False, 'far_acacia', 72),
         ('tree_oak_leafy', 'oak', 233, False, 'far_oak', 96),
         ('tree_walnut_leafy', 'walnut', 244, False, 'far_walnut', 80),
         ('tree_acacia_shelled', 'acacia', 259, True, 'far_acacia_dry', 40)]


def limbs(t, n=7):
    """A few main limbs (branch tip paths trimmed to their first points) as leader tubes for the mid model."""
    out = []
    for b in (t.branch_tips or [])[:n]:
        b = np.asarray(b)
        if len(b) >= 3:
            out.append(b[: max(3, len(b) // 2 + 1)])
    return out


def items():
    out = []
    for name, sp, seed, sh, far, ncl in SPECS:
        t = FT.Tree(name, sp, seed, shelled=sh); t.build()
        out.append(FT.lod1(name + '_mid', t, far, ncl, leaders=limbs(t), seed=seed + 7))
    t = FT.poplar('tree_poplar_leafy', 222)
    out.append(FT.lod1('tree_poplar_leafy_mid', t, 'far_poplar', 84, seed=229))
    return out


def main():
    a, f = BF.atlases()
    reset_scene()
    m_atlas = make_material('farmland_atlas', *a)
    m_fol = make_material('farmland_foliage', *f, alpha_clip=0.5, double=True)
    info = {}; x = 0.0
    for mb in items():
        mn, mx = mb.bounds(); sz = mx - mn
        loc = (x - mn[0], 0, 0); x += sz[0] + 3
        fix_mb(mb, skip_mats=(1,))
        ob = BF.to_blender(mb, [m_atlas, m_fol], loc)
        ob.name = mb.name + '_geo'; ob.data.name = mb.name
        e = bpy.data.objects.new(mb.name, None); bpy.context.scene.collection.objects.link(e)
        e.location = ob.location.copy(); ob.parent = e; ob.location = (0, 0, 0)
        info[mb.name] = {'tris': mb.tris(), 'size': [round(float(v), 2) for v in sz]}
        print(f'{mb.name:28s} {mb.tris():6d} tris  size {np.round(sz, 2)}')
    out = os.path.join(REPO, 'assets', 'env', 'forest.glb')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, export_apply=True, export_image_format='AUTO',
                              export_materials='EXPORT', export_cameras=False, export_lights=False, export_texcoords=True,
                              export_normals=True, export_vertex_color='ACTIVE', export_all_vertex_colors=False)
    print(os.path.basename(out), round(os.path.getsize(out) / 1e6, 2), 'MB')



if __name__ == '__main__':
    import time; t0 = time.time(); main(); print('done', round(time.time() - t0, 1), 's')
