# Phase 2 notes

Phase 2 connects the app to the private `DarkpizzAi/kave-hub` repo: the shared
shopping list and the recipes sync in and out through the GitHub Contents API,
using a per-person token. Phase 1 (`PHASE1-NOTES.md`) is the UI; this is the
backbone.

## What is wired

- **`github.js`** - a `github` global, no app logic. `getFile` / `putFile` /
  `getUser` against `kave-hub`, base64 UTF-8 both ways, conditional GET
  (`{ notModified: true }` on a 304). Errors are plain `Error` tagged with
  `.gh`: `offline` | `unauthorized` | `notFound` | `conflict` | `rateLimited`
  (`.resetAt`) | `http`. The token is pushed in with `github.setToken()`;
  nothing here reads `localStorage`.
- **Repo coordinates are hardcoded** in `github.config`: owner `DarkpizzAi`,
  repo `kave-hub`, branch `main`, `food/data/shopping-list.json`,
  `food/data/recipes.json`. The token is the only per-user value.
- **Token** - a GitHub fine-grained PAT, resource owner `DarkpizzAi`,
  repository access limited to `kave-hub`, permission **Contents: Read and
  write**, nothing else. Settings has a "How to make one" with the exact
  steps. On blur it runs `getUser()` + `getFile(recipes)` and shows
  `Connected as <login>` or a typed error.
- **Cache** (`localStorage`): `foodapp.recipes` (last-synced recipes),
  `foodapp.sync` (`{ listSha, listEtag, recipesSha, recipesEtag, syncedAt }`),
  `foodapp.queue` (pending list changes). `foodapp.list` stays the optimistic
  working copy. Boot renders the cache **before any network call**.
- **Read sync** - `fullSync()` (recipes + list, conditional GETs) runs on boot,
  the Settings "Sync now" button, and pull-to-sync. A 60 s background poll
  (`pollTick`) does one conditional `syncList()` while the tab is visible and
  on List or Planner; `visibilitychange` catches up, `online` triggers a flush
  + poll. A single `syncing` flag gates every read path.
- **Write sync** - every add / tick / delete applies optimistically and pushes
  an op onto `foodapp.queue`. `flushQueue()` is debounced 800 ms and
  serialised on a `flushing` flag: snapshot the ops, GET the list,
  `replayOps()` them onto the remote items, PUT with the sha and a message
  like `list +1 ~2 -1 (isa)`. 200 -> drop those ops by `opId`; 409 -> re-GET
  and retry, cap 3; `offline` / `rateLimited` / `unauthorized` -> keep the
  queue and retry later.
- **Scaler** - `scaleQty(ing, factor)` reads the `frac` field on each recipe
  ingredient (added by `kave-hub/food/tools/build_recipes.py`): `entier`
  rounds to a whole number (min 1), `fractionnable` keeps decimals, `au gout`
  is not scaled. Recipes cached before `frac` existed fall back to the old
  `isCountUnit` unit heuristic.

## The merge rule

A poll or full sync that returns new list content does:

```
store.state.list = replayOps(remote.items, store.queue)
```

**Remote wins for every item, then the pending queue is re-applied on top by
id.** So an item nobody has touched locally takes the remote value; an item
with a pending op keeps the local change (it is about to be PUT).

This is safe because the three op types are all id-targeted and order-stable:

- `check` is idempotent - replaying "set checked = true" any number of times,
  in any order relative to a remote change, lands on the same value.
- `add` carries a client-generated `id` (`crypto.randomUUID()`), so it never
  collides with another device's add and "add if absent" is a no-op once it
  has synced.
- `delete` targets an `id`; if the remote already removed that item, the
  filter is a no-op.

`flushQueue` uses the same `replayOps` against a fresh GET before every PUT, so
a concurrent edit from the other phone (a 409) is resolved by re-fetching and
re-replaying, not by clobbering.

## Status and errors

`syncState` (`idle` | `offline` | `unauthorized` | `rateLimited`) is set by the
sync engine and shown as:

- **`#statusBanner`** - one line, highest priority wins: token rejected >
  no token > rate-limited (with the retry time) > offline (with the last-sync
  time) > "N changes waiting to sync".
- **`#syncDot`** in the header - a spinner while working, a red dot on error,
  an accent dot when the queue is non-empty, invisible when idle and clean.

`unauthorized` also makes the list read-only (edits are blocked until the token
is fixed) while keeping the token in the field so it can be corrected. Every
error state clears itself on recovery - `online`, a good token, or the
rate-limit auto-retry.

## Decisions and deviations

- **Offline / no token = cache, not "read-only mode".** The design spec said a
  read-only mode; Isa chose to cache the last-good list + recipes so the app
  still works offline or if a token expires. No token + a cache = read-only
  view of the cache; no token + no cache = editable Phase-1 style (edits queue
  and sync up once a token is added).
- **`shopping-list.json` was seeded once, by hand**, from the 511-item
  `shopping-seed.json` in `kave-hub`. The app owns it from there;
  `build_shopping_seed.py` only ever writes the seed.
- **Tasks 6, 7, 8 were built as one commit** (`b40dc65`) plus the poll
  (`bf8b361`) - they are one mechanism and half of it is unsafe.
- **A genuinely hung `fetch`** leaves `flushing` / `syncing` true until the
  browser's own timeout fires (tens of seconds). Not worth an explicit
  `Promise.race` timeout for two users; revisit if it bites.
- **The kitchen review (plan Task 11) is not done** - the 10 deduced
  `Portions:` and the `frac` classifications still need Hugo and Isa to
  confirm them. The detail sheet already flags an unconfirmed base.

## Phase 3 picks up

`manifest.json` (name, icons, `display: standalone`, theme colour), a
`service-worker.js` (cache-first for the shell, network-first with a cache
fallback for the data so an offline open shows the last synced list),
add-to-home-screen on both phones, and an offline check in aeroplane mode.
