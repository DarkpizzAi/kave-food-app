# Spoon

The household's phone app: shared shopping list, recipe book, recipe scaler,
and (later) a meal planner that fills the list.

The app was called Kave Food through Phases 1 to 3. The repo, the GitHub Pages
URL and the service-worker cache name still carry that name on purpose - they
are the deployment's identity and renaming them would move the live URL and
orphan every installed copy. Only the user-facing name changed.

**This repo is the static app shell only** - `index.html`, `styles.css`,
`app.js`, `github.js`, `pixel-icons.js`. No data, no secrets. It is public so
GitHub Pages can serve it for free.

The shopping list and the recipes live in a separate **private** repo
(`DarkpizzAi/kave-hub`, at `food/data/`). They sync into the app through a
personal GitHub token pasted in Settings. Nothing personal is ever committed
here.

## Run locally

```bash
python dev_server.py
```

Then open `http://localhost:8777/`. The server sends `no-store`, so a plain
reload always shows your latest edit (`python -m http.server` caches and
serves stale JS/CSS). The service worker does not run on `localhost`.

With no token, the local server loads `recipes.dev.json` (a gitignored
snapshot built from kave-hub) so the Recipes tab is browsable offline of
GitHub. That file never reaches the public repo.

If a reload ever shows you an old version of the app, read the browser-preview
notes in the private hub repo (`food/data/kave-food-app-browser-preview-on-pc.md`)
before changing anything - the obvious fixes for that symptom do not work, and
the service worker is the usual culprit.

## Icons

`icon-512.png` is the master artwork. After replacing it:

```bash
python make_icons.py
```

That derives `icon-192.png`, `icon-512-maskable.png` (opaque, artwork at 70%
so any launcher crop shape is safe) and `apple-touch-icon.png` (flattened;
iOS paints alpha black). Then bump `VERSION` in `service-worker.js`.

## Deploy

Pushed to `main`, served by GitHub Pages at
`https://darkpizzai.github.io/kave-food-app/`. Relative fetch paths, so the
subpath is fine. **Bump `VERSION` in `service-worker.js` on every deploy** -
see PHASE3-NOTES.md.

## Status

**Phase 1** - UI and local state (`localStorage`).

**Phase 2** - GitHub Contents API sync with the private repo: read
`shopping-list.json` + `recipes.json`, write the list back with an
id-keyed merge for concurrent edits, pull-to-refresh, 60 s poll,
read-only mode when no token.

**Phase 3** - PWA: `manifest.json`, service worker, add-to-home-screen,
offline open.

**UI batch** - renamed to Spoon with a new bowl-and-spoon icon; Rubik
throughout; six own palettes (Cobalt, Amber, Chartreuse, Lime, Tangerine,
Volt) replacing the app-clone set, each a light and a dark tonal ladder;
a custom theme editor that edits light and dark separately; the phone's
status bar tracks the app background in both; tab labels and an accent
bubble behind the active tab; "All" chips on the recipe filters; the sync
banner replaced by the Settings sync section; all 43 recipes including
index-only stubs ("link only" / "to write").

**Phase 4** - the meal planner. Not started; the Plan tab is a placeholder.

Design notes and plans are in the private hub repo.
