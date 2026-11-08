"""arms_v1: anatomical arm re-solve, applied to EVERY clip as the last step before soldier_anims.glb is written (build_anims.write).

Why: clips were built with per-clip two-bone IK poles (and mocap / keyed arms for the rest); the swivel of the elbow was never
checked against the joints it implies.  Holding a rifle the support arm needed 100-180 deg of forearm twist (half of it dumped into
the wrist), upper arms were twisted 100-180 deg in deaths / hatch / medevac clips, and some frames flipped a forearm by 180 deg.
measured with arms_check.py (joint-limit QA of the shipped GLB).

What it does, per clip, per arm, per frame - the hand's WORLD transform is kept exactly (weapon grips, contacts, hand props and
fingers do not move), only LeftArm / LeftForeArm / LeftHand (right likewise) local rotations change:
  1. shoulder (Arm joint) and wrist positions from the clip; the elbow lies on a circle round the shoulder->wrist line, its
     swivel angle psi is the only free parameter (psi = 0: the clip's own elbow);
  2. for 72 swivel candidates the arm is rebuilt as a clean hinge (upper arm twisted so the elbow axis is normal to the arm
     plane - no sideways bend, no hyperextension), and the joints it implies are scored against human ranges:
     humeral (upper-arm) twist, forearm pronation / supination (total twist the hand needs), wrist flexion / extension and
     radial / ulnar deviation, elbow / upper arm / forearm inside the torso (+ vest margin), elbow pointing up, and distance
     from the authored swivel;
  3. a Viterbi pass over the frames picks the cheapest swivel path with a smoothness cost (no pops), then a light smoothing;
  4. the forearm twist the hand needs is shared between the joints: ForeArm takes TW_FORE of it (the elbow seam), the hand
     keeps the rest (the wrist seam); with twist helper bones (twist.py) the forearm twist bone takes the middle share.
     Upper-arm twist: the ArmTwist helper (when present) takes back ARM_TW of the humeral twist at the shoulder seam.
  5. clavicles rotated more than CLAV_MAX are scaled back to it (the arm re-solve then still reaches the same hand).
"""
import numpy as np
from qmath import qmul, qinv, qrot, qaxis, qnorm, qslerp
import twist

DEG = np.pi / 180
K = 72
CLAV_MAX = 29.5
TW_FORE = 0.5            # share of the forearm twist on the ForeArm bone (no helpers)
# hand rest frames (anim.Rig.hand: h fingers, p palm normal, t thumb side), bind pose = world
HAND = {'Left': dict(h=(0.462, -0.513, 0.724), t=(-0.397, 0.61, 0.686), p=(-0.793, -0.604, 0.078)),
        'Right': dict(h=(-0.474, -0.558, 0.681), t=(0.358, 0.585, 0.728), p=(0.805, -0.589, 0.078))}
# comfortable ranges (deg); costs grow quadratically outside
RANGE = dict(hum=(-45, 45), pron=(-95, 35), flex=(-55, 60), dev=(-25, 15))
HARD = dict(pron=(-111, 46), flex=(-61, 71), dev=(-26, 16))     # clamp_wrist: + 8 deg soft zone stays inside the arms_check flags
HAND_CAP = 15.0       # max hand re-orientation (deg) per frame - hands carry weapons / props; only out-of-range frames are touched
# clips whose authored hands are far outside the human range in some frames and hold nothing rigid there (or a prop that may turn
# with the hand): reaching over the shoulder for the folded ATGM, hands under / on the casualty, hatch rims, deaths (prefix match)
# The RIGHT hand carries the weapon (weapon_socket): turning it moves the rifle off the left hand's grip, so by default only the
# left hand is clamped; the right one only in the clips listed with a right cap.  (prefix, left cap, right cap)
# ATGM set-up / pack: the right hand carries the launcher / tube that the left palm holds too - neither hand may turn.
HAND_CAP_CLIP = (('medevac_', 90.0, 90.0), ('wounded_', 90.0, 90.0), ('atgm_', 0.0, 0.0),
                 ('hatch_exit', 60.0, 60.0), ('death_', 90.0, 90.0), ('throw_grenade', 45.0, 45.0))
# clips whose elbows / forearms are planted contacts (crawls) or squeeze past vehicle geometry: swivel kept as authored (the arm
# is still rebuilt as a clean hinge and the twist redistributed)
LOCK_SWIVEL = ('prone_crawl', 'high_crawl', 'wounded_crawl', 'dismount_door')
LOCK_ALL = ('prone_crawl', 'high_crawl', 'wounded_crawl')     # loops with planted forearms: not even the end frames move


def hand_cap(name, side):
    for p, cl, cr in HAND_CAP_CLIP:
        if name.startswith(p):
            return cl if side == 'Left' else cr
    return HAND_CAP if side == 'Left' else 0.0
W = dict(hum=1.0, pron=1.0, flex=0.8, dev=0.8, body=4.0, up=2.0, cross=2.0, orig=0.35, far=4.0, step=1.2)


def unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def quat_from_mats(M):
    """(..., 3, 3) rotation matrices -> (..., 4) quaternions [x y z w] (robust branchless-ish)"""
    m = M
    tr = m[..., 0, 0] + m[..., 1, 1] + m[..., 2, 2]
    q = np.zeros(M.shape[:-2] + (4,))
    c0 = tr > 0
    c1 = ~c0 & (m[..., 0, 0] > m[..., 1, 1]) & (m[..., 0, 0] > m[..., 2, 2])
    c2 = ~c0 & ~c1 & (m[..., 1, 1] > m[..., 2, 2])
    c3 = ~c0 & ~c1 & ~c2
    s = np.sqrt(np.maximum(tr + 1, 1e-12)) * 2
    q[c0] = np.stack([(m[..., 2, 1] - m[..., 1, 2]) / s, (m[..., 0, 2] - m[..., 2, 0]) / s, (m[..., 1, 0] - m[..., 0, 1]) / s, 0.25 * s], -1)[c0]
    s = np.sqrt(np.maximum(1 + m[..., 0, 0] - m[..., 1, 1] - m[..., 2, 2], 1e-12)) * 2
    q[c1] = np.stack([0.25 * s, (m[..., 0, 1] + m[..., 1, 0]) / s, (m[..., 0, 2] + m[..., 2, 0]) / s, (m[..., 2, 1] - m[..., 1, 2]) / s], -1)[c1]
    s = np.sqrt(np.maximum(1 + m[..., 1, 1] - m[..., 0, 0] - m[..., 2, 2], 1e-12)) * 2
    q[c2] = np.stack([(m[..., 0, 1] + m[..., 1, 0]) / s, 0.25 * s, (m[..., 1, 2] + m[..., 2, 1]) / s, (m[..., 0, 2] - m[..., 2, 0]) / s], -1)[c2]
    s = np.sqrt(np.maximum(1 + m[..., 2, 2] - m[..., 0, 0] - m[..., 1, 1], 1e-12)) * 2
    q[c3] = np.stack([(m[..., 0, 2] + m[..., 2, 0]) / s, (m[..., 1, 2] + m[..., 2, 1]) / s, 0.25 * s, (m[..., 1, 0] - m[..., 0, 1]) / s], -1)[c3]
    return qnorm(q)


def twist_angle(q, axis):
    """signed twist (rad, wrapped to (-pi, pi]) of q (..., 4) about the unit axis"""
    p = np.sum(q[..., :3] * axis, -1)
    a = 2 * np.arctan2(p, q[..., 3])
    return (a + np.pi) % (2 * np.pi) - np.pi


def rotvec(q):
    q = np.where(q[..., 3:4] < 0, -q, q)
    s = np.linalg.norm(q[..., :3], axis=-1, keepdims=True)
    ang = 2 * np.arctan2(s[..., 0], q[..., 3])
    return q[..., :3] / np.maximum(s, 1e-12) * ang[..., None]


class ArmGeo:
    def __init__(self, sk, side):
        I = sk.idx
        self.side = side
        self.sgn = 1.0 if side == 'Left' else -1.0      # pronation-positive sign of the twist about the forearm axis
        self.iS, self.iA, self.iF, self.iH = (I[side + b] for b in ('Shoulder', 'Arm', 'ForeArm', 'Hand'))
        u0 = sk.head[self.iF] - sk.head[self.iA]; f0 = sk.head[self.iH] - sk.head[self.iF]
        self.L1, self.L2 = np.linalg.norm(u0), np.linalg.norm(f0)
        self.u0, self.f0 = u0 / self.L1, f0 / self.L2
        self.n0 = unit(np.cross(self.u0, self.f0))
        self.A0 = np.stack([self.u0, self.n0, np.cross(self.u0, self.n0)], 1)
        self.B0 = np.stack([self.f0, self.n0, np.cross(self.f0, self.n0)], 1)
        H = {k: unit(np.array(v)) for k, v in HAND[side].items()}
        self.ax_flex = unit(np.cross(H['h'], H['p']))      # + = flexion (fingers toward the palm)
        self.ax_dev = unit(np.cross(H['h'], H['t']))       # + = radial deviation (toward the thumb)
        self.it = I.get(side + 'ForeArmTwist'); self.ia2 = I.get(side + 'ArmTwist')


def chain(geo, S, Wp, Hq, Pq, psi_dirs):
    """rebuild the arm for swivel directions psi_dirs (..., 3) (unit, perpendicular to the shoulder->wrist line).
    S, Wp (F,3) shoulder / wrist, Hq (F,4) hand world rotation, Pq (F,4) clavicle world rotation; extra leading candidate axis
    broadcast as (F, K, ...).  returns dict of arrays (F, K)"""
    d = Wp - S
    dist = np.linalg.norm(d, axis=-1)
    dn = d / np.maximum(dist, 1e-9)[..., None]
    L1, L2 = geo.L1, geo.L2
    dc = np.clip(dist, abs(L1 - L2) + 1e-4, (L1 + L2) * 0.9995)
    a = (L1 ** 2 - L2 ** 2 + dc ** 2) / (2 * dc)
    h = np.sqrt(np.maximum(L1 ** 2 - a ** 2, 0))
    ex = (lambda x: x[:, None]) if psi_dirs.ndim == 3 else (lambda x: x)
    pv = psi_dirs
    E = ex(S) + ex(dn) * ex(a)[..., None] + pv * ex(h)[..., None]
    Tc = ex(S) + ex(dn) * ex(dc)[..., None]
    u1 = unit(E - ex(S)); f1 = unit(Tc - E)
    n1 = unit(np.cross(pv, np.broadcast_to(ex(dn), pv.shape)))
    A1 = np.stack([u1, n1, np.cross(u1, n1)], -1)
    B1 = np.stack([f1, n1, np.cross(f1, n1)], -1)
    qa = quat_from_mats(A1 @ geo.A0.T)
    qb = quat_from_mats(B1 @ geo.B0.T)
    Hqx = np.broadcast_to(ex(Hq), qb.shape)
    Pqx = np.broadcast_to(ex(Pq), qa.shape)
    hum = twist_angle(qmul(qinv(Pqx), qa), geo.u0)
    r0 = qmul(qinv(qb), Hqx)
    T = twist_angle(r0, geo.f0)
    sw = qmul(qinv(qaxis(np.broadcast_to(geo.f0, T.shape + (3,)), T)), r0)
    rv = rotvec(sw)
    return dict(E=E, qa=qa, qb=qb, hum=hum / DEG, T=T, pron=geo.sgn * T / DEG, flex=rv @ geo.ax_flex / DEG,
                dev=rv @ geo.ax_dev / DEG, pv=pv, u1=u1, f1=f1, S=S, dn=dn, a=a, h=h)


def _out(x, lo, hi, scale):
    return (np.maximum(x - hi, 0) / scale) ** 2 + (np.maximum(lo - x, 0) / scale) ** 2


def _viterbi(C, step_cost):
    F, Kc = C.shape
    D = C[0].copy(); back = np.zeros((F, Kc), int)
    idx = np.arange(Kc)
    dk = np.abs(idx[:, None] - idx[None, :]); dk = np.minimum(dk, Kc - dk)
    Tm = step_cost(dk)
    for f in range(1, F):
        tot = D[None, :] + Tm          # [to, from]
        back[f] = np.argmin(tot, 1)
        D = tot[idx, back[f]] + C[f]
    path = np.zeros(F, int); path[-1] = int(np.argmin(D))
    for f in range(F - 1, 0, -1):
        path[f - 1] = back[f, path[f]]
    return path


def solve_side(sk, geo, gq, gp, torso=None, loop=False, log=None, name='', lock=False):
    """returns new global rotations for Arm / ForeArm (and twist helpers) of one side; the hand keeps gq[:, iH]"""
    F = len(gq)
    S = gp[:, geo.iA]; Wp = gp[:, geo.iH]; Hq = gq[:, geo.iH]; Pq = gq[:, geo.iS]
    dn = unit(Wp - S)
    nA = qrot(gq[:, geo.iA], np.broadcast_to(geo.n0, (F, 3)))        # the clip's own elbow axis
    nA = nA - dn * np.sum(nA * dn, -1, keepdims=True)
    bad = np.linalg.norm(nA, axis=-1) < 1e-4
    nA[bad] = np.cross(dn[bad], [0, 1.0, 0])
    e1 = unit(np.cross(dn, unit(nA)))                                  # psi = 0: the clip's own swivel
    e2 = np.cross(dn, e1)
    psi = np.arange(K) * (2 * np.pi / K)
    pvs = np.cos(psi)[None, :, None] * e1[:, None] + np.sin(psi)[None, :, None] * e2[:, None]   # (F,K,3)
    R = chain(geo, S, Wp, Hq, Pq, pvs)
    C = (W['hum'] * _out(R['hum'], *RANGE['hum'], 15) + W['pron'] * _out(R['pron'], *RANGE['pron'], 15)
         + W['flex'] * _out(R['flex'], *RANGE['flex'], 15) + W['dev'] * _out(R['dev'], *RANGE['dev'], 10))
    # elbow pointing up (in the chest frame: Spine1 up), natural elbows hang down / out
    up = qrot(gq[:, sk.idx['Spine1']], np.broadcast_to([0, 1.0, 0], (F, 3)))
    C += W['up'] * (np.maximum(np.sum(R['pv'] * up[:, None], -1) - 0.25, 0) / 0.25) ** 2
    C += W['up'] * (np.maximum(R['pv'][..., 1] - 0.35, 0) / 0.25) ** 2          # ... and in the world (hunched / lying bodies)
    if torso is not None:
        pose = dict(gq=gq, gp=gp)
        S3 = S[:, None]
        pts = np.concatenate([R['E'], S3 + (R['E'] - S3) * 0.6, R['E'] + (Wp[:, None] - R['E']) * 0.35], 1)   # (F, 3K, 3)
        dep = torso.depth(pose, pts, shrink=1.08).reshape(F, 3, K).max(1)
        C += W['body'] * (dep / 0.01) ** 2
    # upper arm swung across the chest (medial in the chest frame) - the torso hull does not cover the face / neck
    lat = qrot(gq[:, sk.idx['Spine1']], np.broadcast_to([1.0 if geo.side == 'Left' else -1.0, 0, 0], (F, 3)))
    C += W['cross'] * (np.maximum(-np.sum(R['u1'] * lat[:, None], -1) - 0.3, 0) / 0.15) ** 2
    # stay near the authored swivel; large departures (> 45 deg) get expensive fast - a re-solve must not read as a new pose
    dpsi = np.minimum(psi, 2 * np.pi - psi) / DEG
    C += W['orig'] * (dpsi / 40) ** 2 + W['far'] * (np.maximum(dpsi - 45, 0) / 10) ** 2
    # ground: elbow / forearm not lower than the authored arm (or 4 cm) - lying, crawling, dead men keep their contacts
    E0 = gp[:, geo.iF]
    for P, P0 in ((R['E'], E0), (R['E'] + (Wp[:, None] - R['E']) * 0.5, (E0 + Wp) * 0.5)):
        lim = np.minimum(P0[:, 1], 0.04)[:, None]
        C += W['body'] * (np.maximum(lim - P[..., 1], 0) / 0.01) ** 2
    if lock:
        # swivel as authored in the interior; the 8 end frames blend to the pinned optimum (hand-over poses must match)
        f = np.arange(F)
        inner = (np.minimum(f, F - 1 - f) >= 8) | name.startswith(LOCK_ALL)
        C = C + 1e6 * ((dpsi > 0)[None, :] & inner[:, None])
    # endpoints pinned to the pose's own optimum (a function of that frame only): clips that hand over to each other (reload ->
    # aim, fire_* -> aim_*, loops) meet at identical poses and so get identical arms there
    pin = C.copy()
    for f in (0, F - 1):
        best = 0 if (lock and name.startswith(LOCK_ALL)) else int(np.argmin(C[f])); pin[f] = 1e9; pin[f, best] = C[f, best]
    path = _viterbi(pin, lambda dk: W['step'] * (dk * 360 / K / 8.0) ** 2 + 4.0 * (np.maximum(dk * 360 / K - 12, 0) / 8.0) ** 4)
    ang = np.unwrap(psi[path])
    # light smoothing of the swivel (+-2 frames); loops wrap
    k = np.array([1, 4, 6, 4, 1], float); k /= k.sum()
    pad = np.r_[ang[-3:-1] - (ang[-1] - ang[0]), ang, ang[1:3] + (ang[-1] - ang[0])] if loop and F > 4 else np.r_[[ang[0]] * 2, ang, [ang[-1]] * 2]
    angs = np.convolve(pad, k, 'valid') if F > 4 else ang.copy()
    # smoothing moved the pinned ends: put them back (linear correction over the clip)
    t = np.linspace(0, 1, F)
    angs += (ang[0] - angs[0]) * (1 - t) + (ang[-1] - angs[-1]) * t
    pv = np.cos(angs)[:, None] * e1 + np.sin(angs)[:, None] * e2
    Rf = chain(geo, S, Wp, Hq, Pq, pv)
    stats = dict(psi_max=float(np.abs((angs + np.pi) % (2 * np.pi) - np.pi).max() / DEG),
                 cost0=float(C[:, 0].sum()), cost=float(C[np.arange(F), path].sum()))
    return Rf, stats


def _ss(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def soft_clip(x, lo, hi, m=8.0):
    """identity inside [lo, hi]; beyond, a smooth (tanh) approach to lo - m / hi + m"""
    y = np.where(x > hi, hi + m * np.tanh((x - hi) / m), x)
    return np.where(x < lo, lo - m * np.tanh((lo - x) / m), y)


def clamp_wrist(geo, qb, Hq, Rf, cap=HAND_CAP):
    """hands still out of the human range after the swivel (authoring: the clip put the hand where no elbow can serve it):
    pronation / wrist flexion / deviation softly clamped to HARD; the hand's world rotation changes by the excess only"""
    pr = soft_clip(Rf['pron'], *HARD['pron'])
    ef = geo.ax_flex; ed = unit(geo.ax_dev - ef * (geo.ax_dev @ ef)); e3 = np.cross(ef, ed)
    T = Rf['T']
    r0 = qmul(qinv(qb), Hq)
    sw = qmul(qinv(qaxis(np.broadcast_to(geo.f0, T.shape + (3,)), T)), r0)
    rv = rotvec(sw)
    rf, rd, r3 = rv @ ef, rv @ ed, rv @ e3
    fx = soft_clip(rf / DEG, *HARD['flex']) * DEG
    c = geo.ax_dev @ ef; dd = geo.ax_dev @ ed
    dev = (fx * c + rd * dd) / DEG
    dv = soft_clip(dev, *HARD['dev']) * DEG
    rd2 = (dv - fx * c) / dd
    rv2 = fx[:, None] * ef + rd2[:, None] * ed + r3[:, None] * e3
    ang = np.linalg.norm(rv2, axis=-1)
    sw2 = np.concatenate([unit(rv2) * np.sin(ang / 2)[:, None], np.cos(ang / 2)[:, None]], -1)
    T2 = geo.sgn * pr * DEG
    H2 = qmul(qb, qmul(qaxis(np.broadcast_to(geo.f0, T.shape + (3,)), T2), sw2))
    H2 = np.where(np.sum(H2 * Hq, -1, keepdims=True) < 0, -H2, H2)
    d = 2 * np.arccos(np.clip(np.abs(np.sum(H2 * Hq, -1)), 0, 1)) / DEG
    # share of the correction applied: capped, and faded out for corrections near a half turn (their direction is unstable from
    # one frame to the next - a flip there would be a pop)
    k = np.minimum(1.0, cap / np.maximum(d, 1e-6)) * (1 - _ss(100.0, 140.0, d))
    if cap <= 0:
        return Hq, T, 0.0
    # correction as a rotation vector in the world, capped / faded, then smoothed over time (no frame-to-frame jumps)
    c = qmul(H2, qinv(Hq)); c = np.where(c[:, 3:4] < 0, -c, c)
    cv = rotvec(c) * k[:, None]
    if len(cv) > 4:
        raw = cv.copy()
        ker = np.array([1, 4, 6, 4, 1], float); ker /= ker.sum()
        for _ in range(2):
            pad = np.concatenate([cv[:1], cv[:1], cv, cv[-1:], cv[-1:]])
            cv = np.stack([np.convolve(pad[:, j], ker, 'valid') for j in range(3)], 1)
        t = np.linspace(0, 1, len(cv))[:, None]
        cv += (raw[0] - cv[0]) * (1 - t) + (raw[-1] - cv[-1]) * t
    ang = np.linalg.norm(cv, axis=-1)
    cq = np.concatenate([unit(cv) * np.sin(ang / 2)[:, None], np.cos(ang / 2)[:, None]], -1)
    H2 = qmul(cq, Hq)
    T2 = twist_angle(qmul(qinv(qb), H2), geo.f0)
    d = 2 * np.arccos(np.clip(np.abs(np.sum(H2 * Hq, -1)), 0, 1)) / DEG
    return H2, T2, float(d.max())


def _pop(lq, geo):
    """largest frame-to-frame change (deg) of the arm's local rotations"""
    m = 0.0
    for i in (geo.iA, geo.iF, geo.iH):
        q = lq[:, i]
        if len(q) > 1:
            d = np.abs(np.sum(q[1:] * q[:-1], -1))
            m = max(m, float(np.degrees(2 * np.arccos(np.clip(d, 0, 1))).max()))
    return m


def apply_clip(sk, lq, root, torso=None, loop=False, name='', log=None, clamp_hands=True):
    """lq (F, n, 4) locals (n = sk.n, or the 31 bones without the twist helpers when sk has them: they are appended), root (F, 3).
    sk: twist.extend(skel) for the helpers.  returns (new lq (F, sk.n, 4), stats)"""
    twist_bones = twist.enabled(sk)
    nb = lq.shape[1]
    n_out = sk.n
    if nb < n_out:
        lq = np.concatenate([lq, np.tile([0, 0, 0, 1.0], (lq.shape[0], n_out - nb, 1))], 1)
    lq = lq.copy()
    lq0 = lq.copy()
    # 5. clavicles past CLAV_MAX scaled back
    for side in ('Left', 'Right'):
        i = sk.idx[side + 'Shoulder']
        q = qnorm(lq[:, i]); q = np.where(q[:, 3:4] < 0, -q, q)
        ang = 2 * np.arccos(np.clip(q[:, 3], -1, 1)) / DEG
        over = ang > CLAV_MAX
        if over.any():
            lq[over, i] = qslerp(np.tile([0, 0, 0, 1.0], (over.sum(), 1)), q[over], CLAV_MAX / ang[over])
    gq0, gp0 = sk.fk(lq0, root)
    gq, gp = sk.fk(lq, root)
    stats = {}
    for side in ('Left', 'Right'):
        geo = ArmGeo(sk, side)
        # the hand world transform must survive the clavicle clamp too: take it from the ORIGINAL pose
        gqs, gps = gq.copy(), gp.copy()
        gqs[:, geo.iH] = gq0[:, geo.iH]; gps[:, geo.iH] = gp0[:, geo.iH]
        pop0 = _pop(lq0, geo)
        best = None
        # strongest fix first; a mode that makes the arm pop more than the authored clip did (fast reaches through impossible
        # wrists: the swivel / hand clamp would have to sweep) falls back to a gentler one
        for mode in ((dict(lock=False, clamp=clamp_hands), dict(lock=False, clamp=False), dict(lock=True, clamp=False))
                     if not name.startswith(LOCK_SWIVEL) else (dict(lock=True, clamp=clamp_hands), dict(lock=True, clamp=False))):
            Rf, st = solve_side(sk, geo, gqs, gps, torso=torso, loop=loop, name=name, lock=mode['lock'])
            qa, qb, T = Rf['qa'], Rf['qb'], Rf['T']
            Hq = gq0[:, geo.iH]
            if mode['clamp']:
                Hq, T, st['hand_moved_deg'] = clamp_wrist(geo, qb, Hq, Rf, cap=hand_cap(name, side))
            # forearm share of the twist: a function of the frame's own (wrapped) twist, faded out towards +-180 deg
            # (twist._fade) so it is continuous across the wrap and identical for identical poses (clip hand-overs)
            share = twist.A_FORE if twist_bones else TW_FORE
            qfa = qmul(qb, qaxis(np.broadcast_to(geo.f0, (len(T), 3)), T * share * twist._fade(T)))
            Pq = gq[:, geo.iS]
            cand = lq.copy()
            cand[:, geo.iA] = qmul(qinv(Pq), qa)
            cand[:, geo.iF] = qmul(qinv(qa), qfa)
            cand[:, geo.iH] = qmul(qinv(qfa), Hq)
            pop = _pop(cand, geo)
            st.update(mode=mode, pop0=round(pop0, 1), pop=round(pop, 1))
            if best is None or pop < best[0] - 2:
                best = (pop, cand, st)
            if pop <= max(pop0 + 3, 20):
                best = (pop, cand, st)
                break
        lq = best[1]
        stats[side] = best[2]
    if twist_bones:
        twist.drive(sk, lq)
    for i in range(lq.shape[1]):
        q = lq[:, i]
        for f in range(1, len(q)):
            if np.dot(q[f], q[f - 1]) < 0:
                q[f] = -q[f]
    return lq, stats
