// WebAudio mixer driven by assets/audio/manifest.json (procedural fallbacks for any event whose files are missing).
//
// Graph:  voice: src -> gain -> air-absorption low-pass -> StereoPanner -> group bus      (+ send -> environment reverb)
//         groups weapons/explosions/ballistics/vehicles/foley -> world (ducked under call-outs) \
//         voice, ambience, ui, reverb return ------------------------------------------------- -> glue comp -> limiter -> soft clip -> out
// Levels come from the MIX table below (dB at the reference distance r0, inverse-distance beyond it, extra ground loss
// far out), not from the source files, which are all loudness-normalised to the same level by tools/audio/build*.py.
// Distance: speed-of-sound start delay, air-absorption low-pass, near/far recording swap, far rumble (dull thud) and close
// debris layers for blasts. Incoming: 152/155 mm = tearing rush ending at the burst; mortar = short whoosh, often nothing.
// Voices: per-key / per-group / global caps; a new voice steals the quietest one (short fade) or is dropped if it would
// be the quietest. Automatic weapons play one shot per ROUND, from the original recordings: real single-shot files
// where they exist (7.62x54R Mosin singles for the PKM, the 30 mm singles) and otherwise the FIRST shot of each burst
// recording (cut at the second shot's onset, found at load), with a per-emitter choke (previous round fades as the
// next one fires), so a 10-round burst never stacks ten whole bursts.
// Loops (engines, tracks, drone, fire): one chain each, updated <= 20 Hz, disconnected while inaudible, loudest N kept.
// Ambience: environment beds (wind / city / battle) and sparse distant artillery and firefights. No wildlife.
const SOS = 343;
const DB = d => Math.pow(10, d / 20);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
// key: [level dB at r0, r0 m, group]
const MIX = {
  rifle_near: [0, 10, 'weapons'], rifle_far: [0, 10, 'weapons'], rifle_burst_near: [0, 10, 'weapons'], rifle_burst_far: [-1, 10, 'weapons'],
  dmr_near: [1, 10, 'weapons'], dmr_far: [1, 10, 'weapons'],
  mg_round_near: [1, 10, 'weapons'], mg_round_far: [1, 10, 'weapons'], mg_near: [-2, 10, 'weapons'], mg_far: [-2, 10, 'weapons'],
  hmg_round: [4, 12, 'weapons'], hmg_round_far: [4, 12, 'weapons'], hmg: [1, 12, 'weapons'], hmg_far: [1, 12, 'weapons'],
  ac_round: [6, 14, 'weapons'], ac_round_far: [6, 14, 'weapons'], cannon30: [3, 14, 'weapons'], cannon30_far: [3, 14, 'weapons'],
  tankgun: [10, 16, 'weapons'], tankgun_far: [10, 16, 'weapons'], howitzer: [11, 20, 'weapons'], mortar_launch: [5, 12, 'weapons'],
  rpg_launch: [4, 12, 'weapons'], rpg_flight: [-2, 10, 'weapons'], atgm_motor: [-2, 10, 'weapons'], drone_buzz: [-5, 10, 'weapons'],
  artillery_far: [-14, 10, 'amb'],
  grenade_pin: [-14, 4, 'foley'], grenade_throw: [-12, 4, 'foley'], reload: [-14, 4, 'foley'], bolt: [-14, 4, 'foley'], dryfire: [-16, 4, 'foley'],
  bullet_whizz: [-6, 4, 'ballistics'], ricochet: [-9, 6, 'ballistics'],
  impact_concrete: [-10, 5, 'ballistics'], impact_dirt: [-12, 5, 'ballistics'], impact_metal: [-9, 5, 'ballistics'], impact_glass: [-10, 5, 'ballistics'],
  impact_flesh: [-12, 4, 'ballistics'], impact_armor: [-2, 8, 'ballistics'], shell_casing: [-18, 3, 'ballistics'],
  explosion_small: [6, 15, 'explosions'], explosion_medium: [9, 18, 'explosions'], explosion_large: [12, 20, 'explosions'],
  shell_impact: [12, 20, 'explosions'], mortar_impact: [8, 16, 'explosions'], explosion_far: [6, 30, 'explosions'], collapse: [6, 20, 'explosions'], debris: [-6, 10, 'explosions'], glass_break: [-6, 8, 'explosions'],
  shell_incoming: [-1, 30, 'explosions'], incoming_whistle: [-6, 25, 'explosions'], mortar_incoming: [-4, 25, 'explosions'],
  btr_engine_idle: [0, 12, 'vehicles'], btr_engine_drive: [2, 12, 'vehicles'], btr_engine_drive_b: [2, 12, 'vehicles'],
  tank_engine_idle: [1, 12, 'vehicles'], tank_engine_drive: [3, 14, 'vehicles'], tank_engine_drive_fast: [3, 14, 'vehicles'],
  engine_start: [0, 12, 'vehicles'], track_clank: [0, 10, 'vehicles'],
  turret_traverse: [-6, 6, 'vehicles'], servo_stop: [-13, 5, 'vehicles'], hatch: [-11, 5, 'vehicles'],
  fire_vehicle_loop: [-9, 8, 'vehicles'], fire_loop: [-12, 6, 'vehicles'], fire_loop_b: [-12, 6, 'vehicles'],
  footstep_rubble: [-19, 3, 'foley'], footstep_concrete: [-19, 3, 'foley'], footstep_gravel: [-19, 3, 'foley'], gear_rattle: [-21, 3, 'foley'], body_fall: [-12, 5, 'foley'],
  pain: [-2, 10, 'voice'], death: [-2, 10, 'voice'], wounded: [-6, 8, 'voice'], shout: [-1, 12, 'voice'], curse_ru: [-4, 10, 'voice'], radio: [-6, 10, 'voice'],
  ambience_city: [-11, 10, 'amb'], ambience_wind: [-13, 10, 'amb'], ambience_wind_gusty: [-14, 10, 'amb'], ambience_battle: [-15, 10, 'amb'],
  siren_air_raid: [-16, 10, 'amb'], radio_static: [-18, 3, 'amb'],
  ui_click: [-8, 1, 'ui'], ui_select: [-9, 1, 'ui'], ui_order: [-8, 1, 'ui'], ui_hover: [-14, 1, 'ui'], ui_alert: [-6, 1, 'ui'], ui_error: [-8, 1, 'ui'],
  victory: [-4, 1, 'ui'], defeat: [-4, 1, 'ui'],
};
const CAT_GROUP = { weapons: 'weapons', ballistics: 'ballistics', explosions: 'explosions', vehicles: 'vehicles', foley: 'foley', human: 'voice', ambience: 'amb', ui: 'ui' };
const GROUP_CAP = { weapons: 28, explosions: 12, ballistics: 10, vehicles: 8, foley: 8, voice: 4, amb: 8, ui: 4 };
const TOTAL_CAP = 64;
const KEY_CAP = { bullet_whizz: 3, ricochet: 3, impact_concrete: 5, impact_dirt: 5, impact_metal: 4, footstep_rubble: 3, footstep_gravel: 3, pain: 2, death: 2, wounded: 2, shout: 2, explosion_far: 5, shell_incoming: 4, mortar_incoming: 3, debris: 4, radio: 1 };
// random variation per group: [rate +-, gain dB +-]
const VAR = { weapons: [0.035, 1.5], explosions: [0.07, 2], ballistics: [0.09, 3], vehicles: [0.05, 1.5], foley: [0.08, 3], voice: [0.04, 1.5], amb: [0.06, 2], ui: [0.01, 0] };
const REVERB_SEND = { weapons: 1, explosions: 1, ballistics: 0.55, vehicles: 0.35, foley: 0.3, voice: 0.45, amb: 0.5, ui: 0 };
// per-round sets built at load from the original recordings: [source event, 0 = whole single shot | 1 = first shot only]
const ROUNDS = { mg_round_near: [['dmr_near', 0], ['mg_near', 1]], mg_round_far: [['dmr_far', 0], ['mg_far', 1]], hmg_round: [['hmg', 1]], hmg_round_far: [['hmg_far', 1]], ac_round: [['cannon30', 1]], ac_round_far: [['cannon30_far', 1]] };
const ROUND_NOM = { mg_round_near: 0.12, mg_round_far: 0.14, hmg_round: 0.13, hmg_round_far: 0.15, ac_round: 0.3, ac_round_far: 0.32 };
// game key -> engine key (if present), near->far swaps [far key, distance m]
const ALIAS = { mg_near: 'mg_round_near', mg_far: 'mg_round_far', hmg: 'hmg_round', hmg_far: 'hmg_round_far', cannon30: 'ac_round', cannon30_far: 'ac_round_far', incoming_whistle: 'mortar_incoming', atgm_motor: 'rpg_flight' };
// incoming sounds end at the burst: the game starts them this many seconds before impact
const LEAD = { shell_incoming: 2.45, mortar_incoming: 1.4 };   // (their buffers: 1.3 s / 0.7 s, so they start late)
const FAR = { rifle_near: ['rifle_far', 110], dmr_near: ['dmr_far', 140], mg_round_near: ['mg_round_far', 130], hmg_round: ['hmg_round_far', 170], ac_round: ['ac_round_far', 190], tankgun: ['tankgun_far', 320], howitzer: ['artillery_far', 900], rifle_burst_near: ['rifle_burst_far', 120], mg_near: ['mg_far', 130], hmg: ['hmg_far', 170], cannon30: ['cannon30_far', 190] };
// per-emitter choke families: [family, fade time-constant s]
const CHOKE = { rifle_near: ['r', 0.05], rifle_far: ['r', 0.05], dmr_near: ['d', 0.08], dmr_far: ['d', 0.08], mg_round_near: ['m', 0.035], mg_round_far: ['m', 0.035], hmg_round: ['h', 0.05], hmg_round_far: ['h', 0.05], ac_round: ['a', 0.08], ac_round_far: ['a', 0.08] };
const BLAST = { explosion_small: 0.55, explosion_medium: 0.8, explosion_large: 1, collapse: 0.7, shell_impact: 1, mortar_impact: 0.7 };
const LOOP_CAP = { vehicles: 14, weapons: 6 };

export class Audio {
  constructor() { this.ok = false; this.manifest = {}; this.act = []; this.loops = new Set(); this.beds = new Map(); this.emit = new Map(); this.last = {}; this.listener = { x: 0, y: 0, z: 0 }; this.fwd = { x: 0, z: -1 }; this.heat = 0; this.tickT = 0; this.env = null; this.cuts = new Map(); this.amb = { art: 12, fire: 8 }; }
  // opts.context: an (Offline)AudioContext to render into (previews); opts.env: 'city' | 'field'
  async init(progress, opts = {}) {
    if (!opts.context) { try { if (localStorage.getItem('smo_noaudio') === '1') return; } catch { } }   // headless multi-instance tests
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC && !opts.context) return;
    const ctx = this.ctx = opts.context || new AC({ latencyHint: 'interactive' });
    // resume() stays pending until the user clicks (always the case in the versus battle iframe): never block loading
    // on it — wait at most 300 ms, then resume on the first click / key press
    if (ctx.state === 'suspended' && !opts.context) {
      await Promise.race([ctx.resume().catch(() => {}), new Promise(r => setTimeout(r, 300))]);
      if (ctx.state === 'suspended') { const kick = () => { ctx.resume().catch(() => {}); if (ctx.state === 'running') for (const e of ['pointerdown', 'keydown']) removeEventListener(e, kick, true); }; for (const e of ['pointerdown', 'keydown']) addEventListener(e, kick, true); }
    }
    this.buildGraph();
    try { const r = await fetch(opts.base ? opts.base + 'assets/audio/manifest.json' : 'assets/audio/manifest.json'); if (r.ok) this.manifest = await r.json(); } catch {}
    const keys = Object.keys(this.manifest); let done = 0;
    await Promise.all(keys.map(async k => {
      const e = this.manifest[k]; e.buffers = [];
      await Promise.all((e.files || []).map(async f => {
        try { const url = (opts.base || '') + (f.startsWith('assets/') ? f : `assets/audio/${f}`); const ab = await (await fetch(url)).arrayBuffer(); e.buffers.push(await ctx.decodeAudioData(ab)); } catch (err) { /* skip bad file */ }
      }));
      progress && progress(++done / keys.length);
    }));
    this.rounds(); this.oldSynth(); this.fallbacks();
    this.setEnvironment(opts.env || 'city');
    this.ok = true;
  }
  buildGraph() {
    const ctx = this.ctx, G = n => { const g = ctx.createGain(); g.gain.value = n; return g; };
    // master chain: gentle glue compression, then a fast high-ratio limiter, then a soft clipper as the last safety
    // (the compressor nodes add their own make-up gain, which the trim in front of them accounts for)
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -12; comp.knee.value = 6; comp.ratio.value = 2; comp.attack.value = 0.01; comp.release.value = 0.2;
    const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.12;
    const clip = ctx.createWaveShaper(); const n = 2048, cv = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x); cv[i] = Math.sign(x) * (a < 0.8 ? a : 0.8 + 0.19 * Math.tanh((a - 0.8) / 0.19)); }
    clip.curve = cv;
    this.master = G(1); this.trim = G(DB(1));
    this.master.connect(this.trim).connect(comp).connect(lim).connect(clip).connect(ctx.destination);
    this.world = G(1); this.world.connect(this.master);   // ducked under voice call-outs
    this.bus = {};
    for (const k of ['weapons', 'explosions', 'ballistics', 'vehicles', 'foley']) { this.bus[k] = G(1); this.bus[k].connect(this.world); }
    this.bus.voice = G(DB(1)); this.bus.voice.connect(this.master);
    this.bus.amb = G(1); const ahp = ctx.createBiquadFilter(); ahp.type = 'highpass'; ahp.frequency.value = 45; this.bus.amb.connect(ahp).connect(this.master);
    this.bus.ui = G(DB(-2)); this.bus.ui.connect(this.master);
    // environment reverb: mono send (pre-pan) -> high-pass -> convolver -> return
    this.revIn = G(1); const rhp = ctx.createBiquadFilter(); rhp.type = 'highpass'; rhp.frequency.value = 140;
    this.reverb = ctx.createConvolver(); this.revOut = G(0.5);
    this.revIn.connect(rhp).connect(this.reverb).connect(this.revOut).connect(this.world);
  }
  // 'city': dense facade reflections + flutter between blocks; 'field': sparse late echoes off tree lines, dark long tail
  setEnvironment(env) {
    if (!this.ctx || env === this.env) return; this.env = env;
    const ctx = this.ctx, sr = ctx.sampleRate, city = env === 'city', sec = city ? 2.4 : 3.4, len = Math.floor(sr * sec), b = ctx.createBuffer(2, len, sr);
    let seed = city ? 7 : 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c), rt = city ? 1.7 : 2.6, t0 = city ? 0.018 : 0.06;
      let lpS = 0;
      for (let i = Math.floor(t0 * sr); i < len; i++) {
        const t = i / sr, k = 0.55 * Math.exp(-(t - t0) * (city ? 2.2 : 3.0));   // the tail darkens as it decays
        lpS += (rnd() - lpS) * (k + 0.05); d[i] = lpS * Math.exp(-6.9 * t / rt) * (city ? 0.5 : 0.32) * Math.min(1, (t - t0) / 0.04);
      }
      const tap = (t, a, w, dark) => { const i0 = Math.floor(t * sr); let s = 0; for (let j = 0; j < w && i0 + j < len; j++) { s += (rnd() - s) * dark; d[i0 + j] += a * s * Math.exp(-j / (w / 4)); } };
      if (city) {
        for (let k = 0; k < 26; k++) tap(0.006 + Math.pow(Math.abs(rnd()), 1.6) * 0.12, (0.9 - k * 0.025) * (rnd() < 0 ? -1 : 1), 90, 0.6);
        for (let k = 0; k < 5; k++) tap(0.14 + Math.abs(rnd()) * 0.36, 0.35 * (rnd() < 0 ? -1 : 1), 260, 0.25);
      } else {
        for (let k = 0; k < 6; k++) tap(0.01 + Math.abs(rnd()) * 0.05, 0.25, 60, 0.4);
        for (let k = 0; k < 6; k++) tap(0.25 + Math.abs(rnd()) * 0.9, 0.3 + 0.15 * rnd(), 1800, 0.06);   // tree lines / hamlets
      }
    }
    this.reverb.buffer = b; this.revOut.gain.value = city ? 0.55 : 0.45;
  }
  has(k) { const e = this.manifest[k]; return !!(e && e.buffers && e.buffers.length); }
  // ---------------------------------------------------------------- per-round sets for automatic weapons (see ROUNDS)
  firstGap(b) {
    // onset of the 2nd shot in a burst recording: 1 ms frames of the first difference, a >10 dB rise over the previous
    // 15 ms within 15 dB of the loudest frame, 45 ms apart. null = one shot only; 0 = shots too close to cut cleanly
    const x = b.getChannelData(0), hop = Math.round(b.sampleRate / 1000), n = Math.min(Math.floor(x.length / hop), 700), L = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let j = i * hop + 1; j < (i + 1) * hop; j++) { const d = x[j] - x[j - 1]; s += d * d; } L[i] = 10 * Math.log10(s / hop + 1e-14); }
    let pk = -999; for (let i = 0; i < n; i++) pk = Math.max(pk, L[i]);
    const on = []; let last = -1e9;
    for (let i = 16; i < n && on.length < 2; i++) { let m = 0; for (let j = i - 16; j < i - 1; j++) m += L[j]; m /= 15; if (L[i] - m > 10 && L[i] > pk - 15 && i - last > 45 && L[i] >= L[i - 1]) { on.push(i); last = i; } }
    if (on.length < 2) return null;
    const g = (on[1] - on[0]) / 1000; return g < 0.075 ? 0 : (on[1] - 4) / 1000;
  }
  rounds() {
    for (const [k, srcs] of Object.entries(ROUNDS)) {
      const e = { category: 'weapons', spatial: true, maxDistance: 0, buffers: [] };
      for (const [s, first] of srcs) {
        const se = this.manifest[s]; if (!se?.buffers?.length) continue; e.maxDistance = Math.max(e.maxDistance, se.maxDistance || 900);
        for (const b of se.buffers) { if (!first) { e.buffers.push(b); continue; } let c = this.firstGap(b); if (c === 0) continue; if (c === null && b.duration > 1.0) c = ROUND_NOM[k]; /* a smeared (far) burst: cut at one round's length */ if (c) this.cuts.set(b, c); e.buffers.push(b); }
      }
      if (e.buffers.length) this.manifest[k] = e;
    }
  }
  // FPV quad and (if the rocket-motor recording is missing) ATGM motor: the original runtime synthesis, unchanged
  oldSynth() {
    const sr = this.ctx.sampleRate, noise = () => Math.random() * 2 - 1;
    const buf = (sec, fn) => { const b = this.ctx.createBuffer(1, Math.floor(sr * sec), sr), d = b.getChannelData(0); const st = { a: 0 }; for (let i = 0; i < d.length; i++) d[i] = fn(i / sr, st); return b; };
    if (!this.has('drone_buzz')) this.manifest.drone_buzz = { category: 'weapons', loop: true, spatial: true, synth: true, buffers: [buf(1.0, (t, st) => {
      let v = 0;
      for (const [f, a] of [[372, 1], [377, 0.9], [369, 0.85], [383, 0.8]]) { for (let h = 1; h <= 9; h++) v += a * Math.sin(2 * Math.PI * f * h * t + h * 1.7) / (h * 1.15); }
      const flutter = 0.78 + 0.22 * Math.sin(2 * Math.PI * 41 * t) * Math.sin(2 * Math.PI * 3 * t);
      st.hp = (st.hp || 0) * 0.6 + noise() * 0.4; const hiss = noise() - st.hp;
      return Math.tanh(v * 0.16 * flutter) * 0.85 + hiss * 0.18;
    })] };
    if (!this.has('rpg_flight') && !this.has('atgm_motor')) this.manifest.atgm_motor = { category: 'weapons', loop: true, spatial: true, synth: true, buffers: [buf(1.0, (t, st) => (st.a += (noise() - st.a) * 0.25) * 0.9 + Math.sin(2 * Math.PI * 95 * t) * 0.15)] };
  }
  // ---------------------------------------------------------------- fallbacks for events with no files (keeps the game audible on a bad install)
  fallbacks() {
    const sr = this.ctx.sampleRate, ctx = this.ctx;
    const mk = (sec, f) => { const b = ctx.createBuffer(1, Math.floor(sr * sec), sr), d = b.getChannelData(0); let s = 0; for (let i = 0; i < d.length; i++) { const t = i / sr; s += ((Math.random() * 2 - 1) - s) * f(t, 'k'); d[i] = s * f(t, 'a'); } return b; };
    const optional = new Set([...Object.values(ALIAS), ...Object.values(FAR).map(f => f[0]), 'explosion_far', 'artillery_far', 'atgm_motor']);
    for (const k of Object.keys(MIX)) {
      if (this.has(k) || optional.has(k)) continue;
      const g = MIX[k][2], loop = /loop|engine|clank|buzz|motor|traverse|ambience|static|siren/.test(k) && !/start/.test(k);
      const dec = g === 'explosions' ? 0.6 : g === 'weapons' ? 0.12 : g === 'ui' ? 0.03 : 0.08;
      const b = loop ? mk(2, (t, w) => w === 'k' ? 0.06 : 0.6) : mk(dec * 5, (t, w) => w === 'k' ? (g === 'explosions' ? 0.05 : 0.4) : Math.exp(-t / dec) * 1.5);
      this.manifest[k] = { ...(this.manifest[k] || {}), loop, spatial: g !== 'ui' && g !== 'amb', buffers: [b], synth: true };
    }
  }
  // ---------------------------------------------------------------- listener / bookkeeping
  setListener(pos, fwd) {
    this.listener = pos; if (fwd) { const l = Math.hypot(fwd.x, fwd.z) || 1; this.fwd = { x: fwd.x / l, z: fwd.z / l }; }
    if (this.ok) this.tick();
  }
  dist(pos) { return pos ? Math.hypot(pos.x - this.listener.x, (pos.y || 0) - this.listener.y, pos.z - this.listener.z) : 0; }
  // level (linear) at distance d for a MIX entry: flat inside r0, inverse distance beyond, + ground/excess loss far out
  att(d, r0) { return d <= r0 ? 1 : (r0 / d) * (d > 200 ? DB(-(d - 200) * 0.004) : 1); }
  pan(pos, d) { const L = this.listener, dx = pos.x - L.x, dz = pos.z - L.z; return clamp((dx * -this.fwd.z + dz * this.fwd.x) / Math.max(d, 1), -1, 1) * 0.85; }
  lpf(d, pos) { let f = 18000 / (1 + d / 110); if (pos && ((pos.x - this.listener.x) * this.fwd.x + (pos.z - this.listener.z) * this.fwd.z) < -10) f *= 0.75; return clamp(f, 320, 18000); }
  mix(key, e) { return MIX[key] || [20 * Math.log10(Math.max(1e-3, e?.gain ?? 1)) - 6, e?.refDistance || 8, CAT_GROUP[e?.category] || 'weapons']; }
  pickBuf(key, e) { const n = e.buffers.length; let i = Math.floor(Math.random() * n); if (n > 2 && i === this.last[key]) i = (i + 1 + Math.floor(Math.random() * (n - 1))) % n; this.last[key] = i; return e.buffers[i]; }
  prune(now) { if (this.act.length > 24 || Math.random() < 0.1) this.act = this.act.filter(v => v.end > now); }
  // ---------------------------------------------------------------- one-shots
  play(key0, pos = null, { gain = 1, rate = 1, delay = true, bus = null, pan = null, dist = null, power = 0 } = {}) {
    if (!this.ok) return null;
    // ground bursts by charge (combat.explode passes power): 152/155 mm (2.7), 122 mm-ish (2.2) -> shell set; mortars (1.3) -> mortar set
    if (power && (key0 === 'explosion_medium' || key0 === 'explosion_small')) { const k = power >= 2 ? 'shell_impact' : power >= 1 ? 'mortar_impact' : null; if (k && this.has(k)) key0 = k; }
    let key = ALIAS[key0] && this.has(ALIAS[key0]) ? ALIAS[key0] : key0;
    let e = this.manifest[key]; if (!e || !e.buffers?.length) return null;
    if (e.loop && e.spatial === false && !pos) return this.bed(key, gain);
    if ((key === 'mortar_incoming' && Math.random() < 0.6) || (key === 'shell_incoming' && Math.random() < 0.35)) return null;   // many rounds land with no warning
    const spatial = !!pos && e.spatial !== false;
    const d = dist ?? (spatial ? this.dist(pos) : 0);
    const far = FAR[key]; if (spatial && far && this.has(far[0]) && d > far[1] * (0.8 + 0.4 * (((pos.x * 0.37 + pos.z * 0.71) % 1 + 1) % 1))) { key = far[0]; e = this.manifest[key]; }   // jitter fixed per spot: a gun's rounds never flip between the two
    const [lv, r0, group] = this.mix(key, e);
    if (spatial && d > (Math.max(e.maxDistance || 900, 900))) return null;
    const ctx = this.ctx, now = ctx.currentTime;
    const t0 = now + (delay && spatial ? Math.min(3.5, Math.max(0, d - 40) / SOS) : 0);
    const [vr, vg] = VAR[group] || VAR.weapons;
    // a world sound with no position (own mortar / battery firing feedback) is heard as if ~60 m off, not in your ear
    const w2d = !spatial && (group === 'weapons' || group === 'explosions');
    const level = DB(lv + (Math.random() * 2 - 1) * vg) * gain * (spatial ? this.att(d, r0) : w2d ? this.att(60, r0) : 1);
    if (level < 3e-4) return null;   // under ~-70 dB: not worth a voice
    // ---- caps: drop if it would be the quietest, else steal the quietest
    this.prune(now);
    const live = this.act.filter(v => v.end > now);
    const cnt = (f) => { let n = 0, lo = null; for (const v of live) if (f(v)) { n++; if (!lo || v.prio < lo.prio) lo = v; } return [n, lo]; };
    for (const [f, cap] of [[v => v.key === key, KEY_CAP[key] || 10], [v => v.group === group, GROUP_CAP[group] || 8], [() => true, TOTAL_CAP]]) {
      const [n, lo] = cnt(f);
      if (n >= cap) { if (!lo || lo.prio >= level) return null; this.kill(lo, now); }
    }
    // ---- automatic fire: one sample per round, the previous round from the same gun fades as this one fires
    const ch = CHOKE[key];
    if (ch && spatial) {
      const ek = ch[0] + ((pos.x / 2.5) | 0) + ',' + ((pos.z / 2.5) | 0), prev = this.emit.get(ek);
      if (prev && prev.end > t0) { try { prev.g.gain.setTargetAtTime(0, Math.max(t0, prev.t0), ch[1]); prev.src.stop(Math.max(t0, prev.t0) + ch[1] * 7); } catch { } prev.end = Math.max(t0, prev.t0) + ch[1] * 7; }
    }
    const v = this.voice(key, e, t0, level, group, rate * (group === 'voice' ? 1 - Math.random() * 0.06 : 1 + (Math.random() * 2 - 1) * vr), spatial ? d : 0, spatial ? (pan ?? this.pan(pos, d)) : (pan ?? 0), 1, bus, spatial ? this.lpf(d, pos) : w2d ? this.lpf(60) : null);   // (voices are only ever pitched down)
    if (!v) return null;
    if (ch && spatial) this.emit.set(ch[0] + ((pos.x / 2.5) | 0) + ',' + ((pos.z / 2.5) | 0), v);
    // ---- blast layers: debris rain close, dull rolling thud far
    const bl = BLAST[key];
    if (bl && spatial) {
      if (bl >= 0.8 && d < 130 && key !== 'shell_impact' && this.has('debris') && cnt(x => x.key === 'debris')[0] < KEY_CAP.debris) this.voice('debris', this.manifest.debris, t0 + 0.12 + Math.random() * 0.25, DB(MIX.debris[0] + 3) * gain * this.att(d, MIX.debris[1]), 'explosions', 0.9 + Math.random() * 0.2, d, v.panV, 1, null, this.lpf(d, pos));
      if (d > 220 && this.has('explosion_far') && cnt(x => x.key === 'explosion_far')[0] < KEY_CAP.explosion_far) this.voice('explosion_far', this.manifest.explosion_far, t0 + 0.03, DB(MIX.explosion_far[0]) * bl * gain * this.att(d, MIX.explosion_far[1]) * clamp((d - 220) / 300, 0.15, 1), 'explosions', 0.92 + Math.random() * 0.16, d, v.panV, 1, null, this.lpf(d * 0.7, pos));
    }
    if (group === 'weapons' || group === 'explosions') this.heat = Math.min(3, this.heat + level * (group === 'explosions' ? 0.6 : 0.25));
    if (key === 'radio' || ((key === 'shout' || key === 'death') && level > 0.2)) this.duck(t0, v.dur);   // call-outs read over the gunfire
    return v;
  }
  voice(key, e, t0, level, group, rate = 1, d = 0, panV = 0, send = 1, bus = null, lp = null) {
    if (!e?.buffers?.length) return null;
    const ctx = this.ctx, src = ctx.createBufferSource(); src.buffer = this.pickBuf(key, e); src.playbackRate.value = rate;
    if (LEAD[key]) t0 += Math.max(0, LEAD[key] - src.buffer.duration / rate);
    const g = ctx.createGain(); g.gain.value = level;
    const cut = this.cuts.get(src.buffer);   // first shot of a burst recording: fade out just before the second shot
    if (cut) { const te = t0 + cut / rate; g.gain.setValueAtTime(level, te - 0.012); g.gain.setTargetAtTime(0, te - 0.012, 0.004); }
    let n = src.connect(g);
    if (lp && lp < 17000) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; f.Q.value = 0.5; n = n.connect(f); }
    const ws = (REVERB_SEND[group] ?? 0.5) * send;
    if (ws > 0 && d > 0) { const s = ctx.createGain(); s.gain.value = ws * clamp(0.14 + d / 450, 0.14, 0.75); n.connect(s).connect(this.revIn); }
    if (panV) { const p = ctx.createStereoPanner(); p.pan.value = panV; n = n.connect(p); }
    n.connect(bus || this.bus[group] || this.bus.weapons);
    src.start(t0); if (cut) src.stop(t0 + cut / rate + 0.04);
    const dur = cut ? cut / rate + 0.04 : src.buffer.duration / rate;
    const v = { src, g, key, group, prio: level, t0, end: t0 + dur, dur, panV };
    src.onended = () => { try { g.disconnect(); } catch { } };
    this.act.push(v);
    return v;
  }
  kill(v, now) { try { v.g.gain.setTargetAtTime(0, Math.max(now, v.t0), 0.012); v.src.stop(Math.max(now, v.t0) + 0.08); } catch { } v.end = now; }
  duck(t0, dur) {
    const p = this.world.gain, now = this.ctx.currentTime;
    p.cancelScheduledValues(now); p.setTargetAtTime(DB(-3.5), Math.max(now, t0 - 0.03), 0.05); p.setTargetAtTime(1, t0 + Math.max(0.35, Math.min(dur, 2.5)), 0.4);
  }
  ui(key) { return this.play(key, null); }
  // ---------------------------------------------------------------- ambience beds (non-positional loops)
  bed(key, gain = 1) {
    if (this.beds.has(key)) return this.beds.get(key);
    if (!this.envSet) { this.envSet = true; const kind = globalThis.game?.map?.kind; this.setEnvironment(kind ? (kind === 'rural' ? 'field' : 'city') : key === 'ambience_city' ? 'city' : 'field'); }
    const e = this.manifest[key], ctx = this.ctx, src = ctx.createBufferSource(); src.buffer = this.pickBuf(key, e); src.loop = true;
    if (e.loopStart != null) { src.loopStart = e.loopStart; src.loopEnd = e.loopEnd; }
    const g = ctx.createGain(), lv = DB(this.mix(key, e)[0]) * gain; g.gain.value = 0; g.gain.setTargetAtTime(lv, ctx.currentTime, 1.5);
    src.connect(g).connect(this.bus.amb); src.start(ctx.currentTime, Math.random() * Math.max(0, (e.loopEnd || src.buffer.duration) - 1));
    const b = { src, g, lv, key }; this.beds.set(key, b); return b;
  }
  // ~4 Hz: battle intensity, sparse distant war, loop culling
  tick(force) {
    const now = this.ctx.currentTime, dt = now - this.tickT; if (!force && dt < 0.25) return; this.tickT = now;
    this.heat *= Math.exp(-Math.min(dt, 1) / 7);
    if (this.beds.size && dt < 2) {
      const A = this.amb;
      if ((A.art -= dt) < 0) {   // distant artillery / impacts, all battle long
        A.art = 15 + Math.random() * 30;
        const k = Math.random() < 0.55 ? 'artillery_far' : 'explosion_far', n = Math.random() < 0.25 ? 2 + (Math.random() * 2 | 0) : 1, p = (Math.random() * 2 - 1) * 0.8;
        for (let i = 0; i < n; i++) { const e = this.manifest[k]; if (e?.buffers?.length) this.voice(k, e, now + i * (0.6 + Math.random() * 1.4), DB(-24 - Math.random() * 12), 'amb', 0.9 + Math.random() * 0.2, 600, p + (Math.random() - 0.5) * 0.25, 0.8, null, 900 + Math.random() * 900); }
      }
      if ((A.fire -= dt) < 0) {   // a firefight somewhere beyond the map edge
        A.fire = 12 + Math.random() * 25;
        const k = ['rifle_burst_far', 'mg_far', 'rifle_burst_far', 'hmg_far', 'cannon30_far'][Math.random() * 5 | 0];
        if (this.has(k)) this.voice(k, this.manifest[k], now + Math.random() * 0.3, DB(-24 - Math.random() * 10), 'amb', 0.95 + Math.random() * 0.1, 500, (Math.random() * 2 - 1) * 0.9, 1, null, 1800 + Math.random() * 1500);
      }
    }
    // loudest N loops per group stay connected; inaudible / culled ones are disconnected (no processing cost)
    const byG = {};
    for (const h of this.loops) (byG[h.group] ||= []).push(h);
    for (const g in byG) { const a = byG[g].sort((x, y) => y.lvl - x.lvl), cap = LOOP_CAP[g] || 8; a.forEach((h, i) => h.cull(i >= cap)); }
    if (this.emit.size > 150) for (const [k, v] of this.emit) if (v.end < now) this.emit.delete(k);
  }
  // ---------------------------------------------------------------- positional loops attached to moving objects
  loop(key, pos, gain = 1) {
    if (!this.ok) return null;
    if (ALIAS[key] && this.has(ALIAS[key])) key = ALIAS[key];
    const e = this.manifest[key]; if (!e?.buffers?.length) return null;
    const ctx = this.ctx, [lv, r0, group] = this.mix(key, e);
    const src = ctx.createBufferSource(); src.buffer = this.pickBuf(key, e); src.loop = true;
    if (e.loopStart != null) { src.loopStart = e.loopStart; src.loopEnd = e.loopEnd; }
    const g = ctx.createGain(); g.gain.value = 0;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.5; f.frequency.value = 12000;
    const p = ctx.createStereoPanner();
    src.connect(g).connect(f).connect(p);
    const send = ctx.createGain(); send.gain.value = (REVERB_SEND[group] ?? 0.3) * 0.5; f.connect(send);
    src.start(ctx.currentTime, Math.random() * Math.max(0, (e.loopEnd || src.buffer.duration) - 0.5));
    const self = this, out = this.bus[group] || this.bus.vehicles;
    let on = false, culled = false, offT = 0, lastT = -1, tg = gain, tr = 1, tp = pos;
    const conn = c => { if (c === on) return; on = c; try { if (c) { p.connect(out); send.connect(self.revIn); } else { p.disconnect(); send.disconnect(); } } catch { } };
    const h = {
      group, lvl: 0, key,
      set(pp, gg = gain, rate = 1) {
        if (!self.ok || !pp) return; tp = pp; tg = gg; tr = rate;
        const t = ctx.currentTime; if (t - lastT < 0.05) return; lastT = t;
        const d = self.dist(pp), lvl = DB(lv) * gg * self.att(d, r0);
        h.lvl = lvl;
        const target = culled ? 0 : lvl;
        if (target > 2e-4) { conn(true); offT = 0; } else if (on && !offT) offT = t + 0.6; else if (offT && t > offT) conn(false);
        g.gain.setTargetAtTime(target, t, 0.08);
        src.playbackRate.setTargetAtTime(rate, t, 0.2);
        f.frequency.setTargetAtTime(self.lpf(d, pp), t, 0.1);
        p.pan.setTargetAtTime(self.pan(pp, d), t, 0.08);
      },
      cull(c) { if (c !== culled) { culled = c; lastT = -1; h.set(tp, tg, tr); } },
      stop() {
        const t = ctx.currentTime; try { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, 0.3); src.stop(t + 1.5); } catch { }
        src.onended = () => { conn(false); try { g.disconnect(); } catch { } };
        self.loops.delete(h);
      },
    };
    this.loops.add(h); h.set(pos, gain, 1);
    return h;
  }
}
