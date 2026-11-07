"""soldiers_v10 joint deformation QA (joints.py): LBS of the uniform (variant A) over every clip of assets/soldiers/soldier_anims.glb,
per-triangle area ratio + anisotropy, worst / mean badness per bone.  run: python3 joints_check.py [data.pkl from a dump] [W.npy]"""
import sys, pickle, numpy as np
sys.path.insert(0, '/home/claude/special-military-operation-/tools/blender/soldiers')
import check_anims as CA
from qmath import qrot
D = pickle.load(open(sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].endswith('.pkl') else '/tmp/comms/headdata.pkl', 'rb'))
Wfile = [a for a in sys.argv[1:] if a.endswith('.npy')]
P = D['uni']['A']; T = D['uni_tri']; W = np.load(Wfile[0]) if Wfile else D['uni_W']
idx = D['skel_idx']; names = {v: k for k, v in idx.items()}
G = CA.read_glb('/home/claude/special-military-operation-/assets/soldiers/soldier_anims.glb'); M = CA.Model(G)
gi = np.array([M.idx[names[i]] for i in range(len(names))])
rest = D['skel_head']
# top-4 like the GLB
o = np.argsort(-W, 1)[:, :4]; w4 = np.take_along_axis(W, o, 1); w4 /= w4.sum(1, keepdims=True)
e1 = P[T[:, 1]] - P[T[:, 0]]; e2 = P[T[:, 2]] - P[T[:, 0]]
A0 = np.linalg.norm(np.cross(e1, e2), axis=1) / 2
# rest 2D frames per triangle
u0 = e1 / np.linalg.norm(e1, axis=1, keepdims=True); n0 = np.cross(e1, e2); n0 /= np.linalg.norm(n0, axis=1, keepdims=True); v0 = np.cross(n0, u0)
R0 = np.stack([np.stack([np.sum(e1 * u0, 1), np.sum(e1 * v0, 1)], 1), np.stack([np.sum(e2 * u0, 1), np.sum(e2 * v0, 1)], 1)], 2)  # 2x2 cols e1,e2
R0i = np.linalg.inv(R0 + np.eye(2) * 1e-12)
acc = np.zeros(len(T)); nfr = 0; worst_area = np.ones(len(T)); worst_aniso = np.ones(len(T)); where = [None] * len(T); where_a = [None] * len(T)
clips = [c for c in G['anims'] if not any(c.startswith(x) for x in ('medevac_cab', 'hatch_exit'))]
skip_clip = set(a for a in sys.argv[1:] if not a.endswith(('.pkl', '.npy')))
for c in clips:
    pose = M.pose(c)
    for f in range(0, pose['F'], 2):
        gq = pose['gq'][f][gi]; gp = pose['gp'][f][gi]
        V = np.zeros_like(P)
        for k in range(4):
            b = o[:, k]
            V += w4[:, k:k + 1] * (gp[b] + qrot(gq[b], P - rest[b]))
        f1 = V[T[:, 1]] - V[T[:, 0]]; f2 = V[T[:, 2]] - V[T[:, 0]]
        nn = np.cross(f1, f2); A1 = np.linalg.norm(nn, axis=1) / 2
        ar = A1 / (A0 + 1e-12)
        # orientation flip relative to the rest normal rotated by the dominant bone
        u1 = f1 / (np.linalg.norm(f1, axis=1, keepdims=True) + 1e-12); n1 = nn / (np.linalg.norm(nn, axis=1, keepdims=True) + 1e-12); v1 = np.cross(n1, u1)
        F2 = np.stack([np.stack([np.sum(f1 * u1, 1), np.sum(f1 * v1, 1)], 1), np.stack([np.sum(f2 * u1, 1), np.sum(f2 * v1, 1)], 1)], 2)
        J = F2 @ R0i
        s = np.linalg.svd(J, compute_uv=False)
        an = s[:, 0] / (s[:, 1] + 1e-9)
        acc += np.clip(0.5 - ar, 0, 0.5) * 2 + np.clip((an - 2.5) / 5, 0, 1); nfr += 1
        m = ar < worst_area
        worst_area[m] = ar[m]
        for i in np.nonzero(m)[0]: where_a[i] = (c, f)
        m = an > worst_aniso
        worst_aniso[m] = an[m]
        for i in np.nonzero(m)[0]: where[i] = (c, f)
dom = np.argmax(W[T].sum(1), 1)
def rep(mask, label):
    print(label, int(mask.sum()), 'tris, area %.3f m2' % A0[mask].sum())
    from collections import Counter
    cnt = Counter(names[d] for d in dom[mask]); print('  by bone', cnt.most_common(8))
    cc = Counter((where_a[i] or where[i])[0] for i in np.nonzero(mask)[0]); print('  by clip', cc.most_common(8))
rep(worst_area < 0.35, 'collapse (area < 35%)')
rep(worst_area < 0.15, 'severe collapse (< 15%)')
rep(worst_aniso > 4.0, 'shear/stretch (aniso > 4)')
rep(worst_aniso > 8.0, 'severe (aniso > 8)')
bb = acc / nfr * A0 * 1e4
for nm in ['Arm','ForeArm','UpLeg','Leg','Hips','LowerBack','Spine','Spine1','Neck','Shoulder','HipJoint']:
    sel = np.array([names[d].replace('Left','').replace('Right','').replace('L','',1 if names[d].startswith('LH') else 0).replace('R','',1 if names[d].startswith('RH') else 0)==nm for d in dom])
    print('  mean-bad', nm, round(float(bb[sel].sum()),2))
print('MEAN-BAD TOTAL', round(float(bb.sum()),2))
np.savez('/tmp/comms/jq.npz', acc=acc/nfr, worst_area=worst_area, worst_aniso=worst_aniso, A0=A0)
print('score: area-weighted collapse', float((A0 * np.clip(0.5 - worst_area, 0, 1)).sum()), 'aniso', float((A0 * np.clip(worst_aniso - 3, 0, 20)).sum()))
