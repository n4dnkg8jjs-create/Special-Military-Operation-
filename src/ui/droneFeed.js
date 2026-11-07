import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { updateLods, LODS } from '../world/instancer.js';
import { Osd } from './osd.js';

// FPV drone view: a picture-in-picture window with the goggles feed of one of the player's FPV drones while it flies to
// its target (game/support.js FpvTeam; on the versus joiner the host's snapshot drones of the joiner's own side,
// net/battle.js g._netDrones). Only the own side's drones are ever shown.
//   * camera: the drone's own position each frame, racing-frame FPV optics (~120 deg horizontal, camera tilted up 25 deg
//     on the frame, so the view sits a little below the horizon in cruise and on the target in the dive), banks into
//     turns, prop-wash vibration, tumbles when shot down.
//   * render: a reduced pass into a 480x270 HalfFloat target at ~30 Hz (analog video frame rate; the composite runs every
//     frame): the scene with the main pass' shadow map (no shadow re-render), no GTAO / bloom / SMAA / grade, instanced
//     LODs chosen for a point 80 m above the drone (coarser), the main camera's LODs restored right after; far plane 560 m
//     in a denser haze (small analog camera), small clutter with a cull distance (crop clumps...) culled at half of it. Soldiers the main
//     camera culled are shown when they are in the drone's view. HUD overlays (selection rings, order lines, markers)
//     and the drone's own airframe are hidden for the pass.
//   * analog look (shader, composited into the window's screen area of the main canvas with viewport + scissor after
//     the main post chain): flat washed colours, sharpening halos, band-limited chroma bleeding right, line jitter,
//     snow and dropout streaks rising with range from the pilot, lost line of sight, low altitude far out and enemy EW
//     (vehicle jammer kits, the side's trench EW mod, a jammed dive), brief breakups (frozen frame, tearing, roll), and
//     on impact / shoot-down a burst of static, then SIGNAL LOST, then the window closes or goes to the next drone.
//   * window: a ground-station monitor docked top right (style.css, FPV section): title (team, drone number), the receiver's status line
//     (band / channel, link bars + LQ, pack voltage, DVR time), the Betaflight-style OSD (ui/osd.js, a canvas over the
//     picture), a standby scan screen; N toggles, Shift+N cycles, x closes (localStorage smo_fpvfeed_open); a click on
//     the feed jumps the main camera to the drone. ?dronefeed=0: off.
// Its CPU time is handed to the adaptive-resolution logic as non-scalable work (renderer.dynFrame), so the fixed-cost
// PiP does not push the main resolution down.
const RW = 480, RH = 270, FPS = 30, UPTILT = THREE.MathUtils.degToRad(25), VFOV = 88;   // 88 deg vertical = ~120 deg horizontal at 16:9
const LOST_STATIC = 0.45, LOST_END = 2.3, FAR = 560, FOG = 0.0034;   // the small camera sees a hazier world (FogExp2 density): ~97 % fog at the far plane
const PH = ['launch', 'climb', 'cruise', 'dive', 'fall'];
const RACEBAND = [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917];   // analog 5.8 GHz video channels (band R): one per drone in turn
const pad2 = n => String(n).padStart(2, '0');
export const FEED_PHASE = PH;
const wrapA = a => Math.atan2(Math.sin(a), Math.cos(a));
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// v2: a panel the player opens and closes (the 'FPV' tab at the right edge, or N); closed by default, it never pops up
// on its own. Open, it shows the drone in the air (the next one when a drone is lost) or a standby screen.
const prefOpen = () => { try { return localStorage.getItem('smo_fpvfeed_open') === '1'; } catch { return false; } };
const savePrefOpen = on => { try { localStorage.setItem('smo_fpvfeed_open', on ? '1' : '0'); } catch { } };
export function droneFeedEnabled() { try { return new URLSearchParams(location.search).get('dronefeed') !== '0'; } catch { return true; } }

const AnalogShader = {
  uniforms: { tFeed: { value: null }, res: { value: new THREE.Vector2(RW, RH) }, time: { value: 0 }, frame: { value: 0 }, noise: { value: 0.05 }, brk: { value: 0 }, snow: { value: 0 }, dark: { value: 0 }, hum: { value: 0 }, roll: { value: 0 }, tearY: { value: 0.5 }, exposure: { value: 1.1 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `uniform sampler2D tFeed; uniform vec2 res; uniform float time, frame, noise, brk, snow, dark, hum, roll, tearY, exposure; varying vec2 vUv;
    float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    vec3 neutral(vec3 c){ c *= exposure; float x = min(c.r, min(c.g, c.b)); float o = x < 0.08 ? x - 6.25 * x * x : 0.04; c -= o;
      float pk = max(c.r, max(c.g, c.b)); const float S = 0.76; if (pk < S) return c; float d = 1.0 - S; float np = 1.0 - d * d / (pk + d - S); c *= np / pk;
      float g = 1.0 - 1.0 / (0.15 * (pk - np) + 1.0); return mix(c, vec3(np), g); }
    vec3 srgb(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    vec3 tap(vec2 uv){ return srgb(neutral(texture2D(tFeed, uv).rgb)); }
    const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
    const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
    void main(){
      vec2 p = vUv;
      p.y = fract(p.y + roll);                                   // vertical roll while the receiver loses sync
      float line = floor(p.y * 288.0);
      float lj = h12(vec2(line, frame)) - 0.5;                    // per-line time-base error
      float tear = exp(-abs(p.y - tearY) * 28.0);
      p.x += lj * (0.0012 + noise * noise * 0.011 + brk * 0.03) + tear * brk * 0.07 + sin(p.y * 38.0 + time * 23.0) * brk * 0.008;
      // wide-angle lens: mild barrel distortion, normalised to the frame corners
      vec2 c = (p - 0.5) * vec2(1.7778, 1.0); float r2 = dot(c, c); c *= (1.0 + 0.14 * r2) / (1.0 + 0.14 * 1.0401); p = c / vec2(1.7778, 1.0) + 0.5;
      vec2 px = vec2(1.0 / res.x, 0.0);
      vec3 s0 = tap(p), sL = tap(p - px * 1.5), sR = tap(p + px * 1.5), sR2 = tap(p + px * 3.5);
      vec3 y0 = toYIQ * s0, yb = toYIQ * ((sL + s0 + sR) / 3.0), cb = toYIQ * ((sL + s0 + sR + sR2) * 0.25);
      float Y = y0.x + (y0.x - yb.x) * 0.7;                       // the camera's sharpening halos
      vec2 IQ = cb.yz * 0.8;                                      // band-limited chroma, bleeding to the right, washed
      float a = (h12(vec2(line * 0.37, frame)) - 0.5) * noise * 1.3; IQ = mat2(cos(a), sin(a), -sin(a), cos(a)) * IQ;
      IQ += (vec2(h12(gl_FragCoord.xy + frame), h12(gl_FragCoord.yx - frame)) - 0.5) * noise * 0.2;
      vec3 col = toRGB * vec3(Y, IQ);
      col = col * 0.86 + 0.055; col *= vec3(0.97, 1.0, 0.975);   // lifted blacks, soft whites, small-CMOS green-grey cast
      col += (h12(gl_FragCoord.xy + frame * vec2(17.0, 31.0)) - 0.5) * (0.06 + noise * noise * 0.6);
      float st = h12(vec2(floor(p.x * 30.0 + h12(vec2(line, frame)) * 7.0), line) + frame * 3.1);
      col = mix(col, vec3(0.92), step(1.0 - noise * noise * noise * 0.04, st) * 0.8);   // white dropout streaks (comets)
      col *= 1.0 - hum * 0.32 * (0.5 + 0.5 * sin(vUv.y * 7.0 - time * 9.0));     // jammer: hum bars + fine interference
      col += hum * 0.13 * sin(vUv.y * 520.0 + vUv.x * 60.0 + time * 70.0);
      float sn = h12(floor(gl_FragCoord.xy * 0.5) + frame * vec2(7.0, 13.0)) * (0.7 + 0.3 * h12(vec2(line, frame + 3.0)));
      col = mix(col, vec3(sn), snow);
      col = mix(col, vec3(0.03, 0.035, 0.04) + sn * 0.07, dark);
      if (p.x < 0.0 || p.x > 1.0) col *= 0.15;
      col *= 0.93 + 0.07 * step(0.5, fract(gl_FragCoord.y * 0.5));
      vec2 v = vUv - 0.5; col *= 1.0 - 0.9 * dot(v, v);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

export class DroneFeed {
  constructor(game) {
    this.g = game; game.droneFeed = this;
    this.panel = prefOpen(); this.mode = 'off'; this.cur = null;
    this.cpuMs = 0; this.st = { renders: 0, composites: 0, ms: 0, n: 0, msMax: 0 };
    this.noise = 0.05; this.brkT = 0; this.brkA = 0; this.roll = 0; this.rollV = 0; this.tearY = 0.5; this.losK = 0; this.losT = 0; this.acc = 1; this.rtOk = false; this.clock = 0;
    this.cam = new THREE.PerspectiveCamera(VFOV, RW / RH, 0.08, FAR); this.cam.rotation.order = 'YXZ';
    this.rt = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, samples: 0 });
    this.mat = new THREE.ShaderMaterial({ ...AnalogShader, uniforms: THREE.UniformsUtils.clone(AnalogShader.uniforms), depthTest: false, depthWrite: false, toneMapped: false });
    this.mat.uniforms.tFeed.value = this.rt.texture; this.mat.uniforms.exposure.value = game.renderer.r.toneMappingExposure;
    this.quad = new FullScreenQuad(this.mat);
    this.vp = new THREE.Vector4(); this.sc = new THREE.Vector4(); this.frus = new THREE.Frustum(); this.pm = new THREE.Matrix4(); this.sph = new THREE.Sphere(new THREE.Vector3(), 2.2); this.lodP = new THREE.Vector3();
    this.buildDom();
    addEventListener('resize', () => { this.layout(); });
    addEventListener('keydown', e => {
      if (e.code !== 'KeyN' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return;
      if (this.g.over || this.g.phase === 'deploy') return;
      if (e.shiftKey) this.cycle(true); else this.toggle();   // N: show / hide, Shift+N: next drone
    });
  }
  // ---------------------------------------------------------------- DOM
  buildDom() {
    const el = this.el = document.createElement('div'); el.id = 'dronefeed'; el.className = 'df hidden';
    el.innerHTML = `<div class="df-head"><div class="df-r1"><i class="df-live"></i><span class="df-title">FPV feed</span><span class="df-num"></span><span class="df-sp"></span>
      <button class="df-cyc" title="Next drone in the air (Shift+N)">Next <b></b></button>
      <button class="df-x" title="Close the FPV view (N)" aria-label="Close the FPV view">&times;</button></div>
      <div class="df-r2"><span class="df-ch" title="Video channel (band R)"><span class="v">--</span></span><span class="df-lq" title="Link quality"><i class="df-sig" data-n="0"><b></b><b></b><b></b><b></b></i>LQ <span class="v">--</span></span><span class="df-bat" title="Pack voltage (6S)"><i class="df-cell"><b></b></i><span class="v">--</span></span><span class="df-rec" title="Video recorder"><i></i>REC <span class="v">00:00</span></span></div></div>
      <div class="df-scr" title="Click: move the camera to this drone"><canvas class="df-osd"></canvas><div class="df-sb"><b>NO SIGNAL</b><span>No FPV drone in the air. Select the FPV team and right-click a target to launch one.</span></div><div class="df-lost"><span>SIGNAL LOST</span></div></div>`;
    const q = s => el.querySelector(s);
    this.titleEl = q('.df-title'); this.numEl = q('.df-num'); this.cycEl = q('.df-cyc'); this.cycN = q('.df-cyc b'); this.scr = q('.df-scr'); this.osd = q('.df-osd'); this.lostEl = q('.df-lost');
    this.osdC = new Osd(this.osd);
    this.rx = { ch: q('.df-ch .v'), sig: q('.df-sig'), lq: q('.df-lq .v'), bat: q('.df-bat'), cell: q('.df-cell b'), v: q('.df-bat .v'), rec: q('.df-rec .v') };
    for (const b of el.querySelectorAll('button')) b.addEventListener('pointerdown', e => e.stopPropagation());
    this.cycEl.addEventListener('click', () => this.cycle(false));
    q('.df-x').addEventListener('click', () => { this.setPanel(false); this.g.sfx?.('ui_click'); });
    // closed: a tab at the right edge (live dot + number of drones in the air); a click (or N) opens the panel
    const pill = this.pill = document.createElement('button'); pill.id = 'dronefeedPill'; pill.className = 'hidden'; pill.title = 'FPV view (N)';
    pill.innerHTML = '<i class="df-live"></i><span>FPV</span><b></b>'; this.pillN = pill.querySelector('b');
    pill.addEventListener('pointerdown', e => e.stopPropagation()); pill.addEventListener('click', () => { this.setPanel(true); this.g.sfx?.('ui_click'); });
    this.scr.addEventListener('pointerdown', e => { e.stopPropagation(); if (e.button === 0) this.jump(); });
    const hud = document.getElementById('hud') || document.body, dock = document.getElementById('dock') || document.getElementById('cmd');
    if (dock && dock.parentNode === hud) { hud.insertBefore(el, dock); hud.insertBefore(pill, dock); } else hud.append(el, pill);   // before the dock: the unit card and the order tooltips paint over the window
  }
  // window size: ~344x194 CSS px at 1600 px wide, 288 at 1280, 550 at 2560; whole pixels (size and position: no
  // transform) so the canvas viewport matches the screen area exactly
  layout() {
    const w = Math.round(Math.min(560, Math.max(288, innerWidth * 0.215))), h = Math.round(w * 9 / 16);
    if (w !== this._w || h !== this._h) { this._w = w; this._h = h; this.scr.style.width = w + 'px'; this.scr.style.height = h + 'px'; this.el.style.setProperty('--dfw', w + 'px'); }
    this.osdC.size(w, h, Math.min(2, devicePixelRatio || 1));
    // top right, under the minimap + force table (style.css --df-top), clear of the message feed and the orders (bottom right)
    if (this.visible) { const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16, fz = document.getElementById('forces')?.getBoundingClientRect(), top = Math.round(fz?.height ? fz.bottom + rem * 0.35 : Math.max(8, rem * 2.4)); if (top !== this._top) { this._top = top; this.el.style.top = top + 'px'; } }
    this.rectT = 0;
  }
  readRect() {
    const r = this.scr.getBoundingClientRect(), c = this.g.renderer.r.domElement.getBoundingClientRect();
    this.rect = { x: Math.round(r.left - c.left), y: Math.round(r.top - c.top), w: Math.round(r.width), h: Math.round(r.height), H: Math.round(c.height) };
  }
  show() { if (this.visible) return; this.visible = true; this.el.classList.remove('hidden'); this._top = null; this.layout(); this.readRect(); }
  hide() { if (!this.visible && this.mode === 'off') return; this.visible = false; this.mode = 'off'; this.cur = null; this.el.classList.add('hidden'); }
  setPanel(on) { this.panel = on; savePrefOpen(on); if (!on) this.hide(); }
  toggle() { this.setPanel(!this.panel); }
  // the player has an FPV team (the tab only shows then)
  hasTeam() { return this.g.squads.some(q => q.side === 'player' && q.kind === 'fpv' && !q.destroyed); }
  // ---------------------------------------------------------------- sources: the own side's drones in the air
  sources() {
    const g = this.g, out = this._src ||= []; out.length = 0;
    if (g.netClient) { for (const e of g._netDrones?.values() || []) if (e.sq?.side === 'player' && e.phase !== 'launch') out.push(e); return out; }
    for (const sq of g.squads) { if (sq.side !== 'player') continue; const d = sq.support?.drone; if (d && d.mesh && d.phase !== 'launch') { d._sq ||= sq; out.push(d); } }
    return out;
  }
  // a drone's state, the same shape for the host's drones and the joiner's snapshot drones
  info(d) {
    const I = this._inf ||= { pos: new THREE.Vector3(), vel: new THREE.Vector3(), tgt: new THREE.Vector3() };
    if (d.net) {
      const k = Math.min(0.3, Math.max(0, (performance.now() - d.rt) / 1000));   // (extrapolate between 10 Hz snapshots)
      I.pos.copy(d.pos).addScaledVector(d.vel, k); I.vel.copy(d.vel); I.tgt.copy(d.aim); I.phase = d.phase; I.jam = d.jam; I.age = d.age + k;
      const p = d.sq?.effective[0]; I.pilot = p?.pos || null; I.pilotOk = !!p; I.name = d.sq?.name || 'FPV team'; I.num = d.num || 0; I.mesh = null; I.side = 'player';
      return I;
    }
    const t = d.target, sq = d._sq;
    I.pos.copy(d.pos); I.vel.copy(d.vel); I.phase = d.phase; I.jam = !!d.jam && d.phase === 'dive'; I.age = d.age;
    if (d.aim && d.phase === 'dive') I.tgt.copy(d.aim); else if (t) I.tgt.copy(t.type === 'vehicle' ? t.pos : (d.man?.pos || t.center()));
    I.pilot = d.pilot?.pos || null; I.pilotOk = !!d.pilot?.effective; I.name = sq?.name || 'FPV team'; I.num = sq?.support?.launched || 0; I.mesh = d.mesh; I.side = sq?.side || 'player';
    return I;
  }
  open(d) {
    this.cur = this.lastCur = d; this.mode = 'live'; this.rtOk = false; this.acc = 1; this.brkT = 0; this.brkA = 0; this.roll = 0; this.rollV = 0; this.noise = 0.1; this.losT = 0;
    this.lostEl.classList.remove('show'); this.el.classList.remove('lost');
    d._fv ||= { yaw: 0, pitch: 0, roll: 0, yawRate: 0, dive: 0, init: false, spin: 0 };
    this.el.classList.remove('standby'); this.show(); this.titleT = 0; this._rxv = null;
  }
  cycle(fromKey) {
    const L = this.sources(); if (!L.length) { if (fromKey) this.g.hud?.alert?.('No FPV drone in the air'); return; }
    if (!this.visible || this.mode !== 'live') { this.setPanel(true); return this.open(L.includes(this.cur) ? this.cur : L.includes(this.lastCur) ? this.lastCur : L[0]); }
    const i = L.indexOf(this.cur); this.open(L[(i + 1) % L.length]); this.g.sfx?.('ui_click');
  }
  jump() {
    const d = this.cur; if (!d || this.mode !== 'live') return;
    const I = this.info(d), cam = this.g.cam, fv = d._fv; cam.lookAt(I.pos.x, I.pos.z);
    if (fv) cam.tYaw = cam.tYaw + wrapA(fv.yaw + Math.PI - cam.tYaw);   // look along the flight path
    cam.tDist = Math.min(cam.tDist, 80); this.g.sfx?.('ui_select');
  }
  // ---------------------------------------------------------------- per frame (also while the render is off: state only)
  update(dt) {
    const g = this.g; this.clock += dt;
    if (g.over || g.phase === 'deploy') { if (this.visible) this.hide(); this.setPill(-1); return; }
    const L = this.sources();
    this.setPill(this.panel || !this.hasTeam() ? -1 : L.length);
    if (!this.panel) { if (this.visible) this.hide(); return; }
    // open: the drone in the air (the last one watched first), else a standby screen (nothing rendered)
    if (this.mode === 'off') { if (L.length) this.open(L.includes(this.lastCur) ? this.lastCur : L[0]); else if (!this.visible) { this.standby(); this.show(); } }
    if (this.mode === 'live') {
      const d = this.cur, I = L.includes(d) ? this.info(d) : null;
      if (!I || (I.phase === 'fall' && !I.pilotOk)) { this.mode = 'lost'; this.lostT = 0; this.lostEl.classList.remove('show'); }
      else this.track(d, I, dt);
    }
    if (this.mode === 'lost') {
      this.lostT += dt;
      if (this.lostT > LOST_STATIC) this.lostEl.classList.add('show');
      if (this.lostT > LOST_END) { this.lostEl.classList.remove('show'); const nx = L.find(x => x !== this.cur); if (nx) this.open(nx); else { this.mode = 'off'; this.cur = null; this.el.classList.remove('lost'); this.standby(); } }
    }
    if (!this.visible) return;
    // chrome: title, cycle count, receiver line, OSD canvas (DOM writes change-guarded, ~15 Hz)
    if ((this.titleT -= dt) <= 0) {
      this.titleT = 1 / 15;
      const n = L.length, i = Math.max(0, L.indexOf(this.cur)), cyc = n > 1 ? `${i + 1}/${n}` : '';
      if (this.cycN.textContent !== cyc) { this.cycN.textContent = cyc; this.cycEl.disabled = n < 2; }
      if (this.mode === 'live' && this.cur) {
        const I = this.info(this.cur), t = I.name, nm = I.num ? `#${pad2(I.num)}` : ''; if (this.titleEl.textContent !== t) this.titleEl.textContent = t; if (this.numEl.textContent !== nm) this.numEl.textContent = nm;
        this.osdText(I);
      } else if (this.mode === 'lost') this.rxLine(0, 0, null, null);
      this.el.classList.toggle('lost', this.mode === 'lost');
      this.osd.style.visibility = this.mode === 'live' && !(this.noise > 0.7 && Math.random() < this.noise - 0.55) && this.brkA < 0.8 ? '' : 'hidden';   // the OSD is keyed into the drone's video: it breaks up with it
      if ((this.rectT -= 1 / 15) <= 0) { this.rectT = 0.25; this.readRect(); }
    }
  }
  standby() {
    this.el.classList.add('standby'); this.titleEl.textContent = 'FPV feed'; this.numEl.textContent = ''; this.osdC.clear();
    const R = this.rx; R.ch.textContent = 'SCAN'; R.sig.dataset.n = '0'; R.lq.textContent = '--'; R.v.textContent = '--'; R.cell.style.setProperty('--b', '0%'); R.rec.textContent = '00:00'; R.bat.classList.remove('low'); this._rxv = null;
  }
  setPill(n) {   // n < 0: no tab; 0: the tab, no drone up; n: drones in the air
    if (n !== this._pn) { this._pn = n; this.pill.classList.toggle('hidden', n < 0); this.pill.classList.toggle('idle', n === 0); this.pillN.textContent = n > 1 ? String(n) : ''; }
  }
  // flight telemetry: the Betaflight OSD in the picture + the receiver's status line in the bezel (DOM writes guarded)
  osdText(I) {
    const fv = this.cur._fv, ground = this.g.city?.terrain?.heightAt?.(I.pos.x, I.pos.z) || 0, alt = Math.max(0, I.pos.y - ground);
    const sp = I.vel.length() * 3.6, dist = I.pos.distanceTo(I.tgt), bat = Math.max(4, Math.round(100 - I.age * 0.55 - (fv?.dive || 0) * 3));
    const lq = Math.max(0, Math.min(99, Math.round((1.08 - this.noise) * 100))), m = Math.floor(I.age / 60), s = Math.floor(I.age % 60);
    const volt = (18.6 + 6.4 * bat / 100 - (fv?.dive || 0) * 0.9).toFixed(1), time = `${pad2(m)}:${pad2(s)}`;   // 6S Li-ion pack, sagging in the dive
    const warn = lq < 35 ? 'RSSI LOW' : bat < 22 ? 'LOW BATTERY' : '';
    this.osdC.draw({ lq: pad2(lq), rssi: `-${Math.round(52 + this.noise * 50)}`, time, volt, mah: String(Math.round((100 - bat) * 78)), alt: String(Math.round(alt)), spd: String(Math.round(sp)),
      dst: String(dist < 100 ? Math.round(dist) : Math.round(dist / 5) * 5), name: I.num ? `FPV ${pad2(I.num)}` : 'FPV', roll: fv?.roll || 0, pitch: (fv?.pitch || 0) - UPTILT, warn: warn && Math.floor(this.clock * 2.5) % 2 ? warn : '' });
    this.rxLine(lq, bat, volt, time, I.num);
  }
  rxLine(lq, bat, volt, time, num) {
    const R = this.rx, ch = num ? `R${(num - 1) % 8 + 1} ${RACEBAND[(num - 1) % 8]}` : null, n = lq <= 0 ? 0 : lq < 35 ? 1 : lq < 60 ? 2 : lq < 85 ? 3 : 4;
    const k = `${lq}|${bat}|${volt}|${time}|${ch}`; if (k === this._rxv) return; this._rxv = k;
    if (ch) R.ch.textContent = ch;
    R.sig.dataset.n = String(n); R.lq.textContent = lq > 0 ? String(lq) : '0';
    if (volt != null) { R.v.textContent = `${volt}V`; R.cell.style.setProperty('--b', `${bat}%`); R.bat.classList.toggle('low', bat < 22); }
    if (time != null) R.rec.textContent = time;
  }
  // flight camera + link quality for drone d
  track(d, I, dt) {
    const g = this.g, fv = d._fv ||= { yaw: 0, pitch: 0, roll: 0, yawRate: 0, dive: 0, init: false, spin: 0 };
    const gdt = g.paused || g.over ? 0 : Math.min(dt, 0.05) * (g.timeScale || 1), v = I.vel, hs = Math.hypot(v.x, v.z), fall = I.phase === 'fall';
    if (!fv.init) { fv.init = true; fv.yaw = hs > 0.5 ? Math.atan2(v.x, v.z) : (g.squads.find(q => q.support?.drone === d)?.effective[0]?.heading || 0); fv.pitch = 0.2; }
    if (fall && !fv.spin) fv.spin = (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 5);
    // terminal dive: the pilot points the airframe (and so the camera) at the aim point
    const ax = I.tgt.x - I.pos.x, ay = I.tgt.y - I.pos.y, az = I.tgt.z - I.pos.z, ah = Math.hypot(ax, az), aimed = I.phase === 'dive' && !I.jam;
    const yawT = fall ? fv.yaw + fv.spin * gdt * 4 : aimed && ah > 0.5 ? Math.atan2(ax, az) : hs > 0.8 ? Math.atan2(v.x, v.z) : fv.yaw;
    const step = wrapA(yawT - fv.yaw) * (1 - Math.exp(-gdt * (fall ? 30 : aimed ? 9 : 7))); fv.yaw = wrapA(fv.yaw + step);
    if (gdt > 0) fv.yawRate += (step / gdt - fv.yawRate) * (1 - Math.exp(-gdt * 8));
    fv.dive += ((I.phase === 'dive' ? 1 : 0) - fv.dive) * (1 - Math.exp(-gdt * 5));
    // racing frame: the body pitches forward with speed, the camera is tilted up 25 deg on it; in the dive the pilot
    // holds the target in the middle of the picture (the camera looks along the flight path)
    const velP = Math.atan2(v.y, Math.max(0.1, hs)), tilt = Math.min(1.15, hs / 30) * 0.68;
    const diveP = aimed ? Math.atan2(ay, Math.max(0.5, ah)) : velP;
    let pitchT = UPTILT - tilt + Math.max(0, velP) * 0.18 + Math.min(0, velP) * 0.3; pitchT = Math.min(0.42, pitchT + (diveP - pitchT) * fv.dive);
    let rollT = THREE.MathUtils.clamp(Math.atan(hs * fv.yawRate / 9.8), -0.85, 0.85) * (1 - 0.6 * fv.dive);   // coordinated turn: bank into it (less once lined up on the target)
    if (fall) { pitchT = -0.5 + Math.sin(g.time * 6.3) * 0.7; rollT = fv.roll + fv.spin * gdt * 2.5; }
    fv.pitch += (pitchT - fv.pitch) * (1 - Math.exp(-gdt * (aimed ? 8 : 5))); fv.roll += (rollT - fv.roll) * (1 - Math.exp(-gdt * (fall ? 20 : 6)));
    // frame resonance / prop wash: incommensurate sines on game time (frozen while paused), stronger at speed and diving
    const T = g.time, vib = 0.0022 + Math.min(1, hs / 34) * 0.0035 + fv.dive * 0.004 + (fall ? 0.02 : 0);
    const vp = (Math.sin(T * 53.1) * 0.6 + Math.sin(T * 31.7 + 1.3) * 0.4 + Math.sin(T * 7.3) * 0.7) * vib, vr = (Math.sin(T * 47.9 + 0.7) * 0.6 + Math.sin(T * 23.3) * 0.5 + Math.sin(T * 5.1 + 2) * 0.8) * vib;
    const c = this.cam, ground = g.city?.terrain?.heightAt?.(I.pos.x, I.pos.z) || 0;
    c.position.set(I.pos.x, Math.max(ground + 0.25, I.pos.y), I.pos.z);
    c.rotation.set(fv.pitch + vp, fv.yaw + Math.PI, fv.roll + vr);
    // ---- link quality: range from the pilot, line of sight, low and far, enemy jammers, jammed dive, last metres
    let n = 0.05;
    const dP = I.pilot ? Math.hypot(I.pos.x - I.pilot.x, I.pos.z - I.pilot.z) : 0; n += sstep(400, 1150, dP) * 0.45;
    if ((this.losT -= dt) <= 0 && I.pilot) { this.losT = 0.3; const o = g.nav?.occluded?.(I.pilot.x, 1.7, I.pilot.z, I.pos.x, I.pos.y, I.pos.z, null, null); this.losW = o ? (o.foliage || o.smokeUntil ? 0.12 : 0.38) : 0; }
    this.losK += ((this.losW || 0) - this.losK) * Math.min(1, dt * 4); n += this.losK;
    n += (1 - sstep(3, 16, I.pos.y - ground)) * sstep(180, 600, dP) * 0.25;
    const foe = I.side === 'player' ? 'enemy' : 'player';
    let ew = 0; for (const u of g.vehicles) if (u.side === foe && !u.destroyed && u.kits?.includes('ew')) { const k = 1 - sstep(40, 260, u.pos.distanceTo(I.pos)); if (k > 0) ew += k; }
    const jamMod = g.mods?.[foe]?.ewJam || 0, dT = I.pos.distanceTo(I.tgt); ew += Math.min(0.6, jamMod * 3) * (1 - sstep(60, 260, dT));
    if (I.jam) ew += 0.4 + sstep(60, 10, dT) * 0.5;   // the pilot's link is being jammed: this dive goes wide
    this.hum = Math.min(1, ew); n += Math.min(0.75, ew * 0.7);
    if (I.phase === 'dive') n += (1 - sstep(1.5, 9, dT)) * 0.22;   // multipath in the last metres
    if (fall) n += 0.4;
    n = Math.min(1, n); this.noise += (n - this.noise) * Math.min(1, dt * 3);
    // brief breakups: frozen frame, tearing, sometimes a vertical roll
    if ((this.brkT -= dt) <= 0) {
      this.brkA = 0; const nn = this.noise;
      if (Math.random() < dt * (0.04 + nn * nn * 2.4 + (nn > 0.8 ? 2 : 0))) { this.brkT = 0.05 + Math.random() * 0.25 * (0.4 + nn); this.brkA = 0.35 + Math.random() * 0.65; this.tearY = Math.random(); this.rollV = Math.random() < nn * 0.6 ? (Math.random() - 0.5) * 4 : 0; }
    }
    if (this.brkT <= 0) this.rollV = 0;
    this.roll = this.rollV ? this.roll + this.rollV * dt : this.roll * Math.max(0, 1 - dt * 12);
  }
  stats() { const S = this.st; return { renders: S.renders, composites: S.composites, cpuMsAvg: S.n ? +(S.ms / S.n).toFixed(2) : 0, cpuMsMax: +S.msMax.toFixed(2), newPrograms: S.newPrograms || 0, calls: S.calls, tris: S.tris, mode: this.mode, visible: !!this.visible, noise: +this.noise.toFixed(2), lostT: this.lostT }; }
  // ---------------------------------------------------------------- render (after the main post chain)
  render(dt) {
    this.cpuMs = 0; if (!this.visible || this.mode === 'off') return;
    const t0 = performance.now(), u = this.mat.uniforms;
    this.acc += dt;
    if (this.mode === 'live' && (!this.rtOk || (this.acc >= 1 / FPS - 0.004 && this.brkA < 0.6))) { this.acc = 0; this.renderScene(); }   // (a breakup freezes the last frame)
    u.time.value = this.clock; u.frame.value = Math.floor(this.clock * FPS);
    if (this.mode === 'lost') {
      const t = this.lostT; u.snow.value = t < LOST_STATIC ? 1 : 0.2; u.dark.value = t < LOST_STATIC ? 0 : 0.9; u.brk.value = t < LOST_STATIC ? 1 - t / LOST_STATIC : 0; u.roll.value = t < LOST_STATIC ? t * 1.7 : 0; u.noise.value = 1;
    } else {
      u.noise.value = this.noise; u.brk.value = this.brkT > 0 ? this.brkA : 0; u.roll.value = this.roll; u.tearY.value = this.tearY; u.hum.value = this.hum || 0;
      u.snow.value = !this.rtOk ? 1 : this.noise > 0.85 && Math.random() < (this.noise - 0.85) * 4 ? 0.85 : 0; u.dark.value = 0;
    }
    this.composite();
    const ms = performance.now() - t0; this.cpuMs = ms; const S = this.st; S.ms += ms; S.n++; S.msMax = Math.max(S.msMax, ms);
  }
  renderScene() {
    const g = this.g, R = g.renderer, r = R.r, scene = g.scene, cam = this.cam, d = this.cur;
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    this.frus.setFromProjectionMatrix(this.pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const hid = this._hid ||= [], shown = this._shown ||= []; hid.length = 0; shown.length = 0;
    const hide = o => { if (o && o.visible) { o.visible = false; hid.push(o); } };
    // HUD overlays and the airframe itself
    const H = g.hud; if (H) { hide(H.ringMesh); hide(H.vRing); hide(H.orderLines); hide(H.fireLines); hide(H.preview); hide(H._gm); }
    for (const o of g.objectives || []) hide(o.ring);
    for (const m of g.zoneMeshes || []) hide(m);
    if (d && !d.net) hide(d.mesh); else for (const m of g._dr || []) if (m.visible && m.position.distanceToSquared(cam.position) < 4) hide(m);
    if ((this.ovT = (this.ovT || 0) - 1) <= 0) { this.ovT = 15; this.ov = scene.children.filter(o => o.geometry?.type === 'RingGeometry'); }   // ground rings: last-known positions, fire missions, area fire
    for (const o of this.ov) hide(o);
    // soldiers the main camera culled but the drone sees (full-rate animation next frame too)
    const sph = this.sph, cp = cam.position;
    for (const sq of g.squads) for (const s of sq.soldiers) {
      if (s.root.visible || !s.visible || (s.inside === 'btr' && !s.inCab) || (s.state === 'evac' && !s.onBed)) continue;
      const dx = s.pos.x - cp.x, dz = s.pos.z - cp.z; if (dx * dx + dz * dz > 220 * 220) continue;   // (beyond ~220 m a man is a couple of pixels in the 480 px feed)
      sph.center.set(s.pos.x, s.pos.y + 0.9, s.pos.z); if (!this.frus.intersectsSphere(sph)) continue;
      s.root.visible = true; s.inView = true; shown.push(s.root);
    }
    // coarser instanced LODs for a point above the drone; the main camera's set comes back right after
    const lp = this.lodP.set(cp.x, cp.y + 80, cp.z); updateLods(lp);
    // small clutter with a cull distance (crop clumps, weeds, rubble...) at half of it: the bulk of the triangles low over a field
    for (const L of LODS) { if (L.state >= 3 || !(L.d2 < 1e8)) continue; const dd = Math.hypot(lp.x - L.cx, lp.z - L.cz, lp.y * 0.6) - (L.hr ?? 45); if (dd > L.d2 * 0.5) { for (const m of L.near) hide(m); if (L.mid) for (const m of L.mid) hide(m); for (const m of L.far) hide(m); } }
    const fog = scene.fog, fd = fog?.density; if (fog && fd != null) fog.density = Math.max(fd, FOG);
    const sm = r.shadowMap, au = sm.autoUpdate, nu = sm.needsUpdate, prev = r.getRenderTarget(), ac = r.autoClear;
    sm.autoUpdate = false; sm.needsUpdate = false;
    const np = r.info.programs?.length || 0, c0 = r.info.render.calls, t0 = r.info.render.triangles, ar = r.info.autoReset; r.info.autoReset = false;
    try { r.setRenderTarget(this.rt); r.autoClear = true; r.render(scene, cam); this.rtOk = true; this.st.renders++; this.dbg?.(cam); this.st.newPrograms = (this.st.newPrograms || 0) + (r.info.programs?.length || 0) - np; this.st.calls = r.info.render.calls - c0; this.st.tris = r.info.render.triangles - t0; }
    finally {
      if (fog && fd != null) fog.density = fd;
      r.info.autoReset = ar; r.setRenderTarget(prev); r.autoClear = ac; sm.autoUpdate = au; sm.needsUpdate = nu;
      for (const o of hid) o.visible = true; for (const o of shown) o.visible = false;
      updateLods(R.camera.position);   // (after the restore: cells whose state differs flip back to the main camera's set)
    }
  }
  composite() {
    const r = this.g.renderer.r, R = this.rect; if (!R || R.w < 8) return;
    r.getViewport(this.vp); r.getScissor(this.sc); const st = r.getScissorTest(), ac = r.autoClear, prev = r.getRenderTarget();
    r.setRenderTarget(null); r.autoClear = false;
    const y = R.H - R.y - R.h; r.setViewport(R.x, y, R.w, R.h); r.setScissor(R.x, y, R.w, R.h); r.setScissorTest(true);
    try { this.quad.render(r); this.st.composites++; }
    finally { r.setScissorTest(st); r.setViewport(this.vp); r.setScissor(this.sc); r.autoClear = ac; r.setRenderTarget(prev); }
  }
}
