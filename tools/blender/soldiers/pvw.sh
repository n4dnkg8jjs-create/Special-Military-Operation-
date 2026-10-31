#!/bin/sh
# weapon comparison sheet: pvw.sh <a.glb> <b.glb|-> <out.png> "<extra query: views=az,el,dist,tx,ty,tz;...&lod=1>"
# paths relative to the repo root (or absolute /tmp/... files are copied into previews/_wtmp)
cd "$(dirname "$0")/../../.."
mkdir -p previews/_wtmp
p() { case "$1" in /*) n=previews/_wtmp/$(echo "$1" | md5sum | cut -c1-8)_$(basename "$1"); cp "$1" "$n"; echo "$n";; *) echo "$1";; esac; }
A=$(p "$1"); if [ "$2" = "-" ]; then B=""; else B="&b=/$(p "$2")"; fi
timeout 300 node tools/preview.mjs "page:/tools/blender/soldiers/preview_weapon.html?a=/$A$B&$4" "$3" "" 0
