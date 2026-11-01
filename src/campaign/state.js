// Campaign rules: turns, the front line in the brigade's sector, directives from higher command, logistics points
// (LP), orders from high command (units, replacements, tech), battles (fought or auto-resolved), persistence of the
// force (losses, wounded returning, veterancy). Pure logic + localStorage; the screen lives in ui.js.
import { MODS } from './schema.js';

const KEY = 'smo.campaign.v1';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rnd = (a, b) => a + Math.random() * (b - a);
let UID = 1;

export function xpLevel(xp) { return xp >= 9 ? 3 : xp >= 5 ? 2 : xp >= 2 ? 1 : 0; }
export const XP_NAMES = ['Green', 'Trained', 'Veteran', 'Elite'];

export class Campaign {
  constructor(def, saved = null) {
    this.def = def;
    if (saved) { Object.assign(this, saved); this.def = def; UID = Math.max(UID, ...this.force.map(u => u.uid + 1), 1); return; }
    this.side = def.id; this.turn = def.start.turn || 1; this.lp = def.start.lp || 0;
    this.owner = Object.fromEntries(def.sectors.map(s => [s.id, s.owner]));
    this.garrison = Object.fromEntries(def.sectors.map(s => [s.id, s.owner === 'enemy' ? (s.garrison ?? 1) : 0]));
    this.fort = Object.fromEntries(def.sectors.map(s => [s.id, s.fort || 0]));
    this.force = def.start.force.map(u => this.record(u));
    this.unlocked = [...(def.start.unlocked || [])];
    this.available = [...(def.start.available || [])];
    this.orders = [];            // { what: 'unit'|'tech', key, eta }
    this.directives = [];        // active: { id, issued, progress }
    this.doneDirectives = {};    // id -> 'success'|'failure'
    this.log = [{ turn: this.turn, text: def.intro?.[0] || 'The operation begins.' }];
    this.pendingAttacks = [];    // enemy attacks to answer this turn: { from, to, strength }
    this.stats = { battles: 0, won: 0, kills: 0, losses: 0, vehLost: 0, vehKills: 0 };
    this.issueDirectives();
  }
  // ------------------------------------------------------------------ persistence
  static load(defs) {
    try { const raw = localStorage.getItem(KEY); if (!raw) return null; const s = JSON.parse(raw); const def = defs[s.side]; return def ? new Campaign(def, s) : null; } catch { return null; }
  }
  save() { const { def, ...rest } = this; try { localStorage.setItem(KEY, JSON.stringify(rest)); } catch (e) { console.warn('campaign save failed', e); } }
  static clear() { try { localStorage.removeItem(KEY); localStorage.removeItem(KEY + '.battle'); localStorage.removeItem(KEY + '.result'); } catch {} }
  static pendingBattle() { try { return JSON.parse(localStorage.getItem(KEY + '.battle') || 'null'); } catch { return null; } }
  static storeResult(r) { try { localStorage.setItem(KEY + '.result', JSON.stringify(r)); localStorage.removeItem(KEY + '.battle'); } catch {} }
  static takeResult() { try { const r = JSON.parse(localStorage.getItem(KEY + '.result') || 'null'); localStorage.removeItem(KEY + '.result'); return r; } catch { return null; } }
  // ------------------------------------------------------------------ helpers
  sector(id) { return this.def.sectors.find(s => s.id === id); }
  catalogItem(key) { return this.def.catalog.find(c => c.key === key); }
  techItem(id) { return this.def.tech.find(t => t.id === id); }
  record(u) {
    const c = this.catalogItem(u.key) || {};
    const men = u.men ?? c.men ?? 0, kind = u.kind || c.kind, vk = u.veh?.kind || c.vehicle;
    return { uid: u.uid ?? UID++, key: u.key, name: u.name || c.label || kind, kind, men, menMax: u.menMax ?? men, wounded: u.wounded || 0, woundedT: u.woundedT || 0,
      veh: vk ? { kind: vk, hp: u.veh?.hp ?? 1, lost: !!u.veh?.lost } : null, xp: u.xp || 0, battles: u.battles || 0, kills: u.kills || 0, status: u.status || 'ready', eta: u.eta || 0 };
  }
  mods() {
    const m = {};
    for (const id of this.unlocked) { const t = this.techItem(id); if (!t?.mods) continue; for (const [k, v] of Object.entries(t.mods)) { if (!(k in MODS)) continue; m[k] = typeof v === 'boolean' ? (m[k] || v) : (m[k] || 0) + v; } }
    return m;
  }
  frontline(id) { return this.sector(id).adj.some(a => this.owner[a] !== this.owner[id]); }
  canAttack(id) { return this.owner[id] === 'enemy' && this.sector(id).adj.some(a => this.owner[a] === 'player'); }
  ready() { return this.force.filter(u => u.status === 'ready' && (u.men > 0 || (u.veh && !u.veh.lost))); }
  lpIncome() { return this.def.sectors.filter(s => this.owner[s.id] === 'player').reduce((a, s) => a + (s.lp || 0), 0); }
  // ------------------------------------------------------------------ orders from high command
  techAvailable(id) { const t = this.techItem(id); return t && !this.unlocked.includes(id) && !this.orders.some(o => o.key === id) && (t.req || []).every(r => this.unlocked.includes(r)); }
  orderTech(id) {
    const t = this.techItem(id); if (!this.techAvailable(id)) return 'Not available'; if (this.lp < t.lp) return 'Not enough logistics points';
    this.lp -= t.lp; this.orders.push({ what: 'tech', key: id, eta: t.eta ?? 1 }); this.note(`Requested from high command: ${t.name} (${t.eta ?? 1} turn${(t.eta ?? 1) === 1 ? '' : 's'}).`); this.save(); return null;
  }
  catalogAvailable(c) { return this.available.includes(c.key) && (c.req || []).every(r => this.unlocked.includes(r)) && (c.limit == null || this.force.filter(u => u.key === c.key).length + this.orders.filter(o => o.key === c.key).length < c.limit); }
  orderUnit(key) {
    const c = this.catalogItem(key); if (!c || !this.catalogAvailable(c)) return 'Not available';
    const cost = Math.round(c.lp * (c.kind === 'replacements' ? (1 + (this.mods().replacementsCost || 0)) : 1)); if (this.lp < cost) return 'Not enough logistics points';
    this.lp -= cost; this.orders.push({ what: 'unit', key, eta: c.eta ?? 1 }); this.note(`Ordered: ${c.label} (arrives in ${c.eta ?? 1} turn${(c.eta ?? 1) === 1 ? '' : 's'}).`); this.save(); return null;
  }
  // replacements: fill a unit back up (men) / repair or replace its vehicle
  replaceCost(u) { const missing = Math.max(0, u.menMax - u.men - u.wounded); const vc = u.veh ? (u.veh.lost ? (this.catalogItem(u.key)?.lp || 12) * 0.6 : (1 - u.veh.hp) * 8) : 0; return Math.ceil((missing * 1.2 + vc) * (1 + (this.mods().replacementsCost || 0))); }
  replenish(uid) {
    const u = this.force.find(f => f.uid === uid); if (!u) return 'No such unit'; const cost = this.replaceCost(u); if (!cost) return 'Already at full strength'; if (this.lp < cost) return 'Not enough logistics points';
    this.lp -= cost; u.men = Math.max(u.men, u.menMax - u.wounded); if (u.veh) { u.veh.hp = 1; u.veh.lost = false; } u.status = 'refit'; u.eta = 1;
    u.xp = Math.max(0, u.xp - 1);   // new men dilute the experience
    this.note(`${u.name}: replacements and repairs requested (${cost} LP); back next turn.`); this.save(); return null;
  }
  // ------------------------------------------------------------------ directives
  issueDirectives() {
    for (const d of this.def.directives) {
      if (this.directives.some(a => a.id === d.id) || this.doneDirectives[d.id]) continue;
      const is = d.issue || {}; let ok = false;
      if (is.turn != null && this.turn >= is.turn && !is.after && !is.when) ok = true;
      if (is.after && this.doneDirectives[is.after]) ok = (is.result ? this.doneDirectives[is.after] === is.result : true);
      if (is.when) { const [k, sid] = is.when.split(':'); ok = (k === 'captured' && this.owner[sid] === 'player') || (k === 'lost' && this.owner[sid] === 'enemy' && this.sector(sid)?.owner === 'player'); }
      if (!ok) continue;
      this.directives.push({ id: d.id, issued: this.turn, progress: 0 });
      this.note(`New directive from ${d.from || 'higher command'}: ${d.title}.`, 'directive');
    }
  }
  directiveDef(id) { return this.def.directives.find(d => d.id === id); }
  checkDirectives(event = null) {
    for (const a of [...this.directives]) {
      const d = this.directiveDef(a.id); if (!d) continue;
      let done = false;
      if (d.kind === 'capture') done = d.targets.every(t => this.owner[t] === 'player');
      else if (d.kind === 'destroy') { if (event?.kills) a.progress += event.vehKills || 0; done = a.progress >= (d.count || 5); }
      else if (d.kind === 'recon') done = d.targets.every(t => this.recon?.[t]);
      else if (d.kind === 'hold' || d.kind === 'survive') { const held = d.targets.every(t => this.owner[t] === 'player'); if (!held) { this.finishDirective(a, d, false); continue; } done = this.turn - a.issued >= (d.count || d.deadline); }
      if (done) { this.finishDirective(a, d, true); continue; }
      if (this.turn - a.issued >= d.deadline) this.finishDirective(a, d, false);
    }
  }
  finishDirective(a, d, ok) {
    this.directives = this.directives.filter(x => x !== a); this.doneDirectives[d.id] = ok ? 'success' : 'failure';
    if (ok) {
      const r = d.reward || {}; this.lp += Math.round((r.lp || 0) * (1 + (this.mods().lpGain || 0)));
      for (const t of r.unlock || []) if (!this.unlocked.includes(t)) this.unlocked.push(t);
      for (const u of r.units || []) this.force.push(this.record({ ...u, status: 'arriving', eta: 1 }));
      this.note(`Directive complete: ${d.title}.${r.lp ? ` +${r.lp} LP from high command.` : ''}`, 'good');
    } else { this.lp = Math.max(0, this.lp - (d.penalty?.lp || 0)); this.note(`Directive failed: ${d.title}.${d.penalty?.lp ? ` High command cuts ${d.penalty.lp} LP.` : ''}`, 'bad'); }
    const nx = ok ? d.next?.success : d.next?.failure;
    if (nx && !this.doneDirectives[nx] && !this.directives.some(x => x.id === nx)) { this.directives.push({ id: nx, issued: this.turn, progress: 0 }); const nd = this.directiveDef(nx); if (nd) this.note(`New directive from ${nd.from || 'higher command'}: ${nd.title}.`, 'directive'); }
  }
  // ------------------------------------------------------------------ battles
  // a battle the player fights: which RTS map, mode, the player's task group, the enemy composition
  battleSetup(sectorId, uids, mode = 'attack', from = null) {
    const s = this.sector(sectorId), E = this.def.enemy || {};
    const strength = clamp(Math.round(mode === 'attack' ? Math.max(1, this.garrison[sectorId] || 1) : (from?.strength || 1)), 1, 3);
    const tpl = (E.forceTemplates || {})[strength] || (E.forceTemplates || {})[String(strength)] || [{ kind: 'mech' }, { kind: 'foot' }, { kind: 'tank' }];
    return {
      sector: sectorId, sectorName: s.name, map: s.battleMap, mode, fort: this.fort[sectorId] || 0, strength,
      force: this.force.filter(u => uids.includes(u.uid)), enemy: tpl.map(e => ({ ...e })), mods: this.mods(), side: this.side,
      fpvThreat: E.fpvThreat ?? 0.5, artillery: E.artillery ?? 0.5, turn: this.turn,
    };
  }
  launch(setup) { try { localStorage.setItem(KEY + '.battle', JSON.stringify(setup)); } catch {} this.save(); }
  // apply what happened in a fought battle (from the game, see src/game/campaignBattle.js)
  applyResult(r) {
    const s = this.sector(r.sector); this.stats.battles++;
    const mods = this.mods(), lpMul = 1 + (mods.lpGain || 0);
    for (const ur of r.units) {
      const u = this.force.find(f => f.uid === ur.uid); if (!u) continue;
      u.battles++; u.kills += ur.kills || 0; this.stats.kills += ur.kills || 0;
      const lost = Math.max(0, u.men - ur.alive - ur.wounded); this.stats.losses += lost;
      u.men = ur.alive; u.wounded += ur.wounded; u.woundedT = 2;
      if (u.veh) { if (ur.vehLost) { u.veh.lost = true; u.veh.hp = 0; this.stats.vehLost++; } else u.veh.hp = clamp(ur.vehHp + (mods.repair || 0) * (1 - ur.vehHp), 0, 1); }
      u.xp += (ur.alive > 0 || (u.veh && !u.veh.lost) ? 1 : 0) + (r.win ? 1 : 0) + Math.min(2, (ur.kills || 0) / 4);
      u.status = 'refit'; u.eta = 1;
    }
    this.stats.vehKills += r.enemyVehLost || 0;
    let lp = 6 + (r.enemyKia || 0) * 0.6 + (r.enemyVehLost || 0) * 4 + (r.objectivesHeld || 0) * 5;
    if (r.win) {
      this.stats.won++; lp += 10;
      if (r.mode === 'attack') { this.owner[r.sector] = 'player'; this.garrison[r.sector] = 0; this.note(`${s.name} taken.`, 'good'); this.recon = { ...(this.recon || {}), [r.sector]: true }; }
      else this.note(`Enemy attack on ${s.name} repulsed.`, 'good');
    } else {
      if (r.mode === 'defend') { this.owner[r.sector] = 'enemy'; this.garrison[r.sector] = 1; this.note(`${s.name} lost.`, 'bad'); this.retreatFrom(r.sector); }
      else { this.garrison[r.sector] = Math.max(1, (this.garrison[r.sector] || 1) - (r.enemyKia > 15 ? 1 : 0)); this.note(`Attack on ${s.name} failed.`, 'bad'); }
    }
    lp = Math.round(lp * lpMul); this.lp += lp; this.note(`Battle report: +${lp} LP.`);
    this.pendingAttacks = this.pendingAttacks.filter(a => a.to !== r.sector);
    this.battleFought = true;
    this.checkDirectives({ kills: true, vehKills: r.enemyVehLost || 0 });
    this.issueDirectives(); this.save();
  }
  retreatFrom(id) { /* the task group falls back; nothing to move on this level of abstraction */ }
  // battles the player doesn't fight himself: strength comparison with noise
  autoResolve(sectorId, mode, enemyStrength, uids = []) {
    const units = this.force.filter(u => uids.includes(u.uid));
    const power = units.reduce((a, u) => a + (u.men * 0.12 + (u.veh && !u.veh.lost ? (u.veh.kind === 'tank' ? 1.4 : 0.8) : 0)) * (1 + xpLevel(u.xp) * 0.12), 0) + (mode === 'defend' ? 1.2 + this.fort[sectorId] * 0.4 : 0);
    const enemy = enemyStrength * 2.2 + (mode === 'attack' ? this.fort[sectorId] * 0.6 : 0);
    const win = power * rnd(0.75, 1.25) > enemy * rnd(0.75, 1.25);
    const r = { sector: sectorId, mode, win, units: units.map(u => { const cas = Math.round(u.men * rnd(0.05, win ? 0.25 : 0.45)); const w = Math.round(cas * 0.6); return { uid: u.uid, alive: Math.max(0, u.men - cas), wounded: w, kills: Math.round(rnd(0, 4)), vehLost: u.veh && !u.veh.lost && Math.random() < (win ? 0.1 : 0.3), vehHp: u.veh ? rnd(0.5, 1) : 1 }; }), enemyKia: Math.round(rnd(3, 12)), enemyVehLost: Math.random() < 0.5 ? 1 : 0, objectivesHeld: win ? 2 : 0, auto: true };
    // a sector defended by no one simply falls
    if (mode === 'defend' && !units.length) r.win = Math.random() < 0.15 + this.fort[sectorId] * 0.1;
    this.applyResult(r); return r;
  }
  // ------------------------------------------------------------------ end of turn
  endTurn() {
    // unresolved enemy attacks: auto-resolved with nobody committed
    for (const a of [...this.pendingAttacks]) this.autoResolve(a.to, 'defend', a.strength, []);
    this.turn++; this.battleFought = false;
    // deliveries from high command, refits, wounded returning
    for (const o of this.orders) o.eta--;
    for (const o of this.orders.filter(o => o.eta <= 0)) {
      if (o.what === 'tech') { this.unlocked.push(o.key); const t = this.techItem(o.key); for (const k of t?.unlock || []) if (!this.available.includes(k)) this.available.push(k); this.note(`Delivered: ${t?.name}.`, 'good'); }
      else { const c = this.catalogItem(o.key); if (c?.kind === 'replacements') { this.distributeReplacements(c.men || 8); this.note(`${c.men || 8} replacements arrived.`, 'good'); } else if (c) { this.force.push(this.record({ key: c.key, kind: c.kind, men: c.men, veh: c.vehicle ? { kind: c.vehicle } : null, name: this.unitName(c) })); this.note(`Arrived: ${c.label}.`, 'good'); } }
    }
    this.orders = this.orders.filter(o => o.eta > 0);
    for (const u of this.force) {
      if (u.status !== 'ready' && --u.eta <= 0) u.status = 'ready';
      if (u.wounded && --u.woundedT <= 0) { const back = Math.ceil(u.wounded * 0.6); u.men = Math.min(u.menMax, u.men + back); u.wounded = 0; }
    }
    this.force = this.force.filter(u => u.men > 0 || u.wounded > 0 || (u.veh && !u.veh.lost) || u.status === 'arriving');
    // supply: LP from held sectors (roads, depots)
    const inc = Math.round(this.lpIncome() * (1 + (this.mods().lpGain || 0))); if (inc) { this.lp += inc; this.note(`Supply from held sectors: +${inc} LP.`); }
    // enemy: reinforces its sectors and counterattacks along the front
    const E = this.def.enemy || {}, t = this.turn - 1;
    const reinf = (E.reinforce || [])[Math.min(t, (E.reinforce || []).length - 1)] ?? 0.3, press = (E.pressure || [])[Math.min(t, (E.pressure || []).length - 1)] ?? 0.25;
    for (const s of this.def.sectors) if (this.owner[s.id] === 'enemy') this.garrison[s.id] = clamp((this.garrison[s.id] || 0) + (Math.random() < reinf ? 1 : 0), 0, 3);
    const front = this.def.sectors.filter(s => this.owner[s.id] === 'player' && s.adj.some(a => this.owner[a] === 'enemy'));
    this.pendingAttacks = [];
    for (const s of front) if (Math.random() < press * (1 + s.vp * 0.1)) {
      const from = s.adj.filter(a => this.owner[a] === 'enemy').sort((a, b) => (this.garrison[b] || 0) - (this.garrison[a] || 0))[0];
      this.pendingAttacks.push({ from, to: s.id, strength: clamp(Math.round((this.garrison[from] || 1) * rnd(0.7, 1.3)), 1, 3) });
      if (this.pendingAttacks.length >= 2) break;
    }
    for (const a of this.pendingAttacks) this.note(`Intelligence: enemy preparing an attack on ${this.sector(a.to).name} from ${this.sector(a.from).name}.`, 'bad');
    this.checkDirectives(); this.issueDirectives(); this.save();
  }
  distributeReplacements(n) {
    for (const u of this.force.filter(f => f.menMax > 0).sort((a, b) => (a.men / a.menMax) - (b.men / b.menMax))) { const k = Math.min(n, u.menMax - u.men - u.wounded); if (k > 0) { u.men += k; n -= k; u.xp = Math.max(0, u.xp - 0.5); } if (n <= 0) break; }
  }
  unitName(c) { const n = this.force.filter(u => u.key === c.key).length + 1; return `${c.label} ${n > 1 ? '#' + n : ''}`.trim(); }
  note(text, kind = '') { this.log.push({ turn: this.turn, text, kind }); if (this.log.length > 200) this.log.shift(); }
  // victory / defeat of the whole operation
  outcome() {
    const fin = this.def.directives.find(d => d.final);
    if (fin && this.doneDirectives[fin.id] === 'success') return { win: true, text: 'The operation succeeded.' };
    const hq = this.def.start.hq; if (hq && this.owner[hq] === 'enemy') return { win: false, text: 'Brigade headquarters sector overrun.' };
    if (!this.ready().length && !this.force.some(u => u.status !== 'ready') && this.lp < 10) return { win: false, text: 'The brigade is no longer combat-capable.' };
    return null;
  }
}
