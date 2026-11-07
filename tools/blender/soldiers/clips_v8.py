"""Infantry anim v8 (clips_v8.py): stance- and weapon-matched reloads.

  reload_prone      AK-74 / AK-12 magazine change lying prone (the game played the KNEELING reload for a prone man: he popped up onto
                    his knee and back).  Field technique: stay flat, roll a little onto the firing (right) side so the support hand
                    can get into the front pouches under the chest, pull the rifle back under the face and cant it (magazine to the
                    left, clear of the ground), rock the empty out, new magazine in, rack over the top, back onto the elbows.
  reload_mg_prone   PKM belt-box change behind the gun, prone (the game played the AK magazine change for the PKM: no magazine, and
                    6.5 s of reload frozen on a 2.6 s clip).  Right hand stays on the pistol grip; support hand: feed-cover latch ->
                    cover up -> strips the link remnant off the feed tray -> unlatches the empty 100-round box on the right side ->
                    new box from beside the left elbow -> box on -> belt laid on the tray -> cover slammed shut -> charging handle
                    (right side, reached under the receiver) back and forward -> handguard.
  reload_mg_crouch  the same, kneeling on the right knee (gun brought into the workspace in front of the chest).

All three start and end exactly on their aim pose (aim_prone / aim_crouch), like reload_stand / reload_crouch, so the game can cross-fade
in and out; the game time-scales them to the weapon's reload time.
Conventions as clips_combat.py (gun space: +X = the gun's left, +Y up, +Z toward the muzzle; origin = pistol grip = weapon_socket)."""
import json, os
import numpy as np
import anim as A
import clips as C
from anim import FPS, fk_global, smooth
from qmath import qmul, qrot, qeuler, qslerp, qfrom_mat
from clips_extra import add_euler, hand_q, to_clip
from clips_combat import track, pulse, set_fingers, gun_pt, ik_err, PRONE_GRIP_L

CLIPS = ('reload_prone', 'reload_mg_prone', 'reload_mg_crouch')
HERE = os.path.dirname(os.path.abspath(__file__))


def _pkm():
    if 'pkm' not in A.GUN:
        wi = json.load(open(f'{HERE}/.cache/weapons_info.json'))
        A.GUN['pkm'] = {k: np.array(v[0]) for k, v in wi['pkm']['empties'].items()}
    return A.GUN['pkm']


def _key_path(t, seq, P, Q, F, arc=None):
    """palm targets / rotations from a list of (time, key); smoothstep between keys; arc(a, b, w, f) -> extra offset"""
    kt = np.array([s for s, _ in seq])
    tgt = np.zeros((F, 3)); rot = np.zeros((F, 4))
    for f in range(F):
        j = min(np.searchsorted(kt, t[f], side='right') - 1, len(seq) - 2)
        w = smooth(np.clip((t[f] - kt[j]) / max(kt[j + 1] - kt[j], 1e-6), 0, 1))
        a, b = seq[j][1], seq[j + 1][1]
        tgt[f] = P[a][f] * (1 - w) + P[b][f] * w
        if arc is not None and a != b:
            tgt[f] += arc(a, b, w, f)
        rot[f] = qslerp(Q[a][f], Q[b][f], w)
    return tgt, rot


def _transits(t, spans, ramp=0.06):
    return np.max([smooth(np.clip((t - a) / ramp, 0, 1)) * (1 - smooth(np.clip((t - b + ramp) / ramp, 0, 1))) for a, b in spans], axis=0)


GUN_LOW_PTS = np.array([[0, -0.22, 0.17], [0, 0.084, 0.621], [0, -0.09, -0.337], [0, -0.05, 0.40]])   # AK mag bottom, muzzle, butt toe, handguard bottom


def _roll_sign(rig, base):
    """sign of a Spine 'yaw' (local Y) that raises the LEFT shoulder of the prone man (rolls him onto his right side)"""
    I = rig.I
    lq = base['lq'].copy()
    add_euler(rig, lq, 'Spine', 0, 10.0, 0)
    gp = fk_global(rig.sk, rig.global_from_local(lq), base['root'])
    return 1.0 if gp[0, I['LeftArm'], 1] > gp[0, I['RightArm'], 1] else -1.0


# ------------------------------------------------------------------ reload_prone (AK magazine change lying down)
def reload_prone(rig, base, dur=3.0):
    I = rig.I
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    T_OUT, T_IN, T_CH = 0.78, 2.05, 2.33
    lq = np.repeat(base['lq'], F, 0); root = np.repeat(base['root'], F, 0).copy()
    lift = smooth(np.clip(t / 0.35, 0, 1)) * (1 - smooth(np.clip((t - 2.55) / 0.4, 0, 1)))
    roll = pulse(t, 0.85, 0.35, 0.75) * (1 - smooth(np.clip((t - 1.75) / 0.3, 0, 1)))    # onto the right side for the pouch
    sg = _roll_sign(rig, base)
    add_euler(rig, lq, 'Hips', 0, sg * 5 * roll, 0)
    add_euler(rig, lq, 'Spine', 0, sg * 9 * roll, 0)
    add_euler(rig, lq, 'Spine1', 0, sg * 5 * roll, 0)
    # head off the stock, looking down-left at the magazine well, then at the pouch
    add_euler(rig, lq, 'Head', 12 * lift + 6 * roll, 8 * lift, 6 * lift)
    add_euler(rig, lq, 'Neck', -4 * lift, 4 * roll, 0)
    lq = C.breathing(rig, lq, F, 2, 0.5)
    gq = rig.global_from_local(lq)
    cq, cp = A.chest_frame(rig.sk, gq, root)
    gq_aim = qmul(cq, base['relq'][None]); gp_aim = cp + qrot(cq, np.broadcast_to(base['relp'], (F, 3)))
    # workspace: pulled back under the face, muzzle a little up, canted top-left (magazine out to the left, not into the ground)
    rock = pulse(t, T_OUT, 0.08, 0.15); slap = pulse(t, T_IN - 0.04, 0.04, 0.14); rack = pulse(t, T_CH - 0.04, 0.06, 0.12)
    wq = []
    for f in range(F):
        d = qmul(qeuler(x=-5, y=4, z=-32, order='YXZ'), qeuler(x=-3 * slap[f] + 2 * rack[f], y=0, z=4 * rock[f], order='YXZ'))
        wq.append(qslerp(np.array([0, 0, 0, 1.0]), d, lift[f]))
    gun_q = qmul(gq_aim, np.array(wq))
    gun_p = gp_aim + np.outer(lift, [0, 0.035, 0]) + qrot(gq_aim, np.broadcast_to([0, 0, -0.07], (F, 3))) * lift[:, None] + \
        np.outer(slap, [0, -0.01, 0]) + qrot(gun_q, np.broadcast_to([0, 0, 0.012], (F, 3))) * rack[:, None]
    # no part of the rifle into the ground (in the workspace; the ends stay exactly on the aim_prone pose)
    lowp = np.stack([gun_p + qrot(gun_q, np.broadcast_to(p, (F, 3))) for p in GUN_LOW_PTS], 1)[..., 1].min(1)
    gun_p = gun_p + np.outer(np.maximum(0.015 - lowp, 0) * lift, [0, 1.0, 0])
    gun = A.GUN['ak74m']
    RL = qfrom_mat(rig.gunL @ rig.hand['Left']['F'].T)
    gx = lambda v: qrot(gun_q, np.broadcast_to(v, (F, 3)))
    s_rest = rig.sk.head[I['Spine1']]
    pouch = cp + qrot(cq, np.broadcast_to(np.array([0.05, 1.13, 0.26]) - s_rest, (F, 3)))
    pouch[:, 1] = np.maximum(pouch[:, 1], 0.075)
    P = {
        'grip': gun_pt(gun_q, gun_p, gun['grip_L'] + PRONE_GRIP_L),
        'reach': gun_pt(gun_q, gun_p, [0.06, -0.02, 0.16]),
        'mag': gun_pt(gun_q, gun_p, [0.032, -0.055, 0.112]),
        'mag_rock': gun_pt(gun_q, gun_p, [0.034, -0.075, 0.135]),
        'pouch': pouch, 'pouch2': pouch + [0, -0.02, 0],
        'ch': gun_pt(gun_q, gun_p, [-0.045, 0.105, 0.125]),
        'ch_back': gun_pt(gun_q, gun_p, [-0.045, 0.105, 0.045]),
        'side': gun_pt(gun_q, gun_p, [0.045, 0.02, 0.24]),
    }
    q_mag = hand_q(rig, 'Left', gx([0.0, -0.55, 0.84]), gx([-1.0, 0, 0]))
    Q = {'grip': qmul(gun_q, np.broadcast_to(RL, (F, 4))), 'reach': q_mag, 'mag': q_mag,
         'mag_rock': hand_q(rig, 'Left', gx([0.0, -0.75, 0.66]), gx([-1.0, 0, 0.1])),
         # pouch under the chest: fingers forward-down into it, palm toward the body
         'pouch': hand_q(rig, 'Left', qrot(cq, np.broadcast_to([0.1, -0.85, 0.5], (F, 3))), qrot(cq, np.broadcast_to([0.2, 0.3, -1.0], (F, 3)))),
         'ch': hand_q(rig, 'Left', gx([-0.9, 0.0, 0.3]), gx([0, -1.0, 0])),
         'side': hand_q(rig, 'Left', gx([0.0, -0.25, 0.97]), gx([-1.0, 0.25, 0]))}
    Q['pouch2'] = Q['pouch']; Q['ch_back'] = Q['ch']
    seq = [(0.0, 'grip'), (0.25, 'grip'), (0.5, 'reach'), (0.63, 'mag'), (T_OUT, 'mag'), (0.9, 'mag_rock'), (1.18, 'pouch'), (1.32, 'pouch2'),
           (1.45, 'pouch'), (1.8, 'mag_rock'), (1.9, 'mag_rock'), (T_IN, 'mag'), (2.09, 'mag'), (2.27, 'ch'), (2.31, 'ch'), (2.37, 'ch_back'),
           (2.43, 'ch'), (2.6, 'side'), (2.75, 'grip'), (dur, 'grip')]
    tgt, rot = _key_path(t, seq, P, Q, F, arc=lambda a, b, w, f: qrot(cq[f], np.array([0.04, 0.0, 0.03])) * np.sin(np.pi * w) if 'pouch' in (a, b) else 0)
    tgt[:, 1] = np.maximum(tgt[:, 1], 0.06)
    gpos = fk_global(rig.sk, gq, root)
    poleR = gpos[:, I['RightArm']] + np.outer(np.ones(F), base['pR'])
    poleL = gpos[:, I['LeftArm']] + np.outer(1 - lift, base['pL']) + np.outer(lift, [0.35, -0.5, 0.15])
    gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, left='target', left_target=tgt, left_rot=rot, poleR=poleR, poleL=poleL)
    gq2 = A.smooth_locals(rig, gq2, ('LeftArm', 'LeftForeArm', 'LeftHand'), 3.0, _transits(t, ((0.81, 1.18), (1.45, 1.9), (2.09, 2.27), (2.43, 2.75))))
    lq2 = rig.local(gq2)
    curl = track([(0.0, (60, 75, 20)), (0.3, (60, 75, 20)), (0.48, (18, 22, 10)), (0.63, (55, 62, 35)), (1.16, (55, 62, 35)), (1.3, (40, 50, 25)),
                  (1.45, (55, 62, 35)), (2.1, (55, 62, 35)), (2.18, (25, 30, 15)), (2.3, (75, 85, 40)), (2.43, (75, 85, 40)), (2.58, (20, 25, 10)),
                  (2.75, (60, 75, 20)), (dur, (60, 75, 20))], t)
    set_fingers(rig, lq2, 'Left', curl)
    gq2 = rig.global_from_local(lq2)
    return to_clip('reload_prone', rig, gq2, root, False,
                   notes=f'prone magazine change from/to aim_prone: stays flat, rolls ~{14:.0f} deg onto the right side for the pouch (0.85-1.8 s), rifle '
                         f'pulled back under the face and canted top-left (magazine out to the left, rifle >= 1.5 cm off the ground), left hand rocks the '
                         f'empty out (mag_out {T_OUT} s: magazine onto mag_socket_L), to the front pouch under the chest (1.18-1.45 s: stow / draw - or drop '
                         f'the empty here for an emergency reload), new magazine rocked home (mag_in {T_IN} s, same palm pose as mag_out), racks the charging '
                         f'handle over the top ({T_CH - 0.06:.2f}-{T_CH + 0.1:.2f} s), back on the handguard at 2.75 s; ik err {ik_err(err)}',
                   events={'mag_out': T_OUT, 'mag_in': T_IN, 'charging_handle': T_CH, 'pouch': [1.18, 1.45]})


# ------------------------------------------------------------------ reload_mg_* (PKM belt box change)
def reload_mg(rig, name, base, dur):
    """PKM: right hand on the pistol grip throughout; support hand works the feed cover, box, belt and charging handle"""
    I = rig.I
    pk = _pkm()
    prone = base['kind'] == 'prone'
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    # key times (authored for 6.0 s; >= 0.3 s between hand poses of different orientation)
    if prone:
        E = dict(cover_open=0.75, box_off=1.9, new_box=2.75, box_on=3.7, belt=4.1, cover_close=4.5, charging_handle=5.0)
    else:
        E = dict(cover_open=0.85, box_off=1.95, new_box=2.7, box_on=3.5, belt=3.95, cover_close=4.4, charging_handle=4.9)
    E = {k: round(v * dur / 6.0, 3) for k, v in E.items()}
    end = dur - (0.45 if prone else 0.5)
    lq = np.repeat(base['lq'], F, 0); root = np.repeat(base['root'], F, 0).copy()
    lift = smooth(np.clip(t / (0.35 if prone else 0.6), 0, 1)) * (1 - smooth(np.clip((t - end + 0.15) / 0.4, 0, 1)))
    box = pulse(t, E['box_off'] - 0.1, 0.4, 1.2) * (1 - smooth(np.clip((t - E['box_on']) / 0.3, 0, 1)))   # attention: right side / new box at the left
    newb = pulse(t, E['box_off'] + 0.2, 0.35, 0.6)
    add_euler(rig, lq, 'Head', 14 * lift, -10 * lift * (1 - newb) + 20 * newb, -6 * lift)
    add_euler(rig, lq, 'Neck', -4 * lift, 6 * newb, 0)
    if prone:
        sg = _roll_sign(rig, base)
        add_euler(rig, lq, 'Spine', 0, sg * 6 * newb, 0)
    else:
        add_euler(rig, lq, 'Spine1', 3 * lift, 8 * newb, 0)
        add_euler(rig, lq, 'Spine', 2 * lift, 5 * newb, 0)
    lq = C.breathing(rig, lq, F, 3, 0.6)
    gq = rig.global_from_local(lq)
    if base['legs']:
        gq = base['legs'](gq, root)
    cq, cp = A.chest_frame(rig.sk, gq, root)
    gq_aim = qmul(cq, base['relq'][None]); gp_aim = cp + qrot(cq, np.broadcast_to(base['relp'], (F, 3)))
    # gun: prone - stays on the bipod line, butt off the shoulder a little, canted top-left 10 deg (right side and feed tray toward the
    # gunner's eye); kneeling - into the workspace in front of the chest
    slam = pulse(t, E['cover_close'], 0.04, 0.14); rack = pulse(t, E['charging_handle'] - 0.05, 0.08, 0.14); seat = pulse(t, E['box_on'], 0.05, 0.15)
    wq = []
    for f in range(F):
        base_d = qeuler(x=-2, y=8, z=-18, order='YXZ') if prone else qeuler(x=-6, y=8, z=-14, order='YXZ')
        d = qmul(base_d, qeuler(x=-2.5 * slam[f] + 1.5 * rack[f], y=0, z=-2 * seat[f], order='YXZ'))
        wq.append(qslerp(np.array([0, 0, 0, 1.0]), d, lift[f]))
    gun_q = qmul(gq_aim, np.array(wq))
    off = np.array([0.05, 0.02, -0.13]) if prone else np.array([0.0, -0.13, -0.04])   # prone: butt off the shoulder, gun drawn in toward the left hand
    gun_p = gp_aim + qrot(cq, np.broadcast_to(off, (F, 3))) * lift[:, None] + np.outer(slam, [0, -0.01, 0]) + \
        qrot(gun_q, np.broadcast_to([0, 0, 0.012], (F, 3))) * rack[:, None]
    if prone:
        lowp = np.stack([gun_p + qrot(gun_q, np.broadcast_to(p, (F, 3))) for p in ([0, -0.08, 0.05], [0, 0.10, 0.95], [0, -0.09, -0.337])], 1)[..., 1].min(1)
        gun_p = gun_p + np.outer(np.maximum(0.015 - lowp, 0) * lift, [0, 1.0, 0])
    gx = lambda v: qrot(gun_q, np.broadcast_to(v, (F, 3)))
    RL = qfrom_mat(rig.gunL @ rig.hand['Left']['F'].T)
    gpos = fk_global(rig.sk, gq, root)
    # new box: prone - on the ground beside the left elbow; kneeling - from the bag on the left hip
    if prone:
        nb = gpos[:, I['LeftArm']] + qrot(cq, np.broadcast_to([0.12, 0.0, 0.12], (F, 3))); nb[:, 1] = 0.085
    else:
        nb = cp + qrot(cq, np.broadcast_to(np.array([0.25, 1.0, 0.12]) - rig.sk.head[I['Spine1']], (F, 3)))
    grip_ak = A.GUN['ak74m']['grip_L'] + (PRONE_GRIP_L if prone else np.array([0, -0.018, 0]))   # = the aim clips' support-hand spot
    P = {
        'grip': gun_pt(gun_q, gun_p, grip_ak),
        'latch': gun_pt(gun_q, gun_p, [0.0, 0.165, -0.02]),           # rear of the feed cover (latch), palm on top
        'open': gun_pt(gun_q, gun_p, [0.0, 0.25, 0.06]),              # cover swung up on its front hinge
        'tray': gun_pt(gun_q, gun_p, [-0.02, 0.15, 0.11]),            # link remnant on the feed tray
        'strip': gun_pt(gun_q, gun_p, [-0.10, 0.14, 0.10]),           # ... pulled out to the right
        'box': gun_pt(gun_q, gun_p, [-0.02, -0.02, 0.135]),           # front face of the box (latch on the bracket), hand under the handguard
        'box_off': gun_pt(gun_q, gun_p, [-0.03, -0.10, 0.16]),        # empty box unhooked, pulled down / forward and let go
        'nb': nb, 'nb2': nb + [0, 0.05, 0],
        'press': gun_pt(gun_q, gun_p, [0.0, 0.17, 0.03]),             # slap the cover shut
        'lside': gun_pt(gun_q, gun_p, [0.05, 0.07, 0.10]),            # hand rolls over the left side of the receiver (under -> over)
        'ch': gun_pt(gun_q, gun_p, [-0.05, 0.045, 0.19]),            # charging handle, right side (hooked from in front, under the receiver)
        'ch_back': gun_pt(gun_q, gun_p, [-0.05, 0.045, 0.09]),
    }
    q_top = hand_q(rig, 'Left', gx([-0.2, 0.0, 1.0]), gx([0, -1.0, 0]))          # palm down on the receiver, fingers forward
    q_side = hand_q(rig, 'Left', gx([-0.4, -0.9, 0.0]), gx([0, 0, -1.0]))          # from in front: palm back on the box face / handle, fingers down-right
    Q = {'grip': qmul(gun_q, np.broadcast_to(RL, (F, 4))), 'latch': q_top, 'open': hand_q(rig, 'Left', gx([-0.2, -0.5, 1.0]), gx([0, -1.0, -0.5])),
         'tray': q_top, 'strip': q_top, 'box': q_side, 'box_off': q_side, 'press': q_top, 'ch': q_side, 'ch_back': q_side,
         # new box taken by its lid handle from above: palm down, fingers forward (same family as the receiver-top poses: no wrist flip)
         'nb': hand_q(rig, 'Left', qrot(cq, np.broadcast_to([0.1, -0.2, 1.0], (F, 3))), qrot(cq, np.broadcast_to([0.25, -1.0, 0.0], (F, 3))))}
    Q['nb2'] = Q['nb']
    Q['lside'] = hand_q(rig, 'Left', gx([0.0, -0.25, 0.97]), gx([-1.0, 0.25, 0]))
    e = E
    seq = [(0.0, 'grip'), (0.12, 'grip'), (0.34, 'lside'), (e['cover_open'] - 0.12, 'latch'), (e['cover_open'], 'latch'), (e['cover_open'] + 0.25, 'open'),
           (e['cover_open'] + 0.45, 'tray'), (e['cover_open'] + 0.62, 'tray'), (e['cover_open'] + 0.75, 'strip'),
           (e['box_off'] - 0.2, 'box'), (e['box_off'], 'box'), (e['box_off'] + 0.25, 'box_off'),
           (e['new_box'] - 0.15, 'nb'), (e['new_box'] + 0.1, 'nb'), (e['new_box'] + 0.3, 'nb2'),
           (e['box_on'] - 0.15, 'box'), (e['box_on'] + 0.1, 'box'), (e['belt'] - 0.05, 'tray'), (e['belt'] + 0.15, 'tray'),
           (e['cover_close'] - 0.15, 'open'), (e['cover_close'], 'press'), (e['cover_close'] + 0.08, 'press'),
           (e['charging_handle'] - 0.16, 'ch'), (e['charging_handle'] - 0.08, 'ch'), (e['charging_handle'] + 0.08, 'ch_back'),
           (e['charging_handle'] + 0.3, 'ch'), (end, 'grip'), (dur, 'grip')]

    def arc(a, b, w, f):
        if {a, b} & {'nb', 'nb2'} and not {a, b} <= {'nb', 'nb2'}:   # up (prone) / out in front of the belly (kneeling) to and from the new box
            return (np.array([0, 0.06, 0]) if prone else qrot(cq[f], np.array([0.04, 0.04, 0.22]))) * np.sin(np.pi * w)
        if {a, b} == {'box', 'tray'} or {a, b} == {'strip', 'box'}:
            return qrot(gun_q[f], np.array([-0.06, 0.0, 0.0])) * np.sin(np.pi * w)   # round the right side of the receiver
        return 0
    tgt, rot = _key_path(t, seq, P, Q, F, arc)
    if os.environ.get('V8_DEBUG'):          # reach of every key from the left shoulder (two-bone reach ~ L1 + L2)
        sh = gpos[:, I['LeftArm']]; reach = rig.L1['Left'] + rig.L2['Left']
        for k, v in P.items():
            print(name, k, 'reach %.2f' % (np.linalg.norm(v - sh, axis=1).max() / reach))
    if prone:
        tgt[:, 1] = np.maximum(tgt[:, 1], 0.06)
    poleR = gpos[:, I['RightArm']] + np.outer(np.ones(F), base['pR'])
    poleL = gpos[:, I['LeftArm']] + np.outer(1 - lift, base['pL']) + np.outer(lift, [0.35, -0.55, 0.1] if prone else [0.3, -0.75, 0.0])
    if not prone:     # elbow back while the hand is down at the hip pouch (the hip lies along the usual down-and-out pole: elbow flip)
        hipw = smooth(np.clip((t - e['box_off']) / 0.3, 0, 1)) * (1 - smooth(np.clip((t - e['new_box'] - 0.4) / 0.4, 0, 1)))
        poleL = poleL + np.outer(hipw, [0.0, 0.35, -0.55])
    gq2, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, left='target', left_target=tgt, left_rot=rot, poleR=poleR, poleL=poleL, gun='pkm')
    gq2 = A.smooth_locals(rig, gq2, ('LeftArm', 'LeftForeArm', 'LeftHand'), 3.0,
                          _transits(t, ((0.12, e['cover_open'] - 0.12), (e['box_off'] + 0.25, e['new_box'] - 0.15), (e['new_box'] + 0.3, e['box_on'] - 0.15),
                                        (e['charging_handle'] + 0.3, end))))
    lq2 = rig.local(gq2)
    curl = track([(0.0, (60, 75, 20)), (0.25, (60, 75, 20)), (e['cover_open'] - 0.15, (25, 30, 15)), (e['cover_open'] + 0.45, (35, 45, 20)),
                  (e['cover_open'] + 0.62, (70, 80, 40)), (e['box_off'] - 0.2, (45, 55, 30)), (e['new_box'], (65, 75, 35)), (e['box_on'] + 0.1, (65, 75, 35)),
                  (e['belt'] + 0.15, (70, 80, 40)), (e['cover_close'], (10, 15, 10)), (e['charging_handle'] - 0.1, (80, 90, 40)),
                  (e['charging_handle'] + 0.3, (80, 90, 40)), (end, (60, 75, 20)), (dur, (60, 75, 20))], t)
    set_fingers(rig, lq2, 'Left', curl)
    gq2 = rig.global_from_local(lq2)
    kind = 'prone behind the gun' if prone else 'kneeling on the right knee'
    return to_clip(name, rig, gq2, root, False,
                   notes=f'PKM belt-box change, {kind}, from/to {"aim_prone" if prone else "aim_crouch"}: right hand stays on the pistol grip; '
                         f'support hand opens the feed cover (cover_open {e["cover_open"]} s), strips the link remnant off the tray, unhooks the empty '
                         f'100-round box on the right side (box_off {e["box_off"]} s), takes a new box ({"beside the left elbow" if prone else "from the left hip"}, '
                         f'new_box {e["new_box"]} s), hooks it on (box_on {e["box_on"]} s), lays the belt on the tray (belt {e["belt"]} s), slams the cover '
                         f'(cover_close {e["cover_close"]} s), works the charging handle on the right side ({e["charging_handle"]} s), back on the '
                         f'handguard at {end:.2f} s. pkm.glb has no separate box node: the box stays drawn on the gun; ik err {ik_err(err)}',
                   events=dict(E))


def v8_clips(rig, lm, want, base_fn):
    out = {}
    if want('reload_prone'):
        out['reload_prone'] = reload_prone(rig, base_fn('prone'))
    if want('reload_mg_prone'):
        out['reload_mg_prone'] = reload_mg(rig, 'reload_mg_prone', base_fn('prone'), 6.0)
    if want('reload_mg_crouch'):
        out['reload_mg_crouch'] = reload_mg(rig, 'reload_mg_crouch', base_fn('crouch'), 6.0)
    return out
