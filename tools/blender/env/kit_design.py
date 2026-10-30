"""Shared design data for the panel kit (geometry + texture painter use the same shapes).

Module (contract, see ASSETS_SPEC.md): W = 3.2 m panel width (1-464 / II-49 transverse wall step 3.2 m),
H = 2.8 m storey height, T = 0.30 m three-layer exterior panel (60-80 mm outer concrete + ~120 mm mineral
wool + ~90 mm inner concrete). Panel coords: x 0..W (left->right seen from outside), y 0..H, z 0 (outside face)
.. -T (room side).
"""
import numpy as np
from meshlib import blob, rng, point_in_poly

W, H, T = 3.2, 2.8, 0.30
CHAMFER = 0.025          # V-groove chamfer on panel outer edges (joint between panels)
# depth layers of the 3-layer panel (used by broken edges and the section texture)
LAYER_OUT = 0.075        # outer concrete layer (with 5 mm ceramic tile skin)
LAYER_INS = 0.195        # insulation ends here
TYPES = ['wall_window', 'wall_balcony', 'wall_blank_end', 'wall_entrance']
STATES = ['intact', 'damaged', 'holed', 'destroyed']

# openings (x0, y0, x1, y1) in metres
OPEN = {
    'wall_window': [('window', (0.85, 0.86, 2.35, 2.30))],
    'wall_balcony': [('door', (0.42, 0.10, 1.16, 2.30)), ('window', (1.34, 0.86, 2.78, 2.30))],
    'wall_blank_end': [],
    'wall_entrance': [('entrance', (0.95, 0.04, 2.25, 2.18))],
}


def _rough_blob(cx, cy, rx, ry, seed, n=56, rough=0.3, notches=6):
    r = rng(seed)
    P = blob(cx, cy, rx, ry, n, seed, rough=rough, spikes=0.25)
    c = np.array([cx, cy])
    for k in r.integers(0, n, notches):          # sharp notches / cracks running out of the hole
        P[k] = c + (P[k] - c) * r.uniform(0.85, 1.18)
    return P


HOLES = {   # blob centre / radii per type; openings touched by the blob merge into the hole
    'wall_window': (2.02, 0.78, 0.72, 0.52, 501),
    'wall_balcony': (1.28, 1.05, 0.62, 0.72, 502),
    'wall_entrance': (2.3, 1.95, 0.62, 0.5, 503),
    'wall_blank_end': (1.45, 1.5, 0.82, 0.7, 504),
}


def hole_poly(t, full=False):
    """Shell hole for the *_holed state: irregular blob unioned with any opening it touches.
    Returns the outline (CCW). With full=True returns dict(poly, broken mask, remaining openings, merged kinds)."""
    from shapely.geometry import Polygon, box
    from shapely.ops import unary_union
    cx, cy, rx, ry, seed = HOLES[t]
    B = _rough_blob(cx, cy, rx, ry, seed)
    B[:, 0] = np.clip(B[:, 0], 0.16, W - 0.16); B[:, 1] = np.clip(B[:, 1], 0.06 if t != 'wall_blank_end' else 0.16, H - 0.14)
    poly = Polygon(B).buffer(0)
    merged, remaining, rects = [], [], []
    for kind, (x0, y0, x1, y1) in OPEN[t]:
        rb = box(x0, y0, x1, y1)
        if rb.intersects(poly):
            poly = unary_union([poly, rb]); merged.append(kind); rects.append((x0, y0, x1, y1))
        else:
            remaining.append((kind, (x0, y0, x1, y1)))
    poly = poly.buffer(0)
    if poly.geom_type != 'Polygon':
        poly = max(poly.geoms, key=lambda g: g.area)
    P = np.array(poly.exterior.coords)[:-1]
    if np.sum(P[:, 0] * np.roll(P[:, 1], -1) - np.roll(P[:, 0], -1) * P[:, 1]) < 0:
        P = P[::-1]
    # remove near-duplicate points
    keep = [0]
    for i in range(1, len(P)):
        if np.linalg.norm(P[i] - P[keep[-1]]) > 0.012:
            keep.append(i)
    P = P[keep]
    def on_rect(p):
        for (x0, y0, x1, y1) in rects:
            if (x0 - 1e-4 <= p[0] <= x1 + 1e-4 and y0 - 1e-4 <= p[1] <= y1 + 1e-4) and \
               min(abs(p[0] - x0), abs(p[0] - x1), abs(p[1] - y0), abs(p[1] - y1)) < 1e-4:
                return True
        return False
    broken = np.array([not on_rect(p) for p in P])
    if not full:
        return P
    return {'poly': P, 'broken': broken, 'remaining': remaining, 'merged': merged, 'rects': rects}


def stub_outline(t, seed=600):
    """Remaining stub of a *_destroyed panel: CCW outline and a per-vertex 'broken' flag.
    Bottom and side edges are clean panel borders; the top is a crumbled jagged line with a taller
    remnant column on the left (still tied to the neighbouring panel by the joint rebar)."""
    r = rng(seed + TYPES.index(t))
    xs = np.linspace(W, 0, 22)
    base = 0.55 + 0.25 * np.sin(xs * 2.1 + r.uniform(0, 6)) + r.normal(0, 0.09, len(xs))
    # remnant column on the left (x < 0.55)
    if t == 'wall_balcony':
        col = np.clip((xs - 2.62) / 0.22, 0, 1)
    else:
        col = np.clip((0.85 - xs) / 0.3, 0, 1)
    top = base * (1 - col) + (1.65 + 0.15 * np.sin(xs * 9) + r.normal(0, 0.06, len(xs))) * col
    # doors pull the line down to the threshold
    for kind, (x0, y0, x1, y1) in OPEN[t]:
        if kind in ('door', 'entrance'):
            m = (xs > x0 - 0.05) & (xs < x1 + 0.05)
            top[m] = np.minimum(top[m], y0 + 0.03 + np.abs(r.normal(0, 0.02, m.sum())))
    top = np.clip(top, 0.03, H - 0.3)
    top[0] = max(top[0], 0.35)
    pts = [(0.0, 0.0), (W, 0.0)] + [(x, y) for x, y in zip(xs, top)]
    broken = [False, False] + [True] * len(xs)
    broken[2] = False  # (W, top0) corner sits on the clean right border
    broken[-1] = False  # (0, top_last) on the left border
    return np.array(pts), np.array(broken)
