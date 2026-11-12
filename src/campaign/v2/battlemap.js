// Which battle map a campaign square is fought on. Every square carries its sector's real-place map (`battleMap`: Avdiivka /
// Robotyne), but that ground is one spot of the sector: only the square(s) the real frame lies on are fought there. The rest:
//   a city / industrial square, a town                      -> the city map
//   a square with a river (Vovcha, Kinska, Tokmak, ...)     -> the river map
//   open ground or a village on the line held since 2022    -> the grey-zone map (the campaign's opening contact line: the
//                                                              no man's land both sides had shelled for a year and more)
//   a village / hamlet behind the lines                     -> the farmland map (fields and two villages)
//   open land: fields, balkas, heights, woods               -> the rural map (fields, tree belts, tracks, strongpoints)
// Pure rules (no three.js): state.js battleSetup and the sector map's battle frame (map3d.js) both ask here.
import { MAPS } from '../../world/maps.js';

// the real map's frame covers at least a quarter of itself on this square (cells are `cellKm` wide, latlon = their centre)
export function realGround(aor, c) {
  const M = MAPS[c?.battleMap]; if (!M?.geo || !Array.isArray(c.latlon)) return false;
  const size = (M.sizeM || 1400) / 1000, cw = aor?.cellKm || 2, km = 111.2;
  const dx = (M.geo.lon - c.latlon[1]) * km * Math.cos(c.latlon[0] * Math.PI / 180), dz = (M.geo.lat - c.latlon[0]) * km;
  const ov = d => Math.max(0, Math.min(d + size / 2, cw / 2) - Math.max(d - size / 2, -cw / 2));
  return ov(dx) * ov(dz) >= 0.25 * size * size;
}
// front: the square lies on the campaign's opening contact line
export function battleMapFor(aor, c, front = false) {
  if (!c) return 'farmland';
  if (realGround(aor, c)) return c.battleMap;
  const s = c.settlement?.kind;
  if (c.terrain === 'urban' || c.terrain === 'industrial' || s === 'town' || s === 'industrial') return 'city';
  if (c.river || c.terrain === 'water') return 'river';
  if (front) return 'greyzone';
  if (c.terrain === 'village' || s) return 'farmland';
  return 'rural';
}
