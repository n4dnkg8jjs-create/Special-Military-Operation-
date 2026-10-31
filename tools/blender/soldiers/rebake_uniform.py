"""Re-bake only the uniform camo textures cached in .cache/body.pkl (stage 1 output) without rebuilding the bodies.
Same inputs / seeds as stage_body.py.   run: python3 tools/blender/soldiers/rebake_uniform.py ru [ua]"""
import sys, os, pickle, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import uniform_tex as UT

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.cache')
TOPS = {'ru': {'A': 'camo', 'B': 'camo', 'C': 'camo'}, 'ua': {'A': 'camo', 'B': 'camo', 'C': 'multicam'}}

if __name__ == '__main__':
    facs = sys.argv[1:] or ['ru']
    t0 = time.time()
    R = pickle.load(open(f'{OUT}/body.pkl', 'rb'))
    U = R['uniform']; vA = R['variants']['A']
    mesh = dict(pos=vA['uniform_pos'], nrm=vA['uniform_nrm'], uv=U['uv'], tri=U['tri'])
    for fac in facs:
        for top in sorted(set(TOPS[fac].values())):
            alb, nrm, _ = UT.bake_uniform(mesh, R['skel'], U['labels'], fac, 'A', top=top, seed=7 if fac == 'ru' else 9)
            R['tex'][(fac, top)] = (alb, nrm)
            print('re-baked uniform', (fac, top), round(time.time() - t0, 1))
    pickle.dump(R, open(f'{OUT}/body.pkl.tmp', 'wb'))
    os.replace(f'{OUT}/body.pkl.tmp', f'{OUT}/body.pkl')
    print('body.pkl written', round(time.time() - t0, 1))
