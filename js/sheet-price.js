/* Ladle: the Insights sheet, the shared sheet drag, and the recipe detail body.

   The Insights sheet is one Material 3 modal sheet (a bottom sheet on a phone,
   a side sheet on a wider window) that the Insights tab reuses for its four
   jobs: the purchase history, the full Worth watching list, the Category /
   Product radio pickers and the receipt clean-up. It owns one history entry,
   so the phone's back button closes it and nothing else. */
"use strict";

import { enterLayer, exitLayer, kaveKey, showSnackbar } from "../m3/kave-m3.js";
import { cap, resolveTargetInfo, roundQty, titleCaseVariant } from "./prices-data.js";
import { detailState, setDetailState, setSheetHasHistory, setTabHasHistory, slideSheetDown, tabHasHistory, wireRecipeSheet } from "./sheet-recipe.js";
import { backSheets } from "./back-sheets.js";
import { store } from "./store.js";
import { $, $$, escapeHtml, safeUrl } from "./util.js";
import { fmtFullDate, metricsHtml, pricesUiState, purchaseRows, storeKeyOf } from "./view-prices.js";
import { TYPE_LABEL, tileHtml, typeOf } from "./view-recipes.js";

/* ---------- the Insights sheet ---------- */

const ins = {
  open: false, hasHistory: false, kind: "bottom", token: 0,
  render: null, onClose: null, opener: null, owner: null, waiters: [], wired: false,
};

export const insSheetIsOpen = () => ins.open;

function drawIns() {
  const body = $("#insSheetBody");
  body.innerHTML = "";
  if (ins.render) ins.render(body);
}

// a sync that lands while the sheet is open redraws it from fresh state
export function refreshInsSheet() {
  if (ins.open) drawIns();
}

function settleWaiters() {
  const w = ins.waiters; ins.waiters = [];
  w.forEach((f) => f());
}

function hideIns(immediate = false) {
  if (!ins.open) return;
  ins.open = false;
  ins.render = null;
  const cb = ins.onClose; ins.onClose = null;
  const token = ++ins.token;
  const el = $("#insSheet"), scrim = $("#insScrim");
  const done = () => {
    if (token !== ins.token) return;     // reopened meanwhile
    el.hidden = true; scrim.hidden = true;
    settleWaiters();
  };
  if (immediate) done();
  else exitLayer(el, ins.kind).then(done);
  const o = ins.opener; ins.opener = null;
  if (o && o.isConnected && o.offsetParent !== null) o.focus({ preventScroll: true });
  if (cb) cb();
}

// the tap, the scrim, Escape and the phone's back button are one path.
// Resolves once the sheet is gone, for a caller that acts on the page under it.
export function closeInsSheet() {
  return new Promise((resolve) => {
    if (!ins.open) { resolve(); return; }
    ins.waiters.push(resolve);
    if (ins.hasHistory) { ins.hasHistory = false; history.back(); }
    else hideIns();
  });
}

// swipe down on the handle or the title row closes a bottom sheet
function wireInsDrag() {
  const el = $("#insSheet");
  let y0 = null, dy = 0;
  [$("#insSheetHandle"), $("#insSheetHead")].forEach((g) => {
    g.addEventListener("pointerdown", (e) => {
      if (ins.kind !== "bottom" || e.target.closest("button")) return;
      y0 = e.clientY; dy = 0;
      try { g.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    });
    g.addEventListener("pointermove", (e) => {
      if (y0 == null) return;
      dy = Math.max(0, e.clientY - y0);
      el.style.transform = `translateY(${dy}px)`;
    });
    const end = () => {
      if (y0 == null) return;
      y0 = null;
      el.style.transform = "";
      if (dy > 80) closeInsSheet();
    };
    g.addEventListener("pointerup", end);
    g.addEventListener("pointercancel", end);
  });
}

function wireIns() {
  if (ins.wired) return;
  ins.wired = true;
  $("#insSheetClose").addEventListener("click", () => closeInsSheet());
  $("#insScrim").addEventListener("click", () => closeInsSheet());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ins.open) { e.stopPropagation(); closeInsSheet(); }
  });
  // the sheet belongs to the tab it was opened from
  store.subscribe((s) => {
    if (ins.open && s.view !== ins.owner) { ins.hasHistory = false; hideIns(true); }
  });
  wireInsDrag();
}

/* title: the sheet's heading. render(body) draws into the body and is called
   again by refreshInsSheet. onClose runs once, however the sheet closes. */
export function openInsSheet({ title, render, onClose = null, tall = false }) {
  wireIns();
  if (ins.open) { ins.hasHistory = false; hideIns(true); }
  settleWaiters();
  const el = $("#insSheet"), scrim = $("#insScrim");
  const side = document.documentElement.dataset.size !== "compact";
  ins.open = true;
  ins.render = render; ins.onClose = onClose;
  ins.owner = store.state.view;
  ins.kind = side ? "side" : "bottom";
  ins.opener = document.activeElement;
  ins.token++;
  el.className = side ? "m3-sheet--side" : `m3-sheet--bottom${tall ? " is-tall" : ""}`;
  el.style.transform = "";
  $("#insSheetHandle").hidden = side;
  $("#insSheetTitle").textContent = title;
  scrim.hidden = false; el.hidden = false;
  drawIns();
  enterLayer(el, ins.kind);
  try { history.pushState({ insSheet: true }, ""); ins.hasHistory = true; }
  catch (e) { ins.hasHistory = false; }
  $("#insSheetClose").focus({ preventScroll: true });
}

/* ---------- purchase history ---------- */

/* The history of whatever the Trends card is showing: its Latest and Best
   price cards, then one line per purchase, newest first. No chart. A tap on a
   chart dot opens it with that dot's purchases picked out (highlight.keys). */
export function openPriceDetail(highlight = null) {
  if (!pricesUiState.target) return;
  openInsSheet({
    title: "Purchase history", tall: true,
    render: (body) => renderPriceHistory(body, highlight),
  });
  if (highlight && highlight.keys && highlight.keys.length) {
    requestAnimationFrame(() => {
      const hi = $("#insSheetBody .is-hi");
      if (hi) hi.scrollIntoView({ block: "center" });
    });
  }
}

function renderPriceHistory(body, highlight) {
  const target = pricesUiState.target;
  const info = target && resolveTargetInfo(target);
  if (!info) {
    body.innerHTML = `<p class="m3-body-m m3-variant">No purchases to show.</p>`;
    return;
  }
  const title = target.level === "l3" ? info.label
    : target.level === "l2" ? titleCaseVariant(info.l2) : info.l1_label;
  const sub = (target.level === "l3" ? [info.l1_label, info.l2 && titleCaseVariant(info.l2)]
    : target.level === "l2" ? [info.l1_label] : []).filter(Boolean).join(" · ");
  const rows = purchaseRows(info.series);
  const hiKeys = highlight && highlight.keys ? new Set(highlight.keys) : null;
  const pooled = target.level !== "l3";
  const avgOf = (g) => g.pts.reduce((s, p) => s + p.price, 0) / g.pts.length;
  const lowest = rows.reduce((m, g) => Math.min(m, avgOf(g)), Infinity);

  const lines = rows.map((g) => {
    // several of the same thing in one trip is one price paid: show the
    // average, and the offer if any one of them was on offer
    const avg = avgOf(g);
    const anyPromo = g.pts.some((p) => p.promo);
    const item = g.prodLabel || titleCaseVariant(g.variant) || info.l1_label;
    const many = g.pts.length > 1;
    const isHi = hiKeys ? hiKeys.has(g.key) : false;
    const support = [g.store, pooled ? item : null,
      many ? `${g.pts.length} bought` : null].filter(Boolean).join(" · ");
    return `<div class="m3-list-item ins-purchase${isHi ? " is-hi" : ""}">` +
      `<span class="m3-dot" style="${kaveKey(storeKeyOf(g.store))}"></span>` +
      `<div class="m3-list-item__text m3-list-item__text--wrap">` +
        `<div class="m3-body-l">${escapeHtml(fmtFullDate(g.date))}</div>` +
        `<div class="m3-body-m m3-variant">${escapeHtml(support)}</div></div>` +
      (anyPromo ? `<span class="m3-tag">Offer</span>` : "") +
      `<span class="m3-title-m m3-num ins-price${avg === lowest ? " is-best" : ""}">€${avg.toFixed(2)}</span>` +
      `</div>`;
  }).join("");

  body.innerHTML =
    `<div class="m3-stack"><h3 class="m3-headline-s ins-sheet-name">${escapeHtml(title)}</h3>` +
    (sub ? `<p class="m3-body-m m3-variant ins-sheet-sub">${escapeHtml(sub)}</p>` : "") + `</div>` +
    `<div class="ins-metrics">${metricsHtml(info)}</div>` +
    `<div class="m3-list-header"><span class="m3-title-s">Purchases</span>` +
    `<span class="m3-label-m m3-variant">${rows.length}</span></div>` +
    `<div class="m3-grouped">${lines}</div>`;
}

/* ---------- history entries and the one popstate handler ---------- */

// Sheets that own one history entry each register in back-sheets.js. They
// register here so this one popstate handler decides, in one place, whether a
// back press was theirs to consume - two handlers racing would let the tab
// underneath react to a press that only closed a sheet.
backSheets.push({
  isOpen: () => ins.open,
  close: () => { ins.hasHistory = false; hideIns(); },
});

window.addEventListener("popstate", () => {
  setSheetHasHistory(false);
  let consumed = false;
  if (detailState != null) {
    if ($("#recipeDetail").hidden) setDetailState(null); // parked elsewhere: back just discards it
    else slideSheetDown();
    consumed = true;
  }
  // A recipe sheet opened from one of the listed sheets sits on top of it, so
  // it takes the press first; only when it was not open does a listed sheet
  // close. One press, one sheet.
  if (!consumed) {
    for (const s of backSheets) {
      if (s.isOpen()) { s.close(); consumed = true; break; }
    }
  }
  // A sheet was on top, so this press closed it and goes no further. Only a
  // press with no sheet in the way reaches the tab underneath.
  if (consumed) return;
  if (!tabHasHistory) return;
  setTabHasHistory(false);
  // The entry can be stale - tapping List directly leaves it on the stack
  // rather than racing history.back() against an open sheet's own entry - in
  // which case this press has already been paid for and does nothing visible.
  if (store.state.view !== "list") store.setView("list");
});

// tap or swipe-down on the tinted name bar closes the sheet - shared by the
// recipe sheet and the price sheet, same physics, different close callback
export function bindSheetDrag(barSel, elSel, onClose) {
  const bar = $(barSel);
  const el = $(elSel);
  let startY = 0;
  let dy = 0;
  let dragging = false;
  let moved = false;

  bar.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    dy = 0;
    dragging = true;
    moved = false;
    el.style.transition = "none";
  }, { passive: true });

  bar.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    dy = e.touches[0].clientY - startY;
    if (dy > 0) {
      moved = true;
      e.preventDefault();
      el.style.transform = `translate(-50%, ${dy}px)`;
    } else {
      el.style.transform = "translate(-50%, 0)";
    }
  }, { passive: false });

  bar.addEventListener("touchend", (e) => {
    if (!dragging) return;
    dragging = false;
    e.preventDefault(); // suppress the ghost click
    el.style.transition = "";
    el.style.transform = "";
    if (!moved || dy < 6 || dy > 90) {
      onClose(); // tap, or dragged far enough -> close (CSS finishes the slide)
    }
    // otherwise: transform cleared -> springs back to translate(-50%, 0)
  }, { passive: false });

  bar.addEventListener("click", () => onClose());
}

export function initSheetDrag() {
  wireRecipeSheet();
}

function isCountUnit(unit) {
  return !unit || ["gousse", "branche", "botte", "paquet", "tranche"].includes(unit);
}

function isWeightVolumeUnit(u) { return /^(g|kg|mg|ml|cl|l)$/i.test(u || ""); }
function isSpoonUnit(u) { return /^(cs|cc)$/i.test(u || ""); }

// snap a fractional count to 0, 1/3, 1/2, 2/3 (a scaled onion reads as
// "1 1/2", not "1.5"). qtyText renders the mixed number.
function snapCount(x) {
  const whole = Math.floor(x), f = x - whole;
  const near = [0, 1 / 3, 1 / 2, 2 / 3, 1].reduce(
    (a, b) => Math.abs(b - f) < Math.abs(a - f) ? b : a);
  return whole + near;
}

// scale one ingredient quantity for a new servings count, honouring its
// fractionnability class from recipes.json. Scaling display policy (Isa,
// 2026-09-02): weight and volume round UP to a whole unit with no decimal,
// spoons to the nearest half, counted items stay fractional. Falls back to
// the old unit heuristic for recipes cached before `frac` existed.
function scaleQty(ing, factor) {
  const x = ing.qty * factor;
  if (ing.frac === "au gout") return ing.qty;                // never scaled
  if (ing.frac === "entier") return Math.max(1, Math.round(x));
  if (ing.frac === "fractionnable") {
    if (isWeightVolumeUnit(ing.unit)) return Math.ceil(x);   // up to the next g / ml
    if (isSpoonUnit(ing.unit)) return Math.round(x * 2) / 2; // nearest half spoon
    return snapCount(x);                                     // counted: 1 1/2, 1 1/3
  }
  return roundQty(x, isCountUnit(ing.unit));                 // no `frac`
}


function qtyText(qty, unit) {
  let q = qty;
  // a counted quantity with a fraction shows as a mixed number: "1 1/2",
  // "1 1/2 branche" - but never for a weight, volume or spoon measure
  if (typeof qty === "number" && !Number.isInteger(qty)
      && !isWeightVolumeUnit(unit) && !isSpoonUnit(unit)) {
    const whole = Math.floor(qty);
    const label = [[1 / 3, "1/3"], [1 / 2, "1/2"], [2 / 3, "2/3"]].reduce(
      (a, b) => Math.abs(b[0] - (qty - whole)) < Math.abs(a[0] - (qty - whole)) ? b : a)[1];
    q = whole > 0 ? `${whole} ${label}` : label;
  }
  return `${escapeHtml(q)}${unit ? " " + escapeHtml(unit) : ""}`;
}


/* ---------- the recipe body: the sheet and the expanded pane draw the same thing ---------- */

// Portions the sheet offers, in order (the mockup's chips)
export const PORTION_CHOICES = [1, 2, 4, 6, 8];

const snack = (opts) => showSnackbar($("#snackHost"), opts);

function metaLine(recipe) {
  const bits = [];
  if (recipe.cuisine) bits.push(cap(recipe.cuisine));
  bits.push(TYPE_LABEL[typeOf(recipe)]);
  if (recipe.stub) bits.push(recipe.stubKind === "link" ? "Link only" : "To write");
  if (recipe.prep) bits.push(`Prep ${recipe.prep}`);
  if (recipe.cook) bits.push(`Cook ${recipe.cook}`);
  return bits.join(" · ");
}

function emptyCard(text) {
  return `<div class="m3-card m3-card--filled rd-empty"><span class="m3-body-m m3-variant">${escapeHtml(text)}</span></div>`;
}

/* Draw one recipe into `host`. `st` is { recipe, servings }; `redraw` runs
   after a change to st (a portions chip, Reset). Each ingredient has its own
   cart button: one tap adds just that ingredient at the scaled amount, with
   a snackbar and Undo. The list is a tally, so a second tap adds a second
   row, deliberately (CLAUDE.md). */
export function renderRecipeInto(host, st, redraw) {
  const { recipe } = st;
  const head = `<div class="rd-head">${tileHtml(recipe, true)}` +
    `<div class="m3-stack rd-title"><h2 class="m3-headline-s rd-name">${escapeHtml(recipe.name)}</h2>` +
    `<p class="m3-body-m m3-variant rd-meta">${escapeHtml(metaLine(recipe))}</p></div></div>`;

  // index-only entry: no card written yet. Show where to cook it from, nothing to scale.
  if (recipe.stub) {
    // numbered off the surviving links, not recipe.sources - a dropped source
    // must not leave a gap in "Open recipe 1 / 3"
    const links = (recipe.sources || []).map(safeUrl).filter(Boolean).map((u, i, all) =>
      `<a class="m3-btn m3-btn--tonal rd-link" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">` +
      `<span class="m3-icon" aria-hidden="true">open_in_new</span>Open recipe${all.length > 1 ? " " + (i + 1) : ""}</a>`).join("");
    host.innerHTML = head +
      (links
        ? `<p class="m3-body-m m3-variant">Not saved as a full recipe yet, so there is no scaler or shopping-list add for this one.</p><div class="m3-chips">${links}</div>`
        : `<p class="m3-body-m m3-variant">Not written up yet. Cook it once and add it with the <code>add-recipe</code> skill and it becomes a full card here.</p>`);
    return;
  }

  const base = recipe.portions;
  const target = st.servings;
  const factor = base ? target / base : 1;
  const scaled = target !== base;
  const ro = store.readOnly();

  const chips = PORTION_CHOICES.map((n) => {
    const on = n === target;
    return `<button type="button" class="m3-chip${on ? " m3-chip--leading is-selected" : ""}" data-serv="${n}" aria-pressed="${on}">` +
      `${on ? '<span class="m3-icon" aria-hidden="true">check</span>' : ""}${n}</button>`;
  }).join("");

  const rows = recipe.ingredients.map((ing, i) => {
    let qtyStr = "";
    if (ing.qty != null) qtyStr = qtyText(scaled ? scaleQty(ing, factor) : ing.qty, ing.unit);
    else if (ing.raw) qtyStr = escapeHtml(ing.raw);
    const label = `Add ${ing.name} to the list`;
    return `<div class="m3-list-item rd-ing">` +
      `<div class="m3-list-item__text m3-list-item__text--wrap"><div class="m3-body-l">${escapeHtml(ing.name)}` +
      `${ing.note ? ` <span class="m3-variant">(${escapeHtml(ing.note)})</span>` : ""}</div></div>` +
      (qtyStr ? `<span class="m3-body-m m3-variant m3-num rd-qty">${qtyStr}</span>` : "") +
      `<button type="button" class="m3-icon-btn m3-icon-btn--small rd-cart" data-i="${i}" aria-label="${escapeHtml(label)}"${ro ? " disabled" : ""}>` +
      `<span class="m3-icon" aria-hidden="true">add_shopping_cart</span></button></div>`;
  }).join("");

  const steps = recipe.steps.length
    ? `<ol class="rd-steps">${recipe.steps.map((s) => `<li class="m3-body-m">${escapeHtml(s)}</li>`).join("")}</ol>`
    : emptyCard("No steps written down yet.");

  host.innerHTML = head +
    `<div class="m3-stack"><span class="m3-title-s">Portions</span>` +
    `<div class="m3-chips rd-portions" role="group" aria-label="Portions">${chips}` +
    `<button type="button" class="m3-btn m3-btn--text" data-reset${target === base ? " disabled" : ""}>Reset</button></div></div>` +
    `<div class="m3-stack"><span class="m3-title-s">Ingredients</span>` +
    (recipe.ingredients.length
      ? `<span class="m3-body-s m3-variant">Tap the cart beside an ingredient to put it on the list.</span><div class="m3-grouped">${rows}</div>`
      : emptyCard("No ingredients written down yet.")) + `</div>` +
    (recipe.portionsConfirmed ? "" : `<p class="m3-body-s m3-variant">Base portions not confirmed in the kitchen.</p>`) +
    `<div class="m3-stack"><span class="m3-title-s">Steps</span>${steps}</div>`;

  $$("[data-serv]", host).forEach((b) => {
    b.addEventListener("click", () => {
      st.servings = Number(b.dataset.serv); redraw();
      const again = $(`[data-serv="${st.servings}"]`, host); if (again) again.focus({ preventScroll: true });
    });
  });
  $("[data-reset]", host).addEventListener("click", () => { st.servings = recipe.portions; redraw(); });

  $$(".rd-cart", host).forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.i);
      const ing = recipe.ingredients[i];
      let qty = null, unit = null;
      if (ing.qty != null) {
        qty = scaled ? scaleQty(ing, factor) : ing.qty;
        unit = ing.unit;
      }
      const name = ing.conceptName || ing.name;
      // null when the list is read-only: then nothing landed and nothing is said
      const made = store.addItem({
        name, qty, unit,
        // the authored variant label when the recipe has one ("Hachée
        // mixte boeuf-porc"), else the derived hint ("hachée mixte") -
        // the note is what you read in the aisle, so the fuller name wins
        note: [ing.variantLabel || ing.variantHint, ing.note]
          .filter(Boolean).join(", ") || null,
        // provenance, not identity - the same row can be added twice, so
        // nothing looks this key up expecting to find at most one
        source: `recipe:${recipe.slug}#${i}`,
        slug: ing.slug || null,
        variant: ing.variant || null,
      });
      if (!made) return;
      snack({ text: `Added ${name} to the list`, action: "Undo", onAction: () => store.deleteItem(made.id) });
    });
  });
}

// the sheet's body, drawn from detailState
export function renderDetail() {
  if (!detailState) return;
  const el = $("#recipeDetail");
  el.setAttribute("aria-label", detailState.recipe.name);
  renderRecipeInto($("#detailBody"), detailState, renderDetail);
}
