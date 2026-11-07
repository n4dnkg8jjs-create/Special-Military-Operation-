"""soldiers_v10 headgear detail: painted helmet shells, 4-point retention harness, nape pad + dial, scrim.

Painted shells (same approach as packs.py): every helmet shell gets its own chart in the faction's `hg_<fac>` texture (shared
with comms.py: headsets, PTTs, radios), so the per-texel detail costs no triangles and a preset stays at 2 draw calls (combo.make
places the charts in the preset atlas like the pack charts).  The shell grid is unwrapped in its own (azimuth, rim -> crown)
parameters; each texel is painted from its 3D point on the shell (triplanar camo at the gear-camo scale, so there is no
stretching toward the crown and no seam at the back), plus a height field -> normal map + cavity AO:
  covers (MM-14 / MultiCam / EMR): 4-panel seams with seam allowance ridges and stitch rows, folded hem with a stitch line and
    the drawstring channel round the rim, fabric creases (3D noise, so the wrap seam is invisible), cloth gathered under the
    band, contact shadow of the band, harness bolt heads pressing through the cloth, sewn label at the back, rim grime;
  bare shells (FAST-type ranger green, SSh-68 olive paint, Altyn steel): mottled matte paint, edge wear / chips along the
    rim (steel showing on the SSh-68), scratches, domed harness bolt heads (SSh-68: liner rivets), FAST loop-velcro fields
    (crown, sides, rear: were raised geometry strips - now painted, -0.4 k tris);
  cover seams are painted too (were 4 raised geometry strips, -0.3 k tris per helmet).
Retention (was a 2 x 3 ribbon chin strap shared by all faces): a 4-point harness per helmet x body variant (front strap in
front of the ear, rear strap behind and under it, both from inside the shell to a tri-glide junction under the ear, chin strap
along the jaw to a padded chin cup, side-release buckle on the left), projected onto that variant's own head mesh (both strap
edges, kept 2.5 mm off the skin, checked for skin penetration) - nodes `retention_<helmet>_<body>` used by the presets;
nape cradle + pad with a ratchet dial at the back on modern helmets (FAST-type, MICH, 6B47, TOR-D); SSh-68: 2-point leather
strap with a buckle.  Scrim: burlap strips tucked under the band of the UA PASGT-type (MM-14) and the RU 6B7 helmets.

Real kit, 2022-25 photos: UA FAST-type copies (Ops-Core style 4-point with BOA-type dial), TOR-D / Kirasa PASGT-type kaska
(4-point, nape pad), MICH; RU 6B47 Ratnik (4-point harness, adjustable nape), 6B7-1M, SSh-68 (leather 2-point), Altyn."""
import numpy as np
from scipy import ndimage
from PIL import Image
from mathutils import Vector
import gear as G
import pouches as PO
import packs as PK
import meshutil as MU

HPXM = 1300.0                # helmet shell chart density (px/m)
_TEX = {}
_TILE = {}

HG_SOLIDS = {
    'harness_ua': ('#3a3428', 0.85, 0.0), 'harness_ru': ('#2c2e27', 0.85, 0.0), 'harness_leather': ('#3d2d20', 0.6, 0.0),
    'harness_pad': ('#1c1c1b', 0.9, 0.0), 'scrim_tan': ('#7b6a4b', 0.97, 0.0), 'scrim_green': ('#4f5338', 0.97, 0.0),
}


def key(fac):
    return 'hg_' + fac


# ------------------------------------------------------------------------------------------------ texture helpers
def _tile_at(name, s):
    """gear tile (assemble._tile) resampled to s px/m (0.5 m repeat): (albedo, normal -1..1)"""
    k = int(round(0.5 * s))
    if (name, k) not in _TILE:
        import assemble as AS
        a, n = AS._tile({'emr_gear': 'emr', 'multicam_gear': 'multicam', 'coyote_webbing': 'coyote', 'mm14_gear': 'mm14', 'ranger_gear': 'ranger'}.get(name, name))
        a8 = (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)
        aa = np.asarray(Image.fromarray(a8).resize((k, k), Image.LANCZOS)).astype(np.float32) / 255
        nn = np.stack([np.asarray(Image.fromarray(np.ascontiguousarray(n[..., i] * 2 - 1, np.float32)).resize((k, k), Image.BILINEAR)) for i in range(3)], -1)
        _TILE[(name, k)] = (aa, nn)
    return _TILE[(name, k)]


def triplanar(P, N, name, s, off=(0.0, 0.0, 0.0)):
    a, n = _tile_at(name, s)
    k = a.shape[0]
    Q = (P + np.asarray(off)) / 0.5 * k
    w = np.abs(N) ** 6; w /= w.sum(-1, keepdims=True)
    col = np.zeros(P.shape[:-1] + (3,), np.float32); nrm = np.zeros_like(col)
    for ax, (i, j) in ((2, (0, 1)), (0, (2, 1)), (1, (0, 2))):
        xi = Q[..., i].astype(int) % k; yi = Q[..., j].astype(int) % k
        col += a[yi, xi] * w[..., ax:ax + 1]
        nrm += n[yi, xi] * w[..., ax:ax + 1]
    return col, nrm


def noise3(P, waves, seed):
    """seamless 3D noise: sum of random plane waves (wavelengths in m)"""
    rng = np.random.default_rng(seed)
    out = np.zeros(P.shape[:-1], np.float32)
    for lam in waves:
        for _ in range(3):
            d = rng.normal(size=3); d /= np.linalg.norm(d)
            out += np.sin((P @ d) * 2 * np.pi / lam + rng.uniform(0, 6.28)).astype(np.float32)
    return out / np.sqrt(3 * len(waves))


def _ss(a, b, x):
    return PK._ss(a, b, x)


def _wrap(a):
    return (a + np.pi) % (2 * np.pi) - np.pi


# ------------------------------------------------------------------------------------------------ shell charts
def shell_charts(kind, fac, H, c, surf, rim_fn, flare_fn, mat, naz, nel, AZ, TT):
    """charts for the shell grid (outer, inner, rim trim).  Returns (outer chart, inner chart, rim chart, aw, bh)"""
    R0 = surf(np.array([np.pi / 2]), rim_fn(np.array([np.pi / 2])))[0] - c
    rmax = max(np.linalg.norm(surf(np.array([a]), rim_fn(np.array([a])))[0] - c) for a in (0.0, np.pi / 2, np.pi))
    aw = 2 * np.pi * rmax * 0.93
    bh = rmax * (np.pi / 2 + 0.35)
    k = key(fac)
    ctx = dict(kind=kind, fac=fac, H=H, c=c, surf=surf, rim_fn=rim_fn, flare_fn=flare_fn, mat=mat, aw=aw, bh=bh)
    dens = min(HPXM, (PK.TW - 2 * PK.GUT - 4) / aw) / PK.PXM          # (a chart must fit the 1024 px wide texture)
    co = PK.Chart(k, f'shell_{kind}', aw, bh, dens=dens, paint=lambda cv, ch: _paint_shell(cv, ch, ctx))
    ci = PK.Chart(k, f'shellin_{kind}', aw, bh, dens=0.22, paint=lambda cv, ch: _paint_inner(cv, ch, ctx))
    cr = PK.Chart(k, f'shellrim_{kind}', aw, 0.012, dens=0.7, paint=lambda cv, ch: _paint_rim(cv, ch, ctx))
    return co, ci, cr, aw, bh


def _shell_pts(ch, ctx, A, B):
    aw, bh, c = ctx['aw'], ctx['bh'], ctx['c']
    az = np.clip(A / aw, 0, 1) * 2 * np.pi - np.pi
    TT = np.clip(B / bh, 0, 1)
    re = ctx['rim_fn'](az)
    EL = re + (np.pi / 2 - re) * (1 - (1 - TT) ** 1.3) * 0.985
    P = ctx['surf'](az, EL, ctx['flare_fn'](az, TT))
    D = P - c
    N = D / np.linalg.norm(D, axis=-1, keepdims=True)
    hr = np.hypot(D[..., 0], D[..., 2])
    return az, EL, re, P, N, hr


COVER_TILES = {'mm14_gear', 'multicam_gear', 'emr_gear', 'coyote_webbing'}
BARE = {'ranger_gear': ((0.235, 0.245, 0.205), 'ranger'), 'ssh68_paint': ((0.29, 0.31, 0.21), 'ssh68'), 'altyn_steel': ((0.30, 0.32, 0.25), 'altyn')}


def _paint_shell(cv, ch, ctx):
    sl, A, B = cv.win(ch)
    H = ctx['H']; kind = ctx['kind']; mat = ctx['mat']
    az, EL, re, P, N, hr = _shell_pts(ch, ctx, A, B)
    Rm = 0.115
    dr = (EL - re) * Rm                                  # metres above the rim (along the shell)
    s = ch.s
    rng = np.random.default_rng(abs(hash(kind)) % 2 ** 31)
    h = np.zeros(A.shape, np.float32); ao = np.ones(A.shape, np.float32); hard = np.zeros(A.shape, np.float32)
    cover = mat in COVER_TILES
    if cover:
        alb, tn = triplanar(P, N, mat, s, off=rng.uniform(0, 0.5, 3))
        # creases: low-frequency folds + a few sharper wrinkles, stronger toward the rim where the cover is tucked in
        cr = noise3(P, (0.07, 0.045), 11) * 0.00045 + np.abs(noise3(P, (0.03,), 12)) * -0.0004
        h += cr * (0.6 + 0.6 * np.exp(-dr / 0.03))
        alb = alb * (1 + 0.06 * noise3(P, (0.09,), 13))[..., None]
        if H.get('seams'):
            for a0 in (0.0, np.pi / 2, np.pi, -np.pi / 2):
                d = np.abs(_wrap(az - a0)) * hr
                on = (EL > re + np.radians(4)) & (EL < np.radians(87))
                g = (1 - _ss(0.0, 0.0022, d)) * on
                ridge = (_ss(0.0015, 0.003, d) * (1 - _ss(0.006, 0.009, d))) * on
                h += -0.0007 * g + 0.0005 * ridge
                ao *= 1 - 0.3 * g
                along = EL * Rm
                st = (np.abs(d - 0.0045) < 0.0007) & ((along * 1000 / 3.2) % 1 < 0.6) & on
                ao *= 1 - 0.28 * st; h -= 0.00015 * st
        # folded hem round the rim: rolled fabric edge, stitch line, drawstring channel
        hem = 1 - _ss(0.010, 0.0125, dr)
        h += 0.0007 * hem * np.sin(np.clip(dr / 0.0125, 0, 1) * np.pi)
        st = (np.abs(dr - 0.0095) < 0.0006) & ((az * hr * 1000 / 3.2) % 1 < 0.6)
        ao *= 1 - 0.25 * st
        ao *= 1 - 0.18 * (1 - _ss(0.0, 0.004, dr))
        if H.get('band'):
            e0, e1 = np.radians(H.get('band_el', (18, 26)))
            db = np.minimum(np.abs(EL - e0), np.abs(EL - e1)) * Rm
            ao *= 1 - 0.32 * (1 - _ss(0.0, 0.007, db)) * ((EL < e0) | (EL > e1))
            # cloth gathered under the band: short vertical folds just above and below it
            fold = np.sin(az * 31 + noise3(P, (0.05,), 14) * 2) * np.exp(-(np.minimum(np.abs(EL - e0), np.abs(EL - e1)) * Rm / 0.012) ** 2)
            h += 0.0005 * fold
        # sewn label at the back, just above the hem
        la = np.abs(_wrap(az - np.pi * 0.93)) * hr
        lab = (la < 0.017) & (dr > 0.016) & (dr < 0.032)
        alb = np.where(lab[..., None], np.array([0.33, 0.33, 0.29], np.float32) * (0.9 + 0.1 * noise3(P, (0.01,), 15))[..., None], alb)
        h += 0.0003 * lab
        # bolts of the harness pressing through the cloth
        bump = _bolts(kind, az, EL, re, hr, Rm, H)
        h += 0.0012 * bump
        # grime toward the rim, dust on top
        alb = alb * (1 - 0.12 * np.exp(-dr / 0.02) * (0.6 + 0.4 * noise3(P, (0.04,), 16)))[..., None]
    else:
        col, style = BARE.get(mat, ((0.3, 0.3, 0.28), 'bare'))
        mot = noise3(P, (0.08, 0.03), 21)
        alb = np.broadcast_to(np.asarray(col, np.float32), A.shape + (3,)).copy() * (1 + 0.05 * mot)[..., None]
        tn = np.zeros(A.shape + (3,), np.float32); tn[..., 2] = 1
        grain = ndimage.gaussian_filter(rng.standard_normal(A.shape).astype(np.float32), 0.8)
        h += 0.00006 * grain
        # edge wear along the rim
        wearn = noise3(P, (0.02, 0.008), 22)
        edge = np.exp(-dr / 0.007)
        if style == 'ssh68':
            chip = (wearn + 1.6 * edge > 1.25) | (noise3(P, (0.012, 0.006), 23) > 1.55)
            alb = np.where(chip[..., None], np.array([0.12, 0.12, 0.11], np.float32), alb)
            h -= 0.0003 * chip
            hard = np.maximum(hard, chip.astype(np.float32))
        else:
            sc = np.clip(edge * (0.6 + 0.6 * wearn), 0, 1)
            alb = alb * (1 + 0.35 * sc)[..., None] if style == 'ranger' else alb * (1 - 0.3 * sc)[..., None]
        # scratches: short random arcs
        for _ in range(14 if style != 'ssh68' else 22):
            a0 = rng.uniform(-np.pi, np.pi); e0 = rng.uniform(0.0, 1.0)
            L = rng.uniform(0.01, 0.05); ang = rng.uniform(0, np.pi)
            x0 = a0 * Rm; y0 = e0 * Rm
            u = az * Rm - x0; v = EL * Rm - y0
            t = u * np.cos(ang) + v * np.sin(ang); q = -u * np.sin(ang) + v * np.cos(ang)
            m_ = (np.abs(q) < 0.0004) & (t > 0) & (t < L)
            alb = np.where(m_[..., None], alb * 1.35 if style != 'ssh68' else np.array([0.2, 0.2, 0.19], np.float32), alb)
            h -= 0.0001 * m_
        bump = _bolts(kind, az, EL, re, hr, Rm, H)
        bolt = bump > 0.05
        alb = np.where(bolt[..., None], np.array([0.11, 0.11, 0.105], np.float32) * (0.8 + 0.4 * bump[..., None]), alb)
        h += 0.0018 * bump; hard = np.maximum(hard, bolt.astype(np.float32))
        if H.get('velcro_paint'):
            for (a0, a1, e0, e1) in H['velcro_paint']:
                for sgn in ((1, -1) if a0 > 0 else (1,)):
                    aa = az * sgn
                    m_ = (aa > a0) & (aa < a1) & (EL > e0) & (EL < e1)
                    m_ = ndimage.gaussian_filter(m_.astype(np.float32), 0.6)
                    nz = ndimage.gaussian_filter(rng.standard_normal(A.shape).astype(np.float32), 0.7)
                    alb = alb * (1 - m_ * (0.32 + 0.06 * nz))[..., None] + np.array([0.20, 0.205, 0.17], np.float32) * (m_ * 0.25)[..., None]
                    h += m_ * (0.0011 + 0.0002 * nz)
                    inner = ndimage.binary_erosion(m_ > 0.5, iterations=max(int(0.004 * s), 1))
                    ao *= 1 - 0.25 * ((m_ > 0.5) & ~inner)
                    tn = tn * (1 - m_[..., None]) + np.array([0, 0, 1.0]) * m_[..., None]
    cv.alb[sl] = alb; cv.tn[sl] = tn; cv.h[sl] = h; cv.ao[sl] = ao; cv.hard[sl] = hard


def _bolts(kind, az, EL, re, hr, Rm, H):
    """domed bolt heads of the harness (4 per shell) / SSh-68 liner rivets: soft disc 0..1"""
    if kind == 'ssh68':
        spots = [(np.pi / 2, 0.016), (-np.pi / 2, 0.016), (np.pi, 0.02)]
    elif kind in ('altyn',):
        spots = [(np.radians(60), 0.02), (-np.radians(60), 0.02), (np.radians(125), 0.02), (-np.radians(125), 0.02)]
    else:
        spots = [(np.radians(62), 0.014), (-np.radians(62), 0.014), (np.radians(120), 0.014), (-np.radians(120), 0.014)]
    out = np.zeros(az.shape, np.float32)
    for a0, d0 in spots:
        u = _wrap(az - a0) * hr; v = (EL - re) * Rm - d0
        r = np.hypot(u, v)
        out = np.maximum(out, np.clip(1 - (r / 0.0055) ** 2, 0, 1) ** 0.5)
    return out


def _paint_inner(cv, ch, ctx):
    sl, A, B = cv.win(ch)
    nz = ndimage.gaussian_filter(cv.rng.standard_normal(A.shape).astype(np.float32), 1.0)
    cv.alb[sl] = np.array([0.10, 0.10, 0.095], np.float32) * (1 + 0.15 * nz)[..., None]
    cv.tn[sl] = [0, 0, 1.0]; cv.h[sl] = 0; cv.ao[sl] = 0.8; cv.hard[sl] = 1


def _paint_rim(cv, ch, ctx):
    sl, A, B = cv.win(ch)
    cover = ctx['mat'] in COVER_TILES
    if cover:
        az = np.clip(A / ctx['aw'], 0, 1) * 2 * np.pi - np.pi
        P = ctx['surf'](az, ctx['rim_fn'](az), 0.0)
        alb, _ = triplanar(P, np.broadcast_to(np.array([0, -1.0, 0]), P.shape), ctx['mat'], ch.s)
        cv.alb[sl] = alb * 0.72
    else:
        cv.alb[sl] = np.array([0.075, 0.075, 0.07], np.float32)
    cv.tn[sl] = [0, 0, 1.0]; cv.h[sl] = 0; cv.ao[sl] = 1; cv.hard[sl] = 1


def chart_ab_uv(p):
    """uv for parts carrying p['chart_ab'] = [(chart, vertex index array, (n, 2) a/b in metres)]"""
    uv = np.zeros((len(p['pos']), 2))
    for c, vi, ab in p.pop('chart_ab'):
        PK._layout(c.fac)
        a = np.clip(ab[:, 0], 0, c.aw); b = np.clip(ab[:, 1], 0, c.bh)
        uv[vi, 0] = (c.ox + PK.GUT + a * c.s) / PK.TW
        uv[vi, 1] = (c.oy + PK.GUT + b * c.s) / c.TH
    p['uv'] = uv
    return p


# ------------------------------------------------------------------------------------------------ texture
def texture(fac):
    """(albedo sRGB float, normal 0..1) of hg_<fac> (helmet shells + comms charts)"""
    k = key(fac)
    if k in _TEX:
        return _TEX[k]
    import assemble as AS
    a, n = AS._tile('multicam' if fac == 'ua' else 'emr')
    cv = PK.Canvas(k, a, n)
    for c in cv.ch:
        cv.fill(c)
        if c.paint is not None:
            c.paint(cv, c)
    nrm = np.zeros_like(cv.tn); nrm[..., 2] = 1
    import tex as TX
    for c in cv.ch:
        sl, _, _ = cv.win(c)
        hh = cv.h[sl] * c.s
        nd = TX.height_to_normal(hh, 1.6) * 2 - 1
        hb = ndimage.gaussian_filter(cv.h[sl], 3.0 * c.s / PK.PXM)
        cav = np.clip(1 - 260 * np.maximum(hb - cv.h[sl], 0), 0.6, 1)
        cv.ao[sl] *= cav
        tn = cv.tn[sl] * (1 - cv.hard[sl][..., None]) + np.array([0, 0, 1.0]) * cv.hard[sl][..., None]
        nn = np.stack([tn[..., 0] + nd[..., 0], tn[..., 1] + nd[..., 1], np.maximum(tn[..., 2], 0.3) * nd[..., 2]], -1)
        nrm[sl] = nn / np.linalg.norm(nn, axis=-1, keepdims=True)
    alb = np.clip(cv.alb * cv.ao[..., None], 0, 1)
    _TEX[k] = (alb, nrm * 0.5 + 0.5)
    return _TEX[k]


# ------------------------------------------------------------------------------------------------ retention harness
RETENTION = {   # kind -> style
    'fast_hc': 'dial', 'fast_mc': 'dial', 'fast': 'dial', 'mich': 'dial', '6b47': 'dial', '6b47_goggles': 'dial', 'pasgt_mc': 'dial',
    'pasgt': 'four', '6b7': 'four', 'altyn': 'four', 'ssh68': 'two'}


class Skin:
    """outer skin of one head mesh: projection along rays from the head centre, inside test"""
    def __init__(self, pos, tri, c):
        from mathutils.bvhtree import BVHTree
        self.c = np.asarray(c, float)
        self.pos = pos
        self.tree = BVHTree.FromPolygons([tuple(v) for v in pos], [tuple(map(int, t)) for t in tri], all_triangles=True)

    def radial(self, p):
        """outermost surface point + normal along the ray from c through p"""
        d = p - self.c; d = d / np.linalg.norm(d)
        o = self.c + d * 0.3
        h = self.tree.ray_cast(Vector(o), Vector(-d), 0.3)
        if h[0] is None:
            return None, None
        return np.array(h[0]), np.array(h[1])

    def depth(self, p):
        """signed distance (+ outside) to the skin, nearest-point based"""
        h = self.tree.find_nearest(Vector(p))
        q, n = np.array(h[0]), np.array(h[1])
        return float((p - q) @ n)


def _strap(skin, guides, w, off=0.0025, th=0.0018, step=0.011, mat='harness_ua', free_start=None):
    """flat strap over the skin through guide points (each projected radially onto the skin).  free_start: a point inside the
    helmet rim where the strap starts (straight run to the first skin contact, never below the skin)"""
    G_ = np.asarray(guides, float)
    seg = np.linalg.norm(np.diff(G_, axis=0), axis=1)
    L = np.r_[0, np.cumsum(seg)]
    n = max(int(L[-1] / step), 2)
    S = np.linspace(0, L[-1], n + 1)
    pts = np.stack([np.interp(S, L, G_[:, i]) for i in range(3)], 1)
    C, Nn = [], []
    for p in pts:
        q, nrm = skin.radial(p)
        if q is None:
            q = p; nrm = (p - skin.c) / np.linalg.norm(p - skin.c)
        if nrm @ (q - skin.c) < 0:
            nrm = -nrm
        C.append(q + nrm * (off + th / 2)); Nn.append(nrm)
    C = np.array(C); Nn = np.array(Nn)
    if free_start is not None:
        fs = np.asarray(free_start, float)
        m = 3
        lead = np.array([fs + (C[0] - fs) * u for u in np.linspace(0, 1, m + 1)[:-1]])
        ln = np.array([(Nn[0] + (fs - skin.c) / np.linalg.norm(fs - skin.c) * (1 - u)) for u in np.linspace(0, 1, m + 1)[:-1]])
        # never below the skin + offset
        for i in range(len(lead)):
            q, nrm = skin.radial(lead[i])
            if q is not None and np.linalg.norm(lead[i] - skin.c) < np.linalg.norm(q - skin.c) + off + th:
                lead[i] = q + nrm * (off + th)
        C = np.concatenate([lead, C]); Nn = np.concatenate([ln, Nn])
    for _ in range(2):
        C[1:-1] = 0.5 * C[1:-1] + 0.25 * (C[:-2] + C[2:])
        Nn[1:-1] = 0.5 * Nn[1:-1] + 0.25 * (Nn[:-2] + Nn[2:])
    Nn /= np.linalg.norm(Nn, axis=1, keepdims=True)
    T = np.gradient(C, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
    Sd = np.cross(T, Nn); Sd /= np.linalg.norm(Sd, axis=1, keepdims=True)
    Nn = np.cross(Sd, T)
    # both edges re-projected (a strap over the curved cheek / jaw must not cut in at its edges)
    E = []
    for sgn in (-1, 1):
        e = C + Sd * sgn * w / 2
        for i in range(len(e)):
            q, nrm = skin.radial(e[i])
            if q is not None:
                if nrm @ (q - skin.c) < 0:
                    nrm = -nrm
                lim = q + nrm * (off * 0.8 + th / 2)
                if np.linalg.norm(e[i] - skin.c) < np.linalg.norm(lim - skin.c):
                    e[i] = lim
        E.append(e)
    Lb, Rb = E
    V = np.concatenate([Lb - Nn * th / 2, Rb - Nn * th / 2, Lb + Nn * th / 2, Rb + Nn * th / 2])
    m_ = len(C); tri = []
    for i in range(m_ - 1):
        a, b = i, i + 1
        tri += [[2 * m_ + a, 3 * m_ + b, 2 * m_ + b], [2 * m_ + a, 3 * m_ + a, 3 * m_ + b]]      # outer face
        tri += [[a, b, m_ + b], [a, m_ + b, m_ + a]]                                            # inner face
    p = G.part(V, np.array(tri), mat, np.zeros((len(V), 2)))
    nrm = np.concatenate([-Nn, -Nn, Nn, Nn]); p['nrm'] = nrm
    p['line'] = (C, T, Nn, Sd)
    return p


def _hw(M, w, h, d, mat, r=0.0015):
    return PO.local_part(PO.rbox(w, h, d, r, 1), M, mat, 'hard')


def _ear(skin, sgn, c):
    """ear centre / bottom of this head (cluster of the outermost side points at ear height)"""
    P = skin.pos
    m = (sgn * P[:, 0] > 0.06) & (P[:, 1] > c[1] - 0.11) & (P[:, 1] < c[1] + 0.005) & (P[:, 2] > c[2] - 0.07) & (P[:, 2] < c[2] + 0.03)
    Q = P[m]
    thr = np.percentile(sgn * Q[:, 0], 85)
    E = Q[sgn * Q[:, 0] >= thr]
    return E.mean(0), E[:, 1].min(), E[:, 1].max(), E[:, 2].min(), E[:, 2].max()


def retention(ctx, skin, lm, fac, log=None):
    """4-point harness (or 2-point leather strap) for one helmet on one head: list of parts (group set by the caller)"""
    kind, on, rim_fn, H = ctx['kind'], ctx['on'], ctx['rim_fn'], ctx['H']
    style = RETENTION.get(kind, 'four')
    c = skin.c
    mat = 'harness_leather' if style == 'two' else ('harness_ua' if fac == 'ua' else 'harness_ru')
    hard = 'gear_hardware'
    out = []
    jaw = np.asarray(lm['jaw'], float)
    for sgn in (1, -1):
        E, ylo, yhi, zlo, zhi = _ear(skin, sgn, c)
        az_f, az_b = np.radians(64), np.radians(118)
        fa = np.asarray(on(np.array(sgn * az_f), rim_fn(np.array(sgn * az_f)) + np.radians(2.0), -0.008)[0]).reshape(3)
        ra = np.asarray(on(np.array(sgn * az_b), rim_fn(np.array(sgn * az_b)) + np.radians(2.0), -0.008)[0]).reshape(3)
        J = np.array([E[0] - sgn * 0.004, ylo - 0.014, zhi + 0.012])                       # junction: below / in front of the lobe
        temple = np.array([E[0], yhi - 0.004, zhi + 0.016])
        g_front = [temple, (temple + J) / 2 + [0, 0, 0.004], J]
        if style != 'two':
            out.append(_strap(skin, g_front, 0.016, mat=mat, free_start=fa))
            behind = np.array([E[0] - sgn * 0.004, (ylo + yhi) / 2, zlo - 0.014])
            under = np.array([E[0] - sgn * 0.006, ylo - 0.016, (zlo + zhi) / 2 - 0.004])
            out.append(_strap(skin, [behind, under, J], 0.016, mat=mat, free_start=ra))
        else:
            out.append(_strap(skin, g_front, 0.018, mat=mat, free_start=(fa + ra) / 2, th=0.0025))
        # chin strap: junction -> along the jaw -> chin cup
        jc = np.array([sgn * 0.045, jaw[1] + 0.006, jaw[2] - 0.05])
        cup = np.array([sgn * 0.012, jaw[1] - 0.004, jaw[2] - 0.022])
        ch = _strap(skin, [J, (J + jc) / 2 + [0, -0.004, 0], jc, cup], 0.018 if style != 'two' else 0.02, mat=mat,
                    th=0.0018 if style != 'two' else 0.0025)
        out.append(ch)
        Cl, Tn, Nn, Sd = ch['line']
        # tri-glide at the junction, side-release buckle on the left chin strap (leather: steel buckle on the right)
        Mj = PO.mat4(Cl[0] + Nn[0] * 0.0015, Sd[0], Tn[0], Nn[0])
        out.append(_hw(Mj, 0.022, 0.014, 0.004, hard))
        if (sgn > 0) == (style != 'two'):
            i = len(Cl) // 3
            Mb = PO.mat4(Cl[i] + Nn[i] * 0.003, Sd[i], Tn[i], Nn[i])
            out.append(_hw(Mb, 0.024, 0.036, 0.007, hard, 0.002))
            out.append(_hw(Mb @ PO.T(0, 0.004, 0.0035), 0.016, 0.01, 0.003, hard, 0.001))
    # chin cup (padded, black) under the chin tip
    cp = np.array([0.0, jaw[1] - 0.006, jaw[2] - 0.016])
    q, nrm = skin.radial(cp)
    if q is not None:
        if nrm @ (q - c) < 0:
            nrm = -nrm
        up = np.array([0, 0, 1.0]) - nrm * nrm[2]; up /= np.linalg.norm(up)
        Mc = PO.mat4(q + nrm * 0.006, np.cross(up, nrm), up, nrm)
        if style != 'two':
            out.append(PO.local_part(PO.rbox(0.05, 0.034, 0.008, 0.010, 1), Mc, 'harness_pad', 'hard'))
    # nape cradle + pad with a ratchet dial (modern harnesses) / nape strap (4-point)
    if style in ('dial', 'four'):
        ys = c[1] - 0.06
        nape = []
        for sgn in (1, -1):
            ra = np.asarray(on(np.array(sgn * np.radians(132)), rim_fn(np.array(sgn * np.radians(132))) + np.radians(2.0), -0.008)[0]).reshape(3)
            g = [np.array([sgn * 0.055, ys + 0.004, c[2] - 0.075]), np.array([sgn * 0.02, ys, c[2] - 0.098])]
            nape.append(_strap(skin, g, 0.018, mat=mat, free_start=ra))
        out += nape
        bp = np.array([0.0, ys, c[2] - 0.11])
        q, nrm = skin.radial(bp)
        if q is not None:
            if nrm @ (q - c) < 0:
                nrm = -nrm
            up = np.array([0, 1.0, 0]) - nrm * nrm[1]; up /= np.linalg.norm(up)
            Mp = PO.mat4(q + nrm * 0.0075, np.cross(up, nrm), up, nrm)
            out.append(PO.local_part(PO.rbox(0.078, 0.036, 0.011, 0.008, 1), Mp, 'harness_pad', 'hard'))
            if style == 'dial':
                Rx = np.eye(4); Rx[:3, :3] = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
                out.append(PO.local_part(PO.cyl(0.0145, 0.0085, 12, 0.0135), Mp @ PO.T(0, 0.002, 0.0055) @ Rx, hard, 'hard'))
                out.append(PO.local_part(PO.cyl(0.006, 0.0035, 6), Mp @ PO.T(0, 0.002, 0.0135) @ Rx, 'medic_red' if fac == 'ua' else hard, 'hard'))
    for p in out:
        p.pop('line', None)
    if log:
        bad = 0; tot = 0
        for p in out:
            for v in p['pos'][::2]:
                tot += 1
                if skin.depth(v) < -0.0005:
                    bad += 1
        log(f'retention {kind}: {sum(len(p["tri"]) for p in out)} tris, {bad}/{tot} sampled vertices under the skin')
    return out


# ------------------------------------------------------------------------------------------------ scrim
def scrim(on, H, c, rim_fn, n=15, seed=5):
    """burlap strips tucked under the band, lying on the shell down to the rim and hanging 1-2 cm below it (not over the ears,
    not in front of the face)"""
    rng = np.random.default_rng(seed)
    out = []
    e0, e1 = np.radians(H.get('band_el', (18, 26)))
    azs = [a for a in np.radians(rng.uniform(-180, 180, 60)) if np.radians(35) < abs(a) < np.radians(62) or abs(a) > np.radians(128)][:n]
    for k, a in enumerate(azs):
        w = rng.uniform(0.008, 0.016)
        a_ = a + rng.uniform(-0.03, 0.03)
        re = float(rim_fn(np.array(a_)))
        els = np.linspace(e0 + np.radians(2), re + np.radians(1.5), 4)
        P, Nn = [], []
        for j, el in enumerate(els):
            p_, n_ = on(np.array(a_), np.array(el), 0.0045 + 0.0008 * j)
            P.append(np.asarray(p_).reshape(3)); Nn.append(np.asarray(n_).reshape(3))
        hang = rng.uniform(0.010, 0.022)
        for j in (1, 2):
            P.append(P[3] + np.array([0, -1.0, 0]) * hang * j / 2 + Nn[3] * 0.003 * j); Nn.append(Nn[3])
        P = np.array(P); Nn = np.array(Nn)
        T = np.gradient(P, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
        S = np.cross(T, Nn); S /= np.linalg.norm(S, axis=1, keepdims=True)
        V = np.concatenate([P - S * w / 2, P + S * w / 2])
        m_ = len(P)
        tri = []
        for i in range(m_ - 1):
            tri += [[i, i + 1, m_ + i + 1], [i, m_ + i + 1, m_ + i]]
        out.append(G.part(V, np.array(tri), 'scrim_tan' if k % 3 else 'scrim_green', np.zeros((len(V), 2))))
    return out
