"""Rebuilt crawls (user feedback: "the crawl animations are awful").

prone_crawl   military low crawl / elbow crawl ("po-plastunski"): body flat on the ground, rifle cradled across the forearms in
              both hands (right hand on the pistol grip = weapon_socket, left hand under the rear of the handguard), contralateral
              cycle: right elbow + left leg drive while the left elbow and the right leg recover, then the mirror.  The driving leg is
              a frog kick: thigh abducted and drawn up along the ground, inner edge of the boot planted (fixed in the world: it slides
              back in the in-place clip at exactly ground_speed) and pushed back until the leg is long; the recovering leg slides
              forward again with the knee out to the side, never lifted into the air.  Elbows plant and pull in small steps, the
              chest rolls / yaws over the planted elbow, the pelvis rolls up on the drawn-leg side, the head stays up looking ahead.
wounded_crawl injured soldier dragging himself on his belly: arms alternately reach forward, plant the palm (fixed in the world)
              and pull; the left leg pushes weakly in a short frog kick, the right leg is dead (dragged, foot rolled out), head up.

Both are seamless in-place loops (horizontal root motion stripped, the planted contacts slide back at ground_speed_mps, i.e. they
stay still in the world when the game moves the root at that speed)."""
import numpy as np
import anim as A
import clips as C
from anim import FPS, fk_global, smooth
from qmath import qmul, qinv, qrot, qaxis, qeuler, qslerp, qfrom_mat, qfix_continuity
from clips_extra import add_euler, hand_q, arm_to, leg_to, to_clip, noise

Y = np.array([0, 1.0, 0])
ANKLE_SIDE = 0.060           # ankle joint height when the boot lies on its inner edge


def foot_q(toe, sole):
    """global foot rotation: bind foot frame (toes +Z, sole -Y) -> toe direction / sole normal (world)"""
    z = np.asarray(toe, float); z = z / np.linalg.norm(z)
    s = np.asarray(sole, float); s = s - z * (s @ z); s /= np.linalg.norm(s)
    y = -s; x = np.cross(y, z)
    return qfrom_mat(np.stack([x, y, z], 1))


def knee_on_ground(hip, ank, L1, L2, yk, side_sign):
    """knee point on the hip-ankle circle at height yk (most lateral solution; nearest reachable height otherwise)"""
    d = ank - hip; D = np.linalg.norm(d); dn = d / D
    D = np.clip(D, abs(L1 - L2) + 1e-4, (L1 + L2) * 0.999)
    a = (L1 ** 2 - L2 ** 2 + D ** 2) / (2 * D); rho = np.sqrt(max(L1 ** 2 - a ** 2, 1e-8))
    c = hip + dn * a
    u = np.cross(dn, Y); u = u / max(np.linalg.norm(u), 1e-9)
    if u[0] * side_sign < 0:
        u = -u
    v = np.cross(dn, u)
    # K(th) = c + rho (cos th u + sin th v);  K_y = c_y + rho (cos th u_y + sin th v_y) = yk
    A_, B_ = rho * u[1], rho * v[1]
    R_ = np.hypot(A_, B_)
    rhs = (yk - c[1])
    if R_ < 1e-9:
        th = 0.0
    else:
        phi = np.arctan2(B_, A_)
        k = np.clip(rhs / R_, -1, 1)
        cands = [phi + np.arccos(k), phi - np.arccos(k)]
        th = max(cands, key=lambda t_: (np.cos(t_) * u + np.sin(t_) * v)[0] * side_sign)
    return c + rho * (np.cos(th) * u + np.sin(th) * v)


def lying_base(rig, F, hip_pitch=88.0):
    I = rig.I
    lq, root = rig.rest(F)
    lq[:, I['Hips']] = qeuler(hip_pitch, 0, 0, order='YXZ')
    for b, e in (('LowerBack', (-4, 0, 0)), ('Spine', (-7, 0, 0)), ('Spine1', (-9, 0, 0)), ('Neck', (-30, 0, 0)), ('Head', (-16, 0, 0))):
        lq[:, I[b]] = qeuler(*e, order='YXZ')
    root[:] = [0.0, 0.13, 0.0]
    return lq, root


def settle(rig, gq, root, target=0.004, loop=True):
    """vertical root offset so the lowest bare-torso point sits at `target` (smoothed, loop-aware)"""
    low = A.torso_low(rig, gq, root)
    off = target - low
    F = len(off)
    k = np.exp(-0.5 * (np.arange(-4, 5) / 2.0) ** 2); k /= k.sum()
    pad = np.concatenate([off[-5:-1], off, off[1:5]]) if loop else np.concatenate([np.repeat(off[:1], 4), off, np.repeat(off[-1:], 4)])
    sm = np.convolve(pad, k, 'valid')
    root = root.copy(); root[:, 1] += sm
    return root


def leg_cycle(rig, gq, root, side, u0, speed, T, push=0.5, x_plant=0.30, z_drawn=-0.50, z_long=None, lift=0.0, dead=False):
    """frog-kick leg on the ground. u0: phase at which this leg starts its push (drawn up).  Push window = `push` of the cycle:
    the planted ankle is fixed in the world (moves back at `speed` in clip space).  Returns ankle targets, knee poles, foot rot."""
    I = rig.I; sk = rig.sk
    F = len(gq); t = np.arange(F) / FPS
    sx = 1 if side == 'Left' else -1
    gp = fk_global(sk, gq, root)
    hip = gp[:, I[side + 'UpLeg']]
    L1 = np.linalg.norm(sk.head[I[side + 'Leg']] - sk.head[I[side + 'UpLeg']])
    L2 = np.linalg.norm(sk.head[I[side + 'Foot']] - sk.head[I[side + 'Leg']])
    stride = speed * T * push
    z_long = z_drawn - stride if z_long is None else z_long
    ank = np.zeros((F, 3)); knee = np.zeros((F, 3)); fq = np.zeros((F, 4)); planted = np.zeros(F, bool)
    hip_mean = hip.mean(0)
    for f in range(F):
        u = ((t[f] / T) - u0) % 1.0
        if u < push:                     # planted: world-fixed, slides back in clip space
            w = u / push
            z = hip_mean[2] + z_drawn - stride * w
            y = ANKLE_SIDE
            planted[f] = True
        else:                            # recovery: slides forward on the ground, knee out
            w = smooth((u - push) / (1 - push))
            z = hip_mean[2] + z_long + (z_drawn - z_long) * w
            y = ANKLE_SIDE + lift * np.sin(np.pi * w)
        ank[f] = [hip_mean[0] * 0 + sx * x_plant, y, z]
    for f in range(F):
        knee[f] = knee_on_ground(hip[f], ank[f], L1, L2, 0.072, sx)
        sh = knee[f] - ank[f]; sh /= np.linalg.norm(sh)
        # boot on its inner edge: toes back / out, sole facing the midline and back
        toe = np.array([sx * 0.55, -0.25, -1.0]) - sh * 0.3
        sole = np.array([-sx * 1.0, -0.15, -0.45])
        if dead:
            toe = np.array([sx * 0.25, -0.35, -1.0]); sole = np.array([-sx * 0.9, 0.35, -0.2])
        fq[f] = foot_q(toe, sole)
    return ank, knee, fq, planted


def ground_feet(rig, gq, root, sides=('Left', 'Right'), floor=0.004):
    """raise / lower each ankle (leg IK, foot rotation kept) so its lowest sole point touches the floor"""
    sk = rig.sk; I = rig.I
    for side in sides:
        for _ in range(2):
            low = A.sole_low(rig, gq, root, side)
            gp = fk_global(sk, gq, root)
            ank = gp[:, I[side + 'Foot']] + np.outer(floor - low, Y)
            gq = leg_to(rig, gq, root, side, ank, gp[:, I[side + 'Leg']] + (gp[:, I[side + 'Leg']] - (gp[:, I[side + 'UpLeg']] + ank) / 2) * 2,
                        foot_q=gq[:, I[side + 'Foot']].copy())
    return gq


# ====================================================================================== prone_crawl
def prone_crawl(rig, lm, relq=None, relp=None, T=1.4, speed=0.45):
    """po-plastunski: the rifle lies on the right forearm, right hand on the pistol grip (weapon_socket), the left hand is free and
    pulls palm-down; both elbows plant (world-fixed while pulling) and step alternately with the opposite leg's frog kick"""
    I = rig.I; sk = rig.sk
    F = int(round(T * FPS)) + 1
    t = np.arange(F) / FPS
    ph = 2 * np.pi * t / T
    c, s = np.cos(ph), np.sin(ph)
    lq, root = lying_base(rig, F)
    # contralateral cycle: u = 0 left knee drawn + right elbow forward (both start driving), u = 0.5 the mirror
    add_euler(rig, lq, 'Hips', 0, -5 * c, 7 * c)                  # pelvis rolls up / yaws forward on the drawn-leg side
    add_euler(rig, lq, 'LowerBack', 0, 2.5 * c, -2.5 * c)
    add_euler(rig, lq, 'Spine', 0, 3.0 * c, -3.0 * c)
    add_euler(rig, lq, 'Spine1', 0, 4.5 * c, 3.0 * c)             # chest: right shoulder forward while the right elbow reaches
    add_euler(rig, lq, 'Neck', 1.5 * np.abs(s), -4.0 * c, -2.5 * c)
    add_euler(rig, lq, 'Head', 0, -3.0 * c, -1.5 * c)
    root[:, 0] += 0.018 * c
    root[:, 2] += 0.012 * np.sin(2 * ph)                         # small surge with each push
    gq = rig.global_from_local(lq)
    root = settle(rig, gq, root, 0.006)
    # ---- the chest rises / rolls over the pulling elbow: per frame, spine pitch + roll so the pulling side's shoulder sits exactly
    #      one upper-arm length above its planted (world-fixed) elbow spot -> the elbow does not slide while the body passes over it
    L1 = rig.L1['Right']; YE = 0.046; stride = speed * T * 0.5
    gp = fk_global(sk, rig.global_from_local(lq), root)
    Sm = {sd: gp[:, I[sd + 'Arm']].mean(0) for sd in ('Left', 'Right')}

    def elbow_spot(side, f):
        sx = 1 if side == 'Left' else -1
        u = ((t[f] / T) - (0.0 if side == 'Right' else 0.5)) % 1.0
        z_front = Sm[side][2] + 0.155
        z = z_front - stride * (u / 0.5) if u < 0.5 else z_front - stride + stride * smooth((u - 0.5) / 0.5)
        return np.array([Sm[side][0] + sx * 0.075, YE, z]), u < 0.5
    bones = (('LowerBack', 0.3), ('Spine', 0.35), ('Spine1', 0.35))
    for f in range(F):
        side = 'Right' if (t[f] / T) % 1.0 < 0.5 else 'Left'
        sx = 1 if side == 'Left' else -1
        Es, _ = elbow_spot(side, f)
        base = lq[f:f + 1].copy()

        def apply(x):
            l = base.copy()
            for b, w in bones:
                l[0, I[b]] = qmul(l[0, I[b]], qeuler(-x[0] * w, 0, x[1] * w, order='YXZ'))
            return l

        def resid(x):
            l = apply(x)
            g = rig.global_from_local(l)
            S = fk_global(sk, g, root[f:f + 1])[0, I[side + 'Arm']]
            d = np.hypot(S[0] - Es[0], S[2] - Es[2])
            req = YE + np.sqrt(max(L1 ** 2 - min(d, L1 * 0.98) ** 2, 0))
            return np.array([S[1] - req, 0.004 * x[0], 0.004 * x[1]])
        x = np.zeros(2)
        for _ in range(6):
            r0 = resid(x); J = np.zeros((3, 2))
            for k in range(2):
                dx = np.zeros(2); dx[k] = 0.5
                J[:, k] = (resid(x + dx) - r0) / 0.5
            x = np.clip(x - np.linalg.lstsq(J, r0, rcond=None)[0], [-6, -14], [16, 14])
        lq[f] = apply(x)[0]
    # smooth the solved spine (it switches sides at u = 0 / 0.5)
    gq = A.smooth_locals(rig, rig.global_from_local(lq), ('LowerBack', 'Spine', 'Spine1'), 1.6, loop=True)
    lq = rig.local(gq)
    root = settle(rig, gq, root, 0.006)
    gq = rig.global_from_local(lq)
    # ---- legs
    legs = {}
    for side, u0 in (('Left', 0.0), ('Right', 0.5)):
        legs[side] = leg_cycle(rig, gq, root, side, u0, speed, T, push=0.5, x_plant=0.31, z_drawn=-0.47, lift=0.0)
    for side in legs:
        ank, knee, fq, _ = legs[side]
        gq = leg_to(rig, gq, root, side, ank, knee, foot_q=fq)
    gq = ground_feet(rig, gq, root)
    # ---- arms: elbow ground points (planted = world-fixed while pulling), forearms flat, rifle along the right forearm
    gp = fk_global(sk, gq, root)
    L2 = rig.L2['Right']
    H = rig.hand['Right']; HLh = rig.hand['Left']
    arm_t = {}
    for side, sx, u0 in (('Right', -1, 0.0), ('Left', 1, 0.5)):
        u = ((t / T) - u0) % 1.0
        S = gp[:, I[side + 'Arm']]
        z_front = Sm[side][2] + 0.155
        pull = u < 0.5
        ez = np.where(pull, z_front - stride * (u / 0.5), z_front - stride + stride * smooth((u - 0.5) / 0.5))
        ex = np.full(F, Sm[side][0] + sx * 0.075)
        lift = np.where(pull, 0.0, 0.045 * np.sin(np.pi * (u - 0.5) / 0.5))
        E = np.zeros((F, 3))
        for f in range(F):
            d = np.array([ex[f] - S[f, 0], ez[f] - S[f, 2]])
            dxz = np.linalg.norm(d)
            ye = S[f, 1] - np.sqrt(max(L1 ** 2 - dxz ** 2, 0.0)) + lift[f]
            if ye < YE + lift[f]:           # shoulder too low for that spot: slide the elbow out radially, keep it on the ground
                ye = YE + lift[f]
                r = np.sqrt(max(L1 ** 2 - (S[f, 1] - ye) ** 2, 1e-6))
                d = d / max(dxz, 1e-6) * r
            elif dxz > L1 * 0.999:
                d = d / dxz * L1 * 0.999; ye = S[f, 1]
            E[f] = [S[f, 0] + d[0], ye, S[f, 2] + d[1]]
        # forearm: flat, pointing forward and in toward the midline; wrist slightly raised
        inward = np.radians(24 if side == 'Right' else 30)
        fdir = np.stack([np.full(F, -sx * np.sin(inward)), np.full(F, 0.10), np.full(F, np.cos(inward))], 1)
        fdir[:, 1] += np.where(pull, 0.0, 0.10 * np.sin(np.pi * (u - 0.5) / 0.5))
        fdir /= np.linalg.norm(fdir, axis=1, keepdims=True)
        Wr = E + fdir * L2
        pole = E + (E - (S + Wr) / 2) * 1.5          # exactly on the elbow's side of the shoulder-wrist axis
        arm_t[side] = (E, Wr, fdir, u, pull, pole)
    # right hand: rifle along the forearm, lying on its left side (palm down on the pistol grip, magazine pointing out to the right)
    E, Wr, fdir, uR, pullR, poleR = arm_t['Right']
    gun_q = np.zeros((F, 4)); hqR = np.zeros((F, 4))
    for f in range(F):
        zf = fdir[f] * [1, 0, 1]; zf /= np.linalg.norm(zf)
        yaw = np.radians(6)        # the rifle points a little further in than the forearm
        Zg = np.array([zf[0] * np.cos(yaw) + zf[2] * np.sin(yaw), -0.06, -zf[0] * np.sin(yaw) + zf[2] * np.cos(yaw)]); Zg /= np.linalg.norm(Zg)
        Xg = np.array([0.0, -1.0, 0.0]); Xg = Xg - Zg * (Xg @ Zg); Xg /= np.linalg.norm(Xg)
        Xg = (Xg * np.cos(np.radians(25)) + np.cross(Zg, Xg) * np.sin(np.radians(25)))     # rolled back 25 deg: magazine forward-right-down
        Yg = np.cross(Zg, Xg)
        gun_q[f] = qfrom_mat(np.stack([Xg, Yg, Zg], 1))
        hqR[f] = qmul(gun_q[f], qinv(rig.sock_q))
    palmR = Wr + qrot(hqR, np.broadcast_to(H['palm'] - H['wrist'], (F, 3)))
    gq = arm_to(rig, gq, root, 'Right', palmR, hqR, poleR, twist=0.6)
    # left hand: palm down on the ground in front of the left forearm, fingers forward / in
    E, Wl, fdir, uL, pullL, poleL = arm_t['Left']
    hqL = hand_q(rig, 'Left', fdir * [1, 0, 1] + [0, -0.15, 0], np.array([0, -1.0, 0]))
    palmL = Wl + qrot(hqL, np.broadcast_to(HLh['palm'] - HLh['wrist'], (F, 3)))
    gq = arm_to(rig, gq, root, 'Left', palmL, hqL, poleL, twist=0.6)
    lq = rig.local(gq)
    rig.finger_curl(lq, 'Right', 58, 72, 22)
    lqa = lq.copy(); rig.finger_curl(lqa, 'Left', 28, 35, 10)
    lqb = lq.copy(); rig.finger_curl(lqb, 'Left', 12, 15, 4)
    reach = np.where(pullL, 0.0, np.sin(np.pi * (uL - 0.5) / 0.5))
    for b in ('LeftFingerBase', 'LeftHandFinger1', 'LThumb'):
        i = I[b]
        lq[:, i] = np.array([qslerp(lqa[f, i], lqb[f, i], reach[f]) for f in range(F)])
    gq = rig.global_from_local(lq)
    # rifle clear of the ground (lift the forearm-carried rifle by raising the right wrist if a low point would dig in)
    gpos = fk_global(sk, gq, root)
    gq_r = gq[:, I['RightHand']]; sock = rig.sock_q
    gqw = qmul(gq_r, np.broadcast_to(sock, (F, 4)))
    gpw = gpos[:, I['RightHand']] + qrot(gq_r, np.broadcast_to(rig.sock_t, (F, 3)))
    import build_anims as BA
    lowp = np.stack([gpw + qrot(gqw, np.broadcast_to(p_, (F, 3))) for p_ in BA.GUN_LOW_PTS], 1)[..., 1].min(1)
    need = A._grow_smooth(np.maximum(0.010 - lowp, 0), 2, loop=True)
    if need.max() > 0.001:
        palmR2 = palmR + np.outer(need, Y)
        gq = arm_to(rig, gq, root, 'Right', palmR2, hqR, poleR, twist=0.6)
        lq = rig.local(gq); rig.finger_curl(lq, 'Right', 58, 72, 22); gq = rig.global_from_local(lq)
    gq[-1] = gq[0]
    return to_clip('prone_crawl', rig, gq, root, True, speed,
                   notes=f'military low crawl ("po-plastunski"): body flat on the ground (bare torso ~0.6 cm above it), rifle lying on the right forearm '
                         f'(right hand on the pistol grip = weapon_socket, left hand free), contralateral {T:.2f} s cycle: right elbow + left leg drive '
                         f'(0-{T / 2:.2f} s) while the left elbow reaches and the right leg is drawn up, then the mirror; frog-kick legs (thigh drawn up along '
                         f'the ground, inner edge of the boot planted and pushed back until the leg is long, the recovering leg slides forward with the knee '
                         f'out - feet never lifted), elbows plant and pull, left palm planted, chest and pelvis roll over the planted side, head up; planted '
                         f'boots / elbows slide back at exactly {speed:.2f} m/s in the in-place clip (still in the world at that ground speed)',
                   events={'left_push': [0.0, T / 2], 'right_push': [T / 2, T], 'weapon': 'weapon_socket (right hand), the left hand is free'})


def _arms_clear(rig, gq, root, gun_q, gun_p, poles, clear=0.035):
    I = rig.I
    gp = fk_global(rig.sk, gq, root)
    j = [I[b] for b in ('LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand')]
    rad = np.array([0.04, 0.04, 0.025, 0.025])
    pen = np.max(rad[None] - gp[:, j, 1], axis=1)
    if pen.max() <= 0.001:
        return gq, root
    import clips_combat as CC
    lift = A._grow_smooth(np.maximum(pen, 0), 2, loop=True)
    root = root.copy(); root[:, 1] += lift
    gun_p = gun_p + np.outer(lift, Y)
    gq0 = gq
    gq2, _ = CC.prone_overlay(rig, gq, root, gun_q, gun_p, poles['Right'] + np.outer(lift, Y), poles['Left'] + np.outer(lift, Y))
    return gq2, root


# ====================================================================================== wounded_crawl
def wounded_crawl(rig, T=2.0, speed=0.24):
    """belly drag: palms reach & plant (fixed in the world) and pull alternately, left leg short frog push, right leg dead"""
    I = rig.I
    F = int(round(T * FPS)) + 1
    t = np.arange(F) / FPS
    ph = 2 * np.pi * t / T
    c, s = np.cos(ph), np.sin(ph)
    lq, root = lying_base(rig, F, hip_pitch=86.0)
    for b, e in (('LowerBack', (-6, 0, 0)), ('Spine', (-10, 0, 0)), ('Spine1', (-12, 0, 0)), ('Neck', (-34, 0, 0)), ('Head', (-14, 0, 0))):
        lq[:, I[b]] = qeuler(*e, order='YXZ')
    # arms: right palm planted 0..0.5 (pulling), left 0.5..1; chest rolls / yaws toward the pulling arm; effortful head bob
    add_euler(rig, lq, 'Hips', 0, 4 * c, -4 + 3 * c)
    add_euler(rig, lq, 'LowerBack', 0, -3 * c, -2 * c)
    add_euler(rig, lq, 'Spine', 0, -4 * c, -3 * c)
    add_euler(rig, lq, 'Spine1', 2 * np.abs(s), -6 * c, -5 * c)
    add_euler(rig, lq, 'Neck', -4 * np.abs(s), 4 * c, 0)
    add_euler(rig, lq, 'Head', -3 * np.abs(s), 3 * c, 2 * c)
    root[:, 0] += 0.022 * c
    root[:, 2] += 0.02 * np.sin(2 * ph - 0.6)                    # the body surges on each pull
    gq = rig.global_from_local(lq)
    root = settle(rig, gq, root, 0.008)
    gq = rig.global_from_local(lq)
    # legs: left short weak frog push in phase with the right-arm pull, right leg dead and dragged (rolled out)
    ankL, kneeL, fqL, _ = leg_cycle(rig, gq, root, 'Left', 0.0, speed, T, push=0.5, x_plant=0.30, z_drawn=-0.60, lift=0.0)
    gq = leg_to(rig, gq, root, 'Left', ankL, kneeL, foot_q=fqL)
    gp = fk_global(rig.sk, gq, root)
    hipR = gp[:, I['RightUpLeg']]
    ankR = hipR + np.array([-0.16, 0, -0.84]); ankR[:, 1] = 0.085 + 0.006 * s
    sk = rig.sk
    L1r = np.linalg.norm(sk.head[I['RightLeg']] - sk.head[I['RightUpLeg']]); L2r = np.linalg.norm(sk.head[I['RightFoot']] - sk.head[I['RightLeg']])
    kneeR = np.array([knee_on_ground(hipR[f], ankR[f], L1r, L2r, 0.058, -1) for f in range(F)])
    gq = leg_to(rig, gq, root, 'Right', ankR, kneeR, foot_q=foot_q([-0.35, -0.2, -1.0], [0.85, 0.45, -0.25]))
    gq = ground_feet(rig, gq, root)
    # arms: palm targets on the ground, world-fixed while planted
    gp = fk_global(rig.sk, gq, root)
    stride = speed * T * 0.5
    arms = {}
    for side, sx, u0 in (('Right', -1, 0.0), ('Left', 1, 0.5)):
        u = ((t / T) - u0) % 1.0
        sh = gp[:, I[side + 'Arm']]
        shm = sh.mean(0)
        z_front = shm[2] + 0.36
        z = np.where(u < 0.5, z_front - stride * (u / 0.5), z_front - stride + stride * smooth((u - 0.5) / 0.5))
        y = 0.022 + np.where(u < 0.5, 0.0, 0.10 * np.sin(np.pi * (u - 0.5) / 0.5))
        x = np.full(F, sx * 0.24)
        palm = np.stack([x, y, z], 1)
        reach = np.where(u < 0.5, 0.0, np.sin(np.pi * (u - 0.5) / 0.5))
        hq_plant = hand_q(rig, side, np.array([-sx * 0.35, 0.0, 1.0]), np.array([0, -1.0, 0]))
        hq_air = hand_q(rig, side, np.array([-sx * 0.2, -0.35, 1.0]), np.array([-sx * 0.3, -0.9, 0.1]))
        hq = np.array([qslerp(hq_plant, hq_air, reach[f]) for f in range(F)])
        pole = sh + np.array([sx * 0.55, 0.15, -0.05])
        gq = arm_to(rig, gq, root, side, palm, hq, pole)
        arms[side] = reach
    lq = rig.local(gq)
    for side in ('Left', 'Right'):
        lqa = lq.copy(); rig.finger_curl(lqa, side, 30, 40, 12)
        lqb = lq.copy(); rig.finger_curl(lqb, side, 10, 15, 4)
        for b in (side + 'FingerBase', side + 'HandFinger1', 'LThumb' if side == 'Left' else 'RThumb'):
            i = I[b]; r = arms[side]
            lq[:, i] = np.array([qslerp(lqa[f, i], lqb[f, i], r[f]) for f in range(F)])
    gq = rig.global_from_local(lq)
    return to_clip('wounded_crawl', rig, gq, root, True, speed,
                   notes=f'wounded belly drag, {T:.1f} s loop: arms alternately reach forward, plant the palm (fixed in the world) and pull the body '
                         f'(right 0-{T / 2:.1f} s, left {T / 2:.1f}-{T:.1f} s), chest rolls toward the pulling arm, effortful head bob; left leg pushes in a short '
                         f'frog kick, right leg dead (dragged, boot rolled out); no weapon (sling it: weapon_socket_back, or drop); planted palms / boot slide back '
                         f'at exactly {speed:.2f} m/s in the in-place clip',
                   events={'right_pull': [0.0, T / 2], 'left_pull': [T / 2, T]})


def _e(err):
    return {k: round(float(v), 4) for k, v in err.items()}
