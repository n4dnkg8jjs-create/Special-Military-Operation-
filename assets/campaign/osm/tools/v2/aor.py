# aor.py SIDE (UA|RU|UAX|RUX) -> /tmp/osmv2/aor_SIDE.json : per-cell terrain stats + simplified geometry (lat/lon) from OSM tiles
import json, glob, math, sys, collections
side = sys.argv[1]
G = {'UA': dict(latN=47.610, lonW=35.650, dLa=0.01809, dLo=0.02658, cols=14, rows=14),
     'RU': dict(latN=48.270, lonW=37.560, dLa=0.01809, dLo=0.02693, cols=12, rows=12),
     # grid extensions (campaign v5: the grid grows past the original AOR) — cell ids keep the parent grid's numbering
     'UAX': dict(latN=47.35674, lonW=35.650, dLa=0.01809, dLo=0.02658, cols=14, rows=7, col0=0, row0=14),
     'RUX': dict(latN=48.270, lonW=37.40242, dLa=0.01809, dLo=0.02693, cols=6, rows=12, col0=-6, row0=0)}[side]
COL0, ROW0 = G.get('col0', 0), G.get('row0', 0)
latN, lonW, dLa, dLo, C, R = G['latN'], G['lonW'], G['dLa'], G['dLo'], G['cols'], G['rows']
latS, lonE = latN - R*dLa, lonW + C*dLo
KX = 111.32*math.cos(math.radians((latN+latS)/2)); KY = 110.57
nodes, ways, rels = {}, {}, {}
for f in sorted(glob.glob(f'/tmp/osmv2/{side}/*.json')):
    for e in json.load(open(f))['elements']:
        {'node': nodes, 'way': ways, 'relation': rels}[e['type']][e['id']] = e
print(len(nodes), len(ways), len(rels), file=sys.stderr)
def wll(w): return [(nodes[i]['lat'], nodes[i]['lon']) for i in w['nodes'] if i in nodes]
def km(a, b): return math.hypot((a[0]-b[0])*KY, (a[1]-b[1])*KX)
# ---- polygons by class
def cls_of(t):
    lu, nat, mm = t.get('landuse'), t.get('natural'), t.get('man_made')
    if lu in ('residential', 'retail', 'commercial', 'garages', 'allotments', 'cemetery') or t.get('place') in ('allotments',): return 'res'
    if lu in ('industrial', 'railway', 'brownfield', 'construction') or mm in ('works', 'wastewater_plant', 'water_works'): return 'ind'
    if lu in ('quarry', 'landfill') or mm == 'spoil_heap' or t.get('aeroway') == 'aerodrome': return 'ind2'
    if lu == 'forest' or nat in ('wood', 'scrub'): return 'wood'
    if nat == 'water' or lu in ('reservoir', 'basin') or t.get('waterway') == 'riverbank': return 'water'
    if nat == 'wetland': return 'wet'
    return None
polys = collections.defaultdict(list)
def addpoly(c, ring):
    if len(ring) < 4: return
    la = [p[0] for p in ring]; lo = [p[1] for p in ring]
    polys[c].append((min(la), max(la), min(lo), max(lo), ring))
for w in ways.values():
    t = w.get('tags') or {}
    c = cls_of(t)
    if c and w['nodes'][0] == w['nodes'][-1]: addpoly(c, wll(w))
def join(segs):
    rings, segs = [], [s[:] for s in segs if len(s) > 1]
    while segs:
        cur = segs.pop()
        changed = True
        while changed and cur[0] != cur[-1]:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]: cur += s[1:]; segs.pop(i); changed = True; break
                if s[-1] == cur[-1]: cur += s[::-1][1:]; segs.pop(i); changed = True; break
        if cur[0] == cur[-1]: rings.append(cur)
    return rings
for r in rels.values():
    t = r.get('tags') or {}
    c = cls_of(t)
    if not c: continue
    segs = [ways[m['ref']]['nodes'] for m in r['members'] if m['type'] == 'way' and m.get('role') in ('outer', '') and m['ref'] in ways]
    for ring in join(segs): addpoly(c, [(nodes[i]['lat'], nodes[i]['lon']) for i in ring if i in nodes])
def pip(lat, lon, ring):
    ins = False; j = len(ring)-1
    for i in range(len(ring)):
        yi, xi = ring[i]; yj, xj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj-xi)*(lat-yi)/(yj-yi+1e-15)+xi: ins = not ins
        j = i
    return ins
# ---- lines
def lines(pred):
    out = []
    for w in ways.values():
        t = w.get('tags') or {}
        if pred(t): out.append((t, wll(w)))
    return out
ROADCLS = {'motorway': 2, 'trunk': 2, 'primary': 2, 'secondary': 2, 'tertiary': 1, 'unclassified': 1, 'residential': 1, 'living_street': 1}
roads = lines(lambda t: t.get('highway') in ROADCLS or t.get('highway', '').endswith('_link'))
tracks = lines(lambda t: t.get('highway') == 'track')
streams = lines(lambda t: t.get('waterway') in ('stream', 'river', 'canal', 'ditch'))
rivers = lines(lambda t: t.get('waterway') == 'river')
forts = lines(lambda t: t.get('barrier') in ('ditch', 'tank_trap') or t.get('military') in ('trench', 'bunker') or t.get('defensive'))
rail = lines(lambda t: t.get('railway') in ('rail', 'disused', 'abandoned'))
bunkers = [(n['lat'], n['lon']) for n in nodes.values() if (n.get('tags') or {}).get('military') in ('bunker', 'trench') or (n.get('tags') or {}).get('barrier') == 'tank_trap']
for w in ways.values():
    t = w.get('tags') or {}
    if t.get('military') == 'bunker' and w['nodes'][0] == w['nodes'][-1]:
        p = wll(w);
        if p: bunkers.append((sum(a for a, b in p)/len(p), sum(b for a, b in p)/len(p)))
places = []
for n in nodes.values():
    t = n.get('tags') or {}
    if t.get('place') in ('city', 'town', 'village', 'hamlet', 'suburb', 'neighbourhood', 'isolated_dwelling', 'quarter') and latS <= n['lat'] <= latN and lonW <= n['lon'] <= lonE:
        places.append(dict(name=t.get('name:en') or t.get('name'), uk=t.get('name:uk') or t.get('name'), place=t['place'], pop=int(''.join(ch for ch in t.get('population', '0') if ch.isdigit()) or 0), lat=n['lat'], lon=n['lon']))
# ---- cells
def cellbox(c, r): return (latN-(r+1)*dLa, latN-r*dLa, lonW+c*dLo, lonW+(c+1)*dLo)
def seglen_in(pts, b):
    s0, s1, w0, w1 = b; L = 0
    for a, bb in zip(pts, pts[1:]):
        # sample segment midpoint-based clipping (fine enough: segments are short)
        n = max(1, int(km(a, bb)/0.1))
        for k in range(n):
            u = (k+0.5)/n; la = a[0]+(bb[0]-a[0])*u; lo = a[1]+(bb[1]-a[1])*u
            if s0 <= la <= s1 and w0 <= lo <= w1: L += km(a, bb)/n
    return L
cells = []
NS = 12
for r in range(R):
    for c in range(C):
        b = cellbox(c, r); s0, s1, w0, w1 = b
        cand = {k: [p for p in v if p[0] <= s1 and p[1] >= s0 and p[2] <= w1 and p[3] >= w0] for k, v in polys.items()}
        frac = collections.Counter()
        for i in range(NS):
            for j in range(NS):
                la = s0+(i+0.5)/NS*dLa; lo = w0+(j+0.5)/NS*dLo
                for k in ('water', 'ind', 'ind2', 'res', 'wood', 'wet'):
                    if any(p[0] <= la <= p[1] and p[2] <= lo <= p[3] and pip(la, lo, p[4]) for p in cand.get(k, [])):
                        frac[k] += 1; break
        frac = {k: round(v/NS/NS, 3) for k, v in frac.items()}
        rl = collections.Counter()
        for t, p in roads:
            L = seglen_in(p, b)
            if L: rl[ROADCLS.get(t['highway'].replace('_link', ''), 1)] += L
        tl = sum(seglen_in(p, b) for t, p in tracks)
        sl = sum(seglen_in(p, b) for t, p in streams)
        fl = sum(seglen_in(p, b) for t, p in forts)
        nb = sum(1 for la, lo in bunkers if s0 <= la <= s1 and w0 <= lo <= w1)
        pl = [p for p in places if s0 <= p['lat'] <= s1 and w0 <= p['lon'] <= w1]
        refs = sorted({t.get('ref') for t, p in roads if t.get('ref') and seglen_in(p, b) > 0.2})
        cells.append(dict(id=f'c{c+COL0}_{r+ROW0}', col=c+COL0, row=r+ROW0, latlon=[round((s0+s1)/2, 5), round((w0+w1)/2, 5)], frac=frac,
                          road2=round(rl[2], 2), road1=round(rl[1], 2), track=round(tl, 2), stream=round(sl, 2), fortKm=round(fl, 2), bunkers=nb,
                          places=pl, refs=refs))
    print('row', r, file=sys.stderr)
# ---- simplified geometry for drawing / 3D (lat,lon, ~25-40 m tolerance)
def dp(pts, tol):
    if len(pts) < 3: return pts
    a, b = pts[0], pts[-1]
    def d(p):
        ax, ay, bx, by, px, py = a[1]*KX, a[0]*KY, b[1]*KX, b[0]*KY, p[1]*KX, p[0]*KY
        L = math.hypot(bx-ax, by-ay)
        return abs((by-ay)*px-(bx-ax)*py+bx*ay-by*ax)/L if L > 1e-9 else math.hypot(px-ax, py-ay)
    i, dm = max(((k, d(pts[k])) for k in range(1, len(pts)-1)), key=lambda x: x[1])
    return dp(pts[:i+1], tol)[:-1]+dp(pts[i:], tol) if dm > tol else [a, b]
def inb(p): return latS-0.005 <= p[0] <= latN+0.005 and lonW-0.007 <= p[1] <= lonE+0.007
def clip(pts):
    out, cur = [], []
    for p in pts:
        if inb(p): cur.append(p)
        else:
            if len(cur) > 1: out.append(cur)
            cur = []
    if len(cur) > 1: out.append(cur)
    return out
R5 = lambda p: [round(p[0], 5), round(p[1], 5)]
def geo_lines(src, tol, keyf):
    out = []
    for t, p in src:
        for seg in clip(p):
            s = dp(seg, tol)
            if len(s) > 1: out.append(dict(**keyf(t), pts=[R5(q) for q in s]))
    return out
g = dict(
  roads=geo_lines([(t, p) for t, p in roads if t['highway'].replace('_link', '') in ('motorway', 'trunk', 'primary', 'secondary', 'tertiary')], 0.03,
                  lambda t: dict(kind={'tertiary': 'road'}.get(t['highway'].replace('_link', ''), 'highway'), ref=t.get('ref'), name=t.get('name:en') or t.get('name'))),
  minor=geo_lines([(t, p) for t, p in roads if t['highway'] == 'unclassified'], 0.05, lambda t: dict(kind='track')),
  rivers=geo_lines(rivers, 0.03, lambda t: dict(name=t.get('name:en') or t.get('name'))),
  streams=geo_lines([(t, p) for t, p in streams if t.get('waterway') == 'stream'], 0.05, lambda t: dict(name=t.get('name:en') or t.get('name'))),
  rail=geo_lines(rail, 0.03, lambda t: dict(state=t.get('railway'), name=t.get('name'))),
  forts=geo_lines(forts, 0.015, lambda t: dict(kind='trench' if t.get('military') == 'trench' else 'ditch')),
  bunkers=[R5(p) for p in bunkers],
  woods=[[R5(q) for q in dp(p[4], 0.03)] for p in polys['wood'] if km((p[0], p[2]), (p[1], p[3])) > 0.25],
  built=[[R5(q) for q in dp(p[4], 0.03)] for p in polys['res'] + polys['ind'] + polys['ind2'] if km((p[0], p[2]), (p[1], p[3])) > 0.2],
  water=[[R5(q) for q in dp(p[4], 0.03)] for p in polys['water'] if km((p[0], p[2]), (p[1], p[3])) > 0.15],
)
json.dump(dict(grid=dict(G, latS=latS, lonE=lonE), cells=cells, places=places, geo=g), open(f'/tmp/osmv2/aor_{side}.json', 'w'), ensure_ascii=False)
print('ok', {k: len(v) for k, v in g.items()}, file=sys.stderr)
