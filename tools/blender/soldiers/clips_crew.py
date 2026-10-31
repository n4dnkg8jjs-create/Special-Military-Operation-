"""Vehicle-crew clips: Makarov PM pistol set (pistol_idle / pistol_aim / pistol_fire / pistol_walk / pistol_run /
pistol_crouch_aim) and hatch_exit (climb out of a turret hatch, onto the deck, down to the ground; root motion).
Conventions (anim.py): joint frames world-aligned in bind pose; local euler (deg, order YXZ): +X pitch forward, hip flexion
-X on *UpLeg, knee flexion +X on *Leg, +Y yaw to the character's left, +Z roll to the character's right.
Model space: +X = character's left, +Y up, +Z forward.

Pistol hold: pm.glb parented to weapon_socket (RightHand) with identity -- same socket and hand pose as the rifles (the PM grip
rakes 18.7 deg like the AK pistol grip).  The support (left) palm sits on the left grip panel at PISTOL['grip_L'] (gun space)
with the fingers wrapped forward-down around the front strap over the right fingers (PISTOL['h'] / ['p'] = finger / palm-normal
directions in gun space)."""
import json, os
import numpy as np
import anim as A
import clips as C
from anim import FPS, fk_global, smooth
from qmath import qmul, qinv, qrot, qaxis, qeuler, qslerp, qfrom_mat, qfix_continuity
from clips_extra import add_euler, noise, osc, hand_q, arm_to, leg_to, to_clip, spline_keys, bone_pt, ground_clamp

HERE = os.path.dirname(os.path.abspath(__file__))
Y = np.array([0, 1.0, 0])
PISTOL = dict(grip_L=np.array([0.0235, -0.0140, 0.0040]), h=np.array([-0.22, -0.62, 0.75]), p=np.array([-1.0, 0.0, -0.05]),
              sight=np.array([0, 0.0695, -0.0345]), front=np.array([0, 0.0702, 0.1015]), muzzle=np.array([0, 0.0505, 0.1125]))
EYE_DIST = 0.33          # right eye -> rear sight (arms extended, isosceles; the rig's shoulder->wrist reach is 0.51 m)
POLE_R = np.array([-0.45, -0.55, -0.15]); POLE_L = np.array([0.45, -0.55, -0.15])


def setup():
    wi = json.load(open(os.path.join(HERE, '.cache', 'weapons_info.json')))
    if 'pm' in wi:
        e = wi['pm']['empties']
        PISTOL['grip_L'] = np.array(e['grip_L'][0]); PISTOL['sight'] = np.array(e['sight_rear'][0])
        PISTOL['front'] = np.array(e['sight_front'][0]); PISTOL['muzzle'] = np.array(e['muzzle'][0])


def support_target(rig, gun_q, gun_p):
    """left palm position + global hand rotation for the two-handed pistol grip"""
    F = len(gun_q)
    palm = gun_p + qrot(gun_q, np.broadcast_to(PISTOL['grip_L'], (F, 3)))
    h = qrot(gun_q, np.broadcast_to(PISTOL['h'] / np.linalg.norm(PISTOL['h']), (F, 3)))
    p = qrot(gun_q, np.broadcast_to(PISTOL['p'], (F, 3)))
    return palm, hand_q(rig, 'Left', h, p)


def pistol_hold(rig, gq, root, gun_q, gun_p, poleR=None, poleL=None, left=True):
    F = len(gq)
    gp = fk_global(rig.sk, gq, root)
    I = rig.I
    pR = gp[:, I['RightArm']] + POLE_R if poleR is None else poleR
    pL = gp[:, I['LeftArm']] + POLE_L if poleL is None else poleL
    if left:
        palm, qL = support_target(rig, gun_q, gun_p)
        return A.rifle_overlay(rig, gq, root, gun_q, gun_p, left='target', left_target=palm, left_rot=qL, poleR=pR, poleL=pL,
                               curlR=(58, 72, 22), curlL=(40, 45, 12))
    return A.rifle_overlay(rig, gq, root, gun_q, gun_p, left=None, poleR=pR, poleL=pL, curlR=(58, 72, 22))


def eye_world(rig, lm, gq, root):
    gp = fk_global(rig.sk, gq, root)
    return gp[:, rig.I['Head']] + qrot(gq[:, rig.I['Head']], np.broadcast_to(lm['eyeR'] - rig.sk.head[rig.I['Head']], (len(gq), 3)))


def aim_gun(rig, lm, gq, root, aim_dir=np.array([0, 0, 1.0]), dist=EYE_DIST):
    """gun pose with the sights on the line from the right eye along aim_dir"""
    d = aim_dir / np.linalg.norm(aim_dir)
    F = len(gq)
    gun_q = np.broadcast_to(qmul(qaxis(Y, np.arctan2(d[0], d[2])), qaxis([1, 0, 0], -np.arcsin(np.clip(d[1], -1, 1)))), (F, 4)).copy()
    eye = eye_world(rig, lm, gq, root)
    gun_p = eye + d * dist - qrot(gun_q, np.broadcast_to(PISTOL['sight'], (F, 3)))
    return gun_q, gun_p


def chest_rel(rig, gq, root, gun_q, gun_p):
    cq, cp = A.chest_frame(rig.sk, gq, root)
    return qmul(qinv(cq[0]), gun_q[0]), qrot(qinv(cq[0]), gun_p[0] - cp[0])


def carried(rig, gq, root, relq, relp, stab=0.0):
    """gun carried by the chest; stab (0..1) removes that share of the chest's rotation oscillation around its mean"""
    cq, cp = A.chest_frame(rig.sk, gq, root)
    F = len(gq)
    if stab > 0:
        qm = cq.mean(0); qm /= np.linalg.norm(qm)
        cq = np.array([qslerp(cq[f], qm, stab) for f in range(F)])
    return qmul(cq, np.broadcast_to(relq, (F, 4))), cp + qrot(cq, np.broadcast_to(relp, (F, 3)))


# ------------------------------------------------------------------ stances
ISO = dict(drop=0.03, hip_yaw=3, spine=(9, 4, 8, 4), lfoot=(0.15, 0.10), rfoot=(-0.15, -0.06), lyaw=-10, ryaw=-18, head=(0, 0))
READY = dict(drop=0.02, hip_yaw=-8, spine=(4, 3, 3, 3), lfoot=(0.13, 0.07), rfoot=(-0.13, -0.05), lyaw=-8, ryaw=-22, head=(4, 2))


def aim_base(rig, lm, stance, plant_feet):
    gq1, root1, feet = stance(rig, 1, **ISO)
    gq1 = plant_feet(rig, gq1, root1, feet)
    lq = rig.local(gq1)
    add_euler(rig, lq, 'Neck', -11, 0, 0); add_euler(rig, lq, 'Head', -9, 0, 0)    # face level over the forward-leaning trunk
    gq1 = rig.global_from_local(lq)
    gun_q, gun_p = aim_gun(rig, lm, gq1, root1)
    relq, relp = chest_rel(rig, gq1, root1, gun_q, gun_p)
    return dict(lq=lq, root=root1, feet=feet, relq=relq, relp=relp, legs=lambda g, r: plant_feet(rig, g, r, feet))


def pistol_clips(rig, lm, R, want, stance, plant_feet, kneel, kneel_legs, loco_body):
    setup()
    out = {}
    I = rig.I
    base = aim_base(rig, lm, stance, plant_feet)
    # ---------------- pistol_aim: isosceles two-handed aim, 3 s loop, breathing (sights follow the chest a little)
    if want('pistol_aim') or want('pistol_fire'):
        F = 3 * FPS + 1
        lq = np.repeat(base['lq'], F, 0); root = np.repeat(base['root'], F, 0)
        lq = C.breathing(rig, lq, F, 1, 0.5)
        gq = base['legs'](rig.global_from_local(lq), root)
        gun_q, gun_p = carried(rig, gq, root, base['relq'], base['relp'])
        gq2, err = pistol_hold(rig, gq, root, gun_q, gun_p)
        if want('pistol_aim'):
            out['pistol_aim'] = to_clip('pistol_aim', rig, gq2, root, True,
                                        notes=f'isosceles two-handed PM aim: right eye on the sight line {EYE_DIST:.2f} m behind the rear sight, arms extended, '
                                              f'support palm on the left grip panel (fingers over the right hand); breathing; ik err {_e(err)}')
    # ---------------- pistol_fire: one shot, 0.267 s (9 frames), first/last frame == pistol_aim frame 0
    if want('pistol_fire'):
        k = np.array([0.0, 1.0, 0.82, 0.58, 0.36, 0.19, 0.08, 0.02, 0.0])
        kb = np.array([0.0, 0.45, 0.85, 0.7, 0.45, 0.24, 0.1, 0.03, 0.0])
        F = len(k)
        lq = np.repeat(base['lq'], F, 0); root = np.repeat(base['root'], F, 0).copy()
        add_euler(rig, lq, 'Spine1', -1.6 * kb, 0, 0); add_euler(rig, lq, 'Spine', -0.6 * kb, 0, 0)
        add_euler(rig, lq, 'Head', -1.0 * kb, 0, 0)
        root[:, 2] -= 0.004 * kb
        gq = base['legs'](rig.global_from_local(lq), root)
        g0q, g0p = carried(rig, gq[:1], root[:1], base['relq'], base['relp'])
        gun_q = np.repeat(g0q, F, 0); gun_p = np.repeat(g0p, F, 0)
        cq, cp = A.chest_frame(rig.sk, gq, root)
        gun_p = gun_p + (cp - cp[0])
        # muzzle flip ~11 deg about the web of the hand (behind / above the grip), slide-mass pushes the gun 2.5 cm back
        piv = np.array([0, 0.035, -0.035])
        flip = np.array([qaxis([1, 0, 0], -np.radians(11.0 * a)) for a in k])
        pw = gun_p + qrot(gun_q, np.broadcast_to(piv, (F, 3)))
        gun_q2 = qmul(gun_q, flip)
        gun_p2 = pw - qrot(gun_q2, np.broadcast_to(piv, (F, 3))) + np.outer(k, [0, 0.008, -0.025])
        gq2, err = pistol_hold(rig, gq, root, gun_q2, gun_p2)
        out['pistol_fire'] = to_clip('pistol_fire', rig, gq2, root, True,
                                     notes=f'one PM shot, {(F - 1) / FPS:.3f} s ({F} frames): report / muzzle flash at t=0 on the aim line, peak muzzle flip 11 deg + 2.5 cm '
                                           f'push back at 0.033 s (wrists break, elbows give, chest absorbs), recovered by the last frame; first/last frame == pistol_aim '
                                           f'frame 0 so it loops for follow-up shots (~3.75 shots/s at timeScale 1) and blends back into pistol_aim; ik err {_e(err)}',
                                     events={'shot': 0.0})
    # ---------------- pistol_idle: two-handed low ready (muzzle ~40 deg down, in front of the belly), looking around
    if want('pistol_idle'):
        F = 4 * FPS + 1
        gq, root, feet = stance(rig, F, **READY)
        lq = rig.local(gq)
        lq = C.breathing(rig, lq, F, 1, 1.0)
        C.add_local(rig, lq, 'Hips', lambda f: (0 * f, 1.5 * osc(F, 1), 1.0 * osc(F, 1)))
        C.add_local(rig, lq, 'Head', lambda f: (1.5 * osc(F, 2, 1.0), 12 * osc(F, 1, 0.6) * np.clip(osc(F, 1, 0.6) * 2, -1, 1) * 0.6, 0 * f))
        gq = rig.global_from_local(lq)
        root = root.copy(); root[:, 0] += 0.012 * osc(F, 1)
        gq = plant_feet(rig, gq, root, feet)
        low_p = np.array([-0.035, 1.10, 0.33]); low_q = qeuler(42, 3, 0, order='YXZ')
        gun_q, gun_p = A.gun_in_chest(rig.sk, gq, root, low_p, low_q)
        gq2, err = pistol_hold(rig, gq, root, gun_q, gun_p, poleR=fk_global(rig.sk, gq, root)[:, I['RightArm']] + [-0.35, -0.7, 0.0],
                               poleL=fk_global(rig.sk, gq, root)[:, I['LeftArm']] + [0.35, -0.7, 0.0])
        out['pistol_idle'] = to_clip('pistol_idle', rig, gq2, root, True,
                                     notes=f'relaxed stance, PM in both hands at low ready (in front of the belly, muzzle ~42 deg down), breathing, weight shift, looking around; ik err {_e(err)}')
    # ---------------- pistol_crouch_aim: kneeling on the right knee, two-handed aim
    if want('pistol_crouch_aim'):
        kq, kr, kfeet = kneel(rig, 1)
        lq1 = rig.local(kq)
        add_euler(rig, lq1, 'Hips', 0, 8, 0); add_euler(rig, lq1, 'Spine1', 4, -6, 0); add_euler(rig, lq1, 'Neck', -6, -2, 0); add_euler(rig, lq1, 'Head', -4, 0, 0)
        gq1 = kneel_legs(rig, rig.global_from_local(lq1), kr, kfeet)
        gun_q, gun_p = aim_gun(rig, lm, gq1, kr)
        relq, relp = chest_rel(rig, gq1, kr, gun_q, gun_p)
        F = 3 * FPS + 1
        lq = np.repeat(lq1, F, 0); root = np.repeat(kr, F, 0)
        lq = C.breathing(rig, lq, F, 1, 0.5)
        gq = kneel_legs(rig, rig.global_from_local(lq), root, kfeet)
        gun_q, gun_p = carried(rig, gq, root, relq, relp)
        gq2, err = pistol_hold(rig, gq, root, gun_q, gun_p)
        out['pistol_crouch_aim'] = to_clip('pistol_crouch_aim', rig, gq2, root, True,
                                           notes=f'kneeling on the right knee (same legs as aim_crouch), isosceles two-handed PM aim, right eye on the sight line; ik err {_e(err)}')
    # ---------------- locomotion
    if want('pistol_walk'):
        gq, root, sp, cyc = loco_body('07_01', 0.0, None, 26, 45, lean=4, sink=0.04)
        # aiming walk: sights on the eye line of the cycle's mean posture, chest oscillation 75 % removed (arms absorb it)
        g0q, g0p = aim_gun(rig, lm, gq, root)
        cq, cp = A.chest_frame(rig.sk, gq, root)
        qm = cq.mean(0); qm /= np.linalg.norm(qm)
        relq = qmul(qinv(qm), g0q.mean(0) / np.linalg.norm(g0q.mean(0)))
        relp = qrot(qinv(qm), (g0p - cp).mean(0))
        gun_q, gun_p = carried(rig, gq, root, relq, relp, stab=0.75)
        # damp the vertical bob of the gun to 40 %
        gun_p[:, 1] = gun_p[:, 1].mean() + 0.4 * (gun_p[:, 1] - gun_p[:, 1].mean())
        gq2, err = pistol_hold(rig, gq, root, gun_q, gun_p)
        out['pistol_walk'] = to_clip('pistol_walk', rig, gq2, root, True, sp,
                                     notes=f'aiming walk: CMU 07_01 legs (pelvis lowered 4 cm, planted foot pinned), PM up in both hands on the eye line, gun stabilised '
                                           f'(75 % of the chest sway and 60 % of the bob removed); {sp:.2f} m/s; cycle {cyc}; ik err {_e(err)}')
    if want('pistol_run'):
        gq, root, sp, cyc = loco_body('16_45', 0.0, None, 16, 26, lean=12, sink=0.035)
        cr_p = np.array([-0.02, 1.20, 0.25]); cr_q = qeuler(28, 2, 0, order='YXZ')
        gun_q, gun_p = A.gun_in_chest(rig.sk, gq, root, cr_p, cr_q)
        gq2, err = pistol_hold(rig, gq, root, gun_q, gun_p, poleR=fk_global(rig.sk, gq, root)[:, I['RightArm']] + [-0.4, -0.6, -0.25],
                               poleL=fk_global(rig.sk, gq, root)[:, I['LeftArm']] + [0.4, -0.6, -0.25])
        out['pistol_run'] = to_clip('pistol_run', rig, gq2, root, True, sp,
                                    notes=f'combat run: CMU 16_45 legs (bent knees, 12 deg lean, planted foot pinned), PM held close to the chest in both hands '
                                          f'(compressed ready, muzzle ~28 deg down); {sp:.2f} m/s; cycle {cyc}; ik err {_e(err)}')
    return out


def _e(err):
    return {k: round(float(v), 4) for k, v in err.items()}


# ====================================================================================== hatch_exit
# Clip frame = the soldier root at the END of the clip (standing on the ground beside the vehicle, facing +Z = away from it).
# Authored for a T-72-sized vehicle, exiting sideways from the commander's turret hatch:
HATCH = dict(rim=np.array([0.0, 2.25, -1.80]), radius=0.33, roof_y=2.20, roof_edge_z=-1.15, deck_y=1.45, deck_edge_z=-0.42, floor_y=0.42)
ANK = 0.072      # ankle joint height above the sole (flat foot)


def _pw(keys, t):
    """piecewise smoothstep through (t, vec) keys"""
    kt = np.array([k[0] for k in keys]); kv = np.array([np.asarray(k[1], float) for k in keys])
    out = np.zeros((len(t), kv.shape[1]))
    for f, tt in enumerate(t):
        j = min(max(np.searchsorted(kt, tt, side='right') - 1, 0), len(kt) - 2)
        w = smooth(np.clip((tt - kt[j]) / max(kt[j + 1] - kt[j], 1e-6), 0, 1))
        out[f] = kv[j] * (1 - w) + kv[j + 1] * w
    return out


def hatch_exit(rig, lm, stance, plant_feet, dur=2.7):
    I = rig.I
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    Hh = HATCH
    g = 9.81
    # ---------------------------------------------------------------- root (Hips joint) path
    T_OFF1, T_TD1 = 1.08, 1.37          # step off the turret roof -> onto the fender
    T_OFF2, T_TD2 = 1.60, 2.19          # jump off the fender -> ground ('landed')
    keys = [(0.00, (0, 1.33, -1.88)), (0.10, (0, 1.33, -1.88)), (0.22, (0, 1.48, -1.87)), (0.36, (0, 1.92, -1.85)), (0.52, (0, 2.42, -1.80)), (0.70, (0, 2.60, -1.62)),
            (0.86, (0, 2.71, -1.42)), (1.00, (0, 2.74, -1.28)), (T_OFF1, (0, 2.78, -1.20))]
    root = np.zeros((F, 3))
    sp = spline_keys(keys, F, 3)
    m0 = t <= T_OFF1
    root[m0] = sp[m0]
    p1 = np.array([0, 2.78, -1.20]); v1 = np.array([0, 0.0, 1.6])
    m1 = (t > T_OFF1) & (t <= T_TD1)
    s = t[m1] - T_OFF1
    root[m1] = p1 + np.outer(s, v1) - np.outer(0.5 * g * s * s, [0, 1, 0])
    td1 = p1 + v1 * (T_TD1 - T_OFF1) - [0, 0.5 * g * (T_TD1 - T_OFF1) ** 2, 0]
    p2 = np.array([0, 2.10, -0.44]); v2 = np.array([0, 1.0, 0.70])
    keys2 = [(T_TD1, td1), (T_TD1 + 0.07, td1 + [0, -0.20, 0.07]), (1.50, (0, 2.03, -0.54)), (T_OFF2, p2)]
    m2 = (t > T_TD1) & (t <= T_OFF2)
    root[m2] = _pw(keys2, t[m2])
    m3 = (t > T_OFF2) & (t <= T_TD2)
    s = t[m3] - T_OFF2
    root[m3] = p2 + np.outer(s, v2) - np.outer(0.5 * g * s * s, [0, 1, 0])
    td2 = p2 + v2 * (T_TD2 - T_OFF2) - [0, 0.5 * g * (T_TD2 - T_OFF2) ** 2, 0]
    m4 = t > T_TD2
    root[m4] = _pw([(T_TD2, td2), (T_TD2 + 0.16, (0, 0.62, -0.01)), (2.45, (0, 0.70, 0.0)), (dur, (0, 0.90, 0.0))], t[m4])
    # ---------------------------------------------------------------- body (local eulers)
    sh_up = dict(LeftShoulder=(0, 0, 22), RightShoulder=(0, 0, -22))
    P = lambda **kw: kw
    bkeys = [
        (0.00, P(Hips=(4, 0, 0), LowerBack=(4, 0, 0), Spine=(3, 0, 0), Spine1=(2, 0, 0), Neck=(-10, 0, 0), Head=(-12, 0, 0), **sh_up)),
        (0.28, P(Hips=(6, 0, 0), LowerBack=(4, 0, 0), Spine=(3, 0, 0), Spine1=(2, 0, 0), Neck=(-8, 0, 0), Head=(-6, 0, 0), LeftShoulder=(0, 0, 10), RightShoulder=(0, 0, -10))),
        (0.42, P(Hips=(12, 0, 0), LowerBack=(6, 0, 0), Spine=(4, 0, 0), Spine1=(2, 0, 0), Neck=(-6, 0, 0), Head=(-4, 0, 0))),
        (0.54, P(Hips=(30, 0, 0), LowerBack=(9, 0, 0), Spine=(8, 0, 0), Spine1=(5, 0, 0), Neck=(-16, 0, 0), Head=(-8, 0, 0))),
        (0.72, P(Hips=(46, -6, 4), LowerBack=(10, 2, 0), Spine=(10, 2, 0), Spine1=(6, 0, 0), Neck=(-22, 0, 0), Head=(-10, 4, 0))),
        (0.88, P(Hips=(40, -4, 0), LowerBack=(10, 0, 0), Spine=(10, 0, 0), Spine1=(6, 0, 0), Neck=(-20, 0, 0), Head=(-8, 0, 0))),
        (1.01, P(Hips=(32, 0, 0), LowerBack=(10, 0, 0), Spine=(8, 0, 0), Spine1=(6, 0, 0), Neck=(-16, 0, 0), Head=(-8, 0, 0))),
        (T_OFF1, P(Hips=(20, 0, 0), LowerBack=(6, 0, 0), Spine=(5, 0, 0), Spine1=(4, 0, 0), Neck=(-10, 0, 0), Head=(-6, 0, 0))),
        (1.24, P(Hips=(8, 0, 0), LowerBack=(4, 0, 0), Spine=(4, 0, 0), Spine1=(2, 0, 0), Neck=(-4, 0, 0), Head=(4, 0, 0))),
        (T_TD1 + 0.07, P(Hips=(30, 0, 0), LowerBack=(8, 0, 0), Spine=(8, 0, 0), Spine1=(6, 0, 0), Neck=(-14, 0, 0), Head=(0, 0, 0))),
        (1.52, P(Hips=(38, 0, 0), LowerBack=(10, 0, 0), Spine=(10, 0, 0), Spine1=(6, 0, 0), Neck=(-18, 0, 0), Head=(-4, 0, 0))),
        (T_OFF2, P(Hips=(18, 0, 0), LowerBack=(6, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(-10, 0, 0), Head=(4, 0, 0))),
        (1.90, P(Hips=(4, 0, 0), LowerBack=(3, 0, 0), Spine=(3, 0, 0), Spine1=(2, 0, 0), Neck=(-2, 0, 0), Head=(8, 0, 0))),
        (T_TD2, P(Hips=(14, 0, 0), LowerBack=(5, 0, 0), Spine=(5, 0, 0), Spine1=(3, 0, 0), Neck=(-6, 0, 0), Head=(6, 0, 0))),
        (T_TD2 + 0.16, P(Hips=(40, -4, 0), LowerBack=(12, 0, 0), Spine=(12, 0, 0), Spine1=(8, 0, 0), Neck=(-22, 0, 0), Head=(-6, 0, 0))),
        (dur, P(Hips=(12, -8, 0), LowerBack=(5, 3, 0), Spine=(4, 3, 0), Spine1=(3, 2, 0), Neck=(-6, 0, 0), Head=(-2, 6, 0))),
    ]
    from clips_extra import keyed
    lq, _ = keyed(rig, [(k, dict(p, root=np.zeros(3))) for k, p in bkeys], dur)
    gq = rig.global_from_local(lq)
    gp = fk_global(rig.sk, gq, root)
    # ---------------------------------------------------------------- feet: planted spots / dangling / flight (relative to the hips)
    ry, dy = Hh['roof_y'] + ANK, Hh['deck_y'] + ANK
    legs = {}
    fl = lambda pitch, yaw: qeuler(pitch, yaw, 0, order='YXZ')
    for side, sx in (('Left', 1), ('Right', -1)):
        if side == 'Left':
            spots = [(0.00, 0.12, (0.12, Hh['floor_y'] + ANK, -1.80), fl(0, -6)),
                     (0.88, T_OFF1, (0.15, ry, -1.30), fl(0, -8)),
                     (T_TD1, T_OFF2, (0.13, dy, -0.57), fl(0, -6)),
                     (T_TD2, dur + 1, (0.15, ANK, 0.10), fl(0, -10))]
        else:
            spots = [(0.00, 0.11, (-0.12, Hh['floor_y'] + ANK, -1.94), fl(0, 8)),
                     (0.70, 0.76, (-0.33, Hh['roof_y'] + 0.085, -1.62), fl(150, 18)),     # kneeling: shin on the roof, toes back / down
                     (1.02, T_OFF1, (-0.13, ry, -1.24), fl(0, 8)),
                     (T_TD1, T_OFF2, (-0.13, dy, -0.66), fl(0, 10)),
                     (T_TD2, dur + 1, (-0.15, ANK, -0.12), fl(0, 14))]
        hang = root + np.array([sx * 0.11, -0.845, -0.10])
        hole_c = np.array([0.0, 0.0, Hh['rim'][2]])
        ank = np.zeros((F, 3)); fq = np.zeros((F, 4)); planted = np.zeros(F, bool)
        for f, tt in enumerate(t):
            cur = [sp_ for sp_ in spots if sp_[0] <= tt <= sp_[1]]
            if cur:
                ank[f] = cur[0][2]; fq[f] = cur[0][3]; planted[f] = True
                continue
            prev = [sp_ for sp_ in spots if sp_[1] < tt]; nxt = [sp_ for sp_ in spots if sp_[0] > tt]
            a, b = prev[-1], nxt[0]
            fa, fb = int(round(a[1] * FPS)), int(round(b[0] * FPS))
            w = smooth(np.clip((tt - a[1]) / max(b[0] - a[1], 1e-6), 0, 1))
            ra = np.asarray(a[2]) - root[fa]; rb = np.asarray(b[2]) - root[min(fb, F - 1)]
            if a[1] < 0.5 and b[0] < 0.9:          # legs dangle straight down inside the hatch until the hips clear the rim, then out over it
                rel_mid = hang[f] - root[f]
                w_in = smooth(np.clip((tt - a[1]) / 0.12, 0, 1))
                rel = ra * (1 - w_in) + rel_mid * w_in
                # tuck: the foot first rises inside the hatch column (to just under the rim), then goes out and down onto the roof
                t_up = 0.50 if side == 'Right' else 0.64
                t_mid = t_up + (0.6 if side == 'Right' else 0.45) * (b[0] - t_up)
                up_p = np.array([np.asarray(b[2])[0] * 0.35, Hh['rim'][1] + (0.05 if side == 'Right' else 0.10), Hh['rim'][2] - 0.02])
                w_up = smooth(np.clip((tt - t_up) / (t_mid - t_up), 0, 1)); w_o = smooth(np.clip((tt - t_mid) / (b[0] - t_mid), 0, 1))
                p_ = root[f] + rel
                p_ = p_ * (1 - w_up) + up_p * w_up
                p_ = p_ * (1 - w_o) + np.asarray(b[2]) * w_o
                rel = p_ - root[f]
                p_ = root[f] + rel
                if p_[1] < Hh['rim'][1] - 0.01:          # below the rim: keep the foot (toes included) inside the hatch column
                    d_ = (p_ - hole_c - [0, 0, -0.06]) * [1, 0, 1]; rr_ = np.linalg.norm(d_)
                    if rr_ > 0.16:
                        p_ = p_ - d_ * (1 - 0.16 / rr_)
                    rel = p_ - root[f]
            else:                                  # flight: the leg reaches from the take-off to the landing configuration
                rel = ra * (1 - w) + rb * w + np.array([0, 0.22 * np.sin(np.pi * w), 0.08 * np.sin(np.pi * w)])     # legs tuck over the edge
            ank[f] = root[f] + rel
            qa, qb = a[3], b[3]
            if a[1] < 0.5 and b[0] < 0.9:      # climbing out: toes hang down, then the foot turns to its roof pose
                fq[f] = qslerp(qslerp(qa, fl(35, 0), smooth(np.clip((tt - a[1]) / 0.15, 0, 1))), qb, smooth(np.clip((tt - (b[0] - 0.15)) / 0.15, 0, 1)))
            elif side == 'Right' and 0.75 < tt < 1.03:      # kneel -> stand: the foot turns from toes-back through toes-down to flat
                fq[f] = fl(150 * (1 - w), 18 * (1 - w) + 8 * w)
            else:
                fq[f] = qslerp(qslerp(qa, fl(25, 0), np.sin(np.pi * w)), qb, w)
        pole = gp[:, I[side + 'Leg']] * 0 + root + np.array([sx * 0.15, 0.1, 0.9])
        legs[side] = (ank, pole, fq, planted)
    root, drop = A.fit_root_to_feet(rig, gq, root, {sd: np.where(legs[sd][3][:, None], legs[sd][0], fk_global(rig.sk, gq, root)[:, I[sd + 'UpLeg']])
                                                   for sd in legs}, slack=0.01)
    for side in legs:
        ank, pole, fq, _ = legs[side]
        gq = leg_to(rig, gq, root, side, ank, pole, foot_q=fq)
    # free legs (dangling, tucking, in flight): temporal smoothing of the leg locals (planted frames keep their exact contact)
    for side in legs:
        pl = legs[side][3].astype(float)
        free = 1 - np.minimum(1, np.convolve(np.pad(pl, 2, mode='edge'), np.ones(5) / 5, 'valid') * 1.0) ** 0.5
        free = np.where(legs[side][3] | (t < 1.05), 0.0, np.clip(free * 1.5, 0, 1))      # flights only (the climb keeps its exact knee path)
        gq = A.smooth_locals(rig, gq, (side + 'UpLeg', side + 'Leg', side + 'Foot'), 1.6, free)
    # ---------------------------------------------------------------- hands: rim -> roof -> balance -> flight -> landing
    gp = fk_global(rig.sk, gq, root)
    cq, cp = gq[:, I['Spine1']], gp[:, I['Spine1']]
    rim_y = Hh['rim'][1] + 0.022
    hands = {}
    for side, sx in (('Left', 1), ('Right', -1)):
        rim = np.array([sx * 0.25, rim_y, -1.56])
        roof = np.array([sx * 0.36, Hh['roof_y'] + 0.022, -1.20])
        chest = lambda off: cp + qrot(cq, np.broadcast_to(np.array(off) * [sx, 1, 1], (F, 3)))
        bal = chest([0.30, -0.12, 0.28]); fly = chest([0.42, 0.08, 0.10]); land = chest([0.26, -0.30, 0.34])
        w_rim = 1 - smooth(np.clip((t - (0.68 if side == 'Left' else 0.64)) / 0.12, 0, 1))
        w_roof = smooth(np.clip((t - (0.72 if side == 'Left' else 0.68)) / 0.10, 0, 1)) * (1 - smooth(np.clip((t - 0.94) / 0.12, 0, 1)))
        w_fly = smooth(np.clip((t - 1.55) / 0.18, 0, 1)) * (1 - smooth(np.clip((t - 2.08) / 0.2, 0, 1)))
        w_land = smooth(np.clip((t - 2.08) / 0.2, 0, 1))
        w_bal = np.clip(1 - w_rim - w_roof - w_fly - w_land, 0, 1)
        tgt = np.outer(w_rim, rim) + np.outer(w_roof, roof) + bal * w_bal[:, None] + fly * w_fly[:, None] + land * w_land[:, None]
        palm_dn = hand_q(rig, side, np.array([sx * 0.25, 0, 1.0]), np.array([0, -1.0, 0]))
        hq_free = hand_q(rig, side, qrot(cq, np.broadcast_to([sx * 0.3, -0.5, 0.8], (F, 3))), qrot(cq, np.broadcast_to([-sx * 0.8, -0.4, 0.0], (F, 3))))
        wp = np.clip(w_rim + w_roof, 0, 1)
        hq = np.array([qslerp(hq_free[f], palm_dn, wp[f]) for f in range(F)])
        pole = gp[:, I[side + 'Arm']] + np.outer(wp, [sx * 0.22, -0.05, -0.5]) + np.outer(1 - wp, [sx * 0.45, -0.5, -0.1])
        hands[side] = (tgt, hq, pole, wp)
        gq = arm_to(rig, gq, root, side, tgt, hq, pole)
    gq = A.smooth_locals(rig, gq, ('LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'), 2.2,
                         1 - np.maximum(hands['Left'][3], hands['Right'][3]))

    lq = rig.local(gq)
    for side in ('Left', 'Right'):
        lqg = lq.copy(); rig.finger_curl(lqg, side, 40, 50, 20)
        lqo = lq.copy(); rig.finger_curl(lqo, side, 18, 25, 8)
        w = hands[side][3]
        for b in (side + 'FingerBase', side + 'HandFinger1', 'LThumb' if side == 'Left' else 'RThumb'):
            i = I[b]
            lq[:, i] = np.array([qslerp(lqo[f, i], lqg[f, i], w[f]) for f in range(F)])
    gq = rig.global_from_local(lq)
    ev = {'hands_on_rim': [0.0, 0.66], 'hips_clear_rim': 0.50, 'knee_on_deck': 0.70, 'on_deck': 1.01, 'step_off': T_OFF1, 'on_fender': T_TD1,
          'jump': T_OFF2, 'landed': T_TD2}
    keyt = {'start': 0.0, 'on_deck': 1.01, 'on_fender': T_TD1, 'jump': T_OFF2, 'landed': T_TD2, 'end': dur}
    hips_at = {k: [round(float(v), 3) for v in root[min(int(round(tt * FPS)), F - 1)]] for k, tt in keyt.items()}
    geo = dict(hatch_rim_centre=Hh['rim'].tolist(), hatch_radius=Hh['radius'], turret_roof_y=Hh['roof_y'], turret_edge_z=Hh['roof_edge_z'],
               deck_y=Hh['deck_y'], deck_edge_z=Hh['deck_edge_z'], inside_floor_y=Hh['floor_y'])
    return to_clip('hatch_exit', rig, gq, root, False, root_motion=True,
                   notes=(f'crewman bails out of a turret hatch: standing inside on the floor ({Hh["floor_y"]:.2f} m), hips {Hh["rim"][1] - root[0, 1]:.2f} m below '
                          f'the rim ({Hh["rim"][1]:.2f} m), dips, jumps and pulls and presses up on the rim, right knee then left foot onto the turret roof (on_deck), steps off the '
                          f'turret edge onto the fender/deck ({Hh["deck_y"]:.2f} m), jumps down beside the vehicle and lands in a crouch (landed), rises. '
                          f'Root motion (vertical + horizontal) is in the Hips track; clip space = the soldier root at the END (on the ground, facing away '
                          f'from the vehicle): hatch rim centre at {Hh["rim"].tolist()} relative to it. No weapon in the hands (pistol holstered).'),
                   events=ev, extra=dict(hatch=dict(geometry=geo, hips_at=hips_at, fit_drop=round(float(drop), 3))))
