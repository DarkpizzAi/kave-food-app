/* Ladle: the per-tab pull gesture, and the sync status UI (snackbars, the
   offline card).

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { attachPullToRefresh, showSnackbar } from "../m3/kave-m3.js";
import { render } from "./render.js";
import { store } from "./store.js";
import { flushQueue, fullSync, joinManualSync, onSyncState, reportEnd, reportStart, setSyncing, syncFailed, syncList, syncPrices, syncRecipes, syncing } from "./sync.js";
import { $ } from "./util.js";

// pull-to-refresh on a tab: sync just that tab's data
async function syncCurrentTab() {
  if (syncing && store.state.settings.token) {
    const joined = joinManualSync(); // a sync is already running: this pull adopts it
    if (joined) return joined;
  }
  if (syncing || !store.state.settings.token) {
    return new Promise((r) => setTimeout(r, 400)); // still feel the gesture
  }
  setSyncing(true);
  reportStart(true);
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
    reportEnd();
  }
  render(store.state);
  flushQueue();
}

export function syncHeaderHeight() {
  const h = $(".app-header").offsetHeight;
  document.documentElement.style.setProperty("--header-h", h + "px");
}

const snack = (opts) => showSnackbar($("#snackHost"), opts);

/* The snackbar rule. Only a sync the person started (pull, Sync now) says
   anything about its own result: "Synced just now", or the failure with Retry.
   A background poll stays silent, with two exceptions that matter: going
   offline (said once per offline spell) and a failed push that leaves edits
   unsent. A manual sync that ends offline says the offline line again, since
   it is the answer to something the person just did. */
const OFFLINE_TEXT = "You're offline. Changes are saved on this phone.";
let offlineSaid = false;
let failSaid = false;   // the unsent-edits failure says itself once per spell

function sayOffline() {
  if (offlineSaid) return;
  offlineSaid = true;
  snack({ text: OFFLINE_TEXT, ms: 5000 });
}

function initStatus() {
  onSyncState((state, meta) => {
    if (state === "ok") {
      offlineSaid = false;
      failSaid = false;
      if (meta.manual) snack({ text: "Synced just now" });
    } else if (state === "offline") {
      if (meta.manual) { offlineSaid = true; snack({ text: OFFLINE_TEXT, ms: 5000 }); }
      else sayOffline();
    } else if (state === "failed" && (meta.manual || (meta.unsent && !failSaid))) {
      failSaid = true;
      snack({
        text: "Couldn't sync. Check the connection.", action: "Retry", ms: 6000,
        onAction: () => { fullSync({ manual: true }); },
      });
    }
  });
  window.addEventListener("offline", () => { sayOffline(); render(store.state); });
  window.addEventListener("online", () => { offlineSaid = false; render(store.state); });
  if (!navigator.onLine) sayOffline();
}

/* The kit's pull indicator wants an element scroller; Ladle scrolls the
   window. This stands in for it: it reads the window's scrollTop, parks the
   indicator in <body> under the header, and runs every touchstart and
   pointerdown through the same guards the old gesture had, so a pull never
   arms under a page, the drawer, a sheet or a search. */
function windowScroller() {
  const root = document.scrollingElement || document.documentElement;
  const canPull = () =>
    $("#page").hidden && $("#drawer").hidden
    && root.scrollTop <= 0 && $("#recipeDetail").hidden && $("#addPage").hidden
    && $("#searchPage").hidden && $("#insSheet").hidden
    && $("#recipeSearchPage").hidden;
  return {
    get scrollTop() { return root.scrollTop; },
    get parentElement() { return document.body; },
    get offsetTop() { return $(".app-header").offsetHeight; },
    setPointerCapture() { /* the document already sees the pointer */ },
    addEventListener(type, fn, opts) {
      const guarded = type === "touchstart" || type === "pointerdown";
      // one finger, and never from a form control or editable text
      const ok = (e) => (type !== "touchstart" || e.touches.length === 1)
        && !(e.target.closest && e.target.closest("input, textarea, select, [contenteditable]"));
      const h = guarded ? (e) => { if (canPull() && ok(e)) fn(e); } : fn;
      (fn.__h || (fn.__h = {}))[type] = h;
      document.addEventListener(type, h, opts);
    },
    removeEventListener(type, fn, opts) {
      document.removeEventListener(type, (fn.__h && fn.__h[type]) || fn, opts);
    },
  };
}

export function initPullToSync() {
  syncHeaderHeight(); // on resize too, from the one listener in wire()
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncHeaderHeight);
  initStatus();
  attachPullToRefresh(windowScroller(), syncCurrentTab);
}
