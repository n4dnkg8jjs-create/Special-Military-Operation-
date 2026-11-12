"""New camouflage for the Ukrainian soldier, patched into the shipped soldier_ua.glb (numpy / scipy / PIL only: the model
cannot be rebuilt here). Replaces three base-colour images:
  mm14_camo           (body_A / body_B uniform atlas, 2048 px = 1.8 m of cloth)
  mm14_multicam_camo  (body_C uniform atlas, same layout)
  multicam_gear       (vest / pouches / packs: a 1024 px tile = 0.6 m, wraps)
What was wrong (owner: 'needs much better textures'): the MM14 was a blurred green woodland with 8-9 mm blocks; the Multicam
uniform was tan with a rash of small dark dots and no green in it.
  MM-14 ('pixel', ZSU 2014): a light pattern - sand-beige and pale khaki-green grounds, olive and brown mid-size clusters,
  few near-black pixels - of ~5 mm square pixels with ragged cluster edges and stray single pixels.
  MultiCam: no hard-edged grounds at all - tan, pale green and darker green melt into each other in soft gradients a hand or
  two across; over that, crisp medium-brown shapes stretched one way, and small crisp dark-brown and cream flecks.
The uniform atlases have the garment's shading baked in (folds, pocket flaps, under-collar shadow): its broad part is taken
from the old image (its luminance, heavily blurred, relative to the mean) and laid over the new pattern, so the cloth keeps its
form; the fine relief is the untouched normal map's. Deterministic (fixed seeds). Idempotent only in the sense that a second
run would take its shading from the new image: run it on the original file (git checkout) when tuning.

run:  python3 tools/blender/soldiers/camo_tex.py [--preview dir] [--dry]"""
import os, sys, io, json, struct
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
HERE = os.path.dirname(os.path.abspath(__file__))
GLB = os.path.join(HERE, '../../../assets/soldiers/soldier_ua.glb')


def lattice(shape, scale, seed, tile=False):
    """smooth value noise 0..1, features ~`scale` px across (scale may be (sy, sx))"""
    sy, sx = (scale, scale) if np.isscalar(scale) else scale
    H, W = shape; gh, gw = max(2, int(round(H / sy))), max(2, int(round(W / sx)))
    r = np.random.default_rng(seed).random((gh, gw))
    if tile:
        out = ndi.zoom(r, (H / gh, W / gw), order=3, mode='grid-wrap', grid_mode=True)
    else:
        out = ndi.zoom(np.pad(r, 2, mode='reflect'), (H / gh, W / gw), order=3)[int(2 * H / gh):, int(2 * W / gw):]
    return out[:H, :W]


def fbm(shape, scale, seed, octaves=4, tile=False, gain=0.5):
    out = np.zeros(shape); amp, tot = 1.0, 0.0
    sy, sx = (scale, scale) if np.isscalar(scale) else scale
    for o in range(octaves):
        out += amp * lattice(shape, (max(1.5, sy / 2 ** o), max(1.5, sx / 2 ** o)), seed * 131 + o * 17, tile); tot += amp; amp *= gain
    out /= tot
    return (out - out.min()) / (out.max() - out.min())


def rank(a):
    """values -> their quantile (0..1): thresholds below are then shares of the area"""
    flat = a.ravel(); r = np.empty(flat.size); r[np.argsort(flat, kind='stable')] = np.linspace(0, 1, flat.size)
    return r.reshape(a.shape)


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def mm14(N=2048, cell=6, seed=14):
    n = N // cell + 1; S = (n, n)
    A = rank(0.62 * fbm(S, 13, seed + 1, 3) + 0.28 * fbm(S, 4.5, seed + 2, 2) + 0.10 * np.random.default_rng(seed + 3).random(S))
    Bm = rank(0.55 * fbm(S, 9, seed + 4, 3) + 0.30 * fbm(S, 3.5, seed + 5, 2) + 0.15 * np.random.default_rng(seed + 6).random(S))
    C = rank(0.5 * fbm(S, 5, seed + 7, 2) + 0.5 * np.random.default_rng(seed + 8).random(S))
    PAL = np.array([[189, 180, 146], [156, 157, 116], [118, 119, 84], [96, 87, 64], [50, 52, 43]], float)   # sand, pale khaki-green, olive, brown, near black
    idx = np.where(A < 0.30, 0, np.where(A < 0.66, 1, 2))
    idx = np.where(Bm > 0.86, 3, idx)                                   # brown clusters
    idx = np.where((C > 0.935) & ((A > 0.5) | (Bm > 0.8)), 4, idx)      # dark pixels, in and beside the darker ground
    idx = np.where((C < 0.03) & (idx >= 2), 0, idx)                     # a few light pixels strayed into the dark
    yy, xx = np.mgrid[0:N, 0:N] // cell
    img = PAL[idx[yy, xx]]
    return img * 0.84 * (1 + (np.random.default_rng(seed + 9).random((N, N, 1)) - 0.5) * 0.05)   # (0.84: worn, dusty cloth - the clean print's sand goes chalk-white in sunlight)


def multicam(N=2048, k=1.0, seed=37, tile=False):
    """k = pattern scale (px per px of the 0.88 mm uniform atlas)"""
    S = (N, N); f = lambda sc, sd, o=4: fbm(S, (sc[0] * k, sc[1] * k) if not np.isscalar(sc) else sc * k, seed + sd, o, tile)
    TAN, PALE, LG, DG, BR, DB, CR = [np.array(c, float) for c in ([183, 165, 126], [203, 190, 153], [141, 143, 100], [92, 101, 69], [112, 90, 64], [61, 48, 37], [222, 212, 179])]
    g1, g2, g3 = rank(f(190, 1, 3)), rank(f(120, 2, 3)), rank(f(150, 3, 3))
    img = TAN + (PALE - TAN) * sstep(0.62, 0.9, g3)[..., None]
    gm = sstep(0.42, 0.66, g1)[..., None]; img = img + (LG - img) * gm * 0.92
    img = img + (DG - img) * (sstep(0.60, 0.78, g2)[..., None] * gm * 0.85)
    edge = lambda r, t, w=0.006: sstep(t - w, t + w, r)[..., None]
    br = rank(0.7 * f((46, 100), 4, 3) + 0.3 * f((18, 40), 5, 2)); img = img + (BR - img) * edge(br, 0.868) * 0.95
    near = sstep(0.55, 0.8, rank(f(90, 6, 2)))[..., None]             # the flecks keep to parts of the cloth, they are not an even rash
    db = rank(f((15, 26), 7, 2)); img = img + (DB - img) * edge(db, 0.962, 0.004) * near
    cr = rank(f((13, 24), 8, 2)); img = img + (CR - img) * edge(cr, 0.966, 0.004) * (1 - 0.6 * near)
    return img * 0.86 * (1 + (np.random.default_rng(seed + 9).random((N, N, 1)) - 0.5) * 0.04)


def shading(old, strength=0.6):
    lum = old[..., :3].astype(float) @ np.array([0.299, 0.587, 0.114])
    bg = np.bincount((lum.astype(int)).ravel()).argmax()               # the flat fill between the islands
    m = np.abs(lum - bg) > 3
    lo = ndi.gaussian_filter(np.where(m, lum, 0), 22) / np.maximum(ndi.gaussian_filter(m.astype(float), 22), 1e-3)
    s = lo / np.median(lo[m])
    s = np.where(ndi.gaussian_filter(m.astype(float), 22) > 0.08, s, 1.0)      # (no shading out between the islands: it would bleed in at the lower mips)
    return np.clip(1 + strength * (s - 1), 0.6, 1.25)[..., None]


CT = {5126: ('<f4', 4), 5123: ('<u2', 2), 5125: ('<u4', 4), 5121: ('u1', 1), 5122: ('<i2', 2), 5120: ('i1', 1)}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def accessor(J, B, i):
    a = J['accessors'][i]; bv = J['bufferViews'][a['bufferView']]; dt, sz = CT[a['componentType']]; n = NC[a['type']]
    st = bv.get('byteStride', 0); off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    if st and st != sz * n:
        arr = np.frombuffer(B, dtype='u1', count=st * a['count'], offset=off).reshape(a['count'], st)[:, :sz * n].copy().view(dt).reshape(a['count'], n)
    else:
        arr = np.frombuffer(B, dtype=dt, count=a['count'] * n, offset=off).reshape(a['count'], n)
    arr = arr.astype(np.float64)
    if a.get('normalized'):
        arr /= {5123: 65535, 5121: 255, 5122: 32767, 5120: 127}[a['componentType']]
    return arr


def sample(img, uv):
    """bilinear, wrapping (the gear tile repeats)"""
    H, W = img.shape[:2]; x = (uv[:, 0] % 1.0) * W - 0.5; y = (uv[:, 1] % 1.0) * H - 0.5
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int); fx = (x - x0)[:, None]; fy = (y - y0)[:, None]
    g = lambda yy, xx: img[yy % H, xx % W]
    return (g(y0, x0) * (1 - fx) + g(y0, x0 + 1) * fx) * (1 - fy) + (g(y0 + 1, x0) * (1 - fx) + g(y0 + 1, x0 + 1) * fx) * fy


def rebake(J, B, atlas_img, atlas_mat, src):
    """The game draws merged outfit meshes with one combined atlas (soldier_atlas_ua / _crew_ua), packed from the parts'
    textures. Every atlas triangle is found again in its part (same three vertex positions) - that gives the part's UVs for it -
    and the cloth is drawn into the atlas afresh from the new images. src: {material name: new image}."""
    mats = [m['name'] for m in J['materials']]; key = lambda P: tuple(sorted(map(tuple, np.round(P, 4))))
    tri_src = {}
    for me in J['meshes']:
        for p in me['primitives']:
            mn = mats[p['material']]
            if mn not in src or 'TEXCOORD_0' not in p['attributes']:
                continue
            P = accessor(J, B, p['attributes']['POSITION']); UV = accessor(J, B, p['attributes']['TEXCOORD_0']); idx = accessor(J, B, p['indices']).astype(int).reshape(-1, 3)
            for t in idx:
                tri_src.setdefault(key(P[t]), (mn, {tuple(np.round(P[v], 4)): UV[v] for v in t}))
    H, W = atlas_img.shape[:2]; out = atlas_img.astype(float).copy(); cover = np.zeros((H, W), bool); other = np.zeros((H, W), bool); seen = set(); n = 0
    for me in J['meshes']:
        for p in me['primitives']:
            if mats[p['material']] != atlas_mat:
                continue
            P = accessor(J, B, p['attributes']['POSITION']); UV = accessor(J, B, p['attributes']['TEXCOORD_0']); idx = accessor(J, B, p['indices']).astype(int).reshape(-1, 3)
            for t in idx:
                a = UV[t] * [W, H]; k2 = tuple(np.round(a, 2).ravel())
                if k2 in seen:
                    continue
                seen.add(k2)
                x0, y0 = np.floor(a.min(0) - 1).astype(int); x1, y1 = np.ceil(a.max(0) + 1).astype(int)
                x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, W - 1), min(y1, H - 1)
                if x1 < x0 or y1 < y0:
                    continue
                yy, xx = np.mgrid[y0:y1 + 1, x0:x1 + 1]; px = np.stack([xx.ravel() + 0.5, yy.ravel() + 0.5], 1)
                e0, e1 = a[1] - a[0], a[2] - a[0]; den = e0[0] * e1[1] - e0[1] * e1[0]
                if abs(den) < 1e-9:
                    continue
                d = px - a[0]; b1 = (d[:, 0] * e1[1] - d[:, 1] * e1[0]) / den; b2 = (e0[0] * d[:, 1] - e0[1] * d[:, 0]) / den; b0 = 1 - b1 - b2
                eps = 0.75 / max(np.sqrt(abs(den)), 1e-6)                # (three quarters of a texel past the edges: no seam lines)
                m = (b0 > -eps) & (b1 > -eps) & (b2 > -eps)
                if not m.any():
                    continue
                s = tri_src.get(key(P[t]))
                if s is None:
                    other[yy.ravel()[m], xx.ravel()[m]] = True; continue
                uvs = np.array([s[1][tuple(np.round(P[v], 4))] for v in t])
                uv = b0[m, None] * uvs[0] + b1[m, None] * uvs[1] + b2[m, None] * uvs[2]
                out[yy.ravel()[m], xx.ravel()[m]] = sample(src[s[0]], uv); cover[yy.ravel()[m], xx.ravel()[m]] = True; n += 1
    # padding round the redrawn islands (where no other part's texels are): nearest redrawn texel, 4 px out
    dist, ind = ndi.distance_transform_edt(~cover, return_indices=True)
    pad = (~cover) & (~other) & (dist <= 4)
    out[pad] = out[ind[0][pad], ind[1][pad]]
    print('  atlas', atlas_mat, (W, H), 'triangles redrawn', n, 'texels', int(cover.sum()), f'({cover.mean() * 100:.0f} %)')
    return out


def main():
    args = sys.argv[1:]; dry = '--dry' in args; prev = args[args.index('--preview') + 1] if '--preview' in args else None
    d = open(GLB, 'rb').read(); jl = struct.unpack('<I', d[12:16])[0]; J = json.loads(d[20:20 + jl]); B = d[20 + jl + 8:]
    def image_of(mat):
        m = next(x for x in J['materials'] if x['name'] == mat); t = J['textures'][m['pbrMetallicRoughness']['baseColorTexture']['index']]
        return t.get('source', t.get('extensions', {}).get('EXT_texture_webp', {}).get('source'))
    def old(i):
        bv = J['bufferViews'][J['images'][i]['bufferView']]; o = bv.get('byteOffset', 0)
        return np.asarray(Image.open(io.BytesIO(B[o:o + bv['byteLength']])).convert('RGB'))
    new = {}
    i = image_of('mm14_camo'); o = old(i); new[i] = mm14(o.shape[0]) * shading(o)
    # the third uniform is a mixed issue - MultiCam jacket over MM-14 trousers: every island of its atlas keeps the pattern it had
    # (the old MultiCam was tan / red-brown, the old MM-14 green)
    i = image_of('mm14_multicam_camo'); o = old(i); lum = o.astype(float) @ np.array([0.299, 0.587, 0.114])
    m = np.abs(lum - np.bincount(lum.astype(int).ravel()).argmax()) > 3
    gmr = ndi.gaussian_filter(np.where(m, o[..., 1].astype(float) - o[..., 0], 0), 12) / np.maximum(ndi.gaussian_filter(m.astype(float), 12), 1e-3)
    green = ndi.binary_opening(ndi.binary_closing(gmr > -6.5, iterations=6), iterations=6)      # (G - R: about -12 on the old MultiCam, -2..+3 on the old MM-14)
    new[i] = np.where(green[..., None], mm14(o.shape[0]), multicam(o.shape[0])) * shading(o)
    print('  mixed uniform: MM-14 share of the cloth', round(float(green[m].mean()), 2))
    i = image_of('multicam_gear'); o = old(i); new[i] = multicam(o.shape[0], k=1.5, seed=71, tile=True)
    # the combined atlases the outfits are drawn with
    src = {'mm14_camo': new[image_of('mm14_camo')], 'mm14_multicam_camo': new[image_of('mm14_multicam_camo')], 'multicam_gear': new[image_of('multicam_gear')]}
    for am in ('soldier_atlas_ua', 'soldier_atlas_crew_ua'):
        if any(m['name'] == am for m in J['materials']):
            i = image_of(am); new[i] = rebake(J, B, old(i), am, src)
    users = {}
    for t in J['textures']:
        s = t.get('source', t.get('extensions', {}).get('EXT_texture_webp', {}).get('source')); users[s] = users.get(s, 0) + 1
    data = {}
    for i, img in new.items():
        im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
        if prev:
            os.makedirs(prev, exist_ok=True); im.save(os.path.join(prev, f'image_{i}.png'))
        buf = io.BytesIO(); im.save(buf, 'WEBP', quality=90, method=6); data[J['images'][i]['bufferView']] = buf.getvalue()
        print('image', i, im.size, len(buf.getvalue()) // 1024, 'KB (was', J['bufferViews'][J['images'][i]['bufferView']]['byteLength'] // 1024, 'KB), textures using it:', users.get(i))
    if dry:
        return
    out = bytearray()
    for k, bv in enumerate(J['bufferViews']):                            # the binary chunk rebuilt view by view
        o = bv.get('byteOffset', 0); chunk = data.get(k, B[o:o + bv['byteLength']])
        while len(out) % 4:
            out += b'\0'
        bv['byteOffset'] = len(out); bv['byteLength'] = len(chunk); out += chunk
    while len(out) % 4:
        out += b'\0'
    J['buffers'][0]['byteLength'] = len(out)
    js = json.dumps(J, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
    glb = b'glTF' + struct.pack('<II', 2, 12 + 8 + len(js) + 8 + len(out)) + struct.pack('<I', len(js)) + b'JSON' + js + struct.pack('<I', len(out)) + b'BIN\0' + bytes(out)
    open(GLB, 'wb').write(glb)
    print('written', GLB, len(glb) // 1024, 'KB')


if __name__ == '__main__':
    main()
