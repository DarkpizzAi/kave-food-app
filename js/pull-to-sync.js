/* Spoon: the per-tab pull gesture.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { render } from "./render.js";
import { store } from "./store.js";
import { flushQueue, setSyncing, syncFailed, syncList, syncPrices, syncRecipes, syncing } from "./sync.js";
import { VIEW_TITLES } from "./theme.js";
import { $ } from "./util.js";

// pull-to-refresh on a tab: sync just that tab's data
async function syncCurrentTab() {
  if (syncing || !store.state.settings.token) {
    return new Promise((r) => setTimeout(r, 400)); // still feel the gesture
  }
  setSyncing(true);
  render(store.state); // spinner on
  const v = store.state.view;
  // The outer try is here for its finally, which is the only thing that can be
  // trusted to clear the latch: syncFailed renders, and a throw out of a render
  // would otherwise leave `syncing` true for the rest of the session, with
  // every later sync silently returning at its own guard.
  try {
    try {
      // Each tab pulls what it shows. Plan renders recipes and nothing else, so
      // it does not fetch the list - it will again when the planner starts
      // writing to it.
      if (v === "recipes" || v === "planner") await syncRecipes();
      if (v === "recipes" || v === "list") await syncList();
    } catch (e) {
      syncFailed(e, "syncCurrentTab");
    }
    // Prices, in its own try/catch for the reason fullSync gives: a missing or
    // unreachable price-series.json is an ordinary state for an optional file
    // and must not degrade the sync dot. Until this was added the gesture ran
    // on the Prices tab, showed the spinner and said "Syncing Prices" while
    // fetching nothing - prices only refreshed on open or on Sync now.
    try {
      if (v === "prices") await syncPrices();
    } catch (e) {
      console.warn("syncPrices failed, Prices tab stays on cached data:", e);
    }
  } finally {
    setSyncing(false);
  }
  render(store.state);
  flushQueue();
}

export function syncHeaderHeight() {
  const h = $(".app-header").offsetHeight;
  document.documentElement.style.setProperty("--header-h", h + "px");
}

export function initPullToSync() {
  const main = $("main");
  const ptr = $("#ptr");
  syncHeaderHeight(); // on resize too, from the one listener in wire()
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncHeaderHeight);
  const arrowText = $(".ptr-text", ptr);
  const scroller = document.scrollingElement || document.documentElement;
  const THRESHOLD = 64;
  const MAX = 96;
  let startY = 0;
  let pulling = false;
  let dist = 0;
  let busy = false;

  // Settings is the one tab the gesture does not arm on. It has no data of its
  // own, so a pull there could only ever spin and fetch nothing - and "Sync
  // now", which does sync everything, is already on that tab.
  const canPull = () =>
    store.state.view !== "settings"
    && scroller.scrollTop <= 0 && $("#recipeDetail").hidden && $("#suggestions").hidden;

  document.addEventListener("touchstart", (e) => {
    if (busy || e.touches.length !== 1 || !canPull()) { pulling = false; return; }
    startY = e.touches[0].clientY;
    pulling = true;
    dist = 0;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) {
      dist = 0;
      main.style.transition = "none";
      main.style.transform = "";
      ptr.style.opacity = 0;
      ptr.classList.remove("ready");
      return;
    }
    dist = Math.min(MAX, dy * 0.5);
    main.style.transition = "none";
    main.style.transform = `translateY(${dist}px)`;
    ptr.style.opacity = String(Math.min(1, dist / THRESHOLD));
    ptr.classList.toggle("ready", dist >= THRESHOLD);
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!pulling) return;
    pulling = false;
    main.style.transition = "transform 0.2s ease";

    if (dist < THRESHOLD) {
      main.style.transform = "translateY(0)";
      ptr.style.opacity = 0;
      ptr.classList.remove("ready");
      return;
    }

    busy = true;
    main.style.transform = "translateY(40px)";
    ptr.classList.add("refreshing");
    ptr.classList.remove("ready");
    arrowText.textContent = `Syncing ${VIEW_TITLES[store.state.view]}`;

    syncCurrentTab().finally(() => {
      main.style.transform = "translateY(0)";
      ptr.style.opacity = 0;
      setTimeout(() => {
        ptr.classList.remove("refreshing");
        arrowText.textContent = "Pull to sync";
        busy = false;
        render(store.state);
      }, 200);
    });
  });
}
