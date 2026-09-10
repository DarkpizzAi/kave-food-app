# v11 - the Plan tab, first cut: three sections that read

Spec for the first real Plan tab. It takes the narrowest slice of the feature
parked as *The Plan tab - planning with insights (Phase 4)* in
`FEATURE-PARKING.md` §2: three sections that **tell you something**, and
nothing that builds a week or writes to the shopping list yet.

Measured against the real data: 43 recipes in `recipes.json`, of which **15
carry ingredient lines** and 28 are index-only stubs; 162 cards in the
groceries dictionary, 34 of them `produce`.

---

## 1. What the tab is for

Isa, setting the brief: three simple sections.

- **Worth pairing** - several meals that share ingredients, so nothing gets
  binned. The herb pack is the case that matters: a bunch of coriander is
  always too big for one recipe.
- **Good for leftovers** (originally *The bolognese move*) - cook a big base once (bolognaise) and later in the
  week only cook the fast fresh part (pasta). And the mirror case: recipes that
  *want* leftovers, like riz saute wanting yesterday's rice.
- **New to us** - a few content creators we like, and links to their videos or
  recipes we would probably enjoy. **Parked before any build** (§5): in v11
  this section is a "coming soon" line and nothing else.

The names are Isa's, picked 2026-09-05; §8 records what each one commits us to.

Two of the three point at recipes we already have, so a row must open that
recipe's detail sheet - the same swoop-up as the Recipes tab, not a new screen.

### What this is not

The picker, the week grid, scaling a set of recipes, merging their ingredients
into the shopping list, the rhythm log and repertoire growth all stay parked in
`FEATURE-PARKING.md` §2. This tab reads; it does not write. Keeping it
read-only is what makes it shippable without first answering "how is a plan
stored and synced".

## 2. What the data can actually support today

This is the finding that shapes everything below, so it comes before the
design.

**Only 15 of the 43 recipes have ingredient lines.** The other 28 are stubs
("link only" / "to write"). Every ingredient-based section can therefore only
reason over those 15. Across them, eight produce cards are shared by two
recipes or more:

| card | recipes | recipes sharing it |
|---|---|---|
| `ail` | 6 | fajitas, korean-nuggets, riz-saute, sauce-big-mac, thit-kho, travers-porc-poulet-citronnelle |
| `oignon` | 5 | bolognese, fajitas, pho, sauce-big-mac, soupe-a-l-oignon |
| `citron-vert` | 3 | fajitas, pho, thonade |
| `coriandre` | 3 | fajitas, pates-kefta-tomates, thonade |
| `carotte` | 2 | bolognese, riz-saute |
| `gingembre` | 2 | pates-kefta-tomates, pho |
| `cebette` | 2 | ramen, riz-saute |
| `piment` | 2 | ramen, riz-saute |

Read that table twice and the design falls out of it.

**Garlic and onion are at the top and they are worthless as a signal.** They
keep for weeks; you never bin half an onion because you only cooked one dish.
A section that ranks by "most shared" would put them first every time and be
ignored within a week. The section must rank by **how fast the thing dies**,
not by how often it recurs.

The dictionary cannot say that today. Its `staple` flag is set on 16 cards and
covers the store cupboard (rice, pasta, oil, salt, eggs, milk) - `ail` and
`oignon` are not on it, and would not belong there anyway; they are not
staples, they are simply durable. **A new field on the card is the one piece of
data *Worth pairing* cannot be built without** (§7).

It is not quite perishability, either. Minced beef dies fast, but you buy the
400 g the recipe asks for, so nothing is binned; ranking on perishability would
surface it, and pairing two mince recipes saves nothing. The field has to ask
the conjunction - **dies fast AND sold in a pack bigger than one recipe uses** -
so it is called `waste_risk`, not `perishable`.

With perishability in place, today's honest output is small: coriander
(3 recipes), spring onion and fresh chilli (2 each, and the same 2 both times).
Roughly **two or three rows**. That is not a failure of the design, it is the
28 stubs showing through - and it is the strongest argument yet for filling
them in. The section gets better every time a recipe gains its ingredient list,
with no code change.

**Nothing in the data knows what keeps.** No recipe says "this is a base",
"this freezes", "this wants leftovers". The only existing hook is riz saute,
whose first two lines are `slug: "none"` with
`slugNoneReason: "leftovers, not a purchased item"`. *Good for leftovers*
needs new recipe metadata (§7) and a hand pass over roughly ten recipes
before it says anything.

**The app cannot reach the internet.** Its only network call is the GitHub
Contents API, through the token in Settings. So *New to us* could never have
been a live feed: it would be a curated file in `kave-hub`, refreshed outside
the app, synced down the same pipe as recipes and prices. Parked either way
(§5), so v11 adds no file and no sync path.

## 3. "Worth pairing" - sharing a perishable

**Unit of the section: a pair of recipes and the one perishable that joins
them.** Not a list of ingredients, not a list of recipes - the pair is the
insight, because the pair is what you would actually cook.

Heading and subtitle, always visible (§8 explains why the subtitle is not
optional): **Worth pairing** / *Meals that share a perishable, so the bunch
gets used.*

Row content:

- the shared perishable, as a chip, weighted by risk - `high` takes the accent,
  `medium` stays quiet. A pair joined by two perishables shows two chips;
- **the recipes as their real cards**, the same ones the Recipes tab shows,
  in a strip that scrolls sideways. Not names, and not a bespoke row: a
  pairing is a suggestion about what to cook, so it should look like the
  thing you would have gone to the Recipes tab to find. Each card opens the
  same sheet;
- nothing else. No score, no percentage.

**One row, then a reveal button** (Isa, 2026-09-07). The section shows the
first pairing and a flat `Show all · N` button, the same control Worth
watching uses on the Prices tab; N is the number of pairings found, not the
number of recipes in them, so a collapsed section never hides how much it
found. Without the cap the section grew with the book - four pairings once
the pesto and sauce tomate cards landed - and pushed *Good for leftovers* off
the screen.

**Randomise** (Isa, 2026-09-07). Both recipe sections carry a flat
`Randomise` button by their title, which reshuffles that section's order. The
settled orders - worst perishable first, card order for the leftovers - are
right, and identical every time the tab is opened, which is exactly the
problem on the night you open the tab because you cannot think what to cook.
With the pairing section collapsed to one row, the button is effectively
"show me a different pair". The shuffle is held as a list of keys and is not
persisted: a new one is a tap away, and a remembered random order is just a
worse default.

A pairing is chips, then the strip, then space, and repeat - no container
around it and no rule between rows. A card in the strip is the same size as a
card on Recipes at every screen width, because the strip is given the column
width the grid's own `auto-fill` would have chosen for the same container
(§6a). Nothing is sized to fit a particular number of cards on screen; the
rest are reached by scrolling, and the "more to the right" fade is the filter
rails' own `updateRailFade`, not a second one.

Ranking:

1. cards flagged `waste_risk: high` first (fresh herbs, leaves, spring onion,
   celery, fresh chilli, mushrooms), then `medium`; `low` is never a reason for
   a row;
2. within a class, more shared perishables beats fewer;
3. ties broken by the pair least recently cooked - **once the cooked log
   exists**. It does not, so v11 ties break alphabetically and the ordering is
   stable rather than clever.

Guards:

- a pair only qualifies if the shared card is `waste_risk` medium or high and
  is not `staple`;
- both recipes must have ingredient lines, so stubs never appear;
- the same recipe may appear in several rows, but the same *pair* never twice.

Empty state: "Nothing pairs up yet. Recipes need their ingredient lists before
this can see anything." Honest about the cause, since the cause is fixable by
Isa and Hugo.

## 4. "Good for leftovers" - cooking once, eating twice

Two shapes live here, and pooling them would make both unreadable. They are
different rows.

**(i) Base then vehicle.** A recipe whose main body keeps, cooked big once,
then finished twice with something fast and fresh. Bolognaise is the flagship
and Isa's own description of the household's best habit: a big ragu on the
Sunday, fresh pasta on the Tuesday and the Thursday. The row reads as a small
schedule - one cook, then two short ones, with the vehicle named each time so
three bolognaise nights do not feel like one meal three times.

**(ii) Leftover eater.** A recipe that only works *because* something is left
over. Riz saute is the existing case: day-old rice, and leftover meat if there
is any. The row is stated from the leftover's side - "cooking rice this week?
riz saute eats what is left" - because that is the order the week happens in.

Both shapes tap through to the recipe sheet.

What each needs on the recipe (§7): for (i), which part is the base, how many
days it keeps, whether it freezes, and the vehicles it accepts; for (ii), which
leftovers it consumes. Riz saute's two `slug: "none"` lines already carry (ii)
in prose and can be lifted rather than retyped.

Scope guard: v11 **describes** the pattern, it does not schedule it. No day
assignment, no "cook this on Sunday" - that is the picker, and the picker is
parked.

**Status, 2026-09-07: shipped, as recipe cards only.** Isa's call: the section
shows the recipes worth cooking big, as the same cards the Recipes tab shows,
each opening the same sheet. No schedule, no keeping rules, no vehicles - the
`leftovers` block below was proposed and dropped, because the reheating detail
is not what makes the section useful. What is left is one hand-authored line
in the card header, `Restes: oui`, built into `batch: true` on the recipe
(§7b). First four: bolognaise, pâtes aux keftas et tomates, pesto, sauce
tomate.

**Renamed to "Good for leftovers"** the same day (§8), when the fourth entry
turned out to be a recipe we already had: the boulettes in a spicy sauce Isa
meant are `pates-kefta-tomates`, not a new dish, so the card written for them
was removed and the existing one flagged instead.

## 5. "New to us" - parked, ships as coming soon

**Status: parked by Isa, 2026-09-05, before any build.** In v11 the section is
a heading, its lede, and an empty box reading "Coming soon", in the place the
real section will occupy. Nothing is fetched, no file is added, no sync path
changes. It is blocked on the creator list, which is Hugo's to supply. The
shaping below is what it becomes when it is unparked.

The lede is written in the present tense it will keep once the section works,
and the empty box carries the "not yet" on its own - saying "coming soon" in
both the sentence and the box below it says it twice.

### The button is the feature

Isa, unparking condition: *"when I like a recipe, I click a button and it
writes it."*

That reframes the section. It is not a feed to browse, it is a **capture
surface**: the point of a row is the one tap that turns a video we liked into a
real entry in `kave-hub/food/data/recipes/`, alongside the 43 already there. A
list of links Isa then has to transcribe by hand is the failure mode, and it is
the shape the section would drift into if the button were treated as a later
addition. So the button is designed in from the first line of code.

Two consequences, both worth settling before that build starts:

- **Writing a recipe is not writing a list row.** The app writes
  `shopping-list.json` today through an id-keyed merge; a recipe is a file in a
  directory, built from markdown by `build_recipes.py`. Either the app learns to
  write a second, differently shaped thing, or the button writes a small "to
  import" queue that the existing `add-recipe` skill drains. The second is far
  less code in the app and keeps recipe authoring where it already lives.
- **What comes off a video is not a recipe yet.** A YouTube link is not
  ingredient lines with slugs and `frac`. So the button captures the intent -
  creator, title, url, the why, the date - and the recipe is written properly
  afterwards, by the same route as any other. The book stays real, which is the
  point of the name.

### The rest of the shaping

Rows come from a curated file, not from a search. Each row carries the creator,
the title, one line of why we would like it, and the link.

That one line is the whole value of a row. A bare list of links is a bookmark
folder; "his cold-oil garlic confit is the same trick as the aglio e olio you
already cook" is a reason to tap. It is written when the row is curated, never
generated in the app.

**Tapping opens the same swoop-up sheet**, not the browser. The sheet shows the
creator, the title, the why in full, and two buttons: open the video
externally, and the capture button above. This was a proposal beyond the
original brief - Isa asked for the sheet on the two recipe sections only - but
the capture button settles it: a row holding two actions needs the sheet.

Freshness: refreshed outside the app, on the existing Monday inbound sweep or
its own scheduled task. The file carries the date it was last refreshed and the
section shows it, so a stale radar admits it rather than looking current.

Still blocked on: **which creators**. Nothing else in the section is uncertain.

## 6. The sheet, opened from a second tab

`openRecipe()` already does what is wanted. What is not general is who owns the
sheet: `store.setView()` hardcodes `"recipes"` in four places - re-tapping the
tab closes the sheet, leaving the tab parks it, coming back unparks it. Opening
the same sheet from Plan and then switching to Recipes would strand it.

The change is contained: put the owning view on `detailState` at open time
(`detailState.owner = store.state.view`) and compare against that instead of
the string `"recipes"`. The Prices tab already proves the pattern -
`priceDetailState` is a second sheet with its own park and unpark - so this is
one sheet with two possible owners, not a third sheet.

Nothing about the sheet's contents changes: the scaler, the portions presets
and shopping mode all behave on the Plan tab exactly as they do on Recipes.
(Shopping mode changed shape at **v11.15** - a cart button arms it instead of a
switch, and there is no way back out of it - but it changed for both tabs at
once, which is the point of this section: `detailState.owner` is what the sheet
is scoped to, not the tab name, so nothing here had to be revisited.)

## 7. What has to change in kave-hub

Everything the app reads is built server-side. Three additions, all in the
private repo.

**a. `waste_risk` on the dictionary card. DONE, 2026-09-05.** A new field on
`food/data/groceries-dictionary/<slug>.md`, carried into
`groceries-dictionary.json`, required on every `ingredient: true` card and
refused on the others - the same conditional rule the builder already applies
to `frac`. Three values, defined by the conjunction in §2 and documented in
`groceries-dictionary-card-rules.md` §4:

- `high` - dies in days *and* the pack is several recipes' worth: the fresh
  herbs (coriandre, persil, basilic, basilic-thai, citronnelle), cebette,
  epinard, celeri, piment, piment-thai, champignon, shiitake, creme-fraiche;
- `medium` - a week or two, pack larger than one use: tomate, poivron,
  poireau, the opened charcuterie packs (lardon, jambon, guanciale), bread;
- `low` - everything else, including things that die fast but are bought to
  quantity (mince, fish), fruit eaten out of hand, frozen veg, and every
  store-cupboard card.

Written to all 129 ingredient cards. `build_recipes.py` stamps it onto each
ingredient line as `wasteRisk`, exactly the way it already stamps `frac` and
`conceptName`, so the app gets it with no new file and no new sync path.

Measured against the real recipes, the field earns itself. Ranking by shared
count alone would have led with ail (6 recipes), oignon (5), poivre and sel
(5 each). Ranking by `waste_risk`, with the one-row-per-pair guard, the whole
section today is:

    [high]    cebette, piment    Ramen express + Riz saute
    [high]    coriandre          Fajitas + Pates aux keftas et tomates + Thonade
    [medium]  lardon             Carbonara + Quiche lorraine

Three rows, and the first one is two perishables joining the same pair, which
is why the guard merges pairs rather than emitting a row per ingredient.

**b. The batch flag on the recipe. DONE, 2026-09-07.** One hand-authored line
in the card header:

    Restes: oui

`build_recipes.py` reads it into `batch: true` on the recipe and the Plan tab
filters on it. Nothing else: the fuller `leftovers` block first drafted here
(base, keeps_days, freezes, vehicles, uses) was written and then removed at
Isa's request - the section shows the recipe, so the recipe is all it needs.
Which dishes carry the flag stays a kitchen judgement, made in the card.

**c. The radar file - not in v11.** *New to us* is parked (§5), so this is
recorded for whenever it is unparked, not built now. New
`food/data/recipes-radar.json`:

    {
      "refreshed": "2026-09-08",
      "creators": [{ "name": "...", "handle": "...", "why": "..." }],
      "items": [{
        "creator": "...", "title": "...", "url": "...",
        "kind": "video" | "recipe", "why": "one line",
        "seen": "2026-09-08"
      }]
    }

It would sync by adding a `radarPath` beside `listPath` / `recipesPath` /
`pricesPath` in `github.js`, with `recipes-radar.dev.json` as the gitignored
localhost stand-in, exactly as `price-series.dev.json` works today. No personal
data, so nothing about the trust boundary changes. A second file would be
needed for the capture queue the button writes (§5), and that one *is* written
by the app, so it needs the same id-keyed merge discipline as the shopping
list.

## 8. The three names

Chosen by Isa, 2026-09-05.

| section | name |
|---|---|
| §3 pairing on perishables | **Worth pairing** |
| §4 cooking once, eating twice | **Good for leftovers** (was *The bolognese move*, renamed 2026-09-07) |
| §5 the radar | **New to us** (parked, §5) |

Two of the three carry a consequence worth writing down.

**Worth pairing** takes its register from *Worth watching* on the Prices tab,
which is the right family, but on its own it does not say what is being paired
or why. It needs a subtitle - one line, always visible, not a tooltip:
*"Meals that share a perishable, so the bunch gets used."* The rows then carry
no explanation of their own.

**The bolognese move** named one recipe for a pattern meant to widen past it -
the parked note's Part B explicitly wants new bases (dal, curry base, pulled
meat, roast-tomato sauce) added to the rotation. The tension was accepted on
purpose at first, then settled by renaming: **Good for leftovers**, Isa,
2026-09-07, once the section held four dishes and the ragu was only one of
them. The name now describes what every row has in common instead of naming
the flagship.

**New to us** frames the section as repertoire growth rather than browsing,
which is where Part D of `FEATURE-PARKING.md` §2 eventually goes - the
never-cooked book entries and the one-new-recipe cadence would sit under this
same heading without renaming it. The name also survived the section being
parked and re-shaped around the capture button (§5), which is a fair sign it
was named for the right thing.

## 9. Out of scope for v11

- Picking a week, assigning days, scaling a set, merging into the shopping
  list.
- The cooked log, the rhythm view, weak-night detection, repertoire growth.
- Everything behind *New to us* except its "coming soon" block (§5).
- Freezer state ("you have ragu in the freezer, just cook pasta").
- Cost per portion of a planned week - that waits on recipe costing, which
  waits on the confirmed `Portions:` values.
- Anything that makes the app fetch from outside GitHub.

## 10. Build order

0. ~~**Name the three sections.**~~ Done 2026-09-05, §8.
1. ~~**`waste_risk`** (§7a): the field, the hand pass, the stamp in
   `build_recipes.py`.~~ Done 2026-09-05, in `kave-hub`. Changed nothing
   visible; `--check` clean on 162 cards.
2. ~~**Generalise the sheet's owner** (§6).~~ Done 2026-09-05. `detailState.owner`
   is set at open time and `setView` compares against it. Verified: a sheet
   opened from Plan parks on the way out, is not adopted by the Recipes tab,
   survives a Recipes re-tap, unparks on returning to Plan, and closes on a
   Plan re-tap. The Recipes tab's own behaviour is unchanged.
3. ~~**The Plan tab shell and "Worth pairing".**~~ Done 2026-09-05, shipped as
   v11.10. Three sections replace the "coming soon" block, computed client-side
   from `state.recipes`; no new sync path. Pulling to sync on Plan now syncs
   recipes as well as the list, since Plan renders recipes.
4. ~~**The batch flag** (§7b) and "Good for leftovers".~~ Done 2026-09-07.
   Four recipes marked, two of them new placeholder cards (pesto, sauce
   tomate) written to carry the flag.
5. **"New to us" ships as a "coming soon" block** in the same position the
   real section will occupy - so the tab is three sections from the first
   deploy and the third one does not later shove the other two around.

Unparking *New to us* (§5) is its own piece of work, after v11: the curated
file, the sync path, the sheet, and the capture button that writes into the
book. It is blocked on the creator list and on deciding whether the app writes
recipes directly or writes an import queue the `add-recipe` skill drains.

Each step is a deploy of its own, and each deploy bumps `VERSION` in
`service-worker.js`.

### Two decisions taken during the build

**The staple guard moved into the dictionary.** §3 said a pair only qualifies
if the shared card is not `staple`. That would have meant shipping `staple`
down to the app alongside `wasteRisk` and applying the test client-side. It is
a property of the card, not of the moment, so `--check` now refuses a
`staple: true` card above `waste_risk: low` and the app reads one field. The
rule caught `pain`, which had been set to `medium`: bread is bought weekly
whatever we cook, so pairing two recipes to finish a loaf is not an insight.

**Rows name the perishable, they do not name its pack.** §3 asked for "one
bunch of coriander". There is no pack noun on a card, and inventing one per
row would be guessing - "one bunch of" is right for coriander and wrong for
mushrooms. The row shows the card's own name as a chip, weighted by risk. If
the phrasing is wanted later it needs a real field on the card, not a lookup
table in the app.

**The recipe card became a component.** Isa asked for the real cards in a
pairing row, so the card markup moved out of `renderRecipes` into
`recipeCard(r)`, and its box styling moved off `#recipeList li` onto
`.recipe-card`. The grid stays the Recipes tab's; the card no longer belongs
to it. Same for the scroll fade: `.rail-fade` lost its `.rail` qualifier so
one definition covers the filter rails and the card strips.

**No container, and no outline.** Putting the cards inside the section's
`.opp-card` container made them vanish: the container and the card are both
`var(--card)`, so in dark Cobalt a `#0f1013` card sat on a `#0f1013` container
with nothing marking its edge, and the contents read as floating text. An
outline on the card was tried and rejected. The container went instead, which
is the right answer for the same reason the Recipes tab has no container: on a
tab whose objects are cards, the cards are the layer, and anything wrapping
them is a second one that has to earn its place.

**The card is the Recipes card, at the Recipes size.** Not resized, not
restyled, not squeezed to fit three across. An earlier attempt to fit more
cards in ran straight into a flex item's `min-width: auto` - below about 160px
a long single word pushes its own card wider than its siblings, so "Carbonara"
came out at 157px beside a 143px neighbour - and a three-up card would have
needed the icon moved off the title's line, which is a different card.

**Matching the grid means running its algorithm, not copying its result.** The
strip was first hardcoded two-up. That matched the grid on a phone and was
wrong everywhere else: the grid is `repeat(auto-fill, minmax(150px, 1fr))`, so
it goes to three columns at around a 550px container and four beyond that,
while the strip stayed at two. At a 600px viewport the Plan card was 279px
against the grid's 183px, which is what Isa spotted.

A flex row has no `auto-fill`, so `sizePlanStrips()` does it by hand: fit as
many whole columns of at least `--card-min` as the width allows, then share the
width equally between them. The strip and the grid are both laid out in
`main`'s content box, so the strip's own `clientWidth` is the right input and
the two land on the same number. The two constants live in `:root` as
`--card-min` and `--card-gap`, read by the grid and by the function, so
changing a card's minimum width moves both tabs together. Verified equal at
320, 360, 390, 414, 430, 500, 600, 700, 768 and 900px - one, two, three and
four column cases.

**A specificity trap, worth writing down.** Moving the card's box styling from
`#recipeList li` onto `.recipe-card` silently broke it. `#recipeList` also
carries `class="list"` for the list reset, and `.list li` sets its own
`padding: 11px 4px`, `align-items: center`, `gap: 12px` and a bottom hairline;
the id had been out-specifying all four. A bare `.recipe-card` does not, so
the cards lost their 16px padding and gained a rule underneath - on the
Recipes tab as much as on Plan. The rule is `li.recipe-card`, which ties on
specificity and wins on source order. Any future move of a style off an
id-based selector in this file needs the same check.
