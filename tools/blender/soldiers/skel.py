"""Skeleton (cmu_mb from MakeHuman) with world-aligned joint frames + FK helpers."""
import numpy as np
from qmath import qmul, qinv, qrot, qnorm
import mhbody as M


class Skel:
    def __init__(self, v_dm, ground):
        J = M.joint_positions(v_dm)
        self.names = M.bone_order()
        self.idx = {n: i for i, n in enumerate(self.names)}
        self.parent = np.array([self.idx[J[n][2]] if J[n][2] else -1 for n in self.names])
        g = np.array([0, ground, 0])
        self.head = np.array([J[n][0] * 0.1 - g for n in self.names])
        self.tail = np.array([J[n][1] * 0.1 - g for n in self.names])
        self.n = len(self.names)
        self.offset = np.array([self.head[i] - (self.head[p] if p >= 0 else 0) for i, p in enumerate(self.parent)])

    def children(self, b):
        i = self.idx[b]
        return [self.names[j] for j in range(self.n) if self.parent[j] == i]

    def fk(self, lq, root_t):
        """lq: (F, nb, 4) local rotations; root_t: (F,3) Hips position. -> gq (F,nb,4), gp (F,nb,3)"""
        F = lq.shape[0]
        gq = np.zeros_like(lq); gp = np.zeros((F, self.n, 3))
        for i in range(self.n):
            p = self.parent[i]
            if p < 0:
                gq[:, i] = lq[:, i]; gp[:, i] = root_t
            else:
                gq[:, i] = qmul(gq[:, p], lq[:, i])
                gp[:, i] = gp[:, p] + qrot(gq[:, p], np.broadcast_to(self.offset[i], (F, 3)))
        return gq, gp

    def local_from_global(self, gq):
        lq = np.zeros_like(gq)
        for i in range(self.n):
            p = self.parent[i]
            lq[:, i] = gq[:, i] if p < 0 else qmul(qinv(gq[:, p]), gq[:, i])
        return qnorm(lq)

    def chain(self, b):
        out = []
        i = self.idx[b]
        while i >= 0:
            out.append(i); i = self.parent[i]
        return out[::-1]


def skin_vertices(skel, verts, joints, weights, gq, gp):
    """CPU linear blend skinning for one frame (gq (nb,4), gp (nb,3))."""
    out = np.zeros_like(verts)
    for k in range(4):
        j = joints[:, k]
        local = verts - skel.head[j]
        out += weights[:, k:k + 1] * (qrot(gq[j], local) + gp[j])
    return out
