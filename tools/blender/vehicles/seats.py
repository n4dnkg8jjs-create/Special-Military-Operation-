"""Desant (tank-rider) seat empties shared by the BTR and T-72 builds.

Each seat is an empty `ride_seat_<n>` parented to `hull`:
  * origin  = point under the rider's pelvis on the sitting surface (found by ray-casting the hull geometry)
  * local +Z (glTF) = direction the rider faces;  local +Y = up
  * extras.seat_type = "edge" (sitting on a deck edge, legs over the side) or "deck" (sitting on the deck,
    legs forward along it).
The rider proxy used for the clearance checks below is mirrored by tools/blender/vehicles/preview.html
(`seats=1`), so what the check measures is what the debug preview shows.

Authoring frame (see vlib): X = vehicle right, Y = forward, Z = up.
"""
import math
import numpy as np
import bpy
from mathutils import Vector as V, Matrix
import vlib as L

# rider proxy, seat-local (f = forward along facing, u = up, r = lateral), metres
PROXY = {
    'edge': [(0, 0.0, 0.10), (-0.06, 0.0, 0.62), (-0.08, 0.0, 0.88), (0.44, 0.0, 0.08), (0.72, 0.0, -0.40),
             (-0.06, 0.21, 0.55), (-0.06, -0.21, 0.55), (0.44, 0.12, 0.08), (0.44, -0.12, 0.08), (0.72, 0.12, -0.40),
             (0.72, -0.12, -0.40)],
    'deck': [(0, 0.0, 0.10), (-0.06, 0.0, 0.62), (-0.08, 0.0, 0.88), (0.38, 0.0, 0.32), (0.74, 0.0, 0.06),
             (-0.06, 0.21, 0.55), (-0.06, -0.21, 0.55), (0.38, 0.12, 0.32), (0.38, -0.12, 0.32), (0.74, 0.12, 0.06),
             (0.74, -0.12, 0.06)],
}
BODY_R = 0.13        # proxy point radius (limb / torso half-thickness)
HEAD_TOP = 1.0       # seated head top above the sitting surface


def _frame(face):
    fx, fy = face
    n = math.hypot(fx, fy)
    f = V((fx / n, fy / n, 0))
    r = f.cross(V((0, 0, 1)))       # rider's right in authoring frame
    return f, r


def proxy_points(seat):
    """World (authoring) proxy points of a rider on `seat` (dict with x, y, z, face, type)."""
    f, r = _frame(seat['face'])
    o = V((seat['x'], seat['y'], seat['z']))
    return [o + f * a + r * b + V((0, 0, c)) for a, b, c in PROXY[seat['type']]]


def drop_z(bvh, x, y, foot=0.07):
    """Highest supporting surface under a pelvis-sized footprint (5 rays)."""
    zs = []
    for dx, dy in ((0, 0), (foot, 0), (-foot, 0), (0, foot), (0, -foot)):
        hit = bvh.ray_cast(V((x + dx, y + dy, 6.0)), V((0, 0, -1)))
        if hit[0] is not None:
            zs.append(hit[0].z)
    return max(zs)


def place_seats(hullE, specs, bvh):
    """specs: [dict(x, y, face=(fx, fy), type)] in the authoring frame.  Returns the completed seat dicts."""
    out = []
    for i, s in enumerate(specs):
        s = dict(s)
        if s.get('z') is None:
            s['z'] = drop_z(bvh, s['x'], s['y'])
        s['name'] = f'ride_seat_{i + 1}'
        e = L.node_empty(s['name'], hullE, (s['x'], s['y'], s['z']), 0.12)
        # Blender export frame = authoring rotated 180 deg about Z.  glTF local +Z == Blender local -Y, so the
        # facing direction f_blender = (-fx, -fy, 0) must be local -Y, i.e. local +Y = (fx, fy, 0).
        f, _ = _frame(s['face'])
        Yc = V((f.x, f.y, 0)); Zc = V((0, 0, 1)); Xc = Yc.cross(Zc)
        M = Matrix((Xc, Yc, Zc)).transposed()
        e.rotation_mode = 'QUATERNION'
        e.rotation_quaternion = M.to_quaternion()
        e['seat_type'] = s['type']
        out.append(s)
    bpy.context.view_layer.update()
    return out


def _verts_world_authoring(objs):
    pts = []
    for o in objs:
        if o is None:
            continue
        mw = o.matrix_world
        a = np.array([tuple(mw @ v.co) for v in o.data.vertices], np.float32)
        a[:, 0] *= -1; a[:, 1] *= -1          # Blender export frame -> authoring frame
        pts.append(a)
    return np.concatenate(pts) if pts else np.zeros((0, 3), np.float32)


def clearance(seats, ring, turret_objs, trunnion, barrel_len, elev_max):
    """Check riders against the turret's swept volume and the gun.

    ring: authoring (x, y, z) of the turret ring centre.  turret_objs: meshes that traverse with the turret
    (turret body, cope cage; gun excluded).  trunnion: authoring trunnion point with the turret facing forward.
    Returns a dict for the manifest."""
    tv = _verts_world_authoring(turret_objs)
    d = np.hypot(tv[:, 0] - ring[0], tv[:, 1] - ring[1])
    sweep_r = float(d.max())
    z_lo, z_hi = float(tv[:, 2].min()), float(tv[:, 2].max())
    worst = 1e9
    per = []
    t_off = math.hypot(trunnion[0] - ring[0], trunnion[1] - ring[1])
    need_el = -90.0
    for s in seats:
        m = 1e9
        for p in proxy_points(s):
            if p.z + BODY_R < z_lo or p.z - BODY_R > z_hi:
                continue
            m = min(m, math.hypot(p.x - ring[0], p.y - ring[1]) - BODY_R - sweep_r)
        worst = min(worst, m)
        # gun: barrel line from the trunnion (which itself sits t_off from the ring centre and turns with it);
        # nearest horizontal distance from the trunnion circle to the rider footprint, rider top = z + HEAD_TOP
        hd = min(math.hypot(p.x - ring[0], p.y - ring[1]) for p in proxy_points(s)) - BODY_R - t_off
        if hd < barrel_len:
            need = math.degrees(math.atan2(s['z'] + HEAD_TOP - trunnion[2], max(hd, 0.05)))
            need_el = max(need_el, need)
        per.append(round(m, 3))
    return dict(turret_sweep_radius_m=round(sweep_r, 3), turret_sweep_z_m=[round(z_lo, 3), round(z_hi, 3)],
                min_rider_margin_m=round(worst, 3), per_seat_margin_m=per,
                gun_trunnion_height_m=round(trunnion[2], 3),
                gun_min_elevation_to_clear_riders_deg=round(need_el, 1),
                gun_max_elevation_deg=elev_max,
                gun_can_clear_riders=bool(need_el <= elev_max))


def manifest_entries(seats):
    """glTF-frame records: pos (x, y, z) and facing unit vector, glTF = (-x_a, z_a, y_a) from authoring."""
    out = []
    for s in seats:
        f, _ = _frame(s['face'])
        out.append(dict(name=s['name'], seat_type=s['type'],
                        pos=[round(-s['x'], 3), round(s['z'], 3), round(s['y'], 3)],
                        facing=[round(-f.x, 3), 0.0, round(f.y, 3)]))
    return out
