// Tense intro music for the campaign cutscene, synthesized with WebAudio (no samples, no copyrighted music):
// a low detuned drone under a slowly opening filter, a heartbeat sub pulse, clock-like ticks, a dissonant string
// cluster with tremolo, distant artillery thuds, a rising noise swell and an impact when the title card lands.
let CTX = null;
// call from a user gesture (click) so the browser lets the context start
export function primeAudio() {
  try { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; if (!CTX) CTX = new AC(); if (CTX.state === 'suspended') CTX.resume(); return CTX; } catch { return null; }
}

export function playIntroMusic({ titleAt = 3.2, length = 11 } = {}) {
  const ctx = primeAudio(); if (!ctx) return { stop() {} };
  const t0 = ctx.currentTime + 0.05, nodes = [];
  const master = ctx.createGain(); master.gain.value = 0;
  master.gain.setValueAtTime(0, t0); master.gain.linearRampToValueAtTime(0.85, t0 + 1.5);
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4;
  master.connect(comp).connect(ctx.destination);
  // reverb from a generated impulse
  const rev = ctx.createConvolver(), len = ctx.sampleRate * 3.2, ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
  rev.buffer = ir; const wet = ctx.createGain(); wet.gain.value = 0.42; rev.connect(wet).connect(master);
  const out = (node, dry = 1, send = 0.5) => { const g = ctx.createGain(); g.gain.value = dry; node.connect(g).connect(master); if (send) { const s = ctx.createGain(); s.gain.value = send; node.connect(s).connect(rev); } };
  const osc = (type, f, t = t0) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(t); nodes.push(o); return o; };
  const noiseBuf = (() => { const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; return b; })();
  const noise = (t, dur) => { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(t); s.stop(t + dur + 0.1); nodes.push(s); return s; };
  const end = t0 + length;

  // 1. drone: D1/D2 saws, detuned, through a slowly opening low-pass
  const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.Q.value = 6; dlp.frequency.setValueAtTime(140, t0); dlp.frequency.exponentialRampToValueAtTime(520, t0 + 8); dlp.frequency.exponentialRampToValueAtTime(260, end);
  const dg = ctx.createGain(); dg.gain.setValueAtTime(0, t0); dg.gain.linearRampToValueAtTime(0.22, t0 + 2.5); dg.gain.setValueAtTime(0.22, end - 2); dg.gain.linearRampToValueAtTime(0, end);
  for (const [f, det] of [[36.71, 0], [73.42, 7], [73.42, -9], [110.0, 4]]) { const o = osc('sawtooth', f); o.detune.value = det; o.connect(dlp); o.stop(end + 0.2); }
  dlp.connect(dg); out(dg, 1, 0.35);
  const lfo = osc('sine', 0.18); const lg = ctx.createGain(); lg.gain.value = 60; lfo.connect(lg).connect(dlp.frequency); lfo.stop(end);

  // 2. heartbeat sub pulse (lub-dub) at ~66 bpm, quickening after the title
  const kick = (t, amp) => { const o = osc('sine', 90, t), g = ctx.createGain(); o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.18); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + 0.008); g.gain.exponentialRampToValueAtTime(0.001, t + 0.4); o.connect(g); out(g, 1, 0.15); o.stop(t + 0.45); };
  for (let t = t0 + 0.6, k = 0; t < end - 0.8; k++) { const bpm = t - t0 < titleAt ? 62 : 76; kick(t, 0.75); kick(t + 0.24, 0.45); t += 60 / bpm; }

  // 3. clock ticks (filtered noise), from 1.5 s
  for (let t = t0 + 1.5, i = 0; t < end - 1; t += 0.5, i++) { const s = noise(t, 0.03), hp = ctx.createBiquadFilter(), g = ctx.createGain(); hp.type = 'highpass'; hp.frequency.value = i % 2 ? 6500 : 4800; g.gain.setValueAtTime(i % 2 ? 0.04 : 0.065, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.04); s.connect(hp).connect(g); out(g, 1, 0.2); }

  // 4. string cluster (D5 + Eb5 + A4) with tremolo, swelling in
  const sg = ctx.createGain(); sg.gain.setValueAtTime(0, t0); sg.gain.linearRampToValueAtTime(0, t0 + 2); sg.gain.linearRampToValueAtTime(0.05, t0 + 6.5); sg.gain.linearRampToValueAtTime(0.075, end - 2); sg.gain.linearRampToValueAtTime(0, end);
  const trem = ctx.createGain(); trem.gain.value = 0.6; const tl = osc('sine', 7.5); const tlg = ctx.createGain(); tlg.gain.value = 0.4; tl.connect(tlg).connect(trem.gain); tl.stop(end);
  for (const [f, d] of [[587.33, 0], [622.25, -6], [440, 5], [293.66, 3]]) { const o = osc('triangle', f); o.detune.value = d; const v = osc('sine', 5.3 + Math.random()); const vg = ctx.createGain(); vg.gain.value = 4; v.connect(vg).connect(o.detune); o.connect(trem); o.stop(end + 0.2); v.stop(end); }
  const slp = ctx.createBiquadFilter(); slp.type = 'lowpass'; slp.frequency.value = 2400; trem.connect(slp).connect(sg); out(sg, 1, 0.9);

  // 5. distant artillery: low noise thumps with long tails
  const thud = (t, amp) => { const s = noise(t, 1.6), lp = ctx.createBiquadFilter(), g = ctx.createGain(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(220, t); lp.frequency.exponentialRampToValueAtTime(60, t + 1.2); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 1.5); s.connect(lp).connect(g); out(g, 1, 0.8); };
  for (const [t, a] of [[1.1, 0.5], [2.4, 0.3], [5.6, 0.45], [6.1, 0.25], [8.4, 0.55]]) if (t0 + t < end - 0.5) thud(t0 + t, a);

  // 6. rising swell into the title impact, then a second swell to the end
  const swell = (a, b, f0, f1, amp) => { const s = noise(a, b - a + 0.2), bp = ctx.createBiquadFilter(), g = ctx.createGain(); bp.type = 'bandpass'; bp.Q.value = 2.5; bp.frequency.setValueAtTime(f0, a); bp.frequency.exponentialRampToValueAtTime(f1, b); g.gain.setValueAtTime(0, a); g.gain.linearRampToValueAtTime(amp, b - 0.05); g.gain.linearRampToValueAtTime(0, b + 0.05); s.connect(bp).connect(g); out(g, 1, 0.6); };
  swell(t0 + 0.8, t0 + titleAt, 200, 2600, 0.12); swell(t0 + titleAt + 3, end - 0.6, 150, 1800, 0.08);
  // impact: sub drop + metallic noise burst
  { const t = t0 + titleAt; const o = osc('sine', 70, t), g = ctx.createGain(); o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(28, t + 1.6); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.9, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + 2.6); o.connect(g); out(g, 1, 0.5); o.stop(t + 2.8);
    const s = noise(t, 2.2), hp = ctx.createBiquadFilter(), ng = ctx.createGain(); hp.type = 'bandpass'; hp.frequency.value = 3200; hp.Q.value = 0.7; ng.gain.setValueAtTime(0.22, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 2); s.connect(hp).connect(ng); out(ng, 0.6, 1); }

  let stopped = false;
  return {
    stop(fade = 0.8) {
      if (stopped) return; stopped = true; const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t); master.gain.setValueAtTime(master.gain.value, t); master.gain.linearRampToValueAtTime(0, t + fade);
      setTimeout(() => { for (const n of nodes) { try { n.stop(); } catch {} } try { master.disconnect(); } catch {} }, (fade + 0.2) * 1000);
    },
  };
}

// small UI blips for orders (move / attack / end turn)
export function blip(kind = 'move') {
  const ctx = CTX; if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'square'; const f = { move: 660, attack: 330, end: 440, error: 180 }[kind] || 500; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * (kind === 'error' ? 0.7 : 1.25), t + 0.08);
  g.gain.setValueAtTime(0.04, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.12); o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.14);
}
