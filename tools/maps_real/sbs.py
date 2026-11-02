# Side-by-side: OSM rendering of the layout (render_osm.py) | the game's top-down overview (cropped to the map square).
import sys
from PIL import Image, ImageDraw, ImageFont
osm, game, out = sys.argv[1:4]
a = Image.open(osm).convert('RGB'); b = Image.open(game).convert('RGB')
H = 800; a = a.resize((H, H))
# the overview is 1400x800 with the map square centred: take the central square
w, h = b.size; s = min(w, h); b = b.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2)).resize((H, H))
im = Image.new('RGB', (H * 2 + 10, H + 28), (30, 30, 30)); im.paste(a, (0, 28)); im.paste(b, (H + 10, 28))
d = ImageDraw.Draw(im)
try: f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
except Exception: f = ImageFont.load_default()
d.text((8, 6), 'OpenStreetMap layout (converted, game frame)', fill=(230, 230, 230), font=f)
d.text((H + 18, 6), 'Game: top-down overview', fill=(230, 230, 230), font=f)
d.text((8, H + 8), 'Map data (c) OpenStreetMap contributors, ODbL', fill=(250, 250, 250), font=f)
im.save(out); print('wrote', out)
