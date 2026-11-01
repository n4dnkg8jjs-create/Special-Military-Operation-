#!/bin/sh
# vehicle-relative clip preview: pvv.sh <out.png> "<query for preview_vehicle.html>" ["label|label|..." [cols] [caption]]
# query paths are URL paths from the repo root; /tmp/... files are copied into previews/_wtmp first (use tmp:/tmp/x.glb)
cd "$(dirname "$0")/../../.."
mkdir -p previews/_wtmp
Q="$2"
for f in $(echo "$Q" | grep -o 'tmp:[^&]*'); do p=${f#tmp:}; n=previews/_wtmp/$(basename "$p"); cp "$p" "$n"; Q=$(echo "$Q" | sed "s#$f#/$n#"); done
timeout 900 nice -n 10 node tools/blender/soldiers/pvgame.mjs "page:/tools/blender/soldiers/preview_vehicle.html?$Q" "$1" "" 0
if [ -n "$3" ]; then python3 tools/blender/soldiers/label_sheet.py "$1" "$3" "${4:-4}" "$5"; fi
