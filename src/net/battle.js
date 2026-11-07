// Versus battles over the peer link. The HOST runs the whole simulation: its own force is the 'player' side, the
// joiner's force is the 'enemy' side (no AI), the joiner's orders arrive as commands. The JOINER runs a puppet copy:
// the same seeded world, the same units (from a spawn manifest), positions/animation state from ~10 Hz snapshots,
// and every visual/audio effect (muzzle flashes, tracers, explosions, building damage, craters, sounds) replayed from
// an event stream. On the joiner the sides are swapped locally so its own units are 'player' (HUD, input, fog).
import * as THREE from 'three';
import { SQUAD_ROLES, ASSAULT_ROLES, CREW_ROLES, ATGM_ROLES, FPV_ROLES, TUNING } from '../config.js';
import { ContactMarkers } from '../ui/contactMarkers.js';
import { MEDIC_ROLES, MSTATES, medevacPuppet, clientMedevac } from '../game/medevac.js';
import { attachKits } from '../game/vehicleKit.js';

const DRONE_PHASE = ['launch', 'climb', 'cruise', 'dive', 'fall'];   // (= game/support.js FpvTeam drone phases)
const STANCE = ['stand', 'crouch', 'prone'], STATE = ['ok', 'light', 'critical', 'stable', 'dead', 'evac'];
const FX_EVENTS = ['light', 'muzzle', 'tracer', 'impact', 'blood', 'explosion', 'collapseDust', 'muzzleBlastTank', 'dustCloud', 'smokeScreen', 'emitter', 'vehicleDust'];
const r2 = v => Math.round(v * 100) / 100;
const enc = a => (a && a.isVector3 ? { v: [r2(a.x), r2(a.y), r2(a.z)] } : Array.isArray(a) ? a.map(enc) : (a && typeof a === 'object') ? (Object.values(a).some(x => x && typeof x === 'object' && !x.isVector3 && !Array.isArray(x)) ? null : Object.fromEntries(Object.entries(a).map(([k, x]) => [k, enc(x)]))) : a);
const dec = a => (a && a.v && a.v.length === 3 ? new THREE.Vector3(...a.v) : Array.isArray(a) ? a.map(dec) : (a && typeof a === 'object') ? Object.fromEntries(Object.entries(a).map(([k, x]) => [k, dec(x)])) : a);
const flip = s => (s === 'player' ? 'enemy' : 'player');

// ------------------------------------------------------------------------------------------------------- host
export function hostBattle(game, peer) {
  const ev = [];
  game.netEvents = ev;
  // record effects as they happen: top-level calls only. An effect's own sub-effects (muzzleBlastTank -> muzzle,
  // explosion / muzzle -> light) and fx.update's emitter lights are replayed by the joiner's own FX code: recording
  // them too doubled those particles / lights on the joiner
  let depth = 0;
  const nest = f => (...a) => { depth++; try { return f(...a); } finally { depth--; } };
  for (const m of FX_EVENTS) { const f = nest(game.fx[m].bind(game.fx)); game.fx[m] = (...a) => { if (!depth) ev.push(['fx', m, enc(a)]); return f(...a); }; }
  game.fx.update = nest(game.fx.update.bind(game.fx));
  // vehicleDust: the heavy shells' and the SPG's blast dust are events; a vehicle's own driving dust / exhaust (vehicle.fx)
  // the joiner makes itself for its puppets (clientSmooth)
  for (const v of game.vehicles) if (v.fx) v.fx = nest(v.fx.bind(v));
  // the rest of Game.init (map smoke columns, burning flats) runs right after this, identically seeded on the joiner: not events
  Promise.resolve().then(() => { ev.length = 0; });
  const sfx = game.sfx.bind(game); game.sfx = (n, p, o) => { ev.push(['sfx', n, enc(p), enc(o || null)]); return sfx(n, p, o); };
  const C = game.city;
  C.buildings.forEach((b, bi) => {
    const ss = b.setState.bind(b), sg = b.setGone.bind(b);
    b.setState = (p, s) => { ev.push(['bs', bi, b.panels.indexOf(p), s]); return ss(p, s); };
    b.setGone = p => { ev.push(['bg', bi, b.panels.indexOf(p)]); return sg(p); };
  });
  const sr = C.spawnRubble.bind(C); C.spawnRubble = (x, z, s) => { ev.push(['rb', r2(x), r2(z), s]); return sr(x, z, s); };
  const ac = C.addCrater.bind(C); C.addCrater = (x, z, s, cell) => { ev.push(['cr', r2(x), r2(z), s]); return ac(x, z, s, cell); };
  if (C.damageFortAt) { const df = C.damageFortAt.bind(C); C.damageFortAt = (x, z, p, r) => { const n = df(x, z, p, r); if (n) ev.push(['ft', r2(x), r2(z), p, r]); return n; }; }
  // trees pushed over by a vehicle (world/treeDamage.js crush, from vehicle.update: the joiner runs no vehicle physics).
  // Shelled trees need nothing: they follow from the replayed explosions. The crush's dust / leaves come from the
  // joiner's own snap (nested here: not recorded); its sound is an ordinary sfx event
  const TD = game.treeDamage;
  if (TD?.crush) { const sn = TD.snap.bind(TD), cr = nest(TD.crush.bind(TD)); let on = false;
    TD.crush = v => { on = true; try { return cr(v); } finally { on = false; } };
    TD.snap = (t, bx, bz, q, w) => { if (on) ev.push(['tc', t, r2(bx), r2(bz)]); return sn(t, bx, bz, q, w); }; }
  // fences / benches / panels flattened by a vehicle (world/city.js crushCheck, host only): the fallen pose goes over
  if (C.crushCheck && C.setCrushMatrix) { const sc = C.setCrushMatrix.bind(C), cc = C.crushCheck.bind(C); let on = false;
    C.crushCheck = (v, g) => { on = true; try { return cc(v, g); } finally { on = false; } };
    C.setCrushMatrix = (it, M) => { if (on) ev.push(['ck', (C.crushables || []).indexOf(it), M.elements.map(x => Math.round(x * 1000) / 1000)]); return sc(it, M); }; }
  // gun recoil (vehicle.recoil, decays in sync): counted per shot so the joiner kicks its puppet's gun on every round
  for (const v of game.vehicles) { let r = v.recoil || 0; Object.defineProperty(v, 'recoil', { get: () => r, set: x => { if (x >= 0.35 && x > r + 0.05) { v._shots = (v._shots || 0) + 1; v._shotK = x; } r = x; }, configurable: true }); }
  game.netKnown = new Set(game.squads.map(q => q.id));   // squads in the spawn manifest; later ones (bailed-out crews) go out with the snapshots
  // the joiner's orders, applied to its ('enemy') units
  const byId = id => game.squads.find(s => s.id === id) || game.vehicles.find(v => v.id === id);
  peer.on('cmd', c => applyCommand(game, byId, c));
  // the joiner's mortar missions: the base allowance + its own campaign upgrades / prep fire (deployCampaign applyMods
  // stored them in game.mods.enemy; the host's own count went into game.mortars)
  game.mortarsEnemy = TUNING.mortarStrikes + (game.mods?.enemy?.mortar || 0); game.mortarsEnemyN = 0;
  peer.on('mortar', ({ x, z }) => { game.mortarsEnemyN++; if (game.mortarsEnemy > 0 && game.phase !== 'deploy') { game.mortarsEnemy--; game.callStrike(x, z, 6, 16, 'enemy', 9, 'mortar'); game.sfx('mortar_launch', null, { gain: 0.4 }); } });
  const sb = game.startBattle.bind(game);
  game.startBattle = () => { if (game.phase !== 'deploy') return; game.hostReady = true; if (game.guestReady) sb(); else game.hud?.alert('Ready — waiting for the opponent to finish deploying', 'good'); };
  peer.on('ready', () => { game.guestReady = true; game.hud?.alert('Opponent is ready', 'good'); if (game.hostReady) sb(); });
  // snapshots + events
  let acc = 0, nSnap = 0;
  game.netTick = dt => {
    acc += dt; if (acc < 0.1) return; acc = 0;
    if (ev.length) { peer.send('ev', ev.splice(0, ev.length)); }
    const sn = snapshot(game); if (!(nSnap++ % 20)) window.__lastSnapSize = JSON.stringify(sn).length; peer.sendSnap('snap', sn);   // (size for the tests every 2 s: not a second full stringify per snapshot)
  };
}

const squadManifest = sq => ({ id: sq.id, side: sq.side, kind: sq.kind, name: sq.name, n: sq.soldiers.length, roles: sq.soldiers.map(s => s.role.role), carrier: sq.carrier?.id ?? null, mounted: sq.mounted, medevac: sq.medevac?.id ?? null });
export function manifest(game) {
  return {
    squads: game.squads.map(squadManifest),
    vehicles: game.vehicles.map(v => ({ id: v.id, side: v.side, kind: v.kind, name: v.name, hp: v.hp, x: v.pos.x, z: v.pos.z, h: v.heading, kits: v.kits?.length ? v.kits : undefined })),   // kits: campaign tech-tree kits (meshes on the joiner's copy)
    mortars: game.mortars,
  };
}

function snapshot(g) {
  const seen = u => g.seen?.('enemy', u) ? 1 : 0;
  const sq = g.squads.map(q => [q.id, Math.round(q.morale), q.mounted ? 1 : 0, q.side === 'player' ? seen(q) : 1, q.soldiers.map(s => {
    const f = (s.firingT > 0 ? 1 : 0) | (s.target ? 2 : 0) | (s.groundAim ? 4 : 0) | (s.ducking ? 8 : 0) | (s.reloadT > 0 ? 16 : 0) | (s.throwT > 0 ? 32 : 0) | (s.launcherT > 0 ? 64 : 0) | (s.legWound ? 128 : 0) | (s.peek ? 256 : 0) | (s.hitT > 0 ? 512 : 0) | (s.inCab ? 1024 : 0) | (s.onBed ? 2048 : 0) | (s.cellar ? 4096 : 0);
    const tp = s.target?.pos;
    return [r2(s.pos.x), r2(s.pos.y), r2(s.pos.z), r2(s.heading), r2(s.vel.x), r2(s.vel.z), STANCE.indexOf(s.stance), STATE.indexOf(s.state), f,
      s.inside === 'ride' ? 1 : s.inside === 'btr' ? 2 : s.inside && typeof s.inside === 'object' ? 3 : 0, s.weaponKey, tp ? [r2(tp.x), r2(tp.z)] : 0,
      s.state === 'dead' ? (s.deathClip || 0) : (s.hatchT > 0 ? ['h', s.hatchClip, r2(s.hatchT)] : s.jumpT > 0 ? ['j', s.jumpClip, r2(s.jumpT)] : 0), s.seatType || 0,
      s.state !== 'dead' && s.curName ? [s.curName, r2(s.cur?.time || 0), r2(s.cur?.timeScale || 1)] : 0, s.kitObjs?.length ? s.kitObjs.map(o => (o.visible ? 1 : 0)).join('') : 0];
  })]);
  const v = g.vehicles.map(x => [x.id, r2(x.pos.x), r2(x.pos.y || 0), r2(x.pos.z), r2(x.heading), r2(x.pitch || 0), r2(x.roll || 0), r2(x.turretYaw), r2(x.gunPitch), Math.round(x.hp), (x.destroyed ? 1 : 0) | (x.burning > 0 ? 2 : 0) | (x.abandoned ? 4 : 0), r2(x.doorK || 0), r2(x.speed), x.side === 'player' ? seen(x) : 1, x.lidAnim ? 1 : 0, x.spg ? [x.spg.k, x.spg.state] : 0, x._shots || 0, r2(x._shotK || 0), x.flyer ? 1 : 0]);
  const pr = g.combat.projectiles.filter(p => p.mesh).map(p => [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r2(p.target.x), r2(p.target.y), r2(p.target.z)]);
  const dr = [], W = new THREE.Vector3(), Q = new THREE.Quaternion(); for (const q of g.squads) { const d = q.support?.drone; if (d?.mesh?.parent && d.mesh.visible) { d.mesh.getWorldPosition(W); d.mesh.getWorldQuaternion(Q); const t = d.target, tp = d.aim && d.phase === 'dive' ? d.aim : t ? (t.type === 'vehicle' ? t.pos : t.center()) : W; dr.push([r2(W.x), r2(W.y), r2(W.z), ...Q.toArray().map(r2), q.id, r2(tp.x), r2(tp.y), r2(tp.z), Math.max(0, DRONE_PHASE.indexOf(d.phase)), d.jam && d.phase === 'dive' ? 1 : 0, r2(d.age), q.support.launched || 0]); } }   // [7..]: squad, target point, phase, jammed, age, drone no. (the joiner's drone view, ui/droneFeed.js)
  // support teams: status line + every launcher prop (tripod, tube, guidance unit, spent tubes...) in world space
  const sp = g.squads.filter(q => q.support).map(q => { const S = q.support; return [q.id, S.status?.() || '', S.launcher ? 1 : 0, S.launcher ? Object.entries(S.nodes || {}).map(([k, n]) => { n.o.getWorldPosition(W); n.o.getWorldQuaternion(Q); return [k, n.o.visible && n.o.parent ? 1 : 0, r2(W.x), r2(W.y), r2(W.z), ...Q.toArray().map(x => Math.round(x * 1000) / 1000)]; }) : 0]; });
  // the medevac pickups (game/medevac.js): run state, casualties aboard, trip timer, saved, doors (an 'away' truck is not in
  // g.vehicles, so not in v: the joiner hides it)
  const md = (g.medevac?.trucks || []).map(t => [t.id, MSTATES.indexOf(t.mstate), t.load.length, Math.max(0, Math.ceil(t.tripT || 0)), t.saved || 0, Object.values(t.doors || {}).map(D => r2(D.k)), t.medicsOut() ? 1 : 0]);
  // squads that came into being after the manifest (a knocked-out vehicle's crew): their manifest with every snapshot
  // (snapshots are unreliable: one lost must not lose the squad), the joiner builds them on first sight
  const ns = g.netKnown ? g.squads.filter(q => !g.netKnown.has(q.id)).map(squadManifest) : [];
  return { t: r2(g.time), ph: g.phase, md, ns, mn: g.mortarsEnemyN || 0, o: g.objectives.map(o => [o.owner, r2(o.control), o.contested ? 1 : 0]), st: g.stats, sq, v, pr, dr, sp, mo: g.mortarsEnemy ?? 0, tk: g.tickets ? [r2(g.tickets.player), r2(g.tickets.enemy), g.tickets.max, g.ticketDrain?.player || 0, g.ticketDrain?.enemy || 0] : null, over: g.over ? g.result : null };
}

function applyCommand(game, byId, c) {
  const u = byId(c.id); if (!u || u.side !== 'enemy') return;
  const a = dec(c.a || []);
  const ref = x => (x && x.unit != null ? byId(x.unit) : x && x.hse != null ? game.houses?.list[x.hse] : x && x.bld != null ? game.city.buildings[x.bld] : x && x.trench != null ? game.city.trenchSystems?.[x.trench] : x);
  switch (c.m) {
    case 'set': if (['holdFire', 'run'].includes(c.k)) u[c.k] = c.v; else if (c.k === 'fireAt') u.fireAt = c.v ? { p: new THREE.Vector3(...c.v.p), until: game.time + 30 } : null; break;
    case 'place': if (game.phase === 'deploy') game.deployPlace(u, a[0], a[1], a[2], 'enemy'); break;   // (no redeploying once the battle has started)
    default: if (CMDS.includes(c.m) && typeof u[c.m] === 'function') u[c.m](...a.map(ref));   // only the joiner's order methods, nothing else on the unit
  }
}

// ------------------------------------------------------------------------------------------------------ joiner
const CMDS = ['orderMove', 'orderAttack', 'orderGarrison', 'orderMount', 'dismount', 'halt', 'orderTrench', 'orderClearTrench', 'orderEvacuate'];
export function clientBattle(game, peer) {
  const local = id => game.netMap.get(id);
  // build the units from the host's manifest (sides swapped: the joiner's own units are 'player' here)
  game.netMap = new Map();
  const M = game.opts.net.manifest;
  const trucks = [];
  for (const vm of M.vehicles) {
    // the medevac pickups are MedevacTrucks here too (model, doors, HUD panel, EVAC marker); their names follow the local sides
    const v = vm.kind === 'medevac' ? medevacPuppet(game, flip(vm.side), vm) : game.makeVehicle(flip(vm.side), vm.kind, vm.x, vm.z, vm.h);
    if (vm.kind === 'medevac') trucks.push(v); else v.name = vm.name;
    v.hp = vm.hp; v.netId = vm.id; game.netMap.set(vm.id, v);
    // the host's campaign kits (cope cages, ERA, the casevac pickup's net ...): the same meshes on the joiner's copy (the
    // effects are the host's: it resolves every hit)
    if (vm.kits?.length && !v.fallback && !v.kitDone) { v.kitDone = true; v.kits = [...vm.kits]; v.cageMesh = null; try { attachKits(v.model, vm.kits, { wheeled: !!v.def?.wheeled || v.kind === 'btr', kind: v.kind }); } catch (e) { console.warn('joiner kits', e); } }
  }
  for (const sm of M.squads) {
    const sq = netSquad(game, sm);
    const car = sm.carrier != null ? game.netMap.get(sm.carrier) : null; if (car && sm.mounted) sq.board(car, true);
    const mv = sm.medevac != null ? game.netMap.get(sm.medevac) : null; if (mv?.attachCrew) { mv.attachCrew(sq); sq.name = sq.side === 'player' ? 'Medevac crew' : 'Enemy medevac crew'; }
  }
  game.medevac = clientMedevac(game, trucks);   // (game.js setupMedevac returns it)
  game.playerUnits = [...game.squads, ...game.vehicles].filter(u => u.side === 'player' && !(u.type === 'squad' && (u.crew || u.medevac)));
  // outgoing orders: unit methods / property sets turn into commands to the host
  const encArg = x => (x && (x.type === 'squad' || x.type === 'vehicle') ? { unit: x.netId } : x && x.house === true ? { hse: game.houses.list.indexOf(x) } : x && x.panels ? { bld: game.city.buildings.indexOf(x) } : x && x.slots && x.lines ? { trench: game.city.trenchSystems.indexOf(x) } : enc(x));
  const wire = u => {
    for (const m of CMDS) if (typeof u[m] === 'function') u[m] = (...a) => peer.send('cmd', { id: u.netId, m, a: a.map(encArg) });
    for (const k of ['holdFire', 'run', 'fireAt']) { let val = u[k]; Object.defineProperty(u, k, { get: () => val, set: x => { val = x; peer.send('cmd', { id: u.netId, m: 'set', k, v: k === 'fireAt' ? (x ? { p: [x.p.x, x.p.y, x.p.z] } : null) : x }); }, configurable: true }); }
  };
  game.netWire = wire;   // (a medevac crew that bails out becomes an ordinary squad: wired then, clientFrame)
  for (const u of [...game.squads, ...game.vehicles]) if (u.side === 'player' && !(u.type === 'squad' && u.medevac)) wire(u);   // (the medics are driven by their truck)
  const dp = game.deployPlace.bind(game);
  game.deployPlace = (u, x, z, f) => { dp(u, x, z, f); if (u.netId != null) peer.send('cmd', { id: u.netId, m: 'place', a: [x, z, f] }); };
  game.startBattle = () => { if (game.sentReady) return; game.sentReady = true; peer.send('ready', 1); game.hud?.alert('Ready — waiting for the opponent', 'good'); };
  game.mortars = 0;
  game.mortarsSent = 0;
  game.playerMortar = (x, z) => { if (game.mortars <= 0 || game.phase === 'deploy') return false; game.mortars--; game.mortarsSent++; peer.send('mortar', { x, z }); game.mortarMarker(x, z); game.hud?.alert(`82 mm mortar fire mission: 6 rounds, ${game.mortars} missions left`, 'good'); game.sfx('radio'); return true; };
  // incoming
  peer.on('snap', s => { if (!game.lastSnap || s.t >= game.lastSnap.t) game.lastSnap = s; });
  peer.on('ev', list => replay(game, list));
  game.netClient = true;
}
function netSquad(game, sm) {
  const sq = game.makeSquad(flip(sm.side), 0, 0, 0, sm.name, sm.kind, rolesFor(sm)); sq.name = sm.name; sq.netId = sm.id; game.netMap.set(sm.id, sq); return sq;
}
function rolesFor(sm) { const pool = { assault: ASSAULT_ROLES, crew: CREW_ROLES, atgm: ATGM_ROLES, fpv: FPV_ROLES, medevac: MEDIC_ROLES }[sm.kind] || SQUAD_ROLES; return sm.roles.map(n => pool.find(r => r.role === n) || CREW_ROLES.find(r => r.role === n) || pool[0]); }

function replay(g, list) {
  for (const e of list) {
    try {
      if (e[0] === 'fx') g.fx[e[1]]?.(...dec(e[2]).map(x => (x === null ? undefined : x)));   // (JSON turns undefined / Infinity into null: the defaults apply again, e.g. an endless fire's life)
      else if (e[0] === 'sfx') g.sfx(e[1], dec(e[2]), dec(e[3]) || undefined);
      else if (e[0] === 'bs') { const b = g.city.buildings[e[1]], p = b?.panels[e[2]]; if (p) b.setState(p, e[3]); }
      else if (e[0] === 'bg') { const b = g.city.buildings[e[1]], p = b?.panels[e[2]]; if (p) b.setGone(p); }
      else if (e[0] === 'rb') g.city.spawnRubble(e[1], e[2], e[3]);
      else if (e[0] === 'cr') g.city.addCrater(e[1], e[2], e[3]);
      else if (e[0] === 'ft') g.city.damageFortAt?.(e[1], e[2], e[3], e[4]);
      else if (e[0] === 'ck') { const it = g.city.crushables?.[e[1]]; if (it && !it.crushed) { it.crushed = true; g.city.setCrushMatrix(it, new THREE.Matrix4().fromArray(e[2])); } }
      else if (e[0] === 'tc') { const T = g.treeDamage; if (T && T.st?.[e[1]] !== 2) T.snap(e[1], e[2], e[3], 0.5, 5); }
    } catch (err) { console.warn('replay', e[0], err); }
  }
}

// per frame on the joiner: apply the latest snapshot smoothly, animate, run local cosmetics. A snapshot's discrete state
// (stances, flags, clips, kit, objectives, support props...) is applied once when it arrives (10 Hz, 5 Hz over the relay);
// every frame only eases positions / headings toward it, animates and syncs.
export function clientFrame(g, dt) {
  const s = g.lastSnap; if (!s) return;
  if (s === g._appliedSnap) return clientSmooth(g, dt);
  g._appliedSnap = s;
  g.time = s.t; globalThis.__gameTime = g.time; if (s.st) g.stats = { player: s.st.enemy, enemy: s.st.player };   // (the host's sides: swapped, as everything here)
  if (s.ph !== 'deploy' && g.phase === 'deploy') { g.phase = s.ph; for (const m of g.zoneMeshes || []) m.visible = false; g.hud?.battleStarted?.(); }
  g.phase = s.ph;
  if (s.tk) { g.tickets = { player: s.tk[1], enemy: s.tk[0], max: s.tk[2] }; g.ticketDrain = { player: s.tk[4], enemy: s.tk[3] }; }   // host tickets, seen from the joiner's side
  s.o.forEach(([own, ctl, con], i) => { const o = g.objectives[i]; if (!o) return; o.owner = own === 'neutral' ? own : flip(own); o.control = -ctl; o.contested = !!con; o.ring?.material.color.set(o.owner === 'player' ? (o.contested ? 0xd8b25a : 0x8fb069) : o.owner === 'enemy' ? 0xc8483a : 0xb8b4a8); });
  // squads born on the host after the manifest (bailed-out crews): built here, under the player's orders if they are ours
  for (const sm of s.ns || []) {
    if (g.netMap.has(sm.id)) continue;
    const sq = netSquad(g, sm); for (const so of sq.soldiers) so.pos.set(0, 0, 0);
    if (sq.side === 'player') { g.netWire?.(sq); g.playerUnits?.push(sq); g.hud?.rebuildCards?.(); }
  }
  const live = g._netSq = [];
  for (const [id, morale, mounted, vis, men] of s.sq) {
    const sq = g.netMap.get(id); if (!sq) continue; sq.morale = morale; sq.mounted = !!mounted; sq.spotted = sq.side === 'player' || !!vis; live.push(sq);
    for (let i = 0; i < men.length; i++) {
      const so = sq.soldiers[i], m = men[i]; if (!so) continue;
      const [x, y, z, h, vx, vz, st, stt, f, ins, wk, tp, clip, seat] = m;
      if (!so._np || so.pos.distanceTo(so._np.set(x, y, z)) > 6 || so.pos.lengthSq() === 0) so.pos.set(x, y, z);
      (so._np ||= new THREE.Vector3()).set(x, y, z); so._nh = h; so.vel.set(vx, 0, vz);
      // (timers outlast one snapshot interval, 0.2 s over the relay; the clip itself comes from netClip)
      so.stance = STANCE[st] || 'stand'; so.firingT = f & 1 ? 0.25 : 0; so.groundAim = !!(f & 4); so.ducking = !!(f & 8); so.reloadT = f & 16 ? 0.5 : 0; so.throwT = f & 32 ? 0.5 : 0; so.legWound = !!(f & 128); so.hitT = f & 512 ? 0.3 : 0; so.inCab = !!(f & 1024); so.onBed = f & 2048 ? (so.onBed || true) : null; so.cellar = f & 4096 ? (so.cellar || true) : null;
      if (f & 2 && tp) { const t = so._nt ||= { pos: new THREE.Vector3(), type: 'squad' }; t.pos.set(tp[0], 0, tp[1]); so.target = t; } else so.target = null;
      so.inside = ins === 1 ? 'ride' : ins === 2 ? 'btr' : ins === 3 ? (so.inside && typeof so.inside === 'object' ? so.inside : { panel: { floor: 0 } }) : null; so.seatType = seat || so.seatType;
      if (wk && so.weaponKey !== wk && so.setWeapon) try { so.setWeapon(wk); } catch {}
      if (Array.isArray(clip)) { if (clip[0] === 'h') { so.hatchClip = clip[1]; so.hatchT = clip[2]; } else { so.jumpClip = clip[1]; so.jumpT = clip[2]; } }
      const nc = m[14], kit = m[15];
      if (Array.isArray(nc)) { so.netClip = nc[0]; so.netClipT = nc[1]; so.netTs = nc[2]; } else so.netClip = null;
      if (kit && so.kitObjs && kit !== so._kit) { so._kit = kit; for (let ki = 0; ki < so.kitObjs.length; ki++) so.kitObjs[ki].visible = kit[ki] === '1'; }
      const state = STATE[stt] || 'ok';
      if (state === 'dead' && so.state !== 'dead') so.die(null, {}); else if (state !== 'dead') so.state = state;
    }
    // the host's units are drawn (unidentified ones, vis 0, carry a "?") unless holed up unseen in a building / heavy foliage
    sq.concealed = ContactMarkers.concealed(sq, g);
    for (const so of sq.soldiers) so.visible = so.state === 'dead' || !sq.concealed;
  }
  for (const [id, x, y, z, h, p, r, ty, gp, hp, fl, dk, sp, vis, , , shots, shotK, toss] of s.v) {
    const v = g.netMap.get(id); if (!v) continue;
    v._np ||= new THREE.Vector3(x, y, z); v._np.set(x, y, z); if (v.pos.distanceTo(v._np) > 10) v.pos.copy(v._np);
    v._nh = h; v.pitch = p; v.roll = r; v.turretYaw = ty; v.gunPitch = gp; v.hp = hp; v.speed = sp;
    v.spotted = v.side === 'player' || !!vis; v.concealed = ContactMarkers.concealed(v, g);
    // knocked out: the wreck model; the explosion and the fire come with the host's event stream (no second set here)
    if (shots > (v._shots ?? shots)) v.recoil = Math.max(v.recoil || 0, shotK || 1); v._shots = shots;   // a round fired since the last snapshot: the gun kicks
    if (fl & 1 && !v.destroyed) { v.destroyed = true; v.wreck = true; v.showWreck(); if (toss) v.tossTurret?.();
      const cs = v.crewSq; if (cs?.medevac) { cs.medevac = null; cs.noncombat = false; cs.name = `${v.name} crew`; if (cs.side === 'player') { g.netWire?.(cs); g.playerUnits?.push(cs); g.hud?.rebuildCards(); } } }
    v.burning = fl & 2 ? Math.max(v.burning || 0, 0.01) : 0; v.abandoned = !!(fl & 4); v.doorK = dk;
  }
  // medevac pickups: run state, load, trip timer, doors; an 'away' truck is off the map
  for (const [id, ms, n, trip, saved, dk, out] of s.md || []) {
    const t = g.netMap.get(id); if (!t || t.kind !== 'medevac') continue;
    const st = MSTATES[ms] || 'ready', was = t.mstate; t.mstate = st; t._mOut = !!out; t.load.length = n; t.load.fill(null); t.tripT = trip; t.saved = saved;
    if (st === 'away') t.root.visible = false; else if (was === 'away') t.root.visible = true;
    Object.values(t.doors || {}).forEach((D, i) => { const k = dk?.[i] ?? 0; if (D.k === k) return; D.k = k; const e = k * k * (3 - 2 * k); D.o.rotation[D.ax] = D.open * e; });
  }
  // support teams: status text and launcher props as the host has them
  // mortar missions: the host's count less the calls it has not seen yet (a call in flight is not given back)
  g.mortars = Math.max(0, s.mo - Math.max(0, (g.mortarsSent || 0) - (s.mn || 0)));
  for (const [id, status, hasL, nodes] of s.sp || []) {
    const sq = g.netMap.get(id), S = sq?.support; if (!S) continue;
    sq.netStatus = status; if (!sq._netSt) { sq._netSt = true; sq.status = () => sq.netStatus; }
    if (hasL && !S.launcher) { const s0 = sq.soldiers.find(x => x.alive) || sq.soldiers[0]; try { S.placeLauncher(s0); } catch (e) { console.warn(e); } }
    if (!hasL && S.launcher) { for (const o of S._netProps || []) o.removeFromParent(); S._netProps = null; S.removeLauncher(); }   // (the props were moved into the scene below: they go with it)
    if (nodes && S.launcher) for (const [k, vis, x, y, z, qx, qy, qz, qw] of nodes) { const n = S.nodes[k]; if (!n) continue; if (n.o.parent !== g.scene) { g.scene.attach(n.o); (S._netProps ||= []).push(n.o); } n.o.visible = !!vis; n.o.position.set(x, y, z); n.o.quaternion.set(qx, qy, qz, qw); }
  }
  // rockets and drones (pooled meshes)
  g._rk ||= []; s.pr.forEach((q, i) => { const m = g._rk[i] ||= (() => { const mm = g.combat.rocketMesh(); g.scene.add(mm); return mm; })(); m.visible = true; m.position.set(q[0], q[1], q[2]); m.lookAt(q[3], q[4], q[5]); }); for (let i = s.pr.length; i < g._rk.length; i++) g._rk[i].visible = false;
  g._dr ||= []; s.dr.forEach((q, i) => { const m = g._dr[i] ||= (() => { const t = g.assets.gltf.fpv_drone?.scene; const mm = t ? t.clone(true) : new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.4)); mm.scale.setScalar(1.3); g.scene.add(mm); return mm; })(); m.visible = true; m.position.set(q[0], q[1], q[2]); m.quaternion.set(q[3], q[4], q[5], q[6]); }); for (let i = s.dr.length; i < g._dr.length; i++) g._dr[i].visible = false;
  { // the drones as the joiner's drone view needs them (ui/droneFeed.js: own side only); one per FPV team, gone = impact / lost
    const M = g._netDrones ||= new Map(), now = performance.now(), live = new Set();
    for (const q of s.dr) { const id = q[7]; if (id == null) continue; live.add(id); let e = M.get(id);
      if (!e) M.set(id, e = { net: true, id, pos: new THREE.Vector3(q[0], q[1], q[2]), vel: new THREE.Vector3(), aim: new THREE.Vector3(), t: s.t, rt: now });
      else { const ddt = s.t - e.t; if (ddt > 0.01) { e.vel.set((q[0] - e.pos.x) / ddt, (q[1] - e.pos.y) / ddt, (q[2] - e.pos.z) / ddt); e.pos.set(q[0], q[1], q[2]); e.t = s.t; e.rt = now; } }
      e.aim.set(q[8], q[9], q[10]); e.phase = DRONE_PHASE[q[11]] || 'cruise'; e.jam = !!q[12]; e.age = q[13] || 0; e.num = q[14] || 0; e.sq = g.netMap.get(id); }
    for (const k of [...M.keys()]) if (!live.has(k)) M.delete(k);
  }
  if (s.over && !g.over) { g.over = true; const r = s.over; g.result = { ...r, win: !r.win, title: r.win ? 'DEFEAT' : 'VICTORY', why: r.why }; g.hud?.showEnd(g.result); }
  clientSmooth(g, dt);
}
// every frame: ease toward the last snapshot, animate, sync, local cosmetics (exhaust, engine sound)
function clientSmooth(g, dt) {
  const k = Math.min(1, dt * 10);
  for (const sq of g._netSq || []) for (const so of sq.soldiers) {
    if (so._np) { so.pos.lerp(so._np, k); so.heading += Math.atan2(Math.sin(so._nh - so.heading), Math.cos(so._nh - so.heading)) * k; }
    so.animate(dt, g.camDist(so.pos)); so.sync();
  }
  for (const v of g.vehicles) {
    if (!v._np) continue;
    v.pos.lerp(v._np, k); v.heading += Math.atan2(Math.sin(v._nh - v.heading), Math.cos(v._nh - v.heading)) * k; v.dist = (v.dist || 0) + (v.speed || 0) * dt;
    v.sync(); if (!v.destroyed) v.fx?.(dt);
    // fire damage / wreck (vehicle.update does it on the host): the paint burns from the fire point, a tossed turret falls
    if (v.destroyed) v.updateWreck?.(dt); else if (v.burning > 0) v.burnLook?.(dt);
  }
}
