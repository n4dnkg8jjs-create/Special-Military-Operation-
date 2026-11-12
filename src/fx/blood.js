import * as THREE from 'three';

// Blood on the ground (the uniform already soaks and runs: soldierDamage.js). Kept small and dark, as it looks on earth and
// asphalt: no splashes, no bright red.
//   * a pool under a man who lies bleeding from a bullet / fragment wound: starts a few seconds after he is down, creeps out to
//     20-40 cm across over half a minute, stops when he is bandaged (state 'stable') or moved; a dead man's stops by itself
//   * a broken smear where a casualty is dragged or crawls: a short streak every ~0.6 m, thinning as it goes
// One instanced quad per mark (ring buffer of MAX), flat on the surface the man lies on (his own height: floors, trench beds),
// drawn with a polygon offset and no depth write so it neither flickers against the ground nor hides anything; marks darken
// from wet red-brown to dry brown over a few minutes.
const MAX = 240, SCAN = 0.4;
const WET = new THREE.Color(0x3d0b09), DRY = new THREE.Color(0x24100b);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color(), _up = new THREE.Vector3(0, 1, 0), _v = new THREE.Vector3();

function blobTexture() {
  const N = 128, c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d');
  let a = 7; const R = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  // a ragged pool: a core and lobes that ran along the ground's unevenness, soft thin rim
  const lobe = (cx, cy, r, al) => { const g = x.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, `rgba(255,255,255,${al})`); g.addColorStop(0.62, `rgba(255,255,255,${al * 0.92})`); g.addColorStop(0.86, `rgba(255,255,255,${al * 0.35})`); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.fill(); };
  lobe(64, 64, 34, 1);
  for (let i = 0; i < 9; i++) { const an = R() * 6.283, d = 14 + R() * 22; lobe(64 + Math.cos(an) * d, 64 + Math.sin(an) * d, 9 + R() * 15, 0.95); }
  for (let i = 0; i < 6; i++) { const an = R() * 6.283, d = 38 + R() * 14; lobe(64 + Math.cos(an) * d, 64 + Math.sin(an) * d, 3 + R() * 5, 0.8); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class BloodDecals {
  constructor(scene) {
    const g = new THREE.PlaneGeometry(1, 1); g.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ map: blobTexture(), color: 0xffffff, transparent: true, opacity: 0.86, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const m = this.mesh = new THREE.InstancedMesh(g, mat, MAX); m.count = 0; m.frustumCulled = false; m.renderOrder = 2; m.name = 'blood_decals';
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < MAX; i++) m.setColorAt(i, WET);
    scene.add(m);
    this.marks = []; this.next = 0; this.acc = 0; this.live = new Set();
  }
  // a mark: position, yaw, half-sizes now / wanted, growth rate, age
  add(x, y, z, yaw, w, l, w1 = w, l1 = l, rate = 0) {
    const i = this.next; this.next = (this.next + 1) % MAX; if (this.mesh.count < MAX) this.mesh.count++;
    const k = this.marks[i] = { i, x, y, z, yaw, w, l, w1, l1, rate, age: 0 };
    this.write(k); return k;
  }
  write(k) {
    this.mesh.setMatrixAt(k.i, _m.compose(_p.set(k.x, k.y, k.z), _q.setFromAxisAngle(_up, k.yaw), _s.set(k.w, 1, k.l)));
    this.mesh.setColorAt(k.i, _c.copy(WET).lerp(DRY, Math.min(1, k.age / 150)));
    this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  update(dt, game) {
    this.acc += dt; if (this.acc < SCAN) return; const step = this.acc; this.acc = 0;
    // growing pools, drying
    for (const k of this.marks) { if (!k) continue; k.age += step; if (k.rate > 0 && k.w < k.w1) { k.w = Math.min(k.w1, k.w + k.rate * step); k.l = Math.min(k.l1, k.l + k.rate * step * (k.l1 / k.w1)); this.write(k); } else if (k.age < 152 && (k.age % 12) < step) this.write(k); }
    const cam = game.cam?.focus;
    for (const sq of game.squads || []) for (const s of sq.soldiers) {
      const st = s.state; if (st !== 'critical' && st !== 'stable' && st !== 'dead') { if (s._bl) s._bl = null; continue; }
      if (s.inside || s.inCab || s.onBed || s.visible === false || s.lostInVeh) continue;
      if (!s.dmg?.wounds?.some(w => (w.blood || 0) > 0.3)) continue;           // (blast / burn casualties without an open wound: nothing runs)
      if (cam && Math.hypot(s.pos.x - cam.x, s.pos.z - cam.z) > 420) continue;
      const b = s._bl || (s._bl = { x: s.pos.x, z: s.pos.z, still: 0, pool: null, n: 0 });
      const dx = s.pos.x - b.x, dz = s.pos.z - b.z, d = Math.hypot(dx, dz), clip = s.curName || s.netClip || '';
      if (d > 0.55) {
        // moved: on the ground (dragged / crawling) it leaves a smear - thinner the further he has come; carried, nothing
        if (/^(being_dragged|wounded_crawl|drag_)/.test(clip) && b.n < 26 && Math.random() < 0.85 - b.n * 0.02) {
          const wd = (0.05 + Math.random() * 0.05) * (1 - b.n * 0.02);
          this.add(b.x + dx * 0.5 + (Math.random() - 0.5) * 0.08, s.pos.y + 0.012, b.z + dz * 0.5 + (Math.random() - 0.5) * 0.08, Math.atan2(dx, dz) + (Math.random() - 0.5) * 0.3, wd * 2, d * (0.7 + Math.random() * 0.5));
          b.n++;
        }
        b.x = s.pos.x; b.z = s.pos.z; b.still = 0; if (b.pool) { b.pool.rate = 0; b.pool = null; }
        continue;
      }
      b.still += step;
      if (b.pool) { if (st === 'stable') b.pool.rate = 0; continue; }           // bandaged: it stops
      if (b.still < 3 || st === 'stable' && b.pooled) continue;
      // under the wound: the chest / belly of a lying man is ~0.3-0.5 m from his root along his body
      let px = s.pos.x, pz = s.pos.z;
      const sp = s.model?.getObjectByName?.('Spine'); if (sp && game.camDist?.(s.pos) < 160) { sp.getWorldPosition(_v); px = _v.x; pz = _v.z; }
      const big = st === 'dead' ? 0.3 + Math.random() * 0.14 : st === 'critical' ? 0.2 + Math.random() * 0.14 : 0.1 + Math.random() * 0.06, k = b.pooled ? 0.6 : 1;
      b.pool = this.add(px + (Math.random() - 0.5) * 0.12, s.pos.y + 0.012, pz + (Math.random() - 0.5) * 0.12, Math.random() * 6.283, 0.05, 0.05, big * k * 2, big * k * 2 * (0.75 + Math.random() * 0.5), (big * 2) / (26 + Math.random() * 16));
      b.pooled = true;
    }
  }
  dispose() { this.mesh.parent?.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.map?.dispose(); this.mesh.material.dispose(); }
}
