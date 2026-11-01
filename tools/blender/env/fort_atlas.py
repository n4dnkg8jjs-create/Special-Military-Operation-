"""Field-works extras atlas (1024^2 RGBA, alpha-tested, double sided) for fortifications.glb, material 'fort_extra':
garnished camouflage net, anti-drone fishing net, welded wire mesh, olive and blue tarpaulins, black plastic sheeting,
non-woven geotextile, OSB and weathered plywood, corrugated cardboard, ration pouches, zinc ammo tins, food-can
labels.  Everything the 2023-25 positions are improvised from that the shared farmland atlas does not have.
Output: _cache/fort_extra_{albedo.png,normal.png,orm.png}.  Run standalone to repaint.
"""
import os
import numpy as np
from PIL import Image
from texlib import spectral, norm01, colorize, srgb, lerp, to8, normal_from_height, smoothstep, blur, CACHE, quantize_normal, rng

S = 1024
REG = {
    'camo_net': (0, 0, 512, 512),
    'drone_net': (512, 0, 768, 256), 'tarp_olive': (768, 0, 1024, 256),
    'wire_mesh': (512, 256, 768, 512), 'tarp_blue': (768, 256, 1024, 512),
    'osb': (0, 512, 256, 768), 'plywood': (256, 512, 512, 768), 'plastic_black': (512, 512, 768, 768), 'cardboard': (768, 512, 1024, 768),
    'geotex': (0, 768, 256, 1024), 'mre': (256, 768, 512, 1024), 'ammo_zinc': (512, 768, 768, 1024), 'tin_can': (768, 768, 1024, 1024),
}


def grid(h, w):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    return yy, xx


def camo_net(w, h, seed):
    """Knotted net (8 px diamond mesh) carrying a dense garnish of cut polyester 'leaves' in olive / dark green /
    brown / khaki, holes where the garnish is torn out."""
    r = rng(seed); yy, xx = grid(h, w)
    u, v = (xx + yy) / 11.0, (xx - yy) / 11.0
    net = np.maximum(smoothstep(0.42, 0.5, np.abs(np.mod(u, 1) - 0.5)), smoothstep(0.42, 0.5, np.abs(np.mod(v, 1) - 0.5)))
    C = np.zeros((h, w, 3), np.float32) + srgb('#3a3a2c'); A = net * 0.9; H = net * 0.3
    pal = [srgb(c) for c in ('#4b5225', '#38421f', '#5c4a30', '#7a7253', '#2c3420', '#655d3c')]
    big = spectral(0, 2.2, seed + 3, fmin=2, fmax=12, shape=(h, w))
    patch = np.argmax(np.stack([spectral(0, 2.4, seed + 10 + k, fmin=2, fmax=10, shape=(h, w)) for k in range(4)]), 0)
    cover = smoothstep(-0.9, -0.3, big)   # torn-out holes where big < -0.9
    for i in range(4200):
        cx, cy = r.uniform(0, w), r.uniform(0, h)
        L, Wd, a = r.uniform(8, 22), r.uniform(3, 7), r.uniform(0, np.pi)
        ix, iy = int(cx) % w, int(cy) % h
        if r.random() > cover[iy, ix]:
            continue
        col = pal[(patch[iy, ix] + (1 if r.random() < 0.25 else 0)) % len(pal)] * r.uniform(0.82, 1.15)
        x0, x1, y0, y1 = int(cx - L), int(cx + L) + 1, int(cy - L), int(cy + L) + 1
        sy, sx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
        du, dv = (sx - cx) * np.cos(a) + (sy - cy) * np.sin(a), -(sx - cx) * np.sin(a) + (sy - cy) * np.cos(a)
        m = (du / L) ** 2 + (dv / Wd * (1 + 0.6 * np.abs(du / L))) ** 2 < 1
        m &= (np.mod(du + dv * 0.3, 5) > 0.8)  # cut slits in the garnish
        ys, xs = np.mod(sy[m].astype(int), h), np.mod(sx[m].astype(int), w)
        shade = 0.85 + 0.25 * (dv[m] / Wd)
        C[ys, xs] = col * shade[:, None]; A[ys, xs] = 1.0; H[ys, xs] = 0.6 + 0.3 * r.random()
    C *= (0.88 + 0.12 * norm01(spectral(0, 1.0, seed + 30, fmin=8, shape=(h, w))))[..., None]
    return C, A, H


def drone_net(w, h, seed):
    """Anti-drone fishing net: thin dark-green nylon twine, 6 px square mesh, knots, a few sagging / torn meshes."""
    yy, xx = grid(h, w)
    wob = spectral(0, 2.2, seed, fmin=2, fmax=10, shape=(h, w)) * 1.4
    gx = np.abs(np.mod(xx + wob, 6.0) - 3.0); gy = np.abs(np.mod(yy + wob * 0.7, 6.0) - 3.0)
    line = np.maximum(smoothstep(1.9, 2.7, gx), smoothstep(1.9, 2.7, gy))
    tear = spectral(0, 2.0, seed + 4, fmin=3, fmax=20, shape=(h, w)) > 1.7
    A = np.where(tear, 0, line).astype(np.float32)
    C = np.zeros((h, w, 3), np.float32) + srgb('#4a5444')
    return C, A, A * 0.2


def wire_mesh(w, h, seed):
    """Welded steel mesh (5 cm squares, galvanised / rusting) for engineered revetment panels."""
    yy, xx = grid(h, w)
    gx = np.abs(np.mod(xx, 16.0) - 8.0); gy = np.abs(np.mod(yy, 16.0) - 8.0)
    line = np.maximum(smoothstep(6.6, 7.4, gx), smoothstep(6.6, 7.4, gy))
    rust = norm01(spectral(0, 1.6, seed, fmin=3, fmax=60, shape=(h, w)))
    C = lerp(np.zeros((h, w, 3), np.float32) + srgb('#8d8f8a'), srgb('#7a4c2c'), smoothstep(0.55, 0.85, rust))
    return C, line.astype(np.float32), line * 0.5


def fabric(w, h, seed, base, dark, weave=4.0, folds=1.0):
    yy, xx = grid(h, w)
    f = spectral(0, 2.6, seed, fmin=1, fmax=10, shape=(h, w)) * folds
    wr = (np.sin(xx * np.pi * 2 / weave) * np.sin(yy * np.pi * 2 / weave)) * 0.04
    t = norm01(f) * 0.6 + norm01(spectral(0, 1.2, seed + 1, fmin=10, shape=(h, w))) * 0.4
    C = colorize(t, [(0, dark), (1, base)]) * (1 + wr)[..., None]
    dirt = smoothstep(0.55, 0.9, norm01(spectral(0, 1.8, seed + 2, fmin=2, fmax=20, shape=(h, w))))
    C = lerp(C, srgb('#4a3d2e'), dirt * 0.5)
    return C, np.ones((h, w), np.float32), (norm01(f) * 0.6 + wr * 3).astype(np.float32)


def plastic_black(w, h, seed):
    yy, xx = grid(h, w)
    wr = spectral(0, 2.0, seed, fmin=3, fmax=40, shape=(h, w)); cr = np.abs(blur(spectral(0, 1.4, seed + 1, fmin=6, fmax=60, shape=(h, w)), 0.8))
    C = np.zeros((h, w, 3), np.float32) + srgb('#1c1d1d'); C = lerp(C, srgb('#3e413f'), smoothstep(0.6, 2.0, wr) * 0.7 + smoothstep(1.6, 2.4, cr) * 0.3)
    dust = smoothstep(0.5, 0.9, norm01(spectral(0, 1.8, seed + 2, fmin=2, fmax=24, shape=(h, w))))
    C = lerp(C, srgb('#5d5345'), dust * 0.55)
    tear = spectral(0, 2.4, seed + 5, fmin=2, fmax=40, shape=(h, w)) > 1.6
    return C, np.where(tear, 0.0, 1.0).astype(np.float32), (norm01(wr) * 0.5).astype(np.float32)


def board(w, h, seed, kind):
    yy, xx = grid(h, w)
    if kind == 'osb':
        r = rng(seed); C = np.zeros((h, w, 3), np.float32) + srgb('#a88a5c'); H = np.zeros((h, w), np.float32)
        for i in range(1400):
            cx, cy, L, Wd, a = r.uniform(0, w), r.uniform(0, h), r.uniform(6, 20), r.uniform(2, 6), r.uniform(-0.6, 0.6)
            x0, y0 = int(cx - L), int(cy - L); sy, sx = np.mgrid[y0:y0 + int(2 * L) + 1, x0:x0 + int(2 * L) + 1].astype(np.float32)
            du, dv = (sx - cx) * np.cos(a) + (sy - cy) * np.sin(a), -(sx - cx) * np.sin(a) + (sy - cy) * np.cos(a)
            m = (np.abs(du) < L) & (np.abs(dv) < Wd)
            C[np.mod(sy[m].astype(int), h), np.mod(sx[m].astype(int), w)] = srgb('#a88a5c') * r.uniform(0.72, 1.2) * np.array([1, r.uniform(0.95, 1.02), r.uniform(0.85, 1.0)])
            H[np.mod(sy[m].astype(int), h), np.mod(sx[m].astype(int), w)] = r.random()
        grey = smoothstep(0.45, 0.85, norm01(spectral(0, 1.6, seed + 3, fmin=2, fmax=20, shape=(h, w))))
        C = lerp(C, srgb('#6e6a60'), grey * 0.6)                                   # weathered grey
        C = lerp(C, srgb('#3e3428'), smoothstep(0.7, 1.0, yy / h)[..., None] * 0.7)   # wicked-up mud at the foot
        return C, np.ones((h, w), np.float32), H * 0.4
    grain = spectral(0, 1.5, seed, fmin=1, fmax=80, shape=(h, w)); grain = blur(grain, (0.5, 10), True)
    C = colorize(norm01(grain), [(0, '#6a6458'), (0.5, '#8b8476'), (1, '#a39a88')])
    C = lerp(C, srgb('#3a3128'), smoothstep(0.75, 1.0, yy / h)[..., None] * 0.6)
    delam = spectral(0, 2.0, seed + 2, fmin=3, fmax=30, shape=(h, w)) > 1.8
    C = np.where(delam[..., None], C * 0.75 + srgb('#b39a72') * 0.25, C)
    return C, np.ones((h, w), np.float32), norm01(grain) * 0.3


def cardboard(w, h, seed):
    yy, xx = grid(h, w)
    C = colorize(norm01(spectral(0, 1.4, seed, fmin=2, fmax=40, shape=(h, w))), [(0, '#7d6446'), (1, '#a8885e')])
    C *= (1 + 0.05 * np.sin(xx * np.pi * 2 / 5))[..., None]
    C[int(h * 0.3):int(h * 0.38), int(w * 0.15):int(w * 0.8)] *= 0.35          # stencilled print bands
    C[int(h * 0.45):int(h * 0.5), int(w * 0.15):int(w * 0.55)] *= 0.45
    wet = smoothstep(0.5, 0.9, norm01(spectral(0, 2.0, seed + 1, fmin=2, fmax=10, shape=(h, w))))
    C = lerp(C, srgb('#4a3a2a'), wet * 0.6)
    return C, np.ones((h, w), np.float32), np.zeros((h, w), np.float32)


def labels(w, h, seed, kind):
    yy, xx = grid(h, w); r = rng(seed)
    if kind == 'mre':
        C = colorize(norm01(spectral(0, 1.4, seed, fmin=3, fmax=40, shape=(h, w))), [(0, '#8a7d5e'), (1, '#a99a74')])
        for k in range(4):
            y0 = int(h * (0.15 + 0.18 * k)); C[y0:y0 + 6, int(w * 0.1):int(w * r.uniform(0.4, 0.9))] = srgb('#3a342a')
        return C, np.ones((h, w), np.float32), np.zeros((h, w), np.float32)
    if kind == 'ammo_zinc':
        C = colorize(norm01(spectral(0, 1.2, seed, fmin=3, fmax=60, shape=(h, w))), [(0, '#5d6352'), (1, '#7a806c')])
        C[int(h * 0.4):int(h * 0.47), int(w * 0.2):int(w * 0.8)] = srgb('#d8d2b8')   # stencil
        C[int(h * 0.55):int(h * 0.6), int(w * 0.3):int(w * 0.7)] = srgb('#d8d2b8')
        rust = smoothstep(0.6, 0.95, norm01(spectral(0, 1.8, seed + 1, fmin=4, fmax=40, shape=(h, w))))
        return lerp(C, srgb('#6b4428'), rust * 0.6), np.ones((h, w), np.float32), np.zeros((h, w), np.float32)
    C = np.zeros((h, w, 3), np.float32) + srgb('#b9bbb6')                                 # tin can: tinplate + label band
    band = (yy > h * 0.2) & (yy < h * 0.8)
    C[band] = srgb('#a8402e') if seed % 2 else srgb('#3d6a8a')
    C[(yy > h * 0.42) & (yy < h * 0.58)] = srgb('#e2dccb')
    C *= (0.8 + 0.2 * norm01(spectral(0, 1.0, seed + 2, fmin=4, shape=(h, w))))[..., None]
    return C, np.ones((h, w), np.float32), np.zeros((h, w), np.float32)


def paint(name, w, h, seed):
    if name == 'camo_net': return camo_net(w, h, seed)
    if name == 'drone_net': return drone_net(w, h, seed)
    if name == 'wire_mesh': return wire_mesh(w, h, seed)
    if name == 'tarp_olive': return fabric(w, h, seed, '#5d6142', '#3f4330')
    if name == 'tarp_blue': return fabric(w, h, seed, '#4a6f96', '#2f4c6c', weave=3.0)
    if name == 'geotex': return fabric(w, h, seed, '#c9c6bc', '#9f9a8c', weave=2.0, folds=0.6)
    if name == 'plastic_black': return plastic_black(w, h, seed)
    if name in ('osb', 'plywood'): return board(w, h, seed, name)
    if name == 'cardboard': return cardboard(w, h, seed)
    return labels(w, h, seed, name)


def build():
    alb = np.zeros((S, S, 3), np.float32) + 0.5; alpha = np.zeros((S, S), np.float32); hgt = np.zeros((S, S), np.float32)
    rough = np.full((S, S), 0.9, np.float32)
    for i, (name, (x0, y0, x1, y1)) in enumerate(REG.items()):
        C, A, H = paint(name, x1 - x0, y1 - y0, 7700 + i * 11)
        alb[y0:y1, x0:x1] = np.clip(C, 0, 1); alpha[y0:y1, x0:x1] = A; hgt[y0:y1, x0:x1] = H
        if name in ('plastic_black', 'tarp_blue'): rough[y0:y1, x0:x1] = 0.55
        if name in ('wire_mesh', 'ammo_zinc', 'tin_can'): rough[y0:y1, x0:x1] = 0.5
    m = alpha > 0.5
    fill = blur(alb * alpha[..., None], 4, wrap=False) / (blur(alpha, 4, wrap=False)[..., None] + 1e-4)
    out = np.where(m[..., None], alb, np.where((blur(alpha, 4, wrap=False) > 0.02)[..., None], fill, alb))
    paths = [os.path.join(CACHE, f'fort_extra_{s}') for s in ('albedo.png', 'normal.png', 'orm.png')]
    Image.fromarray(to8(np.concatenate([np.clip(out, 0, 1), alpha[..., None]], -1)), 'RGBA').save(paths[0], optimize=True)
    nrm = normal_from_height(blur(hgt, 0.7, wrap=False) * 2.5, 0.8, wrap=False)
    Image.fromarray(quantize_normal(nrm, 6)).save(paths[1], optimize=True)
    orm = np.stack([np.clip(0.6 + 0.4 * hgt, 0, 1), rough, np.zeros_like(rough)], -1)
    Image.fromarray(quantize_normal(to8(orm), 6)).save(paths[2], optimize=True)
    return paths


def cache_paths():
    return [os.path.join(CACHE, f'fort_extra_{s}') for s in ('albedo.png', 'normal.png', 'orm.png')]


if __name__ == '__main__':
    import time; t0 = time.time()
    print(build(), round(time.time() - t0, 1), 's')
