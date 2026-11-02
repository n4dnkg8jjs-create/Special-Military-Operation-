#!/bin/sh
# filmstrips of the rider jump-off clips against their vehicles: pvjumps.sh <anims glb (tmp:/path or /assets/...)> <out dir> [az] [clip ...]
# one sheet per clip: 12 frames over the clip's phases (seat, hand down, butt at the edge, leave, flight, touchdown, absorb, step, end)
OUTABS=$(cd "$2" 2>/dev/null && pwd); cd "$(dirname "$0")"
A="$1"; OUT="$2"; AZ="${3:-80}"; shift 3 2>/dev/null
CL="$*"; [ -z "$CL" ] && CL="dismount_jump_btr dismount_jump_tank dismount_jump_bmp3 dismount_jump_bradley dismount_jump_rear_btr dismount_jump_rear_bmp3 dismount_jump_rear_bradley dismount_jump_rear_tank"
for n in $CL; do
  Q=$(python3 -c "
import clips_vehicle as CV
n='$n'; T=CV.jump_times(n); vp,vy=CV.preview_transform(n); veh=CV.LAYOUT[n]['veh'][0]
ts=[0, T['hand'], (T['hand']+T['edge'])/2, T['edge'], T['off']-0.04, T['off']+0.33*T['flight'], T['off']+0.7*T['flight'], T['td'], T['absorb'], T['absorb']+0.2, T['step'], T['dur']]
print(f\"veh=/assets/vehicles/{veh}.glb&vp={vp[0]:.3f},{vp[1]:.3f},{vp[2]:.3f}&vyaw={vy}&clip={n}&weapon=ak74m&ts={','.join('%.3f'%x for x in ts)}&az=$AZ&el=6&r=6.8&c=0,1.1,-0.8&cols=4&w=1400&h=800\")
" 2>/dev/null | tail -1)
  sh pvv.sh "$OUTABS/$n.png" "anims=$A&$Q" >/dev/null 2>&1 && echo "wrote $OUT/$n.png"
done
