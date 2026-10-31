"""Write soldier GLBs (skeleton + skinned body variants + gear + sockets) from cached stage data."""
import numpy as np
from scipy.spatial import cKDTree
import gltfw, mhbody as M, meshutil as MU
from qmath import qnorm


def top4(W):
    return M.top4(np.asarray(W, np.float32))[:2]


def eye_uv(pos):
    c = pos.mean(0)
    r = np.max(np.linalg.norm(pos - c, axis=1))
    return np.stack([0.5 + (pos[:, 0] - c[0]) / (2 * r), 0.5 - (pos[:, 1] - c[1]) / (2 * r)], 1)


class SoldierWriter:
    def __init__(self, skel, name='soldier'):
        self.g = gltfw.GLB()
        self.sk = skel
        self.root = self.g.node(name)
        self.nodes = {}
        for i, n in enumerate(skel.names):
            p = skel.parent[i]
            self.nodes[n] = self.g.node(n, parent=self.root if p < 0 else self.nodes[skel.names[p]], t=skel.offset[i])
        ibm = []
        for i in range(skel.n):
            m = np.eye(4); m[:3, 3] = -skel.head[i]; ibm.append(m.T.reshape(-1))
        self.skin = self.g.skin('soldier_skeleton', [self.nodes[n] for n in skel.names], ibm, skeleton=self.nodes['Hips'])
        self.lods = []
        self.tris = {}

    def emit_lods(self):
        """decimated copies of every skinned node registered with lod= (weights/uv/colour carried as attributes)"""
        import bl
        for name, prims, ratio, extras in self.lods:
            out = []
            for p in prims:
                W = p['W'] if 'W' in p else None
                attrs = {'uvv': p['uv'] if p.get('uv') is not None else np.zeros((len(p['pos']), 2))}
                if W is not None:
                    attrs['W'] = W
                if p.get('color') is not None:
                    attrs['col'] = p['color']
                bl.clear()
                ob = bl.make_obj('lod', p['pos'], p['idx'], attrs=attrs)
                if len(p['idx']) > 60:
                    bl.decimate(ob, ratio)
                m = bl.extract(ob, attrs=tuple(attrs.keys()), split_normals=False)
                q = dict(pos=m['pos'], nrm=MU.weld_normals(m['pos'], MU.vertex_normals(m['pos'], m['tri']), 1e-5), uv=m['uvv'], idx=m['tri'], mat=p['mat'])
                if W is not None:
                    q['W'] = np.clip(m['W'], 0, None)
                if p.get('color') is not None:
                    q['color'] = np.clip(m['col'], 0, 1)
                out.append(q)
            ex = dict(extras or {}); ex['lod'] = 1
            self.skinned(name + '_LOD1', out, extras=ex)

    def skinned(self, name, prims, extras=None, lod=None):
        """prims: list of dict(pos,nrm,uv,idx,mat,W(dense n x nb) or joints/weights).  lod: ratio -> adds <name>_LOD1"""
        if lod:
            self.lods.append((name, [dict(p) for p in prims], lod, extras))
        out = []
        for p in prims:
            q = dict(p)
            if 'W' in q:
                j, w = top4(q.pop('W'))
                q['joints'] = j; q['weights'] = w
            out.append(q)
        mesh = self.g.mesh(name, out)
        self.tris[name] = int(sum(len(p['idx']) for p in out))
        return self.g.node(name, parent=self.root, mesh=mesh, skin=self.skin, extras=extras)

    def rigid_W(self, n, bone, weights=None):
        W = np.zeros((n, self.sk.n), np.float32)
        if weights is None:
            W[:, self.sk.idx[bone]] = 1
        return W

    def socket(self, name, bone, t, r=(0, 0, 0, 1)):
        return self.g.node(name, parent=self.nodes[bone], t=np.asarray(t, float), r=np.asarray(r, float))

    def save(self, path):
        self.g.save(path)


def nearest_weights(points, ref_pos, ref_W, k=4, bones_allowed=None, bone_idx=None):
    tree = cKDTree(ref_pos)
    d, nn = tree.query(points, k=k)
    w = 1 / np.maximum(d, 1e-4)
    W = np.einsum('nk,nkb->nb', w, ref_W[nn]) / w.sum(1, keepdims=True)
    if bones_allowed is not None:
        mask = np.zeros(W.shape[1], bool)
        for b in bones_allowed:
            mask[bone_idx[b]] = True
        W = W * mask
        s = W.sum(1, keepdims=True)
        W = np.where(s > 1e-6, W / np.maximum(s, 1e-9), 0)
    return W


# ---------------------------------------------------------------- materials
import camo as C
import tex as TX
from scipy import ndimage

_TILES = {}


def _tile(name):
    if name in _TILES:
        return _TILES[name]
    res = 1024
    h = C.cordura_tile(res)
    if name == 'emr':
        a = C.emr_tile(res)
    elif name == 'multicam':
        a = C.multicam_tile(res)
    elif name == 'coyote':
        a = C.solid_tile(res, C.COYOTE)
    elif name == 'ranger':
        a = C.solid_tile(res, C.RANGER_GREEN)
    elif name == 'mm14':
        a = C.mm14_tile(res)
    hb = ndimage.gaussian_filter(h, 2, mode='wrap')
    a = a * (1 + (h - hb)[..., None] * 0.25) * (0.93 + 0.07 * np.clip(hb, -1, 1)[..., None])
    n = TX.height_to_normal(h, 0.35)
    _TILES[name] = (np.clip(a, 0, 1), n)
    return _TILES[name]


SOLIDS = {
    'gear_hardware': ('#1d1d1b', 0.55, 0.0), 'ak_mag_polymer': ('#2a2322', 0.45, 0.0), 'radio_black': ('#232423', 0.5, 0.0),
    'medic_red': ('#8c2421', 0.7, 0.0), 'flag_white': ('#d8d8d2', 0.7, 0.0), 'flag_blue': ('#1f4f97', 0.7, 0.0),
    'flag_red': ('#a82a2a', 0.7, 0.0), 'flag_yellow': ('#e3bf1c', 0.7, 0.0),
    'tape': None, 'tape_red': ('#b01e1e', 0.32, 0.0), 'goggle_lens': ('#1b2026', 0.08, 0.3),
    'helmet_hardware': ('#262624', 0.5, 0.2), 'boot_sole': ('#151514', 0.9, 0.0),
    'kneepad_shell': ('#2b2c28', 0.55, 0.0),
    'altyn_steel': ('#4d5240', 0.45, 0.25), 'balaclava_ru': ('#2a2b26', 0.95, 0.0), 'balaclava_ua': ('#4a4a3b', 0.95, 0.0),
}


class Mats:
    def __init__(self, g, fac):
        self.g = g; self.fac = fac; self.m = {}

    def __call__(self, name):
        if name in self.m:
            return self.m[name]
        g = self.g
        if name in ('emr_gear', 'multicam_gear', 'coyote_webbing', 'mm14_gear', 'ranger_gear'):
            t = {'emr_gear': 'emr', 'multicam_gear': 'multicam', 'coyote_webbing': 'coyote', 'mm14_gear': 'mm14', 'ranger_gear': 'ranger'}[name]
            a, n = _tile(t)
            col = (1, 1, 1, 1) if name == 'emr_gear' else (0.5, 0.5, 0.5, 1)     # EMR gear: factor 1 like the EMR uniform (see build_soldier)
            i = g.material(name, color=col, base_tex=g.image(a, key='a_' + t), normal_tex=g.image(n, 'PNG', key='n_' + t), roughness=0.93, normal_scale=0.8)
        elif name == 'tape':
            col = '#e9e9e4' if self.fac == 'ru' else '#e8c31c'
            i = g.material('tape', color=TX.hexc(col).tolist() + [1], roughness=0.32, extras={'recolourable': True})
        else:
            col, rough, met = SOLIDS[name]
            i = g.material(name, color=TX.hexc(col).tolist() + [1], roughness=rough, metallic=met)
        self.m[name] = i
        return i
