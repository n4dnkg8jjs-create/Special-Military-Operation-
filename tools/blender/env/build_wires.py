"""Builds assets/env/wires.glb: Soviet SV-95 vibrated-concrete utility pole (steel crossarm, porcelain pin
insulators, cobra-head street lamp), broken pole, steel trolleybus pole (span-wire clamp, lamp arm), concertina
razor-wire coil, barbed-wire fence segment. Poles carry empties attach_* at the insulator / clamp points
(children of the pole node; city.js poles() reads them). The wire run follows local +X, crossarms span local Z.
Run: cd tools/blender/env && nice -n 10 python3 build_wires.py
"""
import os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
from PIL import Image
from meshfix import fix_mb
from meshlib import *
from texlib import spectral, norm01, colorize, srgb, lerp, to8, normal_from_height, smoothstep, blur, CACHE, quantize_normal

S = 512
REG = {'concrete': (0, 0, 256, 512), 'steel': (256, 0, 384, 256), 'galv': (384, 0, 512, 256),
       'porcelain': (256, 256, 384, 384), 'glass': (384, 256, 512, 384), 'wood': (256, 384, 384, 512), 'lamp': (384, 384, 512, 512)}
R = {k: Region(*v, S=S, pad=2) for k, v in REG.items()}


def atlas():
    alb = np.zeros((S, S, 3), np.float32); hgt = np.zeros((S, S), np.float32)
    rough = np.full((S, S), 0.8, np.float32); metal = np.zeros((S, S), np.float32)
    def put(name, a, h, ro, me=0.0):
        x0, y0, x1, y1 = REG[name]
        alb[y0:y1, x0:x1] = a; hgt[y0:y1, x0:x1] = h; rough[y0:y1, x0:x1] = ro; metal[y0:y1, x0:x1] = me
    # concrete pole: 256 wide (around) x 512 (along 8 m): grey, mould seams, mounting holes, rust streaks, base dirt
    h, w = 512, 256; yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    n = spectral(0, 1.2, 1, fmin=4, fmax=120, shape=(h, w)); f = spectral(0, 0.5, 2, fmin=40, shape=(h, w))
    a = colorize(norm01(n * 0.6 + f * 0.4), [(0, '#7c7a74'), (1, '#a19e96')])
    holes = np.zeros((h, w), np.float32)
    for k in range(9):
        y = 30 + k * 52
        for x in (w * 0.25, w * 0.75):
            holes[int(y) - 3:int(y) + 3, int(x) - 3:int(x) + 3] = 1
    rust = blur(holes, (25, 1.0), wrap=False) * 3 * (yy > 0)
    a = lerp(a, srgb('#7b5638'), np.clip(rust, 0, 0.7))
    a = lerp(a, srgb('#1c1a18'), holes)
    seam = (np.abs(xx - w / 2) < 1.5).astype(np.float32)
    a = lerp(a, srgb('#6a6862'), seam * 0.6)
    a = lerp(a, srgb('#4d463c'), smoothstep(h * 0.85, h, yy) * 0.7)         # mud splash at the base (v=0 is bottom)
    stripe = ((yy > h * 0.6) & (yy < h * 0.64)).astype(np.float32)           # painted number band
    a = lerp(a, srgb('#c9c3b0'), stripe * 0.8)
    put('concrete', a, n * 0.4 + f * 0.3 - holes * 3 - seam, 0.9)
    def simple(name, c0, c1, ro, me, seed, rust=0.0, extra=None):
        x0, y0, x1, y1 = REG[name]; hh, ww = y1 - y0, x1 - x0
        nn = spectral(0, 1.2, seed, fmin=3, fmax=60, shape=(hh, ww))
        aa = colorize(norm01(nn), [(0, c0), (1, c1)])
        if rust:
            aa = lerp(aa, srgb('#6e4122'), smoothstep(0.4, 1.5, spectral(0, 1.6, seed + 1, fmin=3, fmax=50, shape=(hh, ww))) * rust)
        put(name, aa, nn * 0.3, ro, me)
    simple('steel', '#4a4744', '#5f5a55', 0.6, 0.7, 10, rust=0.8)
    simple('galv', '#7e817f', '#9c9e9a', 0.45, 0.85, 12, rust=0.3)
    simple('porcelain', '#c9c8c0', '#e4e2da', 0.25, 0.0, 14)
    simple('glass', '#2f4a3a', '#4f7a5e', 0.1, 0.0, 16)
    simple('wood', '#3d3226', '#5a4a38', 0.9, 0.0, 18)
    simple('lamp', '#5a5d58', '#73766f', 0.5, 0.5, 20, rust=0.3)
    paths = [os.path.join(CACHE, f'wires_atlas_{s}') for s in ('albedo.jpg', 'normal.png', 'orm.png')]
    Image.fromarray(to8(alb)).save(paths[0], quality=90)
    Image.fromarray(quantize_normal(normal_from_height(hgt, 1.0, wrap=False), 6)).save(paths[1], optimize=True)
    Image.fromarray(to8(np.stack([np.ones((S, S)), rough, metal], -1))).save(paths[2], optimize=True)
    return paths


def ruv(name, L=1.0):
    reg = R[name]
    return lambda s, l: reg.uv(s, min(l / L, 1.0))


def lathe(mb, profile, centre, sides, region, M=None, cap=False):
    """Surface of revolution about +Y. profile: [(radius, y), ...] bottom->top.
    cap: close the bottom ring with a downward-facing disc (watertight shell; the open bell mouth shows its inside when
    the piece lies on its side, e.g. the insulators of the broken pole)."""
    reg = R[region]
    rings = []
    tmp = MB()
    for (rr, y) in profile:
        ring = [(centre[0] + rr * math.cos(2 * math.pi * k / sides), centre[1] + y, centre[2] + rr * math.sin(2 * math.pi * k / sides)) for k in range(sides)]
        rings.append(tmp.vs(ring))
    for i in range(len(profile) - 1):
        for k in range(sides):
            k2 = (k + 1) % sides
            q = (rings[i][k], rings[i + 1][k], rings[i + 1][k2], rings[i][k2])
            uv = [reg.uv(k / sides, i / len(profile)), reg.uv(k / sides, (i + 1) / len(profile)), reg.uv((k + 1) / sides, (i + 1) / len(profile)), reg.uv((k + 1) / sides, i / len(profile))]
            tmp.face(q, uv, True)
    if cap and profile[0][0] > 1e-6:       # ring order is clockwise seen from +Y: as-is faces down
        tmp.face(rings[0], [reg.uv(0.5, 0.0)] * sides)
    if cap and profile[-1][0] > 1e-6:
        tmp.face(rings[-1][::-1], [reg.uv(0.5, 1.0)] * sides)
    mb.merge(tmp, M)


def insulator(mb, base, glass=False, closed=False):
    """Pin insulator (ShF-20 porcelain / green glass): steel pin + bell. closed: capped pin + bell (watertight)."""
    x, y, z = base
    mb.tube([(x, y, z), (x, y + 0.275, z)], 0.012, 4, ruv('galv'), smooth=False, cap=closed)     # pin runs up through the bell (bell was not touching it)
    prof = [(0.06, 0.0), (0.075, 0.03), (0.06, 0.06), (0.07, 0.09), (0.05, 0.13), (0.035, 0.16), (0.0, 0.17)]
    lathe(mb, prof, (x, y + 0.1, z), 8, 'glass' if glass else 'porcelain', cap=closed)
    return np.array([x, y + 0.26, z])


def cobra_lamp(mb, root, d, L=1.6, h=0.5, closed=False):
    """RKU 'cobra' street lamp: curved tube arm + luminaire head.
    closed: capped arm and the diffuser as a thin closed slab hugging the head (the open sheet 1 cm under the head was a
    loose, back-face-visible piece once the lamp lies on its side)."""
    d = np.array(d, float); d /= np.linalg.norm(d)
    pts = [root + d * 0.0, root + d * L * 0.35 + [0, h * 0.7, 0], root + d * L * 0.75 + [0, h, 0], root + d * L + [0, h * 0.85, 0]]
    mb.tube(pts, 0.03, 6, ruv('galv', 2.0), cap=closed)
    head = pts[-1]
    side = np.cross(d, [0, 1, 0])
    tmp = MB()
    f = Fit(R['lamp'], (0.6, 0.3), 1)
    tmp.box((-0.05, -0.12, -0.15), (0.55, 0.02, 0.15), f)
    if closed:
        tmp.box((0.0, -0.13, -0.12), (0.5, -0.1205, 0.12), Fit(R['glass'], (0.5, 0.3), 2))
    else:
        tmp.poly([(0.0, -0.13, -0.12), (0.5, -0.13, -0.12), (0.5, -0.13, 0.12), (0.0, -0.13, 0.12)][::-1], Fit(R['glass'], (0.5, 0.3), 2))
    yaw = math.atan2(-d[2], d[0])
    mb.merge(tmp, mat_trs(head, (0, yaw, -0.08)))


def utility_pole(name='utility_pole', broken=False, seed=1):
    mb = MB(name); r = rng(seed)
    Hh = 8.2   # above ground (SV-95: 9.5 m total, ~1.3 m buried)
    def section(y):
        t = y / Hh
        return 0.13 - 0.045 * t, 0.083 - 0.0 * t     # half-sizes along x (run) and z
    reg = R['concrete']
    # chamfered rectangular tapered shaft (8 sides), uv: around x along
    closed = broken          # the broken pole lies at RTS eye level: every part a closed, outward shell
    def shaft(y0, y1, M=None):
        ring_pts = []
        tmp = MB(); rings = []
        for y in (y0, y1):
            hx, hz = section(y); c = 0.02
            pts = [(hx - c, y, hz), (-hx + c, y, hz), (-hx, y, hz - c), (-hx, y, -hz + c), (-hx + c, y, -hz), (hx - c, y, -hz), (hx, y, -hz + c), (hx, y, hz - c)]
            rings.append(tmp.vs(pts))
        for k in range(8):
            k2 = (k + 1) % 8
            q = (rings[0][k], rings[0][k2], rings[1][k2], rings[1][k])
            uv = [reg.uv(k / 8, y0 / Hh), reg.uv((k + 1) / 8, y0 / Hh), reg.uv((k + 1) / 8, y1 / Hh), reg.uv(k / 8, y1 / Hh)]
            P = np.array([tmp.V[i] for i in q]); c_ = P.mean(0)
            if np.dot(newell(P), [c_[0], 0, c_[2]]) < 0:
                q = q[::-1]; uv = uv[::-1]
            tmp.face(q, uv, False)
        top = rings[1]
        if closed:     # broken pole: both ends capped, wound outward like the sides (ring order runs clockwise seen
            # from +Y); the snapped butt of the fallen top is in plain view (was an open, inside-visible end)
            tmp.face(top[::-1], [reg.uv(0.5, 0.99)] * 8)
            tmp.face(rings[0], [reg.uv(0.5, 0.45)] * 8)     # plain grey concrete (v ~ 0 is the mud-splash band)
        else:
            tmp.face(top, [reg.uv(0.5, 0.99)] * 8)
        mb.merge(tmp, M)
    attach = []
    if not broken:
        shaft(-0.3, Hh)
        top = Hh
    else:
        hb = 1.3
        shaft(-0.3, hb)
        M = rot_axis((0, 0, 1), -1.74, origin=(0.13, hb, 0))
        shaft(hb + 0.05, Hh, M)
        for k in range(4):   # rebar holding the two halves
            x = (-0.08 + 0.05 * k)
            a = np.array([x, hb - 0.1, 0.06 * (-1) ** k]); b = xform(np.array([[x, hb + 0.2, 0.06 * (-1) ** k]]), M)[0]
            mb.tube([a, (a + b) / 2 + [0.05, 0.12, 0], b], 0.006, 3, ruv('steel'), cap=True)
        top = None
    # crossarm (steel angle along Z) + insulators, lamp
    tmpk = MB()
    ya = Hh - 0.35
    tmpk.box((-0.05, ya, -0.85), (0.0, ya + 0.05, 0.85), Fit(R['steel'], (0.3, 1.7), 3), faces='+y-y+x-x+z-z')
    if closed:     # vertical leg of the angle as a closed plate just under the horizontal leg (no shared / open edges)
        tmpk.box((-0.05, ya - 0.05, -0.85), (-0.045, ya - 0.0005, 0.85), Fit(R['steel'], (0.3, 1.7), 4))
    else:
        tmpk.box((-0.05, ya - 0.05, -0.85), (-0.045, ya, 0.85), Fit(R['steel'], (0.3, 1.7), 4), faces='+x-x')
    # diagonal braces
    for s_ in (-1, 1):
        tmpk.tube([(-0.09, ya - 0.6, 0.0), (-0.03, ya - 0.01, s_ * 0.55)], 0.012, 4, ruv('steel'), smooth=False, cap=closed)
    pts_att = []
    for zi, zz in enumerate((-0.75, -0.35, 0.35, 0.75)):
        pts_att.append(insulator(tmpk, (-0.025, ya + 0.05, zz), glass=(zi % 2 == 1), closed=closed))
    # top insulator on a bracket (neutral / street-lighting wire)
    tmpk.box((0.08, Hh - 0.12, -0.03), (0.16, Hh - 0.06, 0.03), Fit(R['steel'], (0.2, 0.2), 5))
    pts_att.append(insulator(tmpk, (0.14, Hh - 0.06, 0.0), closed=closed))
    cobra_lamp(tmpk, np.array([0.0, Hh - 1.4, 0.09]), (0, 0, 1), L=1.5, closed=closed)
    # a sagging service cable stub and a rusted junction box
    tmpk.box((-0.12, 2.6, 0.085), (0.12, 2.95, 0.2), Fit(R['steel'], (0.3, 0.4), 6))
    tmpk.tube([(0, 2.95, 0.14), (0, Hh - 1.5, 0.11)], 0.012, 4, ruv('galv', 5.0), smooth=False, cap=closed)
    if broken:
        M = rot_axis((0, 0, 1), -1.74, origin=(0.13, 1.3, 0))
        mb.merge(tmpk, M)
        pts_att = [xform(np.array([p]), M)[0] for p in pts_att]
    else:
        mb.merge(tmpk)
    return mb, pts_att


def trolley_pole():
    mb = MB('trolleybus_pole'); r = rng(7)
    # three-section conical steel tube (stepped joints), 9.5 m
    secs = [(0.0, 3.4, 0.135, 0.125), (3.4, 6.6, 0.115, 0.105), (6.6, 9.5, 0.095, 0.085)]
    for y0, y1, r0, r1 in secs:
        mb.tube([(0, y0 - (0.2 if y0 == 0 else 0), 0), (0, y1, 0)], [r0, r1], 10, ruv('galv', 3.0), smooth=True)
        mb.tube([(0, y1 - 0.06, 0), (0, y1 + 0.02, 0)], r1 + 0.006, 10, ruv('steel'), smooth=True, cap=True)   # joint collar hugging the tube
    lathe(mb, [(0.12, 0), (0.1, 0.06), (0.0, 0.1)], (0, 9.5, 0), 10, 'steel')
    # base plinth (painted collar) and access door
    mb.tube([(0, -0.1, 0), (0, 0.9, 0)], 0.142, 10, ruv('steel'), smooth=True, cap=True)
    pts_att = []
    # span-wire clamp ring + strain insulator facing the road (+Z)
    for y in (6.9, 6.25):
        rp = next(r0 + (r1 - r0) * (y - y0) / (y1 - y0) for y0, y1, r0, r1 in secs if y0 <= y <= y1)
        mb.tube([(0, y - 0.05, 0), (0, y + 0.05, 0)], rp + 0.008, 10, ruv('steel'), smooth=True, cap=True)   # clamp ring on the pole (was 2-3 cm off it)
        ins = [(0, y, rp), (0, y, 0.25), (0, y - 0.02, 0.45)]
        mb.tube(ins[:2], 0.012, 4, ruv('galv'), smooth=False)
        lathe(mb, [(0.035, 0), (0.05, 0.05), (0.035, 0.1), (0.05, 0.15), (0.035, 0.2)], (0, 0, 0), 6, 'porcelain',
              M=mat_trs((0, y, 0.25), (math.pi / 2, 0, 0)))
        pts_att.append(np.array([0, y, 0.48]))
    cobra_lamp(mb, np.array([0, 8.6, 0.09]), (0, 0, 1), L=2.0, h=0.6)
    # bracket for the hanging span wire stub (cut, hanging)
    mb.tube([(0, 6.9, 0.44), (0.05, 6.4, 0.9), (0.08, 5.2, 1.1), (0.1, 3.9, 1.0)], 0.008, 3, ruv('steel', 3.0))
    return mb, pts_att


def concertina(L=6.0, D=0.9, loops=34, seed=3):
    """Stretched concertina razor-wire coil along X; origin on the ground at the coil centre."""
    mb = MB('concertina_coil'); r = rng(seed)
    seg = 18; n = loops * seg
    pts = []
    for i in range(n + 1):
        t = i / n; a = 2 * math.pi * loops * t
        rad = D / 2 * (1 + 0.04 * math.sin(a * 3 + 1.0) + r.normal(0, 0.012))
        x = -L / 2 + L * t + 0.06 * math.sin(a)     # loops lean back and forth (the coil was pulled open)
        pts.append((x, D / 2 + rad * math.sin(a) * 0.95, rad * math.cos(a)))
    pts = np.array(pts)
    mb.tube(pts, 0.0028, 3, ruv('galv', 3.0), smooth=True)
    # razor barbs: small double-edged blades every other segment
    f = Fit(R['galv'], (0.05, 0.05), 1)
    for i in range(0, n, 2):
        p = pts[i]; d = pts[i + 1] - pts[i]; d /= np.linalg.norm(d)
        o = np.cross(d, p - [p[0], D / 2, 0]); o /= (np.linalg.norm(o) + 1e-9)
        b = 0.014
        mb.poly([p - d * b, p + o * 0.012, p + d * b, p - o * 0.012], f)
    # clips joining adjacent loops (every 1/3 turn) - short straight bits
    for i in range(0, n - seg, seg // 3):
        a, b = pts[i], pts[i + seg]
        if np.linalg.norm(a - b) < 0.35:
            mb.tube([a, b], 0.004, 3, ruv('galv'), smooth=False)
    # two steel U-pickets holding the coil
    for x in (-L / 2 + 0.3, L / 2 - 0.3):
        mb.box((x - 0.02, -0.3, -0.03), (x + 0.02, 1.0, 0.03), Fit(R["steel"], (0.1, 1.3), int(abs(x) * 10)), faces='+x-x+z-z+y')
    return mb


def barbed_fence(L=3.0, seed=5):
    mb = MB('barbed_wire_fence'); r = rng(seed)
    posts = [0.0, L]
    for x in posts:
        lean = r.normal(0, 0.05)
        mb.tube([(x, -0.4, 0), (x + lean * 0.5, 0.8, 0), (x + lean, 1.55, 0)], [0.06, 0.055, 0.05], 6, ruv('wood', 2.0), smooth=True)
    f = Fit(R['galv'], (0.05, 0.05), 2)
    for k, y in enumerate((0.25, 0.55, 0.85, 1.15, 1.45)):
        broken = k == 2
        sag = r.uniform(0.02, 0.08)
        npt = 16
        if broken:
            # snapped strand curling down from the left post
            P = [(0.05 + 0.6 * t, y - 0.9 * t ** 2 - 0.05 * math.sin(t * 9), 0.05 * math.sin(t * 7)) for t in np.linspace(0, 1, 10)]
        else:
            P = [(x, y - sag * math.sin(math.pi * x / L) + r.normal(0, 0.006), r.normal(0, 0.008)) for x in np.linspace(0, L, npt)]
        P = np.array(P)
        mb.tube(P, 0.0035, 3, ruv('galv', 2.0), smooth=True, twist=0.6)
        # barbs: 4-point twisted barbs every ~12 cm
        cum = 0.0
        for i in range(len(P) - 1):
            seg = P[i + 1] - P[i]; Ls = np.linalg.norm(seg)
            for s in np.arange(0, Ls, 0.12):
                p = P[i] + seg * (s / Ls); d = seg / Ls
                for ang in (0.6, 2.2):
                    o = np.array([0, math.cos(ang), math.sin(ang)]) * 0.02
                    mb.tube([p - o + d * 0.004, p + o - d * 0.004], 0.0025, 3, ruv('galv'), smooth=False)
    return mb


def main():
    paths = atlas()
    reset_scene()
    m = make_material('pole_metal_concrete', *paths)
    mw = make_material('razor_wire', *paths, double=True)
    info = {}
    def emit(mb, mat, loc, attach=None):
        if mat is m:          # single-sided pole material (razor wire is double sided)
            fix_mb(mb)
        ob = mb.to_object(mb.name, [mat], smooth_angle=50, location=loc)
        if attach is not None:
            for i, p in enumerate(attach):
                e = add_empty(f'attach_{i}', p, parent=ob)
        mn, mx = mb.bounds()
        info[mb.name] = {'tris': mb.tris(), 'bbox_min': [round(float(v), 2) for v in mn], 'bbox_max': [round(float(v), 2) for v in mx]}
        if attach is not None:
            info[mb.name]['attach'] = [[round(float(v), 3) for v in p] for p in attach]
        print(f'{mb.name:22s} {mb.tris():6d} tris')
    p, att = utility_pole(); emit(p, m, (0, 0, 0), att)
    p, att = utility_pole('utility_pole_broken', broken=True, seed=2); emit(p, m, (4, 0, 0), att)
    p, att = trolley_pole(); emit(p, m, (8, 0, 0), att)
    emit(concertina(), mw, (14, 0, 0))
    emit(barbed_fence(), mw, (20, 0, 0))
    size = export_glb(os.path.join(REPO, 'assets', 'env', 'wires.glb'))
    print('wires.glb', size / 1e6)
    update_manifest('wires', {'file': 'wires.glb', 'nodes': info, 'notes':
        'Poles: origin at ground, wire run along local +X, crossarm along local Z; attach_* empties are children of the pole node, '
        'positions given in pole-local glTF coords. utility_pole_broken: snapped at 1.3 m, top hanging on rebar (attach points '
        'follow the fallen top - the game should treat it as a broken pole). trolleybus_pole: attach_0 = span-wire strain insulator '
        '(6.9 m, road side +Z), attach_1 = feeder (6.25 m). concertina_coil: 6 m stretched coil along X, 0.9 m dia; '
        'barbed_wire_fence: 3 m segment along X with one snapped strand.'})


if __name__ == '__main__':
    main()
