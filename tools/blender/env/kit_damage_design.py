"""Damage-variant designs for the wall kit (shared by kit_damage_atlas.py and kit_damage.py; no bpy).

For every wall type with *_holed / *_destroyed pieces (wall_window, wall_balcony, wall_blank_end, wall_entrance,
brick_*, brick_red_*, wall_shopfront, wall_shopfront_shutter) this defines four extra variants:
  <type>_holed_v2     off-centre shell hole + corner bite + spalled face (panel: outer concrete layer blown off,
                      mineral wool exposed; brick: outer half-brick wythe gone)
  <type>_holed_v3     hole through the spandrel / half-panel blow-out / big off-centre hole + (panels) a through-crack
                      splitting the panel, the smaller piece displaced outward
  <type>_destroyed_v2 blown-out panel: ragged remnant column on one side, thin ragged top band, low kerb
  <type>_destroyed_v3 blown-out panel: wide lintel band, spandrel remnant on the other side, narrow edge strip
Destroyed variants are framed by structure in kit_damage.py (ceiling-slab edge band, floor screed edge, transverse
wall ends for panels, hanging rebar and fragments), so nothing reads as a floating cut-out.

design(prefix, state, v) -> dict:
  fam ('panel' | 'brick' | 'shop'), t (type key), colour, openings [(kind, rect)],
  solid    shapely (Multi)Polygon of the remaining wall (outline incl. bites, minus voids and openings)
  voids    list of Nx2 arrays: through-damage outlines clipped to the panel (for the atlas painter)
  spalls   list of shapely Polygons (partial-depth damage, inside `solid` holes)
  crack    None or dict(line=Nx2 polyline, gap=m, move=piece index displaced)
  frags    hanging fragments: list of dict(poly=Nx2 outline at its original place, hinge=(x, y), ang, side)
"""
import math
import numpy as np
from shapely.geometry import Polygon, MultiPolygon, box, LineString, Point
from shapely.ops import unary_union
from meshlib import blob, rng, noise1d
from kit_design import W, H, T, OPEN, TYPES
from city_kit_design import COURSE, PITCH, HALF, HEADER_EVERY, OPEN_BRICK, OPEN_SHOP, BTYPES, SHOP_TYPES

VARIANTS = ['v2', 'v3']
DSTATES = ['holed', 'destroyed']


def all_types():
    """(prefix, family, type key, colour) for every wall type that has damage states."""
    out = [(t, 'panel', t, None) for t in TYPES]
    out += [('brick_' + t, 'brick', t, 'white') for t in BTYPES]
    out += [('brick_red_' + t, 'brick', t, 'red') for t in BTYPES]
    out += [('wall_' + t, 'shop', t, None) for t in SHOP_TYPES]
    return out


TYPE_INFO = {p: (f, t, c) for p, f, t, c in all_types()}


def openings(fam, t):
    return OPEN[t] if fam == 'panel' else OPEN_BRICK[t] if fam == 'brick' else OPEN_SHOP[t]


def seed_of(*parts):
    return sum((i + 1) * 131 * ord(ch) for i, ch in enumerate('_'.join(map(str, parts)))) % 100003


def rblob(cx, cy, rx, ry, seed, rough=0.32, notches=7, step=0.065):
    """Ragged shell-hole blob; vertex count from the perimeter (~6.5 cm spacing)."""
    per = math.pi * (3 * (rx + ry) - math.sqrt((3 * rx + ry) * (rx + 3 * ry)))
    n = int(np.clip(per / step, 18, 90))
    r = rng(seed)
    P = blob(cx, cy, rx, ry, n, seed, rough=rough, spikes=0.25)
    c = np.array([cx, cy])
    for k in r.integers(0, n, notches):
        P[k] = c + (P[k] - c) * r.uniform(0.82, 1.2)
    return Polygon(P).buffer(0)


def ragged_line(p0, p1, seed, amp=0.08, step=0.07, ends=True):
    """Points along p0->p1 with smooth + jagged lateral noise (zero at the ends if ends)."""
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    L = np.linalg.norm(p1 - p0); n = max(3, int(L / step))
    t = np.linspace(0, 1, n + 1)
    nr = np.array([-(p1 - p0)[1], (p1 - p0)[0]]) / (L + 1e-9)
    r = rng(seed)
    off = noise1d(n + 1, seed, 3, closed=False) * amp + r.normal(0, amp * 0.3, n + 1)
    if ends:
        off *= np.sin(np.pi * t) ** 0.3
    return p0[None] + (p1 - p0)[None] * t[:, None] + nr[None] * off[:, None]


def band_poly(xs_y, top=True, y_edge=H):
    """Polygon between a ragged profile [(x, y)...] (x ascending 0..W) and the panel top (or bottom) edge."""
    pts = [tuple(p) for p in xs_y]
    if top:
        return Polygon(pts + [(W, y_edge), (0, y_edge)]).buffer(0)
    return Polygon([(0, y_edge), (W, y_edge)] + pts[::-1]).buffer(0)


def profile(x0, x1, base, amp, seed, step=0.1, lo=0.0, hi=H):
    n = max(3, int((x1 - x0) / step))
    xs = np.linspace(x0, x1, n + 1)
    r = rng(seed)
    y = base + noise1d(n + 1, seed, 3, closed=False) * amp + r.normal(0, amp * 0.25, n + 1)
    return np.stack([xs, np.clip(y, lo, hi)], -1)


def column(side, w_base, amp, seed, y0=0.0, y1=H, step=0.1):
    """Ragged side remnant column (side 'L' -> x 0..w, 'R' -> x W-w..W)."""
    n = max(3, int((y1 - y0) / step))
    ys = np.linspace(y0, y1, n + 1)
    r = rng(seed)
    wv = np.clip(w_base + noise1d(n + 1, seed, 3, closed=False) * amp + r.normal(0, amp * 0.3, n + 1), 0.04, W * 0.6)
    if side == 'L':
        return Polygon([(0, y0)] + [(w, y) for w, y in zip(wv, ys)] + [(0, y1)]).buffer(0)
    return Polygon([(W, y0), (W, y1)] + [(W - w, y) for w, y in zip(wv[::-1], ys[::-1])]).buffer(0)


def brickify(poly, seed, solid_side=False):
    """Quantise a void outline to brick courses / half-brick joints (stair-stepped masonry break)."""
    r = rng(seed)
    rows = []
    for j in range(36):
        y0, y1 = j * COURSE, (j + 1) * COURSE
        seg = poly.intersection(box(-1, y0 + COURSE * 0.5 - 1e-3, W + 1, y0 + COURSE * 0.5 + 1e-3))
        if seg.is_empty:
            continue
        geoms = getattr(seg, 'geoms', [seg])
        off = 0.0 if j % 2 == 0 else HALF
        step = HALF if j % HEADER_EVERY == 0 else PITCH
        for g in geoms:
            xl, _, xr, _ = g.bounds
            ql = off + np.floor((xl - off) / step + r.uniform(0.0, 0.6)) * step
            qr = off + np.ceil((xr - off) / step - r.uniform(0.0, 0.6)) * step
            if qr - ql > 0.08:
                rows.append(box(ql, y0 - (1e-4 if j else 0.5), qr, y1 + (1e-4 if j < 35 else 0.5)))
    if not rows:
        return poly
    return unary_union(rows).buffer(0)


def _clean(g, min_area=0.03):
    """Drop slivers and any remnant that is not tied to the panel border (it would float)."""
    g = g.buffer(0)
    edge = box(0, 0, W, H).exterior
    polys = [p for p in getattr(g, 'geoms', [g]) if p.geom_type == 'Polygon' and p.area > min_area and p.distance(edge) < 0.02]
    return MultiPolygon(polys) if len(polys) != 1 else polys[0]


def simplify_ring(P, tol=0.004):
    return np.array(Polygon(P).simplify(tol).exterior.coords)[:-1]


# ------------------------------------------------------------------ per-type recipes
# positions are chosen to differ from the v1 hole (kit_design.HOLES / city_kit_design.BRICK_HOLES / SHOP_HOLES)
HOLED = {
    # family-agnostic type key -> v2: main hole (cx, cy, rx, ry), bite (corner x, y, rx, ry), spall (cx, cy, rx, ry)
    #                              v3: big damage (kind, params), crack polyline (panels)
    'window': dict(
        v2=dict(hole=(0.72, 2.18, 0.48, 0.36), bite=(W, 0.0, 0.62, 0.5), spall=(2.55, 0.48, 0.42, 0.3)),
        v3=dict(big=('blob', 1.45, 0.42, 0.78, 0.34), extra=('bite', 0.0, H, 0.42, 0.38), crack=[(2.9, -0.1), (2.62, 0.5), (2.28, 1.0)])),
    'balcony': dict(
        v2=dict(hole=(2.55, 0.42, 0.42, 0.32), bite=(0.0, H, 0.5, 0.45), spall=(1.6, 0.44, 0.32, 0.27)),
        v3=dict(big=('blob', 0.8, 1.55, 0.5, 0.62), extra=('bite', W, 0.0, 0.4, 0.42), crack=[(1.95, H + 0.1), (2.05, 2.55), (2.12, 2.2)])),
    'blank_end': dict(
        v2=dict(hole=(2.3, 2.0, 0.55, 0.45), bite=(0.0, 0.0, 0.62, 0.55), spall=(1.0, 1.35, 0.5, 0.42)),
        v3=dict(big=('rect', 1.62, 0.32, 3.2, 2.5), extra=None, crack=[(-0.1, 1.9), (0.7, 1.55), (1.8, 1.45)])),
    'entrance': dict(
        v2=dict(hole=(0.48, 1.25, 0.36, 0.6), bite=(W, H, 0.55, 0.42), spall=(1.6, 2.5, 0.42, 0.2)),
        v3=dict(big=('blob', 2.62, 1.0, 0.45, 0.62), extra=('bite', 0.0, H, 0.5, 0.36), crack=[(-0.1, 0.7), (0.45, 1.25), (1.06, 1.5)])),
    'shopfront': dict(
        v2=dict(hole=(0.62, 2.45, 0.45, 0.32), bite=(W, 0.0, 0.42, 0.45), spall=(1.2, 0.2, 0.25, 0.16)),
        v3=dict(big=('rect', 1.3, 0.05, 3.2, 2.35), extra=None, crack=None)),
    'shopfront_shutter': dict(
        v2=dict(hole=(0.7, 1.05, 0.55, 0.55), bite=(W, H, 0.45, 0.4), spall=(2.4, 2.45, 0.4, 0.2)),
        v3=dict(big=('blob', 2.3, 1.1, 0.75, 0.75), extra=('bite', 0.0, H, 0.45, 0.4), crack=None)),
}

DESTROYED = {
    # v2: remnant column side + width, top band base height, kerb base; v3 the opposite arrangement
    'v2': dict(col='L', colw=0.78, colamp=0.22, edge=0.12, band=0.2, bandamp=0.13, kerb=0.18, kerbamp=0.12, frag='band'),
    'v3': dict(col='R', colw=0.55, colamp=0.2, edge=0.06, band=0.46, bandamp=0.12, kerb=0.62, kerbamp=0.2, frag='col'),
}


def _key(fam, t):
    return t.replace('wall_', '') if fam == 'panel' else t


def design(prefix, state, v):
    fam, t, colour = TYPE_INFO[prefix]
    k = _key(fam, t)
    ops = openings(fam, t)
    s = seed_of(prefix, state, v)
    r = rng(s)
    panel = box(0, 0, W, H)
    rects = [box(*rc) for _, rc in ops]
    voids, spalls, crack, frags = [], [], None, []
    if state == 'holed':
        R = HOLED[k][v]
        parts = []
        if v == 'v2':
            cx, cy, rx, ry = R['hole']; parts.append(rblob(cx, cy, rx, ry, s + 1))
            bx, by, rx, ry = R['bite']; parts.append(rblob(bx, by, rx, ry, s + 2, rough=0.38))
            cx, cy, rx, ry = R['spall']
            sp = rblob(cx, cy, rx, ry, s + 3, rough=0.4, notches=4)
        else:
            big = R['big']
            if big[0] == 'blob':
                parts.append(rblob(*big[1:5], s + 1, rough=0.3))
            else:   # ragged rectangle: half-panel blow-out
                x0, y0, x1, y1 = big[1:5]
                L_ = ragged_line((x0, y0), (x0, y1), s + 1, 0.1)
                Tp = ragged_line((x0, y1), (min(x1, W - 0.12), y1), s + 2, 0.08)
                Rr = ragged_line((min(x1, W - 0.12), y1), (min(x1, W - 0.12), y0), s + 3, 0.06) if x1 < W else np.array([(W + 0.3, y1), (W + 0.3, y0)])
                Bt = ragged_line((min(x1, W - 0.12) if x1 < W else W + 0.3, y0), (x0, y0), s + 4, 0.07)
                parts.append(Polygon(np.concatenate([L_, Tp, Rr, Bt])).buffer(0))
            if R.get('extra'):
                _, bx, by, rx, ry = R['extra']; parts.append(rblob(bx, by, rx, ry, s + 5, rough=0.38))
            sp = None
            if R.get('crack') and fam == 'panel':
                crack = dict(line=np.array(R['crack'], float), gap=0.022, seed=s + 6)
        void = unary_union(parts).intersection(box(-0.5, -0.5, W + 0.5, H + 0.5))
        # keep the panel bottom edge sound under shopfront / entrance doors (threshold slab)
        if fam == 'brick' or fam == 'shop':
            void = brickify(void, s + 7)
            if sp is not None:
                sp = brickify(sp, s + 8)
        # merge openings the damage touches
        for rb in rects:
            if rb.intersects(void.buffer(0.03)):
                void = unary_union([void, rb])
        solid = panel.difference(void)
        for rb in rects:
            solid = solid.difference(rb)
        if sp is not None:
            sp = sp.intersection(solid.buffer(-0.12))
            if not sp.is_empty and sp.area > 0.05:
                sp = max(getattr(sp, 'geoms', [sp]), key=lambda g: g.area)
                solid = solid.difference(sp)
                spalls.append(sp)
        if crack is not None:
            line = ragged_line(crack['line'][0], crack['line'][1], s + 11, 0.03, 0.06)
            line = np.concatenate([line, ragged_line(crack['line'][1], crack['line'][2], s + 12, 0.03, 0.06)[1:]])
            crack['line'] = line
            solid = solid.difference(LineString(line).buffer(crack['gap'] / 2, join_style=2))
        solid = _clean(solid.buffer(-0.025, join_style=2).buffer(0.025, join_style=2))
        if crack is not None:
            ps = polys_of(solid)
            crack['move'] = int(np.argmin([q.area for q in ps])) if len(ps) > 1 else None
        vv = void.intersection(panel)
        voids = [np.array(g.exterior.coords)[:-1] for g in getattr(vv, 'geoms', [vv]) if g.area > 0.01]
    else:
        D = DESTROYED[v]
        side = D['col'] if k != 'balcony' else ('R' if D['col'] == 'L' else 'L')
        keep = []
        # top band (lintel strip still welded to the slab), ragged lower edge; broken through in places
        band = profile(0, W, H - D['band'], D['bandamp'], s + 1, lo=H - 0.62, hi=H - 0.05)
        gaps = r.integers(0, len(band), 2)
        for g_ in gaps:     # band snapped right up to the slab over a short run
            lo_, hi_ = max(0, g_ - 2), min(len(band), g_ + 3)
            band[lo_:hi_, 1] = H + 0.02
        keep.append(band_poly(band, top=True))
        # kerb (lower panel edge bearing on the floor slab)
        kerb = profile(0, W, D['kerb'], D['kerbamp'], s + 2, lo=-0.02, hi=1.05)
        if v == 'v3':      # spandrel remnant rises towards the column side
            ramp = np.clip((kerb[:, 0] - 1.2) / 1.6, 0, 1) if side == 'R' else np.clip((2.0 - kerb[:, 0]) / 1.6, 0, 1)
            kerb[:, 1] = np.clip(kerb[:, 1] * (0.3 + 0.9 * ramp), -0.02, 1.0)
        keep.append(band_poly(kerb, top=False, y_edge=0.0))
        keep.append(column(side, D['colw'], D['colamp'], s + 3))
        keep.append(column('R' if side == 'L' else 'L', D['edge'], 0.05, s + 4))
        solid = unary_union(keep).intersection(panel)
        for kind, rc in ops:     # doors / entrances leave a threshold, no kerb
            rb = box(*rc)
            if kind in ('door', 'entrance', 'shopdoor', 'shutter'):
                solid = solid.difference(box(rc[0], -0.1, rc[2], rc[3]))
            else:
                solid = solid.difference(rb)
        if fam in ('brick', 'shop'):
            vq = brickify(panel.difference(solid), s + 5)
            solid = panel.difference(vq)
            for kind, rc in ops:
                solid = solid.difference(box(rc[0], -0.1 if kind in ('door', 'entrance', 'shopdoor', 'shutter') else rc[1], rc[2], rc[3]))
        solid = _clean(solid.buffer(-0.03, join_style=2).buffer(0.03, join_style=2), 0.02 if fam == 'panel' else 0.035)
        vv = panel.difference(solid)
        voids = [np.array(g.exterior.coords)[:-1] for g in getattr(vv, 'geoms', [vv]) if g.area > 0.01]
        # hanging fragment: a piece of the panel that broke off below the band / beside the column
        if D['frag'] == 'band':
            fx = 1.25 + r.uniform(-0.2, 0.25); fy = H - D['band'] - 0.08
            frag = rblob(fx + 0.32, fy - 0.3, 0.36, 0.28, s + 9, rough=0.35, notches=4)
            hinge = (fx + 0.32, fy - 0.05)
        else:
            cxp = W - D['colw'] - 0.25 if side == 'R' else D['colw'] + 0.25
            frag = rblob(cxp, 1.5, 0.27, 0.42, s + 9, rough=0.35, notches=4)
            hinge = (cxp + (0.22 if side == 'R' else -0.22), 1.75)
        frags.append(dict(poly=np.array(frag.exterior.coords)[:-1], hinge=hinge, side=D['frag'], col=side))
    return dict(fam=fam, t=t, colour=colour, openings=ops, solid=solid, voids=voids, spalls=spalls, crack=crack,
                frags=frags, seed=s, prefix=prefix, state=state, v=v)


def polys_of(g):
    return [p for p in getattr(g, 'geoms', [g]) if p.geom_type == 'Polygon']


if __name__ == '__main__':
    for p, f, t, c in all_types():
        for st in DSTATES:
            for v in VARIANTS:
                d = design(p, st, v)
                ps = polys_of(d['solid'])
                print(f'{p}_{st}_{v}: pieces {len(ps)} area {d["solid"].area:.2f} holes {sum(len(q.interiors) for q in ps)} '
                      f'verts {sum(len(q.exterior.coords) + sum(len(i.coords) for i in q.interiors) for q in ps)} spalls {len(d["spalls"])}')
