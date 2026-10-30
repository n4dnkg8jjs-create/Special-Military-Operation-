"""Mesh helpers: OBJ-style faces -> GL vertex arrays, normals, smoothing."""
import numpy as np


def vertex_normals(V, T):
    fn = np.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]])
    n = np.zeros_like(V)
    for k in range(3):
        np.add.at(n, T[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def triangulate(faces):
    out = []
    for f in faces:
        for k in range(1, len(f) - 1):
            out.append([f[0], f[k], f[k + 1]])
    return np.array(out, int)


def split_by_uv(V, faces, ftex, VT, keep_faces):
    """Build GL arrays: one GL vertex per unique (v, vt). returns pos, uv, tri, src_vertex_index"""
    key = {}
    src, uvs, tris = [], [], []
    for fi in keep_faces:
        f, t = faces[fi], ftex[fi]
        ids = []
        for v, vt in zip(f, t):
            k = (v, vt)
            if k not in key:
                key[k] = len(src); src.append(v); uvs.append(VT[vt] if vt >= 0 else (0, 0))
            ids.append(key[k])
        for k in range(1, len(ids) - 1):
            tris.append([ids[0], ids[k], ids[k + 1]])
    src = np.array(src)
    return V[src], np.array(uvs, np.float64), np.array(tris, int), src


def laplacian_smooth(V, T, iters=5, lam=0.5, mask=None):
    """uniform Laplacian smoothing; mask (n,) in [0,1] scales movement"""
    n = len(V)
    E = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    E = np.concatenate([E, E[:, ::-1]])
    V = V.copy()
    deg = np.bincount(E[:, 0], minlength=n).astype(float)
    for _ in range(iters):
        acc = np.zeros_like(V)
        np.add.at(acc, E[:, 0], V[E[:, 1]])
        avg = acc / np.maximum(deg, 1)[:, None]
        d = (avg - V) * lam
        if mask is not None:
            d *= mask[:, None]
        V += d
    return V


def weld_normals(pos, nrm, tol=1e-5):
    """average normals over vertices sharing a position (hide UV seams)"""
    q = np.round(pos / tol).astype(np.int64)
    _, inv = np.unique(q, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    acc = np.zeros((inv.max() + 1, 3))
    np.add.at(acc, inv, nrm)
    out = acc[inv]
    return out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-12)
