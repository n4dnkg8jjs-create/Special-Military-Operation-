"""Animation toolkit: pose authoring, two-bone IK, rifle hold overlay, mocap post-processing.
Clips are represented as (gq: (F, nb, 4) global joint rotations, root: (F, 3) Hips position) at 30 fps.
Joint frames are world-aligned in the bind pose, so local rotations are expressed in model axes:
  +X = character's left, +Y = up, +Z = forward.  Spine pitch forward = +X rotation; hip flexion = -X;
  knee flexion = +X on *Leg; elbow flexion depends on arm direction (we use IK for arms)."""
import numpy as np
from qmath import qmul, qinv, qrot, qaxis, qbetween, qnorm, qslerp, qeuler, qfrom_mat, qto_mat, qfix_continuity, swing_twist

FPS = 30


def smooth(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def mat_from_cols(a, b, c):
    return np.stack([a, b, c], 1)


class Rig:
    def __init__(self, skel, hands_pos, hands_W):
        self.sk = sk = skel
        self.I = sk.idx
        self.n = sk.n
        self.hand = {}
        for side, sx in (('Right', -1), ('Left', 1)):
            b = [sk.idx[side + 'Hand'], sk.idx[side + 'FingerBase']]
            m = hands_W[:, b].sum(1) > 0.5
            P = hands_pos[m]
            c = P.mean(0)
            u, s, vt = np.linalg.svd(P - c, full_matrices=False)
            h = vt[0] * np.sign(vt[0][2])
            p = vt[2] * np.sign(vt[2][0] * sx * -1)  # palm faces the body (+x for right hand)
            p = p - h * (p @ h); p /= np.linalg.norm(p)
            t = np.cross(h, p) if side == 'Right' else np.cross(p, h)
            wrist = sk.head[sk.idx[side + 'Hand']]
            palm = c + p * 0.012
            self.hand[side] = dict(h=h, t=t, p=p, palm=palm, wrist=wrist, F=mat_from_cols(h, t, p))
        # weapon socket (gun frame relative to the right hand): gun axes for a pistol grip
        hg = np.array([0, -0.32, 0.947]); hg /= np.linalg.norm(hg)
        tg = np.array([0, 0.947, 0.32]); tg /= np.linalg.norm(tg)
        pg = np.array([1.0, 0, 0])
        self.gunR = mat_from_cols(hg, tg, pg)   # right-hand frame expressed in gun space
        H = self.hand['Right']
        self.sock_R = H['F'] @ self.gunR.T      # gun axes in hand(rest) space
        self.sock_q = qfrom_mat(self.sock_R)
        self.sock_t = H['palm'] + H['p'] * 0.006 - H['wrist']
        # left support hand on handguard: palm up, fingers to the gun's right & forward
        pgL = np.array([0, 1.0, 0]); hgL = np.array([-0.82, 0.0, 0.57]); hgL /= np.linalg.norm(hgL)
        tgL = np.cross(pgL, hgL)
        self.gunL = mat_from_cols(hgL, tgL, pgL)
        # left-hand socket for carrying the rifle by the handguard (throw grenade etc.)
        HL = self.hand['Left']
        self.sockL_R = HL['F'] @ self.gunL.T
        self.sockL_q = qfrom_mat(self.sockL_R)
        self.L1 = {s: np.linalg.norm(sk.head[sk.idx[s + 'ForeArm']] - sk.head[sk.idx[s + 'Arm']]) for s in ('Left', 'Right')}
        self.L2 = {s: np.linalg.norm(sk.head[sk.idx[s + 'Hand']] - sk.head[sk.idx[s + 'ForeArm']]) for s in ('Left', 'Right')}

    # ------------------------------------------------------------------ basics
    def rest(self, F):
        lq = np.zeros((F, self.n, 4)); lq[..., 3] = 1
        root = np.tile(self.sk.head[0], (F, 1))
        return lq, root

    def fk(self, lq, root):
        return self.sk.fk(lq, root)

    def local(self, gq):
        return self.sk.local_from_global(gq)

    def global_from_local(self, lq):
        gq, _ = self.sk.fk(lq, np.zeros((lq.shape[0], 3)))
        return gq

    # ------------------------------------------------------------------ IK
    def two_bone(self, gq, gp, upper, lower, end, target, pole, end_rot=None, twist_share=0.5):
        """per-frame two-bone IK on global rotations (in place). target/pole: (F,3)."""
        sk = self.sk
        iu, il, ie = sk.idx[upper], sk.idx[lower], sk.idx[end]
        u0 = sk.head[il] - sk.head[iu]; f0 = sk.head[ie] - sk.head[il]
        L1, L2 = np.linalg.norm(u0), np.linalg.norm(f0)
        n0 = np.cross(u0, f0); n0 /= np.linalg.norm(n0)
        A0 = mat_from_cols(u0 / L1, n0, np.cross(u0 / L1, n0))
        B0 = mat_from_cols(f0 / L2, n0, np.cross(f0 / L2, n0))
        F = gq.shape[0]
        for f in range(F):
            S = gp[f, iu]
            T = target[f]
            d = T - S
            dist = np.linalg.norm(d)
            dist_c = np.clip(dist, abs(L1 - L2) + 1e-4, (L1 + L2) * 0.9995)
            dn = d / max(dist, 1e-9)
            # elbow position in the plane of (d, pole)
            pv = pole[f] - S
            pv = pv - dn * (pv @ dn)
            if np.linalg.norm(pv) < 1e-6:
                pv = np.array([0, -1.0, 0]) - dn * (-dn[1])
            pv /= np.linalg.norm(pv)
            a = (L1 ** 2 - L2 ** 2 + dist_c ** 2) / (2 * dist_c)
            hgt = np.sqrt(max(L1 ** 2 - a ** 2, 0))
            E = S + dn * a + pv * hgt
            Tc = S + dn * dist_c
            u1 = (E - S) / L1; f1 = (Tc - E) / L2
            n1 = np.cross(u1, f1)
            if np.linalg.norm(n1) < 1e-6:
                n1 = np.cross(u1, pv)
            n1 /= np.linalg.norm(n1)
            # keep the same handedness of the bend plane normal as rest
            A1 = mat_from_cols(u1, n1, np.cross(u1, n1))
            B1 = mat_from_cols(f1, n1, np.cross(f1, n1))
            qa = qfrom_mat(A1 @ A0.T); qb = qfrom_mat(B1 @ B0.T)
            if end_rot is not None:
                qe = end_rot[f]
                # distribute forearm twist toward the hand
                rel = qmul(qinv(qb), qe)
                axis = f0 / L2
                sw, tw = swing_twist(rel, axis)
                tw_s = qslerp(np.array([0, 0, 0, 1.0]), tw, twist_share)
                qb = qmul(qb, tw_s)
                gq[f, ie] = qe
            else:
                # end keeps its local rotation relative to lower
                loc = qmul(qinv(gq[f, il]), gq[f, ie])
                gq[f, ie] = qmul(qb, loc)
            gq[f, iu] = qa; gq[f, il] = qb
        return gq

    def update_children(self, gq_old, gq_new, bones):
        """after changing global rotations of `bones`, carry their (unchanged) descendants along"""
        sk = self.sk
        for i in range(self.n):
            p = sk.parent[i]
            if p < 0 or sk.names[i] in bones:
                continue
            # if any ancestor changed, recompute from local
            loc = qmul(qinv(gq_old[:, p]), gq_old[:, i])
            gq_new[:, i] = qmul(gq_new[:, p], loc)
        return gq_new

    def recompute_desc(self, gq_ref_local, gq, changed):
        """gq: globals with `changed` bones overridden; recompute all other bones from their reference locals"""
        sk = self.sk
        out = gq.copy()
        for i in range(self.n):
            p = sk.parent[i]
            if sk.names[i] in changed or p < 0:
                continue
            out[:, i] = qmul(out[:, p], gq_ref_local[:, i])
        return out

    # ------------------------------------------------------------------ hands
    def finger_curl(self, lq, side, base=55, mid=70, thumb=25, spread=0.0):
        H = self.hand[side]
        k = H['t'] if side == 'Right' else H['t'] * 1  # curl axis (toward palm)
        # for left hand: p = cross(h, t) -> rotation about -t brings h toward p
        ax = H['t'] if side == 'Right' else -H['t']
        lq[:, self.I[side + 'FingerBase']] = qaxis(ax, np.radians(base))[None]
        lq[:, self.I[side + 'HandFinger1']] = qaxis(ax, np.radians(mid))[None]
        th = 'RThumb' if side == 'Right' else 'LThumb'
        lq[:, self.I[th]] = qaxis(H['h'] if side == 'Right' else -H['h'], np.radians(thumb))[None]
        return lq


def fk_global(sk, gq, root):
    F = gq.shape[0]
    gp = np.zeros((F, sk.n, 3))
    for i in range(sk.n):
        p = sk.parent[i]
        if p < 0:
            gp[:, i] = root
        else:
            gp[:, i] = gp[:, p] + qrot(gq[:, p], np.broadcast_to(sk.offset[i], (F, 3)))
    return gp


GUN = {  # gun-space reference points (filled from weapons info)
    'ak74m': dict(grip_L=np.array([0, 0.05, 0.234]), butt=np.array([0, 0.035, -0.337]), sight=np.array([0, 0.126, 0.156]),
                  front_sight=np.array([0, 0.14, 0.523]), muzzle=np.array([0, 0.084, 0.621])),
}


def rifle_overlay(rig, gq, root, gun_q, gun_p, left='grip', left_target=None, left_rot=None,
                  poleR=None, poleL=None, curlR=(55, 70, 25), curlL=(60, 75, 20), gun='ak74m', right='grip'):
    """Set arms so the right hand holds the gun (socket) and the left hand grips the handguard.
    gun_q/gun_p: (F,4)/(F,3) world gun pose. Returns new gq."""
    sk = rig.sk; I = sk.idx
    F = gq.shape[0]
    gq = gq.copy()
    lq_ref = sk.local_from_global(gq)
    # targets first (needed for clavicle protraction)
    qR = qmul(gun_q, qinv(rig.sock_q)[None])
    wR = gun_p - qrot(qR, np.broadcast_to(rig.sock_t, (F, 3)))
    HL = rig.hand['Left']
    if left == 'grip':
        RL = qfrom_mat(rig.gunL @ HL['F'].T)
        qL = qmul(gun_q, RL[None])
        palm_t = gun_p + qrot(gun_q, np.broadcast_to(GUN[gun]['grip_L'] + [0, -0.018, 0], (F, 3)))
    elif left == 'target':
        qL = left_rot; palm_t = left_target
    if left in ('grip', 'target'):
        wL = palm_t - qrot(qL, np.broadcast_to(HL['palm'] - HL['wrist'], (F, 3)))
    gp = fk_global(sk, gq, root)
    for side, tgt, on in (('Left', wL if left in ('grip', 'target') else None, left in ('grip', 'target')), ('Right', wR, right == 'grip')):
        if not on:
            continue
        ic = I[side + 'Shoulder']; ia = I[side + 'Arm']
        reach = rig.L1[side] + rig.L2[side]
        for f in range(F):
            v0 = gp[f, ia] - gp[f, ic]; v1 = tgt[f] - gp[f, ic]
            deficit = np.linalg.norm(tgt[f] - gp[f, ia]) - reach * 0.93
            k = np.clip(deficit / 0.07, 0, 1) * (0.9 if side == 'Left' else 0.5)
            if k <= 0:
                continue
            qb = qbetween(v0, v1)
            ang = 2 * np.arccos(np.clip(qb[3], -1, 1))
            lim = np.radians(28 if side == 'Left' else 15)
            frac = min(1.0, lim / max(ang, 1e-6)) * k
            qd = qslerp(np.array([0, 0, 0, 1.0]), qb, frac)
            gq[f, ic] = qmul(qd, gq[f, ic])
        gq = rig.recompute_desc(lq_ref, gq, {side + 'Shoulder'})
        lq_ref = sk.local_from_global(gq)
        gp = fk_global(sk, gq, root)
    out = gq.copy()
    if right == 'grip':
        if poleR is None:
            poleR = gp[:, I['RightArm']] + np.array([-0.35, -0.6, -0.25])
        rig.two_bone(out, gp, 'RightArm', 'RightForeArm', 'RightHand', wR, poleR, end_rot=qR)
    if left in ('grip', 'target'):
        if poleL is None:
            poleL = gp[:, I['LeftArm']] + np.array([0.25, -0.7, -0.1])
        rig.two_bone(out, gp, 'LeftArm', 'LeftForeArm', 'LeftHand', wL, poleL, end_rot=qL)
    changed = {'RightArm', 'RightForeArm', 'RightHand', 'LeftArm', 'LeftForeArm', 'LeftHand'}
    out = rig.recompute_desc(lq_ref, out, changed)
    # fingers
    lq = sk.local_from_global(out)
    if right == 'grip':
        rig.finger_curl(lq, 'Right', *curlR)
    if left in ('grip', 'target'):
        rig.finger_curl(lq, 'Left', *curlL)
    out = rig.global_from_local(lq)
    # report reach error
    gp2 = fk_global(sk, out, root)
    err = {}
    if right == 'grip':
        err['R'] = float(np.max(np.linalg.norm(gp2[:, I['RightHand']] - wR, axis=1)))
    if left in ('grip', 'target'):
        err['L'] = float(np.max(np.linalg.norm(gp2[:, I['LeftHand']] - wL, axis=1)))
    return out, err


def chest_frame(sk, gq, root):
    """world transform of Spine1 per frame (q, p)"""
    gp = fk_global(sk, gq, root)
    i = sk.idx['Spine1']
    return gq[:, i], gp[:, i]


def gun_in_chest(sk, gq, root, rest_pos, rest_q):
    """gun pose given in bind-pose world coordinates relative to the chest (Spine1); carried by the chest."""
    cq, cp = chest_frame(sk, gq, root)
    s_rest = sk.head[sk.idx['Spine1']]
    F = gq.shape[0]
    rp = np.broadcast_to(rest_pos, (F, 3)) if np.ndim(rest_pos) == 1 else rest_pos
    rq = np.broadcast_to(rest_q, (F, 4)) if np.ndim(rest_q) == 1 else rest_q
    p = cp + qrot(cq, rp - s_rest)
    q = qmul(cq, rq)
    return q, p
