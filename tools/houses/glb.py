# shared: read the house templates (city.glb house_*) as triangle arrays in the template's own frame
import json,struct,numpy as np
def load(path='assets/env/city.glb'):
    f=open(path,'rb').read()
    l=struct.unpack('<I',f[12:16])[0]; j=json.loads(f[20:20+l]); off=20+l; bl=struct.unpack('<I',f[off:off+4])[0]; bin_=f[off+8:off+8+bl]
    def acc(i):
        a=j['accessors'][i]; bv=j['bufferViews'][a['bufferView']]; n=a['count']; comp={'VEC3':3,'VEC2':2,'SCALAR':1}[a['type']]
        dt={5126:np.float32,5123:np.uint16,5125:np.uint32}[a['componentType']]
        st=bv.get('byteOffset',0)+a.get('byteOffset',0); isz=np.dtype(dt).itemsize; stride=bv.get('byteStride',0) or comp*isz
        raw=np.frombuffer(bin_,dtype=np.uint8,count=stride*(n-1)+comp*isz,offset=st)
        out=np.stack([raw[k*stride:k*stride+comp*isz] for k in range(n)]).copy().view(dt).reshape(n,comp)
        return out if comp>1 else out[:,0]
    H={}
    for n in j['nodes']:
        nm=n.get('name','')
        if not nm.startswith('house_') or 'mesh' not in n: continue
        T=[]; UV=[]
        for p in j['meshes'][n['mesh']]['primitives']:
            P=acc(p['attributes']['POSITION']).astype(float); I=acc(p['indices']).reshape(-1,3); T.append(P[I])
            U=acc(p['attributes']['TEXCOORD_0']).astype(float); UV.append(U[I])
        H[nm]=(np.concatenate(T),np.concatenate(UV))
    return H
def slice_y(T,y):
    # segments where the plane y cuts the triangles: list of ((x,z),(x,z))
    segs=[]
    for t in T:
        d=t[:,1]-y; pts=[]
        for a,b in ((0,1),(1,2),(2,0)):
            if (d[a]<0)!=(d[b]<0):
                f=d[a]/(d[a]-d[b]); p=t[a]+(t[b]-t[a])*f; pts.append((p[0],p[2]))
        if len(pts)==2: segs.append(pts)
    return segs
