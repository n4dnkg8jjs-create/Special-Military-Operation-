// Strategic screen of the campaign: the brigade's sector map, directives from higher command, the task group,
// orders to high command (units, replacements, tech tree) paid with logistics points, and the operations log.
import { Campaign, xpLevel, XP_NAMES } from './state.js';

const $ = (sel, el = document) => el.querySelector(sel);
const h = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } if (html) e.innerHTML = html; return e; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const KIND_ICON = { mech: '⊠', imech: '⊠', assault: '⊠', tank: '⬭', atgm: '△', fpv: '≈', spg: '●', replacements: '+' };
const MAX_GROUP = 9;

export async function openCampaign(onLaunch) {
  let CAMPAIGNS; try { ({ CAMPAIGNS } = await import('./index.js')); } catch (e) { console.error(e); alert('Campaign content is not available yet.'); return; }
  injectCss();
  document.getElementById('menu')?.classList.add('hidden');
  let root = document.getElementById('campaign'); if (!root) { root = h('div', { id: 'campaign' }); document.body.appendChild(root); }
  root.classList.remove('hidden');
  let C = Campaign.load(CAMPAIGNS);
  const res = Campaign.takeResult(); if (C && res) C.applyResult(res);
  const pre = new URLSearchParams(location.search).get('cside');   // headless preview: start a fresh campaign for this side
  if (pre && CAMPAIGNS[pre]) { C = new Campaign(CAMPAIGNS[pre]); C.save(); }
  if (!C) { chooseSide(root, CAMPAIGNS, def => { C = new Campaign(def); C.save(); new CampaignUI(root, C, onLaunch).render(); }); window.__done = true; return; }
  new CampaignUI(root, C, onLaunch).render(res);
  window.__done = true;   // headless preview hook
}

function chooseSide(root, CAMPAIGNS, done) {
  root.innerHTML = '';
  const box = h('div', { class: 'cp-choose' }, `<div class="kicker">CAMPAIGN</div><h1>Brigade sector</h1><p class="brief">Command one brigade's operational sector. Higher command sends directives; you fight the battles, keep your task group alive and order replacements, new units and equipment with the logistics points your battles earn.</p>`);
  const row = h('div', { class: 'cp-sides' });
  for (const def of Object.values(CAMPAIGNS)) {
    const card = h('button', { class: 'cp-side', onclick: () => done(def) }, `<div class="cp-side-k">${def.id === 'UA' ? 'UKRAINE' : 'RUSSIA'}</div><div class="cp-side-t">${esc(def.title)}</div><div class="cp-side-s">${esc(def.brigade?.name || '')}</div><div class="cp-side-r">${esc(def.region || '')}</div>`);
    row.appendChild(card);
  }
  box.appendChild(row); box.appendChild(h('button', { class: 'cp-back', onclick: () => { root.classList.add('hidden'); document.getElementById('menu')?.classList.remove('hidden'); } }, 'Back'));
  root.appendChild(box);
}

class CampaignUI {
  constructor(root, C, onLaunch) { this.root = root; this.C = C; this.onLaunch = onLaunch; this.tab = 'dir'; this.sel = null; this.group = new Set(); this.msg = ''; }
  render(result = null) {
    const C = this.C, D = C.def;
    this.root.innerHTML = '';
    const top = h('div', { class: 'cp-top' }, `<div><div class="kicker">${esc(D.brigade?.short || D.brigade?.name || '')} · ${esc(D.region || '')}</div><h2>${esc(D.title)}</h2></div>
      <div class="cp-stats"><div><span>TURN</span><b>${C.turn}</b></div><div><span>LOGISTICS POINTS</span><b class="lp">${C.lp}</b></div><div><span>INCOME</span><b>+${C.lpIncome()}/turn</b></div><div><span>BATTLES</span><b>${C.stats.won}/${C.stats.battles}</b></div></div>`);
    const endBtn = h('button', { class: 'big cp-end', onclick: () => { C.endTurn(); this.sel = null; this.group.clear(); this.render(); } }, 'END TURN');
    top.appendChild(endBtn);
    top.appendChild(h('button', { class: 'cp-menu', onclick: () => { if (confirm('Abandon this campaign? Progress will be lost.')) { Campaign.clear(); location.href = location.pathname; } } }, 'Abandon'));
    top.appendChild(h('button', { class: 'cp-menu', onclick: () => { location.href = location.pathname; } }, 'Main menu'));
    this.root.appendChild(top);
    const body = h('div', { class: 'cp-body' });
    const mapBox = h('div', { class: 'cp-map' }); mapBox.appendChild(this.mapSvg()); body.appendChild(mapBox);
    const side = h('div', { class: 'cp-side-panel' });
    const tabs = h('div', { class: 'cp-tabs' });
    for (const [k, l] of [['dir', 'Directives'], ['force', 'Task group'], ['hc', 'High command'], ['tech', 'Tech tree'], ['log', 'Log']]) tabs.appendChild(h('button', { class: this.tab === k ? 'on' : '', onclick: () => { this.tab = k; this.render(); } }, l));
    side.appendChild(tabs);
    const pane = h('div', { class: 'cp-pane' });
    if (this.sel) pane.appendChild(this.sectorPanel());
    if (C.pendingAttacks.length) pane.appendChild(this.attacksPanel());
    pane.appendChild(({ dir: () => this.directivesPanel(), force: () => this.forcePanel(), hc: () => this.hcPanel(), tech: () => this.techPanel(), log: () => this.logPanel() })[this.tab]());
    side.appendChild(pane); body.appendChild(side); this.root.appendChild(body);
    if (this.msg) { this.root.appendChild(h('div', { class: 'cp-toast' }, esc(this.msg))); this.msg = ''; }
    if (result) this.root.appendChild(this.resultModal(result));
    const out = C.outcome(); if (out) this.root.appendChild(h('div', { class: 'cp-modal' }, `<div class="cp-modal-in"><div class="kicker">OPERATION ${out.win ? 'COMPLETE' : 'FAILED'}</div><h1>${out.win ? 'VICTORY' : 'DEFEAT'}</h1><p>${esc(out.text)}</p><p>Battles won ${C.stats.won} of ${C.stats.battles} · enemy killed ${C.stats.kills} · own losses ${C.stats.losses} · enemy vehicles ${C.stats.vehKills}</p><button class="big" onclick="localStorage.removeItem('smo.campaign.v1');location.href=location.pathname">NEW CAMPAIGN</button></div>`));
  }
  // ------------------------------------------------------------------ the sector map
  mapSvg() {
    const C = this.C, M = C.def.map, NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${M.w} ${M.h}`); svg.setAttribute('class', 'cp-svg');
    const add = (tag, a, parent = svg) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); parent.appendChild(e); return e; };
    add('rect', { x: 0, y: 0, width: M.w, height: M.h, fill: '#2b2e25' });
    const P = pts => pts.map(p => p.join(',')).join(' ');
    for (const f of M.fields || []) add('polygon', { points: P(f), fill: '#34382b', stroke: '#3d4232', 'stroke-width': 1 });
    for (const f of M.forests || []) add('polygon', { points: P(f), fill: '#232a1e', stroke: '#1c2218', 'stroke-width': 1.5 });
    for (const r of M.rivers || []) add('polyline', { points: P(r.pts), fill: 'none', stroke: '#3c5560', 'stroke-width': r.width || 6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    for (const r of M.rail || []) add('polyline', { points: P(r.pts), fill: 'none', stroke: '#555', 'stroke-width': 2, 'stroke-dasharray': '6 3' });
    for (const r of M.roads || []) add('polyline', { points: P(r.pts), fill: 'none', stroke: r.kind === 'highway' ? '#8a8270' : r.kind === 'road' ? '#6f6858' : '#544f43', 'stroke-width': r.kind === 'highway' ? 4 : r.kind === 'road' ? 2.5 : 1.5, 'stroke-dasharray': r.kind === 'track' ? '5 4' : '' });
    for (const l of M.labels || []) add('text', { x: l.x, y: l.y, fill: '#7d7a6c', 'font-size': l.size || 14, 'font-style': 'italic' }).textContent = l.text;
    const S = C.def.sectors, by = Object.fromEntries(S.map(s => [s.id, s]));
    // adjacency; front-line edges (between owners) drawn heavy
    const seen = new Set();
    for (const s of S) for (const a of s.adj) { const k = [s.id, a].sort().join('|'); if (seen.has(k) || !by[a]) continue; seen.add(k); const front = C.owner[s.id] !== C.owner[a];
      add('line', { x1: s.x, y1: s.y, x2: by[a].x, y2: by[a].y, stroke: front ? '#d0a24a' : '#55574a', 'stroke-width': front ? 2.5 : 1, 'stroke-dasharray': front ? '' : '3 4', opacity: front ? 0.9 : 0.6 }); }
    // enemy attacks being prepared
    for (const a of C.pendingAttacks) { const f = by[a.from], t = by[a.to]; if (!f || !t) continue; add('line', { x1: f.x, y1: f.y, x2: t.x + (f.x - t.x) * 0.2, y2: t.y + (f.y - t.y) * 0.2, stroke: '#d24a3a', 'stroke-width': 5, 'marker-end': 'url(#arr)', opacity: 0.85 }); }
    const defs = add('defs', {}); const mk = add('marker', { id: 'arr', viewBox: '0 0 10 10', refX: 6, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto' }, defs); add('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#d24a3a' }, mk);
    const targets = new Set(C.directives.flatMap(a => C.directiveDef(a.id)?.targets || []));
    for (const s of S) {
      const own = C.owner[s.id], g = add('g', { class: 'cp-sec', transform: `translate(${s.x},${s.y})` });
      g.addEventListener('click', () => { this.sel = s.id; this.render(); });
      const r = 10 + (s.vp || 1) * 2.2;
      if (targets.has(s.id)) add('circle', { r: r + 7, fill: 'none', stroke: '#e8d27a', 'stroke-width': 2, 'stroke-dasharray': '4 3' }, g);
      add(s.type === 'town' || s.type === 'industrial' ? 'rect' : 'circle', s.type === 'town' || s.type === 'industrial' ? { x: -r, y: -r, width: r * 2, height: r * 2, rx: 3 } : { r }, g)
        .setAttribute('style', `fill:${own === 'player' ? (C.side === 'UA' ? '#3f5f8a' : '#7a3f3f') : (C.side === 'UA' ? '#7a3f3f' : '#3f5f8a')};stroke:${this.sel === s.id ? '#fff' : '#111'};stroke-width:${this.sel === s.id ? 3 : 1.5};${C.canAttack(s.id) ? 'cursor:pointer' : ''}`);
      if (own === 'enemy') for (let i = 0; i < (C.garrison[s.id] || 0); i++) add('rect', { x: -r + 3 + i * 7, y: -r - 9, width: 5, height: 5, fill: '#e06a5a' }, g);
      for (let i = 0; i < (C.fort[s.id] || 0); i++) add('path', { d: `M${-6 + i * 6},${r + 4} l3,4 l3,-4`, stroke: '#c9b98d', fill: 'none', 'stroke-width': 1.5 }, g);
      if (s.id === C.def.start.hq) add('text', { y: 4, 'text-anchor': 'middle', fill: '#fff', 'font-size': 10, 'font-weight': 700 }, g).textContent = 'HQ';
      add('text', { y: r + 18, 'text-anchor': 'middle', fill: '#e6e2d3', 'font-size': 12, 'paint-order': 'stroke', stroke: '#1d1f19', 'stroke-width': 3 }, g).textContent = s.name;
    }
    add('text', { x: 12, y: M.h - 12, fill: '#8a877a', 'font-size': 12 }).textContent = `Enemy rear: ${M.enemyEdge || ''} · ${C.side === 'UA' ? 'blue = Ukrainian control' : 'red = Russian control'} · dashed ring = directive objective · red pips = enemy strength`;
    return svg;
  }
  // ------------------------------------------------------------------ panels
  sectorPanel() {
    const C = this.C, s = C.sector(this.sel), own = C.owner[s.id];
    const p = h('div', { class: 'cp-card' }, `<div class="cp-card-h">${esc(s.name)} <small>${esc(s.type)} · ${own === 'player' ? 'held' : 'enemy-held'}</small><button class="cp-x">×</button></div>
      <div class="cp-kv">Importance <b>${s.vp}</b> · Supply <b>+${s.lp || 0} LP/turn</b> · Fortifications <b>${['none', 'light', 'dug in', 'fortified line'][C.fort[s.id] || 0]}</b>${own === 'enemy' ? ` · Enemy strength <b>${['—', 'company', 'reinforced company', 'battalion'][C.garrison[s.id] || 0]}</b>` : ''}</div>${s.notes ? `<p class="cp-note">${esc(s.notes)}</p>` : ''}`);
    $('.cp-x', p).onclick = () => { this.sel = null; this.render(); };
    if (C.canAttack(s.id)) {
      if (C.battleFought) p.appendChild(h('p', { class: 'cp-note' }, 'The task group has already attacked this turn. End the turn to plan the next operation.'));
      else { p.appendChild(this.groupPicker()); const row = h('div', { class: 'cp-row' });
        row.appendChild(h('button', { class: 'big', onclick: () => this.launch(s.id, 'attack') }, `ATTACK ${esc(s.name.toUpperCase())}`));
        row.appendChild(h('button', { onclick: () => { if (!this.group.size) return this.toast('Pick the units for the task group first'); const r = C.autoResolve(s.id, 'attack', C.garrison[s.id] || 1, [...this.group]); C.battleFought = true; C.save(); this.group.clear(); this.render(r); } }, 'Auto-resolve'));
        p.appendChild(row); }
    }
    return p;
  }
  attacksPanel() {
    const C = this.C, p = h('div', { class: 'cp-card cp-alert' }, `<div class="cp-card-h">Enemy attacks expected this turn</div>`);
    for (const a of C.pendingAttacks) {
      const s = C.sector(a.to), f = C.sector(a.from);
      const row = h('div', { class: 'cp-att' }, `<div><b>${esc(s.name)}</b> from ${esc(f.name)} · ${['', 'company', 'reinforced company', 'battalion'][a.strength]}</div>`);
      const b = h('div', { class: 'cp-row' });
      b.appendChild(h('button', { class: 'big', onclick: () => this.launch(a.to, 'defend', a) }, 'DEFEND'));
      b.appendChild(h('button', { onclick: () => { const r = C.autoResolve(a.to, 'defend', a.strength, [...this.group]); this.group.clear(); this.render(r); } }, 'Auto-resolve'));
      row.appendChild(b); p.appendChild(row);
    }
    p.appendChild(h('p', { class: 'cp-note' }, 'Pick units in the task group below for the defence; attacks you don\'t answer are fought by whatever is in the sector when you end the turn.'));
    if (!this.sel) p.appendChild(this.groupPicker());
    return p;
  }
  groupPicker() {
    const C = this.C, wrap = h('div', { class: 'cp-group' }, `<div class="cp-sub">Task group for the battle (max ${MAX_GROUP}) — ${this.group.size} picked</div>`);
    for (const u of C.ready()) {
      const on = this.group.has(u.uid), lvl = xpLevel(u.xp);
      const b = h('button', { class: 'cp-unit' + (on ? ' on' : ''), onclick: () => { if (on) this.group.delete(u.uid); else if (this.group.size < MAX_GROUP) this.group.add(u.uid); this.render(); } },
        `<span class="ic">${KIND_ICON[u.kind] || '·'}</span><span class="nm">${esc(u.name)}</span><span class="mn">${u.menMax ? `${u.men}/${u.menMax}` : ''}${u.veh ? ` · ${u.veh.lost ? 'no vehicle' : Math.round(u.veh.hp * 100) + '%'}` : ''}</span><span class="vt v${lvl}">${XP_NAMES[lvl]}</span>`);
      wrap.appendChild(b);
    }
    if (!C.ready().length) wrap.appendChild(h('p', { class: 'cp-note' }, 'No units ready — they are refitting or arriving.'));
    return wrap;
  }
  directivesPanel() {
    const C = this.C, p = h('div');
    if (!C.directives.length) p.appendChild(h('p', { class: 'cp-note' }, 'No active directives. Hold the sector and await orders.'));
    for (const a of C.directives) {
      const d = C.directiveDef(a.id); if (!d) continue; const left = d.deadline - (C.turn - a.issued);
      p.appendChild(h('div', { class: 'cp-card cp-dir' }, `<div class="cp-card-h">${esc(d.title)} <small>${esc(d.from || '')}</small></div><p class="cp-order">${esc(d.text)}</p>
        <div class="cp-kv">Objective: <b>${esc(d.kind)}</b> ${(d.targets || []).map(t => esc(C.sector(t)?.name || t)).join(', ')}${d.count ? ` (${d.kind === 'destroy' ? `${a.progress}/${d.count}` : d.count + ' turns'})` : ''} · ${left > 0 ? `${left} turn${left === 1 ? '' : 's'} left` : 'due now'} · Reward <b>${d.reward?.lp || 0} LP</b>${d.reward?.unlock?.length ? ' + equipment' : ''}</div>`));
    }
    const done = Object.entries(C.doneDirectives);
    if (done.length) p.appendChild(h('div', { class: 'cp-sub' }, `Completed ${done.filter(d => d[1] === 'success').length} · failed ${done.filter(d => d[1] === 'failure').length}`));
    return p;
  }
  forcePanel() {
    const C = this.C, p = h('div');
    for (const u of C.force) {
      const lvl = xpLevel(u.xp), cost = C.replaceCost(u);
      const row = h('div', { class: 'cp-card cp-u' }, `<div class="cp-card-h"><span class="ic">${KIND_ICON[u.kind] || '·'}</span> ${esc(u.name)} <small class="vt v${lvl}">${XP_NAMES[lvl]}</small></div>
        <div class="cp-kv">${u.menMax ? `Men <b>${u.men}/${u.menMax}</b>${u.wounded ? ` (+${u.wounded} wounded, back soon)` : ''} · ` : ''}${u.veh ? `Vehicle <b>${u.veh.lost ? 'destroyed' : Math.round(u.veh.hp * 100) + '%'}</b> · ` : ''}Battles ${u.battles} · Kills ${u.kills} · <b>${u.status === 'ready' ? 'ready' : u.status === 'refit' ? 'refitting' : 'arriving'}</b></div>`);
      if (cost) row.appendChild(h('button', { onclick: () => { const e = C.replenish(u.uid); this.toast(e || `${u.name}: replacements ordered`); this.render(); } }, `Order replacements / repairs — ${cost} LP`));
      p.appendChild(row);
    }
    return p;
  }
  hcPanel() {
    const C = this.C, p = h('div', {}, `<p class="cp-note">Requests to higher command, paid with logistics points. Deliveries take the turns shown.</p>`);
    if (C.orders.length) p.appendChild(h('div', { class: 'cp-card' }, `<div class="cp-card-h">On the way</div>${C.orders.map(o => `<div class="cp-kv">${esc(o.what === 'tech' ? C.techItem(o.key)?.name : C.catalogItem(o.key)?.label)} — ${o.eta} turn${o.eta === 1 ? '' : 's'}</div>`).join('')}`));
    for (const c of C.def.catalog) {
      const ok = C.catalogAvailable(c), locked = !C.available.includes(c.key) || !(c.req || []).every(r => C.unlocked.includes(r));
      const row = h('div', { class: 'cp-card cp-cat' + (locked ? ' locked' : '') }, `<div class="cp-card-h"><span class="ic">${KIND_ICON[c.kind] || '·'}</span> ${esc(c.label)} <small>${c.lp} LP · ${c.eta ?? 1} turn${(c.eta ?? 1) === 1 ? '' : 's'}</small></div><div class="cp-kv">${esc(c.desc || '')}${locked ? ` <i>(needs ${(c.req || []).map(r => esc(C.techItem(r)?.name || r)).join(', ') || 'authorisation'})</i>` : ''}</div>`);
      if (!locked) row.appendChild(h('button', { disabled: ok && C.lp >= c.lp ? null : '', onclick: () => { const e = C.orderUnit(c.key); this.toast(e || `${c.label} ordered`); this.render(); } }, ok ? 'Order' : 'Limit reached'));
      p.appendChild(row);
    }
    return p;
  }
  techPanel() {
    const C = this.C, p = h('div', { class: 'cp-tech' }), branches = [...new Set(C.def.tech.map(t => t.branch))];
    for (const b of branches) {
      const col = h('div', { class: 'cp-branch' }, `<div class="cp-sub">${esc(b)}</div>`);
      for (const t of C.def.tech.filter(x => x.branch === b)) {
        const st = C.unlocked.includes(t.id) ? 'have' : C.orders.some(o => o.key === t.id) ? 'ordered' : C.techAvailable(t.id) ? 'avail' : 'locked';
        const n = h('div', { class: `cp-tn ${st}` }, `<div class="cp-tn-h">${esc(t.name)} <small>${st === 'have' ? '✓' : st === 'ordered' ? 'on the way' : `${t.lp} LP`}</small></div><div class="cp-tn-d">${esc(t.desc || '')}</div>${(t.req || []).length ? `<div class="cp-tn-r">needs ${(t.req || []).map(r => esc(C.techItem(r)?.name || r)).join(', ')}</div>` : ''}`);
        if (st === 'avail') n.appendChild(h('button', { disabled: C.lp >= t.lp ? null : '', onclick: () => { const e = C.orderTech(t.id); this.toast(e || `${t.name} requested`); this.render(); } }, `Request (${t.lp} LP)`));
        col.appendChild(n);
      }
      p.appendChild(col);
    }
    return p;
  }
  logPanel() { const p = h('div', { class: 'cp-log' }); for (const l of this.C.log.slice().reverse()) p.appendChild(h('div', { class: `cp-l ${l.kind || ''}` }, `<span>T${l.turn}</span> ${esc(l.text)}`)); return p; }
  resultModal(r) {
    const C = this.C, s = C.sector(r.sector);
    const m = h('div', { class: 'cp-modal' }, `<div class="cp-modal-in"><div class="kicker">${r.auto ? 'AUTO-RESOLVED' : 'AFTER-ACTION REPORT'} · ${esc(s?.name || '')}</div><h1>${r.win ? (r.mode === 'attack' ? 'SECTOR TAKEN' : 'ATTACK REPULSED') : (r.mode === 'attack' ? 'ATTACK FAILED' : 'SECTOR LOST')}</h1>
      <p>Enemy killed <b>${r.enemyKia}</b> · enemy vehicles destroyed <b>${r.enemyVehLost}</b></p>
      <div class="cp-res">${r.units.map(u => { const f = C.force.find(x => x.uid === u.uid); return `<div>${esc(f?.name || u.uid)}: ${u.alive} fit, ${u.wounded} wounded${u.vehLost ? ', vehicle lost' : ''}${u.kills ? `, ${u.kills} kills` : ''}</div>`; }).join('')}</div><button class="big">CONTINUE</button></div>`);
    $('button', m).onclick = () => m.remove();
    return m;
  }
  launch(sectorId, mode, attack = null) {
    if (!this.group.size) return this.toast('Pick the units for the task group first');
    const setup = this.C.battleSetup(sectorId, [...this.group], mode, attack);
    if (mode === 'attack') this.C.battleFought = true;
    this.C.launch(setup); this.onLaunch?.(setup);
  }
  toast(m) { this.msg = m; }
}

function injectCss() {
  if (document.getElementById('cp-css')) return;
  const css = `
#campaign{position:fixed;inset:0;background:#191b16;color:#e6e2d3;z-index:50;display:flex;flex-direction:column;font-family:inherit;overflow:hidden}
#campaign.hidden{display:none}
.cp-choose{max-width:900px;margin:8vh auto;padding:0 20px}.cp-choose h1{margin:4px 0 10px}.cp-sides{display:flex;gap:16px;margin:24px 0}
.cp-side{flex:1;text-align:left;background:#24271f;border:1px solid #3a3d33;color:#e6e2d3;padding:18px;cursor:pointer;border-radius:4px}.cp-side:hover{border-color:#d0a24a}
.cp-side-k{font-size:11px;letter-spacing:2px;color:#d0a24a}.cp-side-t{font-size:20px;font-weight:700;margin:6px 0}.cp-side-s,.cp-side-r{font-size:13px;color:#a9a593}
.cp-back,.cp-menu{background:none;border:1px solid #4a4d42;color:#bdb8a5;padding:6px 12px;cursor:pointer;border-radius:3px;margin-left:8px}
.cp-top{display:flex;align-items:center;gap:18px;padding:10px 18px;border-bottom:1px solid #33362d;background:#1f211b}.cp-top h2{margin:2px 0 0;font-size:20px}
.cp-stats{display:flex;gap:18px;margin-left:auto}.cp-stats div{display:flex;flex-direction:column;align-items:flex-end}.cp-stats span{font-size:10px;letter-spacing:1.5px;color:#8a877a}.cp-stats b{font-size:18px}.cp-stats .lp{color:#e8c870}
.cp-end{margin-left:10px}
.cp-body{flex:1;display:flex;min-height:0}.cp-map{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;padding:10px}.cp-svg{width:100%;height:100%;max-height:calc(100vh - 90px)}
.cp-sec{cursor:pointer}.cp-sec:hover circle,.cp-sec:hover rect{filter:brightness(1.25)}
.cp-side-panel{width:440px;border-left:1px solid #33362d;display:flex;flex-direction:column;background:#1d1f1a}
.cp-tabs{display:flex;border-bottom:1px solid #33362d}.cp-tabs button{flex:1;background:none;border:none;color:#a9a593;padding:10px 4px;cursor:pointer;font-size:12px;letter-spacing:.5px}.cp-tabs button.on{color:#e8c870;box-shadow:inset 0 -2px #d0a24a}
.cp-pane{flex:1;overflow:auto;padding:12px}
.cp-card{background:#24271f;border:1px solid #34372e;border-radius:4px;padding:10px 12px;margin-bottom:10px}.cp-card-h{font-weight:700;display:flex;gap:8px;align-items:baseline}.cp-card-h small{color:#9c988a;font-weight:400}.cp-x{margin-left:auto;background:none;border:none;color:#aaa;font-size:18px;cursor:pointer}
.cp-alert{border-color:#7a3a30;background:#2a201c}.cp-kv{font-size:13px;color:#bdb8a5;margin-top:4px}.cp-note{font-size:12.5px;color:#9c988a;margin:6px 0}.cp-order{font-size:13px;line-height:1.45;color:#d7d2c0;margin:6px 0;font-family:ui-monospace,monospace;white-space:pre-wrap}
.cp-row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}.cp-card button{background:#33362d;border:1px solid #4a4d42;color:#e6e2d3;padding:6px 10px;border-radius:3px;cursor:pointer;margin-top:6px}.cp-card button.big{background:#7a5a22;border-color:#a8803a}.cp-card button[disabled]{opacity:.45;cursor:default}
.cp-group{margin-top:8px}.cp-sub{font-size:11px;letter-spacing:1.4px;color:#8a877a;text-transform:uppercase;margin:6px 0}
.cp-unit{display:flex;gap:8px;align-items:center;width:100%;background:#2a2d24;border:1px solid #3a3d33;color:#d7d2c0;padding:5px 8px;margin:3px 0;border-radius:3px;cursor:pointer;text-align:left}.cp-unit.on{border-color:#d0a24a;background:#3a3420}
.cp-unit .nm{flex:1}.cp-unit .mn{color:#9c988a;font-size:12px}.ic{width:18px;text-align:center;color:#d0a24a}
.vt{font-size:10px;padding:1px 5px;border-radius:2px;background:#3a3d33;color:#bdb8a5}.vt.v1{background:#3c4a2c}.vt.v2{background:#5a4a20;color:#f0d890}.vt.v3{background:#6a2a20;color:#ffd0b0}
.cp-att{border-top:1px solid #4a3530;padding-top:6px;margin-top:6px}
.cp-cat.locked{opacity:.55}
.cp-tech{display:grid;grid-template-columns:1fr 1fr;gap:10px}.cp-tn{background:#24271f;border:1px solid #34372e;border-radius:4px;padding:8px;margin-bottom:8px;font-size:12.5px}.cp-tn.have{border-color:#5a7a3a;background:#232b1d}.cp-tn.ordered{border-color:#8a7a3a}.cp-tn.locked{opacity:.5}.cp-tn-h{font-weight:700}.cp-tn-h small{font-weight:400;color:#9c988a}.cp-tn-d{color:#bdb8a5;margin-top:3px}.cp-tn-r{color:#8a877a;font-size:11px;margin-top:3px}
.cp-tn button{background:#33362d;border:1px solid #4a4d42;color:#e6e2d3;padding:4px 8px;border-radius:3px;cursor:pointer;margin-top:6px}.cp-tn button[disabled]{opacity:.45}
.cp-log .cp-l{font-size:12.5px;padding:4px 0;border-bottom:1px solid #2a2c25;color:#bdb8a5}.cp-l span{color:#77745f;margin-right:6px}.cp-l.good{color:#a8c88a}.cp-l.bad{color:#e09080}.cp-l.directive{color:#e8d27a}
.cp-toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#2e3127;border:1px solid #5a5d50;padding:8px 14px;border-radius:4px;z-index:60}
.cp-modal{position:fixed;inset:0;background:rgba(10,11,9,.7);display:flex;align-items:center;justify-content:center;z-index:70}.cp-modal-in{background:#1f211b;border:1px solid #44473c;padding:24px 30px;max-width:620px;border-radius:6px}.cp-res{font-size:13px;color:#bdb8a5;margin:10px 0 16px;line-height:1.6}
`;
  document.head.appendChild(Object.assign(document.createElement('style'), { id: 'cp-css', textContent: css }));
}
