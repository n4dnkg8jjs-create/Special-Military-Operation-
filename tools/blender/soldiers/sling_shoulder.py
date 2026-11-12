"""Shoulder carry for the slung rifle (sling v11): assets/soldiers/sling_shoulder.json, read by src/game/soldier.js.

The v9/v10 carry laid the rifle diagonally across the back on a strap worn across the chest.  The owner's order: sling over ONE
shoulder, fixed to the rifle at its two swivels, magazine facing out.  That is the drill position "na remen'": the rifle hangs
muzzle up behind the right shoulder, the strap comes from the front swivel over the top of the shoulder, down in front of it and
back under the arm to the rear swivel; the AK's swivels are on its left side, so its left / top edge lies against the shoulder
blade and the magazine points out and back.

The soldier GLBs cannot be rebuilt here (no body cache), so nothing in them is touched: this tool reads the shipped rest-pose
meshes (numpy + scipy only), and for each faction and back-gear class (bare plate carrier / back pouches / assault pack /
rucksack) writes
  * the rifle socket (Spine1-local position + quaternion; rifle frame: +Z muzzle, +Y up, +X its left side), found by resting
    the rifle on the outermost surface under its footprint
  * a 32 mm webbing strap as a skinned ribbon: guide rays from inside the shoulder (over the top) and from the trunk axis (down
    the side under the arm), each sample pushed out to the outermost surface + 4.5 mm and the whole run pulled taut between the
    swivels; skin weights from the nearest trunk vertices (no arm bones), blended to rigid Spine1 over the last 18 cm at each
    swivel (the slung rifle is rigid with Spine1).
Usage: python3 tools/blender/soldiers/sling_shoulder.py"""
import json, struct, os, re
import numpy as np
from scipy.spatial import cKDTree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
SWIVEL_F = np.array([0.0175, 0.080, 0.422])       # AK-74M swivels in gun space (build_soldier.py / weapons.py)
SWIVEL_R = np.array([0.0233, 0.0535, -0.086])
nz = lambda v: np.asarray(v, float) / np.linalg.norm(v)
ZG = nz([0.04, 0.99, -0.06])                      # muzzle: up, leaning a little to the neck and back
YG = np.array([0.72, 0.0, 0.69]); YG = nz(YG - ZG * YG.dot(ZG))   # the rifle's top: toward the spine and the back -> magazine out and behind
XG = np.cross(YG, ZG)                             # its left side (swivels): against the shoulder blade
RG = np.stack([XG, YG, ZG], 1)
GUN_X, FRONT_Y = -0.125, 1.455                    # the rifle's line behind the right shoulder; height of the front swivel
W, CLEAR = 0.032, 0.0045
CLASSES = (('', ()), ('_pouch', ('pouches_back',)), ('_pack', ('backpack_assault',)), ('_ruck', ('backpack',)))
ARM = re.compile(r'(Arm|ForeArm|Hand|Thumb|Finger|ElbowHelper)')
CT = {5126: ('f', 4), 5123: ('H', 2), 5125: ('I', 4), 5121: ('B', 1)}


def load(path):
    d = open(path, 'rb').read(); n = struct.unpack('<I', d[12:16])[0]; j = json.loads(d[20:20 + n]); b0 = 20 + n + 8

    def acc(i):
        a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]; t, sz = CT[a['componentType']]
        k = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
        off = b0 + bv.get('byteOffset', 0) + a.get('byteOffset', 0); st = bv.get('byteStride', sz * k)
        return np.ndarray((a['count'], k), dtype=np.dtype(t), buffer=d, offset=off, strides=(st, sz)).astype(float)
    N = j['nodes']; jn = [N[i]['name'] for i in j['skins'][0]['joints']]
    par = {c: i for i, nd in enumerate(N) for c in nd.get('children', [])}

    def wpos(i):
        p = np.zeros(3)
        while i is not None:
            p += np.array(N[i].get('translation', [0, 0, 0])); i = par.get(i)
        return p
    spine1 = wpos([i for i, nd in enumerate(N) if nd.get('name') == 'Spine1'][0])
    meshes = {}
    for nd in N:
        if 'mesh' not in nd or nd['name'].endswith('_LOD1'): continue
        P, T, D = [], [], []; off = 0
        for pr in j['meshes'][nd['mesh']]['primitives']:
            at = pr['attributes']; p = acc(at['POSITION']); J = acc(at['JOINTS_0']).astype(int); Wt = acc(at['WEIGHTS_0']) / 255.0
            dn = np.zeros((len(p), len(jn)))
            for a in range(4): np.add.at(dn, (np.arange(len(p)), J[:, a]), Wt[:, a])
            P.append(p); T.append(acc(pr['indices']).astype(int).reshape(-1, 3) + off); D.append(dn); off += len(p)
        meshes[nd['name']] = (np.concatenate(P), np.concatenate(T), np.concatenate(D))
    return meshes, jn, spine1


def hits(o, d, A, E1, E2):
    """all ray / triangle hit distances (Moller-Trumbore, vectorised)"""
    p = np.cross(d, E2); det = (E1 * p).sum(1); ok = np.abs(det) > 1e-12
    inv = np.where(ok, 1.0 / np.where(ok, det, 1), 0); s = o - A
    u = (s * p).sum(1) * inv; q = np.cross(s, E1); v = (q @ d) * inv; t = (E2 * q).sum(1) * inv
    return t[ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-6)]


def qfrom(M):
    t = np.trace(M)
    if t > 0:
        s = np.sqrt(t + 1) * 2; return [(M[2, 1] - M[1, 2]) / s, (M[0, 2] - M[2, 0]) / s, (M[1, 0] - M[0, 1]) / s, s / 4]
    i = int(np.argmax(np.diag(M))); j_, k = (i + 1) % 3, (i + 2) % 3
    s = np.sqrt(1 + M[i, i] - M[j_, j_] - M[k, k]) * 2; q = [0, 0, 0, 0]
    q[i] = s / 4; q[j_] = (M[j_, i] + M[i, j_]) / s; q[k] = (M[k, i] + M[i, k]) / s; q[3] = (M[k, j_] - M[j_, k]) / s
    return q


def build(fac):
    meshes, jn, spine1 = load(os.path.join(ROOT, 'assets/soldiers', f'soldier_{fac}.glb'))
    arm = np.array([bool(ARM.search(n)) for n in jn]); s1 = jn.index('Spine1')
    # a combo_* mesh is one whole preset (uniform, vest, pouches, its back gear): each class rests on the presets that use its socket
    ex = json.load(open(os.path.join(ROOT, 'assets/soldiers/manifest.json')))[f'soldier_{fac}']['node_extras']
    cls_of = {n: (ex.get(n, {}).get('preset', {}).get('sling_socket') or 'weapon_socket_sling') for n in meshes if re.match(r'^(assault_|crew_)?combo_\d+$', n)}
    out = {}
    for suf, extra in CLASSES:
        P, T, D = [], [], []; off = 0
        for n in [n for n in meshes if re.match(r'^body_[ABC]$', n)] + [n for n, c in cls_of.items() if c == 'weapon_socket_sling' + suf]:
            p, t, dn = meshes[n]; keep = (dn[:, arm].sum(1)[t] < 0.35).all(1)       # no sleeves: in the rest pose the arms hang out to the sides
            P.append(p); T.append(t[keep] + off); D.append(dn); off += len(p)
        P = np.concatenate(P); T = np.concatenate(T); D = np.concatenate(D)
        T = T[(P[T][:, :, 1].max(1) > 0.5) & (P[T][:, :, 1].min(1) < 1.8)]
        A = P[T[:, 0]]; E1 = P[T[:, 1]] - A; E2 = P[T[:, 2]] - A
        used = np.unique(T); tree = cKDTree(P[used]); Dn = D[used].copy(); Dn[:, arm] = 0
        sm = Dn.sum(1, keepdims=True); Dn = np.where(sm > 0.2, Dn / np.maximum(sm, 1e-9), np.eye(len(jn))[s1])
        # ---- the rifle: front swivel at FRONT_Y on the line x = GUN_X, pushed forward until its footprint meets the surface
        P0 = np.array([GUN_X, FRONT_Y, 0.0]) - RG @ SWIVEL_F; P0[2] = 0
        gy, gz = np.meshgrid(np.linspace(-0.03, 0.11, 5), np.linspace(-0.25, 0.45, 15))
        foot = np.concatenate([np.stack([np.full(gy.size, 0.035), gy.ravel(), gz.ravel()], 1),
                               np.stack([np.tile(np.linspace(-0.02, 0.035, 3), 15), np.full(45, 0.11), np.repeat(np.linspace(-0.25, 0.45, 15), 3)], 1)])
        zmax = 1e9
        for q in foot @ RG.T:
            h = hits(np.array([P0[0] + q[0], P0[1] + q[1], -1.0]), np.array([0, 0, 1.0]), A, E1, E2)
            if len(h): zmax = min(zmax, -1.0 + h.min() - q[2])
        P0[2] = zmax - 0.005
        Fw = P0 + RG @ SWIVEL_F; Rw = P0 + RG @ SWIVEL_R
        # ---- guide rays: over the shoulder (phi from behind, over the top, to the front), then down the side under the arm
        rays = []
        oA = np.array([-0.135, 1.37, -0.01])
        for ph in np.radians(np.linspace(168, 8, 26)):
            rays.append((oA, nz([-0.09, np.sin(ph), np.cos(ph)]), 0.40))
        for u in np.linspace(0, 1, 26):
            y = 1.345 + (Rw[1] + 0.02 - 1.345) * u; th = np.radians(22 + 146 * u ** 0.85)
            rays.append((np.array([-0.07, y, 0.0]), np.array([-np.sin(th), 0, np.cos(th)]), 0.27 if u < 0.8 else 0.5))
        rs = []
        for o, d, tm in rays:
            h = hits(o, d, A, E1, E2); h = h[h < tm]
            rs.append((h.max() if len(h) else 0.03) + CLEAR)
        rs = np.array(rs); r = rs.copy()
        O = np.array([o for o, _, _ in rays]); Dr = np.array([d for _, d, _ in rays])
        pt = lambda i: Fw if i < 0 else Rw if i >= len(r) else O[i] + Dr[i] * r[i]
        for it in range(400):                                         # pull taut: each sample onto the chord of its neighbours, never under the surface
            for i in range(len(r)):
                a, b = pt(i - 1), pt(i + 1); e = b - a; w0 = O[i] - a
                aa, bb, cc, dd, ee = Dr[i].dot(Dr[i]), Dr[i].dot(e), e.dot(e), Dr[i].dot(w0), e.dot(w0)
                den = aa * cc - bb * bb
                rc = (bb * ee - cc * dd) / den if abs(den) > 1e-9 else r[i]
                r[i] = max(rs[i], rc)
        C = np.array([Fw] + [pt(i) for i in range(len(r))] + [Rw]); Nn = np.array([Dr[0]] + list(Dr) + [Dr[-1]])
        # resample evenly (12 mm) so the ribbon bends smoothly, normals carried along
        seg = np.linalg.norm(np.diff(C, axis=0), axis=1); s = np.concatenate([[0], np.cumsum(seg)]); L = s[-1]
        ss = np.linspace(0, L, int(L / 0.012) + 1)
        Cr = np.stack([np.interp(ss, s, C[:, k]) for k in range(3)], 1); Nr = np.stack([np.interp(ss, s, Nn[:, k]) for k in range(3)], 1)
        tg = np.gradient(Cr, axis=0); tg /= np.linalg.norm(tg, axis=1, keepdims=True)
        Nr -= tg * (Nr * tg).sum(1, keepdims=True); Nr /= np.linalg.norm(Nr, axis=1, keepdims=True)
        Sd = np.cross(tg, Nr)
        # at the swivels the strap's face lies along the gun's side (its width across the gun's height)
        for k in range(len(ss)):
            e = min(ss[k], L - ss[k]); f = np.clip(1 - e / 0.07, 0, 1)
            if f > 0:
                sg = YG * np.sign(Sd[k].dot(YG) or 1); v = Sd[k] * (1 - f) + sg * f; v -= tg[k] * v.dot(tg[k]); Sd[k] = nz(v); Nr[k] = np.cross(Sd[k], tg[k])
        pos = np.empty((len(ss) * 2, 3)); pos[0::2] = Cr - Sd * W / 2; pos[1::2] = Cr + Sd * W / 2
        nrm = np.repeat(Nr, 2, 0); uv = np.stack([np.tile([0.0, 1.0], len(ss)), np.repeat(ss / W, 2)], 1)
        idx = []
        for k in range(len(ss) - 1):
            a = 2 * k; idx += [a, a + 1, a + 2, a + 1, a + 3, a + 2]
        # skin: nearest trunk vertices, rigid Spine1 toward the swivels
        dist, ni = tree.query(Cr, k=3); ww = 1 / np.maximum(dist, 1e-4) ** 2; ww /= ww.sum(1, keepdims=True)
        Wd = (Dn[ni] * ww[:, :, None]).sum(1)
        e = np.minimum(ss, L - ss); f = np.clip(e / 0.18, 0, 1); f = f * f * (3 - 2 * f)
        Wd = Wd * f[:, None]; Wd[:, s1] += 1 - f
        top = np.argsort(-Wd, 1)[:, :4]; tw = np.take_along_axis(Wd, top, 1); tw /= tw.sum(1, keepdims=True)
        out['weapon_socket_sling' + suf] = {
            'p': np.round(P0 - spine1, 4).tolist(), 'q': np.round(qfrom(RG), 5).tolist(), 'out': np.round(RG.T @ np.array([0, 0, -1.0]), 4).tolist(),
            'pos': np.round(pos, 4).ravel().tolist(), 'nrm': np.round(nrm, 3).ravel().tolist(), 'uv': np.round(uv, 3).ravel().tolist(), 'idx': idx,
            'ji': np.repeat(top, 2, 0).ravel().tolist(), 'jw': np.round(np.repeat(tw, 2, 0), 3).ravel().tolist()}
        print(f'  {fac} sling{suf or "_bare":6s} rifle origin {np.round(P0, 3)}  muzzle y {P0[1] + ZG[1] * 0.62:.2f} butt y {P0[1] - ZG[1] * 0.34:.2f}  strap {L:.2f} m, {len(ss)} rows, lift over surface max {(r - rs).max() * 100:.1f} cm')
    return {'bones': jn, 'classes': out}


res = {f.upper(): build(f) for f in ('ua', 'ru')}
res['note'] = 'sling v11 (tools/blender/soldiers/sling_shoulder.py): rifle socket (Spine1-local p, q) + skinned strap per back-gear class; ji = indices into bones'
p = os.path.join(ROOT, 'assets/soldiers/sling_shoulder.json')
json.dump(res, open(p, 'w'), separators=(',', ':'))
print('wrote', p, os.path.getsize(p) // 1024, 'KB')
