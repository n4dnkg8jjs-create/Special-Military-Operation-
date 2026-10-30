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
    """height contribution of a stitched seam along an SDF zero line (metres)"""
    g = -0.0007 * np.exp(-(sd / (width * 0.35)) ** 2)  # groove
    return g


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
    H += drape * 0.0012
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
        crease = np.sin(de / 0.018 * 2 * np.pi + TX.noise3(P, 0.08, seed + 3, 1) * 3) * np.exp(-(de / 0.07) ** 2)
        H += m * crease * 0.0009 * (0.3 + 0.7 * front) * (0.6 + 0.4 * TX.noise3(P, 0.05, seed + 31, 2))
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
        H += m * np.sin(dk / 0.024 * 2 * np.pi + TX.noise3(P, 0.06, seed + 5, 2) * 5 + th * 1.5) * np.exp(-(dk / 0.07) ** 2) * 0.0008 * (0.5 + 0.5 * np.cos(th + fw))
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
    # torso: jacket hem, front placket, back yoke
    t = labmask('torso')
    hipy = J('Hips')[1]
    hem = hipy - 0.065
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
    normal = TX.height_to_normal(H / texel_m, 1.0)
    # cavity shading from height (ambient-occlusion-like)
    blur = ndimage.gaussian_filter(H, 3)
    cav = np.clip(1 + (H - blur) * 260, 0.65, 1.12)
    # ---- dirt / wear masks (in 3D)
    y = P[..., 1]
    dirt = np.clip((0.55 - y) / 0.4, 0, 1) ** 1.5 * 0.55
    for side in ('Left', 'Right'):
        k = J(side + 'Leg')
        dirt += 0.6 * np.exp(-np.sum((P - k - [0, 0, 0.06]) ** 2, -1) / 0.07 ** 2)
        e = J(side + 'ForeArm')
        dirt += 0.25 * np.exp(-np.sum((P - e) ** 2, -1) / 0.06 ** 2)
    dirt *= np.clip(0.6 + 0.8 * TX.noise3(P, 0.12, seed + 9, 3), 0, 1.3)
    dirt = np.clip(dirt, 0, 1)
    fade = TX.noise3(P, 0.35, seed + 21, 2) * 0.06
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
    mud = TX.hexc('#5d5040')
    alb = base * sh[..., None]
    alb = alb * (1 - dt[..., None] * 0.55) + mud * dt[..., None] * 0.55
    pa = up(patch[..., 3])
    pc = np.stack([up(patch[..., c], 0) for c in range(3)], -1)
    alb = alb * (1 - pa[..., None]) + pc * sh[..., None] * pa[..., None]
    # fine fabric grain
    alb *= (1 + 0.035 * np.random.default_rng(seed).standard_normal(alb.shape[:2]))[..., None]
    mask_a = up(mask.astype(np.float32), 0) > 0.5
    alb = TX.dilate(np.clip(alb, 0, 1), mask_a, 6)
    return alb, normal, uv_per_m
