// Campaign v7 previews: UAV models orbiting a target square and artillery fire-mission effects on the strategic map.
// usage: flock /tmp/heavy.lock nice -n 10 node src/campaign/v2/tools/v7_fx_shots.mjs UA|RU <tag>   -> previews/campaign_v7/
//        OVERRIDE=<dir>: files that exist under <dir> (same relative path) are served instead of the repo's (before shots)
// The fx clock is stepped by hand where the map offers it (map.fxAdvance(s)): swiftshader renders a frame in seconds.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'), ovr = process.env.OVERRIDE;
const out = path.join(repo, 'previews/campaign_v7'); fs.mkdirSync(out, { recursive: true });
const side = process.argv[2] || 'UA', tag = process.argv[3] || 'after', only = process.argv[4] || '';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]); let p = path.join(repo, rel);
  if (ovr && fs.existsSync(path.join(ovr, rel)) && !fs.statSync(path.join(ovr, rel)).isDirectory()) p = path.join(ovr, rel);
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r)); const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errors = [];
page.on('console', m => { if (/404|GPU stall|GroupMarkerNotSet|content_index/.test(m.text())) return; if (m.type() === 'error') { errors.push(m.text()); console.log('[page]', m.text()); } else if (m.text().startsWith('[v7]')) console.log(m.text()); });
page.on('pageerror', e => { errors.push(e.message); console.log('[pageerror]', e.stack || e.message); });
const shot = async (n, wait = 1200) => { await page.waitForTimeout(wait); await page.screenshot({ path: path.join(out, `${tag}_${n}_${side}.png`), timeout: 240000 }); console.log('shot', n); };
const clean = () => page.evaluate(() => document.querySelectorAll('.c2-modal, .c2-tour, .c2-tut, .c2-toast, .c2-modal-bg').forEach(e => e.remove()));
// step the fx clock (new map) or just wait in real time (old map)
const adv = async s => { const ok = await page.evaluate(s => { const m = window.__c2.map; if (!m.fxAdvance) return false; m.fxAdvance(s); return true; }, s); if (!ok) await page.waitForTimeout(Math.min(s, 3) * 1000); };   // old map: its strike rings last 2.2 s
const t0 = Date.now();
await page.goto(`${base}/index.html?campaign=1&cside=${side}&nointro`); await page.waitForFunction('window.__done === true', null, { timeout: 600000 });
console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');
await clean();
await page.evaluate(() => { const ui = window.__c2; ui.opts = { ...(ui.opts || {}), noFly: true }; window.__v7 = {};
  // camera on a point in the air (a drone): the ground target behind it on the view ray, `off` km from the point
  window.__aim = (P, off, yaw, pitch) => { const m = window.__c2.map, dx = Math.sin(yaw) * Math.cos(pitch), dy = Math.sin(pitch), dz = Math.cos(yaw) * Math.cos(pitch), s = P.y / dy; m.jump({ x: P.x - dx * s, z: P.z - dz * s, dist: s + off, yaw, pitch }); }; if (ui.map.fxFreeze !== undefined) ui.map.fxFreeze = true; });

// ---------------------------------------------------------------- 1. UAV sorties (fixed wing + quad), close cameras
if (!only || only === 'uav') {
  const u = await page.evaluate(() => {
    const ui = window.__c2, C = ui.C, m = ui.map;
    const cand = C.def.aor.cells.filter(c => C.owner[c.id] !== 'player' && (!C.isOpen || C.isOpen(c.id)) && !C.uavCheck('wing', c.id));
    const near = id => Math.min(...C.def.aor.cells.filter(c => C.owner[c.id] === 'player').map(c => Math.max(Math.abs(c.col - C.cell(id).col), Math.abs(c.row - C.cell(id).row))));
    cand.sort((a, b) => near(a.id) - near(b.id)); const w = cand[0]?.id, q = cand.find(c => c.id !== w && !C.uavCheck('quad', c.id) && Math.abs(c.col - C.cell(w).col) >= 2)?.id;
    return { w, q };
  });
  console.log('uav targets', JSON.stringify(u));
  // launch (the new map flies the drone in from the own side: step it to the orbit)
  await page.evaluate(({ w }) => { const ui = window.__c2; ui.startTarget({ kind: 'uav', type: 'wing' }); ui.targetClick(w); }, u);
  await clean();
  await page.evaluate(() => { const m = window.__c2.map; if (m.uavAdvance) { m.uavAdvance(4); m.uavHold = true; } const d = m.uavs?.find(x => !x.leaving && !x.leave); if (d) window.__aim(d.obj.position, 2.2, 0.5, 0.5); });
  await shot('uav_launch', 600);
  await page.evaluate(() => { const m = window.__c2.map; m.uavHold = false; if (m.uavAdvance) m.uavAdvance(9); });
  await page.evaluate(({ w }) => { const m = window.__c2.map, p = m.cellCenter(w); m.jump({ x: p.x, z: p.z, dist: 4.2, yaw: 0.5, pitch: 0.72 }); }, u);
  await shot('uav_wing_orbit');
  // close-up on the drone itself
  await page.evaluate(() => { const m = window.__c2.map, d = m.uavs?.find(x => !x.leaving && !x.leave); if (!d) return; m.uavHold = true; window.__aim(d.obj.position, 0.9, 0.9, 0.62); });
  await shot('uav_wing_close');
  await page.evaluate(() => { const m = window.__c2.map; m.uavHold = false; });
  if (u.q) {
    await page.evaluate(({ q }) => { const ui = window.__c2; ui.startTarget({ kind: 'uav', type: 'quad' }); ui.targetClick(q); }, u);
    await clean();
    await page.evaluate(() => { const m = window.__c2.map; if (m.uavAdvance) m.uavAdvance(9); });
    await page.evaluate(() => { const m = window.__c2.map, d = [...(m.uavs || [])].reverse().find(x => !x.leaving && !x.leave); if (!d) return; m.uavHold = true; window.__aim(d.obj.position, 0.5, 2.2, 0.55); });
    await shot('uav_quad_close');
    await page.evaluate(() => { const m = window.__c2.map; m.uavHold = false; });
  }
  // model gallery (same scale for the three types, plus side / enemy variant), rendered in a separate canvas
  await page.evaluate(async () => {
    const THREE = await import('three'), M = await import('/src/campaign/v2/map3d.js'), side = window.__c2.C.side || window.__c2.C.def.id;
    const cv = document.createElement('canvas'); cv.width = 1400; cv.height = 800; cv.id = 'v7gal'; Object.assign(cv.style, { position: 'fixed', left: 0, top: 0, zIndex: 99999, background: '#9aa38c' }); document.body.appendChild(cv);
    const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true }); r.outputColorSpace = THREE.SRGBColorSpace; r.setClearColor('#8d9682');
    const sc = new THREE.Scene(); sc.add(new THREE.HemisphereLight('#dfe6f0', '#3a3a30', 1.6)); const sun = new THREE.DirectionalLight('#fff2dc', 1.9); sun.position.set(-0.6, 1, 0.4); sc.add(sun);
    const list = [['UA', 'wing'], ['RU', 'wing'], [side, 'quad']], objs = [];
    list.forEach(([s, t], i) => { const o = M.uavModel(s, t, 2); const k = 1 / (o.userData.span || o.scale.x * 1.9); o.scale.multiplyScalar(k * (t === 'quad' ? 0.55 : 1)); o.position.set((i - 1) * 1.15, 0, 0); o.rotation.set(0, 2.5, 0); o.rotateZ(-0.12); sc.add(o); objs.push(o); });
    const cam = new THREE.PerspectiveCamera(30, 1400 / 800, 0.01, 50); cam.position.set(0, 0.95, 2.5); cam.lookAt(0, -0.05, 0);
    r.render(sc, cam);
  });
  await shot('uav_models', 300);
  await page.evaluate(() => document.getElementById('v7gal')?.remove());
}

// ---------------------------------------------------------------- 2. fire missions: suppress (tube), Grad, interdict, counter-battery
const fireAt = async (n, pick) => {
  const f = await page.evaluate(pick => {
    const ui = window.__c2, C = ui.C, m = ui.map;
    if (pick.mission === 'counterbattery') for (const b of C.batteries('player')) if (b.acted === C.turn) b.acted = -1;
    C.ammo.player = Math.max(C.ammo.player, 6);
    const bats = C.batteries('player').filter(b => !b.down && b.acted !== C.turn);
    let b = bats.find(x => pick.kinds.includes(x.kind)) || (pick.any ? bats[0] : null); if (!b) return null;
    if (pick.mission === 'counterbattery') {
      for (const e of C.batteries('enemy')) e.revealed = C.turn;
      // staged for the preview: no found battery in range -> put one into the coverage of a gun battery
      const e = C.batteries('enemy').find(x => !x.down && x.hp > 0), g = bats.find(x => x.kind !== 'mortar120' && x.kind !== 'grad') || bats[0];
      if (e && g && !Object.values(C.fireTargets(g.id)).some(k => k.includes('counterbattery'))) { const cov = C.batteryRange(g.id).coverage.filter(id => C.owner[id] !== 'player'); if (cov.length) e.cell = cov[Math.floor(cov.length / 2)]; }
      b = g;
    }
    const tg = C.fireTargets(b.id), ids = Object.keys(tg).filter(id => tg[id].includes(pick.mission));
    if (!ids.length) return null;
    const bc = C.cell(b.cell); ids.sort((a, z) => { const A = C.cell(a), Z = C.cell(z); return Math.hypot(A.col - bc.col, A.row - bc.row) - Math.hypot(Z.col - bc.col, Z.row - bc.row); });
    const id = pick.road ? (ids.find(i => C.cell(i).road) || ids[0]) : ids[Math.min(ids.length - 1, 1)];
    ui.startTarget({ kind: 'fire', bat: b.id, mission: pick.mission }); ui.targetClick(id);
    const a = m.cellCenter(b.cell), t = m.cellCenter(id);
    return { bat: b.kind, cell: id, from: b.cell, a: [a.x, a.z], t: [t.x, t.z] };
  }, pick);
  console.log(n, JSON.stringify(f)); if (!f) return null; await clean();
  return f;
};
// camera from the side of the line of fire (arcs seen in profile), `side` turns it towards the target (+) or battery (-)
const frame = (f, k = 0.5, dist, side = 0.55, pitch = 0.5) => page.evaluate(({ f, k, dist, side, pitch }) => {
  const m = window.__c2.map, dx = f.t[0] - f.a[0], dz = f.t[1] - f.a[1], L = Math.hypot(dx, dz), yaw = Math.atan2(dz, -dx) + side;
  m.jump({ x: f.a[0] + dx * k, z: f.a[1] + dz * k, dist: dist || Math.max(4, L * 0.8), yaw, pitch });
}, { f, k, dist, side, pitch });
if (!only || only === 'fire') {
  let f = await fireAt('suppress', { kinds: ['how122', 'd30', 'how152', 'msta', 'm777'], mission: 'suppress', any: true });
  if (f) {
    await frame(f, 0.0, 2.6, 0.9, 0.45); await adv(0.3); await shot('fire_salvo', 600);
    await frame(f, 0.5, null, 0.3, 0.42); await adv(1.5); await shot('fire_arcs', 600);
    await frame(f, 1, 3.0, 0.7, 0.55); await adv(0.9); await shot('fire_impact', 600);
    await adv(5); await shot('fire_smoke', 600);
    await adv(40); await frame(f, 1, 2.6, 0.6, 1.0); await shot('fire_craters', 600);
  }
  f = await fireAt('grad', { kinds: ['grad'], mission: 'suppress' });
  if (f) { await frame(f, 0.0, 3.0, 0.9, 0.45); await adv(1.2); await shot('grad_ripple', 600); await frame(f, 0.5, null, 0.3, 0.42); await adv(0.8); await shot('grad_arcs', 600); await frame(f, 1, 3.6, 0.7, 0.55); await adv(1.6); await shot('grad_impact', 600); }
  f = await fireAt('interdict', { kinds: ['how122', 'd30', 'how152', 'msta', 'm777', 'mortar120', 'grad'], mission: 'interdict', road: true, any: true });
  if (f) { await frame(f, 1, 3.2, 0.5, 0.75); await adv(4.5); await shot('interdict', 600); await adv(40); await frame(f, 1, 2.6, 0.5, 1.1); await shot('interdict_craters', 600); }
  f = await fireAt('counterbattery', { kinds: ['how122', 'd30', 'how152', 'msta', 'm777', 'grad', 'mortar120'], mission: 'counterbattery', any: true });
  if (f) { await frame(f, 1, 2.6, 0.6, 0.6); await adv(3.6); await shot('counterbattery', 600); }
}
// ---------------------------------------------------------------- 3. end of the week: drones depart, enemy fire on own squares
if (!only || only === 'enemy') {
  await page.evaluate(() => { const ui = window.__c2; ui.confirmedWeek = true; ui.endTurn(); });
  await page.waitForTimeout(500); await clean();
  const e = await page.evaluate(() => { const C = window.__c2.C; return (C.fireLog || []).filter(l => l.side === 'enemy' && l.turn === C.turn).map(l => ({ cell: l.cell, kind: l.kind, bat: C.battery(l.battery)?.kind })); });
  console.log('enemy fire', JSON.stringify(e));
  if (e.length) {
    await page.evaluate(c => { const m = window.__c2.map, p = m.cellCenter(c); m.jump({ x: p.x, z: p.z, dist: 3.6, yaw: 0.35, pitch: 0.55 }); }, e[0].cell);
    await adv(2.6); await shot('enemy_fire', 600);
    await adv(5); await shot('enemy_fire_smoke', 600);
  }
}
console.log('errors', errors.length);
await browser.close(); server.close();
