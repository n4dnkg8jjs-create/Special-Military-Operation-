// Test campaigns that follow the v2 data contract (schema2.js). Used by the engine/screen until (or when) the real
// content (content_ua.js / content_ru.js via v2/index.js) is not available, and by the node rule checks.
// Real place coordinates; front lines are coarse approximations (the content files carry the researched ones).
import { CAMPAIGN_UA } from '../content_ua.js';
import { CAMPAIGN_RU } from '../content_ru.js';

function rng(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const KYd = 110.57, KXd = lat => 111.32 * Math.cos(lat * Math.PI / 180);

// distance (km) from point to polyline of [lat,lon]
function distLine(lat, lon, line) {
  const kx = KXd(lat); let best = 1e9;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][1] - lon) * kx, ay = (line[i][0] - lat) * KYd, bx = (line[i + 1][1] - lon) * kx, by = (line[i + 1][0] - lat) * KYd;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-9, t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L));
    best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t));
  }
  return best;
}

function buildGrid({ bbox, cellKm, places, roads2, roads1, rivers = [], ownerFn, fortFn, garrisonFn, seed, battleMap, forestP = 0.08, heights = [], balkas = [] }) {
  const [latS, lonW, latN, lonE] = bbox, latM = (latS + latN) / 2;
  const dLat = cellKm / KYd, dLon = cellKm / KXd(latM);
  const cols = Math.round((lonE - lonW) / dLon), rows = Math.round((latN - latS) / dLat);
  const R = rng(seed), cells = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const lat = latN - (row + 0.5) * dLat, lon = lonW + (col + 0.5) * dLon;
    const c = { id: `c${col}_${row}`, col, row, latlon: [+lat.toFixed(5), +lon.toFixed(5)], terrain: 'fields', road: 0, fort: 0, garrison: 0, vp: 0, lp: 0, battleMap };
    const inCell = places.filter(p => Math.abs(p.ll[0] - lat) <= dLat / 2 && Math.abs(p.ll[1] - lon) <= dLon / 2).sort((a, b) => b.size - a.size);
    if (inCell.length) {
      const p = inCell[0];
      c.settlement = { name: p.name, kind: p.kind, latlon: p.ll, size: p.size };
      c.name = p.name; c.terrain = p.kind === 'town' ? 'urban' : p.kind === 'industrial' ? 'industrial' : 'village';
      c.vp = p.size >= 4 ? 3 : p.size >= 2 ? 2 : 1; c.lp = p.size >= 4 ? 3 : 1;
    } else if (heights.some(h => Math.hypot((h[0] - lat) * KYd, (h[1] - lon) * KXd(lat)) < cellKm * 1.1)) { c.terrain = 'heights'; c.vp = 1; }
    else if (balkas.some(b => distLine(lat, lon, b) < cellKm * 0.5)) c.terrain = 'balka';
    else if (R() < forestP) c.terrain = 'forest';
    if (roads2.some(r => distLine(lat, lon, r) < cellKm * 0.55)) c.road = 2; else if (roads1.some(r => distLine(lat, lon, r) < cellKm * 0.55)) c.road = 1;
    if (rivers.some(r => distLine(lat, lon, r.pts) < cellKm * 0.45)) { c.river = true; c.bridge = c.road > 0; }
    if (c.road === 2) c.lp += 1;
    c.owner = ownerFn(lat, lon);
    c.fort = fortFn(lat, lon, c);
    if (c.owner === 'enemy') c.garrison = garrisonFn(lat, lon, c, R);
    cells.push(c);
  }
  return { bbox, cellKm, cols, rows, cells };
}
const cellOf = (g, ll) => { const [latS, lonW, latN, lonE] = g.bbox; const col = Math.floor((ll[1] - lonW) / (lonE - lonW) * g.cols), row = Math.floor((latN - ll[0]) / (latN - latS) * g.rows); return `c${Math.max(0, Math.min(g.cols - 1, col))}_${Math.max(0, Math.min(g.rows - 1, row))}`; };

// ---------------------------------------------------------------------------------------------- theatre (shared)
const DNIPRO = [[46.49, 32.0], [46.62, 32.55], [46.70, 32.90], [46.76, 33.37], [47.05, 33.75], [47.42, 34.20], [47.52, 34.55], [47.45, 35.00], [47.62, 35.10], [47.85, 35.12], [48.10, 35.13], [48.45, 35.05], [48.60, 34.70], [48.95, 34.25]];
const DONETS = [[49.95, 36.90], [49.55, 37.20], [49.17, 37.32], [48.97, 37.80], [48.90, 38.30], [48.85, 38.60], [48.75, 39.00], [48.62, 39.40], [48.45, 39.80]];
const OSKIL = [[50.40, 37.90], [49.95, 37.72], [49.70, 37.62], [49.40, 37.60], [49.17, 37.32]];
const VOVCHA = [[47.95, 36.80], [48.10, 36.40], [48.30, 35.90], [48.45, 35.40]];
function frontFeb23() { return [[46.55, 32.3], [46.66, 32.7], [46.76, 33.37], [47.05, 33.75], [47.42, 34.25], [47.50, 35.30], [47.53, 35.50], [47.50, 35.75], [47.49, 35.90], [47.50, 36.10], [47.60, 36.40], [47.80, 36.75], [47.84, 36.95], [47.78, 37.25], [47.92, 37.45], [48.05, 37.55], [48.10, 37.70], [48.17, 37.78], [48.30, 37.85], [48.55, 37.95], [48.62, 38.05], [48.75, 38.15], [48.95, 38.18], [49.05, 38.17], [49.30, 38.05], [49.55, 37.90], [49.75, 37.95], [50.05, 38.05], [50.25, 38.2]]; }
function bend(line, at, dLat, dLon, r = 0.35) { return line.map(([la, lo]) => { const d = Math.hypot(la - at[0], (lo - at[1]) * 0.67); const k = Math.max(0, 1 - d / r); return [+(la + dLat * k).toFixed(4), +(lo + dLon * k).toFixed(4)]; }); }
function theatre() {
  const f0 = frontFeb23();
  const fBakh = bend(f0, [48.59, 38.0], 0, -0.06, 0.2);              // Bakhmut falls (May 2023)
  const fRob = bend(fBakh, [47.48, 35.83], -0.06, 0, 0.18);          // Robotyne salient (Aug 2023)
  const fRob2 = bend(bend(fRob, [47.73, 36.78], -0.08, 0, 0.12), [47.50, 35.92], -0.02, 0, 0.08);
  const fAvd = bend(fRob2, [48.14, 37.75], 0.0, -0.06, 0.12);        // Avdiivka falls (Feb 2024)
  return {
    bbox: [46.3, 32.0, 50.4, 39.6],
    fronts: [{ date: '2023-02', line: f0 }, { date: '2023-05', line: fBakh }, { date: '2023-06', line: bend(fBakh, [47.48, 35.83], -0.015, 0, 0.18) }, { date: '2023-08', line: fRob }, { date: '2023-10', line: fRob2 }, { date: '2024-01', line: bend(fRob2, [48.14, 37.75], 0.0, -0.025, 0.12) }, { date: '2024-02', line: fAvd }],
    labels: [
      { latlon: [47.84, 35.14], text: 'Zaporizhzhia', kind: 'city' }, { latlon: [46.85, 35.37], text: 'Melitopol', kind: 'city' }, { latlon: [48.0, 37.8], text: 'Donetsk', kind: 'city' },
      { latlon: [49.99, 36.23], text: 'Kharkiv', kind: 'city' }, { latlon: [48.46, 35.05], text: 'Dnipro', kind: 'city' }, { latlon: [46.64, 32.61], text: 'Kherson', kind: 'city' },
      { latlon: [47.10, 37.55], text: 'Mariupol', kind: 'city' }, { latlon: [48.59, 38.0], text: 'Bakhmut', kind: 'city' }, { latlon: [48.72, 37.56], text: 'Kramatorsk', kind: 'city' },
      { latlon: [48.57, 39.31], text: 'Luhansk', kind: 'city' }, { latlon: [49.71, 37.61], text: 'Kupiansk', kind: 'city' }, { latlon: [47.25, 35.71], text: 'Tokmak', kind: 'city' }, { latlon: [47.12, 34.75], text: 'Enerhodar', kind: 'city' },
      { latlon: [47.45, 35.6], text: 'ZAPORIZHZHIA OBLAST', kind: 'oblast' }, { latlon: [48.2, 37.3], text: 'DONETSK OBLAST', kind: 'oblast' }, { latlon: [49.2, 38.9], text: 'LUHANSK OBLAST', kind: 'oblast' },
      { latlon: [49.6, 36.4], text: 'KHARKIV OBLAST', kind: 'oblast' }, { latlon: [48.4, 34.3], text: 'DNIPROPETROVSK OBLAST', kind: 'oblast' }, { latlon: [46.8, 33.0], text: 'KHERSON OBLAST', kind: 'oblast' },
      { latlon: [47.30, 34.35], text: 'Dnipro (Kakhovka res.)', kind: 'river' }, { latlon: [49.0, 37.9], text: 'Siverskyi Donets', kind: 'river' },
    ],
    rivers: [{ pts: DNIPRO, w: 3 }, { pts: DONETS }, { pts: OSKIL }, { pts: VOVCHA }],
    events: [
      { date: '2023-02-24', text: 'One year since the full-scale invasion.' }, { date: '2023-05-20', text: 'Bakhmut: Russian forces claim the city after ten months of fighting.', latlon: [48.59, 38.0] },
      { date: '2023-06-06', text: 'Kakhovka dam destroyed; the lower Dnipro floods.', latlon: [46.78, 33.37] }, { date: '2023-06-08', text: 'Ukrainian counteroffensive begins on the Orikhiv and Velyka Novosilka axes.', latlon: [47.5, 35.9] },
      { date: '2023-08-28', text: 'Ukraine reports Robotyne liberated.', latlon: [47.443, 35.826] }, { date: '2023-10-10', text: 'Russian offensive on Avdiivka begins.', latlon: [48.13, 37.75] },
      { date: '2023-11-01', text: 'Front largely static; both sides dig in for the winter.' }, { date: '2024-02-17', text: 'Ukrainian forces withdraw from Avdiivka.', latlon: [48.13, 37.75] },
    ],
  };
}

// ---------------------------------------------------------------------------------------------- UA: Robotyne sector
function campaignUA() {
  const P = (name, lat, lon, kind, size) => ({ name, ll: [lat, lon], kind, size });
  const places = [P('Orikhiv', 47.5754, 35.7855, 'town', 4), P('Mala Tokmachka', 47.5327, 35.8968, 'village', 3), P('Robotyne', 47.4431, 35.8261, 'village', 2), P('Novoprokopivka', 47.4201, 35.8319, 'village', 2),
    P('Verbove', 47.428, 35.9905, 'village', 2), P('Kopani', 47.4647, 35.7341, 'hamlet', 1), P('Solodka Balka', 47.3868, 35.7887, 'village', 1), P('Nesterianka', 47.4953, 35.6798, 'village', 1),
    P('Novodanylivka', 47.5197, 35.8249, 'village', 2), P('Ocheretuvate', 47.3367, 35.9479, 'village', 2), P('Novopokrovka', 47.5045, 35.9878, 'village', 1), P('Nove', 47.3476, 35.7952, 'village', 2),
    P('Preobrazhenka', 47.5831, 35.7928, 'village', 1), P('Rivne', 47.4335, 35.7241, 'hamlet', 1), P('Myrne', 47.3494, 35.7111, 'village', 1), P('Novoselivka', 47.6171, 35.996, 'village', 1),
    P('Orikhiv industrial zone', 47.5655, 35.8095, 'industrial', 2)];
  const T0408 = [[47.60, 35.775], [47.5754, 35.7855], [47.52, 35.825], [47.4431, 35.8261], [47.4201, 35.8319], [47.3868, 35.7887], [47.33, 35.74]];
  const R1 = [[47.5327, 35.8968], [47.5045, 35.9878], [47.428, 35.9905]], R2 = [[47.5754, 35.7855], [47.5327, 35.8968]], R3 = [[47.4953, 35.6798], [47.4647, 35.7341], [47.4431, 35.8261]], R4 = [[47.3476, 35.7952], [47.3367, 35.9479]];
  const front = lon => 47.492 + (lon - 35.70) * 0.03;
  const aor = buildGrid({ bbox: [47.33, 35.70, 47.60, 36.00], cellKm: 2, places, roads2: [T0408], roads1: [R1, R2, R3, R4], seed: 11, battleMap: 'robotyne',
    rivers: [{ pts: [[47.60, 35.70], [47.575, 35.78], [47.585, 35.86], [47.60, 35.95]] }], heights: [[47.44, 35.95]], balkas: [[[47.40, 35.70], [47.37, 35.85], [47.39, 36.0]]],
    ownerFn: (lat, lon) => (lat > front(lon) ? 'player' : 'enemy'),
    fortFn: (lat, lon, c) => (lat < front(lon) ? (Math.abs(lat - 47.44) < 0.022 ? 3 : lat > front(lon) - 0.03 ? 2 : 1) : 0),
    garrisonFn: (lat, lon, c, R) => Math.min(3, (lat > front(lon) - 0.04 ? 2 : 1) + (c.settlement && c.settlement.size >= 2 ? 1 : 0) + (R() < 0.2 ? 1 : 0) - (lat < 47.40 ? 1 : 0)) || 1 });
  const id = ll => cellOf(aor, ll);
  const hq = id([47.5754, 35.7855]);
  const supplySources = aor.cells.filter(c => c.row === 0 && (c.road || c.col % 4 === 1)).map(c => c.id);
  const unit = (uid, key, name, kind, men, veh, xp = 0) => ({ uid, key, name, kind, men, menMax: men, veh: veh ? { kind: veh, hp: 1 } : null, xp });
  const def = {
    id: 'UA', version: 2, title: 'Orikhiv axis — Robotyne', test: true, region: 'Zaporizhzhia oblast',
    brigade: { name: '47th Separate Mechanized Brigade "Magura"', short: '47 OMBr' },
    intro: { place: 'Robotyne sector', date: 'February 2023', lines: ['One year into the full-scale invasion. The front south of Orikhiv has not moved since the spring of 2022.', 'Behind Robotyne the enemy is digging: minefields, anti-tank ditches, dragon’s teeth. Three lines deep to Tokmak.', 'Your brigade is forming with Western armour. Hold the line, train, and get ready to break it.'] },
    start: { date: '2023-02-06', turnDays: 7, end: '2024-03-04', lp: 60, lpBase: 6, hq, unlocked: [...CAMPAIGN_UA.start.unlocked], available: [...CAMPAIGN_UA.start.available],
      units: [unit('ua_u1', 'mech_ifv', '1st Mech. Squad (Bradley)', 'imech', 6, 'ifv', 1), unit('ua_u2', 'mech_ifv', '2nd Mech. Squad (Bradley)', 'imech', 6, 'ifv', 0), unit('ua_u3', 'mech_btr', '3rd Mech. Squad (BTR-80)', 'mech', 8, 'btr', 1),
        unit('ua_u4', 'assault', 'Assault Squad', 'assault', 6, null, 1), unit('ua_u5', 'tank', 'Tank 1-1', 'tank', 3, 'tank', 1), unit('ua_u6', 'tank', 'Tank 1-2', 'tank', 3, 'tank', 0),
        unit('ua_u7', 'atgm', 'Stugna-P team', 'atgm', 3, null, 1), unit('ua_u8', 'fpv', 'FPV team', 'fpv', 2, null, 0)],
      forces: [{ id: 'tf1', name: 'TF Magura-1', cell: id([47.5197, 35.8249]), units: ['ua_u1', 'ua_u2', 'ua_u5', 'ua_u4'] }, { id: 'tf2', name: 'TF Magura-2', cell: id([47.5327, 35.8968]), units: ['ua_u3', 'ua_u6', 'ua_u7', 'ua_u8'] }] },
    theatre: theatre(),
    aor: { name: 'Robotyne sector', ...aor, enemyEdge: 'south', supplySources, osm: 'assets/campaign/osm/UA/' },
    directives: [
      { id: 'd1', issue: { date: '2023-02-06' }, from: 'OSGT "Tavria"', title: 'Hold the line south of Orikhiv', kind: 'survive', targets: [hq, id([47.5197, 35.8249]), id([47.5327, 35.8968])], deadlineDate: '2023-04-03', reward: { lp: 40 }, penalty: { lp: 15 },
        text: 'Hold the current line Nesterianka – Novodanylivka – Mala Tokmachka while the brigade forms. Do not provoke a general engagement. Reconnoitre, mine, rotate.', history: 'Through the spring of 2023 the Orikhiv front was largely static while new brigades trained abroad and received Western vehicles.', next: { success: 'd2', failure: 'd2' } },
      { id: 'd2', issue: { date: '2023-06-05' }, from: 'OSGT "Tavria"', title: 'Combat Order No. 1 — Break the first positions', kind: 'capture', targets: [id([47.47, 35.83])], deadlineDate: '2023-07-10', reward: { lp: 50 }, penalty: { lp: 15 },
        text: 'Break through the first enemy positions north of Robotyne and open a route for the armour. Mine threat extreme.', history: 'On 8 June 2023 the 47th Brigade attacked south of Mala Tokmachka; the Bradley and Leopard columns ran into dense minefields and suffered heavy losses.', next: { success: 'd3', failure: 'd3' } },
      { id: 'd2r', issue: { date: '2023-05-01' }, from: 'Corps HQ — Intelligence', title: 'Reconnaissance of Robotyne', kind: 'recon', targets: [id([47.4431, 35.8261])], deadlineDate: '2023-06-12', reward: { lp: 25 },
        text: 'Establish the enemy’s strength and fortifications in Robotyne. Approach under drone overwatch.', history: 'Ukrainian reconnaissance mapped a defence in depth: minefields, the first line in front of Robotyne and the main "Surovikin line" behind it.' },
      { id: 'd3', issue: {}, from: 'OSGT "Tavria"', title: 'Combat Order No. 2 — Robotyne', kind: 'capture', targets: [id([47.4431, 35.8261])], deadlineDate: '2023-09-04', reward: { lp: 80, units: [unit('ua_rw1', 'mech_ifv', '4th Mech. Squad (Bradley)', 'imech', 6, 'ifv', 0)] }, penalty: { lp: 20 },
        text: 'Seize Robotyne and clear it to its southern edge.', history: 'Ukrainian forces raised the flag in Robotyne on 28 August 2023 after weeks of small-group assaults.', next: { success: 'd4', failure: 'd5' } },
      { id: 'd3k', issue: { after: 'd2' }, from: 'Corps HQ — Fires', title: 'Attrit the enemy reserves', kind: 'destroy', targets: [], count: 5, deadline: 10, reward: { lp: 40 }, text: 'Destroy enemy armoured vehicles wherever found.' },
      { id: 'd4', issue: {}, from: 'OSGT "Tavria"', title: 'Breach the belt west of Verbove', kind: 'capture', targets: [id([47.44, 35.95])], deadlineDate: '2023-10-30', reward: { lp: 70 }, penalty: { lp: 20 },
        text: 'Breach the main defensive belt on the heights west of Verbove.', history: 'In September 2023 Ukrainian troops reached the anti-tank ditch near Verbove but could not widen the breach.', next: { success: 'd5', failure: 'd5' } },
      { id: 'd5', issue: { date: '2023-11-06' }, from: 'OSGT "Tavria"', title: 'Go over to the defence', kind: 'hold', targets: [id([47.4431, 35.8261])], final: true, deadlineDate: '2024-03-04', reward: { lp: 60 }, penalty: { lp: 20 },
        text: 'The offensive has culminated. Hold the Robotyne salient through the winter against counterattacks.', history: 'From November 2023 Ukraine went over to the defence along the whole front; Robotyne remained a grey zone under constant attack.' },
      { id: 'dlost', issue: { when: `lost:${id([47.5197, 35.8249])}` }, from: 'Corps HQ', title: 'Restore the line at Novodanylivka', kind: 'capture', targets: [id([47.5197, 35.8249])], deadline: 3, reward: { lp: 25 }, penalty: { lp: 20 }, text: 'Counterattack immediately before the enemy consolidates.' },
    ],
    enemy: { pressure: [{ date: '2023-02', p: 0.08 }, { date: '2023-06', p: 0.12 }, { date: '2023-08', p: 0.22 }, { date: '2023-11', p: 0.18 }, { date: '2024-01', p: 0.25 }],
      reinforce: [{ date: '2023-02', r: 0.08 }, { date: '2023-06', r: 0.12 }, { date: '2023-09', r: 0.1 }, { date: '2024-01', r: 0.08 }],
      forceTemplates: CAMPAIGN_UA.enemy.forceTemplates, artillery: 0.8, fpvThreat: 0.45, mortarMissions: 2 },
    catalog: CAMPAIGN_UA.catalog, tech: CAMPAIGN_UA.tech.map(t => (t.id === 'ua_arm_bradley2' ? { ...t, date: '2023-05-01' } : t)),
    sources: [{ title: 'OpenStreetMap', url: 'https://www.openstreetmap.org' }],
  };
  return def;
}

// ---------------------------------------------------------------------------------------------- RU: Avdiivka sector
function campaignRU() {
  const P = (name, lat, lon, kind, size) => ({ name, ll: [lat, lon], kind, size });
  const places = [P('Avdiivka', 48.1339, 37.7467, 'town', 5), P('Avdiivka Coke Plant', 48.172, 37.70, 'industrial', 4), P('Yasynuvata', 48.1271, 37.859, 'town', 4), P('Krasnohorivka', 48.2067, 37.7245, 'village', 2),
    P('Stepove', 48.1959, 37.679, 'village', 1), P('Berdychi', 48.1956, 37.6463, 'village', 1), P('Opytne', 48.0966, 37.7193, 'village', 1), P('Vodiane', 48.0961, 37.6661, 'village', 1),
    P('Lastochkyne', 48.1484, 37.6817, 'village', 2), P('Tonenke', 48.1397, 37.6413, 'village', 1), P('Orlivka', 48.1633, 37.6499, 'village', 1), P('Spartak', 48.0805, 37.7688, 'village', 1),
    P('Vesele', 48.0635, 37.7278, 'hamlet', 1), P('Kamianka', 48.1732, 37.7856, 'village', 1), P('Novobakhmutivka', 48.2492, 37.7892, 'village', 1), P('Keramik', 48.2531, 37.6827, 'village', 2),
    P('Yakovlivka', 48.0885, 37.8245, 'village', 1), P('Vasylivka', 48.1757, 37.857, 'village', 1), P('Avdiivka industrial zone', 48.115, 37.79, 'industrial', 3), P('Donetsk Airport', 48.071, 37.74, 'industrial', 2)];
  const H20 = [[48.07, 37.90], [48.1271, 37.859], [48.13, 37.80], [48.1339, 37.7467], [48.16, 37.70], [48.20, 37.64], [48.24, 37.60]];
  const R1 = [[48.06, 37.80], [48.115, 37.79], [48.1339, 37.7467]], R2 = [[48.1339, 37.7467], [48.1484, 37.6817], [48.1397, 37.6413]], R3 = [[48.1339, 37.7467], [48.2067, 37.7245], [48.2531, 37.6827]];
  const ua = (lat, lon) => (lon < 37.80 && lat > 48.098 && !(lat < 48.105 && lon > 37.76)) || (lat > 48.21 && lon < 37.82);
  const aor = buildGrid({ bbox: [48.06, 37.60, 48.26, 37.90], cellKm: 2, places, roads2: [H20], roads1: [R1, R2, R3], seed: 7, battleMap: 'avdiivka', forestP: 0.06,
    rivers: [{ pts: [[48.26, 37.70], [48.20, 37.66], [48.14, 37.60]] }], heights: [[48.19, 37.71]],
    ownerFn: (lat, lon) => (ua(lat, lon) ? 'enemy' : 'player'),
    fortFn: (lat, lon, c) => (ua(lat, lon) ? (c.settlement ? 3 : 2) : 0),
    garrisonFn: (lat, lon, c, R) => Math.min(3, 1 + (c.settlement ? 1 : 0) + (R() < 0.3 ? 1 : 0)) });
  const id = ll => cellOf(aor, ll);
  const hq = id([48.1271, 37.859]);
  const supplySources = aor.cells.filter(c => (c.col === aor.cols - 1 && c.row % 2 === 0) || (c.row === aor.rows - 1 && c.col % 3 === 2)).filter(c => c.owner === 'player').map(c => c.id);
  const unit = (uid, key, name, kind, men, veh, xp = 0) => ({ uid, key, name, kind, men, menMax: men, veh: veh ? { kind: veh, hp: 1 } : null, xp });
  const cat = CAMPAIGN_RU.catalog, k = kind => (cat.find(c => c.kind === kind) || {}).key || kind;
  return {
    id: 'RU', version: 2, title: 'Avdiivka direction', test: true, region: 'Donetsk oblast',
    brigade: { name: '1st Separate Motor Rifle Brigade', short: '1 OMSBr' },
    intro: { place: 'Avdiivka sector', date: 'February 2023', lines: ['Avdiivka: a fortified town on the edge of Donetsk, held by the enemy since 2014.', 'Coke plant, industrial zone, nine-storey blocks — every one of them a fortress.', 'Your brigade is to close the ring.'] },
    start: { date: '2023-02-06', turnDays: 7, end: '2024-03-04', lp: 60, lpBase: 6, hq, unlocked: [...CAMPAIGN_RU.start.unlocked], available: [...CAMPAIGN_RU.start.available],
      units: [unit('ru_u1', k('mech'), '1st MR Squad (BTR-82A)', 'mech', 8, 'btr', 1), unit('ru_u2', k('mech'), '2nd MR Squad (BTR-82A)', 'mech', 8, 'btr', 0), unit('ru_u3', k('imech') , '3rd MR Squad (BMP)', 'imech', 7, 'ifv', 0),
        unit('ru_u4', k('assault'), 'Storm Squad', 'assault', 6, null, 1), unit('ru_u5', k('tank'), 'Tank 1', 'tank', 3, 'tank', 1), unit('ru_u6', k('tank'), 'Tank 2', 'tank', 3, 'tank', 0), unit('ru_u7', k('atgm'), 'ATGM team', 'atgm', 3, null, 0), unit('ru_u8', k('fpv'), 'FPV team', 'fpv', 2, null, 0)],
      forces: [{ id: 'tf1', name: 'Group North', cell: id([48.1757, 37.857]), units: ['ru_u1', 'ru_u5', 'ru_u4', 'ru_u7'] }, { id: 'tf2', name: 'Group South', cell: id([48.0885, 37.8245]), units: ['ru_u2', 'ru_u3', 'ru_u6', 'ru_u8'] }] },
    theatre: theatre(),
    aor: { name: 'Avdiivka sector', ...aor, enemyEdge: 'west', supplySources, osm: 'assets/campaign/osm/RU/' },
    directives: [
      { id: 'r1', issue: { date: '2023-02-06' }, from: 'Group of Forces "Centre"', title: 'Press the flanks of Avdiivka', kind: 'raid', targets: [id([48.1732, 37.7856])], count: 1, deadlineDate: '2023-04-03', reward: { lp: 35 }, text: 'Probe the enemy positions at Kamianka and the industrial zone.', history: 'Through 2023 Russian forces kept up pressure on the Avdiivka salient before the large offensive in October.', next: { success: 'r2', failure: 'r2' } },
      { id: 'r2', issue: { date: '2023-10-09' }, from: 'Group of Forces "Centre"', title: 'Encircle Avdiivka from the north', kind: 'capture', targets: [id([48.172, 37.70])], deadlineDate: '2024-01-08', reward: { lp: 80 }, penalty: { lp: 20 }, text: 'Advance from Krasnohorivka towards the coke plant to cut the town’s supply.', history: 'The October 2023 offensive took the slag heap north of the coke plant at very heavy cost.', next: { success: 'r3', failure: 'r3' } },
      { id: 'r3', issue: { date: '2024-01-15' }, from: 'Group of Forces "Centre"', title: 'Take Avdiivka', kind: 'capture', final: true, targets: [id([48.1339, 37.7467])], deadlineDate: '2024-03-04', reward: { lp: 120 }, penalty: { lp: 20 }, text: 'Storm the town.', history: 'Ukrainian forces withdrew from Avdiivka on 17 February 2024.' },
    ],
    enemy: { pressure: [{ date: '2023-02', p: 0.1 }, { date: '2023-10', p: 0.15 }, { date: '2024-01', p: 0.1 }], reinforce: [{ date: '2023-02', r: 0.1 }, { date: '2023-10', r: 0.14 }, { date: '2024-01', r: 0.06 }],
      forceTemplates: CAMPAIGN_RU.enemy.forceTemplates, artillery: 0.7, fpvThreat: 0.6, mortarMissions: 2 },
    catalog: CAMPAIGN_RU.catalog, tech: CAMPAIGN_RU.tech,
    sources: [{ title: 'OpenStreetMap', url: 'https://www.openstreetmap.org' }],
  };
}

export const TEST_CAMPAIGNS = { UA: campaignUA(), RU: campaignRU() };
