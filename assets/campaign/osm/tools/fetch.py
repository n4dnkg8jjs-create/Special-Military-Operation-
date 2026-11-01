# usage: fetch.py outdir name lon0 lat0 lon1 lat1  -> OSM API v0.6 map.json saved raw
import json, urllib.request, sys, time, os
UA='smo-campaign-research/1.0'
def get(url):
    for i in range(3):
        try: return urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':UA}),timeout=120).read()
        except Exception as e: print('retry',url,e,file=sys.stderr); time.sleep(5)
    raise SystemExit('failed '+url)
if __name__=='__main__':
    out,name=sys.argv[1],sys.argv[2]
    if sys.argv[3]=='rel' or sys.argv[3]=='way':
        url=f'https://api.openstreetmap.org/api/0.6/{"relation" if sys.argv[3]=="rel" else "way"}/{sys.argv[4]}/full.json'
    else:
        b=','.join(sys.argv[3:7]); url=f'https://api.openstreetmap.org/api/0.6/map.json?bbox={b}'
    data=get(url); p=os.path.join(out,name+'.json'); open(p,'wb').write(data)
    d=json.loads(data); print(name, len(data)//1024,'KB', len(d['elements']),'elements')
