"""Stage 2: soldier GLBs (soldier_ru.glb / soldier_ua.glb) from build/soldiers/body.pkl.
Also usable as a library (build(...)) for test assemblies with animations.

run: nice -n 10 python3 tools/blender/soldiers/build_soldier.py
"""
import os, sys, pickle, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import bpy  # noqa
from mathutils.bvhtree import BVHTree
from mathutils import Vector
import gear as G, kit as K, assemble as AS, gltfw, meshutil as MU, body as BD, anim as A, bl
from qmath import qmul, qinv, qrot, qeuler

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../..'))
BUILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache')
ASSETS = f'{ROOT}/assets/soldiers'

SPINE_BONES = ('Hips', 'LowerBack', 'Spine', 'Spine1', 'Neck', 'LeftShoulder', 'RightShoulder')


def load():
    return pickle.load(open(f'{BUILD}/body.pkl', 'rb'))


def vertex_ao(parts, extra_tris, n_rays=12, dist=0.08, seed=0):
    """cheap per-vertex ambient occlusion for gear parts against everything (body + gear)"""
    allP, allT = [], []
    off = 0
    for P, T in extra_tris:
        allP.append(P); allT.append(T + off); off += len(P)
    for p in parts:
        allP.append(p['pos']); allT.append(p['tri'] + off); off += len(p['pos'])
    P = np.concatenate(allP); T = np.concatenate(allT)
    tree = BVHTree.FromPolygons([tuple(v) for v in P], [tuple(map(int, t)) for t in T], all_triangles=True)
    rng = np.random.default_rng(seed)
    dirs = rng.standard_normal((n_rays, 3)); dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
    for p in parts:
        nrm = p['nrm'] if p['nrm'] is not None else MU.vertex_normals(p['pos'], p['tri'])
        occ = np.zeros(len(p['pos']))
        for i, (v, n) in enumerate(zip(p['pos'], nrm)):
            o = v + n * 0.0015
            hits = 0; tot = 0
            for d in dirs:
                if d @ n < 0:
                    d = -d
                w = d @ n
                h = tree.ray_cast(Vector(o), Vector(d), dist)
                if h[0] is not None:
                    hits += w * (1 - h[3] / dist)
                tot += w
            occ[i] = hits / max(tot, 1e-6)
        ao = np.clip(1 - occ * 1.3, 0.35, 1)
        p['col'] = np.repeat(ao[:, None], 3, 1) * p.get('col', np.ones((len(p['pos']), 3)))
    return parts


def gear_weights(rig_sk, ref_pos, ref_W, parts, rigid_groups=()):
    """weights: transfer from nearest uniform vertices restricted to spine chain; pouches rigid per part"""
    idx = rig_sk.idx
    for p in parts:
        grp = p.get('group', '')
        if grp.startswith('armband') or grp.startswith('legband'):
            p['W'] = AS.nearest_weights(p['pos'], ref_pos, ref_W, k=6)
        elif grp == 'kneepads':
            W = np.zeros((len(p['pos']), rig_sk.n), np.float32)
            side = 'Left' if p['pos'][:, 0].mean() > 0 else 'Right'
            W[:, idx[side + 'Leg']] = 1
            p['W'] = W
        elif grp == 'helmet':
            W = np.zeros((len(p['pos']), rig_sk.n), np.float32); W[:, idx['Head']] = 1; p['W'] = W
        elif 'local' in p or grp.startswith('pouches') or grp == 'backpack' and 'local' in p:
            c = p['pos'].mean(0, keepdims=True)
            w = AS.nearest_weights(c, ref_pos, ref_W, k=8, bones_allowed=SPINE_BONES, bone_idx=idx)
            p['W'] = np.repeat(w, len(p['pos']), 0)
        else:
            p['W'] = AS.nearest_weights(p['pos'], ref_pos, ref_W, k=10, bones_allowed=SPINE_BONES, bone_idx=idx)
    return parts


def head_fit(R):
    lm = R['variants']['A']['lm']
    hp = np.concatenate([R['variants'][v]['head_pos'] for v in 'ABC'])
    ec = (lm['eyeL'] + lm['eyeR']) / 2
    return K.fit_head(hp, ec + [0, 0.02, -0.07])


def make_gear(R, fac, env, which=None):
    """returns list of parts tagged with 'group' (= node name)"""
    mm = K.RU_MATS if fac == 'ru' else K.UA_MATS
    parts = K.plate_carrier(env, fac)
    c, r = head_fit(R)
    hA, hB = ('6b47', '6b47_goggles') if fac == 'ru' else ('fast', 'mich')
    for kind, nm in ((hA, 'helmet_A'), (hB, 'helmet_B')):
        for q in K.helmet(kind, c, r, mm, fac):
            q['group'] = nm; parts.append(q)
    sk = R['skel']; J = lambda n: sk.head[sk.idx[n]]
    for sd, sx in (('Left', 1), ('Right', -1)):
        p = K.tape_band(env.trees, J(sd + 'Arm'), J(sd + 'ForeArm'), 0.12, np.array([sx, 0, 0.0]), seed=sx + 2)
        p['group'] = 'armband_' + sd[0]; parts.append(p)
        for q in K.kneepad(env.trees, J(sd + 'UpLeg'), J(sd + 'Leg'), J(sd + 'Foot'), sd[0], mm):
            q['group'] = 'kneepads'; parts.append(q)
        p = K.tape_band(env.trees, J(sd + 'UpLeg'), J(sd + 'Leg'), 0.2, np.array([sx, 0, 0.0]), width=0.05, seed=5 + sx)
        p['group'] = 'legband_' + sd[0]; parts.append(p)
    parts += K.backpack(env, mm, fac)
    if which:
        parts = [p for p in parts if p['group'] in which]
    return parts


def envelope(R):
    U = R['uniform']
    env = G.Envelope([(R['variants'][v]['uniform_pos'], U['tri']) for v in 'ABC'])
    env.smooth()
    return env


def write_body(W, R, fac, vn, mats_cache, lod=False):
    g = W.g
    T = R['tex']
    v = R['variants'][vn]
    U = R['uniform']; H = R['head']
    key = T[('uniform', fac, vn)]
    alb, nrm = T[key]
    uname = {('ru', 'camo'): 'emr_camo', ('ua', 'camo'): 'mm14_camo', ('ua', 'multicam'): 'mm14_multicam_camo'}[key]
    if uname not in mats_cache:
        mats_cache[uname] = g.material(uname, base_tex=g.image(alb, quality=86), normal_tex=g.image(nrm, 'PNG'), roughness=0.92)
    mu = mats_cache[uname]
    ha, _ = T[('head', vn)]
    ms = g.material('skin_' + vn, base_tex=g.image(ha, quality=88), roughness=0.55)
    if 'eye' not in mats_cache:
        mats_cache['eye'] = g.material('eye', base_tex=g.image(T['eye']), roughness=0.12)
    prims = [dict(pos=v['uniform_pos'], nrm=v['uniform_nrm'], uv=U['uv'], idx=U['tri'], mat=mu, W=U['W']),
             dict(pos=v['head_pos'], nrm=v['head_nrm'], uv=H['uv'], idx=H['tri'], mat=ms, W=H['W'])]
    for e, ep in zip(R['eyes'], v['eyes']):
        prims.append(dict(pos=ep, nrm=MU.vertex_normals(ep, e['tri']), uv=AS.eye_uv(ep), idx=e['tri'], mat=mats_cache['eye'], W=e['W']))
    return W.skinned('body_' + vn, prims, lod=0.28, extras={'default_visible': vn == 'A', 'variant': vn})


def build(fac, variants='ABC', groups=None, out=None, extra_anim=None, sockets=True, with_lod=False, ao=True):
    R = load()
    sk = R['skel']
    rig = A.Rig(sk, R['hands']['pos'], R['hands']['W'])
    W = AS.SoldierWriter(sk, 'soldier_' + fac)
    g = W.g
    mc = {}
    for vn in variants:
        write_body(W, R, fac, vn, mc)
    # hands + gloves
    hd = R['hands']
    mh = g.material('hands_skin', base_tex=g.image(R['tex']['hands']), roughness=0.6)
    W.skinned('hands', [dict(pos=hd['pos'], nrm=hd['nrm'], uv=hd['uv'], idx=hd['tri'], mat=mh, W=hd['W'])], lod=0.28)
    gp = hd['pos'] + hd['nrm'] * 0.0025
    gcol = '#3a3a33' if fac == 'ru' else '#5b5040'
    mg = g.material('gloves', color=list(AS.TX.hexc(gcol)) + [1], roughness=0.75)
    W.skinned('gloves', [dict(pos=gp, nrm=hd['nrm'], uv=hd['uv'], idx=hd['tri'], mat=mg, W=hd['W'])], extras={'default_visible': False, 'replaces': 'hands'}, lod=0.28)
    # boots
    B = BD.Base()
    bcol = '#151413' if fac == 'ru' else '#6e5a42'
    mb = g.material('boot_leather', color=list(AS.TX.hexc(bcol)) + [1], roughness=0.5 if fac == 'ru' else 0.75, double=True)
    msol = g.material('boot_sole', color=list(AS.TX.hexc('#141413')) + [1], roughness=0.9)
    bp = []
    for b in R['boots']:
        u = b['upper']; sp, st = b['sole']
        Wb = AS.nearest_weights(u['pos'], B.vA[:13380], B.W[:13380])
        Ws = AS.nearest_weights(sp, B.vA[:13380], B.W[:13380])
        bp += [dict(pos=u['pos'], nrm=u['nrm'], uv=u['uv'], idx=u['tri'], mat=mb, W=Wb),
               dict(pos=sp, nrm=MU.vertex_normals(sp, st), idx=st, mat=msol, W=Ws)]
    W.skinned('boots', bp, lod=0.3)
    # gear
    env = envelope(R)
    parts = make_gear(R, fac, env, groups)
    ref_pos = R['variants']['A']['uniform_pos']; ref_W = R['uniform']['W']
    parts = [G.box_uv(p, 2.0) if 'local' in p else p for p in parts]
    for p in parts:
        if p['nrm'] is None:
            p['nrm'] = MU.vertex_normals(p['pos'], p['tri'])
    if ao:
        body_tris = [(R['variants']['B']['uniform_pos'], R['uniform']['tri'])]
        vertex_ao([p for p in parts if not p['group'].startswith('helmet')], body_tris)
        for hn in ('helmet_A', 'helmet_B'):
            vertex_ao([p for p in parts if p['group'] == hn], [(R['variants']['B']['head_pos'], R['head']['tri'])])
    gear_weights(sk, ref_pos, ref_W, parts)
    mats = AS.Mats(g, fac)
    bygroup = {}
    for p in parts:
        bygroup.setdefault(p['group'], {}).setdefault(p['mat'], []).append(p)
    tri_count = {}
    for gname, bym in bygroup.items():
        prims = []
        for mname, ps in bym.items():
            m = G.merge(ps)
            Wm = np.concatenate([p['W'] for p in ps])
            prims.append(dict(pos=m['pos'], nrm=m['nrm'], uv=m['uv'], idx=m['tri'], mat=mats(mname), W=Wm, color=m['col']))
            tri_count[gname] = tri_count.get(gname, 0) + len(m['tri'])
        hidden = gname in ('helmet_B', 'backpack', 'legband_L', 'kneepads', 'pouches_back')
        W.skinned(gname, prims, extras={'default_visible': not hidden}, lod=0.28)
    if sockets:
        add_sockets(W, rig, R)
    if with_lod:
        W.emit_lods()
    return W, R, rig, tri_count


def add_sockets(W, rig, R):
    from qmath import qfrom_mat, qeuler
    import numpy as np
    sk = rig.sk
    W.socket('weapon_socket', 'RightHand', rig.sock_t, rig.sock_q)
    # left hand carrying the rifle by the handguard (grip_L in the left palm)
    import anim as A
    HL = rig.hand['Left']
    gl = A.GUN['ak74m']['grip_L'] + np.array([0, -0.018, 0])
    RL = rig.gunL @ HL['F'].T            # hand rest frame -> gun frame rotation (gun axes in hand space)^-1
    q_sock = qfrom_mat(RL.T)             # gun axes expressed in hand space
    t_sock = (HL['palm'] - HL['wrist']) - RL.T @ gl
    W.socket('weapon_socket_L', 'LeftHand', t_sock, q_sock)
    W.socket('mag_socket_L', 'LeftHand', HL['palm'] - HL['wrist'] + HL['p'] * 0.02, qfrom_mat(HL['F'] @ np.stack([[0, 0, 1.0], [0, 1.0, 0], [-1.0, 0, 0]], 1).T))
    # slung rifle on the back: diagonal, muzzle down-left, on top of the back plate (or backpack)
    s1 = sk.head[sk.idx['Spine1']]
    from qmath import qlook
    fwd = np.array([-0.45, 0.89, 0.0]); fwd /= np.linalg.norm(fwd)
    back_p = np.array([0.06, 1.13, -0.205]) - s1
    back_q = qlook(fwd, np.array([0, 0, -1.0]))  # muzzle up over the right shoulder, top of the gun facing away
    W.socket('weapon_socket_back', 'Spine1', back_p, back_q)
    lm = R['variants']['A']['lm']
    eye_mid = (lm['eyeL'] + lm['eyeR']) / 2
    W.socket('aim', 'Head', eye_mid - sk.head[sk.idx['Head']])
    W.socket('aim_eye_R', 'Head', lm['eyeR'] - sk.head[sk.idx['Head']])


if __name__ == '__main__':
    import build_anims as BA
    BA.setup()  # loads weapon reference points into anim.GUN
    info = {}
    for fac in ('ru', 'ua'):
        W, R, rig, tc = build(fac, with_lod=True)
        W.save(f'{ASSETS}/soldier_{fac}.glb')
        info[fac] = W.tris
        print(fac, W.tris)
    json.dump(info, open(f'{BUILD}/soldier_tris.json', 'w'), indent=1)
