"""Street furniture, modern vehicles (+ burnt wrecks) and war additions for modern.glb (see modern_geo.py for the
conventions: material 0 = modern_atlas, 1 = modern_alpha; +Y up; long axis along X; cars front = +X)."""
import math
import numpy as np
from meshlib import MB, Region, Fit, newell, xform, mat_trs, rot_axis, rng, blob
import modern_atlas as MA
import modern_geo as MG
import city_geo as G
from city_geo import tquad, tbox, fbox, lathe, prism, quad, chunk
from modern_geo import (TMB, T, RY, RS, WHITE, RED, YEL, BLUE, GREEN, tint, soot_blob, ground_ao, frame, beam, cyl, disc,
                        aquad, agrid, rubble, ALP, OPA, PI)

CARS = MA.CARS


# ====================================================================== cars
class CarUV:
    """Side (|n.z| dominant) / top / front / rear projection into one car region (layout in modern_atlas)."""
    def __init__(self, reg, spec):
        self.r = G.R[reg] if isinstance(reg, str) else reg; self.L = spec['L']; self.W = spec['W']; self.H = spec['H']

    def __call__(self, P, n):
        ax = np.abs(n); out = []
        for p in P:
            if ax[2] >= ax[0] and ax[2] >= ax[1]:
                s = (p[0] + self.L / 2) / self.L; t = 0.4 + 0.6 * p[1] / self.H
                s = min(max(s, 0.0), 1.0); t = min(max(t, 0.405), 1.0)
            elif ax[1] >= ax[0]:
                s = 0.5 * (p[0] + self.L / 2) / self.L; t = 0.4 * (p[2] + self.W / 2) / self.W
                s = min(max(s, 0.0), 0.495); t = min(max(t, 0.0), 0.395)
            elif n[0] > 0:
                s = 0.5 + 0.25 * (self.W / 2 - p[2]) / self.W; t = 0.4 * p[1] / self.H
                s = min(max(s, 0.505), 0.745); t = min(max(t, 0.0), 0.395)
            else:
                s = 0.75 + 0.25 * (p[2] + self.W / 2) / self.W; t = 0.4 * p[1] / self.H
                s = min(max(s, 0.755), 1.0); t = min(max(t, 0.0), 0.395)
            out.append(self.r.uv(s, t))
        return out


def _prof(y0, y1, hw, n_round=True):
    """10-point lower-body section in (z, y), CCW seen from +X."""
    h = y1 - y0
    return [(-hw * 0.92, y0), (hw * 0.92, y0), (hw * 0.99, y0 + 0.12 * h), (hw, y0 + 0.45 * h), (hw * 0.985, y1 - 0.1 * h),
            (hw * 0.93, y1), (-hw * 0.93, y1), (-hw * 0.985, y1 - 0.1 * h), (-hw, y0 + 0.45 * h), (-hw * 0.99, y0 + 0.12 * h)]


def _orient(Q, centre):
    Q = np.asarray(Q, float)
    return Q if np.dot(newell(Q), Q.mean(0) - centre) >= 0 else Q[::-1]


def car_wheel(mb, c, r, w, side, reg='tyre_car', sides=14, burnt=False):
    """Wheel about the Z axis at c; outer face towards side (+1 / -1 in z).  tyre_car / rim_burnt layout: disc in the
    top 3/4 (centre s 0.5, t 0.625, radius 0.36), band in the bottom quarter."""
    rg = G.R[reg]; c = np.asarray(c, float)
    zo, zi = c[2] + side * w / 2, c[2] - side * w / 2
    ts = np.linspace(0, 2 * PI, sides, endpoint=False)
    A = [mb.v((c[0] + math.cos(t) * r, c[1] + math.sin(t) * r, zo)) for t in ts]
    B_ = [mb.v((c[0] + math.cos(t) * r, c[1] + math.sin(t) * r, zi)) for t in ts]
    for k in range(sides):
        k2 = (k + 1) % sides
        idx = [A[k], A[k2], B_[k2], B_[k]]
        P = np.array([mb.V[i] for i in idx])
        if np.dot(newell(P), P.mean(0) - np.array([c[0], c[1], P.mean(0)[2]])) < 0:
            idx = idx[::-1]
        u0 = (k % (sides // 2)) / (sides // 2); u1 = u0 + 1 / (sides // 2)
        mb.face(idx, [rg.uv(u0, 0.02), rg.uv(u1, 0.02), rg.uv(u1, 0.23), rg.uv(u0, 0.23)], True)
    face = A if side > 0 else A[::-1]
    P = np.array([mb.V[i] for i in face])
    if newell(P)[2] * side < 0:
        face = face[::-1]
    mb.face(face, [rg.uv(0.5 + 0.36 * (mb.V[i][0] - c[0]) / r * side, 0.625 + 0.36 * (mb.V[i][1] - c[1]) / r) for i in face], False)
    if burnt:   # bead wires sagging off the rim
        G.tube(mb, [c + np.array([math.cos(t) * r * 1.12, math.sin(t) * r * 1.05 - 0.02, side * w * 0.3]) for t in np.linspace(0, 2 * PI, 11)], 0.008, 3, 'steel_dark', seg=50)


def car(name, model, kind='intact', seed=0):
    """Modern car / van / bus, front = +X.  kind: intact | medevac | burnt.
    Burnt: sits on the bare rims (tyres burnt away, body ~0.1-0.2 m lower), glazing gone (open greenhouse with
    pillars, gutted black interior: ash floor, seat spring frames, dashboard), roof sagging, panels warped, plastic
    bumpers / lamps burnt off; paint burnt to charcoal and grey-white ash (region painted by burnt_tex)."""
    spec = CARS[model]; r = rng(seed)
    L, W, H, belt = spec['L'], spec['W'], spec['H'], spec['belt']
    xa, xd, xb, xc = spec['gx']; gw0, gw1 = spec['gw']
    burnt = kind == 'burnt'
    reg = ('car_' + model + ('_burnt' if burnt else '')) if model != 'bus' else 'bus_burnt'
    uvf = CarUV(reg, spec)
    mb = TMB(name)
    body = TMB()
    secs = spec['low']
    rings = []
    for (x, y0, y1, hw) in secs:
        rings.append([(x, y, z) for (z, y) in _prof(y0, y1, hw)])
    N = len(rings[0])
    for i in range(len(rings) - 1):
        cen = np.array([(secs[i][0] + secs[i + 1][0]) / 2, (secs[i][1] + secs[i][2]) / 2, 0])
        for k in range(N):
            k2 = (k + 1) % N
            Q = _orient([rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]], cen)
            if k == 0:
                body.poly(Q, G.fit('steel_dark', (2, 2)))
            else:
                body.poly(Q, uvf)
    for ring, sgn in ((rings[0], 1), (rings[-1], -1)):
        P = np.array(ring)
        if newell(P)[0] * sgn < 0:
            P = P[::-1]
        body.poly(P, uvf)
    # greenhouse
    gb = [(xa, belt, -gw0), (xa, belt, gw0), (xd, belt, gw0), (xd, belt, -gw0)]
    gt = [(xb, H, -gw1), (xb, H, gw1), (xc, H, gw1), (xc, H, -gw1)]
    gcen = np.array([(xa + xd) / 2, (belt + H) / 2, 0])
    zg = lambda y, s: s * (gw0 + (gw1 - gw0) * (y - belt) / (H - belt))
    xf = lambda y: xa + (xb - xa) * (y - belt) / (H - belt)
    xr = lambda y: xd + (xc - xd) * (y - belt) / (H - belt)
    if not burnt:
        for i in range(4):
            Q = _orient([gb[i], gb[(i + 1) % 4], gt[(i + 1) % 4], gt[i]], gcen)
            body.poly(Q, uvf)
        body.poly(_orient(gt, gcen - np.array([0, 1, 0])), uvf)
        # mirrors, roof rails (suv), wipers are texture
        if model != 'bus':
            for s in (-1, 1):
                mx = xa - 0.12
                fbox(body, (mx - 0.08, belt + 0.02, min(s * gw0, s * (gw0 + 0.2))), (mx + 0.04, belt + 0.17, max(s * gw0, s * (gw0 + 0.2))), 'steel_dark')
        if model == 'suv':
            for s in (-1, 1):
                fbox(body, (xc + 0.15, H, s * 0.62 - 0.03), (xb - 0.15, H + 0.05, s * 0.62 + 0.03), 'steel_dark', faces='+y+x-x+z-z')
    else:
        # open greenhouse: pillars, header / cowl rails, sagging roof, solid rear (van / bus engine) and van cargo sides
        def strut(p0, p1, w=0.07, reg_='soot'):
            beam(body, p0, p1, w, w, reg_)
        for s in (-1, 1):
            strut((xa, belt, zg(belt, s)), (xb, H - 0.02, zg(H, s)))                      # A pillar
            if model == 'bus':
                for x in np.arange(xd + 1.32, xa - 0.5, 1.32):
                    strut((x, belt, zg(belt, s)), (x, H - 0.3, zg(H - 0.3, s)), 0.09)
                strut((xd, belt, zg(belt, s)), (xd, H - 0.3, zg(H - 0.3, s)), 0.12)
                # upper band below the roof edge
                Q = _orient([(xd, H - 0.32, zg(H - 0.32, s)), (xa, H - 0.32, zg(H - 0.32, s)), (xb, H, zg(H, s)), (xc, H, zg(H, s))], gcen)
                body.poly(Q, uvf)
            elif model == 'van':
                Q = _orient([(xd, belt, zg(belt, s)), (1.2, belt, zg(belt, s)), (1.2, H, zg(H, s)), (xc, H, zg(H, s))], gcen)
                body.poly(Q, uvf)
                strut((1.25, belt, zg(belt, s)), (1.25, H, zg(H, s)), 0.1)
            else:
                bx = spec['doors'][1]
                strut((bx, belt, zg(belt, s)), (bx - 0.06, H - 0.02, zg(H, s)), 0.08)       # B pillar
                cx0 = xd + 0.02; cx1 = spec['doors'][2] - 0.05
                Q = _orient([(cx0, belt, zg(belt, s)), (cx1, belt, zg(belt, s)), (cx1 + 0.12, H, zg(H, s)), (xr(H) + 0.02, H, zg(H, s))], gcen)
                body.poly(Q, uvf)                                                           # C pillar panel
        strut((xb, H - 0.02, -gw1), (xb, H - 0.02, gw1), 0.07)                             # windscreen header
        strut((xa, belt, -gw0), (xa, belt, gw0), 0.06)                                      # cowl
        if model in ('van', 'bus'):
            Q = _orient([gb[2], gb[3], gt[3], gt[2]], gcen)                                 # rear wall (doors / engine)
            body.poly(Q, uvf)
        else:
            strut((xd, belt, -gw0), (xd, belt, gw0), 0.06)
            strut((xc, H - 0.02, -gw1), (xc, H - 0.02, gw1), 0.07)
            for s in (-1, 1):
                strut((xd, belt, zg(belt, s)), (xc, H - 0.02, zg(H, s)), 0.07)
        # sagging roof (3 x 2 grid), double sided so the gutted interior reads from above
        nx, nz = 4, 2
        sag = 0.09 if model != 'bus' else 0.45
        def rp(x, z):
            tx = (x - xc) / (xb - xc); tz = z / gw1
            return (x, H - sag * math.sin(PI * tx) * (1 - tz * tz) - 0.01, z)
        for i in range(nx):
            for j in range(nz):
                xa_, xb_ = xc + (xb - xc) * i / nx, xc + (xb - xc) * (i + 1) / nx
                za, zb = -gw1 + 2 * gw1 * j / nz, -gw1 + 2 * gw1 * (j + 1) / nz
                if model == 'bus' and j == 0 and 1 <= i <= 2:
                    continue                          # burnt-through roof panel
                Q = [rp(xa_, zb), rp(xb_, zb), rp(xb_, za), rp(xa_, za)]
                if newell(np.array(Q))[1] < 0:
                    Q = Q[::-1]
                body.poly(Q, uvf); body.poly(Q[::-1], G.fit('soot', (1.5, 1.5)))
        # gutted interior
        fl = secs[1][1] + 0.12
        tquad(body, (xd + 0.05, fl, gw0 - 0.05), (1, 0, 0), (0, 0, -1), (xa - xd) - 0.1, 2 * gw0 - 0.1, 'ash', (2, 2))
        if model == 'bus':
            for x in np.arange(xd + 1.0, xa - 1.5, 0.85):
                for (z0, z1) in ((0.2, 1.15), (-1.15, -0.2)):
                    if -1.2 < x < 1.2 and z0 < 0:
                        continue
                    fbox(body, (x - 0.22, fl + 0.38, z0), (x + 0.22, fl + 0.46, z1), 'interior_burnt', faces='+y+x-x')
                    fbox(body, (x - 0.27, fl + 0.46, z0), (x - 0.22, fl + 1.0, z1), 'interior_burnt', faces='+x-x+y')
                    cyl(body, (x, fl, (z0 + z1) / 2), (x, fl + 0.38, (z0 + z1) / 2), 0.025, 3, 'steel_dark')
            fbox(body, (xa - 0.9, fl, -1.2), (xa - 0.25, fl + 0.85, -0.35), 'interior_burnt', faces='+y+x-x+z-z')
        else:
            fbox(body, (xa - 0.5, belt - 0.35, -gw0 + 0.1), (xa - 0.1, belt - 0.02, gw0 - 0.1), 'interior_burnt', faces='+y-x')
            rows = [(xa - 1.05, (0.38, -0.38))] + ([(spec['doors'][2] + 0.15, (0.0,))] if model != 'van' else [])
            for (x, zs) in rows:
                for zc in zs:
                    zw = 0.24 if len(zs) > 1 else 0.6
                    fbox(body, (x - 0.25, fl + 0.12, zc - zw), (x + 0.25, fl + 0.22, zc + zw), 'interior_burnt', faces='+y+x-x+z-z')
                    fbox(body, (x - 0.32, fl + 0.22, zc - zw), (x - 0.24, fl + 0.75, zc + zw), 'interior_burnt', faces='+x-x+y+z-z')
            if model == 'van':
                fbox(body, (xd + 0.3, fl, -0.8), (xd + 1.6, fl + 0.5, 0.8), 'ash', faces='+y+x-x+z-z')          # burnt cargo
        # warp: small random displacement of the body vertices, bonnet sprung
        V = np.array(body.V)
        V += r.normal(0, 0.012, V.shape) * (V[:, 1:2] > 0.3)
        if model != 'bus':
            hood = (V[:, 0] > xa + 0.15) & (V[:, 1] > secs[1][2] - 0.08)
            V[hood, 1] += 0.05 * (V[hood, 0] - xa) / (L / 2 - xa)
        body.V = list(V)
    # medevac markings + light bar
    if kind == 'medevac':
        crs = RS('decals', 0.04, 0.54, 0.46, 0.96)
        for s in (-1, 1):
            y0_, y1_ = 1.3, 2.2
            x0_, x1_ = -1.55, -0.65
            P = [(x0_, y0_, zg(y0_, s) + s * 0.012), (x1_, y0_, zg(y0_, s) + s * 0.012), (x1_, y1_, zg(y1_, s) + s * 0.012), (x0_, y1_, zg(y1_, s) + s * 0.012)]
            if s < 0:
                P = [P[1], P[0], P[3], P[2]]
            body.poly(P, G.uvq(crs))
        body.poly([(xd - 0.012, 1.45, -0.42), (xd - 0.012, 2.27, -0.42), (xd - 0.012, 2.27, 0.42), (xd - 0.012, 1.45, 0.42)], G.uvq(crs))
        body.poly([(-1.6, H + 0.012, 0.55), (-0.5, H + 0.012, 0.55), (-0.5, H + 0.012, -0.55), (-1.6, H + 0.012, -0.55)], G.uvq(crs))
        fbox(body, (xb - 0.35, H, -0.6), (xb - 0.12, H + 0.12, 0.6), BLUE(), faces='+y+x-x+z-z')
        fbox(body, (xb - 0.33, H + 0.03, -0.15), (xb - 0.11, H + 0.1, 0.15), RS('lamp_parts', 0.55, 0.55, 0.95, 0.95), faces='+x+y')
    # wheels / rims
    wr = spec['r']; ww = 0.21 if model != 'bus' else 0.3
    drop = 0.0
    if burnt:
        rr = wr * 0.62; drop = wr - rr
    for ax in spec['axles']:
        for s in (-1, 1):
            zc = s * (W / 2 - ww / 2 + 0.01)
            if not burnt:
                car_wheel(mb, (ax, wr, zc), wr, ww, s, 'tyre_car', 16)
                if model == 'bus' and ax < 0:
                    pass
            else:
                car_wheel(mb, (ax, rr, zc), rr, ww * 0.8, s, 'rim_burnt', 12, burnt=True)
    # dark wheel-well shadow plates inside the body sides
    for ax in spec['axles']:
        for s in (-1, 1):
            z = s * (secs[1][3] - 0.02)
            P = [(ax - wr - 0.08, 0.15, z), (ax + wr + 0.08, 0.15, z), (ax + wr * 0.75, wr + wr * 0.8, z), (ax, wr * 2 + 0.06, z), (ax - wr * 0.75, wr + wr * 0.8, z)]
            P = np.array(P)
            if newell(P)[2] * s < 0:
                P = P[::-1]
            body.poly(P, G.fit('soot', (1, 1)))
    if burnt:
        body.transform(mat_trs((0, -drop, 0)))
        # ash / melted-plastic puddles under the wreck
        for k in range(3):
            x = r.uniform(-L / 3, L / 3)
            Pp = [(x + math.cos(t) * r.uniform(0.4, 0.8), 0.012, math.sin(t) * r.uniform(0.3, 0.6)) for t in np.linspace(0, 2 * PI, 8, endpoint=False)]
            Pp = np.array(Pp)
            mb.poly(Pp if newell(Pp)[1] > 0 else Pp[::-1], G.fit('ash', (1.6, 1.6)))
        tint(body, lambda p: 0.72 + 0.28 * min(1.0, max(0.0, (p[1] - 0.15) / (H * 0.7))))
    else:
        tint(body, lambda p: 0.75 + 0.25 * min(1.0, max(0.0, (p[1] - 0.1) / 0.6)))
    mb.merge(body)
    return mb


# ====================================================================== street furniture
def bus_stop_modern(name='bus_stop_modern', seed=400):
    """Glass and steel shelter 4.2 x 1.6 m, 2.6 m: galvanised posts, sloped flat roof, three back glass panels and a
    glass end panel (shattered / partly fallen out), backlit ad panel at the other end, perforated steel bench,
    glass crumbs on the ground."""
    mb = TMB(name); r = rng(seed)
    Lx, D, H = 4.2, 1.6, 2.55
    for x in (-Lx / 2, -Lx / 6, Lx / 6, Lx / 2):
        fbox(mb, (x - 0.04, 0, -D / 2 - 0.04), (x + 0.04, H, -D / 2 + 0.04), 'steel_galv', faces='+x-x+z-z')
    for x in (-Lx / 2, Lx / 2):
        fbox(mb, (x - 0.04, 0, D / 2 - 0.04), (x + 0.04, H - 0.1, D / 2 + 0.04), 'steel_galv', faces='+x-x+z-z')
    Mr = rot_axis((1, 0, 0), -0.05, origin=(0, H, 0))
    tbox(mb, (-Lx / 2 - 0.15, H, -D / 2 - 0.15), (Lx / 2 + 0.15, H + 0.12, D / 2 + 0.25), 'steel_dark', (2, 2), M=Mr, faces='+x-x+z-z-y')
    tbox(mb, (-Lx / 2 - 0.15, H + 0.12, -D / 2 - 0.15), (Lx / 2 + 0.15, H + 0.13, D / 2 + 0.25), 'roof_membrane', (2, 2), M=Mr, faces='+y')
    # back glass (3 panels), end glass (+X), ad panel (-X)
    regs = ['glass_crack_a', 'glass_crack_b', 'glass_crack_a']
    for i in range(3):
        x0 = -Lx / 2 + 0.05 + i * Lx / 3; x1 = -Lx / 2 + (i + 1) * Lx / 3 - 0.05
        if i == 1:
            aquad(mb, [(x0, 0.35, -D / 2), (x1, 0.35, -D / 2), (x1, 2.25, -D / 2), (x0, 2.25, -D / 2)], regs[i])
        else:
            aquad(mb, [(x0, 0.3, -D / 2), (x1, 0.3, -D / 2), (x1, 2.3, -D / 2), (x0, 2.3, -D / 2)], regs[i], uvs=((0, 0), (1, 0), (1, 1), (0, 1)) if i == 0 else ((1, 0), (0, 0), (0, 1), (1, 1)))
    aquad(mb, [(Lx / 2, 0.3, -D / 2 + 0.06), (Lx / 2, 0.3, D / 2 - 0.06), (Lx / 2, 2.3, D / 2 - 0.06), (Lx / 2, 2.3, -D / 2 + 0.06)], 'glass_crack_b', uvs=((1, 1), (0, 1), (0, 0), (1, 0)))
    tbox(mb, (-Lx / 2 - 0.06, 0.25, -D / 2 + 0.1), (-Lx / 2 + 0.06, 2.3, D / 2 - 0.1), 'steel_dark', (1.5, 2.1), faces='+y+z-z')
    for s in (1, -1):
        x = -Lx / 2 + s * 0.061
        P = [(x, 0.3, -D / 2 + 0.15), (x, 0.3, D / 2 - 0.15), (x, 2.25, D / 2 - 0.15), (x, 2.25, -D / 2 + 0.15)]
        if s < 0:
            P = P[::-1]
        mb.poly(P, G.uvq('ad_poster'))
    # bench
    fbox(mb, (-1.2, 0.42, -D / 2 + 0.1), (1.2, 0.46, -D / 2 + 0.5), 'steel_galv', faces='+y+z-z+x-x')
    for x in (-1.0, 1.0):
        fbox(mb, (x - 0.03, 0, -D / 2 + 0.15), (x + 0.03, 0.42, -D / 2 + 0.45), 'steel_dark', faces='+x-x+z')
    for k in range(25):
        x, z = r.uniform(-2.2, 2.4), r.uniform(-D / 2 - 0.5, D / 2 + 0.6)
        s_ = r.uniform(0.04, 0.12)
        mb.poly([(x, 0.008, z), (x + s_, 0.008, z + 0.02), (x + s_ * 0.5, 0.008, z + s_ * 0.8)], G.fit('glass_dark', (0.3, 0.3)))
    tint(mb, ground_ao(0.6, 0.6))
    return mb


def playground_modern(name='playground_modern', seed=410):
    """Modern playground 14 x 10 m on poured rubber safety surfacing (terracotta / green): play tower with a pyramid
    roof, tube-free open slide, stairs and climbing wall, double swing with flat seats, two spring riders, a small
    carousel."""
    mb = TMB(name); r = rng(seed)
    Lx, Dz = 14.0, 10.0
    # mats
    tquad(mb, (-Lx / 2, 0.02, Dz / 2), (1, 0, 0), (0, 0, -1), 7.5, Dz, RS('rubber_mat', 0.02, 0.02, 0.48, 0.98), (2.0, 4.0))
    tquad(mb, (0.5, 0.02, Dz / 2), (1, 0, 0), (0, 0, -1), Lx / 2 - 0.5, Dz, RS('rubber_mat', 0.52, 0.02, 0.98, 0.98), (2.0, 4.0))
    for (x0, x1, z0, z1) in ((-Lx / 2, Lx / 2, Dz / 2, Dz / 2), (-Lx / 2, Lx / 2, -Dz / 2, -Dz / 2)):
        pass
    tbox(mb, (-Lx / 2, 0, -Dz / 2), (Lx / 2, 0.02, Dz / 2), 'concrete', (3, 3), faces='+x-x+z-z')
    # ---- tower
    tx, tz = -3.6, -0.8
    ph = 1.2
    for (dx, dz) in ((-0.7, -0.7), (0.7, -0.7), (0.7, 0.7), (-0.7, 0.7)):
        fbox(mb, (tx + dx - 0.05, 0, tz + dz - 0.05), (tx + dx + 0.05, 2.5, tz + dz + 0.05), BLUE(), faces='+x-x+z-z')
    fbox(mb, (tx - 0.75, ph - 0.05, tz - 0.75), (tx + 0.75, ph, tz + 0.75), 'wood_slats', faces='+y-y+x-x+z-z')
    for (a, b) in (((-0.7, -0.7), (0.7, -0.7)), ((-0.7, 0.7), (-0.7, -0.7))):
        P0 = np.array([tx + a[0], ph, tz + a[1]]); P1 = np.array([tx + b[0], ph, tz + b[1]])
        d = P1 - P0
        nrm = np.cross(d, [0, 1, 0]); nrm /= np.linalg.norm(nrm)
        Q = [P0 + nrm * 0.03, P1 + nrm * 0.03, P1 + nrm * 0.03 + [0, 0.8, 0], P0 + nrm * 0.03 + [0, 0.8, 0]]
        mb.poly(Q, G.uvq(YEL())); mb.poly(Q[::-1], G.uvq(YEL()))
    apex = (tx, 3.3, tz)
    base = [(tx - 0.85, 2.5, tz - 0.85), (tx + 0.85, 2.5, tz - 0.85), (tx + 0.85, 2.5, tz + 0.85), (tx - 0.85, 2.5, tz + 0.85)]
    for i in range(4):
        tri = [base[i], apex, base[(i + 1) % 4]]
        P = np.array(tri)
        if np.dot(newell(P), P.mean(0) - np.array([tx, 2.6, tz])) < 0:
            tri = tri[::-1]
        mb.poly(tri, G.uvq(RED(), ((0, 0), (0.5, 1), (1, 0))))
        mb.poly(tri[::-1], G.uvq(RED(), ((0, 0), (0.5, 1), (1, 0))))
    # slide down to +X (U section ribbon)
    sl0 = np.array([tx + 0.75, ph, tz]); n_ = 9
    rows = []
    for i in range(n_ + 1):
        t = i / n_
        x = sl0[0] + t * 3.2; y = ph * (1 - t) ** 1.4 * (1 - 0.15 * t) + 0.25 * t
        y = max(y, 0.3) if t > 0.9 else y
        row = []
        for (u, dy) in ((-0.32, 0.25), (-0.26, 0.0), (0.0, -0.06), (0.26, 0.0), (0.32, 0.25)):
            row.append((x, y + dy + 0.05, tz + u))
        rows.append(row)
    G.ribbon(mb, rows, YEL(), double=True)
    for t in (0.55, 1.0):
        x = sl0[0] + t * 3.2 - 0.1
        fbox(mb, (x - 0.04, 0, tz - 0.04), (x + 0.04, max(0.3, ph * (1 - t) ** 1.4), tz + 0.04), BLUE(), faces='+x-x+z-z')
    # stairs (-Z side) and climbing wall (-X side)
    for k in range(4):
        y = 0.3 * (k + 1)
        fbox(mb, (tx - 0.4, y - 0.04, tz - 0.75 - 1.2 + k * 0.3), (tx + 0.4, y, tz - 0.75 - 0.9 + k * 0.3), 'wood_slats', faces='+y+z-z+x-x')
    for s in (-1, 1):
        beam(mb, (tx + s * 0.42, 0, tz - 2.0), (tx + s * 0.42, ph + 0.8, tz - 0.75), 0.05, 0.05, BLUE())
    Q = [(tx - 0.78, 0, tz + 0.7), (tx - 0.78, 0, tz - 0.7), (tx - 0.78, ph, tz - 0.7), (tx - 0.78, ph, tz + 0.7)]
    mb.poly(Q, G.uvq(GREEN())); mb.poly(Q[::-1], G.uvq(GREEN()))
    for k in range(8):
        fbox(mb, (tx - 0.84, 0.15 + k * 0.13, tz - 0.6 + (k * 0.37) % 1.2), (tx - 0.78, 0.22 + k * 0.13, tz - 0.5 + (k * 0.37) % 1.2), RED(), faces='-x+y-y+z-z')
    # ---- swings (+X half, back)
    sx, sz = 3.4, -2.2
    for s in (-1, 1):
        x = sx + s * 1.7
        cyl(mb, (x, 2.3, sz), (x - 0.45 * s * 0 - 0.0, 0, sz - 0.9), 0.04, 6, BLUE())
        cyl(mb, (x, 2.3, sz), (x, 0, sz + 0.9), 0.04, 6, BLUE())
    cyl(mb, (sx - 1.75, 2.3, sz), (sx + 1.75, 2.3, sz), 0.045, 6, BLUE())
    for k, x in enumerate((sx - 0.75, sx + 0.75)):
        ang = 0.25 if k == 0 else -0.05
        seat = np.array([x, 0.45, sz + math.sin(ang) * 1.8])
        seat[1] = 2.3 - math.cos(ang) * 1.85
        fbox(mb, (seat[0] - 0.22, seat[1] - 0.03, seat[2] - 0.09), (seat[0] + 0.22, seat[1], seat[2] + 0.09), 'steel_dark', faces='+y-y+x-x+z-z')
        for dx in (-0.2, 0.2):
            cyl(mb, (seat[0] + dx, 2.28, sz), (seat[0] + dx, seat[1], seat[2]), 0.008, 3, 'steel_galv')
    # spring riders
    for (x, z, col) in ((2.2, 2.6, YEL()), (4.4, 2.2, GREEN())):
        G.lathe(mb, [(0.09, 0.0), (0.1, 0.25), (0.09, 0.5)], 6, 'steel_dark', M=T(x, 0, z))
        fbox(mb, (x - 0.4, 0.5, z - 0.12), (x + 0.4, 0.75, z + 0.12), col, faces='+y-y+x-x+z-z')
        fbox(mb, (x + 0.25, 0.75, z - 0.1), (x + 0.42, 1.05, z + 0.1), col, faces='+y+x-x+z-z')
    # carousel
    cxz = (-0.5, 3.0)
    G.lathe(mb, [(0.0, 0.32), (0.85, 0.32), (0.88, 0.27), (0.85, 0.22), (0.0, 0.22)][::-1], 12, RED(), M=T(cxz[0], 0, cxz[1]))
    cyl(mb, (cxz[0], 0, cxz[1]), (cxz[0], 0.95, cxz[1]), 0.05, 6, 'steel_galv')
    G.lathe(mb, [(0.25, 0.92), (0.28, 0.95), (0.25, 0.98)], 10, YEL(), M=T(cxz[0], 0, cxz[1]))
    tint(mb, ground_ao(0.5, 0.7))
    return mb


def outdoor_gym(name='outdoor_gym', seed=420):
    """Street-workout set on a 6 x 4 m rubber mat: triple-height pull-up bars, parallel dip bars, horizontal ladder,
    wall bars; powder-coated blue / yellow steel."""
    mb = TMB(name)
    tquad(mb, (-3.0, 0.02, 2.0), (1, 0, 0), (0, 0, -1), 6.0, 4.0, RS('rubber_mat', 0.52, 0.02, 0.98, 0.98), (2.0, 2.0))
    tbox(mb, (-3.0, 0, -2.0), (3.0, 0.02, 2.0), 'concrete', (3, 3), faces='+x-x+z-z')
    post = lambda x, z, h, reg=BLUE(): cyl(mb, (x, 0, z), (x, h, z), 0.045, 6, reg)
    bar = lambda a, b: cyl(mb, a, b, 0.017, 5, 'steel_galv')
    # pull-up bars (3 heights)
    for i, (x, h) in enumerate(((-2.6, 2.0), (-1.7, 2.3), (-0.8, 2.6), (0.1, 2.6))):
        post(x, -1.2, max(h, 2.0 if i == 0 else h))
    for (xa, xb, h) in ((-2.6, -1.7, 2.0), (-1.7, -0.8, 2.3), (-0.8, 0.1, 2.6)):
        bar((xa, h - 0.05, -1.2), (xb, h - 0.05, -1.2))
    # parallel bars
    for z in (0.75, 1.3):
        post(-2.4, z, 1.15, YEL()); post(-0.6, z, 1.15, YEL())
        cyl(mb, (-2.4, 1.15, z), (-0.6, 1.15, z), 0.025, 5, 'steel_galv')
    # horizontal ladder
    for x in (0.9, 2.7):
        for z in (0.5, 1.2):
            post(x, z, 2.3)
    for z in (0.5, 1.2):
        cyl(mb, (0.9, 2.3, z), (2.7, 2.3, z), 0.03, 6, BLUE())
    for k in range(6):
        x = 1.05 + k * 0.3
        bar((x, 2.31, 0.5), (x, 2.31, 1.2))
    # wall bars
    for x in (1.4, 2.4):
        post(x, -1.3, 2.4, YEL())
    for k in range(8):
        bar((1.4, 0.3 + k * 0.28, -1.3), (2.4, 0.3 + k * 0.28, -1.3))
    tint(mb, ground_ao(0.5, 0.7))
    return mb


def parking_barrier(name='parking_barrier', seed=430):
    """Boom barrier: yellow-black drive housing, 4 m red / white boom along +X resting in a fork post."""
    mb = TMB(name)
    hz = RS('decals', 0.52, 0.02, 0.98, 0.48)
    tbox(mb, (-0.55, 0, -0.35), (0.25, 0.12, 0.35), 'concrete', (1, 1), faces='+x-x+z-z+y')
    fbox(mb, (-0.35, 0.12, -0.17), (0.05, 1.05, 0.17), hz, faces='+x-x+z-z')
    fbox(mb, (-0.37, 1.05, -0.19), (0.07, 1.12, 0.19), 'steel_dark', faces='+x-x+z-z+y')
    st = RS('decals', 0.02, 0.02, 0.48, 0.48)
    for k in range(4):
        x0 = 0.05 + k * 1.0
        fbox(mb, (x0, 0.86, -0.045), (x0 + 1.0, 0.96, 0.045), st, faces='+y-y+z-z' + ('+x' if k == 3 else ''))
    fbox(mb, (3.95, 0, -0.06), (4.07, 0.84, 0.06), 'steel_galv', faces='+x-x+z-z')
    for s in (-1, 1):
        fbox(mb, (3.95, 0.84, s * 0.06 - 0.015), (4.07, 1.0, s * 0.06 + 0.015), 'steel_galv', faces='+x-x+z-z+y')
    tint(mb, ground_ao(0.4, 0.7))
    return mb


def euro_bin(mb, M, seed, open_lid=0.0):
    """1100 l four-wheel container 1.37 x 1.07 x 1.33 m (X = width, Z = depth); local origin on the ground."""
    tmp = TMB()
    reg_b = RS('bin_euro', 0, 0.27, 1, 1); reg_l = RS('bin_euro', 0, 0, 1, 0.23)
    hw, hd = 0.685, 0.535
    y0, y1 = 0.2, 1.18
    P = lambda x, y, z, k: (x * k, y, z * k)
    rings = [[P(-hw, y0, -hd, 0.88), P(hw, y0, -hd, 0.88), P(hw, y0, hd, 0.88), P(-hw, y0, hd, 0.88)],
             [P(-hw, y1, -hd, 1.0), P(hw, y1, -hd, 1.0), P(hw, y1, hd, 1.0), P(-hw, y1, hd, 1.0)]]
    cen = np.array([0, (y0 + y1) / 2, 0])
    for k in range(4):
        Q = [rings[0][k], rings[0][(k + 1) % 4], rings[1][(k + 1) % 4], rings[1][k]]
        tmp.poly(_orient(Q, cen), Fit(reg_b, (1.4, 1.0), seed + k, stretch=True))
    Qb = np.array(rings[0]); tmp.poly(Qb if newell(Qb)[1] < 0 else Qb[::-1], G.fit('steel_dark', (1, 1)))
    # rim + lid (hinged at the back, -Z)
    fbox(tmp, (-hw - 0.03, y1 - 0.05, -hd - 0.03), (hw + 0.03, y1 + 0.02, hd + 0.03), reg_l, faces='+x-x+z-z')
    lid = TMB()
    fbox(lid, (-hw - 0.04, 0, 0), (hw + 0.04, 0.08, 2 * hd + 0.06), reg_l, faces='+y+x-x+z-y')
    tmp.merge(lid, T(0, y1 + 0.02, -hd - 0.03) @ rot_axis((1, 0, 0), -open_lid))
    for x in (-hw * 0.75, hw * 0.75):
        for z in (-hd * 0.7, hd * 0.7):
            fbox(tmp, (x - 0.03, 0, z - 0.06), (x + 0.03, y0, z + 0.06), 'steel_dark', faces='+x-x+z-z')
    fbox(tmp, (-hw * 0.6, y1 - 0.3, hd * 0.98 + 0.0), (hw * 0.6, y1 - 0.24, hd * 0.98 + 0.06), 'steel_dark', faces='+y-y+z')
    mb.merge(tmp, M)


def _orient(Q, centre):
    Q = np.asarray(Q, float)
    return Q if np.dot(newell(Q), Q.mean(0) - centre) >= 0 else Q[::-1]


def waste_pad(name='waste_pad', seed=440):
    """Concrete-walled container pad 5.0 x 2.6 m (low U-wall 1.5 m) with three 1100 l euro bins; the right one
    tipped over forward with its lid open and rubbish spilled; a couple of bin bags."""
    mb = TMB(name); r = rng(seed)
    Lx, Dz, Hw = 5.0, 2.6, 1.5
    tbox(mb, (-Lx / 2, 0, -Dz / 2), (Lx / 2, 0.1, Dz / 2), 'concrete', (2.5, 2.6), faces='+x-x+z+y')
    tbox(mb, (-Lx / 2, 0.1, -Dz / 2), (Lx / 2, Hw, -Dz / 2 + 0.15), 'concrete', (2.5, 1.5), faces='+x-x+z-z+y')
    for s in (-1, 1):
        x = s * (Lx / 2 - 0.075)
        tbox(mb, (x - 0.075, 0.1, -Dz / 2 + 0.15), (x + 0.075, Hw, Dz / 2 - 0.3), 'concrete', (2.6, 1.5), faces='+x-x+z+y')
    euro_bin(mb, T(-1.55, 0.1, -0.35), seed)
    euro_bin(mb, T(0.0, 0.1, -0.3), seed + 1, open_lid=0.6)
    euro_bin(mb, T(1.5, 0.1 - 0.2, -0.35) @ rot_axis((1, 0, 0), PI / 2, origin=(0, 0, 0.535)) @ RY(0.1), seed + 2, open_lid=0.5)
    for k in range(5):
        chunk(mb, (r.uniform(0.6, 2.4), 0.12, r.uniform(1.0, 1.9)), (r.uniform(0.25, 0.5), 0.25, r.uniform(0.25, 0.45)), seed + k, 'steel_dark' if k % 2 else 'interior_dark')
    tint(mb, ground_ao(0.6, 0.65))
    return mb


def bench_modern(name='bench_modern', seed=450):
    """Park bench 1.8 m: two steel side frames, wooden seat / back slats."""
    mb = TMB(name)
    for x in (-0.75, 0.75):
        fbox(mb, (x - 0.035, 0, -0.25), (x + 0.035, 0.42, -0.19), 'steel_dark', faces='+x-x+z-z')
        fbox(mb, (x - 0.035, 0, 0.17), (x + 0.035, 0.42, 0.23), 'steel_dark', faces='+x-x+z-z')
        fbox(mb, (x - 0.035, 0.38, -0.27), (x + 0.035, 0.43, 0.25), 'steel_dark', faces='+x-x+z-z+y')
        beam(mb, (x, 0.42, -0.24), (x, 0.88, -0.33), 0.06, 0.05, 'steel_dark')
    for k in range(3):
        z = -0.2 + k * 0.15
        fbox(mb, (-0.9, 0.43, z), (0.9, 0.47, z + 0.12), RS('wood_slats', 0, 0.62, 1, 0.78), faces='+y-y+z-z+x-x')
    for k in range(2):
        y = 0.55 + k * 0.17
        Mb = rot_axis((1, 0, 0), -0.2, origin=(0, y, -0.28))
        tbox(mb, (-0.9, y, -0.31), (0.9, y + 0.12, -0.27), RS('wood_slats', 0, 0.62, 1, 0.78), (1.8, 0.12), M=Mb, faces='+z-z+y-y+x-x')
    tint(mb, ground_ao(0.4, 0.7))
    return mb


def lamp_led(name='lamp_led', seed=460):
    """Modern street light: 8 m tapered octagonal galvanised pole on a flange, 1.5 m outreach arm along +X, flat
    LED luminaire head."""
    mb = TMB(name)
    G.lathe(mb, [(0.16, 0.0), (0.16, 0.03), (0.095, 0.05)], 8, 'steel_galv')
    G.lathe(mb, [(0.095, 0.05), (0.055, 8.0), (0.0, 8.05)], 8, 'steel_galv')
    G.tube(mb, [(0.0, 7.7, 0), (0.4, 8.05, 0), (1.0, 8.2, 0), (1.5, 8.25, 0)], 0.035, 6, 'steel_galv', seg=50)
    Mh = T(1.65, 8.22, 0) @ rot_axis((0, 0, 1), 0.08)
    fbox(mb, (-0.3, -0.04, -0.13), (0.3, 0.05, 0.13), RS('lamp_parts', 0.02, 0.02, 0.48, 0.48), faces='+x-x+z-z+y', M=Mh)
    tquad(mb, (-0.28, -0.042, -0.11), (1, 0, 0), (0, 0, 1), 0.56, 0.22, RS('lamp_parts', 0.02, 0.52, 0.48, 0.98), (0.56, 0.22), M=Mh)
    fbox(mb, (-0.25, -0.0, -0.06), (0.06, 0.25, 0.06), 'steel_galv', faces='+x-x+z-z+y')     # base door box
    return mb


def ad_column(name='ad_column', seed=470):
    """Round advertising column (afishna tumba), 1.2 m dia, 3.3 m: dark green base and cornice, pasted posters,
    domed cap."""
    mb = TMB(name)
    G.lathe(mb, [(0.66, 0.0), (0.66, 0.3), (0.6, 0.32)], 14, 'steel_dark')
    G.lathe(mb, [(0.6, 0.32), (0.6, 2.72)], 14, 'ad_poster', around=1.0)
    G.lathe(mb, [(0.6, 2.72), (0.7, 2.76), (0.7, 2.9), (0.62, 2.92)], 14, 'steel_dark')
    G.lathe(mb, [(0.62, 2.92), (0.5, 3.05), (0.3, 3.2), (0.06, 3.28), (0.0, 3.3)], 14, GREEN())
    tint(mb, ground_ao(0.5, 0.7))
    return mb


# ====================================================================== war additions
def tyre_ring(mb, c, R0=0.31, r0=0.1, seg=10, sides=4, M=None, burnt=False):
    tmp = TMB()
    rg = G.R['tyre_car' if not burnt else 'ash']
    rings = []
    for i in range(seg):
        a = 2 * PI * i / seg
        ring = []
        for k in range(sides):
            b = 2 * PI * k / sides + PI / sides
            rr = R0 + math.cos(b) * r0
            ring.append(tmp.v((c[0] + math.cos(a) * rr, c[1] + math.sin(b) * r0 * 0.95, c[2] + math.sin(a) * rr)))
        rings.append(ring)
    for i in range(seg):
        for k in range(sides):
            idx = [rings[i][k], rings[(i + 1) % seg][k], rings[(i + 1) % seg][(k + 1) % sides], rings[i][(k + 1) % sides]]
            P = np.array([tmp.V[j] for j in idx])
            a = 2 * PI * (i + 0.5) / seg
            ctr = np.array([c[0] + math.cos(a) * R0, c[1], c[2] + math.sin(a) * R0])
            if np.dot(newell(P), P.mean(0) - ctr) < 0:
                idx = idx[::-1]
            tmp.face(idx, [rg.uv(0.1 + 0.8 * i / seg, 0.03), rg.uv(0.1 + 0.8 * (i + 1) / seg, 0.03), rg.uv(0.1 + 0.8 * (i + 1) / seg, 0.2), rg.uv(0.1 + 0.8 * i / seg, 0.2)], True)
    mb.merge(tmp, M)


def hedgehog(mb, c, seed, s=1.0):
    """Czech hedgehog from three welded I-beam stubs (1.8 m)."""
    r = rng(seed); c = np.asarray(c, float)
    axes = [np.array([1, 1, 0.0]), np.array([-1, 1, 0.0]), np.array([0, 1, 1.0])]
    Mr = mat_trs(c + [0, 0.62 * s, 0], (0, r.uniform(0, PI), 0))
    for k, a in enumerate(((0.0, 0.0, 0.62), (0.0, 2.1, 0.62), (0.0, 4.2, 0.62))):
        d = np.array([math.cos(a[1]) * math.sin(0.95), math.cos(0.95), math.sin(a[1]) * math.sin(0.95)])
        p0 = -d * 0.95 * s; p1 = d * 0.95 * s
        beam(mb, xform(p0[None], Mr)[0], xform(p1[None], Mr)[0], 0.14 * s, 0.14 * s, 'steel_rust', faces='+y-y+z-z')
        beam(mb, xform(p0[None], Mr)[0], xform(p1[None], Mr)[0], 0.02 * s, 0.13 * s, 'steel_rust', faces='+z-z')


def checkpoint_blocks(name='checkpoint_blocks', seed=480):
    """Roadblock / checkpoint chicane 10 x 4 m: FBS 24.6.6 foundation blocks in two staggered rows (partly stacked),
    a sandbag wall with a firing position, a stack of tyres, a Czech hedgehog, a red-white stop board."""
    mb = TMB(name); r = rng(seed)
    fb = RS('fbs', 0, 0.5, 1, 1); fe = RS('fbs', 0, 0, 0.25, 0.5)
    def block(x, y, z, yaw=0.0):
        M = mat_trs((x, y, z), (0, yaw, 0))
        tbox(mb, (-1.2, 0, -0.3), (1.2, 0.6, 0.3), fb, (2.4, 0.6), M=M, faces='+z-z+y', regs=None)
        tbox(mb, (-1.2, 0, -0.3), (1.2, 0.6, 0.3), fe, (0.6, 0.6), M=M, faces='+x-x')
    for i, x in enumerate((-3.8, -1.35, 1.1)):
        block(x, 0, -1.3, r.normal(0, 0.03))
    block(-3.8, 0.6, -1.3, 0.04)
    for i, x in enumerate((0.2, 2.7)):
        block(x, 0, 1.0, r.normal(0, 0.04))
    block(2.7, 0.6, 1.02, -0.05)
    # sandbag wall + firing position at the +X end
    for row in range(5):
        for k in range(5):
            x0 = 3.1 + k * 0.42 - (0.21 if row % 2 else 0)
            if x0 > 4.75 or x0 < 3.0:
                continue
            Mb = mat_trs((x0 + 0.21, row * 0.17, -1.2 + r.normal(0, 0.02)), (0, r.normal(0, 0.06), 0))
            v0 = (row % 6) / 6
            fbox(mb, (-0.2, 0, -0.28), (0.2, 0.18, 0.28), RS('sandbag', 0, v0, 0.5, v0 + 1 / 6), faces='+y+z-z+x-x', M=Mb)
    # tyre stack
    for k in range(5):
        tyre_ring(mb, (-4.4 + r.normal(0, 0.03), 0.1 + k * 0.19, 1.2 + r.normal(0, 0.03)))
    tyre_ring(mb, (-3.6, 0.1, 1.55), M=None)
    hedgehog(mb, (-1.6, 0, 1.1), seed + 3)
    # stop board on a post
    cyl(mb, (4.2, 0.6, 1.0), (4.2, 1.9, 1.0), 0.03, 5, 'steel_galv')
    st = RS('decals', 0.02, 0.02, 0.48, 0.48)
    tquad(mb, (3.8, 1.5, 1.04), (1, 0, 0), (0, 1, 0), 0.8, 0.35, st, (0.8, 0.35))
    tquad(mb, (4.6, 1.5, 0.96), (-1, 0, 0), (0, 1, 0), 0.8, 0.35, st, (0.8, 0.35))
    tint(mb, ground_ao(0.6, 0.62))
    return mb


def antidrone_net_frame(name='antidrone_net_frame', seed=490):
    """Anti-drone net tunnel over an 8 m road section (road along X, 6 m wide): three pairs of steel pipe poles
    5.2 m high braced by cross cables, knotted fishing net sagging over the top and hanging down both sides to
    ~0.4 m above the ground, a torn patch and camo scrim strips (alpha material)."""
    mb = TMB(name); r = rng(seed)
    Lx, hz, Hp = 8.0, 3.2, 5.2
    xs = (-Lx / 2, 0.0, Lx / 2)
    for x in xs:
        for s in (-1, 1):
            cyl(mb, (x, 0, s * hz), (x + r.normal(0, 0.03), Hp, s * hz + s * r.uniform(0.0, 0.08)), 0.055, 6, 'steel_rust' if x == 0 else 'steel_galv')
            tbox(mb, (x - 0.25, 0, s * hz - 0.25), (x + 0.25, 0.25, s * hz + 0.25), 'concrete', (0.5, 0.25), faces='+x-x+z-z+y')
            cyl(mb, (x, Hp - 0.05, s * hz), (x + s * 0.0, 0.25, s * (hz + 1.4)), 0.01, 3, 'steel_dark')      # stay cable
        G.tube(mb, [(x, Hp, -hz), (x, Hp - 0.25, 0), (x, Hp, hz)], 0.012, 3, 'steel_dark', seg=50)
    for s in (-1, 1):
        cyl(mb, (-Lx / 2, Hp, s * hz), (Lx / 2, Hp, s * hz), 0.012, 3, 'steel_dark')
    def top(u, v):          # u along x, v across (z)
        sag_z = 0.45 * math.sin(PI * (v + hz) / (2 * hz))
        sag_x = 0.18 * abs(math.sin(PI * u / (Lx / 2)))
        return np.array([u, Hp - sag_z - sag_x + 0.02, v])
    agrid(mb, top, -Lx / 2 - 0.2, Lx / 2 + 0.2, -hz, hz, 'net', (2.0, 2.0), 1.0)
    for s in (-1, 1):
        def side(u, v, s=s):
            bil = 0.18 * math.sin(PI * (v - 0.4) / (Hp - 0.4)) * (0.6 + 0.4 * abs(math.sin(PI * u / (Lx / 2))))
            return np.array([u, v, s * (hz + 0.06 + bil)])
        if s > 0:
            agrid(mb, side, -Lx / 2 - 0.2, 0.0, 0.4, Hp, 'net', (2.0, 2.0), 1.0)
            agrid(mb, side, 0.0, Lx / 2 + 0.2, 0.4, Hp, 'net_torn', (2.0, 2.0), 1.0)
        else:
            agrid(mb, side, -Lx / 2 - 0.2, Lx / 2 + 0.2, 0.9, Hp, 'net', (2.0, 2.0), 1.0)
            # loose flap hanging lower at one end
            agrid(mb, lambda u, v: np.array([u, v, -hz - 0.2 - 0.25 * (0.9 - v)]), Lx / 2 - 2.0, Lx / 2 + 0.2, 0.15, 0.9, 'net', (2.0, 2.0), 1.0)
    tint(mb, ground_ao(0.5, 0.7))
    return mb


def all_items():
    out = [(car('car_hatch_modern', 'hatch', 'intact', 500), 'ch'), (car('car_hatch_modern_burnt', 'hatch', 'burnt', 501), 'ch'),
           (car('car_suv_modern', 'suv', 'intact', 502), 'cs'), (car('car_suv_modern_burnt', 'suv', 'burnt', 503), 'cs'),
           (car('car_van', 'van', 'intact', 504), 'cv'), (car('car_van_medevac', 'van', 'medevac', 505), 'cv'),
           (car('car_van_burnt', 'van', 'burnt', 506), 'cv'), (car('bus_burnt_modern', 'bus', 'burnt', 507), 'bb'),
           (bus_stop_modern(), 'bs'), (playground_modern(), 'pg'), (outdoor_gym(), 'og'), (parking_barrier(), 'pb'),
           (waste_pad(), 'wp'), (bench_modern(), 'bm'), (lamp_led(), 'll'), (ad_column(), 'ac'),
           (checkpoint_blocks(), 'cb'), (antidrone_net_frame(), 'an')]
    return out


NODE_NOTES = {
    'car_hatch_modern': 'Lanos / Sens-like 5-door hatchback 4.07 x 1.68 x 1.43 m, cherry red, front +X.',
    'car_hatch_modern_burnt': 'burnt-out twin: on bare rims (~0.11 m lower), glass gone, gutted, soot / ash paint.',
    'car_suv_modern': 'compact crossover 4.32 x 1.80 x 1.65 m, silver, black plastic cladding, roof rails, front +X.',
    'car_suv_modern_burnt': 'burnt-out twin of car_suv_modern.',
    'car_van': 'Sprinter-like high-roof van 5.93 x 1.99 x 2.62 m, white, front +X.',
    'car_van_medevac': 'car_van with red-cross markings (sides, rear, roof) and a blue light bar.',
    'car_van_burnt': 'burnt-out van: cab glass gone, cargo box burnt, on rims.',
    'bus_burnt_modern': 'burnt-out 12 m low-floor city bus (Bogdan / Electron type) 12.0 x 2.55 x 3.05 m: window band open, roof sagging and holed, seat frames, on rims; front +X.',
    'bus_stop_modern': '4.2 x 1.6 m shelter, open side +Z, back glass at -Z (alpha, cracked / shot out).',
    'playground_modern': '14 x 10 m rubber-surfaced playground (tower + slide, swings, spring riders, carousel).',
    'outdoor_gym': 'street-workout set on a 6 x 4 m mat.',
    'parking_barrier': 'housing at x = -0.15, 4 m boom along +X to the rest post.',
    'waste_pad': '5 x 2.6 m concrete U-pad (open side +Z), 3 euro bins (one tipped out of the pad).',
    'bench_modern': '1.8 m park bench, seat facing +Z.',
    'lamp_led': '8 m LED street light, arm and head reach +X 1.65 m.',
    'ad_column': 'round advertising column 1.2 m dia x 3.3 m.',
    'checkpoint_blocks': '10 x 4 m FBS-block chicane with sandbags, tyres, hedgehog, stop board.',
    'antidrone_net_frame': 'net tunnel over an 8 m road section along X, 6.4 m between the pole lines, 5.2 m high; netting = modern_alpha.',
}
