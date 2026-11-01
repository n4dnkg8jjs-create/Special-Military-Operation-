// Map definitions. Coordinates in world metres, north (−Z) is the attacker's side, the player deploys in the south.
// Building rows: x, z, rot, modules, floors, depthModules, sections, kind, predamage, opts
const E_C = 520 / 2 + 2;
const E_F = 1400 / 2 + 2;

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
      [172, -22, 0, 12, 5, 4, 3, 'brick', 1.2, { shops: true }],
      [172, -66, Math.PI / 2, 12, 9, 4, 3, 'nine', 1.0], [116, -92, 0, 12, 5, 4, 3, 'khrushchyovka', 1.1, { tint: 0xe0cdb9 }],
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
      markets: [[110, 46, Math.PI], [122, 46, Math.PI], [128, 58, 0]],
      lots: [[96, -78, 138, -46], [97, -44, 137, -17]] },
    lineup: [[-112, 188, 'btr', '1st Squad'], [50, 186, 'btr', '2nd Squad'], [-6, 186, 'ifv', '3rd Squad'], [-30, 187, 'tank', 'Assault Squad'], [140, 188, 'tank', null], [-182, 188, 'spg', null]],
    support: [[95, 194, 'atgm'], [-72, 194, 'fpv']],
    ai: {
      staging: { A: [[-62, -38], [-95, -52], [-23, -40], [-108, -40]], B: [[85, -62], [143, -40], [60, -40], [150, -32]] },
      overwatch: { A: [[-95, -70], [-10, -40]], B: [[85, -95], [143, -60]] },
      army: [[-95, -168, 'mech', 'A'], [-30, -172, 'assault', 'A'], [85, -168, 'imech', 'B'], [130, -172, 'foot', 'B'], [-60, -180, 'tank', 'A'], [40, -180, 'tank', 'B'], [10, -186, 'atgm', 'A'], [-140, -186, 'fpv', 'B'], [176, -170, 'spg', 'B']],
    },
    // improvised positions dug into the courtyard greens (spoil full of brick and concrete): a slit trench across the
    // school forecourt covering the avenue, and foxholes + an MG pit on the market crossroads' south-west corner
    fortifications: [
      { type: 'sp', id: 'A', name: 'School No. 7 forecourt', front: [0, -1], revet: 'urban', craters: 4 },
      { type: 'fire', sp: 'A', base: [[-86, 21], [-70, 22.5], [-52, 21], [-40, 22]], bayGap: 7 },
      { type: 'mg', sp: 'A', at: [-33, 18], front: [0.5, -0.86] },
      { type: 'fox', sp: 'A', pts: [[-90, 25, -0.7, -0.7], [-34, 28, 1, 0]] },
      { type: 'sp', id: 'B', name: 'Market crossroads SW corner', front: [0.6, -0.8], kind: 'outpost', revet: 'urban', craters: 3 },
      { type: 'fire', sp: 'B', base: [[56, 24], [66, 23], [72, 30]], front: [0.6, -0.8], bayGap: 6 },
      { type: 'mg', sp: 'B', at: [73, 17], front: [0.3, -0.95] },
      { type: 'fox', sp: 'B', pts: [[71, 40, 1, 0], [55, 16, 0, -1]] },
    ],
    smoulder: [[-152, -66, 1.2], [12, -72, 1.4], [-59, -22, 1], [145, -150, 0.8], [172, 66, 0.7]],
    plumes: [[-320, -380, 1.4], [260, -420, 1.8], [420, -120, 1.1], [-460, 60, 1.2], [80, -520, 2.2]],
    cam: [0, 140, 150], fog: 0.0021, ambience: 'ambience_city',
  },
  farmland: {
    id: 'farmland', name: 'Novomykolaivka Fields', blurb: 'Open steppe farmland cut by tree-line windbreaks, a forest block, two villages, a kolkhoz farm and a crossroads farmstead. Trench lines in the tree belts, long sightlines, cratered fields.',
    size: 'Large', sizeM: 1400, bounds: 680, kind: 'rural',
    roads: [
      { x0: -E_F, x1: E_F, z0: 60, z1: 67, type: 'paved' },      // regional road / village street (E–W)
      { x0: 100, x1: 107, z0: -E_F, z1: E_F, type: 'paved' },    // N–S road through Kurylivka and the crossroads
      { x0: -E_F, x1: E_F, z0: -297, z1: -292, type: 'track' },  // field tracks along the windbreaks
      { x0: -E_F, x1: E_F, z0: 303, z1: 308, type: 'track' },    // ... becomes the E–W ride through the forest
      { x0: -362, x1: -357, z0: -E_F, z1: E_F, type: 'track' },
      { x0: 357, x1: 362, z0: -E_F, z1: E_F, type: 'track' },
      { x0: -127, x1: -122, z0: 67, z1: 303, type: 'track' },
      { x0: 222, x1: 227, z0: -292, z1: 60, type: 'track' },
      { x0: 107, x1: 357, z0: -146, z1: -141, type: 'track' },
      { x0: -E_F, x1: E_F, z0: -512, z1: -507, type: 'track' },  // northern field track (enemy rear)
      { x0: -357, x1: E_F, z0: 398, z1: 404, type: 'track' },    // crossroads track (objective D)
      { x0: 552, x1: 557, z0: -E_F, z1: E_F, type: 'track' },    // eastern field track
      { x0: -562, x1: -557, z0: -E_F, z1: E_F, type: 'track' },  // western track, N–S ride through the forest
      { x0: -E_F, x1: E_F, z0: 547, z1: 552, type: 'track' },    // southern track behind the screening belt
      // village lanes
      { x0: -330, x1: -40, z0: 150, z1: 155, type: 'track' },        // Novomykolaivka: vul. Sadova (south)
      { x0: -205, x1: -200, z0: -45, z1: 190, type: 'track' },       // Novomykolaivka: vul. Shkilna (cross street)
      { x0: -10, x1: 100, z0: -200, z1: -195, type: 'track' },       // Kurylivka: west lane
    ],
    // phase 1 = the forward positions on the player's approach (C, D), phase 2 = the village and the farm (A, B)
    objectives: [
      { id: 'A', name: 'Village School', x: -168, z: 86, r: 26, phase: 2 },
      { id: 'B', name: 'Kolkhoz Farm', x: 262, z: 112, r: 30, phase: 2 },
      { id: 'C', name: 'Forest Edge Strongpoint', x: -446, z: 436, r: 26, phase: 1 },
      { id: 'D', name: 'Crossroads Farmstead', x: 140, z: 378, r: 26, phase: 1 },
    ],
    deployZones: {
      player: { x0: -680, x1: 680, z0: 612, z1: 692 },
      enemy: { x0: -680, x1: 680, z0: -692, z1: -612 },
    },
    spawns: {
      attacker: [[-360, -690], [103, -690], [360, -688], [-120, -686], [555, -688]],
      defender: [[-124, 690], [103, 690], [360, 688], [-560, 690]],
    },
    buildings: [
      // Novomykolaivka (west village, along the E–W road)
      [-168, 101, 0, 10, 2, 4, 2, 'school', 0.8], [-95, 50, Math.PI, 6, 2, 3, 1, 'shop', 1.0, { shops: true }],
      [-250, 48.5, Math.PI, 8, 2, 4, 2, 'brick', 0.9], [-30, 103, 0, 8, 3, 4, 2, 'khrushchyovka', 1.1],
      // Kurylivka (north-east village, along the N–S road)
      [117, -172, -Math.PI / 2, 6, 2, 3, 1, 'shop', 1.1, { shops: true }], [89, -105, Math.PI / 2, 8, 2, 4, 2, 'brick', 1.2],
      [89, -225, Math.PI / 2, 10, 2, 4, 2, 'khrushchyovka', 1.0],
      // village club and the second shop on the new streets
      [-222, 118, Math.PI / 2, 8, 2, 4, 2, 'brick', 0.9], [-150, 168, 0, 6, 2, 3, 1, 'shop', 0.8, { shops: true }],
      // crossroads farmstead (objective D): the brigade office / shop on the corner
      [82, 382, Math.PI / 2, 6, 2, 3, 1, 'shop', 1.2, { shops: true }],
    ],
    pancakes: [],
    // windbreak tree lines (centre line); gaps are left where roads and tracks cross
    treelines: [
      [-E_F, -560, E_F, -560], [-E_F, -335, E_F, -335], [-E_F, -175, 60, -175], [150, -175, E_F, -175], [-E_F, -22, 60, -22], [150, -22, E_F, -22],
      [-398, 190, E_F, 190], [-398, 335, E_F, 335], [-E_F, 540, E_F, 540],
      [-395, -E_F, -395, 66], [-395, 470, -395, E_F], [-20, -175, -20, -22], [10, 190, 10, 335], [390, -E_F, 390, E_F], [180, -335, 180, -175],
      [563, -E_F, 563, E_F], [-640, -E_F, -640, 56], [-640, 470, -640, E_F], [230, 404, 230, 540],
    ],
    // mixed broadleaf woodland block (oak / robinia / poplar, hazel-elder understorey), ragged edges, rides, clearings
    forest: { x0: -690, x1: -405, z0: 72, z1: 455, clearings: [[-610, 190, 26], [-470, 250, 17], [-640, 395, 21], [-520, 350, 12]] },
    villages: [
      { street: 'x', z0: 60, z1: 67, from: -340, to: -10, depth: 42, name: 'Novomykolaivka' },
      { street: 'x', z0: 150, z1: 155, from: -330, to: -45, depth: 30, name: 'Novomykolaivka' },
      { street: 'z', x0: -205, x1: -200, from: -42, to: 186, depth: 34, name: 'Novomykolaivka' },
      { street: 'z', x0: 100, x1: 107, from: -260, to: -55, depth: 40, name: 'Kurylivka' },
      { street: 'x', z0: -146, z1: -141, from: 112, to: 235, depth: 32, name: 'Kurylivka' },
      { street: 'x', z0: -200, z1: -195, from: -8, to: 96, depth: 30, name: 'Kurylivka' },
      { street: 'x', z0: 398, z1: 404, from: 20, to: 92, depth: 30, name: 'Khutir Perekhrestia', side: -1 },
    ],
    farm: { x: 262, z: 112 },
    farmstead: { x: 150, z: 372 },   // objective D: private farm at the crossroads (yard north-east of the junction)
    // Field fortifications (terrain.js cuts them into the ground), laid out as 2023-25 positions: platoon / squad
    // strongpoints of short hand-dug trench segments, foxholes and covered MG pits in the tree lines and at the
    // village / farm edges, all-round, covering the roads, the gaps between tree belts and the field crossings, with
    // dugouts behind and crawl / communication trenches back into cover; forward and flank outposts; and one
    // continuous machine-dug line only where it belongs (the enemy's rear 'Surovikin' line: AT ditch, dragon's teeth).
    //   sp:   strongpoint header (id, name, front = main facing towards the enemy, kind, revet, craters, yard)
    //   fire: trench segment (style 'rough' hand-dug meander with dog-legs, 'zigzag' machine-dug 'lomanaya'),
    //         bayGap = firing cells every ~n m; dug = dugouts at baseline fractions, mg = covered MG cells there
    //   fox:  foxholes [x, z, fx, fz]; mg: MG pit with a log roof at `at` facing `front` (crawl trench to the nearest
    //         trench); dug: dugout near `at` (passage from the nearest trench); comm: communication trench
    //   revet: 'rough' (sparse scrap), 'crude' (more scrap), 'logs' (forest), 'eng' (wire mesh), 'urban', 'none'
    fortifications: [
      // ---- A: Novomykolaivka. North edge in the rear of the windbreak (old positions facing the enemy line), three
      //      platoon positions 120-150 m apart with the gaps covered by MG; the school yard; the south tree belt.
      { type: 'sp', id: 'A1', name: 'Novomykolaivka NW edge', front: [0, -1], revet: 'crude' },
      { type: 'fire', sp: 'A1', base: [[-326, -12], [-306, -13.5], [-284, -12]], bayGap: 8 },
      { type: 'mg', sp: 'A1', at: [-332, -16], front: [-0.6, -0.8] },
      { type: 'fox', sp: 'A1', pts: [[-299, -3, 0, -1], [-276, -6, 0.7, -0.7], [-337, -3, -1, 0.15]] },
      { type: 'dug', sp: 'A1', at: [-308, -3] }, { type: 'comm', sp: 'A1', pts: [[-296, -12], [-294, 17]] },
      { type: 'sp', id: 'A2', name: 'Novomykolaivka north - Shkilna gap', front: [0, -1], revet: 'crude' },
      { type: 'fire', sp: 'A2', base: [[-158, -12], [-140, -13.5], [-118, -12]], bayGap: 8 },
      { type: 'mg', sp: 'A2', at: [-160, -17], front: [-0.75, -0.66] },
      { type: 'fox', sp: 'A2', pts: [[-128, -3, 0, -1], [-111, -6, 0.6, -0.8]] },
      { type: 'dug', sp: 'A2', at: [-140, -3] }, { type: 'comm', sp: 'A2', pts: [[-136, -12], [-137, 17]] },
      { type: 'sp', id: 'A3', name: 'Novomykolaivka NE corner', front: [0, -1], revet: 'crude' },
      { type: 'fire', sp: 'A3', base: [[-84, -12], [-62, -13.5], [-40, -12]], bayGap: 8 },
      { type: 'mg', sp: 'A3', at: [-34, -16], front: [-0.15, -1] },
      { type: 'fox', sp: 'A3', pts: [[-8, -13, 0.7, -0.7], [-5, 1, 1, 0], [-52, -3, 0, -1]] },
      { type: 'dug', sp: 'A3', at: [-64, -3] }, { type: 'comm', sp: 'A3', pts: [[-58, -12], [-57, 17]] },
      { type: 'sp', id: 'A4', name: 'School yard', front: [0, -1], revet: 'crude', yard: true, craters: 3 },
      { type: 'fire', sp: 'A4', base: [[-186, 76], [-175, 77.5], [-163, 76]], bayGap: 6 },
      { type: 'mg', sp: 'A4', at: [-151, 72.5], front: [1, -0.1] },
      { type: 'fox', sp: 'A4', pts: [[-193, 74, -1, 0], [-146, 81, 1, 0.2]] },
      { type: 'dug', sp: 'A4', at: [-175, 86] },
      { type: 'sp', id: 'A5', name: 'Novomykolaivka south belt', front: [0, 1], revet: 'rough', yard: true },
      { type: 'fire', sp: 'A5', base: [[-178, 191], [-158, 192.5], [-140, 191]], bayGap: 8 },
      { type: 'mg', sp: 'A5', at: [-135, 196], front: [0.45, 0.9] },
      { type: 'fox', sp: 'A5', pts: [[-112, 196, 0, 1], [-186, 197, -0.3, 1]] },
      { type: 'dug', sp: 'A5', at: [-160, 183] }, { type: 'comm', sp: 'A5', pts: [[-152, 191], [-151, 170]] },
      // ---- B: kolkhoz farm. Forward edge in the north windbreak either side of the farm track, an east flank
      //      position between the field track and the east belt, the south belt, a road block on the west road.
      { type: 'sp', id: 'B1', name: 'Kolkhoz north belt', front: [0, -1], revet: 'rough' },
      { type: 'fire', sp: 'B1', base: [[188, -12], [208, -13.5], [230, -12], [252, -13.5], [268, -12]], bayGap: 8 },
      { type: 'mg', sp: 'B1', at: [214, -17], front: [0.35, -0.94] },
      { type: 'fox', sp: 'B1', pts: [[180, -4, -0.7, -0.7], [276, -4, 0.6, -0.8], [238, 3, 0, -1]] },
      { type: 'dug', sp: 'B1', at: [200, -2] }, { type: 'dug', sp: 'B1', at: [258, -2] },
      { type: 'comm', sp: 'B1', pts: [[248, -12], [250, 40]] },
      { type: 'sp', id: 'B2', name: 'Kolkhoz east flank', front: [1, 0], revet: 'rough' },
      { type: 'fire', sp: 'B2', base: [[374, 76], [376.5, 95], [373, 114]], bayGap: 8 },
      { type: 'mg', sp: 'B2', at: [378, 71], front: [0.8, -0.6] },
      { type: 'fox', sp: 'B2', pts: [[371, 128, 0.7, 0.7], [380, 50, 0.6, -0.8]] },
      { type: 'dug', sp: 'B2', at: [374, 124] },
      { type: 'sp', id: 'B3', name: 'Kolkhoz south belt', front: [0, 1], revet: 'rough' },
      { type: 'fire', sp: 'B3', base: [[190, 191], [212, 192.5], [236, 191]], bayGap: 8 },
      { type: 'mg', sp: 'B3', at: [244, 196], front: [0.4, 0.92] },
      { type: 'fox', sp: 'B3', pts: [[182, 197, -0.5, 0.87], [262, 196, 0.2, 1], [298, 195, 0, 1]] },
      { type: 'dug', sp: 'B3', at: [214, 182] },
      { type: 'sp', id: 'B4', name: 'Kolkhoz west road block', front: [-1, 0], kind: 'outpost', revet: 'rough', craters: 4 },
      { type: 'fire', sp: 'B4', base: [[152, 74], [151, 88]], bayGap: 6 },
      { type: 'fox', sp: 'B4', pts: [[155, 52, -0.8, -0.6], [149, 97, -0.8, 0.6]] },
      // ---- C: forest edge strongpoint. Trench 10-15 m inside the trees (cover from drones), firing cells at the edge,
      //      an MG on the corner covering both the southern fields and the track junction; the west part of the south
      //      edge covers the forest ride; outposts on the east edge and forward in the tree belt south of the corner.
      { type: 'sp', id: 'C1', name: 'Forest corner', front: [0, 1], revet: 'logs' },
      { type: 'fire', sp: 'C1', base: [[-474, 442], [-452, 443.5], [-432, 441], [-423, 436]], bayGap: 8 },
      { type: 'fire', sp: 'C1', base: [[-418, 429], [-416.5, 412], [-419, 396]], front: [1, 0], bayGap: 8 },
      { type: 'mg', sp: 'C1', at: [-420, 447], front: [0.7, 0.7] },
      { type: 'fox', sp: 'C1', pts: [[-487, 446, 0, 1], [-412, 383, 1, 0.2], [-441, 449, 0, 1]] },
      { type: 'dug', sp: 'C1', at: [-452, 431] }, { type: 'dug', sp: 'C1', at: [-430, 424] },
      { type: 'comm', sp: 'C1', pts: [[-447, 442], [-450, 400]] },
      { type: 'sp', id: 'C2', name: 'Forest south edge - ride', front: [0, 1], revet: 'logs' },
      { type: 'fire', sp: 'C2', base: [[-547, 443], [-530, 444.5], [-512, 442]], bayGap: 8 },
      { type: 'mg', sp: 'C2', at: [-551, 447], front: [-0.45, 0.9] },
      { type: 'fox', sp: 'C2', pts: [[-500, 447, 0, 1], [-567, 439, -1, 0.3]] },
      { type: 'dug', sp: 'C2', at: [-530, 432] },
      { type: 'sp', id: 'C3', name: 'Forest east edge outpost', front: [1, 0], kind: 'outpost', revet: 'logs', craters: 4 },
      { type: 'fire', sp: 'C3', base: [[-417, 372], [-416, 357], [-418, 344]], bayGap: 7 },
      { type: 'fox', sp: 'C3', pts: [[-412, 331, 0.8, -0.6], [-411, 389, 1, 0]] },
      { type: 'sp', id: 'C4', name: 'Tree belt forward outpost', front: [0, 1], kind: 'outpost', revet: 'rough', craters: 5 },
      { type: 'fire', sp: 'C4', base: [[-402, 524], [-388, 525]], bayGap: 6 },
      { type: 'fox', sp: 'C4', pts: [[-398, 510, -0.8, 0.6], [-391, 512, 0.8, 0.6]] },
      // ---- D: crossroads farmstead. Positions either side of the N-S road south of the track with crossing MG fire
      //      down the road, the head of the east tree belt on the flank, and a forward outpost down that belt.
      { type: 'sp', id: 'D1', name: 'Crossroads east', front: [0, 1], revet: 'rough' },
      { type: 'fire', sp: 'D1', base: [[114, 413], [131, 414.5], [150, 413]], bayGap: 8 },
      { type: 'mg', sp: 'D1', at: [112, 420], front: [-0.3, 0.95] },
      { type: 'fox', sp: 'D1', pts: [[160, 419, 0.3, 1], [113, 432, -0.7, 0.7]] },
      { type: 'dug', sp: 'D1', at: [158, 412] },
      { type: 'sp', id: 'D2', name: 'Crossroads west - hamlet edge', front: [0, 1], revet: 'crude' },
      { type: 'fire', sp: 'D2', base: [[44, 413], [64, 414.5], [86, 413]], bayGap: 8 },
      { type: 'mg', sp: 'D2', at: [93, 419], front: [0.35, 0.94] },
      { type: 'fox', sp: 'D2', pts: [[34, 419, -0.4, 0.9], [72, 426, 0, 1]] },
      { type: 'dug', sp: 'D2', at: [36, 412] },
      { type: 'sp', id: 'D3', name: 'East belt head', front: [0, 1], revet: 'rough' },
      { type: 'fire', sp: 'D3', base: [[221, 421], [238, 422]], bayGap: 6 },
      { type: 'mg', sp: 'D3', at: [220, 431], front: [-0.6, 0.8] },
      { type: 'fox', sp: 'D3', pts: [[238, 438, 0.7, 0.7], [224, 451, -0.5, 0.85], [236, 455, 0.4, 0.9]] },
      { type: 'comm', sp: 'D3', pts: [[230, 421], [230, 409]] },
      { type: 'sp', id: 'D4', name: 'East belt forward outpost', front: [0, 1], kind: 'outpost', revet: 'rough', craters: 5 },
      { type: 'fire', sp: 'D4', base: [[223, 500], [237, 501]], bayGap: 6 },
      { type: 'fox', sp: 'D4', pts: [[226, 488, -0.6, 0.8], [235, 486, 0.6, 0.8]] },
      // ---- flank outpost at the junction of the central belts, covering the open fields between C and D
      { type: 'sp', id: 'O1', name: 'Central belt junction outpost', front: [0, 1], kind: 'outpost', revet: 'rough', craters: 5 },
      { type: 'fire', sp: 'O1', base: [[1, 343], [19, 344]], bayGap: 6 },
      { type: 'mg', sp: 'O1', at: [11, 349], front: [0, 1] },
      { type: 'fox', sp: 'O1', pts: [[-7, 347, -0.5, 0.85], [27, 348, 0.5, 0.85]] },
      // ---- enemy main line in the northern windbreak, facing south ('Surovikin' style): machine-dug zig-zag fire
      //      trenches with wire-mesh / log revetment in stretches, AT ditch, three rows of dragon's teeth
      { type: 'sp', id: 'NW', name: 'Northern line west', front: [0, 1], kind: 'line', revet: 'eng', craters: 10 },
      { type: 'fire', sp: 'NW', base: [[-334, -344], [-62, -344]], style: 'zigzag', leg: 8, amp: 2.6, bays: 2, dug: [0.2, 0.5, 0.8], mg: [0.35, 0.7] },
      { type: 'comm', sp: 'NW', pts: [[-200, -345], [-200, -400]], style: 'zigzag', link: false },
      { type: 'sp', id: 'NE', name: 'Northern line east', front: [0, 1], kind: 'line', revet: 'rough', craters: 8 },
      { type: 'fire', sp: 'NE', base: [[148, -344], [344, -344]], style: 'zigzag', leg: 8, amp: 2.6, bays: 2, dug: [0.3, 0.7], mg: [0.5] },
      { type: 'comm', sp: 'NE', pts: [[250, -345], [250, -400]], style: 'zigzag', link: false },
      { type: 'teeth', pts: [[-560, -321], [-372, -321]], rows: 3 }, { type: 'teeth', pts: [[-348, -321], [-262, -321]], rows: 3 },
      { type: 'teeth', pts: [[-228, -321], [-12, -321]], rows: 3 }, { type: 'teeth', pts: [[22, -321], [88, -321]], rows: 3 },
      { type: 'teeth', pts: [[118, -321], [244, -321]], rows: 3 }, { type: 'teeth', pts: [[276, -321], [348, -321]], rows: 3 },
      { type: 'teeth', pts: [[372, -321], [452, -321]], rows: 3 }, { type: 'teeth', pts: [[482, -321], [560, -321]], rows: 3 },
      { type: 'ditch', pts: [[-470, -307], [-268, -307]], bermSide: -1 }, { type: 'ditch', pts: [[-190, -307], [40, -307]], bermSide: -1 },
      { type: 'ditch', pts: [[150, -307], [330, -307]], bermSide: -1 },
    ],
    lineup: [[-150, 628, 'btr', '1st Squad'], [60, 628, 'btr', '2nd Squad'], [-40, 630, 'ifv', '3rd Squad'], [-95, 642, 'tank', 'Assault Squad'], [200, 636, 'tank', null], [330, 670, 'spg', null]],
    support: [[130, 646, 'atgm'], [-200, 646, 'fpv']],
    ai: {
      staging: { A: [[-170, -62], [-240, -66], [-110, -60], [-290, -52]], B: [[262, -62], [205, -66], [320, -56], [160, -54]],
        C: [[-380, 362], [-559, 292], [-382, 300], [-430, 312]], D: [[140, 296], [60, 312], [220, 312], [250, 290]] },
      overwatch: { A: [[-210, -96], [-130, -100]], B: [[250, -100], [310, -96]], C: [[-340, 318], [-380, 262]], D: [[150, 258], [62, 262]] },
      army: [[-180, -640, 'mech', 'A'], [-110, -645, 'assault', 'A'], [180, -640, 'imech', 'B'], [250, -645, 'foot', 'B'], [-150, -660, 'tank', 'A'], [210, -660, 'tank', 'B'], [40, -655, 'atgm', 'B'], [-60, -655, 'fpv', 'A'], [-330, -672, 'spg', 'A']],
    },
    smoulder: [[-250, 48, 0.9], [89, -105, 1.0], [-30, 103, 0.8], [82, 382, 0.8]],
    plumes: [[-900, -1000, 1.6], [760, -950, 2.0], [1150, 160, 1.2], [-1100, 420, 1.3], [200, -1250, 2.4]],
    cam: [-40, 560, 190], fog: 0.0012, ambience: 'ambience_wind',
  },
};
