import * as THREE from 'three';
import { trenchNear } from '../game/trench.js';

// Mouse & keyboard command layer (Total War conventions).
export class Input {
  constructor(game, hud) {
    this.g = game; this.hud = hud; game.input = this;
    this.canvas = document.getElementById('view'); this.box = document.getElementById('selbox');
    this.ray = new THREE.Raycaster(); this.ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.runMode = false; this.mode = null;
    const c = this.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => this.down(e));
    addEventListener('pointerup', e => this.up(e));
    addEventListener('pointermove', e => this.move(e));
    c.addEventListener('dblclick', e => this.dbl(e));
    addEventListener('keydown', e => this.key(e));
    document.getElementById('orders').addEventListener('click', e => { const b = e.target.closest('button'); if (b) this.command(b.dataset.o); });
  }
  groundAt(x, y) {
    const v = new THREE.Vector2(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1);
    this.ray.setFromCamera(v, this.g.renderer.camera);
    const p = new THREE.Vector3(); return this.ray.ray.intersectPlane(this.ground, p) ? p : null;
  }
  // ray vs building boxes (for garrison targeting)
  buildingAt(x, y) {
    const v = new THREE.Vector2(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); this.ray.setFromCamera(v, this.g.renderer.camera);
    let best = null, bd = 1e9; const r = this.ray.ray, inv = new THREE.Matrix4(), lr = new THREE.Ray(), hit = new THREE.Vector3();
    for (const b of this.g.city.buildings) {
      inv.makeRotationY(b.rot).setPosition(b.x, 0, b.z).invert(); lr.copy(r).applyMatrix4(inv);
      const box = new THREE.Box3(new THREE.Vector3(-b.L / 2, 0, -b.D / 2), new THREE.Vector3(b.L / 2, b.height, b.D / 2));
      if (lr.intersectBox(box, hit)) { const d = hit.distanceTo(lr.origin); if (d < bd) { bd = d; best = b; } }
    }
    return best;
  }
  screenOf(p) { const v = new THREE.Vector3(p.x, (p.y || 0) + 1, p.z).project(this.g.renderer.camera); return v.z > 1 ? null : [(v.x * .5 + .5) * innerWidth, (-v.y * .5 + .5) * innerHeight]; }
  unitAt(x, y, side = null) {
    let best = null, bd = 26;
    for (const sq of this.g.squads) {
      if (sq.destroyed || sq.mounted || (side && sq.side !== side) || (sq.side === 'enemy' && !sq.spotted)) continue;
      for (const s of sq.soldiers) { if (!s.alive || s.inside === 'btr') continue; const p = this.screenOf(s.pos); if (!p) continue; const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = sq; } }
    }
    for (const v of this.g.vehicles) {
      if (v.destroyed || (side && v.side !== side) || (v.side === 'enemy' && !v.spotted)) continue;
      const p = this.screenOf(v.pos); if (!p) continue; const d = Math.hypot(p[0] - x, p[1] - y) - 14; if (d < bd) { bd = d; best = v; }
    }
    return best;
  }
  down(e) {
    if (e.button === 0) { this.drag = { x: e.clientX, y: e.clientY, btn: 0 }; }
    if (e.button === 2) { this.drag = { x: e.clientX, y: e.clientY, btn: 2, g0: this.groundAt(e.clientX, e.clientY) }; }
  }
  move(e) {
    this.lastMouse = [e.clientX, e.clientY];
    const d = this.drag; if (!d) return;
    if (d.btn === 0 && !this.mode) {
      const w = e.clientX - d.x, h = e.clientY - d.y;
      if (Math.abs(w) + Math.abs(h) > 8) { Object.assign(this.box.style, { display: 'block', left: `${Math.min(d.x, e.clientX)}px`, top: `${Math.min(d.y, e.clientY)}px`, width: `${Math.abs(w)}px`, height: `${Math.abs(h)}px` }); }
    }
    if (d.btn === 2 && d.g0 && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 25) {
      const g1 = this.groundAt(e.clientX, e.clientY); if (g1) this.hud.showPreview(this.formationPlan(d.g0, g1).flatMap(p => p.preview));
    }
  }
  up(e) {
    const d = this.drag; this.drag = null; this.box.style.display = 'none'; this.hud.preview.count = 0;
    if (!d) return;
    if (d.btn === 0) {
      if (this.mode === 'fireground') { const p = this.groundAt(e.clientX, e.clientY); if (p) { const sel = [...this.hud.selected]; for (const u of sel) { u.fireAt = { p: p.clone(), until: this.g.time + 30 }; u.target = null; } this.hud.groundMarker?.(p); if (sel.some(u => u.kind !== 'spg')) this.g.hud.alert(`${sel.length > 1 ? sel.length + ' units' : sel[0]?.name} firing on the area for 30 s (X halts)`); this.g.sfx('ui_order'); } this.mode = null; document.body.style.cursor = ''; return; }
      if (this.mode === 'mortar') { const p = this.groundAt(e.clientX, e.clientY); if (p && this.g.playerMortar(p.x, p.z)) { this.mode = null; document.body.style.cursor = ''; } return; }
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 8) {
        const x0 = Math.min(d.x, e.clientX), x1 = Math.max(d.x, e.clientX), y0 = Math.min(d.y, e.clientY), y1 = Math.max(d.y, e.clientY);
        const units = this.g.unitsOf('player').filter(u => { const c = u.center(); const p = this.screenOf(c); return p && p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1; });
        this.hud.select(units, e.shiftKey); if (units.length) this.g.sfx('ui_select');
      } else {
        const u = this.unitAt(e.clientX, e.clientY);
        if (u && u.side === 'player') { this.hud.inspect = null; this.hud.select([u], e.shiftKey); this.g.sfx('ui_select'); }
        else if (u) { this.hud.inspect = u; this.hud.updateInfo(); }
        else if (!e.shiftKey) { this.hud.inspect = null; this.hud.select([]); }
      }
      return;
    }
    if (d.btn === 2) {
      const sel = [...this.hud.selected]; if (!sel.length) return;
      const g1 = this.groundAt(e.clientX, e.clientY);
      if (d.g0 && g1 && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 25) {
        if (this.g.phase === 'deploy') { for (const p of this.formationPlan(d.g0, g1)) this.g.deployPlace(p.unit, p.x, p.z, p.facing); this.g.sfx('ui_order'); return; }
        for (const p of this.formationPlan(d.g0, g1)) p.unit.type === 'squad' ? p.unit.orderMove(p.x, p.z, p.facing, p.width, this.runMode || e.altKey) : p.unit.orderMove(p.x, p.z, p.facing, this.runMode);
        this.g.sfx('ui_order'); return;
      }
      if (this.g.phase === 'deploy') { if (g1) this.moveSelected(g1.x, g1.z, null); return; }
      // click: attack / mount / garrison / move
      const target = this.unitAt(e.clientX, e.clientY);
      if (target && target.side === 'enemy') { for (const u of sel) u.orderAttack(target); this.g.sfx('ui_order'); return; }
      if (target && target.type === 'vehicle' && target.side === 'player' && (target.kind === 'btr' || target.kind === 'ifv') && !target.passengers) {
        const sq = sel.find(u => u.type === 'squad' && !u.mounted); if (sq) { sq.orderMount(target); this.g.sfx('ui_order'); return; }
      }
      const b = this.buildingAt(e.clientX, e.clientY);
      const sqs = sel.filter(u => u.type === 'squad');
      if (b && sqs.length && g1 && b === this.g.city.buildingAt(g1.x, g1.z, 6)) { for (const s of sqs) s.orderGarrison(b); this.g.sfx('ui_order'); return; }
      // click into a trench: occupy it (or clear it if the enemy holds it)
      if (!b && sqs.length && g1 && this.g.city.trenchInfo?.(g1.x, g1.z)) { const T = trenchNear(this.g, g1.x, g1.z, 5); if (T) { for (const s of sqs) s.orderTrench(T); this.g.sfx('ui_order'); return; } }
      if (g1) this.moveSelected(g1.x, g1.z, null);
    }
  }
  moveSelected(x, z, facing) {
    const sel = [...this.hud.selected]; if (!sel.length) return;
    if (this.g.phase === 'deploy') {
      sel.forEach((u, i) => this.g.deployPlace(u, x + (i - (sel.length - 1) / 2) * 22, z, facing ?? Math.PI)); this.g.sfx('ui_order'); return;
    }
    // keep relative spacing between units around the click point
    const c = new THREE.Vector3(); sel.forEach(u => c.add(u.center())); c.multiplyScalar(1 / sel.length);
    const f = facing ?? Math.atan2(x - c.x, z - c.z);
    const right = [Math.cos(f), -Math.sin(f)];
    sel.forEach((u, i) => {
      const off = (i - (sel.length - 1) / 2) * 22;
      const px = x + right[0] * off, pz = z + right[1] * off;
      if (u.type === 'squad') u.orderMove(px, pz, f, 18, this.runMode); else u.orderMove(px, pz, f, this.runMode);
    });
    this.g.sfx('ui_order');
  }
  formationPlan(a, b) {
    const sel = [...this.hud.selected]; const L = Math.hypot(b.x - a.x, b.z - a.z);
    const dir = [(b.x - a.x) / L, (b.z - a.z) / L];
    // facing = perpendicular to the line, pointing away from the camera
    const cam = this.g.renderer.camera.position; const mid = [(a.x + b.x) / 2, (a.z + b.z) / 2];
    let n = [dir[1], -dir[0]]; if ((mid[0] - cam.x) * n[0] + (mid[1] - cam.z) * n[1] < 0) n = [-n[0], -n[1]];
    const facing = Math.atan2(n[0], n[1]);
    const seg = L / sel.length;
    return sel.map((u, i) => {
      const t = (i + 0.5) * seg; const x = a.x + dir[0] * t, z = a.z + dir[1] * t;
      const width = Math.max(6, seg * 0.9); const preview = [];
      if (u.type === 'squad') { const k = Math.max(1, u.effective.length); for (let j = 0; j < k; j++) { const o = (j - (k - 1) / 2) * Math.min(4.2, width / Math.max(1, k - 1)); preview.push([x + dir[0] * o, z + dir[1] * o]); } }
      else preview.push([x, z]);
      return { unit: u, x, z, facing, width, preview };
    });
  }
  dbl(e) {
    const u = this.unitAt(e.clientX, e.clientY, 'player'); if (!u) return;
    const same = this.g.unitsOf('player').filter(o => o.type === u.type && (o.kind === u.kind) && this.screenOf(o.center()));
    this.hud.select(same);
  }
  command(o) {
    const sel = [...this.hud.selected]; const g = this.g;
    if (o === 'run') { this.runMode = !this.runMode; for (const u of sel) if (u.type === 'squad') u.run = this.runMode; }
    if (o === 'holdfire') { const v = !sel.every(u => u.holdFire); for (const u of sel) u.holdFire = v; }
    if (o === 'halt') for (const u of sel) u.halt();
    if (o === 'garrison') { const p = this.lastMouse; const b = p && this.buildingAt(p[0], p[1]); const gp = p && this.groundAt(p[0], p[1]); const Tm = !b && gp ? trenchNear(g, gp.x, gp.z, 8) : null;
      for (const u of sel) if (u.type === 'squad') { const c = u.center(), Tn = Tm || (!b ? trenchNear(g, c.x, c.z, 30) : null), nb = !b && nearestBuilding(g, c); if (Tn && (Tm || !nb || nb.toLocal && Math.hypot(nb.x - c.x, nb.z - c.z) > 30)) { u.orderTrench(Tn); continue; } const bb = b || nearestBuilding(g, u.center()); if (bb) u.orderGarrison(bb); } }
    if (o === 'mount' && g.phase === 'deploy') {
      for (const u of sel) { const sq = u.type === 'squad' ? u : u.passengers; const v = u.type === 'vehicle' ? u : u.carrier;
        if (!sq || !v) continue;
        if (sq.mounted) { sq.dismount(); for (const s of sq.soldiers) { if (s.dmWait != null) sq.exitCarrier(s); s.jumpT = 0; s.path = null; s.goal = null; } const p = v.pos.clone().addScaledVector(new THREE.Vector3(Math.sin(v.heading), 0, Math.cos(v.heading)), -9); g.deployPlace(sq, p.x, p.z, v.heading); }
        else if (!v.passengers) sq.board(v, true); }
      g.sfx('ui_click'); this.hud.updateInfo(); return;
    }
    if (o === 'mount') for (const u of sel) {
      if (u.type === 'squad') { if (u.mounted) u.dismount(); else if (u.carrier && !u.carrier.destroyed && !u.carrier.passengers) u.orderMount(u.carrier); }
      else if ((u.kind === 'btr' || u.kind === 'ifv') && u.passengers) u.passengers.dismount();
    }
    if (o === 'resupply') for (const u of sel) if (u.type === 'squad' && u.carrier && !u.carrier.destroyed && !u.mounted) { const p = u.carrier.pos; u.orderMove(p.x + 6, p.z + 6, null, 12, true); g.hud.alert(`${u.name} moving to ${u.carrier.name} to resupply`); }
    if (o === 'smoke') for (const u of sel) if (u.type === 'squad' && !u.mounted) {
      if ((u.smokes ?? 2) <= 0) { g.hud.alert(`${u.name}: no smoke grenades left`); continue; }
      const m = this.lastMouse && this.groundAt(this.lastMouse[0], this.lastMouse[1]); const th = u.effective.find(s => !s.inside); if (!th || !m) continue;
      u.smokes = (u.smokes ?? 2) - 1; g.combat.throwSmoke(th, m);
    }
    if (o === 'fireground') { if (g.phase === 'deploy') { g.hud.alert('Area fire is available once the battle starts'); return; } if (sel.length) { this.mode = 'fireground'; document.body.style.cursor = 'crosshair'; g.hud.alert('Fire at ground: left-click the area to engage'); } }
    if (o === 'mortar' && g.phase === 'deploy') { g.hud.alert('Fire missions are available once the battle starts'); return; }
    if (o === 'mortar') { if (g.mortars > 0) { this.mode = 'mortar'; document.body.style.cursor = 'crosshair'; g.hud.alert('Mortar: left-click a target area'); } }
    g.sfx('ui_click'); this.hud.updateInfo();
  }
  key(e) {
    if (e.repeat) return; const g = this.g;
    const map = { KeyR: 'run', KeyF: 'holdfire', KeyG: 'garrison', KeyM: 'mount', KeyB: 'resupply', KeyX: 'halt', KeyT: 'mortar', KeyV: 'smoke', KeyC: 'fireground' };
    if (map[e.code]) { this.command(map[e.code]); return; }
    if (e.code === 'Enter' && g.phase === 'deploy') { g.startBattle(); return; }
    if (e.code === 'Tab') { e.preventDefault(); this.hud.rosterMini = !this.hud.rosterMini; this.hud.rebuildCards(); return; }
    if (e.code === 'Space') { e.preventDefault(); g.paused = !g.paused; document.getElementById('pausebadge').classList.toggle('hidden', !g.paused); }
    if (e.code === 'Escape') { this.mode = null; document.body.style.cursor = ''; this.hud.select([]); this.hud.inspect = null; }
    const m = e.code.match(/^Digit(\d)$/);
    if (m) { if (e.ctrlKey) { e.preventDefault(); this.hud.groups[m[1]] = [...this.hud.selected]; } else if (this.hud.groups[m[1]]) this.hud.select(this.hud.groups[m[1]]); }
    if (e.code === 'Backspace' && this.hud.selected.size) { const c = [...this.hud.selected][0].center(); g.cam.lookAt(c.x, c.z); }
  }
}
function nearestBuilding(g, c) { let best = null, bd = 60; for (const b of g.city.buildings) { const d = Math.hypot(b.x - c.x, b.z - c.z) - b.L / 2; if (d < bd && b.slots.some(s => !s.occupant)) { bd = d; best = b; } } return best; }
