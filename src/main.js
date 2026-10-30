import { Game } from './game/game.js';
import { HUD } from './ui/hud.js';
import { Input } from './ui/input.js';

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
  hud.alert(`${game.playerFaction.name}: hold School No. 7 and the Market Crossroads for ${opts.minutes} minutes`, 'good');
  if (Q.has('sim')) { // headless test mode: simulate N seconds, render one frame, report
    window.__done = false;
    const total = +Q.get('sim'); game.noRender = true; const cam = Q.get('cam');
    if (cam) { if (cam !== 'fight') { const [x, z, d, yaw, pitch] = cam.split(',').map(Number); game.cam.lookAt(x, z); game.cam.tDist = d || 80; if (yaw != null && !isNaN(yaw)) game.cam.tYaw = yaw; if (pitch) game.cam.tPitch = pitch; } }
    if (Q.get('sel')) hud.select([game.playerUnits[+Q.get('sel')]]);
    if (!Q.has('deploy')) game.startBattle();
    if (Q.has('collapse')) { const b = game.city.buildings[+Q.get('collapse')]; game.city.collapseSection(b, +(Q.get('sec') || 0), game); }
    const t0 = performance.now();
    for (let t = 0; t < total; t += 0.05) { game.frame(0.05); if (game.over) break; }
    if (cam === 'fight') { // frame the nearest firefight
      let best = null, bd = 1e9;
      for (const e of game.squads) if (e.side === 'enemy' && !e.mounted && !e.destroyed) for (const p of game.squads) if (p.side === 'player' && !p.mounted && !p.destroyed) { const d = e.center().distanceTo(p.center()); if (d < bd) { bd = d; best = [e.center(), p.center()]; } }
      if (best) { const m = best[0].clone().lerp(best[1], 0.35); game.cam.lookAt(m.x, m.z); game.cam.tDist = +(Q.get('dist') || 38); game.cam.tYaw = Math.atan2(best[1].x - best[0].x, best[1].z - best[0].z) + 0.5; game.cam.tPitch = 0.45; }
    }
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
      vehicles: game.vehicles.map(v => `${v.side[0]}${v.kind}${v.destroyed ? 'X' : Math.round(v.hp)}`).join(' '), missing: game.assets.missing.length, particles: game.fx.smoke.p.length, glow: game.fx.glow.p.length, bigNear: game.fx.smoke.p.filter(o => o.size1 > 6 && Math.hypot(o.x - game.renderer.camera.position.x, o.z - game.renderer.camera.position.z) < 120).length };
    window.__done = true; return;
  }
  let last = performance.now();
  const loop = now => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    try { game.frame(dt); } catch (e) { console.error(e); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__done = true;
}

$('startBtn').addEventListener('click', () => {
  const side = document.querySelector('input[name=side]:checked').value;
  const rl = $('roundLen').value; const minutes = rl === 'rand' ? 10 + Math.floor(Math.random() * 7) : +rl;
  start({ side, minutes, quality: $('quality').value });
});
if (Q.has('autostart')) start({ side: Q.get('side') || 'UA', minutes: +(Q.get('min') || 12), quality: Q.get('quality') || 'medium' });
