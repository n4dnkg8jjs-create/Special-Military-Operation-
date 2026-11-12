"""Plate carrier (UA): the cummerbund hung 6 cm below both plate bags, so on a bare back its two ends showed under the back
plate. Lifts the cummerbund, its webbing rows and the pouches that hang on it (every mesh island that lies wholly in the
cummerbund's band, to one side of the spine) by DY, so its lower edge is level with the plates' - in the part meshes, the
merged combo_* meshes and their LODs. Patches the shipped GLB in place (positions only; numpy, no Blender).
NOT idempotent: run once on the committed file.   python3 tools/blender/soldiers/cummerbund_fix.py assets/soldiers/soldier_ua.glb
"""
import json, struct, sys, numpy as np
DY, Y0, Y1, XIN, XOUT = 0.062, 1.04, 1.225, 0.06, 0.30   # (Y0 1.04: the assault kit's side plates ride in the cummerbund and go up with it)
path = sys.argv[1]; dry = '--dry' in sys.argv
raw = bytearray(open(path, 'rb').read()); n = struct.unpack('<I', raw[12:16])[0]; J = json.loads(raw[20:20 + n]); bin0 = 20 + n + 8
CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}; NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
NORM = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535}
def view(i):
    a = J['accessors'][i]; bv = J['bufferViews'][a['bufferView']]; dt = np.dtype(CT[a['componentType']]); nc = NC[a['type']]
    off = bin0 + bv.get('byteOffset', 0) + a.get('byteOffset', 0); st = bv.get('byteStride', dt.itemsize * nc)
    return a, dt, nc, off, st
def read(i):
    a, dt, nc, off, st = view(i); out = np.zeros((a['count'], nc), dtype=dt)
    for k in range(a['count']): out[k] = np.frombuffer(raw, dtype=dt, count=nc, offset=off + k * st)
    return out
def local(i):
    nd = J['nodes'][i]; M = np.eye(4)
    if 'matrix' in nd: return np.array(nd['matrix']).reshape(4, 4).T
    x, y, z, w = nd.get('rotation', [0, 0, 0, 1]); R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M[:3, :3] = R * np.array(nd.get('scale', [1, 1, 1])); M[:3, 3] = nd.get('translation', [0, 0, 0]); return M
par = {c: i for i, nd in enumerate(J['nodes']) for c in nd.get('children', [])}
def world(i):
    M = local(i)
    while i in par: i = par[i]; M = local(i) @ M
    return M
todo = {}   # position accessor -> (set of vertex ids, M, normalised?)
for ni, nd in enumerate(J['nodes']):
    if 'mesh' not in nd: continue
    name = nd.get('name', '')
    if not (name.startswith(('vest', 'pouches_side', 'pouches_assault', 'armor_assault', 'combo_', 'assault_combo_')) and '_tape' not in name): continue   # (not the crews: their belt kit is not on a cummerbund)
    M = world(ni); moved = 0
    for p in J['meshes'][nd['mesh']]['primitives']:
        ai = p['attributes']['POSITION']; a = J['accessors'][ai]; Pq = read(ai).astype(np.float64)
        if a.get('normalized'): Pq /= NORM[a['componentType']]
        P = (M[:3, :3] @ Pq.T).T + M[:3, 3]; I = read(p['indices']).astype(np.int64).reshape(-1, 3)
        key = {}; w = np.zeros(len(P), np.int64)
        for k, v in enumerate(np.round(P * 2000).astype(np.int64)): w[k] = key.setdefault(tuple(v), len(key))
        parent = list(range(len(key)))
        def f(x):
            while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
            return x
        for t in I:
            a_, b_, c_ = w[t]; parent[f(b_)] = f(a_); parent[f(c_)] = f(a_)
        isl = {}
        for t in I: isl.setdefault(f(w[t[0]]), set()).update(t.tolist())
        for vs in isl.values():
            V = P[sorted(vs)]; mn = V.min(0); mx = V.max(0)
            if mn[1] < Y0 or mx[1] > Y1: continue
            if not (mn[0] >= XIN or mx[0] <= -XIN) or max(abs(mn[0]), abs(mx[0])) > XOUT: continue
            todo.setdefault(ai, [set(), M])[0].update(vs); moved += 1
    if moved: print(f'{name}: {moved} islands')
for ai, (vs, M) in todo.items():
    a, dt, nc, off, st = view(ai); sy = np.linalg.norm(M[:3, 1]); d = DY / sy
    if a.get('normalized'): d *= NORM[a['componentType']]
    assert abs(M[1, 1]) > 0.99 * sy, 'node not upright'
    for k in vs:
        o = off + k * st + dt.itemsize; v = np.frombuffer(raw, dtype=dt, count=1, offset=o)[0]
        nv = v + d if dt.kind == 'f' else int(round(v + d))
        if dt.kind != 'f': assert np.iinfo(dt).min <= nv <= np.iinfo(dt).max, 'quantised range'
        raw[o:o + dt.itemsize] = np.array([nv], dtype=dt).tobytes()
    P = read(ai); a['min'] = [float(x) if dt.kind == 'f' else int(x) for x in P.min(0)]; a['max'] = [float(x) if dt.kind == 'f' else int(x) for x in P.max(0)]
js = json.dumps(J, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
out = bytearray(raw[:12]) + struct.pack('<I', len(js)) + b'JSON' + js + raw[20 + n:]
out[8:12] = struct.pack('<I', len(out))
print('accessors patched:', len(todo), 'vertices:', sum(len(v[0]) for v in todo.values()))
if not dry: open(path, 'wb').write(out)
