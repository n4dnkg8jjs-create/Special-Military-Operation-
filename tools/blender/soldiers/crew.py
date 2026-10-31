"""Armoured-vehicle crew (tankers / BTR crew) presets for soldier_ru.glb / soldier_ua.glb.

Same skeleton, skin weights and sockets as the infantry; only pre-combined presets are written (no per-part crew nodes):
  crew_combo_<n>       ONE SkinnedMesh / ONE material (soldier_atlas_crew_<fac>, its own 2048^2 atlas)
  crew_combo_<n>_tape  arm/leg identification bands, material `tape` (recolourable, like the infantry presets)
  + *_LOD1 siblings (W.emit_lods).
Look: one-piece armoured-vehicle crew coverall (RU: olive-khaki or EMR, UA: MM-14 or olive) with a full-length front zip,
slanted chest zip pockets, thigh patch pockets, quilted knee / elbow pads, elastic waist and ankle tabs; Soviet padded
tanker helmet (shlemofon TSh) with longitudinal padded rolls, forehead roll, ear-phone housings, chin strap and a throat
microphone (laryngophone) band with the intercom cable; trouser belt with a PM flap holster on the right hip and a spare
magazine pouch; some presets wear a light soft armour vest; gloves or bare hands; boots; no rucksack, no rifle.

build_soldier.build() calls make_crew() after the infantry presets and before W.emit_lods()."""
import numpy as np
from scipy import ndimage
from mathutils.bvhtree import BVHTree
from mathutils import Vector
import gear as G
import pouches as PO
import kit as K
import meshutil as MU
import camo as CM
import tex as TX
import uniform_tex as UT
import assemble as AS

TILE_PX_CREW = {'tsh_black': 192, 'tsh_olive': 192, 'crew_olive_gear': 192, 'crew_tan_gear': 192}
SOLID_SPECS = {   # name: (sRGB hex, roughness, metallic)
    'holster_brown': ('#3b281c', 0.55, 0.0), 'holster_black': ('#1d1c1a', 0.6, 0.0), 'belt_brown': ('#3f2c1f', 0.6, 0.0),
    'belt_olive': ('#4a4b36', 0.85, 0.0), 'buckle_steel': ('#5b5d5f', 0.38, 0.85), 'radio_black': ('#232423', 0.5, 0.0),
    'tsh_rubber': ('#151515', 0.75, 0.0), 'cable_black': ('#121212', 0.45, 0.0), 'gear_hardware': ('#1d1d1b', 0.55, 0.0),
}
SCHEMES = {   # coverall colour schemes per faction (material name, base, notes)
    'ru': {'olive': ('crew_olive_ru', 'olive', '#4f4f37'), 'emr': ('crew_emr_camo', 'emr', None)},
    'ua': {'mm14': ('crew_mm14_camo', 'mm14', None), 'olive': ('crew_olive_ua', 'olive', '#474d36')},
}


# ====================================================================================== coverall texture
def bake_coverall(mesh, skel, labels, faction, scheme, res_a=2048, res_n=1024, seed=0, olive=None):
    """one-piece crew coverall on the uniform mesh / UVs (bind pose): base (plain olive or camo) + seams, front zip,
    chest zip pockets, thigh pockets, quilted knee and elbow pads, elastic waist, ankle tabs, flag patch, oil / dust"""
    rng = np.random.default_rng(seed)
    pos, nrm, uv, tri = mesh['pos'], mesh['nrm'], mesh['uv'], mesh['tri']
    labnames = sorted(set(labels)); L = {l: i for i, l in enumerate(labnames)}
    lab_i = np.array([L[l] for l in labels])
    Rm = TX.raster(uv, tri, {'P': pos, 'N': nrm}, res_n, tri_attrs={'lab': lab_i})
    P, N, mask, lab = Rm['P'], Rm['N'], Rm['mask'], Rm['lab']
    a3 = np.linalg.norm(np.cross(pos[tri[:, 1]] - pos[tri[:, 0]], pos[tri[:, 2]] - pos[tri[:, 0]]), axis=1).sum() / 2
    u3 = np.c_[uv, np.zeros(len(uv))]
    a2 = np.linalg.norm(np.cross(u3[tri[:, 1]] - u3[tri[:, 0]], u3[tri[:, 2]] - u3[tri[:, 0]]), axis=1).sum() / 2
    uv_per_m = np.sqrt(a2 / a3)
    texel_m = 1.0 / (uv_per_m * res_n)
    H = np.zeros((res_n, res_n), np.float32)
    shade = np.ones((res_n, res_n), np.float32)
    patch = np.zeros((res_n, res_n, 4), np.float32)
    dark = np.zeros((res_n, res_n), np.float32)      # zip teeth / tapes (painted dark)

    def labmask(prefix):
        return np.isin(lab, [L[l] for l in labnames if l.startswith(prefix)])
    J = lambda n: skel.head[skel.idx[n]]
    seam, stitch, rect = UT.seam_profile, UT.stitches, UT.rect_sdf
    # ---- panel seams
    dist_in = ndimage.distance_transform_edt(mask) * texel_m
    H += seam(dist_in - 0.003) + stitch(dist_in - 0.006, (P[..., 0] + P[..., 1] + P[..., 2]), 0.0, 0.004)
    shade *= 1 - 0.18 * np.exp(-((dist_in - 0.002) / 0.0015) ** 2)
    # ---- drape: a coverall is baggier than the field uniform (bigger, softer folds)
    H += TX.noise3(P * [3.0, 0.7, 3.0], 1.0, seed + 11, 3) * 0.0016
    for side, sx in (('Left', 1), ('Right', -1)):
        sh, el, wr = J(side + 'Arm'), J(side + 'ForeArm'), J(side + 'Hand')
        m = labmask('sleeve_' + side[0]) | labmask('cuff_' + side[0])
        ref = np.array([sx, 0.0, 0])
        s1, th1, _ = UT.limb_coords(P, sh, el, ref); s2, th2, _ = UT.limb_coords(P, el, wr, ref)
        Lu = np.linalg.norm(el - sh); on_up = s1 < Lu
        s = np.where(on_up, s1, Lu + s2); th = np.where(on_up, th1, th2)
        de = s - Lu
        front = 0.5 + 0.5 * np.cos(th - (-np.pi / 2 * sx))
        H += m * np.sin(de / 0.02 * 2 * np.pi + TX.noise3(P, 0.08, seed + 3, 1) * 3) * np.exp(-(de / 0.08) ** 2) * 0.0010 * (0.3 + 0.7 * front)
        dc = s - (Lu + np.linalg.norm(wr - el) - 0.04)
        H += m * np.sin(th * 7 + s * 40) * np.exp(-(dc / 0.05) ** 2) * 0.0014
        # quilted elbow pad (back of the elbow): raised oval with diamond quilting
        r_arm = 0.05
        esd = rect(th * r_arm, s, (np.pi / 2 * sx) * r_arm * 0.95, Lu - 0.005, 0.045, 0.065, 0.035)
        ein = m & (esd < 0)
        q = np.abs(np.sin((th * r_arm + s) / 0.022 * np.pi)) * np.abs(np.sin((th * r_arm - s) / 0.022 * np.pi))
        H += np.where(m, seam(esd) + stitch(esd, th * r_arm + s, 0.003) + np.where(ein, 0.0018 - 0.0007 * (1 - q), 0), 0)
        shade *= np.where(ein, 0.93 + 0.07 * q, 1)
        # upper-sleeve pocket with the flag patch (left) / plain velcro panel (right)
        sd = rect(th * 0.055, s, 0.0, 0.14, 0.06, 0.07, 0.012)
        pk = m & on_up
        H += np.where(pk, np.where(sd < 0, 0.0014, 0) + seam(sd) + stitch(sd, th * 0.055 + s, 0.003), 0)
        shade *= np.where(pk, 1 - 0.22 * np.exp(-((sd - 0.001) / 0.002) ** 2), 1)
        if side == 'Left':
            psd = rect(th * 0.055, s, 0, 0.15, 0.038, 0.025, 0.004)
            pm = pk & (psd < 0)
            yy = (s - 0.125) / 0.05
            if faction == 'ua':
                col = np.where((yy < 0.5)[..., None], TX.hexc('#2a5a9a'), TX.hexc('#e8c21a'))
            else:
                col = np.where((yy < 0.333)[..., None], TX.hexc('#e6e6e0'), np.where((yy < 0.667)[..., None], TX.hexc('#2e4f9e'), TX.hexc('#b3282d')))
            col = col * 0.8 + 0.2 * TX.hexc('#6b6b55')
            patch[pm, :3] = col[pm]; patch[pm, 3] = 0.92
            H += np.where(pm, 0.0006, 0)
        # wrist tab (velcro cuff adjuster)
        ct = m & (np.abs(s - (Lu + np.linalg.norm(wr - el) - 0.035)) < 0.014) & (np.abs(np.angle(np.exp(1j * (th - np.pi * 0.5 * sx)))) < 0.35)
        H += np.where(ct, 0.0012, 0)
    for side, sx in (('Left', 1), ('Right', -1)):
        hp, kn, an = J(side + 'UpLeg'), J(side + 'Leg'), J(side + 'Foot')
        m = labmask('leg_' + side[0])
        ref = np.array([sx, 0.0, 0])
        s1, th1, _ = UT.limb_coords(P, hp, kn, ref); s2, th2, _ = UT.limb_coords(P, kn, an, ref)
        Lu = np.linalg.norm(kn - hp); on_up = s1 < Lu
        s = np.where(on_up, s1, Lu + s2); th = np.where(on_up, th1, th2)
        fw = np.pi / 2 * sx
        dk = s - Lu
        H += m * np.sin(dk / 0.026 * 2 * np.pi + TX.noise3(P, 0.06, seed + 5, 2) * 5 + th * 1.5) * np.exp(-(dk / 0.08) ** 2) * 0.0009 * (0.5 + 0.5 * np.cos(th + fw))
        # coverall legs gathered by ankle tabs over the boot tops (no blousing)
        db = P[..., 1] - 0.235
        H += m * np.sin(th * 6 + P[..., 1] * 70) * np.exp(-(db / 0.04) ** 2) * 0.0022 * (db > -0.03)
        tab = m & (np.abs(db - 0.005) < 0.012) & (np.abs(np.angle(np.exp(1j * (th - (fw + 1.2 * sx))))) < 0.35)
        H += np.where(tab, 0.0014, 0)
        shade *= np.where(m, 1 - 0.18 * np.exp(-(db / 0.04) ** 2) * (0.5 + 0.5 * np.sin(th * 6 + P[..., 1] * 70)), 1)
        # thigh patch pocket (front-outer) with flap + press studs
        r_th = 0.085; thp = th - 0.5 * sx
        sd = rect(thp * r_th, s, 0, 0.27, 0.075, 0.09, 0.012)
        pk = m & on_up
        H += np.where(pk, np.where(sd < 0, 0.0018, 0) + seam(sd) + stitch(sd, thp * r_th + s, 0.003), 0)
        shade *= np.where(pk, 1 - 0.28 * np.exp(-((sd - 0.001) / 0.0025) ** 2), 1)
        fsd = rect(thp * r_th, s, 0, 0.195, 0.078, 0.024, 0.01)
        H += np.where(pk & (fsd < 0), 0.0015, 0) + np.where(pk, seam(fsd), 0)
        shade *= np.where(pk & (np.abs(fsd) < 0.003) & (s > 0.21), 0.7, 1)
        for xs_ in (-0.045, 0.045):
            st_ = pk & (np.hypot(thp * r_th - xs_, s - 0.205) < 0.006)
            H += np.where(st_, 0.0008, 0); dark += st_ * 0.5
        # quilted knee pad (front of the knee)
        ksd = rect((th - fw) * 0.06, s, 0, Lu + 0.015, 0.06, 0.095, 0.04)
        kin = m & (ksd < 0)
        q = np.abs(np.sin(((th - fw) * 0.06 + s) / 0.024 * np.pi)) * np.abs(np.sin(((th - fw) * 0.06 - s) / 0.024 * np.pi))
        H += np.where(m, seam(ksd) + stitch(ksd, s + th * 0.06, 0.003) + np.where(kin, 0.0022 - 0.0009 * (1 - q), 0), 0)
        shade *= np.where(kin, 0.92 + 0.08 * q, 1)
    # ---- torso: full-length front zip (collar -> crotch) under a storm flap, elastic waist, slanted chest zip pockets
    t = labmask('torso') | labmask('collar')
    front = P[..., 2] > 0.0
    crotch = J('Hips')[1] - 0.10
    zx = P[..., 0] + 0.012                                   # zip runs 12 mm left of the centre line (under the flap)
    zm = (t | labmask('leg')) & front & (P[..., 1] > crotch) & (np.abs(P[..., 0]) < 0.08)
    H += np.where(zm, -0.0006 * np.exp(-(zx / 0.0025) ** 2), 0)
    teeth = zm & (np.abs(zx) < 0.0028)
    dark += teeth * (0.75 + 0.25 * (np.sin(P[..., 1] / 0.0018 * np.pi) > 0))
    flap = zm & (P[..., 0] < 0.012) & (P[..., 0] > -0.024)
    fsd = np.abs(P[..., 0] + 0.006) - 0.018
    H += np.where(zm, np.where(fsd < 0, 0.0009, 0) + seam(fsd) + stitch(fsd, P[..., 1], 0.003), 0)
    shade *= np.where(zm, 1 - 0.3 * np.exp(-((P[..., 0] + 0.024) / 0.0018) ** 2), 1)
    hipy = J('Hips')[1]
    wy = hipy + 0.07
    dw = P[..., 1] - wy
    wm = t & (np.abs(dw) < 0.03)
    H += np.where(wm, 0.0007 * np.sin(np.arctan2(P[..., 0], P[..., 2]) * 70) * np.exp(-(dw / 0.012) ** 2) - 0.0006 * np.exp(-((np.abs(dw) - 0.022) / 0.003) ** 2), 0)
    for sx in (1, -1):    # slanted chest pockets: zip line from (0.03, 1.36) to (0.11, 1.30)
        p0 = np.array([sx * 0.035, 1.365]); p1 = np.array([sx * 0.115, 1.295])
        d = p1 - p0; Ld = np.linalg.norm(d); d /= Ld
        rel = np.stack([P[..., 0] - p0[0], P[..., 1] - p0[1]], -1)
        al = rel @ d; ac = rel @ np.array([-d[1], d[0]])
        on = t & front & (al > 0) & (al < Ld)
        line = on & (np.abs(ac) < 0.0028)
        H += np.where(on, -0.0005 * np.exp(-(ac / 0.002) ** 2), 0); dark += line * 0.8
        bag = t & front & (al > -0.01) & (al < Ld + 0.01) & (ac * sx < 0.0) & (ac * sx > -0.10)
        bsd = np.maximum(np.maximum(-al - 0.01, al - Ld - 0.01), np.maximum(ac * sx, -ac * sx - 0.10))
        H += np.where(bag, 0.0009, 0) + np.where(t & front, seam(bsd) * (np.abs(bsd) < 0.01), 0)
        tabp = t & front & (np.hypot(rel[..., 0] - d[0] * 0.005, rel[..., 1] - d[1] * 0.005) < 0.006)
        H += np.where(tabp, 0.0008, 0); dark += tabp * 0.6
    # shoulder straps (epaulettes) on the shoulder tops
    for sx in (1, -1):
        ep = t & (P[..., 1] > 1.40) & (np.abs(np.abs(P[..., 0]) - 0.12) < 0.06) & (np.abs(P[..., 2] - 0.0) < 0.022) & (np.sign(P[..., 0]) == sx)
        H += np.where(ep, 0.0010, 0)
        shade *= np.where(ep, 0.97, 1)
    # weave micro detail (plain cotton twill for the olive suit, rip-stop for camo)
    yy, xx = np.mgrid[0:res_n, 0:res_n]
    per = 0.005 / texel_m
    if scheme == 'olive':
        H += (np.sin((xx + yy) / max(0.0012 / texel_m, 1.2) * np.pi) * 0.00006).astype(np.float32)
    else:
        rip = ((np.abs(((xx / per) % 1) - 0.5) > 0.43) | (np.abs(((yy / per) % 1) - 0.5) > 0.43)).astype(np.float32)
        H += rip * 0.00012
    H += rng.standard_normal(H.shape).astype(np.float32) * 0.00004
    H = TX.dilate(H, mask, 6)
    H = ndimage.gaussian_filter(H, 0.6)
    normal = TX.height_to_normal(H / texel_m, 1.0)
    blur = ndimage.gaussian_filter(H, 3)
    cav = np.clip(1 + (H - blur) * 260, 0.65, 1.12)
    # ---- grime: dust low on the legs, oil / grease on knees, thighs, belly, cuffs and sleeves (tank crews)
    y = P[..., 1]
    dust = np.clip((0.5 - y) / 0.4, 0, 1) ** 1.5 * 0.45
    oil = np.zeros_like(y)
    for side in ('Left', 'Right'):
        k = J(side + 'Leg')
        oil += 0.7 * np.exp(-np.sum((P - k - [0, 0, 0.05]) ** 2, -1) / 0.075 ** 2)
        oil += 0.35 * np.exp(-np.sum((P - (J(side + 'UpLeg') * 0.5 + k * 0.5) - [0, 0, 0.06]) ** 2, -1) / 0.08 ** 2)
        oil += 0.35 * np.exp(-np.sum((P - J(side + 'Hand') * 0.8 - J(side + 'ForeArm') * 0.2) ** 2, -1) / 0.07 ** 2)
    oil += 0.3 * np.exp(-np.sum((P - [0, 1.02, 0.12]) ** 2, -1) / 0.10 ** 2)
    oil *= np.clip(0.3 + 1.2 * TX.noise3(P, 0.06, seed + 19, 3), 0, 1.4)
    oil = np.clip(oil, 0, 1)
    dust *= np.clip(0.6 + 0.8 * TX.noise3(P, 0.12, seed + 9, 3), 0, 1.3)
    fade = TX.noise3(P, 0.35, seed + 21, 2) * 0.06
    pxm = uv_per_m * res_a
    if scheme == 'emr':
        base = CM.emr(res_a, pxm, seed + 1)
    elif scheme == 'mm14':
        base = CM.mm14(res_a, pxm, seed + 2)
    else:
        base = CM.solid(res_a, olive or '#5e5d42', seed + 3, var=0.06)
        # faint sun-fading on the shoulders / back
        sh = ndimage.zoom(np.clip((P[..., 1] - 1.25) / 0.2, 0, 1) * (N[..., 1] > 0.2), res_a / res_n, order=1)
        base = base * (1 + 0.08 * sh[..., None])
    up = lambda a, o=1: ndimage.zoom(a, res_a / res_n, order=o) if res_a != res_n else a
    shd = up(shade * cav * (1 + fade))
    alb = base * shd[..., None]
    dt = up(np.clip(dust, 0, 1))
    alb = alb * (1 - dt[..., None] * 0.5) + TX.hexc('#6a5b48') * dt[..., None] * 0.5
    ol = up(oil)
    alb = alb * (1 - 0.55 * ol[..., None]) + TX.hexc('#1e1c18') * 0.25 * ol[..., None]
    dk = up(np.clip(dark, 0, 1))
    alb = alb * (1 - dk[..., None] * 0.85) + TX.hexc('#141412') * dk[..., None] * 0.85
    pa = up(patch[..., 3]); pc = np.stack([up(patch[..., c], 0) for c in range(3)], -1)
    alb = alb * (1 - pa[..., None]) + pc * shd[..., None] * pa[..., None]
    alb *= (1 + 0.03 * np.random.default_rng(seed).standard_normal(alb.shape[:2]))[..., None]
    mask_a = up(mask.astype(np.float32), 0) > 0.5
    alb = TX.dilate(np.clip(alb, 0, 1), mask_a, 6)
    return alb, normal


# ====================================================================================== shlemofon (padded tanker helmet)
def _trees(R):
    return [BVHTree.FromPolygons([tuple(v) for v in R['variants'][vn]['head_pos']], [tuple(map(int, t)) for t in R['head']['tri']], all_triangles=True)
            for vn in 'ABC']


def _ray_max(trees, o, d, default):
    best = None
    for t in trees:
        h = t.ray_cast(Vector(o), Vector(d), 0.4)
        if h[0] is not None and (best is None or h[3] > best):
            best = h[3]
    return best if best is not None else default


class HeadShell:
    """radius field around c0 (max over the three head variants), smoothed; direction (az, el): az 0 = +Z (face), + = left"""
    def __init__(self, R, c0, naz=96, nel=60, el0=-80, el1=90):
        self.c0 = np.asarray(c0, float)
        self.trees = _trees(R)
        self.az = np.linspace(-np.pi, np.pi, naz, endpoint=False)
        self.el = np.radians(np.linspace(el0, el1, nel))
        Rr = np.zeros((nel, naz))
        for i, e in enumerate(self.el):
            for j, a in enumerate(self.az):
                Rr[i, j] = _ray_max(self.trees, self.c0, self.dir(a, e), 0.09)
        # fill holes / spikes, smooth (wrap in azimuth)
        Rr = ndimage.median_filter(np.pad(Rr, ((0, 0), (2, 2)), mode='wrap'), size=(3, 3), mode='nearest')[:, 2:-2]
        self.R = ndimage.gaussian_filter(Rr, (1.2, 1.2), mode=('nearest', 'wrap'))

    @staticmethod
    def dir(a, e):
        return np.stack([np.cos(e) * np.sin(a), np.sin(e), np.cos(e) * np.cos(a)], -1)

    def r(self, a, e):
        a = np.asarray(a, float); e = np.asarray(e, float)
        fe = np.clip((e - self.el[0]) / (self.el[1] - self.el[0]), 0, len(self.el) - 1.001)
        fa = ((a - self.az[0]) / (self.az[1] - self.az[0])) % len(self.az)
        i0 = np.floor(fe).astype(int); j0 = np.floor(fa).astype(int); j1 = (j0 + 1) % len(self.az)
        we = fe - i0; wa = fa - j0
        return (self.R[i0, j0] * (1 - we) * (1 - wa) + self.R[i0 + 1, j0] * we * (1 - wa) + self.R[i0, j1] * (1 - we) * wa + self.R[i0 + 1, j1] * we * wa)

    def point(self, a, e, off=0.0):
        return self.c0 + self.dir(a, e) * (self.r(a, e) + off)[..., None]

    def normal(self, a, e, off=0.0, eps=0.01):
        p = self.point(a, e, off)
        pa = self.point(a + eps, e, off); pe = self.point(a, e + eps, off)
        n = np.cross(pa - p, pe - p)
        n /= np.linalg.norm(n, axis=-1, keepdims=True)
        out = p - self.c0
        return n * np.sign(np.sum(n * out, -1, keepdims=True))


def _tube(path, r, n=6, caps=True):
    """tube along a polyline path (m,3), radius r (scalar or (m,)); returns pos, tri, uv (uv: around x along, physical *2)"""
    path = np.asarray(path, float); m = len(path)
    rr = np.broadcast_to(np.asarray(r, float), (m,))
    T_ = np.gradient(path, axis=0); T_ /= np.linalg.norm(T_, axis=1, keepdims=True)
    u = np.cross(T_[0], [0, 1.0, 0])
    if np.linalg.norm(u) < 1e-3:
        u = np.cross(T_[0], [1.0, 0, 0])
    u /= np.linalg.norm(u)
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    rings = []
    for i in range(m):
        u = u - T_[i] * (u @ T_[i]); u /= np.linalg.norm(u); v = np.cross(T_[i], u)
        rings.append(path[i] + rr[i] * (np.cos(a)[:, None] * u + np.sin(a)[:, None] * v))
    pos = np.concatenate(rings)
    tri = []
    for i in range(m - 1):
        for k in range(n):
            a0, a1 = i * n + k, i * n + (k + 1) % n
            b0, b1 = a0 + n, a1 + n
            tri += [[a0, b0, b1], [a0, b1, a1]]
    along = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))])
    uv = np.stack([np.tile(a / (2 * np.pi) * 2 * np.pi * rr.mean() * 2, m), np.repeat(along * 2, n)], 1)
    if caps:
        c0 = len(pos); c1 = c0 + 1
        pos = np.concatenate([pos, path[:1], path[-1:]])
        uv = np.concatenate([uv, [[0, 0], [0, along[-1] * 2]]])
        for k in range(n):
            tri += [[c0, k, (k + 1) % n], [c1, (m - 1) * n + (k + 1) % n, (m - 1) * n + k]]
    return pos, np.array(tri), uv


def _spline(pts, n=24):
    """Catmull-Rom through pts (open), ~n samples"""
    Pp = np.asarray(pts, float); Pp = np.vstack([2 * Pp[0] - Pp[1], Pp, 2 * Pp[-1] - Pp[-2]])
    out = []; per = max(n // (len(Pp) - 3), 2)
    for i in range(1, len(Pp) - 2):
        p0, p1, p2, p3 = Pp[i - 1:i + 3]
        for t in np.linspace(0, 1, per, endpoint=False):
            out.append(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(Pp[-2])
    return np.array(out)


def _p(pos, tri, mat, uv=None, outward=None, closed=True):
    q = G.part(pos, tri, mat, uv)
    return G.orient_closed(q) if closed else G.orient_open(q, outward)


def tsh_helmet(R, shell_mat, group, seed=0):
    """Soviet padded tanker helmet (TSh-4 style) fitted to the three head variants"""
    lm = R['variants']['A']['lm']
    c0 = np.array([0.0, 1.628, 0.040])
    HS = HeadShell(R, c0)
    out = []
    OFF = 0.011                          # padded cloth over the head

    def el_min(az):
        a = np.abs(np.angle(np.exp(1j * az)))
        e_front, e_side, e_back = np.radians(23), np.radians(-61), np.radians(-36)
        w_open = 1 - np.clip((a - np.radians(58)) / np.radians(14), 0, 1)          # face opening (forehead edge) up to |az| 58..72 deg
        w_open = w_open * w_open * (3 - 2 * w_open)
        w_back = np.clip((a - np.radians(105)) / np.radians(75), 0, 1)
        side = e_side * (1 - w_back) + e_back * w_back
        return e_front * w_open + side * (1 - w_open)
    naz, nel = 56, 11
    az = np.linspace(-np.pi, np.pi, naz, endpoint=False)
    t = np.linspace(0, 1, nel)
    AZ, TT = np.meshgrid(az, t)
    E0 = el_min(AZ)
    EL = E0 + (np.radians(89.0) - E0) * (1 - (1 - TT) ** 1.5)
    # padding bulges slightly between the rolls; edge rolls in toward the head
    OFFm = OFF * (0.55 + 0.45 * np.clip(TT * 6, 0, 1))
    outer = HS.point(AZ, EL, OFFm)
    pos = np.concatenate([outer.reshape(-1, 3), [c0 + HS.dir(0, np.pi / 2) * (HS.r(0, np.pi / 2) + OFF)]])
    Tg = G.grid_tris(naz, nel, closed_u=True)
    top = [[(nel - 1) * naz + k, (nel - 1) * naz + (k + 1) % naz, naz * nel] for k in range(naz)]
    T = np.concatenate([Tg, np.array(top)])
    arc = (HS.r(AZ, EL) + OFF)
    uv = np.concatenate([np.stack([(AZ * arc).reshape(-1) * 2, -(EL * arc).reshape(-1) * 2], 1), [[0, -np.pi / 2 * 0.1 * 2]]])
    shell = G.part(pos, T, shell_mat, uv)
    shell = G.orient_open(shell, pos - c0)
    out.append(shell)
    # edge binding (rolled hem) along the lower edge, pulled in toward the head (no gap visible)
    ab = np.linspace(-np.pi, np.pi, 73)
    eb = el_min(ab)
    edge = HS.point(ab, eb, OFF * 0.35)
    # skip the front (forehead roll covers it)
    sel = np.abs(np.angle(np.exp(1j * ab))) > np.radians(52)
    for seg in np.split(np.where(sel)[0], np.where(np.diff(np.where(sel)[0]) > 1)[0] + 1):
        if len(seg) < 2:
            continue
        p_, t_, u_ = _tube(edge[seg], 0.0055, n=4)
        out.append(_p(p_, t_, shell_mat, u_))
    # forehead roll: across the brow from temple to temple
    af = np.linspace(-np.radians(62), np.radians(62), 17)
    ef = el_min(af) + np.radians(4)
    fpath = HS.point(af, ef, OFF + 0.004)
    rr = 0.0125 * (0.7 + 0.3 * np.cos(af / np.radians(62) * np.pi / 2))
    p_, t_, u_ = _tube(fpath, rr, n=8)
    out.append(_p(p_, t_, shell_mat, u_))
    # longitudinal padded rolls: centre, two on the crown, one above each ear (front -> back over the skull)
    for beta, rad, ph0, ph1 in ((0.0, 0.0125, 30, 212), (0.40, 0.0115, 31, 208), (-0.40, 0.0115, 31, 208), (0.86, 0.0105, 38, 196), (-0.86, 0.0105, 38, 196)):
        ph = np.radians(np.linspace(ph0, ph1, 15))
        d = np.stack([np.full_like(ph, np.sin(beta)), np.cos(beta) * np.sin(ph), np.cos(beta) * np.cos(ph)], 1)
        a_ = np.arctan2(d[:, 0], d[:, 2]); e_ = np.arcsin(np.clip(d[:, 1], -1, 1))
        e_ = np.maximum(e_, el_min(a_) + np.radians(5))
        taper = np.clip(np.minimum((ph - ph[0]) / np.radians(14), (ph[-1] - ph) / np.radians(14)), 0.25, 1) ** 0.5
        path = HS.point(a_, e_, OFF + rad * 0.35)
        p_, t_, u_ = _tube(path, rad * taper, n=6)
        out.append(_p(p_, t_, shell_mat, u_))
    # ear-phone housings (round bulges over the ears) with a rubber rim
    ears = []
    for sx in (1, -1):
        a_ = sx * np.radians(90); e_ = np.radians(-22)
        pc = HS.point(a_, e_, OFF); nn = HS.normal(a_, e_, OFF)
        up = np.array([0, 1.0, 0]) - nn * nn[1]; up /= np.linalg.norm(up)
        side = np.cross(up, nn)
        M = PO.mat4(pc, side, up, nn)
        Rx = np.eye(4); Rx[:3, :3] = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
        out.append(PO.local_part(PO.cyl(0.038, 0.016, 14, 0.032), M @ PO.T(0, 0, -0.004) @ Rx, shell_mat))
        out.append(PO.local_part(PO.cyl(0.040, 0.004, 14), M @ PO.T(0, 0, -0.005) @ Rx, 'tsh_rubber', 'hard'))
        out.append(PO.local_part(PO.cyl(0.010, 0.006, 8), M @ PO.T(0, 0, 0.011) @ Rx, 'radio_black', 'hard'))
        ears.append((pc, nn, up, side))
    # chin strap: from the bottom-front corners of the ear flaps under the chin (buckle on the left)
    jaw = lm['jaw']
    pts = []
    for sx in (1, -1):
        a_ = sx * np.radians(78); pts.append(HS.point(a_, el_min(a_) + np.radians(3), OFF * 0.5))
    pL, pR = pts
    mid = np.array([0.0, jaw[1] - 0.030, jaw[2] - 0.040])
    path = np.array([pL, pL * 0.45 + mid * 0.55 + [0.012, -0.012, 0.0], mid, pR * 0.45 + mid * 0.55 + [-0.012, -0.012, 0.0], pR])
    sp = _spline(path, 14)
    p_, t_, u_ = _tube(sp, 0.0045, n=5)
    out.append(_p(p_, t_, 'tsh_rubber', u_))
    out.append(PO.local_part(PO.rbox(0.016, 0.012, 0.006, 0.002, 1), PO.mat4(sp[3], np.array([0, 0, 1.0]), np.array([0, 1.0, 0]), np.array([1.0, 0, 0])), 'buckle_steel', 'hard'))
    for q in out:
        q['group'] = group
    return out, HS, ears


def larynx(R, env, HS, ears):
    """throat microphone band around the neck (two capsules at the throat) + intercom cable from the left ear housing
    down the chest to a plug; weighted to Neck/Head/Spine1 by the nearest body vertices (set here: W)"""
    out = []
    trees = HS.trees
    yb = 1.512; o = np.array([0.0, yb, 0.012])
    ths = np.linspace(-np.pi, np.pi, 21)
    ring = []
    for th in ths:
        d = np.array([np.sin(th), 0, np.cos(th)])
        ring.append(o + d * (_ray_max(trees, o, d, 0.055) + 0.0045))
    ring = np.array(ring); ring[-1] = ring[0]
    p_, t_, u_ = _tube(ring, 0.0042, n=5, caps=False)
    out.append(G.orient_open(G.part(p_, t_, 'tsh_rubber', u_), p_ - np.repeat(ring, 5, 0)))
    for sx in (1, -1):    # capsules on both sides of the larynx
        th = sx * 0.42
        d = np.array([np.sin(th), 0, np.cos(th)])
        pc = o + d * (_ray_max(trees, o, d, 0.055) + 0.01)
        out.append(PO.local_part(PO.rbox(0.020, 0.024, 0.012, 0.005, 2), PO.mat4(pc, np.cross([0, 1.0, 0], d), np.array([0, 1.0, 0]), d), 'radio_black', 'hard'))
    # cable: left ear housing -> along the neck -> chest (left of the zip) -> plug
    pc, nn, up, side = ears[0]
    p0 = pc - up * 0.030 + nn * 0.004
    p1 = np.array([0.068, 1.52, 0.035])
    p2 = env.point(1.44, 0.55, 0.012)
    p3 = env.point(1.36, 0.42, 0.010)
    p4 = env.point(1.29, 0.36, 0.010)
    sp = _spline(np.array([p0, p1, p2, p3, p4]), 22)
    p_, t_, u_ = _tube(sp, 0.0032, n=5)
    out.append(_p(p_, t_, 'cable_black', u_))
    d = sp[-1] - sp[-2]; d /= np.linalg.norm(d)
    nn2 = env.normal(1.29, 0.36)
    out.append(PO.local_part(PO.cyl(0.008, 0.045, 8), PO.mat4(sp[-1], np.cross(d, nn2), d, nn2), 'cable_black', 'hard'))
    for q in out:
        q['group'] = 'crew_larynx'
    return out


# ====================================================================================== belt + holster, soft armour vest
def _rotz(deg):
    a = np.radians(deg); c, s = np.cos(a), np.sin(a)
    M = np.eye(4); M[:3, :3] = [[c, -s, 0], [s, c, 0], [0, 0, 1]]
    return M


def belt_holster(env, fac):
    """waist belt (over the coverall, ~45 mm) with a plain frame buckle, PM flap holster on the right hip (muzzle down/back),
    spare magazine pouch on the front of the holster, small pouch on the left"""
    leather = 'belt_brown' if fac == 'ru' else 'belt_olive'
    hol = 'holster_brown' if fac == 'ru' else 'holster_black'
    out = []
    y0, y1 = 1.000, 1.045
    b = G.band(env, y0, y1, -np.pi, np.pi, 0.003, 0.0045, nu=48, nv=3, mat=leather)
    out.append(G.orient_closed(b))
    # buckle (frame + plate) at the front
    Mb = K.side_M(env, 0.0, 0.5 * (y0 + y1), 0.0075)
    out.append(PO.local_part(PO.rbox(0.058, 0.050, 0.006, 0.003, 1), Mb @ PO.T(0, 0, 0.003), 'buckle_steel', 'hard'))
    out.append(PO.local_part(PO.rbox(0.046, 0.038, 0.004, 0.002, 1), Mb @ PO.T(0, 0, 0.006), leather, 'hard'))
    # holster (PM flap holster) on the right hip: belt loop + body angled ~35 deg (muzzle down / to the rear)
    th = -1.80
    Mh = K.side_M(env, th, 1.022, 0.008)
    out.append(PO.local_part(PO.rbox(0.055, 0.060, 0.008, 0.003, 1), Mh @ PO.T(0, -0.005, 0.004), hol, 'hard'))       # belt loop
    Mbody = Mh @ PO.T(0.006, -0.062, 0.026) @ _rotz(35)
    out.append(PO.local_part(PO.rbox(0.165, 0.098, 0.036, 0.014, 2), Mbody, hol))                                         # body
    out.append(PO.local_part(PO.rbox(0.168, 0.034, 0.040, 0.010, 2), Mbody @ PO.T(0.0, 0.040, 0.002), hol))              # flap over the top
    out.append(PO.local_part(PO.rbox(0.030, 0.050, 0.006, 0.002, 1), Mbody @ PO.T(0.040, 0.014, 0.021), hol, 'hard'))    # flap tongue
    out.append(PO.local_part(PO.rbox(0.012, 0.012, 0.004, 0.002, 1), Mbody @ PO.T(0.040, 0.000, 0.0255), 'buckle_steel', 'hard'))
    out.append(PO.local_part(PO.rbox(0.032, 0.070, 0.016, 0.006, 1), Mbody @ PO.T(-0.058, -0.006, 0.024), hol))           # spare mag pocket
    out.append(PO.local_part(PO.rbox(0.004, 0.048, 0.006, 0.0015, 1), Mbody @ PO.T(0.085, -0.040, 0.0), 'cable_black', 'hard'))   # lanyard strap
    # small utility pouch on the left hip
    Mp = K.side_M(env, 1.65, 1.0, 0.008)
    out.append(PO.local_part(PO.rbox(0.075, 0.085, 0.035, 0.012, 2), Mp @ PO.T(0, -0.025, 0.018), leather if fac == 'ru' else 'crew_olive_gear'))
    out.append(PO.local_part(PO.rbox(0.078, 0.030, 0.038, 0.008, 2), Mp @ PO.T(0, 0.012, 0.019), leather if fac == 'ru' else 'crew_olive_gear'))
    for q in out:
        q['group'] = 'crew_belt'
    return out


def soft_vest(env, mat, group):
    """light soft armour vest (crew): front / back panels, side panels, padded shoulder straps, front closure strap"""
    out = []
    fp = G.env_panel(env, 0.0, 1.235, 0.145, 0.17, 0.013, chamfer=0.06, mat=mat, nu=13, nv=15, edge=0.018, rad=0.04)
    bp = G.env_panel(env, np.pi, 1.245, 0.145, 0.175, 0.012, mat=mat, back=True, chamfer=0.05, nu=13, nv=15, edge=0.018, rad=0.04)
    out += [G.orient_closed(fp), G.orient_closed(bp)]
    for sgn in (1, -1):
        ths = (0.62, np.pi - 0.58) if sgn > 0 else (-(np.pi - 0.58), -0.62)
        out.append(G.orient_closed(G.band(env, 1.075, 1.20, ths[0], ths[1], 0.003, 0.010, nu=16, nv=4, mat=mat, wrinkle=0.0012, seed=7 if sgn > 0 else 8)))
        out.append(K.shoulder_strap(env, 'L' if sgn > 0 else 'R', mat, x0=0.095, width=0.055, thick=0.010, y_front=1.39, y_back=1.40))
    # velcro closure flaps on the sides (front panel over the side panels)
    for sgn in (1, -1):
        M = K.side_M(env, sgn * 0.75, 1.15, 0.016)
        out.append(PO.local_part(PO.rbox(0.07, 0.11, 0.004, 0.002, 1), M, mat))
    # a pistol-magazine double pouch + small radio pouch on the front
    ffr = fp['frame']
    out += PO.mag_pouch(dict(fabric=mat, hardware='gear_hardware', webbing=mat), K.panel_M(ffr, -0.075, -0.14), w=0.055, h=0.085, d=0.03)
    out += PO.radio_pouch(dict(fabric=mat, hardware='gear_hardware', webbing=mat, radio='radio_black'), K.panel_M(ffr, 0.07, -0.13), w=0.06, h=0.10, d=0.035, antenna=0.12)
    for q in out:
        q['group'] = group
    return out


# ====================================================================================== presets + atlas
def presets(fac):
    if fac == 'ru':
        spec = [  # (body, scheme, helmet colour, hands, vest)
            ('A', 'olive', 'black', 'gloves', None),
            ('B', 'emr', 'black', 'hands', 'crew_vest_olive'),
            ('C', 'olive', 'olive', 'gloves', 'crew_vest_olive'),
        ]
    else:
        spec = [
            ('A', 'mm14', 'black', 'gloves', None),
            ('B', 'olive', 'olive', 'gloves', 'crew_vest_tan'),
            ('C', 'mm14', 'black', 'hands', 'crew_vest_olive'),
        ]
    out = []
    for k, (b, sch, hc, hand, vest) in enumerate(spec):
        parts = [f'crew_body_{b}_{sch}', f'helmet_crew_{hc}', 'crew_larynx', hand, 'boots', 'crew_belt', 'armband_L', 'armband_R', 'legband_R']
        if vest:
            parts.append(vest)
        out.append(dict(name=f'crew_combo_{k}', body=f'body_{b}', coverall=SCHEMES[fac][sch][0], scheme=sch, helmet=f'shlemofon ({hc})',
                        hands=hand, vest=vest or 'none', holster='PM flap holster, right hip', parts=parts))
    return out


def _spec(rec, name, base=None, nrm=None, color=(1, 1, 1), rough=0.9, metal=0.0):
    rec.specs[name] = dict(color=np.asarray(color, float)[:3], metal=metal, rough=rough, base=base, nrm=nrm, double=False)


def _tile_spec(rec, name, hexcol, seed):
    res = 512
    h = CM.cordura_tile(res, seed=seed)
    a = CM.solid_tile(res, hexcol, seed=seed, var=0.07)
    hb = ndimage.gaussian_filter(h, 2, mode='wrap')
    a = a * (1 + (h - hb)[..., None] * 0.25) * (0.93 + 0.07 * np.clip(hb, -1, 1)[..., None])
    n = TX.height_to_normal(h, 0.35)
    _spec(rec, name, base=np.clip(a, 0, 1), nrm=n, rough=0.9)


def make_crew(W, rec, R, fac, env, gear_weights, vertex_ao, log=print):
    """bake crew textures + gear, register them (record-only: no per-part nodes are written), write crew_combo_N presets"""
    import combo as CB
    from build_soldier import head_fit
    orig = rec.mat_name
    rec.mat_name = lambda mi: mi if isinstance(mi, str) else orig(mi)
    CB.TILE_MATS.update(TILE_PX_CREW.keys())
    CB.TILE_PX.update(TILE_PX_CREW)
    sk = R['skel']
    # ---- materials
    for nm, (col, rough, met) in SOLID_SPECS.items():
        if nm not in rec.specs:
            _spec(rec, nm, color=TX.hexc(col), rough=rough, metal=met)
    _tile_spec(rec, 'tsh_black', '#1b1b1a', 31)
    _tile_spec(rec, 'tsh_olive', '#45472f', 32)
    _tile_spec(rec, 'crew_olive_gear', '#4d5038' if fac == 'ru' else '#4a5039', 33)
    _tile_spec(rec, 'crew_tan_gear', '#7a6a4f', 34)
    # ---- coveralls on the three body variants
    U = R['uniform']
    mesh = dict(pos=R['variants']['A']['uniform_pos'], nrm=R['variants']['A']['uniform_nrm'], uv=U['uv'], tri=U['tri'])
    for sch, (mname, kind, olive) in SCHEMES[fac].items():
        alb, nrm = bake_coverall(mesh, sk, U['labels'], fac, kind, seed=(41 if fac == 'ru' else 43) + len(sch), olive=olive)
        _spec(rec, mname, base=alb, nrm=nrm, rough=0.9 if kind == 'olive' else 0.92)
        log('coverall', fac, sch, alb.shape)
        for vn in 'ABC':
            prims = [dict(p) for p in rec.nodes[f'body_{vn}']]
            prims[0]['mat'] = mname                    # prims[0] = uniform (write_body order: uniform, head, eyes)
            rec.nodes[f'crew_body_{vn}_{sch}'] = prims
    # ---- gear parts
    parts = []
    hp = None
    for hc, mat in (('black', 'tsh_black'), ('olive', 'tsh_olive')):
        hp_, HS, ears = tsh_helmet(R, mat, f'helmet_crew_{hc}')
        parts += hp_
    parts += larynx(R, env, HS, ears)
    parts += belt_holster(env, fac)
    parts += soft_vest(env, 'crew_olive_gear', 'crew_vest_olive')
    if fac == 'ua':
        parts += soft_vest(env, 'crew_tan_gear', 'crew_vest_tan')
    parts = [G.box_uv(p, 2.0) if 'local' in p else p for p in parts]
    for p in parts:
        if p['nrm'] is None:
            p['nrm'] = MU.vertex_normals(p['pos'], p['tri'])
    body_tris = [(R['variants']['B']['uniform_pos'], U['tri'])]
    head_tris = [(R['variants']['B']['head_pos'], R['head']['tri'])]
    vertex_ao([p for p in parts if not p['group'].startswith('helmet') and p['group'] != 'crew_larynx'], body_tris)
    for hn in ('helmet_crew_black', 'helmet_crew_olive'):
        vertex_ao([p for p in parts if p['group'] == hn], head_tris)
    vertex_ao([p for p in parts if p['group'] == 'crew_larynx'], head_tris + body_tris)
    # throat mic + cable: nearest weights over head + uniform vertices (Head / Neck / Spine1 allowed)
    refP = np.concatenate([R['variants']['A']['head_pos'], R['variants']['A']['uniform_pos']])
    refW = np.concatenate([R['head']['W'], U['W']])
    for p in parts:
        if p['group'] == 'crew_larynx':
            p['W'] = AS.nearest_weights(p['pos'], refP, refW, k=6)
    gear_weights(sk, R['variants']['A']['uniform_pos'], U['W'], parts)
    tri_count = {}
    bygroup = {}
    for p in parts:
        bygroup.setdefault(p['group'], {}).setdefault(p['mat'], []).append(p)
    for gname, bym in bygroup.items():
        prims = []
        for mname, ps in bym.items():
            m = G.merge(ps)
            prims.append(dict(pos=m['pos'], nrm=m['nrm'], uv=m['uv'], idx=m['tri'], mat=mname, W=np.concatenate([p['W'] for p in ps]), color=m['col']))
            tri_count[gname] = tri_count.get(gname, 0) + len(m['tri'])
        rec.nodes[gname] = prims
    log('crew parts', tri_count)
    pr = presets(fac)
    man, _ = CB.make(W, rec, 'crew_' + fac, pr, log=log)
    rec.mat_name = orig
    for d in man:
        d['part_tris'] = {n: tri_count.get(n) for n in d['parts'] if n in tri_count}
    return man
