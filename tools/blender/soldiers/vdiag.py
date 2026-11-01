"""dev: per-frame vehicle penetration of a clip in .cache/vdev.glb: python3 vdiag.py clip veh [t0 t1]"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import check_anims as CK
import clips_vehicle as CV
name, veh = sys.argv[1], sys.argv[2]
t0, t1 = (float(sys.argv[3]), float(sys.argv[4])) if len(sys.argv) > 4 else (0, 99)
glb = sys.argv[5] if len(sys.argv) > 5 else os.path.join(CK.CACHE, 'vdev.glb')
G = CK.read_glb(glb); M = CK.Model(G); P = M.pose(name)
gp = P['gp']; F = P['F']; t = np.arange(F) / 30
rad = dict(Hips=0.10, LowerBack=0.10, Spine=0.11, Spine1=0.12, Neck=0.06, Head=0.10, LeftHand=0.03, RightHand=0.03, LeftFoot=0.04, RightFoot=0.04,
           LeftToeBase=0.025, RightToeBase=0.025, LeftUpLeg=0.07, RightUpLeg=0.07, LeftLeg=0.05, RightLeg=0.05, LeftForeArm=0.04, RightForeArm=0.04)
for f in range(F):
    if not (t0 - 1e-6 <= t[f] <= t1 + 1e-6):
        continue
    row = []
    for b in CK.BONES:
        if b.endswith(('Thumb', 'FingerBase', 'Finger1')) or b in ('LHipJoint', 'RHipJoint', 'Neck1'):
            continue
        d = CV.vehicle_depth(name.replace('_dev', ''), veh, gp[f, M.idx[b]], rad.get(b, 0.05))
        if d > 0.02:
            v = CV.c2v(name, gp[f, M.idx[b]])
            row.append(f'{b}:{d:.2f}@v({v[0]:.2f},{v[1]:.2f},{v[2]:.2f})')
    if row:
        print(f'{t[f]:.2f}', ' '.join(row))
