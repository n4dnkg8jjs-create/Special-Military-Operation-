"""Static data for the IFVs built by ifv.py (BMP-3, M2A2 ODS-SA Bradley): sources, manifest stats and the
game armour tables.  Pure Python (no bpy) so build_all.py can import it cheaply.

Armour tables (written to assets/vehicles/<name>_armor.json) use the src/game/armor.js frame:
  x = vehicle RIGHT, y = up, z = forward, metres, origin on the ground at the footprint centre.
  NOTE this is mirrored in X relative to the glTF model frame (glTF: vehicle right = -X).
Values are mm RHA-equivalent as seen by a horizontal shot onto that face (slope already folded in, as in armor.js);
armor.js divides by the cosine to the axis-aligned box face on top of that.
"""

SOURCES = {
    'bmp3': [
        'https://en.wikipedia.org/wiki/BMP-3 (7.14 x 3.2 x 2.4 m, 18.7 t; UTD-29 500 hp; 72 km/h road, 45 off-road, 10 water; '
        '2A70 100 mm 40 rds (22 in autoloader) + 8 9M117, 2A72 30 mm 500 rds (300 HE / 200 AP) 350-400 rpm, coax + 2 bow PKT '
        '2000 rds each; -5..+60 deg; crew 3 + 7 (2 beside the driver, 5 aft); hull front 22 mm steel + 60 mm Al, sides/rear 43 mm Al, '
        'roof 15 mm, floor 10 mm; turret front 16 mm steel + 70 mm gap + 50 mm Al; front arc vs 30 mm at 200 m, add-on side '
        'overlay vs 12.7 mm at 100-200 m; troops exit over the engine compartment; 6 x 902V; Kaktus ERA serial from Nov 2022)',
        'https://www.globalsecurity.org/military/world/russia/bmp-3-specs.htm (chassis 6.73 m, height 2.45 m, width 3.15 m; '
        '22 ready + 18 stowed 100 mm, 3 ready + 5 stowed ATGM; 100 mm 8-10 rpm, 30 mm 350 rpm cyclic, PKT 250 practical / 650 '
        'cyclic; 70 km/h road, 45 off-road; -5..+60 deg)',
        'https://dic.academic.ru/dic.nsf/ruwiki/288166 (hull 6.70 m, 7.20 m with gun, width 3.30 m, height 2.30 m to turret roof; '
        'hull front resists 30 mm 2A42 at 300 m, -6..+60 deg; 40 x 100 mm + 8 9M117 + 500 x 30 mm; dismount through the stern hatch)',
        'https://www.zr.ru/content/articles/748087-test-bronemashiny-bmp-3-xit-prodazh/ (transverse rear engine, rear doors above '
        'the engine with hinged steps + rectangular roof hatches over the engine compartment used to dismount; bow PKTs in the front '
        'hull corners; 6000 x 7.62 mm total; two water-jets)',
        'https://commons.wikimedia.org/wiki/File:BMP-3_line_drawing.gif (side-view proportions used for the hull: roof ~1.69 m, '
        'turret roof ~2.25 m, very shallow glacis, 6 road wheels, raised rear sprocket / front idler, gun axis ~0.15 m above the roof, '
        'turret centred ~0.3 m ahead of the hull centre, segmented side screen over the upper track run)',
    ],
    'bradley': [
        'https://en.wikipedia.org/wiki/M2_Bradley (6.55 x 3.60 m (with tiles), 3.3 m without armour kit, 3.0 m over commander hatch; '
        'M2A2 ODS 30.1 t, 61 km/h (38 mph) road, 40 km/h off-road, 7.2 km/h water; M242 900 rds (300 ready: 70 AP + 230 HE, 600 '
        'stowed), single/100/200 rpm; +57/-9 deg; 360 deg traverse in 6 s; 2 TOW in launcher + 5 stowed; M240C 2200 rds; 2 x 4 M257 '
        'smoke; hull 25.4 mm 5083/7039 Al, 9.5 mm steel belly plate; M2A2: 32 mm steel appliqué on hull sides and turret, spaced '
        'laminate on the rear, ERA option; protection vs 14.5 mm all round, A2 vs 30 mm APDS front; 300+ M2A2 ODS-SA to Ukraine '
        'from 2023; BRAT-equipped Ukrainian M2A2 captured Nov 2023)',
        'https://afvdatabase.com/usa/m2bradley.html (M2A2: 655 x 328 x 297 cm, clearance 46 cm, tread 240 cm, track 53 cm wide, '
        '15 cm pitch, 84/82 shoes, ground contact 391 cm, 6 dual road wheels, 3 return rollers, 11-tooth FRONT drive sprocket, rear '
        'idler; sides: two 6.4 mm steel plates 25 mm apart ~89 mm off the Al; M2A2 32 mm appliqué hull sides/turret front+right, '
        'spaced-laminate skirts; big rear ramp with an emergency door in its left side, two ramp firing ports retained)',
        'https://www.twz.com/ukrainian-bradleys-seen-equipped-with-explosive-reactive-armor (Jul 2023: Ukrainian M2A2 ODS with BRAT '
        'boxes mounted around the hull sides; BUSK extras unconfirmed)',
        'https://militarnyi.com/en/articles/bradley-american-cowboy-on-ukrainian-battlefield/ (M2A2 ODS-SA, 600 hp, up to 61 km/h, '
        'crew 3 + up to 6 dismounts; BRAT on front hull, sides and turret of some vehicles, field-installable; no APS)',
        'https://www.snopes.com/news/2023/06/28/ukrainian-military-nazi-cross/ (Ukrainian vehicles carry a plain white equidistant '
        'identification cross)',
    ],
}

# ---------------------------------------------------------------------------------------------- manifest statics
STATIC = {
    'bmp3': dict(
        faction='RU', name='BMP-3', kind='ifv', crew=3, passengers=7, game_dismounts=7,
        real_dimensions_m=dict(hull_length=6.73, length_gun_forward=7.14, width=3.15, height_turret_roof=2.30,
                               height_over_sights=2.45, ground_clearance=0.45, ground_clearance_range=[0.19, 0.51],
                               track_width=0.38, track_centres=2.66, road_wheels_per_side=6, return_rollers_per_side=3,
                               drive='rear sprocket, front idler'),
        armament=['100 mm 2A70 gun-launcher, 9M117M1 Arkan ATGM fired through the bore (muzzle)',
                  '30 mm 2A72 autocannon (muzzle_30)', '7.62 mm PKT coaxial (coax_muzzle)',
                  '2 x 7.62 mm PKT bow MGs (bow_mg_L / bow_mg_R)', '6 x 81 mm 902V Tucha (smoke_launchers)'],
        weapons=[
            dict(id='2a70', name='2A70 100 mm rifled gun-launcher', calibre_mm=100, node='muzzle', rof_rpm=10,
                 ammo_ready=22, ammo_total=40, rounds='3UOF17 HE-Frag (3OF32)', range_m=4000, autoloader=True),
            dict(id='9m117m1', name='9M117M1 Arkan laser-beam-riding ATGM (via 2A70)', calibre_mm=100, node='muzzle',
                 rof_rpm=2, ammo_ready=3, ammo_total=8, penetration_mm_rha=750, tandem=True, range_m=5500,
                 flight_speed_ms=345),
            dict(id='2a72', name='2A72 30 mm autocannon', calibre_mm=30, node='muzzle_30', rof_rpm=330,
                 ammo_ready=500, ammo_total=500, belts={'HE-I (3UOF8)': 300, 'APDS (3UBR8)': 200},
                 penetration_mm_rha={'APDS_500m': 50, 'APDS_1000m': 35}, range_m=2000),
            dict(id='pkt_coax', name='PKT 7.62 mm coaxial', calibre_mm=7.62, node='coax_muzzle', rof_rpm=700,
                 ammo_ready=250, ammo_total=2000),
            dict(id='pkt_bow', name='2 x PKT 7.62 mm bow MGs (fixed ball mounts, ~+/-17 deg)', calibre_mm=7.62,
                 node=['bow_mg_L', 'bow_mg_R'], rof_rpm=700, ammo_ready=250, ammo_total=4000),
            dict(id='902v', name='902V Tucha 81 mm smoke', calibre_mm=81, node='smoke_launchers', salvos=1, tubes=6),
        ],
        mobility=dict(speed_road_kmh=70, speed_offroad_kmh=45, speed_water_kmh=10, range_km=600, power_hp=500,
                      weight_t=18.7, turret_traverse_deg_s=40, turret_traverse_note='2E52 stabiliser; ~9 s per 360 deg (estimate)',
                      gun_elevation_deg=[-5, 60], amphibious=True),
        game_suggested=dict(hp=1050, speed=12, accel=2.6, turnRate=0.75, radius=2.2, length=7.1, width=3.2, height=2.4,
                            turretSpeed=0.7, passengers=7, seats=7, wheeled=False),
        markings='none (plain field-worn 4BO-style Russian green, dust/mud, no tactical letters)',
        armor_file='assets/vehicles/bmp3_armor.json',
    ),
    'bradley_ua': dict(
        faction='UA', name='M2A2 ODS-SA Bradley', kind='ifv', crew=3, passengers=6, game_dismounts=6,
        real_dimensions_m=dict(hull_length=6.55, width_without_tiles=3.28, width_with_brat=3.61, height_turret_roof=2.57,
                               height_over_commander_hatch=2.97, ground_clearance=0.46, track_width=0.533,
                               track_centres=2.44, track_pitch=0.152, road_wheel_diameter=0.61, road_wheels_per_side=6,
                               return_rollers_per_side=3, drive='front sprocket (11 teeth), rear idler'),
        armament=['25 mm M242 Bushmaster (muzzle)', '7.62 mm M240C coaxial (coax_muzzle)',
                  'twin BGM-71 TOW launcher, left side of the turret (tow_launcher > atgm_muzzle_1/2)',
                  '2 x 4 M257 smoke (smoke_launchers)'],
        weapons=[
            dict(id='m242', name='M242 Bushmaster 25 mm chain gun', calibre_mm=25, node='muzzle',
                 rof_rpm={'low': 100, 'high': 200, 'single': True}, ammo_ready=300, ammo_total=900,
                 belts={'AP (M791 APDS-T / M919 APFSDS-T)': 70, 'HE (M792 HEI-T)': 230},
                 penetration_mm_rha={'M919_1000m': 85, 'M791_1000m': 60}, range_m=2500),
            dict(id='tow', name='BGM-71 TOW-2A/2B (twin launcher, must be raised and vehicle halted to fire)',
                 calibre_mm=152, node=['atgm_muzzle_1', 'atgm_muzzle_2'], rof_rpm=2, ammo_ready=2, ammo_total=7,
                 penetration_mm_rha=900, tandem=True, range_m=3750, flight_speed_ms=280, reload_s=60),
            dict(id='m240c', name='M240C 7.62 mm coaxial', calibre_mm=7.62, node='coax_muzzle', rof_rpm=750,
                 ammo_ready=800, ammo_total=2200),
            dict(id='m257', name='M257 66 mm smoke (2 x 4)', calibre_mm=66, node='smoke_launchers', salvos=1, tubes=8),
        ],
        mobility=dict(speed_road_kmh=61, speed_offroad_kmh=40, speed_water_kmh=0, range_km=400, power_hp=600,
                      weight_t=30.0, turret_traverse_deg_s=60, gun_elevation_deg=[-9, 57], amphibious=False,
                      note='A2 lost practical swimming without the flotation screen'),
        game_suggested=dict(hp=1250, speed=10.5, accel=2.4, turnRate=0.7, radius=2.2, length=6.6, width=3.6, height=2.6,
                            turretSpeed=1.0, passengers=6, seats=6, wheeled=False),
        markings='NATO three-tone CARC woodland (green 383 / brown 383 / black), field-worn; plain white identification crosses '
                 'on the BRAT tiles both sides, the rear ramp and the roof cargo hatch (no flags / no yellow-blue)',
        armor_file='assets/vehicles/bradley_ua_armor.json',
    ),
}

# keys copied from <name>_info.json into the manifest entry (in addition to the ones build_all.py already copies)
INFO_KEYS = ('track_link_pitch_m', 'track_length_m', 'track_links', 'ride_seats', 'ride_clearance', 'running_gear_radii_m',
             'empties', 'animated_nodes', 'toggle_nodes', 'gun_limits_deg')

# ---------------------------------------------------------------------------------------------- armour tables
def _Z(name, x0, x1, y0, y1, z0, z1, faces, note=None):
    d = dict(name=name, min=[x0, y0, z0], max=[x1, y1, z1], faces=faces)
    if note:
        d['note'] = note
    return d

def _F(ke, ce, era=None):
    d = dict(ke=ke, ce=ce)
    if era:
        d['era'] = era
    return d

ARMOR = {
    'bmp3': dict(
        vehicle='bmp3', model='BMP-3 (Russian service 2022-24, add-on side screens fitted, no Kaktus ERA)',
        frame='src/game/armor.js frame: x = vehicle RIGHT (mirror of glTF x), y up, z forward, metres; origin ground/footprint centre',
        units='mm RHA-equivalent, horizontal line of sight, vs kinetic (ke) and shaped-charge (ce)',
        basis=['hull front 22 mm BT-70Sh steel + 60 mm ABT-102 Al, very shallow glacis (~16-20 deg from horizontal): rated vs 30 mm '
               'APDS at 200-300 m -> ~70 KE LOS', 'turret front 16 mm steel + 70 mm gap + 50 mm Al -> ~55 KE',
               'sides/rear 43 mm Al (~15 RHA); with the 2022 bolted steel side screens ~25 KE (vs 12.7 mm at 100-200 m)',
               'roof 15-18 mm Al (~6-7 RHA), floor 10 mm Al', 'Al vs HEAT counted at ~0.55 of thickness, steel 1.0, gaps ~0.1'],
        zones=[
            _Z('turret', -1.05, 1.05, 1.70, 2.30, -0.55, 1.45,
               dict(front=_F(55, 75), side=_F(18, 30), rear=_F(15, 25), top=_F(7, 10))),
            _Z('glacis', -1.57, 1.57, 1.14, 1.70, 1.90, 3.36,
               dict(front=_F(70, 95), side=_F(25, 40), top=_F(28, 40)),
               'upper front plate incl. folded trim vane; top = drone strike on the shallow glacis'),
            _Z('lower_front', -1.07, 1.07, 0.45, 1.14, 2.78, 3.36, dict(front=_F(40, 55), side=_F(18, 30), bottom=_F(10, 14))),
            _Z('hull', -1.57, 1.57, 0.45, 1.70, -3.36, 1.90,
               dict(side=_F(25, 40), rear=_F(15, 25), top=_F(6, 10), bottom=_F(4, 8)),
               'side 25/40 with the add-on side screens (side_screens node); without them use 15/25'),
            _Z('tracks_l', -1.58, -1.12, 0.0, 1.14, -3.36, 2.95, dict(side=_F(15, 15), front=_F(15, 15), rear=_F(15, 15))),
            _Z('tracks_r', 1.12, 1.58, 0.0, 1.14, -3.36, 2.95, dict(side=_F(15, 15), front=_F(15, 15), rear=_F(15, 15))),
        ],
        parts=[
            dict(name='driver', crew='driver', min=[-0.35, 0.55, 1.95], max=[0.35, 1.60, 2.90]),
            dict(name='bow_gunner_l', troops=True, seat='bow_mg_L', role='bow_gunner_left', min=[-1.25, 0.55, 1.95], max=[-0.45, 1.60, 2.90]),
            dict(name='bow_gunner_r', troops=True, seat='bow_mg_R', role='bow_gunner_right', min=[0.45, 0.55, 1.95], max=[1.25, 1.60, 2.90]),
            dict(name='gunner', crew='gunner', min=[-0.85, 1.00, -0.10], max=[-0.10, 2.20, 0.90]),
            dict(name='commander', crew='commander', min=[0.10, 1.00, -0.10], max=[0.85, 2.20, 0.90]),
            dict(name='autoloader', ammo=0.65, note='ring conveyor under the turret floor: 22 x 100 mm HE-Frag + 3 9M117',
                 min=[-1.00, 0.50, -0.60], max=[1.00, 0.90, 1.20]),
            dict(name='hull_ammo_l', ammo=0.5, note='9 x 100 mm + ATGMs stowed on the troop compartment left wall',
                 min=[-1.45, 0.60, -1.70], max=[-0.95, 1.45, -0.40]),
            dict(name='hull_ammo_r', ammo=0.5, note='9 x 100 mm + ATGMs stowed on the troop compartment right wall',
                 min=[0.95, 0.60, -1.70], max=[1.45, 1.45, -0.40]),
            dict(name='ammo_30mm', ammo=0.3, note='2A72 belt boxes (500 rds) in the turret, right side',
                 min=[0.35, 1.20, 0.10], max=[0.90, 1.65, 0.90]),
            dict(name='fuel', fuel=0.35, note='main tank low in the bow under the driver / bow gunners',
                 min=[-1.00, 0.47, 2.00], max=[1.00, 0.80, 3.10]),
            dict(name='engine', engine=True, fuel=0.25, note='UTD-29 transverse in the rear floor, under the troop passage',
                 min=[-1.30, 0.47, -3.30], max=[1.30, 1.15, -1.85]),
            dict(name='troops', troops=True, note='5 seats aft of the turret', min=[-1.10, 0.90, -1.85], max=[1.10, 1.68, -0.60]),
            dict(name='troop_passage', troops=True, note='crawl-way over the engine to the rear doors',
                 min=[-0.55, 1.15, -3.30], max=[0.55, 1.68, -1.85]),
            dict(name='gun', gun=True, note='2A70 breech + 2A72 receiver', min=[-0.45, 1.55, -0.10], max=[0.45, 2.05, 1.30]),
            dict(name='optics', optics=True, note='1K13-2 gunner sight (left) and commander TKN sight (right)',
                 min=[-1.00, 2.15, 0.55], max=[1.00, 2.50, 1.25]),
            dict(name='turret_ring', ring=True, min=[-1.00, 1.60, -0.70], max=[1.00, 1.78, 1.30]),
        ],
    ),
    'bradley_ua': dict(
        vehicle='bradley_ua', model='M2A2 ODS-SA Bradley (Ukraine 2023+, BRAT tiles on hull sides and turret)',
        frame='src/game/armor.js frame: x = vehicle RIGHT (mirror of glTF x), y up, z forward, metres; origin ground/footprint centre',
        units='mm RHA-equivalent, horizontal line of sight, vs kinetic (ke) and shaped-charge (ce)',
        basis=['hull 25-38 mm 5083 Al (~0.35 RHA vs KE) with the upper front steel/titanium layer: A2 rated vs 30 mm APDS frontally -> ~75 KE LOS',
               'sides: 25 mm Al + spaced laminate (2 x 6.4 mm steel, 25 mm apart, ~89 mm stand-off) + 32 mm A2 steel appliqué -> ~55 KE '
               '(14.5 mm API at all ranges), spaced -> ~70 CE',
               'turret: steel + 32 mm appliqué front/sides ~60/45 KE', 'rear ramp spaced laminate ~35 KE',
               'BRAT (M19-type tiles, single-charge HEAT / RPG-7 class): +~280-300 CE, ~+10 KE; ERA zones are thin stand-off layers in '
               'front of the hull sides / skirts so they are hit before the hull boxes',
               'belly 9.5 mm steel mine plate over the front third + Al'],
        zones=[
            _Z('turret', -1.00, 1.00, 1.98, 2.60, -1.05, 1.15,
               dict(front=_F(60, 75, dict(ke=10, ce=280)), side=_F(45, 60, dict(ke=10, ce=280)), rear=_F(25, 30), top=_F(20, 25))),
            _Z('tow_launcher', -1.46, -1.00, 2.05, 2.55, -0.55, 0.95,
               dict(front=_F(6, 6), side=_F(6, 6), rear=_F(6, 6), top=_F(6, 6), bottom=_F(6, 6)),
               'light launcher box; any hit here disables the TOW (part tow_launcher)'),
            _Z('glacis', -1.50, 1.50, 1.12, 1.98, 1.65, 3.22, dict(front=_F(75, 90), side=_F(55, 70), top=_F(30, 40))),
            _Z('lower_front', -0.92, 0.92, 0.46, 1.12, 2.85, 3.22, dict(front=_F(45, 55), side=_F(40, 50), bottom=_F(20, 25))),
            _Z('era_l', -1.78, -1.58, 0.64, 1.44, -2.70, 2.50,
               dict(side=_F(55, 70, dict(ke=10, ce=300)), front=_F(55, 70), rear=_F(55, 70), top=_F(40, 50), bottom=_F(30, 30)),
               'BRAT tile belt (2 rows) on the left skirt/side'),
            _Z('era_r', 1.58, 1.78, 0.64, 1.44, -2.70, 2.50,
               dict(side=_F(55, 70, dict(ke=10, ce=300)), front=_F(55, 70), rear=_F(55, 70), top=_F(40, 50), bottom=_F(30, 30)),
               'BRAT tile belt (2 rows) on the right skirt/side'),
            _Z('hull', -1.56, 1.56, 0.46, 1.98, -3.24, 1.65,
               dict(side=_F(55, 70), rear=_F(35, 50), top=_F(15, 20), bottom=_F(18, 25))),
            _Z('tracks_l', -1.62, -0.95, 0.0, 1.15, -3.00, 3.10, dict(side=_F(30, 30), front=_F(20, 20), rear=_F(20, 20)),
               'spaced-laminate high-hardness steel skirts over the upper run'),
            _Z('tracks_r', 0.95, 1.62, 0.0, 1.15, -3.00, 3.10, dict(side=_F(30, 30), front=_F(20, 20), rear=_F(20, 20))),
        ],
        parts=[
            dict(name='driver', crew='driver', min=[-1.00, 0.60, 1.80], max=[-0.30, 1.85, 2.70]),
            dict(name='engine', engine=True, fuel=0.2, note='Cummins VTA-903T + HMPT-500 front right',
                 min=[0.10, 0.50, 1.70], max=[1.40, 1.85, 3.10]),
            dict(name='gunner', crew='gunner', min=[-0.85, 1.10, -0.50], max=[-0.10, 2.30, 0.50]),
            dict(name='commander', crew='commander', min=[0.10, 1.10, -0.60], max=[0.85, 2.30, 0.40]),
            dict(name='ammo_ready_25', ammo=0.3, note='300 ready rounds (dual feed) in the turret basket',
                 min=[-0.60, 0.80, -0.50], max=[0.60, 1.30, 0.50]),
            dict(name='ammo_stowed_25', ammo=0.35, note='600 stowed 25 mm rounds, troop compartment left',
                 min=[-1.40, 0.60, -2.30], max=[-0.90, 1.50, -1.00]),
            dict(name='tow_rack', ammo=0.45, note='5 stowed TOW/Javelin missiles, troop compartment right wall',
                 min=[0.90, 0.60, -2.60], max=[1.45, 1.60, -1.20]),
            dict(name='fuel', fuel=0.4, note='fuel cell in the right rear of the troop compartment (BUSK shields it)',
                 min=[0.80, 0.50, -3.10], max=[1.45, 1.40, -2.00]),
            dict(name='troops', troops=True, note='6 dismounts aft of the turret', min=[-1.30, 0.60, -3.10], max=[1.30, 1.90, -0.70]),
            dict(name='gun', gun=True, note='M242 receiver / dual feeder + M240C', min=[-0.30, 1.95, 0.20], max=[0.35, 2.50, 1.10]),
            dict(name='optics', optics=True, note='ISU (gunner, left front of roof) + commander periscope',
                 min=[-0.75, 2.50, 0.30], max=[0.20, 2.95, 1.00]),
            dict(name='turret_ring', ring=True, min=[-0.95, 1.90, -0.90], max=[0.95, 2.05, 1.00]),
            dict(name='tow_launcher', atgm=True, note='TOW box on the left of the turret; destroyed -> no ATGM',
                 min=[-1.46, 2.05, -0.55], max=[-1.00, 2.55, 0.95]),
        ],
    ),
}
