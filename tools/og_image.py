"""Sharing image (site/og.png, 1200x630) for link previews on X, Bluesky,
Discord, Slack and others. Site v1.18.1.

The service count and the "+ N more" chip come from the board's own list in
site/board.js, so the image can't go stale when services are added.

  python3 tools/og_image.py           write site/og.png
  python3 tools/og_image.py --count   print the service count it uses
  python3 tools/og_image.py --verify  exit 1 if site/og.png is out of date

Needs Pillow and the Inter font (only to regenerate; the site never runs this).
Names only, never statuses: a fixed picture must not claim anything is up.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOARD = os.path.join(ROOT, "site", "board.js")
OUT = os.path.join(ROOT, "site", "og.png")
FONT_DIRS = ["/usr/share/fonts/opentype/inter", os.path.join(ROOT, "brand", "fonts")]

BG = (6, 17, 13)
LINE = (23, 51, 37)
TEXT = (232, 255, 241)
MUTED = (156, 201, 173)
OP = (75, 224, 138)
CHIP = (23, 28, 26)
PANEL = (7, 20, 14)
SHOWN = ["ChatGPT", "Claude", "Gemini", "Grok", "DeepSeek", "Groq", "Mistral", "Perplexity"]


def service_count():
    with open(BOARD, encoding="utf-8") as fh:
        src = fh.read()
    start = src.index("export const SHELL = [")
    end = src.index("];", start)
    return len(re.findall(r"\{\s*id:\s*\"[a-z0-9-]+\"", src[start:end]))


def font(name, size):
    from PIL import ImageFont
    for d in FONT_DIRS:
        path = os.path.join(d, name)
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    raise SystemExit("Inter font not found (" + name + "); install Inter to regenerate the image")


def render():
    from PIL import Image, ImageDraw, ImageFilter
    n = service_count()
    s = 2
    w, h = 1200 * s, 630 * s
    img = Image.new("RGBA", (w, h), BG + (255,))
    grid = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    g = ImageDraw.Draw(grid)
    for x in range(0, w, 60 * s):
        g.line((x, 0, x, h), fill=LINE + (60,), width=s)
    for y in range(0, h, 60 * s):
        g.line((0, y, w, y), fill=LINE + (60,), width=s)
    img.alpha_composite(grid)
    fade = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(fade).rectangle((0, 0, int(w * 0.56), h), fill=BG + (235,))
    img.alpha_composite(fade.filter(ImageFilter.GaussianBlur(60 * s)))

    d = ImageDraw.Draw(img)
    x0 = 72 * s
    d.text((x0, 70 * s), "LIVE STATUS FOR AI APIs", font=font("Inter-SemiBold.otf", 20 * s), fill=OP)
    big = font("Inter-Bold.otf", 76 * s)
    d.text((x0, 102 * s), "Outage", font=big, fill=TEXT)
    d.text((x0 + d.textlength("Outage", font=big), 102 * s), "Radar", font=big, fill=OP)
    head = font("Inter-Bold.otf", 40 * s)
    d.text((x0, 236 * s), "Is ChatGPT, Claude or", font=head, fill=TEXT)
    d.text((x0, 286 * s), "Gemini down?", font=head, fill=TEXT)
    sub = font("Inter-Regular.otf", 26 * s)
    d.text((x0, 372 * s), "Live status of " + str(n) + " AI services:", font=sub, fill=MUTED)
    d.text((x0, 408 * s), "official status plus our own check,", font=sub, fill=MUTED)
    d.text((x0, 444 * s), "every 5 minutes.", font=sub, fill=MUTED)
    d.text((x0, 530 * s), "liveoutageradar.com", font=font("Inter-SemiBold.otf", 26 * s), fill=OP)

    names = SHOWN + ["+ " + str(n - len(SHOWN)) + " more"]
    cw, ch, gap = 140 * s, 52 * s, 14 * s
    px = w - 72 * s - (3 * cw + 2 * gap)
    py = (h - (3 * ch + 2 * gap)) // 2
    d.rounded_rectangle((px - 22 * s, py - 22 * s, px + 3 * cw + 2 * gap + 22 * s, py + 3 * ch + 2 * gap + 22 * s),
                        radius=20 * s, fill=PANEL, outline=LINE, width=2 * s)
    chip = font("Inter-SemiBold.otf", 20 * s)
    for i, name in enumerate(names):
        cx = px + (i % 3) * (cw + gap)
        cy = py + (i // 3) * (ch + gap)
        d.rounded_rectangle((cx, cy, cx + cw, cy + ch), radius=ch // 2, fill=CHIP, outline=LINE, width=2 * s)
        more = name.startswith("+")
        if not more:
            r = 6 * s
            dx, dy = cx + 18 * s, cy + ch // 2
            d.ellipse((dx - r, dy - r, dx + r, dy + r), outline=OP, width=2 * s)  # neutral ring, no status
        tw = d.textlength(name, font=chip)
        tx = cx + (cw - tw) // 2 + (0 if more else 9 * s)
        d.text((tx, cy + ch // 2), name, font=chip, fill=MUTED if more else TEXT, anchor="lm")
    return img.resize((1200, 630), Image.LANCZOS).convert("RGB")


def main(argv):
    if "--count" in argv:
        print(service_count())
        return 0
    img = render()
    if "--verify" in argv:
        from PIL import Image, ImageChops
        if not os.path.exists(OUT):
            print("site/og.png is missing")
            return 1
        current = Image.open(OUT).convert("RGB")
        if current.size != img.size or ImageChops.difference(current, img).getbbox() is not None:
            print("site/og.png differs from the generated image")
            return 1
        return 0
    img.save(OUT, optimize=True)
    print("wrote site/og.png (" + str(service_count()) + " services)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
