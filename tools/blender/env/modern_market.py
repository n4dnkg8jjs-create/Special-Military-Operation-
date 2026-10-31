"""Neighbourhood supermarket for modern.glb (supermarket / supermarket_damaged), modelled on the 2005-2020 single-
storey retail boxes of ATB / Silpo / Varus / Novus / Pyaterochka / Magnit at the edge of a microdistrict -- unbranded.
Box 40 x 22 m (x -20..20, z -11..11 before recentring), parapet 6.0 m, flat PVC roof at 5.35 m.  Two-tone envelope:
light-grey horizontal sandwich panels on the sides / back, anthracite ACM cassettes on the shop front and corner piers,
a red ACM fascia band (4.5-6.0 m) along the front that wraps 6 m round both ends, galvanised coping, granite-look
plinth.  +Z front: 18 m aluminium shopfront (12 bays of 1.5 m, transom, interior shelving seen through the glass), a
projecting glazed vestibule with sliding doors (x 3..9.5, 3 m deep), white 'ПРОДУКТИ' box letters + basket lightbox on
the fascia, 26 x 4.6 m steel entrance canopy on 5 round columns with an 'СУПЕРМАРКЕТ' lightbox and LED downlights,
ATM, payment terminal, parcel locker, citylight, shelter / hours signs, trolley shelter, concrete apron.  +X end:
loading dock (concrete platform 1.15 m, two roller shutters, bumpers, chequer levellers, ramp with railing, steps,
canopy on tie rods, pallets).  -X end: emergency exit, euro-bin enclosure in profiled sheeting.  Roof: two AHUs with
ducts, three refrigeration condensers on rails, six smoke-vent domes, roof hatch, bakery flue; downpipes, wall
floodlights, split ACs, electrical cabinet, louvres.
Damaged twin: shopfront blown in (bent / missing mullions, shard-rimmed and cracked panes, OSB-boarded bays), interior
exposed (toppled gondolas, checkouts, hanging ceiling tiles), vestibule wrecked, right half of the canopy collapsed
onto the apron with its columns down, sagging roof bay with a torn hole and exposed purlins, shot-up fascia with
letters missing / hanging / fallen, scorch above the openings, a shutter blown out, glass / cladding / stock debris.
"""
import math
import numpy as np
from shapely.geometry import Polygon, Point, box as sbox
from meshlib import Fit, newell, xform, mat_trs, rot_axis, rng, blob
import modern_geo as MG
import modern_market_atlas as MKA
import city_geo as G
from city_geo import tquad, tbox, fbox, wall, lathe, chunk
from modern_geo import TMB, T, RS, tint, soot_blob, ground_ao, frame, beam, cyl, disc, aquad, rubble, PI

X0, X1, Z0, Z1 = -20.0, 20.0, -11.0, 11.0
HP, HR, HF, PL, TH = 6.0, 5.35, 4.5, 0.45, 0.25
SF0, SF1, SFH = -16.5, 1.5, 3.7          # storefront x range, head height
VX0, VX1, VZ1, VH = 3.0, 9.5, 14.0, 3.0  # vestibule
CX0, CX1, CZ1, CY0, CY1 = -11.0, 15.0, 15.1, 3.85, 4.45     # canopy
COLS = (-10.6, -3.6, 3.4, 9.1, 14.6)
CZC = 14.7


def MS(k):
    return G.R['sm_misc'].sub(*MKA.MISC[k])


def MS2(k):
    return G.R['sm_misc2'].sub(*MKA.MISC2[k])


FAS = lambda: RS('sm_fascia', 0, 0.5, 1, 1)
FAS_D = lambda: RS('sm_fascia', 0, 0, 1, 0.5)
GLASS = lambda v: RS('sm_glass', v / 4, 0, (v + 1) / 4, 1)
SHOT = lambda: RS('sm_glass_dmg', 0, 0, 0.5, 1)
OSB = lambda: RS('sm_glass_dmg', 0.5, 0, 1, 1)


def WALLS():
    """side -> (frame, length); local x along the wall, y up, +z outward, wall occupies local z -TH..0."""
    return {'front': (frame((X0, 0, Z1), (1, 0, 0)), X1 - X0), 'back': (frame((X1, 0, Z0), (-1, 0, 0)), X1 - X0),
            'east': (frame((X1, 0, Z1), (0, 0, -1)), Z1 - Z0), 'west': (frame((X0, 0, Z0), (0, 0, 1)), Z1 - Z0)}


def lq(mb, M, x0, y0, x1, y1, z, reg, uvs=((0, 0), (1, 0), (1, 1), (0, 1))):
    """Wall-local quad (normal +z local) mapped once onto reg."""
    G.quad(mb, [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], reg, uvs, M=M)


def opoly(mb, P, reg, size, want):
    """Polygon with its normal turned towards `want`."""
    P = np.asarray(P, float)
    if np.dot(newell(P), want) < 0:
        P = P[::-1]
    mb.poly(P, Fit(G.reg_of(reg), size, 0))


# ------------------------------------------------------------------ box letters (Blender font -> mesh)
_LET = {}


def letters(text, cap=1.0, depth=0.12):
    """[(letter index, tris (3 x 3 array), 'face'|'side')] for `text` in DejaVu Sans Bold: baseline y = 0, starts at
    x = 0, back at z = 0, face at z = depth, cap height = cap.  Back faces dropped (mounted on the fascia)."""
    key = (text, cap, depth)
    if key in _LET:
        return _LET[key]
    import bpy, bmesh
    fnt = bpy.data.fonts.load(MKA.FONT_B, check_existing=True)

    def mesh(t):
        cu = bpy.data.curves.new('_t', 'FONT'); cu.body = t; cu.font = fnt; cu.size = 1.0; cu.extrude = 0.5; cu.resolution_u = 2
        ob = bpy.data.objects.new('_t', cu); bpy.context.scene.collection.objects.link(ob)
        dg = bpy.context.evaluated_depsgraph_get(); ev = ob.evaluated_get(dg); me = ev.to_mesh()
        bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.triangulate(bm, faces=bm.faces)
        out = [(np.array([list(v.co) for v in f.verts]), f.normal.z) for f in bm.faces]
        bm.free(); ev.to_mesh_clear(); bpy.data.objects.remove(ob); bpy.data.curves.remove(cu)
        return out
    ref = mesh('П'); ys = np.concatenate([t[0][:, 1] for t in ref]); s = cap / (ys.max() - ys.min())
    edges = [0.0]
    for i in range(1, len(text) + 1):
        if text[i - 1] == ' ':
            edges.append(edges[-1]); continue
        m = mesh(text[:i]); edges.append(max(float(t[0][:, 0].max()) for t in m))
    out = []
    for P, nz in mesh(text):
        if nz < -0.5:
            continue
        cx = P[:, 0].mean()
        li = next((i for i in range(len(text)) if cx <= edges[i + 1] + 1e-4), len(text) - 1)
        Q = P.copy(); Q[:, :2] *= s; Q[:, 2] = (Q[:, 2] + 0.5) * depth
        out.append((li, Q, 'face' if nz > 0.5 else 'side'))
    _LET[key] = out
    return out


def add_letters(mb, M, text, x0, y0, cap, depth=0.12, skip=(), per=None):
    """Box letters on a wall (local frame M): per = {letter index: 4x4 local transform about the letter origin}."""
    face, side = MS('letter_face'), MS('letter_side')
    uf, us = face.uv(0.5, 0.5), side.uv(0.5, 0.5)
    tris = letters(text, cap, depth)
    for li, Q, kind in tris:
        if li in skip:
            continue
        P = Q + np.array([x0, y0, 0.0])
        if per and li in per:
            P = xform(P, per[li])
        P = xform(P, M)
        mb.face(mb.vs(P), [uf if kind == 'face' else us] * 3)


def letter_bounds(text, cap, depth=0.12):
    b = {}
    for li, Q, _ in letters(text, cap, depth):
        lo, hi = b.get(li, (np.full(3, 1e9), np.full(3, -1e9)))
        b[li] = (np.minimum(lo, Q.min(0)), np.maximum(hi, Q.max(0)))
    return b


# ------------------------------------------------------------------ mesh refinement (vertex colour resolution)
def refine(mb, centres, radius, maxlen=0.6, mat=0, keep=None):
    """Split faces (of material `mat`) near any centre into triangles no longer than ~maxlen, so soot / AO vertex
    colours get resolution.  UVs interpolate linearly (exact for planar mapped faces)."""
    C = [np.asarray(c, float) for c in centres]
    Rr = list(radius) if not np.isscalar(radius) else [radius] * len(C)
    dist = lambda p: min(np.linalg.norm(p - c) - rr for c, rr in zip(C, Rr))
    newF = []
    for (idx, uv, sm, mt) in mb.F:
        P = np.array([mb.V[i] for i in idx])
        if mt != mat or len(idx) < 3 or dist(P.mean(0)) > np.ptp(P, 0).max() / 2 or (keep and not keep(P.mean(0))):
            newF.append((idx, uv, sm, mt)); continue
        stack = [((idx[0], idx[k], idx[k + 1]), (uv[0], uv[k], uv[k + 1])) for k in range(1, len(idx) - 1)]
        while stack:
            t, u = stack.pop()
            Pt = [mb.V[i] for i in t]
            Ls = [np.linalg.norm(Pt[(k + 1) % 3] - Pt[k]) for k in range(3)]
            near = dist(np.mean(Pt, 0)) < max(Ls) * 0.5
            if max(Ls) <= maxlen or not near:
                newF.append((t, list(u), sm, mt)); continue
            k = int(np.argmax(Ls)); a, b, c = k, (k + 1) % 3, (k + 2) % 3
            m = mb.v((Pt[a] + Pt[b]) / 2); um = ((u[a][0] + u[b][0]) / 2, (u[a][1] + u[b][1]) / 2)
            stack.append(((t[a], m, t[c]), (u[a], um, u[c])))
            stack.append(((m, t[b], t[c]), (um, u[b], u[c])))
    mb.F = newF


# ------------------------------------------------------------------ parts
def flood(mb, M, x, y, tilt=0.5):
    """LED floodlight on a short bracket, wall-local (x, y)."""
    tbox(mb, (x - 0.03, y - 0.03, 0), (x + 0.03, y + 0.03, 0.28), 'steel_dark', faces='+x-x+y-y', M=M)
    Mh = M @ T(x, y, 0.3) @ rot_axis((1, 0, 0), tilt)
    fbox(mb, (-0.18, -0.03, -0.12), (0.18, 0.03, 0.12), 'steel_dark', faces='+y+x-x+z-z', M=Mh)
    fbox(mb, (-0.16, -0.032, -0.1), (0.16, -0.031, 0.1), MS('flood'), faces='-y', M=Mh)


def downpipe(mb, M, x, top=HP - 0.75, out=0.12):
    """Scupper + hopper + 110 mm pipe + shoe on a wall (local x)."""
    tbox(mb, (x - 0.15, top - 0.05, 0), (x + 0.15, top + 0.12, 0.28), 'steel_dark', (1, 1), M=M, faces='+x-x+y+z')
    fbox(mb, (x - 0.16, top - 0.45, 0.02), (x + 0.16, top - 0.08, 0.3), 'steel_dark', faces='+x-x+z-y', M=M)
    cyl(mb, xform(np.array([[x, top - 0.45, out]]), M)[0], xform(np.array([[x, 0.35, out]]), M)[0], 0.055, 6, 'steel_dark', seg=3.0)
    beam(mb, xform(np.array([[x, 0.38, out]]), M)[0], xform(np.array([[x, 0.12, out + 0.3]]), M)[0], 0.11, 0.11, 'steel_dark', faces='+y-y+z-z')
    for y in np.arange(1.0, top - 0.5, 1.6):
        tbox(mb, (x - 0.07, y, 0), (x + 0.07, y + 0.04, out), 'steel_galv', M=M, faces='+y+x-x')


def column(mb, x, z, h, M=None, r=0.11):
    tmp = TMB()
    cyl(tmp, (x, 0.0, z), (x, h, z), r, 8, 'steel_dark', seg=4.0)
    tbox(tmp, (x - 0.22, 0, z - 0.22), (x + 0.22, 0.18, z + 0.22), 'concrete', (0.5, 0.5), faces='+x-x+y+z-z')
    tbox(tmp, (x - 0.18, h - 0.06, z - 0.18), (x + 0.18, h, z + 0.18), 'steel_dark', faces='+x-x-y+z-z')
    mb.merge(tmp, M)


def ahu(mb, cx, cz, y0, M2=None, L=3.6, D=1.4, H=1.5):
    """Rooftop air-handling unit on a base frame, louvred sides, two fan discs on top, access door."""
    tmp = TMB()
    tbox(tmp, (-L / 2 - 0.1, 0, -D / 2 - 0.1), (L / 2 + 0.1, 0.2, D / 2 + 0.1), 'steel_dark', (2, 1), faces='+x-x+z-z+y')
    fbox(tmp, (-L / 2, 0.2, -D / 2), (L / 2, 0.2 + H, D / 2), MS('louvre'), faces='+z-z')
    fbox(tmp, (-L / 2, 0.2, -D / 2), (L / 2, 0.2 + H, D / 2), MS2('cond_side'), faces='+x-x')
    tbox(tmp, (-L / 2 - 0.04, 0.2 + H, -D / 2 - 0.04), (L / 2 + 0.04, 0.26 + H, D / 2 + 0.04), 'steel_galv', (2, 2), faces='+y+x-x+z-z')
    for fx in (-L / 4, L / 4):
        lathe(tmp, [(0.5, 0), (0.5, 0.18), (0.46, 0.2)], 8, 'steel_galv', M=T(fx, 0.26 + H, 0))
        disc(tmp, (fx, 0.47 + H, 0), (0, 1, 0), 0.46, 8, MS('fan'))
    mb.merge(tmp, T(cx, y0, cz) if M2 is None else M2)


def condenser(mb, cx, cz, y0):
    tmp = TMB()
    for z in (-0.4, 0.4):
        tbox(tmp, (-1.3, 0, z - 0.06), (1.3, 0.25, z + 0.06), 'steel_dark', (2, 1), faces='+x-x+z-z+y')
    fbox(tmp, (-1.1, 0.25, -0.5), (1.1, 1.25, 0.5), MS2('cond_side'), faces='+z-z')
    fbox(tmp, (-1.1, 0.25, -0.5), (1.1, 1.25, 0.5), 'steel_galv', faces='+x-x')
    tbox(tmp, (-1.1, 1.25, -0.5), (1.1, 1.27, 0.5), 'steel_galv', (2, 1), faces='+y')
    for fx in (-0.55, 0.55):
        disc(tmp, (fx, 1.28, 0), (0, 1, 0), 0.42, 8, MS('fan'))
    mb.merge(tmp, T(cx, y0, cz))


def dome(mb, cx, cz, y0, s=1.3):
    tbox(mb, (cx - s / 2, y0, cz - s / 2), (cx + s / 2, y0 + 0.35, cz + s / 2), 'steel_galv', (1.5, 0.5), faces='+x-x+z-z')
    c = [(cx - s / 2, cz - s / 2), (cx + s / 2, cz - s / 2), (cx + s / 2, cz + s / 2), (cx - s / 2, cz + s / 2)]
    ap = np.array([cx, y0 + 0.62, cz]); reg = MS('dome')
    uvc = [(0, 0), (1, 0), (1, 1), (0, 1)]
    for k in range(4):
        a, b = c[k], c[(k + 1) % 4]
        P = np.array([[a[0], y0 + 0.35, a[1]], [b[0], y0 + 0.35, b[1]], ap])
        U = [reg.uv(*uvc[k]), reg.uv(*uvc[(k + 1) % 4]), reg.uv(0.5, 0.5)]
        if newell(P)[1] < 0:
            P = P[::-1]; U = U[::-1]
        mb.face(mb.vs(P), U)


def trolley_row(mb, M, n=8):
    """Nested trolleys (one long wire box + handle + child seats) along local +X from 0."""
    L = 0.95 + 0.28 * (n - 1)
    fbox(mb, (0, 0.18, -0.29), (L, 1.0, 0.29), MS('trolley'), faces='+z-z', M=M)
    fbox(mb, (0, 0.18, -0.29), (L, 1.0, 0.29), MS('trolley'), faces='+x-x+y', M=M)
    tbox(mb, (L - 0.04, 0.98, -0.3), (L + 0.12, 1.04, 0.3), RS('plastic_play', 0.05, 0.55, 0.45, 0.95), faces='+x-x+y-y+z-z', M=M)


def trolley(mb, M):
    """Single shopping trolley (front = local +X): tapered wire basket, handle, chassis, castors."""
    t = MS('trolley')
    P = lambda x, y, z: (x, y, z)
    bot = [P(-0.42, 0.42, -0.24), P(0.42, 0.48, -0.2), P(0.42, 0.48, 0.2), P(-0.42, 0.42, 0.24)]
    top = [P(-0.5, 1.0, -0.28), P(0.44, 0.98, -0.24), P(0.44, 0.98, 0.24), P(-0.5, 1.0, 0.28)]
    tmp = TMB(); c = np.array([0, 0.7, 0])
    for k in range(4):
        Q = np.array([bot[k], bot[(k + 1) % 4], top[(k + 1) % 4], top[k]])
        if np.dot(newell(Q), Q.mean(0) - c) < 0:
            Q = Q[::-1]
        tmp.poly(Q, Fit(t, (1, 1), 0, stretch=True))
        tmp.poly(Q[::-1], Fit(t, (1, 1), 0, stretch=True))
    Qb = np.array(bot); tmp.poly(Qb if newell(Qb)[1] > 0 else Qb[::-1], Fit(t, (1, 1), 0, stretch=True))
    beam(tmp, (-0.55, 1.02, -0.27), (-0.55, 1.02, 0.27), 0.05, 0.05, RS('plastic_play', 0.06, 0.56, 0.44, 0.94))
    for z in (-0.2, 0.2):
        beam(tmp, (-0.45, 0.12, z), (0.4, 0.12, z * 0.8), 0.03, 0.03, 'steel_galv')
        beam(tmp, (-0.45, 0.12, z), (-0.5, 1.0, z * 1.3), 0.03, 0.03, 'steel_galv')
        for x in (-0.42, 0.38):
            fbox(tmp, (x - 0.05, 0.0, z - 0.02), (x + 0.05, 0.1, z + 0.02), MS('rubber'), faces='+z-z+x-x')
    mb.merge(tmp, M)


def euro_bins(mb, M, seed, tipped=False):
    import modern_props as MP
    for k, x in enumerate((-1.6, 0.0, 1.6)):
        if tipped and k == 2:
            MP.euro_bin(mb, M @ T(x + 0.5, 0.55, 0.9) @ rot_axis((1, 0, 0), 1.45) @ rot_axis((0, 1, 0), 0.4), seed + k, open_lid=1.2)
        else:
            MP.euro_bin(mb, M @ T(x, 0, 0) @ rot_axis((0, 1, 0), 0.05 * (k - 1)), seed + k, open_lid=0.3 if k == 1 else 0.0)


# ------------------------------------------------------------------ the building
def supermarket(name, damaged=False, seed=340):
    mb = TMB(name); r = rng(seed)
    W = WALLS()
    soot = []
    back = 'interior_dark' if damaged else False
    Mf, Lf = W['front']
    # ---------------- walls ----------------
    # front: anthracite ACM below the fascia with the shopfront + vestibule openings; red fascia above
    sfh = (SF0 - X0, PL, SF1 - X0, SFH)
    vh = (VX0 - X0, 0.0, VX1 - X0, 3.4)
    wall(mb, (0, PL, Lf, HF), TH, 'sm_acm', (3.0, 2.0), holes=[sfh, (VX0 - X0, PL, VX1 - X0, 3.4)], M=Mf, back=back, side='steel_galv', cap='none')
    if damaged:
        for (a, b, reg) in ((0, 12, FAS()), (12, 31, FAS_D()), (31, Lf, FAS())):
            wall(mb, (a, HF, b, HP), TH, reg, (3.0, 1.5), M=Mf, back=back, cap='none', org=(0, HF))
    else:
        wall(mb, (0, HF, Lf, HP), TH, FAS(), (3.0, 1.5), M=Mf, back=back, cap='none', org=(0, HF))
    for (a, b) in ((0, VX0 - X0), (VX1 - X0, Lf)):
        tbox(mb, (a, 0, 0), (b, PL, 0.03), 'plinth', (1.2, 0.6), M=Mf, faces='+z+y')
    # vestibule floor gap: low threshold in the opening
    tbox(mb, (VX0 - X0, 0, -TH), (VX1 - X0, 0.12, 0.0), 'concrete', (1, 1), M=Mf, faces='+y+z')
    # sides + back: light-grey sandwich, ACM corner piers + red fascia wrap 6 m at the front ends
    Me, Le = W['east']; Mw, Lw_ = W['west']; Mb, Lb = W['back']
    sh_e = [(13.0, 1.15, 16.0, 4.15), (17.5, 1.15, 20.5, 4.15)]           # roller shutters (wz -2..-5, -6.5..-9.5)
    ex_w = (13.5, 0.0, 14.5, 2.1)                                          # emergency exit (wz 2.5..3.5)
    dr_b = (25.5, 0.0, 26.5, 2.1)                                          # staff door (x -5.5..-6.5)
    for side, M_, Lw, holes, front_at0 in (('east', Me, Le, sh_e, True), ('west', Mw, Lw_, [ex_w], False), ('back', Mb, Lb, [dr_b], None)):
        if front_at0 is None:
            wall(mb, (0, PL, Lw, HP), TH, 'sm_clad', (3.0, 3.0), holes=holes, M=M_, back=back, side='steel_galv', cap='none')
        else:
            p0, p1 = (0.0, 1.5) if front_at0 else (Lw - 1.5, Lw)       # ACM pier
            f0, f1 = (0.0, 6.0) if front_at0 else (Lw - 6.0, Lw)       # fascia wrap
            c0, c1 = (1.5, Lw) if front_at0 else (0.0, Lw - 1.5)       # sandwich below the fascia line
            wall(mb, (p0, PL, p1, HF), TH, 'sm_acm', (3.0, 2.0), M=M_, back=back, cap='none')
            wall(mb, (f0, HF, f1, HP), TH, FAS(), (3.0, 1.5), M=M_, back=back, cap='none', org=(f0 if front_at0 else f1 - 6.0, HF))
            sw = (c0, PL, c1, HF)
            wall(mb, sw, TH, 'sm_clad', (3.0, 3.0), holes=[h for h in holes if h[0] >= c0 - 1e-6 and h[2] <= c1 + 1e-6], M=M_, back=back, side='steel_galv', cap='none')
            up = (6.0, HF, Lw, HP) if front_at0 else (0.0, HF, Lw - 6.0, HP)
            wall(mb, up, TH, 'sm_clad', (3.0, 3.0), M=M_, back=back, cap='none', org=(0, 0))
        tbox(mb, (0, 0, 0), (Lw, PL, 0.03), 'plinth', (1.2, 0.6), M=M_, faces='+z+y')
    # coping + parapet inner faces (membrane upstand)
    for side, (M_, Lw) in W.items():
        tbox(mb, (-0.05, HP, -TH - 0.05), (Lw + 0.05, HP + 0.06, 0.06), 'steel_galv', (3.0, 0.4), M=M_, faces='+y+z-z')
        tquad(mb, (Lw, HR, -TH), (-1, 0, 0), (0, 1, 0), Lw, HP - HR, 'sm_roof', (4.0, 4.0), M=M_)
    # ---------------- roof ----------------
    hole = None
    if damaged:
        hole = Polygon(blob(6.0, -0.5, 3.4, 2.6, 16, seed + 2, 0.35, 0.4)).buffer(0)

    def roof_y(x, z):
        if not damaged:
            return HR
        return HR - 1.5 * math.exp(-((x - 6.0) / 7.5) ** 2 - ((z + 0.5) / 5.5) ** 2)
    rx0, rx1, rz0, rz1 = X0 + TH, X1 - TH, Z0 + TH, Z1 - TH
    if not damaged:
        tquad(mb, (rx0, HR, rz1), (1, 0, 0), (0, 0, -1), rx1 - rx0, rz1 - rz0, 'sm_roof', (4.0, 4.0))
    else:
        from meshlib import tessellate
        from shapely.geometry.polygon import orient
        nx, nz = 14, 8; rg = G.R['sm_roof']; di = G.R['interior_dark']
        xs = np.linspace(rx0, rx1, nx + 1); zs = np.linspace(rz0, rz1, nz + 1)
        top = [[mb.v((x, roof_y(x, z), z)) for z in zs] for x in xs]
        bot = [[mb.v((x, roof_y(x, z), z)) for z in zs] for x in xs]
        for i in range(nx):
            for j in range(nz):
                x0, x1, z0, z1 = xs[i], xs[i + 1], zs[j], zs[j + 1]
                cell = sbox(x0, z0, x1, z1)
                uvf = lambda x, z, R=rg: R.uv((x - x0) / 4.0, (z - z0) / 4.0)
                if not hole.intersects(cell):
                    q = [(i, j + 1), (i + 1, j + 1), (i + 1, j), (i, j)]       # CCW from above (x right, z down)
                    for tri in ((0, 1, 2), (0, 2, 3)):
                        ids = [q[t] for t in tri]
                        mb.face([top[a_][b_] for a_, b_ in ids], [uvf(xs[a_], zs[b_]) for a_, b_ in ids], True)
                        ids = ids[::-1]
                        mb.face([bot[a_][b_] for a_, b_ in ids], [uvf(xs[a_], zs[b_], di) for a_, b_ in ids], True)
                    continue
                for pg in G._polys(cell.difference(hole)):
                    if pg.area < 0.02:
                        continue
                    pg = orient(pg.simplify(0.02), 1.0)
                    loops = [np.array(pg.exterior.coords)[:-1]] + [np.array(rr.coords)[:-1] for rr in pg.interiors]
                    allp = np.concatenate(loops)
                    for tri in tessellate(loops):
                        P = np.array([(allp[t][0], roof_y(allp[t][0], allp[t][1]), allp[t][1]) for t in tri])
                        if np.linalg.norm(np.cross(P[1] - P[0], P[2] - P[0])) < 1e-9:
                            continue
                        if newell(P)[1] < 0:
                            P = P[::-1]
                        mb.face(mb.vs(P), [uvf(p[0], p[2]) for p in P], True)
                        mb.face(mb.vs(P[::-1]), [uvf(p[0], p[2], di) for p in P[::-1]], True)
        # torn membrane flaps hanging into the hole + exposed purlins
        cx, cz = 6.0, -0.5
        for k, ang in enumerate((0.3, 1.9, 3.6, 5.0)):
            px, pz = cx + math.cos(ang) * 3.0, cz + math.sin(ang) * 2.3
            tx, tz = -math.sin(ang), math.cos(ang)
            y = roof_y(px, pz)
            a = np.array([px - tx * 0.9, y, pz - tz * 0.9]); b = np.array([px + tx * 0.9, y, pz + tz * 0.9])
            d = np.array([-math.cos(ang) * 0.5, -1.1 - 0.3 * k % 2, -math.sin(ang) * 0.5])
            G.quad(mb, [a, b, b + d * 1.05, a + d], 'sm_roof', double=True)
        for zp in (-2.4, 0.6, 2.2):
            for xa, xb in ((1.0, 6.0), (6.0, 11.5)):
                pa = (xa, roof_y(xa, zp) - 0.25, zp); pb = (xb, roof_y(xb, zp) - 0.25 - (0.35 if xb == 6.0 or xa == 6.0 else 0), zp)
                beam(mb, pa, pb, 0.12, 0.2, 'steel_dark', (3, 1))
        soot.append(((6.0, HR - 0.6, -0.5), 3.4, 0.3))
    # rooftop plant
    if damaged:
        ahu(mb, 0, 0, 0, M2=T(9.5, roof_y(9.5, 3.5) - 0.15, 3.5) @ rot_axis((0, 0, 1), 0.16) @ rot_axis((1, 0, 0), -0.12))
    else:
        ahu(mb, 9.5, 3.5, HR)
    ahu(mb, -8.0, -4.0, HR)
    # ducts from the AHUs on galvanised stands
    for (xa, xb, z, y) in ((-10.0, -16.5, -4.0, HR + 0.75), (-6.0, -1.0, -4.0, HR + 0.75)):
        beam(mb, (xa, y, z), (xb, y, z), 0.7, 0.45, 'steel_galv', (2.0, 1.0))
        for xs in np.linspace(min(xa, xb) + 0.6, max(xa, xb) - 0.6, 3):
            tbox(mb, (xs - 0.04, HR, z - 0.4), (xs + 0.04, y - 0.22, z + 0.4), 'steel_galv', faces='+x-x+z')
    tbox(mb, (-17.0, HR, -4.5), (-16.0, HR + 1.2, -3.5), 'steel_galv', (1, 1), faces='+x-x+y+z-z')
    if not damaged:
        beam(mb, (7.5, HR + 0.75, 3.5), (2.5, HR + 0.75, 3.5), 0.7, 0.45, 'steel_galv', (2.0, 1.0))
        tbox(mb, (2.0, HR, 3.0), (2.8, HR + 1.0, 4.0), 'steel_galv', (1, 1), faces='+x-x+y+z-z')
    for k, x in enumerate((12.6, 15.2, 17.8)):
        condenser(mb, x, -8.6, roof_y(x, -8.6))
    beam(mb, (12.0, HR + 0.15, -7.9), (12.0, HR + 0.15, -2.0), 0.3, 0.08, 'steel_galv', (2, 1))     # cable tray
    for (x, z) in ((-14.0, 4.5), (-6.5, 4.5), (1.0, 6.5), (-14.0, -6.5), (3.0, -7.0), (16.0, 4.5)):
        if damaged and hole.distance(Point(x, z)) < 1.5:
            continue
        dome(mb, x, z, roof_y(x, z))
    tbox(mb, (-18.4, HR, -9.6), (-17.4, HR + 0.5, -8.6), 'steel_galv', (1, 1), faces='+x-x+z-z')
    tbox(mb, (-18.45, HR + 0.5, -9.65), (-17.35, HR + 0.6, -8.55), 'steel_dark', (1, 1), faces='+x-x+y+z-z')
    lathe(mb, [(0.22, 0), (0.22, 1.4), (0.45, 1.45), (0.05, 1.7)], 8, 'steel_galv', M=T(-15.0, HR, 7.5))
    for (a, b) in (((-17.9, -8.4), (-17.9, -5.0)), ((-17.9, -5.0), (-10.2, -5.0)), ((-10.2, -5.0), (12.0, -7.0)), ((12.0, -7.0), (12.0, -9.6))):
        a = np.array(a); b = np.array(b); d = b - a; Lp = float(np.linalg.norm(d)); d /= Lp; nrm = np.array([-d[1], d[0]]) * 0.3
        P = [(a[0] - nrm[0], 0, a[1] - nrm[1]), (b[0] - nrm[0], 0, b[1] - nrm[1]), (b[0] + nrm[0], 0, b[1] + nrm[1]), (a[0] + nrm[0], 0, a[1] + nrm[1])]
        P = [(p[0], roof_y(p[0], p[2]) + 0.015, p[2]) for p in P]
        opoly(mb, P, 'fbs', (2.4, 0.6), (0, 1, 0))
    # ---------------- shopfront ----------------
    bays = int(round((SF1 - SF0) / 1.5))
    var = [0, 1, 3, 0, 2, 1, 3, 0, 1, 2, 3, 1]
    plan = ['glass'] * bays
    if not damaged:
        plan[4] = 'osb'; plan[9] = 'osb'; plan[6] = 'shot'
    else:
        plan = ['osb', 'open', 'open', 'crack', 'open', 'shot', 'open', 'open', 'osb', 'open', 'shot', 'osb']
    for i in range(bays):
        x0 = SF0 - X0 + i * 1.5
        k = plan[i]
        if k == 'glass':
            lq(mb, Mf, x0, PL, x0 + 1.5, SFH, -0.09, GLASS(var[i]))
        elif k == 'osb':
            lq(mb, Mf, x0 + 0.02, PL, x0 + 1.48, SFH, -0.02, OSB())
        elif k == 'shot':
            lq(mb, Mf, x0, PL, x0 + 1.5, SFH, -0.09, SHOT())
        elif k == 'crack':
            aquad(mb, xform(np.array([[x0, PL, -0.09], [x0 + 1.5, PL, -0.09], [x0 + 1.5, 2.75, -0.09], [x0, 2.75, -0.09]]), Mf), 'glass_crack_b')
        if damaged and k in ('open', 'osb', 'shot'):
            soot.append((xform(np.array([[x0 + 0.75, SFH + 0.1, 0.0]]), Mf)[0], 2.6, 0.13 if k == 'open' else 0.3))
    for i in range(bays + 1):
        x = SF0 - X0 + i * 1.5
        if damaged and 0 < i < bays and r.random() < 0.5:
            if r.random() < 0.35:
                continue          # torn out
            ang = r.uniform(0.3, 1.0)
            Mb_ = Mf @ rot_axis((1, 0, 0), -ang, origin=(x, PL, 0)) @ rot_axis((0, 0, 1), r.uniform(-0.3, 0.3), origin=(x, PL, 0))
            tbox(mb, (x - 0.035, PL, -0.12), (x + 0.035, PL + r.uniform(1.2, 2.9), 0.0), 'steel_galv', (1, 3), M=Mb_, faces='+x-x+z-z')
        else:
            tbox(mb, (x - 0.035, PL, -0.12), (x + 0.035, SFH, 0.02), 'steel_galv', (1, 3.5), M=Mf, faces='+x-x+z')
    for (y0, y1) in ((SFH - 0.08, SFH), (PL, PL + 0.08), (2.75, 2.82)):
        if damaged and y0 > 2.7 and y0 < 3:
            for i in range(bays):
                if plan[i] in ('osb', 'crack') or r.random() < 0.4:
                    x = SF0 - X0 + i * 1.5
                    tbox(mb, (x, y0, -0.12), (x + 1.5, y1, 0.02), 'steel_galv', (1.5, 1), M=Mf, faces='+z+y-y')
            continue
        tbox(mb, (SF0 - X0, y0, -0.12), (SF1 - X0, y1, 0.02), 'steel_galv', (3, 1), M=Mf, faces='+z+y-y')
    # ---------------- vestibule ----------------
    vest(mb, damaged, r, soot)
    # ---------------- signage on the fascia ----------------
    cap = 1.05; text = 'ПРОДУКТИ'
    lb = letter_bounds(text, cap)
    tw = max(b[1][0] for b in lb.values())
    lx0 = (SF0 + SF1) / 2 - X0 - tw / 2 + 0.8; ly0 = HF + (HP - HF - cap) / 2 + 0.03
    per = {}; skip = ()
    if damaged:
        skip = (2, 7)
        lo, hi = lb[5]
        per[5] = rot_axis((0, 0, 1), -0.62, origin=(lx0 + lo[0], ly0 + hi[1], 0.0)) @ T(0, 0, 0.05)
        lo, hi = lb[3]
        per[3] = rot_axis((0, 0, 1), 0.12, origin=(lx0 + hi[0], ly0 + hi[1], 0.0))
    add_letters(mb, Mf, text, lx0, ly0, cap, 0.14, skip=skip, per=per)
    if damaged:     # fallen 'О' on the apron, face down-ish
        Mg = T(-8.6, 0.12, 13.4) @ rot_axis((1, 0, 0), -1.45) @ rot_axis((0, 1, 0), 0.5)
        add_letters(mb, Mg, 'О', 0, 0, cap, 0.14)
    lgx = lx0 - 1.75
    tbox(mb, (lgx, HF + 0.12, 0), (lgx + 1.26, HP - 0.12, 0.22), 'steel_dark', M=Mf, faces='+x-x+y-y')
    lq(mb, Mf, lgx, HF + 0.12, lgx + 1.26, HP - 0.12, 0.22, MS('logo'))
    # ---------------- canopy ----------------
    if damaged:
        left, right = TMB(), TMB()
        canopy(left, CX0, COLS[2] + 0.2, r); canopy(right, COLS[2] + 0.2, CX1, r, sign=True)
        mb.merge(left, rot_axis((1, 0, 0), 0.035, origin=(0, CY1, Z1)))
        Mr = rot_axis((0, 0, 1), -0.08, origin=(COLS[2], CY1, Z1)) @ rot_axis((1, 0, 0), 0.95, origin=(0, CY1, Z1 + 0.05))
        mb.merge(right, Mr)
        for x in COLS[:3]:
            column(mb, x, CZC, CY0)
        column(mb, 0, 0, CY0, M=T(9.1, 0.32, 16.2) @ rot_axis((0, 1, 0), 0.5) @ rot_axis((0, 0, 1), -1.5) @ T(0, -0.2, 0))
        column(mb, 0, 0, 1.8, M=T(14.6, 0, CZC))
        column(mb, 0, 0, 2.1, M=T(14.6, 1.75, CZC) @ rot_axis((1, 0, 0), 1.1) @ T(0, 0, 0))
        soot.append(((4.5, 3.5, 13.5), 3.2, 0.3))
    else:
        canopy(mb, CX0, CX1, r, sign=True)
        for x in COLS:
            column(mb, x, CZC, CY0)
        cyl(mb, (14.75, CY0, CZC + 0.15), (14.75, 0.25, CZC + 0.15), 0.055, 6, 'steel_dark', seg=3.0)
    # ---------------- front right: ATM, terminal, parcel locker, citylight, signs ----------------
    front_dressing(mb, Mf, damaged, r)
    # ---------------- apron ----------------
    tbox(mb, (X0, 0, Z1), (X1, 0.1, CZ1 + 0.7), 'concrete', (2.0, 2.0), faces='+y+z-x+x')
    # ---------------- trolley shelter ----------------
    trolley_shelter(mb, damaged, r)
    # ---------------- east: loading dock ----------------
    dock(mb, Me, damaged, r, soot)
    # ---------------- west: exit + bins ----------------
    lq(mb, Mw, *ex_w[:2], ex_w[2], ex_w[3], -0.08, MS('door_exit'))
    tbox(mb, (ex_w[0] - 0.3, 2.3, 0), (ex_w[2] + 0.3, 2.4, 0.8), 'steel_dark', M=Mw, faces='+y-y+z+x-x')
    tbox(mb, (ex_w[0] - 0.5, 0, 0), (ex_w[2] + 0.5, 0.15, 1.3), 'concrete', (1, 1), M=Mw, faces='+y+z+x-x')
    lq(mb, Mw, ex_w[0] - 0.05, 2.5, ex_w[2] + 0.05, 2.72, 0.02, MS2('ukryttya'))
    bin_enclosure(mb, damaged, seed)
    # ---------------- back: staff door, cabinet, louvres, split ACs ----------------
    lq(mb, Mb, *dr_b[:2], dr_b[2], dr_b[3], -0.08, MS('door_exit'))
    tbox(mb, (dr_b[0] - 0.3, 2.3, 0), (dr_b[2] + 0.3, 2.4, 0.8), 'steel_dark', M=Mb, faces='+y-y+z+x-x')
    fbox(mb, (22.0, 0.3, 0), (23.0, 1.9, 0.35), MS2('el_cabinet'), faces='+z', M=Mb)
    fbox(mb, (22.0, 0.3, 0), (23.0, 1.9, 0.35), 'steel_galv', faces='+x-x+y', M=Mb)
    for x in (8.0, 31.0):
        lq(mb, Mb, x, 3.6, x + 1.2, 4.4, 0.02, MS2('vent'))
    for x in (14.0, 16.5, 34.0):
        fbox(mb, (x, 2.6, 0.08), (x + 0.85, 3.2, 0.38), 'steel_galv', faces='+x-x+y-y', M=Mb)
        fbox(mb, (x, 2.6, 0.08), (x + 0.85, 3.2, 0.38), MS('fan'), faces='+z', M=Mb)
        tbox(mb, (x + 0.1, 2.55, 0), (x + 0.16, 2.6, 0.4), 'steel_dark', M=Mb, faces='+y+x-x')
        tbox(mb, (x + 0.69, 2.55, 0), (x + 0.75, 2.6, 0.4), 'steel_dark', M=Mb, faces='+y+x-x')
    # ---------------- downpipes + floodlights ----------------
    for x in (4.0, 15.0, 24.0, 35.0):
        downpipe(mb, Mb, x)
    for x in (4.5, 19.5):
        downpipe(mb, Mw, x)
    downpipe(mb, Me, 8.0)
    for x in (2.5, 12.5, 20.0, 30.0, 37.5):
        flood(mb, Mb, x, 4.2)
    for x in (4.0, 11.0, 18.0):
        flood(mb, Mw, x, 4.2)
    for x in (4.0, 11.5):
        flood(mb, Me, x, 4.2)
    for x in (1.0, 37.5):
        flood(mb, Mf, x, 4.15, tilt=0.6)
    if damaged:
        interior(mb, r, seed)
        debris(mb, r, seed)
    # ---------------- vertex colours: AO + soot ----------------
    if soot:
        refine(mb, [s[0] for s in soot], [s[1] * 0.8 for s in soot], 1.2,
               keep=lambda c: (Z1 - 0.05 < c[2] < Z1 + 0.3 or X1 - 0.05 < c[0] < X1 + 0.3) and c[1] > 1.5)
    tint(mb, ground_ao(1.0, 0.6))

    def amb(p):
        k = 1.0
        if CX0 - 0.3 < p[0] < CX1 + 0.3 and Z1 - 0.3 < p[2] < CZ1 + 0.2 and p[1] < CY0 + 0.02:
            k *= 0.8 + 0.2 * min(1.0, abs(p[0] - (CX0 + CX1) / 2) / 14) ** 4    # under the canopy
        if HR - 2.0 < p[1] < HR + 0.45 and X0 < p[0] < X1 and Z0 < p[2] < Z1:
            k *= 0.78 + 0.22 * min(1.0, max(0.0, p[1] - HR + 0.05) / 0.45)       # roof plant feet, parapet corners
        return k
    tint(mb, amb)
    rn = rng(seed + 99); ph = rn.uniform(0, 6.28, 4)
    tint(mb, lambda p: 1.0 if not (HR - 1.6 < p[1] < HR + 0.02 and abs(p[0]) < X1 - 0.2 and abs(p[2]) < Z1 - 0.2) else
         0.9 + 0.07 * math.sin(p[0] * 0.31 + ph[0]) * math.cos(p[2] * 0.43 + ph[1]) + 0.05 * math.sin(p[0] * 0.13 + p[2] * 0.21 + ph[2]))
    for c, rad, k in soot:
        tint(mb, soot_blob(c, rad, k, up=1.7))
    return mb


def vest(mb, damaged, r, soot):
    """Glazed entrance vestibule (x 3..9.5, z 11..14, glass to 3.0, ACM fascia to 3.6) with sliding doors."""
    tmp = TMB()
    gl = MS2('vest_glass'); dr = MS2('vest_door')
    Mfr = frame((VX0, 0, VZ1), (1, 0, 0))               # front face, local x 0..6.5
    Msl = frame((VX0, 0, Z1), (0, 0, 1))                # left side (normal -X), local x 0..3
    Msr = frame((VX1, 0, VZ1), (0, 0, -1))              # right side (normal +X)
    W_ = VX1 - VX0; dW = 2.2; d0 = (W_ - dW) / 2
    glass_front = [(0.0, d0), (d0 + dW, W_)]
    if not damaged:
        for (a, b) in glass_front:
            lq(tmp, Mfr, a, 0.1, b, VH, -0.03, gl)
        lq(tmp, Mfr, d0, 0.1, d0 + dW, 2.5, -0.06, dr)
        lq(tmp, Mfr, d0, 2.5, d0 + dW, VH, -0.03, gl, uvs=((0, 0.8), (1, 0.8), (1, 1), (0, 1)))
        for M_ in (Msl, Msr):
            lq(tmp, M_, 0.0, 0.1, 3.0, VH, -0.03, gl)
    else:
        aquad(tmp, xform(np.array([[0.05, 0.1, -0.03], [3.0, 0.1, -0.03], [3.0, 2.2, -0.03], [0.05, 2.2, -0.03]]), Msl), 'glass_crack_a')
        G.quad(tmp, [(VX0 + 0.1, 0.13, VZ1 - 0.1), (VX1 - 0.1, 0.13, VZ1 - 0.1), (VX1 - 0.1, 0.13, Z1 + 0.1), (VX0 + 0.1, 0.13, Z1 + 0.1)], MS2('mat'))
    fbox(tmp, (d0 - 0.1, 2.5, -0.25), (d0 + dW + 0.1, 2.72, -0.03), 'steel_galv', faces='+z-y+x-x')      # door operator
    posts = [0.0, d0, d0 + dW, W_]
    for i, x in enumerate(posts):
        if damaged and i == 2:
            tbox(tmp, (-0.04, 0, -0.04), (0.04, 2.4, 0.04), 'steel_galv', (1, 3), faces='+x-x+z-z',
                 M=Mfr @ T(x, 0, 0) @ rot_axis((1, 0, 0), 0.7) @ rot_axis((0, 0, 1), 0.3))
            continue
        tbox(tmp, (x - 0.04, 0, -0.08), (x + 0.04, VH, 0.0), 'steel_galv', (1, 3), M=Mfr, faces='+x-x+z')
    for M_ in (Msl, Msr):
        for x in (1.5, 3.0):
            tbox(tmp, (x - 0.04, 0, -0.08), (x + 0.04, VH, 0.0), 'steel_galv', (1, 3), M=M_, faces='+x-x+z')
    for M_, Lw in ((Mfr, W_), (Msl, 3.0), (Msr, 3.0)):
        tbox(tmp, (0, 2.48, -0.08), (Lw, 2.53, 0.0), 'steel_galv', (2, 1), M=M_, faces='+z+y-y')
        tbox(tmp, (0, 0.0, -0.08), (Lw, 0.1, 0.0), 'steel_galv', (2, 1), M=M_, faces='+z+y')
    # fascia + roof
    tbox(tmp, (VX0 - 0.08, VH, Z1), (VX1 + 0.08, VH + 0.6, VZ1 + 0.08), 'sm_acm', (3.0, 2.0), faces='+x-x+z-y')
    tbox(tmp, (VX0 - 0.08, VH + 0.6, Z1), (VX1 + 0.08, VH + 0.64, VZ1 + 0.08), 'sm_roof', (4, 4), faces='+y')
    tbox(tmp, (VX0 - 0.1, VH + 0.53, VZ1 + 0.08), (VX1 + 0.1, VH + 0.6, VZ1 + 0.1), FAS(), (3, 1.5), faces='+z')
    if damaged:
        mb.merge(tmp, rot_axis((0, 0, 1), 0.04, origin=(VX0, 0, 0)))
        door = TMB()
        lq(door, frame((0, 0, 0), (1, 0, 0)), 0, 0, 1.1, 2.4, 0, RS('sm_misc2', MKA.MISC2['vest_door'][0], MKA.MISC2['vest_door'][1],
                                                                       (MKA.MISC2['vest_door'][0] + MKA.MISC2['vest_door'][2]) / 2, MKA.MISC2['vest_door'][3]))
        tbox(door, (0, 0, -0.03), (1.1, 2.4, 0.0), 'steel_galv', faces='+x-x+y-y')
        mb.merge(door, T(5.0, 0.16, 16.4) @ rot_axis((1, 0, 0), -PI / 2 + 0.04) @ rot_axis((0, 0, 1), 0.3))
        soot.append(((6.2, 3.2, VZ1), 2.6, 0.25))
    else:
        mb.merge(tmp)


def canopy(mb, x0, x1, r, sign=False):
    """Steel entrance canopy segment x0..x1: liner soffit with LED downlights, ACM fascia with a red line, membrane top."""
    L = x1 - x0
    tquad(mb, (x0, CY0, Z1), (1, 0, 0), (0, 0, 1), L, CZ1 - Z1, 'sm_clad', (3.0, 3.0))
    tquad(mb, (x0, CY1 - 0.05, CZ1), (1, 0, 0), (0, 0, -1), L, CZ1 - Z1, 'roof_membrane', (2.0, 2.0))
    tbox(mb, (x0, CY0 - 0.05, CZ1 - 0.15), (x1, CY1 + 0.05, CZ1 + 0.05), 'sm_acm', (3.0, 2.0), faces='+z-y+y-z')
    tbox(mb, (x0, CY0 - 0.05, CZ1 + 0.05), (x1, CY0 + 0.08, CZ1 + 0.07), FAS(), (3.0, 1.5), faces='+z')
    for xe, fc in ((x0, '-x'), (x1, '+x')):
        tbox(mb, (xe - 0.05, CY0 - 0.05, Z1), (xe + 0.05, CY1 + 0.05, CZ1 + 0.05), 'sm_acm', (3.0, 2.0), faces=fc + '-y+y')
    for x in np.arange(x0 + 1.6, x1 - 0.5, 3.2):
        disc(mb, (x, CY0 - 0.01, 13.3), (0, -1, 0), 0.13, 6, RS('lamp_parts', 0, 0.5, 0.5, 1))
    for x in np.arange(x0 + 0.1, x1, 6.5):     # beams under the soffit, into the facade
        tbox(mb, (x, CY0 - 0.25, Z1), (x + 0.16, CY0, CZ1 - 0.15), 'steel_dark', (3, 1), faces='+x-x-y')
    if sign and x0 < 6.25 < x1:
        sx0, sx1 = 6.25 - 1.7, 6.25 + 1.7
        tbox(mb, (sx0, CY0 - 0.02, CZ1 + 0.05), (sx1, CY1 + 0.25, CZ1 + 0.22), 'steel_dark', faces='+x-x+y-y')
        G.quad(mb, [(sx0, CY0 - 0.02, CZ1 + 0.221), (sx1, CY0 - 0.02, CZ1 + 0.221), (sx1, CY1 + 0.25, CZ1 + 0.221), (sx0, CY1 + 0.25, CZ1 + 0.221)], MS2('sign_super'))


def front_dressing(mb, Mf, damaged, r):
    # signs on the narrow ACM pier between shopfront and vestibule (world x 1.5..3)
    lq(mb, Mf, SF1 - X0 + 0.25, 1.2, SF1 - X0 + 1.25, 2.4, 0.01, MS2('hours'))
    lq(mb, Mf, SF1 - X0 + 0.1, 2.55, SF1 - X0 + 1.4, 2.82, 0.01, MS2('ukryttya'))
    # through-wall ATM with a hood (world x 10.6..11.4)
    ax = 10.6 - X0
    tbox(mb, (ax - 0.15, 0.0, 0), (ax + 0.95, 2.35, 0.08), 'steel_galv', M=Mf, faces='+z+x-x+y')
    fbox(mb, (ax, 0.0, 0.08), (ax + 0.8, 1.9, 0.32), 'steel_galv', faces='+x-x+y', M=Mf)
    fbox(mb, (ax, 0.0, 0.08), (ax + 0.8, 1.9, 0.32), MS('atm'), faces='+z', M=Mf)
    tbox(mb, (ax - 0.1, 1.95, 0), (ax + 0.9, 2.02, 0.5), 'steel_dark', M=Mf, faces='+y-y+z+x-x')
    # payment terminal on the apron
    Mt = T(12.3, 0.1, Z1 + 0.6) @ rot_axis((0, 1, 0), 0.0 if not damaged else 1.2)
    if damaged:
        Mt = T(12.5, 0.32, Z1 + 1.3) @ rot_axis((0, 1, 0), 0.9) @ rot_axis((1, 0, 0), -PI / 2)
    fbox(mb, (-0.3, 0, -0.22), (0.3, 1.65, 0.22), MS2('terminal'), faces='+z', M=Mt)
    fbox(mb, (-0.3, 0, -0.22), (0.3, 1.65, 0.22), RS('plastic_play', 0.6, 0.6, 0.9, 0.9), faces='+x-x+y-z', M=Mt)
    # parcel locker against the wall (world x 14.6..16.8)
    lx = 14.6 - X0
    fbox(mb, (lx, 0.1, 0), (lx + 2.2, 2.05, 0.6), MS('locker'), faces='+z', M=Mf)
    fbox(mb, (lx, 0.1, 0), (lx + 2.2, 2.05, 0.6), 'steel_galv', faces='+x-x', M=Mf)
    tbox(mb, (lx - 0.05, 2.05, 0), (lx + 2.25, 2.12, 0.66), 'steel_dark', M=Mf, faces='+y+z+x-x-y')
    # citylight lightbox on the wall (world x 18.0..19.25)
    cx_ = 18.0 - X0
    tbox(mb, (cx_, 0.6, 0), (cx_ + 1.25, 2.5, 0.16), 'steel_dark', M=Mf, faces='+x-x+y-y')
    lq(mb, Mf, cx_, 0.6, cx_ + 1.25, 2.5, 0.161, MS('citylight'))
    # litter bins by the door
    for x in (2.55, 10.0):
        if damaged and x > 5:
            lathe(mb, [(0.0, 0.0), (0.24, 0.0), (0.24, 0.75), (0.2, 0.8)], 8, 'steel_galv', M=T(x + 0.4, 0.34, 15.2) @ rot_axis((0, 0, 1), 1.5))
            continue
        lathe(mb, [(0.0, 0.1), (0.24, 0.1), (0.24, 0.85), (0.2, 0.9)], 8, 'steel_galv', M=T(x, 0, 14.6))


def trolley_shelter(mb, damaged, r):
    """Galvanised trolley shelter 4.4 x 2.2 m with a polycarbonate mono-pitch roof and two nested trolley rows."""
    x0, x1, z0, z1 = -18.8, -14.4, 12.8, 15.0
    for x in (x0, x1):
        for z in (z0, z1):
            tbox(mb, (x - 0.04, 0, z - 0.04), (x + 0.04, 2.2 if z == z0 else 2.0, z + 0.04), 'steel_galv', (1, 2), faces='+x-x+z-z')
    tbox(mb, (x0, 0.6, z0 - 0.03), (x1, 0.66, z0 + 0.03), 'steel_galv', (2, 1), faces='+y-y+z-z')
    tbox(mb, (x0, 1.1, z0 - 0.03), (x1, 1.16, z0 + 0.03), 'steel_galv', (2, 1), faces='+y-y+z-z')
    roof = TMB()
    tq = MS('dome')
    G.quad(roof, [(x0 - 0.1, 2.0, z1 + 0.15), (x1 + 0.1, 2.0, z1 + 0.15), (x1 + 0.1, 2.25, z0 - 0.1), (x0 - 0.1, 2.25, z0 - 0.1)], RS('sm_misc', MKA.MISC['dome'][0] + 0.05, MKA.MISC['dome'][1] + 0.05, MKA.MISC['dome'][0] + 0.1, MKA.MISC['dome'][1] + 0.1), double=True)
    tbox(roof, (x0 - 0.1, 2.24, z0 - 0.14), (x1 + 0.1, 2.48, z0 - 0.1), RS('plastic_play', 0.06, 0.56, 0.44, 0.94), faces='+z-z+y')
    if damaged:
        mb.merge(roof, rot_axis((1, 0, 0), -0.55, origin=(0, 2.0, z1)) @ T(0.4, 0, 0))
        trolley_row(mb, T(x0 + 0.3, 0, 13.4), 6)
        for k in range(5):
            tip = k % 2 == 0
            trolley(mb, T(-13.0 + k * 3.1 + r.uniform(-0.5, 0.5), 0.1 + (0.3 if tip else 0.0), 16.0 + r.uniform(-0.3, 1.0)) @
                    rot_axis((0, 1, 0), r.uniform(0, 6.28)) @ rot_axis((1, 0, 0), 1.5 if tip else 0.0))
    else:
        mb.merge(roof)
        trolley_row(mb, T(x0 + 0.3, 0, 13.4), 11)
        trolley_row(mb, T(x0 + 0.3, 0, 14.35), 9)
        trolley(mb, T(-12.6, 0.1, 14.9) @ rot_axis((0, 1, 0), 2.6))
        trolley(mb, T(0.6, 0.1, 15.0) @ rot_axis((0, 1, 0), -0.4))


def dock(mb, Me, damaged, r, soot):
    """Loading dock on the +X end: platform x 20..23, z -10.5..-0.5 at 1.15 m."""
    yP = 1.15
    tbox(mb, (X1, 0, -10.5), (23.0, yP, -0.5), 'concrete', (2.0, 2.0), faces='+x+y-z+z')
    tquad(mb, (22.85, yP + 0.005, -0.5), (1, 0, 0), (0, 0, -1), 0.15, 10.0, MS('hazard'), (0.15, 1.0))
    for zc in (-3.5, -8.0):
        tquad(mb, (21.0, yP + 0.006, zc + 1.2), (1, 0, 0), (0, 0, -1), 2.0, 2.4, MS('chequer'), (1.0, 1.0))
        for dz in (-1.0, 1.0):
            fbox(mb, (23.0, 0.55, zc + dz - 0.13), (23.13, 1.05, zc + dz + 0.13), MS('rubber'), faces='+x+y-y+z-z')
    # shutters + housings + guides (wall-local)
    for i, (a, y0, b, y1) in enumerate(((13.0, yP, 16.0, 4.15), (17.5, yP, 20.5, 4.15))):
        blown = damaged and i == 1
        if blown:
            sh = TMB()
            lq(sh, frame((0, 0, 0), (1, 0, 0)), 0, 0, 3.0, 1.6, 0, RS('sm_shutter', 0, 0.47, 1, 1), uvs=((0, 0), (1, 0), (1, 1), (0, 1)))
            sh2 = TMB(); lq(sh2, frame((0, 0, 0), (1, 0, 0)), 0, 0, 3.0, 1.4, 0, RS('sm_shutter', 0, 0, 1, 0.47))
            sh.merge(sh2, T(0, 0, 0) @ rot_axis((1, 0, 0), 0.9) @ T(0, -1.4, 0))
            mb.merge(sh, Me @ T(a, y1 - 1.6, 0.05) @ rot_axis((1, 0, 0), -0.35))
            lq(mb, Me, a, y0, b, y1, -0.6, 'interior_dark')
            soot.append((xform(np.array([[(a + b) / 2, y1, 0.0]]), Me)[0], 2.6, 0.22))
        else:
            lq(mb, Me, a, y0, b, y1, -0.1, 'sm_shutter')
        tbox(mb, (a - 0.12, y1, 0), (b + 0.12, y1 + 0.42, 0.42), 'steel_galv', (3.0, 0.5), M=Me, faces='+z+y-y+x-x')
        for x in (a - 0.08, b):
            tbox(mb, (x, y0, 0), (x + 0.08, y1, 0.09), 'steel_galv', (1, 3), M=Me, faces='+x-x+z')
        flood(mb, Me, (a + b) / 2, y1 + 0.75)
    # dock canopy on tie rods
    can = TMB()
    tbox(can, (X1, 4.8, -10.8), (23.6, 5.0, -0.2), 'steel_dark', (2.0, 1.0), faces='+x-x+z-z-y', regs={'+x': 'steel_dark'})
    tbox(can, (X1, 5.0, -10.8), (23.6, 5.02, -0.2), 'roof_membrane', (2.0, 2.0), faces='+y')
    for z in (-9.8, -1.2):
        beam(can, (23.4, 5.0, z), (X1, 5.85, z), 0.05, 0.05, 'steel_galv', (2, 1))
    if damaged:
        mb.merge(can, rot_axis((1, 0, 0), 0.12, origin=(0, 4.9, -10.8)) @ rot_axis((0, 0, 1), -0.05, origin=(X1, 4.9, 0)))
    else:
        mb.merge(can)
    # ramp along +Z, railing, steps at the back end
    P = [(20.1, yP, -0.5), (22.0, yP, -0.5), (22.0, 0.0, 6.0), (20.1, 0.0, 6.0)]
    opoly(mb, P, 'concrete', (2.0, 2.0), (0, 1, 0))
    opoly(mb, [(22.0, 0.0, -0.5), (22.0, yP, -0.5), (22.0, 0.0, 6.0)], 'concrete', (2.0, 2.0), (1, 0, 0))
    for (pa, pb) in (((22.0, yP + 1.0, -0.5), (22.0, 1.0, 6.0)), ((22.0, yP + 1.0, -0.5), (23.0, yP + 1.0, -0.5))):
        beam(mb, pa, pb, 0.05, 0.05, 'steel_galv', (2, 1))
    for t in np.linspace(0, 1, 5):
        x, z = 22.0, -0.5 + 6.5 * t; y = yP * (1 - t)
        tbox(mb, (x - 0.025, y, z - 0.025), (x + 0.025, y + 1.0, z + 0.025), 'steel_galv', (1, 1), faces='+x-x+z-z')
    for k in range(4):
        y = yP * (4 - k) / 4
        tbox(mb, (21.0, 0, -10.5 - 0.3 * (k + 1)), (22.4, y, -10.5 - 0.3 * k), 'concrete', (1, 1), faces='+y-z+x-x')
    # pallets + bale on the platform
    for k, (x, z, rt) in enumerate(((21.3, -5.6, 0.1), (21.4, -1.6, -0.2), (21.8, -10.0, 0.0))):
        Mpal = T(x, yP, z) @ rot_axis((0, 1, 0), rt)
        tbox(mb, (-0.6, 0, -0.4), (0.6, 0.14, 0.4), 'wood_slats', (1.2, 0.6), M=Mpal, faces='+x-x+y+z-z')
        if k == 0:
            fbox(mb, (-0.55, 0.14, -0.38), (0.55, 1.1, 0.38), MS('cardboard'), faces='+x-x+y+z-z', M=Mpal)


def bin_enclosure(mb, damaged, seed):
    """Euro-bin pad at the -X end (x -23..-20.3, z -9.5..-3.5) in brown profiled sheeting on steel posts."""
    xa, xb, za, zb = -23.0, -20.3, -9.5, -3.5
    tbox(mb, (xa - 0.2, 0, za - 0.2), (xb, 0.12, zb + 0.6), 'concrete', (2, 2), faces='+x+y-z+z')
    fence = [((xa, za), (xa, zb)), ((xb, za), (xa, za)), ((xa, zb), (xa + 1.0, zb))]
    for (a, b) in fence:
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        tquad(mb, (a[0], 0.12, a[1]), (b[0] - a[0], 0, b[1] - a[1]), (0, 1, 0), L, 1.8, 'roof_metal', (2.0, 2.0), double=True)
        for p in (a, b):
            tbox(mb, (p[0] - 0.04, 0, p[1] - 0.04), (p[0] + 0.04, 2.0, p[1] + 0.04), 'steel_dark', (1, 2), faces='+x-x+z-z+y')
    euro_bins(mb, T(-21.75, 0.12, -7.6) @ rot_axis((0, 1, 0), PI / 2), seed + 40, tipped=damaged)
    fbox(mb, (-21.9, 0.12, -4.9), (-20.8, 1.0, -3.9), MS('cardboard'), faces='+x-x+y+z-z')


def interior(mb, r, seed):
    """Exposed sales floor behind the blown-in shopfront: floor, back partition with wall shelving, gondolas (some
    toppled), checkouts, hanging ceiling tiles."""
    fl = 0.03
    tquad(mb, (X0 + TH, fl, Z1 - TH), (1, 0, 0), (0, 0, -1), X1 - X0 - 2 * TH, 9.0, 'interior_dark', (4, 4))
    zb = Z1 - TH - 9.0
    tquad(mb, (X0 + TH, 0, zb), (1, 0, 0), (0, 1, 0), X1 - X0 - 2 * TH, 2.0, 'sm_interior', (2.0, 2.0))
    tquad(mb, (X0 + TH, 2.0, zb), (1, 0, 0), (0, 1, 0), X1 - X0 - 2 * TH, 1.7, 'interior_dark', (4.0, 4.0))
    for k, z in enumerate((zb + 2.2, zb + 4.4)):
        for j, (xa, xb) in enumerate(((-17.0, -11.0), (-10.0, -4.0), (-3.0, 3.0), (4.0, 10.0))):
            tilt = 0.0
            if (k, j) in ((1, 1), (0, 2)):
                tilt = 1.35 * (1 if k else -1)
            Mg = rot_axis((1, 0, 0), tilt, origin=(0, 0, z + (0.45 if tilt > 0 else -0.45)))
            tbox(mb, (xa, 0, z - 0.45), (xb, 1.8, z + 0.45), 'sm_interior', (2.0, 2.0), faces='+z-z', M=Mg)
            tbox(mb, (xa, 0, z - 0.45), (xb, 1.8, z + 0.45), 'steel_dark', (2.0, 1.0), faces='+x-x+y', M=Mg)
    for x in (-15.0, -11.5, -8.0):
        tbox(mb, (x, 0, Z1 - 2.6), (x + 2.2, 0.9, Z1 - 1.8), 'steel_dark', (2.0, 1.0), faces='+x-x+y+z-z')
    for k in range(9):
        x = r.uniform(-17, 9); z = r.uniform(zb + 0.5, Z1 - 1.0)
        G.quad(mb, [(x, 4.0, z), (x + 0.6, 4.0, z), (x + 0.6 + r.uniform(-0.1, 0.1), 4.0 - 0.55, z + r.uniform(0.1, 0.35)), (x, 4.0 - 0.6, z + r.uniform(0.1, 0.35))], MS2('ceiling'), double=True)
    for k in range(10):
        x = r.uniform(-17, 9); z = r.uniform(zb + 0.5, Z1 - 0.5)
        G.quad(mb, [(x, fl + 0.02, z), (x + 0.6, fl + 0.02, z + 0.1), (x + 0.5, fl + 0.02, z - 0.5), (x - 0.1, fl + 0.02, z - 0.6)], MS2('ceiling'))


def debris(mb, r, seed):
    ya = 0.1
    rubble(mb, -11.0, Z1 + 1.6, 2.0, 7, seed + 5, regs=('sm_acm', 'concrete', 'sm_clad'), hmax=0.55, y0=ya)
    rubble(mb, -3.5, Z1 + 1.2, 1.6, 6, seed + 6, regs=('sm_interior', 'sm_acm', 'concrete'), hmax=0.45, y0=ya)
    rubble(mb, -6.0, Z1 - 3.5, 2.2, 6, seed + 7, regs=('sm_roof', 'concrete', 'sm_interior'), hmax=0.6, y0=0.03)
    rubble(mb, 6.0, -0.5, 3.0, 9, seed + 8, regs=('sm_roof', 'steel_dark', 'sm_clad'), hmax=0.9, y0=0.03)
    for k in range(70):
        x = r.uniform(-16.5, 9.5); z = r.uniform(Z1 + 0.1, Z1 + 4.6) if k < 50 else r.uniform(Z1 - 3.0, Z1 - 0.3)
        y = ya + 0.004 if z > Z1 else 0.04
        s = r.uniform(0.08, 0.35); a = r.uniform(0, 2 * PI)
        P = [(x, y, z), (x + math.cos(a) * s, y, z + math.sin(a) * s), (x + math.cos(a + 1.2) * s * 0.6, y, z + math.sin(a + 1.2) * s * 0.6)]
        opoly(mb, P, 'glass_dark' if k % 3 else 'car_glass', (0.4, 0.4), (0, 1, 0))
    for k in range(6):
        x = r.uniform(-15, 13); z = r.uniform(Z1 + 1.0, Z1 + 4.8)
        reg = ('sm_acm', 'sm_clad', FAS_D())[k % 3]
        tquad(mb, (0, 0, 0), (1, 0, 0), (0, 0, -1), 1.5 if k % 3 == 0 else 2.6, 1.0, reg, (3.0, 2.0) if k % 3 == 0 else (3.0, 3.0),
              M=mat_trs((x, ya + 0.05, z), (r.normal(0, 0.12), r.uniform(0, 3), r.normal(0, 0.12))), double=True)
    for k in range(14):
        x = r.uniform(-16, 8); z = r.uniform(Z1 - 4, Z1 + 3.5); s = r.uniform(0.2, 0.45)
        chunk(mb, (x, (ya if z > Z1 else 0.03) + s * 0.25, z), (s, s * 0.6, s * 0.8), seed + 70 + k, 'sm_interior')
    for k in range(3):     # OSB sheets blown off
        x = r.uniform(-14, 0); z = r.uniform(Z1 + 1.5, Z1 + 4.0)
        tquad(mb, (0, 0, 0), (1, 0, 0), (0, 0, -1), 1.25, 2.5, MS2('osb_plain'), (1.25, 2.5), M=mat_trs((x, ya + 0.04, z), (0, r.uniform(0, 3), 0)), double=True)
