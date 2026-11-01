"""Vehicle-exit manifest entries (read-modify-write of assets/soldiers/manifest.json; nothing else is touched):
  * soldier_anims.clips.<clip> for clips_vehicle.CLIPS (from .cache/clips.pkl: duration, loop, events, root motion, notes, vehicle layout)
  * soldier_anims.vehicle_exits (how the game places / plays them), soldier_anims.hatch_exit and soldier_anims.riding.dismount_jump (the
    old texts described the replaced 2.7 s / 1.2 s clips)
run: python3 tools/blender/soldiers/vehicle_manifest.py"""
import os, sys, json, pickle
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, '../../..'))
ASSETS = os.path.join(ROOT, 'assets/soldiers')
CACHE = os.path.join(HERE, '.cache')


def jdump(o):
    return json.loads(json.dumps(o, default=lambda v: v.tolist() if hasattr(v, 'tolist') else float(v)))


def clip_record(c):
    r = dict(duration_s=round(c['dur'], 3), frames=len(c['lq']), fps=30, loop=bool(c['loop']), ground_speed_mps=0.0, direction='in place',
             root_motion=True, notes=c['notes'])
    if c.get('events'):
        r['events'] = c['events']
    if c.get('vehicle'):
        r['vehicle'] = c['vehicle']
    return r


def doc():
    import clips_vehicle as CV
    L = CV.LAYOUT
    H = {n: [round(float(x), 3) for x in CV.v2c(n, L[n]['hatch'])] for n in ('hatch_exit_tank', 'hatch_exit_btr')}
    Sv = {n: [round(float(x), 3) for x in CV.v2c(n, L[n]['seat'])] for n in ('dismount_jump_btr', 'dismount_jump_tank')}
    D = [round(float(x), 3) for x in CV.v2c('dismount_door', L['dismount_door']['door'])]
    return dict(
        clips='hatch_exit (= hatch_exit_tank, 4.4 s), hatch_exit_btr (4.2 s), dismount_jump (= dismount_jump_btr, 2.2 s), dismount_jump_tank (1.9 s), '
              'dismount_door (1.6 s), dismount_rear (1.3 s); all play once (names match the soldier.js once-regex: dismount*, hatch_exit*)',
        frame='clip frame = the soldier root at the END of the clip, on the ground, facing +Z (away from the vehicle). Root motion: the whole path from the '
              'vehicle is in the Hips translation track. The game places the root ONCE at that end position (y = ground) with heading = the clip +Z and '
              'does not move it while the clip plays (s.vel = 0, as now for jumpT / hatchT). No root-motion distance has to be applied.',
        placement=dict(
            hatch_exit_tank=f'hatch rim centre at {H["hatch_exit_tank"]} from the root: root = hatch_xz + {abs(H["hatch_exit_tank"][2]):.2f} m outward (perpendicular '
                            f'to the hull side the hatch is on) + {H["hatch_exit_tank"][0]:.2f} m toward the stern (the exit station is shifted aft to land on a fender '
                            f'stowage box, not the gap between boxes); heading = outward. T-72 commander hatch (right); gunner hatch (left) = the mirror with the same numbers.',
            hatch_exit_btr=f'hatch rim centre at {H["hatch_exit_btr"]} from the root: root = hatch_xz + {abs(H["hatch_exit_btr"][2]):.2f} m outward, same station along '
                           f'the hull; heading = outward. BTR-80/82 commander hatch (front right roof); driver hatch = the mirror.',
            dismount_jump=f'ride_seat_N empty (edge seats) at {Sv["dismount_jump_btr"]} (BTR) / {Sv["dismount_jump_tank"]} (T-72) from the root: root = seat_xz + '
                          f'{abs(Sv["dismount_jump_btr"][2]):.2f} m (BTR, dismount_jump / _btr) or {abs(Sv["dismount_jump_tank"][2]):.2f} m (T-72, dismount_jump_tank) '
                          'along the seat heading (outward), on the ground; heading = seat heading. Frame 0 == ride_sit_edge frame 0 at the seat (no pop from the '
                          'riding loop). Deck seats (ride_sit_deck) have no matching start pose: crossfade, or walk them to an edge seat first.',
            dismount_door=f'door sill (step) at {D} from the root: the root is the dismount_L / dismount_R empty of btr82a / btr80_ua (1.95 m off the hull axis at '
                          'the door station z = -0.20, between axles 2 and 3); heading = outward (vehicle heading -/+ 90 deg). The vehicle models have the doors '
                          'closed: open the upper leaf forward and fold the lower leaf down (step, 0.45 m) for the clip, or accept the body passing the door panel.',
            dismount_rear='root = rear door threshold / ramp hinge + 0.55 m along -hull axis, on the ground; heading = hull backward. Floor / threshold height 0.50 m '
                          '(param: clips_vehicle.LAYOUT["dismount_rear"]["threshold"], rebuild for BMP-3 / Bradley values, or offset the root y by (h - 0.50) '
                          'for t < events.ground). A real ramp (Bradley) is a slope: play crouch_walk down it instead.'),
        timing='hatch_exit*: events hatch_open (lid thrown open), out (body clear of the hatch, sitting on the rim), ground (feet on the ground), draw (= duration - 0.5: '
               'the PM appears in weapon_socket, soldier.js already shows it for hatchT < 0.5); set hatchT = clip duration (4.4 / 4.2 s, was 2.7). '
               'dismount_*: events land / ground (feet on the ground), out (through the door); set jumpT = clip duration (2.2 / 1.9 / 1.6 / 1.3 s, was 1.1).',
        continuity='dismount_jump*, dismount_door, dismount_rear end exactly in crouch_walk frame 0 (left foot forward, right heel up) with the hips moving '
                   'forward at crouch_walk ground speed (0.93 m/s): start crouch_walk at time 0 (not a random phase) with the game root moving, or crossfade '
                   'into crouch_idle / walk_rifle. hatch_exit* end in a crouch with the PM at a compressed low ready (crossfade into pistol_idle / pistol_walk / '
                   'pistol_run).',
        vehicles_checked='check_anims.py tests the body against the actual vehicle GLBs (voxelised LOD0 meshes, hatch / door openings carved): '
                         'hatch_exit_tank vs t72av_ua + t72b3, hatch_exit_btr / dismount_jump_btr / dismount_door vs btr82a + btr80_ua, dismount_jump_tank '
                         'vs t72av_ua + t72b3. Known model obstacles ignored by the check: the AA machine gun on the T-72 cupola (t72av_ua: its barrel lies over '
                         'the commander hatch; t72b3: outboard of it) and the T-72B3 cope cage (a crewman cannot stand up through it): hide / swing them for '
                         'the bail-out or accept the clipping. Turret yaw: the tank clip assumes the turret facing forward.',
        tool='clips_vehicle.py (choreography + vehicle layouts), vehicle_geo.py (vehicle surfaces / solid), preview_vehicle.html + pvv.sh (filmstrips against the '
             'vehicle GLBs: vp / vyaw = clips_vehicle.preview_transform(name))')


def main():
    import clips_vehicle as CV
    clips = pickle.load(open(os.path.join(CACHE, 'clips.pkl'), 'rb'))
    mp = os.path.join(ASSETS, 'manifest.json')
    m = json.load(open(mp))
    sa = m.setdefault('soldier_anims', {})
    cl = sa.setdefault('clips', {})
    done = []
    for n in CV.CLIPS:
        if n in clips:
            cl[n] = jdump(clip_record(clips[n])); done.append(n)
    d = doc()
    sa['vehicle_exits'] = jdump(d)
    sa['hatch_exit'] = dict(clip='hatch_exit = hatch_exit_tank (T-72 turret hatch, 4.4 s) and hatch_exit_btr (BTR roof hatch, 4.2 s), play once, root motion in '
                                 'the Hips track, hands free (PM drawn at the end)', see='soldier_anims.vehicle_exits')
    if isinstance(sa.get('riding'), dict):
        sa['riding']['dismount_jump'] = ('dismount_jump = dismount_jump_btr (2.2 s) / dismount_jump_tank (1.9 s): start == ride_sit_edge frame 0 at the seat, end == '
                                         'crouch_walk frame 0; see soldier_anims.vehicle_exits')
    if isinstance(sa.get('in_place'), str):
        sa['in_place'] = sa['in_place'].replace('deaths and dismount_jump keep root motion and end at rest',
                                                'deaths and the vehicle exits (hatch_exit*, dismount_*) keep root motion and end on the root')
    json.dump(m, open(mp, 'w'), indent=1)
    print('manifest: clips', done, '+ vehicle_exits')


if __name__ == '__main__':
    main()
