#!/usr/bin/env python3
"""
Build the deployable Wine with Kai site.

Edit the pages in  src/*.html  (they link the shared  assets/styles.css ).
Run  python3 build.py  to regenerate the self-contained pages at the repo
root: the shared stylesheet is inlined into each page so every file that
GitHub Pages serves is standalone.

Conventions enforced here:
  - no em-dashes anywhere in the output
"""
import re
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parent
SRC = REPO / "src"
CSS = (REPO / "assets" / "styles.css").read_text()

# the <link> in a src page that points at the shared stylesheet
LINK_RE = re.compile(r'[ \t]*<link[^>]+href="\.\./assets/styles\.css"[^>]*>\n?')
INLINE = f"<style>\n{CSS}\n</style>\n"

built = []
for src_page in sorted(SRC.glob("*.html")):
    html = src_page.read_text()
    if not LINK_RE.search(html):
        sys.exit(f"ERROR: {src_page.name} has no ../assets/styles.css link")
    out = LINK_RE.sub(INLINE, html, count=1)

    # convention checks: no em/en dashes, literal characters or HTML entities
    for bad in ("—", "–", "&mdash;", "&ndash;"):
        if bad in out:
            sys.exit(f"ERROR: {src_page.name} contains an em/en dash ({bad!r})")

    (REPO / src_page.name).write_text(out)
    built.append(src_page.name)

print(f"built {len(built)} pages -> repo root")
for n in built:
    print("  ", n)
