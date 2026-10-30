"""Contact sheet of texture sets: tiled 2x2 albedo (seam check) + 1:1 crop + normal + ORM crops."""
import sys, os
from PIL import Image
names = sys.argv[2:]; out = sys.argv[1]
d = 'assets/textures'
rows = []
for n in names:
    a = Image.open(f'{d}/{n}_albedo.jpg').convert('RGB'); nm = Image.open(f'{d}/{n}_normal.png').convert('RGB'); o = Image.open(f'{d}/{n}_orm.png').convert('RGB')
    S = a.size[0]
    t = Image.new('RGB', (S * 2, S * 2)); [t.paste(a, (x, y)) for x in (0, S) for y in (0, S)]
    t = t.resize((512, 512), Image.LANCZOS)
    c = a.crop((S//2-256, S//2-256, S//2+256, S//2+256))
    cn = nm.crop((S//2-256, S//2-256, S//2+256, S//2+256))
    co = o.crop((S//2-256, S//2-256, S//2+256, S//2+256))
    row = Image.new('RGB', (2048, 512)); row.paste(t, (0, 0)); row.paste(c, (512, 0)); row.paste(cn, (1024, 0)); row.paste(co, (1536, 0))
    rows.append(row)
sheet = Image.new('RGB', (2048, 512 * len(rows)))
for i, r in enumerate(rows): sheet.paste(r, (0, 512 * i))
sheet.save(out)
