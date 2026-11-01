"""Builds assets/env/fortifications.glb: dressing for the field fortifications that src/world/terrain.js cuts INTO the
ground (trench walls / floors / spoil are the game's terrain mesh -- raw earth; these pieces only dress them).
Modelled on the 2023-25 photo / drone-footage record of Ukrainian and Russian positions: mostly unrevetted hand-dug
earth, revetment improvised and patchy -- pallets, scavenged doors, corrugated and plywood / OSB sheets, brushwood,
a few logs, wire-mesh panels on engineered stretches -- sandbags at some firing places only, pallets and planks
thrown into the mud, litter (zinc ammo tins, cans, ration pouches, cardboard, plastic), overhead cover of garnished
camouflage net, cut branches, tarpaulins and (2024-25) anti-drone fishing nets on poles, low overgrown log-and-earth
dugouts (blindazh) and crude covered MG positions, concrete "dragon's teeth".
Materials: farmland_atlas + farmland_foliage (same atlases / cache as farmland.glb, so they match the village set)
and fort_extra (tools/blender/env/fort_atlas.py: nets, tarps, plastic, boards, cardboard, labels; alpha, 2-sided).
Conventions (metres, +Y up):
  rv_pallet / rv_door / rv_sheet / rv_ply / rv_branches / rv_logs / rv_mesh
                   improvised revetment, natural size: origin at the bottom centre ON THE TRENCH FLOOR, width along X,
                   face looking +Z (into the trench), thickness behind (-Z).  The game leans it back against the
                   battered wall and may squash Y to fit the trench depth.  Widths 0.8 / 0.84 / 0.95 / 1.22 / 1.3 /
                   1.6 / 1.5 m, heights 1.2 / 2.0 / 1.8 / 1.25 / 1.3 / 1.0 / 1.5 m.
  floor_pallet / floor_planks   lying in the mud, origin on the floor, long axis X.
  litter_a / litter_b           small litter heaps (ammo tins, cans, bottle / cardboard, pouches, plastic), on floor.
  sandbag_row (1.3 m along X, two untidy courses) / sandbag_pile (heap)   origin bottom centre, front +Z.
  debris_conc      broken concrete and bricks thrown on the spoil (urban positions), origin on the ground.
  net_cover / branch_cover / tarp_cover / net_drone
                   overhead cover laid across a trench: long axis X ALONG the trench (3.2 / 2.4 / 2.0 / 4.0 m), Z across
                   (2.6 / 2.4 / 2.2 / 2.0 m, the game scales Z to the trench width + lips); origin centre at lip level.
  dugout_roof(_b)  low earth-covered log roof 4.7 x 4.9 m (x +-2.35, z +-2.45), grassed over (b: netted + branches);
                   the timbered doorway drops to y=-1.7 at z=+2.45 (the passage arrives from +Z).
  mg_nest_roof     crude log roof on 4 posts over a firing cell, embrasure to +Z; origin at ground level, cell centre.
  dragon_tooth(_b) concrete pyramid, base 1.2 m, 1.0 m tall (b: chipped, toppled-looking); origin base centre.
  dragon_tooth_rubble  a tooth blown apart: broken stump, face slabs + lumps scattered ~2 m, bent rebar; origin base
                   centre.  City.damageFortAt() swaps teeth to _b (damaged / toppled) and _rubble (destroyed).
  ammo_crates      a few wooden ammunition boxes, origin on the floor.
  tree_*_mid       mid-distance LODs of the farmland.glb trees (build_forest_lods.py), same origins / crowns.
Run:  cd tools/blender/env && nice -n 10 python3 build_fortifications.py      (then ./optimize_fortifications.sh)
"""
import os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import bpy
from meshlib import reset_scene, make_material, update_manifest, REPO, mat_trs, rng, MB, Region
import farmland_geo as FG
from farmland_geo import TMB, FR, LEAF, cyl, tquad, tbox, earth_surface, tint, RS, T, chunk
import farmland_atlas as FA
import fort_atlas as XA
import build_farmland as BF
from meshfix import fix_mb

PI = math.pi
G = FG.G
EXTRA = 2
XR = {k: Region(*v, S=XA.S, pad=2) for k, v in XA.REG.items()}


def stake(mb, x, z, y0, y1, r, rad=0.035):
    cyl(mb, (x, y0, z), (x + r.normal(0, 0.012), y1, z + r.normal(0, 0.012)), rad, 5, 'bark_acacia', seg=1.2, cap=True)


def xquad(mb, P, reg, uvs):
    mb.face(mb.vs([tuple(p) for p in P]), [reg.uv(*t) for t in uvs], True, EXTRA)


def xbox(mb, mn, mx, reg, M=None):
    """Box with every face mapped to the whole extra-atlas region (small props)."""
    x0, y0, z0 = mn; x1, y1, z1 = mx
    F = [[(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], [(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)],
         [(x1, y0, z1), (x1, y0, z0), (x1, y1, z0), (x1, y1, z1)], [(x0, y0, z0), (x0, y0, z1), (x0, y1, z1), (x0, y1, z0)],
         [(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)]]
    for P in F:
        P = [tuple((M @ np.array([*p, 1.0]))[:3]) if M is not None else p for p in P]
        mb.face(mb.vs(P), [XR[reg].uv(0, 0), XR[reg].uv(1, 0), XR[reg].uv(1, 1), XR[reg].uv(0, 1)], False, EXTRA)


def sheet(mb, f, x0, x1, y0, y1, nu, nv, reg, mat=EXTRA, tile=None, M=None, smooth=True, cut=None):
    """Bent rectangular sheet: point f(u, v) for u in [x0, x1], v in [y0, y1] (grid nu x nv), UV over the region
    (or tiled every `tile` (tu, tv) metres with per-quad offsets).  cut(u, v) -> True drops that quad."""
    U = np.linspace(x0, x1, nu + 1); V = np.linspace(y0, y1, nv + 1)
    rg = XR[reg] if isinstance(reg, str) and reg in XR else (G.R[reg] if isinstance(reg, str) else reg)
    for i in range(nu):
        for j in range(nv):
            uc, vc = (U[i] + U[i + 1]) / 2, (V[j] + V[j + 1]) / 2
            if cut and cut(uc, vc):
                continue
            P = [f(U[i], V[j]), f(U[i + 1], V[j]), f(U[i + 1], V[j + 1]), f(U[i], V[j + 1])]
            if M is not None:
                P = [tuple((M @ np.array([*p, 1.0]))[:3]) for p in P]
            if tile:
                ou, ov = math.floor(uc / tile[0]) * tile[0], math.floor(vc / tile[1]) * tile[1]
                st = [((U[a] - ou) / tile[0], (V[b] - ov) / tile[1]) for a, b in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))]
            else:
                st = [((U[a] - x0) / (x1 - x0), (V[b] - y0) / (y1 - y0)) for a, b in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))]
            mb.face(mb.vs([tuple(p) for p in P]), [rg.uv(s, t) for s, t in st], smooth, mat)


def branch(mb, p0, d, L, r0, r, kids=3, leaves=None, depth=0):
    """Tapered bent branch from p0 along d (length L, base radius r0) with side twigs and optional leaf cards."""
    d = np.asarray(d, float); d /= np.linalg.norm(d); p0 = np.asarray(p0, float)
    side = np.cross(d, [0, 1, 0]); side = side / (np.linalg.norm(side) + 1e-9)
    n = 5; pts = []; rads = []
    bend = r.normal(0, 0.12, 3)
    for k in range(n + 1):
        t = k / n; pts.append(p0 + d * L * t + bend * L * t * t * 0.5); rads.append(max(0.004, r0 * (1 - 0.8 * t)))
    G.tube(mb, pts, np.array(rads), 5 if depth == 0 else 4, 'bark_acacia', seg=0.6, cap=True)
    if depth < 1:
        for k in range(kids):
            t = r.uniform(0.3, 0.9); q = pts[0] + (pts[-1] - pts[0]) * t
            nd = d + side * r.choice([-1, 1]) * r.uniform(0.6, 1.2) + np.array([0, r.uniform(-0.1, 0.4), 0])
            branch(mb, q, nd, L * r.uniform(0.3, 0.5), r0 * 0.45, r, 0, leaves, depth + 1)
    if leaves:
        for k in range(2 if depth else 3):
            t = r.uniform(0.45, 1.0); c = pts[0] + (pts[-1] - pts[0]) * t
            nrm = np.array([r.normal(0, 0.5), 1.0, r.normal(0, 0.5)])
            FG.FT.card(mb, c, nrm, d, r.uniform(0.35, 0.6), r.uniform(0.3, 0.5), FR(leaves), base=0.5)


# ====================================================================== improvised revetment (stand on the floor)
def rv_pallet(name='rv_pallet', seed=400):
    """Euro pallet stood on its short side against the wall: deck boards vertical, stringer boards and blocks behind."""
    mb = TMB(name); r = rng(seed)
    W, H = 0.8, 1.2
    xs = np.linspace(-W / 2 + 0.072, W / 2 - 0.072, 5)
    for x in xs:   # deck boards (vertical), one broken short
        h1 = H if r.random() > 0.2 else H * r.uniform(0.6, 0.85)
        reg = 'wood_raw' if r.random() < 0.6 else 'wood_grey'
        hw = 0.072 if abs(x) > 0.3 else 0.05
        tbox(mb, (x - hw - r.uniform(0, 0.01), 0.0, -0.022), (x + hw, h1, 0.0), reg, (0.3, 1.2), faces='+z+x-x+y')
    for y in (0.0, H / 2 - 0.05, H - 0.1):   # stringer boards + blocks behind
        tbox(mb, (-W / 2, y, -0.044), (W / 2, y + 0.1, -0.022), 'wood_grey', (0.8, 0.2), faces='+y-y+x-x')
        for x in (-W / 2 + 0.05, 0.0, W / 2 - 0.05):
            tbox(mb, (x - 0.05, y, -0.12), (x + 0.05, y + 0.1, -0.044), 'wood_raw', (0.2, 0.2), faces='+y-y+x-x')
    tint(mb, lambda p: 0.42 + 0.5 * min(1.0, p[1] / 0.6))   # muddy foot
    return mb


def rv_door(name='rv_door', seed=410):
    """An old interior door (painted, peeling) from a village house, propped against the wall."""
    mb = TMB(name); r = rng(seed)
    W, H, D = 0.84, 2.0, 0.04
    tbox(mb, (-W / 2, 0, -D), (W / 2, H, 0), 'door_blue', (W, H), faces='+z', regs={'+z': RS('door_blue', 0.08, 0.0, 0.92, 1.0)})
    tbox(mb, (-W / 2, 0, -D), (W / 2, H, 0), 'wood_grey', (0.3, 1.0), faces='+x-x+y')
    tbox(mb, (W / 2 - 0.13, 0.95, 0.0), (W / 2 - 0.05, 0.98, 0.04), 'metal_dark', (0.1, 0.1))   # handle
    tint(mb, lambda p: (0.45 + 0.4 * min(1.0, p[1] / 0.7)) * np.array([1.0, 0.9, 0.78]))   # faded, dirty paint
    return mb


def rv_sheet(name='rv_sheet', seed=420):
    """Corrugated steel roofing sheet torn off a barn, rusted, bent and dented."""
    mb = TMB(name); r = rng(seed)
    W, H = 0.95, 1.8
    ph = r.uniform(0, 6)
    def f(u, v):
        z = 0.018 * math.sin(u * 2 * PI / 0.076) + 0.06 * math.sin(v * 1.6 + ph) * (u / W + 0.5) - 0.02 * (u / W) ** 2
        if v > H - 0.35 and u > W * 0.15:   # dented, bent-over corner
            z += (v - (H - 0.35)) * 0.25 * (u / W)
        return (u, v, z - 0.03)
    sheet(mb, f, -W / 2, W / 2, 0.0, H, 26, 4, 'corr_rust', mat=0, tile=(0.95, 0.9))
    tint(mb, lambda p: 0.55 + 0.45 * min(1.0, p[1] / 0.7))
    return mb


def rv_ply(name='rv_ply', seed=430):
    """OSB / plywood sheet, weathered grey, swollen and delaminating at the muddy foot, one corner broken off."""
    mb = TMB(name); r = rng(seed)
    W, H = 1.22, 1.25
    def f(u, v):
        return (u, v, -0.02 + 0.025 * math.sin(u * 2.2) * math.sin(v * 1.9))
    sheet(mb, f, -W / 2, W / 2, 0.0, H, 6, 5, 'osb', cut=lambda u, v: u > W * 0.25 and v > H - 0.3 and (u - W * 0.25) + (v - H + 0.3) > 0.25)
    tint(mb, lambda p: 0.6 + 0.4 * min(1.0, p[1] / 0.5))
    return mb


def rv_branches(name='rv_branches', seed=440):
    """Brushwood revetment: stakes driven into the floor, cut branches woven between them, a woven wattle panel
    behind as filler, a few wilted leaves still on."""
    mb = TMB(name); r = rng(seed)
    W, H = 1.3, 1.3
    reg = FR('wattle')
    for flip in (False, True):   # alpha weave filler (both sides), slightly ragged top
        P = [(-W / 2, 0.0, -0.02), (W / 2, 0.0, -0.02), (W / 2, H * 0.92, -0.02), (-W / 2, H * 0.85, -0.02)]
        uv = [reg.uv(0, 0), reg.uv(0.45, 0), reg.uv(0.45, 0.92), reg.uv(0, 0.85)]
        if flip:
            P = P[::-1]; uv = uv[::-1]
        mb.face(mb.vs(P), uv, False, LEAF)
    for x in (-0.58, -0.05, 0.55):
        stake(mb, x + r.normal(0, 0.03), 0.02, 0.0, H + r.uniform(0.0, 0.15), r, 0.03)
    y = 0.08
    while y < H - 0.1:
        a = (-W / 2 - 0.1, y + r.normal(0, 0.03), 0.015); b = (W / 2 + 0.12, y + r.normal(0, 0.05), 0.01)
        G.tube(mb, [a, ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.02, 0.035), b], np.array([0.018, 0.014, 0.009]), 4, 'bark_acacia', seg=0.6, cap=True)
        y += r.uniform(0.1, 0.2)
    for k in range(3):
        FG.FT.card(mb, np.array([r.uniform(-0.5, 0.5), r.uniform(0.8, 1.25), 0.05]), (0, 0.4, 1), (0, 1, 0), 0.45, 0.4, FR('acacia_dry'), base=0.4)
    tint(mb, lambda p: 0.5 + 0.45 * min(1.0, p[1] / 0.8))
    return mb


def rv_logs(name='rv_logs', seed=450):
    """A few thin logs / poles stacked against the lower wall, held by two stakes (the top half is raw earth)."""
    mb = TMB(name); r = rng(seed)
    y = 0.0
    for k in range(r.integers(4, 6)):
        rad = r.uniform(0.06, 0.1); yc = y + rad; L0, L1 = -0.8 - r.uniform(0, 0.12), 0.8 + r.uniform(0, 0.12)
        cyl(mb, (L0, yc, -0.06), (L1, yc + r.normal(0, 0.02), -0.06 + r.normal(0, 0.015)), rad, 7, 'bark_acacia', seg=1.1, cap=True)
        y = yc + rad * 0.92
    for x in (-0.62, 0.6):
        stake(mb, x, 0.05, 0.0, y + r.uniform(0.05, 0.25), r, 0.045)
    tint(mb, lambda p: 0.55 + 0.45 * min(1.0, p[1] / 0.7))
    return mb


def rv_mesh(name='rv_mesh', seed=460):
    """Engineered panel: welded wire mesh on two posts with non-woven geotextile behind (spoil pushing through)."""
    mb = TMB(name); r = rng(seed)
    W, H = 1.5, 1.5
    sheet(mb, lambda u, v: (u, v, -0.035 - 0.03 * math.sin(v * 2.1) * math.cos(u * 2.0)), -W / 2, W / 2, 0.0, H, 3, 3, 'geotex')
    sheet(mb, lambda u, v: (u, v, 0.0), -W / 2, W / 2, 0.0, H, 1, 1, 'wire_mesh', tile=(0.8, 0.8))
    for x in (-W / 2 + 0.04, W / 2 - 0.04):
        cyl(mb, (x, 0.0, 0.05), (x + r.normal(0, 0.01), H + 0.1, 0.05), 0.055, 6, 'bark_acacia', seg=1.0, cap=True)
    tint(mb, lambda p: 0.55 + 0.45 * min(1.0, p[1] / 0.6))
    return mb


# ====================================================================== floor, firing places, litter
def pallet_flat(mb, M, r):
    for z in np.linspace(-0.35, 0.35, 5):
        if r.random() < 0.12:
            continue
        tbox(mb, (-0.6, 0.1, z - 0.05), (0.6, 0.122, z + 0.05), 'wood_raw' if r.random() < 0.5 else 'wood_grey', (1.2, 0.3), M=M, faces='+y+z-z+x-x')
    for x in (-0.55, 0.0, 0.55):
        tbox(mb, (x - 0.05, 0.0, -0.4), (x + 0.05, 0.1, 0.4), 'wood_grey', (0.8, 0.2), M=M, faces='+y+x-x+z-z')


def floor_pallet(name='floor_pallet', seed=470):
    mb = TMB(name); r = rng(seed)
    pallet_flat(mb, mat_trs((0, -0.03, 0), (0.03, 0, -0.04)), r)
    tint(mb, lambda p: 0.38)
    return mb


def floor_planks(name='floor_planks', seed=480):
    mb = TMB(name); r = rng(seed)
    for k in range(3):
        L = r.uniform(1.5, 2.0); M = mat_trs((r.normal(0, 0.1), 0.0, -0.18 + k * 0.17), (0, r.normal(0, 0.12), r.normal(0, 0.02)))
        tbox(mb, (-L / 2, 0.0, -0.07), (L / 2, 0.03, 0.07), 'wood_grey' if k != 1 else 'wood_raw', (1.2, 0.3), M=M, faces='+y+z-z+x-x')
    tint(mb, lambda p: 0.4)
    return mb


def bag(mb, M, r, l=0.62, h=0.15, d=0.38, half=0, flat=1.0):
    """One filled sandbag: a squashed rounded box, region 'sandbag' (half 0/1 = two looks)."""
    reg = RS('sandbag', 0, 0, 0.5, 0.17) if half == 0 else RS('sandbag', 0.5, 0.17, 1, 0.34)
    tmp = TMB('bag')
    tbox(tmp, (-l / 2, 0, -d / 2), (l / 2, h * flat, d / 2), reg, (l, h))
    V = np.array(tmp.V)
    k = 1 - (np.abs(V[:, 0]) / (l / 2)) ** 4
    V[:, 1] = np.where(V[:, 1] > h * 0.5 * flat, h * 0.5 * flat + (V[:, 1] - h * 0.5 * flat) * (0.6 + 0.4 * k), V[:, 1])
    V[:, 2] *= 0.85 + 0.15 * k
    V += r.normal(0, 0.008, V.shape)
    tmp.V = list(V)
    mb.merge(tmp, M)


def sandbag_row(name='sandbag_row', seed=490):
    """An untidy short row of sandbags on a firing place: three below, two above, one slumped."""
    mb = TMB(name); r = rng(seed)
    for i in range(3):
        bag(mb, mat_trs((-0.42 + i * 0.42 + r.normal(0, 0.04), 0.0, r.normal(0, 0.05)), (0, r.normal(0, 0.18), r.normal(0, 0.04))), r, half=i % 2, flat=r.uniform(0.75, 1.0))
    for i in range(2):
        bag(mb, mat_trs((-0.2 + i * 0.44 + r.normal(0, 0.05), 0.13, -0.05 + r.normal(0, 0.05)), (0, r.normal(0, 0.25), r.normal(0, 0.08))), r, half=(i + 1) % 2, flat=r.uniform(0.7, 1.0))
    tint(mb, lambda p: (0.72 + 0.25 * min(1.0, p[1] / 0.3)) * np.array([1.0, 0.97, 0.9]))
    return mb


def sandbag_pile(name='sandbag_pile', seed=495):
    mb = TMB(name); r = rng(seed)
    for i in range(7):
        a = r.uniform(0, 2 * PI); d = r.uniform(0, 0.35); y = 0.0 if i < 4 else 0.12
        bag(mb, mat_trs((math.cos(a) * d, y, math.sin(a) * d * 0.7), (r.normal(0, 0.1), r.uniform(0, PI), r.normal(0, 0.1))), r, half=i % 2, flat=r.uniform(0.6, 1.0))
    tint(mb, lambda p: (0.7 + 0.25 * min(1.0, p[1] / 0.3)) * np.array([1.0, 0.96, 0.88]))
    return mb


def litter_a(name='litter_a', seed=500):
    """Zinc ammo tins (one opened), food cans, a plastic bottle, spent ammo-box lid."""
    mb = TMB(name); r = rng(seed)
    xbox(mb, (-0.19, 0, -0.1), (0.19, 0.16, 0.1), 'ammo_zinc', M=mat_trs((0.0, 0, 0.0), (0, 0.3, 0)))
    xbox(mb, (-0.19, 0, -0.1), (0.19, 0.1, 0.1), 'ammo_zinc', M=mat_trs((0.3, 0, 0.22), (0, -0.8, 0.0)))
    for k in range(3):
        a = r.uniform(0, 2 * PI); c = (0.25 * math.cos(a) - 0.2, 0.0, 0.25 * math.sin(a))
        lying = r.random() < 0.6
        M = mat_trs((c[0], 0.04 if lying else 0.0, c[2]), (PI / 2 if lying else 0, r.uniform(0, PI), 0))
        mb.merge(_can(0.04, 0.11, 'tin_can'), M)
    mb.merge(_can(0.045, 0.26, 'tarp_blue'), mat_trs((-0.3, 0.045, -0.2), (PI / 2, 1.1, 0)))   # bottle
    tint(mb, lambda p: 0.65)
    return mb


def _can(rad, h, reg):
    tmp = TMB('can'); n = 8
    for k in range(n):
        a0, a1 = 2 * PI * k / n, 2 * PI * (k + 1) / n
        P = [(rad * math.cos(a0), 0, rad * math.sin(a0)), (rad * math.cos(a1), 0, rad * math.sin(a1)), (rad * math.cos(a1), h, rad * math.sin(a1)), (rad * math.cos(a0), h, rad * math.sin(a0))]
        tmp.face(tmp.vs(P[::-1]), [XR[reg].uv(k / n, 0), XR[reg].uv((k + 1) / n, 0), XR[reg].uv((k + 1) / n, 1), XR[reg].uv(k / n, 1)][::-1], True, EXTRA)
    top = [(rad * math.cos(2 * PI * k / n), h, rad * math.sin(2 * PI * k / n)) for k in range(n)]
    tmp.face(tmp.vs(top[::-1]), [XR[reg].uv(0.5, 0.95)] * n, False, EXTRA)
    return tmp


def litter_b(name='litter_b', seed=510):
    """Flattened cardboard, ration pouches, a black plastic bag, a crumpled poncho corner."""
    mb = TMB(name); r = rng(seed)
    sheet(mb, lambda u, v: (u, 0.012 + 0.01 * math.sin(u * 7) * math.sin(v * 5), v), -0.28, 0.28, -0.22, 0.22, 3, 2, 'cardboard', M=mat_trs((0.05, 0, 0.0), (0, 0.4, 0)))
    for k in range(3):
        xbox(mb, (-0.11, 0, -0.07), (0.11, 0.025, 0.07), 'mre', M=mat_trs((r.uniform(-0.35, 0.35), 0.01 + k * 0.004, r.uniform(-0.3, 0.3)), (r.normal(0, 0.1), r.uniform(0, PI), 0)))
    ph = r.uniform(0, 6, 3)
    sheet(mb, lambda u, v: (u, 0.02 + 0.09 * max(0.0, 1 - (u * u + v * v) / 0.05) * (1 + 0.3 * math.sin(u * 20 + ph[0]) * math.sin(v * 17 + ph[1])), v), -0.25, 0.25, -0.22, 0.22, 6, 6, 'plastic_black', M=mat_trs((-0.32, 0, 0.28), (0, 0.7, 0)))
    tint(mb, lambda p: 0.7)
    return mb


def debris_conc(name='debris_conc', seed=520):
    mb = TMB(name); r = rng(seed)
    for k in range(5):
        chunk(mb, (r.uniform(-0.6, 0.6), 0.08, r.uniform(-0.4, 0.4)), (r.uniform(0.2, 0.5), r.uniform(0.12, 0.25), r.uniform(0.15, 0.4)), 1300 + k, 'concrete')
    for k in range(6):
        M = mat_trs((r.uniform(-0.7, 0.7), 0.0, r.uniform(-0.5, 0.5)), (r.normal(0, 0.3), r.uniform(0, PI), r.normal(0, 0.3)))
        tbox(mb, (-0.125, 0, -0.06), (0.125, 0.065, 0.06), 'brick_red' if r.random() < 0.6 else 'brick_white', (0.25, 0.065), M=M)
    tint(mb, lambda p: 0.75 + 0.25 * min(1.0, p[1] / 0.3))
    return mb


# ====================================================================== overhead cover
def net_cover(name='net_cover', seed=530):
    """Garnished camouflage net over a trench section: thrown over three cross sticks, sagging between them,
    edges dragged onto the spoil and weighted with clods."""
    mb = TMB(name); r = rng(seed)
    LX, LZ = 3.2, 2.6
    sticks = [-1.15, 0.05, 1.2]
    ph = r.uniform(0, 6, 4)
    def f(u, v):
        s = min(abs(u - x) for x in sticks)
        top = 0.16 - 0.1 * min(1.0, s / 0.6) ** 1.3
        edge = max(0.0, (abs(v) - 0.75) / (LZ / 2 - 0.75))
        y = top * (1 - edge) ** 1.5 - 0.04 * edge + 0.03 * math.sin(u * 3.1 + ph[0]) * math.sin(v * 2.3 + ph[1])
        return (u + 0.04 * math.sin(v * 2 + ph[2]), y, v)
    rag = lambda u, v: (abs(u) > LX / 2 - 0.35 and math.sin(v * 7 + u * 3 + ph[3]) > 0.3) or (abs(v) > LZ / 2 - 0.2 and math.sin(u * 9 + ph[3]) > 0.5)
    sheet(mb, f, -LX / 2, LX / 2, -LZ / 2, LZ / 2, 16, 13, 'camo_net', tile=(1.6, 1.3), cut=rag)
    for x in sticks:
        cyl(mb, (x + r.normal(0, 0.05), 0.0, -1.15), (x + r.normal(0, 0.05), 0.12, 1.15), 0.025, 5, 'bark_acacia', seg=1.0, cap=True)
    return mb


def branch_cover(name='branch_cover', seed=540):
    """Fresh-cut branches laid across a trench section (wilting leaves, bark), the cheapest overhead concealment."""
    mb = TMB(name); r = rng(seed)
    for k in range(10):
        x = -1.05 + k * 0.23 + r.normal(0, 0.07); z0 = r.choice([-1, 1]) * 1.2
        branch(mb, (x, 0.05, z0), (r.normal(0, 0.25), 0.02, -np.sign(z0)), r.uniform(1.9, 2.5), r.uniform(0.025, 0.04), r, kids=3, leaves='acacia_dry' if r.random() < 0.6 else 'acacia')
    return mb


def tarp_cover(name='tarp_cover', seed=550):
    """Olive tarpaulin / poncho stretched across a trench section, sagging in the middle, edges held down."""
    mb = TMB(name); r = rng(seed)
    LX, LZ = 2.0, 2.2
    ph = r.uniform(0, 6, 3)
    def f(u, v):
        e = abs(v) / (LZ / 2)
        y = -0.22 * max(0.0, 1 - (v / 0.75) ** 2) ** 1.2 * (0.8 + 0.2 * math.cos(u * 2.4)) + 0.04 * max(0.0, e - 0.6) * 0 + 0.02 * math.sin(u * 5 + ph[0]) * math.sin(v * 4 + ph[1])
        return (u, y + 0.03, v)
    sheet(mb, f, -LX / 2, LX / 2, -LZ / 2, LZ / 2, 8, 10, 'tarp_olive', tile=(1.0, 1.1))
    for k in range(4):   # clods / a sandbag weighting the edges
        z = (LZ / 2 - 0.15) * (1 if k % 2 else -1); x = -0.7 + (k // 2) * 1.3
        chunk(mb, (x, 0.04, z), (0.2, 0.12, 0.18), 1400 + k, 'soil')
    return mb


def net_drone(name='net_drone', seed=560):
    """Anti-drone net tunnel (2024-25): fishing net strung over poles along a communication trench."""
    mb = TMB(name); r = rng(seed)
    LX, LZ, H = 4.0, 2.0, 1.9
    for x in (-1.9, 0.0, 1.9):
        for z in (-LZ / 2, LZ / 2):
            cyl(mb, (x, -0.2, z), (x + r.normal(0, 0.04), H + r.normal(0, 0.05), z * 0.92), 0.035, 5, 'bark_acacia', seg=1.0, cap=True)
    def f(u, v):
        s = min(abs(u - x) for x in (-1.9, 0.0, 1.9))
        arch = H * (1 - (v / (LZ / 2 + 0.1)) ** 2) ** 0.35 if abs(v) < LZ / 2 else 0.0
        return (u, max(0.05, arch - 0.18 * min(1.0, s / 0.95)), v * 1.02)
    sheet(mb, f, -LX / 2, LX / 2, -LZ / 2, LZ / 2, 10, 8, 'drone_net', tile=(1.0, 1.0))
    for side in (-1, 1):   # sides hanging down
        sheet(mb, lambda u, v, side=side: (u, v, side * LZ / 2 * 1.02), -LX / 2, LX / 2, 0.0, 1.35, 10, 2, 'drone_net', tile=(1.0, 1.0))
    return mb


# ====================================================================== dugouts, MG positions
def dugout_roof(name='dugout_roof', seed=570, netted=False):
    """Low log-and-earth roof over a dugout pit (blindazh): 0.45 m of earth in a lumpy mound grown over with weeds
    and grass, roof-log ends showing at the sides, a timbered doorway with a blanket / tarp hung over it at +Z,
    a stovepipe at the back; netted = garnished camo net and cut branches thrown over it."""
    mb = TMB(name); r = rng(seed)
    HX, HZ, H = 2.35, 2.45, 0.45
    ph = r.uniform(0, 6, 4)

    def f(x, z):
        e = (abs(x) / HX) ** 4 + (abs(z) / HZ) ** 4
        if e >= 1:
            return -0.02
        v = H * (1 - e) ** 0.6 * (1 + 0.12 * math.sin(x * 2.1 + ph[0]) * math.sin(z * 1.7 + ph[1]) + 0.06 * math.sin(x * 5.3 + ph[2]))
        if z > HZ - 0.45 and abs(x) < 0.85:   # doorway notch
            v = min(v, max(0.0, (HZ - z) / 0.45) * 0.25)
        return max(-0.02, v)
    earth_surface(mb, f, -HX - 0.05, HX + 0.05, -HZ - 0.05, HZ, 22, 22, 'sod', 2.0)
    for sgn in (-1, 1):   # roof-log ends
        z = -HZ + 0.5
        while z < HZ - 0.75:
            rad = r.uniform(0.07, 0.1)
            if r.random() < 0.7:
                x0 = sgn * (HX - 0.6); x1 = sgn * (HX - 0.1 + r.uniform(0, 0.2)); yb = max(0.0, f(x1 * 0.98, z)) - 0.03
                cyl(mb, (x0, yb + rad * 0.3, z), (x1, yb + rad * 0.5, z + r.normal(0, 0.03)), rad, 6, 'bark_acacia', seg=1.0, cap=True)
            z += rad * 2 + r.uniform(0.02, 0.14)
    zf = HZ   # doorway facade: logs, dark opening, blanket hanging half over it
    tquad(mb, (-0.38, -1.7, zf - 0.04), (1, 0, 0), (0, 1, 0), 0.76, 1.45, 'interior_dark', (1, 1))
    for x in (-0.46, 0.46):
        cyl(mb, (x, -1.72, zf), (x + r.normal(0, 0.02), 0.08, zf), 0.08, 6, 'bark_acacia', seg=1.0, cap=True)
    cyl(mb, (-0.85, -0.22, zf + 0.02), (0.85, -0.2, zf + 0.02), 0.095, 7, 'bark_acacia', seg=1.0, cap=True)
    for sgn in (-1, 1):
        y = -1.7
        while y < -0.3:
            if r.random() < 0.8:
                cyl(mb, (sgn * 0.48, y + 0.09, zf - 0.03), (sgn * (0.9 + r.uniform(0, 0.1)), y + 0.09, zf - 0.03), 0.085, 6, 'bark_acacia', seg=1.0, cap=True)
            y += 0.18
    sheet(mb, lambda u, v: (u, v, zf + 0.06 + 0.04 * math.sin(u * 9) * (1 - (v + 1.65) / 1.45)), -0.42, 0.18, -1.65, -0.24, 4, 4, 'tarp_olive' if not netted else 'plastic_black', tile=(0.6, 0.7))
    cyl(mb, (1.0, 0.25, -1.1), (1.0, 0.95, -1.1), 0.055, 8, 'metal_dark', seg=1.0, cap=False)   # stovepipe
    cyl(mb, (1.0, 0.95, -1.1), (1.13, 1.02, -1.1), 0.055, 8, 'metal_dark', seg=1.0, cap=True)
    # weeds and grass grown over the roof
    for k in range(26 if not netted else 10):
        x = r.uniform(-HX + 0.3, HX - 0.3); z = r.uniform(-HZ + 0.3, HZ - 0.6); y = f(x, z)
        if y < 0.05:
            continue
        reg = FR('grass_tuft') if r.random() < 0.6 else FR('weeds')
        a = r.uniform(0, PI)
        for b in (0, PI / 2):
            FG.FT.card(mb, np.array([x, y - 0.02, z]), (math.cos(a + b), 0, math.sin(a + b)), (0, 1, 0), r.uniform(0.4, 0.7), r.uniform(0.3, 0.5), reg, base=0.0)
    if netted:
        def g(u, v):
            return (u, f(u * 0.97, v * 0.97) + 0.1 + 0.03 * math.sin(u * 4 + ph[3]), v)
        sheet(mb, g, -HX + 0.1, HX - 0.1, -HZ + 0.05, HZ - 0.55, 12, 12, 'camo_net', tile=(1.6, 1.3), cut=lambda u, v: abs(u) > HX - 0.5 and math.sin(v * 6 + u) > 0.4)
        for k in range(4):
            x = r.uniform(-1.4, 1.4)
            branch(mb, (x, f(x, -1.4) + 0.12, -1.6), (r.normal(0, 0.3), 0.0, 1.0), r.uniform(1.6, 2.3), 0.03, r, kids=2, leaves='acacia_dry')
    tint(mb, lambda p: 0.5 + 0.5 * min(1.0, max(0.0, (p[1] + 1.7) / 1.8)))
    return mb


def mg_nest_roof(name='mg_nest_roof', seed=580):
    """Crude covered MG position: four posts at the cell corners, a layer of logs, earth and sod on top grown over,
    cut branches for concealment, untidy sandbag cheeks either side of the embrasure (+Z)."""
    mb = TMB(name); r = rng(seed)
    for x in (-0.72, 0.72):
        for z in (-0.75, 0.62):
            cyl(mb, (x, -1.1, z), (x + r.normal(0, 0.02), 0.4, z + r.normal(0, 0.02)), 0.065, 6, 'bark_acacia', seg=1.0, cap=True)
    z = -1.15
    while z < 0.95:
        rad = r.uniform(0.065, 0.09)
        cyl(mb, (-1.15 - r.uniform(0, 0.15), 0.45, z), (1.15 + r.uniform(0, 0.15), 0.45 + r.normal(0, 0.015), z + r.normal(0, 0.02)), rad, 6, 'bark_acacia', seg=1.0, cap=True)
        z += rad * 2.05
    ph = r.uniform(0, 6, 2)
    def f(x, zz):
        e = (abs(x) / 1.3) ** 4 + (abs(zz + 0.1) / 1.2) ** 4
        return 0.5 + (0.3 * max(0.0, 1 - e) ** 0.7) * (1 + 0.15 * math.sin(x * 4 + ph[0]) * math.sin(zz * 3 + ph[1])) if e < 1 else 0.5
    earth_surface(mb, f, -1.2, 1.2, -1.25, 0.95, 10, 10, 'sod', 2.0)
    for sgn in (-1, 1):
        for c in range(3):
            bag(mb, mat_trs((sgn * (0.95 + r.normal(0, 0.04)), c * 0.13, 1.02 + r.normal(0, 0.04)), (0, PI / 2 + r.normal(0, 0.15), r.normal(0, 0.05))), r, half=c % 2, flat=r.uniform(0.75, 1.0))
    for k in range(3):
        branch(mb, (r.uniform(-1.0, 1.0), 0.72, -1.3), (r.normal(0, 0.3), -0.05, 1.0), r.uniform(1.6, 2.2), 0.025, r, kids=2, leaves='acacia_dry' if k else 'acacia')
    for k in range(8):
        x = r.uniform(-0.9, 0.9); zz = r.uniform(-0.9, 0.6); y = f(x, zz)
        a = r.uniform(0, PI)
        for b in (0, PI / 2):
            FG.FT.card(mb, np.array([x, y - 0.02, zz]), (math.cos(a + b), 0, math.sin(a + b)), (0, 1, 0), 0.5, 0.35, FR('grass_tuft'), base=0.0)
    tint(mb, lambda p: 0.55 + 0.45 * min(1.0, max(0.0, (p[1] + 1.1) / 1.6)))
    return mb


def dragon_tooth(name='dragon_tooth', seed=370, chipped=False):
    """Concrete pyramid ("pirамідка") 1.2 m base, 1.0 m tall, cast-in lifting loop on top; b = chipped corner."""
    mb = TMB(name); r = rng(seed)
    b, t, h = 0.6, 0.13, 1.0
    P0 = [(-b, 0, -b), (b, 0, -b), (b, 0, b), (-b, 0, b)]
    P1 = [(-t, h, -t), (t, h, -t), (t, h, t), (-t, h, t)]
    if chipped:
        P1 = [(-t, h * 0.82, -t), (t * 1.6, h * 0.72, -t), (t, h * 0.82, t), (-t, h * 0.86, t)]
    reg = 'concrete'
    for i in range(4):
        a, c = P0[i], P0[(i + 1) % 4]; d, e = P1[(i + 1) % 4], P1[i]
        G.quad(mb, [a, c, d, e], reg, ((0, 0), (1, 0), (0.6, 0.9), (0.4, 0.9)))
    G.quad(mb, P1, reg, ((0.4, 0.4), (0.6, 0.4), (0.6, 0.6), (0.4, 0.6)))
    if not chipped:
        cyl(mb, (-0.06, h, 0), (-0.06, h + 0.07, 0), 0.012, 4, 'steel_rust')
        cyl(mb, (0.06, h, 0), (0.06, h + 0.07, 0), 0.012, 4, 'steel_rust')
        cyl(mb, (-0.06, h + 0.07, 0), (0.06, h + 0.07, 0), 0.012, 4, 'steel_rust')
    else:
        for k in range(4):
            chunk(mb, (r.uniform(-0.9, 0.9), 0.05, r.uniform(-0.9, 0.9)), (r.uniform(0.1, 0.25), 0.1, r.uniform(0.1, 0.2)), 900 + k, 'concrete')
    tint(mb, lambda p: np.array([1.0, 0.94, 0.84]) * (0.74 + 0.26 * min(1.0, p[1] / 0.6)))   # warm, dusty cast concrete
    return mb


def dragon_tooth_rubble(name='dragon_tooth_rubble', seed=375):
    """A tooth blown apart by a heavy shell: the stump of the pyramid (broken top, 0.3-0.45 m), slabs of its faces
    and lumps of concrete thrown around it, bent rebar of the lifting loop sticking out.  Origin base centre."""
    mb = TMB(name); r = rng(seed)
    b, t = 0.6, 0.13
    half = lambda y: b - (b - t) * y
    hs = [0.42, 0.3, 0.38, 0.27]                                       # broken top: corner heights
    P0 = [(-b, 0, -b), (b, 0, -b), (b, 0, b), (-b, 0, b)]
    sg = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    P1 = [(sx * half(h) * r.uniform(0.85, 1.0), h, sz * half(h) * r.uniform(0.85, 1.0)) for (sx, sz), h in zip(sg, hs)]
    reg = 'concrete'
    for i in range(4):
        a, c = P0[i], P0[(i + 1) % 4]; d, e = P1[(i + 1) % 4], P1[i]
        G.quad(mb, [a, c, d, e], reg, ((0, 0), (1, 0), (0.85, 0.35), (0.15, 0.35)))
    # fractured top: four facets to a low, off-centre point
    ctr = (r.uniform(-0.08, 0.08), 0.22, r.uniform(-0.08, 0.08))
    for i in range(4):
        G.quad(mb, [P1[i], P1[(i + 1) % 4], ctr], reg, ((0.4, 0.4), (0.6, 0.4), (0.5, 0.55)))
    # face slabs and lumps thrown out (half sunk in the churned ground)
    for k in range(3):
        a = r.uniform(0, 2 * PI); d = r.uniform(0.9, 1.6)
        chunk(mb, (math.cos(a) * d, 0.05, math.sin(a) * d), (r.uniform(0.45, 0.65), 0.13, r.uniform(0.35, 0.5)), 910 + k, 'concrete',
              rot=(r.uniform(-0.35, 0.35), r.uniform(0, PI), r.uniform(-0.35, 0.35)))
    for k in range(9):
        a = r.uniform(0, 2 * PI); d = r.uniform(0.55, 1.9); s = r.uniform(0.12, 0.34)
        chunk(mb, (math.cos(a) * d, s * 0.25, math.sin(a) * d), (s * 1.3, s * 0.8, s), 920 + k, 'concrete')
    # the lifting-loop rebar, bent over
    for k, (x0, z0) in enumerate(((-0.07, 0.02), (0.08, -0.03))):
        p0 = (x0, 0.18, z0); p1 = (x0 + r.uniform(-0.05, 0.05), 0.45, z0); p2 = (x0 + r.uniform(-0.3, 0.3), 0.5 + r.uniform(-0.05, 0.08), z0 + r.uniform(-0.3, 0.3))
        cyl(mb, p0, p1, 0.012, 4, 'steel_rust'); cyl(mb, p1, p2, 0.012, 4, 'steel_rust')
    tint(mb, lambda p: np.array([1.0, 0.94, 0.84]) * (0.62 + 0.3 * min(1.0, p[1] / 0.4)))   # dusty, soot-streaked
    return mb


def ammo_crates(name='ammo_crates', seed=380):
    mb = TMB(name); r = rng(seed)
    for i, (x, z, y, a) in enumerate(((0, 0, 0, 0.1), (0.05, 0.02, 0.31, -0.15), (0.72, 0.1, 0, 0.5))):
        M = mat_trs((x, y, z), (0, a, 0))
        tbox(mb, (-0.33, 0, -0.18), (0.33, 0.3, 0.18), 'wood_green', (0.66, 0.3), M=M)
        tbox(mb, (-0.36, 0.06, -0.19), (-0.32, 0.12, 0.19), 'metal_dark', (0.1, 0.1), M=M)
        tbox(mb, (0.32, 0.06, -0.19), (0.36, 0.12, 0.19), 'metal_dark', (0.1, 0.1), M=M)
    tint(mb, lambda p: 0.62)
    return mb


def items():
    import build_forest_lods as FL     # mid-distance tree LODs share the file (and its atlases) -- see build_forest_lods.py
    return FL.items() + [rv_pallet(), rv_door(), rv_sheet(), rv_ply(), rv_branches(), rv_logs(), rv_mesh(),
                         floor_pallet(), floor_planks(), sandbag_row(), sandbag_pile(), litter_a(), litter_b(), debris_conc(),
                         net_cover(), branch_cover(), tarp_cover(), net_drone(),
                         dugout_roof(), dugout_roof('dugout_roof_b', 575, netted=True), mg_nest_roof(),
                         dragon_tooth(), dragon_tooth('dragon_tooth_b', 371, chipped=True), dragon_tooth_rubble(), ammo_crates()]


def main():
    a, f = BF.atlases()
    x_paths = XA.cache_paths()
    if not all(os.path.exists(p) for p in x_paths) or os.environ.get('REBUILD_ATLAS'):
        x_paths = XA.build()
    reset_scene()
    m_atlas = make_material('farmland_atlas', *a)
    m_fol = make_material('farmland_foliage', *f, alpha_clip=0.5, double=True)
    m_x = make_material('fort_extra', *x_paths, alpha_clip=0.5, double=True)
    info = {}
    x = 0.0
    only = set(filter(None, os.environ.get('ONLY', '').split(',')))
    for mb in items():
        if only and mb.name not in only:
            continue
        mn, mx = mb.bounds(); sz = mx - mn
        loc = (x - mn[0], 0, 0); x += sz[0] + 2
        fix_mb(mb, skip_mats=(1, 2))
        ob = BF.to_blender(mb, [m_atlas, m_fol, m_x], loc)
        ob.name = mb.name + '_geo'; ob.data.name = mb.name
        e = bpy.data.objects.new(mb.name, None); bpy.context.scene.collection.objects.link(e)
        e.location = ob.location.copy(); ob.parent = e; ob.location = (0, 0, 0)
        info[mb.name] = {'tris': mb.tris(), 'bbox_min': [round(float(v), 2) for v in mn], 'bbox_max': [round(float(v), 2) for v in mx]}
        print(f'{mb.name:20s} {mb.tris():6d} tris  size {np.round(sz, 2)}')
    out = os.environ.get('OUT') or os.path.join(REPO, 'assets', 'env', 'fortifications.glb')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, export_apply=True, export_image_format='AUTO',
                              export_materials='EXPORT', export_cameras=False, export_lights=False, export_texcoords=True,
                              export_normals=True, export_vertex_color='ACTIVE', export_all_vertex_colors=False)
    print(os.path.basename(out), round(os.path.getsize(out) / 1e6, 2), 'MB')
    if not os.environ.get('NO_MANIFEST') and not only:
        update_manifest('fortifications', {'file': 'fortifications.glb', 'nodes': info, 'notes': __doc__.split('Run:')[0].strip()})


if __name__ == '__main__':
    import time; t0 = time.time(); main(); print('done', round(time.time() - t0, 1), 's')
