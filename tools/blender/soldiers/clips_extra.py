"""Additional / reworked clips: launchers, riding, dismount, CQB stack, window grenade throw, wounded & medical set.
Conventions (see anim.py): joint frames world-aligned in bind pose; local euler (deg, order YXZ):
  +X = pitch forward (spine bend, head nod, toes down), hip flexion = -X on *UpLeg, knee flexion = +X on *Leg,
  +Y = yaw to the character's left, +Z = roll / lean to the character's right."""
import numpy as np
from scipy.optimize import minimize
import anim as A
import clips as C
from anim import FPS, fk_global, smooth
from qmath import qmul, qinv, qrot, qaxis, qeuler, qslerp, qfrom_mat, qto_mat, qfix_continuity, qbetween

Y = np.array([0, 1.0, 0])
LAUNCHER = {   # launcher-space reference points (origin = right-hand grip, +Z muzzle, +Y up)
    'rpg22': dict(eye=np.array([0.004, 0.158, -0.235]), contact=np.array([0.0, 0.026, -0.345]), grip_L=np.array([0.0, 0.0265, 0.19])),
    'rpg7': dict(eye=np.array([0.055, 0.118, -0.235]), contact=np.array([0.0, 0.042, -0.25]), grip_L=np.array([0.0, 0.032, 0.17])),
}


# ------------------------------------------------------------------ small helpers
def osc(F, cycles, phase=0.0):
    return np.sin(2 * np.pi * cycles * np.arange(F) / max(F - 1, 1) + phase)


def noise(F, seed, smooth_n=15, amp=1.0, loop=True):
    """smooth loopable noise in [-amp, amp]"""
    rng = np.random.default_rng(seed)
    n = rng.standard_normal(F + 4 * smooth_n)
    k = np.hanning(2 * smooth_n + 1); k /= k.sum()
    s = np.convolve(n, k, 'same')[2 * smooth_n:2 * smooth_n + F]
    if loop:
        s = s - np.linspace(s[0], s[-1], F)
    return amp * s / max(np.abs(s).max(), 1e-6)


def hand_q(rig, side, h, p):
    """global rotation mapping the rest hand frame to fingers direction h and palm normal p (world)"""
    h = np.asarray(h, float); p = np.asarray(p, float)
    single = h.ndim == 1
    h = np.atleast_2d(h); p = np.broadcast_to(np.atleast_2d(p), h.shape).copy()
    h = h / np.linalg.norm(h, axis=1, keepdims=True)
    p = p - h * np.einsum('ij,ij->i', p, h)[:, None]; p /= np.linalg.norm(p, axis=1, keepdims=True)
    t = np.cross(h, p) if side == 'Right' else np.cross(p, h)
    F0 = rig.hand[side]['F']
    q = np.array([qfrom_mat(np.stack([h[i], t[i], p[i]], 1) @ F0.T) for i in range(len(h))])
    return q[0] if single else q


def arm_to(rig, gq, root, side, palm, hq, pole, twist=0.5):
    """two-bone IK: put the palm centre of `side` hand at palm (F,3) with global hand rotation hq (F,4)"""
    F = len(gq)
    palm = np.broadcast_to(palm, (F, 3)); hq = np.broadcast_to(hq, (F, 4)).copy(); pole = np.broadcast_to(pole, (F, 3)).copy()
    HL = rig.hand[side]
    wrist = palm - qrot(hq, np.broadcast_to(HL['palm'] - HL['wrist'], (F, 3)))
    gp = fk_global(rig.sk, gq, root)
    lq_ref = rig.sk.local_from_global(gq)
    gq = gq.copy()
    rig.two_bone(gq, gp, side + 'Arm', side + 'ForeArm', side + 'Hand', wrist.copy(), pole, end_rot=hq, twist_share=twist)
    return rig.recompute_desc(lq_ref, gq, {side + 'Arm', side + 'ForeArm', side + 'Hand'})


def leg_to(rig, gq, root, side, ankle, pole, foot_q=None):
    return C.leg_ik(rig, gq, root, side, ankle, pole, foot_q=foot_q)


def bone_pt(rig, gq, root, bone, rest_pt):
    """world position of a point rigidly attached to `bone`, given in bind-pose world coordinates"""
    gp = fk_global(rig.sk, gq, root)
    i = rig.I[bone]
    return gp[:, i] + qrot(gq[:, i], np.broadcast_to(np.asarray(rest_pt) - rig.sk.head[i], (len(gq), 3)))


def keyed(rig, keys, dur, ease='io'):
    """keys: [(t, pose)] pose = dict bone -> euler (deg) / 'root' -> xyz.  Missing bones = rest.
    Interpolation: smoothstep between keys (or per-key ease in key[2] if given: 'in','out','io','lin')."""
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    L = [C.pose_lq(rig, k[1])[0][0] for k in keys]
    Rt = [np.asarray(k[1].get('root', rig.sk.head[0]), float) for k in keys]
    kt = np.array([k[0] for k in keys])
    lq = np.zeros((F, rig.n, 4)); root = np.zeros((F, 3))
    for f in range(F):
        j = min(max(np.searchsorted(kt, t[f], side='right') - 1, 0), len(kt) - 1)
        if j >= len(kt) - 1:
            lq[f] = L[-1]; root[f] = Rt[-1]; continue
        w = np.clip((t[f] - kt[j]) / max(kt[j + 1] - kt[j], 1e-6), 0, 1)
        e = keys[j + 1][2] if len(keys[j + 1]) > 2 else ease
        w = w * w if e == 'in' else (1 - (1 - w) ** 2 if e == 'out' else (w if e == 'lin' else smooth(w)))
        lq[f] = qslerp(L[j], L[j + 1], w)
        root[f] = Rt[j] * (1 - w) + Rt[j + 1] * w
    return lq, root


def spline_keys(keys, F, dim):
    """Catmull-Rom through (t, value) keys sampled at F frames (30 fps); smoother than piecewise smoothstep"""
    kt = np.array([k[0] for k in keys]); kv = np.array([np.asarray(k[1], float) for k in keys]).reshape(len(keys), dim)
    t = np.arange(F) / FPS
    out = np.zeros((F, dim))
    for f in range(F):
        j = min(max(np.searchsorted(kt, t[f], side='right') - 1, 0), len(kt) - 2)
        u = np.clip((t[f] - kt[j]) / max(kt[j + 1] - kt[j], 1e-6), 0, 1)
        p0 = kv[max(j - 1, 0)]; p1 = kv[j]; p2 = kv[j + 1]; p3 = kv[min(j + 2, len(kv) - 1)]
        out[f] = 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3)
    return out


def add_euler(rig, lq, bone, ex, ey, ez):
    F = lq.shape[0]
    ex = np.broadcast_to(ex, F); ey = np.broadcast_to(ey, F); ez = np.broadcast_to(ez, F)
    q = np.array([qeuler(a, b, c, order='YXZ') for a, b, c in zip(ex, ey, ez)])
    lq[:, rig.I[bone]] = qmul(lq[:, rig.I[bone]], q)
    return lq


def to_clip(name, rig, gq, root, loop, speed=0.0, root_motion=False, notes='', events=None, extra=None):
    lq = rig.local(gq)
    for i in range(lq.shape[1]):
        lq[:, i] = qfix_continuity(lq[:, i])
    d = dict(name=name, lq=lq, root=root, loop=loop, speed=speed, root_motion=root_motion, notes=notes, dur=(len(lq) - 1) / FPS)
    if events:
        d['events'] = events
    if extra:
        d.update(extra)
    return d


def ground_clamp(rig, gq, root, clear=None, floor=0.0):
    """lift the root so no joint (with a body-part radius) goes below the floor"""
    gp = fk_global(rig.sk, gq, root)
    I = rig.I
    c = np.full(rig.n, 0.045)
    for b in ('Hips', 'LowerBack', 'Spine', 'Spine1'):
        c[I[b]] = 0.12
    for b in ('Neck', 'Neck1', 'Head'):
        c[I[b]] = 0.10
    for b in ('LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm'):
        c[I[b]] = 0.07
    for b in ('LeftUpLeg', 'RightUpLeg', 'LHipJoint', 'RHipJoint'):
        c[I[b]] = 0.08
    if clear:
        for b, v in clear.items():
            c[I[b]] = v
    pen = np.max(c[None] + floor - gp[:, :, 1], axis=1)
    root = root.copy(); root[:, 1] += np.maximum(pen, 0)
    return root


# ------------------------------------------------------------------ shoulder-fired launcher
def solve_launcher(rig, lm, lq, root, L, pocket=np.array([-0.085, 1.50, 0.015]), head=(6, 0, -14), neck=(4, 0, -4), yaw_in=0.0):
    """Launcher on the right shoulder: eye on the sight line, tube underside resting on the trapezius/shoulder.
    Launcher placed from the right eye; chest / clavicle / head solved so the tube rests on the shoulder pocket."""
    sk = rig.sk
    eL = lm['eyeR'] - sk.head[rig.I['Head']]
    base = lq.copy()
    base[0, rig.I['Neck']] = qmul(base[0, rig.I['Neck']], qeuler(*neck, order='YXZ'))
    base[0, rig.I['Head']] = qmul(base[0, rig.I['Head']], qeuler(*head, order='YXZ'))

    def apply(x):
        l = base.copy()
        for b, f in (('Spine', 0.5), ('Spine1', 0.5)):
            l[0, rig.I[b]] = qmul(base[0, rig.I[b]], qeuler(x[0] * f, x[1] * f, x[2] * f, order='YXZ'))
        l[0, rig.I['RightShoulder']] = qmul(base[0, rig.I['RightShoulder']], qeuler(0, x[3], x[4], order='YXZ'))
        l[0, rig.I['Head']] = qmul(l[0, rig.I['Head']], qeuler(x[5], 0, x[6], order='YXZ'))
        l[0, rig.I['Neck']] = qmul(l[0, rig.I['Neck']], qeuler(x[7], 0, x[8], order='YXZ'))
        return l

    def evalx(x):
        l = apply(x)
        g = rig.global_from_local(l)
        p = fk_global(sk, g, root)
        eye = p[0, rig.I['Head']] + qrot(g[0, rig.I['Head']], eL)
        lq_ = qmul(qaxis(Y, np.radians(yaw_in)), qaxis([0, 0, 1.0], np.radians(x[9])))
        lp = eye - qrot(lq_, L['eye'])
        contact = lp + qrot(lq_, L['contact'])
        ic = rig.I['RightShoulder']
        pk = p[0, ic] + qrot(g[0, ic], pocket - sk.head[ic])
        # keep the tube clear of the head: head centre must stay left of the tube axis
        hc = p[0, rig.I['Head']] + qrot(g[0, rig.I['Head']], np.array([0, 0.07, 0.0]))
        ax0 = lp + qrot(lq_, np.array([0, L['contact'][1] + 0.04, -0.2]))
        side = (hc - ax0)[0]
        return l, lq_, lp, contact, pk, side

    def cost(x):
        _, _, _, contact, pk, side = evalx(x)
        return 1e4 * np.sum((contact - pk) ** 2) + 3e3 * max(0.0, 0.10 - side) ** 2 + 0.002 * np.sum(np.asarray(x) ** 2)
    bounds = [(-6, 14), (-16, 16), (-8, 14), (-14, 14), (-8, 22), (-10, 14), (-24, 8), (-6, 16), (-12, 8), (-12, 12)]
    res = minimize(cost, np.zeros(10), method='Powell', bounds=bounds, options=dict(maxiter=8000, xtol=1e-3, ftol=1e-9))
    l, lq_, lp, contact, pk, side = evalx(res.x)
    print('launcher solve', np.round(res.x, 1), 'contact err %.3f' % np.linalg.norm(contact - pk), 'head-left %.3f' % side)
    return l, lq_, lp, float(np.linalg.norm(contact - pk))


def launcher_hands(rig, gq, root, gun_q, gun_p, L, kick=None):
    """right hand on the grip (weapon_socket = launcher origin), left palm under the front tube"""
    F = len(gq)
    I = rig.I
    HL = rig.hand['Left']
    RL = qfrom_mat(rig.gunL @ HL['F'].T)
    ltgt = gun_p + qrot(gun_q, np.broadcast_to(L['grip_L'] + [0.0, -0.016, 0.0], (F, 3)))
    lrot = qmul(gun_q, np.broadcast_to(RL, (F, 4)))
    gpos = fk_global(rig.sk, gq, root)
    out, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, left='target', left_target=ltgt, left_rot=lrot,
                               poleR=gpos[:, I['RightArm']] + [-0.35, -0.55, -0.1], poleL=gpos[:, I['LeftArm']] + [0.2, -0.8, 0.1],
                               curlL=(40, 50, 30))
    return out, err


def launcher_clips(rig, lm, R, want, stance_fn, plant_feet, kneel, kneel_legs):
    out = {}
    L = LAUNCHER['rpg22']
    I = rig.I
    variants = []
    if want('aim_launcher'):
        gq1, root1, feet = stance_fn(rig, 1, drop=0.04, hip_yaw=-22, spine=(5, 6, 4, 6), lfoot=(0.16, 0.17), rfoot=(-0.13, -0.14),
                                     lyaw=-14, ryaw=-38, head=(0, 4))
        gq1 = plant_feet(rig, gq1, root1, feet)
        variants.append(('aim_launcher', gq1, root1, lambda g, r, feet=feet: plant_feet(rig, g, r, feet)))
    if want('aim_launcher_kneel'):
        kq, kr, kfeet = kneel(rig, 1)
        lq1 = rig.local(kq)
        lq1[0, I['Hips']] = qmul(lq1[0, I['Hips']], qeuler(0, -6, 0, order='YXZ'))
        variants.append(('aim_launcher_kneel', rig.global_from_local(lq1), kr, lambda g, r, kfeet=kfeet: kneel_legs(rig, g, r, kfeet)))
    for name, gq1, root1, legs in variants:
        lq_aim, l_q, l_p, err = solve_launcher(rig, lm, rig.local(gq1), root1, L)
        cq0, cp0 = A.chest_frame(rig.sk, rig.global_from_local(lq_aim), root1)
        relq = qmul(qinv(cq0[0]), l_q); relp = qrot(qinv(cq0[0]), l_p - cp0[0])
        F = 3 * FPS + 1
        lq = np.repeat(lq_aim, F, 0); root = np.repeat(root1, F, 0)
        lq = C.breathing(rig, lq, F, 1, 0.45)
        add_euler(rig, lq, 'Spine', 0.4 * noise(F, 3), 0.5 * noise(F, 4), 0)
        gq = rig.global_from_local(lq)
        gq = legs(gq, root)
        cq, cp = A.chest_frame(rig.sk, gq, root)
        gun_q = qmul(cq, relq[None]); gun_p = cp + qrot(cq, np.broadcast_to(relp, (F, 3)))
        gq2, ierr = launcher_hands(rig, gq, root, gun_q, gun_p, L)
        if name in want_set(want, ('aim_launcher', 'aim_launcher_kneel')):
            out[name] = to_clip(name, rig, gq2, root, True,
                                notes=f'launcher shouldered (right shoulder), eye at the RPG-22 rear sight, both hands on the tube; tube-on-shoulder err {err:.3f} m; ik {ierr}',
                                events={'launcher_socket': 'weapon_socket (identity)'})
        # fire_launcher / fire_launcher_kneel / launcher_raise*: clips_combat.launcher_v2 (same aim bases)
    return out


def want_set(want, names):
    return [n for n in names if want(n)]


# ------------------------------------------------------------------ riding on a vehicle deck (seat frame)
# Seat frame: origin = seat empty on the sitting surface under the pelvis, +Z = facing, +Y up.
SEAT_HIPS = np.array([0.0, 0.118, -0.035])     # hip-joint centre above / behind the seat point when sitting
EDGE_FEET = dict(ankle=np.array([0.155, -0.29, 0.60]), pole=np.array([0.13, 0.55, 0.75]), foot=(28, -8, 0))
DECK_FEET = dict(ankle=np.array([0.165, 0.075, 0.47]), pole=np.array([0.32, 0.85, 0.55]), foot=(-4, -12, 0))


def sit_pose(rig, kind='edge'):
    pose = dict(root=SEAT_HIPS, Hips=(-14, 0, 0), LowerBack=(10, 0, 0), Spine=(8, 0, 0), Spine1=(5, 0, 0), Neck=(-2, 0, 0), Head=(4, 0, 0))
    if kind == 'deck':
        pose.update(Hips=(-24, 0, 0), LowerBack=(14, 0, 0), Spine=(13, 0, 0), Spine1=(9, 0, 0), Neck=(-8, 0, 0), Head=(-2, 0, 0))
    return pose


def sit_legs(rig, gq, root, kind='edge', sway=None):
    spec = EDGE_FEET if kind == 'edge' else DECK_FEET
    F = len(gq)
    for side, sx in (('Left', 1), ('Right', -1)):
        a = spec['ankle'] * [sx, 1, 1]; pl = spec['pole'] * [sx, 1, 1]
        ank = np.tile(a, (F, 1))
        if sway is not None and kind == 'edge':   # dangling shins swing a little with the vehicle motion
            ank = ank + np.stack([0.012 * sway[0], 0 * sway[0], 0.025 * sway[1] * sx], 1)
        e = spec['foot']
        fq = qeuler(e[0], e[1] * sx, e[2], order='YXZ')
        gq = leg_to(rig, gq, root, side, ank, np.tile(pl, (F, 1)), foot_q=fq)
    return gq


def ride_motion(F, seed=0):
    """vehicle ride sway: (roll, pitch, bounce) loopable signals"""
    roll = 1.6 * noise(F, seed + 1, 22) + 0.5 * osc(F, 7, 0.3)
    pitch = 1.1 * noise(F, seed + 2, 18) + 0.4 * osc(F, 9, 1.1)
    bounce = 0.006 * noise(F, seed + 3, 6)
    return roll, pitch, bounce


def look_around(F, keys_deg, seed=0):
    """head yaw/pitch over the loop from (t_frac, yaw, pitch) keys"""
    kk = [(k[0] * (F - 1) / FPS, [k[1], k[2]]) for k in keys_deg]
    s = spline_keys(kk, F, 2)
    return s[:, 0], s[:, 1]


def hips_frame_gun(rig, gq, root, p_rest, q_rest, hips_rest_q):
    """gun pose carried by the pelvis: p_rest/q_rest in the seat frame of the un-swayed rest sit pose"""
    i = rig.I['Hips']
    F = len(gq)
    rel = qmul(gq[:, i], np.broadcast_to(qinv(hips_rest_q), (F, 4)))
    return qmul(rel, np.broadcast_to(q_rest, (F, 4))), root + qrot(rel, np.broadcast_to(p_rest - SEAT_HIPS, (F, 3)))


def ride_clips(rig, lm, want):
    from qmath import qlook
    out = {}
    I = rig.I
    dur = 8.0
    F = int(dur * FPS) + 1
    # ---------------- ride_sit_edge: legs over the side, rifle across the lap
    for name, kind in (('ride_sit_edge', 'edge'), ('ride_sit_deck', 'deck')):
        if not want(name):
            continue
        roll, pitch, bounce = ride_motion(F, 10 if kind == 'edge' else 20)
        lq, root = keyed(rig, [(0, sit_pose(rig, kind)), (dur, sit_pose(rig, kind))], dur)
        q0 = rig.global_from_local(lq[:1].copy())
        add_euler(rig, lq, 'Hips', pitch * 0.6, 0, roll)
        add_euler(rig, lq, 'LowerBack', -pitch * 0.3, 0, -roll * 0.45)
        add_euler(rig, lq, 'Spine1', -pitch * 0.2, 0, -roll * 0.3)
        if kind == 'edge':
            yaw, hp = look_around(F, [(0, 0, 0), (0.12, -6, 2), (0.22, -32, 4), (0.36, -28, 0), (0.48, 4, -2), (0.62, 30, 2),
                                      (0.74, 36, 6), (0.86, 8, 0), (1.0, 0, 0)])
        else:
            yaw, hp = look_around(F, [(0, 0, 0), (0.15, 24, 6), (0.3, 30, 2), (0.45, 2, -4), (0.6, -22, 4), (0.75, -30, 0),
                                      (0.9, -6, 2), (1.0, 0, 0)])
        add_euler(rig, lq, 'Neck', hp * 0.4 - pitch * 0.3, yaw * 0.4, -roll * 0.25)
        add_euler(rig, lq, 'Head', hp * 0.6, yaw * 0.6, -roll * 0.2)
        add_euler(rig, lq, 'Spine', 0, yaw * 0.12, 0)
        lq = C.breathing(rig, lq, F, 3, 0.8)
        root = root + np.outer(bounce, [0, 1, 0])
        gq = rig.global_from_local(lq)
        gq = sit_legs(rig, gq, root, kind, sway=(roll / 1.6, pitch / 1.1))
        if kind == 'edge':
            d = np.array([1.0, 0.03, 0.2]); d /= np.linalg.norm(d)
            gq_rest = qlook(d, np.array([0, 0.6, -0.8]))       # magazine turned forward, over the knees
            gp_rest = np.array([-0.14, 0.30, 0.20])
            gun_q, gun_p = hips_frame_gun(rig, gq, root, gp_rest, gq_rest, q0[0, I['Hips']])
            gpos = fk_global(rig.sk, gq, root)
            gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, poleR=gpos[:, I['RightArm']] + [-0.45, -0.5, -0.25],
                                       poleL=gpos[:, I['LeftArm']] + [0.3, -0.7, -0.1])
            note = 'sitting on a deck edge / fender, legs over the side (shins angled ~30 deg out), rifle across the lap, ride sway + looking around'
        else:
            gq_rest = qlook(np.array([0.0, 1.0, 0.16]), np.array([0, 0, -1.0]))
            gp_rest = np.array([-0.01, 0.36, 0.30])
            gun_q, gun_p = hips_frame_gun(rig, gq, root, gp_rest, gq_rest, q0[0, I['Hips']])
            gpos = fk_global(rig.sk, gq, root)
            HL = rig.hand['Left']
            # left hand wraps the handguard from the front, above the right hand
            ltgt = gun_p + qrot(gun_q, np.broadcast_to(np.array([0.0, 0.045, 0.235]), (F, 3)))
            hq = hand_q(rig, 'Left', qrot(gun_q, np.broadcast_to([-1.0, 0, 0], (F, 3))), qrot(gun_q, np.broadcast_to([0, -1.0, 0.0], (F, 3))))
            gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, left='target', left_target=ltgt + qrot(gun_q, np.broadcast_to([0, 0.03, 0], (F, 3))),
                                       left_rot=hq, poleR=gpos[:, I['RightArm']] + [-0.4, -0.6, 0.0], poleL=gpos[:, I['LeftArm']] + [0.4, -0.6, 0.0])
            note = 'sitting on the deck, knees up, rifle held upright between the knees (butt on the deck), ride sway + looking around'
        out[name] = to_clip(name, rig, gq2, root, True, notes=note + f'; seat frame: Hips {SEAT_HIPS.tolist()} above/behind the seat point; ik {err}',
                            extra=dict(seat=kind))
    # ---------------- ride_aim: seated on the edge, aiming outward (+Z, slightly down)
    if want('ride_aim'):
        ap = dict(root=SEAT_HIPS, Hips=(-14, -35, 0), LowerBack=(8, 2, 0), Spine=(4, 8, 0), Spine1=(4, 9, 0), Neck=(0, 3, 0), Head=(0, 3, 0))
        lq1, root1 = keyed(rig, [(0, ap), (1 / FPS, ap)], 1 / FPS)
        lq1 = lq1[:1]; root1 = root1[:1]
        lq_aim, gun_q, gun_p, eerr = C.solve_aim(rig, lm, lq1, root1, aim_dir=np.array([0, -0.1, 1.0]))
        Fa = 4 * FPS + 1
        roll, pitch, bounce = ride_motion(Fa, 30)
        lq = np.repeat(lq_aim, Fa, 0); root = np.repeat(root1, Fa, 0) + np.outer(bounce, [0, 1, 0])
        add_euler(rig, lq, 'Hips', pitch * 0.5, 0, roll * 0.8)
        add_euler(rig, lq, 'LowerBack', -pitch * 0.35, 0, -roll * 0.55)   # upper body stabilises the sights
        add_euler(rig, lq, 'Spine', -pitch * 0.1, 0, -roll * 0.2)
        lq = C.breathing(rig, lq, Fa, 1, 0.5)
        gq = rig.global_from_local(lq)
        gq = sit_legs(rig, gq, root, 'edge', sway=(roll / 1.6, pitch / 1.1))
        cq0, cp0 = A.chest_frame(rig.sk, rig.global_from_local(lq_aim), root1)
        relq = qmul(qinv(cq0[0]), gun_q); relp = qrot(qinv(cq0[0]), gun_p - cp0[0])
        cq, cp = A.chest_frame(rig.sk, gq, root)
        gqg = qmul(cq, relq[None]); gpg = cp + qrot(cq, np.broadcast_to(relp, (Fa, 3)))
        gpos = fk_global(rig.sk, gq, root)
        gq2, err = A.rifle_overlay(rig, gq, root, gqg, gpg, poleR=gpos[:, I['RightArm']] + [-0.5, -0.35, -0.2], poleL=gpos[:, I['LeftArm']] + [0.15, -0.8, 0.1])
        out['ride_aim'] = to_clip('ride_aim', rig, gq2, root, True, notes=f'seated on the edge, rifle shouldered, aiming outward (+Z, 6 deg down) with ride sway; butt err {eerr:.3f}; ik {err}',
                                  extra=dict(seat='edge'))
    return out


# ------------------------------------------------------------------ dismount: from the edge seat, push off and drop ~1.8 m
JUMP_SEAT = np.array([0.0, 1.8, -1.6])   # seat point relative to the landing root (game puts the root 1.6 m out from the seat, on the ground)


def dismount_jump(rig, lm, dur=1.2):
    from qmath import qlook
    I = rig.I
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    S = JUMP_SEAT
    sit = sit_pose(rig, 'edge')
    # body keys (local eulers); root handled separately (ballistic)
    lean = dict(Hips=(-2, 0, 0), LowerBack=(18, 0, 0), Spine=(14, 0, 0), Spine1=(8, 0, 0), Neck=(-14, 0, 0), Head=(4, 0, 0))
    push = dict(Hips=(10, 0, 0), LowerBack=(10, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(-8, 0, 0), Head=(6, 0, 0))
    fly = dict(Hips=(4, 0, 0), LowerBack=(6, 0, 0), Spine=(4, 0, 0), Spine1=(2, 0, 0), Neck=(-4, 0, 0), Head=(8, 0, 0))
    land = dict(Hips=(20, 0, 0), LowerBack=(10, 0, 0), Spine=(8, 0, 0), Spine1=(4, 0, 0), Neck=(-14, 0, 0), Head=(-6, 0, 0))
    crouch = dict(Hips=(10, -8, 0), LowerBack=(6, 3, 0), Spine=(5, 3, 0), Spine1=(3, 2, 0), Neck=(-6, 0, 0), Head=(-2, 6, 0))
    keys = [(0.0, sit), (0.22, lean), (0.36, push), (0.5, fly), (0.8, fly), (0.9, land), (1.05, land), (dur, crouch)]
    lq, _ = keyed(rig, [(k, dict(p, root=np.zeros(3))) for k, p in keys], dur)
    # root (hip joint) path: sit -> lean forward -> push off the edge -> ballistic fall -> landing absorb -> crouch
    hip_sit = S + SEAT_HIPS
    t_off, t_td = 0.40, 0.84
    y_off = hip_sit[1] + 0.06
    y_td = 0.93
    z_sit = hip_sit[2]; z_off = S[2] + 0.18; z_td = -0.12
    root = np.zeros((F, 3))
    for f, tt in enumerate(t):
        if tt <= t_off:
            w = smooth(tt / t_off)
            root[f] = [0, hip_sit[1] + 0.06 * smooth(np.clip((tt - 0.18) / 0.22, 0, 1)), z_sit + (z_off - z_sit) * w ** 1.6]
        elif tt <= t_td:
            u = (tt - t_off) / (t_td - t_off)
            T = t_td - t_off
            vy0 = (y_td - y_off + 0.5 * 9.81 * T * T) / T     # ballistic from (t_off, y_off) to (t_td, y_td)
            s = tt - t_off
            root[f] = [0, y_off + vy0 * s - 0.5 * 9.81 * s * s, z_off + (z_td - z_off) * u]
        else:
            u = np.clip((tt - t_td) / (dur - t_td), 0, 1)
            dip = 0.40 * np.sin(np.clip(u / 0.5, 0, 1) * np.pi / 2) - 0.16 * smooth(np.clip((u - 0.5) / 0.5, 0, 1))
            root[f] = [0, y_td - dip, z_td + (0.0 - z_td) * (1 - (1 - u) ** 2)]
    gq = rig.global_from_local(lq)
    # legs: sitting dangle -> legs reach down -> feet on the ground at touchdown -> crouch (left foot forward)
    gp = fk_global(rig.sk, gq, root)
    for side, sx in (('Left', 1), ('Right', -1)):
        ank_sit = S + EDGE_FEET['ankle'] * [sx, 1, 1]
        ank_air = root + np.array([sx * 0.13, -0.80, 0.10])
        ank_land = np.array([sx * 0.16, 0.075, 0.18 if side == 'Left' else -0.12])
        ank = np.zeros((F, 3)); pole = np.zeros((F, 3)); fq = np.zeros((F, 4))
        for f, tt in enumerate(t):
            if tt < 0.3:
                ank[f] = ank_sit + [0, 0, 0.0]; w = 0
            elif tt < t_off + 0.12:
                w = smooth((tt - 0.3) / (t_off + 0.12 - 0.3))
                ank[f] = ank_sit * (1 - w) + ank_air[f] * w
            elif tt < t_td:
                w2 = smooth((tt - (t_off + 0.12)) / (t_td - t_off - 0.12))
                ank[f] = ank_air[f] * (1 - w2) + np.maximum(ank_land, ank_air[f] * [1, 0, 1] + [0, 0.075, 0]) * w2
                ank[f] = ank_air[f] * (1 - w2) + (ank_land + [0, max(0.0, root[f, 1] - 0.93) * 0.9, 0]) * w2
            else:
                ank[f] = ank_land
            pole[f] = root[f] + [sx * 0.15, 0.4, 1.0]
            fsit = qeuler(28, -8 * sx, 0, order='YXZ'); fl = qeuler(0, -12 * sx, 0, order='YXZ')
            wf = smooth(np.clip((tt - 0.3) / (t_td - 0.3), 0, 1))
            fq[f] = qslerp(fsit, qeuler(35, -6 * sx, 0, order='YXZ'), smooth(np.clip((tt - 0.3) / 0.3, 0, 1))) if tt < t_td - 0.06 else \
                qslerp(qeuler(35, -6 * sx, 0, order='YXZ'), fl, smooth(np.clip((tt - (t_td - 0.06)) / 0.1, 0, 1)))
        gq = leg_to(rig, gq, root, side, ank, pole, foot_q=fq)
    # arms: right hand keeps the rifle at the chest (port), left hand: on the handguard -> pushes on the deck -> balance -> handguard
    port_p = np.array([-0.10, 1.13, 0.27]); port_q = qeuler(22, 35, -15, order='YXZ')
    gun_q, gun_p = A.gun_in_chest(rig.sk, gq, root, port_p, port_q)
    gpos = fk_global(rig.sk, gq, root)
    HL = rig.hand['Left']
    RLg = qfrom_mat(rig.gunL @ HL['F'].T)
    grip_t = gun_p + qrot(gun_q, np.broadcast_to(A.GUN['ak74m']['grip_L'] + [0, -0.018, 0], (F, 3)))
    grip_r = qmul(gun_q, np.broadcast_to(RLg, (F, 4)))
    deck_t = np.broadcast_to(S + [0.25, 0.012, -0.08], (F, 3)).copy()
    deck_r = np.broadcast_to(hand_q(rig, 'Left', np.array([0.15, 0, 1.0]), np.array([0, 1.0, 0])), (F, 4)).copy()
    bal_t = gpos[:, I['LeftArm']] + np.array([0.32, -0.12, 0.25])
    bal_r = np.broadcast_to(hand_q(rig, 'Left', np.array([0.6, -0.2, 0.8]), np.array([0, -1.0, 0.2])), (F, 4)).copy()
    w_deck = smooth(np.clip((t - 0.12) / 0.14, 0, 1)) * (1 - smooth(np.clip((t - 0.42) / 0.1, 0, 1)))
    w_bal = smooth(np.clip((t - 0.42) / 0.1, 0, 1)) * (1 - smooth(np.clip((t - 0.95) / 0.2, 0, 1)))
    w_grip = 1 - np.maximum(w_deck, w_bal)
    ltgt = grip_t * w_grip[:, None] + deck_t * w_deck[:, None] + bal_t * w_bal[:, None]
    lrot = np.array([qslerp(qslerp(grip_r[f], deck_r[f], w_deck[f] / max(w_deck[f] + w_grip[f], 1e-6)), bal_r[f], w_bal[f]) for f in range(F)])
    gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, left='target', left_target=ltgt, left_rot=lrot,
                               poleR=gpos[:, I['RightArm']] + [-0.4, -0.6, -0.2], poleL=gpos[:, I['LeftArm']] + [0.5, -0.5, -0.1])
    return to_clip('dismount_jump', rig, gq2, root, False, root_motion=True,
                   notes=f'push off from the edge seat and drop {S[1]:.1f} m, land in a crouch; root motion kept (vertical AND horizontal): the clip starts with '
                         f'the seat point at {S.tolist()} relative to the root, i.e. the game places the root on the ground {abs(S[2]):.1f} m out from the seat '
                         f'(facing out) and the clip ends at the root; touchdown at {t_td:.2f} s; ik {err}',
                   events={'leave_seat': t_off, 'touchdown': t_td, 'seat_offset_from_root': S.tolist()})


# ------------------------------------------------------------------ wounded / medical
DRAG_HANDLE_REST = np.array([0.0, 1.445, -0.155])    # drag handle at the top of the back plate (bind pose, carried by Spine1)
DRAG = dict(handle_w=np.array([0.0, 0.50, 0.42]),     # handle in the casualty's root frame (head towards +Z)
            gap=1.0)                                  # game: casualty root = dragger root + 1.0 m along the dragger's facing
DRAG['handle_d'] = np.array([0.0, DRAG['handle_w'][1], DRAG['gap'] - DRAG['handle_w'][2]])   # same point in the dragger's frame


def lying_q(head_dir, front_dir):
    """global Hips rotation for a body whose spine points along head_dir and whose front faces front_dir"""
    y = np.asarray(head_dir, float); y /= np.linalg.norm(y)
    z = np.asarray(front_dir, float); z = z - y * (z @ y); z /= np.linalg.norm(z)
    x = np.cross(y, z)
    return qfrom_mat(np.stack([x, y, z], 1))


def limp_fingers(rig, lq, amt=1.0):
    for side in ('Left', 'Right'):
        rig.finger_curl(lq, side, 22 * amt, 30 * amt, 8 * amt)
    return lq


def wounded_ground(rig, dur=6.0):
    """on the back, half rolled onto the left side, right hand pressing a belly wound, left knee drawn up, rocking;
    head lifts and turns looking for help; the left arm reaches up once per loop"""
    I = rig.I
    F = int(dur * FPS) + 1
    t = np.arange(F) / FPS
    lq, root = rig.rest(F)
    # rocking (irregular) and the reach phase
    rock = 8 * noise(F, 41, 25) + 4 * osc(F, 3, 0.4)
    reach = smooth(np.clip((t - 2.4) / 0.6, 0, 1)) * (1 - smooth(np.clip((t - 4.0) / 0.8, 0, 1)))
    lift = 0.6 * smooth(np.clip((t - 2.0) / 0.6, 0, 1)) * (1 - smooth(np.clip((t - 4.4) / 0.8, 0, 1))) + 0.25 * np.clip(noise(F, 42, 30), 0, 1)
    for f in range(F):
        q = lying_q([0, 0.1 + 0.08 * lift[f], -1.0], [0, 1.0, 0.0])
        lq[f, I['Hips']] = qmul(q, qaxis([0, 1.0, 0], np.radians(-22 + rock[f])))   # roll onto the left side
    pose = dict(LowerBack=(8, 0, 0), Spine=(8, 4, 0), Spine1=(6, 4, 0), LeftUpLeg=(-72, -10, 12), LeftLeg=(104, 0, 0), LeftFoot=(-12, 0, 0),
                RightUpLeg=(-22, 12, -6), RightLeg=(30, 0, 0), RightFoot=(22, 0, 0))
    for b, e in pose.items():
        lq[:, I[b]] = qeuler(*e, order='YXZ')[None]
    add_euler(rig, lq, 'LowerBack', 6 * lift + 3 * np.clip(osc(F, 6), 0, 1), 0, -rock * 0.2)
    add_euler(rig, lq, 'Spine', 8 * lift, 0, 0)
    add_euler(rig, lq, 'Spine1', 6 * lift, 0, 0)
    yaw, hp = look_around(F, [(0, 10, 0), (0.15, 30, 6), (0.32, 6, 18), (0.45, -25, 22), (0.6, -10, 26), (0.75, 20, 8), (0.9, 35, 2), (1.0, 10, 0)])
    add_euler(rig, lq, 'Neck', 0.5 * hp + 10, 0.4 * yaw, 0)
    add_euler(rig, lq, 'Head', 0.5 * hp + 4, 0.6 * yaw, -rock * 0.3)
    add_euler(rig, lq, 'LeftUpLeg', -8 * osc(F, 2, 0.5) - 6 * reach, 0, 6 * osc(F, 1))
    add_euler(rig, lq, 'LeftLeg', 10 * osc(F, 2, 0.5), 0, 0)
    add_euler(rig, lq, 'RightUpLeg', -10 * np.clip(osc(F, 2, 2.5), 0, 1), 0, 0)
    add_euler(rig, lq, 'RightLeg', 18 * np.clip(osc(F, 2, 2.5), 0, 1), 0, 0)
    lq = C.breathing(rig, lq, F, 9, 2.2)
    root[:] = [0, 0.15, 0]
    gq = rig.global_from_local(lq)
    gq_tmp = gq
    root = ground_clamp(rig, gq, root, clear={'Spine1': 0.13, 'Hips': 0.11, 'Head': 0.10})
    # hands: right presses the lower belly (both palms when not reaching), left reaches up for help
    belly = bone_pt(rig, gq, root, 'Hips', np.array([-0.06, 1.01, 0.15]))
    belly2 = bone_pt(rig, gq, root, 'Hips', np.array([-0.02, 1.05, 0.165]))
    hips_q = gq[:, I['Hips']]
    front = qrot(hips_q, np.broadcast_to([0, 0, 1.0], (F, 3))); up = qrot(hips_q, np.broadcast_to([0, 1.0, 0], (F, 3))); left = np.cross(up, front)
    press = 0.008 * osc(F, 9)
    hqR = hand_q(rig, 'Right', left * 0.8 - up * 0.2, -front)
    gq = arm_to(rig, gq, root, 'Right', belly + front * (0.01 + press[:, None]), hqR, fk_global(rig.sk, gq, root)[:, I['RightArm']] - left * 0.5 + up * 0.1)
    sh = fk_global(rig.sk, gq, root)[:, I['LeftArm']]
    up_t = sh + np.array([0.12, 0.42, 0.18]) + np.stack([0.03 * osc(F, 4), 0.02 * osc(F, 5), 0 * t], 1)
    rest_t = belly2 + front * 0.03 + left * 0.06
    hq_rest = hand_q(rig, 'Left', -left * 0.8 - up * 0.3, -front)
    hq_up = hand_q(rig, 'Left', np.array([0.1, 1.0, 0.2]), np.array([0.0, -0.2, 1.0]))
    tgt = rest_t * (1 - reach[:, None]) + up_t * reach[:, None]
    hq = np.array([qslerp(hq_rest[f], hq_up, reach[f]) for f in range(F)])
    gq = arm_to(rig, gq, root, 'Left', tgt, hq, sh + left * 0.5 + np.array([0, -0.2, 0]))
    lq = rig.local(gq)
    rig.finger_curl(lq, 'Right', 30, 40, 12)
    lqL = lq.copy(); rig.finger_curl(lqL, 'Left', 35, 45, 12)
    lqO = lq.copy(); rig.finger_curl(lqO, 'Left', 5, 8, 0)
    for b in ('LeftFingerBase', 'LeftHandFinger1', 'LThumb'):
        i = I[b]
        lq[:, i] = np.array([qslerp(lqL[f, i], lqO[f, i], reach[f]) for f in range(F)])
    gq = rig.global_from_local(lq)
    return to_clip('wounded_ground', rig, gq, root, True,
                   notes='on the back, half rolled to the left, right hand pressing a belly wound, left knee drawn up, rocking, head lifting & looking around, '
                         'left arm reaches up for help (2.4-4.0 s); no weapon (sling it: weapon_socket_back, or drop)',
                   events={'reach_for_help': [2.4, 4.0]})


def wounded_crawl(rig, pq, pr, dur=2.0, speed=0.24):
    """belly crawl on the elbows dragging a dead right leg; left leg pushes"""
    I = rig.I
    F = int(dur * FPS) + 1
    t = np.arange(F) / FPS
    ph = 2 * np.pi * t / dur
    lq = np.repeat(rig.local(pq), F, 0); root = np.repeat(pr, F, 0).copy()
    root[:, 1] += 0.035     # chest propped on the forearms
    s = np.sin(ph); c = np.cos(ph)
    add_euler(rig, lq, 'Hips', 0, 7 * s, 5 * c - 2)
    add_euler(rig, lq, 'LowerBack', -4, -4 * s, -3 * c)
    add_euler(rig, lq, 'Spine', -6, -4 * s, -2 * c)
    add_euler(rig, lq, 'Spine1', -6, -3 * s, -2 * c)
    add_euler(rig, lq, 'Neck', -10 + 3 * np.abs(s), 4 * s, 0)
    add_euler(rig, lq, 'Head', -6, 3 * s, 0)
    # left leg: knee draws up sideways and pushes; right leg dead, foot rolled out, dragged
    kl = 0.5 - 0.5 * np.cos(ph + 0.4)       # 0 = leg extended, 1 = knee drawn up to the side (frog leg)
    lq[:, I['RightUpLeg']] = qeuler(0, -8, -10, order='YXZ')[None]
    lq[:, I['RightLeg']] = qeuler(6, 0, 0, order='YXZ')[None]
    lq[:, I['RightFoot']] = qeuler(15, -55, 0, order='YXZ')[None]
    add_euler(rig, lq, 'RightUpLeg', 0, 3 * s, 2 * c)
    root[:, 0] += 0.02 * s
    root[:, 1] += 0.012 * np.abs(s)
    gq = rig.global_from_local(lq)
    gp = fk_global(rig.sk, gq, root)
    # pushing left leg: the knee slides out and up along the ground, inner edge of the boot on the ground
    hipL = gp[:, I['LeftUpLeg']]
    ank = np.stack([0.20 + 0.24 * kl, 0.07 + 0.02 * kl, -0.86 + 0.42 * kl], 1)
    fqL = qmul(qaxis([0, 0, 1.0], np.radians(-70)), qeuler(80, 0, 0, order='YXZ'))
    gq = leg_to(rig, gq, root, 'Left', ank, hipL + np.array([0.9, 0.05, -0.1]), foot_q=np.broadcast_to(fqL, (F, 4)).copy())
    gp = fk_global(rig.sk, gq, root)
    # forearms on the ground: each arm reaches forward (0.45 s) then pulls back while planted
    for side, sgn, phs in (('Left', 1, 0.0), ('Right', -1, 0.5)):
        u = (t / dur + phs) % 1.0
        T_r = 0.25
        stride = speed * dur * (1 - T_r)
        z_front = 0.40; z_back = z_front - stride
        reach_w = smooth(np.clip(u / T_r, 0, 1))
        z = np.where(u < T_r, z_back + (z_front - z_back) * reach_w, z_front - (z_front - z_back) * (u - T_r) / (1 - T_r))
        y = 0.035 + np.where(u < T_r, 0.07 * np.sin(np.pi * u / T_r), 0.0)
        sh = gp[:, I[side + 'Arm']]
        palm = np.stack([sh[:, 0] * 0 + sgn * 0.17, y, sh[:, 2] * 0 + z], 1)
        hq = hand_q(rig, side, np.array([-sgn * 0.45, -0.05, 1.0]), np.array([0, -1.0, 0.0]))
        pole = sh + np.array([sgn * 0.45, -0.6, -0.1])
        gq = arm_to(rig, gq, root, side, palm, hq, pole)
    lq = rig.local(gq)
    for side in ('Left', 'Right'):
        rig.finger_curl(lq, side, 45, 55, 15)
    gq = rig.global_from_local(lq)
    return to_clip('wounded_crawl', rig, gq, root, True, speed,
                   notes='belly crawl on the forearms/elbows (arms alternate reach & pull), left leg pushes, right leg dead (foot rolled out) and dragged; no weapon')


def being_dragged(rig, dur, steps=2):
    """limp casualty pulled by the vest drag handle (head first, towards +Z): back lifted, head lolling, arms trailing,
    heels dragging.  Handle bob matches drag_wounded (2 steps per loop)."""
    I = rig.I
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    bob = np.abs(np.sin(np.pi * steps * t / dur))             # tug per step
    lq, root = rig.rest(F)
    a_p = 24.0
    q_h = lying_q([0, np.sin(np.radians(a_p)), np.cos(np.radians(a_p))], [0, np.cos(np.radians(a_p)), -np.sin(np.radians(a_p))])
    sway = 4 * np.sin(np.pi * steps * t / dur * 0.5 + 0.3)
    for f in range(F):
        lq[f, I['Hips']] = qmul(q_h, qaxis([0, 1.0, 0], np.radians(sway[f] * 0.6)))
    pose = dict(LowerBack=(12, 0, 0), Spine=(12, 0, 0), Spine1=(8, 0, 0), Neck=(-22, 0, 8), Head=(-18, 10, 6),
                LeftUpLeg=(-18, -6, 8), LeftLeg=(10, 0, 0), RightUpLeg=(-16, 8, -10), RightLeg=(8, 0, 0))
    for b, e in pose.items():
        lq[:, I[b]] = qeuler(*e, order='YXZ')[None]
    add_euler(rig, lq, 'Head', -8 * bob, 6 * np.sin(np.pi * steps * t / dur * 0.5), 4 * bob)
    add_euler(rig, lq, 'Neck', -4 * bob, 0, 0)
    add_euler(rig, lq, 'LeftUpLeg', 3 * bob, 0, 2 * bob)
    add_euler(rig, lq, 'RightUpLeg', 2 * bob, 0, -2 * bob)
    gq = rig.global_from_local(lq)
    # place so the handle sits exactly on DRAG['handle_w'] (+ tug)
    root[:] = 0
    hp0 = bone_pt(rig, gq, root, 'Spine1', DRAG_HANDLE_REST)
    target = DRAG['handle_w'] + np.outer(0.012 * bob, [0, 1.0, 0.6])
    root = target - hp0
    # heels dragging on the ground, feet fallen outward
    gp = fk_global(rig.sk, gq, root)
    for side, sgn in (('Left', 1), ('Right', -1)):
        hz = gp[:, I['Hips'], 2]
        ank = np.stack([gp[:, I['Hips'], 0] + sgn * 0.19, 0.085 + 0.004 * bob, hz - 0.80], 1)
        fq = qmul(qaxis([0, 0, 1.0], np.radians(-sgn * 38)), qeuler(-98, 0, 0, order='YXZ'))
        gq = leg_to(rig, gq, root, side, ank, gp[:, I[side + 'UpLeg']] + np.array([sgn * 0.1, 0.6, -0.3]), foot_q=fq)
    # trailing arms: limp, hands on the ground beside / behind the hips, knuckles dragging
    gp = fk_global(rig.sk, gq, root)
    hips_p = gp[:, I['Hips']]
    for side, sgn in (('Left', 1), ('Right', -1)):
        palm = np.stack([hips_p[:, 0] + sgn * 0.34, 0.035 + 0 * t, hips_p[:, 2] + 0.02 - 0.03 * bob], 1)
        hq = hand_q(rig, side, np.array([sgn * 0.3, -0.2, -1.0]), np.array([0, 0.9, 0.2]))
        gq = arm_to(rig, gq, root, side, palm, hq, gp[:, I[side + 'Arm']] + np.array([sgn * 0.6, 0.0, -0.1]))
    lq = rig.local(gq); limp_fingers(rig, lq, 1.0)
    gq = rig.global_from_local(lq)
    hp = bone_pt(rig, gq, root, 'Spine1', DRAG_HANDLE_REST)
    gpz = fk_global(rig.sk, gq, root)
    heel = min(gpz[:, I['LeftFoot'], 1].min(), gpz[:, I['RightFoot'], 1].min())
    return to_clip('being_dragged', rig, gq, root, True, 0.0,
                   notes=f'limp casualty pulled head-first by the vest drag handle (socket drag_handle on Spine1); handle at {np.round(hp.mean(0), 3).tolist()} '
                         f'in the casualty root frame (head towards +Z); the dragger stands {DRAG["gap"]} m along +Z facing -Z (drag_wounded hands at '
                         f'{np.round(DRAG["handle_d"], 3).tolist()} in its own frame); heels on the ground (ankle min y {heel:.3f}); arms trailing; loop matches drag_wounded',
                   events={'drag_handle_root_frame': np.round(hp.mean(0), 3).tolist(), 'dragger_offset_m': DRAG['gap']})


def drag_wounded(rig, base_gq, base_root, sp):
    """dragger walking backwards (mocap legs/hips), bent over, both hands on the casualty's drag handle"""
    I = rig.I
    F = len(base_gq)
    dur = (F - 1) / FPS
    t = np.arange(F) / FPS
    lq = rig.local(base_gq)
    # keep the mocap legs, but re-pose pelvis/torso: leaning back against the load with a fairly straight back,
    # knees bent, head up looking at the casualty / around
    hips = base_gq[:, I['Hips']]
    fwd = qrot(hips, np.broadcast_to([0, 0, 1.0], (F, 3))); yaw = np.arctan2(fwd[:, 0], fwd[:, 2])
    up = qrot(hips, np.broadcast_to([0, 1.0, 0], (F, 3)))
    roll = np.degrees(np.arcsin(np.clip(-up[:, 0], -1, 1)))
    for f in range(F):
        lq[f, I['Hips']] = qmul(qaxis(Y, yaw[f]), qeuler(26, 0, 0.5 * roll[f], order='YXZ'))
    for b, e in (('LowerBack', (6, 0, 0)), ('Spine', (6, 0, 0)), ('Spine1', (4, 0, 0)), ('Neck', (-14, 0, 0)), ('Head', (-4, 0, 0))):
        lq[:, I[b]] = qeuler(*e, order='YXZ')[None]
    add_euler(rig, lq, 'Head', 0, 14 * np.sin(2 * np.pi * t / dur), 0)
    gq = rig.global_from_local(lq)
    root = base_root.copy()
    # re-plant: the re-posed pelvis changes the leg chain only by the hips rotation -> keep feet where the mocap had them
    gp0 = fk_global(rig.sk, base_gq, base_root)
    for side in ('Left', 'Right'):
        gq = leg_to(rig, gq, root, side, gp0[:, I[side + 'Foot']], gp0[:, I[side + 'Leg']] + qrot(hips, np.broadcast_to([0, 0, 0.5], (F, 3))),
                    foot_q=base_gq[:, I[side + 'Foot']])
    steps = 2
    bob = np.abs(np.sin(np.pi * steps * t / dur))
    h = DRAG['handle_d'] + np.outer(0.012 * bob, [0, 1.0, -0.6])
    gp = fk_global(rig.sk, gq, root)
    for side, sgn in (('Left', 1), ('Right', -1)):
        palm = h + np.array([sgn * 0.045, 0.012, 0.01])
        hq = hand_q(rig, side, np.array([-sgn * 0.85, -0.25, 0.3]), np.array([0, -0.3, -1.0]))
        gq = arm_to(rig, gq, root, side, palm, hq, gp[:, I[side + 'Arm']] + np.array([sgn * 0.5, -0.4, -0.2]))
    lq = rig.local(gq)
    for side in ('Left', 'Right'):
        rig.finger_curl(lq, side, 75, 85, 35)
    return lq, root


def treat_wounded(rig, kq, kr, kfeet, kneel_legs, dur=6.0):
    """medic kneeling (right knee) beside a casualty, applying a tourniquet high on the casualty's leg in front of him:
    left hand holds the strap, right hand cranks the windlass; glances around twice per loop"""
    I = rig.I
    F = int(dur * FPS) + 1
    t = np.arange(F) / FPS
    lq = np.repeat(rig.local(kq), F, 0); root = np.repeat(kr, F, 0).copy()
    glance = np.zeros(F); gyaw = np.zeros(F)
    for t0, t1, yaw in ((1.6, 2.6, 55.0), (4.0, 4.9, -45.0)):
        w = smooth(np.clip((t - t0) / 0.3, 0, 1)) * (1 - smooth(np.clip((t - (t1 - 0.3)) / 0.3, 0, 1)))
        glance = np.maximum(glance, w); gyaw += yaw * w
    work = 1 - glance
    add_euler(rig, lq, 'Hips', 14 * work + 4, 6, 0)
    add_euler(rig, lq, 'LowerBack', 12 * work + 2, 0, 0)
    add_euler(rig, lq, 'Spine', 14 * work + 2, 0, 0)
    add_euler(rig, lq, 'Spine1', 10 * work, gyaw * 0.15, 0)
    add_euler(rig, lq, 'Neck', 12 * work - 6 * glance, gyaw * 0.35, 0)
    add_euler(rig, lq, 'Head', 14 * work - 4 * glance, gyaw * 0.5, 0)
    root[:, 1] -= 0.05 * work
    lq = C.breathing(rig, lq, F, 4, 1.0)
    gq = rig.global_from_local(lq)
    gq = kneel_legs(rig, gq, root, kfeet)
    # work point: casualty's thigh on the ground in front of the medic (tourniquet)
    wp = np.array([0.06, 0.18, 0.52])
    crank = 2 * np.pi * t / 0.75
    cr = np.stack([0.035 * np.cos(crank), 0.03 * np.sin(crank), 0 * t], 1) * work[:, None]
    gp = fk_global(rig.sk, gq, root)
    palmR = wp + np.array([-0.05, 0.07, -0.02]) + cr
    palmR = palmR * work[:, None] + (gp[:, I['RightArm']] + np.array([-0.08, -0.38, 0.22])) * glance[:, None]
    hqR = hand_q(rig, 'Right', np.array([0.3, -0.6, 0.8]), np.array([0.2, -0.8, -0.3]))
    gq = arm_to(rig, gq, root, 'Right', palmR, hqR, gp[:, I['RightArm']] + np.array([-0.5, -0.3, -0.1]))
    palmL = wp + np.array([0.08, 0.04, 0.0]) + np.stack([0 * t, 0.01 * np.sin(crank * 0.5), 0 * t], 1)
    palmL = palmL * work[:, None] + (gp[:, I['LeftArm']] + np.array([0.0, -0.42, 0.25])) * glance[:, None]
    hqL = hand_q(rig, 'Left', np.array([-0.5, -0.5, 0.7]), np.array([0.0, -1.0, 0.1]))
    gq = arm_to(rig, gq, root, 'Left', palmL, hqL, gp[:, I['LeftArm']] + np.array([0.5, -0.3, -0.1]))
    lq = rig.local(gq)
    rig.finger_curl(lq, 'Right', 60, 70, 30); rig.finger_curl(lq, 'Left', 55, 65, 25)
    gq = rig.global_from_local(lq)
    return to_clip('treat_wounded', rig, gq, root, True,
                   notes='medic kneeling on the right knee, bent over the casualty, applying a tourniquet (left hand holds the strap, right hand turns the windlass), '
                         'glances around at 1.6-2.6 s (left) and 4.0-4.9 s (right); work point ~0.5 m in front; rifle slung (weapon_socket_back)',
                   events={'glance': [[1.6, 2.6], [4.0, 4.9]], 'casualty_position_root_frame': [0.06, 0.0, 0.55], 'weapon': 'weapon_socket_back'})


WALL_Z = -0.30


def wounded_sit(rig, dur=6.0):
    """stabilised casualty sitting on the ground, back against a wall (wall plane at z = WALL_Z), right leg out
    (bandaged thigh), left knee up, head resting back, hand on the dressing; slow breathing, occasional head turn"""
    I = rig.I
    F = int(dur * FPS) + 1
    t = np.arange(F) / FPS
    lq, root = rig.rest(F)
    # seated: pelvis reclined against the wall
    pose = dict(Hips=(-34, 4, 0), LowerBack=(10, 0, 0), Spine=(6, 0, 0), Spine1=(2, -2, 0), Neck=(-6, 0, 4), Head=(-4, 0, 6),
                LeftUpLeg=(-80, -12, 16), LeftLeg=(105, 0, 0), LeftFoot=(-14, 0, 0),
                RightUpLeg=(-60, 10, -8), RightLeg=(14, 0, 0), RightFoot=(12, -10, 0))
    for b, e in pose.items():
        lq[:, I[b]] = qeuler(*e, order='YXZ')[None]
    yaw, hp = look_around(F, [(0, -8, 0), (0.3, -10, 2), (0.45, 25, -2), (0.62, 30, 0), (0.8, 2, 4), (1.0, -8, 0)])
    add_euler(rig, lq, 'Neck', hp * 0.4, yaw * 0.4, 0)
    add_euler(rig, lq, 'Head', hp * 0.6, yaw * 0.6, 0)
    lq = C.breathing(rig, lq, F, 3, 1.6)
    gq = rig.global_from_local(lq)
    # seat the pelvis on the ground and the upper back against the wall
    root[:] = [0, 0.12, 0]
    gp = fk_global(rig.sk, gq, root)
    back = gp[:, I['Spine1']] + qrot(gq[:, I['Spine1']], np.broadcast_to([0, 0.05, -0.17], (F, 3)))
    root[:, 2] += WALL_Z - back[:, 2].min()
    root = ground_clamp(rig, gq, root, clear={'Hips': 0.105, 'LowerBack': 0.11})
    gp = fk_global(rig.sk, gq, root)
    # right hand on the bandaged right thigh, left hand resting on the left knee
    thigh = (gp[:, I['RightUpLeg']] * 0.45 + gp[:, I['RightLeg']] * 0.55) + np.array([0.0, 0.125, 0.0])
    hqR = hand_q(rig, 'Right', np.array([0.35, -0.1, 1.0]), np.array([0, -1.0, 0.0]))
    gq = arm_to(rig, gq, root, 'Right', thigh + np.outer(0.004 * osc(F, 3), [0, 1, 0]), hqR, gp[:, I['RightArm']] + np.array([-0.5, -0.3, -0.2]))
    knee = gp[:, I['LeftLeg']] + np.array([0.0, 0.07, -0.02])
    hqL = hand_q(rig, 'Left', np.array([-0.4, -0.5, 0.75]), np.array([0, -0.8, -0.4]))
    gq = arm_to(rig, gq, root, 'Left', knee, hqL, gp[:, I['LeftArm']] + np.array([0.5, -0.3, -0.2]))
    lq = rig.local(gq); limp_fingers(rig, lq, 1.2)
    gq = rig.global_from_local(lq)
    return to_clip('wounded_sit', rig, gq, root, True,
                   notes=f'stabilised casualty sitting on the ground against a wall (wall plane z = {WALL_Z} m behind the root, facing +Z), right leg out with the '
                         'hand on the dressed thigh, left knee up, head resting back, slow breathing; no weapon',
                   events={'wall_z': WALL_Z})


# ------------------------------------------------------------------ death crumple (reworked)
def lag(x, k=0.25):
    """critically-damped follow of a (F, ...) signal (secondary motion)"""
    y = np.array(x, float).copy()
    v = np.zeros_like(y[0])
    w = 2 * np.pi * (1 / max(k, 1e-3)) / FPS
    for f in range(1, len(y)):
        a = w * w * (x[f] - y[f - 1]) - 2 * w * v
        v = v + a
        y[f] = y[f - 1] + v
    return y


def death_crumple(rig, stand_fn, plant_feet, dur=2.4):
    """shot: flinch, rifle slips from the hands (0.3 s), knees buckle and hit the ground, the trunk folds and tips onto
    the left side; arms limp; ends at rest on the left side"""
    I = rig.I
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    s0 = dict(root=np.array([0, 0.957, 0.006]), Hips=(0, -8, 0), LowerBack=(1.5, 2.4, 0), Spine=(3, 4, 0), Spine1=(3, 3, 0), Neck=(-2, 2, 0), Head=(-2, 2, 0))
    keys = [
        (0.0, s0, 'io'),
        (0.10, dict(root=np.array([0, 0.95, -0.012]), Hips=(-4, -6, 0), LowerBack=(-3, 0, 0), Spine=(-5, 4, 3), Spine1=(-7, 3, 4), Neck=(-6, 0, 0), Head=(-10, 0, 5),
                    LeftUpLeg=(-4, 0, 0), RightUpLeg=(-4, 0, 0), LeftLeg=(8, 0, 0), RightLeg=(8, 0, 0)), 'out'),
        (0.36, dict(root=np.array([0, 0.80, 0.03]), Hips=(12, -6, -4), LowerBack=(6, 0, 0), Spine=(8, 0, -3), Spine1=(8, 0, -3), Neck=(12, 0, 0), Head=(14, 6, 0),
                    LeftUpLeg=(-38, 0, 0), LeftLeg=(70, 0, 0), LeftFoot=(-22, 0, 0), RightUpLeg=(-34, 0, 0), RightLeg=(62, 0, 0), RightFoot=(-20, 0, 0)), 'in'),
        (0.60, dict(root=np.array([0.02, 0.46, 0.07]), Hips=(18, -4, -8), LowerBack=(8, 0, -2), Spine=(10, 0, -4), Spine1=(10, 0, -4), Neck=(16, 0, 0), Head=(10, 10, 0),
                    LeftUpLeg=(-20, 0, 6), LeftLeg=(100, 0, 0), LeftFoot=(36, 0, 0), RightUpLeg=(-18, 0, -6), RightLeg=(98, 0, 0), RightFoot=(36, 0, 0)), 'in'),
        (0.72, dict(root=np.array([0.03, 0.44, 0.10]), Hips=(28, -4, -14), LowerBack=(10, 0, -3), Spine=(12, 0, -4), Spine1=(10, 0, -4), Neck=(18, 0, 0), Head=(12, 10, 0),
                    LeftUpLeg=(-30, 0, 6), LeftLeg=(104, 0, 0), LeftFoot=(36, 0, 0), RightUpLeg=(-28, 0, -6), RightLeg=(100, 0, 0), RightFoot=(36, 0, 0)), 'out'),
        (1.02, dict(root=np.array([0.14, 0.27, 0.22]), Hips=(32, 0, -55), LowerBack=(10, 0, -4), Spine=(12, 0, -6), Spine1=(10, 0, -6), Neck=(10, 0, -10), Head=(6, 10, -14),
                    LeftUpLeg=(-50, 0, 6), LeftLeg=(98, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-46, 0, -4), RightLeg=(88, 0, 0), RightFoot=(30, 0, 0)), 'in'),
        (1.28, dict(root=np.array([0.25, 0.18, 0.27]), Hips=(16, 0, -86), LowerBack=(8, 0, 0), Spine=(12, 0, 0), Spine1=(10, 0, 0), Neck=(8, 0, -14), Head=(4, 10, -18),
                    LeftUpLeg=(-55, 0, 4), LeftLeg=(82, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-48, 0, 0), RightLeg=(72, 0, 0), RightFoot=(30, 0, 0)), 'in'),
        (1.45, dict(root=np.array([0.26, 0.185, 0.275]), Hips=(14, 0, -82), LowerBack=(8, 0, 1), Spine=(13, 0, 2), Spine1=(11, 0, 2), Neck=(10, 0, -12), Head=(4, 12, -16),
                    LeftUpLeg=(-56, 0, 4), LeftLeg=(84, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-50, 0, 0), RightLeg=(76, 0, 0), RightFoot=(30, 0, 0)), 'out'),
        (1.75, dict(root=np.array([0.27, 0.17, 0.27]), Hips=(14, 0, -87), LowerBack=(8, 0, 0), Spine=(13, 0, 2), Spine1=(11, 0, 2), Neck=(10, 0, -18), Head=(4, 12, -22),
                    LeftUpLeg=(-56, 0, 4), LeftLeg=(82, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-52, 0, 2), RightLeg=(76, 0, 0), RightFoot=(32, 0, 0)), 'io'),
        (dur, dict(root=np.array([0.27, 0.17, 0.27]), Hips=(14, 0, -87), LowerBack=(8, 0, 0), Spine=(13, 0, 2), Spine1=(11, 0, 2), Neck=(10, 0, -18), Head=(4, 12, -22),
                   LeftUpLeg=(-56, 0, 4), LeftLeg=(82, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-52, 0, 2), RightLeg=(76, 0, 0), RightFoot=(32, 0, 0)), 'io'),
    ]
    lq, root = keyed(rig, keys, dur)
    # head / neck lag (secondary motion)
    gq0 = rig.global_from_local(lq)
    # limp arms (local): hanging along the trunk, flung outward a little by the drop, lagging the trunk
    drop = smooth(np.clip((t - 0.3) / 0.3, 0, 1)) * (1 - smooth(np.clip((t - 0.62) / 0.2, 0, 1)))
    for side, sx in (('Left', 1), ('Right', -1)):
        lq[:, I[side + 'Arm']] = np.array([qeuler(-10 - 25 * d, 0, sx * (-38 + 22 * d), order='YXZ') for d in drop])
        lq[:, I[side + 'ForeArm']] = np.array([qeuler(0, 0, sx * (-10 - 15 * d), order='YXZ') for d in drop])
    # neck/head lag behind the trunk
    for b, k in (('Neck', 0.18), ('Head', 0.22)):
        e = np.array([lq[f, I[b]] for f in range(F)])
        lq[:, I[b]] = qfix_continuity(e)
        sm = lag(lq[:, I[b]], k)
        lq[:, I[b]] = sm / np.linalg.norm(sm, axis=1, keepdims=True)
    gq_limp = rig.global_from_local(lq)
    # the first 0.3 s: still holding the rifle (low ready), then the hands open and the arms go limp
    gun_p, gun_q_ = C.gun_rest('low_ready')
    gq_c, gp_c = A.gun_in_chest(rig.sk, gq_limp, root, gun_p, gun_q_)
    gq_hold, _ = A.rifle_overlay(rig, gq_limp, root, gq_c, gp_c)
    w = smooth(np.clip((t - 0.22) / 0.2, 0, 1))
    gq = gq_limp.copy()
    arm = [I[b] for b in ('LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LThumb', 'LeftFingerBase', 'LeftHandFinger1',
                          'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'RThumb', 'RightFingerBase', 'RightHandFinger1')]
    for f in range(F):
        for i in arm:
            gq[f, i] = qslerp(gq_hold[f, i], gq_limp[f, i], w[f])
    # at rest: hands placed on the ground (left arm forward past the head, right hand in front of the belly)
    gp = fk_global(rig.sk, gq, root)
    wr = smooth(np.clip((t - 1.05) / 0.35, 0, 1))
    hips_q = gq[:, I['Hips']]
    for side, off in (('Left', np.array([0.0, 0.035, 0.0])), ('Right', np.array([0.0, 0.035, 0.0]))):
        if side == 'Left':
            tgt = gp[:, I['Head']] + qrot(hips_q, np.broadcast_to([0.05, 0.10, 0.22], (F, 3)))
        else:
            tgt = gp[:, I['Hips']] + qrot(hips_q, np.broadcast_to([-0.05, 0.25, 0.30], (F, 3)))
        tgt[:, 1] = 0.035
        cur = fk_global(rig.sk, gq, root)
        hand_now = cur[:, I[side + 'Hand']]
        tgt = hand_now * (1 - wr[:, None]) + tgt * wr[:, None]
        hq_now = gq[:, I[side + 'Hand']]
        hq_g = np.broadcast_to(hand_q(rig, side, np.array([0.3, 0, 1.0]) if side == 'Left' else np.array([0.6, 0, 0.8]), np.array([0, -1.0, 0])), (F, 4))
        hq = np.array([qslerp(hq_now[f], hq_g[f], wr[f]) for f in range(F)])
        mask = wr > 1e-3
        if mask.any():
            sub = arm_to(rig, gq[mask], root[mask], side, tgt[mask] + qrot(hq[mask], np.broadcast_to(rig.hand[side]['palm'] - rig.hand[side]['wrist'], (mask.sum(), 3))) * 0,
                         hq[mask], cur[mask, I[side + 'Arm']] + qrot(hips_q[mask], np.broadcast_to([0.0, -0.4, 0.3], (mask.sum(), 3))))
            gq[mask] = sub
    root = ground_clamp(rig, gq, root, clear={'Hips': 0.11, 'LeftArm': 0.06, 'LeftShoulder': 0.08, 'Head': 0.10})
    lq = rig.local(gq); limp_fingers(rig, lq, 1.0)
    gq = rig.global_from_local(lq)
    return to_clip('death_crumple', rig, gq, root, False, root_motion=True,
                   notes='reworked: flinch, rifle slips from the hands at ~0.3 s, knees buckle and hit the ground (0.6 s), trunk folds and tips onto the left side, '
                         'limp arms with head lag; root motion kept; ends at rest',
                   events={'drop_weapon': 0.3, 'knees_ground': 0.6, 'body_ground': 1.28})


# ------------------------------------------------------------------ assault: window grenade lob, CQB stack
def throw_grenade_window(rig, stance_fn, plant_feet, dur=1.5):
    """overhand lob up into a 1st/2nd-floor window ~6-10 m away: grenade in the right hand, rifle carried in the left
    (weapon_socket_L); look up, wind up, step in with the left foot, release high at 0.86 s, follow through, recover"""
    I = rig.I
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    body = [
        (0.0, dict(root=np.array([0, 0.945, 0.0]), Hips=(0, -10, 0), LowerBack=(2, 0, 0), Spine=(3, 2, 0), Spine1=(3, 2, 0), Neck=(-4, 0, 0), Head=(-8, 4, 0))),
        (0.30, dict(root=np.array([0, 0.93, -0.02]), Hips=(0, -26, 0), LowerBack=(0, -6, 0), Spine=(-1, -8, 4), Spine1=(-1, -8, 4), Neck=(-6, 8, 0), Head=(-10, 14, 0))),
        (0.58, dict(root=np.array([0, 0.90, -0.06]), Hips=(0, -38, 4), LowerBack=(-2, -10, 4), Spine=(-3, -12, 6), Spine1=(-2, -10, 6), Neck=(-6, 14, 0), Head=(-12, 20, 0))),
        (0.86, dict(root=np.array([0, 0.95, 0.10]), Hips=(4, 6, -4), LowerBack=(4, 8, -4), Spine=(6, 10, -6), Spine1=(4, 10, -6), Neck=(-14, 0, 0), Head=(-16, 0, 0))),
        (1.05, dict(root=np.array([0, 0.93, 0.14]), Hips=(8, 14, -2), LowerBack=(6, 8, -2), Spine=(8, 8, -2), Spine1=(6, 6, -2), Neck=(-8, -4, 0), Head=(-10, -4, 0))),
        (dur, dict(root=np.array([0, 0.94, 0.10]), Hips=(2, -6, 0), LowerBack=(2, 0, 0), Spine=(3, 2, 0), Spine1=(3, 2, 0), Neck=(-4, 0, 0), Head=(-6, 4, 0))),
    ]
    lq, root = keyed(rig, body, dur)
    lq = C.breathing(rig, lq, F, 1, 0.6)
    gq = rig.global_from_local(lq)
    # feet: right foot planted, left foot steps forward 0.28 m between 0.55 and 0.8 s
    ay = rig.sk.head[I['LeftFoot'], 1]
    st = smooth(np.clip((t - 0.55) / 0.25, 0, 1))
    lift = np.sin(np.clip((t - 0.55) / 0.25, 0, 1) * np.pi) * 0.06
    lf = np.stack([0.13 + 0.03 * st, ay + lift, 0.06 + 0.28 * st], 1)
    rf = np.tile([-0.12, ay, -0.12], (F, 1))
    for side, tgt, yaw in (('Left', lf, -10), ('Right', rf, -35)):
        pole = tgt + [0.05 * (1 if side == 'Left' else -1), 0.5, 0.6]
        gq = leg_to(rig, gq, root, side, tgt, pole, foot_q=np.broadcast_to(qaxis(Y, np.radians(yaw)), (F, 4)).copy())
    # right hand path (root frame): chest -> back & low -> up behind the shoulder -> high release in front -> follow through -> chest
    path = [(0.0, [-0.12, 1.18, 0.26]), (0.30, [-0.30, 1.10, -0.10]), (0.58, [-0.34, 1.40, -0.26]), (0.76, [-0.22, 1.80, -0.02]),
            (0.86, [-0.14, 1.96, 0.30]), (1.0, [-0.06, 1.70, 0.52]), (1.2, [-0.06, 1.35, 0.45]), (dur, [-0.12, 1.18, 0.30])]
    P = spline_keys([(k, v) for k, v in path], F, 3) + root * [1, 0, 1]
    # palm orientation: holding the grenade (palm in / forward), opening upward-forward at release
    hq_hold = hand_q(rig, 'Right', np.array([0.2, 0.9, 0.3]), np.array([0.8, 0, 0.6]))
    hq_rel = hand_q(rig, 'Right', np.array([0.0, 0.6, 0.8]), np.array([0.2, 0.6, -0.8]))
    wrel = smooth(np.clip((t - 0.7) / 0.18, 0, 1)) * (1 - smooth(np.clip((t - 1.1) / 0.3, 0, 1)))
    hq = np.array([qslerp(hq_hold, hq_rel, w) for w in wrel])
    gp = fk_global(rig.sk, gq, root)
    gq = arm_to(rig, gq, root, 'Right', P, hq, gp[:, I['RightArm']] + np.array([-0.6, -0.4, -0.2]))
    # left hand carries the rifle by the handguard, low at the left side, swinging forward for balance at release
    lpath = [(0.0, [0.24, 0.98, 0.20]), (0.58, [0.26, 1.02, 0.28]), (0.86, [0.22, 1.05, 0.10]), (1.1, [0.24, 0.98, 0.16]), (dur, [0.24, 0.98, 0.20])]
    LP = spline_keys(lpath, F, 3) + root * [1, 0, 1]
    hqL = hand_q(rig, 'Left', np.array([-0.1, -0.3, 1.0]), np.array([-1.0, 0, 0.1]))
    gq = arm_to(rig, gq, root, 'Left', LP, hqL, gp[:, I['LeftArm']] + np.array([0.5, -0.4, -0.3]))
    lq = rig.local(gq)
    rig.finger_curl(lq, 'Left', 70, 80, 30)
    lqa = lq.copy(); rig.finger_curl(lqa, 'Right', 45, 55, 25)
    lqb = lq.copy(); rig.finger_curl(lqb, 'Right', 8, 10, 0)
    for b in ('RightFingerBase', 'RightHandFinger1', 'RThumb'):
        i = I[b]
        lq[:, i] = np.array([qslerp(lqa[f, i], lqb[f, i], wrel[f]) for f in range(F)])
    gq = rig.global_from_local(lq)
    return to_clip('throw_grenade_window', rig, gq, root, False,
                   notes='overhand lob up into a 1st/2nd-floor window: grenade in the right hand (weapon_socket), rifle in the left (weapon_socket_L); '
                         'looks up, winds up, steps in with the left foot, releases high in front at 0.86 s (launch ~55 deg up), recovers by 1.5 s',
                   events={'move_weapon_to': 'weapon_socket_L', 'pin_pull': 0.25, 'release': 0.86, 'release_dir_up_deg': 55, 'grenade_socket': 'weapon_socket'})


def cqb_stack(rig, stance_fn, plant_feet, dur=4.0):
    """crouched stack-up beside a doorway (door ahead at +Z, wall on the soldier's left), rifle at low ready, coiled,
    small weight shifts, head on the door, one glance back over the right shoulder at the team"""
    I = rig.I
    F = int(dur * FPS) + 1
    t = np.arange(F) / FPS
    gq, root, feet = stance_fn(rig, F, drop=0.20, hip_yaw=-14, spine=(14, 4, 8, 4), lfoot=(0.15, 0.16), rfoot=(-0.14, -0.20), lyaw=-6, ryaw=-28, head=(-10, 4))
    lq = rig.local(gq)
    glance = smooth(np.clip((t - 2.1) / 0.3, 0, 1)) * (1 - smooth(np.clip((t - 2.9) / 0.3, 0, 1)))
    shift = 0.6 * noise(F, 77, 20)
    add_euler(rig, lq, 'Hips', 2.0 * shift, 0, 1.5 * shift)
    add_euler(rig, lq, 'Spine1', 0, -40 * glance * 0.25, 0)
    add_euler(rig, lq, 'Neck', 6 * glance, -40 * glance * 0.35 + 3 * noise(F, 78, 25), 0)
    add_euler(rig, lq, 'Head', 4 * glance, -40 * glance * 0.4 + 4 * noise(F, 79, 25), 0)
    lq = C.breathing(rig, lq, F, 3, 1.3)
    root = root.copy(); root[:, 1] += 0.008 * noise(F, 80, 15); root[:, 0] += 0.01 * shift
    gq = rig.global_from_local(lq)
    gq = plant_feet(rig, gq, root, feet)
    p, q = np.array([-0.12, 1.17, 0.31]), qeuler(x=6, y=12, order='YXZ')
    gun_q, gun_p = A.gun_in_chest(rig.sk, gq, root, p, q)
    gpos = fk_global(rig.sk, gq, root)
    gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, poleR=gpos[:, I['RightArm']] + [-0.45, -0.5, -0.2], poleL=gpos[:, I['LeftArm']] + [0.2, -0.8, 0.0])
    return to_clip('cqb_stack', rig, gq2, root, True,
                   notes=f'crouched stack-up beside a doorway (door ahead, +Z), rifle at low ready (muzzle ~35 deg down), weight shifts, glance back at 2.1-2.9 s; ik {err}',
                   events={'glance_back': [2.1, 2.9]})
