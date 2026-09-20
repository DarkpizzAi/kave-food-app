/* Spoon: price series maths. No DOM in this file.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { store } from "./store.js";
import { $, deburr, escapeHtml, own } from "./util.js";
import { stripQty } from "./view-list.js";

/* Data is store.state.prices, synced from food/data/price-series.json in
   kave-hub (build_price_series.py). Everything below reads it live off
   store.state, never a cached snapshot, so a background sync updates the
   Prices tab the same way a list sync updates the list. See that script's
   docstring for exactly what "products" and "resolve" mean and why. */

// fixed roster (v10 spec): a store outside this list renders greyscale, never
// a made-up colour. Ametller needs a theme-aware pair, so it is read from a
// CSS custom property instead of a literal hex.
const STORE_COLORS = {
  "Keisy": "#F27D16",
  "Mercadona": "#289148",
  "Condis": "#2EA684",
  "Carrefour": "#0E5299",
  "Alcampo": "#D92929",
};
export function storeColor(store) {
  if (store === "Ametller Origen") return "var(--store-ametller)";
  return own(STORE_COLORS, store) ? STORE_COLORS[store] : "var(--text-dim)";
}
// lines that aren't a supermarket (Group by = Product: one line per variant or
// product) have no established colour of their own - Isa's store colours must
// not move, so product lines get their own fixed rotating palette, assigned by
// the line's sorted position so it's stable across renders.
const LINE_PALETTE = [
  "#2563EB", "#16A34A", "#DB2777", "#D97706",
  "#7C3AED", "#0891B2", "#DC2626", "#4D7C0F",
];
export function lineColor(i) { return LINE_PALETTE[i % LINE_PALETTE.length]; }
// the icon drawn on top of a store-coloured bubble: white everywhere except
// Ametller, whose pair goes light in dark mode and would vanish under white
export function storeOnColor(store) {
  return store === "Ametller Origen" ? "var(--store-ametller-on)" : "#fff";
}

// The one way into the products map. Guarded, because `key` reaches here from
// a typed list item and from a data-price-key attribute alike; a missing
// product is a normal answer (a stale key, a product dropped by the last
// rebuild), never a crash.
export function productEntry(key) {
  const products = store.state.prices.products;
  return own(products, key) ? products[key] : null;
}

function priceKeyFor(name) {
  return stripQty(name);
}

// the resolve index is keyed the same way build_price_series.py's
// normalise() builds it: deburred, lowercased, elision and punctuation
// stripped. The 3-way suffix try below (as typed / "es"->"a" / trailing "s"
// dropped) mirrors link_shopping_list.py's match() exactly, on purpose - one
// algorithm, two languages, so the two never drift apart. Deliberately NOT
// the fuller stopword/singularisation machinery those Python tools use for
// bulk, unsupervised matching: this is one word, tapped live, and a miss
// just means no hint (never a guess) rather than needing that much power.
function normaliseForResolve(name) {
  return deburr(name || "")
    .toLowerCase()
    .replace(/\b[dl]'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function resolveInIndex(name) {
  const resolve = store.state.prices.resolve;
  const n = normaliseForResolve(name);
  if (!n) return null;
  for (const cand of [n, n.replace(/es$/, "a"), n.replace(/s$/, "")]) {
    if (cand && own(resolve, cand)) return resolve[cand];
  }
  return null;
}

// what a typed name (a list item, a recipe ingredient) resolves to: the
// exact product if it matches one (someone typed the full product name), else
// the variant it names, else the card it names, else nothing - never guessed.
export function resolvePriceTarget(name) {
  const exactKey = priceKeyFor(name);
  // product keys are deburred AND lowercased; stripQty only deburrs, so a
  // list item with any capital ("Plàtano América") never matched a
  // product and fell back to the L1/L2 index. Match case-insensitively.
  for (const cand of [exactKey, exactKey.toLowerCase()]) {
    if (productEntry(cand)) return { level: "l3", key: cand };
  }
  const hit = resolveInIndex(name);
  if (!hit) return null;
  return hit.level === "l2"
    ? { level: "l2", l1: hit.l1, l1_label: hit.l1_label, l2: hit.l2 }
    : { level: "l1", l1: hit.l1, l1_label: hit.l1_label };
}

// every point from every product sharing this l1 (and l2, if given) - Isa's
// call on the L1/L2 chart (v10 follow-up): pool every product under a card
// or variant into one line per store, same as the very first sketch of this
// feature. Deliberately re-mixes what the product-level key (spec §2) keeps
// apart at L3 - flagged and confirmed, not a silent regression.
function pooledSeries(l1, l2) {
  const out = [];
  for (const entry of Object.values(store.state.prices.products)) {
    if (entry.l1 !== l1) continue;
    if (l2 != null && entry.l2 !== l2) continue;
    out.push(...entry.series);
  }
  return out;
}

// like pooledSeries, but every point is tagged with the product it came from
// (key, label, variant) so the chart can draw one line per variant or product
// when Group by = Product, not just one line per store.
function scopedPoints(target) {
  if (!target) return [];
  if (target.level === "l3") {
    const entry = productEntry(target.key);
    if (!entry) return [];
    return entry.series.map((p) =>
      ({ ...p, prodKey: target.key, prodLabel: entry.label, variant: entry.l2 }));
  }
  const out = [];
  for (const [key, entry] of Object.entries(store.state.prices.products)) {
    if (entry.l1 !== target.l1) continue;
    if (target.level === "l2" && entry.l2 !== target.l2) continue;
    for (const p of entry.series) {
      out.push({ ...p, prodKey: key, prodLabel: entry.label, variant: entry.l2 });
    }
  }
  return out;
}

// display helper for the three Product pills and the variant legend.
//
// l2 is a SLUG since the 07/09/2026 clean-up ("chocolate-filling",
// "creme-de-cuisine-18"), and every product carries the hand-authored
// `l2_label` next to it ("Chocolate filling", "Crème de cuisine 18%"). The
// label is the thing to show; the slug is never displayed. Build the lookup
// once per products map rather than scanning on every pill render - same
// bounded-cache trick, and the same exact key, as priceToday.
//
// The fallback un-kebabs and capitalises the slug, which is what an older
// price-series.json (or a variant with no row in groceries-variants.csv)
// still lands on. It is a fallback, not the path: the builder reports any
// variant with no label rather than letting one quietly reach here.
let variantLabelCache = { products: null, map: null };
function variantLabels() {
  const products = store.state.prices.products;
  if (variantLabelCache.products === products) return variantLabelCache.map;
  const map = new Map();
  for (const e of Object.values(products)) {
    if (e.l2 && e.l2_label && !map.has(e.l2)) map.set(e.l2, e.l2_label);
  }
  variantLabelCache = { products, map };
  return map;
}
export function titleCaseVariant(s) {
  if (!s) return s;
  const known = variantLabels().get(s);
  if (known) return known;
  const words = s.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
// a card's display label, from any product sitting on it - the price data is
// the only place the app has one, since it never loads the dictionary itself
export function cardLabel(l1) {
  for (const e of Object.values(store.state.prices.products)) {
    if (e.l1 === l1) return e.l1_label;
  }
  return null;
}
// distinct L1 cards that have any product with a series, sorted by label
export function l1Options() {
  const seen = new Map();
  for (const e of Object.values(store.state.prices.products)) {
    if (!seen.has(e.l1)) seen.set(e.l1, e.l1_label);
  }
  return [...seen].map(([l1, label]) => ({ l1, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
// distinct variant slugs under one L1 (null variants excluded), sorted by the
// label the dropdown will actually show - sorting the slugs would order the
// list by a string nobody sees
export function l2Options(l1) {
  const seen = new Set();
  for (const e of Object.values(store.state.prices.products)) {
    if (e.l1 === l1 && e.l2) seen.add(e.l2);
  }
  return [...seen].sort((a, b) =>
    titleCaseVariant(a).localeCompare(titleCaseVariant(b)));
}
// products under one L1 (and one variant, if given), sorted by label
export function l3Options(l1, l2) {
  const out = [];
  for (const [key, e] of Object.entries(store.state.prices.products)) {
    if (e.l1 !== l1) continue;
    if (l2 != null && e.l2 !== l2) continue;
    out.push({ key, label: e.label });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// the L1's one variant, when that variant IS the whole card - null if the card
// has several variants, none, or any product sitting outside a variant (then
// the card is genuinely wider than the variant and pooling them differs).
// The single predicate behind both narrowing and the Variant pill, so the pill
// can never claim a variant the chart is not actually filtered to.
export function soleVariant(l1) {
  const variants = l2Options(l1);
  if (variants.length !== 1) return null;
  const bare = Object.values(store.state.prices.products)
    .some((e) => e.l1 === l1 && !e.l2);
  return bare ? null : variants[0];
}

// drill a target down past any level that offers only one choice: picking an
// L1 with a single product lands straight on that product, so its Variant and
// Product pills show the forced value (coloured in) with no dropdown.
export function narrowPriceTarget(target) {
  if (!target || target.level === "l3") return target;
  const products = l3Options(target.l1, target.level === "l2" ? target.l2 : null);
  if (products.length === 1) return { level: "l3", key: products[0].key };
  if (target.level === "l1") {
    const only = soleVariant(target.l1);
    if (only) {
      return narrowPriceTarget({
        level: "l2", l1: target.l1, l1_label: target.l1_label, l2: only,
      });
    }
  }
  return target;
}

// the series array for whatever pricesUiState currently points at - the one
// place that knows how to turn {level, l1, l2, key} into actual points, so
// nothing else has to branch on level.
export function seriesForTarget(target) {
  if (!target) return [];
  if (target.level === "l3") {
    const entry = productEntry(target.key);
    return entry ? entry.series : [];
  }
  return pooledSeries(target.l1, target.level === "l2" ? target.l2 : null);
}

// everything the Trends card and the price sheet both need to display for
// the current target: the breadcrumb strings and the points. One place
// that knows how l3 (a single product) differs from a pooled l1/l2 view,
// so the two renderers can never disagree about it.
export function resolveTargetInfo(target) {
  if (!target) return null;
  const series = scopedPoints(target);
  if (target.level === "l3") {
    const entry = productEntry(target.key);
    if (!entry) return null;
    return { l1: entry.l1, l1_label: entry.l1_label, l2: entry.l2, label: entry.label, series };
  }
  return {
    l1: target.l1, l1_label: target.l1_label,
    l2: target.level === "l2" ? target.l2 : null,
    label: null, series,
  };
}

// one point per date across every store, its median - a single overall
// trend line, deliberately pooling stores rather than one line each (that
// finer view is what the Trends chart is for). Only for a trend statistic:
// bestPriceInPeriod does NOT go through this, because a median can hide the
// one genuinely cheap line among several bought the same day.
// One purchase row: everything bought of one product, at one store, on one
// day. Shared by the detail table and by the chart, so a dot can name exactly
// the rows it stands for.
export function purchaseKey(p) {
  return p.date + "|" + (p.prodKey || "") + "|" + p.store;
}

// Collapse a chart line to one point per day, averaging the prices. Two tins
// of the same thing in one trip are one price paid, not two readings, and
// drawing them as two dots stacked on one x put a vertical stripe in the line
// and made the polyline double back on itself.
// The mean, not dailyPoints' median: this is what a day cost, and a median
// silently discards half the receipt. `members` is kept so a tap can open the
// detail sheet on every row the dot stands for, and the dot carries the promo
// mark if any member was on offer - the same "at least one" rule the detail
// table's own averaged row uses, so the chart and the table never disagree.
export function dayAveraged(points) {
  const byDate = new Map();
  for (const p of points) {
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push(p);
  }
  return [...byDate.entries()]
    .map(([date, members]) => ({
      date,
      price: members.reduce((sum, m) => sum + m.price, 0) / members.length,
      promo: members.some((m) => m.promo),
      store: members[0].store,
      prodKey: members[0].prodKey,
      members,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function dailyPoints(series) {
  const byDate = new Map();
  series.forEach((p) => {
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push(p);
  });
  return [...byDate.entries()]
    .map(([date, pts]) => {
      const nonPromo = pts.filter((p) => !p.promo);
      const use = nonPromo.length ? nonPromo : pts;
      const sorted = use.map((p) => p.price).sort((a, b) => a - b);
      return { date, price: sorted[Math.floor(sorted.length / 2)], promo: pts.every((p) => p.promo) };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// "today" for the 6-month window: the most recent date this device has
// actually seen a price for. Live, not a constant - before the first sync
// there is no data at all, and a background sync can extend it later.
//
// Memoised on the identity of the products map, the same bounded-cache trick
// deburr uses and for the same reason: this is a full scan of every product's
// every point, and seriesInPeriod calls it on every window it cuts. So
// computeOpportunities, which cuts one window per product, was scanning the
// whole dataset once per product - 209 x 517 points on today's file, on every
// single render of the Prices tab, poll ticks included. The map is only ever
// replaced wholesale (load, syncPrices, the dev-file fallback), never mutated
// in place, so its identity is an exact cache key rather than a heuristic.
let priceTodayCache = { products: null, date: null };
function priceToday() {
  const products = store.state.prices.products;
  if (priceTodayCache.products === products) return priceTodayCache.date;
  let latest = null;
  for (const entry of Object.values(products)) {
    for (const p of entry.series) if (!latest || p.date > latest) latest = p.date;
  }
  priceTodayCache = { products, date: latest };
  return latest;
}

// pure UTC arithmetic throughout - mixing a local-time Date with the UTC
// conversion toISOString() does can shift the result by a day depending on
// the viewer's timezone and DST, which would move the "6 months" cutoff
// under Isa in Madrid without ever showing up while testing from UTC
function monthsBefore(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() - n);
  return dt.toISOString().slice(0, 10);
}

export function seriesInPeriod(series, period) {
  let cutFrom = null, cutTo = null;
  if (period === "6m") {
    const today = priceToday();
    if (!today) return series;
    cutFrom = monthsBefore(today, 6);
  } else if (/^\d{4}$/.test(period)) {
    cutFrom = `${period}-01-01`; cutTo = `${period}-12-31`;
  }
  return series.filter((p) => (!cutFrom || p.date >= cutFrom) && (!cutTo || p.date <= cutTo));
}

// v10 spec §1: rank what comes back down, not what only rises. Excludes any
// product that never dropped in the window, even if it moved a lot. Always
// product-level (unaffected by whatever the Trends chart's L1/L2 pooling is
// currently showing) - the spec validated this ranking at product
// granularity specifically, pooling was never re-examined for it.
export function computeOpportunities(period) {
  const out = [];
  for (const [key, entry] of Object.entries(store.state.prices.products)) {
    const pts = dailyPoints(seriesInPeriod(entry.series, period).filter((p) => !p.promo));
    if (pts.length < 2) continue;
    const prices = pts.map((p) => p.price);
    let hasDrop = false;
    for (let i = 1; i < prices.length; i++) if (prices[i] < prices[i - 1] * 0.97) hasDrop = true;
    if (!hasDrop) continue;
    const delta = (Math.max(...prices) - Math.min(...prices)) / Math.max(...prices);
    out.push({ key, label: entry.label, delta });
  }
  return out.sort((a, b) => b.delta - a.delta);
}

// v10 spec §6: a position hint, not a store recommendation - needs >=2
// observations at each of two stores and >=15% apart before it fires, so it
// never reacts to a single coincidental cheap trip. Takes a plain points
// array so it works the same for one product's own series or a pooled L1/L2
// array - the arithmetic does not care where the points came from.
export function computeBubble(series) {
  if (!series || !series.length) return null;
  const byStore = new Map();
  series.forEach((p) => {
    if (!byStore.has(p.store)) byStore.set(p.store, []);
    byStore.get(p.store).push(p.price);
  });
  const medians = [...byStore.entries()]
    .filter(([, prices]) => prices.length >= 2)
    .map(([store, prices]) => {
      const s = [...prices].sort((a, b) => a - b);
      return { store, median: s[Math.floor(s.length / 2)] };
    })
    .sort((a, b) => a.median - b.median);
  if (medians.length < 2) return null;
  const [cheapest, next] = medians;
  if (cheapest.median <= next.median * 0.85) return cheapest.store;
  return null;
}

// the lowest price paid in a period, and which store - promo included,
// since "best price" means the best you could actually have paid, unlike
// the Opportunities ranking which deliberately excludes promos (§4). Same
// plain-points-array shape as computeBubble, same reason.
export function bestPriceInPeriod(series, period) {
  const pts = seriesInPeriod(series, period);
  if (!pts.length) return null;
  const best = pts.reduce((a, b) => (b.price < a.price ? b : a));
  return { price: best.price, store: best.store };
}

// the two periods the chart offers, and the compact form used in
// "Best price · X" where it sits in a small metric card. Per-year periods were
// dropped in v10.7: with six months and all time the only choices,
// pricesUiState.period is always one of these two keys. Both labels are half a
// segmented control now, so they are trimmed to what a half can hold - the
// "Last" in "Last 6 months" was doing no work the row does not already say.
export const PERIODS = [["6m", "6 months"], ["all", "All time"]];
export const PERIOD_SHORT = { "6m": "6mo", all: "all time" };
// Group by, same shape. "Shops" and "Products" rather than "By supermarket"
// and "By product": two halves side by side already read as a choice between
// them, so the "By" was carrying the grammar of a dropdown it no longer is.
export const GROUPS = [["supermarket", "Shops"], ["product", "Products"]];

export const MAIN_LABELS = {
  meat: "Meat", fish: "Fish", rice: "Rice", pasta: "Pasta", soup: "Soup",
  sauce: "Sauce", other: "Other",
};

// 1..3 dots from the recipe category: quick plate -> slow simmer
export function effortFor(category) {
  const c = (category || "").toLowerCase();
  if (c.includes("rapide")) return 2;
  if (c.includes("mijoté")) return 3;
  if (c.includes("soupe") || c.includes("marinade")) return 2;
  return 1;
}

// "20min + 3h" from prep + cook; "" if neither
export function timesText(recipe) {
  return [recipe.prep, recipe.cook]
    .filter(Boolean)
    .map((t) => t.replace(/\s+/g, ""))
    .join(" + ");
}

export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export const ICON = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  sortUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 20V6M7 6l-4 4M7 6l4 4M13 8h8M13 13h5M13 18h2"/></svg>',
  sortDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v14M7 18l-4-4M7 18l4-4M13 8h2M13 13h5M13 18h8"/></svg>',
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M3 4h2l2.3 11.4a1 1 0 0 0 1 .8h8.5a1 1 0 0 0 1-.8L20.5 8H6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
};

// How long the round cart button stays coloured in with a tick after a tap.
export const CONFIRM_MS = 1500;

const CART_LABEL = "Add to the shopping list";
const CART_ADDED_LABEL = "Added to the shopping list";

// The one round cart button. Everywhere it appears - the end of the Trends
// Category row, the Ingredients header, and every ingredient row in shopping
// mode - it is built here, so the three cannot drift into three spellings of
// the same control.
//
// `label` names what this particular button adds. A screen reader reading
// eleven identical "Add to the shopping list" buttons down an ingredient list
// learns nothing from any of them, so each says the thing it would add. It is
// stashed on the element too: the confirm overwrites aria-label with "Added",
// and showCartReady has to be able to put the right one back.
export function cartButtonHtml({ id = "", cls = "", attrs = "", label = CART_LABEL, confirming = false }) {
  const l = escapeHtml(label);
  return `<button type="button" class="cart-btn${cls ? " " + cls : ""}${confirming ? " added" : ""}"` +
    `${id ? ` id="${id}"` : ""}${attrs ? " " + attrs : ""} data-label="${l}"` +
    ` aria-label="${confirming ? CART_ADDED_LABEL : l}">` +
    `${confirming ? ICON.check : ICON.cart}</button>`;
}

function showCartAdded(btn) {
  btn.classList.add("added");
  btn.innerHTML = ICON.check;
  btn.setAttribute("aria-label", CART_ADDED_LABEL);
}

export function showCartReady(btn) {
  btn.classList.remove("added");
  btn.innerHTML = ICON.cart;
  btn.setAttribute("aria-label", btn.dataset.label || CART_LABEL);
}

// The confirm the cart buttons share.
//
// A tap adds, and the button says so by colouring in and showing a tick. It is
// inert for that window: a second tap while the tick is up does nothing, so a
// double tap cannot quietly become two rows. Then it reverts to a cart, and a
// tap after that adds the thing AGAIN - deliberately. The list is a tally, not
// a set: two packs of mince is a real thing to want, and Clean up already
// groups duplicates by concept when they are ticked off shopping.
//
// This is the form for a button that survives its own tap - the ingredient
// rows, which nothing re-renders. The Trends one is replaced by the render its
// add triggers, so it keeps its deadline in a variable instead; see
// startPriceCartConfirm.
//
// The button can still be gone before the timer fires - the sheet closes, or
// the servings change and the rows are rebuilt - so the revert checks it is
// still in the document rather than writing into a detached node.
export function confirmAdd(btn) {
  showCartAdded(btn);
  setTimeout(() => { if (btn.isConnected) showCartReady(btn); }, CONFIRM_MS);
}

/* round a scaled quantity sensibly */
export function roundQty(n, isCount) {
  if (n == null) return n;
  if (isCount) return Math.max(1, Math.round(n));
  if (n >= 100) return Math.round(n);
  if (n >= 10) return Math.round(n * 10) / 10;
  return Math.round(n * 100) / 100;
}
