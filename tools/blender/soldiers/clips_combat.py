"""Combat clips v2: per-shot recoil cycles (stand / crouch / prone / corner peeks), corner peeks, cover duck,
pinned prone, launcher raise + reworked launcher shots, reworked reloads, locomotion post-processing.
Conventions (see anim.py / clips_extra.py): joint frames world-aligned in bind pose; local euler (deg, order YXZ):
  +X = pitch forward, hip flexion = -X on *UpLeg, knee flexion = +X on *Leg, +Y = yaw to the character's left,
  +Z = roll / lean to the character's right.  Model: +X = character's left, +Y up, +Z forward."""
import numpy as np
from scipy.optimize import minimize
import anim as A
import clips as C
from anim import FPS, fk_global, smooth
from qmath import qmul, qinv, qrot, qaxis, qeuler, qslerp, qfrom_mat, qlook, qfix_continuity
from clips_extra import (add_euler, noise, osc, hand_q, arm_to, leg_to, to_clip, ground_clamp, spline_keys, solve_launcher,
                         launcher_hands, LAUNCHER, bone_pt, lag)

Y = np.array([0, 1.0, 0])
ZW = np.array([0, 0, 1.0])
POLE_R = np.array([-0.5, -0.35, -0.2])
POLE_L = np.array([0.15, -0.8, 0.1])
# one shot: muzzle report at t = 0 (gun still at rest), peak kick one frame later, recovered after 4 frames (0.133 s)
KICK = np.array([0.0, 1.0, 0.56, 0.2, 0.0])
KICK_HEAD = np.array([0.0, 0.5, 0.85, 0.35, 0.0])   # the cheek follows the stock a frame late
SHOT_DUR = (len(KICK) - 1) / FPS


def ik_err(err):
    return {k: round(v, 4) for k, v in err.items()}


def roll_world(rig, lq, bone, ang, axis=ZW):
    """rotate `bone` (per frame, degrees) about a WORLD axis at its current pose; children carried along"""
    F = lq.shape[0]
    ang = np.broadcast_to(np.asarray(ang, float), F)
    gq = rig.global_from_local(lq)
    p = rig.sk.parent[rig.I[bone]]
    if p < 0:
        lq[:, rig.I[bone]] = qmul(qaxis(axis, np.radians(ang)), lq[:, rig.I[bone]])
        return lq
    ax = qrot(qinv(gq[:, p]), np.broadcast_to(axis, (F, 3)))
    lq[:, rig.I[bone]] = qmul(np.array([qaxis(ax[f], np.radians(ang[f])) for f in range(F)]), lq[:, rig.I[bone]])
    return lq


def solve_aim_cant(rig, lm, lq, root, cant=0.0, aim_dir=np.array([0, 0, 1.0]), pocket=np.array([-0.10, 1.445, 0.135]), yaw_in=1.5,
                   head=(8, -4, -10), neck=(5, 0, 0), roll=(-14, 14)):
    """clips.solve_aim with a canted rifle (cant deg about the bore, + = top of the rifle to the character's right)"""
    gun = A.GUN['ak74m']
    sk = rig.sk
    d = aim_dir / np.linalg.norm(aim_dir)
    gun_q = qmul(qmul(qaxis(Y, np.arctan2(d[0], d[2]) + np.radians(yaw_in)), qaxis([1, 0, 0], -np.arcsin(np.clip(d[1], -1, 1)))),
                 qaxis(ZW, np.radians(cant)))
    eye_g = np.array([0, gun['sight'][1] + 0.022, gun['sight'][2] - 0.355])
    eL = C.eye_local(rig, lm)
    base = lq.copy()
    base[0, rig.I['Neck']] = qmul(base[0, rig.I['Neck']], qeuler(*neck, order='YXZ'))
    base[0, rig.I['Head']] = qmul(base[0, rig.I['Head']], qeuler(*head, order='YXZ'))

    def apply(x):
        l = base.copy()
        for b in ('Spine', 'Spine1'):
            l[0, rig.I[b]] = qmul(base[0, rig.I[b]], qeuler(x[0] * 0.5, x[1] * 0.5, x[2] * 0.5, order='YXZ'))
        l[0, rig.I['RightShoulder']] = qmul(base[0, rig.I['RightShoulder']], qeuler(0, x[3], x[4], order='YXZ'))
        l[0, rig.I['Head']] = qmul(l[0, rig.I['Head']], qeuler(x[5], 0, x[7], order='YXZ'))
        l[0, rig.I['Neck']] = qmul(l[0, rig.I['Neck']], qeuler(x[6] * 0.5, 0, x[8] * 0.5, order='YXZ'))
        l[0, rig.I['Neck1']] = qmul(l[0, rig.I['Neck1']], qeuler(x[6] * 0.5, 0, x[8] * 0.5, order='YXZ'))
        return l

    def evalx(x):
        l = apply(x)
        g = rig.global_from_local(l)
        p = fk_global(sk, g, root)
        eye = p[0, rig.I['Head']] + qrot(g[0, rig.I['Head']], eL)
        gun_p = eye - qrot(gun_q, eye_g)
        butt = gun_p + qrot(gun_q, gun['butt'] + [0, 0.015, 0])
        ic = rig.I['RightShoulder']
        pk = p[0, ic] + qrot(g[0, ic], pocket - sk.head[ic])
        return l, gun_p, butt, pk

    def cost(x):
        _, _, butt, pk = evalx(x)
        return 1e4 * np.sum((butt - pk) ** 2) + 0.002 * np.sum(np.asarray(x) ** 2)
    # + neck lateral flexion (x8) and wider spine / clavicle / neck ranges (the old bounds left the butt 2.6-7.8 cm off the pocket)
    bounds = [(-6, 18), (-24, 24), roll, (-22, 22), (-12, 26), (-10, 14), (0, 26), (-18, 18), (-10, 28)]
    res = C.solve_bounded(cost, bounds)
    l, gun_p, butt, pk = evalx(res.x)
    print('aim(cant) solve', np.round(res.x, 1), 'butt err %.3f' % np.linalg.norm(butt - pk))
    return l, gun_q, gun_p, float(np.linalg.norm(butt - pk))


def _rel(rig, lq_aim, root1, gun_q, gun_p):
    cq0, cp0 = A.chest_frame(rig.sk, rig.global_from_local(lq_aim), root1)
    return qmul(qinv(cq0[0]), gun_q), qrot(qinv(cq0[0]), gun_p - cp0[0])


def arm_poles(rig, gq, root, pR, pL, rot=None):
    gp = fk_global(rig.sk, gq, root)
    F = len(gq)
    if rot is not None:
        pR = qrot(np.broadcast_to(rot, (F, 4)), np.broadcast_to(pR, (F, 3))); pL = qrot(np.broadcast_to(rot, (F, 4)), np.broadcast_to(pL, (F, 3)))
    return gp[:, rig.I['RightArm']] + pR, gp[:, rig.I['LeftArm']] + pL


# ------------------------------------------------------------------ aim bases (identical maths to the aim_* clips of build_anims)
def base_stand(rig, lm, stance_fn, plant_feet):
    gq1, root1, feet = stance_fn(rig, 1, drop=0.035, hip_yaw=-28, spine=(4, 8, 6, 9), lfoot=(0.14, 0.14), rfoot=(-0.12, -0.12), lyaw=-18, ryaw=-40, head=(0, 6))
    gq1 = plant_feet(rig, gq1, root1, feet)
    lq_aim, gun_q, gun_p, eerr = C.solve_aim(rig, lm, rig.local(gq1), root1)
    relq, relp = _rel(rig, lq_aim, root1, gun_q, gun_p)
    return dict(kind='stand', lq=lq_aim, root=root1, legs=lambda g, r: plant_feet(rig, g, r, feet), relq=relq, relp=relp,
                pR=POLE_R, pL=POLE_L, prot=None, err=eerr, feet=feet)


def base_crouch(rig, lm, kneel, kneel_legs):
    kq, kr, kfeet = kneel(rig, 1)
    lq1 = rig.local(kq)
    lq1[0, rig.I['Hips']] = qmul(lq1[0, rig.I['Hips']], qeuler(0, -10, 0, order='YXZ'))
    lq_aim, gun_q, gun_p, eerr = C.solve_aim(rig, lm, lq1, kr)
    relq, relp = _rel(rig, lq_aim, kr, gun_q, gun_p)
    return dict(kind='crouch', lq=lq_aim, root=kr, legs=lambda g, r: kneel_legs(rig, g, r, kfeet), relq=relq, relp=relp,
                pR=POLE_R, pL=POLE_L, prot=None, err=eerr, kfeet=kfeet)


def base_prone(rig, lm, prone_fn):
    pq, pr = prone_fn(rig)
    lq_aim, gun_q, gun_p, eerr = C.solve_aim(rig, lm, rig.local(pq), pr, pocket=np.array([-0.10, 1.43, 0.13]))
    relq, relp = _rel(rig, lq_aim, pr, gun_q, gun_p)
    return dict(kind='prone', lq=lq_aim, root=pr, legs=None, relq=relq, relp=relp,
                pR=np.array([-0.4, -0.6, 0.1]), pL=np.array([0.3, -0.6, 0.1]), prot=None, err=eerr, gripL=PRONE_GRIP_L)


# prone: elbows on the ground, the support hand can't reach the AK's mid-handguard (grip_L) -> it holds the rear of the lower
# handguard just ahead of the magazine (9 cm back along the bore)
PRONE_GRIP_L = np.array([0.0, -0.018, -0.09])


def hold(rig, base, gq, root, gun_q, gun_p, pR, pL):
    """rifle_overlay with the base's support-hand spot (grip_L, or grip_L + base['gripL'] offset)"""
    if base.get('gripL') is None:
        return A.rifle_overlay(rig, gq, root, gun_q, gun_p, poleR=pR, poleL=pL)
    return prone_overlay(rig, gq, root, gun_q, gun_p, pR, pL, base['gripL'])


def prone_overlay(rig, gq, root, gun_q, gun_p, pR, pL, off=PRONE_GRIP_L):
    F = len(gq)
    RL = qfrom_mat(rig.gunL @ rig.hand['Left']['F'].T)
    tgt = gun_p + qrot(gun_q, np.broadcast_to(A.GUN['ak74m']['grip_L'] + off, (F, 3)))
    return A.rifle_overlay(rig, gq, root, gun_q, gun_p, left='target', left_target=tgt, left_rot=qmul(gun_q, np.broadcast_to(RL, (F, 4))),
                           poleR=pR, poleL=pL)


# (spine roll applied, rifle cant) per stance/side; the aim pose itself leans ~8 deg right and the aim solve claws some
# of a left lean back, so the left side needs more input for the same visible trunk lean (~27 deg standing, ~25 kneeling)
# left peeks: more rifle cant (stand 22 -> 40, kneel 20 -> 32) so the cheek can stay on the stock: with the old cant the aim solve
# could not bring the butt closer than 5.3 / 4.0 cm to the shoulder pocket
LEAN = {('stand', 'left'): (50.0, 40.0), ('stand', 'right'): (34.0, 12.0), ('crouch', 'left'): (50.0, 32.0), ('crouch', 'right'): (27.0, 11.0)}


def base_peek(rig, lm, side, crouch, stance_fn, plant_feet, kneel, kneel_legs):
    """leaning out around a wall corner while aiming straight ahead (+Z).  side 'left': lean to the soldier's left
    (corner on his left, wall to the front-left); 'right': mirror.  Weight shifts onto the lean-side leg; standing,
    the lean-side foot steps 7 cm out.  The rifle stays on the right shoulder, canted ~45% of the lean."""
    I = rig.I
    sg = 1.0 if side == 'left' else -1.0
    lean, cant = LEAN[('crouch' if crouch else 'stand', side)]
    if not crouch:
        lf = (0.14 + (0.07 if sg > 0 else 0.0), 0.14 + (0.02 if sg > 0 else 0.0))
        rf = (-0.12 - (0.07 if sg < 0 else 0.0), -0.12 + (0.03 if sg < 0 else 0.0))
        gq1, root1, feet = stance_fn(rig, 1, drop=0.05, hip_yaw=-28, spine=(4, 8, 6, 9), lfoot=lf, rfoot=rf, lyaw=-18, ryaw=-40, head=(0, 6))
        root1 = root1.copy(); root1[:, 0] += sg * 0.075
        legs = lambda g, r, feet=feet: plant_feet(rig, g, r, feet)
        lq1 = rig.local(gq1)
    else:
        kq, kr, kfeet = kneel(rig, 1)
        lq1 = rig.local(kq)
        lq1[0, I['Hips']] = qmul(lq1[0, I['Hips']], qeuler(0, -10, 0, order='YXZ'))
        root1 = kr.copy(); root1[:, 0] += sg * 0.05; root1[:, 1] -= 0.01
        legs = lambda g, r, kfeet=kfeet: kneel_legs(rig, g, r, kfeet)
    # lean: rolls about the world forward axis distributed down the spine, head partly counter-rotated
    for b, f in (('Hips', 0.16), ('LowerBack', 0.26), ('Spine', 0.30), ('Spine1', 0.28)):
        roll_world(rig, lq1, b, -sg * lean * f)
    roll_world(rig, lq1, 'Neck', sg * lean * 0.18)
    roll_world(rig, lq1, 'Head', sg * lean * 0.12)
    gq1 = legs(rig.global_from_local(lq1), root1)
    lq_aim, gun_q, gun_p, eerr = solve_aim_cant(rig, lm, rig.local(gq1), root1, cant=-sg * cant, roll=(-3, 3))
    gp = fk_global(rig.sk, rig.global_from_local(lq_aim), root1)
    d = gp[0, I['Neck']] - gp[0, I['Hips']]
    trunk = abs(np.degrees(np.arctan2(d[0], d[1])))
    relq, relp = _rel(rig, lq_aim, root1, gun_q, gun_p)
    return dict(kind=('crouch_' if crouch else '') + 'peek_' + side, lq=lq_aim, root=root1, legs=legs, relq=relq, relp=relp,
                pR=POLE_R, pL=POLE_L, prot=qaxis(ZW, np.radians(-sg * lean * 0.8)), err=eerr, lean=trunk, sg=sg, cant=cant)


def aim_frames(rig, base, lq, root):
    """legs + gun carried by the chest + rifle hold for per-frame body locals"""
    gq = rig.global_from_local(lq)
    if base['legs']:
        gq = base['legs'](gq, root)
    cq, cp = A.chest_frame(rig.sk, gq, root)
    F = len(gq)
    gqg = qmul(cq, base['relq'][None]); gpg = cp + qrot(cq, np.broadcast_to(base['relp'], (F, 3)))
    pR, pL = arm_poles(rig, gq, root, base['pR'], base['pL'], base['prot'])
    return hold(rig, base, gq, root, gqg, gpg, pR, pL)


# ------------------------------------------------------------------ recoil
def recoil_clip(rig, name, base, body=1.0, climb=3.0, push=4.5, drift=0.6, rock=0.006, notes=''):
    """one shot (0.133 s, 5 frames): report at t=0 with the rifle still at the aim pose, peak kick at 33 ms, recovered
    at 133 ms.  The butt drives the right shoulder back (clavicle), the chest absorbs, the cheek follows the stock;
    the muzzle climbs `climb` deg (pivoting at the butt) and drifts slightly right.  First/last frame == aim pose."""
    I = rig.I
    k = KICK; kh = KICK_HEAD; F = len(k)
    lq = np.repeat(base['lq'], F, 0); root = np.repeat(base['root'], F, 0).copy()
    add_euler(rig, lq, 'Spine', -1.0 * body * k, 0, 0)
    add_euler(rig, lq, 'Spine1', -1.8 * body * k, 0.5 * body * k, 0.5 * body * k)
    add_euler(rig, lq, 'RightShoulder', 0, -push * k, 0)
    add_euler(rig, lq, 'Neck', -0.6 * body * kh, 0, 0)
    add_euler(rig, lq, 'Head', -1.3 * body * kh, 0.4 * body * kh, 0)
    root[:, 2] -= rock * kh
    gq = rig.global_from_local(lq)
    if base['legs']:
        gq = base['legs'](gq, root)
    gp = fk_global(rig.sk, gq, root)
    cq, cp = gq[:, I['Spine1']], gp[:, I['Spine1']]
    g0q = qmul(cq[0], base['relq']); g0p = cp[0] + qrot(cq[0], base['relp'])
    ic = I['RightShoulder']
    sq, sp = gq[:, ic], gp[:, ic]
    rq = qmul(qinv(sq[0]), g0q); rp = qrot(qinv(sq[0]), g0p - sp[0])
    gun_q = qmul(sq, np.broadcast_to(rq, (F, 4))); gun_p = sp + qrot(sq, np.broadcast_to(rp, (F, 3)))
    butt = A.GUN['ak74m']['butt']

    def elev(q):
        m = qrot(q, np.broadcast_to([0, 0, 1.0], (len(q), 3)))
        return np.degrees(np.arcsin(np.clip(m[:, 1], -1, 1)))
    body_rise = (elev(gun_q) - elev(gun_q[:1]))[1]          # muzzle rise already produced by the chest/clavicle at the peak
    c_loc = max(climb - body_rise, -3.0)                       # `climb` = total muzzle climb at the peak (deg)
    kq = np.array([qmul(qaxis(Y, -np.radians(drift * a)), qaxis([1, 0, 0], -np.radians(c_loc * a))) for a in k])
    bw = gun_p + qrot(gun_q, np.broadcast_to(butt, (F, 3)))
    gun_q2 = qmul(gun_q, kq)
    gun_p2 = bw - qrot(gun_q2, np.broadcast_to(butt, (F, 3))) - qrot(gun_q2, np.broadcast_to([0, 0, 0.008], (F, 3))) * k[:, None]
    pR, pL = arm_poles(rig, gq, root, base['pR'], base['pL'], base['prot'])
    gq2, err = hold(rig, base, gq, root, gun_q2, gun_p2, pR, pL)
    mz = qrot(gun_q2, np.broadcast_to([0, 0, 1.0], (F, 3)))
    rise = np.degrees(np.arcsin(np.clip(mz[:, 1], -1, 1)) - np.arcsin(np.clip(mz[0, 1], -1, 1)))
    bw2 = gun_p2 + qrot(gun_q2, np.broadcast_to(butt, (F, 3)))
    back = -((bw2 - bw2[0]) @ mz[0])
    return to_clip(name, rig, gq2, root, True,
                   notes=f'one-shot recoil cycle {SHOT_DUR:.3f} s ({len(k)} frames): report/muzzle flash at t=0 with the rifle on the aim line, peak kick at 0.033 s '
                         f'(muzzle +{rise.max():.1f} deg, butt/shoulder {100 * back.max():.1f} cm back, chest & cheek absorb), recovered at {SHOT_DUR:.3f} s; '
                         f'first/last frame == {notes} pose, so it loops seamlessly for bursts (one shot per loop, ~7.5 shots/s at timeScale 1; raise timeScale for a faster cyclic rate) and blends back into the aim clip; ik err {ik_err(err)}',
                   events={'shot': 0.0})


# ------------------------------------------------------------------ corner peeks
def peek_clip(rig, name, base, dur=2.0):
    """leaning out around a corner, aiming; subtle loopable sway (lean in/out ~2 deg, breathing, head micro-moves)"""
    F = int(round(dur * FPS)) + 1
    sg = base['sg']
    lq = np.repeat(base['lq'], F, 0); root = np.repeat(base['root'], F, 0).copy()
    sway = 1.0 * osc(F, 1) + 0.5 * noise(F, 11 if sg > 0 else 12, 12)
    for b, f in (('LowerBack', 0.4), ('Spine', 0.35), ('Spine1', 0.25)):
        roll_world(rig, lq, b, -sg * 2.0 * f * sway)
    root[:, 0] += sg * 0.008 * sway
    lq = C.breathing(rig, lq, F, 2, 0.45)
    add_euler(rig, lq, 'Head', 0.5 * noise(F, 13, 15), 0.6 * noise(F, 14, 18), 0)
    gq2, err = aim_frames(rig, base, lq, root)
    gp = fk_global(rig.sk, gq2, root)
    head_x = float(np.abs(gp[:, rig.I['Head'], 0]).mean())
    return to_clip(name, rig, gq2, root, True, notes=peek_notes(name, base, err, head_x),
                   events={'lean_side': 'left' if sg > 0 else 'right', 'head_out_m': round(head_x, 2)})


def peek_notes(name, base, err, head_x):
    side = 'left' if base['sg'] > 0 else 'right'
    pose = 'kneeling (right knee down)' if 'crouch' in name else 'standing'
    return (f'{pose} at a wall corner, trunk (hips->neck) leaning {base["lean"]:.0f} deg to the soldier\'s {side} around the corner (rolled about the aim axis, '
            f'weight on the {side} leg{", " + side + " foot 7 cm out" if "crouch" not in name else ""}), rifle shouldered and canted '
            f'{base["cant"]:.0f} deg, right eye on the sight line, aiming straight ahead (+Z); feet/knee planted; subtle sway; butt err {base["err"]:.3f} m; '
            f'ik err {ik_err(err)}. The head is {head_x:.2f} m to the {side} of the root: with the corner edge ~0.15 m to the {side} of the root the head and '
            f'rifle are out past the edge while the far shoulder and hip stay behind it.')


# ------------------------------------------------------------------ locomotion post-processing
def sink(rig, gq, root, dy):
    """lower the pelvis by dy (m) keeping the ankle trajectories and foot rotations (more knee bend = weightier gait)"""
    I = rig.I
    gp = fk_global(rig.sk, gq, root)
    root2 = root.copy(); root2[:, 1] -= dy
    F = len(gq)
    for side in ('Left', 'Right'):
        hips_f = qrot(gq[:, I['Hips']], np.broadcast_to([0, 0, 1.0], (F, 3)))
        pole = gp[:, I[side + 'Leg']] + hips_f * 0.5
        gq = leg_to(rig, gq, root2, side, gp[:, I[side + 'Foot']], pole, foot_q=gq[:, I[side + 'Foot']].copy())
    return gq, root2


def foot_lock(rig, gq, root, speed, ground=None, h_tol=0.022, v_tol=0.7, ramp=2):
    """foot planting for an in-place locomotion loop (last frame == first): while a foot is in contact (toe within h_tol of
    its lowest point and moving slower than v_tol m/s in the world) its toe is pinned in the world (x, z: the ground slides
    back at `speed`) and set down to the common ground height; corrections ramp in/out over `ramp` frames; leg IK keeps
    the foot rotations.  Returns gq, per-foot max correction (m)."""
    I = rig.I
    F = len(gq); N = F - 1
    gp = fk_global(rig.sk, gq, root)
    t = np.arange(F) / FPS
    toe_min = {sd: gp[:N, I[sd + 'ToeBase'], 1].min() for sd in ('Left', 'Right')}
    g = min(toe_min.values()) if ground is None else ground
    report = {}
    for side in ('Left', 'Right'):
        toe = gp[:N, I[side + 'ToeBase']].copy()
        toe_w = toe.copy(); toe_w[:, 2] += speed * t[:N]
        v = np.zeros(N)
        for f in range(N):   # cyclic central difference of the world toe speed (horizontal)
            a = toe_w[(f - 1) % N] - (0 if f > 0 else [0, 0, speed * N / FPS])
            b = toe_w[(f + 1) % N] + (0 if f < N - 1 else [0, 0, speed * N / FPS])
            v[f] = np.hypot(*(b - a)[[0, 2]]) * FPS / 2
        con = (toe[:, 1] < toe_min[side] + h_tol) & (v < v_tol)
        if con.all() or not con.any():
            report[side] = 0.0; continue
        # contiguous cyclic segments
        start = int(np.argmin(con))       # a non-contact frame
        segs = []; cur = None
        for k in range(1, N + 1):
            f = (start + k) % N
            if con[f] and cur is None:
                cur = [start + k]
            if not con[f] and cur is not None:
                cur.append(start + k - 1); segs.append(cur); cur = None
        if cur is not None:
            cur.append(start + N); segs.append(cur)
        corr = np.zeros((N, 3)); wsum = np.zeros(N)
        for s0, s1 in segs:
            idx = np.arange(s0 - ramp, s1 + ramp + 1)
            core = np.arange(s0, s1 + 1)
            pw = lambda ff: toe_w[ff % N] + [0, 0, speed * (ff // N) * N / FPS]
            lock = np.mean([pw(ff) for ff in core], axis=0)
            for ff in idx:
                w = 1.0 if s0 <= ff <= s1 else smooth(1 - (s0 - ff) / (ramp + 1) if ff < s0 else 1 - (ff - s1) / (ramp + 1))
                c = lock - pw(ff)
                c[1] = g - toe_min[side]
                corr[ff % N] += w * c; wsum[ff % N] += w
        k = wsum > 1
        corr[k] /= wsum[k][:, None]
        ank = gp[:N, I[side + 'Foot']] + corr
        ank = np.concatenate([ank, ank[:1]])
        hips_f = qrot(gq[:, I['Hips']], np.broadcast_to([0, 0, 1.0], (F, 3)))
        pole = gp[:, I[side + 'Leg']] + hips_f * 0.5
        gq = leg_to(rig, gq, root, side, ank, pole, foot_q=gq[:, I[side + 'Foot']].copy())
        report[side] = round(float(np.abs(corr).max()), 3)
    gq[-1] = gq[0]
    return gq, report


def foot_slide(rig, gq, root, speed, h_tol=0.015):
    """median world-space horizontal speed (m/s) of the toes while they are on the ground (within h_tol of the lowest point)"""
    gp = fk_global(rig.sk, gq, root)
    I = rig.I
    F = len(gq)
    t = np.arange(F) / FPS
    errs = []
    for side in ('Left', 'Right'):
        a = gp[:, I[side + 'ToeBase']].copy(); a[:, 2] += speed * t
        v = np.hypot(*np.gradient(a, axis=0)[:, [0, 2]].T) * FPS
        low = a[:, 1] < a[:, 1].min() + h_tol
        errs.append(np.median(v[low]))
    return float(max(errs))


# ------------------------------------------------------------------ entry point
def combat_clips(rig, lm, R, want, stance_fn, plant_feet, kneel, kneel_legs, prone_fn):
    out = {}
    cache = {}

    def base(kind):
        if kind not in cache:
            if kind == 'stand':
                cache[kind] = base_stand(rig, lm, stance_fn, plant_feet)
            elif kind == 'crouch':
                cache[kind] = base_crouch(rig, lm, kneel, kneel_legs)
            elif kind == 'prone':
                cache[kind] = base_prone(rig, lm, prone_fn)
            else:   # [crouch_]peek_<side>
                cache[kind] = base_peek(rig, lm, kind.split('_')[-1], kind.startswith('crouch'), stance_fn, plant_feet, kneel, kneel_legs)
        return cache[kind]

    if want('fire_stand'):
        out['fire_stand'] = recoil_clip(rig, 'fire_stand', base('stand'), notes='aim_stand')
    if want('fire_crouch'):
        out['fire_crouch'] = recoil_clip(rig, 'fire_crouch', base('crouch'), body=0.9, notes='aim_crouch')
    if want('fire_prone'):
        out['fire_prone'] = recoil_clip(rig, 'fire_prone', base('prone'), body=0.45, climb=2.4, push=3.0, rock=0.0, notes='aim_prone')
    for crouch in (False, True):
        for side in ('left', 'right'):
            kind = ('crouch_' if crouch else '') + 'peek_' + side
            pname = ('peek_crouch_' if crouch else 'peek_') + side
            fname = 'fire_' + pname
            if want(pname):
                out[pname] = peek_clip(rig, pname, base(kind))
            if want(fname):
                out[fname] = recoil_clip(rig, fname, base(kind), body=0.9 if crouch else 1.0, notes=pname + ' (frame 0)')
    if want('reload_stand'):
        out['reload_stand'] = reload_v2(rig, 'reload_stand', base('stand'))
    if want('reload_crouch'):
        out['reload_crouch'] = reload_v2(rig, 'reload_crouch', base('crouch'))
    if want('cover_duck'):
        out['cover_duck'] = cover_duck(rig)
    if want('pinned_prone'):
        out['pinned_prone'] = pinned_prone(rig, prone_fn)
    out.update(launcher_v2(rig, lm, want, stance_fn, plant_feet, kneel, kneel_legs))
    return out


# ------------------------------------------------------------------ helpers for keyed tracks
def track(keys, t, ease='io'):
    """scalar/vector keys [(t, value)] -> per-frame values (smoothstep between keys, held outside)"""
    kt = np.array([k[0] for k in keys]); kv = np.array([np.asarray(k[1], float) for k in keys])
    out = np.zeros((len(t),) + kv.shape[1:])
    for f, tt in enumerate(t):
        j = min(max(np.searchsorted(kt, tt, side='right') - 1, 0), len(kt) - 1)
        if j >= len(kt) - 1:
            out[f] = kv[-1]; continue
        w = np.clip((tt - kt[j]) / max(kt[j + 1] - kt[j], 1e-6), 0, 1)
        w = smooth(w) if ease == 'io' else w
        out[f] = kv[j] * (1 - w) + kv[j + 1] * w
    return out


def pulse(t, t0, rise, fall):
    """0 -> 1 (smooth, `rise` s) -> 0 (exp-ish smooth, `fall` s)"""
    up = smooth(np.clip((t - t0) / max(rise, 1e-6), 0, 1))
    dn = 1 - smooth(np.clip((t - t0 - rise) / max(fall, 1e-6), 0, 1))
    return up * dn


def set_fingers(rig, lq, side, curl):
    """per-frame finger curl (F,3: base, mid, thumb deg)"""
    H = rig.hand[side]
    ax = H['t'] if side == 'Right' else -H['t']
    th_ax = H['h'] if side == 'Right' else -H['h']
    th = 'RThumb' if side == 'Right' else 'LThumb'
    lq[:, rig.I[side + 'FingerBase']] = np.array([qaxis(ax, np.radians(c[0])) for c in curl])
    lq[:, rig.I[side + 'HandFinger1']] = np.array([qaxis(ax, np.radians(c[1])) for c in curl])
    lq[:, rig.I[th]] = np.array([qaxis(th_ax, np.radians(c[2])) for c in curl])
    return lq


def gun_pt(gun_q, gun_p, pg):
    return gun_p + qrot(gun_q, np.broadcast_to(pg, (len(gun_q), 3)))


# ------------------------------------------------------------------ reload v2
def reload_v2(rig, name, base, dur=2.6):
    """magazine change from (and back to) the aim pose.  Rifle comes off the shoulder into the workspace (in front of
    the chest, canted, muzzle slightly up); left hand: handguard -> grabs the magazine (thumb on the release) -> rocks it
    forward and out (mag_out 0.70) -> down to the front pouch (stow / draw) -> up to the well, front lug in, rocks it back
    (mag_in 1.80, rifle jolts with the slap) -> over the top to the charging handle, racks it (2.05-2.2) -> handguard ->
    rifle back on the shoulder (2.55).  The left palm holds the same pose relative to the rifle at mag_out and mag_in."""
    I = rig.I
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    lq = np.repeat(base['lq'], F, 0); root = np.repeat(base['root'], F, 0).copy()
    lift = smooth(np.clip(t / 0.32, 0, 1)) * (1 - smooth(np.clip((t - 2.22) / 0.33, 0, 1)))
    pouch = pulse(t, 0.82, 0.3, 0.45)                     # torso/head attention toward the pouch
    # head off the stock, looking at the magazine well / pouch; torso turns a little to bring the pouch to the hand
    add_euler(rig, lq, 'Head', 9 * lift + 6 * pouch, 5 * lift, 7 * lift - 3 * pouch)
    add_euler(rig, lq, 'Neck', -5 * lift + 5 * pouch, 0, 0)
    add_euler(rig, lq, 'Spine1', 2 * lift + 2 * pouch, -3 * pouch, 0)
    add_euler(rig, lq, 'Spine', 1.5 * pouch, -2 * pouch, 0)
    lq = C.breathing(rig, lq, F, 2, 0.6)
    gq = rig.global_from_local(lq)
    if base['legs']:
        gq = base['legs'](gq, root)
    cq, cp = A.chest_frame(rig.sk, gq, root)
    gq_aim = qmul(cq, base['relq'][None]); gp_aim = cp + qrot(cq, np.broadcast_to(base['relp'], (F, 3)))
    # workspace: lowered, pulled in, canted (top to the left), muzzle ~8 deg up relative to the aim line
    low_q = qeuler(x=-6, y=6, z=-24, order='YXZ')
    off = np.array([0.0, -0.12, -0.05])        # (was [0.05, -0.12, -0.10]: pulled that far in, the stock went ~4 cm into the chest)
    # rifle micro-motion: twist when the mag is rocked out, dip on the slap, jerk when racking
    rock = pulse(t, 0.70, 0.08, 0.15)
    slap = pulse(t, 1.76, 0.04, 0.14)
    rack = pulse(t, 2.06, 0.06, 0.12)
    wq = []
    for f in range(F):
        d = qmul(low_q, qeuler(x=-3 * slap[f] + 2 * rack[f], y=0, z=4 * rock[f], order='YXZ'))
        wq.append(qslerp(np.array([0, 0, 0, 1.0]), d, lift[f]) if lift[f] < 1 else d)
    gun_q = qmul(gq_aim, np.array(wq))
    gun_p = gp_aim + qrot(cq, np.broadcast_to(off, (F, 3))) * lift[:, None] + \
        np.outer(slap, [0, -0.012, 0]) + qrot(gun_q, np.broadcast_to([0, 0, 0.012], (F, 3))) * rack[:, None]
    gun = A.GUN['ak74m']
    HL = rig.hand['Left']
    RL = qfrom_mat(rig.gunL @ HL['F'].T)
    s_rest = rig.sk.head[I['Spine1']]
    gx = lambda v: qrot(gun_q, np.broadcast_to(v, (F, 3)))
    # left palm targets / rotations
    P = {
        'grip': gun_pt(gun_q, gun_p, gun['grip_L'] + [0, -0.018, 0]),
        'mag': gun_pt(gun_q, gun_p, [0.032, -0.055, 0.112]),
        'mag_rock': gun_pt(gun_q, gun_p, [0.034, -0.075, 0.135]),
        'pouch': cp + qrot(cq, np.broadcast_to(np.array([0.03, 1.14, 0.25]) - s_rest, (F, 3))),
        'pouch2': cp + qrot(cq, np.broadcast_to(np.array([0.03, 1.10, 0.26]) - s_rest, (F, 3))),
        'ch': gun_pt(gun_q, gun_p, [-0.045, 0.105, 0.125]),
        'ch_back': gun_pt(gun_q, gun_p, [-0.045, 0.105, 0.045]),
        'reach': gun_pt(gun_q, gun_p, [0.06, -0.02, 0.16]),
        'side': gun_pt(gun_q, gun_p, [0.045, 0.02, 0.24]),
    }
    q_mag = hand_q(rig, 'Left', gx([0.0, -0.55, 0.84]), gx([-1.0, 0, 0]))
    q_rock = hand_q(rig, 'Left', gx([0.0, -0.75, 0.66]), gx([-1.0, 0, 0.1]))
    q_ch = hand_q(rig, 'Left', gx([-0.9, 0.0, 0.3]), gx([0, -1.0, 0]))
    Q = {
        'grip': qmul(gun_q, np.broadcast_to(RL, (F, 4))),
        'mag': q_mag, 'mag_rock': q_rock, 'reach': q_mag,
        # front pouch: hand vertical, fingers down into the pouch, palm toward the body
        'pouch': hand_q(rig, 'Left', qrot(cq, np.broadcast_to([0.12, -0.92, 0.30], (F, 3))), qrot(cq, np.broadcast_to([0.25, 0.25, -1.0], (F, 3)))),
        'ch': q_ch, 'ch_back': q_ch,
        # palm on the left side of the handguard: rolls the hand from over-the-top (palm down) back to under (palm up)
        'side': hand_q(rig, 'Left', gx([0.0, -0.25, 0.97]), gx([-1.0, 0.25, 0])),
    }
    Q['pouch2'] = Q['pouch']
    # the palm is exactly at the 'mag' pose (rifle-relative) at mag_out (0.70) and mag_in (1.80)
    seq = [(0.0, 'grip'), (0.22, 'grip'), (0.45, 'reach'), (0.56, 'mag'), (0.70, 'mag'), (0.80, 'mag_rock'), (1.04, 'pouch'), (1.14, 'pouch2'),
           (1.26, 'pouch'), (1.56, 'mag_rock'), (1.66, 'mag_rock'), (1.80, 'mag'), (1.84, 'mag'), (2.04, 'ch'), (2.07, 'ch'), (2.12, 'ch_back'),
           (2.18, 'ch'), (2.35, 'side'), (2.47, 'grip'), (dur, 'grip')]      # hand roll back under the handguard over 0.29 s (was 0.24 s: 50 deg/frame)
    kt = np.array([s for s, _ in seq])
    tgt = np.zeros((F, 3)); rot = np.zeros((F, 4))
    for f in range(F):
        j = min(np.searchsorted(kt, t[f], side='right') - 1, len(seq) - 2)
        w = smooth(np.clip((t[f] - kt[j]) / max(kt[j + 1] - kt[j], 1e-6), 0, 1))
        a, b = seq[j][1], seq[j + 1][1]
        tgt[f] = P[a][f] * (1 - w) + P[b][f] * w
        # arc away from the rifle when travelling between rifle and pouch
        if {a, b} & {'pouch'} and a != b:
            tgt[f] += qrot(cq[f], np.array([0.03, 0.0, 0.05])) * np.sin(np.pi * w)
        rot[f] = qslerp(Q[a][f], Q[b][f], w)
    gpos = fk_global(rig.sk, gq, root)
    # elbow poles: the aim clip's at the start / end (the reload's own poles made the first & last frame differ from the aim
    # pose by 3.6 deg at the elbows), the reload's in the workspace
    poleR = gpos[:, I['RightArm']] + np.outer(1 - lift, base['pR']) + np.outer(lift, [-0.5, -0.4, -0.2])
    poleL = gpos[:, I['LeftArm']] + np.outer(1 - lift, base['pL']) + np.outer(lift, [0.25, -0.8, 0.0])
    gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, left='target', left_target=tgt, left_rot=rot, poleR=poleR, poleL=poleL)
    # free transits of the left hand (rifle -> pouch -> well -> charging handle -> handguard) rotate the hand up to 30 deg per
    # frame: smooth the left arm there (not at the contact poses: mag_out 0.70, pouch, mag_in 1.80, charging handle, grip)
    trans = np.max([smooth(np.clip((t - a) / 0.06, 0, 1)) * (1 - smooth(np.clip((t - b + 0.06) / 0.06, 0, 1)))
                    for a, b in ((0.73, 1.04), (1.27, 1.64), (1.84, 2.04), (2.14, 2.47))], axis=0)
    gq2 = A.smooth_locals(rig, gq2, ('LeftArm', 'LeftForeArm', 'LeftHand'), 3.0, trans)
    lq2 = rig.local(gq2)
    curl = track([(0.0, (60, 75, 20)), (0.25, (60, 75, 20)), (0.42, (18, 22, 10)), (0.56, (55, 62, 35)), (1.02, (55, 62, 35)), (1.14, (40, 50, 25)),
                  (1.26, (55, 62, 35)), (1.86, (55, 62, 35)), (1.95, (25, 30, 15)), (2.07, (75, 85, 40)), (2.2, (75, 85, 40)), (2.34, (20, 25, 10)),
                  (2.47, (60, 75, 20)), (dur, (60, 75, 20))], t)
    set_fingers(rig, lq2, 'Left', curl)
    gq2 = rig.global_from_local(lq2)
    kind = 'kneeling' if base['kind'] == 'crouch' else 'standing'
    return to_clip(name, rig, gq2, root, False,
                   notes=f'{kind} magazine change from/to the aim pose: rifle into the workspace (canted, in front of the chest), left hand grabs the mag '
                         f'(thumb on the release) and rocks it out (mag_out 0.70 s: attach the magazine to mag_socket_L preserving its world transform, '
                         f'e.g. THREE Object3D.attach), down to the front pouch (1.04-1.26 s) and back, front lug in and rocked home (mag_in 1.80 s: '
                         f'the left palm is at the same rifle-relative pose as at mag_out, so restoring the home transform is seamless; rifle dips with '
                         f'the slap), racks the charging handle over the top (2.05-2.2 s), back on the shoulder at 2.55 s; ik err {ik_err(err)}',
                   events={'mag_out': 0.70, 'mag_in': 1.80, 'charging_handle': 2.10, 'pouch': [1.04, 1.26]})   # (v8: pouch - emergency reloads drop the empty before it)


# ------------------------------------------------------------------ cover duck (heavily suppressed behind a low wall)
def flinches(t, times, rise=0.07, fall=0.45):
    return np.max([pulse(t, t0, rise, fall) for t0 in times], axis=0)


def cover_duck(rig, dur=3.0, wall_z=0.42, gun_dir=(1.0, 0.2, 0.05), gun_pos=(-0.05, 0.48, 0.30), head_yaw=(6, 4), gun_up=(0.0, 1.0, -0.6)):
    # the rifle used to be held upright beside the head (gun_dir (-0.10, 1, -0.10), gun_pos (-0.10, 0.62, 0.30), gun_up
    # (0.15, 0, -1), head sweep 8 deg): its receiver came within 0.13 m of the helmet centre, and every duck <-> aim / fire / idle
    # cross-fade (a pinned man ducks and comes up again every 1-3 s) swept it straight through the head (down to 3 mm from the
    # helmet centre): 'the gun glitches through the head when pinned'. Now it lies across the thighs, muzzle to his left along the
    # wall: >= 0.22 m from the helmet in the clip, and the cross-fades never come closer than the aim pose's own cheek weld
    """deep squat tight behind a low wall / window sill in front (+Z), head ducked below the parapet, back rounded, rifle
    held vertical and close (muzzle up beside the head, magazine toward the wall), flinching at 0.55 s and 2.0 s,
    fast shallow breathing and tremor.  Both feet flat."""
    I = rig.I
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    fl = flinches(t, (0.55, 2.0))
    trem = noise(F, 91, 3, 1.0)
    pose = dict(root=np.array([0.0, 0.50, -0.10]), Hips=(34, -10, 0), LowerBack=(14, 2, 0), Spine=(14, 3, 0), Spine1=(12, 3, 0), Neck=(14, 0, 0), Head=(20, head_yaw[0], 0),
                LeftShoulder=(0, 8, -6), RightShoulder=(0, -8, 6))
    lq, root = C.pose_lq(rig, pose, F)
    add_euler(rig, lq, 'Spine1', 5 * fl + 0.8 * trem, 0.6 * trem, 0)
    add_euler(rig, lq, 'Neck', 7 * fl, 0, 0)
    add_euler(rig, lq, 'Head', 8 * fl + 2 * osc(F, 1, 0.5), head_yaw[1] * noise(F, 92, 22), 0)
    add_euler(rig, lq, 'LeftShoulder', 0, 0, -7 * fl)
    add_euler(rig, lq, 'RightShoulder', 0, 0, 7 * fl)
    lq = C.breathing(rig, lq, F, 4, 1.6)
    root[:, 1] -= 0.035 * fl
    root[:, 2] -= 0.01 * fl
    gq = rig.global_from_local(lq)
    ay = rig.sk.head[I['LeftFoot'], 1]
    for side, sx, z, yaw in (('Left', 1, 0.10, -14), ('Right', -1, -0.02, -26)):
        ank = np.array([sx * 0.17, ay, z])
        gq = leg_to(rig, gq, root, side, ank, ank + [sx * 0.35, 0.4, 0.8], foot_q=qaxis(Y, np.radians(yaw)))
    # rifle: across the thighs, muzzle to his left along the wall, sights up, carried by the chest
    gq0 = gq[:1]
    cq, cp = A.chest_frame(rig.sk, gq, root)
    gw_q = qlook(np.array(gun_dir, float), np.array(gun_up, float))    # tipped slightly back: muzzle clear of the wall face
    gw_p = np.array(gun_pos, float)          # (z was 0.27: the left forearm wrapping the handguard went 8 cm into the chest)
    relq = qmul(qinv(cq[0]), gw_q); relp = qrot(qinv(cq[0]), gw_p - cp[0])
    gun_q = qmul(cq, np.broadcast_to(relq, (F, 4))); gun_p = cp + qrot(cq, np.broadcast_to(relp, (F, 3)))
    gpos = fk_global(rig.sk, gq, root)
    # left hand wraps the handguard from the body side, above the right hand
    ltgt = gun_pt(gun_q, gun_p, [0.0, 0.075, 0.25])
    hqL = hand_q(rig, 'Left', qrot(gun_q, np.broadcast_to([-1.0, 0, 0], (F, 3))), qrot(gun_q, np.broadcast_to([0, -1.0, 0.0], (F, 3))))
    gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, left='target', left_target=ltgt, left_rot=hqL,
                               poleR=gpos[:, I['RightArm']] + [-0.5, -0.5, 0.0], poleL=gpos[:, I['LeftArm']] + [0.7, -0.3, 0.3], curlL=(70, 80, 30))
    gp2 = fk_global(rig.sk, gq2, root)
    top = gp2[:, I['Head'], 1].max() + 0.20
    return to_clip('cover_duck', rig, gq2, root, True,
                   notes=f'deep squat tight behind a low wall / sill in front (+Z, face of the wall ~{wall_z} m ahead of the root), back rounded, head ducked '
                         f'(helmet top <= {top:.2f} m, i.e. under a ~0.9-1.0 m parapet), rifle across the thighs (muzzle to his left along the wall, clear of the head), flinches at '
                         f'0.55 s and 2.0 s, fast breathing + tremor; ik err {ik_err(err)}',
                   events={'flinch': [0.55, 2.0], 'head_top_m': round(float(top), 2), 'wall_front_z': wall_z})


# ------------------------------------------------------------------ pinned prone (pinned in the open)
def pinned_prone(rig, prone_fn, dur=3.0):
    """flat on the belly, face down (head turned a little to the right), left forearm over the back of the helmet,
    right hand still on the rifle lying on its side beside the body, legs flat; flinches at 0.8 s and 2.15 s"""
    I = rig.I
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    pq, pr = prone_fn(rig)
    lq = np.repeat(rig.local(pq), F, 0); root = np.repeat(pr, F, 0).copy()
    fl = flinches(t, (0.8, 2.15), 0.06, 0.5)
    # flatten: chest down, head down, face turned right
    for b, e in (('LowerBack', (5, 0, 0)), ('Spine', (9, 0, 0)), ('Spine1', (12, 0, 0)), ('Neck', (22, -10, 0)), ('Head', (18, -22, 0)),
                 ('LeftUpLeg', (0, 4, 4)), ('RightUpLeg', (0, -4, -4)), ('LeftFoot', (12, 20, 0)), ('RightFoot', (12, -20, 0))):
        add_euler(rig, lq, b, *e)
    add_euler(rig, lq, 'Spine1', -2 * fl, 0, 0)
    add_euler(rig, lq, 'Neck', 5 * fl, 0, 0)
    add_euler(rig, lq, 'Head', 4 * fl, -2 * fl, 0)
    add_euler(rig, lq, 'LeftShoulder', 0, -6 * fl, 0)
    add_euler(rig, lq, 'RightShoulder', 0, 6 * fl, 0)
    add_euler(rig, lq, 'LeftLeg', 12 * fl, 0, 0)
    add_euler(rig, lq, 'RightLeg', 8 * pulse(t, 0.86, 0.06, 0.5), 0, 0)
    lq = C.breathing(rig, lq, F, 4, 1.3)
    gq = rig.global_from_local(lq)
    # (the old ground_clamp ran on the un-posed hanging arms, which reach ~0.3 m below the chest of a prone body: the whole
    #  body floated ~25 cm above the ground with only the right hand down on the rifle)
    root = A.settle_ground(rig, gq, root, vest=0.03, arms=False, loop=True)
    root[:, 1] = root[:, 1].min() + 0.012 * fl
    gq = rig.global_from_local(lq)
    gp = fk_global(rig.sk, gq, root)
    # rifle on the ground beside the right side, lying on its left side (top toward the body), muzzle forward
    gun_q0 = qfrom_mat(np.stack([np.array([0, -1.0, 0]), np.array([1.0, 0, 0]), np.array([0, 0, 1.0])], 1))
    gun_q0 = qmul(qaxis(Y, np.radians(-6)), gun_q0)
    sh = gp[:, I['RightArm']]
    gun_p0 = np.array([sh[0, 0] - 0.20, 0.03, sh[0, 2] + 0.10])
    gun_q = np.broadcast_to(gun_q0, (F, 4)).copy(); gun_p = np.broadcast_to(gun_p0, (F, 3)).copy()
    # left forearm over the back of the helmet: palm on the back/top of the head, elbow out forward-left
    hq_ = gq[:, I['Head']]
    palm = gp[:, I['Head']] + qrot(hq_, np.broadcast_to([0.01, 0.12, -0.10], (F, 3)))
    back = qrot(hq_, np.broadcast_to([0, 0.1, -1.0], (F, 3)))       # out of the back of the head (world ~up)
    hqL = hand_q(rig, 'Left', qrot(hq_, np.broadcast_to([-1.0, 0.25, 0], (F, 3))), -back)
    palm = palm + back * (0.025 + 0.012 * fl[:, None])
    gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, left='target', left_target=palm, left_rot=hqL,
                               poleR=gp[:, I['RightArm']] + [-0.6, 0.2, -0.1], poleL=gp[:, I['LeftArm']] + [0.5, 0.25, 0.4], curlL=(35, 40, 15))
    return to_clip('pinned_prone', rig, gq2, root, True,
                   notes=f'pinned in the open: flat on the belly, face down (turned right), left forearm over the back of the helmet, right hand on the rifle '
                         f'lying on its side beside the body (weapon_socket as usual), flinches at 0.8 s and 2.15 s, fast breathing; ik err {ik_err(err)}',
                   events={'flinch': [0.8, 2.15]})


# ------------------------------------------------------------------ RPG-22: raise + shot (standing / kneeling)
STAND_READY = dict(drop=0.015, hip_yaw=-8, spine=(3, 4, 3, 3), lfoot=(0.12, 0.07), rfoot=(-0.12, -0.05), lyaw=-8, ryaw=-25, head=(-2, 4))   # = idle_rifle stance
STAND_LAUNCH = dict(drop=0.04, hip_yaw=-22, spine=(5, 6, 4, 6), lfoot=(0.16, 0.17), rfoot=(-0.13, -0.14), lyaw=-14, ryaw=-38, head=(0, 4))   # = aim_launcher
# launcher carried low before the raise (bind-pose world, carried by the chest like clips.GUNPOSE): right hand at the
# right hip, tube under the forearm, muzzle forward-down and across the body
LAUNCHER_LOW = {'stand': (np.array([-0.13, 1.07, 0.20]), dict(x=28, y=18, z=-6)), 'kneel': (np.array([-0.13, 1.09, 0.21]), dict(x=14, y=20, z=-6))}


def launcher_base(rig, lm, kind, stance_fn, plant_feet, kneel, kneel_legs):
    """same maths as clips_extra.launcher_clips (aim_launcher / aim_launcher_kneel)"""
    I = rig.I
    L = LAUNCHER['rpg22']
    if kind == 'stand':
        gq1, root1, feet = stance_fn(rig, 1, **STAND_LAUNCH)
        gq1 = plant_feet(rig, gq1, root1, feet)
        legs = lambda g, r, feet=feet: plant_feet(rig, g, r, feet)
        kspec = None
    else:
        kq, root1, kspec = kneel(rig, 1)
        lq1 = rig.local(kq)
        lq1[0, I['Hips']] = qmul(lq1[0, I['Hips']], qeuler(0, -6, 0, order='YXZ'))
        gq1 = rig.global_from_local(lq1)
        legs = lambda g, r, k=kspec: kneel_legs(rig, g, r, k)
        feet = None
    lq_aim, l_q, l_p, err = solve_launcher(rig, lm, rig.local(gq1), root1, L)
    relq, relp = _rel(rig, lq_aim, root1, l_q, l_p)
    return dict(kind=kind, lq=lq_aim, root=root1, legs=legs, relq=relq, relp=relp, err=err, feet=feet, kspec=kspec, L=L)


def feet_track(rig, gq, root, lf, rf, lyaw, ryaw, lift_l=None, lift_r=None):
    """plant_feet with per-frame foot targets (x, z), yaws (deg) and lifts (m); lifted feet pitch toes-down a little"""
    F = len(gq)
    ay = rig.sk.head[rig.I['LeftFoot'], 1]
    for side, xz, yaw, lift, sx in (('Left', lf, lyaw, lift_l, 1), ('Right', rf, ryaw, lift_r, -1)):
        xz = np.broadcast_to(xz, (F, 2)); yaw = np.broadcast_to(yaw, F)
        lift = np.zeros(F) if lift is None else np.broadcast_to(lift, F)
        tgt = np.stack([xz[:, 0], ay + lift, xz[:, 1]], 1)
        pole = tgt + [0.05 * sx, 0.5, 0.6]
        fq = np.array([qmul(qaxis(Y, np.radians(yaw[f])), qeuler(min(lift[f] / 0.04, 1.0) * 12, 0, 0, order='YXZ')) for f in range(F)])
        gq = C.leg_ik(rig, gq, root, side, tgt, pole, foot_q=fq)
    return gq


def launcher_hold(rig, gq, root, relq, relp, jump=None, back=None, L=None):
    """launcher carried by the chest (rel pose), plus a muzzle jump (deg, pivoting on the shoulder contact) and a push back (m)"""
    F = len(gq)
    cq, cp = A.chest_frame(rig.sk, gq, root)
    relq = np.broadcast_to(relq, (F, 4)); relp = np.broadcast_to(relp, (F, 3))
    gun_q = qmul(cq, relq); gun_p = cp + qrot(cq, relp)
    if jump is not None:
        c = gun_p + qrot(gun_q, np.broadcast_to(L['contact'], (F, 3)))
        gun_q = qmul(gun_q, np.array([qaxis([1, 0, 0], -np.radians(a)) for a in jump]))
        gun_p = c - qrot(gun_q, np.broadcast_to(L['contact'], (F, 3)))
    if back is not None:
        gun_p = gun_p - qrot(gun_q, np.broadcast_to([0, 0, 1.0], (F, 3))) * np.asarray(back)[:, None]
    return gun_q, gun_p


def launcher_raise(rig, name, base, stance_fn, kneel, dur=0.8):
    """ready (rifle stance, launcher carried low in both hands) -> launcher swung up the right side, past the head, onto the
    right shoulder; cheek comes down to the sight last.  Last frame == the aim clip's frame 0 exactly."""
    I = rig.I
    L = base['L']
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    stand = base['kind'] == 'stand'
    if stand:
        gq0, root0, _ = stance_fn(rig, 1, **STAND_READY)
        lq0 = rig.local(gq0)
    else:
        kq, root0, _ = kneel(rig, 1)
        lq0 = rig.local(kq)
    lq1 = base['lq']; root1 = base['root']
    w_body = smooth(np.clip((t - 0.04) / 0.56, 0, 1))
    w_clav = smooth(np.clip((t - 0.10) / 0.55, 0, 1))
    w_head = smooth(np.clip((t - 0.22) / 0.56, 0, 1))
    lq = np.zeros((F, rig.n, 4))
    for b in range(rig.n):
        nm = rig.sk.names[b]
        w = w_head if nm in ('Neck', 'Neck1', 'Head') else (w_clav if nm in ('LeftShoulder', 'RightShoulder') else w_body)
        lq[:, b] = np.array([qslerp(lq0[0, b], lq1[0, b], w[f]) for f in range(F)])
    dip = pulse(t, 0.06, 0.14, 0.3)             # small gather before the lift
    shrug = pulse(t, 0.30, 0.16, 0.26)          # right shoulder rises as the tube passes up the side
    add_euler(rig, lq, 'Spine1', 2.5 * dip, 0, 0)
    add_euler(rig, lq, 'RightShoulder', 0, 0, -5 * shrug)
    root = root0 * (1 - w_body[:, None]) + root1 * w_body[:, None]
    root = root.copy(); root[:, 1] -= 0.012 * pulse(t, 0.18, 0.16, 0.3)
    gq = rig.global_from_local(lq)
    if stand:
        a, b = STAND_READY, STAND_LAUNCH
        ws = smooth(np.clip((t - 0.16) / 0.30, 0, 1))          # left foot steps forward 0.16-0.46
        wp = smooth(np.clip((t - 0.12) / 0.45, 0, 1))          # right foot pivots on the ball
        lf = np.outer(1 - ws, a['lfoot']) + np.outer(ws, b['lfoot'])
        rf = np.outer(1 - wp, a['rfoot']) + np.outer(wp, b['rfoot'])
        gq = feet_track(rig, gq, root, lf, rf, a['lyaw'] + (b['lyaw'] - a['lyaw']) * ws, a['ryaw'] + (b['ryaw'] - a['ryaw']) * wp,
                        lift_l=0.045 * np.sin(np.pi * ws))
        # exact aim stance at the end
        gq[-1:] = base['legs'](gq[-1:], root[-1:])
    else:
        gq = base['legs'](gq, root)
    # launcher path in the chest frame: low carry -> up the right side, above the shoulder -> settles onto the shoulder
    p_low, e_low = LAUNCHER_LOW[base['kind']]
    s_rest = rig.sk.head[I['Spine1']]
    rel0p = p_low - s_rest; rel0q = qeuler(e_low['x'], e_low['y'], e_low['z'], order='YXZ')
    relp1 = base['relp']; relq1 = base['relq']
    wr = smooth(np.clip((t - 0.06) / 0.44, 0, 1))
    relq = np.array([qslerp(rel0q, relq1, w) for w in wr])
    keys = [(0.0, rel0p - relp1), (0.16, (rel0p - relp1) * 0.86 + [0.0, 0.03, 0.0]), (0.40, [-0.035, 0.08, 0.02]), (0.60, [-0.008, 0.016, 0.0])]
    off = spline_keys(keys, F, 3)
    t_set = 0.60
    k_set = int(round(t_set * FPS))
    off[k_set:] = off[k_set] * (1 - smooth(np.clip((t[k_set:] - t_set) / (dur - t_set), 0, 1)))[:, None]
    relp = relp1 + off
    gun_q, gun_p = launcher_hold(rig, gq, root, relq, relp)
    gq2, ierr = launcher_hands(rig, gq, root, gun_q, gun_p, L)
    aim = 'aim_launcher' + ('' if stand else '_kneel')
    return to_clip(name, rig, gq2, root, False,
                   notes=f'{"standing" if stand else "kneeling"} RPG-22 raise ({dur:.1f} s): from the ready stance with the extended launcher carried low in both hands '
                         f'(right hand = weapon_socket on the grip, left palm under the front tube){", left foot steps 10 cm forward into the launcher stance" if stand else ""}; '
                         f'the tube swings up the right side and over the shoulder (0.15-0.6 s), settles onto the trapezius, cheek comes down to the sight last; '
                         f'last frame == {aim} frame 0; attach rpg22.glb to weapon_socket at t=0 and hide the rifle; ik err {ik_err(ierr)}',
                   events={'launcher_socket': 'weapon_socket (identity)', 'on_shoulder': 0.62})


def fire_launcher_v2(rig, name, base, dur=1.0):
    """RPG-22 shot from the aim pose: brace, rocket leaves at 0.05 s, tube jumps (pivot on the shoulder), head flinches up and
    away from the tube, chest and shoulders rock back; standing the rear (right) foot takes a half step back to absorb, kneeling
    the body rocks back over the knee; settles by ~0.45 s, then the head comes off the sight to watch the round."""
    I = rig.I
    L = base['L']
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    stand = base['kind'] == 'stand'
    ts = 0.05
    brace = smooth(np.clip(t / ts, 0, 1)) * (1 - smooth(np.clip((t - ts) / 0.1, 0, 1)))
    imp = pulse(t, ts, 0.035, 0.36)                     # the jolt
    head = pulse(t, ts + 0.01, 0.05, 0.42)              # flinch, a touch later
    rock = pulse(t, ts + 0.02, 0.13, 0.5)               # whole-body absorb
    after = smooth(np.clip((t - 0.55) / 0.4, 0, 1))     # head up off the sight, tube dips
    lq = np.repeat(base['lq'], F, 0)
    root = np.repeat(base['root'], F, 0).copy()
    add_euler(rig, lq, 'Spine', 0.8 * brace - 1.6 * imp - 1.2 * rock, 0, 0)
    add_euler(rig, lq, 'Spine1', 1.2 * brace - 3.2 * imp - 1.5 * rock, 0.8 * imp, 1.2 * imp)
    add_euler(rig, lq, 'RightShoulder', 0, -4.0 * imp, 2.0 * imp)
    add_euler(rig, lq, 'Neck', -2.5 * head - 3 * after, 2.0 * head, 0)
    add_euler(rig, lq, 'Head', -5.5 * head - 5 * after, 5.0 * head + 2 * after, 3.0 * head + 4 * after)
    lq = C.breathing(rig, lq, F, 1, 0.5 * after)
    if stand:
        step = smooth(np.clip((t - 0.09) / 0.2, 0, 1))
        root[:, 2] -= 0.045 * rock + 0.025 * step
        root[:, 1] -= 0.018 * rock + 0.006 * step
        root[:, 0] -= 0.006 * step
    else:
        root[:, 2] -= 0.03 * rock
        root[:, 1] -= 0.012 * rock
    gq = rig.global_from_local(lq)
    if stand:
        b = STAND_LAUNCH
        rf = np.stack([b['rfoot'][0] - 0.02 * step, b['rfoot'][1] - 0.085 * step], 1)
        gq = feet_track(rig, gq, root, b['lfoot'], rf, b['lyaw'], b['ryaw'] - 4 * step, lift_r=0.035 * np.sin(np.pi * step))
    else:
        gq = base['legs'](gq, root)
    jump = 5.5 * imp + 1.0 * rock + 7 * after
    back = 0.022 * imp
    gun_q, gun_p = launcher_hold(rig, gq, root, base['relq'], base['relp'], jump=jump, back=back, L=L)
    # after the shot the tube comes a little forward off the shoulder
    gun_p = gun_p + qrot(gun_q, np.broadcast_to([0, -0.02, 0.05], (F, 3))) * after[:, None]
    gq2, ierr = launcher_hands(rig, gq, root, gun_q, gun_p, L)
    return to_clip(name, rig, gq2, root, False,
                   notes=f'{"standing" if stand else "kneeling"} RPG-22 shot from {"aim_launcher" if stand else "aim_launcher_kneel"} frame 0: brief brace, rocket leaves at '
                         f'0.05 s (muzzle flash + backblast from the rear empty), tube jumps ~6 deg pivoting on the shoulder, head flinches up/away from the tube, '
                         f'chest rocks back{"; rear (right) foot takes an 8 cm half step back (0.09-0.29 s)" if stand else " over the kneeling knee"}; settled by '
                         f'~0.45 s, then the head comes off the sight and the empty tube dips (0.55-0.95 s) ready to be discarded; ik err {ik_err(ierr)}',
                   events={'shot': ts, 'backblast': ts})


def launcher_v2(rig, lm, want, stance_fn, plant_feet, kneel, kneel_legs):
    out = {}
    for kind, sfx in (('stand', ''), ('kneel', '_kneel')):
        if not (want('launcher_raise' + sfx) or want('fire_launcher' + sfx)):
            continue
        base = launcher_base(rig, lm, kind, stance_fn, plant_feet, kneel, kneel_legs)
        if want('launcher_raise' + sfx):
            out['launcher_raise' + sfx] = launcher_raise(rig, 'launcher_raise' + sfx, base, stance_fn, kneel)
        if want('fire_launcher' + sfx):
            out['fire_launcher' + sfx] = fire_launcher_v2(rig, 'fire_launcher' + sfx, base)
    return out
