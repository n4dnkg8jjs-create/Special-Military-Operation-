"""Builds assets/env/fortifications.glb: dressing for the field fortifications that src/world/terrain.js cuts INTO the
ground (trench walls / floors / parapets are the game's terrain mesh; these pieces only dress them).  Modelled on the
2022-24 Ukrainian / Russian field works: board, wattle and log revetment held by driven stakes, pallet-style duckboards,
sandbag lips on the firing cells, log-roofed earth-covered dugouts (blindazh) with a timbered doorway at the end of a
dog-leg passage, covered MG positions, concrete "dragon's teeth" pyramids (pirамідки) and ammo boxes.
Materials: farmland_atlas + farmland_foliage (same atlases / cache as farmland.glb, so they match the village set).
Conventions (metres, +Y up):
  revet_boards / revet_wattle / revet_logs   wall panel 1.0 m along X (x -0.5..0.5), top edge at y=0, bottom at y=-1,
                                              face in the plane z=0 looking +Z (into the trench).  The game scales it
                                              (segment length, lip height + trench depth, 1).
  duckboard        1.2 m along X, 0.62 m wide, origin on the trench floor.
  sandbag_row      1.3 m along X, two courses, origin at the bottom centre; front (+Z) towards the enemy.
  dugout_roof      earth-covered log roof 4.7 x 4.9 m (x +-2.35, z +-2.45) sitting on flat ground over the pit; the
                   timbered doorway facade drops to y=-1.7 at z=+2.45 (the passage arrives from +Z).
  mg_nest_roof     log roof on 4 posts over a firing cell, embrasure to +Z; origin at ground level, cell centre.
  dragon_tooth(_b) concrete pyramid, base 1.2 m, 1.0 m tall (b: chipped, toppled-looking); origin base centre.
  ammo_crates      a few wooden ammunition boxes, origin on the floor.
  tree_*_mid       mid-distance LODs of the farmland.glb trees (build_forest_lods.py), same origins / crowns.
Run:  cd tools/blender/env && nice -n 10 python3 build_fortifications.py      (then ./optimize_fortifications.sh)
"""
import os, sys, math
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import bpy
from meshlib import reset_scene, make_material, update_manifest, REPO, mat_trs, rng, MB
import farmland_geo as FG
from farmland_geo import TMB, FR, LEAF, cyl, beam, tquad, tbox, earth_surface, tint, RS, T, chunk
import farmland_atlas as FA
import build_farmland as BF
from meshfix import fix_mb

PI = math.pi
G = FG.G


def stake(mb, x, z, y0, y1, r, rad=0.035):
    cyl(mb, (x, y0, z), (x + r.normal(0, 0.012), y1, z + r.normal(0, 0.012)), rad, 5, 'bark_acacia', seg=1.2, cap=True)


def revet_boards(name='revet_boards', seed=300):
    """Horizontal boards (raw / grey / one painted reused board) nailed behind two stakes."""
    mb = TMB(name); r = rng(seed)
    y = 0.0
    k = 0
    while y > -0.99:
        h = r.uniform(0.17, 0.26); y1 = max(-1.0, y - h)
        reg = 'wood_grey' if r.random() < 0.55 else ('wood_raw' if r.random() < 0.8 else 'wood_green')
        dz = r.normal(0, 0.006); x0 = -0.5 - r.uniform(0, 0.03); x1 = 0.5 + r.uniform(0, 0.03)
        tbox(mb, (x0, y1 + 0.006, -0.03 + dz), (x1, y - 0.004, 0.0 + dz), reg, (1.2, 0.5), faces='+z+y-y')
        y = y1; k += 1
    for x in (-0.42, 0.42):
        stake(mb, x, 0.04, -1.0, 0.07, r, 0.04)
    tint(mb, lambda p: 0.55 + 0.45 * min(1.0, max(0.0, (p[1] + 1.0) / 1.0)))   # damp, dark at the floor
    return mb


def revet_wattle(name='revet_wattle', seed=310):
    """Woven willow wattle (pleten) between three stakes (alpha weave, both sides)."""
    mb = TMB(name); r = rng(seed)
    reg = FR('wattle')
    for flip in (False, True):
        P = [(-0.52, -1.0, 0.012), (0.52, -1.0, 0.012), (0.52, 0.0, 0.012), (-0.52, 0.0, 0.012)]
        uv = [reg.uv(0, 0), reg.uv(0.36, 0), reg.uv(0.36, 1), reg.uv(0, 1)]
        if flip:
            P = P[::-1]; uv = uv[::-1]
        mb.face(mb.vs(P), uv, False, LEAF)
    for x in (-0.46, 0.0, 0.46):
        stake(mb, x, 0.05, -1.0, 0.09, r, 0.035)
    tint(mb, lambda p: 0.6 + 0.4 * min(1.0, max(0.0, (p[1] + 1.0) / 1.0)))
    return mb


def revet_logs(name='revet_logs', seed=320):
    """Thin stacked logs (pole timber), half bedded in the wall, held by two stakes."""
    mb = TMB(name); r = rng(seed)
    y = -1.0
    while y < -0.05:
        rad = r.uniform(0.075, 0.105)
        yc = y + rad
        cyl(mb, (-0.53, yc, -0.035), (0.53, yc + r.normal(0, 0.01), -0.035 + r.normal(0, 0.008)), rad, 7, 'bark_acacia', seg=1.1)
        y = yc + rad * 0.95
    for x in (-0.44, 0.44):
        stake(mb, x, 0.07, -1.0, 0.08, r, 0.045)
    tint(mb, lambda p: 0.6 + 0.4 * min(1.0, max(0.0, (p[1] + 1.0) / 1.0)))
    return mb


def duckboard(name='duckboard', seed=330):
    mb = TMB(name); r = rng(seed)
    for z in (-0.22, 0.22):
        tbox(mb, (-0.6, 0.0, z - 0.03), (0.6, 0.06, z + 0.03), 'wood_grey', (1.2, 0.2), faces='+y+z-z+x-x')
    x = -0.56
    while x < 0.55:
        w = r.uniform(0.09, 0.13)
        if r.random() > 0.08:
            reg = 'wood_raw' if r.random() < 0.4 else 'wood_grey'
            tbox(mb, (x, 0.06, -0.31 + r.normal(0, 0.01)), (x + w, 0.083, 0.31 + r.normal(0, 0.01)), reg, (0.3, 0.7), faces='+y+x-x+z-z')
        x += w + r.uniform(0.02, 0.05)
    tint(mb, lambda p: 0.55)
    return mb


def bag(mb, M, r, l=0.62, h=0.15, d=0.38, half=0):
    """One filled sandbag: a squashed rounded box, region 'sandbag' (half 0/1 = two looks)."""
    reg = RS('sandbag', 0, 0, 0.5, 0.17) if half == 0 else RS('sandbag', 0.5, 0.17, 1, 0.34)
    tmp = TMB('bag')
    tbox(tmp, (-l / 2, 0, -d / 2), (l / 2, h, d / 2), reg, (l, h))
    V = np.array(tmp.V)
    # bulge the long faces, pinch the ends
    k = 1 - (np.abs(V[:, 0]) / (l / 2)) ** 4
    V[:, 1] = np.where(V[:, 1] > h * 0.5, h * 0.5 + (V[:, 1] - h * 0.5) * (0.6 + 0.4 * k), V[:, 1])
    V[:, 2] *= 0.85 + 0.15 * k
    V += r.normal(0, 0.006, V.shape)
    tmp.V = list(V)
    mb.merge(tmp, M)


def sandbag_row(name='sandbag_row', seed=340):
    mb = TMB(name); r = rng(seed)
    for c in range(2):
        n = 2 if c == 0 else 2
        for i in range(n):
            x = -0.33 + i * 0.66 + (0.0 if c == 0 else r.normal(0.12, 0.05))
            bag(mb, mat_trs((x, c * 0.135, r.normal(0, 0.03) - c * 0.04), (0, r.normal(0, 0.06), 0)), r, half=(i + c) % 2)
    tint(mb, lambda p: 0.8 + 0.2 * min(1.0, p[1] / 0.3))
    return mb


def dugout_roof(name='dugout_roof', seed=350):
    """Earth-covered log roof over a dugout pit (blindazh): 0.6 m of earth and sod in a low rounded mound, log ends
    showing along the sides, a timbered doorway facade dropping to the passage floor at +Z, stovepipe at the back."""
    mb = TMB(name); r = rng(seed)
    HX, HZ, H = 2.35, 2.45, 0.62
    ph = r.uniform(0, 6, 3)

    def f(x, z):
        e = (abs(x) / HX) ** 4 + (abs(z) / HZ) ** 4
        if e >= 1:
            return -0.02
        v = H * (1 - e) ** 0.6 * (1 + 0.06 * math.sin(x * 2.1 + ph[0]) * math.sin(z * 1.7 + ph[1]))
        # doorway notch: the mound is cut back over the passage end
        if z > HZ - 0.45 and abs(x) < 0.85:
            v = min(v, max(0.0, (HZ - z) / 0.45) * 0.3)
        return max(-0.02, v)
    earth_surface(mb, f, -HX - 0.05, HX + 0.05, -HZ - 0.05, HZ, 24, 24, 'sod', 2.0)
    # log ends of the roof timbers poking out of both sides
    for sgn in (-1, 1):
        z = -HZ + 0.45
        while z < HZ - 0.7:
            rad = r.uniform(0.08, 0.11)
            x0 = sgn * (HX - 0.55); x1 = sgn * (HX - 0.05 + r.uniform(0, 0.25))
            yb = max(0.0, f(x1 * 0.98, z)) - 0.02
            cyl(mb, (x0, yb + rad * 0.3, z), (x1, yb + rad * 0.6, z + r.normal(0, 0.03)), rad, 6, 'bark_acacia', seg=1.0, cap=True)
            z += rad * 2 + r.uniform(0.02, 0.1)
    # doorway facade at z = +HZ: horizontal logs from the passage floor up to the lintel, dark door opening
    zf = HZ
    tquad(mb, (-0.38, -1.7, zf - 0.04), (1, 0, 0), (0, 1, 0), 0.76, 1.45, 'interior_dark', (1, 1))
    for x in (-0.46, 0.46):
        cyl(mb, (x, -1.72, zf), (x, 0.12, zf), 0.085, 6, 'bark_acacia', seg=1.0, cap=True)
    cyl(mb, (-0.85, -0.22, zf + 0.02), (0.85, -0.22, zf + 0.02), 0.1, 7, 'bark_acacia', seg=1.0, cap=True)   # lintel
    y = -0.12
    while y < 0.12:
        cyl(mb, (-0.9, y + 0.09, zf - 0.02), (0.9, y + 0.09, zf - 0.02), 0.09, 6, 'bark_acacia', seg=1.0, cap=True)
        y += 0.17
    for sgn in (-1, 1):   # side cheeks of the doorway (bedded logs either side of the opening)
        y = -1.7
        while y < -0.3:
            cyl(mb, (sgn * 0.48, y + 0.09, zf - 0.03), (sgn * 0.95, y + 0.09, zf - 0.03), 0.09, 6, 'bark_acacia', seg=1.0, cap=True)
            y += 0.18
    # stovepipe (burzhuika chimney) and a rain-sheet corner
    cyl(mb, (1.0, 0.3, -1.1), (1.0, 1.05, -1.1), 0.055, 8, 'metal_dark', seg=1.0, cap=False)
    cyl(mb, (1.0, 1.05, -1.1), (1.14, 1.12, -1.1), 0.055, 8, 'metal_dark', seg=1.0, cap=True)
    tint(mb, lambda p: 0.5 + 0.5 * min(1.0, max(0.0, (p[1] + 1.7) / 1.8)))
    return mb


def mg_nest_roof(name='mg_nest_roof', seed=360):
    """Covered firing position: four posts at the cell corners, a double layer of logs with sod on top, sandbag cheeks
    either side of the embrasure (+Z)."""
    mb = TMB(name); r = rng(seed)
    for x in (-0.72, 0.72):
        for z in (-0.75, 0.62):
            cyl(mb, (x, -1.1, z), (x, 0.42, z), 0.07, 6, 'bark_acacia', seg=1.0, cap=True)
    # logs across (x), then along (z)
    z = -1.15
    while z < 0.95:
        rad = r.uniform(0.07, 0.09)
        cyl(mb, (-1.15, 0.47, z), (1.15, 0.47 + r.normal(0, 0.01), z), rad, 6, 'bark_acacia', seg=1.0, cap=True)
        z += rad * 2.05
    def f(x, zz):
        e = (abs(x) / 1.25) ** 4 + (abs(zz + 0.1) / 1.15) ** 4
        return 0.52 + 0.28 * max(0.0, 1 - e) ** 0.7 if e < 1 else 0.52
    earth_surface(mb, f, -1.15, 1.15, -1.2, 0.95, 10, 10, 'sod', 2.0)
    for sgn in (-1, 1):
        for c in range(3):
            bag(mb, mat_trs((sgn * 0.95, 0.0 + c * 0.14, 1.02), (0, PI / 2 + r.normal(0, 0.08), 0)), r, half=c % 2)
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


def ammo_crates(name='ammo_crates', seed=380):
    mb = TMB(name); r = rng(seed)
    for i, (x, z, y, a) in enumerate(((0, 0, 0, 0.1), (0.05, 0.02, 0.31, -0.15), (0.72, 0.1, 0, 0.5))):
        M = mat_trs((x, y, z), (0, a, 0))
        tbox(mb, (-0.33, 0, -0.18), (0.33, 0.3, 0.18), 'wood_green', (0.66, 0.3), M=M)
        tbox(mb, (-0.36, 0.06, -0.19), (-0.32, 0.12, 0.19), 'metal_dark', (0.1, 0.1), M=M)
        tbox(mb, (0.32, 0.06, -0.19), (0.36, 0.12, 0.19), 'metal_dark', (0.1, 0.1), M=M)
    tint(mb, lambda p: 0.7)
    return mb


def items():
    import build_forest_lods as FL     # mid-distance tree LODs share the file (and its atlases) -- see build_forest_lods.py
    return FL.items() + [revet_boards(), revet_wattle(), revet_logs(), duckboard(), sandbag_row(), dugout_roof(), mg_nest_roof(),
            dragon_tooth(), dragon_tooth('dragon_tooth_b', 371, chipped=True), ammo_crates()]


def main():
    a, f = BF.atlases()
    reset_scene()
    m_atlas = make_material('farmland_atlas', *a)
    m_fol = make_material('farmland_foliage', *f, alpha_clip=0.5, double=True)
    info = {}
    x = 0.0
    for mb in items():
        mn, mx = mb.bounds(); sz = mx - mn
        loc = (x - mn[0], 0, 0); x += sz[0] + 2
        fix_mb(mb, skip_mats=(1,))
        ob = BF.to_blender(mb, [m_atlas, m_fol], loc)
        ob.name = mb.name + '_geo'; ob.data.name = mb.name
        e = bpy.data.objects.new(mb.name, None); bpy.context.scene.collection.objects.link(e)
        e.location = ob.location.copy(); ob.parent = e; ob.location = (0, 0, 0)
        info[mb.name] = {'tris': mb.tris(), 'bbox_min': [round(float(v), 2) for v in mn], 'bbox_max': [round(float(v), 2) for v in mx]}
        print(f'{mb.name:20s} {mb.tris():6d} tris  size {np.round(sz, 2)}')
    out = os.path.join(REPO, 'assets', 'env', 'fortifications.glb')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, export_apply=True, export_image_format='AUTO',
                              export_materials='EXPORT', export_cameras=False, export_lights=False, export_texcoords=True,
                              export_normals=True, export_vertex_color='ACTIVE', export_all_vertex_colors=False)
    print(os.path.basename(out), round(os.path.getsize(out) / 1e6, 2), 'MB')
    if not os.environ.get('NO_MANIFEST'):
        update_manifest('fortifications', {'file': 'fortifications.glb', 'nodes': info, 'notes': __doc__.split('Run:')[0].strip()})


if __name__ == '__main__':
    import time; t0 = time.time(); main(); print('done', round(time.time() - t0, 1), 's')
