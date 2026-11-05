"""Summarise vcheck.py reports (before / after) and emit render jobs with markers at the findings.
python3 vcheck_sheet.py <before_dir> <after_dir> <out_dir>   -> out_dir/checker_summary.md + .json, out_dir/mark_jobs.json
Frames: vcheck.py works in the Blender import frame (Z up); glTF = (x, z, -y)."""
import json, os, sys

KK = {'btr': 'cage ew sandbags smoke sight', 'ifv': 'cage era ew sandbags', 'spg': 'cage', 'tank': 'cage era ew roof sandbags smoke sight'}
VS = ['btr82a', 'btr80_ua', 't72b3', 't72av_ua', 'bmp3', 'bradley_ua', 'msta_s', 'bohdana', 'pickup']
MIN_GAP = 0.012


def g(p):
    return [round(p[0], 3), round(p[2], 3), round(-p[1], 3)]


def kit_ok(rep_item, kind):
    allowed = KK.get(kind, '').split()
    names = rep_item.get('meshes', []) + [rep_item.get('a', '')]
    for n in names:
        n = n.replace('kit:', '')
        if n.startswith('kit_'):
            k = n[4:].split('_')[0]
            k = {'links': 'sandbags', 'cage': 'cage', 'roof': 'roof'}.get(k, k)
            return k in allowed
    return True


def load(d, v):
    p = os.path.join(d, v + '_report.json')
    return json.load(open(p)) if os.path.exists(p) else None


def counts(r, kind):
    if not r:
        return None
    fl = [f for f in r.get('floating', []) if f['gap_m'] > MIN_GAP]
    kf = [f for f in r.get('kit_floating', []) if f['gap_m'] > MIN_GAP and kit_ok(f, kind)]
    kp = [p for p in r.get('kit_penetration', []) if kit_ok(p, kind)]
    return dict(floating=len(fl), floating_gt3cm=len([f for f in fl if f['gap_m'] > 0.03]), clips_closed=len(r.get('penetration_closed', [])),
                clips_open=len(r.get('penetration_open', [])), ghost_lids=[x['node'] for x in r.get('ghost_lids', []) if x['ghost']],
                ghost_lids_lod1=[x['node'] for x in r.get('ghost_lids_lod1', []) if x['ghost']], kit_floating=len(kf), kit_clips=len(kp))


def main(bd, ad, od):
    man = json.load(open(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'assets', 'vehicles', 'manifest.json')))['vehicles']
    rows, out, jobs = [], {}, []
    for v in VS:
        kind = man.get(v, {}).get('kind')
        b, a = load(bd, v), load(ad, v) if ad else None
        cb, ca = counts(b, kind), counts(a, kind)
        out[v] = dict(before=cb, after=ca)
        f = lambda c, k: '-' if c is None else (', '.join(c[k]) or '0') if isinstance(c[k], list) else str(c[k])
        rows.append(f"| {v} | " + ' | '.join(f"{f(cb, k)} -> {f(ca, k)}" for k in ('floating', 'floating_gt3cm', 'clips_closed', 'clips_open', 'ghost_lids', 'kit_floating', 'kit_clips')) + ' |')
        for tag, r, d in (('before', b, bd), ('after', a, ad)):
            if not r:
                continue
            fl = [x for x in r.get('floating', []) if x['gap_m'] > MIN_GAP]
            marks = ';'.join(','.join(map(str, g(x['center']) + [max(x['size']) / 2 + 0.05])) for x in fl[:40])
            pen = r.get('penetration_closed', []) + r.get('penetration_open', [])
            marks2 = ';'.join(','.join(map(str, g(x['at']) + [0.12])) for x in pen[:30])
            m = ';'.join(x for x in (marks, marks2) if x)
            fq = f"&file=previews/vehicles_v5/_before_glb/{v}.glb" if tag == 'before' else ''
            jobs.append(dict(q=f"v={v}{fq}&views=4&angs=35,25;145,25;250,15;0,70&dist=0.8&marks={m}&label={v} {tag}: {len(fl)} floating, {len(pen)} clipping (red)",
                             png=os.path.join(od, f'{v}_{tag}_marks.png')))
            kf = [x for x in r.get('kit_floating', []) if x['gap_m'] > MIN_GAP and kit_ok(x, kind)]
            kp = [x for x in r.get('kit_penetration', []) if kit_ok(x, kind)]
            km = ';'.join([','.join(map(str, g(x['center']) + [max(x['size']) / 2 + 0.05])) for x in kf[:30]] + [','.join(map(str, g(x['at']) + [0.12])) for x in kp[:20]])
            if v != 'pickup':
                jobs.append(dict(q=f"v={v}{fq}&kits={KK[kind].replace(' ', ',')}&views=4&angs=35,25;145,25;250,15;0,70&dist=0.8&marks={km}&label={v} kits {tag}: {len(kf)} floating, {len(kp)} clipping",
                                 png=os.path.join(od, f'{v}_{tag}_kits_marks.png')))
    md = ['| vehicle | floating parts (>1.2 cm gap) | of which >3 cm | clipping pairs (closed) | clipping (hatches/doors open) | ghost closed lids | kit parts floating | kit parts clipping |',
          '|---|---|---|---|---|---|---|---|'] + rows
    open(os.path.join(od, 'checker_summary.md'), 'w').write('\n'.join(md) + '\n')
    json.dump(out, open(os.path.join(od, 'checker_summary.json'), 'w'), indent=1)
    json.dump(jobs, open(os.path.join(od, 'mark_jobs.json'), 'w'))
    print('\n'.join(md))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 3 else None, sys.argv[-1])
