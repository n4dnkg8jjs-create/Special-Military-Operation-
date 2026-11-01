# geojs.py geo.json -> prints a JS object literal with one feature per line
import json,sys
g=json.load(open(sys.argv[1]))
d=lambda v: json.dumps(v,ensure_ascii=False,separators=(',',':'))
out=['{',f"  w: {g['w']}, h: {g['h']}, kmPerUnit: {g['kmPerUnit']}, bbox: {d(g['bbox'])},"]
for k in ('roads','rivers','rail','forests','urban','water','defences','labels'):
    out.append(f'  {k}: [')
    for e in g[k]: out.append('    '+d(e)+',')
    out.append('  ],')
out.append('}')
print('\n'.join(out))
