// Vehicle upgrade kits: visible field modifications on the battle vehicles (and in the campaign tech tree's 3D
// preview) for the upgrades the player's brigade has received (src/campaign/v2/tech.js KITS):
//   cage     anti-drone screen over the turret (posts + mesh grid); on hulls that already carry a cage in the model
//            (T-72B3, BMP-3, Msta-S) hanging nets / chains around it instead
//   roof     full-length screen over the hull and engine deck (tanks)
//   era      reactive-armour bricks on the glacis and the turret front (placed by ray casts against the real surfaces)
//   sandbags sandbags along the hull sides (wheeled) / spare track links on the glacis and turret sides (tracked)
//   sight    thermal gunner-sight housing on the turret roof
//   ew       jammer box with whip antennas on the turret roof
//   smoke    clusters of smoke-grenade tubes on the turret front corners
//   crew     (no visual)
// Geometry is procedural and sized per vehicle from the model's own meshes (bounding quantiles and ray hits), so it
// fits every GLB in assets/vehicles. Kit meshes are leaves parented to the `hull` / `turret` EMPTIES: they traverse
// with the turret, are hidden with the intact hull when the wreck is shown, and never touch the LOD lists or the
// hatch-lid / door nodes. Battle effects: applyKitFx (cage chance, ERA, side armour, sight, smoke, mobility).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KITS } from '../campaign/v2/tech.js';

const SKIP = /_LOD1$|_wreck$|antenna|aerial/i;
const GEAR = /^(wheel_|roadwheel_|sprocket_|idler_|track_|return_)/i;
let MATS = null;
function mats() {
  if (MATS) return MATS;
  const M = (color, rough = 0.85, metal = 0.25, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
  MATS = { steel: M(0x3d4130, 0.8, 0.35), mesh: M(0x2f3226, 0.9, 0.3, { side: THREE.DoubleSide }), era: M(0x50563b, 0.75, 0.2), bag: M(0x8b7d58, 1, 0), link: M(0x34322c, 0.7, 0.6), box: M(0x3b3f2e, 0.7, 0.3), glass: M(0x0b0d10, 0.15, 0.6), net: M(0x5a5a3e, 1, 0, { side: THREE.DoubleSide, transparent: true, opacity: 0.85 }) };
  return MATS;
}

// ---------------------------------------------------------------- measuring the model
// meshes under `node` (LOD0, intact: not under a *_LOD1 / *_wreck / hidden group — by name, not by .visible, which
// the LOD switch toggles), stopping at subtrees `stop` rejects
function under(node, stop) { const out = []; node?.traverse(o => { if (!o.isMesh || o.userData?.kit) return; let p = o; while (p && p !== node) { if (stop(p) || SKIP.test(p.name) || p.userData?.hidden) return; p = p.parent; } out.push(o); }); return out; }
function pointsIn(meshes, space, max = 1500) {
  const inv = new THREE.Matrix4().copy(space.matrixWorld).invert(), v = new THREE.Vector3(), xs = [], ys = [], zs = [];
  for (const o of meshes) { const pa = o.geometry.attributes.position, step = Math.max(1, Math.floor(pa.count / max)); const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld); for (let i = 0; i < pa.count; i += step) { v.fromBufferAttribute(pa, i).applyMatrix4(m); xs.push(v.x); ys.push(v.y); zs.push(v.z); } }
  const q = (a, f) => { if (!a.length) return 0; const s = [...a].sort((p, r) => p - r); return s[Math.floor(f * (s.length - 1))]; };
  return { n: xs.length, q: (axis, f) => q(axis === 'x' ? xs : axis === 'y' ? ys : zs, f) };
}
export function measure(model) {
  model.updateMatrixWorld(true);
  const N = n => model.getObjectByName(n);
  const hull = N('hull') || model, turret = N('turret'), gun = N('gun_pivot');
  const cageMesh = N('cope_cage');
  const hullMeshes = under(hull, p => p === turret || GEAR.test(p.name) || /cope_cage|hatch_lid|door|ramp/i.test(p.name));
  const turMeshes = turret ? under(turret, p => p === gun || /cope_cage|hatch_lid/i.test(p.name)) : [];
  const H = pointsIn(hullMeshes, hull), T = turret ? pointsIn(turMeshes, turret) : null;
  return { hull, turret, gun, hullMeshes, turMeshes, H, T, hasCage: !!cageMesh && cageMesh.visible !== false };
}

// ---------------------------------------------------------------- geometry helpers
function bar(geos, a, b, r = 0.02) {
  const L = a.distanceTo(b); if (L < 1e-3) return;
  const g = new THREE.BoxGeometry(r * 2, r * 2, L); g.lookAt(new THREE.Vector3().subVectors(b, a)); g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); geos.push(g);
}
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = new THREE.Vector3(0, 1, 0);
function placeOn(geo, space, hit, lift = 0.02, spin = 0) {
  // geometry built around the origin with its thin axis along +Y: lay it on the surface hit (world) in `space` local
  const inv = new THREE.Matrix4().copy(space.matrixWorld).invert();
  const p = hit.point.clone().applyMatrix4(inv);
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).transformDirection(inv).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, n); if (spin) q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, spin));
  geo.applyQuaternion(q); geo.translate(p.x + n.x * lift, p.y + n.y * lift, p.z + n.z * lift); return n;
}
function cast(meshes, space, from, dir) {
  const rc = new THREE.Raycaster(); const o = from.clone().applyMatrix4(space.matrixWorld), d = dir.clone().transformDirection(space.matrixWorld);
  rc.set(o, d); rc.far = 20; const h = rc.intersectObjects(meshes, false); return h.find(x => x.face) || null;
}
function mesh(geos, mat, name) { if (!geos.length) return null; const m = new THREE.Mesh(mergeGeometries(geos.map(g => g.index ? g.toNonIndexed() : g)), mat); m.name = name; m.castShadow = true; m.userData.kit = true; return m; }

// ---------------------------------------------------------------- the kits
function cageFrame(geos, x0, x1, z0, z1, base, top, posts = true) {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, ix = (x1 - x0) * 0.32, iz = (z1 - z0) * 0.32;
  if (posts) for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(geos, V3(cx + sx * ix, base, cz + sz * iz), V3(cx + sx * (x1 - x0) / 2, top, cz + sz * (z1 - z0) / 2), 0.026);
  for (const z of [z0, z1]) bar(geos, V3(x0, top, z), V3(x1, top, z), 0.025);
  for (const x of [x0, x1]) bar(geos, V3(x, top, z0), V3(x, top, z1), 0.025);
  const nx = Math.max(2, Math.round((x1 - x0) / 0.3)), nz = Math.max(2, Math.round((z1 - z0) / 0.4));
  for (let i = 1; i < nx; i++) { const x = x0 + (x1 - x0) * i / nx; bar(geos, V3(x, top, z0), V3(x, top, z1), 0.012); }
  for (let i = 1; i < nz; i++) { const z = z0 + (z1 - z0) * i / nz; bar(geos, V3(x0, top, z), V3(x1, top, z), 0.011); }
}
const BUILD = {
  cage(M, out) {
    const S = M.turret && M.T?.n > 20 ? { node: M.turret, P: M.T } : { node: M.hull, P: M.H };
    const P = S.P, roof = P.q('y', 0.9), x0 = P.q('x', 0.03) - 0.18, x1 = P.q('x', 0.97) + 0.18, z0 = P.q('z', 0.03) - 0.25, z1 = P.q('z', 0.97) + 0.2;
    if (M.hasCage) {
      // the model has its cage: hang nets / chain curtains from its rim (rim ~0.45 m over the roof)
      const geos = [], top = roof + 0.42, y0 = roof - 0.12;
      const strip = (x, z, rot) => { const g = new THREE.PlaneGeometry(0.22, top - y0, 1, 1); g.rotateY(rot); g.translate(x, (top + y0) / 2, z); geos.push(g); };
      for (let x = x0 + 0.15; x <= x1 - 0.1; x += 0.3) { strip(x, z1 + 0.04, 0); strip(x, z0 - 0.04, 0); }
      for (let z = z0 + 0.15; z <= z1 - 0.1; z += 0.3) { strip(x1 + 0.04, z, Math.PI / 2); strip(x0 - 0.04, z, Math.PI / 2); }
      const fr = []; cageFrame(fr, x0 - 0.04, x1 + 0.04, z0 - 0.04, z1 + 0.04, top, top, false);
      out.push([S.node, mesh(geos, mats().net, 'kit_cage_nets')], [S.node, mesh(fr, mats().steel, 'kit_cage_rim')]);
      return;
    }
    const geos = []; cageFrame(geos, x0, x1, z0, z1, roof - 0.02, roof + 0.42);
    out.push([S.node, mesh(geos, mats().steel, 'kit_cage')]);
  },
  roof(M, out) {
    // engine-deck screen: posts on the hull edges up to just over the turret roof, grid from the turret back to the stern
    const P = M.H, deck = P.q('y', 0.85), x0 = P.q('x', 0.02) - 0.05, x1 = P.q('x', 0.98) + 0.05, zs = P.q('z', 0.02) - 0.1;
    const tb = M.turret && M.T?.n > 20 ? (() => { const v = new THREE.Vector3(0, 0, M.T.q('z', 0.03)).applyMatrix4(M.turret.matrix); return v.z - 0.15; })() : P.q('z', 0.5);
    const troof = M.turret && M.T?.n > 20 ? M.turret.position.y + M.T.q('y', 0.92) : deck + 0.6;
    const top = troof + 0.55, geos = [];
    for (const x of [x0, x1]) for (const z of [zs, (zs + tb) / 2, tb]) bar(geos, V3(x, deck - 0.05, z), V3(x * 0.96, top, z), 0.03);
    const fr = []; cageFrame(fr, x0, x1, zs, tb, top, top, false); geos.push(...fr);
    out.push([M.hull, mesh(geos, mats().steel, 'kit_roof')]);
    const sheet = new THREE.PlaneGeometry(x1 - x0, tb - zs, 1, 1); sheet.rotateX(-Math.PI / 2); sheet.translate((x0 + x1) / 2, top - 0.01, (zs + tb) / 2);
    out.push([M.hull, mesh([sheet], mats().net, 'kit_roof_net')]);
  },
  era(M, out) {
    const brick = () => { const g = new THREE.BoxGeometry(0.26, 0.07, 0.19); return g; };
    // glacis: rays from the front against the hull
    const P = M.H, geos = [], placed = [];
    const W = P.q('x', 0.98) - P.q('x', 0.02), y0 = P.q('y', 0.25), y1 = P.q('y', 0.9), zf = P.q('z', 0.995) + 2, zc = (P.q('z', 0.02) + P.q('z', 0.98)) / 2, L = P.q('z', 0.98) - P.q('z', 0.02);
    for (let y = y0; y <= y1; y += 0.1) for (let x = -W * 0.42; x <= W * 0.42; x += 0.29) {
      const h = cast(M.hullMeshes, M.hull, V3(x, y, zf), V3(0, 0, -1)); if (!h) continue;
      const p = h.point.clone().applyMatrix4(new THREE.Matrix4().copy(M.hull.matrixWorld).invert());
      if (p.z < zc + L * 0.22 || placed.some(q => q.distanceTo(p) < 0.2)) continue;
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld); if (n.clone().transformDirection(new THREE.Matrix4().copy(M.hull.matrixWorld).invert()).z < 0.25) continue;
      placed.push(p); const g = brick(); placeOn(g, M.hull, h, 0.035); geos.push(g);
    }
    out.push([M.hull, mesh(geos, mats().era, 'kit_era_hull')]);
    if (M.turret && M.T?.n > 20) {
      const T = M.T, tg = [], tp = [], gx = 0;
      const tx0 = T.q('x', 0.04), tx1 = T.q('x', 0.96), ty0 = T.q('y', 0.12), ty1 = T.q('y', 0.85), tzf = T.q('z', 0.995) + 2, tzc = (T.q('z', 0.03) + T.q('z', 0.97)) / 2;
      for (let y = ty0; y <= ty1; y += 0.1) for (let x = tx0; x <= tx1; x += 0.26) {
        if (Math.abs(x - gx) < 0.3) continue;
        const h = cast(M.turMeshes, M.turret, V3(x, y, tzf), V3(0, 0, -1)); if (!h) continue;
        const p = h.point.clone().applyMatrix4(new THREE.Matrix4().copy(M.turret.matrixWorld).invert());
        if (p.z < tzc || tp.some(q => q.distanceTo(p) < 0.19)) continue;
        tp.push(p); const g = brick(); placeOn(g, M.turret, h, 0.035); tg.push(g);
      }
      out.push([M.turret, mesh(tg, mats().era, 'kit_era_turret')]);
    }
  },
  sandbags(M, out, info) {
    const P = M.H, tracked = !info.wheeled, geos = [], placed = [];
    const xL = P.q('x', 0.995) + 2, xR = P.q('x', 0.005) - 2, z0 = P.q('z', 0.08), z1 = P.q('z', 0.92), ya = P.q('y', 0.4), yb = P.q('y', 0.64);   // below the deck edge: riders' legs hang over it
    const inv = new THREE.Matrix4().copy(M.hull.matrixWorld).invert();
    if (!tracked) {
      for (const [x, dx] of [[xL, -1], [xR, 1]]) for (let z = z0; z <= z1; z += 0.48) for (const y of [ya, (ya + yb) / 2]) {
        const h = cast(M.hullMeshes, M.hull, V3(x, y, z), V3(dx, 0, 0)); if (!h) continue;
        const p = h.point.clone().applyMatrix4(inv); if (placed.some(q => q.distanceTo(p) < 0.3)) continue; placed.push(p);
        const g = new THREE.BoxGeometry(0.46, 0.2, 0.3, 2, 1, 1); const pa = g.attributes.position; for (let i = 0; i < pa.count; i++) { const yy = pa.getY(i); pa.setY(i, yy * (1 - 0.35 * Math.abs(pa.getX(i)) / 0.23)); }   // pillow shape
        placeOn(g, M.hull, h, 0.09, Math.PI / 2 + (Math.random() - 0.5) * 0.2); geos.push(g);
      }
      out.push([M.hull, mesh(geos, mats().bag, 'kit_sandbags')]);
      return;
    }
    // tracked: spare track links on the lower glacis and on the turret sides
    const link = () => { const g = new THREE.BoxGeometry(0.56, 0.05, 0.16); const horn = new THREE.BoxGeometry(0.05, 0.08, 0.08); horn.translate(0, 0.05, 0); return mergeGeometries([g.toNonIndexed(), horn.toNonIndexed()]); };
    const zf = P.q('z', 0.995) + 2, zc = (P.q('z', 0.02) + P.q('z', 0.98)) / 2, L = P.q('z', 0.98) - P.q('z', 0.02), W = P.q('x', 0.98) - P.q('x', 0.02);
    for (let y = P.q('y', 0.2); y <= P.q('y', 0.6); y += 0.09) for (const x of [-W * 0.22, W * 0.22]) {
      const h = cast(M.hullMeshes, M.hull, V3(x, y, zf), V3(0, 0, -1)); if (!h) continue;
      const p = h.point.clone().applyMatrix4(inv); if (p.z < zc + L * 0.22 || placed.some(q => q.distanceTo(p) < 0.15)) continue; placed.push(p);
      const g = link(); placeOn(g, M.hull, h, 0.03); geos.push(g);
    }
    out.push([M.hull, mesh(geos, mats().link, 'kit_links_hull')]);
    if (M.turret && M.T?.n > 20) {
      const T = M.T, tg = [], tp = [], tinv = new THREE.Matrix4().copy(M.turret.matrixWorld).invert();
      for (const [x, dx] of [[T.q('x', 0.995) + 2, -1], [T.q('x', 0.005) - 2, 1]]) for (let z = T.q('z', 0.2); z <= T.q('z', 0.7); z += 0.19) {
        const h = cast(M.turMeshes, M.turret, V3(x, T.q('y', 0.5), z), V3(dx, 0, 0)); if (!h) continue;
        const p = h.point.clone().applyMatrix4(tinv); if (tp.some(q => q.distanceTo(p) < 0.15)) continue; tp.push(p);
        const g = link(); placeOn(g, M.turret, h, 0.03, Math.PI / 2); tg.push(g);
      }
      out.push([M.turret, mesh(tg, mats().link, 'kit_links_turret')]);
    }
  },
  sight(M, out) {
    const S = M.turret && M.T?.n > 20 ? { node: M.turret, P: M.T } : { node: M.hull, P: M.H };
    const P = S.P, roof = P.q('y', 0.93), x = P.q('x', 0.22), z = P.q('z', 0.78);
    const body = new THREE.BoxGeometry(0.34, 0.3, 0.42); body.translate(x, roof + 0.15, z);
    const hood = new THREE.BoxGeometry(0.38, 0.04, 0.5); hood.translate(x, roof + 0.32, z + 0.03);
    const base = new THREE.CylinderGeometry(0.12, 0.15, 0.08, 10); base.translate(x, roof + 0.02, z);
    out.push([S.node, mesh([body, hood, base], mats().box, 'kit_sight')]);
    const lens = new THREE.BoxGeometry(0.26, 0.2, 0.02); lens.translate(x, roof + 0.15, z + 0.22);
    out.push([S.node, mesh([lens], mats().glass, 'kit_sight_lens')]);
  },
  ew(M, out) {
    const S = M.turret && M.T?.n > 20 ? { node: M.turret, P: M.T } : { node: M.hull, P: M.H };
    const P = S.P, roof = P.q('y', 0.93), x = P.q('x', 0.7), z = P.q('z', 0.2), geos = [];
    const box = new THREE.BoxGeometry(0.5, 0.24, 0.36); box.translate(x, roof + 0.12, z); geos.push(box);
    const fin = new THREE.BoxGeometry(0.52, 0.02, 0.3); for (let i = 0; i < 4; i++) { const f = fin.clone(); f.translate(x, roof + 0.05 + i * 0.05, z); geos.push(f); }
    for (const [dx, dz, hgt] of [[-0.18, -0.12, 1.3], [0.18, -0.12, 1.1], [-0.18, 0.12, 0.9], [0.18, 0.12, 1.2]]) { const a = new THREE.CylinderGeometry(0.008, 0.014, hgt, 5); a.translate(x + dx, roof + 0.24 + hgt / 2, z + dz); geos.push(a); const b = new THREE.CylinderGeometry(0.025, 0.025, 0.05, 6); b.translate(x + dx, roof + 0.25, z + dz); geos.push(b); }
    out.push([S.node, mesh(geos, mats().box, 'kit_ew')]);
  },
  smoke(M, out) {
    const S = M.turret && M.T?.n > 20 ? { node: M.turret, P: M.T } : { node: M.hull, P: M.H };
    const P = S.P, y = P.q('y', 0.7), z = P.q('z', 0.7), geos = [];
    for (const [sx, x] of [[-1, P.q('x', 0.02)], [1, P.q('x', 0.98)]]) {
      for (let i = 0; i < 4; i++) {
        const t = new THREE.CylinderGeometry(0.045, 0.045, 0.28, 8); t.rotateX(Math.PI / 2 - 0.5); t.rotateY(-sx * (0.35 + i * 0.18)); t.translate(x + sx * 0.08, y + (i % 2) * 0.1, z - Math.floor(i / 2) * 0.1); geos.push(t);
      }
      const plate = new THREE.BoxGeometry(0.06, 0.24, 0.32); plate.translate(x + sx * 0.02, y + 0.05, z - 0.05); geos.push(plate);
    }
    out.push([S.node, mesh(geos, mats().link, 'kit_smoke')]);
  },
  crew() {},
};

// ---------------------------------------------------------------- public API
// add the kit meshes for `kits` to a vehicle model (a clone of the GLB scene); returns the meshes. info.wheeled: BTR /
// Bohdana style hull (sandbags rather than track links).
export function attachKits(model, kits, info = {}) {
  removeKits(model);
  if (!kits?.length) return [];
  const M = measure(model); if (!M.H.n) return [];
  const out = [], made = [];
  for (const k of [...new Set(kits)]) { const n0 = out.length; try { BUILD[k]?.(M, out, info); } catch (e) { console.warn('vehicleKit', k, e); } for (const e of out.slice(n0)) if (e[1]) e[1].userData.kitId = k; }
  for (const [parent, m] of out) { if (!m || !parent) continue; parent.add(m); made.push(m); }
  return made;
}
export function removeKits(model) { const old = []; model.traverse(o => { if (o.userData?.kit) old.push(o); }); for (const o of old) { o.parent?.remove(o); o.geometry?.dispose?.(); } }

// battle effects of the kits on one vehicle (KITS[k].fx summed); idempotent
export function applyKitFx(v, kits) {
  if (v.kitFx || !kits?.length) return;
  const fx = {}; for (const k of new Set(kits)) for (const [a, b] of Object.entries(KITS[k]?.fx || {})) fx[a] = (fx[a] || 0) + b;
  v.kits = [...new Set(kits)]; v.kitFx = fx;
  if (fx.cage) v.cage = Math.min(0.7, (v.cage || 0) + fx.cage);   // capped: screens and jammers never make a vehicle drone-proof
  if (fx.speed || fx.accel || fx.turret) {
    v.def = { ...v.def };
    if (fx.speed) v.def.speed *= 1 + fx.speed;
    if (fx.accel) v.def.accel *= 1 + fx.accel;
    if (fx.turret && v.def.turretSpeed) v.def.turretSpeed *= 1 + fx.turret;
  }
  if ((fx.era || fx.side) && v.zones) {
    v.zones = v.zones.map(z => ({ ...z, faces: Object.fromEntries(Object.entries(z.faces).map(([f, a]) => [f, { ...a, ...(a.era ? { era: { ...a.era } } : {}) }])) }));
    for (const z of v.zones) {
      if (/track|wheel|tow|ammo|engine|crew|driver|gunner|commander/i.test(z.name)) continue;
      const fr = z.faces.front;
      if (fx.era && fr && !/rear|body|bonnet/.test(z.name)) {
        if (fr.era) { fr.era.ce = Math.round(fr.era.ce * 1.15); fr.era.ke = Math.round((fr.era.ke || 0) * 1.1); }
        else fr.era = { ke: v.kind === 'tank' ? 60 : 10, ce: v.kind === 'tank' ? 300 : 200 };
        v.eraLeft[z.name + ':front'] = 1;
      }
      const sd = z.faces.side;
      if (fx.side && sd && !/turret|era_/.test(z.name)) { sd.ce += fx.side; sd.ke += Math.round(fx.side * 0.25); }
    }
  }
  if (fx.smoke) {
    v.smokeLeft = fx.smoke; let lastHp = v.hp; const up = v.update.bind(v), g = v.game;
    v.update = dt => {
      up(dt);
      if (v.smokeLeft > 0 && !v.destroyed && v.hp < lastHp - 1 && g.time > (v.smokeT || 0)) {
        v.smokeLeft--; v.smokeT = g.time + 15;
        const a = v.heading + (v.turretYaw || 0), p = v.pos.clone().add(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)).multiplyScalar(16));
        g.fx?.smokeScreen?.(p); const o = g.nav?.addOccluder?.(p.x, p.z, 7, 7, 0, 7, null); if (o) o.smokeUntil = g.time + 30;
        g.sfx?.('grenade_throw', v.pos);
      }
      lastHp = v.hp;
    };
  }
  if (fx.sight) patchSights(v.game);
}
// stabilised thermal sight: shots on the move sometimes without the movement penalty, a better first round on a
// new target (tank / 100 mm guns). Wraps the combat calls once per game.
function patchSights(g) {
  const C = g?.combat; if (!C || C._kitSight) return; C._kitSight = true;
  const wrap = (fn, tank) => function (v, ...a) {
    const s = v?.kitFx?.sight || 0; if (!s) return fn.call(this, v, ...a);
    const t = tank ? a[0] : a[1];
    if (tank && t && v.lastTarget !== t && Math.random() < s) { v.lastTarget = t; v.rangedShots = 0; }
    if (Math.abs(v.speed) > 1 && Math.random() < s) { const sp = v.speed; v.speed = 0; try { return fn.call(this, v, ...a); } finally { v.speed = sp; } }
    return fn.call(this, v, ...a);
  };
  if (C.fireTankGun) C.fireTankGun = wrap(C.fireTankGun, true);
  if (C.fireVehicleGun) C.fireVehicleGun = wrap(C.fireVehicleGun, false);
}

// a battle vehicle: visuals + effects for its side's campaign kits (game.mods[side].kits[kind]); idempotent.
// Called from the Vehicle constructor (src/game/vehicle.js) and from campaignBattle.applyMods.
export function applyVehicleKits(v) {
  if (v.kitDone || v.fallback) return; const kits = v.game?.mods?.[v.side]?.kits?.[v.kind]; if (!kits?.length) return;
  v.kitDone = true;
  if (kits.includes('cage') && v.cageMesh) { v.cageMesh.parent?.remove(v.cageMesh); v.cageMesh = null; v.cage = 0; }   // the random field cage gives way to the issued one
  try { attachKits(v.model, kits, { wheeled: !!v.def?.wheeled || v.kind === 'btr', kind: v.kind }); } catch (e) { console.warn('vehicleKit attach', e); }
  applyKitFx(v, kits);
}
