"""T-72B3 (RU: Kontakt-5 hull/turret ERA, Sosna-U, 2A46M-5, cope cage, ERA skirts) and
T-72AV-style (UA: Kontakt-1 bricks, L-4 IR searchlight, 902B launchers).

Reference data (sources in assets/vehicles/manifest.json):
  hull 6.86 m, 9.53 m gun forward, width 3.46 m over tracks / ~3.6-3.78 m with skirts/ERA,
  turret roof 2.23 m, ground clearance 0.49 m, track 0.58 m wide on 2.79 m centres, 6 x 750 mm
  rubber-tyred double road wheels, 3 return rollers, rear drive sprocket, front idler, ~97 links.
Authoring frame: X right, Y forward, Z up.
"""
import sys, os, math, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
import numpy as np
from mathutils import Vector as V, Matrix
from mathutils.bvhtree import BVHTree
import vlib as L
from vlib import B, box, hull, prism, lathe, cyl, tube, rail, bolt, fillet_path
import vtex as T
import vbuild as VB
from btr import periscope_block, hatch_rect, louvre_panel, headlight_cluster, tow_hook, tow_cable, antenna_base

TRK_X = 1.395                   # track centre line
TRK_W = 0.58
RW_R = 0.375
RW_Z = 0.435
RW_Y = [2.10, 1.27, 0.44, -0.39, -1.22, -2.09]
IDL = (2.86, 0.60, 0.30)        # y, z, r
SPR = (-2.97, 0.66, 0.335)
RR_Y = [1.68, 0.0, -1.66]
RR_Z, RR_R = 0.84, 0.115
BAND = 0.06                      # track thickness (inner face to ground face)
BELLY = 0.49
DECK = 1.47
SUP_X = 1.30                     # superstructure half width
LOW_X = 1.07                     # lower hull side plates
FEN_Z = 1.07                     # fender height
FEN_X = 1.74
NOSE = (3.38, 0.98)              # y, z of the glacis nose edge
GL_TOP = (2.06, DECK)
TUR_Y = 0.30                     # turret ring centre
GUN_Z = DECK + 0.37

# ================================================================================================ helpers
def glacis_pt(x, t, off=0.0):
    """t in [0,1] from nose to top of upper glacis."""
    y = NOSE[0] + (GL_TOP[0] - NOSE[0]) * t
    z = NOSE[1] + (GL_TOP[1] - NOSE[1]) * t
    n = glacis_n()
    return V((x, y, z)) + n * off

def glacis_n():
    d = V((0, GL_TOP[0] - NOSE[0], GL_TOP[1] - NOSE[1])).normalized()
    return V((0, d.z, -d.y))

def glacis_frame():
    """right-handed: local x = -X, y = up the slope, z = outward normal."""
    return L.frame_from_normal(glacis_n(), V((0, 0, 1)))

def era_block(sx, sy, sz, bev=0.008, bolts=True, mat='era'):
    b = box(sx, sy, sz, mat=mat)
    b.bevel(bev, 1, 30)
    if bolts:
        for x in (-sx / 2 + 0.03, sx / 2 - 0.03):
            for y in (-sy / 2 + 0.03, sy / 2 - 0.03):
                b.add(bolt(0.009, 0.006, 6, mat), Matrix.Translation((x, y, sz / 2)))
    return b

def k1_brick():
    """Kontakt-1 4S20 container 252x131x69 mm on its bracket (local +Z out)."""
    b = box(0.252, 0.131, 0.069, c=(0, 0, 0.07), mat='era').bevel(0.01, 1, 30)
    b.add(box(0.2, 0.02, 0.06, c=(0, 0.03, 0.02), mat='era'))
    b.add(box(0.2, 0.02, 0.06, c=(0, -0.03, 0.02), mat='era'))
    b.add(bolt(0.012, 0.008, 6, 'era'), Matrix.Translation((0.0, 0.0, 0.105)))
    return b

def surface_project(bvh, origin, direction):
    hit = bvh.ray_cast(V(origin), V(direction).normalized())
    return hit  # (loc, normal, index, dist)

bvh_of = L.bvh_of

# ================================================================================================ running gear
def road_wheel():
    """T-72 750 mm double road wheel (aluminium, rubber tyres), axis X, outward +X, origin at hub centre."""
    segs = 30
    def disc(sign):
        # sign: +1 outer disc (x>0 half), -1 inner disc
        prof = [(0.0, 0.215), (0.06, 0.212), (0.09, 0.2), (0.11, 0.17), (0.15, 0.155), (0.25, 0.14),
                (0.29, 0.15), (0.305, 0.17, 'tyre'), (0.33, 0.175, 'tyre'), (0.36, 0.17, 'tyre'), (0.374, 0.155, 'tyre'),
                (0.376, 0.12, 'tyre'), (0.374, 0.085, 'tyre'), (0.36, 0.072, 'tyre'), (0.33, 0.07, 'tyre'), (0.305, 0.075),
                (0.27, 0.06), (0.2, 0.055), (0.12, 0.05), (0.08, 0.045), (0.0, 0.045)]
        pr = []
        for p in prof:
            m = p[2] if len(p) > 2 else 'rim'
            pr.append((p[0], p[1] * sign, m))
        if sign < 0:
            pr = pr[::-1]
            # materials are attached to the start vertex of each band: shift by one
            pr = [(pr[i][0], pr[i][1], pr[i + 1][2] if i + 1 < len(pr) else 'rim') for i in range(len(pr))]
        return lathe(pr, segs, 'x', mat='rim', cap=False)
    w = disc(1)
    w.add(disc(-1))
    # radial ribs on outer disc face
    for i in range(8):
        a = math.tau * i / 8 + math.pi / 8
        r = box(0.012, 0.13, 0.03, c=(0, 0.19, 0), mat='rim').bevel(0.004, 1)
        r.rot('X', 0).move(0.155, 0, 0)
        r.rot('X', math.degrees(a))
        w.add(r)
    # hub cap with bolts
    w.add(lathe([(0, 0.0), (0.085, 0.0), (0.085, 0.03), (0.06, 0.05), (0.0, 0.055)], 16, 'x', mat='rim', c=(0.21, 0, 0)))
    for i in range(8):
        a = math.tau * i / 8
        w.add(bolt(0.011, 0.012, 6, 'rim').rot('Y', 90), Matrix.Translation((0.212, 0.115 * math.cos(a), 0.115 * math.sin(a))))
    return w

def sprocket():
    """Rear drive sprocket: two 12-tooth rings + hub, axis X, outward +X."""
    w = B(mat='rim')
    nt = 12
    for xo in (0.07, -0.07):
        bm = bmesh.new()
        pts = []
        for i in range(nt * 4):
            a = math.tau * i / (nt * 4)
            k = i % 4
            r = 0.36 if k in (1, 2) else 0.30
            pts.append((r * math.cos(a), r * math.sin(a)))
        ring = prism(pts, 0.035, 'x', mat='rim', c=xo).bevel(0.006, 1, 30)
        w.add(ring)
    w.add(lathe([(0.0, 0.16), (0.12, 0.16), (0.16, 0.13), (0.2, 0.09), (0.28, 0.085), (0.29, 0.05), (0.29, -0.05), (0.28, -0.085),
                 (0.16, -0.1), (0.0, -0.1)], 28, 'x', mat='rim'))
    for i in range(10):
        a = math.tau * i / 10
        w.add(bolt(0.013, 0.014, 6, 'rim').rot('Y', 90), Matrix.Translation((0.16, 0.13 * math.cos(a), 0.13 * math.sin(a))))
    for i in range(6):
        a = math.tau * i / 6
        w.add(box(0.02, 0.02, 0.12, c=(0.11, 0.2 * math.cos(a), 0.2 * math.sin(a)), mat='rim').rot('X', math.degrees(a) + 90, (0.11, 0.2 * math.cos(a), 0.2 * math.sin(a))))
    return w

def idler():
    w = B(mat='rim')
    for xo in (0.075, -0.075):
        w.add(lathe([(0.0, xo - 0.05 * np.sign(xo) * -1), (0.12, xo + 0.02 * np.sign(xo)), (0.24, xo + 0.01 * np.sign(xo)),
                     (0.28, xo + 0.03 * np.sign(xo)), (0.30, xo + 0.03 * np.sign(xo)), (0.30, xo - 0.03 * np.sign(xo)),
                     (0.27, xo - 0.03 * np.sign(xo)), (0.0, xo - 0.035 * np.sign(xo))], 32, 'x', mat='rim'))
    # lightening holes suggested by recessed bosses
    for i in range(6):
        a = math.tau * i / 6
        w.add(cyl(0.05, 0.01, 12, 'x', c=(0.11, 0.17 * math.cos(a), 0.17 * math.sin(a)), mat='gunmetal'))
    w.add(lathe([(0, 0.0), (0.07, 0.0), (0.07, 0.05), (0.04, 0.07), (0, 0.07)], 14, 'x', mat='rim', c=(0.1, 0, 0)))
    return w

def track_path():
    """Inner-surface centreline of the track loop in (y, z), CCW seen from +X.  Returns resampled points."""
    circles = [(y, RW_Z, RW_R) for y in RW_Y] + [IDL, SPR] + [(y, RR_Z, RR_R) for y in RR_Y]
    pts = []
    for (cy, cz, r) in circles:
        for i in range(72):
            a = math.tau * i / 72
            pts.append((cy + r * math.cos(a), cz + r * math.sin(a)))
    pts = np.array(pts)
    # convex hull (monotone chain)
    P = sorted(map(tuple, pts))
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in P:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(P):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hullp = lower[:-1] + upper[:-1]          # CCW
    # resample uniformly
    poly = np.array(hullp + [hullp[0]])
    seg = np.linalg.norm(np.diff(poly, axis=0), axis=1)
    Ltot = seg.sum()
    n = int(Ltot / 0.05)
    s = np.linspace(0, Ltot, n, endpoint=False)
    cum = np.concatenate([[0], np.cumsum(seg)])
    out = []
    for si in s:
        k = np.searchsorted(cum, si, side='right') - 1
        t = (si - cum[k]) / seg[k]
        out.append(poly[k] * (1 - t) + poly[k + 1] * t)
    out = np.array(out)
    # top run sag between return rollers / sprocket / idler
    tops = sorted([SPR[0]] + RR_Y + [IDL[0]])
    for i in range(len(out)):
        y, z = out[i]
        if z > 0.9:
            for a, b_ in zip(tops[:-1], tops[1:]):
                if a < y < b_:
                    t = (y - a) / (b_ - a)
                    out[i, 1] -= 0.035 * math.sin(math.pi * t) * (1.0 if (b_ - a) > 1.2 else 0.6)
    # simplify straight bottom/top runs: keep every point where curvature or every 4th on straights
    keep = []
    for i in range(len(out)):
        p0, p1, p2 = out[i - 1], out[i], out[(i + 1) % len(out)]
        d1 = p1 - p0; d2 = p2 - p1
        ang = abs(math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1.dot(d2)))
        if ang > 0.004 or i % 6 == 0:
            keep.append(p1)
    return np.array(keep)

def track_band(side):
    """Closed track band with cross-section profile, UV U = link index (scrolls), V across the profile."""
    path = track_path()
    n = len(path)
    seg = np.linalg.norm(np.roll(path, -1, 0) - path, axis=1)
    Ltot = seg.sum()
    links = 97
    pitch = Ltot / links
    # outward normals (CCW polygon in (y,z) -> outward = rotate tangent clockwise)
    tang = np.roll(path, -1, 0) - np.roll(path, 1, 0)
    tang /= np.linalg.norm(tang, axis=1, keepdims=True)
    nrm = np.stack([tang[:, 1], -tang[:, 0]], 1)
    hw = TRK_W / 2
    # profile (x across, d outward), V coordinate
    prof = [(-hw, BAND, 0.0), (-0.12, BAND + 0.0, 0.2), (0.12, BAND + 0.0, 0.3), (hw, BAND, 0.42), (hw, 0.0, 0.47),
            (0.05, 0.0, 0.62), (0.05, -0.075, 0.68), (-0.05, -0.075, 0.76), (-0.05, 0.0, 0.82), (-hw, 0.0, 0.97), (-hw, BAND, 1.0)]
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    rows = []
    cum = np.concatenate([[0], np.cumsum(seg)])
    for i in range(n + 1):
        k = i % n
        y, z = path[k]
        ny, nz = nrm[k]
        row = []
        for (x, d, v) in prof:
            row.append(bm.verts.new((side * TRK_X + x * side, y + ny * d, z + nz * d)))
        rows.append(row)
    for i in range(n):
        u0 = cum[i] / pitch
        u1 = cum[i + 1] / pitch
        for j in range(len(prof) - 1):
            a, b_ = rows[i][j], rows[i][j + 1]
            c, d = rows[i + 1][j + 1], rows[i + 1][j]
            f = bm.faces.new((a, b_, c, d) if side > 0 else (a, d, c, b_))
            f.material_index = L.SI['track']
            f.smooth = True
            uvs = {a: (u0, prof[j][2]), b_: (u0, prof[j + 1][2]), c: (u1, prof[j + 1][2]), d: (u1, prof[j][2])}
            for lp in f.loops:
                lp[uv].uv = uvs[lp.vert]
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    b = B.__new__(B); b.bm = bm
    return b, pitch, Ltot

# ================================================================================================ hull
def hull_body(variant):
    pts = []
    for s in (1, -1):
        pts += [(s * LOW_X, -3.16, BELLY), (s * LOW_X, 2.92, BELLY), (s * LOW_X, NOSE[0], NOSE[1] - 0.04),
                (s * LOW_X, -3.4, 0.64),
                (s * LOW_X, -3.3, FEN_Z), (s * LOW_X, NOSE[0] - 0.02, FEN_Z - 0.02)]
    lower = hull(pts, bev=0.02, segs=2)
    up = []
    for s in (1, -1):
        up += [(s * SUP_X, NOSE[0], NOSE[1]), (s * SUP_X, NOSE[0] - 0.05, NOSE[1] - 0.1),
               (s * SUP_X, GL_TOP[0], GL_TOP[1]), (s * SUP_X, -3.27, DECK - 0.02),
               (s * SUP_X, -3.36, FEN_Z), (s * SUP_X, 2.6, FEN_Z)]
    upper = hull(up, bev=0.022, segs=2)
    H = lower.add(upper)
    # fenders (sheet steel) left/right with front mudguard sloping down
    for s in (1, -1):
        f = prism([(-3.34, FEN_Z), (3.0, FEN_Z), (3.34, FEN_Z - 0.16), (3.38, FEN_Z - 0.2), (3.3, FEN_Z - 0.2),
                   (2.98, FEN_Z - 0.012), (-3.34, FEN_Z - 0.012)], FEN_X - SUP_X + 0.02, 'x', c=s * (SUP_X + FEN_X) / 2)
        f.bevel(0.004, 1, 30)
        H.add(f)
        # fender support brackets
        for y in (-2.4, -1.0, 0.4, 1.8):
            H.add(box(0.012, 0.06, 0.12, c=(s * (FEN_X - 0.02), y, FEN_Z - 0.07)))
        # front mud flap (rubber)
        H.add(box(0.5, 0.012, 0.22, c=(s * TRK_X, 3.36, FEN_Z - 0.32), mat='skirt', bev=0.004, segs=1))
    # weld seams
    for s in (1, -1):
        H.add(tube([(s * SUP_X, GL_TOP[0] - 0.01, DECK - 0.005), (s * SUP_X, -3.25, DECK - 0.025)], 0.007, 5))
        H.add(tube([(s * SUP_X, NOSE[0] - 0.01, NOSE[1] + 0.005), (s * SUP_X, GL_TOP[0] - 0.01, GL_TOP[1])], 0.007, 5))
        H.add(tube([(s * LOW_X, -3.3, FEN_Z - 0.01), (s * LOW_X, 2.6, FEN_Z - 0.01)], 0.007, 5))
    H.add(tube([(-SUP_X, GL_TOP[0], DECK + 0.003), (SUP_X, GL_TOP[0], DECK + 0.003)], 0.008, 5))
    H.add(tube([(-SUP_X, NOSE[0] + 0.005, NOSE[1]), (SUP_X, NOSE[0] + 0.005, NOSE[1])], 0.009, 5))
    # ---- suspension: torsion arms + return roller stubs, bump stops, shock absorbers
    for s in (1, -1):
        for i, y in enumerate(RW_Y):
            d = 1 if i < 3 else -1           # arms trail toward the hull centre
            hub = V((s * (TRK_X - 0.24), y, RW_Z))
            piv = V((s * (LOW_X + 0.02), y + 0.33 * d, RW_Z + 0.16))
            H.add(tube([piv, hub], 0.05, 8, 'rim'))
            H.add(cyl(0.085, 0.07, 12, 'x', c=tuple(piv), mat='rim'))
            H.add(box(0.06, 0.12, 0.09, c=(s * (LOW_X + 0.03), y + 0.12 * d, RW_Z + 0.36), mat='rolled'))
        for y in RR_Y:
            H.add(cyl(0.05, 0.16, 10, 'x', c=(s * (LOW_X + 0.08), y, RR_Z)))
        for i in (0, 1, 5):
            y = RW_Y[i]
            H.add(tube([(s * (LOW_X + 0.1), y + (0.3 if i < 3 else -0.3), RW_Z + 0.42), (s * (LOW_X + 0.12), y, RW_Z + 0.12)], 0.035, 8, 'gunmetal'))
        # final drive housing + idler crank
        H.add(cyl(0.2, 0.18, 20, 'x', c=(s * (LOW_X + 0.07), SPR[0], SPR[1]), bev=0.015))
        H.add(cyl(0.12, 0.2, 16, 'x', c=(s * (LOW_X + 0.08), IDL[0] - 0.05, IDL[1] + 0.02), bev=0.01))
        H.add(box(0.07, 0.35, 0.1, c=(s * (LOW_X + 0.08), IDL[0] - 0.22, IDL[1] + 0.05), mat='rolled', bev=0.01, segs=1).rot('X', -20, (0, IDL[0] - 0.22, IDL[1] + 0.05)))
    # return rollers (static, part of hull)
    for s in (1, -1):
        for y in RR_Y:
            H.add(lathe([(0.0, -0.11), (RR_R - 0.01, -0.11, 'tyre'), (RR_R, -0.09, 'tyre'), (RR_R, 0.09, 'tyre'), (RR_R - 0.01, 0.11), (0.05, 0.12), (0.0, 0.13)],
                        18, 'x', mat='rim', c=(s * TRK_X, y, RR_Z)))
    return H

def glacis_era_k5():
    """Kontakt-5 package on the upper glacis (T-72B3): two rows of bolted cover modules + top step."""
    G = B()
    M = glacis_frame()
    w_tot = 2 * SUP_X - 0.12
    cols = 6
    cw = w_tot / cols
    for r, (t0, t1) in enumerate(((0.06, 0.42), (0.44, 0.8))):
        for c in range(cols):
            x = -w_tot / 2 + cw * (c + 0.5)
            if r == 1 and abs(x) < cw * 0.6:
                continue    # driver's vision cut-out
            Lg = (t1 - t0) * (V((0, GL_TOP[0] - NOSE[0], GL_TOP[1] - NOSE[1])).length)
            blk = era_block(cw - 0.03, Lg - 0.03, 0.13)
            p = glacis_pt(x, (t0 + t1) / 2, 0.07)
            G.add(blk, L.place(M.to_3x3().to_4x4(), p))
    # upper step box near the top of glacis with central notch
    for s in (1, -1):
        p = glacis_pt(s * 0.75, 0.9, 0.05)
        G.add(era_block(0.95, 0.18, 0.1, bolts=False), L.place(M.to_3x3().to_4x4(), p))
    # V splash-board in front of the driver
    G.add(box(0.7, 0.03, 0.12, mat='rolled', bev=0.006, segs=1).rot('Z', 20).move(-0.18, 0, 0), L.place(M.to_3x3().to_4x4(), glacis_pt(0, 0.62, 0.06)))
    G.add(box(0.7, 0.03, 0.12, mat='rolled', bev=0.006, segs=1).rot('Z', -20).move(0.18, 0, 0), L.place(M.to_3x3().to_4x4(), glacis_pt(0, 0.62, 0.06)))
    return G

def glacis_era_k1():
    """Kontakt-1 bricks on the glacis: staggered rows."""
    G = B()
    M = glacis_frame()
    brick = k1_brick().to_mesh('_k1')
    rows = 6
    for r in range(rows):
        t = 0.08 + r * 0.14
        n = 8 if r % 2 == 0 else 7
        for c in range(n):
            x = (c - (n - 1) / 2) * 0.3
            if r >= 4 and abs(x) < 0.25:
                continue
            p = glacis_pt(x, t, 0.0)
            G.add_mesh(brick, L.place(M.to_3x3().to_4x4() @ Matrix.Rotation(math.radians(-12), 4, 'X'), p))
    bpy.data.meshes.remove(brick)
    return G

def hull_details(variant, H):
    is_b3 = variant == 't72b3'
    M = glacis_frame()
    # driver's hatch + periscope at top centre of glacis / deck
    H.add(lathe([(0, 0.05), (0.24, 0.045), (0.27, 0.02), (0.28, 0.0)], 24, 'z', c=(0, 1.86, DECK)))
    H.add(periscope_block(0.22, 0.1, 0.08), Matrix.Translation((0, 2.08, DECK - 0.02)))
    if is_b3:
        H.add(glacis_era_k5())
    else:
        H.add(glacis_era_k1())
    # lower glacis: dozer blade folded
    lg_n = V((0, 0.85, -0.53)).normalized()
    pz = (NOSE[1] + BELLY) / 2 + 0.03
    py = (NOSE[0] + 2.92) / 2 + 0.06
    db = prism([(-1.0, -0.26), (1.0, -0.26), (1.04, 0.24), (-1.04, 0.24)], 0.03, 'z', c=0.015, bev=0.008, segs=1)
    for x in (-0.7, -0.25, 0.25, 0.7):
        db.add(box(0.04, 0.46, 0.06, c=(x, 0, 0.045), bev=0.006, segs=1))
    db.add(box(2.0, 0.05, 0.06, c=(0, 0.2, 0.045), bev=0.006, segs=1))
    Mb = L.frame_from_normal(lg_n, V((0, 0, 1)))
    H.add(db, L.place(Mb, V((0, py, pz)) + lg_n * 0.02))
    # tow hooks at nose
    for s in (1, -1):
        H.add(tow_hook().rot('X', -10), Matrix.Translation((s * 0.75, NOSE[0] + 0.02, NOSE[1] - 0.12)))
    # headlight groups on the front fenders
    for s in (1, -1):
        H.add(headlight_cluster(s), Matrix.Translation((s * 1.5, 3.0, FEN_Z - 0.01)))
    # deck: engine louvres, hatches, turret ring guard
    H.add(lathe([(1.12, 0), (1.17, 0), (1.17, 0.04), (1.1, 0.06)], 48, 'z', c=(0, TUR_Y, DECK)))
    H.add(louvre_panel(1.3, 0.75, 8), Matrix.Translation((0, -1.65, DECK)))
    H.add(louvre_panel(2.2, 0.55, 7), Matrix.Translation((0, -2.85, DECK - 0.02)))
    for s in (1, -1):
        H.add(louvre_panel(0.5, 0.8, 8), Matrix.Translation((s * 0.92, -2.15, DECK)))
        H.add(hatch_rect(0.5, 0.75, t=0.025, c=(s * 0.92, -1.25, DECK), hinge='y+', rad=0.03))
    H.add(hatch_rect(0.6, 0.6, t=0.03, c=(0, -2.25, DECK), hinge='y-', rad=0.04))
    # fender stowage: right = fuel tanks (3) + box; left = boxes + fuel tank
    for s in (1, -1):
        x0 = s * (SUP_X + FEN_X) / 2
        wb = FEN_X - SUP_X - 0.04
        items = ([(-2.9, -2.1, 'box'), (-2.0, -1.0, 'tank'), (-0.9, 0.2, 'tank'), (0.3, 1.4, 'tank'), (1.5, 2.6, 'box')] if s > 0 else
                 [(-2.9, -2.4, 'exh'), (-2.3, -1.3, 'tank'), (-1.2, -0.1, 'box'), (0.0, 1.2, 'box'), (1.3, 2.6, 'box')])
        for (ya, yb, kind) in items:
            yc = (ya + yb) / 2; ln = yb - ya - 0.04
            hgt = 0.38
            if kind == 'tank':
                tk = hull([(x0 - wb / 2, ya + 0.02, FEN_Z), (x0 + wb / 2, ya + 0.02, FEN_Z), (x0 - wb / 2, yb - 0.02, FEN_Z), (x0 + wb / 2, yb - 0.02, FEN_Z),
                           (x0 - wb / 2, ya + 0.02, FEN_Z + hgt), (x0 + wb / 2 - s * 0.0, ya + 0.02, FEN_Z + hgt - 0.0),
                           (x0 - wb / 2, yb - 0.02, FEN_Z + hgt), (x0 + wb / 2, yb - 0.02, FEN_Z + hgt)], bev=0.035, segs=3)
                for yy in (ya + 0.2, yb - 0.2):
                    tk.add(box(wb + 0.02, 0.04, 0.01, c=(x0, yy, FEN_Z + hgt + 0.004), mat='rolled'))
                    tk.add(box(0.01, 0.04, hgt, c=(x0 + s * (wb / 2 + 0.004), yy, FEN_Z + hgt / 2), mat='rolled'))
                tk.add(cyl(0.05, 0.03, 12, 'z', c=(x0, yc, FEN_Z + hgt + 0.015)))
                H.add(tk)
            elif kind == 'box':
                bx = box(wb, ln, hgt - 0.05, c=(x0, yc, FEN_Z + (hgt - 0.05) / 2), bev=0.012, segs=2)
                bx.add(box(wb + 0.02, ln + 0.02, 0.03, c=(x0, yc, FEN_Z + hgt - 0.05), bev=0.006, segs=1))
                for yy in (ya + 0.15, yb - 0.15):
                    bx.add(box(0.03, 0.05, 0.06, c=(x0 + s * (wb / 2 + 0.01), yy, FEN_Z + hgt - 0.08)))
                bx.add(rail([(x0 + s * (wb / 2), yc - 0.1, FEN_Z + 0.18), (x0 + s * (wb / 2 + 0.05), yc - 0.1, FEN_Z + 0.18),
                             (x0 + s * (wb / 2 + 0.05), yc + 0.1, FEN_Z + 0.18), (x0 + s * (wb / 2), yc + 0.1, FEN_Z + 0.18)], r=0.009, rad=0.02))
                H.add(bx)
            elif kind == 'exh':
                ex = box(wb, ln, 0.2, c=(x0, yc, FEN_Z + 0.1), bev=0.012, segs=1)
                for i in range(5):
                    ex.add(box(0.012, ln - 0.06, 0.02, c=(x0 + s * (wb / 2 + 0.005), yc, FEN_Z + 0.04 + i * 0.033), mat='gunmetal'))
                H.add(ex)
    # tow cables along left fender top edge
    H.add(tow_cable((-(SUP_X + 0.06), 1.6, FEN_Z + 0.4), (-(SUP_X + 0.06), -1.4, FEN_Z + 0.4), 0.0))
    # rear: plate fittings, lights, tow hooks, fuel drums + unditching log
    for s in (1, -1):
        H.add(tow_hook().rot('Z', 180), Matrix.Translation((s * 0.8, -3.4, 0.75)))
        rl = box(0.14, 0.05, 0.08, c=(s * 1.1, -3.32, DECK - 0.12), bev=0.008, segs=1)
        rl.add(box(0.1, 0.01, 0.05, c=(s * 1.1, -3.35, DECK - 0.12), mat='light'))
        H.add(rl)
    for s in (1, -1):
        # 200 l drums on brackets (transverse), on the rear plate
        dc = (s * 0.62, -3.68, 1.16)
        dr = lathe([(0.0, -0.44), (0.27, -0.44), (0.29, -0.43), (0.29, -0.3), (0.3, -0.29), (0.3, -0.27), (0.29, -0.26), (0.29, 0.26),
                    (0.3, 0.27), (0.3, 0.29), (0.29, 0.3), (0.29, 0.43), (0.27, 0.44), (0.0, 0.44)], 28, 'x', c=dc)
        dr.add(cyl(0.03, 0.03, 10, 'x', c=(dc[0] + s * 0.45, dc[1] + 0.1, dc[2] + 0.12)))
        H.add(dr)
        for x in (dc[0] - 0.3, dc[0] + 0.3):
            H.add(box(0.05, 0.38, 0.04, c=(x, -3.5, 0.86), bev=0.006, segs=1))
            H.add(tube(fillet_path([(x, -3.38, 0.86), (x, -3.62, 0.86), (x, -3.98, 1.1), (x, -3.85, 1.45), (x, -3.4, 1.45)], 0.12, 3), 0.012, 6, 'bare'))
    # unditching log above drums
    log = lathe([(0.0, -1.7), (0.13, -1.7), (0.14, -1.6), (0.15, 0.0), (0.14, 1.6), (0.13, 1.7), (0.0, 1.7)], 14, 'x', mat='wood', c=(0, -3.62, 1.6))
    H.add(log)
    for x in (-1.2, 1.2):
        H.add(box(0.06, 0.08, 0.32, c=(x, -3.42, 1.48)))
        H.add(lathe([(0.145, -0.025), (0.155, -0.025), (0.155, 0.025), (0.145, 0.025)], 14, 'x', c=(x, -3.62, 1.6), mat='bare', cap=False))
    # spare track links on the glacis sides/turret? (B3 keeps them on the hull rear plate)
    for s in (1, -1):
        for i in range(2):
            H.add(box(0.5, 0.05, 0.14, c=(s * 1.0, -3.33, 0.95 + i * 0.16), mat='gunmetal', bev=0.01, segs=1))
    # antenna bases on the deck rear
    return H

def side_skirts(variant):
    """Rubber-fabric side skirts hanging from the fender edge; ERA on the forward panels."""
    S = B(mat='skirt')
    is_b3 = variant == 't72b3'
    segs_y = np.linspace(-3.2, 3.15, 9)
    z0, z1 = FEN_Z + 0.01, 0.6
    for s in (1, -1):
        x = s * (FEN_X + 0.006)
        for i in range(len(segs_y) - 1):
            ya, yb = segs_y[i] + 0.01, segs_y[i + 1] - 0.01
            bot = z1 if i < len(segs_y) - 2 else z1 + 0.1
            S.add(box(0.012, yb - ya, z0 - bot, c=(x, (ya + yb) / 2, (z0 + bot) / 2), mat='skirt', bev=0.004, segs=1))
            # fixing strip
            S.add(box(0.02, yb - ya, 0.04, c=(x + s * 0.008, (ya + yb) / 2, z0 - 0.03), mat='rolled'))
            for yy in np.linspace(ya + 0.08, yb - 0.08, 3):
                S.add(bolt(0.012, 0.008, 6, 'rolled').rot('Y', 90 * s), Matrix.Translation((x + s * 0.018, yy, z0 - 0.03)))
            # ERA on forward panels
            if i >= len(segs_y) - 5:
                if is_b3:
                    # 4S22-style flat boxes
                    for r in range(2):
                        S.add(era_block(0.18, (yb - ya) - 0.06, 0.07, bolts=True).rot('Y', 90 if s > 0 else -90),
                              Matrix.Translation((x + s * 0.05, (ya + yb) / 2, z0 - 0.15 - r * 0.2)))
                else:
                    brick = k1_brick()
                    for r in range(2):
                        for c in range(2):
                            b2 = L._bcopy(brick)
                            b2.rot('Z', 90).rot('Y', 90 * s)
                            S.add(b2, Matrix.Translation((x + s * 0.0, ya + 0.2 + c * 0.38, z0 - 0.15 - r * 0.19)))
    return S

# ================================================================================================ turret
def turret_shell(variant):
    """Cast turret dome built from lofted superellipse rings, origin at ring centre on deck."""
    rings = [(0.0, 1.0), (0.12, 1.0), (0.3, 0.97), (0.48, 0.88), (0.62, 0.74), (0.7, 0.6)]
    bm = bmesh.new()
    seg = 40
    allr = []
    for (hz, sc) in rings:
        ring = []
        for i in range(seg):
            t = math.tau * i / seg
            c, s_ = math.cos(t), math.sin(t)
            n = 2.6
            ax = 1.18
            by = 1.32 if s_ > 0 else 1.22
            x = ax * np.sign(c) * abs(c) ** (2 / n)
            y = by * np.sign(s_) * abs(s_) ** (2 / n)
            # flatten the rear a bit, roof slopes down toward the rear
            hz2 = hz - (0.06 * max(0, -s_) * (hz / 0.6))
            ring.append(bm.verts.new((x * sc, y * sc, hz2)))
        allr.append(ring)
    for k in range(len(allr) - 1):
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new((allr[k][i], allr[k][j], allr[k + 1][j], allr[k + 1][i]))
    bm.faces.new(allr[0][::-1])
    bm.faces.new(allr[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    t = B(bm, 'cast')
    t.subsurf(1)
    return t

def turret_b3():
    T_ = turret_shell('b3')
    bv = bvh_of(T_)
    # --- Kontakt-5 turret wedges (each side of the gun): thick boxes forming a forward V in plan
    for s in (1, -1):
        p = [(s * 0.27, 1.64, 0.08), (s * 0.27, 1.55, 0.64), (s * 1.22, 0.96, 0.08), (s * 1.17, 0.9, 0.5),
             (s * 0.27, 0.95, 0.1), (s * 0.27, 0.86, 0.68), (s * 1.22, 0.25, 0.1), (s * 1.14, 0.3, 0.54)]
        wd = hull(p, mat='era', bev=0.02, segs=2)
        wb = bvh_of(wd)
        # top cover-plate seams and bolt rows, projected onto the wedge top
        for k in range(1, 4):
            f = k / 4
            a = V((s * (0.27 + 0.9 * f), 1.6 - 0.66 * f, 1.0)); b_ = V((s * (0.27 + 0.9 * f), 0.9 - 0.62 * f, 1.0))
            for t in np.linspace(0.08, 0.92, 4):
                q = a.lerp(b_, t)
                hit = wb.ray_cast(q, V((0, 0, -1)))
                if hit[0] is not None:
                    wd.add(bolt(0.013, 0.01, 6, 'era'), L.place(L.frame_from_normal(hit[1]), hit[0]))
            hs = [wb.ray_cast(a.lerp(b_, t), V((0, 0, -1)))[0] for t in (0.03, 0.97)]
            if hs[0] is not None and hs[1] is not None:
                wd.add(tube([hs[0] + V((0, 0, 0.004)), hs[1] + V((0, 0, 0.004))], 0.008, 4, 'era'))
        # lifting eye on top
        wd.add(lathe([(0.03, -0.012), (0.05, -0.012), (0.05, 0.012), (0.03, 0.012)], 12, 'x', mat='era', cap=False).move(s * 0.6, 0.95, 0.66))
        T_.add(wd)
    # roof K-5 tiles
    M = Matrix.Identity(4)
    for s in (1, -1):
        for k in range(2):
            T_.add(era_block(0.38, 0.32, 0.06), Matrix.Translation((s * (0.35 + k * 0.4), 0.45, 0.6)))
    # gun mantlet slot frame
    T_.add(box(0.5, 0.25, 0.4, c=(0, 1.3, 0.34), mat='cast', bev=0.04, segs=2))
    # --- Sosna-U armoured box (gunner side, left of the gun)
    so = box(0.42, 0.46, 0.34, c=(-0.62, 0.55, 0.78), bev=0.025, segs=2)
    so.add(box(0.36, 0.04, 0.22, c=(-0.62, 0.8, 0.78), bev=0.01, segs=1))
    so.add(box(0.12, 0.012, 0.09, c=(-0.7, 0.822, 0.8), mat='glass'))
    so.add(box(0.1, 0.012, 0.09, c=(-0.53, 0.822, 0.8), mat='glass'))
    for x in (-0.82, -0.42):
        so.add(cyl(0.02, 0.36, 8, 'z', c=(x, 0.83, 0.78)))     # shutter hinges
    so.add(box(0.48, 0.06, 0.03, c=(-0.62, 0.84, 0.94)))       # rain brow
    so.add(box(0.3, 0.3, 0.2, c=(-0.62, 0.45, 0.62)))          # pedestal
    T_.add(so)
    # 1A40 day sight head + gunner hatch
    T_.add(box(0.2, 0.2, 0.22, c=(-0.3, 0.42, 0.7), bev=0.02, segs=2))
    T_.add(box(0.14, 0.012, 0.08, c=(-0.3, 0.525, 0.74), mat='glass'))
    T_.add(lathe([(0, 0.05), (0.26, 0.045), (0.3, 0.02), (0.31, 0.0)], 24, 'z', c=(-0.5, -0.12, 0.6)))
    T_.add(periscope_block(0.15, 0.09, 0.06), Matrix.Translation((-0.5, 0.2, 0.6)))
    # --- commander's cupola (right) with Kord 12.7 mm
    cu = lathe([(0, 0.0), (0.42, 0.0), (0.42, 0.06), (0.38, 0.14), (0.34, 0.16), (0.0, 0.16)], 32, 'z', c=(0.5, -0.12, 0.58))
    cu.add(lathe([(0, 0.05), (0.27, 0.045), (0.31, 0.02), (0.32, 0.0)], 24, 'z', c=(0.5, -0.12, 0.74)))
    for ang in (60, 90, 120):
        a = math.radians(ang)
        cu.add(periscope_block(0.14, 0.08, 0.06), Matrix.Translation((0.5 + 0.36 * math.cos(a), -0.12 + 0.36 * math.sin(a), 0.68)) @ Matrix.Rotation(a - math.pi / 2, 4, 'Z'))
    cu.add(box(0.26, 0.2, 0.2, c=(0.5, 0.2, 0.78), bev=0.02, segs=2))      # TKN-3 / PK-PAN head
    cu.add(box(0.18, 0.012, 0.08, c=(0.5, 0.305, 0.8), mat='glass'))
    # Kord on pintle
    cu.add(cyl(0.03, 0.25, 8, 'z', c=(0.78, -0.3, 0.86), mat='gunmetal'))
    cu.add(box(0.1, 0.5, 0.12, c=(0.78, -0.2, 1.0), mat='gunmetal', bev=0.01, segs=1))
    cu.add(cyl(0.022, 0.9, 8, 'y', c=(0.78, 0.45, 1.02), mat='gunmetal'))
    cu.add(cyl(0.032, 0.12, 8, 'y', c=(0.78, 0.92, 1.02), mat='gunmetal'))
    cu.add(box(0.12, 0.2, 0.16, c=(0.9, -0.2, 0.96), bev=0.01, segs=1))
    T_.add(cu)
    # --- 902G smoke launchers (4 per side) on the turret front sides behind the wedges
    for s in (1, -1):
        for i in range(4):
            a = math.radians(90 - s * (52 + i * 9))
            px, py = 1.1 * math.cos(a), 1.1 * math.sin(a) * 1.02
            tb = lathe([(0, -0.1), (0.05, -0.1), (0.05, 0.12), (0.042, 0.12), (0.042, -0.07), (0, -0.07)], 12, 'y')
            tb.rot('X', 20).rot('Z', math.degrees(a) - 90)
            T_.add(tb, Matrix.Translation((px, py, 0.42)))
        T_.add(box(0.12, 0.42, 0.04, c=(s * 1.06, 0.42, 0.36), bev=0.008, segs=1).rot('Z', s * 30, (s * 1.06, 0.42, 0.36)))
    # --- rear: stowage bin, snorkel tube, wind sensor, antennas
    T_.add(box(1.8, 0.4, 0.42, c=(0, -1.38, 0.3), bev=0.02, segs=2))
    for x in (-0.6, 0.0, 0.6):
        T_.add(box(0.03, 0.42, 0.44, c=(x, -1.38, 0.3)))
    T_.add(cyl(0.11, 1.5, 18, 'x', c=(0, -1.66, 0.42), bev=0.01))       # OPVT snorkel canister
    for x in (-0.6, 0.6):
        T_.add(box(0.04, 0.1, 0.16, c=(x, -1.6, 0.36)))
    T_.add(cyl(0.012, 0.6, 6, 'z', c=(0.1, -0.9, 0.9), mat='gunmetal'))  # crosswind sensor mast
    T_.add(cyl(0.03, 0.08, 8, 'z', c=(0.1, -0.9, 1.22)))
    T_.add(antenna_base(), Matrix.Translation((-0.55, -0.85, 0.56)))
    # lifting eyes on turret sides
    for s in (1, -1):
        T_.add(lathe([(0.03, -0.012), (0.05, -0.012), (0.05, 0.012), (0.03, 0.012)], 12, 'y', cap=False), Matrix.Translation((s * 0.95, -0.7, 0.5)))
    # side stowage boxes
    for s in (1, -1):
        T_.add(box(0.12, 0.8, 0.28, c=(s * 1.2, -0.6, 0.24), bev=0.015, segs=2))
    return T_

def cope_cage():
    """2022-24 style improvised screen: square-tube posts + flat slatted roof over the turret."""
    C = B(mat='cage')
    top = 1.18
    posts = [(-1.15, 1.0), (1.15, 1.0), (-1.3, -0.4), (1.3, -0.4), (-1.0, -1.5), (1.0, -1.5)]
    for (x, y) in posts:
        base_z = 0.32 if abs(y) < 1.2 else 0.5
        C.add(tube([(x, y, base_z), (x * 1.06, y, top)], 0.022, 4, 'cage'))
        C.add(box(0.12, 0.12, 0.012, c=(x, y, base_z), mat='cage'))
    # frame
    fr = [(-1.32, 1.65), (1.32, 1.65), (1.42, -1.65), (-1.42, -1.65)]
    for i in range(4):
        a, b_ = fr[i], fr[(i + 1) % 4]
        C.add(tube([(a[0], a[1], top), (b_[0], b_[1], top)], 0.02, 4, 'cage'))
    # slats across + 2 longitudinal stringers
    for y in np.arange(-1.5, 1.6, 0.3):
        hw = 1.32 + (1.42 - 1.32) * (1.65 - y) / 3.3
        C.add(box(2 * hw, 0.012, 0.05, c=(0, y, top + 0.03), mat='cage'))
    for x in (-0.7, 0.0, 0.7):
        C.add(box(0.03, 3.3, 0.03, c=(x, 0, top + 0.005), mat='cage'))
    # front drop panel over the gun mantlet area (hangs forward)
    for x in np.arange(-1.2, 1.25, 0.24):
        C.add(tube([(x, 1.65, top), (x, 1.9, top - 0.22)], 0.01, 4, 'cage'))
    C.add(tube([(-1.25, 1.9, top - 0.22), (1.25, 1.9, top - 0.22)], 0.015, 4, 'cage'))
    # side skirts of mesh: bars hanging down
    for s in (1, -1):
        for y in np.arange(-1.5, 1.55, 0.25):
            x = s * (1.36 + 0.05 * (1.65 - y) / 3.3)
            C.add(tube([(x, y, top), (x, y, top - 0.32)], 0.008, 4, 'cage'))
        C.add(tube([(s * 1.36, -1.6, top - 0.32), (s * 1.36, 1.6, top - 0.32)], 0.012, 4, 'cage'))
    return C

def turret_av():
    T_ = turret_shell('av')
    bv = bvh_of(T_)
    brick = k1_brick().to_mesh('_k1')
    # Kontakt-1 bricks over the frontal arc: staggered rows projected onto the cast surface,
    # long axis horizontal (tangent), tilted to follow the dome
    for row, z in enumerate((0.13, 0.3, 0.47)):
        rad = 1.2 - row * 0.1
        step = math.degrees(0.275 / rad)
        k = 0
        a0 = 17 + (step / 2 if row % 2 else 0)
        for side in (1, -1):
            a = a0
            while a < 78 - row * 6:
                ang = math.radians(90 - side * a)
                d = V((math.cos(ang), math.sin(ang), 0.0))
                hit = bv.ray_cast(V((0, 0, z)) + d * 3.0, -d)
                a += step
                if hit[0] is None:
                    continue
                loc, nrm = hit[0], hit[1]
                Mf = L.frame_from_normal(nrm, V((0, 0, 1)))
                T_.add_mesh(brick, L.place(Mf, loc - nrm * 0.02))
    # roof front edge bricks (laid flat-ish)
    for k in range(-4, 5):
        if abs(k) <= 1:
            continue
        T_.add_mesh(brick, Matrix.Translation((k * 0.19, 0.78, 0.6)) @ Matrix.Rotation(math.radians(-15), 4, 'X') @ Matrix.Rotation(math.radians(90), 4, 'Z'))
    bpy.data.meshes.remove(brick)
    T_.add(box(0.46, 0.3, 0.36, c=(0, 1.26, 0.32), mat='cast', bev=0.04, segs=2))
    # L-4 "Luna" IR searchlight right of the gun
    lu = lathe([(0, -0.14), (0.15, -0.14), (0.18, -0.08), (0.18, 0.08), (0.165, 0.11), (0.0, 0.11)], 24, 'y', c=(0.5, 1.12, 0.72))
    lu.add(cyl(0.155, 0.01, 24, 'y', c=(0.5, 1.235, 0.72), mat='glass'))
    lu.add(box(0.06, 0.2, 0.16, c=(0.5, 1.0, 0.6)))
    lu.add(tube([(0.5, 1.2, 0.66), (0.5, 1.4, 0.66)], 0.008, 4))      # link rod to gun
    T_.add(lu)
    # TPD-K1 gunner sight head + gunner hatch (left)
    T_.add(box(0.26, 0.3, 0.2, c=(-0.48, 0.48, 0.66), bev=0.02, segs=2))
    T_.add(box(0.18, 0.012, 0.08, c=(-0.48, 0.635, 0.7), mat='glass'))
    T_.add(box(0.2, 0.18, 0.18, c=(-0.75, 0.3, 0.65), bev=0.02, segs=2))   # TPN-3 night sight
    T_.add(cyl(0.05, 0.02, 12, 'y', c=(-0.75, 0.395, 0.66), mat='glass'))
    T_.add(lathe([(0, 0.05), (0.26, 0.045), (0.3, 0.02), (0.31, 0.0)], 24, 'z', c=(-0.5, -0.15, 0.6)))
    # commander cupola + NSVT
    cu = lathe([(0, 0.0), (0.42, 0.0), (0.42, 0.06), (0.38, 0.14), (0.34, 0.16), (0.0, 0.16)], 32, 'z', c=(0.5, -0.12, 0.58))
    cu.add(lathe([(0, 0.05), (0.27, 0.045), (0.31, 0.02), (0.32, 0.0)], 24, 'z', c=(0.5, -0.12, 0.74)))
    for ang in (60, 90, 120):
        a = math.radians(ang)
        cu.add(periscope_block(0.14, 0.08, 0.06), Matrix.Translation((0.5 + 0.36 * math.cos(a), -0.12 + 0.36 * math.sin(a), 0.68)) @ Matrix.Rotation(a - math.pi / 2, 4, 'Z'))
    cu.add(box(0.2, 0.18, 0.16, c=(0.5, 0.2, 0.76), bev=0.02, segs=2))
    cu.add(cyl(0.03, 0.25, 8, 'z', c=(0.5, -0.45, 0.86), mat='gunmetal'))
    cu.add(box(0.1, 0.55, 0.13, c=(0.5, -0.32, 1.0), mat='gunmetal', bev=0.01, segs=1))
    cu.add(cyl(0.022, 1.0, 8, 'y', c=(0.5, 0.4, 1.02), mat='gunmetal'))
    cu.add(lathe([(0, 0), (0.04, 0), (0.035, 0.12), (0, 0.12)], 8, 'y', mat='gunmetal', c=(0.5, 0.9, 1.02)))
    cu.add(box(0.12, 0.22, 0.16, c=(0.62, -0.3, 0.96), bev=0.01, segs=1))
    T_.add(cu)
    # 902B launchers: 6 per side around the front quarters
    for s in (1, -1):
        for i in range(6):
            a = math.radians(90 - s * (48 + i * 9))
            px, py = 1.12 * math.cos(a), 1.12 * math.sin(a) * 1.05
            tb = lathe([(0, -0.1), (0.045, -0.1), (0.045, 0.11), (0.038, 0.11), (0.038, -0.07), (0, -0.07)], 12, 'y')
            tb.rot('X', 25).rot('Z', math.degrees(a) - 90)
            T_.add(tb, Matrix.Translation((px, py, 0.4)))
        T_.add(box(0.1, 0.62, 0.035, c=(s * 1.08, 0.3, 0.34), bev=0.008, segs=1).rot('Z', s * 38, (s * 1.08, 0.3, 0.34)))
    # rear stowage + snorkel + antenna
    T_.add(box(1.7, 0.36, 0.38, c=(0, -1.36, 0.28), bev=0.02, segs=2))
    T_.add(cyl(0.11, 1.5, 18, 'x', c=(0, -1.62, 0.4), bev=0.01))
    T_.add(antenna_base(), Matrix.Translation((-0.55, -0.85, 0.56)))
    for s in (1, -1):
        T_.add(box(0.12, 0.8, 0.28, c=(s * 1.2, -0.55, 0.24), bev=0.015, segs=2))
        T_.add(lathe([(0.03, -0.012), (0.05, -0.012), (0.05, 0.012), (0.03, 0.012)], 12, 'y', cap=False), Matrix.Translation((s * 0.95, -0.7, 0.5)))
    # canvas tarp roll strapped on the rear stowage (common on UA tanks)
    T_.add(cyl(0.14, 1.5, 14, 'x', c=(0, -1.25, 0.62), mat='canvas'))
    return T_

def gun_2a46(variant):
    """2A46M-5 (B3) / 2A46M (AV) 125 mm. Local origin = trunnion. Gun along +Y."""
    G = B(mat='rolled')
    # canvas mantlet boot
    G.add(lathe([(0.27, 0.0, 'canvas'), (0.25, 0.1, 'canvas'), (0.215, 0.2, 'canvas'), (0.185, 0.3, 'canvas'),
                 (0.16, 0.36, 'canvas')], 20, 'y', mat='canvas', cap=False, c=(0, 0.8, 0)))
    for i in range(4):
        G.add(lathe([(0.262 - i * 0.026, 0.0, 'canvas'), (0.27 - i * 0.026, 0.012, 'canvas'), (0.258 - i * 0.026, 0.024, 'canvas')],
                    20, 'y', mat='canvas', cap=False, c=(0, 0.84 + i * 0.075, 0)))
    L0 = 5.3   # trunnion -> muzzle (muzzle ~5.9 m ahead of hull centre -> ~9.4 m gun-forward length)
    if variant == 't72b3':
        # thermal sleeve: 4 segments with clamp bands; fume extractor ~ mid barrel
        prof = [(0.0, 0.7), (0.155, 0.7), (0.155, 1.0), (0.148, 1.02), (0.148, 2.25), (0.17, 2.3), (0.185, 2.38),
                (0.185, 2.88), (0.17, 2.96), (0.14, 3.0), (0.135, 3.03), (0.135, 4.95), (0.128, 5.0), (0.122, 5.3), (0.098, 5.3), (0.098, 5.2), (0.0, 5.2)]
        G.add(lathe(prof, 24, 'y'))
        for y in (1.02, 1.62, 2.22, 3.04, 3.64, 4.24, 4.84):
            G.add(cyl(0.157 if y < 2.3 else 0.143, 0.03, 24, 'y', c=(0, y, 0)))
        # muzzle reference system box at the muzzle top
        G.add(box(0.06, 0.08, 0.06, c=(0, 5.18, 0.15), bev=0.008, segs=1))
        # sleeve seam straps (longitudinal)
        G.add(box(0.012, 1.2, 0.01, c=(0, 1.6, 0.152)))
        G.add(box(0.012, 1.85, 0.01, c=(0, 3.95, 0.139)))
    else:
        prof = [(0.0, 0.7), (0.15, 0.7), (0.15, 0.95), (0.142, 1.0), (0.142, 2.2), (0.165, 2.26), (0.18, 2.34),
                (0.18, 2.82), (0.165, 2.9), (0.135, 2.95), (0.13, 2.98), (0.13, 5.0), (0.122, 5.3), (0.098, 5.3), (0.098, 5.2), (0.0, 5.2)]
        G.add(lathe(prof, 24, 'y'))
        for y in (1.0, 1.6, 3.0, 3.6, 4.2, 4.8):
            G.add(cyl(0.152 if y < 2.3 else 0.138, 0.03, 24, 'y', c=(0, y, 0)))
    # fume extractor bolts ring
    for i in range(8):
        a = math.tau * i / 8
        G.add(bolt(0.012, 0.01).rot('X', -90), Matrix.Translation((0.185 * math.cos(a), 2.4, 0.185 * math.sin(a))) @ Matrix.Rotation(a - math.pi / 2, 4, 'Y') if False else Matrix.Translation((0.18 * math.cos(a), 2.36, 0.18 * math.sin(a))))
    # coaxial PKT (right of the gun)
    G.add(cyl(0.035, 0.24, 10, 'y', c=(0.32, 0.66, -0.04), mat='gunmetal'))
    G.add(cyl(0.013, 0.3, 8, 'y', c=(0.32, 0.9, -0.04), mat='gunmetal'))
    muzzle = (0, L0, 0)
    coax = (0.32, 1.05, -0.04)
    return G, muzzle, coax

# ================================================================================================ track textures
def track_textures(prefix):
    """1 link per U unit.  U: 128 px, V: 512 px (outer face 0..0.42, edges, inner face + guide horn ridge)."""
    W, H = 128, 512
    u = (np.arange(W) + 0.5) / W
    v = (np.arange(H) + 0.5) / H
    U, Vv = np.meshgrid(u, v)            # rows = v
    h = np.zeros((H, W), np.float32)
    alpha = np.ones((H, W), np.float32)
    col = np.zeros((H, W, 3), np.float32)
    steel = T.srgb2lin((50, 50, 49)); dark = T.srgb2lin((28, 28, 27)); rubber = T.srgb2lin((26, 26, 25))
    shiny = T.srgb2lin((118, 116, 110)); mud = T.srgb2lin((70, 62, 50)); dust = T.srgb2lin((112, 104, 88))
    gap = (U > 0.93)
    col[:] = steel
    rough = np.full((H, W), 0.7, np.float32); metal = np.full((H, W), 0.6, np.float32)
    outer = Vv < 0.42
    # outer face: link plate with two transverse grousers, centre pin bosses at ends
    gr = (np.abs(U - 0.3) < 0.07) | (np.abs(U - 0.68) < 0.07)
    h[outer] = 0.3
    h[outer & gr] = 1.0
    cen = outer & (np.abs(Vv - 0.21) < 0.05)
    h[cen & ~gr] = 0.15
    col[outer & gr] = shiny
    rough[outer & gr] = 0.35; metal[outer & gr] = 0.9
    # end connectors / pin heads on the side edges
    edge = (Vv >= 0.42) & (Vv < 0.47) | (Vv > 0.97)
    pin = edge & (np.abs(U - 0.96) < 0.08)
    h[pin] = 0.8; col[pin] = dark
    # inner face: road wheel paths with rubber bushings + guide horn ridge
    inner = (Vv >= 0.47) & (Vv < 0.97) & ~((Vv >= 0.62) & (Vv < 0.82))
    h[inner] = 0.5
    bush = inner & (np.abs(U - 0.97) < 0.05)
    h[bush] = 0.7; col[bush] = rubber; rough[bush] = 0.9; metal[bush] = 0
    path = inner & ((np.abs(Vv - 0.53) < 0.05) | (np.abs(Vv - 0.9) < 0.05))
    col[path] = shiny * 0.9; rough[path] = 0.4; metal[path] = 0.9
    horn = (Vv >= 0.62) & (Vv < 0.82)
    hornon = horn & (U > 0.12) & (U < 0.62)
    alpha[horn & ~hornon] = 0.0
    h[hornon] = 0.9
    col[hornon] = steel * 1.1
    # gaps between links: see-through
    alpha[gap & ~horn] = 0.0
    # dirt
    P = np.stack([U * 0.14 * 7, Vv * 1.2, np.zeros_like(U)], -1).astype(np.float32)
    dn = T.fbm(P, 6, 4, 77)
    m = T.sstep(0.5, 0.68, dn) * (1 - (h > 0.95) * 0.8) * (1 - (h < 0.2) * 0.0)
    col = T.mix(col, np.broadcast_to(mud, col.shape), m * 0.6)
    col = T.mix(col, np.broadcast_to(dust, col.shape), T.sstep(0.55, 0.72, T.fbm(P, 15, 3, 78)) * 0.3)
    rough = rough * (1 - m) + 0.9 * m
    metal *= (1 - m)
    # height -> normal in pixel space (link pitch ~0.137 m over 128 px, profile ~1.1 m over 512 px)
    from scipy import ndimage
    hs = ndimage.gaussian_filter(h, 1.0) * 0.012
    du = 0.137 / W; dv = 1.15 / H
    gx = (np.roll(hs, -1, 1) - np.roll(hs, 1, 1)) / (2 * du)
    gy = (np.roll(hs, -1, 0) - np.roll(hs, 1, 0)) / (2 * dv)
    n = np.stack([-gx, -gy, np.ones_like(gx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    alb = T.lin2srgb(col)
    img_a = T.to_image(prefix + '_track_albedo', alb, alpha=alpha)
    T.save_png_jpg(img_a, f'{VB.CACHE}/{prefix}_track_albedo.png', 'PNG')
    img_n = T.to_image(prefix + '_track_normal', n * 0.5 + 0.5, colorspace='Non-Color')
    T.save_png_jpg(img_n, f'{VB.CACHE}/{prefix}_track_normal.png', 'PNG')
    orm = np.stack([np.ones_like(rough), rough, metal], -1)
    img_o = T.to_image(prefix + '_track_orm', orm, colorspace='Non-Color')
    T.save_png_jpg(img_o, f'{VB.CACHE}/{prefix}_track_orm.png', 'PNG')
    m1 = T.principled('track', img_a, img_o, img_n, alpha_clip=True)
    _alpha_clip(m1)
    m2 = T.principled('track_wreck', img_a, None, img_n, rough=0.9, alpha_clip=True)
    _alpha_clip(m2)
    # burnt: darken via base colour factor (multiply node is not exported; use a tint MixRGB -> exporter ignores) ->
    # simplest exported path: separate albedo image
    burnt = T.lin2srgb(col * np.array([0.32, 0.2, 0.14], np.float32) + 0.006)
    img_b = T.to_image(prefix + '_track_wreck_albedo', burnt, alpha=alpha)
    T.save_png_jpg(img_b, f'{VB.CACHE}/{prefix}_track_wreck_albedo.png', 'PNG')
    m2.node_tree.nodes['Image Texture'].image = img_b
    return m1, m2

def _alpha_clip(m):
    """glTF exporter: alpha -> Math(ROUND) -> BSDF alpha => alphaMode MASK (cutoff 0.5)."""
    nt = m.node_tree
    bs = nt.nodes['Principled BSDF']
    tex = [n for n in nt.nodes if n.type == 'TEX_IMAGE'][0]
    rd = nt.nodes.new('ShaderNodeMath'); rd.operation = 'ROUND'
    nt.links.new(tex.outputs['Alpha'], rd.inputs[0])
    nt.links.new(rd.outputs[0], bs.inputs['Alpha'])

# ================================================================================================ build
def build(variant):
    t0 = time.time()
    L.reset()
    is_b3 = variant == 't72b3'
    root = L.node_empty('root')
    hullE = L.node_empty('hull', root, (0, 0, 0))
    H = hull_body(variant)
    hull_details(variant, H)
    H.add(side_skirts(variant))
    print('  hull tris', H.tris(), '%.1fs' % (time.time() - t0))
    hull_mesh = L.node_mesh('hull_geo', H, hullE, (0, 0, 0))
    # ---- turret
    tz = DECK + 0.01
    TU = turret_b3() if is_b3 else turret_av()
    TU.move(0, TUR_Y, tz)
    turE = L.node_empty('turret', hullE, (0, TUR_Y, tz))
    tur_mesh = L.node_mesh('turret_geo', TU, turE, (0, TUR_Y, tz))
    cage_mesh = None
    if is_b3:
        CG = cope_cage().move(0, TUR_Y, tz)
        cage_mesh = L.node_mesh('cope_cage', CG, turE, (0, TUR_Y, tz))
    trun = (0, TUR_Y + 0.55, GUN_Z)
    gunE = L.node_empty('gun_pivot', turE, trun)
    G, mz, cx = gun_2a46(variant)
    G.move(*trun)
    gun_mesh = L.node_mesh('gun_geo', G, gunE, trun)
    L.node_empty('muzzle', gunE, (trun[0] + mz[0], trun[1] + mz[1], trun[2] + mz[2]), 0.1)
    L.node_empty('coax_muzzle', gunE, (trun[0] + cx[0], trun[1] + cx[1], trun[2] + cx[2]), 0.1)
    L.node_empty('smoke_launchers', turE, (0, TUR_Y + 0.75, tz + 0.42))
    L.node_empty('commander_hatch', turE, (0.5, TUR_Y - 0.12, tz + 0.8))
    # ---- running gear
    RWm = road_wheel()
    parts = {'road': RWm, 'spr': sprocket(), 'idl': idler()}
    meshes = {}
    rg_objs = []
    def wheel(name, key, side, c):
        e = L.node_empty(name, hullE, c)
        mk = key + ('R' if side > 0 else 'L')
        if mk not in meshes:
            p = L._bcopy(parts[key])
            if side < 0:
                p.scale(-1, 1, 1)
            p.move(*c)
            o = L.node_mesh(name + '_geo', p, e, c)
            o.data.name = mk
            meshes[mk] = o.data
        else:
            o = L.node_mesh(name + '_geo', None, e, c, mesh=meshes[mk])
        rg_objs.append(o)
        return o
    for side, tag in ((1, 'R'), (-1, 'L')):
        for i, y in enumerate(RW_Y):
            wheel(f'roadwheel_{tag}{i + 1}', 'road', side, (side * TRK_X, y, RW_Z))
        wheel(f'sprocket_{tag}', 'spr', side, (side * TRK_X, SPR[0], SPR[1]))
        wheel(f'idler_{tag}', 'idl', side, (side * TRK_X, IDL[0], IDL[1]))
    # ---- tracks
    tracks = []
    for side, tag in ((1, 'R'), (-1, 'L')):
        tb, pitch, Ltot = track_band(side)
        o = L.node_mesh(f'track_{tag}', tb, hullE, (0, 0, 0), sharp=80)
        tracks.append(o)
    # ---- empties
    L.node_empty('exhaust', hullE, (-(SUP_X + FEN_X) / 2 - 0.2, -2.65, FEN_Z + 0.12))
    L.node_empty('dismount_L', hullE, (-2.2, -1.0, 0.0))
    L.node_empty('dismount_R', hullE, (2.2, -1.0, 0.0))
    print('  geometry done %.1fs' % (time.time() - t0))
    extra = [cage_mesh] if cage_mesh else []
    lod0 = [hull_mesh, tur_mesh, gun_mesh] + extra + rg_objs + tracks
    uniq = []
    seen = set()
    for o in [hull_mesh, tur_mesh, gun_mesh] + extra + rg_objs:
        if o.data.name not in seen:
            uniq.append(o); seen.add(o.data.name)
    return dict(root=root, hull=hullE, turret=turE, gun=gunE, lod0=lod0, gun_obj=gun_mesh, tur_obj=tur_mesh,
                cage_obj=cage_mesh, atlas=uniq, tracks=tracks, pitch=pitch, track_len=Ltot)

def wreck_t72(d):
    root = d['root']
    hw = VB.join_copies('hull_wreck', [o for o in d['lod0'] if o not in (d['tur_obj'], d['gun_obj'], d['cage_obj'])], root,
                        (0, 0, 0), drop_slots=('glass', 'light'), drop_z=0.04)
    g = d['gun_obj']
    g.rotation_euler = (math.radians(4), 0, 0)
    bpy.context.view_layer.update()
    tp = d['turret'].matrix_world.translation.copy()
    tw = VB.join_copies('turret_wreck', [o for o in (d['tur_obj'], g, d['cage_obj']) if o], root, tuple(tp), drop_slots=('glass', 'light'))
    g.rotation_euler = (0, 0, 0)
    tw.location.z -= 0.04
    bpy.context.view_layer.update()
    return [hw, tw]

def decals_ua(P, N):
    m = np.zeros(P.shape[:2], np.float32)
    E = lambda p: (-p[0], -p[1], p[2])
    tz = DECK + 0.01
    for s_ in (1, -1):
        m += T.decal_mask(P, N, E((s_ * 1.26, TUR_Y - 0.6, tz + 0.24)), E((s_, 0, 0.0)), (0, 0, 1), T.cross_shape(0.12, 0.03))
        m += T.decal_mask(P, N, E((s_ * (FEN_X + 0.01), -1.8, 0.85)), E((s_, 0, 0)), (0, 0, 1), T.cross_shape(0.15, 0.035))
    m += T.decal_mask(P, N, E((0, TUR_Y - 1.56, tz + 0.3)), E((0, -1, 0)), (0, 0, 1), T.cross_shape(0.15, 0.035))
    return m

def decals_ru(P, N):
    return np.zeros(P.shape[:2], np.float32)

def main(variant):
    d = build(variant)
    tm = track_textures(variant)
    scheme = 'ru_green' if variant == 't72b3' else 'ua_green'
    info = VB.finalize(d, variant, scheme, decals_ru if variant == 't72b3' else decals_ua, wreck_t72, track_mats=tm)
    info['track_link_pitch_m'] = round(d['pitch'], 4)
    info['track_length_m'] = round(d['track_len'], 3)
    info['track_links'] = 97
    with open(os.path.join(VB.CACHE, variant + '_info.json'), 'w') as f:
        json.dump(info, f, indent=1)
    print(json.dumps({k: v for k, v in info.items() if k != 'nodes'}))
    return info

if __name__ == '__main__':
    main(sys.argv[-1])
