"""Quaternion / rotation helpers (numpy, quaternions as [x, y, z, w] like glTF)."""
import numpy as np


def qnorm(q):
    q = np.asarray(q, np.float64)
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def qmul(a, b):
    a = np.asarray(a, np.float64); b = np.asarray(b, np.float64)
    ax, ay, az, aw = np.moveaxis(a, -1, 0)
    bx, by, bz, bw = np.moveaxis(b, -1, 0)
    return np.stack([aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw,
                     aw * bw - ax * bx - ay * by - az * bz], -1)


def qinv(q):
    q = np.asarray(q, np.float64).copy()
    q[..., :3] *= -1
    return q


def qrot(q, v):
    q = np.asarray(q, np.float64); v = np.asarray(v, np.float64)
    u = q[..., :3]; w = q[..., 3:4]
    t = 2 * np.cross(u, v)
    return v + w * t + np.cross(u, t)


def qaxis(axis, ang):
    axis = np.asarray(axis, np.float64)
    axis = axis / np.linalg.norm(axis, axis=-1, keepdims=True)
    ang = np.asarray(ang, np.float64)
    s = np.sin(ang / 2)[..., None]
    return np.concatenate([axis * s, np.cos(ang / 2)[..., None]], -1)


def qbetween(a, b):
    """minimal rotation taking direction a onto direction b"""
    a = np.asarray(a, np.float64); b = np.asarray(b, np.float64)
    a = a / np.linalg.norm(a, axis=-1, keepdims=True); b = b / np.linalg.norm(b, axis=-1, keepdims=True)
    d = np.sum(a * b, -1)
    c = np.cross(a, b)
    q = np.concatenate([c, (1 + d)[..., None]], -1)
    # opposite vectors
    bad = d < -0.999999
    if np.any(bad):
        ortho = np.cross(a, [1, 0, 0])
        if np.ndim(bad) == 0:
            if np.linalg.norm(ortho) < 1e-6:
                ortho = np.cross(a, [0, 1, 0])
            q = np.concatenate([ortho / np.linalg.norm(ortho), [0.0]])
        else:
            q[bad] = np.array([0, 0, 1, 0]) if False else q[bad]
    return qnorm(q)


def qslerp(a, b, t):
    a = qnorm(a); b = qnorm(b)
    d = np.sum(a * b, -1, keepdims=True)
    b = np.where(d < 0, -b, b); d = np.abs(d)
    t = np.asarray(t, np.float64)
    if t.ndim < a.ndim:
        t = t[..., None]
    lin = d > 0.9995
    th = np.arccos(np.clip(d, -1, 1))
    s = np.sin(th)
    s = np.where(s < 1e-9, 1, s)
    w1 = np.where(lin, 1 - t, np.sin((1 - t) * th) / s)
    w2 = np.where(lin, t, np.sin(t * th) / s)
    return qnorm(w1 * a + w2 * b)


def qfrom_mat(m):
    m = np.asarray(m, np.float64)
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = np.sqrt(tr + 1.0) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]
    return qnorm(np.array(q))


def qto_mat(q):
    x, y, z, w = qnorm(q)
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def qlook(fwd, up):
    """rotation whose +Z maps to fwd and +Y close to up"""
    f = np.asarray(fwd, float); f = f / np.linalg.norm(f)
    x = np.cross(up, f); x /= np.linalg.norm(x)
    y = np.cross(f, x)
    return qfrom_mat(np.stack([x, y, f], 1))


def qeuler(x=0, y=0, z=0, order='XYZ', deg=True):
    """intrinsic rotation composition: R = R_first * R_second * ... in given order"""
    k = np.pi / 180 if deg else 1
    q = np.array([0, 0, 0, 1.0])
    for ax in order:
        a = {'X': x, 'Y': y, 'Z': z}[ax] * k
        q = qmul(q, qaxis({'X': [1, 0, 0], 'Y': [0, 1, 0], 'Z': [0, 0, 1]}[ax], a))
    return q


def qfix_continuity(qs):
    qs = np.array(qs, np.float64)
    for i in range(1, len(qs)):
        if np.dot(qs[i], qs[i - 1]) < 0:
            qs[i] = -qs[i]
    return qs


def swing_twist(q, axis):
    """decompose q = swing * twist with twist about axis"""
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    p = np.dot(q[:3], axis) * axis
    tw = qnorm(np.array([p[0], p[1], p[2], q[3]]) + np.array([0, 0, 0, 1e-12]))
    sw = qmul(q, qinv(tw))
    return sw, tw
