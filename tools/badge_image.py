"""OutageRadar badge for other sites to embed. Site v1.18.4.

Writes the same picture three times:
  site/badge.png                   736x144, the permanent public address
                                   https://liveoutageradar.com/badge.png
  brand/outageradar-badge@2x.png   736x144 (identical file, master copy)
  brand/outageradar-badge.png      368x72

  python3 tools/badge_image.py           write the three files
  python3 tools/badge_image.py --verify  exit 1 if any file is out of date

The badge names no service count, so it can't go stale on other people's
sites when services are added (the first one said "10 AI APIs" at 15).
It draws the same design as brand/outageradar-badge.svg, in the Inter font.
Needs Pillow and Inter (only to regenerate; the site never runs this).
Never shows statuses: a fixed picture must not claim anything is up.
"""
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_SITE = os.path.join(ROOT, "site", "badge.png")
OUT_2X = os.path.join(ROOT, "brand", "outageradar-badge@2x.png")
OUT_1X = os.path.join(ROOT, "brand", "outageradar-badge.png")
FONT_DIRS = ["/usr/share/fonts/opentype/inter", os.path.join(ROOT, "brand", "fonts")]

TAGLINE = "Know when to switch: live status of AI APIs"
W, H = 368, 72          # design size, as in the SVG
SS = 8                  # draw at 8x, then shrink, for smooth edges

BG = (6, 17, 13)
BORDER = (31, 74, 51)
DISC = (7, 20, 14)
OP = (75, 224, 138)
AMBER = (255, 181, 71)
TEXT = (232, 255, 241)
MUTED = (156, 201, 173)


def font(name, size):
    from PIL import ImageFont
    for d in FONT_DIRS:
        path = os.path.join(d, name)
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    raise SystemExit("Inter font not found (" + name + "); install Inter to regenerate the badge")


def render():
    """The 2x badge (736x144), RGBA with transparent corners."""
    from PIL import Image, ImageDraw
    k = SS * 2                       # pixels per design unit at the 8x canvas of the 2x image

    def u(v):
        return int(round(v * k))

    w, h = u(W), u(H)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Card: 1.5-unit border inside a 12-unit radius, like the SVG rect.
    d.rounded_rectangle((u(0.75), u(0.75), u(W - 0.75), u(H - 0.75)), radius=u(12),
                        fill=BG + (255,), outline=BORDER + (255,), width=u(1.5))

    cx, cy = u(36), u(36)

    def circle(r, **kw):
        d.ellipse((cx - u(r), cy - u(r), cx + u(r), cy + u(r)), **kw)

    circle(25, fill=DISC + (255,), outline=OP + (255,), width=u(2))
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    for r in (17, 9):
        ld.ellipse((cx - u(r), cy - u(r), cx + u(r), cy + u(r)), outline=OP + (int(255 * 0.3),), width=u(1))
    ld.line((cx - u(25), cy, cx + u(25), cy), fill=OP + (int(255 * 0.22),), width=u(1))
    ld.line((cx, cy - u(25), cx, cy + u(25)), fill=OP + (int(255 * 0.22),), width=u(1))
    img.alpha_composite(layer)

    # Sweep: the wedge from 0 to about -72 degrees, fading in left to right
    # across its own box (x 0..25), as the SVG's linear gradient does.
    end = math.degrees(math.atan2(-23.8, 7.7))
    wedge = Image.new("L", (w, h), 0)
    ImageDraw.Draw(wedge).pieslice((cx - u(25), cy - u(25), cx + u(25), cy + u(25)), start=end, end=0, fill=255)
    ramp = Image.new("L", (w, h), 0)
    rd = ImageDraw.Draw(ramp)
    x0, x1 = cx, cx + u(25)
    for x in range(x0, x1 + 1):
        rd.line((x, 0, x, h), fill=int(255 * 0.55 * (x - x0) / (x1 - x0)))
    from PIL import ImageChops
    alpha = ImageChops.multiply(wedge, ramp)
    sweep = Image.new("RGBA", (w, h), OP + (0,))
    sweep.putalpha(alpha)
    img.alpha_composite(sweep)

    for (x, y, col) in ((9, -13, OP), (-12, -7, OP), (15, 9, OP), (-8, 13, AMBER)):
        r = 2.6
        d.ellipse((cx + u(x - r), cy + u(y - r), cx + u(x + r), cy + u(y + r)), fill=col + (255,))
    circle(2, fill=OP + (255,))

    # Words: baselines at y=32 and y=52, starting at x=74, as in the SVG.
    big = font("Inter-Bold.otf", u(20))
    d.text((u(74), u(32)), "Outage", font=big, fill=TEXT + (255,), anchor="ls")
    d.text((u(74) + d.textlength("Outage", font=big), u(32)), "Radar", font=big, fill=OP + (255,), anchor="ls")
    d.text((u(74), u(52)), TAGLINE, font=font("Inter-Regular.otf", u(12.5)), fill=MUTED + (255,), anchor="ls")

    return img.resize((W * 2, H * 2), Image.LANCZOS)


def images():
    from PIL import Image
    big = render()
    small = big.resize((W, H), Image.LANCZOS)
    return {OUT_SITE: big, OUT_2X: big, OUT_1X: small}


def same(path, want):
    from PIL import Image, ImageChops
    if not os.path.exists(path):
        return False
    have = Image.open(path).convert("RGBA")
    return have.size == want.size and ImageChops.difference(have, want).getbbox() is None


def main(argv):
    out = images()
    if "--verify" in argv:
        bad = [os.path.relpath(p, ROOT) for p, im in out.items() if not same(p, im)]
        if bad:
            print("out of date: " + ", ".join(bad))
            return 1
        return 0
    big_bytes = None
    for path, im in out.items():
        im.save(path, optimize=True)
    # site/badge.png and the @2x master must be the very same file.
    with open(OUT_2X, "rb") as fh:
        big_bytes = fh.read()
    with open(OUT_SITE, "wb") as fh:
        fh.write(big_bytes)
    for p in out:
        print("wrote " + os.path.relpath(p, ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
