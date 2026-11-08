// Main-menu ambience, synthesized with WebAudio (no samples): a low detuned drone under a slowly breathing filter, a
// quiet minor pad, wind (band-passed noise with a slow sweep) and now and then a distant artillery rumble.
// Starts on the first click / key press while the menu is up (browser autoplay rules), fades out when the menu
// is hidden (battle / campaign / versus loading) and stops. Off with Settings > "Menu audio" (smo_menuaudio = '0')
// or with smo_noaudio = '1' (headless tests). menu.js wires it up.
let ctx = null, out = null, timer = 0, nodes = [];
const KEY = 'smo_menuaudio';
export function menuAudioEnabled() { try { return localStorage.getItem(KEY) !== '0' && localStorage.getItem('smo_noaudio') !== '1'; } catch { return true; } }
export function setMenuAudio(on) { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { } if (!on) stopMenuAudio(0.4); }

export function startMenuAudio() {
  if (out || !menuAudioEnabled()) return;
  const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
  try { ctx ||= new AC(); if (ctx.state === 'suspended') ctx.resume(); } catch { return; }
  const t0 = ctx.currentTime + 0.05, G = v => { const g = ctx.createGain(); g.gain.value = v; return g; };
  out = G(0); out.gain.setValueAtTime(0, t0); out.gain.linearRampToValueAtTime(0.5, t0 + 4);
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -20; comp.ratio.value = 3;
  out.connect(comp).connect(ctx.destination);
  // short generated hall for the pad and the rumbles
  const rev = ctx.createConvolver(), len = ctx.sampleRate * 3, ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
  rev.buffer = ir; rev.connect(G(0.5)).connect(out);
  const osc = (type, f, det = 0) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det; o.start(t0); nodes.push(o); return o; };
  const lfo = (f, depth, param) => { const o = osc('sine', f), g = G(depth); o.connect(g).connect(param); };
  // 1. drone: D1 / D2 / A2 saws through a low-pass that breathes
  const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 150; dlp.Q.value = 2;
  lfo(0.05, 50, dlp.frequency);
  for (const [f, d] of [[36.71, 0], [73.42, 6], [73.42, -8], [110, 3]]) osc('sawtooth', f, d).connect(dlp);
  dlp.connect(G(0.11)).connect(out);
  // 2. pad: D3 F3 A3 C4 triangles, very quiet, slow swell, mostly reverb
  const pg = G(0.0), plp = ctx.createBiquadFilter(); plp.type = 'lowpass'; plp.frequency.value = 900;
  for (const [f, d] of [[146.83, 0], [174.61, 4], [220, -5], [261.63, 7]]) osc('triangle', f, d).connect(plp);
  plp.connect(pg); pg.gain.setValueAtTime(0, t0); pg.gain.linearRampToValueAtTime(0.012, t0 + 8); lfo(0.033, 0.008, pg.gain);
  pg.connect(G(0.4)).connect(out); pg.connect(rev);
  // 3. wind: looped noise, band-passed, slow sweep
  const nb = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate), nd = nb.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const ns = ctx.createBufferSource(); ns.buffer = nb; ns.loop = true; ns.start(t0); nodes.push(ns);
  const wbp = ctx.createBiquadFilter(); wbp.type = 'bandpass'; wbp.frequency.value = 420; wbp.Q.value = 0.7; lfo(0.07, 220, wbp.frequency);
  const wg = G(0.03); lfo(0.11, 0.015, wg.gain); ns.connect(wbp).connect(wg).connect(out);
  // 4. distant artillery: a low thump with a long tail every 9-22 s
  const thump = () => {
    if (!out) return; const t = ctx.currentTime + 0.05, s = ctx.createBufferSource(); s.buffer = nb; s.start(t, Math.random() * 3); s.stop(t + 3);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(180, t); lp.frequency.exponentialRampToValueAtTime(45, t + 2.2);
    const g = G(0), a = 0.25 + Math.random() * 0.35; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(a, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 2.8);
    s.connect(lp).connect(g); g.connect(out); g.connect(rev);
    timer = setTimeout(thump, 9000 + Math.random() * 13000);
  };
  timer = setTimeout(thump, 5000 + Math.random() * 5000);
}

export function stopMenuAudio(fade = 1.2) {
  if (!out) return; clearTimeout(timer); timer = 0;
  const o = out, ns = nodes, t = ctx.currentTime; out = null; nodes = [];
  o.gain.cancelScheduledValues(t); o.gain.setValueAtTime(o.gain.value, t); o.gain.linearRampToValueAtTime(0, t + fade);
  setTimeout(() => { for (const n of ns) try { n.stop(); } catch { } o.disconnect(); if (!out && ctx?.state === 'running') ctx.suspend(); }, fade * 1000 + 100);
}
