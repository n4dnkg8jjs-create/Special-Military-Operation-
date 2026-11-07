// Tube-artillery fire missions: the heavy call-in next to the company's 82 mm mortars (order bar ARTILLERY, key Y).
// Not an on-map unit (that is the SPG, game/artillery.js): a battery several kilometres behind the line, reached over
// the battalion fire net. Same rules for both sides and for both players in versus.
//
// Research basis (figures rounded; the battle clock compresses the real procedure):
//   Ukraine: 155 mm M777A2 towed howitzer batteries (US / Australian / Canadian deliveries from 2022) - M795 HE,
//     ~10.8 kg TNT; 24 km unassisted; 2 rpm sustained, ~4 rpm max. 2023-24 shell hunger: 3 guns x 2 rounds is a typical
//     mission, not a full battery's sheaf.
//   Russia: 152 mm 2S3M Akatsiya SP howitzer batteries (the most numerous Russian tube) - OF-540 HE-Frag, ~6.9 kg
//     explosive; 18.5 km; 3-4 rpm. More shells: 4 guns x 2 rounds.
//   Procedure: call for fire -> fire direction centre computes the data (minutes in reality; here seconds) -> "shot":
//     ONE adjusting round from the base piece -> the observer corrects onto the target -> "fire for effect": every gun
//     fires its rounds. Time of flight at ~12 km is ~30-40 s (high angle more); compressed here to ~16 s, so the first
//     FFE round lands ~40 s after the call - the adjusting round is the warning the other side gets.
//   Precision: modern fire control makes this tighter than the company's 82 mm mortars (callStrike spread 16 = ~9 m
//     per axis, ~11 m CEP). Ukraine: Kropyva / GIS Arta tablets put the target grid from the drone straight into the
//     battery's computer, with computed MET and surveyed gun positions; Russia: Strelets C2 terminals and Orlan-10 /
//     Zala spotting. The first round lands close (15-30 m off), the drone operator walks it onto the aim point, and the
//     guns fire for effect with a tight, computed sheaf: mean point of impact within ~3 m, ~5-6 m per axis per round
//     (~6-7 m CEP), the 2S3's older guns / worn tubes a little looser than the M777A2. The bigger burst does the rest.
//   Effect: a 152/155 mm HE-Frag burst is lethal to men in the open out to ~15-20 m and wounds well beyond (game radius
//     15 m, as the on-map Msta-S / Bohdana, suppression to 3x that); a near miss (<5-8 m) wrecks soft vehicles and can disable armour (tracks,
//     optics); a direct hit on a panel building takes out a section of wall / floor.
//   Danger close: 600 m for 155 mm in US doctrine; the game warns when own troops are within 150 m (where its blast
//     model starts to bite), the mission still goes in - the caller has accepted the risk.
import * as THREE from 'three';

export const BATTERIES = {
  UA: { name: '155 mm', gun: 'M777', label: '155 mm M777 battery', guns: 3, rpg: 2, power: 2.8, dmg: [170, 420], radius: 15, sigma: 5, adjErr: [15, 28], tof: [13, 16], volley: [10, 13] },
  RU: { name: '152 mm', gun: '2S3 Akatsiya', label: '152 mm 2S3M Akatsiya battery', guns: 4, rpg: 2, power: 2.7, dmg: [170, 420], radius: 15, sigma: 6, adjErr: [18, 32], tof: [13, 16], volley: [11, 14] },
};
export const ARTY = { missions: 2, aiMissions: 1, dangerClose: 150, aiCooldown: 180, proc: [5, 7.5], correct: [3, 4.5] };

const rr = (a, b) => a + Math.random() * (b - a);
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const OTHER = s => (s === 'player' ? 'enemy' : 'player');

export function setupFires(game) {
  const F = new FireMissions(game);
  game.playerArtillery = (x, z) => F.call('player', x, z);
  const net = game.opts?.net;
  if (net?.role === 'client') {
    // versus joiner: the host runs the mission on its 'enemy' side and sends the alerts / mission count back
    net.peer.on('artyN', n => { F.count.player = n; });
    net.peer.send('artyQ', 1);
    net.peer.on('artyMsg', ([m, k]) => game.hud?.alert(m, k));
    game.playerArtillery = (x, z) => {
      if (F.count.player <= 0 || game.phase === 'deploy') return false;
      F.count.player--; net.peer.send('arty', { x, z }); F.dangerClose('player', x, z); F.marker(x, z, F.zoneR(F.bat('player')), null);
      game.hud?.alert(`${F.bat('player').label}: call for fire sent`, 'good'); game.sfx('radio');
      return true;
    };
  }
  if (net?.role === 'host') {
    F.count.enemy = Math.max(0, ARTY.missions + (game.mods?.enemy?.artillery || 0)); F.remote = net.peer;   // the joiner's missions: the base allowance + its own upgrades (game.mods.enemy, campaignBattle.js applyMods)
    net.peer.on('arty', ({ x, z }) => { if (game.phase !== 'deploy') F.call('enemy', x, z); });
    const tell = () => net.peer.send('artyN', F.count.enemy);
    net.peer.on('artyQ', tell); Promise.resolve().then(tell);
  }
  return F;
}

class FireMissions {
  constructor(game) {
    this.g = game; this.rounds = []; this.events = []; this.markers = []; this.aiLast = -1e9; this.dangerR = ARTY.dangerClose;
    const C = game.campaign, M = game.mods || {};
    // campaign: own guns from the brigade's fire plan if the campaign passes one (setup.fires.ownArty, 0..1), the
    // enemy's from its artillery factor (setup.artillery / fires.enemyArty, 0..1); tech upgrades may add (mods.artillery)
    const own = C?.fires?.ownArty, foe = C ? (C.artillery ?? C.fires?.enemyArty ?? 0.5) : null;
    this.count = {
      player: Math.max(0, (own != null ? Math.round(ARTY.missions * own) : ARTY.missions) + (M.player?.artillery || 0)),
      enemy: Math.max(0, (foe != null ? Math.min(2, Math.round(foe * 2)) : ARTY.aiMissions) + (M.enemy?.artillery || 0)),
    };
  }
  zoneR(B) { return Math.round(2 * B.sigma + B.radius); }   // beaten zone: the sheaf plus the lethal burst radius
  faction(side) { return side === 'player' ? this.g.playerFaction : this.g.enemyFaction; }
  bat(side) { return BATTERIES[this.faction(side)?.id] || BATTERIES.UA; }
  // own (side) troops near a target point: danger close
  nearOwn(side, x, z, r) {
    let n = 0;
    for (const u of this.g.unitsOf(side)) {
      if (u.type === 'vehicle') { if (Math.hypot(u.pos.x - x, u.pos.z - z) < r) n++; continue; }
      if (u.mounted) continue;
      for (const s of u.soldiers) if (s.alive && Math.hypot(s.pos.x - x, s.pos.z - z) < r) { n++; break; }
    }
    return n;
  }
  dangerClose(side, x, z) {
    const n = this.nearOwn(side, x, z, ARTY.dangerClose); if (!n || side !== 'player') return n;
    this.g.hud?.alert(`DANGER CLOSE — ${n} of our unit${n > 1 ? 's' : ''} within ${ARTY.dangerClose} m of the target. Get them down or pull them back`, 'bad');
    return n;
  }
  say(side, msg, kind = 'good') {
    if (side === 'player') this.g.hud?.alert(msg, kind);
    else if (this.remote) this.remote.send('artyMsg', [msg, kind]);
  }
  // call a fire mission for `side` on map point x, z (host / single player)
  call(side, x, z) {
    const g = this.g; if (this.count[side] <= 0 || g.phase === 'deploy' || g.over) return false;
    this.count[side]--; if (side === 'enemy' && this.remote) this.remote.send('artyN', this.count.enemy);
    const B = this.bat(side), t = g.time, shot = t + rr(...ARTY.proc), tof = rr(...B.tof);
    const m = { side, x, z, B, tof };
    this.dangerClose(side, x, z);   // (the joiner warns itself: game/fireMission.js setupFires)
    if (side === 'player') { this.marker(x, z, this.zoneR(B), m); g.sfx('radio'); }
    this.say(side, `${B.label}: adjust fire, 1 round — splash in ~${Math.round(shot + tof - t)} s · ${this.count[side]} mission${this.count[side] === 1 ? '' : 's'} left`);
    // the adjusting round: the base piece on computed data (MET, survey) - close, but not yet on the aim point
    const a = Math.random() * Math.PI * 2, e = rr(...B.adjErr);
    this.events.push({ t: shot, kind: 'shot', m, n: 1 });
    this.rounds.push({ x: x + Math.cos(a) * e, z: z + Math.sin(a) * e, t: shot + tof, side, m, adjust: true, whistled: false });
    return true;
  }
  // the adjusting round is down: correct onto the target, fire for effect
  fireForEffect(m) {
    const g = this.g, B = m.B, t0 = g.time + rr(...ARTY.correct);
    const mx = m.x + gauss() * 2.5, mz = m.z + gauss() * 2.5;   // mean point of impact after the drone-observed correction
    const n = B.guns * B.rpg;
    for (let v = 0; v < B.rpg; v++) {
      const tv = t0 + v * rr(...B.volley);
      this.events.push({ t: tv, kind: 'shot', m, n: B.guns });
      for (let i = 0; i < B.guns; i++) this.rounds.push({ x: mx + gauss() * B.sigma, z: mz + gauss() * B.sigma, t: tv + m.tof + i * rr(0.15, 0.6) + Math.random() * 0.8, side: m.side, m, whistled: false });
    }
    this.say(m.side, `Adjusting round down — fire for effect: ${n} × ${B.name}, splash in ~${Math.round(t0 + m.tof - g.time)} s`);
    // the side under the guns: the adjusting round was the warning
    const os = OTHER(m.side);
    if (os === 'player' && this.nearOwn('player', m.x, m.z, 160)) this.g.hud?.alert('Enemy artillery is ranging on our positions — heavy fire incoming!', 'bad');
    else if (os === 'enemy' && this.remote && this.nearOwn('enemy', m.x, m.z, 160)) this.remote.send('artyMsg', ['Enemy artillery is ranging on our positions — heavy fire incoming!', 'bad']);   // (versus: the joiner's troops)
  }
  update() {
    const g = this.g, now = g.time;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]; if (now < e.t) continue; this.events.splice(i, 1);
      // the battery firing: a distant boom (the guns are 8-15 km back: a low thud, no position)
      if (e.kind === 'shot') g.sfx('artillery_far', null, { gain: e.n > 1 ? 0.7 : 0.45 });
    }
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i];
      if (!r.whistled && now > r.t - 2.6) { r.whistled = true; g.sfx('shell_incoming', new THREE.Vector3(r.x, 24, r.z), { delay: false }); }
      if (now < r.t) continue;
      this.rounds.splice(i, 1); this.impact(r);
      if (r.adjust) this.fireForEffect(r.m);
    }
    for (let i = this.markers.length - 1; i >= 0; i--) { const k = this.markers[i]; if (k.m && (now > k.until || !this.rounds.some(r => r.m === k.m))) this.dropMarker(i); }
  }
  impact(r) {
    const g = this.g, B = r.m.B, at = new THREE.Vector3(r.x, 0.1, r.z);
    const b = g.city.buildingAt(r.x, r.z, 0); if (b) at.y = b.floors * g.assets.kit.H - 0.5;   // on a block: the roof / top floor
    g.combat.blastSide = r.side;
    g.combat.explode(at, B.power, null, B.dmg, B.radius);
    g.combat.blastSide = null;
    // same 152/155 mm HE-Frag burst as the on-map Msta-S / Bohdana (game.js updateStrikes, caliber 'spg'): same
    // explosion, dust and lethal radius - it is the same shell, only fired by an off-map battery
    if (!b) for (let k = 0; k < 2; k++) g.fx.vehicleDust(at, 16);
    // near misses on vehicles: fragments and blast through the running gear, optics, soft skin
    for (const v of g.vehicles) {
      if (v.destroyed) continue; const d = v.pos.distanceTo(at); if (d > 7) continue;
      v.hp -= (7 - d) * (v.kind === 'tank' ? 25 : 70);
      if (v.hp <= 0) v.knockOut(false); else if (d < 3 && Math.random() < 0.5) { v.immob ||= {}; v.immob.track = true; v.immobile = true; }
    }
  }
  // targeting preview while the order is armed: the expected beaten zone, and the danger-close circle in red when
  // own troops are inside it
  preview(p) {
    if (!this.g.scene) return;
    if (!this.pv) {
      const mk = (r0, r1, col, op) => { const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 72), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, depthWrite: false, depthTest: false })); m.rotation.x = -Math.PI / 2; m.renderOrder = 6; this.g.scene.add(m); return m; };
      this.pv = { zone: mk(0.94, 1, 0xd8b25a, 0.85), dc: mk(0.985, 1, 0xd8b25a, 0.4) };
      this.pv.zone.scale.setScalar(this.zoneR(this.bat('player'))); this.pv.dc.scale.setScalar(ARTY.dangerClose);
    }
    const on = !!p; this.pv.zone.visible = this.pv.dc.visible = on; if (!on) return;
    const y = (this.g.city.groundHeight?.(p.x, p.z) || 0) + 0.3;
    this.pv.zone.position.set(p.x, y, p.z); this.pv.dc.position.set(p.x, y, p.z);
    const near = this.nearOwn('player', p.x, p.z, ARTY.dangerClose) > 0;
    this.pv.dc.material.color.set(near ? 0xe2574a : 0xd8b25a); this.pv.dc.material.opacity = near ? 0.85 : 0.35;
    this.pv.zone.material.color.set(near ? 0xe2574a : 0xd8b25a);
  }
  // per frame (host and joiner): hide the preview once the targeting mode is gone; timed markers on the joiner
  frame() {
    if (this.pv?.zone.visible && this.g.input?.mode !== 'artillery') this.preview(null);
    if (this.g.netClient) { const now = performance.now() / 1000; for (let i = this.markers.length - 1; i >= 0; i--) if (now > this.markers[i].wall) this.dropMarker(i); }
  }
  marker(x, z, r, mission) {
    if (!this.g.scene || (this.g.noRender && !this.g.renderer)) return;
    const m = new THREE.Mesh(new THREE.RingGeometry(r - 1.4, r, 64), new THREE.MeshBasicMaterial({ color: 0xd8b25a, transparent: true, opacity: 0.6, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, (this.g.city.groundHeight?.(x, z) || 0) + 0.2, z); m.renderOrder = 3; this.g.scene.add(m);
    // host / single player: dropped once the mission's last round is down; joiner (no mission here): after ~50 s
    this.markers.push({ mesh: m, until: this.g.time + 90, wall: performance.now() / 1000 + 50, m: mission });
  }
  dropMarker(i) { const k = this.markers[i]; this.g.scene.remove(k.mesh); k.mesh.geometry.dispose(); k.mesh.material.dispose(); this.markers.splice(i, 1); }
  // the enemy commander's call (game/ai.js mission()): rationed - one mission every few minutes at most, only on a
  // real concentration, never with its own troops near the target (it knows the guns are not precise)
  aiCall(x, z) {
    const g = this.g;
    if (this.count.enemy <= 0 || g.time - this.aiLast < ARTY.aiCooldown || g.phase === 'deploy') return false;
    if (this.nearOwn('enemy', x, z, ARTY.dangerClose + 30)) return false;
    if (!this.call('enemy', x, z)) return false;
    this.aiLast = g.time; return true;
  }
}
