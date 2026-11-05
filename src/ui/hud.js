import * as THREE from 'three';
import { WEAPONS } from '../config.js';
import { ROADS, MAP_SIZE, DEPLOY_ZONES } from '../world/city.js';
import { TUNING } from '../config.js';
import { unitSymbol, unitKindOf, UNIT_TYPE_NAME, ORDER_ICONS } from './symbols.js';

// Battle HUD. Look & tokens: src/ui/style.css. All per-frame DOM writes are change-guarded
// (each element remembers what it last showed), slow panels refresh at 4 Hz.
const C = { friend: '#5aa9dc', hostile: '#e2574a', neutral: '#a7a69c', accent: '#e4a948', ok: '#7fbb6a', t1: '#ece8de' };   // = style.css tokens
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const set = (el, k, v) => { if (el['_' + k] !== v) { el['_' + k] = v; el[k] = v; } };              // guarded property write
const setS = (el, k, v) => { if (el['_s' + k] !== v) { el['_s' + k] = v; el.style[k] = v; } };      // guarded style write
const tog = (el, c, on) => { on = !!on; const k = '_c' + c; if (el[k] !== on) { el[k] = on; el.classList.toggle(c, on); } };

export class HUD {
  constructor(game) {
    this.g = game; game.hud = this;
    this.cards = document.getElementById('cards'); this.info = document.getElementById('unitinfo');
    this.alerts = document.getElementById('alerts'); this.mm = document.getElementById('minimap'); this.mctx = this.mm.getContext('2d');
    this.selected = new Set(); this.groups = {}; this.banners = new Map();
    this.timerEl = document.getElementById('timer'); this.phaseEl = document.getElementById('phase'); this.fpsEl = document.getElementById('fps');
    this.forcesEl = document.getElementById('forces');
    document.getElementById('hud').classList.remove('hidden');
    // objective chips: A / B exist in the page; further objectives (C, D, ...) are cloned from A. All sit in one row under the clock.
    const tb = document.getElementById('topbar'), row = document.getElementById('objRow') || tb, tplA = document.getElementById('obj-A');
    for (const el of tb.querySelectorAll('.objective.extra')) el.remove();
    for (const o of game.objectives) {
      if (!document.getElementById(`obj-${o.id}`) && tplA) {
        const el = tplA.cloneNode(true); el.id = `obj-${o.id}`; el.classList.add('extra'); el.querySelector('.tag').textContent = o.id; row.appendChild(el);
      }
      const n = document.querySelector(`#obj-${o.id} .name`); if (n) n.textContent = o.name;
    }
    // keep the chips in letter order; objectives the map doesn't have (e.g. B on a one-objective map) are hidden
    for (const el of [...row.querySelectorAll('.objective')].sort((a, b) => a.id.localeCompare(b.id))) row.appendChild(el);
    for (const el of tb.querySelectorAll('.objective')) el.classList.toggle('hidden', !game.objectives.some(o => `obj-${o.id}` === el.id));
    this.objEls = game.objectives.map(o => { const el = document.getElementById(`obj-${o.id}`); return { o, el, fill: el.querySelector('.fill'), state: el.querySelector('.state') }; });
    // ticket blocks (shown only when the game runs a ticket system: game.tickets = { player, enemy, max })
    const tkEl = (id, f) => { const el = document.getElementById(id); if (!el) return null; el.style.setProperty('--tape', f?.color || ''); el.querySelector('.tk-side').textContent = f?.name || ''; return { el, num: el.querySelector('.tk-num'), i: el.querySelector('.tk-bar i'), b: el.querySelector('.tk-bar b'), rate: el.querySelector('.tk-rate'), disp: null, hist: [], r: 0 }; };
    this.tk = { player: tkEl('tkF', game.playerFaction), enemy: tkEl('tkH', game.enemyFaction) };
    tb.classList.toggle('many', game.objectives.length > 2);
    // order buttons: icons in front of the labels
    this.orderBtns = {};
    for (const b of document.querySelectorAll('#orders button')) { this.orderBtns[b.dataset.o] = b; if (!b.querySelector('.ico') && ORDER_ICONS[b.dataset.o]) b.insertAdjacentHTML('afterbegin', ORDER_ICONS[b.dataset.o]); }
    this.mortarEl = document.getElementById('mortarCount');
    this.rings(); this.sizeMinimap(); this.drawMinimapBase(); this.rebuildCards();
    addEventListener('resize', () => { this.sizeMinimap(); });
    this.mm.addEventListener('mousedown', e => { if (e.button !== 0) return; this.mmDrag = true; this.minimapClick(e); });
    addEventListener('mousemove', e => { if (this.mmDrag) this.minimapClick(e); });
    addEventListener('mouseup', () => { this.mmDrag = false; });
    this.mm.addEventListener('contextmenu', e => { e.preventDefault(); this.minimapClick(e, true); });
    this.frames = 0; this.fpsT = 0;
    document.getElementById('startBattle').addEventListener('click', () => game.startBattle());
  }
  battleStarted() { document.getElementById('deploybar').classList.add('hidden'); this.alert(`Battle started — capture ${this.g.objectives.map(o => o.name).join(' and the ')}`, 'good'); }
  // ------------------------------------------------------------ selection rings
  rings() {
    const g = this.g;
    const ringGeo = new THREE.RingGeometry(0.55, 0.72, 24); ringGeo.rotateX(-Math.PI / 2);
    this.ringMesh = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xd8b25a, transparent: true, opacity: 0.85, depthWrite: false }), 200);
    this.ringMesh.frustumCulled = false; this.ringMesh.renderOrder = 5; g.scene.add(this.ringMesh);
    const vg = new THREE.RingGeometry(4.6, 5.0, 48); vg.rotateX(-Math.PI / 2);
    this.vRing = new THREE.InstancedMesh(vg, this.ringMesh.material, 20); this.vRing.frustumCulled = false; g.scene.add(this.vRing);
    const lineMat = new THREE.LineDashedMaterial({ color: 0xd8b25a, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0.7 });
    this.orderLines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat); this.orderLines.frustumCulled = false; g.scene.add(this.orderLines);
    // v6: fire marks of men on individual fire tasks (trench clearing: the fire group's rounds ahead of the assault group)
    this.fireLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xd8483a, dashSize: 0.6, gapSize: 0.9, transparent: true, opacity: 0.75 })); this.fireLines.frustumCulled = false; g.scene.add(this.fireLines);
    this.preview = new THREE.InstancedMesh(new THREE.CircleGeometry(0.35, 10).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }), 80);
    this.preview.count = 0; this.preview.frustumCulled = false; g.scene.add(this.preview);
  }
  updateRings() {
    const m = new THREE.Matrix4(); let n = 0, vn = 0; const pts = [], fpts = [];
    for (const u of this.selected) {
      if (u.type === 'squad') {
        if (u.mounted) continue;
        for (const s of u.soldiers) if (s.alive && s.inside !== 'btr' && n < 200) { m.makeTranslation(s.pos.x, s.pos.y + 0.08, s.pos.z); this.ringMesh.setMatrixAt(n++, m); }
        const c = u.center(); for (const s of u.effective) if (s.goal && s.path) { pts.push(s.pos.x, 0.2, s.pos.z, s.goal[0], 0.2, s.goal[1]); }
        for (const s of u.effective) if (s.fireAt) fpts.push(s.pos.x, s.pos.y + 1.1, s.pos.z, s.fireAt.p.x, 0.5, s.fireAt.p.z);
      } else if (!u.destroyed && vn < 20) {
        m.makeRotationY(u.heading).setPosition(u.pos.x, 0.1, u.pos.z); this.vRing.setMatrixAt(vn++, m);
        if (u.path) { let px = u.pos.x, pz = u.pos.z; for (let i = u.pathI; i < u.path.length; i++) { pts.push(px, 0.25, pz, u.path[i][0], 0.25, u.path[i][1]); [px, pz] = u.path[i]; } }
      }
    }
    if (n || this._rn) { this.ringMesh.count = n; this.ringMesh.instanceMatrix.needsUpdate = true; } this._rn = n;
    if (vn || this._vn) { this.vRing.count = vn; this.vRing.instanceMatrix.needsUpdate = true; } this._vn = vn;
    if (fpts.length || this._fn) { const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.Float32BufferAttribute(fpts, 3)); this.fireLines.geometry.dispose(); this.fireLines.geometry = fg; this.fireLines.computeLineDistances(); } this._fn = fpts.length;
    // order lines: a new geometry (GPU buffer) only when they changed - not every frame for an idle / empty selection
    const L = this._lp; if (L && L.length === pts.length && pts.every((x, i) => x === L[i])) return;
    this._lp = pts;
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.orderLines.geometry.dispose(); this.orderLines.geometry = geo; this.orderLines.computeLineDistances();
  }
  // formation preview dots: green, or pale blue where the man will be in cover (p[2], squad.previewSlots)
  showPreview(points) {
    const m = new THREE.Matrix4(), c = this._pc ||= [new THREE.Color(0x8fb069), new THREE.Color(0x7fd0ff)]; this.preview.count = Math.min(80, points.length);
    points.slice(0, 80).forEach((p, i) => { m.makeTranslation(p[0], 0.15, p[1]); this.preview.setMatrixAt(i, m); this.preview.setColorAt(i, c[p[2] ? 1 : 0]); });
    this.preview.instanceMatrix.needsUpdate = true; if (this.preview.instanceColor) this.preview.instanceColor.needsUpdate = true;
  }
  // area-fire marker: a red ring on the ground for the duration of the fire order
  groundMarker(p) {
    const g = this.g; if (this._gm) { g.scene.remove(this._gm); clearTimeout(this._gmT); }
    const m = new THREE.Mesh(new THREE.RingGeometry(4.2, 5, 40), new THREE.MeshBasicMaterial({ color: 0xd8483a, transparent: true, opacity: 0.55, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(p.x, 0.25, p.z); m.renderOrder = 3; g.scene.add(m); this._gm = m;
    this._gmT = setTimeout(() => { g.scene.remove(m); if (this._gm === m) this._gm = null; }, 30000);
  }
  // ------------------------------------------------------------ roster
  // Order-of-battle roster: a compact, grouped, scrollable list (left edge).
  // Squads are nested under the carrier that brought them; groups collapse; Tab folds the whole panel to symbols.
  rebuildCards() {
    this.cards.innerHTML = ''; this.cards.className = 'roster' + (this.rosterMini ? ' mini' : '');
    this.cardEls = new Map();
    const units = this.g.playerUnits.filter(u => !(u.type === 'squad' && u.crew && u.destroyed));
    const groupOf = u => u.type === 'vehicle' ? (u.kind === 'medevac' ? 'MEDICAL' : u.kind === 'spg' ? 'ARTILLERY' : u.kind === 'tank' ? 'ARMOUR' : 'MOTOR RIFLES') : u.crew ? 'CREWS' : u.kind === 'atgm' || u.kind === 'fpv' ? 'SUPPORT' : u.carrier && units.includes(u.carrier) ? null : u.assault ? 'ASSAULT' : 'MOTOR RIFLES';
    const order = ['MOTOR RIFLES', 'ASSAULT', 'ARMOUR', 'SUPPORT', 'ARTILLERY', 'MEDICAL', 'CREWS'];
    const head = document.createElement('div'); head.className = 'rhead';
    head.innerHTML = `<span class="label">Order of battle<span class="rcount"></span></span><span class="rbtn" title="Fold the roster (Tab)"></span>`;
    head.querySelector('.rbtn').addEventListener('mousedown', e => { e.stopPropagation(); this.rosterMini = !this.rosterMini; this.rebuildCards(); });
    this.rcountEl = head.querySelector('.rcount');
    this.cards.appendChild(head);
    const body = document.createElement('div'); body.className = 'rbody'; this.cards.appendChild(body);
    this.rosterFold ||= {};
    const row = (u, nested) => {
      const el = document.createElement('div'); el.className = 'r' + (nested ? ' nest' : '');
      el.innerHTML = `<span class="g"></span><span class="ic">${unitSymbol(unitKindOf(u), 'friend')}</span><span class="tx"><span class="nm">${esc(u.name)}</span><span class="st"></span></span><span class="mn"></span><span class="bars"><i class="hp"><b></b></i><i class="am"><b></b></i><i class="mo"><b></b></i></span>`;
      el.title = u.name;
      el.addEventListener('mousedown', e => { e.stopPropagation(); if (e.button !== 0) return; this.select([u], e.shiftKey); this.g.sfx('ui_select'); });
      el.addEventListener('dblclick', () => { const c = u.center(); this.g.cam.lookAt(c.x, c.z); });
      const q = s => el.querySelector(s);
      this.cardEls.set(u, { el, g: q('.g'), st: q('.st'), mn: q('.mn'), hp: q('.hp b'), am: q('.am b'), mo: q('.mo b'), moI: q('.mo') }); return el;
    };
    this.rosterGroups = [];
    for (const grp of order) {
      const members = units.filter(u => groupOf(u) === grp); if (!members.length) continue;
      const h = document.createElement('div'); const folded = this.rosterFold[grp]; h.className = 'rg' + (folded ? ' folded' : '');
      h.innerHTML = `<span class="chev"></span><span>${grp}</span><span class="rgn"></span>`; h.dataset.grp = grp;
      h.title = 'Click to fold · Ctrl-click selects the group';
      h.addEventListener('mousedown', e => { e.stopPropagation(); if (e.shiftKey || e.ctrlKey) { this.select(members.flatMap(m => [m, ...units.filter(q => q.carrier === m)]), e.shiftKey); return; } this.rosterFold[grp] = !folded; this.rebuildCards(); });
      body.appendChild(h);
      this.rosterGroups.push({ el: h.querySelector('.rgn'), members: [...members, ...members.flatMap(m => units.filter(q => q.type === 'squad' && q.carrier === m && groupOf(q) === null))] });
      if (folded) { for (const u of members) this.cardEls.set(u, null); for (const q of units) if (q.carrier && members.includes(q.carrier) && groupOf(q) === null) this.cardEls.set(q, null); continue; }
      for (const u of members) {
        body.appendChild(row(u, false));
        if (u.type === 'vehicle') for (const q of units.filter(q => q.type === 'squad' && q.carrier === u && groupOf(q) === null)) body.appendChild(row(q, true));
      }
    }
    // squads whose carrier is gone and that weren't placed yet
    for (const u of units) if (!this.cardEls.has(u)) body.appendChild(row(u, false));
    this.rosterUnits = units;
  }
  updateCards() {
    const gOf = new Map(); for (const [k, v] of Object.entries(this.groups)) for (const u of v) if (!gOf.has(u)) gOf.set(u, k);
    for (const [u, r] of this.cardEls) {
      if (!r) continue;
      const dead = u.destroyed;
      tog(r.el, 'dead', dead); tog(r.el, 'sel', this.selected.has(u)); tog(r.el, 'mounted', u.type === 'squad' && u.mounted);
      let men, hp, am, mo, st, cls = '';
      if (u.type === 'squad') {
        const eff = u.effective.length, wnd = u.soldiers.filter(s => s.state === 'critical' || s.state === 'stable').length;
        men = `${eff}${wnd ? '+' + wnd : ''}`; hp = eff / u.soldiers.length; am = u.ammoFrac(); mo = u.morale / 100;
        st = dead ? 'LOST' : u.routing ? 'ROUTING' : u.pinned ? 'PINNED' : u.mounted ? 'MOUNTED' : u.building ? (u.inCellar ? 'IN CELLAR' : 'GARRISONED') : u.status?.() || u.moraleState();
        cls = u.routing ? 'rout' : /PINNED|SHAKEN|WAVERING/.test(st) ? 'warn' : /GARRISON|MOVING|CLEAR/.test(st) ? 'act' : '';
      } else {
        men = u.destroyed ? '×' : `${u.crew}`; hp = Math.max(0, u.hp / u.def.hp); am = u.ammoFrac(); mo = u.destroyed ? 0 : 1;
        st = u.moraleState() + (u.passengers ? ' · LOADED' : '');
        cls = /FIRE|IMMOB|DAMAGED|CREW/.test(st) ? 'warn' : '';
      }
      set(r.mn, 'textContent', men); set(r.st, 'textContent', st); set(r.st, 'className', 'st ' + cls);
      setS(r.hp, 'width', `${Math.round(hp * 100)}%`); setS(r.am, 'width', `${Math.round(Math.min(1, am) * 100)}%`); setS(r.mo, 'width', `${Math.round(Math.min(1, mo) * 100)}%`);
      set(r.moI, 'className', 'mo' + (u.type === 'squad' && u.routing ? ' bad' : mo < 0.45 ? ' warn' : ''));
      set(r.g, 'textContent', gOf.get(u) || '');
    }
    let fit = 0, all = 0;
    for (const u of this.rosterUnits || []) { if (u.type === 'squad' && !u.crew) { fit += u.effective.length; all += u.soldiers.length; } }
    if (this.rcountEl) set(this.rcountEl, 'textContent', `${fit}/${all} men`);
    for (const gr of this.rosterGroups || []) set(gr.el, 'textContent', `${gr.members.filter(u => !u.destroyed).length}/${gr.members.length}`);
  }
  select(units, add = false) {
    if (!add) this.selected.clear();
    for (let u of units) { if (u?.medevac) u = u.medevac; if (u && (u.type === 'squad' ? !u.destroyed : !u.destroyed) && u.side === 'player') this.selected.add(u); }   // a medevac crew selects its pickup
    this.updateInfo(true); if (this.cardEls) this.updateCards();
  }
  // ------------------------------------------------------------ order bar + unit panel
  updateOrders(sel) {
    const g = this.g, B = this.orderBtns, inp = g.input, deploy = g.phase === 'deploy';
    const sq = sel.filter(u => u.type === 'squad');
    const en = {
      run: true, holdfire: sel.length > 0, halt: sel.length > 0,
      garrison: sq.some(u => !u.mounted), smoke: sq.some(u => !u.mounted),
      mount: sel.some(u => u.type === 'squad' ? (u.mounted || (u.carrier && !u.carrier.destroyed)) : !!u.passengers || (deploy && (u.kind === 'btr' || u.kind === 'ifv'))),
      resupply: sq.some(u => u.carrier && !u.carrier.destroyed && !u.mounted),
      fireground: sel.length > 0 && !deploy, mortar: g.mortars > 0 && !deploy,
    };
    for (const k in B) set(B[k], 'disabled', !en[k]);
    tog(B.holdfire, 'on', sel.length > 0 && sel.every(u => u.holdFire));
    tog(B.run, 'on', !!inp?.runMode);
    tog(B.fireground, 'on', inp?.mode === 'fireground'); tog(B.mortar, 'on', inp?.mode === 'mortar');
    set(this.mortarEl, 'textContent', String(g.mortars));
  }
  updateInfo(force) {
    const sel = [...this.selected].filter(u => !u.destroyed);
    this.updateOrders(sel);
    const u = this.inspect || (sel.length === 1 ? sel[0] : null);
    let html = '';
    if (u) html = this.unitPanel(u);
    else if (sel.length > 1) {
      const men = sel.reduce((n, q) => n + (q.type === 'squad' ? q.effective.length : 0), 0), veh = sel.filter(q => q.type === 'vehicle').length;
      html = `<div class="ui-head"><div class="tt"><h4>${sel.length} units selected</h4><div class="sub">${[men ? `${men} men` : '', veh ? `${veh} vehicle${veh > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')} · right-drag to form a line</div></div></div><div class="ui-multi">${sel.slice(0, 18).map(q => unitSymbol(unitKindOf(q), 'friend')).join('')}</div>`;
    }
    if (html !== this.infoHTML) { this.infoHTML = html; this.info.innerHTML = html; }
    setS(this.info, 'display', html ? 'block' : 'none');
    tog(this.info, 'enemy', u && u.side !== 'player');
  }
  unitPanel(u) {
    const aff = u.side === 'player' ? 'friend' : 'hostile', kind = unitKindOf(u);
    const row = (a, b) => `<div><span>${a}</span><b>${b}</b></div>`;
    const meter = (label, f, val, cls) => `<span>${label}</span><div class="meter ${cls}"><i style="width:${Math.round(Math.max(0, Math.min(1, f)) * 100)}%"></i></div><b>${val}</b>`;
    let chip = '', meters = '', rows = '';
    if (u.type === 'squad') {
      const s = u.soldiers, eff = u.effective.length, ms = u.moraleState(), am = u.ammoFrac();
      chip = u.routing ? '<span class="chip bad">Routing</span>' : u.pinned ? '<span class="chip warn">Pinned</span>' : u.mounted ? '<span class="chip dim">Mounted</span>' : u.building ? '<span class="chip ok">Garrisoned</span>' : '';
      meters = meter('Strength', eff / s.length, `${eff}/${s.length}`, 'friend')
        + meter('Morale', u.morale / 100, `${ms[0] + ms.slice(1).toLowerCase()} ${Math.round(u.morale)}`, u.routing ? 'bad' : u.morale < 45 ? 'warn' : 'ok')
        + meter('Ammo', am, `${Math.round(am * 100)}%`, am < 0.25 ? 'bad' : am < 0.5 ? 'warn' : '');
      rows += row('Fit / wounded / KIA', `${eff} / ${s.filter(x => x.state === 'critical' || x.state === 'stable' || x.state === 'light').length} / ${s.filter(x => x.state === 'dead').length}`);
      if (u.side === 'player') rows += row('Mags per man', s.filter(x => x.effective).map(x => x.weaponKey === 'rpg7' ? `${x.inMag + x.mags}r` : `${x.mags}`).join(' '));
      rows += row('Status', u.mounted ? `Mounted in ${esc(u.carrier?.name)}` : u.building ? (u.inCellar ? 'In the cellar (G: back up)' : u.building.house ? 'Garrisoned (G: cellar)' : 'Garrisoned') : u.order?.type === 'move' ? (u.run ? 'Running' : 'Moving') : 'Holding');
      if (u.holdFire) rows += row('Fire', 'Holding fire');
      const sp = u.support;
      if (sp && sp.drones != null) { rows += row('System', 'FPV strike drones (PG-7VL)'); rows += row('Drones', `${sp.drones}${sp.drone ? ' + 1 airborne' : ''} / ${sp.capacity?.() ?? 5}`); rows += row('Team', sp.status()); }
      else if (sp) { rows += row('System', `${sp.W.name} · ${sp.W.range} m`); rows += row('Missiles', `${sp.ammo + (sp.loaded ? 1 : 0)}${sp.missile ? ' + 1 in flight' : ''}`); rows += row('Team', sp.status()); }
      if (u.carrier && u.side === 'player') rows += row('Carrier', `${esc(u.carrier.name)}${u.carrier.destroyed ? ' (lost)' : ''}`);
    } else {
      const st = u.moraleState(), hull = Math.max(0, u.hp / u.def.hp), crewMax = u.def.crew || 3, am = u.ammoFrac();
      chip = st === 'OPERATIONAL' ? '' : `<span class="chip ${/FIRE|DESTROY/.test(st) ? 'bad' : 'warn'}">${st.toLowerCase()}</span>`;
      meters = meter('Hull', hull, `${Math.round(hull * 100)}%`, hull < 0.35 ? 'bad' : hull < 0.65 ? 'warn' : 'friend')
        + meter('Crew', Math.max(0, u.crew) / crewMax, `${Math.max(0, u.crew)}/${crewMax}`, u.crew < crewMax ? 'warn' : 'ok')
        + meter('Main gun', am, `${u.weapons[0].ammo}`, am < 0.2 ? 'bad' : am < 0.45 ? 'warn' : '');
      const w = u.weapons[0];
      if (u.hudPanel) ({ meters, rows } = u.hudPanel(meter, row));   // e.g. the medevac pickup (game/medevac.js)
      else if (u.kind === 'spg') {
        rows += row('Gun', `${WEAPONS[w.key].name} · ${w.ammo}/${u.def.ammo} HE-Frag`);
        rows += row('Fire mission', `${u.def.salvo} rds · ${Math.round(60 / u.def.interval)} rpm · FIRE AT (C)`);
        rows += row('Range', `indirect ≥ ${u.def.minRange >= 1000 ? (u.def.minRange / 1000).toFixed(1) + ' km' : u.def.minRange + ' m'} · direct ≤ ${(u.def.directRange / 1000).toFixed(1)} km`);
        rows += row('Into / out of action', `${u.def.deployT} s / ${u.def.packT} s${u.def.arc ? ' · ±30°' : ' · 360°'}`);
        if (u.def.mg) rows += row('Kord 12.7 mm', `${u.weapons[1].ammo}`);
      } else {
        rows += row('Main gun', u.kind === 'tank' ? `APFSDS ${w.ap} · HE-FRAG ${w.he}` : `${WEAPONS[w.key]?.name || ''} · ${w.ammo} rds`);
        if (u.gun100) rows += row('100 mm', `${u.gun100.ammo} HE-Frag`);
        if (u.atgm) rows += row('ATGM', u.atgmDisabled ? 'launcher destroyed' : `${WEAPONS[u.atgm.key].name.split(' (')[0]} · ${u.atgm.ammo}`);
        rows += row('Coax PKT', `${u.weapons[1].ammo}`);
        if (u.supply) rows += row('Resupply stock', `${u.supply.rifle} rds · ${u.supply.rpg} rkt`);
        if (u.passengers) rows += row('Carrying', esc(u.passengers.name));
      }
    }
    return `<div class="ui-head">${unitSymbol(kind, aff)}<div class="tt"><h4>${u.side === 'player' ? '' : 'Enemy '}${esc(u.name)}</h4><div class="sub">${UNIT_TYPE_NAME[kind] || ''}</div></div>${chip}</div><div class="ui-meters">${meters}</div><div class="kv">${rows}</div>`;
  }
  // ------------------------------------------------------------ banners
  // World-anchored unit flags. Far-away banners collapse to the symbol and fade; selected ones stay crisp.
  updateBanners() {
    const cam = this.g.renderer.camera, v = new THREE.Vector3(), cp = cam.position, W = innerWidth, H = innerHeight;
    const all = [...this.g.squads, ...this.g.vehicles];
    for (const u of all) {
      let b = this.banners.get(u);
      const show = !u.destroyed && (u.side === 'player' || u.spotted) && !(u.type === 'squad' && u.mounted) && !(u.type === 'squad' && u.medevac);
      if (!show) { if (b) setS(b.el, 'display', 'none'); continue; }
      if (!b) {
        const el = document.createElement('div'), friend = u.side === 'player'; el.className = 'banner ' + (friend ? 'f' : 'h');
        if (friend) el.style.setProperty('--tape', u.faction.color);
        el.innerHTML = `<div class="pin"></div><div class="flag">${unitSymbol(unitKindOf(u), friend ? 'friend' : 'hostile')}<span class="bn">${esc(friend ? u.name : (u.type === 'squad' ? 'Infantry' : u.name))}</span></div><div class="mb"><i></i></div><div class="pole"></div>`;
        document.body.appendChild(el); b = { el, bar: el.querySelector('.mb i'), pin: el.querySelector('.pin') }; this.banners.set(u, b);
      }
      const c = u.type === 'squad' ? (u.leader || u.alive[0])?.pos || u.center() : u.pos;
      v.set(c.x, (u.type === 'squad' ? 2.4 : 4.2) + (u.type === 'squad' && u.leader?.inside && u.leader.inside !== 'btr' ? u.leader.pos.y : 0), c.z);
      const dist = v.distanceTo(cp); v.project(cam);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) { setS(b.el, 'display', 'none'); continue; }
      setS(b.el, 'display', 'flex');
      const x = Math.round((v.x * 0.5 + 0.5) * W), y = Math.round((-v.y * 0.5 + 0.5) * H);
      setS(b.el, 'transform', `translate(${x}px,${y}px) translate(-50%,-100%)`);
      const sel = this.selected.has(u);
      const alarm = u.type === 'squad' && (u.routing || u.pinned);   // a unit in trouble stays readable (name + full opacity) at any distance
      tog(b.el, 'sel', sel); tog(b.el, 'far', !sel && !alarm && dist > 140);
      setS(b.el, 'opacity', sel || alarm ? '1' : String(Math.round(Math.max(0.45, Math.min(1, 1 - (dist - 110) / 260)) * 20) / 20));
      // status sign, by priority: ROUTING > PINNED > the unit's own note (e.g. a vehicle crew FIGHTING FIRE)
      const rout = u.type === 'squad' && !!u.routing, note = rout ? 'ROUTING' : u.type === 'squad' && u.pinned ? 'PINNED' : (u.bannerNote || '');
      if (note !== b.note) {
        b.note = note; b.pin.textContent = note; b.pin.style.display = note ? 'flex' : 'none';
        b.pin.className = 'pin' + (rout ? ' rout' : /FIRE/.test(note) ? ' fire' : ''); tog(b.el, 'rout', rout);
      }
      const val = u.type === 'squad' ? u.morale : Math.max(0, u.hp / u.def.hp * 100);
      setS(b.bar, 'width', `${Math.round(val)}%`); set(b.bar, 'className', u.type === 'squad' && u.routing ? 'bad' : val < 45 ? 'warn' : '');
    }
  }
  // ------------------------------------------------------------ top bar
  updateTop() {
    const g = this.g, left = Math.max(0, g.roundLen - g.time);
    set(this.timerEl, 'textContent', `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`);
    tog(this.timerEl, 'low', g.phase !== 'deploy' && left < 60);
    const lost = g.objectives.filter(o => o.owner === 'enemy');
    const men = side => g.squads.reduce((n, q) => n + (q.side === side && !q.destroyed ? q.effective.length : 0), 0), veh = side => g.vehicles.filter(v => v.side === side && !v.destroyed).length;
    const res = g.commander ? Math.max(0, (g.commander.waves?.length ?? g.commander.plan.length) - g.commander.waveI) : 0;
    set(this.forcesEl, 'innerHTML', `<span class="fz f" title="Your force"><b>${men('player')}</b>men <b>${veh('player')}</b>veh${g.reinforced ? '' : ' +1 res'}</span><span class="fz h" title="Enemy (estimate)"><b>≈${men('enemy')}</b>men <b>${veh('enemy')}</b>veh${res ? ` +${res} res` : ''}</span>`);
    const held = g.objectives.filter(o => o.owner === 'player').length;
    set(this.phaseEl, 'textContent', g.phase === 'deploy' ? 'DEPLOYMENT · CLOCK STOPPED'
      : this.tkOn ? (lost.length > held ? `RETAKE ${lost.map(o => o.id).join(' & ')} · WE ARE BLEEDING` : held > lost.length ? (held === g.objectives.length ? 'ALL HELD · ENEMY BLEEDING' : `HOLD ${g.objectives.filter(o => o.owner === 'player').map(o => o.id).join(' & ')} · ENEMY BLEEDING`) : `TAKE ${g.objectives.filter(o => o.owner !== 'player').map(o => o.id).join(' & ')} · BLEED THE ENEMY`)
      : g.phase === 'capture' ? `CAPTURE ${g.objectives.filter(o => !o.captured).map(o => o.id).join(' & ')} · THEN HOLD` : lost.length ? `RETAKE ${lost.map(o => o.id).join(' & ')} — ${Math.max(0, Math.ceil(TUNING.lostObjectiveGrace - Math.max(...lost.map(o => o.lostT))))}s` : g.objectives.length > 2 ? 'HOLD ALL OBJECTIVES' : 'HOLD BOTH OBJECTIVES');
    tog(this.phaseEl, 'bad', g.phase !== 'deploy' && (this.tkOn ? lost.length > held : g.phase !== 'capture' && lost.length));
    for (const { o, el, fill, state } of this.objEls) {
      const c = Math.max(-100, Math.min(100, o.control));
      setS(fill, 'left', `${c >= 0 ? 50 : 50 + c / 2}%`); setS(fill, 'width', `${Math.abs(c) / 2}%`); tog(fill, 'h', c < 0);
      tog(el, 'lost', o.owner === 'enemy'); tog(el, 'held', o.owner === 'player'); tog(el, 'contested', o.contested);
      set(state, 'textContent', o.owner === 'neutral' ? (o.p || o.e ? `CONTESTED · ${Math.round(o.p || 0)} vs ${Math.round(o.e || 0)}` : 'NEUTRAL') : o.owner === 'enemy' ? (o.captured && !this.tkOn ? `ENEMY HELD · ${Math.max(0, Math.ceil(TUNING.lostObjectiveGrace - o.lostT))}s TO RETAKE` : o.p > 0 ? `ASSAULTING · ${Math.round(o.p)} vs ${Math.round(o.e)}` : (this.tkOn ? 'ENEMY HELD' : 'ENEMY HELD — CAPTURE')) : o.contested ? `CONTESTED · ${Math.round(o.p)} vs ${Math.round(o.e)}` : o.e > 0 ? 'UNDER ATTACK' : 'HELD');
    }
  }
  // ------------------------------------------------------------ tickets
  // game.tickets = { player, enemy, max } (optional; absent on old saves / modes without tickets → objective-only top bar)
  // game.ticketDrain = { player, enemy } tickets per minute (optional; estimated from the ticket history when absent)
  // Per frame this only eases the shown number toward the real one; DOM writes are change-guarded.
  updateTickets(dt, slow) {
    const T = this.g.tickets, on = !!(T && T.max > 0);
    if (on !== this.tkOn) { this.tkOn = on; for (const k in this.tk) if (this.tk[k]) this.tk[k].el.classList.toggle('hidden', !on); tog(document.getElementById('topbar'), 'tickets', on); }
    if (!on) return;
    const now = this.g.time || 0;
    for (const side of ['player', 'enemy']) {
      const t = this.tk[side]; if (!t) continue;
      const v = Math.max(0, +T[side] || 0), f = Math.max(0, Math.min(1, v / T.max));
      if (t.disp == null) t.disp = v;
      if (t.disp !== v) {
        t.disp += (v - t.disp) * Math.min(1, dt * 7); if (Math.abs(v - t.disp) < 0.5) t.disp = v;
        if (v < t.lastV && (!t.hitT || now - t.hitT > 0.3)) { t.hitT = now; t.num.animate?.([{ transform: 'none' }, { transform: 'translateY(-.12rem) scale(1.1)', color: '#fff' }, { transform: 'none' }], { duration: 350, easing: 'ease-out' }); }
      }
      t.lastV = v;
      set(t.num, 'textContent', String(Math.round(t.disp)));
      const w = `${(f * 100).toFixed(1)}%`; setS(t.i, 'width', w); setS(t.b, 'width', w);
      if (!slow) continue;
      // drain rate: from the game if it reports one, otherwise from the last ~20 s of history
      let rate = this.g.ticketDrain?.[side];
      if (rate == null) {
        t.hist.push([now, v]); while (t.hist.length > 2 && now - t.hist[0][0] > 20) t.hist.shift();
        const [t0, v0] = t.hist[0]; rate = now - t0 > 2 ? Math.max(0, (v0 - v) / (now - t0) * 60) : 0;
      }
      t.r = rate;
      const drain = rate > 0.05, fast = drain && (rate >= T.max * 0.08 || v / rate < 3);
      set(t.rate, 'textContent', drain ? `−${rate < 10 ? rate.toFixed(1) : Math.round(rate)}/min` : '');
      tog(t.el, 'drain', drain); tog(t.el, 'fast', fast); tog(t.el, 'low', f < 0.2);
    }
  }
  // ------------------------------------------------------------ minimap
  sizeMinimap() {
    const r = this.mm.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    const S = Math.round(r.width) || 220; if (S === this.mmS && dpr === this.mmDpr) return;
    this.mmS = S; this.mmDpr = dpr; this.mm.width = this.mm.height = Math.round(S * dpr);
  }
  // static layer: terrain (desaturated into the C2 palette), roads, building footprints, 100 m grid
  drawMinimapBase() {
    const R = 512, c = document.createElement('canvas'); c.width = c.height = R; const x = c.getContext('2d'); const k = R / MAP_SIZE, o = MAP_SIZE / 2;
    x.fillStyle = '#3a3730'; x.fillRect(0, 0, R, R);
    this.g.city.minimapBase?.(x, k, o);
    for (const r of ROADS) { x.fillStyle = r.type === 'track' ? '#6e6248' : '#5c5a54'; x.fillRect((r.x0 + o) * k, (r.z0 + o) * k, Math.max(1, (r.x1 - r.x0) * k), Math.max(1, (r.z1 - r.z0) * k)); }
    this.g.city.minimapOver?.(x, k, o);
    x.globalCompositeOperation = 'saturation'; x.fillStyle = 'rgba(128,128,128,.6)'; x.fillRect(0, 0, R, R);
    x.globalCompositeOperation = 'multiply'; x.fillStyle = '#8c9a8f'; x.fillRect(0, 0, R, R);
    x.globalCompositeOperation = 'source-over';
    x.fillStyle = '#858d80'; x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 1;
    for (const b of this.g.city.buildings) { x.save(); x.translate((b.x + o) * k, (b.z + o) * k); x.rotate(-b.rot); x.fillRect(-b.L / 2 * k, -b.D / 2 * k, b.L * k, b.D * k); x.restore(); }
    x.strokeStyle = 'rgba(220,235,215,.09)'; x.beginPath();
    for (let m = -Math.floor(o / 100) * 100; m <= o; m += 100) { const p = Math.round((m + o) * k) + 0.5; x.moveTo(p, 0); x.lineTo(p, R); x.moveTo(0, p); x.lineTo(R, p); }
    x.stroke();
    this.mmBase = c; this.mmBaseT = performance.now();
  }
  // ground point under a screen corner (clamped toward the horizon)
  groundCorner(nx, ny, out) {
    const cam = this.g.renderer.camera; const p = new THREE.Vector3(nx, ny, 0.5).unproject(cam), o = cam.position, d = p.sub(o).normalize();
    let t = d.y < -1e-3 ? -o.y / d.y : Infinity; const lim = MAP_SIZE * 1.5; const hd = Math.hypot(d.x, d.z) || 1e-6;
    if (t * hd > lim) t = lim / hd;
    out.push([o.x + d.x * t, o.z + d.z * t]);
  }
  drawMinimap() {
    const x = this.mctx, g = this.g, S = this.mmS || 220, k = S / MAP_SIZE, o = MAP_SIZE / 2, P = v => (v + o) * k;
    if (performance.now() - this.mmBaseT > 15000) this.drawMinimapBase();   // footprints change slowly (collapses)
    x.setTransform(this.mmDpr || 1, 0, 0, this.mmDpr || 1, 0, 0);
    x.drawImage(this.mmBase, 0, 0, S, S);
    // staging grounds during deployment
    if (g.phase === 'deploy' && DEPLOY_ZONES) for (const [side, col] of [['player', C.ok], ['enemy', C.hostile]]) {
      const z = DEPLOY_ZONES[side]; if (!z) continue; x.setLineDash([3, 3]); x.strokeStyle = col; x.lineWidth = 1.2; x.fillStyle = side === 'player' ? 'rgba(125,189,105,.12)' : 'rgba(234,90,75,.10)';
      x.fillRect(P(z.x0), P(z.z0), (z.x1 - z.x0) * k, (z.z1 - z.z0) * k); x.strokeRect(P(z.x0) + .5, P(z.z0) + .5, (z.x1 - z.x0) * k, (z.z1 - z.z0) * k); x.setLineDash([]);
    }
    // objectives: capture circle in the owner's colour, control arc, letter
    for (const ob of g.objectives) {
      const cx = P(ob.x), cz = P(ob.z), rr = Math.max(6, TUNING.captureRadius * k), col = ob.owner === 'player' ? C.friend : ob.owner === 'enemy' ? C.hostile : C.neutral;
      x.fillStyle = ob.owner === 'player' ? 'rgba(92,178,230,.16)' : ob.owner === 'enemy' ? 'rgba(234,90,75,.16)' : 'rgba(165,172,158,.10)';
      x.beginPath(); x.arc(cx, cz, rr, 0, 7); x.fill();
      x.strokeStyle = ob.contested ? C.accent : col; x.lineWidth = 1.5; if (ob.contested) x.setLineDash([3, 2]); x.stroke(); x.setLineDash([]);
      const cf = Math.max(-100, Math.min(100, ob.control)) / 100;
      if (cf) { x.strokeStyle = cf > 0 ? C.friend : C.hostile; x.lineWidth = 2.5; x.beginPath(); x.arc(cx, cz, rr + 2.5, -Math.PI / 2, -Math.PI / 2 + cf * Math.PI * 2, cf < 0); x.stroke(); }
      x.fillStyle = 'rgba(10,14,12,.85)'; x.fillRect(cx - 6, cz - 6, 12, 12); x.strokeStyle = col; x.lineWidth = 1; x.strokeRect(cx - 5.5, cz - 5.5, 11, 11);
      x.fillStyle = C.t1; x.font = '700 9px "Barlow SC", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(ob.id, cx, cz + 0.5);
    }
    // units: men as faint dots, each unit as an APP-6 frame (friend rectangle / hostile diamond)
    const frame = (px, pz, friend, sel) => {
      x.beginPath();
      if (friend) x.rect(px - 4.5, pz - 3, 9, 6); else { x.moveTo(px, pz - 4.5); x.lineTo(px + 4.5, pz); x.lineTo(px, pz + 4.5); x.lineTo(px - 4.5, pz); x.closePath(); }
      x.fillStyle = friend ? 'rgba(92,178,230,.55)' : 'rgba(234,90,75,.6)'; x.fill();
      x.lineWidth = sel ? 2 : 1.2; x.strokeStyle = sel ? '#fff' : friend ? C.friend : C.hostile; x.stroke();
    };
    for (const sq of g.squads) {
      if (sq.destroyed || (sq.side === 'enemy' && !sq.spotted) || sq.mounted) continue;
      const friend = sq.side === 'player';
      x.fillStyle = friend ? 'rgba(160,215,245,.7)' : 'rgba(250,150,140,.75)';
      for (const s of sq.soldiers) if (s.effective && s.inside !== 'btr') x.fillRect(P(s.pos.x) - .75, P(s.pos.z) - .75, 1.5, 1.5);
      const c = (sq.leader?.effective ? sq.leader : sq.effective[0])?.pos; if (c) frame(P(c.x), P(c.z), friend, this.selected.has(sq));
    }
    for (const v of g.vehicles) {
      if (v.side === 'enemy' && !v.spotted && !v.destroyed) continue;
      const friend = v.side === 'player';
      if (v.destroyed) { x.strokeStyle = 'rgba(0,0,0,.6)'; x.lineWidth = 1.5; const px = P(v.pos.x), pz = P(v.pos.z); x.beginPath(); x.moveTo(px - 3, pz - 3); x.lineTo(px + 3, pz + 3); x.moveTo(px + 3, pz - 3); x.lineTo(px - 3, pz + 3); x.stroke(); continue; }
      x.save(); x.translate(P(v.pos.x), P(v.pos.z)); x.rotate(-v.heading);
      x.fillStyle = friend ? C.friend : C.hostile; x.fillRect(-2.5, -3.5, 5, 7);
      if (this.selected.has(v)) { x.strokeStyle = '#fff'; x.lineWidth = 1.5; x.strokeRect(-3.5, -4.5, 7, 9); }
      x.restore();
    }
    this.g.medevac?.drawMinimap(x, P);   // EVAC road exit (game/medevac.js)
    // camera footprint: the four screen corners projected onto the ground
    const q = []; this.groundCorner(-1, -1, q); this.groundCorner(1, -1, q); this.groundCorner(1, 1, q); this.groundCorner(-1, 1, q);
    x.beginPath(); q.forEach(([a, b], i) => i ? x.lineTo(P(a), P(b)) : x.moveTo(P(a), P(b))); x.closePath();
    x.fillStyle = 'rgba(223,228,214,.06)'; x.fill(); x.strokeStyle = 'rgba(223,228,214,.75)'; x.lineWidth = 1; x.stroke();
  }
  minimapClick(e, right = false) {
    const r = this.mm.getBoundingClientRect(); const wx = (e.clientX - r.left) / r.width * MAP_SIZE - MAP_SIZE / 2, wz = (e.clientY - r.top) / r.height * MAP_SIZE - MAP_SIZE / 2;
    if (!right && e.button !== 2 && e.type === 'mousedown' && this.g.medevac?.minimapClick(wx, wz)) return;
    if (right || e.button === 2) this.g.input?.moveSelected(wx, wz, null);
    else this.g.cam.lookAt(Math.max(-MAP_SIZE / 2, Math.min(MAP_SIZE / 2, wx)), Math.max(-MAP_SIZE / 2, Math.min(MAP_SIZE / 2, wz)));
  }
  // ------------------------------------------------------------ alerts / end
  // Feed with priorities: critical ('bad') alerts stay longer and are the last to be pushed out; repeats stack (×n).
  alert(msg, kind = '') {
    for (const el of this.alerts.children) if (el._msg === msg && !el._dying) {
      el._n++; el.querySelector('.n').textContent = `×${el._n}`;
      el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
      clearTimeout(el._t); el._t = setTimeout(() => el.remove(), (el._life + 0.5) * 1000);
      if (el !== this.alerts.firstChild) this.alerts.prepend(el);
      return;
    }
    const life = kind === 'bad' ? 7 : kind === 'good' ? 5 : 4.5;
    const el = document.createElement('div'); el.className = `alert ${kind}`; el._msg = msg; el._kind = kind; el._n = 1; el._life = life;
    el.style.setProperty('--life', `${life}s`);
    el.innerHTML = `<span class="m"></span><span class="n"></span>`; el.firstChild.textContent = msg;
    this.alerts.prepend(el);
    while (this.alerts.children.length > 5) { const list = [...this.alerts.children].reverse(); (list.find(a => a._kind !== 'bad') || list[0]).remove(); }
    el._t = setTimeout(() => el.remove(), (life + 0.5) * 1000);
    if (kind === 'bad' && this.g.audio?.ok && !/Incoming/.test(msg)) this.g.sfx('radio', null, { gain: 0.6 });
  }
  showEnd(r) {
    const g = this.g, P = g.stats.player, E = g.stats.enemy, t = v => `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`;
    const es = document.getElementById('endscreen'); es.classList.toggle('win', !!r.win); es.classList.toggle('loss', !r.win);
    document.getElementById('endTitle').textContent = r.title;
    document.getElementById('endKicker').textContent = r.title === 'WITHDRAWN' ? 'Task group withdrawn' : r.reason === 'tickets' ? (r.win ? 'Enemy force broken' : 'Our force is broken') : r.reason === 'time' ? (r.win ? 'Time · ahead on tickets' : 'Time · behind on tickets') : r.win ? 'Objectives held' : 'Position lost';
    const tr = (label, a, b) => `<tr><td>${label}</td><td>${a}</td><td>${b}</td></tr>`;
    const T = r.tickets || g.tickets, tk = T && T.max > 0 ? (() => {
      const sd = (side, f, cls) => { const v = Math.max(0, Math.round(+T[side] || 0)); return `<div class="s ${cls}"><span class="label">${esc(f?.name || side)} · tickets</span><span class="n">${v}</span><span class="tb"><i style="width:${Math.min(100, v / T.max * 100).toFixed(1)}%"></i></span></div>`; };
      return `<div class="aar-tk panel">${sd('player', g.playerFaction, 'f')}<span class="vs">vs</span>${sd('enemy', g.enemyFaction, 'h')}</div>`;
    })() : '';
    document.getElementById('endStats').innerHTML = `<p class="aar-why">${r.why}</p>${tk}
      <div class="aar-grid panel"><table><thead><tr><th>Losses</th><th class="f">Your force</th><th class="h">Enemy</th></tr></thead><tbody>
        ${tr('Killed', P.kia, E.kia)}${tr('Wounded', P.wia, E.wia)}${tr('Evacuated', P.evac, E.evac ?? 0)}${tr('Vehicles lost', P.vehLost, E.vehLost)}</tbody></table>
      <div class="aar-side"><div class="label">Battle time</div><div class="aar-time">${t(g.time)}</div><div class="label">Objectives</div><div class="aar-objs">
        ${g.objectives.map(o => `<div class="aar-obj ${o.owner}"><span class="tag">${o.id}</span>${esc(o.name)}<small>${o.owner === 'player' ? 'held' : o.owner === 'enemy' ? 'enemy' : 'neutral'}</small></div>`).join('')}</div></div></div>`;
    const menuBtn = document.querySelector('#endscreen .aar-menu'); if (menuBtn) menuBtn.classList.toggle('hidden', !!(g.campaign || g.opts?.net));
    if (g.campaign) { const b = document.querySelector('#endscreen button.big'); if (b) { b.textContent = 'Return to brigade HQ'; b.onclick = () => window.__campaignReturn?.(); } }
    setTimeout(() => es.classList.remove('hidden'), 1800);
  }
  update(dt) {
    this.frames++; this.fpsT += dt; if (this.fpsT > 1) { this.fpsEl.textContent = `${Math.round(this.frames / this.fpsT)} fps`; this.frames = 0; this.fpsT = 0; }
    for (const u of this.selected) if (u.destroyed) this.selected.delete(u);
    this.updateRings(); this.updateBanners(); this.updateTop(); this.g.medevac?.hudUpdate();
    this.slowT = (this.slowT || 0) - dt; const slow = this.slowT <= 0;
    this.updateTickets(dt, slow);
    if (slow) { this.slowT = 0.25; this.updateCards(); this.updateInfo(); this.drawMinimap(); }
  }
}
