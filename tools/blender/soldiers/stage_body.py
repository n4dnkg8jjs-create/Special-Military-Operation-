"""Stage 1: bodies.  Builds head/eyes/uniform/hands/gloves/boots for all variants & factions,
bakes textures, and caches everything to build/soldiers/body.pkl.

run:  nice -n 10 python3 tools/blender/soldiers/stage_body.py
"""
import sys, os, pickle, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import bl, body as BD, parts as PT, meshutil as MU, mhbody as M
import uniform_tex as UT, skin_tex as ST, tex as TX

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache')
os.makedirs(OUT, exist_ok=True)


def gl_normals(pos, tri):
    return MU.weld_normals(pos, MU.vertex_normals(pos, tri), 1e-5)


def main():
    t0 = time.time()
    B = BD.Base(); sets = BD.face_sets(B)
    res = dict(skel=B.skel, ground=B.ground)
    # ---------------- uniform topology / UVs from variant A
    UA = BD.add_collar_cuffs(B, BD.build_uniform(B, sets, B.vA))
    labs = BD.panel_labels(B, UA)
    L = {l: i for i, l in enumerate(sorted(set(labs)))}; IL = {i: l for l, i in L.items()}
    bl.reset()
    ob = bl.make_obj('uniform', UA['pos'], UA['faces'], face_attrs={'lab': [L[l] for l in labs]})
    bl.unwrap_with_labels(ob, [L[l] for l in labs], margin=0.006)
    um = bl.extract(ob, attrs=('lab',))
    tlabs = [IL[int(i)] for i in um['lab'][:, 0]]
    print('uniform tris', len(um['tri']), time.time() - t0)
    # ---------------- head / hands parts (decimated on A)
    head = PT.decimated_part(B, sets['head'], 0.32, 'head')
    hands = PT.decimated_part(B, sets['hand_L'] + sets['hand_R'], 0.25, 'hands')
    print('head', len(head['tri']), 'hands', len(hands['tri']))
    # eyes
    o = B.o
    eyes = []
    for g in ('helper-l-eye', 'helper-r-eye'):
        fs = [i for i, gg in enumerate(o['g']) if gg == g]
        src, F = BD.submesh(o['f'], fs)
        eyes.append((src, MU.triangulate(F)))
    # ---------------- boots (shared, built on A)
    bl.reset()
    boots = []
    for side in ('Left', 'Right'):
        bob = PT.build_boot_blender(B, side)
        sp, sf = PT.boot_sole(bob)
        bl.smart_uv(bob, 60, 0.02)
        m = bl.extract(bob)
        boots.append(dict(upper=m, sole=(sp, MU.triangulate(sf)), side=side))
    res['boots'] = boots
    # ---------------- per variant
    variants = {}
    for vn in ('A', 'B', 'C'):
        vdm = BD.human(vn)
        V = B.model(vdm)
        U = BD.add_collar_cuffs(B, BD.build_uniform(B, sets, V))
        upos = U['pos'][um['src']]
        hpos = PT.variant_positions(head, V)
        lm = ST.landmarks(vdm, B.ground)
        ep = []
        for src, T in eyes:
            p = V[src]
            ep.append(p)
        variants[vn] = dict(uniform_pos=upos, uniform_nrm=gl_normals(upos, um['tri']), head_pos=hpos,
                            head_nrm=gl_normals(hpos, head['tri']), eyes=ep, lm=lm, height=V[M.group_verts('body'), 1].max())
        print('variant', vn, 'height %.3f' % variants[vn]['height'], time.time() - t0)
    # weights
    res['uniform'] = dict(uv=um['uv'], tri=um['tri'], W=UA['W'][um['src']], labels=tlabs)
    res['head'] = dict(uv=head['uv'], tri=head['tri'], W=head['W'])
    res['hands'] = dict(pos=hands['pos'], nrm=gl_normals(hands['pos'], hands['tri']), uv=hands['uv'], tri=hands['tri'], W=hands['W'])
    res['eyes'] = [dict(tri=T, W=B.W[src]) for src, T in eyes]
    res['variants'] = variants
    # ---------------- textures
    texs = {}
    for fac, tops in (('ru', {'A': 'camo', 'B': 'camo', 'C': 'camo'}), ('ua', {'A': 'camo', 'B': 'camo', 'C': 'multicam'})):
        done = {}
        for vn in 'ABC':
            key = (fac, tops[vn])
            if key not in done:
                mesh = dict(pos=variants['A']['uniform_pos'], nrm=variants['A']['uniform_nrm'], uv=um['uv'], tri=um['tri'])
                alb, nrm, uvm = UT.bake_uniform(mesh, B.skel, tlabs, fac, 'A', top=tops[vn], seed=7 if fac == 'ru' else 9)
                done[key] = (alb, nrm)
                print('baked uniform', key, time.time() - t0)
            texs[('uniform', fac, vn)] = key
            texs[key] = done[key]
    for vn in 'ABC':
        v = variants[vn]
        mesh = dict(pos=v['head_pos'], nrm=v['head_nrm'], uv=head['uv'], tri=head['tri'])
        texs[('head', vn)] = ST.bake_head(mesh, v['lm'], vn, 1024, seed=ord(vn))
    texs['hands'] = ST.bake_hands(dict(pos=hands['pos'], uv=hands['uv'], tri=hands['tri']), ST.SKIN['A']['tone'])
    texs['eye'] = ST.eye_texture()
    res['tex'] = texs
    print('textures done', time.time() - t0)
    pickle.dump(res, open(f'{OUT}/body.pkl', 'wb'))


if __name__ == '__main__':
    main()
