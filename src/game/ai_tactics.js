// Battle-AI v2 support: what the enemy commander knows (Intel — only what its own units have spotted), terrain
// reading (covered approach lanes, firing positions with a field of fire, hull-down spots) and the ?aidebug overlay.
// Used by the Commander in ai.js. Nothing here looks at player units the enemy has not seen.
import * as THREE from 'three';

const POW = { tank: 8, ifv: 6, btr: 4, spg: 2, truck: 0.5 };
export const vehPower = v => (POW[v.kind] ?? 3) * (v.hp > 0 ? Math.max(0.35, v.hp / v.def.hp) : 0) * (v.crew > 0 ? 1 : 0);
export const sqPower = q => q.effective.length * (q.kind === 'atgm' || q.kind === 'fpv' ? 0.8 : 1) * (q.routing ? 0.2 : q.morale < 35 ? 0.6 : 1);

// ------------------------------------------------------------------ intel
// One entry per player unit the enemy side has spotted: last-known position, when, what it looked like. Entries age
// out (a position not re-confirmed for 2 minutes is forgotten); a unit seen destroyed is dropped.
export class Intel {
  constructor(g, side = 'enemy') { this.g = g; this.side = side; this.c = new Map(); this.firstContactT = null; }
  update() {
    const g = this.g, now = g.time;
    for (const u of g.enemiesOf(this.side)) {
      if (u.type === 'squad' && (u.mounted || u.noncombat)) continue;
      if (u.noncombat) continue;
      const sb = u.seenBy?.[this.side];
      if (sb == null || now - sb > 1.5) {
        // not identified, but a contact (game.spotFor tier 1: drone picture, heard firing): its reported position. A unit
        // identified before keeps what it was known to be; a new one is an unknown of modest weight (no type, not armour)
        const c = u.ctc?.[this.side]; if (!c || now - c.t > 1.5 || (u.tierBy?.[this.side] || 0) < 1) continue;
        let e = this.c.get(u);
        if (!e) { e = { u, first: now, contact: true, veh: false, kind: 'unk', armour: false, dug: false, pow: 2.5 }; this.c.set(u, e); this.firstContactT ??= now; }
        e.x = c.x; e.z = c.z; e.t = now;
        continue;
      }
      const p = u.type === 'vehicle' ? u.pos : u.center();
      let e = this.c.get(u); if (e?.contact) e.contact = false;
      if (!e) { e = { u, first: now }; this.c.set(u, e); this.firstContactT ??= now; }
      e.x = p.x; e.z = p.z; e.t = now;
      e.veh = u.type === 'vehicle'; e.kind = e.veh ? u.kind : u.kind === 'atgm' || u.kind === 'fpv' ? u.kind : 'inf';
      e.armour = e.veh && (u.kind === 'tank' || u.kind === 'ifv' || u.kind === 'btr');
      e.dug = !e.veh && !!(u.building || u.trench);
      e.pow = e.veh ? vehPower(u) : sqPower(u) * (e.dug ? 1.6 : 1);
    }
    for (const [u, e] of this.c) if (u.destroyed || now - e.t > 120 || (u.type === 'squad' && !u.effective.length)) this.c.delete(u);
  }
  list(maxAge = 90) { const now = this.g.time, o = []; for (const e of this.c.values()) if (now - e.t <= maxAge) o.push(e); return o; }
  near(x, z, r, maxAge = 90) { return this.list(maxAge).filter(e => Math.hypot(e.x - x, e.z - z) < r); }
  strength(x, z, r, maxAge = 90) { let s = 0; for (const e of this.near(x, z, r, maxAge)) s += e.pow * (1 - 0.4 * Math.min(1, (this.g.time - e.t) / 90)); return s; }
  armour(maxAge = 60) { return this.list(maxAge).filter(e => e.armour); }
  // a known position infantry could fire RPGs from (stand-off for our armour)
  rpgNear(x, z, r) { let n = 0; for (const e of this.near(x, z, r, 30)) if (!e.veh && e.kind === 'inf' && e.u.effective?.some(s => s.weaponKey === 'rpg7' || s.rpg22 > 0)) n++; return n; }
  // the densest known cluster (mortar target): entry with most known power within 35 m
  cluster(maxAge = 25, around = null, R = 1e9) {
    let best = null, bs = 0;
    for (const e of this.list(maxAge)) {
      if (around && Math.hypot(e.x - around[0], e.z - around[1]) > R) continue;
      if (e.veh && e.u.kind === 'tank') continue;   // mortars do little to a tank
      let s = 0; for (const f of this.list(maxAge)) if (Math.hypot(f.x - e.x, f.z - e.z) < 35) s += f.veh ? f.pow * 0.4 : f.pow;
      if (e.dug) s *= 1.2;
      if (s > bs) { bs = s; best = e; }
    }
    return best ? { e: best, score: bs } : null;
  }
}

// ------------------------------------------------------------------ terrain reading
// Is (x,z) covered against a threat at (tx,tz)? Cover from the nav grid (walls, trenches, low walls) or concealment
// (crops, tree lines, orchards) or a smoke screen in between.
export function covered(g, x, z, tx, tz) {
  if (g.nav.coverFrom(x, z, tx, tz) >= 0.5) return 1;
  const cc = g.city.concealAt ? g.city.concealAt.call(g.city, x, z) : 1;
  return cc < 0.6 ? 0.7 : 0;
}
// ------------------------------------------------------------------ concealment (v8)
// How the front moves since 2023 (previews/ai_v8/PROGRESS.md): the sky is full of drones, so men cross open ground as
// little as they can — along tree lines, through ruins and gardens, in trenches and dead ground — in small groups, and halt
// only where a drone can't see them. game.spotFor gives the drone picture of every unit not 'hidden' (game.hiddenSpot:
// buildings, heavy foliage, covered trench bays) within ~700 m of the other side's men, so this matters for both sides.
// concealment of a ground point: 0 = hidden (heavy foliage, trench floor), 0.3 = partial (light foliage / tree belt edge,
// right along a wall or a building), 0.6 = rubble / low cover, 1 = open
export const CONCEAL = { open: 0.9, wall: 0.25, light: 0.35, low: 0.5 };   // extra route cost per metre (nav.findPath opts.conceal)
export function concealOf(g, x, z) {
  const nav = g.nav, k = nav.idx(x, z); if (k < 0) return 1;
  if (nav.trench && nav.trench[k] >= 9) return 0;
  const C = g.city, cc = C.concealAt ? C.concealAt.call(C, x, z) : 1;
  if (cc < 0.45) return 0;
  if (nav.clear[k] < 2.6 && nav.cost[k] !== 255) return 0.3;
  if (cc < 0.6) return 0.35;
  return nav.low[k] ? 0.6 : 1;
}
// the per-cell route cost function for nav.findPath(..., { conceal }) (cached per game)
export function concealCost(g) {
  if (g._aiCC) return g._aiCC;
  const nav = g.nav, C = g.city, ca = C.concealAt;
  return (g._aiCC = k => {
    if (nav.trench && nav.trench[k] >= 9) return 0;
    const cc = ca ? ca.call(C, nav.cx(k), nav.cz(k)) : 1;
    if (cc < 0.45) return 0;
    if (nav.clear[k] < 2.6) return CONCEAL.wall;
    if (cc < 0.6) return CONCEAL.light;
    return nav.low[k] ? CONCEAL.low : CONCEAL.open;
  });
}
// a concealed infantry route (falls back to the plain one when the concealed search does not get there)
// Long routes: the concealed search runs to a sub-goal ~horizon m ahead on the plain route (the most concealed spot near it):
// a bound is at most ~90 m, and a concealed search across the whole map would run out of steps and fall back to the plain one.
export function concealedPath(g, from, to, threat = null, horizon = 230) {
  const nav = g.nav, S = g._aiCCstat ||= [0, 0];
  let goal = to, plain = null;
  if (Math.hypot(to[0] - from[0], to[1] - from[1]) > horizon) {
    plain = nav.findPath(from[0], from[1], to[0], to[1], 0.45, false, 60000);
    if (plain && plain.length) {
      let acc = 0, px = from[0], pz = from[1], q = plain[plain.length - 1];
      for (const [x, z] of plain) { const d = Math.hypot(x - px, z - pz); if (acc + d >= horizon) { const f = (horizon - acc) / (d || 1); q = [px + (x - px) * f, pz + (z - pz) * f]; break; } acc += d; px = x; pz = z; }
      let bs = 1e9; goal = q;
      for (let r = 0; r <= 40; r += 8) for (let a = 0; a < (r ? 10 : 1); a++) { const x = q[0] + Math.cos(a / 10 * 6.283) * r, z = q[1] + Math.sin(a / 10 * 6.283) * r; if (!nav.passable(nav.idx(x, z), 0.5)) continue; const sc = concealOf(g, x, z) + r * 0.008; if (sc < bs) { bs = sc; goal = [x, z]; } }
    }
  }
  let p = nav.findPath(from[0], from[1], goal[0], goal[1], 0.45, false, 60000, threat ? { conceal: concealCost(g), threat } : { conceal: concealCost(g) });
  if (!p || p.length < 1 || Math.hypot(p[p.length - 1][0] - goal[0], p[p.length - 1][1] - goal[1]) > 12) { S[1]++; p = plain || nav.findPath(from[0], from[1], to[0], to[1], 0.45, false, 60000); }
  else S[0]++;
  return p;
}
// mean concealment along a straight line (sampled every 3 m)
export function lineConceal(g, ax, az, bx, bz) {
  const d = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(d / 3)); let s = 0;
  for (let i = 1; i <= n; i++) s += concealOf(g, ax + (bx - ax) * i / n, az + (bz - az) * i / n);
  return s / n;
}
// The next bound along a (concealed) route: the furthest point within maxLen m of route that the squad can reach by its
// own (near-straight) path without leaving the cover the route keeps to, ending if possible in a concealed spot and not
// on top of another squad (dispersion: drones and shells). avoid = [[x, z], ...] friendly squads.
export function nextBound(g, path, from, maxLen, avoid = null) {
  const pts = [[from[0], from[1]], ...path];
  const cand = []; let acc = 0, rc = 0, rn = 0;
  for (let i = 1; i < pts.length && acc < maxLen; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i], L = Math.hypot(bx - ax, bz - az); if (L < 0.01) continue;
    for (let s = Math.min(4, L); ; s += 4) {
      const f = Math.min(1, s / L), x = ax + (bx - ax) * f, z = az + (bz - az) * f, a = acc + L * f;
      if (a > maxLen) break;
      rc += concealOf(g, x, z); rn++;
      cand.push([x, z, a, rc / rn]);
      if (f >= 1) break;
    }
    acc += L;
  }
  if (!cand.length) return { p: pts[pts.length - 1], open: 1 };
  let best = null, bs = -1e9;
  for (const [x, z, a, routeC] of cand) {
    const chord = lineConceal(g, from[0], from[1], x, z);
    if (chord > routeC + 0.15 && a > 12) continue;   // the straight way would leave the tree line / wall the route follows
    const end = concealOf(g, x, z);
    let sc = a / maxLen * 2 - end * 1.2;
    if (avoid) for (const [fx, fz] of avoid) { const d = Math.hypot(fx - x, fz - z); if (d < 22) sc -= (22 - d) * 0.12; }
    if (sc > bs) { bs = sc; best = [x, z, chord]; }
  }
  if (!best) { const c = cand[Math.min(cand.length - 1, 2)]; best = [c[0], c[1], lineConceal(g, from[0], from[1], c[0], c[1])]; }
  return { p: [best[0], best[1]], open: best[2] };
}
// A vehicle hide: within r of `from`, preferably back towards `back` ([dx, dz] unit), out of sight of `tgt` from the turret,
// under tree cover / behind a building. null if nothing better than where it stands.
export function vehicleHide(g, from, tgt, back, r = 60) {
  const nav = g.nav; let best = null, bs = -1e9;
  for (let rr = 12; rr <= r; rr += 12) for (let a = 0; a < 12; a++) {
    const t = a / 12 * 6.283, x = from[0] + Math.sin(t) * rr, z = from[1] + Math.cos(t) * rr, i = nav.idx(x, z);
    if (i < 0 || !(nav.passableV ? nav.passableV(i, 2.0, true) : nav.passable(i, 2.0))) continue;
    const dot = Math.sin(t) * back[0] + Math.cos(t) * back[1];
    const cc = concealOf(g, x, z); let sc = dot * 0.8 - rr * 0.01 - cc * 1.5 + (cc === 0 ? 1.5 : 0);   // under the trees: the drones can't see it (game.hiddenSpot)
    if (tgt && !sees(g, x, z, tgt[0], tgt[1], 2.7, 1.5)) sc += 2;
    if (sc > bs) { bs = sc; best = [x, z]; }
  }
  return best;
}
// sight line between two ground points (eye heights h1, h2)
export function sees(g, ax, az, bx, bz, h1 = 1.6, h2 = 1.4) {
  const y1 = (g.city.groundHeight?.(ax, az) || 0) + h1, y2 = (g.city.groundHeight?.(bx, bz) || 0) + h2;
  return g.combat.los(ax, y1, az, bx, y2, bz, null, null);
}
// Walk an infantry route from -> to and rate it: fraction of the route in cover/concealment from the threat points,
// and how many samples are exposed to a known enemy within 300 m with a sight line.
export function scanLane(g, from, to, threats, objXZ) {
  const path = g.nav.findPath(from[0], from[1], to[0], to[1], 0.45, false, 60000);
  if (!path || path.length < 2) return null;
  const pts = [[from[0], from[1]], ...path];
  let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const N = Math.min(24, Math.max(6, Math.round(len / 15)));
  const T = threats.length ? threats.slice(0, 6).map(e => [e.x, e.z]) : [objXZ];
  let cov = 0, exp = 0, k = 0, acc = 0, seg = 1, sx = pts[0][0], sz = pts[0][1];
  for (let n = 1; n <= N; n++) {
    const want = len * n / (N + 1);
    while (seg < pts.length && acc + Math.hypot(pts[seg][0] - sx, pts[seg][1] - sz) < want) { acc += Math.hypot(pts[seg][0] - sx, pts[seg][1] - sz); sx = pts[seg][0]; sz = pts[seg][1]; seg++; }
    if (seg >= pts.length) break;
    const d = Math.hypot(pts[seg][0] - sx, pts[seg][1] - sz) || 1, f = (want - acc) / d, x = sx + (pts[seg][0] - sx) * f, z = sz + (pts[seg][1] - sz) * f;
    // hidden from every threat point within 320 m: no sight line (buildings, terrain, tree lines), or wall / trench
    // cover, or concealment; the objective itself stands in for the defenders when none are known
    let hid = 1, e = 0;
    for (const [tx, tz] of T) {
      if (Math.hypot(tx - x, tz - z) > 320) continue;
      const cv = covered(g, x, z, tx, tz); if (cv >= 0.5) { hid = Math.min(hid, cv >= 1 ? 1 : 0.8); continue; }
      if (sees(g, tx, tz, x, z, 1.5, 1.2)) { hid = 0; if (threats.length) e++; }
    }
    cov += hid; exp += e; k++;
  }
  return { path, len, cover: k ? cov / k : 0, exposure: exp, samples: k };
}
// Firing position for a squad (h=1.6) or a vehicle (hull-down: turret sees the target at 2.6 m, hull at 1.0 m does not
// / or the cell is in cover): ring of radius [r0,r1] round the target, within +-spread of the bearing `dir` (from the
// target towards our side). Best = sight line on the target + cover against it + close to the preferred radius.
export function firePosition(g, target, dir, r0, r1, spread, vehicle = false, avoid = null) {
  const nav = g.nav, [tx, tz] = target, a0 = Math.atan2(dir[0], dir[1]);
  let best = null, bs = -1e9;
  for (let ri = 0; ri < 4; ri++) for (let ai = 0; ai < 9; ai++) {
    const r = r0 + (r1 - r0) * (ri + 0.5) / 4, a = a0 + spread * (ai / 4 - 1) + (Math.random() - 0.5) * 0.08;
    let x = tx + Math.sin(a) * r, z = tz + Math.cos(a) * r;
    const i = nav.idx(x, z); if (i < 0) continue;
    if (vehicle) { if (!nav.passableV?.(i, 2.0, false) && !nav.passable(i, 2.0)) continue; }
    else if (!nav.passable(i, 0.45)) { const f = nav.nearestFree(x, z, 0.45, 5); if (!f) continue; [x, z] = f; }
    let sc = -Math.abs(ai / 4 - 1) * 0.4 - ri * 0.1;
    if (avoid) for (const [ax, az, ar] of avoid) if (Math.hypot(ax - x, az - z) < ar) sc -= 2;
    if (vehicle) {
      const top = sees(g, x, z, tx, tz, 2.7, 1.2); if (!top) { sc -= 2; } else sc += 2;
      if (top && !sees(g, x, z, tx, tz, 0.9, 1.2)) sc += 1.2;   // hull-down
      if (nav.coverFrom(x, z, tx, tz) >= 0.5) sc += 0.4;
      if (top) sc += (1 - concealOf(g, x, z)) * 0.6;   // v8: at the edge of a tree line / by a building rather than out in the field
    } else {
      const s = sees(g, x, z, tx, tz, 1.5, 1.2); sc += s ? 2 : -1.5;
      sc += covered(g, x, z, tx, tz) * 1.4;
      if (nav.low?.[i]) sc += 0.2;
    }
    if (sc > bs) { bs = sc; best = [x, z]; }
  }
  return best;
}

// ------------------------------------------------------------------ ?aidebug overlay
const ROLE_COL = { recon: 0x5cc8ff, fix: 0xffb347, manoeuvre: 0xff5a4a, reserve: 0xb48cff, garrison: 0x8fd16a, overwatch: 0xffe36a, support: 0xffe36a, occupy: 0x66e0c0, regroup: 0x999999, counter: 0xff3fb0 };
export class AIDebug {
  constructor(cmd) {
    this.cmd = cmd; this.g = cmd.g; this.log = []; this.el = null; this.lines = null;
    if (typeof document !== 'undefined') {
      const el = this.el = document.createElement('pre'); el.id = 'aidebug';
      el.style.cssText = 'position:fixed;right:8px;top:110px;z-index:50;max-width:560px;max-height:70vh;overflow:auto;margin:0;padding:6px 8px;font:11px/1.35 monospace;color:#e8e4d8;background:rgba(10,12,10,.72);border:1px solid #c8483a55;pointer-events:none;white-space:pre-wrap';
      document.body.appendChild(el);
    }
  }
  note(msg) { const s = `[AI ${Math.round(this.g.time)}s] ${msg}`; this.log.push(s); if (this.log.length > 60) this.log.shift(); console.log(s); }
  update() {
    const lines = this.cmd.debugLines();
    window.__aiplan = lines;
    if (this.el) this.el.textContent = lines.join('\n') + '\n— log —\n' + this.log.slice(-10).join('\n');
    if (!this.g.scene) return;
    // intent arrows: unit -> its current destination, coloured by role
    const pos = [], col = [], c = new THREE.Color();
    for (const b of this.cmd.units) {
      if (b.dead || !b.task?.dest) continue; const u = b.v && (!b.sq || b.sq.mounted || b.kind === 'tank') ? b.v : b.sq; if (!u || u.destroyed) continue;
      const p = u.type === 'vehicle' ? u.pos : u.center(), [x, z] = b.task.dest, y = 1.5;
      c.set(ROLE_COL[b.role] || 0xffffff);
      pos.push(p.x, y, p.z, x, y, z); col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      // arrow head
      const a = Math.atan2(x - p.x, z - p.z); for (const s of [-1, 1]) { pos.push(x, y, z, x - Math.sin(a + s * 0.45) * 4, y, z - Math.cos(a + s * 0.45) * 4); col.push(c.r, c.g, c.b, c.r, c.g, c.b); }
    }
    for (const e of this.cmd.intel.list(60)) { c.set(0xff2222); const r = 3; pos.push(e.x - r, 0.6, e.z - r, e.x + r, 0.6, e.z + r, e.x - r, 0.6, e.z + r, e.x + r, 0.6, e.z - r); for (let k = 0; k < 4; k++) col.push(c.r, c.g, c.b); }
    if (!this.lines) {
      this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }));
      this.lines.renderOrder = 10; this.lines.frustumCulled = false; this.g.scene.add(this.lines);
    }
    const G = this.lines.geometry; G.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); G.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); G.computeBoundingSphere();
  }
}
