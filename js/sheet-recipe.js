/* Ladle: the recipe sheet, on Material 3: open, park, close.

   One recipe, two homes. On a phone or a tablet (compact and medium) it is a
   modal bottom sheet with its own history entry, so the phone's back closes
   it. On an expanded window the Recipes tab is a list-detail layout and the
   recipe fills the right-hand pane instead; the pane lives in
   view-recipes.js, which registers itself here with setPaneOpener so this
   file never imports the view (that would be a cycle).

   openRecipe(slug) keeps its name and is the one entry point either way. */
"use strict";

import { enterLayer, exitLayer } from "../m3/kave-m3.js";
import { bindSheetDrag, renderDetail } from "./sheet-price.js";
import { store } from "./store.js";
import { $ } from "./util.js";

// { recipe, servings, owner } while the sheet is open (or parked)
export let detailState = null;
let sheetClosing = false;
let closeRequested = false;
let sheetHasHistory = false;
let sheetToken = 0;
let sheetOpener = null;
let sheetOpenerSel = "";
let sheetKind = "bottom";        // bottom sheet on compact, side sheet on wider windows
let skipExit = false;            // a drag already took the sheet off screen
// one history entry standing for "somewhere other than the List tab"
export let tabHasHistory = false;

// the Recipes tab's right-hand pane, when it has one
let paneOpener = null;
export function setPaneOpener(fn) { paneOpener = fn; }
const paneWanted = () =>
  paneOpener != null && document.documentElement.dataset.size === "expanded" && store.state.view === "recipes";

// a selector that finds the same control again after the tab re-renders it
export function focusKey(el) {
  if (!el || !el.dataset) return "";
  for (const k of ["slug", "drop", "q"]) {
    if (el.dataset[k]) return `[data-${k}="${CSS.escape(el.dataset[k])}"]`;
  }
  return "";
}
export function refocus(sel, o) {
  if (o && o.isConnected && o.offsetParent !== null) { o.focus({ preventScroll: true }); return; }
  const f = sel ? document.querySelector(`#view-recipes ${sel}`) : null;
  if (f && f.offsetParent !== null) f.focus({ preventScroll: true });
}

export const recipeSheetIsOpen = () => detailState != null && !$("#recipeDetail").hidden;

// cancel a finished exit animation: its forwards fill would keep a re-shown sheet off screen
function clearAnims(el) {
  if (el && typeof el.getAnimations === "function") el.getAnimations().forEach((a) => a.cancel());
}

export function openRecipe(slug) {
  const recipe = store.state.recipes.find((r) => r.slug === slug);
  if (!recipe) return;
  // expanded: the recipe fills the pane, there is no sheet to open
  if (paneWanted()) { paneOpener(recipe); return; }
  if (detailState != null && !$("#recipeDetail").hidden && !sheetClosing) {
    // already open (a tap on the recipe under it): swap the recipe, keep the one history entry
    detailState = { recipe, servings: recipe.portions, owner: store.state.view };
    renderDetail();
    $("#detailBody").scrollTop = 0;
    return;
  }
  detailState = {
    recipe, servings: recipe.portions,
    owner: store.state.view,          // the tab that opened it: "recipes" or "planner"
  };
  const el = $("#recipeDetail"), scrim = $("#recipeScrim");
  sheetClosing = false;
  closeRequested = false;
  sheetToken++;
  sheetOpener = document.activeElement;
  sheetOpenerSel = focusKey(sheetOpener);
  const side = document.documentElement.dataset.size !== "compact";
  sheetKind = side ? "side" : "bottom";
  skipExit = false;
  el.className = (side ? "m3-sheet--side" : "m3-sheet--bottom is-tall") + " rl-sheet";
  $("#recipeHandle").hidden = side;
  el.style.transform = ""; scrim.style.opacity = "";
  scrim.hidden = false; el.hidden = false;
  renderDetail();
  $("#detailBody").scrollTop = 0;
  enterLayer(el, sheetKind);
  try {
    history.pushState({ recipeSheet: true }, "");
    sheetHasHistory = true;
  } catch (e) {
    sheetHasHistory = false;
  }
  $("#recipeClose").focus({ preventScroll: true });
}

// slide the sheet down and out; called by popstate and (via history.back) by closeRecipe
export function slideSheetDown() {
  const el = $("#recipeDetail"), scrim = $("#recipeScrim");
  if (el.hidden || sheetClosing) return;
  sheetClosing = true;
  const token = ++sheetToken;
  const skip = skipExit; skipExit = false;
  if (!skip) el.style.transform = "";
  (skip ? Promise.resolve() : exitLayer(el, sheetKind)).then(() => {
    if (token !== sheetToken) return;       // reopened meanwhile
    el.hidden = true; scrim.hidden = true;
    detailState = null;
    sheetClosing = false;
    closeRequested = false;
  });
  const o = sheetOpener; sheetOpener = null;
  refocus(sheetOpenerSel, o);
}

// leaving the sheet's owning tab: hide it instantly, keep it "open"
export function parkRecipe() {
  const el = $("#recipeDetail");
  if (el.hidden || detailState == null) return;
  el.hidden = true; $("#recipeScrim").hidden = true;
}

// back on the owning tab: restore the stashed sheet, no animation
export function unparkRecipe() {
  const el = $("#recipeDetail");
  if (detailState == null) return;
  clearAnims(el); clearAnims($("#recipeScrim"));
  el.hidden = false; $("#recipeScrim").hidden = false;
  $("#detailBody").scrollTop = 0;
}

// tab-tap / phone-back / scrim / close button all route here
export function closeRecipe() {
  if (detailState == null || sheetClosing || closeRequested) return;
  const parked = $("#recipeDetail").hidden;
  closeRequested = true;
  if (sheetHasHistory) {
    sheetHasHistory = false;
    history.back(); // -> popstate -> slideSheetDown (or just discards a parked sheet)
  } else if (parked) {
    detailState = null; closeRequested = false;
  } else {
    slideSheetDown();
  }
}

// swipe down on the handle or the title row (compact only): the shared sheet drag
function wireDrag() {
  bindSheetDrag({
    sheet: $("#recipeDetail"), grips: [$("#recipeHandle"), $("#recipeHead")],
    canDrag: () => sheetKind === "bottom" && recipeSheetIsOpen() && !sheetClosing,
    onClose: () => { skipExit = true; closeRecipe(); },
  });
}

let wired = false;
export function wireRecipeSheet() {
  if (wired) return;
  wired = true;
  $("#recipeClose").addEventListener("click", closeRecipe);
  $("#recipeScrim").addEventListener("click", closeRecipe);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && recipeSheetIsOpen()) { e.stopPropagation(); closeRecipe(); }
  });
  wireDrag();
}

/* An imported binding is read-only, so a module that does not declare
   one of these cannot assign to it. These are the writes that used to
   happen across what was a single shared scope. */
export function setDetailState(v) { detailState = v; }
export function setSheetHasHistory(v) { sheetHasHistory = v; }
export function setTabHasHistory(v) { tabHasHistory = v; }
