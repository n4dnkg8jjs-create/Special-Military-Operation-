# fetch_tiles.py SIDE latN lonW cellLat cellLon cols rows step -> OSM API map tiles (recursive split on 400/509)
import sys, os, time, json, urllib.request, urllib.error
side, latN, lonW, dLa, dLo, cols, rows, step = sys.argv[1], *map(float, sys.argv[2:6]), *map(int, sys.argv[6:9])
out = f'/tmp/osmv2/{side}'
UA = 'smo-campaign-research/1.0 (game map research)'
def get(b):
    url = 'https://api.openstreetmap.org/api/0.6/map.json?bbox=' + ','.join(f'{v:.5f}' for v in b)
    for i in range(4):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=180).read()
        except urllib.error.HTTPError as e:
            if e.code in (400, 509): return None
            print('retry', e, file=sys.stderr); time.sleep(10)
        except Exception as e:
            print('retry', e, file=sys.stderr); time.sleep(10)
    raise SystemExit('failed ' + url)
def fetch(name, b, depth=0):
    p = f'{out}/{name}.json'
    if os.path.exists(p): return
    d = get(b); time.sleep(1.2)
    if d is None:
        if depth > 3: print('give up', name); return
        lo0, la0, lo1, la1 = b; lm, om = (la0+la1)/2, (lo0+lo1)/2
        for k, bb in enumerate([(lo0, lm, om, la1), (om, lm, lo1, la1), (lo0, la0, om, lm), (om, la0, lo1, lm)]):
            fetch(f'{name}_{k}', bb, depth+1)
        return
    open(p, 'wb').write(d); print(name, len(d)//1024, 'KB', flush=True)
for r in range(0, rows, step):
    for c in range(0, cols, step):
        la1 = latN - r*dLa; la0 = latN - min(rows, r+step)*dLa
        lo0 = lonW + c*dLo; lo1 = lonW + min(cols, c+step)*dLo
        fetch(f't{c}_{r}', (lo0, la0, lo1, la1))
print('done')
