"""2S22 Bohdana 155 mm L/52 wheeled self-propelled howitzer, KrAZ-6322/63221 6x6 chassis with the 4-door
armoured crew cab and armoured bonnet (2022-24 field version).

Reference data (sources: arty_specs.SOURCES -> assets/vehicles/manifest.json):
  KrAZ-6322: length ~9.0 m, width 2.72 m, wheelbase 4.08 + 1.40 m, wheel track 2.16 m, 1300x530-533 tyres
  (dia ~1.3 m) with central inflation, cab roof ~3.0 m.  Bohdana: ~8.5-9 m truck + barrel over the cab
  (muzzle ~0.7 m ahead of the bumper in travel), height ~4 m over the gun mount, 25-28 t.
  Open gun mount on the rear: turntable on the frame behind the cab, upper carriage cheeks, cradle with the
  recuperator housing on top and recoil cylinders below, 155 mm L/52 barrel (8.06 m) with a large multi-baffle
  muzzle brake, loading tray behind the breech; traverse -30..+30 deg, elevation -5..+65 deg.
  Two hydraulic spades hinged at the rear end of the frame: folded up (teeth pointing back) for travel,
  lowered to dig in behind the vehicle; their top faces form the loaders' platform.
Authoring frame: X right, Y forward, Z up (see vlib).
"""
import sys, os, math, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
import numpy as np
from mathutils import Vector as V, Matrix
import vlib as L
from vlib import B, box, hull, prism, lathe, cyl, tube, rail, bolt, fillet_path
import vtex as T
import vbuild as VB
from btr import periscope_block, hatch_rect, louvre_panel, tow_hook, antenna_base, tow_cable

NAME = 'bohdana'
AXLES = [2.95, -1.13, -2.53]
TRACK = 2.16
WR = 0.65                 # tyre radius (1300 mm)
WW = 0.53                 # tyre width
WZ = 0.62                 # loaded hub height
FR_X, FR_Z0, FR_Z1 = 0.47, 0.88, 1.16      # chassis rails (half spacing, bottom, top)
DECK = 1.42               # rear platform top
CAB_Y = (0.95, 2.85)
CAB_Z = (1.30, 3.00)
CAB_X = (1.24, 1.15)      # half width at the belt line / roof
HOOD_Y = (2.85, 4.02)
HOOD_Z = (2.14, 2.04)     # bonnet top at the windscreen / at the grille
BUMPER_Y = 4.12
REAR_Y = -3.98
TT_C = (0.0, -1.95, DECK + 0.06)       # turntable centre (turret pivot)
TRUN = (0.0, -2.30, 3.25)              # trunnion
MUZ_L = 7.25                           # trunnion -> muzzle face
ELEV = (-5, 65)
TRAV = (-30, 30)
SPADE_HINGE_Y, SPADE_HINGE_Z = -4.02, 1.00
SPADE_X = 0.53                         # spade centre lines (+-)
SPADE_STOW, SPADE_DEPLOY = -65.0, 20.0 # plate angle about authoring X (0 = horizontal, pointing rearward)

def align_y(d):
    return V((0, 1, 0)).rotation_difference(V(d).normalized()).to_matrix().to_4x4()

# ================================================================================================ wheels
def truck_tyre():
    """KrAZ 1300x530-533 cross-country tyre on a steel disc wheel: big staggered shoulder lugs + centre blocks,
    domed hub with the central-inflation valve.  Outward = +X, hub at origin."""
    segs = 44
    hw = WW / 2
    prof = [(0.36, -0.215), (0.45, -0.25), (0.54, -0.262), (0.60, -0.252), (0.632, -0.23), (0.645, -0.18),
            (0.65, -0.08), (0.651, 0.0), (0.65, 0.08), (0.645, 0.18), (0.632, 0.23), (0.60, 0.252), (0.54, 0.262),
            (0.45, 0.25), (0.36, 0.215)]
    tyre = lathe([(r, h, 'tyre') for r, h in prof], segs, 'x', mat='tyre', cap=False)
    for s in (-1, 1):
        tyre.add(lathe([(0.47, s * 0.252, 'tyre'), (0.475, s * 0.268, 'tyre'), (0.49, s * 0.268, 'tyre'), (0.495, s * 0.255, 'tyre')], segs, 'x', mat='tyre', cap=False))
    R = 0.651
    n = 20
    def lug(theta, side):
        Lp = [(-0.05, 0.04), (0.035, 0.04), (0.1, 0.27), (0.01, 0.27)]
        bm = bmesh.new()
        top, bot = [], []
        for t, hh in Lp:
            for d, lst in ((-0.004, bot), (0.05, top)):
                tt = t * (0.86 if d > 0 else 1.0)
                a = theta + tt / R
                k = hh / 0.27
                rr = R + d - 0.075 * k ** 3 - (0.014 * k if d > 0 else 0)
                lst.append(bm.verts.new((side * hh, rr * math.cos(a), rr * math.sin(a))))
        bm.faces.new(bot[::-1]); bm.faces.new(top)
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((bot[i], bot[j], top[j], top[i]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        return B(bm, 'tyre')
    lugs = B(mat='tyre')
    for i in range(n):
        th = math.tau * i / n
        lugs.add(lug(th, 1))
        lugs.add(lug(th + math.tau / n / 2, -1))
    lugs.bevel(0.007, 1, 30)
    tyre.add(lugs)
    for i in range(n):
        th = math.tau * (i + 0.25) / n
        blk = box(0.06, 0.07, 0.03, mat='tyre', bev=0.006, segs=1)
        blk.xf(Matrix.Rotation(th - math.pi / 2, 4, 'X'))
        tyre.add(blk, Matrix.Translation((0, (R + 0.01) * math.cos(th), (R + 0.01) * math.sin(th))))
    rim = lathe([(0.37, 0.215, 'rim'), (0.355, 0.205, 'rim'), (0.345, 0.17, 'rim'), (0.343, 0.08, 'rim'), (0.31, 0.075, 'rim'),
                 (0.28, 0.1, 'rim'), (0.24, 0.13, 'rim'), (0.2, 0.15, 'rim'), (0.16, 0.18, 'rim'), (0.11, 0.21, 'rim'),
                 (0.06, 0.225, 'rim'), (0.0, 0.23, 'rim')], 36, 'x', mat='rim', cap=False)
    rim.add(lathe([(0.37, -0.215, 'rim'), (0.355, -0.205, 'rim'), (0.345, -0.17, 'rim'), (0.343, -0.05, 'rim'), (0.0, -0.05, 'rim')], 36, 'x', mat='rim', cap=False))
    for i in range(8):            # disc vent holes
        a = math.tau * i / 8 + 0.2
        rim.add(cyl(0.04, 0.012, 10, 'x', c=(0.135, 0.255 * math.cos(a), 0.255 * math.sin(a)), mat='gunmetal'))
    for i in range(10):
        a = math.tau * i / 10
        rim.add(bolt(0.019, 0.026, 6, 'rim').rot('Y', 90), Matrix.Translation((0.2, 0.165 * math.cos(a), 0.165 * math.sin(a))))
    rim.add(lathe([(0, 0.0), (0.04, 0.0), (0.04, 0.04), (0.028, 0.058), (0, 0.062)], 12, 'x', mat='bare', c=(0.225, 0, 0)))
    rim.add(tube(fillet_path([(0.24, 0, 0.025), (0.245, 0, 0.07), (0.19, 0, 0.17), (0.13, 0, 0.27), (0.12, 0, 0.3)], 0.03, 4), 0.013, 6, 'bare'))
    tyre.add(rim)
    return tyre

# ================================================================================================ chassis + cab
def chassis():
    H = B()
    # frame rails + cross members
    for s in (1, -1):
        H.add(box(0.1, BUMPER_Y - REAR_Y - 0.1, FR_Z1 - FR_Z0, c=(s * FR_X, (BUMPER_Y + REAR_Y) / 2 - 0.05, (FR_Z0 + FR_Z1) / 2), bev=0.008, segs=1))
    for y in (3.9, 2.0, 0.6, -0.6, -1.83, -3.3, -3.95):
        H.add(box(2 * FR_X, 0.12, 0.2, c=(0, y, (FR_Z0 + FR_Z1) / 2), bev=0.006, segs=1))
    # axles, differentials, leaf springs, balancer of the rear bogie, propeller shafts
    for i, y in enumerate(AXLES):
        H.add(cyl(0.085, TRACK - 0.25, 14, 'x', c=(0, y, WZ), mat='gunmetal'))
        H.add(lathe([(0, -0.22), (0.2, -0.2), (0.25, -0.05), (0.25, 0.05), (0.2, 0.18), (0, 0.2)], 18, 'y', mat='gunmetal', c=(0.12, y, WZ)))
        for s in (1, -1):
            H.add(cyl(0.13, 0.2, 14, 'x', c=(s * (TRACK / 2 - 0.22), y, WZ), mat='gunmetal'))
    for s in (1, -1):
        # front leaf spring pack
        for k in range(5):
            H.add(box(0.09, 1.5 - k * 0.2, 0.022, c=(s * FR_X, AXLES[0], WZ + 0.12 + k * 0.024), mat='gunmetal'))
        # rear bogie balancer springs
        for k in range(6):
            H.add(box(0.1, 1.9 - k * 0.22, 0.024, c=(s * FR_X, (AXLES[1] + AXLES[2]) / 2, WZ + 0.1 + k * 0.026), mat='gunmetal'))
        H.add(cyl(0.12, 0.24, 14, 'x', c=(s * (FR_X + 0.02), (AXLES[1] + AXLES[2]) / 2, WZ + 0.3), mat='rim'))
        for y in AXLES[1:]:
            H.add(tube([(s * FR_X, y + 0.35, FR_Z0), (s * FR_X, y, WZ + 0.12)], 0.03, 6, 'gunmetal'))   # reaction rods
    H.add(tube([(0.12, AXLES[0] - 0.2, WZ + 0.05), (0.1, 1.2, 0.85), (0.1, -0.6, 0.85), (0.12, AXLES[1] + 0.2, WZ + 0.05)], 0.05, 8, 'gunmetal'))
    H.add(tube([(0.12, AXLES[1] - 0.2, WZ + 0.05), (0.12, AXLES[2] + 0.2, WZ + 0.05)], 0.045, 8, 'gunmetal'))
    # engine sump / gearbox / transfer case under the bonnet & cab
    H.add(box(0.75, 1.3, 0.55, c=(0, 3.3, 1.05), bev=0.04, segs=2, mat='gunmetal'))
    H.add(box(0.6, 0.9, 0.45, c=(0, 1.9, 0.95), bev=0.03, segs=2, mat='gunmetal'))
    H.add(box(0.5, 0.5, 0.4, c=(0.1, 0.7, 0.85), bev=0.03, segs=2, mat='gunmetal'))
    return H

def bonnet_cab():
    C = B()
    # ---- armoured bonnet: angular box, slopes forward, side panels inward, grille front
    y0, y1 = HOOD_Y
    pts = []
    for s in (1, -1):
        pts += [(s * 0.95, y0, HOOD_Z[0]), (s * 0.92, y1 - 0.12, HOOD_Z[1]), (s * 0.90, y1, HOOD_Z[1] - 0.12),
                (s * 0.92, y1 + 0.02, 1.32), (s * 0.95, y0, 1.32), (s * 1.02, y0, 1.85), (s * 1.0, y1 - 0.05, 1.8)]
    C.add(hull(pts, bev=0.02, segs=2, angle=20))
    # grille: frame + vertical armoured slats + KrAZ badge
    gy = y1 + 0.03
    C.add(box(1.5, 0.04, 0.56, c=(0, gy - 0.01, 1.66), bev=0.01, segs=1))
    for i in range(13):
        x = -0.66 + i * 0.11
        C.add(box(0.035, 0.07, 0.5, c=(x, gy + 0.02, 1.66), bev=0.006, segs=1))
    C.add(box(1.45, 0.025, 0.46, c=(0, gy - 0.025, 1.66), mat='gunmetal'))
    C.add(cyl(0.05, 0.02, 14, 'y', c=(0, gy + 0.065, 1.98), mat='bare'))
    # bonnet top louvre + hinges + latches
    C.add(louvre_panel(0.9, 0.42, 6), Matrix.Translation((0, 3.35, HOOD_Z[0] - 0.05)) @ Matrix.Rotation(math.radians(-5), 4, 'X'))
    for s in (1, -1):
        C.add(box(0.06, 0.1, 0.05, c=(s * 0.93, 3.95, 1.95), bev=0.008, segs=1))
        C.add(rail([(s * 0.5, 3.9, 2.06), (s * 0.5, 3.96, 2.1), (s * 0.3, 3.96, 2.1), (s * 0.3, 3.9, 2.06)], r=0.01, rad=0.02))
    # ---- front wings over the front wheels (angular armoured arches)
    for s in (1, -1):
        wpts = []
        for (y, z, xo, xi) in ((AXLES[0] - 0.95, 1.32, 1.33, 0.98), (AXLES[0] - 0.75, 1.68, 1.33, 0.98), (AXLES[0] + 0.55, 1.72, 1.33, 0.98),
                               (AXLES[0] + 1.0, 1.4, 1.30, 0.98), (AXLES[0] + 1.05, 1.28, 1.28, 0.98)):
            wpts += [(s * xo, y, z), (s * xi, y, z), (s * xo, y, z - 0.04), (s * xi, y, z - 0.04)]
        C.add(hull(wpts, bev=0.01, segs=1))
        # inner wheel-arch liner + mud flap
        C.add(box(0.012, 1.7, 0.6, c=(s * 0.97, AXLES[0], 1.25), mat='rolled'))
        C.add(box(0.48, 0.012, 0.35, c=(s * TRACK / 2, AXLES[0] - 0.95, 1.12), mat='skirt', bev=0.004, segs=1))
    # ---- bumper with headlights, tow hooks, number plate, step
    C.add(box(2.48, 0.16, 0.36, c=(0, BUMPER_Y - 0.06, 1.08), bev=0.02, segs=2))
    for s in (1, -1):
        hl = lathe([(0, -0.04), (0.075, -0.04), (0.085, 0.0), (0.085, 0.03), (0, 0.03)], 18, 'y', c=(s * 0.92, BUMPER_Y + 0.03, 1.1))
        hl.add(cyl(0.072, 0.008, 18, 'y', c=(s * 0.92, BUMPER_Y + 0.062, 1.1), mat='light'))
        hl.add(box(0.12, 0.05, 0.07, c=(s * 0.72, BUMPER_Y + 0.03, 1.1), bev=0.006, segs=1))
        hl.add(box(0.09, 0.01, 0.045, c=(s * 0.72, BUMPER_Y + 0.056, 1.1), mat='light'))
        C.add(hl)
        C.add(tow_hook().rot('X', -15), Matrix.Translation((s * 0.45, BUMPER_Y + 0.02, 0.95)))
        C.add(box(0.12, 0.16, 0.6, c=(s * 1.08, BUMPER_Y - 0.08, 1.45), bev=0.01, segs=1))     # bumper-to-wing brace
    C.add(box(0.52, 0.012, 0.12, c=(0, BUMPER_Y + 0.025, 0.98), mat='bare'))
    # ---- 4-door armoured crew cab
    cy0, cy1 = CAB_Y
    cz0, cz1 = CAB_Z
    bx, rx = CAB_X
    belt = 2.22
    pts = []
    for s in (1, -1):
        pts += [(s * bx, cy0, cz0), (s * bx, cy1, cz0), (s * bx, cy0, belt), (s * bx, cy1, belt),
                (s * rx, cy0 + 0.02, cz1), (s * rx, cy1 - 0.35, cz1), (s * (rx + 0.02), cy1 - 0.02, belt + 0.12)]
    C.add(hull(pts, bev=0.025, segs=2, angle=20))
    # windscreen: two flat armoured panes in frames (raked plate from belt to roof front)
    wa, wb = V((0, cy1 - 0.02, belt + 0.12)), V((0, cy1 - 0.35, cz1))
    up = (wb - wa).normalized()
    nrm = V((0, -up.z, up.y)) if up.y < 0 else V((0, up.z, -up.y))
    if nrm.y < 0:
        nrm = -nrm
    Mw = Matrix((up.cross(nrm).normalized(), up, nrm)).transposed().to_4x4()
    wc = (wa + wb) / 2
    for s in (1, -1):
        p = wc + V((s * 0.52, 0, 0))
        win = box(0.9, 0.5, 0.03, c=(0, 0, 0.0), mat='glass')
        win.add(box(0.98, 0.06, 0.05, c=(0, 0.28, 0.015), bev=0.008, segs=1))
        win.add(box(0.98, 0.06, 0.05, c=(0, -0.28, 0.015), bev=0.008, segs=1))
        for x in (-0.47, 0.47):
            win.add(box(0.06, 0.62, 0.05, c=(x, 0, 0.015), bev=0.008, segs=1))
        for x in np.linspace(-0.42, 0.42, 6):
            win.add(bolt(0.011, 0.008), Matrix.Translation((x, 0.28, 0.04)))
            win.add(bolt(0.011, 0.008), Matrix.Translation((x, -0.28, 0.04)))
        C.add(win, L.place(Mw, p))
    C.add(box(0.12, 0.08, 0.6, c=(0, 0, 0.02), bev=0.01, segs=1), L.place(Mw, wc))       # centre pillar
    C.add(box(2.3, 0.12, 0.04, c=(0, 0.32, 0.06), bev=0.01, segs=1), L.place(Mw, wc))     # sun brow
    # wipers
    for s in (1, -1):
        C.add(tube([wc + V((s * 0.35, 0, 0)) - up * 0.28 + nrm * 0.04, wc + V((s * 0.55, 0, 0)) + up * 0.1 + nrm * 0.04], 0.008, 4, 'gunmetal'))
    # side doors (front + rear) with small armoured windows, hinges, handles; door seams
    for s in (1, -1):
        x = s * (bx + 0.003)
        for (y0d, y1d, win_w) in ((cy1 - 0.95, cy1 - 0.1, 0.42), (cy0 + 0.08, cy1 - 1.0, 0.26)):
            yc = (y0d + y1d) / 2
            C.add(box(0.012, y1d - y0d + 0.03, 1.5, c=(x, yc, cz0 + 0.86), mat='gunmetal'))       # seam gap
            d = box(0.03, y1d - y0d, 1.46, c=(x + s * 0.015, yc, cz0 + 0.86), bev=0.008, segs=1)
            d.add(box(0.012, win_w, 0.34, c=(x + s * 0.032, yc + 0.06 * s * 0, belt + 0.25), mat='glass'))
            d.add(box(0.03, win_w + 0.08, 0.04, c=(x + s * 0.035, yc, belt + 0.44), bev=0.006, segs=1))
            d.add(box(0.03, win_w + 0.08, 0.04, c=(x + s * 0.035, yc, belt + 0.06), bev=0.006, segs=1))
            for zz in (cz0 + 0.35, cz0 + 1.25):
                d.add(cyl(0.025, 0.12, 10, 'z', c=(x + s * 0.035, y1d - 0.03, zz)))
                d.add(box(0.012, 0.14, 0.07, c=(x + s * 0.033, y1d - 0.1, zz)))
            d.add(box(0.03, 0.12, 0.04, c=(x + s * 0.04, y0d + 0.14, cz0 + 0.9), bev=0.006, segs=1))
            C.add(d)
        # grab handles beside the doors, steps below
        C.add(rail([(x, cy1 + 0.02, cz0 + 0.3), (x + s * 0.05, cy1 + 0.02, cz0 + 0.3), (x + s * 0.05, cy1 + 0.02, cz0 + 1.1), (x, cy1 + 0.02, cz0 + 1.1)], r=0.012, rad=0.03))
        for y0d, y1d in ((cy1 - 0.95, cy1 - 0.1), (cy0 + 0.08, cy1 - 1.0)):
            st = box(0.3, y1d - y0d - 0.1, 0.03, c=(s * (bx - 0.05), (y0d + y1d) / 2, 0.92), bev=0.006, segs=1)
            st.add(box(0.3, y1d - y0d - 0.1, 0.03, c=(s * (bx - 0.05), (y0d + y1d) / 2, 0.62), bev=0.006, segs=1))
            for yy in (y0d + 0.08, y1d - 0.08):
                st.add(box(0.02, 0.03, 0.36, c=(s * (bx + 0.08), yy, 0.77)))
            C.add(st)
        # mirrors on arms at the front corners
        C.add(tube([(s * bx, cy1 - 0.08, belt + 0.3), (s * (bx + 0.25), cy1 + 0.05, belt + 0.45)], 0.015, 6, 'gunmetal'))
        C.add(box(0.05, 0.2, 0.32, c=(s * (bx + 0.29), cy1 + 0.07, belt + 0.45), bev=0.01, segs=1))
        # cab marker lights
        C.add(box(0.08, 0.05, 0.04, c=(s * (rx - 0.1), cy1 - 0.4, cz1 + 0.02), mat='light'))
    # roof: hatch, antenna mounts, IR camera boxes, travel lock for the barrel at the cab rear
    C.add(hatch_rect(0.6, 0.6, t=0.03, c=(0.35, 1.95, cz1), hinge='y-', rad=0.05))
    for s in (1, -1):
        C.add(antenna_base(), Matrix.Translation((s * 0.95, 1.1, cz1)))
    C.add(box(0.14, 0.12, 0.1, c=(-0.5, cy1 - 0.4, cz1 + 0.05), bev=0.01, segs=1))      # front IR camera
    C.add(cyl(0.035, 0.01, 10, 'y', c=(-0.5, cy1 - 0.335, cz1 + 0.05), mat='glass'))
    # rear wall of the cab: small window, hooks
    C.add(box(0.5, 0.012, 0.26, c=(0.3, cy0 - 0.002, belt + 0.25), mat='glass'))
    return C

def travel_lock_cab():
    """Barrel travel lock on the cab roof (rear): A-frame posts + saddle."""
    TL = B()
    y = CAB_Y[0] + 0.25
    z_top = TRUN[2] - 0.17
    for s in (1, -1):
        TL.add(tube([(s * 0.45, y - 0.12, CAB_Z[1]), (s * 0.12, y, z_top - 0.03)], 0.03, 6))
        TL.add(tube([(s * 0.45, y + 0.12, CAB_Z[1]), (s * 0.12, y, z_top - 0.03)], 0.03, 6))
        TL.add(box(0.14, 0.32, 0.03, c=(s * 0.45, y, CAB_Z[1] + 0.015)))
    TL.add(box(0.42, 0.14, 0.05, c=(0, y, z_top - 0.03), bev=0.01, segs=1))
    for s in (1, -1):
        TL.add(box(0.04, 0.14, 0.14, c=(s * 0.2, y, z_top + 0.04), bev=0.006, segs=1))
    return TL

def rear_body():
    """Platform behind the cab: deck plate, side rails, spare wheel, ammo/charge containers, tool boxes,
    fuel tank, batteries, air tanks, exhaust, rear lights, mudguards, rear control panel."""
    R = B()
    y0, y1 = CAB_Y[0] - 0.08, REAR_Y + 0.05
    R.add(box(2.5, y0 - y1, 0.05, c=(0, (y0 + y1) / 2, DECK - 0.025), bev=0.008, segs=1))
    R.add(box(2.4, y0 - y1, 0.22, c=(0, (y0 + y1) / 2, DECK - 0.16), mat='rolled'))     # platform sub-frame
    # anti-slip plate pattern rows on the deck around the mount
    for y in np.arange(y1 + 0.2, y0 - 0.1, 0.32):
        for x in (-1.1, -0.85, 0.85, 1.1):
            R.add(box(0.12, 0.03, 0.008, c=(x, y, DECK + 0.004)))
    # mudguards over the rear bogie (flat steel with rubber flaps)
    for s in (1, -1):
        R.add(box(0.62, 2.55, 0.03, c=(s * TRACK / 2, (AXLES[1] + AXLES[2]) / 2, 1.36), bev=0.006, segs=1))
        for yy in (AXLES[1] + 0.85, AXLES[2] - 0.85):
            R.add(box(0.6, 0.03, 0.2, c=(s * TRACK / 2, yy, 1.25), bev=0.005, segs=1))
        R.add(box(0.55, 0.012, 0.36, c=(s * TRACK / 2, AXLES[2] - 0.8, 1.0), mat='skirt', bev=0.004, segs=1))
    # ---- right side: spare wheel standing behind the cab
    R.add(truck_tyre(), Matrix.Translation((0.9, 0.3, DECK + 0.7)))
    R.add(box(0.1, 0.1, 0.7, c=(0.55, 0.3, DECK + 0.35)))
    R.add(box(0.36, 0.1, 0.06, c=(0.7, 0.3, DECK + 0.7)))
    # ---- ammunition / charge containers (both sides) and the left tool boxes
    def container(xc, yc, w, ln, h):
        c = box(w, ln, h, c=(xc, yc, DECK + h / 2), bev=0.012, segs=2)
        c.add(box(w + 0.02, ln + 0.02, 0.03, c=(xc, yc, DECK + h - 0.03), bev=0.005, segs=1))
        for yy in (yc - ln / 2 + 0.12, yc + ln / 2 - 0.12):
            sgn = 1 if xc > 0 else -1
            c.add(box(0.03, 0.06, 0.07, c=(xc + sgn * (w / 2 + 0.012), yy, DECK + h - 0.08)))
            c.add(box(0.03, 0.12, 0.012, c=(xc + sgn * (w / 2 + 0.01), yy, DECK + h * 0.5)))
        for yy in np.linspace(yc - ln / 2 + 0.1, yc + ln / 2 - 0.1, max(2, int(ln / 0.35))):
            c.add(box(w - 0.06, 0.025, 0.012, c=(xc, yy, DECK + h + 0.004)))
        return c
    R.add(container(-0.82, 0.05, 0.8, 1.35, 0.55))     # charges (left, behind cab)
    R.add(container(-0.82, -1.0, 0.8, 0.7, 0.5))
    R.add(container(0.82, -0.75, 0.8, 1.15, 0.5))      # projectiles (right, behind the spare)
    R.add(container(0.0, 0.42, 0.7, 0.55, 0.42))       # FCS / electronics box behind the cab
    R.add(box(0.5, 0.35, 0.3, c=(0.0, -0.15, DECK + 0.15), bev=0.015, segs=2))    # hydraulic power pack
    # field clutter: camouflage-net roll across the platform front, tarp bundle on the left box, jerrycans
    R.add(lathe([(0.0, -1.0), (0.2, -1.0, 'canvas'), (0.23, -0.9, 'canvas'), (0.24, 0.0, 'canvas'), (0.23, 0.9, 'canvas'), (0.2, 1.0), (0.0, 1.0)],
                14, 'x', mat='canvas', c=(0.0, 0.72, DECK + 0.62)))
    for x in (-0.6, 0.0, 0.6):
        R.add(lathe([(0.243, -0.03), (0.252, -0.03), (0.252, 0.03), (0.243, 0.03)], 14, 'x', mat='bare', cap=False, c=(x, 0.72, DECK + 0.62)))
    tp = hull([(-1.15, -0.75, DECK + 0.55), (-0.5, -0.75, DECK + 0.55), (-1.15, -1.3, DECK + 0.55), (-0.5, -1.3, DECK + 0.55),
               (-1.08, -0.8, DECK + 0.82), (-0.58, -0.82, DECK + 0.8), (-1.06, -1.24, DECK + 0.78), (-0.62, -1.22, DECK + 0.83)], mat='canvas', bev=0.06, segs=2)
    R.add(tp.subsurf(1))
    for k in range(3):
        jc = box(0.165, 0.34, 0.47, c=(0, 0, 0.235), bev=0.012, segs=1)
        jc.add(box(0.17, 0.2, 0.02, c=(0, 0, 0.3)))
        jc.add(cyl(0.025, 0.04, 8, 'z', c=(0, 0.1, 0.48)))
        for yy in (-0.06, 0.0, 0.06):
            jc.add(box(0.03, 0.012, 0.06, c=(0, yy, 0.47)))
        R.add(jc, Matrix.Translation((1.07, -1.85 - k * 0.37, DECK)))
    R.add(box(0.05, 1.15, 0.04, c=(1.17, -2.22, DECK + 0.3)))
    # side rails (cargo side boards) along the platform, folded crew steps
    for s in (1, -1):
        R.add(box(0.04, 1.6, 0.36, c=(s * 1.26, -0.4, DECK + 0.18), bev=0.006, segs=1))
        for yy in (-1.2, -0.4, 0.4):
            R.add(box(0.06, 0.05, 0.4, c=(s * 1.27, yy, DECK + 0.2)))
        R.add(box(0.05, 1.6, 0.04, c=(s * 1.27, -0.4, DECK + 0.36)))
        # folding side work platform (folded up against the frame) behind the rear wheels
        fp = box(0.035, 0.9, 0.5, c=(s * 1.27, -3.35, DECK - 0.15), bev=0.006, segs=1)
        fp.add(box(0.05, 0.9, 0.03, c=(s * 1.29, -3.35, DECK + 0.09)))
        fp.add(cyl(0.02, 0.9, 8, 'y', c=(s * 1.27, -3.35, DECK - 0.4)))
        R.add(fp)
        # grab rails along the deck edge at the mount
        R.add(rail([(s * 1.22, -1.5, DECK), (s * 1.22, -1.5, DECK + 0.7), (s * 1.22, -3.1, DECK + 0.7), (s * 1.22, -3.1, DECK)], r=0.016, rad=0.06))
    # ---- under-platform: fuel tank (left), batteries + air tanks (right), exhaust silencer + stack
    ft = lathe([(0.0, -0.55), (0.26, -0.55), (0.28, -0.52), (0.28, 0.52), (0.26, 0.55), (0.0, 0.55)], 20, 'y', c=(-1.0, 0.45, 0.98))
    ft.add(cyl(0.05, 0.04, 10, 'z', c=(-1.0, 0.6, 1.27), mat='rolled'))
    for yy in (0.1, 0.8):
        ft.add(lathe([(0.283, -0.025), (0.29, -0.025), (0.29, 0.025), (0.283, 0.025)], 20, 'y', mat='bare', cap=False, c=(-1.0, yy, 0.98)))
    R.add(ft)
    R.add(box(0.5, 0.7, 0.45, c=(1.0, 0.5, 0.98), bev=0.015, segs=2))
    R.add(box(0.52, 0.72, 0.03, c=(1.0, 0.5, 1.22)))
    for x in (0.75, 1.0):
        R.add(cyl(0.11, 0.6, 14, 'y', c=(x, -0.35, 1.0), mat='rolled'))
    R.add(cyl(0.12, 0.7, 14, 'y', c=(-0.85, -0.45, 0.95), mat='gunmetal'))         # silencer
    R.add(tube([(-0.85, -0.1, 0.95), (-0.98, 0.0, 1.2), (-1.0, 0.0, 2.6)], 0.06, 10, 'gunmetal'))
    R.add(cyl(0.075, 0.25, 12, 'z', c=(-1.0, 0.0, 2.45), mat='gunmetal'))           # stack guard
    for k in range(5):
        R.add(box(0.012, 0.07, 0.4, c=(-1.0 - 0.075 * math.cos(k), 0.0 - 0.075 * math.sin(k), 2.45), mat='rolled'))
    # ---- rear end: cross beam with lights, rear control station, tow hitch
    R.add(box(2.4, 0.14, 0.3, c=(0, REAR_Y, 1.0), bev=0.015, segs=1))
    for s in (1, -1):
        rl = box(0.26, 0.06, 0.1, c=(s * 1.0, REAR_Y - 0.05, 1.08), bev=0.008, segs=1)
        rl.add(box(0.07, 0.012, 0.06, c=(s * 0.92, REAR_Y - 0.085, 1.08), mat='light'))
        rl.add(box(0.07, 0.012, 0.06, c=(s * 1.08, REAR_Y - 0.085, 1.08), mat='light'))
        R.add(rl)
    R.add(box(0.4, 0.2, 0.3, c=(-0.95, REAR_Y + 0.25, DECK + 0.4), bev=0.015, segs=2))    # rear control panel
    R.add(box(0.3, 0.012, 0.18, c=(-0.95, REAR_Y + 0.145, DECK + 0.42), mat='gunmetal'))
    R.add(box(0.05, 0.05, 0.4, c=(-0.95, REAR_Y + 0.25, DECK + 0.05)))
    R.add(tube(fillet_path([(0, REAR_Y - 0.05, 0.92), (0, REAR_Y - 0.22, 0.92), (0, REAR_Y - 0.22, 0.8)], 0.04, 3), 0.03, 8))
    # spade hinge brackets + hydraulic ram anchors on the frame end
    for s in (1, -1):
        for dx in (-0.4, 0.4):
            R.add(box(0.05, 0.22, 0.3, c=(s * SPADE_X + dx, SPADE_HINGE_Y + 0.08, SPADE_HINGE_Z - 0.05), bev=0.008, segs=1))
        R.add(cyl(0.05, 0.86, 10, 'x', c=(s * SPADE_X, SPADE_HINGE_Y, SPADE_HINGE_Z)))
    return R

# ================================================================================================ gun mount
def gun_mount():
    """Turret = turntable + lower/upper carriage (world coords).  Gunner's station on the left."""
    M = B()
    cx, cy, cz = TT_C
    M.add(lathe([(0, 0), (0.95, 0), (0.95, 0.08), (0.88, 0.12), (0, 0.12)], 40, 'z', c=(cx, cy, cz - 0.06)))
    for i in range(18):
        a = math.tau * i / 18
        M.add(bolt(0.014, 0.01), Matrix.Translation((cx + 0.88 * math.cos(a), cy + 0.88 * math.sin(a), cz + 0.02)))
    # lower carriage: box pedestal
    M.add(hull([(x, y, cz + 0.06) for x in (-0.62, 0.62) for y in (cy + 0.75, cy - 0.85)] +
               [(x, y, cz + 0.62) for x in (-0.55, 0.55) for y in (cy + 0.55, cy - 0.8)], bev=0.02, segs=2))
    # upper carriage cheeks (trapezoid plates) up to the trunnions
    ty, tz = TRUN[1], TRUN[2]
    for s in (1, -1):
        poly = [(cy + 0.6, cz + 0.6), (cy - 0.95, cz + 0.6), (ty - 0.42, tz - 0.05), (ty - 0.2, tz + 0.18), (ty + 0.22, tz + 0.18), (ty + 0.5, tz - 0.25)]
        ch = prism(poly, 0.05, 'x', c=s * 0.47, bev=0.008, segs=1)
        ch.add(lathe([(0, -0.03), (0.15, -0.03), (0.15, 0.03), (0, 0.03)], 20, 'x', c=(s * 0.5, ty, tz)))   # trunnion boss
        ch.add(box(0.05, 1.2, 0.08, c=(s * 0.5, cy - 0.15, cz + 0.98), bev=0.008, segs=1))           # stiffener
        M.add(ch)
    M.add(box(0.9, 0.06, 0.6, c=(0, cy + 0.55, cz + 0.9), bev=0.008, segs=1))                      # front web
    # elevating arc + gearbox on the left, handwheels, panoramic sight + gunner seat
    M.add(box(0.18, 0.3, 0.3, c=(-0.62, ty + 0.25, tz - 0.55), bev=0.015, segs=2))
    for (y, z, r) in ((ty + 0.25, tz - 0.55, 0.16), (ty - 0.2, tz - 0.85, 0.13)):
        wh = lathe([(r - 0.012, -0.012), (r + 0.012, -0.012), (r + 0.012, 0.012), (r - 0.012, 0.012)], 18, 'x', cap=False)
        for k in range(3):
            a = math.tau * k / 3
            wh.add(tube([(0, 0, 0), (0, r * math.cos(a), r * math.sin(a))], 0.008, 4))
        wh.add(cyl(0.012, 0.08, 6, 'x', c=(-0.04, r * 0.7, 0)))
        M.add(wh, Matrix.Translation((-0.78, y, z)))
    M.add(box(0.12, 0.12, 0.6, c=(-0.68, ty - 0.1, tz - 0.3), bev=0.01, segs=1))            # sight bracket
    M.add(box(0.16, 0.22, 0.18, c=(-0.7, ty - 0.1, tz + 0.08), bev=0.015, segs=2))           # panoramic sight
    M.add(cyl(0.05, 0.12, 12, 'z', c=(-0.7, ty - 0.12, tz + 0.23)))
    M.add(box(0.08, 0.1, 0.08, c=(-0.7, ty - 0.05, tz + 0.32), bev=0.01, segs=1))
    M.add(box(0.06, 0.012, 0.04, c=(-0.7, ty + 0.002, tz + 0.33), mat='glass'))
    M.add(box(0.4, 0.4, 0.06, c=(-0.85, ty - 0.55, cz + 0.62), bev=0.01, segs=1))            # gunner's seat + post
    M.add(box(0.4, 0.06, 0.4, c=(-0.85, ty - 0.75, cz + 0.85), bev=0.01, segs=1))
    M.add(cyl(0.03, 0.55, 8, 'z', c=(-0.85, ty - 0.55, cz + 0.33)))
    # control/FCS box on the right cheek, hydraulic lines
    M.add(box(0.2, 0.42, 0.36, c=(0.64, ty + 0.05, tz - 0.62), bev=0.015, segs=2))
    M.add(box(0.012, 0.3, 0.2, c=(0.745, ty + 0.05, tz - 0.6), mat='gunmetal'))
    for s in (1, -1):
        M.add(tube([(s * 0.52, cy + 0.3, cz + 0.62), (s * 0.55, ty + 0.4, tz - 0.6), (s * 0.52, ty + 0.15, tz - 0.25)], 0.012, 5, 'gunmetal'))
    # equilibrator cylinders (static approximation, front of the carriage)
    for s in (1, -1):
        M.add(tube([(s * 0.36, cy + 0.6, cz + 0.65), (s * 0.36, ty + 0.65, tz - 0.4)], 0.07, 12, 'rolled'))
    return M

def gun_155():
    """155 mm L/52 on its cradle.  Local origin = trunnion, barrel +Y."""
    G = B()
    # cradle body around the barrel + recuperator housing on top + recoil brakes below
    G.add(box(0.56, 2.6, 0.46, c=(0, 0.45, 0.0), bev=0.03, segs=2))
    G.add(hull([(x, y, z) for x in (-0.25, 0.25) for y in (-0.45, 1.6) for z in (0.22, 0.56)] +
               [(x, 1.95, z) for x in (-0.2, 0.2) for z in (0.22, 0.42)] + [(x, -0.62, z) for x in (-0.2, 0.2) for z in (0.24, 0.48)], bev=0.035, segs=2))
    for y in (0.1, 0.8, 1.4):
        G.add(box(0.54, 0.05, 0.05, c=(0, y, 0.56), bev=0.01, segs=1))
    for s in (1, -1):
        G.add(lathe([(0, -0.2), (0.075, -0.2), (0.075, 1.85), (0.06, 1.92), (0, 1.94)], 14, 'y', c=(s * 0.16, 0, -0.3)))
    G.add(box(0.05, 2.2, 0.05, c=(-0.3, 0.6, 0.12), bev=0.01, segs=1))           # sight linkage bar
    for y in np.linspace(-0.2, 1.6, 6):
        for s in (1, -1):
            G.add(bolt(0.013, 0.009).rot('Y', 90 * s), Matrix.Translation((s * 0.28, y, 0.1)))
    # elevating sector on the left of the cradle
    sec = prism([(math.cos(a) * 0.62, math.sin(a) * 0.62) for a in np.linspace(math.radians(-110), math.radians(-40), 9)] + [(0, 0)],
                0.04, 'x', c=-0.33, bev=0.006, segs=1)
    G.add(sec)
    # breech ring + block, loading tray / rammer behind
    G.add(box(0.46, 0.4, 0.46, c=(0, -0.95, 0.0), bev=0.03, segs=2))
    G.add(box(0.3, 0.06, 0.3, c=(0, -1.18, 0.0), mat='gunmetal', bev=0.01, segs=1))
    G.add(cyl(0.03, 0.4, 8, 'x', c=(0, -1.1, -0.15), mat='bare'))                 # breech handle shaft
    for s in (1, -1):
        G.add(box(0.05, 0.9, 0.05, c=(s * 0.24, -1.55, -0.12), bev=0.008, segs=1))
        G.add(rail([(s * 0.3, -1.2, 0.05), (s * 0.34, -1.4, 0.25), (s * 0.34, -1.9, 0.25), (s * 0.3, -2.0, 0.05)], r=0.014, rad=0.06))
    G.add(prism([(-0.17, -0.06), (0.17, -0.06), (0.2, 0.04), (-0.2, 0.04)], 0.8, 'y', c=-1.6, bev=0.008, segs=1).move(0, 0, -0.14))
    G.add(box(0.26, 0.14, 0.14, c=(0, -2.0, -0.12), bev=0.012, segs=1))           # rammer head housing
    # barrel
    prof = [(0.0, -0.75), (0.172, -0.75), (0.17, 1.9), (0.19, 1.95), (0.19, 2.08), (0.165, 2.12), (0.16, 3.0), (0.14, 5.0),
            (0.125, 6.55), (0.142, 6.58), (0.142, 6.66), (0.0, 6.66)]
    G.add(lathe(prof, 28, 'y'))
    # multi-baffle muzzle brake: boxy body with three vertical side ports per side
    y0, y1 = 6.66, MUZ_L
    mb = B()
    mb.add(box(0.4, y1 - y0, 0.07, c=(0, (y0 + y1) / 2, 0.16), bev=0.012, segs=1))
    mb.add(box(0.4, y1 - y0, 0.07, c=(0, (y0 + y1) / 2, -0.16), bev=0.012, segs=1))
    for k, y in enumerate(np.linspace(y0 + 0.03, y1 - 0.03, 4)):
        w = 0.06 if k in (0, 3) else 0.05
        baf = prism([(-0.2, -0.13), (0.2, -0.13), (0.2, 0.13), (-0.2, 0.13)], w, 'y', c=y, bev=0.01, segs=1)
        mb.add(baf)
        mb.add(cyl(0.072, w + 0.004, 18, 'y', c=(0, y, 0), mat='gunmetal'))
    mb.add(lathe([(0.0, y1 + 0.005), (0.072, y1 + 0.005)], 18, 'y', mat='gunmetal', cap=False))
    G.add(mb)
    return G

# ================================================================================================ spades
def spade_part():
    """One spade in its canonical pose: hinge at the origin, plate horizontal pointing rearward (-Y), top = +Z
    (loaders' walking surface when lowered), digging blade at the far end pointing down (-Z)."""
    S = B()
    Lp, W, t = 1.3, 0.96, 0.06
    S.add(box(W, Lp, t, c=(0, -Lp / 2 - 0.05, 0.0), bev=0.01, segs=1))
    for x in np.linspace(-0.38, 0.38, 5):                # anti-slip bars on the walking surface
        S.add(box(0.04, Lp - 0.2, 0.015, c=(x, -Lp / 2 - 0.05, t / 2 + 0.006)))
    for s in (1, -1):                                    # side + underside stiffeners
        S.add(box(0.05, Lp, 0.16, c=(s * (W / 2 - 0.025), -Lp / 2 - 0.05, -0.08), bev=0.008, segs=1))
    S.add(box(0.05, Lp - 0.1, 0.12, c=(0, -Lp / 2 - 0.05, -0.07), bev=0.008, segs=1))
    S.add(cyl(0.07, W - 0.12, 14, 'x', c=(0, 0, 0)))    # hinge tube
    # blade at the end (perpendicular, pointing down), toothed edge, gussets
    bl = -Lp - 0.05
    S.add(box(W, 0.06, 0.62, c=(0, bl, -0.31), bev=0.01, segs=1))
    for k in range(5):
        x = -0.38 + k * 0.19
        S.add(hull([(x - 0.07, bl - 0.03, -0.6), (x + 0.07, bl - 0.03, -0.6), (x - 0.07, bl + 0.03, -0.6), (x + 0.07, bl + 0.03, -0.6),
                    (x, bl - 0.02, -0.76), (x, bl + 0.02, -0.76)], bev=0.006, segs=1))
    for x in (-0.3, 0.3):
        S.add(prism([(bl + 0.03, -0.02), (bl + 0.4, -0.02), (bl + 0.03, -0.5)], 0.04, 'x', c=x, bev=0.006, segs=1))
    # hydraulic ram along the plate underside (cylinder + rod + clevis)
    S.add(tube([(0, -0.25, -0.2), (0, -0.85, -0.2)], 0.065, 12, 'rolled'))
    S.add(tube([(0, -0.85, -0.2), (0, -1.15, -0.18)], 0.035, 10, 'bare'))
    S.add(box(0.12, 0.1, 0.12, c=(0, -0.22, -0.18), bev=0.01, segs=1))
    return S

# ================================================================================================ build
def build():
    t0 = time.time()
    L.reset()
    root = L.node_empty('root')
    hullE = L.node_empty('hull', root, (0, 0, 0))
    H = chassis()
    H.add(bonnet_cab())
    H.add(rear_body())
    H.add(travel_lock_cab())
    print('  hull tris', H.tris(), '%.1fs' % (time.time() - t0))
    hull_mesh = L.node_mesh('hull_geo', H, hullE, (0, 0, 0))
    # ---- gun mount (turret) + gun
    TU = gun_mount()
    turE = L.node_empty('turret', hullE, TT_C)
    tur_mesh = L.node_mesh('turret_geo', TU, turE, TT_C)
    gunE = L.node_empty('gun_pivot', turE, TRUN)
    G = gun_155()
    G.move(*TRUN)
    gun_mesh = L.node_mesh('gun_geo', G, gunE, TRUN)
    L.node_empty('muzzle', gunE, (TRUN[0], TRUN[1] + MUZ_L, TRUN[2]), 0.1)
    L.node_empty('breech', gunE, (TRUN[0], TRUN[1] - 1.18, TRUN[2]), 0.1)
    L.node_empty('gunner_station', turE, (-0.85, TRUN[1] - 0.55, TT_C[2] + 0.68))
    # ---- spades (hinged nodes, built in the stowed pose)
    spades = []
    for s, tag in ((-1, 'L'), (1, 'R')):
        hp = (s * SPADE_X, SPADE_HINGE_Y, SPADE_HINGE_Z)
        e = L.node_empty(f'spade_{tag}', hullE, hp)
        p = spade_part()
        p.rot('X', SPADE_STOW)
        p.move(*hp)
        spades.append(L.node_mesh(f'spade_{tag}_geo', p, e, hp))
    # ---- wheels
    W = truck_tyre()
    Wl = L._bcopy(W); Wl.scale(-1, 1, 1)
    meR = meL = None
    wheel_objs = []
    for side, tag in ((1, 'R'), (-1, 'L')):
        for i, y in enumerate(AXLES):
            c = (side * TRACK / 2, y, WZ)
            e = L.node_empty(f'wheel_{tag}{i + 1}', hullE, c)
            src = W if side > 0 else Wl
            me = meR if side > 0 else meL
            if me is None:
                part = L._bcopy(src); part.move(*c)
                o = L.node_mesh(f'wheel_{tag}{i + 1}_geo', part, e, c)
                if side > 0:
                    meR = o.data
                else:
                    meL = o.data
            else:
                o = L.node_mesh(f'wheel_{tag}{i + 1}_geo', None, e, c, mesh=me)
            wheel_objs.append(o)
    meR.name = 'wheel_R'; meL.name = 'wheel_L'
    # ---- empties
    L.node_empty('exhaust', hullE, (-1.0, 0.0, 2.62))
    cy0, cy1 = CAB_Y
    for s, tag in ((-1, 'L'), (1, 'R')):
        L.node_empty(f'cab_door_F{tag}', hullE, (s * (CAB_X[0] + 0.05), cy1 - 0.52, CAB_Z[0] + 0.8))
        L.node_empty(f'cab_door_R{tag}', hullE, (s * (CAB_X[0] + 0.05), (cy0 + 0.08 + cy1 - 1.0) / 2, CAB_Z[0] + 0.8))
        L.node_empty(f'dismount_{tag}', hullE, (s * 2.0, cy1 - 0.9, 0.0))
    L.node_empty('commander_hatch', hullE, (0.35, 1.95, CAB_Z[1] + 0.05))
    # deployed gun-crew working positions (ground / spade platform), hull frame
    L.node_empty('gun_crew_1', hullE, (-0.25, REAR_Y - 0.75, 0.77))      # loader on the spade platform behind the breech
    L.node_empty('gun_crew_2', hullE, (0.55, REAR_Y - 0.6, 0.82))        # charge loader
    L.node_empty('gun_crew_3', hullE, (1.9, -1.0, 0.0))                # ammo handler at the right containers (ground)
    L.node_empty('gun_crew_4', hullE, (-1.9, 0.0, 0.0))                # charges / rear control panel
    print('  geometry done %.1fs' % (time.time() - t0))
    lod0 = [hull_mesh, tur_mesh, gun_mesh] + spades + wheel_objs
    return dict(root=root, hull=hullE, turret=turE, gun=gunE, lod0=lod0, gun_obj=gun_mesh, tur_obj=tur_mesh, spades=spades,
                atlas=[hull_mesh, tur_mesh, gun_mesh, spades[0], spades[1], wheel_objs[0], wheel_objs[3]])

def wreck(d):
    """Burnt truck on its rims (tyres gone, chassis dropped) + burnt gun mount with drooped barrel."""
    root = d['root']
    drop = WZ - 0.37
    hw = VB.join_copies('hull_wreck', [o for o in d['lod0'] if o.name.startswith(('hull_geo', 'wheel_', 'spade_'))], root,
                        (0, 0, 0), drop_slots=('tyre', 'glass', 'light'), drop_z=drop)
    g = d['gun_obj']
    g.rotation_euler = (math.radians(4), 0, 0)
    bpy.context.view_layer.update()
    tp = d['turret'].matrix_world.translation.copy()
    tw = VB.join_copies('turret_wreck', [d['tur_obj'], g], root, tuple(tp), drop_slots=('glass', 'light'))
    g.rotation_euler = (0, 0, 0)
    tw.location.z -= drop
    bpy.context.view_layer.update()
    return [hw, tw]

def decals(P, N):
    """White crosses (Ukrainian ID marks 2022-24) on the cab sides, bonnet and the cradle sides."""
    m = np.zeros(P.shape[:2], np.float32)
    E = lambda p: (-p[0], -p[1], p[2])
    for s in (1, -1):
        m += T.decal_mask(P, N, E((s * (CAB_X[0] + 0.05), CAB_Y[0] + 0.38, 2.0)), E((s, 0, 0)), (0, 0, 1), T.cross_shape(0.16, 0.035))
        m += T.decal_mask(P, N, E((s * 0.285, TRUN[1] + 1.1, TRUN[2] + 0.02)), E((s, 0, 0)), (0, 0, 1), T.cross_shape(0.13, 0.03))
    m += T.decal_mask(P, N, E((0, 3.3, 2.12)), E((0, 0.05, 1)), (0, 1, 0), T.cross_shape(0.2, 0.045))
    return m

VB.SCHEMES['ua_bohdana'] = dict(base=(60, 70, 42), base2=(52, 61, 37), camo=[((34, 36, 28), 0.22), ((104, 92, 64), 0.12)],
                                camo_freq=0.6, dust=(140, 130, 108), mud=(66, 56, 44), wear=1.1, dust_amt=1.0, fade=(86, 92, 64))

def main(argv):
    quick = '--quick' in argv
    dev = '--dev' in argv
    d = build()
    if quick:
        import msta
        out = os.path.join(VB.REPO, 'previews', 'vehicles_arty', '_quick_' + NAME + '.glb')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        msta.quick_export(d, out)
        return
    VB.SOOT[:] = [((-1.0, 0.0, 2.7), 0.35)]
    out = os.path.join(VB.REPO, 'previews', 'vehicles_arty', '_dev_' + NAME + '.glb') if dev else None
    info = VB.finalize(d, NAME, 'ua_bohdana', decals, wreck, out=out)
    with open(os.path.join(VB.CACHE, NAME + '_info.json'), 'w') as f:
        json.dump(info, f, indent=1)
    print(json.dumps({k: v for k, v in info.items() if k not in ('hierarchy', 'node_bboxes')}))
    if not dev:
        import arty_specs
        arty_specs.write_manifest([NAME])
    return info

if __name__ == '__main__':
    main(sys.argv[1:])
