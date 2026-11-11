# usage: python3 ed.py <path> <file with OLD\n====\nNEW>   -- applies to working tree AND index (index = HEAD-based, other agents' edits excluded)
import sys, subprocess, os
SPEC=open(sys.argv[2]).read(); os.chdir('/home/claude/special-military-operation-')
p, spec = sys.argv[1], SPEC
old, new = spec.split('\n====\n'); new = new.rstrip('\n'); old = old.rstrip('\n')
w = open(p).read()
idx = subprocess.run(['git','show',':'+p],capture_output=True,text=True).stdout
for name, s in (('work', w), ('index', idx)):
    if s.count(old) != 1: sys.exit(f'{name}: {s.count(old)} matches in {p}')
open(p,'w').write(w.replace(old,new))
h = subprocess.run(['git','hash-object','-w','--stdin'],input=idx.replace(old,new),capture_output=True,text=True).stdout.strip()
subprocess.run(['git','update-index','--cacheinfo',f'100644,{h},{p}'],check=True)
print('ok', p)
