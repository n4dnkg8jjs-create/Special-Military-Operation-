"""soldiers_v10 comms: hearing protection / comms headsets, PTTs, handheld radios in pouches, cables - per preset.

Each preset gets (when its loadout has them) two nodes:
  hs_<preset>     head-mounted, rigid with Head: ear cups (shell + leatherette seal), helmet-rail adapters (ARC arms with a
                  pivot) or the headband yoke going up under the helmet rim, volume knob / buttons, mic boom (leaders / RTOs)
  radio_<preset>  on the plate carrier: radio in an open-top pouch with retention bungee, knobs, antenna (flexible whip /
                  stub / long whip), PTT on the left shoulder strap, cable cup -> neck -> PTT (Head blending to the vest) and
                  PTT -> radio along the vest (vest weights)
Cups are fitted to the preset's own head (body variant) and helmet: centred on that head's ear, the seal on the skin round
the ear, and every cup vertex that would reach into the helmet shell is pulled inside the shell's inner surface (2 mm
clearance, smooth cone below the rim), so a cup worn under a PASGT / 6B7 / 6B47 / SSh-68 / Altyn rim tucks up under it like
the real thing; on FAST-type helmets the cups hang on the ARC rails below the cut-out.
Detail is painted (`hg_<fac>` texture shared with helmets.py, same baked height -> normal + cavity AO as packs.py): cup
shells (ComTac ribs + battery door + logo plate / Earmor M32 horizontal ribs + round battery cap / GSSh-01 central boss /
cheap muff emboss), radio fronts (display, keypad, speaker grille, labels), PTT button ring.

References (2022-25 photos): UA - Peltor ComTac III / XPI on ARC rail adapters or headband, Earmor M31 (rails) / M32
(headband, mic boom), Sordin / cheap passive muffs, AN/PRC-152 / 163 for leaders, Motorola R7 / DP4400, Baofeng UV-5R
everywhere, Silynx / Peltor-style PTT on the chest.  RU - Earmor M32 / clones, GSSh-01 (Ratnik "active headphones"),
Azart R-187-P1 for leaders, Baofeng UV-5R / UV-82, Kenwood-type handhelds; often with the 6B47."""
import numpy as np
from mathutils import Vector
import gear as G
import pouches as PO
import packs as PK
import helmets as HG
import kit as K

CDENS = 2.0                 # comms charts: 2 x packs.PXM = 1400 px/m

CM_SOLIDS = {
    'hs_seal': ('#121212', 0.55, 0.0), 'hs_yoke': ('#1c1c1b', 0.5, 0.05), 'hs_cable': ('#151515', 0.5, 0.0),
    'hs_boom': ('#141414', 0.45, 0.0), 'radio_body_black': ('#1b1c1b', 0.5, 0.0), 'radio_antenna': ('#121212', 0.55, 0.0),
    'radio_body_olive': ('#33362c', 0.55, 0.0), 'hs_cup_coyote': ('#73603f', 0.6, 0.0), 'hs_cup_od': ('#3b4031', 0.6, 0.0),
    'hs_cup_black': ('#202120', 0.55, 0.0), 'hs_cup_olive': ('#41443a', 0.6, 0.0),
}

# cup models: shell half sizes (front-back, up-down) m, shell depth, seal thickness, colour by faction variant
CUPS = {
    'comtac': dict(a=0.036, b=0.046, d=0.036, seal=0.015, knob=False, buttons=3),
    'm32': dict(a=0.035, b=0.044, d=0.032, seal=0.016, knob=True, buttons=0),
    'm31': dict(a=0.035, b=0.044, d=0.032, seal=0.016, knob=True, buttons=0),
    'gssh': dict(a=0.037, b=0.045, d=0.034, seal=0.017, knob=True, buttons=0),
    'muffs': dict(a=0.036, b=0.045, d=0.030, seal=0.016, knob=False, buttons=0),
    'clone': dict(a=0.035, b=0.044, d=0.031, seal=0.016, knob=True, buttons=0),
}
# radios: body (w, h, d), colour, antenna (kind, length), knobs
RADIOS = {
    'prc152': dict(w=0.066, h=0.165, d=0.050, col=(0.11, 0.115, 0.10), ant=('whip', 0.42), name='AN/PRC-152'),
    'r7': dict(w=0.061, h=0.127, d=0.040, col=(0.085, 0.087, 0.085), ant=('stub', 0.16), name='Motorola R7'),
    'dp4400': dict(w=0.055, h=0.130, d=0.038, col=(0.085, 0.087, 0.085), ant=('stub', 0.15), name='Motorola DP4400'),
    'uv5r': dict(w=0.058, h=0.110, d=0.032, col=(0.07, 0.07, 0.07), ant=('whip', 0.38), name='Baofeng UV-5R + long whip'),
    'uv82': dict(w=0.058, h=0.125, d=0.035, col=(0.07, 0.07, 0.07), ant=('stub', 0.19), name='Baofeng UV-82'),
    'r187': dict(w=0.068, h=0.150, d=0.046, col=(0.17, 0.18, 0.15), ant=('whip', 0.30), name='Azart R-187-P1'),
    'tk': dict(w=0.056, h=0.120, d=0.036, col=(0.08, 0.08, 0.08), ant=('stub', 0.15), name='Kenwood-type handheld'),
}
HS_NAME = {'comtac': 'Peltor ComTac III-type', 'm32': 'Earmor M32-type', 'm31': 'Earmor M31-type (rail)', 'gssh': 'GSSh-01 (Ratnik)',
           'muffs': 'cheap passive ear muffs', 'clone': 'Chinese Earmor-clone'}

# per preset: headset model, colour, mount ('rail' | 'band'), mic boom, radio, PTT, role
LOADOUT = {
    'ua': {
        'combo_0': dict(hs='m32', col='coyote', mount='band', boom=False, radio='uv5r', ptt=True, role='rifleman'),
        'combo_1': dict(hs='comtac', col='od', mount='rail', boom=True, radio='prc152', ptt=True, role='leader'),
        'combo_2': dict(hs=None, radio='uv5r', ptt=False, role='rifleman'),
        'combo_3': dict(hs='muffs', col='olive', mount='band', boom=False, radio=None, ptt=False, role='rifleman'),
        'combo_4': dict(hs='m31', col='coyote', mount='rail', boom=False, radio='r7', ptt=True, role='rifleman'),
        'combo_5': dict(hs=None, radio=None, ptt=False, role='rifleman'),
        'assault_combo_0': dict(hs='comtac', col='coyote', mount='rail', boom=True, radio='prc152', ptt=True, role='leader'),
        'assault_combo_1': dict(hs='m32', col='coyote', mount='band', boom=False, radio='r7', ptt=True, role='rifleman'),
        'assault_combo_2': dict(hs='m31', col='od', mount='rail', boom=False, radio='uv5r', ptt=True, role='rifleman'),
        'assault_combo_3': dict(hs='comtac', col='od', mount='band', boom=False, radio='dp4400', ptt=True, role='rifleman'),
    },
    'ru': {
        'combo_0': dict(hs='m32', col='black', mount='band', boom=True, radio='r187', ptt=True, role='leader'),
        'combo_1': dict(hs='gssh', col='olive', mount='band', boom=False, radio='uv82', ptt=True, role='rifleman'),
        'combo_2': dict(hs='clone', col='black', mount='band', boom=False, radio=None, ptt=False, role='rifleman'),
        'combo_3': dict(hs=None, radio='uv5r', ptt=False, role='rifleman'),
        'combo_4': dict(hs='m32', col='olive', mount='band', boom=False, radio='tk', ptt=True, role='rifleman'),
        'combo_5': dict(hs=None, radio=None, ptt=False, role='rifleman'),
        'assault_combo_0': dict(hs='m32', col='black', mount='band', boom=True, radio='r187', ptt=True, role='leader'),
        'assault_combo_1': dict(hs='gssh', col='olive', mount='band', boom=False, radio='uv82', ptt=True, role='rifleman'),
        'assault_combo_2': dict(hs='m32', col='olive', mount='band', boom=False, radio='uv5r', ptt=True, role='rifleman'),
        'assault_combo_3': dict(hs=None, radio='uv5r', ptt=False, role='rifleman'),
    },
}
CUP_COL = {'coyote': (0.45, 0.38, 0.26), 'od': (0.24, 0.26, 0.20), 'black': (0.12, 0.12, 0.12), 'olive': (0.26, 0.27, 0.22)}


def describe(fac, name):
    L = LOADOUT[fac].get(name)
    if not L:
        return None
    hs = f"{HS_NAME[L['hs']]} ({L['col']}, {'helmet rails' if L['mount'] == 'rail' else 'headband under the helmet'}{', mic boom' if L.get('boom') else ''})" if L.get('hs') else 'no ear protection'
    rd = RADIOS[L['radio']]['name'] if L.get('radio') else 'no radio'
    return dict(comms_role=L['role'], headset=hs, radio=rd, ptt=bool(L.get('ptt')))


# ------------------------------------------------------------------------------------------------ geometry helpers
def _frame(o, x, y):
    x = np.asarray(x, float); y = np.asarray(y, float)
    z = np.cross(x, y); z /= np.linalg.norm(z); y = np.cross(z, x); y /= np.linalg.norm(y); x = x / np.linalg.norm(x)
    return PO.mat4(o, x, y, z)


def _sweep(path, r, n, mat):
    p = PK._sweep(np.asarray(path, float), np.tile([0, 1.0, 0], (len(path), 1)) + 1e-3 * np.random.default_rng(1).normal(size=(len(path), 3)), r, n, mat)
    return p


def _ring_profile(a, b, pe=3.0, n=12):
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return np.stack([np.sign(np.cos(t)) * np.abs(np.cos(t)) ** (2 / pe) * a, np.sign(np.sin(t)) * np.abs(np.sin(t)) ** (2 / pe) * b], 1)


def cup_geom(spec, n=12):
    """cup in its local frame (x forward, y up, z out of the head; seal face at z=0): (seal pos, tri), (shell pos, tri, ab)"""
    a, b, d, s = spec['a'], spec['b'], spec['d'], spec['seal']
    out_ring = _ring_profile(a * 0.97, b * 0.97, 3.0, n); in_ring = _ring_profile(a * 0.58, b * 0.66, 2.6, n)
    prof = [(in_ring, 0.0015), (out_ring, 0.0015), (out_ring * 1.02, s * 0.55), (out_ring * 0.99, s), (in_ring * 1.1, s * 0.9)]
    P = np.concatenate([np.c_[r_, np.full(n, z)] for r_, z in prof])
    k = len(prof); T = []
    for j in range(k):
        j2 = (j + 1) % k
        for i in range(n):
            i2 = (i + 1) % n
            T += [[j * n + i, j * n + i2, j2 * n + i2], [j * n + i, j2 * n + i2, j2 * n + i]]
    seal = (P, np.array(T))
    # shell: dome rows (outline scale, z), cap point
    rows = [(1.0, s - 0.001), (0.98, s + d * 0.45), (0.86, s + d * 0.82), (0.55, s + d)]
    base = _ring_profile(a, b, 3.2 if spec is CUPS['comtac'] else 2.8, n)
    Ps = [np.c_[base * sc, np.full(n, z)] for sc, z in rows] + [np.array([[0, 0, s + d * 1.03]])]
    Ps = np.concatenate(Ps)
    T = []
    for j in range(len(rows) - 1):
        for i in range(n):
            i2 = (i + 1) % n
            T += [[j * n + i, j * n + i2, (j + 1) * n + i2], [j * n + i, (j + 1) * n + i2, (j + 1) * n + i]]
    ap = len(rows) * n
    jt = len(rows) - 1
    T += [[jt * n + i, jt * n + (i + 1) % n, ap] for i in range(n)]
    ab = np.stack([Ps[:, 0] + a * 1.05, b * 1.05 - Ps[:, 1]], 1)            # planar chart coordinates (a, b) in metres
    return seal, (Ps, np.array(T), ab)


# ------------------------------------------------------------------------------------------------ painters
def _paint_cup(model, colkey):
    col = np.asarray(CUP_COL[colkey], np.float32)
    def paint(cv, ch):
        sl, A, B = cv.win(ch)
        sp = CUPS[model]
        x = A - sp['a'] * 1.05; y = sp['b'] * 1.05 - B
        rr = np.sqrt((x / sp['a']) ** 2 + (y / sp['b']) ** 2)
        nz = PK.ndimage.gaussian_filter(cv.rng.standard_normal(A.shape).astype(np.float32), 0.8)
        cv.alb[sl] = col * (1 + 0.04 * nz)[..., None]; cv.tn[sl] = [0, 0, 1.0]; cv.h[sl] = 0.00004 * nz; cv.ao[sl] = 1; cv.hard[sl] = 1
        h = np.zeros(A.shape, np.float32); ao = np.ones(A.shape, np.float32); alb = cv.alb[sl]
        edge = np.clip((rr - 0.86) / 0.14, 0, 1)
        ao *= 1 - 0.25 * edge ** 2
        if model == 'comtac':
            # two raised vertical ribs either side, recessed oval battery door, small logo plate, buttons at the top rear
            for sx in (-1, 1):
                d = np.abs(x - sx * sp['a'] * 0.62)
                rib = (1 - PK._ss(0.002, 0.004, d)) * (np.abs(y) < sp['b'] * 0.72)
                h += 0.0012 * rib; ao *= 1 - 0.2 * ((d > 0.004) & (d < 0.006) & (np.abs(y) < sp['b'] * 0.72))
            door = np.sqrt((x / 0.017) ** 2 + ((y - 0.006) / 0.024) ** 2)
            h -= 0.0008 * (door < 1); ao *= 1 - 0.35 * (np.abs(door - 1) < 0.07)
            ao *= 1 - 0.3 * ((np.abs(x) < 0.0025) & (np.abs(y - 0.006 + 0.024) < 0.003))          # latch slot
            plate = PK._rect(x, y, -0.009, -0.03, 0.009, -0.022, 0.0006)
            alb = alb * (1 - plate[..., None]) + np.array([0.55, 0.55, 0.5], np.float32) * plate[..., None] * 0.8
            for k in range(sp.get('buttons', 0)):
                bd = np.hypot(x + 0.012 - k * 0.012, y - sp['b'] * 0.8)
                h += 0.0009 * (bd < 0.004); ao *= 1 - 0.3 * (np.abs(bd - 0.004) < 0.0007)
        elif model in ('m32', 'm31', 'clone'):
            # horizontal ribs over the lower half, round battery cap with a coin slot, mic socket at the front
            for k in range(4 if model != 'clone' else 3):
                yy = -0.006 - k * 0.0075
                d = np.abs(y - yy)
                rib = (1 - PK._ss(0.0012, 0.0024, d)) * (np.abs(x) < sp['a'] * (0.8 - 0.1 * k))
                h += 0.001 * rib; ao *= 1 - 0.15 * ((d > 0.0024) & (d < 0.0036)) * (np.abs(x) < sp['a'] * 0.8)
            cap = np.hypot(x, y - 0.014)
            h += 0.0012 * (cap < 0.013) - 0.0006 * ((np.abs(x) < 0.006) & (np.abs(y - 0.014) < 0.0012))
            ao *= 1 - 0.35 * (np.abs(cap - 0.013) < 0.001)
            if model != 'clone':
                lg = PK._rect(x, y, -0.011, 0.031, 0.011, 0.035, 0.0005)
                alb = alb * (1 - 0.6 * lg[..., None]) + np.array([0.6, 0.6, 0.55], np.float32) * 0.6 * lg[..., None]
        elif model == 'gssh':
            boss = np.hypot(x, y)
            h += 0.0016 * np.clip(1 - (boss / 0.02) ** 2, 0, 1) ** 0.5
            for rr_ in (0.008, 0.013, 0.018):
                ao *= 1 - 0.18 * (np.abs(boss - rr_) < 0.0008)
            for a_ in np.radians([45, 135, 225, 315]):
                sd = np.hypot(x - 0.026 * np.cos(a_), y - 0.033 * np.sin(a_))
                h += 0.0006 * (sd < 0.0022); ao *= 1 - 0.3 * (np.abs(sd - 0.0022) < 0.0006)
        else:   # muffs: embossed oval logo field
            ov = np.sqrt((x / 0.02) ** 2 + (y / 0.012) ** 2)
            h += 0.0005 * (ov < 1); ao *= 1 - 0.2 * (np.abs(ov - 1) < 0.08)
        cv.alb[sl] = alb; cv.h[sl] += h; cv.ao[sl] *= ao
    return paint


def _paint_radio(model, face):
    sp = RADIOS[model]; col = np.asarray(sp['col'], np.float32)
    def paint(cv, ch):
        sl, A, B = cv.win(ch)
        nz = PK.ndimage.gaussian_filter(cv.rng.standard_normal(A.shape).astype(np.float32), 0.8)
        cv.alb[sl] = col * (1 + 0.05 * nz)[..., None]; cv.tn[sl] = [0, 0, 1.0]; cv.h[sl] = 0; cv.ao[sl] = 1; cv.hard[sl] = 1
        w, h_ = ch.aw, ch.bh
        PK.binding(cv, ch, 0.0, 0.003)
        if face != '+z':
            if face in ('+x', '-x'):
                for k in range(6):          # grip ribs on the sides
                    m = PK._rect(A, B, 0.006, 0.03 + k * 0.012, w - 0.006, 0.035 + k * 0.012, 0.0006)
                    cv.h[sl] += 0.0006 * m
            return
        def disp(a0, b0, a1, b1):
            m = PK._rect(A, B, a0, b0, a1, b1, 0.0006)
            PK._mix(cv, sl, m, (0.16, 0.19, 0.17)); cv.h[sl] -= 0.0004 * m
            fr = PK._rect(A, B, a0 - 0.002, b0 - 0.002, a1 + 0.002, b1 + 0.002, 0.0005) * (1 - m)
            cv.ao[sl] *= 1 - 0.3 * fr
        def keys(a0, b0, nx, ny, kw, kh, gap):
            for i in range(nx):
                for j in range(ny):
                    m = PK._rect(A, B, a0 + i * (kw + gap), b0 + j * (kh + gap), a0 + i * (kw + gap) + kw, b0 + j * (kh + gap) + kh, 0.0005)
                    PK._mix(cv, sl, m, col * 1.6 + 0.03); cv.h[sl] += 0.0007 * m
        def grille(a0, b0, a1, b1, pitch=0.0035):
            m = PK._rect(A, B, a0, b0, a1, b1, 0.0005) * (((B - b0) / pitch) % 1 < 0.45)
            cv.h[sl] -= 0.0006 * m; cv.ao[sl] *= 1 - 0.45 * m
        if model == 'prc152':
            disp(0.012, 0.012, w - 0.012, 0.034); keys(0.010, 0.042, 4, 4, 0.0095, 0.0075, 0.0035)
            PK.label(cv, ch, 0.01, h_ - 0.03, w - 0.01, h_ - 0.012, (0.14, 0.14, 0.13))
        elif model in ('r7', 'dp4400', 'tk'):
            disp(0.012, 0.010, w - 0.012, 0.028); grille(0.009, 0.04, w - 0.009, h_ - 0.018)
            d = np.hypot(A - w / 2, B - (h_ - 0.01)); PK._mix(cv, sl, (np.abs(d - 0.004) < 0.0008), (0.5, 0.5, 0.5), 0.7)
        elif model in ('uv5r', 'uv82'):
            disp(0.01, 0.008, w - 0.01, 0.03); keys(0.009, 0.036, 4, 4, 0.0095, 0.0065, 0.0025)
            grille(0.012, 0.074, w - 0.012, h_ - 0.008, 0.003)
            PK.label(cv, ch, w / 2 - 0.012, 0.0025, w / 2 + 0.012, 0.0055, (0.6, 0.6, 0.6))
        elif model == 'r187':
            disp(0.012, 0.014, w - 0.012, 0.04); keys(0.012, 0.05, 3, 4, 0.012, 0.009, 0.004)
            PK.label(cv, ch, 0.012, h_ - 0.03, w - 0.012, h_ - 0.016, (0.24, 0.26, 0.21))
    return paint


def _paint_ptt(face):
    def paint(cv, ch):
        sl, A, B = cv.win(ch)
        cv.alb[sl] = (0.10, 0.10, 0.095); cv.tn[sl] = [0, 0, 1.0]; cv.h[sl] = 0; cv.ao[sl] = 1; cv.hard[sl] = 1
        PK.binding(cv, ch, 0.0, 0.0025)
        if face == '+z':
            d = np.hypot(A - ch.aw / 2, B - ch.bh * 0.45)
            cv.ao[sl] *= 1 - 0.4 * (np.abs(d - 0.0135) < 0.0012)
            PK.label(cv, ch, ch.aw / 2 - 0.008, ch.bh - 0.009, ch.aw / 2 + 0.008, ch.bh - 0.005, (0.5, 0.5, 0.48))
    return paint


# ------------------------------------------------------------------------------------------------ fitting
def _shell_limit(ctx):
    """function p -> max allowed distance from the helmet centre along p's direction (np.inf outside the shell's reach)"""
    H, c, rim_fn, surf, flare_fn = ctx['H'], ctx['c'], ctx['rim_fn'], ctx['surf'], ctx['flare_fn']
    thin = 0.0035 if H.get('thin') else 0.009
    def lim(P):
        D = P - c; r = np.linalg.norm(D, axis=1)
        az = np.arctan2(D[:, 0], D[:, 2]); el = np.arcsin(np.clip(D[:, 1] / r, -1, 1))
        re = rim_fn(az)
        u = np.clip((el - re) / ((np.pi / 2 - re) * 0.985), 0, 1)
        TT = 1 - (1 - u) ** (1 / 1.3)
        rin = np.linalg.norm(surf(az, np.maximum(el, re), flare_fn(az, TT) - thin) - c, axis=-1) - 0.002
        below = np.clip(re - el, 0, None) * 0.115                     # metres below the rim (along the shell)
        return np.where(el >= re, rin, rin + below * 1.6)
    return lim


def _clamp(P, c, lim):
    D = P - c; r = np.linalg.norm(D, axis=1)
    L = lim(P)
    s = np.where(r > L, L / r, 1.0)
    return c + D * s[:, None], int((r > L).sum())


def _ear_frame(skin, sgn, c):
    E, ylo, yhi, zlo, zhi = HG._ear(skin, sgn, c)
    ec = np.array([E[0], (ylo + yhi) / 2 - 0.004, (zlo + zhi) / 2 - 0.004])
    # seal plane: outermost skin round the ear (ring 36-44 mm from the ear centre, in the side plane)
    ring = []
    for t in np.linspace(0, 2 * np.pi, 16, endpoint=False):
        q, _ = skin.radial(ec + np.array([0, np.sin(t) * 0.042, np.cos(t) * 0.036]) - np.array([sgn * 0.02, 0, 0]))
        if q is not None:
            ring.append(q)
    ring = np.array(ring)
    xo = np.percentile(sgn * ring[:, 0], 75) + 0.0015
    o = np.array([sgn * xo, ec[1], ec[2]])
    # local +x = forward, +y = up, +z = out of the head (both sides: forward stays forward, so the frame is mirrored on one side
    # and the cup meshes are re-oriented after placing)
    M = PO.mat4(o, np.array([0, 0, 1.0]), np.array([0, 1.0, 0]), np.array([float(sgn), 0, 0]))
    return M, o, E


def build(fac, presets_, helm_ctx, skins, lms, env, parts, mats, log=print):
    """all comms nodes for the faction's presets.  presets_: list of preset dicts (name, body, helmet); helm_ctx: helmet node ->
    helmet ctx (kit.helmet); skins: body variant -> helmets.Skin; parts: gear parts so far (vest / pouches for cable routing)"""
    k = HG.key(fac)
    out = []
    by = lambda g: [p for p in parts if p['group'] == g]
    vest = by('vest')
    from mathutils.bvhtree import BVHTree
    def bvh(ps):
        P = np.concatenate([p['pos'] for p in ps]); T = []; o = 0
        for p in ps:
            T.append(p['tri'] + o); o += len(p['pos'])
        T = np.concatenate(T)
        return BVHTree.FromPolygons([tuple(v) for v in P], [tuple(map(int, t)) for t in T], all_triangles=True)
    charts = {}
    def cup_chart(model, colkey):
        kk = (model, colkey)
        if kk not in charts:
            sp = CUPS[model]
            charts[kk] = PK.Chart(k, f'cup_{model}_{colkey}', sp['a'] * 2.1, sp['b'] * 2.1, dens=CDENS, paint=_paint_cup(model, colkey))
        return charts[kk]
    rad_charts = {}
    for pr in presets_:
        L = LOADOUT[fac].get(pr['name'])
        if not L:
            continue
        bv = pr['body'][-1]; skin = skins[bv]; lm = lms[bv]
        hnode = pr['helmet']; ctx = helm_ctx[hnode]
        c = ctx['c']
        lim = _shell_limit(ctx)
        hs, rd = [], []
        n_cl = 0
        cups = {}
        if L.get('hs'):
            sp = CUPS[L['hs']]
            ch = cup_chart(L['hs'], L['col'])
            (sP, sT), (cP, cT, cab) = cup_geom(sp)
            for sgn in (1, -1):
                Mm, o, E = _ear_frame(skin, sgn, c)
                # low side rims (PASGT-type, 6B7, SSh-68, Altyn): the cup sits lower on the ear so that at least half of it shows
                # under the rim (the helmet rides on the cup tops), like photos of headsets worn under these helmets
                aze = np.arctan2(o[0] - c[0], o[2] - c[2])
                ry = float(ctx['surf'](np.array([aze]), ctx['rim_fn'](np.array([aze])))[0][1])
                dy = float(np.clip(o[1] - ry + 0.002, 0.0, 0.03))
                Mm = Mm.copy(); Mm[1, 3] -= dy; o = o - [0, dy, 0]
                seal = G.orient_closed(G.part(PO.xf(sP, Mm), sT, 'hs_seal'))
                shell = G.part(PO.xf(cP, Mm), cT, k)
                shell = G.orient_open(shell, shell['pos'] - PO.xf(np.array([[0, 0, sp['seal'] * 0.5]]), Mm)[0])
                shell['chart_ab'] = [(ch, np.arange(len(cP)), cab)]
                for q in (seal, shell):
                    q['pos'], nc = _clamp(q['pos'], c, lim); n_cl += nc
                    q['nrm'] = None
                hs += [seal, shell]
                cups[sgn] = (Mm, o, sp)
                top = PO.xf(np.array([[0, sp['b'] * 0.92, sp['seal'] + sp['d'] * 0.5]]), Mm)[0]
                if sp.get('knob') or L['hs'] in ('comtac',):
                    Rk = np.eye(4)
                    kn = PO.local_part(PO.cyl(0.0065, 0.009, 8), Mm @ PO.T(sp['a'] * 0.55, sp['b'] * 0.62, sp['seal'] + sp['d'] * 0.55), 'hs_yoke', 'hard')
                    kn['pos'], _ = _clamp(kn['pos'], c, lim)
                    if sgn > 0 or L['hs'] != 'comtac':
                        hs.append(kn)
                if L['mount'] == 'rail' and ctx['H'].get('arc') or L['mount'] == 'rail' and ctx['H'].get('rails'):
                    # ARC rail adapter: clip on the rail above the cup, arm down to a pivot on the cup's top
                    az = sgn * np.radians(96); el = np.radians(12.2 if ctx['H'].get('arc') else 14)
                    rp = np.asarray(ctx['on'](np.array(az), np.array(el), 0.0095)[0]).reshape(3)
                    rn = np.asarray(ctx['on'](np.array(az), np.array(el), 0.0)[1]).reshape(3)
                    up = np.array([0, 1.0, 0]) - rn * rn[1]; up /= np.linalg.norm(up)
                    hs.append(PO.local_part(PO.rbox(0.026, 0.016, 0.012, 0.002, 1), PO.mat4(rp + rn * 0.004, np.cross(up, rn), up, rn), 'hs_yoke', 'hard'))
                    a0 = rp + rn * 0.008; a1 = top + Mm[:3, 2] * 0.004
                    dv = a1 - a0; Lr = np.linalg.norm(dv); dv /= Lr
                    side = np.cross(dv, rn); side /= np.linalg.norm(side)
                    hs.append(PO.local_part(PO.rbox(0.014, Lr + 0.008, 0.006, 0.002, 1), PO.mat4((a0 + a1) / 2, side, dv, np.cross(side, dv)), 'hs_yoke', 'hard'))
                    Rx = np.eye(4); Rx[:3, :3] = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
                    hs.append(PO.local_part(PO.cyl(0.008, 0.012, 8), Mm @ PO.T(0, sp['b'] * 0.96, sp['seal'] + sp['d'] * 0.35) @ Rx, 'hs_yoke', 'hard'))
                else:
                    # headband yoke: fork pivot on the cup top, wire / band going up under the helmet rim (clamped inside it)
                    yk = PO.local_part(PO.rbox(0.016, 0.018, 0.010, 0.003, 1), Mm @ PO.T(0, sp['b'] * 0.98, sp['seal'] + sp['d'] * 0.35), 'hs_yoke', 'hard')
                    yk['pos'], _ = _clamp(yk['pos'], c, lim)
                    hs.append(yk)
                    p0 = PO.xf(np.array([[0, sp['b'] * 1.04, sp['seal'] * 0.8]]), Mm)[0]
                    gd = [p0, p0 + np.array([-sgn * 0.004, 0.03, 0.0]), p0 + np.array([-sgn * 0.015, 0.065, 0.0])]
                    band = HG._strap(skin, gd, 0.02, off=0.006, th=0.004, step=0.012, mat='hs_yoke')
                    band.pop('line', None)
                    band['pos'], _ = _clamp(band['pos'], c, lim)
                    hs.append(band)
            if L.get('boom'):
                Mm, o, sp = cups[1]
                p0 = PO.xf(np.array([[sp['a'] * 0.8, -sp['b'] * 0.15, sp['seal'] + sp['d'] * 0.45]]), Mm)[0]
                jaw = np.asarray(lm['jaw'], float)
                mouth = np.array([0.028, jaw[1] + 0.046, jaw[2] - 0.004])
                q, nrm = skin.radial(mouth)
                tip = (q + nrm * 0.018) if q is not None else mouth + [0.0, 0, 0.02]
                mid = (p0 + tip) / 2 + np.array([0.02, -0.012, 0.0])
                qm, nm = skin.radial(mid)
                if qm is not None and np.linalg.norm(mid - c) < np.linalg.norm(qm - c) + 0.012:
                    mid = qm + nm * 0.014
                path = np.array([p0 + (mid - p0) * u for u in np.linspace(0, 1, 4)] + [mid + (tip - mid) * u for u in np.linspace(0, 1, 5)[1:]])
                for _ in range(3):
                    path[1:-1] = 0.5 * path[1:-1] + 0.25 * (path[:-2] + path[2:])
                hs.append(_sweep(path, 0.0022, 5, 'hs_boom'))
                dv = tip - path[-2]; dv /= np.linalg.norm(dv)
                side = np.cross(dv, np.array([0, 1.0, 0])); side /= np.linalg.norm(side)
                hs.append(PO.local_part(PO.rbox(0.010, 0.020, 0.009, 0.003, 1), PO.mat4(tip, side, dv, np.cross(side, dv)), 'hs_seal', 'hard'))
                Rx = np.eye(4); Rx[:3, :3] = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
                hs.append(PO.local_part(PO.cyl(0.007, 0.008, 8), Mm @ PO.T(sp['a'] * 0.8, -sp['b'] * 0.15, sp['seal'] + sp['d'] * 0.3) @ Rx, 'hs_yoke', 'hard'))
        # ---------------- radio, pouch, PTT, cables
        m = mats
        if L.get('radio'):
            rs = RADIOS[L['radio']]
            if fac == 'ua':
                # JPC cummerbund, left front (assault: outside the side armour, where the old radio pouch was)
                Mp = K.side_M(env, 1.57, 1.10, 0.036) if pr['name'].startswith('assault_') else K.side_M(env, 1.15, 1.07, 0.015)
            else:
                Mp = K.panel_M(vest_frame(vest), 0.075, 1.247 - vest_frame(vest)['yc'])   # v13b: 1.232 sat 15 mm in the mag pouch flap
            w, h, d = rs['w'], rs['h'], rs['d']
            ph = h * 0.62
            pouch = PO.local_part(PO.rbox(w + 0.012, ph, d + 0.012, 0.007, 1), Mp @ PO.T(0, ph / 2, (d + 0.012) / 2), m['fabric'])
            rd.append(pouch)
            rd.append(PO.local_part(PO.rbox(0.02, 0.05, 0.004, 0.0015, 1), Mp @ PO.T(0, ph - 0.004, d + 0.0135), m['webbing'], 'hard'))   # bungee tab
            if L['radio'] not in rad_charts:      # one set of charts per radio model (shared by the presets)
                paints = {f: _paint_radio(L['radio'], f) for f in ('+z', '-z', '+x', '-x', '+y', '-y')}
                rad_charts[L['radio']] = PK._box(k, w, h, d, 0.005, 1, np.eye(4), k, f'radio_{L["radio"]}', paints,
                                                 dens={'+z': CDENS, '-z': 0.25, '+x': 0.8, '-x': 0.8, '+y': CDENS * 0.8, '-y': 0.2})
            rd.append(_placed(rad_charts[L['radio']], Mp @ PO.T(0, h / 2 + 0.012, (d + 0.012) / 2)))
            top = h + 0.012
            rd.append(PO.local_part(PO.cyl(0.0075, 0.012, 8), Mp @ PO.T(-w * 0.22, top, (d + 0.012) / 2), 'radio_antenna', 'hard'))
            rd.append(PO.local_part(PO.cyl(0.006, 0.010, 8), Mp @ PO.T(w * 0.12, top, (d + 0.012) / 2), 'radio_antenna', 'hard'))
            kind_, aL = rs['ant']
            ab = PO.xf(np.array([[w * 0.3, top, (d + 0.012) / 2]]), Mp)[0]
            rd.append(PO.local_part(PO.cyl(0.0055, 0.016, 6), Mp @ PO.T(w * 0.3, top, (d + 0.012) / 2), 'radio_antenna', 'hard'))
            upv = Mp[:3, 1]; outv = Mp[:3, 2]
            if fac == 'ua':
                # side radio on the cummerbund: whips bent forward and tied down along the vest toward the left shoulder strap
                # (clear of the arm), stubs leaning forward
                fwd = env.point(ab[1] + 0.12, 0.45, 0.03) - ab; fwd /= np.linalg.norm(fwd)
                if kind_ == 'whip':
                    gd = [ab + upv * 0.016, ab + upv * 0.05 + outv * 0.006, env.point(ab[1] + 0.12, 0.62, 0.032), env.point(ab[1] + 0.2, 0.38, 0.036),
                          env.point(min(ab[1] + 0.33, 1.41), 0.27, 0.04)]
                    path = _cable_path(gd, None, None, vest_tree(vest), None, step=0.03, off=0.006)
                else:
                    dv = upv * 0.8 + fwd * 0.6; dv /= np.linalg.norm(dv)
                    path = np.array([ab + upv * 0.016 + dv * aL * u for u in np.linspace(0, 1, 3)])
            else:
                # chest radio: whip leaning out over the left shoulder (clear of the face), stub straight
                lean = np.array([0.19, 0, -0.10]) if kind_ == 'whip' else np.array([0.02, 0, 0])
                path = np.array([ab + upv * (0.016 + aL * u) + lean * u ** 2 for u in np.linspace(0, 1, 7 if kind_ == 'whip' else 3)])
            ant = _sweep(path, 0.0032 if kind_ == 'stub' else 0.0021, 4, 'radio_antenna')
            rd.append(ant)
        if L.get('ptt') and L.get('radio'):
            # PTT on the front of the left shoulder strap
            sp_ = K.shoulder_strap(env, 'L', m['fabric'], percol=True)
            Pp, Dp = PK._strap_line(sp_)
            i = int(np.argmin(np.abs(Pp[:, 1] - (1.37 if fac == 'ua' else 1.40)) + (Pp[:, 2] < 0.02) * 9))
            upd = Pp[min(i + 1, len(Pp) - 1)] - Pp[max(i - 1, 0)]; upd /= np.linalg.norm(upd)
            if upd[1] < 0:
                upd = -upd
            nv = Dp[i] - upd * (Dp[i] @ upd); nv /= np.linalg.norm(nv)
            Mt = PO.mat4(Pp[i] + nv * 0.004, np.cross(upd, nv), upd, nv)
            if 'ptt' not in rad_charts:
                rad_charts['ptt'] = PK._box(k, 0.045, 0.058, 0.019, 0.006, 1, np.eye(4), k, 'ptt',
                                            {f: _paint_ptt(f) for f in ('+z', '-z', '+x', '-x', '+y', '-y')}, dens={'+z': CDENS, '-z': 0.2, '+x': 0.5, '-x': 0.5, '+y': 0.5, '-y': 0.5})
            rd.append(_placed(rad_charts['ptt'], Mt @ PO.T(0, 0, 0.0095)))
            Rx = np.eye(4); Rx[:3, :3] = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]
            rd.append(PO.local_part(PO.cyl(0.0125, 0.005, 12, 0.0115), Mt @ PO.T(0, -0.0035, 0.019) @ Rx, 'hs_seal', 'hard'))
            ptt_top = PO.xf(np.array([[0.012, 0.03, 0.009]]), Mt)[0]
            ptt_bot = PO.xf(np.array([[-0.012, -0.03, 0.009]]), Mt)[0]
            # cable 1: from the left cup (bottom rear) down the neck / collar to the PTT top
            if L.get('hs'):
                Mm, o, sp = cups[1]
                c0 = PO.xf(np.array([[-sp['a'] * 0.3, -sp['b'] * 0.92, sp['seal'] + sp['d'] * 0.35]]), Mm)[0]
                gd = [c0, c0 + np.array([-0.004, -0.04, -0.012]), np.array([0.065, 1.50, 0.0]), np.array([0.08, 1.45, 0.045]), ptt_top + Mt[:3, 1] * 0.03, ptt_top]
                cab = _cable_path(gd, None, skin, vest_tree(vest), c)
                cb = _sweep(cab, 0.0019, 5, 'hs_cable')
                s_ = np.r_[0, np.cumsum(np.linalg.norm(np.diff(cab, axis=0), axis=1))]
                hf = 1 - PK._ss(0.03, 0.09, s_)
                cb['cable_head'] = np.repeat(hf, 5)
                rd.append(cb)
            # cable 2: PTT bottom -> radio top connector, along the vest
            if L.get('radio'):
                rc = PO.xf(np.array([[-w * 0.22, top + 0.006, (d + 0.012) / 2]]), Mp)[0]
                gd = [ptt_bot, ptt_bot - Mt[:3, 1] * 0.03] + _vest_route(env, ptt_bot, rc, fac) + [rc + Mp[:3, 1] * 0.03, rc]
                cab = _cable_path(gd, None, None, vest_tree(vest), None)
                rd.append(_sweep(cab, 0.0019, 5, 'hs_cable'))
        hs = [G.orient_closed(q) if 'local' in q else q for q in hs]
        rd = [G.orient_closed(q) if 'local' in q and 'charts' not in q else q for q in rd]
        for q in hs:
            q['group'] = f'hs_{pr["name"]}'
        for q in rd:
            q['group'] = f'radio_{pr["name"]}'
        if log:
            log(f'comms {fac} {pr["name"]}: headset {sum(len(q["tri"]) for q in hs)} tris ({n_cl} cup vertices tucked under the {hnode} rim), '
                f'radio/PTT/cables {sum(len(q["tri"]) for q in rd)} tris')
        out += hs + rd
    return out


_VT = {}


def _placed(src, M):
    """copy of a chart-box part (packs._box built at identity) placed with M (charts shared)"""
    q = dict(src); q['pos'] = PO.xf(src['local'], M); q['nrm'] = None
    q['tri'] = src['tri'].copy()
    return q


def vest_tree(vest):
    key_ = id(vest[0])
    if key_ not in _VT:
        from mathutils.bvhtree import BVHTree
        P = np.concatenate([p['pos'] for p in vest]); T = []; o = 0
        for p in vest:
            T.append(p['tri'] + o); o += len(p['pos'])
        T = np.concatenate(T)
        _VT[key_] = BVHTree.FromPolygons([tuple(v) for v in P], [tuple(map(int, t)) for t in T], all_triangles=True)
    return _VT[key_]


def vest_frame(vest):
    for p in vest:
        if 'frame' in p and not p['frame'].get('back'):
            return p['frame']
    raise KeyError('front panel frame')


def _vest_route(env, a, b, fac):
    """guide points round the vest from the PTT (front left) to the radio (front / left side)"""
    tha = np.arctan2(a[0], a[2] - float(env.zcen(a[1]))); thb = np.arctan2(b[0], b[2] - float(env.zcen(b[1])))
    out = []
    for u in np.linspace(0.2, 0.85, 4):
        y = a[1] + (b[1] - a[1]) * u; th = tha + (thb - tha) * u
        out.append(env.point(y, th, 0.034))
    return out


def _cable_path(guides, _unused, skin, vtree, c, step=0.016, off=0.004):
    """polyline through the guides, resampled, pushed out of the vest (and the skin near the head), smoothed"""
    G_ = np.asarray(guides, float)
    seg = np.linalg.norm(np.diff(G_, axis=0), axis=1); L = np.r_[0, np.cumsum(seg)]
    n = max(int(L[-1] / step), 3)
    S = np.linspace(0, L[-1], n + 1)
    P = np.stack([np.interp(S, L, G_[:, i]) for i in range(3)], 1)
    for _ in range(3):
        P[1:-1] = 0.5 * P[1:-1] + 0.25 * (P[:-2] + P[2:])
    for it in range(2):
        for i in range(1, len(P) - 1):
            h = vtree.find_nearest(Vector(P[i]))
            if h[0] is not None:
                q, nn = np.array(h[0]), np.array(h[1])
                dd = (P[i] - q) @ nn
                if dd < off:
                    P[i] = P[i] + nn * (off - dd)
            if skin is not None:
                q, nrm = skin.radial(P[i])
                if q is not None and np.linalg.norm(P[i] - skin.c) < np.linalg.norm(q - skin.c) + off:
                    P[i] = q + nrm * off * (1 if nrm @ (q - skin.c) > 0 else -1)
        P[1:-1] = 0.6 * P[1:-1] + 0.2 * (P[:-2] + P[2:])
    return P
