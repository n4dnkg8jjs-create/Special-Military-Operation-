// In-game dismount filmstrip: one page load, the riders of player vehicle i dismount, frames at several times / camera angles.
// Usage: node tools/blender/soldiers/pvdismount.mjs <out.png> "<side=RU&map=city...>" <vehicle i> "<t1,t2,...>" "<cams: dist:yawDeg:height;...>" [cols]
//   cams are relative to the vehicle (yaw 0 = camera on the vehicle's left side (+X), 90 = behind it, 180 = right side, 270 = in front)
//   env FOCUS=x,z (vehicle-local focus offset), BURN=1 (bail=i path: vehicle set burning, crew bails out), PRE=s (sim seconds before
//   dismount, default 2), TRACE=1 (writes per-rider root / hips traces next to out.png), RIDEALL=1 (every seat of
//   vehicle i taken by its passengers, the rest inside), BOARD=1 (first unmounted rifle squad of the side
//   boards vehicle i first, instant), W / H (frame size)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.ktx2': 'application/octet-stream', '.bin': 'application/octet-stream', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const [out, q, vi, ts, cams, cols = '4'] = process.argv.slice(2);
const W = +(process.env.W || 560), H = +(process.env.H || 420);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('console', m => { if (/404|GPU stall|GroupMarkerNotSet/.test(m.text())) return; if (m.type() === 'error' || process.env.VERBOSE || /^TRACE/.test(m.text())) console.log('[page]', m.type(), m.text()); });
page.on('pageerror', e => console.log('[pageerror]', e.stack || e.message));
await page.goto(`http://localhost:${port}/index.html?autostart&quality=medium&nofog&sim=0.05&${q}`);
await page.waitForFunction('window.__done === true', null, { timeout: 900000 });
const setup = await page.evaluate(([vi, pre, burn, focus, board, ride]) => {
  const g = window.game; const v = g.playerUnits.filter(u => u.type === 'vehicle')[+vi];
  window.__dm = { v, focus };
  for (const sq of g.squads) for (const s of sq.soldiers) Object.defineProperty(s, 'inView', { get: () => true, set() {}, configurable: true });   // full-rate animation
  if (board && !v.passengers) {
    const sq = g.squads.find(q => q.side === 'player' && !q.mounted && !q.support && !q.crew && q.kind !== 'atgm' && q.kind !== 'fpv' && q.effective.length >= 6);
    if (sq) { if (sq.carrier?.passengers === sq) sq.carrier.passengers = null; sq.board(v, true); }
  }
  document.querySelectorAll('body > *:not(#view)').forEach(e => { e.style.display = 'none'; });
  const aim = () => { const c = g.cam; c.tFocus.set(v.pos.x, 0, v.pos.z); c.focus.copy(c.tFocus); c.tDist = c.dist = 16; };
  window.__dm.aim = aim; aim();
  for (const sq of g.squads) for (const s of sq.soldiers) if (sq.side === 'enemy') { s.hp = -999; }   // nobody shoots at them
  g.noRender = true;
  if (ride && v.passengers) {   // RIDEALL=1: every seat taken by a rider (the rest inside)
    let k = 0; for (const s of v.passengers.soldiers) { if (s.state === 'dead' || s.state === 'evac') continue; if (k < v.seatCount()) { s.inside = 'ride'; s.seat = { i: k }; s.seatType = v.seatType(k); k++; } else { s.inside = 'btr'; s.seat = null; } }
  }
  for (let t = 0; t < pre; t += 0.05) { aim(); g.frame(0.05); }
  const sq = v.passengers;
  const riders = sq ? sq.soldiers.filter(s => s.inside === 'ride').map(s => s.seat.i) : [];
  if (burn) { if (sq) sq.dismount(); v.burning = 0.01; v.bailAt = 0.2; } else if (sq) sq.dismount();
  window.__dm.t0 = g.time; window.__dm.sq = sq; window.__dm.trace = [];
  return { all: g.playerUnits.filter(u => u.type === 'vehicle').map((u, i) => `${i}:${u.assetKey}${u.passengers ? '+' + u.passengers.soldiers.filter(s => s.inside === 'ride').length : ''}`).join(' '), asset: v.assetKey, kind: v.kind, speed: +v.speed.toFixed(2), seats: v.seats().map((st, i) => { const w = v.seatWorld(i); return [i, st.type, +(w.pos.x - v.pos.x).toFixed(2), +w.pos.y.toFixed(2), +(w.pos.z - v.pos.z).toFixed(2), +w.heading.toFixed(2)]; }), pos: [v.pos.x, v.pos.z], heading: v.heading, riders, n: sq ? sq.soldiers.length : 0 };
}, [vi, +(process.env.PRE || 2), !!process.env.BURN, (process.env.FOCUS || '0,0').split(',').map(Number), !!process.env.BOARD, !!process.env.RIDEALL]);
console.log(JSON.stringify(setup));
const times = ts.split(',').map(Number), C = cams.split(';').map(c => c.split(':').map(Number));
const shots = [];
for (const T of times) {
  const info = await page.evaluate(T => {
    const g = window.game, D = window.__dm;
    while (g.time - D.t0 < T - 1e-6) {
      D.aim(); g.frame(0.05);
      if (D.sq) D.trace.push(D.sq.soldiers.map(s => { const h = s.model?.getObjectByName?.('Hips'); const p = h ? h.getWorldPosition(new h.position.constructor()) : null; return [+(g.time - D.t0).toFixed(2), s.idx, s.curName, +s.pos.x.toFixed(3), +s.pos.y.toFixed(3), +s.pos.z.toFixed(3), +s.heading.toFixed(3), p ? +p.x.toFixed(3) : 0, p ? +p.y.toFixed(3) : 0, p ? +p.z.toFixed(3) : 0, s.inside === 'ride' ? 'R' : s.inside === 'btr' ? 'B' : '-', +(s.jumpT || 0).toFixed(2)]; }));
    }
    return { t: +(g.time - D.t0).toFixed(2) };
  }, T);
  for (const c of C) {
    const url = await page.evaluate(([dist, yawDeg, hgt]) => {
      const g = window.game, D = window.__dm, v = D.v, cam = g.renderer.camera;
      const f = D.focus, ch = Math.cos(v.heading), sh = Math.sin(v.heading);
      const fx = v.pos.x + f[0] * ch + f[1] * sh, fz = v.pos.z - f[0] * sh + f[1] * ch;
      const a = v.heading + Math.PI / 2 + yawDeg * Math.PI / 180;   // yaw 0: camera on the vehicle's +X (left) side
      cam.position.set(fx + Math.sin(a) * dist, (v.pos.y || 0) + hgt, fz + Math.cos(a) * dist);
      cam.lookAt(fx, (v.pos.y || 0) + 1.1, fz); cam.updateMatrixWorld(true);
      g.renderer.render(0.016, g.time);
      return g.renderer.r.domElement.toDataURL('image/png');   // same task as the render: the drawing buffer is still there
    }, c);
    const f = `/tmp/pvd_${shots.length}.png`;
    fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
    shots.push({ f, l: `t=${info.t} ${c.join(':')}` });
  }
}
if (process.env.TRACE) {
  const tr = await page.evaluate(() => window.__dm.trace);
  fs.writeFileSync(out.replace(/\.png$/, '_trace.json'), JSON.stringify(tr));
}
await browser.close(); server.close();
// compose
const { execFileSync } = await import('node:child_process');
execFileSync('python3', ['-c', `
import sys, json
from PIL import Image, ImageDraw
shots = json.loads(sys.argv[1]); cols = int(sys.argv[2]); out = sys.argv[3]
W, H = Image.open(shots[0]['f']).size
rows = (len(shots) + cols - 1) // cols
im = Image.new('RGB', (W * cols, H * rows), (40, 40, 40)); d = ImageDraw.Draw(im)
for i, s in enumerate(shots):
    x, y = (i % cols) * W, (i // cols) * H
    im.paste(Image.open(s['f']).convert('RGB'), (x, y))
    d.rectangle([x + 2, y + 2, x + 8 + 6.2 * len(s['l']), y + 16], fill=(235, 235, 235)); d.text((x + 5, y + 4), s['l'], fill=(0, 0, 0))
im.save(out)
`, JSON.stringify(shots), cols, out]);
console.log('wrote', out);
