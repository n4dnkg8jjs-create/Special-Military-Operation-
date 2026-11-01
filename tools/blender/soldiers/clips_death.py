"""Death clips v2: direction / stance specific deaths (clips_death.py).

Conventions (anim.py / clips_extra.py): root at the origin, facing +Z, joint frames world-aligned in the bind pose, local euler
(deg, order YXZ): +X = pitch forward (spine bend, head nod, toes down), hip flexion = -X on *UpLeg, knee flexion = +X on *Leg,
+Y = yaw to the character's left, +Z = roll / lean to the character's right.  Deaths keep root motion and end at rest on flat
ground (the game hands the body to src/game/ragdoll.js at the 'ragdoll' event to settle it onto the real terrain).

How a clip is made (build()):
  1. trunk + legs from key poses (start pose = frame 0 of the stance clip the man was most likely playing: idle_rifle,
     run_rifle, aim_crouch, aim_prone, wounded_ground), eased per segment ('in' = gravity, accelerating into a contact)
  2. root lifted wherever the trunk / head / thighs would go under the floor; from the 'ground' time on the lowest body part
     is settled onto the floor (no float)
  3. planted feet: two-bone leg IK pins each foot to its ground spot over its support windows (no foot sliding), blended back
     to the keyed legs when the foot lets go; soles never under the floor; lying legs: heels pulled down onto the floor
  4. arms: the start pose's grip is held for `hold` s (the rifle drops), then both arms are SIMULATED (verlet elbow + wrist
     particles hanging from the animated shoulder: gravity, damping, ground friction, torso / thigh / head capsules so a limb
     never passes through the body, shoulder + elbow limits) and solved back onto the skeleton with two-bone IK
  5. neck / head lag (secondary motion), limp hands + fingers
Mirrored variants (death_spin_L) mirror the key poses and plant spots, then run the same pipeline (the arms are re-simulated)."""
import os, pickle
import numpy as np
import anim as A
import clips_extra as CX
from anim import FPS, fk_global, smooth
from qmath import qmul, qinv, qrot, qaxis, qeuler, qslerp, qnorm, qfix_continuity

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.cache')
Y = np.array([0, 1.0, 0])
G = np.array([0, -9.81, 0])
DBG = None

CLIPS = ('death_fall_back', 'death_sit_slump', 'death_fall_forward', 'death_spin_R', 'death_spin_L', 'death_knees', 'death_headshot',
         'death_run', 'death_crouch', 'death_prone', 'death_window_slump', 'death_window_back', 'death_blast', 'death_bleedout')
# impact windows where limbs legitimately move > 25 deg per frame (check_anims SNAP: clip -> (t0, t1, max deg/frame)): the knees
# giving way, the body slamming onto the ground, limp arms whipping on the impact, the blast tumble
SNAP = {'death_fall_back': (0.1, 1.3, 45.0), 'death_sit_slump': (0.2, 2.6, 40.0), 'death_fall_forward': (0.1, 1.2, 45.0),
        'death_spin_R': (0.1, 1.3, 45.0), 'death_spin_L': (0.1, 1.3, 45.0), 'death_knees': (0.2, 1.9, 40.0), 'death_headshot': (0.0, 1.0, 48.0),
        'death_run': (0.0, 1.2, 48.0), 'death_crouch': (0.1, 1.2, 40.0), 'death_prone': (0.0, 0.8, 40.0), 'death_window_slump': (0.1, 1.0, 40.0),
        'death_window_back': (0.0, 1.1, 45.0), 'death_blast': (0.0, 1.5, 55.0), 'death_bleedout': (0.0, 1.0, 30.0)}
# building window (buildings.js slotPos: root 0.75 m inside the wall centre line, wall 0.30 m thick, sill 0.86 m above the floor)
WALL_Z, SILL_Y = 0.60, 0.86
ARM_CHAIN = ('Shoulder', 'Arm', 'ForeArm', 'Hand')
FINGERS = ('LThumb', 'LeftFingerBase', 'LeftHandFinger1', 'RThumb', 'RightFingerBase', 'RightHandFinger1')


# ------------------------------------------------------------------ small helpers
def ease(w, e):
    w = np.clip(w, 0, 1)
    return w * w if e == 'in' else (1 - (1 - w) ** 2 if e == 'out' else (w if e == 'lin' else smooth(w)))


def gsmooth(x, sigma):
    if sigma <= 0:
        return x
    r = int(np.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2); k /= k.sum()
    pad = np.concatenate([np.repeat(x[:1], r, 0), x, np.repeat(x[-1:], r, 0)])
    if x.ndim == 1:
        return np.convolve(pad, k, 'valid')
    return np.stack([np.convolve(pad[:, c], k, 'valid') for c in range(x.shape[1])], 1)


def _mname(b):
    for a, c in (('Left', 'Right'), ('Right', 'Left'), ('LHip', 'RHip'), ('RHip', 'LHip'), ('LThumb', 'RThumb'), ('RThumb', 'LThumb')):
        if b.startswith(a):
            return c + b[len(a):]
    return b


def mirror_pose(p):
    if not isinstance(p, dict):
        return p
    out = {}
    for b, v in p.items():
        if b == 'root':
            out[b] = np.array([-v[0], v[1], v[2]])
        elif b.startswith('_'):
            out[b] = v
        else:
            out[_mname(b)] = (v[0], -v[1], -v[2])
    return out


def mirror_lq(rig, lq, root):
    names = rig.sk.names
    perm = [rig.I[_mname(n)] for n in names]
    m = lq[..., perm, :].copy()
    m[..., 1] *= -1; m[..., 2] *= -1
    r = np.array(root, float).copy(); r[..., 0] *= -1
    return m, r


def start_pose(name, frame=0, built=None):
    c = (built or {}).get(name)
    if c is None:
        c = pickle.load(open(f'{CACHE}/clips.pkl', 'rb'))[name]
    return c['lq'][frame].copy(), c['root'][frame].copy()


def keyed2(rig, keys, dur, base):
    """keys: [(t, pose, ease)]; pose = 'start' | dict bone -> euler deg, 'root' -> Hips xyz; '_start': True keeps the start
    pose for the bones the key does not list (otherwise they are at rest).  base = (lq0, root0) start pose"""
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    lq0, r0 = base
    L, Rt = [], []
    for _, p, _ in keys:
        if isinstance(p, str):
            L.append(lq0.copy()); Rt.append(r0.copy()); continue
        q = lq0.copy() if p.get('_start') else np.tile([0, 0, 0, 1.0], (rig.n, 1))
        for b, e in p.items():
            if b in ('root',) or b.startswith('_'):
                continue
            q[rig.I[b]] = qeuler(*e, order='YXZ')
        L.append(q); Rt.append(np.asarray(p.get('root', r0), float))
    kt = np.array([k[0] for k in keys])
    lq = np.zeros((F, rig.n, 4)); root = np.zeros((F, 3))
    for f in range(F):
        j = min(max(np.searchsorted(kt, t[f], side='right') - 1, 0), len(kt) - 1)
        if j >= len(kt) - 1:
            lq[f] = L[-1]; root[f] = Rt[-1]; continue
        w = ease((t[f] - kt[j]) / max(kt[j + 1] - kt[j], 1e-6), keys[j + 1][2])
        lq[f] = qslerp(L[j], L[j + 1], w)
        root[f] = Rt[j] * (1 - w) + Rt[j + 1] * w
    return lq, root


def bone_pts(gp, gq, rig, bone, rest_pts):
    """(F, k, 3) world positions of points rigidly attached to `bone` (given in bind-pose world coordinates)"""
    i = rig.I[bone]
    P = np.asarray(rest_pts, float) - rig.sk.head[i]
    F = len(gq)
    return gp[:, i][:, None] + qrot(np.repeat(gq[:, i][:, None], len(P), 1), np.broadcast_to(P, (F, len(P), 3)))


# ------------------------------------------------------------------ ground / wall
def trunk_low(rig, gq, root, vest=0.015):
    """(F,) clearance of trunk + head + thighs (+ knees when lying) above the floor"""
    return A.ground_lowest(rig, gq, root, vest=vest, arms=False, legs=False)


def settle_root(rig, gq, root, t_ground, ramp=0.15, vest=0.015, extra=None):
    """lift the root where the trunk would go under the floor; from t_ground on the lowest trunk point rests on the floor"""
    F = len(gq); t = np.arange(F) / FPS
    low = trunk_low(rig, gq, root, vest)
    if extra is not None:
        low = np.minimum(low, extra(gq, root))
    corr = np.maximum(-low, 0)
    if t_ground is not None:
        w = smooth((t - (t_ground - ramp)) / ramp)
        corr = corr * (1 - w) + (-low) * w
        corr = gsmooth(corr, 1.2)
    root = root.copy(); root[:, 1] += corr
    low2 = trunk_low(rig, gq, root, vest)
    if extra is not None:
        low2 = np.minimum(low2, extra(gq, root))
    root[:, 1] += A._grow_smooth(np.maximum(-low2, 0), 2)
    return root


def knee_low(rig, gq, root, r=0.05):
    gp = fk_global(rig.sk, gq, root)
    return np.minimum(gp[:, rig.I['LeftLeg'], 1], gp[:, rig.I['RightLeg'], 1]) - r


def wall_push(rig, gq, root, wall_z=WALL_Z, sill=SILL_Y, margin=0.0):
    """window clips: keep the trunk behind the inner wall face below the sill (shift the root back)"""
    gp = fk_global(rig.sk, gq, root)
    P, bi = A.TORSO
    F = len(gq)
    over = np.full(F, -1.0)
    for i in np.unique(bi):
        p = P[bi == i]
        w = gp[:, i][:, None] + qrot(np.repeat(gq[:, i][:, None], len(p), 1), np.broadcast_to(p - rig.sk.head[i], (F, len(p), 3)))
        z = np.where(w[..., 1] < sill, w[..., 2] + 0.025 + margin, -9)    # 2.5 cm of plate carrier
        over = np.maximum(over, z.max(1) - wall_z)
    for b, rr in (('Head', 0.11), ('LeftLeg', 0.06), ('RightLeg', 0.06), ('LeftFoot', 0.05), ('RightFoot', 0.05)):
        p = gp[:, rig.I[b]]
        over = np.maximum(over, np.where(p[:, 1] < sill + 0.1, p[:, 2] + rr - wall_z, -9))
    root = root.copy(); root[:, 2] -= A._grow_smooth(np.maximum(over, 0), 2)
    return root


# ------------------------------------------------------------------ planted feet
def plant_feet(rig, gq, root, plant, base_gq, base_root, blend=0.14):
    """plant: [(side, t0, t1, ankle_xz or None)] -> foot pinned (ankle position + global foot rotation of the window start;
    None = where the foot is at t0 in the keyed motion, or in the start pose for t0 == 0) over [t0, t1], blended in/out"""
    I = rig.I; sk = rig.sk
    F = len(gq); t = np.arange(F) / FPS
    gp_k = fk_global(sk, gq, root)
    gp_b = fk_global(sk, base_gq[None], base_root[None])[0]
    lq_fk = rig.local(gq)
    lq = lq_fk.copy()
    for side in ('Left', 'Right'):
        wins = sorted([p for p in plant if p[0] == side], key=lambda p: p[1])
        if not wins:
            continue
        tgt = np.zeros((F, 3)); fq = np.tile([0, 0, 0, 1.0], (F, 1)); wgt = np.zeros(F)
        spots = []
        for _, t0, t1, xz in wins:
            f0 = int(round(t0 * FPS))
            if xz is None:
                a = gp_b[I[side + 'Foot']] if f0 == 0 else gp_k[f0, I[side + 'Foot']]
                q = base_gq[I[side + 'Foot']] if f0 == 0 else gq[f0, I[side + 'Foot']]
                a = np.array([a[0], sk.head[I[side + 'Foot'], 1] if f0 > 0 else a[1], a[2]])
            else:
                yaw = xz[2] if len(xz) > 2 else 0.0
                a = np.array([xz[0], sk.head[I[side + 'Foot'], 1], xz[1]]); q = qaxis(Y, np.radians(yaw))
            spots.append((t0, t1, a, q))
        for k, (t0, t1, a, q) in enumerate(spots):
            m = (t >= t0 - 1e-6) & (t <= t1 + 1e-6)
            tgt[m] = a; fq[m] = q; wgt[m] = 1
            if k == 0 and t0 > 0:                       # touch-down from the keyed swing
                mm = (t < t0) & (t > t0 - blend)
                tgt[mm] = a; fq[mm] = q; wgt[mm] = smooth((t[mm] - (t0 - blend)) / blend)
            if k + 1 < len(spots):                       # IK swing to the next spot: arc, foot turned on the way
                n0, n1_, b_, qb = spots[k + 1]
                mm = (t > t1) & (t < n0)
                u = smooth((t[mm] - t1) / max(n0 - t1, 1e-6))
                dist = np.linalg.norm((b_ - a)[[0, 2]])
                tgt[mm] = a[None] + (b_ - a)[None] * u[:, None]
                tgt[mm, 1] += (0.06 + 0.12 * min(dist, 1.0)) * np.sin(np.pi * u)
                fq[mm] = np.array([qslerp(q, qb, x) for x in u]); wgt[mm] = 1
            elif t1 < t[-1]:                             # last spot: lift-off back to the keyed leg
                mm = t > t1
                tgt[mm] = a; fq[mm] = q; wgt[mm] = 1 - smooth((t[mm] - t1) / blend)
        m = wgt > 1e-4
        if not m.any():
            continue
        sub = gq[m].copy()
        gp = fk_global(sk, sub, root[m])
        # reach: a foot the pelvis comes down onto slides out ahead of it (min hip-ankle 0.27 m); a foot the pelvis pulls
        # away from drags after it (max 0.85 m) - the IK never folds / stretches past the leg
        hp = gp[:, I[side + 'UpLeg']]; tg = tgt[m].copy()
        for k in range(len(tg)):
            d = tg[k] - hp[k]; dist = np.linalg.norm(d)
            if dist < 0.27 or dist > 0.85:
                dv = abs(d[1]); want = np.clip(dist, 0.27, 0.85)
                hx = np.sqrt(max(want ** 2 - dv ** 2, 0.0)); dh = d[[0, 2]]; nh = np.linalg.norm(dh)
                dirh = dh / nh if nh > 1e-6 else np.array([0.0, 1.0])
                if want > dv:
                    tg[k, [0, 2]] = hp[k, [0, 2]] + dirh * hx
                else:
                    tg[k] = hp[k] + d / dist * want
        tgt[m] = gsmooth(tg, 1.5) if len(tg) > 4 else tg
        # IK over the whole clip with blended targets / poles (planted: pinned spot, pole ahead of the pelvis; free: the keyed ankle
        # and knee direction) - one consistent solver, no FK/IK twist mismatch when a foot lets go
        gpa = fk_global(sk, gq, root)
        w = wgt[:, None]
        hip = gpa[:, I[side + 'UpLeg']]
        T_ = tgt * w + gpa[:, I[side + 'Foot']] * (1 - w)
        Q_ = np.array([qslerp(gq[f, I[side + 'Foot']], fq[f], wgt[f]) if wgt[f] > 0 else gq[f, I[side + 'Foot']] for f in range(F)])
        fwd = qrot(gq[:, I['Hips']], np.broadcast_to([0.12 if side == 'Left' else -0.12, 0, 1.0], (F, 3)))
        fwd[:, 1] = np.minimum(fwd[:, 1], 0.3)
        pole_p = (hip + T_) / 2 + fwd * 0.6
        pole_k = gpa[:, I[side + 'Leg']] + qrot(gq[:, I[side + 'UpLeg']], np.broadcast_to([0, 0, 0.5], (F, 3)))
        pole = pole_p * w + pole_k * (1 - w)
        sub = gq.copy()
        lq_ref = sk.local_from_global(sub)
        rig.two_bone(sub, gpa, side + 'UpLeg', side + 'Leg', side + 'Foot', T_, pole, end_rot=Q_, twist_share=0.0)
        sub = rig.recompute_desc(lq_ref, sub, {side + 'UpLeg', side + 'Leg', side + 'Foot'})
        lq_ik = rig.local(sub)
        for b_ in ('UpLeg', 'Leg', 'Foot'):
            lq[:, I[side + b_]] = lq_ik[:, I[side + b_]]
    return rig.global_from_local(lq)


def feet_floor(rig, gq, root, ankle_dy=None, floor=0.0):
    """leg IK: soles out of the floor (+ optional signed extra ankle offset per side); foot rotation kept, pole = the knee's
    own forward axis (A.lift_feet takes the pole from the knee bend, which flips on a straight leg)"""
    I = rig.I; sk = rig.sk; F = len(gq)
    for side in ('Left', 'Right'):
        gp = fk_global(sk, gq, root)
        dy = A._grow_smooth(np.maximum(floor - A.sole_low(rig, gq, root, side, gp), 0), 2)
        if ankle_dy is not None:
            dy = dy + ankle_dy[side]
        if np.abs(dy).max() < 1e-5:
            continue
        m = np.ones(F, bool)                    # whole clip: the same solver everywhere (no twist step where the correction starts)
        sub = gq[m].copy()
        tgt = gp[m, I[side + 'Foot']] + np.outer(dy[m], [0, 1.0, 0])
        pole = gp[m, I[side + 'Leg']] + qrot(sub[:, I[side + 'UpLeg']], np.broadcast_to([0, 0, 0.5], (m.sum(), 3)))
        lq_ref = sk.local_from_global(sub)
        rig.two_bone(sub, gp[m], side + 'UpLeg', side + 'Leg', side + 'Foot', tgt, pole, end_rot=sub[:, I[side + 'Foot']].copy(), twist_share=0.0)
        gq = gq.copy()
        gq[m] = rig.recompute_desc(lq_ref, sub, {side + 'UpLeg', side + 'Leg', side + 'Foot'})
    return gq


def heels_down(rig, gq, root, t_ground, ramp=0.25, knee_max=0.62):
    """lying legs: pull a floating boot down onto the floor (leg IK, foot rotation kept) once the body is down"""
    F = len(gq); t = np.arange(F) / FPS
    w = smooth((t - t_ground) / ramp)
    gp = fk_global(rig.sk, gq, root)
    dy = {}
    for side in ('Left', 'Right'):
        low = A.sole_low(rig, gq, root, side, gp)
        lying = smooth((knee_max - gp[:, rig.I[side + 'Leg'], 1]) / 0.08)
        dy[side] = -np.maximum(low, 0) * w * lying
        dy[side] = gsmooth(dy[side], 1.0)
    return feet_floor(rig, gq, root, ankle_dy=dy)


# ------------------------------------------------------------------ simulated limp arms
def capsules(rig, gq, root, gp=None):
    """body capsules (a (F,3), b (F,3), r) the arm particles are kept out of (bare torso: x +-0.18, z -0.09..0.155 + vest)"""
    gp = fk_global(rig.sk, gq, root) if gp is None else gp
    I = rig.I
    caps = []
    for sx in (1, -1):
        a = bone_pts(gp, gq, rig, 'Hips', [[0.07 * sx, 0.93, 0.03]])[:, 0]
        m = bone_pts(gp, gq, rig, 'Spine', [[0.075 * sx, 1.17, 0.035]])[:, 0]
        b = bone_pts(gp, gq, rig, 'Spine1', [[0.065 * sx, 1.36, 0.02]])[:, 0]
        caps += [(a, m, 0.125), (m, b, 0.125)]
    for side in ('Left', 'Right'):
        caps.append((gp[:, I[side + 'UpLeg']], gp[:, I[side + 'Leg']], 0.08))
        caps.append((gp[:, I[side + 'Leg']], gp[:, I[side + 'Foot']], 0.055))
    h = bone_pts(gp, gq, rig, 'Head', [[0, 1.66, 0.03]])[:, 0]
    caps.append((h, h, 0.115))
    n = gp[:, I['Neck']]
    caps.append((n, n, 0.075))
    return caps


def _push_caps(p, r, caps, f, w=1.0):
    for a, b, cr in caps:
        A_ = a[f - 1] + (a[f] - a[f - 1]) * w if f > 0 else a[f]
        B_ = b[f - 1] + (b[f] - b[f - 1]) * w if f > 0 else b[f]
        ab = B_ - A_
        L2 = ab @ ab
        u = 0.0 if L2 < 1e-9 else np.clip((p - A_) @ ab / L2, 0, 1)
        c = A_ + ab * u
        d = p - c
        dist = np.linalg.norm(d)
        R = cr + r
        if dist < R:
            if dist < 1e-6:
                d = np.array([0, 1.0, 0]); dist = 1.0
            p = c + d / dist * R
    return p


def _unit(v):
    return v / max(np.linalg.norm(v), 1e-9)


def arm_sim(rig, gq, root, side, t0, kick=(0, 0, 0), wall=None, sub=8, damp=0.035, fric=0.6, stiff=0.0, hand=0.075, tone=None):
    """limp arm from t0 on: verlet elbow + wrist hanging from the animated shoulder.  Returns elbow, wrist, bend dir (F,3) world.
    The elbow is a hinge: the forearm may only flex toward the bend direction b = n x u of the tracked hinge axis n (no
    hyperextension; the hinge axis follows the forearm when it swings out of its plane = humeral rotation, never flips).
    stiff: 0..1 per-frame pull of the elbow / wrist back toward the animated (kinematic) positions (muscle tone)"""
    I = rig.I; F = len(gq); dt = 1.0 / FPS / sub
    gp = fk_global(rig.sk, gq, root)
    S = gp[:, I[side + 'Arm']]; E0 = gp[:, I[side + 'ForeArm']]; W0 = gp[:, I[side + 'Hand']]
    L1 = np.linalg.norm(rig.sk.head[I[side + 'ForeArm']] - rig.sk.head[I[side + 'Arm']])
    L2 = np.linalg.norm(rig.sk.head[I[side + 'Hand']] - rig.sk.head[I[side + 'ForeArm']])
    dmin = np.sqrt(L1 ** 2 + L2 ** 2 - 2 * L1 * L2 * np.cos(np.radians(32)))     # elbow flexion <= 148 deg
    caps = capsules(rig, gq, root, gp)
    out = side == 'Left' and 1 or -1
    cq = gq[:, I['Spine1']]
    fwd = qrot(cq, np.broadcast_to([0, 0, 1.0], (F, 3)))
    lat = qrot(cq, np.broadcast_to([out * 1.0, 0, 0], (F, 3)))       # outward (the arm's own side)
    f0 = max(int(round(t0 * FPS)), 1)
    E = E0.copy(); W = W0.copy()
    # hinge axis from the kinematic arm (bent) frames, else the bind-pose bend plane
    Bd = np.zeros((F, 3))
    for f in range(F):
        u = _unit(E0[f] - S[f]); n = np.cross(u, W0[f] - E0[f])
        if np.linalg.norm(n) < 1e-3:
            n = np.array([0, 0, -1.0]) * out if f == 0 else np.cross(Bd[f - 1], u)
        Bd[f] = _unit(np.cross(_unit(n), u))
    nref = _unit(np.cross(_unit(E0[f0] - S[f0]), Bd[f0]))
    pe, pw = E0[f0].copy(), W0[f0].copy()
    ve = (E0[f0] - E0[f0 - 1]) * FPS + np.asarray(kick, float)
    vw = (W0[f0] - W0[f0 - 1]) * FPS + np.asarray(kick, float) * 1.6
    qe, qw = pe - ve * dt, pw - vw * dt
    re_, rw_ = 0.045, 0.035
    # residual muscle tone: a soft pull toward arms hanging along the trunk (chest frame), fading as he goes down
    dn = qrot(cq, np.broadcast_to([0, -1.0, 0], (F, 3)))
    Et = S + np.stack([_unit(v) for v in dn * 0.92 + fwd * 0.22 + lat * 0.2], 0) * L1
    Wt = Et + np.stack([_unit(v) for v in dn * 0.8 + fwd * 0.6 + lat * 0.05], 0) * L2
    ktone = np.zeros(F) if tone is None else tone
    for f in range(f0 + 1, F):
        for s in range(sub):
            a = (s + 1) / sub
            Sx = S[f - 1] * (1 - a) + S[f] * a
            vS = (S[f] - S[f - 1]) / sub                  # shoulder displacement per substep: limb speed relative to it <= 7 m/s
            de = (pe - qe) - vS; dw_ = (pw - qw) - vS
            vmax = 7.0 * dt
            de = de * min(1.0, vmax / max(np.linalg.norm(de), 1e-9)); dw_ = dw_ * min(1.0, vmax / max(np.linalg.norm(dw_), 1e-9))
            ne = pe + (vS + de) * (1 - damp) + G * dt * dt
            nw = pw + (vS + dw_) * (1 - damp) + G * dt * dt
            qe, qw, pe, pw = pe, pw, ne, nw
            if DBG is not None:
                DBG.append((f, s, -1, 'verlet', pe.copy(), pw.copy()))
            for it in range(3):
                d = pw - pe; l = np.linalg.norm(d)
                c = (l - L2) / max(l, 1e-9) * d
                pe = pe + c * 0.45; pw = pw - c * 0.55
                d = pe - Sx; pe = Sx + d / max(np.linalg.norm(d), 1e-9) * L1
                # shoulder: no more than ~55 deg behind the trunk, no more than ~40 deg across it
                u = (pe - Sx) / L1
                for ax, lim in ((-fwd[f], 0.82), (-lat[f], 0.62)):
                    k = u @ ax
                    if k > lim:
                        u = u - ax * (k - lim); u /= np.linalg.norm(u)
                pe = Sx + u * L1
                # elbow hinge: the forearm stays in the hinge plane (u, b); its sideways pull twists the hinge axis slowly
                # (humeral rotation, <= 2.5 deg per substep); flexion 10..148 deg (relaxed elbow never dead straight)
                nref = _unit(nref - u * (nref @ u))
                bdir = np.cross(nref, u)
                fv = _unit(pw - pe)
                lat_, fl, ax_ = fv @ nref, fv @ bdir, fv @ u
                tw = np.clip(np.arctan2(-lat_, max(abs(fl), 0.2)) * 0.5, -0.044, 0.044)
                nref = np.cos(tw) * nref + np.sin(tw) * bdir
                bdir = np.cross(nref, u)
                th = np.clip(np.arctan2(fl, ax_), np.radians(10), np.radians(148))
                fv = u * np.cos(th) + bdir * np.sin(th)
                pw = pe + fv * L2
                # body / wall / ground (wrist pushed with its hand tip)
                if DBG is not None:
                    DBG.append((f, s, it, 'pre_caps', pe.copy(), pw.copy()))
                pe = _push_caps(pe, re_, caps, f, a)
                ht = pw + _unit(pw - pe) * hand
                ht2 = _push_caps(ht, 0.03, caps, f, a)
                pw = _push_caps(pw + (ht2 - ht), rw_, caps, f, a)
                # mid-forearm too (a forearm lying across the chest / belly: both ends clear, the middle not)
                mf = (pe + pw) * 0.5
                dm = _push_caps(mf, 0.042, caps, f, a) - mf
                if dm @ dm > 1e-10:
                    pe = pe + dm; pw = pw + dm
                if wall is not None:
                    pe = wall(pe, re_); pw = wall(pw, rw_)
                if pe[1] < re_:
                    pe[1] = re_
                if pw[1] < rw_:
                    pw[1] = rw_
                if DBG is not None:
                    DBG.append((f, s, it, 'post', pe.copy(), pw.copy()))
            if ktone[f] > 0:
                k = ktone[f] / sub
                pe = pe + (Et[f - 1] * (1 - a) + Et[f] * a - pe) * k
                pw = pw + (Wt[f - 1] * (1 - a) + Wt[f] * a - pw) * k
            # ground friction
            if pe[1] <= re_ + 1e-4:
                qe[[0, 2]] = pe[[0, 2]] - (pe[[0, 2]] - qe[[0, 2]]) * (1 - fric)
                qe[1] = min(qe[1], pe[1])
            if pw[1] <= rw_ + 1e-4:
                qw[[0, 2]] = pw[[0, 2]] - (pw[[0, 2]] - qw[[0, 2]]) * (1 - fric)
                qw[1] = min(qw[1], pw[1])
        if stiff > 0:
            k = stiff if np.isscalar(stiff) else stiff[f]
            pe = pe + (E0[f] - pe) * k; pw = pw + (W0[f] - pw) * k
            qe = qe + (E0[f] - qe) * k; qw = qw + (W0[f] - qw) * k
        E[f], W[f] = pe, pw
        Bd[f] = np.cross(nref, _unit(pe - S[f]))
    return E, W, Bd


def apply_arms(rig, gq, root, sims, t_rel, limp_hand=None):
    """two-bone IK of both arms onto the simulated elbow / wrist from t_rel on (blended over 3 frames); the pole is the
    elbow tip (opposite the hinge's bend direction), continuous by construction"""
    I = rig.I; F = len(gq)
    t = np.arange(F) / FPS
    lq_k = rig.local(gq)
    out = gq.copy()
    gp = fk_global(rig.sk, gq, root)
    lq_ref = rig.sk.local_from_global(gq)
    for side, (E, W, Bd) in sims.items():
        rig.two_bone(out, gp, side + 'Arm', side + 'ForeArm', side + 'Hand', W.copy(), E - Bd * 0.3, end_rot=None, twist_share=0.0)
    out = rig.recompute_desc(lq_ref, out, {s + b for s in sims for b in ('Arm', 'ForeArm', 'Hand')})
    lq_s = rig.local(out)
    w = smooth((t - t_rel) / 0.25)
    lq = lq_k.copy()
    lh = qeuler(0, 0, 0, order='YXZ') if limp_hand is None else limp_hand
    wh = smooth((t - t_rel) / 0.35)
    for side in sims:
        for b in ('Arm', 'ForeArm'):
            i = I[side + b]
            lq[:, i] = np.array([qslerp(lq_k[f, i], lq_s[f, i], w[f]) for f in range(F)])
        i = I[side + 'Hand']
        lq[:, i] = np.array([qslerp(lq_k[f, i], lh, wh[f]) for f in range(F)])
        i = I[side + 'Shoulder']
        lq[:, i] = np.array([qslerp(lq_k[f, i], np.array([0, 0, 0, 1.0]), wh[f] * 0.7) for f in range(F)])
    # the clavicle relaxed after the IK: re-solve so the wrist stays on its simulated spot
    gq2 = rig.global_from_local(lq)
    gp2 = fk_global(rig.sk, gq2, root)
    lq_ref = rig.sk.local_from_global(gq2)
    m = w > 0.999
    for side, (E, W, Bd) in sims.items():
        if m.any():
            dS = gp2[:, I[side + 'Arm']] - gp[:, I[side + 'Arm']]
            sub = gq2[m].copy()
            rig.two_bone(sub, gp2[m], side + 'Arm', side + 'ForeArm', side + 'Hand', (W + dS)[m].copy(), (E + dS - Bd * 0.3)[m], end_rot=None, twist_share=0.0)
            gq2[m] = sub
    gq2 = rig.recompute_desc(lq_ref, gq2, {s + b for s in sims for b in ('Arm', 'ForeArm', 'Hand')})
    return gq2


def head_lag(rig, lq, k_neck=0.09, k_head=0.12):
    for b, k in (('Neck', k_neck), ('Neck1', k_neck), ('Head', k_head)):
        i = rig.I[b]
        q = qfix_continuity(lq[:, i])
        sm = CX.lag(q, k)
        lq[:, i] = qnorm(sm)
    return lq


# ------------------------------------------------------------------ the pipeline
def build(rig, name, keys, dur, base, *, plant=(), hold=0.2, t_ground=None, t_ragdoll=None, mirror=False, kick=None,
          wall=False, arm_stiff=0.0, head=(0.09, 0.12), heels=True, events=None, notes='', post=None, knee_r=0.05, tone=0.35):
    lq0, r0 = base
    if mirror:
        keys = [(t, mirror_pose(p), e) for t, p, e in keys]
        lq0, r0 = mirror_lq(rig, lq0[None], r0)
        lq0 = lq0[0]
        plant = [(('Right' if s == 'Left' else 'Left'), a, b, None if xz is None else (-xz[0], xz[1], -(xz[2] if len(xz) > 2 else 0)))
                 for s, a, b, xz in plant]
        kick = None if kick is None else {('Right' if s == 'Left' else 'Left'): (-v[0], v[1], v[2]) for s, v in kick.items()}
    base_gq = rig.global_from_local(lq0[None])[0]
    lq, root = keyed2(rig, keys, dur, (lq0, r0))
    F = len(lq); t = np.arange(F) / FPS
    # arms / fingers keep the start grip (the rifle moves with the chest) until they are simulated
    for s in ('Left', 'Right'):
        for b in ARM_CHAIN:
            lq[:, rig.I[s + b]] = lq0[rig.I[s + b]]
    for b in FINGERS:
        lq[:, rig.I[b]] = lq0[rig.I[b]]
    if head:
        lq = head_lag(rig, lq, *head)
    if post:
        lq, root = post(lq, root)
    gq = rig.global_from_local(lq)
    wall_fn = None
    if wall:
        def wall_fn(p, r):
            if p[1] < SILL_Y + r and p[2] > WALL_Z - r:
                if p[1] < SILL_Y - 0.02:
                    p = p.copy(); p[2] = WALL_Z - r
                else:
                    p = p.copy(); p[1] = SILL_Y + r
            return p
    # ground / wall / planted feet (two passes: the IK moves the knees, the knee clamp moves the root)
    extra = None
    for it in range(3):
        root = settle_root(rig, gq, root, t_ground, extra=extra)
        if wall:
            root = wall_push(rig, gq, root)
        g2 = plant_feet(rig, gq, root, plant, base_gq, r0) if plant else gq
        kl = knee_low(rig, g2, root, knee_r)
        if kl.min() >= -0.003:
            break
        extra = lambda gq_, root_: knee_low(rig, plant_feet(rig, gq_, root_, plant, base_gq, r0) if plant else gq_, root_, knee_r)
    gq = g2
    gq = feet_floor(rig, gq, root)
    if heels and t_ground is not None:
        gq = heels_down(rig, gq, root, t_ground)
    # simulated arms
    kick = kick or {}
    tg_ = t_ground if t_ground is not None else dur
    tone_s = tone * (1 - smooth((t - (tg_ - 0.35)) / 0.5))
    sims = {s: arm_sim(rig, gq, root, s, hold, kick=kick.get(s, (0, 0, 0)), wall=wall_fn, stiff=arm_stiff, tone=tone_s) for s in ('Left', 'Right')}
    gq = apply_arms(rig, gq, root, sims, hold)
    # limp limbs: light temporal smoothing of the simulated arm locals (impact whips spread over 2-3 frames)
    gq = A.smooth_locals(rig, gq, [s + b for s in ('Left', 'Right') for b in ('Arm', 'ForeArm', 'Hand')], 1.3, weight=smooth((t - hold) / 0.2))
    # final: nothing under the floor (arms included), soles out
    low = A.ground_lowest(rig, gq, root, vest=0.012)
    lift = A._grow_smooth(np.maximum(-low, 0), 2)
    if lift.max() > 1e-4:
        root = root.copy(); root[:, 1] += lift
    gq = feet_floor(rig, gq, root)
    lq = rig.local(gq)
    limp = lq.copy(); CX.limp_fingers(rig, limp, 1.0)
    wf = smooth((t - hold) / 0.3)
    for b in FINGERS:
        i = rig.I[b]
        lq[:, i] = np.array([qslerp(lq[f, i], limp[f, i], wf[f]) for f in range(F)])
    gq = rig.global_from_local(lq)
    ev = dict(drop_weapon=round(hold, 3))
    if t_ground is not None:
        ev['body_ground'] = round(t_ground, 3)
    ev['ragdoll'] = round(t_ragdoll if t_ragdoll is not None else (t_ground if t_ground is not None else dur * 0.6), 3)
    if events:
        ev.update(events)
    return CX.to_clip(name, rig, gq, root, False, root_motion=True, notes=notes, events=ev)


# ------------------------------------------------------------------ rest poses (on flat ground)
def supine(root, yaw=0, roll=0, head_turn=35, legs='bent_L'):
    p = dict(root=np.asarray(root, float), Hips=(-88, yaw, roll), LowerBack=(4, 0, 0), Spine=(5, 0, 0), Spine1=(3, 0, 0),
             Neck=(6, head_turn * 0.4, 0), Neck1=(0, 0, 0), Head=(-4, head_turn * 0.6, head_turn * 0.15))
    if legs == 'bent_L':
        p.update(LeftUpLeg=(-28, 28, 16), LeftLeg=(48, 0, 0), LeftFoot=(18, 10, 0), RightUpLeg=(-6, -16, -6), RightLeg=(10, 0, 0), RightFoot=(24, -22, 0))
    elif legs == 'straight':
        p.update(LeftUpLeg=(-5, 18, 9), LeftLeg=(8, 0, 0), LeftFoot=(24, 22, 0), RightUpLeg=(-6, -20, -8), RightLeg=(10, 0, 0), RightFoot=(24, -24, 0))
    elif legs == 'bent_R':
        p.update(RightUpLeg=(-30, -28, -16), RightLeg=(52, 0, 0), RightFoot=(18, -10, 0), LeftUpLeg=(-5, 18, 8), LeftLeg=(9, 0, 0), LeftFoot=(24, 22, 0))
    return p


def prone_rest(root, yaw=0, roll=0, head_turn=70, legs='L_up'):
    p = dict(root=np.asarray(root, float), Hips=(88, yaw, roll), LowerBack=(-3, 0, 0), Spine=(-4, 0, 0), Spine1=(-3, 0, 0),
             Neck=(-12, head_turn * 0.45, 0), Neck1=(0, 0, 0), Head=(-10, head_turn * 0.55, 0))
    # lying legs flat on the ground: hips rotated so the feet fall over onto their sides (a prone corpse never props itself on
    # its toes), one knee a little bent and turned out
    if legs == 'L_up':
        p.update(LeftUpLeg=(-16, 46, 22), LeftLeg=(24, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(0, -40, -7), RightLeg=(6, 0, 0), RightFoot=(32, 0, 0))
    else:
        p.update(LeftUpLeg=(0, 42, 7), LeftLeg=(6, 0, 0), LeftFoot=(32, 0, 0), RightUpLeg=(0, -44, -7), RightLeg=(6, 0, 0), RightFoot=(32, 0, 0))
    return p


def _merge(*ds, **kw):
    out = {}
    for d in ds:
        out.update(d)
    out.update(kw)
    return out


# ------------------------------------------------------------------ the clips
def death_fall_back(rig, built):
    """hit in the chest from the front: the trunk jerks back, the right foot staggers back a step, the knees give and he
    sits down hard, rolls onto his back (head whips), the left knee falls out to the side"""
    base = start_pose('idle_rifle', 0, built)
    r0 = base[1]
    keys = [
        (0.0, 'start', 'io'),
        (0.08, dict(_start=True, root=r0 + [0, -0.01, -0.04], Hips=(-6, -4, 2), LowerBack=(-5, 3, 0), Spine=(-8, 6, 2), Spine1=(-10, 6, 3), Neck=(8, 0, 0), Head=(8, -6, 0),
                    LeftUpLeg=(-6, 0, 0), LeftLeg=(10, 0, 0), RightUpLeg=(-2, 0, 0), RightLeg=(6, 0, 0)), 'out'),
        (0.30, dict(root=r0 + [0.01, -0.07, -0.18], Hips=(-12, -6, 3), LowerBack=(-6, 2, 0), Spine=(-7, 4, 0), Spine1=(-5, 3, 0), Neck=(14, 0, 0), Head=(10, 0, 0),
                    LeftUpLeg=(-24, 0, 2), LeftLeg=(32, 0, 0), LeftFoot=(-6, 0, 0), RightUpLeg=(8, 0, -2), RightLeg=(14, 0, 0), RightFoot=(0, 0, 0)), 'io'),
        (0.52, dict(root=r0 + [0.02, -0.40, -0.46], Hips=(-26, -6, 2), LowerBack=(4, 0, 0), Spine=(6, 0, 0), Spine1=(6, 0, 0), Neck=(18, 0, 0), Head=(12, 0, 0),
                    LeftUpLeg=(-62, 4, 6), LeftLeg=(98, 0, 0), LeftFoot=(-10, 0, 0), RightUpLeg=(-40, 0, -4), RightLeg=(96, 0, 0), RightFoot=(-8, 0, 0)), 'in'),
        (0.68, dict(root=np.array([0.03, 0.13, r0[2] - 0.56]), Hips=(-36, -6, 0), LowerBack=(8, 0, 0), Spine=(8, 0, 0), Spine1=(6, 0, 0), Neck=(22, 0, 0), Head=(14, 0, 0),
                    LeftUpLeg=(-56, 6, 8), LeftLeg=(84, 0, 0), LeftFoot=(-14, 0, 0), RightUpLeg=(-44, -2, -6), RightLeg=(78, 0, 0), RightFoot=(-10, 0, 0)), 'in'),
        (0.76, dict(root=np.array([0.03, 0.15, r0[2] - 0.57]), Hips=(-46, -6, 0), LowerBack=(6, 0, 0), Spine=(7, 0, 0), Spine1=(6, 0, 0), Neck=(24, 0, 0), Head=(14, 0, 0),
                    LeftUpLeg=(-50, 6, 8), LeftLeg=(80, 0, 0), LeftFoot=(-12, 0, 0), RightUpLeg=(-40, -2, -6), RightLeg=(74, 0, 0), RightFoot=(-8, 0, 0)), 'out'),
        (0.98, dict(root=np.array([0.03, 0.13, r0[2] - 0.62]), Hips=(-86, -6, 2), LowerBack=(4, 0, 0), Spine=(5, 0, 0), Spine1=(4, 0, 0), Neck=(26, 0, 0), Head=(10, 0, 0),
                    LeftUpLeg=(-56, 10, 10), LeftLeg=(84, 0, 0), LeftFoot=(-4, 0, 0), RightUpLeg=(-38, -6, -6), RightLeg=(64, 0, 0), RightFoot=(4, 0, 0)), 'in'),
        (1.10, _merge(supine([0.03, 0.12, r0[2] - 0.63], yaw=-6, head_turn=10), LeftUpLeg=(-50, 18, 14), LeftLeg=(76, 0, 0), RightUpLeg=(-22, -10, -6), RightLeg=(38, 0, 0), Neck=(10, 4, 0)), 'out'),
        (1.55, supine([0.03, 0.12, r0[2] - 0.64], yaw=-6, head_turn=35), 'io'),
        (2.3, supine([0.03, 0.12, r0[2] - 0.64], yaw=-6, head_turn=38), 'io'),
    ]
    plant = [('Left', 0.0, 0.70, None), ('Right', 0.0, 0.10, None), ('Right', 0.28, 0.66, (-0.13, -0.18, -14))]
    return build(rig, 'death_fall_back', keys, 2.3, base, plant=plant, hold=0.16, t_ground=0.68, t_ragdoll=0.98,
                 kick={'Left': (0.4, -0.2, 0.6), 'Right': (-0.4, -0.2, 0.6)},
                 notes='hit from the FRONT: trunk jerks back, right foot staggers back, sits down hard (0.68 s), rolls onto the back (0.98 s), '
                       'head whips, arms simulated (limp), left knee falls out; ends supine ~0.65 m behind the start')


def death_fall_forward(rig, built):
    """hit in the back: thrown forward, a half step with the left foot, the knees fold, pitches onto the face"""
    base = start_pose('idle_rifle', 0, built)
    r0 = base[1]
    keys = [
        (0.0, 'start', 'io'),
        (0.08, dict(_start=True, root=r0 + [0, -0.01, 0.05], Hips=(4, -6, 0), LowerBack=(5, 0, 0), Spine=(-4, 0, 0), Spine1=(-8, 0, 0), Neck=(-14, 0, 0), Head=(-12, 0, 0),
                    LeftUpLeg=(-4, 0, 0), RightUpLeg=(-2, 0, 0), LeftLeg=(6, 0, 0), RightLeg=(6, 0, 0)), 'out'),
        (0.30, dict(root=r0 + [0.0, -0.08, 0.22], Hips=(14, -4, 0), LowerBack=(8, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(-6, 0, 0), Head=(-8, 0, 0),
                    LeftUpLeg=(-36, 0, 0), LeftLeg=(30, 0, 0), LeftFoot=(-10, 0, 0), RightUpLeg=(12, 0, 0), RightLeg=(20, 0, 0), RightFoot=(10, 0, 0)), 'io'),
        (0.50, dict(root=r0 + [0.0, -0.36, 0.40], Hips=(34, -4, 0), LowerBack=(10, 0, 0), Spine=(10, 0, 0), Spine1=(8, 0, 0), Neck=(-4, 0, 0), Head=(-6, 0, 0),
                    LeftUpLeg=(-70, 0, 4), LeftLeg=(100, 0, 0), LeftFoot=(-14, 0, 0), RightUpLeg=(-20, 0, -2), RightLeg=(95, 0, 0), RightFoot=(30, 0, 0)), 'in'),
        (0.64, dict(root=r0 + [0.0, -0.52, 0.55], Hips=(55, -4, 0), LowerBack=(8, 0, 0), Spine=(8, 0, 0), Spine1=(6, 0, 0), Neck=(-8, 0, 0), Head=(-8, 10, 0),
                    LeftUpLeg=(-62, 0, 6), LeftLeg=(105, 0, 0), LeftFoot=(10, 0, 0), RightUpLeg=(-30, 0, -4), RightLeg=(105, 0, 0), RightFoot=(40, 0, 0)), 'in'),
        (0.84, dict(root=np.array([0.02, 0.16, r0[2] + 0.92]), Hips=(86, -4, 4), LowerBack=(-2, 0, 0), Spine=(-4, 0, 0), Spine1=(-4, 0, 0), Neck=(-14, 20, 0), Head=(-10, 30, 0),
                    LeftUpLeg=(-30, 0, 10), LeftLeg=(60, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-6, 0, -6), RightLeg=(40, 0, 0), RightFoot=(45, 0, 0)), 'in'),
        (0.96, dict(root=np.array([0.02, 0.17, r0[2] + 0.96]), Hips=(84, -4, 4), LowerBack=(-4, 0, 0), Spine=(-5, 0, 0), Spine1=(-4, 0, 0), Neck=(-14, 28, 0), Head=(-12, 38, 0),
                    LeftUpLeg=(-34, -4, 22), LeftLeg=(62, 0, 0), LeftFoot=(36, 0, 0), RightUpLeg=(-2, 4, -6), RightLeg=(20, 0, 0), RightFoot=(50, 0, 0)), 'out'),
        (1.4, prone_rest([0.02, 0.15, r0[2] + 0.97], yaw=-4, roll=4, head_turn=68), 'io'),
        (2.1, prone_rest([0.02, 0.15, r0[2] + 0.97], yaw=-4, roll=4, head_turn=70), 'io'),
    ]
    plant = [('Right', 0.0, 0.42, None), ('Left', 0.0, 0.10, None), ('Left', 0.30, 0.56, (0.13, 0.42, -8))]
    return build(rig, 'death_fall_forward', keys, 2.1, base, plant=plant, hold=0.14, t_ground=0.84, t_ragdoll=0.84,
                 kick={'Left': (0.2, -0.3, -0.5), 'Right': (-0.2, -0.3, -0.5)},
                 notes='hit from BEHIND: thrown forward, half step with the left foot, knees fold, pitches onto the face (0.84 s) without '
                       'catching himself, head turned; ends prone ~1 m ahead')


def death_spin(rig, built, side='R'):
    """hit from the right side: the right shoulder is knocked back, he twists round to his right (~110 deg) on the left foot,
    the legs fold and he goes down onto his right side / back.  side 'L' = mirror"""
    base = start_pose('idle_rifle', 0, built)
    r0 = base[1]
    keys = [
        (0.0, 'start', 'io'),
        (0.08, dict(_start=True, root=r0 + [0.02, -0.01, 0.0], Hips=(-2, -14, 2), LowerBack=(-2, -6, 0), Spine=(-4, -10, 4), Spine1=(-6, -12, 6), Neck=(6, 6, 0), Head=(4, 8, -4),
                    LeftUpLeg=(-4, 0, 0), LeftLeg=(6, 0, 0), RightUpLeg=(-2, 0, 0), RightLeg=(6, 0, 0)), 'out'),
        (0.34, dict(root=r0 + [0.04, -0.12, -0.04], Hips=(6, -60, 6), LowerBack=(4, -10, 2), Spine=(4, -12, 4), Spine1=(4, -10, 4), Neck=(6, 8, 0), Head=(6, 10, 0),
                    LeftUpLeg=(-20, 30, 0), LeftLeg=(34, 0, 0), LeftFoot=(-6, 0, 0), RightUpLeg=(-28, 4, -10), RightLeg=(40, 0, 0), RightFoot=(-4, 0, 0)), 'io'),
        (0.56, dict(root=r0 + [0.04, -0.44, -0.14], Hips=(22, -100, 14), LowerBack=(8, -6, 4), Spine=(8, -6, 4), Spine1=(6, -6, 4), Neck=(10, 4, 0), Head=(8, 8, 0),
                    LeftUpLeg=(-62, 46, 8), LeftLeg=(100, 0, 0), LeftFoot=(-8, 0, 0), RightUpLeg=(-50, 0, -16), RightLeg=(92, 0, 0), RightFoot=(-6, 0, 0)), 'in'),
        (0.74, dict(root=np.array([-0.08, 0.22, r0[2] - 0.30]), Hips=(26, -118, 62), LowerBack=(8, 0, 4), Spine=(8, 0, 4), Spine1=(8, 0, 4), Neck=(10, 0, 8), Head=(8, 6, 10),
                    LeftUpLeg=(-58, 36, 6), LeftLeg=(90, 0, 0), LeftFoot=(10, 0, 0), RightUpLeg=(-46, 0, -6), RightLeg=(80, 0, 0), RightFoot=(10, 0, 0)), 'in'),
        (0.92, dict(root=np.array([-0.24, 0.15, r0[2] - 0.38]), Hips=(-10, -124, 92), LowerBack=(4, 0, 0), Spine=(4, 0, 0), Spine1=(4, 0, 0), Neck=(6, 0, 18), Head=(4, 4, 22),
                    LeftUpLeg=(-52, 30, 4), LeftLeg=(74, 0, 0), LeftFoot=(20, 0, 0), RightUpLeg=(-34, 0, -2), RightLeg=(58, 0, 0), RightFoot=(20, 0, 0)), 'in'),
        (1.08, dict(root=np.array([-0.30, 0.13, r0[2] - 0.40]), Hips=(-55, -126, 70), LowerBack=(3, 0, 0), Spine=(4, 0, 0), Spine1=(3, 0, 0), Neck=(4, 10, 10), Head=(0, 20, 8),
                    LeftUpLeg=(-46, 30, 10), LeftLeg=(70, 0, 0), LeftFoot=(18, 0, 0), RightUpLeg=(-26, -4, -2), RightLeg=(44, 0, 0), RightFoot=(20, -10, 0)), 'io'),
        (1.6, _merge(supine([-0.32, 0.12, r0[2] - 0.40], yaw=-126, roll=40, head_turn=-30, legs='bent_L'), LowerBack=(3, 0, 0)), 'io'),
        (2.2, _merge(supine([-0.32, 0.12, r0[2] - 0.40], yaw=-126, roll=40, head_turn=-34, legs='bent_L'), LowerBack=(3, 0, 0)), 'io'),
    ]
    plant = [('Left', 0.0, 0.62, None), ('Right', 0.0, 0.10, None), ('Right', 0.30, 0.52, (-0.05, -0.20, -70))]
    name = 'death_spin_' + side
    return build(rig, name, keys, 2.2, base, plant=plant, hold=0.12, t_ground=0.74, t_ragdoll=0.92, mirror=(side == 'L'),
                 kick={'Right': (-0.8, -0.2, -0.6), 'Left': (0.6, -0.2, 0.8)},
                 notes=f'hit from the {"RIGHT" if side == "R" else "LEFT"} side: the {"right" if side == "R" else "left"} shoulder is knocked back, he spins ~120 deg toward '
                       f'the hit on the {"left" if side == "R" else "right"} foot, the legs fold and he drops onto the {"right" if side == "R" else "left"} hip and rolls onto the back'
                       + ('' if side == 'R' else ' (mirror of death_spin_R)'))


def death_sit_slump(rig, built):
    """gut shot from the front: doubles over, knees go, sits down on the backside, sits slumped a moment, then sags over
    sideways onto the left side"""
    base = start_pose('idle_rifle', 0, built)
    r0 = base[1]
    sit = dict(root=np.array([0.0, 0.12, r0[2] - 0.30]), Hips=(-26, -4, 0), LowerBack=(8, 0, 0), Spine=(9, 0, 0), Spine1=(7, 0, 0), Neck=(14, 0, 0), Head=(10, 0, 0),
               LeftUpLeg=(-64, 8, 10), LeftLeg=(70, 0, 0), LeftFoot=(-16, 0, 0), RightUpLeg=(-58, -6, -8), RightLeg=(56, 0, 0), RightFoot=(-14, 0, 0))
    keys = [
        (0.0, 'start', 'io'),
        (0.10, dict(_start=True, root=r0 + [0, -0.03, -0.03], Hips=(-4, -6, 0), LowerBack=(8, 0, 0), Spine=(12, 2, 0), Spine1=(10, 2, 0), Neck=(6, 0, 0), Head=(4, 0, 0),
                    LeftUpLeg=(-6, 0, 0), LeftLeg=(12, 0, 0), RightUpLeg=(-6, 0, 0), RightLeg=(12, 0, 0)), 'out'),
        (0.42, dict(root=r0 + [0, -0.22, -0.10], Hips=(4, -6, 0), LowerBack=(14, 0, 0), Spine=(18, 0, 0), Spine1=(14, 0, 0), Neck=(10, 0, 0), Head=(8, 0, 0),
                    LeftUpLeg=(-46, 4, 4), LeftLeg=(64, 0, 0), LeftFoot=(-14, 0, 0), RightUpLeg=(-44, -2, -4), RightLeg=(62, 0, 0), RightFoot=(-14, 0, 0)), 'io'),
        (0.68, dict(root=r0 + [0, -0.55, -0.22], Hips=(-6, -6, 0), LowerBack=(14, 0, 0), Spine=(16, 0, 0), Spine1=(14, 0, 0), Neck=(12, 0, 0), Head=(10, 0, 0),
                    LeftUpLeg=(-86, 6, 8), LeftLeg=(118, 0, 0), LeftFoot=(-24, 0, 0), RightUpLeg=(-84, -4, -6), RightLeg=(116, 0, 0), RightFoot=(-24, 0, 0)), 'in'),
        (0.84, _merge(sit, root=sit['root'] + [0, -0.01, 0.02], Hips=(-12, -4, 0), LeftUpLeg=(-74, 8, 10), LeftLeg=(96, 0, 0), RightUpLeg=(-70, -6, -8), RightLeg=(90, 0, 0)), 'in'),
        (0.96, _merge(sit, Hips=(-30, -4, 0), LowerBack=(6, 0, 0), Spine=(7, 0, 0), Neck=(8, 0, 0), Head=(4, 0, 0)), 'out'),
        (1.22, _merge(sit, Neck=(26, 0, 0), Head=(20, 0, 6)), 'io'),
        (1.7, _merge(sit, Hips=(-22, -4, -8), LowerBack=(10, 0, -4), Spine=(12, 0, -6), Spine1=(10, 0, -6), Neck=(28, 0, -6), Head=(22, 0, 0)), 'io'),
        (2.16, dict(root=np.array([0.10, 0.17, r0[2] - 0.24]), Hips=(-6, -10, -70), LowerBack=(14, 0, -4), Spine=(14, 0, -2), Spine1=(10, 0, 0), Neck=(8, 0, -14), Head=(4, 6, -18),
                    LeftUpLeg=(-66, 10, 10), LeftLeg=(76, 0, 0), LeftFoot=(10, 0, 0), RightUpLeg=(-60, -8, -2), RightLeg=(70, 0, 0), RightFoot=(10, 0, 0)), 'in'),
        (2.32, dict(root=np.array([0.11, 0.17, r0[2] - 0.24]), Hips=(-4, -10, -84), LowerBack=(12, 0, 0), Spine=(12, 0, 2), Spine1=(10, 0, 2), Neck=(8, 0, -18), Head=(2, 8, -24),
                    LeftUpLeg=(-62, 10, 8), LeftLeg=(74, 0, 0), LeftFoot=(20, 0, 0), RightUpLeg=(-54, -6, 0), RightLeg=(62, 0, 0), RightFoot=(20, 0, 0)), 'out'),
        (3.0, dict(root=np.array([0.11, 0.17, r0[2] - 0.24]), Hips=(-4, -10, -86), LowerBack=(12, 0, 0), Spine=(12, 0, 2), Spine1=(10, 0, 2), Neck=(8, 0, -20), Head=(2, 8, -26),
                   LeftUpLeg=(-62, 10, 8), LeftLeg=(76, 0, 0), LeftFoot=(22, 0, 0), RightUpLeg=(-52, -6, 0), RightLeg=(66, 0, 0), RightFoot=(24, 0, 0)), 'io'),
    ]
    plant = [('Left', 0.0, 1.9, None), ('Right', 0.0, 1.9, None)]
    return build(rig, 'death_sit_slump', keys, 3.0, base, plant=plant, hold=0.22, t_ground=0.84, t_ragdoll=2.16, arm_stiff=0.0,
                 kick={'Left': (0.0, -0.3, 0.2), 'Right': (0.0, -0.3, 0.2)},
                 notes='hit from the FRONT (gut): doubles over, knees go, sits down on the backside (0.84 s) with the feet planted, sits slumped, '
                       'head drops, then sags over onto the left side (2.2 s)')


def death_knees(rig, built):
    """legs go first: drops straight onto both knees, kneels slack for a beat, then topples forward onto the face/left side"""
    base = start_pose('idle_rifle', 0, built)
    r0 = base[1]
    kneel = dict(root=np.array([0.0, 0.56, r0[2] - 0.02]), Hips=(10, -6, 0), LowerBack=(8, 0, 0), Spine=(10, 0, 0), Spine1=(8, 0, 0), Neck=(16, 0, 0), Head=(12, 0, 0),
                 LeftUpLeg=(-14, 0, 6), LeftLeg=(98, 0, 0), LeftFoot=(40, 0, 0), RightUpLeg=(-14, 0, -6), RightLeg=(98, 0, 0), RightFoot=(40, 0, 0))
    keys = [
        (0.0, 'start', 'io'),
        (0.08, dict(_start=True, root=r0 + [0, -0.02, -0.01], Hips=(-3, -6, 0), Spine=(-4, 0, 0), Spine1=(-6, 0, 0), Head=(-8, 0, 0),
                    LeftUpLeg=(-6, 0, 0), LeftLeg=(12, 0, 0), RightUpLeg=(-6, 0, 0), RightLeg=(12, 0, 0)), 'out'),
        (0.30, dict(root=r0 + [0, -0.22, 0.02], Hips=(4, -6, 0), LowerBack=(4, 0, 0), Spine=(4, 0, 0), Spine1=(4, 0, 0), Neck=(6, 0, 0), Head=(6, 0, 0),
                    LeftUpLeg=(-34, 0, 4), LeftLeg=(64, 0, 0), LeftFoot=(-10, 0, 0), RightUpLeg=(-34, 0, -4), RightLeg=(64, 0, 0), RightFoot=(-10, 0, 0)), 'in'),
        (0.46, _merge(kneel, root=kneel['root'] + [0, -0.02, 0.0], Hips=(14, -6, 0), Neck=(20, 0, 0), Head=(16, 0, 0)), 'in'),
        (0.58, _merge(kneel, root=kneel['root'] + [0, 0.01, 0.0], Hips=(8, -6, 0)), 'out'),
        (0.95, _merge(kneel, Hips=(16, -6, -4), LowerBack=(10, 0, 0), Spine=(12, 0, 0), Neck=(28, 0, 0), Head=(20, 0, 4)), 'io'),
        (1.20, _merge(kneel, root=kneel['root'] + [0.03, -0.06, 0.14], Hips=(40, -8, -12), Neck=(20, 0, 0), Head=(10, 10, 0),
                      LeftUpLeg=(-30, 0, 8), RightUpLeg=(-26, 0, -4), LeftLeg=(100, 0, 0), RightLeg=(100, 0, 0)), 'in'),
        (1.40, dict(root=np.array([0.06, 0.26, r0[2] + 0.42]), Hips=(70, -10, -22), LowerBack=(4, 0, 0), Spine=(2, 0, 0), Spine1=(0, 0, 0), Neck=(-4, 20, 0), Head=(-8, 30, 0),
                    LeftUpLeg=(-50, 0, 12), LeftLeg=(104, 0, 0), LeftFoot=(40, 0, 0), RightUpLeg=(-44, 0, -4), RightLeg=(104, 0, 0), RightFoot=(40, 0, 0)), 'in'),
        (1.54, dict(root=np.array([0.08, 0.17, r0[2] + 0.62]), Hips=(84, -10, -30), LowerBack=(-2, 0, 0), Spine=(-4, 0, 0), Spine1=(-4, 0, 0), Neck=(-12, 34, 0), Head=(-10, 40, 0),
                    LeftUpLeg=(-42, 0, 16), LeftLeg=(92, 0, 0), LeftFoot=(40, 0, 0), RightUpLeg=(-30, 0, -6), RightLeg=(84, 0, 0), RightFoot=(40, 0, 0)), 'in'),
        (1.68, dict(root=np.array([0.08, 0.18, r0[2] + 0.64]), Hips=(82, -10, -32), LowerBack=(-3, 0, 0), Spine=(-4, 0, 0), Spine1=(-4, 0, 0), Neck=(-12, 38, 0), Head=(-10, 44, 0),
                    LeftUpLeg=(-38, 0, 16), LeftLeg=(80, 0, 0), LeftFoot=(40, 0, 0), RightUpLeg=(-20, 0, -6), RightLeg=(60, 0, 0), RightFoot=(45, 0, 0)), 'out'),
        (2.2, dict(root=np.array([0.08, 0.17, r0[2] + 0.64]), Hips=(84, -10, -34), LowerBack=(-3, 0, 0), Spine=(-4, 0, 0), Spine1=(-4, 0, 0), Neck=(-12, 38, 0), Head=(-10, 46, 0),
                   LeftUpLeg=(-18, 40, 20), LeftLeg=(28, 0, 0), LeftFoot=(32, 0, 0), RightUpLeg=(-4, -40, -6), RightLeg=(10, 0, 0), RightFoot=(32, 0, 0)), 'io'),
        (2.8, dict(root=np.array([0.08, 0.17, r0[2] + 0.64]), Hips=(84, -10, -34), LowerBack=(-3, 0, 0), Spine=(-4, 0, 0), Spine1=(-4, 0, 0), Neck=(-12, 38, 0), Head=(-10, 47, 0),
                   LeftUpLeg=(-18, 42, 20), LeftLeg=(26, 0, 0), LeftFoot=(32, 0, 0), RightUpLeg=(-4, -42, -6), RightLeg=(8, 0, 0), RightFoot=(32, 0, 0)), 'io'),
    ]
    plant = []
    return build(rig, 'death_knees', keys, 2.8, base, plant=plant, hold=0.18, t_ground=1.54, t_ragdoll=1.54, knee_r=0.05,
                 kick={'Left': (0.1, -0.3, 0.0), 'Right': (-0.1, -0.3, 0.0)},
                 notes='legs go first: drops onto both knees (0.46 s), kneels slack with the head sagging, then topples forward onto the face '
                       '/ left shoulder (1.54 s)')


def death_headshot(rig, built):
    """instant drop: every muscle lets go at once - the knees fold straight down, the trunk drops onto the folded legs and
    tips back/left; no reaction, no step"""
    base = start_pose('idle_rifle', 0, built)
    r0 = base[1]
    keys = [
        (0.0, 'start', 'io'),
        (0.05, dict(_start=True, root=r0 + [0, -0.01, -0.02], Hips=(-2, -6, 0), Neck=(-10, 0, 0), Head=(-14, 0, 0), Spine1=(-3, 0, 0),
                    LeftLeg=(6, 0, 0), RightLeg=(6, 0, 0)), 'out'),
        (0.22, dict(root=r0 + [0.0, -0.36, -0.08], Hips=(2, -6, -3), LowerBack=(6, 0, 0), Spine=(8, 0, 0), Spine1=(8, 0, 0), Neck=(10, 0, 0), Head=(10, 0, 0),
                    LeftUpLeg=(-56, 6, 6), LeftLeg=(100, 0, 0), LeftFoot=(-24, 0, 0), RightUpLeg=(-52, -4, -6), RightLeg=(98, 0, 0), RightFoot=(-24, 0, 0)), 'in'),
        (0.38, dict(root=np.array([0.04, 0.13, r0[2] - 0.34]), Hips=(-22, -8, -8), LowerBack=(12, 0, 0), Spine=(12, 0, 0), Spine1=(10, 0, 0), Neck=(18, 0, 0), Head=(12, 0, 0),
                    LeftUpLeg=(-92, 12, 14), LeftLeg=(128, 0, 0), LeftFoot=(-20, 0, 0), RightUpLeg=(-86, -8, -12), RightLeg=(124, 0, 0), RightFoot=(-20, 0, 0)), 'in'),
        (0.46, dict(root=np.array([0.05, 0.14, r0[2] - 0.35]), Hips=(-30, -9, -12), LowerBack=(12, 0, 0), Spine=(12, 0, 0), Spine1=(10, 0, 0), Neck=(22, 0, 0), Head=(14, 2, 0),
                    LeftUpLeg=(-84, 14, 18), LeftLeg=(120, 0, 0), LeftFoot=(-14, 0, 0), RightUpLeg=(-80, -8, -12), RightLeg=(116, 0, 0), RightFoot=(-14, 0, 0)), 'out'),
        (0.76, dict(root=np.array([0.10, 0.14, r0[2] - 0.40]), Hips=(-74, -14, -40), LowerBack=(4, 0, 0), Spine=(4, 0, 0), Spine1=(4, 0, 0), Neck=(14, 0, -6), Head=(6, 10, -10),
                    LeftUpLeg=(-66, 22, 26), LeftLeg=(110, 0, 0), LeftFoot=(20, 0, 0), RightUpLeg=(-56, -10, -8), RightLeg=(104, 0, 0), RightFoot=(20, 0, 0)), 'in'),
        (0.88, dict(root=np.array([0.12, 0.13, r0[2] - 0.42]), Hips=(-82, -16, -44), LowerBack=(3, 0, 0), Spine=(4, 0, 0), Spine1=(3, 0, 0), Neck=(6, 6, -6), Head=(0, 20, -10),
                    LeftUpLeg=(-56, 26, 30), LeftLeg=(100, 0, 0), LeftFoot=(26, 0, 0), RightUpLeg=(-46, -10, -6), RightLeg=(92, 0, 0), RightFoot=(26, 0, 0)), 'out'),
        (1.3, dict(root=np.array([0.12, 0.13, r0[2] - 0.42]), Hips=(-82, -16, -46), LowerBack=(3, 0, 0), Spine=(4, 0, 0), Spine1=(3, 0, 0), Neck=(6, 8, -6), Head=(0, 26, -10),
                   LeftUpLeg=(-48, 28, 34), LeftLeg=(92, 0, 0), LeftFoot=(26, 0, 0), RightUpLeg=(-36, -10, -6), RightLeg=(80, 0, 0), RightFoot=(26, 0, 0)), 'io'),
        (1.7, dict(root=np.array([0.12, 0.13, r0[2] - 0.42]), Hips=(-82, -16, -46), LowerBack=(3, 0, 0), Spine=(4, 0, 0), Spine1=(3, 0, 0), Neck=(6, 8, -6), Head=(0, 27, -10),
                   LeftUpLeg=(-46, 28, 36), LeftLeg=(90, 0, 0), LeftFoot=(26, 0, 0), RightUpLeg=(-34, -10, -6), RightLeg=(78, 0, 0), RightFoot=(26, 0, 0)), 'io'),
    ]
    plant = [('Left', 0.0, 0.30, None), ('Right', 0.0, 0.30, None)]
    return build(rig, 'death_headshot', keys, 1.7, base, plant=plant, hold=0.06, t_ground=0.38, t_ragdoll=0.46, head=(0.05, 0.07),
                 notes='HEADSHOT / instant kill: no reaction - head snaps back, every muscle lets go, the knees fold straight down, '
                       'he drops onto his backside behind the heels (0.38 s) and tips back onto the left shoulder; rifle drops at once')


def death_run(rig, built):
    """shot while running: the upper body lurches, one more stumbling stride, the legs give, momentum pitches him forward
    onto his chest and he slides to a stop"""
    base = start_pose('run_rifle', 0, built)
    r0 = base[1]
    v = 3.6        # m/s at the start (run_rifle ground speed ~3.9)
    keys = [
        (0.0, 'start', 'io'),
        (0.10, dict(_start=True, root=np.array([0, r0[1] - 0.02, v * 0.10]), Hips=(14, 0, 0), LowerBack=(10, 0, 0), Spine=(6, 4, 0), Spine1=(2, 4, 0), Neck=(-10, 0, 0), Head=(-10, 0, 0)), 'lin'),
        (0.30, dict(root=np.array([0.0, 0.80, 0.98]), Hips=(24, -4, 0), LowerBack=(10, 0, 0), Spine=(8, 0, 0), Spine1=(6, 0, 0), Neck=(-10, 0, 0), Head=(-10, 0, 0),
                    LeftUpLeg=(-50, 0, 2), LeftLeg=(40, 0, 0), LeftFoot=(-14, 0, 0), RightUpLeg=(20, 0, -2), RightLeg=(60, 0, 0), RightFoot=(20, 0, 0)), 'lin'),
        (0.48, dict(root=np.array([0.0, 0.66, 1.58]), Hips=(38, -4, 2), LowerBack=(10, 0, 0), Spine=(8, 0, 0), Spine1=(6, 0, 0), Neck=(-10, 0, 0), Head=(-8, 0, 0),
                    LeftUpLeg=(-8, 0, 2), LeftLeg=(70, 0, 0), LeftFoot=(10, 0, 0), RightUpLeg=(-74, 0, -2), RightLeg=(100, 0, 0), RightFoot=(-10, 0, 0)), 'lin'),
        (0.62, dict(root=np.array([0.02, 0.44, 1.98]), Hips=(62, -4, 4), LowerBack=(8, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(-14, 0, 0), Head=(-10, 10, 0),
                    LeftUpLeg=(-16, 0, 6), LeftLeg=(96, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-60, 0, -4), RightLeg=(110, 0, 0), RightFoot=(10, 0, 0)), 'in'),
        (0.76, dict(root=np.array([0.03, 0.17, 2.42]), Hips=(88, -4, 6), LowerBack=(-4, 0, 0), Spine=(-6, 0, 0), Spine1=(-6, 0, 0), Neck=(-16, 24, 0), Head=(-12, 32, 0),
                    LeftUpLeg=(-6, 0, 8), LeftLeg=(44, 0, 0), LeftFoot=(40, 0, 0), RightUpLeg=(-26, 0, -6), RightLeg=(60, 0, 0), RightFoot=(40, 0, 0)), 'in'),
        (1.10, dict(root=np.array([0.04, 0.16, 2.86]), Hips=(86, -4, 6), LowerBack=(-4, 0, 0), Spine=(-5, 0, 0), Spine1=(-5, 0, 0), Neck=(-14, 34, 0), Head=(-10, 40, 0),
                    LeftUpLeg=(-4, -4, 10), LeftLeg=(20, 0, 0), LeftFoot=(50, 0, 0), RightUpLeg=(-10, 4, -8), RightLeg=(30, 0, 0), RightFoot=(50, 0, 0)), 'out'),
        (1.6, prone_rest([0.04, 0.15, 2.92], yaw=-4, roll=6, head_turn=66, legs='straight'), 'io'),
        (2.2, prone_rest([0.04, 0.15, 2.92], yaw=-4, roll=6, head_turn=68, legs='straight'), 'io'),
    ]
    plant = [('Right', 0.0, 0.05, None), ('Left', 0.18, 0.36, (0.10, 0.85, -4)), ('Right', 0.40, 0.58, (-0.10, 1.55, 4))]
    return build(rig, 'death_run', keys, 2.2, base, plant=plant, hold=0.12, t_ground=0.76, t_ragdoll=0.76, heels=True,
                 kick={'Left': (0.2, -0.2, 0.8), 'Right': (-0.2, -0.2, 0.8)},
                 notes='shot while RUNNING: lurches, one more stumbling stride (feet planted on their contacts), legs give, momentum carries him '
                       'onto his chest (0.76 s) and he slides ~0.5 m to a stop; root travels ~2.9 m forward (+Z)')


def death_crouch(rig, built):
    """shot while kneeling (aim_crouch): jerks, sags back onto the right heel, then keels over onto the left side"""
    base = start_pose('aim_crouch', 0, built)
    r0 = base[1]
    keys = [
        (0.0, 'start', 'io'),
        (0.08, dict(_start=True, root=r0 + [0, 0.0, -0.03], Spine=(-6, 0, 0), Spine1=(-8, 0, 0), Neck=(8, 0, 0), Head=(6, 0, 0)), 'out'),
        (0.36, dict(_start=True, root=r0 + [0.0, -0.10, -0.08], Hips=(8, -14, -6), LowerBack=(10, 0, 0), Spine=(10, 0, 0), Spine1=(8, 0, 0), Neck=(18, 0, 0), Head=(10, 0, 0)), 'in'),
        (0.60, dict(_start=True, root=r0 + [0.10, -0.20, -0.04], Hips=(14, -20, -40), LowerBack=(8, 0, -6), Spine=(10, 0, -6), Spine1=(8, 0, -6), Neck=(16, 0, -6), Head=(8, 6, 0)), 'in'),
        (0.82, dict(root=np.array([0.22, 0.17, r0[2] + 0.02]), Hips=(18, -24, -82), LowerBack=(8, 0, 0), Spine=(10, 0, 0), Spine1=(8, 0, 0), Neck=(10, 0, -12), Head=(4, 10, -16),
                    LeftUpLeg=(-60, 0, 8), LeftLeg=(100, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-40, 0, -4), RightLeg=(110, 0, 0), RightFoot=(30, 0, 0)), 'in'),
        (0.96, dict(root=np.array([0.23, 0.18, r0[2] + 0.03]), Hips=(16, -24, -86), LowerBack=(8, 0, 0), Spine=(10, 0, 0), Spine1=(8, 0, 0), Neck=(10, 0, -16), Head=(4, 12, -20),
                    LeftUpLeg=(-58, 0, 8), LeftLeg=(92, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-44, 0, -4), RightLeg=(96, 0, 0), RightFoot=(30, 0, 0)), 'out'),
        (1.5, dict(root=np.array([0.23, 0.17, r0[2] + 0.03]), Hips=(16, -24, -88), LowerBack=(8, 0, 0), Spine=(10, 0, 0), Spine1=(8, 0, 0), Neck=(10, 0, -18), Head=(4, 12, -22),
                   LeftUpLeg=(-56, 0, 8), LeftLeg=(86, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-40, 0, -4), RightLeg=(84, 0, 0), RightFoot=(32, 0, 0)), 'io'),
        (2.0, dict(root=np.array([0.23, 0.17, r0[2] + 0.03]), Hips=(16, -24, -88), LowerBack=(8, 0, 0), Spine=(10, 0, 0), Spine1=(8, 0, 0), Neck=(10, 0, -18), Head=(4, 12, -23),
                   LeftUpLeg=(-56, 0, 8), LeftLeg=(86, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-40, 0, -4), RightLeg=(84, 0, 0), RightFoot=(32, 0, 0)), 'io'),
    ]
    plant = [('Left', 0.0, 0.40, None)]
    return build(rig, 'death_crouch', keys, 2.0, base, plant=plant, hold=0.14, t_ground=0.82, t_ragdoll=0.82, knee_r=0.045,
                 notes='shot while KNEELING (aim_crouch): jerks, sags back onto the right heel, keels over onto the left side (0.82 s), '
                       'legs stay folded')


def death_prone(rig, built):
    """shot while prone (aim_prone): a jolt through the body, the head drops onto the ground, arms slacken, one leg draws up"""
    base = start_pose('aim_prone', 0, built)
    r0 = base[1]
    keys = [
        (0.0, 'start', 'io'),
        (0.07, dict(_start=True, root=r0 + [0, 0.02, -0.02], Spine=(-4, 0, 0), Spine1=(-6, 0, 0), Neck=(-10, 0, 0), Head=(-6, 0, 0)), 'out'),
        (0.40, dict(_start=True, root=r0 + [0.0, 0.0, -0.03], Hips=(88, 0, 4), Spine=(-2, 0, 0), Spine1=(-2, 0, 0), Neck=(-4, 30, 0), Head=(-6, 36, 0)), 'in'),
        (0.55, dict(_start=True, root=r0 + [0.0, 0.0, -0.03], Hips=(88, 0, 5), Neck=(-6, 34, 0), Head=(-8, 42, 0)), 'out'),
        (1.2, _merge(prone_rest(r0 + [0.0, 0.0, -0.03], yaw=0, roll=5, head_turn=62, legs='L_up')), 'io'),
        (1.7, _merge(prone_rest(r0 + [0.0, 0.0, -0.03], yaw=0, roll=5, head_turn=64, legs='L_up')), 'io'),
    ]
    return build(rig, 'death_prone', keys, 1.7, base, plant=(), hold=0.10, t_ground=0.0, t_ragdoll=0.4, arm_stiff=0.0,
                 notes='shot while PRONE (aim_prone): jolt, the head drops onto the ground turned to the side, arms go slack off the rifle, '
                       'the left knee draws up; ends prone in place')


def death_window_slump(rig, built):
    """at a window (kneeling behind the sill, aim_crouch): hit, slumps forward against the wall under the sill, the head and
    one arm hang over the sill"""
    base = start_pose('aim_crouch', 0, built)
    r0 = base[1]
    keys = [
        (0.0, 'start', 'io'),
        (0.08, dict(_start=True, root=r0 + [0, 0.0, -0.03], Spine=(-6, 0, 0), Spine1=(-8, 0, 0), Neck=(10, 0, 0), Head=(6, 0, 0)), 'out'),
        (0.40, dict(_start=True, root=r0 + [0.0, -0.04, 0.10], Hips=(26, -10, 0), LowerBack=(10, 0, 0), Spine=(12, 0, 0), Spine1=(10, 0, 0), Neck=(20, 0, 0), Head=(14, 0, 0)), 'in'),
        (0.62, dict(_start=True, root=r0 + [0.0, -0.08, 0.20], Hips=(40, -10, 4), LowerBack=(14, 0, 0), Spine=(16, 0, 0), Spine1=(12, 0, 0), Neck=(30, 0, 0), Head=(20, 6, 0)), 'in'),
        (0.74, dict(_start=True, root=r0 + [0.0, -0.10, 0.22], Hips=(38, -10, 6), LowerBack=(12, 0, 0), Spine=(14, 0, 0), Spine1=(10, 0, 0), Neck=(36, 0, 0), Head=(24, 10, 0)), 'out'),
        (1.30, dict(_start=True, root=r0 + [0.02, -0.22, 0.20], Hips=(36, -12, 10), LowerBack=(12, 0, 2), Spine=(12, 0, 2), Spine1=(10, 0, 2), Neck=(38, 0, 0), Head=(26, 14, 4)), 'io'),
        (2.2, dict(_start=True, root=r0 + [0.02, -0.24, 0.20], Hips=(36, -12, 10), LowerBack=(12, 0, 2), Spine=(12, 0, 2), Spine1=(10, 0, 2), Neck=(38, 0, 0), Head=(26, 15, 4)), 'io'),
    ]
    plant = [('Left', 0.0, 9, None)]
    return build(rig, 'death_window_slump', keys, 2.2, base, plant=plant, hold=0.12, t_ground=None, t_ragdoll=None, wall=True, knee_r=0.045,
                 notes=f'BUILDING window, kneeling behind the sill (inner wall face z = {WALL_Z} m ahead of the root, sill {SILL_Y} m): hit, slumps '
                       'forward against the wall, chest and face on the wall / sill, arms hanging; stays kneeling slumped (no ragdoll)',
                 events=dict(ragdoll=-1, wall_z=WALL_Z, sill_y=SILL_Y))


def death_window_back(rig, built):
    """at a window (kneeling, aim_crouch): knocked back into the room, sits back and falls onto the back away from the window"""
    base = start_pose('aim_crouch', 0, built)
    r0 = base[1]
    keys = [
        (0.0, 'start', 'io'),
        (0.08, dict(_start=True, root=r0 + [0, 0.02, -0.05], Hips=(-6, -14, 0), Spine=(-10, 4, 0), Spine1=(-12, 4, 0), Neck=(12, 0, 0), Head=(8, 0, 0)), 'out'),
        (0.34, dict(root=r0 + [0.0, -0.18, -0.30], Hips=(-34, -10, 0), LowerBack=(6, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(22, 0, 0), Head=(12, 0, 0),
                    LeftUpLeg=(-80, 6, 8), LeftLeg=(100, 0, 0), LeftFoot=(-10, 0, 0), RightUpLeg=(-62, -10, -14), RightLeg=(96, 0, 0), RightFoot=(10, 0, 0)), 'in'),
        (0.50, dict(root=np.array([0.02, 0.15, r0[2] - 0.46]), Hips=(-52, -10, 0), LowerBack=(6, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(26, 0, 0), Head=(14, 0, 0),
                    LeftUpLeg=(-62, 8, 10), LeftLeg=(80, 0, 0), LeftFoot=(-10, 0, 0), RightUpLeg=(-52, -8, -10), RightLeg=(84, 0, 0), RightFoot=(14, 0, 0)), 'in'),
        (0.74, dict(root=np.array([0.02, 0.13, r0[2] - 0.58]), Hips=(-86, -10, 2), LowerBack=(4, 0, 0), Spine=(5, 0, 0), Spine1=(4, 0, 0), Neck=(24, 0, 0), Head=(10, 0, 0),
                    LeftUpLeg=(-56, 12, 12), LeftLeg=(80, 0, 0), LeftFoot=(0, 0, 0), RightUpLeg=(-30, -8, -8), RightLeg=(80, 0, 0), RightFoot=(20, 0, 0)), 'in'),
        (0.86, _merge(supine([0.02, 0.12, r0[2] - 0.60], yaw=-10, head_turn=12), LeftUpLeg=(-48, 18, 14), LeftLeg=(74, 0, 0), RightUpLeg=(-26, -14, -10), RightLeg=(66, 0, 0), Neck=(10, 4, 0)), 'out'),
        (1.35, supine([0.02, 0.12, r0[2] - 0.62], yaw=-10, head_turn=-32, legs='bent_R'), 'io'),
        (2.0, supine([0.02, 0.12, r0[2] - 0.62], yaw=-10, head_turn=-34, legs='bent_R'), 'io'),
    ]
    plant = [('Left', 0.0, 0.26, None)]
    return build(rig, 'death_window_back', keys, 2.0, base, plant=plant, hold=0.10, t_ground=0.50, t_ragdoll=-1, knee_r=0.045,
                 kick={'Left': (0.3, 0.0, 0.3), 'Right': (-0.3, 0.0, 0.3)},
                 notes='BUILDING window, kneeling: knocked back into the room, sits back hard (0.5 s) and falls onto the back away from the window '
                       '(~0.6 m back), head rolls; play on the floor slab (no ragdoll)',
                 events=dict(ragdoll=-1))


def death_blast(rig, built):
    """blast in front: thrown up and back off the feet, the body folds round the hips in the air, lands on the backside /
    back ~2.6 m away, tumbles over the shoulder half a turn and ends on the side / front"""
    base = start_pose('idle_rifle', 0, built)
    r0 = base[1]
    keys = [
        (0.0, 'start', 'io'),
        (0.06, dict(_start=True, root=r0 + [0, 0.06, -0.10], Hips=(-10, -4, 0), LowerBack=(4, 0, 0), Spine=(8, 0, 0), Spine1=(8, 0, 0), Neck=(16, 0, 0), Head=(12, 0, 0),
                    LeftUpLeg=(-16, 0, 6), LeftLeg=(20, 0, 0), RightUpLeg=(-12, 0, -6), RightLeg=(16, 0, 0)), 'out'),
        (0.22, dict(root=np.array([0.02, 1.30, r0[2] - 0.70]), Hips=(-40, -6, 4), LowerBack=(10, 0, 0), Spine=(12, 0, 0), Spine1=(10, 0, 0), Neck=(26, 0, 0), Head=(18, 0, 0),
                    LeftUpLeg=(-60, 4, 14), LeftLeg=(70, 0, 0), LeftFoot=(20, 0, 0), RightUpLeg=(-50, -4, -12), RightLeg=(56, 0, 0), RightFoot=(20, 0, 0)), 'out'),
        (0.40, dict(root=np.array([0.04, 1.08, r0[2] - 1.50]), Hips=(-92, -8, 8), LowerBack=(12, 0, 0), Spine=(12, 0, 0), Spine1=(10, 0, 0), Neck=(24, 0, 0), Head=(16, 0, 0),
                    LeftUpLeg=(-70, 6, 16), LeftLeg=(60, 0, 0), LeftFoot=(24, 0, 0), RightUpLeg=(-56, -6, -10), RightLeg=(50, 0, 0), RightFoot=(24, 0, 0)), 'lin'),
        (0.62, dict(root=np.array([0.06, 0.30, r0[2] - 2.30]), Hips=(-135, -10, 10), LowerBack=(10, 0, 0), Spine=(12, 0, 0), Spine1=(10, 0, 0), Neck=(16, 0, 0), Head=(10, 0, 0),
                    LeftUpLeg=(-66, 8, 14), LeftLeg=(50, 0, 0), LeftFoot=(24, 0, 0), RightUpLeg=(-50, -8, -10), RightLeg=(40, 0, 0), RightFoot=(24, 0, 0)), 'in'),
        (0.82, dict(root=np.array([0.08, 0.28, r0[2] - 2.60]), Hips=(-195, -10, 20), LowerBack=(12, 0, 0), Spine=(10, 0, 0), Spine1=(8, 0, 0), Neck=(24, 0, 0), Head=(16, 10, 0),
                    LeftUpLeg=(-74, 10, 16), LeftLeg=(70, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-58, -6, -10), RightLeg=(60, 0, 0), RightFoot=(30, 0, 0)), 'lin'),
        (1.02, dict(root=np.array([0.12, 0.22, r0[2] - 2.95]), Hips=(-252, -14, 26), LowerBack=(6, 0, 0), Spine=(4, 0, 0), Spine1=(2, 0, 0), Neck=(-6, 20, 0), Head=(-6, 30, 0),
                    LeftUpLeg=(-40, 10, 20), LeftLeg=(70, 0, 0), LeftFoot=(40, 0, 0), RightUpLeg=(-26, -6, -8), RightLeg=(50, 0, 0), RightFoot=(40, 0, 0)), 'in'),
        (1.18, dict(root=np.array([0.13, 0.16, r0[2] - 3.10]), Hips=(-272, -14, 24), LowerBack=(-2, 0, 0), Spine=(-4, 0, 0), Spine1=(-4, 0, 0), Neck=(-14, 40, 0), Head=(-10, 44, 0),
                    LeftUpLeg=(-20, 8, 20), LeftLeg=(56, 0, 0), LeftFoot=(46, 0, 0), RightUpLeg=(-4, -4, -6), RightLeg=(30, 0, 0), RightFoot=(50, 0, 0)), 'out'),
        (1.7, _merge(prone_rest([0.13, 0.15, r0[2] - 3.12], yaw=180 - 14, roll=24, head_turn=66, legs='L_up'), Hips=(-272, -14, 24)), 'io'),
        (2.3, _merge(prone_rest([0.13, 0.15, r0[2] - 3.12], yaw=180 - 14, roll=24, head_turn=68, legs='L_up'), Hips=(-272, -14, 24)), 'io'),
    ]
    return build(rig, 'death_blast', keys, 2.3, base, plant=[('Left', 0.0, 0.05, None), ('Right', 0.0, 0.05, None)], hold=0.05, t_ground=0.62,
                 t_ragdoll=0.10, head=(0.06, 0.08),
                 kick={'Left': (1.5, 3.0, -2.0), 'Right': (-1.5, 3.0, -2.0)},
                 notes='BLAST in FRONT (turn the man to face the explosion): thrown up and back off the feet (peak ~0.25 s), folds round the hips '
                       'in the air, lands on the backside / back ~2.3 m away (0.62 s), tumbles back over the shoulder and ends face down '
                       '~3.1 m behind the start; ragdoll may take over from 0.1 s with the blast impulse')


def death_bleedout(rig, built):
    """casualty lying on his back (wounded_ground) dies: the hands slide off the wound, the drawn knee falls, the head rolls"""
    base = start_pose('wounded_ground', 0, built)
    lq0, r0 = base
    rest = dict(LowerBack=(3, 0, 0), Spine=(4, 0, 0), Spine1=(3, 0, 0), Neck=(4, 16, 0), Head=(-4, 26, 6),
                LeftUpLeg=(-10, 24, 14), LeftLeg=(18, 0, 0), LeftFoot=(22, 18, 0), RightUpLeg=(-4, -16, -6), RightLeg=(8, 0, 0), RightFoot=(24, -20, 0))
    keys = [
        (0.0, 'start', 'io'),
        (0.5, dict(_start=True, Spine1=(-2, 0, 0), Neck=(-4, 0, 0)), 'io'),
        (1.4, _merge(rest, _start=True, LeftUpLeg=(-14, 26, 16), LeftLeg=(26, 0, 0), Neck=(4, 14, 0), Head=(-2, 22, 4)), 'io'),
        (2.6, _merge(rest, _start=True), 'io'),
    ]
    hq0 = lq0[rig.I['Hips']]

    def keep_hips(lq, root):        # the pelvis keeps the start orientation, rolling 6 deg onto the right as the knee falls
        w = smooth(np.arange(len(lq)) / FPS / 1.6)
        lq[:, rig.I['Hips']] = np.array([qslerp(hq0, qmul(hq0, qeuler(0, 0, 6, order='YXZ')), x) for x in w])
        return lq, root
    return build(rig, 'death_bleedout', keys, 2.6, base, plant=(), hold=0.25, t_ground=0.0, t_ragdoll=-1, head=(0.15, 0.2), post=keep_hips,
                 notes='casualty on his back (wounded_ground) bleeds out: breathing stops, hands slide off the wound, the drawn-up knee falls '
                       'out, the head rolls to the side; in place (no ragdoll)', events=dict(ragdoll=-1))


def death_clips(rig, want, built=None):
    out = {}
    for n, fn in (('death_fall_back', death_fall_back), ('death_sit_slump', death_sit_slump), ('death_fall_forward', death_fall_forward),
                  ('death_spin_R', lambda r, b: death_spin(r, b, 'R')), ('death_spin_L', lambda r, b: death_spin(r, b, 'L')),
                  ('death_knees', death_knees), ('death_headshot', death_headshot), ('death_run', death_run), ('death_crouch', death_crouch),
                  ('death_prone', death_prone), ('death_window_slump', death_window_slump), ('death_window_back', death_window_back),
                  ('death_blast', death_blast), ('death_bleedout', death_bleedout)):
        if want(n):
            out[n] = fn(rig, built)
    return out


# ------------------------------------------------------------------ dev: stick-figure strips (fast iteration without the renderer)
def stick(rig, clip, path, ts=None, wall=False):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    gq = rig.global_from_local(clip['lq']); gp = fk_global(rig.sk, gq, clip['root'])
    F = len(gq); dur = (F - 1) / FPS
    ts = ts or [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, dur]
    ts = [x for x in ts if x <= dur + 1e-6]
    n = len(ts); half = (n + 1) // 2
    fig, ax = plt.subplots(6, half, figsize=(2.3 * half, 13))
    par = rig.sk.parent
    for k, tt in enumerate(ts):
        f = min(int(round(tt * FPS)), F - 1)
        hc = gp[f, 0]
        for row, (a, b) in enumerate(((2, 1), (0, 1), (0, 2))):
            A_ = ax[row + 3 * (k // half), k % half]
            for i in range(rig.n):
                p = par[i]
                nm = rig.sk.names[i]
                if p < 0 or 'Finger' in nm or 'Thumb' in nm:
                    continue
                c = 'tab:blue' if nm.startswith(('Left', 'LHip')) else ('tab:red' if nm.startswith(('Right', 'RHip')) else 'k')
                A_.plot([gp[f, p, a], gp[f, i, a]], [gp[f, p, b], gp[f, i, b]], c=c, lw=2)
            hd = gp[f, rig.I['Head']]
            A_.plot(hd[a], hd[b], 'o', c='k', ms=6)
            if b == 1:
                A_.axhline(0, c='g', lw=0.8)
                if wall and a == 2:
                    A_.plot([WALL_Z, WALL_Z], [0, SILL_Y], c='brown', lw=3)
                A_.set_xlim(hc[a] - 1.1, hc[a] + 1.1); A_.set_ylim(-0.1, 1.9)
            else:
                A_.set_xlim(hc[0] - 1.1, hc[0] + 1.1); A_.set_ylim(hc[2] - 1.1, hc[2] + 1.1)
            A_.set_aspect('equal'); A_.set_xticks([]); A_.set_yticks([])
            if row == 0:
                A_.set_title(f'{tt:.2f}s  root ({hc[0]:.2f},{hc[2]:.2f})', fontsize=8)
    for k in range(n, 2 * half):
        for row in range(3):
            ax[row + 3, k % half].axis('off')
    fig.suptitle(clip['name'] + '   rows: side (z right) / front (x right=left hand) / top', fontsize=10)
    plt.tight_layout()
    plt.savefig(path, dpi=60)
    plt.close(fig)


if __name__ == '__main__':
    import sys, time
    import build_anims as BA
    R, rig = BA.setup()
    names = sys.argv[1:] or list(CLIPS)
    for n in names:
        t0 = time.time()
        c = death_clips(rig, lambda x: x == n)[n]
        stick(rig, c, f'{CACHE}/stick_{n}.png', wall='window' in n)
        print(n, f'{c["dur"]:.2f}s', c.get('events'), f'{time.time() - t0:.1f}s')
