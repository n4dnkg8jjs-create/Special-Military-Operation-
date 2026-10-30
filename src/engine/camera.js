import * as THREE from 'three';

// Total War-style RTS camera: pan on the ground plane, yaw/pitch orbit, zoom by height.
export class RTSCamera {
  constructor(camera, dom, bounds) {
    this.cam = camera; this.dom = dom; this.bounds = bounds;
    this.focus = new THREE.Vector3(0, 0, 60);
    this.yaw = 0.12; this.pitch = 0.78; this.dist = 95;
    this.tYaw = this.yaw; this.tPitch = this.pitch; this.tDist = this.dist; this.tFocus = this.focus.clone();
    this.keys = new Set(); this.mouse = { x: innerWidth / 2, y: innerHeight / 2, inside: true };
    this.orbiting = false; this.shake = 0;
    addEventListener('keydown', e => { if (e.target.tagName !== 'INPUT') this.keys.add(e.code); });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('wheel', e => { e.preventDefault(); this.tDist = THREE.MathUtils.clamp(this.tDist * Math.pow(1.0015, e.deltaY), 12, 260); }, { passive: false });
    dom.addEventListener('pointerdown', e => { if (e.button === 1) { this.orbiting = true; e.preventDefault(); } });
    addEventListener('pointerup', e => { if (e.button === 1) this.orbiting = false; });
    addEventListener('pointermove', e => {
      if (this.orbiting) { this.tYaw -= e.movementX * 0.005; this.tPitch = THREE.MathUtils.clamp(this.tPitch + e.movementY * 0.004, 0.18, 1.45); }
      this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    });
    document.addEventListener('mouseleave', () => this.mouse.inside = false);
    document.addEventListener('mouseenter', () => this.mouse.inside = true);
  }
  lookAt(x, z) { this.tFocus.set(x, 0, z); }
  addShake(a) { this.shake = Math.min(1.2, this.shake + a); }
  update(dt) {
    const k = this.keys, sp = (k.has('ShiftLeft') ? 2.2 : 1) * (40 + this.dist * 0.9) * dt;
    const fwd = new THREE.Vector3(-Math.sin(this.tYaw), 0, -Math.cos(this.tYaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const mv = new THREE.Vector3();
    if (k.has('KeyW') || k.has('ArrowUp')) mv.add(fwd);
    if (k.has('KeyS') || k.has('ArrowDown')) mv.sub(fwd);
    if (k.has('KeyD') || k.has('ArrowRight')) mv.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) mv.sub(right);
    const m = this.mouse, edge = 6;
    if (m.inside && document.pointerLockElement == null && !this.orbiting && window.__edgePan !== false) {
      if (m.x <= edge) mv.sub(right); if (m.x >= innerWidth - edge) mv.add(right);
      if (m.y <= edge) mv.add(fwd); if (m.y >= innerHeight - edge) mv.sub(fwd);
    }
    if (mv.lengthSq()) this.tFocus.addScaledVector(mv.normalize(), sp);
    if (k.has('KeyQ')) this.tYaw += 1.6 * dt;
    if (k.has('KeyE')) this.tYaw -= 1.6 * dt;
    if (k.has('PageUp')) this.tDist = Math.max(12, this.tDist - 60 * dt);
    if (k.has('PageDown')) this.tDist = Math.min(260, this.tDist + 60 * dt);
    const b = this.bounds;
    this.tFocus.x = THREE.MathUtils.clamp(this.tFocus.x, -b, b);
    this.tFocus.z = THREE.MathUtils.clamp(this.tFocus.z, -b, b);
    const a = 1 - Math.exp(-dt * 9);
    this.focus.lerp(this.tFocus, a);
    this.yaw += (this.tYaw - this.yaw) * a; this.pitch += (this.tPitch - this.pitch) * a; this.dist += (this.tDist - this.dist) * a;
    // pitch flattens as you zoom in (Total War feel)
    const p = THREE.MathUtils.lerp(Math.min(this.pitch, 0.42), this.pitch, THREE.MathUtils.smoothstep(this.dist, 14, 90));
    const c = this.cam;
    c.position.set(
      this.focus.x + Math.sin(this.yaw) * Math.cos(p) * this.dist,
      this.focus.y + Math.sin(p) * this.dist + 1.6,
      this.focus.z + Math.cos(this.yaw) * Math.cos(p) * this.dist);
    c.lookAt(this.focus.x, this.focus.y + 1.2, this.focus.z);
    if (this.shake > 0.001) {
      const s = this.shake * this.shake * 0.6;
      c.position.x += (Math.random() - .5) * s; c.position.y += (Math.random() - .5) * s; c.position.z += (Math.random() - .5) * s;
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
  }
}
