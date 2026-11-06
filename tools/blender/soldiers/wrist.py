"""soldiers_v8: sleeve ends, wrists and glove cuffs (build-time, on top of body.pkl + thicken_uniform).

Problem (v7 and before): the v6 baggy sleeves end ~5 cm before the wrist joint as a raw single-sided tube of ~6 cm radius around
a ~2.5 cm wrist, and the hand / glove mesh stops 4 mm inside it.  stage_body.add_collar_cuffs meant to extrude a hem there, but its
loop pick (largest projection on the forearm axis) chose the trouser bottoms inside the boots, so the sleeves never got one.  Seen
from the hand side the sleeve was an empty (see-through with the single-sided per-part material) tube with the glove floating in it.

Fix (real field jackets: cuff band ~5 cm, cinched round the glove / wrist with a velcro tab, gathered sleeve cloth above it;
tactical gloves: neoprene cuff 5-6 cm past the wrist crease, tucked under the sleeve; knit gloves (RU): snug knit cuff):
  cinch_sleeves   positions only: the last ~11 cm of each sleeve are pulled in to the forearm (skin + 10 mm at the cuff band,
                  i.e. 3.5 mm cloth + room for a glove cuff), blending back to the baggy sleeve above it, the fold relief of
                  thicken_uniform kept in the gathered zone; same topology / UVs / weights as before
  add_hems        appended to R['uniform'] (tri / uv / W / labels 'hem_L', 'hem_R' / colour) and every variant's positions: rounded
                  hem edge (3.4 mm thick) + an inner facing running 3 cm back up the sleeve close round the wrist, then out to
                  the sleeve wall (no see-through, no open inside).  UVs continue the sleeve chart (camo matches), vertex colour
                  darkens the inside (AO)
  extend_hands    the hand mesh continues ~6 cm up the forearm inside the sleeve (skin, shaped on the base body's forearm),
                  skinned with the base body's weights at those points (same as the sleeve there)
  glove_mesh      gloves = hands + 2.5 mm, + a 5.5 cm cuff band (UA: neoprene 4.3 mm with a velcro tab on the back of the
                  wrist, darker; RU: knit cuff 3.6 mm, same tone) ending in a rolled edge, then a dark base-layer cuff inside
                  the sleeve (vertex colours)
All new geometry carries the bind-pose weights of the surface it sits on, so it follows the forearm exactly like the sleeve does
(wrist_check.py measures gaps / poke-through over every clip)."""
import numpy as np
from mathutils.bvhtree import BVHTree
from mathutils import Vector
import meshutil as MU, body as BD, assemble as AS

SIDES = (('Left', 1), ('Right', -1))
CLR_BAND = 0.0102        # sleeve outer surface above the skin at the cuff band
CLOTH = 0.0034           # hem / cuff cloth thickness
BAND = 0.045             # cuff band length (straight, cinched)
GATHER = 0.115           # cinch fades out this far up the sleeve from its end
GLOVE = 0.0025           # glove over the hand
CUFF = {'ua': 0.0043, 'ru': 0.0036}     # glove cuff over the skin
TUBE = (0.014, 0.042, 0.050, 0.076)       # hand-mesh extension rings (m up the forearm from the hand mesh's open end)


def _J(sk, n):
    return sk.head[sk.idx[n]]


def frame(sk, side):
    """forearm frame at the wrist joint: (wrist, axis a (elbow -> wrist), e1, e2)"""
    el, wr = _J(sk, side + 'ForeArm'), _J(sk, side + 'Hand')
    a = (wr - el) / np.linalg.norm(wr - el)
    e1 = np.cross(a, [0, 1.0, 0]); e1 /= np.linalg.norm(e1)
    e2 = np.cross(a, e1)
    return wr, a, e1, e2


def cyl(X, fr):
    wr, a, e1, e2 = fr
    d = X - wr
    s = d @ a
    rv = d - np.outer(s, a)
    return s, np.linalg.norm(rv, axis=1), np.arctan2(rv @ e2, rv @ e1)


def from_cyl(s, r, th, fr):
    wr, a, e1, e2 = fr
    return wr + np.outer(s, a) + (np.outer(np.cos(th), e1) + np.outer(np.sin(th), e2)) * np.asarray(r)[:, None]


def _sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def forearm_only(W, sk, side):
    """weights of points well behind the wrist joint: no hand / finger influence (it would swing them sideways when the wrist
    bends), renormalised"""
    W = np.array(W, np.float64)
    for b in (side + 'Hand', side + 'FingerBase', side + 'HandFinger1', side[0] + 'Thumb'):
        if b in sk.idx:
            W[..., sk.idx[b]] = 0
    return W / np.maximum(W.sum(-1, keepdims=True), 1e-9)


def _weld(P, dec=5):
    _, inv = np.unique(np.round(P, dec), axis=0, return_inverse=True)
    return inv.reshape(-1)


class Skin:
    """forearm / wrist skin radius r(s, theta) of the base body (variant A), by ray casts from the forearm axis"""
    def __init__(self, B, side, fr):
        bones = {side + 'ForeArm', side + 'Hand'}
        F = [B.o['f'][i] for i in B.body_faces if all(B.dom[v] in bones for v in B.o['f'][i])]
        T = MU.triangulate(F)
        self.tree = BVHTree.FromPolygons([tuple(v) for v in B.vA], [tuple(map(int, t)) for t in T], all_triangles=True)
        self.fr = fr

    def r(self, s, th):
        wr, a, e1, e2 = self.fr
        out = np.zeros(len(s))
        for i, (s_, t_) in enumerate(zip(s, th)):
            o = wr + a * s_
            d = e1 * np.cos(t_) + e2 * np.sin(t_)
            h = self.tree.ray_cast(Vector(o), Vector(d), 0.12)
            out[i] = h[3] if h[0] is not None else np.nan
        if np.isnan(out).any():           # rare misses (between faces): neighbour fill
            ok = ~np.isnan(out)
            out[~ok] = np.interp(np.where(~ok)[0], np.where(ok)[0], out[ok])
        return out


def _end_loop(T, P, fr, near):
    """welded boundary loop nearest `near` -> list of welded ids, and the welded index map"""
    inv = _weld(P)
    loops = BD.boundary_loops([list(inv[t]) for t in T])
    rep = np.zeros(inv.max() + 1, int); rep[inv] = np.arange(len(inv))
    lp = min(loops, key=lambda l: np.linalg.norm(P[rep[l]].mean(0) - near))
    return lp, inv, rep


def setup(R, B=None):
    """per side: forearm frame, skin sampler, sleeve end loop (welded ids, ordered), hand mesh end loop"""
    sk = R['skel']
    B = B or BD.Base()
    U = R['uniform']; PA = R['variants']['A']['uniform_pos']
    H = R['hands']
    S = {}
    for side, sx in SIDES:
        fr = frame(sk, side)
        sl, uinv, urep = _end_loop(U['tri'], PA, fr, fr[0])
        hl, hinv, hrep = _end_loop(H['tri'], H['pos'], fr, fr[0] - fr[1] * 0.055)
        S[side] = dict(fr=fr, skin=Skin(B, side, fr), sleeve_loop=sl, uinv=uinv, urep=urep, hand_loop=hl, hinv=hinv, hrep=hrep)
        s, r, _ = cyl(PA[urep[sl]], fr)
        hs, hr, _ = cyl(H['pos'][hrep[hl]], fr)
        print(f'wrist {side}: sleeve end loop {len(sl)} verts s {s.min():.3f}..{s.max():.3f} r {r.min():.3f}..{r.max():.3f}; '
              f'hand end loop {len(hl)} verts s {hs.min():.3f}..{hs.max():.3f} r {hr.min():.3f}..{hr.max():.3f}')
    return S, B


def _sleeve_mask(R, side):
    U = R['uniform']; lab = np.array(U['labels'])
    m = np.zeros(len(R['variants']['A']['uniform_pos']), bool)
    m[np.unique(U['tri'][np.char.startswith(lab, 'sleeve_' + side[0])])] = True
    return m


def cinch_sleeves(R, S, log=print):
    """pull the sleeve ends in round the wrist (positions only, every variant)"""
    U = R['uniform']; T = U['tri']
    d = R.get('_thick_d')
    nv = len(R['variants']['A']['uniform_pos'])
    # fold relief of thicken_uniform's offset field (high-pass over the mesh): kept in the gathered zone
    E = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]); E = np.concatenate([E, E[:, ::-1]])
    deg = np.maximum(np.bincount(E[:, 0], minlength=nv), 1)
    if d is None:
        d = np.zeros(nv)
    lo = d.copy()
    for _ in range(6):
        lo = 0.5 * lo + 0.5 * np.bincount(E[:, 0], lo[E[:, 1]], minlength=nv) / deg
    fold = d - lo
    inv = _weld(R['variants']['A']['uniform_pos'])
    fold = (np.bincount(inv, fold) / np.bincount(inv))[inv]          # UV-seam duplicates must move identically
    for side, sx in SIDES:
        st = S[side]; fr = st['fr']; m = _sleeve_mask(R, side)
        idx = np.where(m)[0]
        for vn in 'ABC':
            v = R['variants'][vn]; P = v['uniform_pos']
            le = st['urep'][st['sleeve_loop']]
            ls, _, lt = cyl(P[le], fr)
            o = np.argsort(lt); ls, lt = ls[o], lt[o]
            s_end = float(np.median(ls))
            s, r, th = cyl(P[idx], fr)
            # square the cut: the base mesh's sleeve end has a 2 cm pointed tongue on one side -> pull the last 4.5 cm of
            # every column so the hem sits at the median end (a straight cuff)
            se = np.interp(th, lt, ls, period=2 * np.pi)
            s = s + (s_end - se) * _sstep(-0.045, 0.0, s - se)
            u = s - s_end
            sel = u > -GATHER - 0.01
            ii = idx[sel]; s, r, th, u = s[sel], r[sel], th[sel], u[sel]
            band = _sstep(-BAND - 0.015, -BAND + 0.005, u)                 # 1 on the cuff band
            w = _sstep(-GATHER, -BAND, u)                                     # 0 above the gathered zone, 1 on the band
            rs = st['skin'].r(s, th)
            # gathered cloth just above the band: a few soft rings, more on the outer side
            gath = (1 - band) * w * 0.0030 * (0.5 + 0.5 * np.cos(2 * np.pi * (u + BAND) / 0.022 + 0.6 * np.sin(th * 2 + sx)))
            tgt = rs + CLR_BAND + 0.0015 * (1 - band) + gath + fold[ii] * (0.25 + 0.75 * (1 - band))
            rn = r * (1 - w) + np.maximum(tgt, 0) * w
            P = P.copy(); P[ii] = from_cyl(s, rn, th, fr)
            v['uniform_pos'] = P
            if vn == 'A':
                log(f'sleeve cinch {side}: end s {s_end:.3f}, end radius {r[u > -0.004].mean():.3f} -> {rn[u > -0.004].mean():.3f} m '
                    f'(skin {rs[u > -0.004].mean():.3f})')
    # UV-seam duplicates move together (same input position -> same output); recompute normals
    for vn in 'ABC':
        v = R['variants'][vn]
        v['uniform_nrm'] = MU.weld_normals(v['uniform_pos'], MU.vertex_normals(v['uniform_pos'], T), 1e-5)


def _orient(tri, P, want):
    """flip triangles whose normal points away from want (per-triangle desired direction)"""
    n = np.cross(P[tri[:, 1]] - P[tri[:, 0]], P[tri[:, 2]] - P[tri[:, 0]])
    flip = (n * want).sum(1) < 0
    tri = tri.copy(); tri[flip] = tri[flip][:, [0, 2, 1]]
    return tri


def _ordered(loop, P, fr):
    """loop (welded ids) ordered by angle round the forearm axis"""
    _, _, th = cyl(P, fr)
    return [loop[i] for i in np.argsort(th)]


def add_hems(R, S, B, log=print):
    """rounded hem + inner facing at each sleeve end, appended to the uniform (all variants)"""
    U = R['uniform']; T = U['tri']; UV = U['uv']; lab = list(U['labels'])
    nv0 = len(UV)
    PA = R['variants']['A']['uniform_pos']
    # uv / metre on the sleeves (for continuing the chart into the hem)
    m = np.char.startswith(np.array(U['labels']), 'sleeve_')
    t = T[m]
    l3 = np.linalg.norm(PA[t[:, 1]] - PA[t[:, 0]], axis=1); l2 = np.linalg.norm(UV[t[:, 1]] - UV[t[:, 0]], axis=1)
    uvpm = float(np.median(l2 / np.maximum(l3, 1e-6)))
    newP = {vn: [] for vn in 'ABC'}; newUV, newW, newC, newT, newLab, newR = [], [], [], [], [], []
    base = nv0
    # edge -> (triangle, its third vertex) for the uniform's boundary edges (unwelded ids)
    for side, sx in SIDES:
        st = S[side]; fr = st['fr']; inv = st['uinv']
        loop = st['sleeve_loop']                      # welded ids, in boundary order
        nl = len(loop)
        # for each boundary edge (welded a -> b) find the uniform triangle carrying it: its unwelded corner ids give the chart UVs
        tw = inv[T]
        edge_tri = {}
        for ti, (x, y, z) in enumerate(tw):
            for a_, b_, c_, k in ((x, y, z, 0), (y, z, x, 1), (z, x, y, 2)):
                edge_tri.setdefault((min(a_, b_), max(a_, b_)), []).append((ti, k))
        # per loop vertex: hem ring positions for every variant
        rings = {}
        for vn in 'ABC':
            P = R['variants'][vn]['uniform_pos']
            le = st['urep'][loop]
            p0 = P[le]
            s0, r0, th0 = cyl(p0, fr)
            a = fr[1]
            rad = (p0 - fr[0] - np.outer(s0, a)) / r0[:, None]
            rs3 = st['skin'].r(s0 - 0.030, th0)
            # sleeve wall (inner side) 5 cm up: ray cast to this variant's cinched sleeve
            tree = BVHTree.FromPolygons([tuple(q) for q in P], [tuple(map(int, q)) for q in T[np.char.startswith(np.array(U['labels']), 'sleeve_' + side[0])]], all_triangles=True)
            r4 = np.zeros(nl)
            for i in range(nl):
                o = fr[0] + a * (s0[i] - 0.052)
                dd = fr[2] * np.cos(th0[i]) + fr[3] * np.sin(th0[i])
                h = tree.ray_cast(Vector(o), Vector(dd), 0.2)
                r4[i] = (h[3] if h[0] is not None else r0[i] + 0.01) - 0.0035
            R1 = p0 + a * 0.0018 - rad * 0.0012
            R2 = p0 + a * 0.0006 - rad * CLOTH
            R3 = from_cyl(s0 - 0.030, rs3 + CLR_BAND - CLOTH, th0, fr)
            R4 = from_cyl(s0 - 0.052, np.maximum(r4, rs3 + CLR_BAND - CLOTH), th0, fr)
            rings[vn] = [p0, R1, R2, R3, R4]
        # path length along the hem section (for the UV continuation), variant A
        rA = rings['A']
        seg = [np.zeros(nl)] + [np.linalg.norm(rA[k + 1] - rA[k], axis=1) for k in range(4)]
        dep = np.cumsum(np.stack(seg, 1), 1)                 # (nl, 5) metres from the sleeve edge
        col = np.array([1.0, 0.92, 0.72, 0.42, 0.30])        # inside of the sleeve is shadowed
        # boundary edges -> (unwelded a, unwelded b, unwelded third corner) of the uniform triangle carrying the edge
        edges = []
        for i in range(nl):
            j = (i + 1) % nl
            wa, wb = loop[i], loop[j]
            cand = edge_tri.get((min(wa, wb), max(wa, wb)))
            if not cand:
                continue
            ti, _ = cand[0]
            tri_ = T[ti]; wt = list(tw[ti])
            ua = tri_[wt.index(wa)]; ub = tri_[wt.index(wb)]; uc = tri_[[q for q in range(3) if wt[q] not in (wa, wb)][0]]
            edges.append((i, j, ua, ub, uc))
        # chart direction "back up the sleeve" per unwelded vertex (mean over its boundary edges in that chart)
        dvs = {}
        for i, j, ua, ub, uc in edges:
            e = UV[ub] - UV[ua]; e /= max(np.linalg.norm(e), 1e-9)
            dv = UV[uc] - 0.5 * (UV[ua] + UV[ub]); dv = dv - e * (dv @ e); dv /= max(np.linalg.norm(dv), 1e-9)
            for u_ in (ua, ub):
                dvs[u_] = dvs.get(u_, 0) + dv
        dvs = {k: v / max(np.linalg.norm(v), 1e-9) for k, v in dvs.items()}
        # deep rings: weights of what they sit on (base body under the facing, the sleeve wall at the far end)
        sm = _sleeve_mask(R, side)
        sk = R['skel']
        W3 = forearm_only(AS.nearest_weights(rA[3], B.vA[:13380], B.W[:13380], k=6), sk, side)
        W2 = AS.nearest_weights(rA[2], B.vA[:13380], B.W[:13380], k=6)
        W4 = AS.nearest_weights(rA[4], PA[sm], U['W'][sm], k=4)
        vid = {}
        def vert(i, k, uid):
            key = (i, k, int(uid))
            if key in vid:
                return vid[key]
            for vn in 'ABC':
                newP[vn].append(rings[vn][k][i])
            newUV.append(UV[uid] + dvs[uid] * dep[i, k] * uvpm)
            newW.append(U['W'][uid] if k < 2 else (forearm_only(0.5 * (U['W'][uid] + W2[i]), sk, side) if k == 2 else W3[i] if k == 3 else W4[i])); newC.append(col[k]); newR.append(k)
            vid[key] = base + len(newUV) - 1
            return vid[key]
        tris, want = [], []
        for i, j, ua, ub, uc in edges:
            ids_a = [vert(i, k_, ua) for k_ in range(5)]
            ids_b = [vert(j, k_, ub) for k_ in range(5)]
            for k_ in range(4):
                a0, a1, b0, b1 = ids_a[k_], ids_a[k_ + 1], ids_b[k_], ids_b[k_ + 1]
                tris += [[a0, b0, b1], [a0, b1, a1]]
                # wanted facing: hem edge forward (+a), inner facing toward the axis
                wv = fr[1] if k_ < 2 else -(rA[1][i] - fr[0] - fr[1] * ((rA[1][i] - fr[0]) @ fr[1]))
                want += [wv, wv]
        newT.append((np.array(tris) , np.array(want)))
        newLab += ['hem_' + side[0]] * len(tris)
    nn = len(newUV)
    for vn in 'ABC':
        v = R['variants'][vn]
        v['uniform_pos'] = np.concatenate([v['uniform_pos'], np.array(newP[vn])])
    P = R['variants']['A']['uniform_pos']
    TT = []
    for tri, want in newT:
        TT.append(_orient(tri, P, want))
    TT = np.concatenate(TT)
    U['tri'] = np.concatenate([T, TT]).astype(T.dtype)
    U['uv'] = np.concatenate([UV, np.array(newUV)])
    U['W'] = np.concatenate([U['W'], np.array(newW)]).astype(U['W'].dtype)
    U['labels'] = lab + newLab
    U['col'] = np.concatenate([np.ones(nv0), np.array(newC)])
    U['hem_ring'] = np.concatenate([np.full(nv0, -1), np.array(newR)])
    for vn in 'ABC':
        v = R['variants'][vn]
        v['uniform_nrm'] = MU.weld_normals(v['uniform_pos'], MU.vertex_normals(v['uniform_pos'], U['tri']), 1e-5)
    log(f'sleeve hems: +{nn} verts, +{len(TT)} tris (uv/m {uvpm:.3f})')
    return len(TT)


def extend_hands(R, S, B, log=print):
    """continue the hand mesh up the forearm inside the sleeve (skin): ring 0 duplicates the hand mesh's open end (same position,
    weights, welded normals: no crack), rings 1.. step TUBE up the forearm on the base body's skin.  The tube is its own small UV
    island on a skin texel of the hand texture (the atlas packer works per island)."""
    H = R['hands']
    P, UV, T, W = H['pos'], H['uv'], H['tri'], H['W']
    nv0 = len(P)
    newP, newUV, newW, newT, ring_of = [], [], [], [], []
    body = B.vA[:13380]; bW = B.W[:13380]
    for side, sx in SIDES:
        st = S[side]; fr = st['fr']; hinv = st['hinv']
        loop = st['hand_loop']
        nl = len(loop)
        rep = {}
        for t_, w_ in zip(T, hinv[T]):
            for q in range(3):
                rep.setdefault(w_[q], t_[q])
        lid = [rep[w] for w in loop]
        p0 = P[lid]
        s0, r0, th0 = cyl(p0, fr)
        k0 = st['skin'].r(s0, th0)
        sc = r0 / np.maximum(k0, 1e-4)                   # decimated hand vs base body: match the hand's own end ring
        # skin texel: UV centroid of the hand triangles 2-4 cm before the wrist on the back of the forearm
        tc = P[T].mean(1); ts, _, _ = cyl(tc, fr)
        near = np.where((np.sign(tc[:, 0]) == sx) & (ts > -0.04) & (ts < -0.02))[0]
        uvc = UV[T[near]].mean(1)[len(near) // 2] if len(near) else UV[lid[0]]
        steps = (0.0,) + TUBE
        prev = None
        for k, dd in enumerate(steps):
            if k == 0:
                pk = p0; Wk = W[lid]
            else:
                s_ = s0 - dd
                f = _sstep(0, 0.03, dd)
                rk = st['skin'].r(s_, th0) * (sc * (1 - f) + f)
                pk = from_cyl(s_, rk, th0, fr)
                Wk = forearm_only(AS.nearest_weights(pk, body, bW, k=6), R['skel'], side)
            cur = []
            for i in range(nl):
                newP.append(pk[i]); newW.append(Wk[i]); ring_of.append(k)
                newUV.append(uvc + 0.004 * np.array([i / nl, k / len(steps)]))
                cur.append(nv0 + len(newP) - 1)
            if prev is not None:
                for i in range(nl):
                    j = (i + 1) % nl
                    newT += [[prev[i], prev[j], cur[j]], [prev[i], cur[j], cur[i]]]
            prev = cur
    Pn = np.concatenate([P, np.array(newP)])
    Tn = np.array(newT)
    # outward facing
    c = Pn[Tn].mean(1)
    want = np.zeros_like(c)
    for side, sx in SIDES:
        fr = S[side]['fr']
        ms = np.sign(c[:, 0]) == sx
        s_ = (c[ms] - fr[0]) @ fr[1]
        want[ms] = c[ms] - fr[0] - np.outer(s_, fr[1])
    Tn = _orient(Tn, Pn, want)
    H['pos'] = Pn
    H['uv'] = np.concatenate([UV, np.array(newUV)])
    H['W'] = np.concatenate([W, np.array(newW)]).astype(W.dtype)
    H['tri'] = np.concatenate([T, Tn]).astype(T.dtype)
    H['nrm'] = MU.weld_normals(Pn, MU.vertex_normals(Pn, H['tri']), 1e-5)
    H['tube_ring'] = np.concatenate([np.full(nv0, -1), np.array(ring_of)])
    # bare skin inside the sleeve is shadowed
    H['col'] = np.concatenate([np.ones(nv0), np.array([1.0, 0.80, 0.62, 0.50, 0.36])[np.array(ring_of)]])[:, None].repeat(3, 1)
    log(f'hands: forearm continued {TUBE[-1] * 100:.0f} cm into the sleeves, +{len(newP)} verts, +{len(Tn)} tris')


def glove_mesh(R, S, rig, fac):
    """glove positions + vertex colours on the (extended) hand topology"""
    H = R['hands']; P, N = H['pos'], H['nrm']
    ring = H['tube_ring']
    off = np.full(len(P), GLOVE)
    col = np.ones((len(P), 3))
    cuff_t = CUFF[fac]
    cuff_c = np.array([0.40, 0.40, 0.40]) if fac == 'ua' else np.array([0.86, 0.86, 0.84])     # UA dark neoprene, RU knit
    tab_c = np.array([0.30, 0.30, 0.30])
    base_c = np.array([0.64, 0.76, 0.72]) * 0.6 if fac == 'ua' else np.array([0.69, 0.72, 0.70]) * 0.6   # dark olive base layer
    for side, sx in SIDES:
        fr = S[side]['fr']
        ms = np.sign(P[:, 0]) == sx
        s, r, th = cyl(P[ms], fr)
        o = off[ms]; c = col[ms]
        # cuff band from 1 cm before the wrist crease to the cuff edge, rolled lip at the hand end
        cb = (1 - _sstep(-0.014, -0.006, s))
        lip = np.exp(-((s + 0.011) / 0.003) ** 2)
        o = o + cb * (cuff_t - GLOVE) + 0.0008 * lip
        c = c * (1 - cb[:, None]) + cuff_c * cb[:, None]
        if fac == 'ua':
            # velcro tab on the back of the wrist (dorsal side = away from the palm)
            dors = -rig.hand[side]['p']
            dv = np.array([dors @ fr[2], dors @ fr[3]])
            td = np.arctan2(dv[1], dv[0])
            ang = np.abs(np.angle(np.exp(1j * (th - td))))
            tab = _sstep(0.55, 0.35, ang) * _sstep(-0.052, -0.046, s) * (1 - _sstep(-0.024, -0.018, s))
            o = o + 0.0013 * tab
            c = c * (1 - tab[:, None]) + tab_c * tab[:, None]
        rk = ring[ms]
        # tube rings: 0 = the hand mesh's end (formula above), 1-2 = glove cuff (to ~9 cm past the wrist joint, >= 1.2 cm under
        # every variant's sleeve end), 3.. = dark base-layer cuff under the sleeve (the 8 mm step 2 -> 3 is the cuff's rolled edge)
        under = rk >= 3
        cf = (rk == 1) | (rk == 2)
        o = np.where(cf, cuff_t, np.where(under, 0.0010, o))
        c = np.where(under[:, None], base_c[None] * np.array([1, 1, 1, 1.0, 0.7])[np.maximum(rk, 0)][:, None], c)
        c = np.where(cf[:, None], cuff_c[None] * np.where(rk == 2, 0.8, 0.95)[:, None], c)
        off[ms] = o; col[ms] = c
    gp = P + N * off[:, None]
    gn = MU.weld_normals(gp, MU.vertex_normals(gp, H['tri']), 1e-5)
    return gp, gn, np.clip(col, 0, 1)


def apply(R, rig, log=print):
    """all of the above, in place on R (after thicken_uniform and after the Rig is built from the original hand mesh)"""
    if R.get('_wrist'):
        return R['_wrist']
    S, B = setup(R)
    cinch_sleeves(R, S, log)
    add_hems(R, S, B, log)
    extend_hands(R, S, B, log)
    R['_wrist'] = S
    return S
