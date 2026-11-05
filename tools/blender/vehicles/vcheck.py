"""Floating / clipping / duplicate-lid checker for the vehicle GLBs.

Input: world-space exports made by tools/blender/vehicles/vcheck.html (export=1) through vcheck.mjs:
    <name>_closed.glb   LOD0, everything closed            -> floating parts, static penetrations
    <name>_open.glb     LOD0, all hatch_lids + doors open   -> lids / doors through other parts, closed-lid ghosts
    <name>_kits.glb     LOD0 + every vehicleKit kit         -> kit parts floating / through hull / turret
    <name>_lod1*.glb    same for LOD1 (ghost lids on LODs)
Usage:  python3 vcheck.py <dir> <name> [<name> ...]   -> <dir>/<name>_report.json + prints a summary

Method (metres, Blender Z-up frame of the imported glTF):
 * every mesh is welded (glTF splits vertices at seams) and split into loose parts (connected components) = authored parts
 * touch graph: two parts touch if a vertex of one lies within TOUCH (1.2 cm) of the other's surface, or their
   triangles intersect (BVH overlap).  Parts not connected (transitively) to the biggest part (the hull) are FLOATING;
   their gap = smallest distance to the connected body.
 * penetration between node groups (hull / turret / gun / wheel / lid:X / door:X / kit:X): a vertex of group A is inside
   group B if the nearest surface normal faces away from it AND a +Z and a -Z ray both hit B an odd number of times;
   depth = distance to that surface.  Reported when depth > 2 cm.
 * ghost lids: with the lids open, the CLOSED lid's outer-surface vertices are probed against everything that is not
   that lid; >= 50 % of them within 4 mm of other geometry = a closed lid is still drawn there.
"""
import sys, os, json, math
import bpy, bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

TOUCH = 0.012
DEPTH = 0.02


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    out = []
    for o in bpy.context.scene.objects:
        if o.type != 'MESH':
            continue
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bm.transform(o.matrix_world)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        bmesh.ops.triangulate(bm, faces=bm.faces)
        path_ = o.get('path', '') or (o.data.get('path', '') if o.data else '')
        out.append(dict(name=o.name.split('.')[0], path=path_, kit=bool(o.get('kit', False)), bm=bm))
    return out


EXTRA_DOORS = [('door_rear_L', 'y', -1.75), ('door_rear_R', 'y', 1.75), ('roof_door_L', 'x', 1.65), ('roof_door_R', 'x', 1.65), ('ramp', 'x', -2.221)]   # vehicle.js animDoors


def load_glb(path, ent, opened=False, lod=False):
    """import an asset GLB straight into Blender and pose it like the game: hatch_lids + doors (+ vehicle.js IFV doors)
    open, LOD0 or LOD1 meshes, no wreck / hidden nodes."""
    from mathutils import Quaternion
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    objs = {o.name: o for o in bpy.context.scene.objects}
    if opened:
        poses = [(n, L_.get('axis', 'x'), L_['open']) for n, L_ in {**(ent.get('hatch_lids') or {}), **(ent.get('doors') or {})}.items()]
        if not ent.get('doors'):
            poses += [(n, a, r) for n, a, r in EXTRA_DOORS]
        for n, ax, ang in poses:
            o = objs.get(n)
            if not o:
                continue
            o.rotation_mode = 'QUATERNION'
            axis = {'x': (1, 0, 0), 'y': (0, 0, 1), 'z': (0, -1, 0)}[ax]
            o.rotation_quaternion = o.rotation_quaternion @ Quaternion(axis, ang)
    bpy.context.view_layer.update()
    out = []
    for o in bpy.context.scene.objects:
        if o.type != 'MESH':
            continue
        chain, p = [], o
        while p:
            chain.append(p); p = p.parent
        names = [c.name for c in chain]
        if any(n.endswith('_wreck') for n in names) or any(c.get('hidden') and not c.name.endswith('_LOD1') for c in chain):
            continue
        is1 = o.name.endswith('_LOD1')
        if lod != is1:
            if not lod or (o.name + '_LOD1') in objs:
                continue
        bm = bmesh.new(); bm.from_mesh(o.data); bm.transform(o.matrix_world)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5); bmesh.ops.triangulate(bm, faces=bm.faces)
        out.append(dict(name=o.name.replace('_LOD1', ''), path='/'.join(n for n in names[::-1][:-1]), kit=False, bm=bm))
    return out


def group_of(m):
    p = (m['path'] + '/' + m['name'])
    n = m['name']
    if m['kit'] or n.startswith('kit_'):
        return 'kit:' + n
    for seg in p.split('/')[::-1]:
        if seg.startswith('hatch_lid_') and not seg.endswith('_geo') and not seg.endswith('_LOD1'):
            return 'lid:' + seg
    for seg in p.split('/')[::-1]:
        if seg.startswith('door_') or seg in ('tailgate', 'ramp') or seg.startswith('roof_door'):
            return 'door:' + seg.replace('_geo', '').replace('_LOD1', '')
    if 'gun_pivot' in p.split('/'):
        return 'gun'
    for seg in p.split('/'):
        if seg.startswith(('wheel_', 'roadwheel_', 'sprocket_', 'idler_', 'return_', 'steer_')):
            return 'wheel:' + seg
        if seg.startswith('track'):
            return 'track'
    if 'turret' in p.split('/'):
        return 'turret'
    return 'hull'


def components(bm):
    """face lists per loose part"""
    bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
    n = len(bm.verts)
    parent = list(range(n))
    def f(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for e in bm.edges:
        a, b = f(e.verts[0].index), f(e.verts[1].index)
        if a != b:
            parent[a] = b
    comp = {}
    for fc in bm.faces:
        r = f(fc.verts[0].index)
        comp.setdefault(r, []).append(fc.index)
    return list(comp.values())


class Scene:
    def __init__(self, meshes):
        self.verts, self.tris, self.fpart = [], [], []
        self.parts = []          # dict(mesh, group, faces(global idx), vidx(global), bbox)
        off = 0
        for mi, m in enumerate(meshes):
            bm = m['bm']
            bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
            co = [v.co.copy() for v in bm.verts]
            self.verts += co
            g = group_of(m)
            for faces in components(bm):
                pid = len(self.parts)
                vids = sorted({v.index for fi in faces for v in bm.faces[fi].verts})
                gf = []
                for fi in faces:
                    self.tris.append([v.index + off for v in bm.faces[fi].verts])
                    self.fpart.append(pid); gf.append(len(self.tris) - 1)
                P = np.array([co[i] for i in vids])
                self.parts.append(dict(mesh=m['name'], group=g, faces=gf, vids=[i + off for i in vids],
                                       lo=P.min(0), hi=P.max(0)))
            off += len(co)
        self.V = np.array(self.verts)
        self.bvh = BVHTree.FromPolygons(self.verts, self.tris, all_triangles=True)
        self.fpart = np.array(self.fpart)

    def part_bvh(self, pids):
        tris = [self.tris[f] for p in pids for f in self.parts[p]['faces']]
        return BVHTree.FromPolygons(self.verts, tris, all_triangles=True), [p for p in pids for f in self.parts[p]['faces']]

    def touch_graph(self, max_verts=600):
        adj = [set() for _ in self.parts]
        for pid, P in enumerate(self.parts):
            vids = P['vids']
            if len(vids) > max_verts:
                vids = vids[::max(1, len(vids) // max_verts)]
            for vi in vids:
                for hit in self.bvh.find_nearest_range(self.verts[vi], TOUCH):
                    q = int(self.fpart[hit[2]])
                    if q != pid:
                        adj[pid].add(q); adj[q].add(pid)
        return adj

    def clusters(self, adj):
        seen = [-1] * len(self.parts); cl = []
        for s in range(len(self.parts)):
            if seen[s] >= 0:
                continue
            st = [s]; seen[s] = len(cl); mem = []
            while st:
                a = st.pop(); mem.append(a)
                for b in adj[a]:
                    if seen[b] < 0:
                        seen[b] = len(cl); st.append(b)
            cl.append(mem)
        return cl, seen


def vol(p):
    d = p['hi'] - p['lo']
    return float(max(d[0], 0.01) * max(d[1], 0.01) * max(d[2], 0.01))


def floating(S):
    adj = S.touch_graph()
    cl, cid = S.clusters(adj)
    # crossing contacts (no vertex near the other surface): triangle overlap test for the small clusters only
    big = max(range(len(S.parts)), key=lambda p: vol(S.parts[p]))
    main = cid[big]
    for ci, mem in enumerate(cl):
        if ci == main or sum(len(S.parts[p]['faces']) for p in mem) > 20000:
            continue
        b, owner = S.part_bvh(mem)
        for i, j in b.overlap(S.bvh):
            q = int(S.fpart[j])
            if q not in mem:
                adj[owner[i]].add(q); adj[q].add(owner[i])
                break
    cl, cid = S.clusters(adj)
    main = cid[big]
    mb, _ = S.part_bvh(cl[main])
    out = []
    for ci, mem in enumerate(cl):
        if ci == main:
            continue
        vids = [v for p in mem for v in S.parts[p]['vids']]
        gap = min(mb.find_nearest(S.verts[v])[3] for v in vids[::max(1, len(vids) // 400)])
        lo = np.min([S.parts[p]['lo'] for p in mem], 0); hi = np.max([S.parts[p]['hi'] for p in mem], 0)
        out.append(dict(meshes=sorted({S.parts[p]['mesh'] for p in mem}), groups=sorted({S.parts[p]['group'] for p in mem}),
                        parts=len(mem), gap_m=round(gap, 3), center=np.round((lo + hi) / 2, 3).tolist(), size=np.round(hi - lo, 3).tolist()))
    out.sort(key=lambda r: -r['gap_m'])
    return out, len(S.parts)


def inside_count(bvh, p, d):
    n, o = 0, Vector(p)
    for _ in range(40):
        loc, nrm, idx, dist = bvh.ray_cast(o, d, 50)
        if loc is None:
            break
        n += 1; o = loc + d * 1e-4
    return n


def penetrations(S, pairs=None):
    groups = {}
    for pid, P in enumerate(S.parts):
        groups.setdefault(P['group'], []).append(pid)
    gb = {g: S.part_bvh(m)[0] for g, m in groups.items()}
    movers = [g for g in groups if g.split(':')[0] in ('lid', 'door', 'kit', 'turret', 'gun', 'wheel')]
    res = []
    for a in movers:
        A = groups[a]
        vids = [v for p in A for v in S.parts[p]['vids']]
        vids = vids[::max(1, len(vids) // 3000)]
        for b, Bb in gb.items():
            if b == a or (a.startswith('wheel') and b.startswith(('wheel', 'track'))) or (a == 'gun' and b == 'turret') \
               or (a == 'turret' and b == 'gun') or (a.startswith('kit') and b.startswith('kit')):
                continue
            deep, mx, where = 0, 0.0, None
            for v in vids:
                co = S.verts[v]
                loc, nrm, idx, dist = Bb.find_nearest(co)
                if loc is None or dist < DEPTH or dist > 0.6 or (co - loc).dot(nrm) > 0:
                    continue
                if inside_count(Bb, co, Vector((0, 0, 1))) % 2 and inside_count(Bb, co, Vector((0, 0, -1))) % 2 \
                   and inside_count(Bb, co, Vector((1, 0, 0))) % 2:
                    deep += 1
                    if dist > mx:
                        mx, where = dist, co
            if deep >= 3:
                res.append(dict(a=a, b=b, verts=deep, of=len(vids), max_depth_m=round(mx, 3), at=[round(c, 3) for c in where]))
    res.sort(key=lambda r: -r['max_depth_m'] * r['verts'])
    return res


def ghost_lids(closed, opened):
    """closed-lid ghosts: closed pose lid vertices vs open-pose geometry minus the lid itself"""
    out = []
    lids = {}
    for m in closed:
        g = group_of(m)
        if g.startswith(('lid:', 'door:')):
            lids.setdefault(g, []).append(m)
    for g, ms in lids.items():
        others = [m for m in opened if group_of(m) != g]
        verts, tris, off = [], [], 0
        for m in others:
            bm = m['bm']; bm.verts.ensure_lookup_table()
            verts += [v.co.copy() for v in bm.verts]
            tris += [[v.index + off for v in f.verts] for f in bm.faces]
            off += len(bm.verts)
        bvh = BVHTree.FromPolygons(verts, tris, all_triangles=True)
        pts = []
        for m in ms:
            bm = m['bm']
            # outer surface: vertices whose faces face up-ish / outward (all verts is fine: ghost = most verts covered)
            pts += [v.co.copy() for v in bm.verts]
        pts = pts[::max(1, len(pts) // 1500)]
        near = sum(1 for p in pts if bvh.find_nearest(p, 0.004)[0] is not None)
        frac = near / max(1, len(pts))
        out.append(dict(node=g, covered=round(frac, 3), ghost=frac >= 0.5))
    return out


def main(d, names):
    summ = {}
    for n in names:
        rep = dict(name=n)
        f = os.path.join(d, n + '_closed.glb')
        G = os.environ.get('VCHECK_GLB')
        if G:
            man = json.load(open(os.environ.get('VCHECK_MAN', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'assets', 'vehicles', 'manifest.json'))))['vehicles'][n]
            gp = os.path.join(G, n + '.glb')
            loader = lambda opened=False, lod=False: load_glb(gp, man, opened, lod)
        else:
            loader = None
        if loader or os.path.exists(f):
            M = loader() if loader else load(f); S = Scene(M)
            fl, np_ = floating(S)
            rep['parts'] = np_
            rep['floating'] = fl
            rep['penetration_closed'] = penetrations(S)
            fo = os.path.join(d, n + '_open.glb')
            if loader or os.path.exists(fo):
                Mc = M
                Mo = loader(True) if loader else load(fo)
                rep['ghost_lids'] = ghost_lids(Mc, Mo)
                So = Scene(Mo)
                rep['penetration_open'] = [r for r in penetrations(So) if r['a'].startswith(('lid', 'door')) or r['b'].startswith(('lid', 'door'))]
        for lodtag in ('lod1',):
            fc, fo = os.path.join(d, f'{n}_{lodtag}_closed.glb'), os.path.join(d, f'{n}_{lodtag}_open.glb')
            if loader:
                rep['ghost_lids_' + lodtag] = ghost_lids(loader(False, True), loader(True, True))
            elif os.path.exists(fc) and os.path.exists(fo):
                rep['ghost_lids_' + lodtag] = ghost_lids(load(fc), load(fo))
        fk = os.path.join(d, n + '_kits.glb')
        if os.path.exists(fk):
            Sk = Scene(load(fk))
            flk, _ = floating(Sk)
            rep['kit_floating'] = [r for r in flk if any(g.startswith('kit') for g in r['groups'])]
            rep['kit_penetration'] = [r for r in penetrations(Sk) if r['a'].startswith('kit')]
        with open(os.path.join(d, n + '_report.json'), 'w') as fh:
            json.dump(rep, fh, indent=1)
        s = dict(parts=rep.get('parts'), floating=len([r for r in rep.get('floating', []) if r['gap_m'] > TOUCH]),
                 floating_gt3cm=len([r for r in rep.get('floating', []) if r['gap_m'] > 0.03]),
                 penetrations=len(rep.get('penetration_closed', [])), open_clips=len(rep.get('penetration_open', [])),
                 ghost_lids=[g['node'] for g in rep.get('ghost_lids', []) if g['ghost']],
                 ghost_lids_lod1=[g['node'] for g in rep.get('ghost_lids_lod1', []) if g['ghost']],
                 kit_floating=len(rep.get('kit_floating', [])), kit_clips=len(rep.get('kit_penetration', [])))
        summ[n] = s
        print('SUMMARY', n, json.dumps(s), flush=True)
    return summ


if __name__ == '__main__':
    a = sys.argv[1:]
    s = main(a[0], a[1:])
    with open(os.path.join(a[0], 'summary_%s.json' % ('_'.join(a[1:]) if len(a) < 4 else 'all')), 'w') as fh:
        json.dump(s, fh, indent=1)
