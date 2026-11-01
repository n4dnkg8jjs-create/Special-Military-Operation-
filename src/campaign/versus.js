// Versus campaign: two human commanders on ONE operation's sector map (e.g. the Orikhiv axis or Avdiivka), each with
// their own side's force, logistics points, high-command catalogue and tech tree. Built from two ordinary Campaign
// objects that share the front line: side X's "player" sectors are side Y's "enemy" sectors.
// The host is authoritative (runs endTurn / battles); the joiner mirrors its own side's state and sends actions.
import { Campaign } from './state.js';

const other = f => (f === 'UA' ? 'RU' : 'UA');

// the derived campaign definition for one faction on the chosen operation's map
export function sideDef(CAMPAIGNS, opId, faction) {
  const op = CAMPAIGNS[opId], own = CAMPAIGNS[faction];
  const mine = s => (faction === opId ? s.owner === 'player' : s.owner === 'enemy');
  const sectors = op.sectors.map(s => ({ ...s, owner: mine(s) ? 'player' : 'enemy', garrison: 0 }));
  let hq = op.start.hq;
  if (faction !== opId) {   // the defending side's HQ: its most important sector furthest from the front
    const held = sectors.filter(s => s.owner === 'player');
    hq = held.sort((a, b) => (b.vp || 1) - (a.vp || 1) || (b.type === 'town') - (a.type === 'town'))[0]?.id;
  }
  // the operation's own side keeps its real directives; the other side gets hold orders for its key sectors
  const directives = faction === opId ? op.directives : versusHoldDirectives(sectors, faction);
  return { ...own, id: faction, title: `${op.title} — versus`, region: op.region, map: op.map, sectors, directives,
    start: { ...own.start, hq, lp: own.start.lp }, enemy: { pressure: [0], reinforce: [0], forceTemplates: {} }, versus: true, op: opId };
}
function versusHoldDirectives(sectors, faction) {
  const key = sectors.filter(s => s.owner === 'player').sort((a, b) => (b.vp || 1) - (a.vp || 1)).slice(0, 4);
  const from = faction === 'RU' ? 'Group of Forces HQ' : 'Operational-Strategic Group HQ';
  const out = key.map((s, i) => ({ id: `vh${i}`, issue: { turn: 1 }, from, title: `Hold ${s.name}`, text: `Hold ${s.name} at all costs. Counterattack immediately if it is lost.`, kind: 'hold', targets: [s.id], count: 6 + i * 2, deadline: 6 + i * 2, reward: { lp: 25 + i * 5 } }));
  if (out.length) out[out.length - 1].final = true;
  return out;
}

export class Versus {
  constructor(CAMPAIGNS, opId, hostFaction) {
    this.CAMPAIGNS = CAMPAIGNS; this.opId = opId; this.host = hostFaction; this.guest = other(hostFaction);
    this.side = { [hostFaction]: new Campaign(sideDef(CAMPAIGNS, opId, hostFaction)), [this.guest]: new Campaign(sideDef(CAMPAIGNS, opId, this.guest)) };
    this.plans = {}; this.ready = {}; this.turn = 1;
  }
  // one sector owner map from a faction's perspective
  syncOwners(from) { const A = this.side[from], B = this.side[other(from)]; for (const id of Object.keys(A.owner)) B.owner[id] = A.owner[id] === 'player' ? 'enemy' : 'player'; }
  plan(faction, p) { this.plans[faction] = p; }    // p = null | { sector, uids }
  // both commanders ended the turn: the battles to fight (an attack on an empty sector simply takes it)
  battles() {
    const out = [];
    for (const f of [this.host, this.guest]) { const p = this.plans[f]; if (p && this.side[f].canAttack(p.sector)) out.push({ attacker: f, defender: other(f), sector: p.sector, uids: p.uids }); }
    return out;
  }
  // a fought (or auto-resolved) battle; result is from the attacker's point of view (collectResult format)
  applyBattle(b, rAtt, rDef) {
    const A = this.side[b.attacker], D = this.side[b.defender];
    A.applyResult({ ...rAtt, mode: 'attack' });
    D.applyResult({ ...rDef, sector: b.sector, mode: 'defend', win: !rAtt.win });
    // the attacker's view decides the sector; mirror it
    if (rAtt.win) { A.owner[b.sector] = 'player'; D.owner[b.sector] = 'enemy'; } else { A.owner[b.sector] = 'enemy'; D.owner[b.sector] = 'player'; }
    this.syncOwners(b.attacker);
  }
  endTurn() {
    for (const f of [this.host, this.guest]) { this.side[f].pendingAttacks = []; this.side[f].endTurn(); this.side[f].pendingAttacks = []; }
    this.syncOwners(this.host); this.plans = {}; this.ready = {}; this.turn++;
  }
  state(f) { const { def, ...rest } = this.side[f]; return { opId: this.opId, faction: f, turn: this.turn, c: JSON.parse(JSON.stringify(rest)), plans: this.plans[f] || null, oppReady: !!this.ready[other(f)] }; }
}
// joiner side: a Campaign object restored from the host's state
export function mirrorCampaign(CAMPAIGNS, st) { return new Campaign(sideDef(CAMPAIGNS, st.opId, st.faction), st.c); }
export { other };
