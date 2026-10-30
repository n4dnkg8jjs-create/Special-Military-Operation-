#!/usr/bin/env python3
"""Build the game's sound library from openly-licensed sources.

    nice -n 10 python3 tools/audio/build.py            # fetch (cached) + process + manifest + credits
    nice -n 10 python3 tools/audio/build.py --only rifle_near,mg_near

Outputs
  assets/audio/<category>/<key>_<nn>.mp3   44.1 kHz, mono for positional one-shots, stereo for beds/UI
  assets/audio/manifest.json               event -> files + playback params (+ loopStart/loopEnd for loops)
  docs/AUDIO_CREDITS.md                    every file -> source, author, licence

Processing per file: decode -> (slice / auto-split / composite) -> trim silence -> fades ->
optional distance treatment -> loudness normalise (max-momentary LUFS for one-shots, integrated for
loops/beds; sample-peak ceiling -2 dBFS one-shots / -3 dBFS UI+loops, leaving headroom for MP3 overshoot) -> LAME VBR MP3.

Loops: built as an equal-power crossfaded periodic loop, then padded with 0.25 s of its own wrap-around on
both sides. Play with source.loop=true, loopStart/loopEnd from the manifest. Because the pad is periodic
content, the loop stays seamless even if a browser's MP3 decoder does not strip encoder delay.
"""
import argparse
import json
import pathlib
import shutil
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import dsp  # noqa: E402
import sources  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "assets" / "audio"
SR = dsp.SR

# ----------------------------------------------------------------------------- event table
# key: (category, gain, loop, spatial, refDistance, maxDistance)
EVENTS = {}


def ev(key, cat, gain=1.0, loop=False, spatial=True, ref=10, maxd=600, **extra):
    EVENTS[key] = dict(category=cat, gain=gain, loop=loop, spatial=spatial, refDistance=ref,
                       maxDistance=maxd, **extra)


# ----------------------------------------------------------------------------- recipes
RECIPES = []  # list of dicts


def R(key, specs, op="whole", **kw):
    """op: whole | split | slice | loop | fn
    common kw: maxdur, pick (indices into split result), thr, gap, tail, far(dict|True), lp, hp, pitch (list),
               target, fout, mono, quality, slices [(s,e)], start/end/xfade (loop), fn (callable)"""
    if isinstance(specs, str):
        specs = [specs]
    RECIPES.append(dict(key=key, specs=specs, op=op, **kw))


FAR = dict(fc=2000, rt=1.6, wet=0.45)
MID = dict(fc=3200, rt=1.1, wet=0.30)
VFAR = dict(fc=900, rt=2.2, wet=0.55)

# ---- weapons ---------------------------------------------------------------
ev("rifle_near", "weapons", 0.9, ref=8, maxd=500, note="AK-74 single shot, close (AK-47/SKS 7.62x39 recordings)")
R("rifle_near", ["ffsl:AK-47/C_28P.wav", "ffsl:SKS/U_14P.wav"], "split", thr=-30, gap=0.6, tail=-58, maxdur=1.3)
R("rifle_near", ["fsd:404561", "fsd:404562"], "whole", maxdur=1.3)
ev("rifle_far", "weapons", 0.8, ref=30, maxd=1500, note="single shot heard from 100-400 m")
R("rifle_far", ["ffsl:AK-47/C_31P.wav", "ffsl:SKS/U_19P.wav"], "split", thr=-26, gap=0.6, tail=-60, maxdur=1.8, far=MID)
R("rifle_far", ["fsd:387477", "fsd:158977", "fsd:158978", "fsd:158979"], "whole", maxdur=2.0)
ev("rifle_burst_near", "weapons", 0.9, ref=8, maxd=500, note="AK burst, close")
R("rifle_burst_near", ["ffsl:AK-47/C_29P.wav", "ffsl:AK-47/C_27P.wav"], "split", thr=-30, gap=0.6, tail=-58, maxdur=2.2)
ev("rifle_burst_far", "weapons", 0.8, ref=30, maxd=1500)
R("rifle_burst_far", ["ffsl:AK-47/C_34P.wav", "ffsl:AK-47/C_36P.wav"], "split", thr=-30, gap=0.6, tail=-58, maxdur=3.0, far=MID)
ev("dmr_near", "weapons", 0.95, ref=10, maxd=800, note="SVD / single 7.62x54R shot, close (Mosin-Nagant recordings)")
R("dmr_near", ["ffsl:Mosin Nagant/M_21P.wav"], "split", thr=-30, gap=0.6, tail=-62, maxdur=1.5)
ev("dmr_far", "weapons", 0.85, ref=40, maxd=2000)
R("dmr_far", ["ffsl:Mosin Nagant/M_26P.wav"], "split", thr=-26, gap=0.6, tail=-60, maxdur=2.0, far=MID)
ev("mg_near", "weapons", 1.0, ref=10, maxd=700, note="PKM-like GPMG bursts (7.62 LMG + Maxim 7.62x54R recordings)")
R("mg_near", ["fsd:417688"], "split", thr=-30, gap=0.6, tail=-55, maxdur=2.8, pick=[0, 1, 2])
R("mg_near", ["fsd:160772"], "split", thr=-24, gap=0.12, tail=-50, maxdur=2.2)
R("mg_near", ["fsd:417686", "fsd:397657"], "whole", maxdur=4.0)
ev("mg_far", "weapons", 0.85, ref=40, maxd=2000)
R("mg_far", ["fsd:160773"], "slice", slices=[(0.7, 1.6), (1.55, 2.5), (2.5, 3.6), (4.35, 5.6)], start_db=-60, fin=0.04)
R("mg_far", ["fsd:417688"], "split", thr=-30, gap=0.6, tail=-55, maxdur=3.0, pick=[0, 2, 4], far=FAR)
ev("hmg", "weapons", 1.0, ref=14, maxd=900, note="14.5 mm KPVT stand-in: .50 cal recordings")
R("hmg", ["fsd:239138"], "slice", slices=[(0.0, 2.65), (2.68, 3.7)])
R("hmg", ["fsd:238677"], "slice", slices=[(0.0, 1.72), (1.70, 3.4)])
R("hmg", ["fsd:160355"], "split", thr=-26, gap=0.08, maxdur=3.0, pick=[0, 1])
ev("hmg_far", "weapons", 0.9, ref=50, maxd=2500)
R("hmg_far", ["fsd:239138"], "slice", slices=[(0.0, 2.65), (2.68, 3.7)], far=FAR)
R("hmg_far", ["fsd:238677"], "slice", slices=[(0.0, 1.72)], far=FAR)
ev("cannon30", "weapons", 1.0, ref=16, maxd=1200, note="2A72 30 mm stand-in: M242 25 mm / Mk46 30 mm recordings, short bursts")
R("cannon30", ["fsd:67580", "fsd:67581"], "slice", slices=[(0.0, 1.5), (1.4, 3.3)])
R("cannon30", ["fsd:162258", "fsd:423108"], "whole", maxdur=2.3)
ev("cannon30_far", "weapons", 0.9, ref=60, maxd=3000)
R("cannon30_far", ["fsd:67580", "fsd:67581"], "slice", slices=[(0.0, 1.5), (1.4, 3.3)], far=FAR)
R("cannon30_far", ["fsd:162258"], "whole", far=FAR)
ev("tankgun", "weapons", 1.0, ref=25, maxd=4000, note="125 mm main gun (120 mm / XM360 / tank cannon recordings)")
R("tankgun", ["fsd:67524", "fsd:67527", "fsd:127845"], "whole", maxdur=4.0)
R("tankgun", ["fsd:187767"], "slice", slices=[(0.1, 3.9)])
ev("tankgun_far", "weapons", 0.9, ref=80, maxd=6000)
R("tankgun_far", ["fsd:184275"], "slice", slices=[(0.0, 5.2), (6.0, 8.6), (9.0, 11.7), (12.0, 17.4)])
ev("artillery_far", "weapons", 0.9, spatial=False, note="distant artillery / howitzer reports (non-positional bed one-shots)")
R("artillery_far", ["fsd:239137"], "slice", slices=[(0.0, 3.0), (3.05, 6.9)], far=dict(fc=1400, rt=2.0, wet=0.4))
R("artillery_far", ["fsd:187767"], "slice", slices=[(6.3, 9.8)], far=VFAR)
R("artillery_far", ["fsd:161342", "fsd:161343"], "whole", far=VFAR)
ev("mortar_launch", "weapons", 0.9, ref=15, maxd=1500, note="82/120 mm mortar firing (M224 recordings)")
R("mortar_launch", ["fsd:426161", "fsd:426162", "fsd:161970"], "whole", maxdur=2.5)
ev("rpg_launch", "weapons", 1.0, ref=12, maxd=1200)
R("rpg_launch", ["fsd:162361", "oga:4-projectile-launches/launches/rlaunch.wav"], "whole", maxdur=2.6)
R("rpg_launch", ["fsd:151402"], "slice", slices=[(0.0, 2.45)])
ev("rpg_flight", "weapons", 0.7, loop=True, ref=8, maxd=400, note="rocket motor/whoosh loop; attach to projectile")
R("rpg_flight", ["oga:rocket-launch/launch/launch.wav"], "loop", start=2.2, end=5.6, xfade=0.8, hp=200)
ev("grenade_pin", "weapons", 0.5, ref=4, maxd=60)
R("grenade_pin", ["fsd:156896"], "split", thr=-30, gap=0.2, maxdur=0.6, pick=[1, 2, 3, 4, 5])
ev("grenade_throw", "weapons", 0.5, ref=4, maxd=60)
R("grenade_throw", ["oga:war-on-water-sndfx/Guns/throwgrenade.ogg", "oga:air-whoosh/whoosh2_0.wav"], "whole", maxdur=1.0)
ev("reload", "weapons", 0.5, ref=4, maxd=60)
R("reload", ["oga:gun-reload-sounds/assaultriflereload1_0.wav", "oga:gun-reload-sounds/gunreload1.wav",
             "oga:gun-reload-sound-effects/clipload1.wav", "oga:gun-reload-sound-effects/clipload2.wav",
             "oga:2-gun-reloads/gun_reload.1.ogg", "oga:2-gun-reloads/gun_reload.2.ogg",
             "oga:handling-guns/Gary Guns/22_mag.wav", "oga:2-metal-weapon-clicks/clicks/weapload.wav",
             "oga:fps-placeholder-sounds/gun_load_01.wav", "oga:fps-placeholder-sounds/gun_load_02.wav"], "whole", maxdur=2.5)
ev("bolt", "weapons", 0.5, ref=4, maxd=60, note="charging handle / bolt", max_files=12)
R("bolt", ["oga:handling-guns/Gary Guns/30-06_bolt.wav", "oga:handling-guns/Gary Guns/45ACP_slide.wav",
           "oga:gun-reload-sounds/shotguncock_0.wav", "oga:handling-guns/Gary Guns/12ga_load_chamber.wav"], "split",
  thr=-30, gap=0.25, maxdur=1.2)
ev("dryfire", "weapons", 0.4, ref=3, maxd=40)
R("dryfire", ["oga:2-metal-weapon-clicks/clicks/outofammo.wav", "oga:fps-placeholder-sounds/gun_outofammo_01.wav",
              "oga:war-on-water-sndfx/Guns/gunempty.ogg"], "whole", maxdur=0.6)

# ---- ballistics -------------------------------------------------------------
ev("bullet_whizz", "ballistics", 0.6, ref=3, maxd=40, note="near-miss whizz (weak: single source pitched)")
R("bullet_whizz", ["oga:red-eclipse-sounds/sounds/weapons/whizz.ogg"], "whole", pitch=[0.8, 0.9, 1.0, 1.12, 1.25])
ev("ricochet", "ballistics", 0.6, ref=6, maxd=150)
R("ricochet", ["fsd:96630", "fsd:96635", "fsd:96636"], "whole", maxdur=1.4, pitch=[0.88, 1.0, 1.14])
ev("impact_concrete", "ballistics", 0.6, ref=5, maxd=150)
R("impact_concrete", ["oga:75-cc0-breaking-falling-hit-sfx/bfh1_rock_hit_01.ogg",
                      "oga:75-cc0-breaking-falling-hit-sfx/bfh1_rock_breaking_01.ogg",
                      "oga:75-cc0-breaking-falling-hit-sfx/bfh1_rock_breaking_02.ogg",
                      "oga:75-cc0-breaking-falling-hit-sfx/bfh1_rock_breaking_03.ogg",
                      "oga:5-break-crunch-impacts/impcrunch/impactcrunch01.mp3.flac",
                      "oga:5-break-crunch-impacts/impcrunch/impactcrunch02.mp3.flac",
                      "oga:5-break-crunch-impacts/impcrunch/impactcrunch03.mp3.flac",
                      "oga:red-eclipse-sounds/sounds/sfx/debris.ogg", "oga:red-eclipse-sounds/sounds/sfx/debris3.ogg",
                      "fsd:267341"], "whole", maxdur=0.7, fout=0.15)
ev("impact_dirt", "ballistics", 0.55, ref=5, maxd=150)
R("impact_dirt", ["oga:impactsgunsfx/Impacts/Impact Gun 1.wav", "oga:impactsgunsfx/Impacts/Impact Gun 2.wav",
                  "oga:impactsgunsfx/Impacts/Impact Gun 3.wav", "oga:impactsgunsfx/Impacts/Impact Gun 4.wav"],
  "whole", maxdur=0.6, fout=0.2, pitch=[0.85, 1.0, 1.15])
ev("impact_metal", "ballistics", 0.6, ref=6, maxd=200)
R("impact_metal", ["fsd:267893", "oga:75-cc0-breaking-falling-hit-sfx/bfh1_metal_hit_01.ogg",
                   "oga:75-cc0-breaking-falling-hit-sfx/bfh1_metal_hit_02.ogg",
                   "oga:75-cc0-breaking-falling-hit-sfx/bfh1_metal_hit_03.ogg",
                   "oga:75-cc0-breaking-falling-hit-sfx/bfh1_metal_hit_04.ogg",
                   "oga:75-cc0-breaking-falling-hit-sfx/bfh1_metal_hit_05.ogg",
                   "oga:metal-impact-sounds/clink1_0.wav", "oga:metal-impact-sounds/clink2.wav",
                   "oga:metal-impact-sounds/bing1.wav"], "whole", maxdur=1.0, fout=0.2)
ev("impact_glass", "ballistics", 0.5, ref=5, maxd=120)
R("impact_glass", ["oga:75-cc0-breaking-falling-hit-sfx/bfh1_glass_hit_01.ogg",
                   "oga:75-cc0-breaking-falling-hit-sfx/bfh1_glass_hit_02.ogg",
                   "oga:75-cc0-breaking-falling-hit-sfx/bfh1_glass_breaking_01.ogg",
                   "oga:75-cc0-breaking-falling-hit-sfx/bfh1_glass_breaking_03.ogg"], "whole", maxdur=1.2)
ev("impact_flesh", "ballistics", 0.5, ref=4, maxd=60, note="non-gory body hit thud")
R("impact_flesh", ["oga:super-foley-pack/chest_hit.wav"], "split", thr=-30, maxdur=0.5, pick=[0, 1, 2, 3, 4, 6])
R("impact_flesh", ["oga:super-foley-pack/leather_hits.wav"], "split", thr=-30, maxdur=0.4)
R("impact_flesh", ["oga:fps-placeholder-sounds/bodyimpact_jack_01.wav"], "whole", maxdur=0.5)
ev("impact_armor", "ballistics", 0.8, ref=10, maxd=500, note="heavy round / shrapnel hitting vehicle armour")
R("impact_armor", ["fsd:209772", "fsd:414848", "fsd:396940", "fsd:400832", "fsd:403313"], "whole", maxdur=2.0)
R("impact_armor", ["oga:metal-clang-sounds/clang - Marker #1.wav", "oga:metal-clang-sounds/clang - Marker #4.wav",
                   "oga:metal-clang-sounds/clang - Marker #8.wav"], "whole", maxdur=1.5)
ev("shell_casing", "ballistics", 0.3, ref=3, maxd=30)
R("shell_casing", ["fsd:337233"], "split", thr=-30, gap=0.12, maxdur=0.7, pick=list(range(0, 12)))
R("shell_casing", ["fsd:158993", "fsd:158997"], "whole", maxdur=1.0)
R("shell_casing", ["oga:red-eclipse-sounds/sounds/sfx/shell.ogg", "oga:red-eclipse-sounds/sounds/sfx/shell2.ogg",
                   "oga:red-eclipse-sounds/sounds/sfx/shell3.ogg"], "whole")

# ---- explosions -------------------------------------------------------------
ev("explosion_small", "explosions", 1.0, ref=15, maxd=1500, note="grenade / RPG warhead")
R("explosion_small", ["fsd:256300", "fsd:256296", "fsd:108641", "fsd:251759", "fsd:182431", "fsd:67474", "fsd:67470"],
  "whole", maxdur=4.0, fout=0.6)
R("explosion_small", ["fsd:189778"], "split", thr=-24, gap=0.1, maxdur=2.2)
R("explosion_small", ["fsd:156896"], "slice", slices=[(6.3, 9.7)], fout=0.6)
ev("explosion_medium", "explosions", 1.0, ref=25, maxd=3000, note="HE shell / mortar impact")
R("explosion_medium", ["fsd:162261"], "slice", slices=[(0.0, 1.3)], fout=0.4)
R("explosion_medium", ["fsd:182429", "fsd:174281", "fsd:114046", "fsd:114049", "fsd:426163", "fsd:426164",
                       "fsd:132929"], "whole", maxdur=5.0, fout=1.0)
ev("explosion_large", "explosions", 1.0, ref=40, maxd=5000, note="vehicle ammo cook-off / heavy shell")
R("explosion_large", ["fsd:114048", "fsd:114050", "fsd:114047", "fsd:265625", "fsd:231765", "fsd:367622",
                      "oga:2-high-quality-explosions/explosions/explode.wav"], "whole", maxdur=7.0, fout=1.5)
ev("explosion_far", "explosions", 0.9, spatial=False, note="distant impacts / booms for the battle bed")
R("explosion_far", ["fsd:434423", "fsd:434424", "fsd:434425", "fsd:434426", "fsd:434427", "fsd:434429", "fsd:434430",
                    "fsd:108640", "fsd:156500", "fsd:156499", "fsd:86291", "fsd:147584", "fsd:426165", "fsd:426167",
                    "oga:muffled-distant-explosion/NenadSimic - Muffled Distant Explosion.wav"], "whole", maxdur=7.0,
  fout=1.5)
ev("incoming_whistle", "explosions", 0.8, ref=20, maxd=800, note="falling shell whistle; play ~2-4 s before impact")
R("incoming_whistle", ["oga:drop-bomb-pack-sounds/dropbomb-2seconds.mp3", "oga:drop-bomb-pack-sounds/dropbomb-3seconds.mp3",
                       "oga:drop-bomb-pack-sounds/dropbomb-4seconds.mp3"], "whole", fout=0.05)
ev("debris", "explosions", 0.7, ref=10, maxd=400, note="falling rubble / debris rain")
R("debris", ["oga:75-cc0-breaking-falling-hit-sfx/bfh1_rock_falling_0%d.ogg" % i for i in range(1, 10)], "whole", maxdur=3.0)
R("debris", ["oga:falling-rock/Falling Rock.wav", "oga:cave-in/cave_in_-_starninjas_0.ogg", "fsd:321143"], "whole",
  maxdur=5.0)
ev("collapse", "explosions", 1.0, ref=30, maxd=3000, note="building section collapse (composite)")
R("collapse", [], "fn", fn="collapse", n=4)
ev("glass_break", "explosions", 0.7, ref=8, maxd=300)
R("glass_break", ["fsd:219846", "fsd:219845", "fsd:219847", "fsd:219940", "fsd:389804", "fsd:245410", "fsd:336425",
                  "fsd:390706", "fsd:390721", "oga:glass-break/glass_breaking.wav"], "whole", maxdur=3.0)

# ---- vehicles ---------------------------------------------------------------
ev("btr_engine_idle", "vehicles", 0.6, loop=True, ref=10, maxd=600, note="wheeled APC diesel idle")
R("btr_engine_idle", ["fsd:186936"], "loop", start=0.0, end=7.6, xfade=1.0)
ev("btr_engine_drive", "vehicles", 0.75, loop=True, ref=12, maxd=900, note="wheeled APC diesel under load")
R("btr_engine_drive", ["fsd:406194"], "loop", start=8.0, end=17.0, xfade=1.5)
ev("btr_engine_drive_b", "vehicles", 0.75, loop=True, ref=12, maxd=900, note="alt: truck diesel cruising")
R("btr_engine_drive_b", ["fsd:54909"], "loop", start=0.5, end=11.5, xfade=1.5)
ev("tank_engine_idle", "vehicles", 0.7, loop=True, ref=12, maxd=900, note="tank diesel idle")
R("tank_engine_idle", ["fsd:200303"], "loop", start=0.0, end=5.0, xfade=0.8)
ev("tank_engine_drive", "vehicles", 0.85, loop=True, ref=15, maxd=1200, note="tank engine under load")
R("tank_engine_drive", ["fsd:187676"], "loop", start=0.0, end=5.7, xfade=0.8)
ev("tank_engine_drive_fast", "vehicles", 0.85, loop=True, ref=15, maxd=1200, note="alt: heavy engine fast")
R("tank_engine_drive_fast", ["oga:engine-loop-heavy-vehicletank/engine-loop-heavy-pack/WAV/faster_speeds/engine_heavy_fast_loop.wav"],
  "loop", start=0.0, end=2.42, xfade=0.3)
ev("engine_start", "vehicles", 0.8, ref=12, maxd=800)
R("engine_start", ["fsd:256808"], "whole", maxdur=8.0, fout=1.0)
ev("track_clank", "vehicles", 0.6, loop=True, ref=10, maxd=600, note="tank track link clatter loop (composite); scale playbackRate with speed")
R("track_clank", [], "fn", fn="track_loop")
ev("turret_traverse", "vehicles", 0.5, loop=True, ref=6, maxd=200, note="hydraulic/electric traverse whine loop")
R("turret_traverse", ["fsd:340686"], "loop", start=3.0, end=9.0, xfade=1.0, pitch=[1.15])
ev("servo_stop", "vehicles", 0.4, ref=5, maxd=150)
R("servo_stop", ["fsd:18724", "fsd:18725", "fsd:18726"], "whole")
ev("hatch", "vehicles", 0.7, ref=6, maxd=200, note="hatch / door clang")
R("hatch", ["fsd:406197", "fsd:48980", "fsd:241829", "fsd:153362", "oga:100-cc0-metal-and-wood-sfx/metal_slam_01.ogg",
            "oga:100-cc0-metal-and-wood-sfx/metal_close_01.ogg"], "whole", maxdur=2.5)
ev("fire_vehicle_loop", "vehicles", 0.8, loop=True, ref=8, maxd=400, note="large burning vehicle")
R("fire_vehicle_loop", ["fsd:387924"], "loop", start=1.0, end=19.0, xfade=2.0)

# ---- foley ------------------------------------------------------------------
ev("footstep_rubble", "foley", 0.35, ref=3, maxd=50)
R("footstep_rubble", ["fsd:401346"], "split", thr=-30, gap=0.1, maxdur=0.5, pick=[0, 1, 2, 3, 4, 5, 6, 7])
R("footstep_rubble", ["fsd:321543"], "split", thr=-30, gap=0.1, maxdur=0.5, pick=[0, 2, 4, 6, 8, 10, 12, 14])
ev("footstep_concrete", "foley", 0.3, ref=3, maxd=50)
R("footstep_concrete", ["fsd:273117"], "split", thr=-30, gap=0.08, maxdur=0.4, pick=list(range(1, 25, 2)))
ev("footstep_gravel", "foley", 0.3, ref=3, maxd=50)
R("footstep_gravel", ["oga:footsteps-on-different-surfaces/footsteps/gravel/%d.ogg" % i for i in range(10)], "whole",
  maxdur=0.6)
ev("gear_rattle", "foley", 0.3, ref=3, maxd=40, note="webbing / kit rattle while moving")
R("gear_rattle", ["fsd:405043"], "split", thr=-30, gap=0.15, maxdur=1.2, pick=[0, 1, 2, 3, 4, 5, 7, 9])
R("gear_rattle", ["fsd:396429"], "whole", maxdur=1.8)
R("gear_rattle", ["oga:equipment-clicks-ii/equipmentclicks.wav"], "split", thr=-30, gap=0.2, maxdur=1.0)
ev("body_fall", "foley", 0.6, ref=5, maxd=80)
R("body_fall", ["fsd:346692", "fsd:346693", "fsd:346694", "fsd:346695", "fsd:187136"], "whole", maxdur=1.8)
R("body_fall", ["oga:super-foley-pack/body_hit_on_ground.wav"], "split", thr=-30, maxdur=0.8)

# ---- human ------------------------------------------------------------------
ev("pain", "human", 0.6, ref=5, maxd=120, note="short hit / pain grunt (non-verbal)")
R("pain", ["oga:15-vocal-male-strainhurtpainjump-sounds/slightscream-%02d.flac" % i for i in range(1, 16)], "whole",
  maxdur=1.5)
R("pain", ["oga:11-male-human-paindeath-sounds/player/pain%d.wav" % i for i in range(1, 7)], "whole", maxdur=1.5)
R("pain", ["oga:pain-sounds-by-emopreben/Painsounds v2 - Track %d - %s.ogg" % t for t in
           [(1, "Arrrch"), (2, "Hurgh"), (3, "Huuurh"), (4, "Arrggh "), (5, "Urggh")]], "whole", maxdur=1.5)
ev("wounded", "human", 0.5, ref=5, maxd=80, note="wounded groans / moans (tasteful, non-verbal)")
R("wounded", ["fsd:171758"], "whole", maxdur=5.0, fout=0.5)
R("wounded", ["fsd:128227"], "split", thr=-30, gap=0.4, maxdur=2.0)
R("wounded", ["oga:grunts-male-death-and-pain/death pain grunts.wav"], "split", thr=-30, gap=0.4, maxdur=3.0,
  pick=[1, 4, 5, 6, 7, 8])
ev("death", "human", 0.6, ref=5, maxd=100, note="death cry (short, non-gory)")
R("death", ["oga:11-male-human-paindeath-sounds/player/die1.wav", "oga:11-male-human-paindeath-sounds/player/die2.wav",
            "oga:11-male-human-paindeath-sounds/player/deathh.wav", "fsd:169747"], "whole", maxdur=2.5)
ev("shout", "human", 0.7, ref=8, maxd=200, note="non-verbal battle shouts / yells")
R("shout", ["fsd:323079", "fsd:323080", "fsd:323081", "fsd:323082", "fsd:323083", "fsd:323084", "fsd:249807",
            "fsd:144337", "fsd:149825", "fsd:220311", "fsd:220307"], "whole", maxdur=2.5)
ev("curse_ru", "human", 0.6, ref=8, maxd=150, note="optional: Russian swear exclamations (CC0); calm 'well... sh*t' delivery")
R("curse_ru", ["oga:russian-swears-male-voice-pack/Russian Swears Voice Pack/%s" % f for f in
               ["ru_swears_0001_fail_блять!.mp3", "ru_swears_0006_fail_сука!.mp3", "ru_swears_0007_fail_бля!.mp3",
                "ru_swears_0009_fail_пиздец!.mp3", "ru_swears_0004_fail_охуеть!.mp3"]], "whole", maxdur=2.0)

# ---- ambience ---------------------------------------------------------------
ev("ambience_wind", "ambience", 0.5, loop=True, spatial=False, note="stereo wind bed")
R("ambience_wind", ["oga:mild-wind-background-noise/wind background noise 2.wav"], "loop", start=10, end=55, xfade=4,
  stereo=True, target=-26)
ev("ambience_wind_gusty", "ambience", 0.5, loop=True, spatial=False, note="stronger gusting wind")
R("ambience_wind_gusty", ["fsd:400992"], "loop", start=0.2, end=10.6, xfade=2.5, target=-26)
ev("ambience_city", "ambience", 0.6, loop=True, spatial=False,
   note="war-torn city bed: wind + distant gunfire/artillery + crows (composite, stereo)")
R("ambience_city", [], "fn", fn="city_bed", seconds=64, density=1.0)
ev("ambience_battle", "ambience", 0.6, loop=True, spatial=False, note="denser distant battle bed (composite, stereo)")
R("ambience_battle", [], "fn", fn="city_bed", seconds=64, density=2.6, seed=7)
ev("fire_loop", "ambience", 0.6, loop=True, ref=5, maxd=150, note="small fire crackle")
R("fire_loop", ["fsd:394754"], "loop", start=2.0, end=24.0, xfade=2.0)
ev("fire_loop_b", "ambience", 0.6, loop=True, ref=5, maxd=150)
R("fire_loop_b", ["oga:fire-loop/qubodupFireLoop.flac"], "loop", start=0.0, end=None, xfade=1.0)
ev("crow", "ambience", 0.4, ref=20, maxd=400, note="crow / raven caws")
R("crow", ["fsd:182090"], "split", thr=-30, gap=0.1, maxdur=2.0)
R("crow", ["fsd:54973", "oga:crow-caw/crow_caw.wav", "oga:crow/crow_0.ogg", "fsd:389609"], "whole", maxdur=3.0)
ev("radio", "ambience", 0.5, ref=3, maxd=40, note="radio squelch / chatter-less transmissions")
R("radio", ["oga:transmission/transmissionStart.wav", "oga:transmission/transmissionEnd.wav", "oga:radio-call/radiocall.wav",
            "fsd:161347"], "whole", maxdur=3.0)
R("radio", ["oga:static/ScatterNoise1.mp3"], "whole", maxdur=2.0)
ev("radio_static", "ambience", 0.35, loop=True, ref=3, maxd=30)
R("radio_static", ["oga:radio-noise-1/radio_noise_loop.wav"], "loop", start=2.0, end=14.0, xfade=1.0)
ev("siren_air_raid", "ambience", 0.5, loop=True, spatial=False, note="distant air-raid siren")
R("siren_air_raid", ["fsd:262278"], "loop", start=1.0, end=21.5, xfade=3.0, target=-24)

# ---- UI ---------------------------------------------------------------------
ev("ui_click", "ui", 0.5, spatial=False)
R("ui_click", ["oga:51-ui-sound-effects-buttons-switches-and-clicks/click%d.wav" % i for i in range(1, 6)] +
  ["oga:51-ui-sound-effects-buttons-switches-and-clicks/mouseclick1.wav"], "whole", target=-20, mono_ok=False)
ev("ui_select", "ui", 0.5, spatial=False, note="unit selected")
R("ui_select", ["oga:51-ui-sound-effects-buttons-switches-and-clicks/switch%d.wav" % i for i in (1, 3, 7, 13, 19, 28)],
  "whole", target=-20)
ev("ui_order", "ui", 0.5, spatial=False, note="order acknowledged (radio-style blip)")
R("ui_order", ["oga:interface-beeps/Beeps/beep-%02d.wav" % i for i in (1, 3, 5, 8, 11)], "whole", target=-20)
ev("ui_hover", "ui", 0.3, spatial=False)
R("ui_hover", ["oga:51-ui-sound-effects-buttons-switches-and-clicks/rollover%d.wav" % i for i in range(1, 7)], "whole",
  target=-22)
ev("ui_alert", "ui", 0.6, spatial=False, note="unit under attack / warning")
R("ui_alert", ["oga:6-user-interface-ding-clicks/dingClicks/dingCling-negative.ogg",
               "oga:gui-sound-effects/GUI_Sound_Effects_by_Lokif/negative.wav",
               "oga:gui-sound-effects/GUI_Sound_Effects_by_Lokif/negative_2.wav",
               "oga:interface-beeps/Beeps/beep-14.wav"], "whole", target=-18)
ev("ui_error", "ui", 0.5, spatial=False)
R("ui_error", ["oga:gui-sound-effects/GUI_Sound_Effects_by_Lokif/misc_menu_4.wav"], "whole", target=-20)
ev("victory", "ui", 0.8, spatial=False, note="victory stinger")
R("victory", ["oga:orchestral-stinger-dramatic-entrance/orchestral_stinger_dramatic_entrance.wav",
              "oga:won-orchestral-winning-jingle/Won!.wav", "oga:win-jingle/WinBrass.wav"], "whole", stereo=True,
  target=-16, fout=0.8)
ev("defeat", "ui", 0.8, spatial=False, note="defeat stinger")
R("defeat", ["oga:the-chaos-has-risen/The Chaos Has Risen.wav", "oga:realization/MS_Realization.wav"], "whole",
  stereo=True, target=-18, fout=1.5, maxdur=12.0)

# default loudness targets per category (one-shots: max momentary LUFS; loops: integrated)
TARGET = dict(weapons=-16, ballistics=-17, explosions=-16, vehicles=-20, foley=-20, human=-18, ambience=-24, ui=-18)
STEREO_CATS = {"ambience", "ui"}


# ----------------------------------------------------------------------------- composites
def _load(spec):
    p, c = sources.resolve(spec)
    return dsp.load(p), c


def comp_collapse(n=4, **_):
    """Building collapse: low rumble + falling masonry + concrete slab impacts + glass."""
    rumble, c1 = _load("oga:rumble-fx/rumble.wav")
    shake, c2 = _load("oga:earthquake-and-open-sesame/shake.flac")
    falls = [_load("oga:75-cc0-breaking-falling-hit-sfx/bfh1_rock_falling_0%d.ogg" % i) for i in (1, 3, 5, 7, 8, 9)]
    blocks, c3 = _load("fsd:93959")
    bsegs = dsp.segments(blocks, thr=-26, min_gap=0.1)
    glass, c4 = _load("fsd:321143")
    credits = [c1, c2, c3, c4] + [f[1] for f in falls]
    outs = []
    for k in range(n):
        rng = np.random.default_rng(100 + k)
        L = int(6.5 * SR)
        y = np.zeros(L)
        r0 = int(rng.uniform(0, max(1, len(rumble) - L)))
        rb = dsp.butter(rumble[r0:r0 + L], "low", 400)
        y[:len(rb)] += rb * np.hanning(len(rb)) * 0.9
        sh = shake[: L]
        y[:len(sh)] += dsp.butter(sh, "low", 1500) * 0.5
        t = int(0.2 * SR)
        for j in range(6):
            a, b = bsegs[int(rng.integers(len(bsegs)))]
            s = blocks[a:min(b, a + int(1.2 * SR))] * rng.uniform(0.4, 1.0)
            pos = t + int(rng.uniform(0, 3.5) * SR)
            y[pos:pos + len(s)] += s[: L - pos]
        for j in range(4):
            f = falls[int(rng.integers(len(falls)))][0]
            pos = int(rng.uniform(0.3, 4.0) * SR)
            y[pos:pos + len(f)] += f[: L - pos] * rng.uniform(0.5, 1.0)
        if k % 2 == 0:
            pos = int(rng.uniform(0.5, 2.0) * SR)
            g = glass[: int(3 * SR)]
            y[pos:pos + len(g)] += g[: L - pos] * 0.35
        y = dsp.fade(y, 0.01, 1.5)
        outs.append(y)
    return outs, credits


def comp_track_loop(**_):
    """Track clatter: periodic link impacts (metal clinks/clanks) over a chain rattle bed, 4 s period."""
    winch, c1 = _load("oga:chain-winch-sounds/winch - Region #1.wav")
    clinks = [_load(s) for s in ["oga:metal-impact-sounds/clink1_0.wav", "oga:metal-impact-sounds/clink2.wav",
                                 "oga:metal-impact-sounds/clink3.wav", "oga:metal-impact-sounds/thud2.wav",
                                 "oga:metal-impact-sounds/thud3.wav",
                                 "oga:100-cc0-metal-and-wood-sfx/metal_hit_01.ogg",
                                 "oga:100-cc0-metal-and-wood-sfx/metal_hit_03.ogg"]]
    credits = [c1] + [c for _, c in clinks]
    rng = np.random.default_rng(5)
    P = 4.0
    L = int(P * SR)
    y = np.zeros(L + SR)
    # chain bed: tile winch rattle
    w = dsp.butter(winch, "high", 300)
    pos = 0
    while pos < len(y):
        seg = w[: min(len(w), len(y) - pos)]
        y[pos:pos + len(seg)] += dsp.fade(seg, 0.05, 0.05) * 0.35
        pos += max(len(seg) - int(0.05 * SR), int(0.1 * SR))
    rate = 7.0  # link impacts per second (~walking-pace tank)
    t = 0.0
    while t < P:
        x, _ = clinks[int(rng.integers(len(clinks)))]
        x = dsp.resample_factor(x[: int(0.35 * SR)], rng.uniform(0.6, 0.85))  # heavier
        p = int(t * SR)
        y[p:p + len(x)] += dsp.fade(x, 0.001, 0.08) * rng.uniform(0.35, 0.8)
        t += 1.0 / rate * rng.uniform(0.85, 1.15)
    # wrap tail into head for periodicity
    y[:SR] += y[L:L + SR]
    y = y[:L]
    y = dsp.butter(y, "low", 6000)
    return [y], credits, True


def comp_city_bed(seconds=64, density=1.0, seed=3, **_):
    """Stereo war-torn city bed: wind + sparse distant small-arms, MG, artillery + crows. Periodic (loopable)."""
    rng = np.random.default_rng(seed)
    L = int(seconds * SR)
    wind, cw = _load("oga:mild-wind-background-noise/wind background noise 2.wav")
    wind2, cw2 = _load("fsd:400992")
    credits = [cw, cw2]
    # base: two wind takes decorrelated L/R
    def tile(x, n, off):
        x = np.roll(x, -off)
        reps = int(np.ceil(n / len(x))) + 1
        return np.tile(x, reps)[:n]
    wl = tile(wind, L, 0)
    wr = tile(wind, L, len(wind) // 3)
    w2 = tile(dsp.butter(wind2, "low", 1200), L, 0)
    bed = np.stack([wl + 0.5 * w2, wr + 0.5 * np.roll(w2, SR * 3)], axis=1) * 0.5
    ev_srcs = {
        "rifle": ["ffsl:AK-47/C_31P.wav", "ffsl:AK-47/C_34P.wav", "ffsl:SKS/U_19P.wav"],
        "mg": ["fsd:160773", "fsd:417688"],
        "boom": ["fsd:434423", "fsd:434425", "fsd:434427", "fsd:434430", "fsd:108640", "fsd:86291", "fsd:156499"],
        "crow": ["fsd:182090", "fsd:54973"],
    }
    clips = {}
    for k, specs in ev_srcs.items():
        clips[k] = []
        for s in specs:
            x, c = _load(s)
            credits.append(c)
            for a, b in dsp.segments(x, thr=-28, min_gap=0.25)[:6]:
                clips[k].append(x[a:min(b, a + int(4 * SR))])
    layer = np.zeros((L + 8 * SR, 2))
    plan = {"rifle": (6, 0.05, VFAR), "mg": (4, 0.06, VFAR), "boom": (5, 0.35, None), "crow": (3, 0.08, None)}
    for k, (n, g, far) in plan.items():
        cnt = int(round(n * (density if k != "crow" else 1.0)))
        for _ in range(cnt):
            x = clips[k][int(rng.integers(len(clips[k])))]
            if far:
                x = dsp.distant(x, **far)
            elif k == "boom":
                x = dsp.butter(x, "low", 700)
            x = x / (np.max(np.abs(x)) + 1e-9)
            pan = rng.uniform(-0.8, 0.8)
            p = int(rng.uniform(0, seconds) * SR)
            gl, gr = np.sqrt((1 - pan) / 2), np.sqrt((1 + pan) / 2)
            gg = g * rng.uniform(0.5, 1.0)
            layer[p:p + len(x), 0] += x * gl * gg
            layer[p:p + len(x), 1] += x * gr * gg
    layer[:8 * SR] += layer[L:L + 8 * SR]  # wrap -> periodic
    y = bed + layer[:L]
    return [y], credits, True


COMPOSITES = {"collapse": comp_collapse, "track_loop": comp_track_loop, "city_bed": comp_city_bed}


# ----------------------------------------------------------------------------- processing
def n_channels(path):
    import subprocess
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout.strip()
    return int(out or 1)


START_DB = dict(explosions=-25, foley=-20)


def finish_oneshot(x, cat, r):
    x = dsp.trim(x, start_db=r.get("start_db", START_DB.get(cat, -40)), end_db=r.get("tail_trim", -55))
    if len(x) < int(0.03 * SR):
        return None
    if r.get("maxdur"):
        x = x[: int(r["maxdur"] * SR)]
    x = dsp.fade(x, r.get("fin", 0.002), r.get("fout", min(0.12, len(x) / SR * 0.25)))
    return x


def process(r):
    key = r["key"]
    cat = EVENTS[key]["category"]
    is_loop = EVENTS[key]["loop"]
    stereo = r.get("stereo", cat in STEREO_CATS and not EVENTS[key]["spatial"])
    target = r.get("target", TARGET[cat])
    results = []  # (signal, credits, loopinfo)

    if r["op"] == "fn":
        out = COMPOSITES[r["fn"]](**{k: v for k, v in r.items() if k not in ("key", "specs", "op", "fn")})
        sigs, credits = out[0], out[1]
        periodic = len(out) > 2 and out[2]
        for s in sigs:
            results.append((s, credits, periodic))
    else:
        for spec in r["specs"]:
            path, credit = sources.resolve(spec)
            ch = 2 if (stereo and r["op"] in ("loop", "whole") and n_channels(path) >= 2) else 1
            x = dsp.load(path, channels=ch)
            if x.ndim == 2 and np.max(np.abs(x[:, 0] - x[:, 1])) < 1e-3 * (np.max(np.abs(x)) + 1e-9):
                x = x.mean(axis=1)  # dual-mono source -> mono
            if r.get("hp"):
                x = dsp.butter(x, "high", r["hp"])
            if r["op"] == "loop":
                end = r.get("end") or len(x) / SR
                end = min(end, len(x) / SR)
                lp = dsp.make_loop(x, r.get("start", 0), end, r.get("xfade", 0.5))
                results.append((lp, [credit], True))
                continue
            pieces = []
            if r["op"] == "whole":
                pieces = [x]
            elif r["op"] == "slice":
                pieces = [x[int(a * SR):int(b * SR)] for a, b in r["slices"]]
            elif r["op"] == "split":
                segs = dsp.segments(x, thr=r.get("thr", -28), min_gap=r.get("gap", 0.15),
                                    tail_db=r.get("tail", -50), maxdur=r.get("maxdur"))
                if r.get("pick") is not None:
                    segs = [segs[i] for i in r["pick"] if i < len(segs)]
                pieces = [x[a:b] for a, b in segs]
            for p in pieces:
                results.append((p, [credit], False))

    outs = []
    for sig, credits, periodic in results:
        variants = [sig]
        if r.get("pitch"):
            variants = [dsp.resample_factor(sig, f) for f in r["pitch"]]
        for v in variants:
            if periodic or is_loop:
                if r.get("far"):
                    v = dsp.distant(v, **(FAR if r["far"] is True else r["far"]))
                v, _ = dsp.normalize(v, target, mode="integrated", ceiling_db=-3.0)
                v, ls, le = dsp.pad_loop(v, 0.25)
                outs.append((v, credits, (round(ls, 6), round(le, 6))))
            else:
                if r.get("far"):
                    v = dsp.mono(v)
                    v = dsp.trim(v, -40, -60)
                    v = dsp.distant(v, **(FAR if r["far"] is True else r["far"]))
                v = finish_oneshot(v, cat, r)
                if v is None:
                    continue
                v, _ = dsp.normalize(v, target, mode="momentary", ceiling_db=-3.0 if cat == "ui" else -2.0)
                outs.append((v, credits, None))
    return outs


def qc(x, name):
    m = dsp.mono(x)
    dur = len(m) / SR
    pk = dsp.peak_db(m)
    rms = 10 * np.log10(np.mean(m ** 2) + 1e-12)
    issues = []
    if dur < 0.02:
        issues.append("too short")
    if pk < -30:
        issues.append("near-silent")
    if np.mean(np.abs(m) > 0.999) > 0.001:
        issues.append("clipping")
    return dict(dur=round(dur, 3), peak=round(pk, 1), rms=round(rms, 1), issues=issues)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--clean", action="store_true")
    a = ap.parse_args()
    only = set(filter(None, a.only.split(",")))
    manifest_p = OUT / "manifest.json"
    credits_p = OUT / "credits.json"
    manifest = json.load(open(manifest_p)) if manifest_p.exists() and only else {}
    allcred = json.load(open(credits_p)) if credits_p.exists() and only else {}
    if a.clean and not only:
        for d in OUT.glob("*/"):
            shutil.rmtree(d)
    keys = [k for k in EVENTS if not only or k in only]
    report = []
    for key in keys:
        cat = EVENTS[key]["category"]
        (OUT / cat).mkdir(parents=True, exist_ok=True)
        for old in (OUT / cat).glob(f"{key}_[0-9][0-9].mp3"):
            old.unlink()
        for k in list(allcred):
            if k.startswith(f"{cat}/{key}_") and k[len(cat) + len(key) + 2:-4].isdigit():
                del allcred[k]
        outs = []
        for r in [r for r in RECIPES if r["key"] == key]:
            outs += process(r)
        files = []
        loopinfo = None
        for i, (sig, creds, li) in enumerate(outs, 1):
            name = f"{cat}/{key}_{i:02d}.mp3"
            q = qc(sig, name)
            if q["issues"]:
                report.append((name, q))
                print("QC FAIL", name, q)
                continue
            # encode; if the decoded MP3 overshoots (inter-sample / lowpass ringing), pull gain down and redo
            for _ in range(4):
                dsp.encode_mp3(sig, OUT / name, quality=4)
                dec = dsp.load(OUT / name, channels=1 if sig.ndim == 1 else 2)
                over = dsp.peak_db(dec) - (-1.0)
                if over <= 0:
                    break
                sig = sig * 10 ** (-(over + 0.3) / 20)
            files.append(name)
            allcred[name] = dict(sources=creds, dur=q["dur"], channels=1 if sig.ndim == 1 else 2,
                                 processed=True)
            if li:
                loopinfo = li
            report.append((name, q))
        e = dict(EVENTS[key])
        mf = e.pop("max_files", None)
        if mf and len(files) > mf:
            keep = set(np.linspace(0, len(files) - 1, mf).round().astype(int))
            for j, f in enumerate(files):
                if j not in keep:
                    (OUT / f).unlink()
                    allcred.pop(f, None)
            files = [f for j, f in enumerate(files) if j in keep]
        e["files"] = files
        if e["loop"] and loopinfo:
            e["loopStart"], e["loopEnd"] = loopinfo
        manifest[key] = e
        print(f"{key:24} {len(files):3d} files")
    manifest = {k: manifest[k] for k in EVENTS if k in manifest}
    json.dump(manifest, open(manifest_p, "w"), indent=1, ensure_ascii=False)
    json.dump(allcred, open(credits_p, "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main()
