"""BMP-3 (RU, 2022-24 service look) and M2A2 ODS-SA Bradley (UA, 2023+, BRAT tiles) infantry fighting vehicles.

    cd /tmp && flock /tmp/heavy.lock nice -n 10 python3 <repo>/tools/blender/vehicles/ifv.py bmp3|bradley_ua

Reference data + sources: ifv_data.py (copied into assets/vehicles/manifest.json `sources.bmp3` / `sources.bradley`).
BMP-3: hull 6.73 m (7.14 m gun forward), 3.15 m wide, 2.30 m turret roof, clearance 0.45 m, roof ~1.69 m, very shallow
  glacis with the folded trim vane, two bow PKT ball mounts in the front corners, centre driver, full-width upper hull
  over the tracks with a segmented screen over the upper run, 6 road wheels, raised rear sprocket + front idler,
  3 return rollers, rear engine under the floor with the troop passage over it: twin rear doors + two roof hatches.
Bradley M2A2 ODS-SA: 6.55 m, 3.28 m (3.61 with BRAT), 2.57 m turret roof, clearance 0.46 m, 53 cm T157-style track on
  2.44 m centres, 6 dual 61 cm road wheels, 11-tooth FRONT sprocket, rear idler, 3 return rollers, engine front right,
  driver front left, 32 mm bolted appliqué on hull sides / turret, spaced-laminate skirts, big rear ramp with a door
  in its left half, TOW twin launcher on the turret left, ISU sight left front of the roof, M257 smoke 2 x 4.
Authoring frame: X right, Y forward, Z up (see vlib).
"""
import sys, os, math, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
import numpy as np
from mathutils import Vector as V, Matrix
import vlib as L
from vlib import B, box, hull, prism, lathe, cyl, tube, rail, bolt, fillet_path
import vtex as T
import vbuild as VB
import seats as S
from btr import (periscope_block, hatch_rect, louvre_panel, headlight_cluster, tow_hook, tow_cable, antenna_base,
                 tucha_tube, firing_port, align_y, tool_shovel)
from t72 import era_block, _alpha_clip
import ifv_data as D

REPO = VB.REPO
VB.SCHEMES.setdefault('ru_bmp3', dict(base=(60, 69, 42), base2=(52, 61, 37), camo=None, dust=(140, 129, 107), mud=(68, 57, 44),
                                      wear=1.05, dust_amt=1.05, fade=(88, 94, 66)))
# NATO three-tone CARC woodland (green 383 / brown 383 / black) as delivered from US stocks, field worn
VB.SCHEMES.setdefault('ua_nato', dict(base=(70, 77, 50), base2=(62, 69, 45), camo=[((84, 67, 48), 0.36), ((33, 33, 30), 0.15)],
                                      camo_freq=0.5, dust=(138, 128, 108), mud=(66, 56, 43), wear=1.1, dust_amt=0.95,
                                      fade=(92, 96, 70)))

# ================================================================================================ generic helpers
def slope_frame(p_lo, p_hi):
    """Frame on a transverse sloped plate through (y,z) p_lo -> p_hi: local x = -X, y = up the plate, z = outward."""
    d = V((0, p_hi[0] - p_lo[0], p_hi[1] - p_lo[1])).normalized()
    n = V((0, d.z, -d.y))
    if (n.y < 0 and p_hi[0] < p_lo[0]) or (n.z < 0):
        n = -n
    return L.frame_from_normal(n, V((0, 0, 1))), n, d

def plate_pt(p_lo, p_hi, x, t, off=0.0):
    _, n, d = slope_frame(p_lo, p_hi)
    y = p_lo[0] + (p_hi[0] - p_lo[0]) * t
    z = p_lo[1] + (p_hi[1] - p_lo[1]) * t
    return V((x, y, z)) + n * off

def side_frame(s, tilt_deg=0.0):
    """Frame on a side plate (normal = +-X tilted up by tilt): local x = forward (right side) / back (left), y = up, z = out."""
    a = math.radians(tilt_deg)
    n = V((s * math.cos(a), 0, math.sin(a)))
    return L.frame_from_normal(n, V((0, 0, 1)))

def facing_empty(name, parent, loc, face, size=0.15, **props):
    """Empty whose glTF local +Z points along authoring direction `face` (fx, fy), +Y up (same math as seats.py)."""
    e = L.node_empty(name, parent, loc, size)
    f = V((face[0], face[1], 0)).normalized()
    Yc = V((f.x, f.y, 0)); Zc = V((0, 0, 1)); Xc = Yc.cross(Zc)
    e.rotation_mode = 'QUATERNION'
    e.rotation_quaternion = Matrix((Xc, Yc, Zc)).transposed().to_quaternion()
    for k, v in props.items():
        e[k] = v
    return e

def grab(p0, p1, h=0.06, r=0.011):
    """Small U grab handle between two points on a surface, standing off along +Z."""
    p0, p1 = V(p0), V(p1)
    return rail([p0, p0 + V((0, 0, h)), p1 + V((0, 0, h)), p1], r=r, rad=0.02)

def bolts_grid(xs, ys, z, r=0.014, h=0.01, mat='rolled'):
    b = B(mat=mat)
    for x in xs:
        for y in ys:
            b.add(bolt(r, h, 6, mat), Matrix.Translation((x, y, z)))
    return b

# ================================================================================================ running gear
def road_wheel(R, hw, style):
    """Dual road wheel, axis X (outward +X), hub at origin. Profile scaled from the T-72 750 mm wheel."""
    sr, sa = R / 0.376, hw / 0.215
    segs = 24
    base = [(0.0, 0.215), (0.09, 0.2), (0.11, 0.17), (0.25, 0.14), (0.29, 0.15), (0.305, 0.17, 'tyre'),
            (0.355, 0.172, 'tyre'), (0.374, 0.15, 'tyre'), (0.376, 0.12, 'tyre'), (0.372, 0.085, 'tyre'), (0.35, 0.071, 'tyre'),
            (0.305, 0.075), (0.2, 0.055), (0.08, 0.045), (0.0, 0.045)]
    def disc(sign):
        pr = [(p[0] * sr, p[1] * sa * sign, p[2] if len(p) > 2 else 'rim') for p in base]
        if sign < 0:
            pr = pr[::-1]
            pr = [(pr[i][0], pr[i][1], pr[i + 1][2] if i + 1 < len(pr) else 'rim') for i in range(len(pr))]
        return lathe(pr, segs, 'x', mat='rim', cap=False)
    w = disc(1)
    w.add(disc(-1))
    xo = 0.155 * sa
    if style == 'bmp3':
        # six pressed spokes + lightening pockets
        for i in range(6):
            a = math.tau * i / 6
            r = box(0.014, 0.16 * sr, 0.045 * sr, c=(0, 0.17 * sr, 0), mat='rim').bevel(0.004, 1)
            w.add(r.move(xo, 0, 0).rot('X', math.degrees(a)))
            a2 = a + math.tau / 12
            w.add(cyl(0.045 * sr, 0.01, 12, 'x', c=(xo - 0.004, 0.2 * sr * math.cos(a2), 0.2 * sr * math.sin(a2)), mat='gunmetal'))
    else:
        # Bradley: flat dished disc with 8 round pockets and a raised bolt circle
        for i in range(8):
            a = math.tau * i / 8 + math.pi / 8
            w.add(cyl(0.042 * sr, 0.012, 12, 'x', c=(xo - 0.003, 0.205 * sr * math.cos(a), 0.205 * sr * math.sin(a)), mat='gunmetal'))
        w.add(lathe([(0.125 * sr, 0.0), (0.145 * sr, 0.0), (0.145 * sr, 0.012), (0.125 * sr, 0.012)], 24, 'x', mat='rim', c=(xo, 0, 0)))
    w.add(lathe([(0, 0.0), (0.085 * sr, 0.0), (0.085 * sr, 0.028), (0.06 * sr, 0.045), (0.0, 0.05)], 16, 'x', mat='rim', c=(0.21 * sa, 0, 0)))
    for i in range(6):
        a = math.tau * i / 6
        w.add(bolt(0.011, 0.012, 6, 'rim').rot('Y', 90), Matrix.Translation((0.212 * sa, 0.115 * sr * math.cos(a), 0.115 * sr * math.sin(a))))
    return w

def sprocket(R, nt, gap=0.07):
    w = B(mat='rim')
    for xo in (gap, -gap):
        pts = []
        for i in range(nt * 4):
            a = math.tau * i / (nt * 4)
            r = R if (i % 4) in (1, 2) else R * 0.83
            pts.append((r * math.cos(a), r * math.sin(a)))
        w.add(prism(pts, 0.032, 'x', mat='rim', c=xo).bevel(0.005, 1, 30))
    k = R / 0.36
    w.add(lathe([(0.0, 0.16 * k), (0.12 * k, 0.16 * k), (0.16 * k, 0.13 * k), (0.2 * k, 0.09 * k), (0.28 * k, gap + 0.015), (0.29 * k, gap - 0.02),
                 (0.29 * k, -gap + 0.02), (0.28 * k, -gap - 0.015), (0.16 * k, -0.1 * k), (0.0, -0.1 * k)], 26, 'x', mat='rim'))
    for i in range(10):
        a = math.tau * i / 10
        w.add(bolt(0.012, 0.013, 6, 'rim').rot('Y', 90), Matrix.Translation((0.16 * k, 0.13 * k * math.cos(a), 0.13 * k * math.sin(a))))
    for i in range(6):
        a = math.tau * i / 6
        c = (0.1 * k, 0.21 * k * math.cos(a), 0.21 * k * math.sin(a))
        w.add(cyl(0.04 * k, 0.012, 10, 'x', c=c, mat='gunmetal'))
    return w

def idler(R, gap=0.07):
    w = B(mat='rim')
    k = R / 0.30
    for sg in (1, -1):
        xo = sg * gap
        w.add(lathe([(0.0, xo - 0.04 * sg), (0.12 * k, xo + 0.015 * sg), (0.24 * k, xo + 0.01 * sg), (0.27 * k, xo + 0.028 * sg),
                     (R, xo + 0.028 * sg), (R, xo - 0.028 * sg), (0.27 * k, xo - 0.028 * sg), (0.0, xo - 0.03 * sg)][::sg], 30, 'x', mat='rim'))
    for i in range(6):
        a = math.tau * i / 6
        w.add(cyl(0.05 * k, 0.01, 12, 'x', c=(gap + 0.035, 0.17 * k * math.cos(a), 0.17 * k * math.sin(a)), mat='gunmetal'))
    w.add(lathe([(0, 0.0), (0.07 * k, 0.0), (0.07 * k, 0.04), (0.04 * k, 0.06), (0, 0.06)], 14, 'x', mat='rim', c=(gap + 0.03, 0, 0)))
    return w

def return_roller(r, w=0.11):
    return lathe([(0.0, -w), (r - 0.01, -w, 'tyre'), (r, -w + 0.02, 'tyre'), (r, w - 0.02, 'tyre'), (r - 0.01, w), (0.04, w + 0.01), (0.0, w + 0.02)],
                 16, 'x', mat='rim')

def track_path(G):
    circles = [(y, G['rw_z'], G['rw_r']) for y in G['rw_y']] + [G['idl'][:3], G['spr'][:3]] + [(y, G['rr_z'], G['rr_r']) for y in G['rr_y']]
    pts = []
    for (cy, cz, r) in circles:
        for i in range(72):
            a = math.tau * i / 72
            pts.append((cy + r * math.cos(a), cz + r * math.sin(a)))
    P = sorted(map(tuple, np.array(pts)))
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
    hp = lower[:-1] + upper[:-1]
    poly = np.array(hp + [hp[0]])
    seg = np.linalg.norm(np.diff(poly, axis=0), axis=1)
    Lt = seg.sum()
    n = int(Lt / 0.045)
    s = np.linspace(0, Lt, n, endpoint=False)
    cum = np.concatenate([[0], np.cumsum(seg)])
    out = []
    for si in s:
        k = np.searchsorted(cum, si, side='right') - 1
        t = (si - cum[k]) / seg[k]
        out.append(poly[k] * (1 - t) + poly[k + 1] * t)
    out = np.array(out)
    # sag of the top run between the supports
    sup = sorted([(G['spr'][0], G['spr'][1] + G['spr'][2]), (G['idl'][0], G['idl'][1] + G['idl'][2])] +
                 [(y, G['rr_z'] + G['rr_r']) for y in G['rr_y']])
    zmid = G['rw_z'] + G['rw_r'] + 0.12
    for i in range(len(out)):
        y, z = out[i]
        if z > zmid:
            for (a, za), (b_, zb) in zip(sup[:-1], sup[1:]):
                if a < y < b_:
                    t = (y - a) / (b_ - a)
                    out[i, 1] -= G['sag'] * math.sin(math.pi * t) * min(1.0, (b_ - a) / 1.2)
    keep = []
    for i in range(len(out)):
        p0, p1, p2 = out[i - 1], out[i], out[(i + 1) % len(out)]
        d1 = p1 - p0; d2 = p2 - p1
        ang = abs(math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1.dot(d2)))
        if ang > 0.004 or i % 6 == 0:
            keep.append(p1)
    return np.array(keep)

def track_band(G, side):
    """Closed band with profile; UV U = link index (1 per link), V across profile (same layout as t72.track_band)."""
    path = track_path(G)
    n = len(path)
    seg = np.linalg.norm(np.roll(path, -1, 0) - path, axis=1)
    Lt = seg.sum()
    links = int(round(Lt / G['pitch']))
    pitch = Lt / links
    tang = np.roll(path, -1, 0) - np.roll(path, 1, 0)
    tang /= np.linalg.norm(tang, axis=1, keepdims=True)
    nrm = np.stack([tang[:, 1], -tang[:, 0]], 1)
    hw = G['trk_w'] / 2
    BD = G['band']
    hx, hh = G['horn']
    prof = [(-hw, BD, 0.0), (-hw * 0.42, BD, 0.2), (hw * 0.42, BD, 0.3), (hw, BD, 0.42), (hw, 0.0, 0.47),
            (hx, 0.0, 0.62), (hx, -hh, 0.68), (-hx, -hh, 0.76), (-hx, 0.0, 0.82), (-hw, 0.0, 0.97), (-hw, BD, 1.0)]
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    rows = []
    cum = np.concatenate([[0], np.cumsum(seg)])
    X = G['trk_x']
    for i in range(n + 1):
        k = i % n
        y, z = path[k]
        ny, nz = nrm[k]
        rows.append([bm.verts.new((side * X + x * side, y + ny * d, z + nz * d)) for (x, d, v) in prof])
    for i in range(n):
        u0 = cum[i] / pitch; u1 = cum[i + 1] / pitch
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
    return b, pitch, Lt, links

def track_textures(prefix, style, pitch, width):
    """U = one link (128 px), V = profile (512 px): outer face 0..0.42, edge, inner face, guide-horn strip 0.62..0.82."""
    W, H = 128, 512
    u = (np.arange(W) + 0.5) / W
    v = (np.arange(H) + 0.5) / H
    U, Vv = np.meshgrid(u, v)
    h = np.zeros((H, W), np.float32)
    alpha = np.ones((H, W), np.float32)
    col = np.zeros((H, W, 3), np.float32)
    steel = T.srgb2lin((52, 51, 49)); dark = T.srgb2lin((28, 28, 27)); rubber = T.srgb2lin((24, 24, 23))
    shiny = T.srgb2lin((122, 118, 110)); mud = T.srgb2lin((72, 63, 50)); dust = T.srgb2lin((114, 106, 90))
    col[:] = steel
    rough = np.full((H, W), 0.7, np.float32); metal = np.full((H, W), 0.6, np.float32)
    outer = Vv < 0.42
    gap = U > 0.92
    horn = (Vv >= 0.62) & (Vv < 0.82)
    if style == 'steel':
        # BMP-3: cast steel link, two grousers, rubber-bushed single pin
        gr = (np.abs(U - 0.32) < 0.07) | (np.abs(U - 0.66) < 0.06)
        h[outer] = 0.3; h[outer & gr] = 1.0
        cen = outer & (np.abs(Vv - 0.21) < 0.04)
        h[cen & ~gr] = 0.12
        hole = outer & (np.abs(U - 0.49) < 0.06) & ((np.abs(Vv - 0.1) < 0.04) | (np.abs(Vv - 0.32) < 0.04))
        alpha[hole] = 0.0
        col[outer & gr] = shiny; rough[outer & gr] = 0.35; metal[outer & gr] = 0.9
    else:
        # Bradley T157-type double-pin: two rubber pads per shoe, steel end connectors + centre guide
        pad = outer & (U > 0.08) & (U < 0.86) & (((Vv > 0.035) & (Vv < 0.185)) | ((Vv > 0.235) & (Vv < 0.385)))
        h[outer] = 0.35; h[pad] = 1.0
        col[pad] = rubber; rough[pad] = 0.92; metal[pad] = 0.0
        wear = pad & (T.fbm(np.stack([U * 3, Vv * 7, np.zeros_like(U)], -1).astype(np.float32), 4, 3, 91) > 0.62)
        col[wear] = rubber * 1.6
        conn = outer & ((Vv < 0.035) | (Vv > 0.385) | ((Vv > 0.185) & (Vv < 0.235))) & ((U < 0.2) | (U > 0.74))
        h[conn] = 0.75; col[conn] = shiny * 0.8; rough[conn] = 0.45; metal[conn] = 0.85
        boltm = conn & (((U - 0.1) ** 2 + ((Vv % 0.21) - 0.01) ** 2) < 0.0006)
        h[boltm] = 0.95
    edge = ((Vv >= 0.42) & (Vv < 0.47)) | (Vv > 0.97)
    pin = edge & (np.abs(U - 0.96) < 0.08)
    h[pin] = 0.8; col[pin] = dark
    inner = (Vv >= 0.47) & (Vv < 0.97) & ~horn
    h[inner] = 0.5
    bush = inner & (np.abs(U - 0.97) < 0.05)
    h[bush] = 0.7; col[bush] = rubber; rough[bush] = 0.9; metal[bush] = 0
    path = inner & ((np.abs(Vv - 0.53) < 0.05) | (np.abs(Vv - 0.9) < 0.05))
    if style == 'steel':
        col[path] = shiny * 0.9; rough[path] = 0.4; metal[path] = 0.9
    else:
        col[path] = rubber * 1.2; rough[path] = 0.85; metal[path] = 0.0     # rubber road-wheel backers
    hornon = horn & (U > 0.14) & (U < 0.6)
    alpha[horn & ~hornon] = 0.0
    h[hornon] = 0.9; col[hornon] = steel * 1.12
    alpha[gap & ~horn] = 0.0
    P = np.stack([U * pitch * 7, Vv * 1.2, np.zeros_like(U)], -1).astype(np.float32)
    dn = T.fbm(P, 6, 4, 77)
    m = T.sstep(0.5, 0.68, dn) * (1 - (h > 0.95) * 0.8)
    col = T.mix(col, np.broadcast_to(mud, col.shape), m * 0.6)
    col = T.mix(col, np.broadcast_to(dust, col.shape), T.sstep(0.55, 0.72, T.fbm(P, 15, 3, 78)) * 0.3)
    rough = rough * (1 - m) + 0.9 * m
    metal *= (1 - m)
    from scipy import ndimage
    hs = ndimage.gaussian_filter(h, 1.0) * 0.012
    du = pitch / W; dv = (2 * width + 0.25) / H
    gx = (np.roll(hs, -1, 1) - np.roll(hs, 1, 1)) / (2 * du)
    gy = (np.roll(hs, -1, 0) - np.roll(hs, 1, 0)) / (2 * dv)
    nn = np.stack([-gx, -gy, np.ones_like(gx)], -1)
    nn /= np.linalg.norm(nn, axis=-1, keepdims=True)
    img_a = T.to_image(prefix + '_track_albedo', T.lin2srgb(col), alpha=alpha)
    T.save_png_jpg(img_a, f'{VB.CACHE}/{prefix}_track_albedo.png', 'PNG')
    img_n = T.to_image(prefix + '_track_normal', nn * 0.5 + 0.5, colorspace='Non-Color')
    T.save_png_jpg(img_n, f'{VB.CACHE}/{prefix}_track_normal.png', 'PNG')
    img_o = T.to_image(prefix + '_track_orm', np.stack([np.ones_like(rough), rough, metal], -1), colorspace='Non-Color')
    T.save_png_jpg(img_o, f'{VB.CACHE}/{prefix}_track_orm.png', 'PNG')
    m1 = T.principled('track', img_a, img_o, img_n, alpha_clip=True)
    _alpha_clip(m1)
    m2 = T.principled('track_wreck', img_a, None, img_n, rough=0.9, alpha_clip=True)
    _alpha_clip(m2)
    img_b = T.to_image(prefix + '_track_wreck_albedo', T.lin2srgb(col * np.array([0.32, 0.2, 0.14], np.float32) + 0.006), alpha=alpha)
    T.save_png_jpg(img_b, f'{VB.CACHE}/{prefix}_track_wreck_albedo.png', 'PNG')
    m2.node_tree.nodes['Image Texture'].image = img_b
    return m1, m2

def suspension(G, H, low_x, s, arm_dir, shocks):
    """Torsion arms from the hull to each road wheel hub, bump stops, shock absorbers, return roller stubs."""
    for i, y in enumerate(G['rw_y']):
        d = arm_dir[i]
        hub = V((s * (G['trk_x'] - G['rw_hw'] - 0.03), y, G['rw_z']))
        piv = V((s * (low_x + 0.02), y + 0.3 * d, G['rw_z'] + 0.13))
        H.add(tube([piv, hub], 0.042, 8, 'rim'))
        H.add(cyl(0.07, 0.06, 12, 'x', c=tuple(piv), mat='rim'))
        H.add(cyl(0.05, 0.05, 10, 'x', c=tuple(hub + V((s * 0.02, 0, 0))), mat='rim'))
        H.add(box(0.05, 0.1, 0.07, c=(s * (low_x + 0.03), y + 0.1 * d, G['rw_z'] + G['rw_r'] + 0.05)))
    for i in shocks:
        y = G['rw_y'][i]
        d = arm_dir[i]
        H.add(tube([(s * (low_x + 0.09), y + 0.28 * d, G['rw_z'] + G['rw_r'] + 0.12), (s * (low_x + 0.1), y + 0.02 * d, G['rw_z'] + 0.08)], 0.03, 8, 'gunmetal'))
        H.add(cyl(0.04, 0.05, 8, 'x', c=(s * (low_x + 0.09), y + 0.28 * d, G['rw_z'] + G['rw_r'] + 0.12)))
    rr = return_roller(G['rr_r'])
    for y in G['rr_y']:
        H.add(cyl(0.04, 0.16, 10, 'x', c=(s * (low_x + 0.08), y, G['rr_z'])))
        H.add(L._bcopy(rr), Matrix.Translation((s * G['trk_x'], y, G['rr_z'])))
    # final drive housing + idler crank
    H.add(cyl(G['spr'][2] * 0.55, 0.16, 20, 'x', c=(s * (low_x + 0.07), G['spr'][0], G['spr'][1]), bev=0.012))
    idl = G['idl']
    H.add(cyl(idl[2] * 0.42, 0.18, 16, 'x', c=(s * (low_x + 0.08), idl[0], idl[1]), bev=0.01))
    dy = -0.2 if idl[0] > 0 else 0.2
    H.add(box(0.07, 0.3, 0.09, c=(s * (low_x + 0.08), idl[0] + dy, idl[1] + 0.05), bev=0.01, segs=1))

def add_running_gear(G, hullE, style):
    parts = {'road': road_wheel(G['rw_r'], G['rw_hw'], style), 'spr': sprocket(G['spr'][2], G['spr'][3], G['spr_gap']),
             'idl': idler(G['idl'][2], G['spr_gap'])}
    meshes = {}
    objs = []
    def wheel(name, key, side, c):
        e = L.node_empty(name, hullE, c)
        mk = key + ('R' if side > 0 else 'L')
        if mk not in meshes:
            p = L._bcopy(parts[key])
            if side < 0:
                p.scale(-1, 1, 1)
            p.move(*c)
            o = L.node_mesh(name + '_geo', p, e, c)
            o.data.name = style + '_' + mk
            meshes[mk] = o.data
        else:
            o = L.node_mesh(name + '_geo', None, e, c, mesh=meshes[mk])
        objs.append(o)
    for side, tag in ((1, 'R'), (-1, 'L')):
        for i, y in enumerate(G['rw_y']):
            wheel(f'roadwheel_{tag}{i + 1}', 'road', side, (side * G['trk_x'], y, G['rw_z']))
        wheel(f'sprocket_{tag}', 'spr', side, (side * G['trk_x'], G['spr'][0], G['spr'][1]))
        wheel(f'idler_{tag}', 'idl', side, (side * G['trk_x'], G['idl'][0], G['idl'][1]))
    tracks = []
    for side, tag in ((1, 'R'), (-1, 'L')):
        tb, pitch, Lt, links = track_band(G, side)
        tracks.append(L.node_mesh(f'track_{tag}', tb, hullE, (0, 0, 0), sharp=80))
    return objs, tracks, pitch, Lt, links

def turret_ring_collar(H, ty, z, r):
    H.add(lathe([(r, 0), (r + 0.05, 0), (r + 0.05, 0.035), (r - 0.02, 0.05)], 48, 'z', c=(0, ty, z)))

# ================================================================================================ BMP-3
B3 = dict(BELLY=0.45, ROOF=1.70, SPON=1.14, LOW_X=1.07, UP_X=1.56, ROOF_X=1.49, NOSE=(3.34, 1.28), GL=(1.90, 1.70),
          REAR=-3.36, REAR_LOW=0.80, BELLY_R=-3.08, BELLY_F=2.78, TY=0.30)
G3 = dict(trk_x=1.33, trk_w=0.38, band=0.05, horn=(0.04, 0.07), rw_r=0.29, rw_hw=0.15, rw_z=0.34,
          rw_y=[1.66, 0.88, 0.06, -0.74, -1.52, -2.30], idl=(2.62, 0.66, 0.23), spr=(-3.02, 0.66, 0.25, 15), spr_gap=0.06,
          rr_y=[1.25, -0.32, -1.90], rr_z=0.835, rr_r=0.085, sag=0.025, pitch=0.137)

def b3_x_side(z):
    """Upper hull side plate x at height z (6 deg tumblehome)."""
    c = B3
    return c['UP_X'] - (z - c['SPON']) * (c['UP_X'] - c['ROOF_X']) / (c['ROOF'] - c['SPON'])

B3_TILT = math.degrees(math.atan2(B3['UP_X'] - B3['ROOF_X'], B3['ROOF'] - B3['SPON']))

def bmp3_hull():
    c = B3
    NOSE, GL = c['NOSE'], c['GL']
    lo = []
    for s in (1, -1):
        lo += [(s * c['LOW_X'], c['BELLY_R'], c['BELLY']), (s * c['LOW_X'], c['BELLY_F'], c['BELLY']),
               (s * c['LOW_X'], NOSE[0] - 0.03, NOSE[1] - 0.06), (s * c['LOW_X'], c['REAR'], c['REAR_LOW']),
               (s * c['LOW_X'], c['REAR'], c['SPON'] + 0.02), (s * c['LOW_X'], NOSE[0] - 0.2, c['SPON'] + 0.02)]
    H = hull(lo, bev=0.02, segs=2)
    up = []
    for s in (1, -1):
        up += [(s * c['UP_X'], c['REAR'], c['SPON']), (s * c['UP_X'], 3.0, c['SPON']), (s * 1.53, 3.12, 1.25),
               (s * 1.30, NOSE[0], NOSE[1]), (s * c['ROOF_X'], GL[0], c['ROOF']), (s * c['ROOF_X'], c['REAR'], c['ROOF'])]
    H.add(hull(up, bev=0.022, segs=2))
    # weld seams on the main joints
    _, gn, gd = slope_frame(NOSE, GL)
    H.add(tube([(-1.27, NOSE[0] - 0.005, NOSE[1] + 0.004), (1.27, NOSE[0] - 0.005, NOSE[1] + 0.004)], 0.008, 5))
    H.add(tube([(-c['ROOF_X'] + 0.02, GL[0] + 0.004, c['ROOF'] + 0.003), (c['ROOF_X'] - 0.02, GL[0] + 0.004, c['ROOF'] + 0.003)], 0.008, 5))
    for s in (1, -1):
        H.add(tube([(s * (c['ROOF_X'] - 0.004), GL[0] - 0.02, c['ROOF'] - 0.004), (s * (c['ROOF_X'] - 0.004), c['REAR'] + 0.03, c['ROOF'] - 0.004)], 0.007, 5))
        H.add(tube([(s * (c['UP_X'] - 0.004), c['REAR'] + 0.02, c['SPON'] + 0.004), (s * (c['UP_X'] - 0.004), 2.98, c['SPON'] + 0.004)], 0.007, 5))
    H.add(box(2.8, 0.02, 0.01, c=(0, -0.9, c['ROOF'] + 0.002)))           # roof plate seam ahead of the troop roof
    H.add(box(2.8, 0.02, 0.01, c=(0, -2.0, c['ROOF'] + 0.002)))           # engine deck seam
    return H

def bmp3_glacis(H):
    c = B3
    NOSE, GL = c['NOSE'], c['GL']
    M, gn, gd = slope_frame(NOSE, GL)
    M3 = M.to_3x3().to_4x4()
    # folded trim vane (wave breaker) covering the centre of the glacis, hinged at the bow edge
    tv = B()
    tv.add(prism([(-0.78, 0.05), (0.78, 0.05), (0.72, 0.92), (-0.72, 0.92)], 0.028, 'z', c=0.05, bev=0.008, segs=1))
    tv.add(box(1.46, 0.035, 0.05, c=(0, 0.91, 0.085), bev=0.006, segs=1))
    tv.add(box(1.5, 0.035, 0.045, c=(0, 0.07, 0.08), bev=0.006, segs=1))
    for x in (-0.5, -0.17, 0.17, 0.5):
        tv.add(box(0.03, 0.82, 0.028, c=(x, 0.48, 0.076), bev=0.006, segs=1))
    tv.add(box(1.44, 0.03, 0.026, c=(0, 0.5, 0.075), bev=0.005, segs=1))
    for x in (-0.6, -0.2, 0.2, 0.6):
        tv.add(cyl(0.028, 0.14, 10, 'x', c=(x, 0.04, 0.035)))
    for x in (-0.55, 0.55):
        tv.add(box(0.06, 0.07, 0.05, c=(x, 0.7, 0.025)))
        tv.add(tube([(x * 1.35, 0.1, 0.03), (x * 1.3, 0.8, 0.05)], 0.015, 6, 'bare'))
    tv.add(rail([(-0.12, 0.78, 0.075), (-0.12, 0.78, 0.12), (0.12, 0.78, 0.12), (0.12, 0.78, 0.075)], r=0.01, rad=0.02))
    H.add(tv, L.place(M3, plate_pt(NOSE, GL, 0, 0.0)))
    # bow PKT ball mounts in armoured housings in the front corners (firing forward)
    mg_pts = {}
    for s in (1, -1):
        p = plate_pt(NOSE, GL, s * 1.07, 0.32, 0.0)
        hs = hull([(s * 0.92, p.y - 0.15, p.z - 0.02), (s * 1.24, p.y - 0.15, p.z - 0.02), (s * 0.92, p.y + 0.12, p.z - 0.06),
                   (s * 1.24, p.y + 0.12, p.z - 0.06), (s * 0.95, p.y - 0.05, p.z + 0.2), (s * 1.21, p.y - 0.05, p.z + 0.2),
                   (s * 0.95, p.y + 0.06, p.z + 0.16), (s * 1.21, p.y + 0.06, p.z + 0.16)], bev=0.02, segs=2)
        H.add(hs)
        H.add(lathe([(0, 0.0), (0.085, 0.0), (0.09, 0.03), (0.075, 0.07), (0.0, 0.08)], 16, 'y', c=(s * 1.08, p.y + 0.1, p.z + 0.08)))
        H.add(cyl(0.022, 0.12, 8, 'y', c=(s * 1.08, p.y + 0.22, p.z + 0.08), mat='gunmetal'))
        H.add(cyl(0.012, 0.18, 8, 'y', c=(s * 1.08, p.y + 0.36, p.z + 0.08), mat='gunmetal'))
        H.add(cyl(0.017, 0.05, 8, 'y', c=(s * 1.08, p.y + 0.46, p.z + 0.08), mat='gunmetal'))
        mg_pts[s] = (s * 1.08, p.y + 0.49, p.z + 0.08)
        # periscope over the bow gunner position
        H.add(periscope_block(0.15, 0.09, 0.06), Matrix.Translation(tuple(plate_pt(NOSE, GL, s * 0.86, 0.78, 0.0))))
        # headlights on the outer front corners + tow hooks at the nose
        H.add(headlight_cluster(s), L.place(Matrix.Identity(4), plate_pt(NOSE, GL, s * 1.33, 0.1, 0.0) + V((0, 0, 0.01))))
        H.add(tow_hook().rot('X', -25), Matrix.Translation((s * 0.68, NOSE[0] - 0.05, NOSE[1] - 0.12)))
        # bow gunner hatches (round, top of the glacis corners)
        H.add(lathe([(0, 0.04), (0.22, 0.036), (0.25, 0.016), (0.26, 0.0)], 24, 'z').xf(M3), Matrix.Translation(tuple(plate_pt(NOSE, GL, s * 0.88, 0.9, 0.0))))
    # driver: hatch in the centre at the top of the glacis + 3 periscopes ahead
    H.add(lathe([(0, 0.045), (0.24, 0.04), (0.27, 0.018), (0.28, 0.0)], 24, 'z').xf(M3), Matrix.Translation(tuple(plate_pt(NOSE, GL, 0, 0.9, 0.0))))
    for i, x in enumerate((-0.2, 0.0, 0.2)):
        Mp = Matrix.Translation(tuple(plate_pt(NOSE, GL, x, 0.74, 0.0))) @ Matrix.Rotation(math.radians(-x * 60), 4, 'Z')
        H.add(periscope_block(0.16, 0.09, 0.065), Mp)
    # splash board ahead of the periscopes
    H.add(box(1.0, 0.03, 0.09, bev=0.006, segs=1), L.place(M3, plate_pt(NOSE, GL, 0, 0.6, 0.045)))
    # lower bow: lifting eyes + belly plate seam
    for x in (-0.45, 0.45):
        H.add(lathe([(0.03, -0.015), (0.055, -0.015), (0.055, 0.015), (0.03, 0.015)], 12, 'x', cap=False, c=(x, 3.12, 0.95)))
    return mg_pts

def bmp3_side_skirt(H, s):
    """Segmented screen over the upper run (z 0.80 - SPON) + front mudguard + rubber flaps."""
    c = B3
    x = s * (c['UP_X'] + 0.012)
    z0, z1 = c['SPON'] + 0.01, 0.80
    ys = np.linspace(-3.0, 2.82, 6)
    for i in range(5):
        ya, yb = ys[i] + 0.008, ys[i + 1] - 0.008
        yc = (ya + yb) / 2
        H.add(box(0.014, yb - ya, z0 - z1, c=(x, yc, (z0 + z1) / 2), bev=0.004, segs=1))
        # stamped rectangular cells (the band seen on the drawing)
        n = 5
        cw = (yb - ya) / n
        for k in range(n):
            yy = ya + cw * (k + 0.5)
            H.add(box(0.012, cw - 0.05, 0.17, c=(x + s * 0.012, yy, z1 + 0.15), bev=0.004, segs=1))
        H.add(box(0.03, yb - ya, 0.035, c=(x + s * 0.012, yc, z0 - 0.025)))
        for yy in np.linspace(ya + 0.08, yb - 0.08, 4):
            H.add(bolt(0.011, 0.008, 6).rot('Y', 90 * s), Matrix.Translation((x + s * 0.028, yy, z0 - 0.025)))
        H.add(box(0.026, yb - ya, 0.02, c=(x + s * 0.008, yc, z1 + 0.01)))
    # front mudguard over the idler sloping down + rubber flap
    H.add(prism([(2.82, z0), (3.1, 1.24), (3.1, 1.2), (2.82, z0 - 0.04)], 0.3, 'x', c=s * (c['UP_X'] - 0.13), bev=0.006, segs=1))
    H.add(box(0.34, 0.01, 0.14, c=(s * G3['trk_x'], 2.98, 0.96), mat='skirt', bev=0.003, segs=1))
    H.add(box(0.36, 0.012, 0.2, c=(s * G3['trk_x'], -3.32, 0.78), mat='skirt', bev=0.004, segs=1))

def bmp3_sides(H, s, hit):
    c = B3
    M = side_frame(s, B3_TILT)
    def on_side(y, z, off=0.0):
        return V((s * (b3_x_side(z) + off), y, z))
    # firing ports (2 per side) with roof-edge vision blocks above
    for y in (0.15, -1.25):
        fp = firing_port()
        fp.add(cyl(0.1, 0.022, 16, 'z', c=(0, 0.2, 0.012)))
        H.add(fp, L.place(M, on_side(y, 1.40)))
        H.add(periscope_block(0.15, 0.085, 0.06), Matrix.Translation((s * (c['ROOF_X'] - 0.08), y, c['ROOF'] - 0.01)) @ Matrix.Rotation(-s * math.pi / 2, 4, 'Z'))
    # tow cable, grab handles, crowbar + shovel
    H.add(tow_cable(on_side(1.55, 1.27, 0.035), on_side(-0.55, 1.27, 0.035)))
    for y in (1.3, 0.6, -0.2):
        H.add(box(0.05, 0.06, 0.05), L.place(M, on_side(y, 1.27, 0.02)))
    H.add(rail([on_side(-1.6, 1.6), on_side(-1.6, 1.6, 0.06), on_side(-2.4, 1.6, 0.06), on_side(-2.4, 1.6)], r=0.011, rad=0.03))
    if s > 0:
        H.add(tool_shovel(), L.place(M, on_side(-1.9, 1.3, 0.03)))
    else:
        H.add(tube([on_side(-1.4, 1.3, 0.03), on_side(-2.5, 1.3, 0.03)], 0.016, 6, 'bare'))
    # spare-parts box on the rear sponson top edge
    H.add(box(0.36, 0.7, 0.2, c=(s * (c['ROOF_X'] - 0.24), -2.75, c['ROOF'] + 0.1), bev=0.015, segs=2))
    H.add(box(0.38, 0.72, 0.02, c=(s * (c['ROOF_X'] - 0.24), -2.75, c['ROOF'] + 0.2), bev=0.005, segs=1))
    # marker light on the front corner
    loc, nrm = hit((s * 2.5, 2.9, 1.2), (-s, 0, 0))
    if loc is not None:
        ml = cyl(0.035, 0.05, 10, 'z')
        ml.add(cyl(0.028, 0.008, 10, 'z', c=(0, 0, 0.028), mat='light'))
        H.add(ml, L.place(L.frame_from_normal(nrm), loc))

def bmp3_roof_rear(H):
    c = B3
    R = c['ROOF']
    turret_ring_collar(H, c['TY'], R, 0.98)
    # engine air intake grilles on both sides of the troop passage, fan cover, exhaust louvre (left)
    for s in (1, -1):
        H.add(louvre_panel(0.56, 1.0, 10), Matrix.Translation((s * 1.0, -2.6, R)))
        H.add(lathe([(0, 0.05), (0.09, 0.045), (0.12, 0.02), (0.12, 0)], 16, 'z', c=(s * 1.0, -1.75, R)))
        H.add(antenna_base(), Matrix.Translation((s * 1.25, -1.6, R)))
        H.add(grab((s * 0.8, -1.15, R), (s * 0.8, -1.55, R)))
    exh = box(0.3, 0.6, 0.08, c=(-1.25, -3.0, R + 0.04), bev=0.012, segs=1)
    for i in range(5):
        exh.add(box(0.26, 0.02, 0.02, c=(-1.25, -3.24 + i * 0.11, R + 0.085), mat='gunmetal'))
    H.add(exh)
    # roof hatch frames over the passage (the hatches themselves are animated nodes)
    for s in (1, -1):
        H.add(box(0.64, 0.04, 0.03, c=(s * 0.31, -2.5, R + 0.015)))
        H.add(box(0.04, 0.84, 0.03, c=(s * 0.64, -2.93, R + 0.015)))
    H.add(box(0.04, 0.84, 0.03, c=(0, -2.93, R + 0.015)))
    # tarp roll across the roof behind the turret
    H.add(cyl(0.12, 1.5, 14, 'x', c=(0, -1.0, R + 0.12), mat='canvas'))
    for x in (-0.5, 0.0, 0.5):
        H.add(lathe([(0.124, -0.02), (0.13, -0.02), (0.13, 0.02), (0.124, 0.02)], 14, 'x', c=(x, -1.0, R + 0.12), mat='bare', cap=False))
    # field stowage typical of 2022-24 photos: ammo crates + rolled camouflage net on the rear deck
    for (x, y, rz) in ((0.5, -1.4, 4), (0.55, -1.86, -6)):
        cr = box(0.42, 0.3, 0.2, c=(x, y, R + 0.1), mat='wood', bev=0.012, segs=1)
        cr.add(box(0.44, 0.04, 0.21, c=(x, y - 0.1, R + 0.1), mat='wood'))
        cr.add(box(0.44, 0.04, 0.21, c=(x, y + 0.1, R + 0.1), mat='wood'))
        cr.add(box(0.06, 0.32, 0.03, c=(x - 0.16, y, R + 0.21), mat='bare'))
        H.add(cr.rot('Z', rz, (x, y, R)))
    net = lathe([(0.0, -0.75), (0.15, -0.72), (0.17, -0.6), (0.18, 0.0), (0.17, 0.6), (0.15, 0.72), (0.0, 0.75)], 12, 'x', mat='canvas',
                c=(-0.55, -1.68, R + 0.15))
    H.add(net)
    for x in (-1.0, -0.55, -0.1):
        H.add(lathe([(0.16, -0.025), (0.172, -0.025), (0.172, 0.025), (0.16, 0.025)], 12, 'x', c=(x, -1.68, R + 0.15), mat='bare', cap=False))
    # rear plate: water-jet outlets with louvred flaps in the rear of the sponsons, lights, hooks
    Y = c['REAR']
    for s in (1, -1):
        wj = box(0.42, 0.06, 0.34, c=(s * 1.18, Y - 0.03, 1.32), bev=0.01, segs=1)
        for k in range(4):
            wj.add(box(0.36, 0.02, 0.05, c=(s * 1.18, Y - 0.07, 1.2 + k * 0.08), mat='gunmetal').rot('X', -30, (s * 1.18, Y - 0.07, 1.2 + k * 0.08)))
        wj.add(cyl(0.025, 0.4, 8, 'x', c=(s * 1.18, Y - 0.06, 1.5)))
        H.add(wj)
        rl = box(0.16, 0.05, 0.09, c=(s * 1.32, Y - 0.025, 1.6), bev=0.008, segs=1)
        rl.add(box(0.12, 0.01, 0.05, c=(s * 1.32, Y - 0.052, 1.6), mat='light'))
        H.add(rl)
        H.add(tow_hook().rot('Z', 180), Matrix.Translation((s * 0.82, Y - 0.02, 0.95)))
        # folding steps under the doors
        H.add(box(0.4, 0.2, 0.025, c=(s * 0.31, Y - 0.1, 0.84), bev=0.005, segs=1))
        H.add(box(0.03, 0.18, 0.08, c=(s * 0.12, Y - 0.08, 0.88)))
    # dark doorway / hatch openings behind the animated doors (seen only when they are open)
    H.add(box(1.22, 0.01, 0.74, c=(0, Y - 0.004, 1.26), mat='gunmetal'))
    H.add(box(1.22, 0.8, 0.01, c=(0, -2.93, R + 0.006), mat='gunmetal'))
    # door frame on the rear plate
    H.add(box(1.32, 0.03, 0.04, c=(0, Y - 0.012, 1.66)))
    H.add(box(1.32, 0.03, 0.04, c=(0, Y - 0.012, 0.86)))

def bmp3_rear_doors():
    """Two rear doors (hinged on their outer edges) + two roof hatches over the passage (hinged at the front)."""
    c = B3
    Y = c['REAR']
    out = {}
    for s, tag in ((1, 'R'), (-1, 'L')):
        hx = s * 0.635
        d = box(0.58, 0.06, 0.74, c=(s * 0.33, Y - 0.03, 1.26), bev=0.012, segs=2)
        d.add(box(0.5, 0.02, 0.62, c=(s * 0.33, Y - 0.065, 1.26), bev=0.006, segs=1))       # stiffening pan
        for zz in (1.0, 1.52):
            d.add(cyl(0.028, 0.12, 10, 'z', c=(hx, Y - 0.05, zz)))
            d.add(box(0.16, 0.02, 0.07, c=(hx - s * 0.07, Y - 0.07, zz)))
        d.add(rail([(s * 0.1, Y - 0.07, 1.36), (s * 0.1, Y - 0.13, 1.36), (s * 0.1, Y - 0.13, 1.2), (s * 0.1, Y - 0.07, 1.2)], r=0.011, rad=0.02))
        vb = box(0.14, 0.05, 0.1, c=(s * 0.38, Y - 0.085, 1.5), bev=0.008, segs=1)
        vb.add(box(0.1, 0.01, 0.05, c=(s * 0.38, Y - 0.112, 1.5), mat='glass'))
        d.add(vb)
        if s < 0:
            fp = firing_port().scale(0.8)
            d.add(fp, L.place(L.frame_from_normal(V((0, -1, 0))), V((s * 0.36, Y - 0.07, 1.17))))
        out['door_rear_' + tag] = (d, (hx, Y - 0.03, 1.26))
        # roof hatch over the passage: hinge at the front edge (y = -2.52)
        hz = c['ROOF'] + 0.03
        h = box(0.58, 0.8, 0.035, c=(s * 0.31, -2.93, hz + 0.0175), bev=0.008, segs=1)
        for xx in (0.12, 0.5):
            h.add(cyl(0.025, 0.11, 10, 'x', c=(s * xx, -2.53, hz + 0.02)))
        h.add(box(0.5, 0.03, 0.03, c=(s * 0.31, -2.75, hz + 0.05)))
        h.add(box(0.5, 0.03, 0.03, c=(s * 0.31, -3.1, hz + 0.05)))
        h.add(rail([(s * 0.22, -3.2, hz + 0.035), (s * 0.22, -3.2, hz + 0.09), (s * 0.4, -3.2, hz + 0.09), (s * 0.4, -3.2, hz + 0.035)], r=0.01, rad=0.025))
        out['roof_door_' + tag] = (h, (s * 0.31, -2.53, hz + 0.02))
    return out

def bmp3_side_screens():
    """2022-24 add-on side protection: bolted steel plates over the upper hull side (toggle node side_screens)."""
    c = B3
    Sc = B()
    for s in (1, -1):
        M = side_frame(s, B3_TILT)
        segs = [(-3.0, -1.55), (-1.45, -0.1), (0.0, 1.45), (1.55, 2.75)]
        for (ya, yb) in segs:
            yc, ln = (ya + yb) / 2, yb - ya
            zc = 1.42
            p = V((s * (b3_x_side(zc) + 0.045), yc, zc))
            pl = box(ln - 0.02, 0.44, 0.03, bev=0.008, segs=1)
            # cut-outs suggested by port frames
            for yy in (0.15, -1.25):
                if ya < yy < yb:
                    off = (yy - yc) * (1 if s > 0 else -1)
                    pl.add(lathe([(0.13, -0.02), (0.16, -0.02), (0.16, 0.03), (0.13, 0.03)], 16, 'z', c=(off, -0.02, 0.0), cap=False))
            n_b = max(3, int(ln / 0.32))
            for k in range(n_b):
                xx = -ln / 2 + 0.08 + k * (ln - 0.16) / (n_b - 1)
                for yy in (-0.18, 0.18):
                    pl.add(bolt(0.016, 0.012, 6), Matrix.Translation((xx, yy, 0.015)))
            Sc.add(pl, L.place(M, p))
            # stand-off brackets
            for yy in (ya + 0.1, yb - 0.1):
                Sc.add(box(0.05, 0.06, 0.32, c=(s * (b3_x_side(zc) + 0.02), yy, zc)))
    return Sc

def bmp3_turret():
    """Low wide welded turret, origin = ring centre on the roof."""
    T_ = B()
    bot = [(-0.55, 1.15), (0.55, 1.15), (1.02, 0.6), (1.05, -0.45), (0.8, -0.85), (-0.8, -0.85), (-1.05, -0.45), (-1.02, 0.6)]
    top = [(-0.42, 0.9), (0.42, 0.9), (0.86, 0.42), (0.88, -0.42), (0.66, -0.74), (-0.66, -0.74), (-0.88, -0.42), (-0.86, 0.42)]
    T_.add(hull([(x, y, 0.0) for x, y in bot] + [(x, y, 0.56) for x, y in top], mat='rolled', bev=0.022, segs=2, angle=20))
    tb = L.bvh_of(T_)
    # mantlet slot frame
    T_.add(box(0.92, 0.1, 0.44, c=(0, 1.04, 0.21), bev=0.02, segs=2))
    # weld seams along the turret edges + roof plate bolts
    for i in range(len(top)):
        a, b_ = top[i], top[(i + 1) % len(top)]
        T_.add(tube([(a[0], a[1], 0.562), (b_[0], b_[1], 0.562)], 0.007, 5))
    for x in np.linspace(-0.5, 0.5, 5):
        T_.add(bolt(0.012, 0.009), Matrix.Translation((x, -0.6, 0.56)))
    # gunner's 1K13-2 sight (left front) in an armoured hood with a shutter
    gx = -0.52
    s1 = box(0.3, 0.38, 0.28, c=(gx, 0.42, 0.7), bev=0.022, segs=2)
    s1.add(box(0.22, 0.012, 0.13, c=(gx, 0.612, 0.72), mat='glass'))
    s1.add(box(0.32, 0.16, 0.018, c=(gx, 0.64, 0.86)).rot('X', -20, (gx, 0.6, 0.85)))
    for x in (gx - 0.16, gx + 0.16):
        s1.add(box(0.02, 0.1, 0.22, c=(x, 0.6, 0.72)))
    s1.add(box(0.24, 0.26, 0.06, c=(gx, 0.4, 0.58)))
    T_.add(s1)
    # PPB day sight head beside it
    T_.add(box(0.12, 0.14, 0.12, c=(-0.24, 0.55, 0.62), bev=0.012, segs=1))
    T_.add(box(0.09, 0.01, 0.05, c=(-0.24, 0.622, 0.63), mat='glass'))
    # commander's cupola (right) with TKN sight + periscopes, gunner's hatch (left)
    cx, cy = 0.46, -0.12
    cu = lathe([(0, 0.0), (0.36, 0.0), (0.36, 0.05), (0.33, 0.11), (0.0, 0.11)], 28, 'z', c=(cx, cy, 0.56))
    cu.add(lathe([(0, 0.05), (0.26, 0.045), (0.29, 0.02), (0.30, 0.0)], 24, 'z', c=(cx, cy, 0.67)))
    cu.add(rail([(cx - 0.1, cy - 0.05, 0.72), (cx - 0.1, cy - 0.05, 0.76), (cx + 0.1, cy - 0.05, 0.76), (cx + 0.1, cy - 0.05, 0.72)], r=0.01, rad=0.025))
    for ang in (40, 140, 200, 340):
        a = math.radians(ang)
        cu.add(periscope_block(0.12, 0.07, 0.05), Matrix.Translation((cx + 0.31 * math.cos(a), cy + 0.31 * math.sin(a), 0.63)) @ Matrix.Rotation(a - math.pi / 2, 4, 'Z'))
    cu.add(box(0.22, 0.2, 0.2, c=(cx, cy + 0.36, 0.72), bev=0.02, segs=2))
    cu.add(box(0.16, 0.012, 0.08, c=(cx, cy + 0.462, 0.75), mat='glass'))
    cu.add(box(0.26, 0.1, 0.016, c=(cx, cy + 0.46, 0.83)))
    T_.add(cu)
    T_.add(lathe([(0, 0.045), (0.23, 0.04), (0.26, 0.018), (0.27, 0.0)], 24, 'z', c=(-0.42, -0.2, 0.56)))
    T_.add(rail([(-0.52, -0.2, 0.6), (-0.52, -0.2, 0.64), (-0.32, -0.2, 0.64), (-0.32, -0.2, 0.6)], r=0.01, rad=0.025))
    T_.add(periscope_block(0.13, 0.08, 0.055), Matrix.Translation((-0.75, -0.05, 0.555)) @ Matrix.Rotation(math.radians(70), 4, 'Z'))
    # 902V Tucha: 3 per side on the front corners, firing forward-up-outward
    for s in (1, -1):
        c0 = V((s * 0.9, 0.62, 0.36))
        br = box(0.1, 0.42, 0.12, bev=0.006, segs=1)
        T_.add(br, Matrix.Translation(c0) @ Matrix.Rotation(math.radians(s * -48), 4, 'Z'))
        for i in range(3):
            p = c0 + V((s * 0.06, 0.0, 0.07)) + V((math.sin(math.radians(s * 48)), math.cos(math.radians(48)), 0)) * ((i - 1) * 0.12)
            d = V((s * (0.35 + 0.1 * i), 1.0, 0.7))
            T_.add(tucha_tube(), Matrix.Translation(p) @ align_y(d))
    # laser warning sensors, wind sensor, antenna, lifting eyes, handrails
    for s in (1, -1):
        T_.add(box(0.08, 0.08, 0.06, c=(s * 0.72, 0.5, 0.59), bev=0.01, segs=1))
        T_.add(lathe([(0.03, -0.012), (0.05, -0.012), (0.05, 0.012), (0.03, 0.012)], 12, 'y', cap=False), Matrix.Translation((s * 0.8, -0.3, 0.6)))
        T_.add(rail([(s * 0.92, 0.1, 0.32), (s * 0.95, 0.1, 0.32), (s * 0.95, -0.4, 0.3), (s * 0.92, -0.4, 0.3)], r=0.011, rad=0.03))
    T_.add(cyl(0.012, 0.32, 6, 'z', c=(-0.5, -0.55, 0.72), mat='gunmetal'))
    T_.add(cyl(0.03, 0.05, 8, 'z', c=(-0.5, -0.55, 0.9)))
    T_.add(antenna_base(), Matrix.Translation((0.55, -0.6, 0.56)))
    # rear stowage box + side boxes
    T_.add(box(1.2, 0.26, 0.3, c=(0, -0.94, 0.3), bev=0.015, segs=2))
    T_.add(box(1.22, 0.28, 0.025, c=(0, -0.94, 0.46), bev=0.005, segs=1))
    for x in (-0.4, 0.4):
        T_.add(rail([(x, -1.06, 0.38), (x, -1.11, 0.38), (x, -1.11, 0.25), (x, -1.06, 0.25)], r=0.008, rad=0.02))
    for s in (1, -1):
        T_.add(box(0.14, 0.5, 0.24, c=(s * 1.02, -0.3, 0.2), bev=0.015, segs=2).rot('Z', s * 8, (s * 1.02, -0.3, 0.2)))
    return T_

def bmp3_gun():
    """2A70 100 mm + 2A72 30 mm (right) + PKT (left) on a common cradle behind a big mantlet. Origin = trunnion."""
    g = B()
    g.add(hull([(-0.40, -0.05, -0.17), (0.42, -0.05, -0.17), (-0.40, -0.05, 0.22), (0.42, -0.05, 0.22),
                (-0.35, 0.50, -0.13), (0.37, 0.50, -0.13), (-0.35, 0.44, 0.18), (0.37, 0.44, 0.18)], bev=0.025, segs=2))
    g.add(box(0.86, 0.16, 0.06, c=(0.01, 0.12, 0.25), bev=0.012, segs=1))                 # top deflector lip
    for x in (-0.3, 0.32):
        for z in (-0.09, 0.12):
            g.add(bolt(0.014, 0.01).rot('X', -90), Matrix.Translation((x, 0.5 if z < 0 else 0.45, z)))
    # 100 mm: recoil sleeve, barrel, muzzle swell
    g.add(lathe([(0, 0.45), (0.12, 0.45), (0.12, 0.6), (0.1, 0.64), (0.1, 0.95), (0.088, 1.0), (0.081, 2.52), (0.091, 2.56),
                 (0.091, 2.65), (0.052, 2.65), (0.052, 2.6), (0.0, 2.6)], 22, 'y'))
    for y in (0.74, 0.88):
        g.add(cyl(0.104, 0.025, 22, 'y', c=(0, y, 0)))
    # 30 mm 2A72 (right): jacket + long thin barrel + muzzle brake
    ax = 0.25
    g.add(lathe([(0, 0.45), (0.06, 0.45), (0.06, 0.84), (0.045, 0.88), (0, 0.88)], 14, 'y', c=(ax, 0, 0)))
    for i in range(3):
        g.add(cyl(0.064, 0.022, 14, 'y', c=(ax, 0.55 + i * 0.12, 0)))
    g.add(cyl(0.022, 1.36, 12, 'y', c=(ax, 1.54, 0), mat='gunmetal'))
    g.add(lathe([(0.0, 0), (0.034, 0), (0.038, 0.02), (0.038, 0.15), (0.032, 0.17), (0, 0.17)], 12, 'y', mat='gunmetal', c=(ax, 2.21, 0)))
    for i in range(3):
        g.add(box(0.085, 0.02, 0.012, c=(ax, 2.26 + i * 0.04, 0), mat='gunmetal'))
    # PKT coax (left)
    px = -0.26
    g.add(cyl(0.03, 0.1, 10, 'y', c=(px, 0.53, -0.03), mat='gunmetal'))
    g.add(cyl(0.012, 0.18, 8, 'y', c=(px, 0.66, -0.03), mat='gunmetal'))
    g.add(cyl(0.016, 0.04, 8, 'y', c=(px, 0.76, -0.03), mat='gunmetal'))
    return g, (0, 2.65, 0), (ax, 2.38, 0), (px, 0.78, -0.03)

def build_bmp3():
    t0 = time.time()
    L.reset()
    c = B3
    root = L.node_empty('root')
    hullE = L.node_empty('hull', root, (0, 0, 0))
    H = bmp3_hull()
    shell_bvh = L.bvh_of(H)
    def hit(o, d):
        h = shell_bvh.ray_cast(V(o), V(d).normalized())
        return h[0], h[1]
    mg = bmp3_glacis(H)
    for s in (1, -1):
        bmp3_side_skirt(H, s)
        bmp3_sides(H, s, hit)
        suspension(G3, H, c['LOW_X'], s, [1, 1, 1, -1, -1, -1], (0, 1, 5))
    bmp3_roof_rear(H)
    print('  hull tris', H.tris(), '%.1fs' % (time.time() - t0))
    full_bvh = L.bvh_of(H)
    hull_mesh = L.node_mesh('hull_geo', H, hullE, (0, 0, 0))
    scr_mesh = L.node_mesh('side_screens', bmp3_side_screens(), hullE, (0, 0, 0))
    # animated rear doors / roof hatches
    anim = []
    for name, (part, piv) in bmp3_rear_doors().items():
        e = L.node_empty(name, hullE, piv, 0.1)
        anim.append(L.node_mesh(name + '_geo', part, e, piv))
    # turret + gun
    tz = c['ROOF'] + 0.01
    TU = bmp3_turret().move(0, c['TY'], tz)
    turE = L.node_empty('turret', hullE, (0, c['TY'], tz))
    turE['traverse_deg_s'] = D.STATIC['bmp3']['mobility']['turret_traverse_deg_s']
    tur_mesh = L.node_mesh('turret_geo', TU, turE, (0, c['TY'], tz))
    trun = (0, c['TY'] + 0.85, tz + 0.17)
    gunE = L.node_empty('gun_pivot', turE, trun)
    gunE['elev_min_deg'], gunE['elev_max_deg'] = -5, 60
    Gm, mz, m30, cx = bmp3_gun()
    Gm.move(*trun)
    gun_mesh = L.node_mesh('gun_geo', Gm, gunE, trun)
    P = lambda o: (trun[0] + o[0], trun[1] + o[1], trun[2] + o[2])
    L.node_empty('muzzle', gunE, P(mz), 0.1)
    L.node_empty('muzzle_30', gunE, P(m30), 0.1)
    L.node_empty('coax_muzzle', gunE, P(cx), 0.1)
    L.node_empty('smoke_launchers', turE, (0, c['TY'] + 0.62, tz + 0.45))
    L.node_empty('hatch_commander', turE, (0.46, c['TY'] - 0.12, tz + 0.72), 0.12, )
    L.node_empty('commander_hatch', turE, (0.46, c['TY'] - 0.12, tz + 0.72), 0.12)
    L.node_empty('hatch_gunner', turE, (-0.42, c['TY'] - 0.2, tz + 0.62), 0.12)
    # running gear
    rg, tracks, pitch, Lt, links = add_running_gear(G3, hullE, 'bmp3')
    # empties
    gl = lambda x, t: tuple(plate_pt(c['NOSE'], c['GL'], x, t, 0.06))
    L.node_empty('hatch_driver', hullE, gl(0, 0.9), 0.12)
    L.node_empty('hatch_bow_L', hullE, gl(-0.88, 0.9), 0.12)
    L.node_empty('hatch_bow_R', hullE, gl(0.88, 0.9), 0.12)
    for s, tag in ((1, 'R'), (-1, 'L')):
        facing_empty('bow_mg_' + tag, hullE, mg[s], (0, 1), 0.08, traverse_deg=[-17, 17] if True else None)
    L.node_empty('exhaust', hullE, (-1.25, -3.0, c['ROOF'] + 0.12))
    facing_empty('exit_rear', hullE, (0, c['REAR'] - 1.0, 0.0), (0, -1), 0.25)
    facing_empty('dismount_L', hullE, (-2.2, -1.2, 0.0), (-1, 0))
    facing_empty('dismount_R', hullE, (2.2, -1.2, 0.0), (1, 0))
    specs = ([dict(x=s * 1.30, y=y, face=(s, 0), type='edge') for y in (-1.25, -2.15) for s in (1, -1)] +
             [dict(x=x, y=-3.0, face=(0, 1), type='deck') for x in (-0.62, 0.0, 0.62)])
    seats = S.place_seats(hullE, specs, full_bvh)
    blen = math.hypot(mz[1], mz[2])
    clr = S.clearance(seats, (0, c['TY'], tz), [tur_mesh], trun, blen, 60)
    print('  seats', [(s_['name'], round(s_['z'], 3)) for s_ in seats])
    print('  clearance', clr)
    VB.SOOT[:] = [((-1.25, -3.25, c['ROOF'] + 0.08), 0.5)]
    lod0 = [hull_mesh, scr_mesh, tur_mesh, gun_mesh] + anim + rg + tracks
    seen, uniq = set(), []
    for o in [hull_mesh, scr_mesh, tur_mesh, gun_mesh] + anim + rg:
        if o.data.name not in seen:
            uniq.append(o); seen.add(o.data.name)
    print('  geometry done %.1fs' % (time.time() - t0))
    return dict(root=root, hull=hullE, turret=turE, gun=gunE, lod0=lod0, atlas=uniq, tracks=tracks, pitch=pitch, track_len=Lt,
                links=links, seats=seats, clearance=clr, tur_objs=[tur_mesh, gun_mesh], gun_obj=gun_mesh,
                extra=dict(
                    animated_nodes={
                        'door_rear_L': 'left rear door, hinge on its outer vertical edge; open = rotation.y NEGATIVE (0 .. -1.75 rad)',
                        'door_rear_R': 'right rear door; open = rotation.y POSITIVE (0 .. +1.75 rad)',
                        'roof_door_L': 'left roof hatch over the troop passage, hinge at its front edge; open = rotation.x POSITIVE (0 .. +1.65 rad)',
                        'roof_door_R': 'right roof hatch over the troop passage; open = rotation.x POSITIVE (0 .. +1.65 rad)',
                        'turret': 'yaw about local Y', 'gun_pivot': 'pitch about local X; elevate = rotation.x NEGATIVE (preview.html uses -deg)'},
                    toggle_nodes={'side_screens': 'hull/side_screens (+LOD1): 2022-24 bolted add-on side armour; armour JSON hull.side '
                                                  'assumes fitted (25/40), use 15/25 without'},
                    empties={
                        'muzzle': '100 mm 2A70 / 9M117 ATGM launch point', 'muzzle_30': '30 mm 2A72', 'coax_muzzle': 'PKT coax',
                        'bow_mg_L / bow_mg_R': 'bow PKT ball-mount muzzles (hull), +Z = fire direction, extras.traverse_deg',
                        'smoke_launchers': 'turret', 'hatch_commander / commander_hatch / hatch_gunner': 'turret hatch rims',
                        'hatch_driver / hatch_bow_L / hatch_bow_R': 'hull hatch rims on the top of the glacis',
                        'exit_rear': 'ground point 1 m behind the rear doors, +Z faces away from the vehicle (dismount spawn)',
                        'dismount_L / dismount_R': 'crew bail-out ground points beside the hull, +Z facing out',
                        'exhaust': 'left rear deck exhaust louvre', 'ride_seat_1..7': 'desant seats (see ride_seats)'},
                    running_gear_radii_m=dict(roadwheel=G3['rw_r'], sprocket=G3['spr'][2], idler=G3['idl'][2]),
                    gun_limits_deg=dict(elevation=[-5, 60], traverse=360, bow_mg_traverse=[-17, 17]),
                ))

def wreck_generic(d):
    root = d['root']
    hw = VB.join_copies('hull_wreck', [o for o in d['lod0'] if o not in d['tur_objs']], root, (0, 0, 0),
                        drop_slots=('glass', 'light'), drop_z=0.04)
    g = d['gun_obj']
    g.rotation_euler = (math.radians(5), 0, 0)
    bpy.context.view_layer.update()
    tp = d['turret'].matrix_world.translation.copy()
    tw = VB.join_copies('turret_wreck', d['tur_objs'], root, tuple(tp), drop_slots=('glass', 'light'))
    g.rotation_euler = (0, 0, 0)
    tw.location.z -= 0.04
    bpy.context.view_layer.update()
    return [hw, tw]

# ================================================================================================ Bradley
BR = dict(BELLY=0.46, ROOF=1.98, SPON=1.20, LOW_X=0.92, UP_X=1.50, ROOF_X=1.48, NOSE=(3.22, 1.12), GL=(1.65, 1.98),
          REAR_T=-3.12, REAR_B=-3.24, REAR_LOW=0.62, BELLY_R=-3.0, BELLY_F=2.85, TY=0.05)
GB = dict(trk_x=1.22, trk_w=0.533, band=0.065, horn=(0.05, 0.075), rw_r=0.305, rw_hw=0.2, rw_z=0.37,
          rw_y=[1.85, 1.12, 0.39, -0.34, -1.07, -1.80], spr=(2.78, 0.78, 0.30, 11), spr_gap=0.075, idl=(-2.70, 0.52, 0.27),
          rr_y=[1.42, -0.05, -1.5], rr_z=0.93, rr_r=0.09, sag=0.03, pitch=0.152)

def br_rear_y(z):
    c = BR
    return c['REAR_B'] + (z - c['REAR_LOW']) * (c['REAR_T'] - c['REAR_B']) / (c['ROOF'] - c['REAR_LOW'])

def bradley_hull():
    c = BR
    NOSE, GL = c['NOSE'], c['GL']
    lo = []
    for s in (1, -1):
        lo += [(s * c['LOW_X'], c['BELLY_R'], c['BELLY']), (s * c['LOW_X'], c['BELLY_F'], c['BELLY']),
               (s * c['LOW_X'], NOSE[0] - 0.02, NOSE[1] - 0.04), (s * c['LOW_X'], c['REAR_B'], c['REAR_LOW']),
               (s * c['LOW_X'], br_rear_y(c['SPON'] + 0.02), c['SPON'] + 0.02), (s * c['LOW_X'], NOSE[0] - 0.1, c['SPON'] + 0.02)]
    H = hull(lo, bev=0.02, segs=2)
    up = []
    for s in (1, -1):
        up += [(s * c['UP_X'], br_rear_y(c['SPON']), c['SPON']), (s * c['UP_X'], 3.0, c['SPON']), (s * c['UP_X'], 3.1, 1.16),
               (s * 1.36, NOSE[0], NOSE[1]), (s * c['ROOF_X'], GL[0], c['ROOF']), (s * c['ROOF_X'], c['REAR_T'], c['ROOF'])]
    H.add(hull(up, bev=0.022, segs=2))
    H.add(tube([(-1.3, NOSE[0] - 0.004, NOSE[1] + 0.004), (1.3, NOSE[0] - 0.004, NOSE[1] + 0.004)], 0.009, 5))
    H.add(tube([(-c['ROOF_X'] + 0.02, GL[0] + 0.004, c['ROOF'] + 0.003), (c['ROOF_X'] - 0.02, GL[0] + 0.004, c['ROOF'] + 0.003)], 0.008, 5))
    H.add(tube([(-c['ROOF_X'] + 0.02, c['REAR_T'] + 0.006, c['ROOF'] + 0.003), (c['ROOF_X'] - 0.02, c['REAR_T'] + 0.006, c['ROOF'] + 0.003)], 0.008, 5))
    for s in (1, -1):
        H.add(tube([(s * (c['ROOF_X'] - 0.004), GL[0] - 0.02, c['ROOF'] - 0.004), (s * (c['ROOF_X'] - 0.004), c['REAR_T'] + 0.03, c['ROOF'] - 0.004)], 0.007, 5))
    H.add(box(2.9, 0.02, 0.01, c=(0, -1.2, c['ROOF'] + 0.002)))
    return H

def bradley_front(H):
    c = BR
    NOSE, GL = c['NOSE'], c['GL']
    M, gn, gd = slope_frame(NOSE, GL)
    M3 = M.to_3x3().to_4x4()
    # trim vane folded flat on the lower 60 % of the glacis
    tv = B()
    tv.add(prism([(-1.2, 0.06), (1.2, 0.06), (1.12, 1.05), (-1.12, 1.05)], 0.03, 'z', c=0.05, bev=0.008, segs=1))
    tv.add(box(2.24, 0.04, 0.05, c=(0, 1.04, 0.085), bev=0.006, segs=1))
    for x in (-0.84, -0.42, 0.0, 0.42, 0.84):
        tv.add(box(0.04, 0.94, 0.045, c=(x, 0.55, 0.085), bev=0.006, segs=1))
    for x in (-0.9, -0.3, 0.3, 0.9):
        tv.add(cyl(0.03, 0.16, 10, 'x', c=(x, 0.05, 0.035)))
    for x in (-1.0, 1.0):
        tv.add(tube([(x * 1.12, 0.12, 0.04), (x * 1.08, 0.95, 0.06)], 0.016, 6, 'bare'))
    H.add(tv, L.place(M3, plate_pt(NOSE, GL, 0, 0.0)))
    # engine grille (right) on the upper glacis + access panel
    H.add(louvre_panel(0.85, 0.5, 8).xf(M3), Matrix.Translation(tuple(plate_pt(NOSE, GL, 0.78, 0.8, 0.0))))
    H.add(box(0.75, 0.4, 0.02, bev=0.005, segs=1).xf(M3), Matrix.Translation(tuple(plate_pt(NOSE, GL, 0.85, 0.6, 0.012))))
    # driver: hatch on the roof front left + periscopes in an arc ahead + ODS-SA DVE thermal box
    H.add(lathe([(0, 0.045), (0.26, 0.04), (0.29, 0.018), (0.3, 0.0)], 24, 'z', c=(-0.78, 1.36, c['ROOF'])))
    H.add(rail([(-0.88, 1.2, c['ROOF'] + 0.05), (-0.88, 1.2, c['ROOF'] + 0.09), (-0.68, 1.2, c['ROOF'] + 0.09), (-0.68, 1.2, c['ROOF'] + 0.05)], r=0.01, rad=0.025))
    for ang in (-40, -15, 15, 40):
        a = math.radians(ang)
        p = (-0.78 + 0.36 * math.sin(a), 1.36 + 0.36 * math.cos(a), c['ROOF'] - 0.01)
        H.add(periscope_block(0.14, 0.085, 0.06), Matrix.Translation(p) @ Matrix.Rotation(-a, 4, 'Z'))
    dve = box(0.24, 0.22, 0.2, c=(-0.78, 1.82, c['ROOF'] - 0.03), bev=0.02, segs=2)
    dve.add(cyl(0.05, 0.02, 14, 'y', c=(-0.78, 1.935, c['ROOF'] - 0.01), mat='glass'))
    H.add(dve)
    # headlights + blackout lights in guards on the front corners, tow hooks + lifting eyes at the nose
    for s in (1, -1):
        H.add(headlight_cluster(s), L.place(Matrix.Identity(4), plate_pt(NOSE, GL, s * 1.25, 0.12, 0.0) + V((0, 0, 0.01))))
        H.add(tow_hook().rot('X', -30).scale(1.2), Matrix.Translation((s * 0.6, NOSE[0] - 0.03, NOSE[1] - 0.14)))
        H.add(lathe([(0.035, -0.018), (0.065, -0.018), (0.065, 0.018), (0.035, 0.018)], 12, 'x', cap=False, c=(s * 1.42, 2.9, 1.3)))
    # lower front plate: belly armour seam + cable reel / tow bar brackets
    H.add(box(1.7, 0.015, 0.03, c=(0, 3.04, 0.8)).rot('X', -29, (0, 3.04, 0.8)))
    for x in (-0.35, 0.35):
        H.add(box(0.1, 0.08, 0.12, c=(x, 3.02, 0.72), bev=0.01, segs=1))
    # exhaust outlet on the right front side above the sprocket
    ex = box(0.06, 0.5, 0.26, c=(c['UP_X'] + 0.03, 2.25, 1.62), bev=0.01, segs=1)
    for i in range(5):
        ex.add(box(0.02, 0.44, 0.02, c=(c['UP_X'] + 0.065, 2.25, 1.52 + i * 0.05), mat='gunmetal'))
    H.add(ex)

def bradley_sides(H, s):
    c = BR
    M = side_frame(s, 0)
    X = c['UP_X']
    # A2 appliqué: thick bolted steel plates over the side above the skirts (3 panels)
    for (ya, yb) in ((-3.08, -1.5), (-1.45, 0.25), (0.3, 2.0)):
        yc, ln = (ya + yb) / 2, yb - ya
        pl = box(ln - 0.02, 0.62, 0.035, bev=0.006, segs=1)
        n_b = max(3, int(ln / 0.27))
        for k in range(n_b):
            xx = -ln / 2 + 0.09 + k * (ln - 0.18) / (n_b - 1)
            for yy in (-0.24, 0.0, 0.24):
                pl.add(lathe([(0, 0.0), (0.024, 0.0), (0.024, 0.01), (0.018, 0.022), (0, 0.022)], 8, 'z'), Matrix.Translation((xx, yy, 0.017)))
        H.add(pl, L.place(M, V((s * (X + 0.018), yc, 1.56))))
    # appliqué wedge on the front of the side (taper toward the glacis)
    H.add(prism([(2.0, 1.25), (2.75, 1.25), (2.05, 1.86), (2.0, 1.86)], 0.035, 'x', c=s * (X + 0.018), bev=0.006, segs=1))
    # spaced-laminate skirts over the upper half of the road wheels, sloped front panel over the sprocket
    xs = s * (X + 0.09)
    ys = np.linspace(-2.95, 2.4, 6)
    for i in range(5):
        ya, yb = ys[i] + 0.008, ys[i + 1] - 0.008
        yc = (ya + yb) / 2
        H.add(box(0.03, yb - ya, 0.54, c=(xs, yc, 0.93), bev=0.008, segs=1))
        H.add(box(0.012, yb - ya - 0.06, 0.46, c=(xs + s * 0.018, yc, 0.93), bev=0.004, segs=1))
        for yy in np.linspace(ya + 0.07, yb - 0.07, 3):
            for zz in (0.72, 1.14):
                H.add(bolt(0.014, 0.01, 6).rot('Y', 90 * s), Matrix.Translation((xs + s * 0.016, yy, zz)))
        H.add(box(0.09, 0.05, 0.05, c=(s * (X + 0.045), yc, 1.17)))
    H.add(prism([(2.4, 1.2), (3.05, 1.2), (3.15, 0.95), (2.4, 0.66)], 0.03, 'x', c=xs, bev=0.008, segs=1))
    H.add(box(0.45, 0.012, 0.22, c=(s * GB['trk_x'], -3.08, 0.6), mat='skirt', bev=0.004, segs=1))
    # side lifting eyes, tow cable along the upper side, grab rails
    for y in (-2.6, 1.6):
        H.add(lathe([(0.035, -0.018), (0.065, -0.018), (0.065, 0.018), (0.035, 0.018)], 12, 'y', cap=False), Matrix.Translation((s * (X + 0.06), y, 1.92)))
    H.add(tow_cable((s * (X + 0.06), 1.2, 1.94), (s * (X + 0.06), -1.2, 1.94)))
    H.add(rail([(s * (X - 0.05), -1.6, c['ROOF']), (s * (X - 0.05), -1.6, c['ROOF'] + 0.06), (s * (X - 0.05), -2.4, c['ROOF'] + 0.06), (s * (X - 0.05), -2.4, c['ROOF'])], r=0.012, rad=0.03))

def bradley_roof_rear(H):
    c = BR
    R = c['ROOF']
    turret_ring_collar(H, c['TY'], R, 1.0)
    # big troop cargo hatch behind the turret (hinged at the rear) + roof periscopes along the edges
    H.add(hatch_rect(1.0, 0.9, t=0.035, c=(0, -2.25, R), hinge='y-', rad=0.07))
    for s in (1, -1):
        for y in (-1.45, -2.0, -2.6):
            H.add(periscope_block(0.15, 0.085, 0.06), Matrix.Translation((s * (c['ROOF_X'] - 0.12), y, R - 0.01)) @ Matrix.Rotation(-s * math.pi / 2, 4, 'Z'))
        H.add(antenna_base(), Matrix.Translation((s * 1.25, -2.95, R)))
        H.add(grab((s * 0.65, -1.35, R), (s * 0.65, -1.75, R)))
    # field stowage: ammo cans on the rear deck corner
    for (x, y) in ((-1.15, -2.97), (-0.93, -2.97)):
        am = box(0.16, 0.28, 0.19, c=(x, y, R + 0.095), mat='rolled', bev=0.01, segs=1)
        am.add(rail([(x - 0.04, y - 0.06, R + 0.19), (x - 0.04, y - 0.06, R + 0.22), (x - 0.04, y + 0.06, R + 0.22), (x - 0.04, y + 0.06, R + 0.19)], r=0.007, rad=0.015))
        H.add(am)
    # rear plate: ramp frame, stowage boxes, lights, hooks, pintle
    for s in (1, -1):
        yb = br_rear_y(1.5)
        sb = box(0.62, 0.3, 0.5, c=(s * 1.12, yb - 0.17, 1.5), bev=0.015, segs=2)
        sb.add(box(0.64, 0.32, 0.025, c=(s * 1.12, yb - 0.17, 1.75), bev=0.005, segs=1))
        for x in (s * 0.92, s * 1.32):
            sb.add(box(0.05, 0.03, 0.08, c=(x, yb - 0.33, 1.62)))
        H.add(sb)
        rl = box(0.18, 0.06, 0.12, c=(s * 1.25, br_rear_y(1.88) - 0.03, 1.88), bev=0.01, segs=1)
        rl.add(box(0.13, 0.01, 0.07, c=(s * 1.25, br_rear_y(1.88) - 0.065, 1.88), mat='light'))
        for x in (s * 1.15, s * 1.35):
            rl.add(rail([(x, br_rear_y(1.82), 1.8), (x, br_rear_y(1.82) - 0.1, 1.8), (x, br_rear_y(1.82) - 0.1, 1.96), (x, br_rear_y(1.82), 1.96)], r=0.008, rad=0.03, foot=False))
        H.add(rl)
        H.add(tow_hook().rot('Z', 180), Matrix.Translation((s * 0.82, br_rear_y(0.75) - 0.02, 0.75)))
        # ramp side frame posts
        H.add(box(0.05, 0.05, 1.24, c=(s * 0.66, br_rear_y(1.27) - 0.02, 1.27)).rot('X', -math.degrees(math.atan2(c['REAR_T'] - c['REAR_B'], c['ROOF'] - c['REAR_LOW'])), (s * 0.66, br_rear_y(1.27) - 0.02, 1.27)))
    H.add(box(1.36, 0.05, 0.05, c=(0, br_rear_y(1.92) - 0.02, 1.92)))
    lean = -math.degrees(math.atan2(c['REAR_T'] - c['REAR_B'], c['ROOF'] - c['REAR_LOW']))
    H.add(box(1.24, 0.01, 1.18, c=(0, br_rear_y(1.26) - 0.004, 1.26), mat='gunmetal').rot('X', lean, (0, br_rear_y(1.26) - 0.004, 1.26)))
    H.add(box(0.14, 0.18, 0.1, c=(0, br_rear_y(0.6) - 0.06, 0.55), bev=0.01, segs=1))
    H.add(tube(fillet_path([(0, br_rear_y(0.58) - 0.14, 0.56), (0, br_rear_y(0.58) - 0.28, 0.56), (0, br_rear_y(0.58) - 0.28, 0.46)], 0.04, 3), 0.025, 8))

def bradley_ramp():
    """Rear ramp (hinged at the bottom) with the personnel door in its left half and two firing ports."""
    c = BR
    z0, z1 = 0.66, 1.86
    ang = math.atan2(c['REAR_T'] - c['REAR_B'], c['ROOF'] - c['REAR_LOW'])     # plate lean (top forward)
    hinge = V((0, br_rear_y(z0) - 0.045, z0))
    r = B()
    hgt = z1 - z0
    r.add(box(1.26, 0.09, hgt, c=(0, 0, hgt / 2), bev=0.015, segs=2))
    r.add(box(1.14, 0.03, hgt - 0.12, c=(0, -0.055, hgt / 2), bev=0.006, segs=1))       # spaced-laminate outer plate
    for xx in np.linspace(-0.5, 0.5, 5):
        for zz in (0.12, hgt - 0.12):
            r.add(bolt(0.016, 0.012).rot('X', 90), Matrix.Translation((xx, -0.072, zz)))
    # personnel door in the left half (authoring left = -X)
    dr = box(0.5, 0.025, 0.95, c=(-0.3, -0.083, 0.58), bev=0.008, segs=1)
    for zz in (0.25, 0.9):
        dr.add(cyl(0.022, 0.1, 10, 'z', c=(-0.56, -0.09, zz)))
    dr.add(rail([(-0.12, -0.096, 0.5), (-0.12, -0.15, 0.5), (-0.12, -0.15, 0.68), (-0.12, -0.096, 0.68)], r=0.011, rad=0.02))
    vb = box(0.14, 0.05, 0.1, c=(-0.3, -0.11, 0.92), bev=0.008, segs=1)
    vb.add(box(0.1, 0.01, 0.05, c=(-0.3, -0.137, 0.92), mat='glass'))
    dr.add(vb)
    r.add(dr)
    for x in (0.32, -0.32):
        fp = firing_port().scale(0.8)
        r.add(fp, L.place(L.frame_from_normal(V((0, -1, 0))), V((x, -0.075, 0.33 if x > 0 else 0.22))))
    # tread bars on the inside (seen when lowered) + hinge knuckles
    for zz in np.linspace(0.2, hgt - 0.2, 5):
        r.add(box(1.0, 0.025, 0.03, c=(0, 0.055, zz)))
    for x in (-0.45, 0.0, 0.45):
        r.add(cyl(0.035, 0.18, 10, 'x', c=(x, 0.0, 0.0)))
    r.add(rail([(0.28, -0.1, hgt - 0.25), (0.28, -0.16, hgt - 0.25), (0.48, -0.16, hgt - 0.25), (0.48, -0.1, hgt - 0.25)], r=0.011, rad=0.02))
    r.xf(Matrix.Rotation(-ang, 4, 'X'))
    r.move(*hinge)
    # opening angle so the ramp lip just touches the ground
    drop = math.asin(min(0.95, (z0 - 0.02) / hgt))
    open_rad = math.pi / 2 + drop + ang          # lean is top-forward, so it swings 90 + lean + drop
    return r, tuple(hinge), open_rad, hgt * math.cos(drop)

def bradley_brat_hull():
    """BRAT ERA tiles: two rows along each hull side over the skirts (toggle node era_hull)."""
    c = BR
    E = B(mat='era')
    tile = era_block(0.40, 0.34, 0.1, bev=0.008, bolts=True)
    me = tile.to_mesh('_brat')
    for s in (1, -1):
        M = side_frame(s, 0)
        x = s * (c['UP_X'] + 0.2)
        ys = np.arange(-2.48, 2.35, 0.43)
        for zc in (0.85, 1.22):
            for y in ys:
                E.add_mesh(me, L.place(M, V((x, y, zc))))
            # mounting rails
            E.add(box(0.05, ys[-1] - ys[0] + 0.45, 0.04, c=(s * (c['UP_X'] + 0.14), (ys[0] + ys[-1]) / 2, zc + 0.19)))
        for y in (ys[0] - 0.05, 0.0, ys[-1] + 0.05):
            E.add(box(0.2, 0.05, 0.78, c=(s * (c['UP_X'] + 0.1), y, 1.03)))
    bpy.data.meshes.remove(me)
    return E

def bradley_turret():
    """Welded steel turret with bolted appliqué; origin = ring centre on the roof."""
    T_ = B()
    bot = [(-0.62, 1.12), (0.62, 1.12), (0.96, 0.8), (0.98, -0.8), (0.85, -1.02), (-0.85, -1.02), (-0.98, -0.8), (-0.96, 0.8)]
    top = [(-0.56, 0.86), (0.56, 0.86), (0.93, 0.62), (0.95, -0.78), (0.82, -0.98), (-0.82, -0.98), (-0.95, -0.78), (-0.93, 0.62)]
    T_.add(hull([(x, y, 0.0) for x, y in bot] + [(x, y, 0.60) for x, y in top], bev=0.02, segs=2, angle=20))
    T_.add(box(0.7, 0.12, 0.44, c=(0.08, 1.06, 0.26), bev=0.02, segs=2))           # gun opening frame
    for i in range(len(top)):
        a, b_ = top[i], top[(i + 1) % len(top)]
        T_.add(tube([(a[0], a[1], 0.602), (b_[0], b_[1], 0.602)], 0.007, 5))
    # bolted appliqué on the turret sides (right full length; left behind the TOW arm) and front cheeks
    for s in (1, -1):
        M = side_frame(s, 4)
        ln = 1.4 if s > 0 else 0.85
        yc = -0.05 if s > 0 else -0.35
        pl = box(ln, 0.42, 0.035, bev=0.006, segs=1)
        n_b = int(ln / 0.24)
        for k in range(n_b):
            xx = -ln / 2 + 0.08 + k * (ln - 0.16) / (n_b - 1)
            for yy in (-0.14, 0.14):
                pl.add(lathe([(0, 0.0), (0.022, 0.0), (0.022, 0.01), (0.016, 0.02), (0, 0.02)], 8, 'z'), Matrix.Translation((xx, yy, 0.017)))
        T_.add(pl, L.place(M, V((s * 1.0, yc, 0.3))))
        ch = box(0.42, 0.04, 0.4, bev=0.006, segs=1)
        for xx in (-0.13, 0.13):
            for zz in (-0.12, 0.12):
                ch.add(lathe([(0, 0.0), (0.02, 0.0), (0.02, 0.01), (0.015, 0.018), (0, 0.018)], 8, 'y'), Matrix.Translation((xx, 0.02, zz)))
        T_.add(ch, Matrix.Translation((s * 0.7, 1.03, 0.26)) @ Matrix.Rotation(math.radians(-s * 38), 4, 'Z'))
    # ISU gunner sight (left front of roof) with armoured doors + ballistic cover
    ix, iy = -0.42, 0.5
    isu = box(0.4, 0.44, 0.32, c=(ix, iy, 0.76), bev=0.02, segs=2)
    isu.add(box(0.3, 0.012, 0.14, c=(ix, iy + 0.222, 0.78), mat='glass'))
    for x in (ix - 0.17, ix + 0.17):
        isu.add(box(0.16, 0.03, 0.2, c=(x, iy + 0.26, 0.78), bev=0.006, segs=1).rot('Z', 60 if x < ix else -60, (x + (-0.08 if x < ix else 0.08), iy + 0.24, 0.78)))
    isu.add(box(0.44, 0.1, 0.02, c=(ix, iy + 0.24, 0.93)))
    T_.add(isu)
    # commander's hatch (right rear) in a raised ring of 6 vision blocks; gunner's hatch (left rear)
    cx, cy = 0.45, -0.38
    cu = lathe([(0, 0.0), (0.38, 0.0), (0.38, 0.1), (0.34, 0.14), (0.0, 0.14)], 28, 'z', c=(cx, cy, 0.6))
    cu.add(lathe([(0, 0.05), (0.27, 0.045), (0.3, 0.02), (0.31, 0.0)], 24, 'z', c=(cx, cy, 0.74)))
    for k in range(6):
        a = math.radians(30 + k * 60)
        cu.add(periscope_block(0.12, 0.075, 0.05), Matrix.Translation((cx + 0.33 * math.cos(a), cy + 0.33 * math.sin(a), 0.68)) @ Matrix.Rotation(a - math.pi / 2, 4, 'Z'))
    cu.add(rail([(cx - 0.1, cy, 0.79), (cx - 0.1, cy, 0.83), (cx + 0.1, cy, 0.83), (cx + 0.1, cy, 0.79)], r=0.01, rad=0.025))
    T_.add(cu)
    T_.add(lathe([(0, 0.045), (0.24, 0.04), (0.27, 0.018), (0.28, 0.0)], 24, 'z', c=(-0.45, -0.45, 0.6)))
    T_.add(periscope_block(0.13, 0.08, 0.055), Matrix.Translation((-0.45, -0.12, 0.598)))
    # ODS missile countermeasure device + GPS antenna on the roof
    T_.add(box(0.2, 0.16, 0.12, c=(0.38, 0.45, 0.66), bev=0.015, segs=1))
    T_.add(cyl(0.05, 0.03, 12, 'z', c=(0.0, -0.75, 0.615)))
    # M257 smoke launchers: 2 x 2 tubes on each front corner
    for s in (1, -1):
        c0 = V((s * 0.86, 0.72, 0.36))
        T_.add(box(0.2, 0.18, 0.08, c=tuple(c0), bev=0.008, segs=1))
        for i in range(2):
            for j in range(2):
                p = c0 + V((s * (0.05 - i * 0.1), 0.04, 0.07 + j * 0.09))
                d = V((s * 0.45, 1.0, 0.55 + j * 0.15))
                tb = lathe([(0, -0.09), (0.04, -0.09), (0.04, 0.1), (0.033, 0.1), (0.033, -0.05), (0, -0.05)], 10, 'y')
                T_.add(tb, Matrix.Translation(p) @ align_y(d))
    # antennas at the rear corners, lifting eyes, grab rails
    for s in (1, -1):
        T_.add(antenna_base(), Matrix.Translation((s * 0.72, -0.85, 0.6)))
        T_.add(lathe([(0.03, -0.012), (0.05, -0.012), (0.05, 0.012), (0.03, 0.012)], 12, 'y', cap=False), Matrix.Translation((s * 0.8, 0.2, 0.62)))
    # bustle stowage basket with rolled gear
    bk = B()
    by0, by1, bx = -1.0, -1.5, 0.86
    for z in (0.15, 0.5):
        bk.add(tube([(-bx, by0, z), (-bx, by1, z), (bx, by1, z), (bx, by0, z)], 0.016, 6))
    for x in np.linspace(-bx, bx, 6):
        bk.add(tube([(x, by1, 0.15), (x, by1, 0.5)], 0.012, 5))
    for s in (1, -1):
        for y in (by0, (by0 + by1) / 2, by1):
            bk.add(tube([(s * bx, y, 0.15), (s * bx, y, 0.5)], 0.012, 5))
    bk.add(box(1.7, 0.5, 0.02, c=(0, (by0 + by1) / 2, 0.15)))
    for x in np.linspace(-0.8, 0.8, 9):
        bk.add(box(0.012, 0.5, 0.012, c=(x, (by0 + by1) / 2, 0.5)))
    bk.add(cyl(0.13, 1.5, 14, 'x', c=(0, -1.22, 0.31), mat='canvas'))
    bk.add(box(0.5, 0.3, 0.26, c=(0.5, -1.33, 0.29), mat='canvas', bev=0.04, segs=2))
    bk.add(box(0.4, 0.28, 0.22, c=(-0.55, -1.32, 0.27), bev=0.015, segs=1))
    T_.add(bk)
    # TOW arm bracket on the left side
    T_.add(box(0.1, 0.3, 0.22, c=(-1.02, -0.4, 0.3), bev=0.012, segs=1))
    return T_

def bradley_tow():
    """Twin TOW launcher box in its stowed position; origin = hinge at the rear (child of turret)."""
    t = B()
    x0, y0, y1, zc = -1.27, -0.55, 0.9, 0.34
    t.add(box(0.42, y1 - y0, 0.40, c=(x0, (y0 + y1) / 2, zc), bev=0.025, segs=2))
    t.add(box(0.44, 0.06, 0.42, c=(x0, y1 - 0.05, zc), bev=0.012, segs=1))                 # front frame
    for dx in (-0.1, 0.1):
        t.add(lathe([(0.0, 0.0), (0.085, 0.0), (0.085, 0.02), (0.0, 0.02)], 16, 'y', mat='gunmetal', c=(x0 + dx, y1 + 0.0, zc)))
        t.add(cyl(0.092, 0.02, 16, 'y', c=(x0 + dx, y1 + 0.02, zc)))
    t.add(box(0.44, 0.12, 0.03, c=(x0, y1 - 0.02, zc + 0.23)).rot('X', -30, (x0, y1 - 0.06, zc + 0.21)))  # rain cover
    for yy in (-0.3, 0.2, 0.6):
        t.add(box(0.44, 0.03, 0.42, c=(x0, yy, zc), bev=0.005, segs=1))                    # stiffening bands
    t.add(rail([(x0 - 0.21, 0.0, zc + 0.12), (x0 - 0.26, 0.0, zc + 0.12), (x0 - 0.26, 0.4, zc + 0.12), (x0 - 0.21, 0.4, zc + 0.12)], r=0.011, rad=0.025))
    t.add(box(0.12, 0.25, 0.18, c=(-1.08, -0.4, 0.3), bev=0.01, segs=1))                   # arm
    hinge = (-1.08, -0.42, 0.3)
    m1 = (x0 - 0.1, y1 + 0.03, zc); m2 = (x0 + 0.1, y1 + 0.03, zc)
    return t, hinge, m1, m2

def bradley_brat_turret():
    c = BR
    E = B(mat='era')
    tile = era_block(0.34, 0.3, 0.09, bev=0.008, bolts=True)
    me = tile.to_mesh('_bratt')
    M = side_frame(1, 4)
    for y in (-0.55, -0.15, 0.25):
        E.add_mesh(me, L.place(M, V((1.1, y, 0.3))))
    for s in (1, -1):
        for k in range(2):
            Mf = Matrix.Rotation(math.radians(-s * 38), 4, 'Z') @ L.frame_from_normal(V((0, 1, 0)))
            E.add_mesh(me, L.place(Mf, V((s * (0.56 + k * 0.28), 1.12 - k * 0.22, 0.2))))
    E.add(box(0.06, 1.1, 0.04, c=(1.05, -0.15, 0.48)))
    bpy.data.meshes.remove(me)
    return E

def bradley_gun():
    """M242 25 mm in a box mantlet + M240C coax (right). Origin = trunnion, +Y forward."""
    g = B()
    g.add(hull([(-0.24, 0.0, -0.17), (0.4, 0.0, -0.17), (-0.24, 0.0, 0.17), (0.4, 0.0, 0.17),
                (-0.2, 0.3, -0.15), (0.36, 0.3, -0.15), (-0.2, 0.26, 0.14), (0.36, 0.26, 0.14)], bev=0.02, segs=2))
    g.add(lathe([(0, 0.28), (0.075, 0.28), (0.075, 0.42), (0.06, 0.46), (0.06, 0.62), (0.04, 0.66), (0, 0.66)], 16, 'y'))
    g.add(cyl(0.026, 1.5, 12, 'y', c=(0, 1.4, 0), mat='gunmetal'))
    g.add(lathe([(0, 0), (0.042, 0), (0.046, 0.03), (0.046, 0.22), (0.04, 0.25), (0, 0.25)], 14, 'y', mat='gunmetal', c=(0, 2.1, 0)))
    for i in range(4):
        g.add(box(0.1, 0.022, 0.014, c=(0, 2.17 + i * 0.04, 0), mat='gunmetal'))
    g.add(cyl(0.032, 0.03, 12, 'y', c=(0, 1.2, 0), mat='gunmetal'))          # barrel clamp
    px = 0.24
    g.add(cyl(0.032, 0.1, 10, 'y', c=(px, 0.33, -0.02), mat='gunmetal'))
    g.add(cyl(0.012, 0.16, 8, 'y', c=(px, 0.45, -0.02), mat='gunmetal'))
    g.add(cyl(0.017, 0.04, 8, 'y', c=(px, 0.54, -0.02), mat='gunmetal'))
    return g, (0, 2.35, 0), (px, 0.56, -0.02)

def build_bradley():
    t0 = time.time()
    L.reset()
    c = BR
    root = L.node_empty('root')
    hullE = L.node_empty('hull', root, (0, 0, 0))
    H = bradley_hull()
    bradley_front(H)
    for s in (1, -1):
        bradley_sides(H, s)
        suspension(GB, H, c['LOW_X'], s, [-1, -1, -1, 1, 1, 1], (0, 1, 5))
    bradley_roof_rear(H)
    print('  hull tris', H.tris(), '%.1fs' % (time.time() - t0))
    full_bvh = L.bvh_of(H)
    hull_mesh = L.node_mesh('hull_geo', H, hullE, (0, 0, 0))
    era_h = L.node_mesh('era_hull', bradley_brat_hull(), hullE, (0, 0, 0))
    rp, hinge, ramp_open, lip_dx = bradley_ramp()
    rampE = L.node_empty('ramp', hullE, hinge, 0.15)
    ramp_mesh = L.node_mesh('ramp_geo', rp, rampE, hinge)
    tz = c['ROOF'] + 0.01
    TU = bradley_turret().move(0, c['TY'], tz)
    turE = L.node_empty('turret', hullE, (0, c['TY'], tz))
    turE['traverse_deg_s'] = D.STATIC['bradley_ua']['mobility']['turret_traverse_deg_s']
    tur_mesh = L.node_mesh('turret_geo', TU, turE, (0, c['TY'], tz))
    era_t = L.node_mesh('era_turret', bradley_brat_turret().move(0, c['TY'], tz), turE, (0, c['TY'], tz))
    tw, th, m1, m2 = bradley_tow()
    P0 = lambda o: (o[0], c['TY'] + o[1], tz + o[2])
    tw.move(0, c['TY'], tz)
    towE = L.node_empty('tow_launcher', turE, P0(th), 0.12)
    tow_mesh = L.node_mesh('tow_launcher_geo', tw, towE, P0(th))
    facing_empty('atgm_muzzle_1', towE, P0(m1), (0, 1), 0.08)
    facing_empty('atgm_muzzle_2', towE, P0(m2), (0, 1), 0.08)
    trun = (0, c['TY'] + 0.78, tz + 0.27)
    gunE = L.node_empty('gun_pivot', turE, trun)
    gunE['elev_min_deg'], gunE['elev_max_deg'] = -9, 57
    Gm, mz, cx = bradley_gun()
    Gm.move(*trun)
    gun_mesh = L.node_mesh('gun_geo', Gm, gunE, trun)
    P = lambda o: (trun[0] + o[0], trun[1] + o[1], trun[2] + o[2])
    L.node_empty('muzzle', gunE, P(mz), 0.1)
    L.node_empty('coax_muzzle', gunE, P(cx), 0.1)
    L.node_empty('smoke_launchers', turE, (0, c['TY'] + 0.75, tz + 0.45))
    L.node_empty('hatch_commander', turE, (0.45, c['TY'] - 0.38, tz + 0.8), 0.12)
    L.node_empty('commander_hatch', turE, (0.45, c['TY'] - 0.38, tz + 0.8), 0.12)
    L.node_empty('hatch_gunner', turE, (-0.45, c['TY'] - 0.45, tz + 0.66), 0.12)
    rg, tracks, pitch, Lt, links = add_running_gear(GB, hullE, 'bradley')
    L.node_empty('hatch_driver', hullE, (-0.78, 1.36, c['ROOF'] + 0.06), 0.12)
    L.node_empty('hatch_cargo', hullE, (0, -2.25, c['ROOF'] + 0.05), 0.12)
    L.node_empty('exhaust', hullE, (c['UP_X'] + 0.12, 2.25, 1.62))
    exit_y = hinge[1] - lip_dx - 0.6
    facing_empty('exit_rear', hullE, (0, exit_y, 0.0), (0, -1), 0.25)
    facing_empty('dismount_L', hullE, (-2.3, -1.0, 0.0), (-1, 0))
    facing_empty('dismount_R', hullE, (2.3, -1.0, 0.0), (1, 0))
    specs = ([dict(x=s * 1.30, y=y, face=(s, 0), type='edge') for y in (-1.75, -2.55) for s in (1, -1)] +
             [dict(x=x, y=-2.95, face=(0, 1), type='deck') for x in (-0.45, 0.45)])
    seats = S.place_seats(hullE, specs, full_bvh)
    blen = math.hypot(mz[1], mz[2])
    clr = S.clearance(seats, (0, c['TY'], tz), [tur_mesh, era_t, tow_mesh], trun, blen, 57)
    print('  seats', [(s_['name'], round(s_['z'], 3)) for s_ in seats])
    print('  clearance', clr)
    VB.SOOT[:] = [((c['UP_X'] + 0.1, 2.0, 1.6), 0.45)]
    lod0 = [hull_mesh, era_h, ramp_mesh, tur_mesh, era_t, tow_mesh, gun_mesh] + rg + tracks
    seen, uniq = set(), []
    for o in [hull_mesh, era_h, ramp_mesh, tur_mesh, era_t, tow_mesh, gun_mesh] + rg:
        if o.data.name not in seen:
            uniq.append(o); seen.add(o.data.name)
    print('  geometry done %.1fs' % (time.time() - t0))
    return dict(root=root, hull=hullE, turret=turE, gun=gunE, lod0=lod0, atlas=uniq, tracks=tracks, pitch=pitch, track_len=Lt,
                links=links, seats=seats, clearance=clr, tur_objs=[tur_mesh, era_t, tow_mesh, gun_mesh], gun_obj=gun_mesh,
                extra=dict(
                    animated_nodes={
                        'ramp': f'rear ramp, hinge at its bottom edge; open = rotation.x NEGATIVE, 0 .. {-ramp_open:.3f} rad (lip on the ground)',
                        'tow_launcher': 'TOW box, hinge at its rear; raise to fire = rotation.x NEGATIVE (~ -0.35 rad)',
                        'turret': 'yaw about local Y', 'gun_pivot': 'pitch about local X; elevate = rotation.x NEGATIVE'},
                    toggle_nodes={'era_hull': 'hull/era_hull (+LOD1): BRAT tile belts on both sides (armour zones era_l / era_r)',
                                  'era_turret': 'turret/era_turret (+LOD1): BRAT tiles on the turret right side and front cheeks'},
                    empties={
                        'muzzle': '25 mm M242', 'coax_muzzle': 'M240C', 'atgm_muzzle_1 / atgm_muzzle_2': 'TOW tube mouths (under tow_launcher), +Z = launch direction',
                        'smoke_launchers': 'turret', 'hatch_commander / commander_hatch / hatch_gunner': 'turret hatch rims',
                        'hatch_driver': 'hull, front left', 'hatch_cargo': 'roof troop hatch behind the turret',
                        'exit_rear': 'ground point at the foot of the lowered ramp, +Z faces away from the vehicle (dismount spawn)',
                        'dismount_L / dismount_R': 'crew bail-out ground points beside the hull, +Z facing out',
                        'exhaust': 'right front side outlet', 'ride_seat_1..6': 'desant seats (see ride_seats)'},
                    running_gear_radii_m=dict(roadwheel=GB['rw_r'], sprocket=GB['spr'][2], idler=GB['idl'][2]),
                    gun_limits_deg=dict(elevation=[-9, 57], traverse=360, ramp_open_rad=round(ramp_open, 3)),
                ))

def decals_bradley(P, N):
    m = np.zeros(P.shape[:2], np.float32)
    E = lambda p: (-p[0], -p[1], p[2])
    c = BR
    for s in (1, -1):
        m += T.decal_mask(P, N, E((s * (c['UP_X'] + 0.2), -0.42, 1.04)), E((s, 0, 0)), (0, 0, 1), T.cross_shape(0.3, 0.06))
    m += T.decal_mask(P, N, E((0.3, br_rear_y(1.4) - 0.1, 1.4)), E((0, -1, 0.09)), (0, 0, 1), T.cross_shape(0.16, 0.04))
    m += T.decal_mask(P, N, E((0, -2.25, c['ROOF'] + 0.04)), E((0, 0, 1)), (0, -1, 0), T.cross_shape(0.28, 0.06))
    return m

def decals_none(P, N):
    return np.zeros(P.shape[:2], np.float32)

# ================================================================================================ outputs
def write_armor(name):
    p = os.path.join(REPO, 'assets', 'vehicles', name + '_armor.json')
    with open(p, 'w') as f:
        json.dump(D.ARMOR[name], f, indent=1)
    print('wrote', p)

def merge_manifest(name, info):
    """Read-modify-write of assets/vehicles/manifest.json touching only this vehicle's keys."""
    import fcntl
    man_path = os.path.join(REPO, 'assets', 'vehicles', 'manifest.json')
    skey = 'bmp3' if name == 'bmp3' else 'bradley'
    with open(man_path + '.lock', 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        man = json.load(open(man_path))
        man.setdefault('sources', {})[skey] = D.SOURCES[skey]
        v = dict(D.STATIC[name])
        v['file'] = f'assets/vehicles/{name}.glb'
        v['file_mb'] = round(os.path.getsize(os.path.join(REPO, v['file'])) / 1e6, 2)
        v['tris'] = dict(lod0=info['lod0_tris'], lod1=info['lod1_tris'], **info['wreck_tris'])
        v['model_bbox_m'] = dict(min=info['bbox_lod0'][0], max=info['bbox_lod0'][1],
                                 size=[round(b - a, 3) for a, b in zip(*info['bbox_lod0'])])
        v['materials'] = info['materials']
        v['sources_key'] = skey
        for k in D.INFO_KEYS:
            if k in info:
                v[k] = info[k]
        v['hierarchy'] = info['hierarchy']
        man.setdefault('vehicles', {})[name] = v
        tmp = man_path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(man, f, indent=1)
        os.replace(tmp, man_path)
    print('merged manifest entry', name)

def dev_export(name, d):
    """Fast geometry check: flat colours per atlas kind, no bakes/LOD/wreck -> previews/vehicles_ifv/_dev_<name>.glb."""
    cols = dict(rolled=(0.10, 0.13, 0.06), cast=(0.1, 0.12, 0.06), skirt=(0.03, 0.03, 0.03), gunmetal=(0.03, 0.03, 0.03),
                rim=(0.09, 0.11, 0.05), tyre=(0.02, 0.02, 0.02), wood=(0.2, 0.12, 0.05), canvas=(0.2, 0.18, 0.1),
                era=(0.12, 0.13, 0.07), bare=(0.2, 0.2, 0.2), cage=(0.1, 0.1, 0.08), decal=(0.8, 0.8, 0.8),
                glass=(0.01, 0.01, 0.01), light=(0.6, 0.6, 0.5), track=(0.05, 0.05, 0.05))
    for k, cc in cols.items():
        m = bpy.data.materials.get('S_' + k)
        if m:
            T.principled('S_' + k, color=cc, rough=0.7)
    out = os.path.join(REPO, 'previews', 'vehicles_ifv', f'_dev_{name}.glb')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    VB.export(d['root'], out)
    tris = sum(L.tri_count(o) for o in d['lod0'])
    print('  DEV tris', tris, {o.name: L.tri_count(o) for o in d['lod0'] if L.tri_count(o) > 2000})

def main(name):
    if '--geo' in sys.argv:
        d = build_bmp3() if name == 'bmp3' else build_bradley()
        dev_export(name, d)
        return
    if name == 'bmp3':
        d = build_bmp3()
        tm = track_textures(name, 'steel', d['pitch'], G3['trk_w'])
        info = VB.finalize(d, name, 'ru_bmp3', decals_none, wreck_generic, track_mats=tm)
    else:
        d = build_bradley()
        tm = track_textures(name, 'pads', d['pitch'], GB['trk_w'])
        info = VB.finalize(d, name, 'ua_nato', decals_bradley, wreck_generic, track_mats=tm)
    info['track_link_pitch_m'] = round(d['pitch'], 4)
    info['track_length_m'] = round(d['track_len'], 3)
    info['track_links'] = d['links']
    info['ride_seats'] = S.manifest_entries(d['seats'])
    info['ride_clearance'] = d['clearance']
    info.update(d['extra'])
    with open(os.path.join(VB.CACHE, name + '_info.json'), 'w') as f:
        json.dump(info, f, indent=1)
    write_armor(name)
    if '--no-manifest' not in sys.argv:
        merge_manifest(name, info)
    print(json.dumps({k: v for k, v in info.items() if k not in ('hierarchy', 'node_bboxes')})[:3000])
    return info

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    main(args[-1])
