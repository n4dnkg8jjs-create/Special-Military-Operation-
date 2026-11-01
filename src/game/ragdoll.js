import * as THREE from 'three';

// Light procedural ragdoll for corpses ("in reason"): position-based dynamics (60 Hz, 4 iterations) on 19 joint particles of the
// soldier skeleton, no physics engine.  soldier.js hands the body over during the death clip (at its 'ragdoll' event, earlier when
// the ground under the falling body is uneven, at ~0.12 s with an impulse for blasts); the particles start where the animated
// joints are, moving with the clip's own velocity, plus a push / impulse / tumble from the hit.
//   - torso = two rigid clusters (pelvis: hips + lower back, chest: shoulders + neck + spine) joined by ranged distance
//     constraints (a little bend / twist, never folding); limbs are rigid segments
//   - joint limits: elbows + knees are hinges about tracked axes (no hyperextension, max flexion ~145-150 deg; the knee axis stays
//     within ~60 deg of the pelvis' lateral axis = hip rotation limit), hip cone (no leg behind the back / across the other), head
//     cone on the chest (no spinning heads: the head's twist always comes from the chest)
//   - limbs pushed out of the torso / thigh capsules (no limb through the body)
//   - ground = city.groundHeight per particle (cached; trench floors, parapets, rubble, slopes): vertical contact with Coulomb
//     friction on gentle ground, push-out along the height-field normal on steep faces (> ~35 deg) so a body slides down a trench
//     wall instead of hanging on it; a step up of > 0.35 m within one move is a wall: the particle is stopped instead of lifted;
//     limbs far above the pelvis (legs left on a lip) slip
//   - weak shape matching toward the clip's final (authored) rest pose, in the pelvis / chest frames, without adding velocity and
//     fading out by 2.2 s, so the body ends close to the authored pose where it can and bends to the terrain where it must
//   - damping rises once the body is down; asleep when the trunk moves < 1.5 cm in 0.35 s (or after 3 s): bones written once
//     more, then nothing runs per frame (frozen).  At most 8 awake; a new one may only end one that has settled > 1.4 s.
// The skeleton is driven back from the particles: torso / head bones from the cluster frames (delta to the hand-off pose),
// limb bones by minimal swing from the hand-off pose carried by their parent, hands / feet / fingers keep their locals.

const DT = 1 / 60, ITER = 4, MAX_ACTIVE = 8, SLEEP_T = 0.35, MAX_T = 3.0, WALL_STEP = 0.35;
const GRAV = -9.81, MU_S = 1.1, MU_K = 0.7;
// particle: [name, bone, radius, extra offset in the bone's hand-off frame (null = joint origin)]
const PART = [
  ['pelvis', 'Hips', 0.11], ['lback', 'Spine', 0.11], ['lhip', 'LeftUpLeg', 0.085], ['rhip', 'RightUpLeg', 0.085],
  ['chest', 'Spine1', 0.12], ['neck', 'Neck', 0.07], ['lsh', 'LeftArm', 0.06], ['rsh', 'RightArm', 0.06],
  ['head', 'Head', 0.1, [0, 0.085, 0.025]],
  ['lelb', 'LeftForeArm', 0.045], ['relb', 'RightForeArm', 0.045], ['lwr', 'LeftHand', 0.04], ['rwr', 'RightHand', 0.04],
  ['lknee', 'LeftLeg', 0.055], ['rknee', 'RightLeg', 0.055], ['lank', 'LeftFoot', 0.05], ['rank', 'RightFoot', 0.05],
  ['ltoe', 'LeftToeBase', 0.035], ['rtoe', 'RightToeBase', 0.035],
];
const PI = Object.fromEntries(PART.map((p, i) => [p[0], i]));
const PELVIS = ['pelvis', 'lback', 'lhip', 'rhip'], CHEST = ['chest', 'neck', 'lsh', 'rsh'];
// limb segments (rigid), then limited spans [a, b, minFactor, maxFactor] relative to the hand-off length
const SEG = [['lsh', 'lelb'], ['lelb', 'lwr'], ['rsh', 'relb'], ['relb', 'rwr'], ['lhip', 'lknee'], ['lknee', 'lank'], ['rhip', 'rknee'],
  ['rknee', 'rank'], ['lank', 'ltoe'], ['rank', 'rtoe'], ['neck', 'head']];
const SPAN = [['pelvis', 'chest', 0.94, 1.03], ['lhip', 'lsh', 0.9, 1.06], ['rhip', 'rsh', 0.9, 1.06], ['lhip', 'rsh', 0.92, 1.06], ['rhip', 'lsh', 0.92, 1.06],
  ['lback', 'neck', 0.95, 1.03], ['lknee', 'ltoe', 0.85, 1.12], ['rknee', 'rtoe', 0.85, 1.12]];
// self collision: limb particles vs torso / thigh capsules ([a, b, r])
const CAPS = [['pelvis', 'chest', 0.15], ['chest', 'neck', 0.12], ['lhip', 'lknee', 0.075], ['rhip', 'rknee', 0.075]];
const LIMB = { lelb: ['lhip', 'lknee'], relb: ['rhip', 'rknee'], lwr: [], rwr: [], lknee: ['rhip', 'rknee'], rknee: ['lhip', 'lknee'], lank: ['rhip', 'rknee'], rank: ['lhip', 'lknee'] };
// bones driven by a limb segment: bone -> [from particle, to particle, parent driver]
const LIMB_BONES = [['LeftArm', 'lsh', 'lelb'], ['LeftForeArm', 'lelb', 'lwr'], ['RightArm', 'rsh', 'relb'], ['RightForeArm', 'relb', 'rwr'],
  ['LeftUpLeg', 'lhip', 'lknee'], ['LeftLeg', 'lknee', 'lank'], ['LeftFoot', 'lank', 'ltoe'], ['RightUpLeg', 'rhip', 'rknee'], ['RightLeg', 'rknee', 'rank'],
  ['RightFoot', 'rank', 'rtoe']];

const active = [];
let STEPS = 0, STEP_MS = 0, GQ = 0;
export const ragdollStats = () => ({ active: active.length, steps: STEPS, ms: +STEP_MS.toFixed(1), msPerStep: STEPS ? +(STEP_MS / STEPS).toFixed(4) : 0, groundQueriesPerStep: STEPS ? +(GQ / STEPS).toFixed(1) : 0 });

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4();
const _X = new THREE.Vector3(), _Y = new THREE.Vector3(), _Z = new THREE.Vector3(), _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _t3 = new THREE.Vector3(), _t4 = new THREE.Vector3();

function frameQuat(a, b, c, d, out) {
  // orthonormal frame: x = a - b (left - right), y = c - d (up), z = x * y
  const x = _v.subVectors(a, b).normalize(), y = _w.subVectors(c, d);
  y.addScaledVector(x, -y.dot(x)).normalize();
  const z = _t4.crossVectors(x, y);
  _m.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_m);
}

export class Ragdoll {
  // model: the soldier's skinned scene; opt: { ground(x,z), impulse: Vector3 (m/s, whole body), push: Vector3 (m/s at the chest),
  //   spin: Vector3 (rad/s), prev: Map bone -> Vector3 world positions one frame earlier (velocity), prevDt, target: Map name ->
  //   Vector3 world positions of the clip's rest pose (shape matching), drive: stiffness, onSleep(rd) }
  constructor(model, opt) {
    this.model = model; this.opt = opt; this.ground = opt.ground; this.t = 0; this.still = 0; this.asleep = false; this.acc = 0;
    const B = this.bones = {}; model.traverse(o => { if (o.isBone) B[o.name] ||= o; });
    model.updateWorldMatrix(true, true);
    const n = PART.length;
    this.p = []; this.q = []; this.r = new Float32Array(n); this.inv = new Float32Array(n);
    const start = opt.start || samplePose(model);
    for (let i = 0; i < n; i++) {
      const nm = PART[i][0], r = PART[i][2];
      const p = start[i].clone();
      this.p.push(p); this.r[i] = r; this.inv[i] = /^(pelvis|chest|lback)$/.test(nm) ? 0.6 : /hip|sh|neck/.test(nm) ? 0.8 : 1;
    }
    // previous positions from the clip's last frame (velocity continuity) + impulses
    const pv = opt.prev, pdt = opt.prevDt || DT;
    this.q = this.p.map((p, i) => {
      const o = pv && pv[i] ? p.clone().sub(pv[i]).multiplyScalar(DT / pdt) : new THREE.Vector3();
      if (o.length() > 0.2) o.setLength(0.2);
      return p.clone().sub(o);
    });
    const c = this.p[PI.chest];
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3();
      if (opt.impulse) v.add(opt.impulse);
      if (opt.push) v.addScaledVector(opt.push, Math.max(0, 1 - this.p[i].distanceTo(c) / 0.9));
      if (opt.spin) v.add(_w.crossVectors(opt.spin, _v.subVectors(this.p[i], this.p[PI.pelvis])));
      this.q[i].addScaledVector(v, -DT);
    }
    // particles that start inside a wall (trench side / heap face: the clip played on flat ground) are pulled out toward the pelvis
    const pp = this.p[PI.pelvis];
    for (let i = 0; i < n; i++) {
      const p = this.p[i]; let g = this.ground(p.x, p.z);
      for (let k = 0; k < 6 && p.y < g - 0.12; k++) { p.x += (pp.x - p.x) * 0.35; p.z += (pp.z - p.z) * 0.35; g = this.ground(p.x, p.z); this.q[i].x = p.x; this.q[i].z = p.z; }
      // a joint the clip left a few cm under its own radius keeps that clearance (no pop at the hand-off)
      this.r[i] = Math.min(this.r[i], Math.max(0.02, p.y - g));
      if (p.y < g + this.r[i]) { p.y = g + this.r[i]; this.q[i].y = Math.min(this.q[i].y, p.y); }
    }
    // rest lengths
    const L = (a, b) => this.p[PI[a]].distanceTo(this.p[PI[b]]);
    this.rigid = [];
    for (const set of [PELVIS, CHEST]) for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) this.rigid.push([PI[set[i]], PI[set[j]], L(set[i], set[j])]);
    this.seg = SEG.map(([a, b]) => [PI[a], PI[b], L(a, b)]);
    this.span = SPAN.map(([a, b, lo, hi]) => { const l = L(a, b); return [PI[a], PI[b], l * lo, l * hi]; });
    this.thigh = { l: L('lhip', 'lknee'), r: L('rhip', 'rknee') };
    // hand-off pose for driving the bones back
    this.h0 = this.p.map(p => p.clone());
    this.Fp0 = frameQuat(this.p[PI.lhip], this.p[PI.rhip], this.p[PI.lback], this.p[PI.pelvis], new THREE.Quaternion());
    this.Fc0 = frameQuat(this.p[PI.lsh], this.p[PI.rsh], this.p[PI.neck], this.p[PI.chest], new THREE.Quaternion());
    this.wq0 = {}; this.lq0 = {};
    for (const [k, b] of Object.entries(B)) { this.wq0[k] = b.getWorldQuaternion(new THREE.Quaternion()); this.lq0[k] = b.quaternion.clone(); }
    // elbow / knee hinge axes (world, tracked): from the hand-off bend (positive flexion = the way the joint is bent now); a
    // straight joint gets the anatomical axis: elbow = chest -X (forearm swings forward), knee = pelvis +X (shin swings back)
    this.hinge = {};
    for (const [s, a, b, c, F, sg] of [['l', 'lsh', 'lelb', 'lwr', this.Fc0, -1], ['r', 'rsh', 'relb', 'rwr', this.Fc0, -1], ['kl', 'lhip', 'lknee', 'lank', this.Fp0, 1], ['kr', 'rhip', 'rknee', 'rank', this.Fp0, 1]]) {
      const u = _v.subVectors(this.p[PI[b]], this.p[PI[a]]).normalize(), f = _w.subVectors(this.p[PI[c]], this.p[PI[b]]).normalize();
      const h = new THREE.Vector3().crossVectors(u, f), ana = new THREE.Vector3(sg, 0, 0).applyQuaternion(F);
      // a bent joint defines its own axis unless that would be against the anatomical one (a hyper-extended clip pose)
      this.hinge[s] = h.lengthSq() > 0.006 && h.dot(ana) > -0.2 ? h.normalize() : ana;
    }
    // shape-matching targets in the pelvis (legs, trunk) / chest (arms, head) frames
    this.tgt = null;
    if (opt.target) this.setTarget(opt.target);
    this.drive = opt.drive ?? 0.03;
    this.core = PART.map(([nm]) => PELVIS.includes(nm) || CHEST.includes(nm));
    this.shapeW = PART.map(([nm]) => /wr|ank|toe|head/.test(nm) ? 1 : 0.6);
    active.push(this);
    while (active.length > MAX_ACTIVE) active[0].sleep();     // callers ask ragdollSlot() first: only a settled body is ever cut short
  }
  setTarget(T) {
    { const Fp = frameQuat(T[PI.lhip], T[PI.rhip], T[PI.lback], T[PI.pelvis], new THREE.Quaternion()), Fc = frameQuat(T[PI.lsh], T[PI.rsh], T[PI.neck], T[PI.chest], new THREE.Quaternion());
      const iFp = Fp.clone().invert(), iFc = Fc.clone().invert();
      this.tgt = PART.map(([nm], i) => {
        const arm = /sh|elb|wr|head|neck/.test(nm), o = arm ? T[PI.chest] : T[PI.pelvis];
        return { arm, v: T[i].clone().sub(o).applyQuaternion(arm ? iFc : iFp) };
      });
    }
  }
  // advance by dt (s); returns true while awake
  update(dt) {
    if (this.asleep) return false;
    const t0 = performance.now();
    this.acc = Math.min(this.acc + dt, DT * 3);
    while (this.acc >= DT) { this.acc -= DT; this.step(); STEPS++; }
    this.t += dt;
    // settled = the trunk (pelvis + chest) has moved < 1.5 cm over the last SLEEP_T s (limb jitter does not keep it awake)
    this.still += dt;
    if (this.still >= SLEEP_T) {
      const a = this.p[PI.pelvis], b = this.p[PI.chest], r = this._rest ||= [a.clone().addScalar(9), b.clone()];
      const mv = Math.max(a.distanceTo(r[0]), b.distanceTo(r[1]));
      r[0].copy(a); r[1].copy(b); this.still = 0;
      if (mv < 0.015 && this.t > 0.7) this.settled = true;
    }
    this.writeBones();
    STEP_MS += performance.now() - t0;
    if (this.settled || this.t > MAX_T) this.sleep();
    return !this.asleep;
  }
  step() {
    const P = this.p, Q = this.q, n = P.length, g = GRAV * DT * DT;
    const prevXZ = this._pxz ||= P.map(() => new THREE.Vector2());
    // damping: free flight keeps its momentum; once he has been down a moment the body loses energy fast (a limp body does
    // not rock, roll or creep about: it settles)
    const dmp = this.t < 0.5 ? 0.995 : Math.max(0.86, 0.995 - (this.t - 0.5) * 0.11);
    for (let i = 0; i < n; i++) {
      const p = P[i], q = Q[i];
      const vx = (p.x - q.x) * dmp, vy = (p.y - q.y) * 0.995, vz = (p.z - q.z) * dmp;
      q.copy(p); prevXZ[i].set(p.x, p.z);
      p.x += vx; p.y += vy + g; p.z += vz;
    }
    for (let it = 0; it < ITER; it++) {
      for (const [a, b, l] of this.rigid) this.dist(a, b, l, l, 1);
      for (const [a, b, l] of this.seg) this.dist(a, b, l, l, 1);
      for (const [a, b, lo, hi] of this.span) this.dist(a, b, lo, hi, 0.8);
      this.limits();
      this.collide();
      if (it === 1) this.groundPass(prevXZ);
    }
    // shape matching moves positions without adding velocity (q shifted too), then the ground has the last word
    if (this.tgt && this.drive > 0) this.shape();
    this.groundPass(prevXZ);
  }
  dist(a, b, lo, hi, k) {
    const pa = this.p[a], pb = this.p[b], d = _v.subVectors(pb, pa), l = d.length();
    if (l < 1e-6) return;
    const tl = l < lo ? lo : l > hi ? hi : l; if (tl === l) return;
    const wa = this.inv[a], wb = this.inv[b], s = (l - tl) / l / (wa + wb) * k;
    pa.addScaledVector(d, s * wa); pb.addScaledVector(d, -s * wb);
  }
  limits() {
    const P = this.p;
    const Fp = frameQuat(P[PI.lhip], P[PI.rhip], P[PI.lback], P[PI.pelvis], this._fp ||= new THREE.Quaternion());
    const X = _X.set(1, 0, 0).applyQuaternion(Fp), Yp = _Y.set(0, 1, 0).applyQuaternion(Fp), Z = _Z.set(0, 0, 1).applyQuaternion(Fp);
    // knees: tracked hinge (no hyperextension, flexion <= ~145 deg), the hinge kept within ~60 deg of the pelvis' lateral axis
    // (hip rotation limit: a knee can fall out to the side, it cannot point backwards); hip cone below
    for (const [hip, knee, ank, out, s] of [['lhip', 'lknee', 'lank', 1, 'kl'], ['rhip', 'rknee', 'rank', -1, 'kr']]) {
      const H = P[PI[hip]], K = P[PI[knee]], A = P[PI[ank]];
      const h = this.hinge[s], hx = h.dot(X);
      if (hx < 0.5) h.addScaledVector(X, 0.5 - hx);
      this.hingeClamp(H, K, A, h, 0.0, 2.5, 0.1);
      // hip cone in the pelvis frame: thigh no more than ~30 deg behind the trunk line, ~45 deg out, ~20 deg in
      const dir = _v.subVectors(K, H).normalize();
      const back = -dir.dot(Z), side = dir.dot(X) * out, down = -dir.dot(Yp);
      let fix = false;
      if (back > 0.5 && down > -0.2) { dir.addScaledVector(Z, back - 0.5); fix = true; }
      if (side > 0.72) { dir.addScaledVector(X, -(side - 0.72) * out); fix = true; }
      if (side < -0.34) { dir.addScaledVector(X, (-0.34 - side) * out); fix = true; }
      if (fix) { const L1 = H.distanceTo(K); K.copy(H).addScaledVector(dir.normalize(), L1); }
    }
    // elbows: tracked hinge axis, flexion 5..150 deg, never backwards
    for (const [s, sh, el, wr] of [['l', 'lsh', 'lelb', 'lwr'], ['r', 'rsh', 'relb', 'rwr']]) this.hingeClamp(P[PI[sh]], P[PI[el]], P[PI[wr]], this.hinge[s], 0.09, 2.6, 0.15);
    // head cone: within ~55 deg of the chest's up axis, ~35 deg forward of it at most backwards
    const Fc = frameQuat(P[PI.lsh], P[PI.rsh], P[PI.neck], P[PI.chest], this._fc ||= new THREE.Quaternion());
    const up = _t1.set(0, 1, 0).applyQuaternion(Fc), N = P[PI.neck], Hd = P[PI.head];
    const hd = _v.subVectors(Hd, N), hl = hd.length(); hd.divideScalar(hl);
    const c = hd.dot(up);
    if (c < 0.57) { const fwd = _t2.set(0, 0, 1).applyQuaternion(Fc); const perp = _t3.copy(hd).addScaledVector(up, -c).normalize(); hd.copy(up).multiplyScalar(0.57).addScaledVector(perp, 0.82); if (perp.dot(fwd) < -0.3) hd.copy(up).multiplyScalar(0.82).addScaledVector(perp, 0.57); Hd.copy(N).addScaledVector(hd.normalize(), hl); }
  }
  // hinge joint S-E-W about the tracked axis h: the distal point W is put back into the hinge plane with its flexion angle clamped to
  // [lo, hi]; a sideways pull twists the hinge a little (long-bone rotation) instead of being ignored
  hingeClamp(S, E, W, h, lo, hi, twist) {
    const u = _v.subVectors(E, S).normalize();
    h.addScaledVector(u, -h.dot(u)).normalize();
    const b = _t1.crossVectors(h, u), f = _w.subVectors(W, E), L2 = f.length();
    let ax = f.dot(u), fl = f.dot(b); const lat = f.dot(h);
    if (Math.abs(lat) > 1e-4) { h.addScaledVector(b, -lat / Math.max(L2, 1e-4) * twist).normalize(); b.crossVectors(h, u); ax = f.dot(u); fl = f.dot(b); }
    let a = Math.atan2(fl, ax); a = Math.min(Math.max(a, lo), hi);
    W.copy(E).addScaledVector(u, Math.cos(a) * L2).addScaledVector(b, Math.sin(a) * L2);
  }
  collide() {
    const P = this.p;
    for (const [nm, skip] of Object.entries(LIMB)) {
      const i = PI[nm], p = P[i], r = this.r[i];
      for (const [a, b, cr] of CAPS) {
        if (skip.includes(a) && skip.includes(b)) continue;
        if ((nm === 'lknee' || nm === 'lank') && a === 'lhip') continue;
        if ((nm === 'rknee' || nm === 'rank') && a === 'rhip') continue;
        const A = P[PI[a]], B = P[PI[b]], ab = _v.subVectors(B, A), l2 = ab.lengthSq();
        const t = l2 < 1e-8 ? 0 : Math.min(1, Math.max(0, _w.subVectors(p, A).dot(ab) / l2));
        const cx = A.x + ab.x * t, cy = A.y + ab.y * t, cz = A.z + ab.z * t;
        let dx = p.x - cx, dy = p.y - cy, dz = p.z - cz; const d = Math.hypot(dx, dy, dz), R = cr + r;
        if (d < R) { if (d < 1e-5) { dx = 0; dy = 1; dz = 0; } else { dx /= d; dy /= d; dz /= d; } const k = (R - d) * 0.8; p.x += dx * k; p.y += dy * k; p.z += dz * k; }
      }
    }
  }
  // ground height (and slope) under particle i, cached per particle: a body at rest costs no height-field queries; within 1.5 cm of
  // the cached point the height is extrapolated along the cached slope
  gq(i, x, z, grad) {
    const C = this.gc ||= { x: new Float32Array(PART.length).fill(1e9), z: new Float32Array(PART.length), g: new Float32Array(PART.length), gx: new Float32Array(PART.length), gz: new Float32Array(PART.length), hg: new Uint8Array(PART.length) };
    const dx = x - C.x[i], dz = z - C.z[i];
    if (dx < 0.015 && dx > -0.015 && dz < 0.015 && dz > -0.015 && (!grad || C.hg[i])) { this._gx = C.gx[i]; this._gz = C.gz[i]; return C.g[i] + (C.hg[i] ? C.gx[i] * dx + C.gz[i] * dz : 0); }
    const g = this.ground(x, z); GQ++;
    C.x[i] = x; C.z[i] = z; C.g[i] = g; C.hg[i] = 0; this._gx = this._gz = 0;
    if (grad) { C.gx[i] = this._gx = (this.ground(x + 0.06, z) - g) / 0.06; C.gz[i] = this._gz = (this.ground(x, z + 0.06) - g) / 0.06; C.hg[i] = 1; GQ += 2; }
    return g;
  }
  groundPass(prevXZ) {
    const P = this.p, Q = this.q;
    for (let i = 0; i < P.length; i++) {
      const p = P[i], r = this.r[i];
      let g = this.gq(i, p.x, p.z, false);
      if (p.y < g + r) {
        const px = prevXZ[i], g0 = Math.abs(px.x - p.x) + Math.abs(px.y - p.z) < 0.02 ? g : this.ground(px.x, px.y);
        if (g - g0 > WALL_STEP && p.y < g - 0.05) { // a wall: stop against it instead of climbing it
          p.x = px.x; p.z = px.y; Q[i].x = p.x; Q[i].z = p.z; g = g0;
          if (p.y >= g + r) continue;
        }
        // surface normal from the height field: on a steep face (trench wall, heap side, > ~35 deg) the body is pushed out along the
        // normal and slides down it - a vertical push would hold a limb up on a wall and leave the body hanging from it
        g = this.gq(i, p.x, p.z, true); const gx = this._gx, gz = this._gz, s2 = gx * gx + gz * gz;
        if (p.y >= g + r) continue;
        if (s2 > 0.5) {
          const il = 1 / Math.sqrt(1 + s2), d = (g + r - p.y) * il * il;     // normal depth * n.y: moves the point onto the plane
          p.x -= gx * d; p.z -= gz * d; p.y += d;
          continue;
        }
        const pen = g + r - p.y;
        p.y = g + r;
        // positional (Coulomb) friction against this step's sideways travel: the vertical projection on a slope / heap would
        // otherwise let a lying body creep downhill for ever; static below MU_S * penetration, else slowed by MU_K * penetration
        // a limb resting well above the pelvis (legs left on a trench lip / up a heap while the trunk hangs below) carries little
        // weight: it slips, so the body slides in and folds instead of hanging from its boots
        const hi = p.y - P[PI.pelvis].y, mu = hi > 0.3 ? Math.max(0.1, 1 - (hi - 0.3) / 0.3) : 1;
        { const px = prevXZ[i], tx = p.x - px.x, tz = p.z - px.y, tl = Math.hypot(tx, tz);
          if (tl > 1e-7) { const k = tl < MU_S * mu * pen ? 1 : Math.min(1, MU_K * mu * pen / tl); p.x -= tx * k; p.z -= tz * k; } }
        // friction: kill most of the sliding (static when slow)
        const vx = p.x - Q[i].x, vz = p.z - Q[i].z, vh = Math.hypot(vx, vz);
        const keep = mu < 1 ? 0.9 : vh < 0.004 ? 0 : 0.55;
        Q[i].x = p.x - vx * keep; Q[i].z = p.z - vz * keep;
        if (Q[i].y < p.y - 0.02) Q[i].y = p.y - 0.02;  // landing: almost no bounce
      }
    }
  }
  shape() {
    const P = this.p, T = this.tgt;
    const Fp = frameQuat(P[PI.lhip], P[PI.rhip], P[PI.lback], P[PI.pelvis], _q), Fc = frameQuat(P[PI.lsh], P[PI.rsh], P[PI.neck], P[PI.chest], _q2);
    const k = this.drive * Math.min(1, this.t / 0.5 + 0.3) * Math.max(0, 1 - this.t / 2.2);   // fades out: the terrain decides the end
    if (k <= 0) return;
    for (let i = 0; i < P.length; i++) {
      if (this.core[i]) continue;
      const tg = T[i], o = tg.arm ? P[PI.chest] : P[PI.pelvis];
      _v.copy(tg.v).applyQuaternion(tg.arm ? Fc : Fp).add(o);
      _w.copy(P[i]); P[i].lerp(_v, k * this.shapeW[i]);
      this.q[i].add(_w.subVectors(P[i], _w));
    }
  }
  // particles -> bones (world rotations), then locals
  writeBones() {
    const P = this.p, B = this.bones, W = {}, H = this.h0;
    const Fp = frameQuat(P[PI.lhip], P[PI.rhip], P[PI.lback], P[PI.pelvis], new THREE.Quaternion());
    const Fc = frameQuat(P[PI.lsh], P[PI.rsh], P[PI.neck], P[PI.chest], new THREE.Quaternion());
    const dP = Fp.multiply(this.Fp0.clone().invert()), dC = Fc.multiply(this.Fc0.clone().invert());
    const set = (k, q) => { W[k] = q; };
    set('Hips', dP.clone().multiply(this.wq0.Hips));
    for (const k of ['LHipJoint', 'RHipJoint']) if (this.wq0[k]) set(k, dP.clone().multiply(this.wq0[k]));
    if (this.wq0.LowerBack) set('LowerBack', dP.clone().slerp(dC, 0.3).multiply(this.wq0.LowerBack));
    if (this.wq0.Spine) set('Spine', dP.clone().slerp(dC, 0.65).multiply(this.wq0.Spine));
    for (const k of ['Spine1', 'Neck', 'LeftShoulder', 'RightShoulder']) if (this.wq0[k]) set(k, dC.clone().multiply(this.wq0[k]));
    // head: chest delta, then the swing that takes the carried neck->head direction onto the actual one
    {
      const d0 = _v.subVectors(H[PI.head], H[PI.neck]).normalize().applyQuaternion(dC), d1 = _w.subVectors(P[PI.head], P[PI.neck]).normalize();
      const sw = new THREE.Quaternion().setFromUnitVectors(d0, d1);
      for (const k of ['Neck1', 'Head']) if (this.wq0[k]) set(k, sw.clone().slerp(new THREE.Quaternion(), k === 'Neck1' ? 0.5 : 0).multiply(dC).multiply(this.wq0[k]));
    }
    // limbs top-down: child world = swing(carried hand-off dir -> actual dir) * (parent world now * hand-off local)
    const parentOf = { LeftArm: 'LeftShoulder', RightArm: 'RightShoulder', LeftForeArm: 'LeftArm', RightForeArm: 'RightArm', LeftUpLeg: 'LHipJoint', RightUpLeg: 'RHipJoint', LeftLeg: 'LeftUpLeg', RightLeg: 'RightUpLeg', LeftFoot: 'LeftLeg', RightFoot: 'RightLeg' };
    for (const [bn, a, b] of LIMB_BONES) {
      const par = parentOf[bn], pw = W[par] || W.Hips;
      const carried = pw.clone().multiply(this.lq0[bn]);                    // world rot if the bone kept its hand-off local
      const rel = carried.clone().multiply(this.wq0[bn].clone().invert());  // carried / hand-off
      const d0 = _v.subVectors(H[PI[b]], H[PI[a]]).normalize().applyQuaternion(rel), d1 = _w.subVectors(P[PI[b]], P[PI[a]]).normalize();
      set(bn, new THREE.Quaternion().setFromUnitVectors(d0, d1).multiply(carried));
    }
    // apply: locals from world rotations (parents first: the order above is top-down)
    this.model.updateWorldMatrix(true, false);
    const hips = B.Hips, hp = hips.parent;
    hp.updateWorldMatrix(true, false);
    const pq = hp.getWorldQuaternion(new THREE.Quaternion());
    hips.position.copy(P[PI.pelvis]); hp.worldToLocal(hips.position);
    const order = ['Hips', 'LHipJoint', 'RHipJoint', 'LowerBack', 'Spine', 'Spine1', 'Neck', 'Neck1', 'Head', 'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot'];
    const worldNow = { __root: pq };
    for (const k of order) {
      const b = B[k]; if (!b || !W[k]) continue;
      const parW = worldNow[b.parent?.name] || (b.parent === hp ? pq : null) || b.parent.getWorldQuaternion(new THREE.Quaternion());
      b.quaternion.copy(parW.clone().invert().multiply(W[k]));
      worldNow[k] = W[k];
    }
    // hands / feet children keep their locals; their world follows automatically
  }
  pelvisGround(out = new THREE.Vector3()) { const p = this.p[PI.pelvis]; return out.set(p.x, this.ground(p.x, p.z), p.z); }
  sleep() {
    if (this.asleep) return; this.asleep = true;
    const i = active.indexOf(this); if (i >= 0) active.splice(i, 1);
    this.writeBones();
    this.opt.onSleep?.(this);
  }
}

// particle positions of the current (animated) pose, world space (for velocity continuity / shape targets)
const BONES = new WeakMap();
export function samplePose(model, out) {
  let B = BONES.get(model);
  if (!B) { B = {}; model.traverse(o => { if (!B[o.name]) B[o.name] = o; }); BONES.set(model, B); }
  model.updateWorldMatrix(true, true);     // parents too: the soldier root may have moved since the last render
  out = out || PART.map(() => new THREE.Vector3());
  PART.forEach(([, bn, , off], i) => {
    const b = B[bn]; if (!b) return; b.getWorldPosition(out[i]);
    if (off) out[i].add(_v.fromArray(off).applyQuaternion(b.getWorldQuaternion(_q)));
  });
  return out;
}
export const RAGDOLL_MAX = MAX_ACTIVE;
// may a new ragdoll start?  A free slot, or the oldest active body has been settling for > 1.4 s (it is put to sleep - frozen
// where it lies, by then on the ground); otherwise no (the caller lets the death clip finish instead of freezing a body mid-air)
export function ragdollSlot() {
  if (active.length < MAX_ACTIVE) return true;
  const o = active[0]; if (o.t > 1.4) { o.sleep(); return true; }
  return false;
}
export const activeRagdolls = () => active.length;
