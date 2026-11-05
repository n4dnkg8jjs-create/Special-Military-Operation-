# Campaign v6: OpenStreetMap (standard tiles) next to the strategic map's top-down close-up of the same ground.
# usage: python3 -I src/campaign/v2/tools/v6_sbs.py UA|RU [tag]   (after v6_shots.mjs: cells_<side>.json + <tag>_<side>_<slug>_top.png)
#   -> previews/campaign_v6/sbs_<side>_<slug>.png (OSM | map, the 2 km grid square outlined on both) + sbs_<side>.png
# Tiles: tile.openstreetmap.org z15, cached in /tmp/osmtiles (a few dozen per side). Map data (c) OpenStreetMap contributors.
import json, math, os, sys, time, urllib.request
from PIL import Image, ImageDraw, ImageFont
side = sys.argv[1]; tag = sys.argv[2] if len(sys.argv) > 2 else 'after'
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.abspath(os.path.join(here, '..', '..', '..', '..'))
out = os.path.join(root, 'previews/campaign_v6'); cache = '/tmp/osmtiles'; os.makedirs(cache, exist_ok=True)
cells = json.load(open(os.path.join(out, f'cells_{side}.json')))
Z = 15; N = 2 ** Z
tx = lambda lo: (lo + 180) / 360 * N
ty = lambda la: (1 - math.log(math.tan(math.radians(la)) + 1 / math.cos(math.radians(la))) / math.pi) / 2 * N
def tile(x, y):
    p = f'{cache}/{Z}_{x}_{y}.png'
    if not os.path.exists(p):
        d = urllib.request.urlopen(urllib.request.Request(f'https://tile.openstreetmap.org/{Z}/{x}/{y}.png', headers={'User-Agent': 'smo-map-preview/1.0'}), timeout=60).read()
        open(p, 'wb').write(d); time.sleep(0.4)
    return Image.open(p).convert('RGB')
def osm_box(s, w, n, e, size):
    X0, X1, Y0, Y1 = tx(w), tx(e), ty(n), ty(s)
    im = Image.new('RGB', ((int(X1) - int(X0) + 1) * 256, (int(Y1) - int(Y0) + 1) * 256))
    for x in range(int(X0), int(X1) + 1):
        for y in range(int(Y0), int(Y1) + 1): im.paste(tile(x, y), ((x - int(X0)) * 256, (y - int(Y0)) * 256))
    c = im.crop((round((X0 - int(X0)) * 256), round((Y0 - int(Y0)) * 256), round((X1 - int(X0)) * 256), round((Y1 - int(Y0)) * 256)))
    return c.resize((size, size), Image.LANCZOS)
try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 20)
except Exception: font = ImageFont.load_default()
panels = []
for slug, c in cells.items():
    shot = os.path.join(out, f'{tag}_{side}_{slug}_top.png')
    if not os.path.exists(shot): continue
    m = Image.open(shot).convert('RGB'); S = m.size[1]; m = m.crop(((m.size[0] - S) // 2, 0, (m.size[0] - S) // 2 + S, S)).resize((900, 900))
    s, w, n, e = c['box']; o = osm_box(s, w, n, e, 900)
    # the grid square: the box is the square +-0.2 km (2.4 km across) -> square = 1/12 .. 11/12
    for im in (o, m):
        d = ImageDraw.Draw(im); a, b = 900 / 12, 900 * 11 / 12
        d.rectangle([a, a, b, b], outline=(255, 210, 60), width=3)
        d.line([b - 900 / 2.4, b + 22, b, b + 22], fill=(255, 255, 255), width=4); d.text((b - 900 / 2.4, b + 26), '1 km', fill=(255, 255, 255), font=font)
    sbs = Image.new('RGB', (1820, 960), (20, 20, 18)); sbs.paste(o, (0, 60)); sbs.paste(m, (920, 60))
    d = ImageDraw.Draw(sbs)
    d.text((10, 16), f"{c['name']} ({c['id']}) - OpenStreetMap  (c) OpenStreetMap contributors", fill=(235, 230, 215), font=font)
    d.text((930, 16), f"Campaign map v6, top-down, same 2.4 km box (yellow: the 2 km grid square)", fill=(235, 230, 215), font=font)
    p = os.path.join(out, f'sbs_{side}_{slug}.png'); sbs.save(p); panels.append(sbs); print(p)
if panels:
    k = 0.5; W, H = int(1820 * k), int(960 * k)
    sheet = Image.new('RGB', (W * 2, H * ((len(panels) + 1) // 2)), (20, 20, 18))
    for i, p in enumerate(panels): sheet.paste(p.resize((W, H)), ((i % 2) * W, (i // 2) * H))
    sheet.save(os.path.join(out, f'sbs_{side}.png'))
# before | after pairs at the same camera: python3 -I v6_sbs.py UA ba -> ba_<side>_<view>.png
if tag == 'ba':
    import glob as _g
    for b in sorted(_g.glob(os.path.join(out, f'before_{side}_*.png'))):
        a = b.replace('/before_', '/after_')
        if not os.path.exists(a): continue
        A, B = Image.open(b).convert('RGB'), Image.open(a).convert('RGB'); w, h = B.size
        im = Image.new('RGB', (w * 2 + 20, h + 50), (20, 20, 18)); im.paste(A.resize((w, h)), (0, 50)); im.paste(B, (w + 20, 50))
        d = ImageDraw.Draw(im); d.text((10, 14), 'BEFORE (v5)', fill=(235, 230, 215), font=font); d.text((w + 30, 14), 'AFTER (v6, true to scale)', fill=(235, 230, 215), font=font)
        v = os.path.basename(b)[len(f'before_{side}_'):]; im.save(os.path.join(out, f'ba_{side}_{v}')); print('ba', v)
