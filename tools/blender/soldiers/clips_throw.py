"""v7 grenade throws (infantry_v7): a proper standing overhand throw and a crouched underhand lob from cover.
Built like clips_extra.throw_grenade_window (keyed body, planted feet by leg IK, right hand along a spline path by arm IK,
rifle carried in the left hand = weapon_socket_L). Grenade in the right hand (weapon_socket) from pin_pull to release.
  throw_grenade_over : standing, 1.45 s. Left arm points at the target, right arm cocked back behind the head, step in with the
                       left foot, release high in front at 0.80 s (~30 deg up), follow-through across the body, recover.
  throw_grenade_low  : crouched behind cover / at a doorway / trench bend, 1.35 s. Hand swings back low past the hip, then
                       an underhand lob forward-up, release at 0.70 s (~40 deg up, waist height), follow-through, recover."""
import numpy as np
import anim as A
import clips as C
from anim import FPS, fk_global, smooth
from qmath import qaxis, qslerp
from clips_extra import keyed, spline_keys, hand_q, arm_to, leg_to, to_clip, pulse_

Y = np.array([0, 1.0, 0])


def qrot1(q):
    from qmath import qrot
    f = qrot(q, np.array([0, 0, 1.0])); return np.arctan2(f[0], f[2])


def qrot_v(q, v):
    from qmath import qrot
    return qrot(q, np.asarray(v, float))


def _throw(rig, name, body, dur, rel, path, pole_keys, lpath, feet, wsm_t, notes, events, knee_fwd=0.6, smooth_w=2.2, hq_rel_dirs=None, fdir=None, lpole=(0.5, -0.4, -0.3), follow=False):
    I = rig.I
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    lq, root = keyed(rig, body, dur)
    lq = C.breathing(rig, lq, F, 1, 0.6)
    gq = rig.global_from_local(lq)
    ay = rig.sk.head[I['LeftFoot'], 1]
    (l0, l1, ls0, ls1), rf_xz = feet
    st = smooth(np.clip((t - ls0) / (ls1 - ls0), 0, 1))
    lift = np.sin(np.clip((t - ls0) / (ls1 - ls0), 0, 1) * np.pi) * 0.06
    lf = np.stack([l0[0] + (l1[0] - l0[0]) * st, ay + lift, l0[1] + (l1[1] - l0[1]) * st], 1)
    rf = np.tile([rf_xz[0], ay, rf_xz[1]], (F, 1))
    root, _ = A.fit_root_to_feet(rig, gq, root, {'Left': lf, 'Right': rf})
    for side, tgt, yaw in (('Left', lf, -10), ('Right', rf, -35)):
        pole = tgt + [0.05 * (1 if side == 'Left' else -1), 0.5, knee_fwd]
        gq = leg_to(rig, gq, root, side, tgt, pole, foot_q=np.broadcast_to(qaxis(Y, np.radians(yaw)), (F, 4)).copy())
    P = spline_keys(path, F, 3) + root * [1, 0, 1]
    gp = fk_global(rig.sk, gq, root)
    # holding: fingers along a keyed direction (smooth), palm in / forward; an arm-line direction flipped while the hand passed the shoulder
    if fdir is not None:
        arm_d = spline_keys(fdir, F, 3); arm_d /= np.linalg.norm(arm_d, axis=1, keepdims=True)
    else:
        arm_d = P - gp[:, I['RightArm']] + [0, 0.25, 0]
    hq_hold = hand_q(rig, 'Right', arm_d, np.broadcast_to([0.6, 0.0, 0.8], (F, 3)))
    hd, hp = hq_rel_dirs or ((0.0, 0.5, 0.85), (0.2, 0.7, -0.6))
    hq_rel = hand_q(rig, 'Right', np.array(hd), np.array(hp))
    wrel = smooth(np.clip((t - (rel - 0.14)) / 0.16, 0, 1)) * (1 - smooth(np.clip((t - rel - 0.25) / 0.3, 0, 1)))
    hq = np.array([qslerp(hq_hold[f], hq_rel, wrel[f]) for f in range(F)])
    poleR = gp[:, I['RightArm']] + spline_keys(pole_keys, F, 3)
    gq = arm_to(rig, gq, root, 'Right', P, hq, poleR)
    wsm = 1 - pulse_(t, wsm_t[0], wsm_t[1], wsm_t[2])
    gq = A.smooth_locals(rig, gq, ('RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'), smooth_w, wsm)
    LP = spline_keys(lpath, F, 3)
    hqL = hand_q(rig, 'Left', np.array([-0.1, -0.3, 1.0]), np.array([-1.0, 0, 0.1]))
    if follow:   # the rifle hand turns with the hips (crouched lob: the trunk yaws 35 deg; a world-fixed hand twisted the wrist over)
        from qmath import qmul, qinv
        hy = np.array([qrot1(gq[f, I['Hips']]) for f in range(F)]); hy -= hy[0]
        qy = np.array([qaxis(Y, a) for a in hy])
        LP = np.array([qrot_v(qy[f], LP[f]) for f in range(F)])
        hqL = np.array([qmul(qy[f], hqL) for f in range(F)])
    LP = LP + root * [1, 0, 1]
    hyL = np.array([qrot1(gq[f, I['Spine1']]) for f in range(F)]); hyL -= hyL[0]
    lp_w = np.array([qrot_v(qaxis(Y, a), lpole) for a in hyL])   # elbow pole turns with the chest (a fixed pole flipped the elbow plane)
    gq = arm_to(rig, gq, root, 'Left', LP, hqL, gp[:, I['LeftArm']] + lp_w)
    if follow:   # (crouched lob) smooth the rifle arm: the IK elbow plane wobbled while the trunk turned
        gq = A.smooth_locals(rig, gq, ('LeftArm', 'LeftForeArm', 'LeftHand'), 3.0, np.ones(F))
    lq = rig.local(gq)
    rig.finger_curl(lq, 'Left', 70, 80, 30)
    lqa = lq.copy(); rig.finger_curl(lqa, 'Right', 45, 55, 25)
    lqb = lq.copy(); rig.finger_curl(lqb, 'Right', 8, 10, 0)
    for b in ('RightFingerBase', 'RightHandFinger1', 'RThumb'):
        i = I[b]
        lq[:, i] = np.array([qslerp(lqa[f, i], lqb[f, i], wrel[f]) for f in range(F)])
    gq = rig.global_from_local(lq)
    return to_clip(name, rig, gq, root, False, notes=notes, events=events)


def throw_grenade_over(rig, dur=1.45):
    rel = 0.80
    body = [
        (0.0, dict(root=np.array([0, 0.945, 0.0]), Hips=(0, -8, 0), LowerBack=(2, 0, 0), Spine=(3, 2, 0), Spine1=(3, 2, 0), Neck=(-2, 2, 0), Head=(-2, 4, 0))),
        (0.28, dict(root=np.array([0, 0.93, -0.03]), Hips=(0, -30, 0), LowerBack=(-1, -8, 3), Spine=(-3, -10, 5), Spine1=(-3, -10, 5), Neck=(-2, 14, 0), Head=(-3, 18, 0))),
        (0.56, dict(root=np.array([0, 0.91, -0.07]), Hips=(0, -42, 4), LowerBack=(-3, -12, 5), Spine=(-6, -14, 7), Spine1=(-5, -12, 7), Neck=(-2, 20, 0), Head=(-4, 24, 0))),
        (rel, dict(root=np.array([0, 0.94, 0.12]), Hips=(6, 8, -4), LowerBack=(6, 10, -4), Spine=(9, 12, -6), Spine1=(7, 12, -6), Neck=(-6, -2, 0), Head=(-6, -4, 0))),
        (1.0, dict(root=np.array([0, 0.92, 0.16]), Hips=(12, 18, -2), LowerBack=(9, 10, -2), Spine=(12, 10, -2), Spine1=(9, 8, -2), Neck=(-6, -8, 0), Head=(-8, -8, 0))),
        (dur, dict(root=np.array([0, 0.94, 0.12]), Hips=(2, -6, 0), LowerBack=(2, 0, 0), Spine=(3, 2, 0), Spine1=(3, 2, 0), Neck=(-2, 2, 0), Head=(-2, 4, 0))),
    ]
    path = [(0.0, [-0.12, 1.18, 0.26]), (0.22, [-0.24, 1.16, 0.02]), (0.40, [-0.34, 1.34, -0.24]), (0.56, [-0.36, 1.62, -0.34]),
            (0.70, [-0.28, 1.82, -0.12]), (rel, [-0.18, 1.84, 0.26]), (0.92, [-0.06, 1.62, 0.58]), (1.08, [0.04, 1.30, 0.58]),
            (1.25, [-0.04, 1.18, 0.40]), (dur, [-0.12, 1.18, 0.30])]
    pole_keys = [(0.0, [-0.6, -0.4, -0.2]), (0.22, [-0.7, -0.45, 0.05]), (0.40, [-0.8, -0.25, 0.15]), (0.56, [-0.8, -0.02, 0.25]), (0.70, [-0.65, 0.15, 0.5]),
                 (rel, [-0.55, 0.0, 0.55]), (0.92, [-0.55, -0.4, 0.3]), (1.08, [-0.6, -0.5, 0.05]), (dur, [-0.6, -0.4, -0.2])]
    # left hand: rifle by the handguard, swung forward and up at the target for balance during the wind-up, pulled in at the release
    lpath = [(0.0, [0.24, 0.98, 0.20]), (0.35, [0.22, 1.16, 0.40]), (0.62, [0.18, 1.24, 0.46]), (rel, [0.26, 1.04, 0.16]),
             (1.05, [0.24, 0.98, 0.12]), (dur, [0.24, 0.98, 0.20])]
    feet = (((0.13, 0.06), (0.15, 0.36), 0.42, 0.68), (-0.12, -0.14))
    fdir = [(0.0, [0.0, 0.5, 0.8]), (0.22, [-0.2, 0.7, 0.3]), (0.40, [-0.2, 0.9, -0.2]), (0.56, [-0.1, 0.8, -0.5]), (0.70, [0.0, 0.9, 0.2]),
            (rel, [0.0, 0.5, 0.85]), (0.92, [0.2, 0.0, 1.0]), (1.08, [0.3, 0.3, 0.8]), (dur, [0.0, 0.5, 0.8])]
    return _throw(rig, 'throw_grenade_over', body, dur, rel, path, pole_keys, lpath, feet, (0.66, 0.05, 0.2), fdir=fdir, smooth_w=3.2,
                  notes='v7 standing overhand throw (15-35 m): grenade in the right hand (weapon_socket), rifle in the left (weapon_socket_L); '
                        'left arm at the target, right arm cocked behind the head, steps in with the left foot, releases above the head at 0.72 s (hand whip peak 0.63 s) '
                        '(~30 deg up), follows through across the body, recovers by 1.45 s',
                  events={'move_weapon_to': 'weapon_socket_L', 'pin_pull': 0.18, 'release': 0.72, 'release_dir_up_deg': 30, 'grenade_socket': 'weapon_socket'})


def throw_grenade_low(rig, dur=1.35):
    rel = 0.70
    body = [
        (0.0, dict(root=np.array([0, 0.70, 0.0]), Hips=(28, -10, 0), LowerBack=(6, 0, 0), Spine=(8, 2, 0), Spine1=(6, 2, 0), Neck=(-14, 0, 0), Head=(-12, 4, 0))),
        (0.36, dict(root=np.array([0, 0.66, -0.04]), Hips=(34, -16, 0), LowerBack=(8, -4, 2), Spine=(10, -5, 3), Spine1=(6, -5, 3), Neck=(-16, 10, 0), Head=(-14, 12, 0))),
        (rel, dict(root=np.array([0, 0.74, 0.10]), Hips=(24, 4, -2), LowerBack=(4, 5, -2), Spine=(4, 5, -3), Spine1=(2, 4, -3), Neck=(-14, -2, 0), Head=(-12, -2, 0))),
        (0.92, dict(root=np.array([0, 0.72, 0.10]), Hips=(26, 6, -2), LowerBack=(5, 4, -2), Spine=(6, 4, -2), Spine1=(4, 3, -2), Neck=(-14, -4, 0), Head=(-12, -4, 0))),
        (dur, dict(root=np.array([0, 0.70, 0.04]), Hips=(28, -8, 0), LowerBack=(6, 0, 0), Spine=(8, 2, 0), Spine1=(6, 2, 0), Neck=(-14, 0, 0), Head=(-12, 4, 0))),
    ]
    path = [(0.0, [-0.16, 0.98, 0.40]), (0.18, [-0.26, 0.80, 0.12]), (0.36, [-0.26, 0.58, -0.26]), (0.50, [-0.22, 0.56, -0.08]),
            (rel, [-0.14, 0.96, 0.46]), (0.84, [-0.10, 1.20, 0.56]), (1.02, [-0.14, 1.08, 0.46]), (dur, [-0.16, 0.98, 0.40])]
    pole_keys = [(0.0, [-0.6, -0.4, -0.2]), (0.36, [-0.5, -0.2, -0.5]), (0.50, [-0.6, -0.5, -0.2]), (rel, [-0.6, -0.6, 0.1]),
                 (0.84, [-0.6, -0.5, 0.2]), (dur, [-0.6, -0.4, -0.2])]
    lpath = [(0.0, [0.30, 0.72, 0.42]), (0.36, [0.30, 0.73, 0.44]), (rel, [0.30, 0.72, 0.40]), (dur, [0.30, 0.72, 0.42])]
    feet = (((0.15, 0.20), (0.16, 0.28), 0.40, 0.62), (-0.14, -0.22))
    fdir = [(0.0, [0.0, -0.2, 1.0]), (0.18, [0.0, -0.8, 0.5]), (0.36, [0.0, -0.9, -0.4]), (0.50, [0.0, -0.9, 0.1]), (rel, [0.0, 0.2, 1.0]),
            (0.84, [0.0, 0.6, 0.8]), (dur, [0.0, -0.2, 1.0])]
    return _throw(rig, 'throw_grenade_low', body, dur, rel, path, pole_keys, lpath, feet, (0.56, 0.05, 0.18), knee_fwd=0.8, smooth_w=2.0,
                  hq_rel_dirs=((0.0, 0.6, 0.8), (-0.2, 0.8, -0.6)), fdir=fdir, lpole=(0.6, -0.6, 0.1), follow=True,
                  notes='v7 crouched underhand lob from cover (doorway, trench bend, dugout entrance, window from below): grenade in the right hand '
                        '(weapon_socket), rifle low in the left (weapon_socket_L); hand swings back low past the hip, lobs forward-up, releases at '
                        'chest height at 0.66 s (~45 deg up), recovers crouched by 1.35 s',
                  events={'move_weapon_to': 'weapon_socket_L', 'pin_pull': 0.12, 'release': 0.66, 'release_dir_up_deg': 45, 'grenade_socket': 'weapon_socket'})
