"""Re-author high_crawl in the shipped soldier_anims.glb, in place (numpy only: the soldier GLBs cannot be rebuilt here).

The shipped clip was a shuffle on hands and knees: thighs vertical under the belly, hips at 0.46 m with the shoulders at
0.32 (bottom in the air, back curled), knees sliding 25 cm under the body - a ball that hardly moved. A high crawl (FM 21-75:
'body off the ground, resting on forearms and lower legs, rifle cradled; knees well behind the buttocks to stay low; advance
the right elbow and the left knee together, then the left elbow and the right knee') is low and long:
  * pelvis and shoulders both ~0.22 m up, back level, head up to look ahead
  * a knee is drawn up ALONGSIDE the body (thigh out to the side and forward, inner knee and lower leg on the ground), is
    planted, and the leg pushes the body past it until it trails nearly straight; then it is drawn up again, just off the ground
  * the opposite elbow reaches forward at the same time, is planted, and the body is pulled over it; forearms lie on the
    ground towards the centre line, the right hand keeps the rifle (its world rotation of the old clip: the rifle stays put)
  * the trunk sways and turns a little into each push
Same frame count / length (23 keys, 0.733 s, loops; 0.54 m per cycle = the game's CLIP_SPEED 0.7 m/s), same events (left knee
planted over the first half). Every joint is placed by geometry (thigh / shin / upper arm / forearm lengths exact; knees, lower
legs, elbows and forearms on the ground) and the bones' rotations follow from the joints with the knee / elbow as a hinge; the
arms' twist / joint helpers are re-baked with twist.py's formulas. Idempotent (it does not read the old leg / arm motion).

run:  python3 tools/blender/soldiers/crawl_fix.py [--glb path] [--dry]"""
import os, sys, json, struct
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import check_anims as CA
from qmath import qmul, qinv, qrot, qaxis, qfrom_mat

D = np.pi / 180
NAME = 'high_crawl'
KNEE_Y, ANKLE_Y, ELBOW_Y, WRIST_Y = 0.07, 0.085, 0.065, 0.09
REACH = 0.40                                   # knee's distance from under its hip joint (sets the pelvis height: ~0.22 m)
A_FWD, A_BACK = 72 * D, 20 * D                 # thigh direction, from straight back: drawn up alongside / trailing
PITCH = (74, 5, 5, 4)                          # Hips, LowerBack, Spine, Spine1: the back level
NECK = (-28, -22, -25)                         # Neck, Neck1, Head: looking ahead
YAW, ROLL, SWAY = 6 * D, 4 * D, 0.025
X = np.array([1.0, 0, 0]); Y = np.array([0, 1.0, 0]); Z = np.array([0, 0, 1.0])


def unit(v):
    return v / max(np.linalg.norm(v), 1e-12)


def frame(d, n):
    d = unit(d); n = unit(n - (n @ d) * d)
    return np.stack([d, n, np.cross(d, n)], -1)


def ease(t):
    return 0.5 - 0.5 * np.cos(np.pi * np.clip(t, 0, 1))


def hinge_pair(P, u0, f0, h0, j0, j1, j2):
    """world rotations of the two bones of a hinged limb from its three joints (P = parent's world rotation, unused here)"""
    d1, d2 = unit(j1 - j0), unit(j2 - j1); n = unit(np.cross(d1, d2))
    return qfrom_mat(frame(d1, n) @ frame(u0, h0).T), qfrom_mat(frame(d2, n) @ frame(f0, h0).T)


def half(q):
    q = q.copy()
    if q[3] < 0:
        q = -q
    q[3] += 1
    return q / np.linalg.norm(q)


def twist(q, ax):
    a = 2 * np.arctan2(q[:3] @ ax, q[3])
    return (a + np.pi) % (2 * np.pi) - np.pi


def fade(a):
    t = np.clip((abs(a) - 1.745) / 1.396, 0, 1)
    return 1 - t * t * (3 - 2 * t)


def main():
    args = sys.argv[1:]
    glb = os.path.join(HERE, '../../../assets/soldiers/soldier_anims.glb')
    dry = '--dry' in args
    if dry:
        args.remove('--dry')
    if '--glb' in args:
        i = args.index('--glb'); glb = args[i + 1]
    raw = bytearray(open(glb, 'rb').read())
    n = struct.unpack('<I', raw[12:16])[0]
    g = json.loads(raw[20:20 + n]); bin0 = 20 + n + 8
    G = CA.read_glb(glb); M = CA.Model(G); I = M.idx; T = M.T; par = M.parent
    old = M.pose(NAME); F = old['F']; assert F == 23, F
    lq = old['lq'].copy(); hips_t = np.zeros((F, 3))
    Lt, Ls = np.linalg.norm(T[I['LeftLeg']]), np.linalg.norm(T[I['LeftFoot']])
    La, Lf = np.linalg.norm(T[I['LeftForeArm']]), np.linalg.norm(T[I['LeftHand']])
    hy = KNEE_Y + np.sqrt(Lt * Lt - REACH * REACH)                      # hip joints' height
    hand_w = {s: old['gq'][0, I[s + 'Hand']].copy() for s in ('Left', 'Right')}
    rep = dict(knee=[], ankle=[], elbow=[], wrist=[], toe=[])
    for f in range(F):
        p = (f / (F - 1)) % 1.0
        # ---- trunk
        s2 = np.sin(2 * np.pi * p)
        qh = qmul(qaxis(Y, -YAW * s2), qmul(qaxis(Z, ROLL * s2), qaxis(X, PITCH[0] * D)))
        hj = qrot(qh, T[I['LeftUpLeg']])                                 # (hip joint offset: the pelvis height from the joints' mean)
        hp = np.array([SWAY * s2, hy - (hj[1] + qrot(qh, T[I['RightUpLeg']])[1]) / 2, 0.0])
        lq[f, I['Hips']] = qh; hips_t[f] = hp
        lq[f, I['LowerBack']] = qaxis(X, PITCH[1] * D)
        lq[f, I['Spine']] = qmul(qaxis(Y, 0.6 * YAW * s2), qaxis(X, PITCH[2] * D))
        lq[f, I['Spine1']] = qmul(qaxis(Y, 0.6 * YAW * s2), qmul(qaxis(Z, -ROLL * s2), qaxis(X, PITCH[3] * D)))
        for k, nm in enumerate(('Neck', 'Neck1', 'Head')):
            lq[f, I[nm]] = qaxis(X, NECK[k] * D)
        for s in ('Left', 'Right'):
            lq[f, I[s + 'Shoulder']] = np.array([0, 0, 0, 1.0])
        # world rotation / position of a node from the locals set so far
        def world(nd):
            chain = []
            while nd >= 0:
                chain.append(nd); nd = par[nd]
            q = np.array([0, 0, 0, 1.0]); pos = np.zeros(3)
            for k in reversed(chain):
                t = hips_t[f] if k == I['Hips'] else T[k]
                pos = pos + qrot(q, t); q = qmul(q, lq[f, k])
            return q, pos
        for s, sx, ph in (('Left', 1.0, 0.0), ('Right', -1.0, 0.5)):
            # ---- leg: the knee planted alongside while the body passes it, then drawn up again just off the ground
            a, b, c = I[s + 'UpLeg'], I[s + 'Leg'], I[s + 'Foot']
            P, H = world(par[a]); H = H + qrot(P, T[a])
            phi = (p - ph) % 1.0; z0, z1 = -REACH * np.cos(A_FWD), -REACH * np.cos(A_BACK)
            if phi <= 0.5:
                zk, lift = z0 + (z1 - z0) * phi / 0.5, 0.0
            else:
                t = (phi - 0.5) / 0.5; zk, lift = z1 + (z0 - z1) * ease(t), 0.035 * np.sin(np.pi * t)
            ky = KNEE_Y + lift; r = np.sqrt(max(Lt * Lt - (H[1] - ky) ** 2, 1e-6)); zk = np.clip(zk, -0.97 * r, 0.97 * r)
            K = H + np.array([sx * np.sqrt(r * r - zk * zk), ky - H[1], zk])
            # the lower leg: folded back along the body while the knee is drawn up, in line with the thigh as the leg trails
            wk = np.clip((zk - z0) / (z1 - z0), 0, 1) * 0.85; th = unit(np.array([K[0] - H[0], 0.0, K[2] - H[2]]))
            sd = unit((1 - wk) * np.array([-sx * 0.10, 0.0, -1.0]) + wk * th)
            A = K + Ls * unit(np.array([sd[0], (ANKLE_Y + lift * 0.6 - ky) / Ls, sd[2]]))
            u0, f0 = unit(T[b]), unit(T[c]); h0 = unit(X - (X @ u0) * u0)
            qa, qb = hinge_pair(P, u0, f0, h0, H, K, A)
            lq[f, a] = qmul(qinv(P), qa); lq[f, b] = qmul(qinv(qa), qb); lq[f, c] = qaxis(X, 50 * D)
            lq[f, I[s + 'ToeBase']] = np.array([0, 0, 0, 1.0])
            rep['knee'].append(K[1]); rep['ankle'].append(A[1]); rep['toe'].append((A + qrot(qmul(qb, lq[f, c]), T[I[s + 'ToeBase']]))[1])
            # ---- arm: the opposite elbow goes forward with this side's knee... i.e. this elbow with the OTHER knee
            a, b, c = I[s + 'Arm'], I[s + 'ForeArm'], I[s + 'Hand']
            P, S = world(par[a]); S = S + qrot(P, T[a])
            pa = (p - ph + 0.5) % 1.0; r = np.sqrt(max(La * La - (S[1] - ELBOW_Y) ** 2, 9e-4))
            if pa <= 0.5:
                dz, lift = (0.92 - 1.47 * pa / 0.5) * r, 0.0
            else:
                t = (pa - 0.5) / 0.5; dz, lift = (-0.55 + 1.47 * ease(t)) * r, 0.03 * np.sin(np.pi * t)
            r2 = np.sqrt(max(La * La - (S[1] - ELBOW_Y - lift) ** 2, 9e-4)); dz = np.clip(dz, -0.97 * r2, 0.97 * r2)
            E = S + np.array([sx * np.sqrt(r2 * r2 - dz * dz), ELBOW_Y + lift - S[1], dz])
            W = E + Lf * unit(np.array([sx * 0.09, WRIST_Y + lift, S[2] + 0.27 + 0.45 * dz]) - E)
            u0, f0 = unit(T[b]), unit(T[c]); h0 = unit(np.cross(u0, f0))
            qa, qb = hinge_pair(P, u0, f0, h0, S, E, W)
            lq[f, a] = qmul(qinv(P), qa); lq[f, b] = qmul(qinv(qa), qb); lq[f, c] = qmul(qinv(qb), hand_w[s])
            rep['elbow'].append(E[1]); rep['wrist'].append(W[1])
            # twist / joint helpers (twist.py)
            ta, th = twist(lq[f, a], u0), twist(lq[f, c], f0)
            at = qaxis(u0, -0.5 * ta * fade(ta)); lq[f, I[s + 'ArmTwist']] = at
            lq[f, I[s + 'ForeArmTwist']] = qaxis(f0, 0.5 * th * fade(th))
            lq[f, I[s + 'ElbowHelper']] = half(lq[f, b]); lq[f, I[s + 'ShoulderHelper']] = half(qmul(lq[f, a], at))
    lq[F - 1] = lq[0]; hips_t[F - 1] = hips_t[0]
    for nd in range(M.n):                                                # same hemisphere frame to frame
        for f in range(1, F):
            if (lq[f, nd] * lq[f - 1, nd]).sum() < 0:
                lq[f, nd] = -lq[f, nd]
    print('pelvis', round(float(hips_t[:, 1].mean()), 3), 'm;', {k: (round(float(min(v)), 3), round(float(max(v)), 3)) for k, v in rep.items()})
    rate = max(float(np.degrees(2 * np.arccos(np.clip(np.abs((lq[1:, nd] * lq[:-1, nd]).sum(-1)), 0, 1))).max()) for nd in range(M.n))
    print('largest bone rotation per frame', round(rate, 1), 'deg')
    use = {}
    for a in g['animations']:
        for s in a['samplers']:
            use[s['output']] = use.get(s['output'], 0) + 1
    an = next(x for x in g['animations'] if x['name'] == NAME); wrote = 0
    for ch in an['channels']:
        nd, path = ch['target']['node'], ch['target']['path']
        v = lq[:, nd] if path == 'rotation' else hips_t if (path == 'translation' and nd == I['Hips']) else None
        if v is None or (path == 'rotation' and np.allclose(v, old['lq'][:, nd], atol=1e-7)):
            continue
        ai = an['samplers'][ch['sampler']]['output']
        acc = g['accessors'][ai]; bv = g['bufferViews'][acc['bufferView']]
        assert use[ai] == 1 and acc['componentType'] == 5126 and acc['count'] == F and not bv.get('byteStride'), (nd, path)
        o = bin0 + bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
        raw[o:o + F * 4 * v.shape[1]] = v.astype('<f4').tobytes(); wrote += 1
        if 'min' in acc:                                                   # (translation accessor bounds)
            acc['min'] = [float(x) for x in v.min(0)]; acc['max'] = [float(x) for x in v.max(0)]
    print(wrote, 'tracks rewritten')
    if not dry:
        js = json.dumps(g, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
        if len(js) == n:
            raw[20:20 + n] = js
        open(glb, 'wb').write(raw)
        print('written', glb)


if __name__ == '__main__':
    main()
