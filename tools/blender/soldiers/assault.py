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


def limb_shell(trees, a, j, b, centre_dir, s0, s1, mat, half_ang=70, thick=0.011, gap=0.003, nu=11, nv=9, edge_s=0.025, edge_a=18):
    """hard/padded shell wrapped around a limb near joint j: s<0 measured back along a->j, s>=0 along j->b"""
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
        rows.append(row)
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
    uv = np.concatenate([np.array([[i / nu * 0.25, jj / nv * 0.25] for jj in range(nv) for i in range(nu)])] * 2)
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
    # groin protector hanging from the front plate (rigid to the pelvis)
    Mg = PO.mat4(np.array([0.0, 1.11, 0.176]), np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), np.array([0, 0, 1.0]))
    Mg = Mg @ PO.T(0, 0, 0, rx=np.radians(-6))
    out += K.tag([PO.local_part(PO.rbox(0.17, 0.20, 0.016, 0.012, 2, taper_top=-0.0), Mg @ PO.T(0, -0.10, 0.008), m['fabric'])], 'armor_groin')
    out += K.tag([PO.local_part(PO.rbox(0.14, 0.012, 0.022, 0.004, 1), Mg @ PO.T(0, -0.005, 0.01), m['webbing'], 'hard')], 'armor_groin')
    if fac == 'ru':
        # neck/throat collar (6B45 assault configuration)
        col = G.band(env, 1.415, 1.475, -2.1, 2.1, 0.012, 0.014, nu=26, nv=3, mat=m['fabric'])
        out += K.tag([G.orient_closed(col)], 'armor_assault')
    # shoulder / upper-arm protectors (brassards), rigid to the upper arm
    for side, sx in (('Left', 1), ('Right', -1)):
        cd = np.array([sx * 1.0, 0.35, 0.0]); cd /= np.linalg.norm(cd)
        p = limb_shell(env.trees, J(side + 'Shoulder'), J(side + 'Arm'), J(side + 'ForeArm'), cd, -0.035, 0.15, m['fabric'],
                       half_ang=95, thick=0.014, gap=0.004, nu=12, nv=9, edge_s=0.03)
        p['side'] = side
        out += K.tag([p], 'armor_arms')
    return out


def assault_pouches(env, fac):
    m = K.RU_MATS if fac == 'ru' else K.UA_MATS
    out = []
    side_M = K.side_M
    if fac == 'ru':
        for th in (0.80, 1.05):
            out += PO.grenade_pouch(m, side_M(env, th, 1.075, 0.016), w=0.066, h=0.095)
        for th in (-0.80, -1.05):
            out += PO.grenade_pouch(m, side_M(env, th, 1.075, 0.016), w=0.066, h=0.095)
        out += PO.grenade_pouch(m, side_M(env, 1.57, 1.10, 0.038))
        out += PO.ifak(m, side_M(env, -1.57, 1.10, 0.038), w=0.13)
        out += PO.dump_pouch(m, side_M(env, -(np.pi - 0.75), 1.07, 0.015))
    else:
        for th in (0.78, 1.02, -0.78, -1.02):
            out += PO.grenade_pouch(m, side_M(env, th, 1.08, 0.016), w=0.066, h=0.095)
        out += PO.radio_pouch(m, side_M(env, 1.57, 1.10, 0.036), antenna=0.22)
        out += PO.ifak(m, side_M(env, -1.57, 1.10, 0.036), w=0.13)
        out += PO.tourniquet(m, side_M(env, -1.3, 1.08, 0.016))
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
    """knitted balaclava over the head with an eye slot: offset copy of the head mesh (same skin weights)"""
    v = R['variants'][vn]; H = R['head']
    lm = v['lm']
    P = v['head_pos'] + v['head_nrm'] * 0.0035
    T = H['tri']
    ec = (lm['eyeL'] + lm['eyeR']) / 2
    Pc = P[T].mean(1)
    # drop the eye slot (front, at eye height) and anything at/below the lower neck
    slot = (np.abs(Pc[:, 1] - ec[1]) < 0.021) & (np.abs(Pc[:, 0]) < 0.062) & (Pc[:, 2] > ec[2] - 0.035)
    low = Pc[:, 1] < lm['neck'][1] - 0.02 if 'neck' in lm else np.zeros(len(T), bool)
    keep = ~(slot | low)
    Tk = T[keep]
    used = np.unique(Tk); remap = -np.ones(len(P), int); remap[used] = np.arange(len(used))
    mat = 'balaclava_ru' if fac == 'ru' else 'balaclava_ua'
    p = dict(pos=P[used], tri=remap[Tk], mat=mat, uv=H['uv'][used] * 4.0, nrm=v['head_nrm'][used], W=H['W'][used], group='balaclava_' + vn)
    return p
