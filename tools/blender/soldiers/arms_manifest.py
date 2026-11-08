"""arms_v1 manifest entries (read-modify-write under manifest.json.lock), run after copying the GLBs to assets/soldiers/ and
v13_manifest.py (node lists / sizes):  python3 tools/blender/soldiers/arms_manifest.py [manifest with the v6_notes to keep]
 - soldier_ua / soldier_ru: v6_notes = the given (pre-run) notes with the arms_v1 note in front (v13_manifest re-prepends older
   notes on every run; the kept copy stops that growing), skeleton_notes (twist helpers)
 - soldier_anims: size_bytes, arms_v1 notes"""
import os, sys, json, fcntl
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.abspath(os.path.join(HERE, '../../../assets/soldiers'))

ARMS = ("arms_v1 (2026-11): four arm twist helper bones appended to the skeleton (LeftArmTwist / RightArmTwist: leaf children of "
        "*Arm 30 % down the upper arm; LeftForeArmTwist / RightForeArmTwist: leaf children of *ForeArm 55 % down the forearm); every "
        "skinned node's upper-arm / forearm weights are split onto them by position along the bone, so arm twist is spread along the "
        "limb instead of pinching the shoulder / elbow / wrist ring. ")
ARMS2 = ("arms_v2 (2026-11): arm volume - forearm twist in thirds, joint volume helpers (Left/RightElbowHelper, Left/RightShoulderHelper: "
         "rotation half way between the bones meeting there) carry the elbow / shoulder rings, elbow blend narrowed to +-2 cm, the "
         "trunk share of the sleeve ends 6 cm down the arm (tools/blender/soldiers/arm_volume.py: sleeve cross-sections thinner than "
         "85 % of the bind pose in 84 % of arm-frames -> 13 %, none thicker than 115 %); field jacket drapes from the chest to the hips "
         "(waist hollow filled up to 2.5 cm per body variant, +8 mm loose at the sides / back above the hem, hem standing off the hips), "
         "sleeves +2-3 mm, trouser thighs +3 mm ease. ")
SKEL = ("Skeleton: the 31 cmu_mb joints + 4 twist helpers (indices 31-34) + 4 joint volume helpers (35-38: Left/RightElbowHelper "
        "child of *Arm on the elbow = half the ForeArm local; Left/RightShoulderHelper child of *Shoulder on the shoulder joint = half of "
        "Arm local x ArmTwist local); all leaves, bind rotations identity like every joint. "
        "Helper drive (baked into every clip of soldier_anims.glb, re-evaluated at runtime by src/game/soldierPose.js driveTwist() "
        "after the procedural layers and by the ragdoll): ArmTwist local = rotation about the upper arm's rest axis by -0.5 x the "
        "Arm bone's local twist; ForeArmTwist local = rotation about the forearm's rest axis by 0.733 x the Hand bone's local twist "
        "about that axis (0.5 since arms_v2); both faded out from 100 to 180 deg.")
ANIMS = ("arms_v1 (2026-11): every clip's arms re-solved on export (tools/blender/soldiers/armfix.py, build_anims.write): hands keep "
         "their world transform (grips, props, contacts), the elbow swivel is chosen per frame (Viterbi over 72 candidates, smooth, "
         "ends pinned so loops / hand-overs match) against human joint ranges - upper-arm twist, forearm pronation / supination, wrist "
         "flexion / deviation, arm in the torso / ground, elbow pointing up, distance from the authored swivel; elbows are clean hinges "
         "(no sideways bend / hyperextension); the forearm twist is shared elbow 25 % / ForeArmTwist 80 % / hand 100 %; hands that "
         "stay outside the wrist range are turned back by at most 15 deg (left) per frame (wider in deaths / medevac / hatch / throw "
         "clips; right hand only there - it carries the weapon); clavicles <= 29.5 deg.  QA: tools/blender/soldiers/arms_check.py "
         "(arm side-frames outside the limits 68 % -> 31 %, summed excess -73 %).  Tracks for the 4 twist helpers added.")


def main():
    keep = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else None
    mp = os.path.join(ASSETS, 'manifest.json')
    with open(mp + '.lock', 'w') as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        m = json.load(open(mp))
        for fac in ('ua', 'ru'):
            e = m[f'soldier_{fac}']
            notes = (keep[f'soldier_{fac}'] if keep else e).get('v6_notes', '').replace(ARMS2, '').replace(ARMS, '')
            e['v6_notes'] = ARMS2 + ARMS + notes
            e['skeleton_notes'] = SKEL
        a = m['soldier_anims']
        a['size_bytes'] = os.path.getsize(os.path.join(ASSETS, 'soldier_anims.glb'))
        a['arms_v1'] = ANIMS
        a['arms_v2'] = ("arms_v2 (2026-11): forearm twist shared elbow 1/3 / ForeArmTwist 2/3 / hand 1; tracks for the joint volume "
                        "helpers Left/RightElbowHelper, Left/RightShoulderHelper (soldier_ua / soldier_ru skeleton_notes).")
        tmp = mp + '.tmp_arms'
        json.dump(m, open(tmp, 'w'), indent=1)
        os.replace(tmp, mp)
    print('arms_v1 notes written')


if __name__ == '__main__':
    main()
