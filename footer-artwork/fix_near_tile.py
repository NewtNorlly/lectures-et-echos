# -*- coding: utf-8 -*-
"""近景层：选择底部草地区域最“平淡”的左右边缘做裁切窗，再 wrap crossfade。"""
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
OUT = ROOT / "strips"

Y_TOP, BAND_H = 283, 400
TILE_W, TILE_H = 2400, 400
OV = 150
# 最终画面里近景真正显眼的 tile-y 区间（遮罩不透明~半透明区）
Y0, Y1 = 214, 400

src = Image.open(RAW / "03-near.png").convert("RGB")
band0 = src.crop((0, Y_TOP, src.width, Y_TOP + BAND_H))
a0 = np.asarray(band0).astype(np.float32)

# 忙碌度：横向梯度能量（花/石头/蘑菇边缘强，纯草坡弱）
gray = a0.mean(axis=2)
gx = np.abs(np.diff(gray, axis=1))
gx = np.pad(gx, ((0, 0), (0, 1)), mode="edge")
col_busy = gx[Y0:Y1].mean(axis=0)
col_color = a0[Y0:Y1].mean(axis=0)

def win(x, arr, half=90):
    lo, hi = max(0, x - half), min(src.width, x + half)
    return arr[lo:hi].mean()

L = range(60, 520)
R = range(src.width - 520, src.width - 40)

cands = []
for xa in L:
    sa = win(xa, col_busy)
    for xb in R:
        if xb - xa < 1750:
            continue
        sb = win(xb, col_busy)
        dc = np.abs(col_color[xa - 50:xa + 50].mean(axis=0) - col_color[xb - 50:xb + 50].mean(axis=0)).mean()
        cands.append((sa + sb + dc / 120.0, xa, xb, sa, sb, dc))
cands.sort(key=lambda c: c[0])
best = cands[0]
print("best:", best)
_, xa, xb, *_ = best

crop = band0.crop((xa, 0, xb, BAND_H)).resize((TILE_W, TILE_H), Image.LANCZOS)
arr = np.asarray(crop).astype(np.float32)
W = TILE_W - OV
left = arr[:, :OV].copy()
right = arr[:, W:W + OV].copy()
t = np.linspace(0, 1, OV, dtype=np.float32)[None, :, None]
arr[:, :OV] = left * t + right * (1.0 - t)
tile = arr[:, :W]
Image.fromarray(np.clip(tile, 0, 255).astype(np.uint8)).save(OUT / "near.jpg", quality=88, optimize=True)
print("tile ->", (W, TILE_H), "window:", xa, xb)

timg = Image.open(OUT / "near.jpg")
dup = Image.new("RGB", (W * 2, TILE_H))
dup.paste(timg, (0, 0)); dup.paste(timg, (W, 0))
dup.crop((W - 420, 0, W + 420, TILE_H)).save(OUT / "near-seam-zoom.jpg", quality=86)
