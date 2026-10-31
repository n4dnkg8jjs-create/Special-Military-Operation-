import * as THREE from 'three';
import { Game } from './game/game.js';
import { HUD } from './ui/hud.js';
import { Input } from './ui/input.js';
import { MAPS } from './world/maps.js';

const Q = new URLSearchParams(location.search);
const $ = id => document.getElementById(id);

async function start(opts) {
  $('menu').classList.add('hidden'); $('loading').classList.remove('hidden');
  const game = window.game = new Game(opts);
  try {
    await game.init((f, msg) => { $('loadBar').style.width = `${Math.round(f * 100)}%`; $('loadText').textContent = msg; });
  } catch (e) { console.error(e); $('loadText').textContent = 'Failed to start: ' + e.message; throw e; }
  const hud = new HUD(game); new Input(game, hud);
  $('loading').classList.add('hidden');
  if (game.assets.missing.length) console.info('Procedural stand-ins used for:', game.assets.missing.join(', '));
  const [oa, ob] = game.objectives; hud.alert(`${game.playerFaction.name}: take ${oa.name} and the ${ob.name}, then hold them for ${opts.minutes} minutes`, 'good');
  if (Q.has('sim')) { // headless test mode: simulate N seconds, render one frame, report
    window.__done = false;
    const total = +Q.get('sim'); game.noRender = true; const cam = Q.get('cam');
    if (cam) { if (!/^(fight|atgm|fpv)$/.test(cam)) { const [x, z, d, yaw, pitch] = cam.split(',').map(Number); game.cam.lookAt(x, z); game.cam.tDist = d || 80; if (yaw != null && !isNaN(yaw)) game.cam.tYaw = yaw; if (pitch) game.cam.tPitch = pitch; } }
    if (Q.get('sel')) hud.select([game.playerUnits[+Q.get('sel')]]);
    if (!Q.has('deploy')) game.startBattle();
    if (Q.has('fire')) { const [fx, fz] = Q.get('fire').split(',').map(Number); game.fx.emitter(new THREE.Vector3(fx, 0, fz), 'fire', 1.3, 999); }
    if (Q.has('bail')) { const v = game.playerUnits.filter(u => u.type === 'vehicle')[+Q.get('bail')]; if (v.passengers) v.passengers.dismount(); v.burning = 0.01; v.bailAt = 0.2; }
    if (Q.has('collapse')) { const b = game.city.buildings[+Q.get('collapse')]; game.city.collapseSection(b, +(Q.get('sec') || 0), game); }
    const t0 = performance.now();
    for (let t = 0; t < total; t += 0.05) { game.frame(0.05); if (game.over) break; }
    if (cam === 'fight') { // frame the nearest firefight
      let best = null, bd = 1e9;
      for (const e of game.squads) if (e.side === 'enemy' && !e.mounted && !e.destroyed) for (const p of game.squads) if (p.side === 'player' && !p.mounted && !p.destroyed) { const d = e.center().distanceTo(p.center()); if (d < bd) { bd = d; best = [e.center(), p.center()]; } }
      if (best) { const m = best[0].clone().lerp(best[1], 0.35); game.cam.lookAt(m.x, m.z); game.cam.tDist = +(Q.get('dist') || 38); game.cam.tYaw = Math.atan2(best[1].x - best[0].x, best[1].z - best[0].z) + 0.5; game.cam.tPitch = 0.45; }
    }
    if (cam === 'atgm' || cam === 'fpv') { const q = game.squads.find(s => s.side === 'player' && s.kind === cam); if (q) { const c = (q.effective[0] || q.soldiers[0]).pos; game.cam.lookAt(c.x, c.z); game.cam.tDist = +(Q.get('dist') || 9); game.cam.tYaw = +(Q.get('yaw') || 2.8); game.cam.tPitch = 0.35; } }
    for (let i = 0; i < 40; i++) game.cam.update(0.05);
    if (Q.has('nofx')) { game.fx.smoke.mesh.visible = false; game.fx.glow.mesh.visible = false; }
    if (Q.has('nofog')) game.scene.fog.density = 0;
    game.noRender = false; game.frame(0.0001); game.renderer.render(0.016, game.time);
    const gl = game.renderer.r.getContext(); gl.finish();
    const rt0 = performance.now(); game.renderer.r.info.autoReset = false; game.renderer.r.info.reset(); for (let i = 0; i < 3; i++) { game.frame(0.016); } gl.finish(); const renderMs = (performance.now() - rt0) / 3;
    const ri = game.renderer.r.info;
    const br = {}; game.scene.traverse(o => { if (!(o.isMesh) || !o.visible) return; let vis = true; for (let p = o; p; p = p.parent) if (!p.visible) { vis = false; break; } if (!vis) return; const g = o.geometry; const t = (g.index ? g.index.count : g.attributes.position?.count || 0) / 3 * (o.isInstancedMesh ? o.count : 1); let k = o.isSkinnedMesh ? 'soldier' : o.isInstancedMesh ? 'inst:' + (o.name || '?').replace(/_(intact|damaged|holed|destroyed)$/, '') : 'mesh'; let r = o; while (r.parent && r.parent !== game.scene) r = r.parent; if (!o.isSkinnedMesh && !o.isInstancedMesh) k = 'mesh:' + (r.name || r.type); (br[k] ||= [0, 0]); br[k][0]++; br[k][1] += Math.round(t); });
    window.__br = Object.entries(br).sort((a, b) => b[1][1] - a[1][1]).slice(0, 25);
    window.__info = { renderMs: Math.round(renderMs), calls: Math.round(ri.render.calls / 3), tris: Math.round(ri.render.triangles / 3), programs: ri.programs?.length, simMs: Math.round(performance.now() - t0), time: Math.round(game.time), over: game.over, result: game.result?.title,
      objectives: game.objectives.map(o => `${o.id}:${o.owner}:${Math.round(o.control)}`),
      player: game.stats.player, enemy: game.stats.enemy, squads: game.squads.map(s => `${s.side[0]}${s.effective.length}/${Math.round(s.morale)}${s.routing ? 'R' : ''}${s.mounted ? 'M' : ''}`).join(' '),
      vehicles: game.vehicles.map(v => `${v.side[0]}${v.kind}${v.destroyed ? 'X' : Math.round(v.hp)}`).join(' '), missing: game.assets.missing.length, support: game.squads.filter(s => s.support).map(s => `${s.side[0]}:${s.name}:${s.effective.length}:${s.status()}`).join(' | '), slog: (game.supportLog || []).slice(-30), crushed: (game.city.crushables || []).filter(c => c.crushed).length + '/' + (game.city.crushables || []).length, particles: game.fx.smoke.p.length, glow: game.fx.glow.p.length, bigNear: game.fx.smoke.p.filter(o => o.size1 > 6 && Math.hypot(o.x - game.renderer.camera.position.x, o.z - game.renderer.camera.position.z) < 120).length };
    window.__done = true; return;
  }
  let last = performance.now();
  const loop = now => {
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000)); last = Math.max(last, now);
    try { game.frame(dt); } catch (e) { console.error(e); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__done = true;
}

$('startBtn').addEventListener('click', () => {
  const side = document.querySelector('input[name=side]:checked').value;
  const rl = $('roundLen').value; const minutes = rl === 'rand' ? 10 + Math.floor(Math.random() * 7) : +rl;
  start({ side, minutes, quality: $('quality').value, map: selMap });
});

// ---------------------------------------------------------------- map picker (size badge on each card + in the header)
let selMap = localStorage.getItem('smo_map') || 'city'; if (!MAPS[selMap]) selMap = 'city';
function drawMapPreview(c, m) {
  const x = c.getContext('2d'), S = c.width, k = S / m.sizeM, o = m.sizeM / 2, P = (v) => (v + o) * k;
  x.fillStyle = m.kind === 'rural' ? '#4a4a33' : '#3b3c36'; x.fillRect(0, 0, S, S);
  if (m.kind === 'rural') { const r = mulberry32(5); for (let i = 0; i < 26; i++) { x.fillStyle = ['#5a5238', '#3d3326', '#6b6340', '#4d5232'][Math.floor(r() * 4)]; x.fillRect(r() * S, r() * S, 20 + r() * 50, 20 + r() * 50); } }
  for (const r of m.roads) { x.fillStyle = r.type === 'track' ? '#7a6c55' : '#8a8a84'; x.fillRect(P(r.x0), P(r.z0), Math.max(1.2, (r.x1 - r.x0) * k), Math.max(1.2, (r.z1 - r.z0) * k)); }
  x.strokeStyle = '#2f4a25'; x.lineWidth = 3; for (const [a, b, c2, d] of m.treelines || []) { x.beginPath(); x.moveTo(P(a), P(b)); x.lineTo(P(c2), P(d)); x.stroke(); }
  x.fillStyle = '#c9c4b5'; for (const [bx, bz, rot, mod, , dm] of m.buildings) { const L = mod * 3.2, D = dm * 3.2; x.save(); x.translate(P(bx), P(bz)); x.rotate(-rot); x.fillRect(-L / 2 * k, -D / 2 * k, Math.max(1.5, L * k), Math.max(1.5, D * k)); x.restore(); }
  for (const v of m.villages || []) { x.fillStyle = '#b8a98e'; const n = 14; for (let i = 0; i < n; i++) { const t = v.from + (v.to - v.from) * i / n; for (const sd of [-1, 1]) { const cx = v.street === 'x' ? t : (v.x0 + v.x1) / 2 + sd * 14, cz = v.street === 'x' ? (v.z0 + v.z1) / 2 + sd * 14 : t; x.fillRect(P(cx) - 1, P(cz) - 1, 2.2, 2.2); } } }
  for (const ob of m.objectives) { x.fillStyle = '#8fb069'; x.beginPath(); x.arc(P(ob.x), P(ob.z), 4, 0, 7); x.fill(); x.fillStyle = '#111'; x.font = 'bold 7px sans-serif'; x.textAlign = 'center'; x.fillText(ob.id, P(ob.x), P(ob.z) + 2.5); }
  x.fillStyle = 'rgba(143,176,105,.35)'; const z1 = m.deployZones.player; x.fillRect(P(z1.x0), P(z1.z0), (z1.x1 - z1.x0) * k, (z1.z1 - z1.z0) * k);
  x.fillStyle = 'rgba(200,72,58,.35)'; const z2 = m.deployZones.enemy; x.fillRect(P(z2.x0), P(z2.z0), (z2.x1 - z2.x0) * k, (z2.z1 - z2.z0) * k);
}
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function pickMap(id) {
  selMap = id; try { localStorage.setItem('smo_map', id); } catch { }
  const m = MAPS[id];
  for (const el of document.querySelectorAll('.mapcard')) el.classList.toggle('sel', el.dataset.map === id);
  $('mapKicker').innerHTML = `MAP · ${m.name.toUpperCase()}<span class="size-big">${m.size.toUpperCase()} · ${m.sizeM} × ${m.sizeM} M</span>`;
  const [a, b] = m.objectives;
  $('mapBrief').innerHTML = `${m.blurb} Your motorized rifle company rides in on armour with an assault squad on the lead tank. <b>Capture Objective A — ${a.name}</b> and <b>Objective B — ${b.name}</b>, then <b>hold both</b> against counterattacks until the round ends. Ammunition is limited, wounded must be pulled back, and squads that lose their nerve will break.`;
}
if ($('mapPick')) {
  for (const m of Object.values(MAPS)) {
    const el = document.createElement('div'); el.className = 'mapcard'; el.dataset.map = m.id;
    el.innerHTML = `<span class="size">${m.size.toUpperCase()}</span><canvas width="184" height="184"></canvas><div><div class="mc-name">${m.name}</div><div class="mc-sub">${m.sizeM} × ${m.sizeM} m · ${m.kind === 'rural' ? 'Farmland, villages' : 'Urban, panel blocks'}</div><div class="mc-sub">${m.objectives.map(o => o.id + ': ' + o.name).join(' · ')}</div></div>`;
    drawMapPreview(el.querySelector('canvas'), m); el.addEventListener('click', () => pickMap(m.id)); $('mapPick').appendChild(el);
  }
  pickMap(selMap);
}
if (Q.has('autostart')) start({ side: Q.get('side') || 'UA', minutes: +(Q.get('min') || 12), quality: Q.get('quality') || 'medium', map: Q.get('map') || 'city' });
