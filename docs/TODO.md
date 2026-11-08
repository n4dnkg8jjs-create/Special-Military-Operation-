# Backlog (deferred to save usage)

- **Tanks look wrong**: rebuild the T-72B3 (RU) and T-72AV (UA) from photos + scale drawings (spec first, photo-calibrated camera, reference | old | new comparisons) — same process as the BTR-82A (previews/models_v17).
- **BTR anti-drone cages**: research what BTR-82A / BTR-80 cages and screens really looked like in 2023-24 and make vehicleKit's BTR cage match a common real configuration.
- **Medevac driver pull-out animation**: two matched clips — a medic reaching in, grabbing the dead driver and hauling him out of the cab; the driver's body coming out of the seat and falling to the ground. Replace the placeholder in src/game/medevac.js (pullTick: drag_wounded clip at half speed + seated body slid out).
- **Window glass z-fighting**: BTR-80/82A windscreen frames and one Bradley vision block have glass coplanar with the frame (same fix as the headlight lenses).
- **Riders vs BTR-82A turret**: the photo-accurate rear box sweeps the front side riders (margin ~0); move ride_seat_1/2 out a little if it shows in game.
