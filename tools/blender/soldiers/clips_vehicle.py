"""Vehicle-relative soldier clips: crew bail-out through a hatch (hatch_exit_tank = hatch_exit, hatch_exit_btr), riders jumping
off the roof / fender (dismount_jump_btr = dismount_jump, dismount_jump_tank) and troops leaving through a side door
(dismount_door, BTR-80/82) or a rear door / ramp (dismount_rear, IFV).

CLIP FRAME (all clips): origin = the soldier root at the END of the clip, on the ground beside the vehicle, +Z = facing at the
end = away from the vehicle (perpendicular to the vehicle side for hatch / roof / side-door exits, along -hull axis for rear
exits), +X = the character's left, +Y up.  The game places the root there once and does not move it during the clip; the whole
path from the vehicle is in the Hips translation track (root motion).  The last frame is a crouched move-ready pose (rifle
clips: == crouch_walk frame 0, entered with crouch_walk's ground speed; crew clips: crouch with the PM drawn).

Vehicle space (assets/vehicles/*.glb): +Z forward, +X = the vehicle's left, +Y up, ground y = 0.  An exit to the vehicle side
s (-1 = right, +1 = left) with the end root at vehicle (ex, 0, ez) maps a vehicle point v to the clip point
    c = (-s (vz - ez), vy, s (vx - ex))           and back   v = (ex + s cz, cy, ez - s cx).

Authoring: choreo() builds a clip from keys: Hips path (Catmull-Rom + ballistic flights), trunk / head local eulers, foot keys
(planted footprints on vehicle surfaces in the clip frame, or ankle offsets relative to the hips for dangling / tucked legs),
hand keys (palm contacts in the clip frame or chest-relative targets), optional rifle (right hand + left-hand grip weight) or
PM pistol hold.  Feet / hands reach their targets with two-bone IK; the pelvis is lowered where a planted foot is out of reach.
Conventions as anim.py: local eulers YXZ (deg): +X pitch forward, hip flexion -X on *UpLeg, knee flexion +X on *Leg, +Y yaw left,
+Z roll right."""
import numpy as np
import anim as A
import clips as C
from anim import FPS, fk_global, smooth
from qmath import qmul, qinv, qrot, qaxis, qeuler, qslerp, qfix_continuity
from clips_extra import hand_q, arm_to, leg_to, to_clip, keyed, spline_keys, add_euler

Y = np.array([0, 1.0, 0])
G = 9.81
JUMPS = ('dismount_jump_btr', 'dismount_jump_tank', 'dismount_jump_bmp3', 'dismount_jump_bradley',
         'dismount_jump_rear_btr', 'dismount_jump_rear_bmp3', 'dismount_jump_rear_bradley', 'dismount_jump_rear_tank')
CLIPS = ('hatch_exit', 'hatch_exit_tank', 'hatch_exit_btr', 'dismount_jump') + JUMPS + ('dismount_door', 'dismount_rear')
PALM_UP = 0.022          # palm centre above a surface it presses on


# ====================================================================================== vehicle layouts
# per clip: vehicles it is authored for / checked against, exit side, end root in vehicle space, volumes cut out of the solid for
# the interpenetration check (the hatch / door opening and the crew space under it, which the closed-lid models fill), parts the
# game shows but the crewman may pass through (documented: AA MG on the cupola, the T-72B3 cope cage is skipped by vehicle_geo).
LAYOUT = {
    'hatch_exit_tank': dict(veh=('t72av_ua', 't72b3'), side=-1, end=(-2.42, -0.07), hatch=(-0.5, 2.28, 0.18), rim_r=0.31,
                            carve=[('cyl', (-0.5, 0.18), 0.31, 1.9, 4.0), ('cyl', (-0.5, 0.18), 0.55, 0.3, 2.06)],
                            ignore={'t72av_ua': [('box', (-0.70, -0.35), (2.30, 2.75), (-0.32, 1.36))],          # NSVT on the cupola, barrel over the hatch
                                    't72b3': [('box', (-1.06, -0.35), (2.30, 2.75), (-0.22, 1.32))]},           # Kord on the cupola, outboard of the hatch
                            note='T-72 commander hatch (turret right, rim 2.28 m); gunner hatch = the mirror (side +1)'),
    'hatch_exit_btr': dict(veh=('btr82a', 'btr80_ua'), side=-1, end=(-2.15, 1.98), hatch=(-0.45, 2.03, 1.98), rim_r=0.28,
                           carve=[('cyl', (-0.45, 1.98), 0.28, 1.7, 4.0), ('cyl', (-0.45, 1.98), 0.60, 0.3, 1.96)], ignore={},
                           note='BTR-80/82 commander hatch (hull roof, front right, rim 2.03 m); driver hatch = the mirror (side +1)'),
    # riders jumping off (ride_sit_edge seat point = the seat empty; side seats: exit to the right side, the left side is the mirror;
    # rear = the stern edge seats vehicle.js seats() re-seats the back row on, facing backwards, exit along -Z)
    'dismount_jump_btr': dict(veh=('btr82a', 'btr80_ua'), side=-1, end=(-2.16, -0.45), seat=(-0.56, 1.995, -0.45), carve=[], ignore={},
                              note='BTR edge seat ride_seat_1 (roof, 0.56 m off the hull axis, 2.0 m); legs over the sloped upper side plate'),
    'dismount_jump_tank': dict(veh=('t72av_ua', 't72b3'), side=-1, end=(-2.62, -2.45), seat=(-1.42, 1.415, -2.45), carve=[], ignore={},
                               note='T-72 edge seat ride_seat_1 (on the fender stowage boxes, 1.42 m out, 1.42 m high)'),
    'dismount_jump_bmp3': dict(veh=('bmp3',), side=-1, end=(-2.28, -1.25), seat=(-1.30, 1.697, -1.25), carve=[], ignore={},
                               note='BMP-3 edge seat ride_seat_1 (hull roof 1.70 m, 1.30 m off the axis, deck edge 1.55 m, side wall 1.64 m)'),
    'dismount_jump_bradley': dict(veh=('bradley_ua',), side=-1, end=(-2.42, -1.75), seat=(-1.30, 1.979, -1.75), carve=[], ignore={},
                                  note='Bradley edge seat ride_seat_1 (hull roof 1.98 m, 1.30 m off the axis, roof edge 1.45 m, side skirt ledge 1.4 m high out to 1.77 m)'),
    'dismount_jump_rear_btr': dict(veh=('btr82a', 'btr80_ua'), rear=True, end=(0.30, -4.52), seat=(0.30, 1.95, -3.62), carve=[], ignore={},
                                   note='BTR stern edge seat (engine deck box 1.95 m, z -3.62, back edge -3.85, facing backwards)'),
    'dismount_jump_rear_bmp3': dict(veh=('bmp3',), rear=True, end=(0.62, -4.10), seat=(0.62, 1.75, -3.24), carve=[], ignore={},
                                    note='BMP-3 stern edge seat (deck 1.75 m, z -3.24, back edge -3.37, rear doors below)'),
    'dismount_jump_rear_bradley': dict(veh=('bradley_ua',), rear=True, end=(0.45, -4.02), seat=(0.45, 1.98, -3.02), carve=[], ignore={},
                                       note='Bradley stern edge seat (roof 1.98 m, z -3.02, rounded back edge -3.12 .. -3.25, ramp below)'),
    'dismount_jump_rear_tank': dict(veh=('t72av_ua', 't72b3'), rear=True, end=(0.95, -4.62), seat=(0.95, 1.745, -3.62), carve=[], ignore={},
                                    note='T-72 stern seat on the external fuel drums (1.745 m, z -3.62, drums end -3.98)'),
    'dismount_door': dict(veh=('btr82a', 'btr80_ua'), side=-1, end=(-1.95, -0.20), door=(-1.06, 0.85, -0.20), door_w=0.74, door_top=1.75,
                          carve=[('box', (-1.0, 1.0), (0.50, 1.95), (-0.80, 0.40)), ('box', (-1.70, -0.95), (0.84, 1.76), (-0.57, 0.17))], ignore={},
                          note='BTR-80/82 side door between axles 2 and 3 (dismount_R empty = end root), sill 0.85 m, opening top 1.75 m'),
    'dismount_rear': dict(veh=(), side=-1, end=(0.0, 0.0), threshold=0.50, threshold_z=-0.55, floor_z=-1.25,
                          note='IFV rear door / ramp edge: floor / threshold 0.50 m above the ground, edge 0.55 m behind the end root'),
}
LAYOUT['hatch_exit'] = LAYOUT['hatch_exit_tank']
LAYOUT['dismount_jump'] = LAYOUT['dismount_jump_btr']


def v2c(name, v):
    """vehicle space -> clip frame (rear exits: clip +Z = vehicle -Z, clip +X = vehicle -X)"""
    L = LAYOUT[name]; ex, ez = L['end']
    v = np.asarray(v, float)
    if L.get('rear'):
        return np.stack([ex - v[..., 0], v[..., 1], ez - v[..., 2]], -1)
    s = L['side']
    return np.stack([-s * (v[..., 2] - ez), v[..., 1], s * (v[..., 0] - ex)], -1)


def c2v(name, c):
    L = LAYOUT[name]; ex, ez = L['end']
    c = np.asarray(c, float)
    if L.get('rear'):
        return np.stack([ex - c[..., 0], c[..., 1], ez - c[..., 2]], -1)
    s = L['side']
    return np.stack([ex + s * c[..., 2], c[..., 1], ez - s * c[..., 0]], -1)


def preview_transform(name):
    """vehicle placement in the clip frame for preview_vehicle.html: (vp x,y,z, vyaw deg)"""
    L = LAYOUT[name]; ex, ez = L['end']
    if L.get('rear'):
        return (ex, 0.0, ez), 180.0
    s = L['side']
    return (s * ez, 0.0, -s * ex), (90.0 if s < 0 else -90.0)


def _in_regions(v, regs):
    m = np.zeros(v.shape[:-1], bool)
    for r in regs:
        if r[0] == 'cyl':
            (cx, cz), rr, y0, y1 = r[1], r[2], r[3], r[4]
            m |= (np.hypot(v[..., 0] - cx, v[..., 2] - cz) < rr) & (v[..., 1] > y0) & (v[..., 1] < y1)
        else:
            (x0, x1), (y0, y1), (z0, z1) = r[1], r[2], r[3]
            m |= (v[..., 0] > x0) & (v[..., 0] < x1) & (v[..., 1] > y0) & (v[..., 1] < y1) & (v[..., 2] > z0) & (v[..., 2] < z1)
    return m


_VG = {}


def vgeo(veh):
    if veh not in _VG:
        import vehicle_geo as VG
        _VG[veh] = VG.VGeo(veh)
    return _VG[veh]


def vehicle_depth(name, veh, P, r):
    """penetration depth (m, > 0 = inside) of spheres at clip-frame points P (..., 3) with radii r into the vehicle solid,
    0 inside the carved openings / ignored parts"""
    L = LAYOUT[name]
    v = c2v(name, P)
    d = vgeo(veh).depth(v, r)
    cut = _in_regions(v, L.get('carve', []) + L.get('ignore', {}).get(veh, []))
    return np.where(cut, 0.0, np.maximum(d, 0.0))


def surface_y(name, veh, x, z, below=9.0):
    """exact height of the vehicle surface under the clip-frame point (x, z) (highest triangle below `below`)"""
    v = c2v(name, np.array([x, below, z]))
    return vgeo(veh).ray_down(v[0], v[2], below)


# ====================================================================================== choreography engine
def _cr(p0, p1, p2, p3, u):
    return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3)


def root_path(keys, dur, flights=()):
    """Hips path: Catmull-Rom through (t, xyz) keys; each flight (t0, t1) (both must be keys) is the ballistic arc between those
    keys (x, z linear), and the spline is given virtual keys on the arc so it leaves / joins the flight with the flight velocity
    (no overshoot before take-off, the fall carries into the landing absorb)"""
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    kd = {round(k[0], 4): np.asarray(k[1], float) for k in keys}
    arcs = []
    extra = []
    for t0, t1 in flights:
        p0, p1 = kd[round(t0, 4)], kd[round(t1, 4)]
        T = t1 - t0
        vy = (p1[1] - p0[1] + 0.5 * G * T * T) / T
        arc = lambda s, p0=p0, p1=p1, T=T, vy=vy: np.array([p0[0] + (p1[0] - p0[0]) * s / T, p0[1] + vy * s - 0.5 * G * s * s, p0[2] + (p1[2] - p0[2]) * s / T])
        arcs.append((t0, t1, arc))
        d = min(0.06, T / 3)
        extra += [(t0 + d, arc(d)), (t1 - d, arc(T - d))]
    allk = sorted(list(keys) + extra, key=lambda k: k[0])
    r = spline_keys(allk, F, 3)
    for t0, t1, arc in arcs:
        m = (t >= t0) & (t <= t1)
        r[m] = np.array([arc(tt - t0) for tt in t[m]])
    return r


def sole_rel(side):
    """boot sole outline relative to the ankle joint (bind pose)"""
    s = A.SOLE * [1 if side == 'Left' else -1, 1, 1]
    return s - np.array([0.195 if side == 'Left' else -0.195, 0.072, 0.017])


def foot_q(e, side):
    """foot global rotation from (pitch, yaw, roll) deg given for the LEFT foot; yaw / roll mirrored for the right"""
    sx = 1 if side == 'Left' else -1
    return qeuler(e[0], e[1] * sx, e[2] * sx, order='YXZ')


def ankle_on(side, x, ys, z, q):
    """ankle position putting the lowest sole point of a foot with rotation q on the surface height ys (ankle x, z given)"""
    low = qrot(np.broadcast_to(q, (len(A.SOLE), 4)), sole_rel(side))[:, 1].min()
    return np.array([x, ys - low, z])


def ankle_on_field(side, x, z, q, hf):
    """ankle position for a foot with rotation q over a height field hf(x, z): every sole point above the surface, at least one
    on it (sloped plates: pitch the foot to the slope)"""
    rel = qrot(np.broadcast_to(q, (len(A.SOLE), 4)), sole_rel(side))
    y = max(hf(x + r[0], z + r[2]) - r[1] for r in rel[::2])
    return np.array([x, y, z])


def _keypos(k, root, chest, f):
    fr = k.get('f', 'w')
    p = np.asarray(k['p'], float)
    if fr == 'w':
        return p
    if fr == 'r':
        return root[f] + p
    cq, cp = chest
    return cp[f] + qrot(cq[f], p)


def track(keys, t, root, chest=None, side='Left', hand=False):
    """per-frame target positions / rotations from keys [{t, p, f ('w' world | 'r' hips-relative | 'c' chest-relative),
    q (quat) | e (foot euler) | hp ((h, p) hand dirs, world or chest), hold (plant until the next key), lift, via}]"""
    F = len(t)
    pos = np.zeros((F, 3)); rot = np.zeros((F, 4)); w_plant = np.zeros(F)
    kt = np.array([k['t'] for k in keys])

    def kq(k, f):
        if 'q' in k:
            return np.asarray(k['q'], float)
        if 'e' in k:
            return foot_q(k['e'], side)
        h, p = k['hp']
        if k.get('f', 'w') == 'c':
            h = qrot(chest[0][f], np.asarray(h, float)); p = qrot(chest[0][f], np.asarray(p, float))
        return _hq(side, h, p)
    for f in range(F):
        tt = t[f]
        j = int(np.clip(np.searchsorted(kt, tt, side='right') - 1, 0, len(keys) - 1))
        if j >= len(keys) - 1 or tt <= kt[0]:
            k = keys[j] if tt > kt[0] else keys[0]
            pos[f] = _keypos(k, root, chest, f); rot[f] = kq(k, f); w_plant[f] = 1.0 if k.get('f', 'w') == 'w' else 0.0
            continue
        k0, k1 = keys[j], keys[j + 1]
        u = (tt - kt[j]) / max(kt[j + 1] - kt[j], 1e-6)
        if k0.get('hold'):
            pos[f] = _keypos(k0, root, chest, f); rot[f] = kq(k0, f); w_plant[f] = 1.0
            continue
        us = smooth(u) if k1.get('ease', 'io') == 'io' else (u * u if k1.get('ease') == 'in' else (1 - (1 - u) ** 2 if k1.get('ease') == 'out' else u))
        km, k2 = keys[max(j - 1, 0)], keys[min(j + 2, len(keys) - 1)]
        P = [_keypos(k, root, chest, f) for k in (km, k0, k1, k2)]
        if km.get('hold') or j == 0:          # leaving a plant / the first key: no overshoot back past it
            P[0] = 2 * P[1] - P[2]
        if k1.get('hold') or j + 1 == len(keys) - 1:
            P[3] = 2 * P[2] - P[1]
        p = _cr(P[0], P[1], P[2], P[3], us)
        if 'via' in k1:                       # extra waypoint at mid-segment (world or hips-relative)
            vf, vp = k1['via']
            V = np.asarray(vp, float) + (root[f] if vf == 'r' else 0)
            mid = _cr(P[0], P[1], P[2], P[3], 0.5)
            p = p + (V - mid) * np.sin(np.pi * us)
        if k1.get('lift'):
            p = p + np.array([0, k1['lift'] * np.sin(np.pi * us), 0])
        pos[f] = p
        rot[f] = qslerp(kq(k0, f), kq(k1, f), us)
    return pos, rot, w_plant


_RIG = [None]


def two_bone_ex(rig, gq, gp, upper, lower, end, target, pole, end_rot, share, free=None):
    """anim.Rig.two_bone (forearm twist share, twist unwrapped frame to frame) where whole twist turns accumulated while the hand
    is free (free > 0.5: not holding anything) are unwound linearly over that free segment, so the twist is back on the short way
    when the hand grips again (or at the end): blending into another arm solution later cannot swing the forearm through 180 deg"""
    from anim import mat_from_cols
    from qmath import qfrom_mat
    sk = rig.sk
    F = len(gq)
    iu, il, ie = sk.idx[upper], sk.idx[lower], sk.idx[end]
    u0 = sk.head[il] - sk.head[iu]; f0 = sk.head[ie] - sk.head[il]
    L1, L2 = np.linalg.norm(u0), np.linalg.norm(f0)
    n0 = np.cross(u0, f0); n0 /= np.linalg.norm(n0)
    A0 = mat_from_cols(u0 / L1, n0, np.cross(u0 / L1, n0)); B0 = mat_from_cols(f0 / L2, n0, np.cross(f0 / L2, n0))
    ax = f0 / L2
    QA = np.zeros((F, 4)); QB = np.zeros((F, 4)); TH = np.zeros(F)
    prev = None
    for f in range(F):
        S_ = gp[f, iu]; d = target[f] - S_
        dist = np.linalg.norm(d); dc = np.clip(dist, abs(L1 - L2) + 1e-4, (L1 + L2) * 0.9995); dn = d / max(dist, 1e-9)
        pv = pole[f] - S_; pv = pv - dn * (pv @ dn)
        if np.linalg.norm(pv) < 1e-6:
            pv = np.array([0, -1.0, 0]) - dn * (-dn[1])
        pv /= np.linalg.norm(pv)
        a = (L1 ** 2 - L2 ** 2 + dc ** 2) / (2 * dc); h = np.sqrt(max(L1 ** 2 - a ** 2, 0))
        E = S_ + dn * a + pv * h; Tc = S_ + dn * dc
        u1 = (E - S_) / L1; f1 = (Tc - E) / L2
        n1 = np.cross(u1, f1)
        if np.linalg.norm(n1) < 1e-6:
            n1 = np.cross(u1, pv)
        n1 /= np.linalg.norm(n1)
        QA[f] = qfrom_mat(mat_from_cols(u1, n1, np.cross(u1, n1)) @ A0.T); QB[f] = qfrom_mat(mat_from_cols(f1, n1, np.cross(f1, n1)) @ B0.T)
        rel = qmul(qinv(QB[f]), end_rot[f])
        th = 2 * np.arctan2(np.dot(rel[:3], ax), rel[3]); th = (th + np.pi) % (2 * np.pi) - np.pi
        if prev is not None:
            th += 2 * np.pi * np.round((prev - th) / (2 * np.pi))
        prev = th; TH[f] = th
    if free is not None:
        fr = np.asarray(free) > 0.5
        idx = np.where(fr)[0]
        for seg in (np.split(idx, np.where(np.diff(idx) > 1)[0] + 1) if len(idx) else []):
            a_, b_ = seg[0], seg[-1]
            ref = b_ + 1 if b_ + 1 < F else b_
            off = 2 * np.pi * np.round(TH[ref] / (2 * np.pi))       # whole turns away from the short way at the segment's end
            if off == 0:
                continue
            ramp = np.linspace(0, 1, b_ - a_ + 1)
            TH[a_:b_ + 1] -= off * ramp
            TH[b_ + 1:] -= off
    share = np.broadcast_to(share, F)
    for f in range(F):
        gq[f, iu] = QA[f]; gq[f, il] = qmul(QB[f], qaxis(ax, TH[f] * share[f])); gq[f, ie] = end_rot[f]
    return gq


def arm_ik(rig, gq, root, side, palm, hq, pole, share=0.5, free=None):
    """two-bone arm IK with a per-frame forearm twist share (0 = the hand alone takes the twist; see two_bone_ex): a free hand
    sweeping through large orientation changes never accumulates a whole forearm twist turn, so blending into another arm
    solution later cannot swing the forearm through 180 deg"""
    F = len(gq)
    palm = np.broadcast_to(palm, (F, 3)); hq = np.broadcast_to(hq, (F, 4)).copy(); pole = np.broadcast_to(pole, (F, 3)).copy()
    share = np.broadcast_to(np.asarray(share, float), F).copy()
    HL = rig.hand[side]
    wrist = palm - qrot(hq, np.broadcast_to(HL['palm'] - HL['wrist'], (F, 3)))
    gp = fk_global(rig.sk, gq, root)
    lq_ref = rig.sk.local_from_global(gq)
    gq = two_bone_ex(rig, gq.copy(), gp, side + 'Arm', side + 'ForeArm', side + 'Hand', wrist, pole, hq, share, free)
    return rig.recompute_desc(lq_ref, gq, {side + 'Arm', side + 'ForeArm', side + 'Hand'})


def _hq(side, h, p):
    return hand_q(_RIG[0], side, np.asarray(h, float), np.asarray(p, float))


def hips_yaw_frame(gq, I):
    """per-frame yaw-only rotation of the pelvis"""
    fwd = qrot(gq[:, I['Hips']], np.broadcast_to([0, 0, 1.0], (len(gq), 3)))
    a = np.arctan2(fwd[:, 0], fwd[:, 2])
    return np.array([qaxis(Y, x) for x in a])


def choreo(rig, dur, root, body_keys, feet, hands=None, knee_pole=None, elbow_pole=None, fit=True, smooth_free=1.6, leg_smooth_from=0.0):
    """root: (F,3) hips path; body_keys: [(t, {bone: euler})]; feet: {side: keys}; hands: {side: keys} (palm targets).
    Returns gq, root, info"""
    _RIG[0] = rig
    I = rig.I
    F = len(root)
    t = np.arange(F) / FPS
    lq, _ = keyed(rig, [(k, dict(p, root=np.zeros(3))) for k, p in body_keys], dur)
    gq = rig.global_from_local(lq)
    info = {}
    # ---------------- legs
    legs = {}
    for side, keys in feet.items():
        sx = 1 if side == 'Left' else -1
        for k in keys:          # planted footprints given as (x, surface y | height field, z): ankle position for the foot rotation
            if k.get('f', 'w') == 'w' and 'hf' in k:
                q = foot_q(k['e'], side)
                k['p'] = ankle_on_field(side, k['p'][0], k['p'][2], q, k['hf'])
            elif k.get('f', 'w') == 'w' and 'surf' in k:
                q = foot_q(k['e'], side)
                k['p'] = ankle_on(side, k['p'][0], k['surf'], k['p'][2], q)
        pos, rot, wp = track(keys, t, root, side=side)
        planted = np.zeros(F, bool)
        kt = [k['t'] for k in keys]
        for i, k in enumerate(keys):
            if k.get('hold') and i + 1 < len(keys):
                planted |= (t >= k['t'] - 1e-6) & (t <= keys[i + 1]['t'] + 1e-6)
        yq = hips_yaw_frame(gq, I)
        pole = root + qrot(yq, np.broadcast_to([sx * 0.12, 0.15, 1.0], (F, 3))) if knee_pole is None else knee_pole(side, root, gq)
        legs[side] = dict(ank=pos, q=rot, planted=planted, pole=pole)
    if fit:
        root, drop = A.fit_root_to_feet(rig, gq, root, {sd: np.where(L['planted'][:, None], L['ank'], fk_global(rig.sk, gq, root)[:, I[sd + 'UpLeg']])
                                                       for sd, L in legs.items()}, slack=0.004)
        info['fit_drop'] = round(drop, 3)
    for side, L in legs.items():
        gq = leg_to(rig, gq, root, side, L['ank'], L['pole'], foot_q=L['q'])
    for side, L in legs.items():
        free = 1.0 - L['planted'].astype(float)
        free = np.minimum(free, np.convolve(np.pad(free, 2, mode='edge'), np.ones(5) / 5, 'valid'))
        if smooth_free:
            gq = A.smooth_locals(rig, gq, (side + 'UpLeg', side + 'Leg', side + 'Foot'), smooth_free, free)
            # second pass after leg_smooth_from (the hatch climb keeps its exact knee routing through the opening)
            gq = A.smooth_locals(rig, gq, (side + 'UpLeg', side + 'Leg', side + 'Foot'), smooth_free, free * smooth(np.clip((t - leg_smooth_from) / 0.2, 0, 1)))
    gq, _ = A.lift_feet(rig, gq, root, floor=0.0, smooth_n=1)        # swinging boots never under the ground
    gp = fk_global(rig.sk, gq, root)
    info['ankle_err'] = {sd: round(float(np.linalg.norm(gp[:, I[sd + 'Foot']] - L['ank'], axis=1)[L['planted']].max(initial=0)), 4) for sd, L in legs.items()}
    info['legs'] = legs
    # ---------------- arms (palm targets)
    if hands:
        chest = (gq[:, I['Spine1']], gp[:, I['Spine1']])
        info['hands'] = {}
        for side, keys in hands.items():
            sx = 1 if side == 'Left' else -1
            pos, rot, wp = track(keys, t, root, chest=chest, side=side, hand=True)
            planted = np.zeros(F, bool)
            for i, k in enumerate(keys):
                if k.get('hold') and i + 1 < len(keys):
                    planted |= (t >= k['t'] - 1e-6) & (t <= keys[i + 1]['t'] + 1e-6)
            pole = gp[:, I[side + 'Arm']] + qrot(chest[0], np.broadcast_to([sx * 0.45, -0.45, -0.25], (F, 3))) if elbow_pole is None else elbow_pole(side, gp, chest)
            gq = arm_ik(rig, gq, root, side, pos, rot, pole, 0.5, free=np.ones(F))
            info['hands'][side] = dict(palm=pos, q=rot, planted=planted)
        for side in hands:
            free = 1.0 - info['hands'][side]['planted'].astype(float)
            free = np.minimum(free, np.convolve(np.pad(free, 2, mode='edge'), np.ones(5) / 5, 'valid'))
            gq = A.smooth_locals(rig, gq, (side + 'Arm', side + 'ForeArm', side + 'Hand'), 2.2, free)
    return gq, root, info


def palm_world(rig, gq, root, side):
    HL = rig.hand[side]
    gp = fk_global(rig.sk, gq, root)
    i = rig.I[side + 'Hand']
    return gp[:, i] + qrot(gq[:, i], np.broadcast_to(HL['palm'] - HL['wrist'], (len(gq), 3)))


def fingers(rig, gq, curls):
    """curls: {side: (F, 3) (base, mid, thumb) deg}"""
    lq = rig.local(gq)
    F = len(lq)
    for side, c in curls.items():
        for f in range(F):
            tmp = lq[f:f + 1].copy()
            rig.finger_curl(tmp, side, *c[f])
            for b in (side + 'FingerBase', side + 'HandFinger1', 'LThumb' if side == 'Left' else 'RThumb'):
                lq[f, rig.I[b]] = tmp[0, rig.I[b]]
    return rig.global_from_local(lq)


def curl_track(keys, t):
    """(t, (base, mid, thumb)) keys -> (F, 3), smoothstep"""
    kt = np.array([k[0] for k in keys]); kv = np.array([k[1] for k in keys], float)
    out = np.zeros((len(t), 3))
    for f, tt in enumerate(t):
        j = int(np.clip(np.searchsorted(kt, tt, side='right') - 1, 0, len(kt) - 1))
        if j >= len(kt) - 1:
            out[f] = kv[-1]; continue
        w = smooth((tt - kt[j]) / max(kt[j + 1] - kt[j], 1e-6))
        out[f] = kv[j] * (1 - w) + kv[j + 1] * w
    return out


def blend_arms(rig, gq_a, gq_b, w, sides=('Left', 'Right')):
    """per-frame slerp of the arm + finger locals from pose a to pose b by w (F,)"""
    la, lb = rig.local(gq_a), rig.local(gq_b)
    out = la.copy()
    for side in sides:
        th = 'LThumb' if side == 'Left' else 'RThumb'
        for b in (side + 'Shoulder', side + 'Arm', side + 'ForeArm', side + 'Hand', side + 'FingerBase', side + 'HandFinger1', th):
            i = rig.I[b]
            out[:, i] = np.array([qslerp(la[f, i], lb[f, i], w[f]) for f in range(len(w))])
    return rig.global_from_local(out)


# ====================================================================================== shared poses
def crouch_walk_frame0():
    """crouch_walk frame 0 from the last full build (.cache/clips.pkl): local rotations + hips position.  The rifle dismounts end
    exactly in this pose (left foot forward, right heel up), entered with crouch_walk's ground speed."""
    import pickle, os
    c = pickle.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache', 'clips.pkl'), 'rb'))['crouch_walk']
    return c['lq'][0].copy(), c['root'][0].copy(), float(c['speed']), c['lq'], c['root']


# ====================================================================================== hatch exits (crew, hands free, PM holstered)
def _surf(name, x, z, veh=None, below=9.0):
    """surface height under the clip-frame point (x, z) on the primary vehicle (voxel top face minus half a voxel)"""
    veh = veh or LAYOUT[name]['veh'][0]
    return surface_y(name, veh, x, z, below)


def pistol_ready(rig, gq, root, crouch=True):
    """arms holding the PM at a compressed low ready in front of the belly (pistol_idle hold, carried by the chest)"""
    import clips_crew as CW
    CW.setup()
    I = rig.I
    low_p = np.array([-0.035, 1.08, 0.31]); low_q = qeuler(48, 3, 0, order='YXZ')
    gun_q, gun_p = A.gun_in_chest(rig.sk, gq, root, low_p, low_q)
    gp = fk_global(rig.sk, gq, root)
    out, err = CW.pistol_hold(rig, gq, root, gun_q, gun_p, poleR=gp[:, I['RightArm']] + [-0.35, -0.7, 0.0], poleL=gp[:, I['LeftArm']] + [0.35, -0.7, 0.0])
    return out, err


def _hatch_phase(L, H, seat_y, S, foot_out, T_OUT=1.98, lift=0.0, out_pitch=14.0):
    """shared first part of the hatch exits (0 .. T_OUT): crouched on the seat under the closed hatch, the right hand throws the lid
    open (0.30 s), both palms on the rim (0.40 / 0.50 s), dip, leg drive + arm pull, a stall and regrip (struggle), press until
    the hips clear the rim (1.48 s) with the hips over the inboard half of the opening (the knees stay inside it), right knee up and
    the right foot out onto the roof, the left leg follows, sits down on the outboard rim (T_OUT = 'out').
    foot_out: {side: (x, z)} where each foot is put down outside; lift: extra hip height while the legs come out (a hatch rim
    barely above a flat roof, BTR: the knees must clear the roof).  Returns root keys, body keys, foot keys, hand keys."""
    hx, ry, hz = H
    rr = L['rim_r']
    z_rim = hz + rr
    P = lambda **kw: kw
    rk = [(0.00, (hx, seat_y + 0.47, hz - 0.06)), (0.30, (hx, seat_y + 0.51, hz - 0.05)), (0.52, (hx, seat_y + 0.46, hz - 0.04)),
          (0.64, (hx, seat_y + 0.44, hz - 0.035)), (0.96, (hx, seat_y + 0.85, hz - 0.02)), (1.10, (hx + 0.01, seat_y + 0.94, hz - 0.01)),
          (1.22, (hx - 0.01, seat_y + 0.97, hz - 0.03)), (1.48, (hx, ry + 0.06 + lift * 0.6, hz - 0.08)), (1.68, (hx - 0.01, ry + 0.15 + lift, hz - 0.08)),
          (1.86, (hx - 0.02, ry + 0.17 + lift * 0.8, hz + 0.02)), (T_OUT, (hx - 0.03, ry + 0.115, z_rim - 0.03))]
    bk = [(0.00, P(Hips=(22, 0, 0), LowerBack=(8, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(-20, 0, 0), Head=(-22, 0, 0))),
          (0.30, P(Hips=(10, 6, 0), LowerBack=(4, 0, 0), Spine=(2, 4, 0), Spine1=(0, 4, 0), Neck=(-14, 0, 0), Head=(-18, -6, 0), RightShoulder=(0, 0, -18))),
          (0.60, P(Hips=(16, 0, 0), LowerBack=(6, 0, 0), Spine=(4, 0, 0), Spine1=(2, 0, 0), Neck=(-10, 0, 0), Head=(-6, 0, 0), LeftShoulder=(0, 0, 12), RightShoulder=(0, 0, -12))),
          (0.96, P(Hips=(12, 0, 0), LowerBack=(6, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(-6, 0, 0), Head=(-4, 0, 0), LeftShoulder=(0, 0, 18), RightShoulder=(0, 0, -18))),
          (1.10, P(Hips=(18, 5, -3), LowerBack=(8, -3, 2), Spine=(8, -4, 2), Spine1=(6, -3, 0), Neck=(-8, 4, 0), Head=(-6, 4, 0), LeftShoulder=(0, 0, 22), RightShoulder=(0, 0, -16))),
          (1.24, P(Hips=(22, -4, 3), LowerBack=(9, 3, -2), Spine=(9, 3, -2), Spine1=(7, 2, 0), Neck=(-10, -3, 0), Head=(-6, -4, 0), LeftShoulder=(0, 0, 16), RightShoulder=(0, 0, -22))),
          (1.48, P(Hips=(40, 0, 0), LowerBack=(10, 0, 0), Spine=(10, 0, 0), Spine1=(6, 0, 0), Neck=(-22, 0, 0), Head=(-12, 0, 0))),
          (1.72, P(Hips=(18, -16, -10), LowerBack=(8, 4, 2), Spine=(8, 4, 2), Spine1=(6, 2, 0), Neck=(-12, 0, 0), Head=(-6, 4, 0))),
          (T_OUT, P(Hips=(-20, -4, 0), LowerBack=(14, 2, 0), Spine=(14, 2, 0), Spine1=(10, 0, 0), Neck=(-6, 0, 0), Head=(10, 6, 0)))]
    W = lambda tt, x, z, ys=None, e=(0, 0, 0), hold=True, **kw: dict(t=tt, p=(x, 0, z), hf=S, e=e, hold=hold, **kw) if ys is None else dict(t=tt, p=(x, 0, z), surf=ys, e=e, hold=hold, **kw)
    R_ = lambda tt, x, y, z, e=(30, 0, 0), **kw: dict(t=tt, p=(x, y, z), f='r', e=e, **kw)
    (xl, zl), (xr, zr) = foot_out['Left'], foot_out['Right']
    fk = {'Left': [W(0.0, hx + 0.11, hz + 0.02, seat_y), W(0.80, hx + 0.11, hz + 0.02, seat_y, hold=False),
                   R_(1.20, 0.10, -0.82, -0.02, e=(40, 0, 0)), R_(1.56, 0.09, -0.80, 0.02, e=(40, 0, 0)), R_(1.72, 0.10, -0.48 + lift * 1.2, 0.14 - lift * 0.5, e=(35, -4, 0)),
                   dict(t=1.86, p=(hx + 0.11, ry + 0.10, hz + 0.16), e=(25, -4, 0)),
                   W(T_OUT + 0.04, xl, zl, e=(out_pitch, -6, 0), lift=0.05 + lift * 0.3)],
          'Right': [W(0.0, hx - 0.11, hz - 0.04, seat_y), W(0.76, hx - 0.11, hz - 0.04, seat_y, hold=False),
                    R_(1.18, -0.12, -0.82, -0.06, e=(40, 0, 0)), R_(1.40, -0.12, -0.72, 0.02, e=(40, 0, 0)), R_(1.54, -0.12, -0.24 + lift * 1.2, 0.12 - lift * 0.5, e=(30, 0, 0)),
                    dict(t=1.69, p=(hx - 0.13, ry + 0.14, hz + 0.16), e=(15, 0, 0)),
                    W(1.81, hx - 0.15, z_rim + 0.19, e=(-6, 6, 0)), W(1.92, hx - 0.15, z_rim + 0.19, e=(-6, 6, 0), hold=False),
                    W(2.04, xr, zr, e=(out_pitch, 8, 0))]}
    PD = lambda sx: ((sx * 0.25, 0, 1.0), (0, -1.0, 0))          # palm down, fingers forward / out
    PB = lambda sx: ((sx * 0.25, 0, -1.0), (0, -1.0, 0))         # palm down, fingers back (sitting, hands behind the hips)
    Hw = lambda tt, x, z, ys, hp, hold=True, **kw: dict(t=tt, p=(x, ys + PALM_UP, z), hp=hp, hold=hold, **kw)
    Hc = lambda tt, sx, x, y, z, h=(0.2, 0.9, 0.3), p=(-0.5, 0.0, 0.8): dict(t=tt, p=(sx * x, y, z), f='c', hp=((sx * h[0], h[1], h[2]), (sx * p[0], p[1], p[2])))
    r2 = rr - 0.03
    rim = lambda sx, dz=0.0: (hx + sx * np.sqrt(r2 ** 2 - dz ** 2), hz + dz)
    hk = {}
    for side, sx in (('Left', 1), ('Right', -1)):
        k = [Hc(0.0, sx, 0.22, 0.20, 0.26)] if side == 'Left' else [dict(t=0.0, p=(hx - 0.13, ry - 0.22, hz + 0.02), hp=((0, 0.6, 0.8), (0, 0.8, -0.6)))]
        xr_, zr_ = hx + sx * 0.42, hz + 0.24                     # regrip: palm on the roof outside the opening, front side
        yr_ = max(S(xr_ + dx_, zr_ + dz_) for dx_ in (-0.05, 0.05) for dz_ in (-0.06, 0.06))
        if side == 'Right':      # throws the lid open: palm up under it, shoves it up and forward
            k += [dict(t=0.10, p=(hx - 0.12, ry - 0.08, hz + 0.08), hp=((0, 0.2, 1.0), (0, 1.0, -0.2))),
                  dict(t=0.30, p=(hx - 0.10, ry + 0.32, hz + 0.18), hp=((0, 0.5, 1.0), (0, 0.6, -0.8))),
                  Hw(0.58, *rim(sx), ry, PD(sx)), Hw(1.02, *rim(sx), ry, PD(sx), hold=False),
                  Hw(1.22, xr_, zr_, yr_, PD(sx), lift=0.06), Hw(1.66, xr_, zr_, yr_, PD(sx), hold=False)]
        else:
            k = [dict(t=0.0, p=(hx + 0.13, ry - 0.20, hz - 0.03), hp=((0.1, 0.9, 0.3), (-0.6, 0.0, 0.8))),
                 dict(t=0.18, p=(hx + 0.12, ry - 0.10, hz - 0.02), hp=((0.1, 0.95, 0.2), (-0.6, 0.0, 0.8))),
                  Hw(0.40, *rim(sx), ry, PD(sx)), Hw(0.94, *rim(sx), ry, PD(sx), hold=False),
                  Hw(1.12, xr_, zr_, yr_, PD(sx), lift=0.06), Hw(1.76, xr_, zr_, yr_, PD(sx), hold=False)]
        xb, zb = rim(sx, 0.10)
        k += [Hw(1.92 if side == 'Left' else 1.86, xb, zb, ry, PB(sx))]
        hk[side] = k
    return rk, bk, fk, hk, (Hw, Hc, PB, rim)


def _hatch_poles(I, t, F, T_ARMS=1.85, T_LEGS=1.75):
    def epole(side, gp, chest):
        sx = 1 if side == 'Left' else -1
        w_in = np.clip((T_ARMS - t) / 0.2, 0, 1)[:, None]        # in the hatch / pressing on the rim: elbows down and back, inside the opening
        w_lo = smooth(np.clip((1.28 - t) / 0.14, 0, 1))[:, None]  # pulling on the rim (shoulders under it): elbows down, inside the opening
        w_op = smooth(np.clip((0.45 - t) / 0.15, 0, 1))[:, None]  # reaching up for the lid / rim: elbows out
        a = qrot(chest[0], np.broadcast_to([sx * 0.0, -0.85, -0.25], (F, 3))) * w_lo + qrot(chest[0], np.broadcast_to([sx * 0.30, -0.25, -0.60], (F, 3))) * (1 - w_lo)
        b = qrot(chest[0], np.broadcast_to([sx * 0.45, -0.45, -0.25], (F, 3)))
        if side == 'Right':      # the lid hand: elbow out while it shoves the lid (the left elbow stays inside the opening)
            a = a * (1 - w_op) + qrot(chest[0], np.broadcast_to([sx * 0.45, -0.55, -0.15], (F, 3))) * w_op
        return gp[:, I[side + 'Arm']] + a * w_in + b * (1 - w_in)
    def kpole(side, root_, gq_):
        sx = 1 if side == 'Left' else -1
        yq = hips_yaw_frame(gq_, I)
        w_in = np.clip((T_LEGS - t) / 0.2, 0, 1)[:, None]        # legs inside the hatch: knees forward but tucked in
        return root_ + qrot(yq, np.broadcast_to([sx * 0.18, 0.1, 1.0], (F, 3))) * (1 - w_in) + qrot(yq, np.broadcast_to([sx * 0.02, 0.1, 1.0], (F, 3))) * w_in
    return epole, kpole


def hatch_exit_tank(rig, lm, name='hatch_exit_tank'):
    """T-72 commander: throws the hatch open, presses up out of the cupola (struggle), right leg then left leg out, sits on the
    outboard rim, slides down the turret side onto the fender stowage boxes, stands, steps to the edge, jumps down, lands in a
    crouch and draws the PM (shown for the last 0.5 s)."""
    L = LAYOUT[name]
    I = rig.I
    dur = 4.40
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    H = v2c(name, L['hatch'])                 # (0.25, 2.28, -1.92)
    hx, ry, hz = H
    S = lambda x, z: _surf(name, x, z)
    seat_y = ry - 1.30                        # commander's seat / footrest inside (hidden by the turret)
    z_rim = hz + L['rim_r']                   # outboard rim (-1.61)
    y_box = S(0.0, -0.95)                     # fender stowage box tops (1.455)
    z_bin = -1.22                             # turret-side bin edge (1.86)
    T_OUT, T_OFF, T_TD = 1.98, 3.27, 3.78
    xs = lambda tt: hx * (1 - smooth(np.clip((tt - 2.0) / 0.9, 0, 1)))          # drift from the hatch station to the box station
    zs = -1.36                                # feet on the turret side plate while sitting on the rim (~1.9 m, ~50 deg)
    rk, bk, fk, hk, (Hw, Hc, PB, rim) = _hatch_phase(L, H, seat_y, S, {'Left': (hx + 0.10, zs - 0.02), 'Right': (hx - 0.14, zs + 0.02)}, T_OUT, out_pitch=30.0)
    # ---------------------------------------------------------------- hips path
    keys = rk + [(2.18, (xs(2.18), ry + 0.09, z_rim + 0.05)),
                 (2.48, (xs(2.48), S(xs(2.48), z_bin - 0.04) + 0.14, z_bin - 0.05)), (2.62, (xs(2.62), S(xs(2.62), z_bin - 0.04) + 0.15, z_bin - 0.01)),
                 (2.86, (xs(2.86), y_box + 0.70, -0.99)), (3.02, (0, y_box + 0.74, -0.90)),
                 (3.20, (0, y_box + 0.52, -0.80)), (T_OFF, (0, y_box + 0.55, -0.76)), (T_TD, (0, 0.86, -0.06)),
                 (3.92, (0, 0.58, -0.02)), (4.10, (0, 0.62, 0.0)), (dur, (0, 0.66, 0.0))]
    root = root_path(keys, dur, flights=[(T_OFF, T_TD)])
    # ---------------------------------------------------------------- trunk / head
    P = lambda **kw: kw
    bk = bk + [(2.18, P(Hips=(-28, -6, 0), LowerBack=(14, 0, 0), Spine=(12, 0, 0), Spine1=(8, 0, 0), Neck=(-4, 0, 0), Head=(14, -4, 0))),
               (2.48, P(Hips=(-16, -4, 0), LowerBack=(16, 0, 0), Spine=(14, 0, 0), Spine1=(10, 0, 0), Neck=(-8, 0, 0), Head=(10, -6, 0))),
               (2.62, P(Hips=(8, 0, 0), LowerBack=(16, 0, 0), Spine=(14, 0, 0), Spine1=(10, 0, 0), Neck=(-14, 0, 0), Head=(6, 0, 0))),
               (2.86, P(Hips=(30, 0, 0), LowerBack=(12, 0, 0), Spine=(8, 0, 0), Spine1=(6, 0, 0), Neck=(-16, 0, 0), Head=(0, 0, 0))),
               (3.02, P(Hips=(18, 0, 0), LowerBack=(6, 0, 0), Spine=(5, 0, 0), Spine1=(4, 0, 0), Neck=(-8, 0, 0), Head=(8, 0, 0))),
               (3.20, P(Hips=(38, 0, 0), LowerBack=(12, 0, 0), Spine=(10, 0, 0), Spine1=(6, 0, 0), Neck=(-20, 0, 0), Head=(4, 0, 0))),
               (T_OFF, P(Hips=(24, 0, 0), LowerBack=(8, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(-12, 0, 0), Head=(6, 0, 0))),
               (3.55, P(Hips=(6, 0, 0), LowerBack=(4, 0, 0), Spine=(3, 0, 0), Spine1=(2, 0, 0), Neck=(-4, 0, 0), Head=(10, 0, 0))),
               (T_TD, P(Hips=(16, 0, 0), LowerBack=(6, 0, 0), Spine=(5, 0, 0), Spine1=(3, 0, 0), Neck=(-8, 0, 0), Head=(6, 0, 0))),
               (3.92, P(Hips=(42, -4, 0), LowerBack=(12, 0, 0), Spine=(10, 0, 0), Spine1=(6, 0, 0), Neck=(-22, 0, 0), Head=(-4, 0, 0))),
               (4.10, P(Hips=(30, -8, 0), LowerBack=(9, 2, 0), Spine=(7, 2, 0), Spine1=(5, 2, 0), Neck=(-14, 0, 0), Head=(-4, 14, 0))),
               (dur, P(Hips=(24, -6, 0), LowerBack=(8, 2, 0), Spine=(6, 3, 0), Spine1=(4, 2, 0), Neck=(-12, 0, 0), Head=(-6, -10, 0)))]
    # ---------------------------------------------------------------- feet
    W = lambda tt, x, z, ys=None, e=(0, 0, 0), hold=True, **kw: dict(t=tt, p=(x, 0, z), hf=S, e=e, hold=hold, **kw) if ys is None else dict(t=tt, p=(x, 0, z), surf=ys, e=e, hold=hold, **kw)
    R_ = lambda tt, x, y, z, e=(30, 0, 0), **kw: dict(t=tt, p=(x, y, z), f='r', e=e, **kw)
    fk['Left'] += [W(2.20, hx + 0.10, zs - 0.02, e=(30, -6, 0), hold=False),
                   W(2.46, 0.14, -0.98, y_box, e=(0, -6, 0), via=('w', (0.14, 1.98, -1.10))), W(3.04, 0.14, -0.98, y_box, e=(0, -6, 0), hold=False),
                   W(3.14, 0.13, -0.80, y_box, e=(0, -6, 0), lift=0.06), W(T_OFF, 0.13, -0.80, y_box, e=(0, -6, 0), hold=False),
                   R_(T_OFF + 0.09, 0.13, -0.42, 0.02, e=(30, -6, 0)), R_(3.55, 0.13, -0.70, 0.14, e=(12, -6, 0)), R_(T_TD - 0.06, 0.13, -0.82, 0.10, e=(4, -8, 0)),
                   W(T_TD, 0.13, 0.03, 0.0, e=(0, -8, 0)), W(dur, 0.13, 0.03, 0.0, e=(0, -8, 0))]
    fk['Right'] += [W(2.22, hx - 0.14, zs + 0.02, e=(30, 8, 0), hold=False),
                    W(2.50, -0.14, -1.02, y_box, e=(0, 8, 0), via=('w', (-0.10, 1.98, -1.12))), W(3.06, -0.14, -1.02, y_box, e=(0, 8, 0), hold=False),
                    W(3.16, -0.13, -0.84, y_box, e=(0, 8, 0), lift=0.06), W(T_OFF, -0.13, -0.84, y_box, e=(0, 8, 0), hold=False),
                    R_(T_OFF + 0.09, -0.13, -0.40, -0.06, e=(30, 8, 0)), R_(3.55, -0.13, -0.72, 0.06, e=(12, 8, 0)), R_(T_TD - 0.06, -0.14, -0.82, -0.08, e=(4, 12, 0)),
                    W(T_TD + 0.02, -0.14, -0.20, 0.0, e=(0, 12, 0)), W(dur, -0.14, -0.20, 0.0, e=(0, 12, 0))]
    # ---------------------------------------------------------------- hands
    zt = z_bin - 0.03
    for side, sx in (('Left', 1), ('Right', -1)):
        xb, zb = rim(sx, 0.10)
        xh = xs(2.5) + sx * 0.22
        hk[side] += [Hw(2.20, xb, zb, ry, PB(sx), hold=False),
                     Hw(2.45, xh, zt, S(xh, zt), PB(sx), lift=0.16), Hw(2.64, xh, zt, S(xh, zt), PB(sx), hold=False),
                     Hc(2.90, sx, 0.30, -0.10, 0.30, h=(0.3, -0.3, 0.9), p=(-0.8, -0.3, 0.0)), Hc(3.20, sx, 0.34, -0.18, 0.34, h=(0.3, -0.3, 0.9), p=(-0.8, -0.3, 0.0)),
                     Hc(T_OFF, sx, 0.36, -0.10, 0.30, h=(0.3, -0.3, 0.9), p=(-0.8, -0.3, 0.0)),
                     Hc(3.55, sx, 0.40, 0.10, 0.18, h=(0.5, 0.1, 0.8), p=(-0.8, -0.3, 0.0)), Hc(T_TD, sx, 0.34, -0.05, 0.30, h=(0.3, -0.3, 0.9), p=(-0.8, -0.3, 0.0)),
                     Hc(3.92, sx, 0.28, -0.30, 0.36, h=(0.3, -0.3, 0.9), p=(-0.8, -0.3, 0.0)), Hc(4.10, sx, 0.24, -0.26, 0.30, h=(0.3, -0.3, 0.9), p=(-0.8, -0.3, 0.0)),
                     Hc(dur, sx, 0.22, -0.24, 0.30, h=(0.3, -0.3, 0.9), p=(-0.8, -0.3, 0.0))]
    epole, kpole = _hatch_poles(I, t, F)
    gq, root, info = choreo(rig, dur, root, bk, fk, hk, knee_pole=kpole, elbow_pole=epole, leg_smooth_from=2.0)
    ev = {'hatch_open': 0.30, 'hands_on_rim': [0.40, 1.02], 'regrip_on_roof': [1.12, 1.66], 'hips_clear': 1.48, 'out': T_OUT, 'on_fender': 2.50, 'jump': T_OFF,
          'ground': T_TD, 'draw': round(dur - 0.5, 3)}
    gq = crew_finish(rig, gq, root, info, dur, t)
    return gq, root, info, ev, dur


def hatch_exit_btr(rig, lm, name='hatch_exit_btr'):
    """BTR-80/82 commander: throws the roof hatch open, presses up and out (struggle), legs out, sits on the outboard rim, scoots
    to the roof edge, slides down the 49 deg upper side plate on the seat with the hands braking on the roof edge, feet onto the
    chine, pushes off and drops 1.25 m beside the front wheel, lands in a crouch and draws the PM."""
    L = LAYOUT[name]
    I = rig.I
    dur = 4.20
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    H = v2c(name, L['hatch'])
    hx, hz = H[0], H[2]
    S = lambda x, z: _surf(name, x, z)
    ry = S(hx, hz)                            # hatch rim (closed lid in the model) ~2.03
    H = np.array([hx, ry, hz])
    seat_y = ry - 1.30
    z_rim = hz + L['rim_r']
    z_edge = v2c(name, (-0.92, 0, L['end'][1]))[2]      # roof edge (-1.23)
    z_chine = v2c(name, (-1.31, 0, L['end'][1]))[2]     # on the side plate above the chine (-0.84)
    T_OUT, T_OFF, T_TD = 1.98, 3.05, 3.55
    rk, bk, fk, hk, (Hw, Hc, PB, rim) = _hatch_phase(L, H, seat_y, S, {'Left': (hx + 0.10, z_edge + 0.11), 'Right': (hx - 0.14, z_edge + 0.15)}, T_OUT, lift=0.12)
    xs = lambda tt: hx * (1 - smooth(np.clip((tt - 2.0) / 0.8, 0, 1)))
    # ---------------------------------------------------------------- hips path
    keys = rk + [(2.18, (xs(2.18), S(xs(2.18), -1.36) + 0.125, -1.36)), (2.42, (xs(2.42), S(xs(2.42), z_edge - 0.06) + 0.125, z_edge - 0.04)),
                 (2.62, (0, 2.00, z_edge + 0.07)), (2.85, (0, S(0, -1.10) + 0.09, -1.00)), (2.98, (0, S(0, -1.10) + 0.07, -0.97)),
                 (T_OFF, (0, S(0, -1.10) + 0.10, -0.93)), (T_TD, (0, 0.86, -0.06)),
                 (3.70, (0, 0.58, -0.02)), (3.88, (0, 0.62, 0.0)), (dur, (0, 0.66, 0.0))]
    root = root_path(keys, dur, flights=[(T_OFF, T_TD)])
    P = lambda **kw: kw
    bk = bk + [(2.18, P(Hips=(-24, -4, 0), LowerBack=(14, 0, 0), Spine=(12, 0, 0), Spine1=(8, 0, 0), Neck=(-4, 0, 0), Head=(16, -4, 0))),
               (2.42, P(Hips=(-22, 0, 0), LowerBack=(14, 0, 0), Spine=(12, 0, 0), Spine1=(8, 0, 0), Neck=(-2, 0, 0), Head=(18, 4, 0))),
               (2.62, P(Hips=(-32, 0, 0), LowerBack=(12, 0, 0), Spine=(10, 0, 0), Spine1=(8, 0, 0), Neck=(0, 0, 0), Head=(16, 0, 0))),
               (2.85, P(Hips=(-38, 0, 0), LowerBack=(14, 0, 0), Spine=(12, 0, 0), Spine1=(10, 0, 0), Neck=(-2, 0, 0), Head=(16, 0, 0))),
               (2.98, P(Hips=(-16, 0, 0), LowerBack=(14, 0, 0), Spine=(12, 0, 0), Spine1=(8, 0, 0), Neck=(-8, 0, 0), Head=(12, 0, 0))),
               (T_OFF, P(Hips=(12, 0, 0), LowerBack=(8, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(-10, 0, 0), Head=(8, 0, 0))),
               (3.30, P(Hips=(6, 0, 0), LowerBack=(4, 0, 0), Spine=(3, 0, 0), Spine1=(2, 0, 0), Neck=(-4, 0, 0), Head=(10, 0, 0))),
               (T_TD, P(Hips=(16, 0, 0), LowerBack=(6, 0, 0), Spine=(5, 0, 0), Spine1=(3, 0, 0), Neck=(-8, 0, 0), Head=(6, 0, 0))),
               (3.70, P(Hips=(42, -4, 0), LowerBack=(12, 0, 0), Spine=(10, 0, 0), Spine1=(6, 0, 0), Neck=(-22, 0, 0), Head=(-4, 0, 0))),
               (3.88, P(Hips=(30, -8, 0), LowerBack=(9, 2, 0), Spine=(7, 2, 0), Spine1=(5, 2, 0), Neck=(-14, 0, 0), Head=(-4, 14, 0))),
               (dur, P(Hips=(24, -6, 0), LowerBack=(8, 2, 0), Spine=(6, 3, 0), Spine1=(4, 2, 0), Neck=(-12, 0, 0), Head=(-6, -10, 0)))]
    W = lambda tt, x, z, ys=None, e=(0, 0, 0), hold=True, **kw: dict(t=tt, p=(x, 0, z), hf=S, e=e, hold=hold, **kw) if ys is None else dict(t=tt, p=(x, 0, z), surf=ys, e=e, hold=hold, **kw)
    R_ = lambda tt, x, y, z, e=(30, 0, 0), **kw: dict(t=tt, p=(x, y, z), f='r', e=e, **kw)
    SL = (49, 0, 0)                           # sole along the 49 deg side plate (toes down the slope)
    fk['Left'] += [W(2.20, hx + 0.10, z_edge + 0.11, e=(14, -6, 0), hold=False),
                   W(2.42, 0.13, -0.92, e=(49, -6, 0)), W(2.56, 0.13, -0.92, e=(49, -6, 0), hold=False),
                   W(2.84, 0.13, z_chine, e=SL), W(T_OFF, 0.13, z_chine, e=SL, hold=False),
                   R_(T_OFF + 0.08, 0.13, -0.50, 0.26, e=(30, -6, 0)), R_(3.30, 0.13, -0.70, 0.18, e=(12, -6, 0)), R_(T_TD - 0.06, 0.13, -0.82, 0.10, e=(4, -8, 0)),
                   W(T_TD, 0.13, 0.03, 0.0, e=(0, -8, 0)), W(dur, 0.13, 0.03, 0.0, e=(0, -8, 0))]
    fk['Right'] += [W(2.22, hx - 0.14, z_edge + 0.15, e=(14, 8, 0), hold=False),
                    W(2.44, -0.13, -0.90, e=(49, 8, 0)), W(2.58, -0.13, -0.90, e=(49, 8, 0), hold=False),
                    W(2.86, -0.13, z_chine + 0.02, e=SL), W(T_OFF, -0.13, z_chine + 0.02, e=SL, hold=False),
                    R_(T_OFF + 0.08, -0.13, -0.50, 0.20, e=(30, 8, 0)), R_(3.30, -0.13, -0.72, 0.10, e=(12, 8, 0)), R_(T_TD - 0.06, -0.14, -0.82, -0.08, e=(4, 12, 0)),
                    W(T_TD + 0.02, -0.14, -0.20, 0.0, e=(0, 12, 0)), W(dur, -0.14, -0.20, 0.0, e=(0, 12, 0))]
    CH = dict(h=(0.3, -0.3, 0.9), p=(-0.8, -0.3, 0.0))
    for side, sx in (('Left', 1), ('Right', -1)):
        xb, zb = rim(sx, 0.10)
        x1 = sx * 0.27
        hk[side] += [Hw(2.08, xb, zb, ry, PB(sx), hold=False),
                     Hw(2.22, xs(2.3) + x1, -1.46, S(xs(2.3) + x1, -1.46), PB(sx), lift=0.06), Hw(2.42, xs(2.3) + x1, -1.46, S(xs(2.3) + x1, -1.46), PB(sx), hold=False),
                     Hw(2.58, x1, z_edge - 0.09, S(x1, z_edge - 0.09), PB(sx), lift=0.05), Hw(T_OFF - 0.04, x1, z_edge - 0.09, S(x1, z_edge - 0.09), PB(sx), hold=False),
                     Hc(T_OFF + 0.12, sx, 0.42, 0.05, -0.02, h=(0.6, 0.0, -0.2), p=(0.0, -1.0, 0.0)),
                     Hc(3.36, sx, 0.42, 0.08, 0.14, h=(0.5, 0.1, 0.8), p=(-0.8, -0.3, 0.0)), Hc(T_TD, sx, 0.34, -0.05, 0.30, **CH),
                     Hc(3.70, sx, 0.28, -0.30, 0.36, **CH), Hc(3.88, sx, 0.24, -0.26, 0.30, **CH), Hc(dur, sx, 0.22, -0.24, 0.30, **CH)]
    epole, kpole = _hatch_poles(I, t, F)
    def epole2(side, gp, chest):         # braking on the roof edge behind: elbows back
        sx = 1 if side == 'Left' else -1
        w = (smooth(np.clip((t - 2.0) / 0.2, 0, 1)) * (1 - smooth(np.clip((t - T_OFF) / 0.2, 0, 1))))[:, None]
        return epole(side, gp, chest) * (1 - w) + (gp[:, I[side + 'Arm']] + qrot(chest[0], np.broadcast_to([sx * 0.35, 0.0, -0.6], (F, 3)))) * w
    gq, root, info = choreo(rig, dur, root, bk, fk, hk, knee_pole=kpole, elbow_pole=epole2, leg_smooth_from=2.0)
    ev = {'hatch_open': 0.30, 'hands_on_rim': [0.40, 1.02], 'regrip_on_roof': [1.12, 1.66], 'hips_clear': 1.48, 'out': T_OUT, 'slide': [2.62, 2.85], 'jump': T_OFF,
          'ground': T_TD, 'draw': round(dur - 0.5, 3)}
    gq = crew_finish(rig, gq, root, info, dur, t)
    return gq, root, info, ev, dur


def crew_finish(rig, gq, root, info, dur, t):
    """fingers (flat on contacts, relaxed when free) + PM draw: right hand to the holster, the PM appears in weapon_socket at
    dur - 0.5 (the game shows it for the last 0.5 s), both hands at a compressed low ready by the end"""
    I = rig.I
    F = len(gq)
    T_DRAW = dur - 0.50
    curls = {}
    for side in ('Left', 'Right'):
        pl = info['hands'][side]['planted'].astype(float)
        pl = np.convolve(np.pad(pl, 3, mode='edge'), np.ones(7) / 7, 'valid')
        curls[side] = np.outer(1 - pl, [22, 30, 12]) + np.outer(pl, [10, 14, 6])
    gq = fingers(rig, gq, curls)
    gpr, perr = pistol_ready(rig, gq, root)
    gp = fk_global(rig.sk, gq, root)
    hq_ = gq[:, I['Hips']]
    hol = gp[:, I['Hips']] + qrot(hq_, np.broadcast_to([-0.21, -0.03, -0.03], (F, 3)))
    hq = _hq('Right', qrot(hq_, np.broadcast_to([0, -1.0, 0.15], (F, 3))), qrot(hq_, np.broadcast_to([1.0, 0, 0], (F, 3))))
    gh = arm_ik(rig, gq, root, 'Right', hol, hq, gp[:, I['RightArm']] + qrot(gq[:, I['Spine1']], np.broadcast_to([-0.45, -0.1, -0.5], (F, 3))), 0.5, free=np.ones(F))
    lqh = rig.local(gh); rig.finger_curl(lqh, 'Right', 45, 60, 20); gh = rig.global_from_local(lqh)
    w_hol = smooth(np.clip((t - (T_DRAW - 0.26)) / 0.24, 0, 1))
    w_draw = smooth(np.clip((t - T_DRAW) / 0.30, 0, 1))
    gq = blend_arms(rig, gq, gh, w_hol, sides=('Right',))
    gq = blend_arms(rig, gq, gpr, w_draw, sides=('Right',))
    gq = blend_arms(rig, gq, gpr, smooth(np.clip((t - (T_DRAW + 0.10)) / 0.30, 0, 1)), sides=('Left',))
    return gq


def debug_report(name, rig, gq, root, info, veh=None):
    """contacts + vehicle penetration summary (dev)"""
    I = rig.I
    F = len(gq); t = np.arange(F) / FPS
    gp = fk_global(rig.sk, gq, root)
    print(f'--- {name}: fit_drop {info.get("fit_drop")} ankle_err {info.get("ankle_err")}')
    for side, L in info['legs'].items():
        so = A.sole_world(rig, gq, root, side)
        low = so[..., 1].min(1)
        idx = np.where(L['planted'])[0]
        if len(idx):
            for seg in np.split(idx, np.where(np.diff(idx) > 1)[0] + 1):
                c = so[seg].mean(1)
                print(f'  {side} plant {t[seg[0]]:.2f}-{t[seg[-1]]:.2f}: sole low {low[seg].min():.3f}..{low[seg].max():.3f} slide {np.linalg.norm(c[:, [0, 2]] - c[:1, [0, 2]], axis=1).max():.3f}')
    if 'hands' in info:
        for side, Hh in info['hands'].items():
            pw = palm_world(rig, gq, root, side)
            e = np.linalg.norm(pw - Hh['palm'], axis=1)
            idx = np.where(Hh['planted'])[0]
            segs = np.split(idx, np.where(np.diff(idx) > 1)[0] + 1) if len(idx) else []
            print(f'  {side} palm err all max {e.max():.3f} @ {t[np.argmax(e)]:.2f}; planted:',
                  ', '.join(f'{t[sg[0]]:.2f}-{t[sg[-1]]:.2f}: err {e[sg].max():.3f} slide {np.linalg.norm(pw[sg] - pw[sg[0]], axis=1).max():.3f}' for sg in segs))
    for v in (LAYOUT[name]['veh'] if veh is None else veh):
        rad = {b: 0.05 for b in rig.sk.names}
        for b, r in (('Hips', 0.10), ('LowerBack', 0.10), ('Spine', 0.11), ('Spine1', 0.12), ('Neck', 0.06), ('Head', 0.10), ('LeftHand', 0.03), ('RightHand', 0.03),
                     ('LeftFoot', 0.04), ('RightFoot', 0.04), ('LeftToeBase', 0.025), ('RightToeBase', 0.025), ('LeftUpLeg', 0.07), ('RightUpLeg', 0.07),
                     ('LeftLeg', 0.05), ('RightLeg', 0.05), ('LeftForeArm', 0.04), ('RightForeArm', 0.04)):
            rad[b] = r
        names = [b for b in rig.sk.names if not b.endswith(('Thumb', 'FingerBase', 'Finger1')) and b not in ('LHipJoint', 'RHipJoint', 'Neck1')]
        worst = []
        for b in names:
            d = vehicle_depth(name, v, gp[:, I[b]], rad[b])
            worst.append((d.max(), b, int(np.argmax(d))))
        worst.sort(reverse=True)
        print(f'  {v}: worst joint pen', [(round(w, 3), b, f'{t[f]:.2f}s') for w, b, f in worst[:5]])


# ====================================================================================== rifle dismounts
BUILT = {}          # clips built earlier in the same build_anims run (preferred over the cached full set)


def _clip_pose(name):
    if name in BUILT:
        return BUILT[name]
    import pickle, os
    c = pickle.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache', 'clips.pkl'), 'rb'))[name]
    return c


def rifle_arms(rig, gq, root, t, gun_w, left_keys, w_grip, ride=None, poleR_off=(-0.4, -0.6, -0.2), poleL_free=(0.45, -0.3, -0.45)):
    """right hand on the rifle, left hand on the handguard (weight w_grip) or on its own keyed targets.
    gun_w: list of (weight (F,), source) with source 'low_ready' | 'port' | 'compact' | ('ride', gun_q, gun_p); weights are blended
    in order (each slerps the running pose toward its source)"""
    I = rig.I
    F = len(gq)
    gun_q = gun_p = None
    for w, src in gun_w:
        if isinstance(src, tuple):
            q_, p_ = src[1], src[2]
        else:
            p0, q0 = C.gun_rest(src) if src in C.GUNPOSE else GUNS[src]
            q_, p_ = A.gun_in_chest(rig.sk, gq, root, p0, q0)
        if gun_q is None:
            gun_q, gun_p = q_.copy(), p_.copy()
        else:
            gun_q = np.array([qslerp(gun_q[f], q_[f], w[f]) for f in range(F)])
            gun_p = gun_p * (1 - w[:, None]) + p_ * w[:, None]
    from qmath import qfrom_mat
    HL = rig.hand['Left']
    RL = qfrom_mat(rig.gunL @ HL['F'].T)
    grip_t = gun_p + qrot(gun_q, np.broadcast_to(A.GUN['ak74m']['grip_L'] + [0, -0.018, 0], (F, 3)))
    grip_r = qmul(gun_q, np.broadcast_to(RL, (F, 4)))
    gp = fk_global(rig.sk, gq, root)
    chest = (gq[:, I['Spine1']], gp[:, I['Spine1']])
    _RIG[0] = rig
    kt, kr, kw = track(left_keys, t, root, chest=chest, side='Left', hand=True)
    planted = np.zeros(F, bool)
    for i, k in enumerate(left_keys):
        if k.get('hold') and i + 1 < len(left_keys):
            planted |= (t >= k['t'] - 1e-6) & (t <= left_keys[i + 1]['t'] + 1e-6)
    ltgt = grip_t * w_grip[:, None] + kt * (1 - w_grip[:, None])
    lrot = np.array([qslerp(kr[f], grip_r[f], w_grip[f]) for f in range(F)])
    poleL = gp[:, I['LeftArm']] + np.outer(w_grip, [0.25, -0.7, -0.1]) + (1 - w_grip[:, None]) * qrot(chest[0], np.broadcast_to(np.asarray(poleL_free, float), (F, 3)))
    out, err = A.rifle_overlay(rig, gq, root, gun_q, gun_p, left='target', left_target=ltgt, left_rot=lrot,
                               poleR=gp[:, I['RightArm']] + np.asarray(poleR_off), poleL=poleL)
    if (w_grip < 0.999).any():                # free left hand: no forearm twist accumulation (see arm_ik)
        gpo = fk_global(rig.sk, out, root)
        poleL2 = gpo[:, I['LeftArm']] + np.outer(w_grip, [0.25, -0.7, -0.1]) + (1 - w_grip[:, None]) * qrot(chest[0], np.broadcast_to(np.asarray(poleL_free, float), (F, 3)))
        out = arm_ik(rig, out, root, 'Left', ltgt, lrot, poleL2, 0.5, free=(w_grip < 0.98).astype(float))
    out = A.smooth_locals(rig, out, ('LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'), 2.2, np.minimum(1, 2 * (1 - w_grip)) * (1 - planted))
    # left fingers: grip curl on the handguard, flat on a contact, relaxed otherwise
    pl = np.convolve(np.pad(planted.astype(float), 3, mode='edge'), np.ones(7) / 7, 'valid')
    c = np.outer(w_grip, [60, 75, 20]) + np.outer((1 - w_grip) * pl, [10, 14, 6]) + np.outer((1 - w_grip) * (1 - pl), [22, 30, 12])
    out = fingers(rig, out, {'Left': c})
    return out, err, (gun_q, gun_p), dict(palm=ltgt, planted=planted)


def finish_into(rig, gq, root, t, lq_end, root_end, T0, rifle=True):
    """blend the local pose (all joints) and the hips onto (lq_end, root_end) from T0 to the last frame (exact at the end).
    rifle: the arms are re-solved on the blended body (low ready, both hands on the rifle, crouch_walk's poles) instead of blended
    (blending two IK arm solutions can swing the forearm twist through 180 deg), then the last 3 frames blend to the exact pose"""
    F = len(t)
    w = smooth(np.clip((t - T0) / max(t[-1] - T0, 1e-6), 0, 1))
    lq = rig.local(gq)
    for i in range(lq.shape[1]):
        lq[:, i] = np.array([qslerp(lq[f, i], lq_end[i], w[f]) for f in range(F)])
    root = root * (1 - w[:, None]) + root_end[None] * w[:, None]
    gq2 = rig.global_from_local(lq)
    if rifle:
        m = t >= T0 - 0.15
        sub, err = C.carry(rig, gq2[m], root[m], 'low_ready')
        wa = smooth(np.clip((t[m] - (T0 - 0.15)) / 0.15, 0, 1))
        gq2[m] = blend_arms(rig, gq2[m], sub, wa)
        lq = rig.local(gq2)
        w3 = smooth(np.clip((t - t[-4]) / max(t[-1] - t[-4], 1e-6), 0, 1))
        for i in range(lq.shape[1]):
            lq[:, i] = np.array([qslerp(lq[f, i], lq_end[i], w3[f]) for f in range(F)])
        gq2 = rig.global_from_local(lq)
    return gq2, root


def cw_end():
    """crouch_walk frame 0: locals, hips, ground speed, feet (ankle positions + global foot rotations) - rifle dismount end pose"""
    c = _clip_pose('crouch_walk')
    rig = _RIG[0]
    gq = rig.global_from_local(c['lq'][:1])
    gp = fk_global(rig.sk, gq, c['root'][:1])
    I = rig.I
    feet = {sd: (gp[0, I[sd + 'Foot']], gq[0, I[sd + 'Foot']]) for sd in ('Left', 'Right')}
    return c['lq'][0], c['root'][0], float(c['speed']), feet


GUNS = {'compact': (np.array([-0.10, 1.16, 0.24]), qeuler(-20, 28, -20, order='YXZ')),     # muzzle up across the chest (one hand)
        'jump': (np.array([-0.14, 1.12, 0.20]), qeuler(-58, 22, -12, order='YXZ'))}       # one-hand port, muzzle high (jumping)


def _edge_z(name):
    """clip-frame z of the deck edge in front of the seat: last point (straight out from the seat) whose surface is within 0.10 m
    of the seat height"""
    L = LAYOUT[name]
    Sv = v2c(name, L['seat'])
    z = Sv[2]
    while z < -0.2 and _surf(name, 0.0, z + 0.01) > Sv[1] - 0.10:
        z += 0.01
    return float(z)


_JT = {}


def _butt_floor(name, zh):
    """highest deck point under the seated buttocks with the hips at clip z zh (seat point 0.035 m ahead of the hips)"""
    return max(_surf(name, x, zh + 0.035 + dz) for x in (-0.10, 0.0, 0.10) for dz in (-0.08, 0.0, 0.06))


def jump_times(name):
    """phase times (s) and key heights of a dismount_jump variant, from its seat / deck edge / drop height:
    hand (left palm on the deck), sc0 (butt starts sliding to the edge), edge (butt at the edge), off (leaves the deck),
    td (touchdown), absorb (deepest), step (left foot steps out), dur"""
    if name in _JT:
        return _JT[name]
    L = LAYOUT[name]
    Sv = v2c(name, L['seat'])
    ze = _edge_z(name)
    h0z = Sv[2] - 0.035
    z_hip_edge = max(h0z, ze - 0.10)
    y_hip_edge = _butt_floor(name, z_hip_edge) + 0.118
    h_off = y_hip_edge + 0.05
    land_y = 0.85
    drop = h_off - land_y
    vy0 = 0.30                                                   # small upward push off the deck
    flight = (vy0 + np.sqrt(vy0 ** 2 + 2 * G * drop)) / G
    scoot = z_hip_edge - h0z
    T = dict(hand=0.40, sc0=0.42)
    T['edge'] = T['sc0'] + max(0.18, scoot / 0.95)
    T['off'] = T['edge'] + 0.16
    T['td'] = T['off'] + flight
    T['absorb'] = T['td'] + 0.15 + 0.04 * min(drop, 1.3)
    T['step'] = T['td'] + 0.58
    T['dur'] = round((T['step'] + 0.30) * FPS) / FPS
    T.update(seat=Sv, z_edge=ze, z_hip_edge=z_hip_edge, y_hip_edge=y_hip_edge, h_off=h_off, land_y=land_y, drop=drop, flight=flight, scoot=scoot,
             absorb_y=0.62 - 0.10 * min(drop, 1.3))
    _JT[name] = T
    return T


def dismount_jump(rig, lm, name='dismount_jump_btr'):
    """rider on an edge seat (ride_sit_edge frame 0 at the seat point) gets off: looks down at his landing spot, right hand takes the
    rifle to a one-hand port (muzzle high), left hand comes off the handguard and plants on the deck beside the hip, the butt
    slides to the edge on that arm (re-plants at the edge on a long BTR slide), weight forward, push off the palm (and the boots on
    a sloped plate), short ballistic drop with the knees coming up and the legs reaching for the ground, lands left-right, deep
    absorb (pelvis to 0.50-0.56 m, trunk folding forward, left hand down for balance), comes up into a crouch with the rifle at
    low ready and steps off into crouch_walk (last frame == crouch_walk frame 0, entered at its ground speed).
    Side variants: legs over the side (BTR: boots on the sloped upper side plate), rear variants: legs over the stern."""
    _RIG[0] = rig
    L = LAYOUT[name]
    I = rig.I
    T = jump_times(name)
    Sv = T['seat']
    S = lambda x, z: _surf(name, x, z)
    ride = _clip_pose('ride_sit_edge')
    lq_end, root_end, speed, feet_end = cw_end()
    dur = T['dur']
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    T_HAND, T_SC0, T_EDGE, T_OFF, T_TD, T_ABS, T_STEP = (T[k] for k in ('hand', 'sc0', 'edge', 'off', 'td', 'absorb', 'step'))
    z_edge = T['z_edge']
    h0 = Sv + ride['root'][0]                 # hips at frame 0 (seat frame root + seat point)
    hip_edge = np.array([0.0, T['y_hip_edge'], T['z_hip_edge']])
    land = np.array([0.0, T['land_y'], -0.42])
    # ---------------------------------------------------------------- hips
    keys = [(0.0, h0), (T_HAND, h0 + [0, -0.004, 0.004]), (T_SC0, h0 + [0, -0.002, 0.012]), (T_EDGE, hip_edge),
            (T_OFF - 0.07, hip_edge + [0, 0.025, 0.05]), (T_OFF, hip_edge + [0, 0.05, 0.11]), (T_TD, land),
            (T_ABS, (0, T['absorb_y'], land[2] + 0.05)), (T_STEP, (0, 0.66, -0.20)), (dur, root_end)]
    root = root_path(keys, dur, flights=[(T_OFF, T_TD)])
    # sliding on the deck: the buttocks never sink into a bump / the edge chamfer
    lift = np.zeros(F)
    for f in np.where((t > 0.05) & (t < T_OFF))[0]:
        lift[f] = max(0.0, _butt_floor(name, root[f, 2]) + 0.113 - root[f, 1])
    lift = np.maximum.reduce([np.roll(lift, k) for k in range(-3, 4)]) if lift.any() else lift
    root[:, 1] += np.convolve(np.pad(lift, 3, mode='edge'), np.ones(7) / 7, 'valid')
    # ---------------------------------------------------------------- trunk / head
    P = lambda **kw: kw
    sit = dict(Hips=(-14, 0, 0), LowerBack=(10, 0, 0), Spine=(8, 0, 0), Spine1=(5, 0, 0), Neck=(-2, 0, 0), Head=(4, 0, 0))
    mid = (T_OFF + T_TD) / 2
    bk = [(0.0, sit),
          (T_HAND, P(Hips=(-9, 10, 3), LowerBack=(13, 3, 0), Spine=(11, 3, 0), Spine1=(6, 0, 0), Neck=(6, 4, 0), Head=(20, 4, 0))),     # looks down
          (T_EDGE, P(Hips=(-3, 5, 2), LowerBack=(17, 1, 0), Spine=(13, 0, 0), Spine1=(7, 0, 0), Neck=(4, 0, 0), Head=(20, 0, 0))),
          (T_OFF - 0.06, P(Hips=(10, 2, 0), LowerBack=(16, 0, 0), Spine=(12, 0, 0), Spine1=(7, 0, 0), Neck=(-4, 0, 0), Head=(16, 0, 0))),  # weight forward
          (T_OFF + 0.04, P(Hips=(18, 0, 0), LowerBack=(10, 0, 0), Spine=(7, 0, 0), Spine1=(4, 0, 0), Neck=(-8, 0, 0), Head=(14, 0, 0))),
          (mid, P(Hips=(16, 0, -2), LowerBack=(7, 0, 0), Spine=(5, 0, 0), Spine1=(3, 0, 0), Neck=(-10, 0, 0), Head=(16, 0, 0))),         # eyes on the ground
          (T_TD, P(Hips=(22, 0, 0), LowerBack=(8, 0, 0), Spine=(6, 0, 0), Spine1=(3, 0, 0), Neck=(-12, 0, 0), Head=(8, 0, 0))),
          (T_ABS, P(Hips=(44, -4, 0), LowerBack=(15, 0, 0), Spine=(12, 0, 0), Spine1=(8, 0, 0), Neck=(-26, 0, 0), Head=(-6, 0, 0))),    # absorb
          (T_ABS + 0.18, P(Hips=(38, -4, 0), LowerBack=(12, 0, 0), Spine=(10, 0, 0), Spine1=(6, 0, 0), Neck=(-20, 0, 0), Head=(-4, 6, 0))),
          (T_STEP, P(Hips=(30, -4, 0), LowerBack=(10, 0, 0), Spine=(8, 0, 0), Spine1=(5, 0, 0), Neck=(-16, 0, 0), Head=(-2, 8, 0))),    # scans
          (dur, P(Hips=(24, -2, 0), LowerBack=(8, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(-12, 0, 0), Head=(0, 0, 0)))]
    # ---------------------------------------------------------------- feet
    W = lambda tt, x, z, e=(0, 0, 0), hold=True, **kw: dict(t=tt, p=(x, 0, z), hf=S, e=e, hold=hold, **kw)
    Wg = lambda tt, x, z, e=(0, 0, 0), hold=True, **kw: dict(t=tt, p=(x, 0, z), surf=0.0, e=e, hold=hold, **kw)
    R_ = lambda tt, x, y, z, e=(30, 0, 0), **kw: dict(t=tt, p=(x, y, z), f='r', e=e, **kw)
    gqr = rig.global_from_local(ride['lq'][:1]); gpr = fk_global(rig.sk, gqr, ride['root'][:1])
    fe = {}
    sup_any = False
    for side, sx in (('Left', 1), ('Right', -1)):
        a0 = Sv + gpr[0, I[side + 'Foot']]
        q0 = gqr[0, I[side + 'Foot']]
        ae, qe = feet_end[side]
        sup = S(a0[0], a0[2]) > a0[1] - 0.16          # the seated boot rests on (or in) a surface: BTR sloped side plate
        sup_any |= sup
        if sup:      # boots set onto the plate, slide down it while the butt goes to the edge, push off it
            k = [dict(t=0.0, p=a0, q=q0), W(0.20, a0[0], a0[2], e=(34, -8, 0)), W(T_SC0 - 0.02, a0[0], a0[2], e=(34, -8, 0), hold=False),
                 W(T_EDGE, sx * 0.14, z_edge + 0.38, e=(49, 0, 0)), W(T_OFF - 0.02, sx * 0.14, z_edge + 0.38, e=(49, 0, 0), hold=False)]
        else:        # boots hang in the air over the edge: shins swing under, the legs drop as he slides off
            k = [dict(t=0.0, p=a0, q=q0, hold=True), dict(t=T_SC0 - 0.04, p=a0, q=q0),
                 R_(T_EDGE, sx * 0.15, -0.47, 0.50, e=(24, 0, 0)), R_(T_OFF - 0.03, sx * 0.14, -0.55, 0.42, e=(20, 0, 0))]
        k += [R_(T_OFF + 0.10, sx * 0.14, -0.50, 0.34, e=(22, 0, 0)), R_(mid + 0.02, sx * 0.13, -0.60, 0.26, e=(16, 0, 0)),     # knees up
              R_(T_TD - 0.06, sx * 0.12, -0.77, 0.15 if side == 'Left' else 0.21, e=(10, -8 * sx, 0))]                        # reaching
        if side == 'Left':
            k += [Wg(T_TD, 0.12, land[2] + 0.12, e=(0, -8, 0)), Wg(T_STEP, 0.12, land[2] + 0.12, e=(0, -8, 0), hold=False),
                  dict(t=dur - 0.08, p=ae, q=qe, hold=True, lift=0.06), dict(t=dur, p=ae, q=qe)]
        else:
            k += [Wg(T_TD + 0.03, -0.12, -0.19, e=(0, 10, 0)), Wg(dur - 0.14, -0.12, -0.19, e=(0, 10, 0), hold=False),
                  dict(t=dur, p=ae, q=qe)]
        fe[side] = k
    gq, root, info = choreo(rig, dur, root, bk, fe, None)
    # start pose: exactly ride_sit_edge frame 0 (seat frame) -> blend from it over the first 0.22 s
    w0 = 1 - smooth(np.clip(t / 0.22, 0, 1))
    lr = ride['lq'][0]
    # ---------------------------------------------------------------- arms + rifle
    from clips_extra import hips_frame_gun
    from qmath import qlook
    d = np.array([1.0, 0.03, 0.2]); d /= np.linalg.norm(d)
    lap_q, lap_p = hips_frame_gun(rig, gq, root, np.array([-0.14, 0.30, 0.20]), qlook(d, np.array([0, 0.6, -0.8])),
                                  rig.global_from_local(rig.local(rig.global_from_local(np.array([C.pose_lq(rig, sit)[0][0]]))))[0, I['Hips']])
    w_port = smooth(np.clip((t - 0.08) / 0.30, 0, 1))
    w_low = smooth(np.clip((T_TD + 0.14 - t) * -1 / 0.40, 0, 1))
    gun_w = [(np.ones(F), ('ride', lap_q, lap_p)), (w_port, 'jump'), (w_low, 'low_ready')]
    xh = 0.25
    PDn = ((0.2, 0, 1.0), (0, -1.0, 0))
    z1 = h0[2] + 0.07
    if T['scoot'] > 0.20:        # long slide (BTR): plant beside the hip, re-plant at the edge, push off it
        z2 = z_edge - 0.05
        lk = [dict(t=T_HAND, p=(xh, S(xh, z1) + PALM_UP, z1), hp=PDn, hold=True),
              dict(t=T_SC0 + 0.45 * (T_EDGE - T_SC0), p=(xh, S(xh, z1) + PALM_UP, z1), hp=PDn),
              dict(t=T_EDGE + 0.02, p=(xh, S(xh, z2) + PALM_UP, z2), hp=PDn, hold=True, lift=0.05),
              dict(t=T_OFF - 0.04, p=(xh, S(xh, z2) + PALM_UP, z2), hp=PDn)]
    else:                        # short slide: one plant, the arm straightens as the hips go forward, push off it
        z1 = min(h0[2] + 0.10, z_edge - 0.10)
        lk = [dict(t=T_HAND, p=(xh, S(xh, z1) + PALM_UP, z1), hp=PDn, hold=True),
              dict(t=T_OFF - 0.07, p=(xh, S(xh, z1) + PALM_UP, z1), hp=PDn)]
    # off the handguard via palm-in (the grip -> palm-down turn is ~180 deg: two halves, no shortest-path flip)
    lk = [dict(t=0.0, p=(0.16, -0.22, 0.32), f='c', hp=((0.15, -0.3, 1.0), (-1.0, 0.0, 0.1))),
          dict(t=0.14, p=(0.20, -0.26, 0.30), f='c', hp=((0.15, -0.3, 1.0), (-1.0, 0.0, 0.1)))] + lk
    lk += [dict(t=T_OFF + 0.16, p=(0.42, -0.02, 0.20), f='c', hp=((0.5, 0.1, 0.8), (-0.8, -0.3, 0.0))),           # out for balance
           dict(t=T_TD + 0.10, p=(0.34, -0.20, 0.36), f='c', hp=((0.0, -0.5, 0.85), (-0.7, 0.3, 0.3))),            # down / forward on the landing
           dict(t=dur, p=(0.20, -0.2, 0.34), f='c', hp=((-0.6, -0.3, 0.7), (0.1, 0.85, 0.5)))]                     # (handguard grip orientation)
    w_grip = 1 - smooth(np.clip((t - 0.04) / 0.36, 0, 1)) * (1 - smooth(np.clip((t - (T_TD + 0.24)) / 0.28, 0, 1)))
    gq2, err, gun, lh = rifle_arms(rig, gq, root, t, gun_w, lk, w_grip, poleL_free=(0.65, 0.05, -0.15))   # free / planted left elbow out to the side
    # free left arm (between the handguard, the deck plants and the balance / landing reach): no IK whip of the forearm twist
    pl = np.convolve(np.pad(lh['planted'].astype(float), 4, mode='edge'), np.ones(9) / 9, 'valid') > 0
    ws = (1 - pl) * np.clip((0.995 - w_grip) / 0.05, 0, 1) * (t < dur - 0.24)
    gq2 = A.smooth_locals(rig, gq2, ('LeftArm', 'LeftForeArm', 'LeftHand'), 2.0, ws)
    # frame 0 .. 0.22 s: from the exact ride_sit_edge frame 0 pose (legs, trunk, arms) into the dismount
    lq2 = rig.local(gq2)
    for i in range(lq2.shape[1]):
        lq2[:, i] = np.array([qslerp(lq2[f, i], lr[i], w0[f]) for f in range(F)])
    gq2 = rig.global_from_local(lq2)
    root = root * (1 - w0[:, None]) + h0[None] * w0[:, None]
    # last 0.2 s: exactly into crouch_walk frame 0
    gq2, root = finish_into(rig, gq2, root, t, lq_end, root_end, dur - 0.20)
    info['hands'] = {'Left': dict(palm=lh['palm'], q=np.zeros((F, 4)), planted=lh['planted'])}
    info['rifle_err'] = err
    ev = {'hand_down': round(T_HAND, 3), 'leave_seat': round(T_OFF, 3), 'land': round(T_TD, 3), 'step': round(T_STEP, 3),
          'seat_offset_from_root': np.round(Sv, 3).tolist(), 'deck_drop_m': round(float(T['drop'] + T['land_y'] - 0.118), 3),
          'rear': bool(L.get('rear')), 'end_pose': 'crouch_walk frame 0', 'end_speed_mps': round(speed, 3)}
    return gq2, root, info, ev, dur


def _jump_fn(name):
    return lambda rig, lm: dismount_jump(rig, lm, name)


DOOR_STEP = (0.45, -0.68)    # folded-down lower door leaf (BTR-80/82): step height and its centre (clip z), 0.21 m outside the sill


def door_support(D, x, z):
    """support heights around the BTR side door (clip frame): troop floor 0.56 inside, the sill / hull plate 0.85 at the door plane,
    the folded-down lower leaf as a step 0.45 m high outside it, then the ground"""
    if z <= D[2] - 0.05:
        return 0.56
    if z <= D[2] + 0.03:
        return D[1]
    if z <= DOOR_STEP[1] + 0.24:
        return DOOR_STEP[0]
    return 0.0


def dismount_door(rig, lm, name='dismount_door'):
    """BTR-80/82 side door (lower leaf folded down as a step at the sill height): crouched in the doorway, right foot onto the
    step, ducks the head and shoulders under the opening top, left hand on the door edge, left foot down to the ground, right foot
    follows, steps off into crouch_walk (last frame == crouch_walk frame 0, entered at its ground speed), rifle at low ready."""
    return _dismount_step(rig, lm, name)


def dismount_rear(rig, lm, name='dismount_rear', threshold=None):
    """IFV rear door / ramp edge: crouched on the troop floor (threshold height h, default 0.5 m), left foot steps down to the
    ground, right foot follows, steps off into crouch_walk (last frame == crouch_walk frame 0, entered at its ground speed)."""
    return _dismount_step(rig, lm, name, threshold)


def _dismount_step(rig, lm, name, threshold=None):
    _RIG[0] = rig
    L = LAYOUT[name]
    I = rig.I
    lq_end, root_end, speed, feet_end = cw_end()
    door = name == 'dismount_door'
    if door:
        dur = 1.60
        D = v2c(name, L['door'])                  # door sill (0, 0.85, -0.89)
        zd, ys = D[2], D[1]
        yf = 0.56                                 # troop floor inside
        zf = -1.30
        y_st, z_st = DOOR_STEP                    # folded-down lower door leaf: a step outside, below the 0.85 m sill
        S = lambda x, z: door_support(D, x, z)
        T_R1, T_L1, T_R2, T_L2 = 0.42, 0.90, 1.15, dur - 0.08      # right foot over the sill onto the step, left foot on the ground, right foot down, left steps on
        keys = [(0.0, (0.06, yf + 0.56, zf - 0.08)), (0.20, (0.07, yf + 0.60, zf + 0.04)), (T_R1, (0.07, 1.10, zd - 0.12)),
                (0.62, (0.06, 1.02, zd + 0.12)), (T_L1, (0.03, 0.88, zd + 0.42)), (0.94, (0.01, 0.78, zd + 0.52)),
                (T_R2, (0, 0.74, -0.30)), (dur, root_end)]
        ev_out, ev_ground = 0.58, T_L1
    else:
        dur = 1.30
        h = L['threshold'] if threshold is None else threshold
        zt = L['threshold_z']
        yf, zf = h, L['floor_z']
        S = lambda x, z: h if z <= zt else 0.0
        T_L1, T_R2, T_L2 = 0.46, 0.86, dur - 0.06
        keys = [(0.0, (0, yf + 0.70, zf + 0.20)), (0.22, (0, yf + 0.66, zt - 0.22)), (T_L1, (0, 0.86, zt + 0.08)), (0.60, (0, 0.74, zt + 0.16)),
                (T_R2, (0, 0.74, -0.24)), (dur, root_end)]
        ev_out, ev_ground = 0.30, T_L1
    F = int(round(dur * FPS)) + 1
    t = np.arange(F) / FPS
    root = root_path(keys, dur)
    P = lambda **kw: kw
    if door:
        bk = [(0.0, P(Hips=(34, 0, 0), LowerBack=(10, 0, 0), Spine=(8, 0, 0), Spine1=(6, 0, 0), Neck=(-16, 0, 0), Head=(-8, 0, 0))),
              (T_R1, P(Hips=(52, -6, 0), LowerBack=(14, 0, 0), Spine=(12, 0, 0), Spine1=(8, 0, 0), Neck=(-26, 0, 0), Head=(-12, 0, 0))),
              (0.60, P(Hips=(50, -4, 0), LowerBack=(14, 0, 0), Spine=(12, 0, 0), Spine1=(8, 0, 0), Neck=(-26, 0, 0), Head=(-10, 4, 0))),
              (T_L1, P(Hips=(34, 0, 0), LowerBack=(10, 0, 0), Spine=(8, 0, 0), Spine1=(6, 0, 0), Neck=(-20, 0, 0), Head=(-4, 8, 0))),
              (T_R2, P(Hips=(28, -4, 0), LowerBack=(9, 0, 0), Spine=(7, 0, 0), Spine1=(5, 0, 0), Neck=(-14, 0, 0), Head=(0, -8, 0))),
              (dur, P(Hips=(24, -2, 0), LowerBack=(8, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(-12, 0, 0), Head=(0, 0, 0)))]
    else:
        bk = [(0.0, P(Hips=(26, 0, 0), LowerBack=(9, 0, 0), Spine=(7, 0, 0), Spine1=(5, 0, 0), Neck=(-14, 0, 0), Head=(-2, 0, 0))),
              (0.22, P(Hips=(32, 0, 0), LowerBack=(10, 0, 0), Spine=(8, 0, 0), Spine1=(6, 0, 0), Neck=(-18, 0, 0), Head=(-4, 0, 0))),
              (T_L1, P(Hips=(30, 0, 0), LowerBack=(9, 0, 0), Spine=(7, 0, 0), Spine1=(5, 0, 0), Neck=(-16, 0, 0), Head=(-2, 6, 0))),
              (T_R2, P(Hips=(26, -4, 0), LowerBack=(8, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(-12, 0, 0), Head=(0, -6, 0))),
              (dur, P(Hips=(24, -2, 0), LowerBack=(8, 0, 0), Spine=(6, 0, 0), Spine1=(4, 0, 0), Neck=(-12, 0, 0), Head=(0, 0, 0)))]
    Wf = lambda tt, x, z, ys_, e=(0, 0, 0), hold=True, **kw: dict(t=tt, p=(x, 0, z), surf=ys_, e=e, hold=hold, **kw)
    (aL, qL), (aR, qR) = feet_end['Left'], feet_end['Right']
    if door:
        fe = {'Left': [Wf(0.0, 0.11, zf + 0.06, yf, e=(0, -8, 0)), Wf(0.54, 0.11, zf + 0.06, yf, e=(0, -8, 0), hold=False),
                       Wf(T_L1, 0.12, zd + 0.54, 0.0, e=(0, -8, 0), via=('w', (0.12, ys + 0.24, zd - 0.06))), Wf(T_L2 - 0.30, 0.12, zd + 0.54, 0.0, e=(0, -8, 0), hold=False),
                       dict(t=T_L2, p=aL, q=qL, hold=True, lift=0.07), dict(t=dur, p=aL, q=qL)],
              'Right': [Wf(0.0, -0.12, zf - 0.10, yf, e=(0, 10, 0)), Wf(0.14, -0.12, zf - 0.10, yf, e=(0, 10, 0), hold=False),
                        Wf(T_R1, -0.12, z_st, y_st, e=(0, 10, 0), via=('w', (-0.12, ys + 0.14, zd - 0.04))), Wf(0.88, -0.12, z_st, y_st, e=(0, 10, 0), hold=False),
                        Wf(T_R2, -0.12, -0.19, 0.0, e=(0, 10, 0), lift=0.05), Wf(dur - 0.14, -0.12, -0.19, 0.0, e=(0, 10, 0), hold=False),
                        dict(t=dur, p=aR, q=qR)]}
    else:
        fe = {'Left': [Wf(0.0, 0.11, zf + 0.30, yf, e=(0, -8, 0)), Wf(0.12, 0.11, zf + 0.30, yf, e=(0, -8, 0), hold=False),
                       Wf(T_L1, 0.12, zt + 0.25, 0.0, e=(0, -8, 0), via=('w', (0.12, yf + 0.10, zt + 0.02))), Wf(T_L2 - 0.36, 0.12, zt + 0.25, 0.0, e=(0, -8, 0), hold=False),
                       dict(t=T_L2, p=aL, q=qL, hold=True, lift=0.07), dict(t=dur, p=aL, q=qL)],
              'Right': [Wf(0.0, -0.12, zf + 0.08, yf, e=(0, 10, 0)), Wf(0.52, -0.12, zf + 0.08, yf, e=(0, 10, 0), hold=False),
                        Wf(T_R2, -0.12, -0.19, 0.0, e=(0, 10, 0), via=('w', (-0.12, yf + 0.10, zt + 0.05))), Wf(dur - 0.12, -0.12, -0.19, 0.0, e=(0, 10, 0), hold=False),
                        dict(t=dur, p=aR, q=qR)]}
    gq, root, info = choreo(rig, dur, root, bk, fe, None)
    gun_w = [(np.ones(F), 'low_ready')]
    if door:          # left hand on the front edge of the door opening while ducking out
        xe = 0.31
        lk = [dict(t=0.36, p=(xe, 1.16, zd - 0.05), hp=((0, 1.0, 0.2), (1.0, 0, 0)), hold=True),
              dict(t=0.54, p=(xe, 1.16, zd - 0.05), hp=((0, 1.0, 0.2), (1.0, 0, 0))),
              dict(t=dur, p=(0.3, -0.1, 0.3), f='c', hp=((0.3, -0.3, 0.9), (-0.8, -0.3, 0.0)))]
        w_grip = 1 - smooth(np.clip((t - 0.03) / 0.33, 0, 1)) * (1 - smooth(np.clip((t - 0.56) / 0.42, 0, 1)))
    else:
        lk = [dict(t=0.0, p=(0.3, -0.1, 0.3), f='c', hp=((0.3, -0.3, 0.9), (-0.8, -0.3, 0.0))), dict(t=dur, p=(0.3, -0.1, 0.3), f='c', hp=((0.3, -0.3, 0.9), (-0.8, -0.3, 0.0)))]
        w_grip = np.ones(F)
    gq2, err, gun, lh = rifle_arms(rig, gq, root, t, gun_w, lk, w_grip, poleR_off=(-0.02, -0.7, -0.12) if door else (-0.4, -0.6, -0.2),
                                   poleL_free=(0.05, -0.8, -0.2) if door else (0.45, -0.3, -0.45))
    gq2, root = finish_into(rig, gq2, root, t, lq_end, root_end, dur - 0.18)
    info['hands'] = {'Left': dict(palm=lh['palm'], q=np.zeros((F, 4)), planted=lh['planted'])}
    info['rifle_err'] = err
    ev = {'out': ev_out, 'ground': ev_ground, 'end_pose': 'crouch_walk frame 0', 'end_speed_mps': round(speed, 3)}
    if door:
        ev.update(step=T_R1, door_sill_from_root=np.round(D, 3).tolist(), door_top_y=L['door_top'])
    else:
        ev.update(threshold_h=float(yf), threshold_z=float(L['threshold_z']))
    return gq2, root, info, ev, dur


# ====================================================================================== build entry
def _notes(name, ev, dur):
    L = LAYOUT[name]
    pt = preview_transform(name) if L.get('veh') else None
    s = L.get('side', -1)
    common = ('Root motion: the whole path is in the Hips translation track; the game places the soldier root ONCE at the end position '
              '(clip frame origin, on the ground, heading = +Z of the clip) and keeps it still for the clip; nothing to add per frame. ')
    if name.startswith('hatch_exit'):
        H = v2c(name, L['hatch'])
        return (f'{L["note"]}. Crew bail-out, hands free (PM holstered, drawn at the end: weapon_socket shows the PM from events.draw = dur - 0.5 s). '
                f'Start: crouched on the seat under the closed hatch; hatch rim centre at {np.round(H, 3).tolist()} relative to the end root '
                f'(i.e. root = hatch_centre + {abs(H[2]):.2f} m outward (perpendicular to the hull side) + {-H[0]:+.2f} m along the hull (+ = toward the bow for a right-side exit), on the ground). ' + common +
                f'Ends crouched, PM at a compressed low ready (blends to pistol_idle / pistol_walk / pistol_run).')
    if name.startswith('dismount_jump'):
        Sv = v2c(name, L['seat'])
        return (f'{L["note"]}. Starts in ride_sit_edge frame 0 with the seat point at {np.round(Sv, 3).tolist()} relative to the end root '
                f'(root = seat + {abs(Sv[2]):.2f} m outward along the seat heading, on the ground). ' + common +
                f'Ends in crouch_walk frame 0 moving forward at crouch_walk ground speed {ev["end_speed_mps"]} m/s (switch to crouch_walk / crouch_idle).')
    if name == 'dismount_door':
        D = v2c(name, L['door'])
        return (f'{L["note"]}. Starts crouched inside on the troop floor (0.56 m); door sill (step) at {np.round(D, 3).tolist()} relative to the end root '
                f'(root = door + {abs(D[2]):.2f} m outward = the dismount_L/R empty), opening top {L["door_top"]} m, width {L["door_w"]} m. ' + common +
                f'Ends in crouch_walk frame 0 moving forward at {ev["end_speed_mps"]} m/s.')
    if name == 'dismount_rear':
        return (f'{L["note"]}. Starts crouched on the troop floor at threshold_h = {L["threshold"]} m, the floor edge {abs(L["threshold_z"]):.2f} m behind the end root '
                f'(root = rear door / ramp edge + {abs(L["threshold_z"]):.2f} m along -hull axis, on the ground, heading = hull backward). ' + common +
                f'Ends in crouch_walk frame 0 moving forward at {ev["end_speed_mps"]} m/s. A different threshold h: offset the root y by (h - {L["threshold"]}) '
                f'for t < events.ground and blend to 0 over the next 0.3 s, or rebuild with clips_vehicle.dismount_rear(threshold=h). '
                f'Ramp (Bradley): the ramp is a slope, not a step: play crouch_walk down it instead.')
    return ''


def vehicle_record_extra(name):
    L = LAYOUT[name]
    d = dict(layout_of=name, note=L.get('note'))
    if L.get('veh'):
        vp, vyaw = preview_transform(name)
        d.update(vehicles=list(L['veh']), side=L.get('side'), rear=bool(L.get('rear')), end_root_vehicle_xz=list(L['end']), vehicle_in_clip_frame=dict(pos=list(vp), yaw_deg=vyaw))
        for k in ('hatch', 'seat', 'door'):
            if k in L:
                d[k + '_vehicle'] = list(L[k]); d[k + '_from_root'] = np.round(v2c(name, L[k]), 3).tolist()
    else:
        d.update(threshold_h=L['threshold'], threshold_z=L['threshold_z'])
    return d


def vehicle_clips(rig, lm, want, built=None):
    """build the wanted vehicle clips -> {name: clip record}; hatch_exit = hatch_exit_tank, dismount_jump = dismount_jump_btr"""
    BUILT.clear()
    if built:
        BUILT.update(built)
    _RIG[0] = rig
    out = {}
    src = {'hatch_exit': ('hatch_exit_tank', hatch_exit_tank), 'hatch_exit_tank': ('hatch_exit_tank', hatch_exit_tank), 'hatch_exit_btr': ('hatch_exit_btr', hatch_exit_btr),
           'dismount_jump': ('dismount_jump_btr', _jump_fn('dismount_jump_btr')), 'dismount_door': ('dismount_door', dismount_door), 'dismount_rear': ('dismount_rear', dismount_rear)}
    src.update({n: (n, _jump_fn(n)) for n in JUMPS})
    cache = {}
    for name in CLIPS:
        if not want(name):
            continue
        base, fn = src[name]
        if base not in cache:
            cache[base] = fn(rig, lm)
        gq, root, info, ev, dur = cache[base]
        alias = '' if name == base else f' (copy of {base})'
        out[name] = to_clip(name, rig, gq, root, False, root_motion=True, notes=_notes(base, ev, dur) + alias,
                            events=dict(ev), extra=dict(vehicle=vehicle_record_extra(base)))
    return out


# ====================================================================================== checker support (check_anims.py)
CHECK = {   # left palm on the handguard windows (s), start / end continuity, required events
    'hatch_exit_tank': dict(grip=None, events=('hatch_open', 'out', 'ground', 'draw'), snap=[(0.60, 1.60, 40.0), (2.40, 2.55, 40.0), (3.70, 3.90, 50.0)]),
    'hatch_exit_btr': dict(grip=None, events=('hatch_open', 'out', 'ground', 'draw'), snap=[(0.60, 1.60, 40.0), (2.98, 3.12, 40.0), (3.47, 3.67, 50.0)]),
    'dismount_door': dict(grip=[(0.0, 0.03), (1.0, 9)], end='crouch_walk', events=('out', 'ground'), snap=[(0.70, 0.98, 40.0)]),
    'dismount_rear': dict(grip=[(0.0, 9)], end='crouch_walk', events=('out', 'ground')),
}
for _n in JUMPS:     # left palm back on the handguard from touchdown + 0.52 s; landing impact window
    _T = jump_times(_n)
    CHECK[_n] = dict(grip=[(0.0, 0.03), (_T['td'] + 0.54, 9)], start='ride_sit_edge', end='crouch_walk', events=('land',),
                     snap=[(_T['td'] - 0.03, _T['absorb'] + 0.04, 50.0)])
ALIAS = {'hatch_exit': 'hatch_exit_tank', 'dismount_jump': 'dismount_jump_btr'}
PEN_TOL = 0.045          # body joints (with radii) into the voxelised vehicle (2.5 cm voxels; sitting / sliding contacts ~3-4 cm)


def support_y(name, x, z, y):
    """height of the surface supporting a foot at clip (x, z) whose sole is at height ~y (ground, vehicle top surface, or the
    clip's own floor / step / seat inside the vehicle)"""
    name = ALIAS.get(name, name)
    L = LAYOUT[name]
    if name == 'dismount_rear':
        return L['threshold'] if z <= L['threshold_z'] else 0.0
    if name == 'dismount_door':
        return door_support(v2c(name, L['door']), x, z)
    if name.startswith('hatch_exit'):
        H = v2c(name, L['hatch'])
        if np.hypot(x - H[0], z - H[2]) < L['rim_r'] + 0.1 and y < H[1] - 0.5:
            return H[1] - 1.30                # seat / footrest inside
    best = 0.0
    for veh in L['veh'][:1]:
        best = max(best, surface_y(name, veh, x, z, below=y + 0.12))
    return best
