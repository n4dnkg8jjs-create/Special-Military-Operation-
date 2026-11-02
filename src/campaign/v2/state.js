// Campaign v2 rules — GRID strategic layer (schema2.js). Weekly turns with real dates (Feb 2023 → Mar 2024), task
// forces that split / merge / move with movement points over grid cells (terrain, roads, rivers), attacks into enemy
// cells (fought on the RTS battle maps or auto-resolved), enemy counterattacks on the grid, logistics (supply
// connectivity from supply sources through own cells, LP income, out-of-supply penalties), directives from higher
// command with dates / branches / history notes, orders from high command (units, replacements, date-gated tech),
// persistence in localStorage. Pure logic — the 3D screen is map3d.js + ui.js.
//
// battleSetup() / applyResult() keep the contract of src/game/campaignBattle.js (deployCampaign / collectResult).
import { MODS } from '../schema.js';

export const KEY2 = 'smo.campaign.v2';
export const MAX_BATTLE = 12;                 // units one battle can deploy (the rest of a task force stays in reserve)
export const XP_NAMES = ['Green', 'Trained', 'Veteran', 'Elite'];
export function xpLevel(xp) { return xp >= 9 ? 3 : xp >= 5 ? 2 : xp >= 2 ? 1 : 0; }

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let RND = Math.random;
const rnd = (a, b) => a + RND() * (b - a);
export function setRandom(f) { RND = f || Math.random; }      // tests: deterministic dice
const ls = () => (typeof localStorage !== 'undefined' ? localStorage : null);

// ------------------------------------------------------------------ dates
const DAY = 86400000;
export const parseDate = s => { const [y, m, d] = String(s).split('-').map(Number); return Date.UTC(y, (m || 1) - 1, d || 1); };
export const fmtDate = t => new Date(t).toISOString().slice(0, 10);
export const addDays = (s, n) => fmtDate(parseDate(s) + n * DAY);
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTHS_L = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const dateLabel = (s, long = false) => { const d = new Date(parseDate(s)); return long ? `${d.getUTCDate()} ${MONTHS_L[d.getUTCMonth()]} ${d.getUTCFullYear()}` : `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
// step-function lookup over [{date, ...}] (dates may be 'YYYY-MM' or 'YYYY-MM-DD'; ISO strings compare lexically)
export function atDate(list, date, key) { let v = null; for (const e of list || []) if (String(e.date) <= date) v = key ? e[key] : e; else break; return v ?? (key && list?.length ? list[0][key] : null); }

// ------------------------------------------------------------------ movement
export const TERRAIN_COST = { fields: 2, village: 2, heights: 2.5, balka: 2.5, forest: 3, urban: 3, industrial: 3, water: Infinity };
export const VEH_MP = { btr: 4, spg: 3, ifv: 3, tank: 3 };
export const FOOT_MP = 2;
const ROAD_COST = [Infinity, 1.5, 1];
const FOOT_KINDS = new Set(['assault', 'atgm', 'fpv']);

export class Campaign2 {
  constructor(def, saved = null) {
    this.def = def; this.index();
    if (saved) { Object.assign(this, saved); this.def = def; this.index(); this.computeSupply(); return; }
    const S = def.start;
    this.v = 2; this.side = def.id; this.sig = this.signature(); this.turn = 1; this.lp = S.lp || 0; this.nextId = 1; this.hq = S.hq;
    this.owner = {}; this.garrison = {}; this.fort = {};
    for (const c of def.aor.cells) { this.owner[c.id] = c.owner; this.garrison[c.id] = c.owner === 'player' ? 0 : (c.garrison ?? 1); this.fort[c.id] = c.fort || 0; }
    this.units = (S.units || S.force || []).map(u => this.record(u));
    this.forces = (S.forces || []).map(f => ({ id: f.id || this.newId('tf'), name: f.name || 'Task force', cell: f.cell, units: [...f.units], mp: 0, stance: f.stance || 'attack', attacked: false }));
    if (!this.forces.length && this.units.length) this.forces.push({ id: this.newId('tf'), name: 'Task force 1', cell: S.hq, units: this.units.map(u => u.uid), mp: 0, stance: 'attack', attacked: false });
    this.unlocked = [...(S.unlocked || [])]; this.available = [...(S.available || [])];
    this.orders = []; this.directives = []; this.doneDirectives = {}; this.depots = [];
    this.recon = {}; this.pendingAttacks = []; this.battle = null; this.seenEvents = {};
    this.log = [];
    this.stats = { battles: 0, won: 0, kills: 0, losses: 0, vehLost: 0, vehKills: 0, cellsTaken: 0, cellsLost: 0 };
    this.note(def.intro?.lines?.[0] || 'The operation begins.');
    this.computeSupply(); this.resetMoves(); this.issueDirectives(); this.newsUpTo(this.date);
  }
  signature() { const a = this.def.aor; return `${this.def.id}:${a.cols}x${a.rows}:${a.cells.length}:${this.def.start.date}`; }
  index() {
    const a = this.def.aor; this.cellById = {}; this.grid = [];
    for (const c of a.cells) { this.cellById[c.id] = c; (this.grid[c.col] ||= [])[c.row] = c; }
    this.blocked = new Set((a.blocked || []).map(([p, q]) => [p, q].sort().join('|')));
  }
  newId(p) {
    const used = id => (this.forces || []).some(f => f.id === id) || (this.units || []).some(u => u.uid === id) || (this.pendingAttacks || []).some(a => a.id === id);
    let id; do { this.nextId = (this.nextId || 1) + 1; id = `${p}${this.nextId}`; } while (used(id)); return id;
  }
  // ------------------------------------------------------------------ persistence
  static load(defs) {
    const L = ls(); if (!L) return null;
    try { const raw = L.getItem(KEY2); if (!raw) return null; const s = JSON.parse(raw); const def = defs[s.side]; if (!def) return null; const C = new Campaign2(def, s); return C.sig === C.signature() ? C : null; } catch (e) { console.warn('campaign v2 load failed', e); return null; }
  }
  save() { if (this.def.versus) return; const { def, cellById, grid, blocked, ...rest } = this; try { ls()?.setItem(KEY2, JSON.stringify(rest)); } catch (e) { console.warn('campaign save failed', e); } }
  static clear() { const L = ls(); try { for (const k of ['', '.battle', '.result']) L?.removeItem(KEY2 + k); } catch {} }
  static pendingBattle() { try { return JSON.parse(ls()?.getItem(KEY2 + '.battle') || 'null'); } catch { return null; } }
  static storeResult(r) { try { ls()?.setItem(KEY2 + '.result', JSON.stringify(r)); ls()?.removeItem(KEY2 + '.battle'); } catch {} }
  static takeResult() { try { const r = JSON.parse(ls()?.getItem(KEY2 + '.result') || 'null'); ls()?.removeItem(KEY2 + '.result'); return r; } catch { return null; } }
  // ------------------------------------------------------------------ time
  get date() { return addDays(this.def.start.date, (this.turn - 1) * (this.def.start.turnDays || 7)); }
  get maxTurn() { return Math.floor((parseDate(this.def.start.end) - parseDate(this.def.start.date)) / DAY / (this.def.start.turnDays || 7)) + 1; }
  get dateLabel() { return dateLabel(this.date); }
  // ------------------------------------------------------------------ grid helpers
  cell(id) { return this.cellById[id]; }
  cellAt(col, row) { return this.grid[col]?.[row]; }
  neighbors(id) { const c = this.cell(id), out = []; if (!c) return out; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { if (!dx && !dy) continue; const n = this.cellAt(c.col + dx, c.row + dy); if (n) out.push(n.id); } return out; }
  adjacent(a, b) { const p = this.cell(a), q = this.cell(b); return p && q && a !== b && Math.abs(p.col - q.col) <= 1 && Math.abs(p.row - q.row) <= 1; }
  frontline(id) { const o = this.owner[id]; return this.neighbors(id).some(n => this.owner[n] !== o); }
  cellName(id) { const c = this.cell(id); if (!c) return id; return c.name || c.settlement?.name || `${({ fields: 'Fields', forest: 'Woods', heights: 'Heights', balka: 'Balka', village: 'Village', urban: 'Town', industrial: 'Works', water: 'Water' })[c.terrain] || 'Grid'} ${String.fromCharCode(65 + (c.col % 26))}${c.row + 1}`; }
  gridRef(id) { const c = this.cell(id); return c ? `${String.fromCharCode(65 + (c.col % 26))}${c.row + 1}` : '?'; }
  // ------------------------------------------------------------------ units and task forces
  catalogItem(key) { return this.def.catalog.find(c => c.key === key); }
  techItem(id) { return this.def.tech.find(t => t.id === id); }
  record(u) {
    const c = this.catalogItem(u.key) || {};
    const men = u.men ?? c.men ?? 0, kind = u.kind || c.kind, vk = u.veh?.kind || c.vehicle;
    return { uid: u.uid ?? this.newId('u'), key: u.key, name: u.name || c.label || kind, kind, men, menMax: u.menMax ?? men, wounded: u.wounded || 0, woundedT: u.woundedT || 0,
      veh: vk ? { kind: vk, hp: u.veh?.hp ?? 1, lost: !!u.veh?.lost } : null, xp: u.xp || 0, battles: u.battles || 0, kills: u.kills || 0, status: u.status || 'ready', eta: u.eta || 0 };
  }
  unit(uid) { return this.units.find(u => u.uid === uid); }
  get force() { return this.units; }                       // v1 name (campaignBattle / versus helpers)
  tf(id) { return this.forces.find(f => f.id === id); }
  tfOf(uid) { return this.forces.find(f => f.units.includes(uid)); }
  forcesAt(cellId) { return this.forces.filter(f => f.cell === cellId); }
  tfUnits(tf) { tf = typeof tf === 'string' ? this.tf(tf) : tf; return tf ? tf.units.map(id => this.unit(id)).filter(Boolean) : []; }
  alive(u) { return u.men > 0 || (u.veh && !u.veh.lost) || u.wounded > 0; }
  combatReady(u) { return u.status === 'ready' && (u.men > 0 || (u.veh && !u.veh.lost)); }
  unitPower(u) { return (u.men * 0.12 + (u.veh && !u.veh.lost ? (u.veh.kind === 'tank' ? 1.4 : u.veh.kind === 'spg' ? 1.0 : 0.8) * (0.5 + 0.5 * u.veh.hp) : 0)) * (1 + xpLevel(u.xp) * 0.12); }
  tfPower(tf) { return this.tfUnits(tf).filter(u => this.combatReady(u)).reduce((a, u) => a + this.unitPower(u), 0); }
  unitMp(u) { if (u.veh && !u.veh.lost) return VEH_MP[u.veh.kind] || 3; return FOOT_MP; }
  // slowest unit sets the pace; foot teams ride along on the force's vehicles (one team per vehicle)
  tfMpMax(tf) {
    const us = this.tfUnits(tf).filter(u => this.alive(u)); if (!us.length) return 0;
    const veh = us.filter(u => u.veh && !u.veh.lost), foot = us.filter(u => !(u.veh && !u.veh.lost));
    const carried = foot.filter(u => FOOT_KINDS.has(u.kind) || u.men <= 8).length <= veh.length;
    let mp = veh.length ? Math.min(...veh.map(u => this.unitMp(u))) : FOOT_MP;
    if (foot.length && !carried) mp = Math.min(mp, FOOT_MP);
    if ((tf.supply ?? 1) < 0.5) mp = Math.max(1, Math.floor(mp / 2));     // out of supply: no fuel
    return mp;
  }
  split(tfId, uids, name) {
    const tf = this.tf(tfId); if (!tf) return 'No such task force';
    uids = uids.filter(u => tf.units.includes(u)); if (!uids.length) return 'Pick the units to detach';
    if (uids.length >= tf.units.length) return 'Leave at least one unit in the task force';
    const spent = Math.max(0, this.tfMpMax(tf) - tf.mp);   // movement already used this week carries over to both parts
    const n = { id: this.newId('tf'), name: name || this.tfName(), cell: tf.cell, units: uids, mp: 0, stance: tf.stance, attacked: tf.attacked, supply: tf.supply };
    tf.units = tf.units.filter(u => !uids.includes(u)); this.forces.push(n);
    n.mp = Math.max(0, this.tfMpMax(n) - spent); tf.mp = Math.max(0, this.tfMpMax(tf) - spent);
    this.note(`${n.name} detached from ${tf.name} at ${this.cellName(tf.cell)}.`); this.save(); return n;
  }
  merge(intoId, fromId) {
    const a = this.tf(intoId), b = this.tf(fromId); if (!a || !b || a === b) return 'Pick two task forces';
    if (a.cell !== b.cell) return 'Task forces must be in the same grid cell to combine';
    const spent = Math.max(this.tfMpMax(a) - a.mp, this.tfMpMax(b) - b.mp, 0);
    a.units.push(...b.units); a.mp = Math.max(0, this.tfMpMax(a) - spent); a.attacked = a.attacked || b.attacked; a.planned ||= b.planned || null; this.forces = this.forces.filter(f => f !== b);
    this.note(`${b.name} combined into ${a.name}.`); this.save(); return a;
  }
  transfer(uid, toId) { const from = this.tfOf(uid), to = this.tf(toId); if (!from || !to || from === to) return 'Nothing to transfer'; if (from.cell !== to.cell) return 'Same grid cell only'; if (from.units.length === 1) return this.merge(toId, from.id); const spent = Math.max(this.tfMpMax(from) - from.mp, this.tfMpMax(to) - to.mp, 0); from.units = from.units.filter(u => u !== uid); to.units.push(uid); to.mp = Math.max(0, this.tfMpMax(to) - spent); from.mp = Math.max(0, this.tfMpMax(from) - spent); this.save(); return to; }
  rename(tfId, name) { const tf = this.tf(tfId); if (tf && name) { tf.name = String(name).slice(0, 32); this.save(); } }
  setStance(tfId, s) { const tf = this.tf(tfId); if (tf && ['attack', 'hold', 'rest'].includes(s)) { tf.stance = s; this.save(); } }
  tfName() { const names = this.side === 'RU' ? ['Group', 'Detachment'] : ['TF', 'Battlegroup']; let i = this.forces.length + 1; while (this.forces.some(f => f.name === `${names[0]} ${i}`)) i++; return `${names[0]} ${i}`; }
  // ------------------------------------------------------------------ movement
  enterCost(fromId, toId) {
    const a = this.cell(fromId), b = this.cell(toId); if (!a || !b || !this.adjacent(fromId, toId)) return Infinity;
    if (this.blocked.has([fromId, toId].sort().join('|'))) return Infinity;
    let c = TERRAIN_COST[b.terrain] ?? 2; if (!isFinite(c)) return Infinity;
    const diag = a.col !== b.col && a.row !== b.row;
    const road = Math.min(a.road || 0, b.road || 0);
    if (road) c = Math.min(c, ROAD_COST[road]); else if (diag) c *= 1.4;
    if (b.river && !b.bridge && !(a.river && road)) c += 2;          // fording / pontoon crossing
    const o = this.owner[toId];
    if (o === 'contested') c += 1;
    if (o === 'enemy') c += (this.fort[toId] || 0) * 0.5;
    return +c.toFixed(2);
  }
  // Dijkstra over own cells from the task force's position
  reach(tf) {
    const dist = { [tf.cell]: 0 }, prev = {}, open = new Set([tf.cell]), done = new Set();
    while (open.size) {
      let cur = null; for (const o of open) if (cur == null || dist[o] < dist[cur]) cur = o; open.delete(cur); if (done.has(cur)) continue; done.add(cur);
      for (const n of this.neighbors(cur)) {
        if (this.owner[n] !== 'player') continue;
        const d = dist[cur] + this.enterCost(cur, n); if (!isFinite(d)) continue;
        if (dist[n] == null || d < dist[n]) { dist[n] = d; prev[n] = cur; open.add(n); }
      }
    }
    return { dist, prev };
  }
  // the route to a cell: { ok, path:[ids], cost, attack, stage, mpLeft, why }
  // R: a reach(tf) computed for this force just before (callers that plan many cells at once)
  plan(tfId, toId, R = null) {
    const tf = this.tf(tfId); if (!tf) return { ok: false, why: 'No task force' };
    if (toId === tf.cell) return { ok: false, why: 'Already here' };
    const full = tf.mp >= this.tfMpMax(tf) - 1e-6, { dist, prev } = R || this.reach(tf);
    const route = end => { const p = [end]; while (prev[p[0]]) p.unshift(prev[p[0]]); return p; };
    const tgt = this.owner[toId];
    if (tgt === 'player') {
      if (dist[toId] == null) return { ok: false, why: 'No route through own lines' };
      const path = route(toId), cost = dist[toId];
      // full MP: a force can always move one cell, whatever it costs
      const ok = cost <= tf.mp + 1e-6 || (full && path.length === 2);
      return { ok, path, cost, attack: false, mpLeft: Math.max(0, tf.mp - cost), why: ok ? '' : `Needs ${cost} MP (${fmt(tf.mp)} left)` };
    }
    // enemy / contested cell: move next to it through own cells, then attack
    if (tf.attacked) return { ok: false, attack: true, why: 'Already attacked this turn' };
    if (!this.tfUnits(tf).some(u => this.combatReady(u))) return { ok: false, attack: true, why: 'No combat-ready units' };
    let best = null;
    for (const n of this.neighbors(toId)) {
      if (dist[n] == null || !isFinite(this.enterCost(n, toId))) continue;
      const left = tf.mp - dist[n];
      if (left < 1 - 1e-6 && !(n === tf.cell && full)) continue;
      if (!best || dist[n] < dist[best]) best = n;
    }
    if (!best) {
      const anyAdj = this.neighbors(toId).filter(n => dist[n] != null).sort((p, q) => dist[p] - dist[q])[0];
      return { ok: false, attack: true, path: anyAdj ? [...route(anyAdj), toId] : [tf.cell, toId], cost: anyAdj ? dist[anyAdj] + this.enterCost(anyAdj, toId) : Infinity, why: anyAdj ? 'Not enough movement left to attack this turn' : 'No route' };
    }
    const path = [...route(best), toId];
    return { ok: true, attack: true, stage: best, path, cost: dist[best] + this.enterCost(best, toId), mpLeft: 0 };
  }
  // move; returns the plan (for an attack, the force stands next to the target: call attackSetup / autoResolve next)
  move(tfId, toId) {
    const tf = this.tf(tfId), p = this.plan(tfId, toId); if (!p.ok) return p;
    if (p.attack) { tf.mp -= this.reach(tf).dist[p.stage]; tf.cell = p.stage; tf.stance = 'attack'; this.save(); return p; }
    tf.mp = Math.max(0, tf.mp - p.cost); tf.cell = toId; tf.stance = 'attack'; this.markRecon(tf.cell, this.reconRange(tf)); this.save(); return p;
  }
  resetMoves() { for (const f of this.forces) { f.mp = this.tfMpMax(f); f.attacked = false; f.planned = null; } }
  // versus: attacks are planned during the week and carried out by the host when both commanders have ended it
  planAttack(tfId, cellId, auto = false) {
    const tf = this.tf(tfId), p = this.plan(tfId, cellId); if (!tf) return 'No task force'; if (!p.ok || !p.attack) return p.why || 'Cannot attack there';
    this.move(tfId, cellId); tf.planned = { cell: cellId, auto: !!auto }; tf.attacked = true; tf.mp = 0;
    this.note(`${tf.name} will attack ${this.cellName(cellId)} from ${this.cellName(tf.cell)} at the end of the week${auto ? ' (staff-resolved)' : ''}.`); return null;
  }
  cancelAttack(tfId) { const tf = this.tf(tfId); if (!tf?.planned) return 'No attack planned'; this.note(`${tf.name}: attack on ${this.cellName(tf.planned.cell)} called off.`); tf.planned = null; tf.attacked = false; return null; }
  markRecon(cellId, r = 1) { const c = this.cell(cellId); if (!c) return; for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) { const n = this.cellAt(c.col + dx, c.row + dy)?.id; if (n && this.owner[n] !== 'player') this.recon[n] = this.turn; } }
  // a task force with a drone team (or the recon-drone upgrade) observes two squares out, otherwise the next square
  reconRange(tf) { return (this.mods().reconDrone || this.tfUnits(tf).some(u => u.kind === 'fpv' && this.combatReady(u))) ? 2 : 1; }
  known(cellId) { return this.owner[cellId] === 'player' || this.recon[cellId] != null || this.forces.some(f => this.adjacent(f.cell, cellId)); }
  // ------------------------------------------------------------------ logistics
  supplyRange() { return (this.def.aor.supplyRange || 8) + (this.mods().supplyRange || 0); }
  computeSupply() {
    const src = [...(this.def.aor.supplySources || []), ...(this.depots || [])].filter(id => this.owner[id] === 'player');
    const dist = {}, open = [];
    for (const s of src) { dist[s] = 0; open.push(s); }
    const q = new Set(open);
    while (q.size) {
      let cur = null; for (const o of q) if (cur == null || dist[o] < dist[cur]) cur = o; q.delete(cur);
      for (const n of this.neighbors(cur)) {
        if (this.owner[n] !== 'player') continue;
        const c = this.cell(n), d = dist[cur] + (c.road ? 1 : 2) * (this.cell(cur).col !== c.col && this.cell(cur).row !== c.row ? 1.4 : 1);
        if (dist[n] == null || d < dist[n] - 1e-9) { dist[n] = d; q.add(n); }
      }
    }
    const R = this.supplyRange();
    this.supplyDist = dist; this.supplied = {};
    for (const c of this.def.aor.cells) { const d = dist[c.id]; this.supplied[c.id] = d == null ? 0 : d <= R ? 1 : d <= R + 3 ? 0.5 : 0; }
    for (const f of this.forces) f.supply = this.supplied[f.cell] ?? 0;
    return this.supplied;
  }
  lpIncome() {
    const base = this.def.start.lpBase ?? 6;
    const k = this.def.start.cellLp ?? 0.5;   // held cells yield a trickle; battles and directives are the main LP source
    const cells = k * this.def.aor.cells.filter(c => this.owner[c.id] === 'player').reduce((a, c) => a + (c.lp || 0) * (this.supplied?.[c.id] ?? 1), 0);
    return Math.round((base + cells) * (1 + (this.mods().lpGain || 0)));
  }
  depotAllowed(cellId) { return this.owner[cellId] === 'player' && (this.supplied[cellId] || 0) >= 1 && !(this.depots || []).includes(cellId) && !(this.def.aor.supplySources || []).includes(cellId) && (this.depots || []).length < 2; }
  buildDepot(cellId) { const cost = 30; if (!this.depotAllowed(cellId)) return 'A forward depot needs an own, supplied cell (max 2 depots)'; if (this.lp < cost) return 'Not enough logistics points'; this.lp -= cost; this.depots.push(cellId); this.computeSupply(); this.note(`Forward supply depot established at ${this.cellName(cellId)} (${cost} LP).`, 'good'); this.save(); return null; }
  // ------------------------------------------------------------------ high command
  mods() {
    const m = {};
    for (const id of this.unlocked) { const t = this.techItem(id); if (!t?.mods) continue; for (const [k, v] of Object.entries(t.mods)) { if (!(k in MODS) && k !== 'supplyRange') continue; m[k] = typeof v === 'boolean' ? (m[k] || v) : (m[k] || 0) + v; } }
    return m;
  }
  dateOk(item) { return !item?.date || String(item.date) <= this.date; }
  techAvailable(id) { const t = this.techItem(id); return !!t && !this.unlocked.includes(id) && !this.orders.some(o => o.key === id) && (t.req || []).every(r => this.unlocked.includes(r)) && this.dateOk(t); }
  orderTech(id) {
    const t = this.techItem(id); if (!t) return 'Not available'; if (!this.dateOk(t)) return `Not before ${dateLabel(t.date)}`; if (!this.techAvailable(id)) return 'Not available'; if (this.lp < t.lp) return 'Not enough logistics points';
    this.lp -= t.lp; this.orders.push({ what: 'tech', key: id, eta: t.eta ?? 1 }); this.note(`Requested from high command: ${t.name} (${t.eta ?? 1} wk).`); this.save(); return null;
  }
  catalogAvailable(c) { return this.available.includes(c.key) && (c.req || []).every(r => this.unlocked.includes(r)) && this.dateOk(c) && (c.limit == null || this.units.filter(u => u.key === c.key && this.alive(u)).length + this.orders.filter(o => o.key === c.key).length < c.limit); }
  unitCost(c) { return Math.round(c.lp * (c.kind === 'replacements' ? (1 + (this.mods().replacementsCost || 0)) : 1)); }
  orderUnit(key) {
    const c = this.catalogItem(key); if (!c || !this.catalogAvailable(c)) return 'Not available';
    const cost = this.unitCost(c); if (this.lp < cost) return 'Not enough logistics points';
    this.lp -= cost; this.orders.push({ what: 'unit', key, eta: c.eta ?? 1 }); this.note(`Ordered: ${c.label} (arrives in ${c.eta ?? 1} wk).`); this.save(); return null;
  }
  replaceCost(u) { const missing = Math.max(0, u.menMax - u.men - u.wounded); const vc = u.veh ? (u.veh.lost ? (this.catalogItem(u.key)?.lp || 12) * 0.6 : (1 - u.veh.hp) * 8) : 0; return Math.ceil((missing * 1.2 + vc) * (1 + (this.mods().replacementsCost || 0))); }
  replenish(uid) {
    const u = this.unit(uid); if (!u) return 'No such unit'; const tf = this.tfOf(uid);
    if (tf && (tf.supply ?? 1) < 0.5) return 'Out of supply: replacements cannot reach this task force';
    const cost = this.replaceCost(u); if (!cost) return 'Already at full strength'; if (this.lp < cost) return 'Not enough logistics points';
    this.lp -= cost; u.men = Math.max(u.men, u.menMax - u.wounded); if (u.veh) { u.veh.hp = 1; u.veh.lost = false; } u.status = 'refit'; u.eta = 1; u.xp = Math.max(0, u.xp - 1);
    this.note(`${u.name}: replacements and repairs (${cost} LP); ready next week.`); this.save(); return null;
  }
  deliveryCell() {
    const hq = this.hq || this.def.start.hq; if (this.owner[hq] === 'player') return hq;
    return (this.def.aor.supplySources || []).find(s => this.owner[s] === 'player') || this.def.aor.cells.find(c => this.owner[c.id] === 'player')?.id;
  }
  deliverUnit(rec) {
    const cell = this.deliveryCell(); this.units.push(rec);
    let tf = this.forces.find(f => f.cell === cell && f.reserve);
    if (!tf) { tf = { id: this.newId('tf'), name: this.side === 'RU' ? 'Reserve group' : 'Brigade reserve', cell, units: [], mp: 0, stance: 'rest', attacked: false, reserve: true, supply: this.supplied?.[cell] ?? 1 }; this.forces.push(tf); }
    tf.units.push(rec.uid);
  }
  // ------------------------------------------------------------------ directives
  directiveDef(id) { return this.def.directives.find(d => d.id === id); }
  issueDirectives() {
    if (this.date >= this.def.start.end) return;   // the operation is over: no new orders on its last day
    for (const d of this.def.directives) {
      if (this.directives.some(a => a.id === d.id) || this.doneDirectives[d.id]) continue;
      const is = d.issue || {}; let ok = false;
      const hasCond = is.after || is.when;
      if (is.date && this.date >= is.date && !hasCond) ok = true;
      if (is.turn != null && this.turn >= is.turn && !hasCond && !is.date) ok = true;
      if (is.after && this.doneDirectives[is.after]) ok = (is.result ? this.doneDirectives[is.after] === is.result : true) && (!is.date || this.date >= is.date);
      if (is.when) { const [k, sid] = is.when.split(':'); ok = (k === 'captured' && this.owner[sid] === 'player') || (k === 'lost' && this.owner[sid] !== 'player' && this.cell(sid)?.owner === 'player'); }
      if (!ok) continue;
      this.activate(d);
    }
  }
  activate(d) {
    if (this.directives.some(a => a.id === d.id) || this.doneDirectives[d.id] || this.date >= this.def.start.end) return;
    const deadline = d.deadlineDate || (d.deadline != null ? addDays(this.date, d.deadline * (this.def.start.turnDays || 7)) : this.def.start.end);
    this.directives.push({ id: d.id, issued: this.turn, issuedDate: this.date, deadline, progress: 0, held: 0 });
    this.note(`New directive from ${d.from || 'higher command'}: ${d.title}.`, 'directive');
  }
  directiveStatus(a) {
    const d = this.directiveDef(a.id), T = d.targets || [];
    const held = T.filter(t => this.owner[t] === 'player').length;
    const txt = { capture: `${held}/${T.length} objectives taken`, hold: d.count ? `held ${a.held}/${d.count} wk` : `${held}/${T.length} held`, survive: `${held}/${T.length} held`, destroy: `${a.progress}/${d.count || 5} vehicles`, raid: `${a.progress}/${d.count || 1} raids`, recon: `${T.filter(t => this.recon[t] != null).length}/${T.length} observed` }[d.kind] || '';
    return { held, txt, weeksLeft: Math.max(0, Math.ceil((parseDate(a.deadline) - parseDate(this.date)) / DAY / (this.def.start.turnDays || 7))) };   // 0 = this is the last week
  }
  checkDirectives(ev = null, endOfTurn = false) {
    for (const a of [...this.directives]) {
      const d = this.directiveDef(a.id); if (!d) { this.directives = this.directives.filter(x => x !== a); continue; }
      const T = d.targets || [], allHeld = T.every(t => this.owner[t] === 'player');
      const past = this.date > a.deadline || this.date >= this.def.start.end;   // the deadline's own week still counts
      // (destroy: a counterattack launched from a target square counts too)
      if (ev) { if (d.kind === 'destroy' && (!T.length || T.includes(ev.cell) || T.includes(ev.from))) a.progress += ev.vehKills || 0; if (d.kind === 'raid' && ev.mode === 'attack' && T.includes(ev.cell)) a.progress++; }
      let res = null;
      if (d.kind === 'capture') { if (allHeld) res = true; else if (past) res = false; }
      else if (d.kind === 'destroy') { if (a.progress >= (d.count || 5)) res = true; else if (past) res = false; }
      else if (d.kind === 'raid') { if (a.progress >= (d.count || 1)) res = true; else if (past) res = false; }
      else if (d.kind === 'recon') { if (T.every(t => this.recon[t] != null || this.owner[t] === 'player')) res = true; else if (past) res = false; }
      else if (d.kind === 'survive') { if (!allHeld) res = false; else if (past) res = true; }
      else if (d.kind === 'hold') {
        if (endOfTurn) a.held = allHeld ? a.held + 1 : 0;
        if (d.count && a.held >= d.count) res = true; else if (past) res = d.count ? false : allHeld;
      }
      if (res != null) this.finishDirective(a, d, res);
    }
  }
  finishDirective(a, d, ok) {
    this.directives = this.directives.filter(x => x !== a); this.doneDirectives[d.id] = ok ? 'success' : 'failure';
    (this.history ||= []).push({ id: d.id, ok, date: this.date });
    if (ok) {
      const r = d.reward || {}; const lp = Math.round((r.lp || 0) * (1 + (this.mods().lpGain || 0))); this.lp += lp;
      for (const t of r.unlock || []) if (!this.unlocked.includes(t)) { this.unlocked.push(t); const ti = this.techItem(t); for (const k of ti?.unlock || []) if (!this.available.includes(k)) this.available.push(k); }
      for (const u of r.units || []) this.deliverUnit(this.record({ ...u, uid: undefined, status: 'ready' }));
      this.note(`Directive complete: ${d.title}.${lp ? ` +${lp} LP from high command.` : ''}${(r.units || []).length ? ` ${(r.units || []).length} unit(s) released to the brigade.` : ''}`, 'good');
    } else { const p = d.penalty?.lp || 0; this.lp = Math.max(0, this.lp - p); this.note(`Directive failed: ${d.title}.${p ? ` High command cuts ${p} LP.` : ''}`, 'bad'); }
    if (d.history) this.note(`History: ${d.history}`, 'history');
    if (d.final) this.finalResult = ok ? 'success' : 'failure';
    const nx = ok ? d.next?.success : d.next?.failure; const nd = nx && this.directiveDef(nx);
    if (nd) this.activate(nd);
  }
  // ------------------------------------------------------------------ battles
  canAttack(tfId, cellId) { return this.plan(tfId, cellId).ok && this.owner[cellId] !== 'player'; }
  battleUnits(uids) {
    return this.units.filter(u => uids.includes(u.uid) && this.combatReady(u)).sort((a, b) => this.unitPower(b) - this.unitPower(a)).slice(0, MAX_BATTLE);
  }
  battleMods(cellId, uids) {
    const m = { ...this.mods() }; const tf = uids.length ? this.tfOf(uids[0]) : null;
    if (tf && (tf.supply ?? 1) < 0.5) { m.morale = (m.morale || 0) - 0.3; m.atgmAmmo = (m.atgmAmmo || 0) - 1; m.artyAmmo = (m.artyAmmo || 0) - 0.4; m.fpvDrones = (m.fpvDrones || 0) - 1; m.outOfSupply = true; }
    return m;
  }
  // a battle the player fights: RTS map, mode, the task force's units, the enemy composition (campaignBattle.js contract)
  battleSetup(cellId, uids, mode = 'attack', from = null) {
    const c = this.cell(cellId), E = this.def.enemy || {};
    const strength = clamp(Math.round(mode === 'attack' ? Math.max(1, this.garrison[cellId] || 1) : (from?.strength || 1)), 1, 3);
    const T = E.forceTemplates || {}; const tpl = T[strength] || T[String(strength)] || [{ kind: 'mech' }, { kind: 'foot' }, { kind: 'tank' }];
    const urban = ['urban', 'industrial'].includes(c.terrain) || (c.settlement && ['town', 'industrial'].includes(c.settlement.kind));
    const force = this.battleUnits(uids);
    return {
      v2: true, sector: cellId, sectorName: this.cellName(cellId), map: c.battleMap || (urban ? 'city' : 'farmland'), mapFallback: urban ? 'city' : 'farmland', mode,
      fort: this.fort[cellId] || 0, strength, force: JSON.parse(JSON.stringify(force)), enemy: tpl.map(e => ({ ...e })), mods: this.battleMods(cellId, uids), side: this.side,
      fpvThreat: E.fpvThreat ?? 0.5, artillery: E.artillery ?? 0.5, turn: this.turn, date: this.date,
    };
  }
  // attack from the staging cell the force stands on (after move()) — returns the setup to fight, or null
  attackSetup(tfId, cellId) {
    const tf = this.tf(tfId); if (!tf || !this.adjacent(tf.cell, cellId) || this.owner[cellId] === 'player' || tf.attacked) return null;
    this.battle = { mode: 'attack', tf: tf.id, cell: cellId, from: tf.cell };
    return this.battleSetup(cellId, tf.units, 'attack');
  }
  defendSetup(attackId) {
    const a = this.pendingAttacks.find(x => x.id === attackId); if (!a) return null;
    const uids = this.forcesAt(a.to).flatMap(f => f.units); if (!this.battleUnits(uids).length) return null;
    this.battle = { mode: 'defend', cell: a.to, attack: a.id, from: a.from };
    return this.battleSetup(a.to, uids, 'defend', a);
  }
  launch(setup) { try { ls()?.setItem(KEY2 + '.battle', JSON.stringify(setup)); } catch {} this.save(); }
  cancelBattle() { this.battle = null; try { ls()?.removeItem(KEY2 + '.battle'); } catch {} this.save(); }
  // a launched battle that never reported back (reload / back button / closed tab): the task group pulled out —
  // counted as a lost battle with light losses (same as the Withdraw button on the battle map)
  withdrawBattle() {
    const B = this.battle; if (!B) return null;
    const uids = B.mode === 'attack' ? (this.tf(B.tf)?.units || []) : this.forcesAt(B.cell).flatMap(f => f.units);
    const r = { sector: B.cell, mode: B.mode, win: false, withdrawn: true, enemyKia: Math.round(rnd(0, 3)), enemyVehLost: 0, objectivesHeld: 0,
      units: this.battleUnits(uids).map(u => { const cas = Math.round(u.men * rnd(0.04, 0.14)); return { uid: u.uid, alive: Math.max(0, u.men - cas), wounded: Math.min(cas, Math.round(cas * 0.6)), kills: 0, vehLost: false, vehHp: u.veh ? (u.veh.lost ? 0 : clamp(u.veh.hp - rnd(0, 0.15), 0.1, 1)) : 1 }; }) };
    try { ls()?.removeItem(KEY2 + '.battle'); } catch {}
    return this.applyResult(r);
  }
  // apply what happened in a battle (fought: src/game/campaignBattle.js collectResult, or auto-resolved)
  applyResult(r) {
    const B = (this.battle && this.battle.cell === r.sector) ? this.battle : { mode: r.mode, cell: r.sector };
    const cellId = r.sector, c = this.cell(cellId); if (!c) return;
    const mods = this.mods(), lpMul = 1 + (mods.lpGain || 0);
    this.stats.battles++;
    for (const ur of r.units || []) {
      const u = this.unit(ur.uid); if (!u) continue;
      u.battles++; u.kills += ur.kills || 0; this.stats.kills += ur.kills || 0;
      const lost = Math.max(0, u.men - ur.alive - ur.wounded); this.stats.losses += lost;
      u.men = ur.alive; u.wounded += ur.wounded; u.woundedT = 2;
      if (u.veh) { if (ur.vehLost && !u.veh.lost) { u.veh.lost = true; u.veh.hp = 0; this.stats.vehLost++; } else if (!u.veh.lost) u.veh.hp = clamp(ur.vehHp + (mods.repair || 0) * (1 - ur.vehHp), 0, 1); }
      u.xp += (ur.alive > 0 || (u.veh && !u.veh.lost) ? 1 : 0) + (r.win ? 1 : 0) + Math.min(2, (ur.kills || 0) / 4);
    }
    this.stats.vehKills += r.enemyVehLost || 0;
    let lp = 6 + (r.enemyKia || 0) * 0.6 + (r.enemyVehLost || 0) * 4 + (r.objectivesHeld || 0) * 5;
    const name = this.cellName(cellId);
    if (B.mode === 'attack') {
      const tf = this.tf(B.tf); if (tf) { tf.attacked = true; tf.mp = 0; }
      if (r.win) {
        this.stats.won++; lp += 10;
        this.owner[cellId] = 'player'; this.garrison[cellId] = 0; this.fort[cellId] = Math.max(0, (this.fort[cellId] || 0) - 1); this.stats.cellsTaken++;
        if (tf) tf.cell = cellId; this.recon[cellId] = this.turn; this.markRecon(cellId);
        this.note(`${name} taken${tf ? ` by ${tf.name}` : ''}.`, 'good');
        const off = this.pendingAttacks.filter(a => a.from === cellId || a.to === cellId);
        if (off.length) { this.pendingAttacks = this.pendingAttacks.filter(a => !off.includes(a)); this.note(`The enemy attack being prepared from ${name} has been broken up.`, 'good'); }
      } else {
        const g = Math.max(0.3, (this.garrison[cellId] || 1) - (r.enemyKia || 0) / 14 - (r.enemyVehLost || 0) * 0.15);
        this.garrison[cellId] = g;
        if (g < 0.8 && (r.objectivesHeld || 0) > 0) { this.owner[cellId] = 'contested'; this.note(`Attack on ${name} failed, but the enemy line there is broken: the cell is contested.`, 'bad'); }
        else this.note(`Attack on ${name} failed.`, 'bad');
        this.recon[cellId] = this.turn;
      }
    } else {
      const a = this.pendingAttacks.find(x => x.id === B.attack) || this.pendingAttacks.find(x => x.to === cellId);
      if (r.win) { this.stats.won++; lp += 8; if (a && this.garrison[a.from] != null) this.garrison[a.from] = Math.max(0.3, this.garrison[a.from] - 0.6); this.note(`Enemy attack on ${name} repulsed.`, 'good'); }
      else this.loseCell(cellId, a?.strength || 1);
      this.pendingAttacks = this.pendingAttacks.filter(x => x !== a);
    }
    if (B.mode === 'defend' && !r.win) lp *= 0.4;                 // a lost position earns little
    if (r.lineOnly) lp = r.win ? 3 : 0;                             // held by the line battalions, not by a task force
    if (r.withdrawn) lp = 0;
    lp = Math.round(lp * lpMul * (r.auto ? 0.7 : 1)); this.lp += lp; if (lp) this.note(`Battle report: +${lp} LP.`);
    this.battle = null; this.battleFought = true;
    this.computeSupply();
    this.checkDirectives({ cell: cellId, from: B.from, mode: B.mode, vehKills: r.enemyVehLost || 0 });
    this.issueDirectives(); this.save();
    return r;
  }
  loseCell(cellId, strength = 1) {
    const name = this.cellName(cellId);
    this.owner[cellId] = 'enemy'; this.garrison[cellId] = clamp(strength * 0.6, 0.5, 3); this.stats.cellsLost++;
    this.depots = (this.depots || []).filter(d => d !== cellId);
    this.note(`${name} lost.`, 'bad');
    if (cellId === (this.hq || this.def.start.hq)) this.relocateHq();
    this.computeSupply();
    for (const tf of this.forcesAt(cellId)) this.retreat(tf);
  }
  // brigade HQ overrun: it displaces to the safest supplied own cell; staff and stores are lost
  relocateHq() {
    const own = this.def.aor.cells.filter(c => this.owner[c.id] === 'player'); if (!own.length) return;
    const dEnemy = c => Math.min(99, ...this.def.aor.cells.filter(e => this.owner[e.id] !== 'player').map(e => Math.max(Math.abs(e.col - c.col), Math.abs(e.row - c.row))));
    const best = own.sort((a, b) => (dEnemy(b) + (b.road ? 0.5 : 0) + (b.settlement ? 0.5 : 0)) - (dEnemy(a) + (a.road ? 0.5 : 0) + (a.settlement ? 0.5 : 0)))[0];
    const pen = Math.min(this.lp, 40); this.lp -= pen; this.hq = best.id;
    this.note(`Brigade headquarters overrun! The staff displaces to ${this.cellName(best.id)}; ${pen} LP of stores lost.`, 'bad');
  }
  // a force pushed out of its cell falls back to the nearest own cell (best supplied); encircled forces break out with losses
  retreat(tf) {
    const near = this.neighbors(tf.cell).filter(n => this.owner[n] === 'player').sort((a, b) => (this.supplied[b] || 0) - (this.supplied[a] || 0) || (this.supplyDist?.[a] ?? 99) - (this.supplyDist?.[b] ?? 99));
    let to = near[0];
    if (!to) {   // encircled: break out to the nearest own cell anywhere, with heavy losses
      const own = this.def.aor.cells.filter(c => this.owner[c.id] === 'player'); const c0 = this.cell(tf.cell);
      to = own.sort((a, b) => Math.hypot(a.col - c0.col, a.row - c0.row) - Math.hypot(b.col - c0.col, b.row - c0.row))[0]?.id;
      for (const u of this.tfUnits(tf)) { const cas = Math.round(u.men * rnd(0.2, 0.4)); u.men -= cas; this.stats.losses += cas; if (u.veh && !u.veh.lost && RND() < 0.35) { u.veh.lost = true; u.veh.hp = 0; this.stats.vehLost++; } }
      this.note(`${tf.name} was encircled and broke out with heavy losses.`, 'bad');
    }
    if (to) { tf.cell = to; tf.mp = 0; this.note(`${tf.name} falls back to ${this.cellName(to)}.`, 'bad'); }
    else { this.note(`${tf.name} was destroyed.`, 'bad'); for (const uid of tf.units) { const u = this.unit(uid); if (u) { this.stats.losses += u.men; u.men = 0; u.wounded = 0; if (u.veh) u.veh.lost = true; } } this.forces = this.forces.filter(f => f !== tf); }
    tf.supply = this.supplied[tf.cell] ?? 0;
  }
  // battles the player doesn't fight himself: strength comparison with noise
  autoResolve(cellId, mode, enemyStrength = null, uids = null, meta = null) {
    if (meta) this.battle = meta;
    const B = this.battle && this.battle.cell === cellId ? this.battle : { mode, cell: cellId };
    if (uids == null) uids = B.mode === 'attack' ? (this.tf(B.tf)?.units || []) : this.forcesAt(cellId).flatMap(f => f.units);
    if (enemyStrength == null) enemyStrength = B.mode === 'attack' ? Math.max(0.5, this.garrison[cellId] || 1) : (this.pendingAttacks.find(a => a.id === B.attack)?.strength || 1);
    const units = this.battleUnits(uids), tf = units.length ? this.tfOf(units[0].uid) : null;
    const supply = tf ? (tf.supply ?? 1) : 1, fort = this.fort[cellId] || 0;
    const c = this.cell(cellId), urban = ['urban', 'industrial'].includes(c?.terrain) ? 1 : c?.terrain === 'village' || c?.terrain === 'forest' ? 0.5 : 0;
    const power = units.reduce((a, u) => a + this.unitPower(u), 0) * (0.6 + 0.4 * supply) + (B.mode === 'defend' ? 1.2 + fort * 0.6 + urban : 0);
    const enemy = enemyStrength * 2.1 + (B.mode === 'attack' ? fort * 0.6 + urban * 0.8 : 0);
    // a cell without a task force is still held by the brigade's line battalions / territorial units
    const lineOnly = B.mode === 'defend' && !units.length, line = lineOnly ? 2.0 : 0;
    const win = (power + line) * rnd(0.75, 1.25) > enemy * rnd(0.75, 1.25);
    const r = { sector: cellId, mode: B.mode, win, auto: true, lineOnly, enemyKia: Math.round(rnd(2, 6) * enemyStrength), enemyVehLost: (RND() < 0.3 * enemyStrength ? 1 : 0) + (win && RND() < 0.12 * enemyStrength ? 1 : 0), objectivesHeld: win ? 2 : (RND() < 0.4 ? 1 : 0),
      units: units.map(u => { const cas = Math.round(u.men * rnd(0.04, win ? 0.22 : 0.4)); const w = Math.round(cas * 0.6); return { uid: u.uid, alive: Math.max(0, u.men - cas), wounded: Math.min(cas, w), kills: Math.round(rnd(0, 3)), vehLost: !!(u.veh && !u.veh.lost && RND() < (win ? 0.08 : 0.25)), vehHp: u.veh ? (u.veh.lost ? 0 : clamp(u.veh.hp - rnd(0, 0.4), 0.1, 1)) : 1 }; }) };
    // casualties stay casualties: alive + wounded never exceed men
    for (const ur of r.units) { const u = this.unit(ur.uid); ur.wounded = Math.min(ur.wounded, Math.max(0, u.men - ur.alive)); }
    return this.applyResult(r);
  }
  // ------------------------------------------------------------------ enemy on the grid
  enemyPhase() {
    const E = this.def.enemy || {}, date = this.date;
    const p = atDate(E.pressure, date, 'p') ?? 0.15, r = atDate(E.reinforce, date, 'r') ?? 0.08;
    const cells = this.def.aor.cells;
    // reinforce and dig in: front garrisons move towards a level set by the date's pressure, the rear stays thin
    const L = 1.2 + p * 5, linked = this.enemyLinked();
    for (const c of cells) {
      if (this.owner[c.id] !== 'enemy') continue;
      const front = this.neighbors(c.id).some(n => this.owner[n] !== 'enemy');
      let g = this.garrison[c.id] || 0;
      // enemy logistics: a square cut off from the enemy's rear withers; a deep salient (mostly surrounded) is hard to reinforce
      if (!linked.has(c.id)) { g = Math.max(0.5, g - rnd(0.15, 0.3)); if ((this.fort[c.id] || 0) > 0 && RND() < 0.2) this.fort[c.id]--; this.garrison[c.id] = g; continue; }
      const salient = this.neighbors(c.id).filter(n => this.owner[n] === 'player').length >= 5;
      const tgt = ((front ? L : 1.0) + (c.vp || 0) * 0.15) * (salient ? 0.8 : 1);
      g += (tgt - g) * clamp(r * 3, 0.05, 0.6) + rnd(-0.15, 0.15);
      if (front && g < 0.8) g = 0.8 + RND() * 0.3;
      this.garrison[c.id] = clamp(g, 0.3, 3);
      if (front && !salient && (this.fort[c.id] || 0) < 3 && RND() < r * 0.6) this.fort[c.id] = (this.fort[c.id] || 0) + 1;
    }
    // the brigade's line battalions dig in on quiet own front cells
    for (const c of cells) if (this.owner[c.id] === 'player' && (this.fort[c.id] || 0) < 1 && this.neighbors(c.id).some(n => this.owner[n] === 'enemy') && RND() < 0.12) this.fort[c.id] = 1;
    // contested cells drift back to the enemy unless own forces sit next to them
    for (const c of cells) if (this.owner[c.id] === 'contested' && !this.forces.some(f => this.adjacent(f.cell, c.id)) && RND() < 0.4) { this.owner[c.id] = 'enemy'; this.garrison[c.id] = Math.max(this.garrison[c.id] || 0, 0.8); this.note(`${this.cellName(c.id)}: the enemy has reoccupied the contested positions.`, 'bad'); }
    // harassment: artillery and drones on forces at the front
    const art = E.artillery ?? 0.5;
    for (const tf of this.forces) {
      if (!this.neighbors(tf.cell).some(n => this.owner[n] === 'enemy') || RND() > art * 0.3) continue;
      const us = this.tfUnits(tf).filter(u => this.alive(u)); if (!us.length) continue;
      const u = us[Math.floor(RND() * us.length)];
      if (u.veh && !u.veh.lost && RND() < 0.5) { u.veh.hp = Math.max(0.15, u.veh.hp - rnd(0.1, 0.3)); this.note(`${tf.name}: ${u.name} damaged by enemy ${RND() < (E.fpvThreat ?? 0.5) ? 'FPV drones' : 'artillery'}.`, 'bad'); }
      else if (u.men > 1) { const w = 1 + (RND() < 0.3 ? 1 : 0); u.men -= w; u.wounded += w; u.woundedT = 2; this.note(`${tf.name}: ${w} wounded by enemy shelling.`, 'bad'); }
    }
    // counterattacks along the front, weighted by the date's pressure
    this.pendingAttacks = [];
    const maxA = p < 0.12 ? 1 : p < 0.2 ? 2 : 3, cand = [];
    for (const c of cells) {
      if (this.owner[c.id] === 'enemy') continue;
      const srcs = this.neighbors(c.id).filter(n => this.owner[n] === 'enemy' && (this.garrison[n] || 0) >= 1.4); if (!srcs.length) continue;
      const from = srcs.sort((a, b) => this.garrison[b] - this.garrison[a])[0], g = this.garrison[from];
      const hasTf = this.forcesAt(c.id).length > 0;
      const w = p * (0.5 + (c.vp || 0) * 0.15) * (g / 2) * (hasTf ? 0.6 : 1) * (this.owner[c.id] === 'contested' ? 1.8 : 1);
      cand.push({ c, from, g, w });
    }
    for (let i = 0; i < maxA && cand.length; i++) {
      if (RND() >= p * 1.3) continue;
      let x = RND() * cand.reduce((a, k) => a + k.w, 0), k = cand[0];
      for (const q of cand) { x -= q.w; if (x <= 0) { k = q; break; } }
      cand.splice(cand.indexOf(k), 1);
      const strength = clamp(Math.round(k.g * rnd(0.55, 1.0)), 1, 3);
      if (this.owner[k.c.id] === 'contested') { this.owner[k.c.id] = 'enemy'; this.garrison[k.c.id] = Math.max(0.8, k.g * 0.5); this.note(`The enemy has retaken ${this.cellName(k.c.id)}.`, 'bad'); continue; }
      this.garrison[k.from] = Math.max(0.5, k.g - 0.8);
      this.pendingAttacks.push({ id: this.newId('ea'), from: k.from, to: k.c.id, strength });
      this.note(`Intelligence: enemy preparing an attack on ${this.cellName(k.c.id)} from ${this.cellName(k.from)} (${['', 'company', 'reinforced company', 'battalion'][strength]}).`, 'bad');
    }
  }
  // enemy-held squares still connected to the enemy's rear edge (through enemy / contested squares)
  enemyLinked() {
    const A = this.def.aor, rear = { north: c => c.row === 0, south: c => c.row === A.rows - 1, east: c => c.col === A.cols - 1, west: c => c.col === 0 }[A.enemyEdge || 'south'];
    const seen = new Set(A.cells.filter(c => rear(c) && this.owner[c.id] !== 'player').map(c => c.id)), q = [...seen];
    while (q.length) { const cur = q.pop(); for (const n of this.neighbors(cur)) if (!seen.has(n) && this.owner[n] !== 'player') { seen.add(n); q.push(n); } }
    return seen;
  }
  // ------------------------------------------------------------------ end of turn
  endTurn() {
    if (this.outcome()) return;
    // enemy attacks announced last week that the player has not answered: resolved with whoever stands there
    for (const a of [...this.pendingAttacks]) { this.battle = { mode: 'defend', cell: a.to, attack: a.id, from: a.from }; this.autoResolve(a.to, 'defend', a.strength); }
    this.pendingAttacks = [];
    // stances: dig in / rest
    for (const tf of this.forces) {
      const moved = tf.mp < this.tfMpMax(tf) - 1e-6 || tf.attacked;
      if (tf.stance === 'hold' && !moved && (this.fort[tf.cell] || 0) < 2 && RND() < 0.6) { this.fort[tf.cell] = (this.fort[tf.cell] || 0) + 1; this.note(`${tf.name} dug in at ${this.cellName(tf.cell)} (fortifications ${this.fort[tf.cell]}).`); }
      if (tf.stance === 'rest' && !moved && (tf.supply ?? 0) >= 1) for (const u of this.tfUnits(tf)) { if (u.veh && !u.veh.lost) u.veh.hp = Math.min(1, u.veh.hp + 0.1); if (u.woundedT > 0) u.woundedT--; }
      this.markRecon(tf.cell, this.reconRange(tf));
    }
    this.checkDirectives(null, true);
    this.turn++; this.battleFought = false;
    // deliveries from high command
    for (const o of this.orders) o.eta--;
    for (const o of this.orders.filter(o => o.eta <= 0)) {
      if (o.what === 'tech') { this.unlocked.push(o.key); const t = this.techItem(o.key); for (const k of t?.unlock || []) if (!this.available.includes(k)) this.available.push(k); this.note(`Delivered: ${t?.name}.`, 'good'); }
      else { const c = this.catalogItem(o.key); if (c?.kind === 'replacements') { const n = this.distributeReplacements(c.men || 8); this.note(`${c.men || 8} replacements arrived${n < (c.men || 8) ? ` (${(c.men || 8) - n} held at the brigade depot: no unit in supply needs them)` : ''}.`, 'good'); } else if (c) { this.deliverUnit(this.record({ key: c.key, kind: c.kind, men: c.men, veh: c.vehicle ? { kind: c.vehicle } : null, name: this.unitName(c) })); this.note(`Arrived at ${this.cellName(this.deliveryCell())}: ${c.label}.`, 'good'); } }
    }
    this.orders = this.orders.filter(o => o.eta > 0);
    this.computeSupply();
    // refits, wounded returning (in supply only), wear out of supply
    for (const tf of this.forces) {
      const sup = tf.supply ?? 0;
      for (const u of this.tfUnits(tf)) {
        if (u.status !== 'ready' && --u.eta <= 0) u.status = 'ready';
        if (u.wounded && sup >= 0.5 && --u.woundedT <= 0) { const back = Math.ceil(u.wounded * 0.6); u.men = Math.min(u.menMax, u.men + back); u.wounded = 0; }
        if (sup < 0.5 && u.veh && !u.veh.lost) u.veh.hp = Math.max(0.2, u.veh.hp - 0.04);
      }
      if (sup < 0.5) this.note(`${tf.name} is out of supply at ${this.cellName(tf.cell)}: no fuel, ammunition or replacements.`, 'bad');
    }
    // dead units leave; empty task forces dissolve
    const gone = new Set(this.units.filter(u => !this.alive(u) && u.status !== 'arriving').map(u => u.uid));
    if (gone.size) { this.units = this.units.filter(u => !gone.has(u.uid)); for (const f of this.forces) f.units = f.units.filter(id => !gone.has(id)); }
    this.forces = this.forces.filter(f => f.units.length);
    // LP from held, supplied cells
    const inc = this.lpIncome(); if (inc) { this.lp += inc; this.note(`Supply from held cells: +${inc} LP.`); }
    // versus: the other side is a human; on the operation's last day the enemy prepares nothing more (the campaign ends)
    if (this.def.versus || this.date >= this.def.start.end) this.pendingAttacks = []; else this.enemyPhase();
    this.computeSupply(); this.resetMoves();
    this.checkDirectives(); this.issueDirectives(); this.newsUpTo(this.date);
    this.save();
  }
  distributeReplacements(n) {
    let used = 0;
    const us = this.forces.filter(f => (f.supply ?? 1) >= 0.5).flatMap(f => this.tfUnits(f)).filter(u => u.menMax > 0).sort((a, b) => (a.men / a.menMax) - (b.men / b.menMax));
    for (const u of us) { const k = Math.min(n - used, u.menMax - u.men - u.wounded); if (k > 0) { u.men += k; used += k; u.xp = Math.max(0, u.xp - 0.5); } if (used >= n) break; }
    return used;
  }
  unitName(c) { const n = this.units.filter(u => u.key === c.key).length + 1; return `${c.label} ${n > 1 ? '#' + n : ''}`.trim(); }
  note(text, kind = '') { this.logSeq = (this.logSeq || 0) + 1; this.log.push({ turn: this.turn, date: this.date, text, kind, n: this.logSeq }); if (this.log.length > 300) this.log.shift(); }
  // country-level news from the theatre as the date passes
  newsUpTo(date) {
    this.seenEvents ||= {}; const out = [];
    for (const e of this.def.theatre?.events || []) { const k = e.date + e.text; if (this.seenEvents[k] || String(e.date) > date) continue; this.seenEvents[k] = 1; this.note(`${dateLabel(e.date.length > 7 ? e.date : e.date + '-01')}: ${e.text}`, 'news'); out.push(e); }
    this.lastNews = out; return out;
  }
  // ------------------------------------------------------------------ the operation's outcome
  score() {
    const cells = this.def.aor.cells, startOwn = cells.filter(c => c.owner === 'player').length, own = cells.filter(c => this.owner[c.id] === 'player').length;
    const ok = Object.values(this.doneDirectives).filter(v => v === 'success').length, fail = Object.values(this.doneDirectives).filter(v => v === 'failure').length;
    return { cells: own - startOwn, ok, fail, vp: cells.filter(c => this.owner[c.id] === 'player').reduce((a, c) => a + (c.vp || 0), 0) - cells.filter(c => c.owner === 'player').reduce((a, c) => a + (c.vp || 0), 0) };
  }
  outcome() {
    if (this.def.versus) return this.vsOutcome || null;   // versus: decided by the host for both sides (versus.js)
    return this.baseOutcome();
  }
  baseOutcome() {
    const cells = this.def.aor.cells, startOwn = cells.filter(c => c.owner === 'player').length, own = cells.filter(c => this.owner[c.id] === 'player').length;
    if (own < Math.max(2, startOwn * 0.35)) return { win: false, title: 'DEFEAT', text: 'The brigade’s sector has collapsed: most of the area of responsibility is in enemy hands.' };
    if (!this.units.some(u => this.alive(u)) && !this.orders.some(o => o.what === 'unit') && this.lp < 20) return { win: false, title: 'DEFEAT', text: 'The brigade is no longer combat-capable.' };
    if (this.finalResult === 'success') { const s = this.score(), win = s.ok >= s.fail; return { win, title: win ? 'VICTORY' : 'OPERATION CONCLUDED', text: `The final directive of the operation has been carried out. ${s.ok} directives carried out, ${s.fail} failed; ${s.cells >= 0 ? `${s.cells} grid squares gained` : `${-s.cells} grid squares lost`}.` }; }
    if (this.finalResult === 'failure') return { win: false, title: 'OPERATION FAILED', text: 'The final directive of the operation could not be carried out.' };
    if (this.date >= this.def.start.end || this.turn > this.maxTurn) {
      const s = this.score(), good = s.ok > s.fail && s.cells >= 0;
      return { win: good, title: good ? 'OPERATION CONCLUDED' : 'STALEMATE', text: `${dateLabel(this.date, true)}: the campaign ends. ${s.ok} directives carried out, ${s.fail} failed; ${s.cells >= 0 ? `${s.cells} grid cells gained` : `${-s.cells} grid cells lost`}.` };
    }
    return null;
  }
}
const fmt = v => (Math.round(v * 10) / 10).toString();
