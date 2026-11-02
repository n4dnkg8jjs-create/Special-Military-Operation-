# Render the converted OSM layout (src/world/real/<name>_osm.js) in the game frame (x right, z down = game +Z),
# optionally with the map's gameplay overlay (objectives / deploy zones / fortifications from a JSON dump).
#   python3 tools/maps_real/render_osm.py robotyne out.png [overlay.json] [px]
# Map data (c) OpenStreetMap contributors, ODbL 1.0.
import sys, os, json, math
from PIL import Image, ImageDraw, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
name, outp = sys.argv[1], sys.argv[2]
ov = json.load(open(sys.argv[3])) if len(sys.argv) > 3 and sys.argv[3] != '-' else None
S = int(sys.argv[4]) if len(sys.argv) > 4 else 1400
src = open(os.path.join(REPO, 'src', 'world', 'real', f'{name}_osm.js')).read()
D = json.loads(src[src.index('{'):src.rindex('}') + 1])
half = D['size'] / 2; k = S / D['size']
im = Image.new('RGB', (S, S), (214, 208, 190)); d = ImageDraw.Draw(im, 'RGBA')
Q = lambda p: ((p[0] + half) * k, (p[1] + half) * k)
LU = {'farmland': (232, 222, 170), 'meadow': (205, 225, 160), 'grass': (195, 222, 160), 'grassland': (200, 220, 165), 'residential': (222, 216, 210), 'industrial': (225, 205, 220),
      'garages': (215, 210, 200), 'allotments': (200, 220, 170), 'orchard': (180, 215, 150), 'brownfield': (218, 212, 196), 'construction': (205, 200, 180), 'railway': (215, 205, 215),
      'cemetery': (175, 205, 175), 'forest': (150, 195, 135), 'wood': (150, 195, 135), 'scrub': (180, 210, 160), 'heath': (205, 215, 170), 'water': (160, 190, 230), 'pitch': (170, 220, 180),
      'park': (190, 230, 180), 'playground': (210, 235, 210), 'stadium': (190, 225, 190), 'school': (240, 235, 200), 'kindergarten': (240, 235, 200), 'parking': (235, 235, 235), 'sand': (240, 230, 190),
      'landfill': (200, 190, 160), 'hospital': (240, 225, 225), 'platform': (190, 190, 190), 'village': (225, 215, 200), 'field': (232, 222, 170)}
order = ['brownfield', 'residential', 'village', 'farmland', 'field', 'meadow', 'grassland', 'industrial', 'garages', 'allotments', 'orchard', 'construction', 'railway', 'school', 'kindergarten', 'hospital',
         'park', 'grass', 'heath', 'scrub', 'wood', 'forest', 'stadium', 'pitch', 'playground', 'parking', 'sand', 'landfill', 'water', 'platform', 'cemetery']
areas = sorted(D['areas'], key=lambda a: order.index(a['t']) if a['t'] in order else 99)
for a in areas:
    c = LU.get(a['t'], (210, 210, 210))
    if len(a['pts']) > 2: d.polygon([Q(p) for p in a['pts']], fill=c, outline=tuple(int(v * 0.85) for v in c))
def line(pts, col, w):
    if len(pts) > 1: d.line([Q(p) for p in pts], fill=col, width=max(1, round(w * k)), joint='curve')
for l in D['lines']:
    if l['t'] in ('tree_row', 'hedge'): line(l['pts'], (110, 165, 90), 7)
for l in D['lines']:
    if l['t'] == 'stream': line(l['pts'], (120, 160, 225), 2.5)
for p in D['paths']: line(p, (190, 140, 120), 1.2)
RC = {'paved': (250, 220, 160), 'street': (255, 255, 255), 'gravel': (240, 235, 225), 'drive': (255, 255, 255), 'track': (190, 160, 110)}
for r in D['roads']: line(r['pts'], (150, 145, 140), r['w'] + 1.5)
for r in D['roads']: line(r['pts'], RC.get(r['type'], (255, 255, 255)), r['w'])
for l in D['lines']:
    if l['t'] in ('rail', 'rail_siding'): line(l['pts'], (90, 90, 90), 3); line(l['pts'], (240, 240, 240), 1)
    elif l['t'] == 'rail_old': line(l['pts'], (140, 140, 140), 1.5)
    elif l['t'] in ('wall',): line(l['pts'], (120, 110, 100), 0.8)
    elif l['t'] in ('fence',): line(l['pts'], (160, 150, 140), 0.5)
    elif l['t'] == 'trench': line(l['pts'], (200, 40, 30), 2)
    elif l['t'] == 'at_ditch': line(l['pts'], (230, 120, 20), 4)
    elif l['t'] == 'power': line(l['pts'], (120, 120, 160), 0.6)
BC = {'block': (215, 160, 140), 'school': (230, 170, 120), 'civic': (220, 165, 150), 'house': (200, 185, 170), 'hall': (180, 170, 190), 'garages': (175, 170, 165),
      'shed': (190, 180, 165), 'shop': (215, 175, 160), 'kiosk': (215, 175, 160), 'silo': (170, 170, 170), 'church': (240, 200, 120), 'ruin': (150, 130, 120)}
for b in D['buildings']:
    parts = b.get('parts') or [[b['x'], b['z'], b['L'], b['D']]]
    for (x, z, L, Dd) in parts:
        c, s = math.cos(b['rot']), math.sin(b['rot'])
        # Building.toWorld: (lx, lz) -> (x + lx c + lz s, z - lx s + lz c)
        pts = [(x + lx * c + lz * s, z - lx * s + lz * c) for lx, lz in ((-L / 2, -Dd / 2), (L / 2, -Dd / 2), (L / 2, Dd / 2), (-L / 2, Dd / 2))]
        if b.get('syn'): d.polygon([Q(p) for p in pts], fill=(225, 215, 200), outline=(150, 135, 120))   # inferred (not an OSM outline)
        else: d.polygon([Q(p) for p in pts], fill=BC.get(b['cls'], (200, 200, 200)), outline=(90, 80, 70))
try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', max(10, S // 110)); fb = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', max(12, S // 70))
except Exception: font = fb = ImageFont.load_default()
grid = ov is not None and ov.get('grid')
if grid:
    for g in range(-int(half) // 100 * 100, int(half) + 1, 100):
        d.line([Q((g, -half)), Q((g, half))], fill=(0, 0, 0, 50 if g % 500 else 110), width=1); d.line([Q((-half, g)), Q((half, g))], fill=(0, 0, 0, 50 if g % 500 else 110), width=1)
        d.text(Q((g + 2, -half + 2)), str(g), fill=(0, 0, 0), font=font); d.text(Q((-half + 2, g + 2)), str(g), fill=(0, 0, 0), font=font)
if ov:
    for kz, col in (('player', (60, 160, 60, 60)), ('enemy', (200, 60, 50, 60))):
        z = ov['deployZones'][kz]; d.rectangle([Q((z['x0'], z['z0'])), Q((z['x1'], z['z1']))], fill=col, outline=col[:3])
    for f in ov.get('fortifications', []):
        if f['type'] == 'fire': line(f['base'], (170, 30, 20), 2.2)
        elif f['type'] == 'comm': line(f['pts'], (170, 60, 40), 1.4)
        elif f['type'] == 'ditch': line(f['pts'], (120, 70, 30), 5)
        elif f['type'] == 'teeth': line(f['pts'], (90, 90, 90), 3)
        elif f['type'] == 'mg': x, z = Q(f['at']); d.ellipse([x - 4, z - 4, x + 4, z + 4], fill=(170, 30, 20))
        elif f['type'] == 'fox':
            for p in f['pts']: x, z = Q(p); d.ellipse([x - 2, z - 2, x + 2, z + 2], fill=(170, 30, 20))
    for tl in ov.get('treelines', []): line([tl[:2], tl[2:]], (60, 120, 50, 160), 5)
    for l in ov.get('lineup', []): x, z = Q(l); d.rectangle([x - 3, z - 5, x + 3, z + 5], fill=(40, 90, 200))
    for a in ov.get('army', []): x, z = Q(a); d.rectangle([x - 3, z - 5, x + 3, z + 5], fill=(200, 40, 40))
    for o in ov['objectives']:
        x, z = Q((o['x'], o['z'])); r = (o.get('r') or 24) * k
        d.ellipse([x - r, z - r, x + r, z + r], outline=(20, 20, 20), width=3)
        d.text((x + r + 3, z - 8), f"{o['id']}: {o['name']}", fill=(10, 10, 10), font=fb)
    if ov.get('north'):
        nx, nz = ov['north']; cx, cy = S - 60, 60
        d.line([(cx, cy), (cx + nx * 40, cy + nz * 40)], fill=(0, 0, 0), width=4); d.text((cx + nx * 52 - 6, cy + nz * 52 - 8), 'N', fill=(0, 0, 0), font=fb)
for p in D.get('plots', []): d.polygon([Q(q) for q in p['pts']], outline=(170, 160, 140))
d.text((8, S - 40), 'light houses / thin outlines: plots inferred along the mapped streets (OSM has no outlines there)', fill=(60, 50, 40), font=font)
d.text((8, S - 22), f"{name}: OpenStreetMap layout in the game frame ({D['size']} m, rotated {D['rot']} deg). Map data (c) OpenStreetMap contributors, ODbL", fill=(20, 20, 20), font=font)
im.save(outp)
print('wrote', outp)
