# -*- coding: utf-8 -*-
"""按浏览器 object-fit:cover + mask 几何合成 footer 预览，调三层垂直分区。"""
from PIL import Image
from pathlib import Path

W, H = 1864, 200
SRC = Path(__file__).parent / "strips"

def cover_crop(tile, pos_y):
    """模拟 object-fit:cover（按宽铺满）+ object-position center <pos_y>。"""
    scaled_h = round(H * tile.height / tile.width * W / H)  # 等比缩放到宽 W 后的高
    scale = W / tile.width
    sh = round(tile.height * scale)
    im = tile.resize((W, sh), Image.LANCZOS)
    off = round((sh - H) * pos_y)
    return im.crop((0, off, W, off + H))

def vgrad_mask(stops):
    """stops: [(y0..1, alpha0..255), ...] 自上而下（y=0 顶部）。"""
    m = Image.new("L", (1, H), 0)
    px = m.load()
    for y in range(H):
        t = y / (H - 1)
        a = stops[0][1]
        for (y1, a1), (y2, a2) in zip(stops, stops[1:]):
            if y1 <= t <= y2:
                k = (t - y1) / (y2 - y1) if y2 > y1 else 0
                a = round(a1 + (a2 - a1) * k)
                break
        else:
            a = stops[-1][1]
        px[0, y] = a
    return m.resize((W, H))

def mask_to_top(opaque_below, half_at, transparent_above):
    """to top 语法：bottom=t=0。opaque_below 是自底向上的不透明比例。"""
    return vgrad_mask([
        (0.0, 0),
        (1 - transparent_above, 0),
        (1 - half_at, 128),
        (1 - opaque_below, 255),
        (1.0, 255),
    ])

def mask_to_bottom_fade(opaque_from_top):
    """顶部淡入：transparent 0 -> opaque@opaque_from_top。"""
    return vgrad_mask([(0.0, 0), (opaque_from_top, 255), (1.0, 255)])

far = Image.open(SRC / "far.jpg").convert("RGB")
mid = Image.open(SRC / "mid.jpg").convert("RGB")
near = Image.open(SRC / "near.jpg").convert("RGB")

# 参数候选（v2：mid 上移露出树冠木屋，near 收成底部草穗 fringe）
FAR_POS = 0.30
MID_POS = 0.55
NEAR_POS = 1.00

canvas = Image.new("RGB", (W, H), (245, 246, 250))

far_v = cover_crop(far, FAR_POS)
canvas.paste(far_v, (0, 0), mask_to_bottom_fade(0.16))

mid_v = cover_crop(mid, MID_POS)
canvas.paste(mid_v, (0, 0), mask_to_top(0.52, 0.68, 0.85))

near_v = cover_crop(near, NEAR_POS)
canvas.paste(near_v, (0, 0), mask_to_top(0.38, 0.54, 0.72))

canvas.save(SRC / "compose-preview-v3.jpg", quality=86)
print("saved", canvas.size)
