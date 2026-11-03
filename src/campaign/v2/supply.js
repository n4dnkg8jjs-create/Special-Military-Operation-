// Campaign v2 — supply lines and logistics hubs (pure rules, used by state.js for BOTH sides).
//
// Brigade logistics, simplified from how it worked on the Zaporizhzhia and Avdiivka fronts in 2023–24 (sources in
// previews/campaign_v4/PROGRESS_RULES.md): ammunition and fuel come forward by rail to a RAILHEAD / logistics base
// (Orikhiv, Yasynuvata, Tokmak, Ocheretyne / Pokrovsk), are broken down at brigade AMMUNITION / SUPPLY POINTS a few km
// behind the line and trucked forward along the main supply routes (MSRs). A unit is only as supplied as the road
// back to a working hub. Interdicting an MSR with drones / artillery, or capturing a hub, starves everything it feeds
// (Avdiivka's "road of life" through Lastochkyne in February 2024; Ukraine's aim of putting the Tokmak rail hub
// under fire in 2023).
//
// Model, per side S ('player' | 'enemy'):
//   * SOURCES: map-edge cells where the strategic rear begins (aor.supplySources / aor.enemySources).
//   * HUBS: aor.hubs [{ cell, name, kind: 'railhead'|'base'|'ammo', side: 'player'|'enemy' }]: a hub works for whoever
//     holds its cell (a captured hub at half throughput) and only while it is LINKED to a source by road within
//     HUB_LINK route-km. Player-built forward depots (C.depots) are ammo hubs too.
//   * ROUTES: route cost per cell entered = road 2: 1, road 1: 1.5, no road: 2.5 (diagonals x1.4); through own cells
//     only; a cell the other side INTERDICTS this week costs +4 (and an interdicted hub works at half throughput).
//   * LEVEL per cell: 1 (supplied) within HUB_RANGE route of a source / linked hub, 0.5 (strained) within +3, else 0.
//     Railheads and bases reach further than ammo points.
// Output (all plain objects, serialisable): level[cell], dist[cell], via[cell] (next cell towards the feeding hub, for
// drawing supply lines), hubOf[cell] (cell id of the feeding hub / source), hubs: [{cell, name, kind, linked, cap}].
export const ROUTE_COST = [2.5, 1.5, 1];
export const HUB_LINK = 14;                  // a hub must be within this route cost of a source to work
export const HUB_RANGE = { source: 5, railhead: 5, base: 5, ammo: 4, depot: 4 };
export const STRAIN = 3;                     // beyond the range: strained (0.5) for this much more route cost

const cheb = (a, b) => Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));

// Dijkstra over the side's own cells from a set of seeds { id: startCost }
function flood(C, side, seeds, interdicted, limit = 99) {
  const dist = {}, via = {}, from = {}, open = new Set();
  for (const [id, d0] of Object.entries(seeds)) { dist[id] = d0.d; from[id] = d0.hub; open.add(id); }
  while (open.size) {
    let cur = null; for (const o of open) if (cur == null || dist[o] < dist[cur]) cur = o; open.delete(cur);
    if (dist[cur] > limit) continue;
    const a = C.cell(cur);
    for (const n of C.neighbors(cur)) {
      if (C.owner[n] !== side) continue;
      if (C.blocked?.has([cur, n].sort().join('|'))) continue;
      const b = C.cell(n); if (b.terrain === 'water') continue;
      const road = Math.min(a.road || 0, b.road || 0);
      let c = ROUTE_COST[road] * (a.col !== b.col && a.row !== b.row && !road ? 1.4 : 1);
      if (interdicted[n] != null) c += 4;
      const d = dist[cur] + c;
      if (dist[n] == null || d < dist[n] - 1e-9) { dist[n] = d; via[n] = cur; from[n] = from[cur]; open.add(n); }
    }
  }
  return { dist, via, from };
}

// the hubs one side can use right now
export function sideHubs(C, side) {
  const A = C.def.aor, out = [];
  for (const h of A.hubs || []) { if (C.owner[h.cell] !== side) continue; out.push({ ...h, captured: (h.side || 'player') !== side }); }
  if (side === 'player') for (const d of C.depots || []) if (C.owner[d] === 'player' && !out.some(h => h.cell === d)) out.push({ cell: d, name: `Forward ammunition point (${C.cellName(d)})`, kind: 'depot', side: 'player', built: true });
  return out;
}
export function sideSources(C, side) {
  const A = C.def.aor;
  if (side === 'player') return (A.supplySources || []).filter(id => C.owner[id] === 'player');
  let s = (A.enemySources || []).filter(id => C.owner[id] === 'enemy');
  if (!(A.enemySources || []).length) {   // default: the enemy's own map edge
    const rear = { north: c => c.row === 0, south: c => c.row === A.rows - 1, east: c => c.col === A.cols - 1, west: c => c.col === 0 }[A.enemyEdge || 'south'];
    s = A.cells.filter(c => rear(c) && C.owner[c.id] === 'enemy').map(c => c.id);
  }
  return s;
}

// interdicted: { cellId: turn } — cells the OTHER side has under fire this week
export function computeNetwork(C, side, interdicted = {}, extraRange = 0) {
  const live = {}; for (const [k, t] of Object.entries(interdicted || {})) if (t >= C.turn - 1) live[k] = t;
  const srcs = sideSources(C, side), seeds = {};
  for (const s of srcs) seeds[s] = { d: 0, hub: s };
  const base = flood(C, side, seeds, live, HUB_LINK + 6);
  const hubs = sideHubs(C, side).map(h => {
    const linked = base.dist[h.cell] != null && base.dist[h.cell] <= HUB_LINK;
    let cap = linked ? 1 : 0; if (h.captured) cap *= 0.5; if (live[h.cell] != null) cap *= 0.5;
    return { ...h, linked, cap, link: base.dist[h.cell] ?? null };
  });
  // second pass: every source and every working hub feeds its own radius; a cell takes its best (lowest relative) feed
  const level = {}, dist = {}, via = {}, hubOf = {};
  const feeds = [...srcs.map(s => ({ cell: s, kind: 'source', cap: 1 })), ...hubs.filter(h => h.cap > 0)];
  for (const f of feeds) {
    const R = (HUB_RANGE[f.kind] ?? 4) + extraRange, F = flood(C, side, { [f.cell]: { d: 0, hub: f.cell } }, live, R + STRAIN + 1);
    for (const [id, d] of Object.entries(F.dist)) {
      let lv = d <= R ? 1 : d <= R + STRAIN ? 0.5 : 0; if (f.cap < 1 && lv === 1 && d > R * f.cap) lv = 0.5;
      const score = lv * 100 - d;
      if (lv > 0 && (level[id] == null || score > (level[id] * 100 - dist[id]))) { level[id] = lv; dist[id] = d; via[id] = F.via[id] || null; hubOf[id] = f.cell; }
    }
  }
  for (const c of C.def.aor.cells) if (C.owner[c.id] === side && level[c.id] == null) level[c.id] = 0;
  return { side, level, dist, via, hubOf, hubs, sources: srcs, interdicted: live };
}

// the route a hub's supply takes to a cell: [hub ... cell] (for drawing supply lines)
export function supplyRoute(net, cellId) { const p = [cellId]; let k = 0; while (net.via[p[0]] && k++ < 60) p.unshift(net.via[p[0]]); return p; }

// the cells whose loss / interdiction would cut the most supply (chokepoints): used by both AIs to pick MSR targets
export function chokepoints(C, net, n = 4) {
  const count = {};
  for (const id of Object.keys(net.level)) { if (!net.level[id]) continue; let cur = net.via[id], k = 0; while (cur && k++ < 60) { count[cur] = (count[cur] || 0) + 1; cur = net.via[cur]; } }
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, k]) => ({ cell: id, feeds: k }));
}
export { cheb };
