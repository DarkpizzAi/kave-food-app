# Kave Food

The household's phone app: shared shopping list, recipe book, recipe scaler,
and (later) a meal planner that fills the list.

**This repo is the static app shell only** - `index.html`, `styles.css`,
`app.js`, `pixel-icons.js`. No data, no secrets. It is public so GitHub Pages
can serve it for free.

The shopping list and the recipes live in a separate **private** repo. They
sync into the app through a personal GitHub token pasted in Settings (from
Phase 2). Nothing personal is ever committed here.

## Run locally

```bash
python dev_server.py
```

Then open `http://localhost:8777/`. The server sends `no-store`, so a plain
reload always shows your latest edit (`python -m http.server` caches and
serves stale JS/CSS).

## Deploy

Pushed to `main`, served by GitHub Pages at
`https://darkpizzai.github.io/kave-food-app/`. Relative fetch paths, so the
subpath is fine.

## Status

**Phase 1** - UI and local state (`localStorage`). The list starts empty and
the Recipes tab is empty until Phase 2.

**Phase 2** - GitHub Contents API sync with the private repo: read
`shopping-list.json` + `recipes.json`, write the list back with an
id-keyed merge for concurrent edits, pull-to-refresh, 60 s poll,
read-only mode when no token.

**Phase 3** - PWA: `manifest.json`, service worker, add-to-home-screen,
offline open.

Design notes and plans are in the private hub repo.
