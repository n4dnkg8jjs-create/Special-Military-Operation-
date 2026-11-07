// Campaign v2 guided tour: coach marks over the live command screen. A spotlight (dimmed screen with a hole that
// glides from element to element) frames the real UI or a spot on the 3D map, a card beside it carries the short
// copy, progress dots and Back / Next / Skip. Fully keyboard driven (→ / Enter next, ← back, Esc skip, Tab stays in
// the card). Some steps are interactive: the hole lets clicks through (e.g. select the task force yourself).
// Offered once after the intro (localStorage smo.campaign.v2.tutorial = 'done' | 'skipped'), re-opened from the ?
// button or F1.
export const TUT_KEY = 'smo.campaign.v2.tutorial';
export function tutorialState() { try { return localStorage.getItem(TUT_KEY); } catch { return 'done'; } }
function setState(v) { try { localStorage.setItem(TUT_KEY, v); } catch {} }

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PAD = 8;

export class Tour {
  constructor(ui, opts = {}) {
    this.ui = ui; this.open = false; this.i = 0; this.opts = opts;
    this.steps = this.build().filter(s => !s.when || s.when());
  }
  // the campaign is always the screen's current one (versus replaces it whenever the host sends a new state)
  get C() { return this.ui.C; }
  set C(v) { }
  // ------------------------------------------------------------------ the steps
  build() {
    const ui = this.ui, map = new Proxy({}, { get: (_, k) => { const m = ui.map, v = m[k]; return typeof v === 'function' ? v.bind(m) : v; } }), C = new Proxy({}, { get: (_, k) => { const c = ui.C, v = c[k]; return typeof v === 'function' ? v.bind(c) : v; } });
    const tf = () => C.forces.find(f => f.id === this.tfId) || C.forces.find(f => !f.reserve) || C.forces[0];
    const sel = () => { const f = tf(); if (f && ui.sel !== f.id) ui.select(f.id); return f; };
    const fly = (cell, dist = 11) => { if (!cell) return; const c = map.cellCenter(cell); map.flyTo({ x: c.x, z: c.z, dist, pitch: 0.95, yaw: map.cam.yaw }, 0.9); };
    // frame a few squares (the task force and where it goes) with a margin of map around them
    const frame = cells => { cells = cells.filter(Boolean); if (!cells.length) return; const ps = cells.map(id => map.cellCenter(id)), x = ps.reduce((a, p) => a + p.x, 0) / ps.length, z = ps.reduce((a, p) => a + p.z, 0) / ps.length; const cs = cells.map(id => C.cell(id)), span = Math.max(...cs.map(c => c.col)) - Math.min(...cs.map(c => c.col)), spanR = Math.max(...cs.map(c => c.row)) - Math.min(...cs.map(c => c.row)); map.flyTo({ x, z, dist: Math.max(9, (Math.max(span, spanR) + 3) * Math.max(map.cw, map.ch) * 1.9), pitch: 0.95, yaw: map.cam.yaw }, 0.9); };
    const preview = cell => { const f = tf(); if (f && cell) { const p = C.plan(f.id, cell); if (p.ok) map.showPath(p); } };
    const reach = kind => { const f = tf(); if (!f) return null; const r = ui.reachOf(f.id); const list = [...r].filter(([, k]) => k === kind).map(([id]) => id); if (!list.length) return null; const c0 = C.cell(f.cell); return list.sort((a, b) => { const p = C.cell(a), q = C.cell(b); return Math.hypot(p.col - c0.col, p.row - c0.row) - Math.hypot(q.col - c0.col, q.row - c0.row); })[0]; };
    const nearEnemy = () => { const f = tf(); if (!f) return null; const c0 = C.cell(f.cell); return C.def.aor.cells.filter(c => C.owner[c.id] !== 'player' && C.frontline(c.id)).sort((a, b) => Math.hypot(a.col - c0.col, a.row - c0.row) - Math.hypot(b.col - c0.col, b.row - c0.row))[0]?.id || null; };
    const frontNear = cell => { const c0 = cell && C.cell(cell); if (!c0) return cell; const fr = C.def.aor.cells.filter(c => C.owner[c.id] === 'player' && C.frontline(c.id)); return fr.sort((a, b) => Math.hypot(a.col - c0.col, a.row - c0.row) - Math.hypot(b.col - c0.col, b.row - c0.row))[0]?.id || cell; };
    const isVs = !!C.def.versus;
    return [
      { id: 'welcome', title: isVs ? 'Commander vs commander' : 'Your brigade, your sector', kicker: 'GUIDED TOUR · 2 MINUTES',
        body: `A short tour of the command screen. Use <kbd>→</kbd> or <kbd>Enter</kbd> to continue, <kbd>Esc</kbd> to skip. The <b>?</b> button brings it back any time.`, next: 'Start the tour', skip: 'Not now' },
      { id: 'map', title: 'Reading the map', target: () => this.cellsRect(this.mapCell, 1), before: () => { const f = tf(); this.tfId = f?.id; ui.select(null); this.mapCell = frontNear(f?.cell); fly(this.mapCell, 13); },
        body: `<span class="sw own"></span><b>Blue</b> squares are yours, <span class="sw en"></span><b>red</b> the enemy's; the bright line is the <b>front</b>. Dark squares marked <b>?</b> are unscouted enemy ground — move next to them to see what holds them. <b>Hatching</b> marks own squares at the end of the supply line.` },
      { id: 'clock', title: 'Weeks and logistics points', target: () => this.union('.c2-top .c2-date', '.c2-top .c2-stats'),
        body: `Every turn is one week, ${isVs ? 'planned by both commanders at once' : 'from February 2023 to March 2024'}. <b>LP</b> — logistics points — pay for everything; battles, held squares and directives earn them.` },
      { id: 'goal', title: 'The operation goal', when: () => !!C.goalProgress?.(), target: () => document.querySelector('.c2-goal'), place: 'bottom', before: () => { ui.goalOpen = true; ui.renderGoal(); }, after: () => { ui.goalOpen = false; ui.renderGoal(); },
        body: `This is what wins the campaign: take and hold the squares marked <b>★</b> on the map (their points fill the bar). Hold all of them at the end of a week for <b>victory</b>; by the end date, reaching the gold mark still counts as a limited success. Dark squares beyond your sector <b>open up</b> as the front moves.` },
      { id: 'token', title: 'Task forces', target: () => this.tokenRect(tf()?.id), interactive: true, waitFor: () => ui.sel === tf()?.id, before: () => { ui.select(null); fly(tf()?.cell, 9); },
        body: `Your brigade fights as task forces — the NATO symbols on the map. <b>Click this one</b> to select it.`, next: 'Select it' , onNext: () => sel() },
      { id: 'panel', title: 'The selected task force', target: () => document.querySelector('.c2-card.tfsel'), before: sel, place: 'left',
        body: `<b>Movement points</b> (the green pips) are set by the slowest unit. Below: supply, the stance — <b>Dig in</b> fortifies a square, <b>Rest</b> repairs — and every unit with its strength and veterancy.` },
      { id: 'move', title: 'Moving', target: () => this.unionRects(this.regionRect([tf()?.cell, this.moveCell]), this.tokenRect(tf()?.id)), before: () => { sel(); this.moveCell = reach('move'); frame([tf()?.cell, this.moveCell]); preview(this.moveCell); }, after: () => map.showPath(null),
        body: `Highlighted squares are in reach this week. <b>Hover</b> one for the route and its MP cost (shown here), <b>right-click</b> to move. Roads are cheap; fields, woods, towns and rivers cost more.` },
      { id: 'attack', title: 'Attacking', target: () => this.unionRects(this.regionRect([tf()?.cell, this.atkCell]), this.tokenRect(tf()?.id)), before: () => { sel(); this.atkCell = reach('attack') || nearEnemy(); frame([tf()?.cell, this.atkCell]); preview(this.atkCell); }, after: () => map.showPath(null),
        body: `<b>Right-click an enemy square</b> to give an attack order: it shows the staff's <b>odds</b>. ${isVs ? 'Attacks are carried out when both commanders end the week — against the other player\'s task forces it becomes a real battle for both of you.' : '<b>Fight the battle</b> takes you to the real-time battle map; <b>Auto-resolve</b> is instant but earns less LP.'} Win, and the square is yours.` },
      { id: 'split', title: 'Split and merge', target: () => this.union('.c2-card.tfsel .c2-units', '.c2-card.tfsel .c2-acts'), before: sel, place: 'left',
        body: `Tick units and <b>Split off</b> to send a detachment to another square. Move task forces onto one square and <b>Merge</b> them for a stronger blow — each task force attacks once a week.` },
      { id: 'spot', title: 'Big formations are seen', when: () => !!C.spotStatus, target: () => [...document.querySelectorAll('.c2-card.tfsel .c2-kv')].find(e => /Signature/.test(e.textContent)) || document.querySelector('.c2-card.tfsel'), before: sel, place: 'left',
        body: `Massing gives you away. A task force of <b>more than four companies</b> — or a smaller one that moved or attacked this week — is <b>spotted</b> by the enemy without any drone (<b>◉ SPOTTED</b> on its token): he knows where it is, aims his guns and drones at it, and it takes heavier losses under fire. The bigger it is, the deeper behind the line it is seen. Small dispersed groups stay hidden until reconnoitred or in contact. The enemy's concentrations show up on your map the same way — a target for your artillery.` },
      { id: 'grow', title: 'Pushing past the map', when: () => !!C.growthStatus?.()?.next, target: () => this.cellsRect(this.edgeCell, 1), before: () => { const f = tf(), A = C.def.aor, g = C.growthStatus(), c = f && C.cell(f.cell); if (!c) return; this.edgeCell = (g.dir === 'west' ? C.cellAt(A.col0 || 0, c.row) : g.dir === 'east' ? C.cellAt((A.col0 || 0) + A.cols - 1, c.row) : g.dir === 'north' ? C.cellAt(c.col, A.row0 || 0) : C.cellAt(c.col, (A.row0 || 0) + A.rows - 1))?.id; fly(this.edgeCell, 16); },
        body: `The grid is not the limit. When ground you have taken comes within <b>three squares of the map's edge</b>, the map <b>grows past it</b>: new ${C.growthStatus?.()?.dir === 'west' || C.growthStatus?.()?.dir === 'east' ? 'columns' : 'rows'} of real terrain from OpenStreetMap — villages, roads, rivers, woods and the enemy's mapped fortification lines — join the map with their garrisons, supply hubs and new directives (next: <b>${C.growthStatus?.()?.next?.name || ''}</b>).` },
      { id: 'supply', title: 'Supply and depots', target: () => document.querySelector('.c2-views .c2-supply'), before: () => { this.supplyWas ??= map.showSupply; if (!map.showSupply) ui.toggleSupply(); fly(tf()?.cell, 16); }, after: () => { if (map.showSupply !== this.supplyWas) ui.toggleSupply(); },
        body: `Supply flows from the rear through <b>logistics hubs</b> along the roads to your squares (<kbd>L</kbd> shows the routes). Lose or let the enemy shell a hub and everything behind it starves. Cut off, a task force moves at half speed, gets no replacements and fights worse. Click a supplied own square to build a <b>forward depot</b> (30 LP).` },
      { id: 'fires', title: 'Artillery fire missions', when: () => !!C.batteries && C.batteries('player').length > 0, target: () => document.querySelector('.c2-left'), place: 'right', before: () => { ui.tab = 'ops'; ui.renderLeft(); },
        body: `Your <b>artillery group</b>: each battery fires one mission a week within its range ring — <b>suppress</b> defenders before an attack, <b>interdict</b> a road or hub to starve the enemy, or <b>counter-battery</b> against guns you have found. Shells are scarce, and guns that fire get found: <b>displace</b> them.` },
      { id: 'uav', title: 'Drone reconnaissance', when: () => !!C.uavStatus, target: () => [...document.querySelectorAll('.c2-left .c2-sub')].find(e => /UAV/.test(e.textContent))?.nextElementSibling || document.querySelector('.c2-left'), place: 'right', before: () => { ui.tab = 'ops'; ui.renderLeft(); const el = [...document.querySelectorAll('.c2-left .c2-sub')].find(e => /UAV/.test(e.textContent)); el?.scrollIntoView({ block: 'start' }); },
        body: `Send a <b>UAV sortie</b> over an enemy square: the drone circles it for the rest of the week and reveals garrisons, fortifications, task forces and batteries around it. Enemy EW shoots some down; airframes are replaced slowly.` },
      { id: 'tech', title: 'Tech tree', target: () => document.querySelector('.c2-ttopen') || document.querySelector('.c2-left'), place: 'right', before: () => { ui.tab = 'hc'; ui.hcTab = 'tech'; ui.renderLeft(); }, after: () => { ui.tab = 'dir'; ui.hcTab = 'units'; ui.renderLeft(); },
        body: `The <b>tech tree</b> (<kbd>T</kbd>) lists your vehicles with a drop-down of field upgrades — cope cages, ERA, sandbags, thermal sights, roof jammers, smoke — and the support branches. Upgrades change how the vehicles fight and <b>look</b> on the battle map; the 3D preview shows them before you order.` },
      { id: 'threat', title: 'Enemy attacks', when: () => !isVs && C.pendingAttacks.length > 0, target: () => document.querySelector('.c2-card.c2-alert'), place: 'right', before: () => { ui.tab = 'dir'; ui.renderLeft(); },
        body: `Red arrows are enemy attacks prepared for next week. Move a task force into the square to defend it yourself — or the line battalions hold it alone.` },
      { id: 'dir', title: isVs ? 'Your orders' : 'Directives', target: () => document.querySelector('.c2-left'), place: 'right', before: () => { ui.tab = 'dir'; ui.renderLeft(); },
        body: `Orders from higher command: a task, a deadline, a reward. The lettered flags on the map mark the objectives. Failing a directive costs LP${isVs ? '' : ' — and the history notes tell you what really happened'}.` },
      { id: 'hc', title: 'High command', target: () => document.querySelector('.c2-left'), place: 'right', before: () => { ui.tab = 'hc'; ui.hcTab = 'units'; ui.renderLeft(); }, after: () => { ui.tab = 'dir'; ui.renderLeft(); },
        body: `Spend LP here: new units, <b>replacements</b> for battered ones and equipment from the <b>tech tree</b>. Deliveries arrive at brigade <b>HQ</b> after a week or more.` },
      { id: 'end', title: 'End the week', target: () => document.querySelector('.c2-top .c2-end'), place: 'bottom',
        body: isVs ? `When your orders are given, <b>end the week</b>. Once your opponent has too, the attacks are carried out and the new week begins.` : `When your orders are given, <b>end the week</b> (<kbd>Enter</kbd>). The enemy moves, deliveries arrive, and a weekly report sums it up.` },
      { id: 'done', title: 'You have command', kicker: 'TOUR COMPLETE', body: `That's all you need to start. Hover markers and buttons for details; the <b>?</b> button replays this tour.`, next: 'Start commanding' },
    ];
  }
  // ------------------------------------------------------------------ geometry helpers (CSS px rects)
  rectOf(el) { if (!el) return null; const r = el.getBoundingClientRect(); return r.width || r.height ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; }
  union(...sels) { const rs = sels.map(s => this.rectOf(document.querySelector(s))).filter(Boolean); if (!rs.length) return null; const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y)), x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h)); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; }
  tokenRect(tfId) { const t = this.ui.map.tokens.find(t => t.tf === tfId); if (!t || t.vis === false) return null; const a = this.rectOf(t.e.querySelector('.c2-nato')), b = this.rectOf(t.e.querySelector('.c2-tok-n')); if (!a) return null; if (!b) return a; const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; }
  unionRects(...rs) { rs = rs.filter(Boolean); if (!rs.length) return null; const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y)), x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h)); return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }; }
  // screen bbox of the squares spanned by a set of cells
  regionRect(cells) {
    const C = this.C, cs = cells.filter(Boolean).map(id => C.cell(id)).filter(Boolean); if (!cs.length) return null;
    const c0 = Math.min(...cs.map(c => c.col)), c1 = Math.max(...cs.map(c => c.col)), r0 = Math.min(...cs.map(c => c.row)), r1 = Math.max(...cs.map(c => c.row));
    const a = this.cellsRect(C.cellAt(c0, r0)?.id, 0), b = this.cellsRect(C.cellAt(c1, r1)?.id, 0), d = this.cellsRect(C.cellAt(c0, r1)?.id, 0), e = this.cellsRect(C.cellAt(c1, r0)?.id, 0);
    const rs = [a, b, d, e].filter(Boolean); if (!rs.length) return null;
    const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y)), x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  // screen bbox of the cells within k squares of a cell (projected corners)
  cellsRect(cell, k = 0) {
    const C = this.C, m = this.ui.map, c = cell && C.cell(cell); if (!c) return null;
    const pts = []; for (const [dc, dr] of [[-k, -k], [k + 1, -k], [-k, k + 1], [k + 1, k + 1]]) { const c0 = m.col0 || 0, r0 = m.row0 || 0, x = m.x0 + Math.max(0, Math.min(C.def.aor.cols, c.col - c0 + dc)) * m.cw, z = m.z0 + Math.max(0, Math.min(C.def.aor.rows, c.row - r0 + dr)) * m.ch; const p = m.screenOf(new (m.cellCenter(cell).constructor)(x, 0, z)); if (p) pts.push(p); }
    if (pts.length < 4) return null;
    const x0 = Math.min(...pts.map(p => p.x)), y0 = Math.min(...pts.map(p => p.y)), x1 = Math.max(...pts.map(p => p.x)), y1 = Math.max(...pts.map(p => p.y));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  // ------------------------------------------------------------------ lifecycle
  start(i = 0) {
    if (this.open) return; this.open = true; injectTutCss();
    const root = this.root = document.createElement('div'); root.className = 'c2-tut'; root.setAttribute('aria-live', 'polite');
    root.innerHTML = `<div class="c2-tut-blk"></div><div class="c2-tut-blk"></div><div class="c2-tut-blk"></div><div class="c2-tut-blk"></div><div class="c2-tut-hole"><i></i></div>
      <div class="c2-tut-card panel" role="dialog" aria-modal="true" aria-labelledby="c2-tut-t" aria-describedby="c2-tut-b"><div class="c2-tut-k kicker"></div><div class="c2-tut-t" id="c2-tut-t"></div><div class="c2-tut-b" id="c2-tut-b"></div>
        <div class="c2-tut-foot"><div class="c2-tut-dots" aria-hidden="true"></div><div class="c2-tut-btns"><button class="btn btn-ghost btn-s c2-tut-skip" data-act="skip">Skip</button><button class="btn btn-s c2-tut-back" data-act="back">Back</button><button class="btn btn-go btn-s c2-tut-next" data-act="next">Next</button></div></div></div>`;
    (this.ui.root || document.body).appendChild(root);
    this.blk = [...root.querySelectorAll('.c2-tut-blk')]; this.hole = root.querySelector('.c2-tut-hole'); this.card = root.querySelector('.c2-tut-card');
    root.querySelector('.c2-tut-dots').innerHTML = this.steps.map((s, k) => `<i data-k="${k}"></i>`).join('');
    root.addEventListener('click', e => { const a = e.target.closest('[data-act]')?.dataset.act; if (a === 'next') this.next(); else if (a === 'back') this.go(this.i - 1); else if (a === 'skip') this.close(this.i >= this.steps.length - 1 ? 'done' : 'skipped'); });
    for (const b of this.blk) { b.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); this.nudge(); }); b.addEventListener('wheel', e => e.preventDefault(), { passive: false }); b.addEventListener('contextmenu', e => e.preventDefault()); }
    this.onKey = e => {
      if (!this.open) return;
      const k = e.key; let used = true;
      if (k === 'ArrowRight' || (k === 'Enter' && !e.target.closest?.('.c2-tut-back, .c2-tut-skip'))) this.next();
      else if (k === 'ArrowLeft') this.go(this.i - 1);
      else if (k === 'Escape') this.close(this.i >= this.steps.length - 1 ? 'done' : 'skipped');
      else if (k === 'Tab') { const f = [...this.card.querySelectorAll('button:not([disabled])')]; const at = f.indexOf(document.activeElement); const n = f[(at + (e.shiftKey ? f.length - 1 : 1) + f.length) % f.length]; n?.focus(); }
      else used = !(k === ' ' || e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(k));   // the map and the command screen get no keys while the tour runs
      if (used) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', this.onKey, true);
    this.ui.map.keys?.clear?.();
    requestAnimationFrame(() => root.classList.add('on'));
    this.go(i);
    const loop = () => { if (!this.open) return; this.raf = requestAnimationFrame(loop); this.track(); };
    this.raf = requestAnimationFrame(loop);
  }
  nudge() { this.card.classList.remove('nudge'); void this.card.offsetWidth; this.card.classList.add('nudge'); }
  next() { const s = this.steps[this.i]; if (s?.onNext && s.waitFor && !s.waitFor()) s.onNext(); if (this.i >= this.steps.length - 1) return this.close('done'); this.go(this.i + 1); }
  go(i) {
    if (i < 0 || i >= this.steps.length) return;
    const prev = this.steps[this.i]; if (prev && prev !== this.steps[i]) try { prev.after?.(); } catch (e) { console.warn(e); }
    this.i = i; const s = this.steps[i];
    try { s.before?.(); } catch (e) { console.warn('tour step', s.id, e); }
    const r = this.root, last = i === this.steps.length - 1;
    this.card.classList.remove('in'); void this.card.offsetWidth;
    r.querySelector('.c2-tut-k').textContent = s.kicker || `STEP ${i} OF ${this.steps.length - 2}`;
    r.querySelector('.c2-tut-t').textContent = s.title;
    r.querySelector('.c2-tut-b').innerHTML = s.body;
    r.querySelector('.c2-tut-next').textContent = s.next || (last ? 'Done' : 'Next');
    r.querySelector('.c2-tut-skip').textContent = s.skip || (last ? 'Close' : 'Skip tour');
    r.querySelector('.c2-tut-skip').classList.toggle('hidden', last);
    r.querySelector('.c2-tut-back').classList.toggle('hidden', i === 0 || last);
    r.querySelectorAll('.c2-tut-dots i').forEach((d, k) => { d.className = k === i ? 'on' : k < i ? 'past' : ''; });
    r.classList.toggle('interactive', !!s.interactive);
    // the spotlight glides to the new step's element, then follows it frame by frame (no lag behind a flying camera)
    r.classList.add('glide'); clearTimeout(this.glideT); this.glideT = setTimeout(() => r.classList.remove('glide'), 1300);
    this.cur = null; this.lastKey = ''; this.track(true);
    requestAnimationFrame(() => { this.card.classList.add('in'); this.card.querySelector('.c2-tut-next')?.focus({ preventScroll: true }); });
  }
  // follow the target (the camera may still be flying, panels re-render) and auto-advance interactive steps
  // the player did what an interactive step asks (the screen calls this on selection changes; the frame loop too)
  poke() {
    const s = this.steps[this.i]; if (!this.open || !s) return;
    if (s.waitFor && s.interactive && s.waitFor() && !this.advancing) { this.advancing = true; setTimeout(() => { this.advancing = false; if (this.open && this.steps[this.i] === s) this.go(this.i + 1); }, 450); }
  }
  track(force = false) {
    const s = this.steps[this.i]; if (!s) return;
    this.poke();
    let t = null; try { t = typeof s.target === 'function' ? s.target() : null; } catch {}
    if (t instanceof Element) t = this.rectOf(t);
    const W = window.innerWidth, H = window.innerHeight;
    let r = t ? { x: Math.max(4, t.x - PAD), y: Math.max(4, t.y - PAD), w: 0, h: 0 } : null;
    if (r) { r.w = Math.min(W - 4, t.x + t.w + PAD) - r.x; r.h = Math.min(H - 4, t.y + t.h + PAD) - r.y; if (r.w < 8 || r.h < 8) r = null; }
    const key = r ? `${r.x | 0},${r.y | 0},${r.w | 0},${r.h | 0}` : 'none';
    if (!force && key === this.lastKey) return; this.lastKey = key;
    const hr = r || { x: W / 2, y: H / 2, w: 0, h: 0 };
    Object.assign(this.hole.style, { left: `${hr.x}px`, top: `${hr.y}px`, width: `${hr.w}px`, height: `${hr.h}px` });
    this.hole.classList.toggle('none', !r);
    // blockers around the hole (the hole itself lets clicks through on interactive steps only)
    const hole = s.interactive && r ? hr : { x: hr.x + hr.w / 2, y: hr.y + hr.h / 2, w: 0, h: 0 };
    const B = [[0, 0, W, hole.y], [0, hole.y + hole.h, W, H - hole.y - hole.h], [0, hole.y, hole.x, hole.h], [hole.x + hole.w, hole.y, W - hole.x - hole.w, hole.h]];
    if (!(s.interactive && r)) B[0] = [0, 0, W, H];
    this.blk.forEach((b, k) => Object.assign(b.style, { left: `${B[k][0]}px`, top: `${B[k][1]}px`, width: `${Math.max(0, B[k][2])}px`, height: `${Math.max(0, B[k][3])}px` }));
    this.place(r, s.place);
  }
  place(r, pref) {
    const W = window.innerWidth, H = window.innerHeight, cw = this.card.offsetWidth || 360, ch = this.card.offsetHeight || 200, g = 18;
    let x, y;
    if (!r) { x = (W - cw) / 2; y = (H - ch) / 2; }
    else {
      const fits = { right: r.x + r.w + g + cw < W - 8, left: r.x - g - cw > 8, bottom: r.y + r.h + g + ch < H - 8, top: r.y - g - ch > 8 };
      const order = [pref, 'right', 'left', 'bottom', 'top'].filter(Boolean); const side = order.find(o => fits[o]) || 'over';
      if (side === 'right') { x = r.x + r.w + g; y = r.y + r.h / 2 - ch / 2; }
      else if (side === 'left') { x = r.x - g - cw; y = r.y + r.h / 2 - ch / 2; }
      else if (side === 'bottom') { x = r.x + r.w / 2 - cw / 2; y = r.y + r.h + g; }
      else if (side === 'top') { x = r.x + r.w / 2 - cw / 2; y = r.y - g - ch; }
      else { x = W - cw - 24; y = H - ch - 24; }
      this.card.dataset.side = side;
    }
    x = Math.max(12, Math.min(W - cw - 12, x)); y = Math.max(12, Math.min(H - ch - 12, y));
    this.card.style.transform = `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;
  }
  close(how = 'skipped') {
    if (!this.open) return; this.open = false; cancelAnimationFrame(this.raf);
    try { this.steps[this.i]?.after?.(); } catch {}
    if (how === 'done' || tutorialState() !== 'done') setState(how);
    window.removeEventListener('keydown', this.onKey, true);
    const r = this.root; r.classList.remove('on'); r.classList.add('off'); setTimeout(() => r.remove(), 380);
    document.activeElement?.blur?.();
    this.opts.onClose?.(how);
  }
}

function injectTutCss() {
  if (document.getElementById('c2-tut-css')) return;
  const css = `
.c2-tut{position:absolute;inset:0;z-index:40;pointer-events:none;font-family:var(--font-ui,"Barlow SC",sans-serif);opacity:0;transition:opacity .35s ease}
.c2-tut.on{opacity:1}.c2-tut.off{opacity:0}
.c2-tut-blk{position:absolute;pointer-events:auto;background:transparent;cursor:default}
.c2-tut-hole{position:absolute;border-radius:0;pointer-events:none;box-shadow:0 0 0 200vmax rgba(6,8,10,.66)}
.c2-tut.glide .c2-tut-hole{transition:left .5s cubic-bezier(.2,.8,.2,1),top .5s cubic-bezier(.2,.8,.2,1),width .5s cubic-bezier(.2,.8,.2,1),height .5s cubic-bezier(.2,.8,.2,1),border-radius .5s}
.c2-tut-hole::before{content:"";position:absolute;inset:-2px;border-radius:0;border:2px solid var(--accent,#e9a93b);box-shadow:none}
.c2-tut-hole i{position:absolute;inset:-2px;border-radius:0;border:2px solid var(--accent,#e9a93b);animation:c2tutPing 1.8s cubic-bezier(.2,.7,.3,1) infinite}
.c2-tut-hole.none::before,.c2-tut-hole.none i{display:none}
.c2-tut.interactive .c2-tut-hole i{animation-duration:1.1s}
@keyframes c2tutPing{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(1.08)}}
.c2-tut-card{position:absolute;left:0;top:0;width:min(22rem,92vw);padding:var(--sp-4,16px) var(--sp-4,16px) var(--sp-3,12px);pointer-events:auto;background:rgba(23,27,31,.98);border:1px solid var(--line-2,rgba(196,212,192,.28));border-top:3px solid var(--accent,#e9a93b);box-shadow:0 18px 50px rgba(0,0,0,.55);}
.c2-tut.glide .c2-tut-card{transition:transform .5s cubic-bezier(.2,.8,.2,1)}
.c2-tut-card>*{transition:opacity .28s ease,transform .28s ease}
.c2-tut-card:not(.in) .c2-tut-k,.c2-tut-card:not(.in) .c2-tut-t,.c2-tut-card:not(.in) .c2-tut-b{opacity:0;transform:translateY(6px)}
.c2-tut-card.nudge{animation:c2tutNudge .4s}
@keyframes c2tutNudge{25%{margin-left:-6px}50%{margin-left:6px}75%{margin-left:-3px}}
.c2-tut-k{margin-bottom:var(--sp-1,4px)}
.c2-tut-t{font-family:var(--font-display,sans-serif);font-size:var(--fs-xl,24px);font-weight:800;text-transform:uppercase;letter-spacing:.02em;line-height:1;color:var(--t-1,#dfe4d6);margin-bottom:var(--sp-2,8px)}
.c2-tut-b{font-size:var(--fs-m,15px);line-height:1.45;color:var(--t-2,#98a395)}.c2-tut-b b{color:var(--t-1,#dfe4d6);font-weight:600}
.c2-tut-b .sw{display:inline-block;width:.8em;height:.8em;margin:0 .3em -.05em 0;border:1px solid rgba(0,0,0,.4)}.c2-tut-b .sw.own{background:#4f8fe0}.c2-tut-b .sw.en{background:#e0503f}
.c2-tut-foot{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:var(--sp-3,12px);margin-top:var(--sp-4,16px);padding-top:var(--sp-3,12px);border-top:1px solid var(--line,rgba(196,212,192,.13))}
.c2-tut-dots{display:flex;gap:5px;flex:1 1 100%}.c2-tut-dots i{width:6px;height:6px;background:var(--line-2,rgba(196,212,192,.28));transition:width .35s cubic-bezier(.2,.8,.2,1),background .35s}
.c2-tut-dots i.past{background:rgba(233,169,59,.45)}.c2-tut-dots i.on{width:18px;background:var(--accent,#e9a93b)}
.c2-tut-btns{display:flex;gap:var(--sp-2,8px);flex:none;margin-left:auto}
.c2-tut .hidden{display:none!important}
`;
  document.head.appendChild(Object.assign(document.createElement('style'), { id: 'c2-tut-css', textContent: css }));
}
