"""MakeHuman (CC0) base mesh + macro/detail targets + cmu_mb rig/weights, in pure numpy.

Coordinates returned are glTF model space: metres, Y up, +Z forward, feet on y=0.
(MakeHuman's native OBJ frame is already Y-up/+Z-facing, in decimetres.)
"""
import gzip, json, os
import numpy as np

MH = '/home/claude/mpfb2/src/mpfb/data'
_cache = {}


def load_obj():
    if 'obj' in _cache:
        return _cache['obj']
    V, VT, F, FT, G = [], [], [], [], []
    grp = None
    with open(f'{MH}/3dobjs/base.obj') as f:
        for line in f:
            if line.startswith('v '):
                V.append([float(x) for x in line.split()[1:4]])
            elif line.startswith('vt '):
                VT.append([float(x) for x in line.split()[1:3]])
            elif line.startswith('g '):
                grp = line.split()[1].strip()
            elif line.startswith('f '):
                vs, ts = [], []
                for tok in line.split()[1:]:
                    p = tok.split('/')
                    vs.append(int(p[0]) - 1)
                    ts.append(int(p[1]) - 1 if len(p) > 1 and p[1] else -1)
                F.append(vs); FT.append(ts); G.append(grp)
    o = dict(v=np.array(V, np.float64), vt=np.array(VT, np.float64), f=F, ft=FT, g=G)
    o['groups'] = json.load(open(f'{MH}/mesh_metadata/basemesh_vertex_groups.json'))
    _cache['obj'] = o
    return o


def group_verts(name):
    g = load_obj()['groups'][name]
    out = []
    for a, b in g:
        out.extend(range(a, b + 1))
    return np.array(out, int)


def load_target(rel):
    key = 't:' + rel
    if key in _cache:
        return _cache[key]
    p = f'{MH}/targets/{rel}'
    if not p.endswith('.gz'):
        p += '.target.gz'
    idx, d = [], []
    with gzip.open(p, 'rt') as f:
        for line in f:
            s = line.split()
            if len(s) == 4 and not line.startswith('#'):
                idx.append(int(s[0])); d.append([float(s[1]), float(s[2]), float(s[3])])
    r = (np.array(idx, int), np.array(d, np.float64).reshape(-1, 3))
    _cache[key] = r
    return r


def _two(v, lo, mid, hi):
    """Map a 0..1 slider with a neutral mid to weights of (lo, mid, hi)."""
    if v < 0.5:
        return {lo: 1 - v * 2, mid: v * 2}
    return {mid: 1 - (v - 0.5) * 2, hi: (v - 0.5) * 2}


def make_human(age=0.55, muscle=0.6, weight=0.5, height=0.55, proportions=0.7,
               race=(0.85, 0.08, 0.07), details=None):
    """race = (caucasian, african, asian). details = {target_rel_path: weight}."""
    o = load_obj()
    v = o['v'].copy()
    ages = {'young': 1 - (age - 0.5) * 2, 'old': (age - 0.5) * 2} if age >= 0.5 else {'young': 1.0}
    mus = _two(muscle, 'minmuscle', 'averagemuscle', 'maxmuscle')
    wts = _two(weight, 'minweight', 'averageweight', 'maxweight')
    rs = np.array(race, float); rs /= rs.sum()

    def add(rel, w):
        if abs(w) < 1e-4:
            return
        try:
            i, d = load_target(rel)
        except FileNotFoundError:
            return
        if len(i):
            v[i] += d * w

    for rn, rw in zip(('caucasian', 'african', 'asian'), rs):
        for an, aw in ages.items():
            add(f'macrodetails/{rn}-male-{an}', rw * aw)
    for an, aw in ages.items():
        for mn, mw in mus.items():
            for wn, ww in wts.items():
                base = aw * mw * ww
                add(f'macrodetails/universal-male-{an}-{mn}-{wn}', base)
                if height > 0.5:
                    add(f'macrodetails/height/male-{an}-{mn}-{wn}-maxheight', base * (height - 0.5) * 2)
                elif height < 0.5:
                    add(f'macrodetails/height/male-{an}-{mn}-{wn}-minheight', base * (0.5 - height) * 2)
                if proportions > 0.5:
                    add(f'macrodetails/proportions/male-{an}-{mn}-{wn}-idealproportions', base * (proportions - 0.5) * 2)
                elif proportions < 0.5:
                    add(f'macrodetails/proportions/male-{an}-{mn}-{wn}-uncommonproportions', base * (0.5 - proportions) * 2)
    for rel, w in (details or {}).items():
        add(rel, w)
    return v  # MH native units (dm), not yet grounded


def to_model(v_dm, ground):
    m = v_dm * 0.1
    m[:, 1] -= ground
    return m


RIG = None


def rig_def():
    global RIG
    if RIG is None:
        RIG = json.load(open(f'{MH}/rigs/standard/rig.cmu_mb.json'))
    return RIG


def joint_positions(v_dm):
    """Bone head/tail in MH dm coords using the rig's CUBE/MEAN/VERTEX strategies."""
    rig = rig_def()
    o = load_obj()

    def pos(spec):
        st = spec['strategy']
        if st == 'CUBE':
            return v_dm[group_verts(spec['cube_name'])].mean(0)
        if st == 'MEAN':
            return v_dm[np.array(spec['vertex_indices'])].mean(0)
        if st == 'VERTEX':
            return v_dm[spec['vertex_index']]
        raise ValueError(st)

    out = {}
    for b, d in rig.items():
        out[b] = (pos(d['head']), pos(d['tail']), d['parent'] or None)
    return out


def bone_order():
    rig = rig_def()
    order, seen = [], set()

    def visit(b):
        if b in seen:
            return
        p = rig[b]['parent']
        if p:
            visit(p)
        seen.add(b); order.append(b)
    for b in sorted(rig):
        visit(b)
    return order


def weights_matrix(nverts=19158):
    """dense (nverts, nbones) weight matrix in bone_order()."""
    if 'W' in _cache:
        return _cache['W']
    w = json.load(open(f'{MH}/rigs/standard/weights.cmu_mb.json'))['weights']
    order = bone_order()
    W = np.zeros((nverts, len(order)), np.float32)
    for bi, b in enumerate(order):
        for vi, ww in w.get(b, []):
            if vi < nverts:
                W[vi, bi] += ww
    _cache['W'] = W
    return W


def top4(W):
    idx = np.argsort(-W, axis=1)[:, :4]
    ww = np.take_along_axis(W, idx, 1)
    s = ww.sum(1, keepdims=True)
    bad = s[:, 0] < 1e-6
    ww = np.where(s > 1e-6, ww / np.maximum(s, 1e-9), 0)
    return idx.astype(np.uint16), ww.astype(np.float32), bad
