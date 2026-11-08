"""arms_v1: arm joint-limit QA over every clip of assets/soldiers/soldier_anims.glb (exactly what the game plays).
run: python3 tools/blender/soldiers/arms_check.py [--glb path] [--json out.json] [--quiet] [clip ...]

Per side and frame, from the LOCAL joint rotations (bind pose = identity, joint frames world-aligned, A-pose with the elbow bent
~46 deg, crease forward):
  clav    LeftShoulder / RightShoulder (clavicle) rotation angle                         flag > 30 deg       ("shoulder popping")
  sh_tw   upper-arm twist about its rest axis (Arm local, swing-twist)                  flag |x| > 75 deg   (candy-wrapper at the shoulder)
  el_flex elbow flexion = 46 deg rest + swing about the rest hinge axis (u0 x f0)       flag < -5 (hyperextension) or > 150
  el_side elbow swing about the axis perpendicular to the hinge (sideways bend)          flag |x| > 15 deg
  el_tw   forearm twist about its rest axis relative to the upper arm (ForeArm local)    flag |x| > 75 deg   (twist at the elbow skin)
  wr_tw   hand twist about the forearm axis at the wrist seam (Hand local; minus the ForeArmTwist helper's twist when present)
                                                                                         flag |x| > 45 deg   (twist concentrated at the wrist)
  wr_bend hand swing (flexion / extension / deviation) relative to the forearm           flag > 70 deg
  tw_tot  el_tw + wr_tw (pronation / supination relative to rest)                        flag |x| > 110 deg
With twist helper bones (LeftForeArmTwist / LeftArmTwist ...) present the skin seams see only part of the twist: `seam` reports
the largest twist step any skin seam (shoulder, elbow, mid-forearm, wrist) has to absorb (deg) - the number that makes candy-wrap."""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np
import check_anims as CA
import armfix as AF
from qmath import qmul, qinv, qnorm

ROOT = os.path.abspath(os.path.join(HERE, '../../..'))
LIM = dict(clav=30.0, sh_tw=75.0, el_lo=-5.0, el_hi=150.0, el_side=15.0, pron=(-120.0, 55.0), wr_tw=45.0, wr_flex=(-70.0, 80.0),
           wr_dev=(-35.0, 25.0), seam=60.0)
REST_FLEX = None


def unit(v):
    return v / np.linalg.norm(v)


def twist_angle(q, axis):
    """signed twist (rad) of quaternions q (F,4) about unit axis, short way"""
    p = q[:, :3] @ axis
    return 2 * np.arctan2(p, q[:, 3])


def swing_vec(q, axis):
    """rotation vector (F,3) of the swing part of q (q = swing * twist about axis)"""
    p = (q[:, :3] @ axis)[:, None] * axis[None]
    tw = np.concatenate([p, q[:, 3:4]], 1)
    tw /= np.linalg.norm(tw, axis=1, keepdims=True) + 1e-12
    sw = qmul(q, qinv(tw))
    sw = np.where(sw[:, 3:4] < 0, -sw, sw)
    s = np.linalg.norm(sw[:, :3], axis=1, keepdims=True)
    ang = 2 * np.arctan2(s[:, 0], sw[:, 3])
    return sw[:, :3] / np.maximum(s, 1e-12) * ang[:, None]


def unwrap_deg(a):
    """twist as the skin sees it: the rotation matrix only, i.e. wrapped to (-180, 180]"""
    return np.degrees((a + np.pi) % (2 * np.pi) - np.pi)


def side_geom(M, side):
    i = M.idx
    sh, ar, fa, ha = (i[side + b] for b in ('Shoulder', 'Arm', 'ForeArm', 'Hand'))
    u0 = unit(M.rest[fa] - M.rest[ar]); f0 = unit(M.rest[ha] - M.rest[fa])
    h0 = unit(np.cross(u0, f0)); s0 = unit(np.cross(f0, h0))
    rest_flex = np.degrees(np.arccos(np.clip(u0 @ f0, -1, 1)))
    H = {k: AF.unit(np.array(v)) for k, v in AF.HAND[side].items()}
    return dict(sh=sh, ar=ar, fa=fa, ha=ha, u0=u0, f0=f0, h0=h0, s0=s0, rest_flex=rest_flex, sgn=1.0 if side == 'Left' else -1.0,
                ax_flex=AF.unit(np.cross(H['h'], H['p'])), ax_dev=AF.unit(np.cross(H['h'], H['t'])),
                at=i.get(side + 'ArmTwist'), ft=i.get(side + 'ForeArmTwist'))


def measure(pose, g):
    lq = pose['lq']
    q_c, q_a, q_e, q_h = lq[:, g['sh']], lq[:, g['ar']], lq[:, g['fa']], lq[:, g['ha']]
    out = {}
    out['clav'] = np.degrees(2 * np.arccos(np.clip(np.abs(q_c[:, 3]), 0, 1)))
    out['sh_tw'] = unwrap_deg(twist_angle(q_a, g['u0']))
    w = swing_vec(q_e, g['f0'])
    out['el_flex'] = g['rest_flex'] + np.degrees(w @ g['h0'])
    out['el_side'] = np.degrees(w @ g['s0'])
    out['el_tw'] = unwrap_deg(twist_angle(q_e, g['f0']))
    out['wr_tw'] = unwrap_deg(twist_angle(q_h, g['f0']))
    # wrist as a 2-dof joint after the forearm twist: q_h = twist * swing' (swing' about the hand's own rest axes)
    T = np.radians(out['wr_tw'])
    tw = np.concatenate([np.sin(T / 2)[:, None] * g['f0'][None], np.cos(T / 2)[:, None]], 1)
    rv = AF.rotvec(qmul(qinv(tw), q_h))
    out['wr_flex'] = np.degrees(rv @ g['ax_flex'])
    out['wr_dev'] = np.degrees(rv @ g['ax_dev'])
    out['wr_bend'] = np.degrees(np.linalg.norm(rv, axis=1))
    # total forearm rotation, pronation positive (rest = the A-pose hand, palm down-in, ~35 deg pronated from thumb-up)
    out['pron'] = g['sgn'] * ((out['el_tw'] + out['wr_tw'] + 180) % 360 - 180)
    out['tw_tot'] = np.abs(out['pron'])
    # skin seams: what each blend region has to absorb
    at = lq[:, g['at']] if g['at'] is not None else None
    ft = lq[:, g['ft']] if g['ft'] is not None else None
    tat = unwrap_deg(twist_angle(at, g['u0'])) if at is not None else 0 * out['sh_tw']
    sh_seams = [np.abs((out['sh_tw'] + tat + 180) % 360 - 180), np.abs(tat)]
    if ft is not None:
        tft = unwrap_deg(twist_angle(ft, g['f0']))
        out['wr_tw'] = (out['wr_tw'] - tft + 180) % 360 - 180      # what the wrist seam itself turns (hand vs forearm twist bone)
        fseams = [np.abs(out['el_tw']), np.abs(tft), np.abs(out['wr_tw'])]
    else:
        fseams = [np.abs(out['el_tw']), np.abs(out['wr_tw'])]
    out['seam'] = np.max(np.stack(sh_seams + fseams), 0)
    return out


def flags(m):
    return dict(
        clav=m['clav'] > LIM['clav'],
        sh_tw=np.abs(m['sh_tw']) > LIM['sh_tw'],
        el_hyper=m['el_flex'] < LIM['el_lo'],
        el_over=m['el_flex'] > LIM['el_hi'],
        el_side=np.abs(m['el_side']) > LIM['el_side'],
        pron=(m['pron'] > LIM['pron'][1]) | (m['pron'] < LIM['pron'][0]),
        wr_tw=np.abs(m['wr_tw']) > LIM['wr_tw'],
        wr_flex=(m['wr_flex'] > LIM['wr_flex'][1]) | (m['wr_flex'] < LIM['wr_flex'][0]),
        wr_dev=(m['wr_dev'] > LIM['wr_dev'][1]) | (m['wr_dev'] < LIM['wr_dev'][0]),
        seam=m['seam'] > LIM['seam'],
    )


def _ex(x, lo, hi):
    return np.clip(x - hi, 0, None) + np.clip(lo - x, 0, None)


def excess(m):
    """degrees beyond the limits, summed over the categories (per frame) - one badness number"""
    return (_ex(m['clav'], -1e9, LIM['clav']) + _ex(np.abs(m['sh_tw']), -1, LIM['sh_tw'])
            + _ex(m['el_flex'], LIM['el_lo'], LIM['el_hi']) + _ex(np.abs(m['el_side']), -1, LIM['el_side'])
            + _ex(m['pron'], *LIM['pron']) + _ex(np.abs(m['wr_tw']), -1, LIM['wr_tw'])
            + _ex(m['wr_flex'], *LIM['wr_flex']) + _ex(m['wr_dev'], *LIM['wr_dev']) + _ex(m['seam'], -1, LIM['seam']))


def run(glb, clips=None, quiet=False):
    G = CA.read_glb(glb); M = CA.Model(G)
    geo = {s: side_geom(M, s) for s in ('Left', 'Right')}
    res = {}
    for c in G['anims']:
        if clips and c not in clips:
            continue
        pose = M.pose(c)
        r = {}
        for s in ('Left', 'Right'):
            m = measure(pose, geo[s])
            fl = flags(m)
            ex = excess(m)
            r[s] = dict(F=pose['F'], flagged={k: int(v.sum()) for k, v in fl.items()},
                        any=int(np.any(np.stack(list(fl.values())), 0).sum()),
                        max=dict(clav=float(m['clav'].max()), sh_tw=float(np.abs(m['sh_tw']).max()),
                                 el_min=float(m['el_flex'].min()), el_max=float(m['el_flex'].max()),
                                 el_side=float(np.abs(m['el_side']).max()), el_tw=float(np.abs(m['el_tw']).max()),
                                 wr_tw=float(np.abs(m['wr_tw']).max()), pr_min=float(m['pron'].min()), pr_max=float(m['pron'].max()),
                                 fx_min=float(m['wr_flex'].min()), fx_max=float(m['wr_flex'].max()),
                                 dv_min=float(m['wr_dev'].min()), dv_max=float(m['wr_dev'].max()), seam=float(m['seam'].max())),
                        excess_sum=float(ex.sum()), excess_max=float(ex.max()), worst_f=int(ex.argmax()))
        res[c] = r
    return res


def summary(res):
    tot = dict(frames=0, any=0, excess=0.0)
    cat = {}
    for c, r in res.items():
        for s, x in r.items():
            tot['frames'] += x['F']; tot['any'] += x['any']; tot['excess'] += x['excess_sum']
            for k, v in x['flagged'].items():
                cat[k] = cat.get(k, 0) + v
    tot['cat'] = cat
    worst = sorted(((x['excess_max'], c, s, x['worst_f']) for c, r in res.items() for s, x in r.items()), reverse=True)
    tot['worst'] = worst[:25]
    tot['clips_flagged'] = sum(1 for r in res.values() if any(x['any'] for x in r.values()))
    return tot


if __name__ == '__main__':
    a = sys.argv[1:]
    glb = a[a.index('--glb') + 1] if '--glb' in a else f'{ROOT}/assets/soldiers/soldier_anims.glb'
    js = a[a.index('--json') + 1] if '--json' in a else None
    skip = {glb, js}
    clips = [x for x in a if not x.startswith('--') and x not in skip] or None
    res = run(glb, clips)
    if '--quiet' not in a:
        print(f'{"clip":28s} side  F  any  clav shTw  elMin elMax elSide elTw wrTw  prMin prMax fxMin fxMax dvMin dvMax seam  exMax')
        for c, r in res.items():
            for s, x in r.items():
                if not x['any']:
                    continue
                mx = x['max']
                print(f'{c:28s} {s[0]} {x["F"]:4d} {x["any"]:4d} {mx["clav"]:5.0f} {mx["sh_tw"]:5.0f} {mx["el_min"]:6.0f} {mx["el_max"]:5.0f}'
                      f' {mx["el_side"]:5.0f} {mx["el_tw"]:5.0f} {mx["wr_tw"]:5.0f} {mx["pr_min"]:5.0f} {mx["pr_max"]:5.0f} {mx["fx_min"]:5.0f} {mx["fx_max"]:5.0f}'
                      f' {mx["dv_min"]:5.0f} {mx["dv_max"]:5.0f} {mx["seam"]:5.0f} {x["excess_max"]:6.0f}@{x["worst_f"]}')
    S = summary(res)
    print('TOTAL side-frames', S['frames'], 'flagged', S['any'], f'({100 * S["any"] / S["frames"]:.1f} %)', 'clips flagged', S['clips_flagged'], '/', len(res))
    print('by category (side-frames):', S['cat'])
    print('excess deg summed: %.0f' % S['excess'])
    print('worst:', [(round(e), c, s[0], f) for e, c, s, f in S['worst'][:12]])
    if js:
        json.dump(dict(res=res, summary=S), open(js, 'w'), indent=0)
