// Campaign v2 — Russian side: "Avdiivka 2023–24". One motor-rifle brigade's area of responsibility (AOR) on the
// Avdiivka salient north of Donetsk, from February 2023 (a year into the full-scale invasion: the fighting for
// Krasnohorivka north of the town and around Vodiane / Opytne south-west of it) through the summer of positional
// fighting, the offensive of 10 October 2023 (pincers on both flanks, the spoil heaps, Stepove, the industrial zone),
// the January 2024 break-in at Tsarska Okhota, the second breach and the cutting of the supply road, to the Ukrainian
// withdrawal on 17 February 2024 and the line west of the town at the end of February (ends 4 March 2024).
// Data contract: src/campaign/schema2.js (+ schema.js for UnitRecord / catalog / tech / MODS).
//
// The BRIGADE IS FICTIONAL (219th Separate Motor Rifle Brigade) and so are its people: real formations fought here and
// attributing this unit's actions to any of them would misrepresent them. The GEOGRAPHY (grid cells built from
// OpenStreetMap, see content_grid_ru.js), the starting line and the course of the operation are real and follow public
// reporting (sources below, per directive). Directive texts are paraphrased in-world orders, not quotations; no real
// person is named. The campaign depicts combat between armed forces only; it does not depict or reward harm to
// civilians or prisoners. The battle was among the costliest of the war for both sides.
import { GRID_RU as G } from './content_grid_ru.js';
import { THEATRE2 } from './content_theatre.js';
import { TECH_RU } from './tech.js';
import { GRID_EXT_RU as GX } from './content_grid_ext_ru.js';

const N = name => { const c = G.cells.find(x => x.name === name); if (!c) throw new Error(`RU grid: no cell named ${name}`); return c.id; };
const unit = (uid, key, name, kind, men, veh, xp = 0) => ({ uid, key, name, kind, men, menMax: men, wounded: 0, ...(veh ? { veh: { kind: veh, hp: 1, lost: false } } : {}), xp, battles: 0, kills: 0, status: 'ready' });

const SRC = {
  avdiivka: { title: 'Battle of Avdiivka (2023–2024) — Wikipedia', url: 'https://en.wikipedia.org/wiki/Battle_of_Avdiivka_(2023%E2%80%932024)' },
  isw0126: { title: 'ISW / CTP: Russian Offensive Campaign Assessment, 26 Jan 2023 (claims about Vodiane)', url: 'https://www.criticalthreats.org/analysis/russian-offensive-campaign-assessment-january-26-2023' },
  isw0320: { title: 'ISW / CTP: Russian Offensive Campaign Assessment, 20 Mar 2023 (tempo north of Avdiivka, Krasnohorivka, Stepove, Berdychi)', url: 'https://www.criticalthreats.org/analysis/russian-offensive-campaign-assessment-march-20-2023' },
  isw1010: { title: 'ISW / CTP: Russian Offensive Campaign Assessment, 10 Oct 2023', url: 'https://www.criticalthreats.org/analysis/russian-offensive-campaign-assessment-october-10-2023' },
  isw1011: { title: 'ISW / CTP: Russian Offensive Campaign Assessment, 11 Oct 2023', url: 'https://www.criticalthreats.org/analysis/russian-offensive-campaign-assessment-october-11-2023' },
  up1126: { title: 'Ukrainska Pravda: Russian forces keep advancing near Avdiivka – ISW (26 Nov 2023)', url: 'https://www.pravda.com.ua/eng/news/2023/11/26/7430403' },
  up1204: { title: 'Ukrainska Pravda: Russian forces make headway in several spots near Avdiivka – ISW (4 Dec 2023)', url: 'https://www.pravda.com.ua/eng/news/2023/12/04/7431511/' },
  up0122: { title: 'Ukrainska Pravda: ISW records movement of Russian troops through Avdiivka streets (22 Jan 2024)', url: 'https://pravda.com.ua/eng/news/2024/01/22/7438289/' },
  isw0217: { title: 'ISW / CTP: Russian Offensive Campaign Assessment, 17 Feb 2024', url: 'https://www.criticalthreats.org/analysis/russian-offensive-campaign-assessment-february-17-2024' },
  meduza0219: { title: 'Meduza: Russia has full control of Avdiivka coke plant, says Russian MoD (19 Feb 2024)', url: 'https://meduza.io/en/news/2024/02/19/russia-has-full-control-of-avdiivka-coke-and-chemical-plant-says-russian-defense-ministry' },
  emp0227: { title: 'Euromaidan Press: Ukraine withdraws from Stepove, Severne near Avdiivka (27 Feb 2024)', url: 'https://euromaidanpress.com/2024/02/27/military-ukraine-withdraws-from-stepove-severne-near-avdiivka/' },
};
// campaign v5: the grid grows west past the original AOR (growth.js; negative column numbers, content_grid_ext_ru.js)
const XN = name => { for (const b of GX.bands) { const c = b.cells.find(x => x.name === name); if (c) return c.id; } throw new Error(`RU grid extension: no cell named ${name}`); };
const EXT_BANDS = {
  ru_x1: { name: 'Novoselivka Persha – Netailove',
    text: 'West of Berdychi, Orlivka and Tonenke the Ukrainian rear opens up along the Vovcha: Sokil, Yevhenivka, Novoselivka Persha on the O0542 and Netailove on the road to Pokrovsk.',
    hubs: [{ cell: XN('Novoselivka Persha'), name: 'Novoselivka Persha supply point (O0542)', kind: 'ammo', side: 'enemy' }],
    forces: [{ name: 'Mech. bn (Novoselivka Persha)', kind: 'mech', cell: XN('Novoselivka Persha'), coys: ['mech', 'mech', 'inf'], xp: 2 }, { name: 'Rifle bn (Netailove)', kind: 'inf', cell: XN('Netailove'), coys: ['inf', 'inf', 'inf'], xp: 1 }],
    directives: [{ id: 'ru_x_novoselivka', issue: { when: 'grown:ru_x1' }, from: 'Group of Forces "Centre"', title: 'Pursue west: Novoselivka Persha', kind: 'capture', targets: [XN('Novoselivka Persha')], deadline: 7,
      text: 'The enemy\'s line west of Avdiivka is broken. Do not let him dig in on the Vovcha: take Novoselivka Persha and the O0542 crossing before his reserves arrive.',
      reward: { lp: 60 }, penalty: { lp: 5 }, history: 'After Avdiivka fell in February 2024 Russian forces kept attacking west along the Vovcha towards Pokrovsk; Novoselivka Persha and Netailove were fought over through the spring and summer of 2024.', sources: [SRC.avdiivka] }] },
  ru_x2: { name: 'Karlivka – Prohres',
    text: 'The Karlivka reservoir anchors the Ukrainian line to the south-west; north of it Prohres sits on the railway and the road from Ocheretyne to Pokrovsk.',
    hubs: [{ cell: XN('Karlivka'), name: 'Karlivka supply point (dam road)', kind: 'ammo', side: 'enemy' }],
    forces: [{ name: 'Rifle bn (Karlivka)', kind: 'inf', cell: XN('Karlivka'), coys: ['inf', 'inf', 'atgm'], xp: 2 }, { name: 'Mech. bn (Prohres)', kind: 'mech', cell: XN('Prohres'), coys: ['mech', 'mech', 'inf'], xp: 2 }],
    directives: [{ id: 'ru_x_prohres', issue: { when: 'grown:ru_x2' }, from: 'Group of Forces "Centre"', title: 'Cut the railway at Prohres', kind: 'capture', targets: [XN('Prohres')], deadline: 6,
      text: 'Take Prohres on the Ocheretyne – Pokrovsk railway and road: the enemy\'s northern flank then has no lateral road left.',
      reward: { lp: 60 }, penalty: { lp: 5 }, history: 'Prohres and the villages along the Ocheretyne – Pokrovsk railway were fought over in the spring of 2024.', sources: [SRC.avdiivka] }] },
  ru_x3: { name: 'Blahodatne – Halytsynivka',
    text: 'The Ukrainian rear on the road to Pokrovsk: Blahodatne, Halytsynivka and the villages on the upper Vovcha, depots and reserve positions.',
    hubs: [{ cell: XN('Blahodatne'), name: 'Blahodatne logistics base (Pokrovsk road)', kind: 'base', side: 'enemy' }],
    forces: [{ name: 'Mech. bn (Pokrovsk axis reserve)', kind: 'mech', cell: XN('Blahodatne'), coys: ['mech', 'mech', 'mech', 'tank'], xp: 3 }],
    directives: [{ id: 'ru_x_blahodatne', issue: { when: 'grown:ru_x3' }, from: 'Group of Forces "Centre"', title: 'Blahodatne', kind: 'capture', targets: [XN('Blahodatne')], deadline: 7,
      text: 'Take Blahodatne and the enemy\'s logistics base on the Pokrovsk road.', reward: { lp: 90 }, penalty: { lp: 5 },
      history: 'The 2024 Russian offensive west of Avdiivka was aimed at Pokrovsk, the main logistics hub of the Ukrainian forces in Donetsk oblast.', sources: [SRC.avdiivka] }] },
};
const EXT_RU = { dir: GX.dir, bbox: GX.bbox, geo: GX.geo, osm: 'osm_RU_ext', bands: GX.bands.map(b => ({ ...b, ...EXT_BANDS[b.id] })) };

// Brigade scale: every unit record is a COMPANY (fought on the RTS battle map by a representative squad / vehicle), every
// task force a BATTALION group. In February 2023 the brigade holds the arc from Vesele to Pisky dispersed, a battalion
// per stretch of front, the tanks at Yasynuvata: an assault group has to be assembled deliberately.
const START_UNITS = [
  unit('ru_u1', 'mech_btr', '1st MR Coy (BTR-82A)', 'mech', 8, 'btr', 1),
  unit('ru_u2', 'mech_btr', '4th MR Coy (BTR-82A)', 'mech', 8, 'btr', 0),
  unit('ru_u3', 'mech_ifv', '7th MR Coy (BMP-2)', 'imech', 7, 'ifv', 1),
  unit('ru_u4', 'mech_ifv', '8th MR Coy (BMP-2)', 'imech', 7, 'ifv', 0),
  unit('ru_u5', 'assault', 'Assault detachment, 1st Bn', 'assault', 6, null, 1),
  unit('ru_u6', 'tank', '1st Tank Coy (T-72B3)', 'tank', 3, 'tank', 1),
  unit('ru_u7', 'tank', '2nd Tank Coy (T-72B3)', 'tank', 3, 'tank', 0),
  unit('ru_u8', 'atgm', 'AT platoon (Kornet)', 'atgm', 3, null, 1),
  unit('ru_u9', 'fpv', 'UAV platoon', 'fpv', 2, null, 0),
  unit('ru_u10', 'mech_btr', '5th MR Coy (BTR-82A)', 'mech', 8, 'btr', 0),
  unit('ru_u11', 'assault', 'Assault detachment, 3rd Bn', 'assault', 6, null, 0),
  unit('ru_u12', 'atgm', 'AT platoon (Kornet) #2', 'atgm', 3, null, 0),
];

export const CAMPAIGN2_RU = {
  id: 'RU', version: 2,
  title: 'Avdiivka 2023–24',
  subtitle: 'Donetsk, February 2023 – March 2024',
  brigade: { name: '219th Separate Motor Rifle Brigade (fictional)', short: '219 OMSBr' },
  intro: {
    place: 'Avdiivka sector, Donetsk',
    date: 'February 2023',
    lines: [
      'Avdiivka: a fortified Ukrainian salient on the edge of Donetsk since 2014 — the coke plant and the high-rises on the horizon.',
      'Higher command wants the town enveloped from the flanks and its supply roads cut.',
      'The 219th Brigade holds the line from Krasnohorivka to the ruins of the Donetsk airport.',
      'The ground is open, the defences are deep, and every approach is watched.',
    ],
  },
  start: {
    date: '2023-02-06', turnDays: 7, end: '2024-03-04', lp: 60, hq: N('Yasynuvata'),
    forces: [
      { id: 'tf_b1', name: '1st MR Bn (Vesele)', cell: N('Vesele'), units: ['ru_u1', 'ru_u5'], stance: 'hold' },
      { id: 'tf_b2', name: '2nd MR Bn (Kamianka)', cell: N('Kamianka'), units: ['ru_u3', 'ru_u12'], stance: 'hold' },
      { id: 'tf_b3', name: '3rd MR Bn (Promzona front)', cell: 'c9_8', units: ['ru_u2', 'ru_u11'], stance: 'hold' },
      { id: 'tf_b4', name: '4th MR Bn (Spartak)', cell: N('Spartak'), units: ['ru_u4', 'ru_u8'], stance: 'hold' },
      { id: 'tf_b5', name: 'Rifle Bn (Pisky)', cell: N('Pisky'), units: ['ru_u10'], stance: 'hold' },
      { id: 'tf_tank', name: 'Tank Bn', cell: N('Yasynuvata'), units: ['ru_u6', 'ru_u7', 'ru_u9'], stance: 'rest' },
    ],
    // the brigade artillery group (fires.js)
    batteries: [
      { id: 'b_mor', kind: 'mortar120', name: '120 mm mortar battery', cell: 'c8_6' },
      { id: 'b_d30', kind: 'd30', name: 'Howitzer bn (D-30)', cell: N('Kashtanove') },
      { id: 'b_msta', kind: 'msta', name: 'SP howitzer bn (2S19 Msta-S)', cell: N('Mineralne') },
      { id: 'b_grad', kind: 'grad', name: 'Rocket bn (BM-21 Grad)', cell: 'c10_5' },
    ],
    // weekly shell allocation in fire missions: plentiful, more for the October offensive, North Korean shells in 2024
    // ("ten-to-one" at Avdiivka in February 2024)
    ammo: [{ date: '2023-02-06', a: 4.5 }, { date: '2023-10-01', a: 6 }, { date: '2024-01-01', a: 7 }],
    ammoStart: 8, ammoMax: 16, uavStock: 6,
    units: START_UNITS,
    unlocked: ['ru_arm_cage', 'ru_dr_orlan'],
    available: ['repl', 'mech_btr', 'mech_ifv', 'tank', 'assault', 'atgm', 'atgm_truck', 'fpv'],
  },
  theatre: { ...THEATRE2 },
  aor: {
    name: 'Avdiivka salient', bbox: G.bbox, cellKm: G.cellKm, cols: G.cols, rows: G.rows,
    enemyEdge: G.enemyEdge, supplySources: G.supplySources, cells: G.cells,
    // supply.js: the Ukrainian rear (Pokrovsk, the Ocheretyne rail line) lies off the western edge
    enemySources: ['c0_3', 'c0_6', 'c0_9', 'c6_0', 'c10_0'],
    hubs: [
      { cell: N('Yasynuvata'), name: 'Yasynuvata railhead', kind: 'railhead', side: 'player' },
      { cell: N('Yakovlivka'), name: 'Yakovlivka ammunition point (N-20)', kind: 'ammo', side: 'player' },
      { cell: N('Kamianka'), name: 'Kamianka forward supply point', kind: 'ammo', side: 'player' },
      { cell: N('Ocheretyne'), name: 'Ocheretyne railhead', kind: 'railhead', side: 'enemy' },
      { cell: N('Lastochkyne'), name: 'Lastochkyne junction — the "road of life" into Avdiivka', kind: 'base', side: 'enemy' },
      { cell: N('Pervomaiske'), name: 'Pervomaiske supply point (M-30)', kind: 'ammo', side: 'enemy' },
    ],
    reveal: 3,
    osm: 'assets/campaign/osm/RU/', geo: 'assets/campaign/osm/RU/aor_v2.json',
    ext: EXT_RU,
    notes: 'Starting line of 6 Feb 2023: Russian forces east and south of the salient (Yasynuvata, Spartak, the Donetsk airport, Pisky), in Vesele, Kamianka and Novoselivka Druha to the north-east; Krasnohorivka contested. The town, the coke plant, the industrial zone, Opytne, Vodiane and the western supply villages Ukrainian-held. Supply from the east and south edges (Yasynuvata railhead, the N-20, the T-05-05 from Donetsk).',
  },
  directives: [
    // ---------------------------------------------------------------- winter / spring 2023: the flanks
    { id: 'ru_krasnohorivka', issue: { date: '2023-02-06' }, from: 'Group of Forces "Centre"', title: 'Krasnohorivka', kind: 'capture',
      targets: [N('Krasnohorivka')], deadlineDate: '2023-03-27',
      text: 'North of Avdiivka the enemy still holds part of Krasnohorivka. From Vesele, take the village among the ponds and tree belts as the jump-off line for the northern flank.',
      reward: { lp: 50 }, penalty: { lp: 15 },
      history: 'Russian forces fought into Krasnohorivka north of Avdiivka in February–March 2023 and pushed west towards Stepove and Berdychi. On 20 March ISW assessed that the tempo north of the town was rising to set up an encirclement.',
      sources: [SRC.isw0320, SRC.avdiivka] },
    { id: 'ru_vodiane', issue: { date: '2023-02-06' }, from: 'Group of Forces "Centre"', title: 'Pressure Vodiane and Opytne', kind: 'raid',
      targets: [N('Vodiane'), N('Opytne')], count: 1, deadlineDate: '2023-04-17',
      text: 'Keep the enemy\'s southern flank under pressure: attack the positions at Vodiane or Opytne from the airport and Spartak. The attack counts whether or not you take the ground.',
      reward: { lp: 35 }, penalty: { lp: 5 },
      history: 'Russian and DNR units attacked Vodiane in January 2023 and claimed to control it. The fighting for Vodiane and Opytne went on, and the line south-west of Avdiivka barely moved in 2023.',
      sources: [SRC.isw0126, SRC.avdiivka] },
    { id: 'ru_hold_krasn', issue: { when: `captured:${N('Krasnohorivka')}` }, from: 'Army HQ', title: 'Hold Krasnohorivka', kind: 'hold',
      targets: [N('Krasnohorivka')], count: 4, deadline: 6,
      text: 'Expect counterattacks on Krasnohorivka. Keep a task force there with Kornet teams and dig in among the ponds (Dig in stance).',
      reward: { lp: 30 }, penalty: { lp: 10 },
      history: 'Krasnohorivka became the jump-off point for the northern attacks of October 2023 towards the spoil heaps and Stepove.',
      sources: [SRC.avdiivka] },
    { id: 'ru_stepove_spring', issue: { date: '2023-03-20' }, from: 'Group of Forces "Centre"', title: 'Towards Stepove and Berdychi', kind: 'capture',
      targets: [N('Stepove')], deadlineDate: '2023-05-22',
      text: 'Develop the attack west of Krasnohorivka along the railway. Seize Stepove and threaten the Avdiivka – Ocheretyne line; glide-bomb strikes can be requested from high command (Fires).',
      reward: { lp: 60 }, penalty: { lp: 10 },
      history: 'Russian sources claimed Stepove in March 2023, but the village stayed in Ukrainian hands until February 2024; the spring attacks north of Avdiivka cost heavy losses and culminated.',
      sources: [SRC.isw0320] },
    // ---------------------------------------------------------------- summer 2023: positional fighting
    { id: 'ru_pin', issue: { date: '2023-05-15' }, from: 'Army HQ', title: 'Tie down the garrison', kind: 'destroy', targets: [], count: 4, deadlineDate: '2023-07-31',
      text: 'The enemy is preparing an offensive elsewhere. Keep his Avdiivka garrison tied down: destroy his armoured vehicles in the sector — ATGMs, drones and tanks in battle — or his guns by counter-battery fire, so that no reserves leave the salient.',
      reward: { lp: 40 }, penalty: { lp: 5 },
      history: 'While the Ukrainian counteroffensive ran in Zaporizhzhia and around Bakhmut in summer 2023, Russian forces kept up artillery, air and local ground pressure on Avdiivka.',
      sources: [SRC.avdiivka] },
    { id: 'ru_hold_summer', issue: { date: '2023-06-12' }, from: 'Army HQ', title: 'Active defence: hold the sector', kind: 'survive',
      targets: [N('Yasynuvata'), N('Spartak'), N('Donetsk airport'), N('Vesele')], deadlineDate: '2023-09-04',
      text: 'Hold Yasynuvata, Spartak, the airport and Vesele through the summer. Rebuild the battalions (replacements), train the assault detachments (High command) and let the shell stocks build up for the autumn.',
      reward: { lp: 40 }, penalty: { lp: 15 },
      history: 'Through the summer of 2023 the Avdiivka front saw positional fighting and shelling while both sides prepared for the autumn.',
      sources: [SRC.avdiivka] },
    { id: 'ru_recon_plant', issue: { date: '2023-08-28' }, from: 'Army HQ — Intelligence', title: 'Reconnoitre the plant and the industrial zone', kind: 'recon',
      targets: [N('Spoil heaps'), N('Avdiivka Coke Plant'), N('Promzona')], deadlineDate: '2023-10-09',
      text: 'Before the offensive: get eyes on the spoil heaps, the coke plant and the industrial zone — UAV sorties over them, or a task force pushed up next to them.',
      reward: { lp: 35, unlock: ['ru_dr_zala'] }, penalty: { lp: 5 },
      history: 'Through September 2023 Russia assembled several brigades and large numbers of armoured vehicles around Avdiivka.',
      sources: [SRC.isw1011] },
    // ---------------------------------------------------------------- October 2023: the offensive
    { id: 'ru_north_pincer', issue: { date: '2023-10-09' }, from: 'Group of Forces "Centre"', title: 'Northern pincer: the spoil heaps', kind: 'capture',
      targets: [N('Spoil heaps')], deadlineDate: '2023-11-27',
      text: 'From Krasnohorivka and Vesele the brigade attacks south-west. Immediate task: seize the coke plant\'s spoil heaps west of the railway, which overlook the plant and the northern quarters. Suppress them with the artillery before the attack; assault groups lead, armour in support.',
      reward: { lp: 70 }, penalty: { lp: 15 }, next: { success: 'ru_stepove', failure: 'ru_north2' },
      history: 'The offensive opened on 10 October 2023 with armoured attacks on three flanks and heavy vehicle losses to mines, ATGMs, drones and artillery. Russian forces took the spoil heap west of the railway around 28 October.',
      sources: [SRC.isw1010, SRC.isw1011, SRC.avdiivka] },
    { id: 'ru_south_pincer', issue: { date: '2023-10-09' }, from: 'Group of Forces "Centre"', title: 'Southern pincer: Tsarska Okhota', kind: 'capture',
      targets: [N('Tsarska Okhota')], deadlineDate: '2023-10-30',
      text: 'Simultaneously, from Spartak, assault the fortified restaurant complex at Tsarska Okhota on the south-eastern exit of the town. Expect prepared positions, mines and ATGMs on the approach: suppress it first.',
      reward: { lp: 60 }, penalty: { lp: 10 }, next: { success: 'ru_zenit', failure: 'ru_promzona' },
      history: 'The attack on Tsarska Okhota on 19 October 2023 failed; the southern effort shifted east to the industrial zone.',
      sources: [SRC.avdiivka] },
    { id: 'ru_north2', issue: {}, from: 'Group of Forces "Centre"', title: 'Renewed attack on the spoil heaps', kind: 'capture',
      targets: [N('Spoil heaps')], deadline: 5,
      text: 'The first attack has stalled under ATGM and drone fire. Regroup, bring up fresh assault detachments and attack the spoil heaps again with small task forces after a fire mission.',
      reward: { lp: 45 }, penalty: { lp: 10 }, next: { success: 'ru_stepove', failure: 'ru_stepove' },
      history: 'After a pause from 22 to 24 October 2023 to regroup and bring in reserves, Russian forces resumed the attacks north of the plant.',
      sources: [SRC.avdiivka] },
    { id: 'ru_stepove', issue: { date: '2023-11-06' }, from: 'Group of Forces "Centre"', title: 'Cut the railway: Stepove', kind: 'capture',
      targets: [N('Stepove')], deadlineDate: '2024-01-29',
      text: 'Develop the attack west along the railway north of the plant. Seize Stepove and cut the Avdiivka – Ocheretyne line north of the plant.',
      reward: { lp: 60 }, penalty: { lp: 10 },
      history: 'Russian forces reached the railway north of the plant on 3 November 2023, entered eastern Stepove on 10 November and western Stepove in late January; the village was fully taken only at the end of February 2024.',
      sources: [SRC.avdiivka, SRC.emp0227] },
    { id: 'ru_promzona', issue: { date: '2023-11-13' }, from: 'Group of Forces "Centre"', title: 'The industrial zone', kind: 'capture',
      targets: [N('Promzona')], deadlineDate: '2023-12-11',
      text: 'Take the industrial zone by the N-20 and the Yasynuvata-2 station. A tank from the army reserve is attached on completion.',
      reward: { lp: 70, units: [unit('ru_rw_t1', 'tank', 'T-72B3 "213"', 'tank', 3, 'tank', 0)] }, penalty: { lp: 15 },
      history: 'Russian forces entered the industrial zone south-east of Avdiivka on 13 November 2023 and reported it fully under their control on 4 December.',
      sources: [SRC.up1126, SRC.up1204, SRC.avdiivka] },
    { id: 'ru_hold_promzona', issue: { when: `captured:${N('Promzona')}` }, from: 'Army HQ', title: 'Hold the industrial zone', kind: 'hold',
      targets: [N('Promzona')], count: 3, deadline: 5,
      text: 'Expect counterattacks to retake the industrial zone. Keep a task force there with Kornet teams and dig in among the concrete works (Dig in stance).',
      reward: { lp: 30 }, penalty: { lp: 10 } },
    { id: 'ru_counter', issue: { date: '2023-11-20' }, from: 'Army HQ', title: 'Defeat the counterattacks at the plant', kind: 'destroy',
      targets: [N('Avdiivka Coke Plant'), N('Stepove'), N('Spoil heaps'), N('Avdiivka NE')], count: 3, deadlineDate: '2024-01-22',
      text: 'The enemy is committing armoured reserves, Bradleys among them, to counterattacks around the plant, the spoil heaps and Stepove. Destroy his armoured vehicles there — ATGMs, drones and tanks in battle — or his guns there by counter-battery fire.',
      reward: { lp: 45 }, penalty: { lp: 5 },
      history: 'Ukrainian brigades counterattacked repeatedly around the coke plant and Stepove in November and December 2023 and retook some positions near Stepove on 19 November.',
      sources: [SRC.avdiivka, SRC.up1126] },
    // ---------------------------------------------------------------- January – February 2024: the town
    { id: 'ru_tsarska', issue: { date: '2024-01-08' }, from: 'Group of Forces "Centre"', title: 'Through the pipe: Tsarska Okhota', kind: 'capture',
      targets: [N('Tsarska Okhota')], deadlineDate: '2024-01-29',
      onIssue: { fortDown: [N('Tsarska Okhota')] }, text: 'Engineers have found a disused drainage pipe running north from near Spartak under the enemy positions: assault groups can come out behind the defences at Tsarska Okhota (its fortifications now count one level lower). Attack it from Spartak and the industrial zone.',
      reward: { lp: 65 }, penalty: { lp: 10 }, next: { success: 'ru_zenit', failure: 'ru_zenit' },
      history: 'Around 20 January 2024 Russian forces broke into southern Avdiivka and took Tsarska Okhota, reportedly using a tunnel route; on 22 January ISW recorded movement along Soborna Street.',
      sources: [SRC.up0122, SRC.avdiivka] },
    { id: 'ru_zenit', issue: { date: '2024-01-29' }, from: 'Group of Forces "Centre"', title: 'Zenit', kind: 'isolate',
      targets: [N('Zenit')], deadlineDate: '2024-02-19',
      text: 'Push west from the south-eastern quarters and Opytne and envelop the Zenit strongpoint on the southern outskirts. Do not storm it frontally if it can be cut off: take the squares around it until no enemy supply route reaches it.',
      reward: { lp: 60 }, penalty: { lp: 10 },
      history: 'In early February 2024 Russian forces advanced east of Opytne and half-encircled the Zenit position; its defenders withdrew on 14–15 February.',
      sources: [SRC.avdiivka] },
    { id: 'ru_ne_breach', issue: { date: '2024-02-01' }, from: 'Group of Forces "Centre"', title: 'Second breach from the north-east', kind: 'capture',
      targets: [N('Avdiivka NE')], deadlineDate: '2024-02-19',
      text: 'Attack from Vesele and Kamianka into the dacha plots on the north-eastern edge of the town and split the garrison between the plant and the high-rise quarters.',
      reward: { lp: 60 }, penalty: { lp: 10 },
      history: 'On 2–9 February 2024 Russian forces made a second breakthrough into northern Avdiivka, threatening to split the town from the coke plant.',
      sources: [SRC.avdiivka] },
    { id: 'ru_khimik', issue: { date: '2024-02-08' }, from: 'Group of Forces "Centre"', title: 'Cut the main supply road', kind: 'capture',
      targets: [N('Khimik')], deadlineDate: '2024-02-26',
      text: 'Seize the Khimik quarter and cut Industrialnyi Avenue, the garrison\'s main supply road between the town and the plant; interdiction fire on the roads beyond it cuts his supply further.',
      reward: { lp: 70 }, penalty: { lp: 15 },
      history: 'By 14 February 2024 the main road into the town was lost to the defenders; on 15 February Ukraine confirmed a partial withdrawal.',
      sources: [SRC.avdiivka, SRC.isw0217] },
    { id: 'ru_avdiivka', issue: { date: '2024-02-12' }, from: 'Group of Forces "Centre"', title: 'Avdiivka', kind: 'capture',
      targets: [N('Avdiivka'), N('Avdiivka Coke Plant')], deadlineDate: '2024-03-04',
      text: 'Take the high-rise quarters of Avdiivka and the coke plant. The garrison is close to encirclement; expect rearguards in the plant\'s bunkers and shelters.',
      reward: { lp: 120 }, penalty: { lp: 20 }, next: { success: 'ru_final', failure: 'ru_final' },
      history: 'On 17 February 2024 Ukraine announced the withdrawal of its forces from Avdiivka to avoid encirclement; Russia claimed full control of the town that day and of the coke plant on 19 February. Both sides lost very heavily in the four-month battle.',
      sources: [SRC.isw0217, SRC.meduza0219, SRC.avdiivka] },
    { id: 'ru_final', issue: { after: 'ru_avdiivka', date: '2024-02-17' }, final: true, from: 'Group of Forces "Centre"', title: 'West of Avdiivka: Lastochkyne, Sieverne, Stepove', kind: 'capture',
      targets: [N('Lastochkyne'), N('Sieverne'), N('Stepove')], deadlineDate: '2024-03-04',
      text: 'Final task of the brigade in this campaign: pursue the withdrawing enemy west of the town and take Lastochkyne, Sieverne and Stepove before he can build a new line.',
      reward: { lp: 80 },
      history: 'Russian forces took Lastochkyne on 24–26 February 2024 and Stepove and Sieverne by 27 February; the line then steadied along Tonenke – Orlivka – Berdychi.',
      sources: [SRC.emp0227, SRC.avdiivka] },
    { id: 'ru_lost_vesele', issue: { when: `lost:${N('Vesele')}` }, from: 'Army HQ', title: 'Restore the position at Vesele', kind: 'capture',
      targets: [N('Vesele')], deadline: 3,
      text: 'The enemy has retaken Vesele and threatens the northern flank. Counterattack before he consolidates.',
      reward: { lp: 25 }, penalty: { lp: 20 } },
    { id: 'ru_lost_spartak', issue: { when: `lost:${N('Spartak')}` }, from: 'Army HQ', title: 'Restore the position at Spartak', kind: 'capture',
      targets: [N('Spartak')], deadline: 3,
      text: 'The enemy has broken into Spartak and threatens the road to Donetsk. Counterattack immediately.',
      reward: { lp: 25 }, penalty: { lp: 20 } },
  ],
  // THE OPERATION GOAL (state.js goalProgress / outcome): all four squares held at the end of a week = victory; at the
  // end of the campaign half the points = limited success.
  goal: {
    title: 'Take Avdiivka',
    text: 'Envelop the town, cut the "road of life" at Lastochkyne, take the coke plant, Khimik and the high-rise centre. The garrison lives on that one road: cut it and the town starves of shells.',
    by: '2024-03-04', partial: 0.5,
    cells: [{ cell: N('Avdiivka'), pts: 3 }, { cell: N('Avdiivka Coke Plant'), pts: 3 }, { cell: N('Khimik'), pts: 2 }, { cell: N('Lastochkyne'), pts: 2 }],
    history: 'Russian forces enveloped Avdiivka from October 2023, reached the main supply road in early February 2024 and cut it mid-month; Ukraine withdrew on 17 February "to avoid encirclement", and Lastochkyne fell a week later.',
  },
  enemy: {
    // the Ukrainian garrison's battalion groups, moved by the enemy commander (ai.js); real brigades are not named.
    // v7: organised like the player's brigade — battalion groups of companies (coys) where the garrison stood: the
    // town centre, the coke plant, Khimik, the Promzona / Tsarska Okhota strongpoints, Stepove – Berdychi in the
    // north-west, the northern flank at Novokalynove – Novobakhmutivka – Verkhnotoretske, Opytne – Vodiane –
    // Pervomaiske in the south, a tank company and the brigade reserve on the Lastochkyne "road of life".
    // Outposts (one company each, ai.js deploy) fill the gaps; the squares behind are empty. role 'hold' = the
    // garrison of a strongpoint the brigade must take (it holds; relieved only in place).
    forces: [
      { name: 'Mech. bn (Avdiivka centre)', kind: 'mech', cell: N('Avdiivka'), coys: ['mech', 'mech', 'inf', 'mech'], xp: 4, role: 'hold' },
      { name: 'Mech. bn (coke plant)', kind: 'mech', cell: N('Avdiivka Coke Plant'), coys: ['mech', 'mech', 'inf', 'atgm'], xp: 4, role: 'hold' },
      { name: 'Rifle bn (Khimik)', kind: 'inf', cell: N('Khimik'), coys: ['inf', 'inf', 'atgm'], xp: 3, role: 'hold' },
      { name: 'Rifle bn (Avdiivka north)', kind: 'inf', cell: N('Avdiivka (north)'), coys: ['inf', 'inf'], xp: 3 },
      { name: 'Mech. bn (Promzona – Tsarska Okhota)', kind: 'mech', cell: N('Tsarska Okhota'), coys: ['mech', 'inf', 'inf'], xp: 3 },
      { name: 'Mech. bn (Stepove)', kind: 'mech', cell: N('Stepove'), coys: ['mech', 'mech', 'inf'], xp: 2 },
      { name: 'Rifle bn (Berdychi)', kind: 'inf', cell: N('Berdychi'), coys: ['inf', 'inf', 'atgm'], xp: 2 },
      { name: 'Rifle bn (Novokalynove)', kind: 'inf', cell: N('Novokalynove'), coys: ['inf', 'inf', 'inf'], xp: 2 },
      { name: 'Territorial bn (Novobakhmutivka – Verkhnotoretske)', kind: 'inf', cell: 'c8_2', coys: ['inf', 'inf', 'inf'], xp: 1 },
      { name: 'Rifle bn (Vodiane – Opytne)', kind: 'inf', cell: N('Opytne'), coys: ['inf', 'inf', 'atgm'], xp: 2 },
      { name: 'Rifle bn (Pervomaiske – Nevelske)', kind: 'inf', cell: 'c1_10', coys: ['inf', 'inf', 'inf'], xp: 2 },
      { name: 'Tank coy (Orlivka)', kind: 'tank', cell: N('Orlivka'), coys: ['tank', 'mech'], xp: 3, role: 'reserve' },
      { name: 'Rifle bn (Lastochkyne – Sieverne)', kind: 'inf', cell: N('Lastochkyne'), coys: ['inf', 'inf', 'atgm'], xp: 2, role: 'hold' },
      { name: 'Brigade reserve', kind: 'mech', cell: N('Lastochkyne'), coys: ['mech', 'mech', 'mech', 'tank'], xp: 3, role: 'reserve' },
    ],
    reinforcements: [
      { date: '2023-10-16', name: 'Mech. bn (Bradley)', kind: 'mech', coys: ['mech', 'mech', 'mech', 'tank'], xp: 5 },
      { date: '2023-11-13', name: 'Mech. bn (reinforcement)', kind: 'mech', coys: ['mech', 'mech', 'inf'], xp: 3 },
      { date: '2023-12-11', name: 'Rifle bn (reinforcement)', kind: 'inf', coys: ['inf', 'inf', 'inf'], xp: 2 },
      { date: '2024-01-15', name: 'Mech. bn (reinforcement) #2', kind: 'mech', coys: ['mech', 'mech', 'inf'], xp: 2 },
      { date: '2024-02-12', name: 'Assault bn', kind: 'assault', coys: ['assault', 'assault', 'assault', 'mech'], xp: 6 },
    ],
    batteries: [
      { kind: 'mortar120', name: '120 mm mortar battery', cell: N('Avdiivka (north)') },
      { kind: 'how122', name: 'SP artillery bn (2S1)', cell: N('Orlivka') },
      { kind: 'm777', name: '155 mm battery (M777)', cell: N('Semenivka') },
      { kind: 'grad', name: 'Rocket bn (BM-21)', cell: 'c1_6' },
    ],
    // Ukrainian shell hunger: rationed in 2023, ~2,000 rounds/day by early 2024; Russian EW lighter here than ours
    ammo: [{ date: '2023-02-06', a: 3 }, { date: '2023-10-01', a: 3.5 }, { date: '2023-12-15', a: 2 }, { date: '2024-01-15', a: 1.5 }], ammoStart: 5, ammoMax: 10, ew: 0.08, minStrength: 8, crisisWeeks: 3, crisisName: 'Mech. bn (rushed in)',
    line: [{ date: '2023-02-06', l: 1.8 }, { date: '2023-10-09', l: 1.9 }, { date: '2024-01-15', l: 1.6 }],
    // Ukrainian behaviour on the grid: local counterattacks in 2023, frequent armoured counterattacks around the plant
    // in Oct–Dec, last reserves committed in February 2024, then withdrawal.
    pressure: [{ date: '2023-02-06', p: 0.08 }, { date: '2023-06-05', p: 0.10 }, { date: '2023-10-09', p: 0.18 }, { date: '2023-12-11', p: 0.15 }, { date: '2024-02-05', p: 0.22 }, { date: '2024-02-19', p: 0.08 }],
    reinforce: [{ date: '2023-02-06', r: 0.06 }, { date: '2023-10-09', r: 0.08 }, { date: '2024-02-05', r: 0.12 }, { date: '2024-02-19', r: 0.03 }],
    forceTemplates: {
      1: [{ kind: 'defend', obj: 'A' }, { kind: 'defend', obj: 'B' }, { kind: 'foot', obj: 'A' }, { kind: 'fpv', obj: 'B' }, { kind: 'atgm', obj: 'B' }],
      2: [{ kind: 'defend', obj: 'A' }, { kind: 'defend', obj: 'B' }, { kind: 'defend', obj: 'A' }, { kind: 'foot', obj: 'B' }, { kind: 'imech', obj: 'A' }, { kind: 'atgm', obj: 'B' }, { kind: 'fpv', obj: 'A' }, { kind: 'fpv', obj: 'B' }],
      3: [{ kind: 'defend', obj: 'A' }, { kind: 'defend', obj: 'B' }, { kind: 'defend', obj: 'B' }, { kind: 'imech', obj: 'A' }, { kind: 'imech', obj: 'B' }, { kind: 'assault', obj: 'A' }, { kind: 'tank', obj: 'A' }, { kind: 'atgm', obj: 'B' }, { kind: 'fpv', obj: 'A' }, { kind: 'fpv', obj: 'B' }, { kind: 'spg' }],
    },
    artillery: 0.5, fpvThreat: 0.75, mortarMissions: 2,
  },
  catalog: [
    { key: 'repl', label: 'Replacements (8 men)', desc: 'Mobilised and contract soldiers from the brigade\'s replenishment company.', kind: 'replacements', men: 8, lp: 16, eta: 1 },
    { key: 'repl_large', label: 'Replacement draft (16 men)', desc: 'A full draft from the training ground behind the lines.', kind: 'replacements', men: 16, lp: 30, eta: 2, req: ['ru_log_mob'] },
    { key: 'mech_btr', label: 'MR Coy (BTR-82A)', desc: 'Eight-man squad with its wheeled carrier: 30 mm 2A72 and PKT.', kind: 'mech', vehicle: 'btr', men: 8, lp: 40, eta: 2, limit: 4 },
    { key: 'mech_ifv', label: 'MR Coy (BMP-2)', desc: 'Seven dismounts in a BMP-2: 30 mm cannon and Konkurs ATGM, light armour.', kind: 'imech', vehicle: 'ifv', men: 7, lp: 55, eta: 3, limit: 2 },
    { key: 'mech_ifv_plus', label: 'MR Coy (BMP-3)', desc: 'BMP-3s for a second mechanised company: 100 mm gun-launcher and 30 mm cannon.', kind: 'imech', vehicle: 'ifv', men: 7, lp: 65, eta: 3, req: ['ru_arm_bmp'], limit: 2 },
    { key: 'tank', label: 'T-72B3 tank', desc: 'Modernised T-72 with a three-man crew: 125 mm gun, Kontakt-5 ERA, thermal sight.', kind: 'tank', vehicle: 'tank', men: 3, lp: 75, eta: 3, limit: 2 },
    { key: 'tank_plus', label: 'T-72B3M tank (second platoon)', desc: 'Newer T-72B3M from the factory for a second tank platoon.', kind: 'tank', vehicle: 'tank', men: 3, lp: 85, eta: 4, req: ['ru_arm_tankpl'], limit: 2 },
    { key: 'assault', label: 'Assault Coy', desc: 'Six assaulters in heavy armour with grenades and an RPG for trench and building clearing.', kind: 'assault', men: 6, lp: 30, eta: 2, limit: 3 },
    { key: 'assault_plus', label: 'Assault Coy (2nd detachment)', desc: 'Additional assault squads from a second assault detachment.', kind: 'assault', men: 6, lp: 35, eta: 2, req: ['ru_inf_stormco'], limit: 2 },
    { key: 'atgm', label: 'Kornet ATGM team', desc: 'Three-man team with a 9M133 Kornet launcher and missiles.', kind: 'atgm', men: 3, lp: 25, eta: 1, limit: 3 },
    { key: 'atgm_truck', label: 'Kornet on a pickup', desc: 'The Kornet team on a pickup: launcher on the bed (fires over the tailgate, 34 deg arc), six missiles aboard, fast to a firing spot and away again. Unarmoured - if the truck is lost the team fights on foot.', kind: 'atgm', vehicle: 'atgmtruck', men: 3, lp: 40, eta: 2, limit: 2 },
    { key: 'fpv', label: 'Drone team', desc: 'Pilot and assistant with five FPV strike quadcopters.', kind: 'fpv', men: 2, lp: 18, eta: 1, limit: 1 },
    { key: 'fpv_plus', label: 'FPV team (UAV company)', desc: 'Additional FPV strike-drone crews (ten drones each) from the brigade\'s UAV company.', kind: 'fpv', men: 2, lp: 20, eta: 1, req: ['ru_dr_uav'], limit: 3 },
    { key: 'spg', label: '2S19M2 Msta-S', desc: 'Tracked 152 mm self-propelled howitzer with a five-man crew.', kind: 'spg', vehicle: 'spg', men: 5, lp: 95, eta: 3, req: ['ru_fire_msta'], limit: 1 },
  ],
  tech: TECH_RU,   // tech tree data: src/campaign/v2/tech.js (vehicle lines + upgrades, support branches)
  sources: [
    SRC.avdiivka, SRC.isw0126, SRC.isw0320, SRC.isw1010, SRC.isw1011, SRC.up1126, SRC.up1204, SRC.up0122, SRC.isw0217, SRC.meduza0219, SRC.emp0227,
    { title: 'OpenStreetMap contributors (ODbL) — grid terrain, settlements, roads, industrial sites', url: 'https://www.openstreetmap.org/copyright' },
    ...THEATRE2.sources,
  ],
};
