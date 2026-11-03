// Campaign v2 — tech tree data and layout (both sides).
//
// The tree is organised as the player sees it in the high-command screen (ui.js techTree):
//   VEHICLE LINES — one row per vehicle the brigade fields on the battle map (only vehicles that exist as GLB models
//     in assets/vehicles). The row head is the vehicle itself (owned from the start, date-gated through the catalog,
//     or unlocked by a tech node `vehicle: true`); unit unlocks for the line follow it; under it a drop-down holds the
//     vehicle's field upgrades (cope cages, ERA, sandbags / track links, gunner sights, roof jammers, smoke, crew drills).
//     A vehicle upgrade carries `kit` (a key of KITS) and `vk` (the battle vehicle kind: btr / ifv / tank / spg): it
//     changes how that vehicle fights (KITS[k].fx, applied in src/game/campaignBattle.js) and how it looks (the kit
//     meshes from src/game/vehicleKit.js, also shown in the tech tree's 3D preview).
//   SUPPORT BRANCHES — infantry kit, drones & EW, fires, logistics: small side-wide MODS (src/campaign/schema.js).
// Columns are date tiers (TIERS); a node sits in the column of its date gate, right of its prerequisites.
//
// Balance rules (v4 audit): no flat "+X% everything" buffs. Side-wide modifiers stay small (accuracy +0.1 at most in
// total, LP gain +0.1, ewJam 0.2 in total, artillery shells +45% in total); vehicle kits are situational and most
// carry a cost on the battle map (weight: speed / acceleration; screens: slower turret traverse).
// Node fields (schema.js tech + extensions): id, name, branch, desc, lp, eta, req, kind ('unlock'|'upgrade'), mods,
// unlock, date, line (vehicle line id), kit, vk, vehicle (true = this node brings the line's vehicle into service).

// ---------------------------------------------------------------- vehicle kits (visual + battle effect)
// fx keys (src/game/vehicleKit.js applyKitFx): cage (+chance a top-attack drone is defeated), era (adds / reinforces
// ERA on the front faces), side (mm-equivalent vs HEAT added to hull sides), sight (0..1: moving-fire penalty ignored /
// first-round ranging), smoke (smoke salvos when hit), speed / accel / turret (multipliers, -0.06 = 6% slower).
export const KITS = {
  cage: { name: 'Anti-drone screen', short: 'Screen', fx: { cage: 0.15, turret: -0.08 },
    good: '+15% chance an FPV or loitering munition goes off on the screen', bad: 'turret traverse −8%' },
  roof: { name: 'Full-length anti-drone roof', short: 'Roof', fx: { cage: 0.1, speed: -0.04, turret: -0.05 },
    good: '+10% chance a top-attack drone is defeated over the hull and engine deck', bad: 'speed −4%, turret traverse −5%' },
  era: { name: 'Reactive armour kit', short: 'ERA', fx: { era: 1, speed: -0.04 },
    good: 'ERA on the hull and turret front: defeats most single-charge RPG / ATGM hits on the front (tandem warheads mostly ignore it; each block works once)', bad: 'speed −4%' },
  sandbags: { name: 'Sandbags and spare track links', short: 'Sandbags', fx: { side: 20, speed: -0.06, accel: -0.08 },
    good: '+20 mm-equivalent against RPG jets on the hull sides', bad: 'speed −6%, acceleration −8%' },
  sight: { name: 'Thermal gunner sight', short: 'Sight', fx: { sight: 0.5 },
    good: 'half the shots fired on the move ignore the movement penalty; better first round on a new target', bad: 'none (cost and delivery time only)' },
  ew: { name: 'Roof EW jammer', short: 'EW', fx: { cage: 0.12 },
    good: '+12% chance an incoming FPV loses its link before impact', bad: 'none on the battle map; does not stop fibre-optic or wire-guided weapons' },
  smoke: { name: 'Smoke grenade launchers', short: 'Smoke', fx: { smoke: 2 },
    good: 'pops a smoke screen in front of the vehicle when it is hit (2 salvos per battle)', bad: 'the smoke blinds the own gunner too' },
  crew: { name: 'Crew drills', short: 'Crew', fx: { turret: 0.1 },
    good: 'turret traverse +10% (faster on to a new target)', bad: 'none' },
};
export const KIT_ORDER = ['cage', 'roof', 'era', 'sandbags', 'sight', 'ew', 'smoke', 'crew'];

// ---------------------------------------------------------------- date tiers (columns)
export const TIERS = [
  { from: '0000', label: 'Winter 2023' },
  { from: '2023-04-01', label: 'Spring 2023' },
  { from: '2023-06-15', label: 'Summer 2023' },
  { from: '2023-09-01', label: 'Autumn 2023' },
  { from: '2023-11-15', label: 'Winter 2023–24' },
];
export const tierOf = date => { let k = 0; TIERS.forEach((t, i) => { if (date && String(date) >= t.from) k = i; }); return k; };

// ---------------------------------------------------------------- vehicle lines
// asset = the GLB in assets/vehicles (= what the battle map shows for that vehicle kind, src/config.js FACTIONS);
// catalog = unit keys that field this vehicle; tech = the node that brings it into service (else owned / catalog-dated)
export const LINES = {
  UA: [
    { id: 'ua_btr', vk: 'btr', asset: 'btr80_ua', name: 'BTR-80', role: 'Wheeled APC', catalog: ['mech_btr'] },
    { id: 'ua_ifv', vk: 'ifv', asset: 'bradley_ua', name: 'M2A2 ODS-SA Bradley', role: 'Infantry fighting vehicle', catalog: ['mech_ifv', 'mech_bmp'] },   // the brigade's IFV squads (BMP-2 in the catalog) fight in the Bradley model on the battle map
    { id: 'ua_tank', vk: 'tank', asset: 't72av_ua', name: 'T-72AV', role: 'Main battle tank', catalog: ['tank'] },
    { id: 'ua_spg', vk: 'spg', asset: 'bohdana', name: '2S22 Bohdana', role: '155 mm wheeled SP howitzer', catalog: ['spg'], tech: 'ua_fire_spg' },
  ],
  RU: [
    { id: 'ru_btr', vk: 'btr', asset: 'btr82a', name: 'BTR-82A', role: 'Wheeled APC', catalog: ['mech_btr'] },
    { id: 'ru_ifv', vk: 'ifv', asset: 'bmp3', name: 'BMP-3', role: 'Infantry fighting vehicle', catalog: ['mech_ifv'] },
    { id: 'ru_tank', vk: 'tank', asset: 't72b3', name: 'T-72B3', role: 'Main battle tank', catalog: ['tank'] },
    { id: 'ru_spg', vk: 'spg', asset: 'msta_s', name: '2S19M2 Msta-S', role: '152 mm tracked SP howitzer', catalog: ['spg'], tech: 'ru_fire_msta' },
  ],
};
export const BRANCHES = {
  UA: ['Infantry', 'Drones & EW', 'Fires', 'Engineers & Logistics'],
  RU: ['Infantry', 'Drones & EW', 'Fires', 'Logistics & Medical'],
};

// vehicle upgrade node
const V = (id, line, vk, kit, lp, o = {}) => ({ id, name: o.name || KITS[kit].name, branch: 'Vehicles', line, vk, kit, desc: o.desc || '', lp, eta: o.eta ?? 1, req: o.req || [], kind: 'upgrade', ...(o.date ? { date: o.date } : {}) });

export const TECH_UA = [
  // ---- BTR-80
  V('ua_btr_cage', 'ua_btr', 'btr', 'cage', 15, { name: 'Welded anti-drone screen', desc: 'A field-welded frame with mesh over the turret and roof hatches.', date: '2023-03-01' }),
  V('ua_btr_sand', 'ua_btr', 'btr', 'sandbags', 12, { name: 'Sandbags and spare wheels', desc: 'Sandbags and spare tyres along the hull sides against RPG jets and fragments.' }),
  V('ua_btr_smoke', 'ua_btr', 'btr', 'smoke', 12, { name: 'Smoke launcher refill', desc: 'Restore the 902V smoke grenade launchers that most BTR-80s run without.' }),
  V('ua_btr_sight', 'ua_btr', 'btr', 'sight', 25, { name: 'Thermal sight for the gunner', desc: 'A clip-on thermal channel for the gunner\'s periscope sight: the KPVT can be laid at night and through dust.', req: ['ua_btr_sand'], date: '2023-06-15' }),
  V('ua_btr_ew', 'ua_btr', 'btr', 'ew', 25, { name: 'Roof jammer', desc: 'A volunteer-built jammer box with whip antennas on the roof.', req: ['ua_btr_cage'], date: '2023-09-01' }),
  // ---- Bradley
  { id: 'ua_arm_bradley2', name: 'Second Bradley company', branch: 'Vehicles', line: 'ua_ifv', desc: 'More M2A2 ODS-SA Bradleys from partner deliveries are assigned to the brigade: more Bradley squads can be ordered.', lp: 55, eta: 3, req: [], kind: 'unlock', unlock: ['mech_ifv_plus'], date: '2023-06-15' },
  V('ua_ifv_brat', 'ua_ifv', 'ifv', 'era', 30, { name: 'BRAT reactive armour', desc: 'Bradley Reactive Armour Tiles bolted to the hull front, sides of the crew compartment and turret.', eta: 2, date: '2023-06-15' }),
  V('ua_ifv_cage', 'ua_ifv', 'ifv', 'cage', 20, { name: 'Anti-drone screen', desc: 'Mesh screens over the turret and the roof hatches against FPVs and Lancets.', date: '2023-09-01' }),
  V('ua_ifv_ew', 'ua_ifv', 'ifv', 'ew', 30, { name: 'Vehicle EW jammer', desc: 'A jammer on the turret roof against FPV control links.', req: ['ua_ifv_cage'], date: '2023-11-15' }),
  V('ua_ifv_crew', 'ua_ifv', 'ifv', 'crew', 25, { name: 'Bradley crew course', desc: 'Gunnery tables abroad and at the brigade range: faster target hand-off between commander and gunner.', eta: 2, date: '2023-04-01' }),
  // ---- T-72AV
  { id: 'ua_arm_tankpl', name: 'Second tank platoon', branch: 'Vehicles', line: 'ua_tank', desc: 'Depot-repaired tanks for a second platoon: more tanks can be ordered.', lp: 50, eta: 3, req: ['ua_arm_era'], kind: 'unlock', unlock: ['tank_plus'] },
  V('ua_arm_era', 'ua_tank', 'tank', 'era', 30, { name: 'Kontakt-1 refit', desc: 'Replace missing Kontakt-1 blocks on the turret and glacis and add domestic ERA to the hull.', eta: 2 }),
  V('ua_arm_cages', 'ua_tank', 'tank', 'cage', 20, { name: 'Anti-drone screen', desc: 'A field-built mesh frame over the turret as enemy FPVs and Lancets multiply.', date: '2023-06-15' }),
  V('ua_tank_links', 'ua_tank', 'tank', 'sandbags', 12, { name: 'Track links and logs', desc: 'Spare track links on the glacis and turret sides, sandbags on the hull.' }),
  V('ua_tank_sight', 'ua_tank', 'tank', 'sight', 35, { name: 'Thermal gunner sight', desc: 'A thermal module for the gunner\'s sight from a partner refit programme.', eta: 2, date: '2023-04-01' }),
  V('ua_tank_smoke', 'ua_tank', 'tank', 'smoke', 12, { name: 'Smoke launcher refill', desc: 'Restore the 902B smoke launchers on the turret.' }),
  V('ua_tank_ew', 'ua_tank', 'tank', 'ew', 30, { name: 'Tank EW jammer', desc: 'A jammer with omni antennas on the turret roof.', req: ['ua_arm_cages'], date: '2023-09-01' }),
  V('ua_tank_crew', 'ua_tank', 'tank', 'crew', 25, { name: 'Tank crew drills', desc: 'Live-fire crew drills on the brigade range between rotations.', eta: 2, req: ['ua_tank_sight'] }),
  // ---- Bohdana
  { id: 'ua_fire_spg', name: '2S22 Bohdana section', branch: 'Vehicles', line: 'ua_spg', vehicle: true, desc: 'A 155 mm wheeled self-propelled howitzer section is placed under brigade command: the gun can be ordered.', lp: 70, eta: 4, req: [], kind: 'unlock', unlock: ['spg'], date: '2023-04-01' },
  V('ua_spg_net', 'ua_spg', 'spg', 'cage', 15, { name: 'Anti-drone net over the cab', desc: 'A net and a welded frame over the cab and the gun cradle.', req: ['ua_fire_spg'] }),
  V('ua_spg_crew', 'ua_spg', 'spg', 'crew', 20, { name: 'Shoot-and-scoot drills', desc: 'Faster emplacement and laying drills for the gun crew.', req: ['ua_fire_spg'] }),
  // ---- Infantry
  { id: 'ua_inf_plates', name: 'Helmets and Level IV plates', branch: 'Infantry', desc: 'Partner-supplied ballistic helmets, rifle plates and better carriers for every squad.', lp: 30, eta: 2, req: [], kind: 'upgrade', mods: { helmet: 0.08, armorPlate: 0.05 } },
  { id: 'ua_inf_optics', name: 'Optics on every rifle', branch: 'Infantry', desc: 'Red-dots and low-power scopes, many volunteer-funded.', lp: 25, eta: 1, req: [], kind: 'upgrade', mods: { accuracy: 0.06 } },
  { id: 'ua_inf_thermal', name: 'Thermal sights and NVGs', branch: 'Infantry', desc: 'Night-fighting kit down to squad level: tree-belt fighting goes on after dark.', lp: 45, eta: 2, req: ['ua_inf_optics'], kind: 'upgrade', mods: { thermals: 0.2 }, date: '2023-04-01' },
  { id: 'ua_inf_training', name: 'Partner combined-arms training', branch: 'Infantry', desc: 'Companies rotate through a combined-arms course abroad: fire and manoeuvre, trench clearing, breaching drills.', lp: 40, eta: 3, req: ['ua_inf_plates', 'ua_inf_optics'], kind: 'upgrade', mods: { accuracy: 0.04, morale: 0.15 }, date: '2023-04-01' },
  { id: 'ua_inf_assault', name: 'Brigade assault company', branch: 'Infantry', desc: 'Form an assault company from experienced volunteers: more assault squads can be ordered.', lp: 45, eta: 3, req: ['ua_inf_training'], kind: 'unlock', unlock: ['assault_plus'] },
  { id: 'ua_inf_missiles', name: 'Missile reserve', branch: 'Infantry', desc: 'Extra Stugna-P and Javelin rounds carried forward for every ATGM team.', lp: 25, eta: 1, req: [], kind: 'upgrade', mods: { atgmAmmo: 1 } },
  // ---- Drones & EW
  { id: 'ua_dr_mavic', name: 'Mavic recon', branch: 'Drones & EW', desc: 'Commercial quadcopters scout enemy positions before every attack.', lp: 20, eta: 1, req: [], kind: 'upgrade', mods: { reconDrone: true } },
  { id: 'ua_dr_sa', name: 'Digital situational awareness', branch: 'Drones & EW', desc: 'Satellite terminals at company level and a shared digital map: drone feeds reach every commander.', lp: 35, eta: 2, req: ['ua_dr_mavic'], kind: 'upgrade', mods: { spotRange: 0.1 } },
  { id: 'ua_dr_fpv', name: 'Volunteer FPV batch', branch: 'Drones & EW', desc: 'A crowdfunded consignment of FPV strike drones.', lp: 20, eta: 1, req: [], kind: 'upgrade', mods: { fpvDrones: 1 }, date: '2023-04-01' },
  { id: 'ua_dr_school', name: 'FPV pilot school', branch: 'Drones & EW', desc: 'Simulator hours and live training for the pilots.', lp: 35, eta: 2, req: ['ua_dr_fpv'], kind: 'upgrade', mods: { fpvHit: 0.15 } },
  { id: 'ua_dr_uas', name: 'Unmanned systems company', branch: 'Drones & EW', desc: 'A dedicated drone company: more FPV teams can be ordered.', lp: 55, eta: 3, req: ['ua_dr_school', 'ua_dr_sa'], kind: 'unlock', unlock: ['fpv_plus'], date: '2023-11-15' },
  { id: 'ua_dr_bomber', name: 'Night bomber drones', branch: 'Drones & EW', desc: 'Heavy hexacopters drop mortar bombs on trench lines at night: one more fire mission per battle.', lp: 45, eta: 2, req: ['ua_dr_school'], kind: 'upgrade', mods: { mortar: 1 }, date: '2023-09-01' },
  { id: 'ua_dr_ew', name: 'Trench EW', branch: 'Drones & EW', desc: 'Portable jammers with the infantry against enemy FPVs.', lp: 30, eta: 1, req: [], kind: 'upgrade', mods: { ewJam: 0.1 }, date: '2023-06-15' },
  { id: 'ua_dr_ewpl', name: 'Brigade EW platoon', branch: 'Drones & EW', desc: 'Detection and jamming of drone control links across the sector.', lp: 50, eta: 3, req: ['ua_dr_ew', 'ua_dr_sa'], kind: 'upgrade', mods: { ewJam: 0.1 }, date: '2023-09-01' },
  // ---- Fires
  { id: 'ua_fire_dfc', name: 'Digital fire control', branch: 'Fires', desc: 'Tablet-based target exchange between drone teams and mortars: faster calls for fire.', lp: 25, eta: 1, req: [], kind: 'upgrade', mods: { mortar: 1 } },
  { id: 'ua_fire_mortar', name: '120 mm mortar battery', branch: 'Fires', desc: 'A heavy mortar battery is attached to the brigade: one more fire mission per battle.', lp: 45, eta: 2, req: ['ua_fire_dfc'], kind: 'upgrade', mods: { mortar: 1 }, date: '2023-04-01' },
  { id: 'ua_fire_alloc', name: '155 mm allocation', branch: 'Fires', desc: 'Partner 155 mm deliveries move the brigade up the shell allocation list.', lp: 40, eta: 2, req: ['ua_fire_spg'], kind: 'upgrade', mods: { artyAmmo: 0.15 } },
  { id: 'ua_fire_dpicm', name: '155 mm cluster rounds', branch: 'Fires', desc: 'Dual-purpose cluster shells delivered from July 2023 stretch the shell supply against trench lines.', lp: 45, eta: 2, req: ['ua_fire_alloc'], kind: 'upgrade', mods: { artyAmmo: 0.15 }, date: '2023-06-15' },
  { id: 'ua_fire_precision', name: 'Precision-guided 155 mm', branch: 'Fires', desc: 'Guided shells for high-value targets: fewer rounds per kill.', lp: 55, eta: 3, req: ['ua_fire_alloc', 'ua_dr_sa'], kind: 'upgrade', mods: { artyAmmo: 0.15 }, date: '2023-09-01' },
  // ---- Engineers & Logistics
  { id: 'ua_log_ifak', name: 'Tourniquets and IFAKs', branch: 'Engineers & Logistics', desc: 'Every soldier carries a tourniquet and first-aid kit and is trained to use them.', lp: 15, eta: 1, req: [], kind: 'upgrade', mods: { medevac: 0.2 } },
  { id: 'ua_log_evac', name: 'Armoured ambulances', branch: 'Engineers & Logistics', desc: 'M113 tracked ambulances evacuate wounded under fire across the open fields.', lp: 40, eta: 2, req: ['ua_log_ifak'], kind: 'upgrade', mods: { medevac: 0.25 }, date: '2023-04-01' },
  { id: 'ua_eng_recovery', name: 'Recovery and repair company', branch: 'Engineers & Logistics', desc: 'Recovery vehicles and a field workshop pull damaged vehicles back after the fight.', lp: 35, eta: 2, req: [], kind: 'upgrade', mods: { repair: 0.2 } },
  { id: 'ua_eng_breach', name: 'Breaching engineers', branch: 'Engineers & Logistics', desc: 'Mine rollers, line charges and sapper teams with every assault group: fewer vehicles crippled, steadier assaults.', lp: 45, eta: 2, req: ['ua_eng_recovery'], kind: 'upgrade', mods: { repair: 0.1, morale: 0.1 }, date: '2023-04-01' },
  { id: 'ua_log_tc', name: 'Brigade training centre', branch: 'Engineers & Logistics', desc: 'Own training ground for incoming drafts: larger, better-trained drafts can be ordered.', lp: 30, eta: 2, req: [], kind: 'unlock', unlock: ['repl_draft'] },
  { id: 'ua_log_pipeline', name: 'Replacement pipeline', branch: 'Engineers & Logistics', desc: 'Direct links with the recruiting centres cut the cost of replacements.', lp: 35, eta: 2, req: ['ua_log_tc'], kind: 'upgrade', mods: { replacementsCost: -0.15 } },
  { id: 'ua_log_staff', name: 'Logistics staff', branch: 'Engineers & Logistics', desc: 'Better reporting and requests: a little more support from higher command.', lp: 50, eta: 2, req: ['ua_log_tc'], kind: 'upgrade', mods: { lpGain: 0.1 } },
];

export const TECH_RU = [
  // ---- BTR-82A
  V('ru_btr_cage', 'ru_btr', 'btr', 'cage', 15, { name: 'Welded cope cage', desc: 'A welded frame with mesh over the turret.' }),
  V('ru_btr_sand', 'ru_btr', 'btr', 'sandbags', 12, { name: 'Sandbags and spare wheels', desc: 'Sandbags, logs and spare tyres along the hull sides.' }),
  V('ru_btr_smoke', 'ru_btr', 'btr', 'smoke', 12, { name: 'Smoke grenade reloads', desc: 'Full loads for the 902V launchers on the turret.' }),
  V('ru_btr_ew', 'ru_btr', 'btr', 'ew', 25, { name: 'Roof jammer', desc: 'A jammer box with whip antennas on the roof.', req: ['ru_btr_cage'], date: '2023-06-15' }),
  V('ru_btr_crew', 'ru_btr', 'btr', 'crew', 20, { name: 'Gunner-operator course', desc: 'Range time for the BTR-82A gunners on the stabilised 2A72.', eta: 2 }),
  // ---- BMP-3
  { id: 'ru_arm_bmp', name: 'BMP-3 company', branch: 'Vehicles', line: 'ru_ifv', desc: 'BMP-3s are assigned to the brigade for the autumn offensive: more IFV squads can be ordered.', lp: 55, eta: 3, req: [], kind: 'unlock', unlock: ['mech_ifv_plus'], date: '2023-09-01' },
  V('ru_ifv_era', 'ru_ifv', 'ifv', 'era', 30, { name: 'Kaktus ERA kit', desc: 'Kaktus reactive armour on the glacis and the turret front, serial from late 2022.', eta: 2, date: '2023-04-01' }),
  V('ru_ifv_cage', 'ru_ifv', 'ifv', 'cage', 15, { name: 'Cope cage', desc: 'A welded cage over the turret.' }),
  V('ru_ifv_ew', 'ru_ifv', 'ifv', 'ew', 30, { name: 'Vehicle EW jammer', desc: 'A jammer on the turret roof.', req: ['ru_ifv_cage'], date: '2023-09-01' }),
  V('ru_ifv_sand', 'ru_ifv', 'ifv', 'sandbags', 12, { name: 'Logs and track links', desc: 'Logs, sandbags and track links on the thin aluminium hull sides.' }),
  // ---- T-72B3
  { id: 'ru_arm_tankpl', name: 'T-72B3M platoon', branch: 'Vehicles', line: 'ru_tank', desc: 'Factory-fresh T-72B3Ms for a second platoon: more tanks can be ordered.', lp: 55, eta: 3, req: ['ru_arm_era'], kind: 'unlock', unlock: ['tank_plus'], date: '2023-06-15' },
  V('ru_arm_cage', 'ru_tank', 'tank', 'cage', 15, { name: 'Cope cage and nets', desc: 'Welded overhead cages with mesh and hanging nets against top-attack munitions.' }),
  V('ru_arm_roof', 'ru_tank', 'tank', 'roof', 30, { name: 'Anti-drone roof', desc: 'A full-length screen over hull and engine deck, as FPVs multiply.', eta: 2, req: ['ru_arm_cage'], date: '2023-09-01' }),
  V('ru_arm_era', 'ru_tank', 'tank', 'era', 30, { name: 'Kontakt-5 / Relikt refit', desc: 'Replace missing and spent ERA blocks; Relikt on the turret fronts.', eta: 2 }),
  V('ru_tank_links', 'ru_tank', 'tank', 'sandbags', 12, { name: 'Track links and sandbags', desc: 'Spare track links and sandbags on the hull sides.' }),
  V('ru_dr_ewveh', 'ru_tank', 'tank', 'ew', 35, { name: 'Vehicle-mounted EW', desc: 'A Volnorez-type jammer on the turret roof.', req: ['ru_arm_cage'], date: '2023-06-15' }),
  V('ru_tank_smoke', 'ru_tank', 'tank', 'smoke', 12, { name: 'Smoke grenade reloads', desc: 'Full loads for the 902B launchers.' }),
  V('ru_tank_crew', 'ru_tank', 'tank', 'crew', 25, { name: 'Tank crew drills', desc: 'Crew drills at the training ground behind the lines.', eta: 2 }),
  // ---- Msta-S
  { id: 'ru_fire_msta', name: '2S19M2 Msta-S battery', branch: 'Vehicles', line: 'ru_spg', vehicle: true, desc: 'A self-propelled 152 mm battery is placed under brigade command: the gun can be ordered.', lp: 70, eta: 3, req: [], kind: 'unlock', unlock: ['spg'] },
  V('ru_spg_net', 'ru_spg', 'spg', 'cage', 15, { name: 'Anti-drone cage', desc: 'A welded cage with mesh over the turret roof.', req: ['ru_fire_msta'] }),
  V('ru_spg_crew', 'ru_spg', 'spg', 'crew', 20, { name: 'Battery drills', desc: 'Faster emplacement and laying drills for the gun crews.', req: ['ru_fire_msta'] }),
  // ---- Infantry
  { id: 'ru_inf_armour', name: '6B47 helmets and 6B45 plates', branch: 'Infantry', desc: 'Full sets of issued body armour and helmets instead of mixed private purchases.', lp: 25, eta: 2, req: [], kind: 'upgrade', mods: { helmet: 0.07, armorPlate: 0.05 } },
  { id: 'ru_inf_optics', name: 'Collimators and 4x sights', branch: 'Infantry', desc: 'Optics for the rifles and machine guns.', lp: 25, eta: 1, req: [], kind: 'upgrade', mods: { accuracy: 0.06 } },
  { id: 'ru_inf_thermal', name: 'Thermal imagers', branch: 'Infantry', desc: 'Handheld thermal imagers and night sights for the assault groups.', lp: 45, eta: 2, req: ['ru_inf_optics'], kind: 'upgrade', mods: { thermals: 0.2 }, date: '2023-04-01' },
  { id: 'ru_inf_storm', name: 'Assault group training', branch: 'Infantry', desc: 'Small-group tactics at the brigade training ground: movement under drones, trench and building clearing.', lp: 40, eta: 2, req: ['ru_inf_armour'], kind: 'upgrade', mods: { morale: 0.15, accuracy: 0.04 } },
  { id: 'ru_inf_stormco', name: 'Second assault detachment', branch: 'Infantry', desc: 'Form a second assault detachment: more assault squads can be ordered.', lp: 45, eta: 3, req: ['ru_inf_storm'], kind: 'unlock', unlock: ['assault_plus'], date: '2023-04-01' },
  { id: 'ru_inf_kornet', name: 'Kornet missile reserve', branch: 'Infantry', desc: 'Extra missiles carried forward for every ATGM team.', lp: 25, eta: 1, req: [], kind: 'upgrade', mods: { atgmAmmo: 1 } },
  // ---- Drones & EW
  { id: 'ru_dr_orlan', name: 'Orlan-10 reconnaissance', branch: 'Drones & EW', desc: 'Fixed-wing reconnaissance drones locate enemy positions before every attack.', lp: 20, eta: 1, req: [], kind: 'upgrade', mods: { reconDrone: true } },
  { id: 'ru_dr_zala', name: 'Spotting and strike coordination', branch: 'Drones & EW', desc: 'ZALA and Supercam drones on station over the sector, linked to the brigade\'s fire control.', lp: 35, eta: 2, req: ['ru_dr_orlan'], kind: 'upgrade', mods: { spotRange: 0.1 } },
  { id: 'ru_dr_fpv', name: 'FPV workshop deliveries', branch: 'Drones & EW', desc: 'A consignment of FPV strike drones from the workshops behind the lines.', lp: 20, eta: 1, req: [], kind: 'upgrade', mods: { fpvDrones: 1 }, date: '2023-06-15' },
  { id: 'ru_dr_school', name: 'FPV operator course', branch: 'Drones & EW', desc: 'Operators trained on simulators and at the range.', lp: 35, eta: 2, req: ['ru_dr_fpv'], kind: 'upgrade', mods: { fpvHit: 0.15 } },
  { id: 'ru_dr_uav', name: 'Brigade UAV company', branch: 'Drones & EW', desc: 'A dedicated UAV company: more FPV teams can be ordered.', lp: 55, eta: 3, req: ['ru_dr_school', 'ru_dr_zala'], kind: 'unlock', unlock: ['fpv_plus'], date: '2023-09-01' },
  { id: 'ru_dr_ew', name: 'Trench EW', branch: 'Drones & EW', desc: 'Portable jammers with the assault groups against enemy FPVs.', lp: 30, eta: 1, req: [], kind: 'upgrade', mods: { ewJam: 0.1 } },
  { id: 'ru_dr_ewco', name: 'Brigade EW company', branch: 'Drones & EW', desc: 'Detection and jamming of drone control links across the sector.', lp: 50, eta: 3, req: ['ru_dr_ew', 'ru_dr_zala'], kind: 'upgrade', mods: { ewJam: 0.1 }, date: '2023-09-01' },
  // ---- Fires
  { id: 'ru_fire_mortar', name: '120 mm mortar battery', branch: 'Fires', desc: 'A heavy mortar battery attached to the brigade: one more fire mission per battle.', lp: 30, eta: 1, req: [], kind: 'upgrade', mods: { mortar: 1 } },
  { id: 'ru_fire_shells', name: 'Shell allocation', branch: 'Fires', desc: 'Priority on the army\'s 152 mm allocation for the offensive.', lp: 40, eta: 2, req: ['ru_fire_msta'], kind: 'upgrade', mods: { artyAmmo: 0.15 } },
  { id: 'ru_fire_krasnopol', name: 'Krasnopol guided shells', branch: 'Fires', desc: 'Laser-guided 152 mm shells designated by drones: fewer rounds per kill.', lp: 55, eta: 3, req: ['ru_fire_shells', 'ru_dr_zala'], kind: 'upgrade', mods: { artyAmmo: 0.15 }, date: '2023-06-15' },
  { id: 'ru_fire_kab', name: 'Air support: glide bombs', branch: 'Fires', desc: 'Guided glide bombs on strongpoints ahead of the assault: one more fire mission per battle.', lp: 60, eta: 2, req: ['ru_fire_mortar'], kind: 'upgrade', mods: { mortar: 1 }, date: '2023-04-01' },
  // ---- Logistics & Medical
  { id: 'ru_arm_repair', name: 'Field repair base', branch: 'Logistics & Medical', desc: 'Recovery tractors and a repair base close behind the line return damaged vehicles faster.', lp: 35, eta: 2, req: [], kind: 'upgrade', mods: { repair: 0.2 } },
  { id: 'ru_log_ifak', name: 'IFAKs and tourniquets', branch: 'Logistics & Medical', desc: 'A modern first-aid kit and tourniquet for every soldier.', lp: 15, eta: 1, req: [], kind: 'upgrade', mods: { medevac: 0.2 } },
  { id: 'ru_log_evac', name: 'Armoured casualty evacuation', branch: 'Logistics & Medical', desc: 'MT-LBs assigned to evacuate the wounded from the line.', lp: 35, eta: 2, req: ['ru_log_ifak'], kind: 'upgrade', mods: { medevac: 0.25 } },
  { id: 'ru_log_mob', name: 'Replenishment drafts', branch: 'Logistics & Medical', desc: 'Regular drafts of contract and mobilised soldiers through the training ground: larger drafts can be ordered.', lp: 30, eta: 2, req: [], kind: 'unlock', unlock: ['repl_large'] },
  { id: 'ru_log_pipeline', name: 'Recruitment pipeline', branch: 'Logistics & Medical', desc: 'Regional recruitment drives cut the cost of replacements.', lp: 35, eta: 2, req: ['ru_log_mob'], kind: 'upgrade', mods: { replacementsCost: -0.15 } },
  { id: 'ru_log_staff', name: 'Rear services and reporting', branch: 'Logistics & Medical', desc: 'Better staff work: a little more support from higher command.', lp: 50, eta: 2, req: ['ru_log_mob'], kind: 'upgrade', mods: { lpGain: 0.1 } },
];

// ---------------------------------------------------------------- queries (C = Campaign2)
export function linesOf(C) { return LINES[C.def.id] || LINES[C.side === 'RU' ? 'RU' : 'UA'] || []; }
export function branchesOf(C) { return BRANCHES[C.def.id] || [...new Set(C.def.tech.filter(t => !t.line).map(t => t.branch || 'General'))]; }
// node state: have | ordered | avail | date (prerequisites met, date not reached) | locked
export function techState(C, t) {
  if (C.unlocked.includes(t.id)) return 'have';
  if (C.orders.some(o => o.what === 'tech' && o.key === t.id)) return 'ordered';
  const reqOk = (t.req || []).every(r => C.unlocked.includes(r));
  if (reqOk && !C.dateOk(t)) return 'date';
  return C.techAvailable(t.id) ? 'avail' : 'locked';
}
// a vehicle line's own state: in service / ordered / from <date> / locked behind its tech
export function lineState(C, L) {
  if (L.tech) { const t = C.techItem(L.tech); return t ? techState(C, t) : 'have'; }
  if (L.date && !C.dateOk(L)) return 'date';
  return 'have';
}
// kits the player's vehicles carry now (kind -> [kit]); ordered and not yet delivered kits are not included
export function kitsOwned(C, vk = null) {
  const out = {};
  for (const id of C.unlocked) { const t = C.techItem(id); if (t?.kit && t.vk) (out[t.vk] ||= []).push(t.kit); }
  return vk ? out[vk] || [] : out;
}
// battle mods: { kits: { btr: [...], ... } } merged into Campaign2.mods() (state.js)
export function kitMods(C) { const k = kitsOwned(C); return Object.keys(k).length ? { kits: k } : {}; }
// column of a node: its date tier, right of its prerequisites inside the same row
export function layoutRow(C, nodes, minCol = 0) {
  const col = new Map(), byId = new Map(nodes.map(t => [t.id, t]));
  const f = t => { if (col.has(t.id)) return col.get(t.id); col.set(t.id, minCol); let c = Math.max(minCol, tierOf(t.date)); for (const r of t.req || []) if (byId.has(r)) c = Math.max(c, f(byId.get(r)) + 1); col.set(t.id, c); return c; };
  nodes.forEach(f);
  // stack nodes sharing a column
  const stacks = {}; const pos = new Map();
  for (const t of nodes) { const c = col.get(t.id); const k = stacks[c] = (stacks[c] || 0) + 1; pos.set(t.id, { col: c, row: k - 1 }); }
  return { pos, rows: Math.max(1, ...Object.values(stacks)), cols: Math.max(TIERS.length, ...[...col.values()].map(c => c + 1)) };
}
// effect text for a node (kit or mods)
const MOD_TXT = { armorPlate: v => `body-armour plate coverage +${pc(v)}`, helmet: v => `helmet stop chance +${pc(v)}`, thermals: v => `spotting at night / through smoke +${pc(v / 2)}`, spotRange: v => `spotting range +${pc(v)}`,
  accuracy: v => `rifle accuracy +${pc(v)}`, morale: v => `morale recovery +${pc(v)}`, medevac: v => `wounded survive ${pc(v)} longer`, fpvDrones: v => `+${v} drone per FPV team`, fpvHit: v => `FPV hit chance +${pc(v)}`,
  ewJam: v => `${pc(v)} of enemy FPVs jammed near own troops`, atgmAmmo: v => `+${v} missile per ATGM team`, mortar: v => `+${v} fire mission per battle`, artyAmmo: v => `SP gun shells +${pc(v)}`, reconDrone: () => 'enemy positions revealed at battle start; recon reaches 2 squares',
  repair: v => `vehicles regain ${pc(v)} of lost condition after battle`, replacementsCost: v => `replacements ${pc(-v)} cheaper`, lpGain: v => `LP income +${pc(v)}` };
function pc(v) { return `${Math.round(v * 100)}%`; }
export function effectLines(t) {
  if (t.kit) { const K = KITS[t.kit]; return [{ good: true, text: K.good }, ...(K.bad && !/^none/.test(K.bad) ? [{ good: false, text: K.bad }] : [])]; }
  const out = [];
  for (const [k, v] of Object.entries(t.mods || {})) if (MOD_TXT[k]) out.push({ good: true, text: MOD_TXT[k](v) });
  return out;
}
