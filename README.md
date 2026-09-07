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

With no token, the local server loads `recipes.dev.json` and
`price-series.dev.json` (gitignored snapshots copied from kave-hub) so the
Recipes and Prices tabs are browsable offline of GitHub. Neither file ever
reaches the public repo.

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
id-keyed merge for concurrent edits, pull-to-refresh, read-only mode
when no token, and a background poll - 60 s, or slower whenever GitHub's
`X-Poll-Interval` header asks for it.

The poll is **tab-independent** as of v11.6. It used to run only on the List
and Plan tabs, on the reasoning that fetching data for a tab you cannot see is
waste. It is not: every sync is a conditional GET carrying an ETag, and a 304
costs a header exchange and is not charged against GitHub's hourly limit. The
tab condition bought almost nothing and cost real bugs, so whichever tab you
are on, its data is at most one interval stale.

It runs two lanes, because the three files do not move at the same speed. The
**shopping list rides every tick**: it is the only one two people edit at once,
so a minute matters. **Recipes and the price series ride a 10-minute lane** -
they change when someone writes a recipe or the weekly rebuild runs, and they
are the large payloads when they do (about 55 KB and 107 KB against the list's
few). The lane is time-based, not a tick count, because `pollTick` is also
called directly on becoming visible and on coming back online, and those must
not shift its cadence or skip it after a long sleep. `fullSync` stamps the
lane on completion, so opening the app does not fetch everything twice.

The lane is stamped only when it is actually entered, not when it merely comes
due: if the list sync throws first - offline, rate limited - recipes and prices
never ran, and stamping anyway would push them out another ten minutes over a
failure that had nothing to do with them. And `syncing`, the latch that stops
two syncs overlapping, is now cleared in a `finally` in all three sync paths.
It was being cleared on the normal tail, which is fine until `syncFailed`
throws - it renders, and rendering runs arbitrary code - after which the latch
stayed on for the rest of the session and every later sync returned at its own
guard. The app would have gone quietly stale with no error to show for it.

Pulling down on a tab syncs what that tab shows, and only that: List pulls the
list, Recipes pulls recipes and the list, Plan pulls recipes, Prices pulls the
price series. Prices was missing from that dispatch until v11.4 - the gesture
ran and said "Syncing Prices" while fetching nothing - and it is guarded the
way `fullSync` guards it, so a missing `price-series.json` never degrades the
sync dot. Plan stops fetching the list at v11.5, since it renders recipes and
nothing else; that comes back when the planner starts writing to the list.

The gesture does not arm on Settings at all. That tab has no data of its own,
so a pull could only spin and fetch nothing, and *Sync now* - which syncs
everything - is already on it.

**Phase 3** - PWA: `manifest.json`, service worker, add-to-home-screen,
offline open.

The List is home. Leaving it pushes exactly one history entry, so the phone's
back gesture returns there from any other tab rather than closing the app, and
it is always a single press however many tabs you hopped through. An open sheet
takes the press first - back closes the sheet, back again goes home. Tapping
List does not pop the entry, deliberately: racing `history.back()` against an
open sheet's own entry would pop the wrong one.

**UI batch** - renamed to Spoon with a new bowl-and-spoon icon; Rubik
throughout; six own palettes (Cobalt, Amber, Chartreuse, Lime, Tangerine,
Volt) replacing the app-clone set, each a light and a dark tonal ladder;
a custom theme editor that edits light and dark separately; the phone's
status bar tracks the app background in both; tab labels and an accent
bubble behind the active tab; "All" chips on the recipe filters; the sync
banner replaced by the Settings sync section; all 43 recipes including
index-only stubs ("link only" / "to write").

**v10 - Prices** - a Prices tab, current at v10.11.

*Worth watching* ranks the products that have genuinely dropped in the last 6
months, not merely moved. *Trends* charts one selection over time: one line per
store, or one per product when the selection spans several. It is steered by
two filter rows - **Category** (the ingredient card, and its variant) and
**Product** - plus **Period**, **Group by** and a **Reset**. A selection drills
past any level that offers only one choice, and the accent marks the deepest
level naming a real value - the subject of the chart - with the levels above it
in grey. An unset level reads *All variants* / *All products*, since that is
what the chart is pooling; a level with nothing to offer at all shows a dash. A
pill you could not have chosen otherwise carries no ✕ and opens no dropdown;
one that does opens it under itself, floating over the chart without moving it.
Tapping a chart point, or *See all*, opens the full-history sheet: day and
month, product, store, quantity and price, in per-year blocks, one row per
shopping trip rather than per observation.

Since v11.8 a day is one reading. A chart line is collapsed to one point per
date at that day's mean, so two of the same thing in one trip no longer stack
two dots on one x; a dot that stands for several purchase rows highlights all
of them when tapped. A row covering several receipt lines shows their average
and carries the offer pill if any one of them was on offer - it used to show
the cheapest, which flattered every multi-buy - and tapping it reveals the
individual lines with their own prices and offer pills. *Worth watching*'s
corner says "Lowest price - 6 mo", since that is what the figure is.

The three filter pills take their width from their row rather than from their
own label, so a pick never reflows the row. The widths are one geometric
progression - card, variant, product, each step x1.776 - and the Category row
deliberately stops short of the Product row. The ratio is not a taste call:
`r^2 + r = k` ties the common ratio to how much of its row the Category pills
take, and k = 0.88 is the value picked. Period (*6 months* / *All time*) and
Group by (*Shops* / *Products*) are segmented controls sharing one line under
the chart - two options never earned a dropdown, so both halves are always
visible and one tap switches. A half with nothing behind it stays named and in
place, greyed.

Shopping-list rows get a price-history icon and a store-coloured bubble when
one store is clearly cheapest. Series are keyed by product, not by ingredient -
see `V10-PRICE-TRACKING-SPEC.md` for why. Real data: `state.prices` syncs from
kave-hub's `food/data/price-series.json` (`build_price_series.py`), same GitHub
Contents API path as recipes and the list, with `price-series.dev.json` as the
localhost stand-in when there is no token. A typed name ("Fusilli", "Pasta")
resolves to a product, a variant or a card via that file's `resolve` index,
built server-side against the ingredients dictionary - never guessed
client-side.

**v11 - the Plan tab, first cut** - current at v11.0. Three sections that
read; nothing builds a week or writes to the list yet. Spec:
`V11-MEAL-PLANNING-TAB-SPEC.md`.

*Worth pairing* finds recipes that share something whose pack outlives one
recipe - the bunch of coriander that is always four recipes' worth. It ranks
on `waste_risk`, a new field on every ingredient card in kave-hub, which asks
whether buying the thing for one recipe leaves a usable amount to bin. That is
not perishability: mince dies fast but you buy the 400 g the recipe asks for.
Ranking on perishability instead would have led with garlic, onion, salt and
pepper. The row is the *pair*, not the ingredient, so two perishables joining
the same two recipes make one row with two chips, and the recipes show as
their real Recipes-tab cards in a strip that scrolls sideways with the same
right-edge fade the filter rails use. A pairing is chips, strip, space, and
repeat - no container and no rule between rows, because on a tab whose objects
are cards the cards are the layer. A card is the same size on both tabs at
every screen width: a flex row has no `auto-fill`, so `sizePlanStrips()` runs
the grid's own algorithm against the strip's width, off the same `--card-min`
and `--card-gap` the grid uses. Two up on a phone, four on a tablet, no
breakpoints and no card styling scoped to the Plan tab.

*The bolognese move* and *New to us* both ship built but blank, each holding
its place with a dashed "Coming soon" box. Both are waiting on data that is
Hugo's to supply, not on code: the first needs a `leftovers` block on the
recipes (which dish is a base, how long it keeps, what finishes it - kitchen
judgements, not something to infer), the second needs the list of creators.
When *New to us* is unparked, the point of it is one tap writing a recipe we
liked into the book, not a list of links.

The recipe sheet is no longer the Recipes tab's: `detailState.owner` records
which tab opened it, so Plan opens the same swoop-up sheet and it parks,
unparks and closes against Plan rather than being adopted by Recipes.

Two things came out of a review pass over v11. Every dictionary keyed by a
string from outside - the products map, the resolve index, the store colours,
the waste ranks - now goes through an own-property test. A plain object
inherits `Object.prototype`, so `products["constructor"]` answered with a
function rather than nothing: typing *constructor* into the shopping list
resolved to a product whose entry had no `series`, and the `TypeError` took the
whole list render down with it - on a row that persists in `localStorage`, so
the list came back broken on every load until the row was gone, which could not
be done from an app that would not render. The products map is reached through
one guarded `productEntry()` now.

`priceToday()` is memoised on the identity of the products map, the same
bounded-cache trick `deburr` uses. It is a full scan of every product's every
point, and `seriesInPeriod` calls it on every window it cuts - so
`computeOpportunities`, which cuts one window per product, was scanning the
whole dataset once per product: 213 scans per render of *Worth watching*, on
every render of the Prices tab, poll ticks included. That section now renders in
1.9 ms instead of 19.4. The map is only ever replaced wholesale, never mutated,
so its identity is an exact cache key rather than a heuristic.

**Phase 4 proper** - picking a week, scaling a set, merging into the shopping
list, and the cooking-rhythm loop. Still parked in `FEATURE-PARKING.md` §2.

Design notes and plans are in the private hub repo.
