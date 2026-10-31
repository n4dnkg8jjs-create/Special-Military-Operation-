// Map definitions. Coordinates in world metres, north (−Z) is the attacker's side, the player deploys in the south.
// Building rows: x, z, rot, modules, floors, depthModules, sections, kind, predamage, opts
const E_C = 520 / 2 + 2;
const E_F = 900 / 2 + 2;

export const MAPS = {
  city: {
    id: 'city', name: 'Novozavodsk', blurb: 'Shelled-out Soviet panel-block microdistrict. Tight street-to-street fighting, collapsible blocks, garrisons.',
    size: 'Medium', sizeM: 520, bounds: 245, kind: 'urban',
    // A planned Soviet microdistrict (mikrorayon) as it looked by 2022: arterial Prospekt Myru and vul. Zavodska
    // cut the district into four superblocks; inside, narrow driveways loop between parallel rows of five-storeys,
    // nine-storey slabs with shops line the avenue, the school and kindergartens sit in the green courtyards,
    // garages and boiler houses at the edges. Some blocks have renovated insulated facades (pastel tints).
    roads: [
      { x0: -E_C, x1: E_C, z0: -10, z1: 10, w: 'avenue' },         // Prospekt Myru (E–W arterial)
      { x0: 78, x1: 92, z0: -E_C, z1: E_C },                       // vul. Zavodska (N–S arterial)
      { x0: -E_C, x1: E_C, z0: -201, z1: -193 },                   // northern outskirts lane
      { x0: -E_C, x1: E_C, z0: 193, z1: 201 },                     // southern outskirts lane
      { x0: -208, x1: -200, z0: -E_C, z1: E_C },                   // western ring road
      { x0: 198, x1: 206, z0: -E_C, z1: E_C },                     // eastern ring road
      // internal driveways (proizdy): loops off the arterials, not a through grid
      { x0: -200, x1: -20, z0: -116, z1: -110, type: 'drive' }, { x0: -98, x1: -92, z0: -110, z1: -10, type: 'drive' }, { x0: -26, x1: -20, z0: -116, z1: -10, type: 'drive' },
      { x0: 92, x1: 198, z0: -112, z1: -106, type: 'drive' }, { x0: 140, x1: 146, z0: -106, z1: -10, type: 'drive' },
      { x0: -200, x1: -20, z0: 104, z1: 110, type: 'drive' }, { x0: -98, x1: -92, z0: 10, z1: 104, type: 'drive' }, { x0: -26, x1: -20, z0: 10, z1: 110, type: 'drive' },
      { x0: 92, x1: 198, z0: 104, z1: 110, type: 'drive' }, { x0: 140, x1: 146, z0: 10, z1: 104, type: 'drive' },
    ],
    objectives: [
      { id: 'A', name: 'School No. 7', x: -62, z: 50 },
      { id: 'B', name: 'Market Crossroads', x: 95, z: 12 },
    ],
    deployZones: {
      player: { x0: -240, x1: 240, z0: 203, z1: 250 },
      enemy: { x0: -240, x1: 240, z0: -250, z1: -203 },
    },
    spawns: {
      attacker: [[-95, -240], [85, -240], [-30, -235], [150, -238]],
      defender: [[-95, 240], [85, 240], [0, 235]],
    },
    buildings: [
      // NW superblock — avenue frontage (nine-storeys with shops), interior rows, kindergarten, north row
      [-172, -22, 0, 14, 9, 4, 3, 'nine', 1.0, { shops: true }], [-125, -22, 0, 12, 9, 4, 3, 'nine', 1.2, { shops: true, tint: 0xe3d3b4 }],
      [-59, -22, 0, 18, 9, 4, 3, 'nine', 1.3, { shops: true }], [24, -22, 0, 16, 5, 4, 3, 'khrushchyovka', 1.3, { shops: true }],
      [-184, -66, Math.PI / 2, 12, 5, 4, 3, 'khrushchyovka', 0.9], [-152, -66, Math.PI / 2, 12, 5, 4, 3, 'brick', 1.1], [-120, -66, Math.PI / 2, 12, 5, 4, 3, 'khrushchyovka', 1.0, { tint: 0xd8c8b8 }],
      [-59, -74, 0, 10, 2, 5, 2, 'school', 1.0, { tint: 0xe9d6b6 }],                    // kindergarten No. 12 (renovated)
      [12, -72, Math.PI / 2, 12, 5, 4, 3, 'khrushchyovka', 1.4], [58, -62, 0, 6, 14, 6, 1, 'tower', 1.3, { tint: 0xd6dadb }],
      [-150, -150, 0, 15, 5, 4, 3, 'brick', 1.0], [-60, -150, 0, 18, 9, 4, 3, 'nine', 1.2], [20, -152, 0, 15, 5, 4, 3, 'khrushchyovka', 0.9],
      // NE superblock
      [118, -22, 0, 6, 2, 3, 1, 'shop', 1.0, { shops: true }], [172, -22, 0, 12, 5, 4, 3, 'brick', 1.2, { shops: true }],
      [172, -66, Math.PI / 2, 12, 9, 4, 3, 'nine', 1.0], [116, -78, 0, 12, 5, 4, 3, 'khrushchyovka', 1.1, { tint: 0xe0cdb9 }],
      [145, -150, Math.PI / 2, 15, 5, 4, 3, 'khrushchyovka', 0.8], [180, -150, Math.PI / 2, 12, 9, 4, 3, 'nine', 1.0],
      // SW superblock — school No. 7 (objective A) in the courtyard
      [-172, 22, Math.PI, 14, 9, 4, 3, 'nine', 1.1, { shops: true, tint: 0xddd0bb }], [-125, 22, Math.PI, 12, 5, 4, 3, 'brick', 1.0, { shops: true }],
      [-60, 40, Math.PI, 10, 3, 4, 2, 'school', 1.0], [-78, 62, Math.PI / 2, 6, 3, 4, 1, 'school', 0.9],
      [24, 22, Math.PI, 16, 5, 4, 3, 'khrushchyovka', 1.2, { shops: true }],
      [-184, 66, Math.PI / 2, 12, 5, 4, 3, 'khrushchyovka', 1.0], [-152, 66, Math.PI / 2, 12, 5, 4, 3, 'brick', 0.9], [-120, 66, Math.PI / 2, 12, 5, 4, 3, 'khrushchyovka', 1.1, { tint: 0xe6d2c0 }],
      [30, 72, 0, 10, 2, 5, 2, 'school', 0.9, { tint: 0xd9dcc8 }],                       // kindergarten No. 31
      [62, 66, Math.PI / 2, 10, 9, 4, 2, 'nine', 1.0],
      [-150, 150, 0, 15, 5, 4, 3, 'khrushchyovka', 0.6], [-60, 150, 0, 18, 9, 4, 3, 'nine', 0.7, { tint: 0xe2d6c2 }], [20, 150, 0, 12, 5, 4, 3, 'brick', 0.6],
      // SE superblock — market square at the crossroads (objective B)
      [118, 24, Math.PI, 6, 2, 3, 1, 'shop', 1.0, { shops: true }], [172, 22, Math.PI, 12, 5, 4, 3, 'khrushchyovka', 0.9, { shops: true }],
      [116, 80, 0, 12, 5, 4, 3, 'brick', 0.8], [172, 66, Math.PI / 2, 12, 9, 4, 3, 'nine', 1.0, { tint: 0xd5d9da }],
      [120, 150, Math.PI / 2, 12, 5, 4, 3, 'khrushchyovka', 0.5], [172, 150, 0, 6, 12, 6, 1, 'tower', 0.6],
      // beyond the ring roads: the neighbouring microdistricts
      [232, -150, Math.PI / 2, 12, 9, 4, 3, 'nine', 1.0], [232, -45, 0, 6, 16, 6, 1, 'tower', 1.1], [232, 72, Math.PI / 2, 14, 5, 4, 3, 'brick', 0.8],
      [232, 160, 0, 6, 12, 6, 1, 'tower', 0.6], [-232, -150, Math.PI / 2, 14, 5, 4, 3, 'brick', 1.0], [-232, -45, 0, 6, 16, 6, 1, 'tower', 1.2],
      [-232, 60, Math.PI / 2, 15, 9, 4, 3, 'nine', 0.9], [-232, 160, 0, 6, 12, 6, 1, 'tower', 0.5],
    ],
    pancakes: [[2, 7, 9], [11, 11, 13]],
    // courtyard furniture plan (used by the city dressing): playgrounds, garage cooperatives, boiler houses
    yards: { playgrounds: [[-168, -66, Math.PI / 2], [-136, -66, Math.PI / 2], [-168, 66, Math.PI / 2], [-136, 66, Math.PI / 2], [30, 96, 0], [145, 66, 0], [-59, -98, 0]],
      garages: [[-172, -178, 0], [-108, -178, 0], [-176, 177, Math.PI], [118, -180, 0]], boilers: [[62, -176, 0], [176, 176, Math.PI]],
      markets: [[110, 46, Math.PI], [122, 46, Math.PI], [128, 58, 0]] },
    lineup: [[-112, 188, 'btr', '1st Squad'], [50, 186, 'btr', '2nd Squad'], [-6, 186, 'btr', '3rd Squad'], [-30, 187, 'tank', 'Assault Squad'], [140, 188, 'tank', null]],
    ai: {
      staging: { A: [[-62, -38], [-95, -52], [-23, -40], [-108, -40]], B: [[85, -62], [143, -40], [60, -40], [150, -32]] },
      overwatch: { A: [[-95, -70], [-10, -40]], B: [[85, -95], [143, -60]] },
      army: [[-95, -168, 'mech', 'A'], [-30, -172, 'assault', 'A'], [85, -168, 'mech', 'B'], [130, -172, 'foot', 'B'], [-60, -180, 'tank', 'A'], [40, -180, 'tank', 'B']],
    },
    smoulder: [[-152, -66, 1.2], [12, -72, 1.4], [-59, -22, 1], [145, -150, 0.8], [172, 66, 0.7]],
    plumes: [[-320, -380, 1.4], [260, -420, 1.8], [420, -120, 1.1], [-460, 60, 1.2], [80, -520, 2.2]],
    cam: [0, 140, 150], fog: 0.0021, ambience: 'ambience_city',
  },
  farmland: {
    id: 'farmland', name: 'Novomykolaivka Fields', blurb: 'Open steppe farmland cut by tree-line windbreaks, two villages and a kolkhoz farm. Long sightlines, cratered fields.',
    size: 'Large', sizeM: 900, bounds: 430, kind: 'rural',
    roads: [
      { x0: -E_F, x1: E_F, z0: 60, z1: 67, type: 'paved' },      // regional road / village street (E–W)
      { x0: 100, x1: 107, z0: -E_F, z1: E_F, type: 'paved' },    // N–S road through Kurylivka
      { x0: -E_F, x1: E_F, z0: -297, z1: -292, type: 'track' },  // field tracks along the windbreaks
      { x0: -E_F, x1: E_F, z0: 303, z1: 308, type: 'track' },
      { x0: -362, x1: -357, z0: -E_F, z1: E_F, type: 'track' },
      { x0: 357, x1: 362, z0: -E_F, z1: E_F, type: 'track' },
      { x0: -127, x1: -122, z0: 67, z1: 303, type: 'track' },
      { x0: 222, x1: 227, z0: -292, z1: 60, type: 'track' },
      { x0: 107, x1: 357, z0: -146, z1: -141, type: 'track' },
    ],
    objectives: [
      { id: 'A', name: 'Village School', x: -168, z: 86 },
      { id: 'B', name: 'Kolkhoz Farm', x: 262, z: 112 },
    ],
    deployZones: {
      player: { x0: -420, x1: 420, z0: 380, z1: 442 },
      enemy: { x0: -420, x1: 420, z0: -442, z1: -380 },
    },
    spawns: {
      attacker: [[-220, -440], [103, -440], [280, -438], [-60, -436]],
      defender: [[-124, 440], [103, 440], [260, 438]],
    },
    buildings: [
      // Novomykolaivka (west village, along the E–W road)
      [-168, 101, 0, 10, 2, 4, 2, 'school', 0.8], [-95, 50, Math.PI, 6, 2, 3, 1, 'shop', 1.0, { shops: true }],
      [-250, 48.5, Math.PI, 8, 2, 4, 2, 'brick', 0.9], [-30, 103, 0, 8, 3, 4, 2, 'khrushchyovka', 1.1],
      // Kurylivka (north-east village, along the N–S road)
      [117, -172, -Math.PI / 2, 6, 2, 3, 1, 'shop', 1.1, { shops: true }], [89, -105, Math.PI / 2, 8, 2, 4, 2, 'brick', 1.2],
      [89, -205, Math.PI / 2, 10, 2, 4, 2, 'khrushchyovka', 1.0],
    ],
    pancakes: [],
    // windbreak tree lines (centre line); gaps are left where roads and tracks cross
    treelines: [
      [-E_F, -335, E_F, -335], [-E_F, -175, 60, -175], [150, -175, E_F, -175], [-E_F, -22, 60, -22], [150, -22, E_F, -22],
      [-E_F, 190, E_F, 190], [-E_F, 335, E_F, 335],
      [-395, -E_F, -395, E_F], [-20, -175, -20, -22], [10, 190, 10, 335], [390, -E_F, 390, E_F], [180, -335, 180, -175],
    ],
    villages: [
      { street: 'x', z0: 60, z1: 67, from: -330, to: -10, depth: 42, name: 'Novomykolaivka' },
      { street: 'z', x0: 100, x1: 107, from: -250, to: -60, depth: 40, name: 'Kurylivka' },
    ],
    farm: { x: 262, z: 112 },
    lineup: [[-150, 402, 'btr', '1st Squad'], [60, 402, 'btr', '2nd Squad'], [-40, 402, 'btr', '3rd Squad'], [-95, 412, 'tank', 'Assault Squad'], [200, 406, 'tank', null]],
    ai: {
      staging: { A: [[-170, -45], [-240, -50], [-110, -42], [-290, -35]], B: [[262, -45], [205, -50], [320, -40], [160, -38]] },
      overwatch: { A: [[-210, -75], [-130, -80]], B: [[250, -80], [310, -75]] },
      army: [[-180, -405, 'mech', 'A'], [-110, -410, 'assault', 'A'], [180, -405, 'mech', 'B'], [250, -410, 'foot', 'B'], [-150, -425, 'tank', 'A'], [210, -425, 'tank', 'B']],
    },
    smoulder: [[-250, 48, 0.9], [89, -105, 1.0], [-30, 103, 0.8]],
    plumes: [[-600, -720, 1.6], [520, -680, 2.0], [820, 120, 1.2], [-780, 300, 1.3], [150, -900, 2.4]],
    cam: [-40, 360, 170], fog: 0.0015, ambience: 'ambience_wind',
  },
};
