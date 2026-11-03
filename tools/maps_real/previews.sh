#!/bin/bash
# Previews of the real-place maps -> previews/maps_real/:
#   <map>_overview.png (top-down), <map>_<view>.png (4 close views), <map>_osm_vs_game.png (OSM rendering | game),
#   <map>_sim60.png (60 s battle, fight camera) + <map>_sim60.json (page report)
#   bash tools/maps_real/previews.sh robotyne|avdiivka [views|overview|sbs|sim]...
# Map data (c) OpenStreetMap contributors, ODbL.
cd "$(dirname "$0")/../.." || exit 1
M=$1; shift; OUT=previews/maps_real; mkdir -p $OUT
WHAT=${*:-overview views sbs sim}
run() { flock /tmp/heavy.lock nice -n 10 timeout 1500 node tools/preview.mjs "page:/index.html?autostart&side=$SIDE&quality=low&map=$M&$1" "$2" 2>&1 | grep -v '^\[page\] warning' > "${2%.png}.log"; tail -1 "${2%.png}.log" | cut -c1-300; }
case $M in
  robotyne) SIDE=UA; HALF=700
    VIEWS="crossroads:64,-8,95,0.55,0.72 school:-300,-66,95,2.5,0.75 westline:600,150,85,3.4,0.7 kolkhoz:-176,452,120,0.25,0.62" ;;
  avdiivka) SIDE=RU; HALF=640
    VIEWS="stadium:-31,-282,110,0.4,0.7 schools:-327,150,110,0.5,0.62 delita:60,262,110,0.2,0.6 garages:162,-20,100,1.9,0.7 private:430,0,100,0.6,0.7" ;;
esac
for w in $WHAT; do case $w in
  overview) run "sim=0.1&nofog&nofx&cam=0,0,$((HALF * 3)),0,1.56" $OUT/${M}_overview.png
       flock /tmp/heavy.lock nice -n 10 timeout 1500 node tools/preview.mjs "page:/tools/maps_real/check.html?map=$M&side=$SIDE&nofog&shot=0,0,$((HALF * 2605 / 1000)),0,1.5707" $OUT/${M}_topdown.png 2>&1 | tail -1 | cut -c1-200 ;;
  views) for v in $VIEWS; do run "sim=0.1&nofog&cam=${v#*:}" $OUT/${M}_${v%%:*}.png; done ;;
  sbs) node -e "import('./src/world/maps.js').then(m=>{const d=m.MAPS['$M'];process.stdout.write(JSON.stringify({objectives:d.objectives,deployZones:d.deployZones,fortifications:d.fortifications,lineup:d.lineup,army:d.ai.army,north:d.north,grid:true}))})" > /tmp/${M}_ov.json 2>/dev/null
       python3 tools/maps_real/render_osm.py $M $OUT/${M}_osm.png /tmp/${M}_ov.json 1000 >/dev/null
       python3 tools/maps_real/sbs.py $OUT/${M}_osm.png $OUT/${M}_topdown.png $OUT/${M}_osm_vs_game.png ;;
  sim) run "sim=60&cam=fight" $OUT/${M}_sim60.png ;;
esac; done
