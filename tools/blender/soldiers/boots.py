"""Combat boots (parametric): lasted upper fitted to the MakeHuman foot (ring sections measured from the foot surface
+ margin), padded collar, lace panel with eyelets / speed hooks and crossed laces, lugged rubber outsole with heel
block, perimeter tread and bottom lugs.  All in GL coords (rest pose), left boot built then mirrored.

used by build_soldier.py:  parts = boots.build(B)  -> {'Left': {...}, 'Right': {...}}"""
import numpy as np
import meshutil as MU

M = 16            # vertices per ring
N_EXP = 2.6       # superellipse exponent


def _foot_samples(B, sx):
    o = B.o
    V = B.vA
    T = []
    for fi in B.body_faces:
        f = o['f'][fi]
        P = V[f]
        if P[:, 1].max() > 0.30 or P[:, 0].mean() * sx < 0.06:
            continue
        for k in range(1, len(f) - 1):
            T.append((f[0], f[k], f[k + 1]))
    T = np.array(T)
    rng = np.random.default_rng(1)
    S = []
    for _ in range(24):
        b = rng.dirichlet((1, 1, 1), len(T))
        S.append(np.einsum('nk,nkd->nd', b, V[T]))
    S.append(V[np.unique(T)])
    return np.concatenate(S)


def _superellipse(cv, h_in, h_out, cw, a, taper, u, l, origin, n=N_EXP, n_out=None):
    """ring points: in-plane axis u (toward the 'outer' side), lateral l; extents measured from origin.
    n_out: exponent on the outer half (large -> flat, square bottom)"""
    th = 2 * np.pi * np.arange(M) / M
    c, s = np.cos(th), np.sin(th)
    nn = np.where(c >= 0, n_out or n, n)
    v = np.where(c >= 0, h_out, h_in) * np.sign(c) * np.abs(c) ** (2 / nn)
    n = nn
    aw = a * (1 + taper * c)
    w = cw + aw * np.sign(s) * np.abs(s) ** (2 / n)
    return origin[None] + u[None] * (cv + v)[:, None] + l[None] * w[:, None]


def build_left(B, sx=1):
    sk = B.skel
    I = sk.idx
    side = 'Left' if sx > 0 else 'Right'
    S = _foot_samples(B, sx)
    ank = sk.head[I[side + 'Foot']]; toe = sk.head[I[side + 'ToeBase']]
    # foot frame: heel reference H on the ground, forward f (horizontal), lateral l (outward = +x for the left foot)
    zb, zt = S[:, 2].min(), S[:, 2].max()
    hx = np.median(S[(S[:, 2] < zb + 0.03) & (S[:, 1] < 0.05), 0])
    tx = np.median(S[(S[:, 2] > zt - 0.05) & (S[:, 1] < 0.04), 0])
    f = np.array([tx - hx, 0, zt - zb]); f /= np.linalg.norm(f)
    yv = np.array([0, 1.0, 0])
    l = np.cross(yv, f)                        # +x-ish
    H = np.array([hx, 0.0, zb]) - f * 0.016    # boot heel back reference (z_f = 0 at boot back)
    to_f = lambda p: np.stack([(p - H) @ f, p[..., 1] if p.ndim > 1 else p[1], (p - H) @ l], -1) if p.ndim > 1 else np.array([(p - H) @ f, p[1], (p - H) @ l])
    Sf = to_f(S)                               # (z_f, y, lat)
    Lf = (zt - zb) + 0.016 + 0.016             # boot length
    # shank centre (sagittal z_f, lateral) as a function of height
    leg = sk.head[I[side + 'Leg']]
    def shank(y):
        t = (y - ank[1]) / (leg[1] - ank[1])
        p = ank + (leg - ank) * t
        return to_f(p)

    sole_top = lambda zf: np.interp(zf, [0, 0.07, 0.11, 0.17, Lf], [0.030, 0.030, 0.024, 0.021, 0.021])
    sole_bot = lambda zf: np.interp(zf, [0, 0.075, 0.085, 0.16, Lf - 0.05, Lf], [0.0, 0.0, 0.004, 0.0, 0.0, 0.009])

    def measure(origin, u, tol=0.005, radius=0.14):
        """foot section in the plane through origin spanned by u and l: extents along u (min, max) and lateral"""
        nrm = np.cross(u, np.array([0, 0, 1.0]))   # in (z_f, y, lat) coords: plane normal within sagittal plane
        d = (Sf - origin) @ nrm
        m = (np.abs(d) < tol) & (np.linalg.norm(Sf - origin, axis=1) < radius)
        P = Sf[m]
        v = (P - origin) @ u
        w = P[:, 2]
        return v, w

    rings = []
    # ---- foot rings: vertical sections (toe -> instep)
    zfs = [Lf - 0.006, Lf - 0.02, Lf - 0.045, Lf - 0.08, Lf - 0.115]
    for zf in zfs:
        o = np.array([zf, 0.10, 0.0])
        v, w = measure(o, np.array([0, -1.0, 0]), tol=0.006)
        top = 0.10 - (v.min() if len(v) else 0.06)
        toebox = 0.013 if zf > Lf - 0.09 else 0.010
        y_top = max(top + toebox, sole_top(zf) + 0.03)
        y_bot = sole_top(zf) - 0.006
        cw = 0.5 * (w.min() + w.max()) if len(w) else 0.0
        a = 0.5 * (w.max() - w.min()) + 0.009 if len(w) else 0.03
        rings.append(dict(kind='foot', o=np.array([zf, y_bot, 0]), ext=(y_top - y_bot, 0.0), cw=cw, a=a, taper=0.10))
    # ---- elbow rings: planes through a pivot in front of / above the instep (centre of curvature outside the boot)
    pivot = np.array([Lf - 0.15, 0.165, 0.0])
    for ang in (0, 15, 30, 45, 60, 75, 90):
        r = np.radians(ang)
        u = np.array([-np.sin(r), -np.cos(r), 0.0])
        v, w = measure(pivot, u, tol=0.006, radius=0.26)
        keep = v > 0.005
        v, w = v[keep], w[keep]
        vin = v.min() - 0.010
        vout = v.max() + 0.010
        if u[1] < -1e-3:
            for t in np.linspace(vin + 0.01, vout, 80):
                p = pivot + u * t
                if p[1] < sole_top(p[0]) - 0.006:
                    vout = t; break
        cw = 0.5 * (w.min() + w.max()); a = 0.5 * (w.max() - w.min()) + 0.009
        rings.append(dict(kind='fan', o=pivot.copy(), u=u, ext=(-vin, vout), cw=cw, a=a, taper=0.08 * np.cos(r)))
    # ---- shaft rings: horizontal sections (u = backward)
    for y in (0.20, 0.240):
        sc = shank(y)
        o = np.array([sc[0], y, 0.0])
        v, w = measure(o, np.array([-1.0, 0, 0]), tol=0.008, radius=0.12)
        vin = -v.min() + 0.010; vout = v.max() + 0.010
        cw = 0.5 * (w.min() + w.max()); a = 0.5 * (w.max() - w.min()) + 0.010
        rings.append(dict(kind='shaft', o=o, u=np.array([-1.0, 0, 0]), ext=(vin, vout), cw=cw, a=a, taper=0.0))
    # smooth lateral params along the rings (1-2-1), keep the ends
    for k in ('a', 'cw'):
        arr = np.array([r[k] for r in rings])
        sm = arr.copy(); sm[1:-1] = 0.25 * arr[:-2] + 0.5 * arr[1:-1] + 0.25 * arr[2:]
        for r, x in zip(rings, sm):
            r[k] = x
    # top shaft a touch wider (bloused trousers sit over it), collar padding
    rings[-1]['a'] += 0.004; rings[-1]['ext'] = (rings[-1]['ext'][0] + 0.004, rings[-1]['ext'][1] + 0.006)
    # ---- build ring vertex loops (foot-frame coords: z_f, y, lat)
    loops = []
    for r in rings:
        u3 = r.get('u')
        if r['kind'] == 'foot':   # foot ring defined bottom-up: origin at bottom, extent up
            h = r['ext'][0] / 2
            o = r['o'] + np.array([0, h, 0])
            P = _superellipse(0.0, h, h, r['cw'], r['a'], r['taper'], np.array([0, -1.0, 0]), np.array([0, 0, 1.0]), o, n_out=7.0)
        else:
            vin, vout = r['ext']
            cv = (vout - vin) / 2; h = (vout + vin) / 2
            nout = 7.0 if r['kind'] == 'fan' and u3[1] < -0.5 else (4.0 if r['kind'] == 'fan' else None)
            P = _superellipse(cv, h, h, r['cw'], r['a'], r['taper'], u3, np.array([0, 0, 1.0]), r['o'], n_out=nout)
        loops.append(P)
    # collar: rolled inward lip at the top
    top = loops[-1]
    cen = top.mean(0)
    lip = cen + (top - cen) * 0.86 - np.array([0, 0.012, 0])
    loops.append(top + np.array([0, 0.008, 0]) + (top - cen) * 0.04)
    loops.append(lip)
    nL = len(loops)
    # toe tip cap
    tip = loops[0].mean(0) + np.array([0.008, 0, 0])
    # ---- upper mesh
    pos = np.concatenate(loops + [tip[None]])
    tri = []
    for k in range(nL - 1):
        for j in range(M):
            a, b = k * M + j, k * M + (j + 1) % M
            c, d = (k + 1) * M + (j + 1) % M, (k + 1) * M + j
            tri += [(a, b, c), (a, c, d)]
    ti = nL * M
    for j in range(M):
        tri.append((ti, (j + 1) % M, j))
    tri = np.array(tri)
    uv = np.stack([np.tile(np.arange(M) / M, nL), np.repeat(np.arange(nL) / nL, M)], 1)
    uv = np.concatenate([uv, [[0.5, 0.0]]])
    # colour: toe cap & heel counter slightly darker/scuffed, collar padding darker
    col = np.ones((len(pos), 3))
    th = 2 * np.pi * np.arange(M) / M
    for k in range(nL):
        idx = np.arange(k * M, (k + 1) * M)
        if k <= 2:
            col[idx] *= 0.82
        if len(zfs) + 2 <= k <= len(zfs) + 5:   # heel counter region (outer side of the fan rings)
            col[idx] *= np.where(np.cos(th) > 0.2, 0.8, 1.0)[:, None]
        if k >= nL - 2:
            col[idx] *= 0.7
    for k in range(len(zfs) - 2, nL - 2):
        col[k * M + M // 2] *= 0.86
    col[-1] *= 0.82
    upper = dict(pos=pos, tri=tri, uv=uv, col=col)
    # ---- lace panel: resample the front centre line (theta = pi) at equal spacing from the instep to the top
    nR = len(rings)
    k0 = len(zfs) - 2
    C = np.array([loops[k][M // 2] for k in range(k0, nR)])
    Lft = np.array([loops[k][M // 2 + 1] for k in range(k0, nR)])
    Rgt = np.array([loops[k][M // 2 - 1] for k in range(k0, nR)])
    Ctr = np.array([loops[k].mean(0) for k in range(k0, nR)])
    seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(C, axis=0), axis=1))]
    ss = np.linspace(0.018, seg[-1] - 0.010, 8)
    interp = lambda A, x: np.stack([np.interp(x, seg, A[:, i]) for i in range(3)], -1)
    lace_rows = []
    for x in ss:
        c, pl, pr, ctr = interp(C, x), interp(Lft, x), interp(Rgt, x), interp(Ctr, x)
        el = c + (pl - c) * (0.016 / max(abs(pl[2] - c[2]), 1e-4))
        er = c + (pr - c) * (0.016 / max(abs(pr[2] - c[2]), 1e-4))
        n = c - ctr; n[2] = 0; n /= np.linalg.norm(n)
        lace_rows.append((el, er, c, n))
    # outward normal estimate per row (from the ring centre)
    lace_tri, lace_pos = [], []
    met_pos, met_tri = [], []
    def add_quad(store_p, store_t, a, b, c, d):
        n0 = len(store_p)
        store_p += [a, b, c, d]; store_t += [(n0, n0 + 1, n0 + 2), (n0, n0 + 2, n0 + 3)]
    rows = lace_rows
    def outward(k, p):
        return rows[k][3]
    wl = 0.0022
    for k in range(len(rows)):
        el, er, cf, _ = rows[k]
        n = outward(k, cf)
        hook = k >= len(rows) - 2
        for e, sgn in ((el, 1), (er, -1)):
            # eyelet / speed hook: small square boss on the surface
            p = e + n * 0.0015
            t1 = np.array([0, 0, 1.0]) * 0.0032
            t2 = np.cross(n, t1 / 0.0032) * 0.0032
            if not hook:
                add_quad(met_pos, met_tri, p - t1 - t2, p + t1 - t2, p + t1 + t2, p - t1 + t2)
            else:
                q = p + n * 0.004
                add_quad(met_pos, met_tri, p - t1 - t2 * 0.6, p + t1 - t2 * 0.6, q + t1 - t2 * 0.6, q - t1 - t2 * 0.6)
                add_quad(met_pos, met_tri, q - t1 - t2 * 0.6, q + t1 - t2 * 0.6, q + t1 + t2 * 0.8, q - t1 + t2 * 0.8)
        if k + 1 < len(rows):
            el2, er2, cf2, _ = rows[k + 1]
            n2 = outward(k + 1, cf2)
            for a0, b0, na, nb in ((el, er2, n, n2), (er, el2, n, n2)):
                a1 = a0 + na * 0.003; b1 = b0 + nb * 0.003
                mid = (a1 + b1) / 2 + (na + nb) / 2 * 0.0025
                d = b1 - a1; d /= np.linalg.norm(d)
                side_ = np.cross((na + nb) / 2, d); side_ /= np.linalg.norm(side_)
                for p0, p1 in ((a1, mid), (mid, b1)):
                    add_quad(lace_pos, lace_tri, p0 - side_ * wl, p1 - side_ * wl, p1 + side_ * wl, p0 + side_ * wl)
        else:
            # top: bow knot stub + bar
            a1 = el + n * 0.004; b1 = er + n * 0.004
            d = b1 - a1; d /= np.linalg.norm(d)
            up = np.array([0, 1.0, 0])
            add_quad(lace_pos, lace_tri, a1 - up * wl, b1 - up * wl, b1 + up * wl, a1 + up * wl)
    # pull loop at the back top
    bt = loops[nL - 3][0]
    nb = np.array([-1.0, 0, 0])
    lp = [bt + np.array([0, -0.01, 0]), bt + nb * 0.006 + np.array([0, 0.012, 0]), bt + nb * 0.003 + np.array([0, 0.018, 0])]
    for p0, p1 in zip(lp[:-1], lp[1:]):
        sd = np.array([0, 0, 1.0]) * 0.008
        add_quad(lace_pos, lace_tri, p0 - sd, p1 - sd, p1 + sd, p0 + sd)
    laces = dict(pos=np.array(lace_pos), tri=np.array(lace_tri))
    metal = dict(pos=np.array(met_pos), tri=np.array(met_tri))
    # ---- outsole: outline from foot footprint + margin, lugged perimeter, heel block, bottom lugs
    NO = 40
    zs = np.linspace(0.0, Lf, 400)
    half = np.zeros_like(zs); cen = np.zeros_like(zs)
    for i, zf in enumerate(zs):
        m = (np.abs(Sf[:, 0] - zf) < 0.006) & (Sf[:, 1] < 0.05)
        if m.sum() > 3:
            w = Sf[m, 2]; half[i] = 0.5 * (w.max() - w.min()); cen[i] = 0.5 * (w.max() + w.min())
    good = half > 0
    half = np.interp(zs, zs[good], half[good]); cen = np.interp(zs, zs[good], cen[good])
    from scipy.ndimage import gaussian_filter1d
    half = gaussian_filter1d(half, 12) + 0.013; cen = gaussian_filter1d(cen, 12)
    # rounded ends: parametrise outline by angle around an ellipse-ish shape
    t = np.linspace(0, 2 * np.pi, NO, endpoint=False)
    zf_o = Lf * 0.5 * (1 - np.cos(t))          # 0 (heel) .. Lf (toe)
    endk = np.sqrt(np.clip(np.sin(t) ** 2, 0, 1)) ** 0.55
    hw = np.interp(zf_o, zs, half) * endk
    cw = np.interp(zf_o, zs, cen)
    sgn = np.where(np.sin(t) >= 0, 1, -1)
    lat = cw + sgn * hw
    out2 = np.stack([zf_o, lat], 1)
    cen2 = np.array([Lf * 0.45, np.interp(Lf * 0.45, zs, cen)])
    nrm2 = out2 - cen2; nrm2 /= np.linalg.norm(nrm2, axis=1, keepdims=True)
    lug = np.where(np.arange(NO) % 2 == 0, 1.0, -1.0) * 0.0022
    rings_s = []
    def ring_at(y_fn, grow, lugs=False):
        o = out2 + nrm2 * (grow + (lug[:, None] if lugs else 0))
        return np.stack([o[:, 0], y_fn(o[:, 0]), o[:, 1]], 1)
    rings_s.append(ring_at(lambda z: sole_top(z) + 0.001, -0.002))
    rings_s.append(ring_at(lambda z: sole_top(z) - 0.002, 0.001))
    rings_s.append(ring_at(lambda z: sole_bot(z) + 0.011, 0.0))
    rings_s.append(ring_at(lambda z: sole_bot(z) + 0.009, 0.0, lugs=True))
    rings_s.append(ring_at(lambda z: sole_bot(z) + 0.0, -0.001, lugs=True))
    rings_s.append(ring_at(lambda z: sole_bot(z) + 0.003, -0.006))
    sp = np.concatenate(rings_s)
    st = []
    for k in range(len(rings_s) - 1):
        for j in range(NO):
            a, b = k * NO + j, k * NO + (j + 1) % NO
            c, d = (k + 1) * NO + (j + 1) % NO, (k + 1) * NO + j
            st += [(a, b, c), (a, c, d)]
    # bottom (fan from centre) and top (fan) caps
    base = len(sp)
    cb = np.array([[cen2[0], sole_bot(cen2[0]) + 0.003, cen2[1]]]); ct = np.array([[cen2[0], sole_top(cen2[0]) + 0.001, cen2[1]]])
    sp = np.concatenate([sp, cb, ct])
    lastr = (len(rings_s) - 1) * NO
    for j in range(NO):
        st.append((base, lastr + (j + 1) % NO, lastr + j))
        st.append((base + 1, j, (j + 1) % NO))
    # bottom lugs (chevron-ish blocks) under forefoot and heel
    lugs_p, lugs_t = [], []
    def lugbox(zc, lc, sz, sl, ang):
        ca, sa = np.cos(ang), np.sin(ang)
        y0 = sole_bot(zc) + 0.0035; y1 = sole_bot(zc) - 0.0005
        corners = []
        for dz, dl in ((-sz, -sl), (sz, -sl), (sz, sl), (-sz, sl)):
            corners.append((zc + dz * ca - dl * sa, lc + dz * sa + dl * ca))
        n0 = len(lugs_p)
        for (z_, l_) in corners:
            lugs_p.append((z_, y0, l_))
        for (z_, l_) in corners:
            lugs_p.append((z_, y1, l_))
        lugs_t.extend([(n0 + 4, n0 + 6, n0 + 5), (n0 + 4, n0 + 7, n0 + 6)])
        for j in range(4):
            a, b = n0 + j, n0 + (j + 1) % 4
            lugs_t.extend([(a, b, b + 4), (a, b + 4, a + 4)])
    for zc in (Lf - 0.05, Lf - 0.09, Lf - 0.13):
        c0 = np.interp(zc, zs, cen); hw0 = np.interp(zc, zs, half) - 0.012
        for s_ in (-1, 1):
            lugbox(zc, c0 + s_ * hw0 * 0.5, 0.009, hw0 * 0.42, s_ * 0.5)
    for zc in (0.03, 0.06):
        c0 = np.interp(zc, zs, cen); hw0 = np.interp(zc, zs, half) - 0.012
        for s_ in (-1, 1):
            lugbox(zc, c0 + s_ * hw0 * 0.5, 0.009, hw0 * 0.42, -s_ * 0.5)
    lp_ = np.array(lugs_p); lt_ = np.array(lugs_t) + len(sp)
    grp = np.concatenate([np.zeros(len(st), int), 1 + np.arange(len(lt_)) // 10])
    sp = np.concatenate([sp, lp_]); st = np.concatenate([np.array(st), lt_])
    sole = dict(pos=sp, tri=st, grp=grp)

    # ---- convert foot-frame (z_f, y, lat) -> world
    def to_w(P):
        P = np.asarray(P, float)
        return H[None] * [1, 0, 1] + P[:, :1] * f[None] + P[:, 1:2] * yv[None] + P[:, 2:3] * l[None]
    out = {}
    for name, d in (('upper', upper), ('sole', sole), ('laces', laces), ('metal', metal)):
        q = dict(d); q['pos'] = to_w(d['pos'])
        out[name] = q
    return out


def _mirror(part):
    q = dict(part)
    q['pos'] = part['pos'] * [-1, 1, 1]
    q['tri'] = part['tri'][:, ::-1].copy()
    return q


def _fix_winding(part, inside_pt):
    """make triangles face away from an interior point (majority vote)"""
    P, T = part['pos'], part['tri']
    n = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    c = P[T].mean(1)
    if np.mean(np.einsum('ij,ij->i', n, c - inside_pt) > 0) < 0.5:
        part['tri'] = T[:, ::-1].copy()
    return part


def build(B):
    """returns {'Left': parts, 'Right': parts}; parts: upper/sole/laces/metal dicts with pos/tri(/uv/col), GL rest pose"""
    L = build_left(B, 1)
    inside = L['upper']['pos'].mean(0)
    _fix_winding(L['upper'], inside)
    so = L['sole']; P, T = so['pos'], so['tri']
    for gid in np.unique(so['grp']):
        m = so['grp'] == gid
        cen = P[np.unique(T[m])].mean(0)
        n = np.cross(P[T[m, 1]] - P[T[m, 0]], P[T[m, 2]] - P[T[m, 0]])
        flip = np.einsum('ij,ij->i', n, P[T[m]].mean(1) - cen) < 0
        Tm = T[m]; Tm[flip] = Tm[flip][:, ::-1]; T[m] = Tm
    so.pop('grp')
    # laces/eyelets: face outward from the upper's centre line
    for k in ('laces', 'metal'):
        _fix_winding(L[k], inside)
    R = {k: _mirror(v) for k, v in L.items()}
    for side in (L, R):
        for k, v in side.items():
            v['nrm'] = MU.weld_normals(v['pos'], MU.vertex_normals(v['pos'], v['tri']), 1e-6) if k in ('upper',) else MU.vertex_normals(v['pos'], v['tri'])
    return {'Left': L, 'Right': R}
