/* Spoon: entry point. The only module index.html loads.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { github } from "../github.js";
import { initPullToSync } from "./pull-to-sync.js";
import { render } from "./render.js";
import { initPriceSheetDrag, initSheetDrag } from "./sheet-price.js";
import { IS_LOCAL_DEV, store } from "./store.js";
import { flushQueue, pollTick, showTapBanner, startPolling } from "./sync.js";
import { applyPalette, applyTheme } from "./theme.js";
import { checkToken, renderSyncStatus, themeBootRan } from "./view-settings.js";
import { wire } from "./wire.js";

store.load();                       // list + recipes + sync meta from the cache
if (!themeBootRan()) {
  console.warn(
    "Spoon: #theme-preload in index.html did not run. If you just edited it, "
    + "its CSP hash is stale - recompute script-src's sha256 with the command "
    + "in the README, under \"The token, and what protects it\"."
  );
}

github.setToken(store.state.settings.token);
applyPalette(store.state.settings.palette || "cobalt");
applyTheme(store.state.settings.theme || "system");
store.subscribe(render);
wire();
initPullToSync();
initSheetDrag();
initPriceSheetDrag();
render(store.state);                 // paint the cache immediately, before any network
if (store.state.settings.token) {
  checkToken();                      // "Connected as ..."; on success it kicks fullSync
}
startPolling();                      // no-ops each tick until there is a token

// dev-only: on the local server with no token, load a bundled recipes snapshot
// so the Recipes tab is browsable without GitHub. Never runs on the real site.
if (IS_LOCAL_DEV && !store.state.settings.token && store.state.recipes.length === 0) {
  fetch("recipes.dev.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((doc) => {
      // the snapshot is copied straight from kave-hub, where recipes.json is
      // the built document; older copies were the bare array
      const arr = Array.isArray(doc) ? doc : (doc && doc.recipes);
      if (Array.isArray(arr) && store.state.recipes.length === 0) {
        store.state.recipes = arr;
        store.notify();
      }
    })
    .catch(() => {});
}

// same idea, for price-series.json: a gitignored snapshot copied from
// kave-hub, since that file lives in the private repo like recipes.json does
if (IS_LOCAL_DEV && !store.state.settings.token
    && Object.keys(store.state.prices.products).length === 0) {
  fetch("price-series.dev.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((doc) => {
      if (doc && doc.products && Object.keys(store.state.prices.products).length === 0) {
        store.state.prices = { products: doc.products, resolve: doc.resolve || {} };
        store.notify();
      }
    })
    .catch(() => {});
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pollTick();  // catch up on becoming visible
});

// keep the Settings sync section live ("2 minutes ago" -> "3 minutes ago")
setInterval(() => {
  if (!document.hidden && store.state.view === "settings") renderSyncStatus();
}, 20000);
window.addEventListener("online", () => {
  flushQueue();
  pollTick();
});

/* ---------- PWA: service worker + update toast ---------- */
// never run the SW on the local dev server: it caches the shell and hides
// every edit behind a stale copy. Tear down any that a previous load left.
if ("serviceWorker" in navigator && IS_LOCAL_DEV) {
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
  if (window.caches) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k)));
}
if ("serviceWorker" in navigator && !IS_LOCAL_DEV) {
  // updateViaCache "none": always revalidate the worker script itself, so
  // Settings > Update can actually find a new version instead of being served
  // the old script out of the HTTP cache.
  navigator.serviceWorker
    .register("service-worker.js", { updateViaCache: "none" })
    .catch(() => {});
  // the first controllerchange is this session's initial takeover, not an update
  let firstControl = !navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (firstControl) { firstControl = false; return; }
    showTapBanner("New version. Tap to reload.", () => location.reload());
  });
}
