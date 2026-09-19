# -*- coding: utf-8 -*-
"""为远景层选择左右边缘都是开阔天空的裁切窗，再做 wrap crossfade，输出无缝 tile。"""
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
OUT = ROOT / "strips"

Y_TOP, BAND_H = 240, 400
TILE_W, TILE_H = 2400, 400
OV = 160
VISIBLE_Y = (60, 275)          # tile 坐标下最终画面真正可见的 y 区间

src = Image.open(RAW / "01-far.png").convert("RGB")
band0 = src.crop((0, Y_TOP, src.width, Y_TOP + BAND_H))   # 2048x400
a0 = np.asarray(band0).astype(np.float32)

# 云量分数：高明度 + 低饱和（白云/暖雾），天空是高饱和蓝
mx = a0.max(axis=2); mn = a0.min(axis=2)
cloud = ((mn > 175) & ((mx - mn) < 70)).astype(np.float32)
y0, y1 = VISIBLE_Y
col_cloud = cloud[y0:y1].mean(axis=0)                  # 每列云占比
col_color = a0[y0:y1].mean(axis=0)                    # 每列平均色

def window_score(x, half=110):
    lo, hi = max(0, x - half), min(src.width, x + half)
    return col_cloud[lo:hi].mean()

# 左边缘候选：最左 18%；右边缘候选：最右 18%
L = [x for x in range(120, 380)]
R = [x for x in range(src.width - 480, src.width - 40)]
best = None
for xa in L:
    sa = window_score(xa)

    if sa > 0.05:
        continue
    for xb in R:
        if xb - xa < 1700:
            continue
        sb = window_score(xb)
        if sb > 0.2:
            continue
        # 两侧边缘颜色接近
        dc = np.abs(col_color[xa - 60:xa + 60].mean(axis=0) - col_color[xb - 60:xb + 60].mean(axis=0)).mean()
        if dc > 45:
            continue
        score = sa + sb + dc / 300.0
        if best is None or score < best[0]:
            best = (score, xa, xb, sa, sb, dc)

print("best:", best)
_, xa, xb, *_ = best

# 裁切 -> 拉宽到 2400
crop = band0.crop((xa, 0, xb, BAND_H)).resize((TILE_W, TILE_H), Image.LANCZOS)
arr = np.asarray(crop).astype(np.float32)

W = TILE_W - OV
left = arr[:, :OV].copy()
right = arr[:, W:W + OV].copy()
t = np.linspace(0, 1, OV, dtype=np.float32)[None, :, None]
arr[:, :OV] = left * t + right * (1.0 - t)
tile = arr[:, :W]
Image.fromarray(np.clip(tile, 0, 255).astype(np.uint8)).save(OUT / "far.jpg", quality=88, optimize=True)
print("tile ->", (W, TILE_H), "source window:", xa, xb, "width", xb - xa)

# 接缝预览（两份拼接，裁接缝区）
timg = Image.open(OUT / "far.jpg")
dup = Image.new("RGB", (W * 2, TILE_H))
dup.paste(timg, (0, 0)); dup.paste(timg, (W, 0))
dup.crop((W - 420, 0, W + 420, TILE_H)).save(OUT / "far-seam-zoom.jpg", quality=86)
