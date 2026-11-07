// Shared UI glyphs: APP-6 / NATO-style unit symbols and order icons.
// Used by the battle HUD and available to other screens (campaign v2, versus lobby):
//   import { unitSymbol, unitKindOf, ORDER_ICONS } from '../ui/symbols.js';
//   el.innerHTML = unitSymbol('ifv', 'friend');      // inline SVG, coloured by CSS `color`
// Frames follow APP-6: friend = rectangle, hostile = diamond, neutral = square, unknown = quatrefoil-ish circle.
// Glyphs use currentColor; the frame gets a translucent fill of the same colour (class .sym in style.css).

const BOX = { friend: [-21, -14, 42, 28], hostile: [-10.5, -10.5, 21, 21], neutral: [-15, -15, 30, 30], unknown: [-13, -13, 26, 26] };
const FRAME = {
  friend: '<rect class="fr" x="-21" y="-14" width="42" height="28"/>',
  hostile: '<path class="fr" d="M0 -21 L21 0 L0 21 L-21 0 Z"/>',
  neutral: '<rect class="fr" x="-16" y="-16" width="32" height="32"/>',
  unknown: '<circle class="fr" r="18"/>',
};
const X = (x, y, w, h) => `<path d="M${x} ${y}L${x + w} ${y + h}M${x + w} ${y}L${x} ${y + h}"/>`;
const ELL = (x, y, w, h, k = 1) => `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w * 0.34 * k}" ry="${h * 0.27 * k}"/>`;
// glyph builders take the inner box of the frame
const GLYPH = {
  squad: (x, y, w, h) => X(x, y, w, h),                                                                     // infantry
  assault: (x, y, w, h) => X(x, y, w, h) + `<path d="M${x + w * 0.5} ${y + h * 0.12}v${h * 0.2}"/>`,         // infantry + assault mark
  crew: (x, y, w, h) => `<path d="M${x + w * 0.28} ${y + h * 0.5}h${w * 0.44}" stroke-dasharray="3 2.5"/>`,  // dismounted crew
  btr: (x, y, w, h) => X(x, y, w, h) + `<path d="M${x + w / 2} ${y}v${h}"/>`,                                // motorized infantry
  ifv: (x, y, w, h) => X(x, y, w, h) + ELL(x, y, w, h),                                                      // mechanized infantry
  tank: (x, y, w, h) => ELL(x, y, w, h, 1.15),                                                               // armour
  atgm: (x, y, w, h) => `<path d="M${x + w * 0.22} ${y + h * 0.88}L${x + w / 2} ${y + h * 0.12}L${x + w * 0.78} ${y + h * 0.88}"/>`,   // anti-armour
  spg: (x, y, w, h) => `<circle class="fill" cx="${x + w / 2}" cy="${y + h * 0.36}" r="${Math.min(w, h) * 0.11}"/>` + `<rect x="${x + w * 0.24}" y="${y + h * 0.62}" width="${w * 0.52}" height="${h * 0.2}" rx="${h * 0.1}"/>`,   // SP artillery
  medevac: (x, y, w, h) => `<path d="M${x + w / 2} ${y + h * 0.16}v${h * 0.68}M${x + w * 0.3} ${y + h / 2}h${w * 0.4}" stroke-width="3.2"/>`,   // medical (casualty evacuation)
  contact: (x, y, w, h) => `<text x="${x + w / 2}" y="${y + h * 0.84}" text-anchor="middle" font-size="${h * 1.05}" font-weight="800" fill="currentColor" stroke="none" font-family="sans-serif">?</text>`,   // unconfirmed contact
  fpv: (x, y, w, h) => `<path d="M${x + w * 0.16} ${y + h * 0.38}Q${x + w * 0.33} ${y + h * 0.78} ${x + w / 2} ${y + h * 0.5}Q${x + w * 0.67} ${y + h * 0.78} ${x + w * 0.84} ${y + h * 0.38}"/>`,   // UAS
};

export function unitSymbol(kind, aff = 'friend', cls = '') {
  const [x, y, w, h] = BOX[aff] || BOX.friend, g = GLYPH[kind] || GLYPH.squad;
  return `<svg class="sym ${aff} ${cls}" viewBox="-23 -23 46 46" aria-hidden="true"><g>${FRAME[aff] || FRAME.friend}${g(x, y, w, h)}</g></svg>`;
}

// game unit -> glyph key
export function unitKindOf(u) {
  if (u.type === 'vehicle') return GLYPH[u.kind] ? u.kind : 'btr';
  if (u.crew) return 'crew';
  if (u.kind === 'atgm' || u.kind === 'fpv') return u.kind;
  return u.assault ? 'assault' : 'squad';
}
export const UNIT_TYPE_NAME = { squad: 'Rifle squad', assault: 'Assault squad', crew: 'Dismounted crew', btr: 'Wheeled APC', ifv: 'Infantry fighting vehicle', tank: 'Main battle tank', atgm: 'ATGM team', spg: 'Self-propelled howitzer', fpv: 'FPV drone team', medevac: 'Casualty evacuation · pickup' };

// 24×24 stroke icons for the order bar: square caps, mitred joins (style.css #orders .ico); .f = filled part.
// Fire support keys borrow APP-6 glyphs: mortar = the mortar symbol (tube arrow on its base ring), artillery = the
// field-artillery dot with the round's trajectory onto a target cross.
const I = d => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
export const ORDER_ICONS = {
  run: I('<path d="M4 6l6 6-6 6M12 6l6 6-6 6"/>'),
  holdfire: I('<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5.5 18.5l13-13"/>'),
  garrison: I('<path d="M4 20V10l8-6 8 6v10M2 20h20M9.5 20v-5.5h5V20"/><path d="M7.5 11.5h2M14.5 11.5h2"/>'),
  mount: I('<path d="M2.5 16h19l-1.5-4.5H8L6.5 9H2.5z"/><path d="M5.5 19h13"/><path d="M15 2.5v5.5M12.5 5.5L15 8l2.5-2.5"/>'),
  resupply: I('<path d="M3.5 11h17v9h-17zM3.5 14.5h17"/><path d="M7 11V6l1-2 1 2v5M11 11V6l1-2 1 2v5M15 11V6l1-2 1 2v5"/>'),
  halt: I('<path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z"/><path d="M8 12h8"/>'),
  smoke: I('<path d="M6.5 17a3.5 3.5 0 0 1 .4-7 5 5 0 0 1 9.5-1.2A3.8 3.8 0 0 1 17.5 17z"/><path d="M5 20.5h14"/>'),
  fireground: I('<path d="M2.5 20.5h19"/><path d="M12 5.5l5.5 5.5-5.5 5.5L6.5 11z"/><path d="M12 2v3.5M12 16.5V20M3 11h3.5M17.5 11H21"/>'),
  mortar: I('<circle cx="12" cy="17.5" r="3.5"/><path d="M12 14V3M8.5 6.5L12 3l3.5 3.5"/>'),
  artillery: I('<circle class="f" cx="5" cy="18.5" r="2.6"/><path d="M6.5 15.5C8.5 6 15 3.5 19 11" stroke-dasharray="2.2 1.8"/><path d="M16.5 15.5l5 5M21.5 15.5l-5 5"/>'),
};

// unit card art: src/ui/portraits.js (side-profile renders of the units' own models)
// short category / arm codes (deck tabs, unit card)
export const ARM_CODE = { 'MOTOR RIFLES': 'MOT', ASSAULT: 'ASLT', ARMOUR: 'ARM', SUPPORT: 'SUP', ARTILLERY: 'ART', MEDICAL: 'MED', CREWS: 'CRW' };
