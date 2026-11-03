# Layout refinement for the v2 real-place maps (called by osm2map.py after the raw conversion):
#   1. footprint conflicts: OSM outlines that overlap (duplicates, a shed drawn inside a house) and the oriented
#      rectangles the game builds from them (a min-area rectangle is larger than an irregular outline): the smaller
#      building is trimmed back to clear the other one, or dropped when it would lose too much
#   2. buildings off the carriageways / track bed: OSM street centre lines are ~1-3 m off the imagery; a building whose
#      rectangle reaches into the carriageway (w/2) or the ballast (2.1 m from the rail) is moved out (<= 3.5 m), else
#      the street is narrowed to clear it
#   3. pavement width per street (r.sw): full 3.2 m where the blocks stand back, narrower where they come close, a
#      0.8 m verge in the private sector (the lanes there have no pavements)
#   4. war damage from imagery (optional, view-only tiles that are NOT redistributed: env IMAGERY=<dir> holding
#      mosaic.jpg + meta.txt from the tile mosaic): per footprint, the roof texture roughness (collapsed sections, rubble,
#      burnt-out roofs read as high-contrast clutter, intact roofs as an even grey) ranked within each class -> b.dmg 0..1
# Map data (c) OpenStreetMap contributors, ODbL.
import math, os
from shapely.geometry import Polygon, LineString, Point
from shapely.strtree import STRtree

def rect(x, z, L, D, rot):
    c, s = math.cos(rot), math.sin(rot)
    return Polygon([(x + lx * c + lz * s, z - lx * s + lz * c) for lx, lz in ((-L / 2, -D / 2), (L / 2, -D / 2), (L / 2, D / 2), (-L / 2, D / 2))])

def rects_of(b):
    if b.get('parts'): return [rect(px, pz, pl, pd, b['rot']) for px, pz, pl, pd in b['parts']]
    return [rect(b['x'], b['z'], b['L'], b['D'], b['rot'])]

def shape_of(b):
    rs = rects_of(b); g = rs[0]
    for r in rs[1:]: g = g.union(r)
    return g

def refine(out, o, C):
    B, roads = out['buildings'], out['roads']
    stats = dict(dropped=0, trimmed=0, moved=0, narrowed=0)
    KIT = ('block', 'school', 'civic')
    prio = lambda b: (b['cls'] in KIT, b['cls'] in ('hall', 'garages'), not b.get('syn'), b['L'] * b['D'])
    # ---------------------------------------------------------------- 1. footprint conflicts
    drop = set()
    for it in range(3):
        shapes = [shape_of(b) for b in B]; tree = STRtree(shapes); changed = False
        for i, b in enumerate(B):
            if i in drop: continue
            for j in tree.query(shapes[i]):
                if j == i or j in drop: continue
                a = shapes[i].intersection(shapes[j]).area
                if a < 0.3: continue
                big, small = (i, j) if prio(B[i]) >= prio(B[j]) else (j, i)
                s = B[small]
                if s.get('parts'):   # a multi-part block against another: drop the smaller only if mostly inside
                    if a > 0.5 * shapes[small].area: drop.add(small); stats['dropped'] += 1; changed = True
                    continue
                # trim the small rectangle along its own axes: the cheaper of the four sides that clears the other shape
                c, sn = math.cos(s['rot']), math.sin(s['rot']); other = shapes[big]
                best = None
                for ax in (0, 1):
                    for sd in (-1, 1):
                        L, D = s['L'], s['D']
                        for cut in [k * 0.25 for k in range(1, 81)]:
                            nL, nD = (L - cut, D) if ax == 0 else (L, D - cut)
                            if nL < 0.55 * L or nD < 0.55 * D or nL < 2.2 or nD < 2.2: break
                            lx, lz = (sd * cut / 2, 0) if ax == 0 else (0, sd * cut / 2)
                            x, z = s['x'] + lx * c + lz * sn, s['z'] - lx * sn + lz * c
                            if rect(x, z, nL, nD, s['rot']).intersection(other).area < 0.05:
                                if not best or cut < best[0]: best = (cut, x, z, nL, nD)
                                break
                if best:
                    _, s['x'], s['z'], s['L'], s['D'] = best; s['x'] = round(s['x'], 2); s['z'] = round(s['z'], 2); s['L'] = round(s['L'], 2); s['D'] = round(s['D'], 2)
                    stats['trimmed'] += 1
                else: drop.add(small); stats['dropped'] += 1
                changed = True; shapes[small] = shape_of(s)
        if not changed: break
    # ---------------------------------------------------------------- 2. off the carriageways / track bed
    def carriage(r): return LineString(r['pts']).buffer(r['w'] / 2 + (0.6 if r['type'] in ('track', 'gravel') else 0), cap_style=2, join_style=2)
    cg = [carriage(r) if len(r['pts']) > 1 else Polygon() for r in roads]
    rails = [LineString(l['pts']).buffer(2.3, cap_style=2) for l in out['lines'] if l['t'] in ('rail', 'rail_old', 'rail_siding') and len(l['pts']) > 1]
    obst = cg + rails; otree = STRtree(obst)
    def hits(g): return [k for k in otree.query(g) if obst[k].intersection(g).area > 0.05]
    others = lambda i: [shape_of(B[k]) for k in range(len(B)) if k != i and k not in drop]
    btree_shapes = [shape_of(b) for b in B]; btree = STRtree(btree_shapes)
    for i, b in enumerate(B):
        if i in drop: continue
        g = shape_of(b); H = hits(g)
        if not H: continue
        # push away from the nearest centre line of what it hits
        k = H[0]; ln = LineString(roads[k]['pts']) if k < len(roads) else None
        if ln is None:
            ln = [LineString(l['pts']) for l in out['lines'] if l['t'] in ('rail', 'rail_old', 'rail_siding') and len(l['pts']) > 1][k - len(roads)]
        p = ln.interpolate(ln.project(Point(b['x'], b['z']))); dx, dz = b['x'] - p.x, b['z'] - p.y; dl = math.hypot(dx, dz) or 1; dx /= dl; dz /= dl
        ok = None
        for step in [q * 0.25 for q in range(1, 15)]:
            gg = shape_of(dict(b, x=b['x'] + dx * step, z=b['z'] + dz * step, parts=[[px + dx * step, pz + dz * step, pl, pd] for px, pz, pl, pd in b.get('parts', [])] or None))
            if hits(gg): continue
            if any(btree_shapes[j].intersection(gg).area > 0.05 for j in btree.query(gg) if j != i and j not in drop): continue
            ok = step; break
        if ok:
            b['x'] = round(b['x'] + dx * ok, 2); b['z'] = round(b['z'] + dz * ok, 2)
            if b.get('parts'): b['parts'] = [[round(px + dx * ok, 2), round(pz + dz * ok, 2), pl, pd] for px, pz, pl, pd in b['parts']]
            btree_shapes[i] = shape_of(b); stats['moved'] += 1
        else:
            for k in H:
                if k >= len(roads): continue
                r = roads[k]; d = LineString(r['pts']).distance(g)
                nw = max(3.0, 2 * d - 0.3)
                if nw < r['w']: r['w'] = round(nw, 1); stats['narrowed'] += 1
    # rebuild the list without the dropped buildings (plots refer to building indices)
    if drop:
        remap, nb = {}, []
        for i, b in enumerate(B):
            if i in drop: continue
            remap[i] = len(nb); nb.append(b)
        out['buildings'] = B = nb
        out['plots'] = [dict(p, h=remap[p['h']]) for p in out.get('plots', []) if p.get('h') in remap]
    # ---------------------------------------------------------------- 3. pavements
    shapes = [shape_of(b) for b in B]; tree = STRtree(shapes)
    for r in roads:
        if r['type'] not in ('paved', 'street', 'drive') or len(r['pts']) < 2: continue
        ln = LineString(r['pts']); near = [j for j in tree.query(ln.buffer(r['w'] / 2 + 12))]
        houses = sum(1 for j in near if B[j]['cls'] in ('house', 'shed') and ln.distance(shapes[j]) < r['w'] / 2 + 10)
        dmin = min([ln.distance(shapes[j]) for j in near if B[j]['cls'] not in ('house', 'shed')] or [99])
        if r['type'] == 'drive': sw = 1.1
        elif houses >= 3 and houses * 40 > ln.length * 0.5: sw = 0.8
        else: sw = 3.2
        sw = max(0.0, min(sw, dmin - r['w'] / 2 - 0.3))
        r['sw'] = round(sw, 1)
    # ---------------------------------------------------------------- 4. damage from imagery (optional)
    img = os.environ.get('IMAGERY')
    if img and os.path.exists(os.path.join(img, 'mosaic.jpg')):
        from PIL import Image, ImageFilter
        import numpy as np
        z, x0, y0, x1, y1 = open(os.path.join(img, 'meta.txt')).read().split(); z = int(z); x0, y0, x1, y1 = map(float, (x0, y0, x1, y1))
        im = Image.open(os.path.join(img, 'mosaic.jpg')).convert('L'); W, H = im.size
        a = np.asarray(im, dtype=np.float32); gx = np.abs(np.diff(a, axis=1, prepend=a[:, :1])); gy = np.abs(np.diff(a, axis=0, prepend=a[:1, :])); grad = gx + gy
        n = 2 ** z
        def px(x, zz):
            lat, lon = o.inv(x, zz)
            tx = (lon + 180) / 360 * n; ty = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
            return (tx - x0) * 256, (ty - y0) * 256
        groups = {}
        for b in B:
            if b.get('syn'): continue
            g = shape_of(b).buffer(-1.0)
            if g.is_empty or g.area < 6: continue
            vals = []
            minx, minz, maxx, maxz = g.bounds
            st = 0.8
            xx = minx
            while xx <= maxx:
                zz = minz
                while zz <= maxz:
                    if g.contains(Point(xx, zz)):
                        u, v = px(xx, zz); iu, iv = int(u), int(v)
                        if 0 <= iu < W and 0 <= iv < H: vals.append((grad[iv, iu], a[iv, iu]))
                    zz += st
                xx += st
            if len(vals) < 6: continue
            g_ = np.array(vals); score = float(np.median(g_[:, 0]) + 0.35 * np.std(g_[:, 1]))
            key = 'kit' if b['cls'] in KIT else 'house' if b['cls'] in ('house',) else 'other'
            groups.setdefault(key, []).append((score, b))
        for key, L in groups.items():
            L.sort(key=lambda t: t[0])
            for rank, (sc, b) in enumerate(L): b['dmg'] = round(rank / max(1, len(L) - 1), 2)
        stats['imagery'] = {k: len(v) for k, v in groups.items()}
    out['refine'] = stats
    print('refine', stats)
