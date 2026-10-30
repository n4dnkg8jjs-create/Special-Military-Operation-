# Research notes

Reference facts the game data is built on. Values are rounded and then tuned for play; see `src/config.js`.

## Identification
- Ukrainian troops widely wore **yellow** (later also blue/green) tape armbands for friend-or-foe identification;
  Russian forces used **white** cloth/tape bands, later also **red**. — Wikipedia, *Combat identification*; Combat Threads Vol. 02 No. 02.
- In-game: UA = yellow tape on both upper arms (+ leg band on some), RU = white tape (red as an alternate material).

## Russian infantry kit (Ratnik)
- **6B45** is the standard Ratnik combined-arms vest (≈7.5–8 kg, Granit ceramic plates front/back, MOLLE).
  **6B46** is the lighter plate-carrier-style variant for light units. — Wikipedia, *Ratnik (program)*, *6B45 ballistic vest*.
- **6B47** helmet with cover, **6Sh117** load-bearing pouches. — Army Recognition; Live Resin figure review.
- Uniform camouflage: EMR ("tsifra") digital.

## Ukrainian infantry kit
- MM-14 pixel camouflage uniforms (with widespread Western Multicam), JPC-style plate carriers, FAST/MICH-type helmets.

## Vehicles
- **BTR-82A**: 8×8 APC, BPPU turret with 30 mm 2A72 autocannon + 7.62 mm PKTM; side doors between 2nd and 3rd axles.
- **BTR-80**: BPU-1 turret with 14.5 mm KPVT + 7.62 mm PKT.
- **T-72B3**: 125 mm 2A46M-5, Kontakt-5 ERA, Sosna-U sight; carousel autoloader with 22 ready rounds (≈7 s cycle).
  Field-added "cope cages" common from 2022.
- **T-72AV**-type with Kontakt-1 bricks for the Ukrainian side.
- Armour values in `config.js` are simplified RHA-equivalents by facing vs kinetic (KE) and chemical (CE) rounds.

## City
- Soviet large-panel series (1-464, 1-468, II-49 …): 5- and 9-storey blocks, ~3.2 m panel module, ~2.7–2.8 m floor height,
  4 entrances on the courtyard side, balconies on the street side. The game builds blocks from this module grid, which is
  also what makes per-panel dynamic damage possible.

## Audio
See `docs/AUDIO_CREDITS.md` — CC0 / CC-BY / CC-BY-SA material from OpenGameArt, the Free Firearm Sound Library and
Freesound clips via the FSD50K dataset; every file is credited.

## Motion capture
CMU Graphics Lab Motion Capture Database (free for any use), played on the MakeHuman `cmu_mb` skeleton.
