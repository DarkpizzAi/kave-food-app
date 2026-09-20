/* Spoon: the Price tracking tab.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { CONFIRM_MS, GROUPS, PERIODS, PERIOD_SHORT, bestPriceInPeriod, cartButtonHtml, computeBubble, computeOpportunities, dayAveraged, l1Options, l2Options, l3Options, lineColor, narrowPriceTarget, productEntry, purchaseKey, resolveTargetInfo, seriesForTarget, seriesInPeriod, showCartReady, soleVariant, storeColor, storeOnColor, titleCaseVariant } from "./prices-data.js";
import { openPriceDetail, priceDetailState } from "./sheet-price.js";
import { store } from "./store.js";
import { $, $$, deburr, escapeHtml } from "./util.js";
import { PRICE_ICON_DOWN_PATH } from "./view-list.js";

export let pricesUiState = {
  target: null,   // {level:"l3", key} | {level:"l1"|"l2", l1, l1_label, l2?} | null (nothing seen yet)
  period: "6m",   // "6m" | "all" | a "YYYY" year
  groupBy: "supermarket",  // "supermarket" (one line per store) | "product" (one line per variant/product)
  openPill: null,  // "l1" | "l2" | "l3" | null - which pill's dropdown is open
  oppOpen: false,
};

// The Trends cart button's confirm. It cannot live on the button itself the
// way the recipe rows' does: adding an item re-renders the whole Prices view,
// which rebuilds that button. So the deadline lives here, renderPricePills
// draws the button from it, and a timer re-renders once to clear it.
let priceCartUntil = 0;
let priceCartTimer = null;

function startPriceCartConfirm() {
  priceCartUntil = Date.now() + CONFIRM_MS;
  clearTimeout(priceCartTimer);
  priceCartTimer = setTimeout(() => {
    priceCartUntil = 0;
    // revert the button itself rather than re-render the tab. The add replaced
    // it once and nothing has re-rendered since, so it is normally still
    // there; and when it is not - another target picked, another tab - the
    // deadline above is already clear and whatever draws it next draws a cart.
    // Re-rendering Prices here would repaint the whole chart to swap a 17px
    // icon. It is looked up rather than captured because the element that
    // wears the tick is not the one that was tapped.
    const el = $("#priceCart");
    if (el) showCartReady(el);
  }, CONFIRM_MS);
}

function endPriceCartConfirm() {
  clearTimeout(priceCartTimer);
  priceCartUntil = 0;
}

// picks a sensible first thing to show the moment real data exists and
// nothing has been tapped yet: the top Worth-watching mover if there is
// one, else whichever product has the deepest history. Never runs again
// once something has actually been selected.
function defaultPriceTarget() {
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
//
// The second test compares against the window rather than a fixed count, so a
// card whose only purchase predates the window - Bouillon, bought once in
// February 2025 - opens on all time and shows it, instead of reporting
// "nothing bought in this period" about a product that was in fact bought.
//
// Only ever consulted when the target changes. A period the user picked by
// hand is left exactly as picked, even when it draws an empty chart - the
// dropdown offers no year the target has no data in, so an empty year chart
// is a true answer ("one purchase, no trend"), not a dead end.
function defaultPeriodFor(series) {
  const bubbleStore = computeBubble(series);
  const in6m = seriesInPeriod(series, "6m");
  if (bubbleStore && !in6m.some((p) => p.store === bubbleStore)) return "all";
  if (in6m.length < 2 && series.length > in6m.length) return "all";
  return "6m";
}

// the one entry point every tap goes through, so a shopping-list tap and a
// Worth watching tap can never drift into two different behaviours: show
// this target's chart, and (v10 spec) scroll to it rather than silently
// updating off-screen.
function selectPriceTarget(target, opts = {}) {
  if (!target) return;
  target = narrowPriceTarget(target);
  const series = seriesForTarget(target);
  if (!series.length) return;
  pricesUiState.target = target;
  pricesUiState.openPill = null;
  endPriceCartConfirm(); // the tick belonged to the old target, not this one
  pricesUiState.period = defaultPeriodFor(series);
  renderTrends();
  if (opts.scroll) {
    const card = document.querySelector(".trends-card");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

export function goToPriceChart(target) {
  store.setView("prices");
  selectPriceTarget(target, { scroll: true });
}

// Reset (by the Trends title): back to the top Worth-watching item on the
// default 6-month, per-supermarket view - identical to tapping that row.
export function resetTrends() {
  pricesUiState.groupBy = "supermarket";
  pricesUiState.openPill = null;
  const t = defaultPriceTarget();
  if (t) {
    selectPriceTarget(t, { scroll: true });
  } else {
    pricesUiState.target = null;
    pricesUiState.period = "6m";
    renderTrends();
  }
}

// the three Product pills, and clearing one. Picking a variant or product
// resets the pills below it; clearing (the x, or picking "All") drops the
// chart one pooling level up.
function pickPriceL1(l1, label) {
  selectPriceTarget({ level: "l1", l1, l1_label: label });
}
function pickPriceL2(l1, label, l2) {
  selectPriceTarget({ level: "l2", l1, l1_label: label, l2 });
}
function pickPriceL3(key) {
  selectPriceTarget({ level: "l3", key });
}
function clearPriceL2(info) {
  selectPriceTarget({ level: "l1", l1: info.l1, l1_label: info.l1_label });
}
function clearPriceL3(info) {
  if (info.l2) pickPriceL2(info.l1, info.l1_label, info.l2);
  else clearPriceL2(info);
}
function togglePricePill(which) {
  pricesUiState.openPill = pricesUiState.openPill === which ? null : which;
  renderTrends();
}

const OPP_COLLAPSED = 5;

export function renderOpportunities() {
  const opps = computeOpportunities("6m");
  const list = $("#oppList");
  if (!opps.length) {
    list.innerHTML = `<li class="opp-empty">Nothing worth watching yet.</li>`;
    $("#oppToggle").hidden = true;
    return;
  }
  const shown = pricesUiState.oppOpen ? opps : opps.slice(0, OPP_COLLAPSED);
  // same shape as a shopping-list row: name left, then right-aligned a
  // qty-styled number and the price icon - and the same bubble rule
  // (v10 spec §6), so a coloured bubble means "clear cheapest store"
  // everywhere it shows up, not just on the list
  list.innerHTML = shown.map((o) => {
    const entry = productEntry(o.key);
    const bubbleStore = entry ? computeBubble(entry.series) : null;
    const best6 = bestPriceInPeriod(entry.series, "6m");
    return `
    <li class="opp-row" data-price-key="${escapeHtml(o.key)}">
      <span class="opp-name">${escapeHtml(o.label)}</span>
      <span class="opp-price">${best6 ? `€${best6.price.toFixed(2)}/kg` : ""}</span>
      <span class="price-btn" aria-hidden="true">
        ${bubbleStore ? `<span class="price-bubble" style="background:${storeColor(bubbleStore)}"></span>` : ""}
        <svg viewBox="0 0 24 24" fill="none" stroke="${bubbleStore ? storeOnColor(bubbleStore) : "currentColor"}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${PRICE_ICON_DOWN_PATH}</svg>
      </span>
    </li>`;
  }).join("");
  $$(".opp-row", list).forEach((row) => {
    row.addEventListener("click", () =>
      selectPriceTarget({ level: "l3", key: row.dataset.priceKey }, { scroll: true }));
  });
  const toggle = $("#oppToggle");
  if (opps.length <= OPP_COLLAPSED) {
    toggle.hidden = true;
  } else {
    toggle.hidden = false;
    toggle.textContent = pricesUiState.oppOpen ? "Show less" : `Show all · ${opps.length}`;
  }
}

// what each line on the chart is: a supermarket (Group by = Supermarket), or a
// variant / product (Group by = Product). "variant" granularity gives a
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
    ln.color = granularity === "store" ? storeColor(ln.id) : lineColor(i);
    ln.points = dayAveraged(ln.points);
  });
  return lines;
}

// dynamic per-item y-axis (v10 spec §5): a fixed scale would flatten a
// EUR 3/kg product to a hairline next to a EUR 60/kg one
function buildPriceChartSvg(lines) {
  const points = lines.flatMap((l) => l.points);
  const dates = [...points.map((p) => p.date)].sort();
  const t0 = new Date(dates[0]).getTime();
  const t1 = new Date(dates[dates.length - 1]).getTime();
  const prices = points.map((p) => p.price);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const pad = Math.max((hi - lo) * 0.15, hi * 0.05, 0.1);
  const yLo = Math.max(0, lo - pad), yHi = hi + pad;
  const X0 = 30, X1 = 310, Y0 = 14, Y1 = 126;
  const xOf = (d) => (t1 === t0 ? (X0 + X1) / 2 : X0 + (X1 - X0) * ((new Date(d).getTime() - t0) / (t1 - t0)));
  const yOf = (p) => Y1 - (Y1 - Y0) * ((p - yLo) / ((yHi - yLo) || 1));

  let svg = `<svg viewBox="0 0 320 148" class="price-svg">`;
  [yHi, (yHi + yLo) / 2, yLo].forEach((v) => {
    const y = yOf(v);
    svg += `<line x1="28" y1="${y.toFixed(1)}" x2="${X1}" y2="${y.toFixed(1)}" class="chart-grid"/>`;
    svg += `<text x="0" y="${(y + 3).toFixed(1)}" class="chart-axis">${v.toFixed(v < 10 ? 1 : 0)}</text>`;
  });

  lines.forEach((ln) => {
    const pts = [...ln.points].sort((a, b) => a.date.localeCompare(b.date));
    const color = ln.color;
    if (pts.length > 1) {
      const poly = pts.map((p) => `${xOf(p.date).toFixed(1)},${yOf(p.price).toFixed(1)}`).join(" ");
      svg += `<polyline points="${poly}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    pts.forEach((p) => {
      const cx = xOf(p.date).toFixed(1), cy = yOf(p.price).toFixed(1);
      // an averaged dot can stand for several purchase rows - two stores on
      // one day under Group by = Product, or two of the same thing in one
      // trip - so it carries all their keys, not one identifying triple
      const keys = [...new Set(p.members.map(purchaseKey))].join("~");
      const d = `data-keys="${escapeHtml(keys)}"`;
      svg += p.promo
        ? `<g class="price-pt" ${d}><circle cx="${cx}" cy="${cy}" r="8" fill="${color}"/><text x="${cx}" y="${(+cy + 3).toFixed(1)}" class="promo-mark" fill="${storeOnColor(p.store)}">€</text></g>`
        : `<circle class="price-pt" ${d} cx="${cx}" cy="${cy}" r="4" fill="${color}"/>`;
    });
  });
  return svg + `</svg>`;
}

// what a Product pill shows when that level has nothing to offer - the same
// em dash the metric cards already use for "no value here"
const NO_LEVEL = "—";
// the Variant pill's answer when there genuinely is no variant to name: the
// whole card carries no L2 at all, or the single product in view is one of
// the bare ones under a card that otherwise has variants. Distinct from "All
// variants" (a real pooling choice across variants that DO exist) and from a
// dash (a level with nothing to say) - "N/A" states that the variant
// dimension does not apply here, which is a fact, not a missing pick.
const NA_VARIANT = "N/A";
// an unset level is not empty, it pools everything under it - so the pill says
// exactly what the dropdown's leading option says, and both are the one string
const ALL_VARIANTS = "All variants";
const ALL_PRODUCTS = "All products";

function priceOptRows(rows, currentId) {
  return rows.map((r) =>
    `<button type="button" class="pill-opt${r.id === currentId ? " on" : ""}" data-opt="${escapeHtml(r.id)}">${escapeHtml(r.label)}</button>`
  ).join("");
}

// every pill in the Trends card is this one button - the Category/Product
// filters and the Period/Group by dropdowns alike - so they cannot drift into
// two spellings of the same control. `opens` is the single switch: a pill that
// opens carries the data-pill the click handlers bind to, and one that does not
// is marked aria-disabled rather than disabled, so it stays announced and keeps
// the .pill colours instead of the browser's greyed-out ones.
// `trailing` is whatever sits after the label - today only a clear x.
function pillButton({ which, text, extra = [], opens, trailing = "" }) {
  const cls = ["pill", ...extra.filter(Boolean)];
  // a pill that cannot open cannot be the open one, whatever openPill still
  // says - it can name a pill that lost its choices under a new target, and
  // the render that clears it runs after this
  if (opens && pricesUiState.openPill === which) cls.push("open");
  // data-lvl says which level a pill is, whether or not it opens - a hook for
  // styling and for finding one in the DOM
  return `<button type="button" class="${cls.join(" ")}" data-lvl="${which}"` +
    `${opens ? ` data-pill="${which}"` : ` aria-disabled="true"`}>` +
    `<span class="pill-text">${escapeHtml(text)}</span>${trailing}</button>`;
}

// the Category row (L1 + L2) and the Product row (L3). Each pill is described
// by three facts and nothing else: `text`, `filled` (it names something, as
// opposed to holding a placeholder), and `opens` (tapping drops a dropdown).
// A pill that is filled but does not open is one there was no choice about;
// only a pill the user could undo carries an x.
//
// Exactly one pill wears the accent: the deepest filled one, because that is
// the thing on the chart. Picking a product moves the accent off the card and
// onto the product; a card pooled across its variants keeps it on L1. The
// levels above stay legible in grey - they still say where you are, they are
// just not the subject.
//
// A level with nothing to offer at all (a card with no variants, a variant
// with no products of its own) shows a dash rather than a placeholder naming a
// choice that does not exist. The open dropdown renders in a full-width host
// below both rows. Dropdowns cascade: L2 lists variants under L1, L3 lists
// products under L1 (and L2). L1 has a search box; L2/L3 never exceed ~15 rows.
function renderPricePills(target, info) {
  const catHost = $("#priceCatPills");
  const prodHost = $("#priceProdPills");
  const l1s = l1Options();
  const variants = l2Options(info.l1);
  const l3scope = l3Options(info.l1, info.l2 || null);

  // a variant is only shown as the forced scope when it really is the whole
  // card (soleVariant) - a card with one variant plus products outside it is
  // wider than that variant, and saying otherwise would misdescribe the chart
  const forcedVariant = soleVariant(info.l1);
  const pills = {
    l1: { text: info.l1_label, filled: true, opens: l1s.length > 1 },
    l2: forcedVariant ? { text: titleCaseVariant(forcedVariant), filled: true, opens: false }
      : !variants.length ? { text: NA_VARIANT, filled: true, opens: false, na: true }
      : target.level === "l3" && !info.l2 ? { text: NA_VARIANT, filled: true, opens: false, na: true }
      : info.l2 ? { text: titleCaseVariant(info.l2), filled: true, opens: true }
      : { text: ALL_VARIANTS, filled: false, opens: true },
    l3: l3scope.length === 1 ? { text: l3scope[0].label, filled: true, opens: false }
      : !l3scope.length ? { text: NO_LEVEL, filled: false, opens: false }
      : target.level === "l3" ? { text: info.label, filled: true, opens: true }
      : { text: ALL_PRODUCTS, filled: false, opens: true },
  };
  // the deepest filled level is the subject of the chart, and the only accent -
  // but an "N/A" variant pill names an absence, never the subject, so it is
  // skipped and the accent falls through to the card it sits under
  const accent = ["l3", "l2", "l1"].find((k) => pills[k].filled && !pills[k].na);

  const pill = (which) => {
    const p = pills[which];
    // clearable exactly when the pill holds a pick that can be undone
    const x = (p.filled && p.opens && which !== "l1")
      ? `<span class="pill-x" data-clear="${which}" aria-hidden="true">✕</span>` : "";
    return pillButton({
      which, text: p.text, opens: p.opens, trailing: x,
      extra: [which === accent && "sel", !p.filled && !p.opens && "pill-empty"],
    });
  };
  // The Category row ends in the same round cart button the ingredient rows
  // carry, so one gesture means one thing everywhere in the app: put this on
  // the list. What it adds is what the two pills say - the card, plus the
  // variant when one is actually named. A product selection is narrower than
  // anything you would write on a shopping list, so an L3 target adds the card
  // and variant that product sits under, never the product itself.
  //
  // Read-only greys it out rather than removing it, the way every other
  // control that needs a token is greyed - including the recipe one it is a
  // copy of. A button that vanishes would also reflow the pills either side of
  // it the moment a token arrives.
  //
  // The Prices view re-renders on every change to the store - including the
  // add this very button just made - so unlike the recipe rows, the confirm
  // cannot live on the button element: it would be replaced the instant it
  // appeared. It lives in priceCartUntil, and this renders whatever state that
  // says the button is in.
  //
  // What the two pills say, and so what the cart adds: the card, plus the
  // variant when one is actually named. Read once here, by both the button's
  // label and its handler, so the two can never describe different things.
  const listedVariant = info.l2 || forcedVariant || null;
  const listedName = listedVariant
    ? `${info.l1_label} ${titleCaseVariant(listedVariant)}` : info.l1_label;
  catHost.innerHTML = pill("l1") + pill("l2") + cartButtonHtml({
    id: "priceCart",
    label: `Add ${listedName} to the shopping list`,
    confirming: Date.now() < priceCartUntil,
  });
  prodHost.innerHTML = pill("l3");

  const cart = $("#priceCart", catHost);
  if (cart) {
    cart.addEventListener("click", (e) => {
      e.stopPropagation();
      if (Date.now() < priceCartUntil) return; // inert while the tick is up
      pricesUiState.openPill = null; // an open dropdown is done with
      // before the add, not after: addItem re-renders the whole Prices view,
      // and that render has to already know this button is confirming or it
      // draws a fresh cart over the tick
      startPriceCartConfirm();
      const created = store.addItem({
        name: info.l1_label,
        qty: null, unit: null,
        // the variant goes in the note, exactly where a recipe add puts it -
        // that is the field Clean up groups on and the field you read in the
        // aisle, so a row added here and one added from a recipe are the same
        // kind of row
        note: listedVariant ? titleCaseVariant(listedVariant) : null,
        source: `trend:${info.l1}${listedVariant ? "#" + listedVariant : ""}`,
        slug: info.l1,
        variant: listedVariant,
      });
      // nothing landed (a list gone read-only between render and tap): take
      // the tick back rather than claim an add that did not happen
      if (!created) { endPriceCartConfirm(); renderTrends(); }
    });
  }

  [catHost, prodHost].forEach((h) => {
    $$(".pill[data-pill]", h).forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.target.closest(".pill-x")) return;
        togglePricePill(b.dataset.pill);
      });
    });
    $$(".pill-x", h).forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (el.dataset.clear === "l2") clearPriceL2(info);
        else clearPriceL3(info);
      });
    });
  });

  // the open Product dropdown, in its own host below the pills row
  const panelHost = $("#pricePillPanel");
  const which = pricesUiState.openPill;
  if (!(pills[which] && pills[which].opens)) {
    // a pill that used to open can lose its choices under a new target
    if (pills[which]) pricesUiState.openPill = null;
    panelHost.hidden = true;
    panelHost.innerHTML = "";
    return;
  }
  let rows, currentId, withSearch = false;
  if (which === "l1") {
    rows = l1s.map((o) => ({ id: o.l1, label: o.label }));
    currentId = info.l1;
    withSearch = true;
  } else if (which === "l2") {
    rows = [{ id: "", label: ALL_VARIANTS }].concat(
      variants.map((v) => ({ id: v, label: titleCaseVariant(v) })));
    currentId = info.l2 || "";
  } else {
    rows = [{ id: "", label: ALL_PRODUCTS }].concat(
      l3scope.map((p) => ({ id: p.key, label: p.label })));
    currentId = target.level === "l3" ? target.key : "";
  }
  panelHost.hidden = false;
  panelHost.innerHTML = `<div class="pill-panel" data-panel="${which}">` +
    (withSearch ? `<input type="text" class="pill-search" placeholder="Search">` : "") +
    `<div class="pill-opts">${priceOptRows(rows, currentId)}</div></div>`;
  positionPillPanel(which === "l3" ? prodHost : catHost, which);

  $$(".pill-opt", panelHost).forEach((o) => {
    o.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = o.dataset.opt;
      if (which === "l1") { if (id !== info.l1) pickPriceL1(id, l1s.find((x) => x.l1 === id).label); else togglePricePill("l1"); }
      else if (which === "l2") { id ? pickPriceL2(info.l1, info.l1_label, id) : clearPriceL2(info); }
      else { id ? pickPriceL3(id) : (info.l2 ? pickPriceL2(info.l1, info.l1_label, info.l2) : clearPriceL2(info)); }
    });
  });
  const search = $(".pill-search", panelHost);
  if (search) {
    search.addEventListener("input", () => {
      const q = deburr(search.value).toLowerCase().trim();
      $$(".pill-opt", panelHost).forEach((o) => {
        o.hidden = q && !deburr(o.textContent).toLowerCase().includes(q);
      });
    });
  }
}

// Put the open dropdown directly under the pill it belongs to, floating over
// whatever is below it. The panel cannot simply live inside the pills row: that
// row scrolls horizontally and clips, so an anchored panel would be cut off.
// It sits instead in a host absolutely positioned within the Trends card, which
// is also what keeps the chart still when a dropdown opens - the host is out of
// the flow, so nothing below it moves. Left is clamped to the card so a pill
// near the right edge does not push the panel off it.
function positionPillPanel(host, which) {
  const panel = $("#pricePillPanel");
  const btn = $(`.pill[data-pill="${which}"]`, host);
  const body = $("#priceTrendsBody");
  if (!btn || !body) return;
  const b = body.getBoundingClientRect();
  const r = btn.getBoundingClientRect();
  panel.style.top = `${r.bottom - b.top + 6}px`;
  const maxLeft = Math.max(0, body.clientWidth - panel.offsetWidth);
  panel.style.left = `${Math.min(Math.max(0, r.left - b.left), maxLeft)}px`;
}

// Period and Group by: two segmented controls sharing one line between the
// chart and the legend. Two options is not enough to earn a dropdown - that
// cost a tap to open and a tap to choose, to pick between two things that
// both fit on screen. Both halves are always shown, and one tap switches.
//
// `canGroup` is false when "by product" would draw the line that is already
// drawn (one product or variant in scope). The Products half is then still
// named and still in place, just plainly not choosable - the same call as the
// dash pill above: say the option exists and is empty rather than removing it
// and letting the row change size under the reader.
function renderPriceSubfilters(canGroup) {
  const control = (hostId, rows, currentId, onPick, liveIndex) => {
    const host = $(hostId);
    const on = Math.max(0, rows.findIndex((r) => r[0] === currentId));
    host.innerHTML =
      `<div class="segment${liveIndex == null ? "" : " forced"}" data-on="${on}">` +
      `<span class="seg-thumb"></span>` +
      rows.map(([id, label], i) => {
        const dead = liveIndex != null && i !== liveIndex;
        return `<button type="button" data-opt="${escapeHtml(id)}"` +
          `${dead ? ` aria-disabled="true"` : ""}` +
          ` aria-pressed="${i === on}">${escapeHtml(label)}</button>`;
      }).join("") + `</div>`;
    $$("button", host).forEach((b) => {
      if (b.getAttribute("aria-disabled") === "true") return;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (b.dataset.opt !== currentId) onPick(b.dataset.opt);
      });
    });
  };

  control("#pricePeriod", PERIODS, pricesUiState.period, (id) => {
    pricesUiState.period = id;
    renderTrends();
  });
  control("#priceGroupBy", GROUPS, pricesUiState.groupBy, (id) => {
    pricesUiState.groupBy = id;
    renderTrends();
  }, canGroup ? null : 0);
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

  // "by product" is only a real choice when it would draw more than one line -
  // judged on what the chosen period actually shows, not on the whole history,
  // or the dropdown offers a switch that changes nothing. Otherwise force
  // supermarket and drop the dropdown affordance.
  const filtered = seriesInPeriod(info.series, pricesUiState.period);
  const productGranularity = target.level === "l1" ? "variant" : "product";
  const canGroupByProduct = chartLines(filtered, productGranularity).length >= 2;
  if (!canGroupByProduct) pricesUiState.groupBy = "supermarket";

  renderPricePills(target, info);
  renderPriceSubfilters(canGroupByProduct);

  const granularity = lineGranularity(target);
  const lines = chartLines(filtered, granularity);
  $("#priceLegend").innerHTML = `<span class="rail-label">Legend</span>` + lines.map((ln) =>
    `<span class="legend-item"><span class="legend-dot" style="background:${ln.color}"></span>${escapeHtml(ln.label)}</span>`
  ).join("");

  const wrap = $("#priceChartWrap");
  if (!filtered.length) {
    wrap.hidden = true;
    wrap.innerHTML = "";
    // a hand-picked year is allowed to draw nothing - say so rather than let
    // "No price history" contradict the metrics still showing below. One
    // purchase is no longer nothing: it draws as a single dot, no polyline.
    $("#priceEmpty").textContent = "Nothing bought in this period.";
    $("#priceEmpty").hidden = false;
  } else {
    wrap.hidden = false;
    $("#priceEmpty").hidden = true;
    wrap.innerHTML = buildPriceChartSvg(lines);
    $$(".price-pt", wrap).forEach((el) => {
      el.addEventListener("click", () =>
        openPriceDetail({ keys: (el.dataset.keys || "").split("~").filter(Boolean) }));
    });
  }

  // "Latest price" is always the most recent purchase, whatever the period
  // chip is set to - it answers "what did I pay", not "what did the chart
  // just draw". Under Group by = Product several products can share that
  // latest date; there is then no single "latest price", so it shows a dash.
  // "Best price" follows the period chip and relabels itself, and is the
  // single cheapest point across everything in view + where it was bought.
  const maxDate = info.series.reduce((m, p) => (p.date > m ? p.date : m), "");
  const onLatest = info.series.filter((p) => p.date === maxDate);
  if (!onLatest.length) {
    $("#priceLastValue").innerHTML = `<span class="metric-none">—</span>`;
    $("#priceLastStore").innerHTML = "";
  } else if (granularity !== "store" && onLatest.length > 1) {
    $("#priceLastValue").innerHTML = `<span class="metric-none">—</span>`;
    $("#priceLastStore").innerHTML = "";
  } else {
    const last = onLatest.reduce((a, b) => (b.price < a.price ? b : a));
    $("#priceLastValue").innerHTML = `€${last.price.toFixed(2)}<span class="metric-unit">/kg</span>`;
    $("#priceLastStore").innerHTML = `<span class="legend-dot" style="background:${storeColor(last.store)}"></span>${escapeHtml(last.store)}`;
  }

  const bestInPeriod = bestPriceInPeriod(info.series, pricesUiState.period);
  $("#priceBestLabel").textContent = `Best price · ${PERIOD_SHORT[pricesUiState.period]}`;
  if (bestInPeriod) {
    $("#priceBestValue").innerHTML = `€${bestInPeriod.price.toFixed(2)}<span class="metric-unit">/kg</span>`;
    $("#priceBestStore").innerHTML = `<span class="legend-dot" style="background:${storeColor(bestInPeriod.store)}"></span>${escapeHtml(bestInPeriod.store)}`;
    $("#priceMetrics").hidden = false;
  } else {
    $("#priceMetrics").hidden = true;
  }

  $("#priceSeeAll").textContent = `See all · ${purchaseRows(info.series).length}`;
}

export function renderPrices(state) {
  renderOpportunities();
  renderTrends();
}

// See-all rows show only day + month - the year is a full-width bar above each
// year's block. Own month list because en-GB's "short" gives a 4-letter "Sept".
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDayMonth(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${Number(d)} ${MONTHS_ABBR[Number(m) - 1]}`;
}

// the "See all" list: one row per (date, product, store), so buying two of the
// same thing at the same shop on one trip is a single line with a quantity, not
// two identical rows. Newest first, then by product name, then store.
function purchaseRows(series) {
  const groups = new Map();
  for (const p of series) {
    const k = purchaseKey(p);
    if (!groups.has(k)) {
      groups.set(k, {
        date: p.date, prodKey: p.prodKey, prodLabel: p.prodLabel,
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

export function renderPriceDetail() {
  if (!priceDetailState || !pricesUiState.target) return;
  const { highlight } = priceDetailState;
  const target = pricesUiState.target;
  const info = resolveTargetInfo(target);
  if (!info) return;

  const title = target.level === "l3" ? info.label
    : target.level === "l2" ? info.l2 : info.l1_label;
  const tags = target.level === "l3" ? [info.l1_label, info.l2]
    : target.level === "l2" ? [info.l1_label] : [];
  $("#priceDetailTitle").textContent = title;
  $("#priceDetailTags").innerHTML = tags.filter(Boolean).map((t) =>
    `<span class="detail-tag">${escapeHtml(t)}</span>`
  ).join("");

  // same columns at every level: date (day + month only), the most-granular
  // name, store, qty, price. One CSS grid holds the header and every row, so a
  // column is one track shared by all of them - guaranteed alignment. Date,
  // qty and price are max-content; product and store split what's left and
  // clip with an ellipsis until the row is tapped open. `.price-row` is
  // display:contents so it can still carry the row's hi / expanded state.
  // Rows run newest first, split into per-year blocks under a full-width bar.
  const cell = (cls, inner) => `<div class="pt-cell ${cls}">${inner}</div>`;
  const head =
    `<div class="price-row pt-headrow">` +
    ["Date", "Product", "Store", "Qty", "€/kg"].map((h) => cell("pt-head", h)).join("") +
    `</div>`;

  // A dot can stand for several rows, so the highlight is a set of purchase
  // keys rather than one date/store/product triple.
  const hiKeys = highlight && highlight.keys ? new Set(highlight.keys) : null;

  let lastYear = null;
  const rows = purchaseRows(info.series).map((g) => {
    // Several of the same thing in one trip is one price paid, so the row
    // shows the average, not the cheapest - the cheapest quietly flattered
    // every multi-buy. It reads as a sale if any one of them was on offer:
    // the offer is the fact worth surfacing, and a row that hid it because a
    // sibling was full price would be the more misleading of the two.
    const avg = g.pts.reduce((sum, p) => sum + p.price, 0) / g.pts.length;
    const anyPromo = g.pts.some((p) => p.promo);
    const priceText = `€${avg.toFixed(2)}`;
    const item = g.prodLabel || titleCaseVariant(g.variant) || info.l1_label;
    const isHi = hiKeys ? hiKeys.has(purchaseKey(g)) : false;
    const year = g.date.slice(0, 4);
    const bar = year === lastYear ? "" : `<div class="pt-year">${year}</div>`;
    lastYear = year;
    const many = g.pts.length > 1;
    const qty = many
      ? `${g.pts.length}<span class="pt-caret">▾</span>`
      : String(g.pts.length);
    // The individual receipt lines behind an averaged row, revealed on a tap.
    // One full-width strip of prices, not one five-column row each: date,
    // product and store are what the row is grouped by, so per-column children
    // would be three empty columns and a "1" - which read as broken rows, not
    // as the parent's contents. Only the price differs, so only the price is
    // shown, in the same offer pill the summary uses.
    const subs = many
      ? `<div class="pt-subs" hidden>` +
        [...g.pts].sort((a, b) => a.price - b.price).map((p) => {
          const t = `€${p.price.toFixed(2)}`;
          return p.promo
            ? `<span class="promo-price">${t}</span>`
            : `<span class="pt-subitem">${t}</span>`;
        }).join("") +
        `</div>`
      : "";
    return bar +
      `<div class="price-row${isHi ? " hi" : ""}${many ? " has-subs" : ""}">` +
      cell("price-date", escapeHtml(formatDayMonth(g.date))) +
      cell("price-item", escapeHtml(item)) +
      cell("price-store", `<span class="legend-dot" style="background:${storeColor(g.store)}"></span><span class="price-store-name">${escapeHtml(g.store)}</span>`) +
      cell("price-qty", qty) +
      // a promo price sits in an accent pill instead of carrying a marker
      cell("price-value", anyPromo ? `<span class="promo-price">${priceText}</span>` : priceText) +
      `</div>` + subs;
  }).join("");

  const table = $("#priceTable");
  table.innerHTML = head + rows;

  // A tap does two things, both "show me the rest of this row": a long product
  // or store name unclips and the row grows to fit, and a row standing for
  // several receipt lines reveals them.
  $$(".price-row:not(.pt-headrow)", table).forEach((r) => {
    r.addEventListener("click", () => {
      const open = r.classList.toggle("expanded");
      const caret = $(".pt-caret", r);
      if (caret) caret.textContent = open ? "▴" : "▾";
      const subs = r.nextElementSibling;
      if (subs && subs.classList.contains("pt-subs")) subs.hidden = !open;
    });
  });
}

export function scrollToHighlightedRow() {
  requestAnimationFrame(() => {
    // .price-row is display:contents (no box of its own) - scroll its first cell
    const el = document.querySelector("#priceDetail .price-row.hi .pt-cell");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}
