Environment asset pipeline (run from this folder, Blender 5.2 bpy module, `nice -n 10`):
  python3 gen_ground_textures.py   -> assets/textures/{asphalt,concrete,brick,dirt,rubble}_{albedo.jpg,normal.png,orm.png}
                                      (then the PNG->JPG step of tools/optimize_assets.sh: normal 2048^2 JPG, ORM 1024^2 JPG).
                                      dirt (6 m tile, base soil of the city + farmland ground shaders): dry dusty chernozem/loam
                                      built in soil_tex.py (crumb aggregates, clods, cracked crust plates, grit/gravel/stones,
                                      straw, twigs, leaf flakes, sparse damp spots; low macro contrast so it does not tile visibly)
  python3 build_kit.py             -> assets/env/panel_kit.glb (+ kit atlases in _cache/), then WebP q88 like
                                      tools/optimize_assets.sh: gltf-transform webp assets/env/panel_kit.glb (no quantisation).
                                      Three materials: kit_panel (kit_atlas.py), kit_city (city_kit_atlas.py), kit_damage
                                      (kit_damage_atlas.py). `--no-atlas` reuses the cached atlases.
                                      Damage variants <type>_holed_v2/_v3 and <type>_destroyed_v2/_v3 for every wall type
                                      (wall_window/balcony/blank_end/entrance, brick_*, brick_red_*, wall_shopfront*):
                                        kit_damage_design.py  outlines (shapely): voids, corner bites, spalls, through-cracks,
                                                              destroyed remnants (lintel band / kerb / side columns), fragments;
                                                              `python3 kit_damage_design.py` prints a summary
                                        kit_damage_atlas.py   kit_damage atlas: 7 x 8 facade cells 292 x 256, painted by the family
                                                              painters (paint_facade / paint_brick / paint_shop, `voids=` override)
                                        kit_damage.py         geometry: layered broken edges (panel: tile/outer concrete/mineral wool
                                                              step/inner leaf; brick: stepped courses), rebar cut at the edges, mesh
                                                              flaps, wool tufts, spall plugs, joinery remnants, chunks; destroyed
                                                              pieces framed by the ceiling-slab edge band, floor screed, transverse
                                                              wall ends (panels), hanging fragment on bar bundles.
                                                              structure_v1() adds the slab band / screed / wall ends to the v1
                                                              *_destroyed pieces too (not to the panels embedded in collapse piles).
                                      The game must normalise variants with the <type>_intact offset: buildKit base-name regex
                                      /_(intact|damaged|holed|destroyed)(_v\d+)?$/ (test_section.py already does).
  python3 build_rubble.py          -> assets/env/rubble_1..6.glb (needs kit atlas + ground textures)
  python3 build_rubble.py rubble_7 rubble_9  -> rebuild only those piles (rubble_7..12 = second set: big panel-slab heap,
                                      red-brick house collapse, mixed debris, slab ramp, wide low scatter, silicate-brick heap);
                                      then gltf-transform webp --quality 88 on the rebuilt files.  The game rasterises every pile
                                      into a height map (src/world/terrain.js templateHeights) -> city.groundHeight(x, z).
  python3 build_fortifications.py  -> assets/env/fortifications.glb (+ manifest 'fortifications'), then ./optimize_fortifications.sh
                                      (WebP + quantize, ~5.5 MB).  Dressing for the raw-earth trenches that terrain.js cuts into the
                                      ground (2023-25 look: patchy improvised scrap, not continuous revetment): rv_pallet / rv_door /
                                      rv_sheet / rv_ply / rv_branches / rv_logs / rv_mesh (natural size, origin bottom centre on the
                                      trench floor, face +Z; the game leans them back against the battered wall), floor_pallet,
                                      floor_planks, litter_a/b, ammo_crates, sandbag_row / sandbag_pile, debris_conc, overhead cover
                                      net_cover / branch_cover / tarp_cover / net_drone (long axis X along the trench, Z scaled to the
                                      width), dugout_roof(_b) (low overgrown log-and-earth roof + timbered doorway down to y=-1.7),
                                      mg_nest_roof, dragon_tooth(_b), dragon_tooth_rubble (blown-apart tooth: stump, slabs, lumps, bent rebar -- the
                                      game swaps teeth to _b / _rubble in place, City.damageFortAt); plus tree_*_mid mid-distance LODs of the farmland trees
                                      (build_forest_lods.py, same seeds as farmland.glb) used 58..210 m (windbreaks) / 12..175 m
                                      (forest).  Uses the cached farmland atlases + fort_atlas.py (material fort_extra: camo / drone
                                      net, wire mesh, tarps, plastic, OSB / plywood, cardboard, labels).  ONLY=a,b OUT=x.glb for QA.
  python3 build_trees.py           -> assets/env/trees.glb
  python3 build_wires.py           -> assets/env/wires.glb
  python3 build_props.py           -> assets/env/props.glb (then WebP the textures: gltf-transform webp --quality 88; NO
                                      quantisation -- props nodes are top-level meshes)
  python3 build_city.py            -> assets/env/city.glb (city_atlas.py -> _cache/city_atlas_*; REBUILD_ATLAS=1 to repaint;
                                      geometry helpers in city_geo.py; `python3 build_city.py house_ pipe_` -> previews/_test/city_test.glb)
                                     church_small is built in church.py on a 2nd material church_atlas (church_atlas.py -> _cache/church_atlas_*)
  python3 research.py              -> manifest research/module sections
QA: python3 test_section.py section|section2|gallery_<type>|accessories|misc|brick_white|brick_red|shops|collapse|street|
    variants_<type> (holed v1-v3 + destroyed v1-v3 in a row, with the game's interior slab + dark box)|vsection (panel facade
    mixing all variants)|vbrick_<brick|brick_red>  (re-imports panel_kit.glb, normalises like
assets.js buildKit(), assembles like buildings.js) -> previews/_test/*.glb ; subset.py extracts nodes for previews.
_cache/ holds generated intermediate textures (regenerated by the scripts).
Geometry QA / repair (all env builders except modern):
  python3 check_assets.py [glb ...] [-a regex] [-v] [--img DIR] [--json out.json]   (numpy/scipy, no Blender)
      per top-level node: back faces seen from outside (software z-buffer, 17 views; FrontSide => holes), open edges,
      inconsistent winding, inside-out shells, bbox min Y (float / sunk), parts hanging in the air (touch graph), z-fighting.
  meshfix.py: fix_mb(mb, skip_mats) is called on every MB right before to_object() in build_city/props/farmland/trees/
      wires/rubble: non-planar quads split on the short diagonal (twin quads no longer poke through), winding made
      consistent per patch, closed shells outward (volume), open patches oriented to the side visible from RTS camera
      directions (BVH rays), faces whose back is still visible get a reversed twin.  drop(mb, part) lets a part fall onto
      the mesh / ground (sandbags, debris, bricks, fallen sheets); settle_islands(mb) does it for whole debris piles.
Farmland (map 2, src/world/farmland.js):
  python3 gen_farm_ground.py       -> assets/textures/{plowed,stubble,fallow,track}_{albedo,normal,orm}.jpg (1024^2, ORM 512^2;
                                      plowed/stubble/fallow tile = 4 m with rows along V; track: U = 6.2 m strip width, V = 4.5 m;
                                      track is authored on an isotropic 1411 x 1024 grid with the dirt soil (soil_tex.py), ruts at
                                      u 0.36/0.64 with tractor-lug + car tread imprints, damp patches, dried mud crust, berms,
                                      grassy hump/verges, then resampled to 1024^2)
  Ground QA: previews/_test/ground_qa.html?tex=/assets/textures/dirt (city.js-like anti-tiling, 4 camera heights) or
      &tex=/assets/textures/track&ground=/assets/textures/dirt&tile=4.5&mode=strip  via node tools/preview.mjs "page:/previews/..." out.png
  python3 build_farmland.py        -> assets/env/farmland.glb + manifest 'farmland' section, then ./optimize_farmland.sh
                                      (WebP q88 + KHR_mesh_quantization, ~7 MB).  Modules: farmland_atlas.py (2048^2 opaque atlas,
                                      shares city_atlas regions), farmland_foliage.py (2048^2 RGBA alpha atlas: leaf clusters, twig
                                      sprays, far_* LOD clumps, crops, wattle, film), farmland_trees.py (trees/bushes + *_lod1, crops),
                                      farmland_geo.py (farm buildings, machinery, village props, earthworks).
                                      REBUILD_ATLAS=1 repaints both atlases; `python3 build_farmland.py tree_ bush_` -> previews/_test/
                                      farmland_test.glb subset ('name$' = exact); COMPARE=1 adds the city leafy_summer_* trees.
                                      Each asset is an empty named <asset id> with a child mesh <asset id>_geo (quantisation transform
                                      lands on the child, so farmland.js template instancing stays correct).
  QA: previews/_test/qa.html (game-like lighting; ?glb=..&place=name@x,z;..&cams=az,el,dist,tx,ty,tz;..) via
      node tools/preview.mjs "page:/previews/_test/qa.html?..." out.png
Burnt vehicles (all sets): burnt_tex.py burnt_steel() is the shared painter -- charcoal soot + grey-white ash / burnt primer,
  flaked grey steel with blue / violet / straw heat tint, only small rust streaks, optional blistered paint remnants, soot
  masks (plume() stamps soot rising over wheel arches / window openings).  Used by props_atlas (car_body / bus_body /
  rim / interior_burnt / chrome_burnt / new steel_burnt; steel_rust keeps the old rusty look for hedgehogs etc.),
  farmland_atlas (burnt_metal / burnt_paint / new burnt_ash for upper skins, hay_burnt) and modern_atlas.
  Tiled 1 m swatches use contrast ~0.3 / freq 0.5 so they do not read as camouflage; per-vehicle side-view regions use
  full contrast.  Vertex colours (COLOR_0) are linear multipliers: 0.5 only darkens ~25 % perceptually.
  NO_MANIFEST=1 skips the assets/env/manifest.json write in any builder (QA iterations).
Modern microdistrict (modern.glb, Ukraine 2022-24):
  python3 build_modern.py          -> assets/env/modern.glb + assets/env/modern_manifest.json, then ./optimize_modern.sh
                                      (WebP q88 + KHR_mesh_quantization, ~5 MB).  Modules: modern_atlas.py (2048^2 opaque
                                      atlas, 12 px wrap-padded gutters so tiled regions repeat without mip seams; car regions =
                                      side / top / front / rear views from the CARS spec; 1024^2 RGBA alpha atlas: anti-drone
                                      net, torn net, cracked / shot-out glass), modern_geo.py (kindergarten, boiler house,
                                      supermarket, pharmacy kiosk, garage row, window_sandbags + shared helpers: facade_wall /
                                      roof_plane / slab with holes, rubble, agrid alpha sheets), modern_props.py (cars / van /
                                      medevac / bus + burnt wrecks, street furniture, checkpoint, anti-drone net tunnel).
                                      Same node convention as farmland (empty <id> + child <id>_geo); origin = bbox centre of
                                      the intact asset (its _damaged / _burnt twin shares it), long axis X, cars front +X.
                                      `python3 build_modern.py car_ bus_` -> previews/_test/modern_test.glb subset ('' = all);
                                      REBUILD_ATLAS=1 repaints both atlases.
  QA: previews/_test/qa_modern.html = qa.html + &show=<regex> (only meshes whose own / ancestor name matches, e.g.
      show=_wreck for the vehicle wreck nodes).  Galleries in previews/_test/modern/.
