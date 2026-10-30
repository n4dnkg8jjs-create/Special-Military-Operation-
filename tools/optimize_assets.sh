#!/usr/bin/env bash
# Compress textures inside GLBs to WebP (EXT_texture_webp, supported by three.js GLTFLoader) and
# convert ground PNG maps to JPG. Run after regenerating assets. Needs: npx @gltf-transform/cli@4, python3 + Pillow.
set -e
cd "$(dirname "$0")/.."
GT=${GT:-"npx -y @gltf-transform/cli@4"}
for f in assets/env/*.glb assets/vehicles/*.glb assets/soldiers/*.glb; do
  [ -f "$f" ] || continue
  grep -q "EXT_texture_webp" "$f" && continue
  $GT webp "$f" "$f.tmp.glb" --quality 88 >/dev/null && mv "$f.tmp.glb" "$f"
  echo "webp: $f $(du -h "$f" | cut -f1)"
done
python3 - <<'PY'
from PIL import Image; import os
d='assets/textures'
for f in sorted(os.listdir(d)):
    if f.endswith(('_normal.png','_orm.png')):
        im=Image.open(os.path.join(d,f)).convert('RGB')
        if f.endswith('_orm.png'): im=im.resize((1024,1024),Image.LANCZOS)
        im.save(os.path.join(d,f[:-4]+'.jpg'),quality=90,optimize=True); os.remove(os.path.join(d,f)); print('jpg:',f)
PY
