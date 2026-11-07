"""infantry anim v8 manifest entries (read-modify-write of assets/soldiers/manifest.json; nothing else is touched - never run
write_manifest.py for this): soldier_anims.clips.<clip> for reload_prone, reload_mg_prone, reload_mg_crouch (from .cache/clips.pkl),
events.pouch on reload_stand / reload_crouch (the hand is at the pouch: an emergency reload lets the empty go before it), and the
soldier_anims.v8 section (what the game layers on the clips at run time).
run after `python3 build_anims.py --merge reload_prone reload_mg_prone reload_mg_crouch`:  python3 tools/blender/soldiers/v8_manifest.py"""
import os, json, pickle, fcntl
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '../../..'))
ASSETS = os.path.join(ROOT, 'assets/soldiers')
CACHE = os.path.join(HERE, '.cache')
CLIPS = ['reload_prone', 'reload_mg_prone', 'reload_mg_crouch']
V8 = dict(
    summary='infantry anim v8: stance / weapon matched reloads, per-shot procedural recoil with support-hand IK, varied deaths '
            '(src/game/soldier.js + src/game/soldierPose.js; clips from clips_v8.py)',
    reloads='game picks reload_stand / reload_crouch / reload_prone (AK family) or reload_mg_prone / reload_mg_crouch (PKM; a standing '
            'gunner uses reload_stand) and time-scales the clip (0.6-1.6) so it ends back on the aim pose when the reload finishes. '
            'Emergency reload (magazine empty): the empty is let go ~0.1 s after mag_out and falls to the ground (lies there 60 s), the hand '
            'comes back from the pouch (events.pouch[0]) with the new one; tactical reload (topping up in a lull, magazine < 1/3): the '
            'part-used magazine is retained (clip as authored), its rounds pooled.',
    recoil='fire_* clips are no longer played: the aim / peek clip stays on and every round fired kicks damped springs (muzzle flip = '
           'RightArm about the shoulder, chest rock = Spine 40 % + Spine1 60 %, neck counter-rock, random yaw drift) with per-weapon '
           'strength (AK-74 2.6 deg flip / 1.4 deg rock, AK-12 2.2 / 1.2, PKM 3.4 / 2.0 and x0.35 on the bipod prone, PM 9 deg wrist flip) '
           'and stance factors (crouch 0.9 / 0.8, prone 0.6 / 0.45); the left hand is held on the weapon by two-bone IK while it moves.',
    deaths='clip by stance, hit bearing, hit region (leg -> death_knees / death_crumple), speed (walking > 0.9 m/s -> forward momentum, '
           'running -> death_run) and blast size (death_blast only for a big burst in front, power >= 130; smaller blasts knock the man '
           'down with a modest ragdoll impulse); each death plays at 0.88-1.12x with a procedural hit jolt (chest back / twist / lean '
           'away from the hit), loose arm and head flail that dies out before the body lands, and a lasting random head turn.',
)


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
            r = dict(duration_s=round(c['dur'], 3), frames=len(c['lq']), fps=30, loop=bool(c['loop']), ground_speed_mps=0.0,
                     direction='in place', root_motion=False, notes=c['notes'])
            if c.get('events'):
                r['events'] = c['events']
            cl[n] = jdump(r); done.append(n)
        for n in ('reload_stand', 'reload_crouch'):
            if n in cl:
                cl[n].setdefault('events', {})['pouch'] = [1.04, 1.26]
        sa['v8'] = V8
        gp = os.path.join(ASSETS, 'soldier_anims.glb')
        if 'size_bytes' in sa:
            sa['size_bytes'] = os.path.getsize(gp)
        tmp = mp + '.tmp_v8'
        json.dump(m, open(tmp, 'w'), indent=1)
        os.replace(tmp, mp)
    print('manifest: soldier_anims.clips', done, '+ pouch events + v8 section')


if __name__ == '__main__':
    main()
