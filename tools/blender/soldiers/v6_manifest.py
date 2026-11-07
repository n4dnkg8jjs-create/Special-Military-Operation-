"""soldiers_v6 manifest entries (read-modify-write of assets/soldiers/manifest.json under its .lock; never write_manifest.py):
for soldier_ua / soldier_ru only size_bytes, mesh_nodes_tris, lod1_tris, default_config_tris, the presets' tris / tape_tris (re-counted
from the shipped GLBs) and a
`v6_notes` field are updated; everything else (combos, clips, other assets) is left as it is.
run after copying the WebP'd GLBs to assets/soldiers/:  python3 tools/blender/soldiers/v6_manifest.py"""
import os, json, struct, fcntl
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, '../../../assets/soldiers'))
NOTES = ("v9: packs (packs.py): rucksack (UA 3-day assault pack / RU Ratnik-type raid pack) and assault pack rebuilt with painted detail - one textured material per faction (pack_ua / pack_ru, placed in the preset atlas like the uniform): every pack / pocket face has its own chart with the gear camo plus a baked height field (coil zips with sliders and pulls, PALS webbing rows with bar tacks, laser-cut MOLLE, bound edges, stitched seams, velcro ID field with a UA flag patch, flat compression straps, grommets, labels) as normal map + cavity AO; geometry: side-release buckles, strap bridges, grab handles, karimat foam roll under the rucksack (spiral ends), MPL-50 entrenching tool on the RU rucksack, hydration tube and CAT tourniquet on the UA rucksack straps (webbing MOLLE rows moved from geometry into the texture: tris about unchanged). "
         "v8: wrists (wrist.py): sleeve ends cinched round the wrist with a 3.4 mm rounded hem + shadowed inner facing (the sleeves were open 6 cm tubes before), forearm skin continues 8 cm inside the sleeve, gloves with a cuff tucked under the sleeve (UA dark neoprene + velcro tab, RU knit) and a dark base-layer cuff; hem / tube skinned forearm-only behind the wrist (wrist_check.py: 111 clips, no poke-through). "
         "v7: soft shaded cloth folds (smooth crease profile, tapered), UA open-top pouch mags turned broad-side out / feed lips down, soft blast smudges. v6 (2026-11): baggier layered uniform (build_soldier.thicken_uniform: per-vertex offset field, trunk 8-15 mm, sleeves "
         "10-18 mm with bunching at the cuffs, trousers 11-28 mm: full thigh / seat, bunching above and below the knee pads, blousing "
         "over the boot tops, filled cargo / sleeve pockets; same topology, UVs and weights), re-baked uniform textures (rebake_v6.py: "
         "ragged printed MM-14 / EMR pixels with per-pixel tone variation, stronger folds, mud / grime / wear gradients), fuller pouches. "
         "Runtime damage (src/game/soldierDamage.js): materials soldier_atlas_* / *_camo / skin_* are patched once (defines SOLDIER_DMG, "
         "DMG_BASE = real bone count); each soldier's skinned meshes get 4 extra data bones (__dmg0..3, not in the scene graph) whose "
         "matrices carry up to 4 wounds (bind-space centre / radius, bandage band, code) + mud / rips / soot / back mud / fade / tint.")

SLING_NOTES = ("Slung weapons (v9, src/game/soldier.js stow()): a weapon not in his hands hangs on its sling on his back - parent it to the socket named in the visible preset's extras.preset.sling_socket (weapon_socket_sling / _pouch / _pack / _ruck: Spine1 children, measured onto the outer surface of that preset's back gear) with identity, and show extras.preset.sling_node (skinned 32 mm webbing sling, hidden by default) while anything hangs there. The rifle lies on its left side diagonally across the back, muzzle up behind the right shoulder, butt at the left hip; the sling runs from the front swivel over the right shoulder, across the chest to the left flank and round to the rear swivel. Used for: the RPG gunner's AK (and his RPG-7 when he has the AK in his hands: same line, turned optic-out, origin +0.16 m gun-Y / +0.18 m gun-Z), the RPG-22 shooter's rifle while the launcher is up, medics / draggers / wounded, FPV assistant; ATGM crew lay the rifle down beside them during atgm_* clips. weapon_socket_back (ATGM tubes / folded launchers) is moved per man along the chest axis so that kit rests on his preset's back gear (Soldier.fitBackKit).")


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
            for lk in ('combos', 'assault_combos', 'crew_combos'):          # v8: preset tri counts from the shipped GLB too
                for c in e.get(lk, []):
                    c['tris'] = nt.get(c['name'], c.get('tris')); c['tape_tris'] = nt.get(c['name'] + '_tape', c.get('tape_tris'))
            e['v6_notes'] = NOTES
            e['sling_notes'] = SLING_NOTES
            print(k, e['size_bytes'], 'combo_1', e['mesh_nodes_tris'].get('combo_1'), 'default', e.get('default_config_tris'))
        tmp = mp + '.tmp_v6'
        json.dump(m, open(tmp, 'w'), indent=1)
        os.replace(tmp, mp)


if __name__ == '__main__':
    main()
