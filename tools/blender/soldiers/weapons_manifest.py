"""Refresh only the weapon entries of assets/soldiers/manifest.json (read-modify-write) after weapons.py, without re-running
the whole soldier pipeline.  The same entries are produced by write_manifest.py on a full rebuild.
run: python3 tools/blender/soldiers/weapons_manifest.py [weapon ...] [--soldiers]
  no weapon names: every weapon entry + references.weapons;  names: only those entries (nothing else is touched)
  --soldiers: also refresh the soldier_ru / soldier_ua entries (computed fields from the GLBs + .cache/combos_<fac>.json; the
              descriptive texts already in the manifest are kept, the vest / armour notes are updated)"""
import os, sys, json, re, ast
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, '../../../assets/soldiers')
CACHE = os.path.join(HERE, '.cache')
WEAPONS = ('ak74m', 'pkm', 'rpg7', 'rpg22', 'ak12', 'ak74m_optic', 'grenade_f1', 'grenade_rgd5', 'pm')


def main(only=(), soldiers=False):
    import write_manifest as WM
    src = open(os.path.join(HERE, 'write_manifest.py')).read()
    # the weapon reference texts live in write_manifest.main(): evaluate that dict literal so both stay identical
    i = src.index("'weapons': {'ak74m':"); j = src.index('{', i)
    depth = 0
    for k in range(j, len(src)):
        depth += src[k] == '{'; depth -= src[k] == '}'
        if depth == 0:
            break
    refs = ast.literal_eval(re.sub(r"'\s*\n\s*'", '', src[j:k + 1]))
    path = os.path.join(ASSETS, 'manifest.json')
    man = json.load(open(path))       # read right before writing (other tools add their own entries concurrently)
    if not only:
        man.setdefault('references', {})['weapons'] = refs
    wi = json.load(open(os.path.join(CACHE, 'weapons_info.json')))
    out = {}
    for w in WEAPONS:
        if only and w not in only:
            continue
        if not os.path.exists(f'{ASSETS}/{w}.glb') or w not in wi:
            continue
        g, tris, mats = WM.read_glb(f'{ASSETS}/{w}.glb')
        out[w] = dict(file=f'{w}.glb', size_bytes=os.path.getsize(f'{ASSETS}/{w}.glb'), tris=tris, materials=sorted({m for ms in mats.values() for m in ms}),
                      empties={k: v[0] for k, v in wi[w]['empties'].items()},
                      conventions='origin = pistol grip (palm centre), +Z = muzzle, +Y up, weapon left side = +X; `<name>_LOD1` node = LOD1 '
                                  '(the magazine LOD1 is a child of `magazine`); one atlas material per weapon',
                      texel_px_per_m=wi[w].get('texel_px_per_m'))
    # per-weapon notes: reuse the literal strings from write_manifest.py
    blk = src[src.index("    out['ak74m']['magazine_node']"):src.index("    out['deviations']")]
    import textwrap
    full = {w: {} for w in WEAPONS}
    full.update(out)
    exec(textwrap.dedent(blk), {"out": full})
    out = {w: e for w, e in full.items() if w in out}
    for w, txt in GEOMETRY_NOTES.items():
        if w in out:
            out[w]['geometry_notes'] = txt
    if soldiers:
        for fac in ('ru', 'ua'):
            man[f'soldier_{fac}'] = soldier_entry(WM, man.get(f'soldier_{fac}', {}), fac)
    for w, e in out.items():
        man[w] = e
    man = {**json.load(open(path)), **{k: v for k, v in man.items() if k in out or (soldiers and k in ('soldier_ru', 'soldier_ua')) or (not only and k == 'references')}}
    json.dump(man, open(path, 'w'), indent=1)
    print('manifest weapon entries updated:', {w: sum(v for k, v in e['tris'].items() if not k.endswith('_LOD1')) for w, e in out.items()})


_AK = ('2026-10 rework (empties unchanged): proportions matched to side photos of the AK-74 / AK-74M scaled on the 943 mm length - '
       '35.6 mm wide receiver (was 30), stock hinge right behind the grip, front trunnion / lower handguard joint at 204 mm ahead of the grip, '
       'longer handguards (lower 170 mm), rear sight block moved onto the barrel over the handguard, gas block 6 cm further forward with a '
       'longer exposed vented gas tube, ~15 mm shorter and deeper pistol grip, stock with ~15 mm comb drop and a 110 mm butt; 30-rd 5.45 '
       'magazine 66 mm deep x 30 mm thick (was 40 x 26), 15 deg rake at the mouth curving to ~33 deg (R 0.53 m), horizontal mouth, '
       'floorplate, spines and ribs')
GEOMETRY_NOTES = {'ak74m': _AK, 'ak74m_optic': _AK + '; Kobra side mount moved out with the wider receiver',
                  'ak12': _AK + '; AK-12 handguard to the gas block (5 M-LOK slots), front sight on the moved gas block, waffle-panel magazine',
                  'pkm': '2026-10: 100-rd box 68 mm thick with stamped ribs (was 52 mm), flat stamped carry-handle bracket instead of a rod'}
VEST_NOTES = {
    'ru': ('RU vest = 6B45/6B46 (Ratnik) style: front and back sections run from the collar bones / shoulder blades down to the belt line '
           '(1.015 m, trouser waist ~1.0 m), soft side sections wrap the waist (to 1.26 m), shooter\'s cut front / armhole cut back; '
           '6Sh117-style pouches: three double mag pouches low on the front, radio + grenade pouch above, grenade pouches / IFAK on the sides.'),
    'ua': 'UA vest = JPC-style plate carrier (plate bags ~280 x 316 mm, cummerbund), open-top triple mag shingle, admin pouch + flag, tourniquet.'}
ARMOUR_NOTES = ('Armour add-on nodes: armor_groin = soft groin protector flap hung from the bottom of the front section (RU) / under the plate '
                'carrier (UA), conforming to the lower belly and the fronts of both thighs, skinned Hips -> 85 % average of both UpLeg bones at '
                'the bottom edge (it is lifted / pushed forward by the thighs); armor_arms = soft shoulder (deltoid) protectors sewn to the shoulder '
                'straps, rigid with the upper arm, top edge shared 45 % with the clavicle bone.  Presets: see combos[*].groin_protector / '
                'shoulder_protectors (standard presets: some with a groin flap, some with shoulder protectors; assault presets mostly both).')


SLING_NOTES = ('Rifle slung on the back: parent the rifle (identity transform) to the socket named in the visible preset\'s '
               'extras.preset.sling_socket (weapon_socket_sling / _pouch / _pack / _ruck: Spine1 children, chosen by the back gear of that '
               'preset) and show the node extras.preset.sling_node (sling_back / sling_back_pouch / sling_back_pack / sling_back_ruck: '
               'skinned 32 mm webbing sling, hidden by default, no LOD) for exactly as long as the rifle is there; hide it otherwise. '
               'The rifle lies on its left side diagonally across the back, muzzle up behind the right shoulder, butt at the left hip; the '
               'sling runs from the front swivel over the right shoulder, across the chest to the left flank and round to the rear swivel '
               '(AK-74M / AK-12 / AK-74M+optic swivel positions). weapon_socket_back is unchanged (ATGM tubes / folded launchers / side '
               'weapons are authored in its frame).')


def soldier_entry(WM, old, fac):
    g, tris, mats = WM.read_glb(f'{ASSETS}/soldier_{fac}.glb')
    nodes = [n['name'] for n in g['nodes']]
    extras = {n['name']: n.get('extras') for n in g['nodes'] if n.get('extras')}
    lod0 = {k: v for k, v in tris.items() if not k.endswith('_LOD1')}
    default = [k for k in lod0 if (extras.get(k) or {}).get('default_visible', True)]
    e = dict(old)
    e.update(file=f'soldier_{fac}.glb', size_bytes=os.path.getsize(f'{ASSETS}/soldier_{fac}.glb'), mesh_nodes_tris=lod0,
             lod1_tris={k: v for k, v in tris.items() if k.endswith('_LOD1')}, default_visible=default,
             default_config_tris=int(sum(lod0[k] for k in default)), materials_by_node=mats, node_extras=extras,
             gear_materials=sorted({m for k, ms in mats.items() for m in ms}), node_list=nodes)
    e['notes'] = ('body_A/B/C are alternative variants (one visible at a time; A default). hands vs gloves are alternatives. '
                  'helmet_A/B/C/D alternatives (see combos[*].helmet_desc). backpack, legband_L, kneepads, pouches_back off by default. '
                  'Gear is skinned to the shared skeleton: vest / plate carrier to the trunk chain only (Hips..Spine1; the shoulder straps and the top '
                  'corners share up to 50 % with the clavicles, no arm / neck influence, so nothing flares out when the arms are raised), pouches '
                  'rigid per pouch, helmet rigid to Head, kneepads rigid to *Leg, tape bands follow the sleeve weights. All textured materials use '
                  'colour factor 1. Vertex colours (COLOR_0) on gear carry baked ambient occlusion. ' + VEST_NOTES[fac] + ' ' + ARMOUR_NOTES)
    e['sling_notes'] = SLING_NOTES
    e['head_shading_notes'] = ('Helmet / headset occlusion is baked per preset into the COLOR_0 vertex colours of the head, eyes and balaclava '
                               '(sky-weighted hemisphere AO against that preset\'s headgear): brow, eyes, temples and ears darken under the brim.')
    cb = json.load(open(os.path.join(CACHE, f'combos_{fac}.json')))
    e['combos'] = cb['combos']; e['assault_combos'] = cb['assault_combos']; e['crew_combos'] = cb.get('crew_combos', [])
    cn = old.get('combo_notes', '')
    tail = ' Presets wearing the vest also drop the uniform triangles completely covered by it (every corner under the vest, skinned to the trunk).'
    e['combo_notes'] = cn if tail in cn else cn + tail
    return e


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    main(only=tuple(args), soldiers='--soldiers' in sys.argv)
