// Campaign v2 data contract — GRID strategic layer, a year into the invasion (Feb 2023) until early 2024.
// Replaces the sector-graph campaign (schema.js/state.js keep working until v2 lands; then they are retired).
//
// THEATRE (pan-able, mostly faded): the real front from the Dnipro to Kharkiv oblast drawn from real geography,
// with the front line as it moved month by month (historical, scripted). The player sees his country's progress
// there but controls only his brigade's area of responsibility (AOR), which is shown in full detail and in 3D.
// AOR: a real ~20–30 km area cut into square GRID CELLS (~1.5–2.5 km). Cells have terrain, settlements (with small
// 3D town/village models on the strategic map), roads, owner, fortifications, enemy strength.
// TURN = 1 week (Feb 2023 → ~Mar 2024, ~55 turns). Each turn: move task forces, attack, resupply, order from HQ.
//
// CampaignDef2 = {
//   id: 'UA'|'RU', version: 2, title, brigade: { name, short }, intro: { place: 'Robotyne sector', date: 'February 2023', lines: [...] },
//   start: { date: '2023-02-06', turnDays: 7, end: '2024-03-04', lp, hq: cellId, forces: [TaskForce...], units: [UnitRecord...], unlocked, available },
//   theatre: {
//     bbox: [latS, lonW, latN, lonE],                 // e.g. the whole southern + eastern front
//     fronts: [{ date: '2023-02', line: [[lat,lon]...] }, ...],   // historical front line by month (at least monthly)
//     occupied?: [{ date, poly: [[lat,lon]...] }],     // optional filled areas
//     labels: [{ latlon, text, kind: 'city'|'oblast'|'river' }], rivers: [{ pts: [[lat,lon]...] }], roads?: [...],
//     events: [{ date, text, latlon? }],               // country-level news shown as the campaign advances (real events)
//   },
//   aor: {
//     name, bbox: [latS, lonW, latN, lonE], cellKm, cols, rows,   // grid origin = NW corner (bbox latN, lonW), row 0 north
//     enemyEdge: 'north'|'south'|'east'|'west', supplySources: [cellId...],   // own rear depots / roads out of the AOR
//     cells: [{
//       id: 'c<col>_<row>', col, row, terrain: 'fields'|'forest'|'urban'|'industrial'|'village'|'water'|'heights'|'balka',
//       name?, settlement?: { name, kind: 'town'|'village'|'hamlet'|'industrial', latlon, size: 1..5 },   // 3D model on the map
//       road: 0|1|2,                                      // best road in the cell (move cost), 2 = paved highway
//       owner: 'player'|'enemy'|'contested', fort: 0..3, garrison: 0..3, vp, lp,
//       battleMap: 'robotyne'|'avdiivka'|'city'|'farmland',   // UA AOR -> 'robotyne', RU AOR -> 'avdiivka' (new maps)
//       objective?: 'A'|'B'|..., notes?, latlon: [lat, lon] (cell centre),
//     }],
//     osm?: 'assets/campaign/osm/<UA|RU>/',               // raw OSM extracts for the 3D map
//   },
//   directives: [{ id, date or issue: { date?, after?, result?, when? }, from, title, text, kind: 'capture'|'hold'|'destroy'|'recon'|'survive'|'raid',
//                  targets: [cellId...], count?, deadlineDate or deadline (turns), reward: { lp, unlock?, units? }, penalty?, next?, final?,
//                  history?: string /* what really happened, shown after completion */ , sources?: [{ title, url }] }],
//   enemy: { pressure: [{ date, p }], reinforce: [{ date, r }], forceTemplates: { 1: [EnemyUnit], 2: [...], 3: [...] }, artillery, fpvThreat, mortarMissions: n },
//   catalog: [...as schema.js], tech: [...as schema.js, plus optional `date` = earliest delivery date (e.g. Bradleys from 2023-03)],
//   sources: [{ title, url }],
// }
// TaskForce (persistent) = { id, name, cell: cellId, units: [uid...], mp: movement points left this turn, supply: 0..1, stance: 'attack'|'hold'|'rest' }
//   • split: units move into a new task force on the same cell; merge: task forces on the same cell combine
//   • movement per turn: MP by slowest unit (foot 2, wheeled 4, tracked 3); cell cost: road 2 → 1, road 1 → 1.5, open 2, forest/urban 3,
//     entering an enemy cell = attack (battle), contested/fortified cells cost more; rivers block except at bridges/dams
//   • logistics: a task force is IN SUPPLY if a chain of own cells connects it to a supply source (road cells count double range);
//     out of supply: no replacements/repairs, ammo (battle) and morale penalties, -readiness per turn; supply depots can be ordered
// UnitRecord / EnemyUnit as in schema.js.
export const V2 = true;
