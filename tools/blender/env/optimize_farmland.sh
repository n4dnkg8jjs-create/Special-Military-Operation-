#!/usr/bin/env bash
# Post-process assets/env/farmland.glb like tools/optimize_assets.sh: WebP textures (q88) + KHR_mesh_quantization.
# Run from anywhere after build_farmland.py.  GT defaults to the local gltf-transform CLI.
set -e
cd "$(dirname "$0")/../../.."
GT=${GT:-/tmp/gt/node_modules/.bin/gltf-transform}
f=assets/env/farmland.glb
$GT webp "$f" "$f.webp.glb" --quality 88 >/dev/null
$GT quantize "$f.webp.glb" "$f.q.glb" >/dev/null
mv "$f.q.glb" "$f"; rm -f "$f.webp.glb"
echo "farmland.glb $(du -h "$f" | cut -f1)"
