"""arms_v1: twist helper bones (forearm + upper arm), added by the GLB writers (assemble.SoldierWriter) - no clip authoring.

Linear blend skinning puts all of a bone's twist on the one ring of vertices where its weights hand over to the next bone: a
forearm turned 100 deg (palm up under a handguard) pinched the wrist or the elbow ("candy wrapper").  Four leaf bones spread it:
  LeftForeArmTwist / RightForeArmTwist  child of *ForeArm, head 55 % down the forearm; driven = K_FORE x the hand's twist about
                                        the forearm axis (Hand local).  armfix.py leaves A_FORE of the forearm twist on the
                                        ForeArm bone (elbow seam), so the forearm skin runs A_FORE -> B_FORE -> 1 of the twist from
                                        elbow to wrist instead of jumping at one ring.
  LeftArmTwist / RightArmTwist          child of *Arm, head 30 % down the upper arm; driven = -C_ARM x the upper arm's own twist
                                        (Arm local about its rest axis): the shoulder seam sees half the humeral rotation, the
                                        upper arm takes the rest progressively.
The drivers are pure functions of the parent / hand LOCAL rotations (same formula baked into every clip by build_anims.write and
evaluated at runtime by src/game/soldierPose.js driveTwist() after the procedural layers), faded out from 100 to 180 deg where the
twist of a rotation is ill-defined.  Skin weights: every skinned primitive's *ForeArm / *Arm weight is split by the vertex's
position along the bone (bind pose) - nested layers (sleeve, hem, glove cuff, skin) at the same place get the same split, so
they turn together."""
import copy
import numpy as np
from qmath import qaxis

A_FORE, B_FORE = 0.25, 0.8           # forearm twist share at the elbow seam / carried by the twist bone (of the total)
K_FORE = (B_FORE - A_FORE) / (1 - A_FORE)
C_ARM = 0.5
BONES = [  # name, parent, child joint (bone end), head fraction along parent -> child
    ('LeftArmTwist', 'LeftArm', 'LeftForeArm', 0.30), ('LeftForeArmTwist', 'LeftForeArm', 'LeftHand', 0.55),
    ('RightArmTwist', 'RightArm', 'RightForeArm', 0.30), ('RightForeArmTwist', 'RightForeArm', 'RightHand', 0.55),
]
# weight split ramps (fraction along the parent bone): forearm 0 at FORE_RAMP[0] -> all twist bone at FORE_RAMP[1];
# upper arm all ArmTwist up to ARM_RAMP[0] -> all Arm from ARM_RAMP[1]
FORE_RAMP = (0.12, 0.80)
ARM_RAMP = (0.15, 0.85)


def enabled(sk):
    return 'LeftForeArmTwist' in sk.idx


def extend(sk):
    """copy of the Skel with the 4 helper bones appended (existing indices unchanged)"""
    if enabled(sk):
        return sk
    s = copy.copy(sk)
    names = list(sk.names); parent = list(sk.parent); head = list(sk.head); tail = list(sk.tail)
    for n, p, c, fr in BONES:
        ip, ic = sk.idx[p], sk.idx[c]
        h = sk.head[ip] + fr * (sk.head[ic] - sk.head[ip])
        names.append(n); parent.append(ip); head.append(h); tail.append(sk.head[ic].copy())
    s.names = names
    s.idx = {n: i for i, n in enumerate(names)}
    s.parent = np.array(parent)
    s.head = np.array(head); s.tail = np.array(tail)
    s.n = len(names)
    s.offset = np.array([s.head[i] - (s.head[p] if p >= 0 else 0) for i, p in enumerate(s.parent)])
    return s


def _axes(sk, side):
    I = sk.idx
    u0 = sk.head[I[side + 'ForeArm']] - sk.head[I[side + 'Arm']]
    f0 = sk.head[I[side + 'Hand']] - sk.head[I[side + 'ForeArm']]
    return u0 / np.linalg.norm(u0), f0 / np.linalg.norm(f0)


def _twist(q, axis):
    p = q[..., :3] @ axis
    a = 2 * np.arctan2(p, q[..., 3])
    return (a + np.pi) % (2 * np.pi) - np.pi


def _fade(a):
    """1 below 100 deg, smooth to 0 at 180 (the twist of a near-half-turn flips sign from one frame to the next)"""
    t = np.clip((np.abs(a) - np.radians(100)) / np.radians(80), 0, 1)
    return 1 - t * t * (3 - 2 * t)


def drive_side(sk, side, lq_arm, lq_hand):
    """local rotations of <side>ArmTwist, <side>ForeArmTwist from the Arm / Hand locals (..., 4)"""
    u0, f0 = _axes(sk, side)
    ta = _twist(lq_arm, u0); th = _twist(lq_hand, f0)
    qa = qaxis(np.broadcast_to(u0, ta.shape + (3,)), -C_ARM * ta * _fade(ta))
    qf = qaxis(np.broadcast_to(f0, th.shape + (3,)), K_FORE * th * _fade(th))
    return qa, qf


def drive(sk, lq):
    """fill the helper bones' locals in lq (F, sk.n, 4) in place from the clip's arm / hand locals"""
    I = sk.idx
    for side in ('Left', 'Right'):
        qa, qf = drive_side(sk, side, lq[:, I[side + 'Arm']], lq[:, I[side + 'Hand']])
        lq[:, I[side + 'ArmTwist']] = qa
        lq[:, I[side + 'ForeArmTwist']] = qf
    return lq


def _ss(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def split_weights(sk, pos, W):
    """dense weights (n, nb <= sk.n) on bind-pose positions -> (n, sk.n) with the forearm / upper-arm weights split onto the
    helper bones by the vertex's place along the bone"""
    W = np.asarray(W, np.float32)
    if W.shape[1] == sk.n and W[:, [sk.idx[b[0]] for b in BONES]].any():
        return W                                       # already split
    if W.shape[1] < sk.n:
        W = np.concatenate([W, np.zeros((len(W), sk.n - W.shape[1]), np.float32)], 1)
    else:
        W = W.copy()
    I = sk.idx
    pos = np.asarray(pos, np.float64)
    for side in ('Left', 'Right'):
        ia, ifa, ih = I[side + 'Arm'], I[side + 'ForeArm'], I[side + 'Hand']
        # forearm: elbow -> wrist
        e, w = sk.head[ifa], sk.head[ih]
        d = w - e; L = np.linalg.norm(d)
        s = (pos - e) @ (d / L) / L
        g = _ss(FORE_RAMP[0], FORE_RAMP[1], s).astype(np.float32)
        mv = W[:, ifa] * g
        W[:, ifa] -= mv; W[:, I[side + 'ForeArmTwist']] += mv
        # upper arm: shoulder -> elbow (proximal part to the ArmTwist)
        sh = sk.head[ia]; d = e - sh; L = np.linalg.norm(d)
        s = (pos - sh) @ (d / L) / L
        g = (1 - _ss(ARM_RAMP[0], ARM_RAMP[1], s)).astype(np.float32)
        mv = W[:, ia] * g
        W[:, ia] -= mv; W[:, I[side + 'ArmTwist']] += mv
    return W
