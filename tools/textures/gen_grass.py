# Seamless late-summer dry grass / weeds ground texture (albedo, normal, ORM), 1024².
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
N = 1024; rng = np.random.default_rng(7)
def fbm(n, octaves=6, seed=0):
    r = np.random.default_rng(seed); out = np.zeros((n, n)); amp = 1.0; tot = 0
    for o in range(octaves):
        f = 4 * 2 ** o; g = r.random((f, f))
        img = Image.fromarray((g * 255).astype(np.uint8)).resize((n, n), Image.BICUBIC)  # periodic enough after tiling below
        a = np.asarray(img, np.float32) / 255; out += a * amp; tot += amp; amp *= 0.55
    return out / tot
def tileable(a):  # cross-fade to make seamless
    h = a.shape[0]; b = np.roll(np.roll(a, h // 2, 0), h // 2, 1)
    w = np.minimum(np.abs(np.linspace(-1, 1, h)), 1)[:, None]; w = np.maximum(w, w.T)
    w = np.clip((w - 0.5) * 2, 0, 1) if a.ndim == 2 else np.clip((w - 0.5) * 2, 0, 1)[..., None]
    return a * (1 - w) + b * w
base = tileable(fbm(N, 6, 1)); dead = tileable(fbm(N, 5, 2))
c_green = np.array([96, 102, 58]); c_olive = np.array([128, 122, 72]); c_straw = np.array([168, 150, 100]); c_soil = np.array([92, 80, 62])
t = np.clip((base - 0.35) * 2.2, 0, 1)[..., None]
col = c_green * (1 - t) + c_olive * t
d = np.clip((dead - 0.55) * 3, 0, 1)[..., None]; col = col * (1 - d) + c_straw * d
s = np.clip((0.42 - base) * 5, 0, 1)[..., None]; col = col * (1 - s) + c_soil * s
img = Image.fromarray(np.clip(col, 0, 255).astype(np.uint8))
# blades: short strokes with random lean, drawn wrapped
dr = ImageDraw.Draw(img); hgt = Image.new('L', (N, N), 0); dh = ImageDraw.Draw(hgt)
for i in range(46000):
    x, y = rng.random() * N, rng.random() * N; L = 5 + rng.random() * 14; a = -np.pi / 2 + (rng.random() - .5) * 1.4
    x2, y2 = x + np.cos(a) * L, y + np.sin(a) * L
    k = rng.random(); c = (int(110 + 80 * k), int(108 + 60 * k), int(60 + 40 * k)) if rng.random() < 0.6 else (int(70 + 40 * k), int(84 + 40 * k), int(44 + 20 * k))
    for ox in (-N, 0, N):
        for oy in (-N, 0, N):
            dr.line([(x + ox, y + oy), (x2 + ox, y2 + oy)], fill=c, width=1)
            dh.line([(x + ox, y + oy), (x2 + ox, y2 + oy)], fill=int(120 + 120 * k), width=2)
img = img.filter(ImageFilter.GaussianBlur(0.4))
img.save('assets/textures/grass_albedo.jpg', quality=90)
h = np.asarray(hgt.filter(ImageFilter.GaussianBlur(1.2)), np.float32) / 255 * 0.7 + base * 0.3
gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 3; gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 3
n = np.dstack([-gx, -gy, np.ones_like(h)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8)).save('assets/textures/grass_normal.jpg', quality=90)
orm = np.dstack([0.75 + 0.25 * h, np.full_like(h, 0.92), np.zeros_like(h)])
Image.fromarray((orm * 255).astype(np.uint8)).resize((512, 512)).save('assets/textures/grass_orm.jpg', quality=90)
print('ok')
