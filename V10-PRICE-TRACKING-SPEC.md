# v10 — the Prices tab, and what it lends the shopping list

Spec for the feature parked as *Receipts data → price intelligence* in
`FEATURE-PARKING.md`. That parking note set a build order: (1) process the
receipt data, (2) associate ingredients across recipes / list / receipts,
(3) decide the highest-value uses. Steps 1 and 2 are done — the ingredients
dictionary shipped 2026-09-02, and the receipt normalisation landed in
`kave-hub`. This is step 3.

Everything below is measured against the real data (25 receipt files, 56
shopping trips, 2024-01-10 .. 2026-08-29), not assumed.

---

## 1. The one decision that shapes everything: what a price series is keyed by

A series is only honest if every point in it is the same product. The obvious
key — `ingredient_slug` — is not that, and the data says so loudly. Keying by
slug alone, then adding `variant`:

| concept | by slug | by (slug, variant) | what the slug-level spread actually was |
|---|---|---|---|
| tomate | 12.8× | 1.4× | fresh vs tinned vs cherry pooled |
| yaourt | 6.8× | 1.4× | petit suisse vs greek vs plain |
| oignon | 5.4× | 1.3× | shallots vs sweet vs cooking |
| fromage | 3.8× | — | parmigiano next to brie |

Charted by slug, the Prices tab would show violent swings that are pure
product mix. A "biggest movers" shortlist built on it would rank exactly those
concepts first — it would be a mix detector wearing a price tracker's clothes.

**Decision: a series is keyed `(ingredient_slug, variant, brand)`.**

`variant` is already filled and settled. `brand` is the third axis because
after variant, every series still wider than 2× is a brand difference:

- `pates / fusilli` 2.2× — Garofalo at EUR 3.40/kg, Gragnano at EUR 7.38/kg.
  Both are fusilli. Neither price is wrong. They are not one series.
- `oeuf / plein air` 2.4× — Baldoma vs Vall de Mestral, plus genuine egg
  inflation across 2024-2026.

Brand is already a column in `groceries-product-name-rules.csv`. It costs
nothing to key on and it is the difference between a chart that means
something and one that does not.

## 2. What the tab shows

Two things, in this order. The second is the reason to build it.

**A. Movers** — the handful of series whose price has moved most over the
tracked window. Not the catalogue: the stuff worth reacting to. This is the
landing view.

**B. A series detail** — unit price over time for one `(slug, variant, brand)`,
points marked by store, so "cheaper at Condis" is visible rather than asserted.

Deliberately **not** in v10: a full browsable catalogue of all 133 ingredients.
Only 28 series clear four distinct dates (see §4); a catalogue would be mostly
empty shelves.

## 3. What it lends the shopping list

The parked note proposed a *preferred store hint*. The data supports a narrower
and more useful version.

**Decision: the hint is per `(slug, variant, brand)` and it is a price hint,
not a store hint.** When a list item resolves to a series with enough history,
show the typical price and flag when the last paid price was unusually high or
low against that series' own median.

Store preference is a weaker claim than it looks: most series here are
single-store (`steak-hache` 1 store, `fromage-rape` 1 store), so "cheapest at X"
would usually mean "only ever bought at X". That is a shopping-habit artefact,
not a price finding. Deferred until the data can distinguish the two.

The connection runs one way: **the list reads the price data, the price data
never depends on the list.** The list stays writable and offline-first; prices
are a read-only overlay that degrades to nothing when absent.

## 4. How much history there actually is

56 shopping trips over 31 months, roughly 1.8 a month. Per series:

- 28 series have >= 4 distinct dates
- 15 have >= 6
- best is `oeuf / plein air` at 17

This is thin, and it sets the guards:

- **Minimum 4 distinct dates** before a series is charted at all.
- **Minimum 6** before it can appear in Movers. Ranking movement on three
  points is ranking noise.
- Movement measured **median-vs-median** (recent half against earlier half),
  not last-vs-first. With this few points a single promo would otherwise top
  the chart every time.
- A series is **stale** after 6 months with no observation; show it greyed
  rather than implying the price still holds.

## 5. Pipeline

Follows the existing model exactly. The app reads JSON from
`DarkpizzAi/kave-hub` at `food/data/` through the GitHub Contents API, the
same token path as `shopping-list.json` and `recipes.json`.

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

`price-series.json` is **generated, never hand-edited** — same contract as the
ingredients dictionary. The app never writes it. Rebuilding is part of the
extract routine, next to the Spend Dashboard rebuild.

### Guards the builder must apply

Each of these is a defect found in the real data while writing this spec, not
a hypothetical:

- **Exclude non-positive lines.** One refund (`amount = -1`,
  `line_total = -2.25`) sits in the 2026-02 receipts. Averaged in, it drags a
  series down silently.
- **Exclude series below the date thresholds** in §4.
- **Refuse to emit a point with no `pack_size`** rather than guessing one.
  52 observations are in this state; they are listed in
  `kave-hub/food/data/groceries-pack-size-label-checks.md`.
- **Flag any series still spread wider than 3×** in the build output. Every
  time that fired during this spec it was a data defect, not a price move.

## 6. Prerequisite: the denominator has to be trustworthy

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

The egg one is the argument for caring: the 12-box is the *cheapest* per kilo
and the bad denominator made it the dearest. A "good price" signal built on
that would have pointed the wrong way — the single worst outcome for this tab.

**Convention, now explicit: `pack_size` is the total net weight or volume of
the pack as sold. Never the weight of one item, never a count.** The tell in
the product name is word order — "*100 g, pack de 2*" states a per-item size,
"*6 unitats 378 g*" states the total.

Still open, and blocking full coverage: 52 observations with no usable
`pack_size` (`groceries-pack-size-label-checks.md`), split into 29 products
needing a label read, and 7 loose-produce rows some tills rang up per piece,
which need a rule rather than a shopping trip.

## 7. Out of scope for v10

- Preferred-store recommendations (§3).
- A browsable all-ingredients price catalogue (§2).
- Basket-level comparison, "this shop cost X% more than usual".
- Anything writing back to the price data from the app.
- Season awareness, which the Plan tab parking note wants — it depends on this
  landing first.

## 8. Open questions for Isa

1. **Movers ranking** — by percent change, or by euros-per-year on how much we
   actually buy? The second favours staples, the first favours anything cheap
   and volatile. My recommendation is the second: it answers "what is costing
   us more" rather than "what wobbled".
2. **Loose produce** (7 rows) — nominal weight per piece, or keep them out of
   the per-kilo series and chart them per piece?
3. Does the Prices tab replace the placeholder Plan tab in the nav, or sit
   alongside it? Five tabs on a phone is tight.
