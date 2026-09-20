/* Spoon: the one "See all" sheet.

   Worth watching, Worth pairing, Good for leftovers and the receipt clean-up
   each show a few rows in place and end on a "See all · N" button. Three of
   them open this sheet, which is a title over whatever list the caller draws:
   the same swoop-up as the recipe and price sheets, closed by a tap or a swipe
   down on the bar, or by the back button. The caller passes a render function
   rather than rows, so a sync that lands while the sheet is open redraws it
   from fresh state (refreshListSheet). */
"use strict";

import { backSheets } from "./back-sheets.js";
import { bindSheetDrag } from "./sheet-price.js";
import { store } from "./store.js";
import { $ } from "./util.js";

let open = false;
let hasHistory = false;
let ownerView = null;
let renderFn = null;
let closeWaiters = [];

export function openListSheet(title, sub, render) {
  const el = $("#listSheet");
  renderFn = render;
  ownerView = store.state.view;
  $("#listSheetTitle").textContent = title;
  $("#listSheetSub").textContent = sub;
  open = true;
  el.hidden = false;
  el.classList.remove("shown");
  draw();
  el.scrollTop = 0;
  void el.offsetHeight;
  el.classList.add("shown");
  try {
    history.pushState({ listSheet: true }, "");
    hasHistory = true;
  } catch (e) {
    hasHistory = false;
  }
}

function draw() {
  const body = $("#listSheetBody");
  body.innerHTML = "";
  if (renderFn) renderFn(body);
}

export function refreshListSheet() {
  if (open) draw();
}

function hide() {
  const el = $("#listSheet");
  open = false;
  renderFn = null;
  el.classList.remove("shown");
  setTimeout(() => { if (!open) el.hidden = true; }, 300);
  closeWaiters.forEach((f) => f());
  closeWaiters = [];
}

// Closes through the history entry, so a tap, a swipe and the back button are
// one path. Resolves once the sheet is actually closed, for a caller that
// wants to act on the page underneath (Worth watching scrolls to a chart).
export function closeListSheet() {
  return new Promise((resolve) => {
    if (!open) { resolve(); return; }
    closeWaiters.push(resolve);
    if (hasHistory) history.back();
    else hide();
  });
}

backSheets.push({
  isOpen: () => open,
  close: () => { hasHistory = false; hide(); },
});

export function initListSheet() {
  bindSheetDrag("#listSheetBar", "#listSheet", () => { closeListSheet(); });
  // the sheet belongs to the tab it was opened from
  store.subscribe((s) => {
    if (open && s.view !== ownerView) { hasHistory = false; hide(); }
  });
}
