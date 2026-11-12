"""Regenerate all vehicle GLBs + assets/vehicles/manifest.json.

    cd <repo> && nice -n 10 python3 tools/blender/vehicles/build_all.py [btr82a btr80_ua t72b3 t72av_ua bmp3 bradley_ua]

Each vehicle builds in its own process (fresh bpy state).  ~1-1.5 min per vehicle on 2 cores
(Cycles is used only for low-sample *data* bakes: position / normal / AO+edge, see vtex.py).
"""
import sys, os, json, subprocess, time
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
CACHE = '/tmp/vehicle_bake_cache'
SCRIPTS = {'btr82a': 'btr.py', 'btr80_ua': 'btr.py', 't72b3': 't72.py', 't72av_ua': 't72.py', 'leopard2a6': 'leopard.py'}

SOURCES = {
    'btr': [
        'https://www.army-technology.com/projects/btr-82a-armoured-personnel-carrier/ (BTR-82A: 7.65 x 2.9 x 2.8 m, 15.4 t, 3+7, 2A72 + PKTM, 3 smoke launchers per side, -7..+70 deg)',
        'https://www.zr.ru/content/articles/976783-osobennosti-btr-82v/ (BTR-82: 7.7 x 2.9 m, height 2.41 m (MG turret) / 2.725 m (BTR-82A), clearance 475 mm, BPU-1 KPVT + PKT)',
        'https://warwheels.net/images/BTR80datasheet.pdf (BTR-80: wheel track 2.41 m, tyres 13.00x18 run-flat, clearance 475 mm, 7.55 x 2.95 x 2.41 m)',
        'https://koi.legion.wplus.net/guide/army/ta/btr80.shtml (axle spacing 1.35 + 1.95 + 1.35 m, central tyre inflation, 902V Tucha x6)',
        'https://en.wikipedia.org/wiki/BTR-80 (split side doors between axles 2 and 3, ball-mount firing ports, BPPU on BTR-80A/82A)',
        'https://www.globalsecurity.org/military/world/russia/btr-80-specs.htm (BTR-80 7.55 x 2.95 x 2.41 m, KPVT + PKT, 6 x 81 mm launchers)',
        'https://en.wikipedia.org/wiki/BTR-80 (side doors: upper part opens forward, lower part folds down as a step; round ball-mount ports, the forward ones in angled recesses; rear raised and engine compartment squared off; 6 smoke projectors on the turret rear; KPVT/PKT elevate to 60 deg)',
    ],
    'leopard2': [
        'https://en.wikipedia.org/wiki/Leopard_2 (hull 7.72 m, 10.97 m gun forward with the L/55, width 3.75 m, height 2.48 m to the turret roof / 3.0 m overall, 2A5: wedge-shaped spaced add-on armour on the turret front and sides, EMES 15 moved to the roof, PERI R17 behind the commander\'s hatch; 2A6: Rh-120 L/55)',
        'https://knds.com/en/products/systems/leopard/leopard-2-a6 (manufacturer: 120 mm L/55, crew 4, MTU MB 873 Ka-501 1,100 kW)',
        'https://www.inetres.com/gp/military/cv/tank/Leopard2.html (ground clearance 0.54 m, turret top 2.48 m, 7 dual road wheels and 4 return rollers a side, 635 mm track)',
        'https://en.wikipedia.org/wiki/Leopard_2#Ukraine (18 Leopard 2A6 from Germany and 3 from Portugal delivered in March 2023; first losses near Mala Tokmachka, 8 June 2023)',
    ],
    't72': [
        'https://www.globalsecurity.org/military/world/russia/t-72-specs.htm (hull 6.86-6.91 m, 9.53 m gun forward, width 3.58-3.77 m, turret roof 2.226 m, clearance 0.49 m)',
        'https://en.wikipedia.org/wiki/T-72 (hull 6.67-6.86 m, width 3.40-3.59 m, height 2.23 m, 0.58 m tracks, T-72B3 Sosna-U, Relikt/Kontakt-5 ERA, T-72A skirts)',
        'https://commons.wikimedia.org/wiki/Category:T-72B3_mod._2016 (V. Kuzmin walkaround T-72B3mod2016-02..36: side photo fitted on the road wheels -> fender/skirt top 1.34 m, turret ring ~0.5 m behind the hull centre line of wheels 3/4, Sosna-U right of the gun, 8 x 902G left, ERA packs on the skirts, slat screens rear; models_v18)',
    ],
}

STATIC = {
    'btr82a': dict(faction='RU', name='BTR-82A', kind='btr', crew=3, passengers=7, game_dismounts=8,
                   real_dimensions_m=dict(length=7.65, width=2.90, height=2.80, ground_clearance=0.475, wheel_track=2.41,
                                          axle_spacing=[1.35, 1.95, 1.35], tyre='KI-80 13.00x18 (dia ~1.12 m)'),
                   armament=['30 mm 2A72 (muzzle)', '7.62 mm PKTM coaxial (coax_muzzle)', '6 x 81 mm 902V Tucha (smoke_launchers)'],
                   markings='none (plain field-worn 4BO-style green, dust)'),
    'btr80_ua': dict(faction='UA', name='BTR-80', kind='btr', crew=3, passengers=7, game_dismounts=8,
                     real_dimensions_m=dict(length=7.65, width=2.90, height=2.41, ground_clearance=0.475, wheel_track=2.41,
                                            axle_spacing=[1.35, 1.95, 1.35], tyre='KI-80 13.00x18 (dia ~1.12 m)'),
                     armament=['14.5 mm KPVT (muzzle)', '7.62 mm PKT coaxial (coax_muzzle)', '6 x 81 mm 902V Tucha (smoke_launchers)'],
                     markings='white crosses on both hull sides, rear plate and roof; green base with brown + khaki disruptive patches'),
    't72b3': dict(faction='RU', name='T-72B3', kind='tank', crew=3, passengers=0,
                  real_dimensions_m=dict(hull_length=6.86, length_gun_forward=9.53, width_over_tracks=3.46, width_with_skirts=3.59,
                                         height_turret_roof=2.23, ground_clearance=0.49, track_width=0.58, track_centres=2.79,
                                         road_wheel_diameter=0.75, road_wheels_per_side=6, return_rollers_per_side=3),
                  armament=['125 mm 2A46M-5 (muzzle)', '7.62 mm PKT coaxial (coax_muzzle)', '12.7 mm Kord on commander cupola (no empty)',
                            '8 x 81 mm 902G smoke (smoke_launchers)'],
                  markings='none'),
    'leopard2a6': dict(faction='UA', name='Leopard 2A6', kind='tank', crew=4, passengers=0,
                       real_dimensions_m=dict(hull_length=7.72, length_gun_forward=10.97, width_with_skirts=3.75, height_turret_roof=2.48,
                                              ground_clearance=0.54, track_width=0.635, track_centres=2.785, road_wheel_diameter=0.70,
                                              road_wheels_per_side=7, return_rollers_per_side=4, gun_tube=6.6),
                       armament=['120 mm Rh-120 L/55 (muzzle)', '7.62 mm MG3 coaxial (coax_muzzle)', '7.62 mm MG3 on the loader hatch rail (no empty)',
                                 '2 x 8 76 mm smoke dischargers (smoke_launchers)'],
                       markings='Bundeswehr three-colour camouflage (bronze green / leather brown / tar black), small white crosses on the turret stowage boxes'),
    't72av_ua': dict(faction='UA', name='T-72AV', kind='tank', crew=3, passengers=0,
                     real_dimensions_m=dict(hull_length=6.86, length_gun_forward=9.53, width_over_tracks=3.46, width_with_skirts=3.59,
                                            height_turret_roof=2.19, ground_clearance=0.49, track_width=0.58, track_centres=2.79,
                                            road_wheel_diameter=0.75, road_wheels_per_side=6, return_rollers_per_side=3),
                     armament=['125 mm 2A46M (muzzle)', '7.62 mm PKT coaxial (coax_muzzle)', '12.7 mm NSVT on commander cupola (no empty)',
                               '12 x 81 mm 902B smoke (smoke_launchers)'],
                     markings='white crosses on turret side bins, side skirts, turret rear; green/black/brown camo'),
}

def vbuild_hatch_convention():
    # kept in sync with vbuild.HATCH_CONVENTION (vbuild needs bpy, so the text is duplicated here)
    return ('Openable crew hatches: every crew hatch lid is a mesh hatch_lid_<role>_geo (+ _LOD1) under a hinge EMPTY '
            'hatch_lid_<role> whose origin lies on the hinge axis, parented to turret (turret hatches) or hull (hull hatches). '
            'Closed = rotation 0 (identity). vehicles.<name>.hatch_lids.<node> = {role, axis, open, parent, rim}: set '
            'node.rotation[axis] = open (radians, three.js local axes of the hinge empty) to open it; interpolate from 0. '
            'rim = the hatch_<role> rim-centre empty (bail-out start point; it does not move). '
            'Wrecks (hull_wreck / turret_wreck) carry the lids baked in the OPEN pose (crew bailed out).')

CONVENTIONS = {
    'frame': 'metres, glTF Y-up, forward +Z, vehicle right = -X, origin on the ground at the footprint centre',
    'hierarchy': ('Transform nodes from the spec (root, hull, turret, gun_pivot, wheel_*, roadwheel_*, sprocket_*, idler_*) are EMPTIES; '
                  'their geometry is a child mesh named <node>_geo with a sibling <node>_geo_LOD1. This keeps every mesh a leaf so LOD '
                  'switching by toggling mesh.visible (as soldier.js does) never hides child transforms. track_L/track_R are leaf meshes '
                  'directly under hull (with track_L_LOD1/track_R_LOD1).'),
    'pivots': 'turret yaws about local Y at the ring centre; gun_pivot pitches about local X at the trunnion; wheels/roadwheels/sprockets/idlers spin about local X at the hub',
    'running_gear_parent': 'wheels, sprockets, idlers and tracks are children of hull (not root) so hiding hull for the wreck swap hides the whole intact vehicle',
    'hidden_by_default': 'nodes with extras.hidden = true (three.js userData.hidden): every *_LOD1 and hull_wreck / turret_wreck. The game must set visible=false on load (glTF has no visibility flag).',
    'wrecks': 'hull_wreck and turret_wreck are direct children of root (siblings of hull) so the turret wreck can be thrown independently; turret_wreck origin = turret ring centre. BTR wreck sits on bare rims (tyres burnt away, hull dropped ~0.3 m); tank wreck sits 4 cm lower. Wrecks use decimated (~45%) copies of the LOD0 geometry with a burnt material sharing the paint atlas UVs.',
    'lod': '<mesh>_LOD1 = collapse-decimated copy (~30% tris) in the same local space as <mesh>; instanced wheel meshes share one LOD1 mesh.',
    'materials': '<vehicle>_paint: one 2048 atlas (albedo JPEG 2048, ORM PNG 1024 [R=1, G=roughness, B=metalness], normal PNG 1024) for all painted steel, rubber tyres, wood, canvas, MG metal; glass; light_lens; track (alphaMode MASK) ; <vehicle>_wreck + track_wreck for the burnt variants.',
    'track_uv': 'track_L/track_R: U = link index along the loop (1.0 per link, 97 links -> U 0..97), V across the profile. Scroll the track material map/normalMap/roughnessMap offset.x by distance_travelled / track_link_pitch_m (sign by direction; L and R share the material, so clone it per side for skid steering). Guide horns and the gaps between links are alpha-tested, so they scroll with the texture.',
    'cope_cage': 't72b3 only: separate mesh node turret/cope_cage (+LOD1) so the game can toggle it.',
    'empties': ('muzzle, coax_muzzle under gun_pivot; smoke_launchers and (tanks) commander_hatch under turret; exhaust, dismount_L, dismount_R and (BTR) commander_hatch under hull. Tank dismount_L/R mark crew bail-out points beside the hull. '
                'hatch_<role> (commander, gunner, driver, + cargo_* / bow_*): crew hatch rim centres (bail-out start points), under turret or hull.'),
    'hatch_lids': vbuild_hatch_convention(),
    'ride_seats': ('Desant riding positions: empties ride_seat_1..N under hull (BTR: 8, T-72: 6), listed per vehicle in ride_seats. '
                   'Origin = point under the rider pelvis on the sitting surface; local +Z = direction the rider faces, +Y = up. '
                   'extras.seat_type: "edge" = sitting on a deck edge / fender bin with the legs hanging over the side '
                   '(thighs along +Z, knees ~0.44 m out, shins down; on the BTR the upper hull side below the roof edge slopes '
                   'outward ~39 deg, so angle the shins out ~30 deg) or "deck" = sitting on the deck, legs forward along +Z '
                   '(knees up). Seats parent to hull, so riders follow hull motion; turret traverse never reaches them '
                   '(ride_clearance.turret_sweep_radius_m vs min_rider_margin_m, cope cage included), but the gun barrel '
                   'does: ride_clearance.gun_min_elevation_to_clear_riders_deg is the elevation the gun needs before it may '
                   'traverse over riders; when gun_can_clear_riders is false (T-72) lock the turret to the forward arc '
                   'while riders are aboard. The rider proxy used for these checks is drawn by '
                   'tools/blender/vehicles/preview.html?seats=1.'),
}

# IFVs (BMP-3 / M2A2 ODS-SA Bradley): data lives in ifv_data.py (no bpy), geometry in ifv.py.  ifv.py also merges its own
# manifest entry and writes assets/vehicles/<name>_armor.json, so it can be run on its own.
sys.path.insert(0, HERE)
import ifv_data
SCRIPTS.update({n: 'ifv.py' for n in ifv_data.STATIC})
SOURCES.update(ifv_data.SOURCES)
STATIC.update(ifv_data.STATIC)
# Self-propelled artillery (2S19M2 Msta-S / 2S22 Bohdana): data + armour + game stats in arty_specs.py (no bpy), geometry in
# msta.py / bohdana.py, which also merge their own manifest entries when run on their own.
import arty_specs
SCRIPTS.update(arty_specs.SCRIPTS)
STATIC.update(arty_specs.STATIC)

def vehicle_entry(n, info):
    v = dict(STATIC[n])
    v['file'] = f'assets/vehicles/{n}.glb'
    v['file_mb'] = info['file_mb']
    v['tris'] = dict(lod0=info['lod0_tris'], lod1=info['lod1_tris'], **info['wreck_tris'])
    v['model_bbox_m'] = dict(min=info['bbox_lod0'][0], max=info['bbox_lod0'][1],
                             size=[round(b - a, 3) for a, b in zip(*info['bbox_lod0'])])
    v['materials'] = info['materials']
    for k in ('track_link_pitch_m', 'track_length_m', 'track_links', 'ride_seats', 'ride_clearance', 'hatch_lids') + ifv_data.INFO_KEYS:
        if k in info:
            v[k] = info[k]
    v['hierarchy'] = info['hierarchy']
    if n in arty_specs.SCRIPTS:
        v = arty_specs.entry(n, info)
        arty_specs.write_armor(n)
    return v

def merge_manifest(names):
    """Locked read-modify-write of assets/vehicles/manifest.json (same lock file as ifv.py / arty_specs.py): replaces only
    vehicles.<n> for the given names that have a cached build info, refreshes conventions / sources."""
    import fcntl
    man_path = os.path.join(REPO, 'assets', 'vehicles', 'manifest.json')
    with open(man_path + '.lock', 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        man = {'generator': 'tools/blender/vehicles/build_all.py', 'conventions': dict(CONVENTIONS), 'sources': dict(SOURCES), 'vehicles': {}}
        if os.path.exists(man_path):
            try:
                old = json.load(open(man_path))
                man['vehicles'].update(old.get('vehicles', {}))
                man['sources'] = {**old.get('sources', {}), **SOURCES}
                man['conventions'] = {**old.get('conventions', {}), **CONVENTIONS}
            except Exception:
                pass
        done = []
        for n in names:
            p = os.path.join(CACHE, n + '_info.json')
            if n not in SCRIPTS or n in ifv_data.STATIC or not os.path.exists(p):    # ifv.py merges its own (richer) entry
                continue
            man['vehicles'][n] = vehicle_entry(n, json.load(open(p)))
            done.append(n)
        tmp = man_path + '.tmp_build_all'
        with open(tmp, 'w') as f:
            json.dump(man, f, indent=1)
        os.replace(tmp, man_path)
    print('wrote', man_path, done)

def main(names):
    os.makedirs(CACHE, exist_ok=True)
    for n in names:
        t = time.time()
        r = subprocess.run(['nice', '-n', '10', sys.executable, os.path.join(HERE, SCRIPTS[n]), n], cwd='/tmp',
                           capture_output=True, text=True)
        tail = [l for l in r.stdout.splitlines() if l.startswith('  ') or l.startswith('{')]
        print(n, 'exit', r.returncode, '%.0fs' % (time.time() - t))
        print('\n'.join(tail[-6:]))
        if r.returncode:
            print(r.stderr[-3000:])
            sys.exit(1)
    merge_manifest(names)

if __name__ == '__main__':
    main(sys.argv[1:] or list(SCRIPTS))
