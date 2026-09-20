/* Spoon: the Meal Planner tab.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { $, $$, escapeHtml, own } from "./util.js";
import { recipeCard, updateRailFade } from "./view-recipes.js";

/* Spec: kave-hub docs/superpowers/specs/2026-09-07-spoon-meal-planning-tab-design.md. Read-only sections computed from the
   recipes already in state - no new sync path, nothing written back. */

// Ranked worst-first. `low` is never a reason for a row, so it is absent here.
const WASTE_RANK = { high: 0, medium: 1 };

// How many pairings show before the reveal button. One is enough to read the
// section as a list without it pushing "Good for leftovers" off the screen;
// the rest are one tap away, and the count is on the button so a collapsed
// section never hides how much it found. Same idiom as Worth watching.
const PAIRS_COLLAPSED = 1;
export let pairsOpen = false;

/* Randomise: both Plan sections have a settled order - worst perishable first,
   then the card order for the leftovers - which is the right default and the
   same every time you open the tab. The button trades that for a shuffle, for
   the evening you are looking at the tab because you cannot think what to
   cook. Held as a list of keys rather than as a shuffled copy of the rows, so
   a sync that changes the recipes cannot strand the order: anything the
   shuffle has not seen keeps its natural place at the end. Not persisted -
   a new shuffle is a tap away, and a remembered random order is just a
   worse default. */
let pairOrder = null;    // array of pair keys, or null for the settled order
let batchOrder = null;   // array of recipe slugs, ditto

export function shuffled(keys) {
  const a = keys.slice();
  for (let i = a.length - 1; i > 0; i--) {          // Fisher-Yates
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// order `items` by `keys`, leaving anything the shuffle never saw at the end
// in the order it already had
function applyOrder(items, keys, keyOf) {
  if (!keys) return items;
  const rank = new Map(keys.map((k, i) => [k, i]));
  return items
    .map((it, i) => ({ it, i, r: rank.has(keyOf(it)) ? rank.get(keyOf(it)) : Infinity }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.it);
}

/* "Worth pairing": recipes that share something whose pack outlives one
   recipe. The unit is the PAIR, not the ingredient - cebette and piment both
   join Ramen to Riz saute, and emitting that twice would read as two findings
   when it is one. So pairs are keyed by their recipe set and carry every
   perishable that joins them. Staples are excluded upstream, not here: the
   dictionary refuses a staple above `low` (build_groceries_dictionary.py), so
   an ingredient line's wasteRisk is the whole test. */
export function pairings(recipes) {
  const cooked = recipes.filter((r) => !r.stub && (r.ingredients || []).length);
  const byCard = new Map();          // slug -> { risk, name, recipes:Set }
  cooked.forEach((r) => {
    (r.ingredients || []).forEach((ing) => {
      if (!ing.slug || ing.slug === "none") return;
      if (!own(WASTE_RANK, ing.wasteRisk)) return;
      let e = byCard.get(ing.slug);
      if (!e) {
        e = { risk: ing.wasteRisk, name: ing.conceptName || ing.name, recipes: new Set() };
        byCard.set(ing.slug, e);
      }
      e.recipes.add(r.slug);
    });
  });

  const byPair = new Map();          // "a|b|c" -> { recipes:[], shared:[] }
  byCard.forEach((e) => {
    if (e.recipes.size < 2) return;
    const key = [...e.recipes].sort().join("|");
    let p = byPair.get(key);
    if (!p) {
      p = { recipes: key.split("|"), shared: [] };
      byPair.set(key, p);
    }
    p.shared.push({ name: e.name, risk: e.risk });
  });

  const rows = [...byPair.values()];
  rows.forEach((p) => p.shared.sort(
    (a, b) => WASTE_RANK[a.risk] - WASTE_RANK[b.risk] || a.name.localeCompare(b.name)));
  return rows.sort((a, b) =>
    // worst single ingredient first, then the pair that uses up the most
    WASTE_RANK[a.shared[0].risk] - WASTE_RANK[b.shared[0].risk]
    || b.shared.length - a.shared.length
    // no cooked log yet, so the spec's "least recently cooked" tie-break
    // cannot be applied - alphabetical keeps the order stable instead of clever
    || a.recipes.join().localeCompare(b.recipes.join()));
}

// One row: the perishables that join the recipes, then the recipes themselves,
// each its own tappable target opening the same sheet the Recipes tab opens.
function planRow(shared, recipeSlugs, byRecipe) {
  const li = document.createElement("li");
  li.className = "plan-row";
  const top = document.createElement("div");
  top.className = "plan-share";
  top.innerHTML = shared
    .map((sh) => `<span class="plan-chip ${sh.risk}">${escapeHtml(sh.name)}</span>`)
    .join("");
  li.appendChild(top);
  // The real cards, not their names: a pairing is a suggestion about what to
  // cook, so it should show what the Recipes tab shows. Three cards already
  // overflow a phone, and a pair can grow, so the strip scrolls sideways
  // rather than wrapping into a block that pushes the next row off screen.
  const strip = document.createElement("ul");
  strip.className = "plan-strip";
  recipeSlugs.forEach((slug) => {
    const r = byRecipe.get(slug);
    if (r) strip.appendChild(recipeCard(r));
  });
  // the same "there is more to the right" fade the filter rails use, so a
  // third card that does not fit is visibly a third card and not an edge
  strip.addEventListener("scroll", () => updateRailFade(strip), { passive: true });
  li.appendChild(strip);
  return li;
}

/* Give each strip the column width the Recipes grid would have chosen for the
   same container. This is `repeat(auto-fill, minmax(--card-min, 1fr))` done by
   hand - fit as many whole columns of at least --card-min as the width allows,
   then share the width equally between them - because a flex row has no
   auto-fill of its own. The strip and the grid are both laid out in main's
   content box, so the strip's own clientWidth is the right input and the two
   land on the same number at every screen width.
   Without this the strip was hardcoded two-up, which matched the grid on a
   phone and diverged the moment the grid went to three columns: 279px against
   183px at a 600px viewport. */
export function sizePlanStrips() {
  const strips = $$("#view-planner .plan-strip");
  if (!strips.length) return;
  const root = getComputedStyle(document.documentElement);
  const min = parseFloat(root.getPropertyValue("--card-min")) || 150;
  const gap = parseFloat(root.getPropertyValue("--card-gap")) || 10;
  strips.forEach((strip) => {
    const w = strip.clientWidth;
    if (!w) return;                       // tab hidden: nothing to measure yet
    const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
    strip.style.setProperty("--plan-card-w", (w - gap * (cols - 1)) / cols + "px");
    updateRailFade(strip);                // the width decides what overflows
  });
}

export function renderPlanner(state) {
  const byRecipe = new Map(state.recipes.map((r) => [r.slug, r]));
  const ul = $("#pairList");
  ul.innerHTML = "";
  const rows = applyOrder(pairings(state.recipes), pairOrder,
                          (p) => p.recipes.join("|"));
  const shown = pairsOpen ? rows : rows.slice(0, PAIRS_COLLAPSED);
  shown.forEach((p) => ul.appendChild(planRow(p.shared, p.recipes, byRecipe)));
  const toggle = $("#pairToggle");
  toggle.hidden = rows.length <= PAIRS_COLLAPSED;
  // nothing to reorder with one row, and an inert button reads as broken
  $("#pairShuffle").hidden = rows.length < 2;
  // the count is the pairings found, not the recipes in them
  toggle.textContent = pairsOpen ? "Show less" : `Show all · ${rows.length}`;
  const empty = $("#pairEmpty");
  empty.hidden = rows.length !== 0;
  empty.textContent = state.recipes.length === 0
    ? "Recipes sync from your repo once a token is set."
    : "Nothing pairs up yet. Recipes need their ingredient lists before this can see anything.";

  // "Good for leftovers": the recipes marked `Restes: oui` in their card,
  // shown as the same cards the Recipes tab shows and opening the same sheet.
  // No schedule and no keeping rules - which dishes are worth cooking big is
  // a kitchen judgement made in the card; the section just surfaces them.
  const batch = applyOrder(state.recipes.filter((r) => r.batch), batchOrder,
                           (r) => r.slug);
  const bul = $("#batchList");
  bul.innerHTML = "";
  if (batch.length) bul.appendChild(batchRow(batch));
  // after layout: neither a strip's width nor its overflow means anything
  // until the cards are in the document. Both sections' strips at once.
  sizePlanStrips();
  $("#batchShuffle").hidden = batch.length < 2;
  const bEmpty = $("#batchEmpty");
  bEmpty.hidden = batch.length !== 0;
  bEmpty.textContent = state.recipes.length === 0
    ? "Recipes sync from your repo once a token is set."
    : "No recipe is marked as one to cook big yet.";
}

// One row, no chip: the strip of recipes worth cooking once and eating twice.
// Same strip as a pairing row, so the two sections read as one tab.
function batchRow(recipes) {
  const li = document.createElement("li");
  li.className = "plan-row";
  const strip = document.createElement("ul");
  strip.className = "plan-strip";
  recipes.forEach((r) => strip.appendChild(recipeCard(r)));
  strip.addEventListener("scroll", () => updateRailFade(strip), { passive: true });
  li.appendChild(strip);
  return li;
}

/* An imported binding is read-only, so a module that does not declare
   one of these cannot assign to it. These are the writes that used to
   happen across what was a single shared scope. */
export function setBatchOrder(v) { batchOrder = v; }
export function setPairOrder(v) { pairOrder = v; }
export function setPairsOpen(v) { pairsOpen = v; }
