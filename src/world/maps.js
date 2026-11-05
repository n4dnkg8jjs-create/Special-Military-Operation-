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
      { x0: -E_F, x1: E_F, z0: 321, z1: 326, type: 'track' },    // along the field side of the z 335 belt; the E–W ride through the forest
      { x0: -362, x1: -357, z0: -E_F, z1: E_F, type: 'track' },
      { x0: 357, x1: 362, z0: -E_F, z1: E_F, type: 'track' },
      { x0: -127, x1: -122, z0: 67, z1: 321, type: 'track' },    // village road -> the E-W track at z 321 (no stub in the field)
      { x0: 222, x1: 227, z0: -292, z1: 60, type: 'track' },
      { x0: 107, x1: 357, z0: -146, z1: -141, type: 'track' },
      { x0: -E_F, x1: E_F, z0: -550, z1: -545, type: 'track' },  // northern field track along the z -560 belt (enemy rear)
      { x0: -357, x1: E_F, z0: 398, z1: 404, type: 'track' },    // crossroads track (objective D)
      { x0: 552, x1: 557, z0: -E_F, z1: E_F, type: 'track' },    // eastern field track
      { x0: -562, x1: -557, z0: -E_F, z1: E_F, type: 'track' },  // western track, N–S ride through the forest
      { x0: -E_F, x1: E_F, z0: 547, z1: 552, type: 'track' },    // southern track behind the screening belt
      // village lanes
      { x0: -357, x1: -40, z0: 150, z1: 155, type: 'track' },        // Novomykolaivka: vul. Sadova (south), from the x -360 track
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

  // ================================================================ real places (src/world/real.js)
  // Layouts converted from OpenStreetMap by tools/maps_real/osm2map.py (src/world/real/*_osm.js): streets, house plots,
  // panel blocks, industrial buildings, rail, tree belts, fields, streams.  Map data (c) OpenStreetMap contributors, ODbL.
  // Frame: metres from the map centre, x east / z south as usual, but rotated so the real attacker comes from the
  // player's (south, +Z) edge: Robotyne is turned 180 deg (real north = +Z), Avdiivka is not (real south = +Z).
  robotyne: {
    id: 'robotyne', name: 'Robotyne', real: 'robotyne', kind: 'rural', size: 'Large', sizeM: 1400, bounds: 680, seed: 4723,
    // the battle frame's real centre (src/world/real/robotyne_osm.js): the campaign map draws it on the grid square it covers
    geo: { lat: 47.4437, lon: 35.8316 },
    blurb: 'The real village of Robotyne on the T-04-08 Orikhiv - Tokmak road (Zaporizhzhia oblast, summer 2023): long streets of ruined farmhouses and garden strips, the school, the kolkhoz yard, tree belts and balkas, the dug-in line west of the highway. The attack comes from the north (Mala Tokmachka side). Map data © OpenStreetMap contributors (ODbL).',
    sub: 'Real place · village, fields · OSM layout', credit: 'Map data © OpenStreetMap contributors (ODbL)', north: [0, 1],
    roads: [], buildings: [], pancakes: [],
    // windbreaks / tree belts seen on the ground but missing from OSM (polylines, game frame)
    belts: [[[279, -650], [283, -420], [288, -190], [292, 20], [300, 140]], [[-60, 556], [60, 552], [150, 560]], [[-420, 590], [-330, 572]]],
    damage: { rubble: 0.36, burnt: 0.3 },
    // churned vehicle trails: the UA approaches from the north edge (field edges, tree belts, the highway verge) and the
    // Russian supply tracks from the south
    trails: [
      { w: 4.4, mud: 0.85, pts: [[40, 700], [24, 610], [-20, 540], [-110, 492], [-150, 468]] },                    // into the kolkhoz yard
      { w: 4.2, mud: 0.8, pts: [[245, 700], [262, 600], [262, 470], [258, 330], [262, 190], [258, 100], [258, 0], [262, -38]] },   // down the belt to the E-W road
      { w: 4.2, mud: 0.8, pts: [[520, 700], [548, 560], [570, 420], [600, 300], [606, 252], [588, 230], [555, 223], [500, 222]] },   // skirts the highway, back onto it along the AT ditch
      { w: 4.0, mud: 0.75, pts: [[-470, 700], [-470, 640], [-430, 590], [-360, 560]] },
      { w: 4.2, mud: 0.8, pts: [[-300, -700], [-330, -600], [-390, -420], [-400, -260], [-390, -201]] },          // to the track junction
      { w: 4.0, mud: 0.7, pts: [[150, -700], [170, -600], [200, -470], [240, -300], [262, -120], [262, -40]] },   // joins the belt trail at the E-W road
    ],
    // phase 1 = the northern edge (the player's approach), phase 2 = the centre of the village
    objectives: [
      { id: 'A', name: 'Robotyne School', x: -300, z: -66, r: 30, phase: 2 },
      { id: 'B', name: 'Silska Street Crossroads', x: 64, z: -8, r: 28, phase: 2 },
      { id: 'C', name: 'Kolkhoz Yard (north end)', x: -176, z: 452, r: 32, phase: 1 },
      { id: 'D', name: 'T-04-08 West Trench Line', x: 600, z: 150, r: 28, phase: 1 },
    ],
    deployZones: { player: { x0: -680, x1: 680, z0: 612, z1: 692 }, enemy: { x0: -680, x1: 680, z0: -692, z1: -612 } },
    spawns: { attacker: [[-690, -690], [-50, -690], [325, -690], [-300, -688], [560, -688]], defender: [[183, 690], [572, 690], [-245, 690], [-30, 690]] },
    lineup: [[-70, 640, 'btr', '1st Squad'], [60, 632, 'btr', '2nd Squad'], [-10, 652, 'ifv', '3rd Squad'], [-130, 655, 'tank', 'Assault Squad'], [240, 646, 'tank', null], [420, 664, 'spg', null]],
    support: [[90, 668, 'atgm'], [-190, 672, 'fpv']],
    ai: {
      staging: { A: [[-300, -190], [-380, -175], [-220, -185], [-430, -120]], B: [[54, -124], [120, -120], [-2, -147], [160, -95]],
        C: [[-168, 330], [-250, 345], [-90, 330], [-310, 300]], D: [[600, 45], [660, 60], [540, 35], [650, -20]] },
      overwatch: { A: [[-330, -235], [-240, -245]], B: [[64, -191], [130, -195]], C: [[-192, 250], [-120, 262]], D: [[620, -40], [560, -60]] },
      army: [[-300, -640, 'mech', 'A'], [-200, -645, 'assault', 'A'], [60, -640, 'imech', 'B'], [150, -646, 'foot', 'B'], [-250, -660, 'tank', 'A'], [120, -662, 'tank', 'B'], [420, -650, 'atgm', 'D'], [-460, -652, 'fpv', 'C'], [250, -672, 'spg', 'D']],
    },
    // Russian positions, facing north (+Z, the UA approach).  The line west of the T-04-08 (fire trench + anti-tank ditch
    // in front, the treeline behind) is traced from imagery of the ground; OSM's mapped Robotyne line lies ~1.25 km
    // further south, outside the square.  In the village: the school forecourt, the kolkhoz yard's north edge, the
    // crossroads, the tree belt east of Silska St and the balka heads; the fall-back line south of the village.
    fortifications: [
      { type: 'sp', id: 'W', name: 'T-04-08 west line', front: [-0.2, 1], kind: 'line', revet: 'eng', craters: 9 },
      { type: 'fire', sp: 'W', base: [[524, 128], [562, 138], [600, 146], [640, 153], [688, 163]], style: 'zigzag', leg: 7, amp: 2.4, bays: 2, dug: [0.25, 0.7], mg: [0.4, 0.85] },
      { type: 'comm', sp: 'W', pts: [[612, 148], [618, 100], [626, 60]], style: 'zigzag', link: true },
      { type: 'ditch', pts: [[552, 199], [600, 208], [650, 219], [696, 230]], bermSide: -1 },
      { type: 'sp', id: 'C1', name: 'Kolkhoz yard north edge', front: [0, 1], revet: 'crude', craters: 6 },
      { type: 'fire', sp: 'C1', base: [[-262, 528], [-240, 530], [-218, 528]], bayGap: 8 },
      { type: 'fire', sp: 'C1', base: [[-150, 530], [-128, 532], [-104, 529]], bayGap: 8 },
      { type: 'mg', sp: 'C1', at: [-190, 535], front: [0, 1] },
      { type: 'fox', sp: 'C1', pts: [[-280, 520, -0.7, 0.7], [-88, 520, 0.7, 0.7], [-200, 545, 0, 1]] },
      { type: 'dug', sp: 'C1', at: [-240, 518] }, { type: 'dug', sp: 'C1', at: [-128, 520] },
      { type: 'sp', id: 'C2', name: 'Shevchenka St north gardens', front: [0, 1], kind: 'outpost', revet: 'rough', yard: true, craters: 4 },
      { type: 'fire', sp: 'C2', base: [[-235, 392], [-218, 394]], bayGap: 6 },
      { type: 'fox', sp: 'C2', pts: [[-246, 398, -0.5, 0.85], [-206, 400, 0.5, 0.85]] },
      { type: 'sp', id: 'A1', name: 'School forecourt', front: [0, 1], revet: 'urban', yard: true, craters: 4 },
      { type: 'fire', sp: 'A1', base: [[-344, -50], [-326, -48], [-308, -50]], bayGap: 6 },
      { type: 'mg', sp: 'A1', at: [-292, -47], front: [0.2, 1] },
      { type: 'fox', sp: 'A1', pts: [[-352, -60, -0.8, 0.6], [-262, -54, 0.6, 0.8]] },
      { type: 'dug', sp: 'A1', at: [-330, -60] },
      { type: 'sp', id: 'B1', name: 'Silska crossroads', front: [0, 1], kind: 'outpost', revet: 'crude', yard: true, craters: 4 },
      { type: 'fire', sp: 'B1', base: [[96, 22], [112, 24], [128, 22]], bayGap: 6 },
      { type: 'mg', sp: 'B1', at: [40, 18], front: [-0.1, 1] },
      { type: 'fox', sp: 'B1', pts: [[24, 30, -0.4, 0.9], [140, 30, 0.5, 0.85]] },
      { type: 'sp', id: 'E1', name: 'Tree belt east of Silska St', front: [0, 1], revet: 'logs', craters: 6 },
      { type: 'fire', sp: 'E1', base: [[270, 92], [276, 112], [282, 132]], front: [-0.6, 0.8], bayGap: 7 },
      { type: 'mg', sp: 'E1', at: [292, 140], front: [0, 1] },
      { type: 'fox', sp: 'E1', pts: [[268, 70, -1, 0.1], [300, 120, 0.6, 0.8]] },
      { type: 'dug', sp: 'E1', at: [284, 96] },
      { type: 'sp', id: 'S1', name: 'South fall-back line', front: [0, 1], kind: 'line', revet: 'rough', craters: 6 },
      { type: 'fire', sp: 'S1', base: [[-420, -590], [-330, -588], [-240, -590]], style: 'zigzag', leg: 8, amp: 2.4, bays: 2, dug: [0.3, 0.7], mg: [0.5] },
      { type: 'fire', sp: 'S1', base: [[60, -600], [160, -598], [250, -600]], style: 'zigzag', leg: 8, amp: 2.4, bays: 2, dug: [0.5] },
    ],
    // knocked-out armour of the summer 2023 assaults (static wrecks): [x, z, heading, vehicle, turret blown off]
    wrecks: [[-40, 560, 3.0, 'bradley_ua', 0], [30, 520, 2.8, 'btr80_ua', 0], [560, 300, 3.4, 't72av_ua', 1], [-420, 470, 2.9, 'bradley_ua', 0],
      [140, 300, 0.2, 'bmp3', 0], [-320, 160, 0.3, 't72b3', 1], [380, -200, 0.1, 'btr82a', 0], [-80, -300, 0.4, 'bmp3', 0]],
    smoulder: [[-176, 470, 0.9], [-300, -80, 1.0], [64, 40, 0.8], [-560, 120, 0.7]],
    plumes: [[-900, -1100, 1.6], [700, -1000, 2.0], [1150, 200, 1.2], [-1100, 400, 1.3], [200, -1300, 2.4]],
    cam: [-20, 560, 190], fog: 0.0012, ambience: 'ambience_wind',
  },
  avdiivka: {
    id: 'avdiivka', name: 'Avdiivka', real: 'avdiivka', kind: 'urban', size: 'Large', sizeM: 1280, bounds: 620, seed: 8831, assets: ['farmland'],
    geo: { lat: 48.1294, lon: 37.7479 },
    blurb: 'The real south-east of Avdiivka (Donetsk oblast, winter 2023-24): the five- and nine-storey microdistrict between vul. Vorobyova, Molodizhna and Hrushevskoho with schools No. 2 and 5, the Khimik stadium, the garage cooperatives on the disused Yasynuvata railway and the private sector on Soborna street; the city centre to the north. The attack comes across the open field south of vul. Vorobyova. Map data © OpenStreetMap contributors (ODbL).',
    sub: 'Real place · panel blocks, private sector, railway · OSM layout', credit: 'Map data © OpenStreetMap contributors (ODbL)', north: [0, -1],
    roads: [], buildings: [], pancakes: [],
    damage: { rubble: 0.22, burnt: 0.26, blocks: [0.7, 1.45] },
    // layout v2 (2026-11): extent centred 300 m west / 60 m north of v1 -- old coordinates + (300, 60)
    objectives: [
      { id: 'A', name: 'Khimik Stadium', x: -31, z: -282, r: 32, phase: 2 },
      { id: 'B', name: 'Schools No. 2 and 5', x: -327, z: 150, r: 30, phase: 1 },
      { id: 'C', name: 'Delita Factory (vul. Vorobyova)', x: 60, z: 262, r: 28, phase: 1 },
      { id: 'D', name: 'Railway Garages', x: 162, z: -20, r: 30, phase: 2 },   // on vul. Hrushevskoho: tanks cannot get between the garage rows
    ],
    deployZones: { player: { x0: -560, x1: 300, z0: 562, z1: 632 }, enemy: { x0: -560, x1: 560, z0: -632, z1: -562 } },
    spawns: { attacker: [[-110, -630], [80, -630], [300, -630], [-560, -600]], defender: [[-300, 630], [176, 630], [-80, 630], [-500, 630]] },
    lineup: [[-300, 600, 'btr', '1st Squad'], [-200, 596, 'btr', '2nd Squad'], [-250, 612, 'ifv', '3rd Squad'], [-160, 616, 'tank', 'Assault Squad'], [-380, 606, 'tank', null], [-460, 616, 'spg', null]],
    support: [[-330, 622, 'atgm'], [-230, 626, 'fpv']],
    ai: {
      staging: { A: [[-31, -400], [40, -380], [-110, -360], [80, -330]], B: [[-327, 40], [-260, 30], [-400, 30], [-200, 60]],
        C: [[60, 150], [0, 150], [110, 120], [-60, 170]], D: [[200, -150], [140, -120], [250, -170], [110, -60]] },
      overwatch: { A: [[-40, -470], [40, -450]], B: [[-330, -40], [-250, -60]], C: [[60, 60], [-20, 80]], D: [[200, -250], [130, -230]] },
      army: [[-100, -602, 'mech', 'A'], [0, -540, 'assault', 'A'], [340, -590, 'imech', 'D'], [-300, -601, 'foot', 'B'], [-110, -560, 'tank', 'A'], [356, -556, 'tank', 'D'], [170, -600, 'atgm', 'D'], [-246, -600, 'fpv', 'C'], [240, -620, 'spg', 'D']],
    },
    // Ukrainian positions: the south edge of the blocks along vul. Vorobyova facing the open field, schools No. 2 / 5,
    // the Delita factory, the railway crossing, the Khimik stadium and the south end of the garages
    fortifications: [
      { type: 'sp', id: 'V1', name: 'Vorobyova St south edge', front: [0, 1], kind: 'line', revet: 'urban', craters: 8 },
      { type: 'fire', sp: 'V1', base: [[-520, 396], [-480, 391], [-440, 386], [-400, 380]], style: 'zigzag', leg: 7, amp: 2.2, bays: 2, dug: [0.3, 0.75], mg: [0.5] },
      { type: 'fire', sp: 'V1', base: [[-330, 371], [-290, 366], [-250, 361]], bayGap: 7 },
      { type: 'sp', id: 'C1', name: 'Delita factory south side', front: [0, 1], revet: 'urban', craters: 6 },
      { type: 'fire', sp: 'C1', base: [[0, 330], [30, 327], [60, 324], [90, 320]], bayGap: 7 },
      { type: 'mg', sp: 'C1', at: [112, 318], front: [0.3, 0.95] },
      { type: 'fox', sp: 'C1', pts: [[-16, 336, -0.6, 0.8], [124, 324, 0.6, 0.8]] },
      { type: 'dug', sp: 'C1', at: [50, 340] },
      { type: 'sp', id: 'R1', name: 'Railway crossing', front: [0, 1], kind: 'outpost', revet: 'urban', craters: 5 },
      { type: 'fire', sp: 'R1', base: [[204, 300], [212, 314], [216, 330]], front: [0.7, 0.7], bayGap: 6 },
      { type: 'mg', sp: 'R1', at: [226, 296], front: [0.4, 0.92] },
      { type: 'fox', sp: 'R1', pts: [[200, 340, 0, 1], [232, 350, 0.3, 0.95]] },
      { type: 'sp', id: 'B1', name: 'School No. 2 yard', front: [0, 1], kind: 'outpost', revet: 'urban', craters: 5 },
      { type: 'fire', sp: 'B1', base: [[-305, 238], [-290, 242], [-275, 245]], bayGap: 6 },
      { type: 'fox', sp: 'B1', pts: [[-318, 236, -0.3, 0.95], [-262, 248, 0.3, 0.95]] },
      { type: 'sp', id: 'A1', name: 'Khimik stadium south stand', front: [0, 1], revet: 'urban', craters: 6 },
      { type: 'fire', sp: 'A1', base: [[-76, -206], [-50, -204], [-24, -205], [2, -207]], bayGap: 7 },
      { type: 'mg', sp: 'A1', at: [18, -206], front: [0.3, 0.95] },
      { type: 'fox', sp: 'A1', pts: [[-90, -212, -0.5, 0.85], [30, -198, 0.6, 0.8]] },
      { type: 'dug', sp: 'A1', at: [-50, -218] },
      { type: 'sp', id: 'D1', name: 'Garages south end', front: [0, 1], kind: 'outpost', revet: 'urban', craters: 4 },
      { type: 'fire', sp: 'D1', base: [[184, 262], [200, 262], [216, 261]], bayGap: 6 },
      { type: 'fox', sp: 'D1', pts: [[178, 252, -0.4, 0.9], [226, 250, 0.4, 0.9]] },
    ],
    wrecks: [[-80, 480, 3.3, 't72b3', 1], [40, 440, 2.9, 'bmp3', 0], [150, 530, 3.1, 'btr82a', 0], [-300, 470, 3.6, 't72b3', 0], [-200, 440, 3.0, 'bmp3', 1], [-420, 450, 3.9, 'btr82a', 0], [260, 180, 0.1, 'btr80_ua', 0]],
    smoulder: [[44, 230, 1.2], [111, 237, 1.0], [-81, -116, 0.9], [-366, 43, 0.8], [175, 32, 0.9]],
    plumes: [[-900, -900, 1.6], [700, -600, 1.8], [900, 300, 1.4], [-700, 900, 1.2], [300, 1000, 2.0]],
    cam: [-140, 520, 170], fog: 0.0016, ambience: 'ambience_city',
  },
};
