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

    def lathe(self, prof, mat, c=(0, 0), n=20, angle=35, a0=0.0):
        """solid of revolution about gl +Z through (x, y) = c; prof: [(z, r), ...] (r = 0 -> pole)"""
        bm = bmesh.new()
        rings = []
        for z, r in prof:
            if r <= 1e-6:
                rings.append([bm.verts.new(tuple(bl.to_bl(np.array([[c[0], c[1], z]]))[0]))])
                continue
            a = a0 + np.linspace(0, 2 * np.pi, n, endpoint=False)
            P = np.stack([c[0] + r * np.cos(a), c[1] + r * np.sin(a), np.full(n, z)], 1)
            rings.append([bm.verts.new(tuple(p)) for p in bl.to_bl(P)])
        for A, B in zip(rings[:-1], rings[1:]):
            if len(A) == 1 and len(B) == 1:
                continue
            for k in range(n):
                if len(A) == 1:
                    bm.faces.new((A[0], B[k], B[(k + 1) % n]))
                elif len(B) == 1:
                    bm.faces.new((A[k], A[(k + 1) % n], B[0]))
                else:
                    bm.faces.new((A[k], A[(k + 1) % n], B[(k + 1) % n], B[k]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        return self._finish(self._obj(bm, 'lathe'), mat, 0.0, 1, angle, wn=False)

    def strap(self, pts, width, thick, mat, up=(1, 0, 0)):
        """flat strap along a gl polyline; `up` = strap face normal hint"""
        pts = np.asarray(pts, float)
        bm = bmesh.new()
        secs = []
        for i, p in enumerate(pts):
            d = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]; d /= np.linalg.norm(d)
            u = np.asarray(up, float); u = u - d * (u @ d); u /= np.linalg.norm(u)
            w = np.cross(d, u)
            Q = [p + w * width / 2 + u * thick / 2, p - w * width / 2 + u * thick / 2, p - w * width / 2 - u * thick / 2, p + w * width / 2 - u * thick / 2]
            secs.append([bm.verts.new(tuple(q)) for q in bl.to_bl(np.array(Q))])
        for A, B in zip(secs[:-1], secs[1:]):
            for k in range(4):
                bm.faces.new((A[k], A[(k + 1) % 4], B[(k + 1) % 4], B[k]))
        bm.faces.new(secs[0][::-1]); bm.faces.new(secs[-1])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        return self._finish(self._obj(bm, 'strap'), mat, 0.0, 1, 30, wn=False)

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
    'fibreglass_olive': dict(color=TX.hexc('#434b2c').tolist() + [1], metallic=0.0, roughness=0.6),
    'fibreglass_olive_dark': dict(color=TX.hexc('#343a24').tolist() + [1], metallic=0.0, roughness=0.6),
    'bore_black': dict(color=TX.hexc('#0c0c0b').tolist() + [1], metallic=0.0, roughness=0.9),
    'rubber_black': dict(color=TX.hexc('#1a1a18').tolist() + [1], metallic=0.0, roughness=0.8),
    'sling_webbing': dict(color=TX.hexc('#4a4a36').tolist() + [1], metallic=0.0, roughness=0.95),
    'stencil_yellow': dict(color=TX.hexc('#8f8040').tolist() + [1], metallic=0.0, roughness=0.7),
}
MAT_NAMES = {'steel': 'gun_steel', 'steel_worn': 'gun_steel_worn', 'polymer': 'gun_polymer', 'mag_polymer': 'ak_mag_polymer',
             'wood': 'gun_wood', 'olive_paint': 'gun_olive_paint', 'warhead_olive': 'warhead_olive', 'glass': 'optic_glass', 'brass': 'brass',
             'fibreglass_olive': 'rpg22_fibreglass', 'fibreglass_olive_dark': 'rpg22_fibreglass_dark', 'bore_black': 'bore_black',
             'rubber_black': 'rubber_black', 'sling_webbing': 'sling_webbing', 'stencil_yellow': 'stencil_yellow'}


def mats(g, key):
    return g.material(MAT_NAMES[key], **MATS[key])


def arc_pts(c, r, a0, a1, n):
    a = np.linspace(a0, a1, n)
    return [(c[0] + r * np.cos(t), c[1] + r * np.sin(t)) for t in a]


AK_GT = np.array([0.010, 0.034]); AK_GB = np.array([-0.028, -0.078])
AK_O = AK_GT + 0.42 * (AK_GB - AK_GT)     # (z, y) of the origin (pistol-grip palm centre) in profile space
AK_BORE = 0.074


def _akP(pts):
    return [(z - AK_O[0], y - AK_O[1]) for z, y in pts]


def _akC(x, y, z):
    return (x, y - AK_O[1], z - AK_O[0])


def _rail(B, z0, z1, y, width=0.021, mat='steel', x=0.0, slots=True, up=True):
    """Picatinny rail along z at height y (top of the rail base), optional cross slots"""
    P, C = _akP, _akC
    h = 0.0095
    B.profile(P([(z0, y), (z1, y), (z1, y + h * 0.55), (z1 - 0.002, y + h), (z0 + 0.002, y + h), (z0, y + h * 0.55)]), width, mat, x0=x, bevel=0.0008, seg=1)
    if slots:
        n = int((z1 - z0) / 0.01)
        for k in range(n):
            z = z0 + 0.005 + k * 0.01
            if z + 0.0025 > z1 - 0.003:
                break
            B.box(C(x, y + h + 0.0004, z), (width + 0.001, 0.0035, 0.0052), 'bore_black', bevel=0.0)


def _ak_core(B, brake='ak74', front_sight=True, rear_sight=True, dust_ribs=True):
    """receiver, barrel, gas block/tube, pistol grip, trigger guard, charging handle, selector"""
    P, C, O, BORE = _akP, _akC, AK_O, AK_BORE
    B.profile(P([(-0.105, 0.036), (0.142, 0.036), (0.142, 0.088), (0.128, 0.094), (-0.08, 0.094), (-0.105, 0.088)]), 0.031, 'steel', bevel=0.003)
    B.profile(P([(-0.085, 0.092), (0.118, 0.092), (0.118, 0.100), (0.10, 0.104), (-0.06, 0.104), (-0.085, 0.099)]), 0.027, 'steel', bevel=0.004, seg=3)
    if dust_ribs:
        for k in range(5):
            z = -0.06 + k * 0.012
            B.box(C(0, 0.101, z), (0.022, 0.006, 0.004), 'steel', bevel=0.0015)
    if rear_sight:
        B.profile(P([(0.142, 0.07), (0.19, 0.07), (0.19, 0.098), (0.17, 0.112), (0.142, 0.106)]), 0.028, 'steel', bevel=0.002)
        B.box(C(0, 0.113, 0.155), (0.018, 0.004, 0.05), 'steel', bevel=0.001)
    else:
        B.profile(P([(0.142, 0.07), (0.19, 0.07), (0.19, 0.096), (0.142, 0.100)]), 0.028, 'steel', bevel=0.002)
    B.profile(P([(0.04, 0.036), (0.098, 0.036), (0.098, 0.03), (0.04, 0.03)]), 0.033, 'steel', bevel=0.0015)
    B.box(C(0.0175, 0.068, -0.02), (0.006, 0.026, 0.11), 'steel', bevel=0.001)
    B.box(C(-0.027, 0.083, 0.115), (0.014, 0.01, 0.012), 'steel', bevel=0.003, seg=2)
    B.profile(P([(-0.06, 0.08), (0.06, 0.08), (0.075, 0.068), (0.06, 0.062), (-0.055, 0.074)]), 0.003, 'steel_worn', x0=-0.0175, bevel=0.0008, seg=1)
    B.tube(0.10 - O[0], 0.535 - O[0], 0.0105, 'steel', c=(0, BORE - O[1]), n=14)
    B.profile(P([(0.335, 0.064), (0.37, 0.064), (0.37, 0.112), (0.36, 0.118), (0.335, 0.112)]), 0.026, 'steel', bevel=0.003)
    B.tube(0.19 - O[0], 0.345 - O[0], 0.0095, 'steel', c=(0, 0.101 - O[1]), n=12)
    if front_sight:
        B.profile(P([(0.495, 0.064), (0.53, 0.064), (0.53, 0.088), (0.52, 0.098), (0.522, 0.13), (0.513, 0.13), (0.505, 0.097)]), 0.02, 'steel', bevel=0.002)
    if brake == 'ak74':
        B.tube(0.53 - O[0], 0.607 - O[0], 0.0125, 'steel', c=(0, BORE - O[1]), n=16)
        B.tube(0.607 - O[0], 0.615 - O[0], 0.0125, 'steel', r1=0.0095, c=(0, BORE - O[1]), n=16)
        for z in (0.548, 0.566):
            B.box(C(0, BORE + 0.0135, z), (0.016, 0.004, 0.007), 'polymer', bevel=0.0)
        mz = 0.615
    else:   # AK-12 brake: longer cylinder with side ports and a slotted crown
        B.tube(0.53 - O[0], 0.622 - O[0], 0.0138, 'steel', c=(0, BORE - O[1]), n=18)
        B.tube(0.622 - O[0], 0.63 - O[0], 0.0138, 'steel', r1=0.011, c=(0, BORE - O[1]), n=18)
        for z in (0.556, 0.574, 0.592):
            for sx in (1, -1):
                B.box(C(sx * 0.0135, BORE, z), (0.004, 0.012, 0.008), 'bore_black', bevel=0.0)
        mz = 0.63
    gp = [(0.012, 0.036), (0.036, 0.036), (0.012, -0.03), (0.006, -0.06), (-0.002, -0.082), (-0.03, -0.084), (-0.03, -0.06), (-0.016, -0.01), (-0.012, 0.036)]
    B.profile(P(gp), 0.029, 'polymer', bevel=0.006, seg=3)
    tg = [(0.02, 0.036), (0.09, 0.036), (0.09, 0.03), (0.06, 0.004), (0.022, 0.002), (0.02, 0.008), (0.026, 0.008), (0.058, 0.01), (0.083, 0.03), (0.02, 0.03)]
    B.profile(P(tg), 0.006, 'steel', bevel=0.001, seg=1)
    B.profile(P([(0.038, 0.034), (0.045, 0.034), (0.04, 0.012), (0.035, 0.012)]), 0.005, 'steel', bevel=0.0008, seg=1)
    return mz


def _ak_mag(B, mat='mag_polymer', ribs=True):
    P = _akP
    B.group = 'magazine'
    zf, yf = 0.098, 0.034
    zr, yr = 0.058, 0.034
    cc = np.array([0.40, 0.03]); R1 = np.linalg.norm(np.array([zf, yf]) - cc); R2 = np.linalg.norm(np.array([zr, yr]) - cc)
    a0 = np.arctan2(yf - cc[1], zf - cc[0]); a1 = a0 + 0.62
    front = arc_pts(cc, R1, a0, a1, 10)
    rear = arc_pts(cc, R2, a0 + 0.02, a1 - 0.01, 10)[::-1]
    B.profile(P(front + rear), 0.026, mat, bevel=0.004, seg=2)
    fp = np.array(front[-1]); rp = np.array(rear[0])
    d = rp - fp
    nrm = np.array([d[1], -d[0]]) / np.linalg.norm(d)
    B.profile(P([tuple(fp - d * 0.08), tuple(rp + d * 0.08), tuple(rp + d * 0.08 + nrm * -0.008), tuple(fp - d * 0.08 + nrm * -0.008)]), 0.03, mat, bevel=0.002)
    if ribs:
        for k in range(3):
            t = 0.25 + k * 0.22
            pa = np.array(arc_pts(cc, R1 - 0.004, a0 + t * 0.6, a0 + t * 0.6, 1)[0]); pb = np.array(arc_pts(cc, R2 + 0.004, a0 + t * 0.6, a0 + t * 0.6, 1)[0])
            for sx in (1, -1):
                B.profile(P([tuple(pa), tuple(pb), tuple(pb + [0.004, -0.002]), tuple(pa + [0.004, -0.002])]), 0.0025, mat, x0=sx * 0.0135, bevel=0.0, seg=1)
    B.group = None


def _ak74_furniture(B, handguards=True, stock=True):
    P, C = _akP, _akC
    if handguards:
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
    if stock:
        st = [(-0.105, 0.088), (-0.105, 0.04), (-0.16, 0.028), (-0.235, 0.0), (-0.325, -0.038), (-0.34, -0.04), (-0.343, 0.04), (-0.34, 0.085), (-0.32, 0.088), (-0.20, 0.086)]
        B.profile(P(st), 0.036, 'polymer', bevel=0.006, seg=3)
        for sx in (1, -1):
            B.profile(P([(-0.17, 0.064), (-0.30, 0.058), (-0.31, 0.02), (-0.21, 0.035)]), 0.004, 'polymer', x0=sx * 0.0175, bevel=0.0012, seg=1)
        B.box(C(0, 0.024, -0.338), (0.038, 0.13, 0.01), 'polymer', bevel=0.003)
        B.box(C(0, 0.06, -0.103), (0.03, 0.05, 0.008), 'steel', bevel=0.0015)


def _ak_empties(mz, rear=(0.116, 0.15), front=(0.13, 0.517), butt=(0.025, -0.343), grip_L=(0.040, 0.228), extra=None):
    O, BORE = AK_O, AK_BORE
    e = {'muzzle': (np.array([0, BORE - O[1], mz - O[0]]), [0, 0, 0, 1]), 'grip_R': (np.zeros(3), [0, 0, 0, 1]),
         'grip_L': (np.array([0, grip_L[0] - O[1], grip_L[1] - O[0]]), [0, 0, 0, 1]),
         'sight_rear': (np.array([0, rear[0] - O[1], rear[1] - O[0]]), [0, 0, 0, 1]),
         'sight_front': (np.array([0, front[0] - O[1], front[1] - O[0]]), [0, 0, 0, 1]),
         'stock_butt': (np.array([0, butt[0] - O[1], butt[1] - O[0]]), [0, 0, 0, 1])}
    for k, (y, z) in (extra or {}).items():
        e[k] = (np.array([0, y - O[1], z - O[0]]), [0, 0, 0, 1])
    return e


def ak74m():
    """AK-74M. Profile points are (z, y) in metres in a frame where the bore axis is y = BORE."""
    B = Builder()
    mz = _ak_core(B)
    _ak74_furniture(B)
    _ak_mag(B)
    emp = _ak_empties(mz)
    tris = B.export('ak74m', mats, emp, extras={'calibre': '5.45x39', 'length_m': 0.943})
    return tris, {k: [list(map(float, v[0])), v[1]] for k, v in emp.items()}


def _collimator_1p87(B, z0, ytop):
    """1P87-style collimator sight on a rail: squarish housing, large rectangular window, side knobs"""
    C = _akC
    L = 0.10; W = 0.054; H = 0.06
    zc = z0 + L / 2
    B.box(C(0, ytop + 0.006, zc), (0.036, 0.012, L * 0.9), 'polymer', bevel=0.002)                      # rail clamp base
    B.box(C(0.0215, ytop + 0.006, zc), (0.008, 0.016, 0.03), 'steel', bevel=0.002)                      # clamp lever
    yb = ytop + 0.012
    for sx in (1, -1):   # side walls
        B.box(C(sx * (W / 2 - 0.004), yb + H / 2, zc), (0.008, H, L), 'olive_paint', bevel=0.003)
    B.box(C(0, yb + H - 0.004, zc), (W, 0.008, L), 'olive_paint', bevel=0.003)                       # roof
    B.box(C(0, yb + 0.006, zc), (W, 0.012, L), 'olive_paint', bevel=0.003)                            # floor / emitter housing
    B.box(C(0, yb + H / 2, z0 + L - 0.004), (W - 0.014, H - 0.018, 0.003), 'glass', bevel=0.0)       # objective window
    B.box(C(0, yb + H / 2, z0 + 0.012), (W - 0.014, H - 0.018, 0.003), 'glass', bevel=0.0)           # eyepiece window
    B.box(C(0, yb + H + 0.004, z0 + L - 0.012), (W, 0.004, 0.03), 'olive_paint', bevel=0.0015)       # sun-shade lip
    # windage / elevation turrets + battery cap
    B.box(C(-(W / 2 + 0.006), yb + H * 0.55, zc), (0.012, 0.022, 0.022), 'polymer', bevel=0.004)
    B.box(C(0, yb + H + 0.008, zc - 0.02), (0.022, 0.012, 0.022), 'polymer', bevel=0.004)
    return yb + H / 2


def _holo_sight(B, z0, ytop):
    """EOTech-style holographic sight: low body with battery box, rectangular hood over the window"""
    C = _akC
    L = 0.096; W = 0.042
    zc = z0 + L / 2
    B.box(C(0, ytop + 0.005, zc), (0.032, 0.010, L * 0.85), 'polymer', bevel=0.002)
    B.box(C(0, ytop + 0.021, zc - 0.012), (W, 0.022, L * 0.72), 'polymer', bevel=0.004)             # body (battery compartment)
    yw = ytop + 0.032
    hh = 0.034
    for sx in (1, -1):
        B.box(C(sx * (W / 2 - 0.003), yw + hh / 2, zc + 0.008), (0.006, hh, L * 0.62), 'polymer', bevel=0.002)
    B.box(C(0, yw + hh - 0.002, zc + 0.008), (W, 0.005, L * 0.62), 'polymer', bevel=0.0025)          # hood roof
    B.box(C(0, yw + hh / 2 - 0.002, zc + 0.03), (W - 0.01, hh - 0.008, 0.003), 'glass', bevel=0.0)   # window
    B.box(C(0, yw + hh / 2 - 0.002, zc - 0.012), (W - 0.01, hh - 0.008, 0.002), 'glass', bevel=0.0)
    for k in range(3):
        B.box(C(-W / 2 - 0.001, ytop + 0.02, zc - 0.03 + k * 0.012), (0.003, 0.007, 0.007), 'rubber_black', bevel=0.001)
    return yw + hh / 2 - 0.002


def ak12():
    """AK-12 (6P70, 2020 pattern): railed hinged dust cover, railed handguard, AK-12 brake, telescoping/folding stock
    with cheek riser, ribbed 30-round magazine, 1P87-style collimator sight."""
    B = Builder()
    P, C, O = _akP, _akC, AK_O
    mz = _ak_core(B, brake='ak12', front_sight=False, rear_sight=False, dust_ribs=False)
    # rail on the dust cover (one piece with the cover, hinged at the rear-sight block) + continuation on the handguard
    _rail(B, -0.075, 0.185, 0.104, width=0.021)
    # railed polymer handguard: tall lower part with M-LOK slots, top rail carried on the gas-tube cover
    lg = [(0.192, 0.040), (0.345, 0.044), (0.348, 0.10), (0.19, 0.10)]
    B.profile(P(lg), 0.05, 'polymer', bevel=0.005, seg=2)
    for sx in (1, -1):
        for k in range(4):
            B.box(C(sx * 0.0252, 0.065, 0.215 + k * 0.032), (0.002, 0.012, 0.022), 'bore_black', bevel=0.0)
    for k in range(5):
        B.box(C(0, 0.0405, 0.205 + k * 0.028), (0.044, 0.003, 0.012), 'polymer', bevel=0.001)
    ug = [(0.19, 0.10), (0.345, 0.10), (0.345, 0.112), (0.19, 0.112)]
    B.profile(P(ug), 0.040, 'polymer', bevel=0.004, seg=2)
    _rail(B, 0.20, 0.335, 0.112, width=0.021, mat='polymer')
    # front sight post on the gas block, flip-up style
    B.profile(P([(0.36, 0.112), (0.372, 0.112), (0.37, 0.132), (0.364, 0.132)]), 0.008, 'steel', bevel=0.001, seg=1)
    # telescoping / side-folding stock: hinge block, guide tube, polymer stock with adjustable cheek riser and butt pad
    B.box(C(0, 0.07, -0.112), (0.03, 0.05, 0.016), 'steel', bevel=0.002)
    B.tube(-0.25 - O[0], -0.118 - O[0], 0.0145, 'polymer', c=(0, 0.074 - O[1]), n=14)
    st = [(-0.20, 0.098), (-0.20, 0.046), (-0.26, 0.022), (-0.33, -0.012), (-0.348, -0.018), (-0.352, 0.096), (-0.33, 0.104)]
    B.profile(P(st), 0.04, 'polymer', bevel=0.006, seg=2)
    B.profile(P([(-0.215, 0.102), (-0.325, 0.108), (-0.325, 0.122), (-0.225, 0.118)]), 0.034, 'polymer', bevel=0.005, seg=2)   # cheek riser
    B.box(C(0, 0.04, -0.355), (0.042, 0.13, 0.012), 'rubber_black', bevel=0.004)
    for sx in (1, -1):
        B.box(C(sx * 0.0205, 0.05, -0.285), (0.002, 0.03, 0.06), 'bore_black', bevel=0.0)                # lightening pockets
    _ak_mag(B, ribs=True)
    eye_y = _collimator_1p87(B, -0.04, 0.1135)
    emp = _ak_empties(mz, rear=(eye_y, -0.04), front=(eye_y, 0.06), butt=(0.04, -0.361), grip_L=(0.040, 0.24),
                      extra={'optic_eye': (eye_y, -0.13)})
    tris = B.export('ak12', mats, emp, extras={'calibre': '5.45x39', 'length_m': 0.945, 'optic': '1P87-style collimator',
                                               'sight_line_above_bore_m': round(float(eye_y - AK_BORE), 3)})
    return tris, {k: [list(map(float, v[0])), v[1]] for k, v in emp.items()}


def ak74m_optic():
    """UA AK-74M upgrade: railed dust cover (B-33 style) with a holographic sight, railed gas-tube cover and lower
    handguard with a vertical foregrip, original side-folding stock."""
    B = Builder()
    P, C, O = _akP, _akC, AK_O
    mz = _ak_core(B, rear_sight=True)
    _ak74_furniture(B, handguards=False, stock=True)
    # railed dust cover (replaces the ribbed one visually: rail sits on top)
    _rail(B, -0.07, 0.11, 0.104, width=0.021)
    # aluminium railed upper (gas tube cover) and lower handguard
    B.profile(P([(0.192, 0.09), (0.335, 0.09), (0.335, 0.114), (0.192, 0.114)]), 0.034, 'steel_worn', bevel=0.003, seg=1)
    _rail(B, 0.196, 0.33, 0.114, width=0.021, mat='steel_worn')
    B.profile(P([(0.192, 0.040), (0.335, 0.044), (0.335, 0.09), (0.192, 0.09)]), 0.05, 'steel_worn', bevel=0.004, seg=1)
    for sx in (1, -1):
        B.profile(P([(0.196, 0.058), (0.33, 0.058), (0.33, 0.067), (0.196, 0.067)]), 0.006, 'steel_worn', x0=sx * 0.027, bevel=0.0008, seg=1)
    _rail(B, 0.20, 0.33, 0.0315, width=0.021, mat='steel_worn')
    # vertical foregrip on the bottom rail
    zf = 0.268
    B.box(C(0, 0.024, zf), (0.026, 0.012, 0.04), 'polymer', bevel=0.003)
    fg = [(zf - 0.017, 0.022), (zf + 0.017, 0.022), (zf + 0.015, -0.055), (zf + 0.012, -0.062), (zf - 0.012, -0.062), (zf - 0.015, -0.055)]
    B.profile(P(fg), 0.03, 'polymer', bevel=0.007, seg=3)
    for k in range(4):
        B.box(C(0, -0.005 - k * 0.013, zf + 0.0165), (0.024, 0.004, 0.003), 'polymer', bevel=0.001)
    _ak_mag(B)
    eye_y = _holo_sight(B, -0.035, 0.1135)
    emp = _ak_empties(mz, rear=(eye_y, -0.035), front=(eye_y, 0.06), grip_L=(0.040, 0.228),
                      extra={'optic_eye': (eye_y, -0.12), 'foregrip': (-0.02, zf)})
    tris = B.export('ak74m_optic', mats, emp, extras={'calibre': '5.45x39', 'length_m': 0.943,
                                                      'optic': 'holographic (EOTech-style) on railed dust cover', 'foregrip': True,
                                                      'sight_line_above_bore_m': round(float(eye_y - AK_BORE), 3)})
    return tris, {k: [list(map(float, v[0])), v[1]] for k, v in emp.items()}


def _ylathe(B, prof, mat, n=16, c=(0.0, 0.0)):
    """solid of revolution about +Y (gl). prof: [(y, r)]"""
    bm = bmesh.new()
    rings = []
    for y, r in prof:
        if r <= 1e-6:
            rings.append([bm.verts.new(tuple(bl.to_bl(np.array([[c[0], y, c[1]]]))[0]))]); continue
        a = np.linspace(0, 2 * np.pi, n, endpoint=False)
        Pp = np.stack([c[0] + r * np.cos(a), np.full(n, y), c[1] + r * np.sin(a)], 1)
        rings.append([bm.verts.new(tuple(p)) for p in bl.to_bl(Pp)])
    for A_, B_ in zip(rings[:-1], rings[1:]):
        if len(A_) == 1 and len(B_) == 1:
            continue
        for k in range(n):
            if len(A_) == 1:
                bm.faces.new((A_[0], B_[k], B_[(k + 1) % n]))
            elif len(B_) == 1:
                bm.faces.new((A_[k], A_[(k + 1) % n], B_[0]))
            else:
                bm.faces.new((A_[k], A_[(k + 1) % n], B_[(k + 1) % n], B_[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return B._finish(B._obj(bm, 'ylathe'), mat, 0.0, 1, 35, wn=False)


GREN_OFF = np.array([0.013, 0.0, 0.0])   # body centre relative to the palm origin (towards the fingers, +X)


def grenade_f1():
    """F-1 defensive grenade: ribbed (fragmentation-segmented) cast-iron ovoid, 55 mm, olive paint, UZRGM fuze.
    origin = grip (palm centre when held in the right hand / weapon_socket), +Y = fuze up, spoon on the palm side."""
    B = Builder()
    cx = GREN_OFF[0]
    R, Hh = 0.0275, 0.042    # radius, half height of the body (body 84 mm tall + fuze)
    yc = -0.004
    # segmented body: 8 columns x 5 rows of pyramidal lumps via a lathe with ridges + vertical grooves
    prof = []
    for t in np.linspace(-1, 1, 21):
        y = yc + t * Hh
        r = R * np.sqrt(max(1 - (t * 0.92) ** 2, 0.0)) * (1 + 0.045 * np.cos(t * 6 * np.pi))
        prof.append((y, max(r, 0.0)))
    prof[0] = (yc - Hh, 0.0); prof[-1] = (yc + Hh, 0.0)
    _ylathe(B, prof, 'olive_paint', n=32, c=(cx, 0.0))
    for k in range(8):   # vertical grooves (dark)
        a = k / 8 * 2 * np.pi
        pts = [(cx + (R * 1.002) * np.sqrt(max(1 - (t * 0.92) ** 2, 0.05)) * np.cos(a), yc + t * Hh * 0.92, (R * 1.002) * np.sqrt(max(1 - (t * 0.92) ** 2, 0.05)) * np.sin(a)) for t in np.linspace(-0.85, 0.85, 9)]
        B.strap(np.array(pts), 0.0035, 0.0012, 'fibreglass_olive_dark', up=(np.cos(a), 0, np.sin(a)))
    # base plug + fuze collar seat
    _ylathe(B, [(yc - Hh - 0.002, 0.0), (yc - Hh - 0.002, 0.008), (yc - Hh + 0.004, 0.009)], 'olive_paint', n=12, c=(cx, 0.0))
    ytop = yc + Hh
    _ylathe(B, [(ytop - 0.004, 0.0), (ytop - 0.004, 0.014), (ytop + 0.004, 0.014), (ytop + 0.004, 0.0)], 'olive_paint', n=16, c=(cx, 0.0))
    _uzrgm_at(B, cx, ytop + 0.002)
    emp = {'grip_R': (np.zeros(3), [0, 0, 0, 1]), 'centre': (np.array([cx, yc, 0.0]), [0, 0, 0, 1]),
           'fuze': (np.array([cx, ytop + 0.03, 0.0]), [0, 0, 0, 1]), 'pin_ring': (np.array([cx, ytop + 0.014, 0.03]), [0, 0, 0, 1])}
    tris = B.export('grenade_f1', mats, emp, lod_ratio=0.35, extras={'type': 'F-1 defensive fragmentation grenade', 'mass_kg': 0.6,
                                                                       'body_diameter_m': 0.055, 'length_m': 0.117, 'fuze': 'UZRGM 3.2-4.2 s'})
    return tris, {k: [list(map(float, v[0])), v[1]] for k, v in emp.items()}


def _uzrgm_at(B, cx, ytop):
    sx = -1.0
    _ylathe(B, [(ytop - 0.002, 0.0), (ytop - 0.002, 0.0125), (ytop + 0.006, 0.0125), (ytop + 0.006, 0.0095), (ytop + 0.024, 0.0095),
                (ytop + 0.026, 0.006), (ytop + 0.026, 0.0)], 'steel_worn', n=14, c=(cx, 0.0))
    pts = np.array([[cx, ytop + 0.03, 0.0], [cx + sx * 0.010, ytop + 0.031, 0.0], [cx + sx * 0.017, ytop + 0.022, 0.0],
                    [cx + sx * 0.025, ytop + 0.002, 0.0], [cx + sx * 0.030, ytop - 0.02, 0.0], [cx + sx * 0.031, ytop - 0.042, 0.0]])
    B.strap(pts, 0.014, 0.0022, 'steel_worn', up=(1, 0, 0))
    B.box((cx, ytop + 0.012, 0.012), (0.003, 0.003, 0.016), 'steel_worn', bevel=0.0)
    ring = [(cx, ytop + 0.012 + 0.011 * np.sin(a), 0.031 + 0.011 * np.cos(a)) for a in np.linspace(0, 2 * np.pi, 13)]
    B.strap(np.array(ring), 0.0025, 0.0025, 'steel_worn', up=(1, 0, 0))


def grenade_rgd5():
    """RGD-5 offensive grenade: smooth two-piece steel egg (58 mm), olive drab with a seam band, UZRGM fuze."""
    B = Builder()
    cx = GREN_OFF[0]
    R, Hh = 0.029, 0.039
    yc = -0.006
    prof = [(yc - Hh, 0.0)]
    for t in np.linspace(-0.97, 0.97, 17):
        prof.append((yc + t * Hh, R * np.sqrt(1 - t * t) ** 0.85 * (1 - 0.06 * t)))
    prof.append((yc + Hh, 0.0))
    _ylathe(B, prof, 'olive_paint', n=28, c=(cx, 0.0))
    _ylathe(B, [(yc - 0.003, 0.0), (yc - 0.003, R * 1.012), (yc + 0.003, R * 1.012), (yc + 0.003, 0.0)], 'olive_paint', n=28, c=(cx, 0.0))  # seam
    ytop = yc + Hh
    _ylathe(B, [(ytop - 0.006, 0.0), (ytop - 0.006, 0.0135), (ytop + 0.003, 0.0135), (ytop + 0.003, 0.0)], 'olive_paint', n=16, c=(cx, 0.0))
    _uzrgm_at(B, cx, ytop + 0.001)
    emp = {'grip_R': (np.zeros(3), [0, 0, 0, 1]), 'centre': (np.array([cx, yc, 0.0]), [0, 0, 0, 1]),
           'fuze': (np.array([cx, ytop + 0.03, 0.0]), [0, 0, 0, 1]), 'pin_ring': (np.array([cx, ytop + 0.013, 0.031]), [0, 0, 0, 1])}
    tris = B.export('grenade_rgd5', mats, emp, lod_ratio=0.35, extras={'type': 'RGD-5 offensive fragmentation grenade', 'mass_kg': 0.31,
                                                                         'body_diameter_m': 0.058, 'length_m': 0.114, 'fuze': 'UZRGM 3.2-4.2 s'})
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


RPG22 = dict(AXY=0.066, R_REAR=0.0400, R_FRONT=0.0435, Z_REAR=-0.462, Z_MUZZLE=0.392, EXT=0.095)


def _rpg22_parts(B, carried=False, oy=0.0, oz=0.0):
    """RPG-22 'Netto' (72.5 mm, fibreglass, telescoping).  Firing configuration 0.85 m, collapsed 0.755 m.
    gun space: origin = right hand on the tube (below the firing-mechanism housing), +Z muzzle, +Y up, +X weapon left."""
    P = RPG22
    A = P['AXY'] + oy
    Rr, Rf = P['R_REAR'], P['R_FRONT']
    ext = 0.0 if not carried else -P['EXT']
    z = lambda v: v + oz
    zf = lambda v: v + oz + ext          # parts riding on the front (extension) tube
    c = (0.0, A)
    # rear (main) tube with rear rim band; open end shows the dark bore
    B.lathe([(z(-0.43), 0.0355), (z(-0.462), 0.0355), (z(-0.462), 0.0428), (z(-0.438), 0.0428), (z(-0.436), Rr), (z(0.02), Rr)], 'fibreglass_olive', c=c, n=22)
    B.lathe([(z(-0.43), 0.0356), (z(-0.43), 0.0)], 'bore_black', c=c, n=22)
    B.lathe([(z(-0.30), Rr + 0.0006), (z(-0.29), Rr + 0.0006)], 'fibreglass_olive_dark', c=c, n=22)   # seam band
    # front extension tube (slides over the main tube): rear collar, body, front rim
    B.lathe([(zf(-0.075), Rr + 0.0004), (zf(-0.075), 0.0458), (zf(-0.052), 0.0458), (zf(-0.050), Rf), (zf(0.368), Rf), (zf(0.370), 0.0458),
             (zf(0.392), 0.0458), (zf(0.392), 0.0385), (zf(0.355), 0.0385)], 'fibreglass_olive', c=c, n=22)
    B.lathe([(zf(0.355), 0.0386), (zf(0.355), 0.0)], 'bore_black', c=c, n=22)
    B.lathe([(zf(0.17), Rf + 0.0006), (zf(0.19), Rf + 0.0006)], 'fibreglass_olive_dark', c=c, n=22)  # sling band
    # stencil markings (left side)
    B.box((Rr - 0.002, A + 0.006, z(-0.24)), (0.003, 0.012, 0.08), 'stencil_yellow', bevel=0.0)
    B.box((Rf - 0.002, A + 0.004, zf(0.07)), (0.003, 0.010, 0.05), 'stencil_yellow', bevel=0.0)
    # firing-mechanism housing on top of the main tube + trigger button + safety
    top = A + Rr
    B.profile([(z(-0.155), top - 0.012), (z(-0.035), top - 0.012), (z(-0.035), top + 0.012), (z(-0.05), top + 0.024), (z(-0.145), top + 0.024), (z(-0.155), top + 0.016)],
              0.032, 'fibreglass_olive_dark', x0=0.004, bevel=0.003, seg=2)
    B.box((0.004, top + 0.027, z(-0.062)), (0.014, 0.008, 0.016), 'rubber_black', bevel=0.002)      # trigger push-button
    B.box((0.022, top + 0.010, z(-0.10)), (0.004, 0.010, 0.030), 'rubber_black', bevel=0.001)       # safety lever (left)
    # rear sight / cocking lever (flip-up aperture frame) at the back of the housing
    if not carried:
        y0, y1 = top + 0.022, top + 0.068
        zs = z(-0.150)
        for sx in (1, -1):
            B.box((0.004 + sx * 0.012, (y0 + y1) / 2, zs), (0.004, y1 - y0, 0.004), 'fibreglass_olive_dark', bevel=0.0008)
        B.box((0.004, y1 - 0.002, zs), (0.028, 0.004, 0.004), 'fibreglass_olive_dark', bevel=0.0008)
        B.box((0.004, top + 0.040, zs), (0.028, 0.006, 0.004), 'fibreglass_olive_dark', bevel=0.0008)   # aperture plate
        B.box((0.004, top + 0.054, zs), (0.010, 0.004, 0.003), 'fibreglass_olive_dark', bevel=0.0005)
    else:
        B.box((0.004, top + 0.027, z(-0.12)), (0.028, 0.004, 0.05), 'fibreglass_olive_dark', bevel=0.0008)  # folded flat
    # front sight frame (pops up when extended)
    ftop = A + Rf
    if not carried:
        zs = zf(0.335)
        B.box((0.004, ftop + 0.002, zs), (0.032, 0.006, 0.014), 'fibreglass_olive_dark', bevel=0.001)
        for sx in (1, -1):
            B.box((0.004 + sx * 0.013, ftop + 0.026, zs), (0.004, 0.046, 0.004), 'fibreglass_olive_dark', bevel=0.0008)
        B.box((0.004, ftop + 0.048, zs), (0.030, 0.004, 0.004), 'fibreglass_olive_dark', bevel=0.0008)
        B.box((0.004, ftop + 0.024, zs), (0.003, 0.040, 0.003), 'fibreglass_olive_dark', bevel=0.0)    # post
    else:
        B.box((0.004, ftop + 0.004, zf(0.31)), (0.032, 0.004, 0.06), 'fibreglass_olive_dark', bevel=0.001)
    # sling swivels (bottom-left) + carry sling
    sw = [(0.026, A - 0.034, z(-0.445)), (0.028, A - 0.036, zf(0.18))]
    for p in sw:
        B.box(p, (0.006, 0.014, 0.018), 'rubber_black', bevel=0.001)
    a, b = np.array(sw[0]) + [0.004, -0.008, 0], np.array(sw[1]) + [0.004, -0.008, 0]
    t = np.linspace(0, 1, 11)
    sag = 0.0 if carried else 0.09
    pts = a[None] * (1 - t[:, None]) + b[None] * t[:, None]
    pts[:, 1] -= sag * 4 * t * (1 - t)
    if carried:
        pts[:, 0] += 0.006 * np.sin(np.pi * t)
    B.strap(pts, 0.025, 0.003, 'sling_webbing', up=(1, 0, 0))
    if carried:
        # rubber end covers on
        B.lathe([(z(-0.474), 0.0), (z(-0.474), 0.040), (z(-0.470), 0.0448), (z(-0.442), 0.0448), (z(-0.440), 0.0430)], 'rubber_black', c=c, n=22)
        B.lathe([(zf(0.404), 0.0), (zf(0.404), 0.042), (zf(0.400), 0.0475), (zf(0.372), 0.0475), (zf(0.370), 0.0460)], 'rubber_black', c=c, n=22)
    return A


def rpg22():
    B = Builder()
    P = RPG22
    A = _rpg22_parts(B)
    top = A + P['R_REAR']
    emp = {'muzzle': (np.array([0, A, P['Z_MUZZLE']]), [0, 0, 0, 1]),
           'rear': (np.array([0, A, P['Z_REAR']]), [0, 1, 0, 0]),
           'backblast': (np.array([0, A, P['Z_REAR']]), [0, 1, 0, 0]),
           'grip_R': (np.zeros(3), [0, 0, 0, 1]),
           'grip_L': (np.array([0.0, A - P['R_FRONT'] + 0.004, 0.19]), [0, 0, 0, 1]),
           'sight_rear': (np.array([0.004, top + 0.054, -0.150]), [0, 0, 0, 1]),
           'sight_front': (np.array([0.004, A + P['R_FRONT'] + 0.046, 0.335]), [0, 0, 0, 1]),
           'shoulder_rest': (np.array([0, A + P['R_REAR'], -0.21]), [0, 0, 0, 1])}
    tris = B.export('rpg22', mats, emp, extras={'calibre': '72.5 mm', 'length_m': 0.85, 'length_collapsed_m': 0.755, 'weight_kg': 2.8,
                                                'config': 'extended / ready to fire, end covers removed, sights up'})
    # carried / collapsed variant: separate small GLB, origin at the tube centre, +Z toward the (closed) front end
    B2 = Builder()
    zc = (P['Z_REAR'] - 0.012 + P['Z_MUZZLE'] - P['EXT'] + 0.012) / 2
    _rpg22_parts(B2, carried=True, oy=-P['AXY'], oz=-zc)
    L = (P['Z_MUZZLE'] - P['EXT'] + 0.012) - (P['Z_REAR'] - 0.012)
    emp2 = {'front_end': (np.array([0, 0, L / 2]), [0, 0, 0, 1]), 'rear_end': (np.array([0, 0, -L / 2]), [0, 1, 0, 0])}
    t2 = B2.export('rpg22_carried', mats, emp2, extras={'config': 'collapsed (transport) 0.755 m tube + covers, sights folded, sling taut',
                                                         'length_m': round(float(L), 3), 'socket': 'launcher_socket_back'})
    return tris, {k: [list(map(float, v[0])), v[1]] for k, v in emp.items()}, t2


if __name__ == '__main__':
    info = {}
    only = sys.argv[1:]
    infop = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache', 'weapons_info.json')
    if only and os.path.exists(infop):
        info = json.load(open(infop))
    for fn in (ak74m, pkm, rpg7, rpg22, ak12, ak74m_optic, grenade_f1, grenade_rgd5):
        if only and fn.__name__ not in only:
            continue
        r = fn()
        (t0, t1), emp = r[0], r[1]
        info[fn.__name__] = dict(tris=t0, tris_LOD1=t1, empties=emp)
        if len(r) > 2:
            info[fn.__name__]['carried'] = dict(file='rpg22_carried.glb', tris=r[2][0], tris_LOD1=r[2][1])
        print(fn.__name__, t0, t1)
    os.makedirs(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache'), exist_ok=True)
    json.dump(info, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache', 'weapons_info.json'), 'w'), indent=1)
