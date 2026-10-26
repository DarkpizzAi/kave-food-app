/* Ladle: the Insights sheet, the shared sheet drag, and the recipe detail body.

   The Insights sheet is one Material 3 modal sheet (a bottom sheet on a phone,
   a side sheet on a wider window) that the Insights tab reuses for its four
   jobs: the purchase history, the full Worth watching list, the Category /
   Product radio pickers and the receipt clean-up. It owns one history entry,
   so the phone's back button closes it and nothing else. */
"use strict";

import { enterLayer, exitLayer, kaveKey } from "../m3/kave-m3.js";
import { MAIN_LABELS, cap, cartButtonHtml, confirmAdd, resolveTargetInfo, roundQty, titleCaseVariant } from "./prices-data.js";
import { closeRecipe, detailState, setDetailState, setSheetHasHistory, setTabHasHistory, slideSheetDown, tabHasHistory } from "./sheet-recipe.js";
import { backSheets } from "./back-sheets.js";
import { store } from "./store.js";
import { $, $$, escapeHtml, own, safeUrl } from "./util.js";
import { fmtFullDate, metricsHtml, pricesUiState, purchaseRows, storeKeyOf } from "./view-prices.js";

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
  bindSheetDrag("#detailBar", "#recipeDetail", closeRecipe);
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
  return `${escapeHtml(q)}${unit ? " " + escapeHtml(unit) : ""}`;
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
