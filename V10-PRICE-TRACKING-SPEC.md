# v10 — the Prices tab, and what it lends the shopping list

Spec for the feature parked as *Receipts data → price intelligence* in
`FEATURE-PARKING.md`. That note set a build order: (1) process the receipt
data, (2) associate ingredients across recipes / list / receipts, (3) decide
the highest-value uses. Steps 1 and 2 are done — the ingredients dictionary
shipped 2026-09-02, the receipt normalisation landed in `kave-hub`. This is
step 3.

Measured against the real data: 25 receipt files, 56 shopping trips,
2024-01-10 .. 2026-08-29.

---

## 1. What the tab is for

Isa, setting the brief: *"That prices keep increasing is not news to us. I want
to highlight the few items that actually go down sometimes."*

That is a sharper feature than a general price tracker, and it rules things in
and out. An item that only ever ratchets up is not actionable — you buy it
anyway, at whatever it costs. An item that **dips** is actionable, because you
can time it: buy now, buy more, or wait.

So the landing view is a **watchlist of things that come back down**, not a
league table of biggest movers. Products that have never fallen are excluded
from it entirely rather than ranked last.

## 2. What a price series is keyed by

A series is only honest if every point in it is the same thing. Three keys were
tested against the data:

| key | series ≥ 4 dates | widest spread | what the spread was |
|---|---|---|---|
| `ingredient_slug` | 22 | **12.8×** | fresh vs tinned tomato pooled |
| `(slug, variant)` | 28 | **3.9×** | Gragnano vs Garofalo fusilli pooled |
| **product** | 25 | **1.7×** | genuine multi-year inflation |

**Decision: a series is keyed by product.** At product level every series in
the data falls under 2× spread, and the widest — eggs at 1.7×, EUR 3.44 → 5.95
over two and a half years — is a real price rise, not a mixing artefact.

This was the single biggest correction to the earlier draft of this spec, which
proposed `(slug, variant, brand)`. Brand is the wrong axis twice over: the
`brand` column is **0% populated** across all 519 rules, and it would not have
worked anyway, because `Danonino petit suisse maxi` and `Danonino de maduixa`
are one brand and two products, 3.9× apart in price.

Every one of the seven series that stayed wide under `(slug, variant)` is
explained by *these are different products* — except lemons, which is §4.

### Deriving the product key

No new column and no backfill. The product key is `item_normalised` with the
size, the multipack count, and a `Promocio:` prefix stripped:

    Promocio: Pasta Garofalo fusilli 500 g   ->  pasta garofalo fusilli
    Pasta Garofalo fusilli                   ->  pasta garofalo fusilli

`ingredient_slug` and `variant` do not disappear — they stop being the series
key and become the **browse hierarchy**: pick mozzarella, see the two
mozzarella products that have histories.

## 3. Unit

**EUR per kilo wherever possible** (Isa). Litres are treated as kilos for
liquids, which is the convention already implicit in `pack_size`.

Where a per-kilo price genuinely cannot be derived — the seven loose-produce
rows some tills rang up per piece — the series is charted **per piece** and
labelled as such, rather than being dropped or given an invented weight. A
nominal weight per piece would be a guess baked into the denominator, which is
the one error class this data has already suffered from (§7).

## 4. Two kinds of "down", and why they must not be pooled

A promotional dip and a base-price fall are different claims, and mixing them
would make the watchlist wrong in both directions.

`on_sale` is already recorded on every receipt line — 73 of 847 lines carry it.
The data shows why it matters:

- **Lemons** — `Llimones` EUR 2.89/kg, `Llimones en oferta` EUR 1.00/kg. Not a
  price fall; a promotion, and the sole reason lemons looked 2.9× volatile.
- **Carrots** — base price up 24% over the window, never once fell. But they go
  on offer at about −10%. "Never cheaper, except when it's on offer" is a
  genuinely useful thing to know, and it is invisible if the two are pooled.

**Decision:**

- Trend and drops are computed on **non-sale points only** — that is the base
  price, the thing that actually moved.
- Sale points are kept in the series, marked, and summarised separately as
  *"goes on offer, typically −X%"*.

## 5. What the tab shows

**A. Goes down sometimes** — the landing view, shipped under the heading
**Worth watching**. Products ranked by their largest
genuine base-price drop. Products that have never fallen are excluded. Run
against today's data this is 19 products; 3 are excluded as never-fallers.
The real output:

    Ous de corral Vall de Mestral      32% drop   trend  +8%    EUR 5.69/kg
    Mozzarella Galbani                 28% drop   trend -16%    EUR 10.00/kg
    Tomaquet branca madur              25% drop   trend  -1%    EUR 1.75/kg
    Alfabrega safata                   24% drop   trend  +5%    EUR 61.67/kg
    Ceba dolca                         23% drop   trend  +0%    EUR 2.15/kg
    Platan america                     22% drop   trend  +0%    EUR 1.75/kg
    Llimones                           22% drop   trend +13%    EUR 2.89/kg
    Pasta Garofalo fusilli             21% drop   trend  +6%    EUR 3.49/kg
    Nata fresca President cremosa 30%  17% drop   trend  +0%    EUR 12.00/kg
    ...

Mozzarella Galbani is the shape of thing this tab exists to surface: it drops
28% and its trend is genuinely **down** 16%. The flat-trend, real-dip items
(Ceba dolca, Platan america, Nata President, Cintes de baco) are the timing
candidates.

**B. Series detail** — price over time, points marked by store and by sale, so
"cheaper at Condis" and "that was a promo" are both visible rather than
asserted.

The view is steered by three always-present **pills — L1 (ingredient) · L2
(variant) · L3 (product)** — plus a **Group by** control. This replaced the
original zoom-out-only breadcrumb (Isa's follow-up): the breadcrumb could only
walk *up* the hierarchy from whatever was tapped, showed no L2 chip when the
product had no variant, and its inactive levels rendered greyed in a way that
read as broken.

Since **v10.4** the three sit on two labelled rows: **Category** (L1 + L2) and
**Product** (L3).

- **Exactly one pill wears the accent** (v10.5): the deepest one naming a real
  value, because that is the subject of the chart. A card pooled across its
  variants keeps it on L1; picking a variant moves it to L2, picking a product
  to L3. The levels above stay legible in grey — they still say where you are,
  they are just not the subject.
- A pill holding a pick the user made carries an inline **✕** to clear it and
  opens a dropdown; a value there was no choice about carries neither.
  Clearing drops the chart one pooling level up. Since v10.5 the ✕ can sit on a
  grey pill rather than an accent one, so it is drawn in `--rule-strong` — the
  one token that contrasts with `--surface-2` in both schemes.
- A level with **nothing to offer** — a card with no variants, a variant with no
  products of its own — shows an **em dash** in a short capsule (v10.5; floored
  at 40px so it never rounds into a circle) rather than a placeholder naming a
  choice that does not exist.
- A selection **drills past any level that offers only one choice** (v10.4):
  picking a card with a single product lands straight on that product. The
  levels it skipped then show that forced value rather than a placeholder. A
  card whose one variant does not cover the whole card — some product sits
  outside it — is *not* narrowed, and its Variant pill stays a real choice,
  because pooling the card and pooling that variant are different charts.
- Every pill that still has a choice to offer opens an inline dropdown.
  **L1 has a search field** (52 options);
  L2 and L3 never exceed ~15 rows so they don't. L2/L3 dropdowns lead with
  **"All variants"** / **"All products"**.
- The dropdowns **cascade**: L2 lists the variants under the chosen L1, L3 the
  products under the chosen L1 *and* L2. Choosing L1 resets L2 and L3; choosing
  L2 resets L3.
- Every pill on the card — the three filters and the Period / Group by
  dropdowns — is emitted by one `pillButton()` (v10.5), so “opens” is a single
  switch: an opening pill carries the `data-pill` the handlers bind to, and an
  inert one is `aria-disabled` rather than `disabled`, keeping the pill colours
  instead of the browser's greyed-out ones.
- **Group by** = **Supermarket** (default) draws one line per store, pooling
  everything in pill scope — the original behaviour. **Group by = Product**
  draws one line per variant (when only L1 is set) or per product (L2/L3 set),
  each from a fixed rotating line palette kept separate from Isa's store
  colours. Under Group by = Product the "latest price" card shows a dash when
  several products share the most recent date (there is no single latest
  price); "best price" stays the single cheapest point in the period across
  everything in view, with the store it was bought at.
- A **Reset** by the Trends title returns to the top Worth-watching item on the
  default 6-month, per-supermarket view — the same as tapping that row.
- The default period is 6 months, but a new selection opens on **all time**
  when 6 months cannot draw a line (fewer than two points) *and* all time has
  more to show, or when 6 months would hide the evidence behind a
  shopping-list bubble. The first test compares against the window rather than
  a fixed count, so a card bought once, long ago (Bouillon, February 2025)
  opens on all time and shows that purchase instead of reporting nothing.
  A period picked **by hand** always stands, even when it draws nothing — a
  year with one purchase is a true answer, and the chart says which nothing it
  is.

**C. The full-history sheet** — reached from *See all* or by tapping a chart
point, which scrolls to and highlights the row it came from. Rebuilt at v10.4
as a single CSS grid, header and rows sharing every column track so they cannot
drift: day and month, product, store, quantity, price, split into per-year
blocks. One row per **shopping trip**, not per observation — the same product
at the same shop on one day is one line carrying a quantity, priced at the
cheapest of them, and the promo pill follows that price. Tap a row to unclip
long product and store names.

Deliberately **not** in v10: a browsable catalogue of all 133 ingredients. The
L1 pill only lists ingredients that already have a product with history.

## 6. What it lends the shopping list

**The hint is per product, and it is a position hint: is this cheap right now,
by this product's own history?** When a list item resolves to a product with
enough history, show its typical price per kilo and flag the last paid price as
low, normal, or high against that product's own median.

This is only trustworthy because §2 made the series clean. Against
slug-level series it would have been noise — "tomatoes are 12× dearer than
usual" when the truth is that a tin was bought instead of a punnet.

The name match into the product keys is **case- and accent-insensitive** (the
keys are stored deburred and lowercased): a hand-typed list item like "Plàtano
América" resolves straight to its product, not just to the L1 card.

Deliberately **not** a preferred-store recommendation, which the parking note
proposed. Most series here are single-store (`steak-hache` 1 store,
`fromage-rape` 1 store), so "cheapest at X" would usually mean "only ever
bought at X" — a shopping habit wearing the clothes of a price finding.

The dependency runs one way: **the list reads the price data; the price data
never depends on the list.** The list stays writable and offline-first. Prices
are a read-only overlay that degrades to nothing when absent.

## 7. How much history there is, and the guards it forces

56 trips over 31 months, about 1.8 a month. 25 products clear 4 distinct dates;
the deepest is `Ous de corral Vall de Mestral` at 10.

- **4 distinct dates** minimum to chart a series at all.
- **6** minimum to appear in the watchlist. Ranking movement on three points is
  ranking noise.
- Trend measured **median-of-recent-half vs median-of-earlier-half**, not
  last-vs-first, so one odd week cannot top the list.
- A drop counts only at **≥ 3%**. Below that it is rounding, not a fall.
- **Stale after 6 months** with no observation: shown greyed, not as current.

## 8. Pipeline

Follows the existing model exactly. The app reads JSON from `DarkpizzAi/kave-hub`
at `food/data/` through the GitHub Contents API — the same token path as
`shopping-list.json` and `recipes.json`.

```
groceries-receipt-lines/*.csv  +  groceries-product-name-rules.csv
                |
                |  food/tools/build_price_series.py   (new, in kave-hub)
                v
          food/data/price-series.json   (generated, committed)
                |
                |  GitHub Contents API, read-only
                v
          Spoon — Prices tab, shopping-list hints
```

`price-series.json` is **generated, never hand-edited** — the same contract as
the ingredients dictionary. The app never writes it. Rebuilding joins the
extract routine, next to the Spend Dashboard rebuild.

### Guards the builder must apply

Each of these is a defect found in the real data while writing this spec:

- **Exclude non-positive lines.** One refund (`amount = -1`, `total = -2.25`)
  sits in the 2026-02 receipts and would drag a series down silently.
- **Refuse to emit a point with no `pack_size`** rather than guessing one.
  52 observations are in this state, listed in
  `kave-hub/food/data/groceries-pack-size-label-checks.md`.
- **Flag any series still wider than 2×** in the build output. At product level
  nothing legitimately is, so a wide series means a defect or a product key
  that merged two things.

## 9. Prerequisite: the denominator has to be trustworthy

`pack_size` is the denominator of every price per kilo, so an error there does
not leave a hole — it moves a product inside its own series, invisibly.

Nine such defects were found and fixed while writing this spec, all one class:
a **per-item** weight stored where the convention is **per-pack**.

```
Ous rojos M +58g, cistella de 6            58g    -> 348 g   (EUR 37 -> 6.18/kg)
Ous de corral Vall de Mestral 12 unitats   378 g  -> 756 g   (was the 6-pack weight)
Iogurt de maduixa Danonino 50 g, 6 unitats 50 g   -> 300 g   (EUR 33.80 -> 5.63/kg)
Cintes de baco Casa Tarradellas, pack de 2 100 g  -> 200 g
Alteza cintes de baco, pack de 2           100 g  -> 200 g
Cola Cao Energy 188 ml pack de 4           188 ml -> 752 ml
Hamburguesa de novilla 130 g, pack de 2    130 g  -> 260 g
Llet Pascual pack de 6, 188 ml             188 ml -> 1128 ml
Alteza nata de cuina 18% 200 ml, pack de 3 200 ml -> 600 ml
```

The egg one is the argument for caring: the 12-box is the *cheapest* per kilo,
and the bad denominator made it the dearest. A "good price" signal built on
that points the wrong way — the worst possible outcome for this tab.

**Convention, now explicit: `pack_size` is the total net weight or volume of
the pack as sold. Never one item, never a count.** The tell in the product name
is word order: "*100 g, pack de 2*" states a per-item size, "*6 unitats 378 g*"
states the total.

Still open, blocking full coverage: 52 observations with no usable `pack_size`
(`groceries-pack-size-label-checks.md`) — 29 products needing a label read, and
7 loose-produce rows needing the §3 per-piece treatment.

## 10. Navigation

New tab order (Isa), Prices second:

    shopping list (list) | price tracking (prices) | recipes (recipes) | meal planning (plan) | settings (settings)

Prices sits **alongside** the Plan placeholder, not in place of it.

## 11. Out of scope for v10

- Preferred-store recommendations (§6).
- A browsable all-ingredients catalogue (§5).
- Basket-level comparison, "this shop cost X% more than usual".
- Anything in the app writing back to the price data.
- Season awareness, which the Plan tab note wants — it depends on this landing.

## 12. Build order

1. `build_price_series.py` in `kave-hub` + the `price-series.json` contract.
2. Prices tab: watchlist (§5A), nav reorder (§10).
3. Series detail (§5B).
4. Shopping-list hint (§6).

Steps 2-4 are app-side and independent of further data work. The 52 blocked
observations improve coverage but block none of it.

**All four shipped**, v10.0 to v10.4 (2026-09-03). §11 still holds: none of the
out-of-scope items were built. The 52 observations with no usable `pack_size`
(§9) remain the one open data item.
