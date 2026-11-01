"""ATGM (Kornet / Stugna-P) + FPV team clips and the infantry drone reactions.

  atgm_aim            gunner kneeling (both knees) at the launcher: right eye at the sight (Kornet 1P45M eyepiece / Stugna PDU
                      screen), palms on the two control grips; loop
  atgm_fire           launch (button at 0, missile out at `launch`), flinch, keeps tracking (SACLOS); first/last == atgm_aim f0
  atgm_setup[_stugna] unsling the folded launcher, plant it, put the first TLC on, settle into atgm_aim (ends == atgm_aim f0)
  atgm_pack[_stugna]  mirror: TLC off and laid down, fold the launcher, sling it on the back, stand up
  atgm_reload[_stugna] loader beside the launcher: spent TLC off -> laid down, fresh TLC from the ground -> on the cradle
  fpv_launch          helper tosses the drone (overhead, both hands; `release`)
  fpv_pilot           pilot sitting on the ground, radio in both hands in front of the chest, goggles on, head down; loop
  dodge_dive_R / _L   (dodge_dive = _R) throw himself to the side and end prone (== prone_idle f0); in place
  drone_shoot         standing, rifle aimed ~55 deg up, short bursts; loop

Every clip is authored in its soldier's own root frame (+Z = facing, +X = his left).  Props are re-parented by the game at the
clip's events; each prop record (clip extra 'props') gives the node, the socket and the node's transform in the socket frame
while held, plus where it is before / after (see PROP_DOC).  Layout (launcher position, TLC spots ...) from atgm_layout.py.
Conventions (anim.py): joint frames world-aligned in bind pose, local euler (deg, YXZ): +X pitch forward, hip flexion -X on
*UpLeg, knee flexion +X on *Leg, +Y yaw to the left, +Z roll to the right."""
import json, os
import numpy as np
from scipy.optimize import minimize
import anim as A
import clips as C
from anim import FPS, fk_global, smooth
from qmath import qmul, qinv, qrot, qaxis, qeuler, qslerp, qfrom_mat, qto_mat, qbetween, qlook, qnorm, qfix_continuity
from clips_extra import add_euler, noise, osc, hand_q, to_clip
import atgm_layout as LY

HERE = os.path.dirname(os.path.abspath(__file__))
X3, Y3, Z3 = np.eye(3)
KNEE_Y = 0.075        # knee joint height when kneeling on the kneecap
KNEE_TOE_H = 0.027    # toe joint height with the toes tucked under
ANK_Y = 0.072         # ankle joint height, flat foot
ID = np.array([0, 0, 0, 1.0])
CLIPS = ('atgm_aim', 'atgm_fire', 'atgm_setup', 'atgm_setup_stugna', 'atgm_pack', 'atgm_pack_stugna', 'atgm_reload', 'atgm_reload_stugna',
         'fpv_launch', 'fpv_pilot', 'dodge_dive', 'dodge_dive_R', 'dodge_dive_L', 'drone_shoot')
PROP_DOC = ('props[]: node = node name in `glb`; while from_event <= t < to_event the node is a child of `socket` (soldier) with local '
            'translation t / rotation q (xyzw); `before` / `after` = where it is outside that window: {attach: "weapon_socket_back"} '
            '(identity), {attach: "launcher"} (its default place in the launcher GLB), {attach: "launcher", empty: "<name>"} (node '
            'transform = that empty of the launcher GLB), {attach: "world"} (keep the world transform it had at to_event), '
            '{attach: "hidden"}.  launcher_nodes[]: visibility of launcher-GLB nodes over the clip (visible from `show` to `hide`, '
            'null = clip start / end).  The launcher is placed so its `seat` empty == the gunner root (position + heading); the loader '
            'root = the launcher\'s `loader_seat` empty.')


# ====================================================================== small helpers
def tgrid(dur):
    F = int(round(dur * FPS)) + 1
    return F, np.arange(F) / FPS


def ramp(t, t0, t1):
    return smooth((np.asarray(t, float) - t0) / max(t1 - t0, 1e-6))


def bump(t, t0, t1, t2, t3):
    """0 before t0, up to 1 by t1, 1 until t2, down to 0 by t3"""
    return ramp(t, t0, t1) * (1 - ramp(t, t2, t3))


def yawq(deg):
    return qaxis(Y3, np.radians(deg))


def bc(v, F):
    v = np.asarray(v, float)
    return np.broadcast_to(v, (F,) + v.shape[-1:]).copy() if v.ndim == 1 else v


def key_w(t, kt):
    kt = np.asarray(kt, float)
    j = np.clip(np.searchsorted(kt, t, side='right') - 1, 0, len(kt) - 1)
    jn = np.minimum(j + 1, len(kt) - 1)
    w = np.where(jn > j, smooth((t - kt[j]) / np.maximum(kt[jn] - kt[j], 1e-6)), 0.0)
    return j, jn, w


def blend(t, kt, P=None, Q=None):
    """P (K, F, d) / Q (K, F, 4) per-key per-frame values -> smoothstep blend between consecutive keys"""
    j, jn, w = key_w(t, kt)
    f = np.arange(len(t))
    out = []
    if P is not None:
        out.append(P[j, f] * (1 - w)[:, None] + P[jn, f] * w[:, None])
    if Q is not None:
        out.append(qslerp(Q[j, f], Q[jn, f], w))
    return out[0] if len(out) == 1 else tuple(out)


def frame_q(x, y, z):
    """rotation with the given (orthonormalised) column axes"""
    z = np.asarray(z, float); z = z / np.linalg.norm(z)
    y = np.asarray(y, float); y = y - z * (y @ z); y /= np.linalg.norm(y)
    return qfrom_mat(np.stack([np.cross(y, z), y, z], 1))


def xf_inv(q, p):
    qi = qinv(q)
    return qi, -qrot(qi, p)


def xf_mul(qa, pa, qb, pb):
    return qmul(qa, qb), pa + qrot(qa, pb)


def pose_lq(rig, root, **eul):
    lq, r = rig.rest(1)
    for b, e in eul.items():
        lq[0, rig.I[b]] = qeuler(*e, order='YXZ')
    return lq[0], np.asarray(root, float)


def body_track(rig, t, keys):
    """keys: [(t, (lq (nb,4), root (3,)))] -> lq (F,nb,4), root (F,3) (smoothstep slerp)"""
    kt = np.array([k[0] for k in keys])
    j, jn, w = key_w(t, kt)
    L = np.array([k[1][0] for k in keys]); R = np.array([k[1][1] for k in keys])
    F = len(t)
    lq = np.zeros((F, rig.n, 4))
    for f in range(F):
        lq[f] = qslerp(L[j[f]], L[jn[f]], w[f])
    root = R[j] * (1 - w)[:, None] + R[jn] * w[:, None]
    return lq, root


class Body:
    """FK products of a (gq, root) body track"""
    def __init__(self, rig, gq, root):
        self.rig = rig; self.gq = gq; self.root = root
        self.gp = fk_global(rig.sk, gq, root)
        I = rig.I
        self.cq = gq[:, I['Spine1']]; self.cp = self.gp[:, I['Spine1']]
        self.s1 = rig.sk.head[I['Spine1']]
        self.F = len(gq)

    def chest(self, p_b, q_b=ID):
        """bind-pose world placement relative to the chest (Spine1) -> per frame world"""
        return qmul(self.cq, bc(q_b, self.F)), self.cp + qrot(self.cq, bc(np.asarray(p_b) - self.s1, self.F))

    def chest_dir(self, d):
        return qrot(self.cq, bc(d, self.F))

    def joint(self, name):
        return self.gq[:, self.rig.I[name]], self.gp[:, self.rig.I[name]]


# ====================================================================== sockets (same maths as build_soldier.add_sockets)
def sockets(rig):
    HL = rig.hand['Left']
    gl = A.GUN['ak74m']['grip_L'] + np.array([0, -0.018, 0])
    RL = rig.gunL @ HL['F'].T
    s1 = rig.sk.head[rig.I['Spine1']]
    Rb, tb = LY.back_frame()
    return dict(weapon_socket=('RightHand', rig.sock_t, rig.sock_q),
                weapon_socket_L=('LeftHand', (HL['palm'] - HL['wrist']) - RL.T @ gl, qfrom_mat(RL.T)),
                weapon_socket_back=('Spine1', tb - s1, qfrom_mat(Rb)))


def socket_world(rig, gq, gp, name):
    b, t_, q_ = sockets(rig)[name]
    i = rig.I[b]
    F = len(gq)
    return qmul(gq[:, i], bc(q_, F)), gp[:, i] + qrot(gq[:, i], bc(t_, F))


def hand_from_socket(rig, side, sq, sp):
    """global hand rotation + palm centre that put weapon_socket(_L) at (sq, sp)"""
    b, t_, q_ = sockets(rig)['weapon_socket' if side == 'Right' else 'weapon_socket_L']
    F = len(sq)
    hq = qmul(sq, bc(qinv(q_), F))
    wrist = sp - qrot(hq, bc(t_, F))
    H = rig.hand[side]
    return hq, wrist + qrot(hq, bc(H['palm'] - H['wrist'], F))


# ====================================================================== legs
def legs(rig, gq, root, t, specs, lift=0.07):
    """specs: {'Left'|'Right': [(t, spec)]}.  spec = ('foot', x, z, yaw[, dy])  flat foot, ankle over (x, z)
                                                     ('knee', x, z, yaw)        knee on the ground at (x, z) (z None: where the
                                                                                thigh lands), toes tucked, shin back along yaw
                                                     ('toe', x, z, yaw, pitch)  on the ball of the foot (heel up `pitch` deg)
    foot -> foot moves of more than 3 cm get a lift arc."""
    I = rig.I; sk = rig.sk; F = len(t)
    L1 = np.linalg.norm(sk.head[I['LeftLeg']] - sk.head[I['LeftUpLeg']])
    L2 = np.linalg.norm(sk.head[I['LeftFoot']] - sk.head[I['LeftLeg']])
    for side, keys in specs.items():
        sx = 1.0 if side == 'Left' else -1.0
        gp = fk_global(sk, gq, root)
        hip = gp[:, I[side + 'UpLeg']]
        Kn = len(keys)
        AN = np.zeros((Kn, F, 3)); FQ = np.zeros((Kn, F, 4)); PO = np.zeros((Kn, F, 3)); TQ = np.zeros((Kn, F, 4))
        mode = []
        toe_rest = sk.head[I[side + 'ToeBase']] - sk.head[I[side + 'Foot']]
        for k, (tk, s) in enumerate(keys):
            m = s[0]; mode.append(m)
            yq = yawq(s[3]); R = qto_mat(yq)
            if m in ('foot', 'toe'):
                pitch = s[4] if m == 'toe' else 0.0
                fq = qmul(yq, qeuler(pitch, 0, 0, order='YXZ')) if pitch else yq      # +X = toes down = heel up
                ank = np.array([s[1], ANK_Y + (s[4] if (m == 'foot' and len(s) > 4) else 0.0), s[2]])
                if m == 'toe':        # pivot about the toe joint: heel up
                    toe_flat = np.array([s[1], 0, s[2]]) + R @ toe_rest * [1, 0, 1] + np.array([0, sk.head[I[side + 'ToeBase'], 1], 0])
                    ank = toe_flat - qrot(fq, toe_rest)
                AN[k] = ank; FQ[k] = fq; TQ[k] = yq
                PO[k] = ank + R @ np.array([sx * 0.06, 0.5, 0.6])
            else:                      # knee on the ground, toes tucked (kneel_legs maths, any side / heading)
                kx, kz = s[1], s[2]
                fq = qmul(yq, qeuler(62, sx * 10, 0, order='YXZ'))
                toe_off = qrot(fq, toe_rest)
                fwd = R @ Z3
                for f in range(F):
                    h = hip[f]
                    d = h - np.array([kx, KNEE_Y, kz if kz is not None else h[2]])
                    lat = d @ (R @ X3)          # lateral (perpendicular to the shin heading) distance
                    if kz is None:
                        rem = L1 ** 2 - lat ** 2 - (h[1] - KNEE_Y) ** 2
                        K = np.array([kx, KNEE_Y, 0.0])
                        along = np.sqrt(max(rem, 0.0)) if rem > 0 else 0.0
                        K = np.array([kx, KNEE_Y, h[2]]) + fwd * along
                        K[0] = kx
                        if rem < 0:      # thigh too short: knee lifts
                            K[1] = h[1] - np.sqrt(max(L1 ** 2 - lat ** 2, 0))
                    else:
                        K = np.array([kx, KNEE_Y, kz])
                        dist_k = np.linalg.norm(K - h)
                        if dist_k > L1:  # spot out of the thigh's reach: knee on the line hip -> spot, above the ground
                            K = h + (K - h) * (L1 / dist_k)
                        else:            # thigh too long for the knee spot: knee slides forward along the ground
                            K = K + fwd * (np.sqrt(max(L1 ** 2 - lat ** 2 - (h[1] - KNEE_Y) ** 2, 0)) - (K - h) @ fwd)
                    ah = KNEE_TOE_H - toe_off[1] - KNEE_Y
                    ank = K + R @ np.array([sx * 0.01, 0, 0]) + np.array([0, ah, 0]) - fwd * np.sqrt(max(L2 ** 2 - ah ** 2, 0))
                    AN[k, f] = ank
                    PO[k, f] = K + (K - (h + ank) / 2) * 1.5 + fwd * 0.3
                FQ[k] = fq; TQ[k] = qmul(yq, yawq(sx * 10))
        kt = np.array([k[0] for k in keys])
        j, jn, w = key_w(t, kt)
        fr = np.arange(F)
        ank = AN[j, fr] * (1 - w)[:, None] + AN[jn, fr] * w[:, None]
        pole = PO[j, fr] * (1 - w)[:, None] + PO[jn, fr] * w[:, None]
        fq = qslerp(FQ[j, fr], FQ[jn, fr], w); tq = qslerp(TQ[j, fr], TQ[jn, fr], w)
        for f in range(F):
            a, b = j[f], jn[f]
            if b > a:
                dist = np.linalg.norm((AN[a, f] - AN[b, f])[[0, 2]])
                if dist > 0.03:
                    ank[f, 1] += min(lift, 0.5 * dist + 0.02) * np.sin(np.pi * w[f])
        gq = C.leg_ik(rig, gq, root, side, ank, pole, foot_q=fq)
        gq[:, I[side + 'ToeBase']] = tq
    return gq


def knee_points(rig, gq, root):
    gp = fk_global(rig.sk, gq, root)
    return gp[:, rig.I['LeftLeg']], gp[:, rig.I['RightLeg']]


def hip_z_on_knees(rig, lq1, hip_y, knees, x0=0.0):
    """root z that puts both thighs (length L1) onto knee points at KNEE_Y (mean residual) for a 1-frame pelvis rotation"""
    I = rig.I; sk = rig.sk
    L1 = np.linalg.norm(sk.head[I['LeftLeg']] - sk.head[I['LeftUpLeg']])
    g = rig.global_from_local(lq1[None])

    def res(z):
        p = fk_global(sk, g, np.array([[x0, hip_y, z]]))
        e = 0
        for side, kp in zip(('Left', 'Right'), knees):
            e += (np.linalg.norm(p[0, I[side + 'UpLeg']] - np.array([kp[0], KNEE_Y, kp[1]])) - L1) ** 2
        return e
    r = minimize(lambda v: res(v[0]), [-0.1], method='Nelder-Mead', options=dict(xatol=1e-5, fatol=1e-10))
    return float(r.x[0])


# ====================================================================== arms / hands
def reach_clavicle(rig, gq, root, side, palm, lim=16.0, share=0.65):
    """protract / raise the clavicle toward a far palm target (rifle_overlay style)"""
    I = rig.I; sk = rig.sk; F = len(gq)
    lq_ref = sk.local_from_global(gq)
    gp = fk_global(sk, gq, root)
    ic = I[side + 'Shoulder']; ia = I[side + 'Arm']
    reach = rig.L1[side] + rig.L2[side] + 0.06
    gq = gq.copy()
    for f in range(F):
        v0 = gp[f, ia] - gp[f, ic]; v1 = palm[f] - gp[f, ic]
        deficit = np.linalg.norm(palm[f] - gp[f, ia]) - reach * 0.9
        k = np.clip(deficit / 0.08, 0, 1) * share
        if k <= 0:
            continue
        qb = qbetween(v0, v1)
        ang = 2 * np.arccos(np.clip(qb[3], -1, 1))
        frac = min(1.0, np.radians(lim) / max(ang, 1e-6)) * k
        gq[f, ic] = qmul(qslerp(ID, qb, frac), gq[f, ic])
    return rig.recompute_desc(lq_ref, gq, {side + 'Shoulder'})


def steady_pole(rig, gq, root, side, palm, hq, pole):
    """pole targets conditioned so the elbow cannot flip to the other side of the shoulder -> wrist line between frames
    (an authored pole passing near that line makes two_bone's bend plane jump)"""
    F = len(gq)
    HL = rig.hand[side]
    wrist = palm - qrot(hq, bc(HL['palm'] - HL['wrist'], F))
    S = fk_global(rig.sk, gq, root)[:, rig.I[side + 'Arm']]
    d = wrist - S; d /= np.linalg.norm(d, axis=1, keepdims=True)
    pv = pole - S; pv -= d * np.einsum('ij,ij->i', pv, d)[:, None]
    n = np.linalg.norm(pv, axis=1)
    out = np.zeros_like(pv)
    prev = None
    for f in range(F):
        v = pv[f] / n[f] if n[f] > 1e-6 else None
        if prev is not None:
            pp = prev - d[f] * (prev @ d[f]); pp /= max(np.linalg.norm(pp), 1e-9)
            if v is None or v @ pp < 0.5:          # sharp change / flip: rotate at most ~25 deg per frame toward the authored side
                v = pp if v is None else (pp * 0.9 + v * 0.1)
                v -= d[f] * (v @ d[f]); v /= max(np.linalg.norm(v), 1e-9)
        if v is None:
            v = np.array([0, -1.0, 0])
        out[f] = v; prev = v
    return S + out * 0.5


def arms_hist(rig, gq, root, side, palm, hq, pole, canon=None, clav=True):
    """arm IK with a continuous forearm twist (history unwrap: no pops when the swing passes its singularity, e.g. reaching over the
    shoulder); `canon` (F,) 0..1 blends the forearm roll toward the canonical short twist (1 = exactly the per-frame solution) - used
    in a window where the hand moves freely before a pose that must match another clip"""
    from clips_extra import arm_to
    if clav:
        gq = reach_clavicle(rig, gq, root, side, palm)
    pole = steady_pole(rig, gq, root, side, palm, hq, pole)
    gh = arm_to(rig, gq, root, side, palm, hq, pole)
    if canon is None or not np.any(canon > 0):
        return gh
    gs = arms(rig, gq, root, side, palm, hq, pole, clav=False)
    I = rig.I; F = len(gq)
    lq_ref = rig.sk.local_from_global(gh)
    out = gh.copy()
    i_f, i_h = I[side + 'ForeArm'], I[side + 'Hand']
    d = qmul(gs[:, i_f], qinv(gh[:, i_f]))                     # forearm roll hist -> short (about the forearm axis)
    gp_ = fk_global(rig.sk, gh, root)
    ax = gp_[:, i_h] - gp_[:, i_f]; ax /= np.linalg.norm(ax, axis=1, keepdims=True)
    ang = 2 * np.arctan2(np.einsum('ij,ij->i', d[:, :3], ax), d[:, 3])
    ang = (ang + np.pi) % (2 * np.pi) - np.pi
    for f in range(1, F):                                      # continuous over time (no flip when the roll is ~180 deg)
        ang[f] += 2 * np.pi * np.round((ang[f - 1] - ang[f]) / (2 * np.pi))
    k = np.round(ang[-1] / (2 * np.pi))                        # end on the short solution exactly
    ang -= 2 * np.pi * k
    out[:, i_f] = qmul(qaxis(ax, ang * canon), gh[:, i_f])
    out[:, i_h] = gh[:, i_h]                                   # hand keeps its global target rotation
    return rig.recompute_desc(lq_ref, out, {side + 'Arm', side + 'ForeArm', side + 'Hand'})


def arms(rig, gq, root, side, palm, hq, pole, clav=True):
    """two-bone arm IK to a palm target + global hand rotation, solved per frame without twist history (the forearm always takes
    the short twist, so a pose reached through different hand orientations is identical to the same pose solved directly)"""
    if clav:
        gq = reach_clavicle(rig, gq, root, side, palm)
    F = len(gq)
    palm = bc(palm, F); hq = bc(hq, F).copy(); pole = bc(pole, F).copy()
    HL = rig.hand[side]
    wrist = palm - qrot(hq, bc(HL['palm'] - HL['wrist'], F))
    gp = fk_global(rig.sk, gq, root)
    lq_ref = rig.sk.local_from_global(gq)
    gq = gq.copy()
    for f in range(F):
        sl = slice(f, f + 1)
        rig.two_bone(gq[sl], gp[sl], side + 'Arm', side + 'ForeArm', side + 'Hand', wrist[sl].copy(), pole[sl], end_rot=hq[sl], twist_share=0.5)
    out = rig.recompute_desc(lq_ref, gq, {side + 'Arm', side + 'ForeArm', side + 'Hand'})
    if TWIST_DEBUG is not None:      # wrist twist (hand vs forearm about the forearm axis), deg
        ax = rig.sk.head[rig.I[side + 'Hand']] - rig.sk.head[rig.I[side + 'ForeArm']]; ax /= np.linalg.norm(ax)
        rel = qmul(qinv(out[:, rig.I[side + 'ForeArm']]), out[:, rig.I[side + 'Hand']])
        rel = rel * np.sign(rel[:, 3:4] + 1e-12)
        TWIST_DEBUG.append((side, np.degrees(2 * np.arctan2(rel[:, :3] @ ax, rel[:, 3]))))
    return out


def hand_keys(B, t, keys, objs, side):
    """keys [(t, target, pole_off (chest frame, from the Arm joint), grip 0..1)]; target:
         ('obj', name, palm_local, hq_local) | ('chest', palm_bind, hq_bind) | ('world', palm, hq)
       -> palm (F,3), hq (F,4), pole (F,3), grip (F,)"""
    F = B.F; Kn = len(keys)
    P = np.zeros((Kn, F, 3)); Q = np.zeros((Kn, F, 4)); PO = np.zeros((Kn, F, 3)); G = np.zeros((Kn, F, 1))
    ga = B.gp[:, B.rig.I[side + 'Arm']]
    for k, (tk, tg, po, gr) in enumerate(keys):
        if tg[0] == 'obj':
            oq, op = objs[tg[1]]
            P[k] = op + qrot(oq, bc(tg[2], F)); Q[k] = qmul(oq, bc(tg[3], F))
        elif tg[0] == 'chest':
            Q[k], P[k] = B.chest(tg[1], tg[2])
        else:
            P[k] = bc(tg[1], F); Q[k] = bc(tg[2], F)
        PO[k] = ga + B.chest_dir(po)
        G[k] = gr
    kt = np.array([k[0] for k in keys])
    palm, hq = blend(t, kt, P, Q)
    pole = blend(t, kt, PO); grip = blend(t, kt, G)[:, 0]
    return palm, hq, pole, grip


def obj_track(B, t, keys):
    """keys [(t, spec)]: ('world', q, p) | ('chest', q_bind, p_bind) | ('back',) (= weapon_socket_back) | ('arr', q (F,4), p (F,3))"""
    F = B.F; Kn = len(keys)
    P = np.zeros((Kn, F, 3)); Q = np.zeros((Kn, F, 4))
    for k, (tk, s) in enumerate(keys):
        if s[0] == 'world':
            Q[k] = bc(s[1], F); P[k] = bc(s[2], F)
        elif s[0] == 'chest':
            Q[k], P[k] = B.chest(s[2], s[1])
        elif s[0] == 'back':
            Q[k], P[k] = socket_world(B.rig, B.gq, B.gp, 'weapon_socket_back')
        elif s[0] == 'back_nat':      # natural frame of a prop whose node sits on weapon_socket_back: back socket * (nat -> node)
            bq, bp = socket_world(B.rig, B.gq, B.gp, 'weapon_socket_back')
            Q[k], P[k] = xf_mul(bq, bp, bc(s[1], F), bc(s[2], F))
        elif s[0] == 'chest_grab':    # chest-relative orientation, natural point s[3] at the chest-relative grab point s[2]
            Q[k] = qmul(B.cq, bc(s[1], F))
            gw = B.chest(s[2])[1]
            P[k] = gw - qrot(Q[k], bc(s[3], F))
        else:
            Q[k] = s[1]; P[k] = s[2]
    return blend(t, np.array([k[0] for k in keys]), P, Q)[::-1]     # -> (q, p)


def fingers(rig, gq, grips, curls=None):
    """grips: {side: (F,) 0..1 grip weight}; open hand (18/25/8) -> closed grip (curl per side)"""
    lq = rig.local(gq); I = rig.I; F = len(gq)
    for side, w in grips.items():
        cg = (curls or {}).get(side, (48, 70, 25))
        lqg = lq.copy(); rig.finger_curl(lqg, side, *cg)
        lqo = lq.copy(); rig.finger_curl(lqo, side, 18, 25, 8)
        for b in (side + 'FingerBase', side + 'HandFinger1', 'LThumb' if side == 'Left' else 'RThumb'):
            i = I[b]
            lq[:, i] = qslerp(lqo[:, i], lqg[:, i], w)
    return rig.global_from_local(lq)


def look_at(rig, gq, root, target, w, neck_share=0.4, roll_keep=True):
    """turn Neck (share) + Head toward world target points (F,3) with weight w (F,)"""
    I = rig.I; sk = rig.sk; F = len(gq)
    lq_ref = sk.local_from_global(gq)
    gq = gq.copy()
    for b, s in (('Neck', neck_share), ('Head', 1.0)):
        gp = fk_global(sk, gq, root)
        ih = I['Head']
        eye = gp[:, ih] + qrot(gq[:, ih], bc(np.array([0, 0.04, 0.09]), F))
        fwd = qrot(gq[:, ih], bc(Z3, F))
        d = target - eye
        qd = qbetween(fwd, d)
        ib = I[b]
        k = np.clip(w, 0, 1) * s
        gq[:, ib] = qmul(qslerp(np.broadcast_to(ID, (F, 4)), qd, k), gq[:, ib])
        gq = rig.recompute_desc(lq_ref, gq, {b})
        lq_ref = sk.local_from_global(gq)
    return gq


LIMB_BONES = tuple(f'{s}{b}' for s in ('Left', 'Right') for b in ('Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot'))
HEAD_BONES = ('Neck', 'Neck1', 'Head')


def despike(rig, gq, bones=LIMB_BONES, thresh=28.0, half=4, hold=None):
    """spread any frame-to-frame local rotation jump > thresh deg (residual IK flips) over +-half frames (slerp across the window).
    hold = {side: (F,) bool}: frames where that hand holds a prop - its arm is left alone there (smoothing would pull the palm off)"""
    lq = rig.local(gq); F = len(lq)
    for b in bones:
        i = rig.I[b]
        hm = None
        if hold:
            for sd, m in hold.items():
                if b.startswith(sd) and any(b.endswith(x) for x in ('Arm', 'ForeArm', 'Hand')):
                    hm = m
        for it in range(3):
            q = lq[:, i]
            step = np.degrees(2 * np.arccos(np.clip(np.abs(np.sum(q[1:] * q[:-1], -1)), 0, 1)))
            bad = np.where(step > thresh)[0]
            if hm is not None:
                bad = np.array([f for f in bad if not (hm[max(f - half, 0):f + half + 2].any())], int)
            if not len(bad):
                break
            wins = []
            for f in bad:
                a, c = max(f - half, 0), min(f + half + 1, F - 1)
                if wins and a <= wins[-1][1]:
                    wins[-1][1] = c
                else:
                    wins.append([a, c])
            for a, c in wins:
                n = c - a
                if n < 2:
                    continue
                w = smooth(np.arange(n + 1) / n)
                lq[a:c + 1, i] = qslerp(np.broadcast_to(q[a], (n + 1, 4)), np.broadcast_to(q[c], (n + 1, 4)), w)
    return rig.global_from_local(lq)


def smooth_arm_swivel(rig, gq, root, sides=('Right', 'Left'), dead=3.0, sigma=2.0):
    """remove elbow flips / forearm roll pops without moving the hands: (1) the elbow's swivel about the shoulder->wrist line is
    unwrapped and low-pass filtered and the upper arm + forearm are turned about that line (the wrist lies on it, so it does not
    move); (2) the forearm's roll about its own axis is filtered the same way (the wrist is on that axis too).  The hand keeps its
    global rotation in both steps, so palms stay exactly on the props.  Changes under `dead` deg are left alone (authored poses
    and clip-matching end frames are untouched)."""
    from scipy.ndimage import gaussian_filter1d, median_filter
    F = len(gq)
    if F < 5:
        return gq
    gq = gq.copy()
    def filt(th):
        th = np.unwrap(th)
        sm = gaussian_filter1d(median_filter(th, size=5, mode='nearest'), sigma, mode='nearest')
        d = sm - th
        d = np.sign(d) * np.maximum(np.abs(d) - np.radians(dead), 0)        # dead band
        return gaussian_filter1d(d, 1.0, mode='nearest')
    for side in sides:
        ia, ie, ih = rig.I[side + 'Arm'], rig.I[side + 'ForeArm'], rig.I[side + 'Hand']
        gp = fk_global(rig.sk, gq, root)
        S_, E_, W_ = gp[:, ia], gp[:, ie], gp[:, ih]
        ax = W_ - S_; ax /= np.linalg.norm(ax, axis=1, keepdims=True)
        ref = qrot(gq[:, rig.I['Spine1']], bc(np.array([0, -1.0, -0.3]), F))    # chest-relative "elbow down/back"
        ref -= ax * np.einsum('ij,ij->i', ref, ax)[:, None]; ref /= np.linalg.norm(ref, axis=1, keepdims=True) + 1e-9
        e = E_ - S_; e -= ax * np.einsum('ij,ij->i', e, ax)[:, None]; e /= np.linalg.norm(e, axis=1, keepdims=True) + 1e-9
        th = np.arctan2(np.einsum('ij,ij->i', np.cross(ref, e), ax), np.einsum('ij,ij->i', ref, e))
        d = filt(th)
        if np.abs(d).max() > 1e-4:
            qd = qaxis(ax, d)
            gh = gq[:, ih].copy()
            gq[:, ia] = qmul(qd, gq[:, ia]); gq[:, ie] = qmul(qd, gq[:, ie]); gq[:, ih] = gh
        # forearm roll relative to the upper arm, about the forearm axis
        gp = fk_global(rig.sk, gq, root)
        fa = gp[:, ih] - gp[:, ie]; fa /= np.linalg.norm(fa, axis=1, keepdims=True)
        rel = qmul(qinv(gq[:, ia]), gq[:, ie])
        fa_l = qrot(qinv(gq[:, ia]), fa)
        rel = rel * np.sign(rel[:, 3:4] + 1e-12)
        roll = 2 * np.arctan2(np.einsum('ij,ij->i', rel[:, :3], fa_l), rel[:, 3])
        d = filt(roll)
        if np.abs(d).max() > 1e-4:
            gh = gq[:, ih].copy()
            gq[:, ie] = qmul(qaxis(fa, d), gq[:, ie]); gq[:, ih] = gh
    # the hand keeps its global rotation: rebuild locals so children (fingers) follow
    return rig.global_from_local(rig.local(gq))


def pose_blend_to(rig, gq, root, lq_t, root_t, t, t0, t1):
    """blend the whole pose (locals + root) to (lq_t, root_t) over [t0, t1] (exact match from t1 on)"""
    lq = rig.local(gq)
    w = ramp(t, t0, t1)
    for i in range(rig.n):
        lq[:, i] = qslerp(lq[:, i], bc(lq_t[i], len(t)), w)
    root = root * (1 - w)[:, None] + root_t[None] * w[:, None]
    return rig.global_from_local(lq), root


def eye_world(rig, lm, gq, gp):
    ih = rig.I['Head']
    return gp[:, ih] + qrot(gq[:, ih], bc(lm['eyeR'] - rig.sk.head[ih], len(gq)))


# ====================================================================== gunner aim pose
KNEE_X = 0.125
TWIST_DEBUG = None


def handle_q(rig, side, tilt=0.0):
    """hand on a vertical control handle: fingers forward round the handle, palm facing the handle (toward the midline)"""
    sx = 1.0 if side == 'Left' else -1.0
    h = np.array([sx * 0.18, -np.sin(np.radians(tilt)), np.cos(np.radians(tilt))])
    return hand_q(rig, side, h, np.array([-sx * 1.0, 0, 0.12]))


def solve_gunner(rig, lm, eye_t=LY.EYE, gaze=-4.0, hip_y=0.40, lean=24.0):
    """kneeling on both knees (toes tucked), trunk leaning forward, right eye at eye_t looking `gaze` deg (+ up).
    returns lq (nb,4), root (3,), knee xz (2 x (x, z))"""
    I = rig.I; sk = rig.sk
    eL = lm['eyeR'] - sk.head[I['Head']]

    def pose(x):
        rz, trunk, neck, head, rx, yaw, hy = x
        lq, r = rig.rest(1)
        lq[0, I['Hips']] = qeuler(trunk * 0.34, yaw * 0.3, 0, order='YXZ')
        lq[0, I['LowerBack']] = qeuler(trunk * 0.20, yaw * 0.2, 0, order='YXZ')
        lq[0, I['Spine']] = qeuler(trunk * 0.24, yaw * 0.25, 0, order='YXZ')
        lq[0, I['Spine1']] = qeuler(trunk * 0.22, yaw * 0.25, 0, order='YXZ')
        lq[0, I['Neck']] = qeuler(neck * 0.5, 0, 0, order='YXZ')
        lq[0, I['Neck1']] = qeuler(neck * 0.5, 0, 0, order='YXZ')
        lq[0, I['Head']] = qeuler(head, 0, 0, order='YXZ')
        lq[0, I['LeftShoulder']] = qeuler(0, -6, 4, order='YXZ')       # shoulders slightly forward (hands on the grips in front)
        lq[0, I['RightShoulder']] = qeuler(0, 6, -4, order='YXZ')
        r[0] = [rx, hy, rz]
        return lq, r

    def ev(x):
        lq, r = pose(x)
        g = rig.global_from_local(lq)
        p = fk_global(sk, g, r)
        eye = p[0, I['Head']] + qrot(g[0, I['Head']], eL)
        fwd = qrot(g[0, I['Head']], Z3)
        return lq, r, eye, fwd

    def cost(x):
        _, _, eye, fwd = ev(x)
        pitch = np.degrees(np.arcsin(np.clip(fwd[1], -1, 1)))
        yaw_e = np.degrees(np.arctan2(fwd[0], fwd[2]))
        return (1e5 * np.sum((eye - eye_t) ** 2) + 0.2 * (pitch - gaze) ** 2 + 0.2 * yaw_e ** 2 + 0.004 * (x[1] - lean) ** 2
                + 0.002 * (x[2] ** 2 + x[3] ** 2) + 0.004 * (x[2] + x[3]) ** 2 + 0.01 * x[5] ** 2 + 400 * (x[6] - hip_y) ** 2)
    x0 = np.array([-0.1, lean, -10, -10, 0.0, 0.0, hip_y])
    bnds = [(-0.4, 0.3), (0, 50), (-40, 30), (-40, 30), (-0.1, 0.1), (-15, 15), (0.30, 0.52)]
    best = None
    for st in (x0, x0 + [0.05, 8, 5, 5, 0, 0, 0.03]):
        r = minimize(cost, st, method='Powell', bounds=bnds, options=dict(maxiter=20000, xtol=1e-4, ftol=1e-12))
        if best is None or r.fun < best.fun:
            best = r
    lq, r, eye, fwd = ev(best.x)
    print('gunner solve', np.round(best.x, 3), 'eye err %.4f' % np.linalg.norm(eye - eye_t), 'gaze %.1f' % np.degrees(np.arcsin(fwd[1])))
    # knees where the thighs land (auto), then fixed for every kneeling phase
    g = rig.global_from_local(lq)
    g = legs(rig, g, r, np.zeros(1), {'Left': [(0, ('knee', KNEE_X, None, 0.0))], 'Right': [(0, ('knee', -KNEE_X, None, 0.0))]})
    kl, kr = knee_points(rig, g, r)
    knees = ((float(kl[0, 0]), float(kl[0, 2])), (float(kr[0, 0]), float(kr[0, 2])))
    return lq[0], r[0], knees


class Gunner:
    """the shared aim pose + helpers to re-pose the kneeling gunner"""
    def __init__(self, rig, lm):
        self.rig = rig; self.lm = lm
        self.lq, self.root, self.knees = solve_gunner(rig, lm)
        I = rig.I
        self.kspec = {'Left': ('knee', self.knees[0][0], self.knees[0][1], 0.0), 'Right': ('knee', self.knees[1][0], self.knees[1][1], 0.0)}
        self.hq = {'Right': handle_q(rig, 'Right'), 'Left': handle_q(rig, 'Left')}
        self.palm = {'Right': LY.GRIP_R.copy(), 'Left': LY.GRIP_L.copy()}
        self.pole = {'Right': np.array([-0.30, -0.55, -0.25]), 'Left': np.array([0.30, -0.55, -0.25])}

    def kneel_legs(self, gq, root, t):
        return legs(self.rig, gq, root, t, {s: [(0, self.kspec[s])] for s in ('Left', 'Right')})

    def grip_keys(self, side, t0=0.0, grip=1.0):
        return (t0, ('world', self.palm[side], self.hq[side]), self.pole[side], grip)


def aim_frames(rig, G, lq, root, t, extra_hand=None):
    """legs on the knees + hands on the grips for per-frame body locals"""
    gq = rig.global_from_local(lq)
    gq = G.kneel_legs(gq, root, t)
    B = Body(rig, gq, root)
    for side in ('Right', 'Left'):
        palm, hq, pole, grip = hand_keys(B, t, [G.grip_keys(side)], {}, side)
        gq = arms(rig, gq, root, side, palm, hq, pole, clav=False)
    gq = fingers(rig, gq, {'Right': np.ones(len(t)), 'Left': np.ones(len(t))}, {'Right': (40, 95, 20), 'Left': (40, 95, 20)})
    return gq


def atgm_aim(rig, lm, G, dur=4.0):
    F, t = tgrid(dur)
    lq = np.repeat(G.lq[None], F, 0); root = np.repeat(G.root[None], F, 0)
    lq = C.breathing(rig, lq, F, 1, 0.5)
    # tiny tracking corrections: the eye stays on the eyepiece (head counter-moves the trunk sway)
    sway = noise(F, 41, 18, 1.0)
    add_euler(rig, lq, 'Spine1', 0, 0.6 * sway, 0); add_euler(rig, lq, 'Head', 0, -0.6 * sway, 0)
    gq = aim_frames(rig, G, lq, root, t)
    e = np.linalg.norm(eye_world(rig, lm, gq, fk_global(rig.sk, gq, root)) - LY.EYE, axis=1).max()
    return to_clip('atgm_aim', rig, gq, root, True,
                   notes=f'ATGM gunner kneeling on both knees (toes tucked) behind the launcher, trunk forward, right eye at the sight (Kornet 1P45M '
                         f'eyepiece / Stugna PDU screen) = launcher empty gunner_ref (max {e * 100:.1f} cm off), palms on the control grips '
                         f'(grip_R / grip_L), rifle slung (weapon_socket_back); breathing; 4 s loop. Launcher: seat empty at the root.',
                   events={'launcher_place': 'launcher `seat` empty == soldier root (position + heading)'})


def atgm_fire(rig, lm, G, dur=1.5, t_launch=0.10):
    """button press at 0, launch at t_launch: blast flinch (shoulders / head jerk, squint), then steady tracking; ends == atgm_aim f0"""
    F, t = tgrid(dur)
    lq = np.repeat(G.lq[None], F, 0); root = np.repeat(G.root[None], F, 0).copy()
    k = np.where(t < t_launch, 0.0, np.exp(-(t - t_launch) / 0.16) * (1 - np.exp(-(t - t_launch) / 0.025)))
    k = k / max(k.max(), 1e-6) * (1 - ramp(t, 0.9, dur))
    add_euler(rig, lq, 'Spine1', -2.2 * k, 0, 0); add_euler(rig, lq, 'Spine', -1.0 * k, 0, 0)
    add_euler(rig, lq, 'Neck', 1.5 * k, 0, 0); add_euler(rig, lq, 'Head', 1.6 * k, 0, 0)
    add_euler(rig, lq, 'LeftShoulder', 0, 0, 5 * k); add_euler(rig, lq, 'RightShoulder', 0, 0, -5 * k)
    root[:, 2] -= 0.012 * k
    root[:, 1] -= 0.006 * k
    gq = aim_frames(rig, G, lq, root, t)
    # thumb press on the right grip before the launch
    lq2 = rig.local(gq)
    pr = bump(t, 0.0, 0.06, 0.16, 0.3)
    I = rig.I
    lq2[:, I['RThumb']] = qmul(lq2[:, I['RThumb']], np.array([qaxis(rig.hand['Right']['t'], np.radians(18 * a)) for a in pr]))
    gq = rig.global_from_local(lq2)
    gq, root = pose_blend_to(rig, gq, root, rig.local(aim_frames(rig, G, G.lq[None], G.root[None], np.zeros(1)))[0], G.root, t, dur - 0.25, dur)
    return to_clip('atgm_fire', rig, gq, root, False,
                   notes=f'ATGM launch: thumb on the launch button (0-0.16 s), missile leaves the muzzle at {t_launch:.2f} s (launch event: muzzle flash / '
                         f'backblast / hide nothing - the spent TLC stays on the cradle until atgm_reload removes it), blast flinch (shoulders up, head '
                         f'jerk, 1.2 cm back), eye back on the sight by 0.5 s and tracking (SACLOS) to the end; first/last frame == atgm_aim frame 0',
                   events={'button': 0.0, 'launch': t_launch})


# ====================================================================== scripted clips (props in the hands)
STAND = dict(root=np.array([0.0, 0.931, 0.006]), feet={'Left': ('foot', 0.12, 0.07, -8.0), 'Right': ('foot', -0.12, -0.05, -25.0)})


def P(rig, root, fwd=0.0, yaw=0.0, roll=0.0, hip_fwd=None, hip_yaw=None, neck=(0, 0, 0), head=(0, 0, 0), shL=(0, 0, 0), shR=(0, 0, 0)):
    """trunk pose: forward bend / twist (+ = to the left) / side bend (+ = to the right) spread over Hips..Spine1"""
    hf = fwd * 0.3 if hip_fwd is None else hip_fwd
    hy = yaw * 0.25 if hip_yaw is None else hip_yaw
    rf = fwd - hf; ry = yaw - hy
    return pose_lq(rig, root, Hips=(hf, hy, roll * 0.15), LowerBack=(rf * 0.3, ry * 0.3, roll * 0.3), Spine=(rf * 0.36, ry * 0.36, roll * 0.3),
                   Spine1=(rf * 0.34, ry * 0.34, roll * 0.25), Neck=(neck[0] * 0.5, neck[1] * 0.5, neck[2] * 0.5),
                   Neck1=(neck[0] * 0.5, neck[1] * 0.5, neck[2] * 0.5), Head=head, LeftShoulder=shL, RightShoulder=shR)


def stand_pose(rig, **kw):
    return P(rig, STAND['root'], **dict(dict(fwd=3.0, yaw=0.0, hip_yaw=-8.0, neck=(-2, 2, 0), head=(-2, 2, 0)), **kw))


def relaxed(rig, side):
    """hand hanging relaxed at the side (chest-relative bind coords)"""
    sx = 1.0 if side == 'Left' else -1.0
    return ('chest', np.array([sx * 0.25, 0.86, 0.06]), hand_q(rig, side, np.array([sx * 0.1, -1.0, 0.25]), np.array([-sx * 1.0, 0, 0.1])))


POLE_DN = {'Right': np.array([-0.35, -0.55, -0.20]), 'Left': np.array([0.35, -0.55, -0.20])}
POLE_UP = {'Right': np.array([-0.45, 0.25, -0.25]), 'Left': np.array([0.45, 0.25, -0.25])}
POLE_OUT = {'Right': np.array([-0.55, -0.25, -0.05]), 'Left': np.array([0.55, -0.25, -0.05])}
POLE_BK = {'Right': np.array([-0.30, 0.05, -0.55]), 'Left': np.array([0.30, 0.05, -0.55])}
POLE_FU = {'Right': np.array([-0.35, 0.30, 0.45]), 'Left': np.array([0.35, 0.30, 0.45])}


def nat_from_grab(q, grab_world, grab_nat):
    """object pose (q, origin) that puts its natural-frame point grab_nat at grab_world"""
    return q, np.asarray(grab_world, float) - qrot(q, np.asarray(grab_nat, float))


def tube_hold(rig, kind, who):
    """palm points + global-in-tube hand rotations on a TLC (node frame: centre, axis +Z).  who = 'gunner' (behind / left of
    the tube: right palm on the carry handle, fingers to the left, left palm on the left side near the rear) or 'loader' (on
    the tube's right side facing it: left palm on the carry handle, right palm on the near (right) side, fingers under)"""
    k = LY.K(kind); r = k['tube_r']
    hz = -0.255 if kind == 'kornet' else -0.05             # carry handle bar (Kornet) / strap peak (Stugna)
    hy = 0.116 if kind == 'kornet' else 0.112
    if who == 'gunner_side':   # standing on the tube's right side (packing): right palm on the near side at the rear, left palm on top
        R = (np.array([-(r * 0.55 + 0.008), r * 0.83 + 0.010, -0.50]), hand_q(rig, 'Right', np.array([0.83, 0.55, 0.15]), np.array([0.55, -0.83, 0])))
        L = (np.array([-0.012, r + 0.012, -0.20]), hand_q(rig, 'Left', np.array([0.92, -0.38, 0.05]), np.array([0.0, -1.0, 0])))
        return {'Right': R, 'Left': L}
    if who == 'gunner':
        R = (np.array([-(r * 0.55 + 0.008), r * 0.83 + 0.010, -0.40]), hand_q(rig, 'Right', np.array([0.83, 0.55, 0.15]), np.array([0.55, -0.83, 0])))
        L = (np.array([r * 0.55 + 0.008, r * 0.83 + 0.010, -0.15]), hand_q(rig, 'Left', np.array([-0.83, 0.55, 0.15]), np.array([-0.55, -0.83, 0])))
    else:
        hz2 = hz if kind == 'kornet' else -0.17
        hy2 = hy if kind == 'kornet' else r + 0.02
        L = (np.array([-0.010, hy2 + 0.020, hz2]), hand_q(rig, 'Left', np.array([1.0, -0.35, 0]), np.array([0.25, -1.0, 0])))
        R = (np.array([-(r * 0.55 + 0.008), r * 0.83 + 0.010, 0.15]), hand_q(rig, 'Right', np.array([0.83, 0.55, 0.15]), np.array([0.55, -0.83, 0])))
    return {'Right': R, 'Left': L}


class Script:
    """keyframed clip with props: body (trunk/root poses), legs (contacts), objects (prop paths), hands (targets), head look"""
    def __init__(self, rig, lm, name, dur):
        self.rig = rig; self.lm = lm; self.name = name; self.dur = dur
        self.F, self.t = tgrid(dur)
        self.body = []; self.legk = {'Left': [], 'Right': []}; self.objk = {}; self.handk = {'Left': [], 'Right': []}
        self.lookk = []; self.events = {}; self.final = None; self.post = None; self.curl = {}; self.unwind = {}

    def apply_retime(self):
        """self.retime = [(t_old, t_new), ...] (piecewise linear, monotonic): stretch / squeeze segments of the authored timeline
        (every key time, event and unwind window is remapped) without rewriting each number"""
        R = getattr(self, 'retime', None)
        if not R:
            return
        xo = np.array([0.0] + [a for a, b in R] + [self.dur]); xn = np.array([0.0] + [b for a, b in R] + [self.dur])
        m = lambda v: float(np.interp(v, xo, xn))
        self.body = [(m(k[0]),) + tuple(k[1:]) for k in self.body]
        self.legk = {sd: [(m(k[0]),) + tuple(k[1:]) for k in ks] for sd, ks in self.legk.items()}
        self.objk = {n: [(m(k[0]),) + tuple(k[1:]) for k in ks] for n, ks in self.objk.items()}
        self.handk = {sd: [(m(k[0]),) + tuple(k[1:]) for k in ks] for sd, ks in self.handk.items()}
        self.lookk = [(m(k[0]),) + tuple(k[1:]) for k in self.lookk]
        self.events.update({k: round(m(v), 3) for k, v in self.events.items() if isinstance(v, (int, float))})
        self.unwind = {sd: (m(a), m(b)) for sd, (a, b) in self.unwind.items()}
        self.retime = None

    def run(self):
        self.apply_retime()
        rig, t = self.rig, self.t
        lq, root = body_track(rig, t, self.body)
        if self.post:
            lq, root = self.post(lq, root)
        gq = rig.global_from_local(lq)
        gq = legs(rig, gq, root, t, self.legk)
        B = Body(rig, gq, root)
        objs = {n: obj_track(B, t, k) for n, k in self.objk.items()}
        if self.lookk:
            kt = np.array([k[0] for k in self.lookk])
            Pt = np.zeros((len(kt), self.F, 3)); Wt = np.zeros((len(kt), self.F, 1))
            for k, (tk, spec, w) in enumerate(self.lookk):
                if spec[0] == 'obj':
                    oq, op = objs[spec[1]]; Pt[k] = op + qrot(oq, bc(spec[2], self.F))
                elif spec[0] == 'chest':
                    Pt[k] = B.chest(spec[1])[1]
                else:
                    Pt[k] = bc(spec[1], self.F)
                Wt[k] = w
            gq = look_at(rig, gq, root, blend(t, kt, Pt), blend(t, kt, Wt)[:, 0])
            B = Body(rig, gq, root)
        grips = {}
        self.err = {}; tg = {}
        for side in ('Right', 'Left'):
            palm, hq, pole, grip = hand_keys(B, t, self.handk[side], objs, side)
            tg[side] = (palm, hq, grip)
            win = self.unwind.get(side)
            canon = ramp(t, *win) if win else np.zeros(self.F)
            gq = arms_hist(rig, gq, root, side, palm, hq, pole, canon)
            grips[side] = grip
            H = rig.hand[side]
            gp = fk_global(rig.sk, gq, root)
            got = gp[:, rig.I[side + 'Hand']] + qrot(gq[:, rig.I[side + 'Hand']], bc(H['palm'] - H['wrist'], self.F))
            self.err[side] = np.linalg.norm(got - palm, axis=1)
        gq = fingers(rig, gq, grips, self.curl)
        gq = despike(rig, gq, hold={sd: tg[sd][2] > 0.5 for sd in tg})
        gq = despike(rig, gq, HEAD_BONES, thresh=12.0, half=5)
        gq = smooth_arm_swivel(rig, gq, root)
        if self.final is not None:
            lq_t, root_t, t0, t1 = self.final
            gq, root = pose_blend_to(rig, gq, root, lq_t, root_t, t, t0, t1)
        self.gq, self.root, self.objs = gq, root, objs
        global _last
        _last = self
        return gq, root

    def fr(self, ev):
        return int(round(self.events[ev] * FPS))

    def prop(self, node, obj, socket, ev_from, ev_to, before, after, nat2node=None, glb=None, other=None):
        """prop record: node transform in the socket frame while held (checked constant over the hold window)"""
        rig = self.rig
        gp = fk_global(rig.sk, self.gq, self.root)
        sq, sp = socket_world(rig, self.gq, gp, socket)
        oq, op = self.objs[obj]
        if nat2node is not None:
            oq, op = xf_mul(oq, op, *nat2node)
        iq, ip = xf_inv(sq, sp)
        lq_, lp_ = xf_mul(iq, ip, oq, op)
        f0, f1 = self.fr(ev_from), self.fr(ev_to)
        ang = np.degrees(2 * np.arccos(np.clip(np.abs(np.sum(lq_[f0:f1 + 1] * lq_[f0], -1)), 0, 1)))
        dev = np.linalg.norm(lp_[f0:f1 + 1] - lp_[f0], axis=1)
        rec = dict(node=node, socket=socket, from_event=ev_from, to_event=ev_to,
                   t=[round(float(v), 5) for v in lp_[f0]], q=[round(float(v), 6) for v in qnorm(lq_[f0])], before=before, after=after,
                   hold_drift=dict(pos_m=round(float(dev.max()), 4), rot_deg=round(float(ang.max()), 2)))
        if glb:
            rec['glb'] = glb
        if other:
            rec['other_hand'] = other
        w = {}
        for side in ('Right', 'Left'):
            e = self.err[side][f0:f1 + 1]
            w[side] = round(float(e.max()), 4)
        rec['palm_err_m'] = w
        # exact per-frame path of the node over the hold window in the clip (= soldier root) frame: the game drives the prop from
        # this track (sampled at the clip time) instead of rigidly parenting it to the hand, so prop and hands stay together even
        # where the grip slides / rotates on it
        rec['track'] = dict(f0=f0, f1=f1, fps=FPS, p=np.round(op[f0:f1 + 1], 4).reshape(-1).tolist(), q=np.round(qnorm(oq[f0:f1 + 1]), 4).reshape(-1).tolist())
        return rec


def gunner_aim_frame(rig, G):
    """atgm_aim frame 0 (legs + arms solved) as (lq, root) for exact end / start matching"""
    gq = aim_frames(rig, G, G.lq[None], G.root[None], np.zeros(1))
    return rig.local(gq)[0], G.root.copy()


def kneel_root(rig, G, hip_y, lq1, x=0.0):
    return np.array([x, hip_y, hip_z_on_knees(rig, lq1, hip_y, G.knees, x)])


def tall(rig, G, hip_y, **kw):
    """kneeling on both knees (the aim pose's knee spots), hips at hip_y"""
    lq, _ = P(rig, np.zeros(3), **kw)
    return lq, kneel_root(rig, G, hip_y, lq)


def atgm_setup_kornet(rig, lm, G, dur=6.0):
    kind = 'kornet'; K_ = LY.KORNET; L0 = K_['L0']
    S = Script(rig, lm, 'atgm_setup', dur)
    ev = S.events = dict(unsling=0.65, plant=2.10, tube_pick=2.90, tube_on=4.10, deployed=5.60)
    aim_lq, aim_root = gunner_aim_frame(rig, G)
    SR = np.array([-0.24, 0.0, 0.13])        # side-step right of the cradle for the TLC (head clear of the overhanging tube)
    S.body = [(0.00, stand_pose(rig)),
              (0.30, stand_pose(rig, fwd=6, yaw=14, roll=-3, neck=(8, 16, 0), head=(4, 10, 0), shR=(0, 0, -5))),
              (0.65, stand_pose(rig, fwd=4, yaw=12, roll=-3, neck=(6, 14, 0), head=(4, 8, 0), shR=(0, 0, -6))),
              (0.95, stand_pose(rig, fwd=2, yaw=-20, roll=4, neck=(0, -14, 0), head=(0, -10, 0), shR=(0, 0, -4))),
              (1.30, stand_pose(rig, fwd=12, neck=(10, 0, 0), head=(8, 0, 0))),
              (1.75, P(rig, STAND['root'] + [0, -0.06, -0.04], fwd=24, hip_yaw=-6, neck=(10, 0, 0), head=(8, 0, 0))),
              (ev['plant'], P(rig, STAND['root'] + [0, -0.08, -0.05], fwd=30, hip_yaw=-6, neck=(8, 0, 0), head=(6, 0, 0))),
              (2.45, P(rig, np.array([-0.20, 0.70, 0.05]), fwd=35, yaw=-30, hip_yaw=-25, neck=(10, -6, 0))),
              (ev['tube_pick'], P(rig, np.array([-0.32, 0.40, 0.04]), fwd=68, yaw=-50, hip_yaw=-30, roll=12, neck=(10, -6, 0), head=(6, 0, 0))),
              (3.35, P(rig, np.array([-0.26, 0.72, 0.08]), fwd=25, yaw=-10, hip_yaw=-10)),
              (3.75, P(rig, SR + [0, 0.91, 0], fwd=10, yaw=18, hip_yaw=10, neck=(-6, 4, 0), head=(-6, 4, 0))),
              (ev['tube_on'], P(rig, SR + [0, 0.88, 0.07], fwd=26, yaw=24, hip_yaw=12, neck=(4, 6, 0), head=(4, 4, 0))),
              (4.35, P(rig, SR + [0, 0.90, 0.04], fwd=18, yaw=20, hip_yaw=12)),
              (4.75, stand_pose(rig, fwd=8)),
              (5.05, P(rig, np.array([0.0, 0.62, -0.08]), fwd=16, hip_yaw=-6, neck=(8, 0, 0), head=(6, 0, 0))),
              (5.30, tall(rig, G, 0.42, fwd=18)),
              (5.55, (aim_lq, aim_root)), (dur, (aim_lq, aim_root))]
    ks = G.kspec
    sL = ('foot', -0.10, 0.16, -10.0); sR = ('foot', -0.44, -0.02, -32.0)
    pL = ('foot', -0.10, 0.36, -25.0); pRk = ('knee', -0.32, 0.14, -35.0)
    S.legk = {'Left': [(0.0, STAND['feet']['Left']), (2.20, STAND['feet']['Left']), (2.55, pL), (3.30, pL), (3.55, sL), (4.40, sL), (4.75, STAND['feet']['Left']),
                       (5.05, STAND['feet']['Left']), (5.35, ks['Left'])],
              'Right': [(0.0, STAND['feet']['Right']), (2.30, STAND['feet']['Right']), (2.65, pRk), (3.20, pRk), (3.50, sR), (4.45, sR), (4.80, STAND['feet']['Right']),
                        (4.85, STAND['feet']['Right']), (5.15, ks['Right'])]}
    # folded launcher (natural frame): back -> over the right shoulder -> upright in front -> planted at L0
    Sx = LY.folded_nat_to_sock(kind); qS = qfrom_mat(Sx[0])
    gR, hR, pR = LY.FOLD_GRAB[kind]['R']; gL = LY.FOLD_GRAB[kind]['L'][0]
    S.objk['fold'] = [(0.0, ('back_nat', qS, Sx[1])), (ev['unsling'], ('back_nat', qS, Sx[1])),
                      (0.80, ('chest_grab', yawq(300), np.array([-0.42, 1.18, -0.20]), gR)),
                      (0.98, ('chest_grab', yawq(270), np.array([-0.36, 1.08, 0.06]), gR)),
                      (1.30, ('chest_grab', ID, np.array([-0.10, 1.26, 0.40]), gR)),
                      (1.80, ('world',) + nat_from_grab(ID, L0 + gR + [0, 0.07, -0.02], gR)),
                      (ev['plant'], ('world', ID, L0))]
    ts = LY.TUBE_SETUP_G[kind] + [0, K_['tube_r_end'], 0]
    tm = LY.tube_mount(kind)[0] + L0
    S.objk['tube'] = [(0.0, ('world', ID, ts)), (ev['tube_pick'], ('world', ID, ts)),
                      (3.35, ('world', ID, np.array([-0.64, 0.84, 0.64]))),
                      (3.75, ('world', ID, np.array([-0.30, 1.38, 0.82]))),
                      (ev['tube_on'], ('world', ID, tm))]
    TH = tube_hold(rig, kind, 'gunner')
    hqR = hand_q(rig, 'Right', hR, pR)
    S.handk['Right'] = [(0.0, relaxed(rig, 'Right'), POLE_DN['Right'], 0.2),
                        (0.22, ('chest', np.array([-0.15, 1.40, 0.13]), hand_q(rig, 'Right', np.array([0, 1.0, 0.15]), np.array([0, 0, -1.0]))), POLE_DN['Right'], 0.8),
                        (0.42, ('chest', np.array([-0.20, 1.38, 0.17]), hand_q(rig, 'Right', np.array([0, 1.0, 0.15]), np.array([0, 0, -1.0]))), POLE_DN['Right'], 0.8),
                        (ev['unsling'], ('chest', np.array([-0.32, 1.26, 0.22]), hand_q(rig, 'Right', np.array([0, 1.0, 0.15]), np.array([0, 0, -1.0]))), POLE_DN['Right'], 0.8),
                        (0.98, ('obj', 'fold', gR, hqR), POLE_DN['Right'], 1.0),
                        (ev['plant'], ('obj', 'fold', gR, hqR), POLE_OUT['Right'], 1.0),
                        (ev['tube_pick'], ('obj', 'tube') + TH['Right'], POLE_BK['Right'], 1.0),
                        (ev['tube_on'], ('obj', 'tube') + TH['Right'], POLE_DN['Right'], 1.0),
                        (4.35, ('obj', 'tube', TH['Right'][0] + [0, 0.03, 0], TH['Right'][1]), POLE_DN['Right'], 0.4),
                        G.grip_keys('Right', 5.40), G.grip_keys('Right', dur)]
    S.handk['Left'] = [(0.0, relaxed(rig, 'Left'), POLE_DN['Left'], 0.2), (1.00, relaxed(rig, 'Left'), POLE_DN['Left'], 0.2),
                       (1.30, ('obj', 'fold', gL, G.hq['Left']), G.pole['Left'], 1.0),
                       (ev['plant'], ('obj', 'fold', gL, G.hq['Left']), G.pole['Left'], 1.0),
                       (ev['tube_pick'], ('obj', 'tube') + TH['Left'], POLE_DN['Left'], 1.0),
                       (ev['tube_on'], ('obj', 'tube') + TH['Left'], POLE_DN['Left'], 1.0),
                       (4.35, ('obj', 'tube', TH['Left'][0] + [0.03, 0, 0], TH['Left'][1]), POLE_DN['Left'], 0.4),
                       G.grip_keys('Left', 5.40), G.grip_keys('Left', dur)]
    S.lookk = [(0.0, ('chest', np.array([0.0, 1.6, 2.0])), 0.0), (0.40, ('obj', 'fold', gR), 0.25), (0.95, ('obj', 'fold', gR), 0.6),
               (1.50, ('world', L0 + [0, 0.3, 0]), 0.7), (2.40, ('world', L0 + [0, 0.5, 0]), 0.5), (3.10, ('obj', 'tube', np.zeros(3)), 0.8),
               (4.00, ('world', tm), 0.6), (4.60, ('world', LY.EYE + [0, -0.3, 1.0]), 0.3), (5.30, ('world', LY.EYE + [0, 0, 1.0]), 0.0),
               (dur, ('world', LY.EYE + [0, 0, 1.0]), 0.0)]
    S.final = (aim_lq, aim_root, 5.55, 5.75)
    S.unwind = {'Right': (4.45, 5.35), 'Left': (4.45, 5.35)}
    S.retime = [(2.90, 2.90), (4.10, 4.30), (5.55, 5.62)]
    S.run()
    nat2node = (qinv(qS), -qrot(qinv(qS), Sx[1]))
    props = [S.prop('folded', 'fold', 'weapon_socket', 'unsling', 'plant', {'attach': 'weapon_socket_back'}, {'attach': 'hidden'}, nat2node=nat2node),
             S.prop('kornet_tube', 'tube', 'weapon_socket', 'tube_pick', 'tube_on', {'attach': 'launcher', 'empty': 'tube_setup'}, {'attach': 'launcher'},
                    other=dict(side='Left', palm_local=np.round(TH['Left'][0], 4).tolist()))]
    lnodes = [dict(node='kornet_tripod', show='plant', hide=None)]
    return to_clip('atgm_setup', rig, S.gq, S.root, False,
                   notes=(f'Kornet gunner sets the launcher up ({dur:.1f} s, in place, ends == atgm_aim frame 0): right hand over the right shoulder to the '
                          f'folded launcher on his back (unsling {ev["unsling"]} s: re-parent node `folded` to weapon_socket), swings it round the right side to the '
                          f'front (it turns 180 deg), left hand on its left control handle, bends and stands it on its legs in front of him '
                          f'(plant {ev["plant"]} s: hide `folded`, show `kornet_tripod` - the deployed launcher is exactly where the folded one stood); side-steps '
                          f'right, squats and picks up the TLC lying on the ground there (tube_pick {ev["tube_pick"]} s, launcher empty tube_setup), lifts it and '
                          f'lays it onto the cradle from the right, standing beside it with his head clear of the overhanging tube (tube_on {ev["tube_on"]} s: back '
                          f'to its own place in the launcher), steps back behind the sight, kneels (right knee, then left) into the aim pose (deployed '
                          f'{ev["deployed"]} s). Rifle on weapon_socket_back throughout. palm err {_pe(S)}'),
                   events=ev, extra=dict(props=props, launcher_nodes=lnodes, launcher='kornet'))


def _pe(S):
    return {k: round(float(v.max()), 3) for k, v in S.err.items()}


def atgm_pack_kornet(rig, lm, G, dur=3.5):
    kind = 'kornet'; K_ = LY.KORNET; L0 = K_['L0']
    S = Script(rig, lm, 'atgm_pack', dur)
    ev = S.events = dict(tube_off=0.80, tube_down=1.62, fold=2.00, sling=2.64)
    aim_lq, aim_root = gunner_aim_frame(rig, G)
    SR = np.array([-0.24, 0.0, 0.13])
    S.body = [(0.00, (aim_lq, aim_root)),
              (0.25, tall(rig, G, 0.42, fwd=12, roll=8)),
              (0.55, P(rig, SR + [0, 0.86, 0.02], fwd=20, yaw=18, hip_yaw=10, neck=(4, 6, 0))),
              (ev['tube_off'], P(rig, SR + [0, 0.88, 0.07], fwd=26, yaw=24, hip_yaw=12, neck=(4, 6, 0), head=(4, 4, 0))),
              (1.02, P(rig, SR + [0, 0.93, 0.0], fwd=8, yaw=10, hip_yaw=6, neck=(-10, 0, 0), head=(-8, 0, 0))),
              (1.30, P(rig, np.array([-0.38, 0.80, 0.06]), fwd=26, yaw=-26, hip_yaw=-14, roll=4, neck=(6, -6, 0), head=(4, -4, 0))),
              (ev['tube_down'], P(rig, np.array([-0.32, 0.40, 0.04]), fwd=68, yaw=-50, hip_yaw=-30, roll=12, neck=(10, -6, 0), head=(6, 0, 0))),
              (1.86, P(rig, STAND['root'] + [0, -0.08, -0.05], fwd=30, hip_yaw=-6, neck=(8, 0, 0), head=(6, 0, 0))),
              (ev['fold'], P(rig, STAND['root'] + [0, -0.08, -0.05], fwd=30, hip_yaw=-6, neck=(8, 0, 0), head=(6, 0, 0))),
              (2.22, stand_pose(rig, fwd=12, neck=(10, 0, 0), head=(8, 0, 0))),
              (2.46, stand_pose(rig, fwd=2, yaw=-20, roll=4, neck=(0, -14, 0), head=(0, -10, 0), shR=(0, 0, -4))),
              (ev['sling'], stand_pose(rig, fwd=4, yaw=12, roll=-3, neck=(6, 14, 0), head=(4, 8, 0), shR=(0, 0, -6))),
              (dur, stand_pose(rig))]
    ks = G.kspec
    sL = ('foot', -0.10, 0.16, -10.0); sR = ('foot', -0.44, -0.02, -32.0)
    pL = ('foot', -0.10, 0.36, -25.0); pRk = ('knee', -0.32, 0.14, -35.0)
    S.legk = {'Left': [(0.0, ks['Left']), (0.25, ks['Left']), (0.55, sL), (1.22, sL), (1.60, pL), (1.80, pL), (1.97, STAND['feet']['Left'])],
              'Right': [(0.0, ks['Right']), (0.30, ks['Right']), (0.62, sR), (1.18, sR), (1.57, pRk), (1.78, pRk), (2.00, STAND['feet']['Right'])]}
    Sx = LY.folded_nat_to_sock(kind); qS = qfrom_mat(Sx[0])
    gR, hR, pR = LY.FOLD_GRAB[kind]['R']; gL = LY.FOLD_GRAB[kind]['L'][0]
    S.objk['fold'] = [(0.0, ('world', ID, L0)), (ev['fold'], ('world', ID, L0)),
                      (2.22, ('chest_grab', ID, np.array([-0.10, 1.26, 0.40]), gR)),
                      (2.34, ('chest_grab', yawq(270), np.array([-0.36, 1.08, 0.06]), gR)),
                      (2.46, ('chest_grab', yawq(300), np.array([-0.42, 1.18, -0.20]), gR)),
                      (ev['sling'], ('back_nat', qS, Sx[1])), (dur, ('back_nat', qS, Sx[1]))]
    ts = LY.TUBE_SETUP_G[kind] + [0, K_['tube_r_end'], 0]
    tm = LY.tube_mount(kind)[0] + L0
    S.objk['tube'] = [(0.0, ('world', ID, tm)), (ev['tube_off'], ('world', ID, tm)),
                      (0.98, ('world', ID, tm + [0.0, 0.20, -0.03])), (1.16, ('world', ID, np.array([-0.48, 1.44, 0.80]))),
                      (1.38, ('world', ID, np.array([-0.76, 1.02, 0.70]))),
                      (ev['tube_down'], ('world', ID, ts))]
    TH = tube_hold(rig, kind, 'gunner_side')
    hqR = hand_q(rig, 'Right', hR, pR)
    S.handk['Right'] = [G.grip_keys('Right', 0.0), G.grip_keys('Right', 0.20), (ev['tube_off'], ('obj', 'tube') + TH['Right'], POLE_DN['Right'], 1.0),
                        (ev['tube_down'], ('obj', 'tube') + TH['Right'], POLE_BK['Right'], 1.0),
                        (ev['fold'], ('obj', 'fold', gR, hqR), POLE_DN['Right'], 1.0),
                        (2.22, ('obj', 'fold', gR, hqR), POLE_DN['Right'], 1.0),
                        (ev['sling'] - 0.14, ('chest', np.array([-0.32, 1.26, 0.22]), hand_q(rig, 'Right', np.array([0, 1.0, 0.15]), np.array([0, 0, -1.0]))), POLE_DN['Right'], 0.8),
                        (ev['sling'], ('chest', np.array([-0.15, 1.40, 0.13]), hand_q(rig, 'Right', np.array([0, 1.0, 0.15]), np.array([0, 0, -1.0]))), POLE_DN['Right'], 0.8),
                        (dur, relaxed(rig, 'Right'), POLE_DN['Right'], 0.2)]
    S.handk['Left'] = [G.grip_keys('Left', 0.0), G.grip_keys('Left', 0.20), (0.74, ('obj', 'tube') + TH['Left'], POLE_DN['Left'], 1.0),
                       (ev['tube_down'], ('obj', 'tube') + TH['Left'], POLE_DN['Left'], 1.0),
                       (1.80, relaxed(rig, 'Left'), POLE_DN['Left'], 0.3),
                       (ev['fold'], ('obj', 'fold', gL, G.hq['Left']), G.pole['Left'], 1.0),
                       (2.22, ('obj', 'fold', gL, G.hq['Left']), G.pole['Left'], 1.0),
                       (2.46, relaxed(rig, 'Left'), POLE_DN['Left'], 0.2), (dur, relaxed(rig, 'Left'), POLE_DN['Left'], 0.2)]
    S.lookk = [(0.0, ('world', LY.EYE + [0, 0, 1.0]), 0.0), (0.5, ('world', tm), 0.5), (1.0, ('obj', 'tube', np.zeros(3)), 0.6), (1.35, ('obj', 'tube', np.zeros(3)), 0.8),
               (1.7, ('world', L0 + [0, 0.5, 0]), 0.5), (2.15, ('obj', 'fold', gR), 0.4), (2.6, ('chest', np.array([0.0, 1.6, 2.0])), 0.0)]
    S.unwind = {'Right': (2.66, 2.98), 'Left': (2.40, 2.98)}
    S.retime = [(1.38, 1.55), (1.62, 1.95), (2.00, 2.38), (2.64, 3.05), (2.99, 3.49)]
    S.run()
    nat2node = (qinv(qS), -qrot(qinv(qS), Sx[1]))
    props = [S.prop('kornet_tube', 'tube', 'weapon_socket', 'tube_off', 'tube_down', {'attach': 'launcher'}, {'attach': 'launcher', 'empty': 'tube_setup'},
                    other=dict(side='Left', palm_local=np.round(TH['Left'][0], 4).tolist())),
             S.prop('folded', 'fold', 'weapon_socket', 'fold', 'sling', {'attach': 'hidden'}, {'attach': 'weapon_socket_back'}, nat2node=nat2node)]
    lnodes = [dict(node='kornet_tripod', show=None, hide='fold')]
    return to_clip('atgm_pack', rig, S.gq, S.root, False,
                   notes=(f'Kornet gunner packs up ({dur:.1f} s, in place, starts == atgm_aim frame 0, ends standing, hands free): gets up and side-steps right '
                          f'of the cradle, lifts the TLC off it (tube_off {ev["tube_off"]} s: re-parent `kornet_tube` to weapon_socket) and lays it on the ground to his right '
                          f'(tube_down {ev["tube_down"]} s: launcher empty tube_setup), steps back behind it, takes the launcher by the sight top + left handle (fold {ev["fold"]} s: hide '
                          f'`kornet_tripod`, show `folded` in weapon_socket - the folded one appears exactly where the deployed one stood), stands up, swings it '
                          f'round the right side over the shoulder onto his back (sling {ev["sling"]} s: `folded` to weapon_socket_back with identity - exact). '
                          f'The game removes the launcher (with the TLC left on the ground) when the clip ends. palm err {_pe(S)}'),
                   events=ev, extra=dict(props=props, launcher_nodes=lnodes, launcher='kornet'))


def atgm_setup_stugna(rig, lm, G, dur=6.0):
    kind = 'stugna'; K_ = LY.STUGNA; L0 = K_['L0']
    S = Script(rig, lm, 'atgm_setup_stugna', dur)
    ev = S.events = dict(unsling=0.65, plant=2.10, tube_pick=2.85, tube_on=3.80, control_on=5.05, deployed=5.45)
    aim_lq, aim_root = gunner_aim_frame(rig, G)
    S.body = [(0.00, stand_pose(rig)),
              (0.30, stand_pose(rig, fwd=6, yaw=14, roll=-3, neck=(8, 16, 0), head=(4, 10, 0), shR=(0, 0, -5))),
              (0.65, stand_pose(rig, fwd=4, yaw=12, roll=-3, neck=(6, 14, 0), head=(4, 8, 0), shR=(0, 0, -6))),
              (0.95, stand_pose(rig, fwd=2, yaw=-20, roll=4, neck=(0, -14, 0), head=(0, -10, 0), shR=(0, 0, -4))),
              (1.25, stand_pose(rig, fwd=10, neck=(8, 0, 0), head=(6, 0, 0))),
              (1.60, P(rig, np.array([-0.05, 0.8, 0.4]), fwd=22, hip_yaw=-4, neck=(6, 0, 0), head=(4, 0, 0))),
              (1.90, P(rig, np.array([-0.04, 0.71, 0.46]), fwd=34, yaw=0, neck=(6, 0, 0), head=(4, 0, 0))),
              (ev['plant'], P(rig, np.array([-0.04, 0.69, 0.48]), fwd=38, yaw=0, neck=(4, 0, 0), head=(2, 0, 0))),
              (2.50, P(rig, np.array([-0.36, 0.5, 0.32]), fwd=50, yaw=-14, roll=8, neck=(10, -10, 0), head=(6, -6, 0))),
              (ev['tube_pick'], P(rig, np.array([-0.40, 0.42, 0.32]), fwd=66, yaw=-34, hip_yaw=-14, roll=12, neck=(10, -10, 0), head=(6, -6, 0))),
              (3.30, P(rig, np.array([-0.27, 0.76, 0.43]), fwd=18, yaw=6, roll=4)),
              (3.55, P(rig, np.array([-0.27, 0.82, 0.46]), fwd=14, yaw=14, roll=4, neck=(-6, 0, 0), head=(-8, 0, 0))),
              (ev['tube_on'], P(rig, np.array([-0.27, 0.82, 0.48]), fwd=16, yaw=16, neck=(-4, 0, 0), head=(-6, 0, 0))),
              (4.05, P(rig, np.array([-0.27, 0.82, 0.46]), fwd=14, yaw=10, neck=(-2, 0, 0), head=(-4, 0, 0))),
              (4.45, stand_pose(rig, fwd=6)),
              (4.78, P(rig, np.array([0.0, 0.62, -0.08]), fwd=16, hip_yaw=-6, neck=(8, 0, 0), head=(6, 0, 0))),
              (ev['control_on'], tall(rig, G, 0.46, fwd=16)),
              (5.40, (aim_lq, aim_root)), (dur, (aim_lq, aim_root))]
    ks = G.kspec
    lung = ('foot', -0.12, 0.72, -8.0); toeR = ('toe', -0.40, 0.05, -25.0, 35.0)
    lungC = ('foot', 0.10, 0.72, -8.0); toeC = ('toe', -0.18, 0.05, -25.0, 35.0)
    S.legk = {'Left': [(0.0, STAND['feet']['Left']), (1.25, STAND['feet']['Left']), (1.60, lungC), (2.20, lungC), (2.45, lung), (4.05, lung), (4.45, STAND['feet']['Left']),
                       (4.80, STAND['feet']['Left']), (5.10, ks['Left'])],
              'Right': [(0.0, STAND['feet']['Right']), (1.35, STAND['feet']['Right']), (1.62, toeC),
                        (2.15, toeC), (2.50, ('knee', -0.46, 0.22, -20.0)), (3.05, ('knee', -0.46, 0.22, -20.0)),
                        (3.35, toeR), (4.05, toeR), (4.35, STAND['feet']['Right']), (4.55, STAND['feet']['Right']), (4.88, ks['Right'])]}
    Sx = LY.folded_nat_to_sock(kind); qS = qfrom_mat(Sx[0])
    gR, hR, pR = LY.FOLD_GRAB[kind]['R']; gL, hL, pL = LY.FOLD_GRAB[kind]['L']
    S.objk['fold'] = [(0.0, ('back_nat', qS, Sx[1])), (ev['unsling'], ('back_nat', qS, Sx[1])),
                      (0.80, ('chest_grab', yawq(300), np.array([-0.42, 1.18, -0.20]), gR)),
                      (0.98, ('chest_grab', yawq(270), np.array([-0.36, 1.08, 0.06]), gR)),
                      (1.25, ('chest_grab', ID, np.array([-0.08, 1.30, 0.42]), gR)),
                      (1.75, ('world',) + nat_from_grab(ID, L0 + gR + [0, 0.10, -0.03], gR)),
                      (ev['plant'], ('world', ID, L0))]
    ts = LY.TUBE_SETUP_G[kind] + [0, K_['tube_r_end'], 0]
    tm = LY.tube_mount(kind)[0] + L0
    S.objk['tube'] = [(0.0, ('world', ID, ts)), (ev['tube_pick'], ('world', ID, ts)),
                      (3.30, ('world', ID, np.array([-0.36, 0.95, 0.95]))),
                      (3.55, ('world', ID, np.array([-0.26, 1.37, 1.15]))),
                      (ev['tube_on'], ('world', ID, tm))]
    TH = tube_hold(rig, kind, 'gunner')
    hqR = hand_q(rig, 'Right', hR, pR); hqL = hand_q(rig, 'Left', hL, pL)
    S.handk['Right'] = [(0.0, relaxed(rig, 'Right'), POLE_DN['Right'], 0.2),
                        (0.22, ('chest', np.array([-0.15, 1.40, 0.13]), hand_q(rig, 'Right', np.array([0, 1.0, 0.15]), np.array([0, 0, -1.0]))), POLE_DN['Right'], 0.8),
                        (0.42, ('chest', np.array([-0.20, 1.38, 0.17]), hand_q(rig, 'Right', np.array([0, 1.0, 0.15]), np.array([0, 0, -1.0]))), POLE_DN['Right'], 0.8),
                        (ev['unsling'], ('chest', np.array([-0.32, 1.26, 0.22]), hand_q(rig, 'Right', np.array([0, 1.0, 0.15]), np.array([0, 0, -1.0]))), POLE_DN['Right'], 0.8),
                        (0.98, ('obj', 'fold', gR, hqR), POLE_DN['Right'], 1.0),
                        (ev['plant'], ('obj', 'fold', gR, hqR), POLE_OUT['Right'], 1.0),
                        (ev['tube_pick'], ('obj', 'tube') + TH['Right'], POLE_BK['Right'], 1.0),
                        (ev['tube_on'], ('obj', 'tube') + TH['Right'], POLE_DN['Right'], 1.0),
                        (3.98, ('obj', 'tube', TH['Right'][0] + [0, 0.03, 0], TH['Right'][1]), POLE_DN['Right'], 0.4),
                        (4.40, ('chest', np.array([-0.18, 1.02, 0.30]), G.hq['Right']), POLE_DN['Right'], 0.5),
                        G.grip_keys('Right', ev['control_on']), G.grip_keys('Right', dur)]
    S.handk['Left'] = [(0.0, relaxed(rig, 'Left'), POLE_DN['Left'], 0.2), (1.00, relaxed(rig, 'Left'), POLE_DN['Left'], 0.2),
                       (1.25, ('obj', 'fold', gL, hqL), POLE_DN['Left'], 1.0),
                       (ev['plant'], ('obj', 'fold', gL, hqL), POLE_DN['Left'], 1.0),
                       (ev['tube_pick'], ('obj', 'tube') + TH['Left'], POLE_DN['Left'], 1.0),
                       (ev['tube_on'], ('obj', 'tube') + TH['Left'], POLE_DN['Left'], 1.0),
                       (3.98, ('obj', 'tube', TH['Left'][0] + [0.03, 0, 0], TH['Left'][1]), POLE_DN['Left'], 0.4),
                       (4.40, ('chest', np.array([0.16, 1.02, 0.30]), G.hq['Left']), POLE_DN['Left'], 0.5),
                       G.grip_keys('Left', ev['control_on']), G.grip_keys('Left', dur)]
    S.lookk = [(0.0, ('chest', np.array([0.0, 1.6, 2.0])), 0.0), (0.40, ('obj', 'fold', gR), 0.25), (0.95, ('obj', 'fold', gR), 0.6),
               (1.50, ('world', L0 + [0, 0.3, 0]), 0.7), (2.10, ('world', L0 + [0, 0.5, 0]), 0.5), (2.70, ('obj', 'tube', np.zeros(3)), 0.8),
               (3.70, ('world', tm), 0.6), (4.40, ('world', LY.EYE + [0, -0.2, 1.0]), 0.3), (5.10, ('world', LY.EYE + [0, 0, 1.0]), 0.0),
               (dur, ('world', LY.EYE + [0, 0, 1.0]), 0.0)]
    S.final = (aim_lq, aim_root, 5.35, 5.55)
    S.unwind = {'Right': (4.10, 5.05), 'Left': (4.10, 5.05)}
    S.retime = [(2.85, 2.85), (3.80, 4.08), (5.05, 5.15), (5.45, 5.52)]
    S.run()
    nat2node = (qinv(qS), -qrot(qinv(qS), Sx[1]))
    props = [S.prop('folded', 'fold', 'weapon_socket', 'unsling', 'plant', {'attach': 'weapon_socket_back'}, {'attach': 'hidden'}, nat2node=nat2node),
             S.prop('stugna_tube', 'tube', 'weapon_socket', 'tube_pick', 'tube_on', {'attach': 'launcher', 'empty': 'tube_setup'}, {'attach': 'launcher'},
                    other=dict(side='Left', palm_local=np.round(TH['Left'][0], 4).tolist()))]
    lnodes = [dict(node='stugna_tripod', show='plant', hide=None), dict(node='stugna_control', show='control_on', hide=None),
              dict(node='stugna_cable', show='control_on', hide=None)]
    return to_clip('atgm_setup_stugna', rig, S.gq, S.root, False,
                   notes=(f'Stugna-P gunner sets up ({dur:.1f} s, in place - steps forward and back -, ends == atgm_aim frame 0): unslings the folded launcher over '
                          f'the right shoulder (unsling {ev["unsling"]} s), steps forward with the left foot and stands it on its legs 1.06 m ahead (plant '
                          f'{ev["plant"]} s: hide `folded`, show `stugna_tripod`), picks up the R-2 TLC from the ground to his right (tube_pick {ev["tube_pick"]} s, '
                          f'empty tube_setup), lays it into the yoke from the right (tube_on {ev["tube_on"]} s), steps back, kneels behind the remote control unit and '
                          f'takes its grips (control_on {ev["control_on"]} s: show `stugna_control` + `stugna_cable`), settles into the aim pose (deployed '
                          f'{ev["deployed"]} s). palm err {_pe(S)}'),
                   events=ev, extra=dict(props=props, launcher_nodes=lnodes, launcher='stugna'))


def atgm_pack_stugna(rig, lm, G, dur=3.5):
    kind = 'stugna'; K_ = LY.STUGNA; L0 = K_['L0']
    S = Script(rig, lm, 'atgm_pack_stugna', dur)
    ev = S.events = dict(control_off=0.25, tube_off=0.85, tube_down=1.35, fold=1.65, sling=2.58)
    aim_lq, aim_root = gunner_aim_frame(rig, G)
    S.body = [(0.00, (aim_lq, aim_root)),
              (0.25, tall(rig, G, 0.40, fwd=12, roll=10)),
              (0.55, P(rig, np.array([-0.08, 0.46, 0.25]), fwd=14, roll=10, neck=(4, 0, 0))),
              (ev['tube_off'], P(rig, np.array([-0.27, 0.82, 0.48]), fwd=16, yaw=16, neck=(-4, 0, 0), head=(-6, 0, 0))),
              (1.05, P(rig, np.array([-0.27, 0.82, 0.46]), fwd=14, yaw=14, roll=4, neck=(-6, 0, 0), head=(-8, 0, 0))),
              (ev['tube_down'], P(rig, np.array([-0.40, 0.42, 0.32]), fwd=66, yaw=-34, hip_yaw=-14, roll=12, neck=(10, -10, 0), head=(6, -6, 0))),
              (ev['fold'], P(rig, np.array([-0.04, 0.69, 0.48]), fwd=38, yaw=0, neck=(4, 0, 0), head=(2, 0, 0))),
              (2.05, P(rig, np.array([-0.05, 0.8, 0.4]), fwd=20, yaw=0, neck=(6, 0, 0))),
              (2.30, stand_pose(rig, fwd=10, neck=(8, 0, 0), head=(6, 0, 0))),
              (2.46, stand_pose(rig, fwd=2, yaw=-20, roll=4, neck=(0, -14, 0), head=(0, -10, 0), shR=(0, 0, -4))),
              (ev['sling'], stand_pose(rig, fwd=4, yaw=12, roll=-3, neck=(6, 14, 0), head=(4, 8, 0), shR=(0, 0, -6))),
              (dur, stand_pose(rig))]
    ks = G.kspec
    lung = ('foot', -0.12, 0.72, -8.0); toe = ('toe', -0.40, 0.05, -25.0, 35.0)
    lungC = ('foot', 0.10, 0.72, -8.0); toeC = ('toe', -0.18, 0.05, -25.0, 35.0)
    S.legk = {'Left': [(0.0, ks['Left']), (0.25, ks['Left']), (0.55, ('foot', 0.12, 0.62, -8.0)), (0.85, lung), (1.42, lung), (1.62, lungC), (2.0, lungC), (2.30, STAND['feet']['Left'])],
              'Right': [(0.0, ks['Right']), (0.55, ks['Right']), (0.85, toe), (1.08, toe), (1.30, ('knee', -0.46, 0.22, -20.0)), (1.42, ('knee', -0.46, 0.22, -20.0)),
                        (1.68, toeC), (2.05, toeC), (2.32, STAND['feet']['Right'])]}
    Sx = LY.folded_nat_to_sock(kind); qS = qfrom_mat(Sx[0])
    gR, hR, pR = LY.FOLD_GRAB[kind]['R']; gL, hL, pL = LY.FOLD_GRAB[kind]['L']
    S.objk['fold'] = [(0.0, ('world', ID, L0)), (ev['fold'], ('world', ID, L0)),
                      (2.05, ('world',) + nat_from_grab(ID, L0 + gR + [0, 0.12, -0.06], gR)),
                      (2.30, ('chest_grab', ID, np.array([-0.08, 1.30, 0.42]), gR)),
                      (2.36, ('chest_grab', yawq(270), np.array([-0.36, 1.08, 0.06]), gR)),
                      (2.46, ('chest_grab', yawq(300), np.array([-0.42, 1.18, -0.20]), gR)),
                      (ev['sling'], ('back_nat', qS, Sx[1])), (dur, ('back_nat', qS, Sx[1]))]
    ts = LY.TUBE_SETUP_G[kind] + [0, K_['tube_r_end'], 0]
    tm = LY.tube_mount(kind)[0] + L0
    S.objk['tube'] = [(0.0, ('world', ID, tm)), (ev['tube_off'], ('world', ID, tm)),
                      (0.95, ('world', ID, tm + [0.0, 0.18, -0.03])), (1.08, ('world', ID, np.array([-0.44, 1.42, 1.00]))),
                      (1.22, ('world', ID, np.array([-0.76, 1.00, 0.86]))), (ev['tube_down'], ('world', ID, ts))]
    S.retime = [(0.85, 0.85), (1.22, 1.45), (1.35, 1.80), (1.65, 2.20), (2.58, 3.05), (2.99, 3.49)]
    TH = tube_hold(rig, kind, 'gunner_side')
    hqR = hand_q(rig, 'Right', hR, pR); hqL = hand_q(rig, 'Left', hL, pL)
    S.handk['Right'] = [G.grip_keys('Right', 0.0), G.grip_keys('Right', 0.20),
                        (ev['tube_off'], ('obj', 'tube') + TH['Right'], POLE_DN['Right'], 1.0),
                        (ev['tube_down'], ('obj', 'tube') + TH['Right'], POLE_BK['Right'], 1.0),
                        (ev['fold'], ('obj', 'fold', gR, hqR), POLE_DN['Right'], 1.0),
                        (2.30, ('obj', 'fold', gR, hqR), POLE_DN['Right'], 1.0),
                        (ev['sling'] - 0.14, ('chest', np.array([-0.32, 1.26, 0.22]), hand_q(rig, 'Right', np.array([0, 1.0, 0.15]), np.array([0, 0, -1.0]))), POLE_DN['Right'], 0.8),
                        (ev['sling'], ('chest', np.array([-0.15, 1.40, 0.13]), hand_q(rig, 'Right', np.array([0, 1.0, 0.15]), np.array([0, 0, -1.0]))), POLE_DN['Right'], 0.8),
                        (dur, relaxed(rig, 'Right'), POLE_DN['Right'], 0.2)]
    S.handk['Left'] = [G.grip_keys('Left', 0.0), G.grip_keys('Left', 0.20),
                       (0.78, ('obj', 'tube') + TH['Left'], POLE_DN['Left'], 1.0),
                       (ev['tube_down'], ('obj', 'tube') + TH['Left'], POLE_DN['Left'], 1.0),
                       (ev['fold'], ('obj', 'fold', gL, hqL), POLE_DN['Left'], 1.0),
                       (2.30, ('obj', 'fold', gL, hqL), POLE_DN['Left'], 1.0),
                       (2.52, relaxed(rig, 'Left'), POLE_DN['Left'], 0.2), (dur, relaxed(rig, 'Left'), POLE_DN['Left'], 0.2)]
    S.lookk = [(0.0, ('world', LY.EYE + [0, 0, 1.0]), 0.0), (0.5, ('world', tm), 0.5), (0.9, ('obj', 'tube', np.zeros(3)), 0.6), (1.3, ('obj', 'tube', np.zeros(3)), 0.8),
               (1.7, ('world', L0 + [0, 0.5, 0]), 0.5), (2.3, ('obj', 'fold', gR), 0.4), (2.7, ('chest', np.array([0.0, 1.6, 2.0])), 0.0)]
    S.unwind = {'Right': (2.60, 2.99), 'Left': (2.50, 2.99)}
    S.run()
    nat2node = (qinv(qS), -qrot(qinv(qS), Sx[1]))
    props = [S.prop('stugna_tube', 'tube', 'weapon_socket', 'tube_off', 'tube_down', {'attach': 'launcher'}, {'attach': 'launcher', 'empty': 'tube_setup'},
                    other=dict(side='Left', palm_local=np.round(TH['Left'][0], 4).tolist())),
             S.prop('folded', 'fold', 'weapon_socket', 'fold', 'sling', {'attach': 'hidden'}, {'attach': 'weapon_socket_back'}, nat2node=nat2node)]
    lnodes = [dict(node='stugna_control', show=None, hide='control_off'), dict(node='stugna_cable', show=None, hide='control_off'),
              dict(node='stugna_tripod', show=None, hide='fold')]
    return to_clip('atgm_pack_stugna', rig, S.gq, S.root, False,
                   notes=(f'Stugna-P gunner packs up ({dur:.1f} s, in place, starts == atgm_aim frame 0, ends standing): lets go of the remote control unit '
                          f'(control_off {ev["control_off"]} s: hide `stugna_control` + `stugna_cable`), gets up into a lunge toward the launcher, lifts the TLC out '
                          f'of the yoke (tube_off {ev["tube_off"]} s) and lays it down on his right (tube_down {ev["tube_down"]} s, empty tube_setup), takes the '
                          f'launcher (fold {ev["fold"]} s: hide `stugna_tripod`, `folded` into weapon_socket), steps back, swings it over the right shoulder onto '
                          f'his back (sling {ev["sling"]} s: weapon_socket_back, identity). palm err {_pe(S)}'),
                   events=ev, extra=dict(props=props, launcher_nodes=lnodes, launcher='stugna'))


def loader_frame(kind):
    """launcher -> loader-local transform (q, p): loader root at the origin facing +Z"""
    q = yawq(-LY.LOADER_HEADING)
    return q, -qrot(q, LY.loader_root(kind))


def atgm_reload(rig, lm, kind, kneel, dur=8.0):
    """loader at the launcher's `loader_seat` (beside it, facing it): spent TLC off -> laid down on his right -> fresh TLC from the
    ground in front of him -> onto the cradle; starts / ends kneeling on the right knee (crouch_idle legs), rifle slung"""
    name = 'atgm_reload' if kind == 'kornet' else 'atgm_reload_stugna'
    S = Script(rig, lm, name, dur)
    ev = S.events = dict(tube_off=1.50, tube_drop=2.95, tube_pick=3.90, loaded=5.60)
    qL, pL_ = loader_frame(kind)
    toL = lambda p: pL_ + qrot(qL, np.asarray(p, float))
    tm = toL(LY.tube_mount(kind)[0]); tg = toL(LY.tube_ground(kind)); tsp = toL(LY.tube_spent(kind))
    q_m = qL                                           # tube orientation (launcher identity) in loader space
    q_sp = qmul(qL, yawq(LY.SPENT_YAW))
    kq, kr, kspec = kneel(rig, 1)
    klq = rig.local(kq)[0]; kroot = kr[0]
    K0 = (klq, kroot)
    kn = {'Right': ('knee', -0.10, -0.02, 0.0), 'Left': ('foot', 0.15, 0.25, -12.0)}
    st = {'Right': ('foot', -0.13, -0.02, -20.0), 'Left': ('foot', 0.13, 0.06, -5.0)}
    S.body = [(0.00, K0), (0.45, K0),
              (0.95, stand_pose(rig, fwd=22, hip_yaw=0)),
              (1.25, P(rig, STAND['root'] + [0, -0.04, 0.03], fwd=30, neck=(-6, 0, 0))),
              (ev['tube_off'], P(rig, STAND['root'] + [0, -0.05, 0.03], fwd=30, neck=(-6, 0, 0))),
              (1.95, P(rig, STAND['root'] + [0, -0.01, 0.0], fwd=12, neck=(-4, 0, 0))),
              (2.45, P(rig, np.array([-0.25, 0.80, -0.15]), fwd=22, yaw=-70, hip_yaw=-50, neck=(8, -6, 0))),
              (2.95, P(rig, np.array([-0.45, 0.42, -0.28]), fwd=74, yaw=-78, hip_yaw=-55, neck=(12, -6, 0))),
              (3.12, P(rig, np.array([-0.44, 0.44, -0.27]), fwd=70, yaw=-76, hip_yaw=-55, neck=(12, -6, 0))),
              (3.40, P(rig, np.array([-0.22, 0.72, -0.12]), fwd=30, yaw=-40, hip_yaw=-25, neck=(10, 0, 0))),
              (3.66, P(rig, np.array([0.0, 0.55, 0.0]), fwd=48, neck=(12, 0, 0))),
              (3.85, P(rig, np.array([0.0, 0.40, -0.03]), fwd=70, neck=(10, 0, 0))),
              (4.50, P(rig, np.array([0.0, 0.70, 0.02]), fwd=34, neck=(0, 0, 0))),
              (4.95, P(rig, STAND['root'] + [0, -0.01, 0.0], fwd=12, neck=(-6, 0, 0))),
              (5.55, P(rig, STAND['root'] + [0, -0.04, 0.03], fwd=26, neck=(-4, 0, 0))),
              (5.90, P(rig, STAND['root'] + [0, -0.03, 0.02], fwd=20)),
              (6.50, stand_pose(rig, fwd=8, hip_yaw=0)),
              (7.30, K0), (dur, K0)]
    S.legk = {'Right': [(0, kn['Right']), (0.45, kn['Right']), (0.95, st['Right']), (2.05, st['Right']), (2.40, ('foot', -0.55, -0.36, -75.0)),
                        (3.20, ('foot', -0.55, -0.36, -75.0)), (3.50, st['Right']), (3.72, ('knee', -0.12, -0.02, 0.0)), (4.25, ('knee', -0.12, -0.02, 0.0)),
                        (4.70, st['Right']), (6.60, st['Right']), (7.25, kn['Right'])],
              'Left': [(0, kn['Left']), (0.50, kn['Left']), (0.95, st['Left']), (2.25, st['Left']), (2.58, ('foot', -0.22, -0.08, -70.0)),
                       (3.10, ('foot', -0.22, -0.08, -70.0)), (3.42, st['Left']), (3.62, ('foot', 0.15, 0.24, -10.0)), (4.30, ('foot', 0.15, 0.24, -10.0)),
                       (4.70, st['Left']), (6.65, st['Left']), (7.25, kn['Left'])]}
    S.objk['spent'] = [(0.0, ('world', q_m, tm)), (ev['tube_off'], ('world', q_m, tm)),
                       (1.95, ('world', q_m, tm + [0.0, 0.16, -0.16])),
                       (2.50, ('world', qmul(qL, yawq(-45)), np.array([-0.55, 0.80, -0.05]))),
                       (ev['tube_drop'], ('world', q_sp, tsp))]
    S.objk['fresh'] = [(0.0, ('world', q_m, tg)), (ev['tube_pick'], ('world', q_m, tg)),
                       (4.40, ('world', q_m, tg + [0.05, 0.45, 0.02])),
                       (4.95, ('world', q_m, tm + [-0.02, 0.17, -0.14])),
                       (ev['loaded'], ('world', q_m, tm))]
    TH = tube_hold(rig, kind, 'loader')
    rel = {s_: relaxed(rig, s_) for s_ in ('Left', 'Right')}
    S.handk['Left'] = [(0.0, rel['Left'], POLE_DN['Left'], 0.2), (0.6, rel['Left'], POLE_DN['Left'], 0.2),
                       (1.40, ('obj', 'spent') + TH['Left'], POLE_DN['Left'], 1.0), (ev['tube_drop'], ('obj', 'spent') + TH['Left'], POLE_DN['Left'], 1.0),
                       (3.40, rel['Left'], POLE_DN['Left'], 0.3),
                       (ev['tube_pick'], ('obj', 'fresh') + TH['Left'], POLE_DN['Left'], 1.0), (ev['loaded'], ('obj', 'fresh') + TH['Left'], POLE_DN['Left'], 1.0),
                       (6.0, ('obj', 'fresh', TH['Left'][0] + [0, 0.03, 0], TH['Left'][1]), POLE_DN['Left'], 0.4),
                       (6.6, rel['Left'], POLE_DN['Left'], 0.2), (dur, rel['Left'], POLE_DN['Left'], 0.2)]
    S.handk['Right'] = [(0.0, rel['Right'], POLE_DN['Right'], 0.2), (0.6, rel['Right'], POLE_DN['Right'], 0.2),
                        (ev['tube_off'], ('obj', 'spent') + TH['Right'], POLE_DN['Right'], 1.0), (ev['tube_drop'], ('obj', 'spent') + TH['Right'], POLE_BK['Right'], 1.0),
                        (3.35, rel['Right'], POLE_DN['Right'], 0.3),
                        (ev['tube_pick'], ('obj', 'fresh') + TH['Right'], POLE_DN['Right'], 1.0), (ev['loaded'], ('obj', 'fresh') + TH['Right'], POLE_DN['Right'], 1.0),
                        (6.0, ('obj', 'fresh', TH['Right'][0] + [-0.03, 0, 0], TH['Right'][1]), POLE_DN['Right'], 0.4),
                        (6.6, rel['Right'], POLE_DN['Right'], 0.2), (dur, rel['Right'], POLE_DN['Right'], 0.2)]
    S.lookk = [(0.0, ('world', tm), 0.3), (1.0, ('world', tm), 0.6), (2.4, ('obj', 'spent', np.zeros(3)), 0.7), (3.3, ('world', tg), 0.7),
               (4.6, ('obj', 'fresh', np.zeros(3)), 0.6), (5.8, ('world', tm), 0.5), (7.0, ('world', tm), 0.3), (dur, ('world', tm), 0.3)]
    kgq = legs(rig, rig.global_from_local(klq[None]), kroot[None], np.zeros(1), {s_: [(0, kn[s_])] for s_ in ('Left', 'Right')})
    S.final = (rig.local(kgq)[0], kroot, 7.40, 7.60)
    S.unwind = {'Right': (6.0, 7.3), 'Left': (6.0, 7.3)}
    S.run()
    tn = 'kornet_tube' if kind == 'kornet' else 'stugna_tube'
    props = [S.prop(tn, 'spent', 'weapon_socket_L', 'tube_off', 'tube_drop', {'attach': 'launcher'}, {'attach': 'launcher', 'empty': 'tube_spent'},
                    other=dict(side='Right', palm_local=np.round(TH['Right'][0], 4).tolist())),
             S.prop(tn + '(fresh)', 'fresh', 'weapon_socket_L', 'tube_pick', 'loaded', {'attach': 'launcher', 'empty': 'tube_ground'}, {'attach': 'launcher'},
                    other=dict(side='Right', palm_local=np.round(TH['Right'][0], 4).tolist()))]
    props[1]['note'] = (f'a second TLC: clone of `{tn}` (the bearer laid it at tube_ground before the reload); at `loaded` it becomes the launcher\'s '
                        f'`{tn}` (the spent one stays at tube_spent as litter / remove it later)')
    return to_clip(name, rig, S.gq, S.root, False,
                   notes=(f'{"Kornet" if kind == "kornet" else "Stugna-P"} loader ({dur:.1f} s, in place at the launcher\'s loader_seat empty; starts / ends '
                          f'kneeling on the right knee like crouch_idle, rifle slung): gets up, takes the spent TLC by its carry handle (left) + near side (right) '
                          f'and lifts it off the cradle (tube_off {ev["tube_off"]} s: `{tn}` -> weapon_socket_L), turns right and lays it on the ground on his '
                          f'right pointing backwards (tube_drop {ev["tube_drop"]} s: empty tube_spent), turns back, kneels, picks up the fresh TLC lying in front '
                          f'of him under the cradle (tube_pick {ev["tube_pick"]} s: clone at empty tube_ground -> weapon_socket_L), stands and lays it on the cradle '
                          f'(loaded {ev["loaded"]} s: launcher default transform), kneels again. palm err {_pe(S)}'),
                   events=ev, extra=dict(props=props, launcher=kind, layout=dict(place='soldier root == launcher empty loader_seat (position + heading)')))


# ====================================================================== FPV team
def drone_hold(rig):
    """palms on the drone (node frame: frame centre, +Z forward): both hands on the sides of the frame / warhead, fingers up-forward"""
    return {'Right': (np.array([-0.056, -0.040, -0.010]), hand_q(rig, 'Right', np.array([0.0, 0.55, 1.0]), np.array([1.0, 0, 0]))),
            'Left': (np.array([0.056, -0.040, -0.010]), hand_q(rig, 'Left', np.array([0.0, 0.55, 1.0]), np.array([-1.0, 0, 0])))}


def fpv_launch(rig, lm, dur=2.0, t_rel=1.10):
    S = Script(rig, lm, 'fpv_launch', dur)
    ev = S.events = dict(start=0.0, release=t_rel)
    S.body = [(0.00, stand_pose(rig, fwd=8, neck=(10, 0, 0), head=(6, 0, 0))),
              (0.45, stand_pose(rig, fwd=2, neck=(-4, 0, 0), head=(-4, 0, 0))),
              (0.80, P(rig, STAND['root'] + [0, -0.03, -0.05], fwd=-4, hip_yaw=-6, neck=(-6, 0, 0), head=(-6, 0, 0))),
              (t_rel, P(rig, STAND['root'] + [0, -0.01, 0.07], fwd=14, hip_yaw=-6, neck=(-12, 0, 0), head=(-12, 0, 0))),
              (1.40, stand_pose(rig, fwd=8, neck=(-16, 0, 0), head=(-14, 0, 0))),
              (dur, stand_pose(rig, neck=(-14, 0, 0), head=(-12, 0, 0)))]
    S.legk = {s_: [(0, STAND['feet'][s_])] for s_ in ('Left', 'Right')}
    # chest -> raised to face height in front -> drawn back a little -> pushed forward and up out of the hands at shoulder height
    S.objk['drone'] = [(0.0, ('chest', ID, np.array([0.0, 1.14, 0.40]))),
                       (0.45, ('chest', qeuler(-4, 0, 0, order='YXZ'), np.array([0.0, 1.46, 0.44]))),
                       (0.80, ('chest', qeuler(-8, 0, 0, order='YXZ'), np.array([0.0, 1.42, 0.32]))),
                       (t_rel, ('chest', qeuler(-14, 0, 0, order='YXZ'), np.array([0.0, 1.58, 0.70])))]
    DH = drone_hold(rig)
    S.handk['Right'] = [(0.0, ('obj', 'drone') + DH['Right'], POLE_DN['Right'], 1.0), (0.50, ('obj', 'drone') + DH['Right'], POLE_DN['Right'], 1.0),
                        (t_rel, ('obj', 'drone') + DH['Right'], POLE_DN['Right'], 1.0),
                        (1.35, ('chest', np.array([-0.12, 1.52, 0.62]), hand_q(rig, 'Right', np.array([0, 0.3, 1.0]), np.array([0.6, -0.2, 0]))), POLE_DN['Right'], 0.3),
                        (dur, relaxed(rig, 'Right'), POLE_DN['Right'], 0.2)]
    S.handk['Left'] = [(0.0, ('obj', 'drone') + DH['Left'], POLE_DN['Left'], 1.0), (0.50, ('obj', 'drone') + DH['Left'], POLE_DN['Left'], 1.0),
                       (t_rel, ('obj', 'drone') + DH['Left'], POLE_DN['Left'], 1.0),
                       (1.35, ('chest', np.array([0.12, 1.52, 0.62]), hand_q(rig, 'Left', np.array([0, 0.3, 1.0]), np.array([-0.6, -0.2, 0]))), POLE_DN['Left'], 0.3),
                       (dur, relaxed(rig, 'Left'), POLE_DN['Left'], 0.2)]
    S.lookk = [(0.0, ('obj', 'drone', np.zeros(3)), 0.5), (0.6, ('obj', 'drone', np.zeros(3)), 0.5), (t_rel, ('chest', np.array([0, 3.5, 4.0])), 0.6),
               (dur, ('chest', np.array([0, 4.5, 4.0])), 0.5)]
    S.unwind = {'Right': (1.4, 1.95), 'Left': (1.4, 1.95)}
    S.run()
    pr = S.prop('fpv_drone', 'drone', 'weapon_socket', 'start', 'release', {'attach': 'weapon_socket'}, {'attach': 'world'}, glb='fpv_drone',
                other=dict(side='Left', palm_local=np.round(DH['Left'][0], 4).tolist()))
    f = S.fr('release')
    oq, op = S.objs['drone']
    vel = (op[f] - op[f - 2]) * FPS / 2
    pr['release_pos'] = [round(float(v), 3) for v in op[f]]
    pr['release_quat'] = [round(float(v), 5) for v in oq[f]]
    pr['release_vel_mps'] = [round(float(v), 2) for v in vel]
    pr['note'] = ('the whole fpv_drone.glb scene (scale 1 while held - the hands fit the 1:1 model); from clip start to `release` it is a child of '
                  'weapon_socket with t / q, then it flies from release_pos (clip / soldier frame) with about release_vel_mps')
    return to_clip('fpv_launch', rig, S.gq, S.root, False,
                   notes=(f'FPV assistant launches the drone ({dur:.1f} s, standing, in place): holds it level in both hands in front of the chest (palms on the '
                          f'sides of the frame / warhead), raises it to face height, draws it back a little and pushes it forward-up out of both hands at shoulder height; release at {t_rel:.2f} s at '
                          f'{pr["release_pos"]} (soldier frame) moving {pr["release_vel_mps"]} m/s; arms follow through and come down, he watches it climb. '
                          f'Rifle on weapon_socket_back. palm err {_pe(S)}'),
                   events=ev, extra=dict(props=[pr]))


def ctrl_socket_pose(face_up=48.0, centre=np.array([0.0, 0.53, 0.34])):
    """weapon_socket world pose that holds the radio (centre in front of the chest, stick face toward the pilot tilted face_up deg)"""
    a = np.radians(face_up)
    face = np.array([0, np.sin(a), -np.cos(a)]); top = np.array([0, np.cos(a), np.sin(a)])
    Rw = np.stack([X3, face, top], 1) @ LY.CTRL_R.T       # socket axes -> world  (natural -> world  *  natural -> socket ^-1)
    q = qfrom_mat(Rw)
    p = centre - qrot(q, np.array([LY.CTRL['grip_L'][0] / 2, 0, 0]))
    return q, p


def fpv_pilot(rig, lm, dur=4.0):
    """sitting on the ground, knees up, radio in both hands in front of the chest, goggles on (Head), head a little down"""
    F, t = tgrid(dur)
    I = rig.I
    root0 = np.array([0.0, 0.118, -0.05])
    lq1, _ = pose_lq(rig, root0, Hips=(-26, 0, 0), LowerBack=(14, 0, 0), Spine=(14, 0, 0), Spine1=(10, 0, 0), Neck=(4, 0, 0), Neck1=(4, 0, 0), Head=(4, 0, 0),
                     LeftShoulder=(0, -4, 6), RightShoulder=(0, 4, -6))
    lq = np.repeat(lq1[None], F, 0); root = np.repeat(root0[None], F, 0).copy()
    lq = C.breathing(rig, lq, F, 1, 0.8)
    sway = noise(F, 61, 16, 1.0); sway2 = noise(F, 62, 22, 1.0)
    add_euler(rig, lq, 'Spine', 0, 1.5 * sway, -2.0 * sway)            # body english with the drone's banking
    add_euler(rig, lq, 'Head', 1.5 * sway2, 2.0 * sway, 0)
    gq = rig.global_from_local(lq)
    feet = {'Left': [(0, ('foot', 0.17, 0.40, 12.0))], 'Right': [(0, ('foot', -0.17, 0.40, -12.0))]}
    gq = legs(rig, gq, root, t, feet)
    B = Body(rig, gq, root)
    # radio: placed for the mean pose, carried by the chest, small stick-input wrist motion
    q_s, p_s = ctrl_socket_pose()
    B0 = Body(rig, rig.global_from_local(lq1[None]), root0[None])
    relq = qmul(qinv(B0.cq[0]), q_s); relp = qrot(qinv(B0.cq[0]), p_s - B0.cp[0])
    sq = qmul(B.cq, bc(relq, F)); sp = B.cp + qrot(B.cq, bc(relp, F))
    jit = np.array([qeuler(2.5 * a, 0, 3.0 * b, order='YXZ') for a, b in zip(noise(F, 63, 10, 1.0), noise(F, 64, 12, 1.0))])
    cen = sp + qrot(sq, bc(np.array([LY.CTRL['grip_L'][0] / 2, 0, 0]), F))
    sq = qmul(sq, jit)
    sp = cen - qrot(sq, bc(np.array([LY.CTRL['grip_L'][0] / 2, 0, 0]), F))
    hqR, palmR = hand_from_socket(rig, 'Right', sq, sp)
    h_s = np.array([0, -0.32, 0.947]); h_s /= np.linalg.norm(h_s)
    palmL = sp + qrot(sq, bc(LY.CTRL['grip_L'], F))
    hqL = hand_q(rig, 'Left', qrot(sq, bc(h_s, F)), qrot(sq, bc(-X3, F)))
    for side, palm, hq in (('Right', palmR, hqR), ('Left', palmL, hqL)):
        pole = B.gp[:, I[side + 'Arm']] + B.chest_dir(np.array([(1 if side == 'Left' else -1) * 0.45, -0.6, -0.05]))
        gq = arms(rig, gq, root, side, palm, hq, pole, clav=False)
    gq = fingers(rig, gq, {'Right': np.ones(F), 'Left': np.ones(F)}, {'Right': (35, 85, 10), 'Left': (35, 85, 10)})
    gp = fk_global(rig.sk, gq, root)
    ws_q, ws_p = socket_world(rig, gq, gp, 'weapon_socket')
    eL = np.linalg.norm(gp[:, I['LeftHand']] + qrot(gq[:, I['LeftHand']], bc(rig.hand['Left']['palm'] - rig.hand['Left']['wrist'], F)) - palmL, axis=1).max()
    eR = np.linalg.norm(ws_p - sp, axis=1).max()
    return to_clip('fpv_pilot', rig, gq, root, True,
                   notes=(f'FPV pilot sitting on the ground (pelvis on the ground, knees up, feet flat), radio (fpv_controller.glb on weapon_socket, identity) '
                          f'held in both hands in front of the chest with the stick face tilted toward him, thumbs on the sticks; goggles on (fpv_goggles.glb on '
                          f'the Head bone, identity); head slightly down, small stick-input / body-english motion, breathing; 4 s loop. '
                          f'socket err {eR * 100:.1f} cm, left palm on the left grip err {eL * 100:.1f} cm'),
                   events={'kit': 'fpv_controller on weapon_socket (identity) visible, fpv_goggles on Head (identity)',
                           'rifle_ground': dict(t=[-0.42, 0.035, 0.22], q=[round(float(v), 5) for v in qmul(yawq(-12), qeuler(0, 0, -90, order='YXZ'))],
                                                note='sitting: the slung rifle (weapon_socket_back) would go 8 cm into the ground - lay it down beside him '
                                                     '(ak74m-style weapon GLB root at this transform in the soldier frame, lying on its left side)')})


# ====================================================================== drone reactions
def _cache_clip(name):
    import pickle
    for f in ('clips.pkl',):
        p = os.path.join(HERE, '.cache', f)
        if os.path.exists(p):
            d = pickle.load(open(p, 'rb'))
            if name in d:
                return d[name]
    raise RuntimeError(f'{name} not in .cache/clips.pkl (build it first)')


def dodge_dive(rig, lm, side, dur=1.2):
    """throw himself to his `side` ('R' / 'L') and end prone (== prone_idle f0); in place (the game slides the root ~2.2 m sideways
    over 0.45 s); rifle kept in both hands (port) and brought into the prone_idle hold"""
    s = -1.0 if side == 'R' else 1.0               # +X = his left
    name = 'dodge_dive_' + side
    F, t = tgrid(dur)
    I = rig.I
    idle = _cache_clip('idle_rifle'); pr = _cache_clip('prone_idle')
    lq0, r0 = idle['lq'][0], idle['root'][0]
    lqP, rP = pr['lq'][0], pr['root'][0]
    rl = -s                                        # roll toward the dive side (+Z roll = to his right)
    near, far = ('Right', 'Left') if side == 'R' else ('Left', 'Right')

    def legs_e(nU, nL, fU, fL, feet=(0, 0)):
        return {near + 'UpLeg': nU, near + 'Leg': nL, far + 'UpLeg': fU, far + 'Leg': fL, 'LeftFoot': (feet[0], 0, 0), 'RightFoot': (feet[1], 0, 0)}

    def pose(root, hips, lb=(0, 0, 0), sp=(0, 0, 0), s1=(0, 0, 0), neck=(0, 0, 0), head=(0, 0, 0), lg=None):
        e = dict(Hips=hips, LowerBack=lb, Spine=sp, Spine1=s1, Neck=neck, Head=head)
        e.update(lg or {})
        return pose_lq(rig, root, **e)
    keys = [(0.00, (lq0, r0)),
            (0.10, pose(np.array([s * 0.04, 0.80, 0.0]), (10, 0, rl * 12), (6, 0, rl * 6), (6, 0, rl * 4), (4, 0, 0), (-4, 0, -rl * 6), (-2, 0, 0),
                        legs_e((-45, 0, -rl * 6), (70, 0, 0), (-40, 0, 0), (65, 0, 0), (-25, -25)))),
            (0.24, pose(np.array([s * 0.10, 0.80, 0.05]), (35, 0, rl * 42), (4, 0, rl * 8), (2, 0, rl * 6), (0, 0, 0), (-10, 0, -rl * 14), (-8, 0, 0),
                        legs_e((-55, 0, -rl * 10), (85, 0, 0), (6, 0, -rl * 8), (8, 0, 0), (20, 20)))),
            (0.38, pose(np.array([s * 0.08, 0.52, 0.10]), (70, 0, rl * 48), (0, 0, rl * 6), (-4, 0, rl * 4), (-6, 0, 0), (-16, 0, -rl * 18), (-10, 0, 0),
                        legs_e((-30, 0, -rl * 6), (50, 0, 0), (-4, 0, -rl * 10), (14, 0, 0), (30, 30)))),
            (0.52, pose(np.array([s * 0.03, 0.26, 0.07]), (84, 0, rl * 34), (-4, 0, rl * 4), (-8, 0, rl * 2), (-10, 0, 0), (-22, 0, -rl * 14), (-12, 0, 0),
                        legs_e((-16, 0, -rl * 6), (30, 0, 0), (-4, 0, -rl * 12), (12, 0, 0), (45, 45)))),
            (0.75, pose(np.array([0.0, 0.19, 0.03]), (86, -s * 4, rl * 10), (-6, 0, 0), (-10, 0, 0), (-13, 0, 0), (-24, 0, -rl * 6), (-14, 0, 0),
                        legs_e((-4, 0, -rl * 10), (10, 0, 0), (-2, 0, rl * 8), (8, 0, 0), (55, 55)))),
            (1.00, (lqP, rP)), (dur, (lqP, rP))]
    lq, root = body_track(rig, t, keys)
    gq = rig.global_from_local(lq)
    gq, _ = A.lift_feet(rig, gq, root, weight=1 - ramp(t, 0.18, 0.30))
    # rifle: idle hold (low ready) -> port across the chest -> prone_idle hold (all chest-relative)
    def gun_rel(c):
        g = rig.global_from_local(c['lq'][:1]); gp_ = fk_global(rig.sk, g, c['root'][:1])
        sq_, sp_ = socket_world(rig, g, gp_, 'weapon_socket')
        cq_, cp_ = g[0, I['Spine1']], gp_[0, I['Spine1']]
        return qmul(qinv(cq_), sq_[0]), qrot(qinv(cq_), sp_[0] - cp_)
    gi = gun_rel(idle); gpn = gun_rel(pr)
    pp_, pq_ = C.gun_rest('port')
    s1 = rig.sk.head[I['Spine1']]
    gport = (pq_, pp_ - s1)
    kt = np.array([0.0, 0.18, 0.70, 1.0])
    RQ = np.array([gi[0], gport[0], gport[0], gpn[0]]); RP = np.array([gi[1], gport[1], gport[1], gpn[1]])
    j, jn, w = key_w(t, kt)
    rq = qslerp(RQ[j], RQ[jn], w); rp = RP[j] * (1 - w)[:, None] + RP[jn] * w[:, None]
    B = Body(rig, gq, root)
    gun_q = qmul(B.cq, rq); gun_p = B.cp + qrot(B.cq, rp)
    import clips_combat as CC
    off = CC.PRONE_GRIP_L * ramp(t, 0.70, 1.0)[:, None]
    RL = qfrom_mat(rig.gunL @ rig.hand['Left']['F'].T)
    tgt = gun_p + qrot(gun_q, A.GUN['ak74m']['grip_L'] + off)
    gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, left='target', left_target=tgt, left_rot=qmul(gun_q, bc(RL, F)),
                               poleR=B.gp[:, I['RightArm']] + B.chest_dir(np.array([-0.4, -0.6, 0.0])), poleL=B.gp[:, I['LeftArm']] + B.chest_dir(np.array([0.3, -0.6, 0.1])))
    from clips_extra import ground_clamp
    root2 = ground_clamp(rig, gq2, root, clear={'Hips': 0.10, 'LowerBack': 0.11, 'Spine': 0.11, 'Spine1': 0.11})
    w2 = ramp(t, 0.05, 0.2) * (1 - ramp(t, 0.85, 1.0))
    root = root * (1 - w2)[:, None] + root2 * w2[:, None]
    gq2, root = pose_blend_to(rig, gq2, root, lqP, rP, t, 0.85, 1.0)
    return to_clip(name, rig, gq2, root, False,
                   notes=(f'drone dodge to his {"right" if side == "R" else "left"}: drops, pushes off the {far.lower()} leg, flies sideways turning face-down, lands '
                          f'on the {near.lower()} side / belly at ~0.5 s and settles prone; IN PLACE - the game moves the root ~2.2 m to his '
                          f'{"right" if side == "R" else "left"} over 0.45 s (airborne 0.22-0.50 s); rifle in both hands (port) into the prone_idle hold; '
                          f'starts like idle_rifle, ends == prone_idle frame 0 (1.0 s on); ik err {_ie(err)}'),
                   events={'airborne': [0.22, 0.50], 'land': 0.52, 'prone': 1.0, 'side': 'right' if side == 'R' else 'left'})


def _ie(err):
    return {k: round(float(v), 4) for k, v in err.items()}


SHOTS = (0.30, 0.42, 0.54, 1.50, 1.62, 1.74)


def drone_shoot(rig, lm, stance, plant_feet, dur=2.4, elev=55.0):
    """standing, rifle aimed ~55 deg up at a drone, tracking it (small sweep), two 3-round bursts per loop"""
    import clips_combat as CC
    F, t = tgrid(dur)
    I = rig.I
    gq1, root1, feet = stance(rig, 1, drop=0.03, hip_yaw=-26, spine=(0, 8, -2, 9), lfoot=(0.15, 0.13), rfoot=(-0.13, -0.13), lyaw=-18, ryaw=-40, head=(0, 6))
    gq1 = plant_feet(rig, gq1, root1, feet)
    lq1 = rig.local(gq1)
    for b, e in (('LowerBack', -5), ('Spine', -9), ('Spine1', -11)):
        add_euler(rig, lq1, b, e, 0, 0)
    d = np.array([0.0, np.sin(np.radians(elev)), np.cos(np.radians(elev))])
    lq_aim, gun_q0, gun_p0, berr = CC.solve_aim_cant(rig, lm, lq1, root1, cant=0.0, aim_dir=d, head=(-22, -4, -10), neck=(-12, 0, 0))
    relq, relp = CC._rel(rig, lq_aim, root1, gun_q0, gun_p0)
    lq = np.repeat(lq_aim, F, 0); root = np.repeat(root1, F, 0).copy()
    lq = C.breathing(rig, lq, F, 1, 0.6)
    sweep = 6.0 * np.sin(2 * np.pi * t / dur) + 1.5 * noise(F, 71, 14, 1.0)
    add_euler(rig, lq, 'Spine', 0, 0.4 * sweep, 0); add_euler(rig, lq, 'Spine1', 0.8 * np.sin(4 * np.pi * t / dur), 0.6 * sweep, 0)
    # recoil: KICK profile per shot (frames), body absorbs, muzzle climbs about the butt
    k = np.zeros(F)
    for ts_ in SHOTS:
        f0 = int(round(ts_ * FPS))
        for i_, a in enumerate(CC.KICK):
            if f0 + i_ < F:
                k[f0 + i_] = max(k[f0 + i_], a)
    add_euler(rig, lq, 'Spine', -1.0 * k, 0, 0); add_euler(rig, lq, 'Spine1', -1.8 * k, 0.5 * k, 0.5 * k)
    add_euler(rig, lq, 'RightShoulder', 0, -4.5 * k, 0); add_euler(rig, lq, 'Head', -1.0 * k, 0, 0)
    gq = rig.global_from_local(lq)
    gq = plant_feet(rig, gq, root, feet)
    B = Body(rig, gq, root)
    gun_q = qmul(B.cq, bc(relq, F)); gun_p = B.cp + qrot(B.cq, bc(relp, F))
    butt = A.GUN['ak74m']['butt']
    bw = gun_p + qrot(gun_q, bc(butt, F))
    kq = np.array([qaxis([1, 0, 0], -np.radians(3.0 * a)) for a in k])
    gun_q = qmul(gun_q, kq)
    gun_p = bw - qrot(gun_q, bc(butt, F)) - qrot(gun_q, bc(np.array([0, 0, 0.008]), F)) * k[:, None]
    gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, poleR=B.gp[:, I['RightArm']] + CC.POLE_R, poleL=B.gp[:, I['LeftArm']] + CC.POLE_L)
    mz = qrot(gun_q, bc(Z3, F))
    el = np.degrees(np.arcsin(mz[:, 1]))
    return to_clip('drone_shoot', rig, gq2, root, True,
                   notes=(f'shooting at a drone overhead: standing, leaning back, rifle shouldered and aimed {el.min():.0f}-{el.max():.0f} deg up (cheek on the stock, '
                          f'butt err {berr:.3f} m), tracking it with a small sweep (+-6 deg), two 3-round bursts per {dur:.1f} s loop (shots at {list(SHOTS)} s: '
                          f'muzzle flash / tracer at each); rifle in weapon_socket; ik err {_ie(err)}'),
                   events={'shots': list(SHOTS), 'shot': SHOTS[0], 'aim_elevation_deg': [round(float(el.min()), 1), round(float(el.max()), 1)]})


# ====================================================================== build entry
def atgm_clips(rig, lm, R, want, stance, plant_feet, kneel, kneel_legs, prone):
    out = {}
    need_g = any(want(n) for n in CLIPS if n.startswith('atgm_'))
    G = Gunner(rig, lm) if need_g else None
    if want('atgm_aim'):
        out['atgm_aim'] = atgm_aim(rig, lm, G)
    if want('atgm_fire'):
        out['atgm_fire'] = atgm_fire(rig, lm, G)
    if want('atgm_setup'):
        out['atgm_setup'] = atgm_setup_kornet(rig, lm, G)
    if want('atgm_pack'):
        out['atgm_pack'] = atgm_pack_kornet(rig, lm, G)
    if want('atgm_setup_stugna'):
        out['atgm_setup_stugna'] = atgm_setup_stugna(rig, lm, G)
    if want('atgm_pack_stugna'):
        out['atgm_pack_stugna'] = atgm_pack_stugna(rig, lm, G)
    if want('atgm_reload'):
        out['atgm_reload'] = atgm_reload(rig, lm, 'kornet', kneel)
    if want('atgm_reload_stugna'):
        out['atgm_reload_stugna'] = atgm_reload(rig, lm, 'stugna', kneel)
    if want('fpv_launch'):
        out['fpv_launch'] = fpv_launch(rig, lm)
    if want('fpv_pilot'):
        out['fpv_pilot'] = fpv_pilot(rig, lm)
    for sd in ('R', 'L'):
        if want('dodge_dive_' + sd) or (sd == 'R' and want('dodge_dive')):
            c = dodge_dive(rig, lm, sd)
            if want('dodge_dive_' + sd):
                out['dodge_dive_' + sd] = c
            if sd == 'R' and want('dodge_dive'):
                out['dodge_dive'] = dict(c, name='dodge_dive', notes=c['notes'] + ' (dodge_dive == dodge_dive_R)')
    if want('drone_shoot'):
        out['drone_shoot'] = drone_shoot(rig, lm, stance, plant_feet)
    return out


def usage_doc():
    """how the game drives the ATGM / FPV clips + props (stored as soldier_anims.atgm_fpv in the manifest)"""
    return dict(
        launcher='kornet.glb (RU) / stugna.glb (UA): place the root so its `seat` empty == the gunner root (position + heading)',
        gunner='atgm_setup[_stugna] -> atgm_aim (loop) / atgm_fire (missile leaves the muzzle at event launch) -> atgm_pack[_stugna]',
        loader='atgm_reload[_stugna] with the loader root at the launcher `loader_seat` empty (position + rotation)',
        props=PROP_DOC + '  track{f0,f1,fps,p,q}: exact per-frame node transform in the soldier root frame over the hold window - drive the prop from it.',
        fpv='fpv_launch (assistant; drone in hands until release), fpv_pilot (loop; fpv_controller on weapon_socket, fpv_goggles on Head, rifle laid on the ground at events.rifle_ground)',
        reactions='dodge_dive_L / dodge_dive_R (in place, ends prone), drone_shoot (loop, rifle aimed 54-61 deg up)')


def prop_doc(name):
    """short usage note per prop GLB for the manifest"""
    D = {'kornet': 'tripod launcher (9P163-1 + 1P45M/1PN79 + 9M133 TLC); root placed so `seat` == gunner root; nodes kornet_tripod / kornet_tube (muzzle) / folded (hidden: carried on weapon_socket_back, identity)',
         'stugna': 'Stugna-P launcher + remote control unit; root placed so `seat` == gunner root; nodes stugna_tripod / stugna_tube (muzzle) / stugna_control / stugna_cable / folded',
         'atgm_tube_carried': 'spare TLC on the back: tube_kornet / tube_stugna on weapon_socket_back with identity',
         'fpv_drone': '7in FPV with PG-7V warhead; +Z forward; prop_0..3 spin about local Y',
         'fpv_controller': 'radio on weapon_socket (identity) while piloting',
         'fpv_goggles': 'goggles on the Head bone (identity)'}
    return {'usage': D.get(name, '')}
