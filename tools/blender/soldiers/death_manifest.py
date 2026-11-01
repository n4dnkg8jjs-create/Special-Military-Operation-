"""Death clip manifest entries (read-modify-write of assets/soldiers/manifest.json; nothing else is touched):
  * soldier_anims.clips.<clip> for clips_death.CLIPS (from .cache/clips.pkl: duration, events incl. 'ragdoll', root motion, notes)
  * soldier_anims.deaths: which clip the game plays when (hit direction semantics) and how the ragdoll hand-off works
run: python3 tools/blender/soldiers/death_manifest.py"""
import os, sys, json, pickle
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, '../../..'))
ASSETS = os.path.join(ROOT, 'assets/soldiers')
CACHE = os.path.join(HERE, '.cache')


def jdump(o):
    return json.loads(json.dumps(o, default=lambda v: v.tolist() if hasattr(v, 'tolist') else float(v)))


def end_offset(c):
    """where the body ends: Hips (x, z) of the last frame relative to the root (m)"""
    r = np.asarray(c['root'])
    return [round(float(r[-1, 0]), 2), round(float(r[-1, 2]), 2)]


DOC = dict(
    summary='Direction / stance specific deaths (clips_death.py). Every death clip plays once, keeps root motion (the Hips track carries '
            'the body away from the root) and ends at rest on flat ground; events.drop_weapon = rifle leaves the hands; events.body_ground = '
            'the trunk lands; events.ragdoll = time from which src/game/ragdoll.js may take the body over (-1 = never: building / casualty clips).',
    direction='hit bearing = angle of (shooter or explosion - soldier) relative to his facing: "front" |bearing| < 49 deg, "back" > 132 deg, '
              '"left" / "right" = the soldier\'s own left / right side in between. _R / _L clips name the side the hit came FROM.',
    choice=[
        'was critical / stable (lying casualty) -> death_bleedout (never a standing clip)',
        'inside a building window slot -> death_window_back (blast: always) / death_window_slump',
        'rider on a vehicle deck -> death_headshot; squad.updateRiders puts him beside the vehicle, near the camera the ragdoll drops him '
        'from deck height (falls off the deck)',
        'blast in front (< 52 deg) -> death_blast, the soldier is turned to face the explosion (thrown back away from it); blast from behind -> '
        'death_fall_forward; from a side -> death_spin_L / _R; blast deaths hand over to the ragdoll by 0.12 s with an impulse away from '
        'the explosion (scaled by the damage) and a backward tumble',
        'prone -> death_prone; kneeling (crouch) -> death_crouch',
        'headshot -> death_headshot; running (> 2.4 m/s) -> death_run',
        'standing, hit from the front -> death_fall_back 45 % / death_sit_slump 30 % / death_knees 15 % / death_crumple 10 %',
        'standing, hit from behind -> death_fall_forward 75 % / death_knees 25 %; from the left -> death_spin_L; from the right -> death_spin_R',
    ],
    arms='both arms are simulated in the build (verlet elbow + wrist hanging from the animated shoulder: gravity, residual tone fading '
         'as he goes down, ground friction, torso / thigh / head capsules, hinge elbows, shoulder limits) and solved back with two-bone IK',
    feet='feet are pinned to their ground spots while they carry weight (leg IK, IK swing between steps); no foot sliding',
    window='building clips: kneeling at the window slot (buildings.js slotPos): inner wall face 0.60 m ahead of the root (+Z), sill 0.86 m',
    ragdoll='game side (src/game/ragdoll.js): position-based dynamics on 19 joint particles, ground = city.groundHeight, max 8 active, '
            'only within ~90 m camera distance and never inside buildings / aboard; on level ground (< 8 cm under every joint now and in the '
            'clip\'s last frame) the authored clip ends the death and no ragdoll runs; otherwise it takes over at events.ragdoll, or earlier (after 0.3 s) as soon as '
            'the ground under the Hips is > 0.25 m above / below the root (trench edge, slope, rubble: the clip assumes flat ground); a new '
            'ragdoll only starts when a slot is free or the oldest body has settled > 1.4 s (never frozen mid-air: otherwise the clip finishes); '
            'blasts always ragdoll from 0.12 s with an impulse away from the explosion; '
            'asleep once the trunk moves < 1.5 cm in 0.35 s (typically 0.7-1.8 s, at most 3 s), then frozen (no per-frame cost); '
            'the soldier\'s pos moves to where the pelvis rests. Without a ragdoll the clip plays to its end, then the corpse is frozen and pos '
            'moves to the end Hips position (root motion).',
)


def main():
    import clips_death as CD
    clips = pickle.load(open(os.path.join(CACHE, 'clips.pkl'), 'rb'))
    mp = os.path.join(ASSETS, 'manifest.json')
    m = json.load(open(mp))
    sa = m.setdefault('soldier_anims', {})
    cl = sa.setdefault('clips', {})
    done = []
    for n in CD.CLIPS:
        if n not in clips:
            continue
        c = clips[n]
        r = dict(duration_s=round(c['dur'], 3), frames=len(c['lq']), fps=30, loop=False, ground_speed_mps=0.0, direction='in place',
                 root_motion=True, notes=c['notes'], end_hips_xz=end_offset(c))
        if c.get('events'):
            r['events'] = c['events']
        cl[n] = jdump(r); done.append(n)
    for n in ('death_front', 'death_back', 'death_crumple'):          # the old clips: ragdoll from the time the trunk is down
        if n in cl:
            ev = cl[n].setdefault('events', {})
            ev.setdefault('ragdoll', {'death_front': 1.0, 'death_back': 1.6, 'death_crumple': 1.28}[n])
    sa['deaths'] = jdump(DOC)
    gp = os.path.join(ASSETS, 'soldier_anims.glb')
    if 'size_bytes' in sa:
        sa['size_bytes'] = os.path.getsize(gp)
    json.dump(m, open(mp, 'w'), indent=1)
    print('manifest: clips', done, '+ deaths')


if __name__ == '__main__':
    main()
