"""Refresh only the weapon entries of assets/soldiers/manifest.json (read-modify-write) after weapons.py, without re-running
the whole soldier pipeline.  The same entries are produced by write_manifest.py on a full rebuild.
run: python3 tools/blender/soldiers/weapons_manifest.py"""
import os, sys, json, re, ast
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, '../../../assets/soldiers')
CACHE = os.path.join(HERE, '.cache')
WEAPONS = ('ak74m', 'pkm', 'rpg7', 'rpg22', 'ak12', 'ak74m_optic', 'grenade_f1', 'grenade_rgd5', 'pm')


def main():
    import write_manifest as WM
    src = open(os.path.join(HERE, 'write_manifest.py')).read()
    # the weapon reference texts live in write_manifest.main(): evaluate that dict literal so both stay identical
    i = src.index("'weapons': {'ak74m':"); j = src.index('{', i)
    depth = 0
    for k in range(j, len(src)):
        depth += src[k] == '{'; depth -= src[k] == '}'
        if depth == 0:
            break
    refs = ast.literal_eval(re.sub(r"'\s*\n\s*'", '', src[j:k + 1]))
    path = os.path.join(ASSETS, 'manifest.json')
    man = json.load(open(path))
    man.setdefault('references', {})['weapons'] = refs
    wi = json.load(open(os.path.join(CACHE, 'weapons_info.json')))
    out = {}
    for w in WEAPONS:
        if not os.path.exists(f'{ASSETS}/{w}.glb') or w not in wi:
            continue
        g, tris, mats = WM.read_glb(f'{ASSETS}/{w}.glb')
        out[w] = dict(file=f'{w}.glb', size_bytes=os.path.getsize(f'{ASSETS}/{w}.glb'), tris=tris, materials=sorted({m for ms in mats.values() for m in ms}),
                      empties={k: v[0] for k, v in wi[w]['empties'].items()},
                      conventions='origin = pistol grip (palm centre), +Z = muzzle, +Y up, weapon left side = +X; `<name>_LOD1` node = LOD1 '
                                  '(the magazine LOD1 is a child of `magazine`); one atlas material per weapon',
                      texel_px_per_m=wi[w].get('texel_px_per_m'))
    # per-weapon notes: reuse the literal strings from write_manifest.py
    blk = src[src.index("    out['ak74m']['magazine_node']"):src.index("    out['deviations']")]
    import textwrap
    exec(textwrap.dedent(blk), {"out": out})
    for w, e in out.items():
        man[w] = e
    json.dump(man, open(path, 'w'), indent=1)
    print('manifest weapon entries updated:', {w: sum(v for k, v in e['tris'].items() if not k.endswith('_LOD1')) for w, e in out.items()})


if __name__ == '__main__':
    main()
