"""Detailed modern cars for modern.glb (hatch / suv / van, intact / medevac / burnt), front = +X.
Body = two smooth lofts over ~35 stations along X built from the CARS spec (modern_atlas.CARS):
  shell  -- open section sill -> door bulge -> shoulder on both sides + floor, with real wheel-arch cut-outs (the sill
            rises round each axle) and fender flares;
  top    -- one 7-point ring blended from the bonnet / boot-lid crown (t = 0) to the roof (t = 1) along the
            greenhouse ramps, so bonnet -> windscreen -> roof -> rear glass -> deck is one surface (creases kept sharp
            by the 35 deg auto-smooth split).
UVs are projected into the car's 512 x 256 region by modern_props.CarUV (side / top / front / rear views painted by
modern_atlas.car_paint: seams, glazing with seat / headrest silhouettes, lamps, plates, plastic trim).
Wheels: rounded tyres (lathe) with tread band, recessed alloy rim disc and dark barrel; burnt: bare rims.
Extras: mirrors (body colour + glass), roof rails (suv), wiper arms, number plates, medevac crosses + light bar.
Burnt: sits on the rims, greenhouse open (A / B / C pillars, header, sagging double-sided roof), gutted interior
(ash floor, seat frames, dash), sprung bonnet, warped panels, ash puddles.
"""
import math
import numpy as np
from meshlib import Fit, newell, mat_trs, rng
import modern_atlas as MA
import city_geo as G
from city_geo import tquad, fbox, lathe
from modern_geo import TMB, T, RS, BLUE, tint, beam, cyl, disc, PI

CARS = MA.CARS


def _interp(spec):
    low = spec['low'][::-1]                     # rear -> front (increasing x)
    X = np.array([s[0] for s in low])
    f = lambda k: (lambda x: float(np.interp(x, X, [s[k] for s in low])))
    return f(1), f(2), f(3)


def _stations(spec, n=34):
    L = spec['L']; xa, xd, xb, xc = spec['gx']; r = spec['r']
    xs = list(np.linspace(-L / 2, L / 2, n))
    xs += [L / 2 - 0.035, -L / 2 + 0.035, L / 2 - 0.1, -L / 2 + 0.1, xa, xb, xc, xd]
    for ax in spec['axles']:
        Ra = r + 0.06
        xs += [ax + Ra * math.cos(t) for t in np.linspace(0, PI, 9)]
        xs += [ax - Ra - 0.05, ax + Ra + 0.05]
    xs = sorted(set(round(float(x), 4) for x in xs if -L / 2 - 1e-6 <= x <= L / 2 + 1e-6))
    out = [xs[0]]
    for x in xs[1:]:
        if x - out[-1] > 0.02:
            out.append(x)
    return out


def _t_green(spec, x):
    xa, xd, xb, xc = spec['gx']
    if x >= xa or x <= xd:
        return 0.0
    if x > xb:
        return ((xa - x) / (xa - xb)) ** 0.9
    if x < xc:
        return ((x - xd) / (xc - xd)) ** 0.9
    return 1.0


def _loft(mb, rings, uvf, smooth=True, close=False, skip=None, reg_for=None):
    """Quads between consecutive rings (lists of shared vertex ids); outward orientation fixed per face against the
    ring centroid.  reg_for(k) -> alternative uv fn for strip k."""
    for i in range(len(rings) - 1):
        A, B = rings[i], rings[i + 1]
        n = len(A)
        cen = (np.mean([mb.V[v] for v in A], 0) + np.mean([mb.V[v] for v in B], 0)) / 2
        for k in range(n if close else n - 1):
            if skip and skip(i, k):
                continue
            k2 = (k + 1) % n
            idx = [A[k], A[k2], B[k2], B[k]]
            P = np.array([mb.V[v] for v in idx])
            # drop collapsed quads, keep triangles
            keep = [j for j in range(4) if np.linalg.norm(P[j] - P[(j + 1) % 4]) > 1e-5]
            if len(keep) < 3:
                continue
            idx = [idx[j] for j in keep]; P = P[keep]
            nrm = newell(P)
            if np.linalg.norm(nrm) < 1e-9:
                continue
            ref = cen.copy(); ref[0] = P.mean(0)[0]
            if np.dot(nrm, P.mean(0) - ref) < 0:
                idx = idx[::-1]; P = P[::-1]
            fn = reg_for(k) if reg_for else uvf
            mb.face(idx, fn(P, newell(P)), smooth)


def wheel(mb, c, r, w, side, burnt=False, sides=18):
    """Tyre (lathe about Z, outer face towards `side`) + recessed rim disc + barrel; burnt: bare charred rim."""
    rg = G.R['tyre_car' if not burnt else 'rim_burnt']
    c = np.asarray(c, float)
    if burnt:
        prof = [(r * 0.98, -w / 2), (r, -w / 2 + 0.02), (r, w / 2 - 0.02), (r * 0.98, w / 2), (r * 0.9, w / 2 - 0.01)]
    else:
        prof = [(r * 0.7, -w / 2 + 0.012), (r * 0.86, -w / 2), (r * 0.96, -w / 2 + 0.018), (r, -w / 2 + 0.05), (r, w / 2 - 0.05),
                (r * 0.96, w / 2 - 0.018), (r * 0.86, w / 2), (r * 0.7, w / 2 - 0.012)]
    ts = np.linspace(0, 2 * PI, sides, endpoint=False)
    rings = [[mb.v((c[0] + math.cos(t) * rr, c[1] + math.sin(t) * rr, c[2] + side * zz)) for t in ts] for rr, zz in prof]
    for j in range(len(prof) - 1):
        for k in range(sides):
            k2 = (k + 1) % sides
            idx = [rings[j][k], rings[j][k2], rings[j + 1][k2], rings[j + 1][k]]
            P = np.array([mb.V[i] for i in idx])
            mr = (prof[j][0] + prof[j + 1][0]) / 2 - r * 0.85; mz = (prof[j][1] + prof[j + 1][1]) / 2
            m = P.mean(0); rad = np.array([m[0] - c[0], m[1] - c[1], 0.0]); rad /= np.linalg.norm(rad) + 1e-12
            out = rad * mr + np.array([0, 0, side * mz])
            if np.dot(newell(P), out) < 0:
                idx = idx[::-1]
            u0 = (k % (sides // 2)) / (sides // 2); u1 = u0 + 1 / (sides // 2)
            mb.face(idx, [rg.uv(u0, 0.03), rg.uv(u1, 0.03), rg.uv(u1, 0.22), rg.uv(u0, 0.22)], True)
    # rim disc recessed in the outer bead, barrel behind it, dark inner face
    ro = prof[-1][0]; zo = c[2] + side * (prof[-1][1] - 0.025)
    rimr = ro * 0.98
    face = [mb.v((c[0] + math.cos(t) * rimr, c[1] + math.sin(t) * rimr, zo)) for t in ts]
    P = np.array([mb.V[i] for i in face])
    if newell(P)[2] * side < 0:
        face = face[::-1]
    k_uv = 0.36 * (rimr / r) / (0.62 if not burnt else 1.0) * (0.62 if not burnt else 0.95)
    mb.face(face, [rg.uv(0.5 + k_uv * (mb.V[i][0] - c[0]) / rimr * side, 0.625 + k_uv * (mb.V[i][1] - c[1]) / rimr) for i in face], False)
    inner = [mb.v((c[0] + math.cos(t) * prof[0][0], c[1] + math.sin(t) * prof[0][0], c[2] + side * prof[0][1])) for t in ts]
    P = np.array([mb.V[i] for i in inner])
    if newell(P)[2] * side > 0:
        inner = inner[::-1]
    mb.face(inner, [G.R['steel_dark'].uv(0.5, 0.5)] * sides, False)
    if burnt:
        G.tube(mb, [c + np.array([math.cos(t) * r * 1.1, math.sin(t) * r * 1.04 - 0.02, side * w * 0.3]) for t in np.linspace(0, 2 * PI, 11)], 0.008, 3, 'steel_dark', seg=50)


def car(name, model, kind='intact', seed=0):
    import modern_props as MP
    spec = CARS[model]; r = rng(seed)
    L, W, H, belt = spec['L'], spec['W'], spec['H'], spec['belt']
    xa, xd, xb, xc = spec['gx']; gw0, gw1 = spec['gw']; wr = spec['r']
    burnt = kind == 'burnt'
    reg = 'car_' + model + ('_burnt' if burnt else '')
    uvf = MP.CarUV(reg, spec)
    ybot, ytop, hwf = _interp(spec)
    xs = _stations(spec)
    mb = TMB(name); body = TMB()
    Ra = wr + 0.06
    crown = 0.035 if model != 'van' else 0.05

    def shell_ring(x):
        ybn, yt, hw = ybot(x), ytop(x), hwf(x)
        yarch = -1.0
        for ax in spec['axles']:
            dx = abs(x - ax)
            if dx < Ra:
                yarch = max(yarch, wr + math.sqrt(Ra * Ra - dx * dx) * 0.98)
            if dx < Ra + 0.12:
                hw = hw + 0.012 * (1 - max(0.0, dx - Ra * 0.6) / (Ra * 0.4 + 0.12))
        h = yt - ybn
        # round the nose / tail in plan + elevation
        e = min(1.0, (L / 2 - abs(x)) / 0.12)
        sq = 0.86 + 0.14 * math.sqrt(max(0.0, e))
        pts = [(hw * 0.9 * sq, ybn), (hw * 0.985 * sq, ybn + 0.1 * h), (hw * sq, ybn + 0.42 * h), (hw * 0.99 * sq, ybn + 0.74 * h),
               (hw * 0.955 * sq, yt - 0.035), (hw * 0.915 * sq, yt)]
        pts = [(z, max(y, yarch) if yarch > 0 else y) for z, y in pts]
        right = [(x, y, z) for z, y in pts]
        left = [(x, y, -z) for z, y in pts]
        return left[::-1] + right, hw * 0.915 * sq, yt

    shells, tops, tz = [], [], []
    for x in xs:
        sr, zs, yt = shell_ring(x)
        shells.append(body.vs(sr))
        tz.append((zs, yt))
    # floor strip index = 5 (between L0 and R0) -> dark underside
    under = Fit(G.R['steel_dark'], (2, 2))
    _loft(body, shells, uvf, reg_for=lambda k: under if k == 5 else uvf)
    # top surface(s): one loft over the whole length (intact) or bonnet + deck only (burnt)
    def build_top(sel):
        rings = []
        for x, (zs, yt), sh in zip(xs, tz, shells):
            if not sel(x):
                continue
            t = _t_green(spec, x)
            hood = [(zs, yt), (zs * 0.97, yt + crown * 0.3), (zs * 0.62, yt + crown * 0.75), (0.0, yt + crown)]
            yg = belt + (H - belt) * t; gwr = zs + (gw1 - zs) * t
            roof = [(zs, yt), (gwr, yg - 0.06 * t), (gwr * 0.8, yg), (0.0, yg + 0.025)]
            Pz = [((1 - t) * a[0] + t * b[0], (1 - t) * a[1] + t * b[1]) for a, b in zip(hood, roof)]
            ids = [sh[-1]] + body.vs([(x, y, z) for z, y in Pz[1:]]) + body.vs([(x, y, -z) for z, y in Pz[1:-1][::-1]]) + [sh[0]]
            rings.append(ids)
        _loft(body, rings, uvf)
        return rings
    if not burnt:
        trings = build_top(lambda x: True)
        front_top, rear_top = trings[-1], trings[0]
    else:
        cab1 = xa if model != 'van' else xa
        cab0 = xd if model != 'van' else 1.2
        tf = build_top(lambda x: x >= cab1 - 1e-6)
        tr = build_top(lambda x: x <= cab0 + 1e-6)
        front_top, rear_top = tf[-1], tr[0]
    # end caps (front / rear faces): shell ring + top ring closed loop, fan from the centroid
    for sh, tp, sgn in ((shells[-1], front_top, 1), (shells[0], rear_top, -1)):
        loop = list(sh) + list(tp[1:-1])[::-1]
        P = np.array([body.V[i] for i in loop])
        c = body.v(P.mean(0))
        for k in range(len(loop)):
            tri = [c, loop[k], loop[(k + 1) % len(loop)]]
            Q = np.array([body.V[i] for i in tri])
            if newell(Q)[0] * sgn < 0:
                tri = tri[::-1]; Q = Q[::-1]
            if np.linalg.norm(newell(Q)) > 1e-9:
                body.face(tri, uvf(Q, np.array([sgn, 0.0, 0.0])), False)
    zg = lambda y, s: s * (gw0 + (gw1 - gw0) * (y - belt) / (H - belt))
    paint = RS(reg, (spec['doors'][0] - 0.35 + L / 2) / L, 0.4 + 0.6 * (belt - 0.3) / H, (spec['doors'][0] - 0.25 + L / 2) / L, 0.4 + 0.6 * (belt - 0.2) / H)
    if not burnt:
        # mirrors (body colour housing, dark glass) on stalks at the A-pillar base
        for s in (-1, 1):
            mx = xa - 0.1 if model != 'van' else xa - 0.08
            zb_ = s * (hwf(mx) * 0.9)
            mh = 0.13 if model != 'van' else 0.26
            beam(body, (mx, belt + 0.04, zb_), (mx - 0.03, belt + 0.07, zb_ + s * 0.1), 0.03, 0.03, 'steel_dark')
            fbox(body, (mx - 0.1, belt + 0.02, min(zb_ + s * 0.08, zb_ + s * 0.2)), (mx + 0.02, belt + 0.02 + mh, max(zb_ + s * 0.08, zb_ + s * 0.2)), paint, faces='+x+y-y+z-z')
            fbox(body, (mx - 0.101, belt + 0.035, min(zb_ + s * 0.09, zb_ + s * 0.19)), (mx - 0.1, belt + 0.01 + mh, max(zb_ + s * 0.09, zb_ + s * 0.19)), 'car_glass', faces='-x')
        # wiper arms resting on the cowl
        for zz in (-0.35, 0.25):
            beam(body, (xa + 0.02, belt + crown + 0.01, zz), (xa - 0.12, belt + 0.12, zz - 0.45), 0.02, 0.015, 'steel_dark')
        if model == 'suv':
            for s in (-1, 1):
                for x in (xc + 0.2, (xb + xc) / 2, xb - 0.2):
                    fbox(body, (x - 0.04, H + 0.02, s * 0.62 - 0.025), (x + 0.04, H + 0.06, s * 0.62 + 0.025), 'steel_dark', faces='+x-x+z-z')
                fbox(body, (xc + 0.12, H + 0.06, s * 0.62 - 0.025), (xb - 0.12, H + 0.09, s * 0.62 + 0.025), 'steel_galv', faces='+y+x-x+z-z')
        # number plates (front / rear), slightly proud
        for sgn, x in ((1, L / 2 + 0.006), (-1, -L / 2 - 0.006)):
            y0, y1 = (0.36, 0.47) if model != 'van' else (0.4, 0.51)
            P = [(x, y0, -0.26 * sgn), (x, y0, 0.26 * sgn), (x, y1, 0.26 * sgn), (x, y1, -0.26 * sgn)]
            body.poly(P, uvf)
    else:
        # open greenhouse: pillars, header, cowl, sagging double-sided roof, gutted interior
        def strut(p0, p1, w=0.07, reg_='soot'):
            beam(body, p0, p1, w, w, reg_)
        cab0 = xd if model != 'van' else 1.2
        for s in (-1, 1):
            strut((xa, belt, zg(belt, s)), (xb, H - 0.02, zg(H, s)))
            if model == 'van':
                strut((1.25, belt, zg(belt, s)), (1.25, H, zg(H, s)), 0.1)
            else:
                bx = spec['doors'][1]
                strut((bx, belt, zg(belt, s)), (bx - 0.06, H - 0.02, zg(H, s)), 0.08)
                strut((xd, belt, zg(belt, s)), (xc, H - 0.02, zg(H, s)), 0.09)
                strut((spec['doors'][2] - 0.05, belt, zg(belt, s)), (spec['doors'][2] + 0.07, H - 0.02, zg(H, s)), 0.12)
        strut((xb, H - 0.02, -gw1), (xb, H - 0.02, gw1), 0.07)
        strut((xa, belt + 0.02, -gw0), (xa, belt + 0.02, gw0), 0.06)
        if model != 'van':
            strut((xc, H - 0.02, -gw1), (xc, H - 0.02, gw1), 0.07)
            strut((xd, belt, -gw0), (xd, belt, gw0), 0.06)
        nx, nz = 5, 3
        sag = 0.1
        x0r, x1r = (xc, xb) if model != 'van' else (1.2, xb)
        def rp(x, z):
            tx = (x - x0r) / (x1r - x0r); tz_ = z / gw1
            return (x, H - sag * math.sin(PI * tx) * (1 - tz_ * tz_) - 0.01, z)
        grid = [[body.v(rp(x0r + (x1r - x0r) * i / nx, -gw1 + 2 * gw1 * j / nz)) for j in range(nz + 1)] for i in range(nx + 1)]
        gridb = [[body.v(rp(x0r + (x1r - x0r) * i / nx, -gw1 + 2 * gw1 * j / nz)) for j in range(nz + 1)] for i in range(nx + 1)]
        so = Fit(G.R['soot'], (1.5, 1.5))
        for i in range(nx):
            for j in range(nz):
                idx = [grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j], grid[i][j]]
                P = np.array([body.V[v] for v in idx])
                if newell(P)[1] < 0:
                    idx = idx[::-1]; P = P[::-1]
                body.face(idx, uvf(P, newell(P)), True)
                idb = [gridb[i][j], gridb[i + 1][j], gridb[i + 1][j + 1], gridb[i][j + 1]]
                Pb = np.array([body.V[v] for v in idb])
                if newell(Pb)[1] > 0:
                    idb = idb[::-1]; Pb = Pb[::-1]
                body.face(idb, so(Pb, newell(Pb)), True)
        fl = ybot(0) + 0.14
        tquad(body, (cab0 + 0.05, fl, gw0 - 0.05), (1, 0, 0), (0, 0, -1), (xa - cab0) - 0.1, 2 * gw0 - 0.1, 'ash', (2, 2))
        fbox(body, (xa - 0.5, belt - 0.35, -gw0 + 0.1), (xa - 0.1, belt - 0.02, gw0 - 0.1), 'interior_burnt', faces='+y-x')
        rows = [(xa - 1.05, (0.38, -0.38))] + ([(spec['doors'][2] + 0.15, (0.0,))] if model != 'van' else [])
        for (x, zs_) in rows:
            for zc in zs_:
                zw = 0.24 if len(zs_) > 1 else 0.6
                fbox(body, (x - 0.25, fl + 0.12, zc - zw), (x + 0.25, fl + 0.22, zc + zw), 'interior_burnt', faces='+y+x-x+z-z')
                fbox(body, (x - 0.32, fl + 0.22, zc - zw), (x - 0.24, fl + 0.75, zc + zw), 'interior_burnt', faces='+x-x+y+z-z')
                for dz in (-zw * 0.7, zw * 0.7):
                    cyl(body, (x - 0.2, fl, zc + dz), (x - 0.2, fl + 0.12, zc + dz), 0.02, 3, 'steel_dark')
        cyl(body, (xa - 0.45, belt - 0.05, 0.38), (xa - 0.62, belt + 0.05, 0.38), 0.02, 3, 'steel_dark')      # steering column
        lathe(body, [(0.18, 0), (0.19, 0.015), (0.18, 0.03)], 8, 'soot', M=T(xa - 0.64, belt + 0.06, 0.38) @ mat_trs((0, 0, 0), (0, 0, 1.1)))
        # warp + sprung bonnet
        V = np.array(body.V)
        V += r.normal(0, 0.01, V.shape) * (V[:, 1:2] > 0.3)
        hood = (V[:, 0] > xa + 0.1) & (V[:, 1] > ytop(L / 2 - 0.3) - 0.05)
        V[hood, 1] += 0.06 * (V[hood, 0] - xa) / (L / 2 - xa)
        body.V = list(V)
    if kind == 'medevac':
        crs = RS('decals', 0.04, 0.54, 0.46, 0.96)
        for s in (-1, 1):
            y0_, y1_ = 1.3, 2.2
            x0_, x1_ = -1.55, -0.65
            P = [(x0_, y0_, zg(y0_, s) + s * 0.015), (x1_, y0_, zg(y0_, s) + s * 0.015), (x1_, y1_, zg(y1_, s) + s * 0.015), (x0_, y1_, zg(y1_, s) + s * 0.015)]
            if s < 0:
                P = [P[1], P[0], P[3], P[2]]
            body.poly(P, G.uvq(crs))
        body.poly([(xd - 0.015, 1.45, -0.42), (xd - 0.015, 2.27, -0.42), (xd - 0.015, 2.27, 0.42), (xd - 0.015, 1.45, 0.42)], G.uvq(crs))
        body.poly([(-1.6, H + 0.04, 0.55), (-0.5, H + 0.04, 0.55), (-0.5, H + 0.04, -0.55), (-1.6, H + 0.04, -0.55)], G.uvq(crs))
        fbox(body, (xb - 0.4, H + 0.02, -0.62), (xb - 0.14, H + 0.14, 0.62), BLUE(), faces='+y+x-x+z-z')
        fbox(body, (xb - 0.38, H + 0.05, -0.15), (xb - 0.13, H + 0.12, 0.15), RS('lamp_parts', 0.55, 0.55, 0.95, 0.95), faces='+x+y')
        for s in (-1, 1):       # side beacons + rear step
            fbox(body, (xd + 0.05, H - 0.2, s * 0.9 - 0.04), (xd + 0.2, H - 0.05, s * 0.9 + 0.04), BLUE(), faces='+y-x+z-z')
        fbox(body, (xd - 0.25, 0.3, -0.6), (xd + 0.02, 0.36, 0.6), 'steel_galv', faces='+y-x+z-z')
    # wheels
    ww = 0.2 if model != 'van' else 0.22
    drop = 0.0
    rr = wr
    if burnt:
        rr = wr * 0.62; drop = wr - rr
    for ax in spec['axles']:
        for s in (-1, 1):
            zc = s * (W / 2 - ww / 2 - 0.005)
            wheel(mb, (ax, rr, zc), rr, ww * (0.8 if burnt else 1.0), s, burnt=burnt)
    if burnt:
        body.transform(mat_trs((0, -drop, 0)))
        for k in range(3):
            x = r.uniform(-L / 3, L / 3)
            Pp = np.array([(x + math.cos(t) * r.uniform(0.4, 0.8), 0.012, math.sin(t) * r.uniform(0.3, 0.6)) for t in np.linspace(0, 2 * PI, 8, endpoint=False)])
            mb.poly(Pp if newell(Pp)[1] > 0 else Pp[::-1], G.fit('ash', (1.6, 1.6)))
        tint(body, lambda p: 0.72 + 0.28 * min(1.0, max(0.0, (p[1] - 0.15) / (H * 0.7))))
    else:
        tint(body, lambda p: 0.7 + 0.3 * min(1.0, max(0.0, (p[1] - 0.1) / 0.6)))
    tint(mb, lambda p: 0.8 + 0.2 * min(1.0, max(0.0, p[1] / 0.3)))
    mb.merge(body)
    return mb
