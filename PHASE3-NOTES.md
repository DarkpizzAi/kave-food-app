# Phase 3: the installable PWA

Kave Food is now installable to the home screen and opens offline. What was
added, and the rules to keep it working.

## What is wired

- `manifest.json`: standalone display, portrait, green (`#2f6f4f`) theme and
  splash, three icons (192, 512, 512 maskable). `start_url` and `scope` are
  `./` so it works from the `/kave-food-app/` project path on GitHub Pages.
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

## How to swap the placeholder icons

`icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `apple-touch-icon.png`
are a plain white cart on the green. To replace them:

1. Make four PNGs at those exact pixel sizes (apple-touch-icon is 180x180).
   The maskable one needs its content inside the centre ~80% (safe zone), the
   rest is padding the launcher may crop to any shape.
2. Drop them in at the same filenames.
3. Bump VERSION.

Keep `theme_color` / `background_color` in `manifest.json` in step with the
icon background or the splash screen will not match.

## Verified

- Live on GitHub Pages (`https://darkpizzai.github.io/kave-food-app/`): worker
  registers, activates, takes control, precaches all 11 shell files
  (verified at `kave-food-v1`; VERSION is now v3). App runs normally with the worker controlling it, no
  console errors, add/nav/settings all work.
- CORRECTED: an earlier version of this note claimed the local dev browser
  pane blocks service-worker script fetches, so the worker "only registers on
  the real HTTPS site". That was wrong. It registered on `localhost` happily
  and then served a frozen shell that survived every reload. Local dev is now
  kept worker-free explicitly, by the hostname kill switch in
  `service-worker.js` and the guard in `app.js`. Full account in the
  browser-preview notes in the private hub repo.

Still to check on a real phone (Isa / Hugo): the install prompt, offline
launch from the home screen with the network off, and the update toast after
a VERSION bump.
