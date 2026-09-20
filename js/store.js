/* Spoon: persisted state, and the only thing render() reads.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { github } from "../github.js";
import { closePriceDetail, parkPriceDetail, priceDetailState, unparkPriceDetail } from "./sheet-price.js";
import { closeRecipe, detailState, parkRecipe, setTabHasHistory, tabHasHistory, unparkRecipe } from "./sheet-recipe.js";
import { scheduleFlush } from "./sync.js";
import { CUSTOM_TOKENS, HEX_RE, PALETTES, applyCustomForTheme, applyPalette, normaliseCustom, seedCustom, syncColorScheme } from "./theme.js";
import { uid } from "./util.js";
import { setCustomGridBuilt } from "./view-settings.js";

const LS_LIST = "foodapp.list";        // the shopping list, optimistic working copy
const LS_SETTINGS = "foodapp.settings";
const LS_RECIPES = "foodapp.recipes";  // last-synced recipes (offline cache)
const LS_PRICES = "foodapp.prices";    // last-synced price-series.json (offline cache)
const LS_SYNC = "foodapp.sync";        // { listSha, listEtag, recipesSha, recipesEtag, pricesSha, pricesEtag, syncedAt }
const LS_QUEUE = "foodapp.queue";      // pending list changes not yet pushed to GitHub

// Declared here, not down with the service-worker block: render() runs during
// init and can reach Settings > Update, which reads this. A const further down
// the file is still in its temporal dead zone at that point.
export const IS_LOCAL_DEV = ["localhost", "127.0.0.1"].includes(location.hostname);

export const store = {
  state: {
    view: "list",
    list: [],
    settings: { token: "", who: "", theme: "system", palette: "cobalt", custom: null },
    recipes: [],
    // {products: {key: {l1,l1_label,l2,label,series}}, resolve: {name: {level,l1,l1_label,l2?}}}
    // - see build_price_series.py in kave-hub for exactly what these mean
    prices: { products: {}, resolve: {} },
  },
  sync: {
    listSha: null, listEtag: null, recipesSha: null, recipesEtag: null,
    pricesSha: null, pricesEtag: null, syncedAt: null,
  },
  queue: [],  // [{ opId, t: "add"|"check"|"delete", id, ts, ... }]
  subs: [],
  subscribe(fn) { this.subs.push(fn); },
  notify() { this.subs.forEach((fn) => fn(this.state)); },
  load() {
    try {
      const l = JSON.parse(localStorage.getItem(LS_LIST));
      if (Array.isArray(l)) this.state.list = l;
    } catch (e) { /* ignore corrupt cache */ }
    try {
      const q = JSON.parse(localStorage.getItem(LS_QUEUE));
      if (Array.isArray(q)) this.queue = q;
    } catch (e) { /* ignore */ }
    try {
      const r = JSON.parse(localStorage.getItem(LS_RECIPES));
      if (Array.isArray(r)) this.state.recipes = r;
    } catch (e) { /* ignore */ }
    try {
      const p = JSON.parse(localStorage.getItem(LS_PRICES));
      if (p && typeof p === "object" && p.products) this.state.prices = p;
    } catch (e) { /* ignore */ }
    try {
      const y = JSON.parse(localStorage.getItem(LS_SYNC));
      if (y && typeof y === "object") this.sync = { ...this.sync, ...y };
    } catch (e) { /* ignore */ }
    try {
      const s = JSON.parse(localStorage.getItem(LS_SETTINGS));
      if (s && typeof s === "object") {
        this.state.settings = {
          token: s.token || "",
          who: s.who || "",
          theme: "system",  // no longer a choice; see setPalette/applyTheme
          palette: PALETTES[s.palette] ? s.palette : "cobalt",
          custom: normaliseCustom(s.custom),
        };
      }
    } catch (e) { /* ignore */ }
    this.state.view = "list"; // always open on the list
  },
  saveList() {
    try { localStorage.setItem(LS_LIST, JSON.stringify(this.state.list)); }
    catch (e) { /* private mode, ignore */ }
  },
  saveRecipes() {
    try { localStorage.setItem(LS_RECIPES, JSON.stringify(this.state.recipes)); }
    catch (e) { /* ignore */ }
  },
  savePrices() {
    try { localStorage.setItem(LS_PRICES, JSON.stringify(this.state.prices)); }
    catch (e) { /* ignore */ }
  },
  saveSync() {
    try { localStorage.setItem(LS_SYNC, JSON.stringify(this.sync)); }
    catch (e) { /* ignore */ }
  },
  saveQueue() {
    try { localStorage.setItem(LS_QUEUE, JSON.stringify(this.queue)); }
    catch (e) { /* ignore */ }
  },
  // record a pending change and try to push it (no-op without a token)
  enqueue(op) {
    op.opId = uid();
    op.ts = new Date().toISOString();
    this.queue.push(op);
    this.saveQueue();
    scheduleFlush();
  },
  saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(this.state.settings)); }
    catch (e) { /* ignore */ }
  },
  hasCache() {
    return localStorage.getItem(LS_SYNC) != null;
  },
  // read-only when there is no usable token (missing or rejected) and we have
  // a synced copy to show - don't let local edits diverge with no way to push
  readOnly() {
    const usable = this.state.settings.token && syncState.kind !== "unauthorized";
    return !usable && this.hasCache();
  },

  /* mutations */
  setView(v) {
    // The List is home. Leaving it pushes one history entry, so the phone's
    // back gesture comes back here from any other tab instead of closing the
    // app. Exactly one entry ever exists: hopping between two non-home tabs
    // does not push another, so back is always a single press from home, and
    // tapping List does not pop it (that would race an open sheet's own entry
    // - see the popstate handler).
    if (v !== "list" && this.state.view === "list" && !tabHasHistory) {
      try {
        history.pushState({ tabAway: true }, "");
        setTabHasHistory(true);
      } catch (e) {
        setTabHasHistory(false);
      }
    }
    const sheetOpen = detailState != null;
    const priceSheetOpen = priceDetailState != null;
    // The recipe sheet can be opened from more than one tab (Recipes, and the
    // Plan tab's recipe-facing sections), so the tab it belongs to is whichever
    // one it was opened from - detailState.owner, set in openRecipe. Comparing
    // against a hardcoded "recipes" would strand a sheet opened from Plan: the
    // Recipes tab would adopt it, and Plan would not park it on the way out.
    const owner = sheetOpen ? detailState.owner : null;
    // tapping the owning tab again while its own sheet is up closes that sheet
    if (sheetOpen && v === owner && this.state.view === owner) {
      closeRecipe();
      return;
    }
    if (priceSheetOpen && v === "prices" && this.state.view === "prices") {
      closePriceDetail();
      return;
    }
    // leaving a tab with its sheet open: stash it, no swoop-down
    if (sheetOpen && v !== owner) parkRecipe();
    if (priceSheetOpen && v !== "prices") parkPriceDetail();
    this.state.view = v;
    this.notify();
    // coming back: bring the stashed sheet straight back
    if (sheetOpen && v === owner) unparkRecipe();
    if (priceSheetOpen && v === "prices") unparkPriceDetail();
  },
  addItem({ name, qty, unit, note, source = "manual", slug = null, variant = null }) {
    if (this.readOnly()) return null;
    const item = {
      id: uid(),
      name: name.trim(),
      qty: qty === "" || qty == null ? null : Number(qty),
      unit: (unit || "").trim() || null,
      note: (note || "").trim() || null,
      slug: slug || null,     // ingredients-dictionary concept, when added from a recipe
      // the variant that concept was asked for, from the shared vocabulary -
      // set only when the row came from a recipe that names one, so the price
      // hint can point at the variant instead of the whole card
      variant: variant || null,
      checked: false,
      source,
      addedBy: this.state.settings.who || "?",
      addedAt: new Date().toISOString(),
      // Last time this row was actually used - ticked or un-ticked while
      // shopping. addedAt cannot stand in for it: every seed row carries the
      // bootstrap date, so it says when the catalogue was built, not whether
      // anyone has bought the thing since. food/tools/prune_shopping_list.py
      // reads it (falling back to addedAt) to retire rows nobody touches.
      touchedAt: new Date().toISOString(),
    };
    this.state.list.push(item);
    this.enqueue({ t: "add", id: item.id, item: { ...item } });
    this.saveList(); this.notify();
    return item;
  },
  toggleItem(id) {
    if (this.readOnly()) return;
    const it = this.state.list.find((x) => x.id === id);
    if (it) {
      it.checked = !it.checked;
      it.touchedAt = new Date().toISOString();
      this.enqueue({ t: "check", id, checked: it.checked, touchedAt: it.touchedAt });
      this.saveList(); this.notify();
    }
  },
  uncheckItem(id) {
    if (this.readOnly()) return;
    const it = this.state.list.find((x) => x.id === id);
    if (it && it.checked) {
      it.checked = false;
      it.touchedAt = new Date().toISOString();
      this.enqueue({ t: "check", id, checked: false, touchedAt: it.touchedAt });
      this.saveList(); this.notify();
    }
  },
  deleteItem(id) {
    if (this.readOnly()) return;
    this.state.list = this.state.list.filter((x) => x.id !== id);
    this.enqueue({ t: "delete", id });
    this.saveList(); this.notify();
  },
  clearChecked() {
    if (this.readOnly()) return;
    const gone = this.state.list.filter((x) => x.checked);
    this.state.list = this.state.list.filter((x) => !x.checked);
    gone.forEach((it) => this.enqueue({ t: "delete", id: it.id }));
    this.saveList(); this.notify();
  },
  removeMany(ids) {
    if (this.readOnly()) return;
    const set = new Set(ids);
    this.state.list = this.state.list.filter((x) => !set.has(x.id));
    ids.forEach((id) => this.enqueue({ t: "delete", id }));
    this.saveList(); this.notify();
  },
  setWho(who) { this.state.settings.who = who; this.saveSettings(); this.notify(); },
  setToken(token) {
    this.state.settings.token = token;
    this.saveSettings();
    if (typeof github !== "undefined") github.setToken(token);
    this.notify();
  },
  setPalette(palette) {
    if (!PALETTES[palette]) return;
    // entering Custom always copies the theme that was on screen a moment ago,
    // both its light and dark sets, so the editor starts from the last look
    if (palette === "custom" && this.state.settings.palette !== "custom") {
      this.state.settings.custom = seedCustom();
      setCustomGridBuilt(false);
    }
    this.state.settings.palette = palette;
    this.saveSettings();
    applyPalette(palette);
    this.notify();
  },
  setCustomToken(mode, token, value) {
    if ((mode !== "light" && mode !== "dark") ||
        !CUSTOM_TOKENS.includes(token) || !HEX_RE.test(value)) return;
    const c = this.state.settings.custom || (this.state.settings.custom = seedCustom());
    (c[mode] || (c[mode] = {}))[token] = value;
    this.saveSettings();
    if (this.state.settings.palette === "custom") {
      applyCustomForTheme();
      syncColorScheme();
    }
  },
};

// live sync status (not persisted). kind: idle | offline | unauthorized | rateLimited
export let syncState = { kind: "idle", resetAt: null };

/* An imported binding is read-only, so a module that does not declare
   one of these cannot assign to it. These are the writes that used to
   happen across what was a single shared scope. */
export function setSyncState(v) { syncState = v; }
