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
    // a dug-in last line across the southern green strip (facing north), dugout behind it
    fortifications: [
      { type: 'fire', base: [[-24, 177], [64, 177]], front: [0, -1], style: 'zigzag', revet: 'boards', leg: 6.5, amp: 2.2, bays: 2, dug: [0.4], mg: [0.9] },
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
    // Field fortifications (terrain.js cuts them into the ground). front = towards the enemy the line was dug against.
    //   fire: zig-zag ('zigzag', Russian 'lomanaya'), crenellated ('crenel': fire bays + traverses) or 'wiggle' (tree-line);
    //         dug = dugouts at baseline fractions (passage to the rear), mg = covered MG cells nearest those fractions
    fortifications: [
      // Novomykolaivka north line: in the rear edge of the windbreak, firing cells pushed into the belt, facing north
      { type: 'fire', base: [[-334, -14], [-36, -14]], front: [0, -1], style: 'zigzag', revet: 'boards', leg: 7, amp: 2.4, bays: 2, dug: [0.1, 0.36, 0.62, 0.9], mg: [0.03, 0.5, 0.97] },
      { type: 'comm', pts: [[-262, -13], [-262, 16]] }, { type: 'comm', pts: [[-150, -13], [-150, 16]] }, { type: 'comm', pts: [[-78, -13], [-78, 16]] },
      // kolkhoz farm north line (Ukrainian crenellated fire trench, wattle / log revetment)
      { type: 'fire', base: [[166, -14], [352, -14]], front: [0, -1], style: 'crenel', revet: 'mixed', leg: 6, amp: 2.0, bays: 3, dug: [0.15, 0.55, 0.88], mg: [0.3, 0.75] },
      { type: 'comm', pts: [[244, -12], [244, 48]], revet: 'wattle' }, { type: 'comm', pts: [[306, -12], [306, 48]], revet: 'wattle' },
      // C: forest-edge strongpoint, trench just inside the tree line facing the southern fields and the east
      { type: 'fire', base: [[-566, 447], [-418, 447]], front: [0, 1], style: 'wiggle', revet: 'logs', leg: 6, amp: 1.8, bays: 2, dug: [0.25, 0.6], mg: [0.95, 0.45] },
      { type: 'fire', base: [[-414, 449], [-414, 352]], front: [1, 0], style: 'wiggle', revet: 'logs', leg: 6, amp: 1.6, bays: 2, dug: [0.5], mg: [0.2] },
      { type: 'comm', pts: [[-486, 446], [-486, 312]], revet: 'logs' },
      // D: crossroads farmstead, crenellated positions south of the track facing the southern approach
      { type: 'fire', base: [[118, 421], [206, 421]], front: [0, 1], style: 'crenel', revet: 'boards', leg: 6, amp: 1.9, bays: 2, dug: [0.3, 0.75], mg: [0.04] },
      { type: 'fire', base: [[24, 421], [93, 421]], front: [0, 1], style: 'zigzag', revet: 'wattle', leg: 7, amp: 2.2, bays: 2, dug: [0.5], mg: [0.95] },
      // enemy main line in the northern windbreak, facing south: AT ditch, three rows of dragon's teeth, then the trench
      { type: 'fire', base: [[-334, -344], [-62, -344]], front: [0, 1], style: 'zigzag', revet: 'boards', leg: 8, amp: 2.6, bays: 2, dug: [0.2, 0.5, 0.8], mg: [0.35, 0.7] },
      { type: 'fire', base: [[148, -344], [344, -344]], front: [0, 1], style: 'zigzag', revet: 'boards', leg: 8, amp: 2.6, bays: 2, dug: [0.3, 0.7], mg: [0.5] },
      { type: 'comm', pts: [[-200, -345], [-200, -400]] }, { type: 'comm', pts: [[250, -345], [250, -400]] },
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
