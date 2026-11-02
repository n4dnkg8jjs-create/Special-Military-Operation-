# Convert an OpenStreetMap extract into the compact layout data of a real-place battle map
# (src/world/real/<name>_osm.js, read by src/world/real.js).
#   python3 tools/maps_real/osm2map.py robotyne|avdiivka|all
# Map data (c) OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
#
# Frame: game metres, x east, z south (north = -Z) around the map centre, then rotated by ROT degrees about the
# vertical (180 = the real north lies at the game's +Z / southern edge).  Everything is clipped to the square
# +-(size/2 + MARGIN).  Output:
#   roads     [{pts, w, type: paved|street|drive|track|gravel, cls, name}]       carriageway centre lines
#   paths     [[x, z]...]                                                          footways / paths (worn earth)
#   buildings [{x, z, L, D, rot, cls, lv, name, parts: [[x, z, L, D]...]}]        oriented min-area rectangle (+ parts of
#             L / U / H shaped footprints in the building frame); rot = game Building rotation (local +X = long side)
#   areas     [{t, pts, name}]                                                     landuse / natural / leisure polygons
#   lines     [{t, pts}]                                                           tree rows, streams, rails, walls, ...
#   pois      [[name, x, z, kind]]
import sys, os, math, json, glob
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from osmlib import OSM, files_for
from shapely.geometry import Polygon, LineString, box, MultiPolygon, MultiLineString, GeometryCollection
from shapely.ops import unary_union
from shapely import affinity

REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
MARGIN = 24
CFG = {
    # Robotyne (Zaporizhzhia oblast): the village on the T-04-08 Orikhiv - Tokmak road, UA counter-offensive Jun-Aug 2023.
    # OSM maps the streets of Robotyne but only ~60 of its houses: the plots along the streets are inferred (house + yard +
    # garden strip, rural frontage 30-42 m) wherever the street runs through the built-up area (checked against imagery:
    # every street in the square is lined with houses, the fields / school / farm / balkas are not).
    'robotyne': dict(side='UA', lat=47.4437, lon=35.8316, size=1400, rot=180, files=['robotyne_area.json'],
                     plots=dict(frontage=(30, 42), setback=(6, 11), depth=(55, 85), house=(10.5, 8), streets=('residential', 'unclassified', 'secondary', 'tertiary'),
                                excl=[[(-470, -724), (-25, -724), (-25, -125), (-470, -125)],          # fields + school north-west of the centre
                                      [(-60, -724), (345, -724), (330, -470), (-60, -470)],             # fields south of Silska
                                      [(130, -480), (300, -480), (430, -480), (440, -60), (130, -60)],  # fields / tree belt between Silska and the T-04-08
                                      [(324, -724), (724, -724), (724, 724), (586, 724), (483, 75), (458, -63)]],   # west of the T-04-08: open fields
                                sparse=[([(300, -60), (520, -60), (600, 724), (300, 724)], 0.22), ([(-724, -95), (470, -95), (470, 22), (-724, 22)], 0.4)])),
    # Avdiivka (Donetsk oblast): south-eastern edge of the town -- the eastern microdistricts, the stadium and garage
    # cooperatives, the Yasynuvata - Avdiivka railway, the old town on vul. Soborna and the dachas / private sector
    # facing the Promzona and Tsarska Okhota (the 2023-24 southern / eastern approach).
    'avdiivka': dict(side='RU', lat=48.1289, lon=37.7519, size=1280, rot=0, files=['avdiivka_se.json'],
                     # the old town east of the railway is only partly mapped house by house: infer the rest (urban plots, 18-24 m)
                     plots=dict(frontage=(18, 25), setback=(4, 7), depth=(30, 45), house=(9.5, 8), streets=('residential', 'living_street', 'unclassified', 'tertiary'),
                                excl=[[(-664, -664), (-15, -664), (-15, 280), (-664, 280)],               # west of the railway: microdistricts
                                      [(-664, 280), (60, 280), (60, 664), (-664, 664)]],                 # railway corridor + fields to the south-west
                                sparse=[])),
}

def r1(v): return round(v, 1)
def rect(x, z, L, D, rot):
    # corners of a Building-frame rectangle (Building.toWorld: (lx, lz) -> (x + lx cos + lz sin, z - lx sin + lz cos))
    c, s = math.cos(rot), math.sin(rot)
    return [(x + lx * c + lz * s, z - lx * s + lz * c) for lx, lz in ((-L / 2, -D / 2), (L / 2, -D / 2), (L / 2, D / 2), (-L / 2, D / 2))]

def run(name):
    C = CFG[name]
    files = [os.path.join(HERE, 'osm', f) for f in C['files']] + files_for(C['side'])
    o = OSM(files).proj(C['lat'], C['lon'])
    th = math.radians(C['rot']); ct, st = math.cos(th), math.sin(th)
    P0 = o.P
    def P(lat, lon):
        x, z = P0(lat, lon); return (x * ct - z * st, x * st + z * ct)
    o.P = P
    half = C['size'] / 2; clipbox = box(-half - MARGIN, -half - MARGIN, half + MARGIN, half + MARGIN)
    inner = box(-half, -half, half, half)
    out = dict(name=name, size=C['size'], rot=C['rot'], lat=C['lat'], lon=C['lon'], roads=[], paths=[], buildings=[], areas=[], lines=[], pois=[],
               credit='Map data (c) OpenStreetMap contributors, ODbL 1.0')
    rural = C['side'] == 'UA'

    def lines_of(g):
        if g.is_empty: return []
        if isinstance(g, LineString): return [list(g.coords)]
        if isinstance(g, (MultiLineString, GeometryCollection)): return [c for gg in g.geoms for c in lines_of(gg)]
        return []
    def polys_of(g):
        if g.is_empty: return []
        if isinstance(g, Polygon): return [g]
        if isinstance(g, (MultiPolygon, GeometryCollection)): return [p for gg in g.geoms for p in polys_of(gg)]
        return []
    def clipline(pts, tol=0.4):
        if len(pts) < 2: return []
        g = LineString(pts).intersection(clipbox)
        return [[[r1(x), r1(z)] for x, z in LineString(c).simplify(tol).coords] for c in lines_of(g) if len(c) >= 2]
    def clippoly(pts, tol=0.8):
        if len(pts) < 4: return []
        try: g = Polygon(pts).buffer(0)
        except Exception: return []
        g = g.intersection(clipbox)
        res = []
        for p in polys_of(g):
            p = p.simplify(tol)
            if p.area < 4: continue
            res.append([[r1(x), r1(z)] for x, z in list(p.exterior.coords)[:-1]])
        return res

    # ---------------------------------------------------------------- roads / paths
    HW = {'motorway': ('paved', 9), 'trunk': ('paved', 8.5), 'primary': ('paved', 8), 'secondary': ('paved', 7.2), 'tertiary': ('paved', 6.5),
          'unclassified': ('street', 5.5), 'residential': ('street', 5.5), 'living_street': ('drive', 4.2), 'service': ('drive', 3.8), 'track': ('track', 3.4)}
    for w in o.ways.values():
        t = w.get('tags', {}); h = t.get('highway')
        if not h: continue
        pts = o.pts(w)
        if h in ('footway', 'path', 'pedestrian', 'steps', 'cycleway', 'bridleway'):
            for l in clipline(pts, 0.6): out['paths'].append(l)
            continue
        if h not in HW or t.get('area') == 'yes': continue
        typ, wd = HW[h]
        surf = t.get('surface', '')
        if h == 'service' and t.get('service') in ('parking_aisle', 'drive-through'): wd = 3.2
        if h == 'service' and t.get('service') == 'driveway': wd = 3.0
        if typ == 'street' and (rural or surf in ('gravel', 'unpaved', 'ground', 'dirt', 'compacted', 'fine_gravel')): typ = 'gravel'
        if typ == 'drive' and surf in ('gravel', 'unpaved', 'ground', 'dirt'): typ = 'track'
        for l in clipline(pts):
            out['roads'].append(dict(pts=l, w=wd, type=typ, cls=h, name=t.get('name:uk') or t.get('name') or ''))

    # ---------------------------------------------------------------- buildings
    def classify(t, area, lv):
        b = t.get('building', 'yes')
        if b in ('apartments', 'dormitory', 'residential') and (lv or 3) >= 3: return 'block'
        if b in ('school', 'kindergarten', 'college', 'university', 'hospital'): return 'school'
        if b in ('civic', 'office', 'public', 'government', 'commercial', 'hotel') and ((lv or 1) >= 2 or area > 450): return 'civic'
        if b in ('retail', 'supermarket', 'commerce') and (lv or 1) >= 2: return 'civic'
        if b in ('retail', 'supermarket', 'commerce', 'kiosk', 'shop'): return 'shop' if area > 25 else 'kiosk'
        if b in ('garages', 'garage', 'carport'): return 'garages'
        if b in ('church', 'chapel', 'cathedral'): return 'church'
        if b == 'silo': return 'silo'
        if b in ('collapsed', 'ruins', 'destroyed', 'damaged'): return 'ruin'
        if b == 'construction': return 'ruin' if area > 60 else 'shed'
        if b in ('house', 'detached', 'semidetached_house', 'bungalow', 'terrace', 'farm'): return 'house' if area < 260 else 'hall'
        if b in ('industrial', 'warehouse', 'service', 'manufacture', 'barn', 'cowshed', 'farm_auxiliary', 'stable', 'greenhouse', 'transportation', 'train_station', 'hangar', 'sports_hall'):
            return 'hall' if area > 45 else 'shed'
        if b in ('shed', 'hut', 'roof', 'cabin', 'outbuilding', 'toilets', 'shelter', 'container'): return 'shed'
        # building=yes: by size / storeys
        if (lv or 1) >= 3 and area > 250: return 'block'
        if area < 30: return 'shed'
        if area < 230: return 'house'
        return 'hall'
    def rect_parts(poly, ang, L, D, minw):
        # greedy cover of an L / U / H footprint by up to 4 rectangles in the min-rect frame
        c = poly.centroid
        q = affinity.rotate(poly, -ang, origin=c, use_radians=True)
        x0, z0, x1, z1 = q.bounds; nx, nz = int(math.ceil(x1 - x0)), int(math.ceil(z1 - z0))
        if nx * nz > 200000: return None
        from shapely.geometry import Point
        from shapely.prepared import prep
        pq = prep(q)
        grid = [[1 if pq.contains(Point(x0 + i + 0.5, z0 + j + 0.5)) else 0 for i in range(nx)] for j in range(nz)]
        total = sum(map(sum, grid)) or 1; parts = []; covered = 0
        for _ in range(4):
            # largest all-ones rectangle (histogram method)
            best = (0, None); hgt = [0] * nx
            for j in range(nz):
                for i in range(nx): hgt[i] = hgt[i] + 1 if grid[j][i] else 0
                stack = []
                for i in range(nx + 1):
                    hh = hgt[i] if i < nx else 0; start = i
                    while stack and stack[-1][1] >= hh:
                        s, sh = stack.pop(); a = sh * (i - s)
                        if a > best[0] and sh >= minw and (i - s) >= minw: best = (a, (s, j - sh + 1, i, j + 1))
                        start = s
                    stack.append((start, hh))
            if not best[1]: break
            i0, j0, i1, j1 = best[1]
            for j in range(j0, j1):
                for i in range(i0, i1): grid[j][i] = 2
            covered += best[0]
            for j in range(j0, j1):
                for i in range(i0, i1): grid[j][i] = 0
            parts.append(((i0 + i1) / 2 + x0, (j0 + j1) / 2 + z0, i1 - i0, j1 - j0))
            if covered / total > 0.9: break
        res = []
        for (cx, cz, a, b) in parts:
            # back to the game frame: rotate the part centre by +ang about the footprint centroid
            dx, dz = cx - c.x, cz - c.y
            wx, wz = c.x + dx * math.cos(ang) - dz * math.sin(ang), c.y + dx * math.sin(ang) + dz * math.cos(ang)
            res.append((wx, wz, a, b))
        return res
    for w in o.ways.values():
        t = w.get('tags', {})
        if 'building' not in t or not o.closed(w): continue
        pts = o.pts(w)
        try: poly = Polygon(pts).buffer(0)
        except Exception: continue
        if poly.is_empty or not inner.buffer(4).contains(poly.centroid): continue
        area = poly.area
        if area < 4: continue
        try: lv = float(t.get('building:levels', '').split(';')[0]) if t.get('building:levels') else None
        except ValueError: lv = None
        cls = classify(t, area, lv)
        mr = poly.minimum_rotated_rectangle
        cs = list(mr.exterior.coords)
        e1 = (cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]); e2 = (cs[2][0] - cs[1][0], cs[2][1] - cs[1][1])
        l1, l2 = math.hypot(*e1), math.hypot(*e2)
        ax = e1 if l1 >= l2 else e2; L, D = max(l1, l2), min(l1, l2)
        ang = math.atan2(ax[1], ax[0])           # long axis direction in the (x, z) plane
        rot = math.atan2(-ax[1], ax[0])          # Building.toWorld: local +X -> (cos rot, -sin rot)
        c = mr.centroid
        rec = dict(x=r1(c.x), z=r1(c.y), L=r1(L), D=r1(D), rot=round(rot, 4), cls=cls, a=round(area))
        if lv: rec['lv'] = lv
        nm = t.get('name:uk') or t.get('name')
        if nm: rec['name'] = nm
        if t.get('building') not in ('yes',): rec['b'] = t.get('building')
        fill = area / max(1, mr.area)
        if cls in ('block', 'school', 'civic', 'hall', 'garages') and fill < 0.86 and L > 14:
            parts = rect_parts(poly, ang, L, D, 6 if cls in ('hall', 'garages') else 9)
            if parts and len(parts) > 1: rec['parts'] = [[r1(a), r1(b), r1(cc), r1(d)] for a, b, cc, d in parts]
        out['buildings'].append(rec)

    # ---------------------------------------------------------------- areas
    AREA = {('landuse', k): k for k in ('farmland', 'meadow', 'grass', 'residential', 'industrial', 'garages', 'allotments', 'orchard', 'vineyard', 'brownfield', 'construction', 'railway', 'cemetery', 'commercial', 'retail', 'forest', 'landfill', 'greenfield', 'village_green', 'plant_nursery')}
    AREA.update({('natural', k): k for k in ('wood', 'scrub', 'grassland', 'heath', 'water', 'wetland', 'sand')})
    AREA.update({('leisure', k): k for k in ('pitch', 'park', 'playground', 'stadium', 'track', 'garden', 'sports_centre')})
    AREA.update({('amenity', k): k for k in ('parking', 'school', 'kindergarten', 'hospital')})
    def area_type(t):
        for (k, v), typ in AREA.items():
            if t.get(k) == v: return typ
        return None
    for w in o.ways.values():
        t = w.get('tags', {})
        if 'building' in t or not o.closed(w): continue
        typ = area_type(t)
        if not typ: continue
        for p in clippoly(o.pts(w)): out['areas'].append(dict(t=typ, pts=p, name=t.get('name:uk') or t.get('name') or ''))
    for t, pts, rid in o.multipolygons():
        typ = area_type(t)
        if not typ: continue
        for p in clippoly(pts): out['areas'].append(dict(t=typ, pts=p, name=t.get('name:uk') or t.get('name') or ''))

    # ---------------------------------------------------------------- lines
    for w in o.ways.values():
        t = w.get('tags', {}); typ = None
        if t.get('natural') == 'tree_row': typ = 'tree_row'
        elif t.get('barrier') == 'hedge': typ = 'hedge'
        elif t.get('waterway') in ('stream', 'river', 'ditch', 'drain', 'canal'): typ = 'stream'
        elif t.get('railway') in ('rail', 'light_rail'): typ = 'rail_siding' if t.get('service') in ('siding', 'yard', 'spur') else 'rail'
        elif t.get('railway') in ('disused', 'abandoned'): typ = 'rail_old'
        elif t.get('railway') == 'platform': typ = 'platform'
        elif t.get('barrier') in ('wall', 'retaining_wall'): typ = 'wall'
        elif t.get('barrier') == 'fence': typ = 'fence'
        elif t.get('military') == 'trench': typ = 'trench'
        elif t.get('barrier') == 'ditch' or t.get('man_made') == 'dyke': typ = 'at_ditch'
        elif t.get('power') in ('line', 'minor_line'): typ = 'power'
        elif t.get('man_made') == 'pipeline' and t.get('location') not in ('underground',): typ = 'pipe'
        elif t.get('man_made') == 'embankment': typ = 'embankment'
        if not typ: continue
        if typ == 'platform' and o.closed(w):
            for p in clippoly(o.pts(w), 0.3): out['areas'].append(dict(t='platform', pts=p, name=''))
            continue
        for l in clipline(o.pts(w), 0.5): out['lines'].append(dict(t=typ, pts=l))

    # ---------------------------------------------------------------- pois
    for n in o.nodes.values():
        t = n.get('tags', {})
        if 'name' not in t: continue
        x, z = P(n['lat'], n['lon'])
        if abs(x) < half and abs(z) < half:
            out['pois'].append([t.get('name:uk') or t['name'], r1(x), r1(z), t.get('amenity') or t.get('shop') or t.get('place') or t.get('railway') or t.get('highway') or ''])
    for w in o.ways.values():
        t = w.get('tags', {})
        if 'name' not in t or 'highway' in t or not o.closed(w): continue
        p = o.pts(w); cx = sum(q[0] for q in p) / len(p); cz = sum(q[1] for q in p) / len(p)
        if abs(cx) < half and abs(cz) < half:
            out['pois'].append([t.get('name:uk') or t['name'], r1(cx), r1(cz), t.get('amenity') or t.get('leisure') or t.get('building') or t.get('landuse') or ''])


    # ---------------------------------------------------------------- inferred house plots (see CFG plots)
    PL = C.get('plots')
    out['plots'] = []
    if PL:
        import random
        rnd = random.Random(1234)
        from shapely.geometry import Point
        from shapely.prepared import prep
        excl = unary_union([Polygon(p) for p in PL['excl']] + [Polygon(a['pts']).buffer(2) for a in out['areas'] if a['t'] in
                ('farmland', 'industrial', 'school', 'kindergarten', 'hospital', 'garages', 'pitch', 'stadium', 'parking', 'wood', 'forest', 'brownfield', 'cemetery', 'railway', 'water', 'construction', 'landfill', 'meadow', 'park', 'playground') and len(a['pts']) > 2
                and not (a['t'] == 'brownfield' and Polygon(a['pts']).area > 2e5)])   # (Robotyne: the whole ruined village is landuse=brownfield)
        excl = unary_union([excl] + [LineString(l['pts']).buffer(16) for l in out['lines'] if l['t'] in ('stream', 'rail', 'rail_old', 'tree_row')])
        exP = prep(excl.buffer(0))
        roadG = unary_union([LineString(r['pts']).buffer(r['w'] / 2 + 2.5) for r in out['roads'] if len(r['pts']) > 1])
        roadP = prep(roadG)
        taken = [Polygon(rect(b['x'], b['z'], b['L'] + 6, b['D'] + 6, b['rot'])) for b in out['buildings']]
        from shapely.strtree import STRtree
        sparse = [(prep(Polygon(p)), d) for p, d in PL['sparse']]
        HL, HD = PL['house']
        newb = []
        def free(poly):
            for t in taken:
                if t.intersects(poly): return False
            return True
        for r in out['roads']:
            if r['cls'] not in PL['streets'] or len(r['pts']) < 2: continue
            ln = LineString(r['pts']); L = ln.length; hw = r['w'] / 2
            for side in (-1, 1):
                t = rnd.uniform(4, 14)
                while t < L - 4:
                    fr = rnd.uniform(*PL['frontage'])
                    p0 = ln.interpolate(max(0, t - 1)); p1 = ln.interpolate(min(L, t + 1))
                    dx, dz = p1.x - p0.x, p1.y - p0.y; dl = math.hypot(dx, dz) or 1; ux, uz = dx / dl, dz / dl
                    nx, nz = -uz * side, ux * side                     # outward normal of this side
                    c = ln.interpolate(t)
                    sb = rnd.uniform(*PL['setback'])
                    hx, hz = c.x + nx * (hw + sb + HD / 2), c.y + nz * (hw + sb + HD / 2)
                    ry = math.atan2(-nx, -nz)                            # template local +Z (front door) faces the street
                    brot = ry                                            # house local +X along the street
                    hp = Polygon(rect(hx, hz, HL + 1, HD + 1, brot))
                    dens = 0.93
                    for sp, d in sparse:
                        if sp.contains(Point(hx, hz)): dens = d
                    ok = abs(hx) < half - 6 and abs(hz) < half - 6 and not exP.intersects(hp) and not roadP.intersects(hp) and free(hp.buffer(2.5))
                    if ok and rnd.random() < dens:
                        dep = rnd.uniform(*PL['depth'])
                        # plot: from the street edge outward, frontage wide, as deep as it stays clear of roads / exclusions
                        def quad(dd):
                            a = (c.x + nx * (hw + 1) - ux * fr / 2, c.y + nz * (hw + 1) - uz * fr / 2); b = (c.x + nx * (hw + 1) + ux * fr / 2, c.y + nz * (hw + 1) + uz * fr / 2)
                            return Polygon([a, b, (b[0] + nx * dd, b[1] + nz * dd), (a[0] + nx * dd, a[1] + nz * dd)])
                        while dep > 22 and (exP.intersects(quad(dep).buffer(-1)) or roadP.intersects(quad(dep).buffer(-1.5)) or not free(Polygon(quad(dep).exterior.coords[2:4] + [(c.x + nx * (hw + sb + HD + 2), c.y + nz * (hw + sb + HD + 2))]).buffer(0))):
                            dep -= 6
                        q = quad(dep)
                        rec = dict(x=r1(hx), z=r1(hz), L=HL, D=HD, rot=round(brot, 4), cls='house', syn=1)
                        newb.append(rec); taken.append(hp.buffer(1.5)); taken.append(q.buffer(-2.5)) if q.area > 200 else None
                        out['plots'].append(dict(pts=[[r1(x), r1(z)] for x, z in list(q.exterior.coords)[:-1]], h=len(out['buildings']) + len(newb) - 1, f=[r1(-nx), r1(-nz)]))
                    t += fr
        out['buildings'] += newb
        # plots for the mapped houses too: nearest street within 45 m
        streets = [(LineString(r['pts']), r['w'] / 2) for r in out['roads'] if r['cls'] in PL['streets'] + ('track', 'service') and len(r['pts']) > 1]
        for i, b in enumerate(out['buildings']):
            if b.get('syn') or b['cls'] not in ('house', 'shed'): continue
            p = Point(b['x'], b['z']); best = None
            for ln, hw in streets:
                d = ln.distance(p)
                if d < 45 and (best is None or d < best[0]): best = (d, ln, hw)
            if not best: continue
            d, ln, hw = best; c = ln.interpolate(ln.project(p)); nx, nz = (b['x'] - c.x) / (d or 1), (b['z'] - c.y) / (d or 1)
            ux, uz = -nz, nx; fr = 26
            a = (c.x + nx * (hw + 1) - ux * fr / 2, c.y + nz * (hw + 1) - uz * fr / 2); bb = (c.x + nx * (hw + 1) + ux * fr / 2, c.y + nz * (hw + 1) + uz * fr / 2)
            dd = max(d + 20, 45 if PL['frontage'][0] > 25 else 32)
            q = Polygon([a, bb, (bb[0] + nx * dd, bb[1] + nz * dd), (a[0] + nx * dd, a[1] + nz * dd)])
            if exP.intersects(q.buffer(-3)) or roadP.intersects(q.buffer(-2)): continue
            out['plots'].append(dict(pts=[[r1(x), r1(z)] for x, z in list(q.exterior.coords)[:-1]], h=i, f=[r1(-nx), r1(-nz)]))

    dst = os.path.join(REPO, 'src', 'world', 'real', f'{name}_osm.js')
    js = json.dumps(out, ensure_ascii=False, separators=(',', ':'))
    with open(dst, 'w') as f:
        f.write(f'// Generated by tools/maps_real/osm2map.py from OpenStreetMap ({", ".join(C["files"])}).\n'
                f'// Map data (c) OpenStreetMap contributors, ODbL 1.0 -- https://www.openstreetmap.org/copyright\n'
                f'export default {js};\n')
    from collections import Counter
    print(name, 'roads', len(out['roads']), 'paths', len(out['paths']), 'buildings', len(out['buildings']), Counter(b['cls'] for b in out['buildings']),
          'syn', sum(1 for b in out['buildings'] if b.get('syn')), 'plots', len(out['plots']), 'areas', Counter(a['t'] for a in out['areas']), 'lines', Counter(l['t'] for l in out['lines']), f'{len(js) // 1024} KB')

if __name__ == '__main__':
    for n in (CFG if sys.argv[1:] in ([], ['all']) else sys.argv[1:]): run(n)
