"""Assault-trooper gear (both factions): armour add-ons (shoulder/upper-arm protectors, groin protector, side plates,
RU neck collar), extra grenade pouches, elbow pads, assault backpack, headset, Altyn-style heavy helmet, balaclavas.
All parts are tagged with a 'group' (= node name in the soldier GLB)."""
import numpy as np
from mathutils import Vector
import gear as G
import pouches as PO
import kit as K
import meshutil as MU


def _ray_r(trees, o, d, default=0.07):
    best = None
    for t in trees:
        h = t.ray_cast(Vector(o), Vector(d), 0.3)
        if h[0] is not None and (best is None or h[3] > best[3]):
            best = h
    return best[3] if best is not None else default


def limb_shell(trees, a, j, b, centre_dir, s0, s1, mat, half_ang=70, thick=0.011, gap=0.003, nu=11, nv=9, edge_s=0.025, edge_a=18, r_cap=None):
    """hard/padded shell wrapped around a limb near joint j: s<0 measured back along a->j, s>=0 along j->b.
    r_cap: clamp each row's ray radii to (row median + r_cap) so rays that run onto the trunk (at the shoulder) cannot bulge it"""
    rows = []
    sm = 0.5 * (s0 + s1); sh = 0.5 * (s1 - s0)
    for s in np.linspace(s0, s1, nv):
        if s < 0:
            p0, p1, ss = a, j, np.linalg.norm(j - a) + s
        else:
            p0, p1, ss = j, b, s
        ax = (p1 - p0) / np.linalg.norm(p1 - p0)
        e1 = centre_dir - ax * (centre_dir @ ax); e1 /= np.linalg.norm(e1); e2 = np.cross(ax, e1)
        o = p0 + ax * ss
        row = []
        for th in np.radians(np.linspace(-half_ang, half_ang, nu)):
            d = np.cos(th) * e1 + np.sin(th) * e2
            r = _ray_r(trees, o, d)
            e = min(1.0, (half_ang - abs(np.degrees(th))) / edge_a, (sh - abs(s - sm)) / edge_s + 0.15)
            row.append((o, d, r, max(e, 0.05)))
        if r_cap is not None:
            med = np.median([q[2] for q in row])
            row = [(o_, d_, min(r_, med + r_cap), e_) for (o_, d_, r_, e_) in row]
        rows.append(row)
    if r_cap is not None:      # rows: radius never shrinks toward the top edge (smooth cap over the shoulder)
        for k in range(len(rows) - 2, -1, -1):
            rows[k] = [(o_, d_, max(r_, 0.9 * rows[k + 1][i][2]), e_) for i, (o_, d_, r_, e_) in enumerate(rows[k])]
    outer = np.array([[o + d * (r + gap + 0.002 + thick * e) for (o, d, r, e) in row] for row in rows]).reshape(-1, 3)
    inner = np.array([[o + d * (r + gap) for (o, d, r, e) in row] for row in rows]).reshape(-1, 3)
    n = nu * nv
    Tg = G.grid_tris(nu, nv)
    T = [Tg, Tg[:, ::-1] + n]
    ring = [(0, i) for i in range(nu)] + [(jj, nu - 1) for jj in range(1, nv)] + [(nv - 1, i) for i in range(nu - 2, -1, -1)] + [(jj, 0) for jj in range(nv - 2, 0, -1)]
    ids = [jj * nu + i for jj, i in ring]
    rim = []
    for k in range(len(ids)):
        p, q = ids[k], ids[(k + 1) % len(ids)]
        rim += [[p + n, q + n, q], [p + n, q, p]]
    T.append(np.array(rim))
    pos = np.concatenate([outer, inner])
    # physical tiling coordinates (1 uv = 0.5 m, like the other gear): arc length around the limb x distance along it
    rr = np.array([[r + gap + thick * 0.5 for (o, d, r, e) in row] for row in rows])
    ths = np.radians(np.linspace(-half_ang, half_ang, nu))
    ss = np.linspace(s0, s1, nv)
    uv1 = np.stack([(ths[None, :] * rr) * 2.0, np.repeat(ss[:, None], nu, 1) * 2.0], -1).reshape(-1, 2)
    uv = np.concatenate([uv1, uv1])
    return G.orient_closed(G.part(pos, np.concatenate(T), mat, uv))


def armour(env, R, fac):
    """6B45-assault style (RU) / heavy JPC+ (UA) add-ons"""
    m = K.RU_MATS if fac == 'ru' else K.UA_MATS
    sk = R['skel']; J = lambda n: sk.head[sk.idx[n]]
    out = []
    # side plates over the cummerbund
    for sgn in (1, -1):
        sp = G.env_panel(env, sgn * np.pi / 2, 1.13, 0.072, 0.088, 0.016, gap=0.019, chamfer=0.0, mat=m['fabric'], nu=9, nv=9, rad=0.02)
        out += K.tag([G.orient_closed(sp)], 'armor_assault')
    # groin protector hanging from the bottom of the front section (see groin_flap; skinned pelvis -> thighs)
    out += K.tag(groin_flap(env, fac), 'armor_groin')
    if fac == 'ru':
        # neck/throat collar (6B45 assault configuration)
        col = G.band(env, 1.415, 1.475, -2.1, 2.1, 0.012, 0.014, nu=26, nv=3, mat=m['fabric'])
        out += K.tag([G.orient_closed(col)], 'armor_assault')
    # shoulder / upper-arm protectors (brassards), rigid to the upper arm
    for side, sx in (('Left', 1), ('Right', -1)):
        cd = np.array([sx * 1.0, 0.35, 0.0]); cd /= np.linalg.norm(cd)
        # 6B45 soft shoulder protector: padded flap sewn to the shoulder strap, over the deltoid (~15 cm), hugging the arm
        p = limb_shell(env.trees, J(side + 'Shoulder'), J(side + 'Arm'), J(side + 'ForeArm'), cd, -0.025, 0.125, m['fabric'],
                       half_ang=82, thick=0.011, gap=0.003, nu=12, nv=9, edge_s=0.025, r_cap=0.012)
        p['side'] = side
        out += K.tag([p], 'armor_arms')
    return out


def groin_flap(env, fac):
    """soft groin protector (6B45 heavy set / UA plate-carrier groin pad): tapered padded flap conforming to the lower belly
    and bridging the fronts of both thighs, hung from the bottom edge of the front section (RU) / under the plate carrier (UA)
    with a webbing hanger strip at the top"""
    m = K.RU_MATS if fac == 'ru' else K.UA_MATS
    if fac == 'ru':
        y_top, L, w_top, w_bot = K.RU_VEST['bottom'] + 0.022, 0.235, 0.25, 0.135
    else:
        y_top, L, w_top, w_bot = 1.105, 0.235, 0.23, 0.145
    y_bot = y_top - L
    zc = float(env.zcen(0.95))
    nu, nv = 9, 10
    ys = np.linspace(y_top, y_bot, nv)
    probe = np.radians(np.linspace(-38, 38, 15))
    rr = []
    for y in ys:
        o = np.array([0.0, y, zc]); best = 0.0
        for a in probe:
            r = _ray_r(env.trees, o, np.array([np.sin(a), 0, np.cos(a)]), default=0.0)
            best = max(best, r * np.cos(a))          # forward-most body surface (belly, then the fronts of the thighs)
        rr.append(best)
    rr = np.array(rr)
    if y_top > 0.93:     # over the vest / belt: at least the envelope front + the vest section
        rr[ys > 0.93] = np.maximum(rr[ys > 0.93], env.r(ys[ys > 0.93], 0.0) + (0.03 if fac == 'ru' else 0.012))
    rr = np.convolve(np.pad(rr, 2, mode='edge'), np.ones(5) / 5, mode='valid')
    tt = (y_top - ys) / L
    rr = rr + 0.010 + 0.012 * tt                    # hangs slightly off the thighs, more toward the bottom
    outer, inner = [], []
    thick = 0.013
    for j, (y, r, t) in enumerate(zip(ys, rr, tt)):
        hw = 0.5 * (w_top + (w_bot - w_top) * t ** 0.8)
        for i, u in enumerate(np.linspace(-1, 1, nu)):
            a = u * hw / r
            d = np.array([np.sin(a), 0.0, np.cos(a)])
            e = min(1.0, (1 - abs(u)) * hw / 0.012, (min(t, 1 - t) * L) / 0.012 + 0.15)
            base = np.array([0.0, y, zc]) + d * r
            inner.append(base); outer.append(base + d * (0.002 + thick * max(np.sqrt(max(e, 0)), 0.12)))
    outer = np.array(outer); inner = np.array(inner)
    n = nu * nv
    Tg = G.grid_tris(nu, nv)
    T = [Tg, Tg[:, ::-1] + n]
    ring = [(0, i) for i in range(nu)] + [(jj, nu - 1) for jj in range(1, nv)] + [(nv - 1, i) for i in range(nu - 2, -1, -1)] + [(jj, 0) for jj in range(nv - 2, 0, -1)]
    ids = [jj * nu + i for jj, i in ring]
    rim = []
    for k in range(len(ids)):
        p_, q_ = ids[k], ids[(k + 1) % len(ids)]
        rim += [[p_ + n, q_ + n, q_], [p_ + n, q_, p_]]
    T.append(np.array(rim))
    pos = np.concatenate([outer, inner])
    uv1 = np.stack([np.tile(np.linspace(-1, 1, nu), nv) * 0.5 * w_top * 2.0, np.repeat(ys, nu) * -2.0], 1)
    out = [G.orient_closed(G.part(pos, np.concatenate(T), m['fabric'], np.concatenate([uv1, uv1])))]
    # webbing hanger strip across the top + two short straps
    Mt = PO.mat4(np.array([0.0, y_top - 0.012, zc + rr[0] + thick + 0.003]), np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0]))
    out.append(PO.local_part(PO.rbox(w_top * 0.82, 0.024, 0.005, 0.002, 1), Mt, m['webbing'], 'hard'))
    for sx in (-1, 1):
        out.append(PO.local_part(PO.rbox(0.022, 0.05, 0.004, 0.0015, 1), Mt @ PO.T(sx * w_top * 0.3, 0.02, -0.001), m['webbing'], 'hard'))
    for q in out:
        q['yr'] = (y_top, y_bot)      # skinning range (build_soldier.groin_weights)
    return out


def assault_pouches(env, fac):
    m = K.RU_MATS if fac == 'ru' else K.UA_MATS
    out = []
    side_M = K.side_M
    if fac == 'ru':
        # models_v13b: ONE grenade pouch per side between the mag shingle and the side armour (the two at 0.80 / 1.05 rad sat
        # 25 mm inside the mag pouches and inside each other)
        for th in (1.08, -1.08):
            out += PO.grenade_pouch(m, side_M(env, th, 1.075, 0.016), w=0.066, h=0.095)
        out += PO.grenade_pouch(m, side_M(env, 1.57, 1.10, 0.038))
        out += PO.ifak(m, side_M(env, -1.57, 1.10, 0.038), w=0.13)
        out += PO.dump_pouch(m, side_M(env, -(np.pi - 0.75), 1.015, 0.015))     # v13b: under the assault pack (was 37 mm inside it)
    else:
        for th in (1.08, -1.08):        # models_v13b: one per side (see above)
            out += PO.grenade_pouch(m, side_M(env, th, 1.08, 0.016), w=0.066, h=0.095)
        pass   # v10: radio + PTT per preset (comms.py)
        out += PO.ifak(m, side_M(env, -1.57, 1.10, 0.036), w=0.13)
        # (models_v13b: side tourniquet dropped - it sat inside the IFAK / side armour; the front tourniquet stays)
    return K.tag(out, 'pouches_assault')


def elbowpads(env, R, fac):
    sk = R['skel']; J = lambda n: sk.head[sk.idx[n]]
    out = []
    for side, sx in (('Left', 1), ('Right', -1)):
        cd = np.array([sx * 0.55, 0.0, -1.0]); cd /= np.linalg.norm(cd)
        p = limb_shell(env.trees, J(side + 'Arm'), J(side + 'ForeArm'), J(side + 'Hand'), cd, -0.045, 0.055, 'kneepad_shell',
                       half_ang=62, thick=0.010, gap=0.003, nu=9, nv=8, edge_s=0.02)
        p['side'] = side
        out.append(p)
    return K.tag(out, 'elbowpads')


def assault_backpack(env, fac):
    m = K.RU_MATS if fac == 'ru' else K.UA_MATS
    out = []
    y = 1.25
    p = env.point(y, np.pi, 0.004 + 0.022 + 0.012)
    n = env.normal(y, np.pi)
    up = np.array([0, 1.0, 0]); side = np.cross(up, n)
    M = PO.mat4(p, side, up, n)
    w, h, d = 0.25, 0.30, 0.11
    out.append(PO.local_part(PO.rbox(w, h, d, 0.03, 3, taper_top=0.08), M @ PO.T(0, 0.0, d / 2), m['fabric']))
    out.append(PO.local_part(PO.rbox(w * 0.75, h * 0.4, 0.035, 0.015, 2), M @ PO.T(0, -0.05, d + 0.014), m['fabric']))
    for k in range(3):
        out.append(PO.local_part(PO.rbox(w * 0.8, 0.022, 0.004, 0.001, 1), M @ PO.T(0, 0.11 - k * 0.045, d + 0.0005), m['webbing'], 'hard'))
    # two grenade pouches + a radio on the pack
    out += PO.grenade_pouch(m, M @ PO.T(-0.135, -0.06, 0.03) @ _roty(-70))
    out += PO.radio_pouch(m, M @ PO.T(0.135, -0.05, 0.03) @ _roty(70), antenna=0.25)
    for q in out:
        q['group'] = 'backpack_assault'
    return out


def _roty(deg):
    a = np.radians(deg); c, s = np.cos(a), np.sin(a)
    Mr = np.eye(4); Mr[:3, :3] = [[c, 0, s], [0, 1, 0], [-s, 0, c]]
    return Mr


def headset(c, r, fac):
    """active hearing protection: ear cups + headband stub + mic boom (left)"""
    out = []
    for sx in (1, -1):
        p = c + np.array([sx * (r[0] + 0.013), -0.045, -0.004])
        Mc = PO.mat4(p, np.array([0, 0, -float(sx)]), np.array([0, 1.0, 0]), np.array([sx, 0, 0.0]))
        # cup: cylinder along the local y axis -> rotate so its axis points outward (local z)
        Rx = np.eye(4); Rx[:3, :3] = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
        out.append(PO.local_part(PO.cyl(0.040, 0.028, 12, 0.034), Mc @ Rx, 'radio_black', 'hard'))
        out.append(PO.local_part(PO.rbox(0.016, 0.05, 0.012, 0.004, 1), Mc @ PO.T(0, 0.05, 0.012), 'radio_black', 'hard'))
    # mic boom on the left cup toward the mouth
    p0 = c + np.array([r[0] + 0.03, -0.06, 0.01])
    p1 = c + np.array([0.035, -0.105, r[2] + 0.012])
    d = p1 - p0; L = np.linalg.norm(d); d /= L
    up = np.cross(d, np.array([0, 1.0, 0])); up /= np.linalg.norm(up)
    Mb = PO.mat4(p0, np.cross(d, up), d, up)
    out.append(PO.local_part(PO.cyl(0.0035, L, 6), Mb, 'radio_black', 'hard'))
    out.append(PO.local_part(PO.rbox(0.016, 0.012, 0.012, 0.004, 1), PO.mat4(p1, np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0])), 'radio_black', 'hard'))
    return K.tag(out, 'headset')


def balaclava(R, vn, fac):
    """knitted balaclava over the head: offset copy of the head mesh (same skin weights) with a clean eye slot - the triangles are
    clipped along a smooth rounded-rectangle line (no saw-tooth of whole dropped triangles) and the slot edge gets a knit hem that
    turns in to the skin, so no gap or skin shows at the edge"""
    v = R['variants'][vn]; H = R['head']
    lm = v['lm']
    P0 = v['head_pos']; N0 = v['head_nrm']
    P = P0 + N0 * 0.0035
    T = H['tri']; UV = H['uv'] * 4.0; W = np.asarray(H['W'], float)
    ec = (lm['eyeL'] + lm['eyeR']) / 2
    a_, b_, ex = 0.060, 0.0175, 4.0
    def fval(Q):                     # > 0 = keep (outside the slot); slot only on the face
        d = (np.abs((Q[:, 0] - ec[0]) / a_) ** ex + np.abs((Q[:, 1] - ec[1] - 0.002) / b_) ** ex) ** (1 / ex) - 1.0
        return np.where(Q[:, 2] > ec[2] - 0.035, d, 1.0)
    f = fval(P0)
    low = P0[:, 1] < lm['neck'][1] - 0.02 if 'neck' in lm else np.zeros(len(P0), bool)
    pos = [P]; nrm = [N0]; uv = [UV]; ww = [W]; base = len(P)
    split = {}
    def cut(i, j):
        k = (min(i, j), max(i, j))
        if k not in split:
            t = f[i] / (f[i] - f[j])
            pos.append(((1 - t) * P[i] + t * P[j])[None]); n_ = (1 - t) * N0[i] + t * N0[j]; nrm.append((n_ / np.linalg.norm(n_))[None])
            uv.append(((1 - t) * UV[i] + t * UV[j])[None]); ww.append(((1 - t) * W[i] + t * W[j])[None])
            split[k] = base + len(split)
        return split[k]
    tris = []; segs = []
    for tri in T:
        if low[tri].any():
            continue
        inside = f[tri] > 0
        if inside.all():
            tris.append(tri); continue
        if not inside.any():
            continue
        # Sutherland-Hodgman against f > 0
        poly = []; cutp = []
        for e in range(3):
            i, j = tri[e], tri[(e + 1) % 3]
            if f[i] > 0:
                poly.append(i)
            if (f[i] > 0) != (f[j] > 0):
                c_ = cut(i, j); poly.append(c_); cutp.append(c_)
        for k in range(1, len(poly) - 1):
            tris.append([poly[0], poly[k], poly[k + 1]])
        if len(cutp) == 2:
            segs.append(cutp)
    pos = np.concatenate(pos); nrm = np.concatenate(nrm); uv = np.concatenate(uv); ww = np.concatenate(ww)
    # hem: each slot-edge segment gets a strip turned in toward the skin (both windings: seen from either side)
    nb = len(pos); hp, hn, hu, hw = [], [], [], []
    hem_of = {}
    for sg in segs:
        for vi in sg:
            if vi not in hem_of:
                hem_of[vi] = nb + len(hem_of)
                hp.append(pos[vi] - nrm[vi] * 0.0042); hn.append(nrm[vi]); hu.append(uv[vi]); hw.append(ww[vi])
    for i, j in segs:
        a2, b2 = hem_of[i], hem_of[j]
        tris += [[i, j, b2], [i, b2, a2], [i, b2, j], [i, a2, b2]]
    if hp:
        pos = np.concatenate([pos, hp]); nrm = np.concatenate([nrm, hn]); uv = np.concatenate([uv, hu]); ww = np.concatenate([ww, hw])
    tris = np.asarray(tris, int)
    used = np.unique(tris); remap = -np.ones(len(pos), int); remap[used] = np.arange(len(used))
    mat = 'balaclava_ru' if fac == 'ru' else 'balaclava_ua'
    p = dict(pos=pos[used], tri=remap[tris], mat=mat, uv=uv[used], nrm=nrm[used], W=ww[used], group='balaclava_' + vn)
    return p
