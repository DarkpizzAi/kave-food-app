/* Spoon: every listener, delegated, bound once.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { syncHeaderHeight } from "./pull-to-sync.js";
import { closeDrawer, closePage, openDrawer, openPage, pageIsOpen, render, setView, updateToTop } from "./render.js";
import { openListSheet } from "./sheet-list.js";
import { openPriceDetail } from "./sheet-price.js";
import { setSyncState, store } from "./store.js";
import { fullSync } from "./sync.js";
import { applyTheme } from "./theme.js";
import { $, $$ } from "./util.js";
import { addPageIsOpen, closeAddPage, tidyChecked, wireAddPage } from "./view-list.js";
import { pairings, renderBatchSheet, renderPairsSheet, renderPlanner, setBatchOrder, setPairOrder, shuffled, sizePlanStrips } from "./view-plan.js";
import { pricesUiState, renderOppSheet, renderOpportunities, renderTrends, resetTrends, resizePriceChart } from "./view-prices.js";
import { equaliseCards, updateRailFade } from "./view-recipes.js";
import { checkForUpdate, checkToken, setTokenStatus, updateState } from "./view-settings.js";

/* The top bar's search magnifier. PLACEHOLDER: Task 6 builds js/search.js and
   replaces this no-op with the real search. */
export function openSearch() {}

export function wire() {
  // tabs: the navigation bar (compact) and the rail (medium, expanded)
  $$("[data-view]").forEach((b) => {
    b.addEventListener("click", () => setView(b.dataset.view));
  });
  // menu: the top bar's button on compact, the rail's on wider windows
  $("#menuBtn").addEventListener("click", openDrawer);
  $("#railMenuBtn").addEventListener("click", openDrawer);
  $("#searchBtn").addEventListener("click", openSearch);
  $("#drawerScrim").addEventListener("click", closeDrawer);
  $$("#drawer [data-page]").forEach((b) => {
    b.addEventListener("click", () => openPage(b.dataset.page));
  });
  $("#pageBack").addEventListener("click", closePage);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (addPageIsOpen()) closeAddPage(); else if (pageIsOpen()) closePage(); else closeDrawer();
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

  wireAddPage();
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
  $$("#setPalette [data-palette]").forEach((b) => {
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
  /* Advanced settings > App link: copy the public address, to open Spoon on
     another device. The label swaps to "Copied" for a moment; if the
     clipboard is refused, the link is selected to copy by hand. */
  $("#copyAppLink").addEventListener("click", (e) => {
    const btn = e.currentTarget, input = $("#appLink");
    const icon = btn.querySelector(".m3-icon");
    const done = () => { icon.textContent = "check"; setTimeout(() => { icon.textContent = "content_copy"; }, 1500); };
    /* the older copy command often works where the clipboard API is refused
       (an embedded frame); failing both, the link stays selected */
    const byHand = () => { input.focus(); input.select(); try { if (document.execCommand("copy")) done(); } catch (err) { /* selected */ } };
    if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, byHand); else byHand();
  });
  $("#clearToken").addEventListener("click", () => {
    $("#setToken").value = "";
    store.setToken("");
    // the cached list/recipes stay readable (Task 5); only the token goes
    setTokenStatus({ state: "idle", text: "" });
    setSyncState({ kind: "idle", resetAt: null });
    render(store.state);
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
