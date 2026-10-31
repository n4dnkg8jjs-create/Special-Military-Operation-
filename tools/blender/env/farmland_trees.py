"""Windbreak trees, bushes and field crops for farmland.glb (+ far LODs).
Material 0 = farmland_atlas (bark / splintered wood regions), material 1 = farmland_foliage (alpha-tested cards).

Trees are grown like build_trees.py (recursive trunk -> limbs -> branches -> twigs, tapered bark tubes) but with
denser, species-specific foliage: every twig carries a spray of leaf-cluster cards (512^2 clusters + 2:1 twig sprays),
card normals are bent outward from the crown ellipsoid (soft, volumetric lighting instead of flat-shaded cards) and
a per-vertex colour darkens the inner / lower crown (baked self-shadow).  A TMB keeps those per-vertex extras; the
builder writes them as custom split normals + COLOR_0.
  tree_acacia_leafy   black locust (Robinia pseudoacacia), the lesopolosa tree: leaning sinuous trunk forking into
                      2-3 zig-zag leaders, open irregular clumpy crown, fine pinnate foliage with seed pods, 10.5 m
  tree_acacia_shelled same species half dead: leader snapped by shellfire, broken / hanging / bare limbs, trunk scar,
                      sparse yellowing foliage
  tree_poplar_leafy   Lombardy poplar, columnar 20 m (fastigiate branches hugging the stem)
  tree_oak_leafy      pedunculate oak, 12 m, broad crown on a thick short trunk, heavy spreading limbs
  tree_walnut_leafy   village garden walnut, 9 m, broad round crown, pale grey bark
  bush_a / bush_b     elder (multi-stem, berry umbels, 3 m) / dog rose (arching canes, red hips, 2.2 m)
  *_lod1              same origin and size: trunk (+ leaders) prism + ~20 crown clumps of 3 cards each using the dense
                      far_* clump cells; same normals / AO scheme so colour matches the near model.
  sunflower_dead_clump / corn_dry_clump / weeds_tall_clump   <= 250 tris, foliage material only.
"""
import math
import numpy as np
from meshlib import MB, Region, newell, xform, mat_trs, rot_axis, rng
import farmland_foliage as FF
import farmland_atlas as FA
import city_geo as G

# city_geo helpers resolve region names through G.R: point them at the farmland atlas
G.R = {k: Region(*v) for k, v in FA.REG.items()}
BARK, LEAF = 0, 1


def FR(name):
    return Region(*FF.FREG[name], S=FF.S, pad=3)


class TMB(MB):
    """MB + per-vertex custom normal (VN) and linear colour (VC) for foliage."""
    def __init__(self, name='mesh'):
        super().__init__(name); self.VN = {}; self.VC = {}; self.leaf_faces = []

    def merge(self, other, M=None):
        off = len(self.V); foff = len(self.F)
        super().merge(other, M)
        if isinstance(other, TMB):
            R = M[:3, :3] if M is not None else np.eye(3)
            for k, v in other.VN.items():
                self.VN[k + off] = R @ v
            for k, v in other.VC.items():
                self.VC[k + off] = v
            self.leaf_faces += [f + foff for f in other.leaf_faces]
        return self


def curve(p0, d, L, nseg, r, droop=0.0, wobble=0.08, up_bias=0.0):
    pts = [np.array(p0, float)]; d = np.array(d, float); d /= np.linalg.norm(d)
    for i in range(nseg):
        d = d + r.normal(0, wobble, 3) + np.array([0, -droop + up_bias, 0]) * (1.0 / nseg)
        d /= np.linalg.norm(d)
        pts.append(pts[-1] + d * L / nseg)
    return np.array(pts)


def zigzag(p0, d, L, nseg, r, amp=0.35, droop=0.0, wobble=0.05):
    """Sympodial (black locust) growth: direction kinks alternately at every node."""
    pts = [np.array(p0, float)]; d = np.array(d, float); d /= np.linalg.norm(d)
    side = np.cross(d, [0, 1, 0]); side = side / (np.linalg.norm(side) + 1e-9) if np.linalg.norm(side) > 1e-6 else np.array([1.0, 0, 0])
    for i in range(nseg):
        k = d + side * amp * (1 if i % 2 else -1) * r.uniform(0.5, 1.2) + r.normal(0, wobble, 3) - np.array([0, droop, 0]) / nseg
        k /= np.linalg.norm(k)
        pts.append(pts[-1] + k * L / nseg)
        d = d * 0.7 + k * 0.3; d /= np.linalg.norm(d)
    return np.array(pts)


def rot_towards(d, ang, az):
    d = d / np.linalg.norm(d)
    a = np.cross(d, [0, 1, 0] if abs(d[1]) < 0.95 else [1, 0, 0]); a /= np.linalg.norm(a); b = np.cross(d, a)
    perp = a * math.cos(az) + b * math.sin(az)
    return d * math.cos(ang) + perp * math.sin(ang)


def bark_tube(mb, pts, rad, sides, reg, circ=1.0):
    """Tube with the bark region wrapping once around and repeating every ~1.4 m along."""
    G.tube(mb, pts, np.asarray(rad, float), sides, reg, seg=circ * 1.4, around=1.0, smooth=True)


def splinter(mb, p, d, r, rnd, n=5):
    """Jagged broken limb end (pale splintered wood + end disc)."""
    reg = G.R['wood_raw']
    d = np.asarray(d, float); d /= np.linalg.norm(d)
    a = np.cross(d, [0, 1, 0] if abs(d[1]) < 0.9 else [1, 0, 0]); a /= np.linalg.norm(a); b = np.cross(d, a)
    ring = [p + (a * math.cos(t) + b * math.sin(t)) * r for t in np.linspace(0, 2 * np.pi, n, endpoint=False)]
    uvf = lambda P, nn: [reg.uv(0.3 + 0.4 * (i % 2), 0.2 + 0.6 * (i // 2 % 2)) for i in range(len(P))]
    for i in range(n):
        q0, q1 = ring[i], ring[(i + 1) % n]
        tip = (q0 + q1) / 2 * 0.7 + p * 0.3 + d * r * rnd.uniform(0.4, 1.8) + rnd.normal(0, r * 0.3, 3)
        mb.poly([q0, q1, tip], uvf); mb.poly([q1, q0, tip], uvf)
    mb.poly(ring[::-1], uvf)


def card(mb, c, nrm, up, w, h, reg, base=0.35):
    """Alpha card centred near c: normal nrm, texture 'up' along up; base = fraction of the card below c."""
    nrm = np.asarray(nrm, float); nrm /= np.linalg.norm(nrm)
    up = np.asarray(up, float); up = up - nrm * np.dot(up, nrm)
    if np.linalg.norm(up) < 1e-3:
        up = np.cross(nrm, [1, 0, 0])
    up /= np.linalg.norm(up); a = np.cross(up, nrm)
    P = [c - a * w / 2 - up * h * base, c + a * w / 2 - up * h * base, c + a * w / 2 + up * h * (1 - base), c - a * w / 2 + up * h * (1 - base)]
    uv = [reg.uv(0, 0), reg.uv(1, 0), reg.uv(1, 1), reg.uv(0, 1)]
    if np.dot(newell(np.array(P)), nrm) < 0:
        P = P[::-1]; uv = uv[::-1]
    ids = mb.vs(P)
    mb.face(ids, uv, True, LEAF)
    if isinstance(mb, TMB):
        mb.leaf_faces.append(len(mb.F) - 1)
    return ids


def shade_foliage(mb, centre, axes, ao=(0.42, 1.0), bend=0.7, floor_y=None, top_light=0.18):
    """Bent normals (face normal -> outward from the crown ellipsoid) + AO colour for every leaf vertex."""
    c = np.asarray(centre, float); ax = np.asarray(axes, float)
    V = np.array(mb.V)
    lo_y = floor_y if floor_y is not None else c[1] - ax[1]
    for fi in mb.leaf_faces:
        idx = mb.F[fi][0]
        P = V[list(idx)]
        fn = newell(P)
        for vi, p in zip(idx, P):
            q = (p - c) / ax
            rr = float(np.linalg.norm(q))
            out = q / ax; out = out / (np.linalg.norm(out) + 1e-9)
            f2 = fn if np.dot(fn, out) >= 0 else -fn
            n = out * bend + f2 * (1 - bend) + np.array([0, 0.25, 0])
            mb.VN[vi] = n / np.linalg.norm(n)
            h = np.clip((p[1] - lo_y) / max(1e-3, (c[1] + ax[1] - lo_y)), 0, 1)
            k = ao[0] + (ao[1] - ao[0]) * np.clip(rr, 0, 1.15) ** 1.6
            k *= (1 - top_light) + top_light * h * 1.2
            mb.VC[vi] = np.array([k, k, k * 0.96])


# ====================================================================== trees
# per level l (0 = trunk): kids on a level-l branch, start fraction, branching angle, length ratio, radius ratio,
# droop of level l, wobble, segments, sides
SPEC = {
    'acacia': dict(H=10.5, r0=0.21, trunk=0.36, lean=0.13, fork=(2, 3), fork_ang=(14, 28), fork_len=0.68, fork_r=0.74,
                   kids=[2, 6, 4, 3], start=[0.55, 0.3, 0.2, 0.2], ang=[34, 46, 50, 45], lr=[0.5, 0.36, 0.5, 0.6],
                   rr=[0.6, 0.5, 0.55, 0.6], droop=[0, 0.1, 0.35, 0.5], wob=[0.035, 0.07, 0.12, 0.15],
                   segs=[6, 7, 4, 2], sides=[8, 6, 4, 3], zig=0.28, maxlevel=3,
                   leaf='acacia', spray='spray_acacia', card=(0.95, 1.35), per_twig=3, per_branch=2, up_bias=0.45),
    'oak':    dict(H=12.0, r0=0.42, trunk=0.26, lean=0.04, fork=(4, 5), fork_ang=(28, 52), fork_len=0.5, fork_r=0.6,
                   kids=[1, 5, 4, 3], start=[0.5, 0.3, 0.2, 0.2], ang=[40, 46, 50, 45], lr=[0.5, 0.45, 0.5, 0.55],
                   rr=[0.6, 0.48, 0.55, 0.6], droop=[0, 0.25, 0.35, 0.4], wob=[0.02, 0.08, 0.12, 0.14],
                   segs=[5, 7, 4, 2], sides=[10, 7, 4, 3], zig=0.12, maxlevel=3,
                   leaf='oak', spray='spray_oak', card=(1.1, 1.55), per_twig=3, per_branch=3, up_bias=0.35),
    'walnut': dict(H=9.0, r0=0.27, trunk=0.25, lean=0.04, fork=(4, 5), fork_ang=(36, 54), fork_len=0.66, fork_r=0.66,
                   kids=[0, 5, 4, 3], start=[0.5, 0.3, 0.2, 0.2], ang=[40, 48, 50, 45], lr=[0.5, 0.45, 0.5, 0.55],
                   rr=[0.6, 0.5, 0.55, 0.6], droop=[0, 0.2, 0.35, 0.45], wob=[0.02, 0.06, 0.1, 0.12],
                   segs=[5, 6, 4, 2], sides=[9, 6, 4, 3], zig=0.05, maxlevel=3,
                   leaf='walnut', spray='spray_walnut', card=(1.2, 1.7), per_twig=3, per_branch=2, up_bias=0.4),
}


class Tree:
    def __init__(self, name, species, seed, shelled=False):
        self.sp = SPEC[species]; self.species = species; self.r = rng(seed); self.mb = TMB(name)
        self.bark = 'bark_' + species; self.twigs = []; self.branch_tips = []; self.shelled = shelled

    def grow(self, p, d, L, r0, level, snap=None):
        sp, r, mb = self.sp, self.r, self.mb
        segs, sides = sp['segs'][level], sp['sides'][level]
        if sp['zig'] and level >= 1:
            pts = zigzag(p, d, L, segs, r, amp=sp['zig'], droop=sp['droop'][level], wobble=sp['wob'][level])
        else:
            pts = curve(p, d, L, segs, r, droop=sp['droop'][level], wobble=sp['wob'][level])
        n = len(pts)
        rad = r0 * np.linspace(1.0, 0.28 if level else 0.62, n)
        fate = 'ok'
        if self.shelled and level >= 1:
            q = r.random()
            fate = ('snapped' if q < 0.18 else 'hanging' if q < 0.26 else 'bare' if q < 0.42 else 'ok') if level == 1 else \
                   ('snapped' if q < 0.15 else 'gone' if q < 0.25 else 'bare' if q < 0.38 else 'ok') if level == 2 else \
                   ('gone' if q < 0.3 else 'ok')
        if snap:
            fate = 'snapped'
        if fate == 'gone':
            return
        if fate == 'snapped':
            cut = max(2, int(n * (snap or r.uniform(0.3, 0.7))))
            bark_tube(mb, pts[:cut], rad[:cut], sides, self.bark)
            splinter(mb, pts[cut - 1], pts[cut - 1] - pts[cut - 2], rad[cut - 1], r, 5 if level < 2 else 3)
            return
        if fate == 'hanging':
            h = max(2, n // 2)
            bark_tube(mb, pts[:h + 1], rad[:h + 1], sides, self.bark)
            hang = curve(pts[h], np.array([r.normal(0, 0.3), -1.0, r.normal(0, 0.3)]), L * 0.55, 3, r, wobble=0.15)
            bark_tube(mb, hang, np.linspace(rad[h] * 0.8, rad[-1], len(hang)), sides, self.bark)
            splinter(mb, pts[h], pts[h] - pts[h - 1], rad[h], r, 3)
            for k in range(2):   # dead twigs on the hanging limb
                tw = curve(hang[-2], hang[-1] - hang[-2] + r.normal(0, 0.6, 3), L * 0.2, 2, r, wobble=0.2)
                bark_tube(mb, tw, np.linspace(rad[-1] * 0.7, 0.006, len(tw)), 3, self.bark)
            return
        bark_tube(mb, pts, rad, sides, self.bark)
        dead = fate == 'bare'
        if level >= sp['maxlevel']:
            if not dead:
                self.twigs.append(pts)
            return
        k = sp['kids'][level]
        if self.shelled and level >= 1:
            k = max(1, int(round(k * 0.8)))
        base_az = r.uniform(0, 2 * np.pi)
        for j in range(k):
            t = sp['start'][level] + (1 - sp['start'][level]) * (j + r.uniform(0.15, 0.85)) / k
            i = min(n - 2, int(t * (n - 1))); f = t * (n - 1) - i
            q0 = pts[i] * (1 - f) + pts[i + 1] * f
            rq = rad[i] * (1 - f) + rad[i + 1] * f
            ang = math.radians(sp['ang'][level] + r.normal(0, 8))
            cd = rot_towards(pts[i + 1] - pts[i], ang, base_az + j * 2.39996)
            cd[1] += sp['up_bias'] * 0.25 * (level <= 1)
            Lc = L * sp['lr'][level] * (1.25 - 0.55 * t) * r.uniform(0.8, 1.15)
            if dead:
                # bare limb: twigs stay, no leaves (shelled tree)
                pts2 = curve(q0, cd, Lc * 0.7, 2, r, wobble=0.15)
                bark_tube(mb, pts2, np.linspace(max(0.006, rq * sp['rr'][level]), 0.006, len(pts2)), 3, self.bark)
                continue
            self.grow(q0, cd, Lc, max(0.007, rq * sp['rr'][level]), level + 1)
        if level == sp['maxlevel'] - 1 and not dead:
            self.branch_tips.append(pts)

    def build(self):
        sp, r, mb = self.sp, self.r, self.mb
        H = sp['H']
        leanv = np.array([r.normal(0, sp['lean']), 1.0, r.normal(0, sp['lean'])])
        tl = H * sp['trunk']
        trunk = curve((0, -0.15, 0), leanv, tl + 0.3, sp['segs'][0], r, wobble=sp['wob'][0])
        trad = sp['r0'] * np.linspace(1.0, 0.72, len(trunk)); trad[0] *= 1.35; trad[1] *= 1.08
        bark_tube(mb, trunk, trad, sp['sides'][0], self.bark)
        self.trunk, self.trad = trunk, trad
        # root flare: a few buttress bumps at the base
        for k in range(4 if self.species != 'acacia' else 3):
            az = k * 2 * np.pi / 4 + r.normal(0, 0.3); dd = np.array([math.cos(az), -0.35, math.sin(az)])
            rp = curve(trunk[1] * 0.6, dd, sp['r0'] * 2.4, 2, r, wobble=0.05)
            bark_tube(mb, rp, np.linspace(sp['r0'] * 0.55, sp['r0'] * 0.15, len(rp)), 5, self.bark)
        # side limbs along the upper trunk
        top, td = trunk[-1], trunk[-1] - trunk[-2]
        for j in range(sp['kids'][0]):
            t = sp['start'][0] + (1 - sp['start'][0]) * (j + 0.5) / max(1, sp['kids'][0])
            i = min(len(trunk) - 2, int(t * (len(trunk) - 1)))
            cd = rot_towards(trunk[i + 1] - trunk[i], math.radians(sp['ang'][0] + r.normal(0, 8)), r.uniform(0, 2 * np.pi))
            self.grow(trunk[i], cd, H * sp['fork_len'] * 0.6 * r.uniform(0.8, 1.1), trad[i] * sp['rr'][0], 1)
        # fork into leaders
        nl = r.integers(sp['fork'][0], sp['fork'][1] + 1)
        az0 = r.uniform(0, 2 * np.pi)
        for j in range(nl):
            ang = math.radians(r.uniform(*sp['fork_ang']))
            cd = rot_towards(td, ang, az0 + j * 2 * np.pi / nl + r.normal(0, 0.35))
            L = H * sp['fork_len'] * r.uniform(0.78, 1.08)
            if self.species == 'acacia' and j == nl - 1:
                L *= 0.72   # lopsided, irregular crown
            snap = r.uniform(0.3, 0.5) if (self.shelled and j == 0) else None
            self.grow(top - td * 0.2, cd, L, trad[-1] * sp['fork_r'], 1, snap=snap)
        if self.shelled:
            self.scars()
        self.foliage()
        return self.mb

    def scars(self):
        """Shrapnel scars on the trunk: pale torn bark patches."""
        r, mb = self.r, self.mb
        reg = G.R['wood_raw']
        for k in range(3):
            i = r.integers(1, len(self.trunk) - 1)
            p = self.trunk[i]; rr = self.trad[i] * 1.04; az = r.uniform(0, 2 * np.pi)
            nrm = np.array([math.cos(az), 0, math.sin(az)]); tang = np.array([-math.sin(az), 0, math.cos(az)])
            w, h = rr * r.uniform(0.6, 1.0), r.uniform(0.25, 0.8)
            mb.poly([p + nrm * rr - tang * w / 2, p + nrm * rr + tang * w / 2, p + nrm * rr * 0.98 + tang * w * 0.35 + [0, h, 0], p + nrm * rr * 0.98 - tang * w * 0.4 + [0, h * 0.8, 0]],
                    lambda P, n: [reg.uv(0.1, 0.1), reg.uv(0.6, 0.1), reg.uv(0.6, 0.9), reg.uv(0.1, 0.9)])

    def foliage(self):
        sp, r, mb = self.sp, self.r, self.mb
        leaf = 'acacia_dry' if self.shelled else sp['leaf']
        A = [p for tw in self.twigs for p in tw[1:]] + [p for b in self.branch_tips for p in b[-2:]]
        A = np.asarray(A)
        c = (A.min(0) + A.max(0)) / 2; ax = np.maximum((A.max(0) - A.min(0)) / 2, 0.8)
        self.crown = (c, ax)
        cs = sp['card']
        def put(p, along, scale=1.0, spray=False):
            # crossed pair of cluster cards (like build_trees.py), 'up' leaning along the twig and outward
            out = (p - c) / ax; out[1] *= 0.6; lo = np.linalg.norm(out)
            out = out / lo if lo > 1e-3 else np.array([0, 1.0, 0])
            s = r.uniform(*cs) * scale
            up = np.array([0, 1.0, 0]) * 0.7 + along * 0.6 + out * 0.4 + r.normal(0, 0.25, 3)
            up /= np.linalg.norm(up)
            yaw = r.uniform(0, np.pi)
            a0 = np.cross(up, [math.cos(yaw), 0.0, math.sin(yaw)]); a0 /= np.linalg.norm(a0) + 1e-9
            for k2, nrm in enumerate((a0, np.cross(up, a0))):
                if spray and k2 == 1:
                    reg = FR(sp['spray']) if not self.shelled else FR('acacia_dry')
                    card(mb, p + out * s * 0.1, out * 0.6 + up * 0.8 + r.normal(0, 0.3, 3), along + r.normal(0, 0.3, 3), s * 1.5, s * 0.75, reg, base=0.5)
                    continue
                lf = leaf if not (self.shelled and r.random() < 0.3) else sp['leaf']
                card(mb, p + out * s * 0.1, nrm, up, s, s, FR(lf), base=0.32)
        per = sp['per_twig'] if not self.shelled else 2
        for tw in self.twigs:
            d = tw[-1] - tw[0]; d /= np.linalg.norm(d) + 1e-9
            for k in range(per):
                if self.shelled and r.random() < 0.35:
                    continue
                t = 0.45 + 0.75 * (k + r.uniform(0, 1)) / per
                i = min(len(tw) - 2, int(t * (len(tw) - 1)))
                f = min(1.4, t * (len(tw) - 1) - i)
                p = tw[i] + (tw[i + 1] - tw[i]) * f + r.normal(0, 0.12, 3)
                put(p, d, spray=(k % 3 == 2 and r.random() < 0.5))
        for b in self.branch_tips:
            d = b[-1] - b[-2]; d /= np.linalg.norm(d) + 1e-9
            for k in range(sp['per_branch'] if not self.shelled else 1):
                put(b[-1] + d * 0.3 + r.normal(0, 0.3, 3), d, 1.1, spray=True)
        floor_y = c[1] - ax[1]
        shade_foliage(mb, c, ax, ao=(0.4, 1.0) if not self.shelled else (0.55, 1.0), floor_y=floor_y, bend=0.45)


def poplar(name, seed, H=20.0):
    """Lombardy poplar: straight trunk to the top, ~44 short ascending limbs (spindle profile) with twigs."""
    r = rng(seed); mb = TMB(name)
    leanv = np.array([r.normal(0, 0.015), 1.0, r.normal(0, 0.015)])
    trunk = curve((0, -0.15, 0), leanv, H * 0.96, 12, r, wobble=0.01)
    trad = 0.34 * np.linspace(1.0, 0.08, len(trunk)); trad[0] *= 1.35
    bark_tube(mb, trunk, trad, 8, 'bark_poplar')
    for k in range(4):   # buttresses
        az = k * np.pi / 2 + r.normal(0, 0.3)
        rp = curve(trunk[1] * 0.6, np.array([math.cos(az), -0.4, math.sin(az)]), 0.8, 2, r, wobble=0.05)
        bark_tube(mb, rp, np.linspace(0.18, 0.05, len(rp)), 5, 'bark_poplar')
    twigs = []; limbs = []
    nb = 46
    def prof(t):   # crown radius profile (m) at relative height t
        return 0.35 + 1.85 * math.sin(math.pi * min(1.0, max(0.0, (t - 0.06) / 0.98))) ** 0.75 * (1 - 0.25 * t)
    for j in range(nb):
        t = 0.1 + 0.86 * (j + r.uniform(0.2, 0.8)) / nb
        i = min(len(trunk) - 2, int(t * (len(trunk) - 1))); f = t * (len(trunk) - 1) - i
        q0 = trunk[i] * (1 - f) + trunk[i + 1] * f; rq = trad[i] * (1 - f) + trad[i + 1] * f
        cd = rot_towards(trunk[i + 1] - trunk[i], math.radians(r.uniform(18, 30)), j * 2.39996 + r.normal(0, 0.2))
        L = prof(t) / math.sin(math.radians(24)) * 0.62 * r.uniform(0.8, 1.15)
        pts = curve(q0, cd, L, 3, r, wobble=0.05, up_bias=0.12)
        bark_tube(mb, pts, np.linspace(max(0.02, rq * 0.42), 0.012, len(pts)), 4 if j % 2 else 3, 'bark_poplar')
        limbs.append(pts)
        for m_ in range(3):
            s = r.uniform(0.3, 0.9); ii = min(len(pts) - 2, int(s * (len(pts) - 1)))
            tw = curve(pts[ii], rot_towards(pts[ii + 1] - pts[ii], math.radians(r.uniform(20, 40)), r.uniform(0, 6.28)), L * 0.35, 1, r, wobble=0.1, up_bias=0.2)
            bark_tube(mb, tw, np.array([0.012, 0.005]), 3, 'bark_poplar')
            twigs.append(tw)
    A = np.asarray([p for l in limbs for p in l[1:]] + [p for t in twigs for p in t])
    c = np.array([0, H * 0.53, 0]); ax = np.array([2.1, H * 0.47, 2.1])
    # cards: hug the stem, radius follows the spindle profile; tall-narrow orientation
    reg_c, reg_s = FR('poplar'), FR('spray_poplar')
    for k in range(800):
        p = A[r.integers(len(A))].copy()
        t = np.clip(p[1] / H, 0, 1)
        a = r.uniform(0, 2 * np.pi); rr = prof(t) * math.sqrt(r.uniform(0.2, 1.0))
        p = np.array([math.cos(a) * rr + trunk[int(t * 12)][0], p[1] + r.normal(0, 0.4), math.sin(a) * rr + trunk[int(t * 12)][2]])
        if p[1] < H * 0.09 or p[1] > H * 1.01:
            continue
        out = np.array([math.cos(a), 0.2, math.sin(a)])
        nrm = out + np.array([0, 0.4, 0]) + r.normal(0, 0.45, 3)
        s = r.uniform(0.95, 1.3) * (0.75 if t > 0.9 else 1.0)
        if k % 4 == 3:
            card(mb, p, nrm, np.cross(nrm, [0, 1.0, 0]) + r.normal(0, 0.2, 3), s * 1.4, s * 0.7, reg_s, base=0.5)
        else:
            card(mb, p, nrm, np.array([0, 1.0, 0]) + r.normal(0, 0.15, 3), s * 0.8, s, reg_c, base=0.4)
    shade_foliage(mb, c, ax, ao=(0.42, 1.0), floor_y=H * 0.08)
    t = Tree.__new__(Tree); t.mb = mb; t.crown = (c, ax); t.trunk = trunk; t.trad = trad; t.species = 'poplar'; t.prof = prof
    return t


def bush(name, kind, seed):
    """Understory shrubs: elder (bush_a) -- 7 upright-arching stems, 3 m, berry umbels;
    dog rose (bush_b) -- 12 arching canes, 2.2 m, red hips."""
    r = rng(seed); mb = TMB(name)
    if kind == 'elder':
        nst, Hh, spread, bark, leaf, csz, per, droop, r0 = 7, 1.9, 0.36, 'bark_walnut', 'elder', (0.95, 1.35), 7, 0.4, 0.045
    else:
        nst, Hh, spread, bark, leaf, csz, per, droop, r0 = 12, 1.75, 0.45, 'bark_acacia', 'rose', (0.8, 1.15), 5, 1.0, 0.025
    tips = []
    for k in range(nst):
        az = k * 2.39996 + r.normal(0, 0.3)
        d = np.array([math.cos(az) * spread * r.uniform(0.5, 1.2), 1.0, math.sin(az) * spread * r.uniform(0.5, 1.2)])
        L = Hh * r.uniform(0.8, 1.2)
        pts = curve((r.normal(0, 0.12), -0.05, r.normal(0, 0.12)), d, L, 4, r, droop=droop, wobble=0.1)
        bark_tube(mb, pts, np.linspace(r0, 0.01, len(pts)), 4 if kind == 'elder' else 3, bark)
        tips.append(pts)
        for j in range(3):
            i = r.integers(1, len(pts) - 1)
            tw = curve(pts[i], rot_towards(pts[i + 1] - pts[i], math.radians(r.uniform(35, 60)), r.uniform(0, 6.28)), L * 0.35, 2, r, droop=droop * 0.5, wobble=0.12)
            bark_tube(mb, tw, np.array([0.012, 0.008, 0.004]), 3, bark)
            tips.append(tw)
    A = np.asarray([p for t in tips for p in t[1:]])
    c = (A.min(0) + A.max(0)) / 2; ax = np.maximum((A.max(0) - A.min(0)) / 2, 0.6)
    for tw in tips:
        dv = tw[-1] - tw[0]; dv /= np.linalg.norm(dv) + 1e-9
        for k in range(per if len(tw) > 3 else 3):
            t = 0.25 + 0.85 * (k + r.uniform(0, 1)) / per
            i = min(len(tw) - 2, int(t * (len(tw) - 1))); f = min(1.3, t * (len(tw) - 1) - i)
            p = tw[i] + (tw[i + 1] - tw[i]) * f + r.normal(0, 0.12, 3)
            out = (p - c) / ax; lo = np.linalg.norm(out); out = out / lo if lo > 1e-3 else np.array([0, 1.0, 0])
            s = r.uniform(*csz)
            card(mb, p + out * s * 0.1, out * 0.7 + np.array([0, 0.45, 0]) + r.normal(0, 0.45, 3),
                 np.array([0, 1.0, 0]) + dv * 0.4 + r.normal(0, 0.3, 3), s, s, FR(leaf), base=0.35)
    shade_foliage(mb, c, ax, ao=(0.45, 1.0), floor_y=0.0)
    t = Tree.__new__(Tree); t.mb = mb; t.crown = (c, ax); t.trunk = None; t.species = kind
    return t


# ====================================================================== far LOD
def kmeans(P, k, r, it=12):
    C = P[r.choice(len(P), size=min(k, len(P)), replace=False)].copy()
    for _ in range(it):
        d = ((P[:, None, :] - C[None]) ** 2).sum(-1); lab = d.argmin(1)
        for j in range(len(C)):
            m = lab == j
            if m.any():
                C[j] = P[m].mean(0)
    d = ((P[:, None, :] - C[None]) ** 2).sum(-1); lab = d.argmin(1)
    return C, lab


def lod1(name, t, far_cell, nclumps=20, leaders=None, seed=0):
    """Far model: trunk prism (+ leader stubs) and crown clumps of 3 cards (2 crossed upright + 1 tilted-up),
    sized to cover the near crown, sharing its centre/AO so it reads as the same tree at 200 m."""
    r = rng(seed); mb = TMB(name)
    near = t.mb
    V = np.array(near.V)
    leafv = np.array([V[i] for fi in near.leaf_faces for i in near.F[fi][0]])
    c, ax = t.crown
    C, lab = kmeans(leafv, nclumps, r)
    if t.trunk is not None:
        tr = t.trunk; n = len(tr)
        idx = [0, n // 2, n - 1] if t.species != 'poplar' else [0, n // 3, 2 * n // 3, n - 1]
        bark_tube(mb, tr[idx], t.trad[idx] * 1.05, 5, 'bark_' + ('acacia' if 'acacia' in t.species else t.species if t.species in ('oak', 'walnut', 'poplar') else 'acacia'))
        if leaders:
            for L in leaders:
                bark_tube(mb, L, np.linspace(t.trad[-1] * 0.7, t.trad[-1] * 0.25, len(L)), 4, 'bark_' + t.species if t.species in ('oak', 'walnut') else 'bark_acacia')
    reg = FR(far_cell)
    for j in range(len(C)):
        m = lab == j
        if not m.any():
            continue
        P = leafv[m]
        ext = np.percentile(np.abs(P - C[j]), 80, axis=0) * 2 + 0.5
        sx = max(ext[0], ext[2]); sy = ext[1]
        out = (C[j] - c) / ax; out = out / (np.linalg.norm(out) + 1e-9)
        yaw = r.uniform(0, np.pi)
        for k in range(3):
            a = yaw + k * np.pi / 3
            tilt = r.uniform(0.15, 0.75)          # no flat 'umbrella' discs from the RTS camera
            nrm = np.array([math.cos(a), 0, math.sin(a)]) * math.cos(tilt) + np.array([0, math.sin(tilt), 0]) + out * 0.3
            card(mb, C[j] + r.normal(0, 0.15, 3), nrm, np.array([0, 1.0, 0]) + r.normal(0, 0.4, 3), sx * 1.0, (sx + sy) * 0.55, reg, base=0.5)
    shade_foliage(mb, c, ax, ao=(0.48, 0.95), bend=0.7, floor_y=c[1] - ax[1])
    return mb


# ====================================================================== crops (all foliage material)
def ribbon_stalk(mb, base, top_dir, L, w, reg, r, segs=2, droop=0.0, crossed=True, yaw=None):
    """Bent vertical alpha strip(s) along a stalk curve; crossed = two strips at 90 deg."""
    pts = curve(base, top_dir, L, segs, r, droop=droop, wobble=0.03)
    yaw = r.uniform(0, np.pi) if yaw is None else yaw
    for c in ((0, np.pi / 2) if crossed else (0,)):
        a = np.array([math.cos(yaw + c), 0, math.sin(yaw + c)])
        for i in range(segs):
            p0, p1 = pts[i], pts[i + 1]
            t0, t1 = i / segs, (i + 1) / segs
            P = [p0 - a * w / 2, p0 + a * w / 2, p1 + a * w / 2, p1 - a * w / 2]
            uv = [reg.uv(0, t0), reg.uv(1, t0), reg.uv(1, t1), reg.uv(0, t1)]
            mb.face(mb.vs(P), uv, False, LEAF)
    return pts


def sunflower_clump(name='sunflower_dead_clump', seed=501):
    """6 dead sunflowers (stalks ~1.6 m) with heavy heads hanging face-down, shrivelled black leaves."""
    r = rng(seed); mb = MB(name)
    n = 6
    for k in range(n):
        a = k * 2.39996; rr = 0.18 + 0.32 * math.sqrt(k / n)
        base = np.array([math.cos(a) * rr + r.normal(0, 0.05), -0.02, math.sin(a) * rr + r.normal(0, 0.05)])
        L = r.uniform(1.45, 1.8)
        d = np.array([r.normal(0, 0.08), 1, r.normal(0, 0.08)])
        pts = ribbon_stalk(mb, base, d, L, 0.28, FR('sf_stalk' if k % 2 else 'sf_stalk2'), r, segs=2, droop=0.1)
        top = pts[-1]
        hdir = np.array([math.cos(a + r.normal(0, 0.6)), 0, math.sin(a + r.normal(0, 0.6))])
        face_n = hdir * 0.55 + np.array([0, -0.85, 0]); face_n /= np.linalg.norm(face_n)
        R = r.uniform(0.12, 0.17)
        c = top + hdir * 0.1 + np.array([0, -0.08, 0])
        u = np.cross(face_n, [0, 1, 0]); u /= np.linalg.norm(u); v = np.cross(face_n, u)
        ring = [c + (u * math.cos(t) + v * math.sin(t)) * R for t in np.linspace(0, 2 * np.pi, 6, endpoint=False)]
        hf, hb = FR('sf_head'), FR('sf_back')
        uvr = [(0.5 + 0.5 * math.cos(t), 0.5 + 0.5 * math.sin(t)) for t in np.linspace(0, 2 * np.pi, 6, endpoint=False)]
        P = np.array(ring); ids = mb.vs(P)
        if np.dot(newell(P), face_n) < 0:
            ids = ids[::-1]; uvq = uvr[::-1]
        else:
            uvq = uvr
        mb.face(ids, [hf.uv(*q) for q in uvq], False, LEAF)
        apex = c - face_n * R * 0.6
        for i in range(6):
            q0, q1 = ring[i], ring[(i + 1) % 6]
            tri = [q1, q0, apex]
            uvt = [hb.uv(*uvr[(i + 1) % 6]), hb.uv(*uvr[i]), hb.uv(0.5, 0.5)]
            if np.dot(newell(np.array(tri)), (q0 + q1) / 2 - c) < 0:
                tri = tri[::-1]; uvt = uvt[::-1]
            mb.face(mb.vs(tri), uvt, False, LEAF)
        nk = np.array([top, (top + apex) / 2 + [0, 0.04, 0], apex])
        an = np.cross(nk[2] - nk[0], [0, 1, 0]); an = an / (np.linalg.norm(an) + 1e-6) * 0.03
        st = FR('sf_stalk')
        mb.face(mb.vs([nk[0] - an, nk[0] + an, nk[2] + an, nk[2] - an]), [st.uv(0.4, 0.9), st.uv(0.6, 0.9), st.uv(0.6, 1), st.uv(0.4, 1)], False, LEAF)
        if k % 2 == 0:
            p = pts[1] + r.normal(0, 0.02, 3)
            az = r.uniform(0, 2 * np.pi); out = np.array([math.cos(az), 0, math.sin(az)])
            card(mb, p + out * 0.12, out + r.normal(0, 0.3, 3), np.array([0, 1.0, 0]), 0.26, 0.34, FR('sf_leaf' if k % 4 else 'sf_leaf2'), base=0.9)
    for k in range(2):
        yaw = k * np.pi / 2 + 0.3
        a = np.array([math.cos(yaw), 0, math.sin(yaw)])
        reg = FR('grass_tuft')
        P = [np.array([0, -0.02, 0]) - a * 0.6, np.array([0, -0.02, 0]) + a * 0.6, a * 0.6 + [0, 0.32, 0], -a * 0.6 + [0, 0.32, 0]]
        mb.face(mb.vs(P), [reg.uv(0, 0), reg.uv(1, 0), reg.uv(1, 1), reg.uv(0, 1)], False, LEAF)
    return mb


def corn_clump(name='corn_dry_clump', seed=502):
    """7 dry maize stalks ~2 m in a short row segment, drooping bleached leaves, hanging ears, litter."""
    r = rng(seed); mb = MB(name)
    for k in range(7):
        base = np.array([r.uniform(-0.45, 0.45), -0.02, r.normal(0, 0.12)])
        L = r.uniform(1.8, 2.2)
        lean = np.array([r.normal(0, 0.1), 1, r.normal(0, 0.1)])
        pts = ribbon_stalk(mb, base, lean, L, 0.78, FR('corn_a' if k % 2 else 'corn_b'), r, segs=3, droop=0.05)
        if k % 2 == 0:
            p = pts[1] + [0, 0.15, 0]
            az = r.uniform(0, 2 * np.pi); out = np.array([math.cos(az), 0, math.sin(az)])
            card(mb, p + out * 0.08, out, np.array([0, 1, 0]) - out * 0.6, 0.12, 0.3, FR('corn_ear'), base=0.95)
    for k in range(2):
        yaw = r.uniform(0, np.pi); a = np.array([math.cos(yaw), 0, math.sin(yaw)]); b = np.array([-a[2], 0, a[0]])
        c = np.array([r.uniform(-0.4, 0.4), 0.03, r.uniform(-0.3, 0.3)])
        reg = FR('corn_leaf')
        P = [c - a * 0.4 - b * 0.15, c + a * 0.4 - b * 0.15, c + a * 0.4 + b * 0.15, c - a * 0.4 + b * 0.15]
        mb.face(mb.vs(P), [reg.uv(0, 0), reg.uv(1, 0), reg.uv(1, 1), reg.uv(0, 1)], False, LEAF)
    return mb


def weeds_clump(name='weeds_tall_clump', seed=503):
    """Overgrown fallow: ragweed / wormwood / thistle, ~1 m, dry olive-tan."""
    r = rng(seed); mb = MB(name)
    for k in range(5):
        yaw = k * np.pi / 5 + r.normal(0, 0.1)
        base = np.array([r.normal(0, 0.12), -0.03, r.normal(0, 0.12)])
        ribbon_stalk(mb, base, np.array([r.normal(0, 0.12), 1, r.normal(0, 0.12)]), r.uniform(0.95, 1.2), 1.15, FR('weeds'), r, segs=2,
                     droop=0.05, crossed=False, yaw=yaw)
    for k, nm in enumerate(('thistle', 'thistle', 'ragweed', 'ragweed')):
        base = np.array([r.uniform(-0.45, 0.45), -0.03, r.uniform(-0.45, 0.45)])
        ribbon_stalk(mb, base, np.array([r.normal(0, 0.1), 1, r.normal(0, 0.1)]), r.uniform(0.9, 1.3), 0.5, FR(nm), r, segs=2, crossed=True)
    return mb


# ====================================================================== all vegetation nodes
def vegetation():
    """Returns list of (mb) for near models, their _lod1 siblings, and crops."""
    out = []
    specs = [('tree_acacia_leafy', 'acacia', 211, False, 'far_acacia', 24),
             ('tree_oak_leafy', 'oak', 233, False, 'far_oak', 34),
             ('tree_walnut_leafy', 'walnut', 244, False, 'far_walnut', 28),
             ('tree_acacia_shelled', 'acacia', 259, True, 'far_acacia_dry', 14)]
    for name, sp, seed, sh, far, ncl in specs:
        t = Tree(name, sp, seed, shelled=sh); t.build()
        out.append(t.mb)
        out.append(lod1(name + '_lod1', t, far, ncl, seed=seed))
    t = poplar('tree_poplar_leafy', 222)
    out.append(t.mb); out.append(lod1('tree_poplar_leafy_lod1', t, 'far_poplar', 30, seed=222))
    for name, kind, seed, far in (('bush_a', 'elder', 301, 'far_elder'), ('bush_b', 'rose', 302, 'far_rose')):
        t = bush(name, kind, seed)
        out.append(t.mb); out.append(lod1(name + '_lod1', t, far, 12, seed=seed))
    out += [sunflower_clump(), corn_clump(), weeds_clump()]
    return out
