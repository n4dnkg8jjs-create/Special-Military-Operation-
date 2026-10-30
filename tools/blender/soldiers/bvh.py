"""CMU BVH loading + retargeting onto the MakeHuman cmu_mb skeleton (world-aligned joint frames)."""
import os, subprocess
import numpy as np
from qmath import qmul, qinv, qrot, qaxis, qbetween, qnorm, qslerp, qfix_continuity

CMU = '/home/claude/cmu'


def ensure(name):
    sub = name.split('_')[0]
    p = f'{CMU}/data/{int(sub):03d}/{name}.bvh'
    if not os.path.exists(p):
        subprocess.run(['git', '-C', CMU, 'checkout', 'HEAD', '--', p[len(CMU) + 1:]], check=True)
    return p


class BVH:
    def __init__(self, name):
        path = ensure(name)
        self.names, self.parent, self.offset, self.channels = [], [], [], []
        self.end = {}
        lines = open(path).read().split('\n')
        stack = []
        i = 0
        cur = None
        while True:
            s = lines[i].strip(); i += 1
            if s.startswith('ROOT') or s.startswith('JOINT'):
                nm = s.split()[1]
                self.names.append(nm); self.parent.append(stack[-1] if stack else -1)
                cur = len(self.names) - 1
                self.offset.append(None); self.channels.append([])
            elif s.startswith('End Site'):
                cur = ('end', stack[-1] if stack else -1)
            elif s.startswith('{'):
                stack.append(cur if not isinstance(cur, tuple) else cur)
            elif s.startswith('}'):
                stack.pop()
                cur = stack[-1] if stack else None
            elif s.startswith('OFFSET'):
                off = np.array([float(x) for x in s.split()[1:4]])
                top = stack[-1]
                if isinstance(top, tuple):
                    self.end[top[1]] = off
                else:
                    self.offset[top] = off
            elif s.startswith('CHANNELS'):
                self.channels[stack[-1]] = s.split()[2:]
            elif s.startswith('MOTION'):
                break
        self.nf = int(lines[i].split()[1]); i += 1
        self.dt = float(lines[i].split()[2]); i += 1
        data = np.array([[float(x) for x in l.split()] for l in lines[i:i + self.nf] if l.strip()])
        self.data = data
        self.idx = {n: k for k, n in enumerate(self.names)}
        self.offset = np.array(self.offset)
        self.parent = np.array(self.parent)
        self._fk()

    def _fk(self):
        F = self.data.shape[0]; n = len(self.names)
        lq = np.zeros((F, n, 4)); lq[..., 3] = 1
        root = np.zeros((F, 3))
        col = 0
        for j in range(n):
            q = np.tile([0, 0, 0, 1.0], (F, 1))
            for ch in self.channels[j]:
                v = self.data[:, col]; col += 1
                if ch.endswith('position'):
                    root[:, 'XYZ'.index(ch[0])] = v
                else:
                    ax = {'X': [1, 0, 0], 'Y': [0, 1, 0], 'Z': [0, 0, 1]}[ch[0]]
                    q = qmul(q, qaxis(ax, np.radians(v)))
            lq[:, j] = q
        gq = np.zeros_like(lq); gp = np.zeros((F, n, 3))
        for j in range(n):
            p = self.parent[j]
            if p < 0:
                gq[:, j] = lq[:, j]; gp[:, j] = root + self.offset[j]
            else:
                gq[:, j] = qmul(gq[:, p], lq[:, j])
                gp[:, j] = gp[:, p] + qrot(gq[:, p], np.broadcast_to(self.offset[j], (F, 3)))
        self.gq, self.gp = gq, gp

    def rest_dir(self, j):
        """direction of the bone driven by joint j in the zero pose (first non-zero descendant offset)."""
        kids = [k for k in range(len(self.names)) if self.parent[k] == j]
        for k in kids:
            if np.linalg.norm(self.offset[k]) > 1e-6:
                return self.offset[k]
        for k in kids:
            d = self.rest_dir(k)
            if d is not None:
                return d
        if j in self.end:
            return self.end[j]
        return None


# MH bone -> BVH joint
MAP = {'LeftHandFinger1': 'LeftHandIndex1', 'RightHandFinger1': 'RightHandIndex1'}
# bones whose rest directions are aligned (limbs); others copy world-space rotation deltas directly
ALIGN = {'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
         'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
         'LeftFingerBase', 'LeftHandFinger1', 'RightFingerBase', 'RightHandFinger1', 'LThumb', 'RThumb'}


def retarget(skel, bvh, f0=0, f1=None, fps=30, scale=None):
    """Return global rotations (F,nb,4) and Hips positions (F,3) for MH skeleton, resampled to fps."""
    f1 = bvh.data.shape[0] if f1 is None else f1
    src_t = np.arange(f0, f1) * bvh.dt
    n_out = int(np.floor((src_t[-1] - src_t[0]) * fps)) + 1
    tt = src_t[0] + np.arange(n_out) / fps
    fi = (tt - src_t[0]) / bvh.dt + f0
    a = np.clip(np.floor(fi).astype(int), f0, f1 - 1); b = np.clip(a + 1, f0, f1 - 1); w = fi - a
    if scale is None:
        # leg length ratio
        L = lambda nm: np.linalg.norm(bvh.offset[bvh.idx[nm]])
        bl = L('LeftLeg') + L('LeftFoot')
        ml = np.linalg.norm(skel.head[skel.idx['LeftLeg']] - skel.head[skel.idx['LeftUpLeg']]) + \
             np.linalg.norm(skel.head[skel.idx['LeftFoot']] - skel.head[skel.idx['LeftLeg']])
        scale = ml / bl
    gq = np.zeros((n_out, skel.n, 4))
    for i, nm in enumerate(skel.names):
        src = MAP.get(nm, nm)
        j = bvh.idx[src]
        q = qslerp(bvh.gq[a, j], bvh.gq[b, j], w)
        if nm in ALIGN:
            d_mh = skel.tail[i] - skel.head[i]
            d_bv = bvh.rest_dir(j)
            A = qbetween(d_mh, d_bv)
            q = qmul(q, A)
        gq[:, i] = q
    hip = bvh.gp[:, bvh.idx['Hips']]
    root = (hip[a] * (1 - w[:, None]) + hip[b] * w[:, None]) * scale
    return qfix_frames(gq), root, scale


def qfix_frames(gq):
    for i in range(gq.shape[1]):
        gq[:, i] = qfix_continuity(gq[:, i])
    return gq
