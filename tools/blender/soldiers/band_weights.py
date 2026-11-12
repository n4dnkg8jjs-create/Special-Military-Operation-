"""Tape bands (armband_L/R, legband_L/R, <combo>_tape and their LOD1s) in assets/soldiers/soldier_{ua,ru}.glb: copy the skin
weights of the uniform underneath onto the band, in place (numpy + scipy only, no Blender).

The bands were weighted on their own (upper arm: Arm / ArmTwist halves, thigh: UpLeg almost rigid), the sleeve and trouser
under them follow the twist bones, the elbow / shoulder helpers and the hip blend - so in a bent or twisted limb the cloth came
through the band, or the band stood off it. Each band vertex now takes the weights of the nearest points of its uniform mesh
(3 nearest LOD0 vertices, inverse-distance blend, 4 strongest joints), so the band follows the cloth it is taped
round - but only on its own limb segment (v2): a tape ring does not stretch round a bent knee or elbow.  Idempotent.  Usage: python3 tools/blender/soldiers/band_weights.py [--dry]"""
import json, struct, sys, re, os
import numpy as np
from scipy.spatial import cKDTree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
DRY = '--dry' in sys.argv
CT = {5126: ('f', 4), 5123: ('H', 2), 5125: ('I', 4), 5121: ('B', 1)}
BAND = re.compile(r'^(?:(armband|legband)_[LR]|(.+)_tape)(_LOD1)?$')


def run(path):
    d = bytearray(open(path, 'rb').read())
    n = struct.unpack('<I', d[12:16])[0]
    j = json.loads(d[20:20 + n]); b0 = 20 + n + 8

    def view(i):
        a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]; t, sz = CT[a['componentType']]
        k = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
        off = b0 + bv.get('byteOffset', 0) + a.get('byteOffset', 0); st = bv.get('byteStride', sz * k)
        return np.ndarray((a['count'], k), dtype=np.dtype(t), buffer=d, offset=off, strides=(st, sz))

    by = {nd.get('name'): nd for nd in j['nodes'] if 'mesh' in nd}
    jn = [j['nodes'][i].get('name', '') for i in j['skins'][0]['joints']]; nj = len(jn)
    # limbs: a band vertex only looks at cloth of its own limb (in the rest pose the inner upper arm is nearer to the chest side
    # than to some of its own sleeve, the thighs nearly touch)
    limb = np.zeros(nj, int)
    for i, nm in enumerate(jn):
        sd = 1 if re.match(r'^(Left|L[A-Z])', nm) else 2 if re.match(r'^(Right|R[A-Z])', nm) else 0
        part = 1 if re.search(r'Arm|Elbow|Shoulder|Hand', nm) else 2 if re.search(r'UpLeg|Leg|Knee|Foot', nm) else 0
        limb[i] = sd * 10 + part if sd and part else 0

    def dense(nd):
        at = j['meshes'][nd['mesh']]['primitives'][0]['attributes']
        P = view(at['POSITION']).astype(float); J = view(at['JOINTS_0']); W = view(at['WEIGHTS_0'])
        D = np.zeros((len(P), nj)); wf = W.astype(float) / 255.0
        for a in range(4):
            np.add.at(D, (np.arange(len(P)), J[:, a].astype(int)), wf[:, a])
        return P, J, W, D / np.maximum(D.sum(1, keepdims=True), 1e-9)

    trees = {}
    for name, nd in sorted(by.items()):
        m = BAND.match(name)
        if not m: continue
        ref = m.group(2) if m.group(2) else 'combo_0'
        if ref not in by: print('  no reference for', name); continue
        if ref not in trees:
            P, _, _, D = dense(by[ref]); t = {}
            for L in (11, 12, 21, 22):
                sel = np.where(D[:, limb == L].sum(1) >= 0.5)[0]; t[L] = (cKDTree(P[sel]), D[sel])
            trees[ref] = t
        P, J, W, D = dense(nd)
        T = D.copy(); dist = np.zeros((len(P), 3))
        # which limb each band vertex is on - by where it is in the rest pose (v2: the shipped bands had the inner-thigh vertices of
        # one leg's band weighted to the OTHER thigh, so the band tore across when the legs parted): +X is the man's left,
        # arm bands sit above 1.0 m outside the trunk, leg bands below 0.9 m; the helmet band is left alone
        # (per connected piece of the mesh - welded by position, so a ring cut by a UV seam stays one piece - by its centroid:
        # the inner vertices of a leg band reach the centre line)
        pr = j['meshes'][nd['mesh']]['primitives'][0]; tri = view(pr['indices']).astype(int).reshape(-1, 3)
        _, wid = np.unique(np.round(P, 4), axis=0, return_inverse=True); wid = wid.ravel(); wt = wid[tri]
        from scipy.sparse import coo_matrix; from scipy.sparse.csgraph import connected_components
        nw = wid.max() + 1; G = coo_matrix((np.ones(len(wt) * 3), (np.concatenate([wt[:, 0], wt[:, 1], wt[:, 2]]), np.concatenate([wt[:, 1], wt[:, 2], wt[:, 0]]))), shape=(nw, nw))
        _, lab = connected_components(G, directed=False); lab = lab[wid]
        cls = np.zeros(len(P), int)
        for c in np.unique(lab):
            m = lab == c; cx, cy = P[m, 0].mean(), P[m, 1].mean()
            part = 1 if (1.0 < cy < 1.45 and abs(cx) > 0.13) else 2 if cy < 0.9 else 0
            cls[m] = (10 if cx > 0 else 20) + part if part else 0
        for c, L in enumerate((11, 12, 21, 22)):
            sel = np.where(cls == L)[0]
            if not len(sel): continue
            tr, RD = trees[ref][L]
            dd, idx = tr.query(P[sel], k=3); dist[sel] = dd
            w = 1.0 / np.maximum(dd, 1e-4) ** 2; w /= w.sum(1, keepdims=True)
            T[sel] = (RD[idx] * w[:, :, None]).sum(1)
            # v2: a ring of tape does not stretch - it is carried by its own limb segment only (upper arm + its twist bone, or
            # thigh); with the cloth's knee / elbow / trunk weights the band was dragged round the bent joint (kneeling: the leg band
            # pulled forward under the thigh)
            ok = np.array([limb[k] == L and bool(re.search(r'(Arm$|ArmTwist$|UpLeg$)', jn[k])) and 'Fore' not in jn[k] for k in range(nj)])
            Tk = T[sel] * ok[None, :]; sm = Tk.sum(1, keepdims=True)
            main = [k for k in range(nj) if ok[k] and re.search(r'(Arm|UpLeg)$', jn[k])][0]
            Tk = np.where(sm > 0.15, Tk / np.maximum(sm, 1e-9), np.eye(nj)[main][None, :])
            T[sel] = Tk
        top = np.argsort(-T, axis=1)[:, :4]; tw = np.take_along_axis(T, top, 1); tw /= tw.sum(1, keepdims=True)
        q = np.floor(tw * 255 + 0.5).astype(int); q[:, 0] += 255 - q.sum(1)          # sums to 255 exactly
        top[q == 0] = 0
        change = np.abs(T - D).sum(1) / 2
        print('  %-28s %4d verts  off the cloth %.1f mm (max %.1f)  weight moved: mean %.2f max %.2f' % (name, len(P), dist[:, 0].mean() * 1000, dist[:, 0].max() * 1000, change.mean(), change.max()))
        if not DRY:
            J[:] = top.astype(J.dtype); W[:] = q.astype(W.dtype)
    if not DRY:
        open(path, 'wb').write(d)


for f in ('soldier_ua', 'soldier_ru'):
    print(f)
    run(os.path.join(ROOT, 'assets/soldiers', f + '.glb'))
