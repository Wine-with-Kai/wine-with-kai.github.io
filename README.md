# Wine with Kai

A small static site for Wine with Kai, curated small-group wine dinners in Singapore.

## Pages

Home and dinners
- `index.html` : the landing page (brushmark, tagline, about, next-dinner tiles)
- `kings.html` : invitation for Kings of the North (Barolo and Amarone), with a map of Piedmont and the Veneto
- `kings-wines.html` : tasting notes for Kings of the North
- `napa.html` : invitation for the Napa Valley Cabernet blind tasting
- `wines.html` : tasting notes for the Napa Cabernets
- `upcoming.html` : upcoming themes, each linking to its line-up page
- `archive.html` : Past Dinners, the themes so far

Theme line-up pages (linked from `upcoming.html`)
- `simply-italian.html`, `super-tuscans.html`, `pinot-noir.html`,
  `wines-of-israel.html`, `great-pauillacs.html`, `left-right-bank.html`,
  `margaux.html`, `chateauneuf-du-pape.html`

Shared
- `assets/styles.css` : the one shared stylesheet for every page

Tasting notes are compiled from winery descriptions and published critic reviews;
community scores are from Vivino (out of 5) and, where shown, CellarTracker (out of 100).

## Editing

Edit the pages in `src/`. Each `src/*.html` links the shared stylesheet
(`../assets/styles.css`) instead of carrying its own copy, so styling lives in
one place.

To preview locally, serve the repo root and open the source page:

```bash
python3 -m http.server 8788
# then visit http://localhost:8788/src/index.html
```

## Building

Run the build to turn the source pages into the self-contained files at the repo
root (the files GitHub Pages serves). It inlines `assets/styles.css` into each
page so every served file stands alone:

```bash
python3 build.py
```

The build also refuses to write a page that contains an em-dash or en-dash, in
keeping with the house style below.

## Publishing on GitHub Pages

This repo is named `wine-with-kai.github.io`, so it serves at the org root:
`https://wine-with-kai.github.io/`. Settings, Pages, Deploy from a branch, `main` / root.

Publish by committing and pushing the root `*.html` files (and `assets/styles.css`),
or by uploading the root `*.html` files through the GitHub web interface. Pages
rebuilds about a minute later.

## House style

- Palette: dark warm background, cream text, gold accents. No red.
- Headers in EB Garamond, loaded from Google Fonts.
- No em-dashes or en-dashes anywhere (the build asserts this).
- Do not move a dinner into `archive.html` until it has actually happened.
