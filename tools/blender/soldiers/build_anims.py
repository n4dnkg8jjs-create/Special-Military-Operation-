"""Stage 3: animation clips -> assets/soldiers/soldier_anims.glb (skeleton + sockets + clips, no meshes).
run: nice -n 10 python3 tools/blender/soldiers/build_anims.py [clip ...]"""
import os, sys, json, pickle, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import anim as A
import clips as C
from anim import FPS, fk_global
from qmath import qmul, qinv, qrot, qaxis, qeuler, qslerp, qnorm, qfix_continuity, qfrom_mat
import assemble as AS

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../..'))
BUILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache')
ASSETS = f'{ROOT}/assets/soldiers'
Y = np.array([0, 1.0, 0])


def setup():
    R = pickle.load(open(f'{BUILD}/body.pkl', 'rb'))
    rig = A.Rig(R['skel'], R['hands']['pos'], R['hands']['W'])
    wi = json.load(open(f'{BUILD}/weapons_info.json'))
    names = {'stock_butt': 'butt', 'sight_rear': 'sight', 'sight_front': 'front_sight'}
    for k, v in wi['ak74m']['empties'].items():
        A.GUN['ak74m'][names.get(k, k)] = np.array(v[0])
    return R, rig


# ------------------------------------------------------------------ stance helpers
def stance(rig, F, drop=0.015, hip_yaw=-8, spine=(3, 4, 3, 3), lfoot=(0.12, 0.07), rfoot=(-0.12, -0.05),
           lyaw=-8, ryaw=-25, head=(-2, 4)):
    lq, root = rig.rest(F)
    I = rig.I
    root[:, 1] -= drop
    lq[:, I['Hips']] = qeuler(0, hip_yaw, 0, order='YXZ')
    lq[:, I['LowerBack']] = qeuler(spine[0] * 0.5, -hip_yaw * 0.3, 0, order='YXZ')
    lq[:, I['Spine']] = qeuler(spine[0], spine[1], 0, order='YXZ')
    lq[:, I['Spine1']] = qeuler(spine[2], spine[3], 0, order='YXZ')
    lq[:, I['Neck']] = qeuler(head[0], head[1] * 0.5, 0, order='YXZ')
    lq[:, I['Head']] = qeuler(head[0], head[1] * 0.5, 0, order='YXZ')
    gq = rig.global_from_local(lq)
    return gq, root, (lfoot, rfoot, lyaw, ryaw)


def plant_feet(rig, gq, root, feet, ankle_y=None):
    lfoot, rfoot, lyaw, ryaw = feet
    ay = rig.sk.head[rig.I['LeftFoot'], 1] if ankle_y is None else ankle_y
    F = len(gq)
    for side, (x, z), yaw in (('Left', lfoot, lyaw), ('Right', rfoot, ryaw)):
        tgt = np.array([x, ay, z])
        pole = tgt + [0.05 * (1 if side == 'Left' else -1), 0.5, 0.6]
        fq = qaxis(Y, np.radians(yaw))
        gq = C.leg_ik(rig, gq, root, side, tgt, pole, foot_q=fq)
    return gq


def to_clip(name, rig, gq, root, loop, speed=0.0, root_motion=False, notes=''):
    lq = rig.local(gq)
    for i in range(lq.shape[1]):
        lq[:, i] = qfix_continuity(lq[:, i])
    return dict(name=name, lq=lq, root=root, loop=loop, speed=speed, root_motion=root_motion, notes=notes,
                dur=(len(lq) - 1) / FPS)


def osc(F, cycles, phase=0.0):
    return np.sin(2 * np.pi * cycles * np.arange(F) / (F - 1) + phase)


# ------------------------------------------------------------------ locomotion from mocap
def loco(rig, bvh, t0, t1, pmin, pmax, gunpose, lean=6, search=None, ground_pct=8, poleL=None, poleR=None, curl=None):
    gq, root = C.mocap(rig, bvh, t0, t1)
    gq, root = C.face_forward(rig, gq, root)
    root = C.ground_fix(rig, gq, root, ground_pct)
    a, p = C.find_cycle(rig, gq, root, pmin, pmax, search)
    gq, root, stride = C.make_loop(gq, root, a, p)
    speed = float(np.hypot(stride[0], stride[2]) / (p / FPS))
    # combat lean + keep head level
    lq = rig.local(gq)
    I = rig.I
    for b, f in (('Spine', 0.5), ('Spine1', 0.5)):
        lq[:, I[b]] = qmul(lq[:, I[b]], qeuler(lean * f, 0, 0, order='YXZ')[None])
    lq[:, I['Neck']] = qmul(lq[:, I['Neck']], qeuler(-lean * 0.7, 0, 0, order='YXZ')[None])
    gq = rig.global_from_local(lq)
    root = C.strip_root(root)
    gq, err = C.carry(rig, gq, root, gunpose, poleL=poleL, poleR=poleR)
    return gq, root, speed, err, (a, p)


def build_all(rig, R, only=None):
    out = {}
    lm = R['variants']['A']['lm']
    I = rig.I

    def want(n):
        return only is None or n in only

    # ---------------- idle_rifle: authored stance, low ready, breathing, slight weight shift, look around
    if want('idle_rifle') or want('aim_stand') or want('fire_stand'):
        F = 4 * FPS + 1
        gq, root, feet = stance(rig, F)
        lq = rig.local(gq)
        lq = C.breathing(rig, lq, F, cycles=1, amp=1.0)
        C.add_local(rig, lq, 'Hips', lambda f: (0 * f, 1.5 * osc(F, 1), 1.0 * osc(F, 1)))
        C.add_local(rig, lq, 'Head', lambda f: (1.5 * osc(F, 2, 1.0), 10 * osc(F, 1, 0.6) * np.clip(osc(F, 1, 0.6) * 2, -1, 1) * 0.6, 0 * f))
        gq = rig.global_from_local(lq)
        root = root.copy(); root[:, 0] += 0.012 * osc(F, 1)
        gq = plant_feet(rig, gq, root, feet)
        gq2, err = C.carry(rig, gq, root, 'low_ready')
        if want('idle_rifle'):
            out['idle_rifle'] = to_clip('idle_rifle', rig, gq2, root, True, notes=f'authored stance, low ready; ik err {err}')
    # ---------------- aim_stand / fire_stand
    if want('aim_stand') or want('fire_stand') or want('reload_stand'):
        F1 = 1
        gq1, root1, feet = stance(rig, F1, drop=0.035, hip_yaw=-28, spine=(4, 8, 6, 9), lfoot=(0.14, 0.14), rfoot=(-0.12, -0.12), lyaw=-18, ryaw=-40, head=(0, 6))
        gq1 = plant_feet(rig, gq1, root1, feet)
        lq1 = rig.local(gq1)
        lq_aim, gun_q, gun_p, eerr = C.solve_aim(rig, lm, lq1, root1)
        F = 3 * FPS + 1
        lq = np.repeat(lq_aim, F, 0); root = np.repeat(root1, F, 0)
        lq = C.breathing(rig, lq, F, cycles=1, amp=0.5)
        gq = rig.global_from_local(lq)
        gq = plant_feet(rig, gq, root, feet)
        # gun follows the chest from the solved pose (so breathing moves the sights slightly)
        cq0, cp0 = A.chest_frame(rig.sk, rig.global_from_local(lq_aim), root1)
        rel_q = qmul(qinv(cq0[0]), gun_q); rel_p = qrot(qinv(cq0[0]), gun_p - cp0[0])
        cq, cp = A.chest_frame(rig.sk, gq, root)
        gqg = qmul(cq, rel_q[None]); gpg = cp + qrot(cq, np.broadcast_to(rel_p, (F, 3)))
        poleR = fk_global(rig.sk, gq, root)[:, I['RightArm']] + [-0.5, -0.35, -0.2]
        poleL = fk_global(rig.sk, gq, root)[:, I['LeftArm']] + [0.15, -0.8, 0.1]
        gqa, err = A.rifle_overlay(rig, gq, root, gqg, gpg, poleR=poleR, poleL=poleL)
        aim_state = dict(lq=lq, root=root, gqg=gqg, gpg=gpg, feet=feet, rel=(rel_q, rel_p))
        if want('aim_stand'):
            out['aim_stand'] = to_clip('aim_stand', rig, gqa, root, True, notes=f'shouldered, cheek weld butt-to-pocket err {eerr:.3f} m; ik err {err}')
        if want('fire_stand'):
            # single shot recoil cycle 0.4 s (loop it for automatic fire): gun kicks back/up, shoulder & head absorb
            F = int(0.4 * FPS) + 1
            t = np.arange(F) / FPS
            kick = np.where(t < 0.04, t / 0.04, np.exp(-(t - 0.04) / 0.07)) * (t < 0.36)
            kick = kick * (1 - smooth_(np.clip((t - 0.25) / 0.15, 0, 1)))
            lqf = np.repeat(lq_aim, F, 0); rootf = np.repeat(root1, F, 0)
            C.add_local(rig, lqf, 'Spine1', lambda f: (-2.5 * kick, 0 * kick, 0.6 * kick))
            C.add_local(rig, lqf, 'Spine', lambda f: (-1.2 * kick, 0 * kick, 0 * kick))
            C.add_local(rig, lqf, 'RightShoulder', lambda f: (0 * kick, 3.5 * kick, 0 * kick))
            C.add_local(rig, lqf, 'Head', lambda f: (-1.5 * kick, 0 * kick, 0 * kick))
            gqf = rig.global_from_local(lqf)
            gqf = plant_feet(rig, gqf, rootf, feet)
            cq, cp = A.chest_frame(rig.sk, gqf, rootf)
            muzzle_up = qaxis([1, 0, 0], -np.radians(4.5) * kick)
            gq_g = qmul(qmul(cq, rel_q[None]), muzzle_up)
            gp_g = cp + qrot(cq, np.broadcast_to(rel_p, (F, 3))) - qrot(gq_g, np.broadcast_to([0, 0, 0.025], (F, 3))) * kick[:, None]
            pR = fk_global(rig.sk, gqf, rootf)[:, I['RightArm']] + [-0.5, -0.35, -0.2]
            pL = fk_global(rig.sk, gqf, rootf)[:, I['LeftArm']] + [0.15, -0.8, 0.1]
            gqf2, err = A.rifle_overlay(rig, gqf, rootf, gq_g, gp_g, poleR=pR, poleL=pL)
            out['fire_stand'] = to_clip('fire_stand', rig, gqf2, rootf, False, notes='one shot recoil cycle (0.4 s); loop for auto fire, muzzle flash at t=0')
    # ---------------- locomotion
    if want('walk_rifle'):
        gq, root, sp, err, cyc = loco(rig, '16_15', 0.3, 3.6, 30, 40, 'patrol', lean=7)
        out['walk_rifle'] = to_clip('walk_rifle', rig, gq, root, True, sp, notes=f'CMU 16_15 cycle {cyc}; ik err {err}')
    if want('run_rifle'):
        gq, root, sp, err, cyc = loco(rig, '16_35', 0.0, 1.35, 18, 26, 'port', lean=12)
        out['run_rifle'] = to_clip('run_rifle', rig, gq, root, True, sp, notes=f'CMU 16_35 cycle {cyc}; ik err {err}')
    if want('crouch_walk'):
        gq, root, sp, err, cyc = loco(rig, '136_09', 2.0, 8.5, 30, 60, 'low_ready', lean=10)
        out['crouch_walk'] = to_clip('crouch_walk', rig, gq, root, True, sp, notes=f'CMU 136_09 walk crouched cycle {cyc}; ik err {err}')
    if want('limp_walk'):
        gq, root, sp, err, cyc = loco(rig, '77_19', 1.5, 7.5, 40, 80, 'patrol', lean=6)
        out['limp_walk'] = to_clip('limp_walk', rig, gq, root, True, sp, notes=f'CMU 77_19 limping (hurt right leg) cycle {cyc}; ik err {err}')
    # ---------------- kneeling family: crouch_idle, aim_crouch, reload_crouch, suppressed_cower
    if any(want(n) for n in ('crouch_idle', 'aim_crouch', 'reload_crouch', 'suppressed_cower')):
        kq, kr, kfeet = kneel(rig, 1)
        if want('crouch_idle'):
            F = 4 * FPS + 1
            lq = np.repeat(rig.local(kq), F, 0); root = np.repeat(kr, F, 0)
            lq = C.breathing(rig, lq, F, 1, 1.1)
            C.add_local(rig, lq, 'Head', lambda f: (0 * f, 14 * osc(F, 1, 0.4) * 0.7, 0 * f))
            gq = rig.global_from_local(lq)
            gq = kneel_legs(rig, gq, root, kfeet)
            gq2, err = C.carry(rig, gq, root, 'low_ready')
            out['crouch_idle'] = to_clip('crouch_idle', rig, gq2, root, True, notes=f'kneeling on right knee, low ready; ik err {err}')
        if want('aim_crouch') or want('reload_crouch'):
            lq1 = rig.local(kq)
            lq1[0, I['Hips']] = qmul(lq1[0, I['Hips']], qeuler(0, -10, 0, order='YXZ'))
            lq_aim, gun_q, gun_p, eerr = C.solve_aim(rig, lm, lq1, kr)
            F = 3 * FPS + 1
            lq = np.repeat(lq_aim, F, 0); root = np.repeat(kr, F, 0)
            lq = C.breathing(rig, lq, F, 1, 0.5)
            gq = rig.global_from_local(lq)
            gq = kneel_legs(rig, gq, root, kfeet)
            cq0, cp0 = A.chest_frame(rig.sk, rig.global_from_local(lq_aim), kr)
            relq = qmul(qinv(cq0[0]), gun_q); relp = qrot(qinv(cq0[0]), gun_p - cp0[0])
            cq, cp = A.chest_frame(rig.sk, gq, root)
            gqg = qmul(cq, relq[None]); gpg = cp + qrot(cq, np.broadcast_to(relp, (F, 3)))
            gpos = fk_global(rig.sk, gq, root)
            gqa, err = A.rifle_overlay(rig, gq, root, gqg, gpg, poleR=gpos[:, I['RightArm']] + [-0.5, -0.35, -0.2], poleL=gpos[:, I['LeftArm']] + [0.15, -0.8, 0.1])
            if want('aim_crouch'):
                out['aim_crouch'] = to_clip('aim_crouch', rig, gqa, root, True, notes=f'kneeling aim; butt err {eerr:.3f}; ik err {err}')
            if want('reload_crouch'):
                out['reload_crouch'] = reload_clip(rig, 'reload_crouch', lq_aim, kr, relq, relp, legs=lambda g, r: kneel_legs(rig, g, r, kfeet))
        if want('suppressed_cower'):
            F = 3 * FPS + 1
            lq = np.repeat(rig.local(kq), F, 0); root = np.repeat(kr, F, 0) - [0, 0.04, 0]
            for b, e in (('LowerBack', (14, 0, 0)), ('Spine', (16, 0, 0)), ('Spine1', (14, 0, 0)), ('Neck', (22, 0, 0)), ('Head', (18, 0, 0)),
                         ('LeftShoulder', (0, 10, -8)), ('RightShoulder', (0, -10, 8))):
                C.add_local(rig, lq, b, lambda f, e=e: e)
            rng = np.random.default_rng(3)
            tremor = np.convolve(rng.standard_normal(F + 8), np.ones(5) / 5, 'same')[:F]
            tremor -= np.linspace(tremor[0], tremor[-1], F)
            C.add_local(rig, lq, 'Spine1', lambda f: (1.2 * tremor, 0.8 * tremor, 0 * f))
            C.add_local(rig, lq, 'Head', lambda f: (2.0 * osc(F, 2), 6 * osc(F, 1, 1), 0 * f))
            lq = C.breathing(rig, lq, F, 3, 1.5)
            gq = rig.global_from_local(lq)
            gq = kneel_legs(rig, gq, root, kfeet)
            gq2, err = C.carry(rig, gq, root, 'cower')
            out['suppressed_cower'] = to_clip('suppressed_cower', rig, gq2, root, True, notes=f'kneeling, hunched, head down, rifle clutched; ik err {err}')
    if want('reload_stand'):
        gq1, root1, feet = stance(rig, 1, drop=0.03, hip_yaw=-24, spine=(5, 6, 5, 6), lfoot=(0.14, 0.13), rfoot=(-0.12, -0.11), lyaw=-18, ryaw=-38, head=(0, 6))
        gq1 = plant_feet(rig, gq1, root1, feet)
        lq1 = rig.local(gq1)
        lq_aim, gun_q, gun_p, eerr = C.solve_aim(rig, lm, lq1, root1)
        cq0, cp0 = A.chest_frame(rig.sk, rig.global_from_local(lq_aim), root1)
        relq = qmul(qinv(cq0[0]), gun_q); relp = qrot(qinv(cq0[0]), gun_p - cp0[0])
        out['reload_stand'] = reload_clip(rig, 'reload_stand', lq_aim, root1, relq, relp, legs=lambda g, r: plant_feet(rig, g, r, feet))
    # ---------------- prone family
    if any(want(n) for n in ('prone_idle', 'aim_prone', 'prone_crawl')):
        pq, pr = prone(rig)
        if want('aim_prone'):
            lq_aim, gun_q, gun_p, eerr = C.solve_aim(rig, lm, rig.local(pq), pr, pocket=np.array([-0.10, 1.43, 0.13]))
            F = 3 * FPS + 1
            lq = np.repeat(lq_aim, F, 0); root = np.repeat(pr, F, 0)
            lq = C.breathing(rig, lq, F, 1, 0.6)
            gq = rig.global_from_local(lq)
            cq0, cp0 = A.chest_frame(rig.sk, rig.global_from_local(lq_aim), pr)
            relq = qmul(qinv(cq0[0]), gun_q); relp = qrot(qinv(cq0[0]), gun_p - cp0[0])
            cq, cp = A.chest_frame(rig.sk, gq, root)
            gqg = qmul(cq, relq[None]); gpg = cp + qrot(cq, np.broadcast_to(relp, (F, 3)))
            gpos = fk_global(rig.sk, gq, root)
            gqa, err = A.rifle_overlay(rig, gq, root, gqg, gpg, poleR=gpos[:, I['RightArm']] + [-0.4, -0.6, 0.1], poleL=gpos[:, I['LeftArm']] + [0.3, -0.6, 0.1])
            out['aim_prone'] = to_clip('aim_prone', rig, gqa, root, True, notes=f'prone aim, elbows down; butt err {eerr:.3f}; ik err {err}')
        if want('prone_idle'):
            F = 4 * FPS + 1
            lq = np.repeat(rig.local(pq), F, 0); root = np.repeat(pr, F, 0)
            C.add_local(rig, lq, 'Spine1', lambda f: (6 + 0 * f, 0 * f, 0 * f))
            C.add_local(rig, lq, 'Neck', lambda f: (10 + 0 * f, 0 * f, 0 * f))
            C.add_local(rig, lq, 'Head', lambda f: (0 * f, 12 * osc(F, 1, 0.3), 0 * f))
            lq = C.breathing(rig, lq, F, 1, 1.0)
            gq = rig.global_from_local(lq)
            p, q = np.array([-0.05, 1.20, 0.33]), qeuler(x=-12, y=6, order='YXZ')
            gun_q, gun_p = A.gun_in_chest(rig.sk, gq, root, p, q)
            gpos = fk_global(rig.sk, gq, root)
            gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, poleR=gpos[:, I['RightArm']] + [-0.4, -0.6, 0.1], poleL=gpos[:, I['LeftArm']] + [0.3, -0.6, 0.1])
            out['prone_idle'] = to_clip('prone_idle', rig, gq2, root, True, notes=f'prone, rifle held in front; ik err {err}')
        if want('prone_crawl'):
            out['prone_crawl'] = prone_crawl(rig, pq, pr)
    if want('wounded_crawl'):
        pq, pr = prone(rig)
        out['wounded_crawl'] = prone_crawl(rig, pq, pr, wounded=True)
    if want('wounded_ground'):
        out['wounded_ground'] = wounded_ground(rig)
    if want('hit_react'):
        out['hit_react'] = hit_react(rig)
    if want('death_crumple'):
        out['death_crumple'] = death_crumple(rig)
    if want('death_front'):
        out['death_front'] = death_front_authored(rig)
    if want('death_back'):
        out['death_back'] = mocap_death(rig, 'death_back', '90_18', 0.35, 3.2, carry_until=0.15)
    if want('throw_grenade'):
        out['throw_grenade'] = throw(rig)
    if want('drag_wounded'):
        gq, root = C.mocap(rig, '81_08', 6.0, 11.4)
        gq, root = C.face_forward(rig, gq, root)
        gq, root = C.rotate_y(gq, root, np.pi)  # walking backwards: face the body, travel toward -Z
        root = C.ground_fix(rig, gq, root)
        a, p = C.find_cycle(rig, gq, root, 30, 90)
        gq, root, stride = C.make_loop(gq, root, a, p)
        sp = float(np.hypot(stride[0], stride[2]) / (p / FPS))
        root = C.strip_root(root)
        lq = rig.local(gq)
        for side in ('Left', 'Right'):
            rig.finger_curl(lq, side, 70, 80, 30)
        out['drag_wounded'] = to_clip('drag_wounded', rig, rig.global_from_local(lq), root, True, -sp,
                                      notes=f'CMU 81_08 drag heavy object (walking backwards, hands gripping); rifle slung on back; cycle {(a, p)}')
    return out


# ------------------------------------------------------------------ pose builders
def kneel(rig, F, knee=(-0.10, 0.075, -0.02), lfoot=(0.15, 0.40)):
    """kneeling on the right knee, left foot forward.  returns gq, root, feet-spec"""
    I = rig.I
    lq, root = rig.rest(F)
    lq[:, I['Hips']] = qeuler(0, -18, 0, order='YXZ')
    lq[:, I['LowerBack']] = qeuler(4, 6, 0, order='YXZ')
    lq[:, I['Spine']] = qeuler(5, 5, 0, order='YXZ')
    lq[:, I['Spine1']] = qeuler(3, 4, 0, order='YXZ')
    lq[:, I['Neck']] = qeuler(-4, 2, 0, order='YXZ')
    K = np.array(knee)
    L1 = np.linalg.norm(rig.sk.head[I['RightLeg']] - rig.sk.head[I['RightUpLeg']])
    gq = rig.global_from_local(lq)
    off = qrot(gq[0, I['Hips']], rig.sk.head[I['RightUpLeg']] - rig.sk.head[I['Hips']])
    # thigh leaning slightly forward (hip behind knee by 6 cm)
    hip = K + np.array([0, np.sqrt(L1 ** 2 - 0.06 ** 2 - 0.0 ** 2), -0.06])
    root[:] = hip - off
    gq = rig.global_from_local(lq)
    return gq, root, dict(knee=K, lfoot=lfoot)


def kneel_legs(rig, gq, root, spec):
    I = rig.I
    K = spec['knee']
    L2 = np.linalg.norm(rig.sk.head[I['RightFoot']] - rig.sk.head[I['RightLeg']])
    ank = K + np.array([-0.01, 0.07, -np.sqrt(L2 ** 2 - 0.07 ** 2)])
    gq = C.leg_ik(rig, gq, root, 'Right', ank, K + [0, -0.3, 0.5], foot_q=qeuler(62, -10, 0, order='YXZ'))
    ay = rig.sk.head[I['LeftFoot'], 1]
    lf = np.array([spec['lfoot'][0], ay, spec['lfoot'][1]])
    gq = C.leg_ik(rig, gq, root, 'Left', lf, lf + [0.1, 0.6, 0.4], foot_q=qeuler(0, -12, 0, order='YXZ'))
    return gq


def prone(rig):
    """lying on the belly, chest propped (gear), legs apart, toes down"""
    I = rig.I
    lq, root = rig.rest(1)
    lq[:, I['Hips']] = qeuler(86, -6, 0, order='YXZ')
    lq[:, I['LowerBack']] = qeuler(-6, 0, 0, order='YXZ')
    lq[:, I['Spine']] = qeuler(-10, 0, 0, order='YXZ')
    lq[:, I['Spine1']] = qeuler(-14, 0, 0, order='YXZ')
    lq[:, I['Neck']] = qeuler(-26, 0, 0, order='YXZ')
    lq[:, I['Head']] = qeuler(-14, 0, 0, order='YXZ')
    lq[:, I['LeftUpLeg']] = qeuler(-2, 6, 12, order='YXZ')
    lq[:, I['RightUpLeg']] = qeuler(-2, -6, -14, order='YXZ')
    lq[:, I['LeftLeg']] = qeuler(6, 0, 0, order='YXZ')
    lq[:, I['RightLeg']] = qeuler(10, 0, 0, order='YXZ')
    lq[:, I['LeftFoot']] = qeuler(55, -15, 0, order='YXZ')
    lq[:, I['RightFoot']] = qeuler(55, 15, 0, order='YXZ')
    root[:] = [0.0, 0.17, 0.0]
    gq = rig.global_from_local(lq)
    # drop the body so the lowest point (knees/toes/pelvis front) touches the ground
    gp = fk_global(rig.sk, gq, root)
    low = min(gp[0, I['LeftLeg'], 1] - 0.06, gp[0, I['RightLeg'], 1] - 0.06, gp[0, I['LeftToeBase'], 1] - 0.02)
    root[:, 1] -= low
    return gq, root


def reload_clip(rig, name, lq_aim, root1, relq, relp, legs, dur=2.6):
    """magazine change from the aim pose: gun lowers & cants, left hand: mag out -> pouch -> new mag in ->
    charging handle -> back to handguard"""
    I = rig.I
    F = int(dur * FPS) + 1
    t = np.arange(F) / FPS
    lq = np.repeat(lq_aim, F, 0); root = np.repeat(root1, F, 0)
    # head relaxes off the stock, looks at the weapon
    lift = smooth_(np.clip(t / 0.3, 0, 1)) * (1 - smooth_(np.clip((t - 2.25) / 0.3, 0, 1)))
    C.add_local(rig, lq, 'Head', lambda f: (8 * lift, 6 * lift, 8 * lift))
    C.add_local(rig, lq, 'Neck', lambda f: (-6 * lift, 0 * f, 0 * f))
    gq = rig.global_from_local(lq)
    gq = legs(gq, root)
    cq, cp = A.chest_frame(rig.sk, gq, root)
    gq_aim = qmul(cq, relq[None]); gp_aim = cp + qrot(cq, np.broadcast_to(relp, (F, 3)))
    # lowered & canted gun pose (relative to the aim pose)
    low_q = qeuler(x=10, y=4, z=-30, order='YXZ')
    gq_low = qmul(gq_aim, low_q[None])
    gp_low = gp_aim + qrot(cq, np.broadcast_to(np.array([0.04, -0.10, -0.05]), (F, 3)))
    wgun = lift
    gun_q = qslerp(gq_aim, gq_low, wgun)
    gun_p = gp_aim * (1 - wgun[:, None]) + gp_low * wgun[:, None]
    gun = A.GUN['ak74m']
    HL = rig.hand['Left']
    RL = qfrom_mat(rig.gunL @ HL['F'].T)
    # key positions for the left palm (gun space or chest space) and the matching hand rotations
    mag_g = np.array([0, -0.03, 0.09])           # on the magazine, gun space
    ch_g = np.array([-0.045, 0.09, 0.12])        # charging handle (right side), gun space
    pouch_c = np.array([0.02, 1.16, 0.24])       # front mag pouch, bind-pose chest space
    s_rest = rig.sk.head[I['Spine1']]
    def gun_pt(pg):
        return gun_p + qrot(gun_q, np.broadcast_to(pg, (F, 3)))
    pts = {
        'grip': gun_pt(gun['grip_L'] + [0, -0.018, 0]),
        'mag': gun_pt(mag_g),
        'pouch': cp + qrot(cq, np.broadcast_to(pouch_c - s_rest, (F, 3))),
        'ch': gun_pt(ch_g),
    }
    rots = {
        'grip': qmul(gun_q, RL[None]),
        'mag': qmul(gun_q, qeuler(0, 0, 90, order='YXZ')[None]),
        'pouch': qmul(cq, qeuler(70, 0, 80, order='YXZ')[None]),
        'ch': qmul(gun_q, qeuler(0, 80, 0, order='YXZ')[None]),
    }
    seq = [(0.0, 'grip'), (0.35, 'grip'), (0.6, 'mag'), (0.8, 'mag'), (1.15, 'pouch'), (1.35, 'pouch'), (1.7, 'mag'), (1.85, 'mag'),
           (2.05, 'ch'), (2.2, 'ch'), (2.5, 'grip'), (dur, 'grip')]
    tgt = np.zeros((F, 3)); rot = np.zeros((F, 4))
    kt = np.array([s for s, _ in seq])
    for f in range(F):
        j = min(np.searchsorted(kt, t[f], side='right') - 1, len(seq) - 2)
        w = smooth_(np.clip((t[f] - kt[j]) / max(kt[j + 1] - kt[j], 1e-6), 0, 1))
        a, b = seq[j][1], seq[j + 1][1]
        # rack: pull back along -Z of the gun between 2.05 and 2.2
        tgt[f] = pts[a][f] * (1 - w) + pts[b][f] * w
        rot[f] = qslerp(rots[a][f], rots[b][f], w)
        if 2.05 <= t[f] <= 2.2:
            tgt[f] += qrot(gun_q[f], np.array([0, 0, -0.08 * np.sin((t[f] - 2.05) / 0.15 * np.pi)]))
    # convert palm targets to the overlay's 'target' mode (palm position)
    gpos = fk_global(rig.sk, gq, root)
    gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, left='target', left_target=tgt, left_rot=rot,
                               poleR=gpos[:, I['RightArm']] + [-0.5, -0.4, -0.2], poleL=gpos[:, I['LeftArm']] + [0.2, -0.8, 0.0])
    return to_clip(name, rig, gq2, root, False, notes=f'mag change: magazine leaves gun at 0.70 s (attach to mag_socket_L), new mag in at 1.80 s, charging handle 2.05-2.2 s; ik err {err}')


def prone_crawl(rig, pq, pr, wounded=False, dur=1.6):
    """elbow crawl (rifle cradled) or wounded crawl (no rifle, arms pulling, right leg dragged)"""
    I = rig.I
    F = int(dur * FPS) + 1
    ph = 2 * np.pi * np.arange(F) / (F - 1)
    lq = np.repeat(rig.local(pq), F, 0); root = np.repeat(pr, F, 0).copy()
    s = np.sin(ph); c = np.cos(ph)
    # body undulation: hips & chest yaw/roll alternate
    C.add_local(rig, lq, 'Hips', lambda f: (0 * s, 7 * s, 4 * c))
    C.add_local(rig, lq, 'Spine', lambda f: (0 * s, -5 * s, -3 * c))
    C.add_local(rig, lq, 'Spine1', lambda f: (0 * s, -4 * s, -3 * c))
    C.add_local(rig, lq, 'Head', lambda f: (0 * s, 4 * s, 0 * s))
    # legs: left knee draws up and pushes; right leg alternates (or drags if wounded)
    kl = np.clip(s, 0, 1)
    kr = np.clip(-s, 0, 1)
    C.add_local(rig, lq, 'LeftUpLeg', lambda f: (-15 * kl, 55 * kl, 40 * kl))
    C.add_local(rig, lq, 'LeftLeg', lambda f: (65 * kl, 0 * s, 0 * s))
    if not wounded:
        C.add_local(rig, lq, 'RightUpLeg', lambda f: (-15 * kr, -55 * kr, -40 * kr))
        C.add_local(rig, lq, 'RightLeg', lambda f: (65 * kr, 0 * s, 0 * s))
    else:
        C.add_local(rig, lq, 'RightUpLeg', lambda f: (0 * s, 0 * s, -6 + 3 * s))
        C.add_local(rig, lq, 'RightFoot', lambda f: (-30 + 0 * s, 25 + 0 * s, 0 * s))
        C.add_local(rig, lq, 'Neck', lambda f: (6 * c, 0 * s, 0 * s))
    root[:, 0] += 0.025 * s
    root[:, 1] += 0.01 * np.abs(s)
    gq = rig.global_from_local(lq)
    speed = 0.35 if not wounded else 0.22
    if not wounded:
        p, q = np.array([-0.04, 1.22, 0.30]), qeuler(x=-10, y=12, order='YXZ')
        gun_q, gun_p = A.gun_in_chest(rig.sk, gq, root, p, q)
        # gun is pushed forward / pulled with the elbows
        gun_p = gun_p + np.stack([0 * s, 0 * s, 0.05 * s], 1)
        gpos = fk_global(rig.sk, gq, root)
        gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, poleR=gpos[:, I['RightArm']] + [-0.5, -0.5, 0.0], poleL=gpos[:, I['LeftArm']] + [0.5, -0.5, 0.0])
        return to_clip('prone_crawl', rig, gq2, root, True, speed, notes=f'authored elbow (low) crawl, rifle cradled; ik err {err}')
    # wounded: arms alternately reach forward and pull (palm targets on the ground, world space)
    gpos = fk_global(rig.sk, gq, root)
    lq_ref = rig.sk.local_from_global(gq)
    for side, sgn, phs in (('Left', 1, 0.0), ('Right', -1, np.pi)):
        u = (ph + phs) % (2 * np.pi) / (2 * np.pi)
        reach = np.where(u < 0.35, smooth_(u / 0.35), 1 - smooth_((u - 0.35) / 0.65))
        lift = np.sin(np.clip(u / 0.35, 0, 1) * np.pi) * (u < 0.35)
        sh = gpos[:, I[side + 'Arm']]
        tgt = np.stack([sh[:, 0] + sgn * 0.12, 0.05 + 0.08 * lift, sh[:, 2] + 0.12 + 0.30 * reach - speed * dur * (u - 0.5) * 0], 1)
        HL = rig.hand[side]
        palm_down = qfrom_mat(np.stack([np.array([0, 0, 1.0]), np.array([-sgn * 1.0, 0, 0]), np.array([0, -1.0, 0])], 1) @ HL['F'].T)
        wrist = tgt - qrot(np.broadcast_to(palm_down, (F, 4)), np.broadcast_to(HL['palm'] - HL['wrist'], (F, 3)))
        rig.two_bone(gq, gpos, side + 'Arm', side + 'ForeArm', side + 'Hand', wrist, sh + [sgn * 0.5, 0.3, -0.2], end_rot=np.broadcast_to(palm_down, (F, 4)).copy())
    gq = rig.recompute_desc(lq_ref, gq, {'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'})
    lq = rig.local(gq)
    for side in ('Left', 'Right'):
        rig.finger_curl(lq, side, 35, 40, 10)
    return to_clip('wounded_crawl', rig, rig.global_from_local(lq), root, True, speed, notes='authored: wounded crawl, arms pulling, left leg pushing, right leg dragged; no weapon in hands')


def wounded_ground(rig, dur=4.0):
    """lying on the back, knees up, hands pressing the abdomen, writhing"""
    I = rig.I
    F = int(dur * FPS) + 1
    lq, root = rig.rest(F)
    lq[:, I['Hips']] = qeuler(-84, 0, 8, order='YXZ')
    lq[:, I['LowerBack']] = qeuler(10, 0, 0, order='YXZ')
    lq[:, I['Spine']] = qeuler(10, 0, 0, order='YXZ')
    lq[:, I['Spine1']] = qeuler(8, 0, 0, order='YXZ')
    lq[:, I['Neck']] = qeuler(18, 0, 0, order='YXZ')
    lq[:, I['Head']] = qeuler(8, 10, 0, order='YXZ')
    lq[:, I['LeftUpLeg']] = qeuler(-70, -8, 10, order='YXZ')
    lq[:, I['LeftLeg']] = qeuler(95, 0, 0, order='YXZ')
    lq[:, I['LeftFoot']] = qeuler(-20, 0, 0, order='YXZ')
    lq[:, I['RightUpLeg']] = qeuler(-25, 8, -12, order='YXZ')
    lq[:, I['RightLeg']] = qeuler(35, 0, 0, order='YXZ')
    lq[:, I['RightFoot']] = qeuler(20, 0, 0, order='YXZ')
    ph = 2 * np.pi * np.arange(F) / (F - 1)
    C.add_local(rig, lq, 'Hips', lambda f: (0 * ph, 0 * ph, 9 * np.sin(ph) + 3 * np.sin(2 * ph)))
    C.add_local(rig, lq, 'Spine1', lambda f: (5 * np.clip(np.sin(2 * ph), 0, 1) ** 2, 4 * np.sin(ph + 1), 0 * ph))
    C.add_local(rig, lq, 'Head', lambda f: (6 * np.sin(2 * ph + 0.5), 18 * np.sin(ph + 0.8), 0 * ph))
    C.add_local(rig, lq, 'LeftUpLeg', lambda f: (8 * np.sin(ph + 2), 0 * ph, 6 * np.sin(ph)))
    C.add_local(rig, lq, 'LeftLeg', lambda f: (-10 * np.sin(ph + 2), 0 * ph, 0 * ph))
    C.add_local(rig, lq, 'RightUpLeg', lambda f: (-10 * np.clip(np.sin(ph + 3.5), 0, 1), 0 * ph, 0 * ph))
    C.add_local(rig, lq, 'RightLeg', lambda f: (20 * np.clip(np.sin(ph + 3.5), 0, 1), 0 * ph, 0 * ph))
    lq = C.breathing(rig, lq, F, 6, 2.5)
    root[:, :] = [0, 0.15, 0]
    gq = rig.global_from_local(lq)
    # hands pressing on the lower belly (right) and over it (left)
    gpos = fk_global(rig.sk, gq, root)
    lq_ref = rig.sk.local_from_global(gq)
    hips_q = gq[:, I['Hips']]; hp = gpos[:, I['Hips']]
    for side, sgn, off in (('Right', -1, np.array([-0.04, 0.10, 0.13])), ('Left', 1, np.array([0.05, 0.13, 0.15]))):
        tgt = hp + qrot(hips_q, np.broadcast_to(off, (F, 3)))
        tgt += np.stack([0 * ph, 0 * ph, 0.01 * np.sin(3 * ph)], 1)
        HL = rig.hand[side]
        # palm facing the body (down onto the belly): palm normal = -body front
        bodyf = qrot(hips_q, np.broadcast_to([0, 0, 1.0], (F, 3)))
        bodyu = qrot(hips_q, np.broadcast_to([0, 1.0, 0], (F, 3)))
        rots = []
        for f in range(F):
            h = -sgn * np.cross(bodyu[f], bodyf[f]); p = -bodyf[f]
            t = np.cross(h, p) if side == 'Right' else np.cross(p, h)
            rots.append(qfrom_mat(np.stack([h, t, p], 1) @ HL['F'].T))
        rots = np.array(rots)
        wrist = tgt - qrot(rots, np.broadcast_to(HL['palm'] - HL['wrist'], (F, 3)))
        rig.two_bone(gq, gpos, side + 'Arm', side + 'ForeArm', side + 'Hand', wrist, gpos[:, I[side + 'Arm']] + sgn * np.array([0.6, 0, 0]) + [0, 0.2, 0], end_rot=rots)
    gq = rig.recompute_desc(lq_ref, gq, {'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'})
    lq = rig.local(gq)
    for side in ('Left', 'Right'):
        rig.finger_curl(lq, side, 25, 35, 10)
    gq = rig.global_from_local(lq)
    # ground the body
    gp = fk_global(rig.sk, gq, root)
    root[:, 1] -= np.percentile(gp[:, I['Spine1'], 1] - 0.13, 10)
    return to_clip('wounded_ground', rig, gq, root, True, notes='authored: on the back, hands pressing abdomen wound, knees drawn, writhing & laboured breathing; no weapon')


def hit_react(rig, dur=0.8):
    I = rig.I
    F = int(dur * FPS) + 1
    t = np.arange(F) / FPS
    gq, root, feet = stance(rig, F)
    lq = rig.local(gq)
    imp = np.where(t < 0.08, smooth_(t / 0.08), np.exp(-(t - 0.08) / 0.18)) * (1 - smooth_(np.clip((t - 0.6) / 0.2, 0, 1)))
    C.add_local(rig, lq, 'Spine', lambda f: (-9 * imp, 10 * imp, 4 * imp))
    C.add_local(rig, lq, 'Spine1', lambda f: (-10 * imp, 12 * imp, 5 * imp))
    C.add_local(rig, lq, 'Neck', lambda f: (14 * imp, -6 * imp, 0 * imp))
    C.add_local(rig, lq, 'Head', lambda f: (10 * imp, -8 * imp, 6 * imp))
    C.add_local(rig, lq, 'Hips', lambda f: (-4 * imp, 6 * imp, 0 * imp))
    root = root.copy(); root[:, 2] -= 0.06 * imp; root[:, 1] -= 0.04 * imp
    gq = rig.global_from_local(lq)
    gq = plant_feet(rig, gq, root, feet)
    p, q = C.gun_rest('low_ready')
    gun_q, gun_p = A.gun_in_chest(rig.sk, gq, root, p, q)
    gun_q = qmul(gun_q, np.array([qeuler(-10 * k, 0, 15 * k, order='YXZ') for k in imp]))
    gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p)
    return to_clip('hit_react', rig, gq2, root, False, notes='authored flinch (impact at 0.05 s), ends in idle stance')


def keyed_death(rig, name, keys, dur, notes):
    """keys: (t, pose, ease) with ease 'in' (gravity, accelerating) or 'out'/'io'; ground clamp keeps joints above floor"""
    I = rig.I
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    L = [C.pose_lq(rig, p)[0][0] for _, p, _ in keys]
    Rt = [C.pose_lq(rig, p)[1][0] for _, p, _ in keys]
    kt = np.array([k for k, _, _ in keys])
    lq = np.zeros((F, rig.n, 4)); root = np.zeros((F, 3))
    for f in range(F):
        j = min(max(np.searchsorted(kt, t[f], side='right') - 1, 0), len(kt) - 1)
        if j >= len(kt) - 1:
            lq[f] = L[-1]; root[f] = Rt[-1]; continue
        w = np.clip((t[f] - kt[j]) / (kt[j + 1] - kt[j]), 0, 1)
        e = keys[j + 1][2]
        w = w * w if e == 'in' else (1 - (1 - w) ** 2 if e == 'out' else smooth_(w))
        lq[f] = qslerp(L[j], L[j + 1], w)
        root[f] = Rt[j] * (1 - w) + Rt[j + 1] * w
    gq = rig.global_from_local(lq)
    gp = fk_global(rig.sk, gq, root)
    clear = np.full(rig.n, 0.05)
    for b in ('Hips', 'LowerBack', 'Spine', 'Spine1', 'Neck', 'Neck1', 'Head'):
        clear[I[b]] = 0.11
    for b in ('LeftShoulder', 'RightShoulder', 'LeftUpLeg', 'RightUpLeg'):
        clear[I[b]] = 0.08
    pen = np.max(clear[None] - gp[:, :, 1], axis=1)
    root[:, 1] += np.maximum(pen, 0)
    lq = rig.local(gq)
    for side in ('Left', 'Right'):
        rig.finger_curl(lq, side, 25, 35, 5)
    return to_clip(name, rig, rig.global_from_local(lq), root, False, root_motion=True, notes=notes)


def _stand():
    return dict(root=np.array([0, 0.972, 0.006]), Hips=(0, -8, 0), Spine=(3, 4, 0), Spine1=(3, 3, 0))


def death_crumple(rig, dur=2.2):
    keys = [
        (0.0, _stand(), 'io'),
        (0.12, dict(root=np.array([0, 0.965, -0.01]), Hips=(-3, -8, 0), Spine=(-4, 4, 3), Spine1=(-6, 3, 4), Head=(-10, 0, 5), LeftArm=(-8, 0, 0), RightArm=(-8, 0, 0)), 'out'),
        (0.42, dict(root=np.array([0.0, 0.76, 0.03]), Hips=(14, -6, -4), Spine=(10, 0, -3), Spine1=(8, 0, -3), Neck=(10, 0, 0), Head=(14, 6, 0),
                    LeftUpLeg=(-40, 0, 0), LeftLeg=(70, 0, 0), LeftFoot=(-22, 0, 0), RightUpLeg=(-36, 0, 0), RightLeg=(62, 0, 0), RightFoot=(-20, 0, 0),
                    LeftArm=(12, 0, 4), RightArm=(12, 0, -4)), 'in'),
        (0.72, dict(root=np.array([0.02, 0.43, 0.08]), Hips=(25, -4, -10), Spine=(10, 0, -4), Spine1=(10, 0, -4), Neck=(20, 0, 0), Head=(14, 10, 0),
                    LeftUpLeg=(-45, 0, 6), LeftLeg=(100, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-40, 0, -6), RightLeg=(96, 0, 0), RightFoot=(30, 0, 0),
                    LeftArm=(30, 0, 6), RightArm=(30, 0, -6)), 'in'),
        (1.05, dict(root=np.array([0.16, 0.24, 0.20]), Hips=(30, 0, -55), Spine=(12, 0, -6), Spine1=(10, 0, -6), Neck=(12, 0, -10), Head=(8, 10, -14),
                    LeftUpLeg=(-55, 0, 6), LeftLeg=(95, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-50, 0, -4), RightLeg=(85, 0, 0), RightFoot=(30, 0, 0),
                    LeftArm=(10, 0, 40), RightArm=(-20, 0, -10)), 'in'),
        (1.3, dict(root=np.array([0.26, 0.17, 0.26]), Hips=(14, 0, -86), Spine=(14, 0, 0), Spine1=(10, 0, 0), Neck=(8, 0, -14), Head=(4, 10, -16),
                   LeftUpLeg=(-55, 0, 4), LeftLeg=(80, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-48, 0, 0), RightLeg=(70, 0, 0), RightFoot=(30, 0, 0),
                   LeftArm=(-40, 0, 30), LeftForeArm=(0, 0, 0), RightArm=(-45, 0, 0), RightForeArm=(-20, 0, 0)), 'in'),
        (1.5, dict(root=np.array([0.27, 0.18, 0.27]), Hips=(14, 0, -84), Spine=(16, 0, 2), Spine1=(12, 0, 2), Neck=(10, 0, -16), Head=(4, 12, -20),
                   LeftUpLeg=(-56, 0, 4), LeftLeg=(82, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-50, 0, 0), RightLeg=(74, 0, 0), RightFoot=(30, 0, 0),
                   LeftArm=(-40, 0, 32), RightArm=(-50, 0, 4), RightForeArm=(-24, 0, 0)), 'out'),
        (dur, dict(root=np.array([0.27, 0.17, 0.27]), Hips=(14, 0, -86), Spine=(16, 0, 2), Spine1=(12, 0, 2), Neck=(10, 0, -18), Head=(4, 12, -22),
                   LeftUpLeg=(-56, 0, 4), LeftLeg=(82, 0, 0), LeftFoot=(30, 0, 0), RightUpLeg=(-50, 0, 0), RightLeg=(74, 0, 0), RightFoot=(30, 0, 0),
                   LeftArm=(-40, 0, 32), RightArm=(-52, 0, 4), RightForeArm=(-26, 0, 0)), 'io'),
    ]
    return keyed_death(rig, 'death_crumple', keys, dur, 'authored: flinch, knees buckle, drops to the knees, tips onto the left side; root motion kept; ends at rest; drop weapon ~0.3 s')


def death_front_authored(rig, dur=2.0):
    keys = [
        (0.0, _stand(), 'io'),
        (0.1, dict(root=np.array([0, 0.975, 0.0]), Hips=(-4, -8, 0), Spine=(-6, 6, 0), Spine1=(-8, 4, 0), Head=(-12, 0, 0), LeftArm=(-12, 0, 8), RightArm=(-12, 0, -8)), 'out'),
        (0.35, dict(root=np.array([0, 0.82, 0.08]), Hips=(18, -4, 0), Spine=(12, 0, 0), Spine1=(10, 0, 0), Neck=(10, 0, 0), Head=(10, 0, 0),
                    LeftUpLeg=(-30, 0, 0), LeftLeg=(50, 0, 0), LeftFoot=(-12, 0, 0), RightUpLeg=(-22, 0, 0), RightLeg=(40, 0, 0), RightFoot=(-10, 0, 0),
                    LeftArm=(18, 0, 6), RightArm=(18, 0, -6)), 'in'),
        (0.62, dict(root=np.array([0, 0.52, 0.30]), Hips=(48, 0, 4), Spine=(10, 0, 0), Spine1=(8, 0, 0), Neck=(0, 0, 0), Head=(-10, 20, 0),
                    LeftUpLeg=(-40, 0, 2), LeftLeg=(60, 0, 0), LeftFoot=(20, 0, 0), RightUpLeg=(-26, 0, -2), RightLeg=(45, 0, 0), RightFoot=(20, 0, 0),
                    LeftArm=(45, 0, 8), RightArm=(45, 0, -8)), 'in'),
        (0.86, dict(root=np.array([0.02, 0.17, 0.62]), Hips=(88, -4, 6), Spine=(0, 0, 0), Spine1=(-4, 0, 0), Neck=(-10, 0, 0), Head=(-10, 50, 0),
                    LeftUpLeg=(-4, 0, 6), LeftLeg=(14, 0, 0), LeftFoot=(50, 0, 0), RightUpLeg=(-2, 0, -6), RightLeg=(8, 0, 0), RightFoot=(50, 0, 0),
                    LeftArm=(80, 0, 10), RightArm=(85, 0, -14), RightForeArm=(0, 0, 10)), 'in'),
        (1.0, dict(root=np.array([0.02, 0.2, 0.66]), Hips=(84, -4, 6), Spine=(-4, 0, 0), Spine1=(-8, 0, 0), Neck=(-8, 0, 0), Head=(-6, 60, 0),
                   LeftUpLeg=(0, 0, 8), LeftLeg=(18, 0, 0), LeftFoot=(55, 0, 0), RightUpLeg=(0, 0, -8), RightLeg=(10, 0, 0), RightFoot=(55, 0, 0),
                   LeftArm=(80, 0, 14), RightArm=(88, 0, -16), RightForeArm=(0, 0, 10)), 'out'),
        (1.2, dict(root=np.array([0.02, 0.16, 0.67]), Hips=(88, -4, 6), Spine=(0, 0, 0), Spine1=(-2, 0, 0), Neck=(-6, 0, 0), Head=(-4, 70, 0),
                   LeftUpLeg=(0, 0, 9), LeftLeg=(16, 0, 0), LeftFoot=(55, 0, 0), RightUpLeg=(0, 0, -9), RightLeg=(8, 0, 0), RightFoot=(55, 0, 0),
                   LeftArm=(82, 0, 14), RightArm=(88, 0, -16), RightForeArm=(0, 0, 10)), 'in'),
        (dur, dict(root=np.array([0.02, 0.16, 0.67]), Hips=(88, -4, 6), Spine=(0, 0, 0), Spine1=(-2, 0, 0), Neck=(-6, 0, 0), Head=(-4, 72, 0),
                   LeftUpLeg=(0, 0, 9), LeftLeg=(16, 0, 0), LeftFoot=(55, 0, 0), RightUpLeg=(0, 0, -9), RightLeg=(8, 0, 0), RightFoot=(55, 0, 0),
                   LeftArm=(82, 0, 14), RightArm=(88, 0, -16), RightForeArm=(0, 0, 10)), 'io'),
    ]
    return keyed_death(rig, 'death_front', keys, dur, 'authored: hit, knees give, pitches forward onto the face (no hands), head turned; root motion kept; ends at rest; drop weapon ~0.2 s')


def mocap_death(rig, name, bvh, t0, t1, carry_until=0.2):
    gq, root = C.mocap(rig, bvh, t0, t1)
    # face +Z using the first frames' hip facing
    f = qrot(gq[0, 0], np.array([0, 0, 1.0])); ang = np.arctan2(f[0], f[2])
    gq, root = C.rotate_y(gq, root, -ang)
    root = root - root[0] * [1, 0, 1]
    # ground: lowest skin-ish point (joints) to ~0.06 m above ground at the end, standing feet at start
    gp = fk_global(rig.sk, gq, root)
    I = rig.I
    start_feet = min(gp[0, I['LeftFoot'], 1], gp[0, I['RightFoot'], 1])
    root[:, 1] += rig.sk.head[I['LeftFoot'], 1] - start_feet
    gp = fk_global(rig.sk, gq, root)
    low_end = np.min(gp[-1, :, 1])
    # blend vertical correction toward the end so the corpse rests on the ground
    F = len(gq)
    w = smooth_(np.linspace(0, 1, F))
    root[:, 1] -= w * (low_end - 0.07)
    # hold the final pose 0.5 s
    hold = int(0.5 * FPS)
    gq = np.concatenate([gq, np.repeat(gq[-1:], hold, 0)])
    root = np.concatenate([root, np.repeat(root[-1:], hold, 0)])
    lq = rig.local(gq)
    for side in ('Left', 'Right'):
        rig.finger_curl(lq, side, 25, 35, 5)
    return to_clip(name, rig, rig.global_from_local(lq), root, False, root_motion=True,
                   notes=f'CMU {bvh} {t0}-{t1}s, root motion kept, ends at rest; game should drop/detach the weapon at start')


def throw(rig):
    gq, root = C.mocap(rig, '113_24', 1.2, 3.6)
    f = qrot(gq[0, 0], np.array([0, 0, 1.0])); ang = np.arctan2(f[0], f[2])
    gq, root = C.rotate_y(gq, root, -ang)
    root = C.ground_fix(rig, gq, root)
    root = root - root[0] * [1, 0, 1]
    lq = rig.local(gq)
    rig.finger_curl(lq, 'Right', 45, 55, 20)
    return to_clip('throw_grenade', rig, rig.global_from_local(lq), root, False, root_motion=False,
                   notes='CMU 113_24 overhand throw; right hand is free: attach rifle to weapon_socket_L or weapon_socket_back for the duration; release ~ see manifest')



def smooth_(t):
    return t * t * (3 - 2 * t)


def write(rig, clips, path, sockets=True):
    W = AS.SoldierWriter(rig.sk, 'soldier_anims')
    g = W.g
    if sockets:
        import build_soldier as BS
        BS.add_sockets(W, rig, pickle.load(open(f'{BUILD}/body.pkl', 'rb')))
    for c in clips.values():
        F = len(c['lq'])
        t = np.arange(F) / FPS
        tracks = [(W.nodes['Hips'], 'translation', t, c['root'])]
        for i, n in enumerate(rig.sk.names):
            tracks.append((W.nodes[n], 'rotation', t, c['lq'][:, i]))
        g.animation(c['name'], tracks, extras=dict(loop=c['loop'], speed=c['speed'], root_motion=c['root_motion']))
    W.save(path)


if __name__ == '__main__':
    only = sys.argv[1:] or None
    R, rig = setup()
    t0 = time.time()
    clips = build_all(rig, R, only)
    for n, c in clips.items():
        print(n, '%.2fs' % c['dur'], 'speed %.2f' % c['speed'], c['notes'])
    path = f'{ASSETS}/soldier_anims.glb' if only is None else f'{BUILD}/anims_test.glb'
    write(rig, clips, path)
    pickle.dump({n: {k: v for k, v in c.items()} for n, c in clips.items()}, open(f'{BUILD}/clips{"_test" if only else ""}.pkl', 'wb'))
    print('done', time.time() - t0)
