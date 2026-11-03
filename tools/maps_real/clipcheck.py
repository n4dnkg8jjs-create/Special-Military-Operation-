# Clipping audit, step 2: intersections between everything the world generator placed (dump of clipcheck.html).
#   node tools/preview.mjs "page:/tools/maps_real/clipcheck.html?map=avdiivka" /tmp/x.png > dump.out
#   python3 tools/maps_real/clipcheck.py dump.out report.json [report.png]
# Categories (counted as pairs / items with an intersection area above a small tolerance):
#   bld_bld        building footprint vs building footprint (kit blocks, halls / garage rows, house templates, sheds,
#                  kiosks, pavilions, garage units) -- walls through walls
#   bld_road       building vs carriageway (centre line +- w/2)            bld_pave   building vs pavement ribbon (minor)
#   bld_rail       building vs track bed (2.1 m either side of the rail)
#   prop_bld       tree trunk / pole / fence / car / bench / playground / bus stop / wreck ... inside a building
#   prop_road      tree trunk / pole / fence / shed on a carriageway
#   prop_prop      solid props through each other (trunks vs cars / sheds / fences, fences vs fences crossing)
# Map data (c) OpenStreetMap contributors, ODbL.
import sys, json, math
from collections import Counter, defaultdict
from shapely.geometry import Polygon, LineString, Point, box
from shapely.strtree import STRtree

src, out = sys.argv[1], sys.argv[2]; png = sys.argv[3] if len(sys.argv) > 3 else None
d = json.loads([l for l in open(src).read().strip().split('\n') if l.startswith('{')][-1])
SW = 3.2
def rect(x, z, L, D, rot):
    c, s = math.cos(rot), math.sin(rot)
    return Polygon([(x + lx * c + lz * s, z - lx * s + lz * c) for lx, lz in ((-L / 2, -D / 2), (L / 2, -D / 2), (L / 2, D / 2), (-L / 2, D / 2))])

BLD_T = ('house_', 'garage_unit', 'shed_wood', 'outhouse', 'kiosk', 'pavilion', 'church', 'water_tower', 'grain_silo', 'well_village', 'greenhouse')
TREE_T = ('tree_', 'leafy_')
SKIP_T = ('Mesh', 'Scene', 'Group', 'bush', 'debris', 'rubble', 'crater', 'litter', 'rv_', 'floor_', 'tyre', 'branch', 'net_cover', 'tarp', 'sandbag', 'mg_nest', 'dugout', 'heap', 'grass', 'woodpile')
blds = []   # (poly, kind, label)
for x, z, L, D, rot, kind, fl, nm in d['kit']: blds.append((rect(x, z, L, D, rot), 'kit', f'{kind}{fl} {nm}'.strip()))
for h in d['hall']:
    x, z, L, D, rot = h[:5]; tag = h[5] if len(h) > 5 else 'hall'
    blds.append((rect(x, z, L, D, rot), 'gar' if tag == 'garages' else 'hall', 'garage-row' if tag == 'garages' else 'hall'))
props = []
for name, x, z, cs, h in d['inst']:
    if name.startswith(SKIP_T): continue
    if name.startswith(BLD_T):
        p = Polygon(cs).buffer(-0.15)          # template boxes include eaves / porch steps: 15 cm tolerance
        blds.append((p, 'tpl', name)); continue
    if name.startswith(TREE_T): props.append((Point(x, z).buffer(0.3, 8), 'tree', name)); continue
    if h < 0.25: continue
    props.append((Polygon(cs).buffer(-0.05), 'prop', name))
for name, x, z, cs in d['crush']: props.append((Polygon(cs).buffer(-0.05), 'fence', name))

roads, paves = [], []
for pts, w, typ, sw in d.get('roads', []):
    if len(pts) < 2: continue
    ln = LineString(pts)
    roads.append((ln.buffer(w / 2 if typ in ('paved', 'street', 'drive') else w / 2 + 0.6, cap_style=2, join_style=2), typ))
    if typ in ('paved', 'street', 'drive'):
        s = sw if sw is not None else (SW if typ != 'drive' else 1.1)
        if s > 0: paves.append((ln.buffer(w / 2 + s, cap_style=2, join_style=2), typ))
rails = [LineString(p).buffer(2.1, cap_style=2) for p in d.get('rails', []) if len(p) > 1]
cuts = [Polygon(c).buffer(0) for c in d.get('cuts', []) if len(c) > 2]
half = d['size'] / 2; inner = box(-half, -half, half, half)

res = defaultdict(list)
TOL = 0.5
before_mode = not any(len(h) > 5 and h[5] == 'garages' for h in d['hall'])   # old generator: garage rows not tagged -> skip row-vs-unit pairs
bt = STRtree([b[0] for b in blds])
for i, (p, k, n) in enumerate(blds):
    if not inner.intersects(p): continue
    for j in bt.query(p):
        if j <= i: continue
        q = blds[j]
        if {k, q[1]} == {'gar', 'tpl'} and 'garage_unit' in (n + q[2]): continue
        if before_mode and {k, q[1]} == {'hall', 'tpl'} and 'garage_unit' in (n + q[2]): continue   # (conservative for the old dump)
        a = p.intersection(q[0]).area
        if a > TOL: res['bld_bld'].append(dict(a=round(a, 1), at=[round(p.centroid.x), round(p.centroid.y)], what=f'{n} x {q[2]}'))
def against(items, polys, cat, tol, kinds=None, lab=lambda x: ''):
    t = STRtree([q[0] if isinstance(q, tuple) else q for q in polys])
    for p, k, n in items:
        if kinds and k not in kinds: continue
        if not inner.intersects(p): continue
        for j in t.query(p):
            q = polys[j]; g = q[0] if isinstance(q, tuple) else q
            a = p.intersection(g).area
            if a > tol:
                res[cat].append(dict(a=round(a, 2), at=[round(p.centroid.x), round(p.centroid.y)], what=n + ' ' + lab(q))); break
against(blds, roads, 'bld_road', 0.5, lab=lambda q: q[1])
against(blds, paves, 'bld_pave', 2.0, lab=lambda q: q[1])
against(blds, rails, 'bld_rail', 0.5)
if cuts: against([b for b in blds if b[1] != 'gar'], [(c, 'trench') for c in cuts], 'bld_trench', 0.3, lab=lambda q: q[1])
against(props, [(b[0], b[2]) for b in blds if b[1] != 'gar'], 'prop_bld', 0.05, lab=lambda q: 'in ' + q[1])
# (burnt cars at the kerb and hedgehog road blocks stand on the carriageway on purpose)
against([p for p in props if not p[2].startswith(('car_', 'hedgehog', 'bus_'))], roads, 'prop_road', 0.05, kinds=('tree', 'prop'), lab=lambda q: q[1])
# props through props: trunks / poles / cars / benches vs each other and vs fences (fence vs fence only when crossing)
pt = STRtree([p[0] for p in props])
for i, (p, k, n) in enumerate(props):
    if not inner.intersects(p): continue
    for j in pt.query(p):
        if j <= i: continue
        q = props[j]
        if k == 'fence' and q[1] == 'fence':
            if p.intersection(q[0]).area > 0.15: res['prop_prop'].append(dict(a=0, at=[round(p.centroid.x), round(p.centroid.y)], what=n + ' x ' + q[2]))
            continue
        if n.split('_')[0] == q[2].split('_')[0] and ('_hull' in n + q[2]) and ('_turret' in n + q[2]): continue   # one wreck
        a = p.intersection(q[0]).area
        if a > 0.05: res['prop_prop'].append(dict(a=round(a, 2), at=[round(p.centroid.x), round(p.centroid.y)], what=n + ' x ' + q[2]))

summary = {k: len(v) for k, v in sorted(res.items())}
for cat in ('bld_bld', 'bld_road', 'bld_pave', 'bld_rail', 'bld_trench', 'prop_bld', 'prop_road', 'prop_prop'): summary.setdefault(cat, 0)
summary['total_major'] = sum(summary[k] for k in ('bld_bld', 'bld_road', 'bld_rail', 'bld_trench', 'prop_bld', 'prop_road', 'prop_prop'))
kinds = {cat: Counter(r['what'].split(' ')[0] for r in v).most_common(12) for cat, v in res.items()}
json.dump(dict(summary=summary, kinds=kinds, items={k: v[:400] for k, v in res.items()}, counts=dict(buildings=len(blds), props=len(props), roads=len(roads))), open(out, 'w'), indent=1)
print(json.dumps(summary)); print(json.dumps(kinds)[:1500])
if png:
    import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    from matplotlib.patches import Polygon as MP
    fig, ax = plt.subplots(figsize=(14, 14))
    for g, t in paves:
        for gg in getattr(g, 'geoms', [g]): ax.add_patch(MP(list(gg.exterior.coords), fc='#ddd', ec='none'))
    for g, t in roads:
        for gg in getattr(g, 'geoms', [g]): ax.add_patch(MP(list(gg.exterior.coords), fc='#999', ec='none'))
    for g in rails: ax.add_patch(MP(list(g.exterior.coords), fc='#a88', ec='none'))
    for p, k, n in blds:
        if p.is_empty or not hasattr(p, 'exterior'): continue
        ax.add_patch(MP(list(p.exterior.coords), fc={'kit': '#c96', 'hall': '#996', 'gar': '#aa9', 'tpl': '#bba'}[k], ec='k', lw=0.2))
    col = dict(bld_trench='brown', bld_bld='red', bld_road='magenta', bld_rail='purple', prop_bld='orange', prop_road='blue', prop_prop='cyan', bld_pave='#9a9')
    for cat, v in res.items():
        if not v: continue
        xs = [r['at'][0] for r in v]; zs = [r['at'][1] for r in v]
        ax.scatter(xs, zs, s=14 if cat != 'bld_pave' else 5, c=col.get(cat, 'k'), label=f'{cat} ({len(v)})', zorder=5)
    ax.set_xlim(-half, half); ax.set_ylim(half, -half); ax.set_aspect('equal'); ax.legend(loc='upper right')
    ax.set_title(f"clipping audit: {summary['total_major']} major intersections ({src.split('/')[-1]})")
    plt.savefig(png, dpi=80, bbox_inches='tight'); print('wrote', png)
