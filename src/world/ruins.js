// Ruins of the real-place maps (real.js: Avdiivka, Robotyne): destruction and debris laid out to match the photo / drone
// record of those battles, from the map's `ruin` profile (maps.js).  Sources and decisions: previews/realcity_destruction/
// PROGRESS.md.  In short:
//  - Avdiivka, Jan-Feb 2024 (the Khimik / south-east microdistrict): dozens of glide bombs a day (FAB-500/1500 + UMPK)
//    on top of months of artillery.  Panel blocks: a bomb through the roof takes a V-shaped slice out of a block, several
//    storeys deep, slabs left hanging on their bars at the rim, a multi-storey heap at the foot; blasts strip the outer
//    panels off a facade and leave the rooms open floor by floor; top storeys burnt out with the roof gone; whole rows of
//    flats burnt out (soot plumes over the windows, black rooms), no pane of glass left.  The private sector: roofless
//    burnt shells, roofs broken open, houses flattened to wall stubs on a heap of brick and slate.  Trees reduced to
//    splintered trunks and stumps.  Streets cratered and littered with slabs, frames, glass, branches, wire; burnt cars in
//    the courtyards, knocked-out armour on the approaches; poles snapped and down with their wires.
//  - Robotyne, summer 2023: a village of single-storey houses -- "not a single house left": roofless, shell-holed,
//    flattened; tree belts and gardens shredded; the fields of the northern approach cratered; burnt tractors in the
//    yards, Bradleys / BTRs knocked out on the approach.
// Everything here is deterministic per map from its own RNG streams (seedOf(map id + stream name)): it never draws from
// the shared world RNG, and no decision depends on the quality setting (multiplayer peers build identical maps and nav).
// Gameplay: big heaps (collapse piles, flattened houses) are infantry-passable at a cost and give low cover; heaps over
// ~1.2 m stop wheeled vehicles, over ~2.2 m every vehicle; wall stubs are slow cover.  The ground / first floors of the
// blocks (garrison windows, the nav footprint) are left as they were, except the full-height pancaked sections.
// Rendering: block damage is all panel-kit pieces (one BatchedMesh per cell / material: no new draw calls), heaps are
// kit piles or the scanned rubble (their instancing / far mound LOD), debris goes into battlefieldDetail's merged
// per-cell buffers (w.bfExtra: no new draw calls), craters are decals in the one crater InstancedMesh.
import * as THREE from 'three';
import { MAP, MAP_SIZE, onRoad, mulberry } from './city.js';
import { BLOCK } from './nav.js';
import { trs } from './instancer.js';
import { houseRuin, roofFrame } from './wear.js';
import { PC, DG, lm, col, mcol, hash2, seedOf, shatteredTpl } from './battlefieldDetail.js';
import { ROAD_Y } from './roadmesh.js';

const TAU = Math.PI * 2;
const pick = (r, a) => a[Math.floor(r() * a.length)];
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// smooth value noise over the map (patches of heavier / lighter destruction: a street that took a salvo, a quieter one)
function vnoise(x, z, s, k) { const i = Math.floor(x / s), j = Math.floor(z / s), fx = x / s - i, fz = z / s - j, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz), h = (a, b) => hash2(a, b, k); return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v; }

// ================================================================ setup: hooks into the real-place builders
export function ruinsSetup(w) {
  const P = MAP.ruin; if (!P || ruinsOff()) return;
  const rs = tag => mulberry(seedOf((MAP.id || 'map') + ':ruins:' + tag + ':' + (MAP.seed ?? '')));
  const S = w.ruin = { P, rs, R: { block: rs('block'), house: rs('house'), debris: rs('debris'), crater: rs('crater'), pole: rs('pole'), car: rs('car'), tree: rs('tree') },
    heaps: [], houses: [], stumps: [], blocks: [], stats: { fab: 0, roof: 0, shear: 0, burn: 0, pancake: 0, piles: 0, houses: {}, trees: {}, poles: 0, cars: 0, wrecks: 0, craters: 0, debris: 0 } };
  // world streams that used to share the world RNG on these maps (their draw counts change with the damage)
  w.decalRng = rs('decals'); w.rubbleRng = rs('rubble');
  w.ruinPlan = b => planBlock(w, b);
  w.ruinHouse = (x, z) => houseFate(w, x, z);
  w.ruinTree = (n, x, z, s) => treeFate(w, n, x, z, s);
  w.ruinPoles = (mats, lines, att, pole) => ruinPoles(w, mats, lines, att, pole);
  w.ruinWrecks = (WT, add) => ruinWrecks(w, WT, add);
  w.ruinRubble = add => ruinRubble(w, add);
  w.ruinCraters = () => ruinCraters(w);
  (w.bfExtra ||= []).push(api => ruinDebris(w, api));
  if (typeof window !== 'undefined') window.__ruins = S.stats;
  return S;
}
function ruinsOff() { try { const q = new URLSearchParams(location.search).get('ruins'); return q != null ? q === '0' : localStorage.getItem('smo_ruins') === '0'; } catch { return false; } }

// ================================================================ panel blocks
// a plan per kit building (applied by City.placeBuildings right after predamage / pancake: Building.ruin), plus the
// kit pieces that go with it (collapse piles at the foot, hanging / fallen slabs, furniture on the exposed floors)
function planBlock(w, b) {
  const S = w.ruin, B = S.P.blocks || {}, R = S.R.block, kit = w.assets.kit, W = kit.W, H = kit.H, F = b.floors, M = b.modules;
  const d = b.osm?.dmg ?? (0.35 + R() * 0.6), seed = Math.floor(R() * 1e9) + 1, plan = { seed, glass: B.glass ?? 0.9, burn: [], fab: [], roof: [], shear: [] };
  const school = b.kind === 'school', k = Math.max(0, Math.min(1.4, (B.scale ?? 1) * (0.45 + d)));
  const secs = b.secCols || [[0, M - 1]];
  // burnt-out flats: a fire takes a riser of flats (1-3 storeys up one or two modules), more of them in the worse blocks
  for (const [a, c] of secs) for (let f = 0; f < F; f++) if (R() < (B.burn ?? 0.4) * 0.3 * k) {
    const w0 = 1 + Math.floor(R() * Math.min(3, c - a + 1)), x0 = a + Math.floor(R() * Math.max(1, c - a + 2 - w0)), h = 1 + Math.floor(R() * 3);
    plan.burn.push([x0, Math.min(c, x0 + w0 - 1), f, Math.min(F - 1, f + h - 1)]); f += h;
  }
  // glide bomb through the roof (FAB-500 / -1500): 2-4 modules wide, deepest in the middle, never down to the first floors
  const fabP = (F >= 9 ? B.fabTall ?? 0.7 : B.fab ?? 0.35) * sstep(0.12, 0.65, d), pk = b.pancaked;
  if (!school && F >= 5 && M >= 5 && (!pk || M >= 10) && R() < fabP) {
    const n = F >= 9 && d > 0.8 && M >= 12 && R() < 0.45 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const wd = 2 + Math.floor(R() * 3), a = 1 + Math.floor(R() * Math.max(1, M - wd - 1)), c = Math.min(M - 2, a + wd - 1);
      if (plan.fab.some(([p, q]) => a <= q + 1 && c >= p - 1) || (pk && a <= pk[1] + 1 && c >= pk[0] - 1)) continue;
      plan.fab.push([a, c, F >= 9 ? 3 + Math.floor(R() * Math.max(1, F - 6)) : 2 + (R() < 0.35 ? 1 : 0)]);
    }
  }
  // roof burnt off / caved in over a section or two (most of the five-storeys: the top flats burn first)
  if (R() < (F >= 9 ? B.roofTall ?? 0.35 : B.roof ?? 0.5) * k) {
    const si = Math.floor(R() * secs.length), [a, c] = secs[si];
    plan.roof.push([a, c]); if (secs.length > 1 && R() < 0.35 * k) { const [a2, c2] = secs[(si + 1) % secs.length]; plan.roof.push([a2, c2]); }
  }
  // single shell / bomb holes through the flat roof (a module each): the burnt flat below open to the sky
  for (let i = 0, nh = Math.floor((B.roofHoles ?? 0.1) * M * k + R()); i < nh; i++) { const c0 = Math.floor(R() * M); if (!plan.roof.some(([a, c]) => c0 >= a && c0 <= c)) plan.roof.push([c0, c0]); }
  // facade stripped by a blast (a bomb that landed beside the block): the rooms behind open floor by floor
  if (!school && F >= 5 && R() < (B.shear ?? 0.25) * sstep(0.3, 0.8, d)) {
    const wd = 2 + Math.floor(R() * 4), a = Math.floor(R() * Math.max(1, M - wd)), c = Math.min(M - 1, a + wd - 1);
    plan.shear.push([R() < 0.5 ? 'front' : 'back', a, c, 3 + Math.floor(R() * 2), F - 1 - (R() < 0.4 ? 1 : 0)]);
  }
  b.ruin(plan);
  const st = S.stats; st.fab += plan.fab.length; st.roof += plan.roof.length; st.shear += plan.shear.length; st.burn += plan.burn.length;
  // ---- kit pieces that go with the damage
  const ex = b.extras ||= [], v = new THREE.Vector3(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), Y = new THREE.Vector3(0, 1, 0);
  const at = (lx, y, lz, ry, s = 1) => { b.toWorld(lx, y, lz, v); q.setFromAxisAngle(Y, b.rot + ry); return new THREE.Matrix4().compose(v, q, new THREE.Vector3(s, s, s)); };
  const pile = (lx, lz, outRy, big, s) => {   // heap against the facade, +Z of the pile = away from the building
    // (big heaps: the small pile stretched flat-ish, 2.9k triangles instead of the large one's 9.1k)
    const name = 'collapse_pile_small', T = pileTpl(w, name); if (!T || !kit.pieces[name]) return;
    const sx = big ? s * 1.75 : s, sy = big ? s * 1.15 : s;
    b.toWorld(lx, 0, lz, v); const ry = b.rot + outRy + (R() - 0.5) * 0.3, x = v.x, z = v.z;
    if (Math.abs(x) > MAP_SIZE / 2 - 10 || Math.abs(z) > MAP_SIZE / 2 - 10 || w.terrain.cutSDF(x, z) < T.r * sx + 1 || w.net?.hit(x, z, T.r * sx * 0.45)) return;
    const Mg = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(Y, ry), new THREE.Vector3(sx, sy, sx));
    ex.push({ piece: name, M: Mg.clone().multiply(new THREE.Matrix4().makeTranslation(T.off.x, T.off.y, T.off.z)) });
    S.heaps.push({ tpl: T.obj, M: Mg, x, z, r: T.r * sx, top: T.top * sy, b }); st.piles++;
  };
  const furn = ['debris_wardrobe', 'debris_bed', 'debris_table', 'debris_radiator'].filter(n => kit.pieces[n]);
  for (const [a, c] of plan.fab) {
    const mx = -b.L / 2 + ((a + c + 1) / 2) * W, big = F >= 9, s = big ? 0.62 + R() * 0.3 : 0.85 + R() * 0.3;
    pile(mx + (R() - 0.5) * 2, b.D / 2 + (big ? 3.6 : 2.6) * s, 0, big, s);
    pile(mx + (R() - 0.5) * 2, -b.D / 2 - (big ? 3.6 : 2.6) * s, Math.PI, big && R() < 0.5, s * 0.85);
    // furniture tipped over on the floor of the crater (the top of the stub), seen from above
    for (let col2 = a; col2 <= c; col2++) if (furn.length && R() < 0.7) { const f = b.cut[col2]; ex.push({ piece: pick(R, furn), M: at(-b.L / 2 + col2 * W + 0.4 + R() * 1.6, f * H + 0.01, (R() - 0.5) * (b.D - 4), R() * TAU) }); }
    S.blocks.push({ b, kind: 'fab', a, c });
  }
  for (const [a, c] of plan.roof) {
    for (let col2 = a; col2 <= c; col2 += 2) if (kit.pieces.slab_floor_broken && b.roofGone.has(col2) && R() < 0.75) ex.push({ piece: 'slab_floor_broken', M: at(-b.L / 2 + col2 * W, (F - 1) * H + 0.01, -1.2 - R() * (b.D - 6) * 0.5, R() < 0.5 ? 0 : Math.PI) });
    S.blocks.push({ b, kind: 'roof', a, c });
  }
  for (const [side, a, c, f0] of plan.shear) {
    const sd = side === 'front' ? 1 : -1, mx = -b.L / 2 + ((a + c + 1) / 2) * W;
    pile(mx, sd * (b.D / 2 + 2.4), side === 'front' ? 0 : Math.PI, false, 0.7 + R() * 0.25);
    for (let col2 = a; col2 <= c; col2++) for (let f = f0; f < F; f++) if (furn.length && R() < 0.22) ex.push({ piece: pick(R, furn), M: at(-b.L / 2 + col2 * W + 0.3 + R() * 0.8, f * H + 0.01, sd * (b.D / 2 - 2.6 - R() * 1.5), R() * TAU) });
    S.blocks.push({ b, kind: 'shear', side, a, c, f0 });
  }
  // full-height pancaked section (real.js classifyBuildings: the worst-hit blocks): one big heap filling the gap
  if (b.pancaked) {
    const [a, c] = b.pancaked, mx = -b.L / 2 + ((a + c + 1) / 2) * W;
    pile(mx, (R() - 0.5) * 2, R() < 0.5 ? 0 : Math.PI, true, Math.min(1.15, 0.45 + F / 12));
    st.pancake++;
  }
  if (plan.burn.length || plan.fab.length || plan.roof.length) S.blocks.push({ b, kind: 'burn' });
}
// collapse pile templates (panel_kit.glb): the node (terrain stamp frame) and the kit piece's offset from it
function pileTpl(w, name) {
  const C = w.ruin._piles ||= {}; if (name in C) return C[name];
  const o = w.assets.gltf.panel_kit?.scene.getObjectByName(name); if (!o) return (C[name] = null);
  o.updateMatrixWorld(true); const bb = new THREE.Box3().setFromObject(o).applyMatrix4(new THREE.Matrix4().copy(o.matrixWorld).invert());
  return (C[name] = { obj: o, off: new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.min.y, (bb.min.z + bb.max.z) / 2), r: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2, top: bb.max.y });
}

// ================================================================ rubble heaps: stamped into the ground, nav
// called from City.rubbleAndDebris (before it instances the scanned heaps); add(x, z, s, ry, own, kind) places one of
// the scanned rubble heaps the usual way (terrain stamp, slow-going nav, low cover)
function ruinRubble(w, add) {
  const S = w.ruin, R = S.R.block, nav = w.nav, kit = w.assets.kit, W = kit.W;
  // the kit collapse piles (drawn by the kit pool): ground relief, nav: slow, cover, vehicles stopped by the big ones
  for (const h of S.heaps) {
    w.terrain.stamp(h.tpl, h.M);
    vehDisc(nav, h.x, h.z, h.r * 0.62, h.top > 2.2 ? 2 : h.top > 1.2 ? 1 : 0);
    nav.circle(h.x, h.z, h.r * 0.7, h.top > 2.2 ? 7 : 6, true);
    w.solidAdd?.(h.x, h.z, h.r * 0.6, h.r * 0.6, 0, 'rubble');
  }
  // scanned heaps along the sheared facades and round the bomb craters (the fans the existing code puts under
  // blown-out panels only reach the first floors)
  for (const e of S.blocks) {
    const b = e.b;
    if (e.kind === 'shear') { const sd = e.side === 'front' ? 1 : -1; for (let col2 = e.a; col2 <= e.c; col2 += 2) { const p = b.toWorld(-b.L / 2 + (col2 + 0.5) * W + (R() - 0.5) * 2, 0, sd * (b.D / 2 + 1.6 + R() * 1.5)); add(p.x, p.z, 0.7 + R() * 0.5, R() * TAU, b, 'fan'); } }
    else if (e.kind === 'fab') for (const sd of [-1, 1]) for (let col2 = e.a - 1; col2 <= e.c + 1; col2 += 2) { const p = b.toWorld(-b.L / 2 + (col2 + 0.5) * W + (R() - 0.5) * 2, 0, sd * (b.D / 2 + 1.4 + R() * 2)); add(p.x, p.z, 0.6 + R() * 0.5, R() * TAU, b, R() < 0.5 ? 'fan' : 'heap'); }
  }
  // flattened houses: a stub of wall round a heap of brick, slate and timber
  // (flattened: a fuller heap, still inside the outline; the scanned heaps are ~3.4 m in radius at scale 1)
  for (const h of S.houses) if (h.mode === 'stub' || h.mode === 'flat') { const fr = houseFrame(w, h.t), k = fr ? Math.min(fr.hx, fr.hz) * h.s / 3.4 : 1; add(h.x + (R() - 0.5) * 1.2, h.z + (R() - 0.5) * 1.2, Math.max(0.5, Math.min(1.05, k * (h.mode === 'flat' ? 1.15 : 0.95))) * (0.9 + R() * 0.15), R() * TAU, null, 'house'); }
  nav.vehDirty = true;
}
function vehDisc(nav, x, z, r, v) {
  if (!v) return; nav.veh ||= new Uint8Array(nav.n * nav.n); nav.vehDirty = true;
  for (let zz = z - r; zz <= z + r; zz += nav.cell) for (let xx = x - r; xx <= x + r; xx += nav.cell) { if ((xx - x) ** 2 + (zz - z) ** 2 > r * r) continue; const i = nav.idx(xx, zz); if (i >= 0) nav.veh[i] = Math.max(nav.veh[i], v); }
}

// ================================================================ private sector / village houses
// 0 intact, 1 burnt-out roofless shell, 2 flattened (heap), 3 roof broken open, 4 wall stubs on a heap.  Patchy: a
// smooth noise field shifts the odds street by street (a salvo, a fire that took a row), the map's gradient (the side
// the attack came from) on top.
const HOUSE_STATES = ['intact', 'shell', 'rubble', 'holed', 'stub'];
function houseFate(w, x, z) {
  const S = w.ruin, H = S.P.houses; if (!H) return null;
  const g = H.grad ? Math.max(-1, Math.min(1, (x * H.grad[0] + z * H.grad[1]) / (MAP_SIZE / 2))) * 0.12 : 0;
  const n = (vnoise(x, z, 70, 41) - 0.5) * 0.5 + g, u = hash2(x, z, 43);
  const wreck = Math.max(0, Math.min(1, 1 - (H.intact ?? 0.05) + n * 0.3));   // share of houses hit at all, here
  if (u > wreck) return 0;
  const v = hash2(x, z, 44), t = H.mix, sum = t.rubble + t.stub + t.shell + t.holed;
  const heavy = Math.max(0, Math.min(1, 0.5 + n));   // worse patch: more flattened / burnt, fewer merely holed
  const wr = t.rubble * (0.6 + heavy * 0.8), ws = t.stub * (0.7 + heavy * 0.6), wsh = t.shell, wh = t.holed * (1.4 - heavy * 0.8), all = wr + ws + wsh + wh;
  let a = v * all; const st = (a -= wr) < 0 ? 2 : (a -= ws) < 0 ? 4 : (a -= wsh) < 0 ? 1 : 3;
  void sum; S.stats.houses[HOUSE_STATES[st]] = (S.stats.houses[HOUSE_STATES[st]] || 0) + 1;
  return st;
}
// the variant templates (registered in the world's template cache like burntTpl)
export function ruinTpl(w, name, mode) {
  const k = name + '_' + mode; w._tpl ||= {};
  if (!(k in w._tpl)) {
    let g = null; const base = w.tpl(name);
    try { g = base ? houseRuin(base, mode, seedOf(MAP.id + ':' + k)) : null; } catch (e) { console.warn('houseRuin', name, mode, e); g = null; }
    if (g) g.userData.bb = new THREE.Box3().setFromObject(g);
    w._tpl[k] = g;
  }
  return w._tpl[k] ? k : null;
}

// ================================================================ trees
// leafy -> stripped (leaves and twigs shot away), broken (crown snapped off, the top lying by it), stump (felled by a
// blast: the stump stays, the trunk lies beside it -- both written as debris, no extra instanced templates); the odds by
// the map's profile, a smooth patchiness and the shelling intensity nearby (heatAt).  Returns the template to place, or
// null: a stump (the caller blocks the cell, the debris pass draws it).
const URBAN_T = { leafy_summer_chestnut: ['tree_chestnut_stripped', 'tree_chestnut_broken'], leafy_summer_birch: ['tree_birch_stripped', 'tree_birch_snapped'], tree_chestnut_broken: [null, 'tree_chestnut_broken'], tree_poplar_broken: [null, 'tree_poplar_broken'], tree_birch_stripped: ['tree_birch_stripped', 'tree_birch_snapped'], tree_chestnut_stripped: ['tree_chestnut_stripped', 'tree_chestnut_broken'] };
const RURAL_T = { tree_acacia_leafy: 'acacia', tree_walnut_leafy: 'acacia', tree_oak_leafy: 'acacia', tree_acacia_shelled: 'acacia', tree_poplar_leafy: 'poplar' };
function treeFate(w, n, x, z, s = 1) {
  const S = w.ruin, T = S.P.trees; if (!T || /^bush/.test(n)) return n;
  const k = Math.max(0, Math.min(1, (T.level ?? 0.6) + (vnoise(x, z, 55, 47) - 0.5) * 0.5 + (S.heat ? S.heat(x, z) : 0) * 0.35));
  const u = hash2(x, z, 48), st = S.stats.trees;
  const pStump = (T.stump ?? 0.12) * (0.4 + k), pBroken = (T.broken ?? 0.2) * (0.5 + k), pStrip = (T.stripped ?? 0.4) * (0.6 + k * 0.8);
  const fall = hash2(x, z, 49) * TAU;
  if (u < pStump) { S.stumps.push([x, z, s, fall]); st.stump = (st.stump || 0) + 1; return null; }
  const urban = URBAN_T[n];
  if (urban) {
    // streets v4: the birch snapped low -- a stump, its top lying beside it (the stump pass) (tree_birch_snapped's own top hangs ~2-6 m
    // up in the air, never touching the ground: not used)
    if (u < pStump + pBroken && urban[1] === 'tree_birch_snapped') { S.stumps.push([x, z, s, fall]); st.broken = (st.broken || 0) + 1; return null; }
    if (u < pStump + pBroken && urban[1]) { if (hash2(x, z, 50) < 0.5) (w._bfTops ||= []).push([x, z, fall, 0.7 * s]); st.broken = (st.broken || 0) + 1; return urban[1]; }
    if (u < pStump + pBroken + pStrip && urban[0]) { st.stripped = (st.stripped || 0) + 1; return urban[0]; }
    return n;
  }
  const sp = RURAL_T[n]; if (!sp) return n;
  if (u < pStump + pBroken) { const t = sp === 'poplar' && w.tpl('tree_poplar_broken') ? 'tree_poplar_broken' : 'tree_acacia_shelled'; (w._bfTops ||= []).push([x, z, fall, (sp === 'poplar' ? 0.75 : 0.6) * s]); st.broken = (st.broken || 0) + 1; return t; }
  if (u < pStump + pBroken + pStrip) { const t = shatteredTpl(w, sp); if (t) { st.stripped = (st.stripped || 0) + 1; return t; } }
  return n;
}

// ================================================================ power lines: poles snapped / down, their wires on the ground
// polesReal hands over the placed pole matrices and the wire polylines (before instancing / merging); a share of the
// standing poles goes over (lying, base by its stump) or leans hard; the spans that hung from it come down to the ground
function ruinPoles(w, mats, lines, att, pole) {
  const S = w.ruin, R = S.R.pole, p = S.P.poles ?? 0.3, v = new THREE.Vector3(), e = new THREE.Vector3();
  for (let i = 0; i < mats.length; i++) {
    const M = mats[i], el = M.elements; if (el[5] < 0.97 || R() > p) continue;   // already broken, or spared
    const x = el[12], z = el[14], old = att.map(a => a.clone().applyMatrix4(M)), ry = Math.atan2(el[8], el[10]) + (R() - 0.5) * 0.6;
    const down = R() < 0.6, tilt = down ? (Math.PI / 2 - 0.05 - R() * 0.12) * (R() < 0.5 ? 1 : -1) : (0.3 + R() * 0.45) * (R() < 0.5 ? 1 : -1);
    const N = w.restOn ? w.restOn(pole, x, z, ry, tilt, (R() - 0.5) * 0.1, down ? 0.06 : 0.25) : trs(x, 0, z, ry, 1, tilt, 0);
    if (down) { // the lying pole must not cross a road or end in a wall
      let ok = true; for (let t = 1; t < 9; t += 1.5) { e.set(0, t, 0).applyMatrix4(N); if (w.net?.hit(e.x, e.z, 0.6) || (w.paved && w.paved.paved(e.x, e.z) < 0.3) || w.railNear?.(e.x, e.z, 2.2) || w.overlapsBuilding?.(e.x, e.z, 0.3, 0.3, 0.3) || w.terrain.cutSDF(e.x, e.z) < 0.6) { ok = false; break; } } if (!ok) continue;
    }
    mats[i] = N; S.stats.poles++; if ((S.poleSpots ||= []).length < 40) S.poleSpots.push([Math.round(x), Math.round(z), down ? 1 : 0]);
    const now = att.map(a => a.clone().applyMatrix4(N));
    for (let j = 0; j < lines.length; j++) {
      const L = lines[j], a = L[0], b = L[L.length - 1];
      for (let q = 0; q < old.length; q++) {
        const ea = a.distanceTo(old[q]) < 0.3, eb = b.distanceTo(old[q]) < 0.3; if (!ea && !eb) continue;
        const far = ea ? b : a, nearP = now[q]; v.copy(nearP);
        if (down) v.y = Math.max(v.y, w.terrain.heightAt(v.x, v.z) + 0.03);
        // wire from the far pole to this end: dragged to the ground, a slack length lying in the grass
        const span = far.distanceTo(v), sag = down || v.y < 2 ? Math.min(far.y, span * 0.35) : 1.6 + R();
        const pts = catenaryTo(far, v, sag, w); lines[j] = ea ? pts.reverse() : pts;
        break;
      }
    }
  }
}
// streets v2: a fallen trunk (log of up to 7.5 m * k from its butt along angle a) never lies on a carriageway / kerb / pavement
export function logClear(w, x, z, a, k) { const L = 7.5 * k + 0.6; for (let t = 0; t <= L; t += 0.8) if (w.terrain.cutSDF(x + Math.cos(a) * t, z - Math.sin(a) * t) < 0.8 || w.terrain.cutSDF(x + Math.cos(a) * t, z + Math.sin(a) * t) < 0.8) return false;   /* (v9: never across a trench -- it hung over the cut) */
  if (!w.paved) return true; for (let t = 0; t <= L; t += 0.8) if ((w.railGap && (w.railGap(x + Math.cos(a) * t, z - Math.sin(a) * t) < 2.6 || w.railGap(x + Math.cos(a) * t, z + Math.sin(a) * t) < 2.6)) || w.paved.paved(x + Math.cos(a) * t, z - Math.sin(a) * t) < 0.3 || w.paved.paved(x + Math.cos(a) * t, z + Math.sin(a) * t) < 0.3) return false; return true; }
function catenaryTo(a, b, sag, w) {
  const pts = []; for (let i = 0; i <= 12; i++) { const t = i / 12, p = a.clone().lerp(b, t); p.y -= sag * 4 * t * (1 - t); const g = w.terrain.heightAt(p.x, p.z) + 0.03; if (p.y < g) p.y = g; pts.push(p); } return pts;
}

// ================================================================ vehicles: knocked-out armour, burnt cars
// warReal hands over its wreck templates and its add(key, group, M) (same instancing batches: no new draw calls per
// type); the map's extra wrecks (profile.wrecks) where the fighting was, burnt cars in the courtyards / yards
function ruinWrecks(w, WT, add) {
  const S = w.ruin, R = S.R.car, P = S.P;
  for (const [x0, z0, ry0, k, off] of P.wrecks || []) {
    const t = WT[k]; if (!t) continue;
    let x = x0, z = z0, ok = false;
    for (let i = 0; i < 24 && !ok; i++) { if (i) { x = x0 + (R() - 0.5) * 26; z = z0 + (R() - 0.5) * 26; } ok = Math.abs(x) < MAP_SIZE / 2 - 12 && Math.abs(z) < MAP_SIZE / 2 - 12 && w.terrain.cutSDF(x, z) > 7 && !w.net.hit(x, z, 2) && !w.overlapsBuilding(x, z, 2, 4, 1) && !w.solidHit(x, z, 1.9, 3.9, ry0, 0.3) && !w.inPlot(x, z) && !(w.wreckSpots || []).some(([a, b]) => Math.hypot(a - x, b - z) < 9); }
    if (!ok) continue;
    const ry = ry0 + (R() - 0.5) * 0.4, M = w.restM(x, z, ry, 1.6, 3.4, (R() - 0.5) * 0.06, (R() - 0.5) * 0.08); add(k + '_h', t.hull, M);
    if (t.turret && !off) add(k + '_t', t.turret, M.clone().multiply(new THREE.Matrix4().makeRotationY((R() - 0.5) * 1.6)));
    else if (t.turret && off === 2) { // turret blown off, lying upside down / on its side a few metres away
      const a = R() * TAU, d = 4 + R() * 4, tx = x + Math.cos(a) * d, tz = z + Math.sin(a) * d;
      if (!w.net.hit(tx, tz, 2) && !w.overlapsBuilding(tx, tz, 2, 2, 0.5) && w.terrain.cutSDF(tx, tz) > 3) add(k + '_t', t.turret, w.restOn(t.turret, tx, tz, R() * TAU, R() < 0.5 ? Math.PI : Math.PI / 2 * (R() < 0.5 ? 1 : -1), 0, 0.15));
    }
    w.nav.rect(x, z, 1.75, 3.7, ry, BLOCK, 0.2); w.solidAdd(x, z, 1.75, 3.7, ry, 'wreck'); w.nav.addOccluder(x, z, 1.6, 3.4, ry, 2.2, null);
    w.wreckSpots.push([x, z]); S.stats.wrecks++;
  }
  // burnt-out cars: courtyards / parking by the ruined blocks, yards of the private sector / village, verges
  const nCars = P.cars || 0, roads = w.osm.roads.filter(r => r.type !== 'track'), cars = w.urban ? ['car_vaz2107_burnt', 'car_vaz2107_burnt', 'car_vaz2107_burnt_sagged', 'car_vaz2107_wreck_side'] : ['car_vaz2107_burnt', 'car_vaz2107_burnt_sagged', 'tractor_mtz80_burnt', 'car_vaz2107_wreck_side'];
  const pool = cars.filter(n => w.tpl(n));
  for (let i = 0, n = 0; i < nCars * 12 && n < nCars && pool.length; i++) {
    let x, z, ry;
    if (R() < 0.55 && S.blocks.length) { // beside a ruined block (its courtyard side / the street side)
      const e = S.blocks[Math.floor(R() * S.blocks.length)], b = e.b, sd = R() < 0.5 ? -1 : 1, p = b.toWorld((R() - 0.5) * b.L, 0, sd * (b.D / 2 + 6 + R() * 10)); x = p.x; z = p.z; ry = b.rot + (R() < 0.5 ? 0 : Math.PI / 2) + (R() - 0.5) * 0.5;
    } else if (R() < 0.5 && S.houses.length) { // in a yard (the plot's front, by the gate)
      const h = S.houses[Math.floor(R() * S.houses.length)], a = R() * TAU, d = 6 + R() * 6; x = h.x + Math.cos(a) * d; z = h.z + Math.sin(a) * d; ry = R() * TAU;
    } else { // on a verge
      const r = roads[Math.floor(R() * roads.length)]; if (!r) continue; const P2 = r.pts, k = Math.floor(R() * (P2.length - 1)), [ax, az] = P2[k], [bx, bz] = P2[k + 1], L = Math.hypot(bx - ax, bz - az) || 1, t = R(), sd = R() < 0.5 ? -1 : 1, o = r.w / 2 + 1.6 + R();
      x = ax + (bx - ax) * t - (bz - az) / L * o * sd; z = az + (bz - az) * t + (bx - ax) / L * o * sd; ry = Math.atan2(-(bz - az), bx - ax) + Math.PI / 2 + (R() - 0.5) * 0.7;
    }
    if (Math.abs(x) > MAP_SIZE / 2 - 15 || Math.abs(z) > MAP_SIZE / 2 - 15 || w.terrain.cutSDF(x, z) < 5 || w.net.hit(x, z, 1.2)) continue;
    const name = pick(R, pool);
    if (w.put(name, x, z, ry, { cost: BLOCK, roadPad: 1, inst: { cell: 320, cullDist: 900 }, group: '_wr' })) { n++; S.stats.cars++; w.burntSpots.push([x, z, /tractor/.test(name) ? 5 : 4]); }
  }
}

// ================================================================ craters
// RealUrban: replaces City.craters' 120 random decals: density by ground (the open field the attack came across, the
// courtyards, the gardens of the private sector, small scars on the asphalt), big bomb craters by the ruined blocks.
// RealRural: extra crater pre-roll (craterList, before crops / trees / nav) on the approach fields, along the tree belts
// and in the village gardens.
function ruinCraters(w) {
  const S = w.ruin, C = S.P.craters || {}, R = S.R.crater, half = MAP_SIZE / 2;
  const occ = new Map(), CG = 8, free = (x, z, r) => { for (let i = Math.floor((x - r) / CG); i <= Math.floor((x + r) / CG); i++) for (let j = Math.floor((z - r) / CG); j <= Math.floor((z + r) / CG); j++) for (const c of occ.get(i * 4096 + j) || []) if (Math.hypot(c[0] - x, c[1] - z) < (c[2] + r) * 0.55) return false; return true; };
  const reg = (x, z, r) => { const k = Math.floor(x / CG) * 4096 + Math.floor(z / CG); (occ.get(k) || occ.set(k, []).get(k)).push([x, z, r]); };
  const bld = w.osm.buildings, bIdx = new Map(); for (const b of bld) { const k = Math.floor(b.x / 32) * 4096 + Math.floor(b.z / 32); (bIdx.get(k) || bIdx.set(k, []).get(k)).push(b); }
  const onBld = (x, z, pad) => { for (let i = Math.floor((x - 40) / 32); i <= Math.floor((x + 40) / 32); i++) for (let j = Math.floor((z - 40) / 32); j <= Math.floor((z + 40) / 32); j++) for (const b of bIdx.get(i * 4096 + j) || []) { const c = Math.cos(b.rot), s = Math.sin(b.rot), dx = x - b.x, dz = z - b.z; if (Math.abs(dx * c - dz * s) < b.L / 2 + pad && Math.abs(dx * s + dz * c) < b.D / 2 + pad) return true; } return false; };
  let made = 0;
  if (w.urban) {
    // decals (size = decal diameter as City.addCrater), the bigger ones a slow / low-cover bowl on the nav grid
    const put = (x, z, size, cell = null) => {
      if (Math.abs(x) > half - 8 || Math.abs(z) > half - 8 || w.terrain.cutSDF(x, z) < size * 0.6 + 0.5 || w.buildingAt(x, z, size * 0.4) || onBld(x, z, size * 0.3) || !free(x, z, size * 0.5)) return false;
      if (cell !== 2 && w.net.hit(x, z, size * 0.25) && R() < 0.8) { size = Math.min(size, 2.6); cell = 2; }
      const n0 = w.craterMesh.count; w.addCrater(x, z, size, cell); if (w.craterMesh.count === n0) return false;
      reg(x, z, size * 0.5); made++;
      if (size > 4.5 && cell !== 2) w.nav.circle(x, z, size * 0.22, 2, true);
      return true;
    };
    // bomb / heavy-shell craters beside the ruined blocks (the near misses of the glide bombs; first: the cap)
    for (const e of S.blocks) if (e.kind === 'fab' || e.kind === 'shear') for (let k = 0; k < (C.fab ?? 2); k++) {
      const b = e.b, a = R() * TAU, d = Math.max(b.L, b.D) * 0.5 + 8 + R() * 25, x = b.x + Math.cos(a) * d, z = b.z + Math.sin(a) * d;
      put(x, z, 7 + R() * 6, R() < 0.5 ? 0 : 1);
    }
    const area = (MAP_SIZE - 20) ** 2, tries = Math.round(area / 90);
    for (let i = 0; i < tries; i++) {
      const x = (R() - 0.5) * (MAP_SIZE - 20), z = (R() - 0.5) * (MAP_SIZE - 20), u = R(), sz = R();
      const road = w.net.hit(x, z, 0), plot = !road && w.inPlot(x, z), field = !road && !plot && w.areaIs(x, z, ['farmland', 'meadow', 'grassland', 'grass', 'scrub']) && !w.areaIs(x, z, ['residential']);
      const dens = road ? C.street ?? 0.02 : plot ? C.garden ?? 0.25 : field ? C.field ?? 0.5 : C.yard ?? 0.2, patch = 0.4 + vnoise(x, z, 90, 51) * 1.2;
      if (u > dens * patch) continue;
      if (road) put(x, z, 1.4 + sz * 1.8, 2);
      else put(x, z, field ? 2.2 + sz * sz * 6 : 1.8 + sz * sz * 5);
    }
  } else {
    const list = w.craterList; if (!list) return;
    for (const [x, z, r] of list) reg(x, z, r);
    const push = (x, z, r) => { if (Math.abs(x) > half - 12 || Math.abs(z) > half - 12 || onRoad(x, z, 2) || onBld(x, z, r + 1) || !free(x, z, r)) return; list.push([x, z, r]); reg(x, z, r); made++; };
    // the approach fields (the attack's side): clustered salvoes
    for (const [x0, z0, x1, z1, n] of C.zones || []) for (let i = 0; i < n; i++) {
      const cx = x0 + R() * (x1 - x0), cz = z0 + R() * (z1 - z0), m = 1 + Math.floor(R() * 5);
      for (let k = 0; k < m; k++) { const a = R() * TAU, d = R() * 18; push(cx + Math.cos(a) * d, cz + Math.sin(a) * d, R() < 0.12 ? 3.5 + R() * 3 : 1.2 + R() * 2.4); }
    }
    // the village: gardens and yards ploughed by shelling
    for (const p of w.osm.plots || []) { const [a, , c] = p.pts; for (let k = 0; k < (C.plot ?? 1); k++) if (R() < 0.8) push(a[0] + (c[0] - a[0]) * R(), a[1] + (c[1] - a[1]) * R(), 1.1 + R() * R() * 3.5); }
    // tree belts (positions dug in along them, so shelled along them)
    for (const l of w.osm.lines) if (l.t === 'tree_row') for (let i = 0; i < l.pts.length - 1; i++) { const [ax, az] = l.pts[i], [bx, bz] = l.pts[i + 1], L = Math.hypot(bx - ax, bz - az); for (let t = 0; t < L; t += 16) if (R() < (C.belt ?? 0.5)) { const o = (R() - 0.5) * 24; push(ax + (bx - ax) * t / L - (bz - az) / L * o, az + (bz - az) * t / L + (bx - ax) / L * o, 1.2 + R() * 2.8); } }
  }
  S.stats.craters = made;
}

// ================================================================ debris (battlefieldDetail's merged per-cell buffers)
export const _RP = {}; const RP = {
  // broken precast slab / wall panel, propped at an angle on the heap, bars sticking out of the broken edge
  slab(D, r) {
    const L = 0.9 + r() * 2.1, wd = 0.5 + r() * 1.1, t = 0.14 + r() * 0.08, c = col(pick(r, [0x8f8b84, 0x9a958c, 0x7f7b73, 0xa39e93]), r), tilt = (r() - 0.5) * 0.6;
    D.box(0, t / 2 + Math.abs(tilt) * wd * 0.5, 0, L, t, wd, c, 0, tilt, (r() - 0.5) * 0.25);
    const n = 2 + (r() * 4 | 0); for (let k = 0; k < n; k++) D.cyl(L / 2 + 0.15, t / 2 + Math.abs(tilt) * wd * 0.5, (k / n - 0.4) * wd * 0.8, 0.008, 0.3 + r() * 0.6, mcol(0x4a3426, r, 0.4, 0.95), 0, (r() - 0.5) * 0.8, -Math.PI / 2 + (r() - 0.5) * 0.9, 1, 5);
  },
  glass(D, r) { const n = 6 + (r() * 9 | 0); for (let k = 0; k < n; k++) { const s = 0.06 + r() * 0.2; D.part(DG.tet, lm((r() - 0.5) * 1.6, 0.004, (r() - 0.5) * 1.6, 0, r() * 6, 0, s, 0.004, s * 0.7), mcol(pick(r, [0xa9bdbb, 0x93a8a6, 0xbfc9c4]), r, 0.0, 0.1)); } },
  radiator(D, r) { const n = 6 + (r() * 6 | 0), c = r() < 0.6 ? col(0xcfcac0, r) : mcol(0x6b4630, r, 0.35, 0.9); D.box(0, 0.045, 0, n * 0.085, 0.09, 0.5, c); for (let k = 0; k < 2; k++) D.box(0, 0.05, (k - 0.5) * 0.52, n * 0.085, 0.07, 0.05, c.clone().multiplyScalar(0.85)); },
  furn(D, r) {
    const burnt = r() < 0.4, k = burnt ? 0.22 : 1, kind = r();
    if (kind < 0.35) { const c = col(pick(r, [0x5a3e2a, 0x6b4a33, 0x4a3628]), r).multiplyScalar(k); D.box(0, 0.25, 0, 1.0, 0.5, 1.9, c, 0, 0, (r() - 0.5) * 0.2); D.box(0.2, 0.52, 0.3, 0.45, 0.04, 0.8, c.clone().multiplyScalar(0.85), 0.3); }   // wardrobe on its back, a door off
    else if (kind < 0.65) { const c = col(pick(r, [0x6a5a4a, 0x3f4a5a, 0x7a4a3a, 0x556048]), r).multiplyScalar(k); D.box(0, 0.2, 0, 1.9, 0.4, 0.85, c); D.box(0, 0.5, -0.35, 1.9, 0.6, 0.18, c, 0, 0.15); D.box(-0.88, 0.35, 0, 0.16, 0.3, 0.85, c); D.box(0.88, 0.35, 0, 0.16, 0.3, 0.85, c); }   // sofa
    else { const c = mcol(0xd9d7cf, r, 0.3, 0.5).multiplyScalar(burnt ? 0.3 : 1); D.box(0, 0.3, 0, 0.6, 0.6, 1.5, c, 0, 0, Math.PI / 2 * (r() < 0.5 ? 1 : 0)); }   // fridge / washer on its side
  },
  insul(D, r) { const n = 3 + (r() * 4 | 0); for (let k = 0; k < n; k++) { const s = 0.12 + r() * 0.25; D.part(DG.tet, lm((r() - 0.5) * 1.2, s * 0.25, (r() - 0.5) * 1.2, r() * 3, r() * 6, r() * 3, s, s * 0.6, s * 0.9), col(pick(r, [0xc2a85e, 0xb39a54, 0x9e8a55]), r)); } },
  // shell-felled tree: splintered stump, pale torn wood at the top
  stump(D, r, s = 1) {
    const r0 = (0.11 + r() * 0.09) * s, h = (0.35 + r() * 1.3) * s, c = col(pick(r, [0x4a4038, 0x3f3a34, 0x544a3e]), r), wd = col(0xa08a68, r);
    D.cyl(0, h / 2, 0, r0, h, c, 0, 0, 0, 0.88, 6);
    for (let k = 0; k < 3; k++) { const a = k / 3 * TAU + r() * 0.8, l = 0.15 + r() * 0.45; D.box(Math.cos(a) * r0 * 0.5, h + l * 0.35, -Math.sin(a) * r0 * 0.5, 0.035 + r() * 0.04, l, 0.05, wd, -a, (r() - 0.5) * 0.5, 0.25 + r() * 0.3); }
  },
};
Object.assign(_RP, RP);
function ruinDebris(w, api) {
  const S = w.ruin, R = S.R.debris, { D, H, free, claim, taken, scorch } = api, kit = w.assets.kit, W = kit.W, Hk = kit.H, Ld = S.P.litter ?? 1;
  let n = 0;
  const lib = (name) => RP[name] || PC[name];
  // a piece on the ground at (x, z), if the ground is free (roads only with road = true: litter on the carriageway)
  const put = (name, x, z, far = false, rr = 0.3, road = false) => {
    if (!(road ? Math.abs(x) < MAP_SIZE / 2 - 5 && Math.abs(z) < MAP_SIZE / 2 - 5 && w.terrain.cutSDF(x, z) > rr + 0.3 && !api.inBuilding(x, z, rr) && !(w.solidHit && w.solidHit(x, z, rr, rr, 0, 0.05)) : free(x, z, rr)) || taken(x, z, rr * 0.5)) return false;
    const ry = R() * TAU, gx = (H(x + 0.3, z) - H(x - 0.3, z)) / 0.6, gz = (H(x, z + 0.3) - H(x, z - 0.3)) / 0.6, c = Math.cos(ry), s = Math.sin(ry);
    const y0 = w.paved && w.paved.paved(x, z) < 0.4 ? Math.max(H(x, z), ROAD_Y) : H(x, z);   // (on the paved surface: on top of it, not sunk 6 cm into it)
    if (!api.guard(() => { D.begin(x, y0 - 0.01, z, ry, -Math.atan(gx * s + gz * c), Math.atan(gx * c - gz * s), 1, far); lib(name)(D, R); })) return false;   // (never into / over a trench, never floating)
    claim(x, z, rr * 0.5); n++; return true;
  };
  // a piece up on a slab (inside a block, no ground checks)
  const up = (name, x, y, z, far = name === 'slab') => { D.begin(x, y, z, R() * TAU, (R() - 0.5) * 0.2, (R() - 0.5) * 0.2, 1, far); lib(name)(D, R); n++; };
  const W8 = tbl => { let s = 0; for (const [, p] of tbl) s += p; let u = R() * s; for (const [k, p] of tbl) if ((u -= p) < 0) return k; return tbl[0][0]; };
  const SPILL = [['slab', 3], ['chunk', 4], ['rebar', 2], ['window', 2], ['glass', 2], ['insul', 1], ['radiator', 0.6], ['furn', 0.5], ['plank', 0.6], ['sheet', 0.4]];
  const BIG = new Set(['slab', 'beam']);   // (the far copy: big readable pieces only)
  // ---- panel blocks: spill along every facade foot under damaged panels (more under the worse ones), the crater floors
  for (const b of w.buildings || []) {
    if (!b.panels || !b.toWorld) continue;
    const brick = /brick/.test(b.kind);
    for (const p of b.panels) {
      const bad = p.gone ? 3 : p.state; if (bad < 2 || R() > (bad === 3 ? 0.22 : 0.07) * Ld) continue;
      const c = b.panelCenter(p), o = b.outward(p), m = 1 + (R() * (bad === 3 ? 2.5 : 1.5) | 0);
      for (let k = 0; k < m; k++) {
        const d = 1.2 + R() * (2.5 + Math.min(p.floor, 8) * 0.45), t = (R() - 0.5) * W * 1.4, x = c.x + o.x * d + o.z * t, z = c.z + o.z * d - o.x * t;
        const name = brick && R() < 0.5 ? 'brick' : W8(SPILL); put(name, x, z, BIG.has(name), 0.4);
      }
    }
    if (!b.ruined) continue;
    // exposed floors: the stub top of a bomb crater, the burnt-out top storey under the open sky
    for (let c2 = 0; c2 < b.modules; c2++) {
      const f = b.cut?.[c2] < b.floors ? b.cut[c2] : b.roofGone?.has(c2) ? b.floors - 1 : -1; if (f < 1) continue;
      const m = 1 + (R() * 3 | 0);
      for (let k = 0; k < m; k++) { const lx = -b.L / 2 + (c2 + 0.1 + R() * 0.8) * W, lz = (R() - 0.5) * (b.D - 3), p = b.toWorld(lx, 0, lz); up(W8([['slab', 3], ['chunk', 3], ['rebar', 1], ['brick', 1], ['insul', 1], ['plank', 1]]), p.x, f * Hk + 0.12, p.z); }
    }
  }
  // ---- houses: rafters (charred on the burnt shells, bare in the holes of the broken roofs), brick / slate round them
  for (const h of S.houses) {
    const T = w.tpl(h.t), fr = w._tpl?.[h.t + '_holed']?.userData.frame || T?.userData.frame || houseFrame(w, h.t); if (!fr) continue;
    const M = trs(h.x, h.y, h.z, h.ry, h.s), burnt = h.mode === 'shell', rf = h.mode === 'holed' ? (w._tpl[h.t + '_holed']?.userData.holes || []) : null;
    // every rafter rests on something: on the measured wall top (wear.js roofFrame) at its foot and, whole, on the ridge (burnt
    // shell: a charred ridge beam laid gable to gable, only where the shell kept both gables; holed: the roof round the hole);
    // a broken one came down and lies on the floor inside (it used to stick out from the eave into thin air, and every rafter
    // started 0.3-0.7 m over the walls / ran the wrong way on house_e)
    const B = (burnt || h.mode === 'holed') && roofFrame(T);
    if (B) {
      const VF = roofFrame(w._tpl?.[h.t + (burnt ? '_burnt' : '_holed')]), gable = B.apex != null && VF?.apex != null && VF.apex > B.apex - 0.4;
      const ax = B.axis === 'x', len = ax ? B.hx : B.hz, wid = ax ? B.hz : B.hx, eave = B.wallTop + 0.075, ridgeY = gable ? B.apex - 0.1 : eave + 1;
      const rise = Math.max(0.3, ridgeY - eave), sl = Math.hypot(wid, rise), ang = Math.atan2(rise, wid), floorY = B.y0 + (burnt ? 0.5 : 0.425) + 0.075;
      const cc = burnt ? 0x1c1916 : 0x6e5d48, inHole = (x, z) => rf && rf.some(([hx, hz, hr]) => Math.hypot(x - hx, z - hz) < hr * 0.75);
      let whole = 0;
      for (let t = -len + 0.4; t <= len - 0.4; t += 0.9) for (const sd of [-1, 1]) {
        const lx = ax ? B.cx + t : B.cx + sd * wid / 2, lz = ax ? B.cz + sd * wid / 2 : B.cz + t;
        if (rf && !inHole(lx, lz)) continue;   // holed: only across the holes
        if (burnt && R() < 0.55) continue;   // burnt: most of the roof timber is gone
        const rx = ax ? B.cx + t : B.cx, rz = ax ? B.cz : B.cz + t;   // its top end, on the ridge line
        const broken = R() < (burnt ? 0.5 : 0.25) || !gable || (rf && inHole(rx, rz) && rf.some(([hx, hz, hr]) => Math.hypot(rx - hx, rz - hz) < hr * 0.62));
        if (!broken) {
          // rafter from the eave up to the ridge (local frame of the house, then the placement)
          const ex = ax ? B.cx + t : B.cx + sd * wid, ez = ax ? B.cz + sd * wid : B.cz + t, dirx = ax ? 0 : -sd, dirz = ax ? -sd : 0;
          const mx = ex + dirx * Math.cos(ang) * sl / 2, mz = ez + dirz * Math.cos(ang) * sl / 2, my = eave + Math.sin(ang) * sl / 2;
          const w0 = new THREE.Vector3(mx, my, mz).applyMatrix4(M), yaw = h.ry + Math.atan2(-dirz, dirx);
          D.begin(w0.x, w0.y, w0.z, yaw, 0, ang + (R() - 0.5) * 0.04, h.s, true); D.box(0, 0, 0, sl, 0.15, 0.07, col(cc, R, 0.2)); n++; whole++;
        } else {
          // the broken piece on the floor inside the walls
          const Lr = Math.min(sl * (0.35 + R() * 0.45), 2 * Math.min(B.hx, B.hz) - 1.4), px = B.cx + (R() - 0.5) * Math.max(0, 2 * B.hx - 1.2 - Lr), pz = B.cz + (R() - 0.5) * Math.max(0, 2 * B.hz - 1.2 - Lr);
          if (Lr < 0.5) continue;
          const w0 = new THREE.Vector3(px, floorY, pz).applyMatrix4(M);
          D.begin(w0.x, w0.y, w0.z, h.ry + R() * TAU, 0, (R() - 0.5) * 0.06, h.s, true); D.box(0, 0, 0, Lr, 0.15, 0.07, col(cc, R, 0.2)); n++;
        }
      }
      if (burnt && whole) {   // the ridge beam the whole rafters lean on, its ends in the gables
        const w0 = new THREE.Vector3(B.cx, ridgeY - 0.1, B.cz).applyMatrix4(M);
        D.begin(w0.x, w0.y, w0.z, h.ry + (ax ? 0 : Math.PI / 2), 0, 0, h.s, true); D.box(0, 0, 0, 2 * len - 0.1, 0.18, 0.12, col(cc, R, 0.2)); n++;
      }
    }
    // the stuff the house shed round its walls
    // flattened / stubs: the roof timber and slate came down inside the walls, some of it spilling out over them
    if (h.mode === 'stub' || h.mode === 'flat') {
      const M2 = trs(h.x, 0, h.z, h.ry, h.s), v = new THREE.Vector3();
      for (let k = 0; k < (h.mode === 'flat' ? 6 : 4); k++) {
        const u = (R() - 0.5) * 1.6, q = (R() - 0.5) * 1.6; v.set(fr.cx + u * fr.hx, 0, fr.cz + q * fr.hz).applyMatrix4(M2);
        const name = W8([['beam', 3], ['sheet', 2], ['plank', 1.5], ['brick', 1]]);
        if (api.guard(() => { D.begin(v.x, H(v.x, v.z) - 0.04, v.z, R() * TAU, (R() - 0.5) * 0.5, (R() - 0.5) * 0.5, h.s, name === 'beam'); lib(name)(D, R); }, true)) n++;
      }
    }
    const nn = h.mode === 'stub' || h.mode === 'flat' ? 3 : h.mode === 'shell' ? 2 : h.mode === 'holed' ? 1 : 0, rad = Math.max(fr.hx, fr.hz) * h.s;
    for (let k = 0; k < nn; k++) { const a = R() * TAU, d = rad + 0.6 + R() * 3, x = h.x + Math.cos(a) * d, z = h.z + Math.sin(a) * d; const name = W8([['brick', 4], ['chunk', 2], ['sheet', h.mode === 'holed' ? 3 : 1.5], ['beam', burnt ? 1.5 : 0.6], ['plank', 1], ['furn', 0.3], ['window', 0.6], ['glass', 0.6]]); put(name, x, z, BIG.has(name), 0.4); }
    if (h.mode === 'shell' || h.mode === 'stub' || h.mode === 'flat') scorch.push([h.x, h.z, rad + 2.5, h.mode === 'shell' ? 0.45 : 0.3]);
  }
  // ---- stumps (treeFate: the trunk lies beside it)
  for (const [x, z, s, a] of S.stumps) {
    if (api.guard(() => { D.begin(x, H(x, z) - 0.04, z, R() * TAU, (R() - 0.5) * 0.08, (R() - 0.5) * 0.08, 1, false); RP.stump(D, R, s); }, true)) { n++; claim(x, z, 0.4); }
    const px = x + Math.cos(a) * 0.6, pz = z + Math.sin(a) * 0.6; if (w.terrain.cutSDF(px, pz) > 1 && !w.net?.hit(px, pz, 1) && logClear(w, px, pz, a, 0.8 * s) && api.guard(() => { D.begin(px, H(px, pz) - 0.03, pz, -a, 0, (R() - 0.5) * 0.06, 1, s > 1.05); PC.log(D, R, 0.8 * s); })) n++;
  }
  // ---- streets: litter on the carriageways and verges, densest by the ruins (glass, chunks, branches, slabs, wire)
  const roads = w.osm.roads.filter(r => r.type !== 'track');
  for (const r of roads) for (let i = 0; i < r.pts.length - 1; i++) {
    const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], L = Math.hypot(bx - ax, bz - az); if (L < 1) continue;
    for (let t = R() * 6; t < L; t += 4 + R() * 8) {
      const x0 = ax + (bx - ax) * t / L, z0 = az + (bz - az) * t / L, near = S.heat ? S.heat(x0, z0) : 0.5;
      if (R() > (w.urban ? 0.12 : 0.1) * Ld * (0.4 + near)) continue;
      const o = (R() - 0.5) * (r.w + 3), x = x0 - (bz - az) / L * o, z = z0 + (bx - ax) / L * o;
      const name = w.urban ? W8([['chunk', 4], ['glass', 2], ['branch', 2], ['slab', 1], ['brick', 2], ['sheet', 0.5], ['frag', 1], ['window', 0.5], ['plank', 0.6], ['tyre', 0.1]]) : W8([['branch', 4], ['brick', 2], ['sheet', 1.5], ['chunk', 1], ['frag', 1], ['plank', 1]]);
      // streets v2: no flat plates (slabs, sheets, window frames) lying on the carriageway -- broken asphalt chunks there
      const onCw = w.paved ? w.paved.asphalt(x, z) < 0.2 : !!w.net?.hit(x, z, 0);
      put(onCw && /^(slab|sheet|window|plank)$/.test(name) ? (R() < 0.6 ? 'chunk' : 'brick') : name, x, z, BIG.has(name) && !onCw, 0.35, true);
    }
  }
  // scorch where things burnt (wrecks / cars, the burnt blocks' feet)
  for (const [x, z, r] of w.burntSpots || []) if (r <= 6) scorch.push([x, z, r + 1.5, 0.4]);
  S.stats.debris = n; api.stats.ruinPieces = n;
}
// wall box / eave / ridge of a house template (when no ruin variant of it was built)
function houseFrame(w, name) {
  const C = w.ruin._frames ||= {}; if (name in C) return C[name];
  const t = w.tpl(name); if (!t) return (C[name] = null);
  t.updateMatrixWorld(true); const bb = new THREE.Box3().setFromObject(t).applyMatrix4(new THREE.Matrix4().copy(t.matrixWorld).invert()), H = bb.max.y - bb.min.y;
  const hx = (bb.max.x - bb.min.x) / 2 * 0.9, hz = (bb.max.z - bb.min.z) / 2 * 0.9;
  return (C[name] = { cx: (bb.min.x + bb.max.x) / 2, cz: (bb.min.z + bb.max.z) / 2, hx, hz, y0: bb.min.y, eave: bb.min.y + Math.min(3.3, H * 0.55), ridge: bb.max.y, axis: hx >= hz ? 'x' : 'z' });
}
// shelling intensity for trees / litter: the map's level, more by the ruined blocks / houses (filled in after the houses
// and blocks are placed: ruinsHeat)
export function ruinsHeat(w) {
  const S = w.ruin; if (!S) return;
  const C = 16, N = Math.ceil(MAP_SIZE / C), g = new Float32Array(N * N), o = MAP_SIZE / 2;
  const st = (x, z, r, v) => { for (let j = Math.max(0, Math.floor((z - r + o) / C)); j <= Math.min(N - 1, Math.floor((z + r + o) / C)); j++) for (let i = Math.max(0, Math.floor((x - r + o) / C)); i <= Math.min(N - 1, Math.floor((x + r + o) / C)); i++) { const d = Math.hypot((i + 0.5) * C - o - x, (j + 0.5) * C - o - z); if (d < r) g[j * N + i] = Math.max(g[j * N + i], v * (1 - d / r)); } };
  for (const e of S.blocks) st(e.b.x, e.b.z, Math.max(e.b.L, e.b.D) / 2 + 40, e.kind === 'burn' ? 0.6 : 1);
  for (const h of S.houses) st(h.x, h.z, 22, h.mode === 'holed' ? 0.5 : 0.8);
  for (const [x, z] of w.hotspots || []) st(x, z, 60, 0.9);
  for (const s of w.trenchSystems || []) st(s.center[0], s.center[1], s.radius + 50, 0.8);
  S.heat = (x, z) => { const i = Math.floor((x + o) / C), j = Math.floor((z + o) / C); return i < 0 || j < 0 || i >= N || j >= N ? 0 : g[j * N + i]; };
}
