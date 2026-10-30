"""Procedural head / hand skin textures (albedo + normal) evaluated on rasterised bind-pose positions."""
import numpy as np
from scipy import ndimage
import tex as TX
import mhbody as M

SKIN = {  # per head variant: tone, stubble, hair colour, brows
    'A': dict(tone='#d8a88b', stub=0.55, hair='#3b2e24', brow='#3a2c22', red=0.10, dirt=0.25),
    'B': dict(tone='#c99378', stub=0.95, hair='#4a4038', brow='#3a3029', red=0.16, dirt=0.35, moustache=True),
    'C': dict(tone='#c7956f', stub=0.15, hair='#1d1814', brow='#1f1a16', red=0.06, dirt=0.3),
}


def landmarks(V_dm, ground):
    g = lambda n: M.load_obj()['v'][0] * 0 + V_dm[M.group_verts(n)].mean(0) * 0.1 - [0, ground, 0]
    return dict(eyeL=g('joint-l-eye'), eyeR=g('joint-r-eye'), mouth=g('joint-mouth'), jaw=g('joint-jaw'),
                head=g('joint-head'), top=g('joint-head-2'), neck=g('joint-neck'))


def bake_head(mesh, lm, variant, res=1024, seed=0):
    p = SKIN[variant]
    rng = np.random.default_rng(seed)
    R = TX.raster(mesh['uv'], mesh['tri'], {'P': mesh['pos'], 'N': mesh['nrm']}, res)
    P, N, mask = R['P'], R['N'], R['mask']
    eL, eR, mo = lm['eyeL'], lm['eyeR'], lm['mouth']
    ec = (eL + eR) / 2
    x, y, z = P[..., 0], P[..., 1], P[..., 2]
    tone = TX.hexc(p['tone'])
    var = TX.noise3(P, 0.05, seed + 1, 3)
    alb = np.ones(P.shape[:2] + (3,)) * tone
    alb *= (1 + 0.06 * var)[..., None]
    red = TX.hexc('#c86a5a')
    def gauss(c, s, sx=1, sy=1, sz=1):
        d = (P - c) / [sx, sy, sz]
        return np.exp(-np.sum(d ** 2, -1) / s ** 2)
    rmask = p['red'] * 4 * (gauss(eL + [0.02, -0.035, 0.0], 0.022) + gauss(eR + [-0.02, -0.035, 0.0], 0.022)
                            + 0.8 * gauss(ec + [0, -0.035, 0.035], 0.012))
    # ears (lateral, at eye height, behind)
    ears = gauss(eL + [0.055, -0.01, -0.07], 0.03) + gauss(eR + [-0.055, -0.01, -0.07], 0.03)
    rmask += p['red'] * 3 * ears
    alb = alb * (1 - np.clip(rmask, 0, 0.5)[..., None]) + red * np.clip(rmask, 0, 0.5)[..., None] * 0.9
    # lips
    lx = (x - mo[0]) / 0.024; ly = (y - mo[1]) / 0.009
    lips = np.clip(1.2 - (lx ** 2 + ly ** 2), 0, 1) * (z > mo[2] - 0.02)
    alb = alb * (1 - 0.55 * lips[..., None]) + TX.hexc('#a85d55') * 0.55 * lips[..., None]
    # eye sockets slightly darker / bluish
    sock = gauss(eL + [0, -0.004, 0.005], 0.017) + gauss(eR + [0, -0.004, 0.005], 0.017)
    alb *= (1 - 0.18 * np.clip(sock, 0, 1))[..., None]
    # brows
    hair = TX.hexc(p['hair'])
    strands = np.clip(0.75 + 0.35 * TX.noise3(P, 0.012, seed + 3, 2), 0, 1)
    brow = 0
    for e, sx in ((eL, 1), (eR, -1)):
        dx = (x - e[0]) * sx
        cy = e[1] + 0.017 + 0.004 * np.cos(np.clip(dx / 0.03, -1.6, 1.6)) - 0.004 * (dx > 0.01) * (dx - 0.01) / 0.02
        b = np.exp(-((y - cy) / 0.0045) ** 2) * (dx > -0.022) * (dx < 0.03) * (z > e[2] - 0.025)
        brow = brow + b
    brow = np.clip(brow * strands, 0, 1)
    alb = alb * (1 - 0.85 * brow[..., None]) + TX.hexc(p['brow']) * 0.85 * brow[..., None]
    # stubble / beard zone: below cheekbones, front & sides of jaw, above throat
    hc = (eL + eR) / 2 + [0, 0, -0.07]   # rough head centre
    jaw_y = mo[1] - 0.055
    zone = (y < ec[1] - 0.04) & (y > jaw_y - 0.035) & (z > hc[2] - 0.01)
    zone = zone.astype(np.float32)
    zone *= np.clip((ec[1] - 0.04 - y) / 0.01, 0, 1)
    # fade at sideburn/ears and below the jaw
    zone *= np.clip((y - (jaw_y - 0.035)) / 0.02, 0, 1)
    zone *= 1 - lips * 1.2
    zone = np.clip(zone, 0, 1)
    if p.get('moustache'):
        zone += 0.5 * np.exp(-((x - mo[0]) / 0.025) ** 2 - ((y - mo[1] - 0.012) / 0.006) ** 2) * (z > mo[2] - 0.02)
    dots = (rng.random(P.shape[:2]) < 0.55).astype(np.float32)
    stub = np.clip(zone, 0, 1) * p['stub'] * (0.5 + 0.5 * dots)
    alb = alb * (1 - 0.5 * stub[..., None]) + hair * 0.5 * stub[..., None]
    # scalp buzz cut: angle above a hairline depending on azimuth
    d = P - hc
    az = np.arctan2(d[..., 0], d[..., 2])  # 0 = front
    el = np.arctan2(d[..., 1], np.hypot(d[..., 0], d[..., 2]))
    front = np.cos(az)
    thr = 0.55 * (front > 0) * front ** 2 + 0.25 * (1 - np.abs(front)) - 0.25 * (front < 0) * front ** 2 * 1.4
    # sideburns stay above the ear top, nape goes low
    hm = np.clip((el - thr) / 0.06, 0, 1)
    hm *= (y > lm['mouth'][1] - 0.01).astype(np.float32)
    hm *= np.clip(1 - gauss(eL + [0.06, -0.012, -0.06], 0.028) * 2 - gauss(eR + [-0.06, -0.012, -0.06], 0.028) * 2, 0, 1)
    hd = (rng.random(P.shape[:2]) < 0.7).astype(np.float32)
    hmask = hm * (0.75 + 0.25 * hd)
    alb = alb * (1 - 0.7 * hmask[..., None]) + hair * 0.7 * hmask[..., None]
    # grime
    dirt = np.clip(TX.noise3(P, 0.03, seed + 7, 3) * 1.5 - 0.1, 0, 1) * p['dirt']
    alb = alb * (1 - 0.35 * dirt[..., None]) + TX.hexc('#6a5a48') * 0.35 * dirt[..., None]
    # pores / micro detail normal
    nrm = None
    alb = TX.dilate(np.clip(alb, 0, 1), mask, 8)
    return alb, nrm


def bake_hands(mesh, tone, res=512, seed=0):
    R = TX.raster(mesh['uv'], mesh['tri'], {'P': mesh['pos']}, res)
    P, mask = R['P'], R['mask']
    alb = np.ones(P.shape[:2] + (3,)) * TX.hexc(tone)
    alb *= (1 + 0.07 * TX.noise3(P, 0.03, seed, 3))[..., None]
    dirt = np.clip(TX.noise3(P, 0.02, seed + 2, 3) * 1.6, 0, 1) * 0.4
    alb = alb * (1 - 0.4 * dirt[..., None]) + TX.hexc('#5e5040') * 0.4 * dirt[..., None]
    return TX.dilate(np.clip(alb, 0, 1), mask, 8)


def eye_texture(res=128, iris='#5b4a35'):
    yy, xx = np.mgrid[0:res, 0:res] / res - 0.5
    r = np.hypot(xx, yy)
    img = np.ones((res, res, 3)) * TX.hexc('#d9d2c8')
    img *= (1 - 0.25 * np.clip((r - 0.3) / 0.2, 0, 1))[..., None]
    ir = TX.hexc(iris) * (0.8 + 0.4 * np.random.default_rng(1).random((res, res)))[..., None]
    m = r < 0.2
    img[m] = ir[m]
    img[r < 0.085] = (0.03, 0.03, 0.03)
    ring = np.abs(r - 0.2) < 0.012
    img[ring] = img[ring] * 0.5
    return np.clip(img, 0, 1)
