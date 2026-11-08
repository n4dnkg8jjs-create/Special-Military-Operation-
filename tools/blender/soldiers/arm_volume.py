"""arms_v2: arm VOLUME QA of the shipped soldier GLB under every clip of soldier_anims.glb (linear blend skinning exactly as three.js:
the GLB's own joints / weights / bind matrices).
run: python3 tools/blender/soldiers/arm_volume.py [--soldier glb] [--anims glb] [--step 3] [--json out.json] [clip ...]

Per arm, the sleeve (body_A) vertices that ride the arm (arm-bone weight > 0.5, within 9 cm of the bone line) are binned along the
bind-pose limb polyline shoulder -> elbow -> wrist (t 0..1 upper arm, 1..2 forearm, bins of 0.1).  Per frame each bin's
cross-section ~ mean squared distance of its vertices to their own POSED limb segment line (upper arm / forearm); ratio to the bind pose:
  area   ratio < 0.85 (thin: candy-wrap / collapse / pinch) or > 1.15 (thick: bulge, weights overlapping the wrong bone) -> flagged
Also per node (hands, gloves, armbands, armour shoulder pads, elbow pads) the 95th percentile of the per-vertex distance change
relative to the bind pose ("stretch", should stay ~0 for rigid kit)."""
import os, sys, json, struct
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np
import check_anims as CA
from qmath import qrot

ROOT = os.path.abspath(os.path.join(HERE, '../../..'))
ARM = ('Arm', 'ArmTwist', 'ForeArm', 'ForeArmTwist', 'ElbowHelper', 'ShoulderHelper')
LIM = 0.15
NODES = ('hands', 'gloves', 'armband_L', 'armband_R', 'armor_arms', 'elbowpads')


def read_soldier(path):
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    g = json.loads(b[20:20 + n])
    off = 20 + n
    bl = struct.unpack('<I', b[off:off + 4])[0]
    raw = np.frombuffer(b[off + 8:off + 8 + bl], np.uint8)
    CT = {5126: (np.float32, 4), 5121: (np.uint8, 1), 5123: (np.uint16, 2), 5125: (np.uint32, 4)}
    NC = dict(SCALAR=1, VEC2=2, VEC3=3, VEC4=4, MAT4=16)

    def acc(i):
        a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]
        dt, sz = CT[a['componentType']]; k = NC[a['type']]
        st = bv.get('byteStride', sz * k); o = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        idx = o + np.arange(a['count'])[:, None] * st + np.arange(k * sz)[None]
        x = raw[idx].copy().view(dt).reshape(a['count'], k).astype(np.float64)
        if a.get('normalized'):
            x /= np.iinfo(dt).max
        return x
    sk = g['skins'][0]
    jn = [g['nodes'][j]['name'] for j in sk['joints']]
    ibm = acc(sk['inverseBindMatrices']).reshape(-1, 4, 4)
    head = -ibm[:, 3, :3]                 # column-major: translation in the last column -> row 3 here
    meshes = {}
    for m in g['meshes']:
        P, J, W = [], [], []
        for p in m['primitives']:
            at = p['attributes']
            if 'JOINTS_0' not in at:
                continue
            P.append(acc(at['POSITION'])); J.append(acc(at['JOINTS_0']).astype(int)); W.append(acc(at['WEIGHTS_0']))
        if P:
            W_ = np.concatenate(W); W_ /= W_.sum(1, keepdims=True)
            meshes[m['name']] = (np.concatenate(P), np.concatenate(J), W_)
    return jn, head, meshes


def resplit(jn, head, meshes, M):
    import twist

    class _S:
        pass
    s0 = _S(); s0.names = jn[:31]; s0.idx = {n: i for i, n in enumerate(s0.names)}; s0.head = head[:31]
    s0.parent = np.array([s0.idx.get(M.names[M.parent[M.idx[n]]], -1) for n in s0.names]); s0.tail = s0.head.copy(); s0.n = 31
    sx = twist.extend(s0)
    out = {}
    for k, (P, J, W) in meshes.items():
        D = np.zeros((len(P), len(jn)))
        for c in range(4):
            np.add.at(D, (np.arange(len(P)), J[:, c]), W[:, c])
        for side in ('Left', 'Right'):
            for b in ('Arm', 'ForeArm'):
                if side + b + 'Twist' in jn:
                    D[:, jn.index(side + b)] += D[:, jn.index(side + b + 'Twist')]
        Wn = twist.split_weights(sx, P, D[:, :31])
        o = np.argsort(-Wn, 1)[:, :4]; w = np.take_along_axis(Wn, o, 1); w /= w.sum(1, keepdims=True)
        out[k] = (P, o, w)
    return list(sx.names), sx.head, out


DQS = '--dqs' in sys.argv     # measure with dual-quaternion skinning (src/game/soldierSkin.js) instead of linear blend


def skin_dq(P, J, Wt, gq, gp, head):
    """dual-quaternion skinning (Kavan 2007), same as the shader: per bone (real q, translation t = gp - q head), blended with the
    sign of each real part aligned to the first influence, normalised"""
    from qmath import qmul
    t = gp - qrot(gq, np.broadcast_to(head, gq.shape[:-1] + (3,)))            # (F, nb, 3)
    td = np.concatenate([t, np.zeros(t.shape[:-1] + (1,))], -1)
    dual = 0.5 * qmul(td, gq)                                                 # (F, nb, 4)
    q0 = gq[:, J[:, 0]]
    R = 0; D = 0
    for k in range(4):
        qk = gq[:, J[:, k]]; dk = dual[:, J[:, k]]
        s = np.sign(np.sum(qk * q0, -1, keepdims=True)); s[s == 0] = 1
        w = Wt[None, :, k:k + 1] * s
        R = R + w * qk; D = D + w * dk
    n = np.linalg.norm(R, axis=-1, keepdims=True)
    R = R / n; D = D / n
    Rc = R.copy(); Rc[..., :3] *= -1
    tr = 2 * qmul(D, Rc)[..., :3]
    return qrot(R, np.broadcast_to(P, R.shape[:-1] + (3,))) + tr


def seg_dist(x, a, b):
    """distance of points x (..., 3) to segment a-b (..., 3) and the parameter"""
    d = b - a
    t = np.clip(np.sum((x - a) * d, -1) / np.maximum(np.sum(d * d, -1), 1e-12), 0, 1)
    return np.linalg.norm(x - (a + d * t[..., None]), axis=-1), t


def poly(x, S, E, Wr):
    d1, t1 = seg_dist(x, S, E); d2, t2 = seg_dist(x, E, Wr)
    return np.minimum(d1, d2), np.where(d1 <= d2, t1, 1 + t2)


def line_dist(x, a, b):
    d = (b - a) / np.linalg.norm(b - a, axis=-1, keepdims=True)
    v = x - a
    return np.linalg.norm(v - np.sum(v * d, -1, keepdims=True) * d, axis=-1)


def main():
    a = sys.argv[1:]
    opt = lambda k, d: a[a.index(k) + 1] if k in a else d
    sol = opt('--soldier', f'{ROOT}/assets/soldiers/soldier_ua.glb')
    ani = opt('--anims', f'{ROOT}/assets/soldiers/soldier_anims.glb')
    step = int(opt('--step', 3)); js = opt('--json', None)
    vals = {opt(k, None) for k in ('--soldier', '--anims', '--step', '--json')}
    clips = [x for x in a if not x.startswith('--') and x not in vals] or None
    jn, head, meshes = read_soldier(sol)
    G = CA.read_glb(ani); M = CA.Model(G)
    if '--resplit' in a:      # prototype: weights of the shipped GLB re-split with the current twist.py (no soldier rebuild)
        jn, head, meshes = resplit(jn, head, meshes, M)
    gi = np.array([M.idx[n] for n in jn])
    out = {}
    sides = {}
    for side in ('Left', 'Right'):
        ji = {n: jn.index(n) for n in jn}
        S, E, Wr = head[ji[side + 'Arm']], head[ji[side + 'ForeArm']], head[ji[side + 'Hand']]
        armj = [ji[side + b] for b in ARM if side + b in ji]
        P, J, Wt = meshes['body_A']
        wa = sum((Wt * (J == j)).sum(1) for j in armj)
        rp, t0 = poly(P, S, E, Wr)
        sel = (wa > 0.5) & (rp < 0.09) & (t0 > 0.0) & (t0 < 1.97)
        r0 = np.where(t0 < 1, line_dist(P, S, E), line_dist(P, E, Wr))
        bins = np.minimum((t0[sel] / 0.1).astype(int), 19)
        sides[side] = dict(t0=t0[sel], S=ji[side + 'Arm'], E=ji[side + 'ForeArm'], W=ji[side + 'Hand'], sel=sel, bins=bins,
                           n=int(sel.sum()), A0=np.array([np.mean(r0[sel][bins == k] ** 2) if (bins == k).any() else np.nan for k in range(20)]))
    nodes = {k: v for k, v in meshes.items() if k in NODES}
    tot_frames = 0; flag = {'thin': 0, 'thick': 0}; worst = []
    node_st = {k: [] for k in nodes}
    for c in G['anims']:
        if clips and c not in clips:
            continue
        pose = M.pose(c)
        fr = list(range(0, pose['F'], step))
        gq = pose['gq'][fr][:, gi]; gp = pose['gp'][fr][:, gi]

        def skin(P, J, Wt):
            if DQS:
                return skin_dq(P, J, Wt, gq, gp, head)
            V = np.zeros((len(fr),) + P.shape)
            for k in range(4):
                j = J[:, k]
                V += Wt[None, :, k:k + 1] * (gp[:, j] + qrot(gq[:, j], P[None] - head[j][None]))
            return V
        P, J, Wt = meshes['body_A']
        res = {}
        for side, s in sides.items():
            m = s['sel']
            V = skin(P[m], J[m], Wt[m])
            Sp, Ep, Wp = gp[:, s['S']][:, None], gp[:, s['E']][:, None], gp[:, s['W']][:, None]
            # radius about the vertex's OWN limb segment (upper arm / forearm line, posed): a bent elbow's inner side is not
            # mistaken for the other segment
            up = (s['t0'] < 1)[None]
            r = np.where(up, line_dist(V, Sp, Ep), line_dist(V, Ep, Wp))
            A = np.stack([np.mean(r[:, s['bins'] == k] ** 2, 1) if (s['bins'] == k).any() else np.full(len(fr), np.nan) for k in range(20)], 1)
            ratio = A / s['A0'][None]
            rn = np.nan_to_num(ratio, nan=1)
            thin = rn[:, 2:] < 1 - LIM; thick = rn[:, 2:] > 1 + LIM
            flag['thin'] += int(thin.any(1).sum()); flag['thick'] += int(thick.any(1).sum()); tot_frames += len(fr)
            flag['ring_thin'] = flag.get('ring_thin', 0) + int((rn[:, :2] < 1 - LIM).any(1).sum())
            flag['ring_thick'] = flag.get('ring_thick', 0) + int((rn[:, :2] > 1 + LIM).any(1).sum())
            for k in range(20):
                flag.setdefault('bin_thin', [0] * 20)[k] += int((rn[:, k] < 1 - LIM).sum())
            dev = np.abs(np.nan_to_num(ratio, nan=1.0) - 1); dev[:, :2] = 0
            k = int(dev.max(1).argmax())
            worst.append((float(dev.max()), c, side, fr[k], int(dev[k].argmax())))
            res[side] = dict(min=float(np.nanmin(ratio)), max=float(np.nanmax(ratio)), thin=int(thin.any(1).sum()), thick=int(thick.any(1).sum()),
                             F=len(fr), min_bin=int(np.nanargmin(ratio.min(0))), max_bin=int(np.nanargmax(ratio.max(0))))
        for nm, (Pn, Jn, Wn) in nodes.items():
            # kit on the arm: per-vertex distance from its own limb segment line vs the bind pose (a band / pad that follows the
            # limb keeps it; stretching / squashing changes it).  Hands / gloves: only the wrist-cuff part behind the wrist.
            V = skin(Pn, Jn, Wn)
            rs = []
            for side, sd in sides.items():
                S0, E0, W0 = head[sd['S']], head[sd['E']], head[sd['W']]
                rp, tt = poly(Pn, S0, E0, W0)
                m = (rp < 0.10) & (tt > 0.15) & (tt < 1.0 if nm in ('hands', 'gloves') else tt < 1.97)
                if nm in ('hands', 'gloves'):
                    m = (rp < 0.10) & (tt > 1.6) & (tt < 1.99)
                if m.sum() < 5:
                    continue
                up = tt[m] < 1
                r0 = np.where(up, line_dist(Pn[m], S0, E0), line_dist(Pn[m], E0, W0))
                Sp, Ep, Wp = gp[:, sd['S']][:, None], gp[:, sd['E']][:, None], gp[:, sd['W']][:, None]
                r = np.where(up[None], line_dist(V[:, m], Sp, Ep), line_dist(V[:, m], Ep, Wp))
                rs.append(np.abs(r / np.maximum(r0, 0.01) - 1).ravel())
            if rs:
                node_st[nm].append(float(np.percentile(np.concatenate(rs), 95)))
        out[c] = res
    worst.sort(reverse=True)
    if '--quiet' not in a:
        for c, r in out.items():
            for s, x in r.items():
                if x['thin'] or x['thick']:
                    print(f"{c:28s} {s[0]} frames {x['F']:3d} thin {x['thin']:3d} thick {x['thick']:3d}  area ratio {x['min']:.2f} (bin {x['min_bin']}) .. {x['max']:.2f} (bin {x['max_bin']})")
    print(f'shoulder joint ring (bins 0-1, first 5 cm, shared with the torso): thin {flag["ring_thin"]} ({100*flag["ring_thin"]/tot_frames:.1f} %), thick {flag["ring_thick"]}')
    print('per-bin thin % (t = 0..2 in 0.1 steps, 1 = elbow):', [round(100 * x / tot_frames, 1) for x in flag['bin_thin']])
    print(f'LIMB (bins 2-19) TOTAL arm-frames {tot_frames}: thin (<{1-LIM:.2f}) {flag["thin"]} ({100*flag["thin"]/tot_frames:.1f} %), thick (>{1+LIM:.2f}) {flag["thick"]} ({100*flag["thick"]/tot_frames:.1f} %)')
    allr = [(x['min'], x['max']) for r in out.values() for x in r.values()]
    print('area ratio range over all clips: %.2f .. %.2f' % (min(v[0] for v in allr), max(v[1] for v in allr)))
    print('worst:', [(round(e, 2), c, s[0], f, 'bin%d' % b) for e, c, s, f, b in worst[:10]])
    print('kit radius change p95 (max over clips):', {k: round(max(v), 3) for k, v in node_st.items() if v})
    if js:
        json.dump(dict(clips=out, flag=flag, frames=tot_frames, worst=worst[:40], kit={k: max(v) for k, v in node_st.items() if v}), open(js, 'w'), indent=0)


if __name__ == '__main__':
    main()
