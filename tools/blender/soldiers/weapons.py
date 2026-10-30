"""Weapons: AK-74M, PKM, RPG-7 (+PG-7V).  Origin at the pistol grip (palm centre), +Z = muzzle, +Y up,
weapon's left side = +X.  Empties: muzzle, grip_R (identity at origin), grip_L (support hand).
run: nice -n 10 python3 tools/blender/soldiers/weapons.py"""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import bpy, bmesh
from mathutils import Matrix
import bl, gltfw, meshutil as MU, tex as TX

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../assets/soldiers')


class Builder:
    def __init__(self):
        bl.reset()
        self.parts = []  # (obj, material, group)
        self.group = None

    def _obj(self, bm, name):
        me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
        return ob

    def _finish(self, ob, mat, bevel=0.0, seg=2, angle=40, smooth=True, sub=0, wn=True):
        if bevel > 0:
            m = ob.modifiers.new('bv', 'BEVEL'); m.width = bevel; m.segments = seg
            m.limit_method = 'ANGLE'; m.angle_limit = np.radians(angle); m.harden_normals = False
        if sub:
            s = ob.modifiers.new('ss', 'SUBSURF'); s.levels = sub; s.render_levels = sub
        if wn:
            w = ob.modifiers.new('wn', 'WEIGHTED_NORMAL'); w.keep_sharp = True
        bl.apply_mods(ob)
        if smooth:
            ob.data.shade_smooth()
            try:
                ob.data.set_sharp_from_angle(angle=np.radians(angle))
            except Exception:
                pass
        self.parts.append((ob, mat, self.group))
        return ob

    def profile(self, pts_zy, width, mat, x0=0.0, bevel=0.002, seg=2, angle=35, sub=0):
        """extrude a side-view polygon (z, y) symmetric about x0 with given width"""
        bm = bmesh.new()
        vs = [bm.verts.new(tuple(bl.to_bl(np.array([[x0 - width / 2, y, z]]))[0])) for z, y in pts_zy]
        f = bm.faces.new(vs)
        bmesh.ops.recalc_face_normals(bm, faces=[f])
        r = bmesh.ops.extrude_face_region(bm, geom=[f])
        nv = [e for e in r['geom'] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.translate(bm, vec=(width, 0, 0), verts=nv)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        return self._finish(self._obj(bm, 'prof'), mat, bevel, seg, angle, sub=sub)

    def box(self, c, size, mat, bevel=0.002, seg=2, rot=None):
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
        M = np.eye(4)
        S = np.diag([size[0], size[2], size[1]])  # blender axes: x, y(depth=-gl z), z(up)
        R = np.eye(3) if rot is None else rot
        Rb = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]])  # gl->bl
        M[:3, :3] = Rb @ R @ Rb.T @ S
        M[:3, 3] = bl.to_bl(np.array([c]))[0]
        bmesh.ops.transform(bm, matrix=Matrix(M.tolist()), verts=bm.verts[:])
        return self._finish(self._obj(bm, 'box'), mat, bevel, seg)

    def tube(self, z0, z1, r0, mat, r1=None, c=(0, 0), n=16, bevel=0.0, axis='z', cap=True, inner=None):
        """cylinder along +Z (gl) from z0 to z1 centred at (x, y) = c"""
        r1 = r0 if r1 is None else r1
        bm = bmesh.new()
        res = bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=n, radius1=r0, radius2=r1, depth=abs(z1 - z0))
        # cone is along blender Z; rotate to gl Z (= blender -Y)
        M = np.eye(4)
        M[:3, :3] = [[1, 0, 0], [0, 0, 1], [0, -1, 0]]  # blender z -> -y
        M[:3, 3] = bl.to_bl(np.array([[c[0], c[1], (z0 + z1) / 2]]))[0]
        bmesh.ops.transform(bm, matrix=Matrix(M.tolist()), verts=bm.verts[:])
        return self._finish(self._obj(bm, 'tube'), mat, bevel, 1, 30)

    def export(self, name, mats, empties, extras=None, lod_ratio=0.3):
        g = gltfw.GLB()
        root = g.node(name, extras=extras)
        groups = {}
        for ob, mat, grp in self.parts:
            m = bl.extract(ob)
            groups.setdefault(grp, {}).setdefault(mat, []).append(m)
        tris_all = 0; lod_all = 0
        for grp, bymat in groups.items():
            nm = name if grp is None else grp
            t0, t1 = self._emit(g, root, nm, bymat, mats, lod_ratio, sub=grp is not None)
            tris_all += t0; lod_all += t1
        for en, (t, r) in empties.items():
            g.node(en, parent=root, t=t, r=r)
        os.makedirs(OUT, exist_ok=True)
        g.save(f'{OUT}/{name}.glb')
        return tris_all, lod_all

    def _emit(self, g, root, name, bymat, mats, lod_ratio, sub=False):
        prims = []; tris = 0
        for mat, ms in bymat.items():
            pos = np.concatenate([m['pos'] for m in ms]); nrm = np.concatenate([m['nrm'] for m in ms])
            off = np.cumsum([0] + [len(m['pos']) for m in ms])[:-1]
            tri = np.concatenate([m['tri'] + o for m, o in zip(ms, off)])
            uv = pos[:, [0, 2]] * 4 + pos[:, [1, 1]] * [0, 4]
            prims.append(dict(pos=pos, nrm=nrm, uv=uv, idx=tri, mat=mats(g, mat)))
            tris += len(tri)
        mesh = g.mesh(name + ('' if sub else '_mesh'), prims)
        g.node(name + ('' if sub else '_mesh'), parent=root, mesh=mesh)
        # LOD1: decimated copy
        lod_prims = []
        for (mat, ms), p in zip(bymat.items(), prims):
            bl.reset()
            ob = bl.make_obj('l', p['pos'], p['idx'])
            bl.decimate(ob, lod_ratio)
            mm = bl.extract(ob)
            lod_prims.append(dict(pos=mm['pos'], nrm=mm['nrm'], idx=mm['tri'], mat=p['mat']))
        lmesh = g.mesh(name + '_LOD1', lod_prims)
        g.node(name + '_LOD1', parent=root, mesh=lmesh, extras={'lod': 1})
        return tris, sum(len(p['idx']) for p in lod_prims)


MATS = {
    'steel': dict(color=TX.hexc('#2b2d2e').tolist() + [1], metallic=0.75, roughness=0.38),
    'steel_worn': dict(color=TX.hexc('#3a3c3d').tolist() + [1], metallic=0.8, roughness=0.32),
    'polymer': dict(color=TX.hexc('#1d1c1b').tolist() + [1], metallic=0.0, roughness=0.62),
    'mag_polymer': dict(color=TX.hexc('#2b2321').tolist() + [1], metallic=0.0, roughness=0.5),
    'wood': dict(color=TX.hexc('#7a4a2a').tolist() + [1], metallic=0.0, roughness=0.55),
    'olive_paint': dict(color=TX.hexc('#4c5134').tolist() + [1], metallic=0.2, roughness=0.6),
    'warhead_olive': dict(color=TX.hexc('#55593c').tolist() + [1], metallic=0.3, roughness=0.5),
    'glass': dict(color=TX.hexc('#10161c').tolist() + [1], metallic=0.2, roughness=0.05),
    'brass': dict(color=TX.hexc('#a8843f').tolist() + [1], metallic=0.9, roughness=0.35),
}
MAT_NAMES = {'steel': 'gun_steel', 'steel_worn': 'gun_steel_worn', 'polymer': 'gun_polymer', 'mag_polymer': 'ak_mag_polymer',
             'wood': 'gun_wood', 'olive_paint': 'gun_olive_paint', 'warhead_olive': 'warhead_olive', 'glass': 'optic_glass', 'brass': 'brass'}


def mats(g, key):
    return g.material(MAT_NAMES[key], **MATS[key])


def arc_pts(c, r, a0, a1, n):
    a = np.linspace(a0, a1, n)
    return [(c[0] + r * np.cos(t), c[1] + r * np.sin(t)) for t in a]


def ak74m():
    """AK-74M. Profile points are (z, y) in metres in a frame where the bore axis is y = BORE."""
    B = Builder()
    BORE = 0.074
    # grip reference: pistol grip top (z=0.010, y=0.034), bottom (z=-0.028, y=-0.078); origin at 40%
    gt = np.array([0.010, 0.034]); gb = np.array([-0.028, -0.078])
    O = gt + 0.42 * (gb - gt)  # (z, y) origin
    def P(pts):
        return [(z - O[0], y - O[1]) for z, y in pts]
    def C(x, y, z):
        return (x, y - O[1], z - O[0])
    # ---- receiver (stamped) + dust cover with ribs
    B.profile(P([(-0.105, 0.036), (0.142, 0.036), (0.142, 0.088), (0.128, 0.094), (-0.08, 0.094), (-0.105, 0.088)]), 0.031, 'steel', bevel=0.003)
    B.profile(P([(-0.085, 0.092), (0.118, 0.092), (0.118, 0.100), (0.10, 0.104), (-0.06, 0.104), (-0.085, 0.099)]), 0.027, 'steel', bevel=0.004, seg=3)
    for k in range(5):  # dust cover ribs
        z = -0.06 + k * 0.012
        B.box(C(0, 0.101, z), (0.022, 0.006, 0.004), 'steel', bevel=0.0015)
    # rear sight block and leaf
    B.profile(P([(0.142, 0.07), (0.19, 0.07), (0.19, 0.098), (0.17, 0.112), (0.142, 0.106)]), 0.028, 'steel', bevel=0.002)
    B.box(C(0, 0.113, 0.155), (0.018, 0.004, 0.05), 'steel', bevel=0.001)
    # trunnion / front of receiver lower, magazine well
    B.profile(P([(0.04, 0.036), (0.098, 0.036), (0.098, 0.03), (0.04, 0.03)]), 0.033, 'steel', bevel=0.0015)
    # side rail (dovetail) on the left
    B.box(C(0.0175, 0.068, -0.02), (0.006, 0.026, 0.11), 'steel', bevel=0.001)
    # charging handle (right side) and selector lever
    B.box(C(-0.027, 0.083, 0.115), (0.014, 0.01, 0.012), 'steel', bevel=0.003, seg=2)
    B.profile(P([(-0.06, 0.08), (0.06, 0.08), (0.075, 0.068), (0.06, 0.062), (-0.055, 0.074)]), 0.003, 'steel_worn', x0=-0.0175, bevel=0.0008, seg=1)
    # ---- barrel, gas block, gas tube, front sight, muzzle brake
    B.tube(0.10 - O[0], 0.535 - O[0], 0.0105, 'steel', c=(0, BORE - O[1]), n=14)
    B.profile(P([(0.335, 0.064), (0.37, 0.064), (0.37, 0.112), (0.36, 0.118), (0.335, 0.112)]), 0.026, 'steel', bevel=0.003)
    B.tube(0.19 - O[0], 0.345 - O[0], 0.0095, 'steel', c=(0, 0.101 - O[1]), n=12)
    B.profile(P([(0.495, 0.064), (0.53, 0.064), (0.53, 0.088), (0.52, 0.098), (0.522, 0.13), (0.513, 0.13), (0.505, 0.097)]), 0.02, 'steel', bevel=0.002)
    # AK-74 muzzle brake: body + ports + chamfered tip
    B.tube(0.53 - O[0], 0.607 - O[0], 0.0125, 'steel', c=(0, BORE - O[1]), n=16)
    B.tube(0.607 - O[0], 0.615 - O[0], 0.0125, 'steel', r1=0.0095, c=(0, BORE - O[1]), n=16)
    for z in (0.548, 0.566):
        B.box(C(0, BORE + 0.0135, z), (0.016, 0.004, 0.007), 'polymer', bevel=0.0)
    # ---- polymer furniture: lower handguard (ribbed) and upper handguard
    lg = [(0.192, 0.042), (0.335, 0.046), (0.335, 0.088), (0.192, 0.088)]
    B.profile(P(lg), 0.046, 'polymer', bevel=0.006, seg=3)
    for k in range(4):
        z = 0.215 + k * 0.03
        B.box(C(0, 0.0445, z), (0.042, 0.004, 0.012), 'polymer', bevel=0.0015)
    for sx in (1, -1):
        for k in range(3):
            B.box(C(sx * 0.0235, 0.066, 0.22 + k * 0.04), (0.003, 0.02, 0.018), 'polymer', bevel=0.001)
    ug = [(0.192, 0.09), (0.33, 0.09), (0.33, 0.112), (0.31, 0.118), (0.2, 0.118), (0.192, 0.112)]
    B.profile(P(ug), 0.036, 'polymer', bevel=0.007, seg=3)
    # pistol grip (finger grooves) and trigger guard / trigger
    gp = [(0.012, 0.036), (0.036, 0.036), (0.012, -0.03), (0.006, -0.06), (-0.002, -0.082), (-0.03, -0.084), (-0.03, -0.06), (-0.016, -0.01), (-0.012, 0.036)]
    B.profile(P(gp), 0.029, 'polymer', bevel=0.006, seg=3)
    tg = [(0.02, 0.036), (0.09, 0.036), (0.09, 0.03), (0.06, 0.004), (0.022, 0.002), (0.02, 0.008), (0.026, 0.008), (0.058, 0.01), (0.083, 0.03), (0.02, 0.03)]
    B.profile(P(tg), 0.006, 'steel', bevel=0.001, seg=1)
    B.profile(P([(0.038, 0.034), (0.045, 0.034), (0.04, 0.012), (0.035, 0.012)]), 0.005, 'steel', bevel=0.0008, seg=1)
    # ---- side-folding polymer stock (AK-74M solid buttstock)
    st = [(-0.105, 0.088), (-0.105, 0.04), (-0.16, 0.028), (-0.235, 0.0), (-0.325, -0.038), (-0.34, -0.04), (-0.343, 0.04), (-0.34, 0.085), (-0.32, 0.088), (-0.20, 0.086)]
    B.profile(P(st), 0.036, 'polymer', bevel=0.006, seg=3)
    # lightening recess ridges
    for sx in (1, -1):
        B.profile(P([(-0.17, 0.064), (-0.30, 0.058), (-0.31, 0.02), (-0.21, 0.035)]), 0.004, 'polymer', x0=sx * 0.0175, bevel=0.0012, seg=1)
    B.box(C(0, 0.024, -0.338), (0.038, 0.13, 0.01), 'polymer', bevel=0.003)  # butt pad
    B.box(C(0, 0.06, -0.103), (0.03, 0.05, 0.008), 'steel', bevel=0.0015)  # hinge block
    # ---- 30-round 5.45 magazine (curved, polymer, ribbed) -> separate node 'magazine' (reload)
    B.group = 'magazine'
    mag = []
    zf, yf = 0.098, 0.034   # front top
    zr, yr = 0.058, 0.034   # rear top
    # curve: centre of curvature in front-down direction
    cc = np.array([0.40, 0.03]); R1 = np.linalg.norm(np.array([zf, yf]) - cc); R2 = np.linalg.norm(np.array([zr, yr]) - cc)
    a0 = np.arctan2(yf - cc[1], zf - cc[0]); a1 = a0 + 0.62
    front = arc_pts(cc, R1, a0, a1, 10)
    rear = arc_pts(cc, R2, a0 + 0.02, a1 - 0.01, 10)[::-1]
    mag = front + rear
    B.profile(P(mag), 0.026, 'mag_polymer', bevel=0.004, seg=2)
    # floor plate
    fp = np.array(front[-1]); rp = np.array(rear[0])
    d = rp - fp
    nrm = np.array([d[1], -d[0]]) / np.linalg.norm(d)
    B.profile(P([tuple(fp - d * 0.08), tuple(rp + d * 0.08), tuple(rp + d * 0.08 + nrm * -0.008), tuple(fp - d * 0.08 + nrm * -0.008)]), 0.03, 'mag_polymer', bevel=0.002)
    # ribs on mag sides
    for k in range(3):
        t = 0.25 + k * 0.22
        pa = np.array(arc_pts(cc, R1 - 0.004, a0 + t * 0.6, a0 + t * 0.6, 1)[0]); pb = np.array(arc_pts(cc, R2 + 0.004, a0 + t * 0.6, a0 + t * 0.6, 1)[0])
        for sx in (1, -1):
            B.profile(P([tuple(pa), tuple(pb), tuple(pb + [0.004, -0.002]), tuple(pa + [0.004, -0.002])]), 0.0025, 'mag_polymer', x0=sx * 0.0135, bevel=0.0, seg=1)
    B.group = None
    muzzle = (np.array([0, BORE - O[1], 0.615 - O[0]]), [0, 0, 0, 1])
    grip_L = (np.array([0, 0.040 - O[1], 0.228 - O[0]]), [0, 0, 0, 1])
    rear_sight = (np.array([0, 0.116 - O[1], 0.15 - O[0]]), [0, 0, 0, 1])
    front_sight = (np.array([0, 0.13 - O[1], 0.517 - O[0]]), [0, 0, 0, 1])
    stock_butt = (np.array([0, 0.025 - O[1], -0.343 - O[0]]), [0, 0, 0, 1])
    emp = {'muzzle': muzzle, 'grip_R': (np.zeros(3), [0, 0, 0, 1]), 'grip_L': grip_L, 'sight_rear': rear_sight,
           'sight_front': front_sight, 'stock_butt': stock_butt}
    tris = B.export('ak74m', mats, emp, extras={'calibre': '5.45x39', 'length_m': 0.943})
    return tris, {k: [list(map(float, v[0])), v[1]] for k, v in emp.items()}


def pkm():
    B = Builder()
    BORE = 0.085
    gt = np.array([0.0, 0.03]); gb = np.array([-0.03, -0.085])
    O = gt + 0.42 * (gb - gt)
    def P(pts):
        return [(z - O[0], y - O[1]) for z, y in pts]
    def C(x, y, z):
        return (x, y - O[1], z - O[0])
    # receiver + feed cover
    B.profile(P([(-0.09, 0.032), (0.24, 0.032), (0.25, 0.06), (0.25, 0.1), (-0.07, 0.1), (-0.09, 0.09)]), 0.052, 'steel', bevel=0.004)
    B.profile(P([(-0.04, 0.1), (0.16, 0.1), (0.16, 0.122), (0.13, 0.13), (-0.02, 0.13), (-0.04, 0.118)]), 0.05, 'steel', bevel=0.005, seg=3)
    B.box(C(0, 0.135, 0.02), (0.012, 0.012, 0.05), 'steel', bevel=0.002)  # rear sight
    # barrel (fluted look via 2 diameters), flash hider, gas tube, front sight, carry handle, bipod
    B.tube(0.24 - O[0], 0.86 - O[0], 0.0125, 'steel', c=(0, BORE - O[1]), n=14)
    B.tube(0.86 - O[0], 0.935 - O[0], 0.0135, 'steel', r1=0.012, c=(0, BORE - O[1]), n=14)
    B.tube(0.24 - O[0], 0.66 - O[0], 0.0095, 'steel', c=(0, 0.06 - O[1]), n=12)
    B.profile(P([(0.65, 0.05), (0.69, 0.05), (0.69, 0.1), (0.655, 0.1)]), 0.03, 'steel', bevel=0.003)
    B.profile(P([(0.82, 0.075), (0.85, 0.075), (0.845, 0.135), (0.835, 0.135)]), 0.012, 'steel', bevel=0.002)
    B.profile(P([(0.29, 0.098), (0.31, 0.098), (0.33, 0.15), (0.44, 0.15), (0.46, 0.098), (0.48, 0.098), (0.45, 0.16), (0.32, 0.16)]), 0.02, 'steel', bevel=0.003)
    B.profile(P([(0.33, 0.15), (0.44, 0.15), (0.44, 0.165), (0.33, 0.165)]), 0.03, 'wood', bevel=0.005)
    for sx in (1, -1):  # folded bipod legs
        B.box(C(sx * 0.012, 0.055, 0.52), (0.008, 0.008, 0.28), 'steel', bevel=0.002)
    # pistol grip, trigger guard
    B.profile(P([(0.0, 0.034), (0.03, 0.034), (0.005, -0.06), (-0.005, -0.09), (-0.035, -0.09), (-0.03, -0.06), (-0.015, 0.034)]), 0.03, 'polymer', bevel=0.006, seg=3)
    B.profile(P([(0.02, 0.034), (0.09, 0.034), (0.07, 0.0), (0.025, -0.002), (0.022, 0.006), (0.03, 0.006), (0.065, 0.008), (0.08, 0.028), (0.02, 0.028)]), 0.006, 'steel', bevel=0.001, seg=1)
    # skeleton stock
    st = [(-0.09, 0.095), (-0.09, 0.035), (-0.17, 0.01), (-0.33, -0.05), (-0.345, -0.05), (-0.348, 0.07), (-0.33, 0.1), (-0.2, 0.098)]
    B.profile(P(st), 0.036, 'polymer', bevel=0.006, seg=3)
    B.profile(P([(-0.16, 0.07), (-0.31, 0.06), (-0.31, -0.02), (-0.2, 0.025)]), 0.04, 'steel_worn', bevel=0.002)  # dark hole insert (visual)
    # 100-round box under the receiver (right side) + belt stub
    B.box(C(-0.015, -0.02, 0.14), (0.05, 0.11, 0.13), 'olive_paint', bevel=0.004)
    B.box(C(-0.015, 0.035, 0.14), (0.052, 0.008, 0.132), 'olive_paint', bevel=0.002)
    for k in range(4):
        B.tube(0.105 - O[0] + k * 0.01, 0.106 - O[0] + k * 0.01 + 0.006, 0.0055, 'brass', c=(-0.03 - k * 0.003, 0.05 - O[1] + k * 0.0), n=8)
    emp = {'muzzle': (np.array([0, BORE - O[1], 0.935 - O[0]]), [0, 0, 0, 1]), 'grip_R': (np.zeros(3), [0, 0, 0, 1]),
           'grip_L': (np.array([0, -0.01 - O[1], 0.2 - O[0]]), [0, 0, 0, 1]),
           'stock_butt': (np.array([0, 0.02 - O[1], -0.348 - O[0]]), [0, 0, 0, 1])}
    tris = B.export('pkm', mats, emp, extras={'calibre': '7.62x54R', 'length_m': 1.19})
    return tris, {k: [list(map(float, v[0])), v[1]] for k, v in emp.items()}


def rpg7():
    B = Builder()
    AX = 0.07  # tube axis height above grip origin reference
    gt = np.array([0.0, 0.045]); gb = np.array([-0.025, -0.07])
    O = gt + 0.42 * (gb - gt)
    def C(x, y, z):
        return (x, y - O[1], z - O[0])
    Y = AX - O[1]
    # launcher tube: front at z=+0.35 (muzzle), rear venturi at z=-0.6
    B.tube(-0.43 - O[0], 0.35 - O[0], 0.024, 'steel', c=(0, Y), n=18)
    B.tube(0.33 - O[0], 0.355 - O[0], 0.027, 'steel', c=(0, Y), n=18)
    B.tube(-0.47 - O[0], -0.43 - O[0], 0.032, 'steel', r1=0.026, c=(0, Y), n=18)
    B.tube(-0.6 - O[0], -0.47 - O[0], 0.05, 'steel', r1=0.032, c=(0, Y), n=18, cap=False)
    # wooden heat guards
    B.tube(-0.3 - O[0], -0.08 - O[0], 0.031, 'wood', c=(0, Y), n=18)
    B.tube(0.05 - O[0], 0.2 - O[0], 0.031, 'wood', c=(0, Y), n=18)
    for z in (-0.3, -0.08, 0.05, 0.2):
        B.tube(z - 0.006 - O[0], z + 0.006 - O[0], 0.033, 'steel', c=(0, Y), n=18)
    # pistol grip + trigger guard (rear grip at origin), front grip
    B.profile([(z - O[0], y - O[1]) for z, y in [(0.0, 0.05), (0.032, 0.05), (0.006, -0.05), (-0.002, -0.075), (-0.03, -0.075), (-0.022, -0.05), (-0.015, 0.05)]], 0.03, 'polymer', bevel=0.006, seg=3)
    B.profile([(z - O[0], y - O[1]) for z, y in [(0.035, 0.05), (0.1, 0.05), (0.08, 0.012), (0.04, 0.01), (0.04, 0.018), (0.075, 0.02), (0.09, 0.044), (0.035, 0.044)]], 0.006, 'steel', bevel=0.001, seg=1)
    B.profile([(z - O[0], y - O[1]) for z, y in [(-0.17, 0.05), (-0.14, 0.05), (-0.155, -0.04), (-0.18, -0.04)]], 0.028, 'polymer', bevel=0.006, seg=2)
    # PGO-7 sight on the left with rubber eyecup, iron sights on top
    B.box(C(0.055, Y + O[1] + 0.035, -0.09), (0.03, 0.05, 0.12), 'olive_paint', bevel=0.005)
    B.tube(-0.2 - O[0], -0.15 - O[0], 0.016, 'polymer', c=(0.055, Y + 0.045), n=12)
    B.tube(-0.04 - O[0], -0.02 - O[0], 0.014, 'glass', c=(0.055, Y + 0.045), n=12)
    B.box(C(0, Y + O[1] + 0.03, 0.25), (0.008, 0.02, 0.01), 'steel', bevel=0.001)
    B.box(C(0, Y + O[1] + 0.03, -0.02), (0.012, 0.02, 0.01), 'steel', bevel=0.001)
    # sling swivels
    # ---- PG-7V grenade in the muzzle: motor tube, ogive body (85 mm), nose cone, piezo fuze tip
    zb = 0.35
    B.tube(zb - 0.01 - O[0], zb + 0.05 - O[0], 0.02, 'warhead_olive', c=(0, Y), n=16)
    B.tube(zb + 0.05 - O[0], zb + 0.08 - O[0], 0.02, 'warhead_olive', r1=0.0425, c=(0, Y), n=20)
    B.tube(zb + 0.08 - O[0], zb + 0.13 - O[0], 0.0425, 'warhead_olive', c=(0, Y), n=20)
    B.tube(zb + 0.13 - O[0], zb + 0.27 - O[0], 0.0425, 'warhead_olive', r1=0.011, c=(0, Y), n=20)
    B.tube(zb + 0.27 - O[0], zb + 0.29 - O[0], 0.011, 'steel', r1=0.007, c=(0, Y), n=10)
    emp = {'muzzle': (np.array([0, Y, zb - O[0]]), [0, 0, 0, 1]), 'grip_R': (np.zeros(3), [0, 0, 0, 1]),
           'grip_L': (np.array([0, -0.0 - O[1], -0.16 - O[0]]), [0, 0, 0, 1]),
           'backblast': (np.array([0, Y, -0.6 - O[0]]), [0, 1, 0, 0]),
           'warhead': (np.array([0, Y, zb + 0.15 - O[0]]), [0, 0, 0, 1]),
           'shoulder_rest': (np.array([0, Y + 0.035, -0.20 - O[0]]), [0, 0, 0, 1])}
    tris = B.export('rpg7', mats, emp, extras={'calibre': '40 mm launcher, PG-7V 85 mm HEAT', 'length_m': 0.95})
    return tris, {k: [list(map(float, v[0])), v[1]] for k, v in emp.items()}


if __name__ == '__main__':
    info = {}
    for fn in (ak74m, pkm, rpg7):
        (t0, t1), emp = fn()
        info[fn.__name__] = dict(tris=t0, tris_LOD1=t1, empties=emp)
        print(fn.__name__, t0, t1)
    os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache'), exist_ok=True)
    json.dump(info, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache', 'weapons_info.json'), 'w'), indent=1)
