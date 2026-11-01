import fs from 'fs';
// Headless ragdoll test (node, no browser): skeleton from soldier_anims.glb, a death clip, hand-off, synthetic terrain; prints the
// pelvis / head path, settle time and deviation from the clip's rest pose.
//   node tools/blender/soldiers/ragdoll_sim.mjs '' <clip> <flat|trench|trenchF|lip|slope|heap> '{"early":1,"blast":0.9,"at":0.3}'
const R = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const THREE = await import(R + '/node_modules/three/build/three.module.js');
const { GLTFLoader } = await import(R + '/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
const { Ragdoll, samplePose } = await import(R + '/src/game/ragdoll.js');
const buf = fs.readFileSync(process.argv[2] || R + '/assets/soldiers/soldier_anims.glb');
const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej));
const clipName = process.argv[3] || 'death_fall_back', terrain = process.argv[4] || 'flat', opts = JSON.parse(process.argv[5] || '{}');
const ground = {
  flat: () => 0,
  trench: (x, z) => (Math.abs(z + (opts.tz ?? 0.6)) < 0.45 ? -1.6 : Math.abs(z + (opts.tz ?? 0.6)) < 0.8 ? -1.6 + (Math.abs(z + (opts.tz ?? 0.6)) - 0.45) / 0.35 * 1.6 : 0),   // trench along x behind him
  slope: (x, z) => -z * 0.5,
  lip: (x, z) => { const d = Math.abs(z + 0.75); return d < 0.4 ? -1.5 : d < 0.55 ? -1.5 + (d - 0.4) / 0.15 * 1.5 : 0; },
  trenchF: (x, z) => { const d = Math.abs(z - 1.1); return d < 0.4 ? -1.6 : d < 0.75 ? -1.6 + (d - 0.4) / 0.35 * 1.6 : 0; },          // downhill behind him (27 deg)
  heap: (x, z) => Math.max(0, 1.8 - Math.hypot(x, z - 1.2) * 0.75),
}[terrain];
const root = new THREE.Group(); const model = gltf.scene; root.add(model);
const y0 = ground(0, 0); root.position.set(0, y0, 0); root.updateMatrixWorld(true);
const mixer = new THREE.AnimationMixer(model);
const clip = gltf.animations.find(c => c.name === clipName); if (!clip) { console.log('no clip', clipName); process.exit(1); }
const a = mixer.clipAction(clip); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play();
const ev = JSON.parse(fs.readFileSync(R + '/assets/soldiers/manifest.json')).soldier_anims.clips[clipName].events || {};
const hips = model.getObjectByName('Hips');
let t = 0, dt = 1 / 60, rd = null, prev = null, cur = null, at = opts.at ?? ev.ragdoll ?? 1.0;
const log = [];
const hp = () => { const v = hips.getWorldPosition(new THREE.Vector3()); return v; };
while (t < at) {
  mixer.update(dt); t += dt; root.updateMatrixWorld(true);
  const h = hp();
  if (opts.early && t > 0.3 && Math.abs(ground(h.x, h.z) - y0) > 0.25) break;
  prev = cur; cur = samplePose(model);
}
console.log(clipName, terrain, 'hand-off at', t.toFixed(2), 'pelvis v', prev ? cur[0].clone().sub(prev[0]).multiplyScalar(1 / dt).toArray().map(v => +v.toFixed(2)) : null);
const o = { ground, start: samplePose(model), prev, prevDt: dt, drive: opts.drive ?? 0.03 };
if (opts.blast) { const k = opts.blast; o.impulse = new THREE.Vector3(0, 0, -(1 + 2 * k)).setY(0.4 + k); o.spin = new THREE.Vector3(1, 0, 0).multiplyScalar(-3 * k * -1); o.spin = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1)).multiplyScalar(3 * k); o.drive = 0.015; }
if (opts.push) o.push = new THREE.Vector3(0, 0, -0.9);
rd = new Ragdoll(model, o);
a.time = clip.duration; mixer.update(0); const END = samplePose(model).map(v => v.clone()); rd.setTarget(END); rd.writeBones();
const P0 = rd.p[0].clone();
let k = 0;
while (!rd.asleep && t < 10) { rd.update(dt); t += dt; if (++k % 15 === 0) { const P = rd.p; log.push(`${t.toFixed(2)} pel(${P[0].x.toFixed(2)},${P[0].y.toFixed(2)},${P[0].z.toFixed(2)}|g${ground(P[0].x, P[0].z).toFixed(2)}) head(${P[8].x.toFixed(2)},${P[8].y.toFixed(2)},${P[8].z.toFixed(2)}|g${ground(P[8].x, P[8].z).toFixed(2)})`); } }
console.log(log.join('\n'));
console.log('pelvis moved', rd.p[0].distanceTo(P0).toFixed(2), 'max dev from clip end', Math.max(...rd.p.map((p, i) => p.distanceTo(END[i]))).toFixed(2), 'pelvis dev', rd.p[0].distanceTo(END[0]).toFixed(2));
console.log('asleep at', t.toFixed(2), 'ragdoll time', rd.t.toFixed(2));
// sanity: every particle above ground - r, bone lengths
const bad = rd.p.map((p, i) => [i, +(p.y - ground(p.x, p.z)).toFixed(3)]).filter(([, d]) => d < -0.02);
console.log('below ground:', JSON.stringify(bad));
if (opts.dump) console.log(JSON.stringify(rd.p.map(p => p.toArray().map(v => +v.toFixed(3)))));
