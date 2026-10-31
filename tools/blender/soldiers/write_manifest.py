"""Stage 4: assets/soldiers/manifest.json (reads the produced GLBs + cached clip metadata).
run: python3 tools/blender/soldiers/write_manifest.py"""
import os, sys, json, struct, pickle
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import camo as C

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, '../../../assets/soldiers'))
CACHE = os.path.join(HERE, '.cache')


def read_glb(path):
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    g = json.loads(b[20:20 + n])
    acc = g.get('accessors', [])
    tris = {}
    for node in g['nodes']:
        if 'mesh' in node:
            m = g['meshes'][node['mesh']]
            tris[node['name']] = int(sum(acc[p['indices']]['count'] // 3 for p in m['primitives']))
    mats_by_node = {}
    for node in g['nodes']:
        if 'mesh' in node:
            mats_by_node[node['name']] = sorted({g['materials'][p['material']]['name'] for p in g['meshes'][node['mesh']]['primitives'] if 'material' in p})
    return g, tris, mats_by_node


def main():
    out = {
        'generator': 'tools/blender/soldiers (stage_body.py -> build_soldier.py -> weapons.py -> build_anims.py -> write_manifest.py)',
        'units': 'metres, Y up, model forward +Z, right = -X, origin on the ground between the feet',
        'height_m': {'body_bare': 1.74, 'with_helmet_and_boots': 1.77},
        'licences': 'MakeHuman base mesh/targets/cmu_mb rig+weights (CC0), CMU mocap (free for any use); everything else procedural.',
    }
    clips = pickle.load(open(f'{CACHE}/clips.pkl', 'rb'))
    pal = lambda d: {k: v for k, v in d.items()}
    out['references'] = {
        'ratnik_emr_camo': dict(palette=pal(C.EMR), pixel_size_m=C.EMR_PIXEL_M,
                                notes='EMR ("tsifra") summer: light grey-green ground with dark-green, brown and black pixel clusters forming '
                                      'larger deforming blobs (Flecktarn-like micro/macro structure). Proportions used: ground ~45%, green 28%, brown 27% (black ~9% inside the dark clusters).'),
        'mm14_camo': dict(palette=pal(C.MM14), pixel_size_m=C.MM14_PIXEL_M,
                          notes='MM-14: five-tone digital pattern (light beige, light green, swamp green, grey-green, dark grey); slightly horizontally elongated shapes.'),
        'multicam': dict(palette=pal(C.MULTICAM), notes='UA plate carriers / helmet covers / some tops; organic 6-tone pattern, procedural approximation.'),
        'coyote_webbing': C.COYOTE,
        '6b46_plate_carrier': dict(notes='Ratnik lightweight plate carrier: front/back plate bags (Granit-type plates), cummerbund, padded shoulder straps, MOLLE, drag handle. '
                                         'Modelled: plate bags ~300 x 336 mm front / 310 x 344 mm back, 22-26 mm thick with plate bulge and shooter\'s-cut corners; '
                                         'cummerbund 180 mm; 6Sh117-style pouches: 3 flapped double AK mag pouches (85x155x62 mm, Fastex), radio pouch (R-187 style radio + antenna), '
                                         'grenade pouches, IFAK, hydration and dump pouch.'),
        'ua_plate_carrier': dict(notes='JPC-style: slimmer plate bags (280 x 316 mm), integrated open-top triple mag shingle with visible AK mag bases, admin pouch with UA flag patch, '
                                       'CAT tourniquet, radio on the cummerbund, IFAK, grenade pouch; MultiCam + coyote webbing.'),
        'helmets': {'RU helmet_A': '6B47 with EMR cover, elastic foliage band, NVG shroud', 'RU helmet_B': '6B47 with EMR cover, band and goggles on the brow',
                    'UA helmet_A': 'FAST-style high cut (ear cut-outs high) with MultiCam cover, ARC side rails, NVG shroud, counterweight pouch',
                    'UA helmet_B': 'MICH/ACH-style mid cut with MultiCam cover and goggles'},
        'tape_bands': 'Identification tape wrapped twice around the upper arms (~50 mm wide, ~120 mm below the shoulder joint) and around the thighs; '
                      'RU white (alt red), UA yellow. Separate meshes using material `tape` (extras.recolourable) so the game can recolour them.',
        'assault_kit': {'RU': '6B45 in assault configuration: shoulder/upper-arm protectors, groin protector, side plates, neck collar; 6B47 with NVG mount + '
                               'headset or Altyn-style heavy visorless helmet; balaclavas on some; grenade pouches + 6Sh117 assault pouches, IFAK, dump pouch; '
                               'knee + elbow pads, assault pack with radio, gloves',
                        'UA': 'heavier plate carrier with shoulder & groin protection and side plates; FAST high-cut with NVG shroud, counterweight pouch and '
                              'headset (or MICH + goggles); grenade pouches, radio, IFAK, tourniquet; elbow/knee pads, gloves, MultiCam or MM-14'},
        'weapons': {'ak74m': 'AK-74M (6P20) 943 mm: plum polymer furniture, ribbed dust cover, stamped receiver with trunnion rivets and mag-well dimples, '
                             'side rail, tangent rear sight, 90-deg gas block with vented gas tube, cleaning rod, AK-74 two-chamber brake, side-folding '
                             'solid stock, 5.45 mm 30-rd curved mag (separate `magazine` node), 2-point sling',
                    'grenades': 'F-1 (segmented 55 mm cast body) and RGD-5 (smooth 58 mm egg with seam), both with UZRGM fuze, spoon and pull ring',
                    'pkm': 'PKM 1190 mm: stamped receiver, ribbed feed cover + tray, fluted barrel, gas cylinder under the barrel, folded bipod, '
                           'barrel carry handle, slotted flash hider, skeleton stock, 100-rd box with belt feeding the tray, sling',
                    'rpg7': 'RPG-7V: birch heat guards with clamp bands, trigger group + pistol grip, plain rear hand grip, folding iron sights, PGO-7 optic on the left bracket, flared '
                            'venturi, sling, PG-7V (85 mm) round loaded',
                    'pm': 'Makarov PM (9x18): rounded blued slide with rear serrations and ejection port, fixed barrel, exposed checkered hammer, slide-mounted '
                          'safety/decocker (left), slide stop, hinged trigger guard, wrap-around red-brown bakelite grip with star emblem and checkering, heel '
                          'magazine catch, lanyard loop; grip raked 18.7 deg like the AK pistol grip so weapon_socket holds it with the rifle hand pose',
                    'texturing': 'one PBR atlas per weapon (base colour / ORM / tangent normal, JPEG), procedural with edge wear, cavity grime, '
                                 'stamped/moulded detail and stencils in the normal + colour maps; ~1100-1400 px/m on rifles'},
    }
    out['skeleton'] = {
        'rig': 'MakeHuman cmu_mb (CMU-BVH compatible names); joint nodes carry identity rest rotations (world-aligned frames); skins use inverse bind = translate(-joint).',
        'right_hand_bone': 'RightHand', 'left_hand_bone': 'LeftHand',
        'finger_bones': ['RightFingerBase', 'RightHandFinger1', 'RThumb', 'LeftFingerBase', 'LeftHandFinger1', 'LThumb'],
        'head_bone': 'Head', 'chest_bone': 'Spine1', 'root_bone': 'Hips',
        'sockets': {
            'weapon_socket': 'child of RightHand: parent a weapon GLB (origin = pistol grip, +Z muzzle) with identity transform; matches all rifle-hold clips',
            'weapon_socket_L': 'child of LeftHand: rifle carried by the handguard (grip_L in the palm) - use during throw_grenade',
            'weapon_socket_back': 'child of Spine1: slung rifle diagonally on the back, muzzle up over the right shoulder (RPG gunner, drag_wounded, wounded clips)',
            'mag_socket_L': 'child of LeftHand: attach ak74m `magazine` node during reloads',
            'aim': 'child of Head at the eye midpoint (eye height)', 'aim_eye_R': 'child of Head at the right eye (sighting eye)',
            'drag_handle': 'child of Spine1 at the vest drag handle (top of the back plate): contact point of being_dragged / drag_wounded'},
    }
    for fac in ('ru', 'ua'):
        g, tris, mats = read_glb(f'{ASSETS}/soldier_{fac}.glb')
        nodes = [n['name'] for n in g['nodes']]
        extras = {n['name']: n.get('extras') for n in g['nodes'] if n.get('extras')}
        lod0 = {k: v for k, v in tris.items() if not k.endswith('_LOD1')}
        default = [k for k in lod0 if (extras.get(k) or {}).get('default_visible', True)]
        out[f'soldier_{fac}'] = dict(
            file=f'soldier_{fac}.glb', size_bytes=os.path.getsize(f'{ASSETS}/soldier_{fac}.glb'),
            mesh_nodes_tris=lod0, lod1_tris={k: v for k, v in tris.items() if k.endswith('_LOD1')},
            default_visible=default, default_config_tris=int(sum(lod0[k] for k in default)),
            materials_by_node=mats, node_extras=extras,
            notes=('body_A/B/C are alternative variants (one visible at a time; A default). hands vs gloves are alternatives. '
                   'helmet_A/helmet_B alternatives. backpack, legband_L, kneepads, pouches_back off by default. '
                   'Gear is skinned to the shared skeleton (vest/pouches to Hips..Spine1/clavicles, helmet rigid to Head, kneepads rigid to *Leg, tape bands follow the sleeve weights). '
                   'Vertex colours (COLOR_0) on gear carry baked ambient occlusion.'),
            uniform_material={'ru': 'emr_camo (all variants)', 'ua': 'mm14_camo (A,B), mm14_multicam_camo (C: MultiCam top, MM-14 trousers)'}[fac],
            gear_materials=sorted({m for k, ms in mats.items() for m in ms}),
            node_list=nodes)
        cb = json.load(open(f'{CACHE}/combos_{fac}.json'))
        clean = lambda d: {k: v for k, v in d.items()}
        out[f'soldier_{fac}']['combos'] = [clean(d) for d in cb['combos']]
        out[f'soldier_{fac}']['assault_combos'] = [clean(d) for d in cb['assault_combos']]
        out[f'soldier_{fac}']['crew_combos'] = [clean(d) for d in cb.get('crew_combos', [])]
        out[f'soldier_{fac}']['crew_notes'] = (
            'Armoured-vehicle crew presets `crew_combo_<n>` (+ `crew_combo_<n>_tape`, + `_LOD1` siblings): same skeleton, skin and sockets as the infantry, '
            f'ONE material each (soldier_atlas_crew_{fac}: its own 2048^2 atlas, base colour / normal / ORM like the infantry atlas), so 2 draw calls per '
            'crewman. Look: one-piece crew coverall (' + ('RU: olive-khaki or EMR' if fac == 'ru' else 'UA: MM-14 or olive') + ') with full-length front zip, '
            'slanted chest zip pockets, thigh pockets, quilted knee / elbow pads, elastic waist and ankle tabs, flag patch on the left sleeve; Soviet padded '
            'tanker helmet (shlemofon TSh: longitudinal padded rolls, forehead roll, ear-phone housings, chin strap) black or olive, throat microphone band with '
            'the intercom cable; waist belt with a PM flap holster on the right hip and a utility pouch; light soft armour vest on presets 1 and 2; gloves or '
            'bare hands; boots; armbands / right thigh band with the recolourable `tape` material exactly like the infantry presets; no rucksack, no rifle '
            '(pistol: pm.glb in weapon_socket). No per-part crew nodes are written (only the presets), hidden by default (extras.combo = true).')
        out[f'soldier_{fac}']['combo_notes'] = (
            'Pre-combined presets for rendering (2 draw calls per soldier): `<name>` = ONE SkinnedMesh / ONE primitive with material '
            f'soldier_atlas_{fac} (2048^2 atlas: base colour JPEG, normal PNG, ORM PNG [R=AO 1, G=roughness, B=metalness]) merging every visible part '
            '(body/head/eyes, hands or gloves, boots, vest, pouches, helmet, backpack, kneepads, assault armour, headset, balaclava); `<name>_tape` = '
            'the preset\'s arm/leg bands with the recolourable `tape` material; `<name>_LOD1` / `<name>_tape_LOD1` ~28% / ~40%. Same skeleton/skin as '
            'the per-part nodes, so all sockets keep working. extras.combo = true, hidden by default (show exactly one preset + its _tape and hide all '
            'per-part nodes). Camouflage is identical to the per-part materials: the uniform is copied texel-for-texel (90-degree turns only) at '
            f'{"~1.0" if fac == "ru" else "~1.3"} mm/texel (EMR / MM-14 pixels stay 3.5-6 texels wide), tiling gear camo is mapped into one wrap-padded '
            'repeat region per material at the same pattern scale (gear triangles never cross a repeat: components are shifted by whole tiles), vertex '
            'colours keep the baked AO. Balaclava presets drop the covered face triangles.')
    out['soldier_ru']['tape_alt_material'] = 'tape (white #e9e9e4); for red tape set tape colour to #b01e1e (tape_red); materials named `tape` are recolourable'
    out['soldier_ua']['tape_alt_material'] = 'tape (yellow #e8c31c)'
    g, tris, mats = read_glb(f'{ASSETS}/soldier_anims.glb')
    ca = {a['name']: a for a in g['animations']}
    acc = g['accessors']
    cl = {}
    for name, c in clips.items():
        cl[name] = dict(duration_s=round(c['dur'], 3), frames=len(c['lq']), fps=30, loop=bool(c['loop']),
                        ground_speed_mps=round(abs(c['speed']), 3) if c['speed'] else 0.0,
                        direction='backward (-Z)' if c['speed'] < 0 else ('forward (+Z)' if c['speed'] > 0 else 'in place'),
                        root_motion=bool(c['root_motion']), notes=c['notes'])
    events = {
        'fire_stand': {'shot': 0.0},
        'reload_stand': {'mag_out': 0.70, 'mag_in': 1.80, 'charging_handle': 2.10},
        'reload_crouch': {'mag_out': 0.70, 'mag_in': 1.80, 'charging_handle': 2.10},
        'throw_grenade': {'move_weapon_to': 'weapon_socket_L', 'release_approx': 1.25},
        'death_front': {'drop_weapon': 0.2}, 'death_back': {'drop_weapon': 0.1}, 'death_crumple': {'drop_weapon': 0.3},
        'drag_wounded': {'weapon': 'weapon_socket_back'}, 'wounded_ground': {'weapon': 'drop or weapon_socket_back'},
        'wounded_crawl': {'weapon': 'drop or weapon_socket_back'}, 'being_dragged': {'weapon': 'drop or weapon_socket_back'},
        'wounded_sit': {'weapon': 'drop or weapon_socket_back'},
        'prone_crawl': {'weapon': 'weapon_socket (right hand; the rifle lies on the right forearm, the left hand is free)'},
    }
    for k in ('pistol_idle', 'pistol_aim', 'pistol_fire', 'pistol_walk', 'pistol_run', 'pistol_crouch_aim'):
        events[k] = {'weapon': 'pm.glb in weapon_socket (identity); support hand on the grip (pm grip_L)'}
    events.setdefault('pistol_fire', {})['shot'] = 0.0
    for k, v in events.items():
        if k in cl:
            cl[k]['events'] = v
    for name, c in clips.items():
        if c.get('events'):
            cl[name]['events'] = dict(cl[name].get('events', {}), **c['events'])
        if c.get('seat'):
            cl[name]['seat_type'] = c['seat']
        if c.get('hatch'):
            cl[name]['hatch'] = c['hatch']
    out['soldier_anims'] = dict(file='soldier_anims.glb', size_bytes=os.path.getsize(f'{ASSETS}/soldier_anims.glb'),
                                contents='skeleton + sockets + clips only (no meshes); tracks: Hips translation + rotation of all 31 joints, 30 fps, linear',
                                in_place='loops have horizontal root motion stripped (Hips keeps vertical bob); deaths and dismount_jump keep root motion and end at rest',
                                time_scaling='ground_speed_mps is the clip\'s natural speed; the game time-scales by speed / ground_speed_mps. '
                                             f'walk_rifle is a native {clips["walk_rifle"]["speed"]:.2f} m/s tactical walk (CMU 07_01, pelvis lowered, soft knees, rifle at low ready; '
                                             f'game 1.55 m/s = x{1.55 / clips["walk_rifle"]["speed"]:.2f}) and run_rifle a native {clips["run_rifle"]["speed"]:.2f} m/s weighty combat run '
                                             f'(CMU 16_45, bent knees, 12 deg lean, rifle at port; game 4.2 m/s = x{4.2 / clips["run_rifle"]["speed"]:.2f}). The planted foot is pinned to the '
                                             'ground sliding back at exactly ground_speed_mps, so there is no foot sliding at those speeds.',
                                rifle_fire=dict(
                                    clips='fire_stand / fire_crouch / fire_prone / fire_peek_left / fire_peek_right / fire_peek_crouch_left / fire_peek_crouch_right',
                                    cycle='each clip is ONE shot (0.133 s, 5 frames): event shot at 0.0 (muzzle flash / tracer / sound), peak kick at 0.033 s '
                                          '(butt drives the shoulder ~2 cm back, muzzle climbs ~3 deg pivoting at the butt, chest and cheek absorb), recovered by 0.133 s. '
                                          'First and last frame == the matching aim pose (aim_stand / aim_crouch / aim_prone / peek_* frame 0), so the clip loops '
                                          'seamlessly during a burst (one recoil cycle per loop) and cross-fades back into the aim clip.'),
                                peeks=dict(
                                    clips='peek_left / peek_right (standing), peek_crouch_left / peek_crouch_right (kneeling), 2 s loops',
                                    geometry='leaning out around a wall corner while aiming straight ahead (+Z): trunk rolled 22-28 deg about the aim axis to the '
                                             'named side (the soldier\'s own left / right), weight on that leg, feet / knee planted, rifle on the right shoulder canted '
                                             '11-12 deg (right peeks) / 32-40 deg (left peeks: the cheek stays on the stock), right eye on the sight line, butt in the '
                                             'shoulder pocket (< 1.5 cm). The head sits 0.23-0.36 m to the lean side of the root (events.head_out_m): with the '
                                             'corner edge ~0.15 m to the lean side of the root, head and rifle are past the edge and the far shoulder / hip stay behind it.'),
                                cover=dict(
                                    cover_duck='deep squat tight behind a low wall / window sill in front (+Z, wall face ~0.42 m ahead of the root), head below '
                                               'a 0.9-1.0 m parapet (see events.head_top_m), rifle vertical and close, flinches (events.flinch); 3 s loop',
                                    pinned_prone='flat prone, face down, left forearm over the helmet, rifle lying on its side beside the body (still in '
                                                 'weapon_socket), flinches (events.flinch); 3 s loop'),
                                launchers=dict(
                                    socket='weapon_socket (identity) for both rpg22.glb and rpg7.glb in aim_launcher / aim_launcher_kneel / fire_launcher',
                                    authored_for='RPG-22: right eye on the rear-sight line, tube underside on the right trapezius, right hand on the tube under the '
                                                 'firing housing (= launcher origin), left palm under the front tube (rpg22 grip_L).',
                                    rpg7_offset=dict(position=[0.0, 0.0, 0.0], note='RPG-7 also fits with identity: its tube axis is 7 mm higher and its PGO-7 eyepiece '
                                                     'sits 5 cm left / 4 cm below the eye (head over the tube instead of beside it). For an exact PGO-7 sight picture '
                                                     'offset the launcher by [-0.051, 0.042, 0.0] (launcher local), at the cost of a 4 cm gap above the shoulder.'),
                                    rpg22_offset=dict(position=[0.0, 0.0, 0.0]),
                                    sequence='launcher_raise[_kneel] (0.8 s, plays once: ready stance with the launcher carried low in both hands -> on the right '
                                             'shoulder; last frame == aim_launcher[_kneel] frame 0) -> aim_launcher[_kneel] (loop) -> fire_launcher[_kneel] (1.0 s, plays '
                                             'once from the aim pose: shot / backblast at 0.05 s, tube jump, head flinch, standing half step back; recoil done by ~0.45 s, '
                                             'then the head comes off the sight and the empty tube dips). Attach rpg22.glb to weapon_socket when the raise starts.'),
                                riding=dict(
                                    frame='ride_sit_edge / ride_sit_deck / ride_aim: root = ride_seat_N empty (point on the sitting surface under the pelvis), '
                                          '+Z = seat facing; Hips joint 0.118 m above and 0.035 m behind the seat point; place the soldier root exactly on the seat '
                                          'empty (position + heading), no ground snapping.',
                                    edge='thighs along +Z, knees ~0.42 m out, shins angled ~30 deg outward (clears the BTR\'s sloped upper hull), rifle across the lap',
                                    deck='knees up, feet flat on the deck ~0.47 m ahead, rifle upright between the knees, butt on the deck',
                                    dismount_jump='root on the ground at the landing point; the clip starts with the seat point at (0, 1.8, -1.6) relative to it '
                                                  '(game: landing = seat + 1.6 m outward, seat ~1.8 m high); vertical and horizontal root motion kept; touchdown 0.84 s'),
                                medical=dict(
                                    drag='drag_wounded (dragger) and being_dragged (casualty) share a 2.5 s loop. Casualty root = dragger root + 1.0 m along the '
                                         'dragger facing, casualty heading = dragger heading + 180 deg (head towards the dragger). Contact point = socket drag_handle '
                                         '(Spine1) at (0, 0.50, 0.42) in the casualty frame = (0, 0.50, 0.58) in the dragger frame (both hands).',
                                    treat_wounded='medic kneels; the casualty (wounded_ground / wounded_sit) lies ~0.55 m in front of the medic root',
                                    wounded_sit='back against a wall plane 0.30 m behind the root (-Z)'),
                                crawls=dict(
                                    prone_crawl='military low crawl ("po-plastunski"), rebuilt: body flat on the ground (bare torso ~0.6 cm above it in every frame), '
                                                'rifle lying on the right forearm (right hand on the pistol grip = weapon_socket, left hand free), contralateral cycle '
                                                '(right elbow + left leg drive, then left elbow + right leg), frog-kick legs: the planted boot is still in the world '
                                                '(slides back at exactly ground_speed_mps in the in-place clip), the recovering leg slides forward with the knee out, '
                                                'boots never lifted; the chest rises / rolls over the pulling elbow so the elbow stays planted (< 5 cm creep).',
                                    wounded_crawl='belly drag, rebuilt: palms reach, plant (still in the world) and pull alternately, left leg short frog push, '
                                                  'right leg dead (dragged, boot rolled out), head up; ground_speed_mps 0.24.'),
                                pistol=dict(
                                    clips='pistol_idle (two-handed low ready) / pistol_aim (isosceles, right eye on the sight line) / pistol_fire (one shot, '
                                          '0.267 s, first/last frame == pistol_aim frame 0, loops for follow-up shots, event shot at 0.0) / pistol_walk '
                                          '(aiming walk 1.47 m/s, gun stabilised) / pistol_run (compressed ready 4.17 m/s) / pistol_crouch_aim (kneeling aim)',
                                    socket='pm.glb parented to weapon_socket with identity (same as the rifles); the support palm sits on pm grip_L',
                                    note='the crew presets have no rifle: parent pm.glb to weapon_socket for these clips (holster stays on the belt)'),
                                hatch_exit=dict(
                                    clip='hatch_exit, 2.7 s, plays once, root motion in the Hips track (vertical + horizontal), no weapon in the hands',
                                    frame='clip space = the soldier root at the END of the clip: on the ground beside the vehicle, facing away from it (+Z). '
                                          'Authored for a T-72-sized vehicle and its commander hatch: rim centre at (0, 2.25, -1.80) relative to that root, hatch '
                                          'radius 0.33 m, turret roof y 2.20 up to z -1.15, fender / hull deck y 1.45 up to z -0.42, crewman starts standing on '
                                          'the inside floor at y 0.42 (hips 0.92 m below the rim).',
                                    game='place the soldier root at R = hatch_centre_world + exit_dir * 1.80 at ground height (y = ground), heading = exit_dir '
                                         '(perpendicular to the vehicle side, pointing away from it), then play hatch_exit once with no further root movement; '
                                         'when it ends the soldier stands at R. For a hatch at height H != 2.25 add (H - 2.25) to the root y for t < events.on_fender '
                                         'and blend it to 0 by events.landed (or accept the mismatch; the clip is tuned for T-72 / BTR-82A turret heights).',
                                    events='hands_on_rim [0, 0.66], hips_clear_rim 0.50, knee_on_deck 0.70, on_deck 1.01, step_off 1.08, on_fender 1.37, '
                                           'jump 1.60, landed 2.19 (s)'),
                                sources='CMU mocap: walk 07_01, run 16_45, crouch walk 136_09, limp 77_19, drag 81_08 (legs), death_back 90_18, throw 113_24. '
                                        'Pistol walk / run reuse 07_01 / 16_45 legs. Hand-keyed + IK: crawls, hatch_exit, pistol aim / idle / fire. '
                                        'Arms of all rifle clips are IK-solved onto the AK grips (right hand = weapon_socket, left hand = grip_L) then baked. '
                                        'Aim clips: authored cheek-weld head posture, gun on the sight line through the right eye, chest/clavicle solved to bring the butt to the shoulder pocket.',
                                clips=cl)
    wi = json.load(open(f'{CACHE}/weapons_info.json'))
    for w in ('ak74m', 'pkm', 'rpg7', 'rpg22', 'ak12', 'ak74m_optic', 'grenade_f1', 'grenade_rgd5', 'pm'):
        if not os.path.exists(f'{ASSETS}/{w}.glb') or w not in wi:
            continue
        g, tris, mats = read_glb(f'{ASSETS}/{w}.glb')
        out[w] = dict(file=f'{w}.glb', size_bytes=os.path.getsize(f'{ASSETS}/{w}.glb'), tris=tris, materials=sorted({m for ms in mats.values() for m in ms}),
                      empties={k: v[0] for k, v in wi[w]['empties'].items()},
                      conventions='origin = pistol grip (palm centre), +Z = muzzle, +Y up, weapon left side = +X; `<name>_LOD1` node = LOD1 '
                                  '(the magazine LOD1 is a child of `magazine`); one atlas material per weapon',
                      texel_px_per_m=wi[w].get('texel_px_per_m'))
    out['ak74m']['magazine_node'] = 'magazine (separate mesh; hide/reparent to mag_socket_L during reloads; its LOD1 `magazine_LOD1` is a child and moves with it)'
    for w in ('ak12', 'ak74m_optic'):
        if w in out:
            out[w]['magazine_node'] = 'magazine (separate mesh, same as ak74m)'
            out[w]['aim_note'] = ('The aim clips are solved for the AK-74M iron-sight line; with the optic the sight line is ~4-5 cm higher '
                                  '(optic_eye empty), i.e. the cheek sits slightly low on the stock - invisible at game distances.')
    out['ak12']['description'] = ('AK-12 (6P70, 2020 pattern): railed dust cover with folded rear diopter, railed polymer handguard with M-LOK slots, '
                                  'gas-block front sight, AK-12 muzzle brake, telescoping/side-folding stock with cheek riser and rubber pad, ribbed black '
                                  '30-rd mag, 1P87 (PK-120) collimator (olive) on the rail, sling')
    out['ak74m_optic']['description'] = ('UA AK-74M: black 6P20 furniture and magazine, quick-detach dovetail side mount with a Kobra-style collimator '
                                         '(tilted amber window), bottom rail on the lower handguard with a vertical foregrip, side-folding stock, sling')
    if 'rpg22' in out:
        out['rpg22']['carried'] = dict(file='rpg22_carried.glb', note='collapsed transport configuration, origin at the tube centre')
        out['rpg22']['conventions'] = 'origin = right hand on the tube under the firing housing, +Z muzzle, +Y up; parent to weapon_socket for the launcher clips'
    if 'rpg7' in out:
        out['rpg7']['grip_L_note'] = ('grip_L sits under the front heat guard (z = 0.17), where the launcher clips put the left palm '
                                      '(clips_extra.LAUNCHER); the plain rear hand grip (z = -0.12) is left free, the right hand holds the trigger grip at the origin')
    for w in ('grenade_f1', 'grenade_rgd5'):
        if w in out:
            out[w]['conventions'] = ('origin = grip (palm centre when held in weapon_socket / the right hand), +Y = fuze up, spoon on the palm side (-X), '
                                     'pull ring on +Z; empties centre, fuze, pin_ring')
    if 'pm' in out:
        out['pm']['description'] = ('Makarov PM (9x18), used by both sides (crew sidearm): blued slide / frame, bakelite grip; one mesh + LOD1, one atlas; '
                                    'origin = palm centre on the grip, +Z muzzle; grip_L = support (left) palm on the left grip panel for the two-handed clips; '
                                    'extra empties: ejection (port, right), holster_ref')
        out['pm']['hold'] = 'parent to weapon_socket (RightHand) with identity for pistol_* clips'
    out['deviations'] = [
        'Uniform is part of each body_X SkinnedMesh (head + eyes + uniform); boots are a separate always-on node `boots`; `gloves` is an alternative to `hands`.',
        'Extra nodes beyond the contract: gloves, boots, kneepads, legband_L, pouches_front/side/back split, helmet_B per faction, *_LOD1 for every mesh node.',
        'Extra sockets: weapon_socket_L, mag_socket_L, aim_eye_R. AK-74M magazine is a separate node.',
        'tape_red is not a separate material in the GLB (unused glTF materials are dropped by loaders); recolour `tape` instead (value given above).',
        'throw_grenade needs the rifle moved to weapon_socket_L; wounded/drag/death clips expect the game to drop or sling the rifle.',
        'Full kit (both legbands + kneepads + backpack + pouches_back) slightly exceeds 25k tris; default configuration is listed in default_config_tris.',
        'Assault presets carry ~28-30k tris (armour + 4 extra pouch groups + headset/balaclava); use their _LOD1 (~8k) beyond close range.',
        'GLBs use KHR_mesh_quantization (required) for int8 normals; weights are normalized u8, atlas UVs normalized u16 (all native in three.js GLTFLoader).',
        'Vehicle crew: crew_combo_N presets live in soldier_ru.glb / soldier_ua.glb with their own atlas material soldier_atlas_crew_<fac>; no per-part crew nodes.',
        'prone_crawl holds the rifle in the right hand only (left hand free) - it no longer uses the prone support grip.',
    ]
    json.dump(out, open(f'{ASSETS}/manifest.json', 'w'), indent=1)
    print('manifest written', {k: out[f'soldier_{k}']['default_config_tris'] for k in ('ru', 'ua')})


if __name__ == '__main__':
    main()
