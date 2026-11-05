"""soldiers_v6 build driver: builds soldier_<fac>.glb with build_soldier.build() (v6 baggy uniform, re-baked textures, fuller pouches)
into .cache/v6/ (not straight into assets/, so a failed / half-checked build never reaches the game).  Copy to assets/soldiers/ after
WebP compression and review; merge the manifest by hand (v6_manifest.py).   run: python3 tools/blender/soldiers/build_v6.py [ru] [ua]"""
import os, sys, json, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import build_anims as BA
BA.setup()
import build_soldier as BS
OUT = os.path.join(HERE, '.cache', 'v6'); os.makedirs(OUT, exist_ok=True)
info = {}
for fac in (sys.argv[1:] or ('ru', 'ua')):
    t0 = time.time()
    W, R, rig, tc = BS.build(fac, with_lod=True)
    W.save(f'{OUT}/soldier_{fac}.glb')
    info[fac] = W.tris
    print(fac, 'built in', round(time.time() - t0), 's', flush=True)
    json.dump(W.combos, open(f'{OUT}/combos_{fac}.json', 'w'), indent=1, default=lambda o: o.tolist() if hasattr(o, 'tolist') else str(o))
    del W, R, rig
json.dump(info, open(f'{OUT}/soldier_tris.json', 'w'), indent=1)
