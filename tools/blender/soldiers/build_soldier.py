"""Stage 2: soldier GLBs (soldier_ru.glb / soldier_ua.glb) from build/soldiers/body.pkl.
Also usable as a library (build(...)) for test assemblies with animations.

run: nice -n 10 python3 tools/blender/soldiers/build_soldier.py [ru] [ua]
then: WebP textures (GT=/tmp/gt/node_modules/.bin/gltf-transform; $GT webp soldier_<fac>.glb out.glb --quality 88, see tools/optimize_assets.sh)
      and the manifest entries: python3 tools/blender/soldiers/weapons_manifest.py <weapons...> --soldiers
mag_socket_L is derived from the reload clip in assets/soldiers/soldier_anims.glb (mag_out event), so build the anims first.
"""
import os, sys, pickle, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import bpy  # noqa
from mathutils.bvhtree import BVHTree
from mathutils import Vector
import gear as G, kit as K, assemble as AS, gltfw, meshutil as MU, body as BD, anim as A, bl
import boots as BT, assault as AT, combo as CB, pouches as PO
import packs as PK                               # soldiers_v9 packs (painted charts)
from qmath import qmul, qinv, qrot, qeuler

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../..'))
BUILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache')
ASSETS = f'{ROOT}/assets/soldiers'

SPINE_BONES = ('Hips', 'LowerBack', 'Spine', 'Spine1', 'Neck', 'LeftShoulder', 'RightShoulder')


def load():
    R = pickle.load(open(f'{BUILD}/body.pkl', 'rb'))
    # soldiers_v6: uniform textures re-baked by rebake_v6.py (kept outside the 460 MB body.pkl)
    if os.path.exists(f'{BUILD}/uniform_tex_v6.pkl'):
        R['tex'].update(pickle.load(open(f'{BUILD}/uniform_tex_v6.pkl', 'rb')))
    return R


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
        if 'W' in p and p['W'] is not None:
            continue
        if grp.startswith('armband') or grp.startswith('legband'):
            p['W'] = AS.nearest_weights(p['pos'], ref_pos, ref_W, k=6)
        elif grp == 'kneepads':
            W = np.zeros((len(p['pos']), rig_sk.n), np.float32)
            side = 'Left' if p['pos'][:, 0].mean() > 0 else 'Right'
            W[:, idx[side + 'Leg']] = 1
            p['W'] = W
        elif grp.startswith('helmet') or grp == 'headset':
            W = np.zeros((len(p['pos']), rig_sk.n), np.float32); W[:, idx['Head']] = 1; p['W'] = W
        elif grp == 'armor_arms':
            sd = p.get('side') or ('Left' if p['pos'][:, 0].mean() > 0 else 'Right')
            p['W'] = deltoid_weights(rig_sk, p['pos'], sd)
        elif grp == 'elbowpads':
            W = np.zeros((len(p['pos']), rig_sk.n), np.float32)
            sd = p.get('side') or ('Left' if p['pos'][:, 0].mean() > 0 else 'Right')
            W[:, idx[sd + 'ForeArm']] = 1
            p['W'] = W
        elif grp == 'armor_groin':
            p['W'] = groin_weights(rig_sk, p['pos'], p.get('yr'))
        elif grp == 'vest' or grp.startswith('crew_vest'):
            p['W'] = vest_weights(rig_sk, p['pos'], ref_pos, ref_W)
        elif grp.startswith('backpack') or grp == 'pouches_back':
            # the pack body rides on the chest only (not the clavicles, or it swings when an arm is raised);
            # shoulder straps in front keep following the clavicles
            Wa = AS.nearest_weights(p['pos'], ref_pos, ref_W, k=10, bones_allowed=SPINE_BONES, bone_idx=idx)
            Ws = AS.nearest_weights(p['pos'], ref_pos, ref_W, k=10, bones_allowed=('Spine', 'Spine1'), bone_idx=idx)
            z = p['pos'][:, 2]
            b = np.clip((-0.07 - z) / 0.06, 0, 1)[:, None]
            b = b * b * (3 - 2 * b)
            p['W'] = Wa * (1 - b) + Ws * b
        elif 'local' in p or grp.startswith('pouches') or grp == 'backpack' and 'local' in p:
            c = p['pos'].mean(0, keepdims=True)
            w = AS.nearest_weights(c, ref_pos, ref_W, k=8, bones_allowed=SPINE_BONES, bone_idx=idx)
            p['W'] = np.repeat(w, len(p['pos']), 0)
        else:
            p['W'] = AS.nearest_weights(p['pos'], ref_pos, ref_W, k=10, bones_allowed=SPINE_BONES, bone_idx=idx)
    # packs / back pouches: rigid, with the plate carrier's own weights where they rest on it (no shear when the trunk bends)
    from scipy.spatial import cKDTree
    vest = [p for p in parts if p.get('group') == 'vest']
    if vest:
        VP = np.concatenate([p['pos'] for p in vest]); VW = np.concatenate([p['W'] for p in vest])
        tree = cKDTree(VP)
        for grp in ('backpack', 'backpack_assault', 'pouches_back'):
            gp_ = [p for p in parts if p.get('group') == grp]
            body = [p for p in gp_ if p['pos'][:, 2].mean() < -0.1]
            if not body:
                continue
            allp = np.concatenate([p['pos'] for p in body])
            c = allp.mean(0)
            # contact point: the vest vertices closest to the pack's front face
            front = allp[allp[:, 2] > np.percentile(allp[:, 2], 85)]
            _, nn = tree.query(front, k=6)
            w = VW[nn.reshape(-1)].mean(0)
            w = w / max(w.sum(), 1e-9)
            for p in body:
                p['W'] = np.repeat(w[None], len(p['pos']), 0)
    return parts


TRUNK_BONES = ('Hips', 'LowerBack', 'Spine', 'Spine1')


def _sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def vest_weights(sk, pos, ref_pos, ref_W):
    """plate carrier / soft vest: rides on the trunk chain only (no clavicle / arm / neck influence -> the panels cannot
    flare out when the arms are raised); only the shoulder straps and the top corners on the trapezius follow the clavicle
    at most half-way so the shoulder does not push through them"""
    idx = sk.idx
    Wt = AS.nearest_weights(pos, ref_pos, ref_W, k=10, bones_allowed=TRUNK_BONES, bone_idx=idx)
    Ws = AS.nearest_weights(pos, ref_pos, ref_W, k=10, bones_allowed=TRUNK_BONES + ('LeftShoulder', 'RightShoulder'), bone_idx=idx)
    f = 0.5 * _sstep(1.385, 1.445, pos[:, 1]) * _sstep(0.035, 0.075, np.abs(pos[:, 0]))
    return (Wt * (1 - f[:, None]) + Ws * f[:, None]).astype(np.float32)


def groin_weights(sk, pos, yr=None):
    """groin protector: the top (hung from the vest / belt) is rigid with the pelvis; the lower flap blends to the average of
    both thighs (85 % at the bottom edge): it is lifted / pushed forward when the legs swing up instead of being pierced by them"""
    idx = sk.idx
    W = np.zeros((len(pos), sk.n), np.float32)
    y0, y1 = yr if yr is not None else (pos[:, 1].max(), pos[:, 1].min())
    t = _sstep(0.12, 1.0, (y0 - pos[:, 1]) / max(y0 - y1, 1e-6)) * 0.85
    W[:, idx['Hips']] = 1 - t
    W[:, idx['LeftUpLeg']] = t / 2
    W[:, idx['RightUpLeg']] = t / 2
    return W


def deltoid_weights(sk, pos, side):
    """shoulder protector (deltoid pad): rigid with the upper arm, the top edge (sewn to the vest's shoulder strap) shares
    the clavicle so it does not lift off the strap / dig into the neck when the arm is raised"""
    idx = sk.idx
    a, j = sk.head[idx[side + 'Shoulder']], sk.head[idx[side + 'Arm']]
    b = sk.head[idx[side + 'ForeArm']]
    ax = (b - j) / np.linalg.norm(b - j)
    s = (pos - j) @ ax                        # distance down the upper arm from the shoulder joint
    f = 0.45 * (1 - _sstep(-0.02, 0.05, s))
    W = np.zeros((len(pos), sk.n), np.float32)
    W[:, idx[side + 'Arm']] = 1 - f
    W[:, idx[side + 'Shoulder']] = f
    return W


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
    # head meshes of all body variants: chin straps are projected onto these (env.trees only holds the uniform)
    htrees = [BVHTree.FromPolygons([tuple(p_) for p_ in R['variants'][v]['head_pos']], [tuple(map(int, t)) for t in R['head']['tri']], all_triangles=True)
              for v in 'ABC']
    for nm, kind in STD_HELMETS[fac].items():
        for q in K.helmet(kind, c, r, mm, fac, trees=htrees):
            q['group'] = nm; parts.append(q)
    sk = R['skel']; J = lambda n: sk.head[sk.idx[n]]
    for sd, sx in (('Left', 1), ('Right', -1)):
        p = K.tape_band(env.trees, J(sd + 'Arm'), J(sd + 'ForeArm'), 0.12, np.array([sx, 0, 0.0]), seed=sx + 2)
        p['group'] = 'armband_' + sd[0]; parts.append(p)
        for q in K.kneepad(env.trees, J(sd + 'UpLeg'), J(sd + 'Leg'), J(sd + 'Foot'), sd[0], mm):
            q['group'] = 'kneepads'; parts.append(q)
        p = K.tape_band(env.trees, J(sd + 'UpLeg'), J(sd + 'Leg'), 0.2, np.array([sx, 0, 0.0]), width=0.05, seed=5 + sx)
        p['group'] = 'legband_' + sd[0]; parts.append(p)
    parts += PK.ruck(env, mm, fac)              # soldiers_v9 (packs.py; was kit.backpack)
    parts += PK.vest_tube(env, fac)             # soldiers_v9: hydration tube of the back carrier (pouches_back) over the left strap
    # ---- assault trooper kit
    parts += AT.armour(env, R, fac)
    parts += AT.assault_pouches(env, fac)
    parts += AT.elbowpads(env, R, fac)
    parts += PK.assault(env, fac)               # soldiers_v9 (packs.py; was assault.assault_backpack)
    hA2, hB2 = ('6b47', 'altyn') if fac == 'ru' else ('fast_hc', 'mich')
    amm = dict(mm, fabric='altyn_steel', webbing='altyn_steel') if fac == 'ru' else mm
    for kind, nm, ms in ((hA2, 'helmet_assault_A', mm), (hB2, 'helmet_assault_B', amm if fac == 'ru' else mm)):
        for q in K.helmet(kind, c, r, ms, fac, trees=htrees):
            q['group'] = nm; parts.append(q)
    parts += AT.headset(c, r, fac)
    for vn in 'ABC':
        parts.append(AT.balaclava(R, vn, fac))
    if which:
        parts = [p for p in parts if p['group'] in which]
    return parts


# standard-infantry helmets per faction (node -> kit.HELMETS kind), from 2022-24 photos:
#  RU: 6B47 in EMR cover (+ black rubber band, NVG mount) / same with 6B34-style goggles / older 6B7-1M in EMR cover with a white ID-tape
#      band / SSh-68 steel helmet (mobilised)
#  UA: PASGT-type kaska in MM-14 cover / FAST-type high cut, bare ranger green / TOR-D type in MultiCam cover + Desert Locust style goggles /
#      FAST-type in MultiCam cover with an ID-tape strip
STD_HELMETS = {'ru': {'helmet_A': '6b47', 'helmet_B': '6b47_goggles', 'helmet_C': '6b7', 'helmet_D': 'ssh68'},
               'ua': {'helmet_A': 'pasgt', 'helmet_B': 'fast_hc', 'helmet_C': 'pasgt_mc', 'helmet_D': 'fast_mc'}}
STD_HELMET_DESC = {
    'ru': {'A': '6B47 Ratnik, EMR cover, black rubber band, NVG mount', 'B': '6B47 Ratnik, EMR cover, band, 6B34-style goggles pushed up',
           'C': '6B7-1M, EMR cover, white identification-tape band', 'D': 'SSh-68 steel helmet, olive paint (mobilised)'},
    'ua': {'A': 'PASGT-type kaska, MM-14 cover, coyote band', 'B': 'FAST-type high cut, bare ranger green, ARC rails, NVG shroud',
           'C': 'TOR-D type kaska, MultiCam cover, coyote band, Desert Locust style goggles', 'D': 'FAST-type high cut in MultiCam cover, ID-tape strip on the back'}}
STD_HELMET_OF_PRESET = {'ru': ['A', 'B', 'C', 'A', 'B', 'D'], 'ua': ['A', 'B', 'C', 'A', 'D', 'C']}


def thicken_uniform(R, log=print):
    """v6 (2026-11): baggier, layered field uniform (photos of UA / RU infantry 2023-24, previews/soldiers_v6/REFERENCES.md): every
    variant's uniform is pushed out along its normals by a per-vertex offset field instead of the old uniform 3 mm shell:
      - trunk 8-9 mm (base layer + fleece under the jacket), the jacket bags out above the belt / hem, collar stands up (layered
        fleece collar), a rolled hood bulges at the back of the neck;
      - sleeves 12-17 mm, fuller at mid upper arm, bunched rings over the last 12 cm before the cuffs (sleeves pushed up / gathered
        at the gloves);
      - trousers 14-21 mm, full in the thigh and seat, cloth bunched above and below the knee pads (straps pinch the leg), blousing
        puckered over the boot tops; long drape folds down the legs, stacked creases behind the knees;
      - thigh cargo pockets / sleeve pockets bulge (filled);
      - reduced where cloth meets cloth (inner thighs at the crotch, armpits) so the shells do not cross; faded to 0 at the boot
        tops (bloused trousers inside the shafts); low-frequency noise so it never reads as an inflated even shell.
    Placement in limb coordinates of the bind pose of variant A (as the texture details in uniform_tex).  Topology / UVs / weights
    unchanged (positions + normals only), so every clip / the ragdoll / LODs keep working."""
    import uniform_tex as UT
    import tex as TX
    if R.get('_thick'):
        return
    U = R['uniform']; sk = R['skel']; J = lambda n: sk.head[sk.idx[n]]
    T = U['tri']; lab = np.array(U['labels'])
    nv = len(R['variants']['A']['uniform_pos'])
    PA = R['variants']['A']['uniform_pos']
    def vmask(prefixes):
        m = np.zeros(nv)
        c = np.zeros(nv)
        tm = np.zeros(len(T), bool)
        for pf in prefixes:
            tm |= np.char.startswith(lab, pf)
        np.add.at(m, T[tm].ravel(), 1.0); np.add.at(c, T.ravel(), 1.0)
        return m / np.maximum(c, 1)
    crease = UT.crease
    g = lambda x, s: np.exp(-(x / s) ** 2)
    tor = vmask(['torso']); col = vmask(['collar']); cuf = vmask(['cuff'])
    nz = TX.noise3(PA, 0.11, 61, 2)                   # low-frequency irregularity (+-1)
    d = np.zeros(nv)
    # ---- trunk
    hipy = J('Hips')[1]; hem = hipy - 0.065; neck = J('Neck')
    dt_ = 0.0085 + 0.0065 * g(PA[:, 1] - (hem + 0.075), 0.05)          # jacket bagging above the belt
    dt_ += 0.0030 * g(PA[:, 1] - 1.22, 0.10)                            # chest / back (layers)
    # armpits: the trunk under the arms stays close (sleeves fill the space)
    for side, sx in (('Left', 1), ('Right', -1)):
        ap = J(side + 'Arm') + np.array([-sx * 0.04, -0.08, 0.0])
        dt_ *= 1 - 0.55 * g(np.linalg.norm(PA - ap, axis=1), 0.07)
    # rolled hood / fleece collar at the back of the neck
    hood = g(np.linalg.norm((PA - (neck + np.array([0, -0.035, -0.075]))) * [0.75, 1.3, 1.0], axis=1), 0.065)
    d += tor * (dt_ + 0.012 * hood) + col * (0.0125 + 0.006 * hood)
    # ---- sleeves
    for side, sx in (('Left', 1), ('Right', -1)):
        sh, el, wr = J(side + 'Arm'), J(side + 'ForeArm'), J(side + 'Hand')
        m = vmask(['sleeve_' + side[0]])
        ref = np.array([sx, 0.0, 0])
        s1, th1, _ = UT.limb_coords(PA, sh, el, ref)
        s2, th2, _ = UT.limb_coords(PA, el, wr, ref)
        Lu, Lf = np.linalg.norm(el - sh), np.linalg.norm(wr - el)
        on_up = s1 < Lu
        s = np.where(on_up, s1, Lu + s2); th = np.where(on_up, th1, th2)
        ds = 0.0125 + 0.0045 * g(s - 0.5 * Lu, 0.09) * (0.6 + 0.4 * np.cos(th))       # fuller at mid upper arm, outer side
        ds *= 1 - 0.45 * g(s1, 0.07) * (np.cos(th) < 0)                                   # inner side at the armpit
        de = s - (Lu + Lf)                                                                # 0 at the wrist
        bunch = np.exp(-((de + 0.065) / 0.05) ** 2)                                     # gathered over the last ~12 cm
        ds += bunch * (0.0045 + 0.0030 * crease(s / 0.042 + 0.35 * np.sin(th * 2 + sx), 0.8))
        ds += 0.0016 * crease(th * 4 / (2 * np.pi) + s * 1.3 + 0.4 * nz, 0.9) * (1 - bunch)   # sleeve drape
        # elbow: creases on the inside, cloth bags at the back
        dk = s - Lu
        ds += 0.0020 * crease(dk / 0.03 + 0.4 * np.sin(th * 1.5)) * g(dk, 0.06)
        # sleeve pocket on the upper arm (filled)
        sd2 = UT.rect_sdf(th1 * 0.055, s1, 0, 0.14, 0.065, 0.075, 0.012)
        ds += 0.0060 * np.clip(-sd2 / 0.02, 0, 1) ** 0.7 * on_up
        d += m * ds + vmask(['cuff_' + side[0]]) * 0.0105
    # ---- trousers
    for side, sx in (('Left', 1), ('Right', -1)):
        hp, kn, an = J(side + 'UpLeg'), J(side + 'Leg'), J(side + 'Foot')
        m = vmask(['leg_' + side[0]])
        ref = np.array([sx, 0.0, 0])
        s1, th1, _ = UT.limb_coords(PA, hp, kn, ref)
        s2, th2, _ = UT.limb_coords(PA, kn, an, ref)
        Lu = np.linalg.norm(kn - hp)
        on_up = s1 < Lu
        s = np.where(on_up, s1, Lu + s2); th = np.where(on_up, th1, th2)
        fw = np.pi / 2 * sx
        front = 0.5 + 0.5 * np.cos(th - fw)
        dk = s - Lu                                                                       # 0 at the knee joint, + down
        dl = 0.0140 + 0.0065 * g(s - 0.20, 0.13) * (0.55 + 0.45 * np.cos(th))             # full thigh (outer side more)
        dl += 0.0045 * g(s - 0.08, 0.10) * (1 - front)                                     # seat
        dl *= 1 - 0.55 * g(s1, 0.12) * np.clip(-np.cos(th) * 1.5, 0, 1) * on_up            # inner thigh at the crotch
        # bunching above / below the knee pad (strap lines), stacked creases behind the knee
        for c0, w0, a0 in ((-0.065, 0.035, 0.0055), (0.115, 0.035, 0.0050)):
            dl += a0 * g(dk - c0, w0) * (0.75 + 0.25 * crease(th * 3 / (2 * np.pi) + 0.3 * nz, 0.8))
        dl += 0.0022 * crease(dk / 0.028 + 0.3 * np.sin(th * 2)) * g(dk, 0.07) * (1 - front) ** 1.2
        # long drape folds (twisting a little), not over the knee
        dl += 0.0022 * crease(th * 4 / (2 * np.pi) + 0.5 * nz + s * 0.6, 0.9) * (1 - g(dk, 0.07))
        # blousing over the boot tops: puckered bulge, nothing inside the shaft
        y = PA[:, 1]
        dl += (0.0140 + 0.0050 * np.sin(th * 7 + 2 * nz)) * g(y - 0.295, 0.045) * (y > 0.25)
        # cargo pocket on the outer thigh (filled) + flap
        thp = th - 0.35 * sx
        sd = UT.rect_sdf(thp * 0.085, s, 0, 0.30, 0.085, 0.10, 0.015)
        dl += on_up * 0.0095 * np.clip(-sd / 0.03, 0, 1) ** 0.7
        fsd = UT.rect_sdf(thp * 0.085, s, 0, 0.215, 0.088, 0.028, 0.01)
        dl += on_up * 0.0030 * np.clip(-fsd / 0.012, 0, 1)
        d += m * dl
    d *= 1 + 0.18 * nz                                                                     # irregular, not an even shell
    d *= np.clip((PA[:, 1] - 0.238) / 0.022, 0, 1)                                         # boot tops: no offset inside the shafts
    # smooth the field over the mesh (1-ring averaging), keeps the folds but removes single-vertex spikes
    E = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]); E = np.concatenate([E, E[:, ::-1]])
    deg = np.bincount(E[:, 0], minlength=nv)
    for _ in range(2):
        d = 0.5 * d + 0.5 * np.bincount(E[:, 0], d[E[:, 1]], minlength=nv) / np.maximum(deg, 1)
    d *= np.clip((PA[:, 1] - 0.238) / 0.022, 0, 1)
    # UV-seam duplicates (same position, different panel label) must move identically or the seams crack
    _, inv = np.unique(np.round(PA, 5), axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    d = (np.bincount(inv, d) / np.bincount(inv))[inv]
    for vn in 'ABC':
        v = R['variants'][vn]
        v['uniform_pos'] = v['uniform_pos'] + v['uniform_nrm'] * d[:, None]
        v['uniform_nrm'] = MU.weld_normals(v['uniform_pos'], MU.vertex_normals(v['uniform_pos'], T), 1e-5)
    R['_thick'] = True
    R['_thick_d'] = d
    log(f'uniform thickened (v6 baggy): offset {d.min() * 1000:.1f}..{d.max() * 1000:.1f} mm (median {np.median(d) * 1000:.1f})')


# ---------------------------------------------------------------- rifle sling (rifle slung on the back)
# AK-74M sling swivels in gun space (weapons.py: front swivel loop under the left of the gas block, rear swivel loop on the left of the
# stock hinge block); gun space: origin = pistol grip, +Z muzzle, +Y up, +X = weapon's left side
SWIVEL_F = np.array([0.0175, 0.080, 0.422])
SWIVEL_R = np.array([0.0233, 0.0535, -0.086])
# slung rifle frame (bind pose): diagonal across the back, muzzle up behind the right shoulder, butt down at the left hip, lying on its
# LEFT side against the back (swivels / sling side toward the body, magazine pointing out to the right), like an AK on a 2-point sling
# worn across the chest (over the right shoulder, diagonally down to the left hip)
SLING_ZG = np.array([-0.45, 0.89, 0.0]) / np.linalg.norm([-0.45, 0.89, 0.0])
SLING_XG = np.array([0.0, 0.0, 1.0])
SLING_YG = np.cross(SLING_ZG, SLING_XG)
SLING_CENTRE = np.array([0.0, 1.15])           # world (x, y) of the gun's balance point (gun z = 0.12)
SLING_CLASSES = (('bare', 'sling_back', 'weapon_socket_sling', ()),
                 ('pouch', 'sling_back_pouch', 'weapon_socket_sling_pouch', ('pouches_back',)),
                 ('pack', 'sling_back_pack', 'weapon_socket_sling_pack', ('backpack_assault',)),
                 ('ruck', 'sling_back_ruck', 'weapon_socket_sling_ruck', ('backpack',)))


def _bvh(meshes):
    P, T = [], []
    off = 0
    for p_, t_ in meshes:
        P.append(p_); T.append(np.asarray(t_) + off); off += len(p_)
    P = np.concatenate(P); T = np.concatenate(T)
    return BVHTree.FromPolygons([tuple(v) for v in P], [tuple(map(int, t)) for t in T], all_triangles=True)


def make_slings(R, fac, env, parts, rig, log=print):
    """one sling mesh + rifle socket per back-gear depth class (bare plate carrier / hydration + dump pouch / assault pack / rucksack):
    the rifle lies on its side on the outermost back surface of that class, the 32 mm webbing sling runs from the front swivel (behind
    the right shoulder) over the right shoulder, diagonally across the chest (riding over the pouches) to the left flank under the arm,
    round the back to the rear swivel at the left hip.  Projected onto the union of all body variants + vest + front pouches + the
    class's back gear, kept 4 mm off it, radially bridged so it lies taut over pouches.  Weights: plate-carrier weights along the body,
    blending to rigid Spine1 over the last ~20 cm at each swivel (the slung rifle is rigid with Spine1)."""
    from qmath import qfrom_mat
    sk = R['skel']; idx = sk.idx
    s1 = sk.head[idx['Spine1']]
    by = lambda n: [p for p in parts if p['group'] == n]
    vest = by('vest')
    if not vest:            # partial builds (groups=...) without the plate carrier: no slings
        return []
    VP = np.concatenate([p['pos'] for p in vest]); VW = np.concatenate([p['W'] for p in vest])
    U = R['uniform']
    wa = U['W'][:, [idx[b] for b in ARM_BONES]].sum(1)
    trunk = U['tri'][(wa[U['tri']] < 0.35).all(1)]          # no sleeves: in the bind pose the arms hang out to the sides
    body = [(R['variants'][v]['uniform_pos'], trunk) for v in 'ABC']
    base_meshes = body + [(p['pos'], p['tri']) for p in vest + by('pouches_front')]
    Rg = np.stack([SLING_XG, SLING_YG, SLING_ZG], 1)
    mat = 'sling_ru' if fac == 'ru' else 'sling_ua'
    # footprint of the rifle's left side (receiver .. handguard, incl. the side-mount optic) in gun space
    fy, fz = np.meshgrid(np.linspace(-0.03, 0.11, 5), np.linspace(-0.25, 0.45, 15))
    foot = np.stack([np.full(fy.size, 0.035), fy.ravel(), fz.ravel()], 1)
    out = []
    for cls, node, sock, extra in SLING_CLASSES:
        meshes = base_meshes + [(p['pos'], p['tri']) for g in extra for p in by(g)]
        tree = _bvh(meshes)
        # ---- rifle placement: on the outermost back surface under its footprint
        P0 = np.zeros(3); P0[:2] = SLING_CENTRE - SLING_ZG[:2] * 0.12
        fw = P0 + foot @ Rg.T
        zs = []
        for q in fw:
            h = tree.ray_cast(Vector((q[0], q[1], -1.0)), Vector((0, 0, 1.0)), 1.5)
            if h[0] is not None:
                zs.append(h[0][2])
        zs = np.array(zs)
        P0[2] = np.percentile(zs, 3) - 0.004 - 0.035
        q_sock = qfrom_mat(Rg)
        Fw = P0 + Rg @ SWIVEL_F; Rw = P0 + Rg @ SWIVEL_R
        # ---- guide path (outward-projected samples)
        def proj(o, d, extra_off=0.0055):
            d = d / np.linalg.norm(d)
            h = tree.ray_cast(Vector(o + d * 0.6), Vector(-d), 0.6)
            r = 0.6 - h[3] if h[0] is not None else 0.15
            return r, d
        samples = []        # (origin, dir, r)
        yc = 1.36; zc = float(env.zcen(yc))
        for ph in np.radians(np.linspace(150, 22, 16)):          # over the right shoulder, back -> front (trapezius beside the neck)
            u = (np.radians(150) - ph) / np.radians(128)
            x = -0.078 - 0.03 * u
            o = np.array([x, yc, zc]); r, d = proj(o, np.array([0, np.sin(ph), np.cos(ph)]))
            samples.append((o, d, r))
        n2 = 22
        for u in np.linspace(0, 1, n2)[1:]:                       # across the chest to the left flank under the arm
            th = -0.72 + (1.50 + 0.72) * u; y = 1.40 - 0.17 * u
            o = np.array([0, y, float(env.zcen(y))]); r, d = proj(o, np.array([np.sin(th), 0, np.cos(th)]))
            samples.append((o, d, r))
        thR = np.arctan2(Rw[0], Rw[2] - float(env.zcen(Rw[1])))
        for u in np.linspace(0, 1, 14)[1:-2]:                     # round the left side, down the back toward the rear swivel
            th = 1.50 + (thR - 1.50) * u; y = 1.23 + (Rw[1] + 0.02 - 1.23) * u
            o = np.array([0, y, float(env.zcen(y))]); r, d = proj(o, np.array([np.sin(th), 0, np.cos(th)]))
            samples.append((o, d, r))
        r = np.array([s_[2] for s_ in samples])
        k = 3
        rp = np.pad(r, k, mode='edge')
        r = np.array([rp[i:i + 2 * k + 1].max() for i in range(len(r))])      # taut over pouches / dips
        rp = np.pad(r, 2, mode='edge'); r = np.convolve(rp, np.ones(5) / 5, mode='valid')
        C = np.array([o + d * (rr + 0.0055) for (o, d, _), rr in zip(samples, r)])
        Nn = np.array([d for (_, d, _) in samples])
        for _ in range(2):
            C[1:-1] = 0.5 * C[1:-1] + 0.25 * (C[:-2] + C[2:])
        # straight runs from the swivels (strap face parallel to the gun's side at the swivel)
        nback = np.array([0, 0, -1.0])
        def run(a, b, na, nb, m):
            t_ = np.linspace(0, 1, m)[:, None]
            nn = na * (1 - t_) + nb * t_
            return a * (1 - t_) + b * t_, nn / np.linalg.norm(nn, axis=1, keepdims=True)
        A1, NA1 = run(Fw + nback * 0.006, C[0], nback, Nn[0], 7)
        A2, NA2 = run(C[-1], Rw + nback * 0.006, Nn[-1], nback, 7)
        Cl = np.concatenate([A1[:-1], C, A2[1:]]); Nl = np.concatenate([NA1[:-1], Nn, NA2[1:]])
        # ---- strap ribbon (closed 4-sided section, 32 x 2.8 mm)
        Tn = np.gradient(Cl, axis=0); Tn /= np.linalg.norm(Tn, axis=1, keepdims=True)
        Sd = np.cross(Tn, Nl); Sd /= np.linalg.norm(Sd, axis=1, keepdims=True)
        Nl = np.cross(Sd, Tn)
        w, th_ = 0.032, 0.0028
        corners = [(-w / 2, -th_ / 2), (w / 2, -th_ / 2), (w / 2, th_ / 2), (-w / 2, th_ / 2)]
        rings = [Cl + Sd * a + Nl * b for a, b in corners]
        nc = len(Cl)
        pos = np.stack(rings, 1).reshape(-1, 3)                  # vertex = i * 4 + corner
        tri = []
        for i in range(nc - 1):
            for c_ in range(4):
                a0 = i * 4 + c_; a1 = i * 4 + (c_ + 1) % 4; b0 = a0 + 4; b1 = a1 + 4
                tri += [[a0, a1, b1], [a0, b1, b0]]
        tri += [[0, 2, 1], [0, 3, 2], [(nc - 1) * 4, (nc - 1) * 4 + 1, (nc - 1) * 4 + 2], [(nc - 1) * 4, (nc - 1) * 4 + 2, (nc - 1) * 4 + 3]]
        strap = G.part(pos, np.array(tri), mat, np.zeros((len(pos), 2)))
        strap = G.orient_closed(strap)
        # arc length from the nearest swivel -> rigid Spine1 blend
        seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(Cl, axis=0), axis=1))]
        s_end = np.minimum(seg, seg[-1] - seg)
        f_c = 1 - _sstep(0.05, 0.22, s_end)
        hw = []
        # slider buckle on the chest + sewn loops at both swivels
        ib = len(A1) - 1 + int(len(C) * 0.30)
        hw.append((PO.local_part(PO.rbox(w + 0.007, 0.016, 0.0065, 0.0015, 1), PO.mat4(Cl[ib] + Nl[ib] * 0.0015, Sd[ib], Tn[ib], Nl[ib]), 'sling_metal', 'hard'), ib))
        for ie in (1, nc - 2):
            hw.append((PO.local_part(PO.rbox(w * 0.96, 0.034, 0.0060, 0.0015, 1), PO.mat4(Cl[ie] + Nl[ie] * 0.0012, Sd[ie], Tn[ie], Nl[ie]), mat, 'hard'), ie))
        sparts = [strap] + [h_ for h_, _ in hw]
        cen_of = [np.repeat(np.arange(nc), 4)] + [np.full(len(h_['pos']), i_) for h_, i_ in hw]
        Ws = []
        for p, ci in zip(sparts, cen_of):
            if p.get('nrm') is None:
                p['nrm'] = MU.vertex_normals(p['pos'], p['tri'])
            Wv = AS.nearest_weights(p['pos'], VP, VW, k=8)
            Wr = np.zeros_like(Wv); Wr[:, idx['Spine1']] = 1
            f = f_c[ci][:, None]
            p['W'] = (Wr * f + Wv * (1 - f)).astype(np.float32)
            p.pop('local', None)
        vertex_ao(sparts, meshes, n_rays=10, dist=0.05)
        log(f'{node}: rifle origin {np.round(P0, 3)} (back surface z {np.percentile(zs, 3):.3f}), swivels F {np.round(Fw, 3)} R {np.round(Rw, 3)}, '
            f'strap {seg[-1]:.2f} m, {sum(len(p_["tri"]) for p_ in sparts)} tris')
        out.append(dict(cls=cls, node=node, socket=sock, t=P0 - s1, q=q_sock, parts=sparts, P0=P0))
    return out


ARM_BONES = ('LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand')


def envelope(R):
    """torso envelope of the three body variants.  The radius table ignores the arms (triangles mostly weighted to the
    arm bones), so vest panels at armpit / shoulder height hug the chest and shoulder blades (no flare onto the deltoids)"""
    U = R['uniform']
    sk = R['skel']
    wa = U['W'][:, [sk.idx[b] for b in ARM_BONES]].sum(1)
    trunk = U['tri'][(wa[U['tri']] < 0.35).all(1)]
    env = G.Envelope([(R['variants'][v]['uniform_pos'], U['tri']) for v in 'ABC'],
                     r_meshes=[(R['variants'][v]['uniform_pos'], trunk) for v in 'ABC'])
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
        # colour factor 1 for every textured material (gltfw's default factor is 0.5 sRGB = 0.21 linear, which darkened the camo
        # and skin to ~1/5 brightness in game: EMR rendered as a dark woodland olive, MM-14 / multicam even darker, faces and
        # hands dark brown).  The crew coveralls already used 1.
        mats_cache[uname] = g.material(uname, color=(1, 1, 1, 1), base_tex=g.image(alb, quality=86), normal_tex=g.image(nrm, 'PNG'), roughness=0.92)
    mu = mats_cache[uname]
    ha, _ = T[('head', vn)]
    ms = g.material('skin_' + vn, color=(1, 1, 1, 1), base_tex=g.image(ha, quality=88), roughness=0.55)
    if 'eye' not in mats_cache:
        mats_cache['eye'] = g.material('eye', color=(1, 1, 1, 1), base_tex=g.image(T['eye']), roughness=0.12)
    prims = [dict(pos=v['uniform_pos'], nrm=v['uniform_nrm'], uv=U['uv'], idx=U['tri'], mat=mu, W=U['W']),
             dict(pos=v['head_pos'], nrm=v['head_nrm'], uv=H['uv'], idx=H['tri'], mat=ms, W=H['W'])]
    if 'col' in U:          # soldiers_v8 (wrist.py): sleeve hems, inside of the sleeve shadowed
        prims[0]['color'] = np.repeat(U['col'][:, None], 3, 1)
    for e, ep in zip(R['eyes'], v['eyes']):
        prims.append(dict(pos=ep, nrm=MU.vertex_normals(ep, e['tri']), uv=AS.eye_uv(ep), idx=e['tri'], mat=mats_cache['eye'], W=e['W']))
    return W.skinned('body_' + vn, prims, lod=0.28, extras={'default_visible': vn == 'A', 'variant': vn})


def build(fac, variants='ABC', groups=None, out=None, extra_anim=None, sockets=True, with_lod=False, ao=True, combos_on=True, crew_on=True,
          thick=True, sling=True, wrist=True):
    R = load()
    if thick:
        thicken_uniform(R)
    sk = R['skel']
    rig = A.Rig(sk, R['hands']['pos'], R['hands']['W'])
    # soldiers_v8: cinched sleeve ends + hems, forearm continued inside the sleeve, glove cuffs (rig built from the original hands)
    import wrist as WR
    wst = WR.apply(R, rig) if wrist else None
    W = AS.SoldierWriter(sk, 'soldier_' + fac)
    g = W.g
    rec = CB.Recorder(W)
    mc = {}
    for vn in variants:
        write_body(W, R, fac, vn, mc)
    # hands + gloves
    hd = R['hands']
    mh = g.material('hands_skin', color=(1, 1, 1, 1), base_tex=g.image(R['tex']['hands']), roughness=0.6)
    W.skinned('hands', [dict(pos=hd['pos'], nrm=hd['nrm'], uv=hd['uv'], idx=hd['tri'], mat=mh, W=hd['W'], color=hd.get('col'))], lod=0.28)
    gcol = '#3a3a33' if fac == 'ru' else '#5b5040'
    mg = g.material('gloves', color=list(AS.TX.hexc(gcol)) + [1], roughness=0.75)
    if wst is not None:     # glove with a cuff (UA: neoprene + velcro tab, RU: knit), base-layer cuff under the sleeve
        gp, gn, gc = WR.glove_mesh(R, wst, rig, fac)
    else:
        gp, gn, gc = hd['pos'] + hd['nrm'] * 0.0025, hd['nrm'], None
    W.skinned('gloves', [dict(pos=gp, nrm=gn, uv=hd['uv'], idx=hd['tri'], mat=mg, W=hd['W'], color=gc)], extras={'default_visible': False, 'replaces': 'hands'}, lod=0.28)
    # boots (parametric combat boots: laced upper, eyelets/speed hooks, lugged outsole)
    B = BD.Base()
    bcol, brough = ('#151413', 0.62) if fac == 'ru' else ('#6e5a42', 0.85)
    lcol = '#3a3833' if fac == 'ru' else '#4b3d2c'
    mb = g.material('boot_leather', color=list(AS.TX.hexc(bcol)) + [1], roughness=brough)
    msol = g.material('boot_sole', color=list(AS.TX.hexc('#161615')) + [1], roughness=0.9)
    mla = g.material('boot_lace', color=list(AS.TX.hexc(lcol)) + [1], roughness=0.85, double=True)
    mme = g.material('boot_metal', color=list(AS.TX.hexc('#34332f')) + [1], roughness=0.45, metallic=0.6, double=True)
    BP = BT.build(B)
    bp = []
    for side in ('Left', 'Right'):
        for k, m in (('upper', mb), ('sole', msol), ('laces', mla), ('metal', mme)):
            d = BP[side][k]
            Wb = AS.nearest_weights(d['pos'], B.vA[:13380], B.W[:13380])
            q = dict(pos=d['pos'], nrm=d['nrm'], idx=d['tri'], mat=m, W=Wb)
            q['uv'] = d['uv'] if 'uv' in d else np.zeros((len(d['pos']), 2))
            if 'col' in d:
                q['color'] = d['col']
            bp.append(q)
    W.skinned('boots', bp, lod=0.3)
    # gear
    env = envelope(R)
    parts = make_gear(R, fac, env, groups)
    # seat the packs directly on the plate carrier's back (no air gap)
    vest = [p for p in parts if p['group'] == 'vest']
    if vest:
        VP = np.concatenate([p['pos'] for p in vest])
        for grp in ('backpack', 'backpack_assault'):
            body = [p for p in parts if p['group'] == grp and p['pos'][:, 2].mean() < -0.12]
            if not body:
                continue
            allp = np.concatenate([p['pos'] for p in body])
            y0, y1 = np.percentile(allp[:, 1], 20), np.percentile(allp[:, 1], 80)
            ym = 0.5 * (y0 + y1)
            m = (np.abs(VP[:, 0]) < 0.12) & (np.abs(VP[:, 1] - ym) < 0.06) & (VP[:, 2] < 0)
            back_z = VP[m, 2].min()                     # plate-carrier back at the pack's mid height
            main = max(body, key=lambda q: np.ptp(q['pos'][:, 1]) * np.ptp(q['pos'][:, 0]))   # the pack box itself
            mp = main['pos']
            band = mp[mp[:, 1] < np.percentile(mp[:, 1], 35)]
            front_z = band[:, 2].max()                  # front face of the pack (lower rounded edge)
            dz = (back_z - 0.006) - front_z
            for p in body:
                p['pos'] = p['pos'] + np.array([0, 0, dz])
            print(f'{grp}: moved {dz * 100:.1f} cm onto the plate carrier')
    ref_pos = R['variants']['A']['uniform_pos']; ref_W = R['uniform']['W']
    parts = [PK.finish_uv(p) if ('charts' in p or 'pack_end' in p) else G.box_uv(p, 2.0) if 'local' in p else p for p in parts]   # v9: pack charts
    for p in parts:
        if p['nrm'] is None:
            p['nrm'] = MU.vertex_normals(p['pos'], p['tri'])
    if ao:
        body_tris = [(R['variants']['B']['uniform_pos'], R['uniform']['tri'])]
        vertex_ao([p for p in parts if not p['group'].startswith('helmet') and not p['group'].startswith('balaclava') and p['group'] != 'headset'], body_tris)
        for hn in ('helmet_A', 'helmet_B', 'helmet_C', 'helmet_D', 'helmet_assault_A', 'helmet_assault_B'):
            vertex_ao([p for p in parts if p['group'] == hn], [(R['variants']['B']['head_pos'], R['head']['tri'])])
    gear_weights(sk, ref_pos, ref_W, parts)
    slings = make_slings(R, fac, env, parts, rig, log=print) if sling else []
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
        hidden = gname in ('helmet_B', 'helmet_C', 'helmet_D', 'backpack', 'legband_L', 'kneepads', 'pouches_back') or gname in ASSAULT_NODES or gname.startswith('balaclava')
        W.skinned(gname, prims, extras={'default_visible': not hidden}, lod=0.28)
    for sl in slings:
        # rifle sling for the rifle slung on the back: separate small node per back-gear depth class, hidden by default (the game
        # shows the one named in the visible preset's extras.preset.sling_node while the rifle sits on extras.preset.sling_socket)
        prims = [dict(pos=q['pos'], nrm=q['nrm'], uv=q['uv'], idx=q['tri'], mat=mats(q['mat']), W=q['W'], color=q.get('col')) for q in sl['parts']]
        W.skinned(sl['node'], prims, extras={'default_visible': False, 'sling': True, 'socket': sl['socket'],
                                             'show_when': f"rifle parented to {sl['socket']} (slung on the back)"})
        tri_count[sl['node']] = int(sum(len(q['tri']) for q in sl['parts']))
    combos = None
    if combos_on:
        bal_masks = {vn: _balaclava_mask(R, vn) for vn in 'ABC'}
        vest_masks = _vest_masks(R, [p for p in parts if p['group'] == 'vest'], log=print)
        std, ast = presets(fac)
        if slings:
            for pr in std + ast:
                cls = 'ruck' if 'backpack' in pr['parts'] else 'pack' if 'backpack_assault' in pr['parts'] else 'pouch' if 'pouches_back' in pr['parts'] else 'bare'
                sl = {s_['cls']: s_ for s_ in slings}[cls]
                pr['sling_node'] = sl['node']; pr['sling_socket'] = sl['socket']
        m1, _ = CB.make(W, rec, fac, std + ast, bal_masks=bal_masks, vest_masks=vest_masks)
        combos = dict(combos=[d for d in m1 if not d['name'].startswith('assault_')], assault_combos=[d for d in m1 if d['name'].startswith('assault_')])
        if crew_on:
            # armoured-vehicle crew presets (crew_combo_N): own atlas, record-only parts (no per-part crew nodes)
            import crew as CR
            combos['crew_combos'] = CR.make_crew(W, rec, R, fac, env, gear_weights, vertex_ao)
    if sockets:
        add_sockets(W, rig, R)
        for sl in slings:
            W.socket(sl['socket'], 'Spine1', sl['t'], sl['q'])
    if with_lod:
        import time as _t; _t0 = _t.time()
        W.emit_lods()
        print('lods %.1fs' % (_t.time() - _t0))
    W.combos = combos
    return W, R, rig, tri_count


ASSAULT_NODES = ('armor_assault', 'armor_groin', 'armor_arms', 'pouches_assault', 'elbowpads', 'backpack_assault',
                 'helmet_assault_A', 'helmet_assault_B', 'headset')
BANDS = ['armband_L', 'armband_R', 'legband_R']
BASE = ['boots', 'vest', 'pouches_front']


def presets(fac):
    """standard (combo_<n>) and assault (assault_combo_<n>) presets.  Armour add-ons: groin protector flap (armor_groin) and
    shoulder / deltoid protectors (armor_arms) on some standard presets, on most assault presets both"""
    std_spec = [('A', 'A', 'hands', ['pouches_side'], []), ('B', 'B', 'gloves', ['pouches_side', 'backpack'], []),
                ('C', 'A', 'gloves', ['pouches_side', 'kneepads'], ['legband_L']), ('A', 'B', 'hands', ['pouches_side', 'pouches_back', 'kneepads'], []),
                ('B', 'A', 'gloves', ['pouches_side', 'backpack'], ['legband_L']), ('C', 'B', 'hands', ['pouches_side', 'pouches_back'], [])]
    # per standard preset: (groin flap, shoulder protectors)
    std_armour = {'ru': [(False, False), (False, True), (True, False), (False, False), (True, True), (False, False)],
                  'ua': [(False, False), (False, False), (True, False), (False, False), (True, True), (False, False)]}[fac]
    std = []
    for k, (b, h, hand, extra, bands) in enumerate(std_spec):
        h = STD_HELMET_OF_PRESET[fac][k]
        groin, arms = std_armour[k]
        parts = [f'body_{b}', f'helmet_{h}', hand] + BASE + extra + BANDS + bands + (['armor_groin'] if groin else []) + (['armor_arms'] if arms else [])
        std.append(dict(name=f'combo_{k}', body=f'body_{b}', helmet=f'helmet_{h}', helmet_desc=STD_HELMET_DESC[fac][h], hands=hand, backpack='backpack' in extra,
                        kneepads='kneepads' in extra, pouches_back='pouches_back' in extra, legband_L='legband_L' in bands,
                        groin_protector=groin, shoulder_protectors=arms, parts=parts))
    AB = ['armor_assault', 'pouches_assault', 'elbowpads', 'kneepads', 'gloves']
    if fac == 'ru':
        # (body, helmet, headset, balaclava, assault pack, groin, shoulders)
        as_spec = [('A', 'A', True, True, True, True, True), ('B', 'B', True, False, False, True, True), ('C', 'A', True, True, True, True, True),
                   ('A', 'B', False, True, False, True, False)]
        hdesc = {'A': '6B47 + NVG mount + headset', 'B': 'Altyn-style heavy steel helmet (no visor)'}
    else:
        as_spec = [('A', 'A', True, False, True, True, True), ('B', 'B', True, True, False, True, False), ('C', 'A', True, False, True, True, True),
                   ('A', 'B', True, True, True, True, True)]
        hdesc = {'A': 'FAST high-cut + NVG shroud + counterweight + headset', 'B': 'MICH mid-cut + goggles + headset'}
    ast = []
    for k, (b, h, hs, bal, pack, groin, arms) in enumerate(as_spec):
        parts = [f'body_{b}', f'helmet_assault_{h}'] + BASE + AB + BANDS + ['legband_L'] + (['armor_groin'] if groin else []) + (['armor_arms'] if arms else [])
        if hs:
            parts.append('headset')
        if bal:
            parts.append(f'balaclava_{b}')
        if pack:
            parts.append('backpack_assault')
        ast.append(dict(name=f'assault_combo_{k}', body=f'body_{b}', helmet=f'helmet_assault_{h}', helmet_desc=hdesc[h], headset=hs,
                        balaclava=bal, backpack_assault=pack, gloves=True, groin_protector=groin, shoulder_protectors=arms, parts=parts))
    return std, ast


def _vest_masks(R, vest_parts, reach=0.075, log=None):
    """uniform triangles completely covered by the plate carrier: every corner, cast outward along its normal, hits the vest
    within `reach`, and is skinned (>= 92 %) to the trunk chain the vest itself rides on -> never visible, dropped from the
    presets (keep-mask, True = keep)"""
    from mathutils.bvhtree import BVHTree
    if not vest_parts:
        return {}
    VP = np.concatenate([p['pos'] for p in vest_parts]); VT = []
    off = 0
    for p in vest_parts:
        VT.append(p['tri'] + off); off += len(p['pos'])
    VT = np.concatenate(VT)
    tree = BVHTree.FromPolygons([tuple(v) for v in VP], [tuple(map(int, t)) for t in VT], all_triangles=True)
    U = R['uniform']; sk = R['skel']
    wt = U['W'][:, [sk.idx[b] for b in TRUNK_BONES]].sum(1)
    lab = np.array(U['labels'])
    torso_tri = np.char.startswith(lab, 'torso')
    out = {}
    for vn in 'ABC':
        P = R['variants'][vn]['uniform_pos']; N = R['variants'][vn]['uniform_nrm']
        cov = np.zeros(len(P), bool)
        for i in np.where(wt >= 0.92)[0]:
            n = N[i] / max(np.linalg.norm(N[i]), 1e-9)
            h = tree.ray_cast(Vector(P[i] + n * 0.001), Vector(n), reach)
            cov[i] = h[0] is not None
        hide = cov[U['tri']].all(1) & torso_tri
        out[vn] = ~hide
        if log:
            log(f'vest mask {vn}: {int(hide.sum())} of {len(hide)} uniform tris hidden under the vest')
    return out


def _balaclava_mask(R, vn):
    """head triangles hidden under the balaclava (dropped from combos that wear one)"""
    v = R['variants'][vn]; H = R['head']; lm = v['lm']
    P = v['head_pos']; T = H['tri']; Pc = P[T].mean(1)
    ec = (lm['eyeL'] + lm['eyeR']) / 2
    slot = (np.abs(Pc[:, 1] - ec[1]) < 0.024) & (np.abs(Pc[:, 0]) < 0.066) & (Pc[:, 2] > ec[2] - 0.04)
    low = Pc[:, 1] < lm['neck'][1] - 0.01
    return ~(slot | low)


def mag_socket_from_reload(path=None, clip='reload_stand'):
    """mag_socket_L = the rifle's pose relative to the left hand at the clip's mag_out event (soldier_anims.glb).  The game parents
    the `magazine` node (gun-space geometry) to this socket with an identity transform, so the magazine then stays exactly where it
    was in the left hand when it leaves the gun, and lands back in the well at mag_in (the reload clips hold the hand on the
    magazine identically at both events).  Returns (t, q) in LeftHand space or None if the clip is unavailable."""
    try:
        import check_anims as CA
        from qmath import qmul, qinv, qrot
        G_ = CA.read_glb(path or f'{ASSETS}/soldier_anims.glb')
        M = CA.Model(G_)
        P = M.pose(clip)
        try:     # event times live in the manifest (soldier_anims.clips.<clip>.events)
            t_out = json.load(open(f'{ASSETS}/manifest.json'))['soldier_anims']['clips'][clip]['events']['mag_out']
        except Exception:
            t_out = 0.7
        f = int(round(float(t_out) * 30))
        iR, iL, iw = M.idx['RightHand'], M.idx['LeftHand'], M.idx['weapon_socket']
        gq = qmul(P['gq'][f, iR], M.R[iw]); gp = P['gp'][f, iR] + qrot(P['gq'][f, iR], M.T[iw])
        qs = qmul(qinv(P['gq'][f, iL]), gq); ts = qrot(qinv(P['gq'][f, iL]), gp - P['gp'][f, iL])
        return np.asarray(ts, float), np.asarray(qs, float) / np.linalg.norm(qs)
    except Exception as e:      # anims not built yet / being rewritten
        print('mag_socket_L: reload clip unavailable, using the hand-frame fallback:', e)
        return None


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
    ms = mag_socket_from_reload()
    if ms is None:     # fallback (old hand-frame guess; leaves the magazine ~15 cm off the palm)
        ms = (HL['palm'] - HL['wrist'] + HL['p'] * 0.02, qfrom_mat(HL['F'] @ np.stack([[0, 0, 1.0], [0, 1.0, 0], [-1.0, 0, 0]], 1).T))
    W.socket('mag_socket_L', 'LeftHand', *ms)
    # slung rifle on the back: diagonal, muzzle down-left, on top of the back plate (or backpack)
    s1 = sk.head[sk.idx['Spine1']]
    from qmath import qlook
    fwd = np.array([-0.45, 0.89, 0.0]); fwd /= np.linalg.norm(fwd)
    back_p = np.array([0.06, 1.13, -0.205]) - s1
    back_q = qlook(fwd, np.array([0, 0, -1.0]))  # muzzle up over the right shoulder, top of the gun facing away
    W.socket('weapon_socket_back', 'Spine1', back_p, back_q)
    # drag handle at the top of the back plate (being_dragged / drag_wounded contact point)
    import clips_extra as CX
    W.socket('drag_handle', 'Spine1', CX.DRAG_HANDLE_REST - s1)
    lm = R['variants']['A']['lm']
    eye_mid = (lm['eyeL'] + lm['eyeR']) / 2
    W.socket('aim', 'Head', eye_mid - sk.head[sk.idx['Head']])
    W.socket('aim_eye_R', 'Head', lm['eyeR'] - sk.head[sk.idx['Head']])


if __name__ == '__main__':
    import build_anims as BA
    BA.setup()  # loads weapon reference points into anim.GUN
    info = {}
    for fac in (sys.argv[1:] or ('ru', 'ua')):
        W, R, rig, tc = build(fac, with_lod=True)
        W.save(f'{ASSETS}/soldier_{fac}.glb')
        info[fac] = W.tris
        print(fac, W.tris)
        json.dump(W.combos, open(f'{BUILD}/combos_{fac}.json', 'w'), indent=1, default=lambda o: o.tolist() if hasattr(o, 'tolist') else str(o))
    json.dump(info, open(f'{BUILD}/soldier_tris.json', 'w'), indent=1)
