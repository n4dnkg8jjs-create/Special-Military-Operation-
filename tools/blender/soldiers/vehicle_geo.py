"""Vehicle geometry for the vehicle-relative soldier clips (hatch_exit_*, dismount_*): reads the LOD0 meshes of a vehicle GLB
(assets/vehicles/<name>.glb, vehicle space: +Z forward, +X = the vehicle's left, +Y up, ground at y=0), voxelises their surfaces
and fills the closed interior -> a solid occupancy grid.  Used by the clip builders (contact heights: roof, deck, fender, wheel
tops) and by check_anims.py (body points inside the vehicle).  Cached per GLB mtime in .cache/vgeo_<name>.npz.
run: python3 vehicle_geo.py <name> [z ...]   -> prints cross-section profiles"""
import os, sys, json, struct
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '../../..'))
CACHE = os.path.join(HERE, '.cache')
VOX = 0.025


def _q2m(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def read_glb(path):
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    g = json.loads(b[20:20 + n])
    off = 20 + n
    bl = struct.unpack('<I', b[off:off + 4])[0]
    return g, b[off + 8:off + 8 + bl]


def _acc(g, bin_, i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]
    o = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    k = dict(SCALAR=1, VEC2=2, VEC3=3, VEC4=4)[a['type']]
    dt = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[a['componentType']]
    stride = bv.get('byteStride')
    if stride and stride != k * np.dtype(dt).itemsize:
        raw = np.frombuffer(bin_, np.uint8, stride * a['count'], o).reshape(a['count'], stride)
        return raw[:, :k * np.dtype(dt).itemsize].copy().view(dt).reshape(a['count'], k)
    return np.frombuffer(bin_, dt, a['count'] * k, o).reshape(a['count'], k)


def nodes_world(g):
    """world 4x4 per node + empties dict name -> (pos, rot quat, extras)"""
    N = len(g['nodes'])
    parent = [-1] * N
    for i, nd in enumerate(g['nodes']):
        for c in nd.get('children', []):
            parent[c] = i
    M = [None] * N

    def world(i):
        if M[i] is not None:
            return M[i]
        nd = g['nodes'][i]
        L = np.eye(4)
        if 'matrix' in nd:
            L = np.array(nd['matrix']).reshape(4, 4).T
        else:
            L[:3, :3] = _q2m(nd.get('rotation', [0, 0, 0, 1])) * np.array(nd.get('scale', [1, 1, 1]))[None]
            L[:3, 3] = nd.get('translation', [0, 0, 0])
        M[i] = L if parent[i] < 0 else world(parent[i]) @ L
        return M[i]
    for i in range(N):
        world(i)
    return M


def empties(name):
    g, _ = read_glb(f'{ROOT}/assets/vehicles/{name}.glb')
    M = nodes_world(g)
    out = {}
    for i, nd in enumerate(g['nodes']):
        if 'mesh' not in nd and nd.get('name'):
            out[nd['name']] = dict(pos=M[i][:3, 3].tolist(), extras=nd.get('extras'))
    return out


def triangles(name, skip=('LOD1', 'wreck', 'cope_cage')):
    g, bin_ = read_glb(f'{ROOT}/assets/vehicles/{name}.glb')
    M = nodes_world(g)
    tris = []
    for i, nd in enumerate(g['nodes']):
        if 'mesh' not in nd or any(s in nd.get('name', '') for s in skip):
            continue
        for p in g['meshes'][nd['mesh']]['primitives']:
            if p.get('mode', 4) != 4:
                continue
            P = _acc(g, bin_, p['attributes']['POSITION']).astype(np.float64)
            P = P @ M[i][:3, :3].T + M[i][:3, 3]
            idx = _acc(g, bin_, p['indices'])[:, 0].astype(np.int64) if 'indices' in p else np.arange(len(P))
            tris.append(P[idx.reshape(-1, 3)])
    return np.concatenate(tris, 0)


class VGeo:
    """solid occupancy grid of a vehicle (vehicle space)"""
    def __init__(self, name):
        self.name = name
        path = f'{ROOT}/assets/vehicles/{name}.glb'
        cp = f'{CACHE}/vgeo_{name}.npz'
        mt = os.path.getmtime(path)
        if os.path.exists(cp) and float(np.load(cp)['mtime']) == mt:
            d = np.load(cp)
            self.lo, self.solid, self.surf = d['lo'], d['solid'], d['surf']
        else:
            self.lo, self.solid, self.surf = self._build()
            os.makedirs(CACHE, exist_ok=True)
            np.savez_compressed(cp, lo=self.lo, solid=self.solid, surf=self.surf, mtime=mt)
        self.shape = np.array(self.solid.shape)
        self.E = empties(name)
        self._top = None

    def _build(self):
        from scipy import ndimage
        T = triangles(self.name)
        lo = T.reshape(-1, 3).min(0) - 4 * VOX; lo[1] = min(lo[1], -2 * VOX)
        hi = T.reshape(-1, 3).max(0) + 4 * VOX
        shape = np.ceil((hi - lo) / VOX).astype(int) + 1
        surf = np.zeros(shape, bool)
        # sample every triangle densely (spacing <= VOX / 2)
        e1 = T[:, 1] - T[:, 0]; e2 = T[:, 2] - T[:, 0]
        L = np.maximum(np.linalg.norm(e1, axis=1), np.linalg.norm(e2, axis=1))
        L = np.maximum(L, np.linalg.norm(T[:, 2] - T[:, 1], axis=1))
        n = np.clip(np.ceil(L / (VOX * 0.5)).astype(int), 1, 400)
        for k in np.unique(n):
            sel = n == k
            u, v = np.meshgrid(np.arange(k + 1), np.arange(k + 1))
            m = (u + v) <= k
            u = u[m] / k; v = v[m] / k
            P = T[sel, 0][:, None] + e1[sel][:, None] * u[None, :, None] + e2[sel][:, None] * v[None, :, None]
            ij = np.floor((P.reshape(-1, 3) - lo) / VOX).astype(int)
            ij = np.clip(ij, 0, shape - 1)
            surf[ij[:, 0], ij[:, 1], ij[:, 2]] = True
        # close small gaps, then flood the exterior from the grid boundary; interior = not exterior
        closed = ndimage.binary_closing(surf, iterations=2) | surf
        ext = ~closed
        lab, nl = ndimage.label(ext)
        border = np.unique(np.concatenate([lab[0].ravel(), lab[-1].ravel(), lab[:, 0].ravel(), lab[:, -1].ravel(), lab[:, :, 0].ravel(), lab[:, :, -1].ravel()]))
        outside = np.isin(lab, border[border > 0])
        solid = ~outside
        solid[:, :2, :] = False        # ground layer
        return lo, solid, surf

    # ---------------------------------------------------------------- queries (vehicle space)
    def ijk(self, P):
        return np.floor((np.asarray(P, float) - self.lo) / VOX).astype(int)

    def inside(self, P):
        P = np.asarray(P, float)
        ij = self.ijk(P)
        ok = np.all((ij >= 0) & (ij < self.shape), axis=-1)
        ijc = np.clip(ij, 0, self.shape - 1)
        return ok & self.solid[ijc[..., 0], ijc[..., 1], ijc[..., 2]]

    def depth(self, P, r=0.0):
        """penetration depth of spheres (centre P, radius r) into the solid: distance from the centre to the nearest free voxel
        + r if the centre is inside, else r - distance to the nearest solid voxel (<= 0 means clear)"""
        if not hasattr(self, '_din'):
            from scipy import ndimage
            self._din = ndimage.distance_transform_edt(self.solid) * VOX      # inside: distance to free space
            self._dout = ndimage.distance_transform_edt(~self.solid) * VOX    # outside: distance to the solid
        P = np.asarray(P, float)
        ij0 = self.ijk(P)
        ij = np.clip(ij0, 0, self.shape - 1)
        outside = np.linalg.norm((ij0 - ij) * VOX, axis=-1)          # beyond the grid: add the distance to it
        din = np.where(outside > 0, 0.0, self._din[ij[..., 0], ij[..., 1], ij[..., 2]])
        dout = self._dout[ij[..., 0], ij[..., 1], ij[..., 2]] + outside
        return np.where(din > 0, din + r, r - dout + VOX * 0.5)

    def ray_down(self, x, z, below=9.0):
        """exact height of the highest mesh surface under (x, below, z) (ray cast against the LOD0 triangles)"""
        if not hasattr(self, '_tris'):
            self._tris = triangles(self.name)
            T = self._tris
            self._tb = (T[:, :, 0].min(1), T[:, :, 0].max(1), T[:, :, 2].min(1), T[:, :, 2].max(1))
        T = self._tris; x0, x1, z0, z1 = self._tb
        m = (x0 <= x) & (x1 >= x) & (z0 <= z) & (z1 >= z)
        best = 0.0
        for a, b, c in T[m]:
            d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
            if abs(d) < 1e-12:
                continue
            l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d
            l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d
            l3 = 1 - l1 - l2
            if min(l1, l2, l3) < -1e-9:
                continue
            y = l1 * a[1] + l2 * b[1] + l3 * c[1]
            if best < y <= below:
                best = y
        return float(best)

    def top(self, x, z, below=9.0):
        """highest solid surface y at (x, z) under the height `below`"""
        ij = self.ijk([x, below, z])
        i, k = np.clip(ij[0], 0, self.shape[0] - 1), np.clip(ij[2], 0, self.shape[2] - 1)
        col = self.solid[i, :min(max(ij[1], 0), self.shape[1] - 1) + 1, k]
        w = np.where(col)[0]
        return float(self.lo[1] + (w.max() + 1) * VOX) if len(w) else 0.0

    def side_x(self, y, z, side=1, x_from=None):
        """outermost solid x on the given side (+1 = the vehicle's left / +X) at height y, station z"""
        ij = self.ijk([0, y, z])
        j, k = np.clip(ij[1], 0, self.shape[1] - 1), np.clip(ij[2], 0, self.shape[2] - 1)
        row = self.solid[:, j, k]
        w = np.where(row)[0]
        if not len(w):
            return 0.0
        return float(self.lo[0] + (w.max() + 1) * VOX) if side > 0 else float(self.lo[0] + w.min() * VOX)

    def profile(self, z, side=1, ys=None):
        ys = np.arange(0.05, 2.6, 0.05) if ys is None else ys
        return [(round(float(y), 2), round(self.side_x(y, z, side), 3)) for y in ys]


if __name__ == '__main__':
    name = sys.argv[1]
    V = VGeo(name)
    print(name, 'grid', V.shape, 'lo', V.lo, 'solid frac %.3f' % V.solid.mean())
    for k, v in V.E.items():
        print('  ', k, np.round(v['pos'], 3).tolist(), v['extras'] or '')
    zs = [float(a) for a in sys.argv[2:]] or [0.0]
    for z in zs:
        print(f'--- z={z}: left side profile (y, outer x)')
        print(V.profile(z, 1))
        xs = np.arange(-1.9, 1.95, 0.1)
        print('top surface y across x:', [(round(x, 1), round(V.top(x, z), 2)) for x in xs])
