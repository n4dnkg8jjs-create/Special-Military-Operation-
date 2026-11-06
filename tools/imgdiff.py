# Pixel diff of two renders (same camera): mean abs diff (0-255), % of pixels differing by > 8 / > 24 (max channel),
# and a side-by-side PNG (before | after | diff x4).  Usage: python3 tools/imgdiff.py before.png after.png out_sbs.png
import sys
import numpy as np
from PIL import Image
a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.int16)
b = np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(np.int16)
d = np.abs(a - b); m = d.max(axis=2)
print(f'mean {d.mean():.2f}  >8: {(m > 8).mean() * 100:.2f}%  >24: {(m > 24).mean() * 100:.2f}%  max {m.max()}')
if len(sys.argv) > 3:
    h, w = a.shape[:2]; out = np.zeros((h, w * 3, 3), np.uint8)
    out[:, :w] = a; out[:, w:2 * w] = b; out[:, 2 * w:] = np.clip(d * 4, 0, 255)
    Image.fromarray(out).save(sys.argv[3])
