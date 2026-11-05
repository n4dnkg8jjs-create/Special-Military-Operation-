"""Beveled gear primitives (Blender bevel modifier) and pouch assemblies in a local frame:
x = across the panel, y = up, z = out of the panel (0 = panel surface)."""
import numpy as np
import bpy, bmesh
import bl, meshutil as MU
from gear import part

_cache = {}


def rbox(w, h, d, r=0.006, seg=2, taper_top=0.0, sub=(1, 1, 1)):
    """rounded box centred at origin (x: w, y: h, z: d), returns (pos, tri) GL"""
    key = ('rbox', round(w, 4), round(h, 4), round(d, 4), round(r, 4), seg, round(taper_top, 4), sub)
    if key in _cache:
        return _cache[key]
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        x, y, z = v.co  # blender coords: x, y(depth), z(up)
        gl = np.array([x * w, z * h, -y * d])
        if taper_top and gl[1] > 0:
            gl[0] *= (1 - taper_top)
        v.co = tuple(bl.to_bl(gl[None])[0])
    if sub != (1, 1, 1):
        pass
    me = bpy.data.meshes.new('rb'); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new('rb', me); bpy.context.scene.collection.objects.link(ob)
    if r > 0:
        m = ob.modifiers.new('bv', 'BEVEL'); m.width = min(r, min(w, h, d) * 0.49); m.segments = seg
        m.limit_method = 'NONE'
        bl.apply_mods(ob)
    me = ob.data
    me.calc_loop_triangles()
    co = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', co)
    tri = np.zeros(len(me.loop_triangles) * 3, np.int32); me.loop_triangles.foreach_get('vertices', tri)
    out = (bl.from_bl(co.reshape(-1, 3)), tri.reshape(-1, 3))
    bpy.data.objects.remove(ob)
    _cache[key] = out
    return out


def cyl(r, h, n=10, r2=None, cap=True):
    """cylinder along local y, base at y=0"""
    r2 = r if r2 is None else r2
    a = np.linspace(0, 2 * np.pi, n, endpoint=False)
    b = np.stack([np.cos(a) * r, np.zeros(n), np.sin(a) * r], 1)
    t = np.stack([np.cos(a) * r2, np.full(n, h), np.sin(a) * r2], 1)
    pos = np.concatenate([b, t, [[0, 0, 0], [0, h, 0]]])
    T = []
    for k in range(n):
        k2 = (k + 1) % n
        T += [[k, n + k2, k2], [k, n + k, n + k2]]
        if cap:
            T += [[2 * n, k, k2], [2 * n + 1, n + k2, n + k]]
    return pos, np.array(T)


def xf(pos, M):
    return pos @ M[:3, :3].T + M[:3, 3]


def mat4(origin, side, up, n):
    M = np.eye(4); M[:3, 0] = side; M[:3, 1] = up; M[:3, 2] = n; M[:3, 3] = origin
    return M


def T(x=0, y=0, z=0, rx=0):
    M = np.eye(4); M[:3, 3] = (x, y, z)
    if rx:
        c, s = np.cos(rx), np.sin(rx)
        M[:3, :3] = [[1, 0, 0], [0, c, -s], [0, s, c]]
    return M


def local_part(geom, M, mat, kind='fabric'):
    pos, tri = geom
    p = part(xf(pos, M), tri, mat, smooth=True)
    p['local'] = pos
    p['kind'] = kind
    # flat-ish normals for crisp bevels: recompute with angle split later; keep smooth
    return p


# ------------------------------------------------------------------ pouch assemblies
def mag_pouch(mats, M, open_top=False, n_mags=2, w=0.087, h=0.155, d=0.068, mag_col='mag'):
    out = []
    hb = h * (0.78 if open_top else 1.0)
    out.append(local_part(rbox(w, hb, d, 0.013, 2), M @ T(0, hb / 2, d / 2), mats['fabric']))   # v6: fuller, softer corners
    # MOLLE strap at back, side seams = slight geometry: bottom drain grommet skipped
    if open_top:
        # mag bottoms (base plates) sticking out, slightly curved forward (AK mags are inserted upside down)
        mw = 0.028
        for k in range(n_mags):
            x = (k - (n_mags - 1) / 2) * (mw + 0.006)
            body = rbox(mw, 0.06, 0.064, 0.004, 1)
            out.append(local_part(body, M @ T(x, hb + 0.0, d / 2 + 0.002, rx=-0.12), mats[mag_col], 'hard'))
            plate = rbox(mw + 0.003, 0.008, 0.068, 0.002, 1)
            out.append(local_part(plate, M @ T(x, hb + 0.03, d / 2 + 0.0, rx=-0.12), mats[mag_col], 'hard'))
        # bungee retention cord across the top
        cord = rbox(w * 0.95, 0.006, 0.006, 0.0025, 1)
        out.append(local_part(cord, M @ T(0, hb + 0.012, d + 0.004), mats['hardware'], 'hard'))
    else:
        # flap: over the top and down the front
        out.append(local_part(rbox(w + 0.004, 0.008, d + 0.008, 0.003, 2), M @ T(0, h + 0.004, d / 2 + 0.002), mats['fabric']))
        out.append(local_part(rbox(w + 0.004, 0.065, 0.008, 0.003, 2), M @ T(0, h - 0.028, d + 0.006), mats['fabric']))
        # fastex buckle: female on flap, male strap on body
        out.append(local_part(rbox(0.026, 0.03, 0.009, 0.003, 1), M @ T(0, h - 0.065, d + 0.011), mats['hardware'], 'hard'))
        out.append(local_part(rbox(0.02, 0.045, 0.004, 0.0015, 1), M @ T(0, h - 0.1, d + 0.003), mats['webbing'], 'hard'))
    return out


def grenade_pouch(mats, M, w=0.074, h=0.1, d=0.068):
    out = [local_part(rbox(w, h, d, 0.016, 2), M @ T(0, h / 2, d / 2), mats['fabric'])]
    out.append(local_part(rbox(w + 0.004, 0.008, d + 0.006, 0.003, 2), M @ T(0, h + 0.004, d / 2 + 0.002), mats['fabric']))
    out.append(local_part(rbox(w + 0.004, 0.04, 0.008, 0.003, 2), M @ T(0, h - 0.016, d + 0.006), mats['fabric']))
    out.append(local_part(rbox(0.03, 0.012, 0.006, 0.002, 1), M @ T(0, h - 0.04, d + 0.01), mats['hardware'], 'hard'))
    return out


def radio_pouch(mats, M, w=0.072, h=0.13, d=0.042, antenna=0.17):
    out = [local_part(rbox(w, h, d, 0.008, 2), M @ T(0, h / 2, d / 2), mats['fabric'])]
    # radio body sticking out the top + knobs + antenna
    out.append(local_part(rbox(w * 0.82, 0.05, d * 0.8, 0.004, 1), M @ T(0, h + 0.012, d / 2), mats['radio'], 'hard'))
    out.append(local_part(cyl(0.007, 0.014, 8), M @ T(-0.015, h + 0.037, d / 2), mats['radio'], 'hard'))
    out.append(local_part(cyl(0.0055, 0.012, 8), M @ T(0.012, h + 0.037, d / 2), mats['radio'], 'hard'))
    out.append(local_part(cyl(0.0045, antenna, 6, 0.0025), M @ T(0.022, h + 0.037, d / 2), mats['radio'], 'hard'))
    # retention strap
    out.append(local_part(rbox(0.022, 0.07, 0.004, 0.0015, 1), M @ T(0, h - 0.0, d + 0.002), mats['webbing'], 'hard'))
    return out


def ifak(mats, M, w=0.165, h=0.115, d=0.082, cross=True):
    out = [local_part(rbox(w, h, d, 0.026, 3), M @ T(0, h / 2, d / 2), mats['fabric'])]
    # zipper line around (thin dark strip) and pull tabs
    out.append(local_part(rbox(w * 0.98, 0.006, d * 0.96 + 0.002, 0.002, 1), M @ T(0, h * 0.62, d / 2), mats['hardware'], 'hard'))
    out.append(local_part(rbox(0.012, 0.03, 0.004, 0.001, 1), M @ T(w * 0.35, h * 0.62 - 0.02, d + 0.002), mats['hardware'], 'hard'))
    if cross:
        out.append(local_part(rbox(0.05, 0.016, 0.002, 0.0, 1), M @ T(0, h * 0.3, d + 0.0005), mats['red'], 'hard'))
        out.append(local_part(rbox(0.016, 0.05, 0.002, 0.0, 1), M @ T(0, h * 0.3, d + 0.0005), mats['red'], 'hard'))
    return out


def tourniquet(mats, M):
    """CAT tourniquet folded in a holder: black band with red tip"""
    out = [local_part(rbox(0.045, 0.11, 0.035, 0.008, 2), M @ T(0, 0.055, 0.0175), mats['hardware'], 'hard')]
    out.append(local_part(rbox(0.02, 0.03, 0.03, 0.004, 1), M @ T(0, 0.12, 0.016), mats['red'], 'hard'))
    out.append(local_part(rbox(0.05, 0.02, 0.04, 0.003, 1), M @ T(0, 0.07, 0.02), mats['webbing'], 'hard'))
    return out


def admin_pouch(mats, M, w=0.22, h=0.12, d=0.036, patch=None):
    out = [local_part(rbox(w, h, d, 0.012, 2), M @ T(0, h / 2, d / 2), mats['fabric'])]
    out.append(local_part(rbox(w * 0.98, 0.005, d + 0.002, 0.002, 1), M @ T(0, h - 0.01, d / 2), mats['hardware'], 'hard'))
    if patch is not None:
        out.append(local_part(rbox(0.08, 0.05, 0.003, 0.002, 1), M @ T(0, h * 0.45, d + 0.0012), mats[patch], 'hard'))
    return out


def drag_handle(mats, M, w=0.11):
    # strap loop: arc of rounded segments
    out = []
    n = 7
    for k in range(n):
        a0 = np.pi * k / n; a1 = np.pi * (k + 1) / n
        am = (a0 + a1) / 2
        x = -np.cos(am) * w / 2; z = np.sin(am) * 0.045
        seg = rbox(w / n * 1.6, 0.03, 0.006, 0.0025, 1)
        Mr = np.eye(4)
        ang = am - np.pi / 2
        c, s = np.cos(ang), np.sin(ang)
        Mr[:3, :3] = [[c, 0, s], [0, 1, 0], [-s, 0, c]]
        Mr[:3, 3] = (x, 0.015, z + 0.004)
        out.append(local_part(seg, M @ Mr, mats['webbing'], 'hard'))
    return out


def hydration(mats, M, w=0.2, h=0.3, d=0.045):
    out = [local_part(rbox(w, h, d, 0.02, 3, taper_top=0.1), M @ T(0, h / 2, d / 2), mats['fabric'])]
    out.append(local_part(rbox(w * 0.9, 0.006, d * 0.9, 0.002, 1), M @ T(0, h * 0.85, d / 2 + 0.001), mats['hardware'], 'hard'))
    return out


def dump_pouch(mats, M, w=0.16, h=0.08, d=0.06):
    out = [local_part(rbox(w, h, d, 0.025, 3), M @ T(0, h / 2, d / 2), mats['fabric'])]
    out.append(local_part(rbox(0.035, h * 0.8, 0.006, 0.002, 1), M @ T(w * 0.25, h / 2, d + 0.002), mats['webbing'], 'hard'))
    out.append(local_part(rbox(0.035, h * 0.8, 0.006, 0.002, 1), M @ T(-w * 0.25, h / 2, d + 0.002), mats['webbing'], 'hard'))
    return out
