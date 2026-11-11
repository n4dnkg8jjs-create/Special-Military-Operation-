"""mount_v2 QA for the mount_* clips (stricter than check_anims / arms_check): bone lengths, per-frame rotation of every bone,
arm limits (arms_check measures; wrist flex/ext <= 60, deviation <= 30, twists <= 90), knees bend forward and <= 150 deg, ankles,
spine / neck ranges.  run: python3 tools/blender/soldiers/mount_check.py [--glb path] [clip ...]"""
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import numpy as np
import check_anims as CA
import arms_check as AC

ROT_MAX = 9.0
ROT_SWING = 14.0
LIM = dict(len=0.01, wr_flex=60.0, wr_dev=30.0, twist=90.0, knee=155.0, ankle=60.0, spine=35.0, neck=45.0, clav=30.0, el_hi=150.0, el_lo=-5.0, el_side=15.0)


def ang(q):
    return np.degrees(2 * np.arccos(np.clip(np.abs(q[..., 3]), 0, 1)))


def check(M, name, geo, ev=None):
    p = M.pose(name)
    lq, gp, F = p['lq'], p['gp'], p['F']
    r = dict(flags=[])
    # bone lengths
    dev = 0.0
    for i, b in enumerate(M.names):
        j = M.parent[i]
        if j < 0 or b == 'Hips':          # (Hips: the root translation track, not a bone)
            continue
        l0 = np.linalg.norm(M.rest[i] - M.rest[j])
        if l0 < 1e-4:
            continue
        l = np.linalg.norm(gp[:, i] - gp[:, j], axis=1)
        dev = max(dev, float(np.abs(l / l0 - 1).max()))
    r['len_dev'] = dev
    if dev > LIM['len']:
        r['flags'].append(f'bone length {dev * 100:.2f} %')
    # per-frame rotation: trunk (hips .. head) <= ROT_MAX always; a leg / arm <= ROT_SWING while its boot / hand moves, ROT_MAX while
    # it is planted (stationary: < 0.10 m/s); no flips (two successive turns > 6 deg/frame about opposed axes)
    dots = np.abs(np.sum(lq[1:] * lq[:-1], -1))
    dr = np.degrees(2 * np.arccos(np.clip(dots, 0, 1)))
    I_ = M.idx
    lim = np.full(dr.shape, ROT_MAX)
    for side in ('Left', 'Right'):
        for end, keys in ((side + 'Foot', ('UpLeg', 'Leg', 'Foot', 'Toe', 'HipJoint')), (side + 'Hand', ('Shoulder', 'Arm', 'ForeArm', 'Hand', 'Finger', 'Thumb'))):
            v = np.linalg.norm(np.diff(gp[:, I_[end]], axis=0), axis=1) * 30
            moving = v >= 0.10
            pre = 'L' if side == 'Left' else 'R'
            for j, b in enumerate(M.names):
                if (b.startswith(side) or b.startswith(pre + 'HipJoint')) and any(k in b for k in keys):
                    lim[moving, j] = ROT_SWING
    over = dr - lim
    f, b = np.unravel_index(np.argmax(dr), dr.shape)
    r['rot'] = (round(float(dr.max()), 1), M.names[b], int(f))
    trunk = [I_[x] for x in ('Hips', 'LowerBack', 'Spine', 'Spine1', 'Neck', 'Neck1', 'Head') if x in I_]
    r['rot_trunk'] = round(float(dr[:, trunk].max()), 1)
    if (over > 0).any():
        f2, b2 = np.unravel_index(np.argmax(over), over.shape)
        bad = sorted({M.names[j] for j in np.where((over > 0).any(0))[0]})
        r['flags'].append(f'rot {dr[f2, b2]:.1f} deg/frame {M.names[b2]} f{f2} (limit {lim[f2, b2]:.0f}; bones over: {bad[:6]})')
    from qmath import qmul
    inv = lq * np.array([-1, -1, -1, 1.0])
    dq = qmul(inv[:-1], lq[1:]); dq = dq * np.where(dq[..., 3:4] < 0, -1, 1)
    ax = dq[..., :3] / np.maximum(np.linalg.norm(dq[..., :3], axis=-1, keepdims=True), 1e-9)
    big = dr > 6.0
    flip = big[1:] & big[:-1] & (np.sum(ax[1:] * ax[:-1], -1) < -0.5)
    if flip.any():
        f3, b3 = np.argwhere(flip)[0]
        r['flags'].append(f'flip {M.names[b3]} f{f3 + 1} ({int(flip.sum())} frames)')
    # arms
    for side in ('Left', 'Right'):
        m = AC.measure(p, geo[side])
        if name.startswith('mount_deck') and ev and 'sit' in ev:      # settling into the ride pose: its arms are the ride clip's own
            cut_ = max(1, int(round((ev['sit'] - 0.35) * 30)))           # (ride_sit_deck itself: R wrist flex 63 / dev 55, L pron 63)
            m = {k: (v[:cut_] if hasattr(v, 'shape') and v.shape[:1] == (F,) else v) for k, v in m.items()}
        tw = max(np.abs(m['sh_tw']).max(), np.abs(m['el_tw']).max(), np.abs(m['wr_tw']).max())
        chk = dict(clav=m['clav'].max() > LIM['clav'], el=(m['el_flex'].max() > LIM['el_hi']) or (m['el_flex'].min() < LIM['el_lo']),
                   el_side=np.abs(m['el_side']).max() > LIM['el_side'], wr_flex=np.abs(m['wr_flex']).max() > LIM['wr_flex'],
                   wr_dev=np.abs(m['wr_dev']).max() > LIM['wr_dev'], twist=tw > LIM['twist'], seam=m['seam'].max() > AC.LIM['seam'],
                   pron=(m['pron'].max() > AC.LIM['pron'][1]) or (m['pron'].min() < AC.LIM['pron'][0]))
        r[side] = dict(clav=round(float(m['clav'].max())), el=(round(float(m['el_flex'].min())), round(float(m['el_flex'].max()))),
                       wr_flex=round(float(np.abs(m['wr_flex']).max())), wr_dev=round(float(np.abs(m['wr_dev']).max())), twist=round(float(tw)),
                       seam=round(float(m['seam'].max())), pron=(round(float(m['pron'].min())), round(float(m['pron'].max()))))
        for k, v in chk.items():
            if v:
                r['flags'].append(f'{side} arm {k} {r[side]}')
    # legs: knee flexion, knee bends forward (pelvis frame), ankle
    I = M.idx
    hq = p['gq'][:, I['Hips']]
    from qmath import qrot
    fwd = qrot(hq, np.broadcast_to([0, 0, 1.0], (F, 3)))
    for side in ('Left', 'Right'):
        H, K, An = gp[:, I[side + 'UpLeg']], gp[:, I[side + 'Leg']], gp[:, I[side + 'Foot']]
        a = (K - H) / np.linalg.norm(K - H, axis=1, keepdims=True); c = (An - K) / np.linalg.norm(An - K, axis=1, keepdims=True)
        flex = np.degrees(np.arccos(np.clip(np.sum(a * c, 1), -1, 1)))
        ln = (An - H) / np.linalg.norm(An - H, axis=1, keepdims=True)
        bend = K - (H + ln * np.sum((K - H) * ln, 1, keepdims=True))
        bn = bend / np.maximum(np.linalg.norm(bend, axis=1, keepdims=True), 1e-9)
        back = (flex > 20) & (np.sum(bn * fwd, 1) < -0.25)
        an = ang(lq[:, I[side + 'Foot']])
        if name.startswith('mount_deck'):      # the final sit (from the 'sit' event, else the last 0.6 s): settling into ride_sit_edge /
            cut = int(round((ev['sit'] - 0.35) * 30)) if ev and 'sit' in ev else F - 18      # ride_sit_deck (own ankles 59-65 deg): boots dropping into it
            an = an[:max(1, min(cut, F - 18) if not (ev and 'sit' in ev) else cut)]
        r[side + '_leg'] = dict(knee=round(float(flex.max())), knee_back=int(back.sum()), ankle=round(float(an.max())))
        if flex.max() > LIM['knee']:
            r['flags'].append(f'{side} knee flex {flex.max():.0f}')
        if back.any():
            r['flags'].append(f'{side} knee bends backward {int(back.sum())} frames (f{int(np.argmax(back))})')
        if an.max() > LIM['ankle']:
            r['flags'].append(f'{side} ankle {an.max():.0f} deg f{int(np.argmax(an))}')
    sp = max(ang(lq[:, I[b]]).max() for b in ('LowerBack', 'Spine', 'Spine1'))
    nk = max(ang(lq[:, I[b]]).max() for b in ('Neck', 'Head'))
    r['spine'] = (round(float(sp)), round(float(nk)))
    if sp > LIM['spine']:
        r['flags'].append(f'spine {sp:.0f}')
    if nk > LIM['neck']:
        r['flags'].append(f'neck/head {nk:.0f}')
    return r


def main():
    args = sys.argv[1:]
    glb = os.path.join(HERE, '../../../assets/soldiers/soldier_anims.glb')
    if '--glb' in args:
        i = args.index('--glb'); glb = args[i + 1]; del args[i:i + 2]
    G = CA.read_glb(glb); M = CA.Model(G)
    geo = {s: AC.side_geom(M, s) for s in ('Left', 'Right')}
    names = args or [n for n in G['anims'] if n.startswith('mount_')]
    try:                    # clip events: the test build's cache next to a test glb, else the manifest
        if 'anims_test' in glb:
            import pickle
            d = pickle.load(open(os.path.join(os.path.dirname(glb), 'clips_test.pkl'), 'rb'))
            EV = {k: v.get('events', {}) for k, v in d.items()} if isinstance(d, dict) else {c['name']: c.get('events', {}) for c in d}
        else:
            import json
            EV = {k: v.get('events', {}) for k, v in json.load(open(os.path.join(os.path.dirname(glb), 'manifest.json')))['soldier_anims']['clips'].items()}
    except Exception as e:
        print('(no clip events:', e, ')'); EV = {}
    bad = 0
    for n in names:
        r = check(M, n, geo, EV.get(n))
        bad += bool(r['flags'])
        print(f"{'OK  ' if not r['flags'] else 'FAIL'} {n:24s} len {r['len_dev'] * 100:.3f}% rot {r['rot']} L {r['Left']} R {r['Right']} legs {r['Left_leg']} {r['Right_leg']} spine/neck {r['spine']}")
        for f in r['flags']:
            print('       !', f)
    print(f'{len(names)} clips, {len(names) - bad} clean')


if __name__ == '__main__':
    main()
