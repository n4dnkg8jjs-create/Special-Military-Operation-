// Command Influence (CI): the brigade commander's standing with the command above him - a second, scarce currency beside the
// logistics points. It is earned by doing what high command asked (directives carried out, battles won, a logistics hub
// taken) and spent on things no brigade owns: attachments that army / front level hands out for a few weeks and wants back.
//   Leopard 2A6 section (UA)   two tanks from the army reserve for 4 weeks: far better gun and frontal armour than the
//                              brigade's T-64 / T-72, no anti-drone screen, no riders
//   VDV assault platoon (RU)   three sections of airborne assault infantry (elite, full kit) for 4 weeks
//   Mi-24 on call (both)       army aviation: one rocket strike per battle for 3 weeks (game/heli.js) - it can be shot down
// They are better than what the brigade has and they are on loan: lose them and the brigade pays. A Leopard knocked out, the
// VDV platoon down to half its men, or the helicopter shot down, and high command cuts the brigade's LP allocation for some
// weeks (ciPenalty) - and the attachment's time is not extended. When its weeks are up it goes back whatever state it is in.
// Pure rules (no three.js): installed onto Campaign2's prototype by install(); the node rule tests can run it.

export const CI = { start: 2, directive: 2, win: 1, hub: 1, max: 12 };
export const REQUESTS = [
  { id: 'leopard', side: 'UA', name: 'Leopard 2A6 section', cost: 6, weeks: 4, date: '2023-06-01',
    text: 'Two Leopard 2A6 of the army reserve attached to the brigade: L/55 gun that kills any tank on this front from the front, turret armour nothing here goes through. No anti-drone screens, 27 rounds beside the driver, and no infantry rides on them.',
    risk: 'Each Leopard lost: −4 LP a week for 4 weeks.', penalty: { lp: 4, weeks: 4 },
    units: [{ key: 'tank', kind: 'tank', name: 'Leopard 2A6 "1"', men: 4, xp: 6, veh: { kind: 'tank', variant: 'tank_leopard' } }, { key: 'tank', kind: 'tank', name: 'Leopard 2A6 "2"', men: 4, xp: 6, veh: { kind: 'tank', variant: 'tank_leopard' } }] },
  { id: 'vdv', side: 'RU', name: 'VDV assault platoon', cost: 5, weeks: 4,
    text: 'A platoon of the airborne forces sent to stiffen the attack: three assault sections, elite, in full kit. They take ground the motor rifles cannot - and the airborne command counts every man it lends.',
    risk: 'The platoon reduced to half its men: −4 LP a week for 4 weeks.', penalty: { lp: 4, weeks: 4 },
    units: [1, 2, 3].map(i => ({ key: 'assault', kind: 'assault', name: `VDV assault section ${i}`, men: 6, xp: 9 })) },
  { id: 'hind', side: null, name: 'Mi-24 on call', cost: 4, weeks: 3,
    text: 'Army aviation keeps a Mi-24 for the brigade: one rocket run per battle on the area you mark (about twenty S-8 over 55 × 25 m). It comes in low and it can be shot down - autocannon, heavy machine guns and shoulder-launched missiles all reach it.',
    risk: 'The helicopter shot down: −5 LP a week for 4 weeks, and no more sorties.', penalty: { lp: 5, weeks: 4 }, strikes: 1 },
];
const HIND_ON = false;   /* the Mi-24 strike is switched off for now (game/heli.js HELI_ON): not offered, a loan still running gives no sorties */
const reqOf = id => REQUESTS.find(r => r.id === id);

const M = {
  ciInit() { this.ci ??= this.def?.start?.ci ?? CI.start; this.ciActive ||= []; this.ciPenalty ||= []; },
  ciEarn(n, why) { this.ciInit(); const b = this.ci; this.ci = Math.min(CI.max, this.ci + n); if (this.ci > b) this.note(`Command influence +${this.ci - b}${why ? ` (${why})` : ''}: ${this.ci}.`, 'good'); },
  // what can be asked for, with why not
  ciList() {
    this.ciInit();
    return REQUESTS.filter(r => (!r.side || r.side === this.side) && (r.id !== 'hind' || HIND_ON)).map(r => {
      const act = this.ciActive.find(a => a.id === r.id);
      const block = act ? `With the brigade for ${Math.max(0, act.until - this.turn)} more week(s)` : r.date && String(this.date) < r.date ? `Not before ${r.date}` : this.ci < r.cost ? `Needs ${r.cost} command influence` : this.def.versus ? 'Not in versus' : null;
      return { ...r, active: act || null, block };
    });
  },
  ciRequest(id) {
    this.ciInit(); const r = this.ciList().find(q => q.id === id); if (!r) return 'Unknown request'; if (r.block) return r.block;
    this.ci -= r.cost;
    const a = { id, until: this.turn + r.weeks, uids: [], men0: 0, hit: 0 };
    for (const u of r.units || []) { const rec = this.record({ ...u, veh: u.veh ? { ...u.veh, hp: 1 } : undefined, status: 'ready' }); rec.special = id; this.deliverUnit(rec); a.uids.push(rec.uid); a.men0 += rec.men; }
    this.ciActive.push(a);
    this.note(`High command attaches ${r.name} to the brigade for ${r.weeks} weeks${r.units ? ` (at ${this.cellName(this.deliveryCell())})` : ''}.`, 'good');
    this.save?.();
  },
  ciBattle() { this.ciInit(); const h = this.ciActive.find(a => a.id === 'hind' && !a.gone); return { heli: h && HIND_ON ? reqOf('hind').strikes : 0 }; },
  ciFine(a, r, why) { this.ciPenalty.push({ lp: r.penalty.lp, until: this.turn + r.penalty.weeks, why }); this.note(`${why} High command cuts the brigade's allocation: −${r.penalty.lp} LP a week for ${r.penalty.weeks} weeks.`, 'bad'); },
  // after a battle: what happened to the things on loan
  ciAfterBattle(res) {
    this.ciInit();
    for (const a of this.ciActive) {
      const r = reqOf(a.id); if (!r) continue;
      if (a.id === 'hind') { if (res.heliLost && !a.gone) { a.gone = true; a.until = this.turn; this.ciFine(a, r, 'The Mi-24 was shot down.'); } continue; }
      const us = a.uids.map(id => this.unit(id)).filter(Boolean);
      if (a.id === 'leopard') { const lost = us.filter(u => u.veh?.lost).length; for (let k = a.hit; k < lost; k++) this.ciFine(a, r, 'A Leopard 2A6 was lost.'); a.hit = lost; }
      else if (a.id === 'vdv' && !a.hit) { const men = us.reduce((s, u) => s + u.men + (u.wounded || 0) * 0.5, 0); if (men < a.men0 * 0.5) { a.hit = 1; this.ciFine(a, r, 'The VDV platoon is down to half its strength.'); } }
    }
  },
  // week's end: loans called back, fines run out
  ciTick() {
    this.ciInit();
    for (const a of this.ciActive.filter(q => this.turn >= q.until)) {
      const r = reqOf(a.id), gone = new Set(a.uids);
      if (gone.size) { this.units = this.units.filter(u => !gone.has(u.uid)); for (const f of this.forces) f.units = f.units.filter(id => !gone.has(id)); this.forces = this.forces.filter(f => f.units.length || !f.reserve); }
      this.note(a.gone ? `${r?.name || a.id}: no more sorties.` : `${r?.name || a.id} returns to its parent formation.`, 'info');
    }
    this.ciActive = this.ciActive.filter(q => this.turn < q.until);
    this.ciPenalty = this.ciPenalty.filter(p => this.turn < p.until);
  },
  ciLpPenalty() { return (this.ciPenalty || []).filter(p => this.turn < p.until).reduce((s, p) => s + p.lp, 0); },
};

export function install(C2) { Object.assign(C2.prototype, M); }
