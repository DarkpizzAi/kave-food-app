/* Spoon: the sync engine and the background poll.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { github } from "../github.js";
import { render } from "./render.js";
import { setSyncState, store, syncState } from "./store.js";
import { $ } from "./util.js";
import { iconCache } from "./view-recipes.js";

// one sync at a time; every entry point checks these
export let syncing = false;
export let flushing = false;
let flushTimer;

const KNOWN_GH = ["offline", "unauthorized", "rateLimited", "notFound", "conflict"];

let rateLimitTimer;

// a sync attempt finished cleanly: clear any lingering error state
function syncOk() {
  if (syncState.kind !== "idle") {
    setSyncState({ kind: "idle", resetAt: null });
    render(store.state);
  }
}

// a sync attempt failed: turn the typed error into a banner state
export function syncFailed(e, where) {
  if (!e || !KNOWN_GH.includes(e.gh)) console.warn(`${where}:`, e);
  if (!e) return;
  if (e.gh === "offline") setSyncState({ kind: "offline", resetAt: null });
  else if (e.gh === "unauthorized") setSyncState({ kind: "unauthorized", resetAt: null });
  else if (e.gh === "rateLimited") {
    setSyncState({ kind: "rateLimited", resetAt: e.resetAt || null });
    clearTimeout(rateLimitTimer);
    const wait = Math.min(Math.max((e.resetAt || 0) - Date.now() + 2000, 5000), 180000);
    rateLimitTimer = setTimeout(() => {
      if (syncState.kind === "rateLimited") fullSync();
    }, wait);
  }
  // notFound / conflict / http: transient enough, leave syncState be
  render(store.state);
}

// apply the pending queue to a list of items, by id, in order
function replayOps(items, ops) {
  let out = items.map((it) => ({ ...it }));
  for (const op of ops) {
    if (op.t === "add") {
      if (!out.some((x) => x.id === op.id)) out.push(op.item);
    } else if (op.t === "check") {
      const it = out.find((x) => x.id === op.id);
      if (it) {
        it.checked = op.checked;
        // carry the touch to the remote copy, so the prune sees real use from
        // either phone, not just the one that happened to write last
        if (op.touchedAt) it.touchedAt = op.touchedAt;
      }
    } else if (op.t === "delete") {
      out = out.filter((x) => x.id !== op.id);
    }
  }
  return out;
}

function queueMessage(ops) {
  const who = store.state.settings.who || "?";
  const adds = ops.filter((o) => o.t === "add").length;
  const checks = ops.filter((o) => o.t === "check").length;
  const dels = ops.filter((o) => o.t === "delete").length;
  const bits = [];
  if (adds) bits.push(`+${adds}`);
  if (checks) bits.push(`~${checks}`);
  if (dels) bits.push(`-${dels}`);
  return `list ${bits.join(" ")} (${who})`;
}

/* 5s, not 800ms. Every push is a ~106 KB GET plus a ~141 KB base64 PUT of the
   whole list, so a debounce shorter than the gap between two ticks means one
   full round trip per ticked item - a 15-item shop was ~3.5 MB. At 5s a run of
   ticks coalesces into one write and the other phone is still under ~6s
   behind. The queue survives backgrounding, so nothing is at risk in the gap. */
const FLUSH_DEBOUNCE_MS = 5000;

export function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushQueue, FLUSH_DEBOUNCE_MS);
}

// push pending list changes to GitHub: GET -> replay -> PUT, retry on 409
export async function flushQueue() {
  // An attempt that lands mid-flush is not dropped: the finally below
  // reschedules whenever the queue is still non-empty after a good push.
  if (flushing || !store.state.settings.token || store.queue.length === 0) return;
  flushing = true;
  let pushed = false;
  let contended = false;
  render(store.state); // spinner on
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ops = store.queue.slice();
      const flushedIds = new Set(ops.map((o) => o.opId));
      const remote = await github.getFile(github.config.listPath);
      // This GET is deliberately unconditional, so a 304 is impossible. Fail
      // loudly rather than treating "unchanged" as "empty": the line below
      // used to fall back to [], which would have committed an empty list
      // over the real one the moment anyone passed an etag in here.
      if (remote.notModified) throw new Error("unconditional list GET returned 304");
      const base = remote.json.items || [];
      const merged = replayOps(base, ops);
      const doc = {
        version: 1,
        updated: new Date().toISOString(),
        updatedBy: store.state.settings.who || null,
        items: merged,
      };
      try {
        const put = await github.putFile(github.config.listPath, doc, remote.sha, queueMessage(ops));
        store.queue = store.queue.filter((o) => !flushedIds.has(o.opId));
        store.saveQueue();
        store.sync.listSha = put.sha;
        store.sync.listEtag = null;      // sha moved; next GET is unconditional
        store.sync.syncedAt = new Date().toISOString();
        store.state.list = replayOps(merged, store.queue); // + any ops that landed mid-flush
        store.saveList();
        store.saveSync();
        pushed = true;
        syncOk();
        store.notify();
        return;
      } catch (e) {
        if (e.gh === "conflict") continue; // sha moved: re-GET, re-replay
        throw e;
      }
    }
    // three 409s running: the other phone is writing at the same moment. Keep
    // the queue and back off, rather than spinning through another three.
    contended = true;
    console.warn("flushQueue: gave up after 3 conflicts, will retry");
  } catch (e) {
    syncFailed(e, "flushQueue"); // offline / rateLimited / unauthorized: keep the queue
  } finally {
    flushing = false;
    render(store.state); // repaint with the flag cleared
    // Ops enqueued while this flush was in flight were skipped by the guard at
    // the top - pick them up now. Only after a good push: a failed flush leaves
    // the queue for the online / rate-limit / next-edit paths, so that an
    // offline phone does not spin.
    if (pushed && store.queue.length) scheduleFlush();
    else if (contended) setTimeout(flushQueue, 8000);
  }
}

export async function syncRecipes() {
  const r = await github.getFile(github.config.recipesPath, { etag: store.sync.recipesEtag });
  if (r.notModified) return;
  store.state.recipes = r.json.recipes || [];
  iconCache.clear(); // names / categories may have moved under the cached art
  store.sync.recipesSha = r.sha;
  store.sync.recipesEtag = r.etag;
  store.saveRecipes();
  store.saveSync();
}

export async function syncPrices() {
  const r = await github.getFile(github.config.pricesPath, { etag: store.sync.pricesEtag });
  if (r.notModified) return;
  const doc = r.json || {};
  store.state.prices = { products: doc.products || {}, resolve: doc.resolve || {} };
  store.sync.pricesSha = r.sha;
  store.sync.pricesEtag = r.etag;
  store.savePrices();
  store.saveSync();
}

export async function syncList() {
  const r = await github.getFile(github.config.listPath, { etag: store.sync.listEtag });
  const now = new Date().toISOString();
  if (r.notModified) {
    store.sync.syncedAt = now;
    store.saveSync();
    syncOk();
    return;
  }
  // merge: remote is authoritative; re-apply pending local ops on top
  store.state.list = replayOps(r.json.items || [], store.queue);
  store.sync.listSha = r.sha;
  store.sync.listEtag = r.etag;
  store.sync.syncedAt = now;
  store.saveList();
  store.saveSync();
  syncOk();
  store.notify();
}

// full read: recipes + list, then push anything pending
export async function fullSync() {
  if (syncing || !store.state.settings.token) return;
  syncing = true;
  render(store.state); // spinner on
  try {
    try {
      await syncRecipes();
      await syncList();
    } catch (e) {
      syncFailed(e, "fullSync");
    }
    // its own try/catch: a missing or unreachable price-series.json (a brand
    // new file, easy to not have landed yet) must never block the list or
    // recipes sync, or degrade the sync-status dot for something optional
    try {
      await syncPrices();
    } catch (e) {
      console.warn("syncPrices failed, Prices tab stays on cached/empty data:", e);
    }
  } finally {
    // Whatever happened above, the latch comes off. syncFailed renders, and a
    // throw out of a render would strand it - see syncCurrentTab.
    syncing = false;
    lastSlowSync = Date.now(); // it just fetched all three; don't repeat in a minute
    render(store.state);
  }
  flushQueue();
}

/* ---------- background poll (Task 6d) ---------- */

let pollTimer = null;
let pollSecs = 0;

// The poll used to run only on the List and Plan tabs, on the reasoning that
// fetching data for a tab you cannot see is waste. It is not: every sync is a
// conditional GET carrying an ETag, and a 304 costs a header exchange and is
// not charged against GitHub's hourly limit. So the tab condition bought
// almost nothing and cost real bugs - Prices refreshed on nothing at all, and
// Plan fetched the list it does not render. The poll is now tab-independent
// and each tab is at most one interval stale, whichever one you are on.
//
// Two lanes, because the three files do not move at the same speed. The
// shopping list is the only one edited by two people at once - Hugo ticking
// something off while Isa is in the shop - so it rides every tick. Recipes
// change when one of us writes one and price-series.json when the weekly
// rebuild runs, so a minute's freshness there would be over-serving by orders
// of magnitude, and they are the big payloads when they do change (about 55 KB
// and 107 KB against the list's few). They ride the slow lane instead.
const SLOW_SYNC_MS = 10 * 60 * 1000;
let lastSlowSync = 0;

// Time-based rather than a tick count, because pollTick is also called
// directly - on becoming visible again, and on coming back online - and those
// must not shift the slow lane's cadence or skip it after a long sleep.
export async function pollTick() {
  if (document.hidden || !store.state.settings.token) return;
  if (syncing || flushing) return;
  const slow = Date.now() - lastSlowSync >= SLOW_SYNC_MS;
  // Set when the slow lane is actually entered, not when it is merely due. If
  // syncList throws first - offline, rate limited - the slow lane never ran,
  // and stamping it anyway would push recipes and prices out another ten
  // minutes over a failure that had nothing to do with them.
  let slowRan = false;
  syncing = true;
  // The outer try exists for its finally: syncFailed and render both run
  // arbitrary render code, and a throw out of either would otherwise latch
  // `syncing` true for the rest of the session - every later sync then returns
  // at its own guard and the app goes quietly stale with no error to show.
  try {
    try {
      await syncList();
      if (slow) {
        slowRan = true;
        await syncRecipes();
      }
    } catch (e) {
      syncFailed(e, "poll");
    }
    // Prices in its own try/catch, for the reason fullSync gives: an absent or
    // unreachable price-series.json is an ordinary state for an optional file
    // and must not turn the sync dot red.
    if (slowRan) {
      try {
        await syncPrices();
      } catch (e) {
        console.warn("syncPrices failed in poll, Prices stays on cached data:", e);
      }
      lastSlowSync = Date.now();
    }
  } finally {
    syncing = false;
  }
  render(store.state);
  startPolling(); // GitHub may have asked for a slower cadence just now
}

// Idempotent, and re-runnable: github.pollInterval moves whenever GitHub sends
// an X-Poll-Interval header, so re-arm the timer when the rate has changed.
// Reading it once at boot meant the header was recorded and then ignored.
export function startPolling() {
  const secs = Math.max(60, Number(github.pollInterval) || 60);
  if (pollTimer && secs === pollSecs) return;
  clearInterval(pollTimer);
  pollSecs = secs;
  pollTimer = setInterval(pollTick, secs * 1000);
}

// "14:32" from an ISO string or epoch ms
export function hhmm(t) {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// relative time for the "last synced" line
export function timeAgo(iso) {
  if (!iso) return null;
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 90) return "a minute ago";
  if (s < 3600) return Math.round(s / 60) + " minutes ago";
  if (s < 5400) return "an hour ago";
  if (s < 86400) return Math.round(s / 3600) + " hours ago";
  if (s < 172800) return "yesterday";
  return Math.round(s / 86400) + " days ago";
}

/* Always clears the tap affordance. The update banner installs an onclick that
   reloads the app; without this reset the next plain message ("3 lines cleaned
   up") inherited it, and tapping it reloaded the app. */
function showBanner(msg) {
  const b = $("#banner");
  b.textContent = msg;
  b.classList.remove("banner-tap");
  b.onclick = null;
  b.hidden = false;
}

// a banner that is meant to be tapped
export function showTapBanner(msg, onTap) {
  showBanner(msg);
  const b = $("#banner");
  b.classList.add("banner-tap");
  b.onclick = onTap;
}

let flashTimer;
export function flashBanner(msg) {
  showBanner(msg);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $("#banner").hidden = true; }, 3500);
}

/* An imported binding is read-only, so a module that does not declare
   one of these cannot assign to it. These are the writes that used to
   happen across what was a single shared scope. */
export function setSyncing(v) { syncing = v; }
