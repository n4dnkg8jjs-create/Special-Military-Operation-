"""QA helper: python3 subset.py <in.glb> <out.glb> <spacing> name1 name2 ... -> those top-level nodes in a row."""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from meshlib import reset_scene, export_glb
src, out, sp = sys.argv[1], sys.argv[2], float(sys.argv[3]); names = sys.argv[4:]
reset_scene(); bpy.ops.import_scene.gltf(filepath=src)
keep = []
for o in list(bpy.context.scene.objects):
    if o.parent is None:
        n = re.sub(r'\.\d+$', '', o.name)
        if n in names:
            i = names.index(n); cols = int(os.environ.get('COLS', '99'))
            o.location = ((i % cols) * sp, (i // cols) * sp, 0); keep.append(o)
sel = []
for o in keep:
    sel.append(o); sel += list(o.children_recursive)
export_glb(out, selection=sel)
