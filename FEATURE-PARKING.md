# Feature parking

Ideas shaped but **not** to be built yet. Nothing here gets implemented until
Isa says go. Keep this file additive.

A section that ships is not deleted - the specs and the README cite these
notes as where the idea came from - it gets a **Status** line saying what it
became, so the file never reads as a backlog of unbuilt work.

Current: §1 shipped as v10. §2 and §3 are still parked.

---

## 1. Receipts data → price intelligence

**Status: shipped as v10** (2026-09-03), specced in
`V10-PRICE-TRACKING-SPEC.md` and summarised in the README. Kept here because
that spec opens by citing this note. The rest of this section is the original
shaping, left as written; what follows is what it actually became.

Both candidate features were built: the Prices tab (a *Worth watching*
shortlist plus a per-selection chart over time) and the shopping-list store
hint (a coloured bubble, gated behind the confidence threshold §6 of the spec
sets - two observations at each of two stores, 15% apart).

The build order held. Step 1 (receipt normalisation) and step 2 (the
ingredients dictionary, 133 canonical cards) landed in `kave-hub` on
2026-09-02; the spec is step 3.

The open questions below have answers now: price history lives at
`food/data/price-series.json` in kave-hub and syncs on the same token and
Contents API path as the list and recipes; six months proved enough for the
shortlist, with the guards in §7 of the spec; ingredient identity was
introduced gradually, by resolving typed names server-side through the
dictionary rather than retrofitting IDs. Only the last one is still open -
basket composition is out of scope (§11), so "preferred store" stays
per-product.

### The data we have

Grocery receipts are being collected and lightly processed (see the household
finances / groceries work). Not yet in a shape the app can consume.

### Build order

1. **Process the receipt data further** — clean line items, normalise units,
   dedupe, get a stable per-purchase record: ingredient, store, date, quantity,
   unit, price, unit price.
2. **Associate ingredients across the three surfaces** — shopping list items,
   recipe ingredients, and receipt line items need to resolve to the same
   canonical ingredient. This is the hard part: fuzzy names, brands, pack sizes,
   languages. Probably a canonical ingredient list + alias map living in
   `kave-hub` alongside the other food data.
3. **Decide the highest-value uses of the data** — the two below are first
   guesses, not committed scope.

### Candidate features (first guesses)

- **New "Prices" tab**
  - A chart of unit price over time per ingredient.
  - A shortlist: the handful of ingredients whose price has moved most
    (up and down) over the tracked window — the stuff worth reacting to, not
    the full catalogue.
- **Shopping-list store hint**
  - Small indicator on a list item when an ingredient has a preferred store —
    either because we only ever buy it there, or because it's consistently the
    cheapest there.
  - Needs a confidence threshold so a one-off purchase doesn't set a preference.

### Open questions

- Where does the processed price history live and how does it sync? (Same
  token / private-repo path as list + recipes, presumably.)
- How much history is enough for the "price moved" shortlist to be meaningful?
- Canonical ingredient IDs: retrofit onto existing recipes and list, or
  introduce gradually?
- Is "preferred store" per-ingredient only, or does basket composition matter
  (one trip vs. splitting a shop)?

---

## 2. The Plan tab — planning with insights (Phase 4)

**Status:** parked, shaping. Named in the README as Phase 4; the Plan tab is a
placeholder today. One feature: a weekly planner whose picking, list-building,
and follow-through are all driven by what the app has learned about how we
actually cook. Formerly parked as four separate items (planning / component
batching / cooking rhythm / repertoire growth) — merged into one 2026-09-02 at
Isa's request, since none of them stands alone.

The parts feed each other: repertoire growth (D) supplies "try this" recipes to
the picker (A); the picker builds weeks around the batching pattern (B); marking
meals cooked feeds the rhythm view (C), which in turn tells the picker which
nights to plan a batch-reheat or a fast meal (A). Build order is likely A → B →
C → D, manual-first, insights layered on as the cooking history accumulates.

### Part A — plan the week

Core loop: pick a set of recipes for the week → scale each to 2 → merge their
ingredients into the shopping list (quantities summed, staples subtracted).
That's table stakes. Value-add in how recipes get picked:

- **Rotation memory** — track when each recipe was last cooked; don't resurface
  last week's meals; surface things not made in a while. Turns "what do we even
  eat" into a short curated shortlist.
- **Perishable overlap** — bias a week's picks toward recipes that share
  perishable ingredients, so half a bunch of coriander gets used, not binned.
- **Effort shape of the week** — tag recipes by effort/time; quick meals on
  known-busy nights, one involved cook at the weekend. Input: which nights are
  we home / out / have guests.
- **Season-aware (ties to feature 1)** — once price/receipt history exists,
  nudge toward recipes whose ingredients are in season right now.
- **Balance** — spread protein, cuisine, and veg across the week.
- **One new recipe** — the picker slots in one "new" from feature 3.

Shopping-list integration:

- Merge identical ingredients across recipes; sum quantities in a common unit
  (needs the canonical ingredient work from feature 1).
- Subtract a "staples we always have" list (oil, salt, pasta…).
- Group by store / aisle; respect preferred-store hints.
- Tag list items with their planned recipe(s), so dropping a recipe from the
  plan pulls its ingredients back out.

### Part B — build the plan around the batching pattern (the "bolognese pattern")

Isa & Hugo's signature move and biggest success: make a big batch of one
component, then twice more that week cook a fast fresh element around it (fresh
pasta) so it never tastes like leftovers. Bolognese is the flagship. The Plan
tab treats this as the primary way to plan a week, not a side effect.

- Recipes can have **components**: a *base* (keeps/reheats/freezes well without
  degrading) + a *fresh vehicle* (cooked to order, fast, cheap) + assembly.
- Tag bases with what matters: keeps N days in fridge, freezes yes/no, reheats
  without quality loss, scales up cleanly.
- A **base → vehicle library**: bolognese → fresh pasta / gnocchi / jacket
  potato / bake / polenta. Candidates to try: ragù (white, lamb), dal, curry
  base, shredded/pulled meat, roast-tomato sauce, chilli, black beans,
  soffritto as a head start, stock, braised greens.
- **Plan a batch week**: "double batch of X on day 1 → day 3 and day 5 are
  fresh-vehicle nights." List gets base ingredients once (doubled) plus the
  cheap fast vehicle for the other nights.
- **Vehicle variety**: same base, different vehicle each night, so three
  "bolognese nights" don't feel like one meal three times.
- **Grow the pattern**: track which bases have worked; suggest a *new* base with
  the same keeps-well property to widen the rotation beyond bolognese.

### Part C — the rhythm loop (tracking)

Goal: cook fairly often, consistently. Marking each planned meal
cooked / skipped / swapped / reheated-from-batch is the input — and the
tracking itself is something Isa wants ("could be quite fun").

- **Rhythm view** — meals cooked per week over time against a loose target.
  Visibility, not gamification; no guilt mechanics.
- **What we cooked log** — a simple history: what got made, when, batch vs
  fresh vs reheat. The raw material for every other insight here.
- **Weak-night detection** — which nights we reliably *don't* cook (takeaway /
  out). Part A then pre-empts those nights with a batch-reheat or a genuine
  15-minute meal instead of pretending we'll cook.
- **Post-batch momentum** — after a batch cook is marked done, surface the
  fresh-vehicle nights that follow so the win doesn't get wasted.
- **Two-nights-ahead check** — if the plan says cook tomorrow but a key
  perishable isn't on a recent receipt / not ticked off the list, flag it.

### Part D — repertoire growth from what we actually buy

Goal: learn new recipes, steadily. Uses the receipts ↔ recipes ↔ list
association from feature 1, plus the cooked log from Part C.

- **Idle ingredients** — things that show up on receipts regularly but aren't
  in any recipe we cook. We clearly like them; suggest recipes built around
  them.
- **One step away** — recipes that need only one or two ingredients we don't
  already buy routinely. Lowest friction to try.
- **Never-cooked book entries** — recipes saved but never marked cooked. Prompt
  to try one, or cut it so the book stays real.
- **New-recipe cadence** — track distinct recipes cooked per month; nudge
  toward one new one per week or fortnight. A growth target, not a guilt streak.
- Output: a small "try this week" shortlist (1–2, not a firehose) that the
  Part A picker can slot into an otherwise familiar week.

### Open questions

- How is the plan stored and synced? New file in `kave-hub/food/data/`?
- Days-assigned, or just "this week's set"?
- Manual-first: v1 = tick recipes + generate list; smart picking and batch
  scheduling layered on after?
- Do components live on the recipe (sub-recipe structure) or a separate "batch
  bases" collection that recipes reference?
- Freezer awareness — track what batch portions are in the freezer now, so it
  can say "you have ragù, just cook pasta"?
- Rhythm target: fixed number ("cook 4 nights a week") or learned from our
  sustained rate?
- Does "cooked" distinguish a real cook from reheating a batch portion?
  (Probably yes — both good, different meaning for rhythm.)
- How much of this depends on feature 1's canonical ingredients? (Merging
  quantities does; a basic picker and the rhythm loop don't.)
- Repertoire suggestions (D): only our own book, or an external source once the
  book is exhausted? And is "new" never-cooked or not-cooked-in-a-year?

---

## 3. Edge-to-edge window / transparent system bars

**Status:** parked, blocked upstream. Nothing to build — the pre-wiring is
already shipped (v9.11) and a probe to detect the change is in Settings >
Advanced > Display (v9.12).

### The ask

Bolt-style: app content fills the whole screen, status and gesture bars are
transparent overlays. Native apps get this with the Android edge-to-edge APIs.

### Why it does not work today

Not an Android version issue — Isa's phone is on Android 17 and the probe still
reads `Safe area top 0px` / "Not edge to edge". It is a **Chrome limitation**:
installed PWAs in `display: standalone` still refuse to draw behind the status
bar. Regular Chrome tabs have done edge-to-edge since Chrome 135; the WebApp
shell has not. Google started landing "short-edges cutout mode" for WebApps in
Chromium in July 2026 - not in stable, no flag, no timeline.

### What is already done

- **v9.11** - `.app-header` pads by `env(safe-area-inset-top)`. Zero effect
  while the inset is 0; when Chrome flips, the title clears the clock and the
  bar goes transparent over `--bg` in every theme, both schemes, for free.
  `syncHeaderHeight()` feeds it into `--header-h` so body/ptr/detail follow.
- **v9.12** - Settings > Advanced > Display reports display-mode, safe-area
  insets, viewport-vs-screen, ending in "Edge to edge" / "Not edge to edge".

### When to revisit

Either Isa notices the bars change on the phone, or a scheduled check ~Nov 2026.
Open the Display readout after any Chrome update. If it still says "Not edge to
edge" and this matters, the only route is a TWA (Bubblewrap) native shell -
sideloaded APK, no Play Store, sets the transparent bars itself.
