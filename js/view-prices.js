/* Ladle: the Insights tab, on Material 3.

   A feed of cards. The best deal right now is the hero, four more deals sit
   under it, and "See all worth watching" opens the full list in a sheet. Then
   the Trends card (filter chips, a chart with direct store labels, the Latest
   and Best price cards, a Purchase history button) and the receipt clean-up
   card (js/cleanup.js).

   Every price tap, here or on the List tab, goes to goToTrend(): it switches
   to this tab and points Trends at that product. Nothing here opens a price
   popup; the only sheets are the list of deals, the Category / Product
   pickers and the purchase history, which is a button of its own.

   The series maths is in prices-data.js and is not touched. */
"use strict";

import { kaveKey, showSnackbar } from "../m3/kave-m3.js";
import { renderCleanup } from "./cleanup.js";
import { CONFIRM_MS, GROUPS, PERIODS, PERIOD_SHORT, bestPriceInPeriod, computeBubble, computeOpportunities, dayAveraged, l1Options, l2Options, l3Options, narrowPriceTarget, productEntry, purchaseKey, resolveTargetInfo, seriesForTarget, seriesInPeriod, soleVariant, titleCaseVariant } from "./prices-data.js";
import { closeInsSheet, openInsSheet, openPriceDetail, refreshInsSheet } from "./sheet-price.js";
import { store } from "./store.js";
import { $, $$, deburr, escapeHtml, markJump } from "./util.js";

export let pricesUiState = {
  target: null,   // {level:"l3", key} | {level:"l1"|"l2", l1, l1_label, l2?} | null (nothing seen yet)
  period: "6m",   // "6m" | "all"
  groupBy: "supermarket",  // "supermarket" (one line per store) | "product" (one line per variant/product)
};

/* ---------- colours ---------- */

// The roster of shops that have a colour of their own. Which shop gets which
// hue is Isa's and does not move; the colours are the kit's --kave-data-<key>
// tokens, and any other shop is the neutral "other".
const STORE_KEYS = new Set(["keisy", "mercadona", "condis", "carrefour", "alcampo", "ametller"]);
export function storeKeyOf(name) {
  const k = deburr(name || "").split(/\s+/)[0];
  return STORE_KEYS.has(k) ? k : "other";
}
const storeStyle = (name) => kaveKey(storeKeyOf(name));

// Product lines (Group by = Products) have no colour of their own, so they
// take scheme roles and data hues in a fixed order, by the line's sorted
// position, stable across renders.
const LINE_TOKENS = [
  "--md-sys-color-primary", "--md-sys-color-tertiary", "--kave-data-culture", "--kave-data-life",
  "--kave-data-nights", "--kave-data-outdoors", "--kave-data-food", "--md-sys-color-secondary",
];

// A chart is drawn as SVG attributes, and one data colour (--kave-data-other)
// is itself a var(): so every colour is read off the document at draw time with
// getComputedStyle, which hands back the resolved value for the seed and the
// light or dark scheme in force right now. It is read again whenever either
// changes (watchColours below), never cached across a paint.
function colourReader() {
  const cs = getComputedStyle(document.documentElement);
  const memo = new Map();
  return (name) => {
    if (!memo.has(name)) memo.set(name, cs.getPropertyValue(name).trim() || "currentColor");
    return memo.get(name);
  };
}

/* ---------- state helpers ---------- */

// The Trends cart button's confirm. The button is rebuilt by the render its
// own add triggers, so the deadline lives here and the render draws the button
// from it; a timer swaps the icon back once.
let priceCartUntil = 0;
let priceCartTimer = null;

function startPriceCartConfirm() {
  priceCartUntil = Date.now() + CONFIRM_MS;
  clearTimeout(priceCartTimer);
  priceCartTimer = setTimeout(() => {
    priceCartUntil = 0;
    // revert the button itself rather than re-render the chart to swap an icon
    const el = $("#priceCart");
    if (el) {
      el.querySelector(".m3-icon").textContent = "add_shopping_cart";
      el.setAttribute("aria-label", el.dataset.label || "Add to the shopping list");
    }
  }, CONFIRM_MS);
}

function endPriceCartConfirm() {
  clearTimeout(priceCartTimer);
  priceCartUntil = 0;
}

// The Trends default, and what Reset goes back to: olive oil. If the data has
// no olive oil card, the top Worth-watching mover, else the deepest history.
function oliveTarget() {
  const hit = l1Options().find((o) => /oliv/.test(deburr(o.l1)) || /oliv/.test(deburr(o.label)));
  return hit ? { level: "l1", l1: hit.l1, l1_label: hit.label } : null;
}
function defaultPriceTarget() {
  const olive = oliveTarget();
  if (olive && seriesForTarget(olive).length) return olive;
  const top = computeOpportunities("6m")[0];
  if (top) return { level: "l3", key: top.key };
  const entries = Object.entries(store.state.prices.products);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1].series.length - a[1].series.length);
  return { level: "l3", key: entries[0][0] };
}

// which period a newly selected target should open on. 6 months by default,
// but: a bubble is a claim ("Carrefour is cheaper") backed by specific
// observations, and if those sit outside 6 months the chart would show the
// bubble's colour on the list row with no way to check it; and a window that
// cannot draw a line (fewer than two points) is worth leaving for one that
// shows more. Either way the evidence is in "all time", so open there instead.
// Only ever consulted when the target changes.
function defaultPeriodFor(series) {
  const bubbleStore = computeBubble(series);
  const in6m = seriesInPeriod(series, "6m");
  if (bubbleStore && !in6m.some((p) => p.store === bubbleStore)) return "all";
  if (in6m.length < 2 && series.length > in6m.length) return "all";
  return "6m";
}

// the one entry point every selection goes through
function selectPriceTarget(target, opts = {}) {
  if (!target) return false;
  target = narrowPriceTarget(target);
  const series = seriesForTarget(target);
  if (!series.length) return false;
  pricesUiState.target = target;
  endPriceCartConfirm(); // the tick belonged to the old target, not this one
  pricesUiState.period = defaultPeriodFor(series);
  renderTrends();
  if (opts.scroll) {
    const card = $("#trendsCard");
    if (card) {
      markJump(1200);
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.focus({ preventScroll: true });
    }
  }
  return true;
}

/* Every price tap lands here: a deal card, the hero, a row of the Worth
   watching list, the price icon on a List row. `what` is a product key, or a
   target object when the caller only knows a card or a variant (the List
   resolves a typed name to one). Switches to Insights, points Trends at it
   (its category chip and its product chip follow) and scrolls Trends in. */
export function goToTrend(what) {
  const target = typeof what === "string" ? { level: "l3", key: what } : what;
  if (!target) return;
  const narrowed = narrowPriceTarget(target);
  if (!seriesForTarget(narrowed).length) return;   // a stale key: stay where we are
  store.setView("prices");
  selectPriceTarget(narrowed, { scroll: true });
}

// Reset: olive oil, 6 months, one line per shop
export function resetTrends() {
  pricesUiState.groupBy = "supermarket";
  const t = defaultPriceTarget();
  if (!(t && selectPriceTarget(t))) {
    pricesUiState.target = null;
    pricesUiState.period = "6m";
    renderTrends();
  }
}

// picks. Picking a card, variant or product resets what sits below it;
// choosing "All variants" / "All products" pools one level up.
function pickPriceL1(l1, label) { selectPriceTarget({ level: "l1", l1, l1_label: label }); }
function pickPriceL2(l1, label, l2) { selectPriceTarget({ level: "l2", l1, l1_label: label, l2 }); }
function pickPriceL3(key) { selectPriceTarget({ level: "l3", key }); }
function clearPriceL2(info) { selectPriceTarget({ level: "l1", l1: info.l1, l1_label: info.l1_label }); }

/* ---------- dates ---------- */

const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtFullDate(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `${Number(d)} ${MONTHS_ABBR[Number(m) - 1]} ${y}`;
}
function fmtMonthYear(ms) {
  const dt = new Date(ms);
  return `${MONTHS_ABBR[dt.getUTCMonth()]} ${String(dt.getUTCFullYear()).slice(2)}`;
}

/* ---------- deals: the hero, four cards, the full list ---------- */

const dropText = (pct) => `-${pct}%`;

// Everything a deal shows, from the product's own six-month series: where the
// lowest price was paid, how far under the six-month high that is (the figure
// Worth watching is ranked by), and the shape of the six months.
function dealOf(opp) {
  const entry = productEntry(opp.key);
  if (!entry) return null;
  const best = bestPriceInPeriod(entry.series, "6m");
  if (!best) return null;
  const spark = dayAveraged(seriesInPeriod(entry.series, "6m")).map((p) => p.price);
  return {
    key: opp.key, label: opp.label, price: best.price, store: best.store,
    pct: Math.round(opp.delta * 100), spark,
  };
}

function sparkSvg(values, colour) {
  const w = 72, h = 28;
  const lo = Math.min(...values), hi = Math.max(...values), r = hi - lo || 1;
  const pts = values.map((v, i) =>
    `${((i * (w - 4)) / Math.max(1, values.length - 1) + 2).toFixed(1)},${(h - 3 - ((v - lo) * (h - 6)) / r).toFixed(1)}`).join(" ");
  return `<svg class="ins-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
    `<polyline points="${pts}" fill="none" stroke="${colour}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function renderOpportunities() {
  const read = colourReader();
  const deals = computeOpportunities("6m").map(dealOf).filter(Boolean);
  const hero = $("#dealHero"), grid = $("#dealGrid"), head = $("#dealHead");
  const empty = $("#dealEmpty"), more = $("#oppToggle");
  if (!deals.length) {
    hero.hidden = true; grid.hidden = true; head.hidden = true; more.hidden = true;
    empty.hidden = false;
    refreshInsSheet();
    return;
  }
  empty.hidden = true; hero.hidden = false; grid.hidden = false; head.hidden = false; more.hidden = false;

  const top = deals[0];
  hero.innerHTML =
    `<div class="ins-hero__kicker"><span class="m3-icon m3-icon--fill" aria-hidden="true">local_offer</span>` +
    `<span class="m3-title-s">Best deal right now</span></div>` +
    `<h2 class="m3-headline-m ins-hero__title">${escapeHtml(top.label)}</h2>` +
    `<p class="m3-body-m ins-hero__text">€${top.price.toFixed(2)}/kg at ${escapeHtml(top.store)}, ` +
    `${top.pct}% under its six-month high.</p>` +
    `<div class="m3-row ins-hero__acts">` +
    `<button type="button" class="m3-btn ins-hero__add" data-act="add"${store.readOnly() ? " disabled" : ""}>` +
    `<span class="m3-icon" aria-hidden="true">add_shopping_cart</span>Add to list</button>` +
    `<button type="button" class="m3-btn m3-btn--text ins-hero__more" data-act="trend">See the trend</button></div>`;
  $("[data-act=add]", hero).addEventListener("click", () => {
    const it = store.addItem({ name: top.label, qty: null, unit: null, note: null, source: `deal:${top.key}` });
    if (!it) return;
    showSnackbar($("#snackHost"), {
      text: `Added ${top.label} to the list`, action: "Undo", onAction: () => store.deleteItem(it.id),
    });
  });
  $("[data-act=trend]", hero).addEventListener("click", () => goToTrend(top.key));

  grid.innerHTML = deals.slice(1, 5).map((d) =>
    `<button type="button" class="m3-card ins-card ins-deal" data-key="${escapeHtml(d.key)}" ` +
    `aria-label="${escapeHtml(`${d.label}, €${d.price.toFixed(2)} per kilo at ${d.store}, ${d.pct}% down. Show its trend`)}">` +
    `<span class="m3-row ins-deal__top" style="${storeStyle(d.store)}"><span class="m3-dot"></span>` +
    `<span class="m3-label-m m3-variant ins-deal__store">${escapeHtml(d.store)}</span>` +
    `<span class="m3-spacer"></span><span class="m3-tag">${dropText(d.pct)}</span></span>` +
    `<span class="m3-title-s ins-deal__name">${escapeHtml(d.label)}</span>` +
    `<span class="ins-deal__foot"><span class="m3-headline-s m3-num">€${d.price.toFixed(2)}` +
    `<span class="m3-body-s m3-variant">/kg</span></span>` +
    sparkSvg(d.spark, read(`--kave-data-${storeKeyOf(d.store)}`)) + `</span></button>`).join("");
  $$(".ins-deal", grid).forEach((b) => b.addEventListener("click", () => goToTrend(b.dataset.key)));
  refreshInsSheet();
}

// "See all worth watching": every deal, one line each, a tap goes to its trend
export function openWorthWatching() {
  openInsSheet({ title: "Worth watching", tall: true, render: renderOppSheet });
}
function renderOppSheet(body) {
  const deals = computeOpportunities("6m").map(dealOf).filter(Boolean);
  if (!deals.length) {
    body.innerHTML = `<p class="m3-body-m m3-variant">Nothing worth watching yet.</p>`;
    return;
  }
  body.innerHTML =
    `<p class="m3-body-m m3-variant">The lowest price paid in the last six months, per product. Tap one to see its trend.</p>` +
    `<div class="m3-grouped">${deals.map((d) =>
      `<button type="button" class="m3-list-item ins-opp" data-key="${escapeHtml(d.key)}" style="${storeStyle(d.store)}">` +
      `<span class="m3-list-item__lead ins-lead"><span class="m3-icon" aria-hidden="true">trending_down</span></span>` +
      `<span class="m3-list-item__text m3-list-item__text--wrap"><span class="m3-body-l">${escapeHtml(d.label)}</span>` +
      `<span class="m3-body-m m3-variant">Lowest at ${escapeHtml(d.store)} · ${dropText(d.pct)}</span></span>` +
      `<span class="m3-title-m m3-num">€${d.price.toFixed(2)}</span></button>`).join("")}</div>`;
  $$(".ins-opp", body).forEach((b) => b.addEventListener("click", () => {
    closeInsSheet().then(() => goToTrend(b.dataset.key));
  }));
}

/* ---------- Trends: the chart ---------- */

// what each line on the chart is: a supermarket (Group by = Shops), or a
// variant / product (Group by = Products). "variant" granularity gives a
// null-variant product its own line labelled by product, so they don't all
// collapse into one nameless line.
function lineGranularity(target) {
  if (pricesUiState.groupBy === "supermarket") return "store";
  return target.level === "l1" ? "variant" : "product";
}
function chartLines(points, granularity) {
  const groups = new Map();
  for (const p of points) {
    let id, label;
    if (granularity === "store") { id = p.store; label = p.store; }
    else if (granularity === "variant" && p.variant) { id = "v:" + p.variant; label = titleCaseVariant(p.variant); }
    else { id = "p:" + p.prodKey; label = p.prodLabel; }
    if (!groups.has(id)) groups.set(id, { id, label, points: [] });
    groups.get(id).points.push(p);
  }
  const lines = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  lines.forEach((ln, i) => {
    ln.token = granularity === "store"
      ? `--kave-data-${storeKeyOf(ln.id)}` : LINE_TOKENS[i % LINE_TOKENS.length];
    ln.points = dayAveraged(ln.points);
  });
  return lines;
}

// what the chart is currently showing, kept so a resize or a change of colour
// scheme can redraw it without rebuilding the whole tab
let chartLinesShown = null;
function paintChart() {
  const wrap = $("#priceChartWrap");
  if (!wrap || wrap.hidden || !chartLinesShown) return;
  wrap.innerHTML = buildPriceChartSvg(chartLinesShown, wrap.clientWidth);
  $$(".price-pt", wrap).forEach((el) => {
    const open = () => openPriceDetail({ keys: (el.dataset.keys || "").split("~").filter(Boolean) });
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });
}
export function resizePriceChart() {
  const wrap = $("#priceChartWrap");
  const svg = wrap && wrap.firstElementChild;
  // only when the width actually changed: a redraw drops any focus on a dot
  if (svg && wrap.clientWidth && Math.round(wrap.clientWidth) !== Number(svg.getAttribute("width"))) paintChart();
}

// The chart is drawn at the width it is shown at, not drawn small and scaled,
// so axis numbers and strokes keep their size on a wide window. Height is a
// proportion of the width held between the phone's and twice it.
// Each line is named at its right-hand end, in the line's own colour: there is
// no legend box.
const CHART_H_MIN = 148, CHART_H_MAX = 296, CHART_ASPECT = 0.45;
const CHART_MIN_W = 260;
const LABEL_GAP = 14, LABEL_W = 92;
function buildPriceChartSvg(lines, width) {
  const read = colourReader();
  const W = Math.max(CHART_MIN_W, Math.round(width || 320));
  const H = Math.min(CHART_H_MAX, Math.max(CHART_H_MIN, Math.round(W * CHART_ASPECT)));
  const points = lines.flatMap((l) => l.points);
  const dates = [...points.map((p) => p.date)].sort();
  const t0 = new Date(dates[0]).getTime();
  const t1 = new Date(dates[dates.length - 1]).getTime();
  const prices = points.map((p) => p.price);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const pad = Math.max((hi - lo) * 0.15, hi * 0.05, 0.1);
  const yLo = Math.max(0, lo - pad), yHi = hi + pad;
  const X0 = 38, X1 = W - LABEL_W, Y0 = 10, Y1 = H - 24;
  const xOf = (d) => (t1 === t0 ? (X0 + X1) / 2 : X0 + (X1 - X0) * ((new Date(d).getTime() - t0) / (t1 - t0)));
  const yOf = (p) => Y1 - (Y1 - Y0) * ((p - yLo) / ((yHi - yLo) || 1));

  const summary = lines.map((ln) => {
    const last = [...ln.points].sort((a, b) => a.date.localeCompare(b.date)).pop();
    return `${ln.label} €${last.price.toFixed(2)}`;
  }).join(", ");
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="price-svg" role="group" ` +
    `aria-label="${escapeHtml(`Price per kilo over time. Latest: ${summary}`)}">`;

  [yHi, (yHi + yLo) / 2, yLo].forEach((v) => {
    const y = yOf(v);
    svg += `<line x1="${X0 - 4}" y1="${y.toFixed(1)}" x2="${X1}" y2="${y.toFixed(1)}" class="chart-grid"/>`;
    svg += `<text x="${X0 - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="chart-axis">${v.toFixed(v < 10 ? 2 : 1)}</text>`;
  });
  // the time axis: first day, middle, last day
  const xTicks = t1 === t0 ? [[(X0 + X1) / 2, t0, "middle"]]
    : [[X0, t0, "start"], [(X0 + X1) / 2, (t0 + t1) / 2, "middle"], [X1, t1, "end"]];
  xTicks.forEach(([x, t, anchor]) => {
    svg += `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="${anchor}" class="chart-axis">${fmtMonthYear(t)}</text>`;
  });

  const ends = [];
  lines.forEach((ln) => {
    const pts = [...ln.points].sort((a, b) => a.date.localeCompare(b.date));
    const colour = read(ln.token);
    if (pts.length > 1) {
      const poly = pts.map((p) => `${xOf(p.date).toFixed(1)},${yOf(p.price).toFixed(1)}`).join(" ");
      svg += `<polyline points="${poly}" fill="none" stroke="${colour}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    pts.forEach((p) => {
      const cx = xOf(p.date).toFixed(1), cy = yOf(p.price).toFixed(1);
      // an averaged dot can stand for several purchase rows, so it carries all
      // their keys; a tap opens the purchase history on those rows
      const keys = [...new Set(p.members.map(purchaseKey))].join("~");
      const name = `€${p.price.toFixed(2)} at ${p.store}, ${fmtFullDate(p.date)}${p.promo ? ", on offer" : ""}. Open the purchase history`;
      svg += `<g class="price-pt" data-keys="${escapeHtml(keys)}" tabindex="0" role="button" aria-label="${escapeHtml(name)}">` +
        `<circle class="price-hit" cx="${cx}" cy="${cy}" r="14"/>` +
        (p.promo
          ? `<circle cx="${cx}" cy="${cy}" r="8" fill="${colour}"/><text x="${cx}" y="${(+cy + 3.5).toFixed(1)}" text-anchor="middle" class="promo-mark">€</text>`
          : `<circle cx="${cx}" cy="${cy}" r="4" fill="${colour}"/>`) + `</g>`;
    });
    ends.push({ ln, colour, y: yOf(pts[pts.length - 1].price) });
  });

  // direct labels at the right end, pushed apart so none sits on another
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + LABEL_GAP);
  const floor = Y1 + 4;
  if (ends.length && ends[ends.length - 1].y > floor) {
    ends[ends.length - 1].y = floor;
    for (let i = ends.length - 2; i >= 0; i--) ends[i].y = Math.min(ends[i].y, ends[i + 1].y - LABEL_GAP);
  }
  ends.forEach(({ ln, colour, y }) => {
    const text = ln.label.length > 11 ? ln.label.slice(0, 10) + "…" : ln.label;
    svg += `<g class="chart-end"><rect x="${X1 + 10}" y="${(y - 4).toFixed(1)}" width="8" height="8" rx="2" fill="${colour}"/>` +
      `<text x="${X1 + 22}" y="${(y + 4).toFixed(1)}" class="chart-lbl"><title>${escapeHtml(ln.label)}</title>${escapeHtml(text)}</text></g>`;
  });
  return svg + `</svg>`;
}

// the chart and the deal sparklines read their colours at draw time, so a new
// seed or a switch between light and dark has to draw them again
let coloursWatched = false;
function watchColours() {
  if (coloursWatched) return;
  coloursWatched = true;
  let queued = false;
  const redraw = () => {
    if (queued) return;
    queued = true;
    // a timer, not a frame: a hidden pane runs no animation frames
    setTimeout(() => {
      queued = false;
      if (store.state.view !== "prices") return;
      renderOpportunities();
      paintChart();
    }, 30);
  };
  new MutationObserver(redraw).observe(document.documentElement,
    { attributes: true, attributeFilter: ["data-seed", "data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
}

/* ---------- Trends: Latest and Best price ---------- */

// "Latest price" is always the most recent purchase, whatever the period chip
// says: it answers "what did I pay", not "what did the chart just draw". Under
// Group by = Products several products can share that date, and then there is
// no single latest price, so it shows a dash. "Best price" follows the period
// and is the single cheapest point in it + where it was bought.
export function metricsHtml(info) {
  const target = pricesUiState.target;
  if (!target) return "";
  const granularity = lineGranularity(target);
  const maxDate = info.series.reduce((m, p) => (p.date > m ? p.date : m), "");
  const onLatest = info.series.filter((p) => p.date === maxDate);
  const card = (label, price, storeName) =>
    `<div class="m3-card m3-card--filled ins-metric">` +
    `<span class="m3-label-m m3-variant">${escapeHtml(label)}</span>` +
    `<span class="m3-headline-s m3-num">${price == null ? "-" : `€${price.toFixed(2)}<span class="m3-body-s m3-variant">/kg</span>`}</span>` +
    (storeName ? `<span class="m3-body-s m3-variant ins-store" style="${storeStyle(storeName)}"><span class="m3-dot"></span>${escapeHtml(storeName)}</span>` : "") +
    `</div>`;

  let latest;
  if (!onLatest.length || (granularity !== "store" && onLatest.length > 1)) latest = card("Latest price", null, null);
  else {
    const last = onLatest.reduce((a, b) => (b.price < a.price ? b : a));
    latest = card("Latest price", last.price, last.store);
  }
  const best = bestPriceInPeriod(info.series, pricesUiState.period);
  if (!best) return "";
  return latest + card(`Best price · ${PERIOD_SHORT[pricesUiState.period]}`, best.price, best.store);
}

/* ---------- Trends: filter chips and their pickers ---------- */

const NA_VARIANT = "N/A";
const ALL_VARIANTS = "All variants";
const ALL_PRODUCTS = "All products";

// The levels of the product filter. Each is a dropdown filter chip that opens a
// radio sheet; one that has no choice to make is shown as a plain selected chip.
function filterLevels(target, info) {
  const l1s = l1Options();
  const variants = l2Options(info.l1);
  const l3scope = l3Options(info.l1, info.l2 || null);
  const forcedVariant = soleVariant(info.l1);
  const levels = [{ which: "l1", title: "Category", text: info.l1_label, filled: true, opens: l1s.length > 1 }];
  // a variant only gets a chip when there is a variant to choose between
  if (!forcedVariant && variants.length && !(target.level === "l3" && !info.l2)) {
    levels.push({
      which: "l2", title: "Variant", filled: !!info.l2, opens: true,
      text: info.l2 ? titleCaseVariant(info.l2) : ALL_VARIANTS,
    });
  }
  if (l3scope.length === 1) levels.push({ which: "l3", title: "Product", text: l3scope[0].label, filled: true, opens: false });
  else if (l3scope.length) {
    levels.push({
      which: "l3", title: "Product", opens: true, filled: target.level === "l3",
      text: target.level === "l3" ? info.label : ALL_PRODUCTS,
    });
  }
  return { levels, l1s, variants, l3scope };
}

function chipHtml(lv) {
  const text = escapeHtml(lv.text);
  if (!lv.opens) {
    return `<span class="m3-chip m3-chip--leading is-selected ins-chip"><span class="m3-icon" aria-hidden="true">check</span>` +
      `<span class="ins-chip__text">${text}</span></span>`;
  }
  return `<button type="button" class="m3-chip m3-chip--dropdown${lv.filled ? " is-selected" : ""} ins-chip" data-pick="${lv.which}" ` +
    `aria-haspopup="dialog" aria-label="${escapeHtml(`${lv.title}: ${lv.text}. Change`)}">` +
    (lv.filled ? `<span class="m3-icon" aria-hidden="true">check</span>` : "") +
    `<span class="ins-chip__text">${text}</span><span class="m3-icon" aria-hidden="true">arrow_drop_down</span></button>`;
}

// the radio list a dropdown chip opens
function pickerModel(which) {
  const target = pricesUiState.target;
  const info = target && resolveTargetInfo(target);
  if (!info) return null;
  const { l1s, variants, l3scope } = filterLevels(target, info);
  if (which === "l1") {
    return {
      title: "Category", search: true, current: info.l1,
      rows: l1s.map((o) => ({ id: o.l1, label: o.label })),
      apply: (id) => { if (id !== info.l1) pickPriceL1(id, l1s.find((x) => x.l1 === id).label); },
    };
  }
  if (which === "l2") {
    return {
      title: "Variant", current: info.l2 || "",
      rows: [{ id: "", label: ALL_VARIANTS }].concat(variants.map((v) => ({ id: v, label: titleCaseVariant(v) }))),
      apply: (id) => { if (id) pickPriceL2(info.l1, info.l1_label, id); else clearPriceL2(info); },
    };
  }
  return {
    title: "Product", search: true, current: target.level === "l3" ? target.key : "",
    rows: [{ id: "", label: ALL_PRODUCTS }].concat(l3scope.map((p) => ({ id: p.key, label: p.label }))),
    apply: (id) => {
      if (id) pickPriceL3(id);
      else if (info.l2) pickPriceL2(info.l1, info.l1_label, info.l2);
      else clearPriceL2(info);
    },
  };
}

function openPicker(which) {
  const m0 = pickerModel(which);
  if (!m0) return;
  openInsSheet({ title: m0.title, tall: !!m0.search, render: (body) => renderPicker(body, which) });
}
function renderPicker(body, which) {
  const m = pickerModel(which);
  if (!m) { body.textContent = ""; return; }
  const search = m.search && m.rows.length > 8
    ? `<div class="m3-field"><span class="m3-field__label">Search</span>` +
      `<input class="m3-field__input" type="search" autocomplete="off" aria-label="Search ${escapeHtml(m.title.toLowerCase())}"></div>`
    : "";
  body.innerHTML = search +
    `<div class="m3-grouped" role="radiogroup" aria-label="${escapeHtml(m.title)}">${m.rows.map((r) =>
      `<label class="m3-list-item ins-pick"><input type="radio" class="m3-radio" name="insPick" value="${escapeHtml(r.id)}"` +
      `${r.id === m.current ? " checked" : ""}><span class="m3-list-item__text m3-list-item__text--wrap">` +
      `<span class="m3-body-l">${escapeHtml(r.label)}</span></span></label>`).join("")}</div>`;
  $$("input[name=insPick]", body).forEach((inp) => inp.addEventListener("change", () => {
    m.apply(inp.value);
    closeInsSheet();
  }));
  const q = $(".m3-field__input", body);
  if (q) {
    q.addEventListener("input", () => {
      const needle = deburr(q.value).trim();
      $$(".ins-pick", body).forEach((row) => {
        row.hidden = !!needle && !deburr(row.textContent).includes(needle);
      });
    });
  }
  const on = $("input:checked", body);
  if (on) on.scrollIntoView({ block: "center" });
}

// a chip row for Period and Group by: filter chips, one selected. `liveIndex`
// pins the choice when only one of them would draw anything different.
function renderChoiceChips(hostId, rows, currentId, onPick, liveIndex) {
  const host = $(hostId);
  host.innerHTML = rows.map(([id, label], i) => {
    const on = id === currentId;
    const dead = liveIndex != null && i !== liveIndex;
    return `<button type="button" class="m3-chip m3-chip--leading${on ? " is-selected" : ""}" data-opt="${escapeHtml(id)}"` +
      `${dead ? ` aria-disabled="true"` : ""} aria-pressed="${on}">` +
      `${on ? `<span class="m3-icon" aria-hidden="true">check</span>` : ""}${escapeHtml(label)}</button>`;
  }).join("");
  $$("button", host).forEach((b) => {
    if (b.getAttribute("aria-disabled") === "true") return;
    b.addEventListener("click", () => { if (b.dataset.opt !== currentId) onPick(b.dataset.opt); });
  });
}

function renderFilters(target, info) {
  const { levels } = filterLevels(target, info);
  // The cart adds what the chips say: the card, plus the variant when one is
  // actually named. A product is narrower than anything you would write on a
  // shopping list, so a product target adds the card and variant it sits under.
  // Read-only greys it out rather than removing it, so the chips either side do
  // not reflow when a token arrives.
  const forcedVariant = soleVariant(info.l1);
  const listedVariant = info.l2 || forcedVariant || null;
  const listedName = listedVariant ? `${info.l1_label} ${titleCaseVariant(listedVariant)}` : info.l1_label;
  const confirming = Date.now() < priceCartUntil;
  const host = $("#priceFilters");
  host.innerHTML = levels.map(chipHtml).join("") +
    `<button type="button" id="priceCart" class="m3-icon-btn m3-icon-btn--tonal ins-cart" data-label="${escapeHtml(`Add ${listedName} to the shopping list`)}" ` +
    `aria-label="${confirming ? "Added to the shopping list" : escapeHtml(`Add ${listedName} to the shopping list`)}"` +
    `${store.readOnly() ? " disabled" : ""}><span class="m3-icon" aria-hidden="true">${confirming ? "check" : "add_shopping_cart"}</span></button>`;
  $$("[data-pick]", host).forEach((b) => b.addEventListener("click", () => openPicker(b.dataset.pick)));
  $("#priceCart", host).addEventListener("click", () => {
    if (Date.now() < priceCartUntil) return; // inert while the tick is up
    // before the add, not after: addItem re-renders this tab, and that render
    // has to already know the button is confirming
    startPriceCartConfirm();
    const created = store.addItem({
      name: info.l1_label, qty: null, unit: null,
      // the variant goes in the note, exactly where a recipe add puts it
      note: listedVariant ? titleCaseVariant(listedVariant) : null,
      source: `trend:${info.l1}${listedVariant ? "#" + listedVariant : ""}`,
      slug: info.l1,
      variant: listedVariant,
    });
    // nothing landed (a list gone read-only between render and tap): take the
    // tick back rather than claim an add that did not happen
    if (!created) { endPriceCartConfirm(); renderTrends(); }
  });
}

export function renderTrends() {
  // first paint after data arrives: nothing has been tapped, so pick both the
  // target and its period the same way a tap would
  if (!pricesUiState.target) {
    const first = narrowPriceTarget(defaultPriceTarget());
    if (first) {
      pricesUiState.target = first;
      pricesUiState.period = defaultPeriodFor(seriesForTarget(first));
    }
  }
  const target = pricesUiState.target;
  const info = target && resolveTargetInfo(target);
  if (!info) {
    $("#priceNoData").hidden = false;
    $("#priceTrendsBody").hidden = true;
    $("#priceReset").hidden = true;
    return;
  }
  $("#priceNoData").hidden = true;
  $("#priceTrendsBody").hidden = false;
  $("#priceReset").hidden = false;

  // "Products" is only a real choice when it would draw more than one line -
  // judged on what the chosen period actually shows. Otherwise it stays
  // Shops and the Products chip is plainly not choosable.
  const filtered = seriesInPeriod(info.series, pricesUiState.period);
  const productGranularity = target.level === "l1" ? "variant" : "product";
  const canGroupByProduct = chartLines(filtered, productGranularity).length >= 2;
  if (!canGroupByProduct) pricesUiState.groupBy = "supermarket";

  renderFilters(target, info);
  renderChoiceChips("#pricePeriod", PERIODS, pricesUiState.period, (id) => {
    pricesUiState.period = id;
    renderTrends();
  });
  renderChoiceChips("#priceGroupBy", GROUPS, pricesUiState.groupBy, (id) => {
    pricesUiState.groupBy = id;
    renderTrends();
  }, canGroupByProduct ? null : 0);

  const lines = chartLines(filtered, lineGranularity(target));
  const wrap = $("#priceChartWrap");
  if (!filtered.length) {
    wrap.hidden = true;
    wrap.innerHTML = "";
    chartLinesShown = null;
    // a hand-picked period is allowed to draw nothing - say so rather than let
    // an empty chart contradict the cards below
    $("#priceEmpty").textContent = "Nothing bought in this period.";
    $("#priceEmpty").hidden = false;
  } else {
    wrap.hidden = false;
    $("#priceEmpty").hidden = true;
    chartLinesShown = lines;
    paintChart();
  }

  const metrics = metricsHtml(info);
  $("#priceMetrics").innerHTML = metrics;
  $("#priceMetrics").hidden = !metrics;
}

export function renderPrices(state) {
  watchColours();
  renderOpportunities();
  renderTrends();
  renderCleanup(true);
}

/* ---------- purchase rows (the history sheet's lines) ---------- */

// one row per (date, product, store), so buying two of the same thing at the
// same shop on one trip is a single line with a count, not two identical rows.
// Newest first, then by product name, then store.
export function purchaseRows(series) {
  const groups = new Map();
  for (const p of series) {
    const k = purchaseKey(p);
    if (!groups.has(k)) {
      groups.set(k, {
        key: k, date: p.date, prodKey: p.prodKey, prodLabel: p.prodLabel,
        variant: p.variant, store: p.store, pts: [],
      });
    }
    groups.get(k).pts.push(p);
  }
  return [...groups.values()].sort((a, b) =>
    b.date.localeCompare(a.date) ||
    (a.prodLabel || "").localeCompare(b.prodLabel || "") ||
    a.store.localeCompare(b.store));
}
