"""Soldier body construction from the MakeHuman base mesh:
head (+eyes), hands, uniform (offset shell with collar/cuffs), boots.  All variants share topology
(uniform) or are bound to variant A's decimated topology via barycentric binding (head, hands, boots).
"""
import numpy as np
from scipy.spatial import cKDTree
import mhbody as M
import meshutil as MU
from skel import Skel

VARIANTS = {
    # A: average young conscript-age contract soldier
    'A': dict(age=0.53, muscle=0.62, weight=0.52, height=0.5, proportions=0.8, race=(0.9, 0.05, 0.05),
              details={'nose/nose-scale-horiz-incr': 0.2, 'chin/chin-width-incr': 0.3, 'head/head-square': 0.3,
                       'eyebrows/eyebrows-trans-down': 0.3}),
    # B: older (~40), heavier, broad face
    'B': dict(age=0.62, muscle=0.55, weight=0.62, height=0.5, proportions=0.6, race=(0.92, 0.04, 0.04),
              details={'head/head-fat-incr': 0.4, 'nose/nose-scale-horiz-incr': 0.5, 'nose/nose-hump-incr': 0.5,
                       'chin/chin-prominent-incr': 0.3, 'cheek/l-cheek-volume-incr': 0.4, 'cheek/r-cheek-volume-incr': 0.4,
                       'eyes/l-eye-bag-incr': 0.5, 'eyes/r-eye-bag-incr': 0.5, 'head/head-age-incr': 0.4}),
    # C: young, lean, slightly mixed (Central-Asian/Buryat or Slavic-Asian features)
    'C': dict(age=0.5, muscle=0.68, weight=0.42, height=0.5, proportions=0.85, race=(0.6, 0.04, 0.36),
              details={'head/head-oval': 0.4, 'nose/nose-scale-horiz-decr': 0.2, 'chin/chin-height-incr': 0.3,
                       'cheek/l-cheek-bones-incr': 0.4, 'cheek/r-cheek-bones-incr': 0.4}),
}

TORSO = {'Hips', 'LowerBack', 'Spine', 'Spine1', 'LeftShoulder', 'RightShoulder', 'Neck'}
ARM_L = {'LeftArm', 'LeftForeArm'}; ARM_R = {'RightArm', 'RightForeArm'}
LEG_L = {'LHipJoint', 'LeftUpLeg', 'LeftLeg'}; LEG_R = {'RHipJoint', 'RightUpLeg', 'RightLeg'}
HAND_BONES = {'LeftHand', 'LThumb', 'LeftFingerBase', 'LeftHandFinger1', 'RightHand', 'RThumb', 'RightFingerBase', 'RightHandFinger1'}

BOOT_TOP = 0.235      # boot shaft top height (m)
PANTS_BOTTOM = 0.175  # trousers tucked into boots


def human(name):
    return M.make_human(**VARIANTS[name])


class Base:
    """topology-level info (computed from variant A)."""

    def __init__(self):
        o = M.load_obj()
        self.o = o
        vA = human('A')
        self.ground = vA[M.group_verts('joint-ground')].mean(0)[1] * 0.1
        self.skel = Skel(vA, self.ground)
        self.W = M.weights_matrix()
        self.order = M.bone_order()
        self.dom = np.array(self.order)[self.W.argmax(1)]
        self.body_faces = [i for i, g in enumerate(o['g']) if g == 'body']
        self.vA = self.model(vA)

    def model(self, v_dm):
        return v_dm * 0.1 - np.array([0, self.ground, 0])

    def bone(self, n):
        sk = self.skel
        return sk.head[sk.idx[n]], sk.tail[sk.idx[n]]

    def plane_d(self, V, point, normal):
        n = np.asarray(normal, float); n = n / np.linalg.norm(n)
        return (V - point) @ n


def face_sets(B):
    """choose faces (base topology) for head / hands / uniform / boots, using variant A geometry."""
    V = B.vA; o = B.o; dom = B.dom
    nh, nt = B.bone('Neck')
    n1h, _ = B.bone('Neck1')
    neck_dir = (n1h - nh)
    # head + neck: above a plane slightly below the Neck joint
    dn = B.plane_d(V, nh + neck_dir * 0.15, neck_dir)
    # jacket ends below a plane at Neck joint (collar extrusion adds the stand-up collar)
    sets = {k: [] for k in ('head', 'hand_L', 'hand_R', 'uniform', 'boots')}
    lab = {}
    hl, _ = B.bone('LeftHand'); fl, _ = B.bone('LeftForeArm')
    hr, _ = B.bone('RightHand'); fr, _ = B.bone('RightForeArm')
    dwl = B.plane_d(V, hl - (hl - fl) / np.linalg.norm(hl - fl) * 0.035, hl - fl)
    dwr = B.plane_d(V, hr - (hr - fr) / np.linalg.norm(hr - fr) * 0.035, hr - fr)
    y = V[:, 1]
    for fi in B.body_faces:
        f = o['f'][fi]
        d = dn[f]
        bones = set(dom[f])
        if d.min() > -0.035 and not (bones & (HAND_BONES | ARM_L | ARM_R)):
            sets['head'].append(fi)
        if dwl[f].min() > -0.03 and (bones & (HAND_BONES | ARM_L)) and V[f, 0].min() > 0:
            sets['hand_L'].append(fi)
        if dwr[f].min() > -0.03 and (bones & (HAND_BONES | ARM_R)) and V[f, 0].max() < 0:
            sets['hand_R'].append(fi)
        if y[f].max() < BOOT_TOP + 0.01:
            sets['boots'].append(fi)
        armish = bool(bones & (ARM_L | ARM_R | HAND_BONES))
        inside = (d.max() < 0.0 or armish) and (not armish or (dwl[f].max() < 0 and dwr[f].max() < 0)) and y[f].min() > PANTS_BOTTOM
        if inside and not (bones & HAND_BONES):
            sets['uniform'].append(fi)
    return sets


def boundary_loops(faces):
    from collections import defaultdict
    cnt = defaultdict(int); nxt = {}
    for f in faces:
        for k in range(len(f)):
            a, b = f[k], f[(k + 1) % len(f)]
            cnt[(min(a, b), max(a, b))] += 1
            nxt[(a, b)] = True
    bedges = [(a, b) for (a, b) in nxt if cnt[(min(a, b), max(a, b))] == 1]
    succ = {a: b for a, b in bedges}
    loops, seen = [], set()
    for a, b in bedges:
        if a in seen:
            continue
        loop = [a]; seen.add(a); c = succ[a]
        while c != a and c not in seen:
            loop.append(c); seen.add(c); c = succ.get(c, a)
        loops.append(loop)
    return loops


def smooth_normals(V, T, iters=4):
    n = MU.vertex_normals(V, T)
    for _ in range(iters):
        n = MU.laplacian_smooth(n, T, 1, 0.5)
        n /= np.linalg.norm(n, axis=1, keepdims=True)
    return n


REGION_OFFSET = {  # metres outward from skin
    'torso': 0.013, 'arm': 0.011, 'forearm': 0.010, 'thigh': 0.015, 'shin': 0.016,
}


def vertex_region(B, vi):
    d = B.dom[vi]
    if d in ('LeftArm', 'RightArm'):
        return 'arm'
    if d in ('LeftForeArm', 'RightForeArm'):
        return 'forearm'
    if d in ('LeftUpLeg', 'RightUpLeg', 'LHipJoint', 'RHipJoint'):
        return 'thigh'
    if d in ('LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot'):
        return 'shin'
    return 'torso'


def submesh(faces_all, fsel):
    vs = sorted({v for fi in fsel for v in faces_all[fi]})
    g2l = {v: i for i, v in enumerate(vs)}
    F = [[g2l[v] for v in faces_all[fi]] for fi in fsel]
    return np.array(vs), F


def tris_of(F):
    return MU.triangulate(F)


def build_uniform(B, sets, V):
    """V: full-res model-space positions of this variant. Returns dict(pos, faces, W, labels...)"""
    o = B.o
    src, F = submesh(o['f'], sets['uniform'])
    P = V[src].copy()
    T = tris_of(F)
    # body reference for push-out: all body verts of this variant
    body_ids = M.group_verts('body')
    Vb = V[body_ids]
    allF = [o['f'][i] for i in B.body_faces]
    Nb_full = MU.vertex_normals(V, tris_of(allF))
    Nb = Nb_full[body_ids]
    n = smooth_normals(P, T, 6)
    reg = np.array([vertex_region(B, v) for v in src])
    d = np.array([REGION_OFFSET[r] for r in reg])
    y = P[:, 1]
    # blousing of trousers above the boots, baggier seat/thighs, looser elbows
    d += np.clip((0.32 - y) / 0.12, 0, 1) * 0.012 * (reg == 'shin')
    hipy = B.bone('Hips')[0][1]
    d += np.exp(-((y - (hipy - 0.12)) / 0.12) ** 2) * 0.006 * (reg == 'thigh')
    for side in ('Left', 'Right'):
        e = B.bone(side + 'ForeArm')[0]
        d += np.exp(-np.sum((P - e) ** 2, 1) / 0.06 ** 2) * 0.006
        k = B.bone(side + 'Leg')[0]
        d += np.exp(-np.sum((P - k) ** 2, 1) / 0.08 ** 2) * 0.004
    P = P + n * d[:, None]
    # remove anatomy (nipples, navel, ribs, muscles): smooth, keep boundaries a little stiffer
    bl = boundary_loops(F)
    bmask = np.ones(len(P)); 
    for lp in bl:
        bmask[lp] = 0.3
    P = MU.laplacian_smooth(P, T, 10, 0.5, bmask)
    # push out so the shell clears the skin by >= 7 mm
    tree = cKDTree(Vb)
    for it in range(3):
        dist, nn = tree.query(P, k=8)
        rel = P[:, None, :] - Vb[nn]
        h = np.sum(rel * Nb[nn], -1)
        need = np.max(np.where(dist < 0.05, 0.007 - h, -1), 1)
        nP = smooth_normals(P, T, 2)
        P = P + nP * np.clip(need, 0, None)[:, None]
        P = MU.laplacian_smooth(P, T, 1, 0.3, bmask)
    Wv = B.W[src].copy()
    return dict(pos=P, faces=F, W=Wv, src=src, loops=bl)


def ring_extrude(pos, faces, W, loop, rings):
    """append rings of vertices: rings = list of (n,3) positions matching loop order; quads between consecutive rings"""
    pos = list(pos); faces = list(faces); W = list(W)
    prev = list(loop)
    for R in rings:
        cur = []
        for k, v in enumerate(loop):
            pos.append(R[k]); W.append(W[v]); cur.append(len(pos) - 1)
        m = len(loop)
        for k in range(m):
            a, b = prev[k], prev[(k + 1) % m]
            c, d = cur[(k + 1) % m], cur[k]
            faces.append([a, b, c, d])
        prev = cur
    return np.array(pos), faces, np.array(W)


def loop_orient(pos, loop, axis):
    """make loop counter-clockwise around axis"""
    c = pos[loop].mean(0)
    a = 0
    for k in range(len(loop)):
        a += np.dot(np.cross(pos[loop[k]] - c, pos[loop[(k + 1) % len(loop)]] - c), axis)
    return loop if a > 0 else loop[::-1]


def add_collar_cuffs(B, U):
    pos, faces, W = U['pos'], [list(f) for f in U['faces']], U['W']
    extra_labels = []
    nh = B.bone('Neck')[0]; n1 = B.bone('Neck1')[0]
    ax = (n1 - nh) / np.linalg.norm(n1 - nh)
    loops = U['loops']
    nf0 = len(faces)
    # neck loop = highest
    neck = max(loops, key=lambda l: pos[l, 1].mean())
    c = pos[neck].mean(0)
    r0 = pos[neck] - c
    r0 -= np.outer(r0 @ ax, ax)
    rn = r0 / np.linalg.norm(r0, axis=1, keepdims=True)
    H = 0.042
    R1 = c + r0 * 0.93 + ax * H * 0.95 + rn * 0.0
    R2 = c + r0 * 0.93 - rn * 0.006 + ax * H
    R3 = c + r0 * 0.93 - rn * 0.007 + ax * 0.004
    pos, faces, W = ring_extrude(pos, faces, W, neck, [R1, R2, R3])
    extra_labels += ['collar_a' if pos[f].mean(0)[0] > 0 else 'collar_b' for f in faces[nf0:]]
    # cuffs
    for side in ('Left', 'Right'):
        h = B.bone(side + 'Hand')[0]; f = B.bone(side + 'ForeArm')[0]
        a = (h - f) / np.linalg.norm(h - f)
        sgn = 1 if side == 'Left' else -1
        cand = [l for l in loops if np.sign(pos[l, 0].mean()) == sgn]
        lp = max(cand, key=lambda l: pos[l] @ a @ np.ones(len(l)) / len(l))
        c = pos[lp].mean(0)
        r0 = pos[lp] - c; r0 -= np.outer(r0 @ a, a)
        rn = r0 / np.linalg.norm(r0, axis=1, keepdims=True)
        n0 = len(faces)
        R1 = c + r0 * 1.06 + a * 0.004
        R2 = c + r0 * 1.06 - rn * 0.006 + a * 0.006
        R3 = c + r0 * 0.95 - rn * 0.006 - a * 0.03
        pos, faces, W = ring_extrude(pos, faces, W, lp, [R1, R2, R3])
        extra_labels += [('cuff_%s_a' if pos[f].mean(0)[2] > c[2] else 'cuff_%s_b') % side[0] for f in faces[n0:]]
    return dict(pos=pos, faces=faces, W=W, extra_labels=extra_labels, nbase=nf0)


def panel_labels(B, U2):
    """label each face for UV seams: torso/sleeve/leg x front/back"""
    pos, faces = U2['pos'], U2['faces']
    labs = []
    W = U2['W']; order = B.order
    hipy = B.bone('Hips')[0][1]
    for k, f in enumerate(faces):
        if k >= U2['nbase']:
            labs.append(U2['extra_labels'][k - U2['nbase']])
            continue
        w = W[f].sum(0)
        b = order[int(np.argmax(w))]
        c = pos[f].mean(0)
        if b in ARM_L or b in ('LeftHand',):
            reg = 'sleeve_L'
        elif b in ARM_R or b in ('RightHand',):
            reg = 'sleeve_R'
        elif b in LEG_L or b in ('LeftFoot',):
            reg = 'leg_L'
        elif b in LEG_R or b in ('RightFoot',):
            reg = 'leg_R'
        else:
            reg = 'torso' if c[1] > hipy - 0.02 else ('leg_L' if c[0] > 0 else 'leg_R')
        labs.append(reg)
    labs = np.array(labs, dtype=object)
    # front/back split by z relative to local centre of the region
    for reg in ('torso', 'sleeve_L', 'sleeve_R', 'leg_L', 'leg_R'):
        idx = np.where(labs == reg)[0]
        cs = np.array([pos[faces[i]].mean(0) for i in idx])
        if reg == 'torso':
            # centre z per height bin
            bins = np.round(cs[:, 1] / 0.04)
            zc = np.zeros(len(cs))
            for bv in np.unique(bins):
                m = bins == bv
                zc[m] = 0.5 * (cs[m, 2].max() + cs[m, 2].min())
            front = cs[:, 2] > zc
        else:
            # radial z relative to the limb bone polyline
            side = 'Left' if reg.endswith('L') else 'Right'
            chain = [side + 'Arm', side + 'ForeArm', side + 'Hand'] if reg.startswith('sleeve') else [side + 'UpLeg', side + 'Leg', side + 'Foot']
            pts = np.array([B.bone(cn)[0] for cn in chain])
            best = np.full(len(cs), 1e9); rz = np.zeros(len(cs))
            for s in range(2):
                a, b2 = pts[s], pts[s + 1]
                ab = b2 - a
                t = np.clip(((cs - a) @ ab) / (ab @ ab), 0, 1)
                q = a + t[:, None] * ab
                dd = np.linalg.norm(cs - q, axis=1)
                m = dd < best
                best[m] = dd[m]; rz[m] = (cs - q)[m, 2]
            front = rz > 0
        labs[idx] = np.where(front, reg + '_f', reg + '_b')
    return labs


# ---------------------------------------------------------------- binding (decimated -> full-res surface)
def bind(points, V, T):
    """closest point of each point on triangle mesh (V,T): returns tri index, barycentrics, normal offset"""
    from mathutils.bvhtree import BVHTree
    from mathutils import Vector
    tree = BVHTree.FromPolygons([tuple(v) for v in V], [tuple(map(int, t)) for t in T], all_triangles=True)
    ti = np.zeros(len(points), int); bc = np.zeros((len(points), 3)); off = np.zeros(len(points))
    fn = np.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]])
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    for i, p in enumerate(points):
        loc, nrm, idx, dist = tree.find_nearest(Vector(p))
        loc = np.array(loc)
        a, b, c = V[T[idx]]
        v0, v1, v2 = b - a, c - a, loc - a
        d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
        d20, d21 = v2 @ v0, v2 @ v1
        den = d00 * d11 - d01 * d01
        w1 = (d11 * d20 - d01 * d21) / den; w2 = (d00 * d21 - d01 * d20) / den
        ti[i] = idx; bc[i] = (1 - w1 - w2, w1, w2); off[i] = (p - loc) @ fn[idx]
    return ti, bc, off


def eval_bind(binding, V, T):
    ti, bc, off = binding
    tv = V[T[ti]]
    loc = np.einsum('nk,nkj->nj', bc, tv)
    fn = np.cross(tv[:, 1] - tv[:, 0], tv[:, 2] - tv[:, 0])
    fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
    return loc + fn * off[:, None]


def interp_bind(binding, A, T):
    ti, bc, _ = binding
    return np.einsum('nk,nkj->nj', bc, A[T[ti]])
