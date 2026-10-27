/* Ladle: the Insights sheet, the shared sheet drag, and the recipe detail body.

   The Insights sheet is one Material 3 modal sheet (a bottom sheet on a phone,
   a side sheet on a wider window) that the Insights tab reuses for its four
   jobs: the purchase history, the full Worth watching list, the Category /
   Product radio pickers and the receipt clean-up. It owns one history entry,
   so the phone's back button closes it and nothing else. */
"use strict";

import { EASE, enterLayer, exitLayer, kaveKey, play, sharedAxisIn, sharedAxisOut, showSnackbar } from "../m3/kave-m3.js";
import { cap, resolveTargetInfo, roundQty, titleCaseVariant } from "./prices-data.js";
import { detailState, setDetailState, setSheetHasHistory, setTabHasHistory, slideSheetDown, tabHasHistory, wireRecipeSheet } from "./sheet-recipe.js";
import { backSheets } from "./back-sheets.js";
import { store } from "./store.js";
import { $, $$, escapeHtml, safeUrl } from "./util.js";
import { fmtFullDate, metricsHtml, pricesUiState, purchaseRows, storeKeyOf } from "./view-prices.js";
import { TYPE_LABEL, tileHtml, typeOf } from "./view-recipes.js";

/* ---------- the Insights sheet ---------- */

/* One sheet, a stack of levels inside it. The first popup gets a close button
   and the kit's rise (bottom) or slide (side); a popup opened from inside it
   does not stack a second scrim: it swaps the content with the shared axis and
   shows a back arrow instead, with a history entry of its own, so the phone's
   back returns one level. */
const ins = {
  open: false, kind: "bottom", token: 0, stack: [], entries: 0, closeAll: false, skipExit: false,
  opener: null, owner: null, waiters: [], wired: false, swapToken: 0,
};
const top = () => ins.stack[ins.stack.length - 1] || null;

export const insSheetIsOpen = () => ins.open;

function drawIns() {
  const body = $("#insSheetBody");
  body.innerHTML = "";
  const f = top();
  if (f && f.render) f.render(body);
}

// a sync that lands while the sheet is open redraws it from fresh state
export function refreshInsSheet() {
  if (ins.open) drawIns();
}

function settleWaiters() {
  const w = ins.waiters; ins.waiters = [];
  w.forEach((f) => f());
}

// the title and the back arrow or close button follow the level on top
function paintHead() {
  const f = top();
  $("#insSheetTitle").textContent = f ? f.title : "";
  const nested = ins.stack.length > 1;
  $("#insSheetBack").hidden = !nested;
  $("#insSheetClose").hidden = nested;
}

const clearAnims = (el) => { if (el && el.getAnimations) el.getAnimations().forEach((a) => a.cancel()); };

function hideIns(immediate = false) {
  if (!ins.open) return;
  ins.open = false;
  const frames = ins.stack.slice().reverse();
  ins.stack = []; ins.entries = 0; ins.closeAll = false;
  const token = ++ins.token;
  const el = $("#insSheet"), scrim = $("#insScrim");
  const skip = immediate || ins.skipExit;   // skipExit: a drag already took it off screen
  ins.skipExit = false;
  const done = () => {
    if (token !== ins.token) return;     // reopened meanwhile
    el.hidden = true; scrim.hidden = true;
    settleWaiters();
  };
  if (skip) done();
  else exitLayer(el, ins.kind).then(done);
  const o = ins.opener; ins.opener = null;
  if (o && o.isConnected && o.offsetParent !== null) o.focus({ preventScroll: true });
  frames.forEach((f) => { if (f.onClose) f.onClose(); });
}

// swap the content of the sheet to the level on top, along the shared axis
function swapLevel(dir, leaving) {
  const swap = ++ins.swapToken;
  const body = $("#insSheetBody"), title = $("#insSheetTitle");
  Promise.all([sharedAxisOut(body, dir), sharedAxisOut(title, dir)]).then(() => {
    if (swap !== ins.swapToken || !ins.open) return;
    if (leaving && leaving.onClose) leaving.onClose();
    paintHead();
    drawIns();
    body.scrollTop = 0;
    sharedAxisIn(body, dir);
    sharedAxisIn(title, dir);
    const first = ins.stack.length > 1 ? $("#insSheetBack") : $("#insSheetClose");
    first.focus({ preventScroll: true });
  });
}

// one level back; the level's own history entry is spent by the caller
function popLevel() {
  const leaving = ins.stack.pop();
  if (leaving && leaving.onClose) leaving.onClose();   // now, so an interrupted swap cannot drop it
  swapLevel(-1, null);
}

// Closes the whole sheet. The tap, the scrim, Escape and the phone's back
// button are one path. Resolves once the sheet is gone, for a caller that acts
// on the page under it.
export function closeInsSheet() {
  return new Promise((resolve) => {
    if (!ins.open) { resolve(); return; }
    ins.waiters.push(resolve);
    if (ins.entries > 0) {
      const n = ins.entries;
      ins.closeAll = true;
      history.go(-n);          // one popstate, however many levels deep
    } else hideIns();
  });
}

// the back arrow: one level
function backInsLevel() {
  if (!ins.open || ins.stack.length < 2) return;
  if (ins.entries > 0) history.back();
  else popLevel();
}

backSheets.push({
  isOpen: () => ins.open,
  close: () => {
    // the phone's back, or the sheet's own history call: one level, or all of it
    if (ins.stack.length > 1 && !ins.closeAll) { ins.entries = Math.max(0, ins.entries - 1); popLevel(); }
    else hideIns();
  },
});

/* Dragging a sheet by its handle or title row. On a phone (compact) a bottom
   sheet follows the finger and the scrim fades with it; let go past a third of
   its height and it leaves, otherwise it springs back. canDrag() says whether
   the sheet is a bottom sheet right now; wider windows present a side sheet
   with a close button and no drag. onClose runs once the sheet is off screen. */
export function bindSheetDrag({ sheet, grips, canDrag, onClose }) {
  const prev = sheet.previousElementSibling;
  const scrim = prev && prev.classList.contains("m3-scrim") ? prev : null;
  let y0 = null, dy = 0, h = 1;
  grips.forEach((g) => {
    g.style.touchAction = "none";
    g.addEventListener("pointerdown", (e) => {
      if (!canDrag() || e.target.closest("button")) return;
      clearAnims(sheet);
      y0 = e.clientY; dy = 0; h = sheet.offsetHeight || 1;
      try { g.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    });
    g.addEventListener("pointermove", (e) => {
      if (y0 == null) return;
      dy = Math.max(0, e.clientY - y0);
      sheet.style.transform = `translateY(${dy}px)`;
      if (scrim) scrim.style.opacity = String(Math.max(0, 1 - dy / h));
    });
    const end = (cancelled) => {
      if (y0 == null) return;
      y0 = null;
      const from = dy;
      const fade = scrim ? Number(scrim.style.opacity || 1) : 1;
      if (!cancelled && from > h / 3) {
        // finish the leave from where the finger let go; the scrim fades out with it
        const ms = Math.max(120, 250 * (1 - from / h));
        if (scrim) play(scrim, [{ opacity: fade }, { opacity: 0 }], ms, "linear", { fill: "forwards" });
        play(sheet, [{ transform: `translateY(${from}px)` }, { transform: "translateY(100%)" }],
          ms, EASE.accelerate, { fill: "forwards" }).then(onClose);
      } else {
        // a cancelled gesture is never a close: spring back, scrim back to full
        sheet.style.transform = "";
        if (scrim) { scrim.style.opacity = ""; if (from > 0) play(scrim, [{ opacity: fade }, { opacity: 1 }], 250, "linear"); }
        if (from > 0) play(sheet, [{ transform: `translateY(${from}px)` }, { transform: "none" }], 250, EASE.decelerate);
      }
    };
    g.addEventListener("pointerup", () => end(false));
    g.addEventListener("pointercancel", () => end(true));
  });
}

function wireIns() {
  if (ins.wired) return;
  ins.wired = true;
  $("#insSheetClose").addEventListener("click", () => closeInsSheet());
  $("#insSheetBack").addEventListener("click", backInsLevel);
  $("#insScrim").addEventListener("click", () => closeInsSheet());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ins.open) { e.stopPropagation(); closeInsSheet(); }
  });
  // the sheet belongs to the tab it was opened from
  store.subscribe((s) => {
    if (ins.open && s.view !== ins.owner) { ins.entries = 0; hideIns(true); }
  });
  bindSheetDrag({
    sheet: $("#insSheet"), grips: [$("#insSheetHandle"), $("#insSheetHead")],
    canDrag: () => ins.open && ins.kind === "bottom",
    onClose: () => { ins.skipExit = true; closeInsSheet(); },
  });
}

/* title: the sheet's heading. render(body) draws into the body and is called
   again by refreshInsSheet. onClose runs once, however the level closes.
   Opened while the sheet is already up, this is a popup from inside it: the
   content changes along the shared axis and the back arrow shows. */
export function openInsSheet({ title, render, onClose = null, tall = false }) {
  wireIns();
  const frame = { title, render, onClose, tall };
  if (ins.open) {
    ins.stack.push(frame);
    try { history.pushState({ insSheet: ins.stack.length }, ""); ins.entries++; } catch (e) { /* no entry: the arrow pops */ }
    swapLevel(1, null);
    return;
  }
  settleWaiters();
  const el = $("#insSheet"), scrim = $("#insScrim");
  const side = document.documentElement.dataset.size !== "compact";
  ins.open = true;
  ins.stack = [frame]; ins.entries = 0; ins.closeAll = false; ins.skipExit = false;
  ins.owner = store.state.view;
  ins.kind = side ? "side" : "bottom";
  ins.opener = document.activeElement;
  ins.token++; ins.swapToken++;
  el.className = side ? "m3-sheet--side" : `m3-sheet--bottom${tall ? " is-tall" : ""}`;
  el.style.transform = ""; scrim.style.opacity = "";
  clearAnims($("#insSheetBody")); clearAnims($("#insSheetTitle"));
  $("#insSheetHandle").hidden = side;
  paintHead();
  scrim.hidden = false; el.hidden = false;
  drawIns();
  enterLayer(el, ins.kind);
  try { history.pushState({ insSheet: 1 }, ""); ins.entries = 1; }
  catch (e) { ins.entries = 0; }
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

  // a base outside the usual five still shows, so the selection is visible
  const choices = [...new Set([...PORTION_CHOICES, ...(base ? [base] : [])])].sort((a, b) => a - b);
  const chips = choices.map((n) => {
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
