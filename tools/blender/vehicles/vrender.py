"""Quick Blender (workbench, textured) contact sheet of a GLB, usable without a browser.
python3 vrender.py <glb> <out.png> "<views>" [rot=node:axis:deg;...] [hide=regex] [target=x,y,z] [dist=m] [cols=2] [w=700] [h=400]
views: "az,el;az,el;..." (degrees; az 0 = looking at the vehicle front, glTF frame: +z forward, +x left).
rot axes are glTF-frame (x, y, z) as in the manifest (glTF y -> Blender z, glTF z -> Blender -y)."""
import sys, os, math, re
import bpy
import numpy as np
from mathutils import Vector, Euler

a = sys.argv[1:]
glb, out, views = a[0], a[1], [tuple(map(float, v.split(','))) for v in a[2].split(';')]
kw = dict(x.split('=', 1) for x in a[3:])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)
sc = bpy.context.scene
hide = re.compile(kw.get('hide', r'_LOD1$|_wreck$'))
only = re.compile(kw['only']) if kw.get('only') else None
for o in sc.objects:
    nm = o.name.split('.')[0]
    chain = []
    p = o
    while p:
        chain.append(p.name.split('.')[0]); p = p.parent
    if any(hide.search(n) for n in chain) or (only and not any(only.search(n) for n in chain)):
        o.hide_render = True
for r in filter(None, kw.get('rot', '').split(';')):
    n, ax, deg = r.split(':')
    o = bpy.data.objects.get(n)
    if o:
        ang = math.radians(float(deg))
        o.rotation_mode = 'XYZ'
        # glTF importer converts Y-up: an empty's glTF local rotation about x/y/z maps to Blender local x / z / -y
        e = o.rotation_euler
        if ax == 'x':
            o.rotation_quaternion = o.rotation_quaternion  # no-op for quaternion mode
        o.rotation_mode = 'QUATERNION'
        from mathutils import Quaternion
        axis = {'x': (1, 0, 0), 'y': (0, 0, 1), 'z': (0, -1, 0)}[ax]
        o.rotation_quaternion = o.rotation_quaternion @ Quaternion(axis, ang)
bpy.context.view_layer.update()
pts = []
for o in sc.objects:
    if o.type == 'MESH' and not o.hide_render:
        pts += [o.matrix_world @ Vector(c) for c in o.bound_box]
# marks=x,y,z,r;... (glTF frame): red wire rings at checker findings
if kw.get('marks'):
    import bmesh
    red = bpy.data.materials.new('mark'); red.diffuse_color = (1, 0.05, 0.05, 1)
    for m in kw['marks'].split(';'):
        x, y, z, r = map(float, m.split(','))
        me = bpy.data.meshes.new('mk'); bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=max(0.06, r))
        bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new('mk', me); sc.collection.objects.link(ob); ob.location = (x, -z, y)
        me.materials.append(red)
        wf = ob.modifiers.new('wf', 'WIREFRAME'); wf.thickness = 0.012

for o in sc.objects:
    if o.type == 'MESH' and not o.hide_render:
        pts += [o.matrix_world @ Vector(c) for c in o.bound_box]
P = np.array(pts) if pts else np.zeros((2, 3))
c = Vector(((P.min(0) + P.max(0)) / 2).tolist())
size = np.linalg.norm(P.max(0) - P.min(0))
if 'target' in kw:
    t = list(map(float, kw['target'].split(',')))
    c = Vector((t[0], -t[2], t[1]))
dist = float(kw.get('dist', 1.0)) * size * 0.9
sc.render.engine = 'BLENDER_WORKBENCH'
sh = sc.display.shading
sh.light = 'STUDIO'; sh.color_type = 'TEXTURE'; sh.show_shadows = True; sh.show_cavity = True
sh.cavity_type = 'BOTH'
sc.display.shadow_focus = 0.2
try:
    sh.show_object_outline = False
except Exception:
    pass
W, H = int(kw.get('w', 700)), int(kw.get('h', 400))
sc.render.resolution_x, sc.render.resolution_y = W, H
sc.render.film_transparent = False
sc.world = bpy.data.worlds.new('w'); sc.world.color = (0.55, 0.58, 0.6)
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.lens = float(kw.get('lens', 40))
cam.data.clip_start = 0.01
tiles = []
for i, (az, el) in enumerate(views):
    A, E = math.radians(az), math.radians(el)
    # glTF: x left, z forward; Blender: x, y = -z_gltf
    d = Vector((math.cos(E) * math.sin(A), -math.cos(E) * math.cos(A), math.sin(E)))
    cam.location = c + d * dist
    cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    f = f'/tmp/_vr_{os.getpid()}_{i}.png'
    sc.render.filepath = f
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(f)
    arr = np.array(img.pixels[:], np.float32).reshape(H, W, 4)[::-1]
    tiles.append(arr); os.remove(f)
cols = int(kw.get('cols', 2 if len(tiles) > 1 else 1))
rows = math.ceil(len(tiles) / cols)
sheet = np.ones((rows * H, cols * W, 4), np.float32)
for i, t in enumerate(tiles):
    r_, c_ = divmod(i, cols)
    sheet[r_ * H:(r_ + 1) * H, c_ * W:(c_ + 1) * W] = t
im = bpy.data.images.new('sheet', cols * W, rows * H, alpha=True)
im.pixels.foreach_set(sheet[::-1].ravel())
im.filepath_raw = out; im.file_format = 'PNG'; im.save()
print('wrote', out)
