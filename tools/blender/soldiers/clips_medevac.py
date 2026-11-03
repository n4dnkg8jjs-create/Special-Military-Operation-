"""Casualty evacuation with the pickup truck (assets/vehicles/pickup.glb, src/game/medevac.js).

Medic clips (rifle slung on the back: soldier.js weapon rule for 'medevac_*'):
  medevac_cab_exit      once  sitting on the cab seat facing the truck's front -> swivels to the door, steps down, stands.
                              Clip frame = END root: standing on the ground beside the door facing away from the truck (+Z);
                              the seat H-point is CAB['seat'] in this frame (+X = the truck's front for the right-hand doors).
  medevac_cab_enter     once  the same motion reversed (stands at the door, climbs in, sits down facing forward).
  medevac_lift          once  casualty lying in front (root CARRY['lie_z'] m ahead, head to the carrier's left): squats,
                              pulls him up and rolls him onto the right shoulder, stands up (ends in medevac_carry_walk frame 0).
  medevac_carry_walk    loop  fireman's carry: walks with the casualty over the right shoulder, right arm round his legs,
                              left hand holding his wrist (legs: CMU walk from walk_rifle).
  medevac_load_bed      once  standing behind the open tailgate facing the truck (load_point): swings the casualty off the
                              shoulder onto the tailgate and pushes him along the bed to the stretcher slot, straightens up.
Casualty clips (paired, same root as the medic: the game puts the casualty's root on the medic's root and heading):
  wounded_lifted        once  pairs with medevac_lift
  wounded_carry_walk    loop  pairs with medevac_carry_walk (same length; the game keeps the two in phase)
  wounded_load_bed      once  pairs with medevac_load_bed; last frame == wounded_on_bed frame 0 placed at the stretcher slot
                              (LOAD['slot'] in the medic's frame, turned 180 deg: the slot's +Z points at the tailgate)
  wounded_on_bed        loop  lying on the back on the bed floor (root frame: floor at y = 0, head towards -Z), breathing,
                              head turning now and then, hands on the dressing.
"""
import os, pickle
import numpy as np
import anim as A
import clips as C
from anim import FPS, fk_global, smooth
from qmath import qmul, qinv, qrot, qaxis, qeuler, qslerp, qnorm, qfix_continuity
import clips_extra as CX

CLIPS = ('medevac_cab_exit', 'medevac_cab_enter', 'medevac_lift', 'medevac_carry_walk', 'medevac_load_bed',
         'wounded_lifted', 'wounded_carry_walk', 'wounded_load_bed', 'wounded_on_bed')
Y = np.array([0, 1.0, 0])
CAB = dict(seat=(-0.10, 0.84, -0.62), floor=0.50)      # pickup.py: H-point 0.84, door point 0.15 m outside the 0.895 m half width
CARRY = dict(lie_z=0.62)
LOAD = dict(slot=(0.0, 0.885, 1.65), tail_tip=0.44, bed_edge=0.85, bed_y=0.88)
HERE = os.path.dirname(os.path.abspath(__file__))


def _cached(name, built):
    if built and name in built:
        return built[name]
    p = os.path.join(HERE, '.cache', 'clips.pkl')
    full = pickle.load(open(p, 'rb'))
    return full[name]


def frames(dur):
    F = int(round(dur * FPS)) + 1
    return F, np.arange(F) / FPS


def wkey(t, keys):
    """piecewise smoothstep weight track: keys [(t, w)]"""
    kt = np.array([k[0] for k in keys]); kv = np.array([k[1] for k in keys], float)
    out = np.zeros(len(t))
    for i, tt in enumerate(t):
        j = min(max(np.searchsorted(kt, tt, side='right') - 1, 0), len(kt) - 1)
        if j >= len(kt) - 1:
            out[i] = kv[-1]; continue
        w = smooth((tt - kt[j]) / max(kt[j + 1] - kt[j], 1e-6))
        out[i] = kv[j] * (1 - w) + kv[j + 1] * w
    return out


def pose_track(rig, keys, t):
    """keys [(t, {bone: euler deg})] -> lq (F, nb, 4) with smoothstep slerp between keys (missing bones = rest)"""
    F = len(t)
    Ls = [C.pose_lq(rig, k[1])[0][0] for k in keys]
    kt = np.array([k[0] for k in keys])
    lq = np.zeros((F, rig.n, 4))
    for f in range(F):
        j = min(max(np.searchsorted(kt, t[f], side='right') - 1, 0), len(kt) - 1)
        if j >= len(kt) - 1:
            lq[f] = Ls[-1]; continue
        w = smooth((t[f] - kt[j]) / max(kt[j + 1] - kt[j], 1e-6))
        lq[f] = qslerp(Ls[j], Ls[j + 1], w)
    return lq


def blend_pose(lqa, roota, lqb, rootb, w):
    """per-frame slerp of two local-rotation tracks + lerp of roots, w (F,) 0 -> a, 1 -> b"""
    F = len(w)
    lq = np.zeros_like(lqa)
    for f in range(F):
        lq[f] = qslerp(lqa[f], lqb[f], w[f])
    return lq, roota * (1 - w[:, None]) + rootb * w[:, None]


def yaw_q(deg):
    return qaxis(Y, np.radians(deg))


def turn_pose(lq, root, deg, offset=(0, 0, 0)):
    """rotate a whole pose track about the vertical axis through the origin, then translate"""
    q = yaw_q(deg)
    lq = lq.copy(); lq[:, 0] = qmul(np.broadcast_to(q, lq[:, 0].shape), lq[:, 0])
    root = qrot(np.broadcast_to(q, (len(root), 4)), root) + np.asarray(offset)
    return lq, root


def ankle_y(rig):
    return rig.sk.head[rig.I['LeftFoot'], 1]


def legs_to(rig, gq, root, ankles, fwd_yaw_deg=None):
    """leg IK for both sides: ankles = {'Left': (F,3), 'Right': (F,3)}; knee poles ahead of the hips along the body facing"""
    I = rig.I
    gp = fk_global(rig.sk, gq, root)
    hq = gq[:, I['Hips']]
    fwd = qrot(hq, np.broadcast_to([0, 0, 1.0], (len(gq), 3))); fwd[:, 1] = 0
    fwd /= np.maximum(np.linalg.norm(fwd, axis=1, keepdims=True), 1e-6)
    # feet flat on the floor, pointing where the body faces (a pitched pelvis no longer tips the toes into the ground)
    fq = np.array([qaxis(Y, np.arctan2(f[0], f[2])) for f in fwd])
    for side in ('Left', 'Right'):
        pole = gp[:, I[side + 'UpLeg']] + fwd * 0.8 + np.array([0, 0.1, 0])
        gq = CX.leg_to(rig, gq, root, side, ankles[side], pole, foot_q=fq)
    gq, _ = A.lift_feet(rig, gq, root)
    return gq


def relaxed_arms(rig, lq, t, sway=1.0):
    F = len(t)
    for side, s in (('Left', 1), ('Right', -1)):
        CX.add_euler(rig, lq, side + 'Arm', 4 * sway * np.sin(2 * np.pi * t / 2.2), 0, s * -6)
        CX.add_euler(rig, lq, side + 'ForeArm', -12 + 0 * t, 0, 0)
    return lq


def finish(rig, gq):
    lq = rig.local(gq)
    for i in range(lq.shape[1]):
        lq[:, i] = qfix_continuity(lq[:, i])
    return lq


def clip(name, rig, gq, root, loop, speed=0.0, notes='', events=None):
    return CX.to_clip(name, rig, gq, root, loop, speed, False, notes, events)


# ------------------------------------------------------------------------------------------------------------ lying on the bed
def wounded_on_bed(rig, dur=6.0):
    I = rig.I
    F, t = frames(dur)
    lq, root = rig.rest(F)
    roll = 6 * CX.noise(F, 71, 30) + 2.5 * CX.osc(F, 2, 0.3)
    for f in range(F):
        q = CX.lying_q([0, 0.06, -1.0], [0, 1.0, 0.0])
        lq[f, I['Hips']] = qmul(q, qaxis([0, 1.0, 0], np.radians(-8 + roll[f])))
    pose = dict(LowerBack=(4, 0, 0), Spine=(4, 2, 0), Spine1=(3, 2, 0), LeftUpLeg=(-34, -6, 8), LeftLeg=(52, 0, 0), LeftFoot=(-6, 0, 0),
                RightUpLeg=(-10, 8, -6), RightLeg=(14, 0, 0), RightFoot=(18, 0, 0))
    for b, e in pose.items():
        lq[:, I[b]] = qeuler(*e, order='YXZ')[None]
    yaw, hp = CX.look_around(F, [(0, 6, 0), (0.25, 24, 4), (0.45, 4, 10), (0.7, -20, 6), (0.85, -6, 2), (1.0, 6, 0)])
    CX.add_euler(rig, lq, 'Neck', 0.4 * hp + 8, 0.4 * yaw, 0)
    CX.add_euler(rig, lq, 'Head', 0.4 * hp + 3, 0.5 * yaw, -roll * 0.3)
    CX.add_euler(rig, lq, 'LeftUpLeg', -4 * CX.osc(F, 1, 0.5), 0, 3 * CX.osc(F, 1))
    lq = C.breathing(rig, lq, F, 8, 1.8)
    root[:] = [0, 0.15, 0]
    gq = rig.global_from_local(lq)
    root = A.settle_ground(rig, gq, root, vest=0.015, arms=False, legs=False, loop=True)
    gq, _ = A.lift_feet(rig, gq, root, loop=True)
    # hands on the dressing (belly / chest)
    hips_q = gq[:, I['Hips']]
    front = qrot(hips_q, np.broadcast_to([0, 0, 1.0], (F, 3))); up = qrot(hips_q, np.broadcast_to([0, 1.0, 0], (F, 3))); left = np.cross(up, front)
    belly = CX.bone_pt(rig, gq, root, 'Hips', np.array([-0.04, 1.02, 0.15]))
    chest = CX.bone_pt(rig, gq, root, 'Spine1', np.array([0.03, 1.3, 0.14]))
    gp = fk_global(rig.sk, gq, root)
    press = 0.006 * CX.osc(F, 8)
    gq = CX.arm_to(rig, gq, root, 'Right', belly + front * (0.012 + press[:, None]), CX.hand_q(rig, 'Right', left * 0.8 - up * 0.2, -front),
                   gp[:, I['RightArm']] - left * 0.5 + up * 0.1)
    gq = CX.arm_to(rig, gq, root, 'Left', chest + front * 0.03 + left * 0.02, CX.hand_q(rig, 'Left', -left * 0.7 + up * 0.4, -front),
                   gp[:, I['LeftArm']] + left * 0.5 + up * 0.0)
    lq = rig.local(gq)
    rig.finger_curl(lq, 'Right', 30, 40, 12); rig.finger_curl(lq, 'Left', 25, 35, 10)
    gq = rig.global_from_local(lq)
    return clip('wounded_on_bed', rig, gq, root, True,
                notes='casualty lying on his back on the pickup bed (floor y = 0 in the root frame, head towards -Z), knees slightly up, '
                      'right hand on the belly dressing, left on the chest, breathing, slow head turns; the game places the root on a '
                      'stretcher_N empty of pickup.glb (its +Z faces the tailgate)')


# ------------------------------------------------------------------------------------------------------------ fireman's carry
def carry_walk(rig, built):
    """medevac_carry_walk + wounded_carry_walk from walk_rifle's legs"""
    I = rig.I
    w = _cached('walk_rifle', built)
    lq0 = w['lq'].copy(); root = w['root'].copy()
    F = len(lq0); dur = (F - 1) / FPS; t = np.arange(F) / FPS
    sp = float(w['speed']) * 0.78        # loaded: shorter, slower steps (game scales the time by speed)
    # upper body: lean into the load, shoulder dropped under it, head turned away from the casualty
    for b in ('LowerBack', 'Spine', 'Spine1', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand'):
        lq0[:, I[b]] = [0, 0, 0, 1]
    hips_bob = root[:, 1] - root[:, 1].mean()
    CX.add_euler(rig, lq0, 'LowerBack', 7, 0, 3)
    CX.add_euler(rig, lq0, 'Spine', 6, 0, 3)
    CX.add_euler(rig, lq0, 'Spine1', 4, 2, 2)
    CX.add_euler(rig, lq0, 'Neck', -6, 14, -4)
    CX.add_euler(rig, lq0, 'Head', -4, 8, -2)
    CX.add_euler(rig, lq0, 'RightShoulder', 0, 0, 6)
    root[:, 1] -= 0.035
    gq = rig.global_from_local(lq0)
    gq, _ = A.lift_feet(rig, gq, root, loop=True)          # bent knees take the lowered pelvis (no sole under the ground)
    gp = fk_global(rig.sk, gq, root)
    shR = gp[:, I['RightArm']]
    # ---------------- casualty draped over the right shoulder: belly on the shoulder, torso down the back, legs down the front
    head_dir = np.array([-0.06, -0.78, -0.62]); front_dir = np.array([0.0, -0.5, 1.0])     # torso down the medic's back, clear of a backpack
    qh = CX.lying_q(head_dir, front_dir)
    clq, croot = rig.rest(F)
    sway = 3 * np.sin(2 * np.pi * 2 * t / dur)
    for f in range(F):
        clq[f, I['Hips']] = qmul(qaxis([0, 0, 1.0], np.radians(sway[f])), qh)
    cpose = dict(LowerBack=(14, 0, 0), Spine=(14, 0, 0), Spine1=(10, 0, 0), Neck=(18, 0, 0), Head=(14, 10, 0))
    for b, e in cpose.items():
        clq[:, I[b]] = qeuler(*e, order='YXZ')[None]
    CX.add_euler(rig, clq, 'Head', 6 * np.abs(np.sin(2 * np.pi * 2 * t / dur)), 0, 0)
    cgq = rig.global_from_local(clq)
    # pelvis (hips joint) just above and in front of the shoulder
    croot = shR + np.array([-0.01, 0.14, 0.03]) + np.outer(0.01 * np.sin(2 * np.pi * 2 * t / dur), [0, 1, 0])
    cgp = fk_global(rig.sk, cgq, croot)
    # legs hang down the front, knees bent, swinging a little with the steps
    swing = 0.03 * np.sin(2 * np.pi * 2 * t / dur + 0.6)
    for side, sx in (('Left', 1), ('Right', -1)):
        hipj = cgp[:, I[side + 'UpLeg']]
        ank = np.stack([hipj[:, 0] + sx * 0.03, hipj[:, 1] - 0.72, hipj[:, 2] + 0.30 + swing], 1)
        pole = hipj + np.array([0, -0.1, 0.9])
        cgq = CX.leg_to(rig, cgq, croot, side, ank, pole)
    # arms hang down the carrier's back
    cgp = fk_global(rig.sk, cgq, croot)
    for side, sx in (('Left', 1), ('Right', -1)):
        sh = cgp[:, I[side + 'Arm']]
        palm = sh + np.array([sx * 0.04, -0.52, -0.06]) + np.outer(0.03 * np.sin(2 * np.pi * 2 * t / dur + 1.2), [0, 0, 1])
        hq = CX.hand_q(rig, side, np.array([0, -1.0, -0.1]), np.array([-sx * 0.8, 0, 0.4]))
        cgq = CX.arm_to(rig, cgq, croot, side, palm, hq, sh + np.array([sx * 0.4, -0.2, -0.4]))
    clq2 = rig.local(cgq); CX.limp_fingers(rig, clq2, 1.0); cgq = rig.global_from_local(clq2)
    cgp = fk_global(rig.sk, cgq, croot)
    # ---------------- carrier arms: right arm round the casualty's thighs, left hand holds his left wrist / sleeve
    thigh = (cgp[:, I['LeftLeg']] + cgp[:, I['RightLeg']]) / 2 * 0.55 + (cgp[:, I['LeftUpLeg']] + cgp[:, I['RightUpLeg']]) / 2 * 0.45
    palmR = thigh + np.array([0.02, -0.02, 0.08])
    hqR = CX.hand_q(rig, 'Right', np.array([0.9, 0.1, -0.3]), np.array([0, 0, -1.0]))
    gq = CX.arm_to(rig, gq, root, 'Right', palmR, hqR, gp[:, I['RightArm']] + np.array([-0.5, -0.2, 0.2]))
    palmL = np.stack([0.14 + 0 * t, 1.08 + hips_bob * 0.5, 0.26 + 0 * t], 1)
    hqL = CX.hand_q(rig, 'Left', np.array([-0.5, -0.2, 0.8]), np.array([-0.3, -0.9, 0]))
    gq = CX.arm_to(rig, gq, root, 'Left', palmL, hqL, gp[:, I['LeftArm']] + np.array([0.5, -0.3, -0.2]))
    lq = rig.local(gq); rig.finger_curl(lq, 'Right', 70, 80, 30); rig.finger_curl(lq, 'Left', 70, 80, 30)
    gq = rig.global_from_local(lq)
    gq[-1] = gq[0]
    cgq[-1] = cgq[0]
    med = clip('medevac_carry_walk', rig, gq, root, True, sp,
               notes=f"fireman's carry: casualty (wounded_carry_walk, same root and heading) over the right shoulder; legs = walk_rifle (CMU), "
                     f"pelvis lowered 3.5 cm, leaning into the load; right arm round his thighs, left hand on his wrist; {sp:.2f} m/s at time scale 1")
    cas = clip('wounded_carry_walk', rig, cgq, croot, True, 0.0,
               notes='casualty over the medic\'s right shoulder (pairs with medevac_carry_walk: same root, same heading, same phase); belly on '
                     'the shoulder, torso and arms hanging down the medic\'s back, legs down his front')
    return med, cas, dict(lq=rig.local(gq)[0], root=root[0], clq=rig.local(cgq)[0], croot=croot[0], shR=shR[0])


# ------------------------------------------------------------------------------------------------------------ lift
def lift(rig, built, c0):
    """medevac_lift + wounded_lifted: squat beside the casualty (lying in front, head to the left), roll him up onto the right shoulder,
    stand up.  Last frame == medevac_carry_walk / wounded_carry_walk frame 0."""
    I = rig.I
    dur = 2.6
    F, t = frames(dur)
    ay = ankle_y(rig)
    # ---------------- carrier: hips path (stand -> squat -> stand), torso pitch, feet planted
    r_end = c0['root']
    hy = wkey(t, [(0, r_end[1] + 0.03), (0.55, 0.62), (1.35, 0.60), (1.75, 0.66), (2.35, r_end[1]), (dur, r_end[1])])
    hz = wkey(t, [(0, 0.0), (0.55, 0.10), (1.35, 0.06), (2.35, r_end[2]), (dur, r_end[2])])
    root = np.stack([wkey(t, [(0, 0), (dur, r_end[0])]), hy, hz], 1)
    pitch = wkey(t, [(0, 4), (0.55, 38), (1.0, 44), (1.4, 30), (1.8, 26), (2.35, 0), (dur, 0)])
    lqA = pose_track(rig, [(0, {})], t)
    for b, k in (('Hips', 0.45), ('LowerBack', 0.2), ('Spine', 0.2), ('Spine1', 0.15)):
        CX.add_euler(rig, lqA, b, pitch * k, 0, 0)
    CX.add_euler(rig, lqA, 'Neck', -pitch * 0.35, 0, 0)
    # blend the upper body into the carry pose at the end
    lqE = np.repeat(c0['lq'][None], F, 0)
    wE = wkey(t, [(0, 0), (1.35, 0), (2.35, 1), (dur, 1)])
    lq = np.zeros_like(lqA)
    for f in range(F):
        lq[f] = qslerp(lqA[f], lqE[f], wE[f])
    gq = rig.global_from_local(lq)
    ank = {'Left': np.broadcast_to([0.13, ay, 0.06], (F, 3)), 'Right': np.broadcast_to([-0.13, ay, -0.05], (F, 3))}
    # end: the carry walk's frame-0 feet
    gpE = fk_global(rig.sk, rig.global_from_local(c0['lq'][None]), c0['root'][None])
    for side in ('Left', 'Right'):
        e = gpE[0, I[side + 'Foot']]
        wf = wkey(t, [(0, 0), (2.1, 0), (dur, 1)])[:, None]
        ank[side] = ank[side] * (1 - wf) + e[None] * wf
    gq = legs_to(rig, gq, root, ank)
    # ---------------- casualty: lying on his back in front (head to the carrier's left) -> drawn up -> carried
    lz = CARRY['lie_z']
    clqL, crootL = rig.rest(F)
    qL = CX.lying_q([1.0, 0.05, 0.0], [0, 1.0, 0])
    clqL[:, I['Hips']] = qL
    for b, e in dict(LowerBack=(4, 0, 0), Spine=(4, 0, 0), LeftUpLeg=(-20, 0, 6), LeftLeg=(30, 0, 0), RightUpLeg=(-8, 0, -4), RightLeg=(10, 0, 0)).items():
        clqL[:, I[b]] = qeuler(*e, order='YXZ')[None]
    crootL[:] = [0, 0.15, lz]
    cg = rig.global_from_local(clqL)
    crootL = A.settle_ground(rig, cg, crootL, vest=0.015, arms=False, legs=False)
    # sitting-up intermediate (t ~ 1.0): torso raised against the carrier's shoulder
    clqM = clqL.copy()
    qM = CX.lying_q([0.55, 0.75, -0.3], [0.2, 0.3, 1.0])
    clqM[:, I['Hips']] = qM
    for b, e in dict(LowerBack=(10, 0, 0), Spine=(10, 0, 0), Neck=(20, 0, 0), Head=(10, 0, 0), LeftUpLeg=(-70, 0, 6), LeftLeg=(60, 0, 0), RightUpLeg=(-60, 0, -4), RightLeg=(50, 0, 0)).items():
        clqM[:, I[b]] = qeuler(*e, order='YXZ')[None]
    gpC = fk_global(rig.sk, gq, root)
    crootM = gpC[:, I['RightArm']] + np.array([0.05, -0.25, 0.25])
    # carried: the carry pose relative to the (moving) shoulder
    clqC = np.repeat(c0['clq'][None], F, 0)
    crootC = gpC[:, I['RightArm']] + (c0['croot'] - c0['shR'])
    w1 = wkey(t, [(0, 0), (0.55, 0), (1.15, 1), (dur, 1)])
    w2 = wkey(t, [(0, 0), (1.0, 0), (1.6, 1), (dur, 1)])
    clq1, croot1 = blend_pose(clqL, crootL, clqM, crootM, w1)
    clq, croot = blend_pose(clq1, croot1, clqC, crootC, w2)
    cgq = rig.global_from_local(clq)
    clq2 = rig.local(cgq); CX.limp_fingers(rig, clq2, 1.0); cgq = rig.global_from_local(clq2)
    cgp = fk_global(rig.sk, cgq, croot)
    # ---------------- carrier hands: on the casualty's vest / far arm while lifting, then the carry grips
    vest = (cgp[:, I['Spine1']] + cgp[:, I['Spine']]) / 2
    thigh = (cgp[:, I['LeftUpLeg']] + cgp[:, I['RightUpLeg']]) / 2 * 0.45 + (cgp[:, I['LeftLeg']] + cgp[:, I['RightLeg']]) / 2 * 0.55
    gripR_lift = vest + np.array([-0.05, 0.08, 0.0])
    gripL_lift = cgp[:, I['LeftForeArm']] * 0.5 + vest * 0.5 + np.array([0.06, 0.05, 0.0])
    gqE = rig.global_from_local(c0['lq'][None])
    endR = A.fk_global(rig.sk, gqE, c0['root'][None])[0, I['RightHand']]
    endL = A.fk_global(rig.sk, gqE, c0['root'][None])[0, I['LeftHand']]
    gp = fk_global(rig.sk, gq, root)
    wH = wkey(t, [(0, 0), (0.45, 1), (1.6, 1), (2.2, 0), (dur, 0)])
    palmR = (thigh + np.array([0.02, -0.02, 0.08])) * (1 - wH[:, None]) + gripR_lift * wH[:, None]
    palmL = np.stack([0.14 + 0 * t, 1.08 + 0 * t, 0.26 + 0 * t], 1) * (1 - wH[:, None]) + gripL_lift * wH[:, None]
    hqR = CX.hand_q(rig, 'Right', np.array([0.9, 0.1, -0.3]), np.array([0, 0, -1.0]))
    hqL = CX.hand_q(rig, 'Left', np.array([-0.5, -0.2, 0.8]), np.array([-0.3, -0.9, 0]))
    gq = CX.arm_to(rig, gq, root, 'Right', palmR, hqR, gp[:, I['RightArm']] + np.array([-0.5, -0.2, 0.2]))
    gq = CX.arm_to(rig, gq, root, 'Left', palmL, hqL, gp[:, I['LeftArm']] + np.array([0.5, -0.3, -0.2]))
    gq = A.smooth_locals(rig, gq, ('LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'), 2.0)
    lq = rig.local(gq); rig.finger_curl(lq, 'Right', 70, 80, 30); rig.finger_curl(lq, 'Left', 70, 80, 30)
    # exact hand-off to the carry walk on the last frames
    wEnd = wkey(t, [(0, 0), (dur - 0.6, 0), (dur, 1)])
    for f in range(F):
        lq[f] = qslerp(lq[f], c0['lq'], wEnd[f])
    gq = rig.global_from_local(lq)
    gq = A.smooth_locals(rig, gq, ('LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'), 2.5, 1 - wkey(t, [(0, 0), (dur - 0.1, 0), (dur, 1)]))
    gq, _ = A.lift_feet(rig, gq, root)
    med = clip('medevac_lift', rig, gq, root, False,
               notes=f"squats beside a casualty lying {lz} m in front (head to the left), takes him by the vest and arm, rolls him up onto the right "
                     "shoulder, stands up; last frame = medevac_carry_walk frame 0", events={'casualty_root_frame': [0, 0, lz], 'lifted': 1.6})
    cas = clip('wounded_lifted', rig, cgq, croot, False,
               notes=f'pairs with medevac_lift (same root / heading): lying on his back {lz} m in front of the medic, head to the medic\'s left, '
                     'drawn up and over his right shoulder; last frame = wounded_carry_walk frame 0')
    return med, cas


# ------------------------------------------------------------------------------------------------------------ load onto the bed
def load_bed(rig, built, c0, bed):
    I = rig.I
    dur = 2.8
    F, t = frames(dur)
    ay = ankle_y(rig)
    sx, sy, sz = LOAD['slot']
    r0 = c0['root']
    hy = wkey(t, [(0, r0[1]), (0.5, r0[1] - 0.02), (1.1, r0[1] - 0.10), (1.9, r0[1] - 0.12), (2.4, r0[1]), (dur, r0[1] + 0.035)])
    hz = wkey(t, [(0, r0[2]), (0.5, 0.12), (1.1, 0.14), (1.9, 0.18), (2.4, 0.08), (dur, 0.02)])
    root = np.stack([r0[0] + 0 * t, hy, hz], 1)
    pitch = wkey(t, [(0, 0), (0.5, 8), (1.1, 34), (1.9, 46), (2.4, 10), (dur, 2)])
    lqS = np.repeat(c0['lq'][None], F, 0)
    lqB = pose_track(rig, [(0, {})], t)
    for b, k in (('Hips', 0.4), ('LowerBack', 0.22), ('Spine', 0.22), ('Spine1', 0.16)):
        CX.add_euler(rig, lqB, b, pitch * k, 0, 0)
    CX.add_euler(rig, lqB, 'Neck', -pitch * 0.4, 0, 0)
    w = wkey(t, [(0, 0), (0.6, 0.6), (1.0, 1), (dur, 1)])
    lq = np.zeros_like(lqB)
    for f in range(F):
        lq[f] = qslerp(lqS[f], lqB[f], w[f])
    gq = rig.global_from_local(lq)
    gpS = fk_global(rig.sk, rig.global_from_local(c0['lq'][None]), c0['root'][None])[0]
    ank = {}
    for side, x, z1 in (('Left', 0.13, 0.22), ('Right', -0.13, 0.05)):
        z0 = gpS[I[side + 'Foot'], 2]
        ank[side] = np.stack([x + 0 * t, ay + 0 * t, wkey(t, [(0, z0), (0.35 if side == 'Left' else 0.6, z0), (0.55 if side == 'Left' else 0.8, z1), (2.5, z1), (dur, z1 - 0.05)])], 1)
        step = 0.06 * np.clip(np.sin(np.pi * np.clip((t - (0.35 if side == 'Left' else 0.6)) / 0.2, 0, 1)), 0, 1)
        ank[side][:, 1] += step
    gq = legs_to(rig, gq, root, ank)
    gp = fk_global(rig.sk, gq, root)
    # ---------------- casualty: carried (relative to the shoulder) -> on the tailgate -> slid to the slot
    clqC = np.repeat(c0['clq'][None], F, 0)
    crootC = gp[:, I['RightArm']] + (c0['croot'] - c0['shR'])
    blq, broot = bed['lq0'], bed['root0']           # wounded_on_bed frame 0 (its own frame)
    clqE, crootE = turn_pose(np.repeat(blq[None], F, 0), np.repeat(broot[None], F, 0), 180.0, (sx, sy, sz))
    clqT, crootT = turn_pose(np.repeat(blq[None], F, 0), np.repeat(broot[None], F, 0), 180.0, (sx, sy, LOAD['bed_edge'] - 0.15))
    w1 = wkey(t, [(0, 0), (0.5, 0), (1.15, 1), (dur, 1)])
    w2 = wkey(t, [(0, 0), (1.15, 0), (1.95, 1), (dur, 1)])
    clq1, croot1 = blend_pose(clqC, crootC, clqT, crootT, w1)
    clq, croot = blend_pose(clq1, croot1, clqE, crootE, w2)
    lift_ = 0.18 * np.sin(np.pi * np.clip((t - 0.5) / 0.65, 0, 1))      # arc over the tailgate edge
    croot[:, 1] += lift_
    cgq = rig.global_from_local(clq)
    cgp = fk_global(rig.sk, cgq, croot)
    # ---------------- carrier hands: carry grips -> casualty's hips/thighs -> pushing at his knees -> let go
    thigh = (cgp[:, I['LeftUpLeg']] + cgp[:, I['RightUpLeg']]) / 2 * 0.45 + (cgp[:, I['LeftLeg']] + cgp[:, I['RightLeg']]) / 2 * 0.55
    knees = (cgp[:, I['LeftLeg']] + cgp[:, I['RightLeg']]) / 2
    gqE = rig.global_from_local(c0['lq'][None]); gpE = A.fk_global(rig.sk, gqE, c0['root'][None])[0]
    rel = lambda p: p
    pushR = knees + np.array([-0.08, 0.06, -0.06]); pushL = knees + np.array([0.10, 0.06, -0.06])
    wP = wkey(t, [(0, 0), (1.0, 0), (1.3, 1), (2.0, 1), (2.35, 0), (dur, 0)])
    wR = wkey(t, [(0, 0), (2.2, 0), (dur, 1)])
    carryR = thigh + np.array([0.02, -0.02, 0.08]); carryL = np.stack([0.14 + 0 * t, 1.08 + 0 * t, 0.26 + 0 * t], 1)
    restR = gp[:, I['RightArm']] + np.array([-0.06, -0.55, 0.06]); restL = gp[:, I['LeftArm']] + np.array([0.06, -0.55, 0.06])
    palmR = carryR * (1 - wP[:, None]) + pushR * wP[:, None]
    palmL = carryL * (1 - wP[:, None]) + pushL * wP[:, None]
    palmR = palmR * (1 - wR[:, None]) + restR * wR[:, None]; palmL = palmL * (1 - wR[:, None]) + restL * wR[:, None]
    hqR = CX.hand_q(rig, 'Right', np.array([0.3, -0.3, 0.9]), np.array([0, -1.0, 0.1]))
    hqL = CX.hand_q(rig, 'Left', np.array([-0.3, -0.3, 0.9]), np.array([0, -1.0, 0.1]))
    gq = CX.arm_to(rig, gq, root, 'Right', palmR, hqR, gp[:, I['RightArm']] + np.array([-0.5, -0.2, -0.1]))
    gq = CX.arm_to(rig, gq, root, 'Left', palmL, hqL, gp[:, I['LeftArm']] + np.array([0.5, -0.2, -0.1]))
    gq = A.smooth_locals(rig, gq, ('LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'), 3.5)
    lq = rig.local(gq); rig.finger_curl(lq, 'Right', 40, 50, 20); rig.finger_curl(lq, 'Left', 40, 50, 20)
    gq = rig.global_from_local(lq)
    cl = rig.local(cgq); CX.limp_fingers(rig, cl, 1.0); cgq = rig.global_from_local(cl)
    med = clip('medevac_load_bed', rig, gq, root, False,
               notes=f"at the load point behind the open tailgate facing the truck (tailgate tip {LOAD['tail_tip']} m ahead at {LOAD['bed_y']} m, bed edge "
                     f"{LOAD['bed_edge']} m): swings the casualty off the shoulder onto the tailgate and pushes him along the bed to the slot "
                     f"{list(LOAD['slot'])}, straightens up", events={'released': 2.0, 'slot_root_frame': list(LOAD['slot'])})
    cas = clip('wounded_load_bed', rig, cgq, croot, False,
               notes='pairs with medevac_load_bed (same root / heading): from the shoulder onto the tailgate, slid head-first along the bed; '
                     f"last frame = wounded_on_bed frame 0 at {list(LOAD['slot'])} turned 180 deg (head towards the cab)")
    return med, cas


# ------------------------------------------------------------------------------------------------------------ cab exit / enter
def cab_exit(rig, built):
    I = rig.I
    dur = 1.8
    F, t = frames(dur)
    ay = ankle_y(rig)
    idle = _cached('idle_rifle', built)
    r_end = idle['root'][0].copy()
    sx, sy, sz = CAB['seat']
    fl = CAB['floor']
    hipsS = (sx, sy + 0.12, sz)
    keys_root = [(0, hipsS), (0.35, (sx + 0.02, sy + 0.13, sz + 0.07)), (0.75, (0.0, sy + 0.08, -0.36)), (1.1, (0.0, 0.84, -0.12)),
                 (1.45, (0.0, r_end[1] - 0.03, -0.02)), (dur, tuple(r_end))]
    root = np.stack([wkey(t, [(k[0], k[1][i]) for k in keys_root]) for i in range(3)], 1)
    yaw = wkey(t, [(0, 90), (0.3, 70), (0.7, 18), (1.05, 0), (dur, 0)])
    sitk = wkey(t, [(0, 1), (0.6, 1), (1.15, 0.25), (1.5, 0), (dur, 0)])
    duck = wkey(t, [(0, 4), (0.55, 22), (0.95, 30), (1.3, 10), (dur, 0)])
    lq = pose_track(rig, [(0, {})], t)
    for f in range(F):
        lq[f, I['Hips']] = qmul(yaw_q(yaw[f]), qeuler(duck[f] * 0.35 - 6 * sitk[f], 0, 0, order='YXZ'))
    CX.add_euler(rig, lq, 'LowerBack', duck * 0.25 + 6 * sitk, 0, 0)
    CX.add_euler(rig, lq, 'Spine', duck * 0.25, 0, 0)
    CX.add_euler(rig, lq, 'Spine1', duck * 0.15, 0, 0)
    CX.add_euler(rig, lq, 'Neck', -duck * 0.3, wkey(t, [(0, 0), (0.5, -20), (1.0, 0), (dur, 0)]), 0)
    relaxed_arms(rig, lq, t, 0.5)
    gq = rig.global_from_local(lq)
    # feet: on the cab floor in front of the seat (facing the truck's front = +X), right foot out first
    akR = [(0, (sx + 0.42, fl + ay, sz + 0.10)), (0.25, (sx + 0.42, fl + ay, sz + 0.10)), (0.5, (0.14, 0.32, -0.12)), (0.7, (-0.12, ay, 0.08)), (dur - 0.15, (-0.12, ay, 0.08))]
    akL = [(0, (sx + 0.42, fl + ay, sz - 0.10)), (0.65, (sx + 0.38, fl + ay, sz - 0.02)), (0.9, (0.1, fl + ay + 0.05, -0.36)), (1.15, (0.13, 0.25, -0.12)), (1.35, (0.13, ay, 0.04)), (dur, (0.13, ay, 0.04))]
    gpE = fk_global(rig.sk, rig.global_from_local(idle['lq'][:1]), idle['root'][:1])[0]
    eR = gpE[I['RightFoot']]; eL = gpE[I['LeftFoot']]
    akR.append((dur, tuple(eR))); akL[-1] = (dur, tuple(eL))
    ank = {'Right': CX.spline_keys(akR, F, 3), 'Left': CX.spline_keys(akL, F, 3)}
    gq = legs_to(rig, gq, root, ank)
    # last frames: settle exactly into idle_rifle frame 0's legs / spine (the game cross-fades to idle / walk)
    lq = rig.local(gq)
    wEnd = wkey(t, [(0, 0), (dur - 0.3, 0), (dur, 1)])
    li = idle['lq'][0]
    keep = [I[b] for b in ('LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand')]
    for f in range(F):
        q = qslerp(lq[f], li, wEnd[f]); q[keep] = lq[f][keep]; lq[f] = q
    gq = rig.global_from_local(lq)
    lq = rig.local(gq); rig.finger_curl(lq, 'Right', 20, 30, 10); rig.finger_curl(lq, 'Left', 20, 30, 10)
    gq = rig.global_from_local(lq)
    ex = clip('medevac_cab_exit', rig, gq, root, False,
              notes=f"from the pickup's cab seat (hips over the H-point {list(CAB['seat'])} in the END-root frame, facing +X = the truck's front for a "
                    "right-hand door): swivels to the door, right foot down, ducks under the roof, steps out and stands facing away from the truck",
              events={'seat_root_frame': list(CAB['seat']), 'door_open': 0.0, 'door_close': dur})
    # enter = the exit reversed
    gr = gq[::-1].copy(); rr = root[::-1].copy()
    en = clip('medevac_cab_enter', rig, gr, rr, False,
              notes='medevac_cab_exit reversed: from standing at the door (facing away from the truck) back onto the seat facing forward',
              events={'seat_root_frame': list(CAB['seat']), 'door_open': 0.0, 'door_close': dur})
    return ex, en


def medevac_clips(rig, lm, want, built=None):
    out = {}
    built = dict(built or {})
    bed = wounded_on_bed(rig)
    if want('wounded_on_bed'):
        out['wounded_on_bed'] = bed
    need_carry = any(want(n) for n in ('medevac_carry_walk', 'wounded_carry_walk', 'medevac_lift', 'wounded_lifted', 'medevac_load_bed', 'wounded_load_bed'))
    if need_carry:
        med, cas, c0 = carry_walk(rig, built)
        if want('medevac_carry_walk'):
            out['medevac_carry_walk'] = med
        if want('wounded_carry_walk'):
            out['wounded_carry_walk'] = cas
        if want('medevac_lift') or want('wounded_lifted'):
            m, c = lift(rig, built, c0)
            if want('medevac_lift'):
                out['medevac_lift'] = m
            if want('wounded_lifted'):
                out['wounded_lifted'] = c
        if want('medevac_load_bed') or want('wounded_load_bed'):
            b0 = dict(lq0=rig.local(rig.global_from_local(bed['lq'][:1]))[0], root0=bed['root'][0])
            m, c = load_bed(rig, built, c0, b0)
            if want('medevac_load_bed'):
                out['medevac_load_bed'] = m
            if want('wounded_load_bed'):
                out['wounded_load_bed'] = c
    if want('medevac_cab_exit') or want('medevac_cab_enter'):
        ex, en = cab_exit(rig, built)
        if want('medevac_cab_exit'):
            out['medevac_cab_exit'] = ex
        if want('medevac_cab_enter'):
            out['medevac_cab_enter'] = en
    return out
