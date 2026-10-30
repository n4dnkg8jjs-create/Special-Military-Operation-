#!/bin/sh
# usage: pv.sh <glb> <out.png> "<extra query>"   (soldier preview page)
cd "$(dirname "$0")/../../.." && node tools/preview.mjs "page:/tools/blender/soldiers/preview_soldier.html?glb=/$1&$3" "$2" "" 0
