"""soldiers_v6 manifest entries (read-modify-write of assets/soldiers/manifest.json under its .lock; never write_manifest.py):
for soldier_ua / soldier_ru only size_bytes, mesh_nodes_tris, lod1_tris, default_config_tris (re-counted from the shipped GLBs) and a
`v6_notes` field are updated; everything else (combos, clips, other assets) is left as it is.
run after copying the WebP'd GLBs to assets/soldiers/:  python3 tools/blender/soldiers/v6_manifest.py"""
import os, json, struct, fcntl
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, '../../../assets/soldiers'))
NOTES = ("v6 (2026-11): baggier layered uniform (build_soldier.thicken_uniform: per-vertex offset field, trunk 8-15 mm, sleeves "
         "10-18 mm with bunching at the cuffs, trousers 11-28 mm: full thigh / seat, bunching above and below the knee pads, blousing "
         "over the boot tops, filled cargo / sleeve pockets; same topology, UVs and weights), re-baked uniform textures (rebake_v6.py: "
         "ragged printed MM-14 / EMR pixels with per-pixel tone variation, stronger folds, mud / grime / wear gradients), fuller pouches. "
         "Runtime damage (src/game/soldierDamage.js): materials soldier_atlas_* / *_camo / skin_* are patched once (defines SOLDIER_DMG, "
         "DMG_BASE = real bone count); each soldier's skinned meshes get 4 extra data bones (__dmg0..3, not in the scene graph) whose "
         "matrices carry up to 4 wounds (bind-space centre / radius, bandage band, code) + mud / rips / soot / back mud / fade / tint.")


def node_tris(path):
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + n])
    out = {}
    for nd in j['nodes']:
        if 'mesh' not in nd:
            continue
        t = 0
        for p in j['meshes'][nd['mesh']]['primitives']:
            a = j['accessors'][p['indices']] if 'indices' in p else j['accessors'][p['attributes']['POSITION']]
            t += a['count'] // 3
        out[nd['name']] = t
    return out


def main():
    mp = os.path.join(ASSETS, 'manifest.json')
    with open(mp + '.lock', 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        m = json.load(open(mp))
        for fac in ('ua', 'ru'):
            k = f'soldier_{fac}'; e = m[k]; g = os.path.join(ASSETS, f'{k}.glb')
            nt = node_tris(g)
            e['size_bytes'] = os.path.getsize(g)
            e['mesh_nodes_tris'] = {n: nt.get(n, v) for n, v in e['mesh_nodes_tris'].items()}
            e['lod1_tris'] = {n: nt.get(n, v) for n, v in e.get('lod1_tris', {}).items()}
            if 'default_visible' in e:
                e['default_config_tris'] = int(sum(nt.get(n, 0) for n in e['default_visible']))
            e['v6_notes'] = NOTES
            print(k, e['size_bytes'], 'combo_1', e['mesh_nodes_tris'].get('combo_1'), 'default', e.get('default_config_tris'))
        tmp = mp + '.tmp_v6'
        json.dump(m, open(tmp, 'w'), indent=1)
        os.replace(tmp, mp)


if __name__ == '__main__':
    main()
