"""Winding / sidedness repair for MB meshes before they go to Blender (used by build_city / build_props / build_farmland /
build_trees / build_wires / build_rubble).  The game renders FrontSide materials, so every visible face must face the
camera; this pass makes that true without touching positions, UVs or node contracts:

  1. faces are welded by position (0.1 mm) into patches across manifold edges; winding is made consistent inside a patch
  2. closed patches (watertight shells) are oriented outward by signed volume
  3. open patches are oriented towards the side that is visible from outside: from sample points on each face, rays are
     cast over the hemisphere on both sides (only directions a top-down RTS camera can come from, i.e. upward; the
     ground plane blocks the rest) and the side that escapes more wins (area weighted over the patch)
  4. faces of open patches whose back side is still clearly visible (thin sheets: fences, sign plates, tarps, film,
     rims of open boxes) get a reversed twin on duplicated vertices (exact twins already present are left alone)

Faces with a material index in `skip_mats` (double-sided alpha materials, e.g. foliage) are ignored but still occlude.
"""
import math
import numpy as np

try:
    import bpy  # noqa: F401  (mathutils is only importable once the bpy module is loaded)
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
except ImportError:      # pragma: no cover
    BVHTree = None


def _camdirs():
    """Directions from the asset towards possible RTS camera positions (elevation 10..85 deg, all azimuths)."""
    out = []
    for el, n in ((10, 16), (22, 16), (38, 14), (55, 10), (72, 6), (85, 1)):
        for i in range(n):
            a = 2 * math.pi * (i + 0.5 * (el % 2)) / n; e = math.radians(el)
            out.append((math.cos(e) * math.sin(a), math.sin(e), math.cos(e) * math.cos(a)))
    return np.array(out)


def _hemi(K):
    i = np.arange(K) + 0.5
    r = np.sqrt(i / K); phi = i * 2.399963229728653
    return np.stack([r * np.cos(phi), r * np.sin(phi), np.sqrt(np.maximum(0.0, 1 - r * r))], 1)


def _newell(P):
    n = np.zeros(3)
    for i in range(len(P)):
        a, b = P[i], P[(i + 1) % len(P)]
        n += [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]
    return n


def fix_mb(mb, skip_mats=(), double_thr=0.003, double_rel=0.06, verbose=True, double=True):
    if BVHTree is None:
        raise RuntimeError('meshfix needs the bpy module (mathutils.bvhtree)')
    if not mb.F:
        return {}
    V = np.array(mb.V, float)
    # non-planar quads -> two triangles on the shorter diagonal (a reversed twin quad would otherwise be split on the
    # other diagonal by Blender and poke through its front -- checkerboard holes in bent sheets / tarps)
    newF = []
    for f in mb.F:
        idx, uv, sm, mt = f
        if len(idx) == 4:
            P = V[list(idx)]
            n = np.cross(P[1] - P[0], P[2] - P[0]); ln = np.linalg.norm(n)
            if ln > 1e-12 and abs((P[3] - P[0]) @ n) / ln > 2e-4:
                if np.linalg.norm(P[2] - P[0]) <= np.linalg.norm(P[3] - P[1]) + 1e-9:
                    newF += [((idx[0], idx[1], idx[2]), [uv[0], uv[1], uv[2]], sm, mt), ((idx[0], idx[2], idx[3]), [uv[0], uv[2], uv[3]], sm, mt)]
                else:
                    newF += [((idx[0], idx[1], idx[3]), [uv[0], uv[1], uv[3]], sm, mt), ((idx[1], idx[2], idx[3]), [uv[1], uv[2], uv[3]], sm, mt)]
                continue
        newF.append(f)
    mb.F[:] = newF
    F = mb.F
    nF = len(F)
    act = np.array([f[3] not in skip_mats for f in F])
    # ---- weld
    q = np.round(V / 1e-4).astype(np.int64)
    _, wid = np.unique(q, axis=0, return_inverse=True); wid = wid.reshape(-1)
    Wf = [tuple(int(wid[i]) for i in f[0]) for f in F]
    Wpos = np.zeros((wid.max() + 1, 3)); Wpos[wid] = V
    # face geometry
    Nn = np.zeros((nF, 3)); A = np.zeros(nF); C = np.zeros((nF, 3))
    for k, f in enumerate(F):
        P = V[list(f[0])]
        n = _newell(P); l = np.linalg.norm(n)
        A[k] = 0.5 * l; Nn[k] = n / l if l > 1e-12 else (0, 0, 1); C[k] = P.mean(0)
    # ---- exact twins (same welded vertex set, opposite normal) -> already double sided
    twin = np.zeros(nF, bool)
    seen = {}
    for k in range(nF):
        if not act[k]:
            continue
        key = tuple(sorted(Wf[k]))
        seen.setdefault(key, []).append(k)
    for ks in seen.values():
        if len(ks) > 1:
            for a in ks:
                for b in ks:
                    if a != b and Nn[a] @ Nn[b] < -0.9:
                        twin[a] = twin[b] = True
    use = act & ~twin & (A > 1e-10)
    if not use.any():          # nothing single-sided to fix (pure foliage / LOD cards)
        return {'faces': nF, 'patches': 0, 'flipped': 0, 'doubled': 0, 'twins': int(twin.sum())}
    # ---- patches over manifold edges
    edges = {}
    for k in np.nonzero(use)[0]:
        w = Wf[k]
        for i in range(len(w)):
            a, b = w[i], w[(i + 1) % len(w)]
            if a == b:
                continue
            edges.setdefault((min(a, b), max(a, b)), []).append((k, a < b))
    adj = [[] for _ in range(nF)]
    boundary = np.zeros(nF, bool)
    for e, lst in edges.items():
        if len(lst) == 2:
            (f1, d1), (f2, d2) = lst
            if f1 == f2:
                continue
            if abs(Nn[f1] @ Nn[f2]) > 0.985:
                # coplanar neighbours: a link is only valid when they continue the surface (centroids on opposite
                # sides of the shared edge); overlapping / folded-back faces (wall caps against wall faces) are not linked
                pa_, pb_ = Wpos[e[0]], Wpos[e[1]]
                ed = pb_ - pa_; ed /= (np.linalg.norm(ed) + 1e-12)
                side = np.cross(ed, Nn[f1])
                if ((C[f1] - pa_) @ side) * ((C[f2] - pa_) @ side) > 0:
                    boundary[f1] = boundary[f2] = True
                    continue
            if d1 == d2:
                # the two faces disagree: never infer a flip from topology (touching separate solids create such
                # links); each consistently wound group is decided on its own (volume / visibility)
                boundary[f1] = boundary[f2] = True
                continue
            adj[f1].append((f2, False)); adj[f2].append((f1, False))
        else:
            for f_, _ in lst:
                boundary[f_] = True
    patch = np.full(nF, -1); par = np.zeros(nF, bool)
    npatch = 0
    for s in np.nonzero(use)[0]:
        if patch[s] >= 0:
            continue
        patch[s] = npatch; par[s] = False; st = [s]
        while st:
            f = st.pop()
            for g, flip in adj[f]:
                if patch[g] < 0:
                    patch[g] = npatch; par[g] = par[f] ^ flip; st.append(g)
        npatch += 1
    # make consistent: faces with parity True get flipped (relative to the patch seed)
    sgn = np.where(par, -1.0, 1.0)
    # ---- visibility rays
    bvh = BVHTree.FromPolygons([tuple(v) for v in V], [tuple(f[0]) for f in F], epsilon=0.0)
    vis = np.zeros((nF, 2))
    diag = float(np.linalg.norm(V.max(0) - V.min(0))) + 1.0
    closed_p = np.ones(npatch, bool)
    for k in np.nonzero(use)[0]:
        if boundary[k]:
            closed_p[patch[k]] = False
    vol = np.zeros(npatch)
    for k in np.nonzero(use)[0]:
        P = V[list(F[k][0])]
        for i in range(1, len(P) - 1):
            vol[patch[k]] += sgn[k] * (P[0] @ np.cross(P[i], P[i + 1])) / 6.0
    pa = np.zeros(npatch); np.add.at(pa, patch[use], A[use])
    need = use & ~closed_p[np.maximum(patch, 0)]
    # closed shells with ~zero volume (degenerate) still need rays
    degenerate = closed_p & (np.abs(vol) < 1e-7)
    need |= use & degenerate[np.maximum(patch, 0)]
    CD = _camdirs()
    H = _hemi(16)
    inside = np.zeros((nF, 2))
    fsgn = np.where(act, 1.0, 0.0)      # foliage / skipped faces never count as solid
    for k in np.nonzero(need)[0]:
        n = Nn[k]
        P = V[list(F[k][0])]
        pts = [C[k]]
        if A[k] > 0.04:
            pts += [C[k] + (p - C[k]) * 0.7 for p in P[:4]]
        dots = CD @ n
        acc = np.zeros(2)
        for p in pts:
            for d, s_ in zip(CD, dots):
                if abs(s_) < 0.02:
                    continue
                side = 0 if s_ > 0 else 1
                o = p + n * (3e-4 if side == 0 else -3e-4)
                if bvh.ray_cast(Vector(o), Vector(d), diag)[0] is None:
                    acc[side] += abs(s_)
        vis[k] = acc / (len(pts) * len(CD))
        # insideness of each side: share of hemisphere rays (all directions) that hit a back face -> inside a solid
        t = np.cross(n, [0, 1, 0] if abs(n[1]) < 0.9 else [1, 0, 0]); t /= np.linalg.norm(t); b = np.cross(n, t)
        for side in (0, 1):
            s_ = 1.0 if side == 0 else -1.0
            D = H[:, 0:1] * t + H[:, 1:2] * b + H[:, 2:3] * (n * s_)
            o = Vector(C[k] + n * s_ * 3e-4); ins = 0
            for d in D:
                h = bvh.ray_cast(o, Vector(d), diag)
                if h[0] is not None and h[2] is not None:
                    hn = Nn[h[2]] * fsgn[h[2]]
                    if hn @ d > 0.05:
                        ins += 1
            inside[k, side] = ins / len(D)
    # ---- decide orientation per patch
    flipP = np.zeros(npatch, bool)
    for p in range(npatch):
        if closed_p[p] and not degenerate[p]:
            flipP[p] = vol[p] < 0
    S = np.zeros(npatch); np.add.at(S, patch[need], A[need] * (vis[need, 0] - vis[need, 1]) * sgn[need])
    # interior evidence (relative to the patch seed orientation): back side inside a solid -> keep, front inside -> flip
    I = np.zeros(npatch); np.add.at(I, patch[need], A[need] * (inside[need, 1] - inside[need, 0]) * sgn[need])
    PA_ = np.zeros(npatch); np.add.at(PA_, patch[need], A[need])
    for p in range(npatch):
        if not closed_p[p] or degenerate[p]:
            ii = I[p] / max(PA_[p], 1e-12)
            if ii > 0.4:            # back clearly interior: never turn it outward
                flipP[p] = False
            else:
                flipP[p] = S[p] < -1e-6
    final_flip = np.zeros(nF, bool)
    final_flip[use] = par[use] ^ flipP[patch[use]]
    # back-side visibility after orientation
    front = np.where(final_flip, vis[:, 1], vis[:, 0]); back = np.where(final_flip, vis[:, 0], vis[:, 1])
    dbl = need & (back > double_thr) & (back > double_rel * front) if double else np.zeros(nF, bool)
    # ---- apply
    VN = getattr(mb, 'VN', None); VC = getattr(mb, 'VC', None)
    newF = []
    for k, f in enumerate(F):
        idx, uv, sm, mt = f
        if final_flip[k]:
            idx = tuple(idx[::-1]); uv = list(uv[::-1])
        newF.append((idx, uv, sm, mt))
    if VN:
        # custom normals follow the flip when every face using the vertex was flipped
        used_by = {}
        for k, f in enumerate(F):
            for vi in f[0]:
                used_by.setdefault(vi, []).append(final_flip[k])
        for vi, fl in used_by.items():
            if vi in VN and all(fl):
                VN[vi] = tuple(-np.asarray(VN[vi], float))
    remap = {}
    for k in np.nonzero(dbl)[0]:
        idx, uv, sm, mt = newF[k]
        nid = []
        for vi in idx:
            if vi not in remap:
                remap[vi] = len(mb.V); mb.V.append(np.array(mb.V[vi], float))
                if VN and vi in VN:
                    VN[remap[vi]] = tuple(-np.asarray(VN[vi], float))
                if VC and vi in VC:
                    VC[remap[vi]] = VC[vi]
            nid.append(remap[vi])
        newF.append((tuple(nid[::-1]), list(uv[::-1]), sm, mt))
    mb.F[:] = newF
    import os
    if os.environ.get('MESHFIX_DEBUG') and os.environ['MESHFIX_DEBUG'] in mb.name:
        for k in range(nF):
            if final_flip[k] or dbl[k] or (os.environ.get('MESHFIX_PATCH') and str(patch[k]) == os.environ['MESHFIX_PATCH']):
                print('   ', 'FLIP' if final_flip[k] else '    ', 'par', int(par[k]), 'flipP', int(flipP[patch[k]]) if patch[k] >= 0 else '-', 'DBL' if dbl[k] else '   ', np.round(C[k], 2), np.round(Nn[k], 2), 'vis', np.round(vis[k], 4), 'ins', np.round(inside[k], 2), 'patch', patch[k], 'closed', closed_p[patch[k]] if patch[k] >= 0 else '-')
    info = {'faces': nF, 'patches': npatch, 'flipped': int(final_flip.sum()), 'doubled': int(dbl.sum()), 'twins': int(twin.sum())}
    if verbose:
        print(f'  meshfix {mb.name:28s} faces {nF:6d} patches {npatch:5d} flipped {info["flipped"]:5d} doubled {info["doubled"]:5d}')
    return info


def drop(mb, part, sink=0.006, ground=0.0, max_drop=None, step_up=False):
    """Merge MB `part` into `mb` after lowering it straight down until it rests on `mb` or the ground plane
    (cast from its lowest vertices).  sink: overlap left so the parts read as touching.  step_up: also lift a part that
    starts below the ground plane so its lowest point sits at ground - sink."""
    P = np.array(part.V, float)
    if not len(P):
        return 0.0
    ymin = P[:, 1].min()
    gap = ymin - ground
    if mb.V and mb.F and BVHTree is not None:
        V = np.array(mb.V, float)
        bvh = BVHTree.FromPolygons([tuple(v) for v in V], [tuple(f[0]) for f in mb.F], epsilon=0.0)
        low = P[P[:, 1] <= ymin + max(0.02, 0.35 * (P[:, 1].max() - ymin))]
        for p in low:
            h = bvh.ray_cast(Vector((p[0], p[1] + 1e-4, p[2])), Vector((0, -1, 0)), 50.0)
            if h[0] is not None:
                gap = min(gap, (p[1] - h[0][1]))
    d = gap + sink
    if max_drop is not None:
        d = min(d, max_drop)
    if d > 0 or (step_up and d < 0):
        part.V = [v - np.array([0, d, 0]) for v in part.V]
    mb.merge(part)
    return d


def settle_islands(mb, tol=0.008, ground=0.0, sink=0.01, skip_mats=(), verbose=True):
    """Debris piles: pieces (welded islands) are settled bottom-up.  An island counts as supported when it touches the
    ground or an island already settled; otherwise it is lowered straight down onto the settled pieces / the ground.
    (Groups of pieces that only touch each other but hang in the air as a whole are settled too.)"""
    if not mb.F or BVHTree is None:
        return 0
    V = np.array(mb.V, float)
    q = np.round(V / 1e-4).astype(np.int64)
    _, wid = np.unique(q, axis=0, return_inverse=True); wid = wid.reshape(-1)
    parent = np.arange(wid.max() + 1)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for f in mb.F:
        w = [wid[i] for i in f[0]]
        ra = find(w[0])
        for x in w[1:]:
            rb = find(x)
            if rb != ra:
                parent[rb] = ra
    froot = np.array([find(wid[f[0][0]]) for f in mb.F])
    groups = {}
    for k, rt in enumerate(froot):
        groups.setdefault(rt, []).append(k)
    isl = []
    for rt, fi in groups.items():
        vids = sorted({i for k in fi for i in mb.F[k][0]})
        isl.append((float(V[vids][:, 1].min()), fi, vids))
    isl.sort(key=lambda t: t[0])
    settled = []          # face indices of settled islands
    moved = 0
    bvh = None; dirty = True
    for ymin, fi, vids in isl:
        if any(mb.F[k][3] in skip_mats for k in fi) or ymin - ground < tol:
            settled += fi; dirty = True
            continue
        if dirty and settled:
            VV = np.array(mb.V, float)
            bvh = BVHTree.FromPolygons([tuple(v) for v in VV], [tuple(mb.F[k][0]) for k in settled], epsilon=0.0)
            dirty = False
        P = np.array([mb.V[i] for i in vids], float)
        touching = False
        if bvh is not None:
            for p in P:
                if bvh.find_nearest(Vector(p), tol)[0] is not None:
                    touching = True; break
        if not touching:
            ym = P[:, 1].min(); gap = ym - ground
            low = P[P[:, 1] <= ym + max(0.02, 0.35 * (P[:, 1].max() - ym))]
            if bvh is not None:
                for p in low:
                    h = bvh.ray_cast(Vector((p[0], p[1] + 1e-4, p[2])), Vector((0, -1, 0)), 50.0)
                    if h[0] is not None:
                        gap = min(gap, p[1] - h[0][1])
            d = gap + sink
            if d > 0:
                for i in vids:
                    mb.V[i] = np.array(mb.V[i], float) - np.array([0, d, 0])
                moved += 1
        settled += fi; dirty = True
    if verbose:
        print(f'  settle  {mb.name:28s} islands {len(isl):5d} lowered {moved:4d}')
    return moved


def unfight(mb, skip_mats=(), push=0.012, eps=4e-4, verbose=True):
    """Z-fighting repair: faces lying coplanar (< eps) on top of another same-facing face of a DIFFERENT island
    (window frames / panels / plates / trims flush with a wall, roof sheets on a slab, stacked boxes) flicker in the
    game.  The smaller island of each fighting pair is moved out along the shared face normal by `push` (1.2 cm: well
    inside the depth precision of the RTS camera at 300+ m, invisible as an offset).  Faces of one island fighting
    each other are left alone (reported).  Positions only; UVs, normals and node contracts are untouched."""
    if not mb.F:
        return 0
    try:
        from scipy.spatial import cKDTree
    except ImportError:      # pragma: no cover
        return 0
    V = np.array(mb.V, float)
    q = np.round(V / 1e-4).astype(np.int64)
    _, wid = np.unique(q, axis=0, return_inverse=True); wid = wid.reshape(-1)
    # islands over welded vertices (union-find)
    par = np.arange(wid.max() + 1)

    def find(a):
        while par[a] != a:
            par[a] = par[par[a]]; a = par[a]
        return a
    for f in mb.F:
        w = [int(wid[i]) for i in f[0]]
        r0 = find(w[0])
        for x in w[1:]:
            r = find(x)
            if r != r0:
                par[r] = r0
    # triangles (fan) with face / island ids
    T, TF = [], []
    for k, f in enumerate(mb.F):
        if f[3] in skip_mats:
            continue
        idx = f[0]
        for t in range(1, len(idx) - 1):
            T.append((idx[0], idx[t], idx[t + 1])); TF.append(k)
    if not T:
        return 0
    T = np.array(T); TF = np.array(TF)
    P = V[T]
    n = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]); ln = np.linalg.norm(n, axis=1)
    ok = ln > 1e-10; P, T, TF, n, ln = P[ok], T[ok], TF[ok], n[ok], ln[ok]
    N = n / ln[:, None]; A = 0.5 * ln; C = P.mean(1)
    isl = np.array([find(int(wid[T[i, 0]])) for i in range(len(T))])
    Lr = np.linalg.norm(P - C[:, None], axis=2).max(1)
    R = float(np.percentile(Lr, 99.5)) * 2 if len(Lr) else 0
    pairs = cKDTree(C).query_pairs(max(R, 1e-3), output_type='ndarray')
    if not len(pairs):
        return 0
    i, j = pairs[:, 0], pairs[:, 1]
    m = (N[i] * N[j]).sum(1) > 0.999
    i, j = i[m], j[m]
    m = np.abs(((C[j] - P[i, 0]) * N[i]).sum(1)) < eps
    i, j = i[m], j[m]
    if not len(i):
        return 0

    def inside(c, a, b, cc, nn, margin=0.1):
        g = (a + b + cc) / 3
        a = g + (a - g) * (1 - margin); b = g + (b - g) * (1 - margin); cc = g + (cc - g) * (1 - margin)
        s1 = (np.cross(b - a, c - a) * nn).sum(1); s2 = (np.cross(cc - b, c - b) * nn).sum(1); s3 = (np.cross(a - cc, c - cc) * nn).sum(1)
        return ((s1 > 0) & (s2 > 0) & (s3 > 0)) | ((s1 < 0) & (s2 < 0) & (s3 < 0))
    hit = inside(C[i], P[j, 0], P[j, 1], P[j, 2], N[j]) | inside(C[j], P[i, 0], P[i, 1], P[i, 2], N[i])
    i, j = i[hit], j[hit]
    if not len(i):
        return 0
    # pairs inside one welded island (a plate / frame sharing a vertex or edge with the wall it lies on): move the smaller
    # coplanar edge-connected patch of faces instead (its welded vertices; neighbouring faces stretch by the push)
    si = isl[i] == isl[j]
    if si.any():
        Fn = {}; Fd = {}
        for t in range(len(T)):
            Fn.setdefault(int(TF[t]), N[t]); Fd.setdefault(int(TF[t]), float(N[t] @ P[t, 0]))
        fpar = {}

        def ff(a):
            while fpar.setdefault(a, a) != a:
                fpar[a] = fpar[fpar[a]]; a = fpar[a]
            return a
        edges = {}
        for k, f in enumerate(mb.F):
            if k not in Fn:
                continue
            w = [int(wid[v]) for v in f[0]]
            for e in range(len(w)):
                key = (min(w[e], w[(e + 1) % len(w)]), max(w[e], w[(e + 1) % len(w)]))
                for o in edges.setdefault(key, []):
                    if Fn[o] @ Fn[k] > 0.999 and abs(Fd[o] - Fd[k]) < eps:
                        fpar[ff(o)] = ff(k)
                edges[key].append(k)
        parea = {}
        for t in range(len(T)):
            r = ff(int(TF[t])); parea[r] = parea.get(r, 0.0) + A[t]
        pmove = {}
        for a, b in zip(i[si], j[si]):
            pa, pb = ff(int(TF[a])), ff(int(TF[b]))
            if pa == pb:
                continue
            small, nrm = (pa, N[a]) if parea[pa] <= parea[pb] else (pb, N[b])
            pmove.setdefault(small, nrm * push)
        if pmove:
            wmove = {}
            for k, f in enumerate(mb.F):
                if k in Fn and ff(k) in pmove:
                    for v in f[0]:
                        wmove.setdefault(int(wid[v]), pmove[ff(k)])
            for vi in range(len(V)):
                d = wmove.get(int(wid[vi]))
                if d is not None:
                    mb.V[vi] = np.array(mb.V[vi], float) + d
        if verbose:
            print(f'  unfight {mb.name:28s} same-island pairs {int(si.sum()):5d} patches moved {len(pmove):4d}')
        i, j = i[~si], j[~si]
        if not len(i):
            return len(pmove)
    iarea = {}
    for t in range(len(T)):
        iarea[isl[t]] = iarea.get(isl[t], 0.0) + A[t]
    move = {}
    for a, b in zip(i, j):
        ia, ib = isl[a], isl[b]
        small, nrm = (ia, N[a]) if iarea[ia] <= iarea[ib] else (ib, N[b])
        if small not in move:
            move[small] = nrm * push
    if move:
        vis = {}
        for vi in range(len(V)):
            r = find(int(wid[vi]))
            if r in move:
                vis.setdefault(r, []).append(vi)
        for r, d in move.items():
            for vi in vis.get(r, []):
                mb.V[vi] = np.array(mb.V[vi], float) + d
    if verbose:
        print(f'  unfight {mb.name:28s} pairs {len(i):5d} islands moved {len(move):4d}')
    return len(move)
