/* Spoon: top-level render. Every interaction ends here.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { store, syncState } from "./store.js";
import { flushing, syncing } from "./sync.js";
import { VIEW_TITLES } from "./theme.js";
import { $, $$ } from "./util.js";
import { renderList, renderListBadge } from "./view-list.js";
import { renderPlanner } from "./view-plan.js";
import { renderPrices } from "./view-prices.js";
import { renderRecipes } from "./view-recipes.js";
import { renderSettings } from "./view-settings.js";

// show the back-to-top button once the shopping list is scrolled past ~200px
export function updateToTop() {
  const btn = $("#toTop");
  if (!btn) return;
  const sc = document.scrollingElement || document.documentElement;
  btn.classList.toggle("show", store.state.view === "list" && sc.scrollTop > 200);
}

export function render(state) {
  $("#viewTitle").textContent = VIEW_TITLES[state.view];
  $$(".view").forEach((v) => { v.hidden = v.id !== `view-${state.view}`; });
  $$(".bottom-nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === state.view);
  });

  document.body.classList.toggle("readonly", store.readOnly());

  // header dot: spinner while working, amber when edits are unsynced, red on error
  const dot = $("#syncDot");
  dot.className = "sync-dot" + (
    syncing || flushing ? " working"
    : syncState.kind === "unauthorized" || syncState.kind === "offline" || syncState.kind === "rateLimited" ? " error"
    : store.queue.length ? " pending"
    : ""
  );

  renderListBadge(state);
  if (state.view === "list") renderList(state);
  if (state.view === "prices") renderPrices(state);
  if (state.view === "recipes") renderRecipes(state);
  if (state.view === "planner") renderPlanner(state);
  if (state.view === "settings") renderSettings(state);
  updateToTop();
}
