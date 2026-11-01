"""ATGM + FPV props: kornet.glb (9K135 Kornet: 9P163-1 tripod, 1P45M sight + 1PN79 thermal, 9M133 TLC), stugna.glb
(Stugna-P: tripod launcher, PN-S guidance unit, R-2 TLC, remote control unit on its own tripod + cable),
atgm_tube_carried.glb (TLC carried on the back), fpv_drone.glb (7" kamikaze quad with a PG-7V warhead),
fpv_controller.glb (radio, weapon_socket), fpv_goggles.glb (head mounted).

Reuses weapons.Builder primitives + the weapon_tex atlas pipeline (Cycles AO/edge bake + procedural PBR), but exports several
nodes per GLB (one atlas material per file): every movable part is its own transform node with `<node>_mesh` (LOD0) and
`<node>_LOD1` mesh children (so hiding / moving the node takes its LODs along), empties are parented where they belong.
Placement relative to the soldier comes from atgm_layout.py (shared with clips_atgm.py).
run: nice -n 10 python3 tools/blender/soldiers/atgm.py [kornet stugna tube drone controller goggles]"""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import bpy, bmesh
import bl, gltfw
import weapon_tex as WT
from weapon_tex import fx_dots, fx_rect, fx_line, fx_pattern, fx_text, fx_cyl_bands, Fx, frame
import weapons as WP
from weapons import Builder, rrect, superell, ring_z, ring_frame, spline, pat_ribs, pat_checker, pat_dots
from qmath import qmul, qinv, qrot, qaxis, qeuler, qlook, qfrom_mat, qto_mat
import atgm_layout as LY

OUT = WP.OUT
CACHE = WP.CACHE
XL, XR, UP, DN, FW, BK = (np.array(v, float) for v in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)))

# ------------------------------------------------------------------ extra material kinds (appended in memory; weapon_tex.py untouched)
_NEW = {
    'kgreen':    dict(col='#56604b', rough=0.62, metal=0.0, wcol='#62655f', wrough=0.38, wmetal=0.85, wear=0.75, mott=0.09, rn=0.08, micro=0.00003, micro_f=700, dirt=0.65),
    'kbeige':    dict(col='#8c8770', rough=0.6, metal=0.0, wcol='#6b6c68', wrough=0.38, wmetal=0.8, wear=0.6, mott=0.07, rn=0.07, micro=0.00002, micro_f=900, dirt=0.6),
    'tlc':       dict(col='#4a5034', rough=0.66, metal=0.0, wcol='#5d6347', wrough=0.5, wmetal=0.0, wear=0.45, mott=0.08, rn=0.06, micro=0.00002, micro_f=800, dirt=0.6),
    'membrane':  dict(col='#b5ad93', rough=0.75, metal=0.0, wcol='#b5ad93', wrough=0.75, wmetal=0.0, wear=0.0, mott=0.10, rn=0.05, micro=0.00002, micro_f=500, dirt=0.7),
    'sgreen':    dict(col='#3c4529', rough=0.6, metal=0.0, wcol='#5a5c58', wrough=0.38, wmetal=0.85, wear=0.7, mott=0.08, rn=0.08, micro=0.00002, micro_f=800, dirt=0.65),
    'carbon':    dict(col='#141516', rough=0.30, metal=0.0, wcol='#3a3b3c', wrough=0.45, wmetal=0.0, wear=0.6, mott=0.04, rn=0.05, micro=0.00001, micro_f=2500, dirt=0.4),
    'prop':      dict(col='#2f3236', rough=0.42, metal=0.0, wcol='#4a4d50', wrough=0.4, wmetal=0.0, wear=0.3, mott=0.04, rn=0.05, micro=0.0, micro_f=1, dirt=0.3),
    'tpu':       dict(col='#a8481c', rough=0.65, metal=0.0, wcol='#c0602c', wrough=0.6, wmetal=0.0, wear=0.2, mott=0.06, rn=0.05, micro=0.00003, micro_f=3000, dirt=0.5),
    'battery':   dict(col='#1a1b1d', rough=0.32, metal=0.0, wcol='#2a2b2d', wrough=0.35, wmetal=0.0, wear=0.3, mott=0.03, rn=0.04, micro=0.0, micro_f=1, dirt=0.4),
    'motor':     dict(col='#26282c', rough=0.32, metal=0.85, wcol='#a6aaae', wrough=0.22, wmetal=1.0, wear=0.8, mott=0.05, rn=0.06, micro=0.00001, micro_f=2000, dirt=0.35),
    'copper':    dict(col='#8c5228', rough=0.35, metal=1.0, wcol='#a8683a', wrough=0.3, wmetal=1.0, wear=0.0, mott=0.08, rn=0.05, micro=0.00002, micro_f=3000, dirt=0.3),
    'foam':      dict(col='#161616', rough=0.95, metal=0.0, wcol='#202020', wrough=0.95, wmetal=0.0, wear=0.0, mott=0.06, rn=0.03, micro=0.00008, micro_f=2500, dirt=0.3),
    'plastic':   dict(col='#2b2d30', rough=0.5, metal=0.0, wcol='#4a4c50', wrough=0.42, wmetal=0.0, wear=0.45, mott=0.04, rn=0.06, micro=0.00002, micro_f=2000, dirt=0.45),
    'plastic_lt': dict(col='#55585c', rough=0.5, metal=0.0, wcol='#75787c', wrough=0.42, wmetal=0.0, wear=0.4, mott=0.04, rn=0.06, micro=0.00002, micro_f=2000, dirt=0.45),
    'cable':     dict(col='#151515', rough=0.7, metal=0.0, wcol='#2a2a2a', wrough=0.7, wmetal=0.0, wear=0.1, mott=0.05, rn=0.04, micro=0.0, micro_f=1, dirt=0.4),
    'case':      dict(col='#3d4630', rough=0.55, metal=0.0, wcol='#56604a', wrough=0.45, wmetal=0.0, wear=0.5, mott=0.06, rn=0.06, micro=0.00004, micro_f=1500, dirt=0.6),
}
for _k, _v in _NEW.items():
    if _k not in WT.K:
        WT.K[_k] = _v
        WT.KIND_ID[_k] = len(WT.KIND_ID)


# ------------------------------------------------------------------ transformed builder (same part code at another place / orientation)
class XB:
    """forwards Builder primitives with every point / direction mapped by (R, t): used to build the folded tripods and the
    back-carried tubes from the same part code, spatially separate from the deployed parts (separate AO bake islands)"""
    def __init__(self, B, R=np.eye(3), t=np.zeros(3)):
        self.B = B; self.R = np.asarray(R, float); self.t = np.asarray(t, float)

    def p(self, v):
        v = np.asarray(v, float)
        return v @ self.R.T + self.t

    def d(self, v):
        return np.asarray(v, float) @ self.R.T

    def box(self, c, size, kind, rot=None, **kw):
        return self.B.box(self.p(c), size, kind, rot=self.R @ (np.eye(3) if rot is None else np.asarray(rot)), **kw)

    def cyl(self, p0, p1, r, kind, **kw):
        return self.B.cyl(self.p(p0), self.p(p1), r, kind, **kw)

    def revolve(self, prof, kind, c=(0, 0, 0), axis=(0, 0, 1), ref=None, **kw):
        axis = np.asarray(axis, float)
        if ref is None:
            ref = np.array([1.0, 0, 0]) if abs(axis[0] / np.linalg.norm(axis)) < 0.9 else np.array([0, 1.0, 0])
        return self.B.revolve(prof, kind, c=self.p(c), axis=self.d(axis), ref=self.d(ref), **kw)

    def pipe(self, path, r, kind, **kw):
        return self.B.pipe(self.p(path), r, kind, **kw)

    def strap(self, pts, width, thick, kind, up=(1, 0, 0), **kw):
        return self.B.strap(self.p(pts), width, thick, kind, up=self.d(up), **kw)

    def mesh(self, V, faces, kind, **kw):
        return self.B.mesh(self.p(V), faces, kind, **kw)

    def loft(self, rings, kind, **kw):
        return self.B.loft([self.p(r) for r in rings], kind, **kw)

    def fx(self, f):
        fs = f if isinstance(f, list) else [f]
        for x in fs:
            x.c = self.p(x.c); x.R = self.R @ x.R
            self.B.fx.append(x)

    def prism(self, poly_uv, width, kind, c, u, v, **kw):
        """extruded polygon: poly (u, v) in the plane spanned by u, v through c, extruded symmetrically along u x v"""
        u = np.asarray(u, float); v = np.asarray(v, float); w = np.cross(u, v); w /= np.linalg.norm(w)
        P = np.asarray(poly_uv, float)
        a = np.asarray(c, float) + P[:, :1] * u + P[:, 1:2] * v
        rings = [a - w * width / 2, a + w * width / 2]
        return self.loft(rings, kind, **kw)


def rot_y(deg):
    a = np.radians(deg); c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_x(deg):
    a = np.radians(deg); c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_z(deg):
    a = np.radians(deg); c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def cols(x, y, z):
    return np.stack([np.asarray(x, float), np.asarray(y, float), np.asarray(z, float)], 1)


# ------------------------------------------------------------------ multi-node export
def _lod_grp(ob, gid, ratio, inset=0.0004):
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


def export_multi(B, out_name, groups, empties, extras=None, res=1024, seed=1, ao_d=0.05, edge_r=0.0012, wear=1.0, dirt=1.0, root_extras=None):
    """groups: [dict(name, parent=None, t=(3,) node translation in the parent... (root frame), q=(4,) node rotation, xf=(R, t) build->root
    frame map, lod=ratio, extras={})].  Parts carry B.group = name.  empties: {name: (parent group name or None, root-frame pos, quat)}"""
    t0 = time.time()
    gid = {g['name']: i + 1 for i, g in enumerate(groups)}
    objs = []
    for p in B.parts:
        ob = p['ob']; me = ob.data; nf = len(me.polygons)
        assert p['grp'] in gid, ('part without group', p['grp'])
        a = me.attributes.new('kind', 'INT', 'FACE'); a.data.foreach_set('value', np.full(nf, WT.KIND_ID[p['kind']], np.int32))
        b = me.attributes.new('grp', 'INT', 'FACE'); b.data.foreach_set('value', np.full(nf, gid[p['grp']], np.int32))
        s = me.attributes.new('uvs', 'FLOAT', 'FACE'); s.data.foreach_set('value', np.full(nf, p['uvs'], np.float32))
        objs.append(ob)
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    WP._unwrap(ob)
    bk = WT.bake_ao_edge(ob, res // 2, edge_r=edge_r, ao_d=ao_d)
    m = bl.extract(ob, attrs=('kind', 'grp'))
    kind_tri = m['kind'][:, 0].astype(np.int32); grp_tri = m['grp'][:, 0].astype(np.int32)
    maps = WT.raster_maps(m['uv'], m['tri'], m['pos'], m['nrm'], kind_tri, res)
    from scipy import ndimage
    for k in ('AO', 'E', 'PT'):
        maps[k] = ndimage.zoom(bk[k], 2, order=1)
    alb, orm, nrm, st = WT.synth(maps, B.fx, seed=seed, wear_scale=wear, dirt_scale=dirt)
    dbg = os.path.join(CACHE, 'wtex'); os.makedirs(dbg, exist_ok=True)
    from PIL import Image
    Image.fromarray(alb).save(f'{dbg}/{out_name}_alb.png'); Image.fromarray(nrm).save(f'{dbg}/{out_name}_nrm.png')
    g = gltfw.GLB()
    orm_h = np.asarray(Image.fromarray(orm).resize((res // 2, res // 2), Image.LANCZOS))
    mat = g.material('prop_' + out_name, color=(1, 1, 1, 1), metallic=1.0, roughness=1.0,
                     base_tex=g.image(alb, 'JPEG', 90), normal_tex=g.image(nrm, 'JPEG', 92), orm_tex=g.image(orm_h, 'JPEG', 90))
    root = g.node(out_name, extras=root_extras)
    nodes = {}; info = {}
    tris = {}

    def node_frame(gs):
        R3, t3 = gs.get('xf', (np.eye(3), np.zeros(3)))
        nt = np.asarray(gs.get('t', np.zeros(3)), float); nq = np.asarray(gs.get('q', [0, 0, 0, 1.0]), float)
        return R3, np.asarray(t3, float), nt, nq

    def to_local(gs, P, N=None):
        R3, t3, nt, nq = node_frame(gs)
        Pr = P @ R3.T + t3
        iq = qinv(nq)
        Pl = qrot(np.broadcast_to(iq, (len(P), 4)), Pr - nt)
        if N is None:
            return Pl
        Nl = qrot(np.broadcast_to(iq, (len(N), 4)), N @ R3.T)
        return Pl, Nl

    for gs in groups:
        name = gs['name']
        i = gid[name]
        sel = grp_tri == i
        R3, t3, nt, nq = node_frame(gs)
        par = nodes[gs['parent']] if gs.get('parent') else root
        if gs.get('parent'):     # node transform relative to its parent (parent frames are root-frame transforms too)
            ps = next(x for x in groups if x['name'] == gs['parent'])
            _, _, pt, pq = node_frame(ps)
            lt = qrot(qinv(pq), nt - pt); lq_ = qmul(qinv(pq), nq)
        else:
            lt, lq_ = nt, nq
        nd = g.node(name, parent=par, t=[float(v) for v in lt] if np.any(np.abs(lt) > 1e-9) else None,
                    r=[float(v) for v in lq_] if np.any(np.abs(lq_ - [0, 0, 0, 1]) > 1e-9) else None, extras=gs.get('extras'))
        nodes[name] = nd
        if not sel.any():
            continue
        tri = m['tri'][sel]
        used, inv = np.unique(tri.reshape(-1), return_inverse=True)
        pl, nl = to_local(gs, m['pos'][used], m['nrm'][used])
        prim = dict(pos=pl, nrm=nl, uv=m['uv'][used], idx=inv.reshape(-1, 3), mat=mat)
        g.node(name + '_mesh', parent=nd, mesh=g.mesh(name + '_mesh', [prim]))
        tris[name + '_mesh'] = int(len(tri))
        if gs.get('lod', 0.3) > 0:
            lp = _lod_grp(ob, i, gs.get('lod', 0.3))
            lp['pos'], lp['nrm'] = to_local(gs, lp['pos'], lp['nrm'])
            lp['mat'] = mat
            g.node(name + '_LOD1', parent=nd, mesh=g.mesh(name + '_LOD1', [lp]), extras={'lod': 1})
            tris[name + '_LOD1'] = int(len(lp['idx']))
        lo = pl.min(0); hi = pl.max(0)
        info[name] = dict(bbox_local=[np.round(lo, 4).tolist(), np.round(hi, 4).tolist()], t=np.round(lt, 4).tolist(), q=np.round(lq_, 5).tolist())
    emp_out = {}
    for en, (pg, pos, q) in empties.items():
        pos = np.asarray(pos, float); q = np.asarray(q if q is not None else [0, 0, 0, 1.0], float)
        if pg:
            gs = next(x for x in groups if x['name'] == pg)
            _, _, nt, nq = node_frame(gs)
            lp_ = qrot(qinv(nq), pos - nt); lq2 = qmul(qinv(nq), q)
        else:
            lp_, lq2 = pos, q
        g.node(en, parent=nodes[pg] if pg else root, t=[float(v) for v in lp_], r=[float(v) for v in lq2] if np.any(np.abs(lq2 - [0, 0, 0, 1]) > 1e-9) else None)
        emp_out[en] = dict(parent=pg or out_name, pos=np.round(lp_, 4).tolist(), quat=np.round(lq2, 5).tolist(), pos_root=np.round(pos, 4).tolist())
    os.makedirs(OUT, exist_ok=True)
    g.save(f'{OUT}/{out_name}.glb')
    print(f'  {out_name}: {tris}  texel {st["px_per_m"]:.0f} px/m, fill {st["fill"]:.2f}, {time.time() - t0:.0f}s')
    return dict(file=f'{out_name}.glb', tris=tris, nodes=info, empties=emp_out, texel_px_per_m=round(st['px_per_m']),
                size_bytes=os.path.getsize(f'{OUT}/{out_name}.glb'))


# ------------------------------------------------------------------ shared bits
def back_frame():
    """weapon_socket_back in the bind pose: (R columns = socket axes in world, origin)"""
    R = qto_mat(qlook(LY.BACK_FWD, np.array([0, 0, -1.0])))
    return R, LY.BACK_SOCK_P.copy()


def to_back(world_R, world_t):
    """build->socket-frame map for a part placed at (world_R, world_t) in the bind pose (natural frame -> world)"""
    Rb, tb = back_frame()
    return Rb.T @ world_R, Rb.T @ (world_t - tb)


def tripod_legs(X, kind, head_y, leg_r, folded=False, flat=False, n=8):
    """3 legs from the head (hinges r 0.06) to the feet; folded: closed down along the column.  flat=True: Stugna flat-bar legs
    with claw feet + pads and struts; else Kornet tubular telescopic legs with pads"""
    for a in LY.LEG_ANG:
        d = rot_y(a) @ FW
        hinge = d * 0.062 + UP * (head_y - 0.025)
        if folded:
            foot = d * 0.07 + UP * (head_y - (0.42 if flat else 0.44))     # collapsed (telescoped) and closed
        else:
            foot = d * leg_r + UP * 0.03
        L = foot - hinge; Ln = np.linalg.norm(L); ld = L / Ln
        side = np.cross(ld, d); side /= np.linalg.norm(side)
        if flat:
            # flat bar (channel) leg: 0.040 x 0.018, slightly inset lower section, claw foot + round pad
            nrm = np.cross(side, ld)
            c = hinge + L * 0.5
            X.box(c, (0.040, 0.018, Ln), kind, rot=cols(side, nrm, ld), bevel=0.003, seg=1)
            X.box(hinge + L * 0.78, (0.046, 0.024, 0.05), kind, rot=cols(side, nrm, ld), bevel=0.002, seg=1)   # lock clamp
            X.fx(fx_dots([hinge + L * f + nrm * 0.0095 for f in (0.25, 0.35, 0.45, 0.55)], 0.004, nrm, depth=0.001, shape='hole', kinds=[kind],
                         col='#101010', colA=0.7))
            # claw foot (folded: tucked)
            fd = d if not folded else -UP
            X.prism([(-0.01, 0.0), (0.075, 0.0), (0.085, 0.03), (0.06, 0.035), (0.05, 0.012), (-0.01, 0.012)], 0.03, kind,
                    foot - fd * 0.005, fd, UP if not folded else d, bevel=0.002, seg=1)
            X.revolve([(0, 0), (0, 0.032), (0.008, 0.032), (0.012, 0.024), (0.012, 0)], kind, c=foot - (UP if not folded else -fd) * 0.028 * (0 if folded else 1),
                      axis=UP if not folded else d, n=12)
        else:
            # tubular telescopic leg: upper r 0.017, collar, lower r 0.0135, foot pad
            X.cyl(hinge, hinge + L * 0.62, 0.017, kind, n=n)
            X.cyl(hinge + L * 0.585, hinge + L * 0.665, 0.0215, kind, n=n)       # lock collar
            X.cyl(hinge + L * 0.6, hinge + L * 0.635 + ld * 0.0, 0.024, 'steel_dark', n=6)  # lever boss
            X.cyl(hinge + L * 0.6, foot - ld * 0.02, 0.0135, 'steel_dark' if kind == 'kgreen' else kind, n=n)
            pad_ax = UP if not folded else -ld
            X.revolve([(0, 0), (0, 0.034), (0.010, 0.034), (0.016, 0.018), (0.035, 0.012), (0.035, 0)], kind,
                      c=foot - pad_ax * 0.02 if folded else foot - UP * 0.03, axis=pad_ax, n=10)
        # hinge lug at the head
        X.box(hinge + UP * 0.005, (0.036, 0.04, 0.036), kind, rot=cols(side, np.cross(d, side), d), bevel=0.003, seg=1)
        X.cyl(hinge - side * 0.022, hinge + side * 0.022, 0.009, 'steel', n=6)


# ------------------------------------------------------------------ 9M133 TLC
def kornet_tlc(X, c, kind='tlc', n=16, handle=True):
    """9M133 transport-launch container centred at c, axis +Z: olive body, black rubber end rings, beige front membrane,
    clamp bands with mounting lugs (bottom), carry handle, connector box, stencils"""
    K = LY.KORNET
    hl = K['tube_len'] / 2; r = K['tube_r']; re = K['tube_r_end']
    cz = np.asarray(c, float)

    def rv(prof, kd, nn=n, **kw):
        return X.revolve([(z, rr) for z, rr in prof], kd, c=cz, axis=FW, n=nn, **kw)
    rv([(-hl + 0.050, r - 0.004), (-hl + 0.050, r), (hl - 0.058, r), (hl - 0.058, r - 0.004)], kind)
    # end rings (rubber) + front membrane + rear cap
    rv([(hl - 0.064, r - 0.002), (hl - 0.060, re), (hl - 0.004, re), (hl, re - 0.004), (hl, re - 0.012), (hl - 0.010, re - 0.014)], 'rubber')
    rv([(hl - 0.010, re - 0.0135), (hl - 0.010, 0.0)], 'membrane', nn=n)
    rv([(-hl + 0.056, r - 0.002), (-hl + 0.052, re), (-hl + 0.004, re), (-hl, re - 0.005), (-hl, 0.0)], 'rubber')
    X.fx(fx_dots([cz + FW * hl * 0.0 + BK * (hl + 0.0005)], 0.03, BK, depth=0.0015, shape='ring', kinds=['rubber'], facing=0.5))
    X.fx(fx_pattern(cz + BK * (hl + 0.0005), BK, UP, 0.14, 0.14, pat_ribs(0.012, 0.35, 0), depth=0.0006, kinds=['rubber'], facing=0.6))
    # clamp bands with lugs (match the cradle saddles) + small raised rings
    for zb in (-0.405, -0.205):
        rv([(zb - 0.016, r - 0.002), (zb - 0.016, r + 0.004), (zb + 0.016, r + 0.004), (zb + 0.016, r - 0.002)], kind)
        X.box(cz + FW * zb + DN * (r + 0.006), (0.034, 0.012, 0.034), kind, bevel=0.002, seg=1)
    for zb in (0.30, 0.42):
        rv([(zb - 0.006, r - 0.001), (zb - 0.006, r + 0.0018), (zb + 0.006, r + 0.0018), (zb + 0.006, r - 0.001)], kind, nn=n)
    if handle:
        # carry handle on top between the bands (bar on two posts)
        y0 = r + 0.002
        for zz in (-0.36, -0.15):
            X.box(cz + FW * zz + UP * (y0 + 0.016), (0.016, 0.034, 0.016), kind, bevel=0.002, seg=1)
        X.cyl(cz + FW * -0.37 + UP * (y0 + 0.034), cz + FW * -0.14 + UP * (y0 + 0.034), 0.0085, 'rubber', n=8)
    # connector housing under the rear
    X.box(cz + FW * (-hl + 0.12) + DN * (r + 0.012) + XL * 0.0, (0.05, 0.028, 0.06), kind, bevel=0.003, seg=1)
    X.cyl(cz + FW * (-hl + 0.12) + DN * (r + 0.026), cz + FW * (-hl + 0.12) + DN * (r + 0.040), 0.010, 'steel_dark', n=8)
    # stencils both sides + band
    for sx in (1, -1):
        X.fx(fx_text('9М133-1', cz + XL * sx * r + FW * 0.05 + UP * 0.012, XL * sx, UP, 0.020, col='#121212', colA=0.85, kinds=[kind], facing=0.55, thick=0.03))
        X.fx(fx_text('ПАРТИЯ 03-19  № 1146', cz + XL * sx * r + FW * 0.05 + DN * 0.020, XL * sx, UP, 0.008, col='#121212', colA=0.8, kinds=[kind], facing=0.55, thick=0.03))
        X.fx(fx_text('◄ НАПРАВЛЕНИЕ ПУСКА', cz + XL * sx * r + FW * -0.30 + DN * 0.010, XL * sx, UP, 0.0085, col='#121212', colA=0.75, kinds=[kind], facing=0.55, thick=0.03))
    X.fx(fx_cyl_bands(cz, FW, 0.18, 0.205, r, '#b39a2a', kinds=[kind]))
    X.fx(fx_cyl_bands(cz, FW, -0.52, -0.505, r, '#141414', kinds=[kind]))
    X.fx([fx_line(cz + np.array([r * np.cos(a), r * np.sin(a), -hl + 0.06]), cz + np.array([r * np.cos(a), r * np.sin(a), hl - 0.07]),
                  np.array([np.cos(a), np.sin(a), 0]), 0.003, depth=0.00025, kinds=[kind], facing=0.6) for a in np.linspace(0, 2 * np.pi, 7)[:-1]])


def stugna_tlc(X, c, kind='fibre', n=16, handle=True):
    """R-2 TLC (Stugna-P 130 mm): filament-wound olive tube, big black end caps, raised rings, carry handle, mount block"""
    K = LY.STUGNA
    hl = K['tube_len'] / 2; r = K['tube_r']; re = K['tube_r_end']
    cz = np.asarray(c, float)

    def rv(prof, kd, nn=n, **kw):
        return X.revolve([(z, rr) for z, rr in prof], kd, c=cz, axis=FW, n=nn, **kw)
    rv([(-hl + 0.07, r - 0.004), (-hl + 0.07, r), (hl - 0.08, r + 0.004), (hl - 0.08, r)], kind)
    # front cap: large black cap with a recessed face; rear cap
    rv([(hl - 0.095, r - 0.002), (hl - 0.085, re), (hl - 0.006, re), (hl, re - 0.006), (hl, re - 0.022), (hl - 0.008, re - 0.024), (hl - 0.008, 0)], 'rubber', nn=n + 2)
    rv([(-hl + 0.085, r - 0.002), (-hl + 0.075, re - 0.006), (-hl + 0.004, re - 0.006), (-hl, re - 0.012), (-hl, 0.0)], 'rubber')
    X.fx(fx_dots([cz + FW * (hl + 0.0002)], 0.055, FW, depth=0.0015, shape='ring', kinds=['rubber'], facing=0.6))
    for zb in (-0.33, 0.05, 0.38):
        rv([(zb - 0.012, r - 0.001), (zb - 0.012, r + 0.0045), (zb + 0.012, r + 0.0045), (zb + 0.012, r - 0.001)], kind, nn=n)
    # mount block (bottom, mates with the yoke saddle) + rear electrical plug
    X.box(cz + DN * (r + 0.004) + FW * -0.02, (0.05, 0.02, 0.16), kind, bevel=0.003, seg=1)
    X.box(cz + XR * (r + 0.006) + FW * (-hl + 0.16), (0.024, 0.04, 0.05), kind, bevel=0.003, seg=1)
    if handle:
        X.strap([cz + UP * (r + 0.004) + FW * -0.20, cz + UP * (r + 0.030) + FW * -0.15, cz + UP * (r + 0.034) + FW * -0.02,
                 cz + UP * (r + 0.030) + FW * 0.10, cz + UP * (r + 0.004) + FW * 0.15], 0.03, 0.006, 'webbing', up=UP, uvs=0.6)
        for zz in (-0.20, 0.15):
            X.box(cz + UP * (r + 0.004) + FW * zz, (0.04, 0.008, 0.02), 'steel_dark', bevel=0.001, seg=1)
    for sx in (1, -1):
        X.fx(fx_text('Р-2', cz + XL * sx * r + FW * 0.15 + UP * 0.010, XL * sx, UP, 0.024, col='#d8c25a', colA=0.9, kinds=[kind], facing=0.55, thick=0.03))
        X.fx(fx_text('ПТКР 130 мм  ЛОТ 07-21  № 0218', cz + XL * sx * r + FW * 0.15 + DN * 0.022, XL * sx, UP, 0.0075, col='#d8c25a', colA=0.85, kinds=[kind], facing=0.55, thick=0.03))
        X.fx(fx_text('ОБЕРЕЖНО! ЗАДНЯ НЕБЕЗПЕЧНА ЗОНА', cz + XL * sx * r + FW * -0.42 + DN * 0.004, XL * sx, UP, 0.0075, col='#d8c25a', colA=0.85, kinds=[kind], facing=0.55, thick=0.03))
    X.fx(fx_cyl_bands(cz, FW, -0.55, -0.53, r, '#a8922c', kinds=[kind]))
    X.fx([fx_line(cz + np.array([r * np.cos(a), r * np.sin(a), -hl + 0.08]), cz + np.array([r * np.cos(a), r * np.sin(a), hl - 0.09]),
                  np.array([np.cos(a), np.sin(a), 0]), 0.0025, depth=0.0002, kinds=[kind], facing=0.6) for a in np.linspace(0, 2 * np.pi, 11)[:-1]])


# ------------------------------------------------------------------ Kornet launcher (deployed or folded) in the launcher frame
def kornet_launcher(X, folded=False):
    """9P163-1 tripod + pedestal + 1P45M guidance device + 1PN79 thermal imager + control handles (launcher frame:
    origin = pedestal axis on the ground).  Everything above the tripod head is identical in the folded variant."""
    K = LY.KORNET; L0 = K['L0']
    hy = K['head_y']
    A = LY.TUBE_Y
    g2l = lambda p: np.asarray(p, float) - L0
    tripod_legs(X, 'kgreen', hy, K['leg_r'], folded=folded)
    # head + column (pedestal) + rotary ring
    X.revolve([(0, 0), (0, 0.066), (0.012, 0.072), (0.060, 0.072), (0.068, 0.060), (0.068, 0)], 'kgreen', c=(0, hy - 0.05, 0), axis=UP, n=12)
    X.revolve([(0, 0.052), (0.16, 0.050), (0.16, 0.0)], 'kgreen', c=(0, hy + 0.01, 0), axis=UP, n=12)
    X.revolve([(0, 0), (0, 0.068), (0.045, 0.068), (0.05, 0.06), (0.05, 0)], 'kgreen', c=(0, hy + 0.17, 0), axis=UP, n=14)
    X.fx(fx_text('9П163М-1', (0.0, hy + 0.10, 0.0505), FW, UP, 0.010, col='#151515', colA=0.85, kinds=['kgreen'], facing=0.5, thick=0.02))
    X.fx(fx_text('№ 0 2 2 0 2 1', (0.0, hy + 0.082, 0.0505), FW, UP, 0.006, col='#151515', colA=0.8, kinds=['kgreen'], facing=0.5, thick=0.02))
    # traverse lock lever (right rear) + azimuth scale ring
    X.cyl((-0.04, hy + 0.12, -0.03), (-0.115, hy + 0.12, -0.075), 0.007, 'steel_dark', n=6)
    X.cyl((-0.115, hy + 0.12, -0.075), (-0.135, hy + 0.12, -0.087), 0.012, 'rubber', n=8)
    X.fx(fx_cyl_bands((0, hy + 0.17, 0), UP, 0.035, 0.045, 0.068, '#d8d4c4', colA=0.35, kinds=['kgreen']))
    # elevation yoke + trunnion + handwheel (left)
    ytop = hy + 0.22
    X.box((0, ytop + 0.03, -0.02), (0.13, 0.06, 0.13), 'kgreen', bevel=0.006, seg=1)
    for sx in (1, -1):
        X.revolve([(0, 0), (0, 0.042), (0.016, 0.042), (0.02, 0.034), (0.02, 0)], 'kgreen', c=(sx * 0.064, ytop + 0.065, -0.02), axis=XL * sx, n=12)
    X.revolve([(0, 0.044), (0.008, 0.050), (0.016, 0.050), (0.024, 0.044), (0.024, 0.036), (0.004, 0.036)], 'steel_dark', c=(0.105, ytop + 0.03, -0.02), axis=XL, n=14)
    for k in range(3):
        a = k * 2 * np.pi / 3
        X.cyl((0.112, ytop + 0.03, -0.02), (0.112, ytop + 0.03 + 0.042 * np.sin(a), -0.02 + 0.042 * np.cos(a)), 0.004, 'steel_dark', n=5)
    X.cyl((0.12, ytop + 0.03 + 0.04, -0.02), (0.15, ytop + 0.03 + 0.04, -0.02), 0.008, 'rubber', n=8)
    # 1P45M guidance device: box under the TLC rear, eyepiece at the gunner's eye
    eye = g2l(LY.EYE)
    bx0, bx1 = -0.095, 0.095
    by0, by1 = A - 0.31, A - 0.085
    bz0, bz1 = g2l([0, 0, 0.41])[2], g2l([0, 0, 0.72])[2]
    bc = np.array([(bx0 + bx1) / 2, (by0 + by1) / 2, (bz0 + bz1) / 2])
    X.box(bc, (bx1 - bx0, by1 - by0, bz1 - bz0), 'kbeige', bevel=0.008, seg=2)
    X.box(bc + UP * ((by1 - by0) / 2 - 0.006) + BK * 0.02, (bx1 - bx0 - 0.03, 0.02, bz1 - bz0 - 0.08), 'kbeige', bevel=0.004, seg=1)   # top rib
    # front: twin objective windows in a hood
    X.box((0, A - 0.19, bz1 + 0.012), (0.15, 0.085, 0.026), 'kbeige', bevel=0.005, seg=1)
    for sx in (1, -1):
        X.revolve([(0, 0.026), (0.004, 0.026), (0.004, 0.0)], 'glass', c=(sx * 0.034, A - 0.19, bz1 + 0.025), axis=FW, n=12, uvs=0.6)
    # eyepiece + rubber eyecup (rear)
    X.revolve([(0, 0.030), (0.035, 0.024), (0.035, 0.0)], 'kbeige', c=(eye[0], eye[1], bz0), axis=BK, n=12)
    X.revolve([(0, 0.0255), (0.006, 0.030), (0.026, 0.032), (0.034, 0.030), (0.036, 0.024), (0.03, 0.019), (0.03, 0.0)], 'rubber',
              c=(eye[0], eye[1], bz0 - 0.03), axis=BK, n=14)
    X.revolve([(0.0, 0.015), (0.0, 0.0)], 'glass', c=(eye[0], eye[1], bz0 - 0.032), axis=BK, n=10, uvs=0.5)
    # side panels: latches, screws, data plate, cable socket
    X.fx(fx_rect(bc + XL * 0.095 + UP * 0.02, XL, UP, 0.20, 0.12, depth=0.0008, mode='frame', kinds=['kbeige']))
    X.fx(fx_dots([bc + XL * 0.0952 + np.array([0, dy, dz]) for dy in (-0.07, 0.07) for dz in (-0.12, 0.12)], 0.004, XL, depth=0.0006, shape='ring', kinds=['kbeige']))
    X.fx(fx_text('1П45М-1', bc + XL * 0.0952 + UP * 0.03, XL, UP, 0.010, col='#141414', colA=0.85, kinds=['kbeige'], facing=0.5, thick=0.02))
    X.fx(fx_rect(bc + XL * 0.0952 + DN * 0.04, XL, UP, 0.06, 0.025, mode='flat', col='#2a2a26', colA=0.6, kinds=['kbeige']))
    # TLC cradle saddles on top (the tube lugs sit in them)
    tc, _ = LY.tube_mount('kornet')
    for zb in (-0.405, -0.205):
        z = tc[2] + zb
        X.box((0, by1 + 0.012, z), (0.06, 0.024, 0.04), 'kgreen', bevel=0.003, seg=1)
        for sx in (1, -1):
            X.box((sx * 0.05, A - 0.055, z), (0.012, 0.05, 0.034), 'kgreen', bevel=0.002, seg=1, rot=rot_z(sx * 25))
    X.cyl((0.09, by1 - 0.01, tc[2] - 0.405), (0.12, by1 + 0.005, tc[2] - 0.405), 0.007, 'steel_dark', n=6)   # latch lever
    # 1PN79 thermal imager on the right side: box + round objective cover + cable
    tx0, tx1 = -0.225, -0.097
    ty0, ty1 = A - 0.29, A - 0.115
    tz0, tz1 = bz0 + 0.02, bz1 + 0.01
    tcen = np.array([(tx0 + tx1) / 2, (ty0 + ty1) / 2, (tz0 + tz1) / 2])
    X.box(tcen, (tx1 - tx0, ty1 - ty0, tz1 - tz0), 'kbeige', bevel=0.01, seg=2)
    X.revolve([(0, 0.052), (0.02, 0.055), (0.026, 0.052), (0.028, 0.0)], 'kbeige', c=(tcen[0], tcen[1] + 0.005, tz1), axis=FW, n=16)
    X.fx(fx_dots([(tcen[0], tcen[1] + 0.005, tz1 + 0.028)], 0.04, FW, depth=0.001, shape='ring', kinds=['kbeige'], facing=0.6))
    X.box((tcen[0] - 0.06, tcen[1], tz0 + 0.05), (0.02, 0.06, 0.05), 'kbeige', bevel=0.004, seg=1)
    X.fx(fx_text('1ПН79', tcen + XR * 0.064 + UP * 0.03, XR, UP, 0.010, col='#141414', colA=0.85, kinds=['kbeige'], facing=0.5, thick=0.02))
    X.pipe([(tcen[0] + 0.03, ty0 + 0.01, tz0 + 0.03), (tcen[0] + 0.05, ty0 - 0.03, tz0 + 0.02), (0.0, ytop + 0.05, -0.08), (-0.03, ytop + 0.04, -0.04)], 0.006, 'cable', n=6)
    # control handles (the gunner's hands): vertical grips under the device, brackets up to the box / imager
    for G, sgn in ((LY.GRIP_R, -1), (LY.GRIP_L, 1)):
        gp = g2l(G) - sgn * XL * LY.HANDLE_OFF          # handle axis: palm centre + palm normal * 12 mm
        top = np.array([gp[0], by0 + 0.005, gp[2]])
        X.cyl(gp + DN * 0.055 + FW * 0.006, gp + UP * 0.045 - FW * 0.004, 0.0175, 'rubber', n=10)
        X.box(gp + UP * 0.056, (0.05, 0.016, 0.05), 'kgreen', bevel=0.003, seg=1)
        att = np.array([sgn * 0.09 if sgn > 0 else gp[0], by0 + 0.01, gp[2]])
        X.box((gp + att) / 2 + UP * 0.03, (abs(att[0] - gp[0]) + 0.03, 0.02 + abs(att[1] - gp[1] - 0.06), 0.03), 'kgreen', bevel=0.003, seg=1)
        X.cyl(gp + UP * 0.048 + FW * 0.012, gp + UP * 0.048 + FW * 0.024, 0.006, 'red' if sgn < 0 else 'steel_dark', n=6)    # launch button / lock
    return dict(eye=eye, box=(bx0, bx1, by0, by1, bz0, bz1))


def kornet():
    B = Builder()
    K = LY.KORNET
    tc, _ = LY.tube_mount('kornet')
    B.group = 'kornet_tripod'
    X = XB(B)
    kornet_launcher(X)
    B.group = 'kornet_tube'
    kornet_tlc(X, tc)
    # folded tripod: built 3 m to the side (own AO), natural frame = launcher frame, then mapped into weapon_socket_back:
    # carried diagonally on the back, the sight box low (small of the back), legs up past the right shoulder, on top of a slung rifle
    off = np.array([3.0, 0.0, 0.0])
    B.group = 'folded'
    XF = XB(B, np.eye(3), off)
    kornet_launcher(XF, folded=True)
    xf_f, folded_world = folded_to_back('kornet', off)
    empties = launcher_empties('kornet')
    groups = [dict(name='kornet_tripod', lod=0.3, extras={'part': 'deployed tripod + pedestal + 1P45M sight + 1PN79 thermal'}),
              dict(name='kornet_tube', t=tc, lod=0.3, extras={'part': '9M133 TLC on the cradle; hide on launch / reload, see manifest'}),
              dict(name='folded', xf=xf_f, lod=0.3, extras={'default_visible': False, 'part': 'tripod collapsed for carrying, authored in the '
                                                             'weapon_socket_back frame (parent there with identity)'})]
    empties.update(muzzle=('kornet_tube', tc + FW * (K['tube_len'] / 2), None),
                   tube_rear=('kornet_tube', tc + BK * (K['tube_len'] / 2), [0, 1, 0, 0]))
    info = export_multi(B, 'kornet', groups, empties, res=1024, root_extras={'system': '9K135 Kornet', 'tlc': '9M133', 'length_tlc_m': K['tube_len']})
    info['folded_world_bind'] = folded_world
    return info


def folded_to_back(kind, off):
    """map for the folded launcher (built at launcher frame + off) into the weapon_socket_back frame (atgm_layout.folded_world:
    upright on the back, sight head behind the right shoulder blade, legs down to the left, firing side facing backwards)"""
    Rs, ts = LY.folded_nat_to_sock(kind)
    Rw, tw = LY.folded_world(kind)
    # build space point p -> natural (p - off) -> socket frame
    return (Rs, ts - Rs @ off), dict(R=Rw.tolist(), t=tw.tolist())


def launcher_empties(kind):
    """seat / gunner_ref / grips / loader / TLC spots (launcher frame)"""
    K = LY.K(kind)
    L0 = K['L0']
    return {
        'seat': (None, -L0 * [1, 0, 1], None),                        # gunner root (soldier position + heading) for atgm_setup/aim/fire/pack
        'gunner_ref': (None, LY.EYE - L0, None),                      # gunner's right eye in atgm_aim
        'grip_R': (None, LY.GRIP_R - L0, None), 'grip_L': (None, LY.GRIP_L - L0, None),      # palm centres on the control grips
        'loader_seat': (None, LY.loader_root(kind), qaxis(UP, np.radians(LY.LOADER_HEADING))),   # loader root + heading for atgm_reload
        'tube_ground': (None, LY.tube_ground(kind), None),           # fresh TLC lying on the ground (TLC node transform) for atgm_reload
        'tube_spent': (None, LY.tube_spent(kind), qaxis(UP, np.radians(LY.SPENT_YAW))),          # where atgm_reload lays the spent TLC
        'tube_setup': (None, LY.tube_setup(kind), None),             # TLC the gunner picks up in atgm_setup / lays down in atgm_pack
    }


# ------------------------------------------------------------------ Stugna-P
def stugna_launcher(X, folded=False):
    """Stugna-P launcher: flat-bar tripod with claw feet + struts, electronics box, rotary unit, yoke with the PN-S guidance
    unit left of the TLC, front T-bracket (launcher frame)"""
    S = LY.STUGNA; L0 = S['L0']
    hy = S['head_y']; A = LY.TUBE_Y
    tc, _ = LY.tube_mount('stugna')
    tripod_legs(X, 'sgreen', hy, S['leg_r'], folded=folded, flat=True)
    # head plate (triangular-ish) + short column below with struts to the legs
    X.revolve([(0, 0), (0, 0.085), (0.03, 0.085), (0.03, 0)], 'sgreen', c=(0, hy - 0.03, 0), axis=UP, n=6, a0=np.pi / 6)
    X.cyl((0, hy - 0.03, 0), (0, hy - 0.26, 0), 0.022, 'sgreen', n=8)
    for a in LY.LEG_ANG:
        d = rot_y(a) @ FW
        hinge = d * 0.062 + UP * (hy - 0.025)
        foot = (d * 0.07 + UP * (hy - 0.42)) if folded else (d * S['leg_r'] + UP * 0.03)
        mid = hinge + (foot - hinge) * 0.42
        X.cyl((0, hy - 0.24, 0) + d * 0.02, mid - d * 0.012, 0.008, 'sgreen', n=6)
    # electronics box (camo cover in the field photos -> plain painted box here) + rotary unit
    ey0, ey1 = hy + 0.005, hy + 0.25
    X.box((0, (ey0 + ey1) / 2, -0.01), (0.30, ey1 - ey0, 0.29), 'sgreen', bevel=0.006, seg=2)
    X.box((0, ey1 - 0.03, -0.01), (0.306, 0.012, 0.296), 'sgreen', bevel=0.003, seg=1)                         # lid rim
    for sx_ in (1, -1):                                                                                            # side carry handles
        for zz in (-0.08, 0.06):
            X.box((sx_ * 0.158, (ey0 + ey1) / 2 + 0.04, zz), (0.016, 0.02, 0.016), 'steel_dark', bevel=0.002, seg=1)
        X.cyl((sx_ * 0.168, (ey0 + ey1) / 2 + 0.04, -0.09), (sx_ * 0.168, (ey0 + ey1) / 2 + 0.04, 0.07), 0.006, 'steel_dark', n=6)
    X.fx(fx_line((-0.15, ey1 - 0.04, 0.136), (0.15, ey1 - 0.04, 0.136), FW, 0.003, depth=0.0006, kinds=['sgreen'], facing=0.5))
    X.fx(fx_rect((0, (ey0 + ey1) / 2, 0.136), FW, UP, 0.26, 0.20, depth=0.0008, mode='frame', kinds=['sgreen']))
    X.fx(fx_dots([(x, y, 0.1355) for x in (-0.12, 0.12) for y in (ey0 + 0.03, ey1 - 0.03)], 0.004, FW, depth=0.0006, shape='ring', kinds=['sgreen']))
    X.fx(fx_dots([(0.1505, (ey0 + ey1) / 2 + dy, dz) for dy in (-0.08, 0.08) for dz in (-0.11, 0.09)], 0.004, XL, depth=0.0006, shape='ring', kinds=['sgreen']))
    X.revolve([(0, 0.0), (0, 0.016), (0.02, 0.016), (0.02, 0)], 'steel_dark', c=(0.15, (ey0 + ey1) / 2 - 0.05, 0.06), axis=XL, n=10)   # connector
    X.revolve([(0, 0.0), (0, 0.012), (0.012, 0.012), (0.012, 0)], 'plastic_lt', c=(0.15, (ey0 + ey1) / 2 + 0.03, 0.06), axis=XL, n=8)  # switch
    X.fx(fx_rect((0.1503, ey1 - 0.035, -0.06), XL, UP, 0.05, 0.016, mode='flat', col='#202020', colA=0.7, kinds=['sgreen']))
    X.revolve([(0, 0), (0, 0.075), (0.045, 0.072), (0.05, 0.06), (0.05, 0)], 'sgreen', c=(0, ey1, 0), axis=UP, n=14)
    X.revolve([(0, 0.042), (0.06, 0.042), (0.06, 0)], 'steel_dark', c=(0, ey1 + 0.05, 0), axis=UP, n=10)
    # yoke / cradle: horizontal plate under the tube + PN-S unit (left of the tube)
    yb = ey1 + 0.11
    X.box((0.06, yb, tc[2] - 0.02), (0.26, 0.025, 0.24), 'sgreen', bevel=0.004, seg=1)
    X.box((0.0, (yb + A - 0.08) / 2, tc[2] - 0.02), (0.05, A - 0.08 - yb, 0.17), 'sgreen', bevel=0.004, seg=1)   # tube saddle post
    # PN-S guidance unit (left of the TLC): two-tier body (deeper optics block in front, electronics block behind), sun-hood frame
    # round the front face with the big thermal objective (protruding, rubber sunshade ring), TV / laser windows, carry handle on
    # top, cooling ribs + latches on the sides, rear connector panel
    gx = 0.075 + 0.095
    gy0, gy1 = yb + 0.015, A + 0.06
    gz0, gz1 = tc[2] - 0.20, tc[2] + 0.13
    gcen = np.array([gx, (gy0 + gy1) / 2, (gz0 + gz1) / 2])
    gh = gy1 - gy0
    X.box(gcen + FW * 0.035, (0.19, gh, gz1 - gz0 - 0.07), 'sgreen', bevel=0.008, seg=2)                      # optics block
    X.box(gcen + BK * ((gz1 - gz0) / 2 - 0.04) + DN * 0.02, (0.17, gh - 0.05, 0.08), 'sgreen', bevel=0.006, seg=2)   # rear electronics block
    X.box(gcen + UP * (gh / 2 + 0.006) + FW * 0.03, (0.16, 0.012, gz1 - gz0 - 0.12), 'sgreen', bevel=0.003, seg=1)   # top rib
    hz = gz1 + 0.035                                                                                              # hood: frame, open front
    for sx_ in (1, -1):
        X.box((gx + sx_ * 0.091, gcen[1], hz), (0.008, gh, 0.07), 'sgreen', bevel=0.002, seg=1)
    X.box((gx, gy1 - 0.004, hz + 0.006), (0.19, 0.008, 0.082), 'sgreen', bevel=0.002, seg=1)
    X.box((gx, gy0 + 0.004, hz - 0.01), (0.19, 0.008, 0.05), 'sgreen', bevel=0.002, seg=1)
    X.box((gx, gcen[1], gz1 + 0.004), (0.175, gh - 0.012, 0.008), 'plastic', bevel=0.001, seg=1)                 # dark front plate
    tcx, tcy = gx + 0.028, gcen[1] + 0.035                                                                        # thermal objective
    X.revolve([(0.0, 0.050), (0.006, 0.052), (0.040, 0.050), (0.046, 0.044), (0.046, 0.034), (0.040, 0.034), (0.040, 0.0)], 'rubber',
              c=(tcx, tcy, gz1 + 0.006), axis=FW, n=16)
    X.revolve([(0.0, 0.035), (0.0, 0.0)], 'glass', c=(tcx, tcy, gz1 + 0.040), axis=FW, n=14, uvs=0.6)
    for (wx, wy, wr) in ((gx - 0.045, gcen[1] - 0.02, 0.020), (gx - 0.04, gcen[1] - 0.075, 0.012), (gx + 0.035, gcen[1] - 0.07, 0.014)):
        X.revolve([(0, wr + 0.005), (0.012, wr + 0.005), (0.012, wr), (0.008, wr), (0.008, 0.0)], 'plastic_lt', c=(wx, wy, gz1 + 0.006), axis=FW, n=10)
        X.revolve([(0.0, wr), (0.0, 0.0)], 'glass', c=(wx, wy, gz1 + 0.0145), axis=FW, n=10, uvs=0.5)
    for zz in (gz0 + 0.06, gz1 - 0.08):                                                                          # carry handle
        X.box((gx, gy1 + 0.02, zz), (0.025, 0.03, 0.02), 'sgreen', bevel=0.002, seg=1)
    X.cyl((gx, gy1 + 0.038, gz0 + 0.05), (gx, gy1 + 0.038, gz1 - 0.07), 0.008, 'rubber', n=8)
    for sx_ in (1, -1):
        X.fx(fx_pattern(gcen + XL * sx_ * 0.0955 + BK * 0.06 + UP * 0.01, XL * sx_, UP, 0.10, gh - 0.08, pat_ribs(0.01, 0.4, 1), depth=0.0012,
                        kinds=['sgreen'], facing=0.5))
        for zz in (gz0 + 0.07, gz1 - 0.06):
            X.box(gcen + XL * sx_ * 0.097 + np.array([0, -gh / 2 + 0.03, zz - gcen[2]]), (0.006, 0.03, 0.018), 'steel_dark', bevel=0.001, seg=1)
    X.fx(fx_text('ПН-С', gcen + XL * 0.0957 + UP * 0.07 + FW * 0.05, XL, UP, 0.012, col='#d8d2b0', colA=0.75, kinds=['sgreen'], facing=0.5, thick=0.02))
    X.revolve([(0, 0.0), (0, 0.016), (0.02, 0.016), (0.02, 0)], 'steel_dark', c=(gx - 0.03, gcen[1] - 0.03, gz0 - 0.002), axis=BK, n=10)   # rear connector
    X.box((gx + 0.03, gcen[1] + 0.03, gz0 - 0.002), (0.06, 0.04, 0.006), 'plastic', bevel=0.001, seg=1)
    # U-cradle under the TLC (side plates of the saddle) + clamp latch
    for sx_ in (1, -1):
        X.box((sx_ * 0.05, A - 0.07, tc[2] - 0.02), (0.01, 0.07, 0.15), 'sgreen', bevel=0.002, seg=1, rot=rot_z(sx_ * 20))
    X.cyl((-0.07, A - 0.09, tc[2] + 0.04), (-0.10, A - 0.07, tc[2] + 0.04), 0.007, 'steel_dark', n=6)
    # front T/L bracket beside the tube (as on the photos) + cable from the PN-S to the electronics box
    X.box((0.075 - 0.02, A - 0.05, gz1 + 0.01), (0.03, 0.13, 0.03), 'sgreen', bevel=0.004, seg=1)
    X.box((0.075 - 0.045, A - 0.105, gz1 + 0.01), (0.08, 0.03, 0.03), 'sgreen', bevel=0.004, seg=1)
    X.pipe([(gx - 0.05, gy0 + 0.01, gz0 + 0.03), (gx - 0.06, gy0 - 0.06, gz0 + 0.02), (0.13, ey1 - 0.02, -0.12), (0.15, ey1 - 0.06, -0.10)], 0.006, 'cable', n=6)
    # traverse / elevation hand knobs (right side of the rotary unit)
    X.cyl((-0.05, ey1 + 0.035, 0.0), (-0.12, ey1 + 0.035, 0.0), 0.006, 'steel_dark', n=6)
    X.cyl((-0.12, ey1 + 0.035, 0.0), (-0.14, ey1 + 0.035, 0.0), 0.013, 'rubber', n=8)
    return dict(yb=yb, ey1=ey1)


def stugna_control(X):
    """PDU-style remote control unit: rugged case (base with keypad + two side grips, lid = display with a sun hood) on a
    short tripod; positioned so the shared atgm_aim pose has the eye ~0.3 m in front of the screen and the palms on the grips
    (gunner frame -> launcher frame via L0).  Returns the unit origin (its tripod centre on the ground)."""
    S = LY.STUGNA; L0 = S['L0']
    g2l = lambda p: np.asarray(p, float) - L0
    gr, gl = g2l(LY.GRIP_R) + XL * LY.HANDLE_OFF, g2l(LY.GRIP_L) - XL * LY.HANDLE_OFF     # grip axes (palm centres + 12 mm)
    o = g2l(S['ctrl'])
    by = gr[1] - 0.045                     # base top
    z0, z1 = gr[2] - 0.06, gr[2] + 0.17   # base depth range
    xc = (gr[0] + gl[0]) / 2
    # tripod: column + three short splayed legs
    X.cyl((xc, 0.30, o[2] + 0.02), (xc, by - 0.07, o[2] + 0.02), 0.012, 'steel_dark', n=8)
    X.cyl((xc, 0.14, o[2] + 0.02), (xc, 0.31, o[2] + 0.02), 0.016, 'case', n=8)
    for a in (30.0, 150.0, 270.0):
        d = rot_y(a) @ FW
        X.cyl(np.array([xc, 0.16, o[2] + 0.02]) + d * 0.015, np.array([xc, 0.012, o[2] + 0.02]) + d * 0.22, 0.008, 'case', n=6)
        X.revolve([(0, 0), (0, 0.016), (0.008, 0.014), (0.008, 0)], 'rubber', c=np.array([xc, 0.0, o[2] + 0.02]) + d * 0.22, axis=UP, n=8)
    X.box((xc, by - 0.065, o[2] + 0.02), (0.08, 0.02, 0.08), 'case', bevel=0.003, seg=1)
    # base (case bottom half) with keypad + trackball, two grips on the sides
    bw = (gl[0] - gr[0]) - 0.06
    X.box((xc, by - 0.028, (z0 + z1) / 2), (bw, 0.056, z1 - z0), 'case', bevel=0.007, seg=2)
    X.box((xc, by + 0.001, (z0 + z1) / 2 - 0.01), (bw - 0.04, 0.004, z1 - z0 - 0.05), 'plastic', bevel=0.0015, seg=1)
    X.fx(fx_pattern((xc - 0.03, by + 0.0032, z0 + 0.07), UP, FW, 0.12, 0.06, pat_checker(0.012), depth=0.0008, kinds=['plastic'], facing=0.6))
    X.revolve([(0, 0.0), (0, 0.014), (0.006, 0.012), (0.008, 0.0)], 'plastic_lt', c=(xc + 0.075, by + 0.003, z0 + 0.07), axis=UP, n=10)   # joystick / trackball
    X.cyl((xc + 0.075, by + 0.006, z0 + 0.07), (xc + 0.075, by + 0.04, z0 + 0.07), 0.005, 'plastic', n=6)
    X.revolve([(0, 0.0), (0, 0.009), (0.012, 0.009), (0.014, 0.0)], 'rubber', c=(xc + 0.075, by + 0.038, z0 + 0.07), axis=UP, n=8)
    X.cyl((xc - 0.10, by + 0.003, z0 + 0.035), (xc - 0.10, by + 0.012, z0 + 0.035), 0.008, 'red', n=8)    # launch button
    for G in (gr, gl):
        X.cyl(G + DN * 0.05 + BK * 0.01, G + UP * 0.04 + FW * 0.01, 0.017, 'rubber', n=10)
        X.box((G[0] * 0.85 + xc * 0.15, G[1] + 0.03, G[2]), (abs(G[0] - xc) * 0.3 + 0.03, 0.02, 0.04), 'case', bevel=0.003, seg=1)
    # lid = display, hinged at the far edge, leaning back 14 deg, with a sun hood toward the operator
    hz = z1 - 0.01
    lid_h = 0.21
    lup = np.array([0, np.cos(np.radians(14)), np.sin(np.radians(14))])
    lfw = np.cross(lup, XL)        # screen normal toward the operator (-Z, up 14 deg)
    lc = np.array([xc, by + 0.01, hz]) + lup * lid_h / 2
    X.box(lc - lfw * 0.012, (bw, lid_h, 0.024), 'case', rot=cols(XL, lup, -lfw), bevel=0.006, seg=2)
    X.box(lc + lfw * 0.0005, (bw - 0.05, lid_h - 0.05, 0.004), 'glass', rot=cols(XL, lup, -lfw), bevel=0.0, seg=1, uvs=0.6)
    X.fx(fx_rect(lc + lfw * 0.003, lfw, lup, bw - 0.06, lid_h - 0.06, mode='flat', col='#24402c', colA=0.5, kinds=['glass'], facing=0.5))
    for s in (-1, 1):          # hood side panels + top
        X.box(lc + XL * s * (bw / 2 - 0.004) + lfw * 0.06, (0.006, lid_h - 0.01, 0.12), 'rubber', rot=cols(XL, lup, -lfw), bevel=0.002, seg=1)
    X.box(lc + lup * (lid_h / 2 - 0.004) + lfw * 0.06, (bw - 0.004, 0.006, 0.12), 'rubber', rot=cols(XL, lup, -lfw), bevel=0.002, seg=1)
    for s in (-1, 1):
        X.cyl((xc + s * (bw / 2 - 0.03), by + 0.01, hz), (xc + s * (bw / 2 - 0.01), by + 0.01, hz), 0.009, 'steel_dark', n=8)
    X.fx(fx_text('ПДУ', (xc, by - 0.028, z0 - 0.0005), BK, UP, 0.012, col='#d8d2b0', colA=0.75, kinds=['case'], facing=0.5, thick=0.02))
    return o


def stugna():
    B = Builder()
    S = LY.STUGNA
    tc, _ = LY.tube_mount('stugna')
    X = XB(B)
    B.group = 'stugna_tripod'
    st = stugna_launcher(X)
    B.group = 'stugna_tube'
    stugna_tlc(X, tc)
    B.group = 'stugna_control'
    co = stugna_control(X)
    # cable: from the control unit down to the ground, a few loose loops, up into the electronics box (separate node so the game
    # can hide it when the control unit is relocated for remote firing)
    B.group = 'stugna_cable'
    hy = S['head_y']
    pts = [(0.10, co[1] + 0.70, co[2] + 0.03), (0.13, 0.30, co[2] + 0.06), (0.16, 0.012, co[2] + 0.12), (0.30, 0.012, co[2] + 0.22),
           (0.38, 0.012, 0.0), (0.30, 0.012, -0.14), (0.22, 0.012, -0.05), (0.20, 0.02, 0.06), (0.17, hy - 0.05, 0.08), (0.152, hy + 0.08, 0.06)]
    X.pipe(spline(np.array(pts), 40), 0.0045, 'cable', n=5)
    # cable drum ring on the ground beside the launcher (as issued: open reel with the rest of the 50 m cable)
    dc = np.array([0.55, 0.0, -0.18])
    X.revolve([(0.0, 0.17), (0.0, 0.215), (0.008, 0.215), (0.008, 0.17)], 'sgreen', c=dc, axis=UP, n=20)
    X.revolve([(0.042, 0.17), (0.042, 0.215), (0.05, 0.215), (0.05, 0.17)], 'sgreen', c=dc, axis=UP, n=20)
    X.revolve([(0.008, 0.182), (0.008, 0.200), (0.042, 0.200), (0.042, 0.182)], 'cable', c=dc, axis=UP, n=20)
    X.fx(fx_cyl_bands(dc, UP, 0.0, 0.008, 0.215, '#1a1a1a', colA=0.0, kinds=['sgreen']))
    off = np.array([3.2, 0.0, 0.0])
    B.group = 'folded'
    XF = XB(B, np.eye(3), off)
    stugna_launcher(XF, folded=True)
    xf_f, folded_world = folded_to_back('stugna', off)
    empties = launcher_empties('stugna')
    # remote operation: soldier root relative to the control unit (same aim pose)
    empties['control_seat'] = ('stugna_control', -S['L0'] * [1, 0, 1], None)
    empties['control_eye'] = ('stugna_control', LY.EYE - S['L0'], None)
    empties.update(muzzle=('stugna_tube', tc + FW * (S['tube_len'] / 2), None),
                   tube_rear=('stugna_tube', tc + BK * (S['tube_len'] / 2), [0, 1, 0, 0]))
    groups = [dict(name='stugna_tripod', lod=0.3, extras={'part': 'deployed tripod + electronics box + PN-S guidance unit'}),
              dict(name='stugna_tube', t=tc, lod=0.3, extras={'part': 'R-2 TLC on the yoke'}),
              dict(name='stugna_control', t=co, lod=0.3, extras={'part': 'remote control unit (PDU) on its tripod; move with the operator '
                                                                  '(control_seat) for remote firing'}),
              dict(name='stugna_cable', lod=0.4, extras={'part': 'control cable + drum; hide when the control unit is moved'}),
              dict(name='folded', xf=xf_f, lod=0.3, extras={'default_visible': False, 'part': 'tripod collapsed for carrying (weapon_socket_back frame)'})]
    info = export_multi(B, 'stugna', groups, empties, res=1024, root_extras={'system': 'Stugna-P', 'tlc': 'R-2 (130 mm)', 'length_tlc_m': S['tube_len']})
    info['folded_world_bind'] = folded_world
    return info


# ------------------------------------------------------------------ TLC carried on the back
def tube_carried():
    """one TLC on the back (weapon_socket_back, identity): tube_kornet / tube_stugna alternatives, each with two harness
    straps; diagonal like a slung rifle but outside it, the top end beside / behind the helmet"""
    B = Builder()
    d = np.array([-0.24, 0.97, 0.0]); d /= np.linalg.norm(d)
    out = np.array([0.0, 0.0, -1.0])
    Rw = cols(np.cross(out, d), out, d)            # natural: X side, Y = out (away from the back), Z = tube axis (up)
    res = {}
    groups = []
    for i, (name, fn, rr, L) in enumerate((('tube_kornet', kornet_tlc, LY.KORNET['tube_r_end'], LY.KORNET['tube_len']),
                                           ('tube_stugna', stugna_tlc, LY.STUGNA['tube_r_end'], LY.STUGNA['tube_len']))):
        off = np.array([i * 1.0, 0.0, 0.0])
        B.group = name
        X = XB(B, np.eye(3), off)
        fn(X, np.zeros(3), n=14)
        # harness straps around the tube + short tails toward the wearer (-Y in the natural frame is toward the back)
        for zz in (-0.25, 0.25):
            ring = [np.array([np.cos(a) * (rr + 0.004), np.sin(a) * (rr + 0.004), zz]) for a in np.linspace(0, 2 * np.pi, 13)]
            X.pipe(np.array(ring)[:-1], 0.003, 'webbing', n=4, closed=True)
            X.strap([np.array([0.03, -rr - 0.002, zz]), np.array([0.05, -rr - 0.03, zz + 0.04]), np.array([0.07, -rr - 0.045, zz + 0.10])],
                    0.025, 0.003, 'webbing', up=(0, 1, 0), uvs=0.5)
            X.box(np.array([0.0, -rr - 0.004, zz]), (0.035, 0.008, 0.03), 'plastic', bevel=0.001, seg=1)
        # world (bind): tube centre outside the rifle on the back plate, a little left of the spine; bottom end above the belt
        centre_w = np.array([0.02, 1.22, -0.205 - 0.115])
        # natural -> world: x' = Rw @ x + tw;  build p -> natural (p - off)
        Rs, ts = to_back(Rw, centre_w)
        groups.append(dict(name=name, xf=(Rs, ts - Rs @ off), lod=0.3,
                           extras={'default_visible': i == 0, 'part': f'{"9M133" if i == 0 else "R-2"} TLC carried on the back (weapon_socket_back, identity)'}))
    info = export_multi(B, 'atgm_tube_carried', groups, {}, res=1024, root_extras={'socket': 'weapon_socket_back', 'variants': 'tube_kornet / tube_stugna'})
    return info


# ------------------------------------------------------------------ FPV drone
def drone():
    """7" FPV kamikaze quad (true-X carbon frame, 2806 motors, 7" tri-blade props as separate nodes prop_0..3, micro camera in
    a TPU mount, VTX + ELRS antennas, 6S pack strapped on top, PG-7V warhead zip-tied under the frame, nose fuze ahead of the props)"""
    B = Builder()
    D = LY.DRONE
    h = D['motor_d'] / 2 / np.sqrt(2)          # motor x / z offset (true X)
    mot = [np.array([h, 0, h]), np.array([-h, 0, h]), np.array([-h, 0, -h]), np.array([h, 0, -h])]   # FL (left = +X), FR, RR, RL
    pt = D['plate_t']
    B.group = 'fpv_drone'
    X = XB(B)
    # bottom plate + arms (carbon), top plate on standoffs
    X.box((0, 0, 0), (0.065, pt, 0.135), 'carbon', bevel=0.002, seg=1)
    for m in mot:
        d = m / np.linalg.norm(m); L = np.linalg.norm(m)
        side = np.cross(UP, d)
        X.prism([(0.02, -0.013), (L - 0.012, -0.0085), (L + 0.014, -0.0085), (L + 0.017, 0.0), (L + 0.014, 0.0085), (L - 0.012, 0.0085), (0.02, 0.013)],
                pt, 'carbon', np.zeros(3) + UP * 0.0, d, side, bevel=0.0012, seg=1)
    X.box((0, 0.029, -0.005), (0.050, 0.0025, 0.105), 'carbon', bevel=0.001, seg=1)
    for sx in (1, -1):
        for sz in (1, -1):
            X.cyl((sx * 0.018, pt / 2, sz * 0.04), (sx * 0.018, 0.028, sz * 0.04), 0.0028, 'alu', n=6)
    X.fx(fx_pattern((0, 0.0302, -0.005), UP, FW, 0.05, 0.10, pat_checker(0.004), depth=0.00005, kinds=['carbon'], facing=0.7, col='#2a2b2d', colA=0.25))
    # stack (FC/ESC) glimpse + capacitor
    X.box((0, 0.014, -0.005), (0.036, 0.016, 0.036), 'plastic', bevel=0.001, seg=1)
    X.cyl((0.022, 0.012, -0.045), (0.022, 0.012, -0.075), 0.005, 'plastic_lt', n=6)
    # motors: base, stator (copper glimpse), bell, shaft
    for m in mot:
        X.revolve([(0, 0), (0, 0.015), (0.004, 0.0155), (0.004, 0.0)], 'motor', c=m + UP * (pt / 2), axis=UP, n=10)
        X.revolve([(0, 0.0148), (0.004, 0.0148), (0.004, 0.0)], 'copper', c=m + UP * (pt / 2 + 0.004), axis=UP, n=10)
        X.revolve([(0, 0.0), (0, D['motor_r']), (0.016, D['motor_r']), (0.0175, D['motor_r'] - 0.003), (0.0175, 0.0)], 'motor', c=m + UP * (pt / 2 + 0.0055), axis=UP, n=12)
        X.fx(fx_cyl_bands(m + UP * (pt / 2 + 0.0055), UP, 0.003, 0.012, D['motor_r'], '#7a2f22', colA=0.85, kinds=['motor']))
        X.cyl(m + UP * (pt / 2 + 0.023), m + UP * (pt / 2 + 0.031), 0.0025, 'steel', n=6)
    # camera: TPU mount (two side plates) + 19 mm cam tilted up 35 deg, lens
    cq = rot_x(-35)
    cc = np.array([0, 0.016, 0.060])
    for sx in (1, -1):
        X.box(cc + XL * sx * 0.016 + DN * 0.004, (0.004, 0.026, 0.026), 'tpu', bevel=0.001, seg=1)
    X.box(cc, (0.024, 0.019, 0.019), 'plastic', rot=cq, bevel=0.0015, seg=1)
    lens_ax = cq @ FW
    X.revolve([(0, 0.0), (0, 0.0075), (0.012, 0.0072), (0.012, 0.0)], 'plastic', c=cc + lens_ax * 0.009, axis=lens_ax, n=10)
    X.revolve([(0.0, 0.0055), (0.0, 0.0)], 'glass', c=cc + lens_ax * 0.0215, axis=lens_ax, n=8, uvs=0.4)
    # battery (6S) on the top plate, velcro strap + XT60 leads
    bc = np.array([0, 0.031 + 0.024, -0.008])
    X.box(bc, (0.044, 0.048, 0.150), 'battery', bevel=0.004, seg=1)
    X.fx(fx_rect(bc + XL * 0.0225, XL, UP, 0.10, 0.034, mode='flat', col='#c9a227', colA=0.9, kinds=['battery'], facing=0.6))
    X.fx(fx_text('6S 4000', bc + XL * 0.0226 + UP * 0.006, XL, UP, 0.008, col='#151515', colA=0.9, kinds=['battery'], facing=0.6, thick=0.01))
    X.fx(fx_text('22.2V', bc + XL * 0.0226 + DN * 0.009, XL, UP, 0.006, col='#151515', colA=0.85, kinds=['battery'], facing=0.6, thick=0.01))
    X.fx(fx_rect(bc + XR * 0.0225, XR, UP, 0.10, 0.034, mode='flat', col='#c9a227', colA=0.9, kinds=['battery'], facing=0.6))
    for zz in (-0.035, 0.035):      # velcro straps round the pack and the top plate
        yt, yb_ = bc[1] + 0.0255, 0.0262
        loop = [(0.0, yt), (0.018, yt), (0.0235, yt - 0.005), (0.0235, yb_ + 0.004), (0.020, yb_), (-0.020, yb_), (-0.0235, yb_ + 0.004),
                (-0.0235, yt - 0.005), (-0.018, yt), (0.0, yt)]
        X.strap(np.array([(x, y, zz) for x, y in loop]), 0.018, 0.0018, 'webbing', up=FW, uvs=0.4)
    X.pipe(np.array([bc + [0.008, -0.012, -0.075], bc + [0.010, -0.010, -0.095], [0.008, 0.030, -0.085], [0.006, 0.020, -0.05]]), 0.0025, 'red', n=5)
    X.pipe(np.array([bc + [-0.008, -0.012, -0.075], bc + [-0.010, -0.010, -0.095], [-0.008, 0.030, -0.085], [-0.006, 0.020, -0.05]]), 0.0025, 'cable', n=5)
    X.box(bc + [0.0, -0.006, -0.10], (0.016, 0.008, 0.016), 'brass', bevel=0.001, seg=1)
    # VTX antenna (rear, up-back: lollipop) + ELRS receiver antennas (two short wires, V)
    X.cyl((0, 0.031, -0.060), (0, 0.075, -0.098), 0.0022, 'cable', n=5)
    X.revolve([(0, 0.0), (0, 0.010), (0.011, 0.010), (0.011, 0.0)], 'plastic', c=(0, 0.075, -0.098), axis=np.array([0, 0.75, -0.66]), n=8)
    for sx in (1, -1):
        X.cyl((sx * 0.012, 0.02, -0.065), (sx * 0.045, 0.034, -0.110), 0.0012, 'plastic_lt', n=4)
    X.box((0, 0.026, -0.064), (0.03, 0.008, 0.014), 'tpu', bevel=0.001, seg=1)
    # warhead (PG-7V head without the motor) under the frame, nose fuze forward; printed tail adapter with the initiator; zip ties
    wy = -0.0475
    wc = np.array([0, wy, 0])
    X.revolve([(-0.072, 0.0), (-0.072, 0.024), (-0.060, 0.030), (-0.040, 0.0425), (0.012, 0.0425), (0.020, 0.0412), (0.150, 0.0112),
               (0.152, 0.0098), (0.168, 0.0068), (0.172, 0.0045), (0.173, 0.0)], 'warhead', c=wc, axis=FW, n=16)
    X.revolve([(-0.105, 0.0), (-0.105, 0.016), (-0.074, 0.025), (-0.072, 0.0)], 'tpu', c=wc, axis=FW, n=10)
    X.fx(fx_cyl_bands(wc, FW, -0.035, -0.031, 0.0425, '#151515', kinds=['warhead']))
    X.fx(fx_cyl_bands(wc, FW, 0.010, 0.014, 0.0425, '#151515', kinds=['warhead']))
    for sx in (1, -1):
        X.fx(fx_text('ПГ-7В', wc + XL * sx * 0.0425 + BK * 0.012, XL * sx, UP, 0.0085, col='#141414', colA=0.9, kinds=['warhead'], facing=0.6, thick=0.012))
    for zz in (-0.022, 0.0):
        ring = [wc + np.array([0.0445 * np.cos(a), 0.0445 * np.sin(a), zz]) for a in np.linspace(-np.pi / 2, 1.5 * np.pi, 13)]
        ring = [p if p[1] < -0.003 else np.array([np.sign(p[0]) * 0.03 if abs(p[0]) > 0.01 else 0.0, 0.004, p[2]]) for p in ring]
        X.pipe(np.array(ring[:-1]), 0.0016, 'polymer', n=4, closed=True)
    X.pipe(np.array([(0.0, wy + 0.012, -0.10), (0.0, -0.006, -0.085), (0.004, 0.006, -0.05)]), 0.0018, 'red', n=4)
    # props: tri-blade 7", own nodes (pivot = motor axis at the hub), CCW/CW alternate (props-out)
    groups = [dict(name='fpv_drone', lod=0.35, extras={'part': 'frame, motors, camera, battery, warhead'})]
    empties = {}
    for i, m in enumerate(mot):
        B.group = f'prop_{i}'
        hub = m + UP * (pt / 2 + 0.026)
        spin = 1 if i in (0, 2) else -1        # +1: counter-clockwise seen from above (about +Y)
        prop(X, hub, D['prop_d'] / 2, spin, phase=i * 37.0)
        groups.append(dict(name=f'prop_{i}', t=hub, lod=0.4, extras={'spin': spin, 'axis': [0, 1, 0], 'note': 'rotate about local +Y; spin sign = '
                                                                    'direction about +Y (props-out: front props turn outward at the front)'}))
    empties.update(cam=('fpv_drone', cc + lens_ax * 0.022, qlook(lens_ax, UP)),
                   warhead_tip=('fpv_drone', wc + FW * 0.173, None),
                   centre=('fpv_drone', np.zeros(3), None))
    info = export_multi(B, 'fpv_drone', groups, empties, res=512, root_extras={'type': '7in FPV kamikaze', 'payload': 'PG-7V warhead', 'mass_kg': 2.1})
    info['motors'] = [np.round(m, 4).tolist() for m in mot]
    return info


def prop(X, hub, R, spin, phase=0.0):
    """tri-blade prop around +Y at hub: hub cylinder + 3 twisted, tapered blades (pitch ~ positive for `spin`)"""
    X.revolve([(-0.004, 0.0), (-0.004, 0.0105), (0.004, 0.0105), (0.006, 0.006), (0.006, 0.0)], 'prop', c=hub, axis=UP, n=10)
    X.revolve([(0.006, 0.0), (0.006, 0.0042), (0.011, 0.0035), (0.012, 0.0)], 'steel', c=hub, axis=UP, n=6)
    for k in range(3):
        a = np.radians(phase + k * 120.0)
        rd = np.array([np.sin(a), 0, np.cos(a)]); td = np.cross(UP, rd) * spin      # tangential (leading edge direction)
        rings = []
        for r, ch, tw in ((0.009, 0.014, 22), (0.03, 0.021, 18), (0.06, 0.018, 13), (0.085, 0.011, 9), (R, 0.005, 7)):
            p = hub + rd * r
            t2 = td * np.cos(np.radians(tw)) + UP * np.sin(np.radians(tw))
            n2 = np.cross(rd, t2) * spin
            th = 0.0028 * (1 - r / R) + 0.0008
            rings.append(np.array([p + t2 * ch * 0.55, p + n2 * th / 2, p - t2 * ch * 0.45, p - n2 * th / 2]))
        X.loft(rings, 'prop', caps=(False, True), angle=50)


# ------------------------------------------------------------------ FPV radio controller (weapon_socket frame)
def controller():
    """Radiomaster-style radio (TX16S / Boxer class) authored in the weapon_socket frame: origin = right palm centre on the right
    handle, +X toward the left handle, +Y = stick face, +Z = top edge (antenna).  Parent to weapon_socket with identity."""
    B = Builder()
    B.group = 'fpv_controller'
    X = XB(B, LY.CTRL_R)           # radio natural frame (x -> left handle, y = stick face, z = top edge) -> weapon_socket frame
    gl = LY.CTRL['grip_L']
    xc = gl[0] / 2
    # handles (palm side x = 0 / gl): rounded grips angled down-out, the body between them
    for hx, s in ((0.016, -1), (gl[0] - 0.016, 1)):
        X.cyl((hx, -0.004, -0.055), (hx - s * 0.006, 0.0, 0.035), 0.017, 'plastic', n=10)
        X.revolve([(0, 0.0), (0, 0.017), (0.004, 0.0)], 'plastic', c=(hx, -0.004, -0.055), axis=np.array([s * 0.06, -0.04, -1.0]), n=10)
        X.fx(fx_pattern((hx, -0.018, -0.01), DN, FW, 0.024, 0.07, pat_ribs(0.003, 0.5, 1), depth=0.0003, kinds=['rubber'], facing=0.4))
    # main body: rounded loft (front face +Y)
    poly = rrect(gl[0] - 0.040, 0.105, 0.02, nc=3)       # (x, z) outline
    rings = []
    for y, sc in ((-0.020, 0.94), (-0.014, 1.0), (0.010, 1.0), (0.018, 0.96)):
        rings.append(np.stack([xc + poly[:, 0] * sc, np.full(len(poly), y), 0.008 + poly[:, 1] * sc], 1))
    X.loft(rings, 'plastic', angle=40)
    # face: gimbals (ring + stick + cap) near the grips, screen centre, switches on the top edge, antenna
    for gx in (0.042, gl[0] - 0.042):
        X.revolve([(0, 0.0), (0, 0.016), (0.003, 0.016), (0.003, 0.0)], 'plastic_lt', c=(gx, 0.018, 0.010), axis=UP, n=12)
        X.cyl((gx, 0.018, 0.010), (gx, 0.040, 0.010), 0.0022, 'steel', n=6)
        X.revolve([(0, 0.0), (0, 0.0055), (0.005, 0.0055), (0.007, 0.0)], 'rubber', c=(gx, 0.040, 0.010), axis=UP, n=8)
    X.box((xc, 0.0185, 0.032), (0.048, 0.003, 0.030), 'glass', bevel=0.0005, seg=1, uvs=0.5)
    X.fx(fx_rect((xc, 0.0201, 0.032), UP, FW, 0.044, 0.026, mode='flat', col='#1c3240', colA=0.55, kinds=['glass'], facing=0.6))
    for k, sx in enumerate((0.03, 0.05, gl[0] - 0.05, gl[0] - 0.03)):
        X.box((sx, 0.006, 0.062), (0.005, 0.006, 0.010), 'steel', bevel=0.0008, seg=1)
        X.cyl((sx, 0.006, 0.066), (sx, 0.006 + (0.006 if k % 2 else -0.004), 0.078), 0.0018, 'steel', n=5)
    for sx in (0.022, gl[0] - 0.022):
        X.cyl((sx, 0.0, 0.055), (sx, 0.0, 0.064), 0.006, 'plastic_lt', n=8)     # shoulder pots
    X.box((xc, 0.012, -0.040), (0.05, 0.010, 0.012), 'plastic_lt', bevel=0.001, seg=1)   # trim / nav buttons row
    # antenna (folded up, hinge on the top edge, slightly back) + lanyard hook on the back
    X.revolve([(0, 0.0), (0, 0.006), (0.012, 0.006), (0.012, 0.0)], 'plastic', c=(xc + 0.03, -0.008, 0.060), axis=FW, n=8)
    X.cyl((xc + 0.03, -0.008, 0.070), (xc + 0.03, -0.018, 0.150), 0.0055, 'plastic', n=8)
    X.box((xc, -0.024, 0.0), (0.012, 0.008, 0.016), 'steel_dark', bevel=0.001, seg=1)
    X.fx(fx_text('RADIOMASTER', (xc, 0.0185, -0.020), UP, FW, 0.005, col='#9a9a96', colA=0.7, kinds=['plastic'], facing=0.6, thick=0.006))
    groups = [dict(name='fpv_controller', lod=0.35, extras={'socket': 'weapon_socket (identity)'})]
    M = LY.CTRL_R
    empties = {'grip_R': ('fpv_controller', np.zeros(3), None), 'grip_L': ('fpv_controller', M @ gl, None),
               'stick_L': ('fpv_controller', M @ np.array([0.042, 0.040, 0.010]), None),
               'stick_R': ('fpv_controller', M @ np.array([gl[0] - 0.042, 0.040, 0.010]), None),
               'antenna_tip': ('fpv_controller', M @ np.array([gl[0] / 2 + 0.03, -0.018, 0.150]), None)}
    return export_multi(B, 'fpv_controller', groups, empties, res=512,
                        root_extras={'socket': 'weapon_socket (identity)', 'frame': 'origin = right palm centre on the right handle; handles along the socket grip axis '
                                     '(like a pistol grip), +X toward the left handle, stick face toward -h (the pilot), antenna up along the grip axis'})


# ------------------------------------------------------------------ FPV goggles (Head bone frame)
def goggles():
    """box goggles (Skyzone / DJI class): front unit over the eyes, foam face plate, two patch antennas on top, head strap
    around the helmet / headset; authored in bind-pose world space relative to the Head joint (parent to the Head bone
    with identity; empty `head_attach` = origin)"""
    import pickle
    R = pickle.load(open(f'{CACHE}/body.pkl', 'rb'))
    sk = R['skel']; lm = R['variants']['A']['lm']
    head = sk.head[sk.idx['Head']].copy()
    eye = (lm['eyeL'] + lm['eyeR']) / 2
    del R
    B = Builder()
    B.group = 'fpv_goggles'
    X = XB(B, np.eye(3), -head)        # build in bind world, output relative to the Head joint
    ey = eye[1] + 0.004
    zf = 0.162                         # face contact (forehead / cheeks)
    # foam face plate (ring) + front unit (rounded box) + lens bezel
    poly = rrect(0.170, 0.072, 0.024, nc=3)
    rings = []
    for z, sc in ((zf - 0.002, 0.92), (zf + 0.012, 1.0)):
        rings.append(np.stack([poly[:, 0] * sc, ey + poly[:, 1] * sc, np.full(len(poly), z)], 1))
    X.loft(rings, 'foam', caps=(True, False), angle=45)
    poly2 = rrect(0.176, 0.080, 0.026, nc=3)
    rings = []
    for z, sc in ((zf + 0.010, 0.97), (zf + 0.016, 1.0), (zf + 0.058, 1.0), (zf + 0.066, 0.93)):
        rings.append(np.stack([poly2[:, 0] * sc, ey + 0.002 + poly2[:, 1] * sc, np.full(len(poly2), z)], 1))
    X.loft(rings, 'plastic', angle=40)
    X.box((0, ey + 0.002, zf + 0.067), (0.12, 0.040, 0.004), 'plastic_lt', bevel=0.002, seg=1)   # front panel
    X.revolve([(0, 0.0), (0, 0.007), (0.004, 0.007), (0.004, 0.0)], 'glass', c=(0.0, ey + 0.004, zf + 0.069), axis=FW, n=8, uvs=0.4)   # front cam
    X.fx(fx_text('SKYZONE', (0.0, ey - 0.025, zf + 0.0665), FW, UP, 0.006, col='#b0b0ac', colA=0.7, kinds=['plastic'], facing=0.6, thick=0.006))
    # side buttons / dial, DVR slot
    X.cyl((0.088, ey + 0.012, zf + 0.04), (0.094, ey + 0.012, zf + 0.04), 0.007, 'plastic_lt', n=8)
    X.box((-0.089, ey - 0.01, zf + 0.035), (0.004, 0.012, 0.03), 'plastic_lt', bevel=0.001, seg=1)
    # two patch antennas on top (receiver module) + stubby
    X.box((0, ey + 0.047, zf + 0.035), (0.10, 0.012, 0.04), 'plastic', bevel=0.003, seg=1)
    for sx in (1, -1):
        X.box((sx * 0.032, ey + 0.068, zf + 0.04), (0.04, 0.032, 0.008), 'plastic', rot=rot_x(-12) @ rot_z(sx * 10), bevel=0.003, seg=1)
    X.cyl((0.0, ey + 0.053, zf + 0.025), (0.0, ey + 0.085, zf + 0.015), 0.0045, 'plastic', n=6)
    # strap: ellipse round the head at eye level, over the helmet / headset sides (half-width 0.126), adjuster at the back
    # tight round the head at eye level (skull half-width ~0.08, back of the skull z ~ -0.07), from one side of the goggles to the other
    hw = 0.090
    side = [(hw, zf + 0.020), (hw + 0.002, zf - 0.04), (hw - 0.002, 0.04), (hw - 0.010, -0.02), (0.060, -0.072), (0.0, -0.090)]
    ring = side + [(-x, z) for x, z in side[::-1][1:]]
    pts = spline(np.array([(x, ey + 0.006 + 0.004 * (1 - abs(x) / hw), z) for x, z in ring]), 28)
    X.strap(pts, 0.030, 0.004, 'webbing', up=(0, 1, 0), uvs=0.5)
    X.box((0, ey + 0.010, -0.094), (0.04, 0.032, 0.008), 'plastic', bevel=0.002, seg=1)
    groups = [dict(name='fpv_goggles', lod=0.35, extras={'attach': 'Head bone, identity'})]
    info = export_multi(B, 'fpv_goggles', groups, {'head_attach': (None, np.zeros(3), None)}, res=512,
                        root_extras={'attach': 'parent to the Head bone (or a child at the head joint) with identity: origin = Head joint, bind-pose axes'})
    info['head_joint_bind'] = head.tolist()
    return info


if __name__ == '__main__':
    only = sys.argv[1:]
    infop = os.path.join(CACHE, 'atgm_info.json')
    info = json.load(open(infop)) if os.path.exists(infop) else {}
    for fn in (kornet, stugna, tube_carried, drone, controller, goggles):
        nm = fn.__name__
        if only and nm not in only:
            continue
        t0 = time.time()
        info[nm] = fn()
        print(nm, 'done', round(time.time() - t0), 's')
        json.dump(info, open(infop, 'w'), indent=1, default=lambda o: o.tolist() if hasattr(o, 'tolist') else str(o))
