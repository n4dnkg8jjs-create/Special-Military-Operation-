"""Uniform texture baking: camo albedo with seams/pockets/patches/dirt + tangent-space normal map.
Everything is evaluated per texel from rasterised bind-pose position/normal maps."""
import numpy as np
from scipy import ndimage
import tex as TX
import camo as C


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
    """cloth fold profile along a phase x (period 1): sharp creases (troughs) between rounded ridges, zero-mean-ish"""
    return np.abs(np.sin(np.pi * x)) ** sharp - 0.6


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


def bake_uniform(mesh, skel, labels, faction, variant, res_a=2048, res_n=1024, top='camo', seed=0):
    """mesh: dict pos/nrm/uv/tri (GL arrays, bind pose). labels: per-tri label strings.
    faction 'ru'|'ua'. top: 'camo' or 'multicam' (UA jacket). returns albedo(res_a), normal(res_n), uv_scale"""
    rng = np.random.default_rng(seed)
    pos, nrm, uv, tri = mesh['pos'], mesh['nrm'], mesh['uv'], mesh['tri']
    labnames = sorted(set(labels)); L = {l: i for i, l in enumerate(labnames)}
    lab_i = np.array([L[l] for l in labels])
    R = TX.raster(uv, tri, {'P': pos, 'N': nrm}, res_n, tri_attrs={'lab': lab_i})
    P, N, mask, lab = R['P'], R['N'], R['mask'], R['lab']
    # texel density
    a3 = np.linalg.norm(np.cross(pos[tri[:, 1]] - pos[tri[:, 0]], pos[tri[:, 2]] - pos[tri[:, 0]]), axis=1).sum() / 2
    u3 = np.c_[uv, np.zeros(len(uv))]
    a2 = np.linalg.norm(np.cross(u3[tri[:, 1]] - u3[tri[:, 0]], u3[tri[:, 2]] - u3[tri[:, 0]]), axis=1).sum() / 2
    uv_per_m = np.sqrt(a2 / a3)
    texel_m = 1.0 / (uv_per_m * res_n)
    H = np.zeros((res_n, res_n), np.float32)
    FOLD = np.zeros((res_n, res_n), np.float32)        # fold field (unitless, ridges > 0) -> albedo shading / AO of the folds
    shade = np.ones((res_n, res_n), np.float32)
    patch = np.zeros((res_n, res_n, 4), np.float32)  # rgba overlay
    def labmask(prefix):
        ids = [L[l] for l in labnames if l.startswith(prefix)]
        return np.isin(lab, ids)
    J = lambda n: skel.head[skel.idx[n]]
    # ---- seams at UV island borders (garment panel seams)
    dist_in = ndimage.distance_transform_edt(mask) * texel_m
    H += seam_profile(dist_in - 0.003) + stitches(dist_in - 0.006, (P[..., 0] + P[..., 1] + P[..., 2]), 0.0, 0.004)
    shade *= 1 - 0.18 * np.exp(-((dist_in - 0.002) / 0.0015) ** 2)
    # ---- folds / drape (low-frequency noise stretched along limbs) and joint creases
    drape = TX.noise3(P * [3.0, 0.6, 3.0], 1.0, seed + 11, 3)
    H += drape * 0.0022
    for side, sx in (('Left', 1), ('Right', -1)):
        sh, el, wr = J(side + 'Arm'), J(side + 'ForeArm'), J(side + 'Hand')
        m = labmask('sleeve_' + side[0]) | labmask('cuff_' + side[0])
        ref = np.array([sx, 0.0, 0]);
        s1, th1, _ = limb_coords(P, sh, el, ref)
        s2, th2, _ = limb_coords(P, el, wr, ref)
        Lu = np.linalg.norm(el - sh)
        on_up = s1 < Lu
        s = np.where(on_up, s1, Lu + s2); th = np.where(on_up, th1, th2)
        # elbow creases: ripples across the arm near the elbow, strongest on the inside (front)
        de = s - Lu
        front = 0.5 + 0.5 * np.cos(th - (-np.pi / 2 * sx))
        crook = 0.5 + 0.5 * np.cos(th - np.pi / 2 * sx)      # crook of the elbow (faces +Z in the bind pose)
        cr_ = crease(de / 0.019 + 0.45 * np.sin(th * 1.3) + TX.noise3(P, 0.08, seed + 3, 1) * 0.5) * np.exp(-(de / 0.075) ** 2)
        H += m * cr_ * 0.0028 * (0.25 + 0.75 * crook ** 1.5) * (0.7 + 0.3 * TX.noise3(P, 0.05, seed + 31, 2))
        FOLD[...] += m * cr_ * (0.25 + 0.75 * crook ** 1.5)
        # inner-elbow fan: diagonal folds converging on the crook of the arm
        ie = el + (np.array([0, 0, 1.0]) * 0.035)
        rf = radial_folds(P, ie, (0, 1), 7, 0.11, seed + 40 + sx)
        H += m * rf * 0.0016 * crook; FOLD[...] += m * rf * crook
        # sleeve drape: long soft folds running down the upper arm and forearm, twisting slightly
        dr = crease(th * 5 / (2 * np.pi) + s * 1.5 + TX.noise3(P, 0.15, seed + 50 + sx, 2) * 0.6, 0.9)
        H += m * dr * 0.0014 * (1 - np.exp(-(de / 0.05) ** 2)); FOLD[...] += m * dr * 0.4
        # sleeve gather near cuff
        dc = s - (Lu + np.linalg.norm(wr - el) - 0.04)
        H += m * np.sin(th * 7 + s * 40) * np.exp(-(dc / 0.05) ** 2) * 0.0012
        # shoulder pocket (velcro flag panel) on upper outer sleeve
        r_arm = 0.055
        sd = rect_sdf(th * r_arm, s, 0.012 * sx * 0, 0.14, 0.065, 0.075, 0.012)
        pk = m & on_up
        inside = pk & (sd < 0)
        H += np.where(pk, np.where(sd < 0, 0.0016, 0) + seam_profile(sd) + stitches(sd, th * r_arm + s, 0.003), 0)
        shade *= np.where(pk, 1 - 0.25 * np.exp(-((sd - 0.001) / 0.002) ** 2), 1)
        flap = pk & (np.abs(th * r_arm) < 0.068) & (s > 0.055) & (s < 0.10)
        fsd = rect_sdf(th * r_arm, s, 0, 0.078, 0.068, 0.024, 0.008)
        H += np.where(pk & (fsd < 0), 0.0012, 0) + np.where(pk, seam_profile(fsd), 0)
        shade *= np.where(pk & (np.abs(fsd) < 0.003) & (s > 0.09), 0.72, 1)
        # flag / unit patch on the left sleeve pocket (velcro)
        if side == 'Left':
            psd = rect_sdf(th * r_arm, s, 0, 0.155, 0.04, 0.026, 0.004)
            pm = pk & (psd < 0)
            yy = (s - 0.129) / 0.052  # 0 top .. 1 bottom
            if faction == 'ua':
                col = np.where((yy < 0.5)[..., None], TX.hexc('#2a5a9a'), TX.hexc('#e8c21a'))
            else:
                col = np.where((yy < 0.333)[..., None], TX.hexc('#e6e6e0'), np.where((yy < 0.667)[..., None], TX.hexc('#2e4f9e'), TX.hexc('#b3282d')))
            col = col * 0.8 + 0.2 * TX.hexc('#6b6b55')  # subdued / dirty
            patch[pm, :3] = col[pm]; patch[pm, 3] = 0.92
            H += np.where(pm, 0.0006, 0)
        # elbow reinforcement on back of elbow
        esd = rect_sdf(th * 0.05, s, (np.pi / 2 * sx) * 0.05 * 0.9, Lu, 0.05, 0.07, 0.03)
        H += np.where(m, seam_profile(esd) + np.where(esd < 0, 0.0005, 0), 0)
    for side, sx in (('Left', 1), ('Right', -1)):
        hp, kn, an = J(side + 'UpLeg'), J(side + 'Leg'), J(side + 'Foot')
        m = labmask('leg_' + side[0])
        ref = np.array([sx, 0.0, 0])
        s1, th1, _ = limb_coords(P, hp, kn, ref)
        s2, th2, _ = limb_coords(P, kn, an, ref)
        Lu = np.linalg.norm(kn - hp)
        on_up = s1 < Lu
        s = np.where(on_up, s1, Lu + s2); th = np.where(on_up, th1, th2)
        fw = np.pi / 2 * sx  # angle of the front (+z) direction
        # knee creases (back of knee + front ripple)
        dk = s - Lu
        frontk = 0.5 + 0.5 * np.cos(th - fw); backk = 1 - frontk
        # back of the knee: stacked horizontal folds (the cloth compresses when the knee bends); front: two broad bagging folds
        kb = crease(dk / 0.021 + 0.35 * np.sin(th * 2) + TX.noise3(P, 0.06, seed + 5, 2) * 0.6) * np.exp(-(dk / 0.075) ** 2)
        H += m * kb * 0.0030 * backk ** 1.3; FOLD[...] += m * kb * backk ** 1.3
        kf = crease(dk / 0.045 + TX.noise3(P, 0.08, seed + 6, 2) * 0.5, 1.0) * np.exp(-((dk + 0.02) / 0.09) ** 2)
        H += m * (kf * 0.0012 + 0.0012 * np.exp(-((dk + 0.01) / 0.05) ** 2)) * frontk; FOLD[...] += m * kf * frontk * 0.7
        # trouser drape: long vertical folds down the leg, a little twisted
        ld = crease(th * 4 / (2 * np.pi) + TX.noise3(P, 0.2, seed + 60 + sx, 2) * 0.5 + s * 0.6, 0.9)
        H += m * ld * 0.0016 * (1 - np.exp(-(dk / 0.06) ** 2)); FOLD[...] += m * ld * 0.4
        # blousing above boots
        db = P[..., 1] - 0.24
        H += m * np.sin(th * 9 + P[..., 1] * 90) * np.exp(-(db / 0.05) ** 2) * 0.0035 * (db > -0.03)
        shade *= np.where(m, 1 - 0.25 * np.exp(-(db / 0.05) ** 2) * (0.5 + 0.5 * np.sin(th * 9 + P[..., 1] * 90)), 1)
        # cargo pocket on outer thigh
        r_th = 0.085
        thp = th - 0.35 * sx  # slightly forward of lateral
        sd = rect_sdf(thp * r_th, s, 0, 0.30, 0.085, 0.10, 0.015)
        pk = m & on_up
        H += np.where(pk, np.where(sd < 0, 0.0022, 0) + seam_profile(sd) + stitches(sd, thp * r_th + s, 0.003), 0)
        shade *= np.where(pk, 1 - 0.3 * np.exp(-((sd - 0.001) / 0.0025) ** 2), 1)
        fsd = rect_sdf(thp * r_th, s, 0, 0.215, 0.088, 0.028, 0.01)
        H += np.where(pk & (fsd < 0), 0.0016, 0) + np.where(pk, seam_profile(fsd), 0)
        shade *= np.where(pk & (np.abs(fsd) < 0.003) & (s > 0.23), 0.7, 1)
        # pleats on the pocket
        H += np.where(pk & (sd < 0) & (s > 0.25), np.sin(thp * r_th / 0.03 * 2 * np.pi) * 0.0003, 0)
        # knee reinforcement (double layer) on front of knee
        ksd = rect_sdf((th - fw) * 0.06, s, 0, Lu + 0.01, 0.065, 0.10, 0.03)
        H += np.where(m, seam_profile(ksd) + stitches(ksd, s + th * 0.06, 0.003) + np.where(ksd < 0, 0.0006, 0), 0)
        # seat / back pocket hint
    # crotch: folds radiating from the crotch over the fronts / insides of the thighs and the seat (front stronger)
    lg = labmask('leg') | labmask('torso')
    cro = np.array([0.0, J('LeftUpLeg')[1] - 0.075, J('Hips')[2] + 0.01])
    rc = radial_folds(P, cro, (0, 1), 9, 0.17, seed + 70)
    fr = np.clip((P[..., 2] - cro[2] + 0.05) / 0.08, 0, 1)
    H += lg * rc * 0.0018 * (0.45 + 0.55 * fr); FOLD += lg * rc * (0.45 + 0.55 * fr)
    # armpits / shoulders: folds fanning from the armpit across the chest and the shoulder blade, and over the top of the shoulder
    tor = labmask('torso')
    for side, sx in (('Left', 1), ('Right', -1)):
        ap = J(side + 'Arm') + np.array([-sx * 0.035, -0.07, 0.0])
        ra = radial_folds(P, ap, (2, 1), 8, 0.16, seed + 80 + sx)
        H += tor * ra * 0.0015; FOLD += tor * ra
        sh_ = J(side + 'Arm') + np.array([-sx * 0.05, 0.03, 0.0])
        rs = radial_folds(P, sh_, (2, 0), 6, 0.10, seed + 90 + sx)
        H += tor * rs * 0.0008; FOLD += tor * rs * 0.5
    # torso: jacket hem, front placket, back yoke
    t = labmask('torso')
    hipy = J('Hips')[1]
    hem = hipy - 0.065
    # waist: cloth gathered by the belt / trouser waistband - short vertical folds round the waist just above the hem
    aw = np.arctan2(P[..., 0], P[..., 2] - J('Hips')[2])
    wg = crease(aw * 30 / (2 * np.pi) + TX.noise3(P, 0.07, seed + 95, 2) * 0.6) * np.exp(-((P[..., 1] - hem - 0.045) / 0.035) ** 2)
    H += t * wg * 0.0014; FOLD += t * wg
    dh = P[..., 1] - hem
    H += np.where(t, np.where(dh > 0, 0.0015, 0) - 0.0012 * np.exp(-(dh / 0.004) ** 2), 0)
    shade *= np.where(t, 1 - 0.35 * np.exp(-((dh + 0.004) / 0.006) ** 2) * (dh < 0.003), 1)
    front = P[..., 2] > 0.02
    pl = t & front & (P[..., 1] > hem)
    psd = np.abs(P[..., 0]) - 0.022
    H += np.where(pl, seam_profile(psd) + np.where(psd < 0, 0.0008, 0) + stitches(psd, P[..., 1], 0.003), 0)
    # waist belt line under the jacket hem (trouser waistband)
    wb = labmask('torso') & (np.abs(P[..., 1] - (hem - 0.035)) < 0.02)
    H += np.where(wb, 0.0006, 0)
    # fabric weave / rip-stop micro detail
    yy, xx = np.mgrid[0:res_n, 0:res_n]
    per = 0.005 / texel_m
    rip = ((np.abs(((xx / per) % 1) - 0.5) > 0.43) | (np.abs(((yy / per) % 1) - 0.5) > 0.43)).astype(np.float32)
    H += rip * 0.00012 + rng.standard_normal(H.shape).astype(np.float32) * 0.00004
    H = TX.dilate(H, mask, 6)
    H = ndimage.gaussian_filter(H, 0.6)
    normal = TX.height_to_normal(H / texel_m, 1.25)
    # cavity shading from height (ambient-occlusion-like): fine (seams, stitching) + coarse (folds / creases: troughs darker, ridges
    # catch a little more light)
    blur = ndimage.gaussian_filter(H, 3)
    cav = np.clip(1 + (H - blur) * 260, 0.65, 1.12)
    blur2 = ndimage.gaussian_filter(H, 12)
    cav *= np.clip(1 + (H - blur2) * 210, 0.68, 1.12)
    FOLD = ndimage.gaussian_filter(TX.dilate(FOLD, mask, 6), 1.0)
    cav *= np.clip(1 + 0.30 * FOLD, 0.70, 1.16)
    # ---- dirt / wear masks (in 3D).  v6 (photos 2023-24): caked mud on the lowest 30 cm and the knees (kneeling / crawling), shins and
    # seat scuffed, elbows / forearms rubbed, grime (sweat / grease, darker not browner) at collar and cuffs; sun-bleached / worn
    # lighter on top surfaces and raised edges (pocket flaps, seams)
    y = P[..., 1]
    n_d = TX.noise3(P, 0.12, seed + 9, 3)
    n_s = TX.noise3(P, 0.035, seed + 19, 2)                        # splatter scale
    wetm = np.clip((0.42 - y) / 0.18, 0, 1) ** 1.2                # wet, dark mud right above the boots
    dirt = np.clip((0.62 - y) / 0.40, 0, 1) ** 1.4 * 0.62
    grime = np.zeros_like(y)
    for side in ('Left', 'Right'):
        k = J(side + 'Leg')
        kd = np.sum(((P - k - [0, -0.01, 0.07]) * [1.0, 0.8, 1.0]) ** 2, -1)
        dirt += 0.85 * np.exp(-kd / 0.085 ** 2)                    # knees (front)
        dirt += 0.30 * np.exp(-np.sum(((P - k - [0, -0.18, 0.06]) * [1, 0.45, 1]) ** 2, -1) / 0.07 ** 2)   # shin fronts
        e = J(side + 'ForeArm')
        dirt += 0.45 * np.exp(-np.sum((P - e - [0, 0, -0.03]) ** 2, -1) / 0.065 ** 2)   # back of the elbows
        dirt += 0.20 * np.exp(-np.sum((P - (e + J(side + 'Hand')) / 2) ** 2, -1) / 0.08 ** 2)   # forearms
        h = J(side + 'Hand')
        grime += 0.55 * np.exp(-np.sum((P - h) ** 2, -1) / 0.07 ** 2)                    # cuffs
        th_ = J(side + 'UpLeg')
        dirt += 0.18 * np.exp(-np.sum(((P - th_ - [0, -0.18, 0.08]) * [1, 0.6, 1]) ** 2, -1) / 0.06 ** 2) * (n_s > 0.2)   # wiped hands
    dirt += 0.32 * np.exp(-np.sum(((P - J('Hips') - [0, -0.10, -0.11]) * [0.7, 1, 1]) ** 2, -1) / 0.09 ** 2)   # seat
    grime += 0.55 * np.exp(-np.sum(((P - J('Neck') - [0, -0.03, 0]) * [0.8, 1.6, 1.0]) ** 2, -1) / 0.08 ** 2)   # collar
    dirt *= np.clip(0.55 + 0.75 * n_d, 0, 1.4)
    dirt += np.clip(n_s - 0.55, 0, 1) * 1.6 * np.clip((0.9 - y) / 0.5, 0, 1)            # splatter going up the legs
    dirt = np.clip(dirt, 0, 1)
    grime = np.clip(grime * (0.6 + 0.6 * n_d), 0, 0.8)
    fade = TX.noise3(P, 0.35, seed + 21, 2) * 0.06
    fade += 0.07 * np.clip(N[..., 1], 0, 1) ** 1.5                 # sun-bleached on top surfaces (shoulders, upper back)
    # ---- albedo at res_a
    pxm = uv_per_m * res_a
    if faction == 'ru':
        base = C.emr(res_a, pxm, seed + 1)
    else:
        base = C.mm14(res_a, pxm, seed + 2)
        if top == 'multicam':
            mc = C.multicam(res_a, pxm, seed + 3)
            tm = np.isin(lab, [L[l] for l in labnames if not l.startswith('leg')]).astype(np.float32)
            tm = ndimage.zoom(tm, res_a / res_n, order=0) > 0.5
            base = np.where(tm[..., None], mc, base)
    up = lambda a, o=1: ndimage.zoom(a, res_a / res_n, order=o) if res_a != res_n else a
    sh = up(shade * cav * (1 + fade))
    dt = up(dirt)
    mud_dry = TX.hexc('#7d705a'); mud_wet = TX.hexc('#3b3229')
    wm = up(wetm)[..., None]
    mud = mud_dry * (1 - wm) + mud_wet * wm
    alb = base * sh[..., None]
    # worn / abraded raised edges a little lighter (cavity > 1 = ridge)
    alb = alb * (1 + up(np.clip(cav - 1.0, 0, 0.12))[..., None] * 0.8)
    a_d = dt[..., None] * (0.55 + 0.3 * wm)
    alb = alb * (1 - a_d) + mud * a_d
    alb = alb * (1 - up(grime)[..., None] * 0.35)
    pa = up(patch[..., 3])
    pc = np.stack([up(patch[..., c], 0) for c in range(3)], -1)
    alb = alb * (1 - pa[..., None]) + pc * sh[..., None] * pa[..., None]
    # fine fabric grain
    alb *= (1 + 0.035 * np.random.default_rng(seed).standard_normal(alb.shape[:2]))[..., None]
    mask_a = up(mask.astype(np.float32), 0) > 0.5
    alb = TX.dilate(np.clip(alb, 0, 1), mask_a, 6)
    return alb, normal, uv_per_m
