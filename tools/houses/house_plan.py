# house interior plan of the house templates (city.glb house_*) -> the PLAN table in src/world/houses.js
# Walls (outer / inner face per side), floor height, doors (openings down to the floor, from horizontal ray casts through each
# wall), windows (openings with a sill; glazed or empty), porch steps in front of each door, interior obstacles (rubble).
# run: python3 previews/house_interior/scen/house_plan.py [--plot out.png]   (prints the JSON table)
import sys,json,numpy as np
sys.path.insert(0,__import__('os').path.dirname(__file__))
from glb import load,slice_y
SIDES=[('front',2,1),('back',2,-1),('right',0,1),('left',0,-1)]
def tri_normals(T):
    n=np.cross(T[:,1]-T[:,0],T[:,2]-T[:,0]); a=np.linalg.norm(n,axis=1)/2; return n/(2*a[:,None]+1e-12),a
def rays(T,O,D):
    # all hits: returns list (per ray) of hit distances; O (N,3), D (3,) one direction
    e1=T[:,1]-T[:,0]; e2=T[:,2]-T[:,0]; h=np.cross(D,e2); a=(e1*h).sum(1); ok=np.abs(a)>1e-10; fi=np.where(ok,1/np.where(ok,a,1),0)
    out=[]
    for k in range(0,len(O),512):
        o=O[k:k+512][:,None,:]; s=o-T[None,:,0]; u=fi*(s*h).sum(2); q=np.cross(s,e1); v=fi*(q@D); t=fi*(e2[None]*q).sum(2)
        m=ok&(u>=-1e-6)&(v>=-1e-6)&(u+v<=1+1e-6)&(t>1e-5)
        out+= [np.sort(t[i][m[i]]) for i in range(len(o))]
    return out
def plan(nm,T):
    nn,area=tri_normals(T); P=T.reshape(-1,3)
    # floor: the big upward plane at ~0.45
    up=nn[:,1]>0.95; fl={}
    for t,a in zip(T[up],area[up]):
        y=round(float(t[:,1].mean()),2)
        if 0.2<y<1.0: fl[y]=fl.get(y,0)+a
    floor=max(fl,key=fl.get)
    walls={}
    for side,ax,sg in SIDES:
        sel=(np.abs(nn[:,ax])>0.95)&(T[:,:,ax].std(1)<0.005)&(T[:,:,1].min(1)<1.2)&(T[:,:,1].max(1)>floor+0.3)
        pl={}
        for t,a,nv in zip(T[sel],area[sel],nn[sel][:,ax]):
            k=(round(float(t[0,ax]),2),int(np.sign(nv)))
            if k[0]*sg>0: pl[k]=pl.get(k,0)+a
        outer=max((k[0] for k,a in pl.items() if k[1]==sg and a>5),key=lambda x:x*sg)
        inner=max((k[0] for k,a in pl.items() if k[1]==-sg and a>5 and abs(k[0])<abs(outer)),key=lambda x:x*sg)
        walls[side]=[outer,inner]
    # interior rectangle (inner faces)
    ix0,ix1,iz0,iz1=walls['left'][1],walls['right'][1],walls['back'][1],walls['front'][1]
    doors=[];wins=[];cov={}
    for side,ax,sg in SIDES:
        outer,inner=walls[side]; oth=0 if ax==2 else 2
        lo,hi=(ix0,ix1) if ax==2 else (iz0,iz1)
        us=np.arange(lo+0.0125,hi,0.025); ys=np.arange(floor+0.05,floor+2.6,0.05)
        U,Y=np.meshgrid(us,ys,indexing='ij'); O=np.zeros((U.size,3)); O[:,oth]=U.ravel(); O[:,1]=Y.ravel(); O[:,ax]=outer+sg*0.02
        D=np.zeros(3); D[ax]=-sg
        # only the wall slab's tris
        c=T[:,:,ax]; slab=(np.maximum(c.max(1),c.min(1))*sg>=inner*sg-0.05)&(np.minimum(c.max(1),c.min(1))*sg<=outer*sg+0.05)
        H=rays(T[slab],O,D); depth=abs(outer-inner)
        # 0 = solid wall at the outer face, 1 = filled opening (pane / door leaf recessed), 2 = hole
        st=np.array([0 if len(h) and h[0]<0.06 else (1 if len(h) and h[0]<depth+0.02 else 2) for h in H]).reshape(U.shape)
        cov[side]=(us,ys,st)
        op=st>0
        # columns: door if open from just above the floor to 1.9 m over it; window if open at sill+ but walled low
        yd=(ys>floor+0.1)&(ys<floor+1.9); yw=(ys>floor+1.1)&(ys<floor+2.1); ylow=(ys>floor+0.1)&(ys<floor+0.6)
        dcol=op[:,yd].all(1); wcol=op[:,yw].mean(1)>0.8
        def runs(m):
            r=[];i=0
            while i<len(m):
                if m[i]:
                    j=i
                    while j+1<len(m) and m[j+1]: j+=1
                    r.append((i,j)); i=j+1
                else: i+=1
            return r
        for i,j in runs(dcol):
            if us[j]-us[i]<0.6: continue
            col=op[i:j+1]; yy=ys[col.all(0)]
            leaf=float(np.median([H[k*len(ys)+m][0] for k in range(i,j+1) for m in range(len(ys)) if st[k,m]==1] or [0]))
            doors.append(dict(side=side,u0=round(us[i]-0.0125,3),u1=round(us[j]+0.0125,3),y0=round(float(yy.min())-0.05,2),y1=round(float(yy.max())+0.05,2),leaf=round(outer-sg*leaf,3) if leaf else None))
        for i,j in runs(wcol&~dcol):
            if us[j]-us[i]<0.4: continue
            col=op[i:j+1]; ym=col.mean(0)>0.8; yy=ys[ym]
            fill=(st[i:j+1][:,ym]==1).mean()
            wins.append(dict(side=side,u0=round(us[i]-0.0125,3),u1=round(us[j]+0.0125,3),y0=round(float(yy.min())-0.025,2),y1=round(float(yy.max())+0.025,2),glazed=bool(fill>0.5)))
    # porch steps in front of each door: geometry outside the outer wall below the floor level, within the door's span +- 1.5 m
    for d in doors:
        ax=2 if d['side'] in('front','back') else 0; sg=1 if d['side'] in('front','right') else -1; oth=2-ax; outer=walls[d['side']][0]
        c=T.mean(1); m=(c[:,ax]*sg>outer*sg+0.02)&(c[:,1]<floor+0.1)&(c[:,oth]>d['u0']-1.5)&(c[:,oth]<d['u1']+1.5)
        Q=T[m].reshape(-1,3)
        d['porch']=round(float((Q[:,ax]*sg).max()*sg),3) if len(Q) else outer
        d['porchU']=[round(float(Q[:,oth].min()),3),round(float(Q[:,oth].max()),3)] if len(Q) else [d['u0'],d['u1']]
    # interior obstacles: geometry inside the interior rect between floor+0.08 and 2.0 m over the floor -> 0.25 m cells
    c=T.mean(1); cell=0.25; obs={}
    m=(T[:,:,0].max(1)>ix0+0.02)&(T[:,:,0].min(1)<ix1-0.02)&(T[:,:,2].max(1)>iz0+0.02)&(T[:,:,2].min(1)<iz1-0.02)&(T[:,:,1].max(1)>floor+0.08)&(T[:,:,1].min(1)<floor+2.0)
    for t in T[m]:
        x0,x1=max(ix0,t[:,0].min()),min(ix1,t[:,0].max()); z0,z1=max(iz0,t[:,2].min()),min(iz1,t[:,2].max())
        for i in range(int(np.floor(x0/cell)),int(np.floor(x1/cell))+1):
            for k in range(int(np.floor(z0/cell)),int(np.floor(z1/cell))+1): obs[(i,k)]=max(obs.get((i,k),0),float(t[:,1].max()-floor))
    obsH=float(T[m][:,:,1].max()-floor) if m.any() else 0
    return dict(floor=floor,walls=walls,inner=[ix0,ix1,iz0,iz1],doors=doors,windows=wins,obst=sorted([i,k,round(h,2)] for (i,k),h in obs.items()),obstH=round(obsH,2),cell=cell),cov
if __name__=='__main__':
    H=load(); OUT={}; COV={}
    for nm,(T,UV) in sorted(H.items()): OUT[nm],COV[nm]=plan(nm,T)
    for nm,p in OUT.items():
        print(nm,'floor',p['floor'],'walls',p['walls'],'obst cells',len(p['obst']),'h',p['obstH'],file=sys.stderr)
        for d in p['doors']: print('   door',d,file=sys.stderr)
        for w in p['windows']: print('   win ',w,file=sys.stderr)
    if '--plot' in sys.argv:
        import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
        fig,axs=plt.subplots(1,len(OUT),figsize=(6*len(OUT),6))
        for ax,(nm,p) in zip(axs,OUT.items()):
            T=H[nm][0]
            for (a,b) in slice_y(T,p['floor']+0.5): ax.plot([a[0],b[0]],[a[1],b[1]],'k-',lw=0.7)
            for (a,b) in slice_y(T,p['floor']+1.6): ax.plot([a[0],b[0]],[a[1],b[1]],'-',color='#999',lw=0.5)
            ix0,ix1,iz0,iz1=p['inner']; ax.add_patch(plt.Rectangle((ix0,iz0),ix1-ix0,iz1-iz0,fill=False,ec='g',ls='--'))
            for (i,k,_) in p['obst']: ax.add_patch(plt.Rectangle((i*0.25,k*0.25),0.25,0.25,color='orange',alpha=0.5))
            for d in p['doors']:
                zax=d['side'] in('front','back'); o=p['walls'][d['side']][0]
                xs=[d['u0'],d['u1']] if zax else [o,o]; zs=[o,o] if zax else [d['u0'],d['u1']]
                ax.plot(xs,zs,'r-',lw=5)
            for w in p['windows']:
                zax=w['side'] in('front','back'); o=p['walls'][w['side']][0]
                xs=[w['u0'],w['u1']] if zax else [o,o]; zs=[o,o] if zax else [w['u0'],w['u1']]
                ax.plot(xs,zs,'b-',lw=4)
            ax.set_aspect('equal'); ax.set_title(nm); ax.grid(alpha=.3)
        plt.tight_layout(); plt.savefig(sys.argv[sys.argv.index('--plot')+1],dpi=70)
    if '--js' in sys.argv:
        # the PLAN table of src/world/houses.js: f floor, w {side: [outer, inner]}, d doors [side, u0, u1, top, leaf|null, porch edge],
        # win windows [side, outer, pane|null (unglazed), u0, u1, sill, top], rub rubble cells (0.25 m) [i, k, height over the floor]
        J={nm:dict(f=p['floor'],w=p['walls'],d=[[d['side'],float(d['u0']),float(d['u1']),d['y1'],d['leaf'],d['porch']] for d in p['doors']],
                   win=[[w['side'],p['walls'][w['side']][0],(round(p['walls'][w['side']][0]-(0.1 if w['side'] in('front','right') else -0.1),3) if w['glazed'] else None),float(w['u0']),float(w['u1']),w['y0'],w['y1']] for w in p['windows']],
                   **({'rub':p['obst']} if p['obst'] else {})) for nm,p in OUT.items()}
        print('const PLAN = '+json.dumps(J,separators=(',',':'))+';')
    else: print(json.dumps(OUT,separators=(',',':')))
