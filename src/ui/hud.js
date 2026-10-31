import * as THREE from 'three';
import { ROADS, MAP_SIZE } from '../world/city.js';
import { TUNING } from '../config.js';

const ICONS = {
  squad: `<svg viewBox="0 0 62 40"><g fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="50" height="28"/><path d="M6 6 L56 34 M56 6 L6 34"/></g></svg>`,
  btr: `<svg viewBox="0 0 62 40"><g fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="50" height="28"/><path d="M6 6 L56 34 M56 6 L6 34"/><ellipse cx="31" cy="20" rx="20" ry="9"/><circle cx="16" cy="38" r="1.6"/><circle cx="26" cy="38" r="1.6"/><circle cx="36" cy="38" r="1.6"/><circle cx="46" cy="38" r="1.6"/></g></svg>`,
  tank: `<svg viewBox="0 0 62 40"><g fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="50" height="28"/><rect x="14" y="12" width="34" height="16" rx="8"/></g></svg>`,
};

export class HUD {
  constructor(game) {
    this.g = game; game.hud = this;
    this.cards = document.getElementById('cards'); this.info = document.getElementById('unitinfo');
    this.alerts = document.getElementById('alerts'); this.mm = document.getElementById('minimap'); this.mctx = this.mm.getContext('2d');
    this.selected = new Set(); this.groups = {}; this.banners = new Map();
    this.timerEl = document.getElementById('timer'); this.phaseEl = document.getElementById('phase'); this.fpsEl = document.getElementById('fps');
    document.getElementById('hud').classList.remove('hidden');
    for (const o of game.objectives) { const n = document.querySelector(`#obj-${o.id} .name`); if (n) n.textContent = o.name; }
    this.rings(); this.drawMinimapBase(); this.rebuildCards();
    this.mm.addEventListener('mousedown', e => this.minimapClick(e));
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
    this.preview = new THREE.InstancedMesh(new THREE.CircleGeometry(0.35, 10).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8fb069, transparent: true, opacity: 0.8, depthWrite: false }), 80);
    this.preview.count = 0; this.preview.frustumCulled = false; g.scene.add(this.preview);
  }
  updateRings() {
    const m = new THREE.Matrix4(); let n = 0, vn = 0; const pts = [];
    for (const u of this.selected) {
      if (u.type === 'squad') {
        if (u.mounted) continue;
        for (const s of u.soldiers) if (s.alive && s.inside !== 'btr' && n < 200) { m.makeTranslation(s.pos.x, s.pos.y + 0.08, s.pos.z); this.ringMesh.setMatrixAt(n++, m); }
        const c = u.center(); for (const s of u.effective) if (s.goal && s.path) { pts.push(s.pos.x, 0.2, s.pos.z, s.goal[0], 0.2, s.goal[1]); }
      } else if (!u.destroyed && vn < 20) {
        m.makeRotationY(u.heading).setPosition(u.pos.x, 0.1, u.pos.z); this.vRing.setMatrixAt(vn++, m);
        if (u.path) { let px = u.pos.x, pz = u.pos.z; for (let i = u.pathI; i < u.path.length; i++) { pts.push(px, 0.25, pz, u.path[i][0], 0.25, u.path[i][1]); [px, pz] = u.path[i]; } }
      }
    }
    this.ringMesh.count = n; this.ringMesh.instanceMatrix.needsUpdate = true; this.vRing.count = vn; this.vRing.instanceMatrix.needsUpdate = true;
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.orderLines.geometry.dispose(); this.orderLines.geometry = geo; this.orderLines.computeLineDistances();
  }
  showPreview(points) { const m = new THREE.Matrix4(); this.preview.count = Math.min(80, points.length); points.slice(0, 80).forEach((p, i) => { m.makeTranslation(p[0], 0.15, p[1]); this.preview.setMatrixAt(i, m); }); this.preview.instanceMatrix.needsUpdate = true; }
  // ------------------------------------------------------------ cards
  rebuildCards() {
    this.cards.innerHTML = '';
    this.cardEls = new Map();
    for (const u of this.g.playerUnits) {
      const el = document.createElement('div'); el.className = 'card';
      const kind = u.type === 'squad' ? 'squad' : u.kind;
      el.innerHTML = `<span class="grp"></span><span class="men"></span><div class="ico" style="color:${u.faction.color}">${ICONS[kind]}</div><div class="nm">${u.name}</div><div class="st"></div><div class="bars"><div class="b hp"><i></i></div><div class="b am"><i></i></div><div class="b mo"><i></i></div></div>`;
      el.addEventListener('mousedown', e => { e.stopPropagation(); if (e.button !== 0) return; this.select([u], e.shiftKey); this.g.sfx('ui_select'); });
      el.addEventListener('dblclick', () => { const c = u.center(); this.g.cam.lookAt(c.x, c.z); });
      this.cards.appendChild(el); this.cardEls.set(u, el);
    }
  }
  updateCards() {
    for (const [u, el] of this.cardEls) {
      const dead = u.type === 'squad' ? u.destroyed : u.destroyed;
      el.classList.toggle('dead', dead); el.classList.toggle('sel', this.selected.has(u));
      const q = s => el.querySelector(s);
      if (u.type === 'squad') {
        if (u.assault) el.querySelector('.ico').style.color = '#e38b3a';
        const eff = u.effective.length, wnd = u.soldiers.filter(s => s.state === 'critical' || s.state === 'stable').length;
        q('.men').textContent = `${eff}${wnd ? '+' + wnd : ''}`;
        q('.hp i').style.width = `${eff / 8 * 100}%`; q('.am i').style.width = `${u.ammoFrac() * 100}%`; q('.mo i').style.width = `${u.morale}%`;
        q('.mo i').style.background = u.routing ? '#c8483a' : u.morale < 45 ? '#d8b25a' : '#8fb069';
        const st = q('.st'); st.textContent = dead ? 'DESTROYED' : u.mounted ? 'MOUNTED' : u.building ? 'GARRISONED' : u.moraleState(); st.classList.toggle('rout', u.routing);
      } else {
        q('.men').textContent = u.destroyed ? '✕' : `${u.crew}`;
        q('.hp i').style.width = `${Math.max(0, u.hp / u.def.hp) * 100}%`; q('.am i').style.width = `${u.ammoFrac() * 100}%`; q('.mo i').style.width = u.destroyed ? '0' : '100%';
        q('.st').textContent = u.moraleState() + (u.passengers ? ' · CARRYING' : '');
      }
      const gnum = Object.entries(this.groups).find(([k, v]) => v.includes(u)); q('.grp').textContent = gnum ? gnum[0] : '';
    }
  }
  select(units, add = false) {
    if (!add) this.selected.clear();
    for (const u of units) if (u && (u.type === 'squad' ? !u.destroyed : !u.destroyed) && u.side === 'player') this.selected.add(u);
    this.updateInfo(true);
  }
  // ------------------------------------------------------------ info panel
  updateInfo(force) {
    const sel = [...this.selected].filter(u => !u.destroyed);
    const ob = document.getElementById('orders');
    for (const b of ob.querySelectorAll('button')) b.disabled = !sel.length && b.dataset.o !== 'mortar';
    ob.querySelector('[data-o=holdfire]').classList.toggle('on', sel.length > 0 && sel.every(u => u.holdFire));
    ob.querySelector('[data-o=run]').classList.toggle('on', !!this.g.input?.runMode);
    document.getElementById('mortarCount').textContent = this.g.mortars;
    const u = this.inspect || (sel.length === 1 ? sel[0] : null);
    if (!u) { this.info.style.display = 'none'; return; }
    this.info.style.display = 'block';
    let html = `<h4>${u.side === 'player' ? '' : 'Enemy '}${u.name}</h4>`;
    const row = (a, b) => `<div class="row"><span>${a}</span><b>${b}</b></div>`;
    if (u.type === 'squad') {
      const s = u.soldiers;
      const ammo = s.filter(x => x.effective).map(x => x.weaponKey === 'rpg7' ? `${x.inMag + x.mags} rkt` : `${x.mags}`).join(' ');
      html += row('Fit / wounded / KIA', `${u.effective.length} / ${s.filter(x => x.state === 'critical' || x.state === 'stable' || x.state === 'light').length} / ${s.filter(x => x.state === 'dead').length}`);
      html += row('Morale', `${u.moraleState()} (${Math.round(u.morale)})`);
      html += row('Ammunition', `${Math.round(u.ammoFrac() * 100)}%`);
      if (u.side === 'player') html += row('Mags per man', ammo);
      html += row('Status', u.mounted ? `Mounted in ${u.carrier?.name}` : u.building ? 'Garrisoned' : u.order?.type === 'move' ? (u.run ? 'Running' : 'Moving') : 'Holding');
      if (u.holdFire) html += row('Fire', 'HOLD FIRE');
      if (u.carrier && u.side === 'player') html += row('Carrier', `${u.carrier.name}${u.carrier.destroyed ? ' (lost)' : ''}`);
    } else {
      html += row('Condition', u.moraleState());
      html += row('Hull integrity', `${Math.max(0, Math.round(u.hp / u.def.hp * 100))}%`);
      html += row('Crew', `${Math.max(0, u.crew)}/3`);
      const w = u.weapons[0];
      html += row('Main gun', u.kind === 'tank' ? `${w.ammo} rds (APFSDS ${w.ap} / HE-FRAG ${w.he})` : `${w.ammo} rds`);
      html += row('Coax PKT', `${u.weapons[1].ammo}`);
      if (u.supply) html += row('Resupply stock', `${u.supply.rifle} rds · ${u.supply.rpg} rkt`);
      if (u.passengers) html += row('Carrying', u.passengers.name);
    }
    this.info.innerHTML = html;
  }
  // ------------------------------------------------------------ banners
  updateBanners() {
    const cam = this.g.renderer.camera, v = new THREE.Vector3();
    const all = [...this.g.squads, ...this.g.vehicles];
    for (const u of all) {
      let b = this.banners.get(u);
      const show = !u.destroyed && (u.side === 'player' || u.spotted) && !(u.type === 'squad' && u.mounted);
      if (!show) { if (b) b.el.style.display = 'none'; continue; }
      if (!b) {
        const el = document.createElement('div'); el.className = 'banner';
        const col = u.side === 'player' ? u.faction.color : '#c8483a';
        el.innerHTML = `<div class="pin">PINNED</div><div class="flag" style="border-color:${col}">${u.side === 'player' ? u.name : (u.type === 'squad' ? 'Infantry' : u.name)}</div><div class="mb"><i></i></div><div class="pole"></div>`;
        el.addEventListener('mousedown', e => { if (u.side === 'player' && e.button === 0) { e.stopPropagation(); this.select([u], e.shiftKey); } });
        document.body.appendChild(el); b = { el, bar: el.querySelector('.mb i'), pin: el.querySelector('.pin') }; this.banners.set(u, b);
      }
      const c = u.type === 'squad' ? (u.leader || u.alive[0])?.pos || u.center() : u.pos;
      v.set(c.x, (u.type === 'squad' ? 2.4 : 4.2) + (u.type === 'squad' && u.leader?.inside && u.leader.inside !== 'btr' ? u.leader.pos.y : 0), c.z).project(cam);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) { b.el.style.display = 'none'; continue; }
      b.el.style.display = 'flex';
      b.el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`; b.el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
      b.el.classList.toggle('sel', this.selected.has(u));
      const pinned = u.type === 'squad' && u.pinned && !u.routing; if (pinned !== b.pinned) { b.pinned = pinned; b.pin.style.display = pinned ? 'block' : 'none'; }
      const val = u.type === 'squad' ? u.morale : Math.max(0, u.hp / u.def.hp * 100);
      b.bar.style.width = `${val}%`; b.bar.style.background = u.type === 'squad' && u.routing ? '#c8483a' : val < 45 ? '#d8b25a' : '#8fb069';
    }
  }
  // ------------------------------------------------------------ top bar
  updateTop() {
    const g = this.g, left = Math.max(0, g.roundLen - g.time);
    this.timerEl.textContent = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;
    const lost = g.objectives.filter(o => o.owner === 'enemy');
    const men = side => g.squads.reduce((n, q) => n + (q.side === side && !q.destroyed ? q.effective.length : 0), 0), veh = side => g.vehicles.filter(v => v.side === side && !v.destroyed).length;
    const res = g.commander ? Math.max(0, (g.commander.waves?.length ?? g.commander.plan.length) - g.commander.waveI) : 0;
    (this.forcesEl ||= document.getElementById('forces')).textContent = `YOU ${men('player')} MEN · ${veh('player')} VEH${g.reinforced ? '' : ' (+1 RESERVE)'}   ENEMY ≈${men('enemy')} · ${veh('enemy')}${res ? ` (+${res} RESERVE)` : ''}`;
    this.phaseEl.textContent = g.phase === 'deploy' ? 'DEPLOYMENT · CLOCK STOPPED' : g.phase === 'capture' ? `CAPTURE ${g.objectives.filter(o => !o.captured).map(o => o.id).join(' & ')} · THEN HOLD` : lost.length ? `RETAKE ${lost.map(o => o.id).join(' & ')} — ${Math.max(0, Math.ceil(TUNING.lostObjectiveGrace - Math.max(...lost.map(o => o.lostT))))}s` : 'HOLD BOTH OBJECTIVES';
    for (const o of g.objectives) {
      const el = document.getElementById(`obj-${o.id}`);
      el.querySelector('.fill').style.width = `${(o.control + 100) / 2}%`;
      el.classList.toggle('lost', o.owner === 'enemy'); el.classList.toggle('contested', o.contested);
      el.querySelector('.state').textContent = o.owner === 'neutral' ? (o.p || o.e ? `CONTESTED · ${Math.round(o.p || 0)} vs ${Math.round(o.e || 0)}` : 'NEUTRAL') : o.owner === 'enemy' ? (o.captured ? `ENEMY HELD · ${Math.max(0, Math.ceil(TUNING.lostObjectiveGrace - o.lostT))}s TO RETAKE` : o.p > 0 ? `ASSAULTING · ${Math.round(o.p)} vs ${Math.round(o.e)}` : 'ENEMY HELD — CAPTURE') : o.contested ? `CONTESTED · ${Math.round(o.p)} vs ${Math.round(o.e)}` : o.e > 0 ? 'UNDER ATTACK' : 'HELD';
    }
  }
  // ------------------------------------------------------------ minimap
  drawMinimapBase() {
    const c = document.createElement('canvas'); c.width = c.height = 440; const x = c.getContext('2d'); const k = 440 / MAP_SIZE, o = MAP_SIZE / 2;
    x.fillStyle = '#3a3730'; x.fillRect(0, 0, 440, 440);
    this.g.city.minimapBase?.(x, k, o);
    for (const r of ROADS) { x.fillStyle = r.type === 'track' ? '#6e6248' : '#5c5a54'; x.fillRect((r.x0 + o) * k, (r.z0 + o) * k, Math.max(1, (r.x1 - r.x0) * k), Math.max(1, (r.z1 - r.z0) * k)); }
    this.g.city.minimapOver?.(x, k, o);
    this.mmBase = c;
  }
  drawMinimap() {
    const x = this.mctx, g = this.g, S = 220, k = S / MAP_SIZE, o = MAP_SIZE / 2;
    x.drawImage(this.mmBase, 0, 0, S, S);
    x.fillStyle = '#8b867a';
    for (const b of g.city.buildings) { x.save(); x.translate((b.x + o) * k, (b.z + o) * k); x.rotate(-b.rot); x.fillRect(-b.L / 2 * k, -b.D / 2 * k, b.L * k, b.D * k); x.restore(); }
    for (const ob of g.objectives) { x.strokeStyle = ob.owner === 'player' ? '#8fb069' : ob.owner === 'enemy' ? '#c8483a' : '#b8b4a8'; x.lineWidth = 2; x.beginPath(); x.arc((ob.x + o) * k, (ob.z + o) * k, TUNING.captureRadius * k, 0, 7); x.stroke(); x.fillStyle = '#fff'; x.font = 'bold 10px sans-serif'; x.fillText(ob.id, (ob.x + o) * k - 3, (ob.z + o) * k + 4); }
    for (const sq of g.squads) {
      if (sq.destroyed || (sq.side === 'enemy' && !sq.spotted) || sq.mounted) continue;
      x.fillStyle = sq.side === 'player' ? (this.selected.has(sq) ? '#fff' : sq.faction.color) : '#d0453a';
      for (const s of sq.soldiers) if (s.effective && s.inside !== 'btr') x.fillRect((s.pos.x + o) * k - 1, (s.pos.z + o) * k - 1, 2, 2);
    }
    for (const v of g.vehicles) {
      if (v.side === 'enemy' && !v.spotted && !v.destroyed) continue;
      x.fillStyle = v.destroyed ? '#222' : v.side === 'player' ? (this.selected.has(v) ? '#fff' : v.faction.color) : '#d0453a';
      x.save(); x.translate((v.pos.x + o) * k, (v.pos.z + o) * k); x.rotate(-v.heading); x.fillRect(-2, -3, 4, 6); x.restore();
    }
    // camera frustum
    const f = g.cam.focus; x.strokeStyle = 'rgba(255,255,255,.6)'; x.lineWidth = 1; const r = g.cam.dist * 0.6 * k;
    x.strokeRect((f.x + o) * k - r, (f.z + o) * k - r * 0.6, r * 2, r * 1.2);
  }
  minimapClick(e, right = false) {
    const r = this.mm.getBoundingClientRect(); const wx = (e.clientX - r.left) / r.width * MAP_SIZE - MAP_SIZE / 2, wz = (e.clientY - r.top) / r.height * MAP_SIZE - MAP_SIZE / 2;
    if (right || e.button === 2) this.g.input?.moveSelected(wx, wz, null);
    else this.g.cam.lookAt(wx, wz);
  }
  // ------------------------------------------------------------ alerts / end
  alert(msg, kind = '') {
    const el = document.createElement('div'); el.className = `alert ${kind}`; el.textContent = msg; this.alerts.prepend(el);
    while (this.alerts.children.length > 5) this.alerts.lastChild.remove();
    setTimeout(() => el.remove(), 5200);
    if (kind === 'bad' && this.g.audio?.ok && !/Incoming/.test(msg)) this.g.sfx('radio', null, { gain: 0.6 });
  }
  showEnd(r) {
    const g = this.g, P = g.stats.player, E = g.stats.enemy;
    document.getElementById('endTitle').textContent = r.title;
    document.getElementById('endKicker').textContent = r.win ? 'OBJECTIVES HELD' : 'POSITION LOST';
    document.getElementById('endStats').innerHTML = `${r.why}<br><br>
      Time: <b>${Math.floor(g.time / 60)}:${String(Math.floor(g.time % 60)).padStart(2, '0')}</b><br>
      Your losses: <b>${P.kia}</b> killed · <b>${P.wia}</b> wounded (${P.evac} evacuated) · <b>${P.vehLost}</b> vehicles<br>
      Enemy losses: <b>${E.kia}</b> killed · <b>${E.wia}</b> wounded · <b>${E.vehLost}</b> vehicles`;
    setTimeout(() => document.getElementById('endscreen').classList.remove('hidden'), 1800);
  }
  update(dt) {
    this.frames++; this.fpsT += dt; if (this.fpsT > 1) { this.fpsEl.textContent = `${Math.round(this.frames / this.fpsT)} fps`; this.frames = 0; this.fpsT = 0; }
    for (const u of this.selected) if (u.destroyed) this.selected.delete(u);
    this.updateRings(); this.updateBanners(); this.updateTop();
    this.slowT = (this.slowT || 0) - dt;
    if (this.slowT <= 0) { this.slowT = 0.25; this.updateCards(); this.updateInfo(); this.drawMinimap(); }
  }
}
