"""webp_glb.py <glb>... : re-encode every PNG/JPEG image in a GLB as WebP (quality 88, alpha kept) and point the
textures at it through EXT_texture_webp (same result as `gltf-transform webp`, which tools/optimize_assets.sh runs;
done with Pillow here because npx downloads are not available).  Then updates file_mb / textures in the manifest
(locked) for vehicles whose file it touched."""
import io, json, os, struct, sys, fcntl
from PIL import Image

R = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))


def convert(path):
    b = open(path, 'rb').read()
    magic, ver, total = struct.unpack('<III', b[:12])
    assert magic == 0x46546C67
    off = 12
    js = bn = None
    while off < len(b):
        ln, typ = struct.unpack('<II', b[off:off + 8])
        data = b[off + 8:off + 8 + ln]
        if typ == 0x4E4F534A:
            js = json.loads(data)
        elif typ == 0x004E4942:
            bn = data
        off += 8 + ln
    if 'EXT_texture_webp' in js.get('extensionsUsed', []):
        print('already webp', path)
        return False
    views = js['bufferViews']
    img_view = {}
    for i, im in enumerate(js.get('images', [])):
        bv = views[im['bufferView']]
        raw = bn[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]
        p = Image.open(io.BytesIO(raw))
        p = p.convert('RGBA' if 'A' in p.getbands() or (p.mode == 'P' and 'transparency' in p.info) else 'RGB')
        o = io.BytesIO()
        p.save(o, 'WEBP', quality=88, method=4)
        img_view[im['bufferView']] = o.getvalue()
        im['mimeType'] = 'image/webp'
    # rebuild the binary chunk: copy every bufferView (replaced image data where converted), 4-byte aligned
    out = bytearray()
    for vi, bv in enumerate(views):
        if vi in img_view:
            data = img_view[vi]
        else:
            s = bv.get('byteOffset', 0)
            data = bn[s:s + bv['byteLength']]
        while len(out) % 4:
            out.append(0)
        bv['byteOffset'] = len(out)
        bv['byteLength'] = len(data)
        out += data
    while len(out) % 4:
        out.append(0)
    js['buffers'][0]['byteLength'] = len(out)
    for t in js.get('textures', []):
        if 'source' in t:
            t.setdefault('extensions', {})['EXT_texture_webp'] = {'source': t.pop('source')}
    js.setdefault('extensionsUsed', []).append('EXT_texture_webp')
    js.setdefault('extensionsRequired', []).append('EXT_texture_webp')
    jb = json.dumps(js, separators=(',', ':')).encode()
    jb += b' ' * ((4 - len(jb) % 4) % 4)
    glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(jb) + 8 + len(out))
    glb += struct.pack('<II', len(jb), 0x4E4F534A) + jb + struct.pack('<II', len(out), 0x004E4942) + bytes(out)
    tmp = path + '.tmp_webp'
    open(tmp, 'wb').write(glb)
    os.replace(tmp, path)
    print('webp', path, round(len(b) / 1e6, 2), '->', round(len(glb) / 1e6, 2), 'MB')
    return True


if __name__ == '__main__':
    names = []
    for p in sys.argv[1:]:
        convert(p)
        n = os.path.basename(p)[:-4]
        if os.path.abspath(p) == f'{R}/assets/vehicles/{n}.glb':
            names.append(n)
    if names:
        mp = R + '/assets/vehicles/manifest.json'
        with open(mp + '.lock', 'w') as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            m = json.load(open(mp))
            for n in names:
                m['vehicles'][n]['file_mb'] = round(os.path.getsize(f'{R}/assets/vehicles/{n}.glb') / 1e6, 2)
                m['vehicles'][n]['textures'] = 'EXT_texture_webp (tools/optimize_assets.sh step applied)'
            json.dump(m, open(mp + '.tmp_webp', 'w'), indent=1)
            os.replace(mp + '.tmp_webp', mp)
        print('manifest updated', names)
