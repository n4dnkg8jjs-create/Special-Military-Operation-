"""models_v12 manifest entries: runs v11_manifest.main() (-> v10_manifest.main(build dir): re-reads the shipped GLBs: nodes, tris,
presets; v11 notes), then prepends the v12 note to soldier_<fac>.v6_notes and writes uniform_notes / back_kit_notes
(read-modify-write under manifest.json.lock).
run after copying the WebP'd GLBs to assets/soldiers/:  python3 tools/blender/soldiers/v12_manifest.py [build dir with combos_<fac>.json]"""
import os, sys, json, fcntl
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import v11_manifest as V11M
V10M = V11M.V10M

V12 = ("v12 (2026-11): field uniform rebuilt as a separate JACKET and TROUSERS (garment.py): seams / panels / camo print follow real "
       "garment construction as smooth analytic lines instead of the jagged UV-island borders; jacket worn out over the trousers "
       "with its hem at hip level (rolled edge + shadow), belt over the jacket at the waist, trousers a little darker; folds only "
       "where cloth bunches; back kit (rucksack, assault pack, hydration pouch) seated on the plate-carrier back with the carrier's "
       "own per-vertex weights. ")

UNIFORM = ("Uniform (v12, garment.py + uniform_tex.bake_uniform + build_soldier.thicken_uniform): BDU-type field jacket (two fronts with a "
           "centre zip under a placket, back + back yoke, set-in sleeves with one underarm seam, stand collar, cuffs, sleeve pockets, "
           "elbow patches, hem at y 0.895 m) worn out over field trousers (front / back panels per leg joined by out- and inseam, "
           "crotch seam, thigh cargo pockets, knee reinforcements, bloused into the boots); 45 mm belt with buckle over the jacket "
           "(y 0.983-1.028 m).  The camo is printed per garment panel (cut from one bolt, grain along the panel) so the print breaks "
           "exactly on the seams.  Shell: the jacket rides >= 5.5 mm over the trousers at the hem.  Folds only inside the elbows, "
           "behind the knees, at the crotch, round the belt, behind the shoulders, at the sleeve ends and the boot blousing.  "
           "Crew presets keep their one-piece coveralls (crew.py), as real AFV crews wear.")

BACK = ("Back kit (v12, packs.seat_on_carrier): rucksack, assault pack and back hydration pouch are conformed to the plate carrier's "
        "back (ray-cast gap field, smooth cubic fit, inner face on the carrier; median gap ~3-7 mm, was 10-21 mm with the top edge "
        "standing up to 5 cm off) and take, per vertex, the carrier-back weights under them (they stay on it in every pose).")


def main():
    V11M.main()
    mp = os.path.join(V10M.ASSETS, 'manifest.json')
    with open(mp + '.lock', 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        m = json.load(open(mp))
        for fac in ('ua', 'ru'):
            e = m[f'soldier_{fac}']
            s = e.get('v6_notes', '').replace(V12, '')
            e['v6_notes'] = V12 + s
            e['uniform_notes'] = UNIFORM
            e['back_kit_notes'] = BACK
        tmp = mp + '.tmp_v12'
        json.dump(m, open(tmp, 'w'), indent=1)
        os.replace(tmp, mp)
    print('v12 notes written')


if __name__ == '__main__':
    main()
