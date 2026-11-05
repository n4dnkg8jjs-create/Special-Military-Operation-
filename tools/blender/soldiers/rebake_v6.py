"""soldiers_v6: re-bake the uniform textures (uniform_tex.bake_uniform, camo.py) WITHOUT rewriting the 460 MB body.pkl: the bakes go
to .cache/uniform_tex_v6.pkl, which build_soldier.load() applies over body.pkl's R['tex'] when present.
Mesh inputs (variant A bind pose, unthickened, UVs, labels, skeleton heads) are read from a small npz extracted from body.pkl
(created on first run).   run: python3 tools/blender/soldiers/rebake_v6.py [ru] [ua]"""
import sys, os, pickle, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import uniform_tex as UT

C = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache')
TOPS = {'ru': ('camo',), 'ua': ('camo', 'multicam')}


class _Sk:
    pass


def mesh_npz():
    f = f'{C}/uniform_mesh_v6.npz'
    if not os.path.exists(f):
        R = pickle.load(open(f'{C}/body.pkl', 'rb'))
        U = R['uniform']; vA = R['variants']['A']; sk = R['skel']
        np.savez(f, pos=vA['uniform_pos'], nrm=vA['uniform_nrm'], uv=U['uv'], tri=U['tri'], lab=np.array(U['labels']),
                 heads=sk.head, names=np.array(list(sk.idx.keys())), idxv=np.array(list(sk.idx.values())))
        del R
    z = np.load(f)
    sk = _Sk(); sk.head = z['heads']; sk.idx = {str(n): int(i) for n, i in zip(z['names'], z['idxv'])}
    return dict(pos=z['pos'], nrm=z['nrm'], uv=z['uv'], tri=z['tri']), list(z['lab']), sk


if __name__ == '__main__':
    facs = sys.argv[1:] or ['ru', 'ua']
    t0 = time.time()
    mesh, labels, sk = mesh_npz()
    out = pickle.load(open(f'{C}/uniform_tex_v6.pkl', 'rb')) if os.path.exists(f'{C}/uniform_tex_v6.pkl') else {}
    for fac in facs:
        for top in TOPS[fac]:
            alb, nrm, _ = UT.bake_uniform(mesh, sk, labels, fac, 'A', top=top, seed=7 if fac == 'ru' else 9)
            out[(fac, top)] = (alb.astype(np.float32), nrm)
            print('baked', fac, top, round(time.time() - t0, 1), flush=True)
            from PIL import Image
            Image.fromarray((np.clip(alb, 0, 1) * 255).astype(np.uint8)).resize((1024, 1024)).save(f'{C}/v6_uniform_{fac}_{top}.png')
    pickle.dump(out, open(f'{C}/uniform_tex_v6.pkl.tmp', 'wb')); os.replace(f'{C}/uniform_tex_v6.pkl.tmp', f'{C}/uniform_tex_v6.pkl')
    print('written', round(time.time() - t0, 1))
