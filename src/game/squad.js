import * as THREE from 'three';
import { Soldier, clipDuration, hasClip, clipEvents } from './soldier.js';
import { TrenchMixin, trenchMen } from './trench.js';
import { SQUAD_ROLES, ASSAULT_ROLES, CREW_ROLES, ATGM_ROLES, FPV_ROLES, TUNING, WEAPONS } from '../config.js';
import { AtgmTeam, FpvTeam } from './support.js';

let NEXT_ID = 1;
const V = new THREE.Vector3();
// riders jumping off (tools/blender/soldiers/clips_vehicle.py dismount_jump_*): [side edge seats, stern edge seats] per vehicle model,
// each authored against that hull (deck height, edge, what is under the legs); fallback seat offset [y, distance seat -> end root]
const JUMP_CLIPS = {
  btr82a: ['dismount_jump_btr', 'dismount_jump_rear_btr'], btr80_ua: ['dismount_jump_btr', 'dismount_jump_rear_btr'],
  bmp3: ['dismount_jump_bmp3', 'dismount_jump_rear_bmp3'], bradley_ua: ['dismount_jump_bradley', 'dismount_jump_rear_bradley'],
  t72b3: ['dismount_jump_tank', 'dismount_jump_rear_tank'], t72av_ua: ['dismount_jump_tank', 'dismount_jump_rear_tank'],
};
const JUMP_SEAT = { dismount_jump: [1.995, 1.6], dismount_jump_btr: [1.995, 1.6], dismount_jump_tank: [1.415, 1.2] };
function jumpClip(v, rear) {
  const L = JUMP_CLIPS[v.assetKey] || (v.kind === 'tank' ? JUMP_CLIPS.t72b3 : v.kind === 'ifv' ? JUMP_CLIPS.bmp3 : JUMP_CLIPS.btr82a);
  for (const c of [L[rear ? 1 : 0], L[0], v.kind === 'tank' ? 'dismount_jump_tank' : 'dismount_jump']) if (hasClip(c)) return c;
  return 'dismount_jump';
}
// mounting up (tools/blender/soldiers/clips_mount.py mount_deck_*): [side edge seats, stern edge seats] per vehicle model, each authored
// against that hull (footholds, deck edge); the Bradley stern borrows the BTR's (2.0 m deck, rarely used: the squad rides inside)
const MOUNT_CLIPS = {
  btr82a: ['mount_deck_btr', 'mount_deck_rear_btr'], btr80_ua: ['mount_deck_btr', 'mount_deck_rear_btr'],
  bmp3: ['mount_deck_bmp3', 'mount_deck_rear_bmp3'], bradley_ua: ['mount_deck_bradley', 'mount_deck_rear_btr'],
  t72b3: ['mount_deck_t72b3', 'mount_deck_rear_t72b3'], t72av_ua: ['mount_deck_tank', 'mount_deck_rear_tank'],
};
const MOUNT_FALLBACK_S = 10;   // a man who has not started climbing on this long after the order boards the old way (instantly, at the hull)
// hull footprint in the vehicle's own frame (x = left, z = forward; hull meshes only, no gun barrel), cached on the vehicle
export function hullBox(v) {
  if (v._dmBox) return v._dmBox;
  const box = new THREE.Box3(), inv = new THREE.Matrix4(), p = new THREE.Vector3();
  v.root.updateMatrixWorld(true); inv.copy(v.root.matrixWorld).invert();
  (v.hull || v.model).traverse(o => { if (!o.isMesh || /_LOD1$|_wreck$/i.test(o.name) || !o.visible) return; const pa = o.geometry.attributes.position, step = Math.max(1, Math.floor(pa.count / 400)); for (let i = 0; i < pa.count; i += step) box.expandByPoint(p.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld).applyMatrix4(inv)); });
  if (box.isEmpty()) box.set(new THREE.Vector3(-v.def.width / 2, 0, -v.def.length / 2), new THREE.Vector3(v.def.width / 2, 2, v.def.length / 2));
  return v._dmBox = box;
}
const smooth01 = x => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
// a point moved out of the vehicle's real hull footprint (plus margin m) to the nearest side (wounded falling off, landing spots)
function outsideHull(v, x, z, M = 0.35) {
  const B = hullBox(v), sh = Math.sin(v.heading), ch = Math.cos(v.heading), dx = x - v.pos.x, dz = z - v.pos.z;
  let lf = dx * sh + dz * ch, ll = dx * ch - dz * sh;
  const pf = Math.min(lf - (B.min.z - M), B.max.z + M - lf), pl = Math.min(ll - (B.min.x - M), B.max.x + M - ll);
  if (pf <= 0 || pl <= 0) return [x, z];
  if (pl < pf) ll = ll - (B.min.x - M) < B.max.x + M - ll ? B.min.x - M : B.max.x + M; else lf = lf - (B.min.z - M) < B.max.z + M - lf ? B.min.z - M : B.max.z + M;
  return [v.pos.x + lf * sh + ll * ch, v.pos.z + lf * ch - ll * sh];
}

// An infantry squad (8 men). Owns orders, formation, morale and casualty handling.
export class Squad {
  constructor(game, side, faction, name, kind = 'mech', roles = null) {
    this.game = game; this.id = NEXT_ID++; this.side = side; this.faction = faction; this.name = name;
    this.type = 'squad'; this.kind = kind; this.assault = kind === 'assault';
    this.crew = kind === 'crew';
    this.soldiers = (roles || (this.assault ? ASSAULT_ROLES : this.crew ? CREW_ROLES : kind === 'atgm' ? ATGM_ROLES : kind === 'fpv' ? FPV_ROLES : SQUAD_ROLES)).map((r, i) => new Soldier(this, i, r, faction, game.scene));
    this.morale = 82; this.order = null; this.holdFire = false; this.run = false;
    this.carrier = null; this.mounted = false; this.building = null; this.routing = false;
    this.underFireT = 99; this.flankDirs = []; this.selected = false; this.spotted = side === 'player';
    this.tier = side === 'player' ? 2 : 0; if (side !== 'player') for (const s of this.soldiers) s.visible = false;   // enemies start unknown (game.spotFor: tiers)
    this.facing = 0; this.lastPos = new THREE.Vector3(); this.thinkT = Math.random();
    this.stats = { kills: 0, kia: 0, wia: 0 };
    this.supplyRpg = 0;
    this.support = kind === 'atgm' ? new AtgmTeam(this) : kind === 'fpv' ? new FpvTeam(this) : null;
  }
  status() { return this.support?.status(); }
  get alive() { return this.soldiers.filter(s => s.alive); }
  get effective() { return this.soldiers.filter(s => s.effective); }
  get leader() { return this.soldiers.find(s => s.role.leader && s.effective) || this.soldiers.find(s => s.role.second && s.effective) || this.effective[0]; }
  get destroyed() { return this.effective.length === 0; }
  center(out = new THREE.Vector3()) {
    if (this.mounted && this.carrier) return out.copy(this.carrier.pos);
    const e = this.effective.length ? this.effective : this.alive; if (!e.length) return out.copy(this.lastPos);
    out.set(0, 0, 0); for (const s of e) out.add(s.pos); out.multiplyScalar(1 / e.length); this.lastPos.copy(out); return out;
  }
  ammoFrac(arms = false) {   // arms: small arms only (an ATGM / FPV team out of missiles or drones is not out of ammunition)
    const sp = this.support;
    if (sp && !arms) return sp.drones != null ? (sp.drones + (sp.drone ? 1 : 0)) / (sp.capacity?.() || 5) : sp.abandoned ? 0 : (sp.ammo + (sp.loaded ? 1 : 0)) / 5;
    let have = 0, max = 0;
    for (const s of this.effective) { const w = s.weapon; have += s.mags * w.mag + s.inMag; max += (s.role.mags + 1) * w.mag; }
    return max ? have / max : 0;
  }
  moraleState() {
    if (this.routing) return 'ROUTING';
    const m = this.morale; return m >= 60 ? 'STEADY' : m >= 45 ? 'HOLDING' : m >= 25 ? 'SHAKEN' : 'WAVERING';
  }
  // ------------------------------------------------------------ placement & orders
  placeAt(x, z, facing) {
    this.facing = facing;
    const slots = this.formationSlots(x, z, facing, 16);
    this.soldiers.forEach((s, i) => { s.pos.set(slots[i][0], 0, slots[i][1]); s.heading = facing; s.sync(); });
  }
  // cover = { thr: [x, z] | null } (move orders): the men are given real cover positions near their slots against the known
  // enemy (else the order's facing) -- see coverAssign. Without it: the old per-slot snap (deployment, rout, dismount).
  formationSlots(x, z, facing, width, cover = null) {
    const nav = this.game.nav, n = this.effective.length || 8;
    const right = [Math.cos(facing), -Math.sin(facing)], fwd = [Math.sin(facing), Math.cos(facing)];
    const perRank = width < 10 ? Math.ceil(n / 2) : n;
    const sp = Math.max(1.8, Math.min(4.2, width / Math.max(1, perRank - 1)));
    const out = [];
    // the ordered spot is the side of the wall / building they go to: every slot stays on that side - a slot (or a cover cell)
    // that can only be reached through a wall from the ordered spot is pulled back towards it (it used to be snapped to the
    // nearest free cell, which for a slot inside a building could be its far side or the next street)
    const [ax, az] = this.orderAnchor(x, z);
    // ordered up to a building's wall: the men line up along THAT wall (its length, a little past the corners at most), backs to
    // it - the 18 m line used to stick out past the corners of a short end wall and half the squad went round to the next facade
    const W = this.wallAt(ax, az);
    const sameSide = (px, pz) => nav.lineFree(ax, az, px, pz, 0.4) && nav.passableI(nav.idx(px, pz), 0.4) && (!W || W.on(px, pz));   // (passableI: no slot on a parked hull / wreck)
    const pullBack = (px, pz) => { const d = Math.hypot(px - ax, pz - az); for (let f = 1; f > 0; f -= Math.min(0.5, 0.5 / Math.max(1, d))) { const qx = ax + (px - ax) * f, qz = az + (pz - az) * f; if (sameSide(qx, qz)) return [qx, qz]; } return [ax, az]; };
    let wallSlot = null;
    if (W) {
      const cap = Math.max(1, Math.floor((2 * W.half + 2) / 2.1) + 1), per = Math.min(n, cap), gap = Math.min(3, (2 * W.half + 2) / Math.max(1, per - 1));
      const lim = W.half + 1 - (per - 1) * gap / 2, c0 = lim > 0 ? THREE.MathUtils.clamp(W.a0, -lim, lim) : 0;
      wallSlot = i => { const rank = Math.floor(i / per), k = i % per; return W.at(c0 + (k - (per - 1) / 2) * gap + (Math.random() - .5) * 0.5, 0.75 + rank * 1.5 + Math.random() * 0.35); };
    }
    const rnd = cover?.noJitter ? (() => { let q = 11; return () => ((q = (q * 16807) % 2147483647) / 2147483647); })() : Math.random;
    const nominal = [];
    for (let i = 0; i < this.soldiers.length; i++) {
      let px, pz;
      if (wallSlot) [px, pz] = wallSlot(i);
      else {
        // loose, staggered line: alternate men sit forward/back, irregular spacing — never a parade-ground rank
        const rank = Math.floor(i / perRank), k = i % perRank, off = (k - (perRank - 1) / 2) * sp + (rnd() - .5) * sp * 0.45;
        const depth = rank * 3.2 + (k % 2 ? 1.6 : -0.4) + (rnd() - .5) * 1.8;
        px = x + right[0] * off - fwd[0] * depth; pz = z + right[1] * off - fwd[1] * depth;
      }
      if (!sameSide(px, pz)) [px, pz] = pullBack(px, pz);
      nominal.push([px, pz]);
    }
    if (cover) { const k = Math.min(nominal.length, n), sl = this.coverAssign(nominal.slice(0, k), ax, az, W, fwd, cover), cv = sl.cov; sl.push(...nominal.slice(k)); sl.cov = cv; return sl; }
    for (let i = 0; i < this.soldiers.length; i++) {
      const [px, pz] = nominal[i];
      // snap to a nearby cell offering cover toward the facing direction
      let best = null, bestS = -1;
      // next to a wall: line up against it (CQB) rather than standing a metre or two off it
      const ci0 = nav.idx(px, pz), nearWall = ci0 >= 0 && nav.clear[ci0] < 6;
      const R0 = W ? 2.2 : nearWall ? 5 : 3.5;
      for (let r = 0; r <= R0; r += 0.9) for (let a = 0; a < 8; a++) {
        const cx = px + Math.cos(a * 0.785) * r, cz = pz + Math.sin(a * 0.785) * r, idx = nav.idx(cx, cz);
        if (!nav.passableI(idx, 0.4)) continue;
        if (out.some(o => Math.hypot(o[0] - cx, o[1] - cz) < 1.1)) continue;
        if (!nav.lineFree(ax, az, cx, cz, 0.4) || (W && !W.on(cx, cz))) continue;
        const sc = nav.coverFrom(cx, cz, cx + fwd[0] * 50, cz + fwd[1] * 50) * 2 - r * 0.25 + (nearWall && nav.clear[idx] < 1.4 ? 1.1 : 0);
        if (sc > bestS) { bestS = sc; best = [cx, cz]; }
      }
      if (!best) best = [px, pz];
      out.push(best);
    }
    return out;
  }
  // v6: men take real cover near their slots. Every cell within a few metres of each nominal slot (on the ordered side of
  // any wall) is scored by the cover it gives against the threat -- the nearest known enemy, and/or the order's facing --
  // (nav.coverFrom: a wall, wreck, tree trunk, rubble heap, sandbags, fence, crater lip, trench), low cover a bit better
  // (he can fire over it), minus how far it is from the slot; then (slot, cell) pairs are taken best-first, at least
  // 1.4 m apart, so the best spots go to the men whose slots are nearest them instead of the first man in the list.
  // Returns the slots; out.cov[i] = cover value (0..1) of slot i (formation preview).
  coverAssign(nominal, ax, az, W, fwd, cover) {
    const nav = this.game.nav, thr = cover.thr, n = nominal.length;
    const T = []; if (thr) T.push([thr[0], thr[1], 1]);
    T.push([ax + fwd[0] * 60, az + fwd[1] * 60, thr ? 0.35 : 1]);
    const wsum = T.reduce((a, t) => a + t[2], 0);
    const covAt = (cx, cz) => { let c = 0; for (const t of T) c += nav.coverFrom(cx, cz, t[0], t[1]) * t[2]; return c / wsum; };
    const reach = new Map(), ok = k => { let v = reach.get(k); if (v === undefined) { const cx = nav.cx(k), cz = nav.cz(k); v = nav.passableI(k, 0.4) && nav.lineFree(ax, az, cx, cz, 0.4) && (!W || W.on(cx, cz)); reach.set(k, v); } return v; };
    const pairs = [];
    // v9 common sense: the threat side (known enemy, else the order's facing); a cell further toward it than his slot costs (no
    // running forward into the fire for a better wall), one ahead of the ordered line costs a lot, and no cell beyond 12 m of the
    // ordered spot (or his slot + 2 m, for a wide line)
    const tx0 = (thr ? thr[0] : ax + fwd[0]) - ax, tz0 = (thr ? thr[1] : az + fwd[1]) - az, tl = Math.hypot(tx0, tz0) || 1, tdx = tx0 / tl, tdz = tz0 / tl;
    for (let i = 0; i < n; i++) {
      const [px, pz] = nominal[i], ci = nav.idx(px, pz), nearWall = ci >= 0 && nav.clear[ci] < 6, R = W ? 2.6 : nearWall ? 4.5 : 3.6;
      const lim = Math.max(12, Math.hypot(px - ax, pz - az) + 2);
      for (let dz = -R; dz <= R; dz += 1) for (let dx = -R; dx <= R; dx += 1) {
        const r = Math.hypot(dx, dz); if (r > R + 0.01) continue;
        const k = nav.idx(px + dx, pz + dz); if (k < 0 || !ok(k)) continue;
        const cx = nav.cx(k), cz = nav.cz(k), d = Math.hypot(cx - px, cz - pz), c = covAt(cx, cz);
        if (Math.hypot(cx - ax, cz - az) > lim) continue;
        const adv = (cx - px) * tdx + (cz - pz) * tdz, advA = (cx - ax) * tdx + (cz - az) * tdz;
        const sc = c * 3 + (c > 0.5 && nav.low[k] ? 0.3 : 0) - d * 0.4 - Math.max(0, adv - 0.5) * 0.5 - Math.max(0, advA - 2) * 0.8 + (W && nav.clear[k] < 1.4 ? 0.9 : 0) + (!W && nearWall && c > 0.5 && nav.clear[k] < 1.4 ? 0.3 : 0);
        pairs.push(sc, i, cx, cz, c);
      }
    }
    const idx = []; for (let p = 0; p < pairs.length; p += 5) idx.push(p); idx.sort((a, b) => pairs[b] - pairs[a]);
    const out = new Array(n).fill(null), cov = new Array(n).fill(0); let left = n;
    for (const p of idx) {
      if (!left) break;
      const i = pairs[p + 1]; if (out[i]) continue;
      const cx = pairs[p + 2], cz = pairs[p + 3]; if (out.some(o => o && Math.hypot(o[0] - cx, o[1] - cz) < 1.4)) continue;
      out[i] = [cx, cz]; cov[i] = pairs[p + 4]; left--;
    }
    for (let i = 0; i < n; i++) if (!out[i]) out[i] = nominal[i];
    out.cov = cov;
    return out;
  }
  pathOpts() { const t = this.threatPoint(); return t ? { threat: t } : null; }
  // nearest enemy unit this side has seen in the last ~25 s (within 400 m): [x, z] or null (cached for 1 s)
  threatPoint() {
    const g = this.game; if (this._thrT != null && g.time - this._thrT < 1) return this._thrP;
    this._thrT = g.time; const c = this.center(); let best = null, bd = 400;
    for (const u of g.enemiesOf(this.side)) {
      const seen = u.seenBy?.[this.side]; if (seen == null || g.time - seen > 25) continue;
      const p = u.type === 'vehicle' ? u.pos : u.center(); const d = Math.hypot(p.x - c.x, p.z - c.z);
      if (d < bd) { bd = d; best = [p.x, p.z]; }
    }
    return (this._thrP = best);
  }
  // formation preview (input.js right-drag): the positions the men would take, flagged when in cover -> [[x, z, inCover]]
  previewSlots(x, z, facing, width) {
    const sl = this.formationSlots(x, z, facing, width, { thr: this.threatPoint(), noJitter: true });
    return sl.slice(0, Math.max(1, this.effective.length)).map((p, i) => [p[0], p[1], sl.cov[i] >= 0.5]);
  }
  // ---- v6 movement: one shared route for the squad, each man following it at his own lateral offset (a loose double file
  // that narrows to single file through gaps and doors) and then peeling off to his own slot. One A* per order instead of
  // one per man, no men threading eight separate routes through each other, and the route itself is threat-aware.
  planMove(men, thr) {
    const g = this.game; if (!men.length) return;
    const c = new THREE.Vector3(); for (const s of men) c.add(s.pos); c.multiplyScalar(1 / men.length);
    const O = this.order, [ax, az] = O && O.type === 'move' ? this.orderAnchor(O.x, O.z) : men[0].goal;
    const tok = { thr }; const E = { pathReq: null, path: null, tok, men, goals: new Map(men.map(s => [s, s.goal])) };
    for (const s of men) s.shareTok = tok;
    this.shareEnt = E;
    g.requestPath(E, c.x, c.z, ax, az, 0.45, false, thr ? { threat: thr } : null);
  }
  applyShared() {
    const E = this.shareEnt, g = this.game, nav = g.nav; this.shareEnt = null;
    const P = E.path && E.path.length ? E.path : null, opts = E.tok.thr ? { threat: E.tok.thr } : null;
    const men = E.men.filter(s => s.shareTok === E.tok && s.effective && s.goal && s.goal === E.goals.get(s) && !s.pathReq && !s.dragging && !s.inside && !s.cqb && !s.slotRef);
    // lateral rank of each man across the start of the route
    let dx = 0, dz = 1; if (P && P.length > 1) { const a = P[0], b = P[Math.min(2, P.length - 1)]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; dx = (b[0] - a[0]) / L; dz = (b[1] - a[1]) / L; }
    men.sort((a, b) => (a.pos.z * dx - a.pos.x * dz) - (b.pos.z * dx - b.pos.x * dz));   // right to left = the offset's sign (left normal)
    men.forEach((s, i) => {
      s.shareTok = null;
      const off = THREE.MathUtils.clamp((i - (men.length - 1) / 2) * 1.2, -2.4, 2.4) + (Math.random() - 0.5) * 0.4;
      const p = P && this.offsetPath(s, P, off);
      if (p) { s.path = p; s.pathI = 0; s.pathReq = null; this.navN = (this.navN || 0) + 1; }
      else g.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], 0.45, false, opts);
    });
  }
  // the shared route P shifted sideways by off metres (less where the way is narrow), joined from where he stands and ending
  // at his own slot; null if he can't join it in a straight line (he then gets a route of his own)
  offsetPath(s, P, off) {
    const nav = this.game.nav, goal = s.goal, n = P.length;
    if (Math.hypot(s.pos.x - P[0][0], s.pos.z - P[0][1]) > 16) return null;
    const out = []; let px = s.pos.x, pz = s.pos.z;
    for (let j = 1; j < n - 1; j++) {
      const a = P[j - 1], b = P[j], c = P[j + 1];
      let ux = b[0] - a[0], uz = b[1] - a[1], ul = Math.hypot(ux, uz) || 1, vx = c[0] - b[0], vz = c[1] - b[1], vl = Math.hypot(vx, vz) || 1;
      let nx = -(uz / ul + vz / vl), nz = ux / ul + vx / vl; const nl = Math.hypot(nx, nz);
      if (nl < 0.2) { nx = -uz / ul; nz = ux / ul; } else { nx /= nl; nz /= nl; }
      const cosHalf = Math.max(0.7, nx * (-uz / ul) + nz * (ux / ul));   // keep the leg parallel through the bend
      let q = null;
      for (const f of [1, 0.5, 0]) {
        const o = off * f / cosHalf, qx = b[0] + nx * o, qz = b[1] + nz * o, k = nav.idx(qx, qz);
        if (f && (!nav.passable(k, 0.45) || nav.clear[k] < 0.9)) continue;
        if (!nav.lineFree(px, pz, qx, qz, 0.4)) continue;
        q = [qx, qz]; break;
      }
      if (!q) return null;
      out.push(q); px = q[0]; pz = q[1];
      // his slot is nearer than the next bend of the route and in plain view: he leaves the route here
      const dg = Math.hypot(goal[0] - px, goal[1] - pz);
      if (dg < 8 && dg < Math.hypot(c[0] - px, c[1] - pz) && nav.lineFree(px, pz, goal[0], goal[1], 0.4)) break;
    }
    if (!nav.lineFree(px, pz, goal[0], goal[1], 0.4)) {
      const e = P[n - 1];
      if (!nav.lineFree(px, pz, e[0], e[1], 0.4) || !nav.lineFree(e[0], e[1], goal[0], goal[1], 0.4)) return null;
      out.push([e[0], e[1]]);
    }
    out.push([goal[0], goal[1]]);
    // not much longer than the shared route itself from where he stands (else his own A* is better)
    let L = 0, Ls = Math.hypot(P[0][0] - s.pos.x, P[0][1] - s.pos.z) + Math.hypot(goal[0] - P[n - 1][0], goal[1] - P[n - 1][1]);
    for (let j = 1; j < n; j++) Ls += Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]);
    for (let j = 0; j < out.length; j++) L += Math.hypot(out[j][0] - (j ? out[j - 1][0] : s.pos.x), out[j][1] - (j ? out[j - 1][1] : s.pos.z));
    return L > Ls * 1.08 + 2 ? null : out;
  }
  // the building facade a point stands in front of (within 5 m of it, not past its corners): its outward normal and length,
  // at(along, out) -> world point, on(x, z) -> is that point in front of the same facade (between its corners + 1.5 m, 0.3-7 m out)
  wallAt(x, z) {
    const B = this.game.city?.buildings; if (!B) return null;
    let best = null, bd = 5;
    for (const b of B) {
      if (Math.hypot(b.x - x, b.z - z) > Math.max(b.L, b.D) / 2 + 6) continue;
      const [lx, lz] = b.toLocal(x, z), ex = Math.abs(lx) - b.L / 2, ez = Math.abs(lz) - b.D / 2;
      const zf = ez >= ex, d = zf ? ez : ex, lat = zf ? Math.abs(lx) - b.L / 2 : Math.abs(lz) - b.D / 2;
      if (d < -0.5 || d > bd || lat > 1.5) continue;
      bd = d; best = { b, zf, sg: zf ? Math.sign(lz) || 1 : Math.sign(lx) || 1, half: zf ? b.L / 2 : b.D / 2, a0: zf ? lx : lz };
    }
    if (!best) return null;
    const { b, zf, sg, half } = best, face = zf ? b.D / 2 : b.L / 2;
    best.at = (along, out) => { const lx = zf ? along : sg * (face + out), lz = zf ? sg * (face + out) : along; return [b.x + lx * b.cos + lz * b.sin, b.z - lx * b.sin + lz * b.cos]; };
    best.on = (px, pz) => { const [lx, lz] = b.toLocal(px, pz), o = (zf ? lz : lx) * sg - face, al = zf ? lx : lz; return o > 0.3 && o < 7 && Math.abs(al) < half + 1.5; };
    return best;
  }
  // the ordered spot itself, moved out of a wall / building it lies in towards the side the squad comes from
  orderAnchor(x, z) {
    const nav = this.game.nav; if (nav.passableI(nav.idx(x, z), 0.4)) return [x, z];   // (passableI: ordered onto a parked vehicle / wreck -> its near side)
    const c = this.center(), d = Math.hypot(c.x - x, c.z - z);
    if (d > 0.5) for (let k = 0.5; k < Math.min(d, 40); k += 0.5) { const px = x + (c.x - x) / d * k, pz = z + (c.z - z) / d * k; if (nav.passableI(nav.idx(px, pz), 0.4)) return [px, pz]; }
    return nav.nearestFreeI(x, z, 0.4, 8);
  }
  // v9: a human's order comes first (player squads; versus: both sides). Every man busy with a casualty lets go at once - a
  // treatment within 1.5 s of done is finished, a dragged / half-reached man is left where he lies (nobody goes back for him for
  // 8 s) - and nobody is sent for a casualty while he walks the new order (think: helpers). Before v9 the draggers / treaters
  // were left out of the order (orderMove / garrison / trench: `!s.dragging`) and the next think tick could take a freshly
  // ordered man for a casualty: men had to be told twice, or drifted off with the wounded and stayed behind.
  humanCmd() { return this.side === 'player' || !!this.game.opts?.net; }
  takeCommand() {
    if (!this.humanCmd()) return;
    this.cmdT = this.game.time;
    for (const s of this.soldiers) { if (s.dragging) this.releaseCare(s, true); s.goProneT = 0; }
  }
  releaseCare(s, ordered = false) {
    const w = s.dragging; s.dragging = null;
    if (w) {
      if (ordered && s.dragPhase === 'treat' && (s.treatT ?? 9) <= 1.5 && w.state === 'critical') w.state = 'stable';
      if (w.dragger === s) w.dragger = null;
      if (w.dragAssist === s) w.dragAssist = null;
      if (ordered && w.state === 'critical') w.noReachT = Math.max(w.noReachT ?? 0, this.game.time + 8);
      w.vel?.set(0, 0, 0);
    }
    if (s.dragPhase === 'drag' || s.dragPhase === 'reach' || s.dragPhase === 'assist') { s.path = null; s.goal = null; s.pathReq = null; }
    s.dragPhase = null; s.reachT = 0; s.treatT = 0; s.dragTarget = null;
  }
  // v9: stale-state sweep (every think tick): flags left pointing at men / places that no longer apply - they made live men
  // ignore orders or stop following the squad. Counts in this.fixN (debug).
  validateStates() {
    const g = this.game, ob = o => (this.fixN = (this.fixN || 0) + 1, o);
    const crit = w => w && w.state === 'critical';
    for (const s of this.soldiers) {
      const w = s.dragging;
      if (w && (!s.effective || !crit(w) || w.onBed || (w.medevacClaim && w.medevacClaim !== s) || w.squad !== this)) ob(this.releaseCare(s));
      if (s.dragger && s.dragger !== s.medevacClaim && (!s.dragger.alive || s.dragger.dragging !== s)) ob(s.dragger = null);
      if (s.dragAssist && (!s.dragAssist.alive || s.dragAssist.dragging !== s)) ob(s.dragAssist = null);
      const mc = s.medevacClaim; if (mc && (!mc.alive || !mc.squad?.medevac?.medics?.some(m => m.s === mc && m.cas === s))) { ob(s.medevacClaim = null); if (s.dragger === mc) s.dragger = null; }
      if (s.inCab && !this.medevac) ob(s.inCab = false);
      if (!s.effective) { if (s.waitTeam) s.waitTeam = false; continue; }
      if (s.slotRef && (this.building !== s.slotRef.panel?.b || this.order?.type !== 'garrison')) { ob(0); if (s.slotRef.occupant === s) s.slotRef.occupant = null; s.slotRef = null; }
      if (s.inBuilding && !this.building && !s.cqb && !s.houseWalk) { ob(0); const b = s.bld, e = b?.entrances?.length ? b.entrances.reduce((a, q) => (q.distanceToSquared(s.pos) < a.distanceToSquared(s.pos) ? q : a)) : null; if (e) s.pos.set(e.x, 0, e.z); s.inside = null; }
      if (s.waitTeam && (!this.order || this.order.type !== 'move')) ob(s.waitTeam = false);
      // a live man stood idle far from the rest of his squad (left behind after a drag / treatment, a dropped goal): he rejoins
      const busy = s.aboard || s.inBuilding || s.cqb || s.houseWalk || s.cellar || s.cellarMove || s.dmWait != null || s.jumpT > 0 || s.hatchT > 0 || s.hatchWait != null || s.dragging || s.trenchSys || this.building || this.trench || this.mounted || this.support;
      if (busy || s.goal || s.pathReq || (s.path && s.pathI < s.path.length)) { s.strayT = 0; continue; }
      let n = 0, cx = 0, cz = 0; for (const o of this.effective) if (o !== s && !o.aboard) { n++; cx += o.goal ? o.goal[0] : o.pos.x; cz += o.goal ? o.goal[1] : o.pos.z; }
      if (!n) continue; cx /= n; cz /= n;
      if (Math.hypot(s.pos.x - cx, s.pos.z - cz) < 35) { s.strayT = 0; continue; }
      if ((s.strayT = (s.strayT || 0) + 0.5) < 3) continue;
      s.strayT = 0; ob(0); this.rejoinN = (this.rejoinN || 0) + 1;
      const [gx, gz] = g.nav.nearestFreeI(cx + (Math.random() - 0.5) * 6, cz + (Math.random() - 0.5) * 6, 0.45, 8);
      s.goal = [gx, gz]; s.goalHeading = this.facing; g.requestPath(s, s.pos.x, s.pos.z, gx, gz, 0.45, false, this.pathOpts());
    }
  }
  orderMove(x, z, facing = null, width = 18, run = false, queued = false, bound = false) {
    if (this.routing) { if (this.side === 'player') this.game.hud?.alert(`${this.name} is routing — not taking orders until it rallies`, 'bad'); return; }
    this.takeCommand();
    const c = this.center();
    if (facing == null) facing = Math.atan2(x - c.x, z - c.z);
    this.leaveBuilding();
    if (this.mounted && this.carrier) { this.carrier.orderMove(x, z, facing, run); return; }
    this.order = { type: 'move', x, z, facing, width, run };
    this.run = run; this.facing = facing;
    if (this.pinned && this.side === 'player') this.game.hud?.alert(`${this.name} is pinned down — crawling`, 'bad');
    const thr = this.threatPoint();
    const slots = this.formationSlots(x, z, facing, width, { thr });
    // assign slots by lateral order to avoid crossing
    const right = [Math.cos(facing), -Math.sin(facing)];
    const men = this.alive.filter(s => s.effective && !s.dragging);
    const lat = p => p[0] * right[0] + p[1] * right[1];
    const ms = [...men].sort((a, b) => lat([a.pos.x, a.pos.z]) - lat([b.pos.x, b.pos.z]));
    const ss = slots.slice(0, ms.length).sort((a, b) => lat(a) - lat(b));
    const go = [];
    ms.forEach((s, i) => {
      // a re-issued order to about the same place (the AI re-orders): keep walking the old route until the new one is ready
      const keep = s.path && s.pathI < s.path.length && s.goal && Math.hypot(s.goal[0] - ss[i][0], s.goal[1] - ss[i][1]) < 20;
      s.goal = ss[i]; s.goalHeading = facing; if (!keep) s.path = null; s.pathReq = null; s.resumeGoal = false;
      s.crawl = false;   // (a crawl from an earlier dash to cover used to stick: the whole new route was crawled)
      // individual pace and reaction time so the squad doesn't move in lockstep
      s.speedMul = 0.86 + Math.random() * 0.24; s.startDelay = keep ? 0 : s.role.leader ? 0 : 0.15 + Math.random() * 0.9;
      // fire-team bounding: team B (odd) covers and waits until team A has reached its positions
      if (bound && i % 2 === 1 && ms.length > 3) { s.waitTeam = true; s.waitT = 9; }
      else { s.waitTeam = false; go.push(s); }
    });
    this.planMove(go, thr);
  }
  orderGarrison(b) {
    if (this.routing) return;
    // building held by the enemy -> storm it (stack up at an entrance, grenades, room clearing)
    if (b.slots.some(sl => sl.occupant && sl.occupant.squad.side !== this.side && sl.occupant.effective)) return this.orderStorm(b);
    if (this.building === b && this.order?.type === 'garrison' && this.effective.every(s => s.slotRef || s.dragging)) return;   // already in / on the way in (no walking out and back in)
    this.takeCommand();
    if (this.mounted) this.dismount();
    this.leaveBuilding();
    const free = b.slots.filter(sl => !sl.occupant && !sl.panel.gone);
    const men = this.effective.filter(s => !s.dragging);
    if (!free.length) { this.game.hud?.alert(`${b.kind === 'school' ? 'School' : 'Building'} is full`, 'bad'); return; }
    this.order = { type: 'garrison', building: b };
    this.building = b;
    // spread the men round the building for all-round (360 deg) fire, the threatened facade getting a bit more
    const picked = this.spreadSlots(b, free, men.length);
    men.forEach((s, i) => {
      const sl = picked[i]; if (!sl) return;
      sl.occupant = s; s.slotRef = sl;
      const ent = b.entrances.reduce((a, e) => (e.distanceToSquared(s.pos) < a.distanceToSquared(s.pos) ? e : a));
      s.goal = [ent.x, ent.z]; s.goalHeading = null; this.game.requestPath(s, s.pos.x, s.pos.z, ent.x, ent.z, 0.45);
    });
  }
  orderStorm(b) {
    this.takeCommand();
    if (this.mounted) this.dismount();
    this.leaveBuilding();
    const c = this.center();
    const ent = b.entrances.slice().sort((p, q) => p.distanceTo(c) - q.distanceTo(c))[0];
    this.order = { type: 'storm', building: b, entrance: ent, t: 0 };
    const f = Math.atan2(ent.x - c.x, ent.z - c.z);
    this.effective.forEach((s, i) => {
      const side = (i % 2 ? 1 : -1) * (1.2 + (i >> 1) * 0.9); // stack along the wall either side of the door
      const d = b.house && b.doorNear ? b.doorNear(ent) : null, r = d ? d.tan : new THREE.Vector3(Math.cos(b.rot), 0, -Math.sin(b.rot));   // (a house: along the wall of its real door)
      const [gx, gz] = this.game.nav.nearestFree(ent.x + r.x * side, ent.z + r.z * side, 0.4, 6);
      s.goal = [gx, gz]; s.goalHeading = f; this.game.requestPath(s, s.pos.x, s.pos.z, gx, gz, 0.45);
    });
    this.run = true;
    if (this.side === 'player') this.game.hud?.alert(`${this.name}: storming the building`);
  }
  // slots grouped by facade (outward direction in 4 sectors), taken round-robin: threat side, flanks, threat, rear, ...
  spreadSlots(b, free, n) {
    const bucket = [[], [], [], []];
    for (const sl of free) { const o = b.outward(sl.panel); const a = Math.atan2(o.x, o.z); bucket[((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4].push(sl); }
    const score = sl => this.threatScore(b, sl) * 0.2 + (sl.panel.floor >= 1 && sl.panel.floor <= 3 ? 0.3 : 0) - (sl.panel.state >= 2 ? 0.4 : 0) + Math.random() * 0.05;
    for (const k of bucket) k.sort((p, q) => score(q) - score(p));
    const facadeThreat = k => k.length ? k.reduce((a, sl) => a + this.threatScore(b, sl), 0) / k.length : -9;
    const order = [0, 1, 2, 3].sort((p, q) => facadeThreat(bucket[q]) - facadeThreat(bucket[p]));
    const [T, S1, S2, R] = order, cycle = [T, S1, S2, T, R, S1, S2, T];
    const out = [];
    for (let i = 0; out.length < n && i < n * 8 + 8; i++) { const k = bucket[cycle[i % cycle.length]]; if (k.length) out.push(k.shift()); }
    return out;
  }
  threatScore(b, sl) { const o = b.outward(sl.panel); const enemyDir = this.side === 'player' ? -1 : 1; return o.z * enemyDir - sl.panel.floor * 0.1 + (sl.panel.state >= 2 ? -0.5 : 0); }
  leaveBuilding() {
    this.leaveTrench();
    if (!this.building) return;
    const b = this.building;
    const walk = b.house && b.P && this.game.cqb, out = [];   // a house: the men walk out through its door (no pop to the door)
    for (const s of this.soldiers) if (s.cellar || s.cellarMove) { const h = (s.cellar || s.cellarMove.house).cellar.hatch; s.cellar = null; s.cellarMove = null; if (walk || !s.slotRef || !s.inBuilding) s.pos.set(h.x, h.y, h.z); }
    this.inCellar = false;
    for (const s of this.soldiers) {
      const entering = walk && s.cqb?.walk?.b === b && !s.inside;   // still on his way in
      if (s.slotRef) { s.slotRef.occupant = null; s.slotRef = null; }
      if (entering) { s.cqb = null; if (b.contains(s.pos, 0.2) && s.effective) out.push(s); continue; }
      if (!s.inBuilding || s.bld !== b) continue;
      if (walk && s.effective) out.push(s);
      else { const ent = b.entrances.reduce((a, e) => (e.distanceToSquared(s.pos) < a.distanceToSquared(s.pos) ? e : a)); s.pos.set(ent.x, 0, ent.z); }
      s.inside = null;
    }
    if (out.length) { const d = b.doorNear(this.center()); out.sort((p, q) => p.pos.distanceToSquared(d.in) - q.pos.distanceToSquared(d.in)).forEach((s, k) => this.game.cqb.exitWalk(this, s, b, k)); }
    this.building = null;
  }
  orderMount(v) {
    if (this.routing || !v || v.destroyed) return;
    this.leaveBuilding();
    this.order = { type: 'mount', vehicle: v, t0: this.game.time }; this.carrier = v;
    if (v.def.asset === 'bradley_ua') v.doorT = Math.max(v.doorT || 0, this.game.time + 6);
    // v10: seats handed out now (same rules as board), each man walks to his own entry point (beside his seat / at the door) and
    // climbs on there (mountTick); the squad is mounted once every effective man is aboard
    for (const s of this.soldiers) { if (s.mounting) this.mountAbort(s, v); s.mountSeat = null; s.mountE = null; }
    this.seatPlan(v);
    for (const s of this.alive) {
      if (s.state === 'dead' || s.aboard) continue;
      const E = s.mountSeat && (s.mountE = this.mountEntry(s, v)), d = E || v.doorPos(s.idx); s.goal = [d.x, d.z]; this.game.requestPath(s, s.pos.x, s.pos.z, d.x, d.z, 0.45);
    }
  }
  // seats for the men not yet aboard (board's rules: Bradley crews ride inside first, then the deck seats in order, overflow inside;
  // casualties get none - board loads those lying at the hull), leaving seats / room taken by men aboard or already given a place
  seatPlan(v) {
    const seats = v.seatCount(), taken = new Set();
    let room = v.def.asset === 'bradley_ua' ? v.def.passengers : 0;
    for (const s of this.soldiers) {
      if (s.state === 'evac') continue;
      const P = s.aboard ? (s.inside === 'ride' && s.seat ? { inside: 'ride', i: s.seat.i } : { inside: 'btr' }) : s.mountSeat;
      if (!P) continue;
      if (P.inside === 'ride') taken.add(P.i); else if (room > 0) room--;
    }
    let k = 0;
    for (const s of this.soldiers) {
      if (s.state === 'dead' || s.state === 'evac' || s.aboard || s.mountSeat) continue;
      if (s.state === 'critical' || s.state === 'stable') continue;
      if (room > 0) { room--; s.mountSeat = { inside: 'btr' }; continue; }
      while (k < seats && taken.has(k)) k++;
      if (k < seats) { s.mountSeat = { inside: 'ride', i: k }; taken.add(k); k++; } else s.mountSeat = { inside: 'btr' };
    }
  }
  // where he gets on (root of his mount clip, on the ground, hull-relative): deck riders beside their seat (BTR: at the nearest wheel,
  // stern: behind it), the men inside at their door (BTR side doors, BMP-3 rear doors) or the foot of the Bradley ramp.
  // fix = the real seat minus the clip's seat point: slid in while he is up on the deck (events.fix), so other seat rows / hulls fit
  mountEntry(s, v) {
    const P = s.mountSeat, g = this.game; if (!P) return null;
    const gH = (x, z) => (g.city?.groundHeight ? g.city.groundHeight(x, z) : 0);
    const sh = Math.sin(v.heading), ch = Math.cos(v.heading), toW = (lx, lz) => [v.pos.x + lz * sh + lx * ch, v.pos.z + lz * ch - lx * sh];
    v.root.updateMatrixWorld(true);
    const base = { vx: v.pos.x, vz: v.pos.z, vh: v.heading };
    if (P.inside === 'ride') {
      const W = v.seatWorld(P.i), dx = W.pos.x - v.pos.x, dz = W.pos.z - v.pos.z, lx0 = dx * ch - dz * sh, lz0 = dx * sh + dz * ch;
      const rear = Math.cos(W.heading - v.heading) < -0.7, L = MOUNT_CLIPS[v.assetKey], clip = L && L[rear ? 1 : 0];
      if (!clip || !hasClip(clip)) return null;
      const ev = clipEvents(clip), E = ev.end_root_vehicle_xz, SV = ev.seat_vehicle, so = ev.seat_offset_from_root; if (!E || !SV || !so) return null;
      let lx, lz, h;
      if (rear) { lx = ev.fixed_x ? E[0] : lx0 + (E[0] - SV[0]); lz = E[1]; h = v.heading + Math.PI; }
      else {
        const sg = lx0 >= 0 ? 1 : -1; lx = sg * Math.abs(E[0]); h = v.heading + sg * Math.PI / 2;
        lz = ev.stations?.length ? ev.stations.reduce((a, b) => (Math.abs(b - lz0) < Math.abs(a - lz0) ? b : a)) : lz0 + (E[1] - SV[2]);
      }
      const [x, z] = toW(lx, lz), y = gH(x, z), fx = Math.sin(h), fz = Math.cos(h);
      const cx = x + fz * so[0] + fx * so[2], cz = z - fx * so[0] + fz * so[2];   // clip seat point (left = (cos h, -sin h), out = (sin h, cos h))
      const f = ev.fix || [2, 3];
      return { ...base, kind: 'deck', clip, dur: clipDuration(clip, 4), x, z, y, h, seat: P.i, fix: { x: W.pos.x - cx, y: W.pos.y - (y + so[1]), z: W.pos.z - cz, t0: f[0], t1: f[1] } };
    }
    const i = this.soldiers.indexOf(s);
    if (v.def.asset === 'bradley_ua') {   // walks up the lowered ramp into the troop compartment
      const ex = v.model.getObjectByName('exit_rear'); if (!ex) return null;
      const p = ex.getWorldPosition(new THREE.Vector3()), lat = ((i % 3) - 1) * 0.35, h = v.heading;
      const x = p.x + Math.cos(h) * lat - sh * 0.5, z = p.z - Math.sin(h) * lat - ch * 0.5;
      return { ...base, kind: 'ramp', clip: 'crouch_walk', dur: 4.2 / 0.95, x, z, y: gH(x, z), h, fx: sh, fz: ch, bx: p.x, bz: p.z, len: 4.2 };
    }
    if (v.kind === 'btr') {   // side doors: the clip root is the dismount_L / dismount_R empty (as dismount_door's end)
      const de = v.model.getObjectByName(i % 2 ? 'dismount_R' : 'dismount_L'); if (!de || !hasClip('mount_door')) return null;
      const p = de.getWorldPosition(new THREE.Vector3());
      return { ...base, kind: 'door', clip: 'mount_door', dur: clipDuration('mount_door', 2.1), x: p.x, z: p.z, y: gH(p.x, p.z), h: Math.atan2(p.x - v.pos.x, p.z - v.pos.z) };
    }
    const dn = v.model.getObjectByName(i % 2 ? 'door_rear_R' : 'door_rear_L'); if (!dn || !hasClip('mount_rear')) return null;   // IFV rear doors
    const q = dn.getWorldPosition(new THREE.Vector3()), dl = (q.x - v.pos.x) * ch - (q.z - v.pos.z) * sh, dzl = (q.x - v.pos.x) * sh + (q.z - v.pos.z) * ch;
    const thz = clipEvents('mount_rear').threshold_z ?? -0.55, [x, z] = toW(dl * 0.6, dzl + thz);
    return { ...base, kind: 'rear', clip: 'mount_rear', dur: clipDuration('mount_rear', 1.7), x, z, y: gH(x, z), h: v.heading + Math.PI };
  }
  // per frame while the squad's mount order runs, for a man not aboard yet: walk to his entry, play his clip there (root fixed to the
  // vehicle), aboard at its end. The vehicle moving / dying mid-clip: he drops off (mountAbort). Returns true when the frame is done
  mountTick(s, dt) {
    const v = this.order.vehicle, g = this.game;
    if (!s.effective) { if (s.mounting) this.mountAbort(s, v); s.mountE = null; return false; }
    let E = s.mountE;
    if (s.mounting) {
      const moved = v.destroyed || Math.hypot(v.pos.x - E.vx, v.pos.z - E.vz) > 0.25 || Math.abs(angDiff(v.heading, E.vh)) > 0.05;
      if (moved) { this.mountAbort(s, v); return false; }
      const t = g.time - s.mountT0, M = s.mountFix, k0 = 1 - smooth01(t / M.T);
      if (E.kind === 'ramp') {   // crouched, up the ramp (0.62 m at its hinge, 1.9 m in) and on into the hull
        const d = Math.min(E.len, t * 0.95), x = E.x + E.fx * d, z = E.z + E.fz * d, along = (x - E.bx) * E.fx + (z - E.bz) * E.fz;
        s.pos.set(x + M.x * k0, Math.max(E.y, 0.62 * THREE.MathUtils.clamp(along / 1.9, 0, 1)), z + M.z * k0); s.heading = E.h;
      } else {
        const F = E.fix, k1 = F ? smooth01((t * (s.jumpTs || 1) - F.t0) / Math.max(0.1, F.t1 - F.t0)) : 0;   /* (fix window in clip time: the clip plays at s.jumpTs) */
        s.pos.set(E.x + M.x * k0 + (F ? F.x * k1 : 0), E.y + M.y * k0 + (F ? F.y * k1 : 0), E.z + M.z * k0 + (F ? F.z * k1 : 0)); s.heading = E.h;
      }
      if (s.jumpT <= 0) this.boardOne(s, v);
      return false;   // (jumpT > 0: moveStep stands still, no turning / combat, the clip plays)
    }
    // walking to his entry: the vehicle has moved since it was planned -> a new entry (and route)
    if (E && (E.stale || Math.hypot(v.pos.x - E.vx, v.pos.z - E.vz) > 1 || Math.abs(angDiff(v.heading, E.vh)) > 0.1) && Math.abs(v.speed) < 0.3 && g.time > (s.mountReT ?? 0)) {
      s.mountReT = g.time + 1; E = s.mountE = this.mountEntry(s, v);
      if (E) { s.goal = [E.x, E.z]; g.requestPath(s, s.pos.x, s.pos.z, E.x, E.z, 0.45); }
    }
    const late = g.time - (this.order.t0 ?? g.time) > MOUNT_FALLBACK_S, near = s.pos.distanceTo(v.pos) < v.def.radius + 3;
    if (!E) { if (near && (late || !s.mountSeat || !(s.path && s.pathI < s.path.length))) this.boardOne(s, v); return false; }   // no clip for this seat / hull: as before
    if (Math.abs(v.speed) > 0.3) return false;
    const d = Math.hypot(s.pos.x - E.x, s.pos.z - E.z), walking = (s.path && s.pathI < s.path.length) || s.pathReq;
    // (the entry is often in a cell the parked hull blocks: the route ends short of it - the rest is slid while the clip starts)
    if (d < 0.3 || (d < 3 && !walking)) {
      // one at a time per entry (BTR: two seats share a wheel; doors)
      if (this.soldiers.some(o => o !== s && o.mounting && o.mountE && Math.hypot(o.mountE.x - E.x, o.mountE.z - E.z) < 0.6)) { if (late) this.boardOne(s, v); return false; }
      this.mountStart(s, v, E); return false;
    }
    if (late && (near || d < 3)) { this.boardOne(s, v); return false; }
    if (!walking && g.time > (s.mountPathT ?? 0)) { s.mountPathT = g.time + 1.5; s.goal = [E.x, E.z]; g.requestPath(s, s.pos.x, s.pos.z, E.x, E.z, 0.45); }   // (route lost / given up: asks again)
    return false;
  }
  mountStart(s, v, E) {
    const g = this.game;
    if (s.dragging) { this.evacuate(s.dragging); s.dragging = null; }   // (as the old boarding did for a dragger reaching the hull)
    s.mounting = true; s.mountT0 = g.time; s.path = null; s.goal = null; s.pathReq = null; s.target = null; s.vel.set(0, 0, 0); s.stance = 'stand';
    s.mountFix = { x: s.pos.x - E.x, y: s.pos.y - E.y, z: s.pos.z - E.z, T: Math.max(0.3, Math.hypot(s.pos.x - E.x, s.pos.z - E.z) / 1.4) };   // (the rest of the way to the entry: slid at a walk while the clip starts)
    // mount v6: the deck climbs are authored at 7-8 s, a careful man in full kit; under fire they dragged (owner: 'overly slow') -
    // played at ~1.6x (4.5-5 s, each man still at his own pace), the door / stern entries at 1.25x
    const rate = E.kind === 'ramp' ? 1 : (/^mount_deck/.test(E.clip || '') ? 1.6 : 1.25) * (0.94 + Math.random() * 0.12);
    s.jumpClip = E.clip; s.jumpTs = rate; s.jumpT = E.dur / rate; s.jumpFix = null; s.heading = E.h;
    if (E.kind === 'rear' || E.kind === 'ramp') v.doorT = Math.max(v.doorT || 0, g.time + E.dur + 1.5);
    if (s.mixer && E.kind !== 'ramp') { s.play(E.clip, 0, rate, ['crouch_idle']); }
    s.sync();
  }
  // off the hull again (vehicle moved / knocked out, hit, order changed): back on the ground beside it, where he was
  mountAbort(s, v) {
    const g = this.game, onHull = s.mounting && s.mountE && g.time - s.mountT0 > 0.5;
    s.mounting = false; s.jumpT = 0; s.jumpTs = 1; s.mountFix = null;
    if (onHull && v) { const [fx, fz] = outsideHull(v, s.pos.x, s.pos.z, 0.4); s.pos.set(fx, g.city?.groundHeight ? g.city.groundHeight(fx, fz) : 0, fz); }
    if (s.mountE && v && !v.destroyed) s.mountE.stale = true;   // (re-planned when the vehicle has stopped)
  }
  // one man aboard (his planned seat / inside): the end of his mount clip, the fallback, or board() for everyone at once
  boardOne(s, v, instant = true) {
    const P = s.mountSeat || { inside: 'btr' };
    if (P.inside === 'ride') { s.inside = 'ride'; s.seat = { i: P.i }; s.seatType = v.seatType(P.i); } else s.inside = 'btr';
    s.path = null; s.goal = null; s.target = null; s.mounting = false; s.mountFix = null; s.mountE = null; s.mountSeat = null; s.jumpT = 0; s.jumpTs = 1;
    if (s.dragging) this.releaseCare(s);
    if (instant) { const w = v.seatWorld(s.seat ? s.seat.i : 0); s.pos.copy(w.pos); s.heading = w.heading; }
  }
  dismount(facing) {
    const v = this.carrier; if (!v || !this.mounted) return;
    this.mounted = false; v.passengers = null;
    if (!v.destroyed && Math.abs(v.speed) > 0.5) v.halt();
    facing ??= v.heading;
    // riders on the deck all jump off together, each from his own seat on the side he faces (stern row off the back), a few tenths
    // of a second apart; the men inside get out through the doors one after another once the jumpers are clear of the doors
    const riders = this.soldiers.filter(s => s.state !== 'evac' && s.inside === 'ride' && s.seat);
    const rearRiders = riders.some(s => Math.cos(v.seatWorld(s.seat.i).heading - v.heading) < -0.7);
    // the jump clip starts from ride_sit_edge facing out from the seat: a man who was aiming from the deck (ride_aim, turned to his
    // target) or sat on the deck first settles into that pose (0.3 s cross-fade, turning back to the seat heading) before he goes
    for (const s of riders) { s.target = null; s.dmWait = (s.curName === 'ride_sit_edge' ? 0.05 : 0.4) + Math.random() * 0.3; s.dmKind = 'jump'; s.dmVeh = v; s.dmSeat = s.seat.i; s.seatOver = null; s.deckWalk = null; }
    // orders given while they are still getting off (move, garrison, ...) set new goals: exitCarrier keeps those
    for (const s of this.soldiers) if (s.aboard) { s.goal = null; s.path = null; s.pathReq = null; }
    // BTR side doors are under the side riders' landing spots; IFV rear doors / ramp swing through the stern riders' landing spots
    const clear = !riders.length ? 0 : v.kind === 'btr' ? 2.6 : v.kind === 'ifv' && rearRiders ? 2.2 : 0;
    let k = 0;
    this.soldiers.forEach((s, i) => {
      if (s.state === 'evac' || s.inside !== 'btr') return;
      s.dmWait = clear + (v.kind === 'ifv' ? (v.def.asset === 'bradley_ua' ? 1.9 : 1.0) : 0.4) + k * 0.55 + Math.random() * 0.2; s.dmKind = 'door'; s.dmVeh = v; s.dmI = i; k++;
    });
    this.dmDoor = k ? { v, at: this.game.time + clear, until: this.game.time + clear + 1.6 + k * 0.6 + 2.5 } : null;   // IFV rear doors / ramp open only if men are inside
    if (this.dmDoor && !clear) { v.doorT = Math.max(v.doorT || 0, this.dmDoor.until); this.dmDoor = null; }
    this.order = null; this.dmFacing = facing;
    this.game.sfx('hatch', v.pos);
  }
  // free ground for a jumper to land on beside vehicle v (no wall, no other vehicle)
  landingOk(v, x, z) {
    const g = this.game, nav = g.nav; if (!nav.passable(nav.idx(x, z), 0.45)) return false;
    for (const o of g.vehicles) if (o !== v && (!o.destroyed || o.wreck) && Math.hypot(o.pos.x - x, o.pos.z - z) < o.def.radius + 0.9) return false;
    return true;
  }
  // one man leaving the carrier (called when his turn comes)
  exitCarrier(s) {
    const v = s.dmVeh, g = this.game; s.dmWait = null;
    if (!v) { s.inside = null; s.seat = null; return; }
    const gH = (x, z) => (g.city?.groundHeight ? g.city.groundHeight(x, z) : 0);
    this.dmLastExit = g.time;
    // dead / badly wounded men don't jump: the body slides off the deck beside the hull (a corpse drops from deck height:
    // Soldier.deathTick / the ragdoll), a casualty inside is pulled out of the door
    if (!s.effective) {
      s.jumpT = 0; s.jumpFix = null;
      if (s.state !== 'dead') {
        const ride = !!s.seat, w = ride ? v.seatWorld(s.seat.i).pos : v.doorPos(s.dmI ?? 0, true), [fx, fz] = outsideHull(v, w.x, w.z, 0.4 + Math.random() * 0.4), gy = gH(fx, fz);
        s.pos.set(fx, gy, fz);
        // off the deck: he slumps down beside the hull over ~0.4 s (jumpFix offset fading from the seat to the ground) - no pop
        if (ride) { s.jumpT = 0.45; s.jumpFix = { x: fx, y: gy, z: fz, ox: w.x - fx, oy: w.y - gy, oz: w.z - fz, t0: g.time, T: 0.45 }; s.pos.set(w.x, w.y, w.z); }
      }
      s.inside = null; s.seat = null; s.dmVeh = null; s.vel.set(0, 0, 0); s.sync(); return;
    }
    if (s.dmKind === 'jump' && s.seat) {
      // the clip's root is its END point (on the ground, facing away from the hull); its frame 0 is ride_sit_edge with the seat point at
      // events.seat_offset_from_root. Root = seat + that distance along the seat heading, at the ground height there: he lands exactly
      // on the root and walks off from it. The (small) rest between the actual seat (deck height of this hull / seat row, terrain) and
      // the clip's seat is an offset on the root that fades out while he slides to the edge, before he leaves the deck.
      const w = s.seatOver || v.seatWorld(s.seat.i); const out = new THREE.Vector3(Math.sin(w.heading), 0, Math.cos(w.heading));
      const side = new THREE.Vector3(w.pos.x - v.pos.x, 0, w.pos.z - v.pos.z); if (!s.seatOver && side.lengthSq() > 0.01 && out.dot(side) < 0) out.negate();
      const rear = Math.cos(Math.atan2(out.x, out.z) - v.heading) < -0.7, clip = jumpClip(v, rear), ev = clipEvents(clip);
      const so = ev.seat_offset_from_root || [0, ...(JUMP_SEAT[clip] || [1.995, 1.6]).map((x, j) => j ? -x : x)];
      const dist = -so[2], nav = g.nav;
      // parked against a wall / another vehicle: jump a little shorter (the flight is compressed), or off diagonally along the hull
      // edge (the root stays seat + jump along the jump direction, so frame 0 still matches the seat), or - no room on his side at
      // all - cross the deck and jump off the other side. (Snapping the landing to the nearest free cell made the seated man slide up
      // to 3 m along the deck before the jump and leave the deck in mid-air.)
      const plan = (W, h0) => {
        for (const d of [dist, dist - 0.3, dist - 0.6]) for (const da of [0, 0.35, -0.35, 0.65, -0.65]) {
          if (d < 0.9) continue;
          const h = h0 + da, x = W.pos.x + Math.sin(h) * d, z = W.pos.z + Math.cos(h) * d, [bx, bz] = outsideHull(v, x, z, 0.15);
          if (Math.hypot(bx - x, bz - z) > 0.05 || !this.landingOk(v, x, z)) continue;   // (not on the hull itself)
          return { h, d, x, z };
        }
        return null;
      };
      let P = plan(w, Math.atan2(out.x, out.z));
      if (!P && !s.seatOver) {
        const fx = Math.sin(v.heading), fz = Math.cos(v.heading), lx = fz, lz = -fx, dx = w.pos.x - v.pos.x, dz = w.pos.z - v.pos.z, al = dx * fx + dz * fz, la = dx * lx + dz * lz;
        if (Math.abs(la) > 0.6) {
          const m = { pos: new THREE.Vector3(v.pos.x + fx * al - lx * la, w.pos.y, v.pos.z + fz * al - lz * la), heading: Math.atan2(-lx * Math.sign(la), -lz * Math.sign(la)) };
          if (plan(m, m.heading)) { s.seatOver = m; s.dmVeh = v; s.dmKind = 'jump'; s.dmWait = 0; s.deckWalk = { x0: w.pos.x, z0: w.pos.z, x1: m.pos.x, z1: m.pos.z, y: w.pos.y, t: 0, T: Math.max(1, Math.hypot(m.pos.x - w.pos.x, m.pos.z - w.pos.z) / 1.1) }; return; }
        }
      }
      let rx, rz;
      if (P) { out.set(Math.sin(P.h), 0, Math.cos(P.h)); rx = P.x; rz = P.z; }
      else [rx, rz] = nav.nearestFree(w.pos.x + out.x * dist, w.pos.z + out.z * dist, 0.45, 3);
      const gy = gH(rx, rz), d = P ? P.d : dist;
      s.heading = Math.atan2(out.x, out.z);
      // clip seat point in the world for a root at the full jump distance; the shortfall (dist - d) is the flight part of the offset
      const fx = out.x * (dist - d), fz = out.z * (dist - d), sx = rx + fx - out.x * dist + out.z * so[0], sz = rz + fz - out.z * dist - out.x * so[0];
      s.jumpFix = { x: rx, y: gy, z: rz, ox: w.pos.x - sx, oy: w.pos.y - (gy + so[1]), oz: w.pos.z - sz, fx, fz, t0: g.time, T: Math.max(0.3, (ev.leave_seat || 0.9) - 0.05), T1: ev.leave_seat || 0.9, T2: ev.land || 1.45 };
      s.seatOver = null;
      s.pos.set(rx + s.jumpFix.ox + fx, gy + s.jumpFix.oy, rz + s.jumpFix.oz + fz);
      s.jumpClip = clip; s.jumpT = clipDuration(clip, 2.2);
      s.inside = null; s.seat = null; s.vel.set(0, 0, 0);
      s.vehFrom = v; s.vehFromT = g.time + s.jumpT + 2.5;
      // the root jumped from the seat to the landing point: switch to frame 0 of the clip at once (no cross-fade from the seated pose)
      if (s.mixer) { s.play(clip, 0, 1, ['dismount_jump', 'crouch_idle']); s.mixer.update(0); }
      s.sync();
    } else if (!v.rampDoorExit?.(s)) {   // (a knocked-out Bradley: through the door in the ramp, vehicle.js)
      const d = v.doorPos(s.dmI ?? 0, true); s.pos.set(d.x, gH(d.x, d.z), d.z); s.inside = null; s.seat = null;
      const rear = v.kind !== 'btr', ramp = v.def.asset === 'bradley_ua';   // the Bradley ramp is a slope: they just walk down it
      s.heading = rear ? v.heading + Math.PI : v.heading + ((s.dmI ?? 0) % 2 ? 1.57 : -1.57);
      // BTR side doors: the clip's end root is exactly the dismount_L / dismount_R empty
      const de = !rear && v.model.getObjectByName((s.dmI ?? 0) % 2 ? 'dismount_R' : 'dismount_L');
      if (de && (s.dmI ?? 0) < 2) { v.root.updateMatrixWorld(true); const p = de.getWorldPosition(new THREE.Vector3()); s.pos.set(p.x, gH(p.x, p.z), p.z); s.heading = Math.atan2(p.x - v.pos.x, p.z - v.pos.z); }
      const clip = ramp ? null : rear ? (hasClip('dismount_rear') ? 'dismount_rear' : null) : hasClip('dismount_door') ? 'dismount_door' : null;
      if (clip) { s.jumpClip = clip; s.jumpT = clipDuration(clip, 1.4); }
    }
    s.dmVeh = null; s.startDelay = 0;   // (an order's reaction delay is spent sitting on the deck)
    // an order given while he was still aboard (move, garrison, attack...) stands; otherwise he forms up behind the carrier
    let sl = s.goal;
    if (!sl) {
      const back = v.pos.clone().addScaledVector(new THREE.Vector3(Math.sin(v.heading), 0, Math.cos(v.heading)), -6);
      const slots = this.dmSlots && g.time - this.dmSlots.t < 4 && this.dmSlots.v === v ? this.dmSlots.s : (this.dmSlots = { v, t: g.time, s: this.formationSlots(back.x, back.z, this.dmFacing ?? v.heading, 18) }).s, i = this.soldiers.indexOf(s);
      sl = slots[i % slots.length]; s.goal = sl; s.goalHeading = this.dmFacing ?? v.heading;
    }
    // Bradley: he starts inside the troop compartment and walks out down the lowered ramp
    const ex = v.def.asset === 'bradley_ua' && s.dmKind !== 'jump' && !s.jumpFix && v.model.getObjectByName('exit_rear');
    if (ex) {
      v.root.updateMatrixWorld(true);
      const E = ex.getWorldPosition(new THREE.Vector3()), f = new THREE.Vector3(Math.sin(v.heading), 0, Math.cos(v.heading)), r = new THREE.Vector3(f.z, 0, -f.x), lat = (((s.dmI ?? 0) % 3) - 1) * 0.35;
      const at = k => [E.x + f.x * k + r.x * lat, E.z + f.z * k + r.z * lat];
      const inside = at(3.4); s.pos.set(inside[0], 0.62, inside[1]); s.heading = v.heading + Math.PI;
      s.rampWalk = { bx: E.x, bz: E.z, fx: f.x, fz: f.z, y0: 0.62, len: 1.9 };
      s.path = [at(1.9), at(0), at(-1.6)]; s.pathI = 0; s.pathReq = null; s.speedMul = 0.8; s.stance = 'crouch';   // the route on to his goal: groundY, once off the ramp
      return;
    }
    s.pathDelay = s.jumpT || 0; g.requestPath(s, s.pos.x, s.pos.z, sl[0], sl[1], 0.45);
  }
  // ride on top of the vehicle (tank/BTR desant). Overflow rides inside.
  board(v, instant = false) {
    // Bradley crews ride inside (overflow on the deck); BMP-3 / BTR desant sits on top, as Russian crews do for mines (seatPlan)
    for (const s of this.soldiers) if (s.mounting) this.mountAbort(s, v);
    this.seatPlan(v);
    for (const s of this.soldiers) {
      if (s.state === 'dead' || s.state === 'evac' || s.aboard) continue;
      // casualties: only those lying at the hull are loaded; one further off stays for a mate's drag or the medevac
      // (mounting used to lift every wounded man on the map into the carrier at once)
      if (s.state === 'critical' || s.state === 'stable') { if (s.pos.distanceTo(v.pos) < v.def.radius + 3) this.evacuate(s); continue; }
      this.boardOne(s, v, instant);   // (v9: no drag flag carried aboard - he resumed the drag on dismount)
    }
    for (const s of this.soldiers) { s.mountSeat = null; s.mountE = null; }
    this.mounted = true; this.carrier = v; v.passengers = this; this.order = null;
  }
  orderAttack(target) {
    if (this.routing) return;
    // enemy dug into a trench: clear it (work down it from one end, grenades round the bends and into the dugouts)
    if (target.type === 'squad') { const T = target.trench || target.order?.trench || target.soldiers.find(s => s.trenchSys)?.trenchSys; if (T && trenchMen(this.game, T, target.side).length) return this.orderClearTrench(T); }
    this.takeCommand();
    this.order = { type: 'attack', target };
    const tc = target.center ? target.center() : target.pos;
    const c = this.center(); const d = c.distanceTo(tc);
    const range = 160;
    if (d > range) { const p = c.clone().lerp(tc, 1 - range * 0.85 / d); this.orderMove(p.x, p.z, Math.atan2(tc.x - p.x, tc.z - p.z), 18, this.run); this.order.attack = target; }
    this.focus = target;
  }
  halt() { this.leaveTrench(); this.order = null; this.fireAt = null; for (const s of this.alive) { s.path = null; s.pathReq = null; s.goal = null; } }   // (pathReq: a route still queued would be installed after the halt)
  // ------------------------------------------------------------ cellar (private houses, world/houses.js)
  // the men at the windows climb down the hatch: no firing, nothing seen, shells and drones barely reach them; up again to fight
  toCellar() {
    const b = this.building; if (!b?.cellar) return false;
    let n = 0;
    for (const s of this.effective) if (s.inBuilding && s.bld === b && !s.cellar && !s.cellarMove) { const h = b.cellar.hatch; s.cellarMove = { t: -Math.random() * 0.8, T: 0.9 + s.pos.distanceTo(h) / 2.2, a: s.pos.clone(), b: h.clone(), down: true, house: b }; s.target = null; n++; }
    if (n) { this.inCellar = true; if (this.side === 'player') this.game.hud?.alert(`${this.name}: down into the cellar`); }
    return n > 0;
  }
  fromCellar() {
    let n = 0;
    for (const s of this.soldiers) {
      if (!s.cellar || !s.effective) continue;
      const b = s.cellar, h = b.cellar.hatch; s.cellar = null; s.pos.set(h.x, h.y, h.z);
      const sl = s.inBuilding ? s.inside : null; const to = sl ? b.slotPos(sl, new THREE.Vector3()) : h.clone();
      s.cellarMove = { t: -Math.random() * 0.6, T: 0.7 + h.distanceTo(to) / 2.2, a: h.clone(), b: to, down: false, house: b }; n++;
    }
    this.inCellar = false; if (n && this.side === 'player') this.game.hud?.alert(`${this.name}: up from the cellar, back at the windows`);
    return n > 0;
  }
  toggleCellar() { if (!this.building?.house) return false; return this.soldiers.some(s => s.cellar || s.cellarMove?.down) ? this.fromCellar() : this.toCellar(); }
  cellarStep(s, dt) {
    const M = s.cellarMove; M.t += dt; const k = Math.max(0, Math.min(1, M.t / M.T));
    s.pos.lerpVectors(M.a, M.b, k); s.stance = 'crouch';
    s.vel.subVectors(M.b, M.a).setY(0); const L = s.vel.length(); if (L > 0.01 && k > 0 && k < 1) s.vel.multiplyScalar(1.6 / L); else s.vel.set(0, 0, 0);
    if (k >= 1) {
      s.cellarMove = null; s.vel.set(0, 0, 0);
      if (M.down) { s.cellar = M.house; s.pos.set(M.b.x, M.house.cellar.y, M.b.z); }
      else if (s.inBuilding) { const o = s.bld.outward(s.inside.panel); s.heading = Math.atan2(o.x, o.z); }
    }
  }
  // computer-run squads in a house: into the cellar under shelling / a drone overhead, back up when infantry closes in
  cellarThink() {
    const g = this.game, b = this.building, c = b.cellar.hatch;
    if (this.side === 'player' || g.opts.net) return;
    const shelled = g.time - (b.shelledT ?? -99) < 10;
    let drone = false; for (const q of g.squads) { const d = q.support?.drone; if (d && q.side !== this.side && d.phase !== 'launch' && Math.hypot(d.pos.x - c.x, d.pos.z - c.z) < 90) { drone = true; break; } }
    let foe = 1e9; for (const q of g.squads) if (q.side !== this.side && !q.destroyed && !q.mounted) for (const s of q.effective) foe = Math.min(foe, Math.hypot(s.pos.x - c.x, s.pos.z - c.z));
    const down = this.soldiers.some(s => s.cellar || s.cellarMove?.down);
    if (!down && (shelled || drone) && foe > 55) this.toCellar();
    else if (down && (foe < 45 || (!shelled && !drone && g.time - (b.shelledT ?? -99) > 18))) this.fromCellar();
  }
  // ------------------------------------------------------------ morale
  addMorale(d, why) { if (this.destroyed) return; this.morale = THREE.MathUtils.clamp(this.morale + d, 0, 100); }
  onCasualty(s, killed) {
    this.addMorale(killed ? -9 : -6);
    if (s.role.leader) { this.addMorale(-14); if (this.side === 'player') this.game.hud?.alert(`${this.name}: squad leader ${killed ? 'killed' : 'down'}`, 'bad'); }
    // nearby friendly squads feel it too
    for (const o of this.game.unitsOf(this.side)) if (o !== this && o.type === 'squad' && o.center().distanceTo(s.pos) < 40) o.addMorale(-2.5);
    if (killed) this.stats.kia++; else this.stats.wia++;
  }
  updateMorale(dt) {
    const e = this.effective; if (!e.length) return;
    let supp = 0; for (const s of e) supp += s.suppression; supp /= e.length;
    this.underFireT += dt;
    let d = 0;
    d -= supp * TUNING.moraleSuppDrain;
    if (this.ammoFrac(true) < 0.15) d -= 0.6;
    if (this.flankDirs.length >= 2) { const a = this.flankDirs; let spread = 0; for (let i = 1; i < a.length; i++) { let x = Math.abs(a[i] - a[0]) % (Math.PI * 2); if (x > Math.PI) x = Math.PI * 2 - x; spread = Math.max(spread, x); } if (spread > 1.6) d -= 0.9; }
    this.flankDirs.length = 0;
    // PINNED: sustained heavy fire on most of the squad
    let heavy = 0; for (const s of e) if (s.suppression > 60) heavy++;
    if (!this.pinned && (supp > 60 || heavy >= Math.ceil(e.length * 0.7)) && !this.mounted) { this.pinned = true; if (this.side === 'player') this.game.hud?.alert(`${this.name} is PINNED DOWN`, 'bad'); }
    else if (this.pinned && supp < 32 && heavy <= Math.floor(e.length * 0.3)) this.pinned = false;
    if (this.mounted) this.pinned = false;
    if (this.underFireT > 6) {
      let r = TUNING.moraleRegen * (this.leader?.role.leader ? 1.4 : 1) * (1 + (this.game.mods?.[this.side]?.morale || 0)) * (1 + (this.vet || 0) * 0.1);
      if (this.building) r += 0.5;
      const c = this.center();
      for (const u of this.game.unitsOf(this.side)) if (u.type === 'vehicle' && !u.destroyed && u.pos.distanceTo(c) < 30) { r += 0.6; break; }
      for (const o of this.game.objectives) if (o.owner === this.side && Math.hypot(o.x - c.x, o.z - c.z) < 30) r += 0.4;
      d += r;
    }
    // local odds
    if (e.length <= 3) d -= 0.5;
    this.morale = THREE.MathUtils.clamp(this.morale + d * dt, 0, 100);
    // breaking point: a rout check every few seconds rather than an automatic rout - a leader on his feet, walls / a trench
    // around them and experience let a shaken squad hang on (morale nudged back above the line) instead of running
    if (!this.routing && this.morale < TUNING.routThreshold) {
      if ((this.routCheckT = (this.routCheckT || 0) - dt) <= 0) {
        this.routCheckT = 3;
        const hold = TUNING.routHold.base + (this.leader?.role.leader && this.leader.effective ? TUNING.routHold.leader : 0) + (this.building || this.trench ? TUNING.routHold.cover : 0) + (this.vet || 0) * 0.04;
        if (Math.random() < hold) { this.morale = TUNING.routThreshold + 5; this.routHeld = (this.routHeld || 0) + 1; }
        // v7: broken under fire in a trench / building and not overrun: running would be across the open into the fire - they
        // cower in the trench / below the sills instead (pinned, morale held at the line) and may run once the fire lifts
        else if ((this.trench || this.building) && this.underFireT < 8 && !this.overrunNear(20)) { this.morale = TUNING.routThreshold + 3; this.pinned = true; this.cowered = (this.cowered || 0) + 1; }
        else this.startRout();
      }
    }
    else if (this.routing && this.morale > 42 && this.underFireT > 8) { this.routing = false; this.order = null; this.morale = 45; if (this.side === 'player') this.game.hud?.alert(`${this.name} has rallied`, 'good'); }
  }
  overrunNear(r) { const c = this.center(); for (const q of this.game.squads) if (q.side !== this.side && !q.destroyed && !q.mounted) for (const e of q.effective) if (!e.aboard && Math.hypot(e.pos.x - c.x, e.pos.z - c.z) < r) return true; return false; }
  startRout() {
    this.routing = true; this.leaveBuilding();
    if (this.side === 'player') { this.game.hud?.alert(`${this.name} is ROUTING!`, 'bad'); this.game.sfx('ui_alert'); }
    for (const o of this.game.unitsOf(this.side)) if (o !== this && o.type === 'squad' && o.center().distanceTo(this.center()) < 45) o.addMorale(-6);
    // riding on a carrier's deck: they jump off and run (men inside a closed hull stay in it); the run starts once all are down
    if (this.mounted && this.carrier && this.soldiers.some(s => s.inside === 'ride')) { this.dismount(); this.routDeferred = true; this.order = { type: 'rout' }; return; }
    this.routMove();
  }
  routMove() {
    const sp = this.game.rallyPoint(this.side);
    const c = this.center(); const f = Math.atan2(c.x - sp[0], c.z - sp[1]);
    const slots = this.formationSlots(sp[0], sp[1], f, 14);
    this.effective.forEach((s, i) => { s.goal = slots[i]; s.goalHeading = f; this.game.requestPath(s, s.pos.x, s.pos.z, slots[i][0], slots[i][1], 0.45); });
    this.order = { type: 'rout' };
  }
  // ------------------------------------------------------------ per-frame
  update(dt) {
    if (this.medevac) { this.flankDirs.length = 0; return this.medevac.updateCrew(dt); }   // medevac pickup crew: driven by its truck (game/medevac.js); (flankDirs: emptied by updateMorale, which the crew never runs)
    if (this.routDeferred && !this.soldiers.some(s => s.alive && (s.aboard || s.dmWait != null || s.jumpT > 0))) { this.routDeferred = false; if (this.routing) this.routMove(); }
    this.support?.update(dt);
    if (this.mounted) { this.updateRiders(dt); this.updateMorale(dt); this.resupplyTick(dt); return; }
    this.updateMorale(dt);
    if (this.dmHold) this.dmHoldTick();
    this.thinkT -= dt;
    if (this.thinkT <= 0) { this.thinkT = 0.5; this.think(); }
    if (this.shareEnt && !this.shareEnt.pathReq) this.applyShared();   // the squad's shared route has been computed
    if (this.order?.type === 'clear') this.clearTick(dt);
    if (this.order?.type === 'storm') this.game.cqb?.tick(this, dt);   // room-by-room clearing (cqb.js)
    else if (this.order?.type !== 'garrison' && this.soldiers.some(s => s.cqb && s.effective)) this.game.cqb?.exitAll(this);   // order changed mid-clearing: out by the door
    for (const s of this.soldiers) this.updateSoldier(s, dt);
    this.resupplyTick(dt);
  }
  // the carrier's move order given while riders were still jumping off: carried out once the last one has left the deck
  dmHoldTick() {
    const H = this.dmHold, v = H.v;
    if (v.destroyed || this.mounted || v.path || v.pathReq) { this.dmHold = null; return; }
    if (this.soldiers.some(s => s.dmWait != null)) return;
    if (this.game.time - (this.dmLastExit ?? -99) < 1.1) return;
    this.dmHold = null; v.orderMove(H.x, H.z, H.facing, H.fast);
  }
  updateRiders(dt, frozen = false) {
    const v = this.carrier, g = this.game;
    for (const s of this.soldiers) {
      s.suppression = Math.max(0, s.suppression - TUNING.suppressionDecay * dt);
      if (s.inside === 'btr' || s.state === 'evac') { if (v) s.pos.copy(v.pos); s.sync(); continue; }
      if (s.inside === 'ride' && v) {
        if (!s.effective) { // hit while riding: falls off the vehicle
          const w = v.seatWorld(s.seat.i); s.inside = null; s.seat = null;
          const [fx, fz] = outsideHull(v, w.pos.x + (Math.random() - .5) * 3, w.pos.z + (Math.random() - .5) * 3, 0.3 + Math.random() * 0.5);   // never inside the hull
          s.pos.set(fx, g.city?.groundHeight ? g.city.groundHeight(fx, fz) : 0, fz);
        } else {
          const w = v.seatWorld(s.seat.i); s.pos.copy(w.pos); s.heading = s.target ? Math.atan2(s.target.pos.x - s.pos.x, s.target.pos.z - s.pos.z) : w.heading;
          s.vel.set(Math.sin(v.heading) * v.speed, 0, Math.cos(v.heading) * v.speed); s.stance = 'crouch';
          if (!frozen && !this.routing && !this.holdFire) g.combat.soldierCombat(s, dt); else s.target = null;
        }
      }
      if (s.inside === 'ride') { s.animate(dt, g.camDist(s.pos)); s.sync(); }
      else this.updateSoldier(s, dt);
    }
    // whole squad jumps off when the vehicle is knocked out (on fire: vehicle.update bails them out at once, game.bailOut - some hurt)
    if (!frozen && v && v.destroyed) this.dismount(v.heading + Math.PI);
    this.underFireT += dt;
  }
  // a man aboard while his squad is still mounting up (updateRiders' per-man part): on his seat, carried along, fights from the deck
  rideTick(s, dt) {
    const v = this.carrier, g = this.game;
    s.suppression = Math.max(0, s.suppression - TUNING.suppressionDecay * dt);
    if (s.inside === 'btr') { if (v) s.pos.copy(v.pos); s.sync(); return; }
    if (!s.effective) {   // hit while sitting there: falls off the vehicle
      const w = v.seatWorld(s.seat.i); s.inside = null; s.seat = null;
      const [fx, fz] = outsideHull(v, w.pos.x + (Math.random() - .5) * 3, w.pos.z + (Math.random() - .5) * 3, 0.3 + Math.random() * 0.5);
      s.pos.set(fx, g.city?.groundHeight ? g.city.groundHeight(fx, fz) : 0, fz); s.sync(); return;
    }
    const w = v.seatWorld(s.seat.i); s.pos.copy(w.pos); s.heading = s.target ? Math.atan2(s.target.pos.x - s.pos.x, s.target.pos.z - s.pos.z) : w.heading;
    s.vel.set(Math.sin(v.heading) * v.speed, 0, Math.cos(v.heading) * v.speed); s.stance = 'crouch';
    if (!this.routing && !this.holdFire) g.combat.soldierCombat(s, dt); else s.target = null;
    s.animate(dt, g.camDist(s.pos)); s.sync();
  }
  // v7: a man with somewhere to go but no route (no path found - pathFail -, or the path dropped by an interruption and never
  // asked again) stood still for good: the v6 watchdog only watches men who are walking a path. After 1.5 s idle he asks
  // again; then from a cell 1 m clear to the nearest free cell at his goal; then the goal is dropped (he rejoins his squad's
  // next order). (Not: inside, aboard, clearing rooms, cellars, waiting on his fire team / his turn to dismount, dragging.)
  idleGoalWatch() {
    const g = this.game, nav = g.nav;
    for (const s of this.effective) {
      const busy = s.inside || s.cqb || s.houseWalk || s.cellar || s.cellarMove || s.dmWait != null || s.jumpT > 0 || s.hatchT > 0 || s.hatchWait != null || s.waitTeam || s.dragging || s.rampWalk || s.deckWalk;
      if (busy || !s.goal || s.pathReq || (s.path && s.pathI < s.path.length) || Math.hypot(s.pos.x - s.goal[0], s.pos.z - s.goal[1]) < 1.6) { s.idleGoalT = 0; if (!s.goal) s.goalRetry = 0; continue; }
      if ((s.idleGoalT = (s.idleGoalT || 0) + 0.5) < 1.5) continue;
      s.idleGoalT = 0; s.goalRetry = (s.goalRetry || 0) + 1; this.idleRetries = (this.idleRetries || 0) + 1;
      if (s.goalRetry <= 2) g.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], s.goalRetry === 1 ? 0.45 : 0.4, false, this.pathOpts?.());
      else if (s.goalRetry <= 4) {
        const [sx, sz] = nav.nearestFreeI(s.pos.x, s.pos.z, 0.6, 4), [gx, gz] = nav.nearestFreeI(s.goal[0], s.goal[1], 0.5, 8);   // (I: a goal on a parked hull / wreck moves beside it)
        s.goal = [gx, gz];
        if (Math.hypot(sx - s.pos.x, sz - s.pos.z) > 0.3 && nav.lineFree(s.pos.x, s.pos.z, sx, sz, 0.3)) { s.path = [[sx, sz]]; s.pathI = 0; s.resumeGoal = true; }
        else g.requestPath(s, s.pos.x, s.pos.z, gx, gz, 0.4);
      } else { s.goal = null; s.goalRetry = 0; this.idleDrops = (this.idleDrops || 0) + 1; }
    }
  }
  think() {
    this.validateStates();
    this.idleGoalWatch();
    // fire teams: release the covering half once the moving half has arrived
    const waiting = this.soldiers.filter(s => s.waitTeam && s.effective);
    if (waiting.length) {
      const movers = this.effective.filter(s => !s.waitTeam && s.path && s.pathI < s.path.length);
      for (const s of waiting) { s.waitT -= 0.5; if (!movers.length || s.waitT <= 0) { s.waitTeam = false; if (s.goal) this.game.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], 0.45); } }
    }
    // storming a building
    if (this.order?.type === 'storm') this.game.combat.stormTick(this, 0.5);
    // mounting completion
    if (this.order?.type === 'mount') {
      const v = this.order.vehicle;
      // knocked out while they were getting on: the order ends; anyone already aboard gets off again (updateSoldier: exitCarrier)
      if (!v || v.destroyed) { this.order = null; for (const s of this.soldiers) { if (s.mounting) this.mountAbort(s, v); s.mountE = null; s.mountSeat = null; } return; }
      for (const s of this.alive) if (s.state !== 'dead' && !s.aboard && !s.mounting && s.pos.distanceTo(v.pos) < v.def.radius + 3) {
        if (s.dragging) { this.evacuate(s.dragging); s.dragging = null; }
      }
      // (a man without a place yet - back on his feet after the order: a seat now)
      if (this.effective.some(s => !s.aboard && !s.mountSeat)) { this.seatPlan(v); for (const s of this.effective) if (!s.aboard && s.mountSeat && !s.mountE && !s.mounting) { s.mountE = this.mountEntry(s, v); if (s.mountE) { s.goal = [s.mountE.x, s.mountE.z]; this.game.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], 0.45); } } }
      // mounted once every effective man is aboard (board: casualties lying at the hull loaded, the squad rides)
      if (this.effective.every(s => s.aboard)) {
        this.board(v, true);
        if (this.side === 'player') this.game.sfx('hatch', v.pos);
      }
    }
    // pending wounded -> assign a buddy to drag them to cover / the carrier. "Care under fire": win the firefight
    // first - a man only goes for a casualty when he himself is not under direct fire and the casualty is not lying in
    // a known enemy's line of fire; otherwise he keeps fighting from cover and the casualty waits
    if (!this.routing) for (const w of this.soldiers) {
      if (w.state !== 'critical' || (w.noReachT ?? 0) > this.game.time) continue;
      // one man goes for him; a second one close by joins in for a two-man drag (faster), never more than two
      const onIt = this.effective.filter(s => s.dragging === w);
      // hit at a window / clearing a house / down in a cellar: no drag across the floors -- a mate in the same house
      // patches him up where he lies (he is carried out with the others when the squad leaves: leaveBuilding)
      if (w.inBuilding || w.cqb || w.cellar || w.cellarMove) {
        const m = !onIt.length && w.inBuilding && this.effective.find(s => !s.dragging && s.inBuilding && s.bld === w.bld && !s.cqb && !s.cellar);
        if (m) { m.dragging = w; m.dragPhase = 'treat'; m.treatT = (7 + Math.random() * 4) * (1 - Math.min(0.6, this.game.mods?.[this.side]?.medTreat || 0)); w.dragger = m; }
        continue;
      }
      if (onIt.length >= 2 || (onIt.length && onIt[0].dragPhase === 'treat') || (w.dragger && !onIt.length)) continue;
      // (v9, human squads: not a man walking the player's order - nor for 4 s after it - he goes where he was sent)
      const fresh = this.humanCmd() && this.game.time - (this.cmdT ?? -99) < 4, onOrder = s => this.humanCmd() && (fresh || s.pathReq || s.shareTok || s.waitTeam || (s.path && s.pathI < s.path.length));
      const helpers = this.effective.filter(s => !s.dragging && !s.inside && !s.cqb && !(this.order?.cqb?.file?.includes(s)) && !onOrder(s) && this.safeToHelp(s) && (!onIt.length || s.pos.distanceTo(w.pos) < 20));   // (not the men clearing a building)
      if (!helpers.length) { if (onIt.length) continue; break; }
      if (this.casualtyExposed(w)) continue;
      helpers.sort((a, b) => (b.role.medic ? 20 : 0) - (a.role.medic ? 20 : 0) + a.pos.distanceTo(w.pos) - b.pos.distanceTo(w.pos));
      const h = helpers[0]; if (h.pos.distanceTo(w.pos) > 60) continue;
      h.dragging = w; h.dragPhase = 'reach'; h.goal = [w.pos.x, w.pos.z]; this.game.requestPath(h, h.pos.x, h.pos.z, w.pos.x, w.pos.z, 0.45);
    }
    // a man on his way to a casualty who comes under fire himself goes to ground and fights; someone retries later
    for (const h of this.effective) if (h.dragging && h.dragPhase === 'reach' && !this.safeToHelp(h, 40)) {
      h.dragging = null; h.dragPhase = null; h.path = null; h.goal = null; h.stance = 'prone'; h.goProneT = this.game.time + 4;
    }
    this.seekCover();
    // stance from situation
    // an ATGM team with the launcher out kneels round it (support.js keeps the crew crouched every frame): no stand-up here, or
    // the loader / bearer bob up for one frame every think tick (idle_rifle <-> crouch_idle cross-fades: 'constantly squatting')
    const kneelTeam = this.support && this.support.state && this.support.state !== 'packed' && !this.support.abandoned;
    for (const s of this.effective) {
      if (s.aboard) continue;
      if (s.rampWalk) { s.stance = 'crouch'; continue; }   // bent double through the low troop compartment and down the ramp
      if (kneelTeam) { s.stance = (s.suppression > 70 || this.pinned) && !s.supportClip && !(s.path && s.pathI < s.path.length) ? 'prone' : 'crouch'; continue; }
      if ((s.droneHideT ?? 0) > this.game.time && !s.droneShooter) { s.stance = s.inBuilding || (s.path && s.pathI < s.path.length) ? 'crouch' : 'prone'; continue; }   // FPV about: down (support.js reactions)
      if (s.inBuilding) { s.stance = s.suppression > 45 || (this.underFireT < 2 && !s.target) ? 'crouch' : 'stand'; continue; }   // v7: up at the window watching (seen / seeing), down below the sill under fire
      const moving = s.path && s.pathI < s.path.length;
      if (!moving && (s.goProneT ?? 0) > this.game.time) { s.stance = 'prone'; continue; }   // (gave up going for a casualty under fire: stays down)
      // v5: a man already down who has to move while still under fire crawls (creeping to cover, or a bound while suppressed)
      // instead of popping up into a crouch-walk after the first metre; he gets up (prone_up) once it eases
      if (moving && s.stance === 'prone' && !this.run && !this.routing && ((s.crawl && (s.suppression > 25 || this.pinned)) || s.suppression > 50)) s.stance = 'prone';
      else if (moving) s.stance = (this.underFireT < 3 && !this.run && !this.routing) || (s.trenchSys && this.game.nav.trench?.[this.game.nav.idx(s.pos.x, s.pos.z)]) ? 'crouch' : 'stand';   // (along a trench: bent double below the lip)
      else {
        const threat = s.target ? s.target.pos : null;
        const cov = threat ? this.game.nav.coverFrom(s.pos.x, s.pos.z, threat.x, threat.z) : 0;
        const lowc = this.game.nav.low[this.game.nav.idx(s.pos.x, s.pos.z)] === 1;
        if ((s.suppression > 70 || this.pinned) && cov < 0.5 && !lowc) s.stance = 'prone';
        else if (s.suppression > 70 || this.pinned) s.stance = 'crouch';
        else if (cov > 0.5) s.stance = lowc ? 'crouch' : (s.weaponKey === 'rpg7' ? 'stand' : 'crouch');
        else if (this.underFireT < 4) s.stance = s.weaponKey === 'pkm' ? 'prone' : 'crouch';
        else s.stance = s.weaponKey === 'pkm' && s.target ? 'prone' : 'stand';
      }
    }
    if (this.trench) this.trenchThink();
    if (this.building?.cellar) this.cellarThink();
  }
  // individual initiative: a man caught in the open while his squad is halted and taking fire scrambles to the
  // nearest real cover against his target (a few metres, never far from where he was ordered)
  seekCover() {
    if (this.mounted || this.routing || this.building || this.trench || this.order?.type === 'storm' || this.order?.type === 'mount' || this.order?.type === 'clear') return;
    if (this.underFireT > 2.5) return;
    const nav = this.game.nav, now = this.game.time;
    for (const s of this.effective) {
      if (s.inside || s.dragging || (s.path && s.pathI < s.path.length) || s.pathReq || s.waitTeam || !s.target || (s.coverT || 0) > now) continue;
      const tp = s.target.pos; if (nav.coverFrom(s.pos.x, s.pos.z, tp.x, tp.z) >= 0.55) continue;
      s.coverT = now + 7 + Math.random() * 4;
      const ax = s.goal ? s.goal[0] : s.pos.x, az = s.goal ? s.goal[1] : s.pos.z, W = this.wallAt(ax, az);
      // v9: within 5 m of his slot and 12 m of the ordered spot, not further toward his target than he is (it was 9 m round the
      // slot in any direction: up to ~20 m from where he was sent, sometimes forward into the fire)
      const O = this.order?.type === 'move' ? this.order : null, tl = Math.hypot(tp.x - s.pos.x, tp.z - s.pos.z) || 1;
      let best = null, bs = 0.5;
      for (let r = 1; r <= 5; r += 1) for (let a = 0; a < 12; a++) {
        const x = ax + Math.cos(a / 12 * 6.283) * r, z = az + Math.sin(a / 12 * 6.283) * r, i = nav.idx(x, z);
        if (!nav.passable(i, 0.45)) continue;
        // only on his side of the wall he was sent to: never round the corner / through the building to its far side
        if (!nav.lineFree(ax, az, x, z, 0.4) || !nav.lineFree(s.pos.x, s.pos.z, x, z, 0.4) || (W && !W.on(x, z))) continue;
        if (this.soldiers.some(o => o !== s && o.alive && Math.hypot(o.pos.x - x, o.pos.z - z) < 1.3)) continue;
        if (O && Math.hypot(x - O.x, z - O.z) > 12) continue;
        const adv = ((x - s.pos.x) * (tp.x - s.pos.x) + (z - s.pos.z) * (tp.z - s.pos.z)) / tl; if (adv > 1.5) continue;
        const sc = nav.coverFrom(x, z, tp.x, tp.z) - Math.hypot(x - s.pos.x, z - s.pos.z) * 0.06 - Math.max(0, adv) * 0.1;
        if (sc > bs) { bs = sc; best = [x, z]; }
      }
      if (best) { s.goal = best; this.game.requestPath(s, s.pos.x, s.pos.z, best[0], best[1], 0.45); }
    }
  }
  evacuate(s) { s.state = 'evac'; s.root.visible = false; s.inside = 'btr'; this.game.stats[this.side].evac++; if (s.dragger) { s.dragger.dragging = null; s.dragger = null; } }
  abandonWounded(s) { /* left on the field; keeps bleeding */ }
  resupplyTick(dt) {
    const v = this.carrier && !this.carrier.destroyed ? this.carrier : null; if (!v || !v.supply) return;
    const near = this.mounted || this.center().distanceTo(v.pos) < 25; if (!near) return;
    this.resupT = (this.resupT || 0) + dt; if (this.resupT < 1.2) return; this.resupT = 0;
    // every rifle (AK-74M, optic AK-74, AK-12), the PKM and the RPG-7 -- also while a grenadier has his rifle out (his
    // rockets are in origWeapon then, the rifle magazines in mags)
    const give = (key, has, max) => {
      if (has >= max) return 0; const t = WEAPONS[key]?.type;
      if (t === 'rifle' && v.supply.rifle >= 30) { v.supply.rifle -= 30; return 1; }
      if (t === 'mg' && v.supply.mg >= 100) { v.supply.mg -= 100; return 1; }
      if (key === 'rpg7' && v.supply.rpg > 0) { v.supply.rpg--; return 1; }
      return 0;
    };
    for (const s of this.effective) {
      const o = s.origWeapon;
      if (o) { o.mags += give(o.key, o.mags, s.role.mags); s.mags += give(s.weaponKey, s.mags, s.role.sideMags || 0); }
      else { s.mags += give(s.weaponKey, s.mags, s.role.mags); if (s.sideKey) s.sideMags += give(s.sideKey, s.sideMags, s.role.sideMags || 0); }
    }
  }
  updateSoldier(s, dt) {
    const g = this.game;
    if (s.hatchWait != null) { s.hatchWait -= dt; if (s.hatchWait <= 0) { s.hatchWait = null; s.inside = null; s.hatchOpen?.(); s.hatchOpen = null; s.hatchT = clipDuration(s.hatchClip || 'hatch_exit', 2.7); g.sfx('hatch', s.pos); } else { s.sync(); return; } }
    // mounting up (v10): aboard already while the rest are still getting on -> rides like a mounted squad's rider; on the way to / climbing
    // on at his entry -> mountTick. Order changed meanwhile: off the hull again (aboard: exitCarrier below)
    const mountOn = this.order?.type === 'mount' && this.order.vehicle === this.carrier && !this.mounted;
    if (s.mounting && !mountOn) this.mountAbort(s, this.carrier);
    if (mountOn) {
      if (!s.aboard && (s.mountSeat || s.mountE || s.mounting)) this.mountTick(s, dt);
      if (s.aboard && s.state !== 'evac') { this.rideTick(s, dt); return; }
    }
    // waiting for his turn to get off the carrier: stays on his seat (riders, carried along) or inside
    if (s.dmWait != null) {
      const v = s.dmVeh || (s.dmVeh = this.carrier);
      if (!v) { s.dmWait = null; if (s.aboard && s.state !== 'evac') { s.inside = null; s.seat = null; } }
      else {
        // jumpers wait until the carrier has (nearly) stopped: the landing point is fixed on the ground when he leaves the seat. A
        // fresh move order for the carrier while men are still on the deck is held back until they are off (dmHoldTick), so it
        // never drives off with them sitting on it (they used to ride along, no longer part of a mounted squad, unable to get off)
        // (doors too: nobody steps out of a hull that is still rolling)
        if (!v.destroyed && (v.path || v.pathReq)) { if (v.order?.type === 'move') this.dmHold = { v, x: v.order.x, z: v.order.z, facing: v.order.facing, fast: v.fast }; v.halt(); v.pathReq = null; }
        if (v.destroyed || Math.abs(v.speed) <= 0.3) s.dmWait -= dt;
        if (this.dmDoor && g.time >= this.dmDoor.at) { this.dmDoor.v.doorT = Math.max(this.dmDoor.v.doorT || 0, this.dmDoor.until); this.dmDoor = null; }
        let settled = true;
        if (s.deckWalk) {   // no room to jump off on his side: crouched, he crosses the deck to the other edge, sits down there, jumps
          const D = s.deckWalk; D.t = Math.min(D.T, D.t + dt); const f = D.t / D.T, dx = D.x1 - D.x0, dz = D.z1 - D.z0;
          s.pos.set(D.x0 + dx * f, D.y, D.z0 + dz * f); s.heading += THREE.MathUtils.clamp(angDiff(Math.atan2(dx, dz), s.heading), -8 * dt, 8 * dt);
          s.vel.set(dx / D.T, 0, dz / D.T); s.stance = 'crouch'; s.target = null; s.animate(dt, g.camDist(s.pos)); s.vel.set(0, 0, 0);
          if (D.t >= D.T) { s.deckWalk = null; s.dmWait = 0.45; } else { s.sync(); return; }
        }
        if (s.inside === 'ride' && s.seat) {   // turn back to the seat heading (from ride_aim) before the jump clip takes over
          const w = s.seatOver || v.seatWorld(s.seat.i), dh = angDiff(w.heading, s.heading); s.pos.copy(w.pos); s.heading += THREE.MathUtils.clamp(dh, -7 * dt, 7 * dt); settled = Math.abs(dh) < 0.12;
          s.target = null; s.vel.set(0, 0, 0); s.animate(dt, g.camDist(s.pos));
        }
        else if (s.inside === 'btr') s.pos.copy(v.pos);
        if ((s.dmWait <= 0 && settled) || (v.destroyed && v.rampDoorAt == null && (settled || s.dmWait < -0.6))) this.exitCarrier(s);   // (Bradley ramp door: one at a time, vehicle.knockOut)
        else { s.sync(); return; }
      }
    }
    // still aboard although the squad is not mounted and nobody is getting him off (should not happen): off he gets
    if (s.aboard && s.state !== 'evac' && !s.lostInVeh && !this.mounted && s.hatchWait == null && s.dmWait == null) {
      const v = this.carrier; if (v) { s.dmVeh = v; s.dmKind = s.inside === 'ride' && s.seat ? 'jump' : 'door'; s.dmI = this.soldiers.indexOf(s); this.exitCarrier(s); } else { s.inside = null; s.seat = null; }
    }
    // jumping off the carrier: the root stays on the landing point (the clip carries him there); the seat-match offset fades out
    if (s.jumpFix) {
      // seat-match offset: fades while he slides to the edge; the flight part (a shortened jump: little room beside the hull) fades
      // while he is in the air, between leaving the deck and landing - he simply jumps less far
      const J = s.jumpFix, k = 1 - smooth01((g.time - J.t0) / J.T), kf = J.fx || J.fz ? 1 - smooth01((g.time - J.t0 - J.T1) / Math.max(0.1, J.T2 - J.T1)) : 0;
      if (s.jumpT > 0 && s.state !== 'dead') s.pos.set(J.x + J.ox * k + (J.fx || 0) * kf, J.y + J.oy * k, J.z + J.oz * k + (J.fz || 0) * kf); else s.jumpFix = null;   // (jumpT cut to 0 = placed elsewhere)
    }
    s.suppression = Math.max(0, s.suppression - TUNING.suppressionDecay * dt * (s.inBuilding ? 1.4 : 1));
    // heavily suppressed: duck behind the wall / window sill, pop up for a burst, duck again
    if (s.suppression > 55 || this.pinned) {
      s.duckT = (s.duckT ?? 0) - dt;
      if (s.duckT <= 0) { s.ducking = !s.ducking; s.duckT = s.ducking ? 1.2 + s.suppression / 35 + Math.random() * 1.5 : 0.8 + Math.random() * 0.9; }
      if (s.suppression > 92) s.ducking = true;
    } else s.ducking = false;
    if (s.state === 'dead' || s.state === 'evac') { s.vel.set(0, 0, 0); s.animate(dt, g.camDist(s.pos)); s.sync(); return; }
    if (s.aboard) { s.sync(); return; }
    // bleeding
    if (s.state === 'critical') {
      s.bleed -= dt * (s.dragger && s.dragger.dragPhase === 'treat' ? 0.25 : 1);
      if (s.bleed <= 0) { s.die('death_crumple'); g.onDeath(s, null, true); }
      if (!s.dragger && s.vel.lengthSq() < 0.01 && Math.random() < dt * 0.05 && !g.nav.trench?.[g.nav.idx(s.pos.x, s.pos.z)]) { // crawl a little towards cover (in a trench: he is in it)
        const [cx, cz] = g.nav.nearestFree(s.pos.x + (Math.random() - .5) * 4, s.pos.z + (this.side === 'player' ? 3 : -3), 0.4, 3); s.path = [[cx, cz]]; s.pathI = 0; s.crawl = true;
      }
    }
    // dragging logic (medic / buddy)
    if (s.dragging) this.dragStep(s, dt);
    // garrison: entering the building through the entrance
    if (s.slotRef && !s.inside && !s.cqb && !s.houseWalk && s.goal && g.cqb) { const dg = Math.hypot(s.pos.x - s.goal[0], s.pos.z - s.goal[1]); if (dg < (s.slotRef.panel.b.house ? 0.9 : 2.2) || (dg < 2.2 && !(s.path && s.pathI < s.path.length) && !s.pathReq)) { s.path = null; s.goal = null; g.cqb.entryWalk(this, s, s.slotRef.panel.b, s.slotRef); } }   // in by the door, then walks (up the stairs) to his window (a house: from its door's outside point, not from across its wall)
    if (!g.cqb && s.slotRef && !s.inside && s.goal && Math.hypot(s.pos.x - s.goal[0], s.pos.z - s.goal[1]) < 2.2) {   // (no CQB module: straight to the window)
      s.inside = s.slotRef; s.path = null; s.goal = null;
      const bb = s.slotRef.panel.b; bb.slotPos(s.slotRef, s.pos); s.heading = Math.atan2(bb.outward(s.slotRef.panel).x, bb.outward(s.slotRef.panel).z);
    }
    if (s.cqb) g.cqb.step(this, s, dt);                 // inside, clearing rooms / walking to a window (cqb.js)
    else if (s.houseWalk) g.cqb.walkStep(this, s, dt);  // out of a house through its door
    else if (s.cellarMove) this.cellarStep(s, dt);      // climbing down to / up from the cellar
    else if (s.cellar) s.vel.set(0, 0, 0);
    else if (s.inBuilding) {
      if (!s.inside.panel.open) s.bld.openWindow?.(s.inside.panel);   // v7: knocks the glass out of his window (buildings.js)
      // panel destroyed under him -> he falls back inside but keeps fighting; if the floor is gone he drops
      if (s.inside.panel.state === 3 && s.inside.panel.floor > 0 && Math.random() < dt * 0.3) { g.hitSoldier(s, { dmg: [40, 90], type: 'blast' }, s.pos, true); }
      s.vel.set(0, 0, 0);
    } else this.moveStep(s, dt);
    // facing
    let want = s.heading;
    if (s.target && s.effective && !(s.path && s.pathI < s.path.length && this.run)) want = Math.atan2(s.target.pos.x - s.pos.x, s.target.pos.z - s.pos.z);
    else if (s.vel.lengthSq() > 0.05) want = Math.atan2(s.vel.x, s.vel.z);
    else if (s.groundAim && s.aimPoint) want = Math.atan2(s.aimPoint.x - s.pos.x, s.aimPoint.z - s.pos.z);
    else if (s.goalHeading != null) want = s.goalHeading;
    if (s.inBuilding && (s.target || s.groundAim)) { const o = s.bld.outward(s.inside.panel); const base = Math.atan2(o.x, o.z); let d = angDiff(want, base); d = THREE.MathUtils.clamp(d, -1.1, 1.1); want = base + d; }
    if (s.dragging && (s.dragPhase === 'drag' || s.dragPhase === 'assist')) want = Math.atan2(-s.vel.x, -s.vel.z); // walks backwards pulling
    if (s.throwT > 0 && s.throwYaw != null) want = s.throwYaw;   // v7: faces his grenade throw (combat.startThrow)
    if (!(s.jumpT > 0 || s.hatchT > 0)) s.heading += THREE.MathUtils.clamp(angDiff(want, s.heading), -5 * dt, 5 * dt);   // root-motion exit clips: heading fixed (hatch exits too: turning the root swung his whole way out off the hull)
    // combat
    if (s.effective && !this.routing && !s.dragging && !(s.jumpT > 0 || s.hatchT > 0)) g.combat.soldierCombat(s, dt);
    else s.target = null;
    s.animate(dt, g.camDist(s.pos));
    s.sync();
  }
  moveStep(s, dt) {
    const g = this.game;
    if (s.jumpT > 0 || s.hatchT > 0) { s.vel.set(0, 0, 0); if (s.jumpT > 0) s.jumpEnded = s.jumpClip; return; }
    let moving = s.path && s.pathI < s.path.length;
    // the jump-off clips end walking off (events.end_speed_mps): carry that pace on instead of stopping dead for a frame and
    // starting again from zero (idle <-> walk cross-fades, a visible stutter right after landing)
    if (s.jumpEnded) { const es = clipEvents(s.jumpEnded).end_speed_mps; s.jumpEnded = null; if (es > 0 && moving) s.vel.set(Math.sin(s.heading) * es, 0, Math.cos(s.heading) * es); }
    let speed = 0;
    // pinned down: nobody gets up and moves (except to drag a wounded mate)
    // (the player's own move order under fire: they crawl there on their bellies instead of freezing where they are)
    let pinned = (this.pinned || s.suppression > 88) && !s.dragging && s.state !== 'critical';
    if (pinned && moving && this.side === 'player' && this.order?.type === 'move' && !this.routing) { pinned = false; s.stance = 'prone'; s.crawl = true; }
    if (s.aimStopT > 0) s.aimStopT -= dt;
    if (moving && (pinned || s.aimStopT > 0 || (s.startDelay > 0 && (s.startDelay -= dt) > 0))) { s.vel.multiplyScalar(Math.max(0, 1 - dt * 8)); s.wdT = 0; s.wdP = null; this.groundY(s, dt, false); return; }
    if (moving) {
      const wp = s.path[s.pathI];
      const dx = wp[0] - s.pos.x, dz = wp[1] - s.pos.z, d = Math.hypot(dx, dz);
      const dash = s.droneMoved && (s.droneHideT ?? 0) > this.game.time;   // breaking for cover from an FPV (support.js reactions)
      let base = this.run || this.routing || dash ? TUNING.run : TUNING.walk;
      if (s.stance === 'crouch') base = Math.min(base, this.run || dash ? TUNING.crouchRun : TUNING.crouchWalk);
      if (s.stance === 'prone') base = !s.crawl && (s.suppression || 0) < 80 ? (TUNING.highCrawl || 0.7) : TUNING.crawl;   // v5: high crawl on a bound unless the fire is heavy; low crawl when creeping / heavily suppressed
      if (this.assault) base *= 1.06;
      if (s.state === 'light' && s.legWound) base *= 0.55;
      if (s.state === 'critical') base = 0.3;
      if (s.dragging && s.dragPhase === 'drag') base = TUNING.dragSpeed * (s.dragging.dragAssist?.dragging === s.dragging && s.dragging.dragAssist.dragPhase === 'assist' && s.dragging.dragAssist.pos.distanceToSquared(s.pos) < 4 ? 1.5 : 1);   // two-man drag: ~1.5x
      else base *= s.speedMul || 1;
      const ci = g.nav.idx(s.pos.x, s.pos.z); if (ci >= 0 && g.nav.cost[ci] > 2 && g.nav.cost[ci] < 255) base *= 0.7;
      // cohesion: don't outrun the squad too much
      speed = base;
      if (d < 0.4) { s.pathI++; if (s.pathI >= s.path.length) { s.path = null; s.crawl = false; if (s.resumeGoal) { s.resumeGoal = false; if (s.goal) g.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], 0.45, false, this.pathOpts()); } } }
      else {
        V.set(dx / d, 0, dz / d);
        // v6 local avoidance: a mate standing / walking slower just ahead on his line -> sidestep round him (on the side
        // he is not on) instead of walking into him and being shoved back by the separation push
        let side = 0;
        for (const o of this.soldiers) {
          if (o === s || !o.alive || o.inside || o.jumpT > 0) continue;
          const rx = o.pos.x - s.pos.x, rz = o.pos.z - s.pos.z, r2 = rx * rx + rz * rz; if (r2 > 4 || r2 < 1e-4) continue;
          const ahead = rx * V.x + rz * V.z; if (ahead < 0.15 || ahead > d + 0.6) continue;
          const lat = rx * V.z - rz * V.x; if (Math.abs(lat) > 0.95) continue;
          if (o.vel.x * V.x + o.vel.z * V.z > speed * 0.8) continue;   // he's walking away at about our pace
          side += (lat >= 0 ? -1 : 1) * (1 - Math.sqrt(r2) / 2) * 1.4;
        }
        if (side) { const sx = V.x + V.z * side, sz = V.z - V.x * side, sl = Math.hypot(sx, sz) || 1, tr = g.nav.trench, ti = k => tr?.[g.nav.idx(k[0], k[1])]; if (!ti([s.pos.x, s.pos.z]) || ti([s.pos.x + sx / sl * 0.6, s.pos.z + sz / sl * 0.6])) V.set(sx / sl, 0, sz / sl); }   // (in a trench: no sidestep over the lip)
        s.vel.lerp(V.multiplyScalar(Math.min(speed, d * 3)), Math.min(1, dt * 6));
      }
    } else if (s.dragPhase !== 'assist') s.vel.multiplyScalar(Math.max(0, 1 - dt * 8));   // (second man of a two-man drag: dragStep sets his pace)
    // separation from squadmates & vehicles (never shoves anyone into a wall; drag partners are not pushed apart)
    const nav = g.nav, free = (x, z) => { const i = nav.idx(x, z); return i >= 0 && nav.cost[i] !== 255; };
    const sepK = s.vehFrom ? 0.3 : 1;   // men who just landed side by side drift apart slowly (they walk off anyway), not shoved
    for (const o of this.soldiers) { if (o === s || !o.alive || o.inside || o.jumpT > 0 || o.dragging === s || (s.dragging && (o === s.dragging || o.dragging === s.dragging))) continue; const dx = s.pos.x - o.pos.x, dz = s.pos.z - o.pos.z, d2 = dx * dx + dz * dz; if (d2 < 1.2 && d2 > 1e-4) { const k = (1.2 - d2) * 1.5 * dt * sepK; if (free(s.pos.x + dx * k, s.pos.z + dz * k) && (!nav.trench?.[nav.idx(s.pos.x, s.pos.z)] || nav.trench[nav.idx(s.pos.x + dx * k, s.pos.z + dz * k)])) { s.pos.x += dx * k; s.pos.z += dz * k; } } }
    if (s.vehFrom && (g.time > s.vehFromT || s.vehFrom.pos.distanceToSquared(s.pos) > 64)) s.vehFrom = null;
    // vehicles: kept out of the real hull footprint (oriented box) - a live vehicle is not in the nav grid, so a path may run
    // straight through it; the old round push (radius + 0.9, far shorter than the hull) let men walk through its bow / stern and
    // left anyone heading for its middle pressed against it for good. Walking into it, he now slides along the side to the
    // nearer end and round it
    if (!s.rampWalk) for (const v of g.vehicles) {
      if (v.destroyed && !v.wreck) continue;
      const dx = s.pos.x - v.pos.x, dz = s.pos.z - v.pos.z, R = v.def.length * 0.5 + 1.5; if (dx * dx + dz * dz > R * R) continue;
      const sh = Math.sin(v.heading), ch = Math.cos(v.heading), B = hullBox(v), lf = dx * sh + dz * ch, ll = dx * ch - dz * sh;   // root frame: +Z forward (sin h, cos h), +X = the vehicle's left (cos h, -sin h)
      const gentle = v === s.vehFrom, M = gentle ? 0.25 : 0.35;   // just jumped off it: gently, no shove off the landing point
      // v8: his next waypoint lies on / against this hull (a route planned before it stopped there, a slot next to a moving one, a
      // goal by a door): within 0.4 m of it he never got, so he circled the hull for good -> skip it, or (the last one) move it off
      if (moving && s.path && !gentle) {
        const wp = s.path[s.pathI], last = s.pathI >= s.path.length - 1, [ox, oz] = wp ? outsideHull(v, wp[0], wp[1], last ? M + 0.3 : M + 0.05) : [0, 0];
        if (wp && (ox !== wp[0] || oz !== wp[1])) {
          if (!last) s.pathI++;
          else { if (s.goal && Math.hypot(s.goal[0] - wp[0], s.goal[1] - wp[1]) < 0.6) s.goal = [ox, oz]; s.path[s.pathI] = [ox, oz]; }
        }
      }
      const pf = Math.min(lf - (B.min.z - M), B.max.z + M - lf), pl = Math.min(ll - (B.min.x - M), B.max.x + M - ll);
      if (pf <= 0 || pl <= 0) continue;
      const side = pl < pf, sg = side ? (ll - (B.min.x - M) < B.max.x + M - ll ? -1 : 1) : (lf - (B.min.z - M) < B.max.z + M - lf ? -1 : 1);
      const nx = side ? sg * ch : sg * sh, nz = side ? -sg * sh : sg * ch, depth = Math.min(side ? pl : pf, gentle ? 1.5 * dt : 9);
      if (free(s.pos.x + nx * depth, s.pos.z + nz * depth)) { s.pos.x += nx * depth; s.pos.z += nz * depth; }
      const vn = s.vel.x * nx + s.vel.z * nz;
      if (moving && vn < 0) {
        let tx = side ? sh : ch, tz = side ? ch : -sh;   // along the face (+forward on a side face, +left on the bow / stern)
        // v8: one way round, held: the sense of rotation round the hull (clockwise / anticlockwise) is picked once on contact and
        // kept while he is against this hull, through its corners (picked afresh every frame it flipped at the corners and near the
        // middle of a face: slid to and fro there for good). Picked: towards his waypoint, else round the nearer end; not into a wall.
        const rs = Math.sign(dx * tz - dz * tx) || 1;   // +t is this sense of rotation round the hull centre
        let sense = s.vSlide && s.vSlide.v === v && g.time - s.vSlide.t < 3 ? s.vSlide.sense : 0;
        if (!sense) {
          const wp = s.path ? s.path[s.pathI] || null : null, along = side ? lf : ll, lo = side ? B.min.z : B.min.x, hi = side ? B.max.z : B.max.x;
          let want = wp ? (wp[0] - s.pos.x) * tx + (wp[1] - s.pos.z) * tz : s.vel.x * tx + s.vel.z * tz;
          const wd = wp ? Math.hypot(wp[0] - s.pos.x, wp[1] - s.pos.z) : s.vel.length();
          if (Math.abs(want) < 0.35 * wd) want = along - lo < hi - along ? -1 : 1;   // heading for the middle: round the nearer end
          let dir = want < 0 ? -1 : 1;
          if (!free(s.pos.x + tx * dir * 1.2, s.pos.z + tz * dir * 1.2) && free(s.pos.x - tx * dir * 1.2, s.pos.z - tz * dir * 1.2)) dir = -dir;
          sense = rs * dir;
        }
        s.vSlide = { v, sense, t: g.time };
        if (rs !== sense) { tx = -tx; tz = -tz; }
        const sp = Math.max(Math.hypot(s.vel.x, s.vel.z), Math.min(speed || 1, 1.1));   // (round it at a walk: the old 0.6 m/s floor crept round a tank in 15 s)
        s.vel.x = tx * sp; s.vel.z = tz * sp;
        // a parked hull (in the infantry layer) and his route still runs through it (planned before it stopped there): a new route
        if (s.goal && !s.pathReq && g.nav.dynStamps.has(v) && g.time > (s.vRepT ?? 0) && s.path) {
          const wp = s.path[s.pathI]; if (wp && g.nav.segHitsDyn(v, s.pos.x, s.pos.z, wp[0], wp[1])) { s.vRepT = g.time + 2; this.vehRepaths = (this.vehRepaths || 0) + 1; g.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], 0.45, false, this.pathOpts()); }
        }
      }
    }
    // already inside a blocked cell (pushed, collapsed rubble, spawned badly): step out to the nearest free spot
    // (a few metres - e.g. the ground round a fresh wreck that was just blocked, a crewman's hatch exit spot - he shuffles out at a
    // brisk walk instead of popping there in one frame)
    if (!free(s.pos.x, s.pos.z)) {
      const [fx, fz] = nav.nearestFree(s.pos.x, s.pos.z, 0.45, 8), d = Math.hypot(fx - s.pos.x, fz - s.pos.z), k = d < 3 ? Math.min(1, 2.2 * dt / Math.max(d, 1e-3)) : 1;
      s.pos.x += (fx - s.pos.x) * k; s.pos.z += (fz - s.pos.z) * k;
      if (k >= 1 && s.goal) { s.path = null; g.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], 0.45); }
      if (k < 1) { s.vel.set((fx - s.pos.x) / Math.max(d, 1e-3) * 2.2, 0, (fz - s.pos.z) / Math.max(d, 1e-3) * 2.2); this.groundY(s, dt, true); return; }
    }
    const nx = s.pos.x + s.vel.x * dt, nz = s.pos.z + s.vel.z * dt;
    if (free(nx, nz)) { s.pos.x = nx; s.pos.z = nz; }
    else if (free(nx, s.pos.z)) { s.pos.x = nx; s.vel.z *= 0.5; }      // slide along the wall
    else if (free(s.pos.x, nz)) { s.pos.z = nz; s.vel.x *= 0.5; }
    else if (moving) { s.vel.multiplyScalar(0.3); s.blockedT = (s.blockedT || 0) + dt; }
    // watchdog: wanted to move but made no progress for a while -> replan from where we stand
    if (moving) {
      s.wdT = (s.wdT || 0) + dt;
      if (s.wdT > 2.5) { let moved = s.wdP ? Math.hypot(s.pos.x - s.wdP[0], s.pos.z - s.wdP[1]) : 9; s.wdP = [s.pos.x, s.pos.z]; s.wdT = 0;
        // v8: moving is not getting anywhere - sliding to and fro along a hull / between two of them moved him every check while
        // he got no nearer for good. Progress = the route left to walk; none for 7.5 s on the same route counts as stuck too
        if (s.path) {
          let rem = 0, px = s.pos.x, pz = s.pos.z; for (let j = s.pathI; j < s.path.length; j++) { rem += Math.hypot(s.path[j][0] - px, s.path[j][1] - pz); px = s.path[j][0]; pz = s.path[j][1]; }
          if (s.wdPath !== s.path || rem < s.wdRem - 0.5) { s.wdPath = s.path; s.wdRem = rem; s.wdNP = 0; }
          else if (++s.wdNP >= 3) { s.wdNP = 0; s.wdPath = null; moved = 0; this.oscN = (this.oscN || 0) + 1; }
        }
        // v6 stuck recovery, escalating: replan; replan giving obstacles a wider berth (0.6 m); walk out to the nearest open
        // cell (1 m clear, away from the corner / fence / wreck he is caught on) and replan from there; give up the goal
        if (moved < 0.6 && s.goal) { g.vehBlockNear?.(s); s.stuckN = (s.stuckN || 0) + 1; s.path = null; s.blockedT = 0; this.stuckN = (this.stuckN || 0) + 1;
          if (s.stuckN > 5) { s.goal = null; s.stuckN = 0; }
          else if (s.stuckN >= 3) { const [fx, fz] = nav.nearestFreeI(s.pos.x, s.pos.z, 1.0, 5); if (Math.hypot(fx - s.pos.x, fz - s.pos.z) > 0.3 && nav.lineFree(s.pos.x, s.pos.z, fx, fz, 0.3)) { s.path = [[fx, fz]]; s.pathI = 0; s.resumeGoal = true; } else g.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], 0.4, false, this.pathOpts()); }
          else g.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], s.stuckN === 2 ? 0.6 : 0.45, false, this.pathOpts()); }
        else if (moved >= 0.6) s.stuckN = 0; }
    } else { s.wdT = 0; s.wdP = null; }
    // footsteps (close to camera only)
    if (s.vel.lengthSq() > 1 && g.camDist(s.pos) < 35) { s.stepT = (s.stepT || 0) + dt * s.vel.length(); if (s.stepT > 1.6) { s.stepT = 0; g.sfx(Math.random() < .6 ? 'footstep_rubble' : 'footstep_gravel', s.pos, { gain: 0.5 }); } }
    this.groundY(s, dt, moving);
  }
  // feet on the terrain (trench floors, parapets, rubble heaps); a man in a trench steps up onto the firing step
  // to shoot (head and shoulders over the parapet) and ducks back to the floor otherwise
  groundY(s, dt, moving) {
    const c = this.game.city, gh = c.groundHeight;
    if (!gh) { s.pos.y = 0; return; }
    let y = gh(s.pos.x, s.pos.z);
    if (s.rampWalk) {   // walking out of an IFV: compartment floor, then down the ramp
      const R = s.rampWalk, t = (s.pos.x - R.bx) * R.fx + (s.pos.z - R.bz) * R.fz;
      if (t < -0.4) { s.rampWalk = null; if (s.goal) this.game.requestPath(s, s.pos.x, s.pos.z, s.goal[0], s.goal[1], 0.45); }
      else { s.pos.y = Math.max(y, R.y0 * THREE.MathUtils.clamp(t / R.len, 0, 1)); return; }
    }
    if (y < -0.8 && !moving) {
      const ti = c.trenchInfo?.(s.pos.x, s.pos.z);
      const firing = s.target || (this.game.time - (s.lastShotT ?? -99) < 2) || (this.fireAt && !this.holdFire);
      if (ti && firing && ti.fireY > y) y = ti.fireY;
    }
    s.pos.y = Math.abs(s.pos.y - y) > 2.5 ? y : THREE.MathUtils.lerp(s.pos.y, y, Math.min(1, dt * 7));
  }
  // not pinned down: little suppression and no rounds cracking past him in the last few seconds
  safeToHelp(s, supMax = 25) { return s.suppression < supMax && this.game.time - (s.nearMissT ?? -99) > 5; }
  // the casualty lies where a spotted enemy (seen in the last 15 s, within direct-fire range) can see him
  casualtyExposed(w) {
    if (w.inBuilding || w.pos.y < -0.8) return false;   // inside / down in the trench: can be reached under cover
    const g = this.game, me = this.side, near = [];
    for (const u of g.enemiesOf(me)) {
      if (u.destroyed || u.type === 'squad' && (u.mounted || !u.effective.length)) continue;
      const t = u.seenBy?.[me]; if (t == null || g.time - t > 15) continue;
      const p = u.type === 'vehicle' ? u.pos : u.center(), d = p.distanceTo(w.pos);
      if (d < (u.type === 'vehicle' ? 1100 : 500)) near.push([p, d, u.type === 'vehicle' ? 2.2 : 1.4]);
    }
    near.sort((a, b) => a[1] - b[1]);
    for (const [p, , h] of near.slice(0, 6)) if (g.combat.los(p.x, p.y + h, p.z, w.pos.x, w.pos.y + 0.4, w.pos.z, null, null)) return true;
    return false;
  }
  dragStep(s, dt) {
    const w = s.dragging, g = this.game;
    if (!w.alive || w.state === 'evac') { s.dragging = null; return; }
    if (s.dragPhase === 'reach') {
      // can't get to him (no route ends at him, blocked, cut off): give up after a while, nobody retries for 30 s
      s.reachT = (s.reachT || 0) + dt;
      if (s.reachT > 25) { s.reachT = 0; w.noReachT = g.time + 30; s.dragging = null; s.dragPhase = null; s.path = null; s.goal = null; return; }
      if (Math.hypot(s.pos.x - w.pos.x, s.pos.z - w.pos.z) < 1.4) {
        s.reachT = 0;
        if (w.dragger && w.dragger !== s && w.dragger.dragging === w) {   // a mate already has him: take the other shoulder strap
          if (w.dragger.dragPhase === 'drag' && !(w.dragAssist?.dragging === w)) { s.dragPhase = 'assist'; w.dragAssist = s; s.path = null; s.goal = null; }
          else { s.dragging = null; s.dragPhase = null; s.path = null; s.goal = null; }
          return;
        }
        s.dragPhase = 'drag'; w.dragger = s;
        // destination: carrier if close, else nearest cover away from the enemy
        const v = this.carrier && !this.carrier.destroyed && this.carrier.pos.distanceTo(s.pos) < 70 ? this.carrier : null;
        let dest;
        // down in a trench: he stays in it - along the floor to the nearest dugout of the system, else patched up where he lies
        const nav = g.nav, wT = nav.trench?.[nav.idx(w.pos.x, w.pos.z)] ? (g.city.trenchSystems || []).find(T => nav.trenchPair(w.pos.x, w.pos.z, w.pos.x, w.pos.z, [T])) : null;
        if (wT) {
          const dd = o => Math.hypot(o.door[0] - w.pos.x, o.door[1] - w.pos.z), dg = (wT.dugouts || []).reduce((a, o) => (!a || dd(o) < dd(a) ? o : a), null);
          if (!dg || dd(dg) > 30 || dd(dg) < 2.5) { s.dragPhase = 'treat'; s.path = null; s.goal = null; s.treatT = (7 + Math.random() * 4) * (1 - Math.min(0.6, g.mods?.[this.side]?.medTreat || 0)); return; }
          dest = [dg.door[0], dg.door[1]]; s.dragTarget = 'cover';
        } else if (v) { const d = v.doorPos(s.idx); dest = [d.x, d.z]; s.dragTarget = 'carrier'; }
        else { const t = this.threatPoint(), dx = t ? s.pos.x - t[0] : 0, dz = t ? s.pos.z - t[1] : (this.side === 'player' ? 1 : -1), L = Math.hypot(dx, dz) || 1; dest = this.findCover(s.pos.x + dx / L * 12, s.pos.z + dz / L * 12, s.pos, t); s.dragTarget = 'cover'; }   // (v9: away from the known enemy - it was always +-z)
        s.goal = dest; g.requestPath(s, s.pos.x, s.pos.z, dest[0], dest[1], 0.45);
      } else if (!s.path) { s.goal = [w.pos.x, w.pos.z]; g.requestPath(s, s.pos.x, s.pos.z, w.pos.x, w.pos.z, 0.45); }
    } else if (s.dragPhase === 'drag') {
      // wounded is pulled behind the dragger
      const back = new THREE.Vector3(-Math.sin(s.heading), 0, -Math.cos(s.heading));
      w.pos.lerp(s.pos.clone().addScaledVector(back, -1.0), Math.min(1, dt * 8)); w.heading = s.heading + Math.PI;
      w.vel.set(0, 0, 0);
      if (!s.path || s.pathI >= (s.path?.length || 0)) {
        if (s.dragTarget === 'carrier' && this.carrier && this.carrier.pos.distanceTo(s.pos) < 5) { this.evacuate(w); s.dragging = null; s.dragPhase = null; this.game.hud && this.side === 'player' && this.game.hud.alert(`${this.name}: casualty evacuated`, 'good'); }
        else { s.dragPhase = 'treat'; s.treatT = (7 + Math.random() * 4) * (1 - Math.min(0.6, this.game.mods?.[this.side]?.medTreat || 0)); }   // campaign tech: combat-lifesaver training (tech.js Medical)
      }
    } else if (s.dragPhase === 'assist') {
      // second man of a two-man drag: beside the casualty's shoulder, opposite the first, walking backwards with him
      const d = w.dragger;
      if (!d || d.dragging !== w || d.dragPhase !== 'drag' || !d.alive) { s.dragging = null; s.dragPhase = null; if (w.dragAssist === s) w.dragAssist = null; s.vel.set(0, 0, 0); return; }
      const sx = Math.cos(d.heading), sz = -Math.sin(d.heading), tx = d.pos.x + sx * 0.75, tz = d.pos.z + sz * 0.75;
      const dx = tx - s.pos.x, dz = tz - s.pos.z, dd = Math.hypot(dx, dz), v = Math.min(dd / Math.max(dt, 1e-3), TUNING.run) * (dd > 0.05 ? 1 : 0);
      s.vel.set(dd > 1e-4 ? dx / dd * v : 0, 0, dd > 1e-4 ? dz / dd * v : 0); s.stance = 'crouch';   // (moveStep integrates it)
      if (dd < 0.3) s.vel.copy(d.vel);
    } else if (s.dragPhase === 'treat') {
      s.treatT -= dt; s.vel.set(0, 0, 0); s.stance = 'crouch';
      if (s.treatT <= 0) { w.state = 'stable'; w.dragger = null; s.dragging = null; s.dragPhase = null; }
    }
  }
  findCover(x, z, from, thr = null) {
    const nav = this.game.nav; let best = [x, z], bs = -1e9;
    const enemyZ = this.side === 'player' ? -200 : 200;
    for (let r = 0; r <= 8; r += 2) for (let a = 0; a < 12; a++) {
      const cx = x + Math.cos(a / 12 * 6.28) * r, cz = z + Math.sin(a / 12 * 6.28) * r, i = nav.idx(cx, cz);
      if (!nav.passable(i, 0.4)) continue;
      const sc = (thr ? nav.coverFrom(cx, cz, thr[0], thr[1]) : nav.coverFrom(cx, cz, cx, enemyZ)) * 10 - r * 0.3 - Math.hypot(cx - from.x, cz - from.z) * 0.1;
      if (sc > bs) { bs = sc; best = [cx, cz]; }
    }
    return best;
  }
}

export function angDiff(a, b) { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }
Object.defineProperties(Squad.prototype, Object.getOwnPropertyDescriptors(TrenchMixin));
