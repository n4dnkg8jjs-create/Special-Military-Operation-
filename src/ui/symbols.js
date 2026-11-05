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

// 24×24 stroke icons for the order bar
const I = d => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
export const ORDER_ICONS = {
  run: I('<path d="M5 6l6 6-6 6M12 6l6 6-6 6"/>'),
  reverse: I('<rect x="10" y="7" width="10" height="10" rx="1.5"/><path d="M13 12h4"/><path d="M8 12H2.5M5.5 9l-3 3 3 3"/>'),
  holdfire: I('<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M5 19L19 5"/>'),
  garrison: I('<path d="M4 20V9l8-5 8 5v11"/><path d="M9.5 20v-5.5h5V20M2.5 20h19"/>'),
  mount: I('<path d="M3 15.5h18l-2-5H7.5L6 8H3z"/><circle cx="7" cy="18" r="1.6"/><circle cx="12" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/><path d="M14 3v5M11.5 5.5L14 8l2.5-2.5"/>'),
  resupply: I('<rect x="4" y="9" width="16" height="11"/><path d="M4 13h16M9 5.5h6M12 3v5"/>'),
  halt: I('<rect x="6" y="6" width="12" height="12"/>'),
  smoke: I('<path d="M6.5 17a3.5 3.5 0 0 1 .4-7 5 5 0 0 1 9.5-1.2A3.8 3.8 0 0 1 17.5 17z"/><path d="M8 20.5h8"/>'),
  fireground: I('<path d="M3 19h18"/><circle cx="12" cy="11" r="5"/><path d="M12 3.5v3M12 15.5v3M4.5 11h3M16.5 11h3"/>'),
  mortar: I('<path d="M3 19C6 7 15 4 20 12"/><path d="M17.5 13.5l2.6-1.4.1 3"/><path d="M3 21h6"/>'),
};
