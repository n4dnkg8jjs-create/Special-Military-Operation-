"""Uniform texture baking: camo albedo with seams/pockets/patches/dirt + tangent-space normal map.
Everything is evaluated per texel from rasterised bind-pose position/normal maps."""
import numpy as np
from scipy import ndimage
import tex as TX
import camo as C
import garment as GM


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


def rect_sdf(x, y, cx, cy, hw, hh, rad=0.01):
    dx = np.abs(x - cx) - hw + rad; dy = np.abs(y - cy) - hh + rad
    return np.minimum(np.maximum(dx, dy), 0) + np.hypot(np.maximum(dx, 0), np.maximum(dy, 0)) - rad


def seam_profile(sd, width=0.004):
    """height contribution of a stitched seam along an SDF zero line (metres): sunk seam line with a raised welt (the folded seam
    allowance under the cloth) beside it -> the cloth reads as thick twill, not paint"""
    g = -0.0008 * np.exp(-(sd / (width * 0.32)) ** 2)  # groove
    g += 0.00055 * np.exp(-((sd - width * 0.95) / (width * 0.55)) ** 2) + 0.00030 * np.exp(-((sd + width * 0.85) / (width * 0.45)) ** 2)
    return g


def crease(x, sharp=0.75):
    """cloth fold profile along a phase x (period 1), zero-mean-ish.  v7: a soft rounded ridge with broad, smooth valleys (raised
    cosine, slightly peaked) - the old |sin|^0.75 profile had cusp troughs that baked into thin dark lines in the normal / cavity
    maps.  `sharp` < 1 makes the ridges a little narrower (kept for the old call signature)."""
    c = 0.5 - 0.5 * np.cos(2 * np.pi * x)
    return c ** (1.0 + 0.6 * (1 - sharp)) - 0.45


def radial_folds(P, c, plane, n_folds, reach, seed, warp=1.6):
    """folds radiating from a point c (crotch, armpit, inner elbow): phase from the angle around c in the plane spanned by the two
    axes `plane` (indices), amplitude falling off with distance (0 at c, peak ~reach/3, gone at ~reach)"""
    rel = P - c
    a = np.arctan2(rel[..., plane[1]], rel[..., plane[0]])
    r = np.linalg.norm(rel, axis=-1)
    ph = a * n_folds / (2 * np.pi) + TX.noise3(P, 0.09, seed, 2) * warp * 0.35 + r * 6
    env = (1 - np.exp(-(r / (reach * 0.18)) ** 2)) * np.exp(-(r / reach) ** 2)
    return crease(ph) * env


def stitches(sd, along, off=0.003, pitch=0.004):
    line = np.exp(-((np.abs(sd) - off) / 0.0006) ** 2)
    dash = (np.sin(along / pitch * 2 * np.pi) > -0.2).astype(np.float32)
    return line * dash * 0.00025


# ======================================================================================================== models_v12 bake
# Seams, panels and the camo print come from garment.py (analytic 3D garment construction, smooth and straight), NOT from the UV
# island borders (jagged); folds only where cloth bunches (inside the elbows, behind the knees, crotch, waist round the belt, behind
# the shoulders, sleeve ends, boot blousing), soft and shallow.  The jacket is worn out over the trousers: hem at hip level with a
# rolled edge and a shadow on the trousers under it (models_v13: no belt over the jacket - GM.BELT_ON), trousers a little darker / more worn.

SHEET_M = 3.3                         # camo "bolt of cloth" the panels are cut from (m, square)
BELT_COL = {'ru': '#34362c', 'ua': '#544c3a'}
BUCKLE_COL = '#26272a'


def _labmasks(tl):
    return {'collar': np.char.startswith(tl, 'collar'), 'cuff_L': np.char.startswith(tl, 'cuff_L'),
            'cuff_R': np.char.startswith(tl, 'cuff_R')}


def _sheet(kind, pxm, seed):
    S = int(SHEET_M * pxm)
    if kind == 'emr':
        return C.emr(S, pxm, seed)
    if kind == 'mm14':
        return C.mm14(S, pxm, seed)
    return C.multicam(S, pxm, seed)


def _layout(pid, U, V, mask):
    """cutting layout: every panel's (u, v) bounding box shelf-packed on the bolt (5 cm apart, in panel-id order)"""
    off = {}
    x = y = rowh = 0.05
    for k in sorted(set(np.unique(pid[mask]).tolist()) - {-1}):
        m = mask & (pid == k)
        u0, u1 = U[m].min(), U[m].max(); v0, v1 = V[m].min(), V[m].max()
        w, h = u1 - u0, v1 - v0
        if x + w > SHEET_M - 0.05:
            x = 0.05; y += rowh + 0.05; rowh = 0
        off[k] = (x - u0, y - v0)
        x += w + 0.05; rowh = max(rowh, h)
    return off


def _sample(sheet, pxm, X, Y):
    """bilinear lookup (X, Y in metres on the bolt, wrapped)"""
    S = sheet.shape[0]
    fx = X * pxm - 0.5; fy = Y * pxm - 0.5
    x0 = np.floor(fx).astype(np.int64); y0 = np.floor(fy).astype(np.int64)
    wx = (fx - x0)[..., None].astype(np.float32); wy = (fy - y0)[..., None].astype(np.float32)
    x0 %= S; y0 %= S; x1 = (x0 + 1) % S; y1 = (y0 + 1) % S
    return (sheet[y0, x0] * (1 - wx) * (1 - wy) + sheet[y0, x1] * wx * (1 - wy) + sheet[y1, x0] * (1 - wx) * wy +
            sheet[y1, x1] * wx * wy)


def bake_uniform(mesh, skel, labels, faction, variant, res_a=2048, res_n=1024, top='camo', seed=0):
    """mesh: dict pos/nrm/uv/tri (GL arrays, bind pose). labels: per-tri label strings.
    faction 'ru'|'ua'. top: 'camo' or 'multicam' (UA jacket). returns albedo(res_a), normal(res_n), uv_scale"""
    rng = np.random.default_rng(seed)
    pos, nrm, uv, tri = mesh['pos'], mesh['nrm'], mesh['uv'], mesh['tri']
    labels = np.asarray(labels).astype(str)
    R = TX.raster(uv, tri, {'P': pos, 'N': nrm}, res_n, tri_attrs={'t': np.arange(len(tri))})
    P, N, mask = R['P'], R['N'], R['mask']
    tl = np.where(mask, labels[np.maximum(R['t'], 0)], '')
    LM = _labmasks(tl)
    a3 = np.linalg.norm(np.cross(pos[tri[:, 1]] - pos[tri[:, 0]], pos[tri[:, 2]] - pos[tri[:, 0]]), axis=1).sum() / 2
    u3 = np.c_[uv, np.zeros(len(uv))]
    a2 = np.linalg.norm(np.cross(u3[tri[:, 1]] - u3[tri[:, 0]], u3[tri[:, 2]] - u3[tri[:, 0]]), axis=1).sum() / 2
    uv_per_m = np.sqrt(a2 / a3)
    texel_m = 1.0 / (uv_per_m * res_n)
    J = lambda n: skel.head[skel.idx[n]]
    G = GM.Garment(J, pos)
    G.cuff_c = {sd: pos[np.unique(tri[np.char.startswith(labels, 'cuff_' + sd)])].mean(0) for sd in 'LR'}
    F = G.fields(P, LM)
    pid = F['pid']
    collar, cufL, cufR = LM['collar'], LM['cuff_L'], LM['cuff_R']
    cuffs = cufL | cufR
    slv = {'L': F['sleeve_L'] & ~cuffs & ~collar, 'R': F['sleeve_R'] & ~cuffs & ~collar}
    jk_t = mask & (F['hem_d'] > 0) & ~F['sleeve_L'] & ~F['sleeve_R'] & ~collar & ~cuffs     # jacket body
    trs = mask & (F['hem_d'] <= 0) & ~F['sleeve_L'] & ~F['sleeve_R'] & ~collar & ~cuffs    # trousers
    x, y, z = P[..., 0], P[..., 1], P[..., 2]
    H = np.zeros((res_n, res_n), np.float32)
    FOLD = np.zeros((res_n, res_n), np.float32)
    shade = np.ones((res_n, res_n), np.float32)
    g = lambda d, s: np.exp(-(d / s) ** 2)

    def seam(sd, m, along, rows=(0.0035,), dark=0.16):
        """stitched seam on the zero line of sd inside mask m (+ topstitch rows at the given offsets)"""
        nonlocal H, shade
        h = seam_profile(sd)
        for o in rows:
            h = h + stitches(sd, along, o, 0.004)
        H += np.where(m, h, 0)
        shade *= np.where(m, 1 - dark * g(sd - 0.0005, 0.0016), 1)

    tap = np.clip(0.6 + 0.8 * TX.noise3(P, 0.07, seed + 77, 2), 0.15, 1.3)      # folds fade in / out along their length
    # very low, broad unevenness of the cloth (no stripes, no creases)
    H += 0.0005 * TX.noise3(P, 0.25, seed + 11, 2)
    # ================================================================ jacket
    a, rh = F['trunk_a'], F['trunk_r']
    # side seams + shoulder seams (one coronal-ish line), flat-felled: two rows of stitching
    m = (jk_t | slv['L'] | slv['R']) & (np.abs(F['side_d']) < 0.02) & ~(slv['L'] | slv['R'])
    seam(F['side_d'], m, y + np.abs(x), rows=(0.0035, 0.0085))
    # back yoke
    bk = jk_t & (F['side_d'] > 0)
    seam(F['yoke_d'], bk & (np.abs(F['yoke_d']) < 0.02), x, rows=(0.0035, 0.0085))
    # armholes (both sides of the line: torso + sleeve cap)
    for sd_ in 'LR':
        d = F['arm_d_' + sd_]
        m = mask & ~collar & ~cuffs & (d > -0.5) & (np.abs(d) < 0.02) & (y > 1.2)
        seam(d, m, y + z, rows=(0.0035,))
    # front: zip under a placket flap (flap from x = -0.026 to +0.012), stitched both edges
    fr = jk_t & (np.abs(a) < np.pi / 2)
    fl = fr & (x > -0.026) & (x < 0.012)
    H += np.where(fl, 0.0011, 0)
    for e in (-0.026, 0.012):
        seam(x - e, fr & (np.abs(x - e) < 0.015), y, rows=(0.005,), dark=0.22)
    # hem: rolled edge at y = HEM, two rows of stitching above it; the jacket stands proud of the trousers, which lie in its shadow
    hd = F['hem_d']
    near = mask & ~collar & ~cuffs & ~F['sleeve_L'] & ~F['sleeve_R'] & (np.abs(hd) < 0.06)
    H += np.where(near, 0.0020 * sstep_(-0.002, 0.003, hd) + 0.0007 * g(hd - 0.006, 0.004), 0)
    H += np.where(near & (hd > 0), stitches(hd - 0.012, a * rh, 0.0, 0.004) + stitches(hd - 0.026, a * rh, 0.0, 0.004)
                  + seam_profile(hd - 0.030) * 0.6, 0)
    shade *= np.where(near, 1 - 0.42 * g(np.minimum(hd, 0) + 0.004, 0.010) * (hd < 0.001) - 0.10 * g(hd - 0.0015, 0.0015), 1)
    b0, b1 = GM.BELT
    aw = np.arctan2(x, z - G.zcen(y))
    if GM.BELT_ON:
        # belt over the jacket at the waist: 45 mm webbing, cobra-type buckle at the front, cloth gathered above / below it
        bm = jk_t & (y > b0 - 0.004) & (y < b1 + 0.004)
        belt = jk_t & (y > b0) & (y < b1)
        bh = 0.0028 * sstep_(b0, b0 + 0.004, y) * (1 - sstep_(b1 - 0.004, b1, y))
        H += np.where(bm, bh + 0.00012 * np.sin((y - b0) / 0.0012 * 2 * np.pi) * belt, 0)
        buck = belt & (np.abs(a) < 0.25) & (np.abs(x) < 0.032)
        H += np.where(buck, 0.0030 * sstep_(0.032, 0.026, np.abs(x)), 0)
        shade *= np.where(jk_t, 1 - 0.30 * g(y - b0 + 0.003, 0.004) - 0.18 * g(y - b1 - 0.002, 0.003), 1)
        for yc_, s_, sg in ((b1 + 0.022, 0.018, 1), (b0 - 0.020, 0.016, -1)):
            wg = crease(aw * 22 / (2 * np.pi) + TX.noise3(P, 0.07, seed + 95 + sg, 2) * 0.6) * g(y - yc_, s_)
            H += tap * jk_t * wg * 0.0011; FOLD += jk_t * wg * 0.8
    else:
        # models_v13: no belt on the jacket (worn out over the trousers, the trouser belt is under it): only soft, irregular
        # gathers round the natural waist (drawcord), no band, no hard edges
        yw = 0.5 * (b0 + b1)
        wg = crease(aw * 16 / (2 * np.pi) + TX.noise3(P, 0.07, seed + 95, 2) * 0.8) * g(y - yw, 0.030)
        H += tap * jk_t * wg * 0.0008; FOLD += jk_t * wg * 0.5
    # behind the shoulders: short soft folds fanning from the back of the armpits over the shoulder blades
    for side, sx in (('Left', 1), ('Right', -1)):
        ap = J(side + 'Arm') + np.array([-sx * 0.04, -0.075, -0.07])
        rf = radial_folds(P, ap, (0, 1), 6, 0.12, seed + 80 + sx, warp=1.0)
        H += tap * bk * rf * 0.0010; FOLD += bk * rf * 0.6
    # ================================================================ sleeves
    for side, sx in (('Left', 1), ('Right', -1)):
        sd = side[0]
        m = slv[sd]
        s, th, r = F['sl_s_' + sd], F['sl_th_' + sd], F['sl_r_' + sd]
        Lu, Lt = F['sl_Lu_' + sd], F['sl_L_' + sd]
        on_up = s < Lu
        # underarm seam (one seam per sleeve, on the inside facing the trunk, th = +-pi)
        seam(r * (np.pi - np.abs(th)), m & (np.pi - np.abs(th) < 0.5), s, rows=(0.0035,))
        # inside of the elbow: a few soft creases where the cloth bunches (crook faces +z in the bind pose)
        de = s - Lu
        crook = 0.5 + 0.5 * np.cos(th - np.pi / 2 * sx)
        cr_ = crease(de / 0.034 + 0.4 * np.sin(th * 1.3) + TX.noise3(P, 0.08, seed + 3, 1) * 0.4) * g(de, 0.06)
        H += tap * m * cr_ * 0.0018 * crook ** 2; FOLD += m * cr_ * crook ** 2
        ie = J(side + 'ForeArm') + np.array([0, 0, 0.035])
        rf = radial_folds(P, ie, (0, 1), 6, 0.09, seed + 40 + sx, warp=1.0)
        H += tap * m * rf * 0.0008 * crook; FOLD += m * rf * crook * 0.5
        # sleeve end gathered against the cuff
        dc = s - (Lt - 0.03)
        gc = crease(th * 6 / (2 * np.pi) + s * 9 + TX.noise3(P, 0.05, seed + 7, 1) * 0.4) * g(dc, 0.035)
        H += m * gc * 0.0008; FOLD += m * gc * 0.4
        # sleeve pocket (bare velcro panel) on the upper outer arm
        r_arm = 0.055
        sdp = rect_sdf(th * r_arm, s, 0.0, 0.14, 0.065, 0.075, 0.012)
        pk = m & on_up
        H += np.where(pk, np.where(sdp < 0, 0.0014, 0) + seam_profile(sdp) + stitches(sdp, th * r_arm + s, 0.003), 0)
        shade *= np.where(pk, 1 - 0.22 * g(sdp - 0.001, 0.002), 1)
        fsd = rect_sdf(th * r_arm, s, 0, 0.078, 0.068, 0.024, 0.008)
        H += np.where(pk & (fsd < 0), 0.0010, 0) + np.where(pk, seam_profile(fsd), 0)
        shade *= np.where(pk & (np.abs(fsd) < 0.003) & (s > 0.09), 0.75, 1)
        # elbow reinforcement on the back of the elbow
        esd = rect_sdf(th * 0.05, s, (np.pi / 2 * sx) * 0.05 * 0.9, Lu, 0.05, 0.07, 0.03)
        H += np.where(m, seam_profile(esd) + stitches(esd, s + th * 0.05, 0.003) + np.where(esd < 0, 0.0005, 0), 0)
    # cuffs / collar: own geometry -> seams on their island borders (straight mesh loops) + a stitched band
    for cm in (collar, cufL, cufR):
        if cm.any():
            dist = ndimage.distance_transform_edt(cm) * texel_m
            H += np.where(cm, seam_profile(dist - 0.003) + stitches(dist - 0.007, x + y + z, 0.0, 0.004), 0)
            shade *= np.where(cm, 1 - 0.16 * g(dist - 0.002, 0.0015), 1)
    # ================================================================ trousers
    for side, sx in (('Left', 1), ('Right', -1)):
        sd = side[0]
        m = trs & ((x >= 0) if sd == 'L' else (x < 0))
        s, th, r = F['lg_s_' + sd], F['lg_th_' + sd], F['lg_r_' + sd]
        Lu, fw = F['lg_Lu_' + sd], F['lg_fw_' + sd]
        on_up = s < Lu
        # outseam (lateral) + inseam (medial)
        seam(r * th, m & (np.abs(th) < 0.5), s, rows=(0.0035, 0.0085))
        seam(r * (np.pi - np.abs(th)), m & (np.pi - np.abs(th) < 0.5), s, rows=(0.0035,))
        dk = s - Lu
        frontk = 0.5 + 0.5 * np.cos(th - fw); backk = 1 - frontk
        # behind the knee: a few stacked soft folds; front: the cloth bags a little over the knee (no lines)
        kb = crease(dk / 0.034 + 0.35 * np.sin(th * 2) + TX.noise3(P, 0.06, seed + 5, 2) * 0.5) * g(dk, 0.065)
        H += tap * m * kb * 0.0022 * backk ** 2; FOLD += m * kb * backk ** 2
        H += m * 0.0010 * g(dk + 0.01, 0.05) * frontk
        # bloused into the boots: the cloth gathers in soft puckers over the boot tops
        db = y - 0.27
        bl_ = crease(th * 7 / (2 * np.pi) + y * 9 + TX.noise3(P, 0.06, seed + 8, 2) * 0.5) * g(db, 0.045) * np.clip((db + 0.04) / 0.03, 0, 1)
        H += m * tap * bl_ * 0.0028; FOLD += m * tap * bl_ * 0.8
        # thigh cargo pocket (bellows) with flap
        r_th = 0.085
        thp = th - 0.35 * sx
        sdp = rect_sdf(thp * r_th, s, 0, 0.30, 0.085, 0.10, 0.015)
        pk = m & on_up
        H += np.where(pk, np.where(sdp < 0, 0.0020, 0) + seam_profile(sdp) + stitches(sdp, thp * r_th + s, 0.003), 0)
        shade *= np.where(pk, 1 - 0.28 * g(sdp - 0.001, 0.0025), 1)
        fsd = rect_sdf(thp * r_th, s, 0, 0.215, 0.088, 0.028, 0.01)
        H += np.where(pk & (fsd < 0), 0.0015, 0) + np.where(pk, seam_profile(fsd), 0)
        shade *= np.where(pk & (np.abs(fsd) < 0.003) & (s > 0.23), 0.72, 1)
        H += np.where(pk & (sdp < 0) & (s > 0.25), np.sin(thp * r_th / 0.03 * 2 * np.pi) * 0.00025, 0)
        # knee reinforcement (double layer) on the front of the knee
        ksd = rect_sdf((th - fw) * 0.06, s, 0, Lu + 0.01, 0.065, 0.10, 0.03)
        H += np.where(m, seam_profile(ksd) + stitches(ksd, s + th * 0.06, 0.003) + np.where(ksd < 0, 0.0006, 0), 0)
    # crotch / seat seam on x = 0, soft folds radiating from the crotch over the fronts of the thighs (under the hem)
    seam(x, trs & (np.abs(x) < 0.02), y, rows=(0.0035,))
    cro = np.array([0.0, J('LeftUpLeg')[1] - 0.09, J('Hips')[2] + 0.02])
    rc = radial_folds(P, cro, (0, 1), 7, 0.13, seed + 70, warp=1.0)
    frc = np.clip((z - cro[2] + 0.05) / 0.08, 0, 1)
    H += tap * trs * rc * 0.0012 * (0.4 + 0.6 * frc); FOLD += trs * rc * (0.4 + 0.6 * frc) * 0.8
    # ================================================================ fabric micro detail
    yy, xx = np.mgrid[0:res_n, 0:res_n]
    per = 0.005 / texel_m
    rip = ((np.abs(((xx / per) % 1) - 0.5) > 0.43) | (np.abs(((yy / per) % 1) - 0.5) > 0.43)).astype(np.float32)
    H += rip * 0.00012 + rng.standard_normal(H.shape).astype(np.float32) * 0.00004
    H = TX.dilate(H, mask, 6)
    H = ndimage.gaussian_filter(H, 0.6)
    normal = TX.height_to_normal(H / texel_m, 1.25)
    blur = ndimage.gaussian_filter(H, 3)
    cav = np.clip(1 + (H - blur) * 170, 0.78, 1.10)
    blur2 = ndimage.gaussian_filter(H, 12)
    cav *= np.clip(1 + (H - blur2) * 140, 0.80, 1.08)
    FOLD = ndimage.gaussian_filter(TX.dilate(FOLD * tap, mask, 6), 3.0)
    cav *= np.clip(1 + 0.16 * FOLD, 0.84, 1.08)
    # ---- dirt / wear masks (in 3D), as soldiers_v6
    n_d = TX.noise3(P, 0.12, seed + 9, 3)
    n_s = TX.noise3(P, 0.035, seed + 19, 2)
    wetm = np.clip((0.42 - y) / 0.18, 0, 1) ** 1.2
    dirt = np.clip((0.70 - y) / 0.42, 0, 1) ** 1.2 * 0.75
    grime = np.zeros_like(y)
    for side in ('Left', 'Right'):
        k = J(side + 'Leg')
        kd = np.sum(((P - k - [0, -0.01, 0.07]) * [1.0, 0.8, 1.0]) ** 2, -1)
        dirt += 1.0 * np.exp(-kd / 0.10 ** 2)
        dirt += 0.30 * np.exp(-np.sum(((P - k - [0, -0.18, 0.06]) * [1, 0.45, 1]) ** 2, -1) / 0.07 ** 2)
        e = J(side + 'ForeArm')
        dirt += 0.45 * np.exp(-np.sum((P - e - [0, 0, -0.03]) ** 2, -1) / 0.065 ** 2)
        dirt += 0.20 * np.exp(-np.sum((P - (e + J(side + 'Hand')) / 2) ** 2, -1) / 0.08 ** 2)
        h = J(side + 'Hand')
        grime += 0.55 * np.exp(-np.sum((P - h) ** 2, -1) / 0.07 ** 2)
        th_ = J(side + 'UpLeg')
        dirt += 0.18 * np.exp(-np.sum(((P - th_ - [0, -0.18, 0.08]) * [1, 0.6, 1]) ** 2, -1) / 0.06 ** 2) * (n_s > 0.2)
    dirt += 0.32 * np.exp(-np.sum(((P - J('Hips') - [0, -0.10, -0.11]) * [0.7, 1, 1]) ** 2, -1) / 0.09 ** 2)
    grime += 0.55 * np.exp(-np.sum(((P - J('Neck') - [0, -0.03, 0]) * [0.8, 1.6, 1.0]) ** 2, -1) / 0.08 ** 2)
    dirt *= np.clip(0.55 + 0.75 * n_d, 0, 1.4)
    dirt += np.clip(n_s - 0.55, 0, 1) * 1.6 * np.clip((0.9 - y) / 0.5, 0, 1)
    dirt = np.clip(dirt, 0, 1)
    grime = np.clip(grime * (0.6 + 0.6 * n_d), 0, 0.8)
    fade = TX.noise3(P, 0.35, seed + 21, 2) * 0.06
    fade += 0.07 * np.clip(N[..., 1], 0, 1) ** 1.5 * ~collar
    fade += np.where(trs, -0.05, 0.02)                              # trousers a little darker / less sun-bleached than the jacket
    # ---- albedo at res_a: camo printed per garment panel (cut from one bolt of cloth, grain along the panel's v)
    pxm = uv_per_m * res_a
    sheets = {'jk': _sheet('emr' if faction == 'ru' else ('multicam' if top == 'multicam' else 'mm14'), pxm,
                           seed + (1 if faction == 'ru' else (3 if top == 'multicam' else 2)))}
    sheets['tr'] = sheets['jk'] if top != 'multicam' else _sheet('mm14', pxm, seed + 2)
    Ra = TX.raster(uv, tri, {'P': pos}, res_a, tri_attrs={'t': np.arange(len(tri))})
    Pa, mask_a = Ra['P'], Ra['mask']
    tla = np.where(mask_a, labels[np.maximum(Ra['t'], 0)], '')
    base = np.zeros((res_a, res_a, 3), np.float32)
    pa = np.full((res_a, res_a), -1, np.int16)
    ch = res_a // 4
    Us, Vs = np.zeros((res_a, res_a), np.float32), np.zeros((res_a, res_a), np.float32)
    for i in range(0, res_a, ch):
        Fa = G.fields(Pa[i:i + ch], _labmasks(tla[i:i + ch]))
        pa[i:i + ch], Us[i:i + ch], Vs[i:i + ch] = Fa['pid'], Fa['u'], Fa['v']
        del Fa
    off = _layout(pa, Us, Vs, mask_a)
    for k, (ox, oy) in off.items():
        m = mask_a & (pa == k)
        sh_ = sheets['jk'] if k in GM.JACKET_PANELS else sheets['tr']
        base[m] = _sample(sh_, pxm, Us[m] + ox, Vs[m] + oy)
    del sheets
    up = lambda arr, o=1: ndimage.zoom(arr, res_a / res_n, order=o) if res_a != res_n else arr
    sh = up(shade * cav * (1 + fade))
    dt = up(dirt)
    mud_dry = TX.hexc('#7d705a'); mud_wet = TX.hexc('#3b3229')
    wm = up(wetm)[..., None]
    mud = mud_dry * (1 - wm) + mud_wet * wm
    alb = base * sh[..., None]
    alb = alb * (1 + up(np.clip(cav - 1.0, 0, 0.10))[..., None] * 0.6)
    if GM.BELT_ON:
        # belt + buckle (painted over the jacket print)
        ya = Pa[..., 1]
        jka = mask_a & (pa >= 0) & np.isin(pa, (GM.JF_L, GM.JF_R, GM.J_BACK))
        bl = jka & (ya > b0) & (ya < b1)
        bcol = TX.hexc(BELT_COL[faction]) * (1 + 0.04 * np.random.default_rng(seed + 5).standard_normal((res_a, res_a, 1)))
        alb = np.where(bl[..., None], bcol * sh[..., None], alb)
        xa = Pa[..., 0]
        bk_a = bl & (np.abs(xa) < 0.032) & (Pa[..., 2] > 0)
        alb = np.where(bk_a[..., None], TX.hexc(BUCKLE_COL) * sh[..., None] * 1.15, alb)
    a_d = np.clip(dt[..., None] * (0.68 + 0.3 * wm), 0, 0.9)
    alb = alb * (1 - a_d) + mud * a_d
    alb = alb * (1 - up(grime)[..., None] * 0.35)
    alb *= (1 + 0.035 * np.random.default_rng(seed).standard_normal(alb.shape[:2]))[..., None]
    alb = TX.dilate(np.clip(alb, 0, 1), mask_a, 6)
    return alb, normal, uv_per_m


def sstep_(a, b, x):
    return GM.sstep(a, b, x)
