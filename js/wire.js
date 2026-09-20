/* Spoon: every listener, delegated, bound once.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { syncHeaderHeight } from "./pull-to-sync.js";
import { render, updateToTop } from "./render.js";
import { openListSheet } from "./sheet-list.js";
import { openPriceDetail } from "./sheet-price.js";
import { setSyncState, store } from "./store.js";
import { fullSync } from "./sync.js";
import { applyTheme } from "./theme.js";
import { $, $$ } from "./util.js";
import { checkedOpen, renderSuggestions, setCheckedOpen, submitAddName, tidyChecked } from "./view-list.js";
import { pairings, renderBatchSheet, renderPairsSheet, renderPlanner, setBatchOrder, setPairOrder, shuffled, sizePlanStrips } from "./view-plan.js";
import { pricesUiState, renderOppSheet, renderOpportunities, renderTrends, resetTrends, resizePriceChart } from "./view-prices.js";
import { equaliseCards, updateRailFade } from "./view-recipes.js";
import { advancedOpen, checkForUpdate, checkToken, renderSettings, setAdvancedOpen, setTokenStatus, updateState } from "./view-settings.js";

export function wire() {
  $$(".bottom-nav button").forEach((b) => {
    b.addEventListener("click", () => store.setView(b.dataset.view));
  });

  $$("#cuisineFilters, #mainFilters").forEach((rail) => {
    rail.addEventListener("scroll", () => updateRailFade(rail), { passive: true });
  });

  window.addEventListener("scroll", updateToTop, { passive: true });
  $("#toTop").addEventListener("click", () => {
    const sc = document.scrollingElement || document.documentElement;
    const start = sc.scrollTop;
    sc.scrollTo({ top: 0, behavior: "smooth" });
    // if smooth scroll isn't honoured (some webviews), the position hasn't
    // budged after a beat - jump instead
    setTimeout(() => { if (sc.scrollTop === start) sc.scrollTop = 0; }, 120);
  });

  const addName = $("#addName");
  addName.addEventListener("input", () => renderSuggestions(store.state));
  addName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitAddName(); }
  });
  addName.addEventListener("blur", () => {
    setTimeout(() => { $("#suggestions").hidden = true; }, 120);
  });
  addName.addEventListener("focus", () => renderSuggestions(store.state));

  $("#checkedToggle").addEventListener("click", () => {
    setCheckedOpen(!checkedOpen);
    render(store.state);
  });
  $("#tidyChecked").addEventListener("click", tidyChecked);

  $("#oppToggle").addEventListener("click", () => openListSheet("Worth watching", "Lowest price · 6 mo", renderOppSheet));
  $("#pairToggle").addEventListener("click", () => openListSheet("Worth pairing", "Meals that share a perishable, so the bunch gets used.", renderPairsSheet));
  $("#batchToggle").addEventListener("click", () => openListSheet("Good for leftovers", "Cook the base once, then twice more just the fast fresh part.", renderBatchSheet));
  $("#pairShuffle").addEventListener("click", () => {
    setPairOrder(shuffled(pairings(store.state.recipes).map((p) => p.recipes.join("|"))));
    renderPlanner(store.state);
  });
  $("#batchShuffle").addEventListener("click", () => {
    setBatchOrder(shuffled(store.state.recipes.filter((r) => r.batch).map((r) => r.slug)));
    renderPlanner(store.state);
  });
  $("#priceSeeAll").addEventListener("click", () => openPriceDetail());
  $("#priceReset").addEventListener("click", resetTrends);

  // tapping anywhere outside an open Trends dropdown closes it
  document.addEventListener("click", (e) => {
    if (pricesUiState.openPill &&
        !e.target.closest("#priceCatPills, #priceProdPills, #pricePillPanel")) {
      pricesUiState.openPill = null;
      renderTrends();
    }
  });

  // the price sheet's own to-top: its scroll never reaches window scroll,
  // since .detail is its own overflow-y:auto container
  $("#priceDetail").addEventListener("scroll", () => {
    $("#priceToTop").classList.toggle("show", $("#priceDetail").scrollTop > 200);
  }, { passive: true });
  $("#priceToTop").addEventListener("click", () => {
    $("#priceDetail").scrollTo({ top: 0, behavior: "smooth" });
  });

  $$("#setWho button").forEach((b) => {
    b.addEventListener("click", () => store.setWho(b.dataset.who));
  });
  $$("#setPalette button").forEach((b) => {
    b.addEventListener("click", () => store.setPalette(b.dataset.palette));
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((store.state.settings.theme || "system") === "system") applyTheme("system");
    });

  // one resize listener for the lot: rail fades, header height, card heights
  let resizeTimer;
  window.addEventListener("resize", () => {
    $$("#cuisineFilters, #mainFilters").forEach(updateRailFade);
    syncHeaderHeight();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (store.state.view === "recipes") equaliseCards();
      if (store.state.view === "planner") sizePlanStrips();
      if (store.state.view === "prices") resizePriceChart();
    }, 120);
  });
  $("#setToken").addEventListener("blur", (e) => {
    const next = e.target.value.trim();
    if (next === store.state.settings.token) return; // unchanged, don't re-check
    store.setToken(next);
    checkToken();
  });
  $("#clearToken").addEventListener("click", () => {
    $("#setToken").value = "";
    store.setToken("");
    // the cached list/recipes stay readable (Task 5); only the token goes
    setTokenStatus({ state: "idle", text: "" });
    setSyncState({ kind: "idle", resetAt: null });
    render(store.state);
  });

  $("#advancedToggle").addEventListener("click", () => {
    setAdvancedOpen(!advancedOpen);
    // full settings render, not just the disclosure: Update and Display are
    // only rendered while the block is open, so opening it has to fill them
    renderSettings(store.state);
  });

  $("#updateBtn").addEventListener("click", () => {
    if (updateState.kind === "ready") { location.reload(); return; }
    checkForUpdate();
  });

  $("#refreshBtn").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (b.disabled) return;
    b.disabled = true;
    b.textContent = "Syncing...";
    await fullSync();
    b.textContent = "Sync now";
    render(store.state); // renderSettings re-enables it if there is a token
  });
}
