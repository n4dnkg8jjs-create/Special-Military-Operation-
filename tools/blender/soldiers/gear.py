"""Gear geometry: body envelope sampling, padded panels (plates), bands (cummerbund, tape), straps,
MOLLE webbing rows, beveled pouches (Blender), helmets, backpack.  All in glTF model space (Y up, +Z fwd).
A 'part' is dict(pos, nrm, uv, tri, mat) (+ optional 'bone'/'W'); parts are later merged per node/material."""
import numpy as np
import bpy  # noqa: F401  (makes mathutils importable)
from mathutils.bvhtree import BVHTree
from mathutils import Vector
import meshutil as MU


def part(pos, tri, mat, uv=None, nrm=None, smooth=True):
    pos = np.asarray(pos, float); tri = np.asarray(tri, int)
    if nrm is None:
        nrm = MU.vertex_normals(pos, tri) if smooth else None
    if uv is None:
        uv = np.zeros((len(pos), 2))
    return dict(pos=pos, nrm=nrm, uv=np.asarray(uv, float), tri=tri, mat=mat)


def grid_tris(nu, nv, closed_u=False):
    T = []
    cu = nu if closed_u else nu - 1
    for j in range(nv - 1):
        for i in range(cu):
            a = j * nu + i; b = j * nu + (i + 1) % nu
            c = (j + 1) * nu + (i + 1) % nu; d = (j + 1) * nu + i
            T += [[a, b, c], [a, c, d]]
    return np.array(T, int)


def merge(parts):
    pos, nrm, uv, tri, col = [], [], [], [], []
    off = 0
    for p in parts:
        pos.append(p['pos']); nrm.append(p['nrm'] if p['nrm'] is not None else MU.vertex_normals(p['pos'], p['tri']))
        uv.append(p['uv']); tri.append(p['tri'] + off)
        col.append(p.get('col', np.ones((len(p['pos']), 3))))
        off += len(p['pos'])
    return dict(pos=np.concatenate(pos), nrm=np.concatenate(nrm), uv=np.concatenate(uv), tri=np.concatenate(tri),
                col=np.concatenate(col))


class Envelope:
    """max radial extent of a set of meshes around a vertical torso axis"""

    def __init__(self, meshes, y0=0.92, y1=1.62, dy=0.01, dth_deg=2.0, r_meshes=None):
        """meshes: (pos, tri) sets for ray casts (self.trees: limbs, straps).  r_meshes: optional trunk-only sets for the radius
        table (arms removed): rays that pass through an arm hole are filled by interpolation around the trunk, so panels near
        the armpits / shoulders follow the chest and back instead of jumping out onto the deltoids."""
        self.trees = [BVHTree.FromPolygons([tuple(v) for v in m[0]], [tuple(map(int, t)) for t in m[1]], all_triangles=True) for m in meshes]
        rtrees = self.trees if r_meshes is None else [BVHTree.FromPolygons([tuple(v) for v in m[0]], [tuple(map(int, t)) for t in m[1]], all_triangles=True) for m in r_meshes]
        self.ys = np.arange(y0, y1 + 1e-9, dy)
        self.ths = np.radians(np.arange(-180, 180, dth_deg))
        # torso centre z per height from front/back hits at x=0
        zc = []
        for y in self.ys:
            zf = max(self._hit((0, y, 1.0), (0, 0, -1)) or [0.1])
            zb = min(self._hit((0, y, -1.0), (0, 0, 1)) or [-0.1])
            zc.append(0.5 * (zf + zb) if zf > zb else 0.0)
        self.zc = np.array(zc)
        from scipy.ndimage import gaussian_filter1d
        self.zc = gaussian_filter1d(self.zc, 3)
        R = np.zeros((len(self.ys), len(self.ths)))
        for i, y in enumerate(self.ys):
            o = np.array([0, y, self.zc[i]])
            for j, th in enumerate(self.ths):
                d = np.array([np.sin(th), 0, np.cos(th)])
                best = 0.05 if r_meshes is None else np.nan
                for t in rtrees:
                    # first surface hit from the torso axis outward (ignores arms)
                    hit = t.ray_cast(Vector(o), Vector(d), 0.6)
                    if hit[0] is not None:
                        best = hit[3] if np.isnan(best) else max(best, hit[3])
                R[i, j] = best
        if r_meshes is not None:
            # arm holes: periodic interpolation around the trunk per row (rows with too few hits copy the row below)
            n = len(self.ths)
            for i in range(len(self.ys)):
                ok = ~np.isnan(R[i])
                if ok.sum() < n // 4:
                    R[i] = R[i - 1] if i > 0 else 0.05
                    continue
                k = np.arange(n)
                R[i] = np.interp(k, np.r_[k[ok] - n, k[ok], k[ok] + n], np.r_[R[i, ok], R[i, ok], R[i, ok]])
        self.R = R

    def _hit(self, o, d):
        out = []
        for t in self.trees:
            h = t.ray_cast(Vector(o), Vector(d), 3.0)
            if h[0] is not None:
                out.append(h[0][2])
        return out

    def smooth(self, s_y=1.5, s_th=2.0):
        from scipy.ndimage import gaussian_filter
        self.R = gaussian_filter(self.R, (s_y, s_th), mode=('nearest', 'wrap'))

    def r(self, y, th):
        """bilinear radius lookup; th in rad (0 = front), arrays ok"""
        y = np.asarray(y, float); th = np.asarray(th, float)
        fy = np.clip((y - self.ys[0]) / (self.ys[1] - self.ys[0]), 0, len(self.ys) - 1.001)
        dth = self.ths[1] - self.ths[0]
        ft = ((th - self.ths[0]) / dth) % len(self.ths)
        i0 = np.floor(fy).astype(int); j0 = np.floor(ft).astype(int)
        wy = fy - i0; wt = ft - j0
        j1 = (j0 + 1) % len(self.ths)
        r = (self.R[i0, j0] * (1 - wy) * (1 - wt) + self.R[i0 + 1, j0] * wy * (1 - wt) +
             self.R[i0, j1] * (1 - wy) * wt + self.R[i0 + 1, j1] * wy * wt)
        return r

    def zcen(self, y):
        return np.interp(y, self.ys, self.zc)

    def point(self, y, th, off=0.0):
        r = self.r(y, th) + off
        return np.stack([r * np.sin(th), np.broadcast_to(y, np.shape(r)), self.zcen(y) + r * np.cos(th)], -1)

    def normal(self, y, th, eps=0.004):
        """outward surface normal at (y, th)"""
        p = self.point(y, th)
        r = self.r(y, th)
        pt = self.point(y, th + eps / np.maximum(r, 0.05))
        py = self.point(y + eps, th)
        n = np.cross(py - p, pt - p)
        n = n / np.linalg.norm(n, axis=-1, keepdims=True)
        out = p - np.stack([np.zeros_like(p[..., 0]), p[..., 1], self.zcen(p[..., 1])], -1)
        s = np.sign(np.sum(n * out, -1, keepdims=True))
        return n * np.where(s == 0, 1, s)


def rounded_rect_map(u, v, hw, hh, rad, chamfer_top=0.0):
    """map unit square grid (u,v in [-1,1]) to a rounded rectangle (x in [-hw,hw], y in [-hh,hh]);
    chamfer_top cuts the top corners (shooter's cut) by that many metres"""
    x = u * hw; y = v * hh
    # shooter's cut: narrow the top corners
    if chamfer_top > 0:
        t = np.clip((y - (hh - chamfer_top * 1.6)) / (chamfer_top * 1.6), 0, 1)
        x = x * (1 - t * chamfer_top / hw)
    # round corners
    cx = np.clip(np.abs(x), hw - rad, None) - (hw - rad)
    cy = np.clip(np.abs(y), hh - rad, None) - (hh - rad)
    d = np.hypot(cx, cy)
    k = np.where(d > rad, rad / np.maximum(d, 1e-9), 1)
    x = np.sign(x) * ((hw - rad) + cx * k) * (np.abs(x) > hw - rad) + x * (np.abs(x) <= hw - rad)
    y = np.sign(y) * ((hh - rad) + cy * k) * (np.abs(y) > hh - rad) + y * (np.abs(y) <= hh - rad)
    return x, y


def env_panel(env, th0, yc, hw, hh, thick, gap=0.004, nu=18, nv=20, rad=0.03, chamfer=0.0, edge=0.012,
              mat=None, uv_scale=2.0, bulge=1.0, back=False):
    """padded panel (plate bag) conforming to the torso envelope. hw/hh in metres (arc length / height).
    returns part with closed pillow (outer + inner + rim)"""
    u = np.linspace(-1, 1, nu); v = np.linspace(-1, 1, nv)
    U, Vv = np.meshgrid(u, v)
    xs, ys = rounded_rect_map(U, Vv, hw, hh, rad, chamfer)
    y = yc + ys
    rmean = env.r(yc, th0)
    th = th0 + xs / rmean * (-1 if back else 1)
    # thickness profile: full inside, rolling off at edges (plate bulge)
    du = 1 - np.abs(U); dv = 1 - np.abs(Vv)
    em = np.minimum(du * hw, dv * hh)
    prof = np.clip(em / edge, 0, 1)
    prof = np.sqrt(prof) * (0.85 + 0.15 * bulge * (1 - (U ** 2) * 0.5 - (Vv ** 2) * 0.3))
    outer = env.point(y, th, gap + thick * np.maximum(prof, 0.15))
    inner = env.point(y, th, gap)
    pos = np.concatenate([outer.reshape(-1, 3), inner.reshape(-1, 3)])
    n = nu * nv
    T = grid_tris(nu, nv)
    Ti = grid_tris(nu, nv)[:, ::-1] + n
    # rim: border ring joining outer and inner
    ring = [(0, i) for i in range(nu)] + [(j, nu - 1) for j in range(1, nv)] + [(nv - 1, i) for i in range(nu - 2, -1, -1)] + [(j, 0) for j in range(nv - 2, 0, -1)]
    ids = [j * nu + i for j, i in ring]
    rim = []
    m = len(ids)
    for k in range(m):
        a, b = ids[k], ids[(k + 1) % m]
        rim += [[a + n, b + n, b], [a + n, b, a]]
    tri = np.concatenate([T, Ti, np.array(rim)])
    if back:
        tri = tri[:, ::-1]
    uv = np.concatenate([np.stack([xs.reshape(-1), -ys.reshape(-1)], 1)] * 2) * uv_scale
    p = part(pos, tri, mat, uv)
    p['frame'] = dict(env=env, th0=th0, yc=yc, rmean=rmean, back=back, hw=hw, hh=hh, thick=thick, gap=gap, edge=edge)
    return p


def panel_point(fr, x, y, h_extra=0.0):
    """surface point + normal + tangent frame on a panel's outer face at panel coords (x across, y up)"""
    env = fr['env']
    th = fr['th0'] + x / fr['rmean'] * (-1 if fr['back'] else 1)
    yy = fr['yc'] + y
    p = env.point(yy, th, fr['gap'] + fr['thick'] + h_extra)
    n = env.normal(yy, th)
    up = np.array([0, 1.0, 0]); up = up - n * (up @ n); up /= np.linalg.norm(up)
    side = np.cross(up, n)
    return p, n, up, side


def band(env, y0, y1, th_a, th_b, off, thick, nu=40, nv=4, mat=None, uv_scale=2.0, wrinkle=0.0, seed=0):
    """band (cummerbund) around the torso between angles th_a..th_b (rad), closed solid strip"""
    th = np.linspace(th_a, th_b, nu)
    yv = np.linspace(y0, y1, nv)
    TH, Y = np.meshgrid(th, yv)
    rng = np.random.default_rng(seed)
    w = wrinkle * np.sin(TH * 23 + rng.uniform(0, 6)) * np.sin(Y * 60)
    outer = env.point(Y, TH, off + thick + w)
    inner = env.point(Y, TH, off)
    n = nu * nv
    T = grid_tris(nu, nv)
    Ti = T[:, ::-1] + n
    rim = []
    ring = [(0, i) for i in range(nu)] + [(j, nu - 1) for j in range(1, nv)] + [(nv - 1, i) for i in range(nu - 2, -1, -1)] + [(j, 0) for j in range(nv - 2, 0, -1)]
    ids = [j * nu + i for j, i in ring]
    for k in range(len(ids)):
        a, b = ids[k], ids[(k + 1) % len(ids)]
        rim += [[a + n, b + n, b], [a + n, b, a]]
    r0 = env.r((y0 + y1) / 2, 0)
    uv = np.stack([TH.reshape(-1) * r0, -Y.reshape(-1)], 1) * uv_scale
    pos = np.concatenate([outer.reshape(-1, 3), inner.reshape(-1, 3)])
    return part(pos, np.concatenate([T, Ti, np.array(rim)]), mat, np.concatenate([uv, uv]))


def molle_rows_panel(fr, x0, x1, y_top, rows, mat, pitch=0.038, h=0.025, gap_row=0.0, raise_=0.0018):
    """MOLLE webbing: horizontal strips (2.5 cm) with 3.8 cm bar-tack pitch on a panel"""
    parts = []
    for r in range(rows):
        yc = y_top - r * (h + 0.0) - r * 0.0 - h / 2 - r * 0.0
        yc = y_top - h / 2 - r * (h + 0.0) * 1.0 - r * 0.0
        yc = y_top - (r + 0.5) * h - r * (0.0)
        # PALS: 1" webbing rows spaced 1" apart -> row pitch 2 * h
        yc = y_top - h / 2 - r * 2 * h * 0.98
        nx = max(int((x1 - x0) / 0.019) + 1, 4)
        xs = np.linspace(x0, x1, nx)
        top, bot, nr = [], [], []
        for x in xs:
            # loops bulge between bar tacks
            ph = ((x - x0) % pitch) / pitch
            bul = raise_ * (0.6 + 0.4 * np.sin(ph * np.pi))
            pt, n, up, side = panel_point(fr, x, yc + h / 2, bul)
            pb, _, _, _ = panel_point(fr, x, yc - h / 2, bul)
            top.append(pt); bot.append(pb); nr.append(n)
        top = np.array(top); bot = np.array(bot); nr = np.array(nr)
        # front face + small side walls
        base_t = top - nr * raise_ * 1.2; base_b = bot - nr * raise_ * 1.2
        pos = np.concatenate([base_t, top, bot, base_b])
        T = grid_tris(nx, 4)
        uv = np.concatenate([np.stack([xs * 2, np.full(nx, k * 0.0125)], 1) for k in range(4)]) * 2
        p = part(pos, T, mat, uv, smooth=False)
        p['nrm'] = None
        parts.append(p)
    return parts


def ring_band(center_fn, n_around=24, n_along=4, mat=None):
    pass


def signed_volume(pos, tri):
    a, b, c = pos[tri[:, 0]], pos[tri[:, 1]], pos[tri[:, 2]]
    return np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6


def orient_closed(p):
    if signed_volume(p['pos'], p['tri']) < 0:
        p['tri'] = p['tri'][:, ::-1]
    p['nrm'] = MU.vertex_normals(p['pos'], p['tri'])
    return p


def orient_open(p, outward):
    """flip so that average face normal agrees with outward vector(s) (n,3) per vertex or (3,)"""
    pos, tri = p['pos'], p['tri']
    fn = np.cross(pos[tri[:, 1]] - pos[tri[:, 0]], pos[tri[:, 2]] - pos[tri[:, 0]])
    ow = np.asarray(outward)
    if ow.ndim == 2:
        ow = ow[tri].mean(1)
    if np.sum(fn * ow) < 0:
        p['tri'] = tri[:, ::-1]
    p['nrm'] = MU.vertex_normals(p['pos'], p['tri'])
    return p


def box_uv(p, scale=2.0, local=None, crease_deg=40):
    """per-face box projection (physical scale, 1 UV = 1/scale m); splits verts per projection axis.
    Also splits normals at hard creases for crisp bevel edges."""
    pos, tri = p['pos'], p['tri']
    L = p.get('local') if local is None else local
    if L is None:
        L = pos
    fnL = np.cross(L[tri[:, 1]] - L[tri[:, 0]], L[tri[:, 2]] - L[tri[:, 0]])
    ax = np.argmax(np.abs(fnL), 1)
    key = tri * 3 + ax[:, None]
    uniq, inv = np.unique(key.reshape(-1), return_inverse=True)
    src = uniq // 3; axv = uniq % 3
    npos = pos[src]; nL = L[src]
    uv = np.where(axv[:, None] == 0, nL[:, [2, 1]], np.where(axv[:, None] == 1, nL[:, [0, 2]], nL[:, [0, 1]])) * scale
    uv[:, 1] *= -1
    ntri = inv.reshape(-1, 3)
    q = dict(p); q.update(pos=npos, tri=ntri, uv=uv, nrm=MU.vertex_normals(npos, ntri))
    # smooth normals across the split (keep shading soft on bevels) using positions
    q['nrm'] = MU.weld_normals(npos, q['nrm'], 1e-6)
    if 'col' in p:
        q['col'] = p['col'][src]
    q.pop('local', None)
    return q
