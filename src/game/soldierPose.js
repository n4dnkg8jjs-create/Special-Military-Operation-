import * as THREE from 'three';

// v8 procedural pose layer, applied on top of the clip after each mixer update (soldier.js animate()):
//  - per-shot RECOIL, synchronised with the rounds actually fired (combat.js sets s.kick = 1 per round): a damped spring per channel
//    (muzzle flip = the right arm / rifle rotating up about the shoulder, chest rock = Spine + Spine1 pushed back, a little random
//    horizontal drift), per-weapon strength and frequency, scaled by stance (prone / bipod absorbs most of it). Bursts climb a little
//    because the next round comes before the last one has recovered (600-650 rpm vs ~0.15-0.2 s recovery), as with a real rifle.
//    Replaces the looping 0.133 s fire_* cycles, which ran at their own 7.5 Hz whatever the rate of fire was (one shot played as
//    2-3 kicks, a PKM burst as a rifle's) and cross-faded aim <-> fire every burst.
//  - SUPPORT-HAND IK: while the rifle moves with the recoil, the left hand is put back where the clip had it on the weapon
//    (two-bone analytic IK on LeftArm / LeftForeArm, hand orientation restored relative to the weapon): the hand stays on the
//    handguard instead of floating off it.
//  - DEATH perturbation: a hit jolt from the hit direction (chest knocked back / twisted / leaned away), loose spring flail of the
//    head and arms that dies out before the body lands, and a lasting random head turn - no two deaths of the same clip look alike.
//    Transient offsets decay to zero, so the authored ground contact of the clip's end pose is kept (ragdoll / restOnGround then
//    conform it to the terrain as before).
// Offsets are post-multiplied on the clip's local rotations of a few bones; the clean clip pose is snapshotted each frame and
// restored when the mixer has not run this frame (distant-soldier animation LOD), so nothing accumulates.

export const RECOIL = {   // peak muzzle flip / chest rock / random yaw (deg), spring frequency (Hz) and damping ratio
  ak74m: { flip: 2.6, rock: 1.4, yaw: 0.8, hz: 4.2, zeta: 0.6 },
  ak74o: { flip: 2.6, rock: 1.4, yaw: 0.8, hz: 4.2, zeta: 0.6 },
  ak12: { flip: 2.2, rock: 1.2, yaw: 0.6, hz: 4.6, zeta: 0.62 },             // better brake, lighter climb
  pkm: { flip: 3.4, rock: 2.0, yaw: 1.1, hz: 3.6, zeta: 0.55, bipod: 0.35 },  // 7.62x54R; prone on the bipod: mostly a shove
  pm: { flip: 9.0, rock: 0.7, yaw: 1.5, hz: 6.0, zeta: 0.6 },                 // pistol: wrist flip
  _: { flip: 2.6, rock: 1.4, yaw: 0.8, hz: 4.2, zeta: 0.6 },
};
const STANCE_K = { stand: [1, 1, 1], crouch: [0.9, 0.8, 0.9], prone: [0.6, 0.45, 0.7] };   // flip, rock, yaw
const AIMING = /^(aim_|peek_|fire_|pistol_aim|pistol_fire|pistol_crouch_aim|ride_aim|drone_shoot)/;
const D2R = Math.PI / 180;
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _pq = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3(), _ax = new THREE.Vector3(), _ax2 = new THREE.Vector3();
const _u = new THREE.Vector3(), _w = new THREE.Vector3(), _lat = new THREE.Vector3(), _tg = new THREE.Vector3(), _hq = new THREE.Quaternion(), _m = new THREE.Matrix4(), _UP = new THREE.Vector3(0, 1, 0);
const BONES = ['Spine', 'Spine1', 'Neck', 'Head', 'RightArm', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftShoulder', 'RightShoulder', 'LeftUpLeg', 'RightUpLeg'];

// impulse (rad/s) that gives a peak displacement of 1 rad for a spring of this frequency / damping
function peakGain(hz, zeta) {
  const w = 2 * Math.PI * hz, wd = w * Math.sqrt(1 - zeta * zeta), tp = Math.atan2(wd, zeta * w) / wd;
  return 1 / (Math.exp(-zeta * w * tp) * Math.sin(wd * tp) / wd);
}
// semi-implicit spring step (sub-stepped): state [x, v]
function spring(st, i, w, zeta, dt) {
  const n = Math.max(1, Math.ceil(dt * 240));
  const h = dt / n;
  for (let k = 0; k < n; k++) { st[i + 1] += (-w * w * st[i] - 2 * zeta * w * st[i + 1]) * h; st[i] += st[i + 1] * h; }
}

export function poseInit(s) {
  const m = s.model; if (!m || !s.mixer) return;
  const b = {}; for (const n of BONES) b[n] = m.getObjectByName(n);
  if (!b.Spine1 || !b.RightArm || !b.LeftArm || !b.LeftForeArm || !b.LeftHand) return;
  s.pl = { b, base: BONES.map(() => new THREE.Quaternion()), rc: new Float32Array(8), applied: false, death: null, synT: 0, relP: new THREE.Vector3(), relQ: new THREE.Quaternion() };
}

// one round fired: kick the recoil springs (per weapon, per stance)
export function poseShot(s, scale = 1) {
  const pl = s.pl; if (!pl) return;
  const R = RECOIL[s.weaponKey] || RECOIL._, k = STANCE_K[s.stance] || STANCE_K.stand, g = peakGain(R.hz, R.zeta) * D2R * scale;
  const bip = s.stance === 'prone' && R.bipod ? R.bipod : 1;
  const j = 0.8 + Math.random() * 0.4;     // round-to-round variation
  pl.rc[1] += R.flip * k[0] * bip * j * g;
  pl.rc[3] += R.rock * k[1] * (bip < 1 ? 0.8 : 1) * j * g;
  pl.rc[5] += R.yaw * k[2] * (Math.random() * 2 - 1) * g;
  // slow climb: a burst walks the muzzle up a little more with every round (the shooter can't fully recover at 10 rounds/s), it settles
  // back within ~0.5 s of the last one
  pl.rc[7] += CLIMB * R.flip * k[0] * bip * j * D2R * peakGain(CLIMB_HZ, 0.9) * scale;
}
const CLIMB = 0.22, CLIMB_HZ = 1.4;

// death: hit jolt + loose flail + lasting head turn. rel = hit bearing relative to his facing (0 = from the front, +PI/2 = from his
// left; null = unknown), power = damage, landT = clip time the trunk lands (events.body_ground)
export function poseDeath(s, rel, power, landT) {
  const pl = s.pl; if (!pl) return;
  const r = () => Math.random() * 2 - 1, k = THREE.MathUtils.clamp((power || 60) / 80, 0.6, 1.4);
  const fr = rel == null ? 0.5 : Math.cos(rel), sd = rel == null ? r() * 0.5 : Math.sin(rel);
  const S = (bone, ax, amp, hz, zeta) => ({ bone, ax: new THREE.Vector3(...ax).normalize(), x: 0, v: amp * D2R * peakGain(hz, zeta), w: 2 * Math.PI * hz, zeta });
  const end = THREE.MathUtils.clamp((landT || 0.8) + 0.15, 0.5, 1.4);
  pl.death = {
    t: 0, end,
    sp: [
      // chest knocked back (front hit) / forward (from behind), twisted and leaned away from a side hit
      S('Spine1', [1, 0, 0], -7 * fr * k, 2.2, 0.45), S('Spine1', [0, 1, 0], 10 * sd * k, 2.0, 0.4), S('Spine', [0, 0, 1], 4 * sd * k, 1.8, 0.45),
      // head lags the jolt, then lolls
      S('Neck', [1, 0, 0], (5 * fr + 4 * r()) * k, 1.6, 0.3), S('Head', [0, 1, 0], 9 * r(), 1.4, 0.3),
      // arms let go of the rifle and flail loose
      S('LeftArm', [r(), 0.2 * r(), r()], 10 + 8 * Math.random(), 1.6, 0.3), S('RightArm', [r(), 0.2 * r(), r()], 10 + 8 * Math.random(), 1.5, 0.3),
      S('LeftForeArm', [1, 0, 0.3 * r()], 12 * Math.random(), 2.0, 0.35), S('RightForeArm', [1, 0, 0.3 * r()], 12 * Math.random(), 2.0, 0.35),
    ],
    head: (Math.random() < 0.5 ? -1 : 1) * (8 + 20 * Math.random()) * D2R,   // lasting turn of the head (about its own up axis)
    // lasting splay of the limbs once he is down: upper arms / thighs swung about the WORLD vertical through the shoulder / hip joint,
    // i.e. along the ground - a limb lying on the ground stays on it (nothing lifted off or pushed into it)
    land: landT || 0.8, splay: [(4 + 22 * Math.random()) * D2R, (4 + 22 * Math.random()) * D2R, (2 + 10 * Math.random()) * D2R, (2 + 10 * Math.random()) * D2R],
  };
  if (!pl.b.RightForeArm) pl.b.RightForeArm = s.model.getObjectByName('RightForeArm');
  pl.rc.fill(0);
}

function snapshot(pl) { const b = pl.b; for (let i = 0; i < BONES.length; i++) { const o = b[BONES[i]]; if (o) pl.base[i].copy(o.quaternion); } if (b.RightForeArm) (pl.baseRF ||= new THREE.Quaternion()).copy(b.RightForeArm.quaternion); }
function restore(pl) { const b = pl.b; for (let i = 0; i < BONES.length; i++) { const o = b[BONES[i]]; if (o) o.quaternion.copy(pl.base[i]); } if (b.RightForeArm && pl.baseRF) b.RightForeArm.quaternion.copy(pl.baseRF); }
// rotate a bone by `ang` about a WORLD axis through its own joint
function rotWorld(o, axis, ang) {
  if (!ang) return;
  o.parent.getWorldQuaternion(_pq);
  _q.setFromAxisAngle(axis, ang); _q2.copy(_pq).invert().multiply(_q).multiply(_pq);
  o.quaternion.premultiply(_q2);
}
function rotLocal(o, axis, ang) { if (o && ang) o.quaternion.multiply(_q.setFromAxisAngle(axis, ang)); }

// analytic two-bone IK (shoulder a, elbow b, wrist c) to world target t, then the hand's world rotation set to hq
function twoBone(a, b, c, t, hq) {
  a.getWorldPosition(_a); b.getWorldPosition(_b); c.getWorldPosition(_c);
  const lab = _a.distanceTo(_b), lcb = _b.distanceTo(_c), lat = THREE.MathUtils.clamp(_a.distanceTo(t), 0.01, lab + lcb - 0.001);
  const ang = (x, y) => Math.acos(THREE.MathUtils.clamp(x.dot(y), -1, 1));
  const ca = _u.subVectors(_c, _a).normalize(), ba = _w.subVectors(_b, _a).normalize();
  const ac_ab0 = ang(ca, ba);
  const ab = _ax2.subVectors(_a, _b).normalize(), cb = _t.copy(_c).sub(_b).normalize();
  const ba_bc0 = ang(ab, cb);
  const ac_ab1 = Math.acos(THREE.MathUtils.clamp((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat), -1, 1));
  const ba_bc1 = Math.acos(THREE.MathUtils.clamp((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb), -1, 1));
  _ax.crossVectors(ca, ba); const l0 = _ax.length();
  if (l0 > 1e-5) {
    _ax.divideScalar(l0);
    a.getWorldQuaternion(_q3); _q.setFromAxisAngle(_ax, ac_ab1 - ac_ab0); a.quaternion.multiply(_q2.copy(_q3).invert().multiply(_q).multiply(_q3));
    b.getWorldQuaternion(_q3); _q.setFromAxisAngle(_ax, ba_bc1 - ba_bc0); b.quaternion.multiply(_q2.copy(_q3).invert().multiply(_q).multiply(_q3));
  }
  // swing the whole chain so the wrist points at the target
  a.updateMatrixWorld(true); c.getWorldPosition(_c);
  const ca2 = _u.subVectors(_c, _a).normalize(), ta = _w.copy(t).sub(_a).normalize();
  _ax.crossVectors(ca2, ta); const l1 = _ax.length();
  if (l1 > 1e-6) {
    _ax.divideScalar(l1);
    a.getWorldQuaternion(_q3); _q.setFromAxisAngle(_ax, Math.atan2(l1, ca2.dot(ta))); a.quaternion.multiply(_q2.copy(_q3).invert().multiply(_q).multiply(_q3));
  }
  a.updateMatrixWorld(true);
  if (hq) { b.getWorldQuaternion(_q3); c.quaternion.copy(_q3.invert().multiply(hq)); }
}

// per frame after the mixer (mixed = the mixer ran this frame); near = worth drawing the detail
export function poseTick(s, dt, mixed, near) {
  const pl = s.pl; if (!pl) return;
  // versus joiner: no per-round kick comes over the net - fire at the weapon's rate while the host says he is firing
  if (s.netClip && s.firingT > 0 && s.weapon?.rof) { pl.synT -= dt; if (pl.synT <= 0) { pl.synT = 60 / s.weapon.rof * (s.weapon.type === 'mg' ? 1 : 2 + Math.random() * 4); s.kick = 1; } }
  const aiming = AIMING.test(s.curName || '') && s.state !== 'dead';
  if (s.kick > 0) { if (aiming && !(s.launcherT > 0)) poseShot(s, Math.min(s.kick, 1.5)); s.kick = 0; }
  const R = RECOIL[s.weaponKey] || RECOIL._, w = 2 * Math.PI * R.hz, rc = pl.rc;
  for (let i = 0; i < 6; i += 2) spring(rc, i, w * (i === 4 ? 0.8 : 1), R.zeta, dt);
  spring(rc, 6, 2 * Math.PI * CLIMB_HZ, 0.9, dt);
  const rec = aiming && (Math.abs(rc[0]) + Math.abs(rc[2]) + Math.abs(rc[4]) + Math.abs(rc[6]) > 2e-4);
  const D = pl.death && s.state === 'dead' ? pl.death : null;
  if (D) { D.t += dt * (s.deathTs || 1); for (const p of D.sp) stepSp(p, dt * (s.deathTs || 1)); }
  if (pl.applied && !mixed) restore(pl);
  if ((!rec && !D) || !near) { pl.applied = false; return; }
  snapshot(pl);
  const b = pl.b;
  if (rec) {
    // support hand on the weapon, in the weapon's frame, before anything moves
    const wo = s.weaponObj, ik = !!wo && s.wSock === 'R' && wo.visible !== false && !s.dropped;
    if (ik) { wo.updateWorldMatrix(true, false); b.LeftHand.updateWorldMatrix(true, false); _m.copy(wo.matrixWorld).invert(); b.LeftHand.getWorldPosition(pl.relP).applyMatrix4(_m); wo.getWorldQuaternion(_q3); b.LeftHand.getWorldQuaternion(pl.relQ); pl.relQ.premultiply(_q3.invert()); }
    const lat = _lat.set(Math.cos(s.heading), 0, -Math.sin(s.heading));   // his left (model +X) in the world
    // chest rocks back (top toward -Z) and the muzzle climbs: both negative about +X; drift about the vertical
    rotWorld(b.Spine, lat, -rc[2] * 0.4); rotWorld(b.Spine1, lat, -rc[2] * 0.6); rotWorld(b.Spine1, _UP, rc[4]);
    if (b.Neck) rotWorld(b.Neck, lat, rc[2] * 0.45);                    // the head rides the stock, not the whole rock
    rotWorld(b.RightArm, lat, -(rc[0] + rc[6]));
    if (ik) {
      wo.updateWorldMatrix(true, false);
      _tg.copy(pl.relP).applyMatrix4(wo.matrixWorld); wo.getWorldQuaternion(_hq); _hq.multiply(pl.relQ);
      twoBone(b.LeftArm, b.LeftForeArm, b.LeftHand, _tg, _hq);
    }
  }
  if (D) {
    const env = 1 - THREE.MathUtils.smoothstep(D.t, D.end - 0.3, D.end), hk = THREE.MathUtils.smoothstep(D.t, 0.25, 1.3);
    for (const p of D.sp) { const o = b[p.bone]; if (o) rotLocal(o, p.ax, p.x * env); }
    rotLocal(b.Neck, _UP, D.head * 0.35 * hk); rotLocal(b.Head, _UP, D.head * 0.65 * hk);
    const sk = THREE.MathUtils.smoothstep(D.t, D.land + 0.05, D.land + 0.7);
    if (sk > 0) {
      const g = n => pl.b[n] || (pl.b[n] = s.model.getObjectByName(n)), L = [b.LeftArm, b.RightArm, b.LeftUpLeg, b.RightUpLeg];
      // (first frame: each limb swings OUTWARD - hand away from the pelvis, foot away from the other foot - not into the body)
      if (!D.out) D.out = L.map((o, i) => {
        if (!o) return 0;
        const end = g(['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'][i]), ref = g(['Hips', 'Hips', 'RightFoot', 'LeftFoot'][i]);
        if (!end || !ref) return 0;
        const d = () => { end.getWorldPosition(_a); ref.getWorldPosition(_b); return Math.hypot(_a.x - _b.x, _a.z - _b.z); };
        const d0 = d(); rotWorld(o, _UP, 0.1); const d1 = d(); rotWorld(o, _UP, -0.1); return d1 >= d0 ? 1 : -1;
      });
      for (let i = 0; i < 4; i++) if (L[i]) rotWorld(L[i], _UP, Math.abs(D.splay[i]) * D.out[i] * sk);
    }
  }
  pl.applied = true;
}
function stepSp(p, dt) {
  const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
  for (let k = 0; k < n; k++) { p.v += (-p.w * p.w * p.x - 2 * p.zeta * p.w * p.v) * h; p.x += p.v * h; }
}
