"""Photo-real street surfaces for the Soviet microdistrict (Ukraine 2022-24), used by gen_ground_textures.py:
  asphalt  7 m tile (src/world/city.js roads(): carriageways, car park; farmland village roads)
  concrete 4 m tile (city.js roads(): pavements / sidewalks) - grey vibro-pressed 200 x 100 mm concrete pavers
           ("цеглинка" бруківка) in running (stretcher) bond, sand joints with dirt and a few dry weeds
  curb     one 1 m precast kerb stone (БР 100.30.15-like) for a 0.98 x 0.2 x 0.22 m BoxGeometry with default UVs:
           U = 1 m along the stone, V = 0.21 m (authored isotropic, stretched to the square image afterwards)

Design rules (game camera 30-250 m, plain MeshStandardMaterial without any anti-tiling shader, so the tile itself
must hide its repeat):
  * no landmarks: no single feature may stand out enough to be recognised again 7 m (4 m) further on; repairs,
    cracks and stains are many, small-to-medium and of LOW contrast; macro tone drift is kept to a few percent
  * the 1-50 cm scale carries the realism: aggregate, ravelling, saw-cut patches of different age, crack sealant
    bands (tar snakes), open hairline cracks, oil drips, dust in the pores
  * cracks are mostly straight at metre scale with jagged cm-scale deviation (no loopy random-walk squiggles)
  * height is authored in millimetres and converted to pixel units; the normal map is strong but not noisy
  * roads in city.js are axis aligned and UV-aligned with the world, so repairs / cracks are aligned to U / V
    (both directions equally, because N-S roads see the texture rotated by 90 deg relative to their direction)
All textures are periodic in both axes.
"""
import os
import numpy as np
import cv2
from PIL import Image
from texlib import smoothstep, blur, colorize, srgb, lerp, rng, to8, normal_from_height, cavity_ao, bake_shade, REPO
from soil_tex import spec, cells, wrap_lines, wrap_fill

OUT = os.path.join(REPO, 'assets', 'textures')


# ------------------------------------------------------------------ helpers
def save_jpg_set(name, alb, nrm_u8, ao, rough, size=2048, orm_size=1024, metal=None, nblur=0.5):
    """albedo + normal JPG at `size`, ORM (R=AO, G=rough, B=metal) JPG at `orm_size`; 4:4:4 chroma for normal/ORM."""
    os.makedirs(OUT, exist_ok=True)
    if metal is None:
        metal = np.zeros_like(rough)

    def rs(img, s):
        return img if img.size == (s, s) else img.resize((s, s), Image.LANCZOS)
    rs(Image.fromarray(to8(alb)), size).save(os.path.join(OUT, f'{name}_albedo.jpg'), quality=90, optimize=True)
    if nblur:
        nrm_u8 = to8(blur(nrm_u8.astype(np.float32) / 255.0, nblur))
    rs(Image.fromarray(nrm_u8), size).save(os.path.join(OUT, f'{name}_normal.jpg'), quality=90, optimize=True, subsampling=0)
    orm = to8(np.stack([ao, np.clip(rough, 0, 1), metal], -1))
    rs(Image.fromarray(orm), orm_size).save(os.path.join(OUT, f'{name}_orm.jpg'), quality=90, optimize=True, subsampling=0)


def crack_path(r, x, y, ang, L, step, curl=0.06, revert=0.15, jag=0.35, zig=0.0):
    """Polyline that keeps its heading at metre scale (mean reversion to `ang`) with jagged small deviations.
    zig: per-segment angular scatter (radians) around the slowly drifting heading -> angular zigzag like real cracks."""
    pts = [(x, y)]; a = ang; base = ang
    for _ in range(int(L / step)):
        base = base + r.normal(0, curl) - (base - ang) * revert
        a = base + r.normal(0, zig) if zig else base
        s = step * r.uniform(0.6, 1.4)
        x += np.cos(a) * s + r.normal(0, jag); y += np.sin(a) * s + r.normal(0, jag)
        pts.append((x, y))
    return np.array(pts, np.float32)


def line_dist(shape, lines, maxd):
    """Wrapped distance (px) to a set of 1-px polylines."""
    m = np.zeros(shape, np.float32)
    wrap_lines(m, lines, 1.0, 1)
    pad = int(maxd + 4)
    mp = np.pad((m < 0.3).astype(np.uint8), pad, mode='wrap')
    return cv2.distanceTransform(mp, cv2.DIST_L2, 5)[pad:-pad, pad:-pad], np.clip(m, 0, 1)


def blob_mask(shape, seed, cx, cy, rad, rough=0.35, lam=None):
    """Organic blob (wrapped): soft disc falloff perturbed by noise, thresholded."""
    h, w = shape
    r0 = int(rad * 1.8) + 4
    yy, xx = np.mgrid[-r0:r0 + 1, -r0:r0 + 1].astype(np.float32)
    n = spec((2 * r0 + 1, 2 * r0 + 1), seed, max(rad * 0.15, 2), lam or rad * 0.9, 1.6)
    d = np.sqrt(xx * xx + yy * yy) / rad + n * rough
    v = 1 - smoothstep(0.85, 1.05, d)
    out = np.zeros(shape, np.float32)
    ys = (np.arange(-r0, r0 + 1) + int(cy)) % h; xs = (np.arange(-r0, r0 + 1) + int(cx)) % w
    out[np.ix_(ys, xs)] = np.maximum(out[np.ix_(ys, xs)], v)
    return out


def rect_poly(x, y, w, h, jag=0.0, r=None, n=0):
    """Axis-aligned rectangle (optionally with slightly wavy hand-cut edges) as polygon points."""
    if not jag:
        return np.array([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], np.float32)
    P = []
    for (x0, y0, x1, y1) in ((x, y, x + w, y), (x + w, y, x + w, y + h), (x + w, y + h, x, y + h), (x, y + h, x, y)):
        k = max(2, n)
        for t in np.linspace(0, 1, k, endpoint=False):
            P.append((x0 + (x1 - x0) * t + r.normal(0, jag), y0 + (y1 - y0) * t + r.normal(0, jag)))
    return np.array(P, np.float32)


# ------------------------------------------------------------------ asphalt
def asphalt_surface(shape, ppm, seed, binder, expose, agg_density=1.0, stone_cols=None, fresh=0.0):
    """Asphalt concrete wearing course: crushed-granite aggregate (2-15 mm) in a bitumen-sand mastic.
    expose: 0..1 field, how much the binder film is worn off the stone tops (old, sun-oxidised = high).
    Returns alb, hgt (mm), rough, stone mask."""
    h, w = shape
    px = lambda m: m * ppm
    r = rng(seed)
    stone_cols = stone_cols or [(0, '#4e4c49'), (0.25, '#6f6b66'), (0.55, '#8d8881'), (0.78, '#a29d95'),
                                (0.88, '#9a8075'), (0.95, '#b4aea4'), (1, '#c2bdb3')]
    grain = spec(shape, seed + 1, 0, px(0.003), 0.3)          # sand / mastic grain
    mastic = spec(shape, seed + 2, px(0.004), px(0.03), 1.2)
    alb = np.zeros(shape + (3,), np.float32); hgt = np.zeros(shape, np.float32); stone = np.zeros(shape, np.float32)
    # binder / mastic colour (bitumen + filler + sand), lighter where oxidised
    bcol = colorize(np.clip(0.5 + 0.18 * mastic + 0.12 * grain, 0, 1), binder)
    alb[:] = bcol
    hgt += mastic * 0.25 + grain * 0.12
    # aggregate in two size classes: coarse 6-14 mm, fine chips 2-5 mm (angular: Voronoi edge distance)
    for k, (cell_m, keep_p, hmm) in enumerate(((0.016, 0.62 * agg_density, 1.6), (0.0068, 0.55 * agg_density, 0.8))):
        F1, F2, ids, _ = cells(shape, px(cell_m), seed + 10 + k, warp=px(cell_m * 0.18), lam=px(cell_m * 1.5))
        n = ids.max() + 1
        on = (r.random(n) < keep_p)[ids]
        e = F2 - F1
        sh = np.clip(e / px(cell_m * 0.32), 0, 1) ** 0.7 * on
        tone = r.random(n).astype(np.float32)[ids]
        ht = (0.6 + 0.4 * r.random(n).astype(np.float32))[ids]
        # stone face shows where the binder film is worn off; the rest of the stone is coated (binder tone, but relief)
        show = smoothstep(0.15, 0.6, sh) * np.clip(expose * (0.55 + 0.6 * ht) - fresh * 0.6, 0, 1)
        scol = colorize(tone, stone_cols) * (0.88 + 0.16 * grain[..., None])
        alb = lerp(alb, scol, show * (sh > stone))
        hgt = np.maximum(hgt, sh * hmm * ht)
        stone = np.maximum(stone, show)
    # voids between stones (macro texture): small dark pits
    cav = np.clip(blur(hgt, 1.2) - hgt, 0, None)
    alb *= (1 - np.clip(cav * 0.9, 0, 0.35))[..., None]
    rough = 0.9 - stone * 0.07 + 0.02 * grain - fresh * 0.1
    return alb, hgt, rough, stone


def tex_asphalt(S=2048, tile_m=7.0, seed=11):
    """Old Soviet-era asphalt street, resurfaced in places, many saw-cut repairs, crack sealing (tar snakes)."""
    shape = (S, S); ppm = S / tile_m; px = lambda m: m * ppm; mm = 1000.0 / ppm
    r = rng(seed)
    # ---------------- macro fields (low contrast; nothing larger than ~2.5 m, nothing that forms a blob landmark)
    m1 = spec(shape, seed + 1, px(0.6), px(2.5), 2.0)
    m2 = spec(shape, seed + 2, px(0.15), px(0.8), 1.8)
    m3 = spec(shape, seed + 3, px(0.03), px(0.2), 1.4)
    ravel = np.clip(0.66 + 0.12 * m1 + 0.1 * m2 + 0.08 * m3, 0, 1)        # binder worn off / aggregate exposure
    # ---------------- three surfaces: old wearing course, mid-age repair, fresh repair
    old_binder = [(0, '#595855'), (0.5, '#706e6a'), (1, '#84817c')]
    alb_o, h_o, r_o, st_o = asphalt_surface(shape, ppm, seed + 100, old_binder, ravel)
    mid_binder = [(0, '#52514e'), (0.5, '#666460'), (1, '#77746f')]
    alb_m, h_m, r_m, st_m = asphalt_surface(shape, ppm, seed + 200, mid_binder, ravel * 0.6, agg_density=1.05)
    new_binder = [(0, '#403f3d'), (0.5, '#4e4d4a'), (1, '#5b5955')]
    alb_n, h_n, r_n, st_n = asphalt_surface(shape, ppm, seed + 300, new_binder, ravel * 0.25, agg_density=1.1, fresh=0.4)
    # ---------------- repair patches: saw-cut rectangles (axis aligned) of different age, overlapping in places
    age = np.ones(shape, np.float32)          # 1 = original surface, 0.5 = mid repair, 0 = fresh repair
    lift = np.zeros(shape, np.float32)        # patch surface step (mm)
    seams = []
    # many repairs, all of LOW contrast (a dark patch would mark the 7 m repeat): mostly old ones that have nearly
    # blended in, a few mid-age, only two small younger ones
    specs = [(2.6, 1.7, 0.85), (1.9, 1.1, 0.72), (3.2, 1.2, 0.9), (1.2, 0.9, 0.55), (2.2, 2.0, 0.8), (0.9, 0.7, 0.5),
             (1.6, 1.4, 0.68), (1.1, 2.3, 0.78), (0.8, 1.6, 0.62), (1.4, 0.8, 0.5), (2.8, 0.9, 0.88), (0.7, 0.6, 0.55),
             (1.8, 1.0, 0.92), (1.0, 1.3, 0.7), (0.6, 0.5, 0.6), (2.0, 0.7, 0.75), (1.3, 1.1, 0.82), (0.9, 1.9, 0.86)]
    for k, (pw, ph, a) in enumerate(specs):
        if r.random() < 0.5:
            pw, ph = ph, pw
        x, y = r.uniform(0, S), r.uniform(0, S)
        poly = rect_poly(x, y, px(pw), px(ph), jag=0.5, r=r, n=5)
        m = np.zeros(shape, np.float32); wrap_fill(m, poly, 1.0); m = np.clip(m, 0, 1)
        sel = m > 0.5
        age[sel] = a; lift[sel] = r.uniform(-1.0, 2.0)
        seams.append((np.vstack([poly, poly[:1]]), a))
    age_s = blur(age, 0.7)
    t_mid = np.clip(age_s * 2, 0, 1); t_old = np.clip(age_s * 2 - 1, 0, 1)
    alb = lerp(lerp(alb_n, alb_m, t_mid), alb_o, t_old)
    hgt = lerp(lerp(h_n, h_m, t_mid), h_o, t_old) + blur(lift, 0.8)
    rough = lerp(lerp(r_n, r_m, t_mid), r_o, t_old)
    # ---------------- hand-placed cold-mix fills of old potholes: organic, darker, lumpy, slightly proud
    blobs = np.zeros(shape, np.float32)
    for k in range(5):
        blobs = np.maximum(blobs, blob_mask(shape, seed + 400 + k, r.uniform(0, S), r.uniform(0, S), px(r.uniform(0.12, 0.3)), 0.45))
    lump = spec(shape, seed + 40, px(0.01), px(0.06), 1.4)
    alb = lerp(alb, alb_m * (0.95 + 0.08 * lump[..., None]), blobs * 0.8)
    hgt = hgt + blobs * (1.5 + lump * 1.0)
    rough = lerp(rough, 0.85, blobs)
    # ---------------- cracks
    # Free cracks, evenly spread (best-candidate sampling, wrapped distance) so that no area is crowded or empty -
    # clusters / crosses of dark cracks are what make a 7 m repeat recognisable. Long ones (1.2-3.5 m) drift in
    # heading (+-30 deg), medium ones branch; ~half are sealed with bitumen. A faint hairline block-crack network
    # (35-70 cm cells) carries a uniform background density of fine cracks.
    def best_candidate(pts, k=12):
        best, bd = None, -1
        for _ in range(k):
            c = r.uniform(0, S, 2)
            if not pts:
                return c
            d = np.abs(np.array(pts) - c); d = np.minimum(d, S - d); d = np.sqrt((d ** 2).sum(1)).min()
            if d > bd:
                best, bd = c, d
        return best
    starts = []
    cracks, is_sealed = [], []
    for k in range(34):
        c = best_candidate(starts); starts.append(c)
        long_ = k < 14
        ang = (0 if r.random() < 0.5 else np.pi / 2) + r.normal(0, 0.2) + (np.pi if r.random() < 0.5 else 0)
        L = px(r.uniform(1.2, 3.5) if long_ else r.uniform(0.35, 1.3))
        P = crack_path(r, c[0], c[1], ang, L, step=px(0.018), curl=0.05 if long_ else 0.07, revert=0.02 if long_ else 0.06,
                       jag=0.4, zig=0.45)
        sl = r.random() < (0.7 if long_ else 0.35)
        cracks.append(P); is_sealed.append(sl)
        if r.random() < (0.3 if long_ else 0.4):
            i = r.integers(len(P) // 4, max(len(P) // 4 + 1, 3 * len(P) // 4))
            a2 = ang + r.choice([-1, 1]) * r.uniform(0.6, 1.3)
            cracks.append(crack_path(r, P[i][0], P[i][1], a2, L * r.uniform(0.12, 0.4), step=px(0.018), curl=0.08, revert=0.05, jag=0.4, zig=0.5))
            is_sealed.append(sl and r.random() < 0.7)
    openc = [c for c, s_ in zip(cracks, is_sealed) if not s_]
    # open cracks: ~5-8 mm dark core + ravelled, partly broken-out edges (1-2 cm)
    od, _ = line_dist(shape, openc, 12)
    rav = spec(shape, seed + 55, px(0.006), px(0.05), 1.3)
    open_m = 1 - smoothstep(0.6, 1.6, od - 0.5 * np.clip(rav, 0, None))
    open_rav = (1 - smoothstep(1.5, 4.5 + 2.0 * rav, od)) * (0.4 + 0.3 * np.clip(rav, 0, 1))
    F1, F2, _, _ = cells(shape, px(0.5), seed + 53, warp=px(0.06), lam=px(0.4))
    hair = np.exp(-((F2 - F1) / 0.7) ** 2) * smoothstep(-0.4, 0.6, spec(shape, seed + 54, px(0.2), px(1.2), 1.8)) * (age_s > 0.7)
    # alligator / fatigue cracking in a few small zones of the original surface (fine polygon network, 6-15 cm cells)
    zone = smoothstep(1.5, 2.1, spec(shape, seed + 50, px(0.4), px(1.4), 2.2) + 0.25 * m2) * (age_s > 0.95)
    F1, F2, _, _ = cells(shape, px(0.09), seed + 51, warp=px(0.02), lam=px(0.12))
    gator = np.exp(-((F2 - F1) / 0.8) ** 2) * zone
    # patch seams: open joint in places (thin dark line), older patches mostly closed up
    seam_d, seam_l = line_dist(shape, [p for p, a in seams], 6)
    seam_open = seam_l * smoothstep(-0.3, 0.5, spec(shape, seed + 52, px(0.08), px(0.5), 1.5))
    crack = np.clip(open_m * 0.9 + gator * 0.6 + seam_open * 0.6 + hair * 0.45, 0, 1)
    crack_soft = blur(crack, 1.5)
    hgt = hgt - crack * 2.4 - crack_soft * 1.0 - open_rav * 1.2
    alb = lerp(alb, alb * 0.7, open_rav)
    alb = lerp(alb, srgb('#252422'), np.clip(crack * 0.72, 0, 1))
    alb = lerp(alb, srgb('#7a756d'), np.clip(crack_soft * 2.0 - crack, 0, 1) * 0.15)
    rough = np.maximum(rough, crack * 0.95)
    # gentle mid-scale mottling (10-80 cm, +-4 %): binder-rich darker vs. dusty lighter areas
    alb = alb * (1 + 0.04 * np.tanh(m2 * 0.8 + m3 * 0.5))[..., None]
    # ---------------- crack sealant (tar snakes): overbanded, width varies along the crack, worn / gritty when old
    seal = np.zeros(shape, np.float32); sage = np.zeros(shape, np.float32)
    wn = spec(shape, seed + 60, px(0.08), px(0.4), 1.8)       # band width variation along the crack
    en = spec(shape, seed + 61, px(0.005), px(0.03), 1.3)      # ragged band edge
    for P, s_ in zip(cracks, is_sealed):
        if not s_:
            continue
        w0 = px(r.uniform(0.012, 0.028))                         # half width 1.2-2.8 cm
        d, _ = line_dist(shape, [P], w0 * 2.2 + 6)
        hw = w0 * (1 + 0.35 * wn) + en * px(0.004)
        m = 1 - smoothstep(hw - 0.9, hw + 0.9, d)
        seal = np.maximum(seal, m)
        sage = np.maximum(sage, m * r.uniform(0.0, 1.0))
    sand = smoothstep(0.0, 1.4, spec(shape, seed + 62, px(0.03), px(0.3), 1.6))   # grit / dust on older sealant
    tar = lerp(srgb('#1d1c1b'), srgb('#383633'), np.clip(sage * 0.7 + sand * 0.35, 0, 1))
    tar = tar * (0.95 + 0.06 * en[..., None])
    alb = lerp(alb, tar, seal * 0.95)
    hgt = lerp(hgt, blur(hgt, 2.5) * 0.35 + 0.8 + en * 0.15, seal)
    rough = lerp(rough, 0.48 + 0.3 * sage + 0.12 * sand, seal)
    # ---------------- oil drips (small clusters, low contrast), tyre-rubber smudges, fine dust film
    drip = np.zeros(shape, np.float32)
    for k in range(int(tile_m * tile_m * 0.8)):
        cx, cy = r.uniform(0, S), r.uniform(0, S)
        for j in range(r.integers(1, 4)):
            drip = np.maximum(drip, blob_mask(shape, int(r.integers(1 << 30)), cx + r.normal(0, px(0.05)), cy + r.normal(0, px(0.05)),
                                              px(r.uniform(0.012, 0.04)), 0.2) * r.uniform(0.3, 0.8))
    drip = blur(drip, 2.0)
    alb = lerp(alb, srgb('#2a2927'), drip * 0.4)
    rough = lerp(rough, 0.65, drip * 0.7)
    dust_f = smoothstep(-0.8, 1.8, spec(shape, seed + 71, px(0.08), px(1.2), 1.8))
    alb = lerp(alb, srgb('#857f74'), dust_f * 0.1 * (1 - seal * 0.5))
    rough = rough + dust_f * 0.03
    cav = np.clip(blur(hgt, 2.0) - hgt, 0, 2.0) / 2.0
    alb = lerp(alb, srgb('#7d786f'), cav * 0.3 * (1 - seal))
    # ---------------- war: shrapnel gouges (bright fresh chips with a dark centre)
    scar = np.zeros(shape, np.float32); pit = np.zeros(shape, np.float32)
    for k in range(int(tile_m * tile_m * 1.0)):
        cx, cy = r.uniform(0, S), r.uniform(0, S); rr = px(r.uniform(0.008, 0.028))
        a = r.uniform(0, np.pi); el = r.uniform(1.0, 2.5)
        kk = 7; ang = np.linspace(0, 2 * np.pi, kk, endpoint=False)
        rad = rr * r.uniform(0.6, 1.3, kk)
        P = np.stack([cx + np.cos(ang) * rad * el * np.cos(a) - np.sin(ang) * rad * np.sin(a),
                      cy + np.cos(ang) * rad * el * np.sin(a) + np.sin(ang) * rad * np.cos(a)], -1)
        wrap_fill(scar, P, 1.0)
        wrap_fill(pit, (P - [cx, cy]) * 0.45 + [cx, cy], 1.0)
    scar = np.clip(scar, 0, 1); pit = np.clip(pit, 0, 1)
    alb = lerp(alb, srgb('#8f8a81'), np.clip(scar - pit, 0, 1) * 0.5)
    alb = lerp(alb, srgb('#2b2a28'), pit * 0.55)
    hgt = hgt - scar * 1.5 - pit * 1.5
    rough = lerp(rough, 0.95, scar)
    # ---------------- finish
    hp = hgt / mm
    ao = cavity_ao(hp, 2, 0.35) * cavity_ao(hp, 10, 0.12)
    alb = alb * bake_shade(hp, 0.5, 0.15) * (0.86 + 0.14 * ao)[..., None]
    nrm = normal_from_height(hp, 1.3)
    save_jpg_set('asphalt', np.clip(alb, 0, 1), nrm, ao, np.clip(rough, 0.3, 1))
    return alb, hp, rough


# ------------------------------------------------------------------ concrete pavers
def tex_concrete(S=2048, tile_m=4.0, seed=101):
    """Grey vibro-pressed concrete pavers 200 x 100 x 60 mm ("цеглинка"), running bond, 3-5 mm sand joints,
    4 mm chamfer, per-paver tone / tilt, chipped arrises, a few cracked or replaced pavers, dirt + dry weeds in
    the joints, chewing-gum spots, leaf bits, shrapnel chips. Courses run along U."""
    shape = (S, S); ppm = S / tile_m; px = lambda m: m * ppm; mm = 1000.0 / ppm
    r = rng(seed)
    L, Wd = px(0.2), px(0.1)
    ncol, nrow = int(round(tile_m / 0.2)), int(round(tile_m / 0.1))
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    # laying imperfection: courses wander a few mm, joint widths vary
    wob_y = spec(shape, seed + 1, px(0.3), px(2.0), 2.0) * px(0.0028)
    wob_x = spec(shape, seed + 2, px(0.3), px(2.0), 2.0) * px(0.0028)
    Y = yy + wob_y
    row = np.floor(Y / Wd).astype(np.int32)
    ly = Y - row * Wd
    row %= nrow
    rjit = r.uniform(-0.25, 0.25, nrow) * L * 0.06      # rows not perfectly half-offset
    X = xx + wob_x + (row % 2) * (L * 0.5) + rjit[row]
    col = np.floor(X / L).astype(np.int32)
    lx = X - col * L
    col %= ncol
    pid = row * ncol + col
    n = nrow * ncol
    # per-paver size jitter: each side of the joint varies (joint 2.5-5 mm total)
    jl = r.uniform(px(0.0012), px(0.0028), n)[pid]; jr = r.uniform(px(0.0012), px(0.0028), n)[pid]
    jt = r.uniform(px(0.0012), px(0.0026), n)[pid]; jb = r.uniform(px(0.0012), px(0.0026), n)[pid]
    dl, dr, dt, db = lx - jl, (L - lx) - jr, ly - jt, (Wd - ly) - jb
    dx = np.minimum(dl, dr); dy = np.minimum(dt, db)
    rc = px(0.004)    # rounded corners
    qx = np.maximum(rc - dx, 0); qy = np.maximum(rc - dy, 0)
    edge = np.where((qx > 0) & (qy > 0), rc - np.sqrt(qx * qx + qy * qy), np.minimum(dx, dy))
    # chipped arrises / corners (spalls a few mm deep, a few cm long)
    chipn = spec(shape, seed + 3, px(0.006), px(0.04), 1.3)
    chip_amt = np.clip(chipn * 1.4 - 1.25, 0, None) * px(0.006)
    corner = np.exp(-((dx / px(0.012)) ** 2 + (dy / px(0.012)) ** 2))
    chip_amt += corner * np.clip(r.random(n)[pid] - 0.55, 0, 1) * px(0.012) * (0.5 + 0.5 * np.clip(chipn, 0, 2))
    edge_c = edge - chip_amt
    inside = smoothstep(-0.6, 0.6, edge_c)
    ch = px(0.004)
    bevel = smoothstep(0, ch, edge_c)                       # 4 mm chamfer
    # per-paver properties
    tone = r.normal(0, 1, n).astype(np.float32)
    warm = r.normal(0, 1, n).astype(np.float32)
    tiltx = r.normal(0, 1, n).astype(np.float32); tilty = r.normal(0, 1, n).astype(np.float32)
    sink = r.normal(0, 1, n).astype(np.float32)
    # replaced pavers: a few small groups of newer, lighter/cleaner stones (low contrast), and some odd darker ones
    newer = np.zeros(n, np.float32)
    for k in range(6):
        r0, c0 = r.integers(0, nrow), r.integers(0, ncol); hh, ww = r.integers(2, 7), r.integers(1, 4)
        for i in range(hh):
            for j in range(ww):
                newer[((r0 + i) % nrow) * ncol + (c0 + j) % ncol] = 1
    odd = (r.random(n) < 0.04).astype(np.float32)
    cracked = (r.random(n) < 0.035)
    # ---------------- paver surface (vibro-pressed: fine sandy skin, small pores, worn exposing sand / fine aggregate)
    fine = spec(shape, seed + 4, 0, px(0.002), 0.3)
    skin = spec(shape, seed + 5, px(0.003), px(0.03), 1.3)
    macro = spec(shape, seed + 6, px(0.4), px(1.8), 2.0)
    traffic = spec(shape, seed + 7, px(0.15), px(0.8), 1.8)
    t = np.clip(0.5 + 0.105 * tone[pid] + 0.06 * skin + 0.06 * fine + 0.05 * macro + 0.13 * newer[pid] - 0.16 * odd[pid], 0, 1)
    pcol = colorize(t, [(0, '#7d7a74'), (0.35, '#94918a'), (0.6, '#a5a199'), (0.85, '#b5b1a8'), (1, '#c2beb5')])
    pcol *= (1 + 0.01 * warm[pid][..., None] * np.array([1.0, 0.2, -0.9], np.float32))         # slight warm / cool batches
    # exposed fine aggregate on worn tops
    F1, F2, gid, _ = cells(shape, px(0.0045), seed + 8, warp=px(0.001), lam=px(0.006))
    ng = gid.max() + 1
    agg = np.clip((F2 - F1) / px(0.0012), 0, 1) ** 0.6 * (r.random(ng) < 0.45)[gid]
    wear = smoothstep(-0.8, 1.2, traffic * 0.7 + skin * 0.3) * (1 - newer[pid] * 0.7)
    acol = colorize(r.random(ng).astype(np.float32)[gid], [(0, '#6f6b65'), (0.5, '#a19c93'), (0.85, '#bdb8ad'), (1, '#8c7468')])
    pcol = lerp(pcol, acol, agg * wear * 0.55)
    pores = (r.random(shape) < 0.004).astype(np.float32)
    pores = np.clip(blur(pores, 0.7) * 5, 0, 1)
    pcol = lerp(pcol, srgb('#56534d'), pores * 0.5)
    # grime: darker toward the joints (dirt washed into the chamfer), traffic soiling, dark gum spots
    near_j = 1 - smoothstep(0, px(0.012), edge_c)
    pcol = pcol * (1 - 0.25 * near_j * (0.7 + 0.3 * skin))[..., None]
    soil = smoothstep(0.2, 1.8, traffic * 0.6 + macro * 0.4)
    pcol = lerp(pcol, srgb('#6a655b'), soil * 0.18)
    gum = np.zeros(shape, np.float32)
    for k in range(int(tile_m * tile_m * 9)):
        stamp = (r.uniform(0, S), r.uniform(0, S), px(r.uniform(0.005, 0.014)))
        kk = 8; ang = np.linspace(0, 2 * np.pi, kk, endpoint=False); rad = stamp[2] * r.uniform(0.8, 1.15, kk)
        wrap_fill(gum, np.stack([stamp[0] + np.cos(ang) * rad, stamp[1] + np.sin(ang) * rad], -1), r.uniform(0.4, 1.0))
    gum = np.clip(blur(gum, 0.7), 0, 1)
    pcol = lerp(pcol, srgb('#5d5a55'), gum * 0.55)
    # paver height: top surface tilt (+-0.5 deg), slight random settlement, chamfer, chips, skin relief
    dxp = lx - L * 0.5; dyp = ly - Wd * 0.5
    ph = (tiltx[pid] * dxp + tilty[pid] * dyp) * 0.006 * mm                 # ~0.35 deg tilt (px -> mm)
    ph = ph + sink[pid] * 0.5 + macro * 2.5 - newer[pid] * 0.0
    ph = ph + skin * 0.08 + fine * 0.05 + agg * wear * 0.12 - pores * 0.4
    top = ph - (1 - bevel) * 4.0
    # cracked pavers: one crack across the stone
    crk = np.zeros(shape, np.float32)
    for p in np.nonzero(cracked)[0]:
        rr_, cc_ = divmod(p, ncol)
        y0 = rr_ * Wd; x0 = cc_ * L - (rr_ % 2) * L * 0.5 - rjit[rr_]
        if r.random() < 0.7:
            xa = x0 + r.uniform(0.25, 0.75) * L; P = crack_path(r, xa, y0 - 2, np.pi / 2 + r.normal(0, 0.3), Wd + 4, 2.0, 0.15, 0.2, 0.3)
        else:
            ya = y0 + r.uniform(0.3, 0.7) * Wd; P = crack_path(r, x0 - 2, ya, r.normal(0, 0.15), L + 4, 2.0, 0.12, 0.2, 0.3)
        wrap_lines(crk, [P], 1.0, 1)
    crk = np.clip(crk, 0, 1) * inside
    top = top - crk * 2.5
    pcol = lerp(pcol, srgb('#45423c'), crk * 0.75)
    # ---------------- joints: compacted sand + dirt, a few dry weeds and moss
    jfill = colorize(np.clip(0.5 + 0.3 * spec(shape, seed + 9, px(0.004), px(0.05), 1.2), 0, 1),
                     [(0, '#4a4438'), (0.5, '#5f584a'), (1, '#7a7160')])
    jsand = (r.random(shape) ** 6).astype(np.float32)
    jfill = lerp(jfill, srgb('#9a9180'), jsand * 0.5)
    jh = -6.0 + spec(shape, seed + 10, 0, px(0.004), 0.6) * 0.6
    # weeds: sparse tufts along joints (dry olive / straw), late autumn
    wz = smoothstep(1.4, 2.3, spec(shape, seed + 11, px(0.08), px(0.6), 1.8) + 0.4 * spec(shape, seed + 12, px(0.02), px(0.08), 1.2))
    jm = 1 - inside
    weed = np.zeros(shape, np.float32); wtone = np.zeros(shape, np.float32)
    ys, xs = np.nonzero((wz > 0.3) & (jm > 0.5))
    if len(xs):
        pick = r.choice(len(xs), size=min(len(xs), int(tile_m * tile_m * 60)), replace=False)
        for i in pick:
            x0, y0 = xs[i], ys[i]
            for b in range(r.integers(2, 6)):
                a = r.uniform(0, 2 * np.pi); l = px(r.uniform(0.01, 0.035))
                P = np.array([(x0, y0), (x0 + np.cos(a) * l * 0.5 + r.normal(0, 1), y0 + np.sin(a) * l * 0.5 + r.normal(0, 1)),
                              (x0 + np.cos(a) * l, y0 + np.sin(a) * l)], np.float32)
                v = r.uniform(0.0, 1.0)
                wrap_lines(weed, [P], 1.0, 1); wrap_lines(wtone, [P], v, 1)
    weed = np.clip(weed, 0, 1); wtone = np.clip(wtone, 0, 1)
    moss = np.clip(blur(jm, 3) * 1.6, 0, 1) * smoothstep(0.8, 1.8, spec(shape, seed + 13, px(0.05), px(0.5), 1.8))
    alb = lerp(jfill, pcol, inside)
    alb = lerp(alb, srgb('#4f5236'), moss * 0.35)
    alb = lerp(alb, colorize(wtone, [(0, '#4b5230'), (0.45, '#666a3e'), (0.75, '#857b52'), (1, '#9c8f66')]), weed * 0.85)
    hgt = lerp(jh, top, inside) + weed * 2.5
    # ---------------- leaf bits and litter (sparse)
    leaf = np.zeros(shape, np.float32); lt = np.zeros(shape, np.float32)
    for k in range(int(tile_m * tile_m * 3)):
        x, y = r.uniform(0, S), r.uniform(0, S); s_ = px(r.uniform(0.01, 0.03)); a = r.uniform(0, 2 * np.pi)
        kk = r.integers(5, 8); ang = a + np.linspace(0, 2 * np.pi, kk, endpoint=False)
        rad = s_ * r.uniform(0.5, 1.0, kk) * np.where(np.arange(kk) % 2 == 0, 1.0, 0.55)
        poly = np.stack([x + np.cos(ang) * rad, y + np.sin(ang) * rad * 0.7], -1)
        wrap_fill(leaf, poly, 1.0); wrap_fill(lt, poly, r.uniform(0.2, 1.0))
    leaf = np.clip(leaf, 0, 1)
    alb = lerp(alb, colorize(np.clip(lt, 0, 1), [(0, '#4a3a28'), (0.5, '#705a38'), (1, '#8c7646')]), leaf * 0.8)
    hgt = hgt + leaf * 0.6
    # ---------------- shrapnel chips: fresh lighter concrete with dark pit
    scar = np.zeros(shape, np.float32); pit = np.zeros(shape, np.float32)
    for k in range(int(tile_m * tile_m * 1.2)):
        cx, cy, rr = r.uniform(0, S), r.uniform(0, S), px(r.uniform(0.006, 0.02))
        kk = 7; ang = np.linspace(0, 2 * np.pi, kk, endpoint=False); rad = rr * r.uniform(0.6, 1.3, kk)
        P = np.stack([cx + np.cos(ang) * rad, cy + np.sin(ang) * rad], -1)
        wrap_fill(scar, P, 1.0); wrap_fill(pit, (P - [cx, cy]) * 0.4 + [cx, cy], 1.0)
    scar = np.clip(scar, 0, 1) * inside; pit = np.clip(pit, 0, 1) * inside
    alb = lerp(alb, srgb('#c3beb3'), np.clip(scar - pit, 0, 1) * 0.5)
    alb = lerp(alb, srgb('#5a5650'), pit * 0.6)
    hgt = hgt - scar * 1.2 - pit * 1.5
    # ---------------- finish
    hp = hgt / mm
    ao = cavity_ao(hp, 2, 0.25) * cavity_ao(hp, 8, 0.08)
    alb = alb * bake_shade(hp, 0.4, 0.2) * (0.82 + 0.18 * ao)[..., None]
    rough = 0.86 + 0.04 * fine - agg * wear * 0.05 + (1 - inside) * 0.1 - newer[pid] * 0.03 + soil * 0.03
    rough = lerp(rough, 0.6, gum * 0.6)
    nrm = normal_from_height(hp, 1.0)
    save_jpg_set('concrete', np.clip(alb, 0, 1), nrm, ao, np.clip(rough, 0.3, 1))
    return alb, hp, rough


# ------------------------------------------------------------------ curb stone
def tex_curb(S=1024, seed=501):
    """Precast concrete kerb stone, one 0.98 m stone per texture (BoxGeometry default UVs: every face gets the full
    image). Authored isotropic at 1 m x 0.21 m, then stretched to S x S. V: 0 = bottom edge of the side faces
    (road grime, tyre rub), 1 = top arris (worn, chipped). Both ends: chipped, darker joint dirt."""
    ppm = S / 1.0
    h = int(round(0.21 * ppm)); shape = (h, S); px = lambda m: m * ppm; mm = 1000.0 / ppm
    r = rng(seed)
    yy, xx = np.mgrid[0:h, 0:S].astype(np.float32)
    v = 1 - yy / (h - 1)            # image row 0 = top of the face = v 1
    fine = spec(shape, seed + 1, 0, px(0.002), 0.3)
    skin = spec(shape, seed + 2, px(0.003), px(0.03), 1.3)
    mid = spec(shape, seed + 3, px(0.03), px(0.25), 1.8)
    macro = spec(shape, seed + 4, px(0.1), px(0.6), 2.0)
    base = colorize(np.clip(0.5 + 0.1 * skin + 0.08 * fine + 0.12 * mid + 0.1 * macro, 0, 1),
                    [(0, '#7b7871'), (0.4, '#949089'), (0.75, '#a7a39a'), (1, '#b7b3a9')])
    # exposed aggregate (weathered cast concrete: gravel 5-20 mm shows through the cement skin)
    F1, F2, gid, _ = cells(shape, px(0.012), seed + 5, warp=px(0.002), lam=px(0.02))
    ng = gid.max() + 1
    agg = np.clip((F2 - F1) / px(0.003), 0, 1) ** 0.6 * (r.random(ng) < 0.4)[gid]
    wear = smoothstep(-0.6, 1.4, mid * 0.6 + macro * 0.4)
    acol = colorize(r.random(ng).astype(np.float32)[gid], [(0, '#64605a'), (0.5, '#8e8a82'), (0.85, '#aca69b'), (1, '#8a7466')])
    alb = lerp(base, acol, agg * wear * 0.6)
    pores = np.clip(blur((r.random(shape) < 0.006).astype(np.float32), 0.7) * 5, 0, 1)
    alb = lerp(alb, srgb('#4f4c47'), pores * 0.55)
    hgt = skin * 0.15 + mid * 0.6 + agg * wear * 0.6 - pores * 0.6
    # arris wear / chips along the top edge (v -> 1) and both ends
    chipn = spec(shape, seed + 6, px(0.01), px(0.06), 1.3)
    dtop = (1 - v) * 0.21; dend = np.minimum(xx, S - 1 - xx) / ppm
    chip = (dtop < 0.008 + np.clip(chipn, 0, None) * 0.006) | (dend < 0.006 + np.clip(chipn - 0.3, 0, None) * 0.01)
    chip = blur(chip.astype(np.float32), 1.0)
    alb = lerp(alb, srgb('#8f8a82'), chip * 0.5)
    hgt -= chip * 2.5
    # bottom (road side) grime, tyre rub marks, splash
    grime = (1 - smoothstep(0.0, 0.45, v)) * (0.6 + 0.4 * smoothstep(-1, 1, mid))
    alb = lerp(alb, srgb('#4b4741'), grime * 0.55)
    rub = smoothstep(0.8, 2.2, blur(spec(shape, seed + 7, px(0.01), px(0.3), 1.6), (0.5, 25))) * (1 - smoothstep(0.05, 0.4, v))
    alb = lerp(alb, srgb('#2e2d2a'), rub * 0.3)
    # end-joint dirt, faint old whitewash residue in the pores, streaks running down
    alb = alb * (1 - 0.25 * (1 - smoothstep(0.0, 0.02, dend)))[..., None]
    wash = smoothstep(0.9, 1.8, spec(shape, seed + 8, px(0.03), px(0.3), 1.6)) * (0.4 + 0.6 * (1 - agg))
    alb = lerp(alb, srgb('#c9c6bd'), wash * 0.18)
    streak = blur(spec(shape, seed + 9, px(0.002), px(0.05), 1.0), (6, 0.6))
    alb = alb * (1 - 0.05 * np.clip(streak, 0, 2))[..., None]
    hp = hgt / mm
    ao = cavity_ao(hp, 2, 0.3) * cavity_ao(hp, 8, 0.08)
    alb = alb * (0.85 + 0.15 * ao)[..., None]
    rough = np.clip(0.9 + 0.03 * fine - rub * 0.15 - agg * wear * 0.05, 0.3, 1)
    nrm = normal_from_height(hp, 1.0, wrap=False)
    # stretch the isotropic 1 m x 0.21 m stone to the square image (vectors stay physically correct)
    sq = lambda a: cv2.resize(a, (S, S), interpolation=cv2.INTER_CUBIC)
    save_jpg_set('curb', np.clip(sq(alb), 0, 1), sq(nrm), np.clip(sq(ao), 0, 1), np.clip(sq(rough), 0, 1),
                 size=S, orm_size=S // 2, nblur=0)
    return alb
