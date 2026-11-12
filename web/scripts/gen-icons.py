#!/usr/bin/env python3
"""Derive the PWA icon set from the app icon (device/app/icons/source.png, white mark on a black square).

Usage: python3 scripts/gen-icons.py [source.png]   (needs Pillow)

Output, in public/ (commit the result; re-run only when the source changes):
  icons/icon-192.png, icons/icon-512.png   manifest icons, purpose "any"
  icons/icon-maskable-512.png              mark scaled into the maskable safe zone, full-bleed background
  apple-touch-icon.png                     180x180, iOS home screen
  favicon.ico                              16, 32 and 48 px
"""
import sys
from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parent.parent
src = Path(sys.argv[1]) if len(sys.argv) > 1 else root.parent / "device" / "app" / "icons" / "source.png"
out = root / "public"
(out / "icons").mkdir(parents=True, exist_ok=True)

base = Image.open(src).convert("RGB")
if base.width != base.height or base.width < 512:
    sys.exit(f"{src}: need a square source of at least 512 px, got {base.size}")
background = base.getpixel((0, 0))


def resized(size: int) -> Image.Image:
    return base.resize((size, size), Image.LANCZOS)


def maskable(size: int, scale: float = 0.8) -> Image.Image:
    """Launchers crop maskable icons to a shape; the safe zone is the central 80 %."""
    inner = round(size * scale)
    canvas = Image.new("RGB", (size, size), background)
    canvas.paste(resized(inner), ((size - inner) // 2, (size - inner) // 2))
    return canvas


resized(192).save(out / "icons" / "icon-192.png", optimize=True)
resized(512).save(out / "icons" / "icon-512.png", optimize=True)
maskable(512).save(out / "icons" / "icon-maskable-512.png", optimize=True)
resized(180).save(out / "apple-touch-icon.png", optimize=True)
resized(48).save(out / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
