"""Shared design data for the city additions to the panel kit (brick 1-447 walls, shopfront ground floors,
shop signs). Geometry (kit_city_parts.py) and the second kit atlas (city_kit_atlas.py) use the same shapes.

Same module as the large-panel kit: W = 3.2, H = 2.8, T = 0.3; panel coords x 0..W (left->right seen from
outside), y 0..H, z 0 (outside face) .. -T (room side).

Series 1-447 (and the similar 1-511/1-439): 4-5 storey brick khrushchyovkas, 380-510 mm walls of white silicate or
red ceramic brick, stretcher bond with a header course every ~6 rows, visible precast concrete lintels over the
openings, galvanised sills, concrete balcony slabs with steel railings, ground-floor flats converted to shops
(cladding, big glazing, roller shutters, box signs on the fascia).
"""
import numpy as np
from meshlib import blob, rng
from kit_design import W, H, T

# brick coursing: 36 courses per storey (65 mm brick + ~13 mm joint), 12 stretchers per module
COURSE = H / 36.0                 # 0.0778
PITCH = W / 12.0                  # 0.2667 (250 mm brick + joint)
HALF = PITCH / 2
HEADER_EVERY = 6                  # header (bond) course every 6th row

COLOURS = ['white', 'red']        # white silicate / red ceramic brick
BTYPES = ['window', 'balcony', 'blank_end', 'entrance']
STATES = ['intact', 'damaged', 'holed', 'destroyed']

OPEN_BRICK = {   # same openings as the panel kit so the game's window / door logic is shared
    'window': [('window', (0.85, 0.86, 2.35, 2.30))],
    'balcony': [('door', (0.42, 0.10, 1.16, 2.30)), ('window', (1.34, 0.86, 2.78, 2.30))],
    'blank_end': [],
    'entrance': [('entrance', (0.95, 0.04, 2.25, 2.18))],
}
LINTEL_H = 0.22                   # visible precast lintel over openings (concrete, flush with the brick)
LINTEL_EXT = 0.25                 # bearing length beyond the opening edges

SHOP_TYPES = ['shopfront', 'shopfront_shutter']
OPEN_SHOP = {
    # glazed door on the left + display window; fascia 2.08..2.8 carries the sign
    'shopfront': [('shopdoor', (0.22, 0.04, 1.12, 2.08)), ('display', (1.30, 0.40, 3.00, 2.08))],
    # one wide opening closed by a roller shutter (box at the head)
    'shopfront_shutter': [('shutter', (0.20, 0.04, 3.00, 2.08))],
}
SIGN_Y = 2.14                     # bottom of a sign mounted on a shopfront panel (panel coords)

# shop signs: (node suffix, text, style, length m). Ukrainian forms, generic, no brands.
SIGNS = [
    ('apteka', 'АПТЕКА', 'pharmacy', 2.6),
    ('produkty', 'ПРОДУКТИ', 'blue', 3.0),
    ('khlib', 'ХЛІБ', 'bread', 2.0),
    ('magazyn', 'МАГАЗИН', 'red', 2.8),
    ('perukarnia', 'ПЕРУКАРНЯ', 'pink', 3.0),
    ('gospodarchi', 'ГОСПОДАРЧІ ТОВАРИ', 'green', 3.0),
    ('kafe', 'КАФЕ', 'cafe', 2.2),
    ('kvity', 'КВІТИ', 'flowers', 2.0),
    ('ovochi', 'ОВОЧІ · ФРУКТИ', 'veg', 3.0),
    ('zootovary', 'ЗООТОВАРИ', 'orange', 2.8),
]
SIGN_H = 0.62


# ------------------------------------------------------------------ shell holes
def _clean_poly(poly):
    from shapely.geometry import Polygon
    poly = poly.buffer(0)
    if poly.geom_type != 'Polygon':
        poly = max(poly.geoms, key=lambda g: g.area)
    poly = poly.simplify(0.002)
    P = np.array(poly.exterior.coords)[:-1]
    if np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1]) < 0:
        P = P[::-1]
    keep = [0]
    for i in range(1, len(P)):
        if np.linalg.norm(P[i] - P[keep[-1]]) > 0.012:
            keep.append(i)
    if np.linalg.norm(P[keep[-1]] - P[0]) < 0.012 and len(keep) > 3:
        keep.pop()
    return P[keep]


def _merge_openings(poly, openings):
    from shapely.geometry import box
    from shapely.ops import unary_union
    merged, remaining, rects = [], [], []
    for kind, (x0, y0, x1, y1) in openings:
        rb = box(x0, y0, x1, y1)
        if rb.intersects(poly):
            poly = unary_union([poly, rb]); merged.append(kind); rects.append((x0, y0, x1, y1))
        else:
            remaining.append((kind, (x0, y0, x1, y1)))
    return poly, merged, remaining, rects


def _broken_mask(P, rects):
    def on_rect(p):
        for (x0, y0, x1, y1) in rects:
            if (x0 - 1e-4 <= p[0] <= x1 + 1e-4 and y0 - 1e-4 <= p[1] <= y1 + 1e-4) and \
               min(abs(p[0] - x0), abs(p[0] - x1), abs(p[1] - y0), abs(p[1] - y1)) < 1e-4:
                return True
        return False
    return np.array([not on_rect(p) for p in P])


BRICK_HOLES = {   # blob centre / radii / seed per brick type
    'window': (1.95, 0.8, 0.75, 0.55, 811),
    'balcony': (1.25, 1.05, 0.62, 0.7, 812),
    'entrance': (2.35, 1.9, 0.6, 0.5, 813),
    'blank_end': (1.5, 1.45, 0.85, 0.72, 814),
}


def brick_hole(t, full=False):
    """Shell hole in a brick wall: blob quantised to brick courses / joints -> stair-stepped outline,
    unioned with any opening it touches. Returns CCW outline (or dict like kit_design.hole_poly)."""
    from shapely.geometry import Polygon, box
    from shapely.ops import unary_union
    cx, cy, rx, ry, seed = BRICK_HOLES[t]
    r = rng(seed)
    B = Polygon(blob(cx, cy, rx, ry, 48, seed, rough=0.3, spikes=0.2)).buffer(0)
    rows = []
    for j in range(36):
        y0, y1 = j * COURSE, (j + 1) * COURSE
        if y0 < 0.12 or y1 > H - 0.12:
            continue
        seg = B.intersection(box(-1, y0 + COURSE * 0.5 - 1e-3, W + 1, y0 + COURSE * 0.5 + 1e-3))
        if seg.is_empty:
            continue
        xl, _, xr, _ = seg.bounds
        off = 0.0 if j % 2 == 0 else HALF
        step = HALF if j % HEADER_EVERY == 0 else PITCH
        ql = off + np.floor((xl - off) / step + r.uniform(0.0, 0.6)) * step
        qr = off + np.ceil((xr - off) / step - r.uniform(0.0, 0.6)) * step
        ql, qr = max(ql, 0.14), min(qr, W - 0.14)
        if qr - ql > 0.1:
            rows.append(box(ql, y0, qr, y1))
    poly = unary_union(rows)
    if poly.geom_type != 'Polygon':
        poly = max(poly.geoms, key=lambda g: g.area)
    poly, merged, remaining, rects = _merge_openings(poly, OPEN_BRICK[t])
    P = _clean_poly(poly)
    if not full:
        return P
    return {'poly': P, 'broken': _broken_mask(P, rects), 'remaining': remaining, 'merged': merged, 'rects': rects}


def brick_stub(t, seed=900):
    """Remaining stub of a destroyed brick wall: stepped crumbled top (per half-brick column, quantised to
    courses) with a taller pier on one side. Returns CCW outline + broken flags (like kit_design.stub_outline)."""
    r = rng(seed + BTYPES.index(t))
    n = int(round(W / HALF))
    xs = np.arange(n + 1) * HALF
    xc = (xs[:-1] + xs[1:]) / 2
    base = 0.6 + 0.25 * np.sin(xc * 2.0 + r.uniform(0, 6)) + r.normal(0, 0.12, n)
    pier = np.clip((0.75 - xc) / 0.3, 0, 1) if t != 'balcony' else np.clip((xc - 2.55) / 0.3, 0, 1)
    top = base * (1 - pier) + (1.9 + r.normal(0, 0.15, n)) * pier
    for kind, (x0, y0, x1, y1) in OPEN_BRICK[t]:
        if kind in ('door', 'entrance'):
            m = (xc > x0) & (xc < x1)
            top[m] = np.minimum(top[m], y0 + COURSE)
    top = np.clip(np.round(top / COURSE) * COURSE, COURSE, H - 0.3)
    top[0] = max(top[0], 0.4); top[-1] = max(top[-1], 0.3)
    pts = [(0.0, 0.0), (W, 0.0)]
    for i in range(n - 1, -1, -1):
        pts.append((xs[i + 1], top[i])); pts.append((xs[i], top[i]))
    # merge collinear / duplicate points
    P = [pts[0], pts[1]]
    for p in pts[2:]:
        if abs(p[0] - P[-1][0]) < 1e-6 and abs(p[1] - P[-1][1]) < 1e-6:
            continue
        P.append(p)
    Q = [P[0], P[1]]
    for i in range(2, len(P)):
        a, b = Q[-1], P[i]
        if len(Q) >= 3:
            z = Q[-2]
            if (abs(z[0] - a[0]) < 1e-6 and abs(a[0] - b[0]) < 1e-6) or (abs(z[1] - a[1]) < 1e-6 and abs(a[1] - b[1]) < 1e-6):
                Q[-1] = b; continue
        Q.append(b)
    P = np.array(Q)
    broken = np.array([False, False] + [True] * (len(P) - 2))
    broken[2] = False; broken[-1] = False
    return P, broken


SHOP_HOLES = {
    'shopfront': (2.2, 1.35, 0.7, 0.6, 821),
    'shopfront_shutter': (1.75, 2.15, 0.85, 0.5, 822),
}


def shop_hole(t, full=False):
    from shapely.geometry import Polygon
    cx, cy, rx, ry, seed = SHOP_HOLES[t]
    B = blob(cx, cy, rx, ry, 52, seed, rough=0.32, spikes=0.25)
    B[:, 0] = np.clip(B[:, 0], 0.16, W - 0.16); B[:, 1] = np.clip(B[:, 1], 0.06, H - 0.14)
    poly, merged, remaining, rects = _merge_openings(Polygon(B).buffer(0), OPEN_SHOP[t])
    P = _clean_poly(poly)
    if not full:
        return P
    return {'poly': P, 'broken': _broken_mask(P, rects), 'remaining': remaining, 'merged': merged, 'rects': rects}


def shop_stub(t, seed=930):
    r = rng(seed + SHOP_TYPES.index(t))
    xs = np.linspace(W, 0, 20)
    top = 0.45 + 0.2 * np.sin(xs * 2.3 + r.uniform(0, 6)) + r.normal(0, 0.08, len(xs))
    col = np.clip((0.3 - xs) / 0.2, 0, 1) + np.clip((xs - 2.95) / 0.2, 0, 1)
    top = top * (1 - np.clip(col, 0, 1)) + 1.7 * np.clip(col, 0, 1)
    for kind, (x0, y0, x1, y1) in OPEN_SHOP[t]:
        m = (xs > x0 + 0.05) & (xs < x1 - 0.05)
        top[m] = np.minimum(top[m], max(y0, 0.03) + 0.02 + np.abs(r.normal(0, 0.03, m.sum())))
    top = np.clip(top, 0.03, H - 0.3); top[0] = max(top[0], 0.5); top[-1] = max(top[-1], 0.5)
    pts = [(0.0, 0.0), (W, 0.0)] + [(x, y) for x, y in zip(xs, top)]
    broken = [False, False] + [True] * len(xs); broken[2] = False; broken[-1] = False
    return np.array(pts), np.array(broken)
