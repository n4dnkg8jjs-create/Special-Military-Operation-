// Campaign v2 rules — GRID strategic layer (schema2.js). Weekly turns with real dates (Feb 2023 → Mar 2024), task
// forces that split / merge / move with movement points over grid cells (terrain, roads, rivers), attacks into enemy
// cells (fought on the RTS battle maps or auto-resolved), enemy counterattacks on the grid, logistics (supply
// connectivity from supply sources through own cells, LP income, out-of-supply penalties), directives from higher
// command with dates / branches / history notes, orders from high command (units, replacements, date-gated tech),
// persistence in localStorage. Pure logic — the 3D screen is map3d.js + ui.js.
//
// battleSetup() / applyResult() keep the contract of src/game/campaignBattle.js (deployCampaign / collectResult).
import { MODS } from '../schema.js';
import * as SUP from './supply.js';
import * as F from './fires.js';
import * as UAVR from './recon.js';
import * as AI from './ai.js';
import * as GR from './growth.js';

export const KEY2 = 'smo.campaign.v2';
export const MAX_BATTLE = 12;                 // units one battle can deploy (the rest of a task force stays in reserve)
export const FRONTAGE = 8;                    // companies that can fight for one 2 km square at once (auto-resolve)
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
// tech effects the campaign layer understands (on top of the battle MODS in schema.js): see PROGRESS_RULES.md
export const CAMPAIGN_MODS = ['supplyRange', 'uavSorties', 'ammoAlloc', 'ammoMax', 'cbBonus', 'medReturn'];   // medReturn: + share of the wounded back to their unit (endTurn)
const ROAD_COST = [Infinity, 1.5, 1];
const FOOT_KINDS = new Set(['assault', 'atgm', 'fpv']);

export class Campaign2 {
  constructor(def, saved = null) {
    // def = the content definition (never mutated); this.def = its grown view (growth.js: bands added past the original grid)
    this.baseDef = def; this.def = GR.growDef(def, saved?.grown); this.index();
    if (saved) { Object.assign(this, saved); this.baseDef = def; this.def = GR.growDef(def, this.grown); this.index(); this.ensureV4(); this.computeSupply(); return; }
    const S = def.start;
    this.v = 2; this.side = def.id; this.sig = this.signature(); this.turn = 1; this.lp = S.lp || 0; this.nextId = 1; this.hq = S.hq;
    this.owner = {}; this.garrison = {}; this.fort = {};
    for (const c of def.aor.cells) { this.owner[c.id] = c.owner; this.garrison[c.id] = c.owner === 'player' ? 0 : (c.garrison ?? 1); this.fort[c.id] = c.fort || 0; }
    this.units = (S.units || S.force || []).map(u => this.record(u));
    this.forces = (S.forces || []).map(f => ({ id: f.id || this.newId('tf'), name: f.name || 'Task force', cell: f.cell, units: [...f.units], mp: 0, stance: f.stance || 'attack', attacked: false }));
    if (!this.forces.length && this.units.length) this.forces.push({ id: this.newId('tf'), name: 'Task force 1', cell: S.hq, units: this.units.map(u => u.uid), mp: 0, stance: 'attack', attacked: false });
    this.grown = []; this.gridV = 0;
    this.unlocked = [...(S.unlocked || [])]; this.available = [...(S.available || [])];
    this.orders = []; this.directives = []; this.doneDirectives = {}; this.depots = [];
    this.recon = {}; this.pendingAttacks = []; this.battle = null; this.seenEvents = {};
    this.log = [];
    this.stats = { battles: 0, won: 0, kills: 0, losses: 0, vehLost: 0, vehKills: 0, cellsTaken: 0, cellsLost: 0 };
    this.note(def.intro?.lines?.[0] || 'The operation begins.');
    this.ensureV4();
    if (this.efDeploy) { AI.deploy(this); this.efDeploy = false; }
    this.computeSupply(); this.resetMoves(); this.issueDirectives(); this.newsUpTo(this.date);
    if (def.goal) this.note(`Operation goal: ${def.goal.title}. ${def.goal.text || ''}`, 'directive');
    this.updateSpots();
  }
  // ------------------------------------------------------------------ v5: the grid grows past the original AOR (growth.js)
  // single player: add every band whose trigger holds (a held square within GROW_REACH of the grid's enemy edge).
  // Versus: the host grows both sides (VersusGame.grow). Returns the bands added.
  checkGrowth() {
    if (this.def.versus) return [];
    const out = []; let b; while ((b = GR.nextBand(this)) && out.length < 3) { GR.applyBand(this, b); out.push(b.id); }
    if (out.length) this.issueDirectives();
    return out;
  }
  // the next band and how close the front is to triggering it: { band, name, dist, reach } or null (UI / tutorial)
  growthStatus() {
    const X = this.baseDef?.aor?.ext; if (!X) return null; const b = X.bands.find(x => !(this.grown || []).includes(x.id));
    const A = this.def.aor, e = GR.edgeLine(A, X.dir), own = A.cells.filter(c => this.owner[c.id] === 'player' && c.owner !== 'player');
    const dist = own.length ? Math.min(...own.map(c => Math.abs(c[e.key] - e.v))) : 99;
    return { grown: [...(this.grown || [])], total: X.bands.length, next: b ? { id: b.id, name: b.name || b.id, cells: b.cells.length } : null, dist, reach: X.reach ?? GR.GROW_REACH, dir: X.dir };
  }
  // ------------------------------------------------------------------ v5: big formations give themselves away (recon.js)
  // this.spots: the enemy task forces the brigade sees this week because of their size (set at the start of the week)
  updateSpots() { this.spots = { turn: this.turn, enemy: this.def.versus ? [] : UAVR.spottedList(this, 'enemy') }; return this.spots; }
  // [{ id, cell, name, kind, str, n, sig, depth }] — enemy formations spotted without recon this week
  spottedEnemy() { const S = this.spots; if (!S || S.turn !== this.turn) return []; return S.enemy.filter(s => (this.eforces || []).some(f => f.id === s.id && f.cell === s.cell)); }
  // live signature of an own task force: { n, sig, depth, moved, attacked, cover, spotted (now), dist, lastWeek (the
  // enemy saw it at the start of its last turn) }
  spotStatus(tfId) {
    const tf = this.tf(tfId); if (!tf) return null;
    const s = UAVR.signature(this, 'player', tf), sp = UAVR.spotted(this, 'player', tf);
    return { ...s, spotted: !!sp, dist: sp?.dist ?? null, size: UAVR.SPOT_SIZE, lastWeek: !!(this.espots && this.espots.turn === this.turn && this.espots.list.some(x => x.id === tf.id)) };
  }
  // v4 state: fires, drones, enemy task forces, intel, opened squares (also fills saves from older versions)
  ensureV4() {
    const S = this.def.start, E = this.def.enemy || {};
    const bat = (b, side, i) => ({ id: b.id || `${side === 'player' ? 'b' : 'eb'}${i + 1}`, kind: b.kind, name: b.name || F.BATTERY[b.kind]?.label || b.kind, cell: b.cell, hp: b.hp ?? 1, acted: 0, moved: 0, revealed: null, down: 0, fired: 0 });
    if (!this.arty) this.arty = { player: (S.batteries || []).map((b, i) => bat(b, 'player', i)), enemy: this.def.versus ? [] : (E.batteries || []).map((b, i) => bat(b, 'enemy', i)) };
    if (!this.ammo) this.ammo = { player: S.ammoStart ?? 6, enemy: E.ammoStart ?? 6 };
    if (!this.uav) this.uav = { player: { stock: S.uavStock ?? 6, max: UAVR.UAV_MAX, used: 0, lost: 0 }, enemy: { stock: E.uavStock ?? 6, max: UAVR.UAV_MAX, used: 0, lost: 0 } };
    // v7: the enemy brigade = battalion task forces of companies (ai.js makeForce); outposts fill the gaps in its line
    if (!this.eforces) { this.eforces = this.def.versus ? [] : (E.forces || []).map(f => AI.makeForce(this, f)); this.efDeploy = true; }
    for (const f of this.eforces) if (!f.coys) AI.migrate(f);
    this.elost ||= {};
    this.intel ||= {}; this.eintel ||= {}; this.suppressed ||= {}; this.interdicted ||= {}; this.opened ||= {}; this.justOpened ||= [];
    this.fireLog ||= []; this.uavLog ||= []; this.firePlans ||= [];
  }
  signature() { const a = (this.baseDef || this.def).aor; return `${this.def.id}:${a.cols}x${a.rows}:${a.cells.length}:${this.def.start.date}`; }
  index() {
    const a = this.def.aor; this.cellById = {}; this.grid = [];
    for (const c of a.cells) { this.cellById[c.id] = c; (this.grid[c.col] ||= [])[c.row] = c; }
    this.blocked = new Set((a.blocked || []).map(([p, q]) => [p, q].sort().join('|')));
  }
  newId(p) {
    const used = id => (this.forces || []).some(f => f.id === id) || (this.eforces || []).some(f => f.id === id) || [...(this.arty?.player || []), ...(this.arty?.enemy || [])].some(b => b.id === id) || (this.units || []).some(u => u.uid === id) || (this.pendingAttacks || []).some(a => a.id === id);
    let id; do { this.nextId = (this.nextId || 1) + 1; id = `${p}${this.nextId}`; } while (used(id)); return id;
  }
  // ------------------------------------------------------------------ persistence
  static load(defs) {
    const L = ls(); if (!L) return null;
    try { const raw = L.getItem(KEY2); if (!raw) return null; const s = JSON.parse(raw); const def = defs[s.side]; if (!def) return null; const C = new Campaign2(def, s); return C.sig === C.signature() ? C : null; } catch (e) { console.warn('campaign v2 load failed', e); return null; }
  }
  save() { if (this.def.versus) return; const { def, baseDef, cellById, grid, blocked, ...rest } = this; try { ls()?.setItem(KEY2, JSON.stringify(rest)); } catch (e) { console.warn('campaign save failed', e); } }
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
  cellName(id) { const c = this.cell(id); if (!c) return id; return c.name || c.settlement?.name || `${({ fields: 'Fields', forest: 'Woods', heights: 'Heights', balka: 'Balka', village: 'Village', urban: 'Town', industrial: 'Works', water: 'Water' })[c.terrain] || 'Grid'} ${String.fromCharCode(65 + (((c.col % 26) + 26) % 26))}${c.row + 1}`; }
  gridRef(id) { const c = this.cell(id); return c ? `${String.fromCharCode(65 + (((c.col % 26) + 26) % 26))}${c.row + 1}` : '?'; }
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
  rename(tfId, name) { const tf = this.tf(tfId); if (tf && name) { tf.name = String(name).slice(0, 32); tf.autoName = false; this.save(); } }
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
  // terrain / road / river cost of a step, without ownership effects (the enemy AI moves by the same table)
  baseCost(fromId, toId) {
    const a = this.cell(fromId), b = this.cell(toId); if (!a || !b || !this.adjacent(fromId, toId)) return Infinity;
    if (this.blocked.has([fromId, toId].sort().join('|'))) return Infinity;
    let c = TERRAIN_COST[b.terrain] ?? 2; if (!isFinite(c)) return Infinity;
    const road = Math.min(a.road || 0, b.road || 0);
    if (road) c = Math.min(c, ROAD_COST[road]); else if (a.col !== b.col && a.row !== b.row) c *= 1.4;
    if (b.river && !b.bridge && !(a.river && road)) c += 2;
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
    if (!this.isOpen(toId)) return { ok: false, attack: true, why: 'Beyond the brigade\'s area of responsibility' };
    // (v7) a square no enemy force holds or covers (and the brigade can see that): occupied by moving in, no battle;
    // clearing it takes the rest of the task force's week
    // (versus: the host's picture of which of the other player's squares are held, C.vsCover — versus.js holds)
    if (tgt === 'enemy' && (this.def.versus ? !this.vsHeld(toId) : AI.undefended(this, toId)) && this.fresh(toId)) {
      let best = null;
      for (const n of this.neighbors(toId)) { if (dist[n] == null) continue; const c = dist[n] + this.enterCost(n, toId); if (!isFinite(c)) continue; if (!best || c < best.c) best = { n, c }; }
      if (best) {
        const path = [...route(best.n), toId], ok = best.c <= tf.mp + 1e-6 || (full && best.n === tf.cell);
        return { ok, occupy: true, attack: false, path, cost: best.c, mpLeft: Math.max(0, tf.mp - best.c), why: ok ? '' : `Needs ${fmt(best.c)} MP to occupy (${fmt(tf.mp)} left)` };
      }
    }
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
    // (v7) clearing an occupied square (mines, stragglers) takes the rest of the week
    if (p.occupy) { tf.mp = 0; tf.cell = toId; tf.stance = 'attack'; this.occupy(toId, tf); this.markRecon(tf.cell, this.reconRange(tf)); this.save(); return p; }
    tf.mp = Math.max(0, tf.mp - p.cost); tf.cell = toId; tf.stance = 'attack'; this.markRecon(tf.cell, this.reconRange(tf)); this.save(); return p;
  }
  // (v7) an undefended enemy square taken without a fight (plan().occupy)
  occupy(cellId, tf = null) {
    const hub = (this.def.aor.hubs || []).find(h => h.cell === cellId && (h.side || 'player') === 'enemy');
    for (const b of (this.arty?.enemy || []).filter(x => x.cell === cellId && !x.down)) { b.hp = 0; b.down = F.REBUILD; this.note(`${b.name} overrun at ${this.cellName(cellId)}.`, 'good'); }
    this.owner[cellId] = 'player'; this.stats.cellsTaken++; this.stats.occupied = (this.stats.occupied || 0) + 1; (this.elost ||= {})[cellId] = this.turn;
    this.recon[cellId] = this.turn;
    this.note(`${this.cellName(cellId)} occupied${tf ? ` by ${tf.name}` : ''}: no enemy forces held it.${hub ? ` Enemy logistics hub captured: ${hub.name}.` : ''}`, 'good');
    if (hub) this.lp += 10;
    this.pendingAttacks = this.pendingAttacks.filter(a => a.from !== cellId);
    this.checkGrowth(); this.computeSupply();
    this.checkDirectives({ cell: cellId, mode: 'occupy', vehKills: 0 }); this.issueDirectives();
  }
  resetMoves() { for (const f of this.forces) { f.mp = this.tfMpMax(f); f.attacked = false; f.planned = null; } }
  // versus: attacks are planned during the week and carried out by the host when both commanders have ended it
  planAttack(tfId, cellId, auto = false) {
    const tf = this.tf(tfId), p = this.plan(tfId, cellId); if (!tf) return 'No task force'; if (!p.ok || !p.attack) return p.why || 'Cannot attack there';
    this.move(tfId, cellId); tf.planned = { cell: cellId, auto: !!auto }; tf.attacked = true; tf.mp = 0;
    this.note(`${tf.name} will attack ${this.cellName(cellId)} from ${this.cellName(tf.cell)} at the end of the week${auto ? ' (staff-resolved)' : ''}.`); return null;
  }
  cancelAttack(tfId) { const tf = this.tf(tfId); if (!tf?.planned) return 'No attack planned'; this.note(`${tf.name}: attack on ${this.cellName(tf.planned.cell)} called off.`); tf.planned = null; tf.attacked = false; return null; }
  markRecon(cellId, r = 1) { const c = this.cell(cellId); if (!c) return; for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) { const n = this.cellAt(c.col + dx, c.row + dy)?.id; if (n && this.owner[n] !== 'player') this.observe(n); } this.refreshPresence(); }
  // organic reconnaissance of a task force: the next square (company drones, observation posts). Deeper looks are UAV
  // sorties (flyUav). An FPV / drone team in the force sees two squares out.
  reconRange(tf) { return this.tfUnits(tf).some(u => u.kind === 'fpv' && this.combatReady(u)) ? 2 : 1; }
  known(cellId) { return this.owner[cellId] === 'player' || this.recon[cellId] != null || this.forces.some(f => this.adjacent(f.cell, cellId)); }
  // a square under observation this week: snapshot of what is there (for the UI after the drone has gone)
  observe(cellId) { this.recon[cellId] = this.turn; this.intel[cellId] = this.snapshot(cellId); }
  snapshot(cellId) {
    const g = AI.aiCampaign(this) ? AI.defPower(this, cellId) / AI.EF_POWER : (this.garrison[cellId] || 0);
    return { turn: this.turn, garrison: Math.round(g * 10) / 10, fort: this.fort[cellId] || 0, supply: this.esupplied?.[cellId] ?? null,
      forces: AI.forcesAt(this, cellId).map(f => ({ id: f.id, name: f.name, kind: f.kind, str: Math.round(f.str * 10) / 10, n: AI.ncoys(f), role: f.role || 'line', xp: XP_NAMES[xpLevel(f.xp || 0)], coys: (f.coys || []).map(c => c.k) })),
      batteries: (this.arty?.enemy || []).filter(b => b.cell === cellId && !b.down).map(b => ({ id: b.id, name: b.name, kind: b.kind, hp: b.hp })) };
  }
  fresh(cellId) { return this.owner[cellId] === 'player' || (this.recon[cellId] ?? -9) >= this.turn - 1 || this.forces.some(f => this.adjacent(f.cell, cellId)); }
  // what the brigade knows about a square: live when observed this / last week or in contact, else the last snapshot
  // { fresh, age, owner, garrison, fort, supply, forces:[{name,kind,str}], batteries:[{name,kind,hp}], hub, suppressed, interdicted, goal }
  cellIntel(cellId) {
    const c = this.cell(cellId); if (!c) return null;
    const hub = (this.def.aor.hubs || []).find(h => h.cell === cellId) || null, goal = (this.def.goal?.cells || []).find(g => g.cell === cellId) || null;
    const base = { owner: this.owner[cellId], open: this.isOpen(cellId), hub, goal, suppressed: this.suppressed[cellId] || null, interdicted: this.interdicted[cellId] || null };
    if (this.owner[cellId] === 'player') return { ...base, fresh: true, age: 0, supply: this.supplied[cellId] ?? 0, forces: this.forcesAt(cellId).map(t => ({ id: t.id, name: t.name, power: Math.round(this.tfPower(t) * 10) / 10 })), batteries: this.batteries('player').filter(b => b.cell === cellId) };
    const sp = this.spottedEnemy().filter(x => x.cell === cellId).map(x => ({ id: x.id, name: x.name, kind: x.kind, str: Math.round(x.str * 10) / 10, spotted: true }));
    if (this.fresh(cellId)) { const contactOnly = (this.recon[cellId] ?? -9) < this.turn - 1, I = this.snapshot(cellId); return { ...base, ...I, forces: I.forces.map(f => (sp.some(x => x.id === f.id) ? { ...f, spotted: true } : f)), spotted: sp.length > 0, batteries: contactOnly ? [] : I.batteries, fresh: true, age: 0 }; }
    const I = this.intel[cellId]; if (!I) return { ...base, fresh: false, age: null, garrison: null, forces: sp, spotted: sp.length > 0, batteries: [] };
    return { ...base, ...I, forces: sp.length ? sp : I.forces, spotted: sp.length > 0, fresh: false, age: this.turn - I.turn };
  }
  // ------------------------------------------------------------------ fires (fires.js): the brigade's artillery group
  batteries(side = 'player') { return this.arty?.[side] || []; }
  battery(id) { return [...this.batteries('player'), ...this.batteries('enemy')].find(b => b.id === id); }
  batteryRange(id) { const b = this.battery(id); return b ? { km: F.batteryDef(b).km, cells: F.rangeCells(this, b), coverage: F.coverage(this, b) } : null; }
  fireCheck(batId, kind, cellId) { return F.fireCheck(this, 'player', this.batteries('player').find(b => b.id === batId), kind, cellId); }
  // the missions a battery can fire at each square: { cellId: ['suppress', 'interdict', 'counterbattery'] }
  fireTargets(batId) { const b = this.batteries('player').find(x => x.id === batId), out = {}; if (!b) return out; for (const id of F.coverage(this, b)) { const k = Object.keys(F.MISSIONS).filter(m => !F.fireCheck(this, 'player', b, m, id)); if (k.length) out[id] = k; } return out; }
  // the enemy batteries the brigade has found (fired last / this week, or under drone observation)
  foundBatteries() { return this.batteries('enemy').filter(b => F.found(this, 'player', b)).map(b => ({ id: b.id, name: b.name, kind: b.kind, cell: b.cell, hp: b.hp })); }
  // returns an error string, or the mission result { ok, kind, cell, ... } (effects already applied in single player;
  // in versus the host applies them to the other side: VersusGame.resolveFires)
  fire(batId, kind, cellId) {
    const r = F.fire(this, 'player', batId, kind, cellId, RND); if (!r.ok) return r.why;
    if (this.def.versus) { this.firePlans.push({ ...r, turn: this.turn }); this.note(`${this.battery(batId).name}: ${F.MISSIONS[kind].label.toLowerCase()} mission on ${this.cellName(cellId)} planned for this week.`); this.save(); return r; }
    this.applyFire(r); this.save(); return r;
  }
  moveBatteryCheck(batId, cellId) { return F.moveCheck(this, 'player', this.batteries('player').find(b => b.id === batId), cellId); }
  moveBattery(batId, cellId) { const e = F.displace(this, 'player', batId, cellId); if (!e) { this.note(`${this.battery(batId).name} displaces to ${this.cellName(cellId)}.`); this.save(); } return e; }
  // effects of a fire mission (single player: both sides live in this object)
  applyFire(r, rnd = RND) {
    const S = r.side, X = r.cell, name = this.cellName(X), B = this.battery(r.battery), us = S === 'player';
    this.fireLog.push({ turn: this.turn, side: S, kind: r.kind, cell: X, battery: r.battery }); if (this.fireLog.length > 60) this.fireLog.shift();
    if (r.kind === 'suppress') {
      const cur = this.suppressed[X], n = Math.min(F.SUPPRESS_MAX, (cur && cur.by === S ? cur.n : 0) + r.n);
      this.suppressed[X] = { n, by: S, turn: this.turn };
      if (us) { if (!AI.aiCampaign(this)) this.garrison[X] = Math.max(0.3, (this.garrison[X] || 0) - 0.1 * r.n); AI.attrit(this, X, 0.06 * r.n * (this.spottedEnemy().some(f => f.cell === X) ? 1.5 : 1), null, 0); this.note(`${B?.name || 'Artillery'}: fire mission on ${name} — the defenders are suppressed (−${Math.round((1 - F.suppressMul(this, X, S)) * 100)}% this week).`, 'good'); }
      else this.harm(X, r.n, rnd);
    } else if (r.kind === 'interdict') {
      this.interdicted[X] = { by: S, turn: this.turn }; this.computeSupply();
      if (us) this.note(`${B?.name || 'Artillery'}: the roads through ${name} are under fire — enemy supply through it is cut back.`, 'good');
      else this.note(`Enemy artillery and drones interdict the roads through ${name}: our supply through it is cut back this week.`, 'bad');
    } else if (r.kind === 'counterbattery') {
      const hits = F.resolveCB(this, S, X, (r.cb || 0) + (us ? (this.mods().cbBonus || 0) : 0), rnd);
      if (us) this.note(hits.length ? `Counter-battery fire on ${name}: ${hits.map(h => `${h.name} ${h.down ? 'destroyed' : 'damaged'}`).join(', ')}.` : `Counter-battery fire on ${name}: no confirmed hits.`, hits.length ? 'good' : '');
      else if (hits.length) this.note(`Enemy counter-battery fire on ${name}: ${hits.map(h => `${h.name} ${h.down ? 'destroyed — rebuilt in ' + F.REBUILD + ' weeks' : 'damaged'}`).join(', ')}.`, 'bad');
    }
    return r;
  }
  // enemy fire on a square the brigade holds: casualties in the task forces there
  harm(cellId, n, rnd = RND) {
    const tfs = this.forcesAt(cellId);
    // a spotted mass (recon.js) is a better target: one more round of losses
    for (let i = 0; i < Math.ceil(n) + 1; i++) for (const tf of tfs) { if (i >= Math.ceil(n) && !UAVR.spotted(this, 'player', tf)) continue;
      const us = this.tfUnits(tf).filter(u => this.alive(u)); if (!us.length) continue;
      const u = us[Math.floor(rnd() * us.length)];
      if (u.veh && !u.veh.lost && rnd() < 0.5) { u.veh.hp = Math.max(0.15, u.veh.hp - rnd() * 0.2 - 0.1); this.note(`${tf.name}: ${u.name} damaged by enemy ${rnd() < (this.def.enemy?.fpvThreat ?? 0.5) ? 'drones' : 'artillery'}.`, 'bad'); }
      else if (u.men > 1) { const w = 1 + (rnd() < 0.3 ? 1 : 0); u.men -= w; u.wounded += w; u.woundedT = 2; this.note(`${tf.name}: ${w} wounded by enemy shelling at ${this.cellName(cellId)}.`, 'bad'); }
    }
    if (!tfs.length && rnd() < 0.3) this.note(`Enemy shelling on ${this.cellName(cellId)}.`, 'bad');
  }
  // suppression on a square: { by: 'player'|'enemy', n, mul } (mul = defence multiplier) or null
  suppression(cellId) { const s = this.suppressed[cellId]; return s ? { ...s, mul: F.suppressMul(this, cellId, s.by) } : null; }
  clearFx(by) { for (const k of Object.keys(this.suppressed)) if (this.suppressed[k].by === by) delete this.suppressed[k]; for (const k of Object.keys(this.interdicted)) if (this.interdicted[k].by === by) delete this.interdicted[k]; }
  // weekly shell allocation (content start.ammo / enemy.ammo: [{ date, a }]) x throughput of the side's hubs
  ammoIncome(side = 'player') {
    const tbl = side === 'player' ? this.def.start.ammo : this.def.enemy?.ammo, a = atDate(tbl, this.date, 'a') ?? 3;
    const hubs = this.def.aor.hubs ? (this.def.aor.hubs || []).filter(h => (h.side || 'player') === side) : [];
    const cap = hubs.length ? this.hubs(side).filter(h => !h.built).reduce((s, h) => s + h.cap, 0) / hubs.length : 1;
    return Math.round(a * (0.4 + 0.6 * Math.min(1, cap)) * 10) / 10 + (side === 'player' ? (this.mods().ammoAlloc || 0) : 0);
  }
  ammoMax(side = 'player') { return (side === 'player' ? (this.def.start.ammoMax ?? 12) + (this.mods().ammoMax || 0) : (this.def.enemy?.ammoMax ?? 14)); }
  // how much of the enemy's artillery can reach a square (battle setup: scales the enemy's fire support)
  enemyArtyFactor(cellId) {
    const n = this.batteries('enemy').filter(b => !b.down && b.hp > 0 && F.inRange(this, b, cellId) && (this.esupplied?.[b.cell] ?? 0) >= 0.5).length;
    if (!this.batteries('enemy').length) return 1;
    return Math.min(1.25, 0.35 + 0.3 * n) * ((this.ammo?.enemy ?? 1) >= 1 ? 1 : 0.5);
  }
  // ------------------------------------------------------------------ UAV reconnaissance (recon.js)
  uavStatus(side = 'player') { const U = this.uav?.[side] || {}; return { sorties: UAVR.sorties(this, side), used: U.used || 0, stock: U.stock || 0, max: U.max || UAVR.UAV_MAX, lost: U.lost || 0, types: UAVR.UAV, log: U.log || [] }; }
  uavCheck(type, cellId) { return UAVR.flyCheck(this, 'player', type, cellId); }
  uavRisk(type, cellId) { return Math.round((UAVR.ewRisk(this, 'player', cellId) + (UAVR.UAV[type]?.loss || 0)) * 100) / 100; }
  uavRadius(type) { return UAVR.radius(this, 'player', type); }
  // fly a sortie: error string, or { ok, lost, cells:[observed squares], risk, type, cell }
  flyUav(type, cellId) {
    const r = UAVR.fly(this, 'player', type, cellId, RND); if (!r.ok) return r.why;
    for (const id of r.cells) if (this.owner[id] !== 'player') this.observe(id);
    const seen = r.cells.reduce((a, id) => a + AI.forcesAt(this, id).length, 0), bats = r.cells.reduce((a, id) => a + this.batteries('enemy').filter(b => b.cell === id && !b.down).length, 0);
    const lbl = (this.side === 'RU' ? UAVR.UAV[type].ru : UAVR.UAV[type].label) || type;
    this.note(`${lbl} over ${this.cellName(cellId)}: ${r.cells.length ? `${r.cells.length} square${r.cells.length > 1 ? 's' : ''} observed${this.def.versus ? '' : `, ${seen} enemy task force${seen === 1 ? '' : 's'}${bats ? `, ${bats} batter${bats > 1 ? 'ies' : 'y'}` : ''} found`}` : 'no pictures'}${r.lost ? ' — the drone was lost to enemy EW / air defence.' : '.'}`, r.lost ? 'bad' : '');
    this.uavLog.push({ turn: this.turn, ...r }); if (this.uavLog.length > 30) this.uavLog.shift();
    this.refreshPresence(); this.save(); return r;
  }
  // ------------------------------------------------------------------ the operation goal (content def.goal)
  // { title, text, by, cells:[{cell, pts, name}], total, held, pct (0..1), achieved (date or null), weeksLeft }
  // versus: the operation's goal (def.vsGoal) from this side's point of view — the attacker takes the squares, the
  // defender holds them (vs: 'attack' | 'defend'); in versus they count double in the final score (versus.js score)
  goalProgress() {
    const vs = !this.def.goal && this.def.versus && this.def.vsGoal ? (this.def.vsOp === this.def.id ? 'attack' : 'defend') : null;
    const G = this.def.goal || (vs ? this.def.vsGoal : null); if (!G) return null;
    const cells = G.cells.map(g => ({ ...g, name: g.name || this.cellName(g.cell), held: this.owner[g.cell] === 'player' }));
    const total = cells.reduce((a, g) => a + g.pts, 0), held = cells.filter(g => g.held).reduce((a, g) => a + g.pts, 0);
    const by = G.by || this.def.start.end;
    return { title: vs === 'defend' ? `Hold: ${G.title.replace(/^(Take|Seize|Capture) /i, '')}` : G.title, text: vs === 'defend' ? `The enemy brigade's objective: ${G.text || G.title} Every objective square you still hold at the end counts double in the final score.` : G.text, vs,
      by, cells, total, held, pct: total ? held / total : 0, partial: G.partial ?? 0.5, win: G.win ?? 1, achieved: vs ? null : this.goalDone || null, weeksLeft: Math.max(0, Math.ceil((parseDate(by) - parseDate(this.date)) / DAY / (this.def.start.turnDays || 7))) };
  }
  // ------------------------------------------------------------------ logistics
  supplyRange() { return SUP.HUB_RANGE.base + (this.mods().supplyRange || 0); }
  // supply networks of both sides (supply.js): sources -> linked hubs -> squares; the other side's interdiction fire
  // this week slows routes through the squares it hits. this.supplied / this.esupplied: { cell: 1 | 0.5 | 0 }
  computeSupply() {
    const by = s => { const o = {}; for (const [k, v] of Object.entries(this.interdicted || {})) if (v.by === s) o[k] = this.turn; return o; };
    const net = SUP.computeNetwork(this, 'player', by('enemy'), this.mods().supplyRange || 0);
    const enet = SUP.computeNetwork(this, 'enemy', by('player'), 0);
    this.supplyNet = { player: net, enemy: enet };
    this.supplied = {}; this.supplyDist = {};
    for (const c of this.def.aor.cells) { this.supplied[c.id] = this.owner[c.id] === 'player' ? (net.level[c.id] ?? 0) : 0; if (net.dist[c.id] != null) this.supplyDist[c.id] = net.dist[c.id]; }
    this.esupplied = {}; for (const c of this.def.aor.cells) if (this.owner[c.id] === 'enemy') this.esupplied[c.id] = enet.level[c.id] ?? 0;
    for (const f of this.forces) f.supply = this.supplied[f.cell] ?? 0;
    for (const f of this.eforces || []) f.supply = this.esupplied[f.cell] ?? 0;
    this.updateOpen(); this.refreshPresence();
    return this.supplied;
  }
  // ---- supply API for the UI: the route that feeds a square (hub ... square), the hubs, chokepoints
  supplyRoute(cellId, side = 'player') { return SUP.supplyRoute(this.supplyNet[side], cellId); }
  hubs(side = 'player') { return this.supplyNet?.[side]?.hubs || []; }
  allHubs() { return (this.def.aor.hubs || []).map(h => ({ ...h, holder: this.owner[h.cell], working: [...this.hubs('player'), ...this.hubs('enemy')].some(x => x.cell === h.cell && x.cap > 0) })); }
  chokepoints(side = 'player', n = 4) { return SUP.chokepoints(this, this.supplyNet[side], n); }
  // ------------------------------------------------------------------ the area of responsibility grows with the front
  // A square is OPEN (playable, shown) when it was in the starting AOR (aor.reveal squares from the own line, default 3)
  // or comes within that distance of an own square later, or is an operation-goal square. Squares stay open once opened.
  // this.justOpened lists the squares opened by the last change (the UI fades them in).
  updateOpen() {
    const A = this.def.aor, D = A.reveal ?? 3, own = A.cells.filter(c => this.owner[c.id] === 'player'), fresh = [];
    if (D >= 99) return;
    for (const c of A.cells) {
      if (this.opened[c.id] != null) continue;
      const goal = (this.def.goal?.cells || []).some(g => g.cell === c.id);
      if (goal || own.some(o => Math.max(Math.abs(o.col - c.col), Math.abs(o.row - c.row)) <= D)) { this.opened[c.id] = this.turn; if (this.openInit) fresh.push(c.id); }
    }
    this.openInit = true;
    if (fresh.length) { this.justOpened = fresh; this.note(`The brigade's area of responsibility extends: ${fresh.length} new grid square${fresh.length > 1 ? 's' : ''} on the map.`); }
  }
  isOpen(id) { return (this.def.aor.reveal ?? 3) >= 99 || this.opened?.[id] != null; }
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
    for (const id of this.unlocked) { const t = this.techItem(id); if (t?.kit && t.vk) ((m.kits ||= {})[t.vk] ||= []).push(t.kit);   // vehicle kits (tech.js KITS) -> battle (campaignBattle.js)
      if (!t?.mods) continue; for (const [k, v] of Object.entries(t.mods)) { if (!(k in MODS) && !CAMPAIGN_MODS.includes(k)) continue; m[k] = typeof v === 'boolean' ? (m[k] || v) : (m[k] || 0) + v; } }
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
    // a new arrival waits at the HQ in its own task force, named after it (it used to be a second 'Brigade reserve' next to
    // the brigade's own reserve with other units in it, so a bought team showed up under a name like 'UAV strike platoon');
    // a second delivery to the same group turns it into a numbered reserve group (never the name of another task force)
    let tf = this.forces.find(f => f.cell === cell && f.reserve);
    if (!tf) { tf = { id: this.newId('tf'), name: this.freeTfName(rec.name), autoName: true, cell, units: [], mp: 0, stance: 'rest', attacked: false, reserve: true, supply: this.supplied?.[cell] ?? 1 }; this.forces.push(tf); }
    else if (tf.autoName && tf.units.length) { tf.autoName = false; tf.name = this.freeTfName(this.side === 'RU' ? 'Reserve group' : 'Brigade reserve', tf); }
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
      if (is.when) { const [k, sid] = is.when.split(':'); ok = (k === 'captured' && this.owner[sid] === 'player') || (k === 'lost' && this.owner[sid] !== 'player' && this.cell(sid)?.owner === 'player') || (k === 'grown' && (this.grown || []).includes(sid)); }
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
      if (r.battery) this.addBattery(r.battery);
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
    const es = this.suppressed[cellId]; if (es && es.by === 'enemy' && this.owner[cellId] === 'player') m.morale = (m.morale || 0) - 0.08 * es.n;
    if (tf && (tf.supply ?? 1) < 0.5) { m.morale = (m.morale || 0) - 0.3; m.atgmAmmo = (m.atgmAmmo || 0) - 1; m.artyAmmo = (m.artyAmmo || 0) - 0.4; m.fpvDrones = (m.fpvDrones || 0) - 1; m.outOfSupply = true; }
    return m;
  }
  // the enemy's strength in a square: line troops + task forces, weakened when cut off from its supply
  // (v7, enemy task-force campaigns: the companies in the square + the covering battalion, ai.js defPower; supply is in it)
  defenderStrength(cellId) { return AI.aiCampaign(this) ? AI.defPower(this, cellId) / AI.EF_POWER : AI.strengthAt(this, cellId) * (0.7 + 0.3 * (this.esupplied?.[cellId] ?? 1)); }
  // v7: the enemy order of battle in a fight, from the forces involved: [{ kind, obj }] for the RTS battle (campaignBattle.js
  // campaignArmy / campaignDefenders), the forces' summary and their veterancy. attack: the companies holding the square
  // (+ one company of the covering battalion); defend: the companies of the attacking battalion groups
  enemyOrbat(cellId, mode, attack = null) {
    const E = this.def.enemy || {};
    const fs = mode === 'attack' ? AI.forcesAt(this, cellId) : (attack?.tfs || [attack?.tf]).map(id => (this.eforces || []).find(f => f.id === id)).filter(Boolean);
    const cov = mode === 'attack' ? AI.coverOf(this, cellId) : null;
    const coys = []; let n = 0;
    for (const f of fs.slice().sort((a, b) => AI.fpow(this, b) - AI.fpow(this, a))) for (const c of f.coys.slice().sort((a, b) => b.s - a.s)) { if (n >= FRONTAGE) break; coys.push({ ...c, f }); n++; }
    if (cov && n < FRONTAGE) { const c = cov.f.coys.slice().sort((a, b) => b.s - a.s)[0]; if (c) coys.push({ ...c, s: c.s * 0.7, f: cov.f, support: true }); }
    const out = [], objs = ['A', 'B'];
    const add = (kind, i) => out.push({ kind, obj: objs[out.length % 2] });
    for (const [i, c] of coys.entries()) {
      const full = c.s >= 0.6;
      if (mode === 'attack') {
        if (c.k === 'tank') add('tank'); else if (c.k === 'atgm') add('atgm'); else if (c.k === 'assault') add('assault');
        else { add('defend'); if (full && !c.support) add(c.k === 'vdv' ? 'imech' : c.k === 'inf' ? 'foot' : 'mech'); }
      } else {
        add(c.k === 'tank' ? 'tank' : c.k === 'vdv' ? 'imech' : c.k === 'inf' ? 'foot' : c.k === 'atgm' ? 'atgm' : c.k === 'assault' ? 'assault' : 'mech');
        if (full && c.k === 'mech' && i < 2) add('foot');
      }
    }
    if (!coys.length) { add('defend'); add('foot'); }                    // rear security: an empty but covered square
    if (fs.length && (E.fpvThreat ?? 0.5) >= 0.4) add('fpv');
    if (this.enemyArtyFactor(cellId) >= 0.6 && coys.length >= 3) out.push({ kind: 'spg' });
    const xp = fs.length ? fs.reduce((a, f) => a + (f.xp || 0) * AI.ncoys(f), 0) / Math.max(1, fs.reduce((a, f) => a + AI.ncoys(f), 0)) : 0;
    return { enemy: out.slice(0, 13), coys: coys.length, vet: xpLevel(xp), forces: [...fs, ...(cov ? [cov.f] : [])].map(f => ({ id: f.id, name: f.name, coys: (f.coys || []).map(c => c.k), str: Math.round(f.str * 100) / 100, xp: XP_NAMES[xpLevel(f.xp || 0)], role: f === cov?.f ? 'support' : f.role || 'line' })) };
  }
  // a battle the player fights: RTS map, mode, the task force's units, the enemy composition (campaignBattle.js contract)
  battleSetup(cellId, uids, mode = 'attack', from = null) {
    const c = this.cell(cellId), E = this.def.enemy || {};
    const prep = mode === 'attack' && this.suppressed[cellId]?.by === 'player' ? this.suppressed[cellId].n : 0;
    const strength = clamp(Math.round(mode === 'attack' ? Math.max(1, this.defenderStrength(cellId) * F.suppressMul(this, cellId, 'player')) : (from?.strength || 1)), 1, 3);
    const T = E.forceTemplates || {}; let tpl = T[strength] || T[String(strength)] || [{ kind: 'mech' }, { kind: 'foot' }, { kind: 'tank' }];
    // v7: the companies of the enemy forces actually involved (attack: the square's holders; defend: the attackers)
    const ob = AI.aiCampaign(this) ? this.enemyOrbat(cellId, mode, from) : null; if (ob) tpl = ob.enemy;
    const urban = ['urban', 'industrial'].includes(c.terrain) || (c.settlement && ['town', 'industrial'].includes(c.settlement.kind));
    const force = this.battleUnits(uids);
    return {
      v2: true, sector: cellId, sectorName: this.cellName(cellId), map: c.battleMap || (urban ? 'city' : 'farmland'), mapFallback: urban ? 'city' : 'farmland', mode,
      fort: this.fort[cellId] || 0, strength, force: JSON.parse(JSON.stringify(force)), enemy: tpl.map(e => ({ ...e })), mods: { ...this.battleMods(cellId, uids), mortar: (this.battleMods(cellId, uids).mortar || 0) + Math.round(prep) }, side: this.side,
      fpvThreat: E.fpvThreat ?? 0.5, artillery: Math.round((E.artillery ?? 0.5) * this.enemyArtyFactor(cellId) * 100) / 100, turn: this.turn, date: this.date,
      fires: { prep, enemyArty: this.enemyArtyFactor(cellId), enemyForces: ob ? ob.forces.map(f => f.name) : AI.forcesAt(this, cellId).map(f => f.name) },
      ...(ob ? { enemyForces: ob.forces, enemyVet: ob.vet, enemyCoys: ob.coys } : {}),
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
        AI.pushOut(this, cellId, RND);
        const hub = (this.def.aor.hubs || []).find(h => h.cell === cellId);
        if (hub && (hub.side || 'player') === 'enemy') { lp += 15; this.note(`Enemy logistics hub captured: ${hub.name}. Everything it fed is short of ammunition and fuel.`, 'good'); }
        this.owner[cellId] = 'player'; this.garrison[cellId] = 0; this.fort[cellId] = Math.max(0, (this.fort[cellId] || 0) - 1); this.stats.cellsTaken++; (this.elost ||= {})[cellId] = this.turn;
        if (tf) tf.cell = cellId; this.recon[cellId] = this.turn; this.markRecon(cellId);
        this.note(`${name} taken${tf ? ` by ${tf.name}` : ''}.`, 'good');
        const off = this.pendingAttacks.filter(a => a.from === cellId || a.to === cellId);
        if (off.length) { this.pendingAttacks = this.pendingAttacks.filter(a => !off.includes(a)); this.note(`The enemy attack being prepared from ${name} has been broken up.`, 'good'); }
      } else {
        const hit = (r.enemyKia || 0) / 14 + (r.enemyVehLost || 0) * 0.15, nf = AI.forcesAt(this, cellId).length;
        let g;
        if (AI.aiCampaign(this)) { if (nf) AI.attrit(this, cellId, hit * 0.8); else { const cv = AI.coverOf(this, cellId); if (cv) AI.attrit(this, cv.f.cell, hit * 0.4, [cv.f]); } g = AI.defPower(this, cellId) / AI.EF_POWER; }
        else { g = Math.max(0.3, (this.garrison[cellId] || 1) - hit / (1 + nf)); this.garrison[cellId] = g; if (nf) AI.attrit(this, cellId, hit / (1 + nf)); }
        if (g < 0.8 && (r.objectivesHeld || 0) > 0) { this.owner[cellId] = 'contested'; this.note(`Attack on ${name} failed, but the enemy line there is broken: the cell is contested.`, 'bad'); }
        else this.note(`Attack on ${name} failed.`, 'bad');
        this.recon[cellId] = this.turn;
      }
    } else {
      const a = this.pendingAttacks.find(x => x.id === B.attack) || this.pendingAttacks.find(x => x.to === cellId);
      const etf = a?.tf ? (this.eforces || []).find(f => f.id === a.tf) : null;
      // v7: every battalion group of the attack shares the losses; the lead occupies a won square, the others stay
      const etfs = (a?.tfs || (a?.tf ? [a.tf] : [])).map(id => (this.eforces || []).find(f => f.id === id)).filter(Boolean);
      if (r.win) { this.stats.won++; lp += 8; if (etfs.length) { AI.attrit(this, a.from, (0.25 + RND() * 0.2) * Math.min(2, etfs.length), etfs); if (etf && !this.eforces.includes(etf)) this.note(`Enemy ${etf.name} was destroyed in the failed attack.`, 'good'); } else if (a && this.garrison[a.from] != null) this.garrison[a.from] = Math.max(0.3, this.garrison[a.from] - 0.6); this.note(`Enemy attack on ${name} repulsed.`, 'good'); }
      else { this.loseCell(cellId, a?.strength || 1, !!etf); if (etfs.length) AI.attrit(this, cellId, 0.2, etfs); if (etf && this.eforces.includes(etf)) { etf.cell = cellId; etf.movedT = this.turn; } }
      this.pendingAttacks = this.pendingAttacks.filter(x => x !== a);
    }
    if (B.mode === 'defend' && !r.win) lp *= 0.4;                 // a lost position earns little
    if (r.lineOnly) lp = r.win ? 3 : 0;                             // held by the line battalions, not by a task force
    if (r.withdrawn) lp = 0;
    lp = Math.round(lp * lpMul * (r.auto ? 0.7 : 1)); this.lp += lp; if (lp) this.note(`Battle report: +${lp} LP.`);
    this.battle = null; this.battleFought = true;
    if (B.mode === 'attack' && r.win) this.checkGrowth();
    this.computeSupply();
    this.checkDirectives({ cell: cellId, from: B.from, mode: B.mode, vehKills: r.enemyVehLost || 0 });
    this.issueDirectives(); this.save();
    return r;
  }
  loseCell(cellId, strength = 1, byForce = false) {
    const name = this.cellName(cellId);
    this.owner[cellId] = 'enemy'; this.garrison[cellId] = AI.aiCampaign(this) ? 0 : clamp(strength * (byForce ? 0.35 : 0.6), 0.5, 3); this.stats.cellsLost++;
    const hub = (this.def.aor.hubs || []).find(h => h.cell === cellId); if (hub) this.note(`Logistics hub lost: ${hub.name}.`, 'bad');
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
    const pa = this.pendingAttacks.find(a => a.id === B.attack);
    if (enemyStrength == null || (B.mode === 'defend' && pa?.power != null)) enemyStrength = B.mode === 'attack' ? Math.max(0.5, this.defenderStrength(cellId)) : (pa?.power != null ? pa.power / 2.1 : (pa?.strength || 1));
    const sp = this.suppressed[cellId];
    if (B.mode === 'attack') enemyStrength *= F.suppressMul(this, cellId, 'player');
    const units = this.battleUnits(uids).slice(0, FRONTAGE), tf = units.length ? this.tfOf(units[0].uid) : null, wsh = woundedShare(this.mods());
    const supply = tf ? (tf.supply ?? 1) : 1, fort = this.fort[cellId] || 0;
    const c = this.cell(cellId), urban = ['urban', 'industrial'].includes(c?.terrain) ? 1 : c?.terrain === 'village' || c?.terrain === 'forest' ? 0.5 : 0;
    let power = units.reduce((a, u) => a + this.unitPower(u), 0) * (0.6 + 0.4 * supply) + (B.mode === 'defend' ? 1.2 + fort * 0.6 + urban : 0);
    if (B.mode === 'defend') power *= F.suppressMul(this, cellId, 'enemy');
    // fortified towns / works: a fortress; (v7) an unoccupied fortified square keeps only its mines and obstacles
    const held = !AI.aiCampaign(this) || AI.forcesAt(this, cellId).length > 0;
    const enemy = enemyStrength * 2.1 + (B.mode === 'attack' ? (fort * (urban >= 1 ? 1.0 : 0.6) + urban * 0.8) * (held ? 1 : 0.5) : 0);
    // a cell without a task force is still held by the brigade's line battalions / territorial units
    // (v7) at full strength only where a task force covers the square (in it or next to it); rear squares are thinly held
    const lineOnly = B.mode === 'defend' && !units.length, cov = this.neighbors(cellId).some(n => this.forcesAt(n).length) || this.forcesAt(cellId).length > 0;
    const line = lineOnly ? (cov || !AI.aiCampaign(this) ? 2.0 : 1.3) * F.suppressMul(this, cellId, 'enemy') : 0;
    const win = (power + line) * rnd(0.75, 1.25) > enemy * rnd(0.75, 1.25);
    const r = { sector: cellId, mode: B.mode, win, auto: true, lineOnly, enemyKia: Math.round(rnd(2, 6) * enemyStrength), enemyVehLost: (RND() < 0.3 * enemyStrength ? 1 : 0) + (win && RND() < 0.12 * enemyStrength ? 1 : 0), objectivesHeld: win ? 2 : (RND() < 0.4 ? 1 : 0),
      units: units.map(u => { const cas = Math.round(u.men * rnd(0.04, win ? 0.22 : 0.4)); const w = Math.round(cas * wsh); return { uid: u.uid, alive: Math.max(0, u.men - cas), wounded: Math.min(cas, w), kills: Math.round(rnd(0, 3)), vehLost: !!(u.veh && !u.veh.lost && RND() < (win ? 0.08 : 0.25)), vehHp: u.veh ? (u.veh.lost ? 0 : clamp(u.veh.hp - rnd(0, 0.4), 0.1, 1)) : 1 }; }) };
    // casualties stay casualties: alive + wounded never exceed men
    for (const ur of r.units) { const u = this.unit(ur.uid); ur.wounded = Math.min(ur.wounded, Math.max(0, u.men - ur.alive)); }
    return this.applyResult(r);
  }
  // ------------------------------------------------------------------ enemy on the grid
  enemyPhase() {
    const E = this.def.enemy || {}, date = this.date;
    const p = atDate(E.pressure, date, 'p') ?? 0.15, r = atDate(E.reinforce, date, 'r') ?? 0.08;
    const cells = this.def.aor.cells, hasAI = !!E.forces;
    // the enemy's week starts like ours: shells, drones, rebuilt guns, task force upkeep and reinforcements
    if (hasAI) {
      this.ammo.enemy = Math.min(this.ammoMax('enemy'), (this.ammo.enemy || 0) + this.ammoIncome('enemy'));
      F.weekly(this, 'enemy'); UAVR.weekly(this, 'enemy', true); AI.upkeep(this);
    }
    // reinforce and dig in: front garrisons move towards a level set by the date's pressure, the rear stays thin
    const L = atDate(E.line, date, 'l') ?? ((hasAI ? 1.0 : 1.2) + p * (hasAI ? 3.5 : 5));   // content enemy.line: the front garrison level
    // (v7: in task-force campaigns there is no line garrison: squares are held by the battalions, ai.js)
    for (const c of hasAI ? [] : cells) {
      if (this.owner[c.id] !== 'enemy') continue;
      const front = this.neighbors(c.id).some(n => this.owner[n] !== 'enemy');
      let g = this.garrison[c.id] || 0;
      // enemy logistics: a square cut off from every enemy hub / source withers; a strained one recovers slowly;
      // a deep salient (mostly surrounded) is hard to reinforce
      const sup = this.esupplied?.[c.id] ?? 1;
      if (sup <= 0) { g = Math.max(0.5, g - rnd(0.15, 0.3)); if ((this.fort[c.id] || 0) > 0 && RND() < 0.2) this.fort[c.id]--; this.garrison[c.id] = g; continue; }
      const salient = this.neighbors(c.id).filter(n => this.owner[n] === 'player').length >= 5;
      // fortified towns and strongpoints are kept manned at their starting strength while their supply runs
      const tgt = Math.max(((front ? L : 1.0) + (c.vp || 0) * 0.15) * (salient ? 0.8 : 1) * (sup < 1 ? 0.8 : 1), (c.fort || 0) >= 3 && front ? (c.garrison || 1) * (sup >= 1 ? 0.95 : 0.6) : 0);
      g += (tgt - g) * clamp(r * 3 * sup, 0.03, 0.6) + rnd(-0.15, 0.15);
      if (front && g < 0.8) g = 0.8 + RND() * 0.3;
      this.garrison[c.id] = clamp(g, 0.3, 3);
      if (front && !salient && sup >= 1 && (this.fort[c.id] || 0) < 3 && RND() < r * 0.6) this.fort[c.id] = (this.fort[c.id] || 0) + 1;
    }
    // the brigade's line battalions dig in on quiet own front cells
    for (const c of cells) if (this.owner[c.id] === 'player' && (this.fort[c.id] || 0) < 1 && this.neighbors(c.id).some(n => this.owner[n] === 'enemy') && RND() < 0.12) this.fort[c.id] = 1;
    // contested cells drift back to the enemy unless own forces sit next to them
    for (const c of cells) if (this.owner[c.id] === 'contested' && !this.forces.some(f => this.adjacent(f.cell, c.id)) && (!hasAI || AI.covered(this, c.id)) && RND() < 0.4) { this.owner[c.id] = 'enemy'; if (!hasAI) this.garrison[c.id] = Math.max(this.garrison[c.id] || 0, 0.8); this.note(`${this.cellName(c.id)}: the enemy has reoccupied the contested positions.`, 'bad'); }
    this.pendingAttacks = [];
    // big player formations give themselves away (recon.js): the enemy knows where they are this week
    this.espots = { turn: this.turn, list: UAVR.spottedList(this, 'player') };
    for (const s of this.espots.list) (this.eintel ||= {})[s.cell] = this.turn;
    if (hasAI) {
      // the enemy commander (ai.js): recon, threat assessment, reserves, concentration, fires
      const res = AI.enemyAI(this, RND, p); this.aiLog = res.log;
      for (const k of res.announced) {
        if (this.owner[k.to] === 'contested') { this.owner[k.to] = 'enemy'; k.tf.cell = k.to; this.note(`The enemy has retaken ${this.cellName(k.to)}.`, 'bad'); continue; }
        const strength = k.coys <= 2 ? 1 : k.coys <= 4 ? 2 : 3, names = k.tfs.map(f => f.name);
        this.pendingAttacks.push({ id: this.newId('ea'), from: k.from, to: k.to, strength, power: Math.round(k.power * 100) / 100, coys: k.coys, tf: k.tf.id, tfs: k.tfs.map(f => f.id), tfName: names.join(' + '), counter: !!k.counter });
        this.stats.eAttacks = (this.stats.eAttacks || 0) + 1;
        this.note(`Intelligence: ${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} preparing to ${k.counter ? 'counterattack' : 'attack'} ${this.cellName(k.to)} from ${this.cellName(k.from)} (${k.coys} compan${k.coys === 1 ? 'y' : 'ies'}).`, 'bad');
      }
      this.reportEnemyMoves();
      return;
    }
    // legacy (test campaigns without enemy task forces): harassment and counterattacks from strong garrisons
    const art = E.artillery ?? 0.5;
    for (const tf of this.forces) { if (!this.neighbors(tf.cell).some(n => this.owner[n] === 'enemy') || RND() > art * 0.3) continue; this.harm(tf.cell, 1); }
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
  // ------------------------------------------------------------------ v7: what the brigade sees of the enemy brigade
  // the enemy's moves this week that the brigade observed (either end under observation / in contact, or the force
  // spotted): one log line per kind of move; the list stays in C.enemyMoves (UI: arrows for entries with seen)
  reportEnemyMoves() {
    const M = this.enemyMoves; if (!M || M.turn !== this.turn) return [];
    const spotted = new Set(UAVR.spottedList(this, 'enemy').map(x => x.id));
    for (const m of M.list) m.seen = m.seen || spotted.has(m.id);
    const seen = M.list.filter(m => m.seen && m.kind !== 'rejoin');
    const verb = { attack: 'moves up to attack', counterattack: 'moves up to counterattack', reinforce: 'reinforces', relieve: 'relieves the line at', rotate: 'is pulled back to', reserve: 'moves into reserve at', outpost: 'pushes an outpost into', 'close the gap': 'moves into the line at', hub: 'moves to cover', 'second line': 'takes up positions at' };
    for (const m of seen.slice(0, 6)) this.note(`Enemy movement observed: ${m.name} ${verb[m.kind] || 'moves to'} ${this.cellName(m.to)} (from ${this.cellName(m.from)}).`, 'enemy');
    if (seen.length > 6) this.note(`Enemy movement observed: ${seen.length - 6} more column${seen.length - 6 > 1 ? 's' : ''} on the move.`, 'enemy');
    // the staff's picture of the enemy brigade this week (only what is observed or spotted)
    const vis = this.visibleEnemy(), sp = this.spottedEnemy(), bns = vis.filter(f => f.role !== 'screen'), outp = vis.filter(f => f.role === 'screen');
    if (vis.length || sp.length) this.note(`Intelligence picture: ${bns.length + sp.length} enemy battalion group${bns.length + sp.length === 1 ? '' : 's'} identified (${[...bns, ...sp].reduce((a, f) => a + (f.n || 0), 0)} companies)${outp.length ? `, ${outp.length} outpost${outp.length > 1 ? 's' : ''}` : ''}${sp.length ? `; on the move and spotted: ${sp.map(f => f.name).join(', ')}` : ''}. The rest of his brigade is out of sight — reconnoitre.`, 'enemy');
    return seen;
  }
  // enemy task forces the brigade sees right now (contact, drones this / last week, spotted) — the versus `foes` format,
  // so the map draws them as hostile task-force tokens: [{ id, cell, name, n, units, power, spotted, role, str, xp }]
  visibleEnemy() {
    if (!AI.aiCampaign(this)) return [];
    const key = `${this.turn}|${this.logSeq}|${this.forces.map(f => f.cell).join()}|${(this.eforces || []).map(f => f.cell + f.str).join()}|${Object.keys(this.recon).length}`;
    const K = VIS.get(this); if (K && K.key === key) return K.out;
    const sp = new Set(this.spottedEnemy().map(x => x.id)), out = [];
    for (const f of this.eforces || []) {
      if (!this.fresh(f.cell) || sp.has(f.id)) continue;      // spotted formations have their own token (map3d spottedEnemy)
      const contactOnly = (this.recon[f.cell] ?? -9) < this.turn - 1;
      out.push({ id: f.id, cell: f.cell, name: f.name, n: AI.ncoys(f), role: f.role || 'line', spotted: false, str: Math.round(f.str * 10) / 10, xp: contactOnly ? null : XP_NAMES[xpLevel(f.xp || 0)],
        units: (f.coys || []).map(c => ({ kind: c.k === 'vdv' ? 'imech' : c.k === 'inf' ? 'assault' : c.k, veh: c.k === 'tank' ? { kind: 'tank' } : c.k === 'mech' ? { kind: 'btr' } : c.k === 'vdv' ? { kind: 'ifv' } : null })),
        power: Math.round(AI.fpow(this, f) * 2) / 2 });
    }
    VIS.set(this, { key, out }); return out;
  }
  get foes() { return this.def?.versus ? this._foes : (AI.aiCampaign(this) ? this.visibleEnemy() : undefined); }
  set foes(v) { this._foes = v; }
  // the brigade's picture of an enemy-held square: { known, fresh, forces:[ids], screen, empty, covered, def } (null for own)
  enemyPresence(cellId) { return this.def.versus ? this.vsPresence(cellId) : AI.aiCampaign(this) ? AI.presence(this, cellId) : null; }
  // versus: is a square of the other player held (versus.js holds: 't' task force, 'g' guns, 'h' HQ, 'l' starting line)?
  vsHeld(cellId) { return this.owner[cellId] !== 'player' && !!this.vsCover?.[cellId]; }
  // versus: the same picture as enemyPresence gives in single player, from the host's C.vsCover / C.vsSeen and the
  // other player's task forces this side sees (C.foes)
  vsPresence(cellId) {
    if (this.owner[cellId] === 'player') return null;
    const fresh = this.fresh(cellId), seen = this.vsSeen?.[cellId], ids = (this._foes || []).filter(f => f.cell === cellId).map(f => f.id);
    if (fresh) { const why = this.vsCover?.[cellId] || null; return { known: true, fresh: true, forces: ids, screen: false, empty: !ids.length && !why, covered: !!why, why, def: null }; }
    if (!seen) return { known: false, fresh: false, forces: ids, screen: false, empty: false, covered: null, why: null, def: null };
    return { known: true, fresh: false, forces: ids, screen: false, empty: !ids.length && !seen.held && !seen.n, covered: !!seen.held, why: seen.held, def: null, age: this.turn - seen.turn };
  }
  // C.garrison in task-force campaigns = the brigade's PICTURE of the enemy strength in each square (map badges, old
  // UI): live where observed / in contact, else the last intel; the rules use ai.js defPower
  refreshPresence() {
    if (!AI.aiCampaign(this)) return;
    for (const c of this.def.aor.cells) { if (this.owner[c.id] === 'player') { this.garrison[c.id] = 0; continue; } const P = AI.presence(this, c.id); this.garrison[c.id] = P?.def != null ? Math.round(P.def / AI.EF_POWER * 10) / 10 : (P?.known ? 0 : 1); }
  }
  // enemy-held squares still connected to the enemy's rear edge (through enemy / contested squares)
  enemyLinked() {
    const A = this.def.aor, rear = c => GR.onEdge(A, A.enemyEdge || 'south', c);
    const seen = new Set(A.cells.filter(c => rear(c) && this.owner[c.id] !== 'player').map(c => c.id)), q = [...seen];
    while (q.length) { const cur = q.pop(); for (const n of this.neighbors(cur)) if (!seen.has(n) && this.owner[n] !== 'player') { seen.add(n); q.push(n); } }
    return seen;
  }
  // ------------------------------------------------------------------ end of turn
  endTurn() {
    if (this.outcome()) return;
    // enemy attacks announced last week that the player has not answered: resolved with whoever stands there
    for (const a of [...this.pendingAttacks]) {
      // (v7) the attack comes with the battalions still on the staging square, at their strength now
      if (a.tfs && AI.aiCampaign(this)) { const fs = a.tfs.map(id => this.eforces.find(f => f.id === id)).filter(f => f && f.cell === a.from); if (!fs.length) { this.note(`The enemy attack on ${this.cellName(a.to)} did not come: the assault group was broken up.`, 'good'); this.pendingAttacks = this.pendingAttacks.filter(x => x !== a); continue; } a.tfs = fs.map(f => f.id); a.power = Math.round(fs.reduce((t, f) => t + AI.fpow(this, f), 0) * 100) / 100; if (!a.tfs.includes(a.tf)) a.tf = a.tfs[0]; }
      this.battle = { mode: 'defend', cell: a.to, attack: a.id, from: a.from }; this.autoResolve(a.to, 'defend', a.strength);
    }
    this.pendingAttacks = [];
    this.clearFx('enemy');                                   // last week's enemy fire is over
    // the operation goal: all its squares held at the end of a week (after the enemy's attacks) = achieved
    const gp = this.def.versus ? null : this.goalProgress(); if (gp && gp.pct >= gp.win - 1e-9 && !this.goalDone) { this.goalDone = this.date; this.note(`Operation goal achieved: ${gp.title}.`, 'good'); this.save(); return; }
    // stances: dig in / rest
    for (const tf of this.forces) {
      const moved = tf.mp < this.tfMpMax(tf) - 1e-6 || tf.attacked;
      if (tf.stance === 'hold' && !moved && (this.fort[tf.cell] || 0) < 2 && RND() < 0.6) { this.fort[tf.cell] = (this.fort[tf.cell] || 0) + 1; this.note(`${tf.name} dug in at ${this.cellName(tf.cell)} (fortifications ${this.fort[tf.cell]}).`); }
      if (tf.stance === 'rest' && !moved && (tf.supply ?? 0) >= 1) for (const u of this.tfUnits(tf)) { if (u.veh && !u.veh.lost) u.veh.hp = Math.min(1, u.veh.hp + 0.1); if (u.woundedT > 0) u.woundedT--; }
      this.markRecon(tf.cell, this.reconRange(tf));
      if (moved) tf.movedT = this.turn; if (tf.attacked || tf.planned) tf.attackedT = this.turn;   // spotting (recon.js signature)
    }
    this.checkDirectives(null, true);
    this.turn++; this.battleFought = false;
    // deliveries from high command
    for (const o of this.orders) o.eta--;
    for (const o of this.orders.filter(o => o.eta <= 0)) {
      if (o.what === 'tech') { this.unlocked.push(o.key); const t = this.techItem(o.key); for (const k of t?.unlock || []) if (!this.available.includes(k)) this.available.push(k); if (t?.battery) this.addBattery(t.battery); this.note(`Delivered: ${t?.name}.`, 'good'); }
      else { const c = this.catalogItem(o.key); if (c?.kind === 'replacements') { const n = this.distributeReplacements(c.men || 8); this.note(`${c.men || 8} replacements arrived${n < (c.men || 8) ? ` (${(c.men || 8) - n} held at the brigade depot: no unit in supply needs them)` : ''}.`, 'good'); } else if (c) { this.deliverUnit(this.record({ key: c.key, kind: c.kind, men: c.men, veh: c.vehicle ? { kind: c.vehicle } : null, name: this.unitName(c) })); this.note(`Arrived at ${this.cellName(this.deliveryCell())}: ${c.label}.`, 'good'); } }
    }
    this.orders = this.orders.filter(o => o.eta > 0);
    this.computeSupply();
    // refits, wounded returning (in supply only), wear out of supply
    for (const tf of this.forces) {
      const sup = tf.supply ?? 0;
      for (const u of this.tfUnits(tf)) {
        if (u.status !== 'ready' && --u.eta <= 0) u.status = 'ready';
        if (u.wounded && sup >= 0.5 && --u.woundedT <= 0) { const back = Math.ceil(u.wounded * Math.min(0.9, 0.6 + (this.mods().medReturn || 0))); u.men = Math.min(u.menMax, u.men + back); u.wounded = 0; }
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
    // shells, guns, drones for the new week
    const ai = this.ammoIncome('player'); this.ammo.player = Math.min(this.ammoMax('player'), Math.round(((this.ammo.player || 0) + ai) * 10) / 10);
    F.weekly(this, 'player'); UAVR.weekly(this, 'player', (this.supplied[this.hq || this.def.start.hq] ?? 0) >= 0.5);
    // versus: the other side is a human; on the operation's last day the enemy prepares nothing more (the campaign ends)
    if (this.def.versus || this.date >= this.def.start.end) this.pendingAttacks = []; else this.enemyPhase();
    this.clearFx('player');                                  // our fire of last week has done its work
    this.checkGrowth();
    this.computeSupply(); this.resetMoves();
    this.updateSpots();
    this.checkDirectives(); this.issueDirectives(); this.newsUpTo(this.date);
    this.save();
  }
  // a new battery for the brigade's artillery group (tech with { battery: 'm777' } etc.), at the HQ
  addBattery(kind, cell = null) {
    if (!F.BATTERY[kind]) return null; const id = this.newId('b');
    const b = { id, kind, name: F.BATTERY[kind].label, cell: cell || this.deliveryCell(), hp: 1, acted: 0, moved: 0, revealed: null, down: 0, fired: 0 };
    this.arty.player.push(b); this.note(`${b.name} placed under brigade command at ${this.cellName(b.cell)}.`, 'good'); return b;
  }
  distributeReplacements(n) {
    let used = 0;
    const us = this.forces.filter(f => (f.supply ?? 1) >= 0.5).flatMap(f => this.tfUnits(f)).filter(u => u.menMax > 0).sort((a, b) => (a.men / a.menMax) - (b.men / b.menMax));
    for (const u of us) { const k = Math.min(n - used, u.menMax - u.men - u.wounded); if (k > 0) { u.men += k; used += k; u.xp = Math.max(0, u.xp - 0.5); } if (used >= n) break; }
    return used;
  }
  // a delivered unit is called by what was ordered: the catalog label, numbered among the units of that label only (the
  // brigade's starting units share catalog keys but carry their own names: 'UAV strike platoon' is key 'fpv' too)
  unitName(c) { const has = n => this.units.some(u => u.name === n); let n = 1, name = c.label; while (has(name)) name = `${c.label} #${++n}`; return name; }
  freeTfName(base, self = null) { const has = n => this.forces.some(f => f !== self && f.name === n); let n = 1, name = base; while (has(name)) name = `${base} ${++n}`; return name; }
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
    const s = this.score(), tail = `${s.ok} directives carried out, ${s.fail} failed; ${s.cells >= 0 ? `${s.cells} grid squares gained` : `${-s.cells} grid squares lost`}.`;
    const G = this.goalProgress();
    if (G && !this.def.versus) {
      // the operation goal decides; directives are the means (LP, units, tech) and the record
      if (this.goalDone) return { win: true, title: 'VICTORY', goal: true, text: `${dateLabel(this.goalDone, true)}: operation goal achieved — ${G.title}. ${tail}` };
      if (this.date >= this.def.start.end || this.turn > this.maxTurn || this.date > G.by) {
        const pct = Math.round(G.pct * 100), part = G.pct >= G.partial;
        return { win: part, title: part ? 'LIMITED SUCCESS' : 'OPERATION FAILED', goal: false, pct, text: `${dateLabel(this.date, true)}: the operation ends with ${pct}% of its goal (${G.title}) in hand: ${G.cells.filter(g => g.held).map(g => g.name).join(', ') || 'none of the objectives'}. ${tail}` };
      }
      return null;
    }
    if (this.finalResult === 'success') { const win = s.ok >= s.fail; return { win, title: win ? 'VICTORY' : 'OPERATION CONCLUDED', text: `The final directive of the operation has been carried out. ${tail}` }; }
    if (this.finalResult === 'failure') return { win: false, title: 'OPERATION FAILED', text: 'The final directive of the operation could not be carried out.' };
    if (this.date >= this.def.start.end || this.turn > this.maxTurn) {
      const good = s.ok > s.fail && s.cells >= 0;
      return { win: good, title: good ? 'OPERATION CONCLUDED' : 'STALEMATE', text: `${dateLabel(this.date, true)}: the campaign ends. ${tail}` };
    }
    return null;
  }
}
const fmt = v => (Math.round(v * 10) / 10).toString();
// share of a staff-resolved battle's casualties who are wounded rather than killed: better casualty care (tech mods
// medSave: stabilisation points, blood forward, armoured ambulances) keeps more of them alive (versus.js autoBattle too)
export const woundedShare = (m = {}) => Math.min(0.8, 0.6 + 0.25 * (m.medSave || 0));
const VIS = new WeakMap();   // visibleEnemy() cache (not saved)
