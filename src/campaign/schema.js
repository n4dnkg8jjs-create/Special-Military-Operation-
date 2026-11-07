// Campaign data contract (both factions). Content lives in content_ua.js / content_ru.js, the rules in state.js,
// the strategic screen in ui.js. Everything here is plain data so campaigns can be authored without touching code.
//
// The player commands ONE brigade's operational sector (not the whole front): a strategic map of that sector
// (~15–25 km wide) made of sectors (villages, farms, tree lines, heights, crossroads, a small town). Each turn is
// roughly a day. Higher command issues DIRECTIVES that change as the operation unfolds. Battles are fought on the
// RTS maps; their outcome moves the front line in the sector.
//
// Logistics points (LP) are the only currency: earned in battles (objectives held, enemy losses, directive
// completion) and spent ORDERING things from higher command — replacements, new units and tech-tree unlocks
// (which take a turn or more to arrive).
//
// CampaignDef = {
//   id: 'UA' | 'RU', title, subtitle, brigade: { name, short, emblem? }, region, intro: [paragraphs],
//   map: {                                   // strategic map drawing, coordinates in map units (0..w, 0..h), north up
//     w, h,
//     rivers: [{ name?, pts: [[x,y]...], width }], roads: [{ kind: 'highway'|'road'|'track', pts: [[x,y]...] }],
//     forests: [[[x,y]...]], fields?: [[[x,y]...]], rail?: [{ pts }], labels?: [{ x, y, text, size }],
//     enemyEdge: 'north'|'south'|'east'|'west',   // where the enemy's rear is
//   },
//   sectors: [{
//     id, name, x, y,                        // map position (centre)
//     type: 'village'|'town'|'farm'|'fields'|'forest'|'height'|'crossroads'|'industrial',
//     battleMap: 'city'|'farmland',          // which RTS map a battle here uses (urban -> city, rural -> farmland)
//     owner: 'player'|'enemy',               // at the start
//     adj: [sectorId...],                    // neighbours (attacks only between neighbours)
//     vp: number,                            // importance (directive scoring / LP yield per turn held)
//     lp: number,                            // LP per turn while held (supply hubs, roads)
//     fort: 0..3,                            // field fortification level (trenches/strongpoints in the battle)
//     garrison: number,                      // enemy strength 0..3 if enemy-held at the start (companies-ish)
//     notes?: string,
//   }],
//   start: { turn: 1, lp: number, hq: sectorId, force: [UnitRecord...], unlocked: [techId...], available: [unitKey...] },
//   directives: [{                         // issued by higher command; one or two are active at a time
//     id, issue: { turn?: n, after?: directiveId, when?: 'captured:<sectorId>'|'lost:<sectorId>' },
//     title, from: 'Brigade HQ'|'OSUV/OSGT ...'|..., text,            // in-world order text
//     kind: 'capture'|'hold'|'destroy'|'recon'|'survive',
//     targets: [sectorId...], count?: n,     // e.g. destroy N vehicles, hold for N turns
//     deadline: turns,                       // turns after issue
//     reward: { lp, unlock?: [techId...], units?: [UnitRecord...] }, penalty?: { lp },
//     next?: { success?: directiveId, failure?: directiveId },
//   }],
//   enemy: {                               // the opposing side's behaviour in the sector
//     pressure: [per-turn counterattack chance 0..1 ...], reinforce: [per-turn strength added ...],
//     forceTemplates: { [name]: [EnemyUnit...] },  // battle compositions by strength level 1..3
//     fpvThreat?: 0..1, artillery?: 0..1,
//   },
//   catalog: [{                            // what can be ORDERED from higher command with LP
//     key, label, desc, kind: 'mech'|'imech'|'tank'|'assault'|'atgm'|'fpv'|'spg'|'replacements',
//     vehicle?: 'btr'|'ifv'|'tank'|'spg', men?: n, lp: cost, eta: turns, req?: [techId...], limit?: n,
//   }],
//   tech: [{                               // tech tree: unit unlocks and upgrades, ordered with LP
//     id, name, branch: 'Infantry'|'Armour'|'Drones & EW'|'Fires'|'Logistics'|..., desc, lp, eta?: turns,
//     req: [techId...], kind: 'unlock'|'upgrade',
//     unlock?: [catalogKey...],             // for kind 'unlock'
//     mods?: { [modKey]: value },           // for kind 'upgrade' — see MODS below
//   }],
// }
//
// UnitRecord (persistent, carried between battles) = {
//   uid, key (catalog key), name, kind: 'mech'|'imech'|'tank'|'assault'|'atgm'|'fpv'|'spg',
//   men: n, menMax: n, wounded: n,          // wounded return after 1–2 turns
//   veh?: { kind: 'btr'|'ifv'|'tank'|'spg', hp: 0..1, lost: bool }, xp: 0..,  // veterancy: 0 green, 1 trained, 2 veteran, 3 elite
//   battles: n, kills: n, status: 'ready'|'refit'|'arriving', eta?: turns,
// }
// EnemyUnit = { kind: 'mech'|'imech'|'foot'|'assault'|'tank'|'atgm'|'fpv'|'spg'|'defend', obj?: 'A'|'B'|... }
//
// MODS (upgrade effects the battle code understands; values are multipliers unless noted):
export const MODS = {
  armorPlate: 'body armour plate coverage (+fraction)',
  helmet: 'helmet stop chance (+fraction)',
  thermals: 'infantry/vehicle spotting range multiplier at night/smoke and vs foliage',
  spotRange: 'spotting range multiplier',
  accuracy: 'small-arms accuracy multiplier',
  morale: 'morale recovery multiplier',
  medevac: 'bleed-out time multiplier (wounded survive longer)',
  medTreat: 'buddy-aid treatment time reduction (fraction, squad.js)',
  medTrip: 'medevac round trip to the aid station shortened (fraction, medevac.js)',
  medSave: 'wounded dying of wounds after the battle reduced (fraction, campaignBattle.js collectResult / auto-resolve)',
  copeCage: 'chance a top-attack drone is defeated by cages (+fraction)',
  era: 'tank ERA effectiveness vs HEAT (+fraction)',
  fpvDrones: 'drones per FPV team (+count)',
  fpvHit: 'FPV hit chance multiplier',
  ewJam: 'chance enemy FPVs are jammed in your area (0..1)',
  atgmAmmo: 'ATGM team missiles (+count)',
  mortar: 'mortar fire missions per battle (+count)',
  artyAmmo: 'SPG shells multiplier',
  reconDrone: 'recon drone: enemy units revealed at battle start (bool)',
  repair: 'vehicle repair after battle (+fraction of lost hp)',
  replacementsCost: 'LP cost multiplier for replacements',
  lpGain: 'LP earned multiplier',
};
