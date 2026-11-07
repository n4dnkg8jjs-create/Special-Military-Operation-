"""Faction kit composition: plate carriers + pouches, helmets, tape bands, knee pads, backpack."""
import numpy as np
from mathutils import Vector
import gear as G
import pouches as PO
import meshutil as MU

RU_MATS = dict(fabric='emr_gear', webbing='emr_gear', hardware='gear_hardware', mag='ak_mag_polymer',
               radio='radio_black', red='medic_red')
UA_MATS = dict(fabric='multicam_gear', webbing='coyote_webbing', hardware='gear_hardware', mag='ak_mag_polymer',
               radio='radio_black', red='medic_red')


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
        # (radio pouch: comms.py, per preset - v10)
        out += tag(PO.grenade_pouch(m, panel_M(ffr, -0.075, fy(1.242))), 'pouches_front')
        # sides: grenade pouches (left), IFAK (right)
        out += tag(PO.grenade_pouch(m, side_M(env, 1.25, 1.075, 0.018)), 'pouches_side')
        out += tag(PO.grenade_pouch(m, side_M(env, 1.65, 1.075, 0.018)), 'pouches_side')
        out += tag(PO.ifak(m, side_M(env, -1.5, 1.07, 0.018), w=0.14), 'pouches_side')
        out += tag(PO.hydration(m, panel_M(bfr, 0, by(1.14))), 'pouches_back')
        out += tag(PO.dump_pouch(m, side_M(env, -(np.pi - 0.75), 1.07, 0.017)), 'pouches_back')
    else:
        # JPC-style: triple open-top mag shingle with visible mags, admin pouch, tourniquet, radio
        for k, x in enumerate((-0.088, 0.0, 0.088)):
            out += tag(PO.mag_pouch(m, panel_M(ffr, x, -0.15), open_top=True, n_mags=1, w=0.075, h=0.16, d=0.045), 'pouches_front')
        out += tag(PO.admin_pouch(m, panel_M(ffr, 0, -0.005), w=0.2, h=0.1, d=0.028), 'pouches_front')
        # (models_v11: no flag patch on the admin pouch - identification is the tape bands only)
        out += tag(PO.tourniquet(m, panel_M(ffr, -0.085, 0.075)), 'pouches_front')
        # (radio pouch: comms.py, per preset - v10)
        out += tag(PO.ifak(m, side_M(env, -1.75, 1.07, 0.015), w=0.15, cross=True), 'pouches_side')
        out += tag(PO.grenade_pouch(m, side_M(env, -1.25, 1.09, 0.015)), 'pouches_side')
        out += tag(PO.hydration(m, panel_M(bfr, 0, -0.16), w=0.21, h=0.28, d=0.05), 'pouches_back')
    return out


# =================================================================== helmets
HELMETS = {
    # rim elevation (deg) as function of azimuth: (front, side, back); extra features
    # scale/off: shell = skull ellipsoid * scale + off (real shells stand 3.5-4 cm off the skull with pads + shell thickness; wider at the sides)
    # cover extras (2026-11, from 2022-24 photos): seams = 4-panel cover seams (crown cross), pucker = cloth gathered under the band,
    # band_mat = band material (RU: black rubber / inner-tube band over the EMR cover; tape = recolourable ID tape), iff = velcro patch
    # at the back, goggles = 'ru' (6B34 / black frame, smoke lens) or 'ua' (Desert Locust style, tan frame, clear lens)
    '6b47': dict(rim=(6, -8, -22), scale=(1.06, 1.02, 1.04), off=0.037, cover='fabric', band=True, nvg=True, rails=False,
                 seams=True, pucker=True, band_mat='helmet_band', iff=True),
    '6b47_goggles': dict(rim=(6, -8, -22), scale=(1.06, 1.02, 1.04), off=0.037, cover='fabric', band=True, nvg=False, rails=False, goggles='ru',
                         seams=True, pucker=True, band_mat='helmet_band', iff=True),
    # 6B7-1M (older Ratnik-era / mobilised issue): rounder, deeper bowl than the 6B47, ears covered, slight flare, no brim; EMR cover
    # with a white identification-tape band (2022-23 photos) -> recolourable `tape`
    '6b7': dict(rim_pts=((0, 3), (40, -2), (70, -19), (100, -29), (140, -29), (180, -26)), scale=(1.06, 1.03, 1.06), off=0.040, sq=2.0,
                cover='fabric', band=True, band_mat='tape', band_el=(15, 22), nvg=False, rails=False, seams=True, pucker=True,
                skirt=((0, 0.004), (60, 0.006), (110, 0.009), (180, 0.008)), naz=48, scrim=True),
    # SSh-68 (steel, olive paint; mobilised / LDPR troops 2022): steep front, near-vertical lower sides, flared brim all round
    'ssh68': dict(rim_pts=((0, 9), (45, 3), (80, -17), (110, -23), (150, -24), (180, -22)), scale=(1.05, 0.97, 1.07), off=0.033, sq=2.15,
                  cover=None, shell_mat='ssh68_paint', band=False, nvg=False, rails=False, thin=True,
                  skirt=((0, 0.013), (50, 0.011), (100, 0.016), (180, 0.016)), naz=48),
    'fast': dict(rim=(9, 20, -12), scale=(1.06, 1.02, 1.04), off=0.034, cover='fabric', band=False, nvg=True, rails=True, counterweight=True),
    'altyn': dict(rim=(14, -34, -30), scale=(1.09, 1.05, 1.08), off=0.040, cover='fabric', band=False, nvg=False, rails=False),
    # FAST high-cut: squarer shell (superellipse in plan), flattish crown, rim cut high above the ears with a sharp notch at the
    # temples, low at the brow and nape; bare ranger-green shell, ARC side rails, NVG shroud, velcro, shock cord, counterweight
    'fast_hc': dict(rim_pts=((0, -5), (44, -5), (56, -4), (62, 0), (68, 5), (74, 6.5), (106, 6.5), (113, 3), (120, -6), (130, -17),
                             (150, -27), (180, -31)),
                    scale=(1.04, 1.02, 1.05), off=0.031, sq=2.5, cover=None, shell_mat='ranger_gear', band=False, nvg=False,
                    rails=False, arc=True, shroud=True, velcro=True, cord=True, counterweight=True, naz=120, flare0=0.0, cw_el=-10,
                    velcro_paint=[(np.radians(-32), np.radians(32), np.radians(46), np.radians(70)), (np.radians(70), np.radians(114), np.radians(26), np.radians(36)),
                                  (np.radians(154), np.radians(181), np.radians(8), np.radians(22))]),
    # standard issue (PASGT-type kevlar / TOR-D): deeper bowl covering the ears, visor lip at the brow, flared skirt at the
    # sides and back; MM-14 cloth cover with an elastic band
    'pasgt': dict(rim_pts=((0, 2), (30, -2), (55, -14), (80, -30), (110, -34), (145, -33), (180, -30)),
                  scale=(1.04, 1.0, 1.06), off=0.034, sq=2.1, cover='fabric', shell_mat='mm14_gear', band=True, nvg=False, rails=False,
                  skirt=((0, 0.010), (40, 0.004), (80, 0.013), (130, 0.016), (180, 0.015)), naz=56, seams=True, pucker=True, scrim=True),
    # TOR-D / Kirasa kaska in a MultiCam cover with coyote band and ballistic goggles pushed up (2023-24 photos)
    'pasgt_mc': dict(rim_pts=((0, 2), (30, -2), (55, -14), (80, -30), (110, -34), (145, -33), (180, -30)),
                     scale=(1.04, 1.0, 1.06), off=0.034, sq=2.1, cover='fabric', shell_mat='multicam_gear', band=True, nvg=False, rails=False,
                     skirt=((0, 0.010), (40, 0.004), (80, 0.013), (130, 0.016), (180, 0.015)), naz=56, seams=True, pucker=True, goggles='ua',
                     iff=True),
    # FAST-type high cut (Ukrainian copies) in a MultiCam cover: rails + shroud through the cover cut-outs, strip of ID tape on the back
    'fast_mc': dict(rim_pts=((0, -5), (44, -5), (56, -4), (62, 0), (68, 5), (74, 6.5), (106, 6.5), (113, 3), (120, -6), (130, -17),
                             (150, -27), (180, -31)),
                    scale=(1.04, 1.02, 1.05), off=0.033, sq=2.5, cover='fabric', shell_mat='multicam_gear', band=False, nvg=False,
                    rails=False, arc=True, shroud=True, velcro=False, cord=False, counterweight=False, naz=120, flare0=0.0, seams=True,
                    tape_back=True),
    'mich': dict(rim=(7, -2, -18), scale=(1.09, 1.02, 1.05), off=0.036, cover='fabric', band=False, nvg=False, rails=False, goggles='ua',
                 seams=True),
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


def helmet(kind, c, r, mats, fac, trees=None, retention_ctx=True):
    H = HELMETS[kind]
    m = dict(mats)
    if H.get('shell_mat'):
        m['fabric'] = H['shell_mat']
    out = []
    naz, nel = H.get('naz', 36), 12 if H.get('rim_pts') else 10
    nu = naz + 1                                # soldiers_v10: open seam column at the back (painted shell chart, helmets.py)
    az = np.linspace(-np.pi, np.pi, nu)
    R = r * H['scale'] + H['off']
    sq = H.get('sq', 2.0)
    def per_az(pts, a):                         # symmetric curve given at 0..180 deg (deg -> value), periodic interpolation
        A = np.array([p[0] for p in pts], float); V = np.array([p[1] for p in pts], float)
        return np.interp(np.degrees(np.abs((np.asarray(a) + np.pi) % (2 * np.pi) - np.pi)), A, V)
    def surf(az_, el_, extra=0.0):
        az_ = np.asarray(az_, float); el_ = np.asarray(el_, float)
        sa, ca = np.sin(az_), np.cos(az_)
        dh = (np.abs(sa / R[0]) ** sq + np.abs(ca / R[2]) ** sq) ** (-1.0 / sq)     # superellipse plan radius
        rr = 1.0 / np.sqrt((np.cos(el_) / dh) ** 2 + (np.sin(el_) / R[1]) ** 2)
        x = np.cos(el_) * sa; y = np.sin(el_); z = np.cos(el_) * ca
        return c[None] + np.stack([x, y, z], -1) * (rr + extra)[..., None]
    t = np.linspace(0, 1, nel)
    AZ, TT = np.meshgrid(az, t)
    rim_fn = (lambda a: np.radians(per_az(H['rim_pts'], a))) if H.get('rim_pts') else (lambda a: rim_el(a, H['rim']))
    def flare_fn(AZ_, TT_):
        f = H.get('flare0', 0.004) * np.clip(1 - TT_ * 4, 0, 1)
        if H.get('skirt'):                      # flared skirt / visor lip toward the rim
            f = f + per_az(H['skirt'], AZ_) * np.clip(1 - TT_ * 3.2, 0, 1) ** 2
        return f
    re = rim_fn(AZ)
    EL = re + (np.pi / 2 - re) * (1 - (1 - TT) ** 1.3) * 0.985
    flare = flare_fn(AZ, TT)
    band_el = np.radians(H.get('band_el', (18, 26)))
    puck = np.zeros_like(AZ)
    if H.get('pucker') and H.get('cover') == 'fabric':
        # cover cloth gathered under the elastic band: irregular folds just above / below it (cloth slack pulled in by the band)
        rng_ = np.random.default_rng(7)
        ph = rng_.uniform(0, 2 * np.pi, 3)
        fold = 0.6 * np.sin(AZ * 11 + ph[0]) + 0.3 * np.sin(AZ * 23 + ph[1]) + 0.25 * np.sin(AZ * 5 + ph[2])
        em = 0.5 * (band_el[0] + band_el[1])
        puck = 0.0016 * np.clip(fold, -0.4, 1.0) * np.exp(-((EL - em) / np.radians(11)) ** 2)
    outer = surf(AZ, EL, flare + puck)
    inner = surf(AZ, EL, flare - (0.0035 if H.get('thin') else 0.009))
    n = nu * nel
    Tg = G.grid_tris(nu, nel, closed_u=False)
    top_o = np.repeat(c[None] + [0, R[1], 0], naz, 0)
    top_i = np.repeat(c[None] + [0, R[1] - (0.0035 if H.get('thin') else 0.009), 0], naz, 0)
    pos = np.concatenate([outer.reshape(-1, 3), inner.reshape(-1, 3), top_o, top_i])
    T = [Tg, Tg[:, ::-1] + n]
    top = [[(nel - 1) * nu + k, (nel - 1) * nu + k + 1, 2 * n + k] for k in range(naz)]
    topi = [[n + (nel - 1) * nu + k + 1, n + (nel - 1) * nu + k, 2 * n + naz + k] for k in range(naz)]
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
            a = base + j * nu + k; b = base + j * nu + k + 1
            rimT += [[a, b + nu, b], [a, a + nu, b + nu]]
    T.append(np.array(rimT))
    T = np.concatenate(T)
    shell = G.part(pos, T, m['fabric'], np.zeros((len(pos), 2)))
    if G.signed_volume(pos, T) < 0:
        shell['tri'] = shell['tri'][:, ::-1]
    shell['nrm'] = MU.vertex_normals(shell['pos'], shell['tri'])
    # soldiers_v10: painted shell (helmets.py): charts for the outer grid, the inside and the rim trim in hg_<fac>
    import helmets as HG
    co, ci, cr, aw, bh = HG.shell_charts(kind, fac, H, c, surf, rim_fn, flare_fn, m['fabric'], naz, nel, AZ, TT)
    a_ = ((AZ + np.pi) / (2 * np.pi) * aw).reshape(-1); b_ = (TT * bh).reshape(-1)
    am = ((az[:-1] + az[1:]) / 2 + np.pi) / (2 * np.pi) * aw
    shell['chart_ab'] = [(co, np.arange(n), np.stack([a_, b_], 1)), (ci, np.arange(n, 2 * n), np.stack([a_, b_], 1)),
                         (co, np.arange(2 * n, 2 * n + naz), np.stack([am, np.full(naz, bh)], 1)),
                         (ci, np.arange(2 * n + naz, 2 * n + 2 * naz), np.stack([am, np.full(naz, bh)], 1)),
                         (cr, np.arange(base, base + 3 * nu), np.stack([np.tile((az + np.pi) / (2 * np.pi) * aw, 3), np.repeat([0.0, 0.006, 0.012], nu)], 1))]
    shell['mat'] = HG.key(fac)
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
        # elastic foliage band around the crown (6B47 cover: often a black rubber / inner-tube band; 6B7: ID tape)
        nb_ = 49                                 # v10: 72 -> 48 segments
        ab = np.linspace(-np.pi, np.pi, nb_)
        e0, e1 = band_el
        hb = 0.0045 if H.get('band_mat') == 'helmet_band' else 0.0035
        wob = np.radians(0.8) * np.sin(ab * 3 + 1.0)            # band never sits perfectly level
        P0, _ = on(ab, e0 + wob, 0.0008); P1, _ = on(ab, e0 + wob, hb)
        P2, _ = on(ab, e1 + wob, hb); P3, _ = on(ab, e1 + wob, 0.0008)
        bp = np.concatenate([P0, P1, P2, P3])
        bt = G.grid_tris(nb_, 4)
        band = G.part(bp, bt, H.get('band_mat') or m['webbing'], np.concatenate([np.stack([ab * 0.2, np.full(nb_, k * 0.01)], 1) for k in range(4)]))
        out.append(G.orient_open(band, bp - c))
    if H.get('seams') and H.get('cover') == 'fabric' and H.get('seam_geo'):     # v10: painted (helmets.py)
        # 4-panel cover: raised seams from the crown down the front, back and sides (stop above the rim)
        rim_f = (lambda a: np.radians(per_az(H['rim_pts'], a))) if H.get('rim_pts') else (lambda a: rim_el(a, H['rim']))
        for a in (0.0, np.pi / 2, np.pi, -np.pi / 2):
            el_lo = float(rim_f(np.array(a))) + np.radians(5)
            ee = np.linspace(el_lo, np.radians(86), 14)
            Q = []
            for da, hh in ((-1, 0.0003), (-0.35, 0.0013), (0.35, 0.0013), (1, 0.0003)):
                dA = da * 0.0035 / (0.125 * np.maximum(np.cos(ee), 0.08))
                Pq, _ = on(a + dA, ee, hh + (float(np.max(puck)) * 0.6 if hh > 0.001 else 0.0)); Q.append(Pq)
            sp = np.concatenate(Q)
            sq_ = G.part(sp, G.grid_tris(14, 4), m['fabric'], np.concatenate([np.stack([ee * 0.2 + k * 0.003, np.full(14, a * 0.1)], 1) for k in range(4)]))
            out.append(G.orient_open(sq_, sp - c))
    if H.get('iff'):
        # velcro IFF / name patch on the back of the cover
        out.append(PO.local_part(PO.rbox(0.06, 0.04, 0.003, 0.002, 1), frame(np.pi, np.radians(36), 0.0) @ PO.T(0, 0, 0.0015), m['webbing'], 'hard'))
    if H.get('tape_back'):
        # strip of identification tape across the back of the cover (recolourable)
        ab = np.linspace(np.radians(150), np.radians(210), 16)
        Q = [on(ab, np.full_like(ab, e_), h_)[0] for e_, h_ in ((np.radians(24), 0.0007), (np.radians(24), 0.0017), (np.radians(31), 0.0017), (np.radians(31), 0.0007))]
        tp = np.concatenate(Q)
        out.append(G.orient_open(G.part(tp, G.grid_tris(16, 4), 'tape', np.concatenate([np.stack([ab * 0.3, np.full(16, k * 0.01)], 1) for k in range(4)])), tp - c))
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
    def strip(a0, a1, e_lo, e_hi, h0, h1, mat, n=24):
        """raised strip on the shell between azimuths a0..a1, elevation band (functions of az or constants), heights h0..h1"""
        ab = np.linspace(a0, a1, n)
        lo = e_lo(ab) if callable(e_lo) else np.full(n, e_lo); hi = e_hi(ab) if callable(e_hi) else np.full(n, e_hi)
        P0, _ = on(ab, lo, h0); P1, _ = on(ab, lo, h1); P2, _ = on(ab, hi, h1); P3, _ = on(ab, hi, h0)
        bp = np.concatenate([P0, P1, P2, P3])
        q = G.part(bp, G.grid_tris(n, 4), mat, np.concatenate([np.stack([ab * 0.2, np.full(n, k * 0.01)], 1) for k in range(4)]))
        return G.orient_open(q, bp - c)
    if H.get('arc'):
        # ARC side rails: straight polymer rails along the top of the ear cut-out, raised ~9 mm, end stops + screws
        for sgn in (1, -1):
            a0, a1 = sorted((sgn * np.radians(70), sgn * np.radians(112)))
            out.append(strip(a0, a1, np.radians(9.0), np.radians(15.5), 0.0005, 0.009, m['hardware'], n=20))
            for a in (70, 112):
                out.append(PO.local_part(PO.rbox(0.008, 0.014, 0.006, 0.002, 1), frame(sgn * np.radians(a), np.radians(12.2), 0.006), m['hardware'], 'hard'))
            for a in (80, 104):
                out.append(PO.local_part(PO.rbox(0.007, 0.007, 0.003, 0.0015, 1), frame(sgn * np.radians(a), np.radians(12.2), 0.0095), m['hardware'], 'hard'))
    if H.get('shroud'):
        # NVG shroud on the front face just above the brow: flat plate, mount recess, 3 screws
        out.append(PO.local_part(PO.rbox(0.070, 0.044, 0.006, 0.010, 2), frame(0.0, np.radians(8), 0.0) @ PO.T(0, 0, 0.003), m['hardware'], 'hard'))
        out.append(PO.local_part(PO.rbox(0.026, 0.020, 0.008, 0.004, 1), frame(0.0, np.radians(6), 0.0) @ PO.T(0, -0.004, 0.008), m['hardware'], 'hard'))
        for dx in (-0.024, 0.0, 0.024):
            out.append(PO.local_part(PO.rbox(0.005, 0.005, 0.003, 0.0015, 1), frame(0.0, np.radians(8), 0.0) @ PO.T(dx, 0.016, 0.0065), m['hardware'], 'hard'))
    if H.get('velcro') and H.get('velcro_geo'):    # v10: painted (helmets.py, H['velcro_paint'])
        # loop panels: crown panel, one each side above the rails, rear panel
        out.append(strip(np.radians(-32), np.radians(32), np.radians(46), np.radians(70), 0.0006, 0.0024, m['webbing']))
        for sgn in (1, -1):
            a0, a1 = sorted((sgn * np.radians(70), sgn * np.radians(114)))
            out.append(strip(a0, a1, np.radians(26), np.radians(36), 0.0006, 0.0022, m['webbing']))
        out.append(strip(np.radians(154), np.radians(206), np.radians(8), np.radians(22), 0.0006, 0.0022, m['webbing']))
    if H.get('cord'):
        out += nvg_cords(on, frame, surf, c, m, log=print)
    if H.get('counterweight'):
        out.append(PO.local_part(PO.rbox(0.085, 0.055, 0.028, 0.01, 2), frame(np.pi, np.radians(H.get('cw_el', 5)), 0.0) @ PO.T(0, 0.0, 0.014), m['fabric']))
    if H.get('goggles'):
        out += goggles(on, frame, c, H['goggles'], rim_el0=float((np.radians(per_az(H['rim_pts'], np.array(0.0))) if H.get('rim_pts')
                                                                   else rim_el(np.array(0.0), H['rim']))))
    if H.get('scrim'):
        import helmets as HG
        out += HG.scrim(on, H, c, rim_fn)
    if trees is not None and not retention_ctx:
        out += chin_strap(c, rim_fn, on, m, trees, H)
    for p in out:
        p['group'] = 'helmet'
    if retention_ctx:       # v10: the retention harness is built per body variant (helmets.retention)
        out[0]['helmet_ctx'] = dict(kind=kind, on=on, frame=frame, rim_fn=rim_fn, H=H, c=c, surf=surf, flare_fn=flare_fn)
    return out


def nvg_cords(on, frame, surf, c, m, rc=0.0022, n=36, sides=5, log=None):
    """models_v11: NVG shock cord (bungee) of a FAST-type high cut, one per side: from a hook moulded on the side edge of the
    NVG shroud, tight along the shell, over the side above the ARC rail, to a rear hook on the back of the shell beside the
    counterweight.  A taut cord over a convex shell lies on the shortest path: the polyline (ends fixed on the hooks) is
    relaxed to its shortest length while every point is kept >= rc + 0.5 mm off the shell (radially, the shell is star-shaped
    round c) and >= 18.5 deg elevation over the rail band (rails / end stops / headset adapters top out ~15.5 deg).  Round
    section (4.4 mm), 5 sides.  Returns parts (cords + 4 hooks)."""
    import packs as PK                                         # (packs imports kit)
    out = []
    hw = m['hardware']
    def lift(P, h):
        D = P - c; r = np.linalg.norm(D, axis=1)
        az = np.arctan2(D[:, 0], D[:, 2]); el = np.arcsin(np.clip(D[:, 1] / r, -1, 1))
        return az, el, r
    for sgn in (1, -1):
        Mf = frame(0.0, np.radians(8), 0.0)                    # shroud plate frame (plate: 70 x 44 x 6 mm, z 0..6 mm)
        Mh = Mf @ PO.T(sgn * 0.037, 0.009, 0.0035)
        out.append(PO.local_part(PO.rbox(0.012, 0.012, 0.007, 0.002, 1), Mh, hw, 'hard'))
        p0 = PO.xf(np.array([[sgn * 0.0425, 0.009, 0.0045]]), Mf)[0]
        ar, er = sgn * np.radians(150.0), np.radians(9.0)      # rear hook (beside the counterweight, which spans ~161..199 deg)
        Mr = frame(ar, er, 0.0)
        out.append(PO.local_part(PO.rbox(0.011, 0.016, 0.007, 0.002, 1), Mr @ PO.T(0, 0, 0.0035), hw, 'hard'))
        out.append(PO.local_part(PO.rbox(0.011, 0.004, 0.006, 0.0015, 1), Mr @ PO.T(0, 0.009, 0.0075), hw, 'hard'))   # hook lip
        p1 = PO.xf(np.array([[0.0, 0.0045, 0.0072 + rc * 0.4]]), Mr)[0]
        # initial guess: (az, el) path bulging up the side, on the offset surface
        t = np.linspace(0, 1, n)
        az0, el0, _ = lift(p0[None], 0); az0, el0 = az0[0], el0[0]
        A = az0 + (ar - az0) * t; E = el0 + (er - el0) * t + np.radians(14) * np.sin(np.pi * t)
        P = surf(A, E, rc + 0.0005); P[0] = p0; P[-1] = p1
        lo_rail = np.radians(18.5)
        for it in range(4000):
            Q = P.copy()
            Q[1:-1] = 0.5 * (P[:-2] + P[2:])
            az, el, r = lift(Q[1:-1], 0)
            band = (np.abs(az) > np.radians(62)) & (np.abs(az) < np.radians(122))
            el = np.where(band, np.maximum(el, lo_rail), el)
            rmin = np.linalg.norm(surf(az, el, rc + 0.0005) - c, axis=1)
            rr = np.maximum(r, rmin)
            Q[1:-1] = c + np.stack([np.cos(el) * np.sin(az), np.sin(el), np.cos(el) * np.cos(az)], 1) * rr[:, None]
            dmax = np.abs(Q - P).max(); P = Q
            if dmax < 2e-7:
                break
        az, el, r = lift(P, 0)
        gap = r - np.linalg.norm(surf(az, el, 0.0) - c, axis=1)
        if log:
            log(f'nvg cord {"LR"[sgn < 0]}: {it} iters, length {np.linalg.norm(np.diff(P, axis=0), axis=1).sum():.3f} m, '
                f'el {np.degrees(el).min():.1f}..{np.degrees(el).max():.1f} deg, centre-line height over the shell '
                f'{gap[1:-1].min() * 1000:.1f}..{gap[1:-1].max() * 1000:.1f} mm')
        Dn = P - c; Dn /= np.linalg.norm(Dn, axis=1, keepdims=True)
        cord = PK._sweep(P, Dn, rc, sides, hw)
        out.append(cord)
    return out


GOGGLE_STYLES = {
    # 6B34 (Ratnik) / ESS Profile copies: black moulded frame, smoke-grey lens, black elastic strap
    'ru': dict(frame='goggle_frame', lens='goggle_lens', strap='goggle_strap', foam='goggle_foam', A=45, hc=11.5),
    # Revision Desert Locust: tan frame, clear lens (reads light grey), coyote strap
    'ua': dict(frame='goggle_frame_tan', lens='goggle_lens_clear', strap='coyote_webbing', foam='goggle_foam', A=46, hc=12.0),
}


def goggles(on, frame, c, style, rim_el0=np.radians(6)):
    """ballistic goggles pushed up on the front of the helmet (lens facing forward / up, foam against the shell): moulded frame
    (foam gasket, rounded wall with vent slots, inner lip), one wrap-around lens with a nose notch, strap outriggers + clips at the
    frame ends, wide elastic strap round the helmet with an adjuster slider at the back.  All in the helmet's (az, el, h) frame."""
    S = GOGGLE_STYLES[style]
    A = np.radians(S['A']); hc = np.radians(S['hc'])
    e_b = rim_el0 + np.radians(9.0)                            # pushed up: bottom edge ~2 cm above the brim
    out = []
    n = 60
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    pe = 5.0
    U = np.sign(np.cos(t)) * np.abs(np.cos(t)) ** (2 / pe)
    V = np.sign(np.sin(t)) * np.abs(np.sin(t)) ** (2 / pe)
    def uv2ae(u, v):
        hh = hc * (1 - 0.25 * u ** 2)
        el = e_b + hc - np.radians(1.5) * u ** 2 + v * hh
        el = el + np.radians(6.0) * np.exp(-(u / 0.2) ** 2) * np.clip(-v, 0, 1) ** 3      # nose notch in the lower edge
        return u * A, el
    az, el = uv2ae(U, V)
    base, N = on(az, el, 0.0)
    Tn = np.roll(base, -1, 0) - np.roll(base, 1, 0); Tn /= np.linalg.norm(Tn, axis=1, keepdims=True)
    O = np.cross(Tn, N); O /= np.linalg.norm(O, axis=1, keepdims=True)
    cen, _ = on(0.0, float(e_b + hc), 0.0)
    if np.sum(O * (base - cen)) < 0:
        O = -O
    def ring(prof):
        return np.stack([base + O * o + N * h for o, h in prof], 0)          # (k, n, 3)
    def tube(prof, mat):
        P = ring(prof); k = len(prof)
        pos = P.reshape(-1, 3)
        tri = G.grid_tris(n, k, closed_u=True)
        uv = np.concatenate([np.stack([t * 0.06, np.full(n, j * 0.01)], 1) for j in range(k)])
        q = G.part(pos, tri, mat, uv)
        return G.orient_open(q, (P - base[None]).reshape(-1, 3))       # faces point away from the shell / lens interior
    # foam gasket against the shell, then the moulded frame wall up to the inner lip that holds the lens
    out.append(tube([(-0.004, 0.0015), (0.006, 0.0015), (0.0068, 0.0075)], S['foam']))
    out.append(tube([(0.0062, 0.0072), (0.0095, 0.0125), (0.0085, 0.0185), (0.0045, 0.0235), (-0.0005, 0.0248), (-0.0042, 0.0228)], S['frame']))
    # lens: star-shaped fill of the inner lip outline, slight dome
    ns = 4
    Lp = []
    uc, vc = 0.0, 0.12
    for s in np.linspace(0, 1, ns + 1)[1:]:
        u_ = uc + (U * 0.955 - uc) * s; v_ = vc + (V * 0.90 - vc) * s
        a_, e_ = uv2ae(u_, v_)
        p_, n_ = on(a_, e_, 0.0)
        Lp.append(p_ + n_ * (0.0226 + 0.0022 * (1 - s ** 2)))
    cp, cn = on(*uv2ae(np.array(uc), np.array(vc)), 0.0)
    pos = np.concatenate([np.asarray(cp).reshape(1, 3) + np.asarray(cn).reshape(1, 3) * 0.0248] + Lp)
    tri = [[0, 1 + i, 1 + (i + 1) % n] for i in range(n)]
    for r_ in range(ns - 1):
        a0 = 1 + r_ * n; a1 = 1 + (r_ + 1) * n
        for i in range(n):
            j = (i + 1) % n
            tri += [[a0 + i, a1 + i, a1 + j], [a0 + i, a1 + j, a0 + j]]
    lens = G.part(pos, np.array(tri), S['lens'], np.zeros((len(pos), 2)))
    out.append(G.orient_open(lens, pos - c))
    # vent slots along the top and bottom walls (dark recessed slots in the frame wall)
    for i in range(n):
        u, v = U[i], V[i]
        if abs(u) > 0.78 or abs(v) < 0.93 or (v < 0 and abs(u) < 0.3) or i % 3:
            continue
        M = PO.mat4(base[i] + O[i] * 0.0092 + N[i] * 0.0152, Tn[i], N[i], O[i])
        out.append(PO.local_part(PO.rbox(0.011, 0.0035, 0.002, 0.0008, 1), M, S['foam'], 'hard'))
    # strap outriggers + clips at the frame ends
    for sgn in (1, -1):
        i = int(np.argmin(np.abs(U - sgn) + np.abs(V)))
        M = PO.mat4(base[i] + O[i] * 0.011 + N[i] * 0.011, np.cross(N[i], O[i]), N[i], O[i])
        out.append(PO.local_part(PO.rbox(0.020, 0.012, 0.010, 0.003, 1), M, S['frame'], 'hard'))
        out.append(PO.local_part(PO.rbox(0.016, 0.006, 0.026, 0.002, 1), frame(sgn * (A + np.radians(9)), float(e_b + hc), 0.0035), S['frame'], 'hard'))
    # elastic strap (~38 mm) round the rest of the helmet, adjuster slider at the back
    es = float(e_b + hc) - np.radians(1.0)
    ab = np.linspace(A + np.radians(5), 2 * np.pi - A - np.radians(5), 64)
    ew = np.radians(8.0)
    Q = [on(ab, np.full_like(ab, es + d_), h_)[0] for d_, h_ in ((-ew, 0.0012), (-ew, 0.0034), (ew, 0.0034), (ew, 0.0012))]
    sp = np.concatenate(Q)
    out.append(G.orient_open(G.part(sp, G.grid_tris(64, 4), S['strap'], np.concatenate([np.stack([ab * 0.25, np.full(64, k * 0.01)], 1) for k in range(4)])), sp - c))
    out.append(PO.local_part(PO.rbox(0.028, 0.044, 0.004, 0.0015, 1), frame(np.pi, es, 0.0036), S['frame'], 'hard'))
    for dx in (-0.009, 0.009):
        out.append(PO.local_part(PO.rbox(0.003, 0.044, 0.0025, 0.001, 1), frame(np.pi, es, 0.0056) @ PO.T(dx, 0, 0), S['foam'], 'hard'))
    return out


def chin_strap(c, rim_fn, on, m, trees, H):
    """retention harness: front + rear strap from inside the rim on each side, joining below the ear, along the jaw to a chin
    cup.  The path is projected onto the skin (rays from the head centre into the head meshes of all body variants) and kept
    4 mm off it, so it lies on cheeks / jaw without cutting in."""
    def skin(d):
        d = d / np.linalg.norm(d); best = 0.0
        for t in trees:
            o = c + d * 0.25
            h = t.ray_cast(Vector(o), Vector(-d), 0.25)          # from outside inward: first hit = outer skin
            if h[0] is not None:
                best = max(best, 0.25 - h[3])
        return best if best > 0 else 0.11
    az_f, az_b = (np.radians(66), np.radians(116)) if H.get('rim_pts') else (np.radians(70), np.radians(112))
    def path(p0, d1, d2, n=10):
        """from point p0 (helmet) through skin directions d1 -> d2: radius = max(skin + 4 mm, straight line)"""
        pts = []
        dirs = [d1 + (d2 - d1) * u for u in np.linspace(0, 1, n)]
        r0 = np.linalg.norm(p0 - c); a0 = (p0 - c) / r0
        for k, u in enumerate(np.linspace(0, 1, 6)):            # helmet rim -> first skin point
            d = a0 * (1 - u) + (dirs[0] / np.linalg.norm(dirs[0])) * u; d /= np.linalg.norm(d)
            rr = max(skin(d) + 0.004, r0 * (1 - u) + (skin(dirs[0]) + 0.004) * u)
            pts.append(c + d * rr)
        for d in dirs[1:]:
            dn = d / np.linalg.norm(d); pts.append(c + dn * (skin(dn) + 0.004))
        return np.array(pts)
    def ribbon(pts, w, mat):
        t = np.gradient(pts, axis=0); t /= np.linalg.norm(t, axis=1, keepdims=True)
        nn = pts - c; nn /= np.linalg.norm(nn, axis=1, keepdims=True)
        sd = np.cross(t, nn); sd /= np.linalg.norm(sd, axis=1, keepdims=True)
        L0 = pts - sd * w / 2; L1 = pts + sd * w / 2
        V = np.concatenate([L0, L1, L0 + nn * 0.0018, L1 + nn * 0.0018]); n_ = len(pts)
        tri = []
        for i in range(n_ - 1):
            a, b, cc, d = i, i + 1, n_ + i + 1, n_ + i
            for off in (0, 2 * n_):
                A, B, C, D = a + off, b + off, cc + off, d + off
                tri += [[A, B, C], [A, C, D], [A, C, B], [A, D, C]]
        uvs = np.concatenate([np.stack([np.linspace(0, 1, n_), np.full(n_, v)], 1) for v in (0, 0.05, 0, 0.05)])
        q = G.part(V, np.asarray(tri), mat, uvs)
        q['nrm'] = np.concatenate([nn, nn, nn, nn]); return q
    out = []
    for sgn in (1, -1):
        fa, _ = on(sgn * az_f, rim_fn(sgn * az_f) + np.radians(1.5), -0.007)
        ra, _ = on(sgn * az_b, rim_fn(sgn * az_b) + np.radians(1.5), -0.007)
        J = np.array([sgn * 0.95, -0.55, 0.12]); K = np.array([sgn * 0.55, -0.85, 0.40]); C_ = np.array([sgn * 0.08, -0.80, 0.60])
        out.append(ribbon(path(np.asarray(fa).reshape(3), np.array([sgn * 0.90, -0.30, 0.30]), J, 6), 0.014, m['webbing']))
        out.append(ribbon(path(np.asarray(ra).reshape(3), np.array([sgn * 0.85, -0.25, -0.30]), J, 6), 0.014, m['webbing']))
        jaw = np.array([c + (d / np.linalg.norm(d)) * (skin(d / np.linalg.norm(d)) + 0.004) for d in [J + (K - J) * u for u in np.linspace(0, 1, 7)] + [K + (C_ - K) * u for u in np.linspace(0, 1, 7)[1:]]])
        out.append(ribbon(jaw, 0.016, m['webbing']))
        # buckle at the junction below the ear
        jn = J / np.linalg.norm(J); jp = c + jn * (skin(jn) + 0.006)
        up = np.array([0, 1.0, 0]) - jn * jn[1]; up /= np.linalg.norm(up)
        out.append(PO.local_part(PO.rbox(0.020, 0.024, 0.005, 0.002, 1), PO.mat4(jp, np.cross(up, jn), up, jn), m['hardware'], 'hard'))
    # chin cup
    cd = np.array([0, -0.80, 0.60]); cd /= np.linalg.norm(cd); cp = c + cd * (skin(cd) + 0.006)
    up = np.array([0, 0, 1.0]) - cd * cd[2]; up /= np.linalg.norm(up)
    out.append(PO.local_part(PO.rbox(0.046, 0.030, 0.007, 0.010, 2), PO.mat4(cp, np.cross(up, cd), up, cd), m['webbing'], 'hard'))
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
