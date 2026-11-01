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


PAD = 5          # gutter around every chart (px) - keeps mip levels from bleeding between charts
SWC = 16         # solid-colour swatch cell size (px)
PADT = 8         # wrap padding around tiling-camo regions
TCELL = 2        # tiling-camo region = TCELL x TCELL repeats of the tile
# tile region size (px) per tiling material: one 0.5 m repeat. 1024 = the per-part material's own resolution
TILE_PX = {'emr_gear': 640, 'multicam_gear': 640, 'mm14_gear': 640, 'coyote_webbing': 192, 'ranger_gear': 192}
# texel-density targets (scale relative to each source texture, before the global fit multiplier)
SRC_SCALE = {'camo': 1.0, 'multicam': 0.8, 'skin_': 0.5, 'hands_skin': 0.7, 'eye': 0.5}
GEAR_PX_PER_M = 1229.0   # = uniform texel density at 2048^2 (0.81 mm/texel)


def _src_scale(m):
    if 'multicam' in m and 'camo' in m:
        return SRC_SCALE['multicam']
    if 'camo' in m:
        return SRC_SCALE['camo']
    for k, v in SRC_SCALE.items():
        if m.startswith(k):
            return v
    return 0.5


def _uv_islands(uv, tri):
    """connected components over (uv-split) vertices -> per-vertex label, {label: (min, max)}"""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    n = len(uv)
    r = np.r_[tri[:, 0], tri[:, 1], tri[:, 2]]; c = np.r_[tri[:, 1], tri[:, 2], tri[:, 0]]
    _, lab = connected_components(coo_matrix((np.ones(len(r)), (r, c)), shape=(n, n)), directed=False)
    used = np.unique(tri)
    isl = {}
    for l in np.unique(lab[used]):
        vs = used[lab[used] == l]
        isl[int(l)] = (uv[vs].min(0), uv[vs].max(0))
    return lab, isl


def _uv_area(uv, tri):
    U = uv[tri]; e1 = U[:, 1] - U[:, 0]; e2 = U[:, 2] - U[:, 0]
    return float(np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]).sum() / 2)


def _bilinear_clamp(img, x, y):
    """bilinear sample at pixel coords (x, y) (texel centres at integers), clamped at the borders"""
    h, w = img.shape[:2]
    x = np.clip(x, 0, w - 1); y = np.clip(y, 0, h - 1)
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int)
    x1 = np.minimum(x0 + 1, w - 1); y1 = np.minimum(y0 + 1, h - 1)
    fx = (x - x0)[:, None]; fy = (y - y0)[:, None]
    return img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy) + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy


def _blender_pack(uvs, tris, margin, reserve=None):
    """pack the UV islands of all (uv, tri) sets together into [0,1]^2 (concave shapes, 90-degree rotations),
    keeping their relative scale.  reserve=(w, h) px: a fixed block kept free in the bottom-right corner."""
    import bpy
    offs = np.cumsum([0] + [len(u) for u in uvs])
    V = np.concatenate(uvs).astype(np.float64); T = np.concatenate([t + o for t, o in zip(tris, offs[:-1])]).astype(np.int64)
    nres = 0
    if reserve is not None:
        # a dummy island (rectangle) that is scaled with everything; replaced by the fixed swatch block afterwards
        w, h = reserve[0] / S, reserve[1] / S
        base_i = len(V)
        V = np.concatenate([V, np.array([[0, 0], [w, 0], [w, h], [0, h]]) * 1.6])
        T = np.concatenate([T, np.array([[0, 1, 2], [0, 2, 3]]) + base_i]); nres = 4
    bl.clear()
    me = bpy.data.meshes.new('pack')
    me.vertices.add(len(V)); me.vertices.foreach_set('co', np.c_[V, np.zeros(len(V))].astype(np.float32).ravel())
    me.loops.add(len(T) * 3); me.loops.foreach_set('vertex_index', T.ravel().astype(np.int32))
    me.polygons.add(len(T)); me.polygons.foreach_set('loop_start', np.arange(0, len(T) * 3, 3, dtype=np.int32))
    me.polygons.foreach_set('loop_total', np.full(len(T), 3, np.int32))
    me.update()
    lay = me.uv_layers.new(name='UVMap'); lay.data.foreach_set('uv', V[T.ravel()].astype(np.float32).ravel())
    ob = bpy.data.objects.new('pack', me); bpy.context.scene.collection.objects.link(ob)
    bl.activate(ob)
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(udim_source='CLOSEST_UDIM', rotate=True, rotate_method='CARDINAL', scale=True, merge_overlap=False,
                            margin_method='FRACTION', margin=margin, shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')
    luv = np.zeros(len(T) * 3 * 2, np.float32); me.uv_layers.active.data.foreach_get('uv', luv); luv = luv.reshape(-1, 2)
    out = np.zeros((len(V), 2)); out[T.ravel()] = luv
    if nres:
        # move the reserved dummy so its corner sits in the bottom-right of the atlas (the packer put it somewhere);
        # simplest robust approach: re-check it is the dummy's space that is free -> we only use its packed position
        r = out[-4:]
        out = out[:-4]
        _blender_pack.reserved = (r.min(0), r.max(0))
    return [out[o0:o1] for o0, o1 in zip(offs[:-1], offs[1:])]


def _clip_poly(poly, axis, k, keep_less):
    """Sutherland-Hodgman against the line suv[axis] = k. poly: list of attribute vectors; suv at SUV_COL"""
    out = []
    n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i + 1) % n]
        da = a[SUV_COL + axis] - k; db = b[SUV_COL + axis] - k
        ina = da <= 1e-9 if keep_less else da >= -1e-9
        inb = db <= 1e-9 if keep_less else db >= -1e-9
        if ina:
            out.append(a)
        if ina != inb:
            t = da / (da - db)
            out.append(a + (b - a) * t)
    return out


SUV_COL = 0


def _split_tiles(gparts, node_idx, tile_idx):
    """gparts: [(node, mat, prim)] with prim uv = tiling coordinates.  Returns de-indexed-and-rewelded gear mesh whose
    triangles each lie in one tile cell; 'loc' = position inside the cell (0..1), vmat = tile material index."""
    rows = []; tris_cell = []; fn = []; fm = []
    n_in = 0
    for n, m, p in gparts:
        col = p['color'] if p.get('color') is not None else np.ones((len(p['pos']), 3))
        # per connected component: shift by whole tiles (pattern unchanged) so it starts in the first repeat; with a
        # TCELL x TCELL-repeat region almost every component then fits without being cut
        suv = np.asarray(p['uv'], np.float64).copy()
        lab, isl = _uv_islands(p['uv'], p['idx'])
        for l, (lo, hi) in isl.items():
            suv[lab == l] -= np.floor(lo)
        V = np.concatenate([suv / TCELL, p['pos'], p['nrm'], col, p['W']], 1).astype(np.float64)
        T = p['idx'].reshape(-1, 3); n_in += len(T)
        U = V[:, :2][T]
        eps = 1e-7
        c0 = np.floor(U.min(1) + eps); c1 = np.floor(U.max(1) - eps)
        simple = np.all(c0 == c1, 1)
        for t in np.where(simple)[0]:
            rows.append(V[T[t]]); tris_cell.append(c0[t]); fn.append(node_idx[n]); fm.append(tile_idx[m])
        for t in np.where(~simple)[0]:
            pieces = [[V[i] for i in T[t]]]
            for axis in (0, 1):
                lo, hi = int(c0[t, axis]), int(c1[t, axis])
                nxt = []
                for poly in pieces:
                    cur = poly
                    for k in range(lo + 1, hi + 1):
                        left = _clip_poly(cur, axis, k, True)
                        if len(left) >= 3:
                            nxt.append(left)
                        cur = _clip_poly(cur, axis, k, False)
                        if len(cur) < 3:
                            break
                    if len(cur) >= 3:
                        nxt.append(cur)
                pieces = nxt
            for poly in pieces:
                P = np.array(poly)
                cell = np.floor(P[:, :2].mean(0))
                for j in range(1, len(P) - 1):
                    rows.append(np.stack([P[0], P[j], P[j + 1]])); tris_cell.append(cell); fn.append(node_idx[n]); fm.append(tile_idx[m])
    R = np.stack(rows)                     # (nt, 3, cols)
    cell = np.array(tris_cell)             # (nt, 2)
    nt = len(R)
    flat = R.reshape(nt * 3, -1)
    loc = flat[:, :2] - np.repeat(cell, 3, 0)
    vmat = np.repeat(np.array(fm), 3)
    # re-weld identical corners (same attributes, same cell, same material)
    key = np.concatenate([np.round(flat[:, 2:9], 6), np.round(loc, 6), vmat[:, None]], 1)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    v = flat[first]
    nb = v.shape[1] - 11
    W = np.clip(v[:, 11:], 0, None); W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
    return dict(pos=v[:, 2:5], nrm=v[:, 5:8], col=v[:, 8:11], W=W, suv=v[:, :2], loc=loc[first], vmat=vmat[first],
                tri=inv.reshape(-1, 3), nid=np.array(fn), mid=np.array(fm), n_in=n_in)


def _uvkey(uv):
    import hashlib
    return hashlib.md5(np.ascontiguousarray(uv, np.float32).tobytes()).hexdigest()


def _shelf(sizes, W=S, H=S):
    """shelf packing (tallest first). sizes: [(w, h)] -> [(x, y)] or None"""
    order = sorted(range(len(sizes)), key=lambda i: (-sizes[i][1], -sizes[i][0]))
    pos = [None] * len(sizes)
    x = y = sh = 0
    for i in order:
        w, h = sizes[i]
        if w > W:
            return None
        if x + w > W:
            y += sh; x = 0; sh = 0
        if y + h > H:
            return None
        pos[i] = (x, y); x += w; sh = max(sh, h)
    return pos


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


_FIB = None
_HEAD_AO_CACHE = {}
HEAD_AO_STRENGTH = 1.1


def _fib_dirs(n=192):
    global _FIB
    if _FIB is None or len(_FIB) != n:
        i = np.arange(n) + 0.5
        phi = np.arccos(1 - 2 * i / n); th = np.pi * (1 + 5 ** 0.5) * i
        _FIB = np.stack([np.cos(th) * np.sin(phi), np.cos(phi), np.sin(th) * np.sin(phi)], 1)
    return _FIB


def headgear_ao(P, N, occ_prims, dist=0.28):
    """per-vertex ambient-occlusion multiplier (0.3..1) of head / face / balaclava / eye vertices under the preset's helmet and
    headset: sky-weighted cosine hemisphere (the overcast sky above dominates the ambient light; the ground bounce below is weak)
    ray cast against the headgear only, so the face under the brim, the brow, temples and ears darken; the chin stays lit"""
    from mathutils.bvhtree import BVHTree
    from mathutils import Vector
    OP = np.concatenate([p['pos'] for p in occ_prims]); OT = []
    off = 0
    for p in occ_prims:
        OT.append(np.asarray(p['idx']).reshape(-1, 3) + off); off += len(p['pos'])
    OT = np.concatenate(OT)
    tree = BVHTree.FromPolygons([tuple(v) for v in OP], [tuple(map(int, t)) for t in OT], all_triangles=True)
    D = _fib_dirs()
    sky = np.where(D[:, 1] > 0, 0.25 + 0.75 * D[:, 1] ** 1.2, 0.15)       # radiance weight per direction (zenith brightest)
    lo, hi = OP.min(0) - dist, OP.max(0) + dist
    out = np.ones(len(P))
    for i in range(len(P)):
        v = P[i]
        if np.any(v < lo) or np.any(v > hi):
            continue
        n = N[i] / max(np.linalg.norm(N[i]), 1e-9)
        cs = D @ n
        sel = cs > 0.02
        w = cs[sel] * sky[sel]
        o = Vector(v + n * 0.0015)
        hit = np.zeros(int(sel.sum()))
        for k, d in enumerate(D[sel]):
            h = tree.ray_cast(o, Vector(d), dist)
            if h[0] is not None:
                hit[k] = 1.0 - 0.35 * (h[3] / dist)
        occ = float((w * hit).sum() / max(w.sum(), 1e-9))
        out[i] = 1.0 - HEAD_AO_STRENGTH * occ
    return np.clip(out, 0.28, 1.0)


def _is_headgear(n):
    return n.startswith('helmet') or n == 'headset'


def _ao_receiver(m):
    return m.startswith('skin_') or m.startswith('balaclava') or m == 'eye'


def make(W, rec, fac, presets, tape_mat='tape', bal_masks=None, vest_masks=None, log=print, head_ao=True):
    """presets: list of dict(name=..., parts=[node names], **descr).  Returns manifest list.
    bal_masks / vest_masks: per body variant, True = keep triangle (head under a balaclava / uniform under the plate carrier)"""
    g = W.g
    bal_masks = bal_masks or {}
    vest_masks = vest_masks or {}
    used = sorted({n for p in presets for n in p['parts'] if n in rec.nodes})
    # ---------------------------------------------------------------- classify materials
    mats = set()
    for n in used:
        for p in rec.nodes[n]:
            mats.add(rec.mat_name(p['mat']))
    place = sorted(m for m in mats if m not in TILE_MATS and m != tape_mat and rec.specs[m]['base'] is not None)
    tile = sorted(m for m in mats if m in TILE_MATS)
    solid = sorted(m for m in mats if m not in TILE_MATS and m != tape_mat and rec.specs[m]['base'] is None)
    base = np.zeros((S, S, 3), np.float32); nrm = np.zeros((S, S, 3), np.float32); nrm[..., 2] = 1.0
    orm = np.zeros((S, S, 3), np.float32); orm[..., 0] = 1.0; orm[..., 1] = 0.9
    occ = np.zeros((S, S), bool)
    # ---------------------------------------------------------------- textured charts: UV islands of every textured material
    uvsets = {}      # (mat, uvkey) -> dict(uv, tri, lab, isl)
    for n in used:
        for p in rec.nodes[n]:
            m = rec.mat_name(p['mat'])
            if m in place:
                k = (m, _uvkey(p['uv']))
                if k not in uvsets:
                    lab, isl = _uv_islands(p['uv'], p['idx'])
                    uvsets[k] = dict(uv=p['uv'], tri=p['idx'], lab=lab, isl=isl)
    # ---------------------------------------------------------------- gear (tiling camo): cut triangles at tile borders
    # every gear triangle then lies inside one repeat of its tiling texture, so all gear of one material maps into a
    # single wrap-padded copy of that tile in the atlas -> identical camo at the identical scale, minimal atlas space
    gparts = []
    tile_idx = {m: i for i, m in enumerate(tile)}
    node_idx = {n: i for i, n in enumerate(used)}
    for n in used:
        for p in rec.nodes[n]:
            m = rec.mat_name(p['mat'])
            if m in TILE_MATS:
                gparts.append((n, m, p))
    gear = None
    if gparts:
        gear = _split_tiles(gparts, node_idx, tile_idx)
        log(f'gear tris {gear["n_in"]} -> {len(gear["tri"])} after tile split')
    # ---------------------------------------------------------------- pack every chart with Blender's concave packer
    # pre-pack coordinates = atlas px at density multiplier 1, / S.  Islands may only turn by 90 deg steps.
    pk_uv, pk_tri, pk_src = [], [], []
    for key, d in uvsets.items():
        m = key[0]; K1 = rec.specs[m]['base'].shape[1] * _src_scale(m)
        pk_uv.append(d['uv'] * K1 / S); pk_tri.append(d['tri']); pk_src.append(('tex', key, K1))
    quad = lambda w, h: (np.array([[0, 0], [w, 0], [w, h], [0, h]], float) / S, np.array([[0, 1, 2], [0, 2, 3]]))
    for m in tile:
        K1 = TILE_PX.get(m, 512) * TCELL
        u_, t_ = quad(K1 + 2 * PADT, K1 + 2 * PADT)
        pk_uv.append(u_); pk_tri.append(t_); pk_src.append(('tile', m, K1))
    nsw = len(solid)
    if nsw:
        cols = 8; rows = int(np.ceil(nsw / cols))
        u_, t_ = quad(cols * SWC + 2 * PAD, rows * SWC + 2 * PAD)
        pk_uv.append(u_); pk_tri.append(t_); pk_src.append(('swatch', None, None))
    packed = _blender_pack(pk_uv, pk_tri, margin=2.0 * PAD / S)
    a_pre = sum(_uv_area(u, t) for u, t in zip(pk_uv, pk_tri)); a_post = sum(_uv_area(u, t) for u, t in zip(packed, pk_tri))
    mul = float(np.sqrt(a_post / a_pre))
    log(f'atlas {fac}: density multiplier {mul:.3f} -> uniform texel {0.81 / mul / SRC_SCALE["camo"]:.2f} mm '
        f'(EMR/MM-14 pixel = {1000 * __import__("camo").EMR_PIXEL_M * mul * SRC_SCALE["camo"] / 0.81:.1f}/{6.0 * mul * SRC_SCALE["camo"] / 0.81:.1f} texels; gear tile '
        f'{0.5 / (TILE_PX["emr_gear"] * mul) * 1000:.2f} mm/texel)')
    ROT = [np.array([[1, 0], [0, 1.0]]), np.array([[0, -1], [1, 0.0]]), np.array([[-1, 0], [0, -1.0]]), np.array([[0, 1], [-1, 0.0]])]
    place_xf = {}     # (mat, uvkey) -> {isl: (K, R, T)}
    tile_rect = {}    # mat -> (x, y, K)  (content origin inside the wrap padding, tile size)
    sw = {}
    filled = np.zeros((S, S), bool)
    for (kind, key, K1), u_pre, newuv, tri in zip(pk_src, pk_uv, packed, pk_tri):
        if kind == 'tile':
            lo_ = np.floor(newuv.min(0) * S).astype(int)
            K = int(np.floor((newuv.max(0) - newuv.min(0)).min() * S)) - 2 * PADT
            tile_rect[key] = (lo_[0] + PADT, lo_[1] + PADT, K)
            continue
        if kind == 'swatch':
            lo_ = newuv.min(0) * S + PAD; hi_ = newuv.max(0) * S - PAD
            bw, bh = hi_ - lo_
            cols = int(np.ceil(np.sqrt(nsw * bw / max(bh, 1)))); rows = int(np.ceil(nsw / cols))
            cell = int(min(bw / cols, bh / rows))
            for k, m in enumerate(solid):
                cx, cy = int(lo_[0]) + (k % cols) * cell, int(lo_[1]) + (k // cols) * cell
                sp = rec.specs[m]
                base[cy:cy + cell, cx:cx + cell] = sp['color'][None, None]
                orm[cy:cy + cell, cx:cx + cell, 1] = sp['rough']; orm[cy:cy + cell, cx:cx + cell, 2] = sp['metal']
                filled[cy:cy + cell, cx:cx + cell] = True
                sw[m] = ((cx + cell / 2) / S, (cy + cell / 2) / S)
            continue
        d = uvsets[key]; m = key[0]
        K = int(round(K1 * mul))
        A = d['uv'] * K; B = newuv * S
        xf = {}
        for l in d['isl']:
            vs = d['lab'] == l
            Al, Bl = A[vs], B[vs]
            best = None
            for ri, Rm in enumerate(ROT):
                RA = Al @ Rm.T
                Tt = (Bl - RA).mean(0)
                e = np.abs(Bl - RA - Tt).max()
                if best is None or e < best[0]:
                    best = (e, ri, Tt)
            e, ri, Tt = best
            xf[l] = (K, ROT[ri], np.round(Tt))
        place_xf[key] = xf
        uvA = np.zeros_like(d['uv'], dtype=np.float64)
        for l, (K_, Rm, Tt) in xf.items():
            vs = d['lab'] == l
            uvA[vs] = ((d['uv'][vs] * K_) @ Rm.T + Tt) / S
        d['uvA'] = uvA; d['K'] = K
    # ---------------------------------------------------------------- tile regions (wrap padded)
    for m, (x, y, K) in tile_rect.items():
        sp = rec.specs[m]
        kt = K // TCELL; K = kt * TCELL; tile_rect[m] = (x, y, K)
        b = lin2srgb(srgb2lin(_resize(sp['base'], kt, kt)) * srgb2lin(sp['color'])[None, None])
        b = np.pad(np.tile(b, (TCELL, TCELL, 1)), ((PADT, PADT), (PADT, PADT), (0, 0)), mode='wrap')
        base[y - PADT:y + K + PADT, x - PADT:x + K + PADT] = b
        if sp['nrm'] is not None:
            n_ = np.pad(np.tile(_resize(sp['nrm'], kt, kt) * 2 - 1, (TCELL, TCELL, 1)), ((PADT, PADT), (PADT, PADT), (0, 0)), mode='wrap')
            nrm[y - PADT:y + K + PADT, x - PADT:x + K + PADT] = n_
        orm[y - PADT:y + K + PADT, x - PADT:x + K + PADT, 1] = sp['rough']
        orm[y - PADT:y + K + PADT, x - PADT:x + K + PADT, 2] = sp['metal']
        filled[y - PADT:y + K + PADT, x - PADT:x + K + PADT] = True
    if gear is not None:
        uvA = np.zeros((len(gear['pos']), 2))
        for m, i in tile_idx.items():
            x, y, K = tile_rect[m]
            vs = gear['vmat'] == i
            uvA[vs, 0] = (x + np.clip(gear['loc'][vs, 0], 0, 1) * K) / S
            uvA[vs, 1] = (y + np.clip(gear['loc'][vs, 1], 0, 1) * K) / S
        gear['uv'] = uvA
    # ---------------------------------------------------------------- rasterise the texture islands into the atlas
    pres = {}
    def prescaled(m, K):
        if (m, K) not in pres:
            sp = rec.specs[m]
            b = lin2srgb(srgb2lin(_resize(sp['base'], K, K)) * srgb2lin(sp['color'])[None, None])
            n_ = (_resize(sp['nrm'], K, K) * 2 - 1) if sp['nrm'] is not None else None
            pres[(m, K)] = (b, n_)
        return pres[(m, K)]

    def raster(At, emit):
        """At: (nt,3,2) atlas px coords; emit(t, bary (n,3), px (n,2))"""
        for t in range(len(At)):
            a = At[t]
            x0, y0 = np.floor(a.min(0) - 1).astype(int); x1, y1 = np.ceil(a.max(0) + 1).astype(int)
            x0 = max(x0, 0); y0 = max(y0, 0); x1 = min(x1, S - 1); y1 = min(y1, S - 1)
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
            eps = 0.75 / max(np.sqrt(abs(den)), 1.0)
            ins = (l0 >= -eps) & (l1 >= -eps) & (l2 >= -eps)
            if not ins.any():
                continue
            emit(t, np.stack([l0, l1, l2], 1)[ins], (q[ins] - 0.5).astype(int))

    for key, d in uvsets.items():
        m = key[0]; sp = rec.specs[m]
        b, n_ = prescaled(m, d['K'])
        tri = d['tri']; Sx = d['uv'][tri] * d['K']; At = d['uvA'][tri] * S
        xfR = {l: v[1] for l, v in place_xf[key].items()}
        tlab = d['lab'][tri[:, 0]]
        def emit(t, L, px, Sx=Sx, b=b, n_=n_, sp=sp, xfR=xfR, tlab=tlab):
            sx = L @ Sx[t]
            base[px[:, 1], px[:, 0]] = _bilinear_clamp(b, sx[:, 0] - 0.5, sx[:, 1] - 0.5)
            if n_ is not None:
                ns = _bilinear_clamp(n_, sx[:, 0] - 0.5, sx[:, 1] - 0.5)
                # island turned by a multiple of 90 deg: turn the tangent-space xy with it (+x = +u, +y = -v)
                Rm = xfR[tlab[t]]
                xy = np.stack([ns[:, 0], -ns[:, 1]], 1) @ Rm.T
                nrm[px[:, 1], px[:, 0]] = np.stack([xy[:, 0], -xy[:, 1], ns[:, 2]], 1)
            orm[px[:, 1], px[:, 0], 1] = sp['rough']; orm[px[:, 1], px[:, 0], 2] = sp['metal']
            filled[px[:, 1], px[:, 0]] = True
        raster(At, emit)
    # dilate all charts into their gutters (edge texels repeated) so mip levels do not bleed
    f = filled.copy()
    for _ in range(PAD + 3):
        nf = f.copy()
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            sf = np.roll(f, (dy, dx), (0, 1))
            take = sf & ~nf
            for arr in (base, nrm, orm):
                arr[take] = np.roll(arr, (dy, dx), (0, 1))[take]
            nf |= take
        f = nf
    log('atlas fill', round(float(filled.mean()), 3), 'with gutters', round(float(f.mean()), 3))
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
        occ_nodes = tuple(n for n in parts if _is_headgear(n))
        occ_prims = [p for n in occ_nodes for p in rec.nodes[n]] if head_ao else []
        for n in parts:
            for pi_, p in enumerate(rec.nodes[n]):
                m = rec.mat_name(p['mat'])
                if m in TILE_MATS:
                    continue
                pos, idx = p['pos'], p['idx']
                col = p['color'] if p.get('color') is not None else np.ones((len(pos), 3))
                if occ_prims and _ao_receiver(m):
                    # helmet occlusion baked into this preset's vertex colours (helmets differ per preset)
                    ck = (fac, occ_nodes, n, pi_, len(pos))
                    if ck not in _HEAD_AO_CACHE:
                        _HEAD_AO_CACHE[ck] = headgear_ao(pos, p['nrm'], occ_prims)
                        log(f'head AO {pr["name"]} {n}/{m}: min {_HEAD_AO_CACHE[ck].min():.2f} mean {_HEAD_AO_CACHE[ck].mean():.2f}')
                    col = col * _HEAD_AO_CACHE[ck][:, None]
                if m == tape_mat:
                    Pt.append(pos); Nt_.append(p['nrm']); Ut_.append(p['uv']); It.append(idx + o2); Wt.append(p['W']); Ct.append(col); o2 += len(pos)
                    tm = p['mat']
                    continue
                if m.startswith('skin_') and bal:
                    mk = bal_masks.get(bal[0][-1])
                    if mk is not None and len(mk) == len(idx):
                        idx = idx[~mk]
                if m.endswith('_camo') and 'vest' in parts and n.startswith('body_'):
                    mk = vest_masks.get(n[-1])          # uniform triangles hidden under the vest are dropped from the preset
                    if mk is not None and len(mk) == len(idx):
                        idx = idx[mk]
                if m in place:
                    uv = uvsets[(m, _uvkey(p['uv']))]['uvA']
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
