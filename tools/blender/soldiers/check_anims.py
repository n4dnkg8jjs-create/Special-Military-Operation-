"""Automated animation QA for assets/soldiers/soldier_anims.glb (reads the shipped GLB, i.e. exactly what the game plays).
run: python3 tools/blender/soldiers/check_anims.py [--glb path] [--manifest manifest.json] [--json out.json] [clip ...]

Per clip it measures
  rot     max per-frame LOCAL joint rotation change (deg) -> pops / quaternion flips (> 25 deg flagged, except deliberate
          impact windows listed in SNAP)
  handL   left palm -> its target on the weapon (rifle grip_L / launcher grip_L / clip-specific spot), in the frames where the
          clip holds the weapon with both hands (m); handLrot = palm orientation error vs the standard support grip (deg)
  butt    rifle butt -> shoulder pocket (aim / fire / peek / ride_aim) or launcher tube contact -> shoulder (m)
  feet    planted clips: lowest sole point per planted foot (penetration < -1 cm or float > 2 cm flagged) and horizontal sole
          slide over the clip (> 1.5 cm flagged); kneeling clips: + right knee / right toe on the ground;
          locomotion: per frame the lower foot must touch the ground (|min| <= 2 cm, run: no penetration only)
  ground  every clip: no joint (with a body-part radius) below the floor; deaths: corpse resting on the ground at the end
  seam    loop clips: first vs last frame (deg / m) and the velocity jump across the seam vs the clip's own max frame-to-frame
          acceleration
  clip    arm (elbow, forearm, wrist, palm) and knee points inside the bare torso hull (per-bone elliptic slices of the
          uniform mesh, shrunk 10 %) -> penetration depth (m); weapon (stock) inside the torso
The body geometry it needs (torso hull, boot soles, palms) is extracted once from .cache/body.pkl into .cache/check_body.npz."""
import os, sys, json, struct, pickle
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np
from qmath import qmul, qinv, qrot

ROOT = os.path.abspath(os.path.join(HERE, '../../..'))
CACHE = os.path.join(HERE, '.cache')
FPS = 30
TOL = dict(rot=25.0, handL=0.02, handLrot=20.0, butt=0.02, pen=0.01, float=0.02, slide=0.015, seam_deg=1.0, seam_m=0.005,
           seam_acc=2.0, clip=0.015, ground=0.01, rest_float=0.05, lying_float=0.08)

# ------------------------------------------------------------------ clip specs
GRIP_L = None      # filled from weapons_info (ak74m grip_L) + [0, -0.018, 0]
L22 = dict(grip_L=np.array([0.0, 0.0265, 0.19]), contact=np.array([0.0, 0.026, -0.345]))
POCKET = np.array([-0.10, 1.445, 0.135]); POCKET_PRONE = np.array([-0.10, 1.43, 0.13]); POCKET_L = np.array([-0.085, 1.50, 0.015])
BUTT = None
RIFLE_STD = ['idle_rifle', 'aim_stand', 'walk_rifle', 'run_rifle', 'crouch_walk', 'limp_walk', 'crouch_idle', 'aim_crouch', 'suppressed_cower',
             'hit_react', 'cqb_stack', 'fire_stand', 'fire_crouch', 'peek_left', 'peek_right', 'peek_crouch_left',
             'peek_crouch_right', 'fire_peek_left', 'fire_peek_right', 'fire_peek_crouch_left', 'fire_peek_crouch_right', 'ride_aim', 'ride_sit_edge']
LAUNCH = ['aim_launcher', 'aim_launcher_kneel', 'launcher_raise', 'launcher_raise_kneel', 'fire_launcher', 'fire_launcher_kneel']
AIM_BUTT = {n: POCKET for n in ('aim_stand', 'aim_crouch', 'fire_stand', 'fire_crouch', 'peek_left', 'peek_right', 'peek_crouch_left', 'peek_crouch_right',
                                 'fire_peek_left', 'fire_peek_right', 'fire_peek_crouch_left', 'fire_peek_crouch_right', 'ride_aim')}
AIM_BUTT.update(aim_prone=POCKET_PRONE, fire_prone=POCKET_PRONE)
# fire_* recoil: the butt pushes the shoulder back by design -> only frame 0/4 (aim pose) are checked
STAND = ['idle_rifle', 'aim_stand', 'fire_stand', 'peek_left', 'peek_right', 'fire_peek_left', 'fire_peek_right', 'reload_stand', 'hit_react',
         'aim_launcher', 'cqb_stack', 'cover_duck']
KNEEL = ['crouch_idle', 'aim_crouch', 'fire_crouch', 'suppressed_cower', 'reload_crouch', 'peek_crouch_left', 'peek_crouch_right',
         'fire_peek_crouch_left', 'fire_peek_crouch_right', 'aim_launcher_kneel', 'launcher_raise_kneel', 'fire_launcher_kneel', 'treat_wounded']
# partially planted: (clip, foot, list of (t0, t1) windows when that foot is planted)
PARTIAL = {'throw_grenade_window': {'Right': [(0, 9)], 'Left': [(0, 0.5), (0.85, 9)]},
           'launcher_raise': {'Left': [(0, 0.12), (0.5, 9)], 'Right': [(0.6, 9)]},
           'fire_launcher': {'Left': [(0, 9)], 'Right': [(0, 0.07), (0.33, 9)]},
           }
LOCO = ['walk_rifle', 'run_rifle', 'crouch_walk', 'limp_walk', 'drag_wounded']
DEATHS = ['death_crumple', 'death_front', 'death_back']
import clips_death as _CD                       # deaths v2 (clips_death.py): window clips rest against the wall, not only on the floor
DEATHS += [n for n in _CD.CLIPS]
_DEATH_SNAP = _CD.SNAP
LYING = ['aim_prone', 'fire_prone', 'prone_idle', 'prone_crawl', 'pinned_prone', 'wounded_crawl', 'wounded_ground']   # trunk rests on the ground
# deliberate fast moves where > 25 deg/frame is allowed (clip -> (t0, t1, limit deg))
SNAP = {'hit_react': (0.0, 0.15, 40.0), 'throw_grenade_window': [(0.40, 0.70, 30.0), (0.70, 0.95, 45.0)], 'death_front': (0.75, 0.95, 40.0), 'death_back': (0.0, 9, 40.0), 'throw_grenade': (0.0, 9, 40.0),
        'death_crumple': (0.25, 1.4, 35.0)}
SNAP.update(_DEATH_SNAP)
NO_GROUND = {'ride_sit_edge', 'ride_sit_deck', 'ride_aim'}   # seat frame, no ground under the root
# ---- vehicle crew (clips_crew.py): PM pistol set; rebuilt crawls (clips_crawl.py); vehicle exits: clips_vehicle.py (vehicle_checks below)
PISTOL = ['pistol_idle', 'pistol_aim', 'pistol_fire', 'pistol_walk', 'pistol_run', 'pistol_crouch_aim']
PM = dict(grip_L=np.array([0.0235, -0.0140, 0.0040]), sight=np.array([0, 0.0695, -0.0345]), front=np.array([0, 0.0702, 0.1015]))   # weapons_info overrides
PISTOL_SIGHT = {'pistol_aim': None, 'pistol_crouch_aim': None, 'pistol_fire': [0, -1]}      # right eye on the PM sight line (frames; None = all)
STAND += ['pistol_idle', 'pistol_aim', 'pistol_fire']
KNEEL += ['pistol_crouch_aim']
LOCO += ['pistol_walk', 'pistol_run']
# planted contacts of the crawls (clip -> list of (point, t0, t1, tol m)); point = joint name or 'palmL'/'palmR'/'soleL'/'soleR';
# 'world' slide = horizontal travel after adding ground_speed * t (the game moves the root at that speed)
CRAWL = {'prone_crawl': [('soleL', 0.0, 0.70, 0.015), ('soleR', 0.70, 1.40, 0.015), ('RightForeArm', 0.05, 0.65, 0.05), ('LeftForeArm', 0.75, 1.35, 0.05)],
         'wounded_crawl': [('palmR', 0.0, 1.0, 0.015), ('palmL', 1.0, 2.0, 0.015), ('soleL', 0.0, 1.0, 0.015)]}
# v5 high crawl (forearms and knees, body off the ground): planted knees (shin joint) / forearms; no flat-body / boot checks
CRAWL['high_crawl'] = [('LeftLeg', 0.03, 0.33, 0.03), ('RightLeg', 0.40, 0.70, 0.03), ('RightForeArm', 0.03, 0.33, 0.05), ('LeftForeArm', 0.40, 0.70, 0.05)]
CRAWL_RAISED = {'high_crawl'}
CRAWL_FLAT = 0.03          # crawls: the bare torso stays within 3 cm of the ground in every frame
CRAWL_FEET_UP = 0.06       # crawls: boots never lifted more than 6 cm (sliding on the ground)
# ---- ATGM / FPV teams + drone reactions (clips_atgm.py)
ATGM_AIM = ['atgm_aim', 'atgm_fire']                      # right eye at the sight (atgm_layout.EYE), palms on GRIP_R / GRIP_L, both knees down
ATGM_PROPS = ['atgm_setup', 'atgm_setup_stugna', 'atgm_pack', 'atgm_pack_stugna', 'atgm_reload', 'atgm_reload_stugna', 'fpv_launch']
KNEEL2 = {'atgm_aim': [(0, 9)], 'atgm_fire': [(0, 9)], 'atgm_setup': [(5.6, 9)], 'atgm_setup_stugna': [(5.5, 9)], 'atgm_pack': [(0, 0.25)],
          'atgm_pack_stugna': [(0, 0.25)]}                 # both knees on the ground in these windows
STAND += ['fpv_launch', 'drone_shoot']
RIFLE_STD += ['drone_shoot']
AIM_BUTT['drone_shoot'] = POCKET
SNAP.update({'dodge_dive': (0.0, 1.2, 45.0), 'dodge_dive_R': (0.0, 1.2, 45.0), 'dodge_dive_L': (0.0, 1.2, 45.0), 'fpv_launch': (0.2, 0.5, 32.0),
             'atgm_reload': (2.6, 3.0, 30.0), 'atgm_reload_stugna': (2.6, 3.0, 30.0)})   # dive / quick lift overhead / loader's quick turn with the spent TLC
PROP_TOL = dict(palm=0.06, place=0.015, place_rot=2.0)   # other hand on the held prop (m); prop placement at from / to events (m, deg)
MANIFEST = None


def atgm_checks(name, r, pose, model, B):
    """eye / grips / knees for the aim clips; held props (manifest records): other palm on its spot, placement at the events"""
    import atgm_layout as LY
    F = pose['F']; t = np.arange(F) / FPS
    gp, gq = pose['gp'], pose['gq']
    if name in ATGM_AIM:
        eye = world_pt(pose, model, 'Head', model.T[model.idx['aim_eye_R']])
        e = np.linalg.norm(eye - LY.EYE, axis=1)
        pr = world_pt(pose, model, 'RightHand', B['palmR']); pl = world_pt(pose, model, 'LeftHand', B['palmL'])
        g = max(np.linalg.norm(pr - LY.GRIP_R, axis=1).max(), np.linalg.norm(pl - LY.GRIP_L, axis=1).max())
        sel = np.ones(F, bool)
        if name == 'atgm_fire':                            # launch flinch: the eye may leave the eyepiece for ~0.4 s
            sel = (t < 0.1) | (t > 0.6)
        r['atgm_eye'] = round(float(e[sel].max()), 4); r['atgm_grips'] = round(float(g), 4)
        if e[sel].max() > 0.015:
            r['flags'].append(f'eye off the sight {e[sel].max():.3f} m')
        if g > 0.015:
            r['flags'].append(f'palms off the control grips {g:.3f} m')
    if name in KNEEL2:
        m = np.zeros(F, bool)
        for a, b in KNEEL2[name]:
            m |= (t >= a - 1e-6) & (t <= b + 1e-6)
        kn = np.stack([gp[:, model.idx['LeftLeg'], 1], gp[:, model.idx['RightLeg'], 1]], 1)[m] - 0.075
        r['knees2'] = (round(float(kn.min()), 4), round(float(kn.max()), 4))
        if kn.min() < -0.02 or kn.max() > 0.03:
            r['flags'].append(f'knees off the ground {kn.min():.3f}..{kn.max():.3f}')
    rec = (MANIFEST or {}).get(name) or {}
    if name in ATGM_PROPS and rec.get('props'):
        ev = rec.get('events', {})
        kind = rec.get('launcher')
        # launcher frame in the clip frame
        if kind:
            if name.startswith('atgm_reload'):
                hq = qaxis_y(-LY.LOADER_HEADING); Lq = hq; Lp = -qrot(hq, LY.loader_root(kind))
            else:
                Lq = np.array([0, 0, 0, 1.0]); Lp = LY.K(kind)['L0']
        res = {}
        for p in rec['props']:
            sq = qmul(gq[:, model.idx[SOCK[p['socket']][0]]], np.broadcast_to(model.R[model.idx[p['socket']]], (F, 4)))
            sp = world_pt(pose, model, SOCK[p['socket']][0], model.T[model.idx[p['socket']]])
            oq = qmul(sq, np.broadcast_to(p['q'], (F, 4))); op = sp + qrot(sq, np.broadcast_to(p['t'], (F, 3)))
            f0, f1 = int(round(ev[p['from_event']] * FPS)), min(int(round(ev[p['to_event']] * FPS)), F - 1)
            if p.get('track'):            # the game drives the prop from its recorded path (clip frame) over the hold window
                tr = p['track']; a, b = tr['f0'], min(tr['f1'], F - 1); n = b - a + 1
                op = op.copy(); oq = oq.copy()
                op[a:b + 1] = np.asarray(tr['p'], float).reshape(-1, 3)[:n]; oq[a:b + 1] = np.asarray(tr['q'], float).reshape(-1, 4)[:n]
            out = {}
            if p.get('other_hand'):
                oh = p['other_hand']
                palm = world_pt(pose, model, oh['side'] + 'Hand', B['palmL'] if oh['side'] == 'Left' else B['palmR'])
                tgt = op + qrot(oq, np.broadcast_to(oh['palm_local'], (F, 3)))
                d = np.linalg.norm(palm - tgt, axis=1)[f0:f1 + 1]
                out['palm'] = round(float(d.max()), 4)
                if d.max() > PROP_TOL['palm']:
                    r['flags'].append(f'{p["node"]}: {oh["side"]} palm off its spot on the prop {d.max():.3f} m')
            for which, f, spec in (('before', f0, p.get('before')), ('after', f1, p.get('after'))):
                if not spec or spec.get('attach') in ('hidden', 'world', 'weapon_socket'):
                    continue
                if spec['attach'] == 'weapon_socket_back':
                    bq = qmul(gq[f, model.idx['Spine1']], model.R[model.idx['weapon_socket_back']])
                    bp = gp[f, model.idx['Spine1']] + qrot(gq[f, model.idx['Spine1']], model.T[model.idx['weapon_socket_back']])
                else:
                    base = p['node'].replace('(fresh)', '')
                    emp = spec.get('empty')
                    if emp == 'tube_setup':
                        q_, p_ = np.array([0, 0, 0, 1.0]), LY.tube_setup(kind)
                    elif emp == 'tube_ground':
                        q_, p_ = np.array([0, 0, 0, 1.0]), LY.tube_ground(kind)
                    elif emp == 'tube_spent':
                        q_, p_ = qaxis_y(LY.SPENT_YAW), LY.tube_spent(kind)
                    elif base.endswith('_tube'):
                        q_, p_ = np.array([0, 0, 0, 1.0]), LY.tube_mount(kind)[0]
                    else:
                        continue
                    bq = qmul(Lq, q_); bp = Lp + qrot(Lq, p_)
                dp = float(np.linalg.norm(op[f] - bp)); da = float(qang(oq[f], bq))
                out[which] = (round(dp, 4), round(da, 2))
                if dp > PROP_TOL['place'] or da > PROP_TOL['place_rot']:
                    r['flags'].append(f'{p["node"]} {which} ({p["from_event" if which == "before" else "to_event"]}) placement off {dp:.3f} m / {da:.1f} deg')
            res[p['node']] = out
        r['props'] = res
    if name == 'fpv_pilot':                 # sitting on the ground: pelvis on the floor, both feet flat and still
        hy = gp[:, model.idx['Hips'], 1]
        r['hips_y'] = (round(float(hy.min()), 3), round(float(hy.max()), 3))
        if hy.max() > 0.15 or hy.min() < 0.08:
            r['flags'].append(f'sitting pelvis off the ground: hips {hy.min():.3f}..{hy.max():.3f} m')


SOCK = {'weapon_socket': ('RightHand',), 'weapon_socket_L': ('LeftHand',)}


def qaxis_y(deg):
    a = np.radians(deg) / 2
    return np.array([0, np.sin(a), 0, np.cos(a)])

CHEST_TORSO_SHRINK = 0.9


def setup_consts():
    global GRIP_L, BUTT
    W = json.load(open(f'{CACHE}/weapons_info.json'))
    wi = W['ak74m']['empties']
    GRIP_L = np.array(wi['grip_L'][0]) + [0, -0.018, 0]
    BUTT = np.array(wi['stock_butt'][0]) + [0, 0.015, 0]
    if 'pm' in W:
        e = W['pm']['empties']
        PM.update(grip_L=np.array(e['grip_L'][0]), sight=np.array(e['sight_rear'][0]), front=np.array(e['sight_front'][0]))


def left_spec(name, F):
    """per-frame (target in gun space or None, check orientation?)"""
    t = np.arange(F) / FPS
    tg = np.full((F, 3), np.nan); rot = np.zeros(F, bool)
    if name in RIFLE_STD:
        tg[:] = GRIP_L; rot[:] = True
    elif name in PISTOL:
        tg[:] = PM['grip_L']              # support palm on the left grip panel (orientation: own hand pose, not the rifle grip)
    elif name in ('aim_prone', 'fire_prone', 'prone_idle'):
        tg[:] = GRIP_L + [0, 0, -0.09]; rot[:] = True
    elif name in LAUNCH:
        tg[:] = L22['grip_L'] + [0, -0.016, 0]; rot[:] = True
    elif name == 'ride_sit_deck':
        tg[:] = [0, 0.075, 0.235]
    elif name == 'cover_duck':
        tg[:] = [0, 0.075, 0.25]
    elif name in ('reload_stand', 'reload_crouch'):
        m = (t <= 0.22) | (t >= 2.47); tg[m] = GRIP_L; rot[m] = True
        for te in (0.70, 1.80):
            tg[int(round(te * FPS))] = [0.032, -0.055, 0.112]
    elif name in VEH and VCHECK(name).get('grip'):
        m = np.zeros(F, bool)
        for a, b in VCHECK(name)['grip']:
            m |= (t >= a - 1e-6) & (t <= b + 1e-6)
        tg[m] = GRIP_L; rot[m] = True
    elif name == 'death_crumple':
        m = t <= 0.2; tg[m] = GRIP_L; rot[m] = True
    return tg, rot


# ------------------------------------------------------------------ GLB reading
def read_glb(path):
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[12:16])[0]
    g = json.loads(b[20:20 + n])
    off = 20 + n
    bl = struct.unpack('<I', b[off:off + 4])[0]
    bin_ = b[off + 8:off + 8 + bl]
    ncomp = dict(SCALAR=1, VEC3=3, VEC4=4)

    def acc(i):
        a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]
        o = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        k = ncomp[a['type']]
        assert a['componentType'] == 5126
        return np.frombuffer(bin_, np.float32, a['count'] * k, o).reshape(a['count'], k).astype(np.float64)
    nodes = g['nodes']
    names = [x['name'] for x in nodes]
    parent = [-1] * len(nodes)
    for i, x in enumerate(nodes):
        for c in x.get('children', []):
            parent[c] = i
    anims = {}
    for a in g['animations']:
        ch = {}
        T = None
        for c in a['channels']:
            s = a['samplers'][c['sampler']]
            T = acc(s['input'])[:, 0]
            ch[(c['target']['node'], c['target']['path'])] = acc(s['output'])
        anims[a['name']] = dict(t=T, ch=ch, extras=a.get('extras', {}))
    return dict(names=names, parent=parent, nodes=nodes, anims=anims)


class Model:
    """FK over the GLB node tree (joints + sockets)"""
    def __init__(self, G):
        self.G = G
        self.names = G['names']
        self.idx = {n: i for i, n in enumerate(self.names)}
        self.n = len(self.names)
        self.T = np.array([x.get('translation', [0, 0, 0]) for x in G['nodes']], float)
        self.R = np.array([x.get('rotation', [0, 0, 0, 1]) for x in G['nodes']], float)
        self.parent = G['parent']
        # bind-pose world positions (rest rotations are identity for joints)
        self.rest = np.zeros((self.n, 3))
        for i in range(self.n):
            p = self.parent[i]
            self.rest[i] = self.T[i] + (self.rest[p] if p >= 0 else 0)

    def pose(self, name):
        a = self.G['anims'][name]
        F = len(a['t'])
        lq = np.tile(self.R, (F, 1, 1)); lt = np.tile(self.T, (F, 1, 1))
        for (nd, path), v in a['ch'].items():
            if path == 'rotation':
                lq[:, nd] = v / np.linalg.norm(v, axis=1, keepdims=True)
            elif path == 'translation':
                lt[:, nd] = v
        gq = np.zeros_like(lq); gp = np.zeros_like(lt)
        for i in range(self.n):
            p = self.parent[i]
            if p < 0:
                gq[:, i] = lq[:, i]; gp[:, i] = lt[:, i]
            else:
                gq[:, i] = qmul(gq[:, p], lq[:, i]); gp[:, i] = gp[:, p] + qrot(gq[:, p], lt[:, i])
        return dict(lq=lq, gq=gq, gp=gp, t=a['t'], F=F, extras=a['extras'])


# ------------------------------------------------------------------ body geometry
def body_geometry():
    path = f'{CACHE}/check_body.npz'
    if os.path.exists(path):
        return dict(np.load(path, allow_pickle=True))
    import anim as A
    R = pickle.load(open(f'{CACHE}/body.pkl', 'rb'))
    sk = R['skel']
    rig = A.Rig(sk, R['hands']['pos'], R['hands']['W'])
    P = R['variants']['A']['uniform_pos']; W = R['uniform']['W']; lab = np.array(R['uniform']['labels'])
    tb = [sk.idx[b] for b in ('Hips', 'LowerBack', 'Spine', 'Spine1')]
    tri = np.asarray(R['uniform']['tri'])
    vt = np.zeros(len(P), bool)
    if len(lab) == len(P):
        vt = np.isin(lab, ['torso_f', 'torso_b'])
    else:                                   # per-face labels
        vt[np.unique(tri[np.isin(lab, ['torso_f', 'torso_b'])])] = True
    m = (W[:, tb].sum(1) > 0.85) & (vt | (P[:, 1] > 0.85))   # torso panels + pelvis (trouser verts skinned to the trunk)
    dom = np.array(tb)[np.argmax(W[m][:, tb], 1)]
    sole = R['boots'][0]['sole'][0]
    sole = sole[np.abs(sole[:, 1]) < 1e-6]
    out = dict(torso_p=P[m], torso_b=dom, soleL=sole, palmL=rig.hand['Left']['palm'] - rig.hand['Left']['wrist'],
               palmR=rig.hand['Right']['palm'] - rig.hand['Right']['wrist'])
    np.savez(path, **out)
    return out


class Torso:
    """per-bone elliptic slices of the bare torso (bind pose, world coords)"""
    def __init__(self, B, model, dy=0.025):
        self.slices = {}
        self.B = B
        for b in np.unique(B['torso_b']):
            name = BONES[b]
            pts = B['torso_p'][B['torso_b'] == b]
            y0, y1 = pts[:, 1].min(), pts[:, 1].max()
            ys = np.arange(y0, y1 + dy, dy)
            sl = []
            if len(pts) < 20:
                continue
            for y in ys:
                s = pts[np.abs(pts[:, 1] - y) < dy * 0.75]
                if len(s) < 6:
                    continue
                sl.append((y, np.abs(s[:, 0]).max(), s[:, 2].min(), s[:, 2].max()))
            self.slices[name] = np.array(sl)
        self.model = model

    def verts(self, pose):
        """(F, k, 3) bare-torso vertices, rigid with their dominant spine bone"""
        out = []
        for b in np.unique(self.B['torso_b']):
            i = self.model.idx[BONES[b]]
            p = self.B['torso_p'][self.B['torso_b'] == b][::3]
            F = pose['F']
            out.append(pose['gp'][:, i][:, None] + qrot(np.repeat(pose['gq'][:, i][:, None], len(p), 1), np.broadcast_to(p - self.model.rest[i], (F, len(p), 3))))
        return np.concatenate(out, 1)

    def depth(self, pose, pts, shrink=CHEST_TORSO_SHRINK):
        """pts (F, k, 3) world -> max penetration depth (F, k) (0 = outside)"""
        F, k, _ = pts.shape
        best = np.zeros((F, k))
        for name, sl in self.slices.items():
            i = self.model.idx[name]
            q = pose['gq'][:, i]; p = pose['gp'][:, i]
            loc = qrot(np.repeat(qinv(q)[:, None], k, 1), pts - p[:, None]) + self.model.rest[i]
            y = loc[..., 1]
            j = np.clip(np.searchsorted(sl[:, 0], y), 0, len(sl) - 1)
            inside_y = (y >= sl[0, 0] - 0.01) & (y <= sl[-1, 0] + 0.01)
            ax = sl[j, 1] * shrink; zc = (sl[j, 2] + sl[j, 3]) / 2; az = (sl[j, 3] - sl[j, 2]) / 2 * shrink
            r = np.sqrt((loc[..., 0] / ax) ** 2 + ((loc[..., 2] - zc) / az) ** 2)
            d = np.where(inside_y & (r < 1), (1 - r) * np.minimum(ax, az), 0)
            best = np.maximum(best, d)
        return best


BONES = ['Hips', 'LowerBack', 'Spine', 'Spine1', 'Neck', 'Neck1', 'Head', 'LHipJoint', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LThumb',
         'LeftFingerBase', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftHandFinger1', 'LeftToeBase', 'RHipJoint', 'RightShoulder', 'RightArm', 'RightForeArm',
         'RightHand', 'RThumb', 'RightFingerBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightHandFinger1', 'RightToeBase']


# ------------------------------------------------------------------ measurements
def qang(a, b):
    d = np.abs(np.sum(a * b, -1)).clip(0, 1)
    return np.degrees(2 * np.arccos(d))


def world_pt(pose, model, node, local):
    i = model.idx[node]
    F = pose['F']
    return pose['gp'][:, i] + qrot(pose['gq'][:, i], np.broadcast_to(local, (F, 3)))


def sole_points(pose, model, B, side):
    """(F, k, 3) world sole outline; front part bends with the toe"""
    sx = 1 if side == 'Left' else -1
    s = B['soleL'] * [sx, 1, 1]
    fi = model.idx[side + 'Foot']; ti = model.idx[side + 'ToeBase']
    toe = s[:, 2] > model.rest[ti, 2] - 0.005
    F = pose['F']
    out = np.zeros((F, len(s), 3))
    for msk, i in ((~toe, fi), (toe, ti)):
        loc = s[msk] - model.rest[i]
        out[:, msk] = pose['gp'][:, i][:, None] + qrot(np.repeat(pose['gq'][:, i][:, None], msk.sum(), 1), np.broadcast_to(loc, (F, msk.sum(), 3)))
    return out


def check_clip(name, model, pose, B, torso):
    F = pose['F']; t = np.arange(F) / FPS
    lq, gp, gq = pose['lq'], pose['gp'], pose['gq']
    r = dict(name=name, frames=F, dur=round(float(pose['t'][-1]), 3), loop=bool(pose['extras'].get('loop')), flags=[])
    J = [model.idx[b] for b in BONES]
    # ---- per-frame local rotation change
    d = np.stack([qang(lq[1:, j], lq[:-1, j]) for j in J], 1)          # (F-1, nb)
    lim = np.full(F - 1, TOL['rot'])
    if name in SNAP:
        tm = (t[1:] + t[:-1]) / 2
        for t0, t1, l2 in (SNAP[name] if isinstance(SNAP[name], list) else [SNAP[name]]):
            lim[(tm >= t0) & (tm <= t1)] = l2
    worst = np.unravel_index(np.argmax(d - lim[:, None]), d.shape)
    r['rot'] = round(float(d.max()), 1)
    r['rot_at'] = f'{BONES[np.argmax(d.max(0))]}@f{int(np.argmax(d.max(1)))}'
    if (d > lim[:, None]).any():
        r['flags'].append(f'rot {d[worst]:.1f} deg {BONES[worst[1]]} f{worst[0]}->{worst[0] + 1}')
    # ---- weapon hold (left palm on its target)
    gun_q = qmul(gq[:, model.idx['RightHand']], np.broadcast_to(model.R[model.idx['weapon_socket']], (F, 4)))
    gun_p = world_pt(pose, model, 'RightHand', model.T[model.idx['weapon_socket']])
    tg, chk_rot = left_spec(name, F)
    has = ~np.isnan(tg[:, 0])
    if has.any():
        palm = world_pt(pose, model, 'LeftHand', B['palmL'])
        tw = gun_p + qrot(gun_q, np.nan_to_num(tg))
        e = np.linalg.norm(palm - tw, axis=1)
        r['handL'] = round(float(e[has].max()), 4)
        r['handL_at'] = int(np.argmax(np.where(has, e, -1)))
        if r['handL'] > TOL['handL']:
            r['flags'].append(f'handL {r["handL"]:.3f} m f{r["handL_at"]}')
        if chk_rot.any() and name not in PISTOL:
            sockL = qmul(gq[:, model.idx['LeftHand']], np.broadcast_to(model.R[model.idx['weapon_socket_L']], (F, 4)))
            ea = qang(sockL, gun_q)
            r['handLrot'] = round(float(ea[chk_rot].max()), 1)
            if r['handLrot'] > TOL['handLrot']:
                r['flags'].append(f'handLrot {r["handLrot"]:.1f} deg')
    # ---- butt / tube contact to the shoulder
    ic = model.idx['RightShoulder']
    if name in AIM_BUTT or name in ('aim_launcher', 'aim_launcher_kneel', 'fire_launcher', 'fire_launcher_kneel'):
        if name in AIM_BUTT:
            pk_rest, pt = AIM_BUTT[name], BUTT
        else:
            pk_rest, pt = POCKET_L, L22['contact']
        pk = world_pt(pose, model, 'RightShoulder', pk_rest - model.rest[ic])
        bw = gun_p + qrot(gun_q, np.broadcast_to(pt, (F, 3)))
        e = np.linalg.norm(bw - pk, axis=1)
        sel = np.ones(F, bool)
        if name.startswith('fire_') and 'launcher' not in name:
            sel[1:-1] = False
        if name.startswith('fire_launcher'):
            sel[:] = t <= 0.05
        r['butt'] = round(float(e[sel].max()), 4)
        if r['butt'] > TOL['butt']:
            r['flags'].append(f'butt {r["butt"]:.3f} m')
    if name in PISTOL_SIGHT:
        fr_ = range(F) if PISTOL_SIGHT[name] is None else [f % F for f in PISTOL_SIGHT[name]]
        fr_ = np.array(list(fr_))
        eye = world_pt(pose, model, 'Head', model.T[model.idx['aim_eye_R']])[fr_]
        a = (gun_p + qrot(gun_q, np.broadcast_to(PM['sight'], (F, 3))))[fr_]; b = (gun_p + qrot(gun_q, np.broadcast_to(PM['front'], (F, 3))))[fr_]
        d = (b - a) / np.linalg.norm(b - a, axis=1, keepdims=True)
        off = np.linalg.norm(np.cross(eye - a, d), axis=1)
        ang = np.degrees(np.arccos(np.clip(d[:, 2], -1, 1)))
        r['sight'] = (round(float(off.max()), 4), round(float(ang.max()), 2))
        if off.max() > 0.015 or ang.max() > 3.0:
            r['flags'].append(f'pistol sight line off the right eye {off.max():.3f} m / {ang.max():.1f} deg from +Z')
    if name in ATGM_AIM or name in ATGM_PROPS or name in KNEEL2 or name == 'fpv_pilot':
        atgm_checks(name, r, pose, model, B)
    # ---- feet
    soles = {sd: sole_points(pose, model, B, sd) for sd in ('Left', 'Right')}
    if name in CRAWL:
        crawl_hatch_checks(name, r, pose, model, B, soles, gun_q, gun_p)
    if name in VEH:
        vehicle_checks(name, r, pose, model, B, soles)
    low = {sd: soles[sd][..., 1].min(1) for sd in soles}
    planted = {}
    if name in STAND:
        planted = {'Left': np.ones(F, bool), 'Right': np.ones(F, bool)}
    elif name in KNEEL:
        planted = {'Left': np.ones(F, bool)}
    elif name in PARTIAL:
        for sd, wins in PARTIAL[name].items():
            planted[sd] = np.zeros(F, bool)
            for a, b in wins:
                planted[sd] |= (t >= a - 1e-6) & (t <= b + 1e-6)
    fr = {}
    for sd, m in planted.items():
        y = low[sd][m]
        hz = soles[sd][m][..., [0, 2]]
        slide = float(np.linalg.norm(hz - hz[:1], axis=2).max()) if len(hz) else 0
        if name in PARTIAL:   # per planted window
            slide = 0.0
            idx = np.where(m)[0]
            for seg in np.split(idx, np.where(np.diff(idx) > 1)[0] + 1):
                h = soles[sd][seg][..., [0, 2]]
                slide = max(slide, float(np.linalg.norm(h - h[:1], axis=2).max()))
        fr[sd] = (round(float(y.min()), 4), round(float(y.max()), 4), round(slide, 4))
        if y.min() < -TOL['pen']:
            r['flags'].append(f'{sd} foot penetrates {y.min():.3f} m')
        if y.max() > TOL['float']:
            r['flags'].append(f'{sd} foot floats {y.max():.3f} m')
        if slide > TOL['slide']:
            r['flags'].append(f'{sd} foot slides {slide:.3f} m')
    if name in KNEEL:
        kn = gp[:, model.idx['RightLeg'], 1] - 0.075            # kneecap ~7.5 cm in front/below the knee joint when kneeling
        toe = low['Right']
        fr['Rknee'] = (round(float(kn.min()), 4), round(float(kn.max()), 4))
        fr['Rtoe'] = (round(float(toe.min()), 4), round(float(toe.max()), 4))
        if kn.min() < -0.02 or kn.max() > 0.03:
            r['flags'].append(f'R knee off the ground {kn.min():.3f}..{kn.max():.3f}')
        if toe.min() < -TOL['pen'] or toe.max() > 0.03:
            r['flags'].append(f'R toe off the ground {toe.min():.3f}..{toe.max():.3f}')
    if name in LOCO:
        both = np.minimum(low['Left'], low['Right'])
        fr['loco_min'] = (round(float(both.min()), 4), round(float(both.max()), 4))
        if both.min() < -TOL['pen']:
            r['flags'].append(f'loco foot penetrates {both.min():.3f}')
        if name not in ('run_rifle', 'pistol_run') and both.max() > TOL['float']:
            r['flags'].append(f'loco both feet up {both.max():.3f}')
    r['feet'] = fr
    # ---- whole-body ground penetration (bare torso surface from the uniform mesh + limb joints with radii + boot soles)
    if name not in NO_GROUND:
        c = np.full(model.n, -9.0)
        for b, v in (('Neck', 0.06), ('Neck1', 0.06), ('Head', 0.10), ('LeftArm', 0.05), ('RightArm', 0.05), ('LeftForeArm', 0.04), ('RightForeArm', 0.04),
                     ('LeftHand', 0.025), ('RightHand', 0.025), ('LeftLeg', 0.045), ('RightLeg', 0.045), ('LeftUpLeg', 0.07), ('RightUpLeg', 0.07)):
            c[model.idx[b]] = v
        jj = np.array([model.idx[b] for b in BONES])
        lowj = gp[:, jj, 1] - c[jj][None]                        # (F, nb) clearance of each limb joint
        tv = torso.verts(pose)[..., 1].min(1)                    # (F,) lowest bare-torso vertex
        solemin = np.minimum(low['Left'], low['Right'])
        g = np.maximum(np.maximum(-lowj.min(1), -tv - 0.01), -solemin)   # bare torso may not go below -1 cm (the vest is outside it)
        r['ground_pen'] = round(float(g.max()), 4)
        if g.max() > TOL['ground']:
            f = int(np.argmax(g))
            b = 'sole' if -solemin[f] >= g[f] else ('torso' if -tv[f] - 0.01 >= g[f] else BONES[int(np.argmin(lowj[f]))])
            r['flags'].append(f'below ground {g.max():.3f} m ({b} f{f})')
        if name in LYING:
            r['torso_low'] = round(float(tv.max()), 4)
            if tv.max() > TOL['lying_float']:
                r['flags'].append(f'lying body floats: bare torso {tv.max():.3f} m above the ground (f{int(np.argmax(tv))})')
        if name == 'wounded_sit':        # sitting on the ground: pelvis (hip joint ~11 cm above the buttocks) on the floor
            hy = gp[:, model.idx['Hips'], 1]
            r['hips_y'] = (round(float(hy.min()), 3), round(float(hy.max()), 3))
            if hy.max() > 0.15 or hy.min() < 0.08:
                r['flags'].append(f'sitting pelvis off the ground: hips {hy.min():.3f}..{hy.max():.3f} m')
        if name in DEATHS:
            clear = min(lowj[-1].min(), tv[-1] - 0.025, solemin[-1])   # 2.5 cm of plate carrier on the torso
            r['rest_gap'] = round(float(clear), 4)
            if clear > TOL['rest_float']:
                r['flags'].append(f'corpse floats {clear:.3f} m')
    # ---- loop seam
    if r['loop'] and F > 3:
        sa = max(float(qang(lq[0, j], lq[-1, j])) for j in J)
        sm = float(np.linalg.norm(gp[0, model.idx['Hips']] - gp[-1, model.idx['Hips']]))
        # velocity jump across the seam (frame F-2 -> F-1 == 0 -> 1) vs interior
        P = np.concatenate([gp[:, J], qrot(gq[:, J], np.broadcast_to([0, 0.1, 0], (F, len(J), 3)))], 1)   # joints + 10 cm direction markers
        v = np.diff(P, axis=0)
        acc_in = np.linalg.norm(np.diff(v, axis=0), axis=2).max(1)          # (F-2)
        acc_seam = np.linalg.norm(v[0] - v[-1], axis=1).max()
        r['seam'] = (round(sa, 2), round(sm, 4), round(float(acc_seam), 4), round(float(np.percentile(acc_in, 95)), 4))
        if sa > TOL['seam_deg'] or sm > TOL['seam_m']:
            r['flags'].append(f'seam mismatch {sa:.1f} deg / {sm:.3f} m')
        if acc_seam > max(TOL['seam_acc'] * acc_in.max(), 0.004):
            r['flags'].append(f'seam velocity jump {acc_seam:.4f} (interior max {acc_in.max():.4f})')
    # ---- limbs through the torso
    pts = []; labels = []
    for sd in ('Left', 'Right'):
        a, f_, h = gp[:, model.idx[sd + 'Arm']], gp[:, model.idx[sd + 'ForeArm']], gp[:, model.idx[sd + 'Hand']]
        for k, (u, v_, w) in enumerate(((a, f_, 0.6), (a, f_, 1.0), (f_, h, 0.33), (f_, h, 0.66), (f_, h, 1.0))):
            pts.append(u + (v_ - u) * w); labels.append(f'{sd} {["upperarm", "elbow", "forearm1", "forearm2", "wrist"][k]}')
        pts.append(world_pt(pose, model, sd + 'Hand', B['palmL'] if sd == 'Left' else B['palmR'])); labels.append(f'{sd} palm')
        pts.append(gp[:, model.idx[sd + 'Leg']]); labels.append(f'{sd} knee')
    pts = np.stack(pts, 1)
    dep = torso.depth(pose, pts)
    r['clip'] = round(float(dep.max()), 4)
    if dep.max() > TOL['clip']:
        f, k = np.unravel_index(np.argmax(dep), dep.shape)
        r['flags'].append(f'limb in torso {dep.max():.3f} m ({labels[k]} f{f})')
    if (has.any() or name in ('throw_grenade_window',)) and name not in PISTOL:
        # weapon stock (between the grip and the butt) inside the torso
        gpts = np.stack([gun_p + qrot(gun_q, np.broadcast_to(BUTT * w, (F, 3))) for w in (0.35, 0.65)], 1)
        gd = torso.depth(pose, gpts, shrink=0.85)
        if name in ('throw_grenade_window', 'death_crumple'):
            gd[:] = 0
        r['gun_clip'] = round(float(gd.max()), 4)
        if gd.max() > TOL['clip']:
            r['flags'].append(f'stock in torso {gd.max():.3f} m f{int(np.argmax(gd.max(1)))}')
    return r


def crawl_hatch_checks(name, r, pose, model, B, soles, gun_q, gun_p):
    F = pose['F']; t = np.arange(F) / FPS
    gp = pose['gp']
    sp = float(pose['extras'].get('speed') or 0.0)
    if name in CRAWL:
        res = {}
        for pt, t0, t1, tol in CRAWL[name]:
            m = (t >= t0 - 1e-6) & (t <= t1 + 1e-6)
            if pt.startswith('sole'):
                P = soles['Left' if pt[-1] == 'L' else 'Right'][m].mean(1)   # sole centroid (the boot is rigid)
            elif pt.startswith('palm'):
                sd = 'Left' if pt[-1] == 'L' else 'Right'
                P = world_pt(pose, model, sd + 'Hand', B['palmL'] if sd == 'Left' else B['palmR'])[m]
            else:
                P = gp[m, model.idx[pt]]
            P = P.copy(); P[:, 2] += sp * t[m]
            slide = float(np.linalg.norm(P[:, [0, 2]] - P[:1, [0, 2]], axis=1).max())
            res[pt] = round(slide, 4)
            if slide > tol:
                r['flags'].append(f'crawl contact {pt} slides {slide:.3f} m in the world ({t0}-{t1} s, tol {tol})')
        r['crawl_slide'] = res
        if name in CRAWL_RAISED:
            tv = Torso(B, model).verts(pose)[..., 1].min(1)
            r['crawl_torso_clear'] = round(float(tv.min()), 4)
            if tv.min() < 0.0:
                r['flags'].append(f'high crawl torso through the ground {tv.min():.3f} m')
            return
        tv = Torso(B, model).verts(pose)[..., 1].min(1)
        r['crawl_flat'] = (round(float(tv.min()), 4), round(float(tv.max()), 4))
        if tv.max() > CRAWL_FLAT:
            r['flags'].append(f'crawl body lifts {tv.max():.3f} m off the ground')
        up = max(float(soles[sd][..., 1].min(1).max()) for sd in soles)
        r['crawl_feet_up'] = round(up, 4)
        if up > CRAWL_FEET_UP:
            r['flags'].append(f'crawl boot lifted {up:.3f} m')
        if name == 'prone_crawl':     # rifle (right hand) clear of the ground: magazine, muzzle, butt toe, handguard bottom
            pts = np.array([[0, -0.22, 0.17], [0, 0.084, 0.621], [0, -0.09, -0.337], [0, -0.05, 0.40]])
            low = min(float((gun_p + qrot(gun_q, np.broadcast_to(p_, (F, 3))))[:, 1].min()) for p_ in pts)
            r['rifle_low'] = round(low, 4)
            if low < -0.01:
                r['flags'].append(f'rifle through the ground {low:.3f} m')


# ---- vehicle exits (clips_vehicle.py): body vs the vehicle GLB meshes (voxelised solid, hatch / door openings carved), planted
# feet on their support (vehicle surface / ground / floor) without sliding, left palm on the handguard windows, events present,
# start (ride_sit_edge frame 0 at the seat) and end (crouch_walk frame 0) continuity
import clips_vehicle as CVH
VEH = list(CVH.CLIPS)
VCHECK = lambda n: CVH.CHECK[CVH.ALIAS.get(n, n)]
for _n in VEH:                      # landing impacts (first contact frames after a drop): deliberate fast knee / hip flexion
    if VCHECK(_n).get('snap'):
        SNAP[_n] = VCHECK(_n)['snap']
VRAD = dict(Hips=0.10, LowerBack=0.10, Spine=0.11, Spine1=0.12, Neck=0.06, Head=0.10, LeftHand=0.0, RightHand=0.0, LeftFoot=0.0, RightFoot=0.0,
            LeftToeBase=0.0, RightToeBase=0.0, LeftUpLeg=0.07, RightUpLeg=0.07, LeftLeg=0.05, RightLeg=0.05, LeftForeArm=0.04, RightForeArm=0.04)
# (hands / feet are contact effectors: joint centre vs the solid only; their contacts are checked against the exact mesh surface
#  by the planted-foot clearance and the palm targets, the voxel grid would read a palm flat on a plate as 3-6 cm deep)


def vehicle_checks(name, r, pose, model, B, soles):
    base = CVH.ALIAS.get(name, name)
    L = CVH.LAYOUT[base]
    F = pose['F']; t = np.arange(F) / FPS
    gp, lq = pose['gp'], pose['lq']
    # -- body inside the vehicle(s)
    pen = {}
    for veh in L.get('veh', ()):
        worst = (0.0, '')
        for b in BONES:
            if b.endswith(('Thumb', 'FingerBase', 'Finger1')) or b in ('LHipJoint', 'RHipJoint', 'Neck1'):
                continue
            d = CVH.vehicle_depth(base, veh, gp[:, model.idx[b]], VRAD.get(b, 0.05))
            if d.max() > worst[0]:
                worst = (float(d.max()), f'{b}@{t[int(np.argmax(d))]:.2f}s')
        pen[veh] = (round(worst[0], 3), worst[1])
        if worst[0] > CVH.PEN_TOL:
            r['flags'].append(f'body inside {veh} {worst[0]:.3f} m ({worst[1]})')
    r['veh_pen'] = pen
    # -- planted feet: stationary (< 3 cm/s for >= 4 frames) -> lowest sole point on its support, no slide
    res = []
    for sd in ('Left', 'Right'):
        S = soles[sd]; c = S.mean(1); low = S[..., 1].min(1)
        v = np.r_[0, np.linalg.norm(np.diff(c, axis=0), axis=1)] * FPS
        st = v < 0.03
        idx = np.where(st)[0]
        for seg in (np.split(idx, np.where(np.diff(idx) > 1)[0] + 1) if len(idx) else []):
            if len(seg) < 4:
                continue
            # clearance = min over the sole outline of (sole point height - support under that point): sloped plates
            dy = np.array([min(p_[1] - CVH.support_y(base, p_[0], p_[2], p_[1]) for p_ in S[f, ::4]) for f in seg[::3]])
            if dy.min() > 0.10:                                     # still but in the air (dangling legs while seated)
                continue
            slide = float(np.linalg.norm(c[seg][:, [0, 2]] - c[seg[0], [0, 2]], axis=1).max())
            res.append((sd[0], round(t[seg[0]], 2), round(t[seg[-1]], 2), round(float(dy.min()), 3), round(float(dy.max()), 3), round(slide, 3)))
            if dy.min() < -0.015 or dy.max() > 0.03 or slide > 0.02:
                r['flags'].append(f'{sd} planted foot {t[seg[0]]:.2f}-{t[seg[-1]]:.2f}s off its support {dy.min():.3f}..{dy.max():.3f} m, slide {slide:.3f}')
    r['veh_feet'] = res
    # -- events
    rec = (MANIFEST or {}).get(name) or {}
    ev = rec.get('events') or {}
    miss = [e for e in VCHECK(name)['events'] if e not in ev]
    if rec and miss:
        r['flags'].append(f'missing events {miss}')
    if 'draw' in ev and abs(ev['draw'] - (r['dur'] - 0.5)) > 0.02:
        r['flags'].append(f'draw event {ev["draw"]} != dur - 0.5 (the game shows the PM for the last 0.5 s)')
    # -- ends on its root (crew) / start + end continuity (rifle dismounts)
    end = gp[-1, model.idx['Hips']]
    r['veh_end_hips'] = [round(float(x), 3) for x in end]
    if np.hypot(end[0], end[2]) > 0.03:
        r['flags'].append(f'does not end over the root ({end[0]:.3f}, {end[2]:.3f})')
    J = [model.idx[b] for b in BONES if not b.endswith(('Thumb', 'FingerBase', 'Finger1'))]
    for key, fa, fb in (('start', 0, 0), ('end', -1, 0)):
        other = VCHECK(name).get(key)
        if not other or other not in model.G['anims']:
            continue
        po = model.pose(other)
        ang = max(float(qang(lq[fa, j], po['lq'][fb, j])) for j in J)
        off = np.array(CVH.v2c(base, L['seat'])) if key == 'start' else np.zeros(3)
        dr = float(np.linalg.norm(gp[fa, model.idx['Hips']] - (po['gp'][fb, model.idx['Hips']] + off)))
        r[f'veh_{key}'] = (other, round(ang, 2), round(dr, 4))
        if ang > 2.0 or dr > 0.005:
            r['flags'].append(f'{key} pose != {other}[{fb}]: {ang:.1f} deg / {dr:.3f} m')


def main():
    args = sys.argv[1:]
    glb = f'{ROOT}/assets/soldiers/soldier_anims.glb'
    js = None
    if '--glb' in args:
        i = args.index('--glb'); glb = args[i + 1]; del args[i:i + 2]
    if '--json' in args:
        i = args.index('--json'); js = args[i + 1]; del args[i:i + 2]
    setup_consts()
    global MANIFEST
    mp = f'{ROOT}/assets/soldiers/manifest.json'
    if '--manifest' in args:
        i = args.index('--manifest'); mp = args[i + 1]; del args[i:i + 2]
    if os.path.exists(mp):
        MANIFEST = json.load(open(mp)).get('soldier_anims', {}).get('clips', {})
    G = read_glb(glb)
    model = Model(G)
    B = body_geometry()
    torso = Torso(B, model)
    names = args or list(G['anims'])
    res = []
    for n in names:
        r = check_clip(n, model, model.pose(n), B, torso)
        res.append(r)
        status = 'OK  ' if not r['flags'] else 'FAIL'
        extra = ' '.join(f'{k}={r[k]}' for k in ('rot', 'handL', 'handLrot', 'butt', 'sight', 'clip', 'gun_clip', 'ground_pen', 'rest_gap', 'seam', 'crawl_slide', 'crawl_flat',
                                                     'crawl_feet_up', 'rifle_low', 'veh_pen', 'veh_feet', 'veh_end_hips', 'veh_start', 'veh_end', 'atgm_eye', 'atgm_grips',
                                                     'knees2', 'props', 'hips_y') if k in r)
        print(f'{status} {n:24s} {r["dur"]:6.3f}s {"loop" if r["loop"] else "once"} {extra} feet={r["feet"]}')
        for f in r['flags']:
            print('       !', f)
    # ---- transitions the game relies on (pose A frame a == pose B frame b)
    PAIRS = [('fire_stand', 0, 'aim_stand', 0), ('fire_crouch', 0, 'aim_crouch', 0), ('fire_prone', 0, 'aim_prone', 0),
             ('fire_peek_left', 0, 'peek_left', 0), ('fire_peek_right', 0, 'peek_right', 0), ('fire_peek_crouch_left', 0, 'peek_crouch_left', 0),
             ('fire_peek_crouch_right', 0, 'peek_crouch_right', 0), ('launcher_raise', -1, 'aim_launcher', 0),
             ('launcher_raise_kneel', -1, 'aim_launcher_kneel', 0), ('fire_launcher', 0, 'aim_launcher', 0), ('fire_launcher_kneel', 0, 'aim_launcher_kneel', 0),
             ('reload_stand', 0, 'aim_stand', 0), ('reload_stand', -1, 'aim_stand', 0), ('reload_crouch', 0, 'aim_crouch', 0), ('reload_crouch', -1, 'aim_crouch', 0),
             ('pistol_fire', 0, 'pistol_aim', 0), ('pistol_fire', -1, 'pistol_aim', 0),
             ('atgm_fire', 0, 'atgm_aim', 0), ('atgm_fire', -1, 'atgm_aim', 0), ('atgm_setup', -1, 'atgm_aim', 0), ('atgm_setup_stugna', -1, 'atgm_aim', 0),
             ('atgm_pack', 0, 'atgm_aim', 0), ('atgm_pack_stugna', 0, 'atgm_aim', 0), ('dodge_dive', -1, 'prone_idle', 0), ('dodge_dive_R', -1, 'prone_idle', 0),
             ('dodge_dive_L', -1, 'prone_idle', 0)]
    print('\ntransitions (max local joint angle deg / root m):')
    J = [model.idx[b] for b in BONES if not b.endswith(('Thumb', 'FingerBase', 'Finger1'))]
    for a, fa, b, fb in PAIRS:
        if a not in G['anims'] or b not in G['anims'] or (names and (a not in names and b not in names)):
            continue
        pa, pb = model.pose(a), model.pose(b)
        ang = max(float(qang(pa['lq'][fa, j], pb['lq'][fb, j])) for j in J)
        dr = float(np.linalg.norm(pa['gp'][fa, model.idx['Hips']] - pb['gp'][fb, model.idx['Hips']]))
        bad_t = ang > 2.0 or dr > 0.005
        print(f'  {"FAIL" if bad_t else "OK  "} {a}[{fa}] -> {b}[{fb}]: {ang:.2f} deg, {dr:.4f} m')
        if bad_t:
            next(r for r in res if r['name'] == a)['flags'].append(f'transition to {b} off by {ang:.1f} deg / {dr:.3f} m')
    bad = [r['name'] for r in res if r['flags']]
    print(f'\n{len(res)} clips checked, {len(res) - len(bad)} clean, {len(bad)} flagged: {bad}')
    if js:
        json.dump(res, open(js, 'w'), indent=1, default=float)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
