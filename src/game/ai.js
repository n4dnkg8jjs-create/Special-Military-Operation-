import * as THREE from 'three';
import { trenchMen } from './trench.js';
import { CommanderV1, STAGING, OVERWATCH } from './ai_legacy.js';
import { Intel, AIDebug, scanLane, firePosition, covered, sees, sqPower, vehPower } from './ai_tactics.js';
import { SPAWNS } from '../world/city.js';
import { TUNING } from '../config.js';

const Q = new URLSearchParams(location.search);
const V3 = (x, z) => new THREE.Vector3(x, 0, z);
const D = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Enemy company commander, v2 (?aiold: the legacy v1 in ai_legacy.js, for A/B benchmarks — tools/ai_bench.mjs).
//
// Plays under the player's constraints: it knows only what its own units have spotted (Intel: last-known positions
// that age out), gets the same orders (move / garrison / trench / storm / smoke), the same rationed mortar missions,
// the same single reinforcement, and its men have the same ammunition and morale.
//
// It runs a small set of operations, re-planned every 4 s:
//  * occupy   — an objective nobody is known to hold: one unit rides up, dismounts short and takes it.
//  * attack   — the deliberate attack on the main effort: RECON (the fix element moves to an observation post
//               with a view of the objective and watches) -> PREP (fix element in a covered base-of-fire position,
//               armour hull-down in overwatch, ATGM team on the armour avenue, manoeuvre element moves along the best
//               covered flank lane to an attack position; mortars on the spotted defenders) -> ASSAULT (smoke, the
//               manoeuvre element storms while the fix element keeps firing and the armour moves up behind the
//               infantry) -> CONSOLIDATE (dig in: trenches / buildings, armour back to overwatch). A failed attack
//               (manoeuvre element broken / shot to pieces) marks its lane and objective: the next attempt goes
//               another way, or at a weaker objective.
//  * counter  — a held objective is lost / penetrated: the reserve (and what is near) counterattacks it when the
//               known enemy there is not stronger.
//  * defend   — one garrison per held objective in trenches / buildings; withdraws when hopeless and short of
//               tickets (trading space for tickets).
// Damaged vehicles pull back, broken squads regroup out of contact, the reserve is kept until it is needed.
export function Commander(game) { return Q.has('ainew') ? new CommanderV2(game) : new CommanderV1(game); }   // v2 behind ?ainew until it out-plays v1 in benchmarks (previews/ai_v2/summary_final.md)

export class CommanderV2 extends CommanderV1 {
  constructor(game) {
    super(game);
    this._plan = this.plan; delete this.plan;   // v1's wave table shadows the planner method
    this.intel = new Intel(game, 'enemy');
    this.ops = []; this.opN = 0; this.laneFail = {}; this.objFail = {}; this.lastLane = {}; this.lostT = {};
    this.planT = 0; this.fireT = 0; this.opCool = 0;
    this.stats = { ops: [], recon: 0, prepFires: 0, fires: 0, smokeAssault: 0, reserveCommits: [], withdrawals: 0, vehRetreats: 0, laneSwitch: 0, counterOps: 0, atgmMoves: 0 };
    this.dbg = Q.has('aidebug') ? new AIDebug(this) : null;
    // the player's side of the map (for facing defences): mean of the defender spawns
    const sp = SPAWNS.defender || [[0, 300]]; this.playerSide = sp.reduce((a, p) => [a[0] + p[0] / sp.length, a[1] + p[1] / sp.length], [0, 0]);
    const ap = SPAWNS.attacker || [[0, -300]]; this.ourSide = ap.reduce((a, p) => [a[0] + p[0] / ap.length, a[1] + p[1] / ap.length], [0, 0]);
  }
  note(m) { this.dbg?.note(m); }
  // ---------------------------------------------------------------- unit helpers
  upos(b) { if (b.sq && !b.sq.mounted && !(b.kind === 'tank')) { const c = b.sq.center(); return [c.x, c.z]; } const v = b.v || b.sq?.carrier; return v ? [v.pos.x, v.pos.z] : [0, 0]; }
  alive(b) { if (b.dead) return false; if (b.kind === 'tank' || b.kind === 'spg') return !b.v.destroyed; return !b.sq.destroyed && b.sq.effective.length > 0; }
  power(b) { if (b.kind === 'tank') return vehPower(b.v); let p = sqPower(b.sq); if (b.v && !b.v.destroyed) p += vehPower(b.v) * 0.7; return p; }
  isInf(b) { return b.sq && b.kind !== 'atgm' && b.kind !== 'fpv' && b.kind !== 'spg'; }
  objOf(id) { return this.g.objectives.find(o => o.id === id); }
  oxz(id) { const o = this.objOf(id); return [o.x, o.z]; }
  // unit vector from objective towards our side (staging) / towards the player's side
  toUs(id) { const [x, z] = this.oxz(id), st = STAGING[id], c = st.reduce((a, p) => [a[0] + p[0] / st.length, a[1] + p[1] / st.length], [0, 0]); let dx = c[0] - x, dz = c[1] - z; const L = Math.hypot(dx, dz) || 1; return [dx / L, dz / L]; }
  toThem(id) { const [x, z] = this.oxz(id), p = this.playerSide; let dx = p[0] - x, dz = p[1] - z; const L = Math.hypot(dx, dz) || 1; return [dx / L, dz / L]; }
  assembly(id, from) { const st = STAGING[id]; return st.slice().sort((a, b) => D(a, from) - D(b, from))[0]; }
  setTask(b, role, dest, why, extra) { const ch = b.role !== role || !b.task || !b.task.dest || !dest || D(b.task.dest, dest) > 12; b.role = role; b.task = { dest, why, ...extra }; if (ch) { b.arrived = false; b.taskT = this.g.time; } return ch; }
  // the intel-based replacement for v1's all-seeing threatsNear (used by the inherited helpers)
  threatsNear(p, r) { const l = this.intel.near(p.x, p.z, r, 30); return { n: l.length, rpg: this.intel.rpgNear(p.x, p.z, r) }; }
  clusterScore(u) { return 0; }
  // ---------------------------------------------------------------- battle start
  begin() {
    for (const b of this.army) { b.role = null; b.task = null; this.units.push(b); if (b.kind === 'defend') { b.role = 'garrison'; b.task = { dest: this.oxz(b.obj), why: 'dug in' }; } }
    this.started = true;
    this.plan(true);
  }
  update(dt) {
    const g = this.g;
    if (!this.started) return;
    this.intelT = (this.intelT || 0) - dt; if (this.intelT <= 0) { this.intelT = 1; this.intel.update(); }
    this.assessT = (this.assessT || 0) - dt; if (this.assessT <= 0) { this.assessT = 3; this.assess(); }
    // the single reinforcement (same as the player's): a mounted squad, into the reserve
    if (!this.counter && (g.objectives.some(o => o.captured) || g.time > g.roundLen * 0.3)) {
      this.counter = true; const rem = Math.max(120, g.roundLen - g.time);
      this.waves = this.plan_.map(([f, a, b, c, d]) => ({ t: g.time + 25 + f * rem, foot: a, mech: b, tank: c, assault: d }));
    }
    if (this.counter && this.waveI < this.waves.length && g.time >= this.waves[this.waveI].t) {
      const n0 = this.units.length; this.spawnWave(this.waves[this.waveI++]);
      for (const b of this.units.slice(n0)) { b.role = null; b.task = null; b.fresh = true; }
      this.note('reinforcement arrived -> reserve');
    }
    this.planT -= dt; if (this.planT <= 0) { this.planT = 4; try { this.plan(false); } catch (e) { console.error('[AI plan]', e); } }
    for (const b of this.units) if (!b.dead) { b.t -= dt; if (b.t <= 0) { b.t = 1.2 + Math.random() * 0.6; try { this.think(b); } catch (e) { console.error('[AI]', e); b.t = 5; } } }
    this.fireT -= dt; if (this.fireT <= 0) { this.fireT = 5; try { this.fireSupport(); } catch (e) { console.error('[AI fire]', e); } }
    if (this.dbg) { this.dbgT = (this.dbgT || 0) - dt; if (this.dbgT <= 0) { this.dbgT = 1; this.dbg.update(); } }
  }
  // v1's wave table is `plan`; v2 uses plan() as the planner — keep the table under another name
  get plan_() { return this._plan || [[0.2, 0, 1, 0, 0]]; }
  set plan_(v) { this._plan = v; }
  // ---------------------------------------------------------------- the planner
  plan(first) {
    const g = this.g, I = this.intel, now = g.time;
    const live = this.units.filter(b => this.alive(b));
    for (const b of this.units) if (!b.dead && !this.alive(b)) { b.dead = true; if (b.op) b.op.units.delete(b); if (b.v && !b.v.destroyed && b.kind !== 'tank') { const h = this.assembly(b.obj || g.objectives[0].id, [b.v.pos.x, b.v.pos.z]); b.v.orderMove(h[0], h[1]); } }
    // a garrison thrown off its objective (out of the trench / building) becomes free for the counterattack
    for (const b of live) if (b.role === 'garrison' && this.objOf(b.obj)?.owner === 'player' && !b.sq.building && !b.sq.trench) { b.role = null; b.task = null; }
    // ---- objective picture
    const pic = {};
    for (const o of g.objectives) {
      const known = I.strength(o.x, o.z, 90), ours = live.filter(b => this.isInf(b) && D(this.upos(b), [o.x, o.z]) < 70).reduce((a, b) => a + this.power(b), 0);
      pic[o.id] = { o, known, ours, armour: I.near(o.x, o.z, 260, 60).filter(e => e.armour).length };
      if (o.owner === 'enemy') this.heldT ??= {}, (this.heldT[o.id] = now);
      if (o.owner === 'player' && this.heldT?.[o.id] && !this.lostT[o.id]) { this.lostT[o.id] = now; this.note(`lost ${o.id} — counterattack wanted`); }
      if (o.owner === 'enemy') this.lostT[o.id] = null;
    }
    this.pic = pic;
    // ---- running operations: progress / success / failure
    for (const op of this.ops.slice()) this.stepOp(op, pic);
    // ---- garrisons: one per held objective (prefer the dug-in 'defend' squads, else whoever stands on it)
    const free = () => live.filter(b => this.isInf(b) && !b.op && b.role !== 'garrison' && b.role !== 'reserve' && b.state !== 'regroup' && !b.sq.routing);
    for (const o of g.objectives) {
      if (o.owner !== 'enemy') continue;
      const gar = live.filter(b => b.role === 'garrison' && b.obj === o.id);
      if (gar.length) continue;
      const cand = free().filter(b => D(this.upos(b), [o.x, o.z]) < 120).sort((a, b) => D(this.upos(a), [o.x, o.z]) - D(this.upos(b), [o.x, o.z]))[0];
      if (cand) { cand.obj = o.id; this.setTask(cand, 'garrison', [o.x, o.z], 'hold ' + o.id); this.note(`${cand.sq.name}: garrison ${o.id}`); }
    }
    // trade space for tickets: a hopeless garrison (enemy far stronger, our tickets low) pulls back instead of dying
    if (this.low) for (const b of live.filter(b => b.role === 'garrison')) {
      const p = pic[b.obj]; if (!p) continue;
      if (p.known > 2.2 * Math.max(1, this.power(b)) && this.power(b) < 4 && b.sq.morale < 60) { this.regroup(b, 'withdraw: outgunned, saving tickets'); b.role = null; this.stats.withdrawals++; }
    }
    // ---- reserve: one mounted squad (or the reinforcement) held back while there is enough in the field
    let res = live.find(b => b.role === 'reserve');
    const mobile = live.filter(b => this.isInf(b) && b.role !== 'garrison');
    if (!res && !this.reserveUsed && mobile.length >= 3 && now > 90 && now - (this.resT || -99) > 60) {
      res = mobile.filter(b => !b.op && b.state !== 'regroup' && b.sq.morale > 55 && b.sq.effective.length >= b.sq.soldiers.length * 0.6).sort((a, b) => (b.v && !b.v.destroyed ? 1 : 0) - (a.v && !a.v.destroyed ? 1 : 0) || (b.fresh ? 1 : 0) - (a.fresh ? 1 : 0))[0];
      if (res) { this.resT = now; if (res.op) res.op.units.delete(res), res.op = null; const st = this.reservePos(); this.setTask(res, 'reserve', st, 'company reserve'); this.note(`${res.sq.name}: company reserve`); }
    }
    if (!res) { const fr = live.find(b => b.fresh && !b.role); if (fr && !this.reserveUsed2) { this.reserveUsed2 = true; this.setTask(fr, 'reserve', this.reservePos(), 'company reserve (reinforcement)'); res = fr; this.reserveUsed = false; } }
    // ---- counterattack a lost objective (reserve + garrison remnants) when the enemy known there is not stronger
    for (const o of g.objectives) {
      if ((o.owner === 'enemy' && !o.contested) || this.ops.some(op => op.obj === o.id && (op.type === 'counter' || op.type === 'attack'))) continue;
      const contested = o.owner === 'enemy' && o.contested;
      if (!(this.lostT[o.id] && now - this.lostT[o.id] < 240) && !contested) continue;
      const cand = live.filter(b => this.isInf(b) && (b.role === 'reserve' || (!b.op && b.role !== 'garrison' && b.state !== 'regroup')) && D(this.upos(b), [o.x, o.z]) < 500);
      const pw = cand.reduce((a, b) => a + this.power(b), 0);
      if (cand.length && pw >= pic[o.id].known * 1.1 && pw >= 4) {
        const op = this.newOp('counter', o.id, cand);
        if (cand.some(b => b.role === 'reserve')) { this.reserveUsed = true; this.stats.reserveCommits.push({ t: Math.round(now), obj: o.id, why: 'counterattack', dt: Math.round(now - (this.lostT[o.id] || now)) }); }
        this.stats.counterOps++; this.note(`COUNTERATTACK on ${o.id} with ${cand.map(b => b.sq.name).join(', ')} (ours ${pw.toFixed(1)} vs known ${pic[o.id].known.toFixed(1)})`);
      }
    }
    // ---- occupy: objectives with nobody known on them (and nobody of ours going). Ticket parity first: while the player
    // holds more points than we do, an empty point is worth a squad taken out of an attack that has not gone in yet
    const held = s => g.objectives.filter(o => o.owner === s).length, behind = held('player') > held('enemy');
    const ourHalf = o => D([o.x, o.z], this.ourSide) - D([o.x, o.z], this.playerSide);
    for (const o of g.objectives.slice().sort((a, c) => ourHalf(a) - ourHalf(c))) {
      if (o.owner === 'enemy' || this.ops.some(op => op.obj === o.id)) continue;
      if (pic[o.id].known > 0.5 || o.owner === 'player') continue;
      let c = free().sort((a, b) => D(this.upos(a), [o.x, o.z]) - D(this.upos(b), [o.x, o.z]));
      if (!c.length && behind) {
        const att = this.ops.find(op => op.type === 'attack' && op.phase !== 'assault' && op.units.size >= 2);
        const q = att && [...att.units].filter(b => b !== att.fix && this.isInf(b)).sort((a, b) => D(this.upos(a), [o.x, o.z]) - D(this.upos(b), [o.x, o.z]))[0];
        if (q) { att.units.delete(q); att.man?.delete(q); q.op = null; c = [q]; }
      }
      const take = c.slice(0, first && c.length > g.objectives.length ? 2 : 1); if (!take.length) continue;
      this.newOp('occupy', o.id, take); this.note(`occupy ${o.id} with ${take.map(b => b.sq.name).join(', ')}`);
    }
    // ---- main effort: a deliberate attack on the objective where the player is weakest / bleeds us most
    if (!this.ops.some(op => op.type === 'attack') && now > this.opCool) {
      const pool = free(); if (res && (now > g.roundLen * 0.45 || this.posture === 'attack' && pool.length < 2)) pool.push(res);
      // behind on points and nothing free: strip garrisons off quiet objectives (nobody known within 300 m for a minute)
      if (pool.length < 2 && behind) for (const b of live.filter(b => b.role === 'garrison' && b.kind !== 'defend' && !I.near(...this.oxz(b.obj), 300, 60).length)) { if (pool.length >= 3) break; b.role = null; if (b.sq.building) b.sq.leaveBuilding(); pool.push(b); }
      const pw = pool.reduce((a, b) => a + this.power(b), 0);
      const cands = g.objectives.filter(o => o.owner !== 'enemy');
      if (pool.length >= 2 && cands.length && !(this.posture === 'hold' && !cands.some(o => o.owner === 'player'))) {
        const cen = pool.reduce((a, b) => { const p = this.upos(b); return [a[0] + p[0] / pool.length, a[1] + p[1] / pool.length]; }, [0, 0]);
        const score = o => (o.owner === 'player' ? 30 : 18) - 3.5 * pic[o.id].known - 10 * (this.objFail[o.id] || 0) - D(cen, [o.x, o.z]) * 0.025 - pic[o.id].armour * 3 + (this.lostT[o.id] ? 6 : 0);
        const best = cands.sort((a, b) => score(b) - score(a))[0];
        // don't throw a weak company at a strong position: wait for the reserve / reinforcement unless time presses
        if (pw >= pic[best.id].known * 0.9 || (now > g.roundLen * 0.6 || this.posture === 'attack') && pw >= pic[best.id].known * 0.6) {
          if (pool.includes(res)) { this.reserveUsed = true; this.stats.reserveCommits.push({ t: Math.round(now), obj: best.id, why: 'main effort' }); }
          this.newOp('attack', best.id, pool);
          this.note(`MAIN EFFORT ${best.id} (score ${score(best).toFixed(1)}, known ${pic[best.id].known.toFixed(1)}) with ${pool.map(b => b.sq.name).join(', ')}`);
        }
      }
    }
    // ---- nobody stands idle: a free squad (rallied, finished its op) joins the nearest running operation, or — when the
    // point count / tickets say we must attack — goes for the nearest objective the player holds as a hasty attack
    for (const b of free()) {
      if (b.role && b.role !== 'idle' && b.role !== 'recon') continue;
      if (b.role === 'recon' && !b.op && g.time - (b.taskT || 0) < 60) continue;   // a lone observer keeps watching for a minute
      const cp = this.upos(b), near = this.ops.filter(op => op.type !== 'consolidate' && D(cp, this.oxz(op.obj)) < 600).sort((p, q) => D(cp, this.oxz(p.obj)) - D(cp, this.oxz(q.obj)))[0];
      if (near) {
        b.op = near; near.units.add(b); b.state = 'advance';
        if (near.type === 'occupy') this.setTask(b, 'occupy', this.oxz(near.obj), 'reinforce: occupy ' + near.obj);
        else { near.man?.add(b); this.setTask(b, near.type === 'counter' ? 'counter' : 'manoeuvre', near.phase === 'assault' ? this.oxz(near.obj) : near.phase === 'recon' ? near.aa : near.ap, `reinforce ${near.type} on ${near.obj}`, { assault: near.phase === 'assault' }); }
        this.note(`${b.sq.name}: joins ${near.type} on ${near.obj}`); continue;
      }
      if (this.posture === 'attack' || behind) {
        const t = g.objectives.filter(o => o.owner !== 'enemy').sort((p, q) => (pic[p.id].known - pic[q.id].known) * 3 + D(cp, [p.x, p.z]) * 0.01 - D(cp, [q.x, q.z]) * 0.01)[0];
        if (t && pic[t.id].known <= this.power(b) * 1.2 + 2) { this.newOp('counter', t.id, [b]); this.note(`${b.sq.name}: hasty attack on ${t.id}`); }
      }
    }
    // ---- armour, ATGM and drones
    for (const b of live) {
      if (b.kind === 'tank') this.planTank(b);
      else if (b.kind === 'atgm') this.planAtgm(b);
      else if (b.kind === 'fpv') this.planFpv(b);
    }
  }
  reservePos() {
    // behind the middle of the held / contested objectives, out of sight: a staging point roughly central
    const g = this.g, obs = g.objectives, c = obs.reduce((a, o) => [a[0] + o.x / obs.length, a[1] + o.z / obs.length], [0, 0]);
    let best = null, bd = 1e9; for (const o of obs) for (const s of STAGING[o.id]) { const d = D(s, c) + D(s, this.ourSide) * 0.15; if (d < bd) { bd = d; best = s; } }
    const [dx, dz] = (() => { const x = this.ourSide[0] - best[0], z = this.ourSide[1] - best[1], L = Math.hypot(x, z) || 1; return [x / L, z / L]; })();
    return this.g.nav.nearestFree(best[0] + dx * 60, best[1] + dz * 60, 0.5, 25);
  }
  newOp(type, obj, units) {
    const g = this.g, op = { id: ++this.opN, type, obj, units: new Set(), phase: type === 'attack' ? 'recon' : type === 'counter' ? 'prep' : 'move', t0: g.time, pt: g.time, p0: 0 };
    for (const b of units) { if (b.op) b.op.units.delete(b); b.op = op; op.units.add(b); b.state = 'advance'; b.wait = 0; }
    op.p0 = [...op.units].reduce((a, b) => a + this.power(b), 0);
    if (type === 'attack' || type === 'counter') this.laneFor(op);
    this.ops.push(op);
    if (type === 'attack' || type === 'counter') this.stats.ops.push({ id: op.id, type, obj, lane: op.lane, t0: Math.round(g.time), res: null });
    this.assignRoles(op);
    return op;
  }
  // choose the approach: three lanes (left flank, centre, right flank) from the assembly area to an attack position
  // ~100 m off the objective; rated by cover along the route, exposure to known positions, and earlier failures
  laneFor(op) {
    const g = this.g, [ox, oz] = this.oxz(op.obj), units = [...op.units];
    const cen = units.reduce((a, b) => { const p = this.upos(b); return [a[0] + p[0] / units.length, a[1] + p[1] / units.length]; }, [0, 0]);
    // assembly area: behind the map's staging point for this objective, at least ~210 m out (out of small-arms reach while
    // the recon element looks), on the side the force comes from
    const st = this.assembly(op.obj, cen), sd = D(st, [ox, oz]), k = Math.max(1, 210 / Math.max(1, sd));
    const aa = op.type === 'counter' ? st : g.nav.nearestFree(ox + (st[0] - ox) * k, oz + (st[1] - oz) * k, 0.5, 30) || st; op.aa = aa;
    const dx = aa[0] - ox, dz = aa[1] - oz, L = Math.hypot(dx, dz) || 1, base = Math.atan2(dx / L, dz / L);
    const threats = this.intel.near(ox, oz, 160, 120), R = Math.min(110, Math.max(60, L * 0.8));
    const fails = this.laneFail[op.obj] || {};
    let best = null;
    op.lanes = {};
    for (const [name, da] of [['L', -0.95], ['C', 0], ['R', 0.95]]) {
      const a = base + da, ap = g.nav.nearestFree(ox + Math.sin(a) * R, oz + Math.cos(a) * R, 0.5, 20); if (!ap) continue;
      const sc = scanLane(g, aa, ap, threats, [ox, oz]); if (!sc) continue;
      const score = sc.cover * 3 - sc.exposure * 0.35 - (fails[name] || 0) * 2.2 + (name === 'C' ? -0.4 : 0) - sc.len * 0.002 + Math.random() * 0.3;
      op.lanes[name] = { ap, score, cover: +sc.cover.toFixed(2), exp: sc.exposure, a };
      if (!best || score > best.score) best = { name, ap, score, a };
    }
    if (!best) { best = { name: 'C', ap: g.nav.nearestFree(ox + dx / L * 80, oz + dz / L * 80, 0.5, 20), a: base }; }
    if (this.lastLane[op.obj] && this.lastLane[op.obj] !== best.name && fails[this.lastLane[op.obj]]) this.stats.laneSwitch++;
    op.lane = best.name; op.ap = best.ap; this.lastLane[op.obj] = best.name;
    // base of fire / observation post: from the side opposite the manoeuvre lane (or the centre), 120-190 m out, with a
    // sight line onto the objective and cover against it
    const fa = best.name === 'C' ? base + (Math.random() < 0.5 ? -0.6 : 0.6) : base - Math.sign(best.a - base) * 0.35;
    op.bof = firePosition(g, [ox, oz], [Math.sin(fa), Math.cos(fa)], 110, 190, 0.5) || g.nav.nearestFree(ox + Math.sin(fa) * 150, oz + Math.cos(fa) * 150, 0.5, 20);
    op.bofA = fa;
  }
  assignRoles(op) {
    const units = [...op.units].filter(b => this.alive(b));
    if (op.type === 'occupy') { for (const b of units) this.setTask(b, 'occupy', this.oxz(op.obj), 'occupy ' + op.obj); return; }
    if (op.type === 'counter') { for (const b of units) this.setTask(b, 'counter', op.ap, `counterattack ${op.obj} via ${op.lane}`); op.man = new Set(units); return; }
    // attack: fix element = a non-assault squad (weakest), the rest manoeuvre; assault squads always manoeuvre
    const fixC = units.filter(b => b.kind !== 'assault').sort((a, b) => this.power(a) - this.power(b));
    const fix = units.length >= 2 ? fixC[0] : null;
    op.fix = fix; op.man = new Set(units.filter(b => b !== fix));
    if (fix) this.setTask(fix, op.phase === 'recon' ? 'recon' : 'fix', op.bof, op.phase === 'recon' ? `observe ${op.obj}` : `base of fire on ${op.obj}`);
    for (const b of op.man) this.setTask(b, 'manoeuvre', op.phase === 'recon' ? op.aa : op.ap, op.phase === 'recon' ? `wait in assembly area for ${op.obj}` : `move to attack position (${op.lane} lane)`);
  }
  endOp(op, res) {
    this.ops.splice(this.ops.indexOf(op), 1);
    const rec = this.stats.ops.find(r => r.id === op.id); if (rec && rec.res !== 'taken') { rec.res = res; rec.t1 = Math.round(this.g.time); }
    for (const b of op.units) { b.op = null; if (b.role !== 'garrison' && b.role !== 'reserve' && b.role !== 'regroup') { b.role = null; } }
    this.note(`op ${op.type} ${op.obj} ${res}`);
  }
  stepOp(op, pic) {
    const g = this.g, now = g.time, o = this.objOf(op.obj), units = [...op.units].filter(b => this.alive(b) && b.op === op);
    op.units = new Set(units);
    if (!units.length) return this.endOp(op, 'no units');
    const pw = units.reduce((a, b) => a + this.power(b), 0);
    if (op.type === 'occupy') {
      if (o.owner === 'enemy' && !o.contested) { const g0 = units[0]; this.endOp(op, 'taken'); g0.obj = op.obj; this.setTask(g0, 'garrison', this.oxz(op.obj), 'hold ' + op.obj); return; }
      if (o.owner === 'player' || pic[op.obj].known > 1.5) {   // somebody is there
        const close = units.some(b => D(this.upos(b), this.oxz(op.obj)) < 260);
        if (close && pic[op.obj].known <= pw * 1.0) {   // meeting engagement, not outclassed: press on (hasty attack)
          this.endOp(op, 'contact -> hasty attack'); this.newOp('counter', op.obj, units); this.note(`hasty attack on ${op.obj} (ours ${pw.toFixed(1)} vs known ${pic[op.obj].known.toFixed(1)})`); return;
        }
        // outclassed / still far: a deliberate attack with more units (the contact was the recon)
        if (!this.ops.some(p => p.type === 'attack')) { this.endOp(op, 'contact -> deliberate attack'); const helpers = this.units.filter(q => this.alive(q) && this.isInf(q) && !q.op && (!q.role || q.role === 'idle') && q.state !== 'regroup' && D(this.upos(q), this.oxz(op.obj)) < 450); if (units.length + helpers.length < 2) {   // alone: observe from cover and wait for the main effort
            this.endOp(op, 'contact, outclassed -> observe'); for (const q of units) { q.obj = op.obj; const c = q.sq.center(), cv = this.coverSpot(c, V3(...this.oxz(op.obj)), 14) || [c.x, c.z]; this.setTask(q, 'recon', cv, `observe ${op.obj}, wait for the main effort`); } return;
          }
          const nop = this.newOp('attack', op.obj, [...units, ...helpers]); nop.phase = 'prep'; nop.pt = now; this.stats.recon++; this.assignRoles(nop); this.note(`contact at ${op.obj}: deliberate attack, ${nop.lane} lane`); }
        else if (pic[op.obj].known <= pw * 0.9) {   // weak opposition: a hasty attack straight off the march
          this.endOp(op, 'contact -> hasty attack'); const nop = this.newOp('counter', op.obj, units); this.note(`hasty attack on ${op.obj} (ours ${pw.toFixed(1)} vs known ${pic[op.obj].known.toFixed(1)})`);
        } else if (now - op.t0 > 90) this.endOp(op, 'contact, main effort elsewhere');
      }
      return;
    }
    if (op.type === 'consolidate') {
      if (now - op.pt > 35) this.endOp(op, 'consolidated');
      return;
    }
    // attack / counter
    const man = [...(op.man || [])].filter(b => op.units.has(b));
    const manP = man.reduce((a, b) => a + this.power(b), 0), manP0 = op.manP0 ??= Math.max(1, manP);
    const broken = man.length === 0 || man.every(b => b.state === 'regroup' || b.sq.routing) || manP < manP0 * 0.4;
    if (o.owner === 'enemy' && !o.contested && (op.phase === 'assault' || op.type === 'counter')) {
      op.type = 'consolidate'; op.phase = 'consolidate'; op.pt = now; const rec = this.stats.ops.find(r => r.id === op.id); if (rec) { rec.res = 'taken'; rec.t1 = Math.round(now); rec.loss = +(op.p0 - pw).toFixed(1); }
      this.objFail[op.obj] = Math.max(0, (this.objFail[op.obj] || 0) - 1);
      const stay = units.filter(b => this.isInf(b)).sort((a, b) => this.power(a) - this.power(b));
      for (const b of stay) this.setTask(b, 'occupy', this.oxz(op.obj), 'consolidate on ' + op.obj);
      if (stay[0]) { stay[0].obj = op.obj; this.setTask(stay[0], 'garrison', this.oxz(op.obj), 'dig in on ' + op.obj); }
      this.note(`${op.obj} TAKEN — consolidating`);
      return;
    }
    if (broken || now - op.t0 > (op.type === 'counter' ? 200 : 330)) {
      this.laneFail[op.obj] ??= {}; this.laneFail[op.obj][op.lane] = (this.laneFail[op.obj][op.lane] || 0) + 1;
      this.objFail[op.obj] = (this.objFail[op.obj] || 0) + 1;
      for (const b of units) if (this.isInf(b) && b.state !== 'regroup') this.regroup(b, `attack on ${op.obj} failed — fall back`, op.aa);
      this.opCool = now + 30;
      return this.endOp(op, broken ? `failed (lane ${op.lane})` : 'timed out');
    }
    const atAP = b => b.arrived || D(this.upos(b), b.task?.dest || op.ap) < 25;
    if (op.phase === 'recon') {
      const f = op.fix && op.units.has(op.fix) ? op.fix : null;
      const seen = this.intel.near(o.x, o.z, 130, 60).length;
      const obsT = f && f.arrived ? now - (f.arrivedT || now) : 0;
      if (!f || seen > 0 && (f.arrived || now - op.pt > 40) || obsT > 25 || now - op.pt > 110 || o.owner === 'player' && now - op.pt > 60) {
        op.phase = 'prep'; op.pt = now; this.stats.recon++; this.assignRoles(op);
        this.note(`${op.obj}: recon done (${seen} positions seen) -> PREP, manoeuvre via ${op.lane} (cover ${op.lanes?.[op.lane]?.cover})`);
      }
      return;
    }
    if (op.phase === 'prep') {
      const ready = man.filter(b => atAP(b) || b.task?.contact).length >= Math.ceil(man.length * 0.6);
      const fixReady = !op.fix || !op.units.has(op.fix) || op.fix.arrived || now - op.pt > 60;
      // fire preparation first (the rounds take ~10-20 s to come down), the assault goes in as it lifts
      if (op.assaultAt == null && ((ready && fixReady) || now - op.pt > (op.type === 'counter' ? 50 : 90))) { this.prepFire(op); op.assaultAt = now + (op.prepped ? 14 : 0); }
      if (op.assaultAt != null && now >= op.assaultAt) {
        op.phase = 'assault'; op.pt = now; op.smoked = false;
        for (const b of man) this.setTask(b, 'manoeuvre', this.oxz(op.obj), `ASSAULT ${op.obj}`, { assault: true });
        if (op.type === 'counter') for (const b of man) b.role = 'counter';
        this.note(`${op.obj}: ASSAULT (${man.length} squads, lane ${op.lane})`);
      }
      return;
    }
  }
  // short = go to ground in the nearest cover / building away from the enemy (30 m) instead of a long run back in the open
  regroup(b, why, to, short = false) {
    const g = this.g, c = this.upos(b), home = to || this.assembly(b.obj || g.objectives[0].id, c);
    const dx = home[0] - c[0], dz = home[1] - c[1], L = Math.hypot(dx, dz) || 1, k = Math.min(L, short ? 30 : 90);
    const fb = V3(c[0] + dx / L * k, c[1] + dz / L * k), thr = V3(c[0] - dx / L * 50, c[1] - dz / L * 50);
    const sq = b.sq; if (!sq || sq.routing) return;
    const bld = this.buildingBehind(V3(c[0], c[1]), V3(dx / L, dz / L), short ? 35 : 80, sq);
    if (bld && Math.random() < 0.6) sq.orderGarrison(bld);
    else { const cv = this.coverSpot(fb, thr, 18) || [fb.x, fb.z]; sq.orderMove(cv[0], cv[1], Math.atan2(-dx, -dz), 14, true); }
    b.state = 'regroup'; b.regroupT = g.time + (short ? 18 : 30) + Math.random() * 15; b.wait = 6; b.role = 'regroup'; b.task = { dest: [fb.x, fb.z], why };
    if (b.op) { b.op.units.delete(b); b.op = null; }
    this.note(`${sq.name}: ${why}`);
  }
  // ---------------------------------------------------------------- fire support (rationed like the player's)
  mission(x, z, why, err = 18) {
    const g = this.g, own = this.spg && !this.spg.destroyed && this.spg.weapons[0].ammo > 0 && !this.spg.spg.mission ? this.spg : null;
    const ap = V3(x + (Math.random() - .5) * err, z + (Math.random() - .5) * err), ad = own ? Math.hypot(ap.x - own.pos.x, ap.z - own.pos.z) : 0;
    if (own && (ad >= own.def.minRange || (ad <= own.def.directRange && own.spgSees(ap)))) { own.fireAt = { p: ap }; this.note(`howitzer mission: ${why}`); this.stats.fires++; this.lastFire = g.time; return true; }
    if ((g.enemyMortars ??= (g.campaign?.enemyMortars ?? TUNING.mortarStrikes)) <= 0) return false;
    g.enemyMortars--; g.callStrike(ap.x, ap.z, 6, 16, 'enemy', 9, 'mortar'); g.hud?.alert('Incoming mortar fire!', 'bad');
    this.note(`mortar mission (${g.enemyMortars} left): ${why}`); this.stats.fires++; this.lastFire = g.time; return true;
  }
  // before an assault: on the strongest spotted position at / around the objective
  prepFire(op) {
    const [ox, oz] = this.oxz(op.obj), cl = this.intel.cluster(60, [ox, oz], 90);
    if (cl && this.mission(cl.e.x, cl.e.z, `prep fire on ${op.obj}`, cl.e.dug ? 12 : 20)) { op.prepped = true; this.stats.prepFires++; }
  }
  // standing fire plan: a counter-battery shot at a player howitzer that keeps firing (sound ranging), enemy massing in
  // the open near a held objective; one mission is kept back for the next assault
  fireSupport() {
    const g = this.g; if (g.time - (this.lastFire ?? -99) < 50) return;
    const pg = g.vehicles.find(v => v.side === 'player' && v.kind === 'spg' && !v.destroyed && g.time - (v.lastFireT ?? -999) < 60);
    if (pg && this.spg && !this.spg.destroyed && Math.random() < 0.3) { if (this.mission(pg.pos.x, pg.pos.z, 'counter-battery', 45)) g.hud?.alert('Enemy counter-battery fire on our howitzer!', 'bad'); return; }
    const left = g.enemyMortars ?? (g.campaign?.enemyMortars ?? TUNING.mortarStrikes), ownGun = this.spg && !this.spg.destroyed && this.spg.weapons[0].ammo > 0;
    if (left <= 1 && !ownGun) return;
    for (const o of g.objectives) {
      if (o.owner !== 'enemy' && !(this.lostT[o.id] && g.time - this.lostT[o.id] < 200)) continue;
      const cl = this.intel.cluster(15, [o.x, o.z], 160);
      if (cl && cl.score >= (ownGun ? 5 : 8) && !cl.e.dug) { this.mission(cl.e.x, cl.e.z, `enemy massing near ${o.id}`); return; }
      if (cl && cl.score >= 6 && cl.e.dug && o.owner === 'player') { this.mission(cl.e.x, cl.e.z, `enemy dug in on ${o.id}`, 12); return; }
    }
  }
  // ---------------------------------------------------------------- armour
  // tanks: hull-down overwatch on the main effort (or the most threatened held objective), never closer to known
  // infantry with RPGs than the own infantry; move up behind the assault; turn on spotted enemy armour
  planTank(b) {
    const g = this.g, v = b.v; if (b.retreating) return;
    const op = this.ops.find(p => p.type === 'attack' || p.type === 'counter' || p.type === 'consolidate');
    const arm = this.intel.armour(45).filter(e => D([e.x, e.z], [v.pos.x, v.pos.z]) < 500).sort((a, c) => D([a.x, a.z], [v.pos.x, v.pos.z]) - D([c.x, c.z], [v.pos.x, v.pos.z]))[0];
    let tgt, why, r0 = 170, r1 = 280;
    // short of infantry and behind on points: a tank parks on an empty objective (vehicles count for the capture)
    const held = s => g.objectives.filter(o => o.owner === s).length;
    if (!arm && held('player') > held('enemy')) {
      const o = g.objectives.filter(o => o.owner === 'neutral' && this.pic[o.id].known < 0.5 && !this.intel.near(o.x, o.z, 200, 45).length && !this.ops.some(op => op.obj === o.id && op.type !== 'consolidate') && !this.units.some(t => t !== b && t.kind === 'tank' && t.occ === o.id)).sort((a, c) => D([a.x, a.z], [v.pos.x, v.pos.z]) - D([c.x, c.z], [v.pos.x, v.pos.z]))[0];
      if (o) { if (b.occ !== o.id) { b.occ = o.id; b.posKey = 'occ' + o.id; this.setTask(b, 'occupy', g.nav.nearestFree(o.x, o.z, 2.2, 15), `park on empty ${o.id}`); b.moved = false; this.note(`${v.name}: park on empty objective ${o.id}`); } return; }
    }
    if (b.occ && this.objOf(b.occ)?.owner !== 'enemy' && !this.intel.near(...this.oxz(b.occ), 200, 45).length) return;   // still taking it
    b.occ = null;
    if (arm && arm.u.kind !== 'btr') { tgt = [arm.x, arm.z]; why = `engage enemy ${arm.u.kind}`; v.focus = arm.u; r0 = 220; r1 = 380; }
    else if (op) { tgt = this.oxz(op.obj); why = `${op.phase === 'assault' ? 'support assault' : 'overwatch'} ${op.obj}`; if (op.phase === 'assault' || op.phase === 'consolidate') { r0 = 90; r1 = 150; } }
    else { const h = g.objectives.filter(o => o.owner === 'enemy').sort((a, c) => this.pic[c.id].known - this.pic[a.id].known)[0] || g.objectives[0]; tgt = [h.x, h.z]; why = `overwatch held ${h.id}`; r0 = 120; r1 = 200; }
    const key = `${Math.round(tgt[0] / 40)},${Math.round(tgt[1] / 40)},${r0}`;
    if (b.posKey === key && b.task?.dest) return;
    const back = this.toUs(op?.obj || b.obj || g.objectives[0].id);
    const p = firePosition(g, tgt, back, r0, r1, 0.75, true); if (!p) return;
    b.posKey = key; this.setTask(b, 'overwatch', p, why); b.moved = false;
  }
  thinkTank(b) {
    const v = b.v, g = this.g; if (v.destroyed) { b.dead = true; return; }
    if (v.crew < 2 || v.hp < v.def.hp * (this.cautious() ? 0.5 : 0.4) || v.weapons[0].ammo <= 0) {
      if (!b.retreating) { b.retreating = true; this.stats.vehRetreats++; const h = this.assembly(b.obj || g.objectives[0].id, [v.pos.x, v.pos.z]); const p = g.nav.nearestFree(h[0] + (this.ourSide[0] - h[0]) * 0.3, h[1] + (this.ourSide[1] - h[1]) * 0.3, 2.2, 30); v.orderMove(p[0], p[1], null, true); this.setTask(b, 'regroup', p, 'damaged — pulling back'); this.note(`${v.name}: damaged, pulling back`); }
      return;
    }
    // RPG stand-off: known enemy infantry close and none of ours: back off
    const rpg = this.intel.rpgNear(v.pos.x, v.pos.z, 80), fr = this.friendsNear(v.pos, 45);
    if (rpg > 0 && fr === 0 && !v.path) {
      const away = new THREE.Vector3(); for (const e of this.intel.near(v.pos.x, v.pos.z, 80, 30)) away.add(V3(v.pos.x - e.x, v.pos.z - e.z).normalize());
      if (away.lengthSq() < 0.01) away.set(this.ourSide[0] - v.pos.x, 0, this.ourSide[1] - v.pos.z); away.normalize();
      const [x, z] = g.nav.nearestFree(v.pos.x + away.x * 50, v.pos.z + away.z * 50, 2.2, 20); v.orderMove(x, z); b.task = { ...b.task, why: 'RPG stand-off' }; return;
    }
    if (b.task?.dest && !b.moved) { b.moved = true; v.orderMove(b.task.dest[0], b.task.dest[1], null, false); return; }
    if (b.task?.dest && !v.path && D([v.pos.x, v.pos.z], b.task.dest) < 15) b.arrived = true;
    if (!v.path && b.task?.dest && D([v.pos.x, v.pos.z], b.task.dest) > 25 && g.time - (b.reT || 0) > 15) { b.reT = g.time; v.orderMove(b.task.dest[0], b.task.dest[1], null, false); }
  }
  // carriers after their squad got out: support by fire from a hull-down spot near the squad; pull back when hurt
  thinkCarrier(b) {
    const v = b.v, sq = b.sq, g = this.g; if (!v || v.destroyed || sq.mounted) return;
    if (v.hp < v.def.hp * (this.cautious() ? 0.5 : 0.4) && !b.vRetreat) { b.vRetreat = true; this.stats.vehRetreats++; const h = this.assembly(b.obj || g.objectives[0].id, [v.pos.x, v.pos.z]); v.orderMove(h[0], h[1], null, true); this.note(`${v.name}: damaged, pulling back`); return; }
    if (b.vRetreat || v.path) return;
    if (b.role === 'reserve' || b.role === 'garrison') return;
    const c = sq.center(), rpg = this.intel.rpgNear(v.pos.x, v.pos.z, 75);
    if (rpg > 0 && c.distanceTo(v.pos) > 35) { const d = V3(v.pos.x - c.x, v.pos.z - c.z); if (d.lengthSq() < 1) d.set(this.ourSide[0] - v.pos.x, 0, this.ourSide[1] - v.pos.z); d.normalize(); const [x, z] = g.nav.nearestFree(c.x + d.x * 45, c.z + d.z * 45, 2.0, 20); v.orderMove(x, z); return; }
    if (g.time - (b.vT || 0) < 20) return; b.vT = g.time;
    const tgt = b.task?.dest || [c.x, c.z], d = v.pos.distanceTo(c);
    if (d > 70 || D([v.pos.x, v.pos.z], tgt) < 60) {
      const p = firePosition(g, tgt, this.toUs(b.op?.obj || b.obj), Math.max(60, Math.min(120, D([c.x, c.z], tgt) + 40)), Math.max(100, D([c.x, c.z], tgt) + 90), 0.6, true, null);
      if (p && D(p, [v.pos.x, v.pos.z]) > 12) v.orderMove(p[0], p[1]);
    }
  }
  // ---------------------------------------------------------------- ATGM / FPV
  // ATGM team: on the armour avenue — a firing position with a long sight line onto known enemy armour, else onto the
  // approach the enemy's armour would use towards the main effort / held objective
  planAtgm(b) {
    const g = this.g, sq = b.sq; if (sq.routing) return;
    const arm = this.intel.armour(60).sort((a, c) => (c.u.kind === 'tank' ? 1 : 0) - (a.u.kind === 'tank' ? 1 : 0))[0];
    const op = this.ops.find(p => p.type === 'attack' || p.type === 'counter');
    let tgt, why, obj = op?.obj || g.objectives.filter(o => o.owner === 'enemy')[0]?.id || b.obj;
    if (arm) { tgt = [arm.x, arm.z]; why = `ambush enemy ${arm.u.kind}`; sq.focus = arm.u; }
    else { tgt = this.armourAvenue(obj); why = `cover armour avenue to ${obj}`; }
    const key = `${Math.round(tgt[0] / 60)},${Math.round(tgt[1] / 60)}`;
    if (b.posKey === key && b.task?.dest) return;
    const hot = sq.underFireT < 3 && sq.morale < 55;
    if (b.task?.dest && !hot && g.time - (b.taskT || 0) < 40) return;
    const p = firePosition(g, tgt, this.toUs(obj), 230, 420, 0.8, false); if (!p) return;
    b.posKey = key; this.setTask(b, 'overwatch', p, why); b.sent = false; this.stats.atgmMoves++;
  }
  // where enemy armour would come from towards objective `obj`: the road / track cell (vehicles prefer roads, nav.js
  // findPathV) on the player's side of it, 80-260 m out; else a point 110 m out on that side
  armourAvenue(obj) {
    const nav = this.g.nav, [ox, oz] = this.oxz(obj), t = this.toThem(obj);
    let best = [ox + t[0] * 110, oz + t[1] * 110], bs = 0;
    for (let r = 80; r <= 260; r += 30) for (let l = -60; l <= 60; l += 15) {
      const x = ox + t[0] * r - t[1] * l, z = oz + t[1] * r + t[0] * l, rd = nav.roadAt?.(x, z) || 0;
      const sc = rd > 0 ? 1 + rd * 0.1 - Math.abs(l) * 0.004 - Math.abs(r - 150) * 0.002 : 0;
      if (sc > bs) { bs = sc; best = [x, z]; }
    }
    return best;
  }
  thinkAtgm(b) {
    const sq = b.sq; if (sq.routing) return;
    const hot = sq.underFireT < 2.5 && sq.morale < 55;
    if (hot && g_now(this) - (b.hotT || 0) > 30) { b.hotT = g_now(this); b.posKey = null; b.taskT = -99; this.planAtgm(b); }   // launch signature: relocate
    const moving = sq.effective.some(s => (s.path && s.pathI < s.path.length) || s.pathReq);
    if (!b.task?.dest || moving) return;
    if (!b.sent) { b.sent = true; const [x, z] = b.task.dest; sq.orderMove(x, z, Math.atan2(this.playerSide[0] - x, this.playerSide[1] - z), 10, hot); }
    else b.arrived = true;
  }
  planFpv(b) {
    const g = this.g, sq = b.sq;
    const arm = this.intel.armour(30)[0], op = this.ops.find(p => p.type === 'attack' || p.type === 'counter');
    if (arm) sq.focus = arm.u;
    else if (op) { const e = this.intel.near(...this.oxz(op.obj), 120, 20).sort((a, c) => c.pow - a.pow)[0]; if (e) sq.focus = e.u; }
    if (!b.task?.dest) { const obj = op?.obj || b.obj, st = this.assembly(obj, this.upos(b)), [dx, dz] = this.toUs(obj); const p = g.nav.nearestFree(st[0] + dx * 70, st[1] + dz * 70, 0.5, 20); this.setTask(b, 'support', p, 'drone team: strike spotted targets'); b.sent = false; }
  }
  thinkFpv(b) {
    const sq = b.sq; if (sq.routing || !b.task?.dest) return;
    const moving = sq.effective.some(s => (s.path && s.pathI < s.path.length) || s.pathReq);
    if (!moving && !b.sent) { b.sent = true; sq.orderMove(b.task.dest[0], b.task.dest[1], 0, 10, true); }
  }
  // ---------------------------------------------------------------- per-unit execution
  think(b) {
    const g = this.g;
    if (b.kind === 'spg') return this.thinkSpg(b);
    if (b.kind === 'tank' || b.kind === 'vdefend') return this.thinkTank(b);
    const sq = b.sq;
    if (sq.destroyed || !sq.effective.length) { b.dead = true; if (b.op) b.op.units.delete(b); if (b.v && !b.v.destroyed) { const h = this.assembly(b.obj || g.objectives[0].id, [b.v.pos.x, b.v.pos.z]); b.v.orderMove(h[0], h[1]); } return; }
    if (b.kind === 'atgm') return this.thinkAtgm(b);
    if (b.kind === 'fpv') return this.thinkFpv(b);
    if (b.v && !b.v.destroyed && !sq.mounted) this.thinkCarrier(b);
    if (sq.mounted) return this.thinkMounted(b);
    if (sq.routing) { b.state = 'routed'; return; }
    if (b.state === 'routed') { this.regroup(b, 'rallied after breaking — regroup'); return; }
    const c = sq.center(), cp = [c.x, c.z];
    const moving = sq.effective.some(s => (s.path && s.pathI < s.path.length) || s.pathReq || s.waitTeam);
    if (b.wait > 0) { b.wait -= 1.5; return; }
    if (sq.order?.type === 'storm' || sq.order?.type === 'clear') return;
    // regrouping: out of contact until the nerve is back, then back into the pool
    if (b.state === 'regroup') {
      if (moving) return;
      if (g.time > b.regroupT && sq.morale > 45 && sq.underFireT > 6) { b.state = 'advance'; if (!b.op || b.role === 'regroup') { b.role = null; b.task = null; } if (sq.building) sq.leaveBuilding(); }
      else b.wait = 4;
      return;
    }
    // strongpoint taken in contact: hold it until the fire slackens and friends are about, then carry on with the task
    if (b.state === 'strongpoint') {
      if (!sq.building && !sq.trench && !moving) b.state = 'advance';
      else if (g.time > b.holdT && sq.morale > 50 && sq.underFireT > 4 && (this.friendsNear(c, 90) >= 1 || g.time > b.holdT + 30)) { b.state = 'advance'; sq.leaveBuilding(); }
      else { b.wait = 3; return; }
    }
    // mauled / shaken and locally outgunned: pull back (garrisons hold unless it is hopeless)
    const strength = sq.effective.length / sq.soldiers.length, careful = this.cautious();
    const onObj = (b.role === 'occupy' || b.role === 'manoeuvre' || b.role === 'counter') && b.op && D(cp, this.oxz(b.op.obj)) < 40;
    if (b.role !== 'garrison' && !onObj && !sq.building && !sq.trench && (strength <= (careful ? 0.5 : 0.4) || sq.morale < (careful ? 34 : 28))) {
      const loc = this.intel.strength(c.x, c.z, 120, 30), mine = this.power(b) + this.friendsNear(c, 90) * 3;
      if (loc > mine * 1.2 || sq.morale < 20) { this.regroup(b, strength < 0.5 ? 'too many casualties — fall back' : 'shaken — fall back', null, sq.morale >= 20 && strength > 0.3); return; }
    }
    if (sq.morale < 30) { if (!moving && sq.underFireT < 3 && !sq.building && !sq.trench) { const bld = this.nearBuilding(c, 30, sq); if (bld) sq.orderGarrison(bld); } b.wait = 6; return; }
    if (moving) return;
    const role = b.role || 'idle';
    if (role === 'garrison') return this.holdObjective(b, b.obj);
    if (role === 'idle') { if (!sq.building && !sq.trench && sq.underFireT > 6) { const st = this.assembly(b.obj || g.objectives[0].id, cp); if (D(cp, st) > 40) this.moveInf(b, st, { why: 'to assembly area' }); } return; }
    if (role === 'reserve') {
      if (!b.task?.dest || D(cp, b.task.dest) < 18) { if (!sq.building && !sq.trench && !b.arrived) { b.arrived = true; const bld = this.nearBuilding(c, 25, sq); if (bld) sq.orderGarrison(bld); } return; }
      return this.moveInf(b, b.task.dest, { why: 'to reserve position', run: true });
    }
    const op = b.op;
    if (role === 'occupy') {
      const [ox, oz] = b.task.dest;
      if (D(cp, [ox, oz]) < 22) return this.holdObjective(b, op?.obj || b.obj);
      if (op && op.type === 'occupy' && this.intel.near(ox, oz, 250, 45).length) return this.fight(b, op);   // contact: fire and manoeuvre onto it
      return this.moveInf(b, [ox, oz], { why: b.task.why, final: D(cp, [ox, oz]) < 70 });
    }
    if (role === 'recon' || role === 'fix') {
      if (op && (op.phase === 'consolidate')) return this.holdObjective(b, op.obj);
      const dest = b.task.dest;
      if (D(cp, dest) < 16 || (b.task.contact && g.time - b.task.contact < 20)) {
        if (!b.arrived) { b.arrived = true; b.arrivedT = g.time; }
        // in the base of fire: keep the heads down of whatever is known on / around the objective
        const [ox, oz] = this.oxz(op?.obj || b.obj), e = this.intel.near(ox, oz, 140, 20).sort((a, c2) => D([a.x, a.z], cp) - D([c2.x, c2.z], cp))[0];
        if (e) sq.focus = e.u;
        if (!sq.building && !sq.trench && !b.bofSet) { b.bofSet = true; const bld = this.nearBuilding(c, 14, sq); if (bld && Math.random() < 0.6) sq.orderGarrison(bld); else { const cv = this.coverSpot(c, V3(ox, oz), 8); if (cv) sq.orderMove(cv[0], cv[1], Math.atan2(ox - cv[0], oz - cv[1]), 12, false); } }
        return;
      }
      b.bofSet = false;
      // contact on the way: an observation post / base of fire found early — stay if it sees the objective
      const ct = this.contactNear(sq, c, 160);
      if (ct && role === 'recon') { b.task.contact = g.time; const cv = this.coverSpot(c, ct.p, 12); if (cv) sq.orderMove(cv[0], cv[1], Math.atan2(ct.p.x - cv[0], ct.p.z - cv[1]), 12, false); b.wait = 6; return; }
      return this.moveInf(b, dest, { why: b.task.why, careful: role === 'recon' });
    }
    if (role === 'manoeuvre' || role === 'counter') {
      if (!op) { b.role = null; return; }
      if (op.phase === 'recon') { if (D(cp, b.task.dest) > 25) this.moveInf(b, b.task.dest, { why: b.task.why }); else if (!sq.building && !sq.trench && !b.arrived) { b.arrived = true; const cv = this.coverSpot(c, V3(...this.oxz(op.obj)), 12); if (cv) sq.orderMove(cv[0], cv[1], null, 14, false); } return; }
      if (op.phase === 'prep' || (op.type === 'counter' && op.phase !== 'assault')) {
        if (D(cp, b.task.dest) < 22) { if (!b.arrived) { b.arrived = true; const cv = this.coverSpot(c, V3(...this.oxz(op.obj)), 10); if (cv) sq.orderMove(cv[0], cv[1], Math.atan2(op.obj ? this.oxz(op.obj)[0] - cv[0] : 0, this.oxz(op.obj)[1] - cv[1]), 14, false); } return; }
        return this.moveInf(b, b.task.dest, { why: b.task.why, flankFrom: this.oxz(op.obj) });
      }
      if (op.phase === 'assault') { if (!op.smoked && !b.smokeTried) { b.smokeTried = true; this.assault(b, op); } else this.fight(b, op); return; }
      if (op.phase === 'consolidate') return this.holdObjective(b, op.obj);
    }
  }
  // the squad rides until the dismount point: short of the objective / known enemy, out of contact
  thinkMounted(b) {
    const sq = b.sq, v = b.v || sq.carrier, g = this.g; if (!v) return;
    const dest = b.role === 'reserve' ? b.task?.dest : b.task?.dest || (b.op ? this.oxz(b.op.obj) : null);
    if (!dest) return;
    const vp = [v.pos.x, v.pos.z], tgtObj = b.op ? this.oxz(b.op.obj) : dest;
    const known = this.intel.near(v.pos.x, v.pos.z, b.role === 'occupy' ? 120 : 230, 40).length;
    const danger = sq.underFireT < 2 || v.hp < v.def.hp * 0.8 || known > 0 || v.destroyed || v.immobile;
    if (b.role === 'reserve') {
      if (danger && known && !v.destroyed) { sq.dismount(); b.state = 'advance'; return; }
      // at the reserve position the men get out and go to cover / a building: a parked carrier full of men is a target
      if (!v.path && D(vp, dest) <= 25) { sq.dismount(); b.state = 'advance'; b.arrived = false; return; }
      if (!v.path && D(vp, dest) > 20) v.orderMove(dest[0], dest[1], null, true);
      return;
    }
    const near = D(vp, tgtObj) < (b.role === 'occupy' && !known ? 70 : 200);
    if (danger || near || (!v.path && D(vp, dest) < 30)) {
      if (!v.destroyed) v.halt();
      sq.dismount(Math.atan2(tgtObj[0] - v.pos.x, tgtObj[1] - v.pos.z)); b.state = 'advance'; b.wait = 2;
      this.note(`${sq.name}: dismount ${danger ? '(contact)' : 'short of ' + (b.op?.obj || '')}`);
      return;
    }
    if (!v.path || g.time - (b.mvT || 0) > 25) { b.mvT = g.time; const d = b.role === 'occupy' ? dest : dest; v.orderMove(d[0], d[1], null, true); }
  }
  // one bound towards dest: ~30-40 m along the route, ending in the best cover against the known threat; bounding by
  // fire teams when the enemy is near; contact on the way -> fire and manoeuvre instead
  moveInf(b, dest, o = {}) {
    const g = this.g, sq = b.sq, c = sq.center(), cp = [c.x, c.z], dist = D(cp, dest);
    const ct = this.contactNear(sq, c, 170);
    if (ct && !o.final && this.react(b, ct, dest, o)) return;
    const path = g.nav.findPath(c.x, c.z, dest[0], dest[1], 0.45, false, 60000);
    if (!path || path.length < 2) { sq.orderMove(dest[0], dest[1], null, 16, true); b.wait = 4; return; }
    // nobody known near the route's next stretch and not under fire: one long move (bounding only near the enemy)
    const quiet = !this.intel.near((c.x + dest[0]) / 2, (c.z + dest[1]) / 2, Math.max(200, dist / 2 + 120), 45).length && sq.underFireT > 8;
    const step = dist < 45 ? dist + 2 : quiet ? Math.min(dist + 2, 140) : (o.careful ? 26 : 32) + Math.random() * 12;
    let acc = 0, px = c.x, pz = c.z, tx = dest[0], tz = dest[1];
    for (const [x, z] of path) { const d = Math.hypot(x - px, z - pz); if (acc + d >= step) { const f = (step - acc) / d; tx = px + (x - px) * f; tz = pz + (z - pz) * f; break; } acc += d; px = x; pz = z; tx = x; tz = z; }
    const thr = this.intel.near(tx, tz, 260, 60).sort((a, e) => D([a.x, a.z], [tx, tz]) - D([e.x, e.z], [tx, tz]))[0];
    const T = thr ? V3(thr.x, thr.z) : o.flankFrom ? V3(...o.flankFrom) : null;
    if (T && dist > 30) { const cv = this.coverSpot(V3(tx, tz), T, 9); if (cv) [tx, tz] = cv; }
    const near = !!thr || sq.underFireT < 6;
    sq.orderMove(tx, tz, T ? Math.atan2(T.x - tx, T.z - tz) : null, near ? 14 : 18, !near || o.run, false, near && sq.effective.length > 3);
    b.bound = (b.bound || 0) + 1; b.wait = near ? 4 + Math.random() * 4 : 2 + Math.random() * 3;
  }
  // in contact while moving: outgunned -> go to ground in cover; else one team fires while the other bounds forward to
  // cover offset to the flank side; smoke when the next bound crosses ground the enemy can see
  react(b, ct, dest, o) {
    const g = this.g, sq = b.sq, c = sq.center(), T = ct.p;
    const local = this.intel.strength(c.x, c.z, 100, 20), mine = this.power(b) + this.friendsNear(c, 70) * 3;
    if (b.task) b.task.contact = g.time;
    // a building / trench right here facing the contact: fight from it for a while (strongpoint) instead of in the open
    if (b.kind !== 'assault' && !sq.trench && !sq.building && ct.d < 170 && local >= mine * 0.6) {
      const tr = this.freeTrench(c.x, c.z, 30, sq);
      if (tr && Math.random() < 0.8) { sq.orderTrench(tr); b.state = 'strongpoint'; b.holdT = g.time + 25 + Math.random() * 25; b.wait = 5; return true; }
      const bld = this.nearBuilding(c, 26, sq);
      if (bld && Math.random() < 0.75) { sq.orderGarrison(bld); b.state = 'strongpoint'; b.holdT = g.time + 25 + Math.random() * 25; b.wait = 5; return true; }
    }
    if (local > mine * 1.3 && sq.morale < 70) { const cv = this.coverSpot(c, T, 14); if (cv) sq.orderMove(cv[0], cv[1], Math.atan2(T.x - cv[0], T.z - cv[1]), 12, true); b.wait = 7 + Math.random() * 5; return true; }
    // keep heading for the destination, but in short covered bounds; bias to the side away from the contact's front
    const ax = dest[0] - c.x, az = dest[1] - c.z, L = Math.hypot(ax, az) || 1, ux = ax / L, uz = az / L;
    const side = Math.sign((T.x - c.x) * uz - (T.z - c.z) * ux) || 1;   // contact left/right of our line of advance
    const want = Math.min(26, Math.max(10, L - 10));
    const base = V3(c.x + ux * want - uz * side * 10, c.z + uz * want + ux * side * 10);
    const cv = this.coverSpot(base, T, 14) || [base.x, base.z];
    const open = covered(g, cv[0], cv[1], T.x, T.z) < 0.5;
    if (open && (b.smokes ?? 2) > 0 && ct.d < 200) { const th = sq.effective.find(s => !s.inside); if (th) { b.smokes = (b.smokes ?? 2) - 1; g.combat.throwSmoke(th, V3((c.x + T.x) / 2, (c.z + T.z) / 2)); } }
    sq.focus = ct.u; sq.orderMove(cv[0], cv[1], Math.atan2(T.x - cv[0], T.z - cv[1]), 14, true, false, sq.effective.length > 3);
    b.wait = 5 + Math.random() * 5; return true;
  }
  // the close fight onto an objective: the v1 fire-and-manoeuvre micro (bounding by fire teams, strongpoints in buildings /
  // trenches taken in contact, storming garrisons, smoke) with the objective, the flank side (from the chosen lane) and the
  // threat picture (Intel — threatsNear is overridden above) set by the v2 plan
  fight(b, op) {
    const sq = b.sq, c = sq.center(), [ox, oz] = this.oxz(op.obj);
    b.obj = op.obj; if (b.state === 'approach' || b.state === 'routed' || !b.state) b.state = 'advance';
    if (b.state === 'hold' && this.objOf(op.obj).owner !== 'enemy' && D([c.x, c.z], [ox, oz]) > 25) b.state = 'advance';
    if (op.ap && b.flankOp !== op.id) { b.flankOp = op.id; const dx = ox - c.x, dz = oz - c.z, L = Math.hypot(dx, dz) || 1, dot = (op.ap[0] - c.x) * (-dz / L) + (op.ap[1] - c.z) * (dx / L); b.flank = op.lane === 'C' ? 0 : Math.sign(dot) || 1; }
    const kind = b.kind; if (kind === 'defend') b.kind = 'foot';
    b.task.why = `${op.type === 'occupy' ? 'take' : 'assault'} ${op.obj} (fire & manoeuvre${b.flank ? ', ' + (b.flank < 0 ? 'left' : 'right') + ' flank' : ''})`;
    try { super.think(b); } finally { if (kind === 'defend') b.kind = kind; }
  }
  // final assault on the objective: clear trenches / storm buildings held by the enemy there, smoke across the open
  assault(b, op) {
    const g = this.g, sq = b.sq, c = sq.center(), [ox, oz] = this.oxz(op.obj), dObj = Math.hypot(c.x - ox, c.z - oz);
    if (!op.smoked) {   // one screen for the whole assault, between the strongest known position and the attackers
      const e = this.intel.near(ox, oz, 120, 60).sort((a, e2) => e2.pow - a.pow)[0], th = sq.effective.find(s => !s.inside);
      if (th && (b.smokes ?? 2) > 0) { const T = e ? V3(e.x, e.z) : V3(ox, oz); if (!covered(g, c.x, c.z, T.x, T.z) || dObj > 50) { b.smokes = (b.smokes ?? 2) - 1; g.combat.throwSmoke(th, V3(c.x + (T.x - c.x) * 0.55, c.z + (T.z - c.z) * 0.55)); op.smoked = true; this.stats.smokeAssault++; } }
    }
    if (dObj < 100) {
      const Tp = (g.city.trenchSystems || []).filter(T => Math.hypot(T.center[0] - ox, T.center[1] - oz) < T.radius + 60 && trenchMen(g, T, 'player').length).sort((p, q) => Math.hypot(p.center[0] - c.x, p.center[1] - c.z) - Math.hypot(q.center[0] - c.x, q.center[1] - c.z))[0];
      if (Tp && (b.kind === 'assault' || sq.effective.length >= 4) && Math.hypot(Tp.center[0] - c.x, Tp.center[1] - c.z) < Tp.radius + 100) { sq.orderClearTrench(Tp); b.wait = 8; return; }
      const tb = g.allBuildings().filter(bl => !bl.collapsedAll && Math.hypot(bl.x - ox, bl.z - oz) < 45 && bl.slots.some(sl => sl.occupant && sl.occupant.squad.side === 'player' && sl.occupant.effective)).sort((p, q) => Math.hypot(p.x - c.x, p.z - c.z) - Math.hypot(q.x - c.x, q.z - c.z))[0];
      if (tb && (b.kind === 'assault' || sq.effective.length >= 4) && Math.hypot(tb.x - c.x, tb.z - c.z) < 110) { sq.orderGarrison(tb); b.wait = 6; return; }
    }
    if (dObj < 20) return this.holdObjective(b, op.obj);
    this.moveInf(b, [ox, oz], { why: 'assault', final: dObj < 60, run: true });
    b.wait = Math.min(b.wait, dObj < 60 ? 2 : 4);
  }
  // hold an objective: trench first, else a building with windows onto the enemy's side, else cover facing them
  holdObjective(b, id) {
    const g = this.g, sq = b.sq, [ox, oz] = this.oxz(id || b.obj || g.objectives[0].id), c = sq.center();
    if (sq.building || sq.trench || sq.order?.type === 'garrison') return;
    if (g.time - (b.holdTry || 0) < 6) return; b.holdTry = g.time;
    const T = this.freeTrench(ox, oz, 60, sq); if (T && Math.random() < 0.8) { sq.orderTrench(T); return; }
    const bld = this.fieldOfFireBuilding(ox, oz, 34, sq, this.toThem(id || b.obj)); if (bld && Math.random() < 0.8) { sq.orderGarrison(bld); return; }
    if (Math.hypot(c.x - ox, c.z - oz) > 14 || !b.dugIn) {
      b.dugIn = true; const t = this.toThem(id || b.obj), thr = V3(ox + t[0] * 120, oz + t[1] * 120);
      const cv = this.coverSpot(V3(ox, oz), thr, 14) || [ox, oz]; sq.orderMove(cv[0], cv[1], Math.atan2(t[0], t[1]), 14, false);
    }
  }
  // a building at the objective with windows onto the enemy's approach (free slots whose facade faces `dir`)
  fieldOfFireBuilding(ox, oz, r, sq, dir) {
    let best = null, bs = 0;
    for (const bl of this.g.allBuildings()) {
      if (bl.collapsedAll || Math.hypot(bl.x - ox, bl.z - oz) > r + Math.max(bl.L || 0, bl.D || 0) / 2) continue;
      if (bl.slots.some(s => s.occupant && s.occupant.squad.side !== sq.side)) continue;
      let n = 0, f = 0; for (const s of bl.slots) { if (s.occupant || s.panel.gone) continue; n++; const o = bl.outward(s.panel); if (o.x * dir[0] + o.z * dir[1] > 0.4) f++; }
      if (n < Math.min(4, sq.effective.length)) continue;
      const sc = Math.min(f, sq.effective.length) * 2 + Math.min(n, 8) * 0.3 - Math.hypot(bl.x - ox, bl.z - oz) * 0.05;
      if (sc > bs) { bs = sc; best = bl; }
    }
    return best;
  }
  // ---------------------------------------------------------------- debug
  debugLines() {
    const g = this.g, L = [];
    L.push(`ENEMY CMD v2  t=${Math.round(g.time)}  posture=${this.posture || '?'}${this.low ? ' LOW' : ''}  tickets ${Math.round(g.tickets.enemy)}/${Math.round(g.tickets.player)}  mortars ${g.enemyMortars ?? '?'}  intel ${this.intel.list(60).length}`);
    for (const op of this.ops) L.push(`OP#${op.id} ${op.type.toUpperCase()} ${op.obj} phase=${op.phase}${op.lane ? ' lane=' + op.lane : ''}${op.lanes ? ' [' + Object.entries(op.lanes).map(([k, v]) => `${k}:c${v.cover}/x${v.exp}`).join(' ') + ']' : ''} units=${[...op.units].map(b => (b.sq || b.v).name).join(',')}`);
    for (const b of this.units) {
      if (b.dead) continue; const u = b.sq || b.v, p = this.upos(b);
      L.push(`  ${(u.name || b.kind).slice(0, 22).padEnd(22)} ${String(b.role || '-').padEnd(9)} ${b.state && b.state !== 'advance' ? b.state + ' ' : ''}${b.task?.dest ? `-> (${Math.round(b.task.dest[0])},${Math.round(b.task.dest[1])}) ${Math.round(D(p, b.task.dest))}m` : ''} ${b.task?.why || ''}${b.sq ? ` [${b.sq.effective.length}/${b.sq.soldiers.length} m${Math.round(b.sq.morale)}${b.sq.mounted ? ' mounted' : ''}${b.sq.building ? ' bld' : ''}${b.sq.trench ? ' trench' : ''}]` : b.v ? ` [hp ${Math.round(100 * b.v.hp / b.v.def.hp)}%]` : ''}`);
    }
    return L;
  }
}
const g_now = c => c.g.time;

// Simple player-side AI for automated balance testing (?autoplay=1): dismount, take objectives, garrison.
export class AutoDefender {
  constructor(g) { this.g = g; this.t = 5; }
  update(dt) {
    const g = this.g; this.t -= dt; if (this.t > 0) return; this.t = 4;
    for (const u of g.unitsOf('player')) {
      if (u.type !== 'squad' || u.routing) continue;
      const o = g.objectives.slice().sort((a, b) => (a.owner === 'enemy' ? -200 : 0) + a.control - ((b.owner === 'enemy' ? -200 : 0) + b.control))[u.id % 2];
      if (u.mounted && u.carrier) {
        const d = Math.hypot(u.carrier.pos.x - o.x, u.carrier.pos.z - o.z);
        if (d < 120 || u.underFireT < 2 || u.carrier.destroyed) u.dismount(Math.PI); else if (!u.carrier.path) u.carrier.orderMove(o.x, o.z + 90, Math.PI, true);
        continue;
      }
      if (u.building || u.trench || u.order?.type === 'clear' || (u.order && u.effective.some(s => s.path))) continue;
      const eT = (g.city.trenchSystems || []).find(T => Math.hypot(T.center[0] - o.x, T.center[1] - o.z) < T.radius + 60 && trenchMen(g, T, 'enemy').length);
      if (eT && u.assault && Math.hypot(eT.center[0] - u.center().x, eT.center[1] - u.center().z) < eT.radius + 120) { u.orderClearTrench(eT); continue; }
      const enemyIn = g.allBuildings().find(b => Math.hypot(b.x - o.x, b.z - o.z) < 35 && b.slots.some(s => s.occupant && s.occupant.squad.side === 'enemy'));
      if (enemyIn && u.assault) { u.orderGarrison(enemyIn); continue; }
      if (o.owner === 'enemy') { u.orderMove(o.x + (Math.random() - .5) * 16, o.z + 10, Math.PI, 16, false); continue; }
      const bl = g.allBuildings().slice().sort((a, b) => Math.hypot(a.x - o.x, a.z - o.z) - Math.hypot(b.x - o.x, b.z - o.z)).find(b => b.slots.some(s => !s.occupant && !s.panel.gone));
      const fT = (g.city.trenchSystems || []).find(T => Math.hypot(T.center[0] - o.x, T.center[1] - o.z) < T.radius + 50 && T.slots.some(sl => !sl.occupant) && !trenchMen(g, T, 'enemy').length);
      if (fT && Math.random() < 0.5) { u.orderTrench(fT); continue; }
      if (bl && Math.random() < 0.5) u.orderGarrison(bl); else u.orderMove(o.x + (Math.random() - .5) * 20, o.z - 8, Math.PI, 18, true);
    }
    for (const v of g.unitsOf('player')) if (v.type === 'vehicle' && !v.path && !v.passengers) { const o = g.objectives[v.id % 2]; if (Math.hypot(v.pos.x - o.x, v.pos.z - o.z) > 70) v.orderMove(o.x, o.z + 55, Math.PI); }
    if (g.mortars > 0 && Math.random() < 0.08) { const e = g.unitsOf('enemy').filter(u => u.type === 'squad' && !u.mounted && u.spotted); if (e.length) { const c = e[0].center(); g.playerMortar(c.x, c.z); } }
  }
}
