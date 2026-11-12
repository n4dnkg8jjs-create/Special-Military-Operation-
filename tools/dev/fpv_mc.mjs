// FPV-vs-vehicle Monte Carlo (logic only): N fresh vehicles of each kind take ONE drone hit resolved exactly as
// support.js FpvTeam.impact does (aim point, dive direction, cage), then 90 s of vehicle updates (fire, bail-out);
// prints per kind: knocked out at once / lost within 90 s (destroyed or abandoned) / burning / immobilised / untouched.
// usage: node tools/dev/fpv_mc.mjs [N=150] [side=UA]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => { const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, r));
const N = +(process.argv[2] || 150), side = process.argv[3] || 'UA';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--js-flags=--max-old-space-size=3072'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.addInitScript(() => { localStorage.setItem('smo_norender', '1'); localStorage.setItem('smo_noaudio', '1'); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:${server.address().port}/index.html?autostart&quality=low&map=farmland&side=${side}`);
await page.waitForFunction('window.game && window.game.objectives && window.__done === true', null, { timeout: 200000 });
const out = await page.evaluate(async ([N]) => {
  const g = window.game, { WEAPONS } = await import('./src/config.js'), THREE = await import('three');
  g.frame = () => {}; g.hud.alert = () => {};
  const W = WEAPONS.fpv, res = {};
  for (const [sd, kinds] of [['player', ['btr', 'ifv', 'tank']], ['enemy', ['btr', 'ifv', 'tank']]]) for (const kind of kinds) {
    const R = { n: 0, ko: 0, lost: 0, burn: 0, immob: 0, gun: 0, none: 0, hp: 0, name: '' };
    for (let i = 0; i < N; i++) {
      const v = g.makeVehicle(sd, kind, -600 + (i % 20) * 12, 500 + Math.floor(i / 20) * 14, Math.random() * 6.28); R.name = v.def.name || v.name; v.name = 'mc'; v.thinkT = 1e9; v.holdFire = true;
      // FpvTeam.aimPoint + impact
      const c = Math.cos(v.heading), s = Math.sin(v.heading), r = Math.random();
      const lx = (Math.random() - .5) * v.def.width * 0.5, lz = r < 0.55 ? -v.def.length * 0.3 : r < 0.85 ? 0 : (Math.random() - .5) * v.def.length * 0.6;
      const at = new THREE.Vector3(v.pos.x + lx * c + lz * s, v.def.height + 0.1, v.pos.z - lx * s + lz * c);
      const a = Math.random() * 6.28, dir = new THREE.Vector3(Math.cos(a), -0.55 - Math.random() * 0.5, Math.sin(a)).normalize(), from = at.clone().addScaledVector(dir, -4);
      const hp0 = v.hp;
      if (v.cage && Math.random() < v.cage) g.combat.hitVehicle(v, { ...W, pen: W.pen * 0.12, dmg: [20, 50] }, from, 'ce', null, false, at); else g.combat.hitVehicle(v, W, from, 'ce', null, false, at);
      R.n++; if (v.destroyed) R.ko++;
      const burn = v.burning > 0, im = v.immobile;
      try { for (let t = 0; t < 90 && !v.destroyed; t += 0.1) v.update(0.1); } catch (e) { R.err = String(e.message).slice(0, 80); }
      if (v.destroyed || v.abandoned) R.lost++; else { if (v.burning > 0 || burn) R.burn++; if (im || v.immobile) R.immob++; if (v.gunDisabled) R.gun++; if (v.hp >= hp0 - 1 && !im) R.none++; }
      R.hp += Math.max(0, v.hp) / hp0;
      g.scene.remove(v.root); const k = g.vehicles.indexOf(v); if (k >= 0) g.vehicles.splice(k, 1); g.nav.unstampDyn?.(v);
      for (const q of g.squads.filter(q => q.crewOf === v || /mc crew|crew/.test(q.name || '') && q.soldiers.length <= 4 && !q._keep)) { }
    }
    res[`${sd[0]}:${kind}`] = R;
  }
  return res;
}, [N]);
for (const [k, R] of Object.entries(out)) console.log(`${k.padEnd(8)} n ${R.n}  killed at once ${(R.ko / R.n * 100).toFixed(0)} %  lost within 90 s ${(R.lost / R.n * 100).toFixed(0)} %  | survivors: burning ${(R.burn / R.n * 100).toFixed(0)} % immobilised ${(R.immob / R.n * 100).toFixed(0)} % gun out ${(R.gun / R.n * 100).toFixed(0)} % untouched ${(R.none / R.n * 100).toFixed(0)} %  mean hp left ${(R.hp / R.n * 100).toFixed(0)} %${R.err ? '  ERR ' + R.err : ''}`);
await browser.close(); server.close();
