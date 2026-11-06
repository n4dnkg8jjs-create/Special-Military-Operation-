"""soldiers_v8 wrist QA: poses the sleeve ends (cinched sleeve + hem, every body variant) and the hands / gloves (wrist.py) with
every clip of assets/soldiers/soldier_anims.glb (linear blend skinning, exactly the game's skinning) and measures per clip
  poke   glove / skin points under the sleeve that end up outside the hem's inner facing (m, > 2 mm flagged)
  gap    widest opening between the hem's inner edge and the glove / hand surface (m, > 12 mm flagged: you could look in)
  bind   the same at the bind pose (reference)
run: python3 tools/blender/soldiers/wrist_check.py [--fac ua|ru] [--step 2] [clip ...]"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import bpy  # noqa  (provides mathutils)
from mathutils.bvhtree import BVHTree
from mathutils import Vector
import build_soldier as BS, anim as A, wrist as WR, check_anims as CA
from qmath import qrot

POKE, GAP = 0.002, 0.012


def lbs(P, W, gq, gp, rest, jmap):
    """P (n,3) bind positions, W (n,nb) skeleton-index weights -> posed (n,3)"""
    out = np.zeros_like(P)
    for b in np.where(W.sum(0) > 0)[0]:
        w = W[:, b]; m = w > 0
        j = jmap[b]
        out[m] += w[m, None] * (gp[j] + qrot(np.repeat(gq[j][None], m.sum(), 0), P[m] - rest[j]))
    return out


def main():
    args = sys.argv[1:]
    fac = 'ua'; step = 2
    if '--fac' in args:
        i = args.index('--fac'); fac = args[i + 1]; del args[i:i + 2]
    if '--step' in args:
        i = args.index('--step'); step = int(args[i + 1]); del args[i:i + 2]
    R = BS.load(); BS.thicken_uniform(R)
    sk = R['skel']
    rig = A.Rig(sk, R['hands']['pos'], R['hands']['W'])
    S = WR.apply(R, rig)
    gp_, _, _ = WR.glove_mesh(R, S, rig, fac)
    U = R['uniform']; H = R['hands']
    lab = np.array(U['labels'])
    G = CA.read_glb(f'{BS.ASSETS}/soldier_anims.glb'); M = CA.Model(G)
    jmap = np.array([M.idx[n] for n in sk.names]) if hasattr(sk, 'names') else np.array([M.idx[n] for n, _ in sorted(sk.idx.items(), key=lambda kv: kv[1])])
    sets = []
    for side, sx in WR.SIDES:
        fr = S[side]['fr']
        hm = np.char.startswith(lab, 'hem_' + side[0])
        ht = U['tri'][hm]
        ring = U['hem_ring']
        fac_t = ht[np.isin(ring[ht], (2, 3)).all(1)]                     # inner facing
        edge = np.unique(ht)[ring[np.unique(ht)] == 2]                    # inner edge of the hem
        for vn in 'ABC':
            P = R['variants'][vn]['uniform_pos']
            es, _, eth = WR.cyl(P[edge], fr)
            o = np.argsort(eth); eth, es = eth[o], es[o]
            for nm, Q in (('gloves', gp_), ('hands', H['pos'])):
                qs, _, qth = WR.cyl(Q, fr)
                se = np.interp(qth, eth, es, period=2 * np.pi)            # hem edge s at that angle
                ms = (np.sign(Q[:, 0]) == sx)
                inside = np.where(ms & (qs < se - 0.004) & (qs > se - 0.026))[0]
                gl_t = H['tri'][ms[H['tri']].all(1)]
                sets.append(dict(side=side, vn=vn, nm=nm, P=P, fac_t=fac_t, edge=edge, Q=Q, inside=inside, gl_t=gl_t))
    names = args or list(G['anims'])

    def measure(st, Pp, Qp):
        ft = BVHTree.FromPolygons([tuple(v) for v in Pp], [tuple(map(int, t)) for t in st['fac_t']], all_triangles=True)
        poke = 0.0
        for i in st['inside']:
            loc, n, fi, d = ft.find_nearest(Vector(Qp[i]))
            if loc is None:
                continue
            sgn = (Qp[i] - np.array(loc)) @ np.array(n)
            if -sgn > poke:
                poke = -sgn; st['why'] = (int(i), int(fi), float(d))
            poke = max(poke, -sgn)
        gt = BVHTree.FromPolygons([tuple(v) for v in Qp], [tuple(map(int, t)) for t in st['gl_t']], all_triangles=True)
        gap = 0.0
        for i in st['edge']:
            loc, n, _, d = gt.find_nearest(Vector(Pp[i]))
            if loc is not None:
                gap = max(gap, d)
        return poke, gap
    # bind pose
    print('bind pose:')
    for st in sets:
        p, g = measure(st, st['P'], st['Q'])
        print(f'  {st["side"]:5s} {st["vn"]} {st["nm"]:6s} poke {p * 1000:5.1f} mm  gap {g * 1000:5.1f} mm')
    Wu = U['W']; Wh = H['W']
    bad = []
    worst = dict(poke=(0, ''), gap=(0, ''))
    for n in names:
        po = M.pose(n)
        frames = range(0, po['F'], step)
        mp = mg = 0.0
        for f in frames:
            gq, gp = po['gq'][f], po['gp'][f]
            cache = {}
            for st in sets:
                kP = (st['vn'],); kQ = (st['nm'],)
                if kP not in cache:
                    cache[kP] = lbs(st['P'], Wu, gq, gp, M.rest, jmap)
                if kQ not in cache:
                    cache[kQ] = lbs(st['Q'], Wh, gq, gp, M.rest, jmap)
                p, g = measure(st, cache[kP], cache[kQ])
                if p > mp:
                    mp = p
                if g > mg:
                    mg = g
                if p > worst['poke'][0]:
                    i_, fi_, d_ = st['why']
                    worst['poke'] = (p, f'{n} f{f} {st["side"]} {st["vn"]} {st["nm"]} vert {i_} ring {H["tube_ring"][i_]} s {WR.cyl(st["Q"][i_:i_ + 1], S[st["side"]]["fr"])[0][0]:.3f} '
                                        f'face rings {U["hem_ring"][st["fac_t"][fi_]].tolist()} dist {d_ * 1000:.1f} mm')
                if g > worst['gap'][0]:
                    worst['gap'] = (g, f'{n} f{f} {st["side"]} {st["vn"]} {st["nm"]}')
        flag = mp > POKE or mg > GAP
        if flag:
            bad.append(n)
        print(f'{"FAIL" if flag else "OK  "} {n:26s} poke {mp * 1000:5.1f} mm  gap {mg * 1000:5.1f} mm', flush=True)
    print(f'\n{len(names)} clips, {len(names) - len(bad)} clean, {len(bad)} flagged: {bad}')
    print('worst poke %.1f mm (%s), worst gap %.1f mm (%s)' % (worst['poke'][0] * 1000, worst['poke'][1], worst['gap'][0] * 1000, worst['gap'][1]))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
