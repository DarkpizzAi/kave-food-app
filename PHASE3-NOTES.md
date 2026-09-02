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

## Bumping VERSION is not enough on its own (fixed in v7)

`install` used `cache.addAll(SHELL)`. That goes through the browser's normal
HTTP cache, and GitHub Pages serves the shell with `max-age=600`. So a
VERSION bump within ten minutes of a deploy precaches the very files it was
meant to replace, into a cache whose name says it is fresh.

This is not theoretical: it happened on the v6 deploy. `index.html` and
`app.js` arrived new (title "Spoon", the six palettes), `styles.css` came out
of the HTTP cache still carrying the old Keep palette, so the app rendered the
new markup with the old colours and `--card` resolved to nothing.

`install` now fetches every shell URL with `cache: "reload"` and fails the
install if any one of them is not `ok`, so a broken deploy leaves the previous
worker in place instead of installing a half-stale shell.

The lesson for any earlier note in this file that says "verified on GitHub
Pages": verify by reading a value that only the new CSS can produce, not just
by checking the worker activated.

## An old cache can come back from the dead (fixed in v9)

`activate` deleted the old caches and then called `clients.claim()`. In that
order the outgoing worker is still handling fetches while the delete runs, and
its stale-while-revalidate calls `caches.open(<its own CACHE>)` - recreating
the cache that was just removed. `kave-food-v7` reappeared seconds after the
v8 worker cleaned it up.

Claim first, delete second. The old worker stops serving fetches once the
claim resolves, so nothing is left to recreate the cache.

## Settings > Update (VERSION v8, cache fix in v9)

The `controllerchange` toast only fires if the app happens to be open at the
moment the browser notices a new worker. On a phone that almost never lines
up, so in practice nobody saw it. Settings now has an **Update** section (in
Advanced settings) with a manual path:

- "Check for updates" calls `registration.update()`, then reads what came
  back: no incoming worker means "Up to date"; an `installing` or `waiting`
  one means a new version is downloading; once it settles the button becomes
  "Restart to finish" and reloads.
- A worker that ends up `redundant` failed to install, and the section says
  the check failed rather than claiming success.
- `install()` already calls `skipWaiting`, but a worker still sitting in
  `installed` gets a `{type: "skipWaiting"}` message as a fallback.
- The worker answers a `{type: "version"}` message over a `MessageChannel`,
  so the section can show which VERSION is actually running. That line is the
  honest way to confirm an update landed.
- Registration now passes `updateViaCache: "none"`. Without it the browser may
  serve the worker script itself from the HTTP cache, and the check finds
  nothing however many times it is pressed.

The toast is kept: it is still the right thing when the app *is* open.

## The UI batch deploy (VERSION v6, then v7)

Shipped on top of Phase 3: the rename to Spoon, the new icon set, six own
palettes, the light/dark custom editor, tab labels. The live site was on `v3`,
so the bump is a fresh cache name and every installed copy refetches the shell
and shows the update toast. `v6` shipped the batch and `v7` shipped the
precache fix above, which is what actually got the new stylesheet onto the
site.

The cache name stays `kave-food-${VERSION}`. It is internal, `activate` deletes
every cache that is not the current one regardless of prefix, and renaming it
would buy nothing.

Still to check on a real phone (Isa / Hugo): the install prompt, offline
launch from the home screen with the network off, the update toast after this
VERSION bump, and that the new maskable icon crops correctly on the launcher.
