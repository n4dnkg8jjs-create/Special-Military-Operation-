# stage = working file with every hunk NOT matching KEEP reverted to HEAD (string replacement, order-safe)
import subprocess,re,sys
p,keep=sys.argv[1],re.compile(sys.argv[2])
d=subprocess.run(['git','diff','-U0','HEAD',p],capture_output=True,text=True).stdout
out=open(p).read()
for h in re.split(r'(?m)^(?=@@ )',d)[1:]:
    if keep.search(h): continue
    lines=h.split('\n')[1:]
    minus=[l[1:] for l in lines if l.startswith('-')]; plus=[l[1:] for l in lines if l.startswith('+')]
    if not plus: sys.exit('pure deletion hunk, handle manually: '+h[:200])
    a='\n'.join(plus)+'\n'; b='\n'.join(minus)+('\n' if minus else '')
    if out.count(a)!=1: sys.exit('ambiguous: '+a[:100])
    out=out.replace(a,b)
h=subprocess.run(['git','hash-object','-w','--stdin'],input=out,capture_output=True,text=True).stdout.strip()
subprocess.run(['git','update-index','--cacheinfo',f'100644,{h},{p}'],check=True); print('staged',p)
