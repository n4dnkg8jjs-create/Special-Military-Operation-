"""models_v13 manifest entries: runs v12_manifest.main() (-> v11 / v10: re-reads the shipped GLBs: nodes, tris, presets), then
fixes the uniform note (no belt over the jacket any more), prepends the v13 note to soldier_<fac>.v6_notes and writes
kit_fit_notes (read-modify-write under manifest.json.lock).
run after copying the WebP'd GLBs to assets/soldiers/:  python3 tools/blender/soldiers/v13_manifest.py [build dir with combos_<fac>.json]"""
import os, sys, json, fcntl
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import v12_manifest as V12M
V10M = V12M.V10M

V13 = ("v13 (2026-11): plate-carrier shoulder straps seated on the jacket per body variant and per column (no gap); the trouser "
       "belt is hidden under the jacket hem (no belt drawn on the jacket); vest kit clipping / warping fixed (touching rigid kit "
       "shares one weight set, back kit rigid behind its contact face, re-spaced pouches). ")

KIT = ("Kit fit (v13): kit.shoulder_strap(percol=True) fits each of the 3 strap columns to the jacket under it; kit.strap_field moves "
       "the straps (+ PTT / cables / ruck straps riding on them) onto each preset's body variant in combo.make (combo strap gap "
       "median ~0.5-2 mm on bodies A/B, 2-7 mm on C, was 2-19 mm).  build_soldier.rigid_kit_weights: every rigid unit (pouch "
       "assembly with its mags / flaps / buckles, radio + pouch + knobs, PTT, side armour pieces) is skinned rigidly; units that "
       "touch on the front + sides share ONE weight set (the carrier under their footprint) so stacked pouches cannot slide into "
       "each other; back kit takes the carrier's per-vertex weights only at its contact face and is rigid 1-7 cm behind it (small "
       "attached items rigid; warp <= 9 mm, was up to 49 mm).  Assault presets: one grenade pouch per side (the pairs sat 25 mm in "
       "the mag shingle), UA admin pouch / tourniquet clear of the mag bases, RU radio / grenade pouch clear of the mag flaps, RU "
       "dump pouch clear of the hydration carrier / assault pack.")


def main():
    V12M.main()
    mp = os.path.join(V10M.ASSETS, 'manifest.json')
    with open(mp + '.lock', 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        m = json.load(open(mp))
        for fac in ('ua', 'ru'):
            e = m[f'soldier_{fac}']
            s = e.get('v6_notes', '').replace(V13, '')
            s = s.replace('with its hem at hip level (rolled edge + shadow), belt over the jacket at the waist,',
                          'with its hem at hip level (rolled edge + shadow; the trouser belt is under it - v13),')
            e['v6_notes'] = V13 + s
            e['uniform_notes'] = e.get('uniform_notes', '').replace(
                '45 mm belt with buckle over the jacket (y 0.983-1.028 m)',
                'the trouser belt (y 0.983-1.028 m) is hidden under the jacket (v13: no belt drawn on the jacket, soft drawcord '
                'gathers at the waist)')
            e['kit_fit_notes'] = KIT
        tmp = mp + '.tmp_v13'
        json.dump(m, open(tmp, 'w'), indent=1)
        os.replace(tmp, mp)
    print('v13 notes written')


if __name__ == '__main__':
    main()
