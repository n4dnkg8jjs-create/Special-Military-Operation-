"""models_v12: field-uniform construction in 3D (bind pose of variant A), shared by the texture bake (uniform_tex.bake_uniform) and
the shell offsets (build_soldier.thicken_uniform).

Why: the uniform's UV islands (body.panel_labels: dominant bone + a z split, on the decimated triangles) have jagged, zigzag borders.
The old bake drew the seams along those borders and generated the camo in UV space, so the print broke along the zigzags too, and the
shell offsets (jacket 8 mm, trousers 14-21 mm, sleeves 12 mm) were switched by the same labels -> contorted seams, a trouser shell
standing proud of the jacket (it read as a jumpsuit).  Here every garment panel and seam is an analytic, smooth function of the 3D
position, laid out like a real BDU-type field jacket + trousers (Ratnik summer suit / MM-14 field uniform):

  jacket  : two fronts (centre-front zip under a placket), back, back yoke, set-in sleeves (armhole seam, one underarm seam per
            sleeve), stand collar + cuffs (own geometry), hem at hip level (y = HEM), worn OUT over the trousers (the trouser belt is hidden under
            it; models_v13);
  trousers: left / right legs, each a front and a back panel joined by the outseam (lateral) and the inseam (medial), crotch / seat
            seam on x = 0, knee reinforcements, thigh cargo pockets, bloused into the boots.

Panel coordinates (u, v) are metres of cloth (u round the body / limb, v along it = the grain), so the camo is printed per panel and
breaks exactly on the seams, with straight, smooth seam lines."""
import numpy as np

HEM = 0.895            # jacket hem height (variant A bind pose, m)
BELT = (0.983, 1.028)  # trouser belt band (bottom, top) - UNDER the jacket
BELT_ON = False        # models_v13: the jacket is worn out over the trousers, its hem covers the trouser belt -> no belt is drawn /
                       # modelled on the jacket (v12 painted one over it); the waist only gathers softly (drawcord)
YOKE = 1.365           # back yoke seam height at the centre back
A_SIDE = np.pi / 2 + 0.10   # side / shoulder seam: angle from the front round the trunk axis (slightly behind the coronal plane)

# panel ids
JF_L, JF_R, J_BACK, J_YOKE, SL_L, SL_R, TF_L, TB_L, TF_R, TB_R, COLLAR, CUFF_L, CUFF_R = range(13)
JACKET_PANELS = (JF_L, JF_R, J_BACK, J_YOKE, SL_L, SL_R, COLLAR, CUFF_L, CUFF_R)


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def limb_coords(P, a, b, ref):
    """cylindrical coords around segment a->b: s (m from a along axis), theta (rad from ref), r"""
    ax = (b - a) / np.linalg.norm(b - a)
    rel = P - a
    s = rel @ ax
    radial = rel - s[..., None] * ax
    r = np.linalg.norm(radial, axis=-1)
    e1 = ref - np.dot(ref, ax) * ax; e1 /= np.linalg.norm(e1)
    e2 = np.cross(ax, e1)
    th = np.arctan2(radial @ e2, radial @ e1)
    return s, th, r


class Garment:
    def __init__(self, J, PA):
        """J(name) -> joint head (bind pose); PA: uniform vertex positions of variant A (bind pose, unthickened)"""
        self.J = J
        # trunk axis: z centre per height from the centre-line vertices (front / back extremes at |x| < 4 cm)
        ys = np.arange(0.80, 1.60, 0.01)
        zc = []
        for y in ys:
            m = (np.abs(PA[:, 0]) < 0.04) & (np.abs(PA[:, 1] - y) < 0.012)
            zc.append(0.5 * (PA[m, 2].max() + PA[m, 2].min()) if m.sum() > 2 else np.nan)
        zc = np.array(zc); ok = ~np.isnan(zc)
        zc = np.interp(ys, ys[ok], zc[ok])
        from scipy.ndimage import gaussian_filter1d
        self.ys, self.zc = ys, gaussian_filter1d(zc, 4, mode='nearest')
        # armhole planes (fitted to the shoulder joints of the bind pose: through the shoulder point on top, ~2 cm outboard of the
        # armpit underneath, leaning forward a little like a set-in sleeve)
        self.arm = {}
        for side, sx in (('Left', 1), ('Right', -1)):
            a = J(side + 'Arm')
            n = np.array([0.953 * sx, 0.141, 0.268]); n /= np.linalg.norm(n)
            c = a + np.array([-0.027 * sx, -0.015, 0.012])
            self.arm[side] = (c, n)

    def zcen(self, y):
        return np.interp(y, self.ys, self.zc)

    def fields(self, P, lab=None):
        """per point: panel id, panel (u, v) in metres, and the signed seam distances (m) used by the bake.
        lab: optional per-point label strings / ids already reduced to 'collar' / 'cuff_L' / 'cuff_R' masks (dict of bool arrays)"""
        J = self.J
        x, y, z = P[..., 0], P[..., 1], P[..., 2]
        F = {}
        # ---- sleeves (set-in): armhole plane distance, only in the arm zone (not the hips / the far side of the chest)
        for side, sx in (('Left', 1), ('Right', -1)):
            c, n = self.arm[side]
            d = (P - c) @ n
            zone = (x * sx > 0.08) & ((y > 1.17) | (x * sx > 0.27))
            F['arm_d_' + side[0]] = np.where(zone, d, -1.0)
            sh, el, wr = J(side + 'Arm'), J(side + 'ForeArm'), J(side + 'Hand')
            ref = np.array([sx, 0.0, 0])
            s1, th1, r1 = limb_coords(P, sh, el, ref)
            s2, th2, r2 = limb_coords(P, el, wr, ref)
            Lu = np.linalg.norm(el - sh)
            up = s1 < Lu
            F['sl_s_' + side[0]] = np.where(up, s1, Lu + s2)
            F['sl_th_' + side[0]] = np.where(up, th1, th2)
            F['sl_r_' + side[0]] = np.where(up, r1, r2)
            F['sl_Lu_' + side[0]] = Lu
            F['sl_L_' + side[0]] = Lu + np.linalg.norm(wr - el)
        sleeve_L = F['arm_d_L'] > 0
        sleeve_R = F['arm_d_R'] > 0
        # ---- trunk
        zc = self.zcen(y)
        a = np.arctan2(x, z - zc)                      # 0 = front, +-pi = back, + = his left
        rh = np.hypot(x, z - zc)
        F['trunk_a'], F['trunk_r'] = a, rh
        F['side_d'] = rh * (np.abs(a) - A_SIDE)       # + behind the side / shoulder seam
        F['hem_d'] = y - HEM                          # + = jacket
        F['yoke_d'] = y - (YOKE + 0.02 * (np.abs(x) / 0.2) ** 2)
        # ---- trousers: limb coords per leg (lateral = 0), seams at th = 0 (outseam) and +-pi (inseam), centre seam at x = 0
        for side, sx in (('Left', 1), ('Right', -1)):
            hp, kn, an = J(side + 'UpLeg'), J(side + 'Leg'), J(side + 'Foot')
            ref = np.array([sx, 0.0, 0])
            s1, th1, r1 = limb_coords(P, hp, kn, ref)
            s2, th2, r2 = limb_coords(P, kn, an, ref)
            Lu = np.linalg.norm(kn - hp)
            up = s1 < Lu
            F['lg_s_' + side[0]] = np.where(up, s1, Lu + s2)
            th = np.where(up, th1, th2)
            F['lg_th_' + side[0]] = th
            F['lg_r_' + side[0]] = np.where(up, r1, r2)
            F['lg_Lu_' + side[0]] = Lu
            F['lg_fw_' + side[0]] = np.pi / 2 * sx         # angle of the front (+z) direction
        # ---- panel ids + cloth coordinates
        pid = np.full(P.shape[:-1], -1, np.int16)
        U = np.zeros(P.shape[:-1], np.float32); V = np.zeros(P.shape[:-1], np.float32)
        left = x >= 0
        jk = F['hem_d'] > 0
        back = F['side_d'] > 0
        yoke = back & (F['yoke_d'] > 0)
        m = jk & ~back
        pid[m & left] = JF_L; pid[m & ~left] = JF_R
        pid[jk & back & ~yoke] = J_BACK
        pid[jk & yoke] = J_YOKE
        U = np.where(jk, a * rh, U); V = np.where(jk, -y, V)
        U = np.where(jk & back, (np.mod(a, 2 * np.pi) - np.pi) * rh, U)       # back: continuous across the centre back
        for side, k, kf, kb in (('L', SL_L, TF_L, TB_L), ('R', SL_R, TF_R, TB_R)):
            sl = sleeve_L if side == 'L' else sleeve_R
            pid[sl] = k
            U = np.where(sl, F['sl_th_' + side] * F['sl_r_' + side], U)
            V = np.where(sl, F['sl_s_' + side], V)
            tr = ~jk & ~sl & ((x >= 0) if side == 'L' else (x < 0))
            th = F['lg_th_' + side]
            fr = np.sin(th) * (1 if side == 'L' else -1) > 0           # front half (+z) of this leg
            pid[tr & fr] = kf; pid[tr & ~fr] = kb
            U = np.where(tr, th * F['lg_r_' + side], U)
            V = np.where(tr, F['lg_s_' + side], V)
        if lab is not None:
            for key, k in (('collar', COLLAR), ('cuff_L', CUFF_L), ('cuff_R', CUFF_R)):
                if key in lab:
                    mm = lab[key]
                    pid[mm] = k
                    if key == 'collar':
                        U = np.where(mm, a * 0.075, U); V = np.where(mm, -y, V)
                    else:
                        # round the cuff ring's own centre (the wrist is bent off the forearm axis in the bind pose)
                        sd = key[-1]; side = 'Left' if sd == 'L' else 'Right'
                        c = getattr(self, 'cuff_c', {}).get(sd)
                        if c is not None:
                            ax = J(side + 'Hand') - J(side + 'ForeArm'); ax /= np.linalg.norm(ax)
                            s_, th_, _ = limb_coords(P, c - ax * 0.1, c, np.array([1.0 if sd == 'L' else -1.0, 0, 0]))
                            U = np.where(mm, th_ * 0.05, U); V = np.where(mm, s_, V)
        F['pid'], F['u'], F['v'] = pid, U, V
        F['sleeve_L'], F['sleeve_R'], F['jacket'] = sleeve_L, sleeve_R, jk | sleeve_L | sleeve_R
        return F

    def memberships(self, P):
        """smooth (0..1) garment weights for the shell offsets: sleeve_L / sleeve_R (across the armhole, 1.2 cm), jacket (across
        the hem, 1 cm), left (across the centre seam, 2 cm)"""
        F = self.fields(P)
        w = {}
        for sd in 'LR':
            w['sleeve_' + sd] = sstep(-0.012, 0.012, F['arm_d_' + sd]) * (F['arm_d_' + sd] > -0.9)
        w['jacket'] = sstep(-0.004, 0.006, F['hem_d'])
        w['left'] = sstep(-0.02, 0.02, P[:, 0])
        return F, w
