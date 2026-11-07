// Versus on the v2 grid: two human commanders share ONE sector map (the Orikhiv axis or Avdiivka), the operation's own
// brigade against the other side's brigade, with weekly turns planned simultaneously. Each side is an ordinary
// Campaign2 on a side-specific definition (sideDef2): side X's "player" cells are side Y's "enemy" cells; ownership is
// kept canonical here (this.own) and mirrored into both after every battle.
// The HOST is authoritative: it applies both players' commands (the joiner sends them, see net/versus_ui.js),
// resolves the week when both are ready (attacks in turn order: against a cell held only by line battalions or when
// the attacker chose auto-resolve, the staff resolves it; against the other player's task forces it is a real battle
// for both players), runs both sides' end of week and decides the outcome.
import { Campaign2, setRandom, woundedShare } from './state.js';
import * as F from './fires.js';
import { normalize } from './index.js';
import { nextBand, applyBand } from './growth.js';
import { spotted } from './recon.js';

export const OTHER = f => (f === 'UA' ? 'RU' : 'UA');
const FLIP = { north: 'south', south: 'north', east: 'west', west: 'east' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);
// commands a player may send (the methods of Campaign2 they call)
export const COMMANDS = ['move', 'split', 'merge', 'transfer', 'rename', 'setStance', 'orderUnit', 'orderTech', 'replenish', 'buildDepot', 'planAttack', 'cancelAttack', 'fire', 'moveBattery', 'flyUav'];

// ------------------------------------------------------------------ the two side definitions
export function sideDef2(defs, opId, faction) {
  const op = defs[opId], own = defs[faction], A = op.aor, mine = faction === opId;
  const owner = c => { const o = c.owner === 'contested' ? 'enemy' : c.owner; return mine ? o : (o === 'player' ? 'enemy' : 'player'); };
  // squares without task forces are held by line battalions of the same baseline strength on both sides (fortifications
  // still differ square by square)
  const cells = A.cells.map(c => { const o = owner(c); return { ...c, owner: o, garrison: o === 'player' ? 0 : 1 }; });
  // supply (supply.js): the other side's sources and hubs swap over; the map does not expand in versus (both
  // commanders see the whole sector)
  const flipSide = h => ({ ...h, side: mine ? (h.side || 'player') : ((h.side || 'player') === 'player' ? 'enemy' : 'player') });
  // v5: the grid extension (growth.js) — the same bands for both commanders (the host grows both sides together);
  // the defending side sees them as its own rear (owners / hubs flipped, its supply sources move out with the edge)
  const ext = A.ext ? { ...A.ext, edgeSide: mine ? 'enemy' : 'player', bands: A.ext.bands.map(b => ({ ...b, forces: [], batteries: [], directives: mine ? (b.directives || []) : [],
    hubs: (b.hubs || []).map(flipSide), cells: b.cells.map(c => { const o = owner(c); return { ...c, owner: o, garrison: o === 'player' ? 0 : 1 }; }) })) } : undefined;
  const aor = { ...A, cells, ext, enemyEdge: mine ? A.enemyEdge : FLIP[A.enemyEdge], supplySources: mine ? [...(A.supplySources || [])] : [...(A.enemySources || [])],
    enemySources: mine ? [...(A.enemySources || [])] : [...(A.supplySources || [])], hubs: (A.hubs || []).map(flipSide), reveal: 99 };
  const byId = Object.fromEntries(cells.map(c => [c.id, c])), at = (col, row) => byId[`c${col}_${row}`];
  const nb = c => { const o = []; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (dx || dy) { const n = at(c.col + dx, c.row + dy); if (n) o.push(n); } return o; };
  const enemyCells = cells.filter(c => c.owner !== 'player');
  const dEnemy = c => Math.min(99, ...enemyCells.map(e => Math.max(Math.abs(e.col - c.col), Math.abs(e.row - c.row))));
  const ownCells = cells.filter(c => c.owner === 'player');
  const ownAll = cells.filter(c => c.owner === 'player'), dEnemy2 = c => Math.min(99, ...ownAll.map(e => Math.max(Math.abs(e.col - c.col), Math.abs(e.row - c.row))));   // (distance of an enemy square from our line)
  // HQ and the task forces of the side that does not own the operation: HQ in the safest town, two task forces one
  // square behind the front (spread across the sector), the third with the HQ
  let start;
  if (mine) start = { ...op.start };
  else {
    const hq = ownCells.slice().sort((a, b) => (dEnemy(b) + (b.settlement ? 1 : 0) + (b.road ? 0.5 : 0)) - (dEnemy(a) + (a.settlement ? 1 : 0) + (a.road ? 0.5 : 0)) || a.id.localeCompare(b.id))[0];
    const second = ownCells.filter(c => dEnemy(c) === 2 && c.terrain !== 'water');
    const span = A.enemyEdge === 'east' || A.enemyEdge === 'west' ? 'row' : 'col', lo = Math.min(...second.map(c => c[span])), hi = Math.max(...second.map(c => c[span]));
    const pick = t => second.slice().sort((a, b) => Math.abs(a[span] - (lo + (hi - lo) * t)) - Math.abs(b[span] - (lo + (hi - lo) * t)) || a.id.localeCompare(b.id))[0] || hq;
    // (v7) squares are held by the task force in or next to them (zone of control), so the brigade deploys like the
    // single-player enemy: its battalions dispersed one square behind the front along the whole sector, the last one
    // (the brigade reserve) with the HQ
    const nf = (own.start.forces || []).length, spots = Array.from({ length: nf }, (_, i) => (i === nf - 1 && nf > 1 ? hq : pick(nf > 1 ? (i + 0.5) / (nf - 1) : 0.5)));
    const forces = (own.start.forces || []).map((f, i) => ({ ...f, cell: spots[i].id, units: [...f.units] }));
    // the artillery group: mortars two squares behind the line, the guns three to four, spread along the front
    const back = d => ownCells.filter(c => dEnemy(c) === d && c.terrain !== 'water');
    const spread = (list, i, n) => { const L = list.slice().sort((a, b) => a[span] - b[span] || a.id.localeCompare(b.id)); return L[Math.min(L.length - 1, Math.floor((i + 0.5) * L.length / n))] || hq; };
    const bats = (own.start.batteries || []).map((b, i, all) => { const d = b.kind === 'mortar120' ? 2 : 3 + (i % 2); const L = back(d).length ? back(d) : back(3).length ? back(3) : [hq]; return { ...b, cell: spread(L, i, all.length).id }; });
    start = { ...own.start, date: op.start.date, end: op.start.end, turnDays: op.start.turnDays, hq: hq.id, forces, batteries: bats };
  }
  if (!mine) start.units = own.start.units;
  // orders: the operation's side keeps its directives (no early-ending 'final'), the other side holds its key squares
  let directives;
  if (mine) directives = op.directives.map(d => ({ ...d, final: false }));
  else {
    const key = ownCells.filter(c => (c.vp || 0) > 0).sort((a, b) => (b.vp || 0) - (a.vp || 0) || a.id.localeCompare(b.id)).slice(0, 4);
    const from = faction === 'RU' ? 'Group of Forces HQ' : 'Operational-Strategic Group HQ';
    directives = key.map((c, i) => ({ id: `vs_hold${i}`, issue: { date: op.start.date }, from, kind: 'hold', targets: [c.id], count: 6 + i * 3, deadline: 8 + i * 4,
      title: `Hold ${c.settlement?.name || c.name || 'the line'}`, text: `${c.settlement?.name || 'This sector'} must not fall. Hold it for ${6 + i * 3} weeks in a row; if it is lost, counterattack at once — the count starts again when it is back in our hands.`, reward: { lp: 25 + i * 10 }, penalty: { lp: 10 } }));
    for (const c of key.slice(0, 2)) directives.push({ id: `vs_retake_${c.id}`, issue: { when: `lost:${c.id}` }, from, kind: 'capture', targets: [c.id], deadline: 4, title: `Retake ${c.settlement?.name || 'the position'}`, text: 'The position has been lost. Retake it before the enemy digs in: attack it from a neighbouring square.', reward: { lp: 40 }, penalty: { lp: 15 } });
    // the same kinds of orders a single-player brigade gets (content directives: recon / destroy), for the defence:
    // find the attacker's staging areas, then wear down his armour as the offensive comes on
    const staging = cells.filter(c => c.owner !== 'player' && dEnemy2(c) === 2 && c.terrain !== 'water').sort((a, b) => (b.vp || 0) + (b.settlement ? 1 : 0) + (b.road || 0) * 0.5 - ((a.vp || 0) + (a.settlement ? 1 : 0) + (a.road || 0) * 0.5) || a.id.localeCompare(b.id)).slice(0, 3);
    if (staging.length) directives.push({ id: 'vs_recon', issue: { date: op.start.date }, from: `${from} — Intelligence`, kind: 'recon', targets: staging.map(c => c.id), deadline: 6,
      title: 'Find the enemy\'s staging areas', text: `Higher command needs to know where the enemy is massing for the offensive. Put drones over ${staging.map(c => c.settlement?.name || c.name || 'the squares').filter((x, i, a) => a.indexOf(x) === i).join(', ')} behind his line.`, reward: { lp: 30 }, penalty: { lp: 5 } });
    directives.push({ id: 'vs_attrit', issue: { date: op.start.date }, from: `${from} — Fires`, kind: 'destroy', targets: [], count: 4, deadline: 12,
      title: 'Attrit the attacking armour', text: 'Destroy enemy armoured vehicles wherever they come on — ATGM teams, drones and tanks in the defensive battles — or his guns by counter-battery fire.', reward: { lp: 35 }, penalty: { lp: 5 }, next: { success: 'vs_attrit2' } });
    directives.push({ id: 'vs_attrit2', from: `${from} — Fires`, kind: 'destroy', targets: [], count: 6, deadline: 14,
      title: 'Break the offensive\'s armour', text: 'The enemy is feeding in his reserves. Keep destroying his armoured vehicles and guns before they reach the main belt.', reward: { lp: 50 }, penalty: { lp: 10 } });
  }
  const def = { ...own, goal: null, vsGoal: op.goal || null, id: faction, version: 2, title: `${op.title} — versus`, region: op.region, mapId: opId, vsOp: opId, versus: true,
    aor, start, directives, theatre: op.theatre, intro: { place: op.intro?.place || A.name, date: op.intro?.date || '', lines: [] },
    enemy: { pressure: [{ date: op.start.date, p: 0 }], reinforce: [{ date: op.start.date, r: 0 }], forceTemplates: op.enemy?.forceTemplates || {}, fpvThreat: 0.4, artillery: 0.4, ew: 0.08 } };
  return normalize(def);
}

// ------------------------------------------------------------------ the shared game (host)
export class VersusGame {
  constructor(defs, opId, hostFaction, saved = null) {
    this.defs = defs; this.opId = opId; this.host = hostFaction; this.guest = OTHER(hostFaction);
    this.sdef = { UA: sideDef2(defs, opId, 'UA'), RU: sideDef2(defs, opId, 'RU') };
    if (saved) {
      this.side = { UA: new Campaign2(this.sdef.UA, saved.sides.UA), RU: new Campaign2(this.sdef.RU, saved.sides.RU) };
      Object.assign(this, { own: saved.own, turn: saved.turn, ready: saved.ready || {}, phase: saved.phase === 'battle' || saved.phase === 'resolve' ? 'resolve' : saved.phase, queue: saved.queue || null, qi: saved.qi || 0, initiative: saved.initiative || opId, acks: saved.acks || {}, result: saved.result || null, history: saved.history || [], pendingBattle: saved.pendingBattle || null, line: saved.line || null });
      this.line ||= this.startLine();
    } else {
      this.side = { UA: new Campaign2(this.sdef.UA), RU: new Campaign2(this.sdef.RU) };
      this.own = {}; for (const c of this.sdef[opId].aor.cells) this.own[c.id] = c.owner === 'player' ? opId : OTHER(opId);
      this.turn = 1; this.ready = {}; this.phase = 'plan'; this.queue = null; this.qi = 0; this.initiative = opId; this.acks = {}; this.result = null; this.history = [];
      this.line = this.startLine();
      for (const f of ['UA', 'RU']) { const C = this.side[f]; C.log = []; C.note(`Versus: ${C.def.brigade?.name || f} takes over the ${f === opId ? 'attack' : 'defence'} of the ${this.sdef[opId].aor.name || 'sector'}. The enemy brigade is commanded by another player.`); }
    }
    this.sync();
  }
  C(f) { return this.side[f]; }
  // v5: the grid grows past the original sector when the attacking side's taken ground nears its enemy edge
  // (growth.js) — both commanders' maps grow by the same band; the new squares belong to the defender
  grow() {
    const added = []; let b;
    while ((b = nextBand(this.side[this.opId])) && added.length < 3) {
      for (const f of ['UA', 'RU']) { const C = this.side[f], bb = C.baseDef.aor.ext.bands.find(x => x.id === b.id); if (bb) applyBand(C, bb); }
      for (const c of b.cells) if (this.own[c.id] == null) this.own[c.id] = OTHER(this.opId);
      added.push(b.id);
    }
    if (added.length) this.sync();
    return added;
  }
  // canonical ownership → both sides' owner maps, supply, contested cells settle
  sync() {
    for (const f of ['UA', 'RU']) { const C = this.side[f]; for (const id of Object.keys(this.own)) C.owner[id] = this.own[id] === f ? 'player' : 'enemy'; }
    // fortifications are what the owner has dug: one value for both views
    for (const id of Object.keys(this.own)) { const v = this.side[this.own[id]].fort[id] || 0; this.side.UA.fort[id] = v; this.side.RU.fort[id] = v; }
    for (const f of ['UA', 'RU']) this.side[f].computeSupply();
    // the other side's batteries each commander has FOUND (they fired since last week, or are under his drones):
    // shadow copies in C.arty.enemy so counter-battery missions can be planned against them
    for (const f of ['UA', 'RU']) {
      const A = this.side[f], D = this.side[OTHER(f)];
      A.arty.enemy = (D.arty?.player || []).filter(b => !b.down && b.hp > 0 && ((b.revealed != null && b.revealed >= D.turn - 1) || (A.recon[b.cell] ?? -9) >= A.turn - 1)).map(b => ({ id: b.id, kind: b.kind, name: b.name, cell: b.cell, hp: b.hp, revealed: b.revealed != null ? A.turn : null, down: 0, acted: 0 }));
    }
    this.refreshCover();
  }
  // ---- v7 parity with single player: not every square holds a company. A square is HELD by its side where one of its
  // task forces stands in it or next to it (zone of control), where its guns or its HQ are, or on the side's starting
  // line (the outposts and line battalions dug in there from the start, as the single-player enemy's outposts fill the
  // gaps of its line). Everything else is empty: the other side occupies it by moving in, without a battle
  // (Campaign2.plan occupy, as against the single-player enemy brigade); a staff-resolved attack on a square held only by
  // the line or outposts meets weaker resistance than one under a task force's cover.
  // Returns null (empty) or why it is held: 't' task force, 'g' guns, 'h' HQ, 'l' starting line.
  startLine() { const out = {}; for (const f of ['UA', 'RU']) { const C = this.side[f]; out[f] = Object.keys(this.own).filter(id => this.own[id] === f && C.cell(id) && C.frontline(id)).sort(); } return out; }
  holds(f, cell) {
    const D = this.side[f]; if (this.own[cell] !== f) return null;
    if (D.forcesAt(cell).length || D.neighbors(cell).some(n => D.forcesAt(n).length)) return 't';
    if ((D.arty?.player || []).some(b => b.cell === cell && !b.down && b.hp > 0)) return 'g';
    if (cell === (D.hq || D.def.start.hq)) return 'h';
    if ((this.line?.[f] || []).includes(cell)) return 'l';
    return null;
  }
  // each commander's picture of which of the other side's squares are held (C.vsCover { cell: why }, used by his own
  // Campaign2.plan / enemyPresence, and by the joiner's mirror the same way) and the last thing seen in each square he
  // has looked at (C.vsSeen { cell: { turn, held, n } }): host only, after every change
  refreshCover() {
    for (const f of ['UA', 'RU']) {
      const A = this.side[f], o = OTHER(f), cov = {}; A.vsSeen ||= {};
      for (const id of Object.keys(this.own)) { if (this.own[id] !== o) continue; const w = this.holds(o, id); if (w) cov[id] = w; }
      A.vsCover = cov;
      for (const id of Object.keys(this.own)) if (this.own[id] === o && A.cell(id) && A.fresh(id)) A.vsSeen[id] = { turn: A.turn, held: cov[id] || null, n: this.side[o].forcesAt(id).length };
    }
  }
  // a square taken without a fight (Campaign2.occupy on the occupier's side, here: the canonical owner, the other side)
  occupied(f, cell) {
    const A = this.side[f], D = this.side[OTHER(f)];
    this.own[cell] = f;
    D.note(`The enemy has occupied ${D.cellName(cell)} without a fight: none of our task forces covered it.`, 'bad');
    D.loseCell(cell, 1, false);
    this.sync(); this.grow();
    for (const S of [A, D]) for (const t of [...S.forces]) if (S.owner[t.cell] !== 'player') S.retreat(t);
    this.history.push({ turn: this.turn, f, cell, win: true, occupy: true });
  }
  // ---- the week's fire missions (planned by both commanders during the week) land before the attacks
  resolveFires() {
    for (const f of ['UA', 'RU']) {
      const A = this.side[f], D = this.side[OTHER(f)];
      for (const r of A.firePlans || []) {
        const X = r.cell, name = A.cellName(X);
        // the campaign maps (map3d.js syncFires) draw a week's fire from C.fireLog: the firer's craters for the rest of this
        // week (the same key as the strike shown when it was planned, ui.js targetClick), and the other commander sees the
        // shells land on his squares when the next week opens (side 'enemy', next turn) — from the guns' square only if the
        // battery gave itself away by firing; the battery's id is not his to look up (ids repeat across the two sides)
        const bat = (A.arty?.player || []).find(b => b.id === r.battery), log = (C, e) => { (C.fireLog ||= []).push(e); if (C.fireLog.length > 60) C.fireLog.shift(); };
        log(A, { turn: A.turn, side: 'player', kind: r.kind, cell: X, battery: r.battery });
        log(D, { turn: D.turn + 1, side: 'enemy', kind: r.kind, cell: X, battery: `vs:${r.battery}`, bkind: bat?.kind || null, from: bat && bat.revealed === A.turn ? bat.cell : null });
        if (r.kind === 'suppress') {
          const cur = A.suppressed[X], n = Math.min(F.SUPPRESS_MAX, (cur ? cur.n : 0) + r.n);
          A.suppressed[X] = { n, by: 'player', turn: A.turn }; D.suppressed[X] = { n, by: 'enemy', turn: D.turn };
          A.garrison[X] = Math.max(0.3, (A.garrison[X] ?? 1) - 0.1 * r.n); D.harm(X, r.n, Math.random);
          A.note(`Fire mission on ${name}: the defenders are suppressed (−${Math.round((1 - F.suppressMul(A, X, 'player')) * 100)}%).`, 'good');
        } else if (r.kind === 'interdict') {
          A.interdicted[X] = { by: 'player', turn: A.turn }; D.interdicted[X] = { by: 'enemy', turn: D.turn };
          A.note(`The roads through ${name} are under our fire this week.`, 'good'); D.note(`Enemy fire interdicts the roads through ${name}: our supply through it is cut back.`, 'bad');
        } else if (r.kind === 'counterbattery') {
          const hits = [];
          for (const b of D.arty?.player || []) {   // (+ tech cbBonus, as in single player: state.js applyFire)
            if (b.cell !== X || b.down || b.hp <= 0) continue;
            const intel = (A.recon[X] ?? -9) >= A.turn - 1;
            if (!(b.revealed != null && b.revealed >= D.turn - 1) && !intel) continue;
            if (Math.random() < F.CB_HIT + (intel ? F.CB_INTEL : 0) + (r.cb || 0) + (A.mods().cbBonus || 0)) { b.hp = Math.round((b.hp - F.CB_DMG) * 100) / 100; if (b.hp <= 0) { b.hp = 0; b.down = F.REBUILD; } hits.push(b); }
          }
          A.note(hits.length ? `Counter-battery fire on ${name}: ${hits.map(h => `${h.name} ${h.down ? 'destroyed' : 'damaged'}`).join(', ')}.` : `Counter-battery fire on ${name}: no confirmed hits.`, hits.length ? 'good' : '');
          if (hits.some(h => h.down)) A.checkDirectives({ cell: X, mode: 'fire', vehKills: hits.filter(h => h.down).length });   // guns destroyed count for 'destroy' orders (state.js DIRECTIVE_KINDS)
          if (hits.length) D.note(`Enemy counter-battery fire on ${name}: ${hits.map(h => `${h.name} ${h.down ? 'destroyed — rebuilt in ' + F.REBUILD + ' weeks' : 'damaged'}`).join(', ')}.`, 'bad');
        }
      }
      A.firePlans = [];
      // the week's drone sorties: the other commander sees them circle over his squares next week (map3d setUavs,
      // C.uav.enemy.log: the same as the single-player enemy's)
      const U = D.uav?.enemy; if (U) { U.log ||= []; for (const l of A.uavLog || []) if (l.turn === A.turn && !l.lost) U.log.push({ turn: D.turn + 1, cell: l.cell, type: l.type, lost: false }); if (U.log.length > 30) U.log.splice(0, U.log.length - 30); }
    }
    for (const f of ['UA', 'RU']) this.side[f].computeSupply();
  }
  // ---- a command from a player (host: own UI; joiner: over the link). Returns the result (error string or object)
  apply(f, name, args) {
    if (this.phase !== 'plan') return 'The week is being resolved';
    if (this.ready[f] && name !== 'rename') return 'You have ended the week';
    if (!COMMANDS.includes(name)) return 'Unknown command';
    const C = this.side[f]; let r;
    try { r = C[name](...(args || [])); } catch (e) { console.warn('versus command', name, e); return 'Command failed'; }
    if (name === 'move' && r && r.ok && r.occupy) this.occupied(f, args[1]);
    else this.refreshCover();
    return r;
  }
  setReady(f, v) { if (this.phase !== 'plan') return; this.ready[f] = !!v; }
  bothReady() { return this.phase === 'plan' && this.ready.UA && this.ready.RU; }
  // ---- what one side may see of the other: task forces next to its own forces, or reconnoitred this / last week
  foes(f) {
    const me = this.side[f], them = this.side[OTHER(f)], out = [];
    for (const t of them.forces) {
      // v5: a big formation gives itself away (recon.js signature) even without a drone over it
      const big = spotted(them, 'player', t);
      const seen = me.forces.some(x => me.adjacent(x.cell, t.cell)) || (me.recon[t.cell] != null && me.recon[t.cell] >= me.turn - 1) || !!big;
      if (!seen) continue;
      const us = them.tfUnits(t).filter(u => them.alive(u));
      out.push({ id: t.id, cell: t.cell, n: us.length, spotted: !!big, units: us.map(u => ({ kind: u.kind, veh: u.veh && !u.veh.lost ? { kind: u.veh.kind } : null })), power: Math.round(them.tfPower(t) * 2) / 2 });
    }
    return out;
  }
  // the state the joiner (or a reconnecting joiner) needs
  view(f) {
    const foes = this.foes(f), C = this.side[f], { def, baseDef, cellById, grid, blocked, ...rest } = C;
    return { opId: this.opId, faction: f, turn: this.turn, phase: this.phase, c: JSON.parse(JSON.stringify(rest)), foes, ready: !!this.ready[f], oppReady: !!this.ready[OTHER(f)], ack: this.acks[f] || 0, result: this.result, battle: this.battle ? { ...this.battle } : null };
  }
  save() {
    const ser = C => { const { def, baseDef, cellById, grid, blocked, ...rest } = C; return JSON.parse(JSON.stringify(rest)); };
    return { v: 2, opId: this.opId, host: this.host, turn: this.turn, own: this.own, ready: this.ready, phase: this.phase, queue: this.queue, qi: this.qi, initiative: this.initiative, acks: this.acks, result: this.result, history: this.history, pendingBattle: this.pendingBattle || null, line: this.line, sides: { UA: ser(this.side.UA), RU: ser(this.side.RU) } };
  }
  // ---- end of the week: the attack queue (alternating sides, the initiative alternates weekly)
  buildQueue() {
    this.resolveFires();
    const L = f => this.side[f].forces.filter(t => t.planned).map(t => ({ f, tf: t.id, cell: t.planned.cell, auto: !!t.planned.auto }));
    const a = L(this.initiative), b = L(OTHER(this.initiative)), q = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) q.push(a[i]); if (b[i]) q.push(b[i]); }
    this.queue = q; this.qi = 0; this.phase = 'resolve';
  }
  // the next attack to carry out: { kind: 'auto' } resolved here, or { kind: 'battle', ... } for the caller to fight
  nextAttack() {
    while (this.queue && this.qi < this.queue.length) {
      const a = this.queue[this.qi++], A = this.side[a.f], D = this.side[OTHER(a.f)], tf = A.tf(a.tf);
      if (!tf || !tf.planned || tf.planned.cell !== a.cell) continue;
      if (A.owner[a.cell] === 'player' || A.owner[tf.cell] !== 'player' || !A.adjacent(tf.cell, a.cell) || !A.tfUnits(tf).some(u => A.combatReady(u))) { A.note(`${tf.name}: the attack on ${A.cellName(a.cell)} was called off — the situation has changed.`, 'bad'); tf.planned = null; continue; }
      const defenders = D.forcesAt(a.cell).filter(t => D.tfUnits(t).some(u => D.combatReady(u)));
      const b = { ...a, stage: tf.cell, defTfs: defenders.map(t => t.id), defUids: defenders.flatMap(t => t.units), id: `vb${this.turn}_${this.qi}` };
      if (!defenders.length || a.auto) { this.autoBattle(b); continue; }
      this.pendingBattle = { kind: 'battle', ...b };   // persisted: a host that reloads mid-battle fights it again
      return this.pendingBattle;
    }
    return null;
  }
  // staff-resolved: own task force against the defending task forces (or the line battalions holding the square)
  autoBattle(b) {
    const A = this.side[b.f], D = this.side[OTHER(b.f)], tf = A.tf(b.tf);
    const au = A.battleUnits(tf.units).slice(0, 8), du = D.battleUnits(b.defUids || []).slice(0, 8);   // frontage: see state.js FRONTAGE
    const c = A.cell(b.cell), urban = ['urban', 'industrial'].includes(c.terrain) ? 1 : c.terrain === 'village' || c.terrain === 'forest' ? 0.5 : 0, fort = A.fort[b.cell] || 0;
    const sup = (C, us) => { const t = us.length ? C.tfOf(us[0].uid) : null; return t ? (t.supply ?? 1) : 1; };
    const pa = au.reduce((s, u) => s + A.unitPower(u), 0) * (0.6 + 0.4 * sup(A, au));
    // (v7) line battalions hold a square at full strength only where a task force of the defender covers it (in it or
    // next to it, zone of control); squares behind the front with no task force near are thinly held (rear security)
    // (a square on the defender's starting line, with his guns or his HQ: the line battalions / outposts, 0.7)
    const why = this.holds(OTHER(b.f), b.cell), zoc = why === 't' ? 1 : why ? 0.7 : 0.4;
    const line = du.length ? 0 : Math.max(0.5, A.garrison[b.cell] || 1) * 2.1 * zoc;
    const pd = (du.reduce((s, u) => s + D.unitPower(u), 0) * (0.6 + 0.4 * sup(D, du)) + (du.length ? 1.2 : 0) + line) * F.suppressMul(A, b.cell, 'player') + fort * (urban >= 1 ? 1.0 : 0.6) + urban * 0.8;
    const win = pa * rnd(0.75, 1.25) > pd * rnd(0.75, 1.25);
    const cas = (us, won, C) => us.map(u => { const k = Math.round(u.men * rnd(0.04, won ? 0.22 : 0.4)); return { uid: u.uid, alive: Math.max(0, u.men - k), wounded: Math.min(k, Math.round(k * woundedShare(C.mods()))), kills: Math.round(rnd(0, 3)), vehLost: !!(u.veh && !u.veh.lost && Math.random() < (won ? 0.08 : 0.25)), vehHp: u.veh ? (u.veh.lost ? 0 : clamp(u.veh.hp - rnd(0, 0.4), 0.1, 1)) : 1 }; });
    const ra = cas(au, win, A), rd = cas(du, !win, D);
    const lost = (rs, us) => rs.reduce((s, r) => { const u = us.find(x => x.uid === r.uid); return s + Math.max(0, (u?.men || 0) - r.alive); }, 0) + Math.round(rnd(0, 3));
    const vl = rs => rs.filter(r => r.vehLost).length;
    const rAtt = { sector: b.cell, mode: 'attack', win, auto: true, units: ra, enemyKia: du.length ? lost(rd, du) : Math.round(rnd(2, 6)), enemyVehLost: vl(rd), objectivesHeld: win ? 2 : 0 };
    const rDef = { sector: b.cell, mode: 'defend', win: !win, auto: true, lineOnly: !du.length, units: rd, enemyKia: lost(ra, au), enemyVehLost: vl(ra), objectivesHeld: win ? 0 : 2 };
    this.applyBattle(b, rAtt, rDef);
    return { rAtt, rDef };
  }
  // a battle's results (attacker's and defender's view, collectResult format) → both sides, ownership, supply
  applyBattle(b, rAtt, rDef) {
    const A = this.side[b.f], D = this.side[OTHER(b.f)], tf = A.tf(b.tf);
    this.pendingBattle = null;
    const strength = clamp(Math.round((tf ? A.tfPower(tf) : 2) / 2.5), 1, 3);
    A.battle = { mode: 'attack', tf: b.tf, cell: b.cell, from: b.stage };
    A.applyResult({ ...rAtt, sector: b.cell, mode: 'attack', win: !!rAtt.win });
    D.pendingAttacks = [{ id: b.id, from: b.stage, to: b.cell, strength }];
    D.battle = { mode: 'defend', cell: b.cell, attack: b.id, from: b.stage };
    D.applyResult({ ...rDef, sector: b.cell, mode: 'defend', win: !rAtt.win, lineOnly: !(b.defUids || []).length });
    D.pendingAttacks = [];
    if (rAtt.win) this.own[b.cell] = b.f;
    this.sync(); if (rAtt.win) this.grow();
    // a defender pushed out lands on a square that is still its own (sync may have moved the line under it)
    for (const S of [A, D]) for (const t of [...S.forces]) if (S.owner[t.cell] !== 'player') S.retreat(t);
    this.history.push({ turn: this.turn, f: b.f, cell: b.cell, win: !!rAtt.win, auto: !!rAtt.auto });
  }
  // both sides' end of week, outcome
  endWeek() {
    for (const f of ['UA', 'RU']) { const C = this.side[f]; for (const t of C.forces) t.planned = null; C.pendingAttacks = []; C.endTurn(); }
    // line battalions: re-man weakened lines, dig in on quiet front squares
    for (const f of ['UA', 'RU']) {
      const C = this.side[f];
      for (const id of Object.keys(this.own)) {
        if (this.own[id] === f) { if ((C.fort[id] || 0) < 1 && !C.forcesAt(id).length && C.frontline(id) && Math.random() < 0.12) C.fort[id] = 1; }
        else if ((C.garrison[id] ?? 1) < 1) C.garrison[id] = Math.min(1, (C.garrison[id] ?? 1) + 0.15);
      }
    }
    this.sync(); this.grow(); for (const f of ['UA', 'RU']) this.side[f].resetMoves();
    this.turn++; this.ready = {}; this.queue = null; this.qi = 0; this.phase = 'plan'; this.battle = null; this.initiative = OTHER(this.initiative);
    this.decide();
  }
  // ground and objectives first; the operation's goal squares count double for whoever holds them
  score(f) { const C = this.side[f], s = C.score(), G = this.sdef[this.opId].vsGoal; const g = G ? G.cells.filter(x => this.own[x.cell] === f).reduce((a, x) => a + x.pts, 0) : 0; return Math.round(s.vp * 3 + s.cells + s.ok * 2 + C.stats.won * 0.5 + g * 2); }
  goalStatus() { const G = this.sdef[this.opId].vsGoal; if (!G) return null; return { title: G.title, text: G.text, attacker: this.opId, cells: G.cells.map(x => ({ ...x, holder: this.own[x.cell], name: this.side[this.opId].cellName(x.cell) })) }; }
  decide() {
    const down = f => { const C = this.side[f], o = C.baseOutcome(); return o && !o.win && /DEFEAT/.test(o.title) ? o : null; };
    const dUA = down('UA'), dRU = down('RU'), C0 = this.side[this.opId], end = C0.date >= C0.def.start.end || C0.turn > C0.maxTurn;
    let win = null, why = '';
    // the operation goal decides as in single player (Campaign2.baseOutcome): its squares held (G.win of the points) at
    // the end of a week = the attacker's victory at once; at the end of the operation below G.partial = the defence
    // has held; in between, the score
    const G = this.sdef[this.opId].vsGoal, att = this.opId, dfd = OTHER(att), gs = this.goalStatus();
    const pct = gs ? gs.cells.filter(x => x.holder === att).reduce((a, x) => a + x.pts, 0) / Math.max(1, gs.cells.reduce((a, x) => a + x.pts, 0)) : null;
    const nm = f => (f === 'UA' ? 'Ukraine' : 'Russia');
    if (dUA && !dRU) { win = 'RU'; why = dUA.text; } else if (dRU && !dUA) { win = 'UA'; why = dRU.text; }
    else if (dUA && dRU) { win = 'draw'; why = 'Both brigades are spent.'; }
    else if (G && pct >= (G.win ?? 1) - 1e-9) { win = att; why = `${C0.dateLabel}: operation goal achieved — ${G.title} (${Math.round(pct * 100)}% of the objective points held by ${nm(att)}).`; }
    else if (end) {
      const a = this.score('UA'), b = this.score('RU'), sc = `Score: Ukraine ${a}, Russia ${b}.`;
      if (G && pct < (G.partial ?? 0.5) - 1e-9) { win = dfd; why = `The operation ends with only ${Math.round(pct * 100)}% of its goal (${G.title}) in the attacker's hands: the defence has held. ${sc}`; }
      else { win = a > b ? 'UA' : b > a ? 'RU' : 'draw'; why = `The operation ends on schedule${G ? ` with ${Math.round(pct * 100)}% of its goal taken (limited success)` : ''}. ${sc}`; }
    }
    if (!win) return null;
    this.result = { win, why, score: { UA: this.score('UA'), RU: this.score('RU') } }; this.phase = 'over';
    for (const f of ['UA', 'RU']) this.side[f].vsOutcome = { win: win === f, title: win === 'draw' ? 'DRAW' : win === f ? 'VICTORY' : 'DEFEAT', text: why };
    return this.result;
  }
}
// the joiner's local copy of its side, from the host's view()
export function mirror2(defs, st, sdefCache = {}) {
  const def = sdefCache[st.faction + st.opId] ||= sideDef2(defs, st.opId, st.faction);
  const C = new Campaign2(def, st.c); C.foes = st.foes || []; return C;
}
export { setRandom };
