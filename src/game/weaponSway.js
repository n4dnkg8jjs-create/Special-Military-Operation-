import * as THREE from 'three';

// v9 held-weapon inertia ("physics when held"): a light procedural layer on top of the clip (and on top of soldierPose.js's recoil),
// only for men near the camera with the weapon in their hands:
//  - TURN LAG: the arms + weapon (the chest, Spine1) trail the body when he turns - a damped spring driven by his turn rate (yaw)
//    and, a little, by sideways acceleration (roll); overshoots a touch and settles when the turn stops
//  - START / STOP: forward acceleration pitches the weapon (muzzle lifts a little when he sets off, dips and swings back when he stops)
//  - GAIT BOB: a small extra nod / roll in step with the distance he covers (twice / once per stride), scaled by speed
//  - HOLD SWAY: slow breathing / muscle sway while standing or aiming (tiny, a few mrad)
// The offset is a world-space rotation of Spine1 about its joint (arms, weapon and the slung kit move together, the hands stay on the
// weapon); the neck takes most of it back so the head stays steady. Order per frame (soldier.js):
//   mixer.update -> swayPre (put Spine1 / Neck back to the clip pose if the mixer did not run this frame) -> poseTick (recoil) -> swayPost.
// Nothing accumulates: swayPre restores the clean clip rotations saved on the last mixed frame.
const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _pi = new THREE.Quaternion(), _ax = new THREE.Vector3(), _fw = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const SWAY = {   // per weapon class: spring frequency (Hz), damping, gains
  rifle: { hz: 2.6, zeta: 0.45, yaw: 0.09, pitch: 0.018, bob: 0.010, max: 0.075 },
  mg: { hz: 1.9, zeta: 0.5, yaw: 0.11, pitch: 0.024, bob: 0.013, max: 0.09 },        // PKM: heavier, slower, swings further
  launcher: { hz: 1.7, zeta: 0.5, yaw: 0.10, pitch: 0.02, bob: 0.012, max: 0.08 },
  pistol: { hz: 3.4, zeta: 0.5, yaw: 0.05, pitch: 0.01, bob: 0.006, max: 0.05 },
};
const AIMING = /^(aim_|peek_|fire_|pistol_aim|pistol_fire|pistol_crouch_aim|ride_aim|drone_shoot)/;

export function swayInit(s) {
  const m = s.model; if (!m || !s.mixer) return;
  const sp = m.getObjectByName('Spine1'), nk = m.getObjectByName('Neck');
  if (!sp || !nk) return;
  s.sw = { sp, nk, q0: new THREE.Quaternion(), n0: new THREE.Quaternion(), on: false, st: new Float32Array(6), h: s.heading, v: 0, vs: 0, ph: Math.random() * 6.28, t: Math.random() * 10 };
}

// before poseTick: undo last frame's offset if the mixer did not rewrite the bones this frame; save the clean clip pose when it did
export function swayPre(s, mixed) {
  const w = s.sw; if (!w) return;
  if (mixed) { w.q0.copy(w.sp.quaternion); w.n0.copy(w.nk.quaternion); w.on = false; }
  else if (w.on) { w.sp.quaternion.copy(w.q0); w.nk.quaternion.copy(w.n0); w.on = false; }
}

function spring(st, i, target, wn, zeta, dt) {
  const n = Math.max(1, Math.ceil(dt * 120)), h = dt / n;
  for (let k = 0; k < n; k++) { st[i + 1] += (-wn * wn * (st[i] - target) - 2 * zeta * wn * st[i + 1]) * h; st[i] += st[i + 1] * h; }
}
// rotate a bone about a world axis through its joint by ang (local rotation re-expressed through the parent's world rotation)
function rotWorld(o, axis, ang) {
  if (!ang) return;
  o.parent.getWorldQuaternion(_pq);
  _q.setFromAxisAngle(axis, ang);
  o.quaternion.premultiply(_pi.copy(_pq).invert().multiply(_q).multiply(_pq));
}

// after poseTick: step the springs (always, so a man walking into view does not start mid-swing) and apply when near
export function swayPost(s, dt, near) {
  const w = s.sw; if (!w || !(dt > 0)) return;
  dt = Math.min(dt, 0.1);
  const held = s.wSock === 'R' && !!s.weaponObj && s.weaponObj.visible !== false && !s.dropped && !s.launcherObj;
  const alive = s.state === 'ok' || s.state === 'light';
  const cls = s.weapon?.type === 'mg' ? 'mg' : s.weaponKey === 'pm' ? 'pistol' : /^rpg/.test(s.weaponKey) ? 'launcher' : 'rifle';
  const P = SWAY[cls], wn = 2 * Math.PI * P.hz, st = w.st;
  // turn rate, forward / sideways acceleration (world velocity in his frame)
  let dh = s.heading - w.h; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); w.h = s.heading;
  const om = THREE.MathUtils.clamp(dh / dt, -6, 6);
  const sh = Math.sin(s.heading), ch = Math.cos(s.heading), vx = s.vel?.x || 0, vz = s.vel?.z || 0;
  const vf = vx * sh + vz * ch, vs = vx * ch - vz * sh;
  const af = THREE.MathUtils.clamp((vf - w.v) / dt, -12, 12), as = THREE.MathUtils.clamp((vs - w.vs) / dt, -12, 12);
  w.v = vf; w.vs = vs;
  const aim = AIMING.test(s.curName || ''), k = held && alive ? (aim ? 0.6 : 1) : 0;      // aiming: braced, less swing
  const lim = P.max;
  spring(st, 0, THREE.MathUtils.clamp(-om * P.yaw * k, -lim, lim), wn, P.zeta, dt);                 // yaw lag (trails the turn)
  spring(st, 2, THREE.MathUtils.clamp(-af * P.pitch * k, -lim * 0.6, lim * 0.6), wn * 0.9, P.zeta, dt);   // pitch: + = muzzle down (about his left axis)
  spring(st, 4, THREE.MathUtils.clamp(as * P.pitch * 0.6 * k, -lim * 0.4, lim * 0.4), wn, P.zeta, dt);    // roll with sideways acceleration
  if (!near || !alive || (!k && Math.abs(st[0]) + Math.abs(st[2]) + Math.abs(st[4]) < 2e-4)) return;
  // gait bob and hold sway (added on top of the springs, not through them)
  const sp = Math.hypot(vx, vz);
  w.ph += sp * dt / 0.75 * Math.PI;                       // ~1.5 m stride: two nods per stride
  w.t += dt;
  const g = Math.min(sp / 3.5, 1) * k, still = (1 - Math.min(sp / 0.6, 1)) * k;
  const bobP = P.bob * g * Math.sin(w.ph * 2) + 0.0035 * still * Math.sin(w.t * 1.9) + (aim ? 0.0025 * still * Math.sin(w.t * 0.7 + 1.3) : 0);
  const bobY = P.bob * 0.6 * g * Math.sin(w.ph) + 0.003 * still * Math.sin(w.t * 1.3 + 0.4);
  const yaw = st[0] + bobY, pitch = st[2] + bobP, roll = st[4] + P.bob * 0.4 * g * Math.sin(w.ph + 0.8);
  if (Math.abs(yaw) + Math.abs(pitch) + Math.abs(roll) < 1e-4) return;
  const lat = _ax.set(ch, 0, -sh);                        // his left (model +X) in the world
  const fwd = _fw.set(sh, 0, ch);
  rotWorld(w.sp, _up, yaw); rotWorld(w.sp, lat, pitch); rotWorld(w.sp, fwd, roll);
  // the neck takes 75 % back: the head stays steady while arms and weapon swing
  rotWorld(w.nk, fwd, -roll * 0.75); rotWorld(w.nk, lat.set(ch, 0, -sh), -pitch * 0.75); rotWorld(w.nk, _up, -yaw * 0.75);
  w.on = true;
}
