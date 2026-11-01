"""label the tiles of a preview grid: label_sheet.py <png> "a|b|c" <cols> [caption]"""
import sys
from PIL import Image, ImageDraw
path, labels, cols = sys.argv[1], sys.argv[2].split('|'), int(sys.argv[3])
cap = sys.argv[4] if len(sys.argv) > 4 else ''
im = Image.open(path).convert('RGB'); W, H = im.size
rows = (len(labels) + cols - 1) // cols
d = ImageDraw.Draw(im)
tw, th = W / cols, H / rows
for i, l in enumerate(labels):
    x, y = (i % cols) * tw, (i // cols) * th
    d.rectangle([x, y, x + tw - 1, y + th - 1], outline=(60, 60, 60))
    d.rectangle([x + 2, y + 2, x + 8 + 6.2 * len(l), y + 16], fill=(235, 235, 235))
    d.text((x + 5, y + 4), l, fill=(0, 0, 0))
if cap:
    d.rectangle([0, H - 18, 8 + 6.2 * len(cap), H], fill=(235, 235, 235)); d.text((4, H - 15), cap, fill=(0, 0, 0))
im.save(path)
