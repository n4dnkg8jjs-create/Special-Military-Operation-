// Offline-render listening previews through the game's real mixer (src/audio/sfx.js) in headless Chromium.
//   flock -w 1200 /tmp/heavy.lock nice -n 10 node tools/audio/render_preview.mjs [scene,...]   -> previews/audio_v3/<scene>.wav
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const { chromium } = createRequire('/opt/npm-tools/node_modules/')('playwright');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'); const out = path.join(root, 'previews/audio_v3'); fs.mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => { const u = decodeURIComponent(req.url.split('?')[0]); if (u === '/blank') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>r</title>'); } const p = path.join(root, u); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise(r => server.listen(0, '127.0.0.1', r));

// ---- scenes: run in the page with the helper API (see `api` below); listener at (0, 28, 20) looking north (-z), like the default RTS camera
const SCENES = {
  battle_city: { dur: 46, env: 'city', fn: ({ at, a, auto, vehicle, drone, rnd }) => {
    at(0, () => { a.play('ambience_city', null, { gain: 0.8 }); a.play('ambience_wind', null, { gain: 0.6 }); a.play('ambience_battle', null, { gain: 0.5 }); });
    at(2.5, () => a.play('ui_select')); at(2.9, () => a.play('ui_order')); at(8, () => a.play('radio'));
    for (let i = 0; i < 4; i++) auto('rifle_near', { x: -28 + i * 5, y: 1.5, z: -12 - i * 3 }, 5 + i * 0.7, 26, 600, [1, 3], [0.45, 1.3]);
    auto('mg_near', { x: 14, y: 1, z: -24 }, 7, 26, 650, [5, 12], [0.6, 1.4]);
    for (let i = 0; i < 5; i++) auto('rifle_near', { x: 30 + i * 12, y: 1.5, z: -290 - i * 8 }, 6 + i, 31, 600, [1, 3], [0.5, 1.6]);
    auto('mg_near', { x: 60, y: 1, z: -340 }, 9, 31, 650, [6, 12], [0.8, 1.8]);
    auto('hmg', { x: -70, y: 2.5, z: -120 }, 12, 30, 600, [4, 8], [0.8, 1.6]);
    auto('cannon30', { x: 60, y: 2.5, z: -150 }, 14, 30, 330, [3, 6], [0.9, 1.8]);
    for (const t of [18, 27]) at(t, () => a.play('tankgun', { x: -30, y: 2, z: -60 }));
    at(22.5, () => a.play('tankgun', { x: 100, y: 2, z: -700 }));
    at(20, () => a.play('rpg_launch', { x: -20, y: 1, z: -10 }, { gain: 1.2 })); at(21.3, () => { a.play('explosion_small', { x: -10, y: 1, z: -170 }); a.play('impact_armor', { x: -10, y: 1, z: -170 }); });
    at(21, () => a.play('pain', { x: -18, y: 1, z: -12 })); at(28, () => a.play('shout', { x: -22, y: 1, z: -14 })); at(30, () => a.play('radio'));
    at(27.6, () => a.play('incoming_whistle', { x: 20, y: 20, z: -60 }, { delay: false })); at(29, () => a.play('explosion_medium', { x: 20, y: 0, z: -60 }));
    at(31, () => a.play('howitzer', { x: 0, y: 0, z: 600 }));
    at(30.7, () => a.play('shell_incoming', { x: -40, y: 24, z: -110 }, { delay: false })); at(33, () => { a.play('explosion_large', { x: -40, y: 0, z: -110 }); a.play('debris', { x: -40, y: 0, z: -110 }); });
    at(35.5, () => a.play('explosion_medium', { x: 300, y: 0, z: -900 }));
    for (let i = 0; i < 6; i++) at(23 + i * 0.4 + rnd() * 0.3, () => a.play(rnd() < 0.5 ? 'bullet_whizz' : 'impact_concrete', { x: -5 + rnd() * 10, y: 1, z: -5 + rnd() * 10 }, { gain: 0.6 }));
    vehicle('btr', { x: -40, z: -40 }, 0, 44, [[10, { x: -40, z: -200 }, 6]]);
    vehicle('tank', { x: 35, z: -30 }, 0, 44, [[24, { x: 35, z: 40 }, 5]], [[16.5, 18]]);
    drone({ x: 150, y: 60, z: -200 }, { x: -10, y: 1, z: -30 }, 36, 41.5);
  } },
  weapons_near_far: { dur: 62, env: 'field', fn: ({ at, a, auto }) => {
    at(0, () => a.play('ambience_wind', null, { gain: 0.5 }));
    // each weapon: ~35 m (camera over the fight), then ~350 m
    const W = [['rifle_near', 600, [1, 3], [0.4, 0.9]], ['mg_near', 650, [6, 12], [0.6, 1.0]], ['hmg', 600, [4, 8], [0.8, 1.2]], ['cannon30', 330, [3, 6], [0.9, 1.4]]];
    let t = 1;
    for (const [k, rof, b, g] of W) { auto(k, { x: -12, y: 1.5, z: -20 }, t, t + 5, rof, b, g); auto(k, { x: 80, y: 1.5, z: -340 }, t + 6, t + 11, rof, b, g); t += 12.5; }
    at(t, () => a.play('tankgun', { x: -15, y: 2, z: -25 })); at(t + 4, () => a.play('tankgun', { x: 120, y: 2, z: -450 }));
    at(t + 8, () => a.play('rpg_launch', { x: -8, y: 1, z: -14 }, { gain: 1.2 })); at(t + 8.9, () => a.play('explosion_small', { x: 5, y: 1, z: -120 }));
  } },
  artillery_mortar: { dur: 36, env: 'field', fn: ({ at, a }) => {
    at(0, () => { a.play('ambience_wind', null, { gain: 0.6 }); a.play('ambience_battle', null, { gain: 0.5 }); });
    at(1, () => a.play('mortar_launch', null, { gain: 0.4 }));
    at(4.6, () => a.play('incoming_whistle', { x: -20, y: 20, z: -50 }, { delay: false })); at(6, () => a.play('explosion_medium', { x: -20, y: 0, z: -50 }));
    at(8.7, () => a.play('shell_incoming', { x: 30, y: 24, z: -120 }, { delay: false })); at(11, () => { a.play('explosion_large', { x: 30, y: 0, z: -120 }); a.play('debris', { x: 30, y: 0, z: -120 }); });
    at(15, () => a.play('explosion_medium', { x: -150, y: 0, z: -420 })); at(15.8, () => a.play('explosion_medium', { x: -120, y: 0, z: -460 }));
    at(19, () => a.play('explosion_large', { x: 400, y: 0, z: -1200 }));
    at(23, () => a.play('howitzer', { x: 20, y: 0, z: 40 })); at(28, () => a.play('howitzer', { x: -300, y: 0, z: 2000 }));
    at(31, () => a.play('artillery_far', null, { gain: 0.7 }));
  } },
  vehicles: { dur: 40, env: 'city', fn: ({ at, a, vehicle, drone }) => {
    at(0, () => a.play('ambience_city', null, { gain: 0.8 }));
    vehicle('btr', { x: -120, z: -15 }, 0.5, 18, [[4, { x: 140, z: -15 }, 11]]);
    vehicle('tank', { x: 40, z: -40 }, 17, 39, [[22, { x: -140, z: -10 }, 8]], [[19, 20.6]]);
    at(19.3, () => a.play('servo_stop', { x: 40, y: 2, z: -40 }));
    drone({ x: 200, y: 70, z: -300 }, { x: 5, y: 1, z: -20 }, 31, 38.5);
  } },
  field_ambience: { dur: 40, env: 'field', fn: ({ at, a, auto }) => {
    at(0, () => { a.play('ambience_wind', null, { gain: 0.8 }); a.play('ambience_wind', null, { gain: 0.6 }); a.play('ambience_battle', null, { gain: 0.5 }); });
    auto('mg_near', { x: -40, y: 1, z: -60 }, 17, 21, 650, [6, 12], [0.6, 1]); auto('rifle_near', { x: -30, y: 1, z: -50 }, 17.3, 21.5, 600, [1, 3], [0.4, 0.8]);
    at(19.5, () => a.play('explosion_small', { x: -60, y: 0, z: -110 }));
  } },
};

const api = async (sceneSrc, dur, env) => {
  const sr = 48000, ctx = new OfflineAudioContext(2, Math.ceil(sr * dur), sr);
  const { Audio } = await import('/src/audio/sfx.js');
  const a = new Audio(); await a.init(null, { context: ctx, env, base: '/' });
  if (!a.ok) throw new Error('audio init failed');
  let seed = 12345; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  Math.random = rnd;
  const Q = 128 / sr, jobs = new Map();
  const at = (t, f) => { const k = Math.max(1, Math.round(t / Q)); if (k * Q >= dur - 0.01) return; (jobs.get(k) || jobs.set(k, []).get(k)).push(f); };
  const L = { x: 0, y: 28, z: 20 };
  for (let t = 0.02; t < dur; t += 0.05) at(t, () => a.setListener(L, { x: 0, z: -1 }));
  const auto = (key, pos, t0, t1, rof, b, g) => { let t = t0; while (t < t1) { const n = Math.round(b[0] + rnd() * (b[1] - b[0])); for (let i = 0; i < n; i++, t += 60 / rof) at(t, () => a.play(key, pos)); t += g[0] + rnd() * (g[1] - g[0]); } };
  const lerp = (p, q, k) => ({ x: p.x + (q.x - p.x) * k, y: (p.y || 1) + ((q.y || 1) - (p.y || 1)) * k, z: p.z + (q.z - p.z) * k });
  // vehicle: [kind, start pos, t0, t1, legs [[t, to, speed]], traverse windows] - mirrors vehicle.js engine logic
  const vehicle = (kind, p0, t0, t1, legs, trav = []) => {
    const def = kind === 'btr' ? { wheeled: true, speed: 14 } : { wheeled: false, speed: 11 }; const pos = { x: p0.x, y: 1.5, z: p0.z }; let h = null;
    let leg = 0, sp = 0;
    for (let t = t0; t < t1; t += 0.05) at(t, () => {
      const now = ctx.currentTime;
      if (!h) { const k = def.wheeled ? 'btr_engine' : 'tank_engine'; h = { e: a.loop(k + '_idle', pos, 0.7), d: a.loop(k + '_drive', pos, 0), tr: def.wheeled ? null : a.loop('track_clank', pos, 0), tv: a.loop('turret_traverse', pos, 0) }; }
      const L0 = legs[leg]; let target = 0;
      if (L0 && now >= L0[0]) { const dx = L0[1].x - pos.x, dz = L0[1].z - pos.z, dd = Math.hypot(dx, dz); if (dd > 2) { target = L0[2]; pos.x += dx / dd * sp * 0.05; pos.z += dz / dd * sp * 0.05; } else leg++; }
      sp += Math.sign(target - sp) * Math.min(Math.abs(target - sp), 2.5 * 0.05);
      const s = Math.abs(sp) / def.speed, slew = trav.some(([u, v]) => now >= u && now <= v);
      h.e.set(pos, 0.8 * (1 - s * 0.6), 1 + s * 0.15); h.d.set(pos, s * 0.9 + (slew ? 0.05 : 0), 0.85 + s * 0.3); h.tr?.set(pos, Math.min(1, s * 1.4), 0.7 + s * 0.6); h.tv.set(pos, slew ? 0.7 : 0, 1);
    });
    at(t1, () => { for (const x of Object.values(h || {})) x?.stop(); });
  };
  const drone = (p0, p1, t0, t1) => { let h; for (let t = t0; t < t1; t += 0.05) at(t, () => { const k = (ctx.currentTime - t0) / (t1 - t0), p = lerp(p0, p1, k * k); h ||= a.loop('drone_buzz', p, 0.8); h.set(p, k > 0.6 ? 1.25 : 0.85, 0.85 + k * 0.45); }); at(t1, () => { h?.stop(); a.play('explosion_small', p1); }); };
  (0, eval)('(' + sceneSrc + ')')({ at, a, auto, vehicle, drone, rnd });
  for (const [k, fs] of [...jobs].sort((x, y) => x[0] - y[0])) ctx.suspend((k + 0.25) * Q).then(() => { for (const f of fs) { try { f(); } catch (e) { console.error(e); } } ctx.resume(); });
  const buf = await ctx.startRendering();
  const L0 = buf.getChannelData(0), R0 = buf.getChannelData(1), n = L0.length, pcm = new Int16Array(n * 2); let pk = 0;
  for (let i = 0; i < n; i++) { pk = Math.max(pk, Math.abs(L0[i]), Math.abs(R0[i])); pcm[2 * i] = Math.max(-1, Math.min(1, L0[i])) * 32767; pcm[2 * i + 1] = Math.max(-1, Math.min(1, R0[i])) * 32767; }
  let s = ''; const u8 = new Uint8Array(pcm.buffer); for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { b64: btoa(s), sr, peak: pk, voices: a.act.length, rounds: Object.fromEntries(['mg_round_near', 'mg_round_far', 'hmg_round', 'hmg_round_far', 'ac_round', 'ac_round_far', 'drone_buzz', 'pain', 'death'].map(k => [k, (a.manifest[k]?.buffers || []).map(b => +(a.cuts.get(b) || b.duration).toFixed(3))])) };
};

const want = (process.argv[2] || Object.keys(SCENES).join(',')).split(',');
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
await p.goto(`http://127.0.0.1:${server.address().port}/blank`);
for (const k of want) {
  const S = SCENES[k]; const t = Date.now();
  const r = await p.evaluate(([src, dur, env, fn]) => (0, eval)('(' + fn + ')')(src, dur, env), [S.fn.toString(), S.dur, S.env, api.toString()]);
  const pcm = Buffer.from(r.b64, 'base64'), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(r.sr, 24); h.writeUInt32LE(r.sr * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(path.join(out, k + '.wav'), Buffer.concat([h, pcm]));
  if (k === want[0]) console.log(JSON.stringify(r.rounds));
  console.log(k, `${S.dur}s peak ${(20 * Math.log10(r.peak)).toFixed(1)} dBFS, rendered in ${((Date.now() - t) / 1000).toFixed(1)} s`);
}
console.log('page errors:', errs.length, errs.slice(0, 5));
await b.close(); server.close();
