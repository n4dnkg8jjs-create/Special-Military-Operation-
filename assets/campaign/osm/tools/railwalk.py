# railwalk.py out.json lon0 lat0 lon1 lat1 seed_node... : follow railway ways (rail/disused/abandoned, usage main/branch) connected to seeds inside bbox
import json,sys,time,urllib.request
UA='smo-campaign-research/1.0'
def get(p):
    time.sleep(1.0); return json.load(urllib.request.urlopen(urllib.request.Request('https://api.openstreetmap.org/api/0.6/'+p,headers={'User-Agent':UA}),timeout=60))
out=sys.argv[1]; lon0,lat0,lon1,lat1=map(float,sys.argv[2:6]); seeds=sys.argv[6:]
nodes={}; ways={}; queue=list(seeds); seen=set(); calls=0
inb=lambda n: lon0<=n['lon']<=lon1 and lat0<=n['lat']<=lat1
while queue and calls<80:
    nid=queue.pop(0)
    if nid in seen: continue
    seen.add(nid); calls+=1
    d=get(f'node/{nid}/ways.json')
    for w in d['elements']:
        t=w.get('tags',{})
        if w['id'] in ways or t.get('railway') not in ('rail','disused','abandoned') or t.get('service') in ('yard','siding','spur','crossover'): continue
        f=get(f"way/{w['id']}/full.json"); calls+=1
        for e in f['elements']:
            if e['type']=='node': nodes[e['id']]=e
        ways[w['id']]=w
        for end in (w['nodes'][0],w['nodes'][-1]):
            n=nodes.get(end)
            if n and inb(n) and str(end) not in seen: queue.append(str(end))
    print(calls,len(ways),file=sys.stderr)
json.dump({'version':'0.6','generator':'railwalk via OSM API v0.6','elements':list(nodes.values())+list(ways.values())},open(out,'w'))
print(len(ways),'ways',calls,'calls')
