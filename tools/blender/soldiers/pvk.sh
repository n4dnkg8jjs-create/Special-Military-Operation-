#!/bin/sh
# soldier kit before/after preview under game lighting: pvk.sh <out.png> "<query for preview_kit.html>"
# query paths are URL paths from the repo root; tmp:/tmp/x.glb files are copied into previews/_wtmp first
cd "$(dirname "$0")/../../.."
mkdir -p previews/_wtmp
Q="$2"
for f in $(echo "$Q" | grep -o 'tmp:[^&,]*'); do p=${f#tmp:}; n=previews/_wtmp/$(basename "$p"); { [ ! -e "$n" ] || [ "$p" -nt "$n" ]; } && cp "$p" "$n"; Q=$(echo "$Q" | sed "s#$f#/$n#"); done
flock /tmp/heavy.lock timeout 900 nice -n 10 node tools/blender/soldiers/pvgame.mjs "page:/tools/blender/soldiers/preview_kit.html?$Q" "$1" "" 0
