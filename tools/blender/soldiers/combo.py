"""Pre-combined soldier presets: one SkinnedMesh + one material (2048^2 atlas: base colour / normal / ORM) per preset,
plus a small `<name>_tape` mesh with the recolourable `tape` material.  Target: 2 draw calls per soldier.

Usage inside build_soldier.build():
    rec = combo.Recorder(W)            # before writing any material / mesh
    ... write the per-part nodes as usual ...
    combo.make(W, rec, fac, presets)   # before W.emit_lods()
Atlas layout (px, 2048^2): uniform camo(s) in the top half, gear charts (re-unwrapped, baked from the tiling camo
textures) bottom-left 1024^2, heads 3 x 512^2, hands, eyes and solid-colour swatches bottom-right."""
import numpy as np
from PIL import Image
import bl

S = 2048
TILE_MATS = {'emr_gear', 'multicam_gear', 'coyote_webbing', 'mm14_gear', 'ranger_gear'}
GEAR_RECT = (0, 1024, 1024, 1024)


def srgb2lin(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin2srgb(c):
    c = np.clip(np.asarray(c, float), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def _f(img):
    a = np.asarray(img)
    return a.astype(np.float32) / 255.0 if a.dtype == np.uint8 else a.astype(np.float32)


def _resize(a, w, h):
    a8 = (np.clip(_f(a), 0, 1) * 255 + 0.5).astype(np.uint8)
    return _f(np.asarray(Image.fromarray(a8).resize((w, h), Image.LANCZOS)))


class Recorder:
    """intercepts GLB.image / GLB.material / SoldierWriter.skinned so every node's source prims and material specs
    (texture arrays, colour, roughness, metallic) are available for baking"""
    def __init__(self, W):
        self.W = W; g = W.g
        self.imgs = {}; self.specs = {}; self.nodes = {}; self.extras = {}
        oi, om, os_ = g.image, g.material, W.skinned

        def image(img, fmt='JPEG', quality=88, key=None):
            ti = oi(img, fmt, quality, key)
            if isinstance(img, np.ndarray):
                self.imgs[ti] = img
            return ti

        def material(name, color=(0.5, 0.5, 0.5, 1), metallic=0.0, roughness=0.8, base_tex=None, normal_tex=None, **kw):
            mi = om(name, color=color, metallic=metallic, roughness=roughness, base_tex=base_tex, normal_tex=normal_tex, **kw)
            if name not in self.specs:
                self.specs[name] = dict(color=np.asarray(color, float)[:3], metal=metallic, rough=roughness,
                                        base=self.imgs.get(base_tex), nrm=self.imgs.get(normal_tex), double=kw.get('double', False))
            return mi

        def skinned(name, prims, extras=None, lod=None):
            if not name.endswith('_LOD1'):
                self.nodes[name] = [dict(p) for p in prims]
                self.extras[name] = extras
            return os_(name, prims, extras=extras, lod=lod)
        g.image = image; g.material = material; W.skinned = skinned

    def mat_name(self, mi):
        return self.W.g.g['materials'][mi]['name']


def _layout(place):
    """rects for directly-placed textures (uniforms, heads, hands, eye)"""
    rects = {}
    uni = sorted(n for n in place if 'camo' in n)
    if len(uni) == 1:
        rects[uni[0]] = (0, 0, 2048, 1024)
    else:
        for k, n in enumerate(uni[:2]):
            rects[n] = (k * 1024, 0, 1024, 1024)
    for n, r in zip(sorted(n for n in place if n.startswith('skin_')), [(1024, 1024, 512, 512), (1536, 1024, 512, 512), (1024, 1536, 512, 512)]):
        rects[n] = r
    if 'hands_skin' in place:
        rects['hands_skin'] = (1536, 1536, 256, 256)
    if 'eye' in place:
        rects['eye'] = (1792, 1536, 128, 128)
    return rects


SW0 = (1536, 1792); SWC = 16   # swatch area origin, cell size


def _bilinear(img, u, v):
    """wrapped bilinear sample, uv in [0,1) repeating (glTF orientation: v down = image rows)"""
    h, w = img.shape[:2]
    x = (u % 1.0) * w - 0.5; y = (v % 1.0) * h - 0.5
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int)
    fx = (x - x0)[:, None]; fy = (y - y0)[:, None]
    x0 %= w; y0 %= h; x1 = (x0 + 1) % w; y1 = (y0 + 1) % h
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy) + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)


def _tbn(P, UV):
    """per-triangle tangent (dP/du) and glTF bitangent (-dP/dv)"""
    e1 = P[:, 1] - P[:, 0]; e2 = P[:, 2] - P[:, 0]
    d1 = UV[:, 1] - UV[:, 0]; d2 = UV[:, 2] - UV[:, 0]
    det = d1[:, 0] * d2[:, 1] - d2[:, 0] * d1[:, 1]
    det = np.where(np.abs(det) < 1e-12, 1e-12, det)
    T = (e1 * d2[:, 1:2] - e2 * d1[:, 1:2]) / det[:, None]
    B = (e2 * d1[:, 0:1] - e1 * d2[:, 0:1]) / det[:, None]
    N = np.cross(e1, e2); N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
    T = T - N * np.einsum('ij,ij->i', T, N)[:, None]; T /= np.maximum(np.linalg.norm(T, axis=1, keepdims=True), 1e-12)
    B = B - N * np.einsum('ij,ij->i', B, N)[:, None]; B /= np.maximum(np.linalg.norm(B, axis=1, keepdims=True), 1e-12)
    return T, -B, N


def make(W, rec, fac, presets, tape_mat='tape', bal_masks=None, log=print):
    """presets: list of dict(name=..., parts=[node names], **descr).  Returns manifest list."""
    g = W.g
    bal_masks = bal_masks or {}
    used = sorted({n for p in presets for n in p['parts'] if n in rec.nodes})
    # ---------------------------------------------------------------- classify materials
    mats = set()
    for n in used:
        for p in rec.nodes[n]:
            mats.add(rec.mat_name(p['mat']))
    place = [m for m in mats if m not in TILE_MATS and m != tape_mat and rec.specs[m]['base'] is not None]
    tile = [m for m in mats if m in TILE_MATS]
    solid = sorted(m for m in mats if m not in TILE_MATS and m != tape_mat and rec.specs[m]['base'] is None)
    rects = _layout(place)
    base = np.zeros((S, S, 3), np.float32); nrm = np.zeros((S, S, 3), np.float32); nrm[..., 2] = 1.0
    orm = np.zeros((S, S, 3), np.float32); orm[..., 0] = 1.0; orm[..., 1] = 0.9
    def fill(rect, b, n, rough, metal):
        x, y, w, h = rect
        base[y:y + h, x:x + w] = b; nrm[y:y + h, x:x + w] = n; orm[y:y + h, x:x + w, 1] = rough; orm[y:y + h, x:x + w, 2] = metal
    for m, r in rects.items():
        sp = rec.specs[m]
        b = lin2srgb(srgb2lin(_resize(sp['base'], r[2], r[3])) * srgb2lin(sp['color'])[None, None])
        n = (_resize(sp['nrm'], r[2], r[3]) * 2 - 1) if sp['nrm'] is not None else np.array([0, 0, 1.0])[None, None]
        fill(r, b, n, sp['rough'], sp['metal'])
    sw = {}
    for k, m in enumerate(solid):
        cx, cy = SW0[0] + (k % 32) * SWC, SW0[1] + (k // 32) * SWC
        sp = rec.specs[m]
        fill((cx, cy, SWC, SWC), sp['color'][None, None], np.array([0, 0, 1.0])[None, None], sp['rough'], sp['metal'])
        sw[m] = ((cx + SWC / 2) / S, (cy + SWC / 2) / S)
    # ---------------------------------------------------------------- gear charts: re-unwrap + bake tiling camo
    tp_pos, tp_tri, tp_suv, tp_W, tp_col, tp_nrm, tp_node, tp_mat = [], [], [], [], [], [], [], []
    off = 0
    tile_idx = {m: i for i, m in enumerate(tile)}
    node_idx = {n: i for i, n in enumerate(used)}
    for n in used:
        for p in rec.nodes[n]:
            m = rec.mat_name(p['mat'])
            if m not in TILE_MATS:
                continue
            tp_pos.append(p['pos']); tp_tri.append(p['idx'] + off); tp_suv.append(p['uv']); tp_W.append(p['W'])
            tp_col.append(p['color'] if p.get('color') is not None else np.ones((len(p['pos']), 3)))
            tp_nrm.append(p['nrm']); tp_node.append(np.full(len(p['idx']), node_idx[n])); tp_mat.append(np.full(len(p['idx']), tile_idx[m]))
            off += len(p['pos'])
    gear = None
    if tp_pos:
        P = np.concatenate(tp_pos); T = np.concatenate(tp_tri)
        bl.clear()
        ob = bl.make_obj('gear_atlas', P, T, attrs={'suv': np.concatenate(tp_suv), 'Wt': np.concatenate(tp_W), 'col': np.concatenate(tp_col),
                                                      'on': np.concatenate(tp_nrm)},
                         face_attrs={'nid': np.concatenate(tp_node), 'mid': np.concatenate(tp_mat)})
        bl.smart_uv(ob, 60, 0.004)
        mm = bl.extract(ob, attrs=('suv', 'Wt', 'col', 'on'), split_normals=False)
        me = ob.data
        nid = np.zeros(len(me.polygons), np.int32); me.attributes['nid'].data.foreach_get('value', nid)
        mid = np.zeros(len(me.polygons), np.int32); me.attributes['mid'].data.foreach_get('value', mid)
        gx, gy, gw, gh = GEAR_RECT
        uvA = np.stack([(gx + mm['uv'][:, 0] * gw) / S, (gy + mm['uv'][:, 1] * gh) / S], 1)
        gear = dict(pos=mm['pos'], nrm=mm['on'], uv=uvA, tri=mm['tri'], W=mm['Wt'], col=mm['col'], suv=mm['suv'],
                    nid=nid[mm['poly']], mid=mid[mm['poly']])
        # rasterise
        filled = np.zeros((gh, gw), bool)
        Pt = gear['pos'][gear['tri']]; Ut = gear['suv'][gear['tri']]; At = gear['uv'][gear['tri']] * S - [gx, gy]
        Ts, Bs, Ns = _tbn(Pt, Ut); Tt, Bt, Nt = _tbn(Pt, gear['uv'][gear['tri']])
        texs = {m: (_f(rec.specs[m]['base']), _f(rec.specs[m]['nrm']) * 2 - 1 if rec.specs[m]['nrm'] is not None else None,
                    srgb2lin(rec.specs[m]['color'])) for m in tile}
        for t in range(len(Pt)):
            a = At[t]
            x0, y0 = np.floor(a.min(0) - 1).astype(int); x1, y1 = np.ceil(a.max(0) + 1).astype(int)
            x0 = max(x0, 0); y0 = max(y0, 0); x1 = min(x1, gw - 1); y1 = min(y1, gh - 1)
            if x1 < x0 or y1 < y0:
                continue
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            q = np.stack([xs.ravel(), ys.ravel()], 1)
            v0 = a[1] - a[0]; v1 = a[2] - a[0]; v2 = q - a[0]
            den = v0[0] * v1[1] - v1[0] * v0[1]
            if abs(den) < 1e-9:
                continue
            l1 = (v2[:, 0] * v1[1] - v1[0] * v2[:, 1]) / den
            l2 = (v0[0] * v2[:, 1] - v2[:, 0] * v0[1]) / den
            l0 = 1 - l1 - l2
            eps = 0.6 / max(np.sqrt(abs(den)), 1.0)
            ins = (l0 >= -eps) & (l1 >= -eps) & (l2 >= -eps)
            if not ins.any():
                continue
            L = np.stack([l0, l1, l2], 1)[ins]
            suv = L @ Ut[t]
            m = tile[gear['mid'][t]]
            alb, nm, fac_lin = texs[m]
            c = lin2srgb(srgb2lin(_bilinear(alb, suv[:, 0], suv[:, 1])) * fac_lin[None])
            px = (q[ins] - 0.5).astype(int)
            base[gy + px[:, 1], gx + px[:, 0]] = c
            if nm is not None:
                ns = _bilinear(nm, suv[:, 0], suv[:, 1])
                no = ns[:, :1] * Ts[t] + ns[:, 1:2] * Bs[t] + ns[:, 2:3] * Ns[t]
                nt = np.stack([no @ Tt[t], no @ Bt[t], no @ Nt[t]], 1)
                nt /= np.maximum(np.linalg.norm(nt, axis=1, keepdims=True), 1e-9)
                nrm[gy + px[:, 1], gx + px[:, 0]] = nt
            orm[gy + px[:, 1], gx + px[:, 0], 1] = rec.specs[m]['rough']
            orm[gy + px[:, 1], gx + px[:, 0], 2] = rec.specs[m]['metal']
            filled[px[:, 1], px[:, 0]] = True
        # dilate charts into the gutters
        sub_b = base[gy:gy + gh, gx:gx + gw]; sub_n = nrm[gy:gy + gh, gx:gx + gw]; sub_o = orm[gy:gy + gh, gx:gx + gw]
        f = filled.copy()
        for _ in range(6):
            nf = f.copy()
            for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                sf = np.roll(f, (dy, dx), (0, 1))
                take = sf & ~nf
                for arr in (sub_b, sub_n, sub_o):
                    arr[take] = np.roll(arr, (dy, dx), (0, 1))[take]
                nf |= take
            f = nf
        log('gear atlas tris', len(gear['tri']), 'fill', round(float(filled.mean()), 3))
    # ---------------------------------------------------------------- atlas material
    nrm8 = ((np.clip(nrm, -1, 1) * 0.5 + 0.5) * 255 + 0.5).astype(np.uint8)
    am = g.material(f'soldier_atlas_{fac}', color=(1, 1, 1, 1), roughness=1.0, metallic=1.0,
                    base_tex=g.image((np.clip(base, 0, 1) * 255 + 0.5).astype(np.uint8), 'JPEG', quality=90, key=f'atlas_b_{fac}'),
                    normal_tex=g.image(nrm8, 'PNG', key=f'atlas_n_{fac}'),
                    orm_tex=g.image((np.clip(orm, 0, 1) * 255 + 0.5).astype(np.uint8), 'PNG', key=f'atlas_o_{fac}'),
                    double=True, extras={'atlas': True, 'layout': 'top: uniform camo; bottom-left: gear charts; bottom-right: heads, hands, eyes, swatches'})
    tm = None
    out_manifest = []
    # ---------------------------------------------------------------- per-preset meshes
    for pr in presets:
        parts = [n for n in pr['parts'] if n in rec.nodes]
        Ps, Ns, Us, Is, Ws, Cs = [], [], [], [], [], []
        Pt, Nt_, Ut_, It, Wt, Ct = [], [], [], [], [], []
        o1 = 0; o2 = 0
        bal = [n for n in parts if n.startswith('balaclava_')]
        for n in parts:
            for p in rec.nodes[n]:
                m = rec.mat_name(p['mat'])
                if m in TILE_MATS:
                    continue
                pos, idx = p['pos'], p['idx']
                col = p['color'] if p.get('color') is not None else np.ones((len(pos), 3))
                if m == tape_mat:
                    Pt.append(pos); Nt_.append(p['nrm']); Ut_.append(p['uv']); It.append(idx + o2); Wt.append(p['W']); Ct.append(col); o2 += len(pos)
                    tm = p['mat']
                    continue
                if m.startswith('skin_') and bal:
                    mk = bal_masks.get(bal[0][-1])
                    if mk is not None and len(mk) == len(idx):
                        idx = idx[~mk]
                if m in rects:
                    x, y, w, h = rects[m]
                    uv = np.clip(p['uv'], 0.5 / w, 1 - 0.5 / w)
                    uv = np.stack([(x + uv[:, 0] * w) / S, (y + uv[:, 1] * h) / S], 1)
                else:
                    uv = np.tile(np.array(sw[m])[None], (len(pos), 1))
                Ps.append(pos); Ns.append(p['nrm']); Us.append(uv); Is.append(idx + o1); Ws.append(p['W']); Cs.append(col); o1 += len(pos)
        if gear is not None:
            sel = np.isin(gear['nid'], [node_idx[n] for n in parts if n in node_idx])
            T = gear['tri'][sel]
            vs = np.unique(T); remap = -np.ones(len(gear['pos']), int); remap[vs] = np.arange(len(vs))
            Ps.append(gear['pos'][vs]); Ns.append(gear['nrm'][vs]); Us.append(gear['uv'][vs]); Is.append(remap[T] + o1)
            Ws.append(gear['W'][vs]); Cs.append(gear['col'][vs]); o1 += len(vs)
        prim = dict(pos=np.concatenate(Ps), nrm=np.concatenate(Ns), uv=np.concatenate(Us), idx=np.concatenate(Is), mat=am,
                    W=np.concatenate(Ws), color=np.clip(np.concatenate(Cs), 0, 1))
        ex = dict(combo=True, default_visible=False, preset={k: v for k, v in pr.items() if k != 'parts'}, parts=parts)
        W.skinned(pr['name'], [prim], extras=ex, lod=0.28)
        tris = len(prim['idx'])
        ttris = 0
        if Pt:
            tprim = dict(pos=np.concatenate(Pt), nrm=np.concatenate(Nt_), uv=np.concatenate(Ut_), idx=np.concatenate(It), mat=tm,
                         W=np.concatenate(Wt), color=np.clip(np.concatenate(Ct), 0, 1))
            W.skinned(pr['name'] + '_tape', [tprim], extras=dict(combo=True, default_visible=False, tape=True), lod=0.4)
            ttris = len(tprim['idx'])
        d = {k: v for k, v in pr.items()}
        d.update(tris=tris, tape_tris=ttris, nodes=[pr['name'], pr['name'] + '_tape'], lod1=[pr['name'] + '_LOD1', pr['name'] + '_tape_LOD1'])
        out_manifest.append(d)
        log('combo', pr['name'], tris, ttris)
    return out_manifest, dict(base=base, nrm=nrm, orm=orm)
