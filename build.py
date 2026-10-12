#!/usr/bin/env python3
"""
Build the deployable Wine with Kai site.

Edit the pages in  src/*.html  (they link the shared  assets/styles.css ).
Run  python3 build.py  to regenerate the self-contained pages at the repo
root: the shared stylesheet, and any other  ../assets/*.css  or
../assets/*.js  a page links, is inlined so every file that GitHub Pages
serves is standalone.

Conventions enforced here:
  - no em-dashes anywhere in the output

The "Next dinner" link in every page's nav is written as {{NEXT_DINNER}}
in src/ and filled in here, so a new dinner means changing one line:
NEXT_DINNER below. That page's own nav link is marked as the current page.
"""
import re
import pathlib
import sys

# the line-up page of the next dinner, linked as "Next dinner" in every nav
NEXT_DINNER = "barolo-altitude.html"

REPO = pathlib.Path(__file__).resolve().parent
SRC = REPO / "src"
CSS = (REPO / "assets" / "styles.css").read_text()

# the <link> in a src page that points at the shared stylesheet
LINK_RE = re.compile(r'[ \t]*<link[^>]+href="\.\./assets/styles\.css"[^>]*>\n?')
INLINE = f"<style>\n{CSS}\n</style>\n"

# extra page-specific assets (the reservation and BYOB pages)
CSS_RE = re.compile(r'[ \t]*<link[^>]+href="\.\./assets/([\w-]+\.css)"[^>]*>\n?')
JS_RE = re.compile(r'[ \t]*<script src="\.\./assets/([\w-]+\.js)"></script>\n?')


def inline_asset(tag, m):
    body = (REPO / "assets" / m.group(1)).read_text()
    return f"<{tag}>\n{body}\n</{tag}>\n"

built = []
for src_page in sorted(SRC.glob("*.html")):
    html = src_page.read_text()
    if not LINK_RE.search(html):
        sys.exit(f"ERROR: {src_page.name} has no ../assets/styles.css link")
    out = LINK_RE.sub(lambda m: INLINE, html, count=1)
    out = CSS_RE.sub(lambda m: inline_asset("style", m), out)
    out = JS_RE.sub(lambda m: inline_asset("script", m), out)

    # the nav's "Next dinner" link, marked current on that dinner's own page
    nav_link = '<a href="{{NEXT_DINNER}}">'
    if src_page.name == NEXT_DINNER:
        out = out.replace(nav_link, f'<a href="{NEXT_DINNER}" aria-current="page">')
    out = out.replace("{{NEXT_DINNER}}", NEXT_DINNER)
    if not (REPO / "src" / NEXT_DINNER).exists():
        sys.exit(f"ERROR: NEXT_DINNER {NEXT_DINNER} is not a page in src/")

    # convention checks: no em/en dashes, literal characters or HTML entities
    for bad in ("—", "–", "&mdash;", "&ndash;"):
        if bad in out:
            sys.exit(f"ERROR: {src_page.name} contains an em/en dash ({bad!r})")

    (REPO / src_page.name).write_text(out)
    built.append(src_page.name)

print(f"built {len(built)} pages -> repo root")
for n in built:
    print("  ", n)
