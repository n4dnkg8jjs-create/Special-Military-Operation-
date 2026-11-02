"""summary of a pvdismount.mjs TRACE=1 trace: per rider - jump start time / clip, hips step at the switch seat -> clip (pop), largest
per-frame hips step during the clip, root travel and heading change during the clip (must be 0), hips over the root at the end, hips
step at the switch clip -> next clip, root drift in the 1 s after the clip.   run: python3 dmtrace.py <out>_trace.json"""
import json, math, sys
tr = json.load(open(sys.argv[1]))
by = {}
for fr in tr:
    for r in fr:
        by.setdefault(r[1], []).append(r)     # [t, idx, clip, x, y, z, heading, hx, hy, hz, inside, jumpT]
starts = []
for i, rows in sorted(by.items()):
    J = [k for k, r in enumerate(rows) if r[2].startswith('dismount')]
    if not J:
        print(i, 'no jump'); continue
    k0, k1 = J[0], J[-1]
    a, b = rows[k0 - 1], rows[k0]
    starts.append(b[0])
    step = max(math.dist(rows[k][7:10], rows[k + 1][7:10]) for k in range(k0, k1))
    travel = max(math.dist(rows[k0][3:6:2], rows[k][3:6:2]) for k in J)
    head = max(abs(rows[k][6] - rows[k0][6]) for k in J)
    e = rows[k1]
    over = math.dist(e[3:6:2], e[7:10:2])
    nxt = rows[k1 + 1] if k1 + 1 < len(rows) else None
    after = [r for r in rows[k1 + 1:] if r[0] - e[0] <= 1.0]
    print(f'{i}: {b[2]:26s} start {b[0]:.2f}s  switch-in hips step {math.dist(a[7:10], b[7:10]):.3f}  max hips step {step:.3f}  root travel {travel:.3f}  '
          f'heading change {head:.3f}  end: hips-root {over:.3f}' + (f'  switch-out ({nxt[2]}) hips step {math.dist(e[7:10], nxt[7:10]):.3f}' if nxt else '') +
          (f'  drift 1 s after {max(math.dist(e[3:6:2], r[3:6:2]) for r in after):.2f} m' if after else ''))
if starts:
    print(f'jump starts within {max(starts) - min(starts):.2f} s')
