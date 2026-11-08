#!/usr/bin/env python3
"""Derive the tray icon set from icons/source.png (white mark on a black square).

Usage: python3 scripts/gen-tray-icons.py [source.png]   (needs Pillow)

The mark's brightness becomes its alpha, so the black square disappears and the
shaded crossing keeps its gradient. Output, in icons/tray/:
  tray-{16,32,64}.png, tray-{16,32,64}@2x.png   white mark, transparent background
  tray-dim-*.png                                same at 40 % opacity (offline / paused)
  tray-template-*.png                           black mark (macOS template image)
  tray-template-dim-*.png                       black mark at 40 % opacity (macOS, offline / paused)
"""
import sys
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
src = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "icons" / "source.png"
out = root / "icons" / "tray"
out.mkdir(parents=True, exist_ok=True)

lum = Image.open(src).convert("L")
box = lum.point(lambda v: 255 if v > 8 else 0).getbbox()
lum = lum.crop(box)
w, h = lum.size
side = round(max(w, h) * 1.12)  # a little padding
alpha = Image.new("L", (side, side), 0)
alpha.paste(lum, ((side - w) // 2, (side - h) // 2))


def variant(size, colour, opacity):
    a = alpha.resize((size, size), Image.LANCZOS)
    if opacity < 1:
        a = a.point(lambda v: round(v * opacity))
    img = Image.new("RGBA", (size, size), (colour, colour, colour, 0))
    img.putalpha(a)
    return img


for prefix, colour, opacity in (
    ("tray", 255, 1.0),
    ("tray-dim", 255, 0.4),
    ("tray-template", 0, 1.0),
    ("tray-template-dim", 0, 0.4),
):
    for base in (16, 32, 64):
        variant(base, colour, opacity).save(out / f"{prefix}-{base}.png")
        variant(base * 2, colour, opacity).save(out / f"{prefix}-{base}@2x.png")
print("wrote", out)
