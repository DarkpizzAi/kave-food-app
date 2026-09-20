/* Spoon: the price detail sheet, the shared sheet drag, and the recipe detail body.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { MAIN_LABELS, cap, cartButtonHtml, confirmAdd, roundQty } from "./prices-data.js";
import { closeRecipe, detailState, setDetailState, setSheetHasHistory, setTabHasHistory, slideSheetDown, tabHasHistory } from "./sheet-recipe.js";
import { store } from "./store.js";
import { $, $$, escapeHtml, own, safeUrl } from "./util.js";
import { pricesUiState, renderPriceDetail, scrollToHighlightedRow } from "./view-prices.js";

// { key, highlightDate, highlightStore } - the two identify one row to
// always whatever the Trends card is currently showing (pricesUiState.target)
// - "See all" and a chart-dot tap both open the same sheet, the dot just
// also carries a {date, store} to scroll to and highlight
export let priceDetailState = null;
let priceSheetClosing = false;
let priceCloseRequested = false;
let priceSheetHasHistory = false;

export function openPriceDetail(highlight = null) {
  if (!pricesUiState.target) return;
  priceDetailState = { highlight };
  const el = $("#priceDetail");
  priceSheetClosing = false;
  priceCloseRequested = false;
  el.hidden = false;
  el.classList.remove("shown");
  el.style.transition = "";
  el.style.transform = "";
  renderPriceDetail();
  el.scrollTop = 0;
  void el.offsetHeight;
  el.classList.add("shown");
  try {
    history.pushState({ priceSheet: true }, "");
    priceSheetHasHistory = true;
  } catch (e) {
    priceSheetHasHistory = false;
  }
  if (highlight) scrollToHighlightedRow();
}

function slidePriceSheetDown() {
  const el = $("#priceDetail");
  if (el.hidden || priceSheetClosing) return;
  priceSheetClosing = true;
  el.style.transition = "";
  el.style.transform = "";
  el.classList.remove("shown");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.removeEventListener("transitionend", onEnd);
    el.hidden = true;
    priceDetailState = null;
    priceSheetClosing = false;
    priceCloseRequested = false;
  };
  const onEnd = (e) => {
    if (e.target === el && e.propertyName === "transform") finish();
  };
  el.addEventListener("transitionend", onEnd);
  setTimeout(finish, 450);
}

export function parkPriceDetail() {
  const el = $("#priceDetail");
  if (el.hidden || priceDetailState == null) return;
  el.style.transition = "none";
  el.classList.remove("shown");
  el.hidden = true;
  el.style.transform = "";
}

export function unparkPriceDetail() {
  const el = $("#priceDetail");
  if (priceDetailState == null) return;
  el.hidden = false;
  el.style.transition = "none";
  el.classList.add("shown");
  el.style.transform = "translate(-50%, 0)";
  el.scrollTop = 0;
  void el.offsetHeight;
  el.style.transition = "";
}

export function closePriceDetail() {
  if ($("#priceDetail").hidden || priceSheetClosing || priceCloseRequested) return;
  priceCloseRequested = true;
  if (priceSheetHasHistory) {
    priceSheetHasHistory = false;
    history.back();
  } else {
    slidePriceSheetDown();
  }
}

window.addEventListener("popstate", () => {
  setSheetHasHistory(false);
  priceSheetHasHistory = false;
  let consumed = false;
  if (detailState != null) {
    if ($("#recipeDetail").hidden) setDetailState(null); // parked elsewhere: back just discards it
    else slideSheetDown();
    consumed = true;
  }
  if (priceDetailState != null) {
    if ($("#priceDetail").hidden) priceDetailState = null;
    else slidePriceSheetDown();
    consumed = true;
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
function bindSheetDrag(barSel, elSel, onClose) {
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
  bindSheetDrag("#detailBar", "#recipeDetail", closeRecipe);
}
export function initPriceSheetDrag() {
  bindSheetDrag("#priceDetailBar", "#priceDetail", closePriceDetail);
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

function servingPresets(recipe) {
  if (recipe.presets && recipe.presets.length) return recipe.presets;
  const b = recipe.portions || 4;
  return [...new Set([1, 2, b, b * 2].filter((n) => n >= 1 && n <= 10))].sort((a, b2) => a - b2);
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
  return `${q}${unit ? " " + escapeHtml(unit) : ""}`;
}

// up to 3 pills for the detail header: cuisine, type, and the stub status
function detailBarHtml(recipe) {
  const tags = [];
  if (recipe.cuisine) tags.push(cap(recipe.cuisine));
  if (recipe.mainIngredient && recipe.mainIngredient !== "other") {
    tags.push(own(MAIN_LABELS, recipe.mainIngredient)
      ? MAIN_LABELS[recipe.mainIngredient] : cap(recipe.mainIngredient));
  }
  if (recipe.stub) tags.push(recipe.stubKind === "link" ? "link only" : "to write");
  const pills = tags.slice(0, 3)
    .map((t) => `<span class="detail-tag">${escapeHtml(t)}</span>`).join("");
  return `<span class="rname">${escapeHtml(recipe.name)}</span>` +
    (pills ? `<div class="detail-tags">${pills}</div>` : "");
}

export function renderDetail() {
  const { recipe } = detailState;

  // index-only entry: no card written yet. Show the name + where to cook it
  // from, nothing to scale.
  if (recipe.stub) {
    $("#detailBar").innerHTML = detailBarHtml(recipe);
    // numbered off the surviving links, not recipe.sources - a dropped source
    // must not leave a gap in "Open recipe 1 / 3"
    const links = (recipe.sources || []).map(safeUrl).filter(Boolean).map((u, i, all) =>
      `<a class="stub-link" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">
         Open recipe${all.length > 1 ? " " + (i + 1) : ""} &nearr;</a>`).join("");
    $("#detailBody").innerHTML = `
      <div class="stub-body">
        ${links || `<p class="hint">Not written up yet. Cook it once and add it
          with the <code>add-recipe</code> skill and it becomes a full card here.</p>`}
        ${links ? `<p class="hint">Not saved as a full recipe yet, so there is no
          scaler or shopping-list add for this one.</p>` : ""}
      </div>`;
    return;
  }

  const base = recipe.portions;
  const target = detailState.servings;
  const factor = base ? target / base : 1;
  const scaled = target !== base;
  const presets = servingPresets(recipe);

  // Shopping mode is armed by the one cart button in the Ingredients header,
  // which then leaves: there is a cart on every row, and a twelfth in the
  // header would be noise. There is no way back out, and none is needed - the
  // mode adds nothing, undoes nothing, and openRecipe starts every opening
  // with addMode false, so closing the sheet is the exit.
  //
  // read-only (no usable token) blocks every list write, so shopping mode
  // would just show ticks that never land - collapse it instead
  const addMode = detailState.addMode && !store.readOnly();
  const ingHtml = recipe.ingredients.map((ing, i) => {
    const nameHtml = `<span class="nm">${escapeHtml(ing.name)}` +
      `${ing.note ? ` <span class="note">(${escapeHtml(ing.note)})</span>` : ""}`;
    let qtyCell, scaledCell, trailing = "";
    if (ing.qty != null) {
      qtyCell = `<span class="qty">${qtyText(ing.qty, ing.unit)}</span>`;
      const scaledQty = scaleQty(ing, factor);
      scaledCell = scaled ? `<span class="qty-scaled">${qtyText(scaledQty, ing.unit)}</span>` : "";
    } else {
      qtyCell = `<span class="qty"></span>`;
      scaledCell = scaled ? `<span class="qty-scaled"></span>` : "";
      trailing = ing.raw ? ` <span class="note">${escapeHtml(ing.raw)}</span>` : "";
    }
    const addCell = addMode
      ? cartButtonHtml({
          cls: "ing-add", attrs: `data-i="${i}"`,
          label: `Add ${ing.name} to the shopping list`,
        })
      : "";
    return `<li>${qtyCell}${scaledCell}${nameHtml}${trailing}</span>${addCell}</li>`;
  }).join("");

  const gridCols = [
    "max-content",
    ...(scaled ? ["max-content"] : []),
    "1fr",
    ...(addMode ? ["max-content"] : []),
  ].join(" ");

  const stepsHtml = recipe.steps.length
    ? `<h3>Preparation</h3><ol class="steps">${recipe.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>`
    : `<h3>Preparation</h3><p class="hint">Not written up yet.</p>`;

  const customIsExtra =
    detailState.custom != null && !presets.includes(detailState.custom);
  const bubbles = presets
    .map((p) => {
      const cls = `bubble${target === p ? " on" : ""}${p === base ? " base" : ""}`;
      return `<button class="${cls}" data-serv="${p}">${p}</button>`;
    })
    .join("");
  let customBubble;
  if (detailState.customEditing) {
    customBubble = `<input class="bubble-input" id="customServ" type="number" inputmode="numeric" min="1" placeholder="#" value="${detailState.custom ?? ""}" />`;
  } else if (customIsExtra) {
    customBubble = `<button class="bubble${target === detailState.custom ? " on" : ""}" id="customBubble" data-serv="${detailState.custom}">${detailState.custom}</button>`;
  } else {
    customBubble = `<button class="bubble bubble-custom" id="customBubble">Custom</button>`;
  }

  $("#detailBar").innerHTML = detailBarHtml(recipe);

  $("#detailBody").innerHTML = `
    <div class="scaler">
      <span class="scaler-label">Servings</span>
      <div class="bubbles">${bubbles}${customBubble}</div>
      <button class="reset" id="resetScale">Reset</button>
    </div>
    <div class="ing-head">
      <h3>Ingredients</h3>
      ${addMode ? "" : cartButtonHtml({
        id: "ingArm", cls: "cart-lg", label: "Add ingredients to the shopping list",
      })}
    </div>
    <ul class="ing-list${addMode ? " adding" : ""}" style="grid-template-columns:${gridCols}">${ingHtml}</ul>
    ${recipe.portionsConfirmed ? "" : `<p class="unconfirmed">Base portions not confirmed in the kitchen.</p>`}
    ${stepsHtml}
  `;

  const body = $("#detailBody");

  $$(".bubble[data-serv]", body).forEach((b) => {
    b.addEventListener("click", () => {
      detailState.servings = Number(b.dataset.serv);
      detailState.customEditing = false;
      renderDetail();
    });
  });

  const cb = $("#customBubble", body);
  if (cb) {
    cb.addEventListener("click", () => {
      detailState.customEditing = true;
      renderDetail();
    });
  }

  const ci = $("#customServ", body);
  if (ci) {
    ci.focus();
    ci.select();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = Math.round(Number(ci.value));
      if (v >= 1) {
        detailState.custom = presets.includes(v) ? null : v;
        detailState.servings = v;
      }
      detailState.customEditing = false;
      renderDetail();
    };
    ci.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { done = true; detailState.customEditing = false; renderDetail(); }
    });
    ci.addEventListener("blur", commit);
  }

  $("#resetScale", body).addEventListener("click", () => {
    detailState.servings = recipe.portions;
    detailState.custom = null;
    detailState.customEditing = false;
    renderDetail();
  });

  const arm = $("#ingArm", body);
  if (arm) {
    arm.addEventListener("click", () => {
      detailState.addMode = true;
      renderDetail();
    });
  }

  $$(".ing-add", body).forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("added")) return; // inert while the tick is up
      const i = Number(btn.dataset.i);
      const ing = recipe.ingredients[i];
      let qty = null, unit = null;
      if (ing.qty != null) {
        qty = scaled ? scaleQty(ing, factor) : ing.qty;
        unit = ing.unit;
      }
      // only confirm if the item actually landed - store.addItem returns
      // null when the list is read-only
      const created = store.addItem({
        name: ing.conceptName || ing.name,
        qty, unit,
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
      // the button carries the whole confirm; re-rendering the sheet here
      // would throw the tick away the moment it appeared
      if (created) confirmAdd(btn);
    });
  });
}
