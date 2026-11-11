"""Mounting up (the reverse of clips_vehicle.py's dismounts): riders climbing onto the deck to their seat (mount_deck_*), troops
climbing in through the BTR side door (mount_door) or stepping in at an IFV rear door (mount_rear).

CLIP FRAME = the dismount clips' (clips_vehicle.py): origin = the soldier root on the ground outboard of the seat / outside the door,
+Z = away from the hull, +X = left when facing +Z.  He STARTS at the origin facing the hull (frame 0 = idle_rifle frame 0 turned
180 deg, his root heading stays the clip's +Z) and the whole path is in the Hips track (root motion, root fixed for the clip).
mount_deck_* ends EXACTLY in ride_sit_edge frame 0 (ride_sit_deck for the T-72B3 deck seats) with the seat point at
events.seat_offset_from_root - the first frame of the matching dismount_jump_* - so the game hands over to the seated rider with no
cross-fade.  The rifle hangs on its sling while he climbs (the game slings it for mount_* clips) and is back in his hands from
events.unsling.  mount_door / mount_rear end crouched inside the hull (the game hides him then: events.inside).

Hull geometry: vehicle_geo against the current GLBs (assets/vehicles); feet on the real surfaces where there is one, otherwise on a
'virtual' step (documented per layout: a tyre shoulder / the bottom lip of a side skirt / a drum bracket the voxel top-down ray
cannot see), hands on the deck edge / sloped plate / ledge."""
import numpy as np
import anim as A
from anim import FPS, fk_global, smooth
from qmath import qmul, qrot, qaxis, qslerp
import clips_vehicle as CV

Y = np.array([0, 1.0, 0])
DECK = ('mount_deck_btr', 'mount_deck_bmp3', 'mount_deck_bradley', 'mount_deck_tank', 'mount_deck_t72b3',
        'mount_deck_rear_btr', 'mount_deck_rear_bmp3', 'mount_deck_rear_tank', 'mount_deck_rear_t72b3')
INSIDE = ('mount_door', 'mount_rear')
CLIPS = DECK + INSIDE

# vehicle space (+X = vehicle left, +Z forward); side clips authored on the right side (side -1), rear clips over the stern.
# end = the soldier root (start of the climb) in vehicle x, z; seat = the seat point he ends on; step = right-foot foothold (x, z[, y
# virtual height]); ledge = left-foot ledge before the deck (BTR chine, Bradley skirt ledge); grab0 / grab = hand line (first from
# the ground, then on the deck edge); deck = first footfall on the deck; crouch = where he crouches and turns round.
# stations: along-hull positions the side climb is tied to (BTR wheels: the game climbs at the wheel nearest the seat and slides the
# rest along the deck); fixed_x (rear): the stern climb is tied to this lateral position (BTR tow hitch), else it follows the seat.
LAYOUT = {
    'mount_deck_btr': dict(veh=('btr80_ua', 'btr82a'), side=-1, end=(-2.06, -1.16), seat=(-0.56, 1.969, -1.25), step=(-1.45, -1.08, 0.68),
                           ledge=(-1.50, -1.27), grab0=(-1.28, -1.16), grab=(-0.90, -1.16), deck=(-0.86, -1.16), crouch=(-0.30, -1.20),
                           stations=(1.95, 0.65, -1.16, -2.52), carve=[], ignore={},
                           note='BTR-80/82 side: right boot on the 3rd-axle tyre bulge (virtual step 0.68 m), left boot on the chine (1.28 m), hands on the 49 deg '
                                'upper side plate then the roof edge, onto the roof (1.93 m), turns, sits on edge seat ride_seat_3'),
    'mount_deck_bmp3': dict(veh=('bmp3',), side=-1, end=(-2.12, -1.25), seat=(-1.30, 1.697, -1.25), step=(-1.77, -1.17, 0.78),
                            grab=(-1.42, -1.25), deck=(-1.40, -1.25), crouch=(-0.92, -1.25), carve=[], ignore={},
                            note='BMP-3 side: right boot on the bottom lip of the side skirt (virtual step 0.78 m), hands on the deck edge, '
                                 'high knee onto the deck (1.70 m), turns, sits on edge seat ride_seat_1'),
    'mount_deck_bradley': dict(veh=('bradley_ua',), side=-1, end=(-2.27, -1.75), seat=(-1.30, 1.979, -1.75), step=(-1.92, -1.67, 0.72),
                               ledge=(-1.66, -1.86), grab0=(-1.66, -1.75), grab=(-1.38, -1.75), deck=(-1.36, -1.75), crouch=(-0.92, -1.75),
                               carve=[], ignore={},
                               note='Bradley side: right boot on the skirt bottom lip (virtual step 0.72 m), left boot on the skirt ledge (1.45 m), '
                                    'hands on the ledge then the roof edge, onto the roof (2.0 m), turns, sits on edge seat ride_seat_1'),
    'mount_deck_tank': dict(veh=('t72av_ua',), side=-1, end=(-2.28, -2.45), seat=(-1.42, 1.545, -2.45), step=(-1.92, -2.37, 0.62),
                            grab=(-1.55, -2.45), deck=(-1.52, -2.45), crouch=(-0.98, -2.45), carve=[], ignore={},
                            note='T-72AV side: right boot on the track top under the ERA skirt (virtual step 0.62 m), hands on the fender '
                                 'stowage boxes, high knee onto them (1.55 m), turns, sits on edge seat ride_seat_1'),
    'mount_deck_t72b3': dict(veh=('t72b3',), side=-1, end=(-2.38, -2.72), seat=(-0.95, 1.517, -2.72), step=(-2.02, -2.64, 0.62),
                             grab=(-1.66, -2.72), deck=(-1.62, -2.72), crouch=(-0.58, -2.72), end_pose='ride_sit_deck', carve=[], ignore={},
                             note='T-72B3 side: right boot on the track top under the skirt (virtual step 0.62 m), hands on the fender, '
                                  'onto it (1.55 m), in onto the engine deck, turns, sits on deck seat ride_seat_1 (ride_sit_deck)'),
    'mount_deck_rear_btr': dict(veh=('btr80_ua', 'btr82a'), rear=True, end=(-0.10, -4.45), seat=(0.30, 1.95, -3.62), step=(-0.20, -4.08, 0.78),
                                ledge=(0.0, -3.98, 1.10), grab0=(-0.10, -3.62), grab=(-0.10, -3.50), deck=(-0.10, -3.52), crouch=(-0.10, -3.02),
                                fixed_x=True, carve=[], ignore={},
                                note='BTR stern: right boot on the sloped lower stern plate (virtual step 0.78 m), left boot on the tow hitch '
                                     '(1.10 m), hands on the engine deck edge, onto it (1.93 m), turns, sits on the stern edge seat facing back'),
    'mount_deck_rear_bmp3': dict(veh=('bmp3',), rear=True, end=(0.62, -3.95), seat=(0.62, 1.75, -3.24), step=(0.52, -3.58, 0.80),
                                 grab=(0.62, -3.28), deck=(0.62, -3.28), crouch=(0.62, -2.72), carve=[], ignore={},
                                 note='BMP-3 stern: right boot on the rear door sill lip (virtual step 0.80 m), hands on the deck edge, onto '
                                      'the deck (1.75 m), turns, sits on the stern edge seat facing back'),
    'mount_deck_rear_tank': dict(veh=('t72av_ua',), rear=True, end=(0.95, -4.48), seat=(0.95, 1.745, -3.62), step=(0.85, -4.12, 0.85),
                                 grab=(0.95, -3.62), deck=(0.95, -3.62), crouch=(0.95, -3.12), carve=[], ignore={},
                                 note='T-72AV stern: right boot on the fuel drum bracket (virtual step 0.85 m), hands on the drums, onto them '
                                      '(1.75 m), down onto the engine deck, turns, sits on the drums facing back'),
    'mount_deck_rear_t72b3': dict(veh=('t72b3',), rear=True, end=(1.00, -4.22), seat=(1.00, 1.48, -3.32), step=(0.90, -3.80, 0.88),
                                  grab=(1.00, -3.26), deck=(1.00, -3.24), crouch=(1.00, -2.78), carve=[], ignore={},
                                  note='T-72B3 stern: right boot on the thin rail of the unditching beam mount (0.88 m), hands on the deck edge, onto the engine deck '
                                       '(1.48 m), turns, sits on the stern edge seat facing back'),
    'mount_door': dict(veh=('btr80_ua', 'btr82a'), side=-1, end=(-1.95, -0.20), door=(-1.06, 0.85, -0.20), door_w=0.74, door_top=1.75,
                       carve=[('box', (-1.0, 1.0), (0.50, 1.95), (-0.80, 0.40)), ('box', (-1.70, -0.95), (0.84, 1.76), (-0.57, 0.17))], ignore={},
                       note='BTR-80/82 side door between axles 2 and 3 (dismount_R empty = start root): right boot on the folded-down lower '
                            'leaf (0.45 m), hands on the door jambs, ducks head first through the opening (sill 0.85 m, top 1.75 m), '
                            'crouched on the troop floor (0.56 m)'),
    'mount_rear': dict(veh=(), side=-1, end=(0.0, 0.0), threshold=0.50, threshold_z=-0.55, floor_z=-1.25,
                       note='IFV rear door: threshold 0.50 m, 0.55 m in front of the start root; steps up, ducks in, crouched inside'),
}
CHECK = {n: dict(grip=None, end=LAYOUT[n].get('end_pose', 'ride_sit_edge'), events=('on_deck', 'sit', 'unsling'), mount=True) for n in DECK}
CHECK.update({n: dict(grip=None, events=('inside',), mount=True) for n in INSIDE})


# ====================================================================================== helpers
def _R():
    return CV._RIG[0]


def pose_of(name, turned=False):
    """frame 0 of a cached clip: locals, hips, {side: (ankle, foot q)} (turned: rotated 180 deg about Y = facing -Z)"""
    rig = _R(); I = rig.I
    c = CV._clip_pose(name)
    lq = c['lq'][0].copy(); root = np.array(c['root'][0], float)
    if turned:
        q = qaxis(Y, np.pi)
        lq[I['Hips']] = qmul(q, lq[I['Hips']]); root = qrot(q, root)
    gq = rig.global_from_local(lq[None]); gp = fk_global(rig.sk, gq, root[None])
    return lq, root, {sd: (gp[0, I[sd + 'Foot']].copy(), gq[0, I[sd + 'Foot']].copy()) for sd in ('Left', 'Right')}


ZMIN = {}


def face_z(name, y, x=0.0, w=0.22):
    """outermost clip z of the hull over heights y - 0.25 .. y (x +- w; the hull lies at -z) in the climbing face (clip z above
    ZMIN[name], just behind the first deck footfall: not the turret further in); above the hull top: its top face"""
    L = LAYOUT[name]
    zs = np.arange(0.3, ZMIN.get(name, -2.5), -0.01)
    best = -9.0
    yy = y
    while best < -8.9 and yy > 0.1:
        for hy in (yy - 0.25, yy - 0.12, yy):
            for xx in (x - w, x, x + w):
                P = np.stack([np.full_like(zs, xx), np.full_like(zs, hy), zs], -1)
                hit = CV.vgeo(L['veh'][0]).inside(CV.c2v(name, P))
                if hit.any():
                    best = max(best, float(zs[np.argmax(hit)]))
        yy -= 0.25
    return best


def fy(side, yaw, pitch=0.0, toe=None):
    """foot euler (foot_q, given for the left foot, mirrored for the right) for a body yaw (deg, 180 = facing the hull), toes out 8 / 10 deg"""
    toe = (8.0 if side == 'Left' else 10.0) if toe is None else toe
    return (pitch, yaw + toe, 0.0) if side == 'Left' else (pitch, -(yaw - toe), 0.0)


def left_vec(yaw):
    a = np.radians(yaw)
    return np.array([np.cos(a), 0.0, -np.sin(a)])


BODY_R = dict(Hips=0.10, LowerBack=0.10, Spine=0.11, Spine1=0.12, Neck=0.06, Head=0.10, LeftShoulder=0.05, RightShoulder=0.05, LeftUpLeg=0.07,
              RightUpLeg=0.07)


def clear_hull(rig, name, dur, root, bk, feet, hk, t, win, iters=1, climb=(0.3, 2.0)):
    """choreo, then push the hips path outward (+Z, away from the hull) / up where the body is inside the hull (feet and palms
    stay on their targets: IK re-solved), within the time window win"""
    I = rig.I
    L = LAYOUT[name]
    m = ((t >= win[0]) & (t <= win[1])).astype(float)
    wc = (smooth(np.clip((t - climb[0]) / 0.5, 0, 1)) * (1 - smooth(np.clip((t - climb[1]) / 0.4, 0, 1))))[:, None]

    def kpole(side, root_, gq_):            # climbing: knees up and forward (high steps), else forward
        sx = 1 if side == 'Left' else -1
        yq = CV.hips_yaw_frame(gq_, I)
        F_ = len(t)
        return root_ + qrot(yq, np.broadcast_to([sx * 0.12, 0.15, 1.0], (F_, 3))) * (1 - wc) + qrot(yq, np.broadcast_to([sx * 0.75, 0.8, 0.05], (F_, 3))) * wc
    add = np.zeros(len(t))
    for it in range(iters):
        r2 = root.copy(); r2[:, 2] += add
        gq, rt, info = CV.choreo(rig, dur, r2, bk, feet, hk, knee_pole=kpole)
        dr = r2[:, 1] - rt[:, 1]
        info['drop_at'] = [(round(float(t[f]), 2), round(float(dr[f]), 3)) for f in range(0, len(t), 3) if dr[f] > 0.03]
        gp = fk_global(rig.sk, gq, rt)
        d = np.zeros(len(t))
        for b, r in BODY_R.items():
            for veh in L['veh']:
                d = np.maximum(d, CV.vehicle_depth(name, veh, gp[:, I[b]], r))
        d *= m
        info['clear_iter'] = (it, round(float(d.max()), 3), round(float(add.max()), 3))
        if d.max() < 0.012:
            break
        k = np.maximum.reduce([np.roll(d, j) for j in range(-4, 5)])
        k = np.convolve(np.pad(k, 4, mode='edge'), np.ones(9) / 9, 'valid')
        add = np.minimum(add + (k + 0.01 * (k > 0)) * 1.1, 0.30)
    return gq, rt, info


def unsnap(rig, gq, lim=20.0, bones=('LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot', 'LeftArm', 'LeftForeArm', 'LeftHand',
                                         'RightArm', 'RightForeArm', 'RightHand')):
    """IK flips (a knee / elbow swapping sides for a frame or two): temporal smoothing of that limb's locals around the snap"""
    for _ in range(3):
        lq = rig.local(gq)
        F = len(lq)
        for b in bones:
            i = rig.I[b]
            d = np.degrees(2 * np.arccos(np.clip(np.abs((lq[1:, i] * lq[:-1, i]).sum(-1)), 0, 1)))
            bad = np.zeros(F); bad[1:] = d > lim; bad[:-1] = np.maximum(bad[:-1], d > lim)
            if not bad.any():
                continue
            w = np.convolve(bad, np.ones(9), 'same') > 0
            limb = (b.replace('UpLeg', '').replace('Leg', '').replace('Foot', '').replace('ForeArm', '').replace('Arm', '').replace('Hand', ''))
            chain = [limb + x for x in (('UpLeg', 'Leg', 'Foot') if 'Leg' in b or 'Foot' in b else ('Arm', 'ForeArm', 'Hand'))]
            gq = A.smooth_locals(rig, gq, tuple(chain), 2.5, w.astype(float))
    return gq


def finger_pass(rig, gq, info):
    curls = {}
    for side in ('Left', 'Right'):
        pl = info['hands'][side]['planted'].astype(float)
        pl = np.convolve(np.pad(pl, 3, mode='edge'), np.ones(7) / 7, 'valid')
        curls[side] = np.outer(1 - pl, [22, 30, 12]) + np.outer(pl, [10, 14, 6])
    return CV.fingers(rig, gq, curls)


def blend_from(rig, gq, root, lq0, root0, T):
    """frames 0 .. T: from the exact pose (lq0, root0) into the authored motion"""
    F = len(gq); t = np.arange(F) / FPS
    w0 = 1 - smooth(np.clip(t / T, 0, 1))
    lq = rig.local(gq)
    for i in range(lq.shape[1]):
        lq[:, i] = np.array([qslerp(lq[f, i], lq0[i], w0[f]) for f in range(F)])
    return rig.global_from_local(lq), root * (1 - w0[:, None]) + root0[None] * w0[:, None]


# ====================================================================================== v2 solver: natural limbs
# Every limb target is held to <= 0.97 of its chain length (the root comes down to planted feet, swing targets are pulled in), knee
# poles are one fixed direction in the pelvis frame (forward, a little up and out), elbow poles one fixed direction in the chest frame
# (down, out, back). Hands: free = a relaxed hanging arm pose (FK, wrist straight); on a hold = two-bone IK with a 'natural' hand: palm
# toward the surface, fingers along the forearm's projection on it, wrist extension capped at 50 deg (the palm tilts onto its heel /
# fingers instead of bending the wrist further). Contacts fade in / out by slerping the arm locals between the two (reach / let go).
REACH = 0.97
WRIST_EXT = 50.0
KNEE_POLE = (0.55, 0.30, 0.85)
ELBOW_POLE = (0.75, -0.15, -0.55)     # out and back (never along the arm: a hand pressing down below the shoulder flipped the elbow)
RAMP = 0.50
HOLD_REACH = 0.88          # a hold is taken / kept only while the palm is well within reach (the ramp in / out stays solvable)


def _unit(v):
    v = np.asarray(v, float)
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


def relaxed_arms(rig, tuck=False):
    """chest-relative hanging arm locals per side: upper arm down / forward / out, elbow 70 deg, wrist straight"""
    from qmath import qbetween
    sk = rig.sk; I = rig.I
    out = {}
    for side, sx in (('Left', 1), ('Right', -1)):
        u0 = _unit(sk.head[I[side + 'ForeArm']] - sk.head[I[side + 'Arm']]); f0 = _unit(sk.head[I[side + 'Hand']] - sk.head[I[side + 'ForeArm']])
        h0 = _unit(np.cross(u0, f0)); rf = np.degrees(np.arccos(np.clip(u0 @ f0, -1, 1)))
        out[side] = {side + 'Shoulder': np.array([0, 0, 0, 1.0]), side + 'Arm': qbetween(u0, _unit([sx * 0.08, -1.0, 0.55] if tuck else [sx * 0.28, -0.75, 0.55])),
                     side + 'ForeArm': qaxis(h0, np.radians(85.0 - rf)), side + 'Hand': np.array([0, 0, 0, 1.0])}
    return out


def chain_len(rig, a, b, c):
    h = rig.sk.head; I = rig.I
    return np.linalg.norm(h[I[b]] - h[I[a]]) + np.linalg.norm(h[I[c]] - h[I[b]])


def natural_hand(rig, side, P, n, fore_dir, wext=None):
    """hand rotation for a palm on a surface (normal n) with the forearm along fore_dir (F,3): palm toward the surface, fingers
    along the forearm's projection on it, wrist extension capped at WRIST_EXT"""
    from clips_extra import hand_q
    n = _unit(np.asarray(n, float))
    d = _unit(fore_dir)
    h = d - n * np.sum(d * n, -1, keepdims=True)
    bias = np.array([0, 0, -1.0]) if abs(n[1]) > 0.5 else np.array([0, 0, -1.0]) - n * n[2]
    h = h + 0.45 * (bias - n * (bias @ n))
    bad = np.linalg.norm(h, axis=-1) < 1e-3
    h[bad] = np.array([0, 0, -1.0])
    h = _unit(h)
    p = np.broadcast_to(-n, h.shape)
    ang = np.degrees(np.arccos(np.clip(np.sum(h * d, -1), -1, 1)))
    k = np.clip((ang - (WRIST_EXT if wext is None else wext)) / np.maximum(ang, 1e-6), 0, 1)[:, None]      # tilt the hand toward the forearm by the excess
    ax = _unit(np.cross(h, d))
    th = np.radians(ang)[:, None] * k
    rot = lambda v: v * np.cos(th) + np.cross(ax, v) * np.sin(th) + ax * np.sum(ax * v, -1, keepdims=True) * (1 - np.cos(th))
    h2, p2 = rot(h), rot(p)
    return np.array([hand_q(rig, side, h2[f], p2[f]) for f in range(len(h2))])


def arms_pass(rig, gq, root, t, contacts, viol, name=None, offs=None):
    I = rig.I
    F = len(t)
    RA = relaxed_arms(rig, tuck=name == 'mount_door' or bool(TUNE.get(name, {}).get('tuck')))
    lq = rig.local(gq)
    lq_free = lq.copy()
    for side in ('Left', 'Right'):
        for b, q in RA[side].items():
            lq_free[:, I[b]] = q
    gq_free = rig.global_from_local(lq_free)
    out = rig.local(gq_free)
    planted = {'Left': np.zeros(F, bool), 'Right': np.zeros(F, bool)}
    palms = {'Left': np.full((F, 3), np.nan), 'Right': np.full((F, 3), np.nan)}
    HQ, POLE = {}, {}
    arms_pass.last = (HQ, POLE)
    for side, sx in (('Left', 1), ('Right', -1)):
        bones = [side + b for b in ('Shoulder', 'Arm', 'ForeArm', 'Hand')]
        L = chain_len(rig, side + 'Arm', side + 'ForeArm', side + 'Hand')
        HL = rig.hand[side]
        wbest = np.zeros(F); lbest = np.zeros((F, len(bones), 4)); lbest[..., 3] = 1
        cl = contacts.setdefault(side, [])
        ci = 0
        while ci < len(cl):
            c = cl[ci]; ci += 1
            t0, t1, P, n = c['t0'], c['t1'], np.asarray(c['P'], float), np.asarray(c['n'], float)
            gp = fk_global(rig.sk, gq_free, root)
            S = gp[:, I[side + 'Arm']]
            # contact window trimmed to where the palm is within reach of the shoulder (released before the body rises out of reach)
            dn0 = np.linalg.norm(np.broadcast_to(P, (F, 3)) - S, axis=1) / (L + 0.08)
            ok = (dn0 <= HOLD_REACH) & (dn0 >= HOLD_MIN) & (S[:, 1] - P[1] < c.get('dy', 0.35))          # (let go before the shoulder comes over the hand: the wrist would fold)
            win = np.where((t >= t0 - 1e-6) & (t <= t1 + 1e-6))[0]
            okw = win[ok[win]]
            if not len(okw):
                viol.append((side + ' hand contact dropped (out of reach)', round(t0, 2), round(float(dn0[win].min()), 3)))
                continue
            f0 = okw[0]; f1 = f0
            while f1 + 1 <= win[-1] and ok[f1 + 1]:
                f1 += 1
            t0e, t1e = t[f0], t[f1]
            if t1e < t1 - 0.05:
                viol.append((side + ' hand released early (reach)', round(t1, 2), round(float(t1e), 2)))
            RI = c.get('ramp', RAMP)
            w = smooth(np.clip((t - (t0e - RI)) / RI, 0, 1)) * (1 - smooth(np.clip((t - t1e) / RAMP, 0, 1)))
            m = w > 0
            if not m.any():
                continue
            # the palm comes down onto the hold from above and outside it, and lifts off the same way (never through the hull)
            out_dir = _unit(np.array([0, 0, 1.0]) - n * n[2]) if abs(n[1]) > 0.5 else np.zeros(3)
            A_ = P + n * 0.20 + out_dir * 0.35
            k_ = np.clip(1 - w, 0, 1)[:, None]
            tgt = P[None] * (1 - k_) + A_[None] * k_
            if c.get('route'):          # ramp-in routed in position space: free palm -> out and above the hold -> onto it (quadratic Bezier)
                Fp = gp[:, I[side + 'Hand']] + qrot(gq_free[:, I[side + 'Hand']], np.broadcast_to(HL['palm'] - HL['wrist'], (F, 3)))
                s_ = np.clip((t - (t0e - RI)) / RI, 0, 1)[:, None]
                Ar = P + n * 0.20 + out_dir * c.get('rout', 0.35)
                bz = (1 - s_) ** 2 * Fp + 2 * s_ * (1 - s_) * Ar[None] + s_ ** 2 * P[None]
                tgt = np.where((t < t0e)[:, None], bz, tgt)
            if offs is not None:
                tgt = tgt + offs['h' + side] * (k_ > 0.02)
            pole = S + qrot(gq_free[:, I['Spine1']], np.broadcast_to([sx * ELBOW_POLE[0], ELBOW_POLE[1], ELBOW_POLE[2]], (F, 3)))
            po_ = pole - S                       # elbow pole frozen (relative to the shoulder) from the moment the palm lands: the trunk pitching
            po_[f0:] = po_[f0]                   # over the hold must not swing the elbow round
            pole = S + po_
            hq = natural_hand(rig, side, P, n, tgt - S, c.get('wext'))
            for _ in range(3):
                if _ == 2:        # a planted palm does not turn on its hold: the hand rotation is frozen from the moment it lands
                    hq = hq.copy(); hq[f0:] = hq[f0]
                off = qrot(hq, np.broadcast_to(HL['palm'] - HL['wrist'], (F, 3)))
                wrist = tgt - off
                d = wrist - S; dn = np.linalg.norm(d, axis=1)
                wrist = S + d * np.minimum(1, REACH * L / np.maximum(dn, 1e-9))[:, None]
                g2 = gq_free.copy()                 # IK on the frames of this hold only (no twist carried in from far away)
                g2[m] = CV.arm_ik(rig, gq_free[m].copy(), root[m], side, (wrist + off)[m], hq[m], pole[m], 0.5, free=np.zeros(int(m.sum())))
                if _ < 2:
                    gp2 = fk_global(rig.sk, g2, root)
                    hq = natural_hand(rig, side, P, n, gp2[:, I[side + 'Hand']] - gp2[:, I[side + 'ForeArm']], c.get('wext'))
            if name and LAYOUT[name].get('veh'):      # wrist inside the hull under a hold on the edge: the palm hangs further out over it
                wp_ = fk_global(rig.sk, g2, root)[:, I[side + 'Hand']]
                pl_ = (t >= t0e - 1e-6) & (t <= t1e + 1e-6)
                dep = max(float(CV.vehicle_depth(name, v_, wp_[pl_], 0.0).max(initial=0)) for v_ in LAYOUT[name]['veh'])
                if dep > 0.0 and c.get('_push', 0) < 3:
                    c2 = dict(c, P=P + out_dir * (dep + 0.025) + n * 0.01, _push=c.get('_push', 0) + 1)
                    cl.insert(ci, c2)
                    continue
            l2 = rig.local(g2)
            for j, b in enumerate(bones):
                i = I[b]
                out[:, i] = np.array([qslerp(out[f, i], l2[f, i], w[f]) for f in range(F)])
            pl = (t >= t0e - 1e-6) & (t <= t1e + 1e-6)
            planted[side] |= pl
            palms[side][pl] = P
            HQ.setdefault(side, np.zeros((F, 4)))[pl] = hq[pl]
            POLE.setdefault(side, np.zeros((F, 3)))[pl] = (pole - S)[pl]
    return rig.global_from_local(out), planted, palms


def foot_heading(q):
    """(F,3) horizontal heading of the feet (their yaw only: a pitched / kneeling foot still points its knee the same way)"""
    F = len(q)
    out = qrot(q, np.broadcast_to([0, 0, 1.0], (F, 3))) + qrot(q, np.broadcast_to([0, 1.0, 0], (F, 3)))   # fwd + up: stable for pitch -45..135
    out[:, 1] = 0
    return _unit(out)


def _hi(k, p):
    """boot target for knee_pole's high-boot rule: only for a flat-ish boot (a kneeling leg's knee goes down, not up)"""
    return p if ('e' in k and abs(k['e'][0]) < 50 and k.get('plant')) else None


def knee_pole(rig, gp, root, side, fq, p=None, spl=0.35):
    """knee over the toes, splayed 20 deg out, raised a little; a boot up high (step-up, knee onto the deck): knee up over it"""
    sx = 1 if side == 'Left' else -1
    h = foot_heading(fq)
    left = np.stack([h[:, 2], np.zeros(len(h)), -h[:, 0]], 1)        # the foot's left
    hip = gp[:, rig.I[side + 'UpLeg']]
    rise = np.zeros((len(h), 1)) if p is None else np.clip((np.asarray(p, float).reshape(-1, 3)[:, 1:2] - (hip[:, 1:2] - 0.55)) / 0.40, 0, 1)
    return hip + h * 1.0 + left * (sx * spl) * (1 - 0.6 * rise) + np.array([0, 1.0, 0]) * (0.25 + 0.9 * rise)


def msolve(rig, name, dur, root, bk, feet, contacts, offs=None):
    """body keys + feet keys (clips_vehicle.choreo conventions) + hand contacts -> gq, root, info"""
    from clips_extra import keyed, leg_to
    I = rig.I
    F = len(root); t = np.arange(F) / FPS
    lq, _ = keyed(rig, [(k, dict(p, root=np.zeros(3))) for k, p in bk], dur)
    gq = rig.global_from_local(lq)
    viol = []
    legs = {}
    for side, keys in feet.items():
        for k in keys:
            if k.get('f', 'w') == 'w' and 'hf' in k:
                k['p'] = CV.ankle_on_field(side, k['p'][0], k['p'][2], CV.foot_q(k['e'], side), k['hf'])
            elif k.get('f', 'w') == 'w' and 'surf' in k:
                k['p'] = CV.ankle_on(side, k['p'][0], k['surf'], k['p'][2], CV.foot_q(k['e'], side))
        prev = None
        for k in keys:
            if k.get('f', 'w') == 'r':
                continue
            q = np.asarray(k['q'], float) if 'q' in k else CV.foot_q(k['e'], side)
            if prev is not None and np.dot(q, prev) < 0:
                q = -q
            k['q'] = q; prev = q
        pos, rot, _ = CV.track(keys, t, root, side=side)
        planted = np.zeros(F, bool)
        for i, k in enumerate(keys):
            if k.get('hold') and i + 1 < len(keys):
                planted |= (t >= k['t'] - 1e-6) & (t <= keys[i + 1]['t'] + 1e-6)
        if offs is not None:
            pos = pos + offs[side] * (~planted)[:, None]
        legs[side] = dict(ank=pos, q=rot, planted=planted)
    if offs is not None:
        root = root + offs['root']
    Lleg = chain_len(rig, 'LeftUpLeg', 'LeftLeg', 'LeftFoot')
    gp = fk_global(rig.sk, gq, root)
    r_pre = root.copy()
    root, drop = A.fit_root_to_feet(rig, gq, root, {sd: np.where(L_['planted'][:, None], L_['ank'], gp[:, I[sd + 'UpLeg']]) for sd, L_ in legs.items()},
                                    slack=(1 - REACH) * Lleg)
    gp = fk_global(rig.sk, gq, root)
    yq = CV.hips_yaw_frame(gq, I)
    for side, L_ in legs.items():
        sx = 1 if side == 'Left' else -1
        hip = gp[:, I[side + 'UpLeg']]
        d = L_['ank'] - hip; dn = np.linalg.norm(d, axis=1)
        if (dn > REACH * Lleg + 0.003).any():
            f = int(np.argmax(dn)); viol.append((side + ' leg reach' + (' (planted)' if L_['planted'][f] else ''), round(float(t[f]), 2), round(float(dn[f] / Lleg), 3)))
        L_['ank'] = hip + d * np.minimum(1, REACH * Lleg / np.maximum(dn, 1e-9))[:, None]
        pole = knee_pole(rig, gp, root, side, L_['q'])
        L_['pole_rel'] = pole - root
        gq = leg_to(rig, gq, root, side, L_['ank'], pole, foot_q=L_['q'])
    for side, L_ in legs.items():
        free = 1.0 - L_['planted'].astype(float)
        free = np.minimum(free, np.convolve(np.pad(free, 2, mode='edge'), np.ones(5) / 5, 'valid'))
        gq = A.smooth_locals(rig, gq, (side + 'UpLeg', side + 'Leg', side + 'Foot'), 1.6, free)
    gq, _ = A.lift_feet(rig, gq, root, floor=0.0, smooth_n=1)
    gq, hpl, palms = arms_pass(rig, gq, root, t, contacts, viol, name, offs)
    dd = r_pre[:, 1] - root[:, 1]
    info = dict(drop_at=[(round(float(t[f]), 2), round(float(dd[f]), 2)) for f in range(0, F, 6) if dd[f] > 0.03], fit_drop=round(drop, 3), legs=legs, hands={sd: dict(palm=palms[sd], q=arms_pass.last[0].get(sd, np.zeros((F, 4))), pole=arms_pass.last[1].get(sd, np.zeros((F, 3))), planted=hpl[sd]) for sd in hpl}, viol=viol)
    return gq, root, info


VR = dict(Hips=0.10, LowerBack=0.10, Spine=0.11, Spine1=0.12, Neck=0.06, Head=0.10, LeftUpLeg=0.07, RightUpLeg=0.07, LeftLeg=0.05, RightLeg=0.05,
          LeftForeArm=0.04, RightForeArm=0.04, LeftFoot=0.0, RightFoot=0.0, LeftToeBase=0.0, RightToeBase=0.0, LeftHand=0.0, RightHand=0.0,
          LeftArm=0.05, RightArm=0.05)
TRUNK = ('Hips', 'LowerBack', 'Spine', 'Spine1', 'Neck', 'Head', 'LeftArm', 'RightArm')


def _bump(d, n=6):
    k = np.maximum.reduce([np.roll(d, j) for j in range(-n, n + 1)])
    return np.convolve(np.pad(k, n, mode='edge'), np.hanning(2 * n + 3)[1:-1] / np.hanning(2 * n + 3)[1:-1].max(), 'valid')[:len(d)] if False else \
        np.convolve(np.pad(k, n, mode='edge'), np.ones(2 * n + 1) / (2 * n + 1), 'valid')


def repair(rig, name, dur, root, bk, feet, contacts, iters=7, tol=0.02, post=None, push_root=True):
    """msolve, then nudge the swinging feet / reaching hands / the hips out of the hull where the body is in it (+Z = away from the
    hull, and up), re-solve; repeated until clear"""
    import copy
    I = rig.I
    F = len(root)
    vehs = LAYOUT[name].get('veh', ())
    offs = {k: np.zeros((F, 3)) for k in ('Left', 'Right', 'root', 'hLeft', 'hRight')}
    hist = []
    for it in range(iters):
        gq, rt, info = msolve(rig, name, dur, root, bk, copy.deepcopy(feet), copy.deepcopy(contacts), offs)
        if post is not None:
            gq, rt = post(gq, rt, info)
        if not vehs:
            break
        gp = fk_global(rig.sk, gq, rt)
        dep = {b: np.max([CV.vehicle_depth(name, v, gp[:, I[b]], r) for v in vehs], 0) for b, r in VR.items()}
        if len(gp) != F:      # (final clip resampled to its tempo: back onto the solve frames)
            xs = np.linspace(0, len(gp) - 1, F)
            dep = {b: np.maximum(np.interp(xs, np.arange(len(gp)), d), np.interp(np.floor(xs), np.arange(len(gp)), d)) for b, d in dep.items()}
        worst = max(float(d.max()) for d in dep.values())
        hist.append(round(worst, 3))
        if worst <= tol:
            break
        for side in ('Left', 'Right'):
            pl = info['legs'][side]['planted']
            dl = np.maximum.reduce([dep[side + b] for b in ('Leg', 'Foot', 'ToeBase')])
            offs[side] += np.outer(_bump(dl * (~pl)) * 1.3, [0, 0.3, 1.0])
            if push_root:
                offs['root'] += np.outer(_bump(dep[side + 'Leg'] * pl) * 1.2, [0, 0, 1.0])
            else:
                offs[side] += np.outer(_bump(dl * pl) * 0.0, [0, 1.0, 0])
            hp = info['hands'][side]['planted']
            dh = np.maximum(dep[side + 'Hand'], dep[side + 'ForeArm'])
            offs['h' + side] += np.outer(_bump(dh * (~hp)) * 1.3, [0, 0.5, 1.0])
        dt_ = np.maximum.reduce([dep[b] for b in TRUNK] + [dep['LeftUpLeg'], dep['RightUpLeg']])
        offs['root'] += np.outer(_bump(dt_) * 1.2, [0, 0.2, 1.0] if push_root else [0, 1.0, 0])
        for k_, cap in (('Left', 0.15), ('Right', 0.15), ('hLeft', 0.15), ('hRight', 0.15), ('root', 0.15)):   # small nudges only: never a new motion
            nn = np.linalg.norm(offs[k_], axis=1, keepdims=True)
            offs[k_] *= np.minimum(1, cap / np.maximum(nn, 1e-9))
    info['repair'] = hist
    return gq, rt, info


ROT_MAX = 13.5          # export safety net only (limit_lq); the solve itself stays under the mount_check limits
DECK_DUR = 5.8


def _icopy(info):
    return dict(info, legs={k: dict(v) for k, v in info['legs'].items()}, hands={k: dict(v) for k, v in info['hands'].items()})


def _slerp_toward(a, b, lim):
    d = np.degrees(2 * np.arccos(np.clip(abs(np.dot(a, b)), 0, 1)))
    if d <= lim:
        return b
    return qslerp(a, b, lim / d)


def limit_rot(rig, gq, lim=ROT_MAX):
    """per bone, frame to frame: at most lim deg (forward then backward pass: no lag build-up at one end)"""
    return rig.global_from_local(limit_lq(rig.local(gq), lim))


def limit_lq(lq, lim=ROT_MAX):
    lq = lq.copy()
    F, n = lq.shape[:2]
    for i in range(n):
        q = lq[:, i].copy()
        for f in range(1, F):
            if np.dot(q[f], q[f - 1]) < 0:
                q[f] = -q[f]
            q[f] = _slerp_toward(q[f - 1], q[f], lim)
        for f in range(F - 2, -1, -1):
            q[f] = _slerp_toward(q[f + 1], q[f], lim)
        lq[:, i] = q
    return lq


def replant(rig, gq, root, info):
    """planted feet / hands back on their targets after the limiter (IK on the contact frames, faded in / out over 4 frames)"""
    from clips_extra import leg_to
    I = rig.I
    F = len(gq)
    lq = rig.local(gq)
    gp = fk_global(rig.sk, gq, root)
    for side in ('Left', 'Right'):
        L_ = info['legs'][side]
        pl = L_['planted'].astype(float)
        if pl.any():
            w = np.convolve(np.pad(pl, 2, mode='edge'), np.ones(5) / 5, 'valid')
            g2 = leg_to(rig, gq.copy(), root, side, L_['ank'], knee_pole(rig, gp, root, side, L_['q']), foot_q=L_['q'])
            l2 = rig.local(g2)
            for b in ('UpLeg', 'Leg', 'Foot'):
                i = I[side + b]
                lq[:, i] = np.array([qslerp(lq[f, i], l2[f, i], w[f]) for f in range(F)])
        H = info['hands'][side]
        hp = H['planted'].astype(float)
        if hp.any() and np.abs(H['q']).sum() > 0:
            w = np.convolve(np.pad(hp, 2, mode='edge'), np.ones(5) / 5, 'valid')
            palm = np.where(np.isnan(H['palm']), gp[:, I[side + 'Hand']], H['palm'])
            hq = np.where((np.abs(H['q']).sum(1) > 0)[:, None], H['q'], gq[:, I[side + 'Hand']])
            g2 = CV.arm_ik(rig, gq.copy(), root, side, palm, hq, gp[:, I[side + 'Arm']] + H['pole'], 0.5, free=np.zeros(F))
            l2 = rig.local(g2)
            for b in ('Arm', 'ForeArm', 'Hand'):
                i = I[side + b]
                lq[:, i] = np.array([qslerp(lq[f, i], l2[f, i], w[f]) for f in range(F)])
    return rig.global_from_local(lq)


def resample(rig, gq, root, info, k):
    """the whole solved clip played k times as long (k < 1: faster), contact data with it"""
    F = len(gq)
    F2 = int(round((F - 1) * k)) + 1
    s_ = np.linspace(0, F - 1, F2); i0 = np.minimum(np.floor(s_).astype(int), F - 2); u = s_ - i0
    lq = rig.local(gq)
    lq2 = np.zeros((F2,) + lq.shape[1:])
    for f in range(F2):
        for i in range(lq.shape[1]):
            lq2[f, i] = qslerp(lq[i0[f], i], lq[i0[f] + 1, i], u[f])
    lin = lambda a: a[i0] * (1 - u)[:, None] + a[i0 + 1] * u[:, None]
    near = np.rint(s_).astype(int)
    root2 = lin(root)
    for side in ('Left', 'Right'):
        L_ = info['legs'][side]
        q = L_['q'].copy()
        for f in range(1, F):
            if np.dot(q[f], q[f - 1]) < 0:
                q[f] = -q[f]
        L_['ank'] = lin(L_['ank']); L_['q'] = np.array([qslerp(q[i0[f]], q[i0[f] + 1], u[f]) for f in range(F2)]); L_['planted'] = L_['planted'][near]
        H = info['hands'][side]
        for key in ('palm', 'q', 'pole', 'planted'):
            H[key] = H[key][near]
    return rig.global_from_local(lq2), root2


def finalize(rig, gq, root, info, k, start=None, end=None, iters=4):
    """tempo, start / end blends, then: angular-velocity limiter -> re-plant contacts, repeated; a last limiter pass"""
    if abs(k - 1) > 1e-3:
        gq, root = resample(rig, gq, root, info, k)
    gq = finger_pass(rig, gq, info)
    if start is not None:
        gq, root = blend_from(rig, gq, root, *start)
    if end is not None:
        lq_end, hip_end, T0 = end
        t = np.arange(len(gq)) / FPS
        gq, root = CV.finish_into(rig, gq, root, np.minimum(t, t[-1] - 0.15), lq_end, hip_end, T0, rifle=False)
    for _ in range(iters):
        gq = limit_rot(rig, gq)
        gq = replant(rig, gq, root, info)
    gq = limit_rot(rig, gq)
    return gq, root


def leg_unsnap(rig, gq, info, lim=8.0):
    """swinging legs only (planted frames untouched): temporal smoothing of the chain where a bone snaps"""
    for _ in range(4):
        lq = rig.local(gq)
        F = len(lq); hit = False
        for side in ('Left', 'Right'):
            free = (~info['legs'][side]['planted']).astype(float)
            free = np.minimum(free, np.convolve(np.pad(free, 3, mode='edge'), np.ones(7) / 7, 'valid'))
            for b in ('UpLeg', 'Leg', 'Foot'):
                i = rig.I[side + b]
                d = np.degrees(2 * np.arccos(np.clip(np.abs((lq[1:, i] * lq[:-1, i]).sum(-1)), 0, 1)))
                bad = np.zeros(F); bad[1:] = d > lim; bad[:-1] = np.maximum(bad[:-1], d > lim)
                if (bad * free).any():
                    hit = True
                    w = (np.convolve(bad, np.ones(13), 'same') > 0) * free
                    gq = A.smooth_locals(rig, gq, (side + 'UpLeg', side + 'Leg', side + 'Foot'), 3.0, w)
        if not hit:
            break
    return gq


def unsnap8(rig, gq, lim=7.5, it=6, keep=None):
    """any bone turning more than lim deg between frames: temporal smoothing of that bone's chain there
    keep: {side: bool[F]} planted-hand frames whose arm chain is left alone (smoothing would drag the palm off its hold)"""
    chains = {}
    for side in ('Left', 'Right'):      # (legs left alone: smoothing their locals moves the planted feet off their holds)
        for b in ('Shoulder', 'Arm', 'ForeArm', 'Hand'):
            chains[side + b] = tuple(side + x for x in ('Shoulder', 'Arm', 'ForeArm', 'Hand'))
    for b in ('Hips', 'LowerBack', 'Spine', 'Spine1', 'Neck', 'Head'):
        chains[b] = ('LowerBack', 'Spine', 'Spine1', 'Neck', 'Head')
    for _ in range(it):
        lq = rig.local(gq)
        F = len(lq)
        hit = False
        for b, ch in chains.items():
            if b not in rig.I or b == 'Hips':
                continue
            i = rig.I[b]
            d = np.degrees(2 * np.arccos(np.clip(np.abs((lq[1:, i] * lq[:-1, i]).sum(-1)), 0, 1)))
            if (d > lim).any():
                hit = True
                bad = np.zeros(F); bad[1:] = d > lim; bad[:-1] = np.maximum(bad[:-1], d > lim)
                w = (np.convolve(bad, np.ones(11), 'same') > 0).astype(float)
                if keep is not None and b[:4] in ('Left', 'Righ'):
                    sd = 'Left' if b.startswith('Left') else 'Right'
                    if sd in keep:          # tapered: no seam where the protected hold starts / ends
                        kp = keep[sd].copy(); on = np.where(kp[1:] & ~kp[:-1])[0] + 1
                        for o in on:             # (the palm settling onto its hold may still be eased: protection starts 5 frames in)
                            kp[o:o + 5] = False
                        k_ = np.convolve(kp.astype(float), np.hanning(13) / np.hanning(13).sum(), 'same')
                        w = w * (1 - np.clip(k_ * 1.6, 0, 1))
                gq = A.smooth_locals(rig, gq, tuple(x for x in ch if x in rig.I), 2.0, w)
        if not hit:
            break
    return gq


# ====================================================================================== deck climbs (v2)
def mount_deck(rig, lm, name):
    CV._RIG[0] = rig
    L = LAYOUT[name]
    I = rig.I
    V = lambda p: CV.v2c(name, np.asarray(p, float))
    S = (lambda x, z: max(CV._surf(name, x, z, veh=v_) for v_ in L['veh'])) if T_.get('surf_all') else (lambda x, z: CV._surf(name, x, z))      # (surf_all: hull variants differ)
    end_kind = L.get('end_pose', 'ride_sit_edge')
    lq_end, r_end, feet_end = pose_of(end_kind)
    lq0, r0, feet0 = pose_of('idle_rifle', turned=True)
    Sv = V(L['seat'])
    hip_end = Sv + r_end
    st = V((L['step'][0], 0, L['step'][1]))
    virt = len(L['step']) > 2
    y_st = L['step'][2] if virt else CV._surf(name, st[0], st[2], below=1.15)
    dk = V((L['deck'][0], 0, L['deck'][1])) + np.array([0, 0, T_.get('deck_dz', 0.0)]); yd = S(dk[0], dk[2])       # (deck_dz: past a sloped stern plate)
    cr = V((L['crouch'][0], 0, L['crouch'][1])); y_cr = S(cr[0], cr[2])
    gr = V((L['grab'][0], 0, L['grab'][1]))
    ZMIN[name] = dk[2] - 0.15
    ledge = 'ledge' in L
    face = lambda y: face_z(name, y)
    zw = face(1.0)
    ze = dk[2]                                 # outer edge of the deck: last point out from the first footfall still at deck height
    while ze < 0.3 and min(S(dk[0] + dx, ze + 0.01) for dx in (-0.2, 0.0, 0.2)) > yd - 0.06:
        ze += 0.01
    up = np.array([0, 1.0, 0])
    if ledge:
        lg = V((L['ledge'][0], 0, L['ledge'][1]))
        lgy = L['ledge'][2] if len(L['ledge']) > 2 else S(lg[0], lg[2])
        g0 = V((L['grab0'][0], 0, L['grab0'][1]))
    kneel = (not ledge) and (yd - y_st > 0.72)
    # ---------------------------------------------------------------- times
    T_H, T_R0, T_S = 0.85, 0.80, 1.50          # hands on, right foot up, on the step
    T_UPS = 2.15                               # up on the step (the left foot leaves the ground as the hips rise)
    if ledge:                                  # like a ladder: right boot on the step, left on the ledge, right beside it, left / right onto the deck
        T_L0, T_L1 = 1.65, 2.25
        T_RG = (2.35, 2.65)                    # regrip on the deck edge (right, left)
        T_R2, T_R3 = 2.45, 2.95                # right foot from the step onto the ledge beside the left
        T_UPL = 3.15
        T_L2, T_L3 = 3.20, 3.70                # left foot up onto the deck
        T_R4, T_R5 = 3.80, 4.30                # right foot up onto the deck
        T_HOFF = (3.75, 3.95)
        T_DECK = 4.45
    elif kneel:
        T_L0, T_K = 1.70, 2.75                 # left knee onto the deck edge
        T_R2, T_R3 = 2.45, 3.30                # right foot off the step -> on the deck in front
        T_L2, T_L3 = 3.45, 3.95                # left foot from the knee to a crouch
        T_HOFF = (2.85, 3.00)
        T_DECK = 4.05
    else:
        T_L0, T_L1 = 1.70, 2.35                # left foot up onto the deck
        T_R2, T_R3 = 2.55, 3.10
        T_L2 = T_L3 = None
        T_HOFF = (2.90, 3.05)
        T_DECK = 3.30
    T1, T2, T3 = T_DECK + 0.10, T_DECK + 0.70, T_DECK + 1.30      # turning steps (lift)
    T_S0, T_S1 = T_DECK + 1.85, T_DECK + 3.05                    # sit down
    T_FIN = T_S1 + 0.10
    dur = round((T_FIN + 0.75) * FPS) / FPS
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    # ---------------------------------------------------------------- hips
    hz = lambda y, m=0.30: face(y) + m
    keys = [(0.0, r0), (0.45, (0.0, 0.92, hz(1.0, 0.42))), (T_H, (0.02, 0.90, hz(1.0, 0.38))), (T_S, (st[0] * 0.4, 0.92, hz(1.0, 0.40))),
            (T_UPS, (st[0] * 0.55, y_st + 0.80, hz(y_st + 0.8, 0.40)))]
    if ledge:
        keys = [k for k in keys if k[0] < T_UPS - 1e-6]
        keys += [(T_L1, (st[0] * 0.4, y_st + 0.74, hz(y_st + 0.8, 0.32))), (T_R3, (lg[0], lgy + 0.62, hz(lgy + 0.6, 0.30))),
                 (T_UPL, (lg[0], lgy + 0.74, hz(lgy + 0.75, 0.30))), (T_L3, (dk[0] * 0.5, yd + 0.40, 0.5 * (hz(lgy + 0.75, 0.30) + dk[2]))),
                 (T_R5, (dk[0], yd + 0.52, dk[2] + 0.04)), (T_DECK, (dk[0], yd + 0.56, dk[2] + 0.02))]
    elif kneel:
        K = np.array([-0.12, yd + 0.06, ze - 0.30])           # left knee on the deck
        keys += [(T_K, (-0.02, yd + 0.22, ze + 0.06)),
                 (T_R3, (0.02, yd + 0.48, ze - 0.22)), (T_DECK, (dk[0], yd + 0.56, dk[2] - 0.05))]
    else:
        keys += [(T_L1, (st[0] * 0.3, y_st + 0.84, hz(y_st + 0.9, 0.28))), (T_R3, (dk[0], yd + 0.50, dk[2] + 0.05)), (T_DECK, (dk[0], yd + 0.56, dk[2]))]
    mid = 0.5 * (np.array([dk[0], yd + 0.62, dk[2]]) + np.array([cr[0], y_cr + 0.62, cr[2]]))
    keys += [(T1 + 0.30, mid), (T2 + 0.30, (cr[0], y_cr + 0.62, cr[2])), (T3 + 0.35, (cr[0], y_cr + 0.62, cr[2] + 0.04)),
             (T_S0, (0.7 * cr[0] + 0.3 * hip_end[0], y_cr + 0.60, 0.7 * cr[2] + 0.3 * hip_end[2])), (T_S1, hip_end), (dur, hip_end)]
    keys = sorted(keys, key=lambda k: k[0])
    root = CV.root_path(keys, dur)
    # ---------------------------------------------------------------- trunk / head
    P = lambda **kw: kw
    tr = lambda yaw, hp, lb=8, sp=6, s1=4, nk=-10, hd=0: P(Hips=(hp, yaw, 0), LowerBack=(lb, 0, 0), Spine=(sp, 0, 0), Spine1=(s1, 0, 0), Neck=(nk, 0, 0), Head=(hd, 0, 0))
    sit = dict(Hips=(-14, 0, 0), LowerBack=(10, 0, 0), Spine=(8, 0, 0), Spine1=(5, 0, 0), Neck=(-2, 0, 0), Head=(4, 0, 0))
    bk = [(0.0, tr(180, 4, 2, 2, 2, -2, -4)), (0.45, tr(180, 8, 3, 3, 2, -10, -10)), (T_H, tr(180, 10, 4, 3, 2, -14, -12)),
          (T_S, tr(180, 10, 4, 3, 2, -10, -8)), (T_UPS, tr(180, 16, 6, 5, 3, -14, -6))]
    if ledge:
        bk = [k for k in bk if k[0] < T_UPS - 1e-6]
        bk += [(T_L1, tr(180, 16, 6, 5, 3, -14, -4)), (T_R3, tr(180, 14, 6, 5, 3, -12, -4)), (T_UPL, tr(180, 18, 6, 5, 3, -14, -2)),
               (T_L3, tr(180, 30, 10, 8, 5, -18, 0)), (T_DECK, tr(180, 26, 10, 8, 5, -16, 2))]
    elif kneel:
        bk += [(T_K, tr(180, 44, 10, 8, 5, -24, -2)), (T_R3, tr(180, 32, 10, 8, 5, -18, 2)), (T_DECK, tr(180, 26, 10, 8, 5, -16, 2))]
    else:
        bk += [(T_L1, tr(180, 24, 8, 6, 4, -18, -2)), (T_R3, tr(180, 28, 10, 8, 5, -16, 2)), (T_DECK, tr(180, 26, 10, 8, 5, -16, 2))]
    bk += [(T1 + 0.30, tr(120, 24, 10, 8, 5, -14, 4)), (T2 + 0.30, tr(60, 24, 10, 8, 5, -14, 4)), (T3 + 0.35, tr(0, 24, 10, 8, 5, -14, 2)),
           (T_S0, tr(0, 22, 10, 8, 5, -10, 4)), (T_S1, sit), (dur, sit)]
    # ---------------------------------------------------------------- feet
    W = lambda tt, x, z, e, hold=True, **kw: dict(t=tt, p=(x, 0, z), hf=S, e=e, hold=hold, **kw)
    Wv = lambda tt, x, z, ys, e, hold=True, **kw: dict(t=tt, p=(x, 0, z), surf=ys, e=e, hold=hold, **kw)
    Air = lambda tt, x, y, z, e=(0.0, 180.0, 0.0): dict(t=tt, p=(x, y, z), e=e)
    (aL0, qL0), (aR0, qR0) = feet0['Left'], feet0['Right']
    stp = (lambda tt, hold=True: Wv(tt, st[0], st[2], y_st, fy('Right', 180), hold)) if virt else \
          (lambda tt, hold=True: dict(t=tt, p=(st[0], 0, st[2]), hf=lambda x, z: CV._surf(name, x, z, below=1.15), e=fy('Right', 180, -10), hold=hold))
    fL = [dict(t=0.0, p=aL0, q=qL0, hold=True), dict(t=T_L0, p=aL0, q=qL0)]
    fR = [dict(t=0.0, p=aR0, q=qR0, hold=True), dict(t=T_R0, p=aR0, q=qR0),
          Air(0.5 * (T_R0 + T_S), st[0], y_st + 0.10, max(st[2] + 0.22, hz(y_st + 0.1, 0.14))), stp(T_S)]
    if ledge:
        Wl = (lambda tt, hold=True: W(tt, lg[0], lg[2], fy('Left', 180, -20), hold)) if len(L['ledge']) < 3 else (lambda tt, hold=True: Wv(tt, lg[0], lg[2], lgy, fy('Left', 180), hold))
        lg2 = lg + np.array([0.24, 0, 0])
        Wr = (lambda tt, hold=True: W(tt, lg2[0], lg2[2], fy('Right', 180, -20), hold)) if len(L['ledge']) < 3 else (lambda tt, hold=True: Wv(tt, lg2[0], lg2[2], lgy, fy('Right', 180), hold))
        fL += [Air(0.5 * (T_L0 + T_L1), lg[0], lgy + 0.10, hz(lgy, 0.32)), Wl(T_L1), Wl(T_L2, hold=False),
               Air(0.5 * (T_L2 + T_L3), dk[0] - 0.12, yd + 0.26, ze + 0.32), W(T_L3, dk[0] - 0.12, dk[2] + 0.02, fy('Left', 180))]
        fR += [stp(T_R2, hold=False), Air(0.5 * (T_R2 + T_R3), lg2[0], lgy + 0.10, hz(lgy, 0.32)), Wr(T_R3), Wr(T_R4, hold=False),
               Air(0.5 * (T_R4 + T_R5), dk[0] + 0.13, yd + 0.26, ze + 0.32), W(T_R5, dk[0] + 0.13, dk[2] - 0.04, fy('Right', 180))]
    elif kneel:
        shin = np.linalg.norm(rig.sk.head[I['LeftFoot']] - rig.sk.head[I['LeftLeg']])
        aK = K + np.array([0, 0.02, shin])                    # ankle behind the knee, foot hanging off the edge
        fL += [Air(T_L0 + 0.30 * (T_K - T_L0), -0.12, y_st + 0.25, hz(y_st + 0.3, 0.36)), Air(T_L0 + 0.70 * (T_K - T_L0), -0.12, yd - 0.30, ze + 0.45, fy('Left', 180, 40)),
               dict(t=T_K, p=aK, e=fy('Left', 180, 115), hold=True), dict(t=T_L2, p=aK, e=fy('Left', 180, 115)),
               Air(0.5 * (T_L2 + T_L3), -0.13, yd + 0.20, ze - 0.10), W(T_L3, -0.13, dk[2] + 0.02, fy('Left', 180))]
        fR += [stp(T_R2, hold=False), Air(T_R2 + 0.35 * (T_R3 - T_R2), st[0] * 0.5, yd - 0.30, hz(yd - 0.3, 0.36)),
               Air(T_R2 + 0.70 * (T_R3 - T_R2), 0.13, yd + 0.30, ze + 0.24), W(T_R3, 0.13, ze - 0.48, fy('Right', 180))]
    else:
        fL += [Air(0.5 * (T_L0 + T_L1), dk[0] - 0.12, yd + 0.16, ze + 0.22), W(T_L1, dk[0] - 0.12, dk[2] + 0.02, fy('Left', 180))]
        fR += [stp(T_R2, hold=False), Air(0.5 * (T_R2 + T_R3), dk[0] + 0.13, yd + 0.16, ze + 0.22), W(T_R3, dk[0] + 0.13, dk[2] - 0.06, fy('Right', 180))]
    cL = lambda yaw: cr + left_vec(yaw) * 0.13
    cR = lambda yaw: cr - left_vec(yaw) * 0.13
    lastL, lastR = fL[-1], fR[-1]
    fL += [dict(lastL, t=T1, hold=False), W(T1 + 0.40, cL(120)[0], cL(120)[2], fy('Left', 120), lift=0.08),
           W(T3, cL(120)[0], cL(120)[2], fy('Left', 120), hold=False), W(T3 + 0.40, cL(0)[0], cL(0)[2], fy('Left', 0), lift=0.08)]
    fR += [dict(lastR, t=T2, hold=False), W(T2 + 0.40, cR(40)[0], cR(40)[2], fy('Right', 40), lift=0.08)]
    for side, k in (('Left', fL), ('Right', fR)):     # sitting down: over the edge into the seated pose
        a, q = feet_end[side]
        a = Sv + a
        sup = S(a[0], a[2]) > a[1] - 0.16
        last = k[-1]
        t_off = T_S0 + (0.30 if side == 'Right' else 0.45)
        lp = np.array(last['p'], float)
        zz = np.linspace(lp[2], a[2], 9); top = max(S(xx, z_) for xx in (lp[0], a[0]) for z_ in zz)
        k.append(dict(last, t=t_off, hold=False))
        k.append(Air(t_off + 0.40, lp[0] + 0.3 * (a[0] - lp[0]), S(lp[0], lp[2]) + 0.12, lp[2] + 0.25 * (a[2] - lp[2]), last['e']))
        k.append(Air(0.5 * (t_off + 0.40 + T_S1 + 0.1), 0.5 * (lp[0] + a[0]), max(top + 0.24, a[1] + 0.14), 0.5 * (lp[2] + a[2]), last['e']))
        k.append(dict(t=T_S1 + 0.10, p=a, q=q, hold=True) if sup else dict(t=T_S1 + 0.10, p=a, q=q))
        k.append(dict(t=dur, p=a, q=q))
    for k in fL + fR:
        if 'e' in k and 'q' not in k and k.get('f', 'w') == 'w' and 'hf' not in k and 'surf' not in k and k.get('hold') is None:
            pass
    feet = {'Left': fL, 'Right': fR}
    # ---------------------------------------------------------------- hands
    PU = CV.PALM_UP
    hold = lambda x, z, y=None: np.array([x, (S(x, z) if y is None else y) + PU, z])
    con = {'Left': [], 'Right': []}
    for side, sx in (('Left', -1), ('Right', 1)):
        gx = gr[0] + sx * T_.get('grip_w', 0.24)
        zg = ze - 0.05
        if ledge:
            if name == 'mount_deck_btr':      # palms on the 49 deg upper side plate first
                a = np.radians(49); nrm = np.array([0, np.cos(a), np.sin(a)])
                x0 = g0[0] + sx * 0.24; P0 = np.array([x0, S(x0, g0[2]), g0[2]]) + nrm * (PU + 0.03)
            else:
                x0 = g0[0] + sx * 0.24; P0 = hold(x0, g0[2] + 0.04); nrm = up
            tg = T_RG[0] if side == 'Right' else T_RG[1]
            con[side] += [dict(t0=T_H, t1=tg - 0.42, P=P0, n=nrm), dict(t0=tg + 0.05, t1=T_HOFF[0 if side == 'Right' else 1], P=hold(gx, zg), n=up)]
        else:
            zf = face(yd - 0.02)                    # outermost shelf under the deck edge (BMP-3 skirt top, fender): first hold from the ground
            ysh = S(gx, zf - 0.04)
            if zf - ze > 0.06 and yd - ysh > 0.08 and ysh > 1.0 and not T_.get('no_shelf'):
                tg = 2.05 if side == 'Right' else 2.30
                con[side] += [dict(t0=T_H, t1=tg - 0.42, P=hold(gx, zf - 0.04), n=up), dict(t0=tg + 0.05, t1=T_HOFF[0 if side == 'Right' else 1], P=hold(gx, zg), n=up)]
            else:
                con[side] += [dict(t0=T_H, t1=T_HOFF[0 if side == 'Right' else 1], P=hold(gx, zg), n=up)]
    K = min(1.0, DECK_DUR / dur)

    def post(gq, root, info):
        return finalize(rig, gq, root, _icopy(info), K, start=(lq0, r0, 0.45), end=(lq_end, hip_end, T_FIN * K))
    gq, root, info = repair(rig, name, dur, root, bk, feet, con, post=post)
    sc = lambda x: round(x * K, 3)
    dur = (len(gq) - 1) / FPS
    off = np.round(np.array(Sv), 3).tolist()
    ev = {'on_deck': sc(T_DECK), 'turn': [sc(T1), sc(T3 + 0.4)], 'sit': sc(T_S1), 'unsling': sc(T_FIN + 0.05),
          'fix': [sc(T_DECK - 0.10), sc(T_S1)],
          'seat_offset_from_root': off, 'end_root_vehicle_xz': list(L['end']), 'seat_vehicle': list(L['seat']), 'side': L.get('side', 0),
          'rear': bool(L.get('rear')), 'stations': list(L.get('stations', [])), 'fixed_x': bool(L.get('fixed_x')), 'end_pose': end_kind,
          'step_h': round(float(y_st), 3), 'virtual_step': virt}
    return gq, root, info, ev, dur


# ====================================================================================== in through a door (v2)
def mount_in(rig, lm, name):
    CV._RIG[0] = rig
    L = LAYOUT[name]
    lq0, r0, feet0 = pose_of('idle_rifle', turned=True)
    (aL0, qL0), (aR0, qR0) = feet0['Left'], feet0['Right']
    door = name == 'mount_door'
    P = lambda **kw: kw
    tr = lambda hp, lb=8, sp=6, s1=4, nk=-10, hd=0, yaw=180: P(Hips=(hp, yaw, 0), LowerBack=(lb, 0, 0), Spine=(sp, 0, 0), Spine1=(s1, 0, 0), Neck=(nk, 0, 0), Head=(hd, 0, 0))
    Wf = lambda tt, x, z, ys, e, hold=True, **kw: dict(t=tt, p=(x, 0, z), surf=ys, e=e, hold=hold, **kw)
    Air = lambda tt, x, y, z, e=(0.0, 180.0, 0.0): dict(t=tt, p=(x, y, z), e=e)
    up = np.array([0, 1.0, 0])
    PU = CV.PALM_UP
    if door:
        dur = 3.0
        D = CV.v2c('dismount_door', CV.LAYOUT['dismount_door']['door'])     # sill (0, 0.85, -0.89)
        zd, ys = D[2], D[1]
        yf = 0.56
        y_st, z_st = CV.DOOR_STEP
        z_st += 0.11
        keys = [(0.0, r0), (0.45, (0.0, 0.90, -0.16)), (0.95, (0.04, 0.96, -0.30)), (1.40, (0.04, 1.12, -0.58)), (1.80, (0.02, 1.16, zd - 0.02)),
                (2.25, (0.0, yf + 0.62, zd - 0.40)), (2.65, (0.0, yf + 0.55, zd - 0.62)), (dur, (0.0, yf + 0.55, zd - 0.66))]
        bk = [(0.0, tr(4, 2, 2, 2, -2, -4)), (0.45, tr(14, 6, 5, 3, -12, -8)), (0.95, tr(26, 8, 6, 4, -18, -8)), (1.40, tr(44, 10, 8, 5, -24, -10)),
              (1.80, tr(56, 10, 8, 5, -26, -8)), (2.25, tr(44, 10, 8, 5, -22, -6)), (2.65, tr(32, 10, 8, 5, -16, -4)), (dur, tr(30, 10, 8, 5, -14, -2))]
        fe = {'Left': [dict(t=0.0, p=aL0, q=qL0, hold=True), dict(t=1.10, p=aL0, q=qL0), Air(1.35, -0.10, ys + 0.20, zd + 0.30, fy('Left', 180)),
                       Wf(1.60, -0.10, zd - 0.07, ys, fy('Left', 180)), Wf(2.20, -0.10, zd - 0.07, ys, fy('Left', 180), hold=False),
                       Air(2.40, -0.12, ys + 0.10, zd - 0.32, fy('Left', 180)), Wf(2.65, -0.12, zd - 0.62, yf, fy('Left', 180)), Wf(dur, -0.12, zd - 0.62, yf, fy('Left', 180))],
              'Right': [dict(t=0.0, p=aR0, q=qR0, hold=True), dict(t=0.50, p=aR0, q=qR0), Air(0.72, 0.12, y_st + 0.18, z_st + 0.25, fy('Right', 180)),
                        Wf(0.95, 0.12, z_st, y_st, fy('Right', 180)), Wf(1.75, 0.12, z_st, y_st, fy('Right', 180), hold=False),
                        Air(2.00, 0.12, ys + 0.16, zd + 0.02, fy('Right', 180)), Wf(2.30, 0.12, zd - 0.38, yf, fy('Right', 180)), Wf(dur, 0.12, zd - 0.38, yf, fy('Right', 180))]}
        con = {}
        for side, sx in (('Left', -1), ('Right', 1)):
            con[side] = [dict(t0=0.70, t1=1.20 if side == 'Left' else 1.30, P=np.array([sx * 0.46, 1.20, zd + 0.06 + 0.03]), n=np.array([0, 0, 1.0])),   # palms flat on the hull beside the frame
                         ]
        ev = {'inside': 2.70, 'step': 0.95, 'door_sill_from_root': np.round(D, 3).tolist(), 'door_top_y': CV.LAYOUT['dismount_door']['door_top']}
    else:
        dur = 2.30
        h, zt = L['threshold'], L['threshold_z']
        keys = [(0.0, r0), (0.40, (0.0, 0.92, -0.16)), (0.85, (0.0, 0.96, zt + 0.10)), (1.25, (0.0, h + 0.58, zt - 0.28)),
                (1.75, (0.0, h + 0.56, zt - 0.70)), (dur, (0.0, h + 0.55, zt - 1.00))]
        bk = [(0.0, tr(4, 2, 2, 2, -2, -4)), (0.40, tr(14, 6, 5, 3, -12, -6)), (0.85, tr(30, 8, 6, 4, -18, -8)), (1.25, tr(38, 10, 8, 5, -22, -8)),
              (1.75, tr(34, 10, 8, 5, -20, -4)), (dur, tr(30, 10, 8, 5, -16, -2))]
        fe = {'Left': [dict(t=0.0, p=aL0, q=qL0, hold=True), dict(t=0.30, p=aL0, q=qL0), Air(0.55, -0.11, h + 0.14, zt + 0.10, fy('Left', 180)),
                       Wf(0.80, -0.11, zt - 0.22, h, fy('Left', 180)), Wf(1.35, -0.11, zt - 0.22, h, fy('Left', 180), hold=False),
                       Wf(1.75, -0.12, zt - 0.86, h, fy('Left', 180), lift=0.08), Wf(dur, -0.12, zt - 0.86, h, fy('Left', 180))],
              'Right': [dict(t=0.0, p=aR0, q=qR0, hold=True), dict(t=0.85, p=aR0, q=qR0), Air(1.05, 0.12, h + 0.14, zt + 0.02, fy('Right', 180)),
                        Wf(1.25, 0.12, zt - 0.52, h, fy('Right', 180)), Wf(1.80, 0.12, zt - 0.52, h, fy('Right', 180), hold=False),
                        Wf(2.20, 0.12, zt - 1.12, h, fy('Right', 180), lift=0.08), Wf(dur, 0.12, zt - 1.12, h, fy('Right', 180))]}
        con = {}                                  # (hands free: the left hand on the door frame twisted the shoulder through 170 deg)
        ev = {'inside': 1.90, 'threshold_h': h, 'threshold_z': zt}
    root = CV.root_path(keys, dur)
    def post(gq, root, info):
        return finalize(rig, gq, root, _icopy(info), 1.0, start=(lq0, r0, 0.45))
    gq, root, info = repair(rig, name, dur, root, bk, fe, con, post=post, push_root=not door)
    return gq, root, info, ev, dur


# ====================================================================================== v3: hand-keyed legs
# Leg key poses: IK is solved only AT each key (the boot on its hold / at a swing waypoint, knee over the toes); between keys the leg
# locals are slerped with smoothstep (no IK in between, no flips); while a foot is planted it is pinned per frame by IK with the pole
# taken from the slerped pose's own knee (continuous). Root and trunk: smoothstep between held key poses.
def root_ss(keys, dur):
    """hips path through the keys: cubic Hermite, velocity carried through a key (no stop at every key) except at the ends,
    at holds (two equal keys) and per axis where the path turns back (no overshoot)"""
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    kt = np.array([k[0] for k in keys]); kv = np.array([np.asarray(k[1], float) for k in keys])
    n = len(kt)
    m = np.zeros_like(kv)
    for j in range(1, n - 1):
        d0 = (kv[j] - kv[j - 1]) / max(kt[j] - kt[j - 1], 1e-6); d1 = (kv[j + 1] - kv[j]) / max(kt[j + 1] - kt[j], 1e-6)
        if np.linalg.norm(kv[j] - kv[j - 1]) < 1e-4 or np.linalg.norm(kv[j + 1] - kv[j]) < 1e-4:
            continue
        mm = 0.5 * (d0 + d1)
        mm[np.sign(d0) != np.sign(d1)] = 0.0
        m[j] = np.sign(mm) * np.minimum(np.abs(mm), 2.0 * np.minimum(np.abs(d0), np.abs(d1)))
    out = np.zeros((F, 3))
    for f in range(F):
        j = int(np.clip(np.searchsorted(kt, t[f], side='right') - 1, 0, n - 1))
        if j >= n - 1:
            out[f] = kv[-1]; continue
        h = max(kt[j + 1] - kt[j], 1e-6); u = (t[f] - kt[j]) / h
        h00, h10, h01, h11 = 2 * u**3 - 3 * u**2 + 1, u**3 - 2 * u**2 + u, -2 * u**3 + 3 * u**2, u**3 - u**2
        out[f] = h00 * kv[j] + h10 * h * m[j] + h01 * kv[j + 1] + h11 * h * m[j + 1]
    return out


def legs_keyed(rig, gq, root, t, legkeys, viol):
    from clips_extra import leg_to
    I = rig.I
    F = len(t)
    Lleg = chain_len(rig, 'LeftUpLeg', 'LeftLeg', 'LeftFoot')
    lq = rig.local(gq)
    info = {}
    for side, keys in legkeys.items():
        bones = [I[side + b] for b in ('UpLeg', 'Leg', 'Foot')]
        prev = None
        poses = []
        pk = None
        for k in keys:
            q = np.asarray(k['q'], float) if 'q' in k else CV.foot_q(k['e'], side)
            same = pk is not None and pk.get('plant') and np.linalg.norm(np.subtract(k['p'], pk['p'])) < 1e-4
            if same:            # end of a planted hold: the boot keeps the planted key's own (possibly ankle-limited) rotation
                q = np.asarray(pk['q'], float)
            pk = k
            if prev is not None and np.dot(q, prev) < 0:
                q = -q
            k['q'] = prev = q
            f = min(int(round(k['t'] * FPS)), F - 1)
            g1 = gq[f:f + 1].copy()
            gp1 = fk_global(rig.sk, g1, root[f:f + 1])
            hip = gp1[0, I[side + 'UpLeg']]
            p = np.asarray(k['p'], float)
            d = p - hip; dn = np.linalg.norm(d)
            if dn > REACH * Lleg + 0.002 and k['t'] > 0:
                viol.append((side + ' leg key reach', round(k['t'], 2), round(dn / Lleg, 3)))
                p = hip + d * REACH * Lleg / dn
            k['pc'] = p
            pole = knee_pole(rig, gp1, root[f:f + 1], side, q[None], _hi(k, p), k.get('spl', 0.35))
            g1 = leg_to(rig, g1, root[f:f + 1], side, p[None], pole, foot_q=q[None])
            l1 = rig.local(g1)
            for _it in range(4):            # (re-aiming the knee changes the boot local again: repeat)
                lf = l1[0, bones[2]]; a_f = float(np.degrees(2 * np.arccos(min(1.0, abs(lf[3])))))
                if a_f <= ANK_KEY + 1.0 or same or 'e' not in k:          # (an explicit end pose boot is kept as it is)
                    break
                if True:          # no ankle wrung round its shin: the key's boot is turned back towards the shin's own frame
                    l1[0, bones[2]] = ank_limit(lf, bool(k.get('plant')))
                    g1 = rig.global_from_local(l1)
                    q = g1[0, bones[2]].copy()
                    if prev is not None and np.dot(q, prev) < 0:
                        q = -q
                    k['q'] = prev = q
                    g1 = gq[f:f + 1].copy()            # knee re-aimed for the limited boot (the hold-end copy of a planted key solves the same way)
                    g1 = leg_to(rig, g1, root[f:f + 1], side, p[None], knee_pole(rig, gp1, root[f:f + 1], side, q[None], _hi(k, p), k.get('spl', 0.35)), foot_q=q[None])
                    l1 = rig.local(g1)
            poses.append(l1[0, bones])
        kt = np.array([k['t'] for k in keys])
        seg = []
        for j in range(len(keys) - 1):
            aa = [float(np.degrees(2 * np.arccos(min(1.0, abs(np.dot(poses[j][b], poses[j + 1][b])))))) for b in range(3)]
            a_ = max(aa)
            nf = max(1.0, (kt[j + 1] - kt[j]) * FPS)
            if a_ / nf > 9.0:
                seg.append((side[0], round(kt[j], 2), round(kt[j + 1], 2), [round(x) for x in aa]))
        viol.extend(('seg',) + x for x in seg)
        planted = np.zeros(F, bool); ank = np.zeros((F, 3)); fq = np.zeros((F, 4))
        # leg locals: Catmull-Rom through the key poses (velocity continuous: no stop at every key; a hold's two keys = a held pose)
        from clips_extra import spline_keys
        for b in range(3):
            qs = [poses[0][b]]
            for j in range(1, len(poses)):
                q_ = poses[j][b]
                qs.append(-q_ if np.dot(q_, qs[-1]) < 0 else q_)
            ck = []
            for j in range(len(qs)):          # holds: the pose is doubled at both ends (zero velocity into / out of a planted boot)
                if j > 0 and keys[j - 1].get('plant'):
                    ck.append((kt[j] - 0.01, qs[j]))
                ck.append((kt[j], qs[j]))
                if keys[j].get('plant') and j + 1 < len(qs):
                    ck.append((kt[j] + 0.01, qs[j]))
            ck = sorted(ck, key=lambda x: x[0])
            sp = spline_keys(ck, F, 4)
            lq[:, bones[b]] = sp / np.linalg.norm(sp, axis=1, keepdims=True)
        for f in range(F):
            j = int(np.clip(np.searchsorted(kt, t[f], side='right') - 1, 0, len(kt) - 1))
            if j >= len(kt) - 1:
                ank[f] = keys[-1]['pc']; fq[f] = keys[-1]['q']; planted[f] = bool(keys[-1].get('plant'))
                continue
            u_ = (t[f] - kt[j]) / max(kt[j + 1] - kt[j], 1e-6)
            # v4 varied timing: a boot leaving its hold pushes off fast and settles slowly onto the next key (peak speed early)
            w = smooth(u_ ** (1 - (1 - ORG['push']) * (1 - _PMASK[0][f]))) if (ORG['on'] and not keys[j].get('plant') and _PMASK[0] is not None and f < len(_PMASK[0])) else smooth(u_)
            ank[f] = keys[j]['pc'] * (1 - w) + keys[j + 1]['pc'] * w
            fq[f] = qslerp(keys[j]['q'], keys[j + 1]['q'], w)
            if keys[j].get('plant'):
                planted[f] = True; ank[f] = keys[j]['pc']; fq[f] = keys[j]['q']
        gq = rig.global_from_local(lq)
        if planted.any():                      # pin the planted boots (pole = the keyed pose's own knee)
            gp = fk_global(rig.sk, gq, root)
            hip, kn, an = gp[:, I[side + 'UpLeg']], gp[:, I[side + 'Leg']], gp[:, I[side + 'Foot']]
            pole = kn + _unit(kn - 0.5 * (hip + an)) * 0.5
            g2 = leg_to(rig, gq.copy(), root, side, ank, pole, foot_q=fq)
            l2 = rig.local(g2)
            lq = rig.local(gq)
            for b in bones:
                lq[planted, b] = l2[planted, b]
            gq = rig.global_from_local(lq)
        lq = rig.local(gq)
        info[side] = dict(ank=ank, q=fq, planted=planted)
    return gq, info


def ank_limit(lf, planted):
    """boot local rotation limited: twist about the shin (bind: vertical) to +-25 deg; a free boot also has its whole turn
    scaled down to ANK_KEY, a planted one keeps its flex (the sole stays on its support)"""
    lf = lf * (1 if lf[3] >= 0 else -1)
    tw = np.array([0, lf[1], 0, lf[3]]); tw /= max(1e-9, np.linalg.norm(tw))
    sw = qmul(lf, np.array([0, -tw[1], 0, tw[3]]))          # lf = sw * tw
    a_t = float(np.degrees(2 * np.arccos(min(1.0, abs(tw[3])))))
    if a_t > 25:
        tw = qslerp(np.array([0, 0, 0, 1.0]), tw, 25 / a_t)
    q = qmul(sw, tw)
    a_f = float(np.degrees(2 * np.arccos(min(1.0, abs(q[3])))))
    if not planted and a_f > ANK_KEY:
        q = qslerp(np.array([0, 0, 0, 1.0]) * (1 if q[3] >= 0 else -1), q, ANK_KEY / a_f)
    return q


def leg_seg_need(rig, gq, root, t, legkeys, lim=11.0):
    """per leg key segment: (t0, t1, needed duration for <= lim deg/frame between the two key poses)"""
    from clips_extra import leg_to
    I = rig.I; F = len(t)
    out = []
    for side, keys in legkeys.items():
        bones = [I[side + b] for b in ('UpLeg', 'Leg', 'Foot')]
        poses = []
        prev = None
        for k in keys:
            q = np.asarray(k['q'], float) if 'q' in k else CV.foot_q(k['e'], side)
            f = min(int(round(k['t'] * FPS)), F - 1)
            g1 = gq[f:f + 1].copy(); gp1 = fk_global(rig.sk, g1, root[f:f + 1])
            g1 = leg_to(rig, g1, root[f:f + 1], side, np.asarray(k['p'], float)[None], knee_pole(rig, gp1, root[f:f + 1], side, q[None], _hi(k, k['p']), k.get('spl', 0.35)), foot_q=q[None])
            l1 = rig.local(g1)[0, bones]
            a_f = float(np.degrees(2 * np.arccos(min(1.0, abs(l1[2][3])))))
            if a_f > ANK_KEY and 'e' in k:
                l1[2] = ank_limit(l1[2], bool(k.get('plant')))
            poses.append(l1)
        for j in range(len(keys) - 1):
            a_ = max(float(np.degrees(2 * np.arccos(min(1.0, abs(np.dot(poses[j][b], poses[j + 1][b])))))) for b in range(3))
            # a segment leaving a held pose starts from rest (Catmull-Rom: the speed peaks late, ~2x the mean): give it more time
            held = j > 0 and np.linalg.norm(np.subtract(keys[j]['p'], keys[j - 1]['p'])) < 1e-4
            out.append((keys[j]['t'], keys[j + 1]['t'], a_ / (lim * FPS) * (1.15 if held else 1.0)))
    return out


WARP_DEBUG = False
TRUNK_V = 7.0          # deg/frame mean between trunk keys
ROOT_V = 1.00          # m/s mean between hip keys (Hermite, carried through keys: peak ~1.2 m/s)
ANK_KEY = 52.0        # deg, boot local rotation at a leg key pose (mount_check: 60)
HOLD_MIN = 0.55       # let go once the shoulder closes in over the palm (the elbow would fold fast)


SWING_LIM, HOLD_LIM = 13.0, 8.6           # deg/frame targets of the solve (mount_check: 14 swinging limbs, 9 trunk / planted)


def speed_warp(rig, gq, info):
    """per-frame time stretch (as a warp of clip time) wherever a leg / arm bone turns faster than SWING_LIM, or the trunk or a
    planted limb faster than HOLD_LIM; None when nothing needs it"""
    I = rig.I
    lq = rig.local(gq)
    dr = np.degrees(2 * np.arccos(np.clip(np.abs(np.sum(lq[1:] * lq[:-1], -1)), 0, 1)))
    F1 = len(dr)
    need = np.ones(F1)
    trunk = [I[b] for b in ('Hips', 'LowerBack', 'Spine', 'Spine1', 'Neck', 'Head') if b in I]
    need = np.maximum(need, dr[:, trunk].max(1) / HOLD_LIM)
    for side in ('Left', 'Right'):
        pl = np.asarray(info['legs'][side]['planted'], bool)[:F1] | np.asarray(info['legs'][side]['planted'], bool)[1:F1 + 1]
        lb = [I[side + b] for b in ('UpLeg', 'Leg', 'Foot')]
        need = np.maximum(need, dr[:, lb].max(1) / np.where(pl, HOLD_LIM, SWING_LIM))
        hp = np.asarray(info['hands'][side]['planted'], bool)
        hp = hp[:F1] | hp[1:F1 + 1]
        ab = [I[side + b] for b in ('Arm', 'ForeArm', 'Hand')]
        need = np.maximum(need, dr[:, ab].max(1) / np.where(hp, HOLD_LIM, SWING_LIM))
    print('speed_warp', [(round(f / FPS, 2), round(float(need[f]), 2)) for f in range(0, F1, 6) if need[f] > 1.0]) if WARP_DEBUG else None
    if need.max() <= 1.0:
        return None
    # keys are interpolated per key segment: a local stretch only re-times its whole segment a little, so the slowing is
    # spread over the neighbourhood (max over +-0.4 s), then eased
    need = np.array([need[max(0, f - 8):f + 9].max() for f in range(F1)])
    need = np.convolve(np.pad(need, 4, mode='edge'), np.ones(9) / 9, 'valid')
    need = np.maximum(need, 1.0)
    tt = np.arange(F1 + 1) / FPS
    nt = np.r_[0, np.cumsum(need) / FPS]
    return lambda x: float(np.interp(x, tt, nt, right=nt[-1] + (x - tt[-1])))


def make_warp(segs, dur):
    """piecewise-linear time warp stretching every interval where a leg segment needs more time than authored"""
    knots = sorted({0.0, dur} | {x for a, b, _ in segs for x in (a, b)})
    st = []
    for a, b in zip(knots[:-1], knots[1:]):
        f = 1.0
        for s0, s1, need in segs:
            if s0 <= a + 1e-6 and b <= s1 + 1e-6 and s1 - s0 > 1e-6:
                f = max(f, need / (s1 - s0))
        st.append(f)
    new = [0.0]
    for (a, b), f in zip(zip(knots[:-1], knots[1:]), st):
        new.append(new[-1] + (b - a) * f)
    kn, nw = np.array(knots), np.array(new)
    return lambda x: float(np.interp(x, kn, nw))


# ====================================================================================== v4 organic layer
# Layered on the keyed hips / trunk BEFORE the limbs are solved (feet / hands stay IK-pinned on their holds, so contacts and seat
# poses are untouched): weight shift over the support boot (+ pelvis hike / counter-roll), a load dip before every step-up and a
# damped settle after every landing, the spine / chest / neck / head trailing the hips (overlap), the head looking at the next
# foothold / handhold, then the seat, then out, breathing + a slight sway so no hold freezes.  Generic: driven by the clip's own
# key / contact timeline; per-clip phase seeds from the clip name (asymmetry between hulls).
ORG = dict(on=True, push=0.80, lag=(('LowerBack', 2, 0.55), ('Spine', 3, 0.55), ('Spine1', 4, 0.6), ('Neck', 6, 0.6), ('Head', 7, 0.6)),
           lag_cap=10.0, shift=0.045, kshift=0.40, ant=0.15, hike=4.0, dip=0.035, settle=0.018, arm_lag=(('Right', 3, 0.6), ('Left', 5, 0.6)), arm_cap=12.0, look=0.6, look_cap=18.0, breathe=0.9,
           sway=0.005, ext0=0.66, ext1=0.84)


def _qpow(q, w):
    """rotation q scaled by w (slerp from identity)"""
    return qslerp(np.broadcast_to([0, 0, 0, 1.0], np.shape(q)), q, w)


def _cap_dev(qa, qb, cap):
    """qb pulled back toward qa so the two differ by <= cap deg"""
    from qmath import qinv
    d = qmul(qinv(qa), qb); d = d * np.where(d[..., 3:4] < 0, -1, 1)
    a = np.degrees(2 * np.arccos(np.clip(d[..., 3], -1, 1)))
    k = np.clip(cap / np.maximum(a, 1e-6), 0, 1)
    return qmul(qa, _qpow(d, k))


def _bumps(t, events):
    """sum of (centre, amplitude, width) gaussians"""
    out = np.zeros(len(t))
    for c, a, w in events:
        out += a * np.exp(-0.5 * ((t - c) / w) ** 2)
    return out


def organic(rig, name, t, root, lq, legkeys, contacts, look=None):
    import zlib
    from qmath import qinv, qbetween
    I = rig.I; F = len(t); O = org_of(name)
    rng = np.random.default_rng(zlib.crc32(name.encode()))
    ph = rng.uniform(0, 2 * np.pi, 4)
    root = root.copy()
    G = rig.global_from_local(lq)
    lq_ref = lq.copy()
    gp = fk_global(rig.sk, G, root)
    # -- support per side (keys: planted from a plant key to the next key), read ahead by O['ant'] (the weight goes over first)
    def sup(keys, tt):
        kt = np.array([k['t'] for k in keys]); j = np.clip(np.searchsorted(kt, tt, side='right') - 1, 0, len(kt) - 1)
        return np.array([bool(keys[i].get('plant')) for i in j]), np.array([keys[i]['p'] for i in j], float)
    plL, pL = sup(legkeys['Left'], t + O['ant']); plR, pR = sup(legkeys['Right'], t + O['ant'])
    left = qrot(G[:, I['Hips']], np.broadcast_to([1.0, 0, 0], (F, 3))); left[:, 1] = 0
    left /= np.maximum(np.linalg.norm(left, axis=1, keepdims=True), 1e-9)
    fwd = np.cross(left, Y)
    tgt = np.zeros(F)
    for f in range(F):
        if plL[f] != plR[f]:
            p = pL[f] if plL[f] else pR[f]
            tgt[f] = np.clip(O['kshift'] * float(np.dot(p - root[f], left[f])), -O['shift'], O['shift'])
    # reach-aware: the root layers fade out wherever a planted leg is already deeply bent (high step / kneel: v3 sits at the knee,
    # ankle limits there) and act fully while the support leg is fairly straight
    pl0L, p0L = sup(legkeys['Left'], t); pl0R, p0R = sup(legkeys['Right'], t)
    Lleg = chain_len(rig, 'LeftUpLeg', 'LeftLeg', 'LeftFoot')
    ext = np.ones(F)
    for pl0, p0, sd in ((pl0L, p0L, 'Left'), (pl0R, p0R, 'Right')):
        e = np.linalg.norm(gp[:, I[sd + 'UpLeg']] - p0, axis=1) / Lleg
        ext = np.where(pl0, np.minimum(ext, e), ext)
    kr = _gs(np.clip((ext - O['ext0']) / (O['ext1'] - O['ext0']), 0, 1), 3.0)
    if O.get('hold_shift'):          # (per clip: no sideways shift while a hand is braced on a hold)
        hm = np.zeros(F)
        for cl in contacts.values():
            for c in cl:
                hm = np.maximum(hm, ((t >= c['t0'] - 0.2) & (t <= c['t1'] + 0.2)).astype(float))
        kr = kr * (1 - O['hold_shift'] * np.clip(_gs(hm, 4.0), 0, 1))
    sh = _gs(tgt, 4.0) * kr
    root[:, [0, 2]] += (sh[:, None] * left)[:, [0, 2]]
    # pelvis: the swing side hikes (roll about the pelvis forward axis), the trunk keeps 40 % of it (counter-roll)
    roll = np.radians(-O['hike'] * sh / max(O['shift'], 1e-6))
    qr = qaxis(fwd, roll)
    # -- anticipation (load dip before a step-up) + settle after each landing (damped, small rebound)
    ev = []
    for side, keys in legkeys.items():
        for i in range(1, len(keys)):
            if keys[i - 1].get('plant') and not keys[i].get('plant'):
                nxt = next((k for k in keys[i + 1:] if k.get('plant')), None)
                if nxt is not None and nxt['p'][1] - keys[i - 1]['p'][1] > 0.15:
                    ev.append((keys[i]['t'] - 0.12, -O['dip'], 0.09))
            if keys[i].get('plant') and not keys[i - 1].get('plant') and i < len(keys) - 1:
                ev += [(keys[i]['t'] + 0.12, -O['settle'], 0.08), (keys[i]['t'] + 0.42, 0.3 * O['settle'], 0.10)]
    root[:, 1] += _bumps(t, ev) * kr
    # -- micro: sway + breathing
    root[:, [0, 2]] += (O['sway'] * np.sin(2 * np.pi * 0.37 * t + ph[0]))[:, None] * left[:, [0, 2]]
    G2 = G.copy()
    G2[:, I['Hips']] = qmul(qr, G[:, I['Hips']])
    G2[:, I['LowerBack']] = qmul(_qpow(qr, 0.4), G[:, I['LowerBack']])
    G2 = rig.recompute_desc(rig.local(G), G2, {'Hips', 'LowerBack'})
    # -- overlap: each trunk bone's world rotation trails toward where it was a few frames ago (capped vs the keyed local)
    G3 = G2.copy()
    for b, lag, w in O['lag']:
        i = I[b]; pi = rig.sk.parent[i]
        src = np.clip(np.arange(F) - lag, 0, F - 1)
        g = qslerp(G2[:, i], G2[src, i], w)
        loc = qmul(qinv(G3[:, pi]), g)
        loc = _cap_dev(qmul(qinv(G2[:, pi]), G2[:, i]), loc, O['lag_cap'])
        G3[:, i] = qmul(G3[:, pi], loc)
        G3 = rig.recompute_desc(rig.local(G2), G3, {rig.sk.names[k] for k in range(rig.n) if k <= i or k in rig.sk.chain(b)})
    # -- breathing on the chest
    br = np.radians(O['breathe']) * np.sin(2 * np.pi * 0.27 * t + ph[1])
    G3[:, I['Spine1']] = qmul(qaxis(left, br), G3[:, I['Spine1']])
    G3 = rig.recompute_desc(rig.local(G2), G3, {'Hips', 'LowerBack', 'Spine', 'Spine1'})
    # -- head look-at: the next foothold / handhold within 1.2 s, then the clip's own look targets (seat, out)
    tg = []
    for keys in legkeys.values():
        for i in range(1, len(keys)):
            if keys[i].get('plant') and not keys[i - 1].get('plant'):
                tg.append((keys[i]['t'], np.asarray(keys[i]['p'], float)))
    for cl in contacts.values():
        for c in cl:
            tg.append((c['t0'] + 0.15, np.asarray(c['P'], float)))
    tg += [(a, np.asarray(p, float)) for a, p in (look or [])]
    tg.sort(key=lambda x: x[0])
    gp3 = fk_global(rig.sk, G3, root)
    hp = gp3[:, I['Head']]
    D = np.zeros((F, 3)); W = np.zeros(F)
    for f in range(F):
        nx = [(a, p) for a, p in tg if t[f] + 0.05 < a < t[f] + 1.2]
        if nx:
            D[f] = nx[0][1] - hp[f]; W[f] = 1.0
        elif look and t[f] >= look[-1][0] - 0.05:
            D[f] = np.asarray(look[-1][1]) - hp[f]; W[f] = 1.0
    D = _gs(D / np.maximum(np.linalg.norm(D, axis=1, keepdims=True), 1e-9), 5.0); W = _gs(W, 5.0) * O['look']
    hf = qrot(G3[:, I['Head']], np.broadcast_to([0, 0, 1.0], (F, 3)))
    qd = qbetween(hf, np.where(np.linalg.norm(D, axis=1, keepdims=True) > 1e-6, D, hf))
    ang = np.degrees(2 * np.arccos(np.clip(np.abs(qd[:, 3]), 0, 1)))
    k = W * np.clip(O['look_cap'] / np.maximum(ang, 1e-6), 0, 1)
    qd = _qpow(qd, k)
    G4 = G3.copy()
    G4[:, I['Neck']] = qmul(_qpow(qd, 0.45), G3[:, I['Neck']])
    G4[:, I['Head']] = qmul(qd, G3[:, I['Head']])
    G4 = rig.recompute_desc(rig.local(G3), G4, {'Hips', 'LowerBack', 'Spine', 'Spine1', 'Neck', 'Head'})
    return root, rig.local(G4)


def org_of(name):
    """ORG with the clip's TUNE[name]['org'] overrides (+ env ORG_OVR json for experiments)"""
    import os, json
    O = dict(ORG, **TUNE.get(name, {}).get('org', {}))
    O.update(json.loads(os.environ.get('ORG_OVR', '{}')))
    return O


def arm_overlap(rig, gq, planted, name=''):
    """free arms (not on a hold) trail the chest: upper arm / forearm locals lag a few frames (left later than right), capped"""
    lq = rig.local(gq); F = len(gq); O = org_of(name)
    for side, lag, w in O['arm_lag']:
        free = 1 - np.clip(_gs(np.asarray(planted[side], float), 4.0) * 1.5, 0, 1)
        src = np.clip(np.arange(F) - lag, 0, F - 1)
        for b in ('Arm', 'ForeArm'):
            i = rig.I[side + b]
            d = qslerp(lq[:, i], lq[src, i], w * free)
            lq[:, i] = _cap_dev(lq[:, i], d, O['arm_cap'])
    return rig.global_from_local(lq)


def hand_clear(rig, name, gq, root, planted, tol=0.022):
    """v4: a free hand whose path brushes the hull (the organic layer moves the chest a few cm) is lifted out along the face
    (clip +Z, up) by its depth: two-bone arm IK on the moved palm, faded in / out"""
    I = rig.I; F = len(gq)
    for _ in range(2):
        gp = fk_global(rig.sk, gq, root)
        for side in ('Left', 'Right'):
            d = np.zeros(F)
            for veh in LAYOUT[name]['veh']:
                for b in (side + 'Hand', side + 'FingerBase'):
                    d = np.maximum(d, CV.vehicle_depth(name, veh, gp[:, I[b]], 0.0))
            d = np.where(np.asarray(planted[side], bool), 0.0, d)
            if d.max() <= tol:
                continue
            off = _gs(np.maximum(d - tol + 0.012, 0) * 1.3, 2.5)
            dirn = np.array([0, 0.45, 1.0]); dirn /= np.linalg.norm(dirn)
            HL = rig.hand[side]
            hq = gq[:, I[side + 'Hand']]
            palm = gp[:, I[side + 'Hand']] + qrot(hq, np.broadcast_to(HL['palm'] - HL['wrist'], (F, 3)))
            E = gp[:, I[side + 'ForeArm']]; S_ = gp[:, I[side + 'Arm']]
            pole = E + (E - 0.5 * (S_ + gp[:, I[side + 'Hand']])) * 0.8
            sol = CV.arm_ik(rig, gq.copy(), root, side, palm + off[:, None] * dirn, hq, pole, share=0.5)
            w = np.clip(_gs((off > 1e-4).astype(float), 5.0) * 2.0, 0, 1)
            gq = CV.blend_arms(rig, gq, sol, w, sides=(side,))
    return gq


_PMASK = [None]      # per-frame guard mask (1 = v3 easing) for legs_keyed


def _leg_bad(rig, gq, root, knee=150.0, ankle=54.0, name=None, pen=0.034):
    """frames where a leg passes the mount_check limits less a margin (knee flex, boot local angle, knee bending backward)"""
    I = rig.I; F = len(gq)
    gp = fk_global(rig.sk, gq, root); lq = rig.local(gq)
    fwd = qrot(gq[:, I['Hips']], np.broadcast_to([0, 0, 1.0], (F, 3)))
    bad = np.zeros(F, bool)
    for side in ('Left', 'Right'):
        H, K, An = gp[:, I[side + 'UpLeg']], gp[:, I[side + 'Leg']], gp[:, I[side + 'Foot']]
        a = _unit(K - H); c = _unit(An - K)
        flex = np.degrees(np.arccos(np.clip(np.sum(a * c, 1), -1, 1)))
        ln = _unit(An - H)
        bn = _unit(K - (H + ln * np.sum((K - H) * ln, 1, keepdims=True)))
        an = np.degrees(2 * np.arccos(np.clip(np.abs(lq[:, I[side + 'Foot'], 3]), 0, 1)))
        bad |= (flex > knee) | ((flex > 20) & (np.sum(bn * fwd, 1) < -0.15)) | (an > ankle)
        if name and LAYOUT.get(name, {}).get('veh'):          # (legs / hips into the hull)
            for veh in LAYOUT[name]['veh']:
                for b in (side + 'UpLeg', side + 'Leg'):
                    bad |= CV.vehicle_depth(name, veh, gp[:, I[b]], VR.get(b, 0.05)) > pen
    return bad


def foot_clear(rig, name, gq, root, planted, tol=0.022):
    """v4: a swinging boot (toe / ankle) brushing the hull is lifted up and out by its depth (two-bone leg IK, faded)"""
    I = rig.I; F = len(gq)
    for _ in range(2):
        gp = fk_global(rig.sk, gq, root)
        for side in ('Left', 'Right'):
            d = np.zeros(F)
            for veh in LAYOUT[name]['veh']:
                for b in (side + 'Foot', side + 'ToeBase'):
                    d = np.maximum(d, CV.vehicle_depth(name, veh, gp[:, I[b]], 0.0))
            d = np.where(np.asarray(planted[side], bool), 0.0, d)
            if d.max() <= tol:
                continue
            off = _gs(np.maximum(d - tol + 0.012, 0) * 1.3, 2.5)
            dirn = np.array([0, 1.0, 0.5]); dirn /= np.linalg.norm(dirn)
            H, K, An = gp[:, I[side + 'UpLeg']], gp[:, I[side + 'Leg']], gp[:, I[side + 'Foot']]
            pole = K + (K - 0.5 * (H + An)) * 0.8
            lq_ref = rig.sk.local_from_global(gq)
            sol = CV.two_bone_ex(rig, gq.copy(), gp, side + 'UpLeg', side + 'Leg', side + 'Foot', An + off[:, None] * dirn, pole,
                                 gq[:, I[side + 'Foot']].copy(), np.zeros(F))
            sol = rig.recompute_desc(lq_ref, sol, {side + 'UpLeg', side + 'Leg', side + 'Foot'})
            w = np.clip(_gs((off > 1e-4).astype(float), 3.0) * 2.0, 0, 1)
            lq = rig.local(gq); ls = rig.local(sol)
            for b in ('UpLeg', 'Leg', 'Foot'):
                i = I[side + b]
                lq[:, i] = qslerp(lq[:, i], ls[:, i], w)
            gq = rig.global_from_local(lq)
    return gq


def _gs(x, s):
    n = int(3 * s) + 1
    k = np.exp(-0.5 * (np.arange(-n, n + 1) / s) ** 2); k /= k.sum()
    x = np.asarray(x, float)
    xp = np.pad(x, [(n, n)] + [(0, 0)] * (x.ndim - 1), mode='edge')
    return np.apply_along_axis(lambda v: np.convolve(v, k, 'valid'), 0, xp)


def ksolve(rig, name, dur, rkeys, bk, legkeys, contacts, warp=True, post=None, look=None):
    from clips_extra import keyed
    if warp:          # first pass at the authored times: stretch the intervals whose leg moves would turn faster than ~8.5 deg/frame
        F0 = int(round(dur * FPS)) + 1; t0_ = np.arange(F0) / FPS
        r0_ = root_ss(rkeys, dur)
        l0_, _ = keyed(rig, [(k, dict(p, root=np.zeros(3))) for k, p in bk], dur)
        segs = leg_seg_need(rig, rig.global_from_local(l0_), r0_, t0_, legkeys)
        rs = sorted(rkeys, key=lambda k: k[0])          # hips: no lunges (smoothstep peak 1.5x the mean speed: mean <= ROOT_V)
        segs += [(a[0], b[0], float(np.linalg.norm(np.subtract(b[1], a[1]))) / ROOT_V) for a, b in zip(rs[:-1], rs[1:]) if b[0] - a[0] > 1e-6]
        bs = sorted(bk, key=lambda k: k[0])             # trunk: hips / spine turn <= ~6 deg/frame mean (smoothstep peak ~9)
        def _tang(a, b):
            ha, hb = a.get('Hips', (0, 0, 0)), b.get('Hips', (0, 0, 0))
            return max(abs(hb[1] - ha[1]), abs(hb[0] - ha[0]) * 1.7)
        segs += [(a[0], b[0], _tang(a[1], b[1]) / (TRUNK_V * FPS)) for a, b in zip(bs[:-1], bs[1:]) if b[0] - a[0] > 1e-6]
        W0_ = make_warp(segs, dur)
        W_ = W0_ if post is None else (lambda x, W0_=W0_: post(W0_(x)))
        print('post', [(round(x, 2), round(W0_(x), 2), round(W_(x), 2)) for x in np.arange(3.5, dur + 0.01, 0.5)]) if (WARP_DEBUG and post) else None
        rkeys = [(W_(k), v) for k, v in rkeys]; bk = [(W_(k), v) for k, v in bk]
        for keys in legkeys.values():
            for k in keys:
                k['t'] = W_(k['t'])
        for cl in contacts.values():
            for c in cl:
                c['t0'] = W_(c['t0']); c['t1'] = W_(c['t1'])
        look = [(W_(a), p) for a, p in look] if look else look
        print('warp', [(round(x, 2), round(W_(x), 2)) for x in np.arange(0, dur + 0.01, 0.5)]) if WARP_DEBUG else None
        dur = round(W_(dur) * FPS) / FPS
        ksolve.warp = W_
    F = int(round(dur * FPS)) + 1; t = np.arange(F) / FPS
    root = root_ss(rkeys, dur)
    lq, _ = keyed(rig, [(k, dict(p, root=np.zeros(3))) for k, p in bk], dur)
    root_b, lq_b = root.copy(), lq.copy()
    if ORG['on']:
        root_o, lq_o = organic(rig, name, t, root, lq, legkeys, contacts, look)
    m = np.zeros(F)
    hl = org_of(name).get('hold_lock', 0.0)          # (per clip: hips / trunk layers held back while a hand is on a hold)
    if ORG['on'] and hl > 0:
        hm = np.zeros(F)
        for cl in contacts.values():
            for c in cl:
                hm = np.maximum(hm, ((t >= c['t0']) & (t <= c['t1'])).astype(float))
        m = np.clip(_gs(hm, 4.0) * 1.5, 0, 1) * hl
    I = rig.I
    Lleg = chain_len(rig, 'LeftUpLeg', 'LeftLeg', 'LeftFoot')
    import copy as _cpy
    lk0 = _cpy.deepcopy(legkeys)
    lift = np.zeros(F)
    for g_ in range(5 if ORG['on'] else 1):
        lk = _cpy.deepcopy(lk0)          # (legs_keyed writes the ankle-limited boot back into the keys)
        # v4 guard: wherever the organic layer would take a leg past the limits (knee 152 / boot 57 deg / knee backward), the
        # hips + trunk fall back toward the v3 keyed values there (m), re-solved
        if ORG['on']:
            root = root_o * (1 - m[:, None]) + root_b * m[:, None] + lift[:, None] * Y
            lq = np.stack([qslerp(lq_o[:, i], lq_b[:, i], m) for i in range(lq_o.shape[1])], 1)
        gq = rig.global_from_local(lq)
        viol = []
        # hips brought down where a planted boot would be out of reach (3 % slack), before any leg is solved
        tgt = {}
        gp = fk_global(rig.sk, gq, root)
        for side, keys in legkeys.items():
            kt = np.array([k['t'] for k in keys]); a_ = gp[:, I[side + 'UpLeg']].copy()
            for f in range(F):
                j = int(np.clip(np.searchsorted(kt, t[f], side='right') - 1, 0, len(kt) - 1))
                if keys[j].get('plant'):
                    a_[f] = keys[j]['p']
            tgt[side] = a_
        root, drop = A.fit_root_to_feet(rig, gq, root, tgt, slack=(1 - REACH) * Lleg + 0.004)
        _PMASK[0] = m
        gq, legs = legs_keyed(rig, gq, root, t, lk, viol)
        if not ORG['on']:
            break
        bad = _leg_bad(rig, gq, root, name=name, pen=org_of(name).get('gpen', 0.034))
        if LAYOUT.get(name, {}).get('veh') and g_ >= 2 and org_of(name).get('lift', True):          # (still a knee / thigh in the hull where m is already 1: lift)
            gpx = fk_global(rig.sk, gq, root); ex = np.zeros(F)
            for veh in LAYOUT[name]['veh']:
                for b in ('LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg'):
                    ex = np.maximum(ex, CV.vehicle_depth(name, veh, gpx[:, I[b]], VR.get(b, 0.05)) - 0.028)
            lift += np.clip(_gs(np.maximum(ex, 0), 2.0) * 2.5, 0, 0.06)
        if not bad.any():
            break
        m = np.maximum(m, np.clip(_gs(bad.astype(float), 4.0) * 3.0, 0, 1))
    for sd in legkeys:
        legkeys[sd][:] = lk[sd]
    gq, hpl, palms = arms_pass(rig, gq, root, t, contacts, viol, name)
    if ORG['on']:
        gq = arm_overlap(rig, gq, hpl, name)
    if ORG['on'] and LAYOUT.get(name, {}).get('veh'):
        if org_of(name).get('hclear', True):
            gq = hand_clear(rig, name, gq, root, hpl)
        if org_of(name).get('fclear', True):
            gq = foot_clear(rig, name, gq, root, {sd: legs[sd]['planted'] for sd in ('Left', 'Right')})
    info = dict(legs=legs, hands={sd: dict(palm=palms[sd], q=arms_pass.last[0].get(sd, np.zeros((F, 4))), pole=arms_pass.last[1].get(sd, np.zeros((F, 3))),
                                          planted=hpl[sd]) for sd in hpl}, viol=viol)
    return gq, root, info


def mount_deck_k(rig, lm, name):
    """keyed deck climb.  Classes: 'ledge' (BTR, Bradley, BTR stern: step -> ledge -> deck), 'kneel' (rise > 0.72 m: knee onto the deck),
    'plain' (a stair step).  Per-hull numbers: TUNE[name]."""
    CV._RIG[0] = rig
    L = LAYOUT[name]
    I = rig.I
    T_ = TUNE.get(name, {})
    V = lambda p: CV.v2c(name, np.asarray(p, float))
    S = (lambda x, z: max(CV._surf(name, x, z, veh=v_) for v_ in L['veh'])) if T_.get('surf_all') else (lambda x, z: CV._surf(name, x, z))      # (surf_all: hull variants differ)
    end_kind = L.get('end_pose', 'ride_sit_edge')
    lq_end, r_end, feet_end = pose_of(end_kind)
    lq0, r0, feet0 = pose_of('idle_rifle', turned=True)
    Sv = V(L['seat']); hip_end = Sv + r_end
    st = V((L['step'][0], 0, L['step'][1])) + np.array([0, 0, T_.get('step_dz', 0.0)]); virt = len(L['step']) > 2
    y_st = L['step'][2] if virt else CV._surf(name, st[0], st[2], below=1.15)
    dk = V((L['deck'][0], 0, L['deck'][1])) + np.array([0, 0, T_.get('deck_dz', 0.0)]); yd = S(dk[0], dk[2])       # (deck_dz: past a sloped stern plate)
    cr = V((L['crouch'][0], 0, L['crouch'][1])); y_cr = S(cr[0], cr[2])
    # crouch for the one-move sit: hips just in from the seat, boots between the seat and the edge (the legs never pass under the hips)
    fm = Sv + 0.5 * (np.asarray(feet_end['Left'][0]) + np.asarray(feet_end['Right'][0]))
    u = np.array([fm[0] - hip_end[0], 0, fm[2] - hip_end[2]]); u /= max(1e-6, np.linalg.norm(u))
    room = float(np.dot(np.array([0, 0, face_z(name, S(hip_end[0], hip_end[2]) - 0.02)]) - hip_end, u))       # seat -> deck lip along u
    cu, bu = (0.42, 0.30) if room > 0.62 else (-0.10, max(0.0, min(0.30, room - 0.18)))          # (a seat right at the lip: crouch in from it)
    cr = np.array([hip_end[0] + u[0] * cu, 0.0, hip_end[2] + u[2] * cu]); y_cr = S(cr[0], cr[2])      # (clip frame; hips behind the boots while facing the hull)
    CRL = np.array([hip_end[0] + u[0] * bu, 0.0, hip_end[2] + u[2] * bu]) + np.array([-u[2], 0, u[0]]) * 0.13      # (his left while facing the hull)
    if T_.get('cr_dz'):          # (a seat above a sloped plate: crouch and turn on the flat deck further in)
        cr = cr + np.array([0, 0, T_['cr_dz']]); CRL = CRL + np.array([0, 0, T_['cr_dz']]); y_cr = S(cr[0], cr[2])
    gr = V((L['grab'][0], 0, L['grab'][1]))
    ZMIN[name] = dk[2] - 0.15
    face = lambda y: face_z(name, y)
    zw = face(1.0)
    ze = dk[2]
    while ze < 0.3 and min(S(dk[0] + dx, ze + 0.01) for dx in (-0.2, 0.0, 0.2)) > yd - 0.06:
        ze += 0.01
    up = np.array([0, 1.0, 0])
    ledge = 'ledge' in L
    if ledge:
        lg = V((L['ledge'][0], 0, L['ledge'][1]))
        lgy = L['ledge'][2] if len(L['ledge']) > 2 else S(lg[0], lg[2])
        g0 = V((L['grab0'][0], 0, L['grab0'][1]))
    cls = 'kneel' if yd - y_st > 0.72 else 'plain'
    AY = 0.072                                                # ankle above the sole (flat boot)
    def P(t_, x, z, side, yaw=180.0, pitch=0.0, ys=None, plant=True):
        e = fy(side, yaw, pitch)
        q = CV.foot_q(e, side)
        p = CV.ankle_on(side, x, ys, z, q) if ys is not None else CV.ankle_on_field(side, x, z, q, S)
        return dict(t=t_, p=p, e=e, plant=plant)
    K = lambda t_, x, y, z, side, yaw=180.0, pitch=0.0: dict(t=t_, p=np.array([x, y, z]), e=fy(side, yaw, pitch))
    hz = lambda y, m: face(y) + m                              # clear of the hull face at height y by m
    (aL0, qL0), (aR0, qR0) = feet0['Left'], feet0['Right']
    idleL = dict(t=0.0, p=aL0, q=qL0, plant=True); idleR = dict(t=0.0, p=aR0, q=qR0, plant=True)
    s_ = T_.get('scale', 1.0)
    T = lambda x: round(x * s_ * 30) / 30
    OUT_L, OUT_R = 180.0 + T_.get('toe_out', 35.0), 180.0 - T_.get('toe_out', 35.0)      # high steps: toes (and so the knee) turned out
    STEP_R = 180.0 - T_.get('step_out', 30.0)
    P_ = lambda **kw: kw
    tr = lambda yaw, hp, nk=-10, hd=0: P_(Hips=(hp, yaw, 0), LowerBack=(hp * 0.3, 0, 0), Spine=(hp * 0.25, 0, 0), Spine1=(hp * 0.15, 0, 0), Neck=(nk, 0, 0), Head=(hd, 0, 0))
    hip_in = T_.get('hip_in', 0.0)
    # ---------------------------------------------------------------- 1. right boot onto the step (out -> up -> in)
    stp = lambda t_: (P(t_, st[0], st[2], 'Right', yaw=STEP_R, ys=y_st) if virt else P(t_, st[0], st[2], 'Right', yaw=STEP_R, pitch=-10))
    fR = [idleR, dict(idleR, t=T(0.35), plant=False), K(T(0.75), aR0[0] + 0.04, AY + 0.22, aR0[2] + 0.08, 'Right', yaw=STEP_R),
          K(T(1.25), st[0], y_st + AY + T_.get('step_lift', 0.16), max(st[2] + 0.22, hz(y_st + 0.1, 0.22)), 'Right', yaw=STEP_R), stp(T(1.55))]
    fR[2]['spl'] = 0.12                  # boot lifted off the ground: knee forward, not out to the side
    fL = [idleL]
    hb = T_.get('hip_back', 0.0)            # (a step tucked in under a skirt: hips further back while the boot goes in)
    shy = T_.get('step_hy', 0.0)          # (a high first step: hips stay taller, the thigh not folded up above them)
    rk = [(0.0, r0), (T(0.55), (0.0, 0.88 + shy * 0.5, -0.03 + hb)), (T(1.55), (st[0] * 0.3, 0.86 + shy, -0.05 + hb)),
          (T(1.72), (st[0] * 0.35, 0.90 + shy, -0.07 + hb * 0.5)), (T(2.15), (st[0] * 0.4, y_st + 0.78, hz(y_st + 0.8, 0.38 - hip_in)))]
    bk = [(0.0, tr(180, 4, -2, -4)), (T(0.55), tr(180, 10, -12, -12)), (T(1.55), tr(180, 10, -10, -8)), (T(2.15), tr(180, 16, -12, -4))]
    hipy = lambda tt: float(np.interp(tt, [k[0] for k in rk], [k[1][1] for k in rk]))     # hips height along the keys so far (trailing boot keys)
    if cls == 'kneel':
        # 2. left knee up onto the deck edge (shin flat on the deck, boot hanging off the edge), hands pulling
        shin = np.linalg.norm(rig.sk.head[I['LeftFoot']] - rig.sk.head[I['LeftLeg']])
        kin = T_.get('knee_in', 0.30)
        kx = T_.get('knee_x', -0.12)          # (knee x: clear of deck fittings beside the kneel spot)
        Kn = np.array([kx, max(S(kx + dx, ze - kin + dz) for dx in (-0.06, 0.06) for dz in (-0.08, 0.0, 0.08)) + 0.07, ze - kin])
        aK = Kn + np.array([0, 0.015, shin])
        fL += [dict(idleL, t=T(1.65), plant=False), K(T(2.00), -0.14, hipy(T(2.00)) - 0.62, aL0[2] + 0.18, 'Left', yaw=OUT_L, pitch=35),
               K(T(2.35), -0.16, yd - 0.45, hz(yd - 0.45, 0.55), 'Left', yaw=195, pitch=40),
               K(T(2.70), kx - 0.02, yd - 0.05 + T_.get('knee_up', 0.0), ze + 0.55, 'Left', yaw=185, pitch=80), dict(t=T(3.00), p=aK, e=fy('Left', 180, T_.get('kn_pitch', 110)), plant=True)]
        rk += [(T(3.00), (-0.04, yd + 0.50, ze - 0.10))]          # kneeling up: chest up, hands pushing on the deck
        bk += [(T(3.00), tr(180, 21, -14, -2))]
        # 3. right boot from the step onto the deck in front of the knee
        fR += [dict(stp(T(2.15)), plant=False), K(T(2.75), 0.14, yd - 0.35, hz(yd - 0.35, 0.42), 'Right', yaw=OUT_R, pitch=20),
               K(T(3.40), 0.14, yd + AY + 0.28, ze + 0.30, 'Right', yaw=OUT_R, pitch=10), K(T(3.65), 0.13, yd + AY + 0.12 + T_.get('front_up', 0.0), ze - T_.get('front', 0.45) + 0.06, 'Right', yaw=165, pitch=5), P(T(3.85), 0.13, ze - T_.get('front', 0.45), 'Right', yaw=165)]
        rk += [(T(3.85), (0.02, yd + 0.54, ze - 0.26))]
        bk += [(T(3.85), tr(180, 22, -14, 2))]
        # 4. off the knee: left boot down beside, already turning (yaw 90)
        fL += [dict(t=T(3.95), p=aK, e=fy('Left', 180, T_.get('kn_pitch', 110)))]
        if T_.get('koff_up'):          # (boot hanging over a sloped plate: lifted straight up off the knee first)
            fL += [K(T(4.12), aK[0], aK[1] + T_['koff_up'], aK[2] + 0.03, 'Left', yaw=180, pitch=70)]
        fL += [K(T(4.30), -0.12, yd + AY + 0.20, ze - 0.12, 'Left', yaw=135, pitch=40),
               P(T(4.65), CRL[0], CRL[2], 'Left', yaw=T_.get('crl_yaw', 170))]
        hand_off = (T(3.20), T(3.35)); t_deck = T(4.65)
    else:
        # 2. left boot onto the deck (a stair step), 3. right boot after it, already turning
        fL += [dict(idleL, t=T(1.65), plant=False), K(T(2.00), -0.12, AY + 0.25, aL0[2] + 0.12, 'Left', yaw=OUT_L),
               K(T(2.35), dk[0] - 0.12, yd + AY + 0.18, ze + 0.26, 'Left', yaw=OUT_L), P(T(2.70), dk[0] - 0.12, dk[2] + 0.02, 'Left', yaw=OUT_L)]
        rk += [(T(2.70), (st[0] * 0.3, y_st + 0.82, hz(y_st + 0.8, 0.32 - T_.get('hip_in2', 0.0))))]
        bk += [(T(2.70), tr(180, T_.get('pitch2', 22), -14, -2))]
        if T_.get('trail_fwd'):          # trailing boot: knee driven forward and up, boot rising close in front of the face (no hurdle leg)
            fR += [dict(stp(T(2.80)), plant=False), K(T(3.15), st[0], y_st + AY + 0.30, max(st[2] + T_.get('trail_z', 0.04), hz(y_st + 0.3, 0.06)), 'Right', yaw=T_.get('trail_yaw', 165), pitch=20),
                   K(T(3.50), dk[0] + 0.13, yd + AY + 0.18, ze + 0.26, 'Right', yaw=165), P(T(3.85), dk[0] + 0.13, dk[2] - 0.06, 'Right', yaw=165)]
        else:
            fR += [dict(stp(T(2.80)), plant=False), K(T(3.15), st[0], y_st + AY + 0.22, max(st[2] + 0.25, hz(y_st + 0.3, 0.26)), 'Right', yaw=OUT_R),
                   K(T(3.50), dk[0] + 0.13, yd + AY + 0.18, ze + 0.26, 'Right', yaw=OUT_R), P(T(3.85), dk[0] + 0.13, dk[2] - 0.06, 'Right', yaw=165)]
        rk += [(T(3.85), (dk[0], yd + 0.58 + T_.get('deck_hy', 0.0), dk[2]))]
        bk += [(T(3.85), tr(180, 26, -16, 2))]
        fL += [dict(fL[-1], t=T(3.95), plant=False), K(T(4.30), dk[0] - 0.12, yd + AY + 0.12, dk[2] + 0.02, 'Left', yaw=135),
               P(T(4.65), CRL[0], CRL[2], 'Left', yaw=170)]
        hand_off = (T(3.10), T(3.25)); t_deck = T(3.85)
    # ---------------------------------------------------------------- 5. one move: turn on the balls of both feet while lowering into the sit
    T1 = T(4.65)
    rk += [(T(4.65), (0.5 * (dk[0] + cr[0]), y_cr + 0.68 + T_.get('cr_up', 0.0), 0.5 * (ze - 0.30 + cr[2])))]
    bk += [(T(4.65), tr(195, 22, -14, 4))]          # turning to his left (yaw up to 360): the left boot comes round in front
    for side, k, yw in (('Left', fL, 215), ('Right', fR, T_.get('piv_r', 215))):        # (piv_r: the rear boot's turn, its knee kept forward)
        lp = np.array(k[-1]['p'], float); t_h = T(4.70) if side == 'Left' else T(4.65)
        if t_h > k[-1]['t'] + 1e-6:
            k += [dict(k[-1], t=t_h, plant=False)]
        k += [K(T(5.05), lp[0], lp[1] + 0.05, lp[2], side, yaw=yw, pitch=-12)]          # (heel up a little: on the ball of the foot)
    T_S0, T_S1 = T(5.10), T(6.00)
    sit = dict(Hips=(-14, 0, 0), LowerBack=(10, 0, 0), Spine=(8, 0, 0), Spine1=(5, 0, 0), Neck=(-2, 0, 0), Head=(4, 0, 0))
    rk += [(T_S0, (0.5 * cr[0] + 0.5 * hip_end[0], y_cr + 0.66, 0.5 * cr[2] + 0.5 * hip_end[2])),
           *([(T_S0 + 0.62 * (T_S1 - T_S0), (hip_end[0], hip_end[1] + 0.30, hip_end[2] - u[2] * 0.08))] if room <= 0.62 else []),   # (lip seat: hips stay up till the boots are out)
           (T_S1, tuple(hip_end))]
    sit = dict(sit, Hips=(sit['Hips'][0], 360, 0))
    bk += [(T_S0, tr(235, 18, -10, 4)), (T_S1, sit)]
    for side, k in (('Left', fL), ('Right', fR)):          # sitting: boots up off the deck, out over the edge, down into the seated pose
        swu = T_.get('sw_up', 0.0) if side == 'Right' else 0.0          # (extra swing height for the far boot: a deck rising across its path)
        a, q = feet_end[side]; a = Sv + a
        sup = S(a[0], a[2]) > a[1] - 0.16
        lp = np.array(k[-1]['p'], float)
        t0 = T_S0 + (0.00 if side == 'Left' else 0.10)
        sp_ = T_S1 + 0.15 - t0
        zz = np.linspace(lp[2], a[2], 9); top = max(S(xx, z_) for xx in (lp[0], a[0]) for z_ in zz)
        k += [dict(k[-1], t=t0, plant=False), K(t0 + 0.14 * sp_, lp[0], lp[1] + 0.14, lp[2] + 0.03, side, yaw=250, pitch=-12),
              K(t0 + 0.28 * sp_, lp[0], top + AY + 0.17 + swu, lp[2] + 0.10, side, yaw=285, pitch=-8),
              K(t0 + 0.43 * sp_, 0.7 * lp[0] + 0.3 * a[0], top + AY + 0.18 + swu, 0.7 * lp[2] + 0.3 * a[2] + 0.06, side, yaw=310, pitch=5),
              K(t0 + 0.58 * sp_, 0.5 * (lp[0] + a[0]), max(top + AY + 0.10 + swu, a[1] + 0.10), 0.5 * (lp[2] + a[2]) + 0.10, side, yaw=330, pitch=30),
              K(t0 + 0.82 * sp_, a[0], (a[1] + 0.10) if (room <= 0.62 and S(a[0], a[2]) > a[1] - 0.02) else max(a[1] + 0.10, S(a[0], a[2]) + AY + 0.08), a[2], side, yaw=0, pitch=30),
              dict(t=T_S1 + 0.15, p=a, q=q, plant=sup)]
    T_FIN = T_S1 + 0.15
    dur = round((T_FIN + 0.35) * FPS) / FPS
    for k in (fL, fR):
        k.append(dict(k[-1], t=dur))
    rk += [(dur, tuple(hip_end))]; bk += [(dur, sit)]
    # ---------------------------------------------------------------- hands (v3: per-hold blend-in, twist unwound off the hold)
    PU = CV.PALM_UP
    hold = lambda x, z, y=None: np.array([x, (S(x, z) if y is None else y) + PU + 0.04, z])     # (gripping the edge / rail: palm 4 cm up)
    con = {'Left': [], 'Right': []}
    for side, sx in (('Left', -1), ('Right', 1)):
        gx = gr[0] + sx * T_.get('grip_w', 0.24)
        zg = ze - 0.05 + T_.get('grip_out', 0.0)          # (grip_out: the lip of a fender reaching out past the deck spot)
        ho = hand_off[0 if side == 'Right' else 1]
        if ledge:
            tg = (T(2.10), T(T_.get('tg_l', 2.40)))
            if name == 'mount_deck_btr':
                a_ = np.radians(49); nrm = np.array([0, np.cos(a_), np.sin(a_)])
                x0 = g0[0] + sx * 0.20; zz = g0[2] + 0.06; P0 = np.array([x0, S(x0, zz), zz]) + nrm * (PU + 0.03)     # (a hand lower on the glacis: within reach from the ground)
            else:
                x0 = g0[0] + sx * 0.24; P0 = hold(x0, g0[2] + 0.04); nrm = up
            tgx = tg[0 if side == 'Right' else 1]
            rt_ = dict(route=T_.get('route', False), ramp=T_.get('ramp', RAMP), rout=T_.get('rout', 0.35), wext=T_.get('wext'), dy=T_.get('hold_dy', 0.35))
            con[side] += [dict(t0=T(0.75), t1=tgx - (0.62 if name == 'mount_deck_btr' and side == 'Left' else 0.42), P=P0, n=nrm, **rt_), dict(t0=tgx + 0.05, t1=ho, P=hold(gx, zg), n=up, **rt_)]
        else:
            zf = face(yd - 0.02); ysh = S(gx, zf - 0.04)
            if zf - ze > 0.06 and yd - ysh > 0.08 and ysh > 1.0 and not T_.get('no_shelf'):
                tgx = (T(1.95) if side == 'Right' else T(2.2)) + T_.get('shelf_late', 0.0)
                con[side] += [dict(t0=T(0.75), t1=tgx - 0.42, P=hold(gx, zf - 0.04), n=up), dict(t0=tgx + 0.05, t1=ho, P=hold(gx, zg), n=up, route=T_.get('route', False), ramp=T_.get('ramp', RAMP))]
            else:
                con[side] += [dict(t0=T(0.75), t1=ho, P=hold(gx, zg), n=up, route=T_.get('route', False), ramp=T_.get('ramp', RAMP))]
        if con[side]:          # hand walks forward onto the deck once the shoulder comes over the edge hold (trimmed by reach / HOLD_MIN)
            c_ = con[side][-1]
            con[side].append(dict(t0=c_['t0'] + 0.10, t1=ho + 0.25, P=hold(gx, ze - 0.40), n=up))
    rk = sorted(rk, key=lambda k: k[0]); bk = sorted(bk, key=lambda k: k[0])
    import copy as _cp
    keys0 = _cp.deepcopy((rk, bk, fL, fR, con))
    look = [(t_deck + 0.25, Sv + np.array([0, 0.05, 0])), (T1 + 0.45, hip_end + np.array([0, 0.55, 4.0]))]        # v4: seat, then out
    gq, root, info = ksolve(rig, name, dur, rk, bk, {'Left': fL, 'Right': fR}, con, look=look)
    post = None
    for _ in range(3):                             # further passes: re-time wherever the solved pose still turns too fast
        p2 = speed_warp(rig, gq, info)
        if p2 is None:
            break
        post = p2 if post is None else (lambda x, a_=post, b_=p2: b_(a_(x)))
        rk, bk, fL, fR, con = _cp.deepcopy(keys0)
        gq, root, info = ksolve(rig, name, dur, rk, bk, {'Left': fL, 'Right': fR}, con, post=post, look=look)
    W_ = ksolve.warp
    T_FIN, T_S1, T1, t_deck = W_(T_FIN), W_(T_S1), W_(T1), W_(t_deck)
    dur = (len(gq) - 1) / FPS
    gq = finger_pass(rig, gq, info)
    gq, root = blend_from(rig, gq, root, lq0, r0, 0.45)
    t = np.arange(len(gq)) / FPS
    gq, root = CV.finish_into(rig, gq, root, np.minimum(t, dur - 0.15), lq_end, hip_end, T_FIN, rifle=False)
    gq = unsnap8(rig, gq, lim=8.5, it=8, keep={sd: np.asarray(h['planted'], bool) for sd, h in info['hands'].items()})   # arms / trunk: short temporal smoothing where a hold hand-over turns too fast
    off = np.round(np.array(Sv), 3).tolist()
    ev = {'on_deck': round(t_deck, 3), 'turn': [round(T1, 3), round(T1 + 0.8, 3)], 'sit': round(T_S1, 3), 'unsling': round(T_FIN + 0.05, 3),
          'fix': [round(t_deck - 0.10, 3), round(T_S1, 3)],
          'seat_offset_from_root': off, 'end_root_vehicle_xz': list(L['end']), 'seat_vehicle': list(L['seat']), 'side': L.get('side', 0),
          'rear': bool(L.get('rear')), 'stations': list(L.get('stations', [])), 'fixed_x': bool(L.get('fixed_x')), 'end_pose': end_kind,
          'step_h': round(float(y_st), 3), 'virtual_step': virt, 'class': cls}
    return gq, root, info, ev, dur


def mount_in_k(rig, lm, name):
    """v3 keyed: in through the BTR side door (step on the folded-down leaf, crouch, over the sill) or an IFV rear door (over the
    threshold, stooped), hands free (tucked), ends crouched inside"""
    CV._RIG[0] = rig
    L = LAYOUT[name]
    lq0, r0, feet0 = pose_of('idle_rifle', turned=True)
    (aL0, qL0), (aR0, qR0) = feet0['Left'], feet0['Right']
    AY = 0.072
    def P(t_, x, z, side, ys, yaw=180.0, pitch=0.0):
        e = fy(side, yaw, pitch); q = CV.foot_q(e, side)
        return dict(t=t_, p=CV.ankle_on(side, x, ys, z, q), e=e, plant=True)
    K = lambda t_, x, y, z, side, yaw=180.0, pitch=0.0: dict(t=t_, p=np.array([x, y, z]), e=fy(side, yaw, pitch))
    tr = lambda hp, nk=-10, hd=0: dict(Hips=(hp, 180, 0), LowerBack=(hp * 0.3, 0, 0), Spine=(hp * 0.25, 0, 0), Spine1=(hp * 0.15, 0, 0), Neck=(nk, 0, 0), Head=(hd, 0, 0))
    idleL = dict(t=0.0, p=aL0, q=qL0, plant=True); idleR = dict(t=0.0, p=aR0, q=qR0, plant=True)
    if name == 'mount_door':
        D = CV.v2c('dismount_door', CV.LAYOUT['dismount_door']['door']); zd, ys = D[2], D[1]          # sill (0, 0.85, -0.89)
        yf = 0.56; y_st, z_st = CV.DOOR_STEP
        dur = 4.40
        # both boots onto the leaf, right boot over the sill (knee high, hips back: the head still outside), hips dive in under the
        # door top with the head ducked, rise inside, left boot over the sill, crouch
        rk = [(0.0, r0), (0.45, (0.02, 0.90, -0.12)), (0.95, (0.06, 1.00, -0.22)), (1.45, (0.02, 1.06, -0.36)), (1.85, (0.0, 1.20, -0.42)),
              (2.35, (0.0, 1.15, -0.44)), (2.85, (0.0, 1.05, zd + 0.11)), (3.30, (0.0, 1.20, zd - 0.24)), (3.75, (0.0, 1.25, zd - 0.36)),
              (4.20, (0.0, yf + 0.66, zd - 0.30)), (dur, (0.0, yf + 0.66, zd - 0.30))]
        bk = [(0.0, tr(4, -2, -4)), (0.45, tr(10, -12, -8)), (0.95, tr(14, -14, -8)), (1.45, tr(14, -14, -8)), (1.85, tr(16, -16, -10)),
              (2.35, tr(20, -26, -18)), (2.85, tr(22, -26, -18)), (3.35, tr(18, -18, -10)), (3.85, tr(16, -14, -6)), (4.30, tr(14, -12, -4)), (dur, tr(14, -12, -4))]
        fR = [idleR, dict(idleR, t=0.35, plant=False), K(0.65, 0.12, AY + 0.30, aR0[2] - 0.08, 'Right', pitch=15), P(0.95, 0.12, z_st + 0.06, 'Right', y_st),
              dict(P(2.05, 0.12, z_st + 0.06, 'Right', y_st), plant=False), dict(K(2.25, 0.10, ys + AY + 0.10, zd + 0.17, 'Right', pitch=10), spl=0.10),
              dict(K(2.45, 0.10, ys + AY + 0.10, zd - 0.10, 'Right'), spl=0.10), P(2.70, 0.12, zd - 0.26, 'Right', yf)]
        fL = [idleL, dict(idleL, t=1.10, plant=False), K(1.38, -0.12, AY + 0.30, aL0[2] - 0.12, 'Left', pitch=15), P(1.68, -0.12, z_st + 0.08, 'Left', y_st),
              dict(P(2.55, -0.12, z_st + 0.08, 'Left', y_st), plant=False), dict(K(2.85, -0.10, y_st + AY + 0.05, z_st + 0.08, 'Left', pitch=-15), spl=0.10),          # (heel up: on the ball of the foot)
              dict(K(3.20, -0.08, 0.88, zd + 0.13, 'Left', pitch=30), spl=0.10), dict(K(3.45, -0.08, ys + AY + 0.10, zd - 0.03, 'Left', pitch=10), spl=0.10),
              P(3.75, -0.12, zd - 0.50, 'Left', yf)]
        t_in = 3.30
        evx = {'step': 0.95, 'door_sill_from_root': np.round(D, 3).tolist(), 'door_top_y': CV.LAYOUT['dismount_door']['door_top']}
    else:
        h, zt = L['threshold'], L['threshold_z']
        dur = 2.55
        rk = [(0.0, r0), (0.40, (0.0, 0.92, -0.12)), (0.90, (0.02, 0.92, zt + 0.22)), (1.35, (0.0, h + 0.60, zt + 0.02)),
              (1.80, (0.0, h + 0.70, zt - 0.28)), (2.30, (0.0, h + 0.72, zt - 0.66)), (dur, (0.0, h + 0.72, zt - 0.70))]
        bk = [(0.0, tr(4, -2, -4)), (0.40, tr(10, -12, -6)), (0.90, tr(16, -16, -8)), (1.35, tr(20, -18, -8)), (1.80, tr(21, -18, -6)),
              (2.30, tr(19, -14, -4)), (dur, tr(19, -14, -4))]
        fL = [idleL, dict(idleL, t=0.25, plant=False), K(0.50, -0.11, AY + 0.26, aL0[2] - 0.12, 'Left', pitch=15), K(0.70, -0.11, h + AY + 0.12, zt + 0.10, 'Left'),
              P(0.90, -0.11, zt - 0.08, 'Left', h), dict(P(1.62, -0.11, zt - 0.08, 'Left', h), plant=False), K(1.88, -0.11, h + AY + 0.12, zt - 0.45, 'Left'),
              P(2.18, -0.11, zt - 0.78, 'Left', h)]
        fR = [idleR, dict(idleR, t=0.85, plant=False), K(1.10, 0.12, AY + 0.26, aR0[2] - 0.15, 'Right', pitch=15), K(1.35, 0.12, h + AY + 0.14, zt + 0.04, 'Right'),
              P(1.60, 0.12, zt - 0.60, 'Right', h)]
        t_in = 1.95
        evx = {'threshold_h': h, 'threshold_z': zt}
    for k in (fL, fR):
        k.append(dict(k[-1], t=dur))
    import copy as _cp
    keys0 = _cp.deepcopy((rk, bk, fL, fR))
    gq, root, info = ksolve(rig, name, dur, rk, bk, {'Left': fL, 'Right': fR}, {})
    post = None
    for _ in range(5):
        p2 = speed_warp(rig, gq, info)
        if p2 is None:
            break
        post = p2 if post is None else (lambda x, a_=post, b_=p2: b_(a_(x)))
        rk, bk, fL, fR = _cp.deepcopy(keys0)
        gq, root, info = ksolve(rig, name, dur, rk, bk, {'Left': fL, 'Right': fR}, {}, post=post)
    W_ = ksolve.warp
    dur = (len(gq) - 1) / FPS
    gq = finger_pass(rig, gq, info)
    gq, root = blend_from(rig, gq, root, lq0, r0, 0.45)
    gq = unsnap8(rig, gq, lim=8.5, it=8)
    ev = dict(inside=round(W_(t_in), 3), **evx)
    if 'step' in ev:
        ev['step'] = round(W_(ev['step']), 3)
    return gq, root, info, ev, dur


TUNE = {'mount_deck_btr': dict(front=0.35, scale=0.68), 'mount_deck_rear_btr': dict(org=dict(arm_lag=[('Right', 3, 0.6)]), koff_up=0.10, tg_l=1.90, surf_all=True, cr_dz=-0.35, sw_up=0.22, deck_dz=-0.30, front=0.35, scale=0.70, step_lift=0.06, rout=0.60, hip_back=0.10, kn_pitch=94, step_out=12, step_hy=0.08, crl_yaw=188, piv_r=235, route=True, ramp=1.0),
        'mount_deck_rear_bmp3': dict(front_up=0.08, step_dz=0.05, scale=0.75, step_lift=0.06, rout=0.60, hip_back=0.14, kn_pitch=100, step_out=12, step_hy=0.08, crl_yaw=188, piv_r=235, route=True, ramp=1.0),
        'mount_deck_rear_tank': dict(org=dict(lift=False, gpen=0.044), scale=0.75, step_lift=0.06, rout=0.60, hip_back=0.10, kn_pitch=100, step_out=12, step_hy=0.08, crl_yaw=188, piv_r=235, route=True, ramp=1.0),
        'mount_deck_rear_t72b3': dict(hip_back=0.0, step_lift=0.06, crl_yaw=188, piv_r=235, trail_fwd=True, trail_z=0.12, trail_yaw=150, step_out=12, step_hy=0.08, pitch2=8, deck_hy=0.07, hip_in2=0.07),
        'mount_deck_bradley': dict(front=0.25, piv_r=235, crl_yaw=188, tg_l=2.20, rout=0.60, grip_w=0.30, hold_dy=0.28, scale=0.68, hip_back=0.14, step_lift=0.06, route=True, ramp=1.0),
        'mount_deck_bmp3': dict(org=dict(settle=0.010), scale=0.70, grip_out=0.12, hip_back=0.10, knee_up=0.14, tuck=True, route=True, ramp=1.00, knee_x=-0.03), 'mount_deck_t72b3': dict(scale=0.75, step_lift=0.06, grip_out=0.12, hip_back=0.14, piv_r=235),
        'mount_deck_tank': dict(org=dict(arm_lag=[], shift=0.0, hike=0.0), scale=0.75, step_lift=0.06, grip_out=0.0, hip_back=0.14, piv_r=235, route=True, ramp=1.0, grip_w=0.31, crl_yaw=188)}


def build(rig, lm, name):
    return mount_deck_k(rig, lm, name) if name in DECK else mount_in_k(rig, lm, name)


def notes(name, ev, dur):
    L = LAYOUT[name]
    if name in DECK:
        return (f'{L["note"]}. Starts at the root (on the ground, {"behind the stern" if L.get("rear") else "beside the hull"}) facing the hull '
                f'(idle_rifle frame 0 turned 180 deg; root heading = away from the hull, the seat heading), ends exactly in {ev["end_pose"]} frame 0 '
                f'with the seat point at {ev["seat_offset_from_root"]} relative to the root (= the first frame of the matching dismount_jump). '
                f'Root fixed, whole path in the Hips track. Rifle slung while climbing, back in the right hand from events.unsling. '
                f'events.fix = window (on the deck) over which the game slides the root to the real seat of this hull / seat row.')
    return (f'{L["note"]}. Starts at the root facing the opening (idle_rifle frame 0 turned 180 deg), ends crouched inside: hide him '
            f'from events.inside. Root fixed, whole path in the Hips track.')


def support(name, x, z, y):
    """checker support heights (check_anims vehicle_checks): virtual steps, door leaf / floor, rear threshold"""
    L = LAYOUT[name]
    if name == 'mount_door':
        return CV.door_support(CV.v2c('dismount_door', CV.LAYOUT['dismount_door']['door']), x, z)
    if name == 'mount_rear':
        return L['threshold'] if z <= L['threshold_z'] else 0.0
    if len(L.get('step', ())) > 2:
        st = CV.v2c(name, (L['step'][0], 0, L['step'][1]))
        if abs(x - st[0]) < 0.14 and abs(z - st[2]) < 0.26 and abs(y - L['step'][2]) < 0.10:
            return L['step'][2]
    return None


