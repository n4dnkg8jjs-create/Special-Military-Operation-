"""infantry_v5 crawl clip manifest entries (read-modify-write of assets/soldiers/manifest.json; nothing else is touched - never run
write_manifest.py for this): soldier_anims.clips.<clip> for prone_crawl, high_crawl, prone_down, prone_up (from .cache/clips.pkl).
run after `python3 build_anims.py --merge prone_crawl high_crawl prone_down prone_up`:  python3 tools/blender/soldiers/crawl_manifest.py"""
import os, sys, json, pickle, fcntl
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '../../..'))
ASSETS = os.path.join(ROOT, 'assets/soldiers')
CACHE = os.path.join(HERE, '.cache')
CLIPS = ['prone_crawl', 'high_crawl', 'prone_down', 'prone_up']


def jdump(o):
    return json.loads(json.dumps(o, default=lambda v: v.tolist() if hasattr(v, 'tolist') else float(v)))


def main():
    clips = pickle.load(open(os.path.join(CACHE, 'clips.pkl'), 'rb'))
    mp = os.path.join(ASSETS, 'manifest.json')
    with open(mp + '.lock', 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        m = json.load(open(mp))
        sa = m.setdefault('soldier_anims', {})
        cl = sa.setdefault('clips', {})
        done = []
        for n in CLIPS:
            if n not in clips:
                continue
            c = clips[n]
            sp = float(c.get('speed', 0.0))
            r = dict(duration_s=round(c['dur'], 3), frames=len(c['lq']), fps=30, loop=bool(c['loop']), ground_speed_mps=round(sp, 3),
                     direction='forward (+Z)' if sp > 0 else 'in place', root_motion=False, notes=c['notes'])
            if c.get('events'):
                r['events'] = c['events']
            cl[n] = jdump(r); done.append(n)
        gp = os.path.join(ASSETS, 'soldier_anims.glb')
        if 'size_bytes' in sa:
            sa['size_bytes'] = os.path.getsize(gp)
        tmp = mp + '.tmp_crawl'
        json.dump(m, open(tmp, 'w'), indent=1)
        os.replace(tmp, mp)
    print('manifest: updated', done)


if __name__ == '__main__':
    main()
