# Wine with Kai

A small static site for Wine with Kai, curated small-group wine dinners in Singapore.

## Pages
- `index.html` : the Wine with Kai landing page (logo, tagline, about, links)
- `napa.html` : invitation for the Napa Valley Cabernet blind tasting
- `wines.html` : tasting notes and what to look for, per wine
- `archive.html` : Past Dinners, the themes so far
- `assets/styles.css` : shared styles

Tasting notes are compiled from winery descriptions and published critic reviews;
community scores are from Vivino (out of 5) and CellarTracker (out of 100).

## Publishing on GitHub Pages
This repo is named `wine-with-kai.github.io`, so it serves at the org root:
`https://wine-with-kai.github.io/`. Settings, Pages, Deploy from a branch, `main` / root.

No build step, no dependencies. Plain HTML and CSS. Fonts load from Google Fonts.
