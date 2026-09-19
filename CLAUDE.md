# Spoon - non-negotiables

Rules that are expensive to break and easy to break by accident. Everything
else, including the whole design system, lives in the `design` plugin of the
private `kave-hub` repo: read `design/data/household-look.md` and
`design/data/household-tokens.css`, or invoke its `apply-household-look`
skill. **Do not restate the design system here.** This repo is public.

## Never rename

The repo slug, its GitHub Pages URL, and the `CACHE` name in
`service-worker.js` are the deployment's identity. This is why the repo, the
URL and the cache still say `kave-food` while the app is called Spoon: the
user-facing name was the only thing that changed. Renaming any of the others
moves the live URL and orphans every installed copy on both phones.

## Bump `VERSION` on every deploy

In `service-worker.js`. No exceptions, and a look or token change counts. A
stale service worker will keep serving the old shell, and the symptom looks
like "my change did nothing" rather than like an error.

**Verifying a deploy by checking that it deployed is not verifying it.** The
`v6` deploy passed every structural check - build green, worker activated,
new cache name, new title - while serving the old stylesheet out of the
browser's HTTP cache. Verify by reading a value only the new code can
produce.

## Two service-worker traps, both paid for

- **Precache with `cache: "reload"` on every request.** `c.addAll()` goes
  through the browser's HTTP cache, and Pages serves the shell with a ten
  minute max-age, so a `VERSION` bump straight after a deploy can fill the
  brand new cache with the files it was meant to replace. That is exactly
  what `v6` did.
- **Claim before deleting old caches, not after.** The outgoing worker keeps
  serving until this one claims its clients, and its stale-while-revalidate
  reopens its own cache - recreating the one just deleted. `kave-food-v7`
  came back from the dead moments after `activate` cleaned it up.

If a reload shows an old version, read
`food/data/kave-food-app-browser-preview-on-pc.md` in the hub repo before
changing anything. The obvious fixes for that symptom do not work.

## Security: XSS is the whole threat model

The GitHub token sits in `localStorage` in plain text, because a static page
with no server of its own has nowhere better. Anything that can run script on
this origin can read it and write to the private repo.

- Every synced string reaches the DOM through `escapeHtml`.
- Every URL goes through `safeUrl`. Escaping does nothing to a
  `javascript:` scheme, which is how a stub recipe's `sources` field once
  produced a live `javascript:` link on this origin.
- No `eval`, no `new Function`, no `document.write`, no
  `insertAdjacentHTML`. Not "avoid" - none.
- **Recompute the CSP hash after touching `#theme-preload`**, even by one
  character of whitespace. The command is in the README, deliberately not in
  `index.html`. A blocked script is silent; Settings flags it, which is the
  only reason you would notice.

## `eol=lf`

Pinned in `.gitattributes`. The CSP carries a sha256 of an inline script, so
the bytes hashed locally have to be the bytes Pages serves. A CRLF working
tree hashes to something production rejects.

## The list is a tally, not a set

**Adding the same thing twice is deliberate**, not a bug to fix. `source` is
provenance, not identity, and one cart button is the whole add gesture. A
well-meant deduplication here breaks the feature.

## Check the no-token state

The app with no token saved is a real screen, seen after every reinstall. It
is invisible to a diff and to a dev run with a token present, and that blind
spot hid three defects in the v11 release alone. Test it deliberately.

## Four sync rules, all bug-driven

Before touching the sync engine, read the Status section of the README, which
explains each. In short: conditional GETs carrying an ETag, so a 304 is free
and uncharged; two lanes, so the contended file is not held back by the large
ones; a lane stamped only when actually entered, never when merely due; and
the `syncing` latch cleared in a `finally`. Clearing that latch on the normal
tail leaves it stuck on after one throw, and the app then goes quietly stale
with nothing to show for it.

## `tokens.css` - not yet, and then generated

Spoon has **not** adopted the shared token file. Its palettes still live in
`styles.css`, and that is the current correct state.

When the migration lands, `tokens.css` becomes a verbatim generated copy of
`design/data/household-tokens.css`, placed by the hub's
`design/tools/sync-household-tokens.py`. From that point: never hand-edit it,
and flip Spoon's flag in that script's `TARGETS` in the same commit that
links it, or the drift check stops guarding this app silently.
