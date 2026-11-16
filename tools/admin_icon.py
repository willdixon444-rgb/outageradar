"""Makes the /admin home-screen icon (checker v1.22.0).

Shrinks the radar avatar (brand/outageradar-x-profile.png, the X/Bluesky
profile picture) to 180 x 180, the size iPhones use for a home-screen icon,
and writes it into worker/checker.js as the ADMIN_ICON_180_B64 line, so the
Worker can serve it at /admin/icon-180.png with nothing extra to upload.

Run from the repo root:  python3 tools/admin_icon.py
"""
import base64
import io
import re
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "brand" / "outageradar-x-profile.png"
CHECKER = ROOT / "worker" / "checker.js"
SIZE = 180


def make_png():
    im = Image.open(SOURCE).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
    # Full colour: fewer colours band the sweep and dull the amber dot, and
    # the file is only about 20 KB.
    out = io.BytesIO()
    im.save(out, format="PNG", optimize=True)
    return out.getvalue()


def main():
    data = make_png()
    b64 = base64.b64encode(data).decode("ascii")
    text = CHECKER.read_text(encoding="utf-8")
    line = 'const ADMIN_ICON_180_B64 = "' + b64 + '";'
    new, n = re.subn(r'^const ADMIN_ICON_180_B64 = "[A-Za-z0-9+/=]*";$', line, text, flags=re.M)
    if n != 1:
        sys.exit("could not find the ADMIN_ICON_180_B64 line in worker/checker.js")
    if new != text:
        CHECKER.write_text(new, encoding="utf-8")
    print("icon: %d bytes PNG, %d characters base64%s" % (len(data), len(b64), "" if new != text else " (unchanged)"))


if __name__ == "__main__":
    main()
