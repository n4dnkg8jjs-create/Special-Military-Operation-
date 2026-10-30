"""Builds assets/env/props.glb (one material 'props_atlas'): burnt VAZ-2107 sedans, burnt PAZ-3205 bus, Czech
hedgehogs, sandbag walls of individual bags, tyres, Soviet garage-row units, bus stop with smalt mosaic,
playground climbing frame, newspaper kiosks, shell craters with ejecta.
Top-level node names match the city.js regexes (car_*, bus_*, hedgehog_*, sandbag_*, tyre_*, garage_*, bus_stop,
playground_*, kiosk_*, crater_*). Origin: ground centre of the footprint, forward = +Z.
Run: cd tools/blender/env && nice -n 10 python3 build_props.py
"""
import os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from meshlib import *
import props_atlas as PA

R = {k: Region(*v) for k, v in PA.REG.items()}


def tbox(mb, mn, mx, name, tile=1.0, faces='all', M=None):
    """Box whose faces are subdivided so the region texture repeats every `tile` metres (atlas can't wrap)."""
    reg = R[name]
    x0, y0, z0 = mn; x1, y1, z1 = mx
    F = {'+x': ((x1, y0, z1), (0, 0, -1), (0, 1, 0), z1 - z0, y1 - y0), '-x': ((x0, y0, z0), (0, 0, 1), (0, 1, 0), z1 - z0, y1 - y0),
         '+y': ((x0, y1, z1), (1, 0, 0), (0, 0, -1), x1 - x0, z1 - z0), '-y': ((x0, y0, z0), (1, 0, 0), (0, 0, 1), x1 - x0, z1 - z0),
         '+z': ((x0, y0, z1), (1, 0, 0), (0, 1, 0), x1 - x0, y1 - y0), '-z': ((x1, y0, z0), (-1, 0, 0), (0, 1, 0), x1 - x0, y1 - y0)}
    for k, (o, du, dv, Lu, Lv) in F.items():
        if faces != 'all' and k not in faces:
            continue
        o = np.array(o, float); du = np.array(du, float); dv = np.array(dv, float)
        nu, nv = max(1, int(math.ceil(Lu / tile - 1e-6))), max(1, int(math.ceil(Lv / tile - 1e-6)))
        for i in range(nu):
            for j in range(nv):
                a0, a1 = i * tile, min(Lu, (i + 1) * tile); b0, b1 = j * tile, min(Lv, (j + 1) * tile)
                P = np.array([o + du * a0 + dv * b0, o + du * a1 + dv * b0, o + du * a1 + dv * b1, o + du * a0 + dv * b1])
                if M is not None:
                    P = xform(P, M)
                uv = [reg.uv(0, 0), reg.uv((a1 - a0) / tile, 0), reg.uv((a1 - a0) / tile, (b1 - b0) / tile), reg.uv(0, (b1 - b0) / tile)]
                mb.poly(P, lambda P_, n_, uv=uv: uv)


def fit(name, size=(1.0, 1.0), seed=0, stretch=False):
    return Fit(R[name], size, seed, stretch)


def luv(name, L=1.0):
    reg = R[name]
    return lambda s, l: reg.uv(s, (l / L) % 1.0)


class CarUV:
    """Projection of car/bus body faces into the side/top/front sub-areas of the body region."""
    def __init__(self, reg, L, Hh, W, front_y=(0.2, 0.9), zf=None):
        self.r = reg; self.L = L; self.H = Hh; self.W = W; self.fy = front_y; self.zf = zf if zf is not None else L / 2

    def __call__(self, P, n):
        out = []
        ax = np.abs(n)
        for p in P:
            if ax[0] >= ax[1] and ax[0] >= ax[2]:      # side
                s = (self.zf - p[2]) / self.L; t = 0.5 + 0.5 * (p[1] / self.H)
            elif ax[1] >= ax[2]:                        # top
                s = (self.zf - p[2]) / self.L; t = 0.125 + 0.375 * (1 - (p[0] + self.W / 2) / self.W)
            else:                                       # front / rear
                half = 0 if n[2] > 0 else 0.5
                s = half + 0.5 * (p[0] + self.W / 2) / self.W; t = 0.125 * np.clip((p[1] - self.fy[0]) / (self.fy[1] - self.fy[0]), 0, 1)
            out.append(self.r.uv(np.clip(s, 0, 1), np.clip(t, 0, 1)))
        return out


def loft(mb, stations, uvfn, cap_front=True, cap_back=True, skip_edges=()):
    """stations: list of (z, Nx2 profile (x, y)) all with the same N, profile CCW seen from +Z. Faces outward."""
    rings = [[(p[0], p[1], z) for p in prof] for z, prof in stations]
    N = len(rings[0])
    for i in range(len(rings) - 1):
        for k in range(N):
            if k in skip_edges:
                continue
            k2 = (k + 1) % N
            Q = [rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]]
            Pq = np.array(Q); nn = newell(Pq)
            c = Pq.mean(0)
            if np.dot(nn, [c[0], c[1] - 0.6, 0]) < 0:
                Q = Q[::-1]
            mb.poly(Q, uvfn)
    if cap_front:
        mb.poly(rings[0][::-1] if newell(np.array(rings[0]))[2] < 0 else rings[0], uvfn)
    if cap_back:
        P = rings[-1]; mb.poly(P if newell(np.array(P))[2] < 0 else P[::-1], uvfn)


def rim(mb, c, r_=0.18, w=0.14, side=1, sides=10):
    """Burnt wheel on its rim (tyre burnt away): cylinder + dished face."""
    x, y, z = c
    reg = R['rim']
    tmp = MB()
    ring0 = [(0, r_ * math.cos(2 * math.pi * k / sides), r_ * math.sin(2 * math.pi * k / sides)) for k in range(sides)]
    a = tmp.vs([(-w / 2, p[1], p[2]) for p in ring0]); b = tmp.vs([(w / 2, p[1], p[2]) for p in ring0])
    for k in range(sides):
        k2 = (k + 1) % sides
        tmp.face((a[k], a[k2], b[k2], b[k]), [reg.uv(k / sides, 0), reg.uv((k + 1) / sides, 0), reg.uv((k + 1) / sides, 0.2), reg.uv(k / sides, 0.2)], True)
    face = lambda xx: [reg.uv(0.5 + 0.5 * p[1] / r_, 0.5 + 0.5 * p[2] / r_) for p in [(0, q[1], q[2]) for q in ring0]]
    tmp.face(b, face(w / 2)); tmp.face(a[::-1], face(-w / 2)[::-1])
    mb.merge(tmp, mat_trs((x, y, z), (0, 0, 0)))


# ------------------------------------------------------------------ VAZ-2107
def car_vaz2107(name, seed=1, sag=0.0):
    mb = MB(name); r = rng(seed)
    W2 = 0.8
    uvb = CarUV(R['car_body'], PA.CAR_L, 1.0, 1.6, front_y=(0.2, 0.9), zf=2.07)
    def prof(bottom, top, w=W2):
        return np.array([(-w, bottom), (w, bottom), (w + 0.01, (bottom + top) / 2 + 0.05), (w - 0.01, top - 0.02), (w - 0.25, top), (-(w - 0.25), top), (-(w - 0.01), top - 0.02), (-(w + 0.01), (bottom + top) / 2 + 0.05)])
    # front section (bumper -> windscreen base) and rear section (rear seat -> tail)
    front = [(2.07, prof(0.32, 0.74, 0.74)), (1.98, prof(0.24, 0.8, 0.79)), (1.5, prof(0.18, 0.84)), (0.72, prof(0.18, 0.87))]
    rear = [(-1.2, prof(0.18, 0.87)), (-1.7, prof(0.2, 0.85)), (-2.0, prof(0.26, 0.82, 0.79)), (-2.07, prof(0.34, 0.78, 0.74))]
    loft(mb, front, uvb); loft(mb, rear, uvb)
    # cabin: side walls (doors), floor; open top (glass gone)
    for s in (-1, 1):
        x = s * W2
        P = [(x, 0.18, 0.72), (x, 0.18, -1.2), (x, 0.87, -1.2), (x, 0.87, 0.72)]
        mb.poly(P if s > 0 else P[::-1], uvb)
        xi = s * (W2 - 0.05)
        P = [(xi, 0.3, -1.2), (xi, 0.3, 0.72), (xi, 0.85, 0.72), (xi, 0.85, -1.2)]
        mb.poly(P if s > 0 else P[::-1], fit('interior_burnt', (1.9, 0.6), 1))
        mb.poly([(x, 0.87, 0.72), (x, 0.87, -1.2), (xi, 0.85, -1.2), (xi, 0.85, 0.72)][::(1 if s > 0 else -1)], uvb)
    mb.poly([(-W2, 0.3, 0.72), (W2, 0.3, 0.72), (W2, 0.3, -1.2), (-W2, 0.3, -1.2)][::-1], fit('ash', (1.6, 1.9), 2))
    # greenhouse: roof (sagging) + pillars
    roof_y = 1.3 - sag
    mb.box((-0.66, roof_y - 0.03, -0.85), (0.66, roof_y, 0.3), uvb, faces='+y-y+x-x+z-z')
    for s in (-1, 1):
        for (zb, zt) in ((0.72, 0.3), (-0.27, -0.27), (-1.2, -0.85)):
            mb.tube([(s * 0.76, 0.86, zb), (s * 0.66, roof_y - 0.02, zt)], 0.035, 4, luv('car_body', 2.0), smooth=False)
    # dashboard, seats (burnt spring frames), steering wheel
    mb.box((-0.75, 0.55, 0.45), (0.75, 0.82, 0.7), fit('interior_burnt', (1.5, 0.3), 3), faces='+y-z')
    for sx in (-0.38, 0.38):
        mb.box((sx - 0.24, 0.32, -0.15), (sx + 0.24, 0.45, 0.35), fit('interior_burnt', (0.5, 0.5), 4), faces='+y+z+x-x')
        mb.box((sx - 0.24, 0.45, -0.22), (sx + 0.24, 0.98, -0.12), fit('interior_burnt', (0.5, 0.6), 5), faces='+z-z+y')
    mb.box((-0.7, 0.32, -1.15), (0.7, 0.46, -0.65), fit('interior_burnt', (1.4, 0.5), 6), faces='+y+z')
    sw = [(0.38 + 0.18 * math.cos(a), 0.8 + 0.18 * math.sin(a) * 0.8, 0.42 - 0.08 * math.sin(a)) for a in np.linspace(0, 2 * np.pi, 9)]
    mb.tube(sw, 0.015, 3, luv('chrome_burnt'), smooth=True)
    # bumpers (burnt chrome), sagging front bumper
    mb.box((-0.78, 0.38, 2.04), (0.78, 0.5, 2.12), fit('chrome_burnt', (1.6, 0.15), 7), faces='+z+y-y+x-x')
    mb.box((-0.78, 0.38, -2.12), (0.78, 0.48, -2.04), fit('chrome_burnt', (1.6, 0.15), 8), faces='-z+y-y+x-x')
    # wheels on rims
    for (sx, sz) in ((-1, 1), (1, 1), (-1, -1), (1, -1)):
        rim(mb, (sx * 0.66, 0.18, sz * 1.21))
    return mb


# ------------------------------------------------------------------ PAZ-3205 bus
def bus_paz(name='bus_paz_burnt', seed=2):
    mb = MB(name); r = rng(seed)
    L2, W2 = 3.46, 1.25
    uvb = CarUV(R['bus_body'], PA.BUS_L, PA.BUS_H, 2.5, front_y=(0.0, 2.9), zf=3.5)
    belt, floor, bot = 1.15, 0.55, 0.38
    doors = [(2.35, 3.15), (-0.95, -0.1)]   # on the right side (-X) of the bus
    # lower side panels (with door gaps on -X)
    for s in (-1, 1):
        x = s * W2
        zs = [L2, -L2]
        segs = [(L2, -L2)] if s > 0 else [(L2, doors[0][1]), (doors[0][0], doors[1][1]), (doors[1][0], -L2)]
        for z0, z1 in segs:
            P = [(x, bot, z0), (x, bot, z1), (x, belt, z1), (x, belt, z0)]
            mb.poly(P if s > 0 else P[::-1], uvb)
            P = [(x * 0.97, floor, z1), (x * 0.97, floor, z0), (x * 0.97, belt, z0), (x * 0.97, belt, z1)]
            mb.poly(P if s > 0 else P[::-1], fit('interior_burnt', (2.0, 0.6), int(abs(z0) * 10)))
            mb.poly([(x, belt, z0), (x, belt, z1), (x * 0.97, belt, z1), (x * 0.97, belt, z0)][::(1 if s > 0 else -1)], uvb)
    # front and rear lower faces + window frames
    for zf, sgn in ((L2, 1), (-L2, -1)):
        P = [(-W2, bot, zf), (W2, bot, zf), (W2, belt + (0.0 if sgn > 0 else 0.15), zf), (-W2, belt + (0.0 if sgn > 0 else 0.15), zf)]
        mb.poly(P if sgn > 0 else P[::-1], uvb)
        # destination box / upper front band
        P = [(-W2, 2.4, zf), (W2, 2.4, zf), (W2, 2.82, zf), (-W2, 2.82, zf)]
        mb.poly(P if sgn > 0 else P[::-1], uvb)
        for xx in (-W2 + 0.04, 0.0, W2 - 0.04):
            mb.tube([(xx, belt, zf - sgn * 0.02), (xx * 0.98, 2.4, zf - sgn * 0.02)], 0.04, 4, luv('bus_body', 2.0), smooth=False)
    # window pillars and rails
    for s in (-1, 1):
        x = s * (W2 - 0.03)
        for z in np.arange(L2 - 0.1, -L2, -1.05):
            if s < 0 and any(a - 0.1 >= z >= b + 0.1 for b, a in doors):
                continue
            mb.tube([(x, belt, z), (x * 0.97, 2.35, z)], 0.035, 4, luv('bus_body', 2.0), smooth=False)
        mb.tube([(x, 2.38, L2), (x, 2.38, -L2)], 0.04, 4, luv('bus_body', 6.0), smooth=False)
    # sagging, partly burnt-through roof: 3 strips with a dip in the middle
    xs = [-W2, -0.45, 0.45, W2]; ys = [2.4, 2.78, 2.78, 2.4]
    zs = np.linspace(L2, -L2, 9)
    dip = lambda z: 0.35 * math.exp(-((z + 0.6) / 1.4) ** 2)
    for j in range(3):
        if j == 1:
            continue  # burnt-through centre strip (open)
        for i in range(len(zs) - 1):
            z0, z1 = zs[i], zs[i + 1]
            P = [(xs[j], ys[j] - dip(z0), z0), (xs[j + 1], ys[j + 1] - dip(z0), z0), (xs[j + 1], ys[j + 1] - dip(z1), z1), (xs[j], ys[j] - dip(z1), z1)]
            if newell(np.array(P))[1] < 0:
                P = P[::-1]
            mb.poly(P, uvb)
    # roof bows across the open strip
    for z in zs[1:-1]:
        mb.tube([(-0.45, 2.78 - dip(z), z), (0.0, 2.85 - dip(z) * 1.2, z), (0.45, 2.78 - dip(z), z)], 0.025, 3, luv('rim'), smooth=False)
    # floor + seat frames (2+1 rows)
    mb.poly([(-W2, floor, L2), (W2, floor, L2), (W2, floor, -L2), (-W2, floor, -L2)][::-1], fit('ash', (2.5, 7.0), 3, stretch=True))
    for z in np.arange(1.6, -3.2, -0.78):
        for x0, x1 in ((0.15, 1.15), (-1.15, -0.65)):
            mb.box((x0, floor + 0.35, z - 0.2), (x1, floor + 0.45, z + 0.2), fit('interior_burnt', (1.0, 0.4), int(z * 10 + 50)), faces='+y+z-z')
            mb.box((x0, floor + 0.45, z - 0.25), (x1, floor + 1.0, z - 0.2), fit('interior_burnt', (1.0, 0.6), int(z * 10 + 60)), faces='+z-z')
            mb.tube([((x0 + x1) / 2, floor, z), ((x0 + x1) / 2, floor + 0.35, z)], 0.02, 3, luv('rim'), smooth=False)
    # engine cowl by the driver, dashboard
    mb.box((-0.2, floor, 2.5), (0.55, floor + 0.65, 3.4), fit('bus_body', (0.8, 0.9), 4))
    mb.box((-1.2, floor + 0.6, 3.15), (1.2, floor + 0.95, 3.42), fit('interior_burnt', (2.4, 0.4), 5), faces='+y-z')
    # wheels: single front, dual rear (on rims)
    for s in (-1, 1):
        rim(mb, (s * 1.05, 0.36, 2.25), r_=0.33, w=0.2)
        rim(mb, (s * 1.0, 0.36, -1.4), r_=0.33, w=0.2)
        rim(mb, (s * 0.75, 0.36, -1.4), r_=0.33, w=0.2)
    # chassis rails visible under the floor
    for x in (-0.55, 0.55):
        mb.box((x - 0.06, 0.25, -3.2), (x + 0.06, floor, 3.2), fit('steel_rust', (0.2, 3.0), 9), faces='+x-x-y')
    return mb


# ------------------------------------------------------------------ hedgehogs
def hedgehog(name, kind='ibeam', seed=3):
    mb = MB(name); r = rng(seed)
    L = 2.1
    if kind == 'ibeam':
        h, b, tw, tf = 0.2, 0.12, 0.009, 0.014
        prof = [(-b / 2, -h / 2), (b / 2, -h / 2), (b / 2, -h / 2 + tf), (tw / 2, -h / 2 + tf), (tw / 2, h / 2 - tf), (b / 2, h / 2 - tf),
                (b / 2, h / 2), (-b / 2, h / 2), (-b / 2, h / 2 - tf), (-tw / 2, h / 2 - tf), (-tw / 2, -h / 2 + tf), (-b / 2, -h / 2 + tf)]
    else:  # railway rail
        prof = [(-0.075, -0.09), (0.075, -0.09), (0.075, -0.075), (0.012, -0.06), (0.012, 0.05), (0.038, 0.06), (0.038, 0.09), (-0.038, 0.09), (-0.038, 0.06), (-0.012, 0.05), (-0.012, -0.06), (-0.075, -0.075)]
    prof = np.array(prof)
    reg = R['steel_rust']
    tmp = MB()
    for axis in range(3):
        # extrude profile along local X, then rotate onto the axis
        ring0 = [(-L / 2, p[1], p[0]) for p in prof]; ring1 = [(L / 2, p[1], p[0]) for p in prof]
        a = tmp.vs(ring0); b_ = tmp.vs(ring1); n = len(prof)
        sub = MB(); a = sub.vs(ring0); b_ = sub.vs(ring1)
        for k in range(n):
            k2 = (k + 1) % n
            Q = (a[k], a[k2], b_[k2], b_[k])
            P = np.array([sub.V[i] for i in Q])
            nn = newell(P); c = P.mean(0)
            if np.dot(nn, [0, c[1], c[2]]) < 0:
                Q = Q[::-1]
            sub.face(Q, [reg.uv(k / n, 0), reg.uv((k + 1) / n, 0), reg.uv((k + 1) / n, 1), reg.uv(k / n, 1)], False)
        from meshlib import tessellate
        for ends, flip in ((a, True), (b_, False)):
            tri = tessellate([prof])
            for t3 in tri:
                Q = [ends[i] for i in t3]
                P = np.array([sub.V[i] for i in Q])
                if (newell(P)[0] > 0) == flip:
                    Q = Q[::-1]
                sub.face(Q, [reg.uv(0.5, 0.5)] * 3)
        rot = [mat_trs(), mat_trs(r=(0, 0, math.pi / 2)) @ mat_trs(r=(math.pi / 2, 0, 0)), mat_trs(r=(0, math.pi / 2, 0)) @ mat_trs(r=(0, 0, math.pi / 2))][axis]
        tmp.merge(sub, rot)
    # gusset plates at the crossing
    tmp.box((-0.12, -0.12, -0.004), (0.12, 0.12, 0.004), Fit(reg, (0.3, 0.3), 1))
    # orient: body diagonal (1,1,1) vertical -> stands on three beam ends
    d = np.array([1, 1, 1.0]) / math.sqrt(3)
    axis = np.cross(d, [0, 1, 0]); ang = math.acos(np.dot(d, [0, 1, 0]))
    M = rot_axis(axis, ang) @ rot_axis((1, 1, 1), r.uniform(0, 1))
    tmp.transform(M)
    mn, mx = tmp.bounds()
    tmp.transform(mat_trs((0, -mn[1] - 0.02, 0)))
    mb.merge(tmp)
    return mb


# ------------------------------------------------------------------ sandbags
def bag(mb, c, size, yaw, seed, region, squash=0.0):
    """Filled sandbag: superellipsoid pillow (6x5 grid), flattened by the weight above, tied end."""
    r = rng(seed)
    a, b, cc = size[0] / 2, size[1] / 2, size[2] / 2
    nu, nv = 8, 5
    reg = R[region]
    S = lambda x, e: math.copysign(abs(x) ** e, x)
    rings = []
    for i in range(nv + 1):
        v = -math.pi / 2 + math.pi * i / nv
        row = []
        for j in range(nu):
            u = 2 * math.pi * j / nu
            x = a * S(math.cos(v), 0.35) * S(math.cos(u), 0.3)
            z = cc * S(math.cos(v), 0.35) * S(math.sin(u), 0.45)
            y = b * S(math.sin(v), 0.5)
            y *= (1 - squash * 0.3)
            x *= 1 + squash * 0.06; z *= 1 + squash * 0.08
            x += r.normal(0, 0.006); y += r.normal(0, 0.004); z += r.normal(0, 0.006)
            row.append((x, y, z))
        rings.append(row)
    tmp = MB()
    ids = [tmp.vs(rw) for rw in rings]
    for i in range(nv):
        for j in range(nu):
            j2 = (j + 1) % nu
            Q = (ids[i][j], ids[i][j2], ids[i + 1][j2], ids[i + 1][j])
            uv = [reg.uv(j / nu, i / nv), reg.uv((j + 1) / nu, i / nv), reg.uv((j + 1) / nu, (i + 1) / nv), reg.uv(j / nu, (i + 1) / nv)]
            P = np.array([tmp.V[k] for k in Q])
            if np.dot(newell(P), P.mean(0)) < 0:
                Q = Q[::-1]; uv = uv[::-1]
            tmp.face(Q, uv, True)
    mb.merge(tmp, mat_trs(c, (r.normal(0, 0.03), yaw, r.normal(0, 0.03))))


def sandbag_wall(name, length=3.6, rows=5, seed=4, curved=0.0):
    mb = MB(name); r = rng(seed)
    bl, bh, bd = 0.56, 0.14, 0.32
    regions = ['bag_white', 'bag_green', 'bag_white', 'bag_jute', 'bag_green']
    y = 0.0
    for row in range(rows):
        n = int(length / bl)
        off = (row % 2) * bl / 2
        depth_rows = 2 if row < rows - 2 else 1      # two bags thick at the base
        for dz in range(depth_rows):
            for k in range(n + (1 if row % 2 == 0 else 0)):
                x = -length / 2 + off + k * bl + bl / 2 + r.normal(0, 0.02)
                if x > length / 2 - bl * 0.3:
                    continue
                z = (dz - (depth_rows - 1) / 2) * bd * 1.02 + r.normal(0, 0.015) + curved * (x / length) ** 2 * 2
                missing = row == rows - 1 and r.random() < 0.18
                if missing:
                    continue
                bag(mb, (x, y + bh / 2, z), (bl * r.uniform(0.95, 1.05), bh * r.uniform(0.9, 1.1), bd), r.normal(0, 0.06),
                    seed * 1000 + row * 50 + k * 2 + dz, regions[r.integers(0, len(regions))], squash=(rows - row) / rows)
        y += bh * 0.86
    # a burst bag spilling sand on top, and a couple of loose bags at the foot
    bag(mb, (r.uniform(-1, 1), 0.07, 0.55), (bl, bh, bd), r.uniform(0, 3), seed + 7, 'bag_green', squash=0.3)
    mb.box((-0.3, y - 0.02, -0.1), (0.2, y + 0.04, 0.12), fit('soil', (0.5, 0.3), 8), faces='+y+z-z+x-x')
    return mb


# ------------------------------------------------------------------ tyres
def tyre(mb, c, rot=(0, 0, 0), R0=0.3, r0=0.1, w=0.19, seg=14, sides=7, burnt=False):
    reg = R['tyre'] if not burnt else R['ash']
    tmp = MB(); rings = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        ring = []
        for k in range(sides):
            b = 2 * math.pi * k / sides
            rr = R0 + r0 * math.cos(b); yy = (w / 2) * np.sign(math.sin(b)) * abs(math.sin(b)) ** 0.5
            ring.append((rr * math.cos(a), yy, rr * math.sin(a)))
        rings.append(tmp.vs(ring))
    for i in range(seg):
        i2 = (i + 1) % seg
        for k in range(sides):
            k2 = (k + 1) % sides
            Q = (rings[i][k], rings[i][k2], rings[i2][k2], rings[i2][k])
            uv = [reg.uv(i / seg, k / sides), reg.uv(i / seg, (k + 1) / sides), reg.uv((i + 1) / seg, (k + 1) / sides), reg.uv((i + 1) / seg, k / sides)]
            P = np.array([tmp.V[t] for t in Q]); cen = P.mean(0)
            ring_c = np.array([cen[0], 0, cen[2]]); ring_c = ring_c / (np.linalg.norm(ring_c) + 1e-9) * R0
            if np.dot(newell(P), cen - ring_c) < 0:
                Q = Q[::-1]; uv = uv[::-1]
            tmp.face(Q, uv, True)
    mb.merge(tmp, mat_trs(c, rot))


def tyre_items():
    a = MB('tyre_single'); tyre(a, (0, 0.095, 0))
    b = MB('tyre_stack'); r = rng(5)
    for k in range(5):
        tyre(b, (r.normal(0, 0.03), 0.095 + k * 0.185, r.normal(0, 0.03)), (r.normal(0, 0.03), r.uniform(0, 3), r.normal(0, 0.03)), burnt=(k == 4))
    c = MB('tyre_pile')
    for k in range(4):
        tyre(c, (r.uniform(-0.5, 0.5), 0.1 + (0.12 if k == 3 else 0), r.uniform(-0.5, 0.5)), (r.uniform(-0.3, 0.3) if k < 3 else 1.3, r.uniform(0, 3), 0))
    return [a, b, c]


# ------------------------------------------------------------------ garage unit
def garage(name, damaged=False, seed=6):
    """One unit of a Soviet garage row: 3.6 m wide (game spaces units 3.6 m apart), 6 m deep, doors facing +Z."""
    mb = MB(name); r = rng(seed)
    Wg, D, Hg, t = 3.6, 6.0, 2.5, 0.12
    for s in (-1, 1):
        tbox(mb, (s * Wg / 2 - (t if s > 0 else 0), 0, -D / 2), (s * Wg / 2 + (0 if s > 0 else t), Hg, D / 2), 'silicate', 1.0, faces='+x-x+z+y')
    tbox(mb, (-Wg / 2, 0, -D / 2), (Wg / 2, Hg - 0.1, -D / 2 + t), 'silicate', 1.0, faces='-z+z')
    # lintel + brick parapet over the doors
    tbox(mb, (-Wg / 2, 2.15, D / 2 - 0.25), (Wg / 2, Hg + 0.25, D / 2), 'silicate', 1.0, faces='+z-y+y')
    # roof slab (hollow-core) with roofing felt, overhang at the front
    roof = fit('roofing', (3.6, 6.0), 2, stretch=True)
    if not damaged:
        tbox(mb, (-Wg / 2, Hg, -D / 2 - 0.1), (Wg / 2, Hg + 0.18, D / 2 + 0.15), 'roofing', 2.0, faces='+y-y+z-z')
    else:
        tbox(mb, (-Wg / 2, Hg, -D / 2 - 0.1), (Wg / 2, Hg + 0.18, 0.2), 'roofing', 2.0, faces='+y-y+z-z')
        # front slab broken and fallen in at an angle
        tmp = MB(); tmp.box((-Wg / 2 + 0.05, 0, 0), (Wg / 2 - 0.05, 0.18, 2.3), roof)
        mb.merge(tmp, mat_trs((0, Hg - 0.05, 0.2)) @ rot_axis((1, 0, 0), 0.75))
    # interior darkness
    mb.box((-Wg / 2 + t, 0.01, -D / 2 + t), (Wg / 2 - t, 2.15, D / 2 - 0.3), fit('ash', (3.0, 6.0), 3), faces='-y')
    mb.poly([(-Wg / 2 + t, 0, -D / 2 + t), (Wg / 2 - t, 0, -D / 2 + t), (Wg / 2 - t, 2.2, -D / 2 + t), (-Wg / 2 + t, 2.2, -D / 2 + t)], fit('ash', (3, 2), 4))
    # steel swing doors 2 x 1.3 x 2.05
    door = 'garage_door' if seed % 2 else 'garage_door2'
    def leaf(M):
        tmp = MB(); dreg = R[door]
        tmp.box((0, 0, -0.04), (1.33, 2.08, 0), lambda P, n: [dreg.uv(p[0] / 1.33, p[1] / 2.08) for p in P], faces='+z-z')
        tmp.box((0, 0, -0.04), (1.33, 2.08, 0), fit('steel_rust', (0.2, 2), 5), faces='+x-x+y')
        mb.merge(tmp, M)
    zf = D / 2 - 0.2
    if not damaged:
        leaf(mat_trs((-1.33, 0.05, zf)))
        leaf(mat_trs((1.33, 0.05, zf)) @ mat_trs(r=(0, math.pi, 0)) @ mat_trs((0, 0, 0.04)))
    else:
        leaf(mat_trs((-1.33, 0.05, zf)) @ mat_trs(r=(0, -1.9, 0)))                                  # blown wide open
        leaf(mat_trs((0.1, 0.02, zf + 1.4)) @ mat_trs(r=(-1.5, 0.3, 0.1)))                           # torn off, lying
    # padlock hasp / frame
    mb.box((-1.36, 0, zf - 0.03), (1.36, 2.12, zf), fit('steel_rust', (2.7, 2.1), 6), faces='+z')
    return mb


# ------------------------------------------------------------------ bus stop
def bus_stop():
    mb = MB('bus_stop'); r = rng(7)
    Wb, D, Hh = 3.4, 1.5, 2.3
    conc = fit('concrete', (2.0, 2.0), 1)
    mos = R['mosaic']
    # back wall with mosaic facing the street (+Z)
    tbox(mb, (-Wb / 2, 0, -0.18), (Wb / 2, Hh, 0), 'concrete', 1.5, faces='-z+x-x')
    mb.poly([(-Wb / 2, 0.15, 0.001), (Wb / 2, 0.15, 0.001), (Wb / 2, Hh - 0.05, 0.001), (-Wb / 2, Hh - 0.05, 0.001)],
            lambda P, n: [mos.uv((p[0] + Wb / 2) / Wb, (p[1] - 0.15) / (Hh - 0.2)) for p in P])
    for s in (-1, 1):
        tbox(mb, (s * Wb / 2 - (0.15 if s > 0 else 0), 0, 0), (s * Wb / 2 + (0 if s > 0 else 0.15), Hh, D * 0.7), 'concrete', 1.5, faces='+x-x+z')
    # roof slab, front corner blown off
    P = [(-Wb / 2 - 0.2, 0), (Wb / 2 + 0.2, 0), (Wb / 2 + 0.2, D - 0.6), (Wb / 2 - 0.3, D - 0.2), (Wb / 2 - 0.8, D + 0.15), (-Wb / 2 - 0.2, D + 0.15)]
    tmp = MB()
    from meshlib import slab as slab_, side_uv
    slab_(tmp, [{'pts': ccw(np.array([(x, -z) for x, z in P]))}], [0, -0.16], conc, fit('concrete', (2.0, 2.0), 2), side_uv(R['concrete'], 2.0))
    mb.merge(tmp, np.array([[1, 0, 0, 0], [0, 0, 1, Hh + 0.16], [0, -1, 0, 0], [0, 0, 0, 1.0]]))
    # fix orientation: the slab was built in (x, z) -> rotate so local y = depth
    # bench
    for z in (0.32, 0.45):
        mb.box((-1.2, 0.45, z - 0.05), (1.2, 0.48, z + 0.05), fit('wood', (2.4, 0.1), int(z * 100)), faces='+y+z-z')
    for x in (-1.0, 1.0):
        mb.box((x - 0.03, 0, 0.3), (x + 0.03, 0.45, 0.5), fit('steel_rust', (0.1, 0.5), 3), faces='+x-x+z-z')
    # sign pole with the "A" plate
    mb.tube([(Wb / 2 + 0.5, 0, D + 0.3), (Wb / 2 + 0.5, 2.6, D + 0.3)], 0.03, 5, luv('steel_rust'), smooth=False)
    sg = R['busstop_sign']
    mb.box((Wb / 2 + 0.3, 2.2, D + 0.33), (Wb / 2 + 0.7, 2.6, D + 0.35), lambda P, n: [sg.uv((p[0] - Wb / 2 - 0.3) / 0.4, (p[1] - 2.2) / 0.4) for p in P], faces='+z-z')
    # debris on the floor
    for k in range(5):
        x, z = r.uniform(-1.5, 1.5), r.uniform(0.3, 1.6)
        s_ = r.uniform(0.1, 0.3)
        mb.box((x, 0, z), (x + s_, s_ * 0.4, z + s_ * 0.7), fit('concrete', (0.3, 0.3), 10 + k), M=mat_trs((0, 0, 0), (0, r.uniform(0, 3), 0)))
    return mb


# ------------------------------------------------------------------ playground
def playground():
    mb = MB('playground_climbing_frame'); r = rng(8)
    cols = ['paint_red', 'paint_yellow', 'paint_blue', 'paint_green']
    # arched ladder climber: 6 half-ring arches + rungs
    Ra, n_arch = 1.05, 6
    for k in range(n_arch):
        x = -0.9 + k * 0.36
        pts = [(x, Ra * math.sin(a) + 0.02 * r.normal(), Ra * math.cos(a)) for a in np.linspace(0, math.pi, 11)]
        pts = [(p[0], p[1] if k != 2 else p[1] * (0.82 if abs(p[2]) < 0.6 else 1.0), p[2]) for p in pts]   # one arch dented by a blast
        mb.tube(pts, 0.022, 6, luv(cols[k % 4], 1.5))
    for a in np.linspace(0.12, math.pi - 0.12, 8):
        y, z = Ra * math.sin(a), Ra * math.cos(a)
        mb.tube([(-0.9, y, z), (0.9, y, z)], 0.016, 5, luv('paint_yellow', 2.0), smooth=False)
    # slide with ladder
    sx = 2.1
    for s in (-1, 1):
        mb.tube([(sx + s * 0.25, 0, -0.6), (sx + s * 0.25, 1.5, -0.4)], 0.025, 5, luv('paint_blue'), smooth=False)
    for k in range(5):
        y = 0.25 + k * 0.28
        mb.tube([(sx - 0.25, y, -0.6 + y * 0.13), (sx + 0.25, y, -0.6 + y * 0.13)], 0.015, 4, luv('paint_red'), smooth=False)
    mb.box((sx - 0.3, 1.45, -0.45), (sx + 0.3, 1.5, -0.05), fit('steel_paint', (0.6, 0.4), 1), faces='+y-y')
    rows = []
    for t in np.linspace(0, 1, 6):
        z = -0.05 + t * 2.0; y = 1.5 - 1.3 * t + 0.25 * math.sin(math.pi * t) * 0
        rows.append([(sx - 0.25, y, z), (sx - 0.2, y - 0.04, z), (sx + 0.2, y - 0.04, z), (sx + 0.25, y, z)])
    mb.ribbon(rows, lambda s, t: R['steel_paint'].uv(s, t), double=True, smooth=True)
    # sand box frame (wooden) with spilled sand
    mb.box((-2.6, 0, 1.2), (-1.2, 0.25, 1.28), fit('wood', (1.4, 0.25), 2), faces='+y+z-z')
    mb.box((-2.6, 0, 2.5), (-1.2, 0.25, 2.58), fit('wood', (1.4, 0.25), 3), faces='+y+z-z')
    mb.box((-2.68, 0, 1.2), (-2.6, 0.25, 2.58), fit('wood', (1.4, 0.25), 4), faces='+y+x-x')
    return mb


# ------------------------------------------------------------------ kiosk
def kiosk(name, burnt=False, seed=9):
    mb = MB(name); r = rng(seed)
    Wk, Dk, Hk = 2.6, 2.0, 2.5
    panel = 'kiosk_panel' if not burnt else 'steel_rust'
    pr = R[panel]
    side = lambda P, n: [pr.uv(((p[0] + p[2]) % 1.3) / 1.3 if False else (0.5 + 0.5 * (p[0] if abs(n[2]) > 0.5 else p[2]) / max(Wk, Dk)), p[1] / 1.0) for p in P]
    # lower panels
    mb.box((-Wk / 2, 0, -Dk / 2), (Wk / 2, 1.0, Dk / 2), side, faces='+x-x+z-z')
    # glazed band 1.0..2.1 with frame posts; front glass broken, one side shuttered
    for x in np.linspace(-Wk / 2, Wk / 2, 5):
        mb.box((x - 0.03, 1.0, Dk / 2 - 0.05), (x + 0.03, 2.1, Dk / 2), fit('steel_paint', (0.1, 1.1), int(abs(x) * 10)), faces='+z+x-x')
    for z in np.linspace(-Dk / 2, Dk / 2, 4):
        for s in (-1, 1):
            mb.box((s * Wk / 2 - 0.05 * (s > 0), 1.0, z - 0.03), (s * Wk / 2 + 0.05 * (s < 0), 2.1, z + 0.03), fit('steel_paint', (0.1, 1.1), int(abs(z) * 10) + 3), faces='+x-x+z')
    gl = R['glass_dark']
    for i, x in enumerate(np.linspace(-Wk / 2, Wk / 2, 5)[:-1]):
        if burnt or i == 1:
            continue
        mb.poly([(x + 0.03, 1.0, Dk / 2 - 0.02), (x + Wk / 4 - 0.03, 1.0, Dk / 2 - 0.02), (x + Wk / 4 - 0.03, 2.1, Dk / 2 - 0.02), (x + 0.03, 2.1, Dk / 2 - 0.02)],
                lambda P, n: [gl.uv(0, 0), gl.uv(1, 0), gl.uv(1, 1), gl.uv(0, 1)])
    sh = R['shutter']
    for s in (-1, 1):
        x = s * Wk / 2
        P = [(x, 1.0, -Dk / 2), (x, 1.0, Dk / 2), (x, 2.1, Dk / 2), (x, 2.1, -Dk / 2)]
        if s < 0:
            P = P[::-1]
        if s > 0 or not burnt:
            mb.poly(P, lambda P_, n: [sh.uv(0, 0), sh.uv(1, 0), sh.uv(1, 1), sh.uv(0, 1)])
    mb.box((-Wk / 2, 1.0, -Dk / 2), (Wk / 2, 2.1, -Dk / 2 + 0.02), fit(panel, (2.6, 1.1), 1), faces='-z')
    # roof with overhang + sign box
    roof_tilt = mat_trs((0, 0, 0)) if not burnt else rot_axis((1, 0, 0), 0.18, origin=(0, 2.1, -Dk / 2))
    tmp = MB()
    tmp.box((-Wk / 2 - 0.15, 2.1, -Dk / 2 - 0.15), (Wk / 2 + 0.15, 2.22, Dk / 2 + 0.2), fit('roofing' if not burnt else 'steel_rust', (2.9, 2.3), 2))
    ks = R['kiosk_sign'] if not burnt else R['steel_rust']
    tmp.box((-Wk / 2, 2.22, Dk / 2 - 0.1), (Wk / 2, 2.62, Dk / 2 + 0.05), lambda P, n: [ks.uv((p[0] + Wk / 2) / Wk, (p[1] - 2.22) / 0.4) for p in P], faces='+z+y')
    tmp.box((-Wk / 2, 2.22, Dk / 2 - 0.1), (Wk / 2, 2.62, Dk / 2 + 0.05), fit('steel_paint', (2.6, 0.4), 3), faces='-z+x-x')
    mb.merge(tmp, roof_tilt)
    # counter flap + scattered newspapers / debris
    mb.box((-0.6, 0.98, Dk / 2), (0.6, 1.02, Dk / 2 + 0.3), fit('steel_paint', (1.2, 0.3), 4), faces='+y-y+z')
    for k in range(6):
        x, z = r.uniform(-1.6, 1.6), r.uniform(Dk / 2 + 0.2, Dk / 2 + 1.5)
        mb.poly([(x, 0.01, z), (x + 0.3, 0.01, z + 0.05), (x + 0.28, 0.01, z + 0.25), (x - 0.02, 0.01, z + 0.2)], fit('bag_white' if not burnt else 'ash', (0.3, 0.3), 20 + k))
    return mb


# ------------------------------------------------------------------ craters
def crater(name, Rr, depth_vis, seed, asphalt=False):
    """Shell crater as a positive mesh: low ejecta rim + inner bowl reaching down to y=0.02 (the visible depth comes
    from the scorched texture); clods / asphalt slabs thrown around."""
    mb = MB(name); r = rng(seed)
    reg = R['crater']
    K = 3.9 * Rr
    uv = lambda P, n: [reg.uv(0.5 + p[0] / K, 0.5 + p[2] / K) for p in P]
    rings_r = [0.0, 0.35, 0.65, 0.85, 1.0, 1.15, 1.35, 1.7]
    rings_h = [0.02, 0.025, 0.05, 0.12, 0.2 * depth_vis, 0.16 * depth_vis, 0.07, 0.0]
    sect = 20
    ids = []
    for i, (rr, hh) in enumerate(zip(rings_r, rings_h)):
        row = []
        for j in range(sect):
            a = 2 * math.pi * j / sect
            k = 1 + 0.12 * math.sin(a * 3 + seed) + r.normal(0, 0.05)
            row.append(mb.v((math.cos(a) * rr * Rr * k, max(0.0, hh + r.normal(0, 0.02) * (0 < i < 7)), math.sin(a) * rr * Rr * k)))
        ids.append(row)
    for i in range(len(rings_r) - 1):
        for j in range(sect):
            j2 = (j + 1) % sect
            for tri in ((ids[i][j], ids[i][j2], ids[i + 1][j2]), (ids[i][j], ids[i + 1][j2], ids[i + 1][j])):
                P = np.array([mb.V[t] for t in tri])
                if newell(P)[1] < 0:
                    tri = tri[::-1]; P = P[::-1]
                if np.linalg.norm(np.cross(P[1] - P[0], P[2] - P[0])) < 1e-8:
                    continue
                mb.face(tri, uv(P, None), True)
    # ejecta clods (soil) or broken asphalt plates
    for k in range(18 if not asphalt else 12):
        a = r.uniform(0, 2 * np.pi); d = Rr * r.uniform(1.0, 2.2)
        s = r.uniform(0.08, 0.25) * (1.5 if asphalt else 1)
        x, z = math.cos(a) * d, math.sin(a) * d
        reg2 = 'asphalt_chunk' if asphalt and k % 2 == 0 else 'soil'
        mb.box((-s / 2, 0, -s / 2), (s / 2, s * (0.25 if asphalt else 0.5), s / 2), fit(reg2, (0.3, 0.3), seed + k),
               M=mat_trs((x, -0.01, z), (r.normal(0, 0.2), r.uniform(0, 3), r.normal(0, 0.2))))
    return mb


def main():
    paths = PA.build()
    reset_scene()
    mat = make_material('props_atlas', *paths)
    items = []
    items.append(car_vaz2107('car_vaz2107_burnt', 1))
    c2 = car_vaz2107('car_vaz2107_wreck_side', 2, sag=0.12)
    c2.transform(rot_axis((0, 0, 1), math.pi / 2 - 0.05))
    mn, mx = c2.bounds(); c2.transform(mat_trs((-(mn[0] + mx[0]) / 2, -mn[1], 0)))
    items.append(c2)
    items.append(car_vaz2107('car_vaz2107_burnt_sagged', 3, sag=0.18))
    items.append(bus_paz())
    items.append(hedgehog('hedgehog_ibeam', 'ibeam', 3)); items.append(hedgehog('hedgehog_rail', 'rail', 4))
    items.append(sandbag_wall('sandbag_wall', 3.6, 5, 4)); items.append(sandbag_wall('sandbag_wall_low', 2.4, 3, 5))
    items += tyre_items()
    items.append(garage('garage_unit', False, 7)); items.append(garage('garage_unit_damaged', True, 6))
    items.append(bus_stop()); items.append(playground())
    items.append(kiosk('kiosk_press', False, 9)); items.append(kiosk('kiosk_burnt', True, 10))
    items.append(crater('crater_small', 1.1, 1.0, 11)); items.append(crater('crater_large_asphalt', 2.6, 1.6, 12, asphalt=True))
    info = {}
    for i, mb in enumerate(items):
        mb.to_object(mb.name, [mat], smooth_angle=35, location=((i % 6) * 9.0, 0, -(i // 6) * 10.0))
        mn, mx = mb.bounds()
        info[mb.name] = {'tris': mb.tris(), 'bbox_min': [round(float(v), 2) for v in mn], 'bbox_max': [round(float(v), 2) for v in mx]}
        print(f'{mb.name:28s} {mb.tris():6d} tris  size {np.round(mx - mn, 2)}')
    size = export_glb(os.path.join(REPO, 'assets', 'env', 'props.glb'))
    print('props.glb', size / 1e6)
    update_manifest('props', {'file': 'props.glb', 'nodes': info, 'notes':
        'One material (props_atlas 2048^2). Origin = ground centre of footprint, forward +Z, nodes laid out on a grid in the file. '
        'garage_unit* are 3.6 m wide modules (city.js places 4 side by side at 3.6 m) with doors to +Z. crater_* are positive meshes '
        '(ejecta rim + scorched bowl texture down to y=0.02, nothing below ground). car_vaz2107_wreck_side lies on its side.'})


if __name__ == '__main__':
    main()
