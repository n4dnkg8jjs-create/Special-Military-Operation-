"""Clip library: mocap processing (CMU) + authored poses + rifle overlay -> named clips.
Each clip: dict(name, gq (F,nb,4) global rotations, root (F,3), loop, speed (m/s), root_motion, notes)."""
import numpy as np
from scipy.optimize import minimize
import bvh as BV
import anim as A
from anim import FPS, smooth, fk_global, rifle_overlay, gun_in_chest
from qmath import qmul, qinv, qrot, qaxis, qbetween, qnorm, qslerp, qeuler, qfrom_mat, qto_mat, qfix_continuity

Y = np.array([0, 1.0, 0])


# ============================================================== mocap helpers
def mocap(rig, name, t0=0.0, t1=None):
    b = BV.BVH(name)
    f0 = int(t0 / b.dt); f1 = None if t1 is None else int(t1 / b.dt)
    gq, root, sc = BV.retarget(rig.sk, b, f0, f1)
    return gq, root


def rotate_y(gq, root, ang, pivot=None):
    q = qaxis(Y, ang)
    pivot = root[0] * [1, 0, 1] if pivot is None else pivot
    gq = qmul(q[None, None], gq)
    root = pivot + qrot(q[None], root - pivot)
    return gq, root


def face_forward(rig, gq, root, use_travel=True):
    """rotate so the travel direction (or hip facing) is +Z"""
    if use_travel:
        d = root[-1] - root[0]; d[1] = 0
    if not use_travel or np.linalg.norm(d) < 0.2:
        f = qrot(gq[:, 0], np.array([0, 0, 1.0])).mean(0); d = f; d[1] = 0
    ang = np.arctan2(d[0], d[2])
    return rotate_y(gq, root, -ang)


def ground_fix(rig, gq, root, pct=8, target=None):
    gp = fk_global(rig.sk, gq, root)
    I = rig.sk.idx
    feet = np.minimum(np.minimum(gp[:, I['LeftFoot'], 1], gp[:, I['RightFoot'], 1]),
                      np.minimum(gp[:, I['LeftToeBase'], 1] + 0.045, gp[:, I['RightToeBase'], 1] + 0.045))
    rest_ankle = rig.sk.head[I['LeftFoot'], 1]
    target = rest_ankle if target is None else target
    off = target - np.percentile(feet, pct)
    root = root.copy(); root[:, 1] += off
    return root


def find_cycle(rig, gq, root, pmin, pmax, search=None):
    """best (start, period) so the pose at start+period matches start (positions rel. to hips)"""
    gp = fk_global(rig.sk, gq, root)
    rel = gp - gp[:, :1]
    vel = np.gradient(rel, axis=0)
    F = len(gq)
    best = (1e9, 0, pmin)
    s0, s1 = search if search else (0, F - pmax - 1)
    for a in range(s0, max(s0 + 1, s1)):
        for p in range(pmin, pmax + 1):
            b = a + p
            if b >= F:
                break
            e = np.sum((rel[a] - rel[b]) ** 2) + 4 * np.sum((vel[a] - vel[b]) ** 2)
            if e < best[0]:
                best = (e, a, p)
    return best[1], best[2]


def make_loop(gq, root, a, p, blend=6):
    """frames a..a+p, cross-faded so the last frame == first; returns gq, root (p+1 frames), stride (m)"""
    seg_q = gq[a:a + p + 1].copy(); seg_r = root[a:a + p + 1].copy()
    stride = seg_r[-1] - seg_r[0]
    # blend the tail toward the frames preceding the start (shifted by one period)
    for k in range(blend + 1):
        i = p - blend + k
        w = smooth(k / blend)
        src = a + i - p  # frame before start
        if src < 0:
            continue
        seg_q[i] = qslerp(seg_q[i], gq[src], w)
        seg_r[i] = seg_r[i] * (1 - w) + (root[src] + stride * [1, 0, 1]) * w   # horizontal stride only: vertical must close the loop
    seg_q[-1] = seg_q[0]
    for j in range(seg_q.shape[1]):
        seg_q[:, j] = qfix_continuity(seg_q[:, j])
    return seg_q, seg_r, stride


def strip_root(root, keep_y=True):
    r = root.copy()
    F = len(r)
    # remove linear drift in xz (in-place loop)
    t = np.linspace(0, 1, F)
    r[:, 0] = r[:, 0] - (r[0, 0] + (r[-1, 0] - r[0, 0]) * t)
    r[:, 2] = r[:, 2] - (r[0, 2] + (r[-1, 2] - r[0, 2]) * t)
    return r


# ============================================================== authored poses
def pose_lq(rig, pose, F=1):
    """pose: dict bone -> (x, y, z) local euler degrees (order Y, X, Z); 'root' -> (x,y,z) Hips position"""
    lq = np.zeros((F, rig.n, 4)); lq[..., 3] = 1
    for b, e in pose.items():
        if b in ('root',):
            continue
        lq[:, rig.I[b]] = qeuler(*e, order='YXZ')[None]
    root = np.tile(pose.get('root', rig.sk.head[0]), (F, 1)).astype(float)
    return lq, root


def keyed(rig, keys, dur, ease=True):
    """keys: list of (time_s, pose). returns lq (F,nb,4), root (F,3)"""
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    L = [pose_lq(rig, p)[0][0] for _, p in keys]
    Rt = [pose_lq(rig, p)[1][0] for _, p in keys]
    kt = np.array([k for k, _ in keys])
    lq = np.zeros((F, rig.n, 4)); root = np.zeros((F, 3))
    for f in range(F):
        j = np.searchsorted(kt, t[f], side='right') - 1
        j = np.clip(j, 0, len(kt) - 1)
        if j >= len(kt) - 1:
            lq[f] = L[-1]; root[f] = Rt[-1]; continue
        w = (t[f] - kt[j]) / max(kt[j + 1] - kt[j], 1e-6)
        w = smooth(w) if ease else w
        lq[f] = qslerp(L[j], L[j + 1], w)
        root[f] = Rt[j] * (1 - w) + Rt[j + 1] * w
    return lq, root


def add_local(rig, lq, bone, euler_fn):
    """multiply a per-frame local rotation (euler deg as function of frame index array) onto a bone"""
    F = lq.shape[0]
    f = np.arange(F)
    ex, ey, ez = euler_fn(f)
    q = np.array([qeuler(x, y, z, order='YXZ') for x, y, z in zip(np.broadcast_to(ex, F), np.broadcast_to(ey, F), np.broadcast_to(ez, F))])
    lq[:, rig.I[bone]] = qmul(lq[:, rig.I[bone]], q)
    return lq


def breathing(rig, lq, F, cycles=1, amp=1.2):
    ph = 2 * np.pi * cycles * np.arange(F) / (F - 1)
    for b, a in (('Spine', 0.5), ('Spine1', 1.0), ('Neck', -0.6)):
        add_local(rig, lq, b, lambda f, a=a: (amp * a * np.sin(ph), 0 * ph, 0 * ph))
    for b, s in (('LeftShoulder', 1), ('RightShoulder', -1)):
        add_local(rig, lq, b, lambda f, s=s: (0 * ph, 0 * ph, s * 0.8 * amp * np.sin(ph)))
    return lq


def leg_ik(rig, gq, root, side, ankle, pole, foot_q=None):
    gp = fk_global(rig.sk, gq, root)
    F = len(gq)
    ankle = np.broadcast_to(ankle, (F, 3)); pole = np.broadcast_to(pole, (F, 3))
    lq_ref = rig.sk.local_from_global(gq)
    end_rot = None if foot_q is None else np.broadcast_to(foot_q, (F, 4)).copy()
    rig.two_bone(gq, gp, side + 'UpLeg', side + 'Leg', side + 'Foot', ankle.copy(), pole.copy(), end_rot=end_rot, twist_share=0.0)
    gq = rig.recompute_desc(lq_ref, gq, {side + 'UpLeg', side + 'Leg', side + 'Foot'})
    return gq


# ============================================================== gun poses (bind-pose world, carried by chest)
GUNPOSE = {
    'patrol': (np.array([-0.13, 1.13, 0.26]), dict(x=30, y=26)),
    'low_ready': (np.array([-0.13, 1.17, 0.29]), dict(x=32, y=14)),
    'port': (np.array([-0.12, 1.15, 0.25]), dict(x=22, y=35, z=-15)),
    'cower': (np.array([-0.08, 1.12, 0.22]), dict(x=-55, y=35, z=-10)),
}


def gun_rest(name):
    p, e = GUNPOSE[name]
    return p, qeuler(e.get('x', 0), e.get('y', 0), e.get('z', 0), order='YXZ')


def carry(rig, gq, root, pose='patrol', **kw):
    p, q = gun_rest(pose)
    gun_q, gun_p = gun_in_chest(rig.sk, gq, root, p, q)
    out, err = rifle_overlay(rig, gq, root, gun_q, gun_p, **kw)
    return out, err


# ============================================================== aiming solver
def eye_local(rig, lm):
    return lm['eyeR'] - rig.sk.head[rig.I['Head']]


def solve_aim(rig, lm, lq, root, aim_dir=np.array([0, 0, 1.0]), pocket=np.array([-0.10, 1.445, 0.135]), yaw_in=1.5,
              head=(8, -4, -10), neck=(5, 0, 0)):
    """Shouldered aim.  The head/neck take an authored cheek-weld posture (chin down, head canted right);
    the gun is placed so the right eye lies on the sight line (eye 2 cm above the sights, ~27 cm behind the
    rear sight), then the chest/clavicle are solved so the butt sits in the shoulder pocket.
    returns lq, gun_q, gun_p, butt_error"""
    gun = A.GUN['ak74m']
    sk = rig.sk
    d = aim_dir / np.linalg.norm(aim_dir)
    gun_q = qmul(qaxis(Y, np.arctan2(d[0], d[2]) + np.radians(yaw_in)), qaxis([1, 0, 0], -np.arcsin(np.clip(d[1], -1, 1))))
    eye_g = np.array([0, gun['sight'][1] + 0.022, gun['sight'][2] - 0.355])
    eL = eye_local(rig, lm)
    base = lq.copy()
    base[0, rig.I['Neck']] = qmul(base[0, rig.I['Neck']], qeuler(*neck, order='YXZ'))
    base[0, rig.I['Head']] = qmul(base[0, rig.I['Head']], qeuler(*head, order='YXZ'))
    s_rest = sk.head[sk.idx['Spine1']]

    def apply(x):
        l = base.copy()
        l[0, rig.I['Spine']] = qmul(base[0, rig.I['Spine']], qeuler(x[0] * 0.5, x[1] * 0.5, x[2] * 0.5, order='YXZ'))
        l[0, rig.I['Spine1']] = qmul(base[0, rig.I['Spine1']], qeuler(x[0] * 0.5, x[1] * 0.5, x[2] * 0.5, order='YXZ'))
        l[0, rig.I['RightShoulder']] = qmul(base[0, rig.I['RightShoulder']], qeuler(0, x[3], x[4], order='YXZ'))
        l[0, rig.I['Head']] = qmul(l[0, rig.I['Head']], qeuler(x[5], 0, 0, order='YXZ'))
        l[0, rig.I['Neck']] = qmul(l[0, rig.I['Neck']], qeuler(x[6] * 0.5, 0, 0, order='YXZ'))
        l[0, rig.I['Neck1']] = qmul(l[0, rig.I['Neck1']], qeuler(x[6] * 0.5, 0, 0, order='YXZ'))
        return l

    def evalx(x):
        l = apply(x)
        g = rig.global_from_local(l)
        p = fk_global(sk, g, root)
        eye = p[0, rig.I['Head']] + qrot(g[0, rig.I['Head']], eL)
        gun_p = eye - qrot(gun_q, eye_g)
        butt = gun_p + qrot(gun_q, gun['butt'] + [0, 0.015, 0])
        cq, cp = g[0, rig.I['Spine1']], p[0, rig.I['Spine1']]
        # pocket follows the clavicle: rest pocket relative to RightShoulder joint
        ic = rig.I['RightShoulder']
        pk = p[0, ic] + qrot(g[0, ic], pocket - sk.head[ic])
        return l, gun_p, butt, pk

    def cost(x):
        _, _, butt, pk = evalx(x)
        return 1e4 * np.sum((butt - pk) ** 2) + 0.002 * np.sum(np.asarray(x) ** 2)
    bounds = [(-4, 10), (-14, 14), (-10, 10), (-12, 12), (-6, 18), (-6, 12), (0, 16)]
    res = minimize(cost, np.zeros(7), method='Powell', bounds=bounds, options=dict(maxiter=6000, xtol=1e-3, ftol=1e-8))
    l, gun_p, butt, pk = evalx(res.x)
    print('aim solve', np.round(res.x, 1))
    return l, gun_q, gun_p, float(np.linalg.norm(butt - pk))
