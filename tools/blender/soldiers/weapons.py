"""Weapons: AK-74M, AK-74M + side-mount collimator, AK-12, PKM, RPG-7V (+PG-7V), RPG-22, F-1 / RGD-5 grenades.
Origin at the pistol grip (palm centre), +Z = muzzle, +Y up, weapon's left side = +X.  Empties: muzzle, grip_R (identity at
origin), grip_L (support hand), sight_rear / sight_front, stock_butt (+ per-weapon extras).  The AK magazine is a separate
`magazine` node (its LOD1 is a child of it so it follows the magazine during reloads).

Every weapon is one mesh atlas: parts are tagged with a material kind (weapon_tex.K), joined, smart-unwrapped, Cycles-baked
(AO + edge mask) and textured procedurally (base colour / ORM / normal) with gun-space surface details (weapon_tex.Fx).
run: nice -n 10 python3 tools/blender/soldiers/weapons.py [names...]"""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import bpy, bmesh
from mathutils import Matrix
import bl, gltfw, tex as TX
import weapon_tex as WT
from weapon_tex import fx_dots, fx_rect, fx_line, fx_pattern, fx_text, fx_cyl_bands, Fx, frame

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../../assets/soldiers')
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache')
GROUP_IDS = {None: 0, 'magazine': 1}


def _tb(P):
    return bl.to_bl(np.asarray(P, float).reshape(-1, 3))


def rrect(w, h, r, nc=2, cx=0.0, cy=0.0, rb=None):
    """rounded rectangle polygon (x, y), CCW, w x h, corner radius r (rb: bottom corner radius)"""
    rb = r if rb is None else rb
    pts = []
    for (sx, sy, rr) in ((1, -1, rb), (1, 1, r), (-1, 1, r), (-1, -1, rb)):
        ccx, ccy = cx + sx * (w / 2 - rr), cy + sy * (h / 2 - rr)
        a0 = {(1, -1): -np.pi / 2, (1, 1): 0.0, (-1, 1): np.pi / 2, (-1, -1): np.pi}[(sx, sy)]
        if rr <= 1e-6:
            pts.append((cx + sx * w / 2, cy + sy * h / 2)); continue
        for a in np.linspace(a0, a0 + np.pi / 2, nc + 1):
            pts.append((ccx + rr * np.cos(a), ccy + rr * np.sin(a)))
    return np.array(pts)


def superell(w, h, n=16, p=3.0, cx=0.0, cy=0.0):
    a = np.linspace(0, 2 * np.pi, n, endpoint=False) - np.pi / 2
    c, s = np.cos(a), np.sin(a)
    return np.stack([cx + w / 2 * np.sign(c) * np.abs(c) ** (2 / p), cy + h / 2 * np.sign(s) * np.abs(s) ** (2 / p)], 1)


def ring_z(poly, z):
    poly = np.asarray(poly, float)
    return np.stack([poly[:, 0], poly[:, 1], np.full(len(poly), z)], 1)


def ring_frame(poly, c, u, v):
    poly = np.asarray(poly, float)
    return np.asarray(c, float)[None] + poly[:, :1] * np.asarray(u, float)[None] + poly[:, 1:2] * np.asarray(v, float)[None]


class Builder:
    def __init__(self):
        bl.reset()
        self.parts = []
        self.group = None
        self.fx = []

    # ----------------------------------------------------------------------------------------- primitives
    def _obj(self, bm, name):
        me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
        ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
        return ob

    def _finish(self, ob, kind, bevel=0.0, seg=2, angle=40, smooth=True, wn=True, uvs=1.0, clamp=True):
        assert kind in WT.K, kind
        if bevel > 0:
            m = ob.modifiers.new('bv', 'BEVEL'); m.width = bevel; m.segments = seg
            m.limit_method = 'ANGLE'; m.angle_limit = np.radians(angle); m.harden_normals = False
            m.use_clamp_overlap = clamp
        if wn:
            w = ob.modifiers.new('wn', 'WEIGHTED_NORMAL'); w.keep_sharp = True
        bl.apply_mods(ob)
        if smooth:
            ob.data.shade_smooth()
            try:
                ob.data.set_sharp_from_angle(angle=np.radians(angle))
            except Exception:
                pass
        self.parts.append(dict(ob=ob, kind=kind, grp=self.group, uvs=uvs))
        if os.environ.get('WDEBUG'):
            import traceback
            ob.name = '%s:%d' % (traceback.extract_stack()[-3].name, traceback.extract_stack()[-3].lineno)
        return ob

    def mesh(self, V, faces, kind, **kw):
        bm = bmesh.new()
        vs = [bm.verts.new(tuple(p)) for p in _tb(V)]
        for f in faces:
            try:
                bm.faces.new([vs[i] for i in f])
            except ValueError:
                pass
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        return self._finish(self._obj(bm, 'mesh'), kind, **kw)

    def loft(self, rings, kind, caps=(True, True), closed=False, **kw):
        """rings: list of (m, 3) gun-space point loops with equal m"""
        rings = [np.asarray(r, float) for r in rings]
        m = len(rings[0]); V = np.concatenate(rings)
        F = []
        nr = len(rings)
        for i in range(nr - 1 + (1 if closed else 0)):
            a, b = i * m, ((i + 1) % nr) * m
            for k in range(m):
                F.append((a + k, a + (k + 1) % m, b + (k + 1) % m, b + k))
        if not closed:
            if caps[0]:
                F.append(tuple(range(m))[::-1])
            if caps[1]:
                F.append(tuple(range((nr - 1) * m, nr * m)))
        return self.mesh(V, F, kind, **kw)

    def profile(self, pts_zy, width, kind, x0=0.0, bevel=0.002, seg=1, angle=35, **kw):
        """extrude a side-view polygon (z, y) symmetric about x0 with given width"""
        bm = bmesh.new()
        vs = [bm.verts.new(tuple(bl.to_bl(np.array([[x0 - width / 2, y, z]]))[0])) for z, y in pts_zy]
        f = bm.faces.new(vs)
        bmesh.ops.recalc_face_normals(bm, faces=[f])
        r = bmesh.ops.extrude_face_region(bm, geom=[f])
        nv = [e for e in r['geom'] if isinstance(e, bmesh.types.BMVert)]
        bmesh.ops.translate(bm, vec=(width, 0, 0), verts=nv)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        return self._finish(self._obj(bm, 'prof'), kind, bevel, seg, angle, **kw)

    def box(self, c, size, kind, bevel=0.002, seg=1, rot=None, **kw):
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
        M = np.eye(4)
        S = np.diag([size[0], size[2], size[1]])
        R = np.eye(3) if rot is None else np.asarray(rot)
        Rb = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]])
        M[:3, :3] = Rb @ R @ Rb.T @ S
        M[:3, 3] = bl.to_bl(np.array([c]))[0]
        bmesh.ops.transform(bm, matrix=Matrix(M.tolist()), verts=bm.verts[:])
        return self._finish(self._obj(bm, 'box'), kind, bevel, seg, **kw)

    def revolve(self, prof, kind, c=(0, 0, 0), axis=(0, 0, 1), ref=None, n=16, a0=0.0, angle=35, arc=None, **kw):
        """solid of revolution: prof [(t, r)] along `axis` from c (r = 0 -> pole).  arc=(a_start, a_end) for partial."""
        axis = np.asarray(axis, float); axis /= np.linalg.norm(axis)
        if ref is None:
            ref = np.array([1.0, 0, 0]) if abs(axis[0]) < 0.9 else np.array([0, 1.0, 0])
        u = np.asarray(ref, float) - axis * (np.asarray(ref, float) @ axis); u /= np.linalg.norm(u)
        v = np.cross(axis, u)
        full = arc is None
        aa = (a0 + np.linspace(0, 2 * np.pi, n, endpoint=False)) if full else np.linspace(arc[0], arc[1], n)
        V = []; rings = []
        for t, r in prof:
            base = np.asarray(c, float) + axis * t
            if r <= 1e-7:
                rings.append([len(V)]); V.append(base); continue
            idx = []
            for a in aa:
                idx.append(len(V)); V.append(base + r * (np.cos(a) * u + np.sin(a) * v))
            rings.append(idx)
        F = []
        for A, B in zip(rings[:-1], rings[1:]):
            if len(A) == 1 and len(B) == 1:
                continue
            kk = range(n) if full else range(n - 1)
            for k in kk:
                k1 = (k + 1) % n
                if len(A) == 1:
                    F.append((A[0], B[k], B[k1]))
                elif len(B) == 1:
                    F.append((A[k], A[k1], B[0]))
                else:
                    F.append((A[k], A[k1], B[k1], B[k]))
        if full:
            if len(rings[0]) > 1:
                F.append(tuple(rings[0][::-1]))
            if len(rings[-1]) > 1:
                F.append(tuple(rings[-1]))
        kw.setdefault('wn', False)
        return self.mesh(np.array(V), F, kind, angle=angle, **kw)

    def tube(self, z0, z1, r0, kind, r1=None, c=(0, 0), n=16, cap=True, a0=0.0, **kw):
        r1 = r0 if r1 is None else r1
        prof = ([(z0, 0.0)] if cap else []) + [(z0, r0), (z1, r1)] + ([(z1, 0.0)] if cap else [])
        return self.revolve(prof, kind, c=(c[0], c[1], 0.0), axis=(0, 0, 1), n=n, a0=a0, **kw)

    def cyl(self, p0, p1, r, kind, n=12, r1=None, **kw):
        p0 = np.asarray(p0, float); p1 = np.asarray(p1, float); d = p1 - p0; L = np.linalg.norm(d)
        r1 = r if r1 is None else r1
        return self.revolve([(0, 0), (0, r), (L, r1), (L, 0)], kind, c=p0, axis=d / L, n=n, **kw)

    def pipe(self, path, r, kind, n=6, closed=False, caps=True, **kw):
        path = np.asarray(path, float); m = len(path)
        T = []
        for i in range(m):
            if closed:
                d = path[(i + 1) % m] - path[i - 1]
            else:
                d = path[min(i + 1, m - 1)] - path[max(i - 1, 0)]
            T.append(d / np.linalg.norm(d))
        T = np.array(T)
        u = np.cross(T[0], [0, 1, 0]);
        if np.linalg.norm(u) < 1e-3:
            u = np.cross(T[0], [1, 0, 0])
        u /= np.linalg.norm(u)
        rings = []
        a = np.linspace(0, 2 * np.pi, n, endpoint=False)
        for i in range(m):
            u = u - T[i] * (u @ T[i]); u /= np.linalg.norm(u); v = np.cross(T[i], u)
            rr = r[i] if np.ndim(r) else r
            rings.append(path[i] + rr * (np.cos(a)[:, None] * u + np.sin(a)[:, None] * v))
        kw.setdefault('wn', False)
        return self.loft(rings, kind, caps=(caps, caps), closed=closed, **kw)

    def strap(self, pts, width, thick, kind, up=(1, 0, 0), **kw):
        pts = np.asarray(pts, float)
        rings = []
        for i, p in enumerate(pts):
            d = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]; d /= np.linalg.norm(d)
            u = np.asarray(up, float); u = u - d * (u @ d); u /= np.linalg.norm(u)
            w = np.cross(d, u)
            rings.append(np.array([p + w * width / 2 + u * thick / 2, p - w * width / 2 + u * thick / 2,
                                   p - w * width / 2 - u * thick / 2, p + w * width / 2 - u * thick / 2]))
        kw.setdefault('wn', False)
        return self.loft(rings, kind, angle=30, **kw)

    # ----------------------------------------------------------------------------------------- atlas + export
    def export(self, name, empties, extras=None, lod_ratio=0.3, res=1024, seed=1, ao_d=0.05, edge_r=0.0012,
               wear=1.0, dirt=1.0, out_name=None, mag_name='magazine'):
        t0 = time.time()
        objs = []
        if os.environ.get('WDEBUG'):
            cnt = []
            for p in self.parts:
                me = p['ob'].data; me.calc_loop_triangles(); cnt.append((len(me.loop_triangles), p['kind'], p['ob'].name, len(cnt)))
            for c in sorted(cnt, reverse=True)[:25]:
                print('   part', c)
        for p in self.parts:
            ob = p['ob']; me = ob.data; nf = len(me.polygons)
            a = me.attributes.new('kind', 'INT', 'FACE'); a.data.foreach_set('value', np.full(nf, WT.KIND_ID[p['kind']], np.int32))
            b = me.attributes.new('grp', 'INT', 'FACE'); b.data.foreach_set('value', np.full(nf, GROUP_IDS[p['grp']], np.int32))
            s = me.attributes.new('uvs', 'FLOAT', 'FACE'); s.data.foreach_set('value', np.full(nf, p['uvs'], np.float32))
            objs.append(ob)
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        ob = bpy.context.view_layer.objects.active
        _unwrap(ob)
        bk = WT.bake_ao_edge(ob, res // 2, edge_r=edge_r, ao_d=ao_d)
        m = bl.extract(ob, attrs=('kind', 'grp'))
        kind_tri = m['kind'][:, 0].astype(np.int32); grp_tri = m['grp'][:, 0].astype(np.int32)
        maps = WT.raster_maps(m['uv'], m['tri'], m['pos'], m['nrm'], kind_tri, res)
        from scipy import ndimage
        for k in ('AO', 'E', 'PT'):
            maps[k] = ndimage.zoom(bk[k], 2, order=1)
        alb, orm, nrm, st = WT.synth(maps, self.fx, seed=seed, wear_scale=wear, dirt_scale=dirt)
        out_name = out_name or name
        dbg = os.path.join(CACHE, 'wtex'); os.makedirs(dbg, exist_ok=True)
        from PIL import Image
        Image.fromarray(alb).save(f'{dbg}/{out_name}_alb.png'); Image.fromarray(nrm).save(f'{dbg}/{out_name}_nrm.png')
        Image.fromarray(orm).save(f'{dbg}/{out_name}_orm.png')
        g = gltfw.GLB()
        # ORM (AO / roughness / metal) is low-frequency: half resolution saves ~4 MB of VRAM per weapon
        orm_h = np.asarray(Image.fromarray(orm).resize((res // 2, res // 2), Image.LANCZOS))
        mat = g.material('wpn_' + out_name, color=(1, 1, 1, 1), metallic=1.0, roughness=1.0,
                         base_tex=g.image(alb, 'JPEG', 90), normal_tex=g.image(nrm, 'JPEG', 92), orm_tex=g.image(orm_h, 'JPEG', 90))
        root = g.node(out_name, extras=extras)
        tris = {}
        for gname, gid in GROUP_IDS.items():
            sel = grp_tri == gid
            if not sel.any():
                continue
            tri = m['tri'][sel]
            used, inv = np.unique(tri.reshape(-1), return_inverse=True)
            prim = dict(pos=m['pos'][used], nrm=m['nrm'][used], uv=m['uv'][used], idx=inv.reshape(-1, 3), mat=mat)
            nm = out_name + '_mesh' if gname is None else mag_name
            node = g.node(nm, parent=root, mesh=g.mesh(nm, [prim]))
            lp = _lod(ob, gid, lod_ratio)
            lp['mat'] = mat
            lname = (out_name if gname is None else mag_name) + '_LOD1'
            g.node(lname, parent=root if gname is None else node, mesh=g.mesh(lname, [lp]), extras={'lod': 1})
            tris[nm] = int(len(tri)); tris[lname] = int(len(lp['idx']))
        for en, (t, r) in empties.items():
            g.node(en, parent=root, t=t, r=r)
        os.makedirs(OUT, exist_ok=True)
        g.save(f'{OUT}/{out_name}.glb')
        print(f'  {out_name}: {tris}  texel {st["px_per_m"]:.0f} px/m, fill {st["fill"]:.2f}, {time.time() - t0:.0f}s')
        return tris, st


def _unwrap(ob, margin=0.004):
    me = ob.data
    bl.activate(ob)
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=np.radians(55), island_margin=margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode='OBJECT')
    # per-part texel-density scale (hidden / dark parts get less space)
    nf = len(me.polygons)
    s = np.zeros(nf, np.float32); me.attributes['uvs'].data.foreach_get('value', s)
    if np.any(s != 1.0):
        nl = len(me.loops)
        uv = np.zeros(nl * 2, np.float32); me.uv_layers.active.data.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
        ls = np.zeros(nf, np.int32); me.polygons.foreach_get('loop_start', ls)
        lt = np.zeros(nf, np.int32); me.polygons.foreach_get('loop_total', lt)
        fl = np.repeat(np.arange(nf), lt)
        uv *= s[fl][:, None]
        me.uv_layers.active.data.foreach_set('uv', uv.reshape(-1))
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, margin_method='FRACTION', margin=margin, shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')


def _lod(ob, gid, ratio, inset=0.0005):
    """decimated copy of one group of the joined, unwrapped object (UVs kept), pushed `inset` m inward along the normals so
    it can never poke through LOD0 if both are drawn"""
    bm = bmesh.new(); bm.from_mesh(ob.data)
    lay = bm.faces.layers.int.get('grp')
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[lay] != gid], context='FACES')
    me = bpy.data.meshes.new('lod'); bm.to_mesh(me); bm.free()
    lo = bpy.data.objects.new('lod', me); bpy.context.scene.collection.objects.link(lo)
    bl.decimate(lo, ratio)
    try:
        lo.data.set_sharp_from_angle(angle=np.radians(40))
    except Exception:
        pass
    mm = bl.extract(lo)
    bpy.data.objects.remove(lo)
    return dict(pos=mm['pos'] - mm['nrm'] * inset, nrm=mm['nrm'], uv=mm['uv'], idx=mm['tri'])


def _emp(emp):
    return {k: [list(map(float, v[0])), v[1]] for k, v in emp.items()}


# ================================================================================================= AK family
AK_GT = np.array([0.010, 0.034]); AK_GB = np.array([-0.028, -0.078])
AK_O = AK_GT + 0.42 * (AK_GB - AK_GT)     # (z, y) of the origin (pistol-grip palm centre) in profile space
AK_BORE = 0.074
XL, XR = np.array([1.0, 0, 0]), np.array([-1.0, 0, 0])
UP, DN, FW, BK = np.array([0, 1.0, 0]), np.array([0, -1.0, 0]), np.array([0, 0, 1.0]), np.array([0, 0, -1.0])


def _akP(pts):
    return [(z - AK_O[0], y - AK_O[1]) for z, y in pts]


def _akC(x, y, z):
    return (x, y - AK_O[1], z - AK_O[0])


def G(x, y, z):
    return np.array(_akC(x, y, z), float)


def Gr(poly_xy, z):
    """profile-space ring (x, y) at profile z -> gun space"""
    r = ring_z(poly_xy, z - AK_O[0]); r[:, 1] -= AK_O[1]
    return r


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


# ---------------------------------------------------------------------------------------------- patterns
def pat_dots(pitch, r):
    def f(x, y):
        yy = y / (pitch * 0.866); row = np.floor(yy)
        xx = x / pitch + 0.5 * (row % 2)
        dx = (xx - np.round(xx)) * pitch; dy = (yy - np.round(yy)) * pitch * 0.866
        d = np.sqrt(dx * dx + dy * dy)
        return np.clip(1 - d / r, 0, 1) ** 0.5
    return f


def pat_ribs(pitch, duty=0.5, axis=0):
    def f(x, y):
        t = (x if axis == 0 else y) / pitch
        s = np.abs(t - np.round(t)) * 2      # 0 centre of rib .. 1 between
        return np.clip((duty - s) / 0.25 + 0.5, 0, 1)
    return f


def pat_checker(pitch):
    def f(x, y):
        a = (x + y) / pitch; b = (x - y) / pitch
        return np.clip(1 - 2 * np.maximum(np.abs(a - np.round(a)), np.abs(b - np.round(b))) * 1.2, 0, 1) ** 0.7
    return f


def pat_stipple(seed, density=0.5):
    rng = np.random.default_rng(seed)
    def f(x, y):
        P = np.stack([x, y, np.zeros_like(x)], -1)
        n = WT.noise3(P[None], 1400.0, seed)[0]
        return WT.sstep(1 - density, 1 - density + 0.15, n)
    return f


# ---------------------------------------------------------------------------------------------- AK parts
def _ak_receiver(B, kind='enamel', side_rail=True, rear_sight=True, ribbed_cover=True, cover_rail=False):
    P, C, O, BORE = _akP, _akC, AK_O, AK_BORE
    # stamped receiver (U section, 1 mm sheet): flat sides, slightly rounded bottom corners
    rec = [(-0.104, 0.040), (-0.096, 0.036), (0.142, 0.036), (0.142, 0.090), (-0.104, 0.090)]
    B.profile(P(rec), 0.030, kind, bevel=0.0025, seg=2)
    # dust cover: inverted-U loft, rounded top, tail drops at the rear (recoil-spring button)
    zs = [-0.100, -0.093, -0.082, 0.0, 0.12, 0.134]
    rings = []
    for z in zs:
        t = np.clip((z + 0.100) / 0.018, 0, 1)
        top = 0.096 + 0.0085 * np.sqrt(t)
        w = 0.0306 if z < 0.13 else 0.0300
        poly = rrect(w, top - 0.082, 0.0105 * (0.6 + 0.4 * t), nc=3, cy=(top + 0.082) / 2, rb=0.0)
        rings.append(Gr(poly, z))
    B.loft(rings, kind, angle=40, bevel=0.0012, seg=1)
    B.cyl(G(0, 0.091, -0.103), G(0, 0.091, -0.110), 0.0045, 'steel', n=10)          # recoil-spring guide button
    if ribbed_cover:   # transverse stiffening ribs stamped into the cover
        for k in range(7):
            z = -0.075 + k * 0.026
            for sx in (1, -1):
                B.fx.append(fx_line(G(sx * 0.0153, 0.0865, z), G(sx * 0.0153, 0.0955, z), sx * XL, 0.006, depth=0.0006,
                                    kinds=[kind], profile='rib', facing=0.5))
            B.fx.append(fx_line(G(-0.009, 0.104, z), G(0.009, 0.104, z), UP, 0.006, depth=0.0006, kinds=[kind], profile='rib', facing=0.3, thick=0.006))
    # front trunnion + rear trunnion rivets, mag-well dimple, trigger-group pins (both sides)
    for sx in (1, -1):
        n = sx * XL
        xs = sx * 0.0151
        riv = [(0.118, 0.044), (0.118, 0.056), (0.131, 0.044), (0.131, 0.056), (0.136, 0.072), (-0.085, 0.047), (-0.085, 0.062),
               (-0.072, 0.047), (-0.096, 0.075)]
        B.fx += fx_dots([G(xs, y, z) for z, y in riv], 0.0024, n, depth=0.0006, kinds=[kind], wear=0.5)
        B.fx.append(fx_rect(G(xs, 0.055, 0.080), n, UP, 0.034, 0.012, depth=0.0009, kinds=[kind], radius=0.5))
        B.fx += fx_dots([G(xs, 0.060, 0.016), G(xs, 0.060, 0.044), G(xs, 0.074, 0.060)], 0.0028, n, depth=0.0005, shape='ring', kinds=[kind])
        B.fx += fx_dots([G(xs, 0.060, 0.016), G(xs, 0.060, 0.044), G(xs, 0.074, 0.060)], 0.0016, n, depth=0.0003, kinds=[kind],
                        col='#55585a', colA=0.7)
        # receiver rails (top edge seam under the cover) + the bolt-carrier guide line
        B.fx.append(fx_line(G(xs, 0.0885, -0.10), G(xs, 0.0885, 0.14), n, 0.0012, depth=0.0004, kinds=[kind]))
    # ejection port (right): dark recess with the bolt carrier showing
    B.fx.append(fx_rect(G(-0.0151, 0.078, 0.064), XR, UP, 0.082, 0.020, depth=0.0035, kinds=[kind], col='#0a0a0a', colA=0.9, radius=0.15, edge=0.08))
    B.fx.append(fx_rect(G(-0.0151, 0.0795, 0.052), XR, UP, 0.056, 0.011, depth=0.0, mode='flat', kinds=[kind], col='#77797b', colA=0.95, metal=1.0, rough=0.3, edge=0.25))
    B.fx.append(fx_line(G(-0.0151, 0.0795, 0.026), G(-0.0151, 0.0795, 0.078), XR, 0.0016, depth=0.0004, kinds=[kind], col='#2a2a2a', colA=0.8, facing=0.5))
    # serial + year stamped on the left above the trigger group, arsenal triangle
    B.fx.append(fx_text('1998  № 7845321', G(0.0151, 0.047, 0.03), XL, UP, 0.0034, col='#9a9c9c', colA=0.35, depth=-0.00012, kinds=[kind]))
    B.fx.append(fx_text('∆', G(0.0151, 0.071, -0.03), XL, UP, 0.004, col='#9a9c9c', colA=0.3, depth=-0.0001, kinds=[kind]))
    # selector markings (right side, under the lever)
    B.fx.append(fx_text('АВ', G(-0.0151, 0.064, 0.050), XR, UP, 0.0045, col='#c8c6be', colA=0.7, depth=-0.00012, kinds=[kind]))
    B.fx.append(fx_text('ОД', G(-0.0151, 0.056, 0.074), XR, UP, 0.0045, col='#c8c6be', colA=0.7, depth=-0.00012, kinds=[kind]))
    # charging handle (on the bolt carrier, right, front of the port) + knob
    B.box(C(-0.0185, 0.0815, 0.106), (0.010, 0.006, 0.010), 'bare', bevel=0.0012, seg=1)
    B.revolve([(0, 0), (0, 0.0042), (0.006, 0.0050), (0.010, 0.0045), (0.012, 0.0), ], 'bare', c=G(-0.022, 0.0815, 0.106), axis=XR, n=10)
    # selector lever (right): long stamped plate pivoting at the rear, finger tab at the front
    sel = [(-0.074, 0.084), (-0.06, 0.086), (0.06, 0.077), (0.074, 0.074), (0.078, 0.064), (0.071, 0.062), (0.06, 0.068), (-0.06, 0.076), (-0.074, 0.076)]
    B.profile(P(sel), 0.0022, 'steel', x0=-0.0163, bevel=0.0006, seg=1)
    B.revolve([(0, 0), (0, 0.0055), (0.0018, 0.0052), (0.0026, 0.0)], 'steel', c=G(-0.0172, 0.080, -0.07), axis=XR, n=12)
    B.fx.append(fx_pattern(G(-0.0175, 0.068, 0.073), XR, UP, 0.006, 0.008, pat_ribs(0.0016, 0.5, 1), depth=0.0003, kinds=['steel'], facing=0.6))
    # magazine catch (paddle) between mag and trigger guard
    B.profile(P([(0.050, 0.036), (0.058, 0.036), (0.058, 0.026), (0.052, 0.012), (0.046, 0.012), (0.048, 0.026)]), 0.016, 'steel', bevel=0.001, seg=1)
    if side_rail:   # 'Warsaw' side dovetail rail (left), riveted
        r = [(-0.064, 0.058), (0.052, 0.058), (0.056, 0.061), (0.056, 0.083), (0.052, 0.086), (-0.064, 0.086), (-0.068, 0.083), (-0.068, 0.061)]
        B.profile(P(r), 0.0025, kind, x0=0.0162, bevel=0.0006, seg=1)
        B.profile(P([(-0.064, 0.062), (0.052, 0.062), (0.052, 0.082), (-0.064, 0.082)]), 0.0025, kind, x0=0.0185, bevel=0.0008, seg=1)
        B.fx += fx_dots([G(0.0175, 0.072, z) for z in (-0.06, -0.005, 0.048)], 0.0022, XL, depth=0.0005, kinds=[kind])
        B.fx.append(fx_line(G(0.0198, 0.072, -0.063), G(0.0198, 0.072, 0.051), XL, 0.0018, depth=0.0005, kinds=[kind]))
    # rear sight block on the front trunnion, tangent leaf, slider, notch
    if rear_sight:
        B.profile(P([(0.140, 0.064), (0.205, 0.064), (0.205, 0.098), (0.196, 0.104), (0.160, 0.106), (0.140, 0.102)]), 0.028, 'steel', bevel=0.002)
        for sx in (1, -1):   # leaf spring housing walls
            B.profile(P([(0.150, 0.100), (0.198, 0.100), (0.198, 0.108), (0.150, 0.110)]), 0.003, 'steel', x0=sx * 0.0105, bevel=0.0007, seg=1)
        B.profile(P([(0.150, 0.1075), (0.198, 0.1045), (0.198, 0.1075), (0.150, 0.1105)]), 0.015, 'steel', bevel=0.0006, seg=1)  # leaf
        B.profile(P([(0.147, 0.106), (0.153, 0.106), (0.153, 0.1185), (0.147, 0.1185)]), 0.015, 'steel', bevel=0.0006, seg=1)  # notch plate
        B.fx.append(fx_rect(G(0, 0.1170, 0.1535), FW, UP, 0.003, 0.0035, depth=0.0008, kinds=['steel'], col='#050505', colA=0.9, radius=0.0, facing=0.5))
        B.fx.append(fx_rect(G(0, 0.1170, 0.1465), BK, UP, 0.003, 0.0035, depth=0.0008, kinds=['steel'], col='#050505', colA=0.9, radius=0.0, facing=0.5))
        B.box(C(0, 0.1095, 0.176), (0.019, 0.0055, 0.008), 'steel', bevel=0.001, seg=1)                                    # range slider
        for sx in (1, -1):
            B.fx += [fx_text(t, G(sx * 0.0075, 0.1092, z), sx * XL, UP, 0.0017, col='#d8d6cc', colA=0.8, kinds=['steel'], facing=0.5)
                     for t, z in (('3', 0.168), ('5', 0.184), ('8', 0.192))]
        # gas-tube lock lever (right)
        B.profile(P([(0.186, 0.100), (0.204, 0.098), (0.205, 0.104), (0.188, 0.106)]), 0.003, 'steel', x0=-0.0152, bevel=0.0006, seg=1)
    else:
        B.profile(P([(0.140, 0.064), (0.205, 0.064), (0.205, 0.098), (0.198, 0.102), (0.140, 0.102)]), 0.028, 'steel', bevel=0.002)
    # bottom: trigger-guard rivets on the receiver floor
    B.fx += fx_dots([G(0, 0.036, z) for z in (-0.06, -0.015)], 0.0025, DN, depth=0.0005, kinds=[kind])


def _ak_barrel(B, brake='ak74', front_sight=True, gas_vents=True, cleaning_rod=True, front_swivel=True):
    P, C, O, BORE = _akP, _akC, AK_O, AK_BORE
    zo = O[0]; yb = BORE - O[1]
    B.revolve([(0.140, 0), (0.140, 0.0112), (0.215, 0.0108), (0.36, 0.0102), (0.50, 0.0098), (0.535, 0.0098), (0.535, 0)], 'steel',
              c=(0, yb, -zo), axis=(0, 0, 1), n=10)
    # gas block (90 deg): barrel collar + riser + piston housing, rounded front cap
    B.tube(0.336 - zo, 0.372 - zo, 0.0142, 'steel', c=(0, yb), n=12)
    B.profile(P([(0.338, 0.076), (0.370, 0.076), (0.370, 0.101), (0.338, 0.101)]), 0.016, 'steel', bevel=0.0015)
    B.revolve([(0.330, 0), (0.330, 0.0108), (0.366, 0.0108), (0.372, 0.0092), (0.376, 0.0050), (0.377, 0)], 'steel',
              c=(0, 0.101 - O[1], -zo), axis=(0, 0, 1), n=10)
    B.fx += fx_dots([G(0, 0.101 + 0.0105, 0.35)], 0.0018, UP, depth=0.0003, shape='ring', kinds=['steel'])
    # gas tube (exposed front part shows vent holes; rear under the upper handguard)
    B.tube(0.196 - zo, 0.336 - zo, 0.0092, 'steel', c=(0, 0.101 - O[1]), n=10)
    if gas_vents:
        for sx in (1, -1):
            B.fx += fx_dots([G(sx * 0.0064, 0.101 + 0.0064, z) for z in (0.3265, 0.3315)], 0.0016, np.array([sx, 1, 0]) / 1.414, depth=0.0012,
                            shape='hole', kinds=['steel'], col='#050505', colA=0.95, facing=0.6)
    if front_swivel:   # front sling swivel on the left of the gas block
        B.box(C(0.0145, 0.080, 0.354), (0.005, 0.008, 0.014), 'steel', bevel=0.0012, seg=1)
        sw = [G(0.0175, 0.078 - 0.0105 * np.cos(a), 0.354 + 0.0105 * np.sin(a)) for a in np.linspace(-1.9, 1.9, 9)]
        B.pipe(sw, 0.0016, 'steel', n=6)
    # handguard retainer band (front of the lower handguard)
    B.revolve([(0.3335, 0), (0.3335, 0.0215), (0.3365, 0.0230), (0.3415, 0.0230), (0.3435, 0.0205), (0.3435, 0)], 'steel',
              c=(0, 0.066 - O[1], -zo), axis=(0, 0, 1), n=14, a0=np.pi / 14)
    if front_sight:
        B.tube(0.494 - zo, 0.531 - zo, 0.0132, 'steel', c=(0, yb), n=12)
        B.profile(P([(0.497, 0.080), (0.529, 0.080), (0.529, 0.093), (0.524, 0.101), (0.502, 0.101), (0.497, 0.094)]), 0.017, 'steel', bevel=0.0015)
        for sx in (1, -1):   # protective ears, open top
            B.profile(P([(0.505, 0.096), (0.527, 0.096), (0.526, 0.112), (0.521, 0.1335), (0.512, 0.1335), (0.507, 0.112)]), 0.0028, 'steel',
                      x0=sx * 0.0074, bevel=0.0007, seg=1)
        B.cyl(G(0, 0.099, 0.517), G(0, 0.1305, 0.517), 0.0013, 'steel', n=8, r1=0.0011)            # post (tip = sight_front)
        B.cyl(G(0, 0.099, 0.517), G(0, 0.104, 0.517), 0.0035, 'steel', n=10)                          # post drum
        B.profile(P([(0.502, 0.060), (0.526, 0.060), (0.524, 0.050), (0.506, 0.050)]), 0.012, 'steel', bevel=0.0012, seg=1)  # bayonet lug
    if cleaning_rod:
        B.cyl(G(0, 0.0545, 0.345), G(0, 0.0545, 0.534), 0.0030, 'steel', n=8)
        B.revolve([(0, 0), (0, 0.0040), (0.010, 0.0040), (0.012, 0)], 'steel', c=G(0, 0.0545, 0.528), axis=FW, n=8)
    mz = 0.615
    if brake == 'ak74':
        # two-chamber AK-74 brake: big side windows, asymmetric crown slots, compensator holes
        B.revolve([(0.528, 0), (0.528, 0.0118), (0.534, 0.0125), (0.606, 0.0125), (0.611, 0.0118), (0.615, 0.0102), (0.615, 0.0048),
                   (0.6, 0.0048), (0.6, 0.0)], 'steel', c=(0, yb, -zo), axis=(0, 0, 1), n=14, a0=np.pi / 14)
        for sx in (1, -1):
            B.fx.append(fx_rect(G(sx * 0.0125, BORE, 0.5585), sx * XL, UP, 0.011, 0.0135, depth=0.004, kinds=['steel'], col='#040404', colA=0.97,
                                radius=0.5, edge=0.1, facing=0.4))
        B.fx.append(fx_rect(G(0, BORE + 0.0125, 0.5875), UP, FW, 0.010, 0.006, depth=0.0035, kinds=['steel'], col='#050505', colA=0.95, radius=0.9, facing=0.4))
        B.fx += fx_dots([G(-0.0063, BORE + 0.0108, z) for z in (0.597, 0.604)], 0.0016, np.array([-0.5, 0.866, 0]), depth=0.002, shape='hole',
                        kinds=['steel'], col='#050505', colA=0.95, facing=0.6)
        B.fx.append(fx_rect(G(0, BORE, 0.6152), FW, UP, 0.0095, 0.0095, depth=0.003, kinds=['steel'], col='#030303', colA=0.98, radius=1.0, facing=0.6))
        for sx in (1, -1):
            B.fx.append(fx_rect(G(sx * 0.0085, BORE, 0.6145), FW, UP, 0.004, 0.012, depth=0.003, kinds=['steel'], col='#050505', colA=0.95, radius=0.5, facing=0.6))
    else:   # AK-12 (2020): longer cylindrical two-chamber brake, 3 pairs of side ports + top ports
        B.revolve([(0.528, 0), (0.528, 0.0125), (0.534, 0.0138), (0.621, 0.0138), (0.626, 0.0128), (0.630, 0.0112), (0.630, 0.0052),
                   (0.62, 0.0052), (0.62, 0.0)], 'steel', c=(0, yb, -zo), axis=(0, 0, 1), n=14, a0=np.pi / 14)
        for sx in (1, -1):
            for z in (0.556, 0.576, 0.596):
                B.fx.append(fx_rect(G(sx * 0.0138, BORE, z), sx * XL, UP, 0.0085, 0.012, depth=0.004, kinds=['steel'], col='#040404', colA=0.97, radius=0.6, facing=0.4))
        B.fx += fx_dots([G(0, BORE + 0.0138, z) for z in (0.606, 0.613)], 0.0018, UP, depth=0.002, shape='hole', kinds=['steel'], col='#050505', colA=0.95, facing=0.6)
        B.fx.append(fx_rect(G(0, BORE, 0.6302), FW, UP, 0.0105, 0.0105, depth=0.003, kinds=['steel'], col='#030303', colA=0.98, radius=1.0, facing=0.6))
        B.fx.append(fx_line(G(0, BORE - 0.0139, 0.535), G(0, BORE - 0.0139, 0.545), DN, 0.003, depth=0.0006, kinds=['steel'], profile='rib'))
        mz = 0.63
    return mz


def _ak_grip(B, kind='plum', style='ak74m'):
    """pistol grip (horizontal superellipse sections along a back-raked axis) + trigger guard + trigger"""
    P, C = _akP, _akC
    if style == 'ak74m':
        lv = [(0.036, 0.012, 0.046, 0.0275), (0.026, 0.009, 0.045, 0.0285), (0.006, 0.003, 0.042, 0.0295), (-0.025, -0.004, 0.040, 0.0298),
              (-0.055, -0.011, 0.040, 0.0295), (-0.075, -0.016, 0.041, 0.029), (-0.083, -0.018, 0.040, 0.0275), (-0.087, -0.019, 0.034, 0.022)]
    else:   # AK-12 2020: slimmer straight grip
        lv = [(0.036, 0.012, 0.042, 0.026), (0.026, 0.009, 0.041, 0.0265), (0.0, 0.002, 0.038, 0.027), (-0.04, -0.008, 0.037, 0.027),
              (-0.075, -0.016, 0.038, 0.027), (-0.084, -0.018, 0.037, 0.025), (-0.088, -0.019, 0.032, 0.020)]
    rings = []
    for y, zc, d, w in lv:
        e = superell(w, d, n=14, p=2.6)          # (x, z) section
        r = np.stack([e[:, 0], np.full(len(e), y - AK_O[1]), e[:, 1] + zc - AK_O[0]], 1)
        rings.append(r)
    B.loft(rings, kind, angle=50, bevel=0.0, wn=False)
    # moulded texture: vertical ribs at the back strap, stipple panels on the sides
    for sx in (1, -1):
        B.fx.append(fx_pattern(G(sx * 0.0148, -0.030, -0.004), sx * XL, np.array([0, 1, -0.24]), 0.024, 0.074, pat_stipple(7 + sx, 0.45),
                               depth=0.0003, kinds=[kind], facing=0.5))
        B.fx.append(fx_rect(G(sx * 0.0149, -0.030, -0.004), sx * XL, np.array([0, 1, -0.24]), 0.026, 0.076, depth=0.0003, mode='frame', kinds=[kind], facing=0.5, radius=0.6))
    B.fx.append(fx_pattern(G(0, -0.035, -0.026), np.array([0, 0.24, -1]), UP, 0.016, 0.08, pat_ribs(0.0028, 0.45, 0), depth=0.00045, kinds=[kind], facing=0.4))
    # stamped trigger guard (front ends in the mag-catch housing) + trigger blade
    tg = [(0.010, 0.036), (0.060, 0.036), (0.060, 0.030), (0.050, 0.008), (0.040, 0.002), (0.018, 0.000), (0.012, 0.006), (0.018, 0.0055),
          (0.039, 0.0075), (0.048, 0.012), (0.054, 0.030), (0.010, 0.030)]
    B.profile(P(tg), 0.0085, 'steel', bevel=0.0012, seg=1, angle=50)
    B.profile(P([(0.032, 0.034), (0.038, 0.034), (0.036, 0.020), (0.031, 0.011), (0.027, 0.011), (0.030, 0.020)]), 0.005, 'steel', bevel=0.0008, seg=1)


def _ak_mag(B, kind='mag_plum', ribs=True):
    """30-round 5.45 polymer magazine on the 'magazine' node: curved loft with front/rear spines, top stop-rib, floorplate"""
    B.group = 'magazine'
    zf, yf = 0.098, 0.034
    cc = np.array([0.40, 0.03]); R1 = np.linalg.norm(np.array([zf, yf]) - cc); R2 = R1 + 0.040
    a0 = np.arctan2(yf - cc[1], zf - cc[0]); a1 = a0 + 0.62
    aa = np.linspace(a0 - 0.012, a1, 10)
    rings = []
    for i, a in enumerate(aa):
        t = i / (len(aa) - 1)
        rad = np.array([np.cos(a), np.sin(a)]); tang = np.array([-np.sin(a), np.cos(a)])
        r_in = R1 - 0.0005 * t; r_out = R2 - 0.002 * t
        w = 0.0262 + (0.0015 if 0.12 < t < 0.2 else 0.0)        # horizontal stop rib near the top
        # section in (x, radial) with spine bumps front/back
        sec = [(-w / 2, 0.003), (-w / 2 + 0.003, 0.0), (-0.004, 0.0), (-0.0025, -0.0018), (0.0025, -0.0018), (0.004, 0.0), (w / 2 - 0.003, 0.0),
               (w / 2, 0.003), (w / 2, r_out - r_in - 0.003), (w / 2 - 0.004, r_out - r_in), (0.003, r_out - r_in), (0.002, r_out - r_in + 0.0015),
               (-0.002, r_out - r_in + 0.0015), (-0.003, r_out - r_in), (-w / 2 + 0.004, r_out - r_in), (-w / 2, r_out - r_in - 0.003)]
        pr = cc + rad * r_in   # front face point (profile); +rad points to the back of the magazine
        ring = []
        for x, d in sec:
            zy = pr + rad * d
            ring.append(G(x, zy[1], zy[0]))
        rings.append(np.array(ring)[::-1])
    B.loft(rings, kind, angle=38, bevel=0.0, wn=False)
    # floorplate (slightly larger, flat) + catch tab
    a = a1; rad = np.array([np.cos(a), np.sin(a)]); tang = np.array([-np.sin(a), np.cos(a)])
    fp = []
    for dt in (0.0, -0.006):
        pc = cc + rad * ((R1 + R2) / 2) + tang * (-dt)
        sec = rrect(0.0286, 0.0445, 0.004, nc=2)
        fp.append(np.array([G(x, (pc + rad * r)[1], (pc + rad * r)[0]) for x, r in sec]))
    B.loft(fp, kind, angle=40, bevel=0.0008, seg=1)
    # feed lips / follower (steel) peeking at the top + locking lugs
    B.box(_akC(0, 0.039, 0.078), (0.016, 0.006, 0.034), 'steel', bevel=0.0008, seg=1)
    B.box(_akC(0, 0.037, 0.0975), (0.012, 0.006, 0.004), kind, bevel=0.0008, seg=1)
    if ribs:   # moulded side ribs following the curvature
        for sx in (1, -1):
            for f in (0.22, 0.78):
                pts = []
                for a in np.linspace(a0 + 0.12, a1 - 0.03, 7):
                    rad = np.array([np.cos(a), np.sin(a)]); q = cc + rad * (R1 + (R2 - R1) * f)
                    pts.append(G(sx * 0.0131, q[1], q[0]))
                for p0, p1 in zip(pts[:-1], pts[1:]):
                    B.fx.append(fx_line(p0, p1, sx * XL, 0.0035, depth=0.0006, kinds=[kind], profile='rib', facing=0.6))
    # mould marks on the side
    for sx in (1, -1):
        a = a0 + 0.36; rad = np.array([np.cos(a), np.sin(a)]); q = cc + rad * (R1 + 0.02)
        B.fx.append(fx_text('6Л23', G(sx * 0.0131, q[1], q[0]), sx * XL, UP, 0.0035,
                            col='#000000', colA=0.0, depth=0.00025, kinds=[kind], facing=0.6))
    B.group = None


def _ak74_furniture(B, kind='plum', handguards=True, stock=True, lower=True):
    P, C, O = _akP, _akC, AK_O
    if handguards:
        if lower:   # lower handguard: U section with 4 lengthwise grip ribs per side
            def sec(w, ybot, ytop, rib=0.0012):
                half = w / 2
                pts = [(0.0, ybot)]
                for a in np.linspace(-np.pi / 2, 0, 4)[1:]:
                    pts.append((half * 0.62 * np.cos(a) + 0.0, ybot + 0.012 * (1 + np.sin(a))))
                ys = np.linspace(ybot + 0.013, ytop - 0.004, 7)
                for k, y in enumerate(ys):
                    pts.append((half + (rib if k % 2 == 1 else 0.0), y))
                pts.append((half - 0.002, ytop)); pts.append((0.0, ytop))
                right = [(-x, y) for x, y in pts[1:-1]][::-1]
                return np.array(pts[:-1] + [pts[-1]] + right)
            rings = []
            for z, w, yb in ((0.204, 0.040, 0.047), (0.212, 0.0445, 0.0445), (0.29, 0.0455, 0.0440), (0.326, 0.044, 0.0445), (0.334, 0.041, 0.047)):
                s = sec(w, yb, 0.090)
                rings.append(Gr(s[::-1], z))
            B.loft(rings, kind, angle=55, bevel=0.0, wn=False)
            B.fx.append(fx_rect(G(0, 0.0442, 0.265), DN, FW, 0.016, 0.10, depth=0.0005, kinds=[kind], radius=0.8, facing=0.6))
        # upper handguard over the gas tube: round top, 3 lengthwise finger grooves per side
        rings = []
        for z, w, h in ((0.204, 0.030, 0.026), (0.212, 0.034, 0.028), (0.31, 0.034, 0.028), (0.322, 0.031, 0.025)):
            poly = rrect(w, h, 0.0145, nc=3, cy=0.090 + h / 2, rb=0.0)
            rings.append(Gr(poly, z))
        B.loft(rings, kind, angle=50, bevel=0.0, wn=False)
        for sx in (1, -1):
            for y in (0.098, 0.106):
                B.fx.append(fx_line(G(sx * 0.0165, y, 0.222), G(sx * 0.0165, y, 0.302), np.array([sx, 0.3 * (y - 0.098) / 0.008, 0]), 0.003, depth=0.0006,
                                    kinds=[kind], facing=0.4))
    if stock:
        _ak74m_stock(B, kind)


def _ak74m_stock(B, kind):
    P, C, O = _akP, _akC, AK_O
    # stock hinge block (steel) at the receiver rear, hinge pin on the left, folding latch button
    B.profile(P([(-0.104, 0.042), (-0.104, 0.088), (-0.121, 0.088), (-0.121, 0.042)]), 0.0315, 'steel', bevel=0.0015)
    B.cyl(G(0.0165, 0.046, -0.114), G(0.0165, 0.086, -0.114), 0.0040, 'steel', n=10)
    B.revolve([(0, 0), (0, 0.0042), (0.0035, 0.0040), (0.004, 0)], 'steel', c=G(0.0152, 0.076, -0.094), axis=XL, n=10)
    # rear sling swivel (left, on the hinge block)
    sw = [G(0.0205, 0.050 - 0.009 * np.cos(a), -0.110 + 0.009 * np.sin(a)) for a in np.linspace(-2.0, 2.0, 9)]
    B.pipe(sw, 0.0015, 'steel', n=6)
    # solid polymer side-folding stock: loft along z
    st = [(-0.121, 0.0300, 0.0870, 0.0425, 0.005), (-0.13, 0.0310, 0.0875, 0.040, 0.006), (-0.17, 0.0335, 0.0880, 0.024, 0.008),
          (-0.23, 0.0350, 0.0870, 0.0, 0.010), (-0.29, 0.0365, 0.0860, -0.026, 0.011), (-0.325, 0.0375, 0.0855, -0.040, 0.011),
          (-0.334, 0.0375, 0.0855, -0.0425, 0.010)]
    rings = []
    for z, w, yt, yb, rr in st:
        rings.append(Gr(rrect(w, yt - yb, rr, nc=2, cy=(yt + yb) / 2), z))
    B.loft(rings, kind, angle=40)
    for sx in (1, -1):
        B.fx.append(fx_rect(G(sx * 0.018, 0.040, -0.245), sx * XL, np.array([0, 1, 0.33]), 0.100, 0.030, depth=0.0018, kinds=[kind], radius=0.9, edge=0.3))
    # butt plate with trap door, horizontal ribs
    B.profile(P([(-0.333, -0.045), (-0.333, 0.088), (-0.343, 0.088), (-0.344, 0.08), (-0.345, -0.038), (-0.343, -0.045)]), 0.0395, kind, bevel=0.0025, seg=2)
    B.fx.append(fx_pattern(G(0, 0.022, -0.3445), BK, UP, 0.034, 0.12, pat_ribs(0.004, 0.45, 1), depth=0.0005, kinds=[kind], facing=0.6))
    B.fx.append(fx_rect(G(0, 0.052, -0.3448), BK, UP, 0.026, 0.026, depth=0.0005, mode='frame', kinds=[kind], facing=0.6, radius=0.3))
    # stock folding hook (left front)
    B.profile(P([(-0.135, 0.070), (-0.124, 0.070), (-0.124, 0.080), (-0.135, 0.080)]), 0.005, 'steel', x0=0.0175, bevel=0.0008, seg=1)




def spline(pts, n=24):
    """Catmull-Rom through pts (open), ~n samples"""
    Pp = np.asarray(pts, float); Pp = np.vstack([2 * Pp[0] - Pp[1], Pp, 2 * Pp[-1] - Pp[-2]])
    out = []; per = max(n // (len(Pp) - 3), 2)
    for i in range(1, len(Pp) - 2):
        p0, p1, p2, p3 = Pp[i - 1:i + 3]
        for t in np.linspace(0, 1, per, endpoint=False):
            out.append(0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    out.append(Pp[-2])
    return np.array(out)


def rot_cols(ez, ex):
    ez = np.asarray(ez, float); ez /= np.linalg.norm(ez)
    ex = np.asarray(ex, float); ex = ex - ez * (ex @ ez); ex /= np.linalg.norm(ex)
    return np.stack([ex, np.cross(ez, ex), ez], 1)


def Rx(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def _sling(B, pts, width=0.020, kind='webbing', up=(1, 0, 0), n=14, buckle=0.3):
    """2-point sling cinched along the gun: strap through gun-space control points + slider buckle"""
    path = spline(pts, n)
    B.strap(path, width, 0.0022, kind, up=up, uvs=0.5)
    k = int(len(path) * buckle); d = path[k + 1] - path[k - 1]
    B.box(path[k] + np.asarray(up) * 0.0018, (0.0032, width + 0.004, 0.011), 'steel_dark', bevel=0.0008, seg=1, rot=rot_cols(d, up))
    for kk in (1, len(path) - 2):   # sewn loops at the swivels
        d = path[kk + 1] - path[kk - 1]
        B.box(path[kk] + np.asarray(up) * 0.0012, (0.0030, width * 0.92, 0.026), kind, bevel=0.0006, seg=1, rot=rot_cols(d, up), uvs=0.5)


RAIL_SEC = np.array([(-0.0080, 0), (0.0080, 0), (0.0080, 0.0025), (0.0106, 0.0051), (0.0106, 0.0067), (0.0082, 0.0093),
                     (-0.0082, 0.0093), (-0.0106, 0.0067), (-0.0106, 0.0051), (-0.0080, 0.0025)])


def _rail(B, x, y, z0, z1, kind='alu', slots=True, down=False, step=0.01):
    """Picatinny rail along gun-space z (z0 < z1), base centre at gun-space (x, y); down=True hangs under a surface"""
    s = RAIL_SEC * [1, -1 if down else 1]
    if down:
        s = s[::-1]
    B.loft([ring_z(s + [x, y], z) for z in (z0, z1)], kind, bevel=0.0006, seg=1, angle=30)
    yt = y + (-0.0093 if down else 0.0093)
    if slots:
        for z in np.arange(z0 + 0.007, z1 - 0.004, step):
            B.fx.append(fx_rect((x, yt, z), DN if down else UP, FW, 0.03, 0.0052, depth=0.0028, kinds=[kind], facing=None, radius=0.0,
                                edge=0.05, col='#0c0c0c', colA=0.5, thick=0.0042))


# ---------------------------------------------------------------------------------------------- AK-74M
def ak74m():
    """AK-74M (6P20): plum polymer furniture, ribbed dust cover, side rail, AK-74 brake, cleaning rod, sling"""
    B = Builder()
    _ak_receiver(B)
    mz = _ak_barrel(B)
    _ak_grip(B, 'plum')
    _ak74_furniture(B, 'plum')
    _ak_mag(B, 'mag_plum')
    _sling(B, [G(0.0192, 0.0705, 0.354), G(0.0262, 0.052, 0.30), G(0.0262, 0.043, 0.21), G(0.0215, 0.038, 0.12), G(0.0222, 0.040, 0.0),
               G(0.0215, 0.0415, -0.108)])
    emp = _ak_empties(mz)
    tris, st = B.export('ak74m', emp, extras={'calibre': '5.45x39', 'length_m': 0.943})
    return tris, _emp(emp), st


# ---------------------------------------------------------------------------------------------- AK-74M + side-mount collimator
def _side_mount_kobra(B):
    P, C = _akP, _akC
    # quick-detach side mount clamped on the left dovetail rail, riser arm and bridge over the dust cover
    B.profile(P([(-0.052, 0.057), (0.042, 0.057), (0.042, 0.089), (-0.052, 0.089)]), 0.007, 'alu', x0=0.0233, bevel=0.0012)
    B.profile(P([(-0.040, 0.061), (0.022, 0.063), (0.026, 0.069), (0.022, 0.073), (-0.040, 0.071)]), 0.004, 'alu', x0=0.0288, bevel=0.0009, seg=1)
    B.revolve([(0, 0), (0, 0.0062), (0.003, 0.0060), (0.0042, 0.0)], 'alu', c=G(0.0303, 0.067, 0.030), axis=XL, n=8)
    B.fx += fx_dots([G(0.0268, 0.082, z) for z in (-0.045, 0.035)], 0.0022, XL, depth=0.0004, shape='ring', kinds=['alu'])
    B.profile(P([(-0.048, 0.088), (0.036, 0.088), (0.036, 0.111), (0.030, 0.124), (-0.042, 0.124), (-0.048, 0.111)]), 0.006, 'alu', x0=0.0228, bevel=0.0012)
    B.box(C(0.0055, 0.1185, -0.006), (0.0385, 0.011, 0.07), 'alu', bevel=0.0015)
    # Kobra-style collimator: low emitter housing, tall forward frame with a tilted tinted window, hood, rotary knob (right)
    B.profile(P([(-0.045, 0.124), (0.040, 0.124), (0.040, 0.142), (-0.030, 0.142), (-0.045, 0.136)]), 0.034, 'alu', bevel=0.003, seg=2)
    for sx in (1, -1):
        B.profile(P([(0.026, 0.130), (0.068, 0.130), (0.068, 0.140), (0.060, 0.186), (0.046, 0.188), (0.034, 0.150), (0.026, 0.142)]), 0.0045, 'alu',
                  x0=sx * 0.0165, bevel=0.0012, seg=1)
    B.box(C(0, 0.186, 0.054), (0.0375, 0.005, 0.020), 'alu', bevel=0.0015, rot=Rx(-0.15))
    B.box(C(0, 0.160, 0.052), (0.0300, 0.046, 0.0025), 'glass_amber', bevel=0.0, rot=Rx(0.26), uvs=0.5)
    B.box(C(0, 0.143, 0.040), (0.006, 0.004, 0.010), 'glass', bevel=0.0008, seg=1, uvs=0.5)              # emitter window
    B.revolve([(0, 0), (0, 0.0085), (0.009, 0.0085), (0.010, 0.0075), (0.0105, 0.0)], 'rubber', c=G(-0.017, 0.134, -0.014), axis=XR, n=10)
    B.fx.append(fx_pattern(G(-0.0225, 0.134, -0.014), XR, UP, 0.017, 0.017, pat_ribs(0.0016, 0.5, 0), depth=0.0003, kinds=['rubber'], facing=None))
    B.fx.append(fx_text('КОБРА', G(0.0172, 0.1335, -0.005), XL, UP, 0.0045, col='#d8d4c6', colA=0.85, kinds=['alu']))
    return 0.160


def _foregrip(B, zf, kind='polymer'):
    rings = []
    for y, d, w in ((0.0355, 0.036, 0.030), (0.020, 0.032, 0.0285), (-0.02, 0.030, 0.0275), (-0.05, 0.031, 0.028), (-0.058, 0.030, 0.027), (-0.062, 0.022, 0.020)):
        e = superell(w, d, n=10, p=2.4)
        rings.append(np.stack([e[:, 0], np.full(len(e), y - AK_O[1]), e[:, 1] + zf - AK_O[0]], 1))
    B.loft(rings, kind, angle=50, wn=False)
    for sx in (1, -1):
        B.fx.append(fx_pattern(G(sx * 0.0138, -0.012, zf), sx * XL, UP, 0.024, 0.07, pat_ribs(0.0035, 0.4, 1), depth=0.0005, kinds=[kind], facing=0.4))


def ak74m_optic():
    """UA AK-74M: black 6P20 furniture, side-mount (dovetail) Kobra-style collimator, bottom rail + vertical foregrip"""
    B = Builder()
    P, C, O = _akP, _akC, AK_O
    _ak_receiver(B)
    mz = _ak_barrel(B)
    _ak_grip(B, 'polymer')
    _ak74_furniture(B, 'polymer')
    _rail(B, 0.0, G(0, 0.0445, 0)[1], G(0, 0, 0.236)[2], G(0, 0, 0.312)[2], kind='alu', down=True)
    zf = 0.268
    B.box(C(0, 0.0345, zf), (0.026, 0.009, 0.040), 'polymer', bevel=0.002)
    _foregrip(B, zf)
    _ak_mag(B, 'mag_black')
    eye_y = _side_mount_kobra(B)
    _sling(B, [G(0.0192, 0.0705, 0.354), G(0.0262, 0.052, 0.30), G(0.0262, 0.047, 0.21), G(0.0215, 0.040, 0.12), G(0.0222, 0.041, 0.0),
               G(0.0215, 0.0415, -0.108)], kind='webbing')
    emp = _ak_empties(mz, rear=(eye_y, -0.03), front=(eye_y, 0.052), grip_L=(0.040, 0.228), extra={'optic_eye': (eye_y, -0.12), 'foregrip': (-0.02, zf)})
    tris, st = B.export('ak74m_optic', emp, extras={'calibre': '5.45x39', 'length_m': 0.943, 'optic': 'Kobra-style collimator on a dovetail side mount',
                                                    'foregrip': True, 'sight_line_above_bore_m': round(float(eye_y - AK_BORE), 3)})
    return tris, _emp(emp), st


# ---------------------------------------------------------------------------------------------- AK-12 (2020)
def _collimator_1p87(B, z0, ytop):
    """1P87 (PK-120) collimator on a Picatinny rail: clamp base + thumb nut, boxy tunnel housing with a big amber window"""
    C = _akC
    L, W, H = 0.10, 0.054, 0.06
    zc = z0 + L / 2
    B.box(C(0, ytop + 0.006, zc), (0.034, 0.012, L * 0.9), 'alu', bevel=0.002)
    B.revolve([(0, 0), (0, 0.0075), (0.006, 0.0075), (0.007, 0.0)], 'alu', c=G(-0.017, ytop + 0.006, zc + 0.02), axis=XR, n=12)
    B.fx.append(fx_pattern(G(-0.0205, ytop + 0.006, zc + 0.02), XR, UP, 0.015, 0.015, pat_ribs(0.0015, 0.5, 0), depth=0.0003, kinds=['alu'], facing=None))
    yb = ytop + 0.012
    for sx in (1, -1):
        B.profile(_akP([(z0, yb), (z0 + L, yb), (z0 + L, yb + H - 0.004), (z0 + L - 0.012, yb + H), (z0 + 0.008, yb + H), (z0, yb + H - 0.01)]), 0.008,
                  'olive_dark', x0=sx * (W / 2 - 0.004), bevel=0.0025, seg=2)
    B.profile(_akP([(z0 + 0.004, yb + H - 0.008), (z0 + L - 0.004, yb + H - 0.008), (z0 + L - 0.014, yb + H + 0.0005), (z0 + 0.010, yb + H + 0.0005)]), W - 0.004,
              'olive_dark', bevel=0.002)
    B.box(C(0, yb + 0.007, zc), (W - 0.004, 0.014, L), 'olive_dark', bevel=0.0025)
    B.box(C(0, yb + H / 2 + 0.003, z0 + L - 0.006), (W - 0.014, H - 0.022, 0.0025), 'glass_amber', bevel=0.0, uvs=0.5)
    B.box(C(0, yb + H / 2 + 0.003, z0 + 0.010), (W - 0.014, H - 0.022, 0.0025), 'glass', bevel=0.0, uvs=0.5)
    B.revolve([(0, 0), (0, 0.010), (0.010, 0.010), (0.012, 0.008), (0.0125, 0.0)], 'olive_dark', c=G(-W / 2, yb + 0.03, zc - 0.012), axis=XR, n=14)  # battery cap
    for k in range(2):
        B.box(C(W / 2 + 0.0005, yb + 0.022, zc - 0.012 + k * 0.016), (0.004, 0.009, 0.010), 'rubber', bevel=0.0015, seg=1)
    B.fx.append(fx_text('ВАЛДАЙ', G(W / 2, yb + 0.042, zc + 0.01), XL, UP, 0.0042, col='#d8d4c6', colA=0.8, kinds=['olive_dark']))
    B.fx.append(fx_text('1П87', G(-W / 2, yb + 0.046, zc + 0.012), XR, UP, 0.0042, col='#d8d4c6', colA=0.8, kinds=['olive_dark']))
    return yb + H / 2


def ak12():
    """AK-12 (6P70, 2020 pattern): railed dust cover with rear diopter, railed polymer handguard, AK-12 brake, gas-block front
    sight, telescoping side-folding stock with cheek riser, ribbed black magazine, 1P87 collimator"""
    B = Builder()
    P, C, O = _akP, _akC, AK_O
    _ak_receiver(B, side_rail=False, rear_sight=False, ribbed_cover=False)
    mz = _ak_barrel(B, brake='ak12', front_sight=False, cleaning_rod=False, front_swivel=False)
    _rail(B, 0.0, G(0, 0.1030, 0)[1], G(0, 0, -0.088)[2], G(0, 0, 0.134)[2], kind='enamel')
    # rear diopter (folded) at the rear of the cover rail
    B.box(C(0, 0.1170, -0.078), (0.020, 0.006, 0.016), 'steel', bevel=0.001)
    B.revolve([(0, 0), (0, 0.0055), (0.016, 0.0055), (0.016, 0)], 'steel', c=G(-0.008, 0.1225, -0.078), axis=XL, n=12)
    B.fx.append(fx_pattern(G(0, 0.128, -0.078), UP, FW, 0.016, 0.01, pat_checker(0.0012), depth=0.0003, kinds=['steel'], facing=0.2))
    # railed polymer handguard: chamfered box section, M-LOK slots at 3/6/9, top rail
    rings = []
    for z, w in ((0.193, 0.046), (0.200, 0.050), (0.338, 0.050), (0.346, 0.046)):
        rings.append(Gr(rrect(w, 0.112 - 0.040, 0.010, nc=2, cy=0.076, rb=0.014), z))
    B.loft(rings, 'polymer', angle=40, bevel=0.0012, seg=1)
    for k in range(4):
        z = 0.215 + k * 0.032
        for sx in (1, -1):
            B.fx.append(fx_rect(G(sx * 0.025, 0.066, z), sx * XL, UP, 0.022, 0.0075, depth=0.003, kinds=['polymer'], col='#050505', colA=0.9, radius=0.9, edge=0.1))
        B.fx.append(fx_rect(G(0, 0.040, z), DN, FW, 0.0075, 0.022, depth=0.003, kinds=['polymer'], col='#050505', colA=0.9, radius=0.9, edge=0.1))
    B.fx.append(fx_text('КАЛАШНИКОВ', G(0.025, 0.088, 0.27), XL, UP, 0.0045, col='#000000', colA=0.0, depth=0.00025, kinds=['polymer']))
    _rail(B, 0.0, G(0, 0.112, 0)[1], G(0, 0, 0.202)[2], G(0, 0, 0.336)[2], kind='polymer')
    # front sight on the gas block (protected post)
    B.profile(P([(0.343, 0.108), (0.368, 0.108), (0.366, 0.114), (0.348, 0.114)]), 0.018, 'steel', bevel=0.001, seg=1)
    for sx in (1, -1):
        B.profile(P([(0.347, 0.112), (0.366, 0.112), (0.364, 0.128), (0.350, 0.128)]), 0.0025, 'steel', x0=sx * 0.0072, bevel=0.0006, seg=1)
    B.cyl(G(0, 0.112, 0.357), G(0, 0.126, 0.357), 0.0012, 'steel', n=8)
    # telescoping side-folding stock
    B.profile(P([(-0.104, 0.044), (-0.104, 0.090), (-0.126, 0.090), (-0.126, 0.044)]), 0.0315, 'alu', bevel=0.0018)
    B.cyl(G(0.0165, 0.048, -0.116), G(0.0165, 0.086, -0.116), 0.004, 'alu', n=10)
    B.tube(-0.126 - O[0], -0.262 - O[0], 0.0145, 'polymer', c=(0, 0.074 - O[1]), n=14, a0=np.pi / 14)
    B.fx += [fx_line(G(0, 0.074 - 0.0145, z), G(0, 0.074 - 0.0145, z + 0.006), DN, 0.004, depth=0.0008, kinds=['polymer'], facing=0.6) for z in np.arange(-0.24, -0.14, 0.018)]
    st = [(-0.200, 0.036, 0.0985, 0.049, 0.008), (-0.215, 0.040, 0.0990, 0.040, 0.010), (-0.27, 0.040, 0.0990, 0.016, 0.010),
          (-0.33, 0.040, 0.0985, -0.010, 0.010), (-0.343, 0.040, 0.098, -0.016, 0.009)]
    B.loft([Gr(rrect(w, yt - yb, rr, nc=2, cy=(yt + yb) / 2), z) for z, w, yt, yb, rr in st], 'polymer', angle=40, bevel=0.0012, seg=1)
    for sx in (1, -1):
        B.fx.append(fx_rect(G(sx * 0.020, 0.040, -0.285), sx * XL, UP, 0.07, 0.032, depth=0.003, kinds=['polymer'], col='#0a0a0a', colA=0.4, radius=0.5, edge=0.15))
    B.profile(P([(-0.215, 0.099), (-0.33, 0.099), (-0.33, 0.112), (-0.322, 0.120), (-0.228, 0.118), (-0.215, 0.110)]), 0.032, 'polymer', bevel=0.004, seg=2)
    B.profile(P([(-0.343, -0.020), (-0.343, 0.100), (-0.356, 0.100), (-0.357, 0.09), (-0.357, -0.012), (-0.355, -0.020)]), 0.042, 'rubber', bevel=0.003, seg=2)
    B.fx.append(fx_pattern(G(0, 0.04, -0.357), BK, UP, 0.036, 0.11, pat_ribs(0.0045, 0.45, 1), depth=0.0006, kinds=['rubber'], facing=0.6))
    _ak_grip(B, 'polymer', style='ak12')
    _ak_mag(B, 'mag_black', ribs=True)
    eye_y = _collimator_1p87(B, -0.04, 0.1123)
    _sling(B, [G(0.0262, 0.064, 0.334), G(0.0262, 0.050, 0.30), G(0.0262, 0.044, 0.21), G(0.0185, 0.038, 0.12), G(0.0185, 0.040, 0.0),
               G(0.0205, 0.052, -0.120)])
    emp = _ak_empties(mz, rear=(eye_y, -0.04), front=(eye_y, 0.06), butt=(0.04, -0.361), grip_L=(0.040, 0.24), extra={'optic_eye': (eye_y, -0.13)})
    tris, st = B.export('ak12', emp, extras={'calibre': '5.45x39', 'length_m': 0.945, 'optic': '1P87 (PK-120) collimator',
                                             'sight_line_above_bore_m': round(float(eye_y - AK_BORE), 3)})
    return tris, _emp(emp), st


# ================================================================================================= generic frame helper
class Frame:
    def __init__(self, O):
        self.O = np.asarray(O, float)

    def P(self, pts):
        return [(z - self.O[0], y - self.O[1]) for z, y in pts]

    def G(self, x, y, z):
        return np.array((x, y - self.O[1], z - self.O[0]), float)

    def Gr(self, poly, z):
        r = ring_z(poly, z - self.O[0]); r[:, 1] -= self.O[1]
        return r

    def z(self, z):
        return z - self.O[0]

    def y(self, y):
        return y - self.O[1]


def _grip_loft(B, F, lv, kind):
    rings = []
    for y, zc, d, w in lv:
        e = superell(w, d, n=16, p=2.6)
        rings.append(np.stack([e[:, 0], np.full(len(e), F.y(y)), e[:, 1] + F.z(zc)], 1))
    B.loft(rings, kind, angle=50, wn=False)


def _cartridge(B, base, d, n=6, kind='brass'):
    """7.62x54R round along direction d from its rim centre"""
    pr = [(0, 0), (0, 0.0071), (0.0016, 0.0071), (0.0022, 0.0062), (0.040, 0.0058), (0.047, 0.0046), (0.0535, 0.0043), (0.054, 0.0040),
          (0.066, 0.0036), (0.075, 0.0016), (0.0765, 0.0)]
    B.revolve(pr[:8] + [(0.054, 0.0)], kind, c=base, axis=d, n=n, uvs=0.6)
    B.revolve([(0.054, 0.0), (0.054, 0.0040), (0.066, 0.0036), (0.075, 0.0016), (0.0765, 0.0)], 'bare', c=base, axis=d, n=n, uvs=0.5)


def pkm():
    """PKM: stamped receiver with rivets, ribbed feed cover + feed tray, rear sight leaf, fluted barrel, gas cylinder under the
    barrel, folded bipod, carry handle, slotted flash hider, skeleton stock, 100-rd box with belt feeding the tray, sling"""
    B = Builder()
    BORE = 0.085
    gt = np.array([0.0, 0.03]); gb = np.array([-0.03, -0.085])
    F = Frame(gt + 0.42 * (gb - gt))
    P, Gf = F.P, F.G
    # receiver: stamped box, front trunnion narrower
    B.profile(P([(-0.09, 0.036), (-0.082, 0.032), (0.20, 0.032), (0.20, 0.100), (-0.07, 0.100), (-0.09, 0.090)]), 0.050, 'steel_dark', bevel=0.003)
    B.profile(P([(0.195, 0.040), (0.262, 0.044), (0.262, 0.100), (0.195, 0.100)]), 0.044, 'steel_dark', bevel=0.0025)
    for sx in (1, -1):
        n = sx * XL; xs = sx * 0.0251
        B.fx += fx_dots([Gf(xs, y, z) for z, y in ((0.17, 0.045), (0.17, 0.085), (0.185, 0.065), (-0.07, 0.045), (-0.07, 0.08), (-0.05, 0.062),
                                                   (0.06, 0.040), (0.10, 0.040))], 0.0026, n, depth=0.0006, kinds=['steel_dark'], wear=0.5)
        B.fx.append(fx_rect(Gf(xs, 0.066, 0.06), n, UP, 0.16, 0.030, depth=0.0008, kinds=['steel_dark'], radius=0.4, edge=0.15))   # stamped panel
        B.fx.append(fx_line(Gf(xs, 0.096, -0.085), Gf(xs, 0.096, 0.198), n, 0.0012, depth=0.0004, kinds=['steel_dark']))
    B.fx.append(fx_text('1987  № АК 4527', Gf(0.0251, 0.050, 0.06), XL, UP, 0.0032, col='#9a9c9c', colA=0.35, depth=-0.00012, kinds=['steel_dark']))
    # feed cover (hinged at the front) with stamped ribs, latch, feed tray on the right
    rings = []
    for z in (-0.045, -0.035, 0.0, 0.10, 0.155, 0.162):
        top = 0.128 if -0.04 < z < 0.158 else 0.121
        rings.append(F.Gr(rrect(0.052, top - 0.098, 0.012, nc=3, cy=(top + 0.098) / 2, rb=0.002), z))
    B.loft(rings, 'steel_dark', angle=40, bevel=0.001, seg=1)
    for x in (-0.012, 0.012):
        B.fx.append(fx_line(Gf(x, 0.128, -0.03), Gf(x, 0.128, 0.15), UP, 0.005, depth=0.0008, kinds=['steel_dark'], profile='rib', facing=0.5))
    B.box(Gf(0, 0.113, -0.050), (0.020, 0.012, 0.010), 'steel', bevel=0.0015)                              # cover latch
    B.cyl(Gf(0.027, 0.118, 0.158), Gf(-0.027, 0.118, 0.158), 0.0042, 'steel', n=10)                        # hinge pin
    B.box(Gf(-0.031, 0.099, 0.09), (0.014, 0.008, 0.070), 'steel', bevel=0.0012)                          # feed tray (right)
    B.box(Gf(-0.033, 0.092, 0.09), (0.010, 0.006, 0.070), 'steel', bevel=0.001)
    # rear sight block + leaf on the trunnion top
    B.profile(P([(0.165, 0.100), (0.225, 0.100), (0.225, 0.110), (0.165, 0.113)]), 0.024, 'steel', bevel=0.0015)
    B.profile(P([(0.172, 0.113), (0.218, 0.1105), (0.218, 0.1135), (0.172, 0.1165)]), 0.012, 'steel', bevel=0.0006, seg=1)
    B.profile(P([(0.170, 0.112), (0.176, 0.112), (0.176, 0.124), (0.170, 0.124)]), 0.012, 'steel', bevel=0.0006, seg=1)
    B.box(Gf(0, 0.116, 0.195), (0.016, 0.005, 0.007), 'steel', bevel=0.0008, seg=1)
    # charging handle (right, folded) + slot
    B.box(Gf(-0.029, 0.060, 0.135), (0.010, 0.010, 0.014), 'steel', bevel=0.0015)
    B.revolve([(0, 0), (0, 0.006), (0.014, 0.0065), (0.018, 0.0055), (0.019, 0.0)], 'steel', c=Gf(-0.032, 0.060, 0.135), axis=XR, n=10)
    B.fx.append(fx_rect(Gf(-0.0251, 0.060, 0.06), XR, UP, 0.16, 0.006, depth=0.002, kinds=['steel_dark'], col='#080808', colA=0.9, radius=0.9))
    # pistol grip + trigger guard + trigger + safety
    _grip_loft(B, F, [(0.033, 0.010, 0.044, 0.029), (0.0, 0.0, 0.042, 0.0295), (-0.04, -0.010, 0.040, 0.0295), (-0.075, -0.018, 0.041, 0.029),
                      (-0.088, -0.021, 0.040, 0.027), (-0.093, -0.022, 0.034, 0.021)], 'polymer')
    for sx in (1, -1):
        B.fx.append(fx_pattern(Gf(sx * 0.0148, -0.035, -0.008), sx * XL, np.array([0, 1, -0.24]), 0.024, 0.07, pat_checker(0.0022), depth=0.0003, kinds=['polymer'], facing=0.5))
    B.profile(P([(0.020, 0.034), (0.088, 0.034), (0.088, 0.028), (0.070, 0.002), (0.030, -0.002), (0.020, 0.006), (0.028, 0.0045), (0.066, 0.008),
                 (0.080, 0.028), (0.020, 0.028)]), 0.0085, 'steel', bevel=0.0012, seg=1, angle=50)
    B.profile(P([(0.046, 0.032), (0.052, 0.032), (0.050, 0.018), (0.044, 0.008), (0.040, 0.008), (0.044, 0.018)]), 0.005, 'steel', bevel=0.0008, seg=1)
    B.revolve([(0, 0), (0, 0.0045), (0.003, 0.0045), (0.0035, 0)], 'steel', c=Gf(0.0252, 0.040, 0.010), axis=XL, n=10)
    # barrel (fluted), gas block + regulator, gas cylinder under the barrel, flash hider, front sight
    zo = F.O[0]; yb = F.y(BORE)
    B.revolve([(0.24, 0), (0.24, 0.0145), (0.30, 0.0140), (0.30, 0.0125), (0.86, 0.0118), (0.86, 0)], 'steel', c=(0, yb, -zo), axis=FW, n=12)
    for k in range(6):
        a = np.pi / 6 + k * np.pi / 3
        nrm = np.array([np.cos(a), np.sin(a), 0])
        B.fx.append(fx_line(Gf(0.0124 * nrm[0], BORE + 0.0124 * nrm[1], 0.31), Gf(0.0124 * nrm[0], BORE + 0.0124 * nrm[1], 0.62), nrm, 0.0042,
                            depth=0.0008, kinds=['steel'], facing=0.7, thick=0.004))
    B.profile(P([(0.645, 0.050), (0.692, 0.050), (0.692, 0.099), (0.682, 0.102), (0.655, 0.102), (0.645, 0.096)]), 0.030, 'steel', bevel=0.003)
    B.revolve([(0, 0), (0, 0.0085), (0.006, 0.0085), (0.007, 0.0)], 'steel', c=Gf(-0.015, 0.060, 0.670), axis=XR, n=12)        # gas regulator
    B.fx.append(fx_rect(Gf(-0.022, 0.060, 0.670), XR, UP, 0.012, 0.002, depth=0.001, kinds=['steel'], col='#080808', colA=0.8, facing=0.6))
    B.revolve([(0.26, 0), (0.26, 0.0105), (0.64, 0.0105), (0.648, 0.0)], 'steel', c=(0, F.y(0.060), -zo), axis=FW, n=12)
    B.fx += fx_dots([Gf(sx * 0.0074, 0.060 - 0.0074, 0.62) for sx in (1, -1)], 0.0018, np.array([0, -1, 0]), depth=0.0012, shape='hole', kinds=['steel'],
                    col='#050505', colA=0.95, facing=0.2)
    B.revolve([(0.858, 0), (0.858, 0.0140), (0.865, 0.0145), (0.930, 0.0138), (0.936, 0.0120), (0.936, 0.006), (0.92, 0.006), (0.92, 0)], 'steel',
              c=(0, yb, -zo), axis=FW, n=16, a0=np.pi / 16)
    for k in range(5):
        a = k * 2 * np.pi / 5 + np.pi / 2
        nrm = np.array([np.cos(a), np.sin(a), 0])
        B.fx.append(fx_line(Gf(0.0142 * nrm[0], BORE + 0.0142 * nrm[1], 0.880), Gf(0.0142 * nrm[0], BORE + 0.0142 * nrm[1], 0.928), nrm, 0.0032,
                            depth=0.003, kinds=['steel'], facing=0.6, col='#040404', colA=0.95))
    B.fx.append(fx_rect(Gf(0, BORE, 0.9362), FW, UP, 0.010, 0.010, depth=0.003, kinds=['steel'], col='#030303', colA=0.98, radius=1.0, facing=0.6))
    B.tube(F.z(0.818), F.z(0.852), 0.0145, 'steel', c=(0, yb), n=14)
    B.profile(P([(0.820, 0.090), (0.850, 0.090), (0.848, 0.104), (0.822, 0.104)]), 0.016, 'steel', bevel=0.0012)
    for sx in (1, -1):
        B.profile(P([(0.824, 0.100), (0.846, 0.100), (0.844, 0.136), (0.828, 0.136)]), 0.0028, 'steel', x0=sx * 0.0075, bevel=0.0007, seg=1)
    B.cyl(Gf(0, 0.103, 0.836), Gf(0, 0.133, 0.836), 0.0013, 'steel', n=8)
    # carry handle on the barrel: clamp, arch, wood grip
    B.tube(F.z(0.29), F.z(0.316), 0.0158, 'steel', c=(0, yb), n=14)
    hp = [Gf(-0.003, BORE + 0.010, 0.303), Gf(-0.008, 0.128, 0.306), Gf(-0.012, 0.150, 0.316), Gf(-0.012, 0.158, 0.330)]
    B.pipe(spline(hp, 8), 0.0045, 'steel', n=8)
    B.revolve([(0, 0), (0, 0.0090), (0.004, 0.0105), (0.010, 0.0118), (0.086, 0.0118), (0.094, 0.0108), (0.098, 0.0070), (0.098, 0.0)], 'wood',
              c=Gf(-0.012, 0.1585, 0.326), axis=FW, n=12)
    B.revolve([(0, 0), (0, 0.0122), (0.006, 0.0122), (0.006, 0)], 'steel', c=Gf(-0.012, 0.1585, 0.322), axis=FW, n=12)
    # folded bipod: hinge block on the gas block, two legs along the barrel underside with feet + leg clip
    B.box(Gf(0, 0.044, 0.660), (0.026, 0.012, 0.024), 'steel', bevel=0.002)
    for sx in (1, -1):
        B.pipe([Gf(sx * 0.009, 0.044, 0.655), Gf(sx * 0.011, 0.046, 0.55), Gf(sx * 0.011, 0.048, 0.40)], 0.0048, 'steel', n=7)
        B.box(Gf(sx * 0.011, 0.043, 0.392), (0.007, 0.016, 0.018), 'steel', bevel=0.0015)
    B.box(Gf(0, 0.050, 0.47), (0.030, 0.006, 0.010), 'steel', bevel=0.0012)
    # skeleton stock: comb, lower strut, butt; cheek ribs, rubber butt plate
    B.profile(P([(-0.09, 0.095), (-0.09, 0.036), (-0.12, 0.030), (-0.12, 0.096)]), 0.036, 'polymer', bevel=0.004)
    B.profile(P([(-0.12, 0.098), (-0.12, 0.072), (-0.30, 0.064), (-0.33, 0.070), (-0.33, 0.100), (-0.20, 0.099)]), 0.034, 'polymer', bevel=0.004, seg=2)
    B.profile(P([(-0.12, 0.045), (-0.12, 0.024), (-0.30, -0.044), (-0.33, -0.048), (-0.33, -0.024), (-0.29, -0.020)]), 0.034, 'polymer', bevel=0.004, seg=2)
    B.profile(P([(-0.295, 0.090), (-0.295, -0.045), (-0.336, -0.050), (-0.336, 0.100)]), 0.038, 'polymer', bevel=0.004, seg=2)
    B.profile(P([(-0.336, -0.052), (-0.336, 0.101), (-0.348, 0.100), (-0.349, 0.09), (-0.349, -0.044), (-0.347, -0.052)]), 0.040, 'rubber', bevel=0.003)
    B.fx.append(fx_pattern(Gf(0, 0.024, -0.349), BK, UP, 0.034, 0.14, pat_ribs(0.0045, 0.45, 1), depth=0.0006, kinds=['rubber'], facing=0.6))
    # 100-round box under the receiver (right), stamped ribs, lid + latch + handle, belt into the feed tray
    B.box(Gf(-0.012, -0.020, 0.14), (0.052, 0.110, 0.130), 'olive', bevel=0.003)
    B.box(Gf(-0.012, 0.036, 0.14), (0.054, 0.006, 0.134), 'olive', bevel=0.002)
    for sx in (1, -1):
        B.fx.append(fx_rect(Gf(-0.012 + sx * 0.026, -0.022, 0.14), sx * XL, UP, 0.10, 0.08, depth=0.0012, mode='raised', kinds=['olive'], radius=0.3, edge=0.1))
    B.box(Gf(-0.012, 0.020, 0.2065), (0.020, 0.012, 0.004), 'steel', bevel=0.001)
    B.pipe([Gf(-0.03, 0.039, 0.115), Gf(-0.03, 0.047, 0.125), Gf(-0.03, 0.047, 0.155), Gf(-0.03, 0.039, 0.165)], 0.0022, 'steel', n=6)
    B.box(Gf(-0.012, 0.038, 0.10), (0.03, 0.010, 0.016), 'steel', bevel=0.0012)       # mounting bracket
    belt = spline([Gf(-0.026, 0.030, 0.0), Gf(-0.040, 0.058, 0.0), Gf(-0.040, 0.086, 0.0), Gf(-0.028, 0.100, 0.0)], 12)
    for k in range(7):
        p = belt[int(round(k * (len(belt) - 1) / 6))]
        base = np.array([p[0], p[1], F.z(0.058)])
        _cartridge(B, base, FW)
        B.box(base + np.array([0, 0, 0.018]), (0.0035, 0.016, 0.010), 'steel_dark', bevel=0.0006, seg=1, rot=rot_cols(FW, np.array([1, 0, 0])), uvs=0.5)
    # sling: gas block (left, under) -> stock lower left
    B.pipe([Gf(0.016, 0.052 - 0.008 * np.cos(a), 0.676 + 0.008 * np.sin(a)) for a in np.linspace(-2, 2, 7)], 0.0015, 'steel', n=6)
    B.pipe([Gf(0.019, 0.000 - 0.008 * np.cos(a), -0.28 + 0.008 * np.sin(a)) for a in np.linspace(-2, 2, 7)], 0.0015, 'steel', n=6)
    _sling(B, [Gf(0.019, 0.044, 0.676), Gf(0.024, 0.040, 0.55), Gf(0.030, 0.030, 0.30), Gf(0.030, 0.022, 0.12), Gf(0.026, 0.02, -0.10),
               Gf(0.022, -0.008, -0.28)], width=0.024)
    emp = {'muzzle': (np.array([0, F.y(BORE), F.z(0.935)]), [0, 0, 0, 1]), 'grip_R': (np.zeros(3), [0, 0, 0, 1]),
           'grip_L': (np.array([0, F.y(-0.01), F.z(0.2)]), [0, 0, 0, 1]),
           'stock_butt': (np.array([0, F.y(0.02), F.z(-0.348)]), [0, 0, 0, 1])}
    tris, st = B.export('pkm', emp, extras={'calibre': '7.62x54R', 'length_m': 1.19})
    return tris, _emp(emp), st


# ================================================================================================= RPG-7V
def rpg7():
    """RPG-7V: blued tube, two lacquered birch heat guards with clamp bands, trigger group + pistol grip, iron sights,
    PGO-7 optic on the left bracket, flared venturi, sling, PG-7V round (motor + 85 mm warhead + piezo fuze)"""
    B = Builder()
    gt = np.array([0.0, 0.045]); gb = np.array([-0.025, -0.07])
    F = Frame(gt + 0.42 * (gb - gt)); P, Gf = F.P, F.G
    AX = 0.07; Y = F.y(AX); zo = F.O[0]
    c = (0, Y, 0)
    def rev(prof, kind, n=18, **kw):
        return B.revolve([(F.z(z), r) for z, r in prof], kind, c=c, axis=FW, n=n, **kw)
    rev([(-0.43, 0), (-0.43, 0.0240), (0.335, 0.0240), (0.335, 0.0272), (0.356, 0.0272), (0.358, 0.0250), (0.358, 0.0205), (0.345, 0.0205),
         (0.345, 0)], 'steel_dark', n=16)
    # rear: tapered section + flared venturi with blast cone (inner surface dark)
    rev([(-0.47, 0), (-0.47, 0.0315), (-0.455, 0.0322), (-0.43, 0.0255), (-0.43, 0)], 'steel_dark', n=16)
    rev([(-0.47, 0.0315), (-0.585, 0.0485), (-0.600, 0.0505), (-0.603, 0.0490), (-0.600, 0.0465), (-0.585, 0.0455), (-0.47, 0.0280)], 'steel_dark', n=18)
    rev([(-0.598, 0.0458), (-0.47, 0.0275), (-0.46, 0.0)], 'bore', n=16, uvs=0.4)
    # heat guards (birch, lacquered) with steel clamp bands
    for z0, z1, r in ((-0.30, -0.08, 0.0318), (0.05, 0.20, 0.0310)):
        rev([(z0, 0), (z0, 0.026), (z0 + 0.004, r), (z1 - 0.004, r), (z1, 0.026), (z1, 0)], 'wood', n=18)
        for zb in (z0 + 0.006, z1 - 0.006):
            rev([(zb - 0.006, 0), (zb - 0.006, r + 0.0018), (zb + 0.006, r + 0.0018), (zb + 0.006, 0)], 'steel_dark', n=18)
            B.box(Gf(0, AX - r - 0.003, zb), (0.010, 0.006, 0.010), 'steel_dark', bevel=0.0012, seg=1)
            B.fx += fx_dots([Gf(0.0055, AX - r - 0.003, zb)], 0.0022, XL, depth=0.0005, shape='ring', kinds=['steel_dark'])
    # iron sights (folding): front on the front guard, rear above the grip
    B.box(Gf(0, AX + 0.027, 0.215), (0.012, 0.008, 0.016), 'steel_dark', bevel=0.0012)
    B.profile(P([(0.211, AX + 0.030), (0.219, AX + 0.030), (0.217, AX + 0.050), (0.213, AX + 0.050)]), 0.004, 'steel_dark', bevel=0.0006, seg=1)
    B.box(Gf(0, AX + 0.027, -0.025), (0.016, 0.008, 0.022), 'steel_dark', bevel=0.0012)
    B.profile(P([(-0.03, AX + 0.030), (-0.018, AX + 0.030), (-0.022, AX + 0.046), (-0.028, AX + 0.046)]), 0.012, 'steel_dark', bevel=0.0006, seg=1)
    # trigger mechanism housing, hammer, safety, trigger guard, trigger, pistol grip
    B.profile(P([(-0.03, AX - 0.020), (0.105, AX - 0.020), (0.105, AX - 0.031), (0.09, AX - 0.040), (0.035, 0.034), (-0.03, 0.034)]), 0.022, 'steel_dark', bevel=0.002)
    B.profile(P([(-0.035, 0.050), (-0.022, 0.050), (-0.022, 0.060), (-0.033, 0.064)]), 0.010, 'steel', bevel=0.001, seg=1)      # hammer
    B.cyl(Gf(0.014, 0.045, 0.012), Gf(-0.014, 0.045, 0.012), 0.0035, 'steel', n=10)                                             # safety
    B.profile(P([(0.035, 0.036), (0.098, 0.036), (0.082, 0.010), (0.044, 0.006), (0.040, 0.012), (0.046, 0.0125), (0.078, 0.0155), (0.090, 0.032), (0.035, 0.032)]),
              0.007, 'steel_dark', bevel=0.001, seg=1)
    B.profile(P([(0.055, 0.035), (0.061, 0.035), (0.058, 0.020), (0.052, 0.014), (0.049, 0.015), (0.053, 0.022)]), 0.005, 'steel', bevel=0.0008, seg=1)
    _grip_loft(B, F, [(0.040, 0.008, 0.040, 0.027), (0.0, -0.001, 0.040, 0.029), (-0.04, -0.010, 0.039, 0.0295), (-0.068, -0.016, 0.040, 0.029),
                      (-0.078, -0.018, 0.038, 0.027), (-0.082, -0.019, 0.032, 0.021)], 'plum')
    for sx in (1, -1):
        B.fx.append(fx_pattern(Gf(sx * 0.0145, -0.025, -0.006), sx * XL, np.array([0, 1, -0.22]), 0.022, 0.07, pat_checker(0.0024), depth=0.0003, kinds=['plum'], facing=0.5))
    # second (rear) hand grip: plain grip on a clamp bracket under the front end of the rear heat guard
    zr = -0.128
    B.profile(P([(zr - 0.010, AX - 0.030), (zr + 0.026, AX - 0.030), (zr + 0.026, AX - 0.036), (zr + 0.016, AX - 0.044), (zr - 0.002, AX - 0.044),
                 (zr - 0.010, AX - 0.038)]), 0.018, 'steel_dark', bevel=0.0015, seg=1)
    B.fx += fx_dots([Gf(sx * 0.009, AX - 0.035, zr + 0.016) for sx in (1, -1)], 0.0022, XL, depth=0.0004, shape='ring', kinds=['steel_dark'])
    _grip_loft(B, F, [(AX - 0.043, zr + 0.008, 0.034, 0.025), (AX - 0.052, zr + 0.005, 0.038, 0.028), (AX - 0.09, zr - 0.004, 0.037, 0.0285),
                      (AX - 0.122, zr - 0.012, 0.038, 0.028), (AX - 0.131, zr - 0.014, 0.036, 0.026), (AX - 0.135, zr - 0.015, 0.030, 0.020)], 'plum')
    for sx in (1, -1):
        B.fx.append(fx_pattern(Gf(sx * 0.0140, AX - 0.088, zr - 0.004), sx * XL, np.array([0, 1, -0.22]), 0.020, 0.06, pat_checker(0.0024), depth=0.0003,
                               kinds=['plum'], facing=0.5))
    # PGO-7 optic: bracket on the left, body, objective + sunshade, eyepiece + rubber eyecup, range drum + illumination knob
    ox, oy = 0.055, AX + 0.045
    B.profile(P([(-0.07, AX - 0.012), (0.01, AX - 0.012), (0.01, AX + 0.016), (-0.07, AX + 0.016)]), 0.010, 'steel_dark', x0=0.029, bevel=0.0015)
    B.box(Gf(0.040, AX + 0.022, -0.03), (0.024, 0.012, 0.05), 'enamel', bevel=0.002)
    B.profile(P([(-0.155, oy - 0.022), (-0.03, oy - 0.022), (-0.03, oy + 0.020), (-0.05, oy + 0.028), (-0.135, oy + 0.028), (-0.155, oy + 0.018)]), 0.032,
              'enamel', x0=ox, bevel=0.004, seg=2)
    B.revolve([(F.z(-0.035), 0), (F.z(-0.035), 0.0155), (F.z(0.015), 0.0165), (F.z(0.015), 0.0145), (F.z(0.003), 0.0140)], 'enamel', c=Gf(ox, oy, 0) * [1, 1, 0], axis=FW, n=16)
    B.revolve([(F.z(0.003), 0.0141), (F.z(0.003), 0.0)], 'glass', c=Gf(ox, oy, 0) * [1, 1, 0], axis=FW, n=16, uvs=0.5)
    B.revolve([(F.z(-0.20), 0), (F.z(-0.20), 0.0125), (F.z(-0.155), 0.0125), (F.z(-0.155), 0.0)], 'enamel', c=Gf(ox, oy, 0) * [1, 1, 0], axis=FW, n=14)
    B.revolve([(F.z(-0.235), 0.0105), (F.z(-0.235), 0.0185), (F.z(-0.228), 0.0195), (F.z(-0.205), 0.0150), (F.z(-0.19), 0.0135), (F.z(-0.19), 0.0),
               ], 'rubber', c=Gf(ox, oy, 0) * [1, 1, 0], axis=FW, n=14)
    B.revolve([(F.z(-0.224), 0.0104), (F.z(-0.224), 0.0)], 'glass', c=Gf(ox, oy, 0) * [1, 1, 0], axis=FW, n=12, uvs=0.5)
    B.revolve([(0, 0), (0, 0.011), (0.010, 0.011), (0.011, 0.0095), (0.011, 0)], 'enamel', c=Gf(ox, oy + 0.028, -0.09), axis=UP, n=16)
    B.fx.append(fx_pattern(Gf(ox, oy + 0.0335, -0.09), np.array([0, 0, 1.0]), UP, 0.012, 0.008, pat_ribs(0.0016, 0.5, 0), depth=0.0003, kinds=['enamel'], facing=None))
    B.revolve([(0, 0), (0, 0.0075), (0.008, 0.0075), (0.008, 0)], 'enamel', c=Gf(ox + 0.016, oy, -0.11), axis=XL, n=12)
    B.fx.append(fx_text('ПГО-7', Gf(ox + 0.016, oy + 0.008, -0.075), XL, UP, 0.005, col='#d8d4c6', colA=0.8, kinds=['enamel']))
    for k in range(5):   # range scale ticks on the drum side
        B.fx.append(fx_line(Gf(ox + 0.016, oy - 0.012, -0.13 + k * 0.012), Gf(ox + 0.016, oy - 0.006, -0.13 + k * 0.012), XL, 0.0008, kinds=['enamel'],
                            profile='flat', col='#d8d4c6', colA=0.8))
    # sling swivels + sling (left, under the tube)
    for zs in (-0.294, 0.194):
        B.pipe([Gf(0.022, AX - 0.030 - 0.007 * np.cos(a), zs + 0.007 * np.sin(a)) for a in np.linspace(-2, 2, 7)], 0.0015, 'steel', n=6)
    _sling(B, [Gf(0.024, AX - 0.035, 0.194), Gf(0.030, AX - 0.033, 0.10), Gf(0.032, AX - 0.040, -0.05), Gf(0.030, AX - 0.038, -0.20),
               Gf(0.024, AX - 0.035, -0.294)], width=0.025)
    B.fx.append(fx_text('ЛЕ 1342   1978', Gf(0.024, AX + 0.006, -0.38), XL, UP, 0.0035, col='#a0a0a0', colA=0.3, depth=-0.0001, kinds=['steel_dark']))
    # PG-7V round in the muzzle
    zb = 0.35
    rev([(zb - 0.01, 0), (zb - 0.01, 0.0195), (zb + 0.055, 0.0195), (zb + 0.064, 0.026), (zb + 0.080, 0.0425), (zb + 0.135, 0.0425), (zb + 0.145, 0.0412),
         (zb + 0.268, 0.0112), (zb + 0.270, 0.0105), (zb + 0.270, 0)], 'warhead', n=22)
    rev([(zb + 0.270, 0), (zb + 0.270, 0.0098), (zb + 0.285, 0.0070), (zb + 0.290, 0.0045), (zb + 0.291, 0)], 'steel', n=12)
    for zz in (zb + 0.084, zb + 0.130):
        B.fx.append(fx_cyl_bands(Gf(0, AX, 0), FW, F.z(zz), F.z(zz + 0.004), 0.0425, '#151515', kinds=['warhead']))
    for sx in (1, -1):
        B.fx.append(fx_text('ПГ-7В', Gf(sx * 0.0425, AX, zb + 0.107), sx * XL, UP, 0.010, col='#141414', colA=0.9, kinds=['warhead'], facing=0.6, thick=0.012))
        B.fx.append(fx_text('12-87-345', Gf(sx * 0.0425, AX - 0.016, zb + 0.107), sx * XL, UP, 0.0045, col='#141414', colA=0.85, kinds=['warhead'], facing=0.6, thick=0.012))
    emp = {'muzzle': (np.array([0, Y, F.z(zb)]), [0, 0, 0, 1]), 'grip_R': (np.zeros(3), [0, 0, 0, 1]),
           'grip_L': (np.array([0.0, 0.032, 0.17]), [0, 0, 0, 1]),
           'backblast': (np.array([0, Y, F.z(-0.6)]), [0, 1, 0, 0]),
           'warhead': (np.array([0, Y, F.z(zb + 0.15)]), [0, 0, 0, 1]),
           'shoulder_rest': (np.array([0, Y + 0.035, F.z(-0.20)]), [0, 0, 0, 1])}
    tris, st = B.export('rpg7', emp, extras={'calibre': '40 mm launcher, PG-7V 85 mm HEAT', 'length_m': 0.95, 'optic': 'PGO-7'})
    return tris, _emp(emp), st


# ================================================================================================= RPG-22
RPG22 = dict(AXY=0.066, R_REAR=0.0400, R_FRONT=0.0435, Z_REAR=-0.462, Z_MUZZLE=0.392, EXT=0.095)


def _rpg22_parts(B, carried=False, oy=0.0, oz=0.0):
    """RPG-22 'Netto' (72.5 mm, fibreglass, telescoping).  Firing configuration 0.85 m, collapsed 0.755 m.
    gun space: origin = right hand on the tube (below the firing-mechanism housing), +Z muzzle, +Y up, +X weapon left."""
    Pp = RPG22
    A = Pp['AXY'] + oy
    Rr, Rf = Pp['R_REAR'], Pp['R_FRONT']
    ext = 0.0 if not carried else -Pp['EXT']
    z = lambda v: v + oz
    zf = lambda v: v + oz + ext
    c = (0.0, A, 0.0)
    def rev(prof, kind, n=22, **kw):
        return B.revolve(prof, kind, c=c, axis=FW, n=n, **kw)
    # rear (main) tube with rear rim band; open end shows the dark bore
    rev([(z(-0.43), 0.0355), (z(-0.462), 0.0355), (z(-0.462), 0.0428), (z(-0.438), 0.0428), (z(-0.436), Rr), (z(0.02), Rr)], 'fibre')
    rev([(z(-0.43), 0.0356), (z(-0.43), 0.0)], 'bore', uvs=0.4)
    rev([(z(-0.30), Rr + 0.0007), (z(-0.29), Rr + 0.0007)], 'fibre_dark')
    # front extension tube
    rev([(zf(-0.075), Rr + 0.0004), (zf(-0.075), 0.0458), (zf(-0.052), 0.0458), (zf(-0.050), Rf), (zf(0.368), Rf), (zf(0.370), 0.0458),
         (zf(0.392), 0.0458), (zf(0.392), 0.0385), (zf(0.355), 0.0385)], 'fibre')
    rev([(zf(0.355), 0.0386), (zf(0.355), 0.0)], 'bore', uvs=0.4)
    rev([(zf(0.17), Rf + 0.0007), (zf(0.19), Rf + 0.0007)], 'fibre_dark')
    # stencilled markings (left side) + rear warning band + arrow
    B.fx.append(fx_text('РПГ-22', (Rr, A + 0.010, z(-0.24)), XL, UP, 0.010, col='#c9b45a', colA=0.92, kinds=['fibre'], facing=0.5, thick=0.012))
    B.fx.append(fx_text('ВЫСТРЕЛ  ЛОТ 04-91-17', (Rr, A - 0.006, z(-0.24)), XL, UP, 0.0045, col='#c9b45a', colA=0.85, kinds=['fibre'], facing=0.5, thick=0.012))
    B.fx.append(fx_text('ОСТОРОЖНО! СЗАДИ ОПАСНАЯ ЗОНА 30 м', (Rr * 0.7, A + Rr * 0.7, z(-0.36)), np.array([0.7, 0.7, 0]), UP, 0.0036, col='#c9b45a', colA=0.85,
                        kinds=['fibre'], facing=0.5, thick=0.02))
    B.fx.append(fx_text('◄ ВПЕРЁД', (Rf, A + 0.004, zf(0.07)), XL, UP, 0.0065, col='#c9b45a', colA=0.9, kinds=['fibre'], facing=0.5, thick=0.012))
    B.fx.append(fx_text('1  ВЫДВИНУТЬ   2  СНЯТЬ С ПРЕДОХРАНИТЕЛЯ', (Rf, A - 0.012, zf(0.11)), XL, UP, 0.0034, col='#c9b45a', colA=0.85, kinds=['fibre'], facing=0.5, thick=0.012))
    B.fx.append(fx_cyl_bands(c, FW, z(-0.418), z(-0.405), Rr, '#8a7a3a', kinds=['fibre']))
    B.fx.append(fx_text('РПГ-22  НЕТТО', (-Rr, A + 0.006, z(-0.25)), XR, UP, 0.0075, col='#c9b45a', colA=0.9, kinds=['fibre'], facing=0.5, thick=0.012))
    B.fx.append(fx_text('ПАРТИЯ 07-91  №0384', (-Rr, A - 0.008, z(-0.25)), XR, UP, 0.0042, col='#c9b45a', colA=0.85, kinds=['fibre'], facing=0.5, thick=0.012))
    B.fx.append(fx_text('ГОТОВ К ВЫСТРЕЛУ ПОСЛЕ ВЫДВИЖЕНИЯ', (-Rf, A + 0.002, zf(0.12)), XR, UP, 0.0036, col='#c9b45a', colA=0.85, kinds=['fibre'], facing=0.5, thick=0.012))
    B.fx += [fx_line((0, A + Rf * np.sin(a), zf(0.0) + 0) * np.array([1, 1, 1]) + np.array([Rf * np.cos(a), 0, 0]),
                     (0, A + Rf * np.sin(a), zf(0.36)) + np.array([Rf * np.cos(a), 0, 0]), np.array([np.cos(a), np.sin(a), 0]), 0.002, depth=0.0003,
                     kinds=['fibre'], facing=0.6) for a in np.linspace(0, 2 * np.pi, 9)[:-1]]   # filament-wound seams
    # firing-mechanism housing + trigger button + safety
    top = A + Rr
    B.profile([(z(-0.155), top - 0.012), (z(-0.035), top - 0.012), (z(-0.035), top + 0.012), (z(-0.05), top + 0.024), (z(-0.145), top + 0.024), (z(-0.155), top + 0.016)],
              0.032, 'fibre_dark', x0=0.004, bevel=0.003, seg=2)
    B.box((0.004, top + 0.027, z(-0.062)), (0.014, 0.008, 0.016), 'rubber', bevel=0.002)
    B.box((0.022, top + 0.010, z(-0.10)), (0.004, 0.010, 0.030), 'rubber', bevel=0.001)
    B.fx.append(fx_text('ПУСК', (0.020, top + 0.016, z(-0.07)), XL, UP, 0.0032, col='#e0dccb', colA=0.9, kinds=['fibre_dark'], facing=0.5))
    B.fx += fx_dots([(0.0201, top + y, z(zz)) for y, zz in ((-0.006, -0.145), (-0.006, -0.045))], 0.002, XL, depth=0.0004, kinds=['fibre_dark'])
    # rear sight (flip-up aperture frame)
    if not carried:
        y0, y1 = top + 0.022, top + 0.068
        zs = z(-0.150)
        for sx in (1, -1):
            B.box((0.004 + sx * 0.012, (y0 + y1) / 2, zs), (0.004, y1 - y0, 0.004), 'fibre_dark', bevel=0.0008, seg=1)
        B.box((0.004, y1 - 0.002, zs), (0.028, 0.004, 0.004), 'fibre_dark', bevel=0.0008, seg=1)
        B.box((0.004, top + 0.040, zs), (0.028, 0.006, 0.004), 'fibre_dark', bevel=0.0008, seg=1)
        B.box((0.004, top + 0.054, zs), (0.010, 0.004, 0.003), 'fibre_dark', bevel=0.0005, seg=1)
        B.fx.append(fx_dots([(0.004, top + 0.054, zs - 0.0016)], 0.0012, BK, depth=0.001, shape='hole', col='#050505', colA=0.9, kinds=['fibre_dark'])[0])
        B.cyl((0.018, top + 0.022, zs), (-0.010, top + 0.022, zs), 0.0022, 'fibre_dark', n=8)
    else:
        B.box((0.004, top + 0.027, z(-0.12)), (0.028, 0.004, 0.05), 'fibre_dark', bevel=0.0008, seg=1)
    # front sight frame with range lines
    ftop = A + Rf
    if not carried:
        zs = zf(0.335)
        B.box((0.004, ftop + 0.002, zs), (0.032, 0.006, 0.014), 'fibre_dark', bevel=0.001, seg=1)
        for sx in (1, -1):
            B.box((0.004 + sx * 0.013, ftop + 0.026, zs), (0.004, 0.046, 0.004), 'fibre_dark', bevel=0.0008, seg=1)
        B.box((0.004, ftop + 0.048, zs), (0.030, 0.004, 0.004), 'fibre_dark', bevel=0.0008, seg=1)
        B.box((0.004, ftop + 0.024, zs), (0.003, 0.040, 0.003), 'fibre_dark', bevel=0.0, seg=1)
        for k, yy in enumerate((0.014, 0.022, 0.030, 0.038)):
            B.box((0.004, ftop + yy, zs), (0.022, 0.0012, 0.0025), 'fibre_dark', bevel=0.0, seg=1)
            B.fx.append(fx_text(str(50 * (k + 1)), (0.0175, ftop + yy, zs), XL, UP, 0.0022, col='#e0dccb', colA=0.9, kinds=['fibre_dark'], facing=0.5, thick=0.004))
    else:
        B.box((0.004, ftop + 0.004, zf(0.31)), (0.032, 0.004, 0.06), 'fibre_dark', bevel=0.001, seg=1)
    # sling swivels (bottom-left) + carry sling
    sw = [(0.026, A - 0.034, z(-0.445)), (0.028, A - 0.036, zf(0.18))]
    for p in sw:
        B.box(p, (0.006, 0.014, 0.018), 'rubber', bevel=0.001, seg=1)
    a, b = np.array(sw[0]) + [0.004, -0.008, 0], np.array(sw[1]) + [0.004, -0.008, 0]
    t = np.linspace(0, 1, 11)
    sag = 0.0 if carried else 0.09
    pts = a[None] * (1 - t[:, None]) + b[None] * t[:, None]
    pts[:, 1] -= sag * 4 * t * (1 - t)
    if carried:
        pts[:, 0] += 0.006 * np.sin(np.pi * t)
    B.strap(pts, 0.025, 0.003, 'webbing', up=(1, 0, 0), uvs=0.5)
    if carried:
        rev([(z(-0.474), 0.0), (z(-0.474), 0.040), (z(-0.470), 0.0448), (z(-0.442), 0.0448), (z(-0.440), 0.0430)], 'rubber')
        rev([(zf(0.404), 0.0), (zf(0.404), 0.042), (zf(0.400), 0.0475), (zf(0.372), 0.0475), (zf(0.370), 0.0460)], 'rubber')
        B.fx.append(fx_pattern((0, A, z(-0.474)), BK, UP, 0.07, 0.07, pat_ribs(0.004, 0.4, 1), depth=0.0005, kinds=['rubber'], facing=0.6))
    return A


def rpg22():
    B = Builder()
    Pp = RPG22
    A = _rpg22_parts(B)
    top = A + Pp['R_REAR']
    emp = {'muzzle': (np.array([0, A, Pp['Z_MUZZLE']]), [0, 0, 0, 1]),
           'rear': (np.array([0, A, Pp['Z_REAR']]), [0, 1, 0, 0]),
           'backblast': (np.array([0, A, Pp['Z_REAR']]), [0, 1, 0, 0]),
           'grip_R': (np.zeros(3), [0, 0, 0, 1]),
           'grip_L': (np.array([0.0, A - Pp['R_FRONT'] + 0.004, 0.19]), [0, 0, 0, 1]),
           'sight_rear': (np.array([0.004, top + 0.054, -0.150]), [0, 0, 0, 1]),
           'sight_front': (np.array([0.004, A + Pp['R_FRONT'] + 0.046, 0.335]), [0, 0, 0, 1]),
           'shoulder_rest': (np.array([0, A + Pp['R_REAR'], -0.21]), [0, 0, 0, 1])}
    tris, st = B.export('rpg22', emp, res=1024, extras={'calibre': '72.5 mm', 'length_m': 0.85, 'length_collapsed_m': 0.755, 'weight_kg': 2.8,
                                                         'config': 'extended / ready to fire, end covers removed, sights up'})
    B2 = Builder()
    zc = (Pp['Z_REAR'] - 0.012 + Pp['Z_MUZZLE'] - Pp['EXT'] + 0.012) / 2
    _rpg22_parts(B2, carried=True, oy=-Pp['AXY'], oz=-zc)
    L = (Pp['Z_MUZZLE'] - Pp['EXT'] + 0.012) - (Pp['Z_REAR'] - 0.012)
    emp2 = {'front_end': (np.array([0, 0, L / 2]), [0, 0, 0, 1]), 'rear_end': (np.array([0, 0, -L / 2]), [0, 1, 0, 0])}
    t2, st2 = B2.export('rpg22_carried', emp2, res=512, extras={'config': 'collapsed (transport) 0.755 m tube + covers, sights folded, sling taut',
                                                               'length_m': round(float(L), 3), 'socket': 'launcher_socket_back'})
    t0 = sum(v for k, v in t2.items() if not k.endswith('_LOD1')); t1 = sum(v for k, v in t2.items() if k.endswith('_LOD1'))
    return tris, _emp(emp), st, dict(file='rpg22_carried.glb', tris=t0, tris_LOD1=t1)


# ================================================================================================= grenades
GREN_OFF = np.array([0.013, 0.0, 0.0])   # body centre relative to the palm origin (towards the fingers, +X)


def _uzrgm_at(B, cx, ytop):
    """UZRGM fuze: body, striker housing, spoon down the palm side (-X), pin + pull ring (+Z)"""
    B.revolve([(ytop - 0.002, 0.0), (ytop - 0.002, 0.0125), (ytop + 0.006, 0.0125), (ytop + 0.006, 0.0095), (ytop + 0.022, 0.0095), (ytop + 0.026, 0.006),
               (ytop + 0.026, 0.0)], 'steel', c=(cx, 0, 0), axis=UP, n=10)
    sx = -1.0
    pts = np.array([[cx + 0.004, ytop + 0.0285, 0.0], [cx + sx * 0.010, ytop + 0.029, 0.0], [cx + sx * 0.017, ytop + 0.022, 0.0],
                    [cx + sx * 0.025, ytop + 0.002, 0.0], [cx + sx * 0.030, ytop - 0.02, 0.0], [cx + sx * 0.031, ytop - 0.042, 0.0]])
    B.strap(pts, 0.014, 0.0018, 'steel', up=(1, 0, 0))
    B.cyl((cx, ytop + 0.012, 0.004), (cx, ytop + 0.012, 0.021), 0.0013, 'steel', n=4)
    ring = [(cx, ytop + 0.012 + 0.010 * np.sin(a), 0.031 + 0.010 * np.cos(a)) for a in np.linspace(0, 2 * np.pi, 9)[:-1]]
    B.pipe(np.array(ring), 0.0013, 'steel', n=4, closed=True)


def grenade_f1():
    """F-1 defensive grenade: segmented cast-iron ovoid (55 mm), olive paint, UZRGM fuze.  origin = palm centre, +Y = fuze."""
    B = Builder()
    cx = GREN_OFF[0]
    R, Hh = 0.0275, 0.042
    yc = -0.004
    prof = []
    for t in np.linspace(-1, 1, 11):
        r = R * np.sqrt(max(1 - (t * 0.93) ** 2, 0.0))
        prof.append((yc + t * Hh, r))
    prof[0] = (yc - Hh, 0.0); prof[-1] = (yc + Hh, 0.0)
    prof.insert(1, (yc - Hh, 0.008)); prof.insert(-1, (yc + Hh, 0.013))
    B.revolve(prof, 'cast', c=(cx, 0, 0), axis=UP, n=16, angle=60)
    ytop = yc + Hh

    def seg(lu, lv, ln):
        x, y, z = lu * 0.03, lv * 0.05, ln * 0.03
        phi = np.arctan2(z, x); rxy = np.sqrt(x * x + z * z)
        dc = np.abs(((phi / (2 * np.pi / 8)) + 0.5) % 1 - 0.5) * (2 * np.pi / 8) * rxy
        rows = (y - (-0.034)) / 0.0136
        dr = np.abs((rows + 0.5) % 1 - 0.5) * 0.0136
        g = np.maximum(np.clip(1 - dc / 0.0022, 0, 1), np.clip(1 - dr / 0.0022, 0, 1) * (np.abs(y) < 0.036))
        lump = (1 - g) * (1 - np.clip(np.maximum(dc, dr * 0) / 0.009, 0, 1) * 0.0)
        return dict(h=-0.0016 * g ** 0.7 + 0.0002 * lump, mul=1 - 0.25 * g, wear=0.0 * g)
    B.fx.append(Fx((cx, yc, 0), np.eye(3), (0.03, 0.05, 0.03), seg, facing=None, kinds=['cast']))
    _uzrgm_at(B, cx, ytop + 0.002)
    emp = {'grip_R': (np.zeros(3), [0, 0, 0, 1]), 'centre': (np.array([cx, yc, 0.0]), [0, 0, 0, 1]),
           'fuze': (np.array([cx, ytop + 0.03, 0.0]), [0, 0, 0, 1]), 'pin_ring': (np.array([cx, ytop + 0.014, 0.03]), [0, 0, 0, 1])}
    tris, st = B.export('grenade_f1', emp, res=512, lod_ratio=0.45, ao_d=0.01, edge_r=0.0008,
                        extras={'type': 'F-1 defensive fragmentation grenade', 'mass_kg': 0.6, 'body_diameter_m': 0.055, 'length_m': 0.117, 'fuze': 'UZRGM 3.2-4.2 s'})
    return tris, _emp(emp), st


def grenade_rgd5():
    """RGD-5 offensive grenade: smooth two-piece steel egg (58 mm), olive drab with a seam band, UZRGM fuze."""
    B = Builder()
    cx = GREN_OFF[0]
    R, Hh = 0.029, 0.039
    yc = -0.006
    prof = [(yc - Hh, 0.0)]
    for t in np.linspace(-0.96, 0.96, 9):
        prof.append((yc + t * Hh, R * np.sqrt(1 - t * t) ** 0.85 * (1 - 0.06 * t)))
    prof.append((yc + Hh, 0.0))
    B.revolve(prof, 'olive', c=(cx, 0, 0), axis=UP, n=14, angle=60)
    ytop = yc + Hh
    B.revolve([(ytop - 0.006, 0.0135), (ytop + 0.003, 0.0135), (ytop + 0.003, 0.0)], 'olive', c=(cx, 0, 0), axis=UP, n=10)
    B.fx.append(fx_cyl_bands((cx, 0, 0), UP, yc - 0.0022, yc + 0.0022, R, '#3c4128', colA=0.6, depth=0.0005, kinds=['olive']))
    B.fx.append(fx_cyl_bands((cx, 0, 0), UP, yc - 0.0004, yc + 0.0004, R, '#22251a', colA=0.8, depth=-0.0003, kinds=['olive']))
    B.fx.append(fx_text('РГД-5', (cx + R * 0.72, yc + 0.012, R * 0.69), np.array([0.72, 0, 0.69]), UP, 0.0045, col='#141414', colA=0.85, kinds=['olive'], facing=0.4))
    B.fx.append(fx_text('17-88-243', (cx + R * 0.72, yc - 0.008, R * 0.69), np.array([0.72, 0, 0.69]), UP, 0.0032, col='#141414', colA=0.8, kinds=['olive'], facing=0.4))
    _uzrgm_at(B, cx, ytop + 0.001)
    emp = {'grip_R': (np.zeros(3), [0, 0, 0, 1]), 'centre': (np.array([cx, yc, 0.0]), [0, 0, 0, 1]),
           'fuze': (np.array([cx, ytop + 0.03, 0.0]), [0, 0, 0, 1]), 'pin_ring': (np.array([cx, ytop + 0.013, 0.031]), [0, 0, 0, 1])}
    tris, st = B.export('grenade_rgd5', emp, res=512, lod_ratio=0.45, ao_d=0.01, edge_r=0.0008,
                        extras={'type': 'RGD-5 offensive fragmentation grenade', 'mass_kg': 0.31, 'body_diameter_m': 0.058, 'length_m': 0.114, 'fuze': 'UZRGM 3.2-4.2 s'})
    return tris, _emp(emp), st


if __name__ == '__main__':
    info = {}
    only = sys.argv[1:]
    infop = os.path.join(CACHE, 'weapons_info.json')
    if os.path.exists(infop):
        info = json.load(open(infop))
    for fn in (ak74m, pkm, rpg7, rpg22, ak12, ak74m_optic, grenade_f1, grenade_rgd5):
        if only and fn.__name__ not in only:
            continue
        r = fn()
        tris, emp, st = r[0], r[1], r[2]
        t0 = sum(v for k, v in tris.items() if not k.endswith('_LOD1')); t1 = sum(v for k, v in tris.items() if k.endswith('_LOD1'))
        info[fn.__name__] = dict(tris=t0, tris_LOD1=t1, nodes=tris, empties=emp, texel_px_per_m=round(st['px_per_m']))
        if len(r) > 3:
            info[fn.__name__]['carried'] = r[3]
        print(fn.__name__, t0, t1)
    os.makedirs(CACHE, exist_ok=True)
    json.dump(info, open(infop, 'w'), indent=1)
