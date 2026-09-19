# -*- coding: utf-8 -*-
"""
Footer artwork processing for Lectures & Échos.
1. Crop landscape layers to footer frieze bands, resize to 2400x400.
2. Wrap-around crossfade so each tile loops seamlessly when duplicated in CSS.
3. White-key the floating sprites (leaves / soot sprites), split halves, autocrop.
Run: python process_footer_art.py
"""
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "raw"
OUT_STRIPS = ROOT / "strips"
OUT_SPRITES = ROOT / "sprites"
OUT_STRIPS.mkdir(exist_ok=True)
OUT_SPRITES.mkdir(exist_ok=True)

TILE_W, TILE_H = 2400, 400
OVERLAP = 240  # px of wrap crossfade (10%)


def make_tile(src_name, y_top, dst_name, quality=86):
    """Crop a 2048x400 band from the 2048x683 source, resize, wrap-blend edges."""
    img = Image.open(RAW / src_name).convert("RGB")
    w, h = img.size
    band = img.crop((0, y_top, w, min(y_top + 400, h)))
    band = band.resize((TILE_W, TILE_H), Image.LANCZOS)
    arr = np.asarray(band).astype(np.float32)

    ov = OVERLAP
    W = TILE_W - ov
    left = arr[:, :ov].copy()                   # L: original left edge
    right = arr[:, W:W + ov].copy()             # R: original right edge
    t = np.linspace(0, 1, ov, dtype=np.float32)[None, :, None]
    blended = left * t + right * (1.0 - t)
    arr[:, :ov] = blended
    tile = arr[:, :W]
    out = Image.fromarray(np.clip(tile, 0, 255).astype(np.uint8))
    out.save(OUT_STRIPS / dst_name, quality=quality, optimize=True)
    print(f"strip -> {dst_name}  {out.size}")
    return out


def white_key(src_name, prefix, long_edge, bg_thresh=232, feather=1.6):
    """
    Flood-key pure-white background connected to borders, split left/right halves,
    autocrop each subject, despill white fringe, export transparent PNG.
    """
    img = Image.open(RAW / src_name).convert("RGB")
    w, h = img.size
    arr = np.asarray(img).astype(np.uint8)

    # whiteness score: min channel high AND low saturation
    mx = arr.max(axis=2).astype(np.int16)
    mn = arr.min(axis=2).astype(np.int16)
    near_white = (mn >= bg_thresh) & ((mx - mn) <= 22)

    # flood fill background from all border pixels through near-white cells
    from collections import deque
    bg = np.zeros((h, w), dtype=bool)
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            if near_white[y, x] and not bg[y, x]:
                bg[y, x] = True
                dq.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if near_white[y, x] and not bg[y, x]:
                bg[y, x] = True
                dq.append((y, x))
    while dq:
        y, x = dq.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not bg[ny, nx] and near_white[ny, nx]:
                bg[ny, nx] = True
                dq.append((ny, nx))

    alpha = np.where(bg, 0, 255).astype(np.uint8)
    a_img = Image.fromarray(alpha, mode="L").filter(ImageFilter.GaussianBlur(feather))
    a = np.asarray(a_img).astype(np.float32) / 255.0
    # strengthen: only keep real feather, no gray haze
    a = np.clip((a - 0.18) / 0.82, 0, 1)

    # white despill: C' = (C - (1-a)*255) / a
    rgb = arr.astype(np.float32)
    af = a[..., None]
    safe_a = np.where(af < 0.06, 1.0, af)
    rgb_out = (rgb - (1.0 - safe_a) * 255.0) / safe_a
    rgb_out = np.where(af < 0.06, 0, rgb_out)
    rgba = np.dstack([np.clip(rgb_out, 0, 255), (a * 255).astype(np.uint8)]).astype(np.uint8)
    full = Image.fromarray(rgba, mode="RGBA")

    paths = []
    for i, (x0, x1) in enumerate(((0, w // 2), (w // 2, w))):
        half = full.crop((x0, 0, x1, h))
        bbox = half.getbbox()
        if not bbox:
            print(f"WARNING: no subject in half {i} of {src_name}")
            continue
        pad = 36
        bx0, by0, bx1, by1 = bbox
        bx0 = max(0, bx0 - pad)
        by0 = max(0, by0 - pad)
        bx1 = min(x1 - x0, bx1 + pad)
        by1 = min(h, by1 + pad)
        sub = half.crop((bx0, by0, bx1, by1))
        scale = long_edge / max(sub.size)
        sub = sub.resize((max(1, round(sub.width * scale)), max(1, round(sub.height * scale))), Image.LANCZOS)
        name = f"{prefix}-{i+1}.png"
        sub.save(OUT_SPRITES / name, optimize=True)
        paths.append(name)
        print(f"sprite -> {name}  {sub.size}")
    return paths


if __name__ == "__main__":
    # Source canvases are 2048x683. Crop windows chosen per composition.
    make_tile("01-far.png", 240, "far.jpg")
    make_tile("02-mid.png", 283, "mid.jpg")
    make_tile("03-near.png", 283, "near.jpg")
    white_key("04-leaves.png", "leaf", long_edge=280)
    white_key("05-sprites.png", "soot", long_edge=190)
    print("done.")
