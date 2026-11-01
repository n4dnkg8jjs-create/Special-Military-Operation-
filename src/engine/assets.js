import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as Fallback from './fallback.js';

// Loads GLB assets produced by tools/blender/*. Every asset has a procedural fallback so the game
// always runs; the HUD logs which ones were substituted.
const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();

async function tryJSON(url) { try { const r = await fetch(url); if (!r.ok) return null; return await r.json(); } catch { return null; } }
async function tryGLB(url) { try { const r = await fetch(url, { method: 'HEAD' }); if (!r.ok) return null; return await loader.loadAsync(url); } catch (e) { console.warn('GLB failed', url, e); return null; } }

export class Assets {
  constructor() { this.missing = []; this.gltf = {}; this.manifest = {}; this.kit = null; this.tex = {}; }

  async load(progress, renderer, opts = {}) {
    const jobs = [
      ['soldier_ua', 'assets/soldiers/soldier_ua.glb'], ['soldier_ru', 'assets/soldiers/soldier_ru.glb'],
      ['soldier_anims', 'assets/soldiers/soldier_anims.glb'],
      ['ak74m', 'assets/soldiers/ak74m.glb'], ['pkm', 'assets/soldiers/pkm.glb'], ['rpg7', 'assets/soldiers/rpg7.glb'],
      ['btr82a', 'assets/vehicles/btr82a.glb'], ['btr80_ua', 'assets/vehicles/btr80_ua.glb'],
      ['t72b3', 'assets/vehicles/t72b3.glb'], ['t72av_ua', 'assets/vehicles/t72av_ua.glb'],
      ['panel_kit', 'assets/env/panel_kit.glb'], ['trees', 'assets/env/trees.glb'], ['wires', 'assets/env/wires.glb'], ['props', 'assets/env/props.glb'], ['city', 'assets/env/city.glb'], ['rpg22', 'assets/soldiers/rpg22.glb'], ['pm', 'assets/soldiers/pm.glb'], ['ak12', 'assets/soldiers/ak12.glb'], ['ak74m_optic', 'assets/soldiers/ak74m_optic.glb'],
      // ATGM / FPV team props
      ['kornet', 'assets/soldiers/kornet.glb'], ['stugna', 'assets/soldiers/stugna.glb'], ['atgm_tube_carried', 'assets/soldiers/atgm_tube_carried.glb'],
      ['fpv_drone', 'assets/soldiers/fpv_drone.glb'], ['fpv_controller', 'assets/soldiers/fpv_controller.glb'], ['fpv_goggles', 'assets/soldiers/fpv_goggles.glb'],
    ];
    if (opts.rural) jobs.push(['farmland', 'assets/env/farmland.glb']); else jobs.push(['modern', 'assets/env/modern.glb']);
    for (const m of ['soldiers', 'vehicles', 'env']) this.manifest[m] = (await tryJSON(`assets/${m}/manifest.json`)) || {};
    // rubble files are discovered from the env manifest (or a default list)
    const rubbleList = (this.manifest.env.rubble_files) || ['rubble_1', 'rubble_2', 'rubble_3', 'rubble_4', 'rubble_5', 'rubble_6'];
    for (const r of rubbleList) jobs.push([r, `assets/env/${r}.glb`]);
    let done = 0;
    await Promise.all(jobs.map(async ([k, url]) => {
      const g = await tryGLB(url);
      if (g) { this.gltf[k] = g; g.scene.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); }
      else this.missing.push(k);
      progress(++done / (jobs.length + 6), k);
    }));
    this.rubbleKeys = rubbleList.filter(k => this.gltf[k]);
    // tiling textures
    for (const t of ['asphalt', 'concrete', 'brick', 'dirt', 'rubble', 'grass']) {
      this.tex[t] = await this.loadTexSet(t, renderer);
      progress(++done / (jobs.length + 6), t);
    }
    { const c = await this.loadTexSet('curb', renderer, true); if (c) this.tex.curb = c; }
    // farmland ground sets are optional (the ground shader has procedural fallbacks)
    if (opts.rural) for (const t of ['plowed', 'stubble', 'fallow', 'track']) { const s = await this.loadTexSet(t, renderer, true); if (s) this.tex[t] = s; }
    this.buildKit();
  }

  async loadTexSet(name, renderer, optional = false) {
    const base = `assets/textures/${name}`;
    const one = (suf, srgb) => new Promise(res => texLoader.load(`${base}_${suf}`, t => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      if (srgb) t.colorSpace = THREE.SRGBColorSpace; res(t);
    }, undefined, () => res(null)));
    const [map, normalMap, orm] = await Promise.all([one('albedo.jpg', true), one('normal.jpg'), one('orm.jpg')]);
    if (!map && optional) return null;
    if (!map) { this.missing.push('tex:' + name); return Fallback.textureSet(name, renderer); }
    return { map, normalMap, roughnessMap: orm, aoMap: orm, metalnessMap: null };
  }

  // Kit: name -> [{geometry, material}] normalised so that the *_intact variant's bbox has
  // minX=0, minY=0, maxZ=0 (bottom-left-outer pivot, outside facing +Z). Damage variants share the offset.
  buildKit() {
    const g = this.gltf.panel_kit;
    const kit = this.kit = { pieces: {}, W: 3.2, H: 2.8, T: 0.3, fallback: !g };
    const mk = this.manifest.env.kit || this.manifest.env.module || {};
    if (mk.width || mk.W) kit.W = mk.width || mk.W;
    if (mk.height || mk.floor_height || mk.H) kit.H = mk.height || mk.floor_height || mk.H;
    if (mk.thickness || mk.T) kit.T = mk.thickness || mk.T;
    if (!g) { kit.pieces = Fallback.panelKit(kit); return; }
    g.scene.updateMatrixWorld(true);
    const raw = {};
    g.scene.traverse(o => {
      if (!o.isMesh) return;
      // piece name = nearest ancestor that is a direct child of the scene (or the mesh itself)
      let p = o; while (p.parent && p.parent !== g.scene) p = p.parent;
      const name = p.name.replace(/\.\d+$/, '');
      const geo = o.geometry.clone(); geo.applyMatrix4(o.matrixWorld);
      // remove the piece's own world placement (kit pieces may be laid out in a row in the file)
      (raw[name] ||= { root: p, parts: [] }).parts.push({ geometry: geo, material: o.material });
    });
    // undo the piece root translation so each piece is at its own origin
    for (const [name, r] of Object.entries(raw)) {
      const inv = new THREE.Matrix4().makeTranslation(-r.root.position.x, -r.root.position.y, -r.root.position.z);
      for (const pt of r.parts) pt.geometry.applyMatrix4(inv);
    }
    const bboxOf = parts => { const b = new THREE.Box3(); for (const p of parts) { p.geometry.computeBoundingBox(); b.union(p.geometry.boundingBox); } return b; };
    const offsets = {};
    for (const name of Object.keys(raw)) {
      const base = name.replace(/_(intact|damaged|holed|destroyed)(_v\d+)?$/, '');
      const ref = raw[base + '_intact'] || raw[name];
      if (!offsets[base]) {
        const b = bboxOf(ref.parts), sz = b.getSize(new THREE.Vector3());
        // accessories hang outside the facade: centre them on the module and start at the wall face
        const acc = /^(balcony|entrance_canopy|sign_)/.test(base);
        const centred = /^(roof_machine_room|roof_vent|roof_antenna|collapse_pile|slab_hanging)/.test(base);
        offsets[base] = centred ? new THREE.Vector3(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2)
          : acc ? new THREE.Vector3((kit.W - sz.x) / 2 - b.min.x, -b.min.y, -b.min.z) : new THREE.Vector3(-b.min.x, -b.min.y, -b.max.z);
        offsets[base].size = sz;
      }
      for (const pt of raw[name].parts) { pt.geometry.translate(offsets[base].x, offsets[base].y, offsets[base].z); pt.geometry.computeBoundingBox(); pt.geometry.computeBoundingSphere(); }
      kit.pieces[name] = raw[name].parts;
      kit.pieces[name].size = offsets[base].size;
    }
    const wi = kit.pieces.wall_window_intact;
    if (wi && !(mk.width || mk.W)) { kit.W = +wi.size.x.toFixed(3); kit.H = +wi.size.y.toFixed(3); kit.T = +wi.size.z.toFixed(3); }
    // fill in any missing piece from the fallback set
    const fb = Fallback.panelKit(kit);
    for (const k of Object.keys(fb)) if (!kit.pieces[k]) { kit.pieces[k] = fb[k]; this.missing.push('kit:' + k); }
  }

  // Named node lookup in an asset scene (exact, then prefix match).
  static node(root, name) {
    let f = root.getObjectByName(name); if (f) return f;
    root.traverse(o => { if (!f && o.name && o.name.toLowerCase().startsWith(name.toLowerCase())) f = o; });
    return f;
  }
}
