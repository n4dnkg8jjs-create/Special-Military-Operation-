# geocode.py in.txt out.json  (lines: key|query) via Nominatim, 1.1 s spacing, cached
import sys, json, time, os, urllib.request, urllib.parse
inp, outp = sys.argv[1], sys.argv[2]
res = json.load(open(outp)) if os.path.exists(outp) else {}
UA = 'smo-campaign-research/1.0 (game map research)'
for line in open(inp, encoding='utf-8'):
    line = line.strip()
    if not line or line.startswith('#'): continue
    key, q = line.split('|', 1)
    if key in res: continue
    url = 'https://nominatim.openstreetmap.org/search?' + urllib.parse.urlencode({'q': q, 'format': 'json', 'limit': 3, 'countrycodes': 'ua', 'accept-language': 'en'})
    try:
        d = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=60).read())
    except Exception as e:
        print('ERR', key, e, flush=True); time.sleep(3); continue
    res[key] = [{'lat': float(x['lat']), 'lon': float(x['lon']), 'name': x.get('display_name', '')[:120], 'type': x.get('type'), 'cls': x.get('class')} for x in d]
    print(key, res[key][0]['lat'] if d else None, res[key][0]['lon'] if d else None, (res[key][0]['name'][:70] if d else ''), flush=True)
    json.dump(res, open(outp, 'w'), ensure_ascii=False, indent=0)
    time.sleep(1.1)
