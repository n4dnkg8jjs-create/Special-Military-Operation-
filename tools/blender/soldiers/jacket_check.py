"""arms_v2: jacket bulk vs kit.  For every preset (standard + assault) the preset's body shell (jacket / trousers) in the lower-torso
zone (bind y 0.80-1.20 m) is skinned with the preset's kit (plate carrier, pouches, groin / arm armour, packs) in rest + poses; a
jacket vertex POKES when a kit face lies behind it - between the jacket surface and the body (ray from the vertex inward along its
posed normal hits kit within 4 cm).  Also reports the jacket stand-off (bind: distance of the shell from the variant's trunk
centre line is not stored, so the zone's mean normal offset vs a reference GLB is printed when --ref is given).
usage: python3 jacket_check.py soldier_xx.glb combos_xx.json [anims.glb] [--quick]"""
import sys, json, numpy as np
sys.path.insert(0, '/tmp/v13s')
import bpy  # noqa (mathutils comes with the bpy module)
from mathutils.bvhtree import BVHTree
from mathutils import Vector
from glb import GLB
from skin import Rig

args = [a for a in sys.argv[1:] if not a.startswith('--')]
glbp, combp = args[0], args[1]
animp = args[2] if len(args) > 2 else '/home/claude/special-military-operation-/assets/soldiers/soldier_anims.glb'
rig = Rig(glbp, animp); g = rig.g
C = json.load(open(combp)); presets = C['combos'] + C['assault_combos']
KIT = ('vest', 'pouches_front', 'pouches_side', 'pouches_back', 'backpack', 'backpack_assault', 'armor_assault', 'pouches_assault',
       'armor_groin', 'armor_arms')
POSES = [(None, 0), ('idle_rifle', .3), ('aim_crouch', .3), ('aim_prone', .3), ('crouch_walk', .4), ('ride_sit_edge', .5),
         ('throw_grenade', .5), ('treat_wounded', .5)]
if '--quick' in sys.argv:
    POSES = POSES[:4]
MATS = {p: rig.joint_mats(*p) if p[0] else rig.joint_mats(None) for p in POSES}


def vnormals(P, T):
    n = np.zeros_like(P)
    f = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    for k in range(3):
        np.add.at(n, T[:, k], f)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


tot = {}
for pr in presets:
    BP, BT, BX = g.mesh(pr['body'])
    armj = [i for i, n in enumerate(rig.jn) if any(n.startswith(sd + b) for sd in ('Left', 'Right') for b in ('Arm', 'ForeArm', 'Hand', 'Elbow', 'Shoulder')) and 'Shoulder' not in n.replace('ShoulderHelper', '')]
    wa = sum((BX['WEIGHTS_0'] * (BX['JOINTS_0'] == j)).sum(1) for j in armj)
    zone = (BP[:, 1] > 0.80) & (BP[:, 1] < 1.20) & (wa < 0.3)          # trunk / hips shell, not the sleeves
    kits = [k for k in pr['parts'] if k in KIT]
    worst = (0, None); cnt = {}
    for pz, M in MATS.items():
        V = rig.skin(BP, BX['JOINTS_0'], BX['WEIGHTS_0'], M)
        N = vnormals(V, BT)
        KP, KT = [], []; o = 0
        for k in kits:
            m = g.mesh(k)
            if m is None:
                continue
            P_, T_, X_ = m
            KP.append(rig.skin(P_, X_['JOINTS_0'], X_['WEIGHTS_0'], M)); KT.append(T_ + o); o += len(P_)
        if not KP:
            continue
        KP = np.concatenate(KP); KT = np.concatenate(KT)
        tree = BVHTree.FromPolygons([tuple(map(float, p)) for p in KP], [tuple(map(int, t)) for t in KT], all_triangles=True)
        n_poke = 0; dmax = 0
        for i in np.nonzero(zone)[0]:
            p = V[i] + N[i] * 0.001
            h = tree.ray_cast(Vector(tuple(p)), Vector(tuple(-N[i])), 0.04)
            if h[0] is not None:
                dep = h[3] - 0.001
                if dep > 0.003:
                    n_poke += 1; dmax = max(dmax, dep)
        cnt[pz[0] or 'rest'] = n_poke
        if dmax > worst[0]:
            worst = (dmax, pz)
    tot[pr['name']] = cnt
    print(f"{pr['name']:16s} {pr['body']} zone {zone.sum():4d} verts | poking (>3 mm) per pose {cnt} | worst depth {worst[0] * 1000:.1f} mm {worst[1]}", flush=True)
s = sum(sum(c.values()) for c in tot.values())
print('TOTAL poking vertex-poses', s)
