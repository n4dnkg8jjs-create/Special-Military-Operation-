"""Faction kit composition: plate carriers + pouches, helmets, tape bands, knee pads, backpack."""
import numpy as np
from mathutils import Vector
import gear as G
import pouches as PO
import meshutil as MU

RU_MATS = dict(fabric='emr_gear', webbing='emr_gear', hardware='gear_hardware', mag='ak_mag_polymer',
               radio='radio_black', red='medic_red', flag_a='flag_white', flag_b='flag_blue', flag_c='flag_red')
UA_MATS = dict(fabric='multicam_gear', webbing='coyote_webbing', hardware='gear_hardware', mag='ak_mag_polymer',
               radio='radio_black', red='medic_red', flag_a='flag_blue', flag_b='flag_yellow', flag_c='flag_yellow')


def tag(parts, group):
    for p in parts:
        p['group'] = group
    return parts


def shoulder_strap(env, side, mat, x0=0.095, width=0.05, y_front=1.43, y_back=1.46, thick=0.011, gap=0.004, n=17):
    """padded strap over the shoulder, conforming to the uniform surface via ray casts"""
    sx = 1 if side == 'L' else -1
    cols = []
    yc = 1.36
    zc = env.zcen(yc)
    for dx in (-width / 2, 0, width / 2):
        x = sx * (x0 + dx)
        o = np.array([x, yc, zc])
        pts = []
        # sweep from front-down over the top to back-down
        for phi in np.linspace(np.radians(-15), np.radians(195), n):
            d = np.array([0, np.sin(phi), np.cos(phi)])
            best = None
            for t in env.trees:
                h = t.ray_cast(Vector(o), Vector(d), 0.5)
                if h[0] is not None and (best is None or h[3] > best[3]):
                    best = h
            if best is None:
                pts.append(o + d * 0.15)
            else:
                pts.append(np.array(best[0]))
        cols.append(np.array(pts))
    cols = np.array(cols)  # 3 x n x 3
    # take the max radial distance per row across the 3 columns so the strap bridges dips
    rad = np.linalg.norm(cols - np.array([0, yc, zc]) * [0, 1, 1] - [cols[..., 0].mean() * 0, 0, 0], axis=-1)
    # build outward directions in the y-z plane
    ctr = np.array([0, yc, zc])
    rel = cols - ctr; rel[..., 0] = 0
    dirs = rel / np.linalg.norm(rel, axis=-1, keepdims=True)
    r = np.linalg.norm(rel, axis=-1).max(0)
    r = np.convolve(np.pad(r, 2, mode='edge'), np.ones(5) / 5, mode='valid')
    # trim to the strap extents (front end at y_front, back end at y_back)
    keep = []
    for k in range(n):
        p = ctr + dirs[1, k] * r[k]
        z = p[2]
        if (z > zc and p[1] < y_front - 0.01) or (z < zc and p[1] < y_back - 0.01):
            continue
        keep.append(k)
    keep = np.array(keep)
    xs = np.array([sx * (x0 - width / 2), sx * x0, sx * (x0 + width / 2)])
    outer, inner = [], []
    for k in keep:
        for j in range(3):
            d = dirs[1, k]
            bulge = 1.0 if j == 1 else 0.55
            outer.append([xs[j], *(ctr[1:] + d[1:] * (r[k] + gap + thick * bulge))])
            inner.append([xs[j], *(ctr[1:] + d[1:] * (r[k] + gap))])
    nk = len(keep)
    pos = np.concatenate([outer, inner])
    T = G.grid_tris(3, nk)
    Ti = T[:, ::-1] + 3 * nk
    rim = []
    ring = [(0, i) for i in range(3)] + [(j, 2) for j in range(1, nk)] + [(nk - 1, i) for i in range(1, -1, -1)] + [(j, 0) for j in range(nk - 2, 0, -1)]
    ids = [j * 3 + i for j, i in ring]
    for k in range(len(ids)):
        a, b = ids[k], ids[(k + 1) % len(ids)]
        rim += [[a + 3 * nk, b + 3 * nk, b], [a + 3 * nk, b, a]]
    uv = np.concatenate([[[xs[j] * 2, k * 0.03] for k in range(nk) for j in range(3)]] * 2)
    return G.orient_closed(G.part(pos, np.concatenate([T, Ti, np.array(rim)]), mat, uv))


def panel_M(fr, x, y, h_extra=0.0):
    p, n, up, side = G.panel_point(fr, x, y, h_extra)
    if fr['back']:
        side = -side
        side = np.cross(up, n)
    return PO.mat4(p, side, up, n)


def side_M(env, th, y, off):
    p = env.point(y, th, off)
    n = env.normal(y, th)
    up = np.array([0, 1.0, 0]); up = up - n * (up @ n); up /= np.linalg.norm(up)
    side = np.cross(up, n)
    return PO.mat4(p, side, up, n)


RU_VEST = dict(bottom=1.015, front_top=1.452, back_top=1.448, side_top=1.262)   # 6B45/6B46 cover down to the belt line (trouser waist ~1.0)


def plate_carrier(env, fac):
    m = RU_MATS if fac == 'ru' else UA_MATS
    out = []
    if fac == 'ru':
        # 6B45 / 6B46 (Ratnik): front and back sections run from the collar bones / shoulder blades down to the belt, the side
        # sections (soft armour bags) wrap the waist; narrow shooter's cut at the top front, wide armhole cut at the top back
        V = RU_VEST
        yb, ft, bt = V['bottom'], V['front_top'], V['back_top']
        fp = G.env_panel(env, 0.0, (ft + yb) / 2, 0.158, (ft - yb) / 2, 0.024, chamfer=0.05, mat=m['fabric'], nu=13, nv=18, rad=0.035, edge=0.014)
        bp = G.env_panel(env, np.pi, (bt + yb) / 2, 0.150, (bt - yb) / 2, 0.021, mat=m['fabric'], back=True, chamfer=0.048, nu=13, nv=18, rad=0.035, edge=0.014)
        cy0, cy1, cth = yb + 0.004, V['side_top'], 0.5
    else:
        fp = G.env_panel(env, 0.0, 1.282, 0.14, 0.158, 0.022, chamfer=0.032, mat=m['fabric'], nu=13, nv=15)
        bp = G.env_panel(env, np.pi, 1.30, 0.145, 0.165, 0.02, mat=m['fabric'], back=True, chamfer=0.02, nu=13, nv=15)
        cy0, cy1, cth = 1.07, 1.215, 0.52
    out += tag([G.orient_closed(fp), G.orient_closed(bp)], 'vest')
    for sgn in (1, -1):
        ths = (cth, np.pi - 0.48) if sgn > 0 else (-(np.pi - 0.48), -cth)
        out += tag([G.orient_closed(G.band(env, cy0, cy1, ths[0], ths[1], 0.003, 0.011 if fac == 'ua' else 0.013, nu=22, nv=5 if fac == 'ru' else 4,
                                           mat=m['fabric'], wrinkle=0.0015, seed=3 if sgn > 0 else 4))], 'vest')
        out += tag([shoulder_strap(env, 'L' if sgn > 0 else 'R', m['fabric'])], 'vest')
    ffr, bfr = fp['frame'], bp['frame']
    fy = lambda y: y - ffr['yc']          # absolute height -> panel coordinate
    by = lambda y: y - bfr['yc']
    # MOLLE webbing rows (from the upper chest down to just above the bottom edge)
    nf, nb = (8, 8) if fac == 'ru' else (6, 7)
    # (RU: the rows fully hidden behind the three mag pouches, 1.075 .. 1.225 m, are skipped)
    rows_f = [p for p in G.molle_rows_panel(ffr, -0.13, 0.13, fy(1.417), nf, m['webbing'])
              if fac != 'ru' or not (p['pos'][:, 1].min() > 1.075 and p['pos'][:, 1].max() < 1.225)]
    out += tag([G.orient_open(p, p['pos'] - np.stack([0 * p['pos'][:, 0], p['pos'][:, 1], env.zcen(p['pos'][:, 1])], 1)) for p in rows_f], 'vest')
    out += tag([G.orient_open(p, p['pos'] - np.stack([0 * p['pos'][:, 0], p['pos'][:, 1], env.zcen(p['pos'][:, 1])], 1)) for p in G.molle_rows_panel(bfr, -0.13, 0.13, by(1.44 if fac == 'ua' else 1.415), nb, m['webbing'])], 'vest')
    # cummerbund MOLLE (3 rows each side; RU side sections: 4)
    off = 0.003 + (0.011 if fac == 'ua' else 0.013) + 0.0018
    for sgn in (1, -1):
        for r in range(3 if fac == 'ua' else 4):
            yc = cy1 - 0.02 - r * 0.05
            th = np.linspace(sgn * (cth + 0.25), sgn * (np.pi - 0.75), 12)
            top = env.point(yc + 0.0125, th, off)
            bot = env.point(yc - 0.0125, th, off)
            bt_ = env.point(yc + 0.0125, th, off - 0.0028)
            bb = env.point(yc - 0.0125, th, off - 0.0028)
            pos = np.concatenate([bt_, top, bot, bb])
            p = G.part(pos, G.grid_tris(12, 4), m['webbing'], np.concatenate([np.stack([th * 0.15 * 2, np.full(12, k * 0.02)], 1) for k in range(4)]))
            out += tag([G.orient_open(p, pos - np.array([0, yc, env.zcen(yc)]))], 'vest')
    # drag handle on back top
    out += tag(PO.drag_handle(m, panel_M(bfr, 0, by(1.43))), 'vest')
    # ------------------------------------------------------------- pouches
    if fac == 'ru':
        # 6Sh117-style: three double AK mag pouches low on the front (belly), radio + grenade pouch above them
        for k, x in enumerate((-0.092, 0.0, 0.092)):
            out += tag(PO.mag_pouch(m, panel_M(ffr, x, fy(1.072))), 'pouches_front')
        out += tag(PO.radio_pouch(m, panel_M(ffr, 0.075, fy(1.247)), antenna=0.2), 'pouches_front')
        out += tag(PO.grenade_pouch(m, panel_M(ffr, -0.075, fy(1.242))), 'pouches_front')
        # sides: grenade pouches (left), IFAK (right)
        out += tag(PO.grenade_pouch(m, side_M(env, 1.25, 1.075, 0.018)), 'pouches_side')
        out += tag(PO.grenade_pouch(m, side_M(env, 1.65, 1.075, 0.018)), 'pouches_side')
        out += tag(PO.ifak(m, side_M(env, -1.5, 1.07, 0.018), w=0.14), 'pouches_side')
        out += tag(PO.hydration(m, panel_M(bfr, 0, by(1.14))), 'pouches_back')
        out += tag(PO.dump_pouch(m, side_M(env, -(np.pi - 0.75), 1.07, 0.017)), 'pouches_back')
    else:
        # JPC-style: triple open-top mag shingle with visible mags, admin + flag, tourniquet, radio
        for k, x in enumerate((-0.088, 0.0, 0.088)):
            out += tag(PO.mag_pouch(m, panel_M(ffr, x, -0.15), open_top=True, n_mags=1, w=0.075, h=0.16, d=0.045), 'pouches_front')
        out += tag(PO.admin_pouch(m, panel_M(ffr, 0, -0.005), w=0.2, h=0.1, d=0.028), 'pouches_front')
        # UA flag patch on the admin pouch (blue over yellow)
        Mf = panel_M(ffr, 0, 0.045, 0.031)
        out += tag([PO.local_part(PO.rbox(0.07, 0.022, 0.003, 0.0, 1), Mf @ PO.T(0, 0.011, 0), m['flag_a'], 'hard'),
                    PO.local_part(PO.rbox(0.07, 0.022, 0.003, 0.0, 1), Mf @ PO.T(0, -0.011, 0), m['flag_b'], 'hard')], 'pouches_front')
        out += tag(PO.tourniquet(m, panel_M(ffr, -0.085, 0.075)), 'pouches_front')
        out += tag(PO.radio_pouch(m, side_M(env, 1.15, 1.09, 0.015), antenna=0.22), 'pouches_side')
        out += tag(PO.ifak(m, side_M(env, -1.75, 1.07, 0.015), w=0.15, cross=True), 'pouches_side')
        out += tag(PO.grenade_pouch(m, side_M(env, -1.25, 1.09, 0.015)), 'pouches_side')
        out += tag(PO.hydration(m, panel_M(bfr, 0, -0.16), w=0.21, h=0.28, d=0.05), 'pouches_back')
    return out


# =================================================================== helmets
HELMETS = {
    # rim elevation (deg) as function of azimuth: (front, side, back); extra features
    '6b47': dict(rim=(6, -8, -22), scale=(1.0, 1.0, 1.0), off=0.03, cover='fabric', band=True, nvg=True, rails=False),
    '6b47_goggles': dict(rim=(6, -8, -22), scale=(1.0, 1.0, 1.0), off=0.03, cover='fabric', band=True, nvg=False, rails=False, goggles=True),
    'fast': dict(rim=(9, 20, -12), scale=(1.0, 0.98, 1.0), off=0.026, cover='fabric', band=False, nvg=True, rails=True, counterweight=True),
    'altyn': dict(rim=(14, -34, -30), scale=(1.05, 1.03, 1.05), off=0.034, cover='fabric', band=False, nvg=False, rails=False),
    'mich': dict(rim=(7, -2, -18), scale=(1.0, 1.0, 1.0), off=0.027, cover='fabric', band=False, nvg=False, rails=False, goggles=True),
}


def fit_head(head_pts, head_center_guess):
    """axis-aligned ellipsoid fitted to the skull (points above the brow line)"""
    c0 = head_center_guess
    P = head_pts[head_pts[:, 1] > c0[1] - 0.01]
    lo, hi = P.min(0), P.max(0)
    c = np.array([(lo[0] + hi[0]) / 2, c0[1], (lo[2] + hi[2]) / 2])
    r = np.array([(hi[0] - lo[0]) / 2, hi[1] - c0[1], (hi[2] - lo[2]) / 2])
    return c, r


def rim_el(az, rim):
    f, s, b = np.radians(rim)
    ca = np.cos(az)
    w_f = np.clip(ca, 0, 1) ** 1.5; w_b = np.clip(-ca, 0, 1) ** 1.5; w_s = 1 - w_f - w_b
    return f * w_f + s * w_s + b * w_b


def helmet(kind, c, r, mats, fac):
    H = HELMETS[kind]
    m = mats
    out = []
    naz, nel = 36, 10
    az = np.linspace(-np.pi, np.pi, naz, endpoint=False)
    R = r * H['scale'] + H['off']
    def surf(az_, el_, extra=0.0):
        x = np.cos(el_) * np.sin(az_); y = np.sin(el_); z = np.cos(el_) * np.cos(az_)
        rr = 1.0 / np.sqrt((x / R[0]) ** 2 + (y / R[1]) ** 2 + (z / R[2]) ** 2)
        # slight flare toward the rim
        return c[None] + np.stack([x, y, z], -1) * (rr + extra)[..., None]
    t = np.linspace(0, 1, nel)
    AZ, TT = np.meshgrid(az, t)
    re = rim_el(AZ, H['rim'])
    EL = re + (np.pi / 2 - re) * (1 - (1 - TT) ** 1.3) * 0.985
    flare = 0.004 * np.clip(1 - TT * 4, 0, 1)
    outer = surf(AZ, EL, flare)
    inner = surf(AZ, EL, flare - 0.009)
    n = naz * nel
    Tg = G.grid_tris(naz, nel, closed_u=True)
    pos = np.concatenate([outer.reshape(-1, 3), inner.reshape(-1, 3), [c + [0, R[1] + 0.0, 0], c + [0, R[1] - 0.009, 0]]])
    T = [Tg, Tg[:, ::-1] + n]
    top = [[(nel - 1) * naz + k, (nel - 1) * naz + (k + 1) % naz, 2 * n] for k in range(naz)]
    topi = [[n + (nel - 1) * naz + (k + 1) % naz, n + (nel - 1) * naz + k, 2 * n + 1] for k in range(naz)]
    T += [np.array(top), np.array(topi)]
    # rolled rim (rubber edge trim): torus segment joining outer and inner
    rim_o = outer[0]; rim_i = inner[0]
    mid = (rim_o + rim_i) / 2
    down = np.array([0, -1.0, 0])
    rings = [rim_o, rim_o * 0.5 + (mid + down * 0.004) * 0.5 + 0.002 * (rim_o - mid) / 0.0045, rim_i]
    rpos = np.concatenate(rings)
    base = len(pos)
    pos = np.concatenate([pos, rpos])
    rimT = []
    for j in range(2):
        for k in range(naz):
            a = base + j * naz + k; b = base + j * naz + (k + 1) % naz
            rimT += [[a, b + naz, b], [a, a + naz, b + naz]]
    T.append(np.array(rimT))
    T = np.concatenate(T)
    uv = np.concatenate([np.stack([AZ.reshape(-1) * 0.1 * 2, -EL.reshape(-1) * 0.1 * 2], 1)] * 2 + [[[0, 0], [0, 0]]] + [np.zeros((3 * naz, 2))])
    shell = G.part(pos, T, m['fabric'], uv)
    if G.signed_volume(pos, T) < 0:
        shell['tri'] = shell['tri'][:, ::-1]
    shell['nrm'] = MU.vertex_normals(shell['pos'], shell['tri'])
    out.append(shell)
    def on(az_, el_, h=0.0):
        p = surf(np.asarray(az_), np.asarray(el_), h)
        nn = (surf(np.asarray(az_), np.asarray(el_), h + 0.01) - p) / 0.01
        if np.ndim(az_) == 0:
            p = p.reshape(3); nn = nn.reshape(3)
        return p, nn / np.linalg.norm(nn, axis=-1, keepdims=True)
    def frame(az_, el_, h=0.0):
        p, nn = on(az_, el_, h)
        up = np.array([0, 1.0, 0]) - nn * nn[1]; up /= np.linalg.norm(up)
        return PO.mat4(p, np.cross(up, nn), up, nn)
    if H.get('band'):
        # elastic foliage band around the crown (6B47 cover)
        ab = np.linspace(-np.pi, np.pi, naz + 1)
        e0 = np.radians(18); e1 = np.radians(26)
        P0, _ = on(ab, np.full_like(ab, e0), 0.001); P1, _ = on(ab, np.full_like(ab, e0), 0.004)
        P2, _ = on(ab, np.full_like(ab, e1), 0.004); P3, _ = on(ab, np.full_like(ab, e1), 0.001)
        bp = np.concatenate([P0, P1, P2, P3])
        bt = G.grid_tris(naz + 1, 4)
        band = G.part(bp, bt, m['webbing'], np.concatenate([np.stack([ab * 0.2, np.full(naz + 1, k * 0.01)], 1) for k in range(4)]))
        out.append(G.orient_open(band, bp - c))
    if H.get('nvg'):
        out.append(PO.local_part(PO.rbox(0.07, 0.045, 0.012, 0.004, 1), frame(0.0, np.radians(30), 0.0) @ PO.T(0, 0, 0.006), m['hardware'], 'hard'))
        out.append(PO.local_part(PO.rbox(0.028, 0.03, 0.022, 0.003, 1), frame(0.0, np.radians(27), 0.0) @ PO.T(0, -0.012, 0.018), m['hardware'], 'hard'))
    if H.get('rails'):
        for sgn in (1, -1):
            for k, e in enumerate(np.radians([12, 20, 28])):
                pass
            rail_parts = []
            a0 = sgn * np.radians(78)
            for k in range(5):
                a = a0 + sgn * np.radians(-12 + k * 7)
                rail_parts.append(PO.local_part(PO.rbox(0.03, 0.022, 0.009, 0.002, 1), frame(a, np.radians(14), 0.0) @ PO.T(0, 0, 0.0045), m['hardware'], 'hard'))
            out += rail_parts
    if H.get('counterweight'):
        out.append(PO.local_part(PO.rbox(0.09, 0.06, 0.03, 0.01, 2), frame(np.pi, np.radians(5), 0.0) @ PO.T(0, 0.0, 0.015), m['fabric']))
    if H.get('goggles'):
        # strap around the helmet + goggle frame and lens resting on the front of the helmet
        ab = np.linspace(-np.pi, np.pi, naz + 1)
        e0 = np.radians(12); e1 = np.radians(21)
        P0, _ = on(ab, np.full_like(ab, e0), 0.001); P1, _ = on(ab, np.full_like(ab, e0), 0.003)
        P2, _ = on(ab, np.full_like(ab, e1), 0.003); P3, _ = on(ab, np.full_like(ab, e1), 0.001)
        bp = np.concatenate([P0, P1, P2, P3])
        strap = G.part(bp, G.grid_tris(naz + 1, 4), m['hardware'])
        out.append(G.orient_open(strap, bp - c))
        for sgn in (1, -1):
            Fm = frame(sgn * np.radians(17), np.radians(16), 0.004)
            out.append(PO.local_part(PO.rbox(0.072, 0.05, 0.022, 0.012, 2), Fm @ PO.T(0, 0, 0.011), m['hardware'], 'hard'))
            out.append(PO.local_part(PO.rbox(0.064, 0.042, 0.006, 0.01, 2), Fm @ PO.T(0, 0, 0.022), 'goggle_lens', 'hard'))
    for p in out:
        p['group'] = 'helmet'
    return out


# =================================================================== bands (tape), knee pads
def limb_ring_points(trees, a, b, s, ref, n=24, extra=0.0):
    ax = (b - a) / np.linalg.norm(b - a)
    e1 = ref - ax * (ref @ ax); e1 /= np.linalg.norm(e1); e2 = np.cross(ax, e1)
    o = a + ax * s
    pts = []
    for k in range(n):
        th = 2 * np.pi * k / n
        d = np.cos(th) * e1 + np.sin(th) * e2
        best = None
        for t in trees:
            h = t.ray_cast(Vector(o), Vector(d), 0.3)
            if h[0] is not None and (best is None or h[3] > best[3]):
                best = h
        r = best[3] if best is not None else 0.06
        pts.append((r, d))
    return o, ax, pts


def tape_band(trees, a, b, s_center, ref, width=0.05, mat='tape', seed=0, n=28):
    """wrapped duct tape: two overlapping wraps, crinkles, slightly spiral"""
    rng = np.random.default_rng(seed)
    rows = []
    nrow = 6
    ss = np.linspace(-width / 2, width / 2, nrow)
    o, ax, _ = limb_ring_points(trees, a, b, s_center, ref, n)
    for j, s in enumerate(ss):
        _, _, pts = limb_ring_points(trees, a, b, s_center + s, ref, n)
        row = []
        for k, (r, d) in enumerate(pts):
            th = 2 * np.pi * k / n
            crinkle = 0.0007 * np.sin(th * 7 + rng.uniform(0, 6)) * np.sin(s * 300 + th * 3) + 0.0004 * rng.standard_normal()
            # the second wrap overlaps: step on one half
            step = 0.0006 if (th / (2 * np.pi) + (s / width + 0.5) * 0.25) % 1 > 0.5 else 0.0
            row.append(o + ax * (s + 0.004 * np.sin(th)) + d * (r + 0.0025 + crinkle + step))
        rows.append(row)
    pos = np.array(rows).reshape(-1, 3)
    T = G.grid_tris(n, nrow, closed_u=True)
    # edge thickness: inner copy slightly in, to avoid see-through edges
    uv = np.array([[k / n * 2, j / nrow * 0.3] for j in range(nrow) for k in range(n)])
    p = G.part(pos, T, mat, uv)
    return G.orient_open(p, pos - (o + ax * ((pos - o) @ ax)[:, None]))


def kneepad(trees, hip, knee, ankle, side, mats):
    """hard-shell knee pad conforming to the front of the knee"""
    sx = 1 if side == 'L' else -1
    fwd = np.array([0, 0, 1.0])
    rows = []
    nu, nv = 10, 9
    for j, s in enumerate(np.linspace(-0.025, 0.075, nv)):
        if s < 0:
            a, b, ss = hip, knee, np.linalg.norm(knee - hip) + s
        else:
            a, b, ss = knee, ankle, s
        ax = (b - a) / np.linalg.norm(b - a)
        e1 = fwd - ax * (fwd @ ax); e1 /= np.linalg.norm(e1); e2 = np.cross(ax, e1)
        o = a + ax * ss
        row = []
        for k, th in enumerate(np.radians(np.linspace(-50, 50, nu))):
            d = np.cos(th) * e1 + np.sin(th) * e2
            best = None
            for t in trees:
                h = t.ray_cast(Vector(o), Vector(d), 0.3)
                if h[0] is not None and (best is None or h[3] > best[3]):
                    best = h
            r = best[3] if best is not None else 0.07
            edge = min(1, (50 - abs(np.degrees(th))) / 18, (0.06 - abs(s - 0.01)) / 0.025 + 0.2)
            row.append((o, d, r, max(edge, 0.05)))
        rows.append(row)
    outer = np.array([[o + d * (r + 0.004 + 0.011 * e) for (o, d, r, e) in row] for row in rows]).reshape(-1, 3)
    inner = np.array([[o + d * (r + 0.003) for (o, d, r, e) in row] for row in rows]).reshape(-1, 3)
    n = nu * nv
    Tg = G.grid_tris(nu, nv)
    T = [Tg, Tg[:, ::-1] + n]
    ring = [(0, i) for i in range(nu)] + [(j, nu - 1) for j in range(1, nv)] + [(nv - 1, i) for i in range(nu - 2, -1, -1)] + [(j, 0) for j in range(nv - 2, 0, -1)]
    ids = [j * nu + i for j, i in ring]
    rim = []
    for k in range(len(ids)):
        a, b = ids[k], ids[(k + 1) % len(ids)]
        rim += [[a + n, b + n, b], [a + n, b, a]]
    T.append(np.array(rim))
    pos = np.concatenate([outer, inner])
    p = G.orient_closed(G.part(pos, np.concatenate(T), 'kneepad_shell'))
    out = [p]
    # straps above and below (thin bands) - fabric
    return out


# =================================================================== backpack
def backpack(env, mats, fac):
    m = mats
    out = []
    th = np.pi
    y = 1.27
    p = env.point(y, th, 0.004 + 0.022 + 0.01)  # straight over the back plate (a hydration bladder, if shown, sits inside)
    n = env.normal(y, th)
    up = np.array([0, 1.0, 0]); side = np.cross(up, n)
    M = PO.mat4(p, side, up, n)
    w, h, d = 0.30, 0.40, 0.17
    out.append(PO.local_part(PO.rbox(w, h, d, 0.04, 3, taper_top=0.06), M @ PO.T(0, 0.02, d / 2), m['fabric']))
    # front pocket + compression straps + top handle + MOLLE rows
    out.append(PO.local_part(PO.rbox(w * 0.8, h * 0.45, 0.05, 0.02, 2), M @ PO.T(0, -0.06, d + 0.02), m['fabric']))
    for x in (-0.11, 0.11):
        out.append(PO.local_part(PO.rbox(0.025, h * 0.85, 0.006, 0.002, 1), M @ PO.T(x, 0.02, d + 0.001), m['webbing'], 'hard'))
        out.append(PO.local_part(PO.rbox(0.03, 0.022, 0.012, 0.003, 1), M @ PO.T(x, 0.12, d + 0.006), m['hardware'], 'hard'))
    for k in range(3):
        out.append(PO.local_part(PO.rbox(w * 0.75, 0.025, 0.004, 0.001, 1), M @ PO.T(0, 0.16 - k * 0.05, d + 0.0005 + 0.0), m['webbing'], 'hard'))
    out.append(PO.local_part(PO.rbox(0.08, 0.02, 0.03, 0.006, 1), M @ PO.T(0, h / 2 + 0.03, d * 0.4), m['webbing'], 'hard'))
    for sd in ('L', 'R'):
        out.append(shoulder_strap(env, sd, m['fabric'], x0=0.115, width=0.058, gap=0.017, thick=0.013, y_front=1.30, y_back=1.40))
    for q in out:
        q['group'] = 'backpack'
    return out
