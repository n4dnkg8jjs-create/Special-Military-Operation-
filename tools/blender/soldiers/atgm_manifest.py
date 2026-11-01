"""ATGM / FPV manifest entries (read-modify-write of assets/soldiers/manifest.json; nothing else is touched):
  * soldier_anims.clips.<clip> for the clips of clips_atgm.CLIPS (from .cache/clips.pkl: duration, loop, events, props,
    launcher_nodes ... same fields as write_manifest.py) + soldier_anims.atgm_fpv (how the game uses them)
  * kornet / stugna / atgm_tube_carried / fpv_drone / fpv_controller / fpv_goggles prop GLB entries (nodes, empties, tris, bytes)
run: python3 tools/blender/soldiers/atgm_manifest.py            -> manifest
     python3 tools/blender/soldiers/atgm_manifest.py --preview  -> previews/atgm/props.json from .cache/clips_test.pkl (+ clips.pkl)"""
import os, sys, json, pickle, struct
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, '../../..'))
ASSETS = os.path.join(ROOT, 'assets/soldiers')
CACHE = os.path.join(HERE, '.cache')
CLIP_KEYS = ('events', 'props', 'launcher_nodes', 'launcher', 'layout', 'socket_note')
PROPS = ('kornet', 'stugna', 'atgm_tube_carried', 'fpv_drone', 'fpv_controller', 'fpv_goggles')


def clip_record(c):
    import clips_atgm as CA
    r = dict(duration_s=round(c['dur'], 3), frames=len(c['lq']), fps=30, loop=bool(c['loop']),
             ground_speed_mps=round(abs(c['speed']), 3) if c['speed'] else 0.0,
             direction='backward (-Z)' if c['speed'] < 0 else ('forward (+Z)' if c['speed'] > 0 else 'in place'),
             root_motion=bool(c['root_motion']), notes=c['notes'])
    for k in CLIP_KEYS:
        if c.get(k) is not None:
            r[k] = c[k]
    if c.get('props'):
        r['props_doc'] = CA.PROP_DOC
    return r


def jdump(o):
    return json.loads(json.dumps(o, default=lambda v: v.tolist() if hasattr(v, 'tolist') else float(v)))


def preview():
    import clips_atgm as CA
    out = {}
    for f in ('clips.pkl', 'clips_test.pkl'):
        p = os.path.join(CACHE, f)
        if os.path.exists(p):
            for n, c in pickle.load(open(p, 'rb')).items():
                if n in CA.CLIPS:
                    out[n] = clip_record(c)
    os.makedirs(os.path.join(ROOT, 'previews/atgm'), exist_ok=True)
    json.dump(jdump(out), open(os.path.join(ROOT, 'previews/atgm/props.json'), 'w'), indent=1)
    print('props.json:', sorted(out))


def read_glb(path):
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    return json.loads(b[20:20 + n])


def glb_entry(name, info):
    g = read_glb(f'{ASSETS}/{name}.glb')
    nodes = g['nodes']
    parent = {}
    for i, x in enumerate(nodes):
        for ch in x.get('children', []):
            parent[ch] = i
    tris = {}
    for i, x in enumerate(nodes):
        if 'mesh' in x:
            m = g['meshes'][x['mesh']]
            t = 0
            for pr in m['primitives']:
                t += g['accessors'][pr['indices']]['count'] // 3
            tris[x['name']] = t
    movable = {}; empties = {}
    for i, x in enumerate(nodes):
        nm = x['name']
        if 'mesh' in x or i not in parent:
            continue
        kids = [nodes[c]['name'] for c in x.get('children', [])]
        rec = dict(parent=nodes[parent[i]]['name'], t=[round(v, 4) for v in x.get('translation', [0, 0, 0])],
                   q=[round(v, 5) for v in x.get('rotation', [0, 0, 0, 1])])
        if any(k.endswith(('_mesh', '_LOD1')) for k in kids):
            rec['children'] = kids
            if x.get('extras'):
                rec['extras'] = x['extras']
            movable[nm] = rec
        else:
            empties[nm] = rec
    lod0 = sum(v for k, v in tris.items() if not k.endswith('_LOD1'))
    lod1 = sum(v for k, v in tris.items() if k.endswith('_LOD1'))
    e = dict(file=f'{name}.glb', size_bytes=os.path.getsize(f'{ASSETS}/{name}.glb'), tris=tris, tris_lod0=lod0, tris_lod1=lod1,
             materials=[m['name'] for m in g.get('materials', [])], nodes=movable, empties=empties,
             conventions='metres, +Y up, +Z forward; one atlas material per file; every movable part is a node with `<node>_mesh` (LOD0) '
                         'and `<node>_LOD1` children (hide the _LOD1 meshes near the camera, the _mesh ones far away)')
    if info and 'texel_px_per_m' in info:
        e['texel_px_per_m'] = info['texel_px_per_m']
    if g['scenes'][0].get('extras') or nodes[0].get('extras'):
        e['root_extras'] = nodes[0].get('extras')
    return e


def manifest():
    import clips_atgm as CA
    import atgm_layout as LY
    clips = pickle.load(open(os.path.join(CACHE, 'clips.pkl'), 'rb'))
    infop = os.path.join(CACHE, 'atgm_info.json')
    info = json.load(open(infop)) if os.path.exists(infop) else {}
    path = os.path.join(ASSETS, 'manifest.json')
    man = json.load(open(path))          # read right before writing
    sa = man.setdefault('soldier_anims', {})
    cl = sa.setdefault('clips', {})
    for n in CA.CLIPS:
        if n in clips:
            cl[n] = jdump(clip_record(clips[n]))
    sa['size_bytes'] = os.path.getsize(os.path.join(ASSETS, 'soldier_anims.glb'))
    sa['atgm_fpv'] = jdump(CA.usage_doc())
    fn = {'kornet': 'kornet', 'stugna': 'stugna', 'atgm_tube_carried': 'tube_carried', 'fpv_drone': 'drone', 'fpv_controller': 'controller',
          'fpv_goggles': 'goggles'}
    for p in PROPS:
        if os.path.exists(f'{ASSETS}/{p}.glb'):
            e = glb_entry(p, info.get(fn[p]))
            e.update(CA.prop_doc(p))
            man[p] = jdump(e)
    json.dump(man, open(path, 'w'), indent=1)
    print('manifest updated:', [n for n in CA.CLIPS if n in clips], PROPS)


if __name__ == '__main__':
    if '--preview' in sys.argv:
        preview()
    else:
        manifest()
