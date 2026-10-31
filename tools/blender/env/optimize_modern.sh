#!/usr/bin/env bash
# Post-process assets/env/modern.glb like optimize_farmland.sh: WebP textures (q88) + KHR_mesh_quantization.
# Run from anywhere after build_modern.py.  GT defaults to the local gltf-transform CLI.
set -e
cd "$(dirname "$0")/../../.."
GT=${GT:-/tmp/gt/node_modules/.bin/gltf-transform}
f=assets/env/modern.glb
$GT webp "$f" "$f.webp.glb" --quality 88 >/dev/null
$GT quantize "$f.webp.glb" "$f.q.glb" >/dev/null
mv "$f.q.glb" "$f"; rm -f "$f.webp.glb"
echo "modern.glb $(du -h "$f" | cut -f1)"
