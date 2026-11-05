# geo_v6.py SIDE (UA|RU|UAX|RUX): the drawing geometry of the strategic map, true to the ground (campaign v6).
# Reads the OSM API map tiles of the grid (/tmp/osmv2/<SIDE>/*.json, fetch_tiles.py) and replaces the "geo" block of
# assets/campaign/osm/<UA|RU>/aor_v2.json (UAX/RUX: aor_ext.json); the per-cell statistics (aor.py) stay as they are.
# Every class is kept at its real shape and size (Douglas-Peucker in metres: woods / tree belts 2.5 m, fields 6 m):
#   fields   landuse=farmland                      grass  natural=grassland|heath, landuse=meadow|grass
#   orchards landuse=orchard|vineyard|allotments    scrub  natural=scrub
#   woods    natural=wood, landuse=forest (all, incl. the 15-30 m wide shelter belts)
#   water    natural=water, landuse=reservoir|basin, waterway=riverbank      wet natural=wetland
#   built    [{k: res|ind|farm|cem, p}] residential/retail/commercial/garages, industrial/railway/quarry/..., farmyard, cemetery
#   ways     [{c: class, ref, pts}] every highway by class (motorway..service, track)       treeRows natural=tree_row|barrier=hedge
#   rivers / streams / rail / forts / bunkers as before (aor.py), roads + minor kept for older readers
# Polygons: a ring [[lat, lon], ...] or {r: [outer, hole, ...]} for multipolygons with holes.
# Relief: hillshade of the Terrarium DEM (elevation-tiles-prod, SRTM-derived, z12 ~26 m) over the grid's bbox ->
#   relief_v2.jpg / relief_ext.jpg next to the json (geo.relief = {url, bbox, zmin, zmax}).
# Data (c) OpenStreetMap contributors (ODbL); DEM: Mapzen Terrarium / AWS open data (SRTM, public domain).
import json, glob, math, sys, os, io, time, urllib.request
from shapely.geometry import Polygon, LineString, box
from shapely.ops import unary_union
side = sys.argv[1]
G = {'UA': dict(latN=47.610, lonW=35.650, dLa=0.01809, dLo=0.02658, cols=14, rows=14),
     'RU': dict(latN=48.270, lonW=37.560, dLa=0.01809, dLo=0.02693, cols=12, rows=12),
     'UAX': dict(latN=47.35674, lonW=35.650, dLa=0.01809, dLo=0.02658, cols=14, rows=7),
     'RUX': dict(latN=48.270, lonW=37.40242, dLa=0.01809, dLo=0.02693, cols=6, rows=12)}[side]
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', '..'))
S = side[:2]
OUT = os.path.join(REPO, 'assets/campaign/osm', S, 'aor_ext.json' if side.endswith('X') else 'aor_v2.json')
latN, lonW = G['latN'], G['lonW']; latS = latN - G['rows'] * G['dLa']; lonE = lonW + G['cols'] * G['dLo']
lat0, lon0 = (latN + latS) / 2, (lonW + lonE) / 2
KX = 111320 * math.cos(math.radians(lat0)); KY = 110570
P = lambda la, lo: ((lo - lon0) * KX, (la - lat0) * KY)
U = lambda x, y: [round(lat0 + y / KY, 5), round(lon0 + x / KX, 5)]
M = 300   # m of margin around the grid
W = box(*P(latS, lonW), *P(latN, lonE)).buffer(M, join_style=2)
nodes, ways, rels = {}, {}, {}
for f in sorted(glob.glob(f'/tmp/osmv2/{side}/*.json')):
    for e in json.load(open(f))['elements']:
        {'node': nodes, 'way': ways, 'relation': rels}[e['type']][e['id']] = e
print(side, len(nodes), len(ways), len(rels), file=sys.stderr)
def wxy(ids): return [P(nodes[i]['lat'], nodes[i]['lon']) for i in ids if i in nodes]

def cls_poly(t):
    lu, nat = t.get('landuse'), t.get('natural')
    if lu == 'farmland': return 'fields'
    if lu in ('orchard', 'vineyard', 'allotments', 'plant_nursery'): return 'orchards'
    if lu in ('meadow', 'grass', 'village_green') or nat in ('grassland', 'heath'): return 'grass'
    if nat == 'scrub': return 'scrub'
    if lu == 'forest' or nat == 'wood': return 'woods'
    if nat == 'water' or lu in ('reservoir', 'basin') or t.get('waterway') == 'riverbank': return 'water'
    if nat == 'wetland': return 'wet'
    if lu in ('residential', 'retail', 'commercial', 'garages'): return 'built:res'
    if lu in ('industrial', 'railway', 'brownfield', 'construction', 'quarry', 'landfill') or t.get('man_made') in ('works', 'wastewater_plant', 'water_works', 'spoil_heap') or t.get('aeroway') == 'aerodrome': return 'built:ind'
    if lu in ('farmyard',): return 'built:farm'
    if lu == 'cemetery' or t.get('amenity') == 'grave_yard': return 'built:cem'
    return None
TOL = dict(fields=6, orchards=5, grass=6, scrub=4, woods=2.5, water=4, wet=5, built=5)
MINA = dict(fields=1500, orchards=400, grass=800, scrub=300, woods=120, water=150, wet=400, built=500)
out = {k: [] for k in ('fields', 'orchards', 'grass', 'scrub', 'woods', 'water', 'wet', 'built')}
area = {k: 0.0 for k in out}
def emit(cls, poly):
    k, sub = (cls.split(':') + [None])[:2]
    if not poly.is_valid: poly = poly.buffer(0)
    poly = poly.intersection(W)
    for g in getattr(poly, 'geoms', [poly]):
        if g.geom_type != 'Polygon' or g.area < MINA[k]: continue
        s = g.simplify(TOL[k], preserve_topology=True)
        if s.is_empty or s.geom_type != 'Polygon': continue
        rings = [[U(x, y) for x, y in s.exterior.coords]] + [[U(x, y) for x, y in r.coords] for r in s.interiors if Polygon(r).area > MINA[k]]
        e = rings[0] if len(rings) == 1 else {'r': rings}
        out[k].append({'k': sub, 'p': e} if k == 'built' else e); area[k] += s.area
def join(segs):
    rings, segs = [], [s[:] for s in segs if len(s) > 1]
    while segs:
        cur = segs.pop(); changed = True
        while changed and cur[0] != cur[-1]:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]: cur += s[1:]; segs.pop(i); changed = True; break
                if s[-1] == cur[-1]: cur += s[::-1][1:]; segs.pop(i); changed = True; break
                if s[-1] == cur[0]: cur = s + cur[1:]; segs.pop(i); changed = True; break
                if s[0] == cur[0]: cur = s[::-1] + cur[1:]; segs.pop(i); changed = True; break
        if cur[0] == cur[-1] and len(cur) >= 4: rings.append(cur)
    return rings
for w in ways.values():
    t = w.get('tags') or {}; c = cls_poly(t)
    if c and w['nodes'][0] == w['nodes'][-1] and len(w['nodes']) >= 4:
        p = wxy(w['nodes'])
        if len(p) >= 4: emit(c, Polygon(p))
for r in rels.values():
    t = r.get('tags') or {}; c = cls_poly(t)
    if not c or t.get('type') not in ('multipolygon', None): continue
    mem = [m for m in r['members'] if m['type'] == 'way' and m['ref'] in ways]
    outer = [wxy(r2) for r2 in join([ways[m['ref']]['nodes'] for m in mem if m.get('role') in ('outer', '')])]
    inner = [wxy(r2) for r2 in join([ways[m['ref']]['nodes'] for m in mem if m.get('role') == 'inner'])]
    inner = [Polygon(i) for i in inner if len(i) >= 4]
    for o in outer:
        if len(o) < 4: continue
        po = Polygon(o)
        holes = [i for i in inner if po.contains(i.representative_point())]
        if holes: po = po.difference(unary_union(holes))
        emit(c, po)
# ---- lines
def lines(pred, tol, keyf, minlen=0):
    res = []; L = 0
    for w in ways.values():
        t = w.get('tags') or {}
        if not pred(t): continue
        p = wxy(w['nodes'])
        if len(p) < 2: continue
        g = LineString(p).intersection(W)
        for s in getattr(g, 'geoms', [g]):
            if s.geom_type != 'LineString' or s.length < minlen: continue
            s = s.simplify(tol)
            res.append(dict(**keyf(t), pts=[U(x, y) for x, y in s.coords])); L += s.length
    return res, L
HW = {'motorway': 'primary', 'trunk': 'primary', 'primary': 'primary', 'secondary': 'secondary', 'tertiary': 'tertiary',
      'unclassified': 'unclassified', 'residential': 'residential', 'living_street': 'residential', 'service': 'service', 'track': 'track', 'road': 'unclassified'}
def hwc(t): h = t.get('highway', ''); return HW.get(h.replace('_link', '')) if h else None
ways_out, wl = lines(lambda t: hwc(t) is not None, 3, lambda t: dict(c=hwc(t), ref=t.get('ref') or None, sf=t.get('surface') or None), 8)
for w in ways_out:
    if w['ref'] is None: del w['ref']
    if w['sf'] is None: del w['sf']
rivers, _ = lines(lambda t: t.get('waterway') == 'river', 4, lambda t: dict(name=t.get('name:en') or t.get('name')))
streams, _ = lines(lambda t: t.get('waterway') in ('stream', 'canal', 'ditch', 'drain'), 4, lambda t: dict(name=t.get('name:en') or t.get('name'), w=t.get('waterway')))
rail, _ = lines(lambda t: t.get('railway') in ('rail', 'disused', 'abandoned', 'light_rail'), 4, lambda t: dict(state=t.get('railway'), name=t.get('name')))
forts, fl = lines(lambda t: t.get('barrier') in ('ditch', 'tank_trap') or t.get('military') in ('trench',) or t.get('defensive'), 1.5,
                  lambda t: dict(kind='trench' if t.get('military') == 'trench' else 'teeth' if t.get('barrier') == 'tank_trap' else 'ditch'))
trows, _ = lines(lambda t: t.get('natural') == 'tree_row' or t.get('barrier') == 'hedge', 3, lambda t: {})
bunkers = []
for n in nodes.values():
    t = n.get('tags') or {}
    if t.get('military') in ('bunker', 'trench') or t.get('barrier') == 'tank_trap':
        x, y = P(n['lat'], n['lon'])
        if W.contains(Polygon([(x - 1, y - 1), (x + 1, y - 1), (x + 1, y + 1), (x - 1, y + 1)])): bunkers.append([round(n['lat'], 5), round(n['lon'], 5)])
for w in ways.values():
    t = w.get('tags') or {}
    if t.get('military') == 'bunker':
        p = [(nodes[i]['lat'], nodes[i]['lon']) for i in w['nodes'] if i in nodes]
        if p: bunkers.append([round(sum(a for a, b in p) / len(p), 5), round(sum(b for a, b in p) / len(p), 5)])
# ---- house plots along village streets that OSM has no building footprints for (the war zone is mapped street by
# street, but only some villages house by house): a rural plot every 25-45 m on both sides of the street, the house
# 9-12 x 7-9 m, its centre 13-19 m from the street's centre line (as tools/maps_real/osm2map.py does for the Robotyne battle map).
# Not where OSM has buildings within 30 m, not in fields / woods / water, not on another road.
# plots: [lat, lon, w (along the street), d, angle of the street (rad, from east towards north), side (+1 left of the street)]
from shapely.strtree import STRtree
from shapely.geometry import Point
import random
bxy = []
for f in sorted(glob.glob(f'/tmp/osmv2/{side}/*.json')) + sorted(glob.glob(os.path.join(REPO, 'assets/campaign/osm', S, 'sector_*.json'))):
    try: els = json.load(open(f))['elements']
    except Exception: continue
    nn = {e['id']: (e['lat'], e['lon']) for e in els if e['type'] == 'node'}
    for e in els:
        if e['type'] == 'way' and (e.get('tags') or {}).get('building'):
            q = [nn.get(i) or (nodes[i]['lat'], nodes[i]['lon']) if (i in nn or i in nodes) else None for i in e['nodes']]
            q = [v for v in q if v]
            if q: bxy.append(P(sum(a for a, b in q) / len(q), sum(b for a, b in q) / len(q)))
btree = STRtree([Point(x, y) for x, y in bxy]) if bxy else None
def ring_xy(e): r = e['r'][0] if isinstance(e, dict) else e; return [P(a, b) for a, b in r]
blockers = [Polygon(ring_xy(e)).buffer(0) for k in ('fields', 'woods', 'water', 'orchards') for e in out[k]]
blockers = [b for b in blockers if not b.is_empty]
ptree = STRtree(blockers)
resl = [Polygon(ring_xy(e['p'])).buffer(0) for e in out['built'] if e['k'] == 'res']
rtree = STRtree(resl) if resl else None
roadl = [LineString([P(a, b) for a, b in w['pts']]) for w in ways_out if w['c'] != 'track' and len(w['pts']) > 1]
rdtree = STRtree(roadl)
resid = [LineString([P(a, b) for a, b in w['pts']]) for w in ways_out if w['c'] == 'residential' and len(w['pts']) > 1]
retree = STRtree(resid) if resid else None
rnd = random.Random(7); plots = []; placed = []
def hits(tree, geom, d):
    return tree is not None and len(tree.query(geom, predicate='dwithin', distance=d)) > 0
for w in ways_out:
    if w['c'] not in ('residential', 'unclassified', 'tertiary', 'secondary') or len(w['pts']) < 2: continue
    L = LineString([P(a, b) for a, b in w['pts']])
    t = rnd.uniform(5, 20)
    while t < L.length - 5:
        a = L.interpolate(t); b = L.interpolate(min(L.length, t + 2)); dx, dy = b.x - a.x, b.y - a.y; n = math.hypot(dx, dy) or 1; dx, dy = dx / n, dy / n
        street = w['c'] == 'residential' or hits(retree, a, 110) or (rtree is not None and len(rtree.query(a, predicate='within')) > 0)
        if street:
            for sd in (-1, 1):
                if rnd.random() < 0.12: continue
                off = rnd.uniform(13, 19); hx, hy = a.x - dy * off * sd, a.y + dx * off * sd
                hp = Point(hx, hy)
                if hits(btree, hp, 30) or hits(ptree, hp, 2) or len(rdtree.query(hp, predicate='dwithin', distance=9)) > 0: continue
                if any(abs(px - hx) < 16 and abs(py - hy) < 16 for px, py in placed[-60:]): continue
                placed.append((hx, hy)); wv, dv = rnd.uniform(9, 12), rnd.uniform(7, 9)
                plots.append(U(hx, hy) + [round(wv, 1), round(dv, 1), round(math.atan2(dy, dx), 3), sd])
        t += rnd.uniform(25, 45)
plots = [p for p in plots if W.contains(Point(*P(p[0], p[1])))]
print('plots', len(plots), 'osm buildings', len(bxy), file=sys.stderr)
geo = dict(out)
geo['plots'] = plots
geo.update(ways=ways_out, rivers=rivers, streams=streams, rail=rail, forts=forts, bunkers=bunkers, treeRows=[r['pts'] for r in trows])
# older readers (pre-v6 map3d): main roads / minor
geo['roads'] = [dict(kind='highway' if w['c'] in ('primary', 'secondary') else 'road', ref=w.get('ref'), pts=w['pts']) for w in ways_out if w['c'] in ('primary', 'secondary', 'tertiary')]
geo['minor'] = [dict(kind='track', pts=w['pts']) for w in ways_out if w['c'] == 'unclassified']
# ---- relief (Terrarium DEM)
def relief():
    import numpy as np
    from PIL import Image
    z = 12; n = 2 ** z
    tx = lambda lo: (lo + 180) / 360 * n
    ty = lambda la: (1 - math.log(math.tan(math.radians(la)) + 1 / math.cos(math.radians(la))) / math.pi) / 2 * n
    x0, x1, y0, y1 = int(tx(lonW - 0.01)), int(tx(lonE + 0.01)), int(ty(latN + 0.01)), int(ty(latS - 0.01))
    os.makedirs('/tmp/dem', exist_ok=True)
    mos = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), np.float32)
    for X in range(x0, x1 + 1):
        for Y in range(y0, y1 + 1):
            fp = f'/tmp/dem/{z}_{X}_{Y}.png'
            if not os.path.exists(fp):
                url = f'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{X}/{Y}.png'
                d = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'smo-map-build/1.0'}), timeout=60).read()
                open(fp, 'wb').write(d); time.sleep(0.2)
            a = np.asarray(Image.open(fp).convert('RGB'), np.float32)
            mos[(Y - y0) * 256:(Y - y0 + 1) * 256, (X - x0) * 256:(X - x0 + 1) * 256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    # resample onto the grid's equirectangular frame at ~20 m / px
    wm, hm = (lonE - lonW) * KX, (latN - latS) * KY; px = 20.0
    Wp, Hp = int(round(wm / px)), int(round(hm / px))
    lo = lonW + (np.arange(Wp) + 0.5) / Wp * (lonE - lonW); la = latN - (np.arange(Hp) + 0.5) / Hp * (latN - latS)
    fx = (np.array([tx(v) for v in lo]) - x0) * 256 - 0.5; fy = (np.array([ty(v) for v in la]) - y0) * 256 - 0.5
    FX, FY = np.meshgrid(fx, fy); ix, iy = np.floor(FX).astype(int), np.floor(FY).astype(int); ax, ay = FX - ix, FY - iy
    g = lambda j, i: mos[np.clip(j, 0, mos.shape[0] - 1), np.clip(i, 0, mos.shape[1] - 1)]
    E = g(iy, ix) * (1 - ax) * (1 - ay) + g(iy, ix + 1) * ax * (1 - ay) + g(iy + 1, ix) * (1 - ax) * ay + g(iy + 1, ix + 1) * ax * ay
    # light smoothing (SRTM speckle), hillshade from the north-west at 40 deg, slopes x ZF (the steppe is gentle: balkas
    # 20-40 m deep over 0.5-1 km); 128 = flat ground
    from numpy.lib.stride_tricks import sliding_window_view as sw
    lo_, hi_ = np.percentile(E, [0.5, 99.5]); E = np.clip(E, lo_, hi_)
    Ep = np.pad(E, 1, mode='edge'); E = np.median(sw(Ep, (3, 3)), axis=(2, 3))
    Ep = np.pad(E, 3, mode='edge'); E2 = sw(Ep, (7, 7)).mean(axis=(2, 3))
    Ep = np.pad(E2, 2, mode='edge'); E2 = sw(Ep, (5, 5)).mean(axis=(2, 3))
    ZF = 2.5
    dzdx = (np.roll(E2, -1, 1) - np.roll(E2, 1, 1)) / (2 * px) * ZF; dzdy = (np.roll(E2, 1, 0) - np.roll(E2, -1, 0)) / (2 * px) * ZF
    dzdx[:, [0, -1]] = 0; dzdy[[0, -1], :] = 0
    az, alt = math.radians(315), math.radians(40)
    lx, ly, lz = math.cos(alt) * math.sin(az), math.cos(alt) * math.cos(az), math.sin(alt)
    nn = np.sqrt(dzdx ** 2 + dzdy ** 2 + 1)
    sh = (-dzdx * lx - dzdy * ly + lz) / nn / lz   # 1 = flat
    img = np.clip(128 + (sh - 1) * 300, 0, 255).astype(np.uint8)
    name = 'relief_ext.jpg' if side.endswith('X') else 'relief_v2.jpg'
    Image.fromarray(img, 'L').save(os.path.join(os.path.dirname(OUT), name), quality=88)
    return dict(url=f'assets/campaign/osm/{S}/{name}', bbox=[latS, lonW, latN, lonE], zmin=round(float(E.min()), 1), zmax=round(float(E.max()), 1), px=px, zf=ZF)
try: geo['relief'] = relief()
except Exception as ex: print('relief failed', ex, file=sys.stderr)
D = json.load(open(OUT)); D['geo'] = geo; D['geoVersion'] = 6
if os.environ.get('GEO_DRY'): OUT = os.path.join(os.environ['GEO_DRY'], os.path.basename(OUT)); os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(D, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
A = W.area
print('ok', OUT, f'{os.path.getsize(OUT) / 1024:.0f} KB', {k: len(v) for k, v in geo.items() if isinstance(v, list)},
      'cover%', {k: round(100 * v / A, 1) for k, v in area.items()}, 'ways km', round(wl / 1000), 'forts km', round(fl / 1000, 1), geo.get('relief'), file=sys.stderr)
