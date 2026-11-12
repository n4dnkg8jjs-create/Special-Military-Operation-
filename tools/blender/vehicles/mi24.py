"""Mi-24V 'Hind-E' attack helicopter (both sides fly it: Russian army aviation Mi-24V / P / Mi-35M, Ukrainian army aviation
Mi-24V / P / PU1), in flight trim: undercarriage retracted, 2 x B-8V20A pods (20 x 80 mm S-8) on each wing's inboard pylons.

Reference data (sources in assets/vehicles/manifest.json):
  fuselage 17.51 m (19.79 m rotors turning), main rotor 17.30 m (five blades, 0.58 m chord), tail rotor 3.908 m (three blades,
  on the port side of the fin), wing span 6.54 m with 12 deg anhedral and down-turned end plates carrying the ATGM rails, height
  3.97 m to the rotor head, fuselage 1.7 m wide; tandem stepped cockpits under separate bubble canopies (weapons operator in
  front, pilot behind and above), USPU-24 chin turret with the four-barrel 12.7 mm YakB, Raduga-F guidance pod under the nose
  to port, two TV3-117 turboshafts side by side over the cabin with dome dust filters on the intakes and (in wartime) EVU
  exhaust mixer boxes, eight-seat cabin with a two-leaf door and four windows a side, L-166V1A 'Ispanka' IR jammer behind the
  rotor head, ASO-2V flare dispensers on the tail boom.
Authoring frame: X right, Y forward, Z up; origin on the ground line (undercarriage down) under the main rotor axis - the belly
is 0.62 m above it.  Nodes: hull > hull_geo, glass_geo, rotor_main (hub, spins about its local up axis), rotor_tail (spins about
its local X), muzzle (YakB), rocket_L / rocket_R (pod mouths), flare_L / flare_R, exhaust_L / exhaust_R, id_band_a / id_band_b
(two rings round the tail boom, own untextured materials: tinted to the side's colours at runtime), hull_wreck.
"""
import sys, os, math, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
import numpy as np
from mathutils import Vector as V, Matrix
import vlib as L
from vlib import B, box, hull, prism, lathe, cyl, tube, bolt
import vtex as T
import vbuild as VB

NAME = 'mi24'
BELLY = 0.62
HUB_Z = 3.97                      # rotor head
R_MAIN, R_TAIL = 8.65, 1.954
TAIL_Y = -10.62                   # tail rotor axis behind the main rotor axis
NOSE_Y = 6.55
# fuselage stations: y, half width, z bottom, z top (above BELLY datum = 0), squareness
ST = [(6.55, 0.10, 0.72, 0.98, 2.0), (6.15, 0.36, 0.48, 1.22, 2.2), (5.5, 0.56, 0.26, 1.42, 2.4), (4.7, 0.70, 0.10, 1.52, 2.6),
      (3.9, 0.80, 0.03, 1.62, 2.8), (3.0, 0.85, 0.0, 1.98, 3.0), (2.2, 0.86, 0.0, 2.28, 3.0), (0.0, 0.86, 0.0, 2.36, 3.0),
      (-1.9, 0.85, 0.04, 2.32, 3.0), (-2.8, 0.74, 0.34, 2.24, 2.6), (-3.8, 0.52, 0.86, 2.14, 2.3), (-5.2, 0.36, 1.22, 2.02, 2.1),
      (-7.6, 0.26, 1.50, 1.96, 2.0), (-9.6, 0.19, 1.70, 1.98, 2.0), (-10.3, 0.15, 1.78, 2.02, 2.0)]


def loft(stations, seg=24, mat='rolled', cap=True):
    """closed rings (superellipse of exponent n between z0 and z1, half width w) joined along Y"""
    bm = bmesh.new(); rings = []
    for (y, w, z0, z1, n) in stations:
        zc, hh = (z0 + z1) / 2, (z1 - z0) / 2; ring = []
        for i in range(seg):
            t = math.tau * i / seg; c, s = math.cos(t), math.sin(t)
            ring.append(bm.verts.new((w * np.sign(c) * abs(c) ** (2 / n), y, BELLY + zc + hh * np.sign(s) * abs(s) ** (2 / n))))
        rings.append(ring)
    for a, b_ in zip(rings[:-1], rings[1:]):
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new((a[i], a[j], b_[j], b_[i]))
    if cap:
        bm.faces.new(rings[0]); bm.faces.new(rings[-1][::-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    b = B(bm, mat)
    for f in b.bm.faces: f.smooth = True
    return b


def ellipsoid(rx, ry, rz, c, mat='glass', seg=16, rings=8, zmin=-1.0):
    prof = []
    for k in range(rings + 1):
        a = -math.pi / 2 + math.pi * k / rings
        if math.sin(a) < zmin: continue
        prof.append((math.cos(a), math.sin(a), mat))
    b = lathe(prof, seg, 'z', mat=mat, cap=False)
    return b.scale(rx, ry, rz).move(*c)


def fuselage():
    F = loft(ST)
    Z = lambda z: BELLY + z
    # engine / gearbox fairing over the cabin: intakes with dome dust filters, EVU exhaust mixers, oil cooler intake, APU
    F.add(loft([(3.0, 0.72, 1.85, 2.42, 2.4), (2.4, 0.80, 2.0, 2.78, 2.6), (0.8, 0.80, 2.1, 2.96, 2.8), (-0.9, 0.74, 2.1, 2.98, 2.6),
                (-2.2, 0.56, 2.0, 2.78, 2.4), (-3.3, 0.34, 1.95, 2.42, 2.2)], 20))
    for s in (1, -1):
        F.add(lathe([(0.27, 0.0), (0.30, 0.1), (0.30, 0.7), (0.27, 0.74)], 16, 'y', c=(s * 0.38, 2.5, Z(2.42)), cap=False))
        F.add(ellipsoid(0.27, 0.34, 0.27, (s * 0.38, 3.2, Z(2.42)), 'gunmetal', 14, 8))                 # PZU dust filter dome
        F.add(box(0.62, 1.05, 0.5, c=(s * 1.03, 0.55, Z(2.52)), bev=0.06, segs=2))                       # EVU mixer box
        F.add(box(0.5, 0.6, 0.05, c=(s * 1.03, 0.4, Z(2.79)), mat='gunmetal'))
        for k in range(5):
            F.add(box(0.03, 0.8, 0.36, c=(s * (1.2 + 0.0) + s * 0.1, 0.55 + 0.0, Z(2.52)), mat='gunmetal').move(0, (k - 2) * 0.0, 0)) if k == 0 else None
        # cabin: two-leaf door outline + four windows, cockpit door
        for k in range(4):
            F.add(box(0.012, 0.36, 0.3, c=(s * 0.862, 1.6 - k * 0.72, Z(1.52)), mat='glass'))
        F.add(box(0.012, 0.012, 1.25, c=(s * 0.866, 1.95, Z(1.2)), mat='decal')); F.add(box(0.012, 0.012, 1.25, c=(s * 0.866, 0.52, Z(1.2)), mat='decal'))
        F.add(box(0.012, 1.44, 0.012, c=(s * 0.866, 1.235, Z(1.82)), mat='decal')); F.add(box(0.012, 1.44, 0.012, c=(s * 0.866, 1.235, Z(1.2)), mat='decal'))
        # main undercarriage doors (closed) and the bulge they close over
        F.add(box(0.3, 1.5, 0.3, c=(s * 0.72, -1.3, Z(0.12)), bev=0.1, segs=2))
        # ASO-2V flare dispensers under the tail boom's root, formation light
        F.add(box(0.1, 0.9, 0.2, c=(s * 0.42, -4.5, Z(1.08)), mat='gunmetal', bev=0.01, segs=1))
    F.add(lathe([(0.20, 0.0), (0.17, 0.25), (0.11, 0.42), (0.0, 0.46)], 12, 'z', c=(0, -1.85, Z(2.96)), mat='gunmetal'))          # Ispanka IR jammer
    F.add(cyl(0.13, 0.3, 12, 'y', c=(0.0, -2.9, Z(2.62)), mat='gunmetal'))                                                         # APU exhaust
    F.add(box(0.36, 0.5, 0.24, c=(0, 3.15, Z(2.72)), bev=0.06, segs=2))                                                            # oil cooler intake
    # rotor mast fairing
    F.add(lathe([(0.34, 0.0), (0.3, 0.2), (0.2, 0.42), (0.16, HUB_Z - BELLY - 2.98 - 0.12)], 16, 'z', c=(0, 0, Z(2.94))))
    # nose: USPU-24 turret with the YakB, Raduga-F pod (port), pitot / air-data boom, low-light TV fairing (starboard)
    F.add(ellipsoid(0.24, 0.3, 0.2, (0, 5.75, Z(0.2)), 'rolled', 14, 8))
    for k in range(4):
        a = math.tau * k / 4
        F.add(cyl(0.014, 0.9, 6, 'y', c=(0.03 * math.cos(a), 6.25, Z(0.17) + 0.03 * math.sin(a)), mat='gunmetal'))
    F.add(cyl(0.05, 0.3, 10, 'y', c=(0, 5.95, Z(0.17)), mat='gunmetal'))
    F.add(loft([(5.55, 0.17, -0.06, 0.3, 2.4), (4.5, 0.2, -0.12, 0.26, 2.4), (4.0, 0.14, -0.04, 0.2, 2.2)], 12).move(-0.5, 0, 0))
    F.add(box(0.012, 0.2, 0.2, c=(-0.5, 5.56, Z(0.12)), mat='glass'))
    F.add(loft([(5.3, 0.13, 0.0, 0.26, 2.2), (4.6, 0.14, -0.02, 0.24, 2.2), (4.2, 0.08, 0.04, 0.2, 2.0)], 10).move(0.52, 0, 0))
    F.add(tube([(0.3, 6.5, Z(0.8)), (0.3, 7.6, Z(0.8))], 0.022, 6, 'gunmetal'))
    F.add(tube([(0.3, 7.35, Z(0.8)), (0.3, 7.4, Z(0.95))], 0.008, 4, 'gunmetal')); F.add(tube([(0.3, 7.35, Z(0.8)), (0.42, 7.4, Z(0.8))], 0.008, 4, 'gunmetal'))
    # canopy frames (the bubbles themselves are the glass object)
    for (cy, cz, ry, rz) in ((5.05, 1.42, 0.78, 0.5), (3.55, 1.72, 0.86, 0.56)):
        for dy in (-0.42, 0.0, 0.42):
            pts = [(math.sin(a) * 0.5 * math.sqrt(max(1 - (dy / ry) ** 2, 0.05)), cy + dy, Z(cz) + math.cos(a) * rz * math.sqrt(max(1 - (dy / ry) ** 2, 0.05))) for a in np.linspace(-1.35, 1.35, 9)]
            F.add(tube(pts, 0.016, 5, 'rolled'))
        F.add(tube([(0, cy - ry * 0.95, Z(cz) + 0.1), (0, cy, Z(cz) + rz + 0.012), (0, cy + ry * 0.9, Z(cz) + 0.14)], 0.016, 5, 'rolled'))
    # ---- stub wings: 12 deg anhedral, two pylons each, end plate with the twin ATGM rail frame
    for s in (1, -1):
        r0, r1 = V((s * 0.84, -0.25, Z(1.5))), V((s * 3.27, -0.42, Z(0.98)))
        pts = []
        for p, ch, th in ((r0, 1.42, 0.2), (r1, 1.02, 0.12)):
            for dy, dz in ((ch / 2, 0.0), (ch * 0.2, th / 2), (-ch * 0.3, th * 0.4), (-ch / 2, 0.0), (-ch * 0.3, -th * 0.4), (ch * 0.2, -th / 2)):
                pts.append((p.x, p.y + dy, p.z + dz))
        F.add(hull(pts, bev=0.01, segs=1))
        F.add(hull([(r1.x, r1.y + 0.5, r1.z + 0.05), (r1.x, r1.y - 0.5, r1.z + 0.05), (r1.x + s * 0.05, r1.y + 0.5, r1.z + 0.05), (r1.x + s * 0.05, r1.y - 0.5, r1.z + 0.05),
                    (r1.x + s * 0.06, r1.y + 0.42, r1.z - 0.52), (r1.x + s * 0.06, r1.y - 0.3, r1.z - 0.52), (r1.x + s * 0.1, r1.y + 0.42, r1.z - 0.52), (r1.x + s * 0.1, r1.y - 0.3, r1.z - 0.52)], bev=0.008, segs=1))
        for dx in (-0.13, 0.13):                                               # 9M114 launch rail frames (tubes not carried)
            F.add(box(0.05, 1.5, 0.05, c=(r1.x + s * 0.08 + dx * 0.9, r1.y + 0.2, r1.z - 0.58), mat='gunmetal'))
        for k, t_ in enumerate((0.3, 0.68)):                                   # pylons: B-8V20A pod inboard, empty rack outboard
            p = r0.lerp(r1, t_)
            F.add(box(0.07, 0.9, 0.3, c=(p.x, p.y + 0.05, p.z - 0.2), bev=0.02, segs=1))
            if k == 0 or True:
                py, pz = p.y + 0.12, p.z - 0.56
                F.add(lathe([(0.0, -0.88), (0.12, -0.86), (0.26, -0.55), (0.26, 0.78), (0.24, 0.88), (0.0, 0.88, 'gunmetal')], 16, 'y', c=(p.x, py, pz)))
                for q in range(20):                                            # tube mouths: rings of 7 and 13
                    rr, a = (0.105, math.tau * q / 7) if q < 7 else (0.2, math.tau * (q - 7) / 13)
                    F.add(cyl(0.034, 0.012, 8, 'y', c=(p.x + rr * math.cos(a), py + 0.884, pz + rr * math.sin(a)), mat='decal'))
    # ---- tail: swept fin (canted), fixed tailplane halves, tail skid, tail rotor gearbox fairing
    fin = [(-0.07, -9.3, Z(1.95)), (0.07, -9.3, Z(1.95)), (-0.07, -10.75, Z(1.9)), (0.07, -10.75, Z(1.9)),
           (-0.05, -10.5, Z(3.45)), (0.05, -10.5, Z(3.45)), (-0.05, -11.25, Z(3.55)), (0.05, -11.25, Z(3.55)), (-0.05, -10.0, Z(2.6)), (0.05, -10.0, Z(2.6))]
    F.add(hull(fin, bev=0.012, segs=1))
    F.add(ellipsoid(0.2, 0.42, 0.2, (-0.12, TAIL_Y, HUB_Z - 0.72), 'rolled', 12, 8))
    for s in (1, -1):
        F.add(hull([(s * 0.15, -9.0, Z(1.9)), (s * 0.15, -9.9, Z(1.9)), (s * 1.63, -9.25, Z(1.9)), (s * 1.63, -9.85, Z(1.9)),
                    (s * 0.15, -9.3, Z(1.98)), (s * 0.15, -9.7, Z(1.96)), (s * 1.63, -9.45, Z(1.95)), (s * 1.63, -9.7, Z(1.94))], bev=0.008, segs=1))
    F.add(tube([(0, -10.1, Z(1.75)), (0, -10.5, Z(1.35))], 0.03, 6, 'gunmetal'))
    # aerials
    F.add(tube([(0, -4.6, Z(2.1)), (0, -4.7, Z(2.5))], 0.012, 5, 'gunmetal'))
    F.add(box(0.02, 0.5, 0.26, c=(0, -6.6, Z(1.36)), mat='gunmetal'))
    return F


def glass():
    G = B()
    Z = lambda z: BELLY + z
    G.add(ellipsoid(0.5, 0.78, 0.5, (0, 5.05, Z(1.42)), 'glass', 18, 10, zmin=-0.12))
    G.add(ellipsoid(0.52, 0.86, 0.56, (0, 3.55, Z(1.72)), 'glass', 18, 10, zmin=-0.12))
    return G


def rotor_main():
    """five-blade main rotor about the origin (hub centre): blade root cuffs, drooped a little as on a slow rotor"""
    Rm = B()
    Rm.add(lathe([(0.0, -0.2), (0.24, -0.2), (0.3, -0.06), (0.3, 0.1), (0.16, 0.22), (0.0, 0.24)], 14, 'z', mat='gunmetal'))
    for k in range(5):
        a = math.degrees(math.tau * k / 5)
        bl = B()
        bl.add(box(0.16, 0.9, 0.1, c=(0, 0.72, 0.0), mat='gunmetal', bev=0.02, segs=1))
        pts = []
        for y, dz in ((1.1, 0.0), (4.0, -0.03), (R_MAIN, -0.12)):
            for dx, zz in ((0.29, 0.0), (0.1, 0.03), (-0.29, 0.006), (0.1, -0.02)):
                pts.append((dx, y, dz + zz))
        bl.add(hull(pts[:8])); bl.add(hull(pts[4:]))
        Rm.add(bl.rot('Z', a))
    return Rm


def rotor_tail():
    Rt = B()
    Rt.add(cyl(0.12, 0.3, 10, 'x', mat='gunmetal'))
    for k in range(3):
        bl = hull([(-0.02, 0.2, 0.13), (0.02, 0.2, 0.13), (-0.02, 0.2, -0.13), (0.02, 0.2, -0.13), (-0.012, R_TAIL, 0.11), (0.012, R_TAIL, 0.11), (-0.012, R_TAIL, -0.11), (0.012, R_TAIL, -0.11)])
        Rt.add(bl.rot('X', 120 * k))
    return Rt


def bands():
    """two identification rings round the tail boom (thin shells just off the skin), tinted by the game"""
    out = []
    for y0 in (-6.0, -6.7):
        st = []
        for y in (y0, y0 - 0.5):
            # the boom's section at y (interpolated between the stations), grown by 6 mm
            for a, b_ in zip(ST[:-1], ST[1:]):
                if b_[0] <= y <= a[0]:
                    t = (a[0] - y) / (a[0] - b_[0]); w = a[1] + (b_[1] - a[1]) * t; z0 = a[2] + (b_[2] - a[2]) * t; z1 = a[3] + (b_[3] - a[3]) * t; n = a[4] + (b_[4] - a[4]) * t
                    st.append((y, w + 0.006, z0 - 0.006, z1 + 0.006, n))
        out.append(loft(st, 24, 'decal', cap=False))
    return out


def build():
    t0 = time.time()
    L.reset()
    root = L.node_empty('root')
    hullE = L.node_empty('hull', root, (0, 0, 0))
    F = fuselage()
    print('  fuselage tris', F.tris(), '%.1fs' % (time.time() - t0))
    hull_mesh = L.node_mesh('hull_geo', F, hullE, (0, 0, 0), sharp=50)
    glass_mesh = L.node_mesh('glass_geo', glass(), hullE, (0, 0, 0))
    rmE = L.node_empty('rotor_main', hullE, (0, 0, HUB_Z))
    rm = L.node_mesh('rotor_main_geo', rotor_main().move(0, 0, HUB_Z), rmE, (0, 0, HUB_Z))
    tp = (-0.42, TAIL_Y, HUB_Z - 0.72)
    rtE = L.node_empty('rotor_tail', hullE, tp)
    rt = L.node_mesh('rotor_tail_geo', rotor_tail().move(*tp), rtE, tp)
    idm = []
    for nm, part in zip(('id_band_a', 'id_band_b'), bands()):
        o = L.node_mesh(nm, part, hullE, (0, 0, 0))
        mt = T.principled('mi24_' + nm, color=(0.85, 0.85, 0.82), rough=0.7, metal=0.0)
        o.data.materials.clear(); o.data.materials.append(mt)
        for poly in o.data.polygons: poly.material_index = 0
        idm.append(o)
    Z = lambda z: BELLY + z
    L.node_empty('muzzle', hullE, (0, 6.72, Z(0.17)), 0.1)
    for s, tag in ((1, 'R'), (-1, 'L')):
        r0, r1 = V((s * 0.84, -0.25, Z(1.5))), V((s * 3.27, -0.42, Z(0.98)))
        for k, t_ in enumerate((0.3, 0.68)):
            p = r0.lerp(r1, t_)
            L.node_empty(f'rocket_{tag}{k + 1}', hullE, (p.x, p.y + 1.02, p.z - 0.56), 0.1)
        L.node_empty(f'flare_{tag}', hullE, (s * 0.48, -4.5, Z(1.0)), 0.1)
        L.node_empty(f'exhaust_{tag}', hullE, (s * 1.36, 0.55, Z(2.52)), 0.1)
    print('  geometry done %.1fs' % (time.time() - t0))
    lod0 = [hull_mesh, rm, rt, glass_mesh]
    return dict(root=root, hull=hullE, lod0=lod0, atlas=[hull_mesh, rm, rt], nolod=[glass_mesh], bake_hide=[glass_mesh], idm=idm, body=hull_mesh, rm=rm, rt=rt)


def wreck(d):
    """burnt-out airframe: fuselage with the rotor head and the stumps of the blades (decimated, glass gone)"""
    hw = VB.join_copies('hull_wreck', [d['body']], d['root'], (0, 0, 0), drop_slots=('glass', 'light', 'decal'), drop_z=0.0)
    return [hw]


def decals(P, N):
    """pale blue-grey undersides (both operators), over the camouflage"""
    under = np.clip((-N[..., 2] - 0.25) / 0.35, 0, 1).astype(np.float32)
    return [((122, 142, 156), under, 0.15)]


SCHEME = dict(base=(74, 86, 60), base2=(66, 77, 54), camo=[((146, 128, 94), 0.3)], camo_freq=0.28,
              dust=(140, 130, 110), mud=(70, 60, 48), wear=0.7, dust_amt=0.45, fade=(96, 104, 78))


def main():
    VB.SCHEMES['heli_camo'] = SCHEME
    d = build()
    if '--geo' in sys.argv:
        out = sys.argv[sys.argv.index('--geo') + 1]
        bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, export_apply=False)
        print('GEO', {o.name: L.tri_count(o) for o in d['lod0']}); return
    info = VB.finalize(d, NAME, 'heli_camo', decals, wreck, lod_ratio=0.35, glass_alpha=0.35)
    man_path = os.path.join(VB.OUT, 'manifest.json')
    man = json.load(open(man_path))
    man['vehicles'][NAME] = dict(
        faction='both', name='Mi-24V', kind='heli', crew=2, passengers=0,
        real_dimensions_m=dict(fuselage_length=17.51, length_rotors_turning=19.79, main_rotor_diameter=17.30, tail_rotor_diameter=3.908,
                               wing_span=6.54, height_rotor_head=3.97, fuselage_width=1.7),
        armament=['12.7 mm YakB-12.7 in the USPU-24 chin turret (muzzle)', '4 x B-8V20A, 20 x 80 mm S-8 each (rocket_L1/L2/R1/R2)', 'ASO-2V flares (flare_L / flare_R)'],
        markings='green / tan camouflage, pale blue-grey undersides; id_band_a / id_band_b = two rings round the tail boom (own materials, tinted at runtime)',
        sources=['https://en.wikipedia.org/wiki/Mil_Mi-24 (length 17.5 m fuselage / 19.79 m rotors turning, rotor 17.3 m, wing span 6.5 m, height 6.5 m overall, 5-blade main and 3-blade tail rotor, YakB-12.7, S-8 in B-8V20 pods)',
                 'https://www.airvectors.net/avhind_1.html (Mi-24V: stepped tandem cockpits, USPU-24 turret, Raduga-F pod to port, PZU intake filters, EVU exhaust mixers, L-166V Ispanka, ASO-2V)'],
        file=f'assets/vehicles/{NAME}.glb', file_mb=info['file_mb'], tris=dict(lod0=info['lod0_tris'], lod1=info['lod1_tris'], **info['wreck_tris']),
        model_bbox_m=dict(min=info['bbox_lod0'][0], max=info['bbox_lod0'][1]), materials=info['materials'],
        animated_nodes={'rotor_main': 'spin about local Y (glTF up)', 'rotor_tail': 'spin about local X'},
        frame='origin on the ground line under the main rotor axis; belly 0.62 m above it; rotor head at 3.97 m', hierarchy=info['hierarchy'])
    json.dump(man, open(man_path, 'w'), indent=1)
    print(json.dumps({k: v for k, v in info.items() if k not in ('nodes', 'hierarchy', 'node_bboxes')})[:800])


if __name__ == '__main__':
    main()
