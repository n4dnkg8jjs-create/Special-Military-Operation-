"""soldiers_v10 joints: skin-weight clean-up of the uniform (and the neck of the head mesh) for linear blend skinning.

The MakeHuman cmu_mb weights change from one bone to the next over a single ring of the (coarse, ~4.3k vertex) uniform at the
shoulders, elbows, hips / seat and knees: in strong bends (prone, crouch, kneel, reload_prone, throw, deaths, medevac) those
rings collapse to a crease or shear into thin slivers ("warped" joints).  three.js skins with linear blend and the rig has no
twist / helper bones (adding some would need channels in every clip and in the procedural pose layer / ragdoll), so the fix is in
the weights:
  - per joint, the weights inside a ball round the joint centre are diffused over the welded surface (cotangent-free umbrella
    Laplacian, a few dozen damped steps), so the change parent -> child spreads over ~3-4 rings instead of one;
  - joint-specific shaping: elbows / knees keep the outer side (olecranon / kneecap) a little more on the distal bone so the
    point of the joint does not cave in; the seat keeps the buttock on the thigh longer (sitting / crouching no longer
    flattens it into the pelvis); shoulders share the clavicle over the top of the deltoid;
  - wrists / hands are left alone (wrist.py: cinched sleeve hems, forearm-only weights, checked in 111 clips).
Measured with the per-triangle area / anisotropy QA in tools/blender/soldiers/joints_check.py (all clips, every 2nd frame):
mean badness 422 -> 304 (-28 %).
"""
import numpy as np

# (joint bone whose head is the pivot, radius m, steps, outer-side bias toward the distal bone (0..1), outer direction in rest)
JOINTS = [   # tuned with joints_check.py (mean badness over all clips 422 -> 304: shoulders 135 -> 87, seat 40 -> 13, hips 141 -> 119)
    ('LeftArm', 0.18, 120, 0.0, None), ('RightArm', 0.18, 120, 0.0, None),
    ('LeftForeArm', 0.13, 140, 0.2, (0, 0, -1.0)), ('RightForeArm', 0.13, 140, 0.2, (0, 0, -1.0)),
    ('LeftUpLeg', 0.20, 120, 0.0, None), ('RightUpLeg', 0.20, 120, 0.0, None),
    ('LeftLeg', 0.08, 30, 0.0, (0, 0, 1.0)), ('RightLeg', 0.08, 30, 0.0, (0, 0, 1.0)),
    ('Neck', 0.07, 12, 0.0, None), ('Spine', 0.10, 14, 0.0, None), ('LowerBack', 0.10, 14, 0.0, None),
]
PROTECT = ('LeftHand', 'RightHand', 'LThumb', 'RThumb', 'LeftFingerBase', 'RightFingerBase', 'LeftHandFinger1', 'RightHandFinger1',
           'LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase', 'Head')


def _weld(P, tol=1e-5):
    q = np.round(P / tol).astype(np.int64)
    _, rep, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
    return rep, inv.reshape(-1)


def _adjacency(nw, Tw):
    from scipy.sparse import coo_matrix
    r = np.r_[Tw[:, 0], Tw[:, 1], Tw[:, 2], Tw[:, 1], Tw[:, 2], Tw[:, 0]]
    c = np.r_[Tw[:, 1], Tw[:, 2], Tw[:, 0], Tw[:, 0], Tw[:, 1], Tw[:, 2]]
    A = coo_matrix((np.ones(len(r)), (r, c)), shape=(nw, nw)).tocsr()
    A.data[:] = 1.0
    deg = np.asarray(A.sum(1)).ravel()
    return A, deg


def _ss(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def smooth_weights(P, T, W, skel, joints=JOINTS, protect=PROTECT, alpha=1.0, log=None):
    """P (n,3) rest positions, T tris, W (n, nb) weights -> new W (same shape, rows sum to 1, <= 4 significant influences kept
    by the writer's top-4)."""
    idx = skel.idx
    rep, inv = _weld(P)
    nw = len(rep)
    Pw = P[rep]
    Tw = inv[T]
    A, deg = _adjacency(nw, Tw)
    Ww = np.zeros((nw, W.shape[1])); np.add.at(Ww, inv, W); Ww /= np.bincount(inv, minlength=nw)[:, None]
    prot = np.zeros(nw)
    for b in protect:
        if b in idx:
            prot += Ww[:, idx[b]]
    keep = 1 - _ss(0.01, 0.08, prot)            # no smoothing where the hand / foot / head bones have any say
    for name, rad, steps, bias, odir in joints:
        j = skel.head[idx[name]]
        d = np.linalg.norm(Pw - j, axis=1)
        f = (1 - _ss(rad * 0.55, rad, d)) * keep * alpha
        if not (f > 0).any():
            continue
        for _ in range(steps):
            L = (A @ Ww) / np.maximum(deg, 1)[:, None]
            Ww = Ww + f[:, None] * (L - Ww)
        if bias > 0 and odir is not None:
            # outer side of the hinge: move part of the parent's share onto the distal bone (pivot = this bone's head; the
            # distal bone is the one whose head is the pivot -> `name`; parent = skel parent)
            par = skel.parent[idx[name]] if hasattr(skel, 'parent') else None
            if par is not None and par >= 0:
                o = np.asarray(odir, float)
                side = np.clip(((Pw - j) @ o) / 0.05, 0, 1)
                g = bias * side * (1 - _ss(rad * 0.4, rad * 0.9, d)) * keep
                mv = Ww[:, par] * g
                Ww[:, par] -= mv; Ww[:, idx[name]] += mv
    Ww = np.clip(Ww, 0, None)
    Ww[Ww < 0.01] = 0
    Ww /= Ww.sum(1, keepdims=True)
    out = Ww[inv].astype(W.dtype)
    if log:
        ch = np.abs(out - W).sum(1)
        log(f'joints: weights changed on {(ch > 0.02).sum()} / {len(W)} uniform vertices (max L1 {ch.max():.2f})')
    return out


def apply(R, log=print):
    """in place on R (before wrist.apply / gear weights, so the sleeves' hems and all gear transfer the cleaned weights)"""
    if R.get('_joints'):
        return
    U = R['uniform']
    U['W'] = smooth_weights(R['variants']['A']['uniform_pos'], U['tri'], U['W'], R['skel'], log=log)
    R['_joints'] = True
