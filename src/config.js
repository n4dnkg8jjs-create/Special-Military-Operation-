// Game data: factions, weapons, unit templates. Values are sourced from public references
// (see docs/RESEARCH.md) and then tuned for play.

export const FACTIONS = {
  UA: {
    id: 'UA', name: 'Ukraine', tape: 0xf2c81a, tapeName: 'yellow',
    soldierAsset: 'soldier_ua', btrAsset: 'btr80_ua', tankAsset: 't72av_ua',
    btrName: 'BTR-80', tankName: 'T-72AV', squadName: 'Mech. Inf. Squad', color: '#f2c81a',
  },
  RU: {
    id: 'RU', name: 'Russia', tape: 0xf4f4ee, tapeName: 'white',
    soldierAsset: 'soldier_ru', btrAsset: 'btr82a', tankAsset: 't72b3',
    btrName: 'BTR-82A', tankName: 'T-72B3', squadName: 'Motor Rifle Squad', color: '#f4f4ee',
  },
};

// Small-arms and vehicle weapons. range in m, rof in rounds/min, dmg per hit, pen in mm RHA (vs vehicles),
// spread = base angular dispersion in milliradians.
export const WEAPONS = {
  ak74m:  { name: 'AK-74M', type: 'rifle', range: 300, rof: 600, burst: [1, 3], burstGap: [0.45, 1.3], mag: 30, reload: 2.8, dmg: [30, 70], pen: 4, spread: 2.6, sound: 'rifle', tracerEvery: 4 },
  pkm:    { name: 'PKM', type: 'mg', range: 500, rof: 650, burst: [5, 12], burstGap: [0.6, 1.4], mag: 100, reload: 6.5, dmg: [35, 80], pen: 8, spread: 3.5, sound: 'mg', tracerEvery: 3, suppress: 2.2 },
  rpg22:  { name: 'RPG-22 Netto', type: 'at', range: 160, rof: 1, mag: 1, reload: 0, dmg: [70, 110], pen: 390, blast: 3, spread: 8, sound: 'rpg', projectile: { speed: 133, gravity: 3 } },
  ak12:   { name: 'AK-12 (optic)', type: 'rifle', range: 330, rof: 700, burst: [1, 3], burstGap: [0.35, 1.0], mag: 30, reload: 2.4, dmg: [30, 70], pen: 4, spread: 2.0, sound: 'rifle', tracerEvery: 4, optic: true },
  ak74o:  { name: 'AK-74M (optic)', type: 'rifle', range: 330, rof: 600, burst: [1, 3], burstGap: [0.35, 1.0], mag: 30, reload: 2.5, dmg: [30, 70], pen: 4, spread: 2.0, sound: 'rifle', tracerEvery: 4, optic: true },
  rpg7:   { name: 'RPG-7 (PG-7VL)', type: 'at', range: 200, rof: 1, mag: 1, reload: 6, dmg: [80, 120], pen: 500, blast: 4, spread: 7, sound: 'rpg', projectile: { speed: 120, gravity: 2.5 } },
  // vehicle weapons
  a72:    { name: '2A72 30 mm', type: 'autocannon', range: 900, rof: 330, burst: [3, 6], burstGap: [0.9, 1.8], mag: 300, reload: 0, dmg: [90, 140], pen: 30, blast: 2.2, spread: 1.6, sound: 'cannon30', tracerEvery: 1 },
  kpvt:   { name: 'KPVT 14.5 mm', type: 'hmg', range: 800, rof: 600, burst: [4, 8], burstGap: [0.8, 1.6], mag: 500, reload: 0, dmg: [70, 120], pen: 30, spread: 2.0, sound: 'hmg', tracerEvery: 2, suppress: 2.5 },
  pkt:    { name: 'PKT 7.62 mm', type: 'mg', range: 600, rof: 700, burst: [6, 14], burstGap: [0.6, 1.4], mag: 2000, reload: 0, dmg: [35, 80], pen: 8, spread: 2.8, sound: 'mg', tracerEvery: 3, suppress: 2.0 },
  pm:     { name: 'PM 9 mm (pistol)', type: 'pistol', range: 60, rof: 140, burst: [1, 2], burstGap: [0.35, 0.9], mag: 8, reload: 2.2, dmg: [22, 50], pen: 2, spread: 5, sound: 'rifle', tracerEvery: 99 },
  // ATGM teams (tripod, SACLOS): tandem HEAT, long range. FPV: RPG-7 warhead strapped to a quadcopter.
  kornet: { name: '9M133 Kornet', type: 'atgm', range: 1300, rof: 1, mag: 1, reload: 8, dmg: [180, 320], pen: 1100, tandem: true, blast: 5, spread: 0.3, sound: 'rpg', projectile: { speed: 260, gravity: 0 } },
  stugna: { name: 'Stugna-P (RK-2S)', type: 'atgm', range: 1200, rof: 1, mag: 1, reload: 8, dmg: [170, 300], pen: 1000, tandem: true, blast: 5, spread: 0.3, sound: 'rpg', projectile: { speed: 220, gravity: 0 } },
  fpv:    { name: 'FPV drone (PG-7VL warhead)', type: 'atgm', range: 900, rof: 1, mag: 1, reload: 0, dmg: [130, 230], pen: 420, blast: 4, spread: 0, sound: 'rpg' },
  a46:    { name: '2A46M 125 mm', type: 'tankgun', range: 1500, rof: 8.5, mag: 39, reload: 7.1, dmg: [200, 400], pen: 600, blast: 7, spread: 0.35, sound: 'tankgun', projectile: { speed: 900, gravity: 0 } },
};

export const SQUAD_ROLES = [
  // Russian motor-rifle / Ukrainian mech-inf squads mounted in a BTR: 8 dismounts.
  { role: 'Squad leader', weapon: 'ak74m', mags: 8, leader: true },
  { role: 'MG gunner', weapon: 'pkm', mags: 3 },
  { role: 'Grenadier (RPG)', weapon: 'rpg7', mags: 3, side: 'ak74m', sideMags: 4 },
  { role: 'Asst. grenadier', weapon: 'ak74m', mags: 7, carriesRpg: 2 },
  { role: 'Rifleman (RPG-22)', weapon: 'ak74m', mags: 7, rpg22: 2 },
  { role: 'Rifleman', weapon: 'ak74m', mags: 8 },
  { role: 'Rifleman (medic)', weapon: 'ak74m', mags: 7, medic: true },
  { role: 'Senior rifleman', weapon: 'ak74m', mags: 8, second: true },
];

// Assault squad (6): heavier armour (shoulder/groin/side protection), optics, many grenades,
// trained for building clearing. weapon 'primary' resolves per faction (AK-12 RU / AK-74M+optic UA).
export const ASSAULT_ROLES = [
  { role: 'Assault leader', weapon: 'primary', mags: 9, leader: true, grenades: 4, armor: 'heavy' },
  { role: 'Assaulter', weapon: 'primary', mags: 9, grenades: 6, armor: 'heavy' },
  { role: 'Assaulter', weapon: 'primary', mags: 9, grenades: 6, armor: 'heavy' },
  { role: 'Assaulter (RPG-22)', weapon: 'primary', mags: 8, grenades: 5, rpg22: 2, armor: 'heavy' },
  { role: 'Assault gunner', weapon: 'pkm', mags: 3, grenades: 3, armor: 'heavy' },
  { role: 'Assaulter (medic)', weapon: 'primary', mags: 8, grenades: 4, armor: 'heavy', medic: true, second: true },
];
export const ARMOR = {
  standard: { plateCoverage: 0.42, plateStop: 0.85, helmetStop: 0.35 },
  heavy: { plateCoverage: 0.62, plateStop: 0.92, helmetStop: 0.5 },
  light: { plateCoverage: 0.2, plateStop: 0.6, helmetStop: 0.15 },     // vehicle crew: soft armour, padded tanker helmet   // + shoulder/groin/side protection
};

// Crew bailing out of a knocked-out or burning vehicle: tanker kit, Makarov pistols only.
export const CREW_ROLES = [
  { role: 'Vehicle commander', weapon: 'pm', mags: 2, leader: true, armor: 'light', grenades: 0, crew: true },
  { role: 'Gunner', weapon: 'pm', mags: 2, armor: 'light', grenades: 0, crew: true },
  { role: 'Driver-mechanic', weapon: 'pm', mags: 2, armor: 'light', grenades: 0, crew: true },
];

// ATGM team: gunner, loader, ammo bearer (missiles in transport tubes). FPV team: pilot + launcher/assistant.
export const ATGM_ROLES = [
  { role: 'ATGM gunner', weapon: 'ak74m', mags: 4, leader: true, grenades: 1, atgm: 'gunner' },
  { role: 'ATGM loader', weapon: 'ak74m', mags: 5, grenades: 1, atgm: 'loader', second: true },
  { role: 'Ammo bearer', weapon: 'ak74m', mags: 5, grenades: 1, atgm: 'bearer' },
];
export const FPV_ROLES = [
  { role: 'FPV pilot', weapon: 'ak74m', mags: 3, leader: true, grenades: 1, fpv: 'pilot' },
  { role: 'FPV assistant', weapon: 'ak74m', mags: 5, grenades: 1, fpv: 'helper', second: true },
];

export const VEHICLES = {
  // armor in mm RHA-equivalent vs chemical energy (CE) and kinetic (KE) rounds by facing.
  btr: {
    kind: 'btr', hp: 900, speed: 11, accel: 3.0, turnRate: 0.75, radius: 2.1, length: 7.6, width: 2.9, height: 2.4,
    armor: { front: { ke: 14, ce: 14 }, side: { ke: 9, ce: 9 }, rear: { ke: 7, ce: 7 }, top: { ke: 7, ce: 7 } },
    passengers: 8, seats: 8, supply: { rifle: 1500, rpg: 6, mg: 400 },
    turretSpeed: 1.2, wheeled: true,
  },
  tank: {
    kind: 'tank', hp: 1600, speed: 9, accel: 2.0, turnRate: 0.6, radius: 2.4, length: 9.5, width: 3.6, height: 2.3,
    armor: { front: { ke: 520, ce: 650 }, side: { ke: 90, ce: 260 }, rear: { ke: 50, ce: 60 }, top: { ke: 40, ce: 40 } },
    passengers: 6, seats: 6, turretSpeed: 0.5, wheeled: false,
  },
};

export const TUNING = {
  soldierHp: 100,
  plateCoverage: 0.42,      // fraction of hits landing on front/back plate area
  plateStopsRifle: 0.85,
  helmetStopChance: 0.35,
  bleedOut: [110, 220],      // seconds a critically wounded soldier survives if not evacuated
  dragSpeed: 1.1,
  moraleRegen: 1.8,          // per second when not under fire
  routThreshold: 15,
  shakenThreshold: 45,
  suppressionDecay: 14,
  captureRadius: 26,
  captureRate: 0.9,          // control points per second per effective soldier (capped at 6)
  lostObjectiveGrace: 90,    // seconds to retake an objective before defeat
  mortarStrikes: 3,
  // movement speeds (m/s)
  walk: 1.55, run: 4.2, crouchWalk: 1.2, crouchRun: 2.8, crawl: 0.45,
};
