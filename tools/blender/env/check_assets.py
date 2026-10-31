"""Geometry QA for the environment GLBs (no Blender needed: numpy + scipy + Pillow).

  python3 check_assets.py [glb ...] [-a name_regex] [-v] [--img DIR] [--json out.json]

Per top-level asset node (in its own frame, the root's layout translation is stripped) reports:
  backface%  share of the asset's silhouette pixels where the first surface hit is a BACK face of a single-sided
             material (orthographic software z-buffer from 16 views: 8 azimuths x elevation 15 / 45 deg + top).
             The game renders FrontSide, so these pixels are holes / inverted faces / missing sides.
  open       boundary edges (after welding positions at 1 mm) on single-sided islands (gaps in shells)
  flipE      manifold edges whose two faces run the same direction (inconsistent winding inside a shell)
  inv        closed single-sided islands with negative signed volume (inside-out shells)
  minY       bbox min Y (ground contact; > +2 cm floats, < -5 cm sunk)
  float      clusters of touching islands that do not reach the ground (y < 2 cm) - parts hanging in the air
  zfight     triangles coplanar (< 0.4 mm) and overlapping with another same-facing triangle
-v prints island details for assets with problems; --img writes per-view debug images (red = back face seen).
"""
import sys, os, json, struct, math, re, argparse
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def load_glb(path):
    b = open(path, 'rb').read()
    l = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + l])
    o = 20 + l
    bl = struct.unpack('<I', b[o:o + 4])[0]
    return j, b[o + 8:o + 8 + bl]


def accessor(j, binb, i):
    a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]
    dt = np.dtype(CT[a['componentType']]); n = NC[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride', dt.itemsize * n)
    raw = np.frombuffer(binb, np.uint8, count=stride * (a['count'] - 1) + dt.itemsize * n, offset=off)
    arr = np.lib.stride_tricks.as_strided(raw, (a['count'], dt.itemsize * n), (stride, 1)).copy()
    arr = arr.view(dt).reshape(a['count'], n).astype(np.float64)
    if a.get('normalized'):
        mx = {np.int8: 127, np.uint8: 255, np.int16: 32767, np.uint16: 65535}[CT[a['componentType']]]
        arr = np.maximum(arr / mx, -1.0)
    return arr


def node_matrix(n):
    if 'matrix' in n:
        return np.array(n['matrix'], float).reshape(4, 4).T
    M = np.eye(4)
    t = n.get('translation', [0, 0, 0]); r = n.get('rotation', [0, 0, 0, 1]); s = n.get('scale', [1, 1, 1])
    x, y, z, w = r
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M[:3, :3] = R * np.array(s)[None, :]; M[:3, 3] = t
    return M


def gather(j, binb, root):
    """All triangles under a root node in the root's own frame -> (P (T,3,3), double (T,) bool)."""
    tris, dbl = [], []
    mats = j.get('materials', [])

    def walk(ni, M):
        n = j['nodes'][ni]
        if 'mesh' in n:
            for pr in j['meshes'][n['mesh']]['primitives']:
                if pr.get('mode', 4) != 4:
                    continue
                P = accessor(j, binb, pr['attributes']['POSITION'])
                P = P @ M[:3, :3].T + M[:3, 3]
                if 'indices' in pr:
                    I = accessor(j, binb, pr['indices']).astype(np.int64).reshape(-1, 3)
                else:
                    I = np.arange(len(P)).reshape(-1, 3)
                if np.linalg.det(M[:3, :3]) < 0:
                    I = I[:, ::-1]
                m = mats[pr['material']] if 'material' in pr else {}
                tris.append(P[I]); dbl.append(np.full(len(I), bool(m.get('doubleSided', False))))
        for c in n.get('children', []):
            walk(c, M @ node_matrix(j['nodes'][c]))
    rn = j['nodes'][root]
    M0 = np.eye(4)
    if 'matrix' not in rn:      # keep root rotation / scale, strip its layout translation
        M0 = node_matrix(dict(rn, translation=[0, 0, 0]))
    walk(root, M0)
    if not tris:
        return np.zeros((0, 3, 3)), np.zeros(0, bool)
    return np.concatenate(tris), np.concatenate(dbl)


# ------------------------------------------------------------------ topology
def weld(P, tol=1e-3):
    V = P.reshape(-1, 3)
    q = np.round(V / tol).astype(np.int64)
    _, inv = np.unique(q, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    # merge grid neighbours closer than tol (rounding boundary cases)
    U = np.zeros((inv.max() + 1, 3)); U[inv] = V
    pairs = cKDTree(U).query_pairs(tol * 0.9, output_type='ndarray')
    if len(pairs):
        n = len(U)
        g = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n))
        _, lab = connected_components(g, directed=False)
        inv = lab[inv]
    _, inv = np.unique(inv, return_inverse=True)
    W = np.zeros((inv.max() + 1, 3)); W[inv] = V
    return W, inv.reshape(-1, 3)


def topology(F, nV):
    E = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    ti = np.tile(np.arange(len(F)), 3)
    key = np.sort(E, 1)
    k = key[:, 0] * nV + key[:, 1]
    uk, inv, cnt = np.unique(k, return_inverse=True, return_counts=True)
    ecount = cnt[inv]
    boundary = ecount == 1
    # winding consistency on 2-face edges: directions must be opposite
    fwd = E[:, 0] < E[:, 1]
    s = np.zeros(len(uk)); np.add.at(s, inv, np.where(fwd, 1, -1))
    flipped_e = (cnt == 2) & (s != 0)
    return E, ti, boundary, flipped_e[inv], ecount


def islands(F, nV):
    T = len(F)
    rows = np.repeat(np.arange(T), 3); cols = F.reshape(-1)
    g = coo_matrix((np.ones(3 * T), (rows, cols + T)), shape=(T + nV, T + nV))
    n, lab = connected_components(g, directed=False)
    tl = lab[:T]
    _, tl = np.unique(tl, return_inverse=True)
    return tl


# ------------------------------------------------------------------ software z-buffer
def view_dirs():
    out = []
    for el in (15, 45):
        for az in range(0, 360, 45):
            a, e = math.radians(az), math.radians(el)
            out.append(('az%d_el%d' % (az, el), np.array([-math.cos(e) * math.sin(a), -math.sin(e), -math.cos(e) * math.cos(a)])))
    out.append(('top', np.array([0.0, -1.0, 0.0])))
    return out


def raster(P, d, px=0.015, maxres=320, bias=None):
    """Orthographic z-buffer along view direction d (from the camera into the scene).
    bias: per-triangle depth offset (back faces pushed 2 mm back so exact back-to-back twins resolve like culling).
    Returns tri id per pixel (-1 = empty)."""
    d = d / np.linalg.norm(d)
    up = np.array([0, 1.0, 0]) if abs(d[1]) < 0.95 else np.array([0, 0, -1.0])
    rx = np.cross(d, up); rx /= np.linalg.norm(rx); ry = np.cross(rx, d)
    V = P.reshape(-1, 3)
    X = V @ rx; Y = V @ ry; Z = V @ d
    x0, x1, y0, y1 = X.min(), X.max(), Y.min(), Y.max()
    s = max(px, max(x1 - x0, y1 - y0) / maxres)
    W = int((x1 - x0) / s) + 2; H = int((y1 - y0) / s) + 2
    X = ((X - x0) / s).reshape(-1, 3); Y = ((Y - y0) / s).reshape(-1, 3); Z = Z.reshape(-1, 3)
    bx0 = np.floor(X.min(1)).astype(int); bx1 = np.ceil(X.max(1)).astype(int)
    by0 = np.floor(Y.min(1)).astype(int); by1 = np.ceil(Y.max(1)).astype(int)
    bw = np.clip(bx1 - bx0 + 1, 1, None); bh = np.clip(by1 - by0 + 1, 1, None)
    depth = np.full(W * H, np.inf); tid = np.full(W * H, -1, np.int64)
    area = (X[:, 1] - X[:, 0]) * (Y[:, 2] - Y[:, 0]) - (X[:, 2] - X[:, 0]) * (Y[:, 1] - Y[:, 0])
    ok = np.abs(area) > 1e-9
    idx = np.nonzero(ok)[0]
    cnt = (bw * bh)[idx]
    CH = 3_000_000
    starts = np.concatenate([[0], np.cumsum(cnt)])
    i = 0
    while i < len(idx):
        j = np.searchsorted(starts, starts[i] + CH, side='right') - 1
        j = max(j, i + 1)
        sel = idx[i:j]; c = cnt[i:j]
        t = np.repeat(sel, c)
        loc = np.arange(c.sum()) - np.repeat(np.cumsum(c) - c, c)
        w_ = np.repeat(bw[sel], c)
        px_ = bx0[t] + loc % w_ + 0.5; py_ = by0[t] + loc // w_ + 0.5
        ax, ay = X[t, 0], Y[t, 0]; bxv, byv = X[t, 1], Y[t, 1]; cx, cy = X[t, 2], Y[t, 2]
        ar = area[t]
        w0 = ((bxv - px_) * (cy - py_) - (cx - px_) * (byv - py_)) / ar
        w1 = ((cx - px_) * (ay - py_) - (ax - px_) * (cy - py_)) / ar
        w2 = 1 - w0 - w1
        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        pxi = (px_ - 0.5).astype(int); pyi = (py_ - 0.5).astype(int)
        inside &= (pxi >= 0) & (pxi < W) & (pyi >= 0) & (pyi < H)
        t = t[inside]; z = (w0 * Z[t, 0] + w1 * Z[t, 1] + w2 * Z[t, 2])[inside] if False else None
        w0, w1, w2 = w0[inside], w1[inside], w2[inside]
        z = w0 * Z[t, 0] + w1 * Z[t, 1] + w2 * Z[t, 2]
        if bias is not None:
            z = z + bias[t]
        pix = pyi[inside] * W + pxi[inside]
        o = np.lexsort((z, pix))
        pix, z, t = pix[o], z[o], t[o]
        first = np.ones(len(pix), bool); first[1:] = pix[1:] != pix[:-1]
        pix, z, t = pix[first], z[first], t[first]
        better = z < depth[pix]
        depth[pix[better]] = z[better]; tid[pix[better]] = t[better]
        i = j
    return tid.reshape(H, W)


# ------------------------------------------------------------------ geometry helpers
def closest_pt_tri(p, a, b, c):
    """Vectorised closest point on triangles (Ericson). p,a,b,c (N,3)."""
    ab = b - a; ac = c - a; ap = p - a
    d1 = (ab * ap).sum(1); d2 = (ac * ap).sum(1)
    bp = p - b; d3 = (ab * bp).sum(1); d4 = (ac * bp).sum(1)
    cp = p - c; d5 = (ab * cp).sum(1); d6 = (ac * cp).sum(1)
    vc = d1 * d4 - d3 * d2; vb = d5 * d2 - d1 * d6; va = d3 * d6 - d5 * d4
    den = va + vb + vc; den = np.where(np.abs(den) < 1e-20, 1e-20, den)
    v = vb / den; w = vc / den
    res = a + ab * v[:, None] + ac * w[:, None]
    # edge / vertex regions
    m = (d1 <= 0) & (d2 <= 0); res[m] = a[m]
    m2 = (d3 >= 0) & (d4 <= d3); res[m2 & ~m] = b[m2 & ~m]; m |= m2
    m2 = (d6 >= 0) & (d5 <= d6) & ~m; res[m2] = c[m2]; m |= m2
    m2 = (vc <= 0) & (d1 >= 0) & (d3 <= 0) & ~m
    t = d1 / np.where(np.abs(d1 - d3) < 1e-20, 1e-20, d1 - d3); res[m2] = (a + ab * t[:, None])[m2]; m |= m2
    m2 = (vb <= 0) & (d2 >= 0) & (d6 <= 0) & ~m
    t = d2 / np.where(np.abs(d2 - d6) < 1e-20, 1e-20, d2 - d6); res[m2] = (a + ac * t[:, None])[m2]; m |= m2
    m2 = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0) & ~m
    t = (d4 - d3) / np.where(np.abs((d4 - d3) + (d5 - d6)) < 1e-20, 1e-20, (d4 - d3) + (d5 - d6))
    res[m2] = (b + (c - b) * t[:, None])[m2]
    return res


def seg_tri_hit(p0, p1, a, b, c):
    """Segments p0-p1 vs triangles (pairwise rows) -> bool."""
    d = p1 - p0; e1 = b - a; e2 = c - a
    h = np.cross(d, e2); det = (e1 * h).sum(1)
    ok = np.abs(det) > 1e-12; inv = 1 / np.where(ok, det, 1)
    s = p0 - a; u = (s * h).sum(1) * inv
    q = np.cross(s, e1); v = (d * q).sum(1) * inv; t = (e2 * q).sum(1) * inv
    return ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t >= 0) & (t <= 1)


def islands_touch(PA, EA, PB, EB, tol):
    """Do two triangle soups touch / intersect? PA (n,3,3)."""
    # vertices of one within tol of the other's surface
    for P1, P2 in ((PA, PB), (PB, PA)):
        V = np.unique(P1.reshape(-1, 3), axis=0)
        # plus points along the edges every ~4 cm (a sheet edge running along a rail face has no vertex near it)
        E = np.concatenate([P1[:, [0, 1]], P1[:, [1, 2]], P1[:, [2, 0]]])
        L = np.linalg.norm(E[:, 1] - E[:, 0], axis=1)
        nseg = np.clip((L / 0.04).astype(int), 0, 40)
        if nseg.sum():
            ei = np.repeat(np.arange(len(E)), nseg); t = (np.arange(nseg.sum()) - np.repeat(np.cumsum(nseg) - nseg, nseg) + 0.5) / np.repeat(nseg, nseg)
            V = np.concatenate([V, E[ei, 0] + (E[ei, 1] - E[ei, 0]) * t[:, None]])
        mn = P2.reshape(-1, 3).min(0) - tol; mx = P2.reshape(-1, 3).max(0) + tol
        V = V[np.all((V >= mn) & (V <= mx), 1)]
        if not len(V):
            continue
        # triangles of P2 near V's bbox
        vm, vM = V.min(0) - tol, V.max(0) + tol
        tm = P2.min(1); tM = P2.max(1)
        T = P2[np.all((tM >= vm) & (tm <= vM), 1)]
        if not len(T):
            continue
        CH = max(1, 400000 // len(T))
        for k in range(0, len(V), CH):
            v = V[k:k + CH]
            pv = np.repeat(v, len(T), 0); tt = np.tile(T, (len(v), 1, 1))
            q = closest_pt_tri(pv, tt[:, 0], tt[:, 1], tt[:, 2])
            if (np.linalg.norm(pv - q, axis=1) < tol).any():
                return True
    # edges of one crossing triangles of the other
    for E1, P2 in ((EA, PB), (EB, PA)):
        mn = P2.reshape(-1, 3).min(0); mx = P2.reshape(-1, 3).max(0)
        em = np.minimum(E1[:, 0], E1[:, 1]); eM = np.maximum(E1[:, 0], E1[:, 1])
        E = E1[np.all((eM >= mn) & (em <= mx), 1)]
        if not len(E):
            continue
        tm = P2.min(1); tM = P2.max(1)
        T = P2[np.all((tM >= E.reshape(-1, 3).min(0)) & (tm <= E.reshape(-1, 3).max(0)), 1)]
        if not len(T):
            continue
        CH = max(1, 400000 // len(T))
        for k in range(0, len(E), CH):
            e = E[k:k + CH]
            pe = np.repeat(e, len(T), 0); tt = np.tile(T, (len(e), 1, 1))
            if seg_tri_hit(pe[:, 0], pe[:, 1], tt[:, 0], tt[:, 1], tt[:, 2]).any():
                return True
    return False


def zfight(P, N, dbl, eps=4e-4):
    """Triangles overlapping another coplanar same-facing triangle."""
    C = P.mean(1)
    L = np.linalg.norm(P - C[:, None], axis=2).max(1)
    tree = cKDTree(C)
    bad = np.zeros(len(P), bool)
    R = float(np.percentile(L, 99)) if len(L) else 0
    for i in np.argsort(-L)[:0]:
        pass
    pairs = tree.query_pairs(max(R, 1e-3) * 1.0, output_type='ndarray')
    if not len(pairs):
        return bad
    i, j = pairs[:, 0], pairs[:, 1]
    cosn = (N[i] * N[j]).sum(1)
    same = cosn > 0.999
    m = same      # opposite twins never fight: FrontSide culls one; double-sided ones shade identically
    i, j = i[m], j[m]
    dpl = np.abs(((C[j] - P[i, 0]) * N[i]).sum(1))
    m = dpl < eps
    i, j = i[m], j[m]
    if not len(i):
        return bad

    def inside(c, a, b, cc, n, margin=0.15):
        # c strictly inside triangle (shrunk towards its centroid by margin)
        g = (a + b + cc) / 3
        a = g + (a - g) * (1 - margin); b = g + (b - g) * (1 - margin); cc = g + (cc - g) * (1 - margin)
        s1 = (np.cross(b - a, c - a) * n).sum(1); s2 = (np.cross(cc - b, c - b) * n).sum(1); s3 = (np.cross(a - cc, c - cc) * n).sum(1)
        return ((s1 > 0) & (s2 > 0) & (s3 > 0)) | ((s1 < 0) & (s2 < 0) & (s3 < 0))
    hit = inside(C[i], P[j, 0], P[j, 1], P[j, 2], N[j]) | inside(C[j], P[i, 0], P[i, 1], P[i, 2], N[i])
    bad[i[hit]] = True; bad[j[hit]] = True
    return bad


# ------------------------------------------------------------------ per-asset analysis
NOT_GROUNDED = re.compile(r'^(crater_|wire|attach|.*_lod1$|trench|dugout|berm)')
# allowed to reach below ground (embedded posts / trunks / piles / pits)
SINK_OK = re.compile(r'^(tree_|bush_|leafy_|stump|crater_|rubble_|trench|dugout|berm|.*pole|barbed_wire|concertina|tyre_pile|church|house_c|fence_wattle|fallen_trunk)')
FOLIAGE = re.compile(r'^(tree_|bush_|leafy_|corn_|sunflower_|weeds_)')


def analyse(name, P, dbl, verbose=False, imgdir=None, touch_limit=400):
    res = {'name': name, 'tris': int(len(P))}
    if not len(P):
        return res
    e1 = P[:, 1] - P[:, 0]; e2 = P[:, 2] - P[:, 0]
    Nn = np.cross(e1, e2); A2 = np.linalg.norm(Nn, axis=1)
    keep = A2 > 1e-10
    P, dbl, Nn, A2 = P[keep], dbl[keep], Nn[keep], A2[keep]
    N = Nn / A2[:, None]
    V, F = weld(P)
    E, ti, boundary, flipped, ecount = topology(F, len(V))
    tl = islands(F, len(V))
    nI = tl.max() + 1
    # per island
    isl = []
    vol = np.zeros(nI); np.add.at(vol, tl, (P[:, 0] * np.cross(P[:, 1], P[:, 2])).sum(1) / 6)
    bnd_t = np.zeros(len(F), int); np.add.at(bnd_t, ti[boundary], 1)
    open_cnt = np.zeros(nI, int); np.add.at(open_cnt, tl, bnd_t)
    flip_t = np.zeros(len(F), int); np.add.at(flip_t, ti[flipped], 1)
    flip_cnt = np.zeros(nI, int); np.add.at(flip_cnt, tl, flip_t)
    dbl_i = np.zeros(nI); np.add.at(dbl_i, tl, dbl.astype(float))
    tcount = np.bincount(tl, minlength=nI)
    dbl_i = dbl_i / tcount > 0.5
    imn = np.full((nI, 3), np.inf); imx = np.full((nI, 3), -np.inf)
    np.minimum.at(imn, tl, P.min(1)); np.maximum.at(imx, tl, P.max(1))
    single = ~dbl_i
    res['islands'] = int(nI)
    res['open_edges'] = int((open_cnt[single]).sum() // 1)
    res['open_islands'] = int(((open_cnt > 0) & single).sum())
    res['flip_edges'] = int(flip_cnt[single].sum() // 2)
    inv = (open_cnt == 0) & single & (vol < -1e-5)
    res['inverted_shells'] = int(inv.sum())
    mn = P.reshape(-1, 3).min(0); mx = P.reshape(-1, 3).max(0)
    res['bbox'] = [[round(float(v), 3) for v in mn], [round(float(v), 3) for v in mx]]
    res['minY'] = round(float(mn[1]), 3)
    # backface visibility
    views = []
    tot_px = tot_bad = 0
    bad_tris = np.zeros(len(P), int)
    for vn, d in view_dirs():
        tid = raster(P, d, bias=np.where((N @ d) > 1e-4, 0.002, 0.0))
        hitm = tid >= 0
        t = tid[hitm]
        back = ((N[t] @ d) > 1e-4) & ~dbl[t]
        nb = int(back.sum()); npx = int(hitm.sum())
        tot_px += npx; tot_bad += nb
        np.add.at(bad_tris, t[back], 1)
        views.append((vn, nb, npx))
        if imgdir and nb:
            from PIL import Image
            H, W = tid.shape
            img = np.full((H, W, 3), 255, np.uint8)
            shade = np.clip(0.35 + 0.65 * np.abs(N[t] @ np.array([0.4, 0.8, 0.45])), 0, 1)
            col = np.stack([shade * 200, shade * 200, shade * 200], 1)
            col[back] = [230, 20, 20]
            col[dbl[t]] = col[dbl[t]] * np.array([0.6, 1.0, 0.6])
            img[hitm] = col.astype(np.uint8)
            Image.fromarray(img[::-1]).resize((W * 2, H * 2), Image.NEAREST).save(os.path.join(imgdir, f'{name}_{vn}.png'))
    res['backface_pct'] = round(100 * tot_bad / max(1, tot_px), 3)
    res['backface_worst_view'] = max(views, key=lambda v: v[1] / max(1, v[2]))[0] if tot_bad else ''
    res['backface_worst_pct'] = round(max(100 * v[1] / max(1, v[2]) for v in views), 2)
    # floating parts: touch graph between islands
    tol = 0.01
    grounded = imn[:, 1] < 0.02
    nIs = nI
    order = np.arange(nI)
    if nI > touch_limit:     # huge soups (foliage): only check the largest islands
        order = np.argsort(-tcount)[:touch_limit]
    sel = np.zeros(nI, bool); sel[order] = True
    Pi = {k: P[tl == k] for k in order}
    Ei = {}
    for k in order:
        Q = Pi[k]; Ei[k] = np.concatenate([Q[:, [0, 1]], Q[:, [1, 2]], Q[:, [2, 0]]])
    adj = []
    lo = imn - tol; hi = imx + tol
    for a_ in range(len(order)):
        a = order[a_]
        ov = np.all((lo[order] <= hi[a]) & (hi[order] >= lo[a]), 1)
        for b in order[ov]:
            if b <= a:
                continue
            if islands_touch(Pi[a], Ei[a], Pi[b], Ei[b], tol):
                adj.append((a, b))
    if adj:
        adj = np.array(adj)
        g = coo_matrix((np.ones(len(adj)), (adj[:, 0], adj[:, 1])), shape=(nI, nI))
        _, cl = connected_components(g, directed=False)
    else:
        cl = np.arange(nI)
    floating = []
    for c in np.unique(cl[sel]):
        m = (cl == c) & sel
        if grounded[m].any():
            continue
        floating.append({'islands': [int(x) for x in np.nonzero(m)[0]], 'tris': int(tcount[m].sum()),
                         'min': [round(float(v), 3) for v in imn[m].min(0)], 'max': [round(float(v), 3) for v in imx[m].max(0)]})
    res['floating'] = len(floating)
    res['floating_tris'] = int(sum(f['tris'] for f in floating))
    zb = zfight(P, N, dbl)
    res['zfight_tris'] = int(zb.sum())
    if verbose:
        res['floating_detail'] = floating
        det = []
        bad_i = np.zeros(nI, int); np.add.at(bad_i, tl, bad_tris)
        zf_i = np.zeros(nI, int); np.add.at(zf_i, tl, zb.astype(int))
        for k in range(nI):
            if (open_cnt[k] and single[k]) or flip_cnt[k] or inv[k] or bad_i[k] or zf_i[k]:
                det.append({'island': k, 'tris': int(tcount[k]), 'dbl': bool(dbl_i[k]), 'open_edges': int(open_cnt[k]),
                            'flip': int(flip_cnt[k]), 'vol': round(float(vol[k]), 5), 'backpx': int(bad_i[k]), 'zfight': int(zf_i[k]),
                            'min': [round(float(v), 3) for v in imn[k]], 'max': [round(float(v), 3) for v in imx[k]]})
        det.sort(key=lambda d: -d['backpx'])
        res['island_detail'] = det
        res['views'] = views
    return res


def flags(r, name):
    f = []
    if r.get('backface_worst_pct', 0) > 0.5:
        f.append('HOLES')
    if r.get('flip_edges', 0) > 0:
        f.append('FLIP')
    if r.get('inverted_shells', 0):
        f.append('INV')
    grounded = not NOT_GROUNDED.match(name)
    if grounded and r.get('minY', 0) > 0.02:
        f.append('FLOAT')
    if grounded and r.get('minY', 0) < -0.05 and not SINK_OK.match(name):
        f.append('SUNK')
    if r.get('floating', 0) and not FOLIAGE.match(name):
        f.append('PARTS-AIR')
    if r.get('zfight_tris', 0):
        f.append('ZFIGHT')
    return f


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('glbs', nargs='*')
    ap.add_argument('-a', '--asset', default='')
    ap.add_argument('-v', '--verbose', action='store_true')
    ap.add_argument('--img', default='')
    ap.add_argument('--json', default='')
    a = ap.parse_args()
    glbs = a.glbs or [os.path.join(REPO, 'assets/env', f) for f in
                      ('city.glb', 'props.glb', 'farmland.glb', 'trees.glb', 'wires.glb')] + \
        [os.path.join(REPO, 'assets/env/rubble_%d.glb' % i) for i in range(1, 7)]
    rx = re.compile(a.asset) if a.asset else None
    if a.img:
        os.makedirs(a.img, exist_ok=True)
    out = {}
    for g in glbs:
        j, b = load_glb(g)
        gname = os.path.basename(g)
        print(f'== {gname}')
        print(f'  {"asset":34s} {"tris":>6s} {"isl":>4s} {"open":>5s} {"flipE":>5s} {"inv":>3s} {"back%":>6s} {"worst%":>6s} {"minY":>7s} {"float":>5s} {"zf":>4s}  flags')
        rows = []
        for ri in j['scenes'][0]['nodes']:
            nm = j['nodes'][ri].get('name', str(ri))
            if rx and not rx.search(nm):
                continue
            P, dbl = gather(j, b, ri)
            if not len(P):
                continue
            r = analyse(nm, P, dbl, a.verbose, a.img)
            r['flags'] = flags(r, nm)
            rows.append(r)
            print(f'  {nm:34s} {r["tris"]:6d} {r["islands"]:4d} {r["open_edges"]:5d} {r["flip_edges"]:5d} {r["inverted_shells"]:3d} '
                  f'{r["backface_pct"]:6.2f} {r["backface_worst_pct"]:6.2f} {r["minY"]:7.3f} {r["floating"]:5d} {r["zfight_tris"]:4d}  {" ".join(r["flags"])}', flush=True)
            if a.verbose and r['flags']:
                for d in r.get('floating_detail', [])[:12]:
                    print('      floating', d)
                for d in r.get('island_detail', [])[:25]:
                    print('      island', d)
        out[gname] = rows
        nflag = sum(1 for r in rows if r['flags'])
        print(f'  -> {len(rows)} assets, {nflag} flagged')
    if a.json:
        with open(a.json, 'w') as f:
            json.dump(out, f, indent=1)


if __name__ == '__main__':
    main()
