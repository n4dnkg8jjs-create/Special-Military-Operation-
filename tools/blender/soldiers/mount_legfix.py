"""mount v5: the leg swings of the mount_* clips re-planned inside human joint limits - a pass over the SHIPPED soldier_anims.glb
(no body.pkl / clips.pkl needed).

What was wrong (v3 / v4): the holds are fine, but the legs travelled between them through poses no hip allows.  Getting onto the roof
the left thigh swung out sideways to 70-75 deg, the right thigh was carried BACK to 85-105 deg behind the pelvis (a hurdler's trail leg
whipped round the side), and after leaving its hold the trailing leg hung locked straight (hip -> ankle 97-98 % of the leg length for
up to 1.2 s) - 'the leg stretches'.

Per leg, per swing (the ankle moving between two holds; a hold = the ankle below 0.10 m/s, or the knee resting on the hull).  A swing
is re-planned only if it breaks a limit (thigh > BACK_FLAG behind the pelvis, > OUT_FLAG out to the side, or locked straight in the
air); every hold frame - each foothold, the start pose, the seated end pose - keeps its original pose exactly, and so does the trunk
and both arms.
  * the swing is planned in joint space: thigh pitch (fore / aft, in the pelvis' heading) x knee flexion on a grid, the cheapest path
    from the pose leaving the old hold to the pose arriving on the next one (dynamic programming, <= STEP deg / frame):
      - the thigh stays between THIGH_FWD in front and pelvis pitch + THIGH_BACK behind
      - the knee gives as soon as the boot is off its hold and stays bent through the swing (TUCK): shin and heel trail behind
      - nothing through the hull (vehicle_geo depth of the thigh / knee / shin / boot spheres), the ground or the other leg
  * the thigh's sideways angle is eased into OUT_MAX / IN_MAX, the knee axis square to the pelvis, the ankle relaxed (toes hanging)
Only the Left / Right UpLeg, Leg, Foot rotation tracks are rewritten, in place (same key count, same file layout).

run:  python3 tools/blender/soldiers/mount_legfix.py [--glb path] [--dry] [clip ...]     then mount_check.py (must stay clean)
Run it ONCE after a rebuild of the mount clips (build_anims.py --merge mount_...): it is not idempotent (a second run re-plans
the on-deck swings it left wide), so never stack runs on the same file.  A swing whose re-plan fails the checks (rotation per
frame, hull, ground, knee) keeps its original frames and is listed with 'applied': False."""
import os, sys, json, struct
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import check_anims as CA
import clips_vehicle as CV
from qmath import qmul, qinv, qrot, qaxis, qslerp, qfrom_mat, qbetween

D = np.pi / 180
BACK_FLAG, OUT_FLAG, STIFF_FLAG = 32 * D, 45 * D, 5       # a swing over any of these is re-planned (back: beyond the pelvis pitch)
THIGH_BACK, THIGH_FWD = 10 * D, 118 * D                   # thigh range: behind the pelvis' own pitch / in front (knee to the chest)
OUT_MAX, IN_MAX = 24 * D, 6 * D                           # thigh out to the side / across the midline
OUT_FWD = 58 * D                                          # ... with the hip flexed (knee up and out in a high step: natural)
DECK_MIN = 30                                             # frames: on the deck only long free swings are re-planned
ROT_OK, PEN_OK = 13.2, 0.05                               # accept a re-planned swing only inside these (else the original stays)
TUCK = (20 * D, 45 * D)                                   # least knee flexion at the ends / the middle of a swing (slack knee = + 10)
KNEE_MAX = 142 * D
EASE, HEEL_UP = 0.0025, 30.0                              # pull to the slack knee angle (/deg^2) / cost of a shin pointing up
HANG = 0.004                                              # cost of a thigh held out behind the vertical (/deg^2 past 15 deg)
STEP = 2                                                  # grid steps per frame (x GRID deg)
GRID = 4 * D
RAMP_IN, RAMP_OUT = 9, 10                                 # frames to ease the sideways / knee-axis / ankle change in and out
V_PLANT, V_KNEE = 0.10, 0.07                              # m/s: ankle on a hold / knee resting
PEN_FREE = 0.012                                          # m of hull contact that costs nothing
ANKLE_RELAX = 0.75
X = np.array([1.0, 0, 0]); Y = np.array([0, 1.0, 0]); Z = np.array([0, 0, 1.0])


def _ss(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def _unit(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-9)


def _runs(mask):
    out = []; f = 0; n = len(mask)
    while f < n:
        if mask[f]:
            a = f
            while f < n and mask[f]:
                f += 1
            out.append((a, f))
        else:
            f += 1
    return out


def fk(M, lq, lt):
    gq = np.zeros_like(lq); gp = np.zeros_like(lt)
    for i in range(M.n):
        p = M.parent[i]
        if p < 0:
            gq[:, i] = lq[:, i]; gp[:, i] = lt[:, i]
        else:
            gq[:, i] = qmul(gq[:, p], lq[:, i]); gp[:, i] = gp[:, p] + qrot(gq[:, p], lt[:, i])
    return gq, gp


def pen_of(name, vehs, P, rad):
    """worst hull penetration of spheres (.., k, 3) with radii (k,) over the last axis (m; <= 0 clear)"""
    pen = np.full(P.shape[:-2], -1.0)
    for veh in vehs:
        d = CV.vgeo(veh).depth(CV.c2v(name, P), rad)
        pen = np.maximum(pen, np.asarray(d).max(-1))
    return pen


class Leg:
    """one leg of one clip in the pelvis-heading frame"""
    def __init__(self, M, side, lq, lt):
        I = M.idx
        self.M, self.side, self.sg = M, side, (1.0 if side == 'Left' else -1.0)
        self.iU, self.iL, self.iF, self.iT = I[side + 'UpLeg'], I[side + 'Leg'], I[side + 'Foot'], I[side + 'ToeBase']
        self.L1 = np.linalg.norm(M.T[self.iL]); self.L2 = np.linalg.norm(M.T[self.iF])
        self.update(lq, lt)

    def update(self, lq, lt):
        M, I = self.M, self.M.idx
        self.lq = lq; self.gq, self.gp = fk(M, lq, lt)
        gq, gp = self.gq, self.gp; F = len(lq); self.F = F
        hq = gq[:, I['Hips']]
        fw = qrot(hq, np.broadcast_to(Z, (F, 3))); up = qrot(hq, np.broadcast_to(Y, (F, 3)))
        fh = fw.copy(); fh[:, 1] = 0; self.fh = _unit(fh)
        self.lat = np.cross(Y, self.fh)                                  # the man's left
        self.pel = np.arctan2(np.sum(up * self.fh, 1), up[:, 1])         # pelvis pitched forward +
        self.H, self.K, self.A = gp[:, self.iU], gp[:, self.iL], gp[:, self.iF]
        self.t = _unit(self.K - self.H); self.c = _unit(self.A - self.K)
        self.phi = np.arccos(np.clip(np.sum(self.t * self.c, 1), -1, 1))
        h = np.cross(self.t, self.c); n = np.linalg.norm(h, axis=1, keepdims=True)
        hid = _unit(self.lat - np.sum(self.lat * self.t, 1, keepdims=True) * self.t)
        self.h = np.where(n > 0.08, h / np.maximum(n, 1e-9), hid)       # knee axis (the ideal one where the leg is straight)
        self.beta = np.arctan2(-np.sum(self.t * self.fh, 1), -self.t[:, 1])                  # thigh back +
        self.out = np.arcsin(np.clip(np.sum(self.t * self.lat, 1), -1, 1)) * self.sg          # thigh out to the side +
        self.ext = np.linalg.norm(self.A - self.H, axis=1) / (self.L1 + self.L2)

    def holds(self):
        F = self.F
        va = np.r_[0.0, np.linalg.norm(np.diff(self.A, axis=0), axis=1) * CA.FPS]
        vk = np.r_[0.0, np.linalg.norm(np.diff(self.K, axis=0), axis=1) * CA.FPS]
        hold = va < V_PLANT
        for a, b in _runs(vk < V_KNEE):
            if b - a >= 6:
                hold[a:b] = True
        hold[:2] = True; hold[-3:] = True
        return hold

    def points(self, t, h, c, foot):
        """sample spheres of the leg for thigh dir t, knee axis h, shin dir c (.., 3) and boot offsets `foot` (k, 3) in the shin
        frame (c, h, c x h) -> thigh points (.., 2, 3), lower points (.., 4 + k, 3)"""
        H = self.Hf
        K = H + self.L1 * t; A = K + self.L2 * c; g = np.cross(c, h)
        th = np.stack([H + 0.45 * self.L1 * t, H + 0.78 * self.L1 * t], -2)
        lo = [K, K + 0.33 * self.L2 * c, K + 0.66 * self.L2 * c, A]
        lo += [A + f[0] * c + f[1] * h + f[2] * g for f in foot]
        return th, np.stack(np.broadcast_arrays(*lo), -2)


RT = np.array([0.08, 0.075]); RL = np.array([0.055, 0.05, 0.045, 0.045, 0.035, 0.03, 0.04])


def out_limit(leg, f):
    """sideways limit at a hold frame: wider while the thigh is well in front of the pelvis"""
    return OUT_MAX + (OUT_FWD - OUT_MAX) * _ss((-(leg.beta[f] - leg.pel[f]) - 35 * D) / (45 * D))


def hinge_ideal(t, lat):
    return _unit(lat - np.sum(lat * t, -1, keepdims=True) * t)


def twist_of(leg, f):
    """the thigh's own turn at frame f: angle about the thigh from the square knee axis to the real one"""
    t = leg.t[f]; hi = hinge_ideal(t, leg.lat[f]); h = _unit(leg.h[f] - (leg.h[f] @ t) * t)
    return float(np.arctan2(np.cross(hi, h) @ t, hi @ h))


def swing_shape(leg, a, b):
    """sideways angle and thigh turn through the swing a .. b - 1, eased from the pose on the old hold into the limits and out
    to the pose on the next hold"""
    n = b - a; i = np.arange(n); u = (i + 0.5) / n
    rin = min(RAMP_IN, n * 0.4); rout = min(RAMP_OUT, n * 0.4)
    oa, ob = leg.out[a - 1], leg.out[b]
    o = oa + (ob - oa) * _ss(u)
    lim = out_limit(leg, a - 1) + (out_limit(leg, b) - out_limit(leg, a - 1)) * _ss(u)
    wo = _ss((i + 1) / (rin * 1.4)) * _ss((n - i) / (rout * 1.4))
    out_n = o + wo * (np.clip(o, -IN_MAX, lim) - o)
    tau = twist_of(leg, a - 1) * (1 - _ss((i + 1) / rin)) + twist_of(leg, b) * (1 - _ss((n - i) / rout))
    return out_n, tau, u


def thigh_frame(leg, f, beta, out, tau):
    """thigh direction(s) for pitch beta (array ok) + the knee axis"""
    fh, lat = leg.fh[f], leg.lat[f]
    beta = np.asarray(beta, float)
    t = np.cos(out) * (-np.cos(beta)[..., None] * Y - np.sin(beta)[..., None] * fh) + np.sin(out) * leg.sg * lat
    hi = hinge_ideal(t, lat)
    h = np.cos(tau) * hi + np.sin(tau) * np.cross(t, hi)
    return t, h


def plan(M, name, vehs, leg, other, a, b, lqF, rep, margin=PEN_FREE):
    """re-plan the swing frames a .. b - 1 of `leg` (frames a - 1 and b are holds); lqF = the eased ankle rotation -> per-frame
    (t, h, phi) or None"""
    n = b - a
    fr = np.arange(a, b)
    i = np.arange(n)
    out_n, tau, u = swing_shape(leg, a, b)
    nb = int(round((THIGH_FWD + 60 * D) / GRID)) + 1; npi = int(round((150 * D - 8 * D) / GRID)) + 1
    B = -THIGH_FWD - 6 * D + GRID * np.arange(nb); P = 8 * D + GRID * np.arange(npi)
    bmax = leg.pel[fr] + THIGH_BACK
    tuck = TUCK[0] + (TUCK[1] - TUCK[0]) * np.sin(np.pi * u) ** 0.8
    # boot offsets in the shin frame with the eased ankle
    go = np.cross(leg.c, leg.h)
    U = np.zeros((n, nb, npi)); geo = []
    pen_a = max(0.0, float(pen_leg(name, vehs, leg, a - 1))); pen_b = max(0.0, float(pen_leg(name, vehs, leg, b)))
    op = other_points(other)
    for k, f in enumerate(fr):
        gF = qmul(leg.gq[f, leg.iL], lqF[f])
        toe = qrot(gF, M.T[leg.iT]); tip = toe + _unit(toe) * 0.07; heel = qrot(gF, np.array([0.0, -0.05, -0.06]))
        foot = np.array([[d @ leg.c[f], d @ leg.h[f], d @ go[f]] for d in (toe, tip, heel)])
        tb, h = thigh_frame(leg, f, B, out_n[k], tau[k])                                              # (nb, 3)
        e = np.cross(tb, h)
        c = np.cos(P)[None, :, None] * tb[:, None] - np.sin(P)[None, :, None] * e[:, None]          # (nb, npi, 3)
        leg.Hf = leg.H[f]
        th, lo = leg.points(tb[:, None], h[:, None], c, foot)
        allow = margin[k] + max(pen_a * (1 - u[k]) ** 4, pen_b * u[k] ** 4)
        pen = np.maximum(pen_of(name, vehs, lo, RL), pen_of(name, vehs, th, RT)) if vehs else np.full((nb, npi), -1.0)
        cost = 6e4 * np.maximum(pen - allow, 0) ** 2 + 400.0 * (pen > allow + 0.03)
        low = (lo[..., 1] - RL).min(-1)
        cost += 6e4 * np.maximum(0.004 - low, 0) ** 2
        dmin = np.linalg.norm(lo[..., :, None, :] - op[f][None, None, None], axis=-1).min((-1, -2))
        cost += 3e3 * np.maximum(0.13 - dmin, 0) ** 2
        cost += (0.03 / D ** 2) * (np.maximum(B - bmax[k], 0) ** 2 + np.maximum(-THIGH_FWD - B, 0) ** 2)[:, None]
        cost += (0.02 / D ** 2) * (np.maximum(tuck[k] - P, 0) ** 2 + 4 * np.maximum(P - KNEE_MAX, 0) ** 2)[None, :]
        cost += (EASE / D ** 2) * ((P - tuck[k] - 10 * D) ** 2)[None, :]             # a slack knee, not a clenched one
        cost += (HANG / D ** 2) * (np.maximum(B - 15 * D, 0) ** 2)[:, None]          # a free thigh hangs: not held out behind
        cost += HEEL_UP * np.maximum(c[..., 1] + 0.15, 0) ** 2                       # the shin hangs: no heel above the knee
        U[k] = cost
        geo.append((tb, h))
    # dynamic programme over the grid
    lam = 0.012 / D ** 2
    sh = [(db, dp) for db in range(-STEP, STEP + 1) for dp in range(-STEP, STEP + 1)]
    bs, ps = leg.beta[a - 1], leg.phi[a - 1]; be, pe = leg.beta[b], leg.phi[b]
    C = np.empty((n, nb, npi)); back = np.zeros((n, nb, npi), np.int8)
    d0 = np.maximum(np.abs(B[:, None] - bs), np.abs(P[None, :] - ps))
    C[0] = U[0] + lam * ((B[:, None] - bs) ** 2 + (P[None, :] - ps) ** 2) + 1e6 * (d0 > STEP * GRID + GRID * 0.75)
    for k in range(1, n):
        prev = np.pad(C[k - 1], STEP, constant_values=np.inf)
        best = np.full((nb, npi), np.inf)
        for j, (db, dp) in enumerate(sh):
            cand = prev[STEP - db:STEP - db + nb, STEP - dp:STEP - dp + npi] + lam * GRID ** 2 * (db * db + dp * dp)
            m = cand < best
            best[m] = cand[m]; back[k][m] = j
        C[k] = U[k] + best
    d1 = np.maximum(np.abs(B[:, None] - be), np.abs(P[None, :] - pe))
    end = C[-1] + lam * ((B[:, None] - be) ** 2 + (P[None, :] - pe) ** 2) + 1e6 * (d1 > STEP * GRID + GRID * 0.75)
    ib, ip = np.unravel_index(np.argmin(end), end.shape)
    pb = np.zeros(n, int); pp = np.zeros(n, int)
    for k in range(n - 1, -1, -1):
        pb[k], pp[k] = ib, ip
        db, dp = sh[back[k][ib, ip]]
        ib -= db; ip -= dp
    rep['cost'] = round(float(end.min()), 1)

    def smooth(path, s0, s1):
        s = np.r_[s0, path, s1]
        g = np.exp(-0.5 * (np.arange(-5, 6) / 1.7) ** 2); g /= g.sum()
        s = np.convolve(np.pad(s, 5, mode='edge'), g, mode='valid')
        s += np.linspace(s0 - s[0], s1 - s[-1], len(s))
        return s[1:-1]
    beta = smooth(B[pb], bs, be); phi = smooth(P[pp], ps, pe)
    return beta, phi, out_n, tau


def pen_leg(name, vehs, leg, f):
    if not vehs:
        return -1.0
    K, A = leg.K[f], leg.A[f]
    P = np.stack([K, K + (A - K) * 0.33, K + (A - K) * 0.66, A], 0)
    return pen_of(name, vehs, P[None], RL[:4])[0]


def other_points(o):
    K, A, T = o.K, o.A, o.gp[:, o.iT]
    return np.stack([K, K + (A - K) * 0.33, K + (A - K) * 0.66, A, T], 1)


def apply(M, leg, lq, fr, beta, phi, out_n, tau, lqF):
    """write the planned swing into lq (UpLeg, Leg, Foot local rotations)"""
    for k, f in enumerate(fr):
        t1, h1 = thigh_frame(leg, f, beta[k], out_n[k], tau[k])
        t0, h0 = leg.t[f], _unit(leg.h[f] - (leg.h[f] @ leg.t[f]) * leg.t[f])
        R = np.stack([t1, h1, np.cross(t1, h1)], 1) @ np.stack([t0, h0, np.cross(t0, h0)], 1).T
        Q = qfrom_mat(R)
        gU = qmul(Q, leg.gq[f, leg.iU])
        gL = qmul(qaxis(h1, phi[k] - leg.phi[f]), qmul(Q, leg.gq[f, leg.iL]))
        lq[f, leg.iU] = qmul(qinv(leg.gq[f, M.parent[leg.iU]]), gU)
        lq[f, leg.iL] = qmul(qinv(gU), gL)
        lq[f, leg.iF] = lqF[f]


def continuity(lq, ref, bones):
    """keep each track's sign continuous (and equal to the original's where the rotation is unchanged)"""
    for j in bones:
        for f in range(len(lq)):
            if f == 0:
                if lq[f, j] @ ref[f, j] < 0:
                    lq[f, j] *= -1
            elif lq[f, j] @ lq[f - 1, j] < 0:
                lq[f, j] *= -1


def spheres(M, leg, fr):
    """the leg's sample spheres at frames fr from the real pose (same set the planner uses)"""
    H, K, A = leg.H[fr], leg.K[fr], leg.A[fr]
    gF = leg.gq[fr, leg.iF]
    toe = leg.gp[fr, leg.iT]; tip = toe + _unit(toe - A) * 0.07; heel = A + qrot(gF, np.broadcast_to([0.0, -0.05, -0.06], A.shape))
    t = K - H
    P = np.stack([H + 0.45 * t, H + 0.78 * t, K, K + (A - K) * 0.33, K + (A - K) * 0.66, A, toe, tip, heel], 1)
    return P, np.r_[RT, RL]


def knee_back(leg, fr):
    """frames with the knee bent away from the pelvis' front (mount_check's test)"""
    M = leg.M
    fwd = qrot(leg.gq[fr, M.idx['Hips']], np.broadcast_to(Z, (len(fr), 3)))
    H, K, A = leg.H[fr], leg.K[fr], leg.A[fr]
    ln = _unit(A - H)
    bn = _unit(K - (H + ln * np.sum((K - H) * ln, 1, keepdims=True)))
    return int(((leg.phi[fr] > 20 * D) & (np.sum(bn * fwd, 1) < -0.25)).sum())


def rot_rate(lq0, lq1, bones, a, b):
    """max local rotation per frame (deg) of `bones` over frames a - 1 .. b of lq1"""
    q = lq1[a - 1:b + 1][:, bones]
    d = np.abs(np.sum(q[1:] * q[:-1], -1))
    return float(np.degrees(2 * np.arccos(np.clip(d, 0, 1))).max())


def relax(M, name, pose, lt, vehs, f_deck):
    lq = pose['lq'].copy(); ref = pose['lq']
    rep = []
    relaxed = qaxis(X, 14 * D)                       # toes hanging a little
    for side, oside in (('Left', 'Right'), ('Right', 'Left')):
        leg = Leg(M, side, lq.copy(), lt)
        hold = leg.holds()
        bones = [leg.iU, leg.iL, leg.iF]
        for a, b in _runs(~hold):
            n = b - a
            if n < 12 or (a >= f_deck and n < DECK_MIN):
                continue
            fr = np.arange(a, b)
            rel = leg.beta[fr] - leg.pel[fr]
            back = float(rel.max()); stiff = int((leg.ext[fr] > 0.93).sum())
            low = rel > -35 * D                       # (a knee out to the side with the hip flexed is a normal high step)
            outm = float(leg.out[fr][low].max()) if low.any() else 0.0
            if not (back > BACK_FLAG or outm > OUT_FLAG or stiff >= STIFF_FLAG):
                continue
            other = Leg(M, oside, lq.copy(), lt)
            i = np.arange(n)
            wa = _ss((i + 1) / min(RAMP_IN, n * 0.4)) * _ss((n - i) / min(RAMP_OUT, n * 0.4))
            lqF = lq[:, leg.iF].copy()
            lqF[fr] = qslerp(lq[fr, leg.iF], np.broadcast_to(relaxed, (n, 4)), wa * ANKLE_RELAX)
            r = dict(side=side, frames=(a, b), deck=bool(a >= f_deck), back=round(back / D), out=round(outm / D), stiff=stiff)
            frb = np.arange(a - 1, b + 1)             # (with the two hold frames: a knee / boot resting on the hull counts as allowed)
            P0, rad = spheres(M, leg, frb)
            pen0 = float(pen_of(name, vehs, P0, rad).max()) if vehs else -1.0
            low0 = min(float((P0[..., 1] - rad).min()), 0.0)
            kb0 = knee_back(leg, fr)
            ok = False
            margin = np.full(n, PEN_FREE)
            pen_lim = max(pen0, PEN_OK) + 0.006
            for attempt in range(6):                  # (where the smoothed path still touches the hull: more clearance there, re-plan)
                lq2 = lq.copy()
                beta, phi, out_n, tau = plan(M, name, vehs, leg, other, a, b, lqF, r, margin)
                apply(M, leg, lq2, fr, beta, phi, out_n, tau, lqF)
                continuity(lq2, ref, bones)
                new = Leg(M, side, lq2.copy(), lt)
                P1, _ = spheres(M, new, fr)
                pf = pen_of(name, vehs, P1, rad) if vehs else np.full(n, -1.0)
                pen1 = float(pf.max())
                rot = rot_rate(ref, lq2, bones, a, b)
                rel1 = new.beta[fr] - new.pel[fr]
                r.update(back1=round(float(rel1.max()) / D), out1=round(float(new.out[fr][rel1 > -35 * D].max() if (rel1 > -35 * D).any() else 0) / D),
                         stiff1=int((new.ext[fr] > 0.93).sum()), knee1=round(float(new.phi[fr].max()) / D), pen0=round(pen0, 3),
                         pen1=round(pen1, 3), rot=round(rot, 1), tries=attempt + 1)
                r['kb'] = (kb0, knee_back(new, fr))
                if (r['cost'] < 1e5 and rot <= ROT_OK and pen1 <= pen_lim and (P1[..., 1] - rad).min() > low0 - 0.012
                        and r['kb'][1] <= kb0 and r['knee1'] <= 150):
                    ok = True
                    break
                bad = pf > pen_lim
                if not bad.any():
                    margin = margin - 0.025
                else:
                    margin = margin - 0.025 * (np.convolve(bad.astype(float), np.ones(9), mode='same') > 0)
            r['applied'] = ok
            if ok:
                lq = lq2
            rep.append(r)
    return lq, rep


def main():
    args = sys.argv[1:]
    glb = os.path.join(HERE, '../../../assets/soldiers/soldier_anims.glb')
    dry = '--dry' in args
    if dry:
        args.remove('--dry')
    if '--glb' in args:
        i = args.index('--glb'); glb = args[i + 1]; del args[i:i + 2]
    raw = bytearray(open(glb, 'rb').read())
    n = struct.unpack('<I', raw[12:16])[0]
    g = json.loads(raw[20:20 + n]); bin0 = 20 + n + 8
    G = CA.read_glb(glb); M = CA.Model(G); I = M.idx
    names = args or [a for a in G['anims'] if a.startswith('mount_')]
    use = {}
    for a in g['animations']:
        for s in a['samplers']:
            use[s['output']] = use.get(s['output'], 0) + 1
    legs = [I[s + b] for s in ('Left', 'Right') for b in ('UpLeg', 'Leg', 'Foot')]
    EV = {k: v.get('events', {}) for k, v in json.load(open(os.path.join(os.path.dirname(glb), 'manifest.json')))['soldier_anims']['clips'].items()}
    for name in names:
        pose = M.pose(name)
        lt = np.tile(M.T, (pose['F'], 1, 1))
        for (nd, path), v in G['anims'][name]['ch'].items():
            if path == 'translation':
                lt[:, nd] = v
        vehs = [v for v in CV.LAYOUT[name].get('veh', ())]
        if not name.startswith('mount_deck'):      # (mount_door / mount_rear: short steps inside the hull, nothing over the limits)
            continue
        f_deck = int(round(EV[name]['on_deck'] * CA.FPS))
        lq, rep = relax(M, name, pose, lt, vehs, f_deck)
        print(name, '' if rep else '(no swing over the limits)')
        for r in rep:
            print('   ', r)
        an = next(a for a in g['animations'] if a['name'] == name)
        for c in an['channels']:
            nd = c['target']['node']
            if c['target']['path'] != 'rotation' or nd not in legs or np.allclose(lq[:, nd], pose['lq'][:, nd], atol=1e-7):
                continue
            ai = an['samplers'][c['sampler']]['output']
            acc = g['accessors'][ai]; bv = g['bufferViews'][acc['bufferView']]
            assert use[ai] == 1 and acc['componentType'] == 5126 and acc['count'] == pose['F'] and not bv.get('byteStride')
            o = bin0 + bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
            raw[o:o + pose['F'] * 16] = lq[:, nd].astype('<f4').tobytes()
    if not dry:
        open(glb, 'wb').write(raw)
        print('written', glb)


if __name__ == '__main__':
    main()
