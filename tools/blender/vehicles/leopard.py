"""Leopard 2A6 (UA, delivered 2023: 18 from Germany + 3 from Portugal, 33rd Mechanised Brigade / 21st Mechanised Brigade,
first used on the Orikhiv - Robotyne axis in June 2023).

Reference data (sources in assets/vehicles/manifest.json):
  hull 7.72 m, 10.97 m gun forward (Rh-120 L/55: 6.6 m tube), width 3.75 m over the skirts, turret roof 2.48 m (2.64 m with
  the PERI R17A2), ground clearance 0.54 m, 635 mm Diehl 570F track (82 links, 184 mm pitch) on 2.785 m centres, 7 x 700 mm
  double road wheels and 4 return rollers a side, front idler, rear sprocket, torsion bars.
  2A5/2A6 turret: spaced wedge add-on armour on the turret front and forward sides, EMES 15 gunner's sight in an armoured housing
  on the roof front right, PERI R17A2 commander's panoramic sight behind his hatch, commander right / loader left (MG3 on the
  loader's hatch rail), 2 x 8 smoke dischargers on the turret sides, stowage bustle; heavy ballistic skirts over the first three
  wheel stations, light rubber skirts behind; two round fan grilles on the engine deck, two round exhaust grilles in the rear plate.
The running gear, track band and track textures are the T-72 builder's functions with this vehicle's stations (its module
globals are set below).  Authoring frame: X right, Y forward, Z up.
"""
import sys, os, math, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
import numpy as np
from mathutils import Vector as V, Matrix
import vlib as L
from vlib import B, box, hull, prism, lathe, cyl, tube, rail, bolt
import vtex as T
import vbuild as VB
import t72 as T72
from btr import periscope_block, headlight_cluster, tow_hook, tow_cable, antenna_base

NAME = 'leopard2a6'
TRK_X, TRK_W, BAND = 1.3925, 0.635, 0.065
RW_R, RW_Z = 0.35, 0.415
RW_Y = [2.44, 1.62, 0.80, -0.02, -0.84, -1.66, -2.48]
IDL = (3.30, 0.70, 0.30)
SPR = (-3.42, 0.72, 0.325)
RR_Y, RR_Z, RR_R = [2.05, 0.75, -0.55, -1.85], 0.93, 0.10
for k_, v_ in dict(TRK_X=TRK_X, TRK_W=TRK_W, BAND=BAND, RW_R=RW_R, RW_Z=RW_Z, RW_Y=RW_Y, IDL=IDL, SPR=SPR, RR_Y=RR_Y, RR_Z=RR_Z, RR_R=RR_R).items():
    setattr(T72, k_, v_)
LINKS = 82
FRONT, REAR = 3.86, -3.86
BELLY, DECK, EDECK = 0.52, 1.66, 1.74          # belly plate / hull roof / raised engine deck
LOW_X, SUP_X, SP_Z = 1.06, 1.76, 1.08           # tub half width / sponson half width / sponson floor
SK_X0, SK_X1, SK_TOP, SK_BOT = 1.79, 1.875, 1.30, 0.62
TUR_Y = 0.42                                    # turret ring centre
TZ = DECK + 0.01
GUN_Z = DECK + 0.37                             # bore axis 2.03 m
TRUN_Y = 1.05                                   # trunnion ahead of the ring centre
GUN_L = 7.11 - (TUR_Y + TRUN_Y)                 # muzzle 3.25 m ahead of the hull front (10.97 m gun forward)
ROOF = 0.80                                     # turret roof over the deck (2.48 m)
CMD, LDR, DRV = (0.62, -0.05, 0.30), (-0.62, -0.12, 0.28), (0.60, 2.12, 0.29)   # hatch centres (turret local / hull) + radius


def road_wheel():
    """700 mm double road wheel: the T-72 wheel's section scaled to this diameter (dished aluminium discs, rubber tyres)."""
    w = T72.road_wheel(); k = RW_R / 0.376
    return w.scale(0.92, k, k)


def hull_body():
    H = B()
    lo = []
    for s in (1, -1):
        lo += [(s * LOW_X, REAR + 0.16, 0.78), (s * LOW_X, -3.40, BELLY), (s * LOW_X, 2.95, BELLY), (s * LOW_X, 3.74, 0.96),
               (s * LOW_X, FRONT, 1.08), (s * LOW_X, REAR + 0.12, 1.25), (s * LOW_X, 3.0, 1.25)]
    H.add(hull(lo, bev=0.02, segs=2))
    up = []
    for s in (1, -1):
        up += [(s * SUP_X, FRONT, 1.10), (s * SUP_X, FRONT - 0.03, SP_Z), (s * SUP_X, 2.60, 1.56), (s * SUP_X, 1.85, DECK),
               (s * SUP_X, REAR + 0.04, DECK), (s * SUP_X, REAR, SP_Z + 0.04)]
    H.add(hull(up, bev=0.022, segs=2))
    # raised engine deck with its lifting-plate seams, intake louvres ahead of the two round fan grilles
    H.add(box(2 * SUP_X - 0.1, 2.36, EDECK - DECK + 0.02, c=(0, -2.66, (EDECK + DECK) / 2), bev=0.015, segs=2))
    for s in (1, -1):
        H.add(lathe([(0.50, 0.0), (0.50, 0.035), (0.46, 0.05), (0.44, 0.05, 'cage'), (0.0, 0.05, 'cage')], 28, 'z', c=(s * 0.86, -3.18, EDECK)))
        for k in range(7):                                   # grille bars
            H.add(box(0.012, 2 * math.sqrt(max(0.44 ** 2 - (k * 0.125 - 0.375) ** 2, 0.01)), 0.02, c=(s * 0.86 + k * 0.125 - 0.375, -3.18, EDECK + 0.056), mat='gunmetal'))
        H.add(cyl(0.09, 0.05, 12, 'z', c=(s * 0.86, -3.18, EDECK + 0.07), mat='rolled'))
        for k in range(8):                                   # intake louvres
            H.add(box(0.74, 0.03, 0.022, c=(s * 0.86, -1.72 - k * 0.085, EDECK + 0.014), mat='gunmetal').rot('X', 24, (s * 0.86, -1.72 - k * 0.085, EDECK + 0.014)))
        H.add(box(0.80, 0.74, 0.012, c=(s * 0.86, -2.02, EDECK + 0.004), mat='gunmetal'))
        H.add(box(0.012, 2.3, 0.008, c=(s * 0.36, -2.66, EDECK + 0.012), mat='decal'))
        # sponson top plates: stowage (shovel, pry bar), fuel filler caps
        H.add(cyl(0.06, 0.02, 12, 'z', c=(s * 1.52, -1.2, DECK + 0.01)))
        H.add(tube([(s * 1.60, 0.2, DECK + 0.03), (s * 1.60, 1.45, DECK + 0.03)], 0.016, 6, 'wood'))
        H.add(box(0.2, 0.26, 0.012, c=(s * 1.60, 1.5, DECK + 0.03), mat='gunmetal'))
        # tow cables along the engine deck's sides
        H.add(tow_cable((s * 1.58, -1.5, EDECK + 0.03), (s * 1.58, -3.7, EDECK + 0.03)))
    H.add(box(0.012, 2 * SUP_X - 0.2, 0.008, c=(0, -1.48, DECK + 0.004), mat='decal').rot('Z', 90, (0, -1.48, DECK)))
    # glacis: driver's periscopes, headlight clusters in the nose corners, towing shackles, spare track links on the lower nose
    for a in (-22, 0, 22):
        pb = periscope_block(0.2, 0.1, 0.08).rot('Z', -a)
        H.add(pb.move(DRV[0] + math.sin(math.radians(a)) * 0.36, DRV[1] + 0.32 + math.cos(math.radians(a)) * 0.08, DECK - 0.012))
    for s in (1, -1):
        hl = headlight_cluster(s).rot('X', -20)
        H.add(hl.move(s * 1.30, 3.30, 1.345))
        H.add(tow_hook().move(s * 0.72, FRONT - 0.02, 0.9))
        H.add(box(0.5, 0.012, 0.42, c=(s * 1.52, FRONT + 0.006, 0.84), mat='skirt'))                    # front mud flap
    for k in range(5):
        H.add(box(0.16, 0.05, 0.11, c=((k - 2) * 0.17, 3.80, 0.85), mat='gunmetal', bev=0.01, segs=1).rot('X', 36, (0, 3.80, 0.85)))
    # rear plate: two round exhaust grilles, light clusters, tow hooks + pintle, telephone box, mud flaps
    for s in (1, -1):
        H.add(lathe([(0.33, 0.0), (0.33, 0.03), (0.30, 0.045), (0.28, 0.045, 'cage'), (0.0, 0.045, 'cage')], 24, 'y', c=(s * 0.95, REAR, 1.30)).rot('Z', 180, (s * 0.95, REAR, 1.30)))
        for k in range(5):
            H.add(box(2 * math.sqrt(max(0.28 ** 2 - (k * 0.11 - 0.22) ** 2, 0.01)), 0.02, 0.012, c=(s * 0.95, REAR - 0.05, 1.30 + k * 0.11 - 0.22), mat='gunmetal'))
        H.add(box(0.26, 0.05, 0.12, c=(s * 1.52, REAR - 0.02, 1.36), mat='skirt', bev=0.01, segs=1))
        H.add(box(0.07, 0.02, 0.07, c=(s * 1.46, REAR - 0.05, 1.36), mat='light'))
        H.add(box(0.07, 0.02, 0.07, c=(s * 1.58, REAR - 0.05, 1.36), mat='light'))
        H.add(tow_hook().rot('Z', 180).move(s * 0.62, REAR + 0.02, 0.92))
        H.add(box(0.56, 0.012, 0.4, c=(s * 1.50, REAR - 0.006, 0.86), mat='skirt'))
    H.add(box(0.3, 0.14, 0.26, c=(0.0, REAR - 0.07, 1.12), bev=0.012, segs=1))
    H.add(cyl(0.05, 0.12, 10, 'y', c=(0, REAR - 0.08, 0.8), mat='gunmetal'))
    H.add(box(0.22, 0.1, 0.3, c=(1.36, REAR - 0.05, 1.05), bev=0.01, segs=1))
    # driver's hatch coaming (right of the centre line)
    H.add(lathe([(DRV[2] + 0.05, 0.0), (DRV[2] + 0.05, 0.03), (DRV[2] + 0.01, 0.03), (DRV[2] + 0.01, 0.0)], 24, 'z', c=(DRV[0], DRV[1], DECK - 0.002), cap=False))
    return H


def side_skirts():
    S_ = B()
    for s in (1, -1):
        xc = s * (SK_X0 + SK_X1) / 2
        # heavy ballistic modules over the first three stations (110 mm, chamfered front), hung on the sponson
        for y0, y1 in ((3.50, 2.72), (2.70, 1.90), (1.88, 1.10)):
            poly = [(y0, SK_TOP), (y1, SK_TOP), (y1, SK_BOT + 0.02), (y0 - (0.16 if y0 > 3.4 else 0), SK_BOT + 0.02), (y0, SK_BOT + (0.2 if y0 > 3.4 else 0.02))]
            S_.add(prism(poly, 0.11, 'x', c=s * (SK_X0 + 0.055), bev=0.012, segs=1))
            for yy in (y0 - 0.12, y1 + 0.12):
                S_.add(bolt(0.022, 0.012, 6).rot('Y', 90 * s).move(s * (SK_X0 + 0.112), yy, SK_TOP - 0.1))
        # light rubber / steel skirts behind them, scalloped lower edge between the stations
        for k in range(6):
            y0 = 1.08 - k * 0.765; y1 = y0 - 0.755
            poly = [(y0, SK_TOP), (y1, SK_TOP), (y1, SK_BOT + 0.06), ((y0 + y1) / 2 - 0.2, SK_BOT + 0.02), ((y0 + y1) / 2 + 0.2, SK_BOT + 0.02), (y0, SK_BOT + 0.06)]
            S_.add(prism(poly, 0.022, 'x', mat='skirt', c=s * (SK_X0 + 0.02)))
            S_.add(box(0.03, 0.05, SK_TOP - SK_BOT - 0.12, c=(s * (SK_X0 + 0.034), y0 - 0.03, (SK_TOP + SK_BOT) / 2 + 0.05), mat='rolled'))
        # the rail they hang on, under the sponson's edge
        S_.add(box(SK_X1 - SUP_X + 0.03, 6.95, 0.035, c=(s * (SUP_X + SK_X1 - 0.03) / 2, 0.02, SK_TOP + 0.016), bev=0.006, segs=1))
    return S_


def turret():
    """Welded turret with the 2A5/2A6 wedge armour, local origin = ring centre on the deck."""
    Tu = B()
    z0, z1 = 0.07, ROOF
    body = []
    for s in (1, -1):
        for (x, y, zt) in ((0.47, 1.52, z1 - 0.07), (1.22, 1.22, z1 - 0.06), (1.50, 0.15, z1), (1.50, -1.30, z1), (0.9, -1.40, z1)):
            body += [(s * x * 0.985, y, z0), (s * x, y, z0 + 0.1), (s * x * 0.97, y, zt)]
    Tu.add(hull(body, bev=0.018, segs=2))
    # stowage bustle (ammunition behind blow-out panels, baskets on its sides and rear)
    Tu.add(box(2.46, 1.42, 0.60, c=(0, -1.98, 0.49), bev=0.02, segs=2))
    for s in (1, -1):
        Tu.add(box(0.62, 0.9, 0.012, c=(s * 0.55, -1.95, 0.796), mat='decal'))                              # blow-out panels
        Tu.add(box(0.24, 1.38, 0.5, c=(s * 1.37, -1.98, 0.45), bev=0.015, segs=1))                         # side stowage boxes
        for k in range(3):
            Tu.add(box(0.012, 0.02, 0.5, c=(s * 1.495, -1.5 - k * 0.48, 0.45), mat='gunmetal'))
    Tu.add(box(2.3, 0.3, 0.42, c=(0, -2.84, 0.42), mat='cage', bev=0.01, segs=1))                           # rear basket (mesh sides read as one volume)
    for k in range(5):
        Tu.add(box(0.02, 0.32, 0.44, c=(-1.15 + k * 0.575, -2.84, 0.42), mat='gunmetal'))
    Tu.add(box(2.34, 0.02, 0.03, c=(0, -2.995, 0.64), mat='gunmetal')); Tu.add(box(2.34, 0.02, 0.03, c=(0, -2.995, 0.21), mat='gunmetal'))
    # wedge add-on armour: a spaced module either side of the mantlet running back along the forward turret side, a vertical knife
    # edge at the front (plan view: the arrowhead), its top falling and its floor rising toward that edge
    for s in (1, -1):
        w = [(s * 0.44, 1.46, 0.10), (s * 0.44, 1.46, z1 - 0.05), (s * 0.45, 2.08, 0.31), (s * 0.45, 2.08, 0.60), (s * 0.62, 2.02, 0.29), (s * 0.62, 2.02, 0.62),
             (s * 1.63, 0.42, 0.12), (s * 1.63, 0.42, z1 - 0.02), (s * 1.30, 0.9, 0.10), (s * 1.24, 1.1, z1 - 0.045)]
        Tu.add(hull(w, bev=0.014, segs=1))
        sd = [(s * 1.50, 0.44, 0.12), (s * 1.63, 0.44, 0.14), (s * 1.63, 0.44, z1 - 0.03), (s * 1.50, 0.44, z1 - 0.01),
              (s * 1.50, -1.22, 0.12), (s * 1.60, -1.22, 0.14), (s * 1.60, -1.22, z1 - 0.03), (s * 1.50, -1.22, z1 - 0.01)]
        Tu.add(hull(sd, bev=0.01, segs=1))
        Tu.add(box(0.012, 0.012, z1 - 0.2, c=(s * 1.618, -0.4, 0.45), mat='decal'))                          # module joint
        # smoke dischargers: two blocks of four on each side, splayed out and up
        for g in range(2):
            for k in range(4):
                c0 = V((s * 1.66, -1.46 - g * 0.36 - (k % 2) * 0.13, 0.36 + (k // 2) * 0.14))
                d = V((s * 0.8, 0.25 - g * 0.5, 0.55)).normalized()
                t_ = cyl(0.047, 0.26, 10, 'z', mat='gunmetal'); t_.xf(L.place(L.frame_from_normal(d), c0 + d * 0.11)); Tu.add(t_)
            Tu.add(box(0.07, 0.3, 0.3, c=(s * 1.62, -1.52 - g * 0.36, 0.42), bev=0.008, segs=1))
        Tu.add(antenna_base().move(s * 1.05, -2.5, 0.79))
    # ---- roof
    # EMES 15 gunner's primary sight: armoured housing on the roof front right, two windows behind doors
    ex, ey = 0.80, 0.86
    Tu.add(hull([(ex - 0.33, ey - 0.3, z1 - 0.01), (ex + 0.33, ey - 0.3, z1 - 0.01), (ex - 0.33, ey + 0.3, z1 - 0.08), (ex + 0.33, ey + 0.3, z1 - 0.08),
                 (ex - 0.33, ey - 0.3, z1 + 0.25), (ex + 0.33, ey - 0.3, z1 + 0.25), (ex - 0.33, ey + 0.26, z1 + 0.22), (ex + 0.33, ey + 0.26, z1 + 0.22)], bev=0.012, segs=1))
    for dx in (-0.15, 0.15):
        Tu.add(box(0.2, 0.012, 0.15, c=(ex + dx, ey + 0.288, z1 + 0.1), mat='glass'))
    Tu.add(box(0.7, 0.03, 0.03, c=(ex, ey + 0.3, z1 + 0.235), mat='rolled'))
    # PERI R17A2 commander's panoramic sight, behind and inboard of his hatch
    px, py = 0.24, -0.78
    Tu.add(cyl(0.2, 0.1, 16, 'z', c=(px, py, z1 + 0.05)))
    Tu.add(box(0.3, 0.34, 0.42, c=(px, py, z1 + 0.31), bev=0.02, segs=2))
    Tu.add(box(0.2, 0.012, 0.16, c=(px, py + 0.172, z1 + 0.38), mat='glass'))
    Tu.add(box(0.33, 0.37, 0.03, c=(px, py, z1 + 0.535), bev=0.008, segs=1))
    # commander's cupola (right): ring of six periscopes round the hatch; loader's hatch (left) with the MG3's rail
    Tu.add(lathe([(CMD[2] + 0.12, 0.0), (CMD[2] + 0.12, 0.07), (CMD[2] + 0.02, 0.09), (CMD[2] + 0.02, 0.0)], 24, 'z', c=(CMD[0], CMD[1], z1 - 0.002), cap=False))
    for k in range(6):
        a = math.radians(-70 + k * 46)
        pb = periscope_block(0.17, 0.085, 0.07).rot('Z', -math.degrees(a))
        Tu.add(pb.move(CMD[0] + math.sin(a) * (CMD[2] + 0.16), CMD[1] + math.cos(a) * (CMD[2] + 0.16), z1 - 0.004))
    Tu.add(lathe([(LDR[2] + 0.06, 0.0), (LDR[2] + 0.06, 0.035), (LDR[2] + 0.015, 0.035), (LDR[2] + 0.015, 0.0)], 24, 'z', c=(LDR[0], LDR[1], z1 - 0.002), cap=False))
    Tu.add(lathe([(LDR[2] + 0.2, 0.05), (LDR[2] + 0.2, 0.075), (LDR[2] + 0.17, 0.075), (LDR[2] + 0.17, 0.05)], 24, 'z', c=(LDR[0], LDR[1], z1), cap=False))   # skate rail
    for k in range(4):
        a = math.radians(45 + k * 90)
        Tu.add(cyl(0.012, 0.06, 6, 'z', c=(LDR[0] + math.cos(a) * (LDR[2] + 0.185), LDR[1] + math.sin(a) * (LDR[2] + 0.185), z1 + 0.03)))
    # MG3 on the rail, laid forward
    mx, my, mz_ = LDR[0] - 0.05, LDR[1] + LDR[2] + 0.19, z1 + 0.2
    Tu.add(box(0.05, 0.08, 0.13, c=(mx, my, z1 + 0.11), mat='gunmetal'))
    Tu.add(box(0.06, 0.62, 0.075, c=(mx, my + 0.05, mz_), mat='gunmetal', bev=0.01, segs=1))
    Tu.add(cyl(0.022, 0.5, 8, 'y', c=(mx, my + 0.6, mz_ + 0.005), mat='gunmetal'))
    Tu.add(box(0.035, 0.3, 0.1, c=(mx, my - 0.4, mz_ - 0.02), mat='skirt', bev=0.01, segs=1))
    Tu.add(box(0.13, 0.2, 0.11, c=(mx - 0.1, my + 0.02, mz_ - 0.02), mat='gunmetal', bev=0.008, segs=1))
    # roof plates, lifting eyes, the gunner's auxiliary sight port beside the mantlet
    Tu.add(box(0.012, 2.3, 0.006, c=(0.0, -0.2, z1 + 0.002), mat='decal'))
    for s in (1, -1):
        for y in (0.95, -1.15):
            Tu.add(lathe([(0.05, 0.0), (0.05, 0.02), (0.03, 0.05), (0.0, 0.05)], 10, 'z', c=(s * 1.3, y, z1 - (0.05 if y > 0 else 0.0))))
    Tu.add(cyl(0.045, 0.1, 10, 'y', c=(0.42, 1.5, 0.52), mat='gunmetal'))
    return Tu


def gun():
    """Rh-120 L/55 in its mantlet, local origin = trunnion, gun along +Y."""
    G = B()
    # mantlet: the armoured block between the wedges, canvas-free; coaxial MG3 port on the left
    G.add(hull([(-0.40, 0.36, -0.30), (0.40, 0.36, -0.30), (-0.40, 0.36, 0.30), (0.40, 0.36, 0.30),
                (-0.36, 0.98, -0.2), (0.36, 0.98, -0.2), (-0.36, 0.98, 0.2), (0.36, 0.98, 0.2)], bev=0.02, segs=2))
    G.add(lathe([(0.19, 0.95), (0.19, 1.12), (0.15, 1.2), (0.125, 1.22)], 24, 'y', cap=False))
    G.add(cyl(0.035, 0.1, 10, 'y', c=(-0.27, 1.0, 0.05), mat='gunmetal'))
    # tube: thermal sleeve in sections, bore evacuator a third of the way out, muzzle reference mirror
    prof = [(0.0, 1.0), (0.118, 1.0), (0.118, 2.42), (0.15, 2.5), (0.158, 2.62), (0.158, 3.22), (0.15, 3.34), (0.112, 3.42), (0.106, 3.46),
            (0.106, GUN_L - 0.42), (0.098, GUN_L - 0.38), (0.092, GUN_L - 0.02), (0.088, GUN_L), (0.062, GUN_L), (0.062, GUN_L - 0.2), (0.0, GUN_L - 0.2)]
    G.add(lathe(prof, 24, 'y'))
    for y in (1.2, 1.82, 2.4, 3.48, 4.1, 4.72, GUN_L - 0.44):
        G.add(cyl(0.124 if y < 2.5 else 0.112, 0.028, 24, 'y', c=(0, y, 0)))
    G.add(box(0.07, 0.11, 0.06, c=(0.06, GUN_L - 0.2, 0.105), bev=0.01, segs=1))
    G.add(box(0.012, 1.2, 0.01, c=(0, 1.8, 0.119))); G.add(box(0.012, 1.9, 0.01, c=(0, 4.4, 0.107)))
    return G, (0, GUN_L, 0), (-0.27, 1.08, 0.05)


def lids(hullE, turE):
    out = []
    p, piv, ax = L.round_lid(CMD[2], 0.05, hinge=(0, -1))
    out.append(VB.hatch_lid('commander', p, piv, ax, turE, Matrix.Translation((CMD[0], TUR_Y + CMD[1], TZ + ROOF + 0.09)), open_deg=100))
    p, piv, ax = L.round_lid(LDR[2], 0.05, hinge=(0, -1))
    out.append(VB.hatch_lid('gunner', p, piv, ax, turE, Matrix.Translation((LDR[0], TUR_Y + LDR[1], TZ + ROOF + 0.035)), open_deg=100,
                            note="the loader's hatch (left): the gunner has none of his own and leaves through it"))
    p, piv, ax = L.round_lid(DRV[2], 0.05, hinge=(1, 0))
    piv = V((DRV[2] + 0.014, 0.0, 0.0))
    out.append(VB.hatch_lid('driver', p, piv, (0, 0, 1), hullE, Matrix.Translation((DRV[0], DRV[1], DECK + 0.03)), open_deg=170, sign=-1,
                            note='sliding / swinging hatch: pivots about a vertical axis on its right edge and ends up over the right sponson'))
    L.node_empty('hatch_commander', turE, (CMD[0], TUR_Y + CMD[1], TZ + ROOF + 0.15), 0.12)
    L.node_empty('hatch_gunner', turE, (LDR[0], TUR_Y + LDR[1], TZ + ROOF + 0.09), 0.12)
    L.node_empty('hatch_driver', hullE, (DRV[0], DRV[1], DECK + 0.08), 0.12)
    return out


def build():
    t0 = time.time()
    L.reset()
    root = L.node_empty('root')
    hullE = L.node_empty('hull', root, (0, 0, 0))
    H = hull_body(); H.add(side_skirts())
    print('  hull tris', H.tris(), '%.1fs' % (time.time() - t0))
    hull_bvh = L.bvh_of(H)
    hull_mesh = L.node_mesh('hull_geo', H, hullE, (0, 0, 0))
    TU = turret(); TU.move(0, TUR_Y, TZ)
    turE = L.node_empty('turret', hullE, (0, TUR_Y, TZ))
    tur_mesh = L.node_mesh('turret_geo', TU, turE, (0, TUR_Y, TZ))
    trun = (0, TUR_Y + TRUN_Y, GUN_Z)
    gunE = L.node_empty('gun_pivot', turE, trun)
    G, mz, cx = gun(); G.move(*trun)
    gun_mesh = L.node_mesh('gun_geo', G, gunE, trun)
    worst = 9.0
    for d in np.linspace(1.0, GUN_L, 60):                       # barrel over the hull at the game's lowest gun pitch (-0.1 rad)
        ax_ = V((0, trun[1] + d * math.cos(0.1), trun[2] - d * math.sin(0.1)))
        hit = hull_bvh.ray_cast(ax_, V((0, 0, -1)))
        if hit[0] is not None:
            worst = min(worst, ax_.z - 0.16 - hit[0].z)
    print('  gun depression clearance at -0.1 rad: %.3f m' % worst)
    L.node_empty('muzzle', gunE, (trun[0] + mz[0], trun[1] + mz[1], trun[2] + mz[2]), 0.1)
    L.node_empty('coax_muzzle', gunE, (trun[0] + cx[0], trun[1] + cx[1], trun[2] + cx[2]), 0.1)
    L.node_empty('smoke_launchers', turE, (0, TUR_Y - 1.6, TZ + 0.45))
    L.node_empty('commander_hatch', turE, (CMD[0], TUR_Y + CMD[1], TZ + ROOF + 0.1))
    ld = lids(hullE, turE)
    lid_objs = [l_['mesh'] for l_ in ld]
    parts = {'road': road_wheel(), 'spr': T72.sprocket().scale(1.0, SPR[2] / 0.36 * 1.06, SPR[2] / 0.36 * 1.06), 'idl': T72.idler()}
    meshes, rg = {}, []
    def wheel(name, key, side, c):
        e = L.node_empty(name, hullE, c)
        mk = key + ('R' if side > 0 else 'L')
        if mk not in meshes:
            p = L._bcopy(parts[key])
            if side < 0:
                p.scale(-1, 1, 1)
            p.move(*c)
            o = L.node_mesh(name + '_geo', p, e, c); o.data.name = mk; meshes[mk] = o.data
        else:
            o = L.node_mesh(name + '_geo', None, e, c, mesh=meshes[mk])
        rg.append(o)
    for side, tag in ((1, 'R'), (-1, 'L')):
        for i, y in enumerate(RW_Y):
            wheel(f'roadwheel_{tag}{i + 1}', 'road', side, (side * TRK_X, y, RW_Z))
        wheel(f'sprocket_{tag}', 'spr', side, (side * TRK_X, SPR[0], SPR[1]))
        wheel(f'idler_{tag}', 'idl', side, (side * TRK_X, IDL[0], IDL[1]))
    tracks = []
    for side, tag in ((1, 'R'), (-1, 'L')):
        tb, pitch, Ltot = T72.track_band(side, LINKS)
        tracks.append(L.node_mesh(f'track_{tag}', tb, hullE, (0, 0, 0), sharp=80))
    L.node_empty('exhaust', hullE, (0.95, REAR - 0.1, 1.30))
    L.node_empty('dismount_L', hullE, (-2.4, -0.6, 0.0))
    L.node_empty('dismount_R', hullE, (2.4, -0.6, 0.0))
    print('  geometry done %.1fs' % (time.time() - t0))
    lod0 = [hull_mesh, tur_mesh, gun_mesh] + lid_objs + rg + tracks
    uniq, seen = [], set()
    for o in [hull_mesh, tur_mesh, gun_mesh] + lid_objs + rg:
        if o.data.name not in seen:
            uniq.append(o); seen.add(o.data.name)
    return dict(root=root, hull=hullE, turret=turE, gun=gunE, lod0=lod0, gun_obj=gun_mesh, tur_obj=tur_mesh, cage_obj=None, atlas=uniq,
                tracks=tracks, pitch=pitch, track_len=Ltot, seats=[], lids=ld, tur_lids=[l_['mesh'] for l_ in ld if l_['entry']['parent'] == 'turret'])


def decals(P, N):
    """small white crosses on the turret's side stowage boxes and the bustle basket (2023 field markings)"""
    m = np.zeros(P.shape[:2], np.float32)
    E = lambda p: (-p[0], -p[1], p[2])
    for s_ in (1, -1):
        m += T.decal_mask(P, N, E((s_ * 1.5, TUR_Y - 2.0, TZ + 0.45)), E((s_, 0, 0)), (0, 0, 1), T.cross_shape(0.13, 0.03))
    return m


def main():
    d = build()
    if '--geo' in sys.argv:
        out = sys.argv[sys.argv.index('--geo') + 1]
        bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, export_apply=False)
        print('GEO', {o.name: L.tri_count(o) for o in d['lod0'][:3]}); return
    tm = T72.track_textures(NAME)
    info = VB.finalize(d, NAME, 'nato_3tone', decals, T72.wreck_t72, track_mats=tm)
    info['track_link_pitch_m'] = round(d['pitch'], 4); info['track_length_m'] = round(d['track_len'], 3); info['track_links'] = LINKS
    info['ride_seats'] = []
    info['hatch_lids'], anim = VB.lid_manifest(d['lids'])
    anim.update({'turret': 'yaw about local Y', 'gun_pivot': 'pitch about local X; elevate = rotation.x NEGATIVE'})
    info['animated_nodes'] = anim
    info['empties'] = {'muzzle': '120 mm L/55', 'coax_muzzle': 'MG3 coax (left of the gun)', 'smoke_launchers': 'turret sides',
                       'hatch_commander / commander_hatch': 'commander cupola (turret right)', 'hatch_gunner': 'loader hatch (turret left)',
                       'hatch_driver': 'driver hatch (hull front right)', 'exhaust': 'right exhaust grille (rear plate)',
                       'dismount_L / dismount_R': 'crew bail-out ground points beside the hull'}
    with open(os.path.join(VB.CACHE, NAME + '_info.json'), 'w') as f:
        json.dump(info, f, indent=1)
    if '--no-manifest' not in sys.argv:
        import build_all
        build_all.merge_manifest([NAME])
    print(json.dumps({k: v for k, v in info.items() if k not in ('nodes', 'hierarchy', 'node_bboxes')})[:1500])


if __name__ == '__main__':
    main()
