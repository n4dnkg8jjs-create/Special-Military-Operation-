"""Minimal glTF 2.0 binary writer (numpy) used by the soldier pipeline.

We write GLBs ourselves (instead of Blender's exporter) so that joint frames, node names,
sockets and sampled animation tracks are exactly what the game contract requires.
Joint nodes carry identity rest rotations (world-aligned joint frames); skins use
inverse bind matrices = translate(-joint_world_pos).
"""
import json, struct, io
import numpy as np
from PIL import Image


def _pad4(b, fill=b'\x00'):
    return b + fill * ((4 - len(b) % 4) % 4)


class GLB:
    def __init__(self):
        self.g = {"asset": {"version": "2.0", "generator": "smo soldier pipeline"},
                  "scenes": [{"nodes": []}], "scene": 0, "nodes": [], "meshes": [],
                  "accessors": [], "bufferViews": [], "buffers": [], "materials": [],
                  "textures": [], "images": [], "samplers": [], "skins": [], "animations": []}
        self.bin = bytearray()
        self.mat_index = {}
        self.img_cache = {}
        self.quantize_normals = True

    # ---------------------------------------------------------------- buffers
    def _view(self, data, target=None, stride=None):
        off = len(self.bin)
        self.bin += _pad4(bytes(data))
        bv = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            bv["target"] = target
        if stride:
            bv["byteStride"] = stride
        self.g["bufferViews"].append(bv)
        return len(self.g["bufferViews"]) - 1

    def accessor(self, arr, kind, target=None, minmax=False, normalized=False):
        arr = np.ascontiguousarray(arr)
        ct = {np.dtype('float32'): 5126, np.dtype('uint16'): 5123, np.dtype('uint32'): 5125,
              np.dtype('uint8'): 5121}[arr.dtype]
        bv = self._view(arr.tobytes(), target)
        acc = {"bufferView": bv, "componentType": ct, "count": int(arr.shape[0]), "type": kind}
        if normalized:
            acc["normalized"] = True
        if minmax:
            a2 = arr.reshape(arr.shape[0], -1)
            acc["min"] = [float(x) for x in a2.min(0)]
            acc["max"] = [float(x) for x in a2.max(0)]
        self.g["accessors"].append(acc)
        return len(self.g["accessors"]) - 1

    # ---------------------------------------------------------------- images / materials
    def image(self, img, fmt='JPEG', quality=88, key=None):
        if key is not None and key in self.img_cache:
            return self.img_cache[key]
        if isinstance(img, np.ndarray):
            a = img
            if a.dtype != np.uint8:
                a = (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)
            img = Image.fromarray(a)
        bio = io.BytesIO()
        if fmt == 'JPEG':
            img.convert('RGB').save(bio, 'JPEG', quality=quality, optimize=True)
            mime = 'image/jpeg'
        else:
            img.save(bio, 'PNG', optimize=True)
            mime = 'image/png'
        bv = self._view(bio.getvalue())
        self.g["images"].append({"bufferView": bv, "mimeType": mime})
        if not self.g["samplers"]:
            self.g["samplers"].append({"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497})
        self.g["textures"].append({"sampler": 0, "source": len(self.g["images"]) - 1})
        ti = len(self.g["textures"]) - 1
        if key is not None:
            self.img_cache[key] = ti
        return ti

    def material(self, name, color=(0.5, 0.5, 0.5, 1), metallic=0.0, roughness=0.8,
                 base_tex=None, normal_tex=None, orm_tex=None, normal_scale=1.0,
                 double=False, alpha_mode=None, emissive=None, extras=None, srgb=True):
        if name in self.mat_index:
            return self.mat_index[name]
        if srgb:
            color = [float(c) / 12.92 if c <= 0.04045 else ((float(c) + 0.055) / 1.055) ** 2.4 for c in color[:3]] + [float(color[3]) if len(color) > 3 else 1.0]
        pbr = {"baseColorFactor": [float(c) for c in color], "metallicFactor": float(metallic),
               "roughnessFactor": float(roughness)}
        if base_tex is not None:
            pbr["baseColorTexture"] = {"index": base_tex}
        if orm_tex is not None:
            pbr["metallicRoughnessTexture"] = {"index": orm_tex}
        m = {"name": name, "pbrMetallicRoughness": pbr}
        if normal_tex is not None:
            m["normalTexture"] = {"index": normal_tex, "scale": float(normal_scale)}
        if orm_tex is not None:
            m["occlusionTexture"] = {"index": orm_tex}
        if double:
            m["doubleSided"] = True
        if alpha_mode:
            m["alphaMode"] = alpha_mode
        if emissive:
            m["emissiveFactor"] = list(emissive)
        if extras:
            m["extras"] = extras
        self.g["materials"].append(m)
        self.mat_index[name] = len(self.g["materials"]) - 1
        return self.mat_index[name]

    # ---------------------------------------------------------------- nodes / meshes
    def node(self, name, parent=None, t=None, r=None, s=None, mesh=None, skin=None, extras=None):
        n = {"name": name}
        if t is not None and np.any(np.abs(np.asarray(t)) > 1e-9):
            n["translation"] = [float(x) for x in t]
        if r is not None and abs(float(r[3]) - 1.0) > 1e-9:
            n["rotation"] = [float(x) for x in r]
        if s is not None:
            n["scale"] = [float(x) for x in s]
        if mesh is not None:
            n["mesh"] = mesh
        if skin is not None:
            n["skin"] = skin
        if extras:
            n["extras"] = extras
        self.g["nodes"].append(n)
        i = len(self.g["nodes"]) - 1
        if parent is None:
            self.g["scenes"][0]["nodes"].append(i)
        else:
            self.g["nodes"][parent].setdefault("children", []).append(i)
        return i

    def mesh(self, name, prims):
        """prims: list of dict(pos, nrm, uv, idx, mat, joints=None, weights=None, color=None, tangent=None)"""
        out = []
        for p in prims:
            attrs = {}
            attrs["POSITION"] = self.accessor(p['pos'].astype(np.float32), "VEC3", 34962, minmax=True)
            if p.get('nrm') is not None:
                n = p['nrm'].astype(np.float32)
                n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-8)
                if self.quantize_normals:
                    # KHR_mesh_quantization: normalized int8 normals, 4-byte stride
                    q = np.zeros((len(n), 4), np.int8); q[:, :3] = np.clip(np.round(n * 127), -127, 127)
                    bv = self._view(q.tobytes(), 34962, stride=4)
                    self.g["accessors"].append({"bufferView": bv, "componentType": 5120, "count": int(len(n)), "type": "VEC3", "normalized": True})
                    attrs["NORMAL"] = len(self.g["accessors"]) - 1
                    for k in ("extensionsUsed", "extensionsRequired"):
                        if "KHR_mesh_quantization" not in self.g.setdefault(k, []):
                            self.g[k].append("KHR_mesh_quantization")
                else:
                    attrs["NORMAL"] = self.accessor(n, "VEC3", 34962)
            if p.get('uv') is not None:
                uv = np.asarray(p['uv'], np.float64)
                if len(uv) and uv.min() >= 0.0 and uv.max() <= 1.0:   # core glTF: TEXCOORD may be normalized u16
                    attrs["TEXCOORD_0"] = self.accessor(np.round(uv * 65535).astype(np.uint16), "VEC2", 34962, normalized=True)
                else:
                    attrs["TEXCOORD_0"] = self.accessor(uv.astype(np.float32), "VEC2", 34962)
            if p.get('color') is not None:
                c = np.clip(p['color'], 0, 1)
                if c.shape[1] == 3:   # u8 RGB padded to a 4-byte stride (vertex attribute alignment rule)
                    q = np.full((len(c), 4), 255, np.uint8); q[:, :3] = (c * 255 + 0.5).astype(np.uint8)
                    bv = self._view(q.tobytes(), 34962, stride=4)
                    self.g["accessors"].append({"bufferView": bv, "componentType": 5121, "count": int(len(c)), "type": "VEC3", "normalized": True})
                    attrs["COLOR_0"] = len(self.g["accessors"]) - 1
                else:
                    attrs["COLOR_0"] = self.accessor((c * 255 + 0.5).astype(np.uint8), "VEC4", 34962, normalized=True)
            if p.get('joints') is not None:
                attrs["JOINTS_0"] = self.accessor(p['joints'].astype(np.uint8 if p['joints'].max() < 256 else np.uint16), "VEC4", 34962)
                w = p['weights'].astype(np.float64)
                w /= np.maximum(w.sum(1, keepdims=True), 1e-8)
                wq = np.round(w * 255).astype(np.int32)                  # normalized u8 weights (core glTF)
                r = 255 - wq.sum(1); j = np.argmax(w, 1)
                wq[np.arange(len(wq)), j] += r
                attrs["WEIGHTS_0"] = self.accessor(np.clip(wq, 0, 255).astype(np.uint8), "VEC4", 34962, normalized=True)
            idx = p['idx'].reshape(-1)
            idx = idx.astype(np.uint16 if p['pos'].shape[0] < 65535 else np.uint32)
            prim = {"attributes": attrs, "indices": self.accessor(idx, "SCALAR", 34963), "mode": 4}
            if p.get('mat') is not None:
                prim["material"] = p['mat']
            out.append(prim)
        self.g["meshes"].append({"name": name, "primitives": out})
        return len(self.g["meshes"]) - 1

    def skin(self, name, joint_nodes, ibms, skeleton=None):
        ib = self.accessor(np.asarray(ibms, np.float32).reshape(-1, 16), "MAT4")
        s = {"name": name, "joints": list(joint_nodes), "inverseBindMatrices": ib}
        if skeleton is not None:
            s["skeleton"] = skeleton
        self.g["skins"].append(s)
        return len(self.g["skins"]) - 1

    def animation(self, name, tracks, extras=None):
        """tracks: list of (node_index, path, times(np), values(np [n,k]))"""
        samplers, channels = [], []
        tcache = {}
        for node, path, times, vals in tracks:
            key = (len(times), float(times[0]), float(times[-1]))
            if key not in tcache:
                tcache[key] = self.accessor(np.asarray(times, np.float32).reshape(-1), "SCALAR", minmax=True)
            ta = tcache[key]
            kind = {"translation": "VEC3", "rotation": "VEC4", "scale": "VEC3"}[path]
            va = self.accessor(np.asarray(vals, np.float32), kind)
            samplers.append({"input": ta, "output": va, "interpolation": "LINEAR"})
            channels.append({"sampler": len(samplers) - 1, "target": {"node": node, "path": path}})
        a = {"name": name, "samplers": samplers, "channels": channels}
        if extras:
            a["extras"] = extras
        self.g["animations"].append(a)

    def save(self, path):
        g = {k: v for k, v in self.g.items() if not (isinstance(v, list) and len(v) == 0)}
        g["buffers"] = [{"byteLength": len(self.bin)}]
        js = _pad4(json.dumps(g, separators=(',', ':')).encode(), b' ')
        bn = _pad4(bytes(self.bin))
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bn)))
            f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
            f.write(struct.pack('<II', len(bn), 0x004E4942)); f.write(bn)
