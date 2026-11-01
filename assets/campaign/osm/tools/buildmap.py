# Build strategic-map geometry (map units) from the saved OSM JSON. usage: buildmap.py UA|RU out.json
import json, glob, math, sys, os, re
side, outp = sys.argv[1], sys.argv[2]
CFG = {
  'UA': dict(lon0=35.65, lon1=36.02, lat0=47.235, lat1=47.605, km=0.07),
  'RU': dict(lon0=37.58, lon1=37.90, lat0=48.05, lat1=48.26, km=0.03),
}[side]
D = f'/home/claude/special-military-operation-/assets/campaign/osm/{side}'
latm = (CFG['lat0'] + CFG['lat1']) / 2
KX = 111.32 * math.cos(math.radians(latm)); KY = 110.57
W = round((CFG['lon1'] - CFG['lon0']) * KX / CFG['km']); H = round((CFG['lat1'] - CFG['lat0']) * KY / CFG['km'])
def P(lat, lon): return ((lon - CFG['lon0']) * KX / CFG['km'], (CFG['lat1'] - lat) * KY / CFG['km'])
nodes, ways, rels = {}, {}, {}
files = {}
for f in glob.glob(D + '/*.json'):
    d = json.load(open(f))
    if not isinstance(d, dict) or 'elements' not in d: continue
    files[os.path.basename(f)] = d
    for e in d['elements']:
        if e['type'] == 'node': nodes[e['id']] = e
        elif e['type'] == 'way': ways[e['id']] = e
        elif e['type'] == 'relation': rels[e['id']] = e
def wpts(w): return [P(nodes[i]['lat'], nodes[i]['lon']) for i in w['nodes'] if i in nodes]
def dp(pts, tol):
    if len(pts) < 3: return pts
    a, b = pts[0], pts[-1]; dx, dy = b[0]-a[0], b[1]-a[1]; L = math.hypot(dx, dy) or 1e-9
    i, dm = 0, -1
    for k in range(1, len(pts)-1):
        p = pts[k]; dd = abs(dy*p[0] - dx*p[1] + b[0]*a[1] - b[1]*a[0]) / L if L > 1e-9 else math.hypot(p[0]-a[0], p[1]-a[1])
        if dd > dm: i, dm = k, dd
    if dm > tol: return dp(pts[:i+1], tol)[:-1] + dp(pts[i:], tol)
    return [a, b]
def inside(p): return 0 <= p[0] <= W and 0 <= p[1] <= H
def clip_line(pts):
    # split polyline at bbox; crude: keep runs of inside points + interpolated crossings
    out, cur = [], []
    def cross(a, b):
        t0, t1 = 0, 1; dx, dy = b[0]-a[0], b[1]-a[1]
        for pk, qk in ((-dx, a[0]), (dx, W-a[0]), (-dy, a[1]), (dy, H-a[1])):
            if pk == 0:
                if qk < 0: return None
            else:
                r = qk / pk
                if pk < 0: t0 = max(t0, r)
                else: t1 = min(t1, r)
        if t0 > t1: return None
        return (a[0]+t0*dx, a[1]+t0*dy), (a[0]+t1*dx, a[1]+t1*dy)
    for a, b in zip(pts, pts[1:]):
        c = cross(a, b)
        if not c: 
            if cur: out.append(cur); cur = []
            continue
        p0, p1 = c
        if not cur: cur = [p0]
        elif math.hypot(cur[-1][0]-p0[0], cur[-1][1]-p0[1]) > 1e-6: out.append(cur); cur = [p0]
        cur.append(p1)
        if not inside(b) or p1 != b:
            out.append(cur); cur = []
    if cur: out.append(cur)
    return [c for c in out if len(c) >= 2]
def clip_poly(pts):
    def clip(poly, inside_f, inter):
        out = []
        for i in range(len(poly)):
            a, b = poly[i-1], poly[i]
            if inside_f(b):
                if not inside_f(a): out.append(inter(a, b))
                out.append(b)
            elif inside_f(a): out.append(inter(a, b))
        return out
    poly = pts
    for axis, val, keep_ge in ((0, 0, True), (0, W, False), (1, 0, True), (1, H, False)):
        if not poly: break
        f = (lambda p, axis=axis, val=val, g=keep_ge: p[axis] >= val if g else p[axis] <= val)
        def inter(a, b, axis=axis, val=val):
            t = (val - a[axis]) / ((b[axis] - a[axis]) or 1e-9); return (a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1]))
        poly = clip(poly, f, inter)
    return poly
def area(p): return abs(sum(p[i-1][0]*p[i][1]-p[i][0]*p[i-1][1] for i in range(len(p))))/2
def chain(wlist):
    segs = [w['nodes'][:] for w in wlist if len(w['nodes']) > 1]
    lines = []
    while segs:
        cur = segs.pop(0); changed = True
        while changed:
            changed = False
            for s in segs:
                if s[0] == cur[-1]: cur += s[1:]
                elif s[-1] == cur[-1]: cur += s[::-1][1:]
                elif s[-1] == cur[0]: cur = s[:-1] + cur
                elif s[0] == cur[0]: cur = s[::-1][:-1] + cur
                else: continue
                segs.remove(s); changed = True; break
        lines.append(cur)
    return lines
R = lambda v: round(v, 1)
fmt = lambda pts: [[R(x), R(y)] for x, y in pts]
out = {'w': W, 'h': H, 'kmPerUnit': CFG['km'], 'bbox': [CFG['lon0'], CFG['lat0'], CFG['lon1'], CFG['lat1']], 'roads': [], 'rivers': [], 'rail': [], 'forests': [], 'urban': [], 'water': [], 'defences': [], 'labels': []}
# ---- roads from route relations
def road_kind(ref):
    if re.match(r'^[НМРНHME]', ref): return 'highway'
    if ref.startswith('Т') or ref.startswith('T'): return 'road'
    if ref.startswith('О') or ref.startswith('O'): return 'road'
    return 'track'
lat_ref = {'Н':'N','М':'M','Р':'R','Т':'T','О':'O','С':'C','Е':'E'}
def latin(ref): return ''.join(lat_ref.get(c, c) for c in ref)
done_ways = set()
for fn, d in sorted(files.items()):
    if not (fn.startswith('route_') or fn.startswith('rail_')): continue
    for e in d['elements']:
        if e['type'] != 'relation': continue
        t = e.get('tags', {})
        if t.get('type') != 'route': continue
        ws = [ways[m['ref']] for m in e['members'] if m['type'] == 'way' and m['ref'] in ways and m.get('role', '') in ('', 'forward', 'backward', 'main')]
        if t.get('route') == 'road':
            ws = [w for w in ws if w.get('tags', {}).get('highway')]
            ref = t.get('ref', '')
            for line in chain(ws):
                pts = [P(nodes[i]['lat'], nodes[i]['lon']) for i in line if i in nodes]
                for c in clip_line(pts):
                    c = dp(c, 0.8)
                    if len(c) >= 2: out['roads'].append({'kind': road_kind(ref), 'ref': latin(ref), 'pts': fmt(c)})
        elif t.get('route') in ('railway', 'train'):
            for line in chain(ws):
                pts = [P(nodes[i]['lat'], nodes[i]['lon']) for i in line if i in nodes]
                for c in clip_line(pts):
                    c = dp(c, 0.8)
                    if len(c) >= 2: out['rail'].append({'name': t.get('name'), 'pts': fmt(c)})
    if fn.startswith('rail_') and not any(e['type'] == 'relation' for e in d['elements']):
        for line in chain([e for e in d['elements'] if e['type'] == 'way']):
            pts = [P(nodes[i]['lat'], nodes[i]['lon']) for i in line if i in nodes]
            for c in clip_line(pts):
                c = dp(c, 0.8)
                if len(c) >= 2: out['rail'].append({'name': fn[5:-5], 'pts': fmt(c)})
# ---- rivers: relations + named river/stream ways + water polygons
river_ways = {}
for fn, d in files.items():
    for e in d['elements']:
        if e['type'] == 'way' and e.get('tags', {}).get('waterway') in ('river', 'stream') and len(e['nodes']) > 1:
            river_ways[e['id']] = e
by_name = {}
for w in river_ways.values():
    by_name.setdefault((w['tags'].get('name') or '', w['tags']['waterway']), []).append(w)
for (name, kind), ws in by_name.items():
    for line in chain(ws):
        pts = [P(nodes[i]['lat'], nodes[i]['lon']) for i in line if i in nodes]
        L = sum(math.hypot(b[0]-a[0], b[1]-a[1]) for a, b in zip(pts, pts[1:]))
        if L < (6 if name else 10): continue
        for c in clip_line(pts):
            c = dp(c, 0.7)
            if len(c) >= 2: out['rivers'].append({'name': name or None, 'width': 3 if kind == 'river' else 1.4, 'pts': fmt(c)})
# ---- polygons
seen_poly = set()
def add_poly(key, ring, min_area, tol=0.6):
    pts = [P(nodes[i]['lat'], nodes[i]['lon']) for i in ring if i in nodes]
    if len(pts) < 3: return
    pts = clip_poly(pts)
    if len(pts) < 3 or area(pts) < min_area: return
    s = dp(pts + [pts[0]], tol)[:-1]
    if len(s) >= 3: out[key].append(fmt(s))
for w in ways.values():
    t = w.get('tags', {}); 
    if w['id'] in seen_poly or len(w['nodes']) < 4 or w['nodes'][0] != w['nodes'][-1]: continue
    seen_poly.add(w['id'])
    if t.get('natural') == 'wood' or t.get('landuse') == 'forest': add_poly('forests', w['nodes'], 1.5 if side=='UA' else 3)
    elif t.get('landuse') in ('residential', 'industrial', 'retail', 'commercial', 'brownfield') or t.get('place') in ('village','town'): add_poly('urban', w['nodes'], 4 if side=='UA' else 10, 1.0)
    elif t.get('natural') == 'water' or t.get('landuse') == 'reservoir' or t.get('water'): add_poly('water', w['nodes'], 2)
    elif t.get('landuse') == 'landfill' or t.get('man_made') == 'spoil_heap': add_poly('urban', w['nodes'], 2)
for r in rels.values():
    t = r.get('tags', {})
    if t.get('type') != 'multipolygon': continue
    outer = [ways[m['ref']] for m in r['members'] if m['type'] == 'way' and m.get('role') == 'outer' and m['ref'] in ways]
    for ring in chain(outer):
        if ring[0] != ring[-1]: continue
        if t.get('natural') == 'wood' or t.get('landuse') == 'forest': add_poly('forests', ring, 1.5 if side=='UA' else 3)
        elif t.get('natural') == 'water' or t.get('landuse') == 'reservoir': add_poly('water', ring, 2)
        elif t.get('landuse') in ('residential', 'industrial'): add_poly('urban', ring, 4 if side=='UA' else 10, 1.0)
# ---- defences (anti-tank ditches, trenches) — mapped in OSM as barrier=ditch / military=trench
for w in ways.values():
    t = w.get('tags', {})
    if t.get('barrier') == 'ditch' or t.get('military') in ('trench',):
        pts = wpts(w)
        for c in clip_line(pts):
            c = dp(c, 0.5)
            if len(c) >= 2 and sum(math.hypot(b[0]-a[0], b[1]-a[1]) for a, b in zip(c, c[1:])) > 1.0: out['defences'].append({'kind': t.get('military') or 'ditch', 'pts': fmt(c)})
    if t.get('military') == 'bunker':
        pts = wpts(w)
        if pts:
            x = sum(p[0] for p in pts)/len(pts); y = sum(p[1] for p in pts)/len(pts)
            if inside((x, y)): out['defences'].append({'kind': 'bunker', 'pts': [[R(x), R(y)]]})
for n in nodes.values():
    if n.get('tags', {}).get('military') == 'bunker':
        x, y = P(n['lat'], n['lon'])
        if inside((x, y)): out['defences'].append({'kind': 'bunker', 'pts': [[R(x), R(y)]]})
json.dump(out, open(outp, 'w'), ensure_ascii=False)
print(side, 'w', W, 'h', H, {k: len(v) for k, v in out.items() if isinstance(v, list)})
# ---- labels: road refs (longest piece), named rivers, extra place names (non-sector villages from Nominatim)
RIV = {'Кінська': 'Kinska r.', 'Токмак': 'Tokmak r.', 'Дурна': 'Durna balka', 'балка Дурна': 'Durna balka', 'Водяна': 'Vodiana', "Кам'янка": 'Kamianka', 'балка Тонка': 'Tonka balka', 'Каїнкулак': 'Kainkulak'}
best = {}
for r in out['roads']:
    L = sum(math.hypot(b[0]-a[0], b[1]-a[1]) for a, b in zip(r['pts'], r['pts'][1:]))
    if r['ref'] and (r['ref'] not in best or L > best[r['ref']][0]): best[r['ref']] = (L, r['pts'])
def midpt(pts):
    L = sum(math.hypot(b[0]-a[0], b[1]-a[1]) for a, b in zip(pts, pts[1:])); acc = 0
    for a, b in zip(pts, pts[1:]):
        s = math.hypot(b[0]-a[0], b[1]-a[1])
        if acc + s >= L / 2: t = (L/2 - acc) / (s or 1); return a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])
        acc += s
    return pts[0]
for ref, (L, pts) in best.items():
    if L < 25: continue
    x, y = midpt(pts); out['labels'].append({'x': R(x + 3), 'y': R(y - 3), 'text': ref, 'size': 9})
rb = {}
for r in out['rivers']:
    n = RIV.get(r['name'] or '')
    if not n: continue
    L = sum(math.hypot(b[0]-a[0], b[1]-a[1]) for a, b in zip(r['pts'], r['pts'][1:]))
    if n not in rb or L > rb[n][0]: rb[n] = (L, r['pts'])
for n, (L, pts) in rb.items():
    x, y = midpt(pts); out['labels'].append({'x': R(x + 3), 'y': R(y + 9), 'text': n, 'size': 9})
json.dump(out, open(outp, 'w'), ensure_ascii=False)
print('labels', len(out['labels']))
