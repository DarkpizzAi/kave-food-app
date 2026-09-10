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

## The token, and what protects it

The GitHub token lives in `localStorage`, under `foodapp.settings`, in plain
text. There is nowhere better for it: this is a static page on GitHub Pages
with no server of its own, so a token that survives a reload has to sit
somewhere any script on the origin can read. `github.js` never touches storage
- the app pushes the token in with `setToken()` - but that is layering, not
protection. The input is `type="password"` with `autocomplete="off"`, and the
token is never logged, never put in a URL, and never rendered into markup: it
goes into an `Authorization` header, to `api.github.com` and nowhere else. The
service worker deliberately does not intercept anything cross-origin, so no
API response carrying it is ever cached.

That means **XSS is the whole threat model**. Anything that can run script on
this origin can read the token and write to the hub repo with it. So the rule
is that no synced string reaches the DOM as markup: every interpolation goes
through `escapeHtml`, and there is no `eval`, no `new Function`, no
`document.write`, no `insertAdjacentHTML`.

`escapeHtml` is not enough in an `href`, which is what `safeUrl()` is for. It
escapes characters, and a URL scheme has none for it to touch, so
`javascript:...` used to come through a template literal intact and become a
live link in this origin - reachable through a stub recipe's `sources`, which
are written in the hub repo. Sources are now required to parse as absolute
http(s) URLs, and anything else is dropped rather than rendered.

There is a **Content-Security-Policy**, as a `<meta http-equiv>` in
`index.html` - GitHub Pages serves static files and cannot set headers. The
load-bearing part is `script-src 'self'` plus a single hash, with no
`'unsafe-inline'` and no `'unsafe-eval'`, so injected script does not run even
if something one day does reach the DOM unescaped. `connect-src` is `'self'`
and `api.github.com` only, so a script that did run could not post the token
anywhere. `base-uri`, `object-src` and `form-action` are `'none'`.

`style-src` keeps `'unsafe-inline'`, because the app writes `style="..."`
attributes at runtime for the store colours. The narrower `style-src-attr` /
`style-src-elem` pair says that precisely where the browser understands it:
attributes yes, injected `<style>` elements no. CSS exfiltration would need an
external fetch anyway, which `img-src` and `connect-src` already refuse.

A meta CSP silently ignores `frame-ancestors`, `report-uri` and `sandbox`, so
they are absent rather than written down doing nothing. **Clickjacking is not
covered.**

### Recomputing the script hash

`script-src` carries a `sha256` of `#theme-preload`, the anti-flash theme
script inlined in `index.html`. Edit that script - one character of whitespace
or a comment is enough - and the hash stops matching and the script is blocked.
Recompute it with:

```
python -c "import re,hashlib,base64;b=re.search(rb'<script id=\"theme-preload\">(.*?)</script>',open('index.html','rb').read(),re.S).group(1);print('sha256-'+base64.b64encode(hashlib.sha256(b).digest()).decode())"
```

It matches on the `id` rather than on the first `<script>` in the file, and it
lives here rather than in `index.html` for the reason that cost an iteration
while it was being written: a command containing the text `<script></script>`
is itself the first thing a regex hunting for the script finds, so documenting
it in the file it parses made it hash its own documentation.

A blocked script would otherwise be silent - the symptom is the colour flash it
exists to prevent, not an error. So it announces itself: the script stamps
`data-theme-boot` on `<html>` before doing anything else, and app.js warns to
the console and shows a red *Theme preload BLOCKED* line in
*Settings > Display* when that stamp is missing.

`.gitattributes` pins `eol=lf`, so the bytes hashed locally are the bytes Pages
serves - a CRLF working tree would hash to something production rejects.

If a token is ever exposed, revoke it on GitHub; clearing it in Settings only
removes this device's copy.

## Status

**Phase 1** - UI and local state (`localStorage`).

**Phase 2** - GitHub Contents API sync with the private repo: read
`shopping-list.json` + `recipes.json`, write the list back with an
id-keyed merge for concurrent edits, pull-to-refresh, read-only mode
when no token, and a background poll - 60 s, or slower whenever GitHub's
`X-Poll-Interval` header asks for it.

The poll is **tab-independent** as of v11.10. It used to run only on the List
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
price series. Prices was missing from that dispatch until v11.10 - the gesture
ran and said "Syncing Prices" while fetching nothing - and it is guarded the
way `fullSync` guards it, so a missing `price-series.json` never degrades the
sync dot. Plan stops fetching the list at v11.10, since it renders recipes and
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
what the chart is pooling. A level with nothing to offer at all says so, and
since v11.12 the two levels say it differently: the variant pill reads *N/A* -
a card with no variants, or a product with none under a card that has them -
because "no variants exist" is a different fact from "all of them", and it
never takes the accent since it names an absence rather than the subject of the
chart. The product pill, which can only ever be empty, keeps its dash. A
pill you could not have chosen otherwise carries no ✕ and opens no dropdown;
one that does opens it under itself, floating over the chart without moving it.
Tapping a chart point, or *See all*, opens the full-history sheet: day and
month, product, store, quantity and price, in per-year blocks, one row per
shopping trip rather than per observation.

Since v11.10 a day is one reading. A chart line is collapsed to one point per
date at that day's mean, so two of the same thing in one trip no longer stack
two dots on one x; a dot that stands for several purchase rows highlights all
of them when tapped. A row covering several receipt lines shows their average
and carries the offer pill if any one of them was on offer - it used to show
the cheapest, which flattered every multi-buy - and tapping it reveals the
individual lines with their own prices and offer pills. *Worth watching*'s
corner says "Lowest price - 6 mo", since that is what the figure is.

Since v11.15 a Category pill is as wide as its own label, and shrinks only when
the row runs out of room. From v10.9 to v11.14 the three pills took fixed shares
of their rows instead - one geometric progression, card, variant, product, each
step x1.776 - which bought a row that never reflowed and charged the card pill
for it: it was the tightest thing on the card at 8 characters, so a short card
name sat half empty beside a variant that ellipsised. The card pill no longer
shrinks at all, since an ingredient card is a word or two by construction and
"Hou..." helps nobody; a 46% cap keeps a rare long one from crowding the variant
out, and the variant absorbs whatever the row is short by. The Category row ends
in a cart button - see below. Period (*6 months* / *All time*) and
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

**v11 - the Plan tab** - current at v11.14. Sections that read; nothing builds
a week or writes to the list yet. Spec: `V11-MEAL-PLANNING-TAB-SPEC.md`.

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

*Good for leftovers* shipped at v11.14, having held its place with a dashed
"Coming soon" box since the first cut. It surfaces the recipes marked
`Restes: oui` on their card in kave-hub, as the same cards the Recipes tab
shows, opening the same sheet. It carries no schedule and no keeping rules:
which dishes are worth cooking big is a kitchen judgement made in the card, and
the section only surfaces it. It was called *The bolognese move* until v11.14 -
renamed because it holds four dishes and the ragu is only one of them, so the
name says what the rows have in common instead of naming the flagship. Its
no-data message kept the dashed "Coming soon" box for two versions after it
stopped being a waiting section, which made a built section look parked; at
v11.16 it moved to the ordinary empty state, so the dashed box means one thing
again - the section does not exist yet - and *New to us* is the only one
wearing it.

*New to us* is still parked and still blank, waiting on data that is Hugo's to
supply rather than on code: the list of creators. When it is unparked, the point
of it is one tap writing a recipe we liked into the book, not a list of links.

Also at v11.14, *Worth pairing* collapses to one row behind a *Show all · N*
button, N being the pairings found rather than the recipes in them. It grew with
the book - four pairings once the new cards landed - and was pushing the section
below it off screen. Both sections carry a **Randomise** button by their title,
for the evening you open the tab because you cannot think what to cook. Each has
a settled order it is trading away - worst perishable first, then card order for
the leftovers - so the shuffle is held as a list of keys rather than a shuffled
copy of the rows: a sync that changes the recipes cannot strand it, and anything
the shuffle never saw keeps its natural place at the end. It is deliberately not
persisted, since a remembered random order is just a worse default.

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

The same pass found three things left deliberately unfixed - a back gesture
that can eat two dead presses, day-averaging that would pool stores under
*Group by = Product*, and an offer marker that picks its colour from an
arbitrary member. All three are reproduced and written up in
`FEATURE-PARKING.md` §4, with the trade-off each one turns on, so they are not
rediscovered from scratch or "fixed" without that trade-off being seen again.

`priceToday()` is memoised on the identity of the products map, the same
bounded-cache trick `deburr` uses. It is a full scan of every product's every
point, and `seriesInPeriod` calls it on every window it cuts - so
`computeOpportunities`, which cuts one window per product, was scanning the
whole dataset once per product: 213 scans per render of *Worth watching*, on
every render of the Prices tab, poll ticks included. That section now renders in
1.9 ms instead of 19.4. The map is only ever replaced wholesale, never mutated,
so its identity is an exact cache key rather than a heuristic.

**v11.12** is two things Isa asked for. *Trends* no longer needs two
purchases: the chart had a `filtered.length < 2` guard that hid it behind "Just
one purchase here - no line to draw", so a product bought once was invisible
even though the chart builder already handled a lone point. Now only an empty
period draws nothing, and one purchase is one dot with no polyline. And the
variant pill reads its label rather than its slug - `l2` became a slug in the
07/09/2026 kave-hub clean-up (`chocolate-filling`, `creme-de-cuisine-18`) and
each product carries the authored `l2_label` beside it, so `titleCaseVariant`
looks the label up, cached on the identity of the products map the same way
`priceToday` is. The variant dropdown sorts by that label too, since sorting
slugs orders it by a string nobody sees.

**v11.13** makes a list row added from a recipe price its *variant* rather than
its whole card. Recipes in kave-hub now carry an authored variant from the
shared vocabulary, so a row added from one arrives knowing both its card and
which kind it wants, and `priceHintFor` targets that variant when it has a
history. Carbonara's parmesan was being hinted against all 70 cheese
observations - mozzarella, philadelphia and brie included - and is now hinted
against the 6 parmigiano ones; mince goes from 21 pooled meat points to 16
minced-beef ones. Where the variant has no priced receipt line yet (the
bolognese's mixed mince, gruyere) it falls back to the card, which is the old
behaviour, and hand-typed rows are unchanged since they still resolve by name.
The list note now prefers the authored `variantLabel` ("Hachée mixte
boeuf-porc") over the derived `variantHint` ("hachée mixte") - the note is what
you read in the aisle, so the fuller name wins.

**v11.15 - one cart button** - the same round cart in the Trends chart and in
every recipe, so one gesture means one thing anywhere in the app: put this on
the list.

In *Trends* it ends the Category row and adds what the two pills say - the card,
plus the variant when one is named. A product selection adds the card and
variant that product sits under, never the product: a list row names what to
buy, not a SKU. In a recipe it replaces both the `+` on the ingredient rows and
the shopping-mode switch in the Ingredients header. That switch was the only
sliding toggle in the app, and it asked you to configure a mode before you knew
you wanted anything. Now one cart arms the rows and then leaves, because there
is a cart on every row and a twelfth would be noise. There is no way back out
and none is needed: closing the sheet is the exit, and `openRecipe` starts every
opening unarmed.

The confirm is shared - colour in, show a tick, stay inert for 1.5s, then revert
to a cart. A second tap while the tick is up does nothing, so a double tap
cannot quietly become two rows; a tap after it reverts adds the thing again,
deliberately. The list is a **tally, not a set**: two packs of mince is a real
thing to want, and *Clean up* already groups duplicates by concept. So `source`
is provenance now, not identity - nothing looks it up expecting to find at most
one - and the old behaviour where tapping an already-listed ingredient just
ticked it, and tapping the tick removed it, is gone with the mode it belonged
to. Nothing survives closing a recipe.

The two confirms are not the same mechanism, because the two buttons do not have
the same lifetime. Nothing re-renders an open recipe sheet, so an ingredient
row's button survives its own tap and carries its confirm on the element. The
Prices view re-renders on every change to the store - including the add the
button just made - so that one keeps its deadline in a variable the render reads,
and its timer reverts the button by looking it up, rather than re-rendering the
tab to swap a 17px icon.

The circle is 34px, which is what sits well in a row of pills and is under every
thumb-target minimum there is. The tap area is pushed back out to 44px without
the circle growing, reaching 5px into a 7px gap so it never takes a tap meant
for the pill beside it. Each button's `aria-label` names the thing it would add,
since eleven identical "Add to the shopping list" buttons down an ingredient
list tell a screen reader nothing.

**v11.17 - an empty filter rail hides itself.** The Recipes tab's Cuisine and
Type rails carry their label inside the rail, as static markup, so a book with
no recipes in it drew a bare "Cuisine" over nothing - which reads as chips that
failed to load rather than as a book waiting for a token. Both rails now hide
when they have no chips. The chip lists count over every recipe rather than the
filtered rows, so picking a cuisine cannot make the Type rail vanish under the
thumb that picked it; only an empty book hides them. Worth fixing rather than
shrugging at, because a reinstall clears `localStorage` and every manifest
change forces one - so both phones land on that screen and stay there until the
token is pasted back in.

**Phase 4 proper** - picking a week, scaling a set, merging into the shopping
list, and the cooking-rhythm loop. Still parked in `FEATURE-PARKING.md` §2.

Design notes and plans are in the private hub repo.
