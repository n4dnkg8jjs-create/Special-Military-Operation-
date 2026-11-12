import * as THREE from 'three';
import { twoBone, driveTwist } from './soldierPose.js';

// Seated men in the pickup's cab (casualty-evacuation truck, ATGM truck). They are drawn in the first frame of the cab exit clip,
// which is a man about to get out: head turned to his door, one hand at the handle (through the door skin), the other in the air.
// cabPose() runs after the mixer and puts that frame right for a man who is just riding:
//   * head and neck face the truck's nose (the driver looks a little into his turn, the others glance about slowly)
//   * the driver's hands grip the steering wheel's rim where the model has it (pickup.py: centre 0.42 m ahead of and 0.22 m above
//     the driver's H-point, rim radius 0.185 m, top leaning forward): palms on the rim, fingers and thumb closed round it. The
//     wheel is a node of its own (steer_wheel) and turns with the front wheels; the hands stay on their spots of the rim
//   * the others rest their hands on their thighs, palms down
// Bones' rest rotations are identity, so a bone's world quaternion turns rest-pose (model space) directions into world ones:
// the hands' fingers / palm axes below were read off the rest skeleton (hand -> finger joints, thumb on the inner side).
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const _q = new THREE.Quaternion(), _qp = new THREE.Quaternion(), _m = new THREE.Matrix4(), _c = V(), _e = new THREE.Euler();
const CURL = [1, -1].map(sd => { const F = V(0.27 * sd, -0.34, 0.90).normalize(), N = V(0, -1, 0); N.addScaledVector(F, -N.dot(F)).normalize(); return V().crossVectors(F, N).normalize(); });   /* fingers close about this (hand-local) axis */
const REST = [1, -1].map(sd => { const F = V(0.27 * sd, -0.34, 0.90).normalize(), N = V(0, -1, 0); N.addScaledVector(F, -N.dot(F)).normalize(); return new THREE.Matrix4().makeBasis(F, N, V().crossVectors(F, N)).transpose(); });
/* world quaternion of a hand whose fingers point along F and whose palm faces N (k: 0 left hand, 1 right) */
function handQ(F, N, k, out) {
  F.normalize(); N.addScaledVector(F, -N.dot(F)).normalize();
  return out.setFromRotationMatrix(_m.makeBasis(F, N, _c.crossVectors(F, N)).multiply(REST[k]));
}
function setWorldQ(bone, q) { bone.parent.getWorldQuaternion(_qp); bone.quaternion.copy(_qp.invert().multiply(q)); bone.updateMatrixWorld(true); }
function bones(s) {
  if (s._cabBones !== undefined) return s._cabBones;
  const N = n => s.model.getObjectByName(n);
  const r = { arm: [[N('LeftArm'), N('LeftForeArm'), N('LeftHand')], [N('RightArm'), N('RightForeArm'), N('RightHand')]], fing: [[N('LeftFingerBase'), N('LeftHandFinger1'), N('LThumb')], [N('RightFingerBase'), N('RightHandFinger1'), N('RThumb')]], leg: [[N('LeftUpLeg'), N('LeftLeg')], [N('RightUpLeg'), N('RightLeg')]], neck: N('Neck'), head: N('Head') };
  return (s._cabBones = r.arm.flat().every(Boolean) && r.leg.flat().every(Boolean) && r.neck && r.head ? r : null);
}

export const WHEEL = { fwd: 0.42, up: 0.22, r: 0.185, lean: 0.401, turn: 2.0 };   /* from ride_seat_1 (tools/blender/vehicles/pickup.py, steering wheel); turn = wheel angle per rad of road-wheel steer (shown, not the real ratio: the hands stay on) */
const _ax = V();
/* the wheel itself: about its column, anticlockwise for the driver in a left turn (steerA > 0) */
export function turnWheel(veh) {
  const n = veh._swN !== undefined ? veh._swN : (veh._swN = veh.model?.getObjectByName('steer_wheel') || null); if (!n) return 0;
  const a = THREE.MathUtils.clamp(veh.steerA || 0, -0.6, 0.6) * WHEEL.turn, ax = veh.vman?.steering_wheel?.axis;
  n.quaternion.setFromAxisAngle(ax ? _ax.fromArray(ax).normalize() : _ax.set(0, Math.sin(WHEEL.lean), -Math.cos(WHEEL.lean)), a);
  return a;
}

export function cabPose(s, veh, driver) {
  if (!s.model || veh.game.noRender || veh.game.camDist(s.pos) > 220) return;   /* (v1 stopped at 70 m: from an ordinary battle zoom the men sat in the raw exit frame - head to the door, hands out through the doors) */
  const b = bones(s); if (!b) return;
  const f = veh.fwd(V()), l = veh.left(V()), t = veh.game.time || 0, ph = s._cabPh ?? (s._cabPh = Math.random() * 6.283);
  s.model.updateMatrixWorld(true);
  // head: forward (+yaw = to the truck's left)
  const look = driver ? THREE.MathUtils.clamp((veh.steerA || 0) * 0.45, -0.3, 0.3) : Math.sin(t * 0.21 + ph) * 0.14 + Math.sin(t * 0.057 + ph * 2.3) * 0.1;
  setWorldQ(b.neck, _q.setFromEuler(_e.set(0.06, veh.heading + look * 0.5, 0, 'YXZ')));
  setWorldQ(b.head, _q.setFromEuler(_e.set(driver ? 0.02 : 0.05 + Math.sin(t * 0.13 + ph) * 0.03, veh.heading + look, 0, 'YXZ')));
  const hq = new THREE.Quaternion();
  if (driver) {
    const cs = Math.cos(WHEEL.lean), sn = Math.sin(WHEEL.lean);
    const up = V(0, cs, 0).addScaledVector(f, sn), n = V(0, sn, 0).addScaledVector(f, -cs);   /* rim 'up', and the wheel's axis toward the driver */
    const C = veh.wpos('ride_seat_1', V()).addScaledVector(f, WHEEL.fwd); C.y += WHEEL.up;
    const w = -THREE.MathUtils.clamp(veh.steerA || 0, -0.6, 0.6) * WHEEL.turn;   /* (the rim point under each hand turns with the wheel) */
    for (const k of [0, 1]) {
      const a = (k ? Math.PI - 0.38 : 0.38) + w, rad = V().addScaledVector(l, Math.cos(a)).addScaledVector(up, Math.sin(a));
      const P = C.clone().addScaledVector(rad, WHEEL.r);
      const F = V().addScaledVector(n, -0.72).addScaledVector(up, 0.62).addScaledVector(rad, -0.2), N = V().addScaledVector(rad, -0.65).addScaledVector(n, -0.6).addScaledVector(up, -0.3);
      handQ(F, N, k, hq);
      twoBone(b.arm[k][0], b.arm[k][1], b.arm[k][2], P.addScaledVector(F, -0.085).addScaledVector(N, -0.032), hq);
      const [fb, f1, th] = b.fing[k];
      if (fb) fb.quaternion.setFromAxisAngle(CURL[k], 1.05);
      if (f1) f1.quaternion.setFromAxisAngle(CURL[k], 1.25);
      if (th) th.quaternion.setFromAxisAngle(CURL[k], 0.55);
    }
  } else {
    for (const k of [0, 1]) {
      const U = b.leg[k][0].getWorldPosition(V()), K = b.leg[k][1].getWorldPosition(V()), d = K.clone().sub(U);
      const T = U.clone().addScaledVector(d, 0.56); T.y += 0.105;   /* on top of the thigh, a little short of the knee */
      const F = d.clone().normalize().addScaledVector(l, k ? 0.18 : -0.18), N = V(0, -1, 0);
      handQ(F, N, k, hq);
      twoBone(b.arm[k][0], b.arm[k][1], b.arm[k][2], T.addScaledVector(F, -0.06), hq);
    }
  }
  driveTwist(s);
}
