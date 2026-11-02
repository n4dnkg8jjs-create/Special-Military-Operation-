import json,sys
d=json.load(open(f'/tmp/osmv2/aor_{sys.argv[1]}.json')); g=d['grid']
C,R=g['cols'],g['rows']; cells={x['id']:x for x in d['cells']}
def grid(f,w=5):
    print('     '+''.join(f'{c:>{w}}' for c in range(C)))
    for r in range(R):
        print(f'{r:>3}  '+''.join(f'{f(cells[f"c{c}_{r}"]):>{w}}' for c in range(C)))
for name,f in [('res%',lambda x:int(100*(x['frac'].get('res',0)+x['frac'].get('ind',0)+x['frac'].get('ind2',0)))),('wood%',lambda x:int(100*x['frac'].get('wood',0))),('water%',lambda x:int(100*(x['frac'].get('water',0)+x['frac'].get('wet',0)))),
  ('fortKm',lambda x:round(x['fortKm'],1)),('bunk',lambda x:x['bunkers']),('road2km',lambda x:round(x['road2'],1)),('road1km',lambda x:round(x['road1'],1)),('stream',lambda x:round(x['stream'],1))]:
    print(name); grid(f)
for x in d['cells']:
    for p in x['places']:
        if p['place'] in ('city','town','village','hamlet'): print(x['id'],p['name'],p['place'],p['pop'],round(p['lat'],4),round(p['lon'],4))
