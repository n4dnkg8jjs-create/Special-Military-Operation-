"""Third panel-kit atlas 'kit_damage' (2048^2: albedo JPEG, normal PNG, ORM PNG) with the facade cells of the damage
variants <type>_holed_v2/_v3 and <type>_destroyed_v2/_v3 (see kit_damage_design.py). Third material of panel_kit.glb.

Each cell is painted by the family's own facade painter (kit_atlas.paint_facade for large panels, city_kit_atlas.
paint_brick / paint_shop for brick and shopfront walls) at its native resolution with the variant's own void outlines
(scorch, blown-off tiles / bricks, radiating cracks, pockmark cluster all follow the variant's damage), then resampled.
Layout: 7 x 8 cells of 292 x 256 px (= 3.2 x 2.8 m, ~91 px/m); index = type_index * 4 + state_index * 2 + variant_index
with type order kit_damage_design.all_types(), states (holed, destroyed), variants (v2, v3).
Only the facade (outside face) uses this atlas; broken sections, slabs, rebar, joinery use kit_panel / kit_city regions.
"""
import os
import numpy as np
import cv2
import kit_atlas as KA
import city_kit_atlas as CA
from meshlib import Region
from kit_design import W, H
import kit_damage_design as KD

S = 2048
CW, CH = 292, 256
COLS = 7


def cell_index(prefix, state, v):
    ti = [p for p, *_ in KD.all_types()].index(prefix)
    return ti * 4 + KD.DSTATES.index(state) * 2 + KD.VARIANTS.index(v)


def cell_rect(i):
    c, r = i % COLS, i // COLS
    return (c * CW, r * CH, c * CW + CW, r * CH + CH)


def cell_region(prefix, state, v):
    x0, y0, x1, y1 = cell_rect(cell_index(prefix, state, v))
    return Region(x0, y0, x1, y1, pad=0)


def _rs(a, k):
    return cv2.resize(a, (CW, CH), interpolation=cv2.INTER_AREA)


def paint_cell(prefix, state, v):
    d = KD.design(prefix, state, v)
    fam, t, colour = d['fam'], d['t'], d['colour']
    voids = d['voids'] + [np.array(sp.exterior.coords)[:-1] for sp in d['spalls']]
    seed = 9000 + d['seed'] % 5000
    if fam == 'panel':
        alb, hgt, rough = KA.paint_facade(t, state, seed, voids=voids); k = CW / KA.CW
    elif fam == 'brick':
        alb, hgt, rough = CA.paint_brick(colour, t, state, seed, voids=voids); k = CW / CA.CW
    else:
        alb, hgt, rough = CA.paint_shop(t, state, seed, voids=voids); k = CW / CA.CW
    return _rs(alb.astype(np.float32), k), _rs(hgt.astype(np.float32), k) * k, _rs(rough.astype(np.float32), k)


def build_atlas():
    A = KA.Atlas()
    for p, f, t, c in KD.all_types():
        for st in KD.DSTATES:
            for v in KD.VARIANTS:
                alb, hgt, rough = paint_cell(p, st, v)
                A.put(cell_rect(cell_index(p, st, v)), alb, hgt, rough)
    return A.save('kit_atlas_damage')


if __name__ == '__main__':
    import time; t0 = time.time()
    print(build_atlas(), time.time() - t0)
