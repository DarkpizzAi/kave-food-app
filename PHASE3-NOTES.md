# Phase 3: the installable PWA

Spoon (called Kave Food when this was written) is installable to the home
screen and opens offline. What was added, and the rules to keep it working.

## What is wired

- `manifest.json`: standalone display, portrait, theme and splash matching the
  Cobalt light background (`#f4f7fd`), three icons (192, 512, 512 maskable).
  `start_url` and `scope` are `./` so it works from the `/kave-food-app/`
  project path on GitHub Pages.
- `service-worker.js`: precaches the static shell on install and serves it
  stale-while-revalidate. Navigation is network-first with the cached
  `index.html` as the offline fallback - it must not be cache-only, or a new
  shell can never reach an install. Registered from `app.js` with a
  `.catch(() => {})` so a browser that refuses the worker still runs the app.
  On `localhost` it is a kill switch instead and caches nothing: see the
  browser-preview notes in the private hub repo.
- Update toast: when a new worker takes control (not the first one), the
  `#banner` shows "New version. Tap to reload." and reloads on tap.
- `index.html` head: `<link rel="manifest">`, `apple-touch-icon`, kept the
  inline SVG favicon.

Data (the shared list and recipes) is never cached by the worker. It comes
from api.github.com, which the fetch handler lets straight through to the
network. The app's own localStorage is the offline data store, exactly as in
Phase 2.

## The one rule: bump VERSION on every deploy

`service-worker.js`:

```js
const VERSION = "v3";
```

Every time you deploy a change to any shell file (`index.html`, `app.js`,
`github.js`, `pixel-icons.js`, `styles.css`), bump this: `v1` to `v2`, etc.

Why: the cache name is `kave-food-${VERSION}`. A new VERSION means a new cache,
which means the `install` handler re-fetches every shell file, and the
`activate` handler deletes the old cache. It also makes `controllerchange`
fire, which is what shows the "new version" toast to whoever has the app open.

Forget to bump it and returning users keep the old cached files until their
browser happens to expire the worker (can be days).

If you add or remove a shell file, update the `SHELL` array too.

## How to swap the icons

`icon-512.png` is the master. Everything else is derived from it:

```bash
python make_icons.py
```

- `icon-192.png` - the same transparent artwork at 192.
- `icon-512-maskable.png` - opaque background, artwork at 70% so it survives
  any launcher crop shape. The maskable safe zone is the centre 80%, and a
  square-ish drawing at 80% width already pokes out of that circle at the
  corners, which is why it is 70% and not 80%.
- `apple-touch-icon.png` - 180x180, flattened onto the background. iOS paints
  alpha black, so this one must not be transparent.

Then bump VERSION. `BG` in `make_icons.py` must stay in step with
`theme_color` / `background_color` in `manifest.json`, or the splash will not
match the icon.

The maskable icon was briefly dropped during the UI batch and put back before
that batch shipped. Do not drop it again: without it Android letterboxes the
"any" icon inside a grey squircle on the home screen, and Spoon is an
Android-only app.

## Verified

- Live on GitHub Pages (`https://darkpizzai.github.io/kave-food-app/`): worker
  registers, activates, takes control, precaches all 11 shell files
  (verified at `kave-food-v1`). App runs normally with the worker controlling
  it, no console errors, add/nav/settings all work.
- CORRECTED: an earlier version of this note claimed the local dev browser
  pane blocks service-worker script fetches, so the worker "only registers on
  the real HTTPS site". That was wrong. It registered on `localhost` happily
  and then served a frozen shell that survived every reload. Local dev is now
  kept worker-free explicitly, by the hostname kill switch in
  `service-worker.js` and the guard in `app.js`. Full account in the
  browser-preview notes in the private hub repo.

## The UI batch deploy (VERSION v6)

Shipped on top of Phase 3: the rename to Spoon, the new icon set, six own
palettes, the light/dark custom editor, tab labels. The live site was on `v3`,
so `v6` is a fresh cache name and every installed copy refetches the shell and
shows the update toast.

The cache name stays `kave-food-${VERSION}`. It is internal, `activate` deletes
every cache that is not the current one regardless of prefix, and renaming it
would buy nothing.

Still to check on a real phone (Isa / Hugo): the install prompt, offline
launch from the home screen with the network off, the update toast after this
VERSION bump, and that the new maskable icon crops correctly on the launcher.
