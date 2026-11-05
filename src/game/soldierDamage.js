import * as THREE from 'three';

// Dynamic damage on soldiers (v6): blood soaking into the uniform at the hit, torn cloth at the wound, bandages / tourniquets
// once treated, mud picked up crawling / lying / being dragged, soot and rips from blasts.  Dying and dead men keep it all.
//
// Cost: no per-soldier (or per-hit) material clones and no extra uniform uploads.  The soldier atlas / uniform materials are
// patched once (shared program); each soldier's wound data rides in 4 extra "data bones" appended to the skeleton of its
// skinned meshes: they are not in the scene graph, their matrixWorld holds raw floats, and the existing per-skeleton bone
// texture (already uploaded every frame for skinning; 31 -> 35 bones keeps it 12 x 12 texels) carries them to the shader.
// Wound positions are in the mesh's bind space (bind pose, metres, +Y up, +Z front), so the stains stay on the cloth
// through every clip, the ragdoll and LODs.  Undamaged soldiers cost two texel fetches per vertex and a uniform branch.

export const MAX_WOUNDS = 4;
const DATA_BONES = 4;           // 3 bones = 12 texels = 4 wounds x 3 vec4, 1 bone = global (mud, rips, soot, back mud | count, ...)
const PATCH = new WeakSet();
const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
// wound codes (vec4 slot 2 .w = code + blood amount * 0.99)
const T_OPEN = 0, T_GAUZE = 1, T_TQ_BLACK = 2, T_OLIVE = 3, T_TQ_RUBBER = 4;
// limb segments: [from bone, to bone, cloth radius (m)]
const SEG = {
  armL: ['LeftArm', 'LeftForeArm', 0.055], foreL: ['LeftForeArm', 'LeftHand', 0.047], armR: ['RightArm', 'RightForeArm', 0.055], foreR: ['RightForeArm', 'RightHand', 0.047],
  thighL: ['LeftUpLeg', 'LeftLeg', 0.08], shinL: ['LeftLeg', 'LeftFoot', 0.058], thighR: ['RightUpLeg', 'RightLeg', 0.08], shinR: ['RightLeg', 'RightFoot', 0.058],
};
const UPPER = { foreL: 'armL', foreR: 'armR', shinL: 'thighL', shinR: 'thighR' };

const GLSL_COMMON = /* glsl */`
varying vec3 vDmgP; varying vec4 vDmgW; varying vec4 vDmgB; varying vec4 vDmgC; varying vec4 vDmgG; varying vec4 vDmgH;`;
const GLSL_VERT = /* glsl */`
#ifdef USE_SKINNING
{
  int dsz = textureSize( boneTexture, 0 ).x;
  #define DMG_T(i) texelFetch( boneTexture, ivec2( ( DMG_BASE * 4 + (i) ) % dsz, ( DMG_BASE * 4 + (i) ) / dsz ), 0 )
  vec4 dw = vec4( 9.0 ), db = vec4( 9.0 ), dc = vec4( 0.0 );
  vDmgP = position; vDmgG = DMG_T( 12 ); vDmgH = DMG_T( 13 );
  int nw = int( vDmgH.x + 0.5 );
  for ( int k = 0; k < 4; k ++ ) {
    if ( k >= nw ) break;
    vec4 a = DMG_T( 3 * k ), b = DMG_T( 3 * k + 1 ), c = DMG_T( 3 * k + 2 );
    if ( a.w > 0.0 ) { vec3 d = position - a.xyz; d.y *= d.y < 0.0 ? 0.5 : 1.25; dw[ k ] = length( d ) / a.w; }   // blood runs down
    if ( b.w > 0.0 ) { float cut = length( c.xyz ); vec3 ax = c.xyz / cut; vec3 q = position - b.xyz; float s = dot( q, ax ); db[ k ] = max( abs( s ) / b.w, length( q - s * ax ) / cut ); }
    dc[ k ] = c.w;
  }
  vDmgW = dw; vDmgB = db; vDmgC = dc;
  #undef DMG_T
}
#else
vDmgP = position; vDmgW = vec4( 9.0 ); vDmgB = vec4( 9.0 ); vDmgC = vec4( 0.0 ); vDmgG = vec4( 0.0 ); vDmgH = vec4( 0.0 );
#endif`;
const GLSL_FRAG_PARS = /* glsl */`
float dmgH( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
float dmgN( vec3 x ) {
  vec3 i = floor( x ), f = fract( x ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( dmgH( i ), dmgH( i + vec3( 1, 0, 0 ) ), f.x ), mix( dmgH( i + vec3( 0, 1, 0 ) ), dmgH( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
              mix( mix( dmgH( i + vec3( 0, 0, 1 ) ), dmgH( i + vec3( 1, 0, 1 ) ), f.x ), mix( dmgH( i + vec3( 0, 1, 1 ) ), dmgH( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}`;
// injected after <metalnessmap_fragment>: roughnessFactor is known there and tells cloth (rough, ~0.9) from skin / plastic / metal
// (the atlas packs them all in one texture)
const GLSL_FRAG = /* glsl */`
{
  float cloth = smoothstep( 0.68, 0.8, roughnessFactor ) * ( 1.0 - metalnessFactor );
  vec3 col = diffuseColor.rgb;
  // per-soldier wear: sun-faded / washed-out cloth and a slight tone shift (variety between men of one preset, no texture cost)
  float lum = dot( col, vec3( 0.3, 0.55, 0.15 ) );
  col = mix( col, vec3( lum ) * vec3( 1.06, 1.03, 0.94 ) + 0.012, vDmgH.y * cloth );
  col *= 1.0 + vDmgH.z * cloth * vec3( 0.05, 0.0, -0.05 );
  float dmgWet = 0.0, dmgDry = 0.0;
  if ( vDmgG.x + vDmgG.y + vDmgG.z + vDmgG.w + vDmgC.x + vDmgC.y + vDmgC.z + vDmgC.w > 0.0 ) {
    vec3 P = vDmgP;
    float n1 = dmgN( P * 23.0 ), n2 = dmgN( P * 67.0 + 7.3 ), nn = n1 * 0.65 + n2 * 0.35;
    float cm = 0.4 + 0.6 * cloth;
    // mud: caked low on the legs / knees, spattered higher up; on the back for men who lay / were dragged
    float low = clamp( ( 0.80 - P.y ) / 0.65, 0.0, 1.0 );
    float back = clamp( ( 0.02 - P.z ) * 9.0, 0.0, 1.0 );
    float mud = vDmgG.x * ( 0.25 + 0.75 * low ) * smoothstep( 0.62 - 0.45 * vDmgG.x, 0.9 - 0.45 * vDmgG.x, nn );
    mud = max( mud, vDmgG.w * back * smoothstep( 0.35, 0.65, n1 ) ) * cm;
    col = mix( col, col * vec3( 0.50, 0.43, 0.33 ) + vec3( 0.022, 0.016, 0.009 ), clamp( mud, 0.0, 1.0 ) );
    dmgDry = mud;
    // blast: soot and small rips (dark holes with frayed light edges)
    col = mix( col, vec3( 0.014, 0.013, 0.012 ), vDmgG.z * smoothstep( 0.4, 0.8, n1 + 0.25 * n2 ) * 0.85 );
    float rip = vDmgG.y * ( 0.3 + 0.7 * low ) * cloth;
    float rn = dmgN( P * 41.0 + 3.1 );
    col = mix( col, col * 1.35 + 0.03, rip * smoothstep( 0.79, 0.81, rn ) * ( 1.0 - smoothstep( 0.835, 0.845, rn ) ) );
    col = mix( col, vec3( 0.03, 0.012, 0.008 ), rip * smoothstep( 0.835, 0.845, rn ) );
    for ( int k = 0; k < 4; k ++ ) {
      float code = vDmgC[ k ]; if ( code <= 0.0 ) continue;
      float type = floor( code ), amt = fract( code );
      // blood soaked into the cloth: dark wet red-brown core, browner dried rim, ragged edge
      float d = vDmgW[ k ] + ( nn - 0.5 ) * 0.55;
      float bl = amt * ( 1.0 - smoothstep( 0.62, 1.0, d ) );
      float wetc = amt * ( 1.0 - smoothstep( 0.2, 0.7, d ) );
      col = mix( col, col * vec3( 0.40, 0.13, 0.10 ) + vec3( 0.030, 0.003, 0.002 ), bl );
      col = mix( col, vec3( 0.045, 0.004, 0.003 ), wetc * 0.75 );
      dmgWet = max( dmgWet, max( bl * 0.55, wetc ) );
      // torn cloth at the wound (open wounds only)
      float hole = amt * ( 1.0 - step( 0.2 + 0.06 * amt, vDmgW[ k ] + ( n2 - 0.5 ) * 0.3 ) );
      if ( type < 0.5 ) { col = mix( col, vec3( 0.06, 0.01, 0.006 ), hole ); }
      // bandage / tourniquet band
      float bd = vDmgB[ k ] + ( n2 - 0.5 ) * 0.07;
      if ( bd < 1.0 ) {
        vec3 bc = type < 1.5 ? vec3( 0.50, 0.47, 0.38 ) : type < 2.5 ? vec3( 0.018, 0.018, 0.017 ) : type < 3.5 ? vec3( 0.075, 0.085, 0.05 ) : vec3( 0.32, 0.075, 0.03 );
        bc *= 0.85 + 0.3 * n1;
        float wrap = 0.5 + 0.5 * sin( ( P.x + P.y * 3.1 + P.z ) * 260.0 );                        // wraps / folds
        bc *= 0.85 + 0.15 * wrap;
        float seep = ( type < 1.5 || ( type > 2.5 && type < 3.5 ) ) ? amt * 0.8 * ( 1.0 - smoothstep( 0.1, 0.8, vDmgW[ k ] + ( n1 - 0.5 ) * 0.6 ) ) : 0.0;
        bc = mix( bc, vec3( 0.13, 0.012, 0.008 ), seep );
        col = bc; dmgWet = type > 1.5 && type < 2.5 ? 0.35 : seep * 0.5; dmgDry = 0.0;
      }
    }
    roughnessFactor = mix( mix( roughnessFactor, 1.0, dmgDry * 0.6 ), 0.3, clamp( dmgWet, 0.0, 1.0 ) );
    metalnessFactor *= 1.0 - clamp( dmgWet + dmgDry, 0.0, 1.0 );
  }
  diffuseColor.rgb = col;
}`;

function patchMaterial(mat, base) {
  if (PATCH.has(mat)) return; PATCH.add(mat);
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.defines = { ...(mat.defines || {}), SOLDIER_DMG: '', DMG_BASE: base };
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>' + GLSL_COMMON).replace('#include <skinning_vertex>', '#include <skinning_vertex>' + GLSL_VERT);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>' + GLSL_COMMON + GLSL_FRAG_PARS)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>' + GLSL_FRAG);
  };
  mat.customProgramCacheKey = () => 'soldier_dmg' + base + (prev ? '|' + prevKey() : '');
  mat.needsUpdate = true;
}

const isDamageMat = m => /^soldier_atlas|_camo$|^skin_/.test(m?.name || '');

// The damage state of one soldier model.  meshes: its SkinnedMeshes (all LODs); faction: 'UA' | 'RU'
export class DamageSkin {
  constructor(meshes, faction = 'UA', rnd = Math.random) {
    this.faction = faction; this.rnd = rnd;
    this.bones = Array.from({ length: DATA_BONES }, (_, i) => { const b = new THREE.Bone(); b.name = '__dmg' + i; b.matrixWorldAutoUpdate = false; b.matrixAutoUpdate = false; b.matrixWorld.elements.fill(0); return b; });
    this.wounds = []; this.mud = 0; this.rips = 0; this.soot = 0; this.backMud = 0;
    // variety: sun-faded / washed cloth, warm-cool tone shift, some men already muddy
    this.fade = rnd() < 0.6 ? 0.05 + 0.3 * rnd() : 0; this.tint = (rnd() - 0.5) * 2;
    if (rnd() < 0.35) this.mud = 0.08 + 0.2 * rnd();
    this.ref = null;
    for (const o of meshes) {
      if (!o.isSkinnedMesh || !o.skeleton) continue;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (!mats.some(isDamageMat)) continue;
      const sk = o.skeleton, n = sk.bones.length;
      if (sk.bones.some(b => b.name === '__dmg0')) continue;
      mats.forEach(m => { if (isDamageMat(m)) patchMaterial(m, n); });
      const inv = sk.boneInverses.concat(this.bones.map(() => new THREE.Matrix4()));
      o.skeleton = new THREE.Skeleton(sk.bones.concat(this.bones), inv);
      if (!this.ref) this.ref = { mesh: o, sk: o.skeleton, n };
    }
    this.active = !!this.ref;
    this.flush();
  }
  // bind-space position of a bone's head
  bindPos(name, out = new THREE.Vector3()) {
    const { mesh, sk, n } = this.ref;
    const i = sk.bones.findIndex((b, k) => k < n && b.name === name); if (i < 0) return null;
    _m.copy(sk.boneInverses[i]).invert().premultiply(mesh.bindMatrixInverse);
    return out.setFromMatrixPosition(_m);
  }
  // region: head | torso | arm | leg | limb | thigh | shin | upperarm | fore | blast | helmet | plate.  dir: unit vector in bind space (x right-left, z front) toward
  // the shooter (null = random).  Returns the wound or null.
  addWound(region, dir = null, opt = {}) {
    if (!this.active) return null;
    const R = this.rnd;
    if (region === 'helmet' || region === 'plate') { this.rips = Math.min(1, this.rips + 0.05); this.flush(); return null; }   // stopped: scuff only
    if (region === 'blast') {
      this.soot = Math.min(1, this.soot + 0.55 + 0.3 * R()); this.rips = Math.min(1, this.rips + 0.5 + 0.3 * R()); this.mud = Math.min(1, this.mud + 0.35);
      const k = 1 + (R() < 0.6 ? 1 : 0) + (opt.dead ? 1 : 0);
      for (let i = 0; i < k; i++) this.addWound(R() < 0.65 ? 'leg' : R() < 0.5 ? 'torso' : 'arm', dir, { ...opt, frag: true });
      return this.wounds[this.wounds.length - 1] || null;
    }
    if (!dir) { const a = R() * Math.PI * 2; dir = _a.set(Math.sin(a), 0, Math.cos(a)); }
    let w;
    if (region === 'head') {
      const h = this.bindPos('Head', _v); if (!h) return null;
      w = { c: h.clone().add(new THREE.Vector3(dir.x * 0.08, 0.06, dir.z * 0.09)), r: 0.07, seg: null };
    } else if (region === 'torso') {
      const hip = this.bindPos('Hips', new THREE.Vector3()), nk = this.bindPos('Neck', new THREE.Vector3()); if (!hip || !nk) return null;
      const t = 0.22 + 0.55 * R(), ang = Math.atan2(dir.x, dir.z) + (R() - 0.5) * 1.6;
      const c = hip.clone().lerp(nk, t); c.x += Math.sin(ang) * 0.17; c.z += Math.cos(ang) * 0.15;   // on the plate carrier / jacket surface
      w = { c, r: 0.085 + 0.03 * R(), seg: null, out: new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang)) };
    } else {
      const side = R() < 0.5 ? 'L' : 'R';
      const kind = { thigh: 'thigh', shin: 'shin', upperarm: 'arm', fore: 'fore' }[region] ||
        (region === 'leg' || (region === 'limb' && R() < 0.55) ? (R() < 0.6 ? 'thigh' : 'shin') : (R() < 0.55 ? 'arm' : 'fore'));
      const seg = kind + side, [b0, b1, rad] = SEG[seg];
      const A = this.bindPos(b0, new THREE.Vector3()), B = this.bindPos(b1, new THREE.Vector3()); if (!A || !B) return null;
      const ax = B.clone().sub(A), len = ax.length(); ax.divideScalar(len);
      const p = A.clone().addScaledVector(ax, len * (0.25 + 0.5 * R()));
      // radial direction: toward the shooter, perpendicular to the limb, jittered
      const rd = dir.clone().addScaledVector(ax, -dir.dot(ax)); if (rd.lengthSq() < 1e-4) rd.set(1, 0, 0).addScaledVector(ax, -ax.x);
      rd.normalize().applyAxisAngle(ax, (R() - 0.5) * 1.8);
      w = { c: p.clone().addScaledVector(rd, rad * 0.95), r: (opt.frag ? 0.05 : 0.06) + rad * 0.4 + 0.02 * R(), seg, axP: p, ax, rad };
    }
    w.blood = opt.dead ? 0.85 : 0.55 + 0.2 * R(); w.type = T_OPEN; w.r0 = w.r; w.grow = 0; w.band = null;
    if (this.wounds.length >= MAX_WOUNDS) { // merge: grow the nearest one instead
      let best = null, bd = 1e9; for (const o of this.wounds) { const d = o.c.distanceTo(w.c); if (d < bd && o.type === T_OPEN) { bd = d; best = o; } }
      if (best) { best.blood = Math.min(1, best.blood + 0.2); best.r = Math.min(best.r0 * 1.8, best.r * 1.15); }
      this.flush(); return best;
    }
    this.wounds.push(w); this.flush(); return w;
  }
  // bleeding: stains spread (up to ~1.7x) and darken
  bleed(dt, rate = 1) {
    let ch = false;
    for (const w of this.wounds) if (w.type === T_OPEN && w.r < w.r0 * 1.7) { w.r = Math.min(w.r0 * 1.7, w.r + w.r0 * 0.012 * dt * rate); w.blood = Math.min(1, w.blood + 0.01 * dt * rate); ch = true; }
    return ch;
  }
  // first aid: bandage every open wound; tourniquet (high and tight on the limb) on bad limb wounds
  treat(tourniquet = false) {
    const R = this.rnd, add = [];
    for (const w of this.wounds) {
      if (w.type !== T_OPEN) continue;
      w.type = this.faction === 'UA' && R() < 0.55 ? T_OLIVE : T_GAUZE;
      if (w.seg) {
        w.band = { p: w.axP, ax: w.ax, hw: 0.045 + 0.015 * R(), cut: w.rad + 0.035 };
        if (tourniquet) {
          const up = UPPER[w.seg] || w.seg, [b0, b1, rad] = SEG[up];
          const A = this.bindPos(b0, new THREE.Vector3()), B = this.bindPos(b1, new THREE.Vector3());
          if (A && B) { const ax = B.clone().sub(A), len = ax.length(); ax.divideScalar(len); add.push({ c: A.clone(), r: 0, type: this.faction === 'RU' && R() < 0.5 ? T_TQ_RUBBER : T_TQ_BLACK, blood: 0, band: { p: A.clone().addScaledVector(ax, len * 0.2), ax, hw: 0.02, cut: rad + 0.03 } }); }
        }
      } else if (w.out) w.band = { p: w.c, ax: w.out, hw: 0.05, cut: 0.065 + 0.01 * R() };   // dressing pad on the torso
      else w.band = { p: w.c, ax: new THREE.Vector3(0, 1, 0), hw: 0.035, cut: 0.13 };       // head wrap
    }
    for (const t of add) if (this.wounds.length < MAX_WOUNDS) this.wounds.push(t);
    this.flush();
  }
  // write everything into the data bones (matrixWorld elements: texel t = elements 4t..4t+3)
  flush() {
    if (!this.active) return;
    const E = this.bones.map(b => b.matrixWorld.elements);
    for (const e of E) e.fill(0);
    const put = (t, x, y, z, w) => { const e = E[t >> 2], o = (t & 3) * 4; e[o] = x; e[o + 1] = y; e[o + 2] = z; e[o + 3] = w; };
    this.wounds.forEach((w, k) => {
      put(3 * k, w.c.x, w.c.y, w.c.z, w.r);
      const b = w.band;
      if (b) { put(3 * k + 1, b.p.x, b.p.y, b.p.z, b.hw); put(3 * k + 2, b.ax.x * b.cut, b.ax.y * b.cut, b.ax.z * b.cut, w.type + Math.min(0.99, w.blood * 0.99) + 1e-4); }
      else put(3 * k + 2, 0, 0, 1, w.type + Math.min(0.99, w.blood * 0.99) + 1e-4);
    });
    put(12, this.mud, this.rips, this.soot, this.backMud);
    put(13, this.wounds.length, this.fade, this.tint, 0);
  }
}

// ---------------------------------------------------------------- soldier glue
// Called every frame from Soldier.animate (cheap: compares numbers).  Hits are detected from hp drops / state changes, so
// every damage source (rifle fire, blasts, burning vehicles, network joiners) leaves a mark; combat.hitSoldier can say where
// it hit (soldier.lastHit = { region, from, blast }).
export function damageTick(s, dt) {
  const D = s.dmg; if (!D?.active) return;
  const st = s.state;
  if (s._dmgHp === undefined) { s._dmgHp = s.hp; s._dmgSt = st; }
  let ch = false;
  const hit = s.hp < s._dmgHp - 0.5 || (st !== s._dmgSt && (st === 'light' || st === 'critical' || (st === 'dead' && !D.wounds.length)));
  if (hit && st !== 'evac') {
    const h = s.lastHit; s.lastHit = null;
    let region = h?.region || (st === 'dead' && s.deathInfo?.head ? 'head' : st === 'dead' && s.deathInfo?.blast ? 'blast' : s.legWound ? 'leg' : Math.random() < 0.5 ? 'torso' : 'limb');
    if (st === 'dead' && s.deathInfo?.head && !h) region = 'head';
    let dir = null;
    const f = h?.from || s.deathInfo?.from;
    if (f) {   // shooter direction in the model's frame (model faces +Z; root rotation.y = heading)
      const dx = f.x - s.pos.x, dz = f.z - s.pos.z, c = Math.cos(-s.heading), sn = Math.sin(-s.heading), l = Math.hypot(dx, dz);
      if (l > 0.1) dir = _b.set((dx * c + dz * sn) / l, 0, (-dx * sn + dz * c) / l);
    }
    D.addWound(region, dir, { dead: st === 'dead' });
    s._dmgSelfAid = st === 'light' ? 15 + Math.random() * 25 : null;
  }
  if (st !== s._dmgSt) {
    if (st === 'stable') { D.treat(true); D.backMud = Math.max(D.backMud, 0.5); D.rips = Math.max(D.rips, 0.25); ch = true; }   // clothing cut open for the dressing
    if (st === 'critical' || st === 'dead') { D.backMud = Math.max(D.backMud, 0.35); ch = true; }
  }
  s._dmgHp = s.hp; s._dmgSt = st;
  // light wounded: field dressing after a while (self / buddy aid)
  if (s._dmgSelfAid != null && st === 'light') { s._dmgSelfAid -= dt; if (s._dmgSelfAid <= 0) { s._dmgSelfAid = null; D.treat(false); } }
  // slow changes, flushed at most every 0.5 s
  s._dmgAcc = (s._dmgAcc || 0) + dt;
  if (s._dmgAcc > 0.5) {
    const a = s._dmgAcc; s._dmgAcc = 0;
    if (st === 'critical') ch = D.bleed(a, s.dragger ? 2 : 1) || ch;
    else if (st === 'dead' && (s.deathT || 0) < 25) ch = D.bleed(a, 0.6) || ch;
    // crawling / prone / being dragged: mud
    const lying = st === 'critical' || st === 'stable' || s.stance === 'prone';
    const mv = s.vel ? s.vel.length() : 0;
    if (lying && D.mud < (st === 'ok' || st === 'light' ? 0.55 : 0.85)) { D.mud = Math.min(1, D.mud + a * (mv > 0.05 || s.dragger ? 0.02 : 0.004)); ch = true; }
    if ((s.dragger || st === 'critical') && D.backMud < 0.9) { D.backMud = Math.min(0.9, D.backMud + a * (s.dragger ? 0.05 : 0.01)); ch = true; }
    if (ch) D.flush();
  } else if (ch) D.flush();
}
