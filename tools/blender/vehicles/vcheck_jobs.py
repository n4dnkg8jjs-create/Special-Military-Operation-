import json, sys
out, png = sys.argv[1], sys.argv[2]
VS = sys.argv[3].split(',')
jobs = []
man = json.load(open('/home/claude/special-military-operation-/assets/vehicles/manifest.json'))['vehicles']
KK = {'btr': 'cage,ew,sandbags,smoke,sight', 'ifv': 'cage,era,ew,sandbags', 'spg': 'cage', 'tank': 'cage,era,ew,roof,sandbags,smoke,sight'}
def kits(v):
    return KK.get(man[v].get('kind'), 'cage')

for v in VS:
    jobs += [dict(q=f'v={v}', glb=f'{out}/{v}_closed.glb'), dict(q=f'v={v}&open=1', glb=f'{out}/{v}_open.glb'),
             dict(q=f'v={v}&lod=1', glb=f'{out}/{v}_lod1_closed.glb'), dict(q=f'v={v}&lod=1&open=1', glb=f'{out}/{v}_lod1_open.glb')]
    if v != 'pickup':
        jobs.append(dict(q=f'v={v}&kits={kits(v)}', glb=f'{out}/{v}_kits.glb'))
    jobs.append(dict(q=f'v={v}&open=1&views=4&angs=30,45;150,45;270,70;90,25&dist=0.62&label={v} all hatches open (LOD0)', png=f'{png}/{v}_open.png'))
    jobs.append(dict(q=f'v={v}&open=1&lod=1&views=2&angs=30,45;210,45&dist=0.62&label={v} hatches open (LOD1)', png=f'{png}/{v}_open_lod1.png', w=1400, h=400))
    if v != 'pickup':
        jobs.append(dict(q=f'v={v}&kits={kits(v)}&views=4&angs=35,25;145,25;250,15;0,70&dist=0.8&label={v} all kits', png=f'{png}/{v}_kits.png'))
json.dump(jobs, open(f'{out}/jobs.json', 'w'))
