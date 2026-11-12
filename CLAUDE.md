# Special Military Operation — continuation notes for Claude Code

Browser RTS (Three.js r187, WebGL2, no build step, ES modules + importmap in index.html) set in the Russo-Ukrainian war.
Company-level battles: infantry squads, BTR / BMP / Bradley / T-72s, FPV drones, artillery, medevac, campaign, P2P multiplayer.
Repo: github.com/n4dnkg8jjs-create/special-military-operation- (main; GitHub Pages serves main, so a push = live).

## How the owner works (follow these)
- Owner tests in the browser and reports bugs with phone photos. Keep YOUR testing minimal (a load/smoke run, a screenshot when
  a visual change needs checking). They are usage-limited: be efficient, don't spawn more than ONE helper agent at a time,
  prefer doing it yourself. Don't add extra features they didn't ask for.
- Realism + research: Avdiivka / Robotyne are real places (OSM data) during the 2023-24 battles. Research (web) before
  inventing details; cite briefly in the reply when it answers a "is this realistic?" question.
- Show pictures of visual results (send the image) and push as you go: commit + push to main after each finished fix.
- Commit messages: one dense line ("Area vN: what changed and why"), then blank line + co-author trailer if your tool uses one.
- Never put personal data (the owner's email etc.) into requests/URLs/User-Agents. No paid services/credentials without asking.
- Owner rejects: floating objects, z-fighting/flicker, clipping, things intersecting roads/tracks/trenches, "un-organic"
  animation, inaccurate vehicle shapes, UI that looks "Roblox" (style is dark, WARNO-like, cinematic), war clutter on streets.

## Running / testing
- Serve the repo root (`npx serve .`) and open index.html. URL params: `?autostart&map=<city|farmland|robotyne|avdiivka>&quality=<low|medium|high>`,
  `?aiold` (v1 AI). `window.game` is exposed (game.city = world, game.squads, game.vehicles, game.cam, game.renderer).
- `node tools/dev/nrb.mjs city,farmland,avdiivka,robotyne 20000` — headless load + N ms of play, prints page errors (needs
  `npm i playwright` + `npx playwright install chromium`). Headless pages crash under memory pressure (big maps ~1.2 GB heap).
- `node tools/dev/shot.mjs <map> <outprefix> "<JS expr returning [[x,z,dist,pitch,yaw],...]>"` — canvas screenshots (Q=low|medium env).
- `node tools/dev/perf_probe.mjs avdiivka medium` — draw calls / triangles / per-mesh triangle breakdown.
- Syntax check a module: `node --input-type=module --check < file.js`.
- NEVER write `//` comments in the middle of a one-line statement/callback (it swallowed code several times) — use `/* */`.
- tools/dev/ed.py (exact OLD====NEW replace in working tree + index), stage_keep.py (stage only matching hunks).

## Code map (src/)
- game/: game.js (loop, phases deploy/battle, spotting tiers, fog), squad.js (orders, mount/dismount/board, medevac care,
  trench routing), soldier.js (anim state, clips, jump/hatch/mount clips), soldierPose.js (procedural layers, twist bones),
  vehicle.js (movement, seats ride_seat_*, doors, lights, RE stern seats ~l.217), armor.js (hit zones + TANK_PARTS),
  combat.js (weapons, explode(), FPV hit quality), ai.js / ai_tactics.js (v2 commander default), support.js (FPV/arty),
  medevac.js (driver swap; pullTick placeholder), campaign*.js, artillery.js.
- fx/: particles.js (GPU billboards: smoke / glow / fire systems, explosion() = flash + burst cloud + earth jets + ground dust +
  column + haze, no shock ring; fragments instanced), flames.js.
- world/: maps.js (map defs incl. Avdiivka ruin knobs `ruins.blocks/houses/craters`), real.js (OSM real maps: roads via
  roadmesh.js merged surfaces + dead-end turning pads, rails (mitred strips, flush in asphalt on roads, Chaikin-smoothed),
  vegetation (offPaved + railGap clearance), houses, garages, pipes, skyline), ruins.js (siege destruction: craters, rubble,
  stumps/logs via logClear, slabs/furniture), battlefieldDetail.js (Robotyne belts, treeFate, _bfTops), city.js (base world,
  crushables chunked per 120 m cell, interior slabs / room boxes), buildings.js (panel kit; room box hidden when a long
  facade panel is gone — onRoomOpen), farmland.js (rural base; skyline blobs kept off-map), terrain.js (relief: craters /
  ditches / mounds; a crater bowl fades other rims and parapets), instancer.js (instance(), LODS, simplified(), farLod()).
- net/: peer.js (direct + relay racing, acks, chunking), battle.js (host-authoritative snapshots, world events).
- ui/: hud.js (dock, unit cards, selection rings drawn depthTest:false), menu.js (cinematic menu), style.css.
- Assets: assets/vehicles/*.glb (+manifest.json, node contract: turret, gun_pivot, muzzle, hatches, ride_seat_*, lights,
  wreck/LOD1 — never rename), assets/soldiers/soldier_anims.glb + manifest.json (125 clips), assets/env/*.glb.

## Asset pipelines (Blender via the `bpy` python module, `python3 -c "import bpy"`)
- Vehicles: tools/blender/vehicles/{t72.py,btr.py,...} → build_all.py / vbuild.py (+ WebP step). BTR-80 UA shares the BTR
  bow only; keep it unchanged when editing the 82A. Check node lists before/after any rebuild.
- Farm/env props: tools/blender/env/build_farmland.py + optimize_farmland.sh (grain-bin ladder fixed there).
- Soldier clips: tools/blender/soldiers/*: clips_vehicle.py (hatch/dismount/jump clips), clips_mount.py (mount_* climbs,
  per-hull TUNE dict), build_anims.py --merge, vehicle_manifest.py, check_anims.py + mount_check.py (must pass:
  bone lengths, joint limits, per-frame rotation ≤14°/frame moving limbs ≤9 trunk/planted, hull penetration ≤0.045 m).
  previews/ is gitignored (helper notes/renders live there locally only).

## State at handoff (Nov 2026)
- Pushed recently: streets v1–v6 (merged roads, junction radii, signs, turning pads, rails), Avdiivka perf v1 (~½ triangles),
  siege v2 destruction, models v18 (T-72B3/AV rebuilt, BTR-82A detail), mount-up v3 (hand-keyed climbs, all 11 clips pass).
- Mount v4 (organic keyframe detail) + v5 (leg swings inside joint limits) pushed — see "Mount v4 / v5 status" at the end of this file.
- Owner Q&A already answered: BTR riders sit on top (8 deck seats); only overflow men go inside (door) — BMP-3 has 7 deck
  seats so the 8th uses the rear doors. Avdiivka tram line ran beside the road (OSM: 5–9 m from road centre), service
  stopped 2015, partly resumed 2016, closed Jan 2017; rails mostly left in place (OSM "disused").
- Open complaints not yet resolved: "Avdiivka doesn't look like Avdiivka" (ask for a specific spot/photo), general lag on
  the owner's machine (measure again after changes), docs/TODO.md backlog.

## Mount v4 / v5 status
- PUSHED (mount v4): organic layer in clips_mount.py on top of the v3 keys (weight shift, anticipation + settle, spine/head/arm
  overlap, varied timing, head look-at, breathing/sway; `ORG['on']=False` = exact v3) + per-man playback rate 0.92–1.08
  (squad.js sets it when the climb starts and stretches the clip timer to match; soldier.js plays the clip at that rate).
- All 11 mount_* clips pass mount_check; check_anims 10/11: mount_deck_rear_t72b3's last frame is 3.6° off ride_sit_edge
  (left hand; pre-existing, hidden by the 0.12 s blend in game).
- Softened layers on mount_deck_tank (T-72AV: no weight shift / arm lag — least lively), BMP-3 (smaller settle), rear BTR
  (right-arm lag only), rear T-72AV (no knee lift).
- Not yet judged by the owner in game. If they still call it un-organic, the next step is changing the choreography
  (v3 key poses), not more layers. Motion capture (CMU) was tried and dropped at the owner's request.
- Mount v5 (leg fix): tools/blender/soldiers/mount_legfix.py re-plans the leg swings of the 9 mount_deck_* clips IN the shipped
  soldier_anims.glb (numpy + scipy only, no body.pkl / Blender): the v3 choreography carried the legs between holds through
  impossible hips (left thigh 70-75 deg out to the side, right thigh 85-105 deg behind the pelvis, trailing leg locked straight).
  Holds, trunk and arms are untouched; only UpLeg / Leg / Foot rotation tracks of flagged swings are rewritten in place, each
  re-plan is kept only if it passes rotation / hull / ground / knee checks. Run it ONCE after any rebuild of the mount clips
  (not idempotent), then mount_check.py. Previews without Blender: `npm i` (three) + link playwright into node_modules, then
  tools/blender/soldiers/pvgame.mjs "page:/tools/blender/soldiers/preview_vehicle.html?clip=...&veh=...&vp=...&vyaw=...&ts=...".
- The on-deck turn-and-sit still has a wide squat on some hulls (feet shuffle there, so most of it is left as authored).
- Scripted UA-city mount test is flaky (one BTR-80 squad sometimes never starts climbing) — cause not found; look at
  squad.js mount entry/arrival logic if the owner reports men not boarding.
