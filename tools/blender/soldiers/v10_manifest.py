"""soldiers_v10 manifest entries (read-modify-write of assets/soldiers/manifest.json under its .lock; never write_manifest.py).
For soldier_ua / soldier_ru: everything that describes the GLB's nodes is re-read from the shipped GLB (node_list, mesh_nodes_tris,
lod1_tris, node_extras, materials_by_node, gear_materials, default_config_tris, size_bytes), the preset lists (combos /
assault_combos / crew_combos) come from the build's combos_<fac>.json (tris re-counted from the GLB), plus the notes fields
(v6_notes history + v10 text, comms_notes, sling_notes, head_shading_notes).  Other assets / clips are left as they are.
run after copying the WebP'd GLBs to assets/soldiers/:  python3 tools/blender/soldiers/v10_manifest.py [build dir with combos_<fac>.json]"""
import os, sys, json, struct, fcntl
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, '../../../assets/soldiers'))
sys.path.insert(0, HERE)
import v6_manifest as V6

V10 = ("v10 (2026-11): comms + ear protection per preset (comms.py: nodes hs_<preset> on the head - ear cups with leatherette "
       "seals, ARC rail adapters on FAST-type helmets or a headband yoke going up under the rim, knobs, mic boom for leaders - and "
       "radio_<preset> on the plate carrier - handheld radio in an open-top pouch with antenna, PTT on the left shoulder strap, "
       "cables cup -> neck -> PTT -> radio; cups fitted to each preset's own head and helmet: centred on the ear, pulled inside the "
       "shell's inner surface where a rim covers them, lowered under low rims); painted helmet shells (helmets.py, `hg_<fac>` "
       "charts in the preset atlas: cover seams + stitching, hem, creases, band shadow, bolt heads, labels, FAST loop-velcro fields, "
       "paint wear / chips / scratches on bare shells; the geometry seams / velcro strips were removed, -0.3..-0.6 k tris per "
       "helmet); 4-point retention harness per helmet x body variant (retention_<helmet>_<body>: front / rear straps round the ear "
       "to a junction, chin strap along the jaw to a chin cup, side-release buckle, nape cradle + pad with a ratchet dial on "
       "modern helmets; SSh-68: 2-point leather strap), projected onto that face (no floating, no skin penetration), scrim on the UA "
       "PASGT-type and RU 6B7; joint skin-weight clean-up (joints.py: diffusion round shoulders / elbows / hips / knees, measured "
       "with joints_check.py over every clip: mean deformation badness -28 %); rifle sling rebuilt (taut, continuous, over the "
       "right shoulder, across the chest to the left hip, round the flank to the rear swivel; strap ends wrap the swivels; "
       "adjuster + slider). ")

COMMS_NOTES = ("Comms (v10, comms.py): every preset lists `comms_role` ('leader' | 'rifleman'), `comms`, `headset_desc`, `radio_desc`; its parts "
               "include hs_<preset> (head-mounted, rigid with Head; absent / empty when he wears no ear protection) and radio_<preset> "
               "(plate-carrier mounted, vest weights; the headset cable blends Head -> Neck -> vest).  src/game/soldier.js picks a "
               "preset with comms_role 'leader' for role.leader soldiers (squad / assault leaders, ATGM gunner, FPV pilot) and a "
               "non-leader preset for everyone else.  Loadouts (2022-25 photos): UA - Peltor ComTac III-type on ARC rails + mic "
               "boom + AN/PRC-152 (leaders), Earmor M31 on rails / M32 with headband + Motorola R7 / DP4400 or Baofeng UV-5R + PTT, "
               "cheap passive muffs, some without; RU - Earmor M32 / clones + mic boom + Azart R-187-P1 (leaders), GSSh-01 (Ratnik) "
               "+ Baofeng UV-82, Kenwood-type handhelds, Baofeng UV-5R in a chest pouch without a headset, mobilised men without. "
               "Retention harness: retention_<helmet>_<body> (in the presets).")

SLING_V10 = (" v10 sling: one continuous 32 mm strap from the front swivel over the right shoulder beside the neck, diagonally across the "
             "chest to the left hip, round the left flank at belt height to the rear swivel; every sample on a ray from inside the "
             "body is pulled taut against the outermost surface (body, vest, front / side pouches, radio pouches, the class's back "
             "gear) + 4.5 mm, so it lies on the kit and bridges hollows straight (no plateaus / gaps, no longer under the left arm); "
             "the strap ends wrap round the AK-74M swivel bars, sewn fold-back loops, slider + adjuster buckles.  AK-12: soldier.js "
             "moves it 3 cm up the sling line so its front swivel meets the strap.")


def glb_json(path):
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    return json.loads(b[20:20 + n])


def main():
    bdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '.cache', 'v10')
    mp = os.path.join(ASSETS, 'manifest.json')
    with open(mp + '.lock', 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        m = json.load(open(mp))
        for fac in ('ua', 'ru'):
            k = f'soldier_{fac}'; e = m[k]; g = os.path.join(ASSETS, f'{k}.glb')
            j = glb_json(g); nt = V6.node_tris(g)
            names = [nd['name'] for nd in j['nodes']]
            mats = [mt['name'] for mt in j['materials']]
            e['size_bytes'] = os.path.getsize(g)
            e['node_list'] = names
            e['mesh_nodes_tris'] = {n: t for n, t in nt.items() if not n.endswith('_LOD1')}
            e['lod1_tris'] = {n: t for n, t in nt.items() if n.endswith('_LOD1')}
            ex = {}; mbn = {}
            for nd in j['nodes']:
                if 'mesh' not in nd:
                    continue
                if nd.get('extras'):
                    ex[nd['name']] = nd['extras']
                if not nd['name'].endswith('_LOD1'):
                    mbn[nd['name']] = sorted({mats[p['material']] for p in j['meshes'][nd['mesh']]['primitives'] if 'material' in p})
            e['node_extras'] = ex
            e['materials_by_node'] = mbn
            e['gear_materials'] = sorted(set(mats))
            e['default_visible'] = [n for n in e['mesh_nodes_tris'] if ex.get(n, {}).get('default_visible', True) and not ex.get(n, {}).get('combo')
                                    and not ex.get(n, {}).get('sling')]
            e['default_config_tris'] = int(sum(nt.get(n, 0) for n in e['default_visible']))
            cj = json.load(open(os.path.join(bdir, f'combos_{fac}.json')))
            for lk_ in ('combos', 'assault_combos', 'crew_combos'):
                if lk_ in cj:
                    lst = cj[lk_]
                    for c in lst:
                        c['tris'] = nt.get(c['name'], c.get('tris')); c['tape_tris'] = nt.get(c['name'] + '_tape', c.get('tape_tris'))
                    e[lk_] = lst
            hist = e.get('v6_notes', '')
            e['v6_notes'] = V10 + (hist if not hist.startswith('v10') else hist[len(V10):])
            e['comms_notes'] = COMMS_NOTES
            e['sling_notes'] = V6.SLING_NOTES + SLING_V10
            e['head_shading_notes'] = ("Helmet / headset / retention occlusion is baked per preset into the COLOR_0 vertex colours of the head, eyes and "
                                       "balaclava (sky-weighted hemisphere AO against that preset's helmet_*, hs_* and retention_* nodes): brow, eyes, "
                                       "temples and ears darken under the brim and the cups.")
            print(k, e['size_bytes'], {c['name']: c['tris'] for c in e['combos'] + e['assault_combos']})
        tmp = mp + '.tmp_v10'
        json.dump(m, open(tmp, 'w'), indent=1)
        os.replace(tmp, mp)


if __name__ == '__main__':
    main()
