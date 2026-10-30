#!/bin/sh
# contact sheet: sheet.sh <soldier glb> <anims glb> <clip> <out.png> [cy] [r] [az] [extra]
cd "$(dirname "$0")/../../.."
cy=${5:-1.0}; r=${6:-3.4}; az=${7:-60}
timeout 120 node tools/preview.mjs "page:/tools/blender/soldiers/preview_soldier.html?glb=/$1&anims=/$2&anim=$3&ts=0,0.25,0.5,0.75&az=$az&cy=$cy&r=$r&weapon=/assets/soldiers/ak74m.glb&hide=ak74m_LOD1,gloves&$8" "$4" "" 0 >/dev/null
