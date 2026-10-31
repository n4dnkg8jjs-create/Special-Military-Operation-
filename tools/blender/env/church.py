"""church_small for city.glb: a small Donbas parish church (late-19th-c. Russian-Revival type, rebuilt / restored in the
2000s), damaged by shelling. Material 0 = city_atlas (plinth / steps concrete, loose bricks, ground debris, glass shards),
material 1 = church_atlas (church_atlas.py) for everything else.

Plan (glTF space, +Z = west front / main entrance, origin on the ground at the footprint centre):
  bell tower over the entrance (3 tiers: chetverik with the portal, open arched belfry with bells, octagon + gilded onion)
  -> refectory / narthex (trapeznaya) -> square nave (chetverik) with 3 keel kokoshniks per face over a dentil cornice,
  hip roof, round drum with 8 arched windows carrying the big blue-with-gold-stars onion, 4 gilded corner cupolas on
  drums -> semicircular apse (east, -Z) with a half-cone roof. Standing-seam green sheet roofs with gutters and
  downpipes, pilasters, keel-arched window surrounds with dark glass, perspective portal with columns, gable canopy,
  icon and steps.
Damage: shell hole through the nave's south (+X) wall with exposed brick and rubble, shrapnel pocking on that side,
  part of the main dome's sheet skin torn off exposing the steel ribs (sheets hanging), dented / stripped gilding on
  the bell-tower onion and one cupola, one cupola cross shot off and lying on the ground, a burnt-out refectory window
  with a soot plume, broken glass, torn roof sheets.
"""
import math
import numpy as np
from meshlib import MB, Region, Fit, mat_trs, rot_axis, xform, newell, rng, blob
import church_atlas as CHA
from city_geo import wall, tquad, fbox, tube, sheet, chunk, loose_bricks
from shapely.geometry import Polygon, box as sbox
from shapely.ops import unary_union

PI = math.pi
CR = {k: Region(*v, S=CHA.S, pad=2) for k, v in CHA.REG.items()}
WALLR, POCK, BRICK, TRIM = CR['cp_wall'], CR['cp_pock'], CR['cp_brick'], CR['cp_trim']
TIN, GOLD, GOLDX, BLUE = CR['cp_tin'], CR['cp_gold'], CR['cp_gold_strip'], CR['cp_blue']
WIN, WINX, DOOR, ICONR = CR['cp_win'], CR['cp_win_broken'], CR['cp_door'], CR['cp_icon']
SOOT, STEEL, INNER, WOODR = CR['cp_soot'], CR['cp_steel'], CR['cp_inner'], CR['cp_wood']
ICON = ICONR.sub(0, 0.34, 1, 1)
BRONZE = ICONR.sub(0, 0, 1, 0.28)
BOARDS = WOODR.sub(0, 0.5, 1, 1)
CHAR = WOODR.sub(0, 0, 1, 0.5)
TILE = (2.0, 2.0)

# ---------------------------------------------------------------- dimensions (design space; shifted to centre at the end)
PL = 0.7                               # plinth height
NX, NZ0, NZ1, HN = 4.8, -3.75, 3.75, 8.0          # nave half-width, z range, cornice height
AR, HA = 3.0, 6.2                      # apse radius, wall height
RX, RZ0, RZ1, HR = 4.2, NZ1, 7.0, 5.8  # refectory
TX, TZ0, TZ1, HT1 = 2.3, RZ1, 11.5, 7.4            # bell tower tier 1
BX, HT2 = 1.95, 11.8                  # belfry half-width, top
TH = 0.6                               # wall thickness


def T(x=0.0, y=0.0, z=0.0):
    return mat_trs((x, y, z))


def frame(o, X, Y):
    X = np.asarray(X, float); Y = np.asarray(Y, float)
    X = X / np.linalg.norm(X); Y = Y / np.linalg.norm(Y); Z = np.cross(X, Y)
    M = np.eye(4); M[:3, 0] = X; M[:3, 1] = Y; M[:3, 2] = Z; M[:3, 3] = o
    return M


def face_M(face, x0, x1, z0, z1):
    """Matrix for a box face: local u = left->right seen from outside (centred), v = up (y), w = outward."""
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    if face == 'S':
        return mat_trs((cx, 0, z1)), x1 - x0
    if face == 'N':
        return mat_trs((cx, 0, z0), (0, PI, 0)), x1 - x0
    if face == 'E':
        return mat_trs((x1, 0, cz), (0, PI / 2, 0)), z1 - z0
    return mat_trs((x0, 0, cz), (0, -PI / 2, 0)), z1 - z0


def arch_pts(cx, y0, w, h, n=9):
    r = w / 2; ys = y0 + h - r
    P = [(cx - r, y0), (cx + r, y0)] + [(cx + r * math.cos(t), ys + r * math.sin(t)) for t in np.linspace(0, PI, n)]
    return np.array(P[:2] + P[2:])


def keel_pts(cx, y0, w, h, n=13, tip=0.3, foot=0.0):
    """Keel-arched (ogee-pointed) kokoshnik outline, CCW, base at y0."""
    P = [(cx - w / 2, y0), (cx + w / 2, y0)]
    if foot > 0:
        P.append((cx + w / 2, y0 + foot))
    hh = h - foot - tip
    for t in np.linspace(0, PI, n):
        c = math.cos(t)
        y = y0 + foot + hh * math.sin(t) ** 0.85 + tip * max(0.0, 1 - abs(c) / 0.32) ** 2
        P.append((cx + w / 2 * c, y))
    P.append((cx - w / 2, y0 + foot)) if foot > 0 else None
    out = []
    for p in P:
        if not out or np.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > 1e-4:
            out.append(p)
    if np.hypot(out[-1][0] - out[0][0], out[-1][1] - out[0][1]) < 1e-4:
        out.pop()
    return np.array(out)


def poly_local(mb, pts2, z, M, uvfn, flip=False):
    """Planar polygon from local 2D points at depth z; uvfn(x, y) -> uv (computed in local space)."""
    pts2 = np.asarray(pts2, float)
    if flip:
        pts2 = pts2[::-1]
    P = np.array([[p[0], p[1], z] for p in pts2])
    uv = [uvfn(p[0], p[1]) for p in pts2]
    mb.poly(xform(P, M), lambda P_, n_: uv)


def box_uv(reg, x0, y0, x1, y1):
    return lambda x, y: reg.uv((x - x0) / (x1 - x0), (y - y0) / (y1 - y0))


def plane_poly(mb, pts3, reg, tile=TILE, up=True):
    """Tiled planar polygon (3D points, first edge = texture u axis, e.g. a roof eave so seams run up the slope)."""
    P = np.asarray(pts3, float)
    n = newell(P)
    if up and n[1] < 0:
        P = np.concatenate([P[:2][::-1], P[2:][::-1]]) if len(P) > 3 else P[[1, 0, 2]]
        n = newell(P)
    X = P[1] - P[0]; X /= np.linalg.norm(X)
    N = n / np.linalg.norm(n); Y = np.cross(N, X)
    Mf = frame(P[0], X, Y)
    loc = [((p - P[0]) @ X, (p - P[0]) @ Y) for p in P]
    wall(mb, np.array(loc), 0.0, reg, tile, M=Mf, back=False, cap='none')


def reveal(mb, ring2, th, reg, M, tile=(1.0, 1.0)):
    """Side faces of a hole (ring CCW in local XY) through a slab of thickness th (front z=0, back z=-th)."""
    R = np.asarray(ring2, float)
    for i in range(len(R)):
        a, b = R[i], R[(i + 1) % len(R)]
        L = float(np.linalg.norm(b - a))
        if L < 1e-5:
            continue
        # hole interior is to the left of a CCW ring edge -> face normals point into the hole: quad a->b
        tquad(mb, (a[0], a[1], 0.0), (b[0] - a[0], b[1] - a[1], 0.0), (0, 0, -1), L, th, reg, tile, M=M)


# ---------------------------------------------------------------- profile sweeps (cornices, plinths, collars)
def offset_path(P, closed, d):
    P = np.asarray(P, float); n = len(P); out = []
    def nrm(a, b):
        t = b - a; t /= np.linalg.norm(t); return np.array([t[1], -t[0]])
    for i in range(n):
        if closed or 0 < i < n - 1:
            a, b, c = P[i - 1], P[i], P[(i + 1) % n]
            n1, n2 = nrm(a, b), nrm(b, c)
            m = n1 + n2; m /= np.linalg.norm(m)
            out.append(b + m * d / max(0.3, float(m @ n1)))
        elif i == 0:
            out.append(P[0] + nrm(P[0], P[1]) * d)
        else:
            out.append(P[-1] + nrm(P[-2], P[-1]) * d)
    return np.array(out)


def orient_out(P):
    """Closed (x, z) path -> orientation whose right-hand normal (t_z, -t_x) points outward."""
    P = np.asarray(P, float)
    a = 0.5 * np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1])
    # n = (tz, -tx) is the outward normal of a positive-area (x, z) loop
    return P if a > 0 else P[::-1]


def sweep(mb, P, closed, y, profile, reg, seg=1.6, tile=(2.0, 0.5)):
    """Sweep profile [(d_out, dy), ...] bottom->top along a path in (x, z) at base height y."""
    P = np.asarray(P, float)
    if closed:
        P = orient_out(P)
    rows = [offset_path(P, closed, d) for d, _ in profile]
    m = len(P) if closed else len(P) - 1
    for e in range(m):
        i0, i1 = e, (e + 1) % len(P)
        L = float(np.linalg.norm(P[i1] - P[i0])); ns = max(1, int(math.ceil(L / seg)))
        for j in range(len(profile) - 1):
            (d0, y0), (d1, y1) = profile[j], profile[j + 1]
            A0, B0, A1, B1 = rows[j][i0], rows[j][i1], rows[j + 1][i0], rows[j + 1][i1]
            for s in range(ns):
                f0, f1 = s / ns, (s + 1) / ns
                p00 = A0 + (B0 - A0) * f0; p01 = A0 + (B0 - A0) * f1
                p10 = A1 + (B1 - A1) * f0; p11 = A1 + (B1 - A1) * f1
                Q = np.array([(p00[0], y + y0, p00[1]), (p01[0], y + y0, p01[1]), (p11[0], y + y1, p11[1]), (p10[0], y + y1, p10[1])])
                if np.linalg.norm(newell(Q)) < 1e-9:
                    continue
                t = P[i1] - P[i0]; t /= np.linalg.norm(t); no = np.array([t[1], 0, -t[0]])
                exp = no * (y1 - y0) - np.array([0, 1.0, 0]) * (d1 - d0)
                if newell(Q) @ exp < 0:
                    Q = Q[::-1]
                l0 = L * f0; l1 = L * f1; v0 = 0.0; v1 = max(0.05, math.hypot(d1 - d0, y1 - y0))
                uv = [reg.uv((l0 % tile[0]) / tile[0], 0), reg.uv(min(1, (l0 % tile[0] + l1 - l0) / tile[0]), 0),
                      reg.uv(min(1, (l0 % tile[0] + l1 - l0) / tile[0]), v1 / tile[1]), reg.uv((l0 % tile[0]) / tile[0], v1 / tile[1])]
                mb.poly(Q, lambda P_, n_, uv=uv: uv)


def dentils(mb, P, closed, y, reg, size=(0.14, 0.16, 0.14), step=0.32, margin=0.25):
    """Row of dentil blocks (w, h, depth) hung under a cornice along a path (outer face at the path line)."""
    P = np.asarray(P, float)
    if closed:
        P = orient_out(P)
    m = len(P) if closed else len(P) - 1
    w, h, dp = size
    f = Fit(reg, (0.5, 0.5), 3)
    for e in range(m):
        a, b = P[e], P[(e + 1) % len(P)]
        L = float(np.linalg.norm(b - a))
        if L < 2 * margin + w:
            continue
        t = (b - a) / L; no = np.array([t[1], -t[0]])
        k = int((L - 2 * margin) // step)
        s0 = (L - k * step) / 2
        for i in range(k + 1):
            c = a + t * (s0 + i * step)
            Mf = frame((c[0], y, c[1]), (t[0], 0, t[1]), (0, 1, 0))      # local x along, y up, z = x * y
            # make local z the outward normal
            if np.array([Mf[0, 2], Mf[2, 2]]) @ no < 0:
                Mf = frame((c[0], y, c[1]), (-t[0], 0, -t[1]), (0, 1, 0))
            mb.box((-w / 2, -h, 0), (w / 2, 0, dp), f, faces='+x-x-y+z', M=Mf)


def circle(cx, cz, r, n, a0=0.0):
    return np.array([(cx + r * math.cos(a0 + 2 * PI * k / n), cz + r * math.sin(a0 + 2 * PI * k / n)) for k in range(n)])


# ---------------------------------------------------------------- lathe with per-face region / holes / flipping
def lathe2(mb, prof, segs, regfn, M=None, jitter=None, skip=None, flip=False, a0=0.0, around=1.0):
    prof = np.asarray(prof, float)
    L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(prof, axis=0), axis=1))]); L /= L[-1]
    tmp = MB()
    rings = []
    for i, (rr, y) in enumerate(prof):
        ring = []
        for k in range(segs):
            a = a0 + 2 * PI * k / segs
            j = jitter(i, k) if jitter else 1.0
            ring.append(tmp.v((rr * j * math.cos(a), y, rr * j * math.sin(a))))
        rings.append(ring)
    for i in range(len(prof) - 1):
        for k in range(segs):
            if skip and skip(i, k):
                continue
            rg = regfn(i, k) if callable(regfn) else regfn
            k2 = (k + 1) % segs
            ids = [rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2]]
            su0, su1 = (k / segs * around) % 1.0, (k / segs * around) % 1.0 + around / segs
            uvs = [rg.uv(su0, L[i]), rg.uv(su0, L[i + 1]), rg.uv(su1, L[i + 1]), rg.uv(su1, L[i])]
            if prof[i + 1][0] < 1e-6:
                ids = [ids[0], ids[1], ids[3]]; uvs = [uvs[0], uvs[1], uvs[3]]
            elif prof[i][0] < 1e-6:
                ids = [ids[0], ids[2], ids[3]]; uvs = [uvs[0], uvs[2], uvs[3]]
            if flip:
                ids = ids[::-1]; uvs = uvs[::-1]
            tmp.face(ids, uvs, True)
    mb.merge(tmp, M)
    return rings


ONION = [(0.92, 0.0), (1.0, 0.03), (1.12, 0.08), (1.26, 0.155), (1.37, 0.24), (1.42, 0.32), (1.40, 0.40), (1.30, 0.49),
         (1.13, 0.58), (0.90, 0.665), (0.64, 0.745), (0.42, 0.815), (0.26, 0.875), (0.15, 0.925), (0.09, 0.965), (0.07, 1.0)]


def orth_cross(mb, M, hc, reg=GOLD, th=None, bent=0.0):
    """Eight-pointed Orthodox cross in the local XY plane (bars along X, seen from +Z), base at local origin.
    Footrest slants up towards the viewer's left (-X)."""
    th = th or max(0.09, hc * 0.058)
    fbox(mb, (-th / 2, 0, -th / 2), (th / 2, hc, th / 2), reg, M=M)
    for yy, ww, rz in ((0.70, 0.50, 0.0), (0.875, 0.26, 0.0), (0.29, 0.30, -0.42)):
        Mb = M @ mat_trs((0, hc * yy, 0), (0, 0, rz + (bent if yy == 0.70 else 0.0)))
        fbox(mb, (-hc * ww / 2, -th * 0.45, -th * 0.45), (hc * ww / 2, th * 0.45, th * 0.45), reg, M=Mb)
    # small finials at the main bar ends
    for sx in (-1, 1):
        Mb = M @ mat_trs((sx * hc * 0.25, hc * 0.70, 0), (0, 0, bent))
        fbox(mb, (-th * 0.7, -th * 0.7, -th * 0.6), (th * 0.7, th * 0.7, th * 0.6), reg, M=Mb)


def onion_dome(mb, y0, r0, h, regfn, cx=0.0, cz=0.0, segs=20, cross=1.0, jitter=None, skip=None, tilt=None, inner=False, cross_bent=0.0):
    prof = [(r0 * a, h * b) for a, b in ONION]
    M = T(cx, y0, cz)
    if tilt is not None:
        M = M @ tilt
    lathe2(mb, prof, segs, regfn, M=M, jitter=jitter, skip=skip)
    if inner:
        lathe2(mb, [(r * 0.94, y) for r, y in prof], segs, CHAR, M=M, flip=True, skip=lambda i, k: i >= len(prof) - 4)
    # neck, apple, cross
    Mt = M @ T(0, h, 0)
    ra = max(0.08, r0 * 0.09)
    lathe2(mb, [(ra * 0.7, -0.05), (ra * 1.2, ra * 0.6), (ra * 1.25, ra * 1.2), (ra * 0.8, ra * 2.0), (ra * 0.5, ra * 2.4)], 8, GOLD, M=Mt)
    if cross:
        orth_cross(mb, Mt @ T(0, ra * 2.3, 0), cross, bent=cross_bent)


# ---------------------------------------------------------------- facade elements
def window(mb, M, cx, y0, w, h, broken=False, depth=0.3, hood=True, th=TH):
    """Glass + keel-arched surround for an arched opening already cut into a wall placed by M."""
    P = arch_pts(cx, y0, w, h, 9)
    poly_local(mb, P, -depth, M, box_uv(WINX if broken else WIN, cx - w / 2, y0, cx + w / 2, y0 + h))
    poly_local(mb, P, -depth - 0.005, M, box_uv(WINX, cx - w / 2, y0, cx + w / 2, y0 + h), flip=True)
    if hood:
        outer = keel_pts(cx, y0 - 0.02, w + 0.42, h + 0.42, 13, tip=0.18 + 0.05 * w, foot=h - w / 2 - 0.02)
        inner = arch_pts(cx, y0 - 0.02, w + 0.02, h + 0.02, 9)
        try:
            wall(mb, outer, 0.08, WALLR, (1, 1), holes=[inner], M=M @ T(0, 0, 0.08), back=False, cap='auto')
        except Exception:
            pass
    # sill
    fbox(mb, (cx - w / 2 - 0.22, y0 - 0.14, 0), (cx + w / 2 + 0.22, y0, 0.16), WALLR, faces='+x-x+y-y+z', M=M)


def pilasters(mb, M, L, xs, y0, y1, w=0.5, d=0.1, reg=WALLR, corner=True, cut=None):
    for x in xs:
        a, b = x - w / 2, x + w / 2
        if corner and abs(abs(x) - L / 2) < 1e-6:
            a, b = (x - w, x + d) if x > 0 else (x - d, x + w)
        if cut is not None and sbox(a, y0, b, y1).intersects(cut):
            g = sbox(a, y0, b, y1).difference(cut)
            for pg in (list(g.geoms) if hasattr(g, 'geoms') else [g]):
                if pg.area > 0.005:
                    wall(mb, np.array(pg.exterior.coords)[:-1], d, reg, (1, 1), M=M @ T(0, 0, d), back=False, cap='auto', side=BRICK)
            continue
        fbox(mb, (a, y0, 0), (b, y1, d), reg, faces='+x-x+z', M=M)


CORNICE = [(0.0, 0.0), (0.08, 0.0), (0.08, 0.12), (0.0, 0.14), (0.0, 0.34), (0.2, 0.34), (0.2, 0.42), (0.45, 0.48), (0.45, 0.6), (0.0, 0.66)]
CORNICE_S = [(0.0, 0.0), (0.07, 0.0), (0.07, 0.1), (0.0, 0.12), (0.0, 0.28), (0.18, 0.28), (0.3, 0.36), (0.3, 0.44), (0.0, 0.48)]
DENT, DENT_S = 0.34, 0.28        # dentil hang heights under CORNICE / CORNICE_S
PLINTH = [(0.12, 0.0), (0.12, PL - 0.1), (0.0, PL)]


def kokoshnik(mb, M, cx, y0, w, h, tip=0.35, depth=0.35):
    """Keel-arched gable slab standing on the cornice (front at local z=0.1), blue tympanum and a moulded band."""
    out = keel_pts(cx, y0, w, h, 15, tip=tip)
    wall(mb, out, depth, WALLR, TILE, M=M @ T(0, 0, 0.12), back=WALLR, side=TIN, cap='auto')
    inn = keel_pts(cx, y0 + 0.12, w - 0.5, h - 0.36, 13, tip=tip * 0.8)
    poly_local(mb, inn, 0.125, M, box_uv(TRIM, cx - w / 2, y0, cx + w / 2, y0 + h))
    band_o = keel_pts(cx, y0 + 0.12, w - 0.3, h - 0.2, 13, tip=tip * 0.85)
    try:
        wall(mb, band_o, 0.07, WALLR, (1, 1), holes=[inn], M=M @ T(0, 0, 0.19), back=False, cap='auto')
    except Exception:
        pass


def soot_quad(mb, M, cx, y0, w, h, z=0.012, holes=()):
    wall(mb, (cx - w / 2, y0, cx + w / 2, y0 + h), 0.0, SOOT, (w, h), holes=holes, M=M @ T(0, 0, z), back=False, org=(cx - w / 2, y0))


def bell(mb, cx, y, cz, s):
    prof = [(0.62, 0), (0.6, 0.07), (0.5, 0.22), (0.43, 0.45), (0.41, 0.7), (0.35, 0.86), (0.15, 0.93), (0.0, 0.95)]
    lathe2(mb, [(r * s, y + yy * s) for r, yy in prof], 12, BRONZE, M=T(cx, 0, cz))
    lathe2(mb, [(r * s * 0.97, y + yy * s) for r, yy in prof[:-2]], 12, STEEL, M=T(cx, 0, cz), flip=True)
    fbox(mb, (-0.04 * s, y + 0.95 * s, -0.12 * s), (0.04 * s, y + 1.12 * s, 0.12 * s), STEEL, M=T(cx, 0, cz))


# ---------------------------------------------------------------- the building
def church_small(name='church_small', seed=80):
    A = MB(name)          # city_atlas faces (material 0)
    C = MB(name + '_c')   # church_atlas faces (material 1)
    r = rng(seed)

    # ================= nave =================
    nbox = (-NX, NX, NZ0, NZ1)
    bays_side = [-2.5, 0.0, 2.5]                     # E/W faces (L = 7.5)
    bays_fb = [-3.2, 0.0, 3.2]                       # N/S faces (L = 9.6)
    lw, lh, ly = 1.0, 2.4, 2.5                       # lower windows
    uw, uh, uy = 0.66, 1.15, 5.85                    # upper windows
    hole_E = None
    for face in 'ESWN':
        M, L = face_M(face, *nbox)
        reg = POCK if face == 'E' else WALLR
        holes, wins = [], []
        if face in 'EW':
            for i, c in enumerate(bays_side):
                wins.append((c, ly, lw, lh, face == 'W' and i == 2)); wins.append((c, uy, uw, uh, face == 'E' and i == 1))
        elif face == 'N':
            for c in (-3.75, 3.75):
                wins.append((c, ly, 0.85, 2.2, False)); wins.append((c, uy, uw, uh, False))
        else:   # S: covered by the refectory below 7 m
            pass
        holes = [arch_pts(c, y, w, h) for c, y, w, h, _ in wins]
        if face == 'E':
            # shell hole merging with the front-bay lower window (front bay = left as seen from outside = u < 0)
            hb = blob(-2.3, 3.35, 1.3, 1.35, 24, seed + 2, rough=0.35, spikes=0.45)
            u = unary_union([Polygon(holes[0]), Polygon(hb).buffer(0)]).intersection(sbox(-3.55, PL + 0.3, 0.5, 6.4)).simplify(0.02)
            if hasattr(u, 'geoms'):
                u = max(u.geoms, key=lambda g: g.area)
            hole_E = np.array(u.exterior.coords)[:-1]
            wins = wins[1:]
            holes = [hole_E] + holes[1:]
        wall(C, (-L / 2, PL, L / 2, HN), 0.0, reg, TILE, holes=holes, M=M, back=False)
        # interior face (seen through holes): flip by building with a mirrored matrix
        Mi = M @ T(0, 0, -TH) @ mat_trs((0, 0, 0), (0, PI, 0))
        wall(C, (-L / 2, PL, L / 2, HN), 0.0, INNER, (3.0, 3.0), holes=[np.array([(-p[0], p[1]) for p in hh])[::-1] for hh in holes], M=Mi, back=False)
        for hh in holes:
            reveal(C, hh, TH, BRICK if (face == 'E' and hh is hole_E) else WALLR, M)
        for (c, y, w, h, broken) in wins:
            window(C, M, c, y, w, h, broken=broken)
        xs = ([-L / 2, L / 2] + ([-1.25, 1.25] if face in 'EW' else [-1.6, 1.6]))
        pilasters(C, M, L, xs, PL, HN, w=0.5 if face in 'EW' else 0.55, cut=Polygon(hole_E).buffer(0.06) if face == 'E' else None)
        if face == 'E':
            # spalled plaster ring around the shell hole (exposed brick) + scorch
            hp = Polygon(hole_E).buffer(0)
            hb2 = Polygon(blob(-2.3, 3.4, 1.85, 1.9, 22, seed + 1, rough=0.4, spikes=0.3)).buffer(0)
            ring = hb2.union(hp.buffer(0.35)).difference(hp)
            ring = ring.intersection(sbox(-L / 2 + 0.05, PL + 0.05, L / 2, HN - 0.1))
            geoms = list(ring.geoms) if hasattr(ring, 'geoms') else [ring]
            for g in geoms:
                if g.area < 0.01:
                    continue
                wall(C, np.array(g.exterior.coords)[:-1], 0.0, BRICK, (1.0, 1.0), holes=[np.array(x.coords)[:-1] for x in g.interiors],
                     M=M @ T(0, 0, 0.006), back=False)
            soot_quad(C, M, -2.3, 3.9, 3.0, 3.8, z=0.012, holes=[hole_E])
    # plinth, cornice, dentils
    nave_rect = [(-NX, NZ1), (NX, NZ1), (NX, NZ0), (-NX, NZ0)]
    sweep(A, nave_rect, True, 0.0, PLINTH, fit_reg('concrete'), tile=(2.0, 1.0))
    sweep(C, nave_rect, True, HN, CORNICE, WALLR)
    dentils(C, nave_rect, True, HN + DENT, WALLR)
    # kokoshniks over the cornice (3 per face)
    ytop = HN + 0.66
    for face in 'ESWN':
        M, L = face_M(face, *nbox)
        cs = bays_side if face in 'EW' else bays_fb
        for i, c in enumerate(cs):
            w = (2.3 if face in 'EW' else 2.9)
            hk = 2.3 if i == 1 else 1.7
            kokoshnik(C, M, c, ytop - 0.02, w, hk, tip=0.38 if i == 1 else 0.3)
    # nave hip roof from just inside the cornice up to the drum base
    yb = ytop - 0.05; yr = HN + 2.3
    e = 0.15
    c4 = [(-NX - e, yb, NZ1 + e), (NX + e, yb, NZ1 + e), (NX + e, yb, NZ0 - e), (-NX - e, yb, NZ0 - e)]
    t4 = [(-2.5, yr, 2.5), (2.5, yr, 2.5), (2.5, yr, -2.5), (-2.5, yr, -2.5)]
    for i in range(4):
        P = [c4[(i + 1) % 4], c4[i], t4[i], t4[(i + 1) % 4]]     # eave edge first
        plane_poly(C, P, TIN)
    plane_poly(C, [t4[1], t4[0], t4[3], t4[2]], TIN)
    # interior: floor + flat ceiling (seen through the shell hole / door)
    tquad(C, (-NX + TH, PL + 0.01, NZ1 - TH), (1, 0, 0), (0, 0, -1), 2 * (NX - TH), NZ1 - NZ0 - 2 * TH, BOARDS, (2.0, 2.0))
    tquad(C, (-NX + TH, HN - 0.2, NZ0 + TH), (1, 0, 0), (0, 0, 1), 2 * (NX - TH), NZ1 - NZ0 - 2 * TH, INNER, (3.0, 3.0))

    # ================= central drum + main dome =================
    DR, DY0, DY1, DS = 2.3, HN + 2.2, HN + 5.6, 16
    WY0, WH = DY0 + 0.65, 1.9
    for k in range(DS):
        a0, a1 = 2 * PI * k / DS, 2 * PI * (k + 1) / DS
        p0 = np.array([DR * math.cos(a0), DR * math.sin(a0)]); p1 = np.array([DR * math.cos(a1), DR * math.sin(a1)])
        Lf = float(np.linalg.norm(p1 - p0)); mid = (p0 + p1) / 2; nn = mid / np.linalg.norm(mid)
        # local u left->right seen from outside: from p1 to p0 (counter-clockwise in x,z seen from above is p0->p1)
        X = np.array([p0[0] - p1[0], 0, p0[1] - p1[1]]); Mf = frame((mid[0], 0, mid[1]), X, (0, 1, 0))
        if np.array([Mf[0, 2], Mf[2, 2]]) @ nn < 0:
            Mf = frame((mid[0], 0, mid[1]), -X, (0, 1, 0))
        holes = []
        if k % 2 == 0:
            holes = [arch_pts(0, WY0, 0.62, WH, 7)]
        wall(C, (-Lf / 2, DY0, Lf / 2, DY1), 0.0, WALLR, TILE, holes=holes, M=Mf, back=False)
        for hh in holes:
            reveal(C, hh, 0.45, WALLR, Mf)
            poly_local(C, hh, -0.3, Mf, box_uv(WINX if k in (0, 14) else WIN, -0.31, WY0, 0.31, WY0 + WH))
            fbox(C, (-0.4, WY0 - 0.13, 0), (0.4, WY0, 0.12), WALLR, faces='+x-x+y+z', M=Mf)
            # arched hood over the drum window
            try:
                wall(C, arch_pts(0, WY0 + WH - 0.5, 0.86, 0.64, 7), 0.07, WALLR, (1, 1), holes=[arch_pts(0, WY0 + WH - 0.52, 0.64, 0.54, 7)],
                     M=Mf @ T(0, 0, 0.07), back=False)
            except Exception:
                pass
        if k % 2 == 1:
            # slim engaged column between windows
            fbox(C, (-0.11, DY0, 0), (0.11, DY1, 0.14), WALLR, faces='+x-x+z', M=Mf)
            # blind recessed panel
            poly_local(C, arch_pts(0, WY0 + 0.1, 0.36, 1.6, 5), 0.004, Mf, box_uv(TRIM, -0.18, WY0 + 0.1, 0.18, WY0 + 1.7))
    dring = circle(0, 0, DR, DS)
    sweep(C, dring, True, DY0 + 0.0, [(0.12, 0.0), (0.12, 0.3), (0.0, 0.36)], WALLR, seg=3)
    sweep(C, dring, True, DY1 - 0.05, CORNICE_S, WALLR, seg=3)
    dentils(C, dring, True, DY1 - 0.05 + DENT_S, WALLR, size=(0.12, 0.14, 0.12), step=0.3, margin=0.08)
    # sheet-metal collar from the cornice to the dome neck
    yc = DY1 - 0.05 + 0.47
    lathe2(C, [(DR + 0.02, yc), (DR - 0.1, yc + 0.2), (1.9, yc + 0.45), (1.84, yc + 0.55)], 24, BLUE)
    OR, OH, oy = 2.0, 5.2, yc + 0.55
    # cap inside the drum top (seen through the torn dome skin)
    cp = circle(0, 0, 1.84, 16)[::-1]
    C.poly(np.array([(p[0], oy + 0.01, p[1]) for p in cp]) if newell(np.array([(p[0], 0, p[1]) for p in cp]))[1] > 0 else
           np.array([(p[0], oy + 0.01, p[1]) for p in cp[::-1]]), Fit(STEEL, (4, 4)))
    # damaged sector of the blue dome: torn skin (noise mask), exposed ribs/hoops, hanging sheets
    segs = 24
    hole_c = (-0.35, 0.47)    # (angle around Y, height fraction); +X side, slightly towards the back
    def dskip(i, k):
        a = 2 * PI * (k + 0.5) / segs; da = (a - hole_c[0] + PI) % (2 * PI) - PI
        hf = (ONION[i][1] + ONION[i + 1][1]) / 2
        nse = 0.12 * math.sin(k * 2.3 + i * 1.7) + 0.08 * math.cos(k * 5.1 - i * 3.3)
        return (da / 0.62) ** 2 + ((hf - hole_c[1]) / 0.2) ** 2 < 1.0 + nse * 3
    onion_dome(C, oy, OR, OH, BLUE, segs=segs, cross=2.9, skip=dskip, inner=True)
    prof = [(OR * a, OH * b) for a, b in ONION]
    for k in range(segs):
        a = 2 * PI * k / segs; da = (a - hole_c[0] + PI) % (2 * PI) - PI
        if abs(da) < 0.75:
            pts = [(rr * 0.975 * math.cos(a), oy + y, rr * 0.975 * math.sin(a)) for rr, y in prof[3:12]]
            tube(C, pts, 0.055, 4, STEEL, seg=10.0, smooth=False)
    for i in (4, 6, 8, 10):
        rr, y = prof[i]
        pts = [(rr * 0.97 * math.cos(hole_c[0] + t), oy + y, rr * 0.985 * math.sin(hole_c[0] + t)) for t in np.linspace(-0.62, 0.62, 7)]
        tube(C, pts, 0.04, 4, STEEL, seg=10.0, smooth=False)
    for j, (ang, hf, ln) in enumerate(((-0.65, 0.30, 1.1), (-0.1, 0.27, 0.8), (0.2, 0.34, 0.9))):
        i = int(np.searchsorted([b for _, b in ONION], hf))
        rr, y = prof[i]
        o = np.array([rr * math.cos(ang), oy + y, rr * math.sin(ang)])
        tang = np.array([-math.sin(ang), 0, math.cos(ang)]); outw = np.array([math.cos(ang), 0, math.sin(ang)])
        Mf = frame(o, tang, np.array([0, -1.0, 0]))
        sheet(C, 0.55, ln, 2, 3, BLUE, Mf @ T(-0.27, 0, 0), bend=lambda u, v, j=j: (0.05 * math.sin(u * 3 + j), 0, (0.25 + 0.1 * j) * v * v + 0.06 * v), double=True,
              uv_rect=(0.1, 0.1, 0.4, 0.7))

    # ================= corner cupolas =================
    cups = [(3.15, 2.2), (-3.15, 2.2), (3.15, -2.2), (-3.15, -2.2)]
    for ci, (cx, cz) in enumerate(cups):
        cr_, cy0, cy1 = 0.72, HN + 0.4, HN + 3.6
        ring = circle(cx, cz, cr_, 12)
        for k in range(12):
            a0, a1 = 2 * PI * k / 12, 2 * PI * (k + 1) / 12
            p0 = ring[k]; p1 = ring[(k + 1) % 12]
            Q = [(p1[0], cy0, p1[1]), (p0[0], cy0, p0[1]), (p0[0], cy1, p0[1]), (p1[0], cy1, p1[1])]
            Q = np.array(Q)
            if newell(Q) @ np.array([math.cos((a0 + a1) / 2), 0, math.sin((a0 + a1) / 2)]) < 0:
                Q = Q[::-1]
            rg = TRIM.sub(0.2, 0.1, 0.8, 0.9) if k % 3 == 1 else WALLR.sub(k / 12, 0, (k + 1) / 12, 1)
            C.poly(Q, lambda P_, n_, rg=rg: [rg.uv(0, 0), rg.uv(1, 0), rg.uv(1, 1), rg.uv(0, 1)])
        sweep(C, ring, True, cy1 - 0.02, [(0.0, 0.0), (0.12, 0.08), (0.12, 0.2), (0.0, 0.26)], WALLR, seg=3)
        lathe2(C, [(cr_ + 0.02, cy1 + 0.24), (0.63, cy1 + 0.42)], 12, GOLD, M=T(cx, 0, cz))
        jit = None; regfn = GOLD; crs = 1.25; bent = 0.0; tilt = None
        if ci == 0:     # front-right cupola: stripped gilding, cross shot off (stump only)
            regfn = lambda i, k: GOLDX if (1 <= k <= 6 and i <= 11) else GOLD
            jit = lambda i, k: 0.86 if (k in (2, 3) and 4 <= i <= 7) else 1.0
            crs = 0
        if ci == 3:
            bent = 0.25; tilt = rot_axis((1, 0, 0), 0.12)
        onion_dome(C, cy1 + 0.42, 0.68, 2.2, regfn, cx, cz, segs=14, cross=crs, jitter=jit, tilt=tilt, cross_bent=bent)
        if ci == 0:
            fbox(C, (-0.04, 0, -0.04), (0.04, 0.35, 0.04), STEEL, M=T(cx, cy1 + 0.42 + 2.2 + 0.18, cz) @ rot_axis((0, 0, 1), 0.3))

    # ================= apse =================
    AS = 9
    za = NZ0
    apts = [(AR * math.cos(PI + PI * k / AS), za + AR * math.sin(PI + PI * k / AS)) for k in range(AS + 1)]   # from -x round via -z to +x
    for k in range(AS):
        p0, p1 = np.array(apts[k]), np.array(apts[k + 1])
        Lf = float(np.linalg.norm(p1 - p0)); mid = (p0 + p1) / 2; nn = (mid - np.array([0, za])); nn /= np.linalg.norm(nn)
        X = np.array([p0[0] - p1[0], 0, p0[1] - p1[1]]); Mf = frame((mid[0], 0, mid[1]), X, (0, 1, 0))
        if np.array([Mf[0, 2], Mf[2, 2]]) @ nn < 0:
            Mf = frame((mid[0], 0, mid[1]), -X, (0, 1, 0))
        holes = [arch_pts(0, 2.4, 0.8, 2.2, 7)] if k in (1, 4, 7) else []
        wall(C, (-Lf / 2, PL, Lf / 2, HA), 0.0, WALLR, TILE, holes=holes, M=Mf, back=False)
        for hh in holes:
            reveal(C, hh, TH, WALLR, Mf)
            window(C, Mf, 0, 2.4, 0.8, 2.2, broken=(k == 7), hood=False)
            # small keel hood
            wall(C, keel_pts(0, 2.38, 1.12, 2.62, 11, tip=0.2, foot=1.8), 0.07, WALLR, (1, 1), holes=[arch_pts(0, 2.38, 0.82, 2.22, 7)], M=Mf @ T(0, 0, 0.07), back=False)
        if k in (2, 3, 5, 6):
            fbox(C, (-0.13, PL, 0), (0.13, HA, 0.12), WALLR, faces='+x-x+z', M=Mf @ T(Lf / 2 if k in (2, 5) else -Lf / 2, 0, 0))
    sweep(A, apts, False, 0.0, PLINTH, fit_reg('concrete'), tile=(2.0, 1.0))
    sweep(C, apts, False, HA, CORNICE_S, WALLR, seg=3)
    dentils(C, apts, False, HA + DENT_S, WALLR, size=(0.12, 0.14, 0.12), step=0.3, margin=0.1)
    # half-cone roof up to the nave wall
    ar = [(p[0] * (AR + 0.32) / AR, za + (p[1] - za) * (AR + 0.32) / AR) for p in apts]
    apex = (0, HN - 0.1, za)
    for k in range(AS):
        P = [(ar[k + 1][0], HA + 0.4, ar[k + 1][1]), (ar[k][0], HA + 0.4, ar[k][1]), apex]
        plane_poly(C, P, TIN)

    # ================= refectory =================
    rbox = (-RX, RX, RZ0, RZ1)
    for face in 'EWS':
        M, L = face_M(face, *rbox)
        reg = POCK if face == 'E' else WALLR
        wins = []
        if face in 'EW':
            for i, c in enumerate((-0.9, 0.9)):
                wins.append((c, 2.2, 0.95, 2.2, face == 'W' and i == 0))
        else:
            for c in (-3.25, 3.25):
                wins.append((c, 2.4, 0.7, 1.7, False))
        holes = [arch_pts(c, y, w, h) for c, y, w, h, _ in wins]
        if face == 'S':
            outline = [(-L / 2, PL), (L / 2, PL), (L / 2, HR), (-L / 2, HR)]
        else:
            outline = (-L / 2, PL, L / 2, HR)
        wall(C, outline, 0.0, reg, TILE, holes=holes, M=M, back=False)
        Mi = M @ T(0, 0, -TH) @ mat_trs((0, 0, 0), (0, PI, 0))
        wall(C, (-L / 2, PL, L / 2, HR), 0.0, INNER, (3.0, 3.0), holes=[np.array([(-p[0], p[1]) for p in hh])[::-1] for hh in holes], M=Mi, back=False)
        for hh in holes:
            reveal(C, hh, TH, WALLR, M)
        for (c, y, w, h, broken) in wins:
            window(C, M, c, y, w, h, broken=broken)
            if broken:
                soot_quad(C, M, c, y + h - 1.0, 2.3, 3.3, holes=[arch_pts(c, y, w, h)])
                tquad(C, (c - 0.4, y + 0.02, -0.25), (1, 0, 0), (0, 1, 0), 0.8, 0.02, CHAR, (1, 1), M=M)
        pilasters(C, M, L, [-L / 2, L / 2] if face != 'S' else [-L / 2, L / 2], PL, HR, w=0.5)
    rrect = [(RX, RZ0), (RX, RZ1), (-RX, RZ1), (-RX, RZ0)]
    sweep(A, rrect, False, 0.0, PLINTH, fit_reg('concrete'), tile=(2.0, 1.0))
    sweep(C, rrect, False, HR, CORNICE_S, WALLR, seg=2)
    dentils(C, rrect, False, HR + DENT_S, WALLR, size=(0.12, 0.14, 0.12), step=0.3, margin=0.2)
    # roof: two side slopes + front hip (back abuts the nave wall), gutters + downpipes
    ye, yrr, ov = HR + 0.5, HR + 1.7, 0.42
    zr1 = RZ1 - 1.0
    plane_poly(C, [(RX + ov, ye, RZ0), (RX + ov, ye, RZ1 + ov), (0, yrr, zr1), (0, yrr, RZ0)], TIN)
    plane_poly(C, [(-RX - ov, ye, RZ1 + ov), (-RX - ov, ye, RZ0), (0, yrr, RZ0), (0, yrr, zr1)], TIN)
    plane_poly(C, [(-RX - ov, ye, RZ1 + ov), (RX + ov, ye, RZ1 + ov), (0, yrr, zr1)], TIN)
    tquad(C, (-RX + TH, PL + 0.01, RZ1 - TH), (1, 0, 0), (0, 0, -1), 2 * (RX - TH), RZ1 - RZ0 - TH, BOARDS, (2.0, 2.0))
    tquad(C, (-RX + TH, HR - 0.1, RZ0), (1, 0, 0), (0, 0, 1), 2 * (RX - TH), RZ1 - RZ0 - TH, INNER, (3.0, 3.0))
    for sx in (-1, 1):
        tube(C, [(sx * (RX + ov), ye - 0.06, RZ0 + 0.05), (sx * (RX + ov), ye - 0.06, RZ1 + ov)], 0.08, 6, TIN, seg=2.0)
        if sx > 0:
            # torn downpipe hanging off the shelled side
            tube(C, [(RX + ov, ye - 0.06, RZ1 + ov - 0.2), (RX + 0.12, ye - 0.5, RZ1 + ov - 0.2), (RX + 0.12, 2.6, RZ1 + ov - 0.2), (RX + 0.6, 1.4, RZ1 + ov + 0.1)], 0.055, 6, TIN, seg=2.0)
        else:
            tube(C, [(-RX - ov, ye - 0.06, RZ1 + ov - 0.2), (-RX - 0.12, ye - 0.5, RZ1 + ov - 0.2), (-RX - 0.12, 0.35, RZ1 + ov - 0.2), (-RX - 0.4, 0.08, RZ1 + ov - 0.2)], 0.055, 6, TIN, seg=2.0)

    # ================= bell tower =================
    tbox_ = (-TX, TX, TZ0, TZ1)
    DW, DH = 1.6, 3.0
    for face in 'ESWN':
        M, L = face_M(face, *tbox_)
        y0 = PL if face != 'N' else HR + 0.6
        holes = []
        if face == 'S':
            holes = [arch_pts(0, PL, DW, DH)]
        elif face in 'EW':
            holes = [arch_pts(0.6 if face == 'E' else -0.6, 2.8, 0.7, 1.6), arch_pts(0, HT1 - 2.6, 0.6, 1.3)]
        reg = POCK if face == 'E' else WALLR
        wall(C, (-L / 2, y0, L / 2, HT1), 0.0, reg, TILE, holes=holes, M=M, back=False)
        Mi = M @ T(0, 0, -TH) @ mat_trs((0, 0, 0), (0, PI, 0))
        wall(C, (-L / 2, y0, L / 2, HT1), 0.0, INNER, (3.0, 3.0), holes=[np.array([(-p[0], p[1]) for p in hh])[::-1] for hh in holes], M=Mi, back=False)
        for hh in holes:
            reveal(C, hh, TH, WALLR, M)
        if face in 'EW':
            window(C, M, 0.6 if face == 'E' else -0.6, 2.8, 0.7, 1.6, broken=(face == 'E'))
            window(C, M, 0, HT1 - 2.6, 0.6, 1.3)
        pilasters(C, M, L, [-L / 2, L / 2], y0, HT1, w=0.45)
    trect = [(-TX, TZ1), (TX, TZ1), (TX, TZ0), (-TX, TZ0)]
    sweep(A, [(TX, TZ0), (TX, TZ1), (-TX, TZ1), (-TX, TZ0)], False, 0.0, PLINTH, fit_reg('concrete'), tile=(2.0, 1.0))
    sweep(C, trect, True, HT1, CORNICE, WALLR, seg=2)
    dentils(C, trect, True, HT1 + DENT, WALLR)
    # sloped sheet ledge from the tier-1 cornice to the belfry wall
    tzc = (TZ0 + TZ1) / 2
    c4 = [(-TX - 0.05, HT1 + 0.6, TZ1 + 0.05), (TX + 0.05, HT1 + 0.6, TZ1 + 0.05), (TX + 0.05, HT1 + 0.6, TZ0 - 0.05), (-TX - 0.05, HT1 + 0.6, TZ0 - 0.05)]
    t4 = [(-BX, HT1 + 0.95, tzc + BX), (BX, HT1 + 0.95, tzc + BX), (BX, HT1 + 0.95, tzc - BX), (-BX, HT1 + 0.95, tzc - BX)]
    for i in range(4):
        plane_poly(C, [c4[(i + 1) % 4], c4[i], t4[i], t4[(i + 1) % 4]], TIN)
    # door leaves, perspective portal (3 stepped arched bands), interior of the vestibule
    M, L = face_M('S', *tbox_)
    poly_local(C, arch_pts(0, PL, DW, DH), -0.42, M, box_uv(DOOR, -DW / 2, PL, DW / 2, PL + DH))
    for k in range(3):
        wo, ho = DW + 0.36 + 0.3 * k, DH + 0.24 + 0.17 * k
        wi, hi = DW + 0.02 + 0.3 * k, DH + 0.02 + 0.15 * k
        wall(C, arch_pts(0, PL, wo, ho, 11), 0.11, WALLR, (1, 1), holes=[arch_pts(0, PL, wi, hi, 11)], M=M @ T(0, 0, 0.11 * (3 - k)), back=False)
    # porch: columns, beams, gable canopy with a kokoshnik front and the icon, platform and steps
    pz1 = TZ1 + 1.35
    for sx in (-1, 1):
        x = sx * 1.35
        fbox(C, (x - 0.24, PL, pz1 - 0.5), (x + 0.24, PL + 0.6, pz1 - 0.02), WALLR, faces='+x-x+y+z-z')
        tube(C, [(x, PL + 0.6, pz1 - 0.26), (x, 3.55, pz1 - 0.26)], 0.15, 8, WALLR, seg=2.0)
        lathe2(C, [(0.15, 3.55), (0.22, 3.62), (0.25, 3.75)], 8, WALLR, M=T(x, 0, pz1 - 0.26))
        fbox(C, (x - 0.22, 3.75, TZ1), (x + 0.22, 4.0, pz1), WALLR, faces='+x-x+y-y+z')
    fbox(C, (-1.6, 3.75, pz1 - 0.44), (1.6, 4.0, pz1), WALLR, faces='+y-y+z')
    kM = mat_trs((0, 0, pz1))
    kokoshnik(C, kM @ T(0, 0, -0.12), 0, 3.98, 3.3, 1.75, tip=0.35, depth=0.25)
    poly_local(C, arch_pts(0, 4.12, 1.0, 1.25, 9), 0.02, kM, box_uv(ICON, -0.5, 4.12, 0.5, 5.37))
    ycr = 5.55
    plane_poly(C, [(1.75, 3.98, TZ1), (1.75, 3.98, pz1 - 0.1), (0, ycr, pz1 - 0.1), (0, ycr, TZ1)], TIN)
    plane_poly(C, [(-1.75, 3.98, pz1 - 0.1), (-1.75, 3.98, TZ1), (0, ycr, TZ1), (0, ycr, pz1 - 0.1)], TIN)
    tquad(C, (-1.6, 3.74, TZ1), (1, 0, 0), (0, 0, 1), 3.2, pz1 - TZ1 - 0.44, INNER, (2, 2))
    # platform + steps (concrete)
    con = fit_reg('concrete')
    A_box(A, (-1.9, 0, TZ1), (1.9, PL, pz1 + 0.15), con)
    for s in range(3):
        hs = PL * (2 - s) / 3
        A_box(A, (-1.7, 0, pz1 + 0.15 + s * 0.34), (1.7, hs, pz1 + 0.15 + (s + 1) * 0.34), con)
    # --- tier 2: open belfry
    yb0 = HT1 + 0.62
    bbox_ = (-BX, BX, (TZ0 + TZ1) / 2 - BX, (TZ0 + TZ1) / 2 + BX)
    tzc = (TZ0 + TZ1) / 2
    for face in 'ESWN':
        M, L = face_M(face, *bbox_)
        op = arch_pts(0, yb0 + 0.45, 2.0, 2.65, 11)
        wall(C, (-L / 2, yb0, L / 2, HT2), 0.0, POCK if face == 'E' else WALLR, TILE, holes=[op], M=M, back=False)
        Mi = M @ T(0, 0, -0.5) @ mat_trs((0, 0, 0), (0, PI, 0))
        wall(C, (-L / 2, yb0, L / 2, HT2), 0.0, WALLR, TILE, holes=[np.array([(-p[0], p[1]) for p in op])[::-1]], M=Mi, back=False)
        reveal(C, op, 0.5, WALLR, M)
        wall(C, arch_pts(0, yb0 + 0.43, 2.36, 2.85, 11), 0.08, WALLR, (1, 1), holes=[arch_pts(0, yb0 + 0.43, 2.02, 2.67, 11)], M=M @ T(0, 0, 0.08), back=False)
        pilasters(C, M, L, [-L / 2, L / 2], yb0, HT2, w=0.4)
        # balustrade bar across the opening
        fbox(C, (-1.0, yb0 + 0.45, -0.32), (1.0, yb0 + 1.25, -0.18), WALLR, faces='+y+z-z', M=M)
    sweep(C, [(-BX, tzc + BX), (BX, tzc + BX), (BX, tzc - BX), (-BX, tzc - BX)], True, HT2, CORNICE_S, WALLR, seg=2)
    dentils(C, [(-BX, tzc + BX), (BX, tzc + BX), (BX, tzc - BX), (-BX, tzc - BX)], True, HT2 + DENT_S, WALLR,
            size=(0.12, 0.14, 0.12), step=0.3, margin=0.15)
    tquad(C, (-BX + 0.5, yb0 + 0.01, tzc + BX - 0.5), (1, 0, 0), (0, 0, -1), 2 * BX - 1.0, 2 * BX - 1.0, BOARDS, (2, 2))
    tquad(C, (-BX + 0.5, HT2 - 0.05, tzc - BX + 0.5), (1, 0, 0), (0, 0, 1), 2 * BX - 1.0, 2 * BX - 1.0, CHAR, (2, 2))
    # bells on a beam
    fbox(C, (-BX + 0.4, HT2 - 0.75, tzc - 0.1), (BX - 0.4, HT2 - 0.55, tzc + 0.1), CHAR)
    bell(C, 0, HT2 - 1.95, tzc, 1.2)
    for bx_, s_ in ((-0.95, 0.55), (0.9, 0.48), (0.45, 0.36)):
        bell(C, bx_, HT2 - 0.55 - 0.95 * s_ - 0.08, tzc + (0.05 if bx_ < 0.4 else -0.05), s_)
    # small kokoshnik on each belfry face
    for face in 'ESWN':
        M, L = face_M(face, *bbox_)
        kokoshnik(C, M, 0, HT2 + 0.46, 2.3, 1.25, tip=0.28, depth=0.3)
    # belfry roof skirt -> octagonal drum -> gilded onion (dented, partly stripped) + cross
    ys0 = HT2 + 0.46
    c4 = [(-BX - 0.3, ys0, tzc + BX + 0.3), (BX + 0.3, ys0, tzc + BX + 0.3), (BX + 0.3, ys0, tzc - BX - 0.3), (-BX - 0.3, ys0, tzc - BX - 0.3)]
    t4 = [(-1.0, ys0 + 0.95, tzc + 1.0), (1.0, ys0 + 0.95, tzc + 1.0), (1.0, ys0 + 0.95, tzc - 1.0), (-1.0, ys0 + 0.95, tzc - 1.0)]
    for i in range(4):
        plane_poly(C, [c4[(i + 1) % 4], c4[i], t4[i], t4[(i + 1) % 4]], TIN)
    oct_ = circle(0, tzc, 1.05, 8, PI / 8)
    oy0, oy1 = ys0 + 0.6, ys0 + 2.0
    for k in range(8):
        p0, p1 = oct_[k], oct_[(k + 1) % 8]
        mid = (p0 + p1) / 2; nn = (mid - np.array([0, tzc])); nn /= np.linalg.norm(nn)
        X = np.array([p0[0] - p1[0], 0, p0[1] - p1[1]]); Mf = frame((mid[0], 0, mid[1]), X, (0, 1, 0))
        if np.array([Mf[0, 2], Mf[2, 2]]) @ nn < 0:
            Mf = frame((mid[0], 0, mid[1]), -X, (0, 1, 0))
        Lf = float(np.linalg.norm(p1 - p0))
        wall(C, (-Lf / 2, oy0, Lf / 2, oy1), 0.0, WALLR, TILE, M=Mf, back=False)
        poly_local(C, arch_pts(0, oy0 + 0.3, 0.4, 0.95, 5), 0.004, Mf, box_uv(TRIM, -0.2, oy0 + 0.3, 0.2, oy0 + 1.25))
    sweep(C, oct_, True, oy1 - 0.02, [(0.0, 0.0), (0.12, 0.08), (0.12, 0.2), (0.0, 0.25)], WALLR, seg=3)
    lathe2(C, [(1.2, oy1 + 0.23), (0.9, oy1 + 0.45)], 16, GOLD, M=T(0, 0, tzc))
    tj = lambda i, k: 1.0 - (0.14 if (k in (4, 5, 6) and 3 <= i <= 6) else 0.0) - (0.08 if (k == 11 and 5 <= i <= 7) else 0.0)
    onion_dome(C, oy1 + 0.45, 0.95, 2.7, lambda i, k: GOLDX if (3 <= k <= 7 and 2 <= i <= 10) or (k == 8 and 4 <= i <= 7) else GOLD, 0, tzc, segs=16, cross=1.5, jitter=tj,
               tilt=rot_axis((0, 0, 1), 0.05))

    # ================= damage dressing =================
    # rubble below the shell hole (outside + inside), plaster chunks, bricks, shards of glass
    hx_, hz_ = NX, 0.0 + 2.35     # world position of the hole centre (E face, u=-2.35 -> z=+2.35)
    loose_bricks(A, NX + 1.2, hz_, 1.3, 70, 'red', seed)
    loose_bricks(A, NX - 1.4, hz_, 0.9, 30, 'red', seed + 1, y0=PL)
    for k in range(14):
        chunk(C, (NX + r.uniform(0.3, 2.2), 0.12, hz_ + r.uniform(-1.4, 1.4)), (r.uniform(0.3, 0.6), r.uniform(0.15, 0.35), r.uniform(0.3, 0.5)), seed + 40 + k, WALLR if k % 3 else BRICK)
    for k in range(6):
        chunk(C, (NX - 1.0 - r.uniform(0, 1.8), PL + 0.12, hz_ + r.uniform(-1.2, 1.2)), (0.45, 0.25, 0.4), seed + 70 + k, BRICK if k % 2 else WALLR)
    # a charred floor beam fallen through the hole
    fbox(C, (-0.11, -0.11, -1.6), (0.11, 0.11, 1.6), CHAR, M=mat_trs((NX - 1.1, PL + 0.5, hz_ - 0.3), (0.25, 0.6, 0.2)))
    gl = Fit(fit_reg('glass_dark'), (0.5, 0.5))
    for k in range(18):
        x_, z_ = (NX + r.uniform(0.2, 1.6), r.uniform(-3, 3)) if k < 12 else (-RX - r.uniform(0.2, 1.2), RZ0 + 1.0 + r.uniform(-0.8, 0.8))
        a_ = r.uniform(0, 2 * PI); s_ = r.uniform(0.08, 0.2)
        P = np.array([(x_ + math.cos(a_) * s_, 0.02, z_ + math.sin(a_) * s_), (x_ + math.cos(a_ + 2.3) * s_, 0.02, z_ + math.sin(a_ + 2.3) * s_),
                      (x_ + math.cos(a_ + 4.1) * s_ * 0.6, 0.02, z_ + math.sin(a_ + 4.1) * s_ * 0.6)])
        if newell(P)[1] < 0:
            P = P[::-1]
        A.poly(P, gl)
    # torn roof sheets curling up on the nave roof (shelled side) and one blown onto the ground
    for j, (zc_, ang) in enumerate(((1.6, 0.0), (0.4, 0.3))):
        o = np.array([NX - 0.6, yb + 0.55, zc_])
        Mf = frame(o, (0, 0, -1), (-0.86, 0.5, 0))
        sheet(C, 0.5, 1.4, 1, 4, TIN, Mf @ T(0, 0, 0.02), bend=lambda u, v, j=j: (0, 0, 0.9 * v * v + 0.1 * j), double=True, uv_rect=(0, 0, 0.25, 0.7))
    sheet(C, 0.5, 2.0, 1, 3, TIN, mat_trs((NX + 2.3, 0.05, -1.6), (-PI / 2, 0.6, 0)), bend=lambda u, v: (0, 0, 0.15 * math.sin(v * 3)), double=True, uv_rect=(0, 0, 0.25, 1))
    # the shot-off cupola cross lying on the ground beside the rubble (bent main bar)
    Mx = mat_trs((NX + 2.0, 0.06, 0.2), (-PI / 2, 0.9, 0)) @ T(0, -0.6, 0)
    orth_cross(C, Mx, 1.25, bent=0.35)
    lathe2(C, [(0.0, -0.02), (0.1, 0.05), (0.12, 0.12), (0.06, 0.2)], 8, GOLD, M=mat_trs((NX + 2.0 - 0.55, 0.06, 0.2 + 0.4)) @ rot_axis((1, 0, 0), 1.4))

    # ---------------------------------------------------------------- merge (church atlas -> material 1), centre the footprint
    C.F = [(idx, uv, sm, 1) for idx, uv, sm, mt in C.F]
    A.merge(C)
    mn, mx = A.bounds()
    cx, cz = (-NX - 0.5 + NX + 0.5) / 2, (NZ0 - AR - 0.35 + pz1 + 0.15 + 3 * 0.34) / 2
    A.transform(T(-cx, 0, -cz))
    return A


def fit_reg(name):
    import city_geo as G
    return G.R[name]


def A_box(mb, mn, mx, reg):
    from city_geo import tbox
    tbox(mb, mn, mx, reg, (1.0, 1.0), faces='+x-x+y+z-z')
