// Campaign v2 — Ukrainian side: "Orikhiv Axis 2023". One mechanised brigade's area of responsibility (AOR) south of
// Orikhiv in Zaporizhzhia, from February 2023 (a year into the full-scale invasion: positional defence, raids and the
// preparation for the counteroffensive) through the June 2023 attack south of Mala Tokmachka, the small-group fighting
// along the T-04-08, Robotyne (August), the breach of the main belt west of Verbove and the fighting for Novoprokopivka
// (September), to the culmination and the transition to defence in the winter of 2023–24 (ends 4 March 2024).
// Data contract: src/campaign/schema2.js (+ schema.js for UnitRecord / catalog / tech / MODS).
//
// The BRIGADE IS FICTIONAL (209th Separate Mechanised Brigade) and so are its people: real brigades fought here and
// attributing this unit's actions to any of them would misrepresent them. The GEOGRAPHY (grid cells built from
// OpenStreetMap, see content_grid_ua.js), the starting line, the fortification belts and the course of the operation
// are real and follow public reporting (sources below, per directive). Directive texts are paraphrased in-world orders,
// not quotations; no real person is named. Higher-command names are real formations/organisations (OSUV "Tavria").
import { GRID_UA as G } from './content_grid_ua.js';
import { THEATRE2 } from './content_theatre.js';
import { TECH_UA } from './tech.js';
import { GRID_EXT_UA as GX } from './content_grid_ext_ua.js';

const N = name => { const c = G.cells.find(x => x.name === name); if (!c) throw new Error(`UA grid: no cell named ${name}`); return c.id; };
const unit = (uid, key, name, kind, men, veh, xp = 0) => ({ uid, key, name, kind, men, menMax: men, wounded: 0, ...(veh ? { veh: { kind: veh, hp: 1, lost: false } } : {}), xp, battles: 0, kills: 0, status: 'ready' });

const SRC = {
  robotyne: { title: 'Battle of Robotyne — Wikipedia', url: 'https://en.wikipedia.org/wiki/Battle_of_Robotyne' },
  counter: { title: '2023 Ukrainian counteroffensive — Wikipedia', url: 'https://en.wikipedia.org/wiki/2023_Ukrainian_counteroffensive' },
  surovikin: { title: 'Surovikin line — Wikipedia', url: 'https://en.wikipedia.org/wiki/Surovikin_line' },
  isw0126: { title: 'ISW / CTP: Russian Offensive Campaign Assessment, 26 Jan 2023 (localised attacks near Novodanylivka, Novopokrovka)', url: 'https://www.criticalthreats.org/analysis/russian-offensive-campaign-assessment-january-26-2023' },
  isw0608: { title: 'ISW / CTP: Russian Offensive Campaign Assessment, 8 Jun 2023', url: 'https://www.criticalthreats.org/analysis/russian-offensive-campaign-assessment-june-8-2023' },
  isw0826: { title: 'ISW / CTP: Russian Offensive Campaign Assessment, 26 Aug 2023', url: 'https://www.criticalthreats.org/analysis/russian-offensive-campaign-assessment-august-26-2023' },
  isw0923: { title: 'ISW / CTP: Russian Offensive Campaign Assessment, 23 Sep 2023', url: 'https://www.criticalthreats.org/analysis/russian-offensive-campaign-assessment-september-23-2023' },
  nbc0828: { title: 'NBC News: Ukraine says it liberates strategic southeastern settlement (28 Aug 2023)', url: 'https://www.nbcnews.com/news/world/ukraine-liberates-robotyne-russia-counteroffensive-rcna102100' },
  isw1226: { title: 'ISW / CTP: Russian Offensive Campaign Assessment, 26 Dec 2023', url: 'https://www.criticalthreats.org/analysis/russian-offensive-campaign-assessment-december-26-2023' },
  isw0217: { title: 'ISW / CTP: Russian Offensive Campaign Assessment, 17 Feb 2024', url: 'https://www.criticalthreats.org/analysis/russian-offensive-campaign-assessment-february-17-2024' },
};
// campaign v5: the grid grows south past the original AOR (growth.js). Squares of the extension (content_grid_ext_ua.js)
const XN = name => { for (const b of GX.bands) { const c = b.cells.find(x => x.name === name); if (c) return c.id; } throw new Error(`UA grid extension: no cell named ${name}`); };
const EXT_BANDS = {
  ua_x1: { name: 'Nove – Kharkove – Ocheretuvate',
    text: 'Behind Solodka Balka and Verbove the ground falls away to the R-85 lateral road: Nove, Kharkove and Ocheretuvate, depots and reserve positions behind the second belt.',
    hubs: [{ cell: XN('Nove'), name: 'Nove supply point', kind: 'ammo', side: 'enemy' }],
    forces: [{ name: 'Motor-rifle bn (Ocheretuvate)', kind: 'mech', cell: XN('Ocheretuvate'), coys: ['mech', 'mech', 'mech'], xp: 2 }, { name: 'Motor-rifle bn (Nove)', kind: 'mech', cell: XN('Nove'), coys: ['mech', 'mech', 'inf'], xp: 1 }],
    directives: [{ id: 'ua_x_nove', issue: { when: 'grown:ua_x1' }, from: 'OSUV "Tavria"', title: 'Exploit past the second belt: Nove', kind: 'capture', targets: [XN('Nove')], deadline: 6,
      text: 'The brigade has broken through the second belt. Push south along the T-04-08 to Nove before the enemy closes the gap with his reserves from Tokmak; keep the flanks on the R-85 under drone watch.',
      reward: { lp: 60 }, penalty: { lp: 5 },
      history: 'In reality the 2023 counteroffensive culminated in the Robotyne – Verbove salient: Ukrainian troops did not reach Nove or the R-85.', sources: [SRC.counter] }] },
  ua_x2: { name: 'The Tokmak line',
    text: 'North of Tokmak the third Russian belt runs across the T-04-08: a continuous anti-tank ditch, dragon\'s teeth and dozens of bunkers (mapped in OpenStreetMap), with Chervonohirka as its strongpoint.',
    hubs: [{ cell: XN('Chervonohirka'), name: 'Chervonohirka ammunition point', kind: 'ammo', side: 'enemy' }],
    forces: [{ name: 'Fortress bn (Tokmak line)', kind: 'inf', cell: XN('Tokmak line (T-04-08)'), coys: ['inf', 'inf', 'atgm', 'inf'], xp: 1, role: 'hold' }, { name: 'Motor-rifle bn (Chervonohirka)', kind: 'mech', cell: XN('Chervonohirka'), coys: ['mech', 'mech', 'mech'], xp: 2 }],
    directives: [{ id: 'ua_x_tokmak_line', issue: { when: 'grown:ua_x2' }, from: 'OSUV "Tavria" — Intelligence', title: 'Map the Tokmak line', kind: 'recon', targets: [XN('Tokmak line (T-04-08)'), XN('Chervonohirka')], deadline: 5,
      text: 'The third belt in front of Tokmak is close. Fly drones over the ditch and the strongpoints at Chervonohirka and on the T-04-08: where are the lanes, the bunkers, the reserves?',
      reward: { lp: 40 }, penalty: { lp: 5 }, history: 'Satellite imagery in 2023 showed a continuous defence line around Tokmak\'s northern approaches, the third of the belts south of Orikhiv.', sources: [SRC.surovikin] }] },
  ua_x3: { name: 'Tokmak',
    text: 'Tokmak, the rail junction and supply hub of the whole Russian grouping south of Orikhiv: the railhead on the Fedorivka – Volnovakha line, depots, a fortified town.',
    hubs: [{ cell: XN('Tokmak station'), name: 'Tokmak railhead (Fedorivka – Volnovakha line)', kind: 'railhead', side: 'enemy' }],
    forces: [{ name: 'Tokmak garrison (motor-rifle regiment)', kind: 'mech', cell: XN('Tokmak'), coys: ['mech', 'mech', 'mech', 'tank', 'inf'], xp: 2, role: 'hold' }],
    directives: [{ id: 'ua_x_tokmak', issue: { when: 'grown:ua_x3' }, from: 'OSUV "Tavria"', title: 'Combat order: the outskirts of Tokmak', kind: 'capture', targets: [XN('Tokmak')], deadline: 8,
      text: 'Tokmak is in reach. Seize the northern quarters of the town and put the railhead under direct fire: every train that cannot unload in Tokmak is a shell that does not reach the front.',
      reward: { lp: 150 }, penalty: { lp: 10 }, history: 'Tokmak was the counteroffensive\'s operational objective (cutting the land bridge to Crimea); the front stayed about 20 km north of it.', sources: [SRC.counter] }] },
};
const EXT_UA = { dir: GX.dir, bbox: GX.bbox, geo: GX.geo, osm: 'osm_UA_ext', bands: GX.bands.map(b => ({ ...b, ...EXT_BANDS[b.id] })) };

// Brigade scale: every unit record is a COMPANY (fought on the RTS battle map by a representative squad / vehicle), every
// task force a BATTALION group. In February 2023 the brigade holds the sector dispersed — a battalion per stretch of
// front, the tanks back in Orikhiv — so a strike force has to be assembled deliberately.
const START_UNITS = [
  unit('ua_u1', 'mech_bmp', '1st Mech. Coy (BMP-2)', 'imech', 7, 'ifv', 1),
  unit('ua_u2', 'mech_bmp', '4th Mech. Coy (BMP-2)', 'imech', 7, 'ifv', 0),
  unit('ua_u3', 'mech_btr', '7th Mech. Coy (BTR-80)', 'mech', 8, 'btr', 1),
  unit('ua_u4', 'mech_btr', '10th Rifle Coy (BTR-80)', 'mech', 8, 'btr', 0),
  unit('ua_u5', 'assault', '2nd Coy assault platoon', 'assault', 6, null, 1),
  unit('ua_u6', 'tank', '1st Tank Coy (T-64BV)', 'tank', 3, 'tank', 1),
  unit('ua_u7', 'tank', '2nd Tank Coy (T-64BV)', 'tank', 3, 'tank', 0),
  unit('ua_u8', 'atgm', 'AT platoon (Stugna-P)', 'atgm', 3, null, 1),
  unit('ua_u9', 'fpv', 'UAV strike platoon', 'fpv', 2, null, 0),
  unit('ua_u10', 'mech_btr', '8th Mech. Coy (BTR-80)', 'mech', 8, 'btr', 0),
  unit('ua_u11', 'assault', '11th Rifle Coy assault group', 'assault', 6, null, 0),
  unit('ua_u12', 'atgm', 'AT platoon (Stugna-P) #2', 'atgm', 3, null, 0),
];

export const CAMPAIGN2_UA = {
  id: 'UA', version: 2,
  title: 'Orikhiv Axis 2023',
  subtitle: 'Zaporizhzhia, February 2023 – March 2024',
  brigade: { name: '209th Separate Mechanised Brigade (fictional)', short: '209 OMBr' },
  intro: {
    place: 'Orikhiv sector, Zaporizhzhia',
    date: 'February 2023',
    lines: [
      'A year into the full-scale invasion, the front south of Orikhiv has frozen into trenches, tree belts and minefields.',
      'Across the steppe the enemy is digging belt after belt: ditches, dragon\'s teeth and bunkers from Robotyne to Verbove.',
      'The 209th Brigade holds the sector. By summer it will be ordered to break through.',
      'Robotyne. Verbove. Tokmak beyond. Every metre will be paid for.',
    ],
  },
  start: {
    date: '2023-02-06', turnDays: 7, end: '2024-03-04', lp: 60, hq: N('Orikhiv'),
    forces: [
      { id: 'tf_b1', name: '1st Mech. Bn (Nesterianka)', cell: N('Nesterianka'), units: ['ua_u3', 'ua_u12'], stance: 'hold' },
      { id: 'tf_b2', name: '2nd Mech. Bn (Novodanylivka)', cell: N('Novodanylivka'), units: ['ua_u1', 'ua_u5'], stance: 'hold' },
      { id: 'tf_b3', name: '3rd Mech. Bn (Mala Tokmachka)', cell: N('Mala Tokmachka'), units: ['ua_u2', 'ua_u8'], stance: 'hold' },
      { id: 'tf_b4', name: 'Rifle Bn (Novopokrovka)', cell: N('Novopokrovka'), units: ['ua_u4', 'ua_u11'], stance: 'hold' },
      { id: 'tf_res', name: 'Brigade reserve', cell: 'c6_3', units: ['ua_u10', 'ua_u9'], stance: 'rest' },
      { id: 'tf_tank', name: 'Tank Bn', cell: N('Orikhiv'), units: ['ua_u6', 'ua_u7'], stance: 'rest' },
    ],
    // the brigade artillery group (fires.js): a 120 mm mortar battery up front, the 2S1 battalion and the Grad
    // battalion further back; a 155 mm M777 battery joins with the Western deliveries (directive ua_shaping)
    batteries: [
      { id: 'b_mor', kind: 'mortar120', name: '120 mm mortar battery', cell: 'c7_4' },
      { id: 'b_2s1', kind: 'how122', name: 'Self-propelled artillery bn (2S1)', cell: 'c4_2' },
      { id: 'b_grad', kind: 'grad', name: 'Rocket artillery bn (BM-21)', cell: 'c8_2' },
    ],
    // weekly shell allocation in fire missions: tight in spring, priority for the offensive (cluster rounds from July),
    // then "shell hunger" from November 2023 (~3,600 rounds/day in 2023 -> ~2,000/day in early 2024)
    ammo: [{ date: '2023-02-06', a: 3 }, { date: '2023-06-01', a: 5 }, { date: '2023-07-15', a: 5.5 }, { date: '2023-11-01', a: 2.5 }, { date: '2024-01-01', a: 2 }],
    ammoStart: 6, ammoMax: 12, uavStock: 6,
    units: START_UNITS,
    unlocked: ['ua_log_ifak', 'ua_dr_mavic'],
    available: ['repl', 'mech_btr', 'mech_bmp', 'mech_ifv', 'tank', 'assault', 'atgm', 'fpv'],
  },
  theatre: { ...THEATRE2 },
  aor: {
    name: 'Orikhiv – Robotyne – Verbove', bbox: G.bbox, cellKm: G.cellKm, cols: G.cols, rows: G.rows,
    enemyEdge: G.enemyEdge, supplySources: [...G.supplySources, 'c13_3'], cells: G.cells,
    // supply.js: the Russian rear is the T-04-08 / rail corridor to Tokmak off the southern edge
    enemySources: ['c4_13', 'c0_13', 'c13_13'],
    hubs: [
      { cell: N('Orikhiv'), name: 'Orikhiv logistics base (rail station)', kind: 'base', side: 'player' },
      { cell: 'c6_3', name: 'Brigade ammunition point (N-08 / T-04-08)', kind: 'ammo', side: 'player' },
      { cell: N('Novoandriivka'), name: 'Novoandriivka supply point', kind: 'ammo', side: 'player' },
      { cell: N('Robotyne'), name: 'Robotyne forward ammunition point', kind: 'ammo', side: 'enemy' },
      { cell: N('Kopani'), name: 'Kopani supply point', kind: 'ammo', side: 'enemy' },
      { cell: N('Verbove'), name: 'Verbove supply point', kind: 'ammo', side: 'enemy' },
      { cell: N('Solodka Balka'), name: 'Solodka Balka logistics node (T-04-08 to Tokmak)', kind: 'base', side: 'enemy' },
    ],
    reveal: 3,
    osm: 'assets/campaign/osm/UA/', geo: 'assets/campaign/osm/UA/aor_v2.json',
    ext: EXT_UA,
    notes: 'Starting line of 6 Feb 2023 ~2–3 km south of Novodanylivka and Mala Tokmachka. Russian first positions behind minefields in the fields and tree belts north of Robotyne; the main belt (anti-tank ditches, dragon\'s teeth, trenches, bunkers — the "Surovikin line") from south of Robotyne past Novoprokopivka to the heights west of Verbove; a second belt around Solodka Balka. Supply from the north edge (N-08 to Zaporizhzhia, T-04-08, T-08-12).',
  },
  directives: [
    // ---------------------------------------------------------------- winter / spring 2023: positional defence and preparation
    { id: 'ua_hold_winter', issue: { date: '2023-02-06' }, from: 'OSUV "Tavria"', title: 'Hold the line south of Orikhiv', kind: 'hold',
      targets: [N('Novodanylivka'), N('Mala Tokmachka'), N('Novopokrovka'), N('Nesterianka')], count: 4, deadlineDate: '2023-03-20',
      text: 'The enemy is probing the sector with small assault groups under artillery cover. Hold Novodanylivka, Mala Tokmachka, Novopokrovka and Nesterianka; keep the armour back in Orikhiv and dispersed, and counterattack any break-in before it is reinforced.',
      reward: { lp: 30 }, penalty: { lp: 10 },
      history: 'In late January and February 2023 Russian forces made small, localised attacks near Novodanylivka, Novopokrovka and Mali Shcherbaky — a "positional offensive" that did not move the line.',
      sources: [SRC.isw0126] },
    { id: 'ua_raid_spring', issue: { date: '2023-02-20' }, from: 'Brigade HQ', title: 'Raid the forward positions', kind: 'raid',
      targets: [N('T-04-08 tree belts'), N('Fields S of Mala Tokmachka'), N('Tree belts SE of Mala Tokmachka')], count: 2, deadlineDate: '2023-04-17',
      text: 'Identify the units opposite us and the layout of their forward positions. Raid the tree belts in front of Novodanylivka and Mala Tokmachka at night with small groups under drone overwatch, then pull back to our line.',
      reward: { lp: 30 }, penalty: { lp: 5 },
      history: 'Through the spring of 2023 both sides raided and shelled each other\'s forward positions south of Orikhiv while the Russian command fortified the sector in depth.',
      sources: [SRC.counter] },
    { id: 'ua_recon_belts', issue: { date: '2023-03-13' }, from: 'OSUV "Tavria" — Intelligence', title: 'Map the defence belts', kind: 'recon',
      targets: [N('Robotyne'), N('Kopani'), N('Verbove heights')], deadlineDate: '2023-05-15',
      text: 'Higher command needs the enemy\'s defence system mapped before the offensive: Robotyne, Kopani and the heights west of Verbove. Use drones and reconnaissance in force; report minefields, ditches, strongpoints and reserves.',
      reward: { lp: 35, unlock: ['ua_dr_sa'] }, penalty: { lp: 5 },
      history: 'By spring 2023 satellite imagery showed several Russian belts south of Orikhiv: forward positions behind minefields, a main belt of anti-tank ditches, dragon\'s teeth and trenches from south of Robotyne to Verbove, and further lines around Tokmak.',
      sources: [SRC.surovikin] },
    { id: 'ua_shaping', issue: { date: '2023-04-10' }, from: 'OSUV "Tavria"', title: 'Shaping: attrit the enemy\'s armour and guns', kind: 'destroy', targets: [], count: 3, deadlineDate: '2023-06-05',
      text: 'Before the offensive, wear down the enemy\'s vehicles and guns in the sector with drones, ATGMs and counter-battery fire. On completion the brigade receives two companies of Western infantry fighting vehicles and an M777 battery.',
      reward: { lp: 40, battery: 'm777', units: [unit('ua_rw_b1', 'mech_ifv', '5th Mech. Coy (Bradley)', 'imech', 6, 'ifv', 0), unit('ua_rw_b2', 'mech_ifv', '6th Mech. Coy (Bradley)', 'imech', 6, 'ifv', 0)] }, penalty: { lp: 5 },
      history: 'In April–May 2023 Ukraine received Western tanks and infantry fighting vehicles for new and reconstituted brigades, and struck Russian depots and command posts behind the line ahead of the counteroffensive.',
      sources: [SRC.counter] },
    // ---------------------------------------------------------------- June 2023: the armoured attack
    { id: 'ua_breach1', issue: { date: '2023-06-05' }, from: 'OSUV "Tavria"', title: 'Combat order: break the first positions', kind: 'capture',
      targets: [N('Fields S of Mala Tokmachka'), N('Tree belts SE of Mala Tokmachka')], deadlineDate: '2023-06-26',
      text: 'The brigade attacks south from Mala Tokmachka. Immediate task: break through the enemy\'s first positions in the fields and tree belts south of the village and open a lane for the armour towards Robotyne. Engineers with the lead company; the mine threat is extreme. Armour moves only on cleared lanes.',
      reward: { lp: 60 }, penalty: { lp: 15 }, next: { success: 'ua_tbelts', failure: 'ua_small_groups' },
      history: 'On 8 June 2023 armoured columns with Leopard 2 tanks and Bradleys attacked south of Mala Tokmachka towards Robotyne. They ran into dense minefields under ATGM, artillery and helicopter fire and lost a number of vehicles; Ukrainian units then switched to small dismounted assault groups.',
      sources: [SRC.robotyne, SRC.isw0608] },
    { id: 'ua_tbelts', issue: {}, from: 'OSUV "Tavria"', title: 'Exploit to the tree belts north of Robotyne', kind: 'capture',
      targets: [N('T-04-08 tree belts'), N('Balka N of Robotyne')], deadline: 7,
      text: 'The first positions are broken. Push south along the T-04-08 and clear the strongpoints in the tree belts and the balka north of Robotyne before the enemy reserves arrive.',
      reward: { lp: 45 }, penalty: { lp: 10 }, next: { success: 'ua_robotyne', failure: 'ua_robotyne' },
      history: 'Through June and July 2023 Ukrainian troops advanced tree line by tree line towards Robotyne; progress was measured in hundreds of metres a week.',
      sources: [SRC.robotyne] },
    { id: 'ua_small_groups', issue: {}, from: 'OSUV "Tavria"', title: 'Change of tactics: small assault groups', kind: 'capture',
      targets: [N('T-04-08 tree belts'), N('Balka N of Robotyne')], deadline: 8,
      text: 'The armoured attack through the minefields has failed with losses. Vehicles stay back in overwatch. Advance on foot in small assault groups along the tree belts either side of the T-04-08 and clear the strongpoints north of Robotyne one at a time. Evacuate the damaged vehicles.',
      reward: { lp: 40 }, penalty: { lp: 10 }, next: { success: 'ua_robotyne', failure: 'ua_robotyne' },
      history: 'After the first armoured attacks, Ukrainian brigades on the Orikhiv axis advanced mostly on foot, clearing the tree belts with small groups and sappers while vehicles supported from behind.',
      sources: [SRC.robotyne, SRC.counter] },
    // ---------------------------------------------------------------- August 2023: Robotyne
    { id: 'ua_robotyne', issue: { date: '2023-08-07' }, from: 'OSUV "Tavria"', title: 'Combat order: Robotyne', kind: 'capture',
      targets: [N('Robotyne')], deadlineDate: '2023-09-04',
      text: 'Seize Robotyne and clear it to its southern edge. The village is the hinge of the enemy\'s forward line on this axis. Assault groups into the houses and gardens, infantry fighting vehicles in support from the tree belts, fires on call. On completion an additional Bradley squad is released to the brigade.',
      reward: { lp: 90, units: [unit('ua_rw_b3', 'mech_ifv', '9th Mech. Coy (Bradley)', 'imech', 6, 'ifv', 0)] }, penalty: { lp: 20 }, next: { success: 'ua_verbove_belt', failure: 'ua_robotyne2' },
      history: 'Ukrainian troops raised the flag over Robotyne on 23 August 2023 after weeks of small-group assaults; the liberation was announced on 28 August. The southern outskirts stayed contested for some days more.',
      sources: [SRC.robotyne, SRC.nbc0828, SRC.isw0826] },
    { id: 'ua_robotyne2', issue: {}, from: 'OSUV "Tavria"', title: 'Renewed assault on Robotyne', kind: 'capture',
      targets: [N('Robotyne')], deadline: 6,
      text: 'The first assault on Robotyne has stalled. Fresh engineers and shells are allocated: take the village before the enemy\'s reserves dig in.',
      reward: { lp: 50 }, penalty: { lp: 15 }, next: { success: 'ua_verbove_belt', failure: 'ua_culminate' } },
    { id: 'ua_hold_robotyne', issue: { when: `captured:${N('Robotyne')}` }, from: 'Corps HQ', title: 'Hold Robotyne', kind: 'hold',
      targets: [N('Robotyne')], count: 3, deadline: 5,
      text: 'Enemy reserves, airborne troops among them, are moving up to retake Robotyne. Turn the captured positions around, mine the southern approaches, keep ATGM and drone teams forward and the vehicles dispersed.',
      reward: { lp: 35 }, penalty: { lp: 15 },
      history: 'After Robotyne fell, Russian forces counterattacked its southern and western outskirts for weeks; the village stayed in Ukrainian hands.',
      sources: [SRC.isw0826] },
    { id: 'ua_west', issue: { date: '2023-08-14' }, from: 'Corps HQ', title: 'Fix the enemy at Kopani', kind: 'raid',
      targets: [N('Kopani'), N('Rivne')], count: 2, deadlineDate: '2023-09-25',
      text: 'The fighting has spread west of Robotyne. Attack towards Kopani and Rivne to tie down the enemy\'s reserves there and keep him from flanking the Robotyne salient from the west.',
      reward: { lp: 35 }, penalty: { lp: 5 },
      history: 'From 11 August 2023 the fighting for Robotyne spilled into Nesterianka and Kopani on its western flank.',
      sources: [SRC.robotyne] },
    { id: 'ua_vdv', issue: { date: '2023-08-28' }, from: 'OSUV "Tavria" — Fires', title: 'Attrit the airborne reserves', kind: 'destroy', targets: [], count: 5, deadlineDate: '2023-10-23',
      text: 'Fresh enemy armour and airborne troops are moving into the Robotyne – Verbove line. Destroy enemy armoured vehicles wherever found: drones, ATGMs and artillery. Confirm with video.',
      reward: { lp: 45, unlock: ['ua_dr_fpv'] }, penalty: { lp: 5 },
      history: 'In August–September 2023 Russia moved airborne (VDV) units from other sectors into the Robotyne – Verbove line to stop the breakthrough.',
      sources: [SRC.isw0826, SRC.robotyne] },
    // ---------------------------------------------------------------- September 2023: the main belt
    { id: 'ua_verbove_belt', issue: { date: '2023-09-04' }, from: 'OSUV "Tavria"', title: 'Combat order: breach the main belt west of Verbove', kind: 'capture',
      targets: [N('Heights NW of Verbove')], deadlineDate: '2023-11-27',
      text: 'The main effort shifts south-east. Break into the main defence belt on the heights north-west of Verbove, then roll it up towards the village: anti-tank ditch, dragon\'s teeth and the trench line behind them. Artillery preparation, smoke, engineers to the ditch, assault groups into the trenches; the armour crosses only on a proven lane.',
      reward: { lp: 80 }, penalty: { lp: 20 }, next: { success: 'ua_verbove', failure: 'ua_culminate' },
      history: 'On 21–23 September 2023 Ukrainian forces broke through the best-prepared belt 1.7–3.5 km west of Verbove and armour crossed the anti-tank ditch, but the breach stayed narrow and under fire from three sides.',
      sources: [SRC.isw0923, SRC.robotyne] },
    { id: 'ua_novoprokopivka', issue: { date: '2023-09-11' }, from: 'Corps HQ', title: 'Novoprokopivka', kind: 'capture',
      targets: [N('Novoprokopivka')], deadlineDate: '2023-11-13',
      text: 'Push south from Robotyne along the T-04-08 into Novoprokopivka and take the high ground beyond it. Expect a stubborn defence from the trench lines on the heights.',
      reward: { lp: 60 }, penalty: { lp: 10 },
      history: 'Ukrainian forces cleared the ground between Robotyne and Novoprokopivka and fought on the village\'s northern outskirts; Novoprokopivka itself remained Russian-held.',
      sources: [SRC.isw0923] },
    { id: 'ua_verbove', issue: {}, from: 'OSUV "Tavria"', title: 'Verbove', kind: 'capture',
      targets: [N('Verbove')], deadline: 7,
      text: 'Exploit the breach. Enter Verbove from the north-west and clear it; airborne troops hold the village. Keep the breach open behind you.',
      reward: { lp: 70 }, penalty: { lp: 10 }, next: { success: 'ua_culminate', failure: 'ua_culminate' },
      history: 'Ukrainian troops reached the north-western edge of Verbove in late September 2023; the village itself was not taken.',
      sources: [SRC.robotyne] },
    // ---------------------------------------------------------------- winter 2023–24: culmination and defence
    { id: 'ua_culminate', issue: { date: '2023-11-06' }, from: 'OSUV "Tavria"', title: 'Go over to the defence', kind: 'hold',
      targets: [N('Orikhiv'), N('Novodanylivka'), N('Mala Tokmachka')], count: 4, deadlineDate: '2023-12-18',
      text: 'The brigade has culminated. Consolidate on the line reached, evacuate the wounded, take in replacements and repair the vehicles. Dig in for the winter; the enemy will try to take back what he lost.',
      reward: { lp: 35 }, penalty: { lp: 10 },
      history: 'By November 2023 the counteroffensive had culminated short of Tokmak. In early November Ukraine\'s commander-in-chief called the war a stalemate; at the end of November Ukraine announced a move to strategic defence and the building of fortified lines.',
      sources: [SRC.counter, SRC.robotyne] },
    { id: 'ua_winter', issue: { date: '2023-12-04' }, from: 'Corps HQ', title: 'Defeat the winter assaults', kind: 'destroy', targets: [], count: 4, deadlineDate: '2024-01-29',
      text: 'Enemy assault groups backed by armour are attacking the salient. Destroy his vehicles before they reach our trenches: mines, ATGMs, drones and artillery.',
      reward: { lp: 40 }, penalty: { lp: 5 },
      history: 'Over the winter of 2023–24 Russian assault groups, often with armour, attacked the Robotyne salient and the positions west of Verbove; the fighting cost both sides heavily but changed little.',
      sources: [SRC.isw1226] },
    { id: 'ua_spoil', issue: { date: '2024-01-08' }, from: 'Brigade HQ', title: 'Spoiling attacks', kind: 'raid',
      targets: [N('Novoprokopivka'), N('Heights S of Novoprokopivka'), N('Verbove heights')], count: 2, deadlineDate: '2024-02-26',
      text: 'Disrupt the enemy\'s preparations for his next assault: short attacks on his assembly areas south and east of Robotyne, then back to our line.',
      reward: { lp: 30 }, penalty: { lp: 5 },
      history: 'Both sides kept up local attacks and drone strikes around Robotyne and Verbove into early 2024 while the front stayed largely in place.',
      sources: [SRC.isw0217] },
    { id: 'ua_hold_salient', issue: { date: '2024-01-29' }, from: 'OSUV "Tavria"', title: 'Hold the Robotyne salient', kind: 'hold',
      targets: [N('Robotyne')], deadlineDate: '2024-03-04',
      text: 'Robotyne was paid for in blood. Hold it through the end of winter.',
      reward: { lp: 40 }, penalty: { lp: 10 },
      history: 'In March 2024 the Robotyne salient was still held by Ukrainian forces, under constant Russian attack from the south and west.',
      sources: [SRC.isw0217] },
    { id: 'ua_final', issue: { date: '2024-02-05' }, final: true, from: 'OSUV "Tavria"', title: 'Hold the sector into spring', kind: 'hold',
      targets: [N('Orikhiv'), N('Novodanylivka'), N('Mala Tokmachka')], deadlineDate: '2024-03-04',
      text: 'Final task of the brigade in this campaign: keep the sector intact until the spring rotation — Orikhiv, Novodanylivka and Mala Tokmachka must be in our hands on 4 March.',
      reward: { lp: 60 },
      history: 'Two years into the full-scale invasion the Zaporizhzhia front ran a few kilometres south of where it had been in June 2023, with the Robotyne salient as the counteroffensive\'s gain on this axis.',
      sources: [SRC.counter] },
    { id: 'ua_lost_nd', issue: { when: `lost:${N('Novodanylivka')}` }, from: 'Corps HQ', title: 'Restore the line at Novodanylivka', kind: 'capture',
      targets: [N('Novodanylivka')], deadline: 3,
      text: 'The enemy has broken into Novodanylivka and threatens the T-04-08 to Orikhiv. Counterattack immediately before he consolidates.',
      reward: { lp: 25 }, penalty: { lp: 20 } },
    { id: 'ua_lost_mt', issue: { when: `lost:${N('Mala Tokmachka')}` }, from: 'Corps HQ', title: 'Restore the line at Mala Tokmachka', kind: 'capture',
      targets: [N('Mala Tokmachka')], deadline: 3,
      text: 'The enemy has broken into Mala Tokmachka on the Kinska. Counterattack before he brings up reserves.',
      reward: { lp: 25 }, penalty: { lp: 20 } },
  ],
  // THE OPERATION GOAL (state.js goalProgress / outcome): 7 of the 10 points held at the end of a week = victory (e.g.
  // Robotyne, Novoprokopivka and Verbove: the line broken on two axes); at the end of the campaign 30%+ of the points
  // (Robotyne alone, as in 2023) = limited success.
  goal: {
    title: 'Break the Robotyne – Verbove line and open the road to Tokmak',
    text: 'Break the line on two axes — Robotyne and Novoprokopivka on the T-04-08, Verbove in the east — or seize the Solodka Balka logistics node behind it (7 of 10 objective points): the enemy\'s second belt and the road and rail corridor to Tokmak, the hub of his whole southern grouping, then lie open.',
    by: '2024-03-04', partial: 0.3, win: 0.7,
    cells: [{ cell: N('Robotyne'), pts: 3 }, { cell: N('Novoprokopivka'), pts: 2 }, { cell: N('Verbove'), pts: 2 }, { cell: N('Solodka Balka'), pts: 3 }],
    history: 'The 2023 counteroffensive aimed at Tokmak and Melitopol to cut the land bridge to Crimea. On this axis it took Robotyne (August) and breached the main belt west of Verbove (September), but culminated short of Novoprokopivka, Verbove and Tokmak.',
  },
  enemy: {
    // Russian behaviour on the grid: localised attacks in winter, counterattacks with airborne reserves from August,
    // winter assaults on the salient from December. v7: the enemy is organised like the brigade — battalion groups of
    // companies (coys) standing where the real units stood: the 42nd Motor Rifle Division's regiments and 22nd Army
    // Corps units in the forward zone and the Robotyne – Verbove belt, a tank battalion and the regimental reserve
    // behind it; outposts (one company each, ai.js deploy) fill the gaps in the forward zone, the rear is empty; role 'hold' = a
    // garrison that holds its fortified village (relieved only in place).
    // The airborne (7th / 76th VDV divisions) arrive in August. The enemy commander (ai.js) moves all of them.
    forces: [
      // forward zone (row 8): the screen in front of the belt
      { name: 'Motor-rifle bn (Kamianske – west)', kind: 'mech', cell: 'c1_8', coys: ['mech', 'mech', 'inf'], xp: 2 },
      { name: 'Motor-rifle bn (Kopani)', kind: 'mech', cell: N('Kopani'), coys: ['mech', 'mech', 'mech'], xp: 3 },
      { name: 'Motor-rifle bn (Robotyne north)', kind: 'mech', cell: N('Balka N of Robotyne'), coys: ['mech', 'mech', 'tank'], xp: 3 },
      { name: 'Storm detachment', kind: 'assault', cell: N('Tree belts SE of Mala Tokmachka'), coys: ['assault', 'assault'], xp: 4 },
      { name: 'Motor-rifle bn (Verbove heights)', kind: 'mech', cell: N('Heights NW of Verbove'), coys: ['mech', 'mech', 'mech'], xp: 2 },
      { name: 'Rifle bn (Novofedorivka)', kind: 'inf', cell: 'c13_8', coys: ['inf', 'inf', 'atgm'], xp: 1 },
      // the main belt (Rivne – Robotyne – Verbove) and the depth
      { name: 'Motor-rifle bn (Robotyne)', kind: 'mech', cell: N('Robotyne'), coys: ['mech', 'mech', 'inf'], xp: 2, role: 'hold' },
      { name: 'Motor-rifle bn (Verbove)', kind: 'mech', cell: N('Verbove'), coys: ['mech', 'inf', 'inf'], xp: 1, role: 'hold' },
      { name: 'Naval infantry bn (Rivne)', kind: 'mech', cell: N('Rivne'), coys: ['mech', 'mech', 'mech'], xp: 3 },
      { name: 'Motor-rifle bn (Verbove heights, main belt)', kind: 'mech', cell: N('Verbove heights'), coys: ['mech', 'mech', 'inf'], xp: 2 },
      { name: 'Rifle bn (Ilchenkove)', kind: 'inf', cell: N('Ilchenkove'), coys: ['inf', 'inf', 'atgm'], xp: 1, role: 'hold' },
      { name: 'Tank bn (Novoprokopivka)', kind: 'tank', cell: N('Novoprokopivka'), coys: ['tank', 'tank', 'mech'], xp: 3, role: 'reserve' },
      { name: 'Regimental reserve', kind: 'mech', cell: N('Solodka Balka'), coys: ['mech', 'mech', 'mech'], xp: 2, role: 'reserve' },
    ],
    reinforcements: [
      { date: '2023-06-12', name: 'Tank bn (army reserve)', kind: 'tank', coys: ['tank', 'tank', 'mech'], xp: 2 },
      { date: '2023-08-14', name: 'Airborne bn (VDV)', kind: 'vdv', coys: ['vdv', 'vdv', 'vdv', 'tank'], xp: 5 },
      { date: '2023-08-28', name: 'Airborne bn (VDV) #2', kind: 'vdv', coys: ['vdv', 'vdv', 'vdv'], xp: 5 },
      { date: '2023-12-04', name: 'Storm-V detachment', kind: 'assault', coys: ['assault', 'assault', 'assault'], xp: 1 },
      { date: '2024-01-15', name: 'Motor-rifle bn (rotation)', kind: 'mech', coys: ['mech', 'mech', 'mech'], xp: 2 },
    ],
    batteries: [
      { kind: 'mortar120', name: '120 mm mortar battery', cell: N('Balka N of Robotyne') },
      { kind: 'd30', name: 'Howitzer bn (D-30)', cell: N('Ilchenkove') },
      { kind: 'msta', name: 'SP howitzer bn (2S19 Msta-S)', cell: N('Pshenychne') },
      { kind: 'grad', name: 'Rocket bn (BM-21 Grad)', cell: 'c9_11' },
    ],
    // ~10,000 rounds a day against Ukraine's ~3,600 (spring 2023); dense EW along the belt
    ammo: [{ date: '2023-02-06', a: 4.5 }, { date: '2023-10-01', a: 5.5 }, { date: '2024-01-01', a: 6 }], ammoStart: 8, ammoMax: 14, ew: 0.1, minStrength: 7, crisisWeeks: 4, crisisName: 'Motor-rifle bn (rushed in)',
    line: [{ date: '2023-02-06', l: 1.4 }, { date: '2023-06-05', l: 1.7 }, { date: '2023-10-16', l: 1.6 }],
    pressure: [{ date: '2023-02-06', p: 0.10 }, { date: '2023-06-05', p: 0.14 }, { date: '2023-08-14', p: 0.22 }, { date: '2023-10-16', p: 0.18 }, { date: '2023-12-04', p: 0.24 }, { date: '2024-02-05', p: 0.20 }],
    reinforce: [{ date: '2023-02-06', r: 0.10 }, { date: '2023-06-05', r: 0.06 }, { date: '2023-08-14', r: 0.10 }, { date: '2023-10-16', r: 0.06 }, { date: '2023-12-04', r: 0.08 }],
    forceTemplates: {
      1: [{ kind: 'defend', obj: 'A' }, { kind: 'defend', obj: 'B' }, { kind: 'foot', obj: 'A' }, { kind: 'atgm', obj: 'B' }, { kind: 'fpv' }],
      2: [{ kind: 'defend', obj: 'A' }, { kind: 'defend', obj: 'B' }, { kind: 'defend', obj: 'A' }, { kind: 'mech', obj: 'A' }, { kind: 'tank', obj: 'B' }, { kind: 'atgm', obj: 'B' }, { kind: 'fpv', obj: 'A' }, { kind: 'spg' }],
      3: [{ kind: 'defend', obj: 'A' }, { kind: 'defend', obj: 'B' }, { kind: 'defend', obj: 'B' }, { kind: 'imech', obj: 'A' }, { kind: 'assault', obj: 'B' }, { kind: 'mech', obj: 'A' }, { kind: 'tank', obj: 'A' }, { kind: 'tank', obj: 'B' }, { kind: 'atgm', obj: 'A' }, { kind: 'fpv', obj: 'B' }, { kind: 'spg' }],
    },
    artillery: 0.8, fpvThreat: 0.45, mortarMissions: 2,
    coyPower: 1.9,   // v7: a dug-in Russian company in the belt (minefields, ATGMs, Ka-52s, artillery on call) — ai.js COY_POWER
  },
  catalog: [
    { key: 'repl', label: 'Replacements (8 men)', desc: 'Mobilised soldiers from the brigade\'s reserve battalion to fill gaps in depleted squads.', kind: 'replacements', men: 8, lp: 12, eta: 1 },
    { key: 'repl_draft', label: 'Trained draft (16 men)', desc: 'A full draft through the brigade training centre: better prepared, arrives together.', kind: 'replacements', men: 16, lp: 20, eta: 2, req: ['ua_log_tc'] },
    { key: 'mech_btr', label: 'Mech. Coy (BTR-80)', desc: 'Eight-man squad with its wheeled carrier: KPVT and PKT, light armour.', kind: 'mech', vehicle: 'btr', men: 8, lp: 45, eta: 2, limit: 4 },
    { key: 'mech_bmp', label: 'Mech. Coy (BMP-2)', desc: 'Seven dismounts in a BMP-2: 30 mm cannon and Konkurs ATGM, thin armour.', kind: 'imech', vehicle: 'ifv', men: 7, lp: 55, eta: 2, limit: 3 },
    { key: 'mech_ifv', label: 'Mech. Coy (M2A2 Bradley)', desc: 'Six dismounts in an M2A2 ODS-SA: 25 mm Bushmaster, TOW-2, armour that brings crews home. Deliveries from spring 2023.', kind: 'imech', vehicle: 'ifv', men: 6, lp: 70, eta: 3, limit: 3, date: '2023-04-01' },
    { key: 'mech_ifv_plus', label: 'Mech. Coy (Bradley, 2nd)', desc: 'Further Bradleys from partner deliveries for a second mechanised company.', kind: 'imech', vehicle: 'ifv', men: 6, lp: 75, eta: 3, req: ['ua_arm_bradley2'], limit: 2 },
    { key: 'tank', label: 'T-64BV tank', desc: 'Brigade tank with a three-man crew: 125 mm gun, Kontakt-1 ERA.', kind: 'tank', vehicle: 'tank', men: 3, lp: 70, eta: 3, limit: 2 },
    { key: 'tank_plus', label: 'Tank (second platoon)', desc: 'Additional depot-repaired tank for a second tank platoon.', kind: 'tank', vehicle: 'tank', men: 3, lp: 85, eta: 4, req: ['ua_arm_tankpl'], limit: 2 },
    { key: 'assault', label: 'Assault Coy', desc: 'Six assaulters in heavy armour with optics and grenades for trench and house clearing.', kind: 'assault', men: 6, lp: 35, eta: 2, limit: 3 },
    { key: 'assault_plus', label: 'Assault Coy (assault bn)', desc: 'Additional assault squads from the brigade\'s assault company.', kind: 'assault', men: 6, lp: 40, eta: 2, req: ['ua_inf_assault'], limit: 2 },
    { key: 'atgm', label: 'Stugna-P ATGM team', desc: 'Three-man team with a Stugna-P launcher and missiles in transport tubes.', kind: 'atgm', men: 3, lp: 25, eta: 1, limit: 3 },
    { key: 'fpv', label: 'Drone team', desc: 'Pilot and assistant with five FPV strike quadcopters.', kind: 'fpv', men: 2, lp: 18, eta: 1, limit: 1 },
    { key: 'fpv_plus', label: 'FPV team (unmanned systems company)', desc: 'Additional FPV strike-drone crews (ten drones each) from the brigade\'s unmanned systems company.', kind: 'fpv', men: 2, lp: 20, eta: 1, req: ['ua_dr_uas'], limit: 3 },
    { key: 'spg', label: '155 mm self-propelled howitzer', desc: 'A 155 mm SP howitzer with its crew (M109 / 2S22 Bohdana class).', kind: 'spg', vehicle: 'spg', men: 5, lp: 100, eta: 4, req: ['ua_fire_spg'], limit: 1 },
  ],
  tech: TECH_UA,   // tech tree data: src/campaign/v2/tech.js (vehicle lines + upgrades, support branches)
  sources: [
    SRC.robotyne, SRC.counter, SRC.surovikin, SRC.isw0126, SRC.isw0608, SRC.isw0826, SRC.isw0923, SRC.nbc0828, SRC.isw1226, SRC.isw0217,
    { title: 'OpenStreetMap contributors (ODbL) — grid terrain, settlements, roads, fortifications', url: 'https://www.openstreetmap.org/copyright' },
    ...THEATRE2.sources,
  ],
};
