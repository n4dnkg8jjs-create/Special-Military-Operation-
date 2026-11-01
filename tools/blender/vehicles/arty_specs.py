"""Self-propelled artillery: researched data, game stats, armour tables and manifest entries for
msta_s (2S19M2 Msta-S, RU) and bohdana (2S22 Bohdana, UA).

    python3 tools/blender/vehicles/arty_specs.py      # after msta.py / bohdana.py have run

writes assets/vehicles/<name>_armor.json and (read-modify-write) only vehicles.msta_s / vehicles.bohdana in
assets/vehicles/manifest.json.  build_all.py imports this module for full rebuilds.

Armour frame = src/game/armor.js: metres, x = vehicle right, y = up, z = forward, origin on the ground at the
hull centre; zone faces are mm RHA-equivalent against a horizontal shot (plate slope already folded in);
part flags follow armor.js (crew, ammo = cook-off chance, fuel = fire chance, engine, gun, optics, ring).
Authoring frame of the build scripts (X right, Y fwd, Z up) maps to it as (x, y, z) = (X, Z, Y).
"""
import os, json, sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
CACHE = '/tmp/vehicle_bake_cache'
SCRIPTS = {'msta_s': 'msta.py', 'bohdana': 'bohdana.py'}

SOURCES = {
    'msta_s': [
        'https://en.wikipedia.org/wiki/2S19_Msta-S (crew 5; 42 t; 7.15 x 3.38 x 2.99 m; armour 15 mm all-round; T-80 running gear + T-72 V-84A diesel; 2A64 L/47, -4..+68 deg, 360 deg; 6-8 rpm, 2S19M2 10 rpm; 50 rounds; ranges 24.7 km standard / 28.9-29 km base bleed / 36 km RAP; 60 km/h, 500 km)',
        'https://man.fas.org/dod-101/sys/land/row/2s19.htm (armour turret 15 / turret top 15 / hull 15 mm; burst 8, normal 6, sustained 2 rpm, 6-7 rpm from ground; OF-72 6.5-24.7 km, OF-61 BB 6.71-29 km; emplace / displace 1-2 min; 60 km/h road, 25 km/h off-road; 11.91 m long)',
        'https://www.globalsecurity.org/military/world/russia/2s19.htm (NSVT 5 x 60 = 300 rds on the PZU-5 mount; projectile conveyor stowed on the turret rear, charge conveyor inside; 7-8 rpm internal, 6-7 rpm ground fed, 2S19M2 up to 10 rpm; 3OF45 24.7 km, 3OF61 28.9 km, 3O23 cargo 26 km, 3NS30 jammer 22.3 km, Krasnopol 20 km; 6 road wheels + 5 return rollers, T-80 idler/sprocket; armour vs small arms and shell fragments)',
        'https://www.globalsecurity.org/military/world/russia/2s19-specs.htm (crew 5 + 2 in the ammo carrier; 15 mm turret/top/hull; 11.91 x 3.58 x 2.98 m; 1-2 min in/out of action; fording 1.5 m)',
        'https://koi.legion.wplus.net/guide/army/ar/2s19.shtml (crew: commander, driver, gunner, two loaders; 12.0 m gun forward, hull 7.15 m, 3.38 m, clearance 0.45 m, 580 mm track; 28 rds in the turret ready rack + 22 in the hull; 8 rpm first minute, 6-7 rpm for 3-5 min, 2-3 rpm long term; 60 km/h road, 30-35 km/h cross-country; 60-90 s march-to-first-round; two 6-tube 81 mm smoke launchers; its 50-80 mm armour figures contradict every other source and are not used)',
        'https://znanierussia.ru/articles/2%D0%A119 (11.917 m gun forward, 3.38 m width, track 2.8 m, clearance 450 mm, homogeneous steel armour, -4..+68 deg, 6 pairs of road wheels, fuel 1,300 l, 500 km)',
        'https://www.army-technology.com/?p=228338 (2S19M1: up to five crew, 3.38 m wide, -4..+70 deg, 8 rpm max, Krasnopol-M to 17 km, ground-fed projectiles, 60 km/h, 500 km)',
        'Wikimedia Commons photographs: AlabinoTraining0904-34, 2S19_Msta-S_PM_MWB_09, SPG_2S19M2_Msta-S_on_Oboronexpo_2014 (front + rear views), UA_Air_Assault_Forces_captured_Msta-SM2_01, T-80U_and_2S19M2 (shape, cupola on the right, side door on the right, rear conveyor, skirts with holes, A-frame travel lock)',
    ],
    'bohdana': [
        'https://en.wikipedia.org/wiki/2S22_Bohdana (crew 5; 28 t; 155 mm L/52; 5 rpm; 20 rounds; 42 km conventional / 60 km RAP; 80 km/h; 800 km road / 300 km off-road; 2018 prototype on KrAZ-6322, Bohdana 1.0 on KrAZ-63221; armoured cab variants; deployed by May 2022, adopted 21 July 2023)',
        'https://militarnyi.com/uk/news/rozrobnyky-rozkryly-harakterystyky-bogdany/ (IDEF 2023: 155 mm L/52, 5 rpm, 20 rounds, traverse -30..+30 deg, elevation -5..+65 deg, 40-42 km, 1.5 min into and 1.5 min out of action, 30 km/h off-road / 80 km/h road, 500 / 800 km, armoured cab with IR driving cameras)',
        'https://global.espreso.tv/ukraines-bohdana-self-propelled-howitzer-specifications-and-production-history (armoured cab protects against 7.62 mm B-32 at 30 m and fragments + mine protection; 4-6 rpm; minimum range 780 m; 40-42 km HE-frag, 45-60 km active-rocket; 6 rounds in the auto-feed (later versions) + 20 in containers; deploy ~1.5 min)',
        'https://www.army-technology.com/projects/2s22-bohdana-howitzer-ukraine/ (up to five crew; 8.5 x 2.7 x 4 m; 25 t; KrAZ-63221 6x6; elevation +5..+65 deg; 6 rpm; minimum 780 m; 42 km HEIAP / 50 km RAP; ~20 shells; 80 km/h; 1,000 km)',
        'KrAZ-6322 data (factory): 9.03 x 2.72 x 2.985 m, wheelbase 4,080 + 1,400 mm, track 2,160 mm, tyres 1300x530-533 with central inflation',
        'Wikimedia Commons photographs: 2S22_Bohdana_SPH_Kyiv_2018 (01, 03), 2S22_Bohdana_tests_2021 (01, 05), Bohdana_self-propelled_howitzer (cab, bonnet, mount, travel lock over the cab, folded / lowered spades, rear platform)',
    ],
}

STATIC = {
    'msta_s': dict(
        faction='RU', name='2S19M2 Msta-S', kind='spg', tracked=True, crew=5, passengers=0,
        crew_roles=['commander (turret right, cupola + remote 12.7 mm)', 'gunner (turret left front, 1P22/1P23 sights)',
                    'loader - projectiles (turret right rear)', 'loader - charges (turret left rear)', 'driver (hull front centre)'],
        mass_t=42,
        real_dimensions_m=dict(hull_length=7.15, length_gun_forward=11.92, width_over_tracks=3.38, width_with_skirts=3.58,
                               height_turret_roof=2.99, ground_clearance=0.45, track_width=0.58, track_centres=2.80,
                               road_wheel_diameter=0.67, road_wheels_per_side=6, return_rollers_per_side=5),
        armament=['152 mm 2A64 L/47 howitzer, two-chamber muzzle brake + bore evacuator (muzzle)',
                  '12.7 mm NSVT/Kord on the commander cupola remote mount (mg_muzzle), 300 rds',
                  '2 x 6 x 81 mm 902V smoke (smoke_launchers)'],
        markings='white "Z" on both turret sides and the turret rear (2022-24 Russian ID mark), plain field-worn green',
        options=['cope_cage: 2023-24 anti-drone screen over the turret (separate node, toggle)'],
    ),
    'bohdana': dict(
        faction='UA', name='2S22 Bohdana', kind='spg', wheeled=True, crew=5, passengers=0,
        crew_roles=['commander (cab front right)', 'driver (cab front left)', 'gunner (cab rear; deployed: gunner_station on the mount, left)',
                    'loader (cab rear; deployed: gun_crew_1 on the spade platform)', 'loader / ammo handler (cab rear; deployed: gun_crew_2..4)'],
        mass_t=28,
        real_dimensions_m=dict(length_truck=9.03, length_gun_forward_travel=9.95, width=2.72, height_cab_roof=3.0,
                               height_over_gun_travel=3.9, wheel_track=2.16, axle_spacing=[4.08, 1.40],
                               tyre='1300x530-533 (dia 1.30 m), central inflation', ground_clearance=0.36),
        armament=['155 mm L/52 howitzer (8.06 m tube), multi-baffle muzzle brake (muzzle)'],
        markings='white crosses on the cab sides, bonnet and cradle sides; green with black-green + khaki disruptive patches',
        chassis='KrAZ-6322/63221 6x6, 4-door armoured crew cab and armoured bonnet (2022-24 field version)',
    ),
}

# --------------------------------------------------------------------------------------------- game data
GAME = {
    'msta_s': dict(
        hp_suggestion=1100,
        speed_kmh=dict(road=60, off_road=30, note='FAS 25 km/h off-road, koi 30-35 km/h cross-country'),
        game_speed=8.5, accel=1.8, turn_rate=0.55,
        turret=dict(traverse_deg=[-180, 180], traverse_speed_deg_s=8, note='360 deg hydraulic/electric; traverse speed not published - game estimate'),
        gun=dict(elevation_deg=[-4, 68], elevation_speed_deg_s=5, travel_elevation_deg=-3.5,
                 note='gun rests in the glacis travel lock at -3.5 deg with the turret at 0'),
        rate_of_fire=dict(burst=dict(rounds=10, seconds=60, note='2S19M2 max 10 rpm first minute (2S19: 8)'),
                          normal_rpm=6, sustained_rpm=2, ground_fed_rpm=6.5),
        reload_s_per_round=6.0,
        range_m={'3OF45 HE-frag (OF-45)': 24700, '3OF61 HE-frag base bleed': 28900, 'HE-frag rocket assisted': 36000,
                 '3O23 cargo (cluster)': 26000, '3OF39 Krasnopol / Krasnopol-M (laser-guided)': 20000,
                 '3NS30 HF/VHF jammer': 22300, 'minimum (indirect)': 6500, 'direct fire (HEAT 3BK29 / BP-540)': 1000},
        ammo=dict(projectiles=50, charges=50, stowage='28 in the turret ready rack + 22 in the hull', mg_12_7mm=300,
                  ground_feed='projectile conveyor folded on the turret rear (ammo_feed empty) feeds from a 9T452 carrier / ground stack'),
        deploy=dict(time_s=60, pack_s=60, steps=['stop', 'fold travel_lock down (rotation.x 0 -> -45 deg)', 'lay gun'],
                    ground_feed_setup_s=180, source_range='1-2 min (FAS / GlobalSecurity); 60-90 s march to first round (koi)'),
        nbc=True, smoke=True, dozer_blade='self-entrenching, firing pit in 40-60 min',
    ),
    'bohdana': dict(
        hp_suggestion=700,
        speed_kmh=dict(road=80, off_road=30),
        game_speed=10.5, accel=2.4, turn_rate=0.5,
        turret=dict(traverse_deg=[-30, 30], traverse_speed_deg_s=5, note='open mount, +-30 deg sector over the cab; speed is a game estimate'),
        gun=dict(elevation_deg=[-5, 65], elevation_speed_deg_s=4, travel_elevation_deg=0.0,
                 note='rests on the cab-roof travel lock at 0 deg / traverse 0; depression below 0 only when |traverse| > 20 deg'),
        rate_of_fire=dict(burst=dict(rounds=3, seconds=40, note='game burst; published 4-6 rpm'), normal_rpm=5, sustained_rpm=2),
        reload_s_per_round=12.0,
        range_m={'HE-frag ERFB / base bleed (manufacturer)': 42000, 'HE-frag conventional (M107-class, L/52, estimate)': 24000,
                 'active-rocket / V-LAP (claimed)': 60000, 'RAP (army-technology)': 50000, 'M982 Excalibur (L/52, estimate)': 40000,
                 'minimum': 780},
        ammo=dict(projectiles=20, charges='modular / bagged for 20 rounds', stowage='containers on the platform (charges left, shells right)',
                  later_versions='4.0 adds a 6-round semi-automatic feed'),
        deploy=dict(time_s=90, pack_s=90,
                    steps=['stop', 'lower spade_L/spade_R (rotation.x 0 -> -85 deg, ~20 s)', 'lift gun off the cab travel lock (elevate >= 5 deg)', 'traverse / lay'],
                    must_be_deployed_to_fire=True),
        mine_protection=True,
    ),
}

ANIMATION = {
    'msta_s': {
        'frame': 'glTF node local rotations in radians (three.js), values below in degrees',
        'turret': 'rotation.y = traverse (positive = to the vehicle left), unlimited',
        'gun_pivot': 'rotation.x = -elevation; limits elevation -4..+68 deg -> rotation.x in [-68, +4] deg; travel pose rotation.x = +3.5 deg (gun at -3.5 deg in the lock)',
        'travel_lock': 'rotation.x: 0 = raised A-frame clamping the barrel (travel); -45 deg = folded back onto the glacis (deployed)',
        'cope_cage': 'mesh under turret (+ cope_cage_LOD1): set visible=false to remove the anti-drone screen',
        'deployed_pose': {'travel_lock.rotation.x': -45, 'gun_pivot.rotation.x': -45, 'turret.rotation.y': 'target bearing'},
        'travel_pose': {'travel_lock.rotation.x': 0, 'gun_pivot.rotation.x': 3.5, 'turret.rotation.y': 0},
        'running_gear': 'roadwheel_*, sprocket_*, idler_* spin about local X; track_L/track_R scroll U (see track_link_pitch_m)',
        'empties': ['muzzle', 'mg_muzzle', 'smoke_launchers', 'commander_hatch', 'hatch_commander', 'hatch_gunner',
                    'hatch_loader_roof_L', 'hatch_loader_roof_R', 'hatch_side_R', 'hatch_ammo_rear', 'ammo_feed', 'hatch_driver',
                    'exhaust', 'dismount_L', 'dismount_R'],
    },
    'bohdana': {
        'frame': 'glTF node local rotations in radians (three.js), values below in degrees',
        'turret': 'gun mount turntable: rotation.y = traverse (positive = to the vehicle left), limits -30..+30 deg',
        'gun_pivot': 'rotation.x = -elevation; limits -5..+65 deg -> rotation.x in [-65, +5] deg; travel pose 0 (barrel on the cab travel lock)',
        'spade_L / spade_R': 'hinged at the rear frame end, rotate about local X: 0 = folded up for travel (leaning back ~65 deg, teeth pointing back); -85 deg = lowered, blade dug in ~6 cm below ground, top faces = loaders platform sloping 20 deg from 1.0 m (hinge) to 0.55 m (gun_crew_1/2 stand on it)',
        'deployed_pose': {'spade_L.rotation.x': -85, 'spade_R.rotation.x': -85, 'gun_pivot.rotation.x': -40, 'turret.rotation.y': 'within +-30'},
        'travel_pose': {'spade_L.rotation.x': 0, 'spade_R.rotation.x': 0, 'gun_pivot.rotation.x': 0, 'turret.rotation.y': 0},
        'wheels': 'wheel_L1..L3 / wheel_R1..R3 spin about local X (hub); front axle (wheel_*1) steers: rotate about local Y with rotation.order = "YXZ"',
        'empties': ['muzzle', 'breech', 'gunner_station', 'cab_door_FL', 'cab_door_FR', 'cab_door_RL', 'cab_door_RR', 'commander_hatch',
                    'gun_crew_1', 'gun_crew_2', 'gun_crew_3', 'gun_crew_4', 'exhaust', 'dismount_L', 'dismount_R'],
    },
}

# --------------------------------------------------------------------------------------------- armour
def Z(x0, x1, y0, y1, z0, z1, faces, name, **kw):
    d = dict(name=name, min=[x0, y0, z0], max=[x1, y1, z1], faces=faces)
    d.update(kw)
    return d

def F(ke, ce, **kw):
    d = dict(ke=ke, ce=ce)
    d.update(kw)
    return d

def P(name, x0, x1, y0, y1, z0, z1, **kw):
    d = dict(name=name, min=[x0, y0, z0], max=[x1, y1, z1])
    d.update(kw)
    return d

ARMOR = {
    'msta_s': dict(
        model='msta_s', vehicle='2S19M2 Msta-S',
        summary=('Welded rolled-steel hull and turret, ~15 mm all round (turret front, sides, roof and hull per FAS / GlobalSecurity / '
                 'Wikipedia). Proof against 7.62 mm ball and most 152/155 mm splinters beyond ~20-30 m; 12.7/14.5 mm AP, 30 mm, any '
                 'RPG/ATGM, FPV-drone shaped charges and top-attack submunitions defeat it. The sloped glacis and turret cheeks give '
                 '~20-30 mm line of sight. Projectiles and especially propellant charges fill the turret rear and the hull centre: '
                 'a penetration of the turret bustle or fighting compartment usually ends in a cook-off.'),
        frame='armor.js: metres, x right, y up, z forward, origin on the ground at the hull centre; faces in mm RHA-equivalent vs a horizontal shot',
        zones=[
            Z(-1.58, 1.58, 1.54, 2.99, -2.95, 1.55, {'front': F(20, 20), 'side': F(15, 15), 'rear': F(15, 15), 'top': F(15, 15)}, 'turret'),
            Z(-0.5, 0.5, 1.9, 3.0, 1.3, 2.0, {'front': F(25, 25), 'side': F(15, 15), 'top': F(15, 15)}, 'mantlet'),
            Z(-1.69, 1.69, 0.98, 1.52, 2.3, 3.5, {'front': F(30, 30), 'side': F(15, 15), 'top': F(17, 17)}, 'glacis'),
            Z(-1.69, 1.69, 0.45, 0.98, 2.95, 3.5, {'front': F(25, 25), 'side': F(15, 15)}, 'lower_front'),
            Z(-1.69, 1.69, 0.45, 1.52, -3.42, 2.95, {'side': F(19, 19, note='15 mm side + ~4 mm steel skirt (front 2/3)'), 'rear': F(15, 15),
                                                     'top': F(12, 12), 'bottom': F(10, 10)}, 'hull'),
            Z(-1.76, -1.11, 0.0, 0.95, -3.45, 3.4, {'side': F(25, 25), 'front': F(25, 25), 'rear': F(25, 25)}, 'tracks_l'),
            Z(1.11, 1.76, 0.0, 0.95, -3.45, 3.4, {'side': F(25, 25), 'front': F(25, 25), 'rear': F(25, 25)}, 'tracks_r'),
        ],
        screens=[dict(name='cope_cage', node='cope_cage', zone='turret', faces={'top': F(0, 300), 'side': F(0, 200)},
                      coverage=0.6, decay_per_hit=0.15,
                      note='2023-24 anti-drone cage: treat like armor.js ERA (era: {ke, ce}) only while the cope_cage node is visible; '
                           'defeats/pre-detonates part of FPV / RPG / submunition hits')],
        parts=[
            P('driver', -0.45, 0.45, 0.55, 1.5, 1.65, 2.6, crew='driver'),
            P('commander', 0.45, 1.4, 1.6, 2.9, -0.85, 0.35, crew='commander'),
            P('gunner', -1.4, -0.45, 1.6, 2.9, -0.35, 0.85, crew='gunner'),
            P('loader_projectiles', 0.3, 1.35, 1.6, 2.9, -2.35, -1.05, crew='loader'),
            P('loader_charges', -1.35, -0.3, 1.6, 2.9, -2.35, -1.05, crew='loader'),
            P('turret_shell_rack', -1.45, 1.45, 1.6, 2.6, -2.9, -2.35, ammo=0.35, ammo_kind='projectiles (ready rack, mechanised)', rounds=28),
            P('turret_charge_rack', -1.45, -0.95, 1.6, 2.7, -2.35, -0.6, ammo=0.75, ammo_kind='propellant charges (combustible-case 4Zh)', rounds=28),
            P('hull_rack', -1.0, 1.0, 0.5, 1.45, -1.6, 0.6, ammo=0.55, ammo_kind='22 projectiles + charges', rounds=22),
            P('breech', -0.35, 0.35, 2.05, 2.85, -0.7, 1.4, gun=True),
            P('gun_tube', -0.25, 0.25, 2.25, 2.75, 1.5, 8.45, gun=True, external=True),
            P('optics', -1.1, -0.35, 2.95, 3.45, 0.2, 1.1, optics=True),
            P('mg_mount', 0.6, 1.3, 2.99, 3.55, -0.7, 0.4, optics=True, external=True),
            P('turret_ring', -1.25, 1.25, 1.42, 1.6, -1.65, 0.85, ring=True),
            P('fuel_front', 0.5, 1.6, 0.5, 1.5, 1.6, 3.0, fuel=0.35),
            P('fuel_rear', -1.6, 1.6, 0.55, 1.4, -1.95, -1.6, fuel=0.4),
            P('engine', -1.3, 1.3, 0.5, 1.5, -3.4, -1.95, engine=True, fuel=0.25),
        ],
        crew_positions=[dict(role='commander', hatch='hatch_commander'), dict(role='gunner', hatch='hatch_gunner'),
                        dict(role='loader', hatch='hatch_side_R'), dict(role='loader', hatch='hatch_ammo_rear'),
                        dict(role='driver', hatch='hatch_driver')],
        notes=['koi.legion.wplus.net lists 50-80 mm hull/turret armour; this contradicts FAS/GlobalSecurity/Wikipedia (15 mm) and the '
               'vehicle mass budget, so the 15 mm figure is used.',
               'Line-of-sight values: glacis 15 mm at ~60 deg -> 30; lower front plate ~55 deg -> 25; turret cheeks ~40 deg -> 20.'],
    ),
    'bohdana': dict(
        model='bohdana', vehicle='2S22 Bohdana (KrAZ-6322/63221, armoured cab)',
        summary=('Only the 4-door crew cab and the bonnet are armoured: protection against 7.62x54R B-32 API at 30 m and splinters, '
                 'plus a mine-protected floor (manufacturer); modelled as ~12-14 mm RHA-equivalent (high-hardness steel, est. 8-10 mm '
                 'actual). The gun mount, crew working positions, ammunition containers, fuel tank and tyres are unprotected '
                 '(3-10 mm structural steel), so artillery splinters, drones and HMG fire disable the gun or start a charge fire. '
                 'Crew are protected only while travelling in the cab; when deployed they work in the open.'),
        frame='armor.js: metres, x right, y up, z forward, origin on the ground at the hull centre; faces in mm RHA-equivalent vs a horizontal shot',
        zones=[
            Z(-1.24, 1.24, 1.30, 3.0, 0.95, 2.85, {'front': F(14, 14, note='armoured glass equivalent'), 'side': F(12, 12), 'rear': F(12, 12),
                                                   'top': F(8, 8), 'bottom': F(12, 12, note='mine-protected floor')}, 'cab'),
            Z(-1.33, 1.33, 1.30, 2.15, 2.85, 4.2, {'front': F(10, 10), 'side': F(8, 8), 'top': F(6, 6)}, 'bonnet'),
            Z(-0.65, 0.65, 1.5, 3.85, -3.5, -0.6, {'front': F(10, 10), 'side': F(8, 8), 'rear': F(5, 5), 'top': F(5, 5)}, 'gun_mount'),
            Z(-1.3, 1.3, 0.88, 2.2, -3.98, 0.95, {'front': F(4, 4), 'side': F(4, 4), 'rear': F(4, 4), 'top': F(3, 3), 'bottom': F(5, 5)}, 'body'),
            Z(-1.36, -0.81, 0.0, 1.3, -3.2, 3.6, {'side': F(12, 12), 'front': F(12, 12), 'rear': F(12, 12)}, 'wheels_l'),
            Z(0.81, 1.36, 0.0, 1.3, -3.2, 3.6, {'side': F(12, 12), 'front': F(12, 12), 'rear': F(12, 12)}, 'wheels_r'),
        ],
        parts=[
            P('driver', -1.15, -0.1, 1.35, 2.75, 1.9, 2.8, crew='driver'),
            P('commander', 0.1, 1.15, 1.35, 2.75, 1.9, 2.8, crew='commander'),
            P('crew_rear', -1.15, 1.15, 1.35, 2.75, 1.0, 1.9, crew='gun_crew', seats=3),
            P('engine', -0.6, 0.6, 0.8, 1.95, 2.85, 4.0, engine=True, fuel=0.2),
            P('fuel_tank', -1.3, -0.7, 0.7, 1.26, -0.1, 1.0, fuel=0.5),
            P('charges', -1.25, -0.4, 1.42, 1.97, -1.35, 0.75, ammo=0.8, ammo_kind='propellant charges (modular / bagged)'),
            P('shells', 0.4, 1.25, 1.42, 1.92, -1.35, -0.15, ammo=0.4, ammo_kind='155 mm projectiles', rounds=20),
            P('breech', -0.35, 0.35, 2.9, 3.6, -3.5, -1.2, gun=True),
            P('gun_tube', -0.25, 0.25, 3.05, 3.45, -1.2, 4.95, gun=True, external=True),
            P('optics', -0.85, -0.55, 3.2, 3.7, -2.6, -2.2, optics=True, external=True),
            P('fcs_box', -0.35, 0.35, 1.42, 1.85, 0.15, 0.7, optics=True),
            P('turntable', -0.95, 0.95, 1.42, 2.1, -2.9, -1.0, ring=True),
            P('hydraulics', -0.3, 0.3, 1.42, 1.75, -0.35, 0.05, hydraulics=True, note='spade + laying power pack: destroyed -> cannot deploy / pack'),
        ],
        deployed_crew_parts=[
            P('gunner_deployed', -1.15, -0.55, 1.6, 2.9, -3.0, -2.2, crew='gunner', exposed=True),
            P('loader_deployed', -0.4, 0.4, 0.55, 2.3, -5.0, -4.2, crew='loader', exposed=True),
        ],
        crew_positions=[dict(role='driver', hatch='cab_door_FL'), dict(role='commander', hatch='cab_door_FR'),
                        dict(role='gunner', hatch='cab_door_RL', deployed='gunner_station'),
                        dict(role='loader', hatch='cab_door_RR', deployed='gun_crew_1'),
                        dict(role='loader', hatch='cab_door_RL', deployed='gun_crew_2')],
        notes=['Cab protection published only as a threat level (7.62 mm B-32 at 30 m + splinters, mine protection); thickness is an estimate.'],
    ),
}

# --------------------------------------------------------------------------------------------- manifest
def entry(n, info):
    v = dict(STATIC[n])
    v['file'] = f'assets/vehicles/{n}.glb'
    v['file_mb'] = info['file_mb']
    v['tris'] = dict(lod0=info['lod0_tris'], lod1=info['lod1_tris'], **info['wreck_tris'])
    v['model_bbox_m'] = dict(min=info['bbox_lod0'][0], max=info['bbox_lod0'][1],
                             size=[round(b - a, 3) for a, b in zip(*info['bbox_lod0'])])
    v['materials'] = info['materials']
    for k in ('track_link_pitch_m', 'track_length_m', 'track_links'):
        if k in info:
            v[k] = info[k]
    v['armor_file'] = f'assets/vehicles/{n}_armor.json'
    v['game'] = GAME[n]
    v['animation'] = ANIMATION[n]
    v['sources'] = SOURCES[n]
    v['hierarchy'] = info['hierarchy']
    return v

def write_armor(n):
    a = dict(ARMOR[n])
    a['generator'] = 'tools/blender/vehicles/arty_specs.py'
    a['sources'] = SOURCES[n][:-1]
    p = os.path.join(REPO, 'assets', 'vehicles', n + '_armor.json')
    with open(p, 'w') as f:
        json.dump(a, f, indent=1)
    return p

def write_manifest(names):
    """Read-modify-write: only vehicles.<name> for the given names is replaced."""
    man_path = os.path.join(REPO, 'assets', 'vehicles', 'manifest.json')
    new = {}
    for n in names:
        info = json.load(open(os.path.join(CACHE, n + '_info.json')))
        new[n] = entry(n, info)
        write_armor(n)
    import fcntl
    with open(man_path + '.lock', 'w') as lk:   # same lock as ifv.py's merge_manifest
        fcntl.flock(lk, fcntl.LOCK_EX)
        man = json.load(open(man_path))
        man.setdefault('vehicles', {}).update(new)
        tmp = man_path + '.tmp_arty'
        with open(tmp, 'w') as f:
            json.dump(man, f, indent=1)
        os.replace(tmp, man_path)
    print('wrote', man_path, list(new))

if __name__ == '__main__':
    write_manifest(sys.argv[1:] or list(SCRIPTS))
