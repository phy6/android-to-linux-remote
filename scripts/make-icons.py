#!/usr/bin/env python3
"""Render the app icon set.

The mark is a trackpad with a cursor, a filled left button and an accented
right button -- the three things the deck actually controls. Shapes are drawn
at 4x and downsampled so edges stay clean at 192px, and the maskable variant
keeps its glyph inside the safe zone so Android's mask cannot clip it.

Run from the repo root:  python3 scripts/make-icons.py
"""

import os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")

BG_TOP = (14, 23, 41)
BG_BOTTOM = (29, 43, 71)
PAD_FILL = (23, 35, 59)
PAD_LINE = (63, 127, 232)
ACCENT = (96, 165, 250)
ACCENT_GLOW = (59, 130, 246)
BUTTON_LEFT = (47, 111, 228)
BUTTON_LINE = (69, 83, 110)
MIC = (251, 113, 133)

SS = 4  # supersampling factor


def rounded(draw, box, radius, fill=None, outline=None, width=0):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def gradient(size):
    g = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        g.putpixel((0, y), tuple(
            round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)
        ))
    return g.resize((size, size))


def draw_mark(size, corner_frac, glyph_scale):
    """corner_frac: background corner radius as a fraction of size (0 = square).
    glyph_scale: how much of the canvas the mark occupies (maskable wants less)."""
    s = size * SS
    img = gradient(s).convert("RGBA")

    # Corner mask for the rounded variants.
    if corner_frac > 0:
        mask = Image.new("L", (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, s - 1, s - 1), radius=int(s * corner_frac), fill=255
        )
        img.putalpha(mask)
    else:
        img.putalpha(Image.new("L", (s, s), 255))

    # Soft highlight so the surface is not flat.
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        (-int(s * 0.30), -int(s * 0.42), int(s * 0.72), int(s * 0.42)),
        fill=ACCENT_GLOW + (70,),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.06))
    img = Image.alpha_composite(img, glow)

    # The mark is authored on a 512 grid, then scaled into the safe area.
    grid = 512
    k = (s / grid) * glyph_scale
    off = (s - grid * k) / 2

    def G(v):
        return off + v * k

    layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # Trackpad.
    rounded(d, (G(100), G(118), G(412), G(336)), int(44 * k),
            fill=PAD_FILL, outline=PAD_LINE, width=max(1, round(9 * k)))

    # Cursor glow, then the cursor itself.
    cg = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(cg).ellipse(
        (G(256 - 52), G(206 - 52), G(256 + 52), G(206 + 52)), fill=ACCENT + (90,)
    )
    layer = Image.alpha_composite(layer, cg.filter(ImageFilter.GaussianBlur(s * 0.018)))
    d = ImageDraw.Draw(layer)
    d.ellipse((G(256 - 27), G(206 - 27), G(256 + 27), G(206 + 27)), fill=ACCENT)

    # Buttons: the filled one is what a left tap does, the plain one is the rest.
    rounded(d, (G(100), G(362), G(246), G(452)), int(26 * k), fill=BUTTON_LEFT)
    rounded(d, (G(266), G(362), G(412), G(452)), int(26 * k),
            fill=PAD_FILL, outline=BUTTON_LINE, width=max(1, round(7 * k)))
    # Rose dot: the dictation accent.
    d.ellipse((G(339 - 15), G(407 - 15), G(339 + 15), G(407 + 15)), fill=MIC)

    img = Image.alpha_composite(img, layer)
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    targets = [
        ("pwa-512x512.png", 512, 0.227, 1.0),
        ("pwa-192x192.png", 192, 0.227, 1.0),
        ("apple-touch-icon.png", 180, 0.0, 0.82),
        ("pwa-maskable-512x512.png", 512, 0.0, 0.72),
    ]
    for name, size, corner, scale in targets:
        img = draw_mark(size, corner, scale)
        path = os.path.join(OUT, name)
        img.save(path, "PNG", optimize=True)
        print(f"wrote {name} ({size}x{size})")

    # Tab icon: multi-resolution, opaque background.
    ico = draw_mark(256, 0.227, 1.0)
    ico.save(os.path.join(OUT, "favicon.ico"),
             sizes=[(16, 16), (32, 32), (48, 48)])
    print("wrote favicon.ico")


if __name__ == "__main__":
    main()
