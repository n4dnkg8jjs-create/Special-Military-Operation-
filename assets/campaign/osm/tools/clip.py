# clip.py in.json out.json lon0 lat0 lon1 lat1 : keep nodes in bbox(+margin), ways with >=1 kept node (all their nodes kept), relation shells
import json,sys
d=json.load(open(sys.argv[1])); lon0,lat0,lon1,lat1=map(float,sys.argv[3:7]); m=0.02
nodes={e['id']:e for e in d['elements'] if e['type']=='node'}
inb=lambda n: lon0-m<=n['lon']<=lon1+m and lat0-m<=n['lat']<=lat1+m
ways=[e for e in d['elements'] if e['type']=='way' and any(inb(nodes[i]) for i in e['nodes'] if i in nodes)]
keep=set(i for w in ways for i in w['nodes'])
wid=set(w['id'] for w in ways)
rels=[]
for e in d['elements']:
    if e['type']=='relation':
        e=dict(e); e['members']=[mm for mm in e['members'] if mm['type']!='way' or mm['ref'] in wid]; rels.append(e)
out=dict(d); out['elements']=[nodes[i] for i in keep if i in nodes]+ways+rels
out['clipped_to_bbox']=[lon0,lat0,lon1,lat1]
json.dump(out,open(sys.argv[2],'w'))
print(sys.argv[2],len(ways),'ways',len(keep),'nodes')
