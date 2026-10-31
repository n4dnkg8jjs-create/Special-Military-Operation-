"""QA: re-import panel_kit.glb, normalise pieces exactly like src/engine/assets.js buildKit(), and assemble
test scenes the way src/world/buildings.js places panels. Exports previews/_test/<name>.glb for tools/preview.mjs.
Usage: python3 test_section.py section|gallery_<type>|accessories
"""
import os, sys, math, re
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import bpy
from mathutils import Matrix
from meshlib import reset_scene, export_glb, make_material, REPO

KIT = os.path.join(REPO, 'assets', 'env', 'panel_kit.glb')
STATES = ['intact', 'damaged', 'holed', 'destroyed']
H_ = 2.8
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))   # glTF -> Blender
Ci = C.inverted()


def load_kit():
    bpy.ops.import_scene.gltf(filepath=KIT)
    pieces = {}
    for o in list(bpy.context.scene.objects):
        if o.type != 'MESH' or o.parent is not None:
            continue
        name = re.sub(r'\.\d+$', '', o.name)
        # geometry in glTF space, without the node translation
        V = np.array([(Ci @ (o.matrix_world @ v.co)) for v in o.data.vertices])
        loc = np.array(Ci @ o.matrix_world.translation)
        V = V - loc
        pieces[name] = {'obj': o, 'V': V, 'loc': loc}
        o.hide_set(True); o.hide_render = True
    offs = {}
    for name, p in pieces.items():
        base = re.sub(r'_(intact|damaged|holed|destroyed)(_v\d+)?$', '', name)
        ref = pieces.get(base + '_intact', p)
        if base not in offs:
            mn, mx = ref['V'].min(0), ref['V'].max(0); sz = mx - mn
            if re.match(r'^(balcony|entrance_canopy|sign_)', base):
                offs[base] = np.array([(3.2 - sz[0]) / 2 - mn[0], -mn[1], -mn[2]])
            else:
                offs[base] = np.array([-mn[0], -mn[1], -mx[2]])
        p['off'] = offs[base]
    return pieces


def gl_mat(pos, roty, off):
    """three.js compose(pos, rotY) * translate(off) * translate(-node_loc) -> blender matrix_world for the imported object."""
    T = Matrix.Translation(pos) @ Matrix.Rotation(roty, 4, 'Y') @ Matrix.Translation(off)
    return T


def place(pieces, name, pos, roty, coll):
    p = pieces[name]
    o = p['obj'].copy(); o.data = p['obj'].data
    G = gl_mat(pos, roty, p['off']) @ Matrix.Translation(-p['loc'])
    # the imported object's matrix_world maps mesh -> blender world = C @ T_node(glTF); replace T_node with G
    o.matrix_world = C @ G @ Ci @ p['obj'].matrix_world
    o.hide_set(False); o.hide_render = False
    coll.objects.link(o)
    return o


def section(pieces, coll, states_fn, modules=4, floors=5, depth=3, ends=True, balcony_cols=(1,), entrance_col=None):
    W, H = 3.2, 2.8
    L, D = modules * W, depth * W
    for f in range(floors):
        for c in range(modules):
            sv = states_fn(c, f)          # int state or 'holed_v2'-style suffix (damage variants)
            suf = sv if isinstance(sv, str) else STATES[sv]
            st = STATES.index(suf.split('_')[0])
            bal = f > 0 and c in balcony_cols
            t = 'wall_balcony' if bal else 'wall_window'
            if f == 0 and c == entrance_col:
                t = 'wall_entrance'
            place(pieces, f'{t}_{suf}', (-L / 2 + c * W, f * H, D / 2), 0, coll)
            if bal and st < 2:
                place(pieces, 'balcony_slab', (-L / 2 + c * W, f * H, D / 2), 0, coll)
            if t == 'wall_entrance':
                place(pieces, 'entrance_canopy', (-L / 2 + c * W, f * H + H * 0.8, D / 2), 0, coll)
            # back side plain windows
            place(pieces, f'wall_window_{STATES[min(st, 1)]}', (-L / 2 + (c + 1) * W, f * H, -D / 2), math.pi, coll)
        if ends:
            for j in range(depth):
                sv = states_fn(modules, f) if j == 0 else 0
                place(pieces, f'wall_blank_end_{sv if isinstance(sv, str) else STATES[sv]}', (L / 2, f * H, D / 2 - j * W), math.pi / 2, coll)
                place(pieces, 'wall_blank_end_intact', (-L / 2, f * H, -D / 2 + j * W), -math.pi / 2, coll)
    sn = lambda v: STATES.index(v.split('_')[0]) if isinstance(v, str) else v
    for c in range(modules):
        if sn(states_fn(c, floors - 1)) < 3:
            place(pieces, 'roof_parapet', (-L / 2 + c * W, floors * H, D / 2), 0, coll)
        place(pieces, 'roof_parapet', (-L / 2 + (c + 1) * W, floors * H, -D / 2), math.pi, coll)
    # interior like buildings.js buildInterior(): floor slabs + dark volume, roof box
    slabm = make_material('slab_tmp', color=(0.25, 0.24, 0.22, 1), rough=0.95)
    dark = make_material('dark_tmp', color=(0.008, 0.007, 0.006, 1), rough=1)
    roofm = make_material('roof_tmp', color=(0.04, 0.04, 0.035, 1), rough=0.9)
    def box(cx, cy, cz, sx, sy, sz, m):
        bpy.ops.mesh.primitive_cube_add(size=1)
        o = bpy.context.active_object
        o.scale = (sx, sz, sy); o.location = (cx, -cz, cy)
        o.data.materials.append(m)
        for c_ in o.users_collection: c_.objects.unlink(o)
        coll.objects.link(o)
    for c in range(modules):
        for f in range(floors):
            if sn(states_fn(c, f)) == 3 and sn(states_fn(c, min(floors - 1, f + 1))) == 3 and f >= floors - 2:
                continue
            cx = -L / 2 + (c + 0.5) * W
            box(cx, f * H + H - 0.11, 0, W, 0.22, D - 0.2, slabm)
            box(cx, f * H + H / 2, 0, W - 0.02, H - 0.24, D - 2.4, dark)
    box(0, floors * H + 0.05, 0, L, 0.3, D, roofm)


def section_brick(pieces, coll, states_fn, pre='brick_', modules=4, floors=5, depth=3, ground=None, signs=None):
    W, H = 3.2, 2.8
    L, D = modules * W, depth * W
    ground = ground or {}
    signs = signs or {}
    for f in range(floors):
        for c in range(modules):
            sv = states_fn(c, f)
            suf = sv if isinstance(sv, str) else STATES[sv]
            st = STATES.index(suf.split('_')[0])
            bal = f > 0 and c in (1, 2)
            t = pre + ('balcony' if bal else 'window')
            if f == 0 and c in ground:
                t = ground[c]
            place(pieces, f'{t}_{suf}', (-L / 2 + c * W, f * H, D / 2), 0, coll)
            if bal and st < 2:
                place(pieces, 'balcony_slab' if c == 1 else 'balcony_slab_open', (-L / 2 + c * W, f * H, D / 2), 0, coll)
            if t.endswith('entrance'):
                place(pieces, 'entrance_canopy', (-L / 2 + c * W, f * H + H * 0.8, D / 2), 0, coll)
            if f == 0 and c in signs:
                place(pieces, f'{signs[c]}_{"damaged" if st >= 1 else "intact"}', (-L / 2 + c * W, 2.14, D / 2), 0, coll)
            place(pieces, f'{pre}window_{STATES[min(st, 1)]}', (-L / 2 + (c + 1) * W, f * H, -D / 2), math.pi, coll)
        for j in range(depth):
            sv = states_fn(modules, f) if j == 0 else 0
            place(pieces, f'{pre}blank_end_{sv if isinstance(sv, str) else STATES[sv]}', (L / 2, f * H, D / 2 - j * W), math.pi / 2, coll)
            place(pieces, f'{pre}blank_end_intact', (-L / 2, f * H, -D / 2 + j * W), -math.pi / 2, coll)
    par = pre + 'parapet'
    sn = lambda v: STATES.index(v.split('_')[0]) if isinstance(v, str) else v
    for c in range(modules):
        if sn(states_fn(c, floors - 1)) < 3:
            place(pieces, par, (-L / 2 + c * W, floors * H, D / 2), 0, coll)
        place(pieces, par, (-L / 2 + (c + 1) * W, floors * H, -D / 2), math.pi, coll)
    for j in range(depth):
        place(pieces, par, (L / 2, floors * H, D / 2 - j * W), math.pi / 2, coll)
        place(pieces, par, (-L / 2, floors * H, -D / 2 + j * W), -math.pi / 2, coll)
    roofm = make_material('roof_tmp', color=(0.04, 0.04, 0.035, 1), rough=0.9)
    dark = make_material('dark_tmp', color=(0.008, 0.007, 0.006, 1), rough=1)
    def box(cx, cy, cz, sx, sy, sz, m):
        bpy.ops.mesh.primitive_cube_add(size=1)
        o = bpy.context.active_object
        o.scale = (sx, sz, sy); o.location = (cx, -cz, cy)
        o.data.materials.append(m)
        for c_ in o.users_collection: c_.objects.unlink(o)
        coll.objects.link(o)
    box(0, floors * H / 2, 0, L - 0.4, floors * H - 0.1, D - 0.4, dark)
    box(0, floors * H + 0.05, 0, L, 0.3, D, roofm)


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else 'section'
    reset_scene()
    pieces = load_kit()
    coll = bpy.data.collections.new('test'); bpy.context.scene.collection.children.link(coll)
    if which == 'section':
        S = {(0, 0): 1, (1, 0): 0, (2, 0): 1, (3, 0): 2,
             (0, 1): 0, (1, 1): 1, (2, 1): 2, (3, 1): 1,
             (0, 2): 1, (1, 2): 2, (2, 2): 3, (3, 2): 1,
             (0, 3): 0, (1, 3): 1, (2, 3): 2, (3, 3): 3,
             (0, 4): 1, (1, 4): 0, (2, 4): 3, (3, 4): 3, (4, 4): 3, (4, 3): 3, (4, 2): 2}
        section(pieces, coll, lambda c, f: S.get((c, f), 0), entrance_col=None)
    elif which == 'section2':
        S = {(1, 1): 1, (1, 2): 2, (2, 2): 1, (0, 0): 1}
        section(pieces, coll, lambda c, f: S.get((c, f), 0), entrance_col=2)
    elif which.startswith('variants_'):
        # holed v1..v3 (front row) and destroyed v1..v3 (back row) with the game's interior slab + dark box behind
        t = which[len('variants_'):]
        slabm = make_material('slab_tmp', color=(0.25, 0.24, 0.22, 1), rough=0.95)
        dark = make_material('dark_tmp', color=(0.008, 0.007, 0.006, 1), rough=1)
        for row, st in enumerate(('holed', 'destroyed')):
            for i, v in enumerate(('', '_v2', '_v3')):
                x, z = (row * 3 + i) * 3.8, 0.0
                place(pieces, f'{t}_{st}{v}', (x, 0, z), 0, coll)
                for (cy, sy, m, cz, sz) in ((H_ - 0.11, 0.22, slabm, z - 1.6, 3.0), (H_ / 2, H_ - 0.24, dark, z - 2.1, 1.8)):
                    bpy.ops.mesh.primitive_cube_add(size=1); o = bpy.context.active_object
                    o.scale = (3.2, sz, sy); o.location = (x + 1.6, -cz, cy)
                    o.data.materials.append(m)
                    for c_ in o.users_collection: c_.objects.unlink(o)
                    coll.objects.link(o)
    elif which == 'vsection':
        S = {(0, 0): 'holed_v2', (1, 0): 0, (2, 0): 'destroyed_v3', (3, 0): 1,
             (0, 1): 1, (1, 1): 'holed_v3', (2, 1): 'destroyed_v2', (3, 1): 'holed',
             (0, 2): 'destroyed_v2', (1, 2): 2, (2, 2): 'destroyed', (3, 2): 'holed_v2',
             (0, 3): 'holed_v3', (1, 3): 'destroyed_v3', (2, 3): 'destroyed_v2', (3, 3): 'destroyed_v3',
             (0, 4): 1, (1, 4): 'holed_v2', (2, 4): 'destroyed_v3', (3, 4): 'destroyed_v2', (4, 4): 'destroyed_v2', (4, 3): 'holed_v3', (4, 2): 'holed_v2', (4, 1): 'destroyed_v3'}
        section(pieces, coll, lambda c, f: S.get((c, f), 0), entrance_col=None)
    elif which.startswith('vbrick_'):
        pre = which[len('vbrick_'):] + '_'
        S = {(0, 0): 'holed_v2', (2, 0): 1, (3, 1): 'destroyed_v2', (0, 2): 'holed_v3', (1, 3): 'destroyed_v3', (2, 2): 'destroyed_v2',
             (2, 3): 'destroyed', (2, 4): 'destroyed_v3', (3, 4): 1, (4, 3): 'holed_v2', (0, 4): 'holed_v3', (1, 1): 'holed', (3, 2): 'destroyed_v3'}
        sv = lambda c, f: S.get((c, f), 0)
        section_brick(pieces, coll, sv, pre=pre,
                      ground={0: 'wall_shopfront', 1: pre + 'entrance', 2: 'wall_shopfront_shutter'},
                      signs={})
    elif which.startswith('gallery_'):
        t = which[len('gallery_'):]
        for i, s in enumerate(STATES):
            place(pieces, f'{t}_{s}', (i * 3.8, 0, 0), 0, coll)
    elif which == 'accessories':
        names = ['balcony_slab', 'balcony_slab_open', 'balcony_hanging', 'entrance_canopy', 'roof_parapet', 'plinth']
        for i, n in enumerate(names):
            place(pieces, n, (i * 3.8, 0, 0), 0, coll)
    elif which == 'misc':
        names = ['slab_floor', 'slab_floor_broken', 'stair_core', 'partition_wall_intact', 'partition_wall_holed']
        for i, n in enumerate(names):
            place(pieces, n, (i * 4.2, 0, 0), 0, coll)
        for i, n in enumerate(['debris_wardrobe', 'debris_bed', 'debris_table', 'debris_radiator']):
            place(pieces, n, (i * 2.5, 0, 4.0), 0, coll)
    elif which == 'brick_white' or which == 'brick_red':
        pre = 'brick_' if which == 'brick_white' else 'brick_red_'
        S = {(0, 0): 1, (2, 0): 1, (3, 1): 2, (0, 2): 1, (1, 3): 2, (2, 2): 3, (2, 3): 3, (2, 4): 3, (3, 4): 1, (4, 3): 2, (0, 4): 2}
        section_brick(pieces, coll, lambda c, f: S.get((c, f), 0), pre=pre,
                      ground={0: 'wall_shopfront', 1: pre + 'entrance', 2: 'wall_shopfront_shutter'},
                      signs={0: 'sign_apteka', 2: 'sign_produkty'})
    elif which == 'shops':
        for i, s_ in enumerate(STATES):
            place(pieces, f'wall_shopfront_{s_}', (i * 3.8, 0, 0), 0, coll)
            place(pieces, f'sign_{["apteka", "khlib", "kafe", "perukarnia"][i]}_{"intact" if i < 2 else "damaged"}', (i * 3.8, 2.14, 0), 0, coll)
            place(pieces, f'wall_shopfront_shutter_{s_}', (i * 3.8, 0, -5), 0, coll)
            place(pieces, f'sign_{["gospodarchi", "magazyn", "ovochi", "zootovary"][i]}_{"intact" if i % 2 == 0 else "damaged"}', (i * 3.8, 2.14, -5), 0, coll)
    elif which == 'collapse':
        import bpy as _b
        for n, pos in (('collapse_pile_large', (0, 0, 0)), ('collapse_pile_small', (12, 0, 0)), ('slab_hanging', (8, 0, 8)),
                       ('roof_machine_room', (-10, 0, 8)), ('roof_vent', (-5, 0, 9)), ('roof_antenna', (-3, 0, 12))):
            p = pieces[n]
            o = p['obj'].copy(); o.data = p['obj'].data
            o.matrix_world = C @ Matrix.Translation(pos) @ Ci @ p['obj'].matrix_world @ Matrix.Translation(C @ (-Matrix.Translation(p['loc']).translation))
            o.matrix_world = C @ Matrix.Translation(pos) @ Matrix.Translation(-p['loc']) @ Ci @ p['obj'].matrix_world
            o.hide_set(False); o.hide_render = False
            coll.objects.link(o)
    elif which == 'street':
        # a district street: 5-storey white-brick block with a shop ground floor, heating mains and private houses opposite
        S = {(0, 0): 1, (3, 1): 2, (2, 3): 1, (5, 4): 2, (5, 0): 2}
        section_brick(pieces, coll, lambda c, f: S.get((c, f), 0), pre='brick_', modules=6,
                      ground={0: 'wall_shopfront', 1: 'wall_shopfront_shutter', 2: 'brick_entrance', 3: 'wall_shopfront', 4: 'wall_shopfront', 5: 'wall_shopfront_shutter'},
                      signs={0: 'sign_apteka', 1: 'sign_gospodarchi', 3: 'sign_khlib', 4: 'sign_perukarnia', 5: 'sign_produkty'})
        bpy.ops.import_scene.gltf(filepath=os.path.join(REPO, 'assets', 'env', 'city.glb'))
        city = {re.sub(r'\.\d+$', '', o.name): o for o in bpy.context.selected_objects if o.parent is None}
        for o in city.values():
            o.hide_set(True); o.hide_render = True
        P = math.pi
        layout = [('lamp_a', -7, 8.6, 0), ('lamp_broken', 7, 8.6, 0), ('car_parked_lada', -4, 11.2, P / 2), ('car_parked_volga', 3.5, 11.4, -P / 2 + 0.05),
                  ('bench_concrete', -1.0, 6.3, 0), ('bin_a', 1.6, 6.4, 0), ('sign_road_crossing', 9.5, 8.6, 0), ('billboard_b', -13, 9, 0.3),
                  ('pipe_straight_a', -15, 20, 0), ('pipe_straight_torn', -9, 20, 0), ('pipe_loop', -3, 20, 0), ('pipe_straight_burst', 3, 20, 0),
                  ('pipe_straight_a', 9, 20, 0), ('pipe_straight_a', 15, 20, 0), ('substation_a', 13, 13.5, P),
                  ('house_a', -8, 32, P), ('house_d', 6, 32, P), ('house_c', 20, 32, P), ('fence_house_prof', -8, 23, P), ('fence_house_picket', 6, 23, P),
                  ('fence_house_broken', 20, 23, P), ('laundry_pole_a', -3, -9.5, 0), ('fence_po2_a', -20, 2, P / 2), ('fence_po2_broken', -20, 6.1, P / 2)]
        for name, x, z, ry in layout:
            src = city[name]
            o = src.copy(); o.data = src.data
            loc = src.matrix_world.translation.copy()
            o.matrix_world = C @ Matrix.Translation((x, 0, z)) @ Matrix.Rotation(ry, 4, 'Y') @ Ci @ Matrix.Translation(-loc) @ src.matrix_world
            o.hide_set(False); o.hide_render = False
            coll.objects.link(o)
    sel = list(coll.objects)
    out = os.path.join(REPO, 'previews', '_test', which + '.glb')
    export_glb(out, selection=sel)
    print('wrote', out)


main()
