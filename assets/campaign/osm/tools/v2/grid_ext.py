# grid_ext.py UA|RU -> src/campaign/v2/content_grid_ext_<side>.js  (+ copies the stats/geometry to
# assets/campaign/osm/<side>/aor_ext.json)
# Campaign v5: the playable grid GROWS past the original AOR when the front approaches its edge. This builds the extra
# rows (UA: south towards Tokmak) / columns (RU: west of Avdiivka) from the per-cell OSM statistics made by
#   python3 assets/campaign/osm/tools/v2/fetch_tiles.py UAX 47.35674 35.65 0.01809 0.02658 14 7 2
#   python3 assets/campaign/osm/tools/v2/fetch_tiles.py RUX 48.27 37.40242 0.01809 0.02693 6 12 2
#   python3 assets/campaign/osm/tools/v2/aor.py UAX   (and RUX)
# with the same classification as grid.py (settlements, terrain, roads, rivers, OSM-mapped field fortifications).
# Every extension square is enemy-held at the start (it lies behind the enemy's lines). Cell ids keep the parent
# grid's numbering (RU: negative columns west of column 0). Data (c) OpenStreetMap contributors (ODbL).
# Run from the repo root: python3 assets/campaign/osm/tools/v2/grid_ext.py UA
import json, math, sys, os, shutil

side = sys.argv[1]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../../..'))
SRC = f'/tmp/osmv2/aor_{side}X.json'
DST = f'{ROOT}/assets/campaign/osm/{side}/aor_ext.json'
if os.path.exists(SRC): shutil.copyfile(SRC, DST)
D = json.load(open(DST))
G = D['grid']; latN, lonW, dLa, dLo, C, R = G['latN'], G['lonW'], G['dLa'], G['dLo'], G['cols'], G['rows']
COL0, ROW0 = G.get('col0', 0), G.get('row0', 0)
latS, lonE = latN - R * dLa, lonW + C * dLo
KX = 111.32 * math.cos(math.radians((latN + latS) / 2)); KY = 110.57
cells = {c['id']: c for c in D['cells']}
def cid(lat, lon): return f'c{min(C-1, max(0, int((lon - lonW) / dLo))) + COL0}_{min(R-1, max(0, int((latN - lat) / dLa))) + ROW0}'

if side == 'UA':
    DIR = 'south'
    # bands, nearest the original grid first: (id, first row, last row)
    BANDS = [('ua_x1', 14, 15), ('ua_x2', 16, 17), ('ua_x3', 18, 20)]
    NAMES = {'Tokmak': dict(size=5, kind='town'), 'Ocheretuvate': dict(size=2), 'Nove': dict(size=2), 'Ostrykivka': dict(size=3)}
    NOTES = {
        'Tokmak': 'District town and rail junction on the Tokmak river (Tokmak–Fedorivka–Volnovakha line): the railhead, depots and command posts of the Russian grouping south of Orikhiv, ringed by its own anti-tank ditch and trench belt. The 2023 counteroffensive\'s operational objective; it stayed ~20 km behind the line.',
        'Nove': 'Village on a balka south of Solodka Balka, behind the second belt.',
        'Myrne': 'Hamlet west of the T-04-08 south of Solodka Balka.',
        'Ocheretuvate': 'Village on the R-85 east of the T-04-08; the road to Polohy and the Russian rear area east of Tokmak.',
        'Kharkove': 'Hamlet on the R-85 between the T-04-08 and Ocheretuvate.',
        'Chervonohirka': 'Village on the northern approaches to Tokmak, inside the third defence belt (ditch, dragon\'s teeth and bunker lines mapped in OSM).',
        'Sadove': 'Village north-west of Tokmak on the edge of the third belt.',
        'Skeliuvate': 'Village east of Tokmak on the Tokmak river balka.',
        'Ostrykivka': 'Village on the Tokmak river east of the town.',
        'Luhivka': 'Village on the Tokmak river just east of the town.',
        'Snihurivka': 'Hamlet on the Tokmak river south-east of the town.',
        'Ivanivka': 'Hamlet on the Tokmak river south-east of the town.',
        'Fabrychne': 'Village on the eastern edge of Tokmak.',
        'Trudove': 'Village in the south-east, on the road to Polohy.',
    }
    EXTRA = [  # named features (lat, lon, name, terrain, note)
        (47.3100, 35.7400, 'Tokmak line (T-04-08)', 'heights', 'The third Russian defence belt on the high ground north of Tokmak: a continuous anti-tank ditch, dragon\'s teeth and dozens of bunkers mapped in OpenStreetMap from 2023 imagery.'),
    ]
    EXTRA += [(47.2620, 35.6800, 'Tokmak (west)', 'urban', 'Western quarters of Tokmak and the road to Molochansk.'),
              (47.2620, 35.7350, 'Tokmak (east)', 'urban', 'Eastern quarters of Tokmak along the Tokmak river.'),
              (47.2440, 35.6800, 'Tokmak (south-west)', 'urban', 'South-western quarters of Tokmak.'),
              (47.2440, 35.7080, 'Tokmak station', 'industrial', 'Tokmak railway station and yards on the Fedorivka–Volnovakha line: the railhead of the southern grouping.')]
    GARRISON = {'Tokmak': 3, 'Tokmak line (T-04-08)': 3, 'Chervonohirka': 2, 'Tokmak station': 3, 'Tokmak (east)': 2, 'Tokmak (west)': 2, 'Tokmak (south-west)': 2}
    FORT = {'Tokmak': 3, 'Tokmak station': 3, 'Tokmak (east)': 2, 'Tokmak (west)': 2, 'Tokmak (south-west)': 2}
    OBJ = {}
else:
    DIR = 'west'
    BANDS = [('ru_x1', -1, -2), ('ru_x2', -3, -4), ('ru_x3', -5, -6)]
    NAMES = {}
    NOTES = {}
    EXTRA = []
    GARRISON = {}
    FORT = {}
    OBJ = {}
if os.path.exists(f'{os.path.dirname(__file__)}/grid_ext_{side.lower()}.json'):   # optional side config (RU place notes)
    X = json.load(open(f'{os.path.dirname(__file__)}/grid_ext_{side.lower()}.json'))
    NAMES.update(X.get('names', {})); NOTES.update(X.get('notes', {})); GARRISON.update(X.get('garrison', {})); FORT.update(X.get('fort', {}))
    EXTRA += [tuple(e) for e in X.get('extra', [])]

def place_size(p):
    pop = p['pop']; return 5 if pop > 20000 else 4 if pop > 8000 else 3 if pop > 900 else 2 if pop > 250 else 1
out = []
extra = {}
for lat, lon, name, ter, note in EXTRA: extra.setdefault(cid(lat, lon), (lat, lon, name, ter, note))
for s in D['cells']:
    lat, lon = s['latlon']; f = s['frac']; c, r = s['col'], s['row']
    cell = dict(id=s['id'], col=c, row=r, latlon=[lat, lon], terrain='fields', road=0, owner='enemy', fort=0, garrison=0, vp=0, lp=0)
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
        cell['terrain'] = 'urban' if best['kind'] == 'town' else 'village'
        cell['vp'] = {5: 4, 4: 3, 3: 2, 2: 1, 1: 1}[best['size']]; cell['lp'] = {5: 3, 4: 3, 3: 2, 2: 1, 1: 0}[best['size']]
    if f.get('water', 0) > 0.35 and not best: cell['terrain'] = 'water'
    elif not best and (f.get('ind', 0) + f.get('ind2', 0)) > 0.3: cell['terrain'] = 'industrial'
    elif not best and built > 0.45: cell['terrain'] = 'urban'
    elif not best and f.get('wood', 0) >= 0.18: cell['terrain'] = 'forest'
    elif not best and s['stream'] >= 5.0 and f.get('wood', 0) < 0.18: cell['terrain'] = 'balka'
    if s['id'] in extra:
        elat, elon, name, ter, note = extra[s['id']]
        if ter: cell['terrain'] = ter
        if not best or ter in ('urban', 'industrial', 'heights'): cell['name'] = name
        if note: cell['notes'] = note
        cell['vp'] = max(cell['vp'], 1)
    cell['road'] = 2 if s['road2'] >= 0.8 else 1 if (s['road1'] >= 0.8 or s['road2'] > 0) else 0
    if cell['road'] == 2: cell['lp'] += 1
    if s['refs']: cell['roads'] = [x.replace('С', 'C').replace('О', 'O').replace('Т', 'T').replace('Н', 'N').replace('Р', 'R') for x in s['refs']][:4]
    fk, bk = s['fortKm'], s['bunkers']
    fort = 1
    if fk >= 2.0 or bk >= 5: fort = 3
    elif fk >= 0.8: fort = 2
    cell['fort'] = fort
    g = 1 + (1 if fort == 3 and (best or cell['terrain'] in ('heights', 'urban', 'industrial')) else 0)
    if best and best['size'] >= 4: g = 3
    nm = cell.get('name')
    if nm in FORT: cell['fort'] = fort = max(fort, FORT[nm])
    if nm in GARRISON: g = GARRISON[nm]
    cell['garrison'] = min(3, g)
    if nm in NOTES and 'notes' not in cell: cell['notes'] = NOTES[nm]
    bits = []
    if fk >= 0.5 or bk: bits.append(f"OSM maps {fk:.1f} km of ditches/trenches{f' and {bk} bunkers' if bk else ''} here")
    if cell.get('roads'): bits.append('roads ' + ', '.join(cell['roads']))
    if bits: cell['notes'] = (cell.get('notes', '') + (' ' if cell.get('notes') else '') + '(' + '; '.join(bits) + ')').strip()
    if nm in OBJ: cell['objective'] = OBJ[nm]
    cell['battleMap'] = 'robotyne' if side == 'UA' else 'avdiivka'
    cell['ext'] = True
    out.append(cell)
byid = {c['id']: c for c in out}
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
# ------------------------------------------------------------------ bands
bands = []
for bid, a, b in BANDS:
    lo, hi = min(a, b), max(a, b)
    key = 'row' if DIR in ('south', 'north') else 'col'
    bc = [c for c in out if lo <= c[key] <= hi]
    edge = hi if DIR in ('south', 'east') else lo
    # enemy supply sources on the band's outer edge: roads first, spread along the edge (max 3)
    ec = sorted([c for c in bc if c[key] == edge and c['terrain'] != 'water'], key=lambda c: (-(c['road']), c['row' if key == 'col' else 'col']))
    src = []
    for c in ec:
        other = 'col' if key == 'row' else 'row'
        if all(abs(c[other] - byid[s][other]) >= 3 for s in src): src.append(c['id'])
        if len(src) >= 3: break
    la = [c['latlon'][0] for c in bc]; lo2 = [c['latlon'][1] for c in bc]
    bbox = [round(min(la) - dLa / 2, 5), round(min(lo2) - dLo / 2, 5), round(max(la) + dLa / 2, 5), round(max(lo2) + dLo / 2, 5)]
    bands.append(dict(id=bid, lo=lo, hi=hi, bbox=bbox, sources=src, cells=bc))
js = [f'// GENERATED by assets/campaign/osm/tools/v2/grid_ext.py {side} — do not edit by hand (edit the generator).',
      f'// Grid EXTENSION (campaign v5): {C}x{R} extra {G.get("dLa") and "2 km"} squares past the original AOR, added in bands as the front approaches the edge.',
      f'// Data (c) OpenStreetMap contributors (ODbL); per-cell statistics and geometry in assets/campaign/osm/{side}/aor_ext.json.',
      f'export const GRID_EXT_{side} = {{', f'  dir: {json.dumps(DIR)}, bbox: {json.dumps([round(latS, 5), round(lonW, 5), latN, round(lonE, 5)])}, geo: "assets/campaign/osm/{side}/aor_ext.json",', '  bands: [']
for b in bands:
    js.append(f'    {{ id: {json.dumps(b["id"])}, lo: {b["lo"]}, hi: {b["hi"]}, bbox: {json.dumps(b["bbox"])}, sources: {json.dumps(b["sources"])}, cells: [')
    for c in b['cells']: js.append('      ' + json.dumps(c, ensure_ascii=False) + ',')
    js.append('    ] },')
js += ['  ],', '};', '']
open(f'{ROOT}/src/campaign/v2/content_grid_ext_{side.lower()}.js', 'w').write('\n'.join(js))
for b in bands:
    print(b['id'], len(b['cells']), 'sources', b['sources'])
    key = 'row' if DIR in ('south', 'north') else 'col'
    rng = sorted({c['row'] for c in b['cells']}); cols = sorted({c['col'] for c in b['cells']})
    for r in rng:
        print(f'{r:>4} ' + ' '.join(f"{(byid[f'c{c}_{r}']['terrain'][:2] + str(byid[f'c{c}_{r}']['fort'])):>4}" for c in cols))
for c in out:
    if c.get('name'): print(c['id'], c['name'], c['terrain'], 'f', c['fort'], 'g', c['garrison'], 'vp', c['vp'], 'road', c['road'], 'RIVER' if c.get('river') else '')
