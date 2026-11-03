"""Medevac clip manifest entries (read-modify-write of assets/soldiers/manifest.json; nothing else is touched - never run
write_manifest.py for this):
  * soldier_anims.clips.<clip> for clips_medevac.CLIPS (from .cache/clips.pkl)
  * soldier_anims.medevac: how the game pairs the medic and casualty clips (src/game/medevac.js)
run after `python3 build_anims.py --merge <clips_medevac.CLIPS...>`:  python3 tools/blender/soldiers/medevac_manifest.py"""
import os, sys, json, pickle, fcntl
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, '../../..'))
ASSETS = os.path.join(ROOT, 'assets/soldiers')
CACHE = os.path.join(HERE, '.cache')

DOC = dict(
    summary='Casualty evacuation with the pickup (assets/vehicles/pickup.glb, src/game/medevac.js, clips_medevac.py). Medic and casualty '
            'clips come in pairs that share the root: the game puts the casualty\'s root on the medic\'s root with the same heading and keeps '
            'the casualty clip time equal to the medic\'s (medevac_lift + wounded_lifted, medevac_carry_walk + wounded_carry_walk, '
            'medevac_load_bed + wounded_load_bed).',
    cab='medevac_cab_exit / medevac_cab_enter: clip frame = the end root on the ground beside the door facing away from the truck; the cab seat '
        'H-point (ride_seat_2 / ride_seat_3 of pickup.glb) is events.seat_root_frame in that frame (+X = the truck\'s front for right-hand doors): '
        'root = seat + 0.62 m outward + 0.10 m forward. The door (door_FR / door_RR hinge, manifest vehicles.pickup.doors) opens at the start.',
    lift='medevac_lift: the casualty lies events.casualty_root_frame ahead of the medic (on his back, head to the medic\'s left); ends in '
         'medevac_carry_walk frame 0 (the casualty over the right shoulder).',
    load='medevac_load_bed: the medic stands at load_point (behind the open tailgate, facing the truck) shifted sideways by the stretcher slot\'s '
         'x; wounded_load_bed ends exactly in wounded_on_bed frame 0 at that stretcher_N empty (turned 180 deg: the empty\'s +Z faces the tailgate).',
    bed='wounded_on_bed: lying on the back, floor at y = 0 of the root frame, head towards -Z; root = stretcher_N empty.',
    weapon='medevac_* clips: rifle slung on the back (weapon_socket_back); wounded_*: slung / dropped as for the other wounded clips.',
)


def jdump(o):
    return json.loads(json.dumps(o, default=lambda v: v.tolist() if hasattr(v, 'tolist') else float(v)))


def main():
    import clips_medevac as CM
    clips = pickle.load(open(os.path.join(CACHE, 'clips.pkl'), 'rb'))
    mp = os.path.join(ASSETS, 'manifest.json')
    with open(mp + '.lock', 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        m = json.load(open(mp))
        sa = m.setdefault('soldier_anims', {})
        cl = sa.setdefault('clips', {})
        done = []
        for n in CM.CLIPS:
            if n not in clips:
                continue
            c = clips[n]
            sp = float(c.get('speed', 0.0))
            r = dict(duration_s=round(c['dur'], 3), frames=len(c['lq']), fps=30, loop=bool(c['loop']), ground_speed_mps=round(sp, 3),
                     direction='forward' if sp > 0 else 'in place', root_motion=not c['loop'], notes=c['notes'])
            if c.get('events'):
                r['events'] = c['events']
            cl[n] = jdump(r); done.append(n)
        sa['medevac'] = DOC
        gp = os.path.join(ASSETS, 'soldier_anims.glb')
        if 'size_bytes' in sa:
            sa['size_bytes'] = os.path.getsize(gp)
        tmp = mp + '.tmp_medevac'
        json.dump(m, open(tmp, 'w'), indent=1)
        os.replace(tmp, mp)
    print('manifest: clips', done, '+ medevac')


if __name__ == '__main__':
    main()
