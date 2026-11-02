# grid.py UA|RU -> src/campaign/v2/content_grid_<side>.js
# Campaign v2 AOR grid from the per-cell OSM statistics in assets/campaign/osm/<side>/aor_v2.json (made by aor.py from
# OSM API v0.6 map tiles, (c) OpenStreetMap contributors, ODbL) plus the researched starting front line (Feb 2023),
# fortification belts, named features and notes. Run from the repo root: python3 assets/campaign/osm/tools/v2/grid.py UA
import json, math, sys, os

side = sys.argv[1]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../../..'))
D = json.load(open(f'{ROOT}/assets/campaign/osm/{side}/aor_v2.json'))
G = D['grid']; latN, lonW, dLa, dLo, C, R = G['latN'], G['lonW'], G['dLa'], G['dLo'], G['cols'], G['rows']
latS, lonE = latN - R * dLa, lonW + C * dLo
KX = 111.32 * math.cos(math.radians((latN + latS) / 2)); KY = 110.57
cellKm = round(dLa * KY, 2)
cells = {c['id']: c for c in D['cells']}
def cid(lat, lon): return f'c{min(C-1, max(0, int((lon - lonW) / dLo)))}_{min(R-1, max(0, int((latN - lat) / dLa)))}'
def pip(lat, lon, poly):
    ins = False; j = len(poly) - 1
    for i in range(len(poly)):
        yi, xi = poly[i]; yj, xj = poly[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi + 1e-15) + xi: ins = not ins
        j = i
    return ins

# ------------------------------------------------------------------------------------------------ side configs
if side == 'UA':
    # Ukrainian-held area on 6 Feb 2023 (north of the line): the line ran ~2–3 km south of Novodanylivka and Mala
    # Tokmachka, with Russian first positions in the fields and tree belts north of Robotyne / Kopani and towards Verbove.
    FRONT = [[47.505, 35.640], [47.488, 35.690], [47.484, 35.730], [47.486, 35.770], [47.488, 35.800], [47.486, 35.840],
             [47.488, 35.880], [47.490, 35.920], [47.486, 35.960], [47.480, 36.000], [47.476, 36.030]]
    OWN = FRONT + [[47.62, 36.03], [47.62, 35.64]]
    OVERRIDE_OWNER = {}
    RENAME = {}
    NAMES = {   # settlement names/size/kind overrides (2023 names), keyed by OSM name
        'Orikhiv': dict(size=4, kind='town'), 'Preobrazhenka': None, 'Буряківка': dict(name='Buriakivka'),
        'Mala Tokmachka': dict(size=3), 'Novodanylivka': dict(size=3), 'Robotyne': dict(size=3), 'Verbove': dict(size=3),
        'Novoprokopivka': dict(size=2), 'Kopani': dict(size=2), 'Rivne': dict(size=1), 'Nesterianka': dict(size=3),
    }
    EXTRA = [   # named features without (or beside) a settlement: (lat, lon, name, terrain, extra)
        (47.4358, 35.9476, 'Verbove heights', 'heights', dict(objective='D', note='The best-prepared part of the main belt, 1.7–3.5 km west of Verbove: anti-tank ditch, dragon\'s teeth, trench lines and bunkers on the high ground (ISW, 23 Sep 2023).')),
        (47.4560, 35.9500, 'Heights NW of Verbove', 'heights', {}),
        (47.4050, 35.8320, 'Heights S of Novoprokopivka', 'heights', dict(note='Trench lines on the high ground south of Novoprokopivka, inside the main belt.')),
        (47.4800, 35.8260, 'T-04-08 tree belts', None, dict(note='Strongpoints in the tree belts either side of the Orikhiv–Tokmak road north of Robotyne; dense minefields.')),
        (47.4620, 35.8250, 'Balka N of Robotyne', 'balka', dict(note='A balka with a stream across the T-04-08 just north of Robotyne; first Russian line and minefields.')),
        (47.4800, 35.8870, 'Fields S of Mala Tokmachka', None, dict(note='Open fields and tree belts sown with anti-tank and anti-personnel mines, covered by ATGMs, artillery and attack helicopters. The first armoured attack on 8 June 2023 stalled here.')),
        (47.4800, 35.9150, 'Tree belts SE of Mala Tokmachka', None, {}),
    ]
    GARRISON = {'Robotyne': 2, 'Novoprokopivka': 3, 'Verbove': 3, 'Verbove heights': 3, 'Solodka Balka': 2, 'Kopani': 2}
    OBJ = {'Robotyne': 'A', 'Kopani': 'C', 'Novoprokopivka': 'B', 'Verbove': 'E', 'Solodka Balka': 'F'}
    HEIGHTS = []
    FORT_BELT = [[47.452, 35.640], [47.446, 35.760], [47.432, 35.800], [47.428, 35.860], [47.440, 35.920], [47.448, 35.960], [47.452, 36.03]]   # main belt runs south of this line
    NOTES = {
        'Orikhiv': 'District town on the Kinska; brigade CP, depots and the field hospital, shelled daily. Rail station on the Orikhiv–Polohy line; the T-04-08, T-08-12 and N-08 meet here.',
        'Novodanylivka': 'Forward village on the T-04-08 Orikhiv–Tokmak road: the road south to Robotyne is the axis of advance.',
        'Mala Tokmachka': 'Village on the Kinska and the T-08-15 to Polohy; assembly area for the armour in June 2023.',
        'Novopokrovka': 'Eastern flank village on the O-081347.',
        'Nesterianka': 'Western flank village on the O-081349 Orikhiv–Molochansk road; fighting spread here from Robotyne in August 2023.',
        'Kopani': 'Village on the C-081301 west of Robotyne; ditches and trench lines mapped west of it.',
        'Rivne': 'Hamlet behind a dense lattice of ditches and trenches.',
        'Robotyne': 'Village on the T-04-08 at the southern edge of the minefields; garrisoned strongpoints in the houses and gardens, the main belt just behind it. Liberation announced 28 Aug 2023.',
        'Novoprokopivka': 'Village 1.5–2.5 km south of Robotyne on the T-04-08, inside the main belt.',
        'Verbove': 'Village bordered on its north and west by the main belt, on the O-081450; held by airborne troops in September 2023.',
        'Solodka Balka': 'Strongpoint village on the T-04-08 in the second belt: dozens of bunkers and ditch segments mapped around it.',
        'Ilchenkove': 'Hamlet on a balka west of the T-04-08 inside the second belt.',
        'Pshenychne': 'Village on the way to Ocheretuvate and Tokmak.',
        'Chystopillia': 'Village in the south-west, behind the main belt.',
        'Novoandriivka': 'Village west of Orikhiv near the Mali Shcherbaky axis.',
        'Novopavlivka': 'Rear village on the N-08 to Zaporizhzhia.',
        'Bilohiria': 'Eastern rear village near Novokarlivka station.',
        'Chervona Krynytsia': 'Rear hamlet north-east of Orikhiv.',
        'Buriakivka': 'Rear hamlet west of Orikhiv.',
    }
    HQ = 'Orikhiv'
    ENEMY_EDGE = 'south'
    SUPPLY = [(47.600, 35.770), (47.600, 35.815), (47.565, 35.663)]       # N-08 to Zaporizhzhia, T-04-08 north, T-08-12 west
else:
    # Russian-held area on 6 Feb 2023 (east / south of the Avdiivka salient): Yasynuvata, the Donetsk airport ruins, Spartak,
    # Pisky (since Aug 2022), Vesele and Novoselivka Druha in the north-east (since mid-2022), Kamianka. Krasnohorivka contested.
    OWN = [[48.214, 37.890], [48.214, 37.845], [48.222, 37.800], [48.214, 37.768], [48.197, 37.744], [48.180, 37.748],
           [48.172, 37.768], [48.160, 37.776], [48.146, 37.790], [48.128, 37.812], [48.110, 37.807], [48.100, 37.786],
           [48.093, 37.762], [48.088, 37.738], [48.087, 37.708], [48.083, 37.668], [48.078, 37.630], [48.066, 37.598],
           [48.050, 37.585], [48.050, 37.890]]
    OVERRIDE_OWNER = {(48.2067, 37.7245): 'contested'}
    RENAME = {'c2_2': 'Novobakhmutivka (Soloviove)', 'c6_11': 'Vesele (airport)'}      # Krasnohorivka: fought over Feb–Mar 2023
    NAMES = {
        'Avdiivka': dict(size=5, kind='town'), 'Yasynuvata': dict(size=5, kind='town'), 'Ocheretyne': dict(size=3, kind='town'),
        'Yasnohorivka': dict(name='Krasnohorivka', size=2), 'Krynychne': dict(name='Lastochkyne', size=2), 'Pivnichne': dict(name='Sieverne', size=2),
        'Авдіївське': dict(name='Pervomaiske', size=3), 'Keramik': dict(kind='village', size=2), 'Verkhnotoretske': dict(kind='village', size=3),
        'Spartak': dict(size=2), 'Pisky': dict(size=2), 'Stepove': dict(size=2), 'Novobakhmutivka': dict(size=2),
    }
    EXTRA = [
        (48.1725, 37.6996, 'Avdiivka Coke Plant', 'industrial', dict(settlement=dict(name='Avdiivka Coke Plant', kind='industrial', size=4), objective='E',
          note='Avdiivka Coke Plant (AKKhZ), one of Europe\'s largest: coke batteries, bunkers, rail yards and shelters. The last part of the town to be abandoned (Feb 2024).')),
        (48.1830, 37.7128, 'Spoil heaps', 'heights', dict(objective='A', note='The coke plant\'s spoil (slag) heaps west of the railway, overlooking the plant and the northern quarters. Taken by Russian forces around 28 Oct 2023.')),
        (48.1179, 37.7922, 'Promzona', 'industrial', dict(settlement=dict(name='Promzona', kind='industrial', size=3), objective='C',
          note='The industrial zone by the N-20 and Yasynuvata-2 station: concrete works, a quarry and trench lines. Fought over 13 Nov – 4 Dec 2023.')),
        (48.1225, 37.7665, 'Tsarska Okhota', 'urban', dict(objective='B', note='Fortified restaurant complex on Soborna St (T-05-26) at the south-eastern exit of the town (position approximate). Taken around 20 Jan 2024.')),
        (48.1120, 37.7320, 'Zenit', 'heights', dict(objective='F', note='Zenit: fortified former air-defence position on the southern outskirts (position approximate). Abandoned under threat of encirclement 14–15 Feb 2024.')),
        (48.1530, 37.7200, 'Khimik', 'urban', dict(objective='G', note='Khimik quarter between the station and the plant; Industrialnyi Avenue (O0542) is the garrison\'s main supply road.')),
        (48.1500, 37.7500, 'Avdiivka NE', 'urban', dict(note='Dacha plots, the sand quarry and Shestakova St on the north-eastern edge of the town; the second breach came here in early Feb 2024.')),
        (48.1524, 37.7350, 'Avdiivka (north)', 'urban', dict(note='Northern high-rise quarters of Avdiivka between the station and Khimik.')),
        (48.1343, 37.7620, 'Avdiivka (east)', 'urban', dict(note='Eastern edge of the town: the old town along Soborna St and the approaches from the industrial zone.')),
        (48.0714, 37.7408, 'Donetsk airport', 'industrial', dict(note='The ruined terminals and runways of the Donetsk airport, Russian-held since January 2015.')),
    ]
    GARRISON = {'Avdiivka': 3, 'Avdiivka Coke Plant': 3, 'Zenit': 3, 'Tsarska Okhota': 3, 'Promzona': 2, 'Spoil heaps': 2, 'Khimik': 3, 'Avdiivka NE': 2, 'Stepove': 2, 'Krasnohorivka': 1, 'Vodiane': 2, 'Opytne': 2}
    OBJ = {'Avdiivka': 'D', 'Stepove': 'H', 'Krasnohorivka': 'K', 'Lastochkyne': 'L', 'Vodiane': 'V', 'Opytne': 'O'}
    FORT_BELT = None
    NOTES = {
        'Yasynuvata': 'Rail junction town on the N-20, fortified since 2014; brigade CP, depots and the railhead.',
        'Avdiivka': 'The high-rise quarters around Tsentralnyi Avenue; a fortified Ukrainian salient since 2014.',
        'Krasnohorivka': 'Village among tree belts and ponds north of the coke plant (OSM: Yasnohorivka, renamed 2024); fought over in Feb–Mar 2023, jump-off point of the northern attacks in October 2023.',
        'Vesele': 'Village north-east of the town; launch point of the northern attacks.',
        'Novoselivka Druha': 'Rear village on the Kamianka stream, Russian-held since mid-2022.',
        'Kamianka': 'Village on the N-20 and the Kamianka stream north-east of the town.',
        'Stepove': 'Village on the Avdiivka–Ocheretyne railway north-west of the plant; contested from October 2023, taken by late Feb 2024.',
        'Berdychi': 'Village on the Durna balka and the C051813; the line stabilised near here after Avdiivka fell.',
        'Orlivka': 'Village on the O0542 supply road west of the town.',
        'Lastochkyne': 'Village and road junction on the Durna balka where the supply roads from the west meet (OSM: Krynychne, renamed 2024). Taken 24–26 Feb 2024.',
        'Tonenke': 'Village on the Tonka balka west of the town.',
        'Sieverne': 'Village 6 km west of the town (OSM: Pivnichne, renamed 2024).',
        'Vodiane': 'Village on the Vodiana stream on the north-western edge of the airport; Russian attempts to take it in January 2023 failed.',
        'Opytne': 'Village between the airport and the town, on the line since 2014.',
        'Spartak': 'Village on the T-05-05 Avdiivka–Donetsk road; a disused drainage pipe runs north from here under the fields.',
        'Pisky': 'Ruined village west of the airport, taken by Russian forces in August 2022.',
        'Pervomaiske': 'Village on the Vodiana stream south-west of Avdiivka (OSM: Avdiivske, renamed 2024).',
        'Novobakhmutivka': 'Village 13 km north-east of Avdiivka on the northern flank.',
        'Verkhnotoretske': 'Ukrainian-held village north of Yasynuvata on the line since 2015.',
        'Ocheretyne': 'Rail town on the Ukrainian side, the salient\'s rear.',
        'Keramik': 'Ukrainian-held settlement north-west of Krasnohorivka.',
        'Novokalynove': 'Ukrainian-held village north of the salient.',
        'Kruta Balka': 'Russian rear village east of the N-20.',
        'Mineralne': 'Russian rear village by the Verkhnokalmiuske reservoir.',
        'Vesele (airport)': 'Village south-east of the Donetsk airport on the Russian side.',
        'Novobakhmutivka (Soloviove)': 'Small village near Soloviove behind the Ukrainian line.',
        'Yakovlivka': 'Russian rear village south of Yasynuvata.',
    }
    HQ = 'Yasynuvata'
    ENEMY_EDGE = 'west'
    SUPPLY = [(48.127, 37.870), (48.172, 37.870), (48.064, 37.775), (48.064, 37.870)]   # Yasynuvata railhead, Vasylivka, Donetsk via T-05-05, N-20 south

# ------------------------------------------------------------------------------------------------ build
out = []
own_override = {cid(*k): v for k, v in OVERRIDE_OWNER.items()}
extra = {}
for lat, lon, name, ter, ex in EXTRA:
    extra.setdefault(cid(lat, lon), (lat, lon, name, ter, ex))
def place_size(p):
    pop = p['pop']; return 5 if pop > 20000 else 4 if pop > 8000 else 3 if pop > 900 else 2 if pop > 250 else 1
for r in range(R):
    for c in range(C):
        s = cells[f'c{c}_{r}']; lat, lon = s['latlon']; f = s['frac']
        cell = dict(id=s['id'], col=c, row=r, latlon=[lat, lon], terrain='fields', road=0, owner='enemy', fort=0, garrison=0, vp=0, lp=0)
        # settlement: the biggest named place in the cell (villages/towns/hamlets; 2023 names)
        pl = [p for p in s['places'] if p['place'] in ('town', 'city', 'village', 'hamlet')]
        best = None
        for p in sorted(pl, key=lambda p: -(p['pop'] + (100000 if p['place'] in ('town', 'city') else 0))):
            ov = NAMES.get(p['name'], {})
            if ov is None: continue
            best = dict(name=ov.get('name', p['name']), kind=ov.get('kind', 'town' if p['place'] in ('town', 'city') else 'hamlet' if p['place'] == 'hamlet' else 'village'),
                        latlon=[round(p['lat'], 5), round(p['lon'], 5)], size=ov.get('size', place_size(p)))
            break
        built = f.get('res', 0) + f.get('ind', 0) + f.get('ind2', 0)
        if best:
            cell['settlement'] = best; cell['name'] = best['name']
            cell['terrain'] = 'urban' if best['kind'] == 'town' else 'industrial' if best['kind'] == 'industrial' else 'village'
            cell['vp'] = {5: 4, 4: 3, 3: 2, 2: 1, 1: 1}[best['size']]; cell['lp'] = {5: 3, 4: 3, 3: 2, 2: 1, 1: 0}[best['size']]
        if f.get('water', 0) > 0.35: cell['terrain'] = 'water'
        elif not best and (f.get('ind', 0) + f.get('ind2', 0)) > 0.3: cell['terrain'] = 'industrial'
        elif not best and built > 0.45: cell['terrain'] = 'urban'
        elif not best and f.get('wood', 0) >= 0.18: cell['terrain'] = 'forest'
        elif not best and s['stream'] >= 5.0 and f.get('wood', 0) < 0.18: cell['terrain'] = 'balka'
        # named feature
        if s['id'] in extra:
            elat, elon, name, ter, ex = extra[s['id']]
            if ter: cell['terrain'] = ter
            if ex.get('settlement'):
                cell['settlement'] = dict(ex['settlement'], latlon=[elat, elon]); cell['vp'] = max(cell['vp'], 2); cell['lp'] = max(cell['lp'], 1)
            if not best or ex.get('settlement') or ter in ('urban', 'industrial', 'heights'): cell['name'] = name
            if ex.get('objective'): cell['objective'] = ex['objective']
            if ex.get('note'): cell['notes'] = ex['note']
            cell['vp'] = max(cell['vp'], 1)
        # roads (km of road in the 2 km cell): paved highway 2, any other paved road 1
        cell['road'] = 2 if s['road2'] >= 0.8 else 1 if (s['road1'] >= 0.8 or s['road2'] > 0) else 0
        if cell['road'] == 2: cell['lp'] += 1
        if s['refs']: cell['roads'] = [x.replace('С', 'C').replace('О', 'O').replace('Т', 'T').replace('Н', 'N').replace('Р', 'R') for x in s['refs']][:4]
        # owner at the start (6 Feb 2023)
        cell['owner'] = own_override.get(s['id'], 'player' if pip(lat, lon, OWN) else 'enemy')
        # OSM-mapped field fortifications (anti-tank ditches, trenches, bunkers)
        if s['fortKm'] or s['bunkers']: cell['osmFort'] = dict(km=round(s['fortKm'], 1), bunkers=s['bunkers'])
        out.append(cell)
byid = {c['id']: c for c in out}
def nb(c):
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            if dx or dy:
                n = byid.get(f"c{c['col']+dx}_{c['row']+dy}")
                if n: yield n
for c in out:
    front = any(n['owner'] != c['owner'] for n in nb(c))
    of = c.get('osmFort', {}); fk, bk = of.get('km', 0), of.get('bunkers', 0)
    lat, lon = c['latlon']
    if c['owner'] == 'player':
        c['fort'] = 1 if front else 0
        if c['terrain'] in ('urban',) or (c.get('settlement') and c['settlement']['size'] >= 4): c['fort'] = 2
    else:
        f = 2 if front else 1
        if fk >= 2.0 or bk >= 5: f = 3
        elif fk >= 0.8: f = max(f, 2)
        if side == 'UA' and FORT_BELT:   # main belt: everything south of the belt line is at least 2
            # interpolate the belt latitude at this longitude
            for (a0, o0), (a1, o1) in zip(FORT_BELT, FORT_BELT[1:]):
                if o0 <= lon <= o1:
                    bl = a0 + (a1 - a0) * (lon - o0) / (o1 - o0)
                    if bl - 0.03 < lat < bl: f = max(f, 3 if c.get('settlement') or c['terrain'] == 'heights' else 2)
                    break
        if side == 'RU' and (c['terrain'] in ('urban', 'industrial') or c.get('objective')): f = 3
        c['fort'] = min(3, f)
        g = (2 if front else 1) + (1 if c['fort'] == 3 and (c.get('settlement') or c['terrain'] in ('heights', 'urban', 'industrial')) else 0)
        if c.get('settlement') and c['settlement']['size'] >= 4: g = 3
        c['garrison'] = min(3, g)
    if c['owner'] == 'contested': c['garrison'] = 1; c['fort'] = max(c['fort'], 1)
    # notes
    if c['id'] in RENAME:
        c['name'] = RENAME[c['id']]
        if c.get('settlement'): c['settlement']['name'] = RENAME[c['id']]
    nm = c.get('name')
    if nm in NOTES and 'notes' not in c: c['notes'] = NOTES[nm]
    extra_bits = []
    if fk >= 0.5 or bk: extra_bits.append(f"OSM maps {fk:.1f} km of ditches/trenches{f' and {bk} bunkers' if bk else ''} here")
    if c.get('roads'): extra_bits.append('roads ' + ', '.join(c['roads']))
    if extra_bits: c['notes'] = (c.get('notes', '') + (' ' if c.get('notes') else '') + '(' + '; '.join(extra_bits) + ')').strip()
    if nm in OBJ and 'objective' not in c: c['objective'] = OBJ[nm]
    if c.get('objective'): c['vp'] = max(c['vp'] + 1, 2)
    if nm in GARRISON and c['owner'] != 'player': c['garrison'] = GARRISON[nm]
    c['battleMap'] = 'robotyne' if side == 'UA' else 'avdiivka'
    c.pop('osmFort', None)
# rivers (OSM waterway=river): river cells, bridges where a paved road crosses
for rv in D['geo']['rivers']:
    pts = rv['pts']
    for a, b in zip(pts, pts[1:]):
        n = max(1, int(math.hypot((b[0]-a[0])*KY, (b[1]-a[1])*KX) / 0.2))
        for k in range(n + 1):
            la = a[0] + (b[0]-a[0]) * k / n; lo = a[1] + (b[1]-a[1]) * k / n
            if latS <= la <= latN and lonW <= lo <= lonE:
                cc = byid[cid(la, lo)]; cc['river'] = True; cc['riverName'] = rv.get('name') or cc.get('riverName')
for c in out:
    if c.get('river'):
        c['bridge'] = c['road'] >= 1
        if not c.get('riverName'): c.pop('riverName', None)
def find(name): return next(c['id'] for c in out if c.get('name') == name)
hq = find(HQ)
supply = sorted({cid(*p) for p in SUPPLY})
for s in supply: byid[s]['owner'] = 'player'
aor = dict(bbox=[round(latS, 5), lonW, latN, round(lonE, 5)], cellKm=cellKm, cols=C, rows=R, enemyEdge=ENEMY_EDGE, supplySources=supply, hq=hq, cells=out)
# ------------------------------------------------------------------------------------------------ write
js = [f'// GENERATED by assets/campaign/osm/tools/v2/grid.py {side} — do not edit by hand (edit the generator).',
      f'// {C}x{R} grid of {cellKm} km cells over the real ground; data (c) OpenStreetMap contributors (ODbL), per-cell statistics',
      f'// in assets/campaign/osm/{side}/aor_v2.json. Owner = the line on 6 Feb 2023 (approximate, from public maps / ISW reporting).',
      f'export const GRID_{side} = {{', f'  bbox: {json.dumps(aor["bbox"])}, cellKm: {cellKm}, cols: {C}, rows: {R}, enemyEdge: {json.dumps(ENEMY_EDGE)},',
      f'  supplySources: {json.dumps(supply)}, hq: {json.dumps(hq)},', '  cells: [']
for c in out: js.append('    ' + json.dumps(c, ensure_ascii=False) + ',')
js += ['  ],', '};', '']
open(f'{ROOT}/src/campaign/v2/content_grid_{side.lower()}.js', 'w').write('\n'.join(js))
# ascii overview
sym = {'player': 'o', 'enemy': 'x', 'contested': '~'}
print('     ' + ''.join(f'{c:>3}' for c in range(C)))
for r in range(R):
    print(f'{r:>3}  ' + ''.join(f"{(sym[byid[f'c{c}_{r}']['owner']] + str(byid[f'c{c}_{r}']['fort'])):>3}" for c in range(C)), '   ',
          ' '.join(f"{byid[f'c{c}_{r}']['terrain'][:2]}" for c in range(C)))
for c in out:
    if c.get('name'): print(c['id'], c['name'], c['terrain'], c['owner'], 'f', c['fort'], 'g', c['garrison'], 'vp', c['vp'], 'lp', c['lp'], 'road', c['road'], c.get('objective', ''), 'RIVER' if c.get('river') else '')
print('hq', hq, 'supply', supply, 'river cells', sum(1 for c in out if c.get('river')))
