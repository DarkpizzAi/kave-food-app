/* Spoon: the recipe detail sheet: open, park, close.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { renderDetail } from "./sheet-price.js";
import { store } from "./store.js";
import { $ } from "./util.js";

// { recipe, servings, custom, customEditing, addMode, added:Set<ingredientIndex> }
export let detailState = null;
let sheetClosing = false;
let closeRequested = false;
let sheetHasHistory = false;
// one history entry standing for "somewhere other than the List tab"
export let tabHasHistory = false;

export function openRecipe(slug) {
  const recipe = store.state.recipes.find((r) => r.slug === slug);
  if (!recipe) return;
  detailState = {
    recipe, servings: recipe.portions, custom: null, customEditing: false,
    // armed by the header cart, and never carried between openings: a tick is
    // a moment, not a record of what is on the list
    addMode: false,
    owner: store.state.view,          // the tab that opened it: "recipes" or "planner"
  };
  const el = $("#recipeDetail");
  sheetClosing = false;
  closeRequested = false;
  el.hidden = false;
  el.classList.remove("shown");
  el.style.transition = "";
  el.style.transform = "";
  renderDetail();
  el.scrollTop = 0;
  void el.offsetHeight; // commit the off-screen start state before transitioning
  el.classList.add("shown");
  try {
    history.pushState({ recipeSheet: true }, "");
    sheetHasHistory = true;
  } catch (e) {
    sheetHasHistory = false;
  }
}

// slide the sheet down and out; called by popstate and (via history.back) by closeRecipe
export function slideSheetDown() {
  const el = $("#recipeDetail");
  if (el.hidden || sheetClosing) return;
  sheetClosing = true;
  el.style.transition = "";
  el.style.transform = ""; // drop any drag override so the CSS drives it out
  el.classList.remove("shown");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.removeEventListener("transitionend", onEnd);
    el.hidden = true;
    detailState = null;
    sheetClosing = false;
    closeRequested = false;
  };
  const onEnd = (e) => {
    if (e.target === el && e.propertyName === "transform") finish();
  };
  el.addEventListener("transitionend", onEnd);
  setTimeout(finish, 450);
}

// leaving the sheet's owning tab: hide it instantly, keep it "open".
// Shopping mode and its ticks are kept - they only reset on the cart toggle
// or on closing the recipe. A half-typed custom serving is dropped.
export function parkRecipe() {
  const el = $("#recipeDetail");
  if (el.hidden || detailState == null) return;
  if (detailState.customEditing) {
    detailState.customEditing = false;
    renderDetail();
  }
  el.style.transition = "none";
  el.classList.remove("shown");
  el.hidden = true;
  el.style.transform = "";
}

// back on the owning tab: restore the stashed sheet, no animation
export function unparkRecipe() {
  const el = $("#recipeDetail");
  if (detailState == null) return;
  el.hidden = false;
  el.style.transition = "none";
  el.classList.add("shown");
  el.style.transform = "translate(-50%, 0)";
  el.scrollTop = 0;
  void el.offsetHeight; // commit before re-enabling transitions
  el.style.transition = "";
}

// tab-tap / phone-back / bar tap all route here
export function closeRecipe() {
  if ($("#recipeDetail").hidden || sheetClosing || closeRequested) return;
  closeRequested = true;
  if (sheetHasHistory) {
    sheetHasHistory = false;
    history.back(); // -> popstate -> slideSheetDown
  } else {
    slideSheetDown();
  }
}

/* An imported binding is read-only, so a module that does not declare
   one of these cannot assign to it. These are the writes that used to
   happen across what was a single shared scope. */
export function setDetailState(v) { detailState = v; }
export function setSheetHasHistory(v) { sheetHasHistory = v; }
export function setTabHasHistory(v) { tabHasHistory = v; }
