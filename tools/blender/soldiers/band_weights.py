"""Tape bands (armband_L/R, legband_L/R, <combo>_tape and their LOD1s) in assets/soldiers/soldier_{ua,ru}.glb: copy the skin
weights of the uniform underneath onto the band, in place (numpy + scipy only, no Blender).

The bands were weighted on their own (upper arm: Arm / ArmTwist halves, thigh: UpLeg almost rigid), the sleeve and trouser
under them follow the twist bones, the elbow / shoulder helpers and the hip blend - so in a bent or twisted limb the cloth came
through the band, or the band stood off it. Each band vertex now takes the weights of the nearest points of its uniform mesh
(3 nearest LOD0 vertices, inverse-distance blend, 4 strongest joints), so the band is carried exactly as the cloth it is taped
round.  Idempotent.  Usage: python3 tools/blender/soldiers/band_weights.py [--dry]"""
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
        own = np.array([[D[:, limb == L].sum(1) for L in (11, 12, 21, 22)]])[0].T          # which limb each band vertex is on
        for c, L in enumerate((11, 12, 21, 22)):
            sel = np.where((own.argmax(1) == c) & (own.max(1) > 0.3))[0]
            if not len(sel): continue
            tr, RD = trees[ref][L]
            dd, idx = tr.query(P[sel], k=3); dist[sel] = dd
            w = 1.0 / np.maximum(dd, 1e-4) ** 2; w /= w.sum(1, keepdims=True)
            T[sel] = (RD[idx] * w[:, :, None]).sum(1)
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
