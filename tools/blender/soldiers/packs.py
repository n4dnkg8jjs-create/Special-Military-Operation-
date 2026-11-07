"""soldiers_v9 packs: rucksack ('backpack') and assault pack ('backpack_assault') with painted detail.

Geometry (modest): pack body + front pocket (bevelled boxes), side-release buckles, compression-strap bridges, grab handle, rolled
foam sleeping mat under the pack (karimat, two straps, rolled-up ends), MPL-50 entrenching tool on the RU rucksack's right side,
hydration tube over the left shoulder strap and a CAT-type tourniquet on the right one (UA), radio / grenade pouch on the
assault packs, padded shoulder straps (kit.shoulder_strap).

Detail that would cost triangles is painted instead: the pack bodies / pockets / mat ends use one textured material per faction
(`pack_ua` / `pack_ru`): every face of a box gets its own chart (box projection in the box's own frame, front / sides / top at
PXM texels per metre, the face against the back and the bottom at lower density), painted with the faction's gear camo (same
tile as the per-part gear) plus a height field (zippers with slider + pull, PALS webbing rows with bar tacks, laser-cut MOLLE
slots, bound edges, panel seams with stitching, velcro ID field (bare: no flag patch since models_v11), flat compression straps, drain grommets,
labels, the spiral of the rolled mat) turned into a normal map and a cavity / contact AO multiplied into the base colour.
combo.make places these charts in the preset atlas like the uniform (SRC_SCALE['pack_']), so a preset stays at 2 draw calls.

Real kit, 2023-25 photos: UA - 3-day / 1-day assault packs (M-Tac, Dozor, 5.11 Rush-type) in MultiCam with laser-cut or webbing
MOLLE, bare velcro field, side compression straps, karimat foam roll strapped under the pack, hydration tube, CAT / SICH
tourniquet on the shoulder strap. RU - Ratnik-era (6Sh117 set) raid / assault packs in EMR with webbing PALS, flap pockets
with buckled straps, MPL-50 strapped to the side, karimat roll."""
import numpy as np
from scipy import ndimage
from PIL import Image
import pouches as PO
import gear as G
import kit as K
import camo as C
import tex as TX
import meshutil as MU

PXM = 700.0       # pack texture: texels per metre (front / sides / top)
TW = 1024         # pack texture width (height from the layout)
GUT = 6           # gutter (px) around every chart
_REG = {}         # fac -> list of Chart
_TEX = {}         # fac -> (albedo, normal)

PACK_SOLIDS = {   # extra solid swatches (assemble.SOLIDS)
    'mat_foam_ua': ('#5c5f45', 0.95, 0.0), 'mat_foam_ru': ('#4b5140', 0.95, 0.0),
    'shovel_paint': ('#474b38', 0.6, 0.25), 'shovel_wood': ('#6b5034', 0.75, 0.0), 'hydro_tube': ('#2d2f2a', 0.55, 0.0),
}


class Chart:
    def __init__(self, fac, key, aw, bh, dens=1.0, paint=None):
        self.fac, self.key, self.aw, self.bh, self.dens, self.paint = fac, key, aw, bh, dens, paint
        self.s = PXM * dens
        self.wp = int(np.ceil(aw * self.s)) + 2 * GUT
        self.hp = int(np.ceil(bh * self.s)) + 2 * GUT
        self.ox = self.oy = None
        _REG.setdefault(fac, []).append(self)
        _TEX.pop(fac, None)


def _layout(fac):
    """shelf-pack the faction's charts into a TW-wide image (once)"""
    ch = _REG.get(fac, [])
    if not ch or ch[0].ox is not None and all(c.ox is not None for c in ch):
        return
    x = y = rowh = 0
    for c in sorted(ch, key=lambda c: -c.hp):
        if x + c.wp > TW:
            x = 0; y += rowh; rowh = 0
        c.ox, c.oy = x, y
        x += c.wp; rowh = max(rowh, c.hp)
    th = y + rowh
    th = int(np.ceil(th / 64) * 64)
    for c in ch:
        c.TH = th


# ------------------------------------------------------------------------------------------------ geometry helpers
def _box(fac, w, h, d, r, seg, M, mat, name, paints, taper=0.0, dens=None):
    """bevelled box (local: centred) with one chart per face.  paints: face -> painter(cv, chart, dims) or None"""
    dens = dens or {}
    p = PO.local_part(PO.rbox(w, h, d, r, seg, taper_top=taper), M, mat)
    sz = {'+z': (w, h), '-z': (w, h), '+x': (d, h), '-x': (d, h), '+y': (w, d), '-y': (w, d)}
    dd = {'+z': 1.0, '-z': 0.22, '+x': 1.0, '-x': 1.0, '+y': 0.8, '-y': 0.45}
    dd.update(dens)
    p['charts'] = {f: Chart(fac, f'{name}{f}', *sz[f], dens=dd[f], paint=paints.get(f)) for f in sz}
    p['box'] = (w, h, d, taper)
    return p


def _face_ab(f, L, w, h, d):
    x, y, z = L[:, 0], L[:, 1], L[:, 2]
    if f == '+z':
        return x + w / 2, h / 2 - y
    if f == '-z':
        return w / 2 - x, h / 2 - y
    if f == '+x':
        return d / 2 - z, h / 2 - y
    if f == '-x':
        return z + d / 2, h / 2 - y
    if f == '+y':
        return x + w / 2, d / 2 - z
    return x + w / 2, z + d / 2


def chart_uv(p):
    """box_uv replacement for parts with charts: split vertices per face, uv into the faction's pack texture"""
    L, pos, tri = p['local'], p['pos'], p['tri']
    w, h, d, _ = p['box']
    fn = np.cross(L[tri[:, 1]] - L[tri[:, 0]], L[tri[:, 2]] - L[tri[:, 0]])
    ax = np.argmax(np.abs(fn), 1)
    sg = np.sign(fn[np.arange(len(fn)), ax]) > 0
    fk = ax * 2 + sg                                    # 0:-x 1:+x 2:-y 3:+y 4:-z 5:+z
    names = ['-x', '+x', '-y', '+y', '-z', '+z']
    key = tri * 6 + fk[:, None]
    uniq, inv = np.unique(key.reshape(-1), return_inverse=True)
    src = uniq // 6; fv = uniq % 6
    uv = np.zeros((len(uniq), 2))
    ch0 = next(iter(p['charts'].values()))
    _layout(ch0.fac)
    for k in range(6):
        m = fv == k
        if not m.any():
            continue
        c = p['charts'][names[k]]
        a, b = _face_ab(names[k], L[src[m]], w, h, d)
        a = np.clip(a, 0, c.aw); b = np.clip(b, 0, c.bh)
        uv[m, 0] = (c.ox + GUT + a * c.s) / TW
        uv[m, 1] = (c.oy + GUT + b * c.s) / c.TH
    ntri = inv.reshape(-1, 3)
    q = dict(p); q.update(pos=pos[src], tri=ntri, uv=uv, nrm=MU.vertex_normals(pos[src], ntri))
    q['nrm'] = MU.weld_normals(q['pos'], q['nrm'], 1e-6)
    if 'col' in p:
        q['col'] = p['col'][src]
    for k_ in ('local', 'charts', 'box'):
        q.pop(k_, None)
    return q


def _flatbox(w, h, d):
    return PO.rbox(w, h, d, 0.0, 1)


def _buckle(M, mats):
    """side-release buckle (flat, hard edges: 12 + 12 tris)"""
    return [PO.local_part(_flatbox(0.034, 0.042, 0.009), M @ PO.T(0, 0, 0.0045), mats['hardware'], 'hard'),
            PO.local_part(_flatbox(0.026, 0.012, 0.004), M @ PO.T(0, 0.006, 0.010), mats['hardware'], 'hard')]


def _rot(axis, ang):
    c, s = np.cos(ang), np.sin(ang)
    Mr = np.eye(4)
    if axis == 'x':
        Mr[:3, :3] = [[1, 0, 0], [0, c, -s], [0, s, c]]
    elif axis == 'y':
        Mr[:3, :3] = [[c, 0, s], [0, 1, 0], [-s, 0, c]]
    else:
        Mr[:3, :3] = [[c, -s, 0], [s, c, 0], [0, 0, 1]]
    return Mr


def _ring_tube(M, r, L, n, mat, caps=None, fac=None, name=None):
    """cylinder along local x (centred), n sides; caps: 'chart' -> rolled-mat end charts (pack texture)"""
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    ring = np.stack([np.zeros(n), np.cos(a) * r, np.sin(a) * r], 1)
    P = np.concatenate([ring + [-L / 2, 0, 0], ring + [L / 2, 0, 0]])
    T = []
    for k in range(n):
        k2 = (k + 1) % n
        T += [[k, k2, n + k2], [k, n + k2, n + k]]
    side = G.part(PO.xf(P, M), np.array(T), mat)
    side['uv'] = np.stack([np.r_[a, a] / (2 * np.pi) * 0.5, np.r_[np.zeros(n), np.ones(n)] * L * 2], 1)
    out = [side]
    if caps:
        for sx in (-1, 1):
            c = Chart(fac, f'{name}_end{sx}', 2 * r, 2 * r, dens=0.9, paint=_paint_mat_end)
            Pc = np.concatenate([ring + [sx * L / 2, 0, 0], [[sx * L / 2, 0, 0]]])
            Tc = [[n, k, (k + 1) % n] if sx > 0 else [n, (k + 1) % n, k] for k in range(n)]
            q = G.part(PO.xf(Pc, M), np.array(Tc), caps)
            q['pack_end'] = (c, Pc[:, 1:] + r)          # chart, (a, b) in metres
            out.append(q)
    return out


def _sweep(path, nrm, r, n, mat):
    """tube of n sides along a polyline (path (m,3), nrm (m,3) reference up)"""
    Tn = np.gradient(path, axis=0); Tn /= np.linalg.norm(Tn, axis=1, keepdims=True)
    B = np.cross(Tn, nrm); B /= np.linalg.norm(B, axis=1, keepdims=True)
    Nn = np.cross(B, Tn)
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    P = (path[:, None, :] + r * (np.cos(a)[None, :, None] * Nn[:, None, :] + np.sin(a)[None, :, None] * B[:, None, :])).reshape(-1, 3)
    T = []
    m = len(path)
    for i in range(m - 1):
        for k in range(n):
            k2 = (k + 1) % n
            T += [[i * n + k, i * n + k2, (i + 1) * n + k2], [i * n + k, (i + 1) * n + k2, (i + 1) * n + k]]
    p = G.part(P, np.array(T), mat)
    # outward winding
    c = path.repeat(n, 0)
    if np.mean(np.sum((MU.vertex_normals(p['pos'], p['tri'])) * (P - c), 1)) < 0:
        p['tri'] = p['tri'][:, ::-1]
        p['nrm'] = MU.vertex_normals(p['pos'], p['tri'])
    return p


def _strap_line(sp):
    """centre line + outward direction of a kit.shoulder_strap part (outer middle column)"""
    nk = len(sp['pos']) // 6
    outer = sp['pos'][np.arange(nk) * 3 + 1]
    inner = sp['pos'][3 * nk + np.arange(nk) * 3 + 1]
    d = outer - inner; d /= np.linalg.norm(d, axis=1, keepdims=True)
    return outer, d


def _frame(env, y, lift):
    p = env.point(y, np.pi, lift)
    n = env.normal(y, np.pi)
    up = np.array([0, 1.0, 0]); side = np.cross(up, n)
    return PO.mat4(p, side, up, n)


def _tourniquet(mats, M):
    """CAT-type tourniquet folded in its rubber band on a strap: black windlass bundle, red tab (cheap: ~70 tris)"""
    return [PO.local_part(PO.rbox(0.042, 0.105, 0.03, 0.006, 1), M @ PO.T(0, 0, 0.015), mats['hardware'], 'hard'),
            PO.local_part(PO.rbox(0.016, 0.026, 0.026, 0.003, 1), M @ PO.T(0, 0.062, 0.014), mats['red'], 'hard'),
            PO.local_part(_flatbox(0.047, 0.016, 0.035), M @ PO.T(0, 0.012, 0.0165), mats['webbing'], 'hard')]


# ------------------------------------------------------------------------------------------------ packs
def ruck(env, mats, fac):
    """rucksack ('backpack' node): UA 3-day assault pack / RU Ratnik-type raid pack"""
    m = mats; ua = fac == 'ua'; pm = f'pack_{fac}'
    out = []
    M = _frame(env, 1.27, 0.004 + 0.022 + 0.01)
    w, h, d, tp = (0.31, 0.42, 0.18, 0.06) if ua else (0.30, 0.41, 0.17, 0.05)
    yc = 0.02
    Mb = M @ PO.T(0, yc, d / 2)
    out.append(_box(fac, w, h, d, 0.036, 2, Mb, pm, f'ruck_{fac}', {'+z': _paint_ruck_front, '+x': _paint_ruck_side, '-x': _paint_ruck_side,
                                                                     '+y': _paint_top, '-y': None, '-z': None}, taper=tp))
    # front pocket (UA: zipped, MOLLE / laser cut; RU: flap pocket with two buckled straps)
    pw, ph, pd = (0.25, 0.21, 0.05) if ua else (0.24, 0.20, 0.055)
    py = yc - h / 2 + ph / 2 + 0.035
    Mp = M @ PO.T(0, py, d + pd / 2 - 0.008)
    out.append(_box(fac, pw, ph, pd, 0.018, 2, Mp, pm, f'ruckpkt_{fac}', {'+z': _paint_pocket_ua if ua else _paint_pocket_ru,
                                                                          '+x': None, '-x': None, '+y': None}, dens={'-y': 0.3, '-x': 0.6, '+x': 0.6}))
    if not ua:
        # flap over the pocket top + two vertical straps with buckles
        out.append(_box(fac, pw + 0.008, 0.075, 0.012, 0.005, 1, M @ PO.T(0, py + ph / 2 - 0.03, d + pd - 0.004), pm, f'ruckflap_{fac}',
                        {'+z': _paint_flap}, dens={'-z': 0.15, '+x': 0.3, '-x': 0.3, '+y': 0.3, '-y': 0.3}))
        for x in (-0.075, 0.075):
            out.append(PO.local_part(_flatbox(0.025, ph * 0.75, 0.004), M @ PO.T(x, py - 0.01, d + pd - 0.006 + 0.004), m['webbing'], 'hard'))
            out += _buckle(M @ PO.T(x, py - 0.05, d + pd - 0.002), m)
    # side-release buckles on the side compression straps (straps themselves painted flat on the sides)
    for sx in (-1, 1):
        if not ua and sx > 0:
            continue                                    # RU right side: the shovel's strap bridges instead
        for yb in (yc + 0.09,):                      # (lower strap: under the side pouch)
            xs = sx * (w / 2 * (1 - tp * (yb - yc + h / 2) / h) + 0.001)
            Ms = PO.mat4(PO.xf(np.array([[xs, yb, d * 0.62]]), M)[0], M[:3, 2] * -sx, M[:3, 1], M[:3, 0] * sx)
            out += _buckle(Ms, m)
    # side pouches: 1 l water bottle pouch on the left (both), IFAK with a red cross on the right (UA; RU: the shovel)
    for sx, kind in ((-1, 'bottle'), (1, 'ifak')):
        if kind == 'ifak' and not ua:
            continue
        yb = yc - 0.19
        xs = sx * (w / 2 * (1 - tp * (yb - yc + h / 2) / h) + 0.001)
        Ms = PO.mat4(PO.xf(np.array([[xs, yb, d * 0.5]]), M)[0], M[:3, 2] * -sx, M[:3, 1], M[:3, 0] * sx)
        out += _side_pouch(Ms, m, kind)
    # top grab handle (two-segment arch)
    for k, (xh, a) in enumerate(((-0.025, 0.5), (0.025, -0.5))):
        out.append(PO.local_part(_flatbox(0.055, 0.008, 0.026), M @ PO.T(xh, yc + h / 2 + 0.012, d * 0.45) @ _rot('z', a), m['webbing'], 'hard'))
    # rolled foam mat under the pack, two straps
    rm, Lm = (0.068, 0.52) if ua else (0.064, 0.50)
    Mm = M @ PO.T(0, yc - h / 2 - rm + 0.012, d * 0.52)
    out += _ring_tube(Mm, rm, Lm, 12, 'mat_foam_ua' if ua else 'mat_foam_ru', caps=pm, fac=fac, name=f'mat_{fac}')
    for xb in (-0.16, 0.16):
        out += _ring_tube(Mm @ PO.T(xb, 0, 0), rm + 0.0035, 0.024, 12, m['webbing'])
    # shoulder straps
    straps = {}
    for sd in ('L', 'R'):
        sp = K.shoulder_strap(env, sd, m['fabric'], x0=0.115, width=0.058, gap=0.017, thick=0.013, y_front=1.30, y_back=1.40)
        straps[sd] = sp; out.append(sp)
    if ua:
        # hydration tube over the left strap, bite valve at the chest; tourniquet on the right strap
        P, D = _strap_line(straps['L'])
        P = P + D * 0.0085 + np.array([0.008, 0, 0])
        P = np.concatenate([P[:1] + (P[0] - P[1]) * 0.6, P])[::-1]
        tube = _sweep(P, np.tile([1.0, 0, 0], (len(P), 1)), 0.0048, 5, 'hydro_tube')
        out.append(tube)
        e = P[-1]; dv = (P[-1] - P[-2]); dv /= np.linalg.norm(dv)
        side = np.cross(dv, D[0]); side /= np.linalg.norm(side)
        out.append(PO.local_part(PO.cyl(0.0075, 0.03, 6), PO.mat4(e, side, dv, np.cross(side, dv)), 'hydro_tube', 'hard'))
        P, D = _strap_line(straps['R'])
        k = int(np.argmin(np.abs(P[:, 1] - 1.335) + (P[:, 2] < 0) * 9))
        up = P[min(k + 1, len(P) - 1)] - P[max(k - 1, 0)]; up /= np.linalg.norm(up)
        n = D[k] - up * (D[k] @ up); n /= np.linalg.norm(n)
        out += _tourniquet(m, PO.mat4(P[k] + n * 0.002, np.cross(up, n), up, n))
    else:
        # MPL-50 entrenching tool on the right side (his right = local +x), blade down, held under the compression straps
        out += _shovel(M, w, h, d, yc, tp, m)
    for q in out:
        q['group'] = 'backpack'
    return out


def _side_pouch(M, m, kind):
    """small pouch on a pack side (frame: x along the side, y up, z out; base at y = 0): bottle pouch (8-sided, lid flap,
    retention strap) or IFAK (soft box, red cross)"""
    out = []
    if kind == 'bottle':
        r, hh = 0.043, 0.19
        out.append(PO.local_part(PO.cyl(r, hh, 8, r * 0.94), M @ PO.T(0, 0, r + 0.002), m['fabric']))
        out.append(PO.local_part(_flatbox(r * 2.05, 0.012, r * 2.05), M @ PO.T(0, hh + 0.004, r + 0.002), m['fabric']))
        out.append(PO.local_part(_flatbox(0.022, 0.06, 0.004), M @ PO.T(0, hh - 0.03, 2 * r + 0.003), m['webbing'], 'hard'))
    else:
        w_, h_, d_ = 0.13, 0.15, 0.055
        out.append(PO.local_part(PO.rbox(w_, h_, d_, 0.014, 1), M @ PO.T(0, h_ / 2, d_ / 2 + 0.001), m['fabric']))
        out.append(PO.local_part(_flatbox(0.05, 0.016, 0.002), M @ PO.T(0, h_ * 0.55, d_ + 0.0015), m['red'], 'hard'))
        out.append(PO.local_part(_flatbox(0.016, 0.05, 0.002), M @ PO.T(0, h_ * 0.55, d_ + 0.0015), m['red'], 'hard'))
        out.append(PO.local_part(_flatbox(w_ * 0.96, 0.005, 0.004), M @ PO.T(0, h_ - 0.012, d_ + 0.001), m['hardware'], 'hard'))   # zip
    return out


def vest_tube(env, fac):
    """hydration tube from the carrier on the plate carrier's back (pouches_back) over the left vest shoulder strap to the chest"""
    m = K.RU_MATS if fac == 'ru' else K.UA_MATS
    sp = K.shoulder_strap(env, 'L', m['fabric'])                 # same call as kit.plate_carrier: its centre line
    P, D = _strap_line(sp)
    P = P + D * 0.008 + np.array([0.012, 0, 0])
    P = np.concatenate([P[:1] + (P[0] - P[1]) * 0.8, P])[::-1]
    out = [_sweep(P, np.tile([1.0, 0, 0], (len(P), 1)), 0.0045, 5, 'hydro_tube')]
    e = P[-1]; dv = P[-1] - P[-2]; dv /= np.linalg.norm(dv)
    side = np.cross(dv, D[0]); side /= np.linalg.norm(side)
    out.append(PO.local_part(PO.cyl(0.007, 0.028, 6), PO.mat4(e, side, dv, np.cross(side, dv)), 'hydro_tube', 'hard'))
    for q in out:
        q['group'] = 'pouches_back'
    return out


def _shovel(M, w, h, d, yc, tp, m):
    """MPL-50: pointed flat blade (painted steel), collar, wooden handle; flat against the pack's right side"""
    out = []
    ang = np.arctan(tp * w / 2 / h)                    # follow the tapered side
    yb = yc - 0.075                                     # blade centre
    xs = w / 2 * (1 - tp * (yb - yc + h / 2) / h)
    # frame on the side face: e1 = along pack depth (+z local), e2 = up (tilted with the side), e3 = outward (+x)
    Mside = M @ PO.T(xs, yb, d * 0.5) @ _rot('z', ang)
    poly = np.array([[-0.075, 0.09], [0.075, 0.09], [0.075, -0.035], [0.0, -0.095], [-0.075, -0.035]])   # (along depth, up)
    n = len(poly)
    top = np.stack([np.full(n, 0.0045), poly[:, 1], poly[:, 0]], 1)
    bot = top.copy(); bot[:, 0] = 0.0015
    P = np.concatenate([top, bot])
    T = [[0, k, k + 1] for k in range(1, n - 1)] + [[n, n + k + 1, n + k] for k in range(1, n - 1)]
    for k in range(n):
        k2 = (k + 1) % n
        T += [[k, n + k, n + k2], [k, n + k2, k2]]
    blade = G.orient_closed(G.part(PO.xf(P, Mside), np.array(T), 'shovel_paint'))
    out.append(blade)
    Mh = Mside @ PO.T(0.020, 0.085, 0.0)
    out.append(PO.local_part(PO.cyl(0.0175, 0.07, 6, 0.0165), Mh, 'shovel_paint', 'hard'))           # collar / socket
    out.append(PO.local_part(PO.cyl(0.0155, 0.235, 6, 0.0145), Mh @ PO.T(0, 0.068, 0), 'shovel_wood', 'hard'))
    # the two side compression straps (painted flat on the side, at box y +0.09 / -0.08) bridge over the handle and the blade
    out.append(PO.local_part(_flatbox(0.004, 0.024, 0.06), Mside @ PO.T(0.0375, 0.165, 0.0), m['webbing'], 'hard'))
    out.append(PO.local_part(_flatbox(0.003, 0.024, 0.165), Mside @ PO.T(0.0065, -0.005, 0.0), m['webbing'], 'hard'))
    return out


def assault(env, fac):
    """assault pack ('backpack_assault'): UA 1-day pack with laser-cut MOLLE, RU Ratnik-type assault pack with webbing PALS"""
    m = K.RU_MATS if fac == 'ru' else K.UA_MATS
    ua = fac == 'ua'; pm = f'pack_{fac}'
    out = []
    M = _frame(env, 1.25, 0.004 + 0.022 + 0.012)
    w, h, d, tp = 0.25, 0.30, 0.11, 0.08
    out.append(_box(fac, w, h, d, 0.026, 2, M @ PO.T(0, 0, d / 2), pm, f'apack_{fac}',
                    {'+z': _paint_assault_ua if ua else _paint_assault_ru, '+x': _paint_apack_side, '-x': _paint_apack_side, '+y': _paint_top},
                    taper=tp))
    out.append(_box(fac, w * 0.76, h * 0.40, 0.034, 0.013, 2, M @ PO.T(0, -0.05, d + 0.013), pm, f'apkt_{fac}',
                    {'+z': _paint_apocket_ua if ua else _paint_apocket_ru}, dens={'+x': 0.5, '-x': 0.5, '+y': 0.6, '-y': 0.3}))
    # grab handle + side buckles
    out.append(PO.local_part(_flatbox(0.07, 0.008, 0.024), M @ PO.T(0, h / 2 + 0.01, d * 0.45), m['webbing'], 'hard'))
    for sx in (-1, 1):
        xs = sx * (w / 2 * (1 - tp * (0.10 + h / 2) / h) + 0.001)
        Ms = PO.mat4(PO.xf(np.array([[xs, 0.10, d * 0.6]]), M)[0], M[:3, 2] * -sx, M[:3, 1], M[:3, 0] * sx)
        out += _buckle(Ms, m)
    # grenade pouch + radio (whip antenna) on the sides
    out += PO.grenade_pouch(m, M @ PO.T(-0.135, -0.06, 0.03) @ _roty(-70))
    out += PO.radio_pouch(m, M @ PO.T(0.135, -0.05, 0.03) @ _roty(70), antenna=0.25)
    for q in out:
        q['group'] = 'backpack_assault'
    return out


def _roty(deg):
    return _rot('y', np.radians(deg))


# ------------------------------------------------------------------------------------------------ painting
class Canvas:
    def __init__(self, fac, fab, fab_n):
        _layout(fac)
        self.fac = fac; self.ch = _REG[fac]
        TH = self.ch[0].TH
        self.alb = np.zeros((TH, TW, 3), np.float32); self.h = np.zeros((TH, TW), np.float32)
        self.ao = np.ones((TH, TW), np.float32); self.hard = np.zeros((TH, TW), np.float32)
        self.tn = np.zeros((TH, TW, 3), np.float32); self.tn[..., 2] = 1
        self.fab, self.fab_n = fab, fab_n * 2 - 1
        self.rng = np.random.default_rng(31 if fac == 'ua' else 37)
        self._rs = {}
        self.web = C.hexc(C.COYOTE) if fac == 'ua' else None

    def tile_at(self, s):
        """camo + weave tile resampled to s px/m (0.5 m repeat)"""
        k = int(round(0.5 * s))
        if k not in self._rs:
            a8 = (np.clip(self.fab, 0, 1) * 255 + 0.5).astype(np.uint8)
            a = np.asarray(Image.fromarray(a8).resize((k, k), Image.LANCZOS)).astype(np.float32) / 255
            n = np.stack([np.asarray(Image.fromarray(np.ascontiguousarray(self.fab_n[..., i], np.float32)).resize((k, k), Image.BILINEAR)) for i in range(3)], -1)
            self._rs[k] = (a, n)
        return self._rs[k]

    def win(self, c):
        sl = (slice(c.oy, c.oy + c.hp), slice(c.ox, c.ox + c.wp))
        A, B = np.meshgrid((np.arange(c.wp) - GUT + 0.5) / c.s, (np.arange(c.hp) - GUT + 0.5) / c.s)
        return sl, A, B

    def fill(self, c):
        sl, A, B = self.win(c)
        a, n = self.tile_at(c.s)
        k = a.shape[0]
        o = self.rng.uniform(0, 0.5, 2)
        xi = (((A + o[0]) * c.s).astype(int)) % k; yi = (((B + o[1]) * c.s).astype(int)) % k
        self.alb[sl] = a[yi, xi]; self.tn[sl] = n[yi, xi]
        self.h[sl] = 0; self.ao[sl] = 1; self.hard[sl] = 0


def _ss(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def _rect(A, B, a0, b0, a1, b1, soft=0.0015):
    return _ss(a0 - soft, a0 + soft, A) * (1 - _ss(a1 - soft, a1 + soft, A)) * _ss(b0 - soft, b0 + soft, B) * (1 - _ss(b1 - soft, b1 + soft, B))


def _poly_dist(A, B, pts):
    """distance to a polyline + arc-length parameter of the closest point"""
    pts = np.asarray(pts, float)
    best = np.full(A.shape, 1e9); par = np.zeros(A.shape); s0 = 0.0
    for p0, p1 in zip(pts[:-1], pts[1:]):
        v = p1 - p0; L = np.linalg.norm(v) + 1e-12
        t = np.clip(((A - p0[0]) * v[0] + (B - p0[1]) * v[1]) / (L * L), 0, 1)
        dd = np.hypot(A - p0[0] - t * v[0], B - p0[1] - t * v[1])
        m = dd < best
        best[m] = dd[m]; par[m] = s0 + t[m] * L
        s0 += L
    return best, par


def _mix(cv, sl, m, col, amt=1.0):
    m = (m * amt)[..., None]
    cv.alb[sl] = cv.alb[sl] * (1 - m) + np.asarray(col, np.float32) * m


def binding(cv, c, inset=0.0, wid=0.009):
    """bound edge round the face (binding tape over the seam) - raised, slightly darker"""
    sl, A, B = cv.win(c)
    dd = np.minimum.reduce([A - inset, c.aw - inset - A, B - inset, c.bh - inset - B])
    m = _ss(-0.002, 0.0, dd) * (1 - _ss(wid - 0.0015, wid, dd))
    cv.h[sl] += m * 0.0012 * (0.6 + 0.4 * np.sin(np.clip(dd / wid, 0, 1) * np.pi))
    cv.alb[sl] *= (1 - 0.12 * m)[..., None]
    st = np.abs(dd - wid * 0.55) < 0.0007
    cv.ao[sl] *= 1 - 0.18 * st * (np.sin(A * 1400 + B * 1400) > -0.2)


def seam(cv, c, pts, groove=0.0008, stitch=True):
    sl, A, B = cv.win(c)
    dd, s = _poly_dist(A, B, pts)
    g = 1 - _ss(0.0, 0.0025, dd)
    cv.h[sl] -= g * groove
    cv.ao[sl] *= 1 - 0.25 * g
    if stitch:
        for off in (0.004, -0.004):
            st = (np.abs(dd - 0.004) < 0.0008) & ((s * 1000 / 4.0) % 1 < 0.65)
            cv.ao[sl] *= 1 - 0.22 * st
            cv.h[sl] -= st * 0.0002
            break


def zipper(cv, c, pts, slider_at=None, coil=(0.13, 0.12, 0.11)):
    """coil zipper: tapes either side, dark coil with teeth, slider + pull tab"""
    sl, A, B = cv.win(c)
    dd, s = _poly_dist(A, B, pts)
    tape = 1 - _ss(0.0045, 0.0060, dd)
    cv.alb[sl] *= (1 - 0.18 * tape)[..., None]
    cv.h[sl] += tape * 0.0005
    cm = 1 - _ss(0.0016, 0.0024, dd)
    teeth = 0.5 + 0.5 * np.cos(s * 2 * np.pi / 0.0032)
    _mix(cv, sl, cm, coil, 0.9)
    cv.h[sl] += cm * (0.0009 + 0.0004 * teeth)
    cv.ao[sl] *= 1 - 0.3 * ((dd > 0.0022) & (dd < 0.0035))
    cv.hard[sl] = np.maximum(cv.hard[sl], cm)
    if slider_at is not None:
        pts = np.asarray(pts, float)
        L = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
        for sa in np.atleast_1d(slider_at):
            sp = sa * L[-1]
            i = min(np.searchsorted(L, sp) - 1, len(pts) - 2); i = max(i, 0)
            t = (sp - L[i]) / max(L[i + 1] - L[i], 1e-9)
            p = pts[i] + (pts[i + 1] - pts[i]) * t
            v = (pts[i + 1] - pts[i]); v /= np.linalg.norm(v)
            nrm = np.array([-v[1], v[0]])
            u = (A - p[0]) * v[0] + (B - p[1]) * v[1]; q = (A - p[0]) * nrm[0] + (B - p[1]) * nrm[1]
            body = _rect(u, q, -0.011, -0.0055, 0.011, 0.0055, 0.0008)
            _mix(cv, sl, body, (0.10, 0.10, 0.095))
            cv.h[sl] += body * 0.0025 * (1 - 0.3 * np.abs(q) / 0.0055)
            cv.hard[sl] = np.maximum(cv.hard[sl], body)
            # pull cord loop hanging down from the slider
            pd = np.hypot(A - p[0], np.maximum(B - p[1] - 0.006, 0) * 0.5 + 0 * A)
            cord = (np.abs(A - p[0]) < 0.0024) & (B > p[1] + 0.004) & (B < p[1] + 0.034)
            _mix(cv, sl, cord, (0.09, 0.09, 0.085))
            cv.h[sl] += cord * 0.0018
            tab = _rect(A, B, p[0] - 0.005, p[1] + 0.03, p[0] + 0.005, p[1] + 0.045, 0.001)
            _mix(cv, sl, tab, (0.12, 0.12, 0.11)); cv.h[sl] += tab * 0.003; cv.hard[sl] = np.maximum(cv.hard[sl], tab)
            cv.ao[sl] *= 1 - 0.35 * _rect(A, B, p[0] - 0.006, p[1] + 0.034, p[0] + 0.007, p[1] + 0.05, 0.002) * (1 - tab)


def webbing_rows(cv, c, a0, a1, b0, rows, pitch=0.05, hgt=0.025, tack=0.038, col=None, printed=0.82):
    """PALS: 1-inch webbing rows sewn at bar tacks every 1.5 inch, slightly bulging between them"""
    sl, A, B = cv.win(c)
    for r in range(rows):
        bt = b0 + r * pitch
        m = _rect(A, B, a0, bt, a1, bt + hgt, 0.0008)
        if col is None:
            cv.alb[sl] *= (1 - (1 - printed) * m)[..., None]
        else:
            _mix(cv, sl, m, col, 0.9)
        ph = ((A - a0) / tack) % 1
        bulge = np.sin(ph * np.pi) ** 0.6
        cv.h[sl] += m * (0.0010 + 0.0012 * bulge)
        tk = m * (np.minimum(ph, 1 - ph) * tack < 0.0018)
        cv.ao[sl] *= 1 - 0.32 * tk
        cv.h[sl] -= tk * 0.0006
        edge = _rect(A, B, a0 - 0.002, bt + hgt, a1 + 0.002, bt + hgt + 0.003, 0.0008)
        cv.ao[sl] *= 1 - 0.28 * edge
        edge2 = _rect(A, B, a0 - 0.002, bt - 0.0015, a1 + 0.002, bt, 0.0006)
        cv.ao[sl] *= 1 - 0.15 * edge2


def laser_molle(cv, c, a0, a1, b0, rows, pitch=0.038, slot=(0.028, 0.0055), step=0.038):
    """laser-cut MOLLE panel: rows of slots through a laminated panel (dark, recessed), panel slightly raised"""
    sl, A, B = cv.win(c)
    panel = _rect(A, B, a0 - 0.008, b0 - 0.01, a1 + 0.008, b0 + rows * pitch, 0.002)
    cv.h[sl] += panel * 0.0012
    cv.alb[sl] *= (1 - 0.05 * panel)[..., None]
    n = int((a1 - a0) / step)
    ac = (a0 + a1) / 2
    for r in range(rows):
        bc = b0 + r * pitch + slot[1] / 2
        for k in range(n):
            x = ac + (k - (n - 1) / 2) * step
            m = _rect(A, B, x - slot[0] / 2, bc - slot[1] / 2, x + slot[0] / 2, bc + slot[1] / 2, 0.0007)
            cv.alb[sl] *= (1 - 0.72 * m)[..., None]
            cv.h[sl] -= m * 0.0016
            cv.ao[sl] *= 1 - 0.25 * m


def strap_flat(cv, c, pts, wid=0.025, col=None, amt=0.9):
    """flat webbing strap sewn / lying on the face"""
    sl, A, B = cv.win(c)
    dd, s = _poly_dist(A, B, pts)
    m = 1 - _ss(wid / 2 - 0.0008, wid / 2 + 0.0008, dd)
    if col is None:
        cv.alb[sl] *= (1 - 0.2 * m)[..., None]
    else:
        _mix(cv, sl, m, col, amt)
    cv.h[sl] += m * 0.0018
    sh = (dd > wid / 2) & (dd < wid / 2 + 0.003)
    cv.ao[sl] *= 1 - 0.25 * sh
    st = np.abs(dd - (wid / 2 - 0.0025)) < 0.0006
    cv.ao[sl] *= 1 - 0.15 * st * m


def velcro(cv, c, a0, b0, a1, b1, flag=None):
    sl, A, B = cv.win(c)
    m = _rect(A, B, a0, b0, a1, b1, 0.0008)
    nz = cv.rng.standard_normal(A.shape).astype(np.float32)
    nz = ndimage.gaussian_filter(nz, 0.7)
    cv.alb[sl] *= (1 - m * (0.22 + 0.05 * nz))[..., None]
    cv.h[sl] += m * (0.0012 + 0.00025 * nz)
    bd = m * (1 - _rect(A, B, a0 + 0.004, b0 + 0.004, a1 - 0.004, b1 - 0.004, 0.0006))
    cv.h[sl] += bd * 0.0005
    if flag is not None:
        w_, h_ = 0.075, 0.05
        fa, fb = (a0 + a1) / 2 - w_ / 2, (b0 + b1) / 2 - h_ / 2
        f = _rect(A, B, fa, fb, fa + w_, fb + h_, 0.0007)
        top = B < fb + h_ / 2
        cols = np.where(top[..., None], np.asarray(flag[0], np.float32), np.asarray(flag[1], np.float32))
        mm = f[..., None]
        cv.alb[sl] = cv.alb[sl] * (1 - mm) + cols * mm
        cv.h[sl] += f * 0.0012
        bd = f * (1 - _rect(A, B, fa + 0.0025, fb + 0.0025, fa + w_ - 0.0025, fb + h_ - 0.0025, 0.0005))
        _mix(cv, sl, bd, (0.16, 0.16, 0.14), 0.8)
        cv.hard[sl] = np.maximum(cv.hard[sl], f * 0.7)


def grommet(cv, c, a, b, r=0.005):
    sl, A, B = cv.win(c)
    d = np.hypot(A - a, B - b)
    ring = (d < r) & (d > r * 0.55)
    hole = d <= r * 0.55
    _mix(cv, sl, ring, (0.2, 0.2, 0.19)); _mix(cv, sl, hole, (0.04, 0.04, 0.04))
    cv.h[sl] += ring * 0.0008 - hole * 0.001
    cv.hard[sl] = np.maximum(cv.hard[sl], ring | hole)


def label(cv, c, a0, b0, a1, b1, col=(0.11, 0.11, 0.1)):
    sl, A, B = cv.win(c)
    m = _rect(A, B, a0, b0, a1, b1, 0.0006)
    _mix(cv, sl, m, col, 0.85)
    cv.h[sl] += m * 0.0004


def cast(cv, c, a0, b0, a1, b1, amt=0.35, soft=0.012):
    """soft contact shadow (e.g. under a pocket / pouch / mat)"""
    sl, A, B = cv.win(c)
    cv.ao[sl] *= 1 - amt * _rect(A, B, a0, b0, a1, b1, soft)


def _edge_x(c, b, taper, h):
    """half width of a tapered face at depth b (from the top)"""
    return c.aw / 2 * (1 - taper * (h - b) / h)


# ---- painters (cv, chart): chart.aw / bh are the face size; front faces of tapered boxes narrow toward the top
def _paint_ruck_front(cv, c):
    ua = cv.fac == 'ua'; w, h = c.aw, c.bh
    binding(cv, c, 0.0)
    # main compartment zip: round the top and down both sides (clamshell)
    m_ = 0.028
    pts = [(m_ + 0.012, h - 0.05), (m_ + 0.008, 0.06), (m_ + 0.02, m_ + 0.012), (w / 2, m_), (w - m_ - 0.02, m_ + 0.012), (w - m_ - 0.008, 0.06), (w - m_ - 0.012, h - 0.05)]
    zipper(cv, c, pts, slider_at=(0.42, 0.58))
    # upper admin pocket: horizontal zip + plain velcro ID field (UA; models_v11: no flag patch) / name tape field (RU)
    zipper(cv, c, [(0.06, 0.135), (w - 0.06, 0.135)], slider_at=0.82)
    if ua:
        velcro(cv, c, w / 2 - 0.06, 0.05, w / 2 + 0.06, 0.12)
    else:
        webbing_rows(cv, c, 0.05, w - 0.05, 0.06, 1, hgt=0.025)
        label(cv, c, w / 2 - 0.035, 0.093, w / 2 + 0.035, 0.112, (0.2, 0.21, 0.17))
    # vertical compression straps either side of the pocket (flat)
    for x in (0.03, w - 0.03):
        strap_flat(cv, c, [(x, 0.12), (x, h - 0.01)], 0.022, col=None)
    cast(cv, c, w / 2 - 0.14, h - 0.235, w / 2 + 0.14, h - 0.02, 0.35)        # under / round the front pocket
    seam(cv, c, [(0.015, 0.2), (w - 0.015, 0.2)])
    grommet(cv, c, w / 2 - 0.09, h - 0.012); grommet(cv, c, w / 2 + 0.09, h - 0.012)


def _paint_pocket_ua(cv, c):
    w, h = c.aw, c.bh
    binding(cv, c, 0.0)
    laser_molle(cv, c, 0.03, w - 0.03, 0.045, 4)
    zipper(cv, c, [(0.012, h - 0.02), (0.012, 0.018), (w - 0.012, 0.018), (w - 0.012, h - 0.02)], slider_at=(0.1, 0.9))
    label(cv, c, w - 0.06, h - 0.03, w - 0.025, h - 0.02)


def _paint_pocket_ru(cv, c):
    w, h = c.aw, c.bh
    binding(cv, c, 0.0)
    webbing_rows(cv, c, 0.02, w - 0.02, 0.07, 3, pitch=0.045)
    seam(cv, c, [(0.01, 0.06), (w - 0.01, 0.06)])
    grommet(cv, c, 0.03, h - 0.015); grommet(cv, c, w - 0.03, h - 0.015)


def _paint_flap(cv, c):
    w, h = c.aw, c.bh
    binding(cv, c, 0.0, 0.007)
    seam(cv, c, [(0.01, 0.015), (w - 0.01, 0.015)])


def _paint_ruck_side(cv, c):
    w, h = c.aw, c.bh
    binding(cv, c, 0.0)
    for b in (h / 2 - 0.09, h / 2 + 0.08):        # compression straps at box y +0.09 / -0.08 (buckles are geometry)
        strap_flat(cv, c, [(0.0, b), (w, b)], 0.022, col=cv.web)
    zipper(cv, c, [(w * 0.5, 0.05), (w * 0.5, h - 0.06)], slider_at=0.08)       # side access zip
    webbing_rows(cv, c, 0.025, w - 0.025, h - 0.11, 2, pitch=0.05)
    cast(cv, c, -0.01, h - 0.012, w + 0.01, h + 0.03, 0.4, 0.02)                 # mat / bottom


def _paint_top(cv, c):
    w, h = c.aw, c.bh
    binding(cv, c, 0.0)
    cast(cv, c, w / 2 - 0.05, h * 0.3, w / 2 + 0.05, h * 0.62, 0.3)             # grab handle
    grommet(cv, c, w * 0.8, h * 0.6, 0.006)                                     # hydration port
    seam(cv, c, [(0.012, h * 0.82), (w - 0.012, h * 0.82)])


def _paint_assault_ua(cv, c):
    w, h = c.aw, c.bh
    binding(cv, c, 0.0)
    zipper(cv, c, [(0.022, h - 0.02), (0.02, 0.045), (0.04, 0.022), (w - 0.04, 0.022), (w - 0.02, 0.045), (w - 0.022, h - 0.02)], slider_at=(0.45, 0.55))
    velcro(cv, c, w / 2 - 0.055, 0.04, w / 2 + 0.055, 0.105)        # (models_v11: no flag patch)
    laser_molle(cv, c, 0.035, w - 0.035, 0.12, 2)
    cast(cv, c, w / 2 - 0.1, h - 0.17, w / 2 + 0.1, h - 0.03, 0.3)


def _paint_assault_ru(cv, c):
    w, h = c.aw, c.bh
    binding(cv, c, 0.0)
    webbing_rows(cv, c, 0.025, w - 0.025, 0.035, 3, pitch=0.05)
    zipper(cv, c, [(0.02, h - 0.02), (0.02, 0.025), (w - 0.02, 0.025), (w - 0.02, h - 0.02)], slider_at=(0.3, 0.7))
    cast(cv, c, w / 2 - 0.1, h - 0.17, w / 2 + 0.1, h - 0.03, 0.3)


def _paint_apocket_ua(cv, c):
    w, h = c.aw, c.bh
    binding(cv, c, 0.0, 0.007)
    zipper(cv, c, [(0.012, 0.014), (w - 0.012, 0.014)], slider_at=0.85)
    laser_molle(cv, c, 0.02, w - 0.02, 0.035, 2)


def _paint_apocket_ru(cv, c):
    w, h = c.aw, c.bh
    binding(cv, c, 0.0, 0.007)
    webbing_rows(cv, c, 0.015, w - 0.015, 0.03, 2, pitch=0.045)
    seam(cv, c, [(0.01, 0.018), (w - 0.01, 0.018)])


def _paint_apack_side(cv, c):
    w, h = c.aw, c.bh
    binding(cv, c, 0.0)
    strap_flat(cv, c, [(0.0, h / 2 - 0.10), (w, h / 2 - 0.10)], 0.02, col=cv.web)      # at box y +0.10 (buckle geometry)
    seam(cv, c, [(w * 0.5, 0.02), (w * 0.5, h - 0.02)])


def _paint_mat_end(cv, c):
    """rolled foam mat seen end-on: spiral of foam layers"""
    sl, A, B = cv.win(c)
    r0 = c.aw / 2
    x, y = A - r0, B - r0
    rr = np.hypot(x, y); th = np.arctan2(y, x)
    pitch = 0.0105
    ph = (rr - th / (2 * np.pi) * pitch) / pitch
    g = np.abs((ph % 1) - 0.5) < 0.08
    cv.alb[sl] *= (1 - 0.55 * g)[..., None]
    cv.h[sl] -= g * 0.0012
    cv.ao[sl] *= np.clip(0.75 + 0.25 * rr / r0, 0, 1)
    cv.hard[sl] = 1.0


def texture(fac, fab, fab_n, mat_cols):
    """(albedo sRGB float HxWx3, normal 0..1 HxWx3) for pack_<fac>.  fab / fab_n: gear camo tile (1024^2, 0.5 m) + its normal"""
    if fac in _TEX:
        return _TEX[fac]
    cv = Canvas(fac, fab, fab_n)
    for c in cv.ch:
        cv.fill(c)
        if c.key.startswith('mat_'):
            sl, A, B = cv.win(c)
            col = C.hexc(mat_cols[fac])
            nz = ndimage.gaussian_filter(cv.rng.standard_normal(A.shape), 1.2)
            cv.alb[sl] = (col * (1 + 0.06 * nz[..., None])).astype(np.float32)
        if c.paint is not None:
            c.paint(cv, c)
        elif not c.key.startswith('mat_'):
            binding(cv, c, 0.0)
    # height -> normal per chart (texel size differs per chart), cavity AO, weave suppressed on hard items
    nrm = np.zeros_like(cv.tn); nrm[..., 2] = 1
    for c in cv.ch:
        sl, _, _ = cv.win(c)
        hh = cv.h[sl] * c.s
        nd = TX.height_to_normal(hh, 1.6) * 2 - 1
        hb = ndimage.gaussian_filter(cv.h[sl], 3.0 * c.s / PXM)
        cav = np.clip(1 - 260 * np.maximum(hb - cv.h[sl], 0), 0.6, 1)
        cv.ao[sl] *= cav
        tn = cv.tn[sl] * (1 - cv.hard[sl][..., None]) + np.array([0, 0, 1.0]) * cv.hard[sl][..., None]
        n = np.stack([tn[..., 0] + nd[..., 0], tn[..., 1] + nd[..., 1], tn[..., 2] * nd[..., 2]], -1)
        nrm[sl] = n / np.linalg.norm(n, axis=-1, keepdims=True)
    alb = np.clip(cv.alb * cv.ao[..., None], 0, 1)
    _TEX[fac] = (alb, nrm * 0.5 + 0.5)
    return _TEX[fac]


def mat_end_uv(p):
    """uv of the rolled-mat end caps (planar in the cap)"""
    c, ab = p.pop('pack_end')
    _layout(c.fac)
    a = np.clip(ab[:, 0], 0, c.aw); b = np.clip(c.bh - ab[:, 1], 0, c.bh)
    p['uv'] = np.stack([(c.ox + GUT + a * c.s) / TW, (c.oy + GUT + b * c.s) / c.TH], 1)
    return p


def finish_uv(p):
    if 'charts' in p:
        return chart_uv(p)
    if 'pack_end' in p:
        return mat_end_uv(p)
    return None
