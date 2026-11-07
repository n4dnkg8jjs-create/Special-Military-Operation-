// Game data: factions, weapons, unit templates. Values are sourced from public references
// (see docs/RESEARCH.md) and then tuned for play.

export const FACTIONS = {
  UA: {
    id: 'UA', name: 'Ukraine', tape: 0xf2c81a, tapeName: 'yellow',
    soldierAsset: 'soldier_ua', btrAsset: 'btr80_ua', tankAsset: 't72av_ua', ifvAsset: 'bradley_ua', ifvName: 'M2A2 Bradley', spgAsset: 'bohdana', spgName: '2S22 Bohdana',
    btrName: 'BTR-80', tankName: 'T-72AV', squadName: 'Mech. Inf. Squad', color: '#f2c81a',
  },
  RU: {
    id: 'RU', name: 'Russia', tape: 0xf4f4ee, tapeName: 'white',
    soldierAsset: 'soldier_ru', btrAsset: 'btr82a', tankAsset: 't72b3', ifvAsset: 'bmp3', ifvName: 'BMP-3', spgAsset: 'msta_s', spgName: '2S19M2 Msta-S',
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
  rpg7:   { name: 'RPG-7 (PG-7VL)', type: 'at', range: 300, rof: 1, mag: 1, reload: 6, dmg: [80, 120], pen: 500, blast: 4, spread: 7, sound: 'rpg', projectile: { speed: 120, gravity: 2.5 } },
  // vehicle weapons
  a72:    { name: '2A72 30 mm', type: 'autocannon', range: 900, rof: 330, burst: [3, 6], burstGap: [0.9, 1.8], mag: 300, reload: 0, dmg: [90, 140], pen: 55, blast: 2.2, spread: 1.6, sound: 'cannon30', tracerEvery: 1 },
  kpvt:   { name: 'KPVT 14.5 mm', type: 'hmg', range: 800, rof: 600, burst: [4, 8], burstGap: [0.8, 1.6], mag: 500, reload: 0, dmg: [70, 120], pen: 30, spread: 2.0, sound: 'hmg', tracerEvery: 2, suppress: 2.5 },
  pkt:    { name: 'PKT 7.62 mm', type: 'mg', range: 600, rof: 700, burst: [6, 14], burstGap: [0.6, 1.4], mag: 2000, reload: 0, dmg: [35, 80], pen: 8, spread: 2.8, sound: 'mg', tracerEvery: 3, suppress: 2.0 },
  kord:   { name: 'Kord 12.7 mm (remote mount)', type: 'hmg', range: 900, rof: 650, burst: [4, 8], burstGap: [0.8, 1.6], mag: 300, reload: 0, dmg: [70, 120], pen: 20, spread: 2.2, sound: 'hmg', tracerEvery: 2, suppress: 2.5 },
  // howitzers (fire missions only, see artillery.js): range = max with standard / extended-range HE
  g2a64:  { name: '2A64 152 mm L/47 howitzer', type: 'howitzer', range: 24700, rof: 6, dmg: [160, 400], pen: 60, blast: 14 },
  b155:   { name: '155 mm L/52 howitzer', type: 'howitzer', range: 42000, rof: 5, dmg: [170, 420], pen: 60, blast: 15 },
  pm:     { name: 'PM 9 mm (pistol)', type: 'pistol', range: 60, rof: 140, burst: [1, 2], burstGap: [0.35, 0.9], mag: 8, reload: 2.2, dmg: [22, 50], pen: 2, spread: 5, sound: 'rifle', tracerEvery: 99 },
  // ATGM teams (tripod, SACLOS): tandem HEAT, long range. FPV: RPG-7 warhead strapped to a quadcopter.
  kornet: { name: '9M133 Kornet', type: 'atgm', range: 5500, rof: 1, mag: 1, reload: 8, dmg: [180, 320], pen: 1100, tandem: true, blast: 5, spread: 0.3, sound: 'rpg', projectile: { speed: 260, gravity: 0 } },
  stugna: { name: 'Stugna-P (RK-2S)', type: 'atgm', range: 5000, rof: 1, mag: 1, reload: 8, dmg: [170, 300], pen: 850, tandem: true, blast: 5, spread: 0.3, sound: 'rpg', projectile: { speed: 220, gravity: 0 } },
  fpv:    { name: 'FPV drone (PG-7VL warhead, improvised fuze)', type: 'atgm', range: 900, rof: 1, mag: 1, reload: 0, dmg: [170, 290], pen: 420,   /* (below the RPG-7's 500: crush fuze, no proper standoff, poor impact angles) */ blast: 4, spread: 0, sound: 'rpg' },
  // IFV weapons (BMP-3 / M2A2 Bradley)
  m242:   { name: 'M242 Bushmaster 25 mm', type: 'autocannon', range: 900, rof: 200, burst: [2, 5], burstGap: [0.8, 1.6], mag: 300, reload: 0, dmg: [80, 130], pen: 55, blast: 1.8, spread: 1.4, sound: 'cannon30', tracerEvery: 1 },
  a70:    { name: '2A70 100 mm (HE-Frag)', type: 'tankgun', range: 1200, rof: 10, mag: 40, reload: 6, dmg: [180, 320], pen: 40, blast: 6, spread: 0.6, sound: 'tankgun', projectile: { speed: 250, gravity: 0 } },
  m9m117: { name: '9M117M1 Arkan (gun-launched ATGM)', type: 'atgm', range: 5500, rof: 1, mag: 1, reload: 8, dmg: [180, 320], pen: 750, tandem: true, blast: 5, spread: 0.3, sound: 'rpg', projectile: { speed: 300, gravity: 0 } },
  tow2:   { name: 'BGM-71 TOW-2A', type: 'atgm', range: 3750, rof: 1, mag: 2, reload: 25, dmg: [190, 330], pen: 900, tandem: true, blast: 5, spread: 0.3, sound: 'rpg', projectile: { speed: 280, gravity: 0 } },
  a46:    { name: '2A46M 125 mm', type: 'tankgun', range: 1500, rof: 8.5, mag: 45, reload: 7.1, dmg: [200, 400], pen: 600, blast: 7, spread: 0.35, sound: 'tankgun', projectile: { speed: 900, gravity: 0 } },
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
  // IFVs (values from assets/vehicles/manifest.json game_suggested; armour from <asset>_armor.json)
  ifv_ru: {
    kind: 'ifv', asset: 'bmp3', hp: 1050, speed: 12, accel: 2.6, turnRate: 0.75, radius: 2.2, length: 7.1, width: 3.2, height: 2.4,
    armor: { front: { ke: 70, ce: 95 }, side: { ke: 25, ce: 40 }, rear: { ke: 15, ce: 25 }, top: { ke: 6, ce: 10 } },
    passengers: 7, seats: 7, supply: { rifle: 1200, rpg: 4, mg: 400 }, turretSpeed: 0.7, wheeled: false, atgm: 'm9m117', atgmAmmo: 8, main: 'a72', mainAmmo: 500, gun100: 40,
  },
  ifv_ua: {
    kind: 'ifv', asset: 'bradley_ua', hp: 1250, speed: 10.5, accel: 2.4, turnRate: 0.7, radius: 2.2, length: 6.6, width: 3.6, height: 2.6,
    armor: { front: { ke: 75, ce: 90 }, side: { ke: 55, ce: 70 }, rear: { ke: 35, ce: 50 }, top: { ke: 15, ce: 20 } },
    passengers: 6, seats: 6, supply: { rifle: 1200, rpg: 4, mg: 400 }, turretSpeed: 1.0, wheeled: false, atgm: 'tow2', atgmAmmo: 7, main: 'm242', mainAmmo: 900,
  },
  // self-propelled howitzers (assets/vehicles/manifest.json msta_s.game / bohdana.game; armour from <asset>_armor.json)
  // 2S19M2: 42 t, 5 crew, 15 mm welded steel hull/turret, 50 rounds, 10 rpm burst / 6 normal, 1-2 min into action
  spg_ru: {
    kind: 'spg', asset: 'msta_s', hp: 1100, speed: 8.5, accel: 1.8, turnRate: 0.55, radius: 2.4, length: 7.2, width: 3.5, height: 3.0,
    armor: { front: { ke: 30, ce: 30 }, side: { ke: 19, ce: 19 }, rear: { ke: 15, ce: 15 }, top: { ke: 15, ce: 15 } },
    passengers: 0, seats: 0, crew: 5, turretSpeed: 8 * Math.PI / 180, elevSpeed: 5 * Math.PI / 180, wheeled: false,
    gun: 'g2a64', mg: 'kord', ammo: 50, caliber: '152 mm', salvo: 4, interval: 6, cool: 26, deployT: 60, packT: 60, travelPitch: -3.5 * Math.PI / 180, arc: 0, cep: 12, power: 2.7, minRange: 6500, directRange: 4000,
  },
  // 2S22 Bohdana: 28 t KrAZ 6x6, 5 crew, armoured cab only (7.62 AP at 30 m), 20 rounds, 4-6 rpm, 1.5 min into / out of action
  spg_ua: {
    kind: 'spg', asset: 'bohdana', hp: 700, speed: 10.5, accel: 2.4, turnRate: 0.5, radius: 2.3, length: 9.0, width: 2.7, height: 3.0,
    armor: { front: { ke: 14, ce: 14 }, side: { ke: 12, ce: 12 }, rear: { ke: 6, ce: 6 }, top: { ke: 6, ce: 6 } },
    passengers: 0, seats: 0, crew: 5, turretSpeed: 5 * Math.PI / 180, elevSpeed: 4 * Math.PI / 180, wheeled: true,
    gun: 'b155', mg: null, ammo: 20, caliber: '155 mm', salvo: 3, interval: 12, cool: 30, deployT: 90, packT: 90, travelPitch: 0, arc: 30 * Math.PI / 180, spades: true, cep: 10, power: 2.8, minRange: 780, directRange: 2000,
  },
  // casualty-evacuation pickup (assets/vehicles/pickup.glb, src/game/medevac.js): civilian double cab, unarmoured (sheet steel:
  // rifle fire penetrates, ~4 hits stop it, any AT round destroys it), fast and nimble. manifest pickup.game_suggested
  medevac: {
    kind: 'medevac', asset: 'pickup', hp: 160, speed: 16.5, accel: 5.0, turnRate: 1.35, radius: 1.6, length: 5.4, width: 1.9, height: 1.9,
    armor: { front: { ke: 2, ce: 2 }, side: { ke: 1, ce: 1 }, rear: { ke: 1, ce: 1 }, top: { ke: 1, ce: 1 } },
    passengers: 0, seats: 3, crew: 3, turretSpeed: 0, wheeled: true,
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
  // v7 hit outcomes (combat.hitSoldier): a man brought below 0 hp by small arms is killed outright only past `overkill` hp (was
  // -95; HMG / autocannon / blasts keep -95: `overkillHeavy`), by a
  // blast with `blastKill` odds (was 0.25), or by a head hit that is not a graze (`headGraze` of the unstopped head hits only
  // wound: was 0); otherwise he is down, critically wounded. Light wounds below `lightHp` (was 55). Heavy weapons (HMG /
  // autocannon x2.5 damage, shells) still overkill almost every time.
  wound: { overkill: -125, overkillHeavy: -95, blastKill: 0.21, headGraze: 0.2, lightHp: 62 },
  dragSpeed: 1.1,
  moraleRegen: 1.8,          // per second when not under fire
  routThreshold: 12,         // (was 15) morale below this: rout check (routHold) every 3 s
  routHold: { base: 0.25, leader: 0.25, cover: 0.15 },   // chance a check holds (squad stays, morale back to threshold + 5)
  moraleSuppDrain: 0.029,    // (was 0.035) morale lost per second per point of average suppression
  riderKillSurvival: { normal: 0.85, catastrophic: 0.65 },   // riders on the deck unhurt when the vehicle is knocked out (inside: the crew's odds)
  shakenThreshold: 45,
  suppressionDecay: 14,
  captureRadius: 26,
  captureRate: 0.9,          // control points per second per effective soldier (capped at 6)
  lostObjectiveGrace: 90,    // (legacy, no longer a rule — battles are decided by tickets; kept for old HUD text)
  // ---- tickets: each side starts with `tickets` (scaled with the round length, 12 min = 1x) and loses them for
  // every man killed and vehicle / support team destroyed, and continuously while the other side holds more
  // objectives. A side at 0 tickets, or with no fighting units left, loses; at the end of the clock the side with
  // more tickets wins.
  tickets: 500,
  ticketLoss: { soldier: 3, tank: 30, ifv: 22, btr: 16, spg: 18, soft: 8, support: 10 },   // support = ATGM / FPV team wiped out (on top of its men)
  // objective bleed: per objective of advantage, tickets per minute; a point counts `fresh` x on capture, rising to
  // full weight after `ramp` seconds held without interruption (contested / neutral points count for nobody)
  ticketBleed: { perObj: 24, ramp: 90, fresh: 0.35 },
  mortarStrikes: 3,
  // movement speeds (m/s)
  walk: 1.55, run: 4.2, crouchWalk: 1.2, crouchRun: 2.8, crawl: 0.45, highCrawl: 0.7,
};
