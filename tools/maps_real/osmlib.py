# OSM JSON (API v0.6 map.json) loader + local metric projection shared by the real-map tools.
# Map data (c) OpenStreetMap contributors, ODbL 1.0.
import json, glob, math, os
class OSM:
    def __init__(self, files):
        self.nodes, self.ways, self.rels = {}, {}, {}
        for f in files:
            try: d = json.load(open(f))
            except Exception: continue
            if not isinstance(d, dict) or 'elements' not in d: continue
            for e in d['elements']:
                if e['type'] == 'node': self.nodes[e['id']] = e
                elif e['type'] == 'way': self.ways[e['id']] = e
                elif e['type'] == 'relation': self.rels[e['id']] = e
    def proj(self, lat0, lon0):
        kx = 111320.0 * math.cos(math.radians(lat0)); ky = 111132.0
        self.P = lambda lat, lon: ((lon - lon0) * kx, (lat0 - lat) * ky)   # x east, z south (north = -Z)
        self.inv = lambda x, z: (lat0 - z / ky, lon0 + x / kx)
        return self
    def pts(self, w):
        return [self.P(self.nodes[i]['lat'], self.nodes[i]['lon']) for i in w['nodes'] if i in self.nodes]
    def closed(self, w): return len(w['nodes']) > 3 and w['nodes'][0] == w['nodes'][-1]
    def multipolygons(self):
        # outer rings of multipolygon relations (joined), with the relation tags
        out = []
        for r in self.rels.values():
            t = r.get('tags', {})
            if t.get('type') != 'multipolygon': continue
            segs = [self.ways[m['ref']]['nodes'] for m in r['members'] if m['type'] == 'way' and m.get('role', 'outer') in ('outer', '') and m['ref'] in self.ways]
            rings = []
            while segs:
                ring = list(segs.pop(0))
                changed = True
                while ring[0] != ring[-1] and changed:
                    changed = False
                    for i, s in enumerate(segs):
                        if s[0] == ring[-1]: ring += s[1:]
                        elif s[-1] == ring[-1]: ring += s[::-1][1:]
                        elif s[-1] == ring[0]: ring = s[:-1] + ring
                        elif s[0] == ring[0]: ring = s[::-1][:-1] + ring
                        else: continue
                        segs.pop(i); changed = True; break
                rings.append(ring)
            for ring in rings:
                p = [self.P(self.nodes[i]['lat'], self.nodes[i]['lon']) for i in ring if i in self.nodes]
                if len(p) > 3: out.append((t, p, r['id']))
        return out
def files_for(side, extra=()):
    base = '/home/claude/special-military-operation-/assets/campaign/osm/' + side
    return sorted(glob.glob(base + '/*.json')) + list(extra)
