"""models_v11 manifest entries: runs v10_manifest.main(build dir) (re-reads the shipped GLBs: nodes, tris, presets), then
prepends the v11 note to soldier_<fac>.v6_notes and writes id_tape_notes (read-modify-write under manifest.json.lock).
run after copying the WebP'd GLBs to assets/soldiers/:  python3 tools/blender/soldiers/v11_manifest.py [build dir with combos_<fac>.json]"""
import os, sys, json, fcntl
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import v10_manifest as V10M

V11 = ("v11 (2026-11): no national flag patches anywhere (uniform left-sleeve pocket, crew coverall sleeve, UA admin pouch, UA "
       "ruck / assault-pack velcro fields - the velcro fields stay, bare): identification is the tape only; FAST high-cut NVG "
       "shock cords rebuilt (kit.nvg_cords: one 4.4 mm round cord per side from a hook on the shroud's side edge, tight along the "
       "shell over the ARC rail to a rear hook beside the counterweight - shortest path on the shell, 2.7 mm centre-line height). ")

TAPE = ("Identification tape (v11): the only side marking on the men.  Recolourable `tape` material (soldier.js tints it to "
        "FACTIONS.<side>.tape) on armband_L / armband_R (two wraps round each upper arm), legband_R (right thigh, every preset) "
        "and legband_L (some presets), the RU 6B7 helmet band and the tape strip on the back of the UA FAST-type cover; combos "
        "carry it in <combo>_tape.  2023-24 practice: UA blue (yellow in 2022), RU white (red in some sectors).")


def main():
    V10M.main()
    mp = os.path.join(V10M.ASSETS, 'manifest.json')
    with open(mp + '.lock', 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        m = json.load(open(mp))
        for fac in ('ua', 'ru'):
            e = m[f'soldier_{fac}']
            s = e.get('v6_notes', '').replace(V11, '')          # (re-runs: v10_manifest prepends its own text again)
            while s.startswith(V10M.V10 + V10M.V10):
                s = s[len(V10M.V10):]
            e['v6_notes'] = V11 + s
            e['id_tape_notes'] = TAPE
        tmp = mp + '.tmp_v11'
        json.dump(m, open(tmp, 'w'), indent=1)
        os.replace(tmp, mp)
    print('v11 notes written')


if __name__ == '__main__':
    main()
