// Campaign v2 strategic screen: the 3D grid map (map3d.js) with the HTML command interface around it — date / turn /
// LP bar, directives, task forces (select, move, attack, split, merge, stance), high command (catalog, replacements,
// tech tree, depots), the operations log, enemy attack warnings, battle launch / return, and the intro cutscene.
import { Campaign2, xpLevel, XP_NAMES, MAX_BATTLE, dateLabel } from './state.js';
import { loadCampaigns } from './index.js';
import { StrategicMap, natoSvg, echelon, COL } from './map3d.js';
import { playIntroMusic, primeAudio, blip } from './audio.js';
import { Tour, tutorialState } from './tutorial.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KITS, TIERS, tierOf, linesOf, branchesOf, techState, lineState, kitsOwned, layoutRow, effectLines } from './tech.js';
import { attachKits } from '../../game/vehicleKit.js';

const Q = new URLSearchParams(location.search);
const h = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v); } if (html) e.innerHTML = html; return e; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = v => (Math.round(v * 10) / 10).toString();
const STRENGTH = ['—', 'company', 'reinforced company', 'battalion'];
const TERRAIN = { fields: 'Open fields', forest: 'Woods', urban: 'Town', industrial: 'Industrial zone', village: 'Village', water: 'Water', heights: 'Heights', balka: 'Balka (gully)' };
const KIND = { mech: 'Mech. infantry', imech: 'Mech. infantry (IFV)', assault: 'Assault infantry', tank: 'Tank', atgm: 'ATGM team', fpv: 'FPV drone team', spg: 'Self-propelled gun', replacements: 'Replacements' };
const KIND_ICON = { mech: '⊠', imech: '⊠', assault: '✕', tank: '⬭', atgm: '△', fpv: '≈', spg: '●', replacements: '+' };

export async function openCampaign2(onLaunch) {
  injectCss();
  document.getElementById('menu')?.classList.add('hidden');
  let root = document.getElementById('c2'); if (!root) { root = h('div', { id: 'c2' }); document.body.appendChild(root); }
  root.classList.remove('hidden'); root.innerHTML = '<div class="c2-boot">LOADING THE OPERATIONAL PICTURE…</div>';
  const { defs, test } = await loadCampaigns();
  let C = Campaign2.load(defs);
  const res = Campaign2.takeResult();
  let applied = null, interrupted = null;
  if (C && res) { try { applied = C.applyResult(res) || res; } catch (e) { console.error(e); } }
  else if (C?.battle) { interrupted = Campaign2.pendingBattle(); if (!interrupted || interrupted.sector !== C.battle.cell) { interrupted = null; C.cancelBattle(); } }
  const pre = Q.get('cside');
  if (pre && defs[pre]) { C = new Campaign2(defs[pre]); for (let i = +(Q.get('cadvance') || 0); i > 0 && !C.outcome(); i--) C.endTurn(); C.save(); return start(root, C, onLaunch, { intro: !Q.has('nointro'), test }); }   // cadvance: headless preview of a later week
  if (!C) { chooseSide(root, defs, test, def => { primeAudio(); const c = new Campaign2(def); c.save(); start(root, c, onLaunch, { intro: true, test }); }); window.__done = true; return; }
  // a campaign whose intro was never watched to the end (reload during the cutscene) gets it again
  start(root, C, onLaunch, { result: applied, interrupted, test, intro: !C.introSeen && C.turn === 1 && !C.stats.battles && !applied && !interrupted });
}

async function start(root, C, onLaunch, opts) {
  const get = u => fetch(u).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const X = C.baseDef?.aor?.ext || C.def.aor.ext;
  const [osm, geo, osmX, geoX] = await Promise.all([get(new URL(`./data/osm_${C.def.mapId || C.def.id}.json`, import.meta.url)), C.def.aor.geo ? get(C.def.aor.geo) : null,
    X?.osm ? get(new URL(`./data/${X.osm}.json`, import.meta.url)) : null, X?.geo ? get(X.geo) : null]);
  // v5: the OSM data of the grid extension (drawn once the grid has grown over it) joins the main extracts
  const join = (a, b) => { if (!a || !b) return a || b; const o = { ...a }; for (const [k, v] of Object.entries(b)) if (Array.isArray(v) && Array.isArray(a[k])) o[k] = [...a[k], ...v]; return o; };
  if (osm && osmX) Object.assign(osm, join(osm, { ...osmX, patches: [] }));
  if (geo && geoX) geo.geo = join(geo.geo, geoX.geo);
  const ui = new CampaignScreen(root, C, onLaunch, osm, opts, geo); window.__c2 = ui;
  return ui;
}
// versus (net/versus_ui.js): the command screen for one side of a shared game, in the #c2 root
export async function openScreen(C, opts) {
  injectCss(); document.getElementById('menu')?.classList.add('hidden');
  let root = document.getElementById('c2'); if (!root) { root = h('div', { id: 'c2' }); document.body.appendChild(root); }
  root.classList.remove('hidden'); root.innerHTML = '<div class="c2-boot">LOADING THE OPERATIONAL PICTURE…</div>';
  return start(root, C, null, opts);
}

function chooseSide(root, defs, test, done) {
  root.innerHTML = '';
  const box = h('div', { class: 'c2-choose' }, `<div class="kicker">CAMPAIGN · FEBRUARY 2023 – MARCH 2024</div><h1>Brigade area of responsibility</h1>
    <p class="brief">Command one brigade's sector of the front, week by week, from the first anniversary of the invasion to the spring of 2024. Split your brigade into task forces, move them across the grid, attack enemy-held squares and towns, keep them supplied, and spend the logistics points your battles earn on replacements, new units and equipment from high command. Higher command sends the directives; the rest of the front moves as it really did.</p>${test ? '<p class="c2-note">Running on the built-in test campaigns (the researched campaign content is not installed yet).</p>' : ''}`);
  const row = h('div', { class: 'c2-sides' });
  for (const def of Object.values(defs)) row.appendChild(h('button', { class: `c2-side ${def.id}`, onclick: () => done(def) }, `<div class="c2-side-k">${def.id === 'UA' ? 'UKRAINE' : 'RUSSIA'}</div><div class="c2-side-t">${esc(def.intro?.place || def.aor?.name || def.title)}</div><div class="c2-side-s">${esc(def.brigade?.name || '')}</div><div class="c2-side-r">${esc(def.title)} · ${esc(def.region || '')}</div>`));
  box.appendChild(row);
  box.appendChild(h('button', { class: 'c2-btn', onclick: () => { location.href = location.pathname; } }, 'Back'));
  root.appendChild(box);
}

export class CampaignScreen {
  constructor(root, C, onLaunch, osm, opts = {}, geo = null) {
    this.root = root; this.C = C; this.onLaunch = onLaunch; this.tab = 'dir'; this.sel = null; this.selCell = null; this.pick = new Set(); this.opts = opts; this.vs = opts.vs || null;
    root.classList.toggle('vs', !!this.vs);
    root.innerHTML = '';
    this.mapEl = h('div', { class: 'c2-map' }); root.appendChild(this.mapEl);
    this.osm = osm; this.geo = geo;
    this.map = new StrategicMap(this.mapEl, C, osm, geo);
    this.map.viewOffset = 190; this.map.resize();   // keep the camera's centre in the part of the screen the side panel leaves free
    this.map.on = { select: id => this.select(id), cell: id => this.clickCell(id), order: (id, tfId) => this.order(id, tfId), hover: id => this.hoverCell(id), regrid: () => this.regrid() };
    this.top = h('div', { class: 'c2-top' }); this.left = h('div', { class: 'c2-left' }); this.right = h('div', { class: 'c2-right hidden' });
    this.bottom = h('div', { class: 'c2-bottom' }); this.toastEl = h('div', { class: 'c2-toast' });
    this.goalEl = h('div', { class: 'c2-goal' });
    root.append(this.top, this.left, this.right, this.bottom, this.toastEl, this.goalEl);
    this.onKey = e => this.key(e); window.addEventListener('keydown', this.onKey);
    this.lastLog = C.log.length;
    this.render();
    if (opts.intro) this.intro();
    else {
      this.map.jump(this.map.view('front'));
      // headless previews: &cview=theatre|aor|front or &ccell=<cellId>&cdist=<km>&cyaw=&cpitch=
      if (Q.get('cview')) this.map.jump(this.map.view(Q.get('cview')));
      if (Q.get('ccell') && C.cell(Q.get('ccell'))) { const p = this.map.cellCenter(Q.get('ccell')); this.map.jump({ x: p.x, z: p.z, dist: +(Q.get('cdist') || 6), yaw: +(Q.get('cyaw') || 0.3), pitch: +(Q.get('cpitch') || 0.75) }); }
      if (Q.get('csel')) { const f = C.forces[+Q.get('csel')]; if (f) this.select(f.id); }
      if (opts.result) this.resultModal(opts.result, () => this.checkOutcome());
      else if (opts.interrupted) this.interruptedModal(opts.interrupted);
      else this.checkOutcome();
      // reloaded after the intro but before the tour offer was answered: offer it again (first week only)
      if (!this.vs && C.turn === 1 && !opts.result && !opts.interrupted && !Q.has('cside')) this.offerTutorial();
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__done = true; }));
    }
  }
  // every change to the campaign goes through here: single player calls the campaign directly, versus hands the
  // command to the session (applied at once, and by the host for the joiner)
  act(name, ...args) {
    const r = this.vs ? this.vs.act(name, args) : this.C[name](...args);
    // the counters in the top bar and the tabs (LP, forces, orders) follow every change, not just the panel clicked
    if (typeof r !== 'string') { this.renderTop(); this.renderLeft(); }
    return r;
  }
  // v5: the grid has grown past the original AOR (growth.js): the 3D map is rebuilt over the larger extent, the camera
  // keeps its place and then glides to the new squares
  regrid() {
    const old = this.map, cam = { ...old.tcam }, vo = old.viewOffset, on = old.on, sup = old.showSupply, tgt = old.targeting;
    old.dispose();
    this.map = new StrategicMap(this.mapEl, this.C, this.osm, this.geo);
    this.map.viewOffset = vo; this.map.on = on; this.map.showSupply = sup; this.map.resize(); this.map.jump(cam);
    if (tgt) this.map.setTargeting(tgt);
    const g = this.C.lastGrowth;
    if (g && g.turn >= this.C.turn - 1 && g.cells?.length && !this.opts?.noFly) {
      const ps = g.cells.map(id => this.map.cellCenter(id)), x = ps.reduce((a, p) => a + p.x, 0) / ps.length, z = ps.reduce((a, p) => a + p.z, 0) / ps.length;
      this.map.flyTo({ x: (x + cam.x) / 2, z: (z + cam.z) / 2, dist: Math.max(cam.dist, 22), yaw: cam.yaw, pitch: 0.95 }, 1.4);
      this.toast(`The map extends: ${g.name}`, true);
    }
    this.map.refresh(); this.select(this.sel && this.C.tf(this.sel) ? this.sel : null);
  }
  // versus: a new authoritative state for this side (from the host)
  setCampaign(C) {
    const sel = this.sel; this.C = C; this.map.C = C; if (this.tut) this.tut.C = C;
    this.map.refresh(); this.render(); this.select(sel && C.tf(sel) ? sel : null);
  }
  // ------------------------------------------------------------------ top / bottom bars
  render() { this.renderTop(); this.renderLeft(); this.renderRight(); this.renderBottom(); this.renderGoal(); }
  renderTop() {
    const C = this.C, D = C.def, wk = Math.min(C.turn, C.maxTurn);
    this.top.innerHTML = `<div class="c2-id"><div class="c2-k">${esc([D.brigade?.short || D.brigade?.name, D.region].filter(Boolean).join(' · '))}</div><div class="c2-t">${esc(D.intro?.place || D.aor.name)}</div></div>
      <div class="c2-date"><div class="c2-d">${esc(dateLabel(C.date, true).toUpperCase())}</div><div class="c2-k">WEEK ${wk} OF ${C.maxTurn} · <span class="c2-season">${seasonName(C.date)}</span></div><div class="c2-prog"><i style="width:${(100 * (wk - 1) / Math.max(1, C.maxTurn - 1)).toFixed(1)}%"></i></div></div>
      <div class="c2-stats"><div><span>LP</span><b class="lp">${C.lp}</b></div><div><span>PER WEEK</span><b>+${C.lpIncome()}</b></div><div><span>BATTLES</span><b>${C.stats.won}/${C.stats.battles}</b></div><div><span>GRID HELD</span><b>${this.held()}</b></div></div>`;
    if (this.vs) this.top.appendChild(h('div', { class: 'c2-vs ' + (this.vs.statusKind?.() || '') }, this.vs.status()));
    const end = h('button', { class: 'c2-end' + (this.vs?.isReady?.() ? ' wait' : ''), title: this.vs ? (this.vs.isReady() ? 'Click to change your orders' : 'Finish planning: the week is carried out when both commanders have ended it') : 'End the week (Enter)', onclick: () => this.endTurn(true) }, this.vs ? this.vs.endLabel() : C.outcome() ? 'CAMPAIGN OVER ▸' : 'END WEEK ▸'); this.top.appendChild(end);
    const menu = h('div', { class: 'c2-menu' });
    if (this.vs) { menu.appendChild(h('button', { class: 'c2-btn c2-helpbtn', title: 'How to play: the guided tour (F1)', 'aria-label': 'Help: guided tour', onclick: () => this.tutorial() }, '?')); menu.appendChild(h('button', { class: 'c2-btn', title: 'Leave the versus game (the host can resume it later)', onclick: () => this.vs.leave() }, 'Leave')); this.top.appendChild(menu); return; }
    menu.appendChild(h('button', { class: 'c2-btn c2-helpbtn', title: 'How to play: the guided tour (F1)', 'aria-label': 'Help: guided tour', onclick: () => this.tutorial() }, '?'));
    menu.appendChild(h('button', { class: 'c2-btn', title: 'Back to the main menu (the campaign is saved)', onclick: () => { location.href = location.pathname; } }, 'Menu'));
    menu.appendChild(h('button', { class: 'c2-btn', title: 'Abandon this campaign', onclick: () => { if (confirm('Abandon this campaign? All progress will be lost.')) { Campaign2.clear(); location.href = location.pathname + '?campaign=1'; } } }, 'Abandon'));
    this.top.appendChild(menu);
  }
  held() { const C = this.C, cells = C.def.aor.cells; return `${cells.filter(c => C.owner[c.id] === 'player').length}/${cells.length}`; }
  renderBottom() {
    this.bottom.innerHTML = '';
    const views = h('div', { class: 'c2-views' });
    for (const [k, l] of [['front', 'Task forces'], ['aor', 'Sector'], ['theatre', 'Whole front']]) views.appendChild(h('button', { class: 'c2-btn', onclick: () => this.map.flyTo(this.map.view(k), 1.4) }, l));
    views.appendChild(h('button', { class: 'c2-btn c2-supply' + (this.map.showSupply ? ' on' : ''), title: 'Supply overlay (L)', 'aria-pressed': this.map.showSupply ? 'true' : 'false', onclick: () => this.toggleSupply() }, 'Supply'));
    this.bottom.appendChild(views);
    this.bottom.appendChild(h('div', { class: 'c2-help' }, `<b>Left-click</b> select · <b>Right-click</b> move / attack · <b>WASD</b>/drag/edges pan · <b>wheel</b> zoom · <b>Q/E</b> or right-drag rotate · <b>Tab</b> next task force · <b>Esc</b> deselect · <b>Enter</b> end week`));
  }
  toggleSupply() { this.map.showSupply = !this.map.showSupply; this.map.refresh(); this.renderBottom(); }
  // ------------------------------------------------------------------ left panel: tabs
  renderLeft() {
    const C = this.C, keep = this.left.querySelector('.c2-pane'), scroll = keep && this.leftTab === `${this.tab}/${this.hcTab}` ? keep.scrollTop : 0;   // re-renders keep the list where it was
    this.leftTab = `${this.tab}/${this.hcTab}`; this.left.innerHTML = '';
    const tabs = h('div', { class: 'c2-tabs' });
    const nAtt = C.pendingAttacks.length;
    for (const [k, l] of [['dir', `Directives${C.directives.length ? ` <i>${C.directives.length}</i>` : ''}`], ['tf', `Forces <i>${C.forces.length}</i>`], ['ops', 'Fires · UAV'], ['hc', 'High command'], ['log', 'Log']]) tabs.appendChild(h('button', { class: this.tab === k ? 'on' : '', onclick: () => { this.tab = k; this.renderLeft(); } }, l));
    this.left.appendChild(tabs);
    const pane = h('div', { class: 'c2-pane' });
    if (nAtt) pane.appendChild(this.attacksCard());
    pane.appendChild(({ dir: () => this.directivesPane(), tf: () => this.forcesPane(), ops: () => this.opsPane(), hc: () => this.hcPane(), log: () => this.logPane() })[this.tab]());
    this.left.appendChild(pane); if (scroll) pane.scrollTop = scroll;
  }
  attacksCard() {
    const C = this.C, card = h('div', { class: 'c2-card c2-alert' }, `<div class="c2-ch">ENEMY ATTACKS EXPECTED</div><div class="c2-note">Intelligence reports attacks being prepared. Move a task force into the threatened square to fight the defence yourself; otherwise the line battalions hold it alone when the week ends.</div>`);
    for (const a of C.pendingAttacks) {
      const own = C.forcesAt(a.to);
      const row = h('div', { class: 'c2-att' }, `<div><b>${esc(cellRef(C, a.to))}</b> ← ${esc(C.cellName(a.from))}<br><small>${STRENGTH[a.strength]} · ${own.length ? `defended by ${own.map(f => esc(f.name)).join(', ')}` : 'line battalions only'}</small></div>`);
      const b = h('div', { class: 'c2-row' });
      b.appendChild(h('button', { class: 'c2-btn', onclick: () => { this.map.flyTo({ ...this.map.cellCenter(a.to), dist: 9 }, 1); this.clickCell(a.to); } }, 'Show'));
      if (own.length) { b.appendChild(h('button', { class: 'c2-btn pri', title: 'Fight the defence on the RTS battle map', onclick: () => this.fightDefence(a) }, 'Fight defence')); b.appendChild(h('button', { class: 'c2-btn', title: 'Let the staff resolve the defence now', onclick: () => this.autoDefence(a) }, 'Auto-resolve')); }
      row.appendChild(b); card.appendChild(row);
    }
    return card;
  }
  directivesPane() {
    const C = this.C, p = h('div');
    if (!C.directives.length) p.appendChild(h('div', { class: 'c2-note' }, 'No active directives. Hold the sector and prepare; higher command will issue new orders.'));
    for (const a of C.directives) {
      const d = C.directiveDef(a.id); if (!d) continue; const st = C.directiveStatus(a);
      const card = h('div', { class: 'c2-card dir' }, `<div class="c2-ck">${esc(d.from || 'Higher command')} · issued ${esc(dateLabel(a.issuedDate))}</div><div class="c2-ch">${esc(d.title)}</div><div class="c2-order">${esc(d.text || '')}</div>
        <div class="c2-kv"><span>${esc(kindLabel(d.kind))}</span><b>${esc(st.txt)}</b></div><div class="c2-kv"><span>Deadline</span><b class="${st.weeksLeft <= 1 ? 'warn' : ''}">${esc(dateLabel(a.deadline))} (${st.weeksLeft ? `${st.weeksLeft} wk` : 'this week'})</b></div><div class="c2-kv"><span>Reward</span><b>${d.reward?.lp || 0} LP${d.reward?.units?.length ? ` + ${d.reward.units.length} unit(s)` : ''}${d.reward?.unlock?.length ? ' + equipment' : ''}</b></div>`);
      const tg = h('div', { class: 'c2-row' }); for (const t of d.targets || []) tg.appendChild(h('button', { class: 'c2-chip' + (C.owner[t] === 'player' ? ' ok' : ''), onclick: () => { this.map.flyTo({ ...this.map.cellCenter(t), dist: 8 }, 1); this.clickCell(t); } }, `${esc(cellRef(C, t))}`));
      card.appendChild(tg); p.appendChild(card);
    }
    const hist = (C.history || []).slice().reverse();
    if (hist.length) { p.appendChild(h('div', { class: 'c2-sub' }, 'Completed directives')); for (const x of hist) { const d = C.directiveDef(x.id); p.appendChild(h('div', { class: 'c2-card done ' + (x.ok ? 'ok' : 'bad') }, `<div class="c2-ch">${x.ok ? '✓' : '✗'} ${esc(d?.title || x.id)} <small>${esc(dateLabel(x.date))}</small></div>${d?.history ? `<div class="c2-hist"><b>What really happened:</b> ${esc(d.history)}</div>` : ''}`)); } }
    return p;
  }
  forcesPane() {
    const C = this.C, p = h('div');
    p.appendChild(h('div', { class: 'c2-note' }, 'Select a task force, then right-click a square to move or an enemy square to attack. Movement points depend on the slowest unit (foot 2, tracked 3, wheeled 4); roads are cheap, woods, towns and rivers expensive.'));
    for (const f of C.forces) {
      const us = C.tfUnits(f), mx = C.tfMpMax(f);
      const card = h('div', { class: 'c2-card tf' + (f.id === this.sel ? ' sel' : ''), onclick: () => { this.select(f.id); this.map.flyTo({ ...this.map.cellCenter(f.cell), dist: Math.min(this.map.cam.dist, 14) }, 0.8); } },
        `<div class="c2-tfh">${natoSvg(us, 34, 24)}<div><div class="c2-ch">${esc(f.name)} <small>${echelon(us.length)}</small></div><div class="c2-ck">${esc(cellRef(C, f.cell))} · ${us.length} units · ${f.stance}</div></div></div>
        <div class="c2-kv"><span>Movement</span><b>${fmt(f.mp)}/${mx} MP${f.attacked ? ' · attacked' : ''}</b></div><div class="c2-kv"><span>Supply</span><b class="${(f.supply ?? 1) >= 1 ? 'good' : (f.supply ?? 1) > 0 ? 'warn' : 'bad'}">${(f.supply ?? 1) >= 1 ? 'in supply' : (f.supply ?? 1) > 0 ? 'stretched' : 'OUT OF SUPPLY'}</b></div><div class="c2-kv"><span>Combat power</span><b>${fmt(C.tfPower(f))}</b></div>`);
      p.appendChild(card);
    }
    return p;
  }
  hcPane() {
    const C = this.C, p = h('div');
    p.appendChild(h('div', { class: 'c2-note' }, `Requests to high command are paid with logistics points (LP: ${C.lp}). Units arrive at brigade HQ (${esc(C.cellName(C.deliveryCell()))}) after the weeks shown; equipment and doctrine unlock when delivered. Some deliveries are only possible from a historical date.`));
    if (C.orders.length) p.appendChild(h('div', { class: 'c2-card' }, `<div class="c2-ch">On the way</div>${C.orders.map(o => `<div class="c2-kv"><span>${esc(o.what === 'tech' ? C.techItem(o.key)?.name : C.catalogItem(o.key)?.label)}</span><b>${o.eta} wk</b></div>`).join('')}`));
    const sub = h('div', { class: 'c2-subtabs' });
    this.hcTab ||= 'units';
    for (const [k, l] of [['units', 'Units'], ['repl', 'Replacements'], ['tech', 'Tech tree']]) sub.appendChild(h('button', { class: this.hcTab === k ? 'on' : '', onclick: () => { this.hcTab = k; this.renderLeft(); } }, l));
    p.appendChild(sub);
    if (this.hcTab === 'units') for (const c of C.def.catalog) {
      const unlocked = C.available.includes(c.key) && (c.req || []).every(r => C.unlocked.includes(r)), dateOk = C.dateOk(c), ok = C.catalogAvailable(c), cost = C.unitCost(c);
      const row = h('div', { class: 'c2-card cat' + (unlocked ? '' : ' locked') }, `<div class="c2-ch"><span class="ic">${KIND_ICON[c.kind] || '·'}</span> ${esc(c.label)} <small>${cost} LP · ${c.eta ?? 1} wk</small></div><div class="c2-ck">${esc(KIND[c.kind] || c.kind)}${c.men ? ` · ${c.men} men` : ''}${c.vehicle ? ` · ${c.vehicle.toUpperCase()}` : ''}</div><div class="c2-desc">${esc(c.desc || '')}</div>${!unlocked ? `<div class="c2-req">Needs ${(c.req || []).map(r => esc(C.techItem(r)?.name || r)).join(', ') || 'authorisation from high command'}</div>` : !dateOk ? `<div class="c2-req">Available from ${esc(dateLabel(c.date))}</div>` : ''}`);
      if (unlocked && dateOk) row.appendChild(h('button', { class: 'c2-btn pri', disabled: !ok || C.lp < cost, onclick: () => { const e = this.act('orderUnit', c.key); this.toast(e || `${c.label} ordered`, !e); this.render(); } }, ok ? `Order (${cost} LP)` : 'Limit reached'));
      p.appendChild(row);
    }
    if (this.hcTab === 'repl') {
      const units = C.units.filter(u => C.replaceCost(u) > 0);
      if (!units.length) p.appendChild(h('div', { class: 'c2-note' }, 'All units are at full strength.'));
      for (const u of units) { const tf = C.tfOf(u.uid), cost = C.replaceCost(u); const row = h('div', { class: 'c2-card' }, `<div class="c2-ch"><span class="ic">${KIND_ICON[u.kind] || '·'}</span> ${esc(u.name)} <small>${esc(tf?.name || '')}</small></div><div class="c2-ck">${u.menMax ? `${u.men}/${u.menMax} men${u.wounded ? ` (+${u.wounded} wounded)` : ''}` : ''}${u.veh ? ` · vehicle ${u.veh.lost ? 'destroyed' : Math.round(u.veh.hp * 100) + '%'}` : ''}</div>`);
        row.appendChild(h('button', { class: 'c2-btn pri', disabled: C.lp < cost || (tf && (tf.supply ?? 1) < 0.5), onclick: () => { const e = this.act('replenish', u.uid); this.toast(e || `${u.name}: replacements on the way`, !e); this.render(); this.map.refresh(); } }, (tf && (tf.supply ?? 1) < 0.5) ? 'Out of supply' : `Replenish (${cost} LP)`)); p.appendChild(row); }
    }
    if (this.hcTab === 'tech') {
      const owned = kitsOwned(C), lines = linesOf(C);
      const card = h('div', { class: 'c2-card c2-ttsum' }, `<div class="c2-ch">Equipment and doctrine</div><div class="c2-note">Vehicle lines with their field upgrades (cope cages, ERA, sandbags, sights, jammers, smoke) and the support branches. Upgrades change how the vehicles fight and look on the battle map.</div>
        ${lines.map(L => { const st = lineState(C, L); const ks = owned[L.vk] || []; return `<div class="c2-kv"><span>${esc(L.name)}</span><b class="${st === 'have' ? '' : 'warn'}">${st === 'have' ? (ks.length ? ks.map(k => esc(KITS[k].short)).join(' · ') : 'no upgrades') : st === 'date' ? `from ${esc(dateLabel(L.date || C.techItem(L.tech)?.date))}` : st === 'ordered' ? 'on the way' : 'not in service'}</b></div>`; }).join('')}
        <div class="c2-kv"><span>Available to request now</span><b class="lp">${C.def.tech.filter(t => techState(C, t) === 'avail').length}</b></div>`);
      card.appendChild(h('button', { class: 'c2-btn pri c2-ttopen', title: 'Open the tech tree (T)', onclick: () => this.techTree() }, 'OPEN TECH TREE ▸'));
      p.appendChild(card);
    }
    return p;
  }
  logPane() {
    const p = h('div', { class: 'c2-log' }); let last = null;
    for (const l of this.C.log.slice().reverse()) { if (l.date !== last) { p.appendChild(h('div', { class: 'c2-logd' }, esc(dateLabel(l.date)))); last = l.date; } p.appendChild(h('div', { class: `c2-l ${l.kind || ''}` }, esc(l.text))); }
    return p;
  }
  // ------------------------------------------------------------------ right panel: selection
  renderRight() {
    const C = this.C; this.right.innerHTML = '';
    const tf = this.sel && C.tf(this.sel);
    if (!tf && !this.selCell) { this.right.classList.add('hidden'); return; }
    this.right.classList.remove('hidden');
    if (tf) this.right.appendChild(this.tfCard(tf));
    const cell = this.selCell || tf?.cell; if (cell) this.right.appendChild(this.cellCard(cell));
  }
  tfCard(f) {
    const C = this.C, us = C.tfUnits(f), mx = C.tfMpMax(f), here = C.forcesAt(f.cell).filter(x => x !== f);
    const card = h('div', { class: 'c2-card tfsel' });
    card.innerHTML = `<div class="c2-tfh">${natoSvg(us, 44, 31)}<div style="flex:1"><div class="c2-ch lg">${esc(f.name)}</div><div class="c2-ck">${esc(cellRef(C, f.cell))}${f.reserve ? ' · brigade reserve' : ''}</div></div><button class="c2-x" title="Deselect (Esc)">×</button></div>
      <div class="c2-mp">${Array.from({ length: Math.ceil(mx) }, (_, i) => `<i class="${f.mp >= i + 1 - 1e-6 ? 'on' : f.mp > i + 1e-6 ? 'half' : ''}"></i>`).join('')}<span>${fmt(f.mp)} / ${mx} MP${f.attacked ? ' · has attacked' : ''}</span></div>
      <div class="c2-kv"><span>Supply</span><b class="${(f.supply ?? 1) >= 1 ? 'good' : (f.supply ?? 1) > 0 ? 'warn' : 'bad'}">${(f.supply ?? 1) >= 1 ? 'in supply' : (f.supply ?? 1) > 0 ? 'stretched — at the end of the supply line' : 'OUT OF SUPPLY: half movement, no replacements, battle penalties'}</b></div>${(() => { const sp = C.spotStatus?.(f.id); if (!sp) return '';
        return `<div class="c2-kv" title="Big formations give themselves away: a signature of ${sp.size}+ (companies, +1 moving, +1 attacking, −1 still in a town or woods) is seen by the enemy without recon — bigger is seen deeper behind the line"><span>Signature</span><b class="${sp.spotted ? 'bad' : sp.sig >= sp.size ? 'warn' : 'good'}">${sp.n} coy · ${sp.sig}${sp.spotted ? ` — SPOTTED (seen ${sp.depth} sq. deep)` : sp.sig >= sp.size ? ` — would be seen within ${sp.depth} sq. of the line` : ' — hidden'}</b></div>`; })()}`;
    card.querySelector('.c2-x').onclick = () => this.select(null);
    if (f.planned) { const pl = h('div', { class: 'c2-plan' }, `<span>⚔ Attack planned: <b>${esc(cellRef(C, f.planned.cell))}</b>${f.planned.auto ? ' (staff-resolved)' : ''}</span>`); pl.appendChild(h('button', { class: 'c2-btn', onclick: () => { const e = this.act('cancelAttack', f.id); if (e) this.toast(e, false); this.select(f.id); } }, 'Call off')); card.appendChild(pl); }
    const st = h('div', { class: 'c2-seg' });
    for (const [k, l, t] of [['attack', 'Ready', 'Ready to move and attack'], ['hold', 'Dig in', 'Hold: improves the square’s fortifications if it does not move'], ['rest', 'Rest', 'Rest and repair: vehicles repaired, wounded return faster (in supply, not moving)']]) st.appendChild(h('button', { class: f.stance === k ? 'on' : '', title: t, onclick: () => { this.act('setStance', f.id, k); this.render(); this.map.refresh(); } }, l));
    card.appendChild(st);
    const list = h('div', { class: 'c2-units' });
    for (const u of us) {
      const lvl = xpLevel(u.xp), on = this.pick.has(u.uid);
      const row = h('label', { class: 'c2-unit' + (on ? ' on' : '') + (C.combatReady(u) ? '' : ' nr') }, `<input type="checkbox" ${on ? 'checked' : ''}><span class="ic">${KIND_ICON[u.kind] || '·'}</span><span class="nm">${esc(u.name)}<small>${u.menMax ? `${u.men}/${u.menMax}${u.wounded ? ` +${u.wounded}w` : ''}` : ''}${u.veh ? ` · ${u.veh.lost ? 'no vehicle' : `<span class="hp"><i style="width:${Math.round(u.veh.hp * 100)}%"></i></span>`}` : ''}${u.status !== 'ready' ? ` · ${u.status === 'refit' ? 'refitting' : 'arriving'}` : ''}</small></span><span class="vt v${lvl}" title="${u.battles} battles, ${u.kills} kills">${XP_NAMES[lvl]}</span>`);
      row.querySelector('input').onchange = e => { if (e.target.checked) this.pick.add(u.uid); else this.pick.delete(u.uid); this.renderRight(); };
      list.appendChild(row);
    }
    card.appendChild(list);
    const acts = h('div', { class: 'c2-row c2-acts' });
    const picked = [...this.pick].filter(id => f.units.includes(id));
    acts.appendChild(h('button', { class: 'c2-btn', disabled: !picked.length || picked.length >= f.units.length, title: 'Detach the ticked units into a new task force on this square', onclick: () => { const r = this.act('split', f.id, picked); if (typeof r === 'string') return this.toast(r, false); this.pick.clear(); this.select(r.id); this.toast(`${r.name} detached`); } }, `Split off ${picked.length || ''}`.trim()));
    for (const o of here) acts.appendChild(h('button', { class: 'c2-btn', title: `Combine ${o.name} and ${f.name} into one task force`, onclick: () => {
      const [into, from] = (o.units.length > f.units.length || (o.units.length === f.units.length && C.forces.indexOf(o) < C.forces.indexOf(f))) ? [o, f] : [f, o];   // the larger / older force keeps its name
      const r = this.act('merge', into.id, from.id); if (typeof r === 'string') return this.toast(r, false); this.toast(`${from.name} combined into ${into.name}`); this.select(into.id); } }, `Merge ${esc(o.name)}`));
    acts.appendChild(h('button', { class: 'c2-btn', onclick: () => { const n = prompt('Task force name', f.name); if (n) { this.act('rename', f.id, n); this.render(); this.map.refresh(); } } }, 'Rename'));
    card.appendChild(acts);
    card.appendChild(h('div', { class: 'c2-note' }, here.length ? 'Other task forces share this square: merge them for a stronger attack.' : 'Tick units and split them off to send detachments to different squares; move task forces onto one square and merge them for a larger force.'));
    return card;
  }
  cellCard(id) {
    const C = this.C, c = C.cell(id); if (!c) return h('div');
    const o = C.owner[id], known = C.known(id), sup = C.supplied[id] ?? 0;
    const card = h('div', { class: 'c2-card cell' }, `<div class="c2-ck">GRID ${C.gridRef(id)} · ${esc(TERRAIN[c.terrain] || c.terrain)}</div><div class="c2-ch lg">${esc(C.cellName(id))}</div>
      <div class="c2-kv"><span>Control</span><b class="${o === 'player' ? 'own' : o === 'contested' ? 'warn' : 'bad'}">${o === 'player' ? 'own' : o === 'contested' ? 'contested' : 'enemy'}</b></div>
      ${c.settlement ? `<div class="c2-kv"><span>Settlement</span><b>${esc(c.settlement.name)} (${esc(c.settlement.kind)})</b></div>` : ''}
      <div class="c2-kv"><span>Roads</span><b>${['none (cross-country)', 'local road', 'paved highway'][c.road || 0]}${c.river ? (c.bridge ? ' · river (bridge)' : ' · river (no bridge)') : ''}</b></div>
      <div class="c2-kv"><span>Fortifications</span><b>${(o === 'player' || known) ? ['none', 'trenches', 'dug in', 'fortified line'][C.fort[id] || 0] : 'unknown'}</b></div>
      ${o !== 'player' ? `<div class="c2-kv"><span>Enemy strength</span><b>${known ? STRENGTH[Math.max(1, Math.min(3, Math.round(C.garrison[id] || 1)))] : 'unknown — reconnoitre'}</b></div>` : `<div class="c2-kv"><span>Supply</span><b class="${sup >= 1 ? 'good' : sup > 0 ? 'warn' : 'bad'}">${sup >= 1 ? 'in supply' : sup > 0 ? 'stretched' : 'cut off'}</b></div>`}
      ${(() => { const sp = (C.spottedEnemy?.() || []).filter(f => f.cell === id); return sp.length ? `<div class="c2-kv"><span>Spotted</span><b class="bad">${sp.map(f => `${esc(f.name)} (~${f.n} coy)`).join(', ')}</b></div>` : ''; })()}
      ${c.ext ? '<div class="c2-kv"><span>Map</span><b class="warn">past the original area of responsibility</b></div>' : ''}
      <div class="c2-kv"><span>Value</span><b>${c.vp || 0} VP · +${c.lp || 0} LP/wk</b></div>
      <div class="c2-kv"><span>Battle map</span><b>${esc(c.battleMap || '')}</b></div>${c.notes ? `<div class="c2-desc">${esc(c.notes)}</div>` : ''}`);
    if (C.depotAllowed(id)) card.appendChild(h('button', { class: 'c2-btn', title: 'A forward supply depot extends the supply network from this square', onclick: () => { const e = this.act('buildDepot', id); this.toast(e || 'Forward depot established', !e); this.render(); this.map.refresh(); } }, 'Establish forward depot (30 LP)'));
    const tf = this.sel && C.tf(this.sel);
    if (tf && o !== 'player') { const p = C.plan(tf.id, id); card.appendChild(h('button', { class: 'c2-btn pri', disabled: !p.ok, title: p.why || '', onclick: () => this.order(id) }, p.ok ? `Attack with ${esc(tf.name)}` : esc(p.why || 'Cannot attack'))); }
    return card;
  }
  // ------------------------------------------------------------------ selection and orders
  select(tfId) {
    const C = this.C; if (tfId && !C.tf(tfId)) tfId = null;
    if (tfId !== this.sel) this.pick.clear();
    this.sel = tfId; if (tfId) this.selCell = null;
    this.map.setSelection(tfId, tfId ? this.reachOf(tfId) : null); this.map.setSelectedCell(this.selCell); this.map.showPath(null);
    this.renderRight(); if (this.tab === 'tf') this.renderLeft();
    this.tut?.poke?.();
  }
  reachOf(tfId) {
    const C = this.C, tf = C.tf(tfId), out = new Map(); if (!tf) return out; const R = C.reach(tf), { dist } = R;
    for (const [id, d] of Object.entries(dist)) if (id !== tf.cell && (d <= tf.mp + 1e-6 || C.plan(tfId, id, R).ok)) out.set(id, 'move');
    if (!tf.attacked) for (const c of C.def.aor.cells) if (C.owner[c.id] !== 'player' && C.neighbors(c.id).some(n => dist[n] != null) && C.plan(tfId, c.id, R).ok) out.set(c.id, 'attack');
    return out;
  }
  clickCell(id) {
    if (this.targeting) { if (id && this.map.targeting?.valid?.get(id) === 'ok') this.targetClick(id); else if (id) { const v = this.map.targeting?.valid?.get(id); this.toast(v === 'bad' ? this.targetWhy(id) : 'Out of range', false); } return; }
    const C = this.C; if (!id) { this.select(null); this.selCell = null; this.map.setSelectedCell(null); this.renderRight(); return; }
    const fs = C.forcesAt(id);
    if (fs.length) { const i = fs.findIndex(f => f.id === this.sel); this.select(fs[(i + 1) % fs.length].id); return; }
    this.selCell = id; this.map.setSelectedCell(id); this.renderRight();
  }
  hoverCell(id) {
    if (!this.sel || !id) { this.map.showPath(null); return; }
    const tf = this.C.tf(this.sel); if (!tf || id === tf.cell) { this.map.showPath(null); return; }
    this.map.showPath(this.C.plan(this.sel, id));
  }
  order(id, tfId = null) {
    if (this.targeting) { this.cancelTarget(); return; }
    const C = this.C; if (tfId && tfId !== this.sel && !this.sel) return this.select(tfId);
    if (!this.sel) { this.clickCell(id); return; }
    const tf = C.tf(this.sel); if (!tf || id === tf.cell) return;
    const p = C.plan(tf.id, id);
    if (!p.ok) { blip('error'); return this.toast(p.why || 'Cannot move there', false); }
    if (p.attack) return this.attackModal(tf, id, p);
    this.act('move', tf.id, id); blip('move');
    this.select(tf.id); this.renderTop();
  }
  // ------------------------------------------------------------------ battles
  estimate(tf, cellId) {
    const C = this.C, us = C.battleUnits(tf.units), sup = tf.supply ?? 1, fort = C.fort[cellId] || 0, c = C.cell(cellId);
    const urban = ['urban', 'industrial'].includes(c.terrain) ? 1 : c.terrain === 'village' || c.terrain === 'forest' ? 0.5 : 0;
    const foes = (C.foes || []).filter(f => f.cell === cellId);
    const mine = us.reduce((a, u) => a + C.unitPower(u), 0) * (0.6 + 0.4 * sup), theirs = (foes.length ? foes.reduce((a, f) => a + f.power, 0) + 1.2 : Math.max(0.5, C.garrison[cellId] || 1) * 2.1) + fort * 0.6 + urban * 0.8;
    const r = mine / theirs; return { mine, theirs, r, label: r > 1.5 ? 'Favourable' : r > 1.1 ? 'Slight advantage' : r > 0.85 ? 'Even' : r > 0.6 ? 'Unfavourable' : 'Very unfavourable', cls: r > 1.1 ? 'good' : r > 0.85 ? 'warn' : 'bad', units: us };
  }
  attackModal(tf, cellId, plan) {
    const C = this.C, c = C.cell(cellId), est = this.estimate(tf, cellId), known = C.known(cellId);
    const m = this.modal(`<div class="c2-k">ATTACK ORDER · ${esc(dateLabel(C.date))}</div><h2>${esc(tf.name)} → ${esc(cellRef(C, cellId))}</h2>
      <div class="c2-two"><div><div class="c2-sub">Own force (${est.units.length} of ${tf.units.length} units deploy, max ${MAX_BATTLE})</div>${est.units.map(u => `<div class="c2-li"><span class="ic">${KIND_ICON[u.kind] || '·'}</span> ${esc(u.name)} <small>${u.menMax ? `${u.men}/${u.menMax}` : ''}${u.veh ? ` · ${u.veh.lost ? 'no veh.' : Math.round(u.veh.hp * 100) + '%'}` : ''} · ${XP_NAMES[xpLevel(u.xp)]}</small></div>`).join('')}${(tf.supply ?? 1) < 0.5 ? '<div class="c2-li bad">Out of supply: less ammunition, fewer drones, lower morale</div>' : ''}</div>
      <div><div class="c2-sub">Objective</div><div class="c2-li">${esc(TERRAIN[c.terrain] || c.terrain)}${c.settlement ? ` · ${esc(c.settlement.name)}` : ''}</div><div class="c2-li">Enemy: <b>${this.vs && (C.foes || []).some(f => f.cell === cellId) ? `${(C.foes || []).filter(f => f.cell === cellId).reduce((a, f) => a + f.n, 0)} units of the other player` : this.vs ? `line battalions${known ? ` (${STRENGTH[Math.max(1, Math.min(3, Math.round(C.garrison[cellId] || 1)))]})` : ''}` : known ? STRENGTH[Math.max(1, Math.min(3, Math.round(C.garrison[cellId] || 1)))] : 'unknown'}</b></div><div class="c2-li">Fortifications: <b>${known ? ['none', 'trenches', 'dug in', 'fortified line'][C.fort[cellId] || 0] : 'unknown'}</b></div><div class="c2-li">Battle map: <b>${esc(c.battleMap || '')}</b></div>
      <div class="c2-odds ${est.cls}">${known ? `Staff estimate: <b>${est.label}</b>` : 'Staff estimate: <b>no reliable intelligence</b>'}</div></div></div>
      <div class="c2-note">${this.vs ? `The task force moves to ${esc(C.cellName(plan.stage))} now and attacks when both commanders have ended the week. Against the other player's task forces it becomes a real battle for both of you (unless you leave it to the staff); squares held only by line battalions are staff-resolved.` : `The task force moves to ${esc(C.cellName(plan.stage))} and attacks. Fight the battle yourself on the RTS map, or let the staff auto-resolve it (less LP, rougher losses). Win and the square is yours; the task force moves in.`}</div>`,
      this.vs ? [['PLAN ATTACK', 'pri', () => this.planAttack(tf, cellId, false)], ['Plan — staff-resolved', '', () => this.planAttack(tf, cellId, true)], ['Cancel', 'cancel', () => {}]]
        : [['FIGHT THE BATTLE', 'pri', () => this.launchAttack(tf, cellId, false)], ['Auto-resolve', '', () => this.launchAttack(tf, cellId, true)], ['Cancel', 'cancel', () => {}]]);
    return m;
  }
  planAttack(tf, cellId, auto) {
    const e = this.act('planAttack', tf.id, cellId, auto); if (e) return this.toast(e, false);
    blip('attack'); this.toast(`${tf.name} will attack ${this.C.cellName(cellId)} when the week ends`); this.select(tf.id); this.renderTop();
  }
  launchAttack(tf, cellId, auto) {
    const C = this.C, p = C.move(tf.id, cellId); if (!p.ok) return this.toast(p.why || 'Cannot attack', false);
    const setup = C.attackSetup(tf.id, cellId); if (!setup) return this.toast('Cannot attack from here', false);
    blip('attack');
    if (auto) { const r = C.autoResolve(cellId, 'attack'); this.afterBattle(r); return; }
    this.launch(setup);
  }
  autoDefence(a) {
    const C = this.C; if (!C.forcesAt(a.to).length) return this.toast('No task force in that square', false);
    blip('attack'); const r = C.autoResolve(a.to, 'defend', a.strength, null, { mode: 'defend', cell: a.to, attack: a.id, from: a.from }); this.afterBattle(r);
  }
  interruptedModal(setup) {
    const C = this.C;
    this.modal(`<div class="c2-k">${setup.mode === 'attack' ? 'ATTACK' : 'DEFENCE'} IN PROGRESS · ${esc(dateLabel(C.date))}</div><h2>${esc(setup.sectorName || C.cellName(setup.sector))}</h2><div class="c2-note">The battle was interrupted before it ended. Go back to the battle map and fight it from the start, or pull the task group out — a withdrawal counts as a lost battle (light losses, no LP).</div>`,
      [['RETURN TO THE BATTLE', 'pri', () => this.launch(setup)], ['Withdraw', 'cancel', () => { const r = C.withdrawBattle(); this.afterBattle(r); }]]);
  }
  fightDefence(a) {
    const C = this.C, setup = C.defendSetup(a.id); if (!setup) return this.toast('No combat-ready task force in that square', false);
    this.launch(setup);
  }
  launch(setup) {
    const C = this.C; C.launch(setup);
    const m = this.modal(`<div class="c2-k">${setup.mode === 'attack' ? 'ATTACK' : 'DEFENCE'} · ${esc(dateLabel(C.date))}</div><h2>${esc(setup.sectorName)}</h2><div class="c2-note">Moving to the battle map…</div>`, []);
    setTimeout(() => this.onLaunch?.(setup), 350);
    return m;
  }
  afterBattle(r) {
    this.map.refresh(); this.render(); this.select(this.sel && this.C.tf(this.sel) ? this.sel : null);
    if (r) this.resultModal(r, () => this.checkOutcome()); else this.checkOutcome();
  }
  resultModal(r, then = null) {
    const C = this.C, win = r.win, att = r.mode === 'attack';
    const rows = (r.units || []).map(u => { const f = C.unit(u.uid); return `<div class="c2-li"><span class="ic">${KIND_ICON[f?.kind] || '·'}</span> ${esc(f?.name || u.uid)} <small>${u.alive} fit · ${u.wounded} wounded${u.vehLost ? ' · <b class="bad">vehicle lost</b>' : ''}${u.kills ? ` · ${u.kills} kills` : ''}</small></div>`; }).join('');
    this.modal(`<div class="c2-k">${r.auto ? 'AUTO-RESOLVED' : 'AFTER-ACTION REPORT'} · ${esc(cellRef(C, r.sector))}</div><h1 class="${win ? 'good' : 'bad'}">${r.withdrawn ? 'WITHDRAWN' : win ? (att ? 'SQUARE TAKEN' : 'ATTACK REPULSED') : (att ? 'ATTACK FAILED' : 'POSITION LOST')}</h1>
      <div class="c2-kv"><span>Enemy killed</span><b>${r.enemyKia || 0}</b></div><div class="c2-kv"><span>Enemy vehicles destroyed</span><b>${r.enemyVehLost || 0}</b></div>${rows ? `<div class="c2-sub">Own units</div>${rows}` : ''}`, [['CONTINUE', 'pri', () => then?.()]]);
  }
  // ------------------------------------------------------------------ end of week
  endTurn(button = false) {
    const C = this.C; if (C.outcome()) return this.checkOutcome(true);
    if (document.querySelector('.c2-modal') || this.tut?.open) return;
    if (this.vs) { if (this.vs.isReady() && !button) return; blip('end'); this.vs.toggleReady(); this.renderTop(); return; }   // Enter only ends the week; the button also takes it back
    const unanswered = C.pendingAttacks.filter(a => !C.forcesAt(a.to).length).length;
    const go = () => {
      const n0 = C.log.length, d0 = C.date, nDir = C.directives.map(a => a.id);
      blip('end'); this.cancelTarget(); this.map.uavDepart?.(); C.endTurn();
      const entries = C.log.slice(n0);
      this.map.setDate(C.date, true); this.select(this.sel && C.tf(this.sel) ? this.sel : null); this.map.refresh(); this.render();
      for (const e of C.lastNews || []) if (e.latlon) this.map.flashEvent(e.latlon, `${dateLabel(e.date.length > 7 ? e.date : e.date + '-01')}: ${e.text}`);
      const fresh = C.directives.filter(a => !nDir.includes(a.id));
      this.turnReport(d0, entries, () => { if (fresh.length && !C.outcome()) this.directiveModal(fresh[0]); else this.checkOutcome(); });
    };
    if (unanswered && !this.confirmedWeek) { this.modal(`<div class="c2-k">END WEEK</div><h2>${unanswered} enemy attack${unanswered > 1 ? 's' : ''} expected on undefended squares</h2><div class="c2-note">The line battalions will try to hold them alone. Move a task force in to fight the defence, or end the week anyway.</div>`, [['End week', 'pri', go], ['Back', 'cancel', () => {}]]); return; }
    go();
  }
  turnReport(d0, entries, done) {
    const C = this.C, imp = entries.slice(-18), rest = entries.length - imp.length;
    if (!entries.length) return done();
    this.modal(`<div class="c2-k">WEEKLY REPORT · ${esc(dateLabel(d0))} → ${esc(dateLabel(C.date))}</div><h2>Week ${C.turn - 1} summary</h2><div class="c2-report">${imp.map(e => `<div class="c2-l ${e.kind}">${esc(e.text)}</div>`).join('')}${rest > 0 ? `<div class="c2-l">+ ${rest} more entries in the log</div>` : ''}</div>`, [['CONTINUE', 'pri', done]]);
  }
  directiveModal(a, then = null) {
    const C = this.C, d = C.directiveDef(a.id); if (!d) return;
    this.modal(`<div class="c2-k">NEW DIRECTIVE · ${esc(d.from || 'Higher command')} · ${esc(dateLabel(a.issuedDate))}</div><h2>${esc(d.title)}</h2><div class="c2-order lg">${esc(d.text || '')}</div>
      <div class="c2-kv"><span>Task</span><b>${esc(kindLabel(d.kind))}${(d.targets || []).length ? ': ' + d.targets.map(t => esc(C.cellName(t))).join(', ') : ''}</b></div><div class="c2-kv"><span>Deadline</span><b>${esc(dateLabel(a.deadline))}</b></div><div class="c2-kv"><span>Reward</span><b>${d.reward?.lp || 0} LP</b></div>`,
      [['ACKNOWLEDGED', 'pri', () => { this.tab = 'dir'; this.renderLeft(); const t = (d.targets || [])[0]; if (t) this.map.flyTo({ ...this.map.cellCenter(t), dist: 14 }, 1.4); then?.(); }]]);
  }
  checkOutcome(again = false) {
    const C = this.C, o = C.outcome(); if (!o || (this.outShown && !again) || document.querySelector('.c2-modal')) return; this.outShown = true;
    const s = C.score();
    this.modal(`<div class="c2-k">${esc(dateLabel(C.date, true).toUpperCase())}</div><h1 class="${o.win ? 'good' : 'bad'}">${esc(o.title)}</h1><p>${esc(o.text)}</p>
      <div class="c2-kv"><span>Battles won</span><b>${C.stats.won} of ${C.stats.battles}</b></div><div class="c2-kv"><span>Grid squares</span><b>+${C.stats.cellsTaken} taken / −${C.stats.cellsLost} lost (net ${s.cells >= 0 ? '+' : ''}${s.cells})</b></div><div class="c2-kv"><span>Directives</span><b>${s.ok} carried out · ${s.fail} failed</b></div><div class="c2-kv"><span>Enemy killed / vehicles</span><b>${C.stats.kills} / ${C.stats.vehKills}</b></div><div class="c2-kv"><span>Own losses / vehicles</span><b>${C.stats.losses} / ${C.stats.vehLost}</b></div>`,
      this.vs ? [['BACK TO THE MENU', 'pri', () => this.vs.leave(true)], ['Look at the map', 'cancel', () => {}]] : [['NEW CAMPAIGN', 'pri', () => { Campaign2.clear(); location.href = location.pathname + '?campaign=1'; }], ['Look at the map', 'cancel', () => {}]]);
  }
  // ------------------------------------------------------------------ intro cutscene
  intro() {
    const C = this.C, D = C.def, I = D.intro || {}, map = this.map;
    const shot = Q.has('introshot') ? +Q.get('introshot') : null;
    const ov = h('div', { class: 'c2-intro' }, `<div class="c2-bar t"></div><div class="c2-bar b"></div><div class="c2-black"></div>
      <div class="c2-title"><div class="c2-ik">${esc(D.brigade?.name || '')}</div><div class="c2-ip">${esc((I.place || D.aor.name).toUpperCase())}</div><div class="c2-idate">${esc(I.date || dateLabel(C.date, true))}</div></div>
      <div class="c2-lines">${(I.lines || []).slice(0, 3).map(l => `<p>${esc(l)}</p>`).join('')}</div><div class="c2-skip">click or press any key to skip</div>`);
    this.root.appendChild(ov); this.root.classList.add('intro-on'); map.labels.style.visibility = 'hidden'; this.inIntro = true;
    const th = map.view('theatre'), fr = map.view('front'), aor = map.view('aor');
    const start = { x: (th.x * 0.55 + aor.x * 0.45), z: (th.z * 0.55 + aor.z * 0.45), dist: th.dist * 0.75, yaw: -0.35, pitch: 1.2 };
    map.jump(start); map.locked = true;
    const music = shot == null ? playIntroMusic({ titleAt: 3.2, length: 11 }) : { stop() {} };
    const LEN = 10.5, lines = [...ov.querySelectorAll('.c2-lines p')];
    let t = 0, last = performance.now(), done = false;
    const path = k => { // slow descent: theatre → over the AOR with a gentle turn
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      map.jump({ x: start.x + (fr.x - start.x) * e, z: start.z + (fr.z - start.z) * e, dist: Math.exp(Math.log(start.dist) + (Math.log(fr.dist * 1.05) - Math.log(start.dist)) * e), yaw: start.yaw + (fr.yaw - start.yaw) * e, pitch: start.pitch + (fr.pitch - start.pitch) * e });
    };
    const finish = () => {
      if (done) return; done = true; this.inIntro = false; music.stop(0.9); map.locked = false; map.jump(fr);
      ov.classList.add('out'); setTimeout(() => { ov.remove(); this.root.classList.remove('intro-on'); map.labels.style.visibility = ''; }, 700);
      window.removeEventListener('keydown', skip, true); ov.removeEventListener('pointerdown', skip);
      C.introSeen = true; C.save();
      const first = C.directives[0]; setTimeout(() => { if (first) this.directiveModal(first, () => this.offerTutorial()); else this.offerTutorial(); }, 500);
    };
    const skip = e => { e.preventDefault?.(); e.stopPropagation?.(); finish(); };
    window.addEventListener('keydown', skip, true); ov.addEventListener('pointerdown', skip);
    const step = now => {
      if (done) return;
      t = shot != null ? shot : t + Math.min(0.1, (now - last) / 1000); last = now;
      path(Math.min(1, t / (LEN - 0.5)));
      ov.querySelector('.c2-black').style.opacity = String(Math.max(0, 1 - t / 1.6));
      const title = ov.querySelector('.c2-title'); title.style.opacity = String(t < 3.2 ? 0 : t < 3.9 ? (t - 3.2) / 0.7 : t < 8.4 ? 1 : Math.max(0, 1 - (t - 8.4) / 1));
      title.style.transform = `translateY(-50%) scale(${1.04 - Math.min(1, Math.max(0, (t - 3.2) / 6)) * 0.04})`;
      lines.forEach((p, i) => { const a = 4.6 + i * 1.9; p.style.opacity = String(t < a ? 0 : t < a + 0.6 ? (t - a) / 0.6 : t < LEN - 0.9 ? 1 : Math.max(0, 1 - (t - LEN + 0.9) / 0.6)); });
      if (shot != null) { setTimeout(() => { window.__done = true; }, 1500); return; }
      if (t >= LEN) return finish();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  // ------------------------------------------------------------------ guided tour
  tutorial(from = 0) {
    if (this.tut?.open || this.inIntro) return;
    if (document.querySelector('.c2-modal')) return this.toast('Close the open dialog first', false);
    if (this.ttEl) this.closeTechTree(); this.cancelTarget();
    this.tut = new Tour(this, { onClose: how => { if (how === 'skipped' && from === 0) this.toast('Tour skipped — the ? button brings it back'); } }); this.tut.start(from);
  }
  // offered once, as soon as the screen is free (no dialog, intro over)
  offerTutorial() {
    if (tutorialState() || Q.has('notour')) return;
    let n = 0; const t = () => { if (this.tut?.open || tutorialState()) return; if (document.querySelector('.c2-modal') || this.inIntro) { if (n++ < 60) setTimeout(t, 400); return; } this.tutorial(); };
    setTimeout(t, 350);
  }
  // ------------------------------------------------------------------ v4: operation goal banner
  renderGoal() {
    const C = this.C, G = C.goalProgress?.(); this.goalEl.innerHTML = ''; this.goalEl.classList.toggle('hidden', !G);
    if (!G) return;
    const pct = Math.round(G.pct * 100), part = Math.round((G.partial ?? 0.5) * 100);
    const head = h('button', { class: 'c2-goal-h', title: 'The operation goal: what wins the campaign (click for details)', 'aria-expanded': this.goalOpen ? 'true' : 'false', onclick: () => { this.goalOpen = !this.goalOpen; this.renderGoal(); } },
      `<span class="c2-goal-k">OPERATION GOAL</span><span class="c2-goal-t">${esc(G.title)}</span><span class="c2-goal-p"><i style="width:${pct}%"></i><em style="left:${part}%"></em></span><b>${pct}%</b><small>${G.achieved ? 'ACHIEVED' : `${G.weeksLeft} wk left`}</small>`);
    this.goalEl.appendChild(head);
    if (this.goalOpen) {
      const d = h('div', { class: 'c2-goal-d' }, `<div class="c2-desc">${esc(G.text || '')}</div>
        <div class="c2-goal-win"><b>Victory:</b> hold every objective square at the end of a week. <b>By ${esc(dateLabel(G.by))}:</b> ${part}%+ of the points = limited success, less = the operation failed.</div>`);
      const row = h('div', { class: 'c2-row' });
      for (const g of G.cells) row.appendChild(h('button', { class: 'c2-chip' + (g.held ? ' ok' : ''), title: `${g.pts} points${g.held ? ' — held' : ''}`, onclick: () => { this.map.flyTo({ ...this.map.cellCenter(g.cell), dist: 9 }, 1); this.clickCell(g.cell); } }, `${g.held ? '✓' : '★'} ${esc(g.name)} · ${g.pts}`));
      d.appendChild(row); this.goalEl.appendChild(d);
    }
  }
  // ------------------------------------------------------------------ v4: fires and UAV reconnaissance (left tab)
  opsPane() {
    const C = this.C, p = h('div');
    if (!C.batteries || !C.uavStatus) { p.appendChild(h('div', { class: 'c2-note' }, 'Fires and drone reconnaissance are not available in this campaign.')); return p; }
    const T = this.targeting;
    if (T) p.appendChild(h('div', { class: 'c2-card c2-tgt' }, `<div class="c2-ch">${T.kind === 'uav' ? 'UAV sortie: pick a square' : T.kind === 'move' ? 'Displace: pick a square' : 'Fire mission: pick a target'}</div><div class="c2-note">Left-click a highlighted square on the map. Right-click or Esc cancels.</div>`));
    // ---- artillery
    const ammo = C.ammo?.player ?? 0, amax = C.ammoMax?.() ?? 12, inc = C.ammoIncome?.() ?? 0;
    p.appendChild(h('div', { class: 'c2-sub' }, 'Artillery group'));
    p.appendChild(h('div', { class: 'c2-card' }, `<div class="c2-kv"><span>Ammunition</span><b class="${ammo >= 2 ? '' : 'warn'}">${fmt(ammo)} / ${amax} missions</b></div><div class="c2-ammo">${Array.from({ length: Math.ceil(amax) }, (_, i) => `<i class="${i < ammo ? 'on' : ''}"></i>`).join('')}</div><div class="c2-kv"><span>Allocation</span><b>+${fmt(inc)} a week</b></div><div class="c2-note">One mission per battery a week: <b>suppress</b> defenders, <b>interdict</b> a road or hub, or <b>counter-battery</b> fire at a found enemy battery. Guns that fire are found: displace them.</div>`));
    for (const b of C.batteries('player')) {
      const R = C.batteryRange(b.id), st = b.down ? `rebuilding (${b.down} wk)` : b.acted === C.turn ? (b.moved === C.turn ? 'displaced this week' : 'fired this week') : (C.supplied?.[b.cell] ?? 1) < 0.5 ? 'out of supply' : 'ready';
      const card = h('div', { class: 'c2-card c2-batc' + (T?.bat === b.id ? ' sel' : '') }, `<div class="c2-ch">${esc(b.name)} <small>${R ? `${R.km} km · ${R.cells} sq.` : ''}</small></div><div class="c2-ck">${esc(cellRef(C, b.cell))} · <span class="${st === 'ready' ? 'good' : 'warn'}">${st}</span>${b.hp < 1 && !b.down ? ' · damaged' : ''}${b.revealed != null && b.revealed >= C.turn - 1 ? ' · <span class="bad">located by the enemy</span>' : ''}</div>`);
      const row = h('div', { class: 'c2-row' });
      row.appendChild(h('button', { class: 'c2-btn pri', disabled: st !== 'ready' || ammo < 1, title: 'Pick a target square in range', onclick: () => this.startTarget({ kind: 'fire', bat: b.id, mission: 'suppress' }) }, 'Fire mission'));
      row.appendChild(h('button', { class: 'c2-btn', disabled: st !== 'ready', title: 'Move the battery up to 3 squares inside own, supplied ground (hides it again)', onclick: () => this.startTarget({ kind: 'move', bat: b.id }) }, 'Displace'));
      row.appendChild(h('button', { class: 'c2-btn', title: 'Show on the map', onclick: () => { this.map.flyTo({ ...this.map.cellCenter(b.cell), dist: 14 }, 0.8); } }, 'Show'));
      card.appendChild(row); p.appendChild(card);
    }
    const found = C.foundBatteries?.() || [];
    if (found.length) p.appendChild(h('div', { class: 'c2-card' }, `<div class="c2-ch">Enemy batteries found</div>${found.map(b => `<div class="c2-kv"><span>${esc(b.name || b.kind)}</span><b>${esc(cellRef(C, b.cell))}</b></div>`).join('')}`));
    // ---- UAVs
    const U = C.uavStatus(), left = Math.max(0, U.sorties - U.used);
    p.appendChild(h('div', { class: 'c2-sub' }, 'UAV reconnaissance'));
    const uc = h('div', { class: 'c2-card' }, `<div class="c2-kv"><span>Sorties this week</span><b class="${left ? 'good' : 'warn'}">${left} of ${U.sorties}</b></div><div class="c2-kv"><span>Airframes</span><b>${U.stock} / ${U.max}${U.lost ? ` · ${U.lost} lost` : ''}</b></div><div class="c2-note">A sortie reveals the enemy in the squares around the target for this week and the next: garrisons, fortifications, task forces, batteries. Enemy EW and air defence shoot drones down.</div>`);
    const row = h('div', { class: 'c2-row' });
    for (const [k, D] of Object.entries(U.types || {})) row.appendChild(h('button', { class: 'c2-btn' + (T?.kind === 'uav' && T.type === k ? ' on' : ''), disabled: !left || U.stock <= 0, title: `${C.side === 'RU' ? D.ru : D.label}: reach ${D.reach * (C.def.aor.cellKm || 2)} km past the line, sees ${C.uavRadius(k)} square(s) around the target, ${Math.round(D.loss * 100)}% base loss`, onclick: () => this.startTarget({ kind: 'uav', type: k }) }, `${k === 'quad' ? 'Quadcopter' : 'Fixed-wing'} sortie`));
    uc.appendChild(row); p.appendChild(uc);
    const wk = (C.uavLog || []).filter(l => l.turn === C.turn);
    if (wk.length) p.appendChild(h('div', { class: 'c2-card' }, `<div class="c2-ch">Flown this week</div>${wk.map(l => `<div class="c2-kv"><span>${l.type === 'quad' ? 'Quadcopter' : 'Fixed-wing'} → ${esc(cellRef(C, l.cell))}</span><b class="${l.lost ? 'bad' : 'good'}">${l.lost ? 'lost' : `${l.cells.length} sq. seen`}</b></div>`).join('')}`));
    return p;
  }
  // targeting mode on the map: { kind: 'fire', bat, mission } | { kind: 'move', bat } | { kind: 'uav', type }
  startTarget(T) {
    const C = this.C; this.select(null); this.targeting = T; this.tab = 'ops';
    let valid = new Map(), from = null, rangeKm = 0, radius = 0, color = '#ffd27a';
    if (T.kind === 'fire') {
      const b = C.battery(T.bat), R = C.batteryRange(T.bat), tg = C.fireTargets(T.bat); from = b.cell; rangeKm = R.km; color = '#ffb35a';
      for (const id of R.coverage) valid.set(id, (tg[id] || []).includes(T.mission) ? 'ok' : 'bad');
    } else if (T.kind === 'move') {
      const b = C.battery(T.bat); from = b.cell; color = '#8fbaf0';
      for (const c of C.def.aor.cells) if (C.owner[c.id] === 'player' && c.id !== b.cell && Math.max(Math.abs(c.col - C.cell(b.cell).col), Math.abs(c.row - C.cell(b.cell).row)) <= 3) valid.set(c.id, (C.supplied?.[c.id] ?? 0) >= 0.5 ? 'ok' : 'bad');
    } else {
      color = '#7fd6ff'; radius = C.uavRadius(T.type);
      for (const c of C.def.aor.cells) if (C.owner[c.id] !== 'player' && (!C.isOpen || C.isOpen(c.id))) valid.set(c.id, C.uavCheck(T.type, c.id) ? 'bad' : 'ok');
    }
    this.map.setTargeting({ valid, from, rangeKm, radius, color, bat: T.bat });
    this.renderTargetBar(); this.renderLeft(); this.map.refresh(); this.tut?.poke?.();
  }
  targetWhy(id) { const C = this.C, T = this.targeting; if (!T) return ''; if (T.kind === 'fire') return C.fireCheck(T.bat, T.mission, id) || 'Not possible'; if (T.kind === 'uav') return C.uavCheck(T.type, id) || 'Not possible'; return (C.supplied?.[id] ?? 0) < 0.5 ? 'That square is out of supply' : 'Not possible'; }
  cancelTarget() { if (!this.targeting) return; this.targeting = null; this.map.setTargeting(null); this.targetBar?.remove(); this.targetBar = null; this.renderLeft(); this.map.refresh(); }
  renderTargetBar() {
    const C = this.C, T = this.targeting; this.targetBar?.remove(); if (!T) return;
    const bar = this.targetBar = h('div', { class: 'c2-tbar' });
    if (T.kind === 'fire') {
      const b = C.battery(T.bat), R = C.batteryRange(T.bat);
      bar.appendChild(h('div', { class: 'c2-tbar-t' }, `<b>${esc(b.name)}</b> · range ${R.km} km — pick the target square`));
      const seg = h('div', { class: 'c2-seg' });
      for (const [k, M] of Object.entries({ suppress: 'Suppress', interdict: 'Interdict', counterbattery: 'Counter-battery' })) seg.appendChild(h('button', { class: T.mission === k ? 'on' : '', title: { suppress: 'Defenders of the square fight weaker until the enemy has moved and lose men (1 ammo)', interdict: 'Enemy supply through a road / hub square is cut back for his next week (1 ammo)', counterbattery: 'Fire at a found enemy battery: 45% to hit, 65% with fresh drone pictures (2 ammo)' }[k], onclick: () => this.startTarget({ ...T, mission: k }) }, M));
      bar.appendChild(seg);
    } else if (T.kind === 'move') bar.appendChild(h('div', { class: 'c2-tbar-t' }, `<b>${esc(C.battery(T.bat).name)}</b> — pick a new position (up to 3 squares, own supplied ground)`));
    else { const D = C.uavStatus().types[T.type]; bar.appendChild(h('div', { class: 'c2-tbar-t' }, `<b>${esc(C.side === 'RU' ? D.ru : D.label)}</b> · reach ${D.reach * (C.def.aor.cellKm || 2)} km past the line · sees ${C.uavRadius(T.type)} square(s) around the target — pick the square`)); }
    bar.appendChild(h('button', { class: 'c2-btn', onclick: () => this.cancelTarget() }, 'Cancel (Esc)'));
    this.root.appendChild(bar);
  }
  targetClick(id) {
    const C = this.C, T = this.targeting; if (!T || !id) return;
    if (T.kind === 'fire') {
      const r = this.act('fire', T.bat, T.mission, id); if (typeof r === 'string') { blip('error'); return this.toast(r, false); }
      blip('attack'); this.map.strike?.(id, T.mission === 'interdict' ? '#ffb35a' : '#ff7a5a');
      this.toast(`${C.battery(T.bat)?.name}: ${({ suppress: 'suppression', interdict: 'interdiction', counterbattery: 'counter-battery' })[T.mission]} mission on ${C.cellName(id)}`);
    } else if (T.kind === 'move') {
      const e = this.act('moveBattery', T.bat, id); if (e) { blip('error'); return this.toast(e, false); } blip('move'); this.toast(`${C.battery(T.bat)?.name} displaces to ${C.cellName(id)}`);
    } else {
      const r = this.act('flyUav', T.type, id); if (typeof r === 'string') { blip('error'); return this.toast(r, false); }
      blip('move'); this.toast(r.lost ? `The drone over ${C.cellName(id)} was lost${r.cells?.length ? ' after sending its first pictures' : ''}` : `UAV over ${C.cellName(id)}: ${r.cells.length} square(s) observed`, !r.lost);
    }
    this.targeting = null; this.map.setTargeting(null); this.targetBar?.remove(); this.targetBar = null;
    this.map.refresh(); this.render(); this.tut?.poke?.();
  }
  // ------------------------------------------------------------------ tech tree (full-screen node graph + 3D preview)
  // Columns = date tiers (tech.js TIERS); vehicle lines first (vehicle node, its unit unlocks, and a drop-down with the
  // vehicle's upgrades), then the support branches. Wires connect prerequisites. The side panel shows the selected
  // node and a rotating 3D model of the vehicle with its delivered kits (+ the selected upgrade, as a preview).
  techTree(selId = null) {
    const C = this.C; if (this.inIntro) return;
    this.ttEl?.remove(); this.ttOpen ||= new Set([linesOf(C)[0]?.id]);
    const el = this.ttEl = h('div', { class: 'c2-tt', role: 'dialog', 'aria-label': 'Tech tree' });
    const head = h('div', { class: 'c2-tt-head' }, `<div><div class="c2-k">HIGH COMMAND · ${esc(dateLabel(C.date))}</div><div class="c2-t">Tech tree</div></div>
      <div class="c2-tt-legend"><span class="have">in service</span><span class="ordered">on the way</span><span class="avail">can request</span><span class="date">date-gated</span><span class="locked">needs prerequisite</span></div><div class="c2-tt-lp">LP <b>${C.lp}</b></div>`);
    head.appendChild(h('button', { class: 'c2-x', title: 'Close (Esc)', onclick: () => this.closeTechTree() }, '×'));
    const body = h('div', { class: 'c2-tt-body' }), treeWrap = h('div', { class: 'c2-tt-tree' }), tree = h('div', { class: 'c2-tt-in' });
    const cols = TIERS.length, colsCss = `repeat(${cols}, var(--cw))`;
    tree.appendChild(h('div', { class: 'c2-tt-grid c2-tt-tiers', style: `grid-template-columns:${colsCss}` }, TIERS.map((t, i) => `<div style="grid-column:${i + 1}" class="${tierOf(C.date) >= i ? 'now' : ''}">${esc(t.label)}${tierOf(C.date) === i ? ' <i>◂ now</i>' : ''}</div>`).join('')));
    const node = (t, extra = '') => {
      const st = techState(C, t), o = C.orders.find(x => x.what === 'tech' && x.key === t.id);
      const meta = st === 'have' ? '✓ in service' : st === 'ordered' ? `arrives in ${o?.eta ?? t.eta ?? 1} wk` : st === 'date' ? `from ${dateLabel(t.date)}` : `${t.lp} LP · ${t.eta ?? 1} wk`;
      return h('button', { class: `c2-tn2 ${st} ${extra}${this.ttSel === t.id ? ' sel' : ''}`, 'data-id': t.id, title: t.name, onclick: () => this.ttSelect(t.id) },
        `<div class="nm">${t.kit ? `<span class="kt">${esc(KITS[t.kit].short)}</span>` : t.kind === 'unlock' ? '<span class="kt u">UNIT</span>' : ''}${esc(t.name)}</div><div class="mt">${st === 'locked' ? '🔒 ' : ''}${esc(meta)}</div>`);
    };
    // ---- vehicle lines
    tree.appendChild(h('div', { class: 'c2-sub' }, 'Vehicles'));
    for (const L of linesOf(C)) {
      const vt = L.tech ? C.techItem(L.tech) : null, lst = lineState(C, L), vcol = tierOf(vt?.date || L.date);
      const rowNodes = C.def.tech.filter(t => t.line === L.id && !t.kit && t.id !== L.tech), ups = C.def.tech.filter(t => t.line === L.id && t.kit);
      const line = h('div', { class: 'c2-tt-line' }), g = h('div', { class: 'c2-tt-grid', style: `grid-template-columns:${colsCss}` });
      const owned = ups.filter(t => C.unlocked.includes(t.id)).length, open = this.ttOpen.has(L.id);
      const vn = h('button', { class: `c2-tv ${lst}${this.ttLine === L.id && (!this.ttSel || this.ttSel === L.tech) ? ' sel' : ''}`, 'data-id': L.tech || `line:${L.id}`, style: `grid-column:${vcol + 1}`, onclick: () => { this.ttLine = L.id; this.ttSelect(L.tech || null, L.id); } },
        `<div class="ro">${esc(L.role)}</div><div class="nm">${esc(L.name)}</div><div class="mt">${lst === 'have' ? '✓ in service' : lst === 'date' ? `from ${esc(dateLabel(vt?.date || L.date))}` : lst === 'ordered' ? 'on the way' : vt ? `${vt.lp} LP · ${vt.eta ?? 1} wk` : ''}</div>`);
      g.appendChild(vn);
      const lay = layoutRow(C, rowNodes, vcol + 1);
      for (const t of rowNodes) { const p = lay.pos.get(t.id), n = node(t, 'unit'); n.style.gridColumn = String(Math.min(cols, p.col + 1)); n.style.gridRow = String(p.row + 1); g.appendChild(n); }
      line.appendChild(g);
      const dd = h('button', { class: 'c2-tt-dd' + (open ? ' open' : ''), 'aria-expanded': open ? 'true' : 'false', style: `margin-left:calc(${vcol} * (var(--cw) + var(--cg)))`, onclick: () => { if (this.ttOpen.has(L.id)) this.ttOpen.delete(L.id); else this.ttOpen.add(L.id); this.ttLine = L.id; this.techTree(this.ttSel); } },
        `${open ? '▾' : '▸'} Upgrades <b>${owned}/${ups.length}</b>${ups.some(t => techState(C, t) === 'avail') ? ' <i>new</i>' : ''}`);
      line.appendChild(dd);
      if (open && ups.length) {
        const sg = h('div', { class: 'c2-tt-grid sub', style: `grid-template-columns:${colsCss}` }), ly = layoutRow(C, ups, vcol);
        for (const t of ups) { const p = ly.pos.get(t.id), n = node(t, 'kit'); n.style.gridColumn = String(Math.min(cols, p.col + 1)); n.style.gridRow = String(p.row + 1); n.dataset.parent = L.tech || `line:${L.id}`; sg.appendChild(n); }
        line.appendChild(sg);
      }
      tree.appendChild(line);
    }
    // ---- support branches
    for (const b of branchesOf(C)) {
      const ts = C.def.tech.filter(t => !t.line && (t.branch || 'General') === b); if (!ts.length) continue;
      tree.appendChild(h('div', { class: 'c2-sub' }, esc(b)));
      const g = h('div', { class: 'c2-tt-grid', style: `grid-template-columns:${colsCss}` }), ly = layoutRow(C, ts, 0);
      for (const t of ts) { const p = ly.pos.get(t.id), n = node(t); n.style.gridColumn = String(Math.min(cols, p.col + 1)); n.style.gridRow = String(p.row + 1); g.appendChild(n); }
      tree.appendChild(g);
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.classList.add('c2-tt-wires'); tree.prepend(svg);
    treeWrap.appendChild(tree);
    const side = h('div', { class: 'c2-tt-side' }), view = h('div', { class: 'c2-tt-view' }), info = h('div', { class: 'c2-tt-info' });
    side.append(view, info); body.append(treeWrap, side); el.append(head, body); this.root.appendChild(el);
    if (this.ttScroll) treeWrap.scrollTop = this.ttScroll; treeWrap.onscroll = () => { this.ttScroll = treeWrap.scrollTop; };
    this.ttPreview ||= new TechPreview(); this.ttPreview.mount(view);
    this.ttWires(tree, svg); requestAnimationFrame(() => { if (tree.isConnected) this.ttWires(tree, svg); });
    if (!this.ttRo) { this.ttRo = () => { const t = this.ttEl?.querySelector('.c2-tt-in'), w = t?.querySelector('.c2-tt-wires'); if (t && w) this.ttWires(t, w); }; window.addEventListener('resize', this.ttRo); }
    this.ttSelect(selId ?? this.ttSel ?? null, this.ttLine, true);
    this.tut?.poke?.();
  }
  ttWires(tree, svg) {
    const C = this.C, base = tree.getBoundingClientRect(), R = el => { const r = el.getBoundingClientRect(); return { l: r.left - base.left, r: r.right - base.left, t: r.top - base.top, b: r.bottom - base.top, m: (r.top + r.bottom) / 2 - base.top, c: (r.left + r.right) / 2 - base.left }; };
    svg.setAttribute('width', tree.scrollWidth); svg.setAttribute('height', tree.scrollHeight);
    const byId = id => tree.querySelector(`[data-id="${CSS.escape(id)}"]`), out = [];
    const wire = (a, b, cls, elbow = false) => { const A = R(a), B = R(b); if (elbow) { const x = A.l + 18; out.push(`<path class="${cls}" d="M${x},${A.b} V${B.m} H${B.l}"/>`); return; } const x0 = A.r, y0 = A.m, x1 = B.l, y1 = B.m, dx = Math.max(14, (x1 - x0) / 2); out.push(`<path class="${cls}" d="M${x0},${y0} C${x0 + dx},${y0} ${x1 - dx},${y1} ${x1},${y1}"/>`); };
    for (const n of tree.querySelectorAll('[data-id]')) {
      const t = C.techItem(n.dataset.id), st = t ? techState(C, t) : 'have', cls = st === 'have' ? 'have' : st === 'avail' || st === 'ordered' ? 'avail' : 'locked';
      const reqs = (t?.req || []).map(byId).filter(Boolean);
      for (const r of reqs) wire(r, n, cls);
      if (!reqs.length && n.dataset.parent) { const p = byId(n.dataset.parent); if (p) wire(p, n, cls, true); }
      else if (!reqs.length && n.classList.contains('unit')) { const v = n.closest('.c2-tt-line')?.querySelector('.c2-tv'); if (v) wire(v, n, cls); }
    }
    svg.innerHTML = out.join('');
  }
  ttSelect(id, lineId = null, keepScroll = false) {
    const C = this.C, el = this.ttEl; if (!el) return;
    const t = id ? C.techItem(id) : null; this.ttSel = id;
    const L = linesOf(C).find(x => x.id === (t?.line || lineId || this.ttLine)) || linesOf(C)[0]; this.ttLine = L?.id;
    for (const n of el.querySelectorAll('.c2-tn2, .c2-tv')) n.classList.toggle('sel', id ? n.dataset.id === id : n.dataset.id === (L?.tech || `line:${L?.id}`));
    // 3D preview: the line's vehicle with its delivered kits, plus the selected kit (shown as a preview)
    const have = L ? kitsOwned(C, L.vk) : [], extra = t?.kit && !have.includes(t.kit) ? t.kit : null;
    if (L) this.ttPreview?.show(L.asset, extra ? [...have, extra] : have, { wheeled: L.vk === 'btr' || L.asset === 'bohdana', label: `${L.name}${have.length ? ' · ' + have.map(k => KITS[k].short).join(', ') : ''}${extra ? ` · preview: + ${KITS[extra].short}` : ''}`, focus: extra });
    const info = el.querySelector('.c2-tt-info'); info.innerHTML = '';
    if (!t) {
      const ups = C.def.tech.filter(x => x.line === L?.id && x.kit);
      info.innerHTML = `<div class="c2-ck">${esc(L?.role || '')}</div><div class="c2-ch lg">${esc(L?.name || '')}</div><div class="c2-desc">Fielded by: ${(L?.catalog || []).map(k => C.catalogItem(k)?.label).filter(Boolean).map(esc).join(', ') || '—'}</div>
        <div class="c2-sub">Upgrades</div>${ups.map(u => `<div class="c2-kv"><span>${esc(u.name)}</span><b class="${techState(C, u) === 'have' ? 'good' : ''}">${({ have: '✓', ordered: 'on the way', avail: `${u.lp} LP`, date: `from ${dateLabel(u.date)}`, locked: 'locked' })[techState(C, u)]}</b></div>`).join('')}
        <div class="c2-note">Open the drop-down under the vehicle and pick an upgrade to see it on the model.</div>`;
      return;
    }
    const st = techState(C, t), fx = effectLines(t);
    const unl = (t.unlock || []).map(k => C.catalogItem(k)?.label).filter(Boolean);
    info.innerHTML = `<div class="c2-ck">${t.kit ? `Vehicle upgrade · ${esc(L?.name || '')}` : t.vehicle ? 'New vehicle' : t.kind === 'unlock' ? 'Unit authorisation' : esc(t.branch || '')}</div><div class="c2-ch lg">${esc(t.name)}</div><div class="c2-desc">${esc(t.desc || '')}</div>
      ${fx.length ? `<div class="c2-sub">Effect</div>${fx.map(f => `<div class="c2-fx ${f.good ? 'g' : 'b'}">${f.good ? '+' : '−'} ${esc(f.text)}</div>`).join('')}` : ''}${unl.length ? `<div class="c2-sub">Unlocks</div>${unl.map(u => `<div class="c2-fx g">+ ${esc(u)}</div>`).join('')}` : ''}
      <div class="c2-sub">Request</div><div class="c2-kv"><span>Cost</span><b class="lp">${t.lp} LP</b></div><div class="c2-kv"><span>Delivery</span><b>${t.eta ?? 1} wk</b></div>${t.date ? `<div class="c2-kv"><span>Available from</span><b class="${C.dateOk(t) ? '' : 'warn'}">${esc(dateLabel(t.date))}</b></div>` : ''}
      ${(t.req || []).length ? `<div class="c2-kv"><span>Needs</span><b>${t.req.map(r => `<span class="${C.unlocked.includes(r) ? 'good' : 'warn'}">${esc(C.techItem(r)?.name || r)}</span>`).join(', ')}</b></div>` : ''}`;
    const btn = h('button', { class: 'c2-btn pri c2-tt-req', disabled: st !== 'avail' || C.lp < t.lp, onclick: () => { const e = this.act('orderTech', t.id); this.toast(e || `${t.name} requested`, !e); blip(e ? 'error' : 'move'); this.techTree(t.id); } },
      st === 'have' ? '✓ In service' : st === 'ordered' ? 'On the way' : st === 'date' ? `Not before ${dateLabel(t.date)}` : st === 'locked' ? 'Prerequisites missing' : C.lp < t.lp ? `Not enough LP (${t.lp})` : `REQUEST (${t.lp} LP)`);
    info.appendChild(btn);
  }
  closeTechTree() { this.ttEl?.remove(); this.ttEl = null; this.ttPreview?.stop(); this.renderLeft(); this.tut?.poke?.(); }
  // ------------------------------------------------------------------ misc
  key(e) {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || document.querySelector('.c2-intro') || this.tut?.open) return;
    if (this.ttEl && !document.querySelector('.c2-modal')) { if (e.key === 'Escape' || e.key.toLowerCase() === 't') { e.preventDefault(); this.closeTechTree(); } return; }
    if (e.key.toLowerCase() === 't' && !document.querySelector('.c2-modal') && !e.ctrlKey) { e.preventDefault(); this.techTree(); return; }
    if (e.key === 'F1' || (e.key === '?' && !e.ctrlKey)) { e.preventDefault(); if (!document.querySelector('.c2-modal')) this.tutorial(); return; }
    // modals: Enter = the primary button, Escape = cancel (or the only button); the topmost modal only
    const ms = document.querySelectorAll('.c2-modal'), m = ms[ms.length - 1];
    if (m) {
      if (e.key === 'Enter') { if (e.target.closest?.('.c2-modal') && e.target.matches('button')) return; e.preventDefault(); m.querySelector('button.pri, button')?.click(); }   // a focused dialog button acts itself
      else if (e.key === 'Escape') { e.preventDefault(); const bs = m.querySelectorAll('button'); (m.querySelector('button.cancel') || (bs.length === 1 ? bs[0] : null))?.click(); }
      return;
    }
    const inUi = e.target !== document.body && e.target.closest?.('.c2-top, .c2-left, .c2-right, .c2-bottom');   // keyboard focus on a panel control: let it act
    if (e.key === 'Escape' && this.targeting) { this.cancelTarget(); return; }
    if (e.key === 'Escape') { this.select(null); this.selCell = null; this.map.setSelectedCell(null); this.renderRight(); }
    else if (e.key === 'Tab') { if (inUi) return; e.preventDefault(); const fs = this.C.forces; if (!fs.length) return; const i = fs.findIndex(f => f.id === this.sel); const f = fs[(i + (e.shiftKey ? fs.length - 1 : 1)) % fs.length]; this.select(f.id); this.map.flyTo({ ...this.map.cellCenter(f.cell), dist: Math.min(this.map.cam.dist, 14) }, 0.7); }
    else if (e.key === 'Enter') { if (inUi && e.target.matches('button, a, [tabindex]')) return; e.preventDefault(); this.endTurn(); }
    else if (e.key.toLowerCase() === 'l') this.toggleSupply();
  }
  modal(html, buttons) {
    const m = h('div', { class: 'c2-modal', role: 'dialog', 'aria-modal': 'true' }), box = h('div', { class: 'c2-modal-in' }, html), row = h('div', { class: 'c2-row end' });
    for (const [l, cls, f] of buttons) row.appendChild(h('button', { class: `c2-btn ${cls}`, onclick: () => { if (!m.isConnected) return; m.remove(); document.activeElement?.blur?.(); f(); } }, l));
    if (buttons.length) box.appendChild(row); m.appendChild(box); this.root.appendChild(m);
    requestAnimationFrame(() => { if (m.isConnected) (box.querySelector('button.pri') || box.querySelector('button'))?.focus({ preventScroll: true }); });
    return m;
  }
  toast(msg, good = true) { this.toastEl.textContent = msg; this.toastEl.className = 'c2-toast show ' + (good ? '' : 'bad'); clearTimeout(this.tt); this.tt = setTimeout(() => { this.toastEl.className = 'c2-toast'; }, 2600); }
}

const cellRef = (C, id) => { const n = C.cellName(id), r = C.gridRef(id); return n.endsWith(r) ? n : `${n} ${r}`; };
const kindLabel = k => ({ capture: 'Capture', hold: 'Hold', survive: 'Hold the line', destroy: 'Destroy enemy vehicles', recon: 'Reconnaissance', raid: 'Raid' })[k] || k;
const seasonName = d => { const m = +String(d).slice(5, 7); return m === 12 || m <= 2 ? 'WINTER' : m <= 5 ? 'SPRING' : m <= 8 ? 'SUMMER' : 'AUTUMN'; };

// 3D vehicle preview for the tech tree: one renderer, reused every time the tree opens; the GLB (cached) rotates
// on a turntable with the delivered kits attached (vehicleKit.js) and the selected upgrade highlighted.
const GLB = {};
const glbLoader = new GLTFLoader();
class TechPreview {
  constructor() {
    this.r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); this.r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); this.r.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.r.domElement; this.canvas.className = 'c2-tt-canvas';
    this.scene = new THREE.Scene(); this.cam = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
    this.scene.add(new THREE.HemisphereLight('#e6ecf2', '#3b382c', 1.5)); const sun = new THREE.DirectionalLight('#fff3dc', 2.3); sun.position.set(-6, 10, 7); this.scene.add(sun);
    const rim = new THREE.DirectionalLight('#9fb6d8', 0.9); rim.position.set(6, 4, -8); this.scene.add(rim);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(6.5, 48), new THREE.MeshStandardMaterial({ color: 0x24261f, roughness: 1 })); disc.rotation.x = -Math.PI / 2; this.scene.add(disc);
    const ring = new THREE.Mesh(new THREE.RingGeometry(6.3, 6.5, 64), new THREE.MeshBasicMaterial({ color: 0xd8b25a, transparent: true, opacity: 0.5 })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.005; this.scene.add(ring);
    this.pivot = new THREE.Group(); this.scene.add(this.pivot); this.yaw = 0.6; this.key = null;
  }
  mount(el) {
    this.el = el; el.appendChild(this.canvas); this.label = h('div', { class: 'c2-tt-vl' }); el.appendChild(this.label);
    let drag = null; this.canvas.onpointerdown = e => { drag = e.clientX; this.canvas.setPointerCapture(e.pointerId); }; this.canvas.onpointermove = e => { if (drag != null) { this.yaw += (e.clientX - drag) * 0.01; drag = e.clientX; this.hold = 2; } }; this.canvas.onpointerup = () => { drag = null; };
    this.run();
  }
  async show(asset, kits, opts = {}) {
    const key = `${asset}|${kits.join(',')}|${opts.focus || ''}`; if (this.label) this.label.textContent = opts.label || '';
    if (key === this.key) return; this.key = key; window.__ttReady = null;
    let g = GLB[asset]; if (!g) { try { g = GLB[asset] = await glbLoader.loadAsync(`assets/vehicles/${asset}.glb`); } catch (e) { console.warn('tech preview', asset, e); return; } }
    if (this.key !== key) return;
    for (const c of [...this.pivot.children]) this.pivot.remove(c);
    const m = g.scene.clone(true);
    m.traverse(o => { if (o.userData?.hidden || /_LOD1$|_wreck$/i.test(o.name)) o.visible = false; });
    this.pivot.add(m); m.updateMatrixWorld(true);
    attachKits(m, kits, { wheeled: !!opts.wheeled });
    if (opts.focus) m.traverse(o => { if (o.userData?.kitId === opts.focus && o.material) { o.material = o.material.clone(); o.material.emissive = new THREE.Color(0xb88a2a); o.material.emissiveIntensity = 0.55; this.glow = o.material; } });
    else this.glow = null;
    const box = new THREE.Box3(); m.traverse(o => { if (o.isMesh && o.visible) { let p = o, vis = true; while (p) { if (!p.visible) vis = false; p = p.parent; } if (vis) box.expandByObject(o); } });
    const sz = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3()); m.position.x -= c.x; m.position.z -= c.z;
    this.fit = { r: Math.max(sz.x, sz.z) * 0.62 + sz.y * 0.3, y: sz.y * 0.45 };
    window.__ttReady = key;
  }
  run() {
    cancelAnimationFrame(this.raf); let last = performance.now();
    const loop = now => {
      if (!this.canvas.isConnected) return; this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const w = this.el.clientWidth, hh = this.el.clientHeight; if (w && hh && (w !== this.w || hh !== this.h)) { this.w = w; this.h = hh; this.r.setSize(w, hh, false); this.cam.aspect = w / hh; this.cam.updateProjectionMatrix(); }
      if (this.hold > 0) this.hold -= dt; else if (!window.__ttStill) this.yaw += dt * 0.35;
      this.pivot.rotation.y = this.yaw;
      if (this.glow) this.glow.emissiveIntensity = 0.35 + 0.3 * Math.sin(now / 260);
      const f = this.fit || { r: 5, y: 1 }, d = f.r / Math.tan(16 * Math.PI / 180) * 0.62;
      this.cam.position.set(0, f.y + d * 0.42, d); this.cam.lookAt(0, f.y * 0.8, 0);
      this.r.render(this.scene, this.cam);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { cancelAnimationFrame(this.raf); }
}

export function injectCss() {
  if (document.getElementById('c2-css')) return;
  const css = `
#c2{position:fixed;inset:0;z-index:50;background:#0e0f0d;color:var(--ink,#e8e4d8);font-family:"Barlow Condensed","Roboto Condensed","Arial Narrow",system-ui,sans-serif;overflow:hidden;--p:rgba(16,17,15,.86);--l:rgba(232,228,216,.14);--own:${COL.own};--en:${COL.enemy};--acc:var(--accent,#d8b25a)}
#c2.hidden{display:none}
.c2-boot{position:absolute;inset:0;display:grid;place-items:center;letter-spacing:.3em;color:var(--dim,#9c978a);font-size:14px}
.c2-map{position:absolute;inset:0}.c2-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;outline:none}
.c2-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.c2-labels>div{position:absolute;left:0;top:0;will-change:transform}
.c2-tl{transform-origin:0 0;white-space:nowrap;margin:0}
.c2-tl-city{font-size:13px;color:rgba(232,228,216,.7);letter-spacing:.06em;text-shadow:0 1px 2px #000;translate:6px -50%}
.c2-tl-oblast{font-size:12px;letter-spacing:.42em;color:rgba(232,228,216,.28);translate:-50% -50%}
.c2-tl-river{font-size:12px;font-style:italic;color:rgba(120,165,185,.75);translate:-50% -50%}
.c2-sl{translate:-50% -160%;white-space:nowrap;color:#f2eee2;text-shadow:0 0 3px #000,0 1px 2px #000;font-weight:600;letter-spacing:.05em}
.c2-sl1{font-size:11px;opacity:.8}.c2-sl2{font-size:12.5px}.c2-sl3{font-size:14px}.c2-sl4{font-size:16px;letter-spacing:.1em}.c2-sl5{font-size:18px;letter-spacing:.14em;text-transform:uppercase}
.c2-tok{pointer-events:auto;cursor:pointer;translate:-50% -100%;display:flex;flex-direction:column;align-items:center;padding-bottom:22px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))}
.c2-tok .c2-nato{display:block}.c2-tok-ech{font-size:11px;font-weight:800;line-height:9px;color:#dfe9f7;letter-spacing:1px;text-shadow:0 0 2px #000}
.c2-tok-n{font-size:12px;font-weight:700;color:#fff;background:rgba(10,18,30,.78);padding:0 5px;margin-top:2px;white-space:nowrap;border:1px solid rgba(79,143,224,.5)}
.c2-tok-mp{display:flex;gap:2px;margin-top:2px;align-items:center}.c2-tok-mp i{width:7px;height:4px;background:rgba(255,255,255,.18)}.c2-tok-mp i.on{background:#9fd07a}.c2-tok-mp i.half{background:linear-gradient(90deg,#9fd07a 50%,rgba(255,255,255,.18) 50%)}
.c2-tok-mp b{font-size:9px;letter-spacing:.08em;padding:0 3px;margin-left:3px}.c2-oos{background:var(--en);color:#fff}.c2-spot{background:#d8b25a;color:#1b1406}.c2-tok.spotted .c2-tok-n{box-shadow:0 0 0 1px #d8b25a,0 0 10px rgba(216,178,90,.55)}.c2-used{background:#555;color:#ddd}
.c2-stem{position:absolute;bottom:0;left:50%;width:2px;height:22px;background:linear-gradient(rgba(220,235,255,.9),rgba(220,235,255,.1))}
.c2-tok.sel .c2-nato rect{stroke:var(--acc);stroke-width:3}.c2-tok.sel .c2-tok-n{background:var(--acc);color:#14130f;border-color:var(--acc)}.c2-tok.sel{filter:drop-shadow(0 0 6px rgba(216,178,90,.8))}
.c2-tok.res .c2-tok-n{opacity:.8}.c2-tok.oos .c2-nato rect{fill:#6c7d93}
.c2-tok:hover .c2-tok-n{border-color:#fff}
.c2-tok.compact .c2-tok-n{visibility:hidden}.c2-tok.compact:hover .c2-tok-n{visibility:visible;position:relative;z-index:3}.c2-tok.compact:hover{z-index:3}
.c2-tok-n.foe{background:rgba(40,10,8,.82);border-color:rgba(224,80,63,.6);color:#ffd6cf;font-weight:600}.c2-tok-ech.foe{color:#ffd6cf}.c2-stem.foe{background:linear-gradient(rgba(255,190,180,.9),rgba(255,190,180,.1))}
.c2-tok.plan .c2-tok-n::after{content:" ⚔";color:#ff9c8c}
.c2-en{translate:-50% -50%;display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,.7))}.c2-en-ech{font-size:10px;font-weight:800;color:#ffd6cf;line-height:9px;text-shadow:0 0 2px #000}.c2-en.unk{opacity:.8}
.c2-obj{translate:-50% -100%}.c2-obj span{display:block;background:var(--acc);color:#14130f;font-weight:800;font-size:13px;padding:1px 6px 2px;clip-path:polygon(0 0,100% 0,100% 75%,50% 100%,0 75%);min-width:20px;text-align:center}.c2-obj.held span{background:#9fd07a}
.c2-hq{translate:-50% -50%;font-size:10px;font-weight:800;color:#0d1520;background:var(--own);border:2px solid #0d1520;padding:0 3px;letter-spacing:.08em}
.c2-arrow-l{translate:-50% -50%;font-size:11px;font-weight:700;color:#fff;background:rgba(160,40,30,.85);padding:0 5px;white-space:nowrap;letter-spacing:.04em}
.c2-path-l{translate:-50% -170%;font-size:12px;font-weight:700;background:rgba(10,12,10,.88);border:1px solid rgba(255,255,255,.4);color:#fff;padding:1px 7px;white-space:nowrap}.c2-path-l.atk{border-color:var(--en);color:#ffb8ab}.c2-path-l.bad{color:#bbb;border-style:dashed}
.c2-evt{translate:-8px -50%;display:flex;align-items:center;gap:8px;animation:c2fade 9s forwards}.c2-evt i{width:12px;height:12px;border-radius:50%;background:var(--en);box-shadow:0 0 0 0 rgba(224,80,63,.8);animation:c2ping 1.4s infinite}.c2-evt span{background:rgba(10,10,9,.85);border-left:3px solid var(--en);padding:3px 8px;font-size:13px;max-width:320px}
@keyframes c2ping{0%{box-shadow:0 0 0 0 rgba(224,80,63,.8)}100%{box-shadow:0 0 0 18px rgba(224,80,63,0)}}@keyframes c2fade{0%{opacity:0}5%{opacity:1}85%{opacity:1}100%{opacity:0}}
.c2-top{position:absolute;left:0;right:0;top:0;height:64px;display:flex;align-items:center;gap:22px;padding:0 16px;background:linear-gradient(rgba(10,11,9,.95),rgba(10,11,9,.82));border-bottom:1px solid var(--l);z-index:3}
.c2-top *{white-space:nowrap}.c2-id{min-width:0;max-width:24vw;overflow:hidden}.c2-id .c2-t{overflow:hidden;text-overflow:ellipsis}.c2-k{font-size:11px;letter-spacing:.24em;color:var(--acc)}.c2-t{font-size:22px;font-weight:700;letter-spacing:.04em}
.c2-date{margin-left:auto;text-align:center;min-width:220px}.c2-d{font-size:26px;font-weight:800;letter-spacing:.08em;line-height:1}.c2-date .c2-k{color:var(--dim,#9c978a);margin-top:3px}.c2-season{color:var(--acc)}
.c2-prog{height:3px;background:rgba(255,255,255,.1);margin-top:4px}.c2-prog i{display:block;height:100%;background:var(--acc)}
.c2-stats{display:flex;gap:16px;margin-left:auto}.c2-stats div{display:flex;flex-direction:column;align-items:flex-end}.c2-stats span{font-size:10px;letter-spacing:.16em;color:var(--dim,#9c978a)}.c2-stats b{font-size:20px}.c2-stats .lp{color:var(--acc)}
.c2-end{background:var(--acc);color:#14130f;border:0;font:inherit;font-weight:800;font-size:17px;letter-spacing:.12em;padding:10px 18px;cursor:pointer;flex:none}.c2-end:hover{filter:brightness(1.12)}
.c2-menu{display:flex;gap:6px}.c2-end.wait{background:transparent;color:var(--acc);border:1px solid var(--acc);animation:c2wait 1.6s ease-in-out infinite}@keyframes c2wait{50%{opacity:.6}}
.c2-vs{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--dim,#9c978a);letter-spacing:.04em;min-width:150px;max-width:280px;flex:0 1 auto;white-space:normal!important;line-height:1.25}.c2-vs span{white-space:normal!important}.c2-vs i{flex:none;width:8px;height:8px;border-radius:50%;background:#7dbd69}.c2-vs.wait i{background:var(--acc);animation:c2wait 1.1s infinite}.c2-vs.bad{color:#f2c6bf}.c2-vs.bad i{background:var(--en);animation:c2wait .8s infinite}
#c2.vs .c2-stats div:nth-child(2),#c2.vs .c2-stats div:nth-child(3){display:none}#c2.vs .c2-id{max-width:18vw}#c2.vs .c2-top{gap:16px}
.c2-plan{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0;padding:5px 8px;border:1px solid rgba(224,80,63,.55);background:rgba(120,30,20,.2);font-size:13.5px}.c2-plan b{color:#ffb8ab}
.c2-banner{position:absolute;left:50%;top:72px;transform:translateX(-50%);z-index:8;display:flex;align-items:center;gap:10px;background:rgba(12,13,11,.95);border:1px solid var(--l);border-left:3px solid var(--acc);padding:8px 14px;font-size:14.5px;max-width:min(680px,90vw)}.c2-banner.bad{border-left-color:var(--en)}.c2-banner i{flex:none;width:9px;height:9px;border-radius:50%;background:var(--acc);animation:c2wait 1s infinite}.c2-banner.bad i{background:var(--en)}.c2-helpbtn{min-width:34px;font-weight:800;font-size:16px;padding:4px 0}
.c2-btn{background:rgba(255,255,255,.06);border:1px solid var(--l);color:var(--ink,#e8e4d8);font:inherit;font-size:14px;padding:5px 11px;cursor:pointer;letter-spacing:.03em}.c2-btn:hover{border-color:rgba(232,228,216,.45)}.c2-btn.pri{background:var(--acc);color:#14130f;border-color:var(--acc);font-weight:700}.c2-btn.on{border-color:var(--acc);color:var(--acc)}.c2-btn[disabled]{opacity:.4;cursor:default}
.c2-left{position:absolute;left:12px;top:76px;bottom:52px;width:370px;display:flex;flex-direction:column;background:var(--p);border:1px solid var(--l);backdrop-filter:blur(6px);z-index:2;transform:translateZ(0)}
.c2-tabs,.c2-subtabs{display:flex;border-bottom:1px solid var(--l)}.c2-tabs button,.c2-subtabs button{flex:1;background:none;border:0;color:var(--dim,#9c978a);font:inherit;font-size:14px;letter-spacing:.08em;padding:9px 4px;cursor:pointer;text-transform:uppercase}.c2-tabs button.on,.c2-subtabs button.on{color:var(--acc);box-shadow:inset 0 -2px var(--acc)}.c2-tabs i{font-style:normal;background:rgba(255,255,255,.12);padding:0 5px;margin-left:3px;font-size:12px}
.c2-subtabs{margin:4px 0 8px}.c2-subtabs button{font-size:12.5px;padding:6px 2px}
.c2-pane{flex:1;overflow:auto;padding:10px}.c2-pane::-webkit-scrollbar{width:6px}.c2-pane::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15)}
.c2-card{background:rgba(255,255,255,.035);border:1px solid var(--l);padding:9px 11px;margin-bottom:9px}.c2-card.c2-alert{border-color:rgba(224,80,63,.6);background:rgba(120,30,20,.18)}.c2-card.sel{border-color:var(--acc)}.c2-card.tf{cursor:pointer}.c2-card.tf:hover{border-color:rgba(232,228,216,.4)}
.c2-card.done{padding:6px 10px}.c2-card.done.ok .c2-ch{color:#b5d69a}.c2-card.done.bad .c2-ch{color:#e8a598}
.c2-ch{font-weight:700;font-size:16px;letter-spacing:.02em}.c2-ch.lg{font-size:21px}.c2-ch small{font-weight:400;color:var(--dim,#9c978a);font-size:12.5px;margin-left:4px}.c2-ck{font-size:11.5px;letter-spacing:.1em;color:var(--dim,#9c978a);text-transform:uppercase}
.c2-kv{display:flex;justify-content:space-between;gap:10px;font-size:14px;padding:2px 0;border-bottom:1px dashed rgba(255,255,255,.06)}.c2-kv span{color:var(--dim,#9c978a)}.c2-kv b{font-weight:600;text-align:right}
.good{color:#a9d48a!important}.warn{color:#e8b85a!important}.bad{color:#ef8c7c!important}.own{color:#8fbaf0!important}
.c2-note{font-size:13px;color:var(--dim,#9c978a);line-height:1.4;margin:4px 0 8px}.c2-desc{font-size:13px;color:#bdb8a8;margin-top:4px;line-height:1.35}.c2-req{font-size:12px;color:#c9a46a;margin-top:3px}
.c2-order{font-family:ui-monospace,"Cascadia Mono",Menlo,monospace;font-size:12.5px;line-height:1.5;color:#d8d3c2;background:rgba(0,0,0,.25);border-left:2px solid var(--acc);padding:6px 9px;margin:6px 0;white-space:pre-wrap}.c2-order.lg{font-size:14px}
.c2-hist{font-size:12.5px;color:#c4bfae;margin-top:4px;line-height:1.4}.c2-hist b{color:var(--acc);font-weight:600}
.c2-sub{font-size:11px;letter-spacing:.2em;color:var(--dim,#9c978a);text-transform:uppercase;margin:10px 0 6px}
.c2-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.c2-row.end{justify-content:flex-end;margin-top:16px}
.c2-chip{background:rgba(216,178,90,.12);border:1px solid rgba(216,178,90,.5);color:#ecd9a8;font:inherit;font-size:13px;padding:2px 8px;cursor:pointer}.c2-chip.ok{background:rgba(143,176,105,.15);border-color:rgba(143,176,105,.6);color:#c5e0ad}
.c2-ref{font-size:12px;color:var(--acc);border:1px solid rgba(216,178,90,.5);padding:0 4px;letter-spacing:.06em;vertical-align:middle}
.c2-att{border-top:1px solid rgba(224,80,63,.3);padding-top:7px;margin-top:7px;font-size:14px}.c2-att small{color:#d8a59b}
.c2-tfh{display:flex;gap:10px;align-items:center}
.c2-right{position:absolute;right:12px;top:76px;width:350px;max-height:calc(100% - 140px);overflow:auto;z-index:2;display:flex;flex-direction:column;gap:0}
.c2-right .c2-card{background:var(--p);backdrop-filter:blur(6px)}.c2-card.tfsel{border-color:rgba(216,178,90,.6)}
.c2-x{margin-left:auto;background:none;border:0;color:#aaa;font-size:22px;cursor:pointer;align-self:flex-start}
.c2-mp{display:flex;gap:3px;align-items:center;margin:8px 0 4px}.c2-mp i{width:22px;height:7px;background:rgba(255,255,255,.12)}.c2-mp i.on{background:#9fd07a}.c2-mp i.half{background:linear-gradient(90deg,#9fd07a 50%,rgba(255,255,255,.12) 50%)}.c2-mp span{margin-left:8px;font-size:13px;color:var(--dim,#9c978a)}
.c2-seg{display:flex;margin:8px 0}.c2-seg button{flex:1;background:rgba(255,255,255,.05);border:1px solid var(--l);color:var(--dim,#9c978a);font:inherit;font-size:13.5px;padding:4px;cursor:pointer}.c2-seg button.on{color:#14130f;background:var(--acc);border-color:var(--acc);font-weight:700}
.c2-units{margin-top:6px;max-height:300px;overflow:auto}.c2-unit{display:flex;gap:7px;align-items:center;padding:4px 6px;border:1px solid transparent;cursor:pointer;font-size:14px}.c2-unit:hover{background:rgba(255,255,255,.04)}.c2-unit.on{border-color:rgba(216,178,90,.55);background:rgba(216,178,90,.08)}.c2-unit.nr{opacity:.6}
.c2-unit input{accent-color:var(--acc);margin:0}.c2-unit .nm{flex:1;display:flex;flex-direction:column;line-height:1.15}.c2-unit small{color:var(--dim,#9c978a);font-size:12px}
.hp{display:inline-block;width:36px;height:5px;background:rgba(255,255,255,.12);vertical-align:middle}.hp i{display:block;height:100%;background:#9fd07a}
.ic{width:16px;text-align:center;color:var(--acc);display:inline-block}
.vt{font-size:10.5px;padding:1px 5px;background:rgba(255,255,255,.08);color:#bdb8a5;letter-spacing:.05em}.vt.v1{background:#3c4a2c;color:#d4e6c0}.vt.v2{background:#5a4a20;color:#f0d890}.vt.v3{background:#6a2a20;color:#ffd0b0}
.c2-card.cat.locked{opacity:.55}
.c2-tech{display:flex;flex-direction:column;gap:2px}.c2-branch{margin-bottom:4px}.c2-tn{border:1px solid var(--l);border-left-width:3px;padding:6px 9px;margin-bottom:5px;font-size:13px}.c2-tn.have{border-left-color:#8fb069;background:rgba(143,176,105,.07)}.c2-tn.ordered{border-left-color:var(--acc)}.c2-tn.avail{border-left-color:#c9c4b0}.c2-tn.locked,.c2-tn.date{opacity:.55}.c2-tnh{font-weight:700;font-size:14px}.c2-tnh small{font-weight:400;color:var(--dim,#9c978a)}
.c2-log{font-size:13.5px}.c2-logd{font-size:11px;letter-spacing:.18em;color:var(--acc);margin:10px 0 3px;border-bottom:1px solid var(--l)}.c2-l{padding:3px 0 3px 8px;border-left:2px solid transparent;color:#c6c1b1;line-height:1.3}
.c2-l.good{border-left-color:#8fb069}.c2-l.bad{border-left-color:var(--en)}.c2-l.news{border-left-color:#6f9fc0;color:#a9c7dc}.c2-l.directive{border-left-color:var(--acc);color:#ecd9a8}.c2-l.history{border-left-color:#8a7a5a;color:#b9ab8a;font-style:italic}
.c2-bottom{position:absolute;left:394px;right:12px;bottom:10px;display:flex;align-items:center;gap:14px;z-index:2;pointer-events:none}.c2-bottom>*{pointer-events:auto}
.c2-views{display:flex;gap:4px}.c2-views .c2-btn{background:var(--p);font-size:13px;white-space:nowrap}
.c2-help{font-size:12.5px;color:rgba(232,228,216,.55);text-shadow:0 1px 2px #000}.c2-help b{color:rgba(232,228,216,.85);font-weight:600}
.c2-toast{position:absolute;left:50%;top:118px;transform:translateX(-50%);background:rgba(10,11,9,.92);border-left:3px solid #8fb069;padding:7px 16px;font-size:15px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:6}.c2-toast.show{opacity:1}.c2-toast.bad{border-left-color:var(--en)}
.c2-modal{position:absolute;inset:0;background:rgba(4,4,3,.55);display:flex;align-items:center;justify-content:center;z-index:10;backdrop-filter:blur(2px)}
.c2-modal-in{width:min(680px,92vw);max-height:86vh;overflow:auto;background:rgba(16,17,15,.97);border:1px solid var(--l);border-top:3px solid var(--acc);padding:20px 24px}
.c2-modal-in h1{font-size:44px;margin:6px 0 10px;letter-spacing:.05em}.c2-modal-in h2{font-size:28px;margin:6px 0 10px;font-weight:700}.c2-modal-in p{color:#cfcab9;font-size:16px}
.c2-two{display:grid;grid-template-columns:1fr 1fr;gap:18px}.c2-li{font-size:14px;padding:2px 0}.c2-li small{color:var(--dim,#9c978a)}
.c2-odds{margin-top:10px;font-size:16px;padding:6px 10px;border:1px solid currentColor}
.c2-report{max-height:50vh;overflow:auto;font-size:14px}
.c2-choose{max-width:960px;margin:9vh auto;padding:0 24px}.c2-choose h1{font-size:54px;margin:6px 0 10px}.c2-sides{display:flex;gap:16px;margin:26px 0}
.c2-side{flex:1;text-align:left;background:rgba(255,255,255,.04);border:1px solid var(--l);color:var(--ink,#e8e4d8);padding:20px;cursor:pointer;font:inherit;border-top:3px solid #888}.c2-side.UA{border-top-color:var(--ua,#f2c81a)}.c2-side.RU{border-top-color:var(--ru,#f4f4ee)}.c2-side:hover{background:rgba(255,255,255,.08)}
.c2-side-k{font-size:12px;letter-spacing:.28em;color:var(--acc)}.c2-side-t{font-size:30px;font-weight:800;margin:6px 0}.c2-side-s{font-size:16px;color:#cfcab9}.c2-side-r{font-size:13px;color:var(--dim,#9c978a);margin-top:4px}
#c2.intro-on .c2-top,#c2.intro-on .c2-left,#c2.intro-on .c2-right,#c2.intro-on .c2-bottom,#c2.intro-on .c2-labels{opacity:0;pointer-events:none}
.c2-top,.c2-left,.c2-right,.c2-bottom,.c2-labels{transition:opacity .8s}
.c2-intro{position:absolute;inset:0;z-index:20;cursor:pointer;transition:opacity .7s}.c2-intro.out{opacity:0}
.c2-black{position:absolute;inset:0;background:#000}
.c2-bar{position:absolute;left:0;right:0;height:11vh;background:#000;z-index:1}.c2-bar.t{top:0}.c2-bar.b{bottom:0}
.c2-title{position:absolute;left:8vw;top:46%;transform:translateY(-50%);opacity:0;z-index:2;text-shadow:0 2px 18px rgba(0,0,0,.9)}
.c2-ik{font-size:15px;letter-spacing:.42em;color:var(--acc);text-transform:uppercase}.c2-ip{font-size:min(9vw,104px);font-weight:800;letter-spacing:.06em;line-height:1;margin:8px 0;color:#f4f0e4}.c2-idate{font-size:min(4vw,40px);letter-spacing:.32em;color:#e0dccd;font-weight:300}
.c2-lines{position:absolute;left:8vw;right:8vw;bottom:13vh;z-index:2}.c2-lines p{font-size:19px;color:#e6e2d4;margin:6px 0;opacity:0;text-shadow:0 1px 6px #000;max-width:900px;font-family:ui-monospace,"Cascadia Mono",Menlo,monospace;font-size:15.5px}
.c2-skip{position:absolute;right:20px;bottom:3vh;font-size:12px;letter-spacing:.24em;color:rgba(255,255,255,.4);z-index:2;text-transform:uppercase}
.c2-tt{position:absolute;left:0;right:0;top:64px;bottom:0;z-index:9;background:#0b0c0a;display:flex;flex-direction:column;--cw:168px;--cg:26px}
.c2-tt-head{display:flex;align-items:center;gap:24px;padding:10px 18px;border-bottom:1px solid var(--l)}.c2-tt-head .c2-x{margin-left:0}
.c2-tt-legend{display:flex;gap:12px;margin-left:auto;font-size:12.5px;color:var(--dim,#9c978a)}.c2-tt-legend span::before{content:"";display:inline-block;width:10px;height:10px;margin-right:5px;vertical-align:-1px;border:1px solid #777;border-left-width:3px}
.c2-tt-legend .have::before{border-color:#8fb069;background:rgba(143,176,105,.25)}.c2-tt-legend .ordered::before{border-color:var(--acc)}.c2-tt-legend .avail::before{border-color:#e8e4d8}.c2-tt-legend .date::before{border-style:dashed}.c2-tt-legend .locked::before{opacity:.4}
.c2-tt-lp{font-size:13px;letter-spacing:.16em;color:var(--dim,#9c978a)}.c2-tt-lp b{font-size:24px;color:var(--acc);letter-spacing:0;margin-left:6px}
.c2-tt-body{flex:1;display:flex;min-height:0}.c2-tt-tree{flex:1;overflow:auto;padding:6px 18px 30px}.c2-tt-in{position:relative;width:max-content;min-width:100%}
.c2-tt-wires{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}.c2-tt-wires path{fill:none;stroke:rgba(232,228,216,.22);stroke-width:2}.c2-tt-wires path.have{stroke:rgba(143,176,105,.75)}.c2-tt-wires path.avail{stroke:rgba(232,228,216,.6)}.c2-tt-wires path.locked{stroke-dasharray:4 4}
.c2-tt-grid{display:grid;column-gap:var(--cg);row-gap:8px;position:relative}.c2-tt-grid.sub{margin:6px 0 4px;padding:8px 0 6px;border-top:1px dashed rgba(232,228,216,.1)}
.c2-tt-tiers{position:sticky;top:-6px;z-index:2;background:rgba(11,12,10,.97);padding:6px 0;border-bottom:1px solid var(--l)}.c2-tt-tiers div{font-size:11.5px;letter-spacing:.18em;text-transform:uppercase;color:rgba(232,228,216,.35)}.c2-tt-tiers div.now{color:var(--dim,#9c978a)}.c2-tt-tiers i{color:var(--acc);font-style:normal;letter-spacing:.05em}
.c2-tt-line{margin-bottom:14px;padding-bottom:6px;border-bottom:1px solid rgba(232,228,216,.06)}
.c2-tn2,.c2-tv{position:relative;z-index:1;text-align:left;font:inherit;color:var(--ink,#e8e4d8);background:rgba(28,30,25,.96);border:1px solid var(--l);border-left-width:3px;padding:6px 9px;cursor:pointer;min-height:46px}
.c2-tn2:hover,.c2-tv:hover{border-color:rgba(232,228,216,.5)}.c2-tn2.sel,.c2-tv.sel{outline:2px solid var(--acc);outline-offset:1px}
.c2-tn2 .nm{font-size:13.5px;font-weight:700;line-height:1.15}.c2-tn2 .mt,.c2-tv .mt{font-size:11.5px;color:var(--dim,#9c978a);margin-top:3px}
.c2-tn2 .kt{font-size:9.5px;letter-spacing:.08em;background:rgba(216,178,90,.18);color:#ecd9a8;padding:0 4px;margin-right:5px;vertical-align:1px;text-transform:uppercase}.c2-tn2 .kt.u{background:rgba(79,143,224,.2);color:#bcd5f5}
.c2-tn2.have,.c2-tv.have{border-left-color:#8fb069;background:rgba(40,52,32,.96)}.c2-tn2.have .mt,.c2-tv.have .mt{color:#b5d69a}.c2-tn2.ordered,.c2-tv.ordered{border-left-color:var(--acc)}.c2-tn2.ordered .mt{color:var(--acc)}
.c2-tn2.avail,.c2-tv.avail{border-left-color:#e8e4d8;box-shadow:0 0 0 1px rgba(232,228,216,.15)}.c2-tn2.date,.c2-tv.date{border-style:dashed;opacity:.75}.c2-tn2.locked,.c2-tv.locked{opacity:.45}
.c2-tv{border-left-width:4px;min-height:62px}.c2-tv .nm{font-size:17px;font-weight:800;letter-spacing:.02em}.c2-tv .ro{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--acc)}
.c2-tt-dd{display:inline-block;margin-top:6px;background:rgba(255,255,255,.04);border:1px solid var(--l);color:var(--ink,#e8e4d8);font:inherit;font-size:13px;padding:3px 10px;cursor:pointer;letter-spacing:.04em}.c2-tt-dd.open{border-color:rgba(216,178,90,.6);color:#ecd9a8}.c2-tt-dd b{color:#b5d69a}.c2-tt-dd i{font-style:normal;font-size:11px;background:var(--acc);color:#14130f;padding:0 4px;margin-left:4px}
.c2-tt-side{width:380px;flex:none;border-left:1px solid var(--l);display:flex;flex-direction:column;min-height:0}.c2-tt-view{position:relative;height:300px;flex:none;background:radial-gradient(ellipse at 50% 40%,#2a2d25,#121310)}.c2-tt-canvas{width:100%;height:100%;display:block;cursor:grab}
.c2-tt-vl{position:absolute;left:10px;bottom:8px;font-size:12px;letter-spacing:.06em;color:#d8d3c2;text-shadow:0 1px 2px #000;pointer-events:none}
.c2-tt-info{flex:1;overflow:auto;padding:12px 16px}.c2-fx{font-size:13.5px;line-height:1.35;padding:2px 0}.c2-fx.g{color:#b5d69a}.c2-fx.b{color:#e8a598}.c2-tt-req{width:100%;margin-top:12px;padding:8px}
.c2-ttsum .c2-ttopen{width:100%;margin-top:10px;padding:8px}
.c2-goal{position:absolute;top:70px;left:394px;max-width:calc(100% - 394px - 374px);min-width:320px;z-index:3;background:rgba(12,13,11,.92);border:1px solid var(--l);border-left:3px solid var(--acc);backdrop-filter:blur(4px)}.c2-goal.hidden{display:none}
.c2-goal-h{display:flex;align-items:center;gap:10px;width:100%;background:none;border:0;color:var(--ink,#e8e4d8);font:inherit;padding:6px 10px;cursor:pointer;text-align:left}
.c2-goal-k{font-size:10.5px;letter-spacing:.2em;color:var(--acc);flex:none}.c2-goal-t{font-size:14.5px;font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.c2-goal-p{position:relative;flex:none;width:110px;height:7px;background:rgba(255,255,255,.12)}.c2-goal-p i{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#8fb069,#b5d69a)}.c2-goal-p em{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--acc)}
.c2-goal-h b{font-size:16px;color:#b5d69a;flex:none}.c2-goal-h small{font-size:11.5px;color:var(--dim,#9c978a);letter-spacing:.06em;flex:none}
.c2-goal-d{padding:0 12px 10px;border-top:1px dashed var(--l)}.c2-goal-win{font-size:13px;margin-top:6px;color:#d8d3c2;line-height:1.4}.c2-goal-win b{color:var(--acc);font-weight:600}
.c2-tbar{position:absolute;left:calc(394px + (100% - 394px) / 2);bottom:52px;transform:translateX(-50%);z-index:6;display:flex;align-items:center;gap:12px;background:rgba(12,13,11,.95);border:1px solid var(--l);border-top:2px solid #ffb35a;padding:8px 12px;font-size:14px;max-width:min(860px,94vw)}.c2-tbar .c2-seg{margin:0}.c2-tbar .c2-seg button{padding:4px 10px}
.c2-tbar-t b{color:#ffd9a8}.c2-tgt{border-color:rgba(255,179,90,.6)}.c2-batc.sel{border-color:#ffb35a}
.c2-ammo{display:flex;gap:3px;margin:4px 0}.c2-ammo i{flex:1;height:6px;background:rgba(255,255,255,.1)}.c2-ammo i.on{background:#e8b85a}
.c2-goalm{translate:-50% -50%;display:flex;align-items:center;gap:2px;background:rgba(20,18,10,.85);border:1px solid var(--acc);padding:0 5px;font-size:12px;font-weight:800;color:var(--acc)}.c2-goalm.held{border-color:#8fb069;color:#b5d69a}.c2-goalm i{font-style:normal}
.c2-bat{translate:-50% -50%;filter:drop-shadow(0 1px 2px rgba(0,0,0,.8))}.c2-bat.used{opacity:.55}.c2-bat.down{opacity:.3}.c2-bat.sel{filter:drop-shadow(0 0 5px #ffb35a)}
.c2-hub{translate:-50% -50%;display:flex;align-items:center;gap:4px;font-size:11.5px;white-space:nowrap;background:rgba(14,22,12,.85);border:1px solid #8fb069;color:#d6ecc4;padding:0 6px 0 3px}.c2-hub i{font-style:normal;color:#a9d48a}.c2-hub.half{border-color:#e8b85a;color:#f2dcae}.c2-hub.cut{border-color:var(--en);color:#ffc4b8}
.c2-intd{translate:-50% 60%;font-size:11px;font-weight:700;color:#ffb8ab;background:rgba(60,12,8,.8);padding:0 5px;white-space:nowrap}
.c2-left .c2-tabs button{font-size:13px;letter-spacing:.05em;padding:9px 2px;line-height:1.15}
`;
  document.head.appendChild(Object.assign(document.createElement('style'), { id: 'c2-css', textContent: css }));
}
