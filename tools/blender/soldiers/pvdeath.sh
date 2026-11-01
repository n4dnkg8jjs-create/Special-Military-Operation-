#!/bin/sh
# death clip filmstrip (12 frames over the clip, 6 columns): pvdeath.sh <anims glb> <clip> <out.png> [az] [r] [cz] [cy] [el]
# e.g. tools/blender/soldiers/pvdeath.sh assets/soldiers/soldier_anims.glb death_fall_back previews/deaths/death_fall_back.png 90 4.2 -0.3
cd "$(dirname "$0")/../../.."
az=${4:-90}; r=${5:-4.0}; cz=${6:-0}; cy=${7:-0.6}; el=${8:-12}
ts=0,0.06,0.12,0.18,0.24,0.3,0.37,0.44,0.52,0.62,0.78,0.995
timeout 600 nice -n 10 node tools/preview.mjs "page:/tools/blender/soldiers/preview_soldier.html?glb=/assets/soldiers/soldier_ru.glb&anims=/$1&anim=$2&ts=$ts&cols=6&az=$az&cy=$cy&cz=$cz&cx=0&r=$r&el=$el&fov=34&defaults=1&hidelod=1" "$3" "" 0 >/dev/null
