// WebAudio mixer driven by assets/audio/manifest.json, with procedural fallbacks for any missing event.
// Positional panning, air-absorption low-pass, speed-of-sound delay for distant events, urban reverb,
// near/far variant selection and per-event voice limits.
const SPEED_OF_SOUND = 343;
const LIMITS = { rifle_near: 14, rifle_far: 10, mg_near: 6, mg_far: 6, bullet_crack: 8, impact_concrete: 8, impact_dirt: 8, impact_metal: 6, ricochet: 4, footstep_rubble: 6, pain: 3, wounded: 3, shout: 3 };

export class Audio {
  constructor() { this.ok = false; this.buffers = {}; this.manifest = {}; this.voices = new Map(); this.loops = new Set(); this.listener = { x: 0, y: 0, z: 0 }; }
  async init(progress) {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.amb = ctx.createGain(); this.amb.gain.value = 0.55; this.amb.connect(this.master);
    this.ui = ctx.createGain(); this.ui.gain.value = 0.5; this.ui.connect(this.master);
    this.reverb = ctx.createConvolver(); this.reverb.buffer = this.makeIR(2.6); const rv = ctx.createGain(); rv.gain.value = 0.32; this.reverb.connect(rv).connect(this.master);
    try { const r = await fetch('assets/audio/manifest.json'); if (r.ok) this.manifest = await r.json(); } catch {}
    const keys = Object.keys(this.manifest); let done = 0;
    await Promise.all(keys.map(async k => {
      const e = this.manifest[k]; e.buffers = [];
      await Promise.all((e.files || []).map(async f => {
        try { const url = f.startsWith('assets/') ? f : `assets/audio/${f}`; const ab = await (await fetch(url)).arrayBuffer(); e.buffers.push(await ctx.decodeAudioData(ab)); } catch (err) { /* skip bad file */ }
      }));
      progress && progress(++done / keys.length);
    }));
    this.synthFallbacks();
    this.ok = true;
  }
  makeIR(sec) {
    // urban canyon: sparse early reflections off facades + diffuse tail
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.2) * 0.35;
      for (let k = 0; k < 14; k++) { const t = Math.floor((0.02 + Math.random() * 0.35) * ctx.sampleRate); const a = (0.6 - k * 0.035) * (Math.random() < .5 ? -1 : 1); for (let j = 0; j < 200; j++) d[t + j] += a * Math.exp(-j / 40) * (Math.random() * 2 - 1); }
    }
    return b;
  }
  has(k) { const e = this.manifest[k]; return e && e.buffers && e.buffers.length; }
  // ---------------------------------------------------------------- synthesis
  synthFallbacks() {
    const sr = this.ctx.sampleRate;
    const buf = (sec, fn, ch = 1) => { const b = this.ctx.createBuffer(ch, Math.floor(sr * sec), sr); for (let c = 0; c < ch; c++) { const d = b.getChannelData(c); let st = { a: 0, b: 0, c: 0 }; for (let i = 0; i < d.length; i++) d[i] = fn(i / sr, st, i); } return b; };
    const lp = (st, x, k) => (st.a += (x - st.a) * k);
    const noise = () => Math.random() * 2 - 1;
    const def = (k, opts, makers) => { if (this.has(k)) return; this.manifest[k] = { gain: 1, spatial: true, refDistance: 8, maxDistance: 900, ...opts, buffers: makers.map(m => m()), synth: true }; };
    const shot = (body, tail, low, crackAmt) => () => buf(tail + 0.05, (t, st) => { const e = Math.exp(-t / body), e2 = Math.exp(-t / tail); const n = noise(); const thump = Math.sin(2 * Math.PI * low * t * (1 - t * 2)) * Math.exp(-t / 0.03); return (lp(st, n, 0.35 + Math.random() * 0.1) * e * 1.4 + n * crackAmt * Math.exp(-t / 0.004) + thump * 0.9) * 0.8 + lp({ a: st.b }, n, 0.05) * e2 * 0.25; });
    def('rifle_near', { gain: 0.55, refDistance: 6 }, [shot(0.018, 0.35, 120, 0.8), shot(0.022, 0.4, 100, 0.7), shot(0.016, 0.3, 140, 0.9)]);
    def('rifle_far', { gain: 0.5, refDistance: 30 }, [() => buf(0.6, (t, st) => lp(st, noise(), 0.06) * Math.exp(-t / 0.08) * 2 + lp({ a: st.b }, noise(), 0.02) * Math.exp(-t / 0.3))]);
    def('mg_near', { gain: 0.6, refDistance: 8 }, [shot(0.02, 0.4, 90, 0.7), shot(0.025, 0.45, 80, 0.6)]);
    def('mg_far', { gain: 0.5, refDistance: 30 }, [() => buf(0.6, (t, st) => lp(st, noise(), 0.05) * Math.exp(-t / 0.1) * 2)]);
    def('hmg', { gain: 0.75, refDistance: 12 }, [shot(0.03, 0.6, 60, 0.6)]);
    def('cannon30', { gain: 0.8, refDistance: 14 }, [shot(0.04, 0.8, 50, 0.5)]);
    def('tankgun', { gain: 1, refDistance: 25 }, [() => buf(2.5, (t, st) => { const n = noise(); return lp(st, n, 0.08) * Math.exp(-t / 0.15) * 3 + Math.sin(2 * Math.PI * 38 * t) * Math.exp(-t / 0.25) * 1.2 + lp({ a: st.b }, n, 0.01) * Math.exp(-t / 0.8) * 2; })]);
    const boom = (dec, low) => () => buf(dec * 4, (t, st) => { const n = noise(); st.b += (n - st.b) * 0.02; return (lp(st, n, 0.12) * Math.exp(-t / (dec * 0.25)) * 2.2 + st.b * Math.exp(-t / dec) * 6 + Math.sin(2 * Math.PI * low * t) * Math.exp(-t / (dec * 0.4)) * 1.4) * 0.7; });
    // FPV drone: 7-inch quad motor whine (looped), and a missile motor roar for ATGMs
    // FPV quad: four slightly detuned motors (integer Hz so the 1 s loop is seamless) -> beating, band-limited saw harmonics,
    // two-blade prop pass flutter, a hiss of prop wash on top. The game raises playbackRate with throttle / dive.
    def('drone_buzz', { gain: 0.55, refDistance: 16, loop: true }, [() => buf(1.0, (t, st) => {
      let v = 0;
      for (const [f, a] of [[372, 1], [377, 0.9], [369, 0.85], [383, 0.8]]) { for (let h = 1; h <= 9; h++) v += a * Math.sin(2 * Math.PI * f * h * t + h * 1.7) / (h * 1.15); }
      const flutter = 0.78 + 0.22 * Math.sin(2 * Math.PI * 41 * t) * Math.sin(2 * Math.PI * 3 * t);
      st.hp = (st.hp || 0) * 0.6 + noise() * 0.4; const hiss = noise() - st.hp;
      return Math.tanh(v * 0.16 * flutter) * 0.85 + hiss * 0.18;
    })]);
    def('atgm_motor', { gain: 0.6, refDistance: 14, loop: true }, [() => buf(1.0, (t, st) => lp(st, noise(), 0.25) * 0.9 + Math.sin(2 * Math.PI * 95 * t) * 0.15)]);
    def('explosion_small', { gain: 0.9, refDistance: 14 }, [boom(0.4, 55), boom(0.5, 48)]);
    def('explosion_medium', { gain: 1, refDistance: 22 }, [boom(0.8, 40), boom(0.9, 35)]);
    def('explosion_large', { gain: 1, refDistance: 35 }, [boom(1.6, 28)]);
    def('rpg_launch', { gain: 0.8, refDistance: 12 }, [() => buf(1.2, (t, st) => lp(st, noise(), 0.3) * (Math.exp(-t / 0.05) * 2 + Math.exp(-t / 0.5) * 0.5))]);
    def('bullet_crack', { gain: 0.35, refDistance: 4, spatial: true }, [() => buf(0.08, (t) => noise() * Math.exp(-t / 0.002) * 1.5 + Math.sin(t * 9000) * Math.exp(-t / 0.01) * 0.3)]);
    def('ricochet', { gain: 0.25, refDistance: 5 }, [() => buf(0.6, (t) => Math.sin(2 * Math.PI * (2600 - 1800 * t) * t) * Math.exp(-t / 0.15) * 0.6)]);
    for (const k of ['impact_concrete', 'impact_dirt', 'impact_metal']) def(k, { gain: 0.35, refDistance: 4 }, [() => buf(0.15, (t, st) => (k === 'impact_metal' ? Math.sin(2 * Math.PI * 1900 * t) * 0.5 : 0) * Math.exp(-t / 0.03) + lp(st, noise(), k === 'impact_dirt' ? 0.1 : 0.4) * Math.exp(-t / 0.02))]);
    const engine = (f0, rough) => () => buf(2, (t, st) => { const ph = 2 * Math.PI * f0 * t; return (Math.sin(ph) * 0.4 + Math.sin(ph * 2.01) * 0.25 + Math.sin(ph * 0.5) * 0.3 + lp(st, noise(), 0.05) * rough) * (0.8 + 0.2 * Math.sin(2 * Math.PI * f0 / 4 * t)); });
    def('btr_engine_idle', { gain: 0.35, loop: true, refDistance: 10 }, [engine(32, 1.2)]);
    def('btr_engine_drive', { gain: 0.45, loop: true, refDistance: 12 }, [engine(46, 1.5)]);
    def('tank_engine_idle', { gain: 0.45, loop: true, refDistance: 12 }, [engine(26, 1.6)]);
    def('tank_engine_drive', { gain: 0.55, loop: true, refDistance: 14 }, [engine(38, 2)]);
    def('track_clank', { gain: 0.3, loop: true, refDistance: 10 }, [() => buf(1, (t) => { const ph = (t * 9) % 1; return noise() * Math.exp(-ph / 0.02) * 0.9; })]);
    def('turret_traverse', { gain: 0.2, loop: true, refDistance: 6 }, [() => buf(1, (t) => Math.sin(2 * Math.PI * 180 * t) * 0.3 + Math.sin(2 * Math.PI * 360 * t) * 0.15)]);
    def('fire_loop', { gain: 0.3, loop: true, refDistance: 8 }, [() => buf(3, (t, st) => lp(st, noise(), 0.08) * 0.8 + (Math.random() < 0.002 ? 1 : 0))]);
    // 152/155 mm howitzer: a deep, long concussion with a rolling echo; heard across the whole map
    def('howitzer', { gain: 1, refDistance: 60 }, [() => buf(4.5, (t, st) => { const n = noise(); st.b = (st.b || 0) + (n - (st.b || 0)) * 0.006; return lp(st, n, 0.06) * Math.exp(-t / 0.12) * 3.2 + Math.sin(2 * Math.PI * 27 * t) * Math.exp(-t / 0.35) * 1.6 + st.b * Math.exp(-t / 1.4) * 14 + st.b * Math.exp(-Math.max(0, t - 1.1) / 0.9) * (t > 1.1 ? 6 : 0); })]);
    def('shell_incoming', { gain: 0.55, refDistance: 60 }, [() => buf(2.4, (t) => { const f = 900 - 420 * t; return (Math.sin(2 * Math.PI * f * t) * 0.25 + (Math.random() * 2 - 1) * 0.35) * Math.min(1, t * 1.5) * (0.4 + t * 0.3); })]);
    def('incoming_whistle', { gain: 0.45, refDistance: 40 }, [() => buf(1.6, (t) => Math.sin(2 * Math.PI * (1400 - 600 * t) * t) * Math.min(1, t * 2) * 0.4)]);
    def('collapse', { gain: 0.9, refDistance: 30 }, [boom(2.5, 25)]);
    def('debris', { gain: 0.4, refDistance: 12 }, [() => buf(1.5, (t, st) => (Math.random() < 0.02 ? noise() : 0) * Math.exp(-t / 0.8) + lp(st, noise(), 0.1) * Math.exp(-t / 0.5) * 0.3)]);
    def('glass_break', { gain: 0.3, refDistance: 8 }, [() => buf(0.8, (t) => noise() * (Math.random() < 0.15 ? 1 : 0.2) * Math.exp(-t / 0.2) * Math.sin(2 * Math.PI * 4000 * t))]);
    def('reload', { gain: 0.25, refDistance: 3 }, [() => buf(0.5, (t) => (Math.abs(t - 0.1) < 0.01 || Math.abs(t - 0.35) < 0.01 ? noise() : 0))]);
    def('body_fall', { gain: 0.3, refDistance: 4 }, [() => buf(0.4, (t, st) => lp(st, noise(), 0.05) * Math.exp(-t / 0.08) * 2)]);
    def('ambience_city', { gain: 0.35, loop: true, spatial: false }, [() => buf(8, (t, st) => { const n = noise(); st.b += (n - st.b) * 0.004; return st.b * 4 + lp(st, n, 0.01) * 0.3; }, 2)]);
    def('ui_click', { gain: 0.4, spatial: false }, [() => buf(0.05, (t) => Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t / 0.008))]);
    def('ui_select', { gain: 0.4, spatial: false }, [() => buf(0.12, (t) => Math.sin(2 * Math.PI * (900 + 900 * t * 8) * t) * Math.exp(-t / 0.04) * 0.6)]);
    def('ui_order', { gain: 0.4, spatial: false }, [() => buf(0.15, (t) => Math.sin(2 * Math.PI * 600 * t) * Math.exp(-t / 0.05) * 0.6 + Math.sin(2 * Math.PI * 1200 * t) * Math.exp(-t / 0.03) * 0.3)]);
    def('ui_alert', { gain: 0.5, spatial: false }, [() => buf(0.5, (t) => Math.sin(2 * Math.PI * (t < 0.2 ? 700 : 520) * t) * Math.exp(-((t % 0.2)) / 0.12) * 0.5)]);
    def('radio', { gain: 0.3, spatial: false }, [() => buf(0.6, (t, st) => lp(st, noise(), 0.6) * 0.25 * (t < 0.08 || t > 0.5 ? 1 : 0.4))]);
    for (const k of ['victory', 'defeat']) def(k, { gain: 0.5, spatial: false }, [() => buf(3, (t) => { const f = k === 'victory' ? [262, 330, 392] : [220, 262, 311]; return f.reduce((a, fr, i) => a + Math.sin(2 * Math.PI * fr * t) * Math.exp(-Math.max(0, t - i * 0.25) / 1.2) * (t > i * 0.25 ? 0.2 : 0), 0); })]);
  }
  // ---------------------------------------------------------------- playback
  setListener(pos, fwd) {
    this.listener = pos; if (!this.ok) return;
    const L = this.ctx.listener, t = this.ctx.currentTime;
    if (L.positionX) { L.positionX.setTargetAtTime(pos.x, t, 0.05); L.positionY.setTargetAtTime(pos.y, t, 0.05); L.positionZ.setTargetAtTime(pos.z, t, 0.05); L.forwardX.setTargetAtTime(fwd.x, t, 0.05); L.forwardY.setTargetAtTime(0, t, 0.05); L.forwardZ.setTargetAtTime(fwd.z, t, 0.05); L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; }
    else { L.setPosition(pos.x, pos.y, pos.z); L.setOrientation(fwd.x, 0, fwd.z, 0, 1, 0); }
  }
  dist(pos) { return pos ? Math.hypot(pos.x - this.listener.x, (pos.y || 0) - this.listener.y, pos.z - this.listener.z) : 0; }
  pick(key, pos) {
    // prefer a *_far variant beyond 120 m when it exists
    const d = this.dist(pos);
    if (key.endsWith('_near') && d > 120) { const f = key.replace('_near', '_far'); if (this.has(f)) key = f; }
    return [key, this.manifest[key], d];
  }
  play(key0, pos = null, { gain = 1, rate = 1, delay = true, bus = null } = {}) {
    if (!this.ok) return null;
    const [key, e, d] = this.pick(key0, pos); if (!e || !e.buffers?.length) return null;
    const maxD = e.maxDistance || 900; if (pos && d > maxD) return null;
    const lim = LIMITS[key] || 8; const list = this.voices.get(key) || []; this.voices.set(key, list);
    const now = this.ctx.currentTime;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].end < now) list.splice(i, 1);
    if (list.length >= lim) { list.sort((a, b) => b.d - a.d); if (list[0].d < d) return null; try { list[0].src.stop(); } catch {} list.shift(); }
    const ctx = this.ctx, src = ctx.createBufferSource();
    src.buffer = e.buffers[Math.floor(Math.random() * e.buffers.length)];
    src.playbackRate.value = rate * (0.94 + Math.random() * 0.12);
    const g = ctx.createGain(); g.gain.value = (e.gain ?? 1) * gain;
    let node = src.connect(g), pn = null;
    if (pos && e.spatial !== false) {
      const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = Math.max(700, 18000 / (1 + d / 60));
      const p = pn = ctx.createPanner(); p.panningModel = 'equalpower'; p.distanceModel = 'inverse';
      p.refDistance = e.refDistance || 8; p.maxDistance = maxD; p.rolloffFactor = 1.1;
      if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y || 0; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y || 0, pos.z);
      node = g.connect(lpf).connect(p);
      const send = ctx.createGain(); send.gain.value = Math.min(1, 0.25 + d / 250); p.connect(send).connect(this.reverb);
    }
    node.connect(bus || (e.category === 'ui' || key.startsWith('ui_') ? this.ui : (e.loop && e.spatial === false ? this.amb : this.sfx)));
    const t0 = now + (delay && pos ? Math.min(2.5, d / SPEED_OF_SOUND) : 0);
    if (e.loop) { src.loop = true; if (e.loopStart != null) { src.loopStart = e.loopStart; src.loopEnd = e.loopEnd; } }
    src.start(t0);
    const v = { src, g, panner: pn, end: e.loop ? Infinity : t0 + src.buffer.duration / src.playbackRate.value, d, key };
    list.push(v);
    return v;
  }
  // looping positional sound attached to a moving object
  loop(key, pos, gain = 1) {
    const v = this.play(key, pos, { gain, delay: false }); if (!v) return null;
    const h = {
      v, set: (p, g = gain, rate = 1) => {
        if (!this.ok) return; const t = this.ctx.currentTime;
        const node = v.g; node.gain.setTargetAtTime((this.manifest[v.key]?.gain ?? 1) * g, t, 0.15);
        v.src.playbackRate.setTargetAtTime(rate, t, 0.2);
        // walk the graph to the panner
        h.p = v.panner;
        if (h.p) { if (h.p.positionX) { h.p.positionX.setTargetAtTime(p.x, t, 0.05); h.p.positionY.setTargetAtTime(p.y || 0, t, 0.05); h.p.positionZ.setTargetAtTime(p.z, t, 0.05); } else h.p.setPosition(p.x, p.y || 0, p.z); }
      },
      stop: () => { try { v.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3); v.src.stop(this.ctx.currentTime + 1.2); } catch {} this.loops.delete(h); },
    };
    this.loops.add(h); return h;
  }
  ui(key) { return this.play(key, null); }
}
