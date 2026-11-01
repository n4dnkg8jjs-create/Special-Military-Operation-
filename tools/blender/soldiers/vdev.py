"""dev runner for clips_vehicle: python3 vdev.py clip [clip ...] -> .cache/vdev.glb + diagnostics"""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import build_anims as BA
import clips_vehicle as CV
R, rig = BA.setup()
lm = R['variants']['A']['lm']
out = {}
for n in sys.argv[1:]:
    t0 = time.time()
    if n.startswith('hatch_exit'):
        gq, root, info, ev, dur = getattr(CV, n)(rig, lm)
    else:
        gq, root, info, ev, dur = getattr(CV, n)(rig, lm)
    CV.debug_report(n, rig, gq, root, info)
    print('events', ev, 'built in %.1fs' % (time.time() - t0))
    out[n] = CV.to_clip(n, rig, gq, root, False, root_motion=True, notes='dev', events=ev)
BA.write(rig, out, os.path.join(BA.BUILD, 'vdev.glb'))
print('wrote .cache/vdev.glb')
