/* Spoon. Phase 2: offline-first cache of the shared list + recipes, kept
   in sync with a private GitHub repo. */
"use strict";

/* ---------- store ---------- */

const LS_LIST = "foodapp.list";        // the shopping list, optimistic working copy
const LS_SETTINGS = "foodapp.settings";
const LS_RECIPES = "foodapp.recipes";  // last-synced recipes (offline cache)
const LS_PRICES = "foodapp.prices";    // last-synced price-series.json (offline cache)
const LS_SYNC = "foodapp.sync";        // { listSha, listEtag, recipesSha, recipesEtag, pricesSha, pricesEtag, syncedAt }
const LS_QUEUE = "foodapp.queue";      // pending list changes not yet pushed to GitHub

// Declared here, not down with the service-worker block: render() runs during
// init and can reach Settings > Update, which reads this. A const further down
// the file is still in its temporal dead zone at that point.
const IS_LOCAL_DEV = ["localhost", "127.0.0.1"].includes(location.hostname);

const store = {
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
    const sheetOpen = detailState != null;
    const priceSheetOpen = priceDetailState != null;
    // tapping Recipes/Prices again while its own sheet is up closes that sheet
    if (sheetOpen && v === "recipes" && this.state.view === "recipes") {
      closeRecipe();
      return;
    }
    if (priceSheetOpen && v === "prices" && this.state.view === "prices") {
      closePriceDetail();
      return;
    }
    // leaving a tab with its sheet open: stash it, no swoop-down
    if (sheetOpen && v !== "recipes") parkRecipe();
    if (priceSheetOpen && v !== "prices") parkPriceDetail();
    this.state.view = v;
    this.notify();
    // coming back: bring the stashed sheet straight back
    if (sheetOpen && v === "recipes") unparkRecipe();
    if (priceSheetOpen && v === "prices") unparkPriceDetail();
  },
  addItem({ name, qty, unit, note, source = "manual", slug = null }) {
    if (this.readOnly()) return null;
    const item = {
      id: uid(),
      name: name.trim(),
      qty: qty === "" || qty == null ? null : Number(qty),
      unit: (unit || "").trim() || null,
      note: (note || "").trim() || null,
      slug: slug || null,     // ingredients-dictionary concept, when added from a recipe
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
      customGridBuilt = false;
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
let syncState = { kind: "idle", resetAt: null };

/* ---------- helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* Memoised: renderSuggestions deburrs every item name on every keystroke, and
   the recipe sort deburrs every card on every render. NFD-normalising 400+
   strings per keypress was measurable on a phone. Bounded, because search
   typing feeds it a fresh string each time. */
const deburrCache = new Map();
const deburr = (s) => {
  if (!s) return "";
  let v = deburrCache.get(s);
  if (v === undefined) {
    v = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    if (deburrCache.size < 4000) deburrCache.set(s, v);
  }
  return v;
};

const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());

/* palette id -> display name. The full token sets live in styles.css,
   keyed by [data-palette]; the browser-chrome colour is read from the
   resolved --surface (the app header's background) so they never drift. */
const PALETTES = {
  cobalt:     { name: "Cobalt"     },
  amber:      { name: "Amber"      },
  chartreuse: { name: "Chartreuse" },
  lime:       { name: "Lime"       },
  tangerine:  { name: "Tangerine"  },
  volt:       { name: "Volt"       },
  custom:     { name: "Custom"     },
};

/* every themeable token, in the order shown in the custom editor */
const CUSTOM_TOKENS = [
  "--bg", "--surface", "--surface-2", "--card", "--text", "--text-dim",
  "--accent", "--accent-text", "--accent-soft",
  "--border", "--rule", "--rule-strong", "--danger",
];
const TOKEN_LABELS = {
  "--bg": "Background", "--surface": "Surface", "--surface-2": "Surface (raised)",
  "--card": "Card", "--text": "Text", "--text-dim": "Text (dim)", "--accent": "Accent",
  "--accent-text": "Text on accent", "--accent-soft": "Accent (soft)",
  "--border": "Border", "--rule": "Rule", "--rule-strong": "Rule (strong)",
  "--danger": "Danger",
};

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function resolvedDark() {
  const theme = store.state.settings.theme || "system";
  return theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/* Read the tokens a given palette resolves to in one theme, as hex. Forces
   data-theme for the read, then restores it. Custom inline overrides are
   stripped first so we sample the stylesheet, not our own edits. */
function readTokensFor(themeMode) {
  const root = document.documentElement;
  const prevTheme = root.getAttribute("data-theme");
  const prevInline = {};
  CUSTOM_TOKENS.forEach((t) => {
    prevInline[t] = root.style.getPropertyValue(t);
    root.style.removeProperty(t);
  });
  root.setAttribute("data-theme", themeMode);
  const cs = getComputedStyle(root);
  const o = {};
  CUSTOM_TOKENS.forEach((t) => { o[t] = (cs.getPropertyValue(t).trim() || "#000000"); });
  if (prevTheme === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", prevTheme);
  CUSTOM_TOKENS.forEach((t) => { if (prevInline[t]) root.style.setProperty(t, prevInline[t]); });
  return o;
}

/* a fresh custom set: { light, dark } seeded from the palette on screen now */
function seedCustom() {
  return { light: readTokensFor("light"), dark: readTokensFor("dark") };
}

/* accept { light, dark }; migrate a legacy flat set; null if unusable */
function normaliseCustom(c) {
  if (!c || typeof c !== "object") return null;
  if (c.light || c.dark) return { light: c.light || c.dark || {}, dark: c.dark || c.light || {} };
  return { light: { ...c }, dark: { ...c } }; // legacy single set
}

/* push the right custom set (light or dark) onto <html> as inline overrides */
function applyCustomForTheme() {
  const root = document.documentElement;
  const c = store.state.settings.custom;
  const set = c && (resolvedDark() ? (c.dark || c.light) : (c.light || c.dark));
  CUSTOM_TOKENS.forEach((t) => {
    if (set && HEX_RE.test(set[t] || "")) root.style.setProperty(t, set[t]);
    else root.style.removeProperty(t);
  });
}

/* Tell the browser which way the page is leaning. This is what darkens the
   Android gesture bar at the bottom; the status bar at the top is the phone's
   own and takes no instruction from us. */
function syncColorScheme() {
  document.documentElement.style.colorScheme = darkNow() ? "dark" : "light";
}

/* Light or dark is the phone's call and only the phone's: an installed PWA
   cannot colour the status and gesture bars, it only gets the light or dark
   pair the system chose. Following that setting exactly is what lets --bg
   (pure white or pure black) meet those bars without a seam. */
function darkNow() {
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  if (store.state.settings.palette === "custom") applyCustomForTheme();
  syncColorScheme();
}

function applyPalette(palette) {
  const root = document.documentElement;
  // drop any custom inline overrides from a previous selection
  CUSTOM_TOKENS.forEach((t) => root.style.removeProperty(t));
  if (palette === "custom") {
    root.setAttribute("data-palette", "custom");
    applyCustomForTheme();
  } else if (palette && palette !== "cobalt") {
    root.setAttribute("data-palette", palette);
  } else {
    root.removeAttribute("data-palette");
  }
  syncColorScheme();
}

const VIEW_TITLES = {
  list: "Shopping List",
  prices: "Price tracking",
  recipes: "Recipe book",
  planner: "Meal Planner",
  settings: "Settings",
};

/* ---------- prices ---------- */
/* Data is store.state.prices, synced from food/data/price-series.json in
   kave-hub (build_price_series.py). Everything below reads it live off
   store.state, never a cached snapshot, so a background sync updates the
   Prices tab the same way a list sync updates the list. See that script's
   docstring for exactly what "products" and "resolve" mean and why. */

// fixed roster (v10 spec): a store outside this list renders greyscale, never
// a made-up colour. Ametller needs a theme-aware pair, so it is read from a
// CSS custom property instead of a literal hex.
const STORE_COLORS = {
  "Keisy": "#F27D16",
  "Mercadona": "#289148",
  "Condis": "#2EA684",
  "Carrefour": "#0E5299",
  "Alcampo": "#D92929",
};
function storeColor(store) {
  if (store === "Ametller Origen") return "var(--store-ametller)";
  return STORE_COLORS[store] || "var(--text-dim)";
}
// lines that aren't a supermarket (Group by = Product: one line per variant or
// product) have no established colour of their own - Isa's store colours must
// not move, so product lines get their own fixed rotating palette, assigned by
// the line's sorted position so it's stable across renders.
const LINE_PALETTE = [
  "#2563EB", "#16A34A", "#DB2777", "#D97706",
  "#7C3AED", "#0891B2", "#DC2626", "#4D7C0F",
];
function lineColor(i) { return LINE_PALETTE[i % LINE_PALETTE.length]; }
// the icon drawn on top of a store-coloured bubble: white everywhere except
// Ametller, whose pair goes light in dark mode and would vanish under white
function storeOnColor(store) {
  return store === "Ametller Origen" ? "var(--store-ametller-on)" : "#fff";
}

function priceKeyFor(name) {
  return stripQty(name);
}

// the resolve index is keyed the same way build_price_series.py's
// normalise() builds it: deburred, lowercased, elision and punctuation
// stripped. The 3-way suffix try below (as typed / "es"->"a" / trailing "s"
// dropped) mirrors link_shopping_list.py's match() exactly, on purpose - one
// algorithm, two languages, so the two never drift apart. Deliberately NOT
// the fuller stopword/singularisation machinery those Python tools use for
// bulk, unsupervised matching: this is one word, tapped live, and a miss
// just means no hint (never a guess) rather than needing that much power.
function normaliseForResolve(name) {
  return deburr(name || "")
    .toLowerCase()
    .replace(/\b[dl]'/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function resolveInIndex(name) {
  const resolve = store.state.prices.resolve;
  const n = normaliseForResolve(name);
  if (!n) return null;
  for (const cand of [n, n.replace(/es$/, "a"), n.replace(/s$/, "")]) {
    if (cand && resolve[cand]) return resolve[cand];
  }
  return null;
}

// what a typed name (a list item, a recipe ingredient) resolves to: the
// exact product if it matches one (someone typed the full product name), else
// the variant it names, else the card it names, else nothing - never guessed.
function resolvePriceTarget(name) {
  const exactKey = priceKeyFor(name);
  // product keys are deburred AND lowercased; stripQty only deburrs, so a
  // list item with any capital ("Plàtano América") never matched a
  // product and fell back to the L1/L2 index. Match case-insensitively.
  for (const cand of [exactKey, exactKey.toLowerCase()]) {
    if (store.state.prices.products[cand]) return { level: "l3", key: cand };
  }
  const hit = resolveInIndex(name);
  if (!hit) return null;
  return hit.level === "l2"
    ? { level: "l2", l1: hit.l1, l1_label: hit.l1_label, l2: hit.l2 }
    : { level: "l1", l1: hit.l1, l1_label: hit.l1_label };
}

// every point from every product sharing this l1 (and l2, if given) - Isa's
// call on the L1/L2 chart (v10 follow-up): pool every product under a card
// or variant into one line per store, same as the very first sketch of this
// feature. Deliberately re-mixes what the product-level key (spec §2) keeps
// apart at L3 - flagged and confirmed, not a silent regression.
function pooledSeries(l1, l2) {
  const out = [];
  for (const entry of Object.values(store.state.prices.products)) {
    if (entry.l1 !== l1) continue;
    if (l2 != null && entry.l2 !== l2) continue;
    out.push(...entry.series);
  }
  return out;
}

// like pooledSeries, but every point is tagged with the product it came from
// (key, label, variant) so the chart can draw one line per variant or product
// when Group by = Product, not just one line per store.
function scopedPoints(target) {
  if (!target) return [];
  if (target.level === "l3") {
    const entry = store.state.prices.products[target.key];
    if (!entry) return [];
    return entry.series.map((p) =>
      ({ ...p, prodKey: target.key, prodLabel: entry.label, variant: entry.l2 }));
  }
  const out = [];
  for (const [key, entry] of Object.entries(store.state.prices.products)) {
    if (entry.l1 !== target.l1) continue;
    if (target.level === "l2" && entry.l2 !== target.l2) continue;
    for (const p of entry.series) {
      out.push({ ...p, prodKey: key, prodLabel: entry.label, variant: entry.l2 });
    }
  }
  return out;
}

// display helpers for the three Product pills and the variant legend: the raw
// l2 strings are lowercased in the data ("platano", "creme de cuisine 18%")
function titleCaseVariant(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
// distinct L1 cards that have any product with a series, sorted by label
function l1Options() {
  const seen = new Map();
  for (const e of Object.values(store.state.prices.products)) {
    if (!seen.has(e.l1)) seen.set(e.l1, e.l1_label);
  }
  return [...seen].map(([l1, label]) => ({ l1, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
// distinct variants under one L1 (null variants excluded), sorted
function l2Options(l1) {
  const seen = new Set();
  for (const e of Object.values(store.state.prices.products)) {
    if (e.l1 === l1 && e.l2) seen.add(e.l2);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
// products under one L1 (and one variant, if given), sorted by label
function l3Options(l1, l2) {
  const out = [];
  for (const [key, e] of Object.entries(store.state.prices.products)) {
    if (e.l1 !== l1) continue;
    if (l2 != null && e.l2 !== l2) continue;
    out.push({ key, label: e.label });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// the L1's one variant, when that variant IS the whole card - null if the card
// has several variants, none, or any product sitting outside a variant (then
// the card is genuinely wider than the variant and pooling them differs).
// The single predicate behind both narrowing and the Variant pill, so the pill
// can never claim a variant the chart is not actually filtered to.
function soleVariant(l1) {
  const variants = l2Options(l1);
  if (variants.length !== 1) return null;
  const bare = Object.values(store.state.prices.products)
    .some((e) => e.l1 === l1 && !e.l2);
  return bare ? null : variants[0];
}

// drill a target down past any level that offers only one choice: picking an
// L1 with a single product lands straight on that product, so its Variant and
// Product pills show the forced value (coloured in) with no dropdown.
function narrowPriceTarget(target) {
  if (!target || target.level === "l3") return target;
  const products = l3Options(target.l1, target.level === "l2" ? target.l2 : null);
  if (products.length === 1) return { level: "l3", key: products[0].key };
  if (target.level === "l1") {
    const only = soleVariant(target.l1);
    if (only) {
      return narrowPriceTarget({
        level: "l2", l1: target.l1, l1_label: target.l1_label, l2: only,
      });
    }
  }
  return target;
}

// the series array for whatever pricesUiState currently points at - the one
// place that knows how to turn {level, l1, l2, key} into actual points, so
// nothing else has to branch on level.
function seriesForTarget(target) {
  if (!target) return [];
  if (target.level === "l3") {
    const entry = store.state.prices.products[target.key];
    return entry ? entry.series : [];
  }
  return pooledSeries(target.l1, target.level === "l2" ? target.l2 : null);
}

// everything the Trends card and the price sheet both need to display for
// the current target: the breadcrumb strings and the points. One place
// that knows how l3 (a single product) differs from a pooled l1/l2 view,
// so the two renderers can never disagree about it.
function resolveTargetInfo(target) {
  if (!target) return null;
  const series = scopedPoints(target);
  if (target.level === "l3") {
    const entry = store.state.prices.products[target.key];
    if (!entry) return null;
    return { l1: entry.l1, l1_label: entry.l1_label, l2: entry.l2, label: entry.label, series };
  }
  return {
    l1: target.l1, l1_label: target.l1_label,
    l2: target.level === "l2" ? target.l2 : null,
    label: null, series,
  };
}

// one point per date across every store, its median - a single overall
// trend line, deliberately pooling stores rather than one line each (that
// finer view is what the Trends chart is for). Only for a trend statistic:
// bestPriceInPeriod does NOT go through this, because a median can hide the
// one genuinely cheap line among several bought the same day.
function dailyPoints(series) {
  const byDate = new Map();
  series.forEach((p) => {
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date).push(p);
  });
  return [...byDate.entries()]
    .map(([date, pts]) => {
      const nonPromo = pts.filter((p) => !p.promo);
      const use = nonPromo.length ? nonPromo : pts;
      const sorted = use.map((p) => p.price).sort((a, b) => a - b);
      return { date, price: sorted[Math.floor(sorted.length / 2)], promo: pts.every((p) => p.promo) };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

// "today" for the 6-month window: the most recent date this device has
// actually seen a price for. Live, not a constant - before the first sync
// there is no data at all, and a background sync can extend it later.
function priceToday() {
  let latest = null;
  for (const entry of Object.values(store.state.prices.products)) {
    for (const p of entry.series) if (!latest || p.date > latest) latest = p.date;
  }
  return latest;
}

// pure UTC arithmetic throughout - mixing a local-time Date with the UTC
// conversion toISOString() does can shift the result by a day depending on
// the viewer's timezone and DST, which would move the "6 months" cutoff
// under Isa in Madrid without ever showing up while testing from UTC
function monthsBefore(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() - n);
  return dt.toISOString().slice(0, 10);
}

function seriesInPeriod(series, period) {
  let cutFrom = null, cutTo = null;
  if (period === "6m") {
    const today = priceToday();
    if (!today) return series;
    cutFrom = monthsBefore(today, 6);
  } else if (/^\d{4}$/.test(period)) {
    cutFrom = `${period}-01-01`; cutTo = `${period}-12-31`;
  }
  return series.filter((p) => (!cutFrom || p.date >= cutFrom) && (!cutTo || p.date <= cutTo));
}

// v10 spec §1: rank what comes back down, not what only rises. Excludes any
// product that never dropped in the window, even if it moved a lot. Always
// product-level (unaffected by whatever the Trends chart's L1/L2 pooling is
// currently showing) - the spec validated this ranking at product
// granularity specifically, pooling was never re-examined for it.
function computeOpportunities(period) {
  const out = [];
  for (const [key, entry] of Object.entries(store.state.prices.products)) {
    const pts = dailyPoints(seriesInPeriod(entry.series, period).filter((p) => !p.promo));
    if (pts.length < 2) continue;
    const prices = pts.map((p) => p.price);
    let hasDrop = false;
    for (let i = 1; i < prices.length; i++) if (prices[i] < prices[i - 1] * 0.97) hasDrop = true;
    if (!hasDrop) continue;
    const delta = (Math.max(...prices) - Math.min(...prices)) / Math.max(...prices);
    out.push({ key, label: entry.label, delta });
  }
  return out.sort((a, b) => b.delta - a.delta);
}

// v10 spec §6: a position hint, not a store recommendation - needs >=2
// observations at each of two stores and >=15% apart before it fires, so it
// never reacts to a single coincidental cheap trip. Takes a plain points
// array so it works the same for one product's own series or a pooled L1/L2
// array - the arithmetic does not care where the points came from.
function computeBubble(series) {
  if (!series || !series.length) return null;
  const byStore = new Map();
  series.forEach((p) => {
    if (!byStore.has(p.store)) byStore.set(p.store, []);
    byStore.get(p.store).push(p.price);
  });
  const medians = [...byStore.entries()]
    .filter(([, prices]) => prices.length >= 2)
    .map(([store, prices]) => {
      const s = [...prices].sort((a, b) => a - b);
      return { store, median: s[Math.floor(s.length / 2)] };
    })
    .sort((a, b) => a.median - b.median);
  if (medians.length < 2) return null;
  const [cheapest, next] = medians;
  if (cheapest.median <= next.median * 0.85) return cheapest.store;
  return null;
}

// the lowest price paid in a period, and which store - promo included,
// since "best price" means the best you could actually have paid, unlike
// the Opportunities ranking which deliberately excludes promos (§4). Same
// plain-points-array shape as computeBubble, same reason.
function bestPriceInPeriod(series, period) {
  const pts = seriesInPeriod(series, period);
  if (!pts.length) return null;
  const best = pts.reduce((a, b) => (b.price < a.price ? b : a));
  return { price: best.price, store: best.store };
}

// the two periods the chart offers, longest label first for the dropdown, and
// the compact form used in "Best price · X" where it sits in a small metric
// card. Per-year periods were dropped in v10.7: with six months and all time
// the only choices, pricesUiState.period is always one of these two keys.
const PERIODS = [["6m", "Last 6 months"], ["all", "All time"]];
const PERIOD_SHORT = { "6m": "6mo", all: "all time" };

const MAIN_LABELS = {
  meat: "Meat", fish: "Fish", rice: "Rice", pasta: "Pasta", soup: "Soup",
  sauce: "Sauce", other: "Other",
};

// 1..3 dots from the recipe category: quick plate -> slow simmer
function effortFor(category) {
  const c = (category || "").toLowerCase();
  if (c.includes("rapide")) return 2;
  if (c.includes("mijoté")) return 3;
  if (c.includes("soupe") || c.includes("marinade")) return 2;
  return 1;
}

// "20min + 3h" from prep + cook; "" if neither
function timesText(recipe) {
  return [recipe.prep, recipe.cook]
    .filter(Boolean)
    .map((t) => t.replace(/\s+/g, ""))
    .join(" + ");
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const ICON = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  sortUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 20V6M7 6l-4 4M7 6l4 4M13 8h8M13 13h5M13 18h2"/></svg>',
  sortDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v14M7 18l-4-4M7 18l4-4M13 8h2M13 13h5M13 18h8"/></svg>',
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M3 4h2l2.3 11.4a1 1 0 0 0 1 .8h8.5a1 1 0 0 0 1-.8L20.5 8H6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>',
};

/* round a scaled quantity sensibly */
function roundQty(n, isCount) {
  if (n == null) return n;
  if (isCount) return Math.max(1, Math.round(n));
  if (n >= 100) return Math.round(n);
  if (n >= 10) return Math.round(n * 10) / 10;
  return Math.round(n * 100) / 100;
}

/* ---------- rendering: list ---------- */

let checkedOpen = false;

// the chart icon (trending line + arrowhead), same mark on the list row,
// the sheet's promo dots and the Prices nav tab - one icon, one meaning
const PRICE_ICON_PATH = '<path d="M4 17l5-6 4 3 7-7"/><path d="M15 7h5v5"/>';
// same mark, flipped: a downward trend for an Opportunities row
const PRICE_ICON_DOWN_PATH = '<path d="M4 7l5 6 4-3 7 7"/><path d="M15 17h5v-5"/>';

// price hint for one list row: only unticked, only when the name resolves to
// something with a history at all - a row with no data gets no icon
// (v10 spec §6)
function priceHintFor(it) {
  if (it.checked) return null;
  const target = resolvePriceTarget(it.name);
  if (!target) return null;
  const series = seriesForTarget(target);
  if (!series.length) return null;
  return { target, bubbleStore: computeBubble(series) };
}

function itemRow(it) {
  const li = document.createElement("li");
  li.className = it.checked ? "checked" : "";
  const qtyStr = it.qty != null ? `${it.qty}${it.unit ? " " + it.unit : ""}` : "";
  const hint = priceHintFor(it);
  const priceBtn = hint ? `
    <button class="price-btn" aria-label="Price history">
      ${hint.bubbleStore ? `<span class="price-bubble" style="background:${storeColor(hint.bubbleStore)}"></span>` : ""}
      <svg viewBox="0 0 24 24" fill="none" stroke="${hint.bubbleStore ? storeOnColor(hint.bubbleStore) : "currentColor"}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${PRICE_ICON_PATH}</svg>
    </button>` : "";
  li.innerHTML = `
    <button class="tick" aria-label="Toggle">${it.checked ? "✓" : ""}</button>
    <span class="main">
      <span class="nm">${escapeHtml(it.name)}</span>
      ${it.note ? `<span class="sub">${escapeHtml(it.note)}</span>` : ""}
      ${qtyStr ? `<span class="qty">${escapeHtml(qtyStr)}</span>` : ""}
    </span>
    ${priceBtn}
    <button class="del" aria-label="Remove">✕</button>`;
  $(".tick", li).addEventListener("click", () => store.toggleItem(it.id));
  $(".del", li).addEventListener("click", () => store.deleteItem(it.id));
  if (hint) {
    $(".price-btn", li).addEventListener("click", () => goToPriceChart(hint.target));
  }
  return li;
}

/* The nav badge is visible from every tab, so it updates on every render even
   when the list itself is not on screen. */
function renderListBadge(state) {
  const n = state.list.reduce((a, x) => a + (x.checked ? 0 : 1), 0);
  const badge = $("#listBadge");
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.hidden = n === 0;
}

/* Only called when the list view is actually on screen. It rebuilds every row
   and re-binds two listeners per row; with the ticked block open that is 400+
   rows, and it used to run on every store change and every background poll
   while you were sat on Recipes or Settings looking at none of it. */
function renderList(state) {
  const active = state.list.filter((x) => !x.checked);
  const checked = state.list.filter((x) => x.checked);

  $("#addName").disabled = store.readOnly();

  const ul = $("#listItems");
  ul.innerHTML = "";
  active.forEach((it) => ul.appendChild(itemRow(it)));
  $("#listEmpty").hidden = active.length !== 0 || checked.length !== 0;

  const block = $("#checkedBlock");
  block.hidden = checked.length === 0;
  if (checked.length) {
    $("#checkedCount").textContent =
      `${checked.length} ticked item${checked.length === 1 ? "" : "s"}`;
    $("#checkedCaret").textContent = checkedOpen ? "▾" : "▸";
    const cul = $("#checkedItems");
    cul.hidden = !checkedOpen;
    cul.innerHTML = "";
    if (checkedOpen) {
      checked
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((it) => cul.appendChild(itemRow(it)));
    }
  }
}

function renderSuggestions(state) {
  const box = $("#suggestions");
  const q = deburr($("#addName").value.trim());
  if (!q) { box.hidden = true; box.innerHTML = ""; return; }
  const matches = state.list
    .filter((it) => it.checked && deburr(it.name).includes(q))
    .slice(0, 6);
  if (!matches.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.innerHTML = `<div class="hint-line">Add back to the list:</div>`;
  matches.forEach((it) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = it.name;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      store.uncheckItem(it.id);
      $("#addName").value = "";
      renderSuggestions(state);
    });
    box.appendChild(b);
  });
  box.hidden = false;
}

function submitAddName() {
  const input = $("#addName");
  const raw = input.value.trim();
  if (!raw) return;
  // exact (accent/case-insensitive) match on a ticked item: untick it instead
  const existing = store.state.list.find(
    (it) => it.checked && deburr(it.name) === deburr(raw),
  );
  if (existing) store.uncheckItem(existing.id);
  else store.addItem({ name: raw, qty: "", unit: "", note: "" });
  input.value = "";
  renderSuggestions(store.state);
  input.focus();
}

/* An amount at the end of a name, but only an unambiguous one: it carries a
   unit ("200 g"), an x multiplier ("x2"), or brackets ("(2x400g)"). A bare
   trailing number is NOT an amount - "Omega 3" is a name, not three of
   something, and "Vitamine B12" and "Ratio 16 9" are names too.

   One rule, used for both halves of Clean up, because both halves delete:
   isQuantified decides whether a row is a recipe leftover to remove, and
   stripQty builds the key that decides which rows are duplicates of each
   other. Letting the key strip a bare number merged "Omega 3" with "Omega 6"
   and deleted one of them; a unit-bearing suffix is the only safe signal. */
const TRAILING_AMOUNT =
  /(?:\s+x\s*\d+(?:[.,]\d+)?|\s+\d+(?:[.,]\d+)?\s*(?:kg|g|mg|l|ml|cl|pcs?|pc)|\s*[([][^()[\]]*\d[^()[\]]*[)\]])$/i;

/* strip a trailing quantity / size note from a name, e.g. "Parmesan 200 g" ->
   "parmesan", "Tomatoes (2x400g)" -> "tomatoes". Deburred, so it doubles as a
   grouping key. A bracketed note is only stripped when it has a digit, so real
   descriptors ("(spicy)", "(Keisy)") survive. */
function stripQty(name) {
  let s = deburr(name || "").replace(/\s+/g, " ").trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/[.,;]+$/, "").replace(TRAILING_AMOUNT, "").trim();
  } while (s !== prev);
  return s;
}

/* a ticked item is "recipe-specific" if it carries an amount: a real qty
   field, or a quantity left in the name (hand-typed items don't parse one) */
function isQuantified(it) {
  const q = Number(it.qty);
  if (Number.isFinite(q) && q !== 0) return true;
  return TRAILING_AMOUNT.test(deburr(it.name || "").replace(/\s+/g, " ").trim());
}

/* Clean up also retires ticked rows nobody has used in a long time.

   Same gesture, same meaning ("tidy the ticked block"), and doing it on an
   explicit tap beats a scheduled job that removes things unasked. It matters
   because the whole list is re-uploaded on every write, so the ticked
   catalogue is paid for on every single tick; this is what stops it growing
   forever. Retired rows also stop appearing as "add back" suggestions, which
   is the point: they are things nobody buys. */
const PRUNE_MONTHS = 6;
// a sweep bigger than this asks before deleting, see tidyChecked
const CONFIRM_OVER = 20;

/* The clock starts here, not at whatever addedAt a row happens to carry.
   Usage tracking began with v9.22; before that nothing recorded whether an
   item was ever actually bought. The seed's addedAt is the bootstrap date, so
   letting it age rows out on its own would retire the catalogue on the
   strength of a timestamp that never meant "last used". Flooring at the epoch
   means the first prune cannot land until PRUNE_MONTHS of real use have been
   observed: six months from this build, whatever the data says.
   food/tools/prune_shopping_list.py mirrors both constants. */
const PRUNE_EPOCH = Date.parse("2026-09-03T00:00:00Z");

let pruneArmed = false;
let pruneArmTimer;

/* Last evidence a row was used: touchedAt moves on every tick and un-tick.
   Without one, the row counts as last used at its addedAt or the epoch,
   whichever is later, so a row added tomorrow ages from tomorrow and a seed
   row ages from the epoch. Never null: every row has a defensible date. */
function lastUsedAt(it) {
  const touched = Date.parse(it.touchedAt || "");
  if (Number.isFinite(touched)) return touched;
  const added = Date.parse(it.addedAt || "");
  return Math.max(Number.isFinite(added) ? added : PRUNE_EPOCH, PRUNE_EPOCH);
}

function pruneCutoffMs() {
  const d = new Date();
  d.setMonth(d.getMonth() - PRUNE_MONTHS);
  return d.getTime();
}

/* the group key: same concept (slug, or the de-quantified name) and same
   variant (the note field, where recipe adds put the variant) */
function cleanupKey(it) {
  return `${it.slug || stripQty(it.name)}|${deburr((it.note || "").trim())}`;
}

/* Everything Clean up would remove, and why. Per group of ticked items: keep
   one (a non-quantified staple by preference, else the shortest name), delete
   the rest; then delete that survivor too if it is itself quantified.
   Survivors stay ticked. Then, separately, anything ticked and past the age
   cutoff. Computing without mutating lets the confirm step show a count. */
function cleanupPlan() {
  const groups = new Map();
  for (const it of store.state.list) {
    if (!it.checked) continue;
    const k = cleanupKey(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }

  const drop = new Set();
  for (const items of groups.values()) {
    const sorted = items.slice().sort(
      (a, b) =>
        (isQuantified(a) - isQuantified(b)) ||
        (a.name.trim().length - b.name.trim().length) ||
        a.name.localeCompare(b.name),
    );
    const [keep, ...rest] = sorted;
    rest.forEach((it) => drop.add(it.id));
    if (isQuantified(keep)) drop.add(keep.id);
  }
  const dupes = drop.size;

  const cut = pruneCutoffMs();
  let stale = 0;
  for (const it of store.state.list) {
    if (!it.checked || drop.has(it.id)) continue;
    if (lastUsedAt(it) < cut) { drop.add(it.id); stale++; }
  }
  return { ids: [...drop], dupes, stale };
}


function disarmPrune() {
  clearTimeout(pruneArmTimer);
  pruneArmed = false;
}

function tidyChecked() {
  const plan = cleanupPlan();

  if (!plan.ids.length) {
    disarmPrune();
    showTidyResult("Nothing to clean up");
    return;
  }

  /* A big sweep - typically the first prune, retiring the untouched half of
     the seed catalogue in one go - is irreversible and there is no undo, so
     make it two taps. Small tidies go straight through, as they always have.
     The guard covers a large duplicate merge too, which was never confirmed. */
  if (plan.ids.length > CONFIRM_OVER && !pruneArmed) {
    pruneArmed = true;
    clearTimeout(pruneArmTimer);
    showTidyResult(`Remove ${plan.ids.length}? Tap again`, { hold: 6000 });
    pruneArmTimer = setTimeout(() => { pruneArmed = false; }, 6000);
    return;
  }
  disarmPrune();

  const dropSet = new Set(plan.ids);
  const stillChecked = store.state.list.some((x) => x.checked && !dropSet.has(x.id));
  store.removeMany(plan.ids);

  const bits = [];
  if (plan.dupes) bits.push(`${plan.dupes} duplicate${plan.dupes === 1 ? "" : "s"}`);
  if (plan.stale) bits.push(`${plan.stale} unused`);
  const msg = `${bits.join(" and ")} cleaned up`;
  // the result briefly replaces the Clean up button; if the whole ticked block
  // just emptied there is no button, so fall back to the page banner
  if (stillChecked) showTidyResult(msg);
  else flashBanner(msg);
}

/* the Clean up result fades in over the button, holds, then the button fades
   back. render() does not touch #tidyChecked, so the swap survives it. */
let tidyResultTimer;
function showTidyResult(text, opts) {
  const hold = (opts && opts.hold) || 2600;
  const btn = $("#tidyChecked");
  if (!btn) return;
  clearTimeout(tidyResultTimer);
  btn.classList.add("fading");
  setTimeout(() => {
    btn.textContent = text;
    btn.classList.add("result");
    btn.classList.remove("fading");
  }, 200);
  tidyResultTimer = setTimeout(() => {
    btn.classList.add("fading");
    setTimeout(() => {
      btn.textContent = "Clean up";
      btn.classList.remove("result", "fading");
    }, 200);
  }, hold);
}

const HTML_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

/* ---------- rendering: recipes ---------- */

/* Order-by options, in menu order. `cmp` is the primary comparator; name
   ascending is always the tie-breaker, applied in renderRecipes. */
const SORT_MODES = [
  { id: "complexity-asc",  label: "Complexity, simplest first",
    cmp: (a, b) => effortFor(a.category) - effortFor(b.category) },
  { id: "complexity-desc", label: "Complexity, hardest first",
    cmp: (a, b) => effortFor(b.category) - effortFor(a.category) },
  { id: "name-asc",        label: "Alphabetical, A to Z", cmp: () => 0 },
  { id: "name-desc",       label: "Alphabetical, Z to A",
    cmp: (a, b) => deburr(b.name).localeCompare(deburr(a.name)) },
  { id: "time-asc",        label: "Cooking time, quickest first",
    cmp: (a, b) => timeCmp(a, b, 1) },
  { id: "time-desc",       label: "Cooking time, longest first",
    cmp: (a, b) => timeCmp(a, b, -1) },
  { id: "incomplete-first", label: "Incomplete first",
    cmp: (a, b) => incompleteRank(b) - incompleteRank(a) },
  { id: "incomplete-last",  label: "Incomplete last",
    cmp: (a, b) => incompleteRank(a) - incompleteRank(b) },
];
const DEFAULT_SORT = "complexity-asc";
const sortMode = (id) => SORT_MODES.find((m) => m.id === id) || SORT_MODES[0];

/* "1h30", "45 min", "1 h 15" -> minutes. prep + cook together; a recipe with
   no times at all sorts to the very bottom either way rather than pretending
   to take zero minutes. */
function totalMinutes(recipe) {
  let total = 0;
  let seen = false;
  [recipe.prep, recipe.cook].forEach((t) => {
    if (!t) return;
    const str = String(t).toLowerCase();
    const h = /(\d+(?:[.,]\d+)?)\s*h/.exec(str);
    // minutes written after the hours ("1h30") as well as on their own ("45min")
    const m = /(\d+)\s*(?:min|mn|m(?![a-z]))/.exec(str) || (h && /h\s*(\d{1,2})(?!\d)/.exec(str));
    const bare = !h && !m ? /(\d+)/.exec(str) : null;
    if (h) { total += parseFloat(h[1].replace(",", ".")) * 60; seen = true; }
    if (m) { total += parseInt(m[1], 10); seen = true; }
    if (bare) { total += parseInt(bare[1], 10); seen = true; }
  });
  return seen ? total : null;
}

/* recipes with no time at all sit at the bottom whichever way you sort, rather
   than pretending to be the quickest (or the longest) thing in the book */
function timeCmp(a, b, dir) {
  const ta = totalMinutes(a);
  const tb = totalMinutes(b);
  if (ta == null || tb == null) return (ta == null) - (tb == null);
  return dir * (ta - tb);
}

/* incomplete = still to write, or written but not yet confirmed in the kitchen */
const incompleteRank = (r) => (r.stub || !r.portionsConfirmed ? 1 : 0);

const recipeFilters = {
  q: "",
  cuisine: "",
  main: "",
  searchOpen: false,
  sort: DEFAULT_SORT,
  sortOpen: false,
};

const recipeFiltersActive = () =>
  !!(
    recipeFilters.cuisine ||
    recipeFilters.main ||
    recipeFilters.q.trim() ||
    recipeFilters.sort !== DEFAULT_SORT
  );

// distinct values ordered by how many recipes have them, most first
function countedValues(recipes, pick) {
  const counts = new Map();
  recipes.forEach((r) => {
    const v = pick(r);
    if (v) counts.set(v, (counts.get(v) || 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v]) => v);
}

function renderRecipeControlRow(state) {
  const row = $("#recipeControlRow");
  // don't rebuild a live search field mid-typing
  if (recipeFilters.searchOpen && $(".search-field", row)) return;
  row.innerHTML = "";

  if (recipeFilters.searchOpen) {
    const back = document.createElement("button");
    back.className = "icon-btn";
    back.setAttribute("aria-label", "Close search");
    back.innerHTML = ICON.back;
    back.addEventListener("click", () => {
      recipeFilters.searchOpen = false;
      recipeFilters.q = "";
      renderRecipes(store.state);
    });

    const field = document.createElement("div");
    field.className = "search-field";
    field.innerHTML =
      ICON.search +
      `<input type="text" inputmode="search" enterkeyhint="search" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Search ${state.recipes.length} recipes" aria-label="Search recipes" />` +
      `<button class="clr" type="button" aria-label="Clear search">${ICON.x}</button>`;
    const input = $("input", field);
    input.value = recipeFilters.q;
    input.addEventListener("input", () => {
      recipeFilters.q = input.value;
      renderRecipes(store.state);
    });
    $(".clr", field).addEventListener("click", () => {
      recipeFilters.searchOpen = false;
      recipeFilters.q = "";
      renderRecipes(store.state);
    });

    row.append(back, field);
    input.focus();
    return;
  }

  const glass = document.createElement("button");
  glass.className = "icon-btn";
  glass.setAttribute("aria-label", "Search recipes");
  glass.innerHTML = ICON.search;
  glass.addEventListener("click", () => {
    recipeFilters.searchOpen = true;
    renderRecipeControlRow(store.state);
  });

  const spacer = document.createElement("div");
  spacer.className = "spacer";

  // Clear sits immediately left of Order by, on the right of the row, and is
  // accent-coloured so it reads as the one active thing to undo
  const clear = document.createElement("button");
  clear.className = "clear-btn";
  clear.hidden = !recipeFiltersActive();
  clear.innerHTML = `${ICON.x}<span>Clear filters</span>`;
  clear.addEventListener("click", () => {
    recipeFilters.q = "";
    recipeFilters.cuisine = "";
    recipeFilters.main = "";
    recipeFilters.sort = DEFAULT_SORT;
    recipeFilters.sortOpen = false;
    renderRecipes(store.state);
  });

  const sortWrap = document.createElement("div");
  sortWrap.className = "sort-wrap";

  const sort = document.createElement("button");
  sort.className = "sort-btn";
  sort.setAttribute("aria-haspopup", "listbox");
  sort.setAttribute("aria-expanded", String(recipeFilters.sortOpen));
  sort.innerHTML = ICON.sortUp + `<span>Order by</span>`;
  sort.addEventListener("click", (e) => {
    e.stopPropagation();
    recipeFilters.sortOpen = !recipeFilters.sortOpen;
    renderRecipeControlRow(store.state);
  });
  sortWrap.appendChild(sort);

  if (recipeFilters.sortOpen) {
    const menu = document.createElement("div");
    menu.className = "sort-menu";
    menu.setAttribute("role", "listbox");
    SORT_MODES.forEach((m) => {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "sort-opt" + (m.id === recipeFilters.sort ? " on" : "");
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", String(m.id === recipeFilters.sort));
      opt.innerHTML = `<span>${m.label}</span>` +
        (m.id === recipeFilters.sort ? ICON.check : "");
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        recipeFilters.sort = m.id;
        recipeFilters.sortOpen = false;
        renderRecipes(store.state);
      });
      menu.appendChild(opt);
    });
    sortWrap.appendChild(menu);
    // one-shot: the next tap anywhere else closes the menu
    setTimeout(() => {
      document.addEventListener("click", closeSortMenu, { once: true });
    }, 0);
  }

  row.append(glass, spacer, clear, sortWrap);
}

function closeSortMenu() {
  if (!recipeFilters.sortOpen) return;
  recipeFilters.sortOpen = false;
  renderRecipeControlRow(store.state);
}

function renderRecipeFilters(state) {
  const cuisines = countedValues(state.recipes, (r) => r.cuisine);
  const mains = countedValues(state.recipes, (r) =>
    r.mainIngredient === "other" ? null : r.mainIngredient,
  );

  // "All" (default) chip first, then one chip per value
  const filterChip = (box, key, value, label) => {
    const b = document.createElement("button");
    b.className = "chip" + (recipeFilters[key] === value ? " on" : "");
    b.textContent = label;
    b.addEventListener("click", () => {
      recipeFilters[key] = value === "" ? "" : (recipeFilters[key] === value ? "" : value);
      renderRecipes(store.state);
    });
    box.appendChild(b);
  };

  const cbox = $("#cuisineFilters");
  cbox.querySelectorAll(".chip").forEach((c) => c.remove());
  if (cuisines.length) {
    filterChip(cbox, "cuisine", "", "All");
    cuisines.forEach((c) => filterChip(cbox, "cuisine", c, cap(c)));
  }

  const mbox = $("#mainFilters");
  mbox.querySelectorAll(".chip").forEach((c) => c.remove());
  if (mains.length) {
    filterChip(mbox, "main", "", "All");
    mains.forEach((m) => filterChip(mbox, "main", m, MAIN_LABELS[m] || m));
  }

  updateRailFade(cbox);
  updateRailFade(mbox);
}

// fade the right edge only while the rail actually has more to scroll to,
// so an intentionally-cut-off chip reads as "scroll for more", not "broken" -
// and the fade clears once you've scrolled to the last chip
function updateRailFade(rail) {
  const moreToTheRight =
    rail.scrollWidth > rail.clientWidth + 1 &&
    rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 2;
  rail.classList.toggle("rail-fade", moreToTheRight);
}

/* One canvas pair per recipe, rasterised once and reused. renderRecipes runs
   on every render while the tab is visible - including a background poll - and
   foodPixelIcon builds two canvases per card, so 43 recipes meant re-drawing
   86 canvases for a repaint that changed nothing. Re-appending a cached
   element moves it, which is exactly what we want. Cleared when recipes
   resync, in case a name or category changed. */
const iconCache = new Map();

function recipeIcon(r) {
  if (typeof foodPixelIcon !== "function") return null;
  let el = iconCache.get(r.slug);
  if (!el) {
    el = foodPixelIcon(r.name, r.category, 38);
    iconCache.set(r.slug, el);
  }
  return el;
}

function renderRecipes(state) {
  renderRecipeControlRow(state);
  renderRecipeFilters(state);
  const q = deburr(recipeFilters.q);
  const mode = sortMode(recipeFilters.sort);
  const rows = state.recipes
    .filter((r) => {
      if (recipeFilters.cuisine && r.cuisine !== recipeFilters.cuisine) return false;
      if (recipeFilters.main && r.mainIngredient !== recipeFilters.main) return false;
      if (q && !deburr(r.name).includes(q)) return false;
      return true;
    })
    .sort((a, b) => mode.cmp(a, b) || deburr(a.name).localeCompare(deburr(b.name)));
  const ul = $("#recipeList");
  ul.innerHTML = "";
  rows.forEach((r) => {
    const li = document.createElement("li");
    li.className = "recipe-card";
    const eff = effortFor(r.category);
    const times = timesText(r);
    const meta = r.stub
      ? `<span class="card-stub">${r.stubKind === "link" ? "link only" : "to write"}</span>`
      : `${times ? `<span class="card-time">${escapeHtml(times)}</span>` : ""}
         <span class="dots" title="Effort ${eff}/3" aria-label="effort ${eff} of 3">${'<i class="on"></i>'.repeat(eff)}${"<i></i>".repeat(3 - eff)}</span>`;
    li.classList.toggle("stub", !!r.stub);
    li.innerHTML = `
      <span class="main">${escapeHtml(r.name)}</span>
      <span class="card-meta">${meta}</span>`;
    const icon = recipeIcon(r);
    if (icon) li.appendChild(icon);
    li.addEventListener("click", () => openRecipe(r.slug));
    ul.appendChild(li);
  });
  const empty = $("#recipeEmpty");
  empty.hidden = rows.length !== 0;
  empty.textContent = state.recipes.length === 0
    ? "Recipes sync from your repo once a token is set."
    : "No recipe matches.";
  scheduleEqualise();
}

function scheduleEqualise() {
  equaliseCards();
  // fonts can change line wrapping after first paint; re-run once loaded
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(equaliseCards);
  }
}

// every card takes the height of the tallest visible one; recomputed on
// each render, after fonts load, and on resize (column count changes with width)
function equaliseCards() {
  if ($("#view-recipes").hidden) return;
  const cards = $$("#recipeList li");
  if (!cards.length) return;
  cards.forEach((c) => { c.style.minHeight = ""; });
  let max = 0;
  cards.forEach((c) => { max = Math.max(max, c.offsetHeight); });
  cards.forEach((c) => { c.style.minHeight = max + "px"; });
}

/* ---------- recipe detail + scaler ---------- */

// { recipe, servings, custom, customEditing, addMode, added:Set<ingredientIndex> }
let detailState = null;
let sheetClosing = false;
let closeRequested = false;
let sheetHasHistory = false;

function openRecipe(slug) {
  const recipe = store.state.recipes.find((r) => r.slug === slug);
  if (!recipe) return;
  detailState = {
    recipe, servings: recipe.portions, custom: null, customEditing: false,
    addMode: false, added: new Set(), // ingredient indices ticked this add-mode session
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
function slideSheetDown() {
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

// leaving the Recipes tab: hide the open sheet instantly, keep it "open".
// Shopping mode and its ticks are kept - they only reset on the cart toggle
// or on closing the recipe. A half-typed custom serving is dropped.
function parkRecipe() {
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

// back on the Recipes tab: restore the stashed sheet, no animation
function unparkRecipe() {
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
function closeRecipe() {
  if ($("#recipeDetail").hidden || sheetClosing || closeRequested) return;
  closeRequested = true;
  if (sheetHasHistory) {
    sheetHasHistory = false;
    history.back(); // -> popstate -> slideSheetDown
  } else {
    slideSheetDown();
  }
}

/* ---------- price detail sheet (same swoop-up as a recipe) ---------- */

// { key, highlightDate, highlightStore } - the two identify one row to
// always whatever the Trends card is currently showing (pricesUiState.target)
// - "See all" and a chart-dot tap both open the same sheet, the dot just
// also carries a {date, store} to scroll to and highlight
let priceDetailState = null;
let priceSheetClosing = false;
let priceCloseRequested = false;
let priceSheetHasHistory = false;

function openPriceDetail(highlight = null) {
  if (!pricesUiState.target) return;
  priceDetailState = { highlight };
  const el = $("#priceDetail");
  priceSheetClosing = false;
  priceCloseRequested = false;
  el.hidden = false;
  el.classList.remove("shown");
  el.style.transition = "";
  el.style.transform = "";
  renderPriceDetail();
  el.scrollTop = 0;
  void el.offsetHeight;
  el.classList.add("shown");
  try {
    history.pushState({ priceSheet: true }, "");
    priceSheetHasHistory = true;
  } catch (e) {
    priceSheetHasHistory = false;
  }
  if (highlight) scrollToHighlightedRow();
}

function slidePriceSheetDown() {
  const el = $("#priceDetail");
  if (el.hidden || priceSheetClosing) return;
  priceSheetClosing = true;
  el.style.transition = "";
  el.style.transform = "";
  el.classList.remove("shown");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.removeEventListener("transitionend", onEnd);
    el.hidden = true;
    priceDetailState = null;
    priceSheetClosing = false;
    priceCloseRequested = false;
  };
  const onEnd = (e) => {
    if (e.target === el && e.propertyName === "transform") finish();
  };
  el.addEventListener("transitionend", onEnd);
  setTimeout(finish, 450);
}

function parkPriceDetail() {
  const el = $("#priceDetail");
  if (el.hidden || priceDetailState == null) return;
  el.style.transition = "none";
  el.classList.remove("shown");
  el.hidden = true;
  el.style.transform = "";
}

function unparkPriceDetail() {
  const el = $("#priceDetail");
  if (priceDetailState == null) return;
  el.hidden = false;
  el.style.transition = "none";
  el.classList.add("shown");
  el.style.transform = "translate(-50%, 0)";
  el.scrollTop = 0;
  void el.offsetHeight;
  el.style.transition = "";
}

function closePriceDetail() {
  if ($("#priceDetail").hidden || priceSheetClosing || priceCloseRequested) return;
  priceCloseRequested = true;
  if (priceSheetHasHistory) {
    priceSheetHasHistory = false;
    history.back();
  } else {
    slidePriceSheetDown();
  }
}

window.addEventListener("popstate", () => {
  sheetHasHistory = false;
  priceSheetHasHistory = false;
  if (detailState != null) {
    if ($("#recipeDetail").hidden) detailState = null; // parked elsewhere: back just discards it
    else slideSheetDown();
  }
  if (priceDetailState != null) {
    if ($("#priceDetail").hidden) priceDetailState = null;
    else slidePriceSheetDown();
  }
});

// tap or swipe-down on the tinted name bar closes the sheet - shared by the
// recipe sheet and the price sheet, same physics, different close callback
function bindSheetDrag(barSel, elSel, onClose) {
  const bar = $(barSel);
  const el = $(elSel);
  let startY = 0;
  let dy = 0;
  let dragging = false;
  let moved = false;

  bar.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    dy = 0;
    dragging = true;
    moved = false;
    el.style.transition = "none";
  }, { passive: true });

  bar.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    dy = e.touches[0].clientY - startY;
    if (dy > 0) {
      moved = true;
      e.preventDefault();
      el.style.transform = `translate(-50%, ${dy}px)`;
    } else {
      el.style.transform = "translate(-50%, 0)";
    }
  }, { passive: false });

  bar.addEventListener("touchend", (e) => {
    if (!dragging) return;
    dragging = false;
    e.preventDefault(); // suppress the ghost click
    el.style.transition = "";
    el.style.transform = "";
    if (!moved || dy < 6 || dy > 90) {
      onClose(); // tap, or dragged far enough -> close (CSS finishes the slide)
    }
    // otherwise: transform cleared -> springs back to translate(-50%, 0)
  }, { passive: false });

  bar.addEventListener("click", () => onClose());
}

function initSheetDrag() {
  bindSheetDrag("#detailBar", "#recipeDetail", closeRecipe);
}
function initPriceSheetDrag() {
  bindSheetDrag("#priceDetailBar", "#priceDetail", closePriceDetail);
}

function isCountUnit(unit) {
  return !unit || ["gousse", "branche", "botte", "paquet", "tranche"].includes(unit);
}

function isWeightVolumeUnit(u) { return /^(g|kg|mg|ml|cl|l)$/i.test(u || ""); }
function isSpoonUnit(u) { return /^(cs|cc)$/i.test(u || ""); }

// snap a fractional count to 0, 1/3, 1/2, 2/3 (a scaled onion reads as
// "1 1/2", not "1.5"). qtyText renders the mixed number.
function snapCount(x) {
  const whole = Math.floor(x), f = x - whole;
  const near = [0, 1 / 3, 1 / 2, 2 / 3, 1].reduce(
    (a, b) => Math.abs(b - f) < Math.abs(a - f) ? b : a);
  return whole + near;
}

// scale one ingredient quantity for a new servings count, honouring its
// fractionnability class from recipes.json. Scaling display policy (Isa,
// 2026-09-02): weight and volume round UP to a whole unit with no decimal,
// spoons to the nearest half, counted items stay fractional. Falls back to
// the old unit heuristic for recipes cached before `frac` existed.
function scaleQty(ing, factor) {
  const x = ing.qty * factor;
  if (ing.frac === "au gout") return ing.qty;                // never scaled
  if (ing.frac === "entier") return Math.max(1, Math.round(x));
  if (ing.frac === "fractionnable") {
    if (isWeightVolumeUnit(ing.unit)) return Math.ceil(x);   // up to the next g / ml
    if (isSpoonUnit(ing.unit)) return Math.round(x * 2) / 2; // nearest half spoon
    return snapCount(x);                                     // counted: 1 1/2, 1 1/3
  }
  return roundQty(x, isCountUnit(ing.unit));                 // no `frac`
}

function servingPresets(recipe) {
  if (recipe.presets && recipe.presets.length) return recipe.presets;
  const b = recipe.portions || 4;
  return [...new Set([1, 2, b, b * 2].filter((n) => n >= 1 && n <= 10))].sort((a, b2) => a - b2);
}

function qtyText(qty, unit) {
  let q = qty;
  // a counted quantity with a fraction shows as a mixed number: "1 1/2",
  // "1 1/2 branche" - but never for a weight, volume or spoon measure
  if (typeof qty === "number" && !Number.isInteger(qty)
      && !isWeightVolumeUnit(unit) && !isSpoonUnit(unit)) {
    const whole = Math.floor(qty);
    const label = [[1 / 3, "1/3"], [1 / 2, "1/2"], [2 / 3, "2/3"]].reduce(
      (a, b) => Math.abs(b[0] - (qty - whole)) < Math.abs(a[0] - (qty - whole)) ? b : a)[1];
    q = whole > 0 ? `${whole} ${label}` : label;
  }
  return `${q}${unit ? " " + escapeHtml(unit) : ""}`;
}

// up to 3 pills for the detail header: cuisine, type, and the stub status
function detailBarHtml(recipe) {
  const tags = [];
  if (recipe.cuisine) tags.push(cap(recipe.cuisine));
  if (recipe.mainIngredient && recipe.mainIngredient !== "other") {
    tags.push(MAIN_LABELS[recipe.mainIngredient] || cap(recipe.mainIngredient));
  }
  if (recipe.stub) tags.push(recipe.stubKind === "link" ? "link only" : "to write");
  const pills = tags.slice(0, 3)
    .map((t) => `<span class="detail-tag">${escapeHtml(t)}</span>`).join("");
  return `<span class="rname">${escapeHtml(recipe.name)}</span>` +
    (pills ? `<div class="detail-tags">${pills}</div>` : "");
}

function renderDetail() {
  const { recipe } = detailState;

  // index-only entry: no card written yet. Show the name + where to cook it
  // from, nothing to scale.
  if (recipe.stub) {
    $("#detailBar").innerHTML = detailBarHtml(recipe);
    const links = (recipe.sources || []).map((u, i) =>
      `<a class="stub-link" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">
         Open recipe${recipe.sources.length > 1 ? " " + (i + 1) : ""} &nearr;</a>`).join("");
    $("#detailBody").innerHTML = `
      <div class="stub-body">
        ${links || `<p class="hint">Not written up yet. Cook it once and add it
          with the <code>add-recipe</code> skill and it becomes a full card here.</p>`}
        ${links ? `<p class="hint">Not saved as a full recipe yet, so there is no
          scaler or shopping-list add for this one.</p>` : ""}
      </div>`;
    return;
  }

  const base = recipe.portions;
  const target = detailState.servings;
  const factor = base ? target / base : 1;
  const scaled = target !== base;
  const presets = servingPresets(recipe);

  // read-only (no usable token) blocks every list write, so shopping mode
  // would just show ticks that never land - collapse it instead
  const addMode = detailState.addMode && !store.readOnly();
  const ingHtml = recipe.ingredients.map((ing, i) => {
    const nameHtml = `<span class="nm">${escapeHtml(ing.name)}` +
      `${ing.note ? ` <span class="note">(${escapeHtml(ing.note)})</span>` : ""}`;
    let qtyCell, scaledCell, trailing = "";
    if (ing.qty != null) {
      qtyCell = `<span class="qty">${qtyText(ing.qty, ing.unit)}</span>`;
      const scaledQty = scaleQty(ing, factor);
      scaledCell = scaled ? `<span class="qty-scaled">${qtyText(scaledQty, ing.unit)}</span>` : "";
    } else {
      qtyCell = `<span class="qty"></span>`;
      scaledCell = scaled ? `<span class="qty-scaled"></span>` : "";
      trailing = ing.raw ? ` <span class="note">${escapeHtml(ing.raw)}</span>` : "";
    }
    let addCell = "";
    if (addMode) {
      const added = detailState.added.has(i);
      addCell = `<button type="button" class="ing-add${added ? " added" : ""}" data-i="${i}" aria-label="${added ? "Remove from shopping list" : "Add to shopping list"}">${added ? ICON.check : ICON.plus}</button>`;
    }
    return `<li>${qtyCell}${scaledCell}${nameHtml}${trailing}</span>${addCell}</li>`;
  }).join("");

  const gridCols = [
    "max-content",
    ...(scaled ? ["max-content"] : []),
    "1fr",
    ...(addMode ? ["max-content"] : []),
  ].join(" ");

  const stepsHtml = recipe.steps.length
    ? `<h3>Preparation</h3><ol class="steps">${recipe.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>`
    : `<h3>Preparation</h3><p class="hint">Not written up yet.</p>`;

  const customIsExtra =
    detailState.custom != null && !presets.includes(detailState.custom);
  const bubbles = presets
    .map((p) => {
      const cls = `bubble${target === p ? " on" : ""}${p === base ? " base" : ""}`;
      return `<button class="${cls}" data-serv="${p}">${p}</button>`;
    })
    .join("");
  let customBubble;
  if (detailState.customEditing) {
    customBubble = `<input class="bubble-input" id="customServ" type="number" inputmode="numeric" min="1" placeholder="#" value="${detailState.custom ?? ""}" />`;
  } else if (customIsExtra) {
    customBubble = `<button class="bubble${target === detailState.custom ? " on" : ""}" id="customBubble" data-serv="${detailState.custom}">${detailState.custom}</button>`;
  } else {
    customBubble = `<button class="bubble bubble-custom" id="customBubble">Custom</button>`;
  }

  $("#detailBar").innerHTML = detailBarHtml(recipe);

  $("#detailBody").innerHTML = `
    <div class="scaler">
      <span class="scaler-label">Servings</span>
      <div class="bubbles">${bubbles}${customBubble}</div>
      <button class="reset" id="resetScale">Reset</button>
    </div>
    <div class="ing-head">
      <h3>Ingredients</h3>
      <button type="button" id="ingAddToggle" class="switch${addMode ? " on" : ""}" role="switch" aria-checked="${addMode}" aria-label="Shopping mode">
        <span class="switch-icon">${ICON.cart}</span>
        <span class="switch-track"><span class="switch-knob"></span></span>
      </button>
    </div>
    <ul class="ing-list${addMode ? " adding" : ""}" style="grid-template-columns:${gridCols}">${ingHtml}</ul>
    ${recipe.portionsConfirmed ? "" : `<p class="unconfirmed">Base portions not confirmed in the kitchen.</p>`}
    ${stepsHtml}
  `;

  const body = $("#detailBody");

  $$(".bubble[data-serv]", body).forEach((b) => {
    b.addEventListener("click", () => {
      detailState.servings = Number(b.dataset.serv);
      detailState.customEditing = false;
      renderDetail();
    });
  });

  const cb = $("#customBubble", body);
  if (cb) {
    cb.addEventListener("click", () => {
      detailState.customEditing = true;
      renderDetail();
    });
  }

  const ci = $("#customServ", body);
  if (ci) {
    ci.focus();
    ci.select();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = Math.round(Number(ci.value));
      if (v >= 1) {
        detailState.custom = presets.includes(v) ? null : v;
        detailState.servings = v;
      }
      detailState.customEditing = false;
      renderDetail();
    };
    ci.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { done = true; detailState.customEditing = false; renderDetail(); }
    });
    ci.addEventListener("blur", commit);
  }

  $("#resetScale", body).addEventListener("click", () => {
    detailState.servings = recipe.portions;
    detailState.custom = null;
    detailState.customEditing = false;
    renderDetail();
  });

  $("#ingAddToggle", body).addEventListener("click", () => {
    detailState.addMode = !detailState.addMode;
    if (!detailState.addMode) detailState.added.clear(); // leaving: reset the ticks
    renderDetail();
  });

  $$(".ing-add", body).forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.i);
      const ing = recipe.ingredients[i];
      const key = `recipe:${recipe.slug}#${i}`;
      const existing = store.state.list.find((it) => it.source === key);
      if (detailState.added.has(i)) {
        if (existing) store.deleteItem(existing.id);
        detailState.added.delete(i);
      } else if (existing) {
        detailState.added.add(i);
      } else {
        let qty = null, unit = null;
        if (ing.qty != null) {
          qty = scaled ? scaleQty(ing, factor) : ing.qty;
          unit = ing.unit;
        }
        // only tick the row if the item actually landed - store.addItem
        // returns null when the list is read-only
        const created = store.addItem({
          name: ing.conceptName || ing.name,
          qty, unit,
          note: [ing.variantHint, ing.note].filter(Boolean).join(", ") || null,
          source: key,
          slug: ing.slug || null,
        });
        if (created) detailState.added.add(i);
      }
      renderDetail();
    });
  });
}

/* ---------- settings ---------- */

// { state: "idle"|"checking"|"ok"|"error", text, login }  (not persisted)
let tokenStatus = { state: "idle", text: "" };

async function checkToken() {
  const token = store.state.settings.token;
  if (!token) {
    tokenStatus = { state: "idle", text: "" };
    renderSettings(store.state);
    return;
  }
  tokenStatus = { state: "checking", text: "Checking..." };
  renderSettings(store.state);
  try {
    const { login } = await github.getUser();
    // Proves repo access AND keeps what it downloads. This used to be a bare
    // getFile() whose 86 KB body was parsed and thrown away, and then fetched
    // again by the fullSync below - two full recipe downloads per app open.
    // Going through syncRecipes stores the etag, so that second read is a 304.
    await syncRecipes();
    tokenStatus = { state: "ok", login, text: `Connected as ${login}` };
    if (syncState.kind === "unauthorized") syncState = { kind: "idle", resetAt: null };
    fullSync().then(() => render(store.state)); // a fresh token: pull everything
  } catch (e) {
    const c = github.config;
    const msg = {
      unauthorized: `Token rejected. It must be a fine-grained token with Contents access to ${c.owner}/${c.repo}.`,
      notFound: `That token cannot see ${c.owner}/${c.repo}. Give it repository access.`,
      offline: "Offline, cannot check the token right now.",
      rateLimited: "GitHub is busy, try again in a minute.",
    }[e.gh] || `Could not check the token (${e.message}).`;
    tokenStatus = { state: "error", text: msg };
    if (e.gh === "unauthorized") syncState = { kind: "unauthorized", resetAt: null };
  }
  render(store.state);
}

/* ---------- rendering: prices ---------- */

let pricesUiState = {
  target: null,   // {level:"l3", key} | {level:"l1"|"l2", l1, l1_label, l2?} | null (nothing seen yet)
  period: "6m",   // "6m" | "all" | a "YYYY" year
  groupBy: "supermarket",  // "supermarket" (one line per store) | "product" (one line per variant/product)
  openPill: null,  // "l1" | "l2" | "l3" | null - which pill's dropdown is open
  oppOpen: false,
};

// picks a sensible first thing to show the moment real data exists and
// nothing has been tapped yet: the top Worth-watching mover if there is
// one, else whichever product has the deepest history. Never runs again
// once something has actually been selected.
function defaultPriceTarget() {
  const top = computeOpportunities("6m")[0];
  if (top) return { level: "l3", key: top.key };
  const entries = Object.entries(store.state.prices.products);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1].series.length - a[1].series.length);
  return { level: "l3", key: entries[0][0] };
}

// which period a newly selected target should open on. 6 months by default,
// but: a bubble is a claim ("Carrefour is cheaper") backed by specific
// observations, and if those sit outside 6 months the chart would show the
// bubble's colour on the list row with no way to check it; and a window that
// cannot draw a line (fewer than two points) is worth leaving for one that
// shows more. Either way the evidence is in "all time", so open there instead.
//
// The second test compares against the window rather than a fixed count, so a
// card whose only purchase predates the window - Bouillon, bought once in
// February 2025 - opens on all time and shows it, instead of reporting
// "nothing bought in this period" about a product that was in fact bought.
//
// Only ever consulted when the target changes. A period the user picked by
// hand is left exactly as picked, even when it draws an empty chart - the
// dropdown offers no year the target has no data in, so an empty year chart
// is a true answer ("one purchase, no trend"), not a dead end.
function defaultPeriodFor(series) {
  const bubbleStore = computeBubble(series);
  const in6m = seriesInPeriod(series, "6m");
  if (bubbleStore && !in6m.some((p) => p.store === bubbleStore)) return "all";
  if (in6m.length < 2 && series.length > in6m.length) return "all";
  return "6m";
}

// the one entry point every tap goes through, so a shopping-list tap and a
// Worth watching tap can never drift into two different behaviours: show
// this target's chart, and (v10 spec) scroll to it rather than silently
// updating off-screen.
function selectPriceTarget(target, opts = {}) {
  if (!target) return;
  target = narrowPriceTarget(target);
  const series = seriesForTarget(target);
  if (!series.length) return;
  pricesUiState.target = target;
  pricesUiState.openPill = null;
  pricesUiState.period = defaultPeriodFor(series);
  renderTrends();
  if (opts.scroll) {
    const card = document.querySelector(".trends-card");
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function goToPriceChart(target) {
  store.setView("prices");
  selectPriceTarget(target, { scroll: true });
}

// Reset (by the Trends title): back to the top Worth-watching item on the
// default 6-month, per-supermarket view - identical to tapping that row.
function resetTrends() {
  pricesUiState.groupBy = "supermarket";
  pricesUiState.openPill = null;
  const t = defaultPriceTarget();
  if (t) {
    selectPriceTarget(t, { scroll: true });
  } else {
    pricesUiState.target = null;
    pricesUiState.period = "6m";
    renderTrends();
  }
}

// the three Product pills, and clearing one. Picking a variant or product
// resets the pills below it; clearing (the x, or picking "All") drops the
// chart one pooling level up.
function pickPriceL1(l1, label) {
  selectPriceTarget({ level: "l1", l1, l1_label: label });
}
function pickPriceL2(l1, label, l2) {
  selectPriceTarget({ level: "l2", l1, l1_label: label, l2 });
}
function pickPriceL3(key) {
  selectPriceTarget({ level: "l3", key });
}
function clearPriceL2(info) {
  selectPriceTarget({ level: "l1", l1: info.l1, l1_label: info.l1_label });
}
function clearPriceL3(info) {
  if (info.l2) pickPriceL2(info.l1, info.l1_label, info.l2);
  else clearPriceL2(info);
}
function togglePricePill(which) {
  pricesUiState.openPill = pricesUiState.openPill === which ? null : which;
  renderTrends();
}

const OPP_COLLAPSED = 5;

function renderOpportunities() {
  const opps = computeOpportunities("6m");
  const list = $("#oppList");
  if (!opps.length) {
    list.innerHTML = `<li class="opp-empty">Nothing worth watching yet.</li>`;
    $("#oppToggle").hidden = true;
    return;
  }
  const shown = pricesUiState.oppOpen ? opps : opps.slice(0, OPP_COLLAPSED);
  // same shape as a shopping-list row: name left, then right-aligned a
  // qty-styled number and the price icon - and the same bubble rule
  // (v10 spec §6), so a coloured bubble means "clear cheapest store"
  // everywhere it shows up, not just on the list
  list.innerHTML = shown.map((o) => {
    const entry = store.state.prices.products[o.key];
    const bubbleStore = computeBubble(entry.series);
    const best6 = bestPriceInPeriod(entry.series, "6m");
    return `
    <li class="opp-row" data-price-key="${escapeHtml(o.key)}">
      <span class="opp-name">${escapeHtml(o.label)}</span>
      <span class="opp-price">${best6 ? `€${best6.price.toFixed(2)}/kg` : ""}</span>
      <span class="price-btn" aria-hidden="true">
        ${bubbleStore ? `<span class="price-bubble" style="background:${storeColor(bubbleStore)}"></span>` : ""}
        <svg viewBox="0 0 24 24" fill="none" stroke="${bubbleStore ? storeOnColor(bubbleStore) : "currentColor"}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${PRICE_ICON_DOWN_PATH}</svg>
      </span>
    </li>`;
  }).join("");
  $$(".opp-row", list).forEach((row) => {
    row.addEventListener("click", () =>
      selectPriceTarget({ level: "l3", key: row.dataset.priceKey }, { scroll: true }));
  });
  const toggle = $("#oppToggle");
  if (opps.length <= OPP_COLLAPSED) {
    toggle.hidden = true;
  } else {
    toggle.hidden = false;
    toggle.textContent = pricesUiState.oppOpen ? "Show less" : `Show all · ${opps.length}`;
  }
}

// what each line on the chart is: a supermarket (Group by = Supermarket), or a
// variant / product (Group by = Product). "variant" granularity gives a
// null-variant product its own line labelled by product, so they don't all
// collapse into one nameless line.
function lineGranularity(target) {
  if (pricesUiState.groupBy === "supermarket") return "store";
  return target.level === "l1" ? "variant" : "product";
}
function chartLines(points, granularity) {
  const groups = new Map();
  for (const p of points) {
    let id, label;
    if (granularity === "store") { id = p.store; label = p.store; }
    else if (granularity === "variant" && p.variant) { id = "v:" + p.variant; label = titleCaseVariant(p.variant); }
    else { id = "p:" + p.prodKey; label = p.prodLabel; }
    if (!groups.has(id)) groups.set(id, { id, label, points: [] });
    groups.get(id).points.push(p);
  }
  const lines = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  lines.forEach((ln, i) => {
    ln.color = granularity === "store" ? storeColor(ln.id) : lineColor(i);
  });
  return lines;
}

// dynamic per-item y-axis (v10 spec §5): a fixed scale would flatten a
// EUR 3/kg product to a hairline next to a EUR 60/kg one
function buildPriceChartSvg(lines) {
  const points = lines.flatMap((l) => l.points);
  const dates = [...points.map((p) => p.date)].sort();
  const t0 = new Date(dates[0]).getTime();
  const t1 = new Date(dates[dates.length - 1]).getTime();
  const prices = points.map((p) => p.price);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const pad = Math.max((hi - lo) * 0.15, hi * 0.05, 0.1);
  const yLo = Math.max(0, lo - pad), yHi = hi + pad;
  const X0 = 30, X1 = 310, Y0 = 14, Y1 = 126;
  const xOf = (d) => (t1 === t0 ? (X0 + X1) / 2 : X0 + (X1 - X0) * ((new Date(d).getTime() - t0) / (t1 - t0)));
  const yOf = (p) => Y1 - (Y1 - Y0) * ((p - yLo) / ((yHi - yLo) || 1));

  let svg = `<svg viewBox="0 0 320 148" class="price-svg">`;
  [yHi, (yHi + yLo) / 2, yLo].forEach((v) => {
    const y = yOf(v);
    svg += `<line x1="28" y1="${y.toFixed(1)}" x2="${X1}" y2="${y.toFixed(1)}" class="chart-grid"/>`;
    svg += `<text x="0" y="${(y + 3).toFixed(1)}" class="chart-axis">${v.toFixed(v < 10 ? 1 : 0)}</text>`;
  });

  lines.forEach((ln) => {
    const pts = [...ln.points].sort((a, b) => a.date.localeCompare(b.date));
    const color = ln.color;
    if (pts.length > 1) {
      const poly = pts.map((p) => `${xOf(p.date).toFixed(1)},${yOf(p.price).toFixed(1)}`).join(" ");
      svg += `<polyline points="${poly}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    pts.forEach((p) => {
      const cx = xOf(p.date).toFixed(1), cy = yOf(p.price).toFixed(1);
      const d = `data-date="${p.date}" data-store="${escapeHtml(p.store)}" data-prod="${escapeHtml(p.prodKey || "")}"`;
      svg += p.promo
        ? `<g class="price-pt" ${d}><circle cx="${cx}" cy="${cy}" r="8" fill="${color}"/><text x="${cx}" y="${(+cy + 3).toFixed(1)}" class="promo-mark" fill="${storeOnColor(p.store)}">€</text></g>`
        : `<circle class="price-pt" ${d} cx="${cx}" cy="${cy}" r="4" fill="${color}"/>`;
    });
  });
  return svg + `</svg>`;
}

// what a Category/Product pill shows when that level has nothing to offer -
// the same em dash the metric cards already use for "no value here"
const NO_LEVEL = "—";
// an unset level is not empty, it pools everything under it - so the pill says
// exactly what the dropdown's leading option says, and both are the one string
const ALL_VARIANTS = "All variants";
const ALL_PRODUCTS = "All products";

function priceOptRows(rows, currentId) {
  return rows.map((r) =>
    `<button type="button" class="pill-opt${r.id === currentId ? " on" : ""}" data-opt="${escapeHtml(r.id)}">${escapeHtml(r.label)}</button>`
  ).join("");
}

// every pill in the Trends card is this one button - the Category/Product
// filters and the Period/Group by dropdowns alike - so they cannot drift into
// two spellings of the same control. `opens` is the single switch: a pill that
// opens carries the data-pill the click handlers bind to, and one that does not
// is marked aria-disabled rather than disabled, so it stays announced and keeps
// the .pill colours instead of the browser's greyed-out ones.
// `trailing` is whatever sits after the label - a clear x, or a caret.
function pillButton({ which, text, extra = [], opens, trailing = "" }) {
  const cls = ["pill", ...extra.filter(Boolean)];
  // a pill that cannot open cannot be the open one, whatever openPill still
  // says - it can name a pill that lost its choices under a new target, and
  // the render that clears it runs after this
  if (opens && pricesUiState.openPill === which) cls.push("open");
  if (!opens) cls.push("dd-static");
  return `<button type="button" class="${cls.join(" ")}"` +
    `${opens ? ` data-pill="${which}"` : ` aria-disabled="true"`}>` +
    `<span class="pill-text">${escapeHtml(text)}</span>${trailing}</button>`;
}

// the Category row (L1 + L2) and the Product row (L3). Each pill is described
// by three facts and nothing else: `text`, `filled` (it names something, as
// opposed to holding a placeholder), and `opens` (tapping drops a dropdown).
// A pill that is filled but does not open is one there was no choice about;
// only a pill the user could undo carries an x.
//
// Exactly one pill wears the accent: the deepest filled one, because that is
// the thing on the chart. Picking a product moves the accent off the card and
// onto the product; a card pooled across its variants keeps it on L1. The
// levels above stay legible in grey - they still say where you are, they are
// just not the subject.
//
// A level with nothing to offer at all (a card with no variants, a variant
// with no products of its own) shows a dash rather than a placeholder naming a
// choice that does not exist. The open dropdown renders in a full-width host
// below both rows. Dropdowns cascade: L2 lists variants under L1, L3 lists
// products under L1 (and L2). L1 has a search box; L2/L3 never exceed ~15 rows.
function renderPricePills(target, info) {
  const catHost = $("#priceCatPills");
  const prodHost = $("#priceProdPills");
  const l1s = l1Options();
  const variants = l2Options(info.l1);
  const l3scope = l3Options(info.l1, info.l2 || null);

  // a variant is only shown as the forced scope when it really is the whole
  // card (soleVariant) - a card with one variant plus products outside it is
  // wider than that variant, and saying otherwise would misdescribe the chart
  const forcedVariant = soleVariant(info.l1);
  const pills = {
    l1: { text: info.l1_label, filled: true, opens: l1s.length > 1 },
    l2: forcedVariant ? { text: titleCaseVariant(forcedVariant), filled: true, opens: false }
      : !variants.length ? { text: NO_LEVEL, filled: false, opens: false }
      : info.l2 ? { text: titleCaseVariant(info.l2), filled: true, opens: true }
      : { text: ALL_VARIANTS, filled: false, opens: true },
    l3: l3scope.length === 1 ? { text: l3scope[0].label, filled: true, opens: false }
      : !l3scope.length ? { text: NO_LEVEL, filled: false, opens: false }
      : target.level === "l3" ? { text: info.label, filled: true, opens: true }
      : { text: ALL_PRODUCTS, filled: false, opens: true },
  };
  // the deepest filled level is the subject of the chart, and the only accent
  const accent = ["l3", "l2", "l1"].find((k) => pills[k].filled);

  const pill = (which) => {
    const p = pills[which];
    // clearable exactly when the pill holds a pick that can be undone
    const x = (p.filled && p.opens && which !== "l1")
      ? `<span class="pill-x" data-clear="${which}" aria-hidden="true">✕</span>` : "";
    return pillButton({
      which, text: p.text, opens: p.opens, trailing: x,
      extra: [which === accent && "sel", !p.filled && !p.opens && "pill-empty"],
    });
  };
  catHost.innerHTML = pill("l1") + pill("l2");
  prodHost.innerHTML = pill("l3");

  [catHost, prodHost].forEach((h) => {
    $$(".pill[data-pill]", h).forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.target.closest(".pill-x")) return;
        togglePricePill(b.dataset.pill);
      });
    });
    $$(".pill-x", h).forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (el.dataset.clear === "l2") clearPriceL2(info);
        else clearPriceL3(info);
      });
    });
  });

  // the open Product dropdown, in its own host below the pills row
  const panelHost = $("#pricePillPanel");
  const which = pricesUiState.openPill;
  if (!(pills[which] && pills[which].opens)) {
    // a pill that used to open can lose its choices under a new target
    if (pills[which]) pricesUiState.openPill = null;
    panelHost.hidden = true;
    panelHost.innerHTML = "";
    return;
  }
  let rows, currentId, withSearch = false;
  if (which === "l1") {
    rows = l1s.map((o) => ({ id: o.l1, label: o.label }));
    currentId = info.l1;
    withSearch = true;
  } else if (which === "l2") {
    rows = [{ id: "", label: ALL_VARIANTS }].concat(
      variants.map((v) => ({ id: v, label: titleCaseVariant(v) })));
    currentId = info.l2 || "";
  } else {
    rows = [{ id: "", label: ALL_PRODUCTS }].concat(
      l3scope.map((p) => ({ id: p.key, label: p.label })));
    currentId = target.level === "l3" ? target.key : "";
  }
  panelHost.hidden = false;
  panelHost.innerHTML = `<div class="pill-panel" data-panel="${which}">` +
    (withSearch ? `<input type="text" class="pill-search" placeholder="Search">` : "") +
    `<div class="pill-opts">${priceOptRows(rows, currentId)}</div></div>`;
  positionPillPanel(which === "l3" ? prodHost : catHost, which);

  $$(".pill-opt", panelHost).forEach((o) => {
    o.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = o.dataset.opt;
      if (which === "l1") { if (id !== info.l1) pickPriceL1(id, l1s.find((x) => x.l1 === id).label); else togglePricePill("l1"); }
      else if (which === "l2") { id ? pickPriceL2(info.l1, info.l1_label, id) : clearPriceL2(info); }
      else { id ? pickPriceL3(id) : (info.l2 ? pickPriceL2(info.l1, info.l1_label, info.l2) : clearPriceL2(info)); }
    });
  });
  const search = $(".pill-search", panelHost);
  if (search) {
    search.addEventListener("input", () => {
      const q = deburr(search.value).toLowerCase().trim();
      $$(".pill-opt", panelHost).forEach((o) => {
        o.hidden = q && !deburr(o.textContent).toLowerCase().includes(q);
      });
    });
  }
}

// Put the open dropdown directly under the pill it belongs to, floating over
// whatever is below it. The panel cannot simply live inside the pills row: that
// row scrolls horizontally and clips, so an anchored panel would be cut off.
// It sits instead in a host absolutely positioned within the Trends card, which
// is also what keeps the chart still when a dropdown opens - the host is out of
// the flow, so nothing below it moves. Left is clamped to the card so a pill
// near the right edge does not push the panel off it.
function positionPillPanel(host, which) {
  const panel = $("#pricePillPanel");
  const btn = $(`.pill[data-pill="${which}"]`, host);
  const body = $("#priceTrendsBody");
  if (!btn || !body) return;
  const b = body.getBoundingClientRect();
  const r = btn.getBoundingClientRect();
  panel.style.top = `${r.bottom - b.top + 6}px`;
  const maxLeft = Math.max(0, body.clientWidth - panel.offsetWidth);
  panel.style.left = `${Math.min(Math.max(0, r.left - b.left), maxLeft)}px`;
}

// Period and Group by: plain grey dropdowns (never accent), sitting on one
// line between the chart and the legend. `canGroup` is false when "by product"
// would draw a single line (one product/variant in scope) - then Group by is
// shown as static text with no caret, since there is nothing to switch to.
function renderPriceSubfilters(canGroup) {
  const groups = [["supermarket", "By supermarket"], ["product", "By product"]];

  const dd = (hostId, which, rows, currentId, onPick, interactive = true) => {
    const host = $(hostId);
    const cur = rows.find((r) => r[0] === currentId) || rows[0];
    const open = interactive && pricesUiState.openPill === which;
    host.innerHTML =
      pillButton({
        which, text: cur[1], opens: interactive, extra: ["dd-btn"],
        trailing: interactive ? `<span class="dd-caret" aria-hidden="true">▾</span>` : "",
      }) +
      (open ? `<div class="pill-panel dd-panel"><div class="pill-opts">` +
        priceOptRows(rows.map(([id, label]) => ({ id, label })), currentId) +
        `</div></div>` : "");
    if (!interactive) return;
    $(".pill", host).addEventListener("click", (e) => {
      e.stopPropagation();
      togglePricePill(which);
    });
    $$(".pill-opt", host).forEach((o) => {
      o.addEventListener("click", (e) => { e.stopPropagation(); onPick(o.dataset.opt); });
    });
  };

  dd("#pricePeriod", "period", PERIODS, pricesUiState.period, (id) => {
    pricesUiState.period = id;
    pricesUiState.openPill = null;
    renderTrends();
  });
  dd("#priceGroupBy", "group", groups, pricesUiState.groupBy, (id) => {
    pricesUiState.groupBy = id;
    pricesUiState.openPill = null;
    renderTrends();
  }, canGroup);
}

function renderTrends() {
  // first paint after data arrives: nothing has been tapped, so pick both the
  // target and its period the same way a tap would
  if (!pricesUiState.target) {
    const first = narrowPriceTarget(defaultPriceTarget());
    if (first) {
      pricesUiState.target = first;
      pricesUiState.period = defaultPeriodFor(seriesForTarget(first));
    }
  }
  const target = pricesUiState.target;
  const info = target && resolveTargetInfo(target);
  if (!info) {
    $("#priceNoData").hidden = false;
    $("#priceTrendsBody").hidden = true;
    $("#priceReset").hidden = true;
    return;
  }
  $("#priceNoData").hidden = true;
  $("#priceTrendsBody").hidden = false;
  $("#priceReset").hidden = false;

  // "by product" is only a real choice when it would draw more than one line -
  // judged on what the chosen period actually shows, not on the whole history,
  // or the dropdown offers a switch that changes nothing. Otherwise force
  // supermarket and drop the dropdown affordance.
  const filtered = seriesInPeriod(info.series, pricesUiState.period);
  const productGranularity = target.level === "l1" ? "variant" : "product";
  const canGroupByProduct = chartLines(filtered, productGranularity).length >= 2;
  if (!canGroupByProduct) pricesUiState.groupBy = "supermarket";

  renderPricePills(target, info);
  renderPriceSubfilters(canGroupByProduct);

  const granularity = lineGranularity(target);
  const lines = chartLines(filtered, granularity);
  $("#priceLegend").innerHTML = `<span class="rail-label">Legend</span>` + lines.map((ln) =>
    `<span class="legend-item"><span class="legend-dot" style="background:${ln.color}"></span>${escapeHtml(ln.label)}</span>`
  ).join("");

  const wrap = $("#priceChartWrap");
  if (filtered.length < 2) {
    wrap.hidden = true;
    wrap.innerHTML = "";
    // a hand-picked year is allowed to draw nothing, so say which nothing it
    // is: no purchases at all, or one purchase and therefore no line. "No
    // price history" would contradict the metrics still showing below.
    $("#priceEmpty").textContent = !filtered.length
      ? "Nothing bought in this period."
      : "Just one purchase here - no line to draw.";
    $("#priceEmpty").hidden = false;
  } else {
    wrap.hidden = false;
    $("#priceEmpty").hidden = true;
    wrap.innerHTML = buildPriceChartSvg(lines);
    $$(".price-pt", wrap).forEach((el) => {
      el.addEventListener("click", () => openPriceDetail({
        date: el.dataset.date, store: el.dataset.store, prodKey: el.dataset.prod,
      }));
    });
  }

  // "Latest price" is always the most recent purchase, whatever the period
  // chip is set to - it answers "what did I pay", not "what did the chart
  // just draw". Under Group by = Product several products can share that
  // latest date; there is then no single "latest price", so it shows a dash.
  // "Best price" follows the period chip and relabels itself, and is the
  // single cheapest point across everything in view + where it was bought.
  const maxDate = info.series.reduce((m, p) => (p.date > m ? p.date : m), "");
  const onLatest = info.series.filter((p) => p.date === maxDate);
  if (!onLatest.length) {
    $("#priceLastValue").innerHTML = `<span class="metric-none">—</span>`;
    $("#priceLastStore").innerHTML = "";
  } else if (granularity !== "store" && onLatest.length > 1) {
    $("#priceLastValue").innerHTML = `<span class="metric-none">—</span>`;
    $("#priceLastStore").innerHTML = "";
  } else {
    const last = onLatest.reduce((a, b) => (b.price < a.price ? b : a));
    $("#priceLastValue").innerHTML = `€${last.price.toFixed(2)}<span class="metric-unit">/kg</span>`;
    $("#priceLastStore").innerHTML = `<span class="legend-dot" style="background:${storeColor(last.store)}"></span>${escapeHtml(last.store)}`;
  }

  const bestInPeriod = bestPriceInPeriod(info.series, pricesUiState.period);
  $("#priceBestLabel").textContent = `Best price · ${PERIOD_SHORT[pricesUiState.period]}`;
  if (bestInPeriod) {
    $("#priceBestValue").innerHTML = `€${bestInPeriod.price.toFixed(2)}<span class="metric-unit">/kg</span>`;
    $("#priceBestStore").innerHTML = `<span class="legend-dot" style="background:${storeColor(bestInPeriod.store)}"></span>${escapeHtml(bestInPeriod.store)}`;
    $("#priceMetrics").hidden = false;
  } else {
    $("#priceMetrics").hidden = true;
  }

  $("#priceSeeAll").textContent = `See all · ${purchaseRows(info.series).length}`;
}

function renderPrices(state) {
  renderOpportunities();
  renderTrends();
}

// See-all rows show only day + month - the year is a full-width bar above each
// year's block. Own month list because en-GB's "short" gives a 4-letter "Sept".
const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDayMonth(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${Number(d)} ${MONTHS_ABBR[Number(m) - 1]}`;
}

// the "See all" list: one row per (date, product, store), so buying two of the
// same thing at the same shop on one trip is a single line with a quantity, not
// two identical rows. Newest first, then by product name, then store.
function purchaseRows(series) {
  const groups = new Map();
  for (const p of series) {
    const k = p.date + "|" + (p.prodKey || "") + "|" + p.store;
    if (!groups.has(k)) {
      groups.set(k, {
        date: p.date, prodKey: p.prodKey, prodLabel: p.prodLabel,
        variant: p.variant, store: p.store, pts: [],
      });
    }
    groups.get(k).pts.push(p);
  }
  return [...groups.values()].sort((a, b) =>
    b.date.localeCompare(a.date) ||
    (a.prodLabel || "").localeCompare(b.prodLabel || "") ||
    a.store.localeCompare(b.store));
}

function renderPriceDetail() {
  if (!priceDetailState || !pricesUiState.target) return;
  const { highlight } = priceDetailState;
  const target = pricesUiState.target;
  const info = resolveTargetInfo(target);
  if (!info) return;

  const title = target.level === "l3" ? info.label
    : target.level === "l2" ? info.l2 : info.l1_label;
  const tags = target.level === "l3" ? [info.l1_label, info.l2]
    : target.level === "l2" ? [info.l1_label] : [];
  $("#priceDetailTitle").textContent = title;
  $("#priceDetailTags").innerHTML = tags.filter(Boolean).map((t) =>
    `<span class="detail-tag">${escapeHtml(t)}</span>`
  ).join("");

  // same columns at every level: date (day + month only), the most-granular
  // name, store, qty, price. One CSS grid holds the header and every row, so a
  // column is one track shared by all of them - guaranteed alignment. Date,
  // qty and price are max-content; product and store split what's left and
  // clip with an ellipsis until the row is tapped open. `.price-row` is
  // display:contents so it can still carry the row's hi / expanded state.
  // Rows run newest first, split into per-year blocks under a full-width bar.
  const cell = (cls, inner) => `<div class="pt-cell ${cls}">${inner}</div>`;
  const head =
    `<div class="price-row pt-headrow">` +
    ["Date", "Product", "Store", "Qty", "€/kg"].map((h) => cell("pt-head", h)).join("") +
    `</div>`;

  let lastYear = null;
  const rows = purchaseRows(info.series).map((g) => {
    // the cheapest point in the group is the one shown, so the promo pill is
    // that point's own flag - never a sibling's
    const shown = g.pts.reduce((a, b) => (b.price < a.price ? b : a));
    const priceText = `€${shown.price.toFixed(2)}`;
    const item = g.prodLabel || titleCaseVariant(g.variant) || info.l1_label;
    // a pooled L1/L2 view can hold several products bought at one store on one
    // day, so the product is part of what identifies the tapped dot's row
    const isHi = highlight && highlight.date === g.date && highlight.store === g.store &&
      (!highlight.prodKey || highlight.prodKey === g.prodKey);
    const year = g.date.slice(0, 4);
    const bar = year === lastYear ? "" : `<div class="pt-year">${year}</div>`;
    lastYear = year;
    return bar +
      `<div class="price-row${isHi ? " hi" : ""}">` +
      cell("price-date", escapeHtml(formatDayMonth(g.date))) +
      cell("price-item", escapeHtml(item)) +
      cell("price-store", `<span class="legend-dot" style="background:${storeColor(g.store)}"></span><span class="price-store-name">${escapeHtml(g.store)}</span>`) +
      cell("price-qty", g.pts.length) +
      // a promo price sits in an accent pill instead of carrying a marker
      cell("price-value", shown.promo ? `<span class="promo-price">${priceText}</span>` : priceText) +
      `</div>`;
  }).join("");

  const table = $("#priceTable");
  table.innerHTML = head + rows;

  // a long product or store name is clipped to one line; tapping the row
  // unclips both and the row grows to fit
  $$(".price-row:not(.pt-headrow)", table).forEach((r) => {
    r.addEventListener("click", () => r.classList.toggle("expanded"));
  });
}

function scrollToHighlightedRow() {
  requestAnimationFrame(() => {
    // .price-row is display:contents (no box of its own) - scroll its first cell
    const el = document.querySelector("#priceDetail .price-row.hi .pt-cell");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

function renderSettings(state) {
  $$("#setWho button").forEach((b) => {
    b.classList.toggle("on", b.dataset.who === state.settings.who);
  });
  $$("#setPalette button").forEach((b) => {
    b.classList.toggle("on", b.dataset.palette === (state.settings.palette || "cobalt"));
  });

  const ctf = $("#customThemeField");
  ctf.hidden = state.settings.palette !== "custom";
  if (!ctf.hidden) renderCustomGrid(state);

  const t = $("#setToken");
  if (document.activeElement !== t) t.value = state.settings.token || "";

  const st = $("#tokenStatus");
  st.hidden = tokenStatus.state === "idle";
  st.textContent = tokenStatus.text;
  st.className = "token-status " + tokenStatus.state;

  renderSyncStatus();
  renderAdvanced();
  // Both live inside the Advanced disclosure. renderDisplayDiag in particular
  // appends a probe element and forces a synchronous layout to read the safe
  // -area insets; doing that on every store change, collapsed and unseen, was
  // pure waste.
  if (advancedOpen) {
    renderUpdateStatus();
    renderDisplayDiag();
  }

  const rb = $("#refreshBtn");
  if (rb.textContent !== "Syncing...") {
    rb.disabled = !state.settings.token;
    rb.textContent = "Sync now";
    rb.removeAttribute("title");
  }
}

/* the sync section: connection, queue depth, last-synced. rebuilt on each
   render and by a slow timer so "5 minutes ago" keeps advancing. */
let advancedOpen = false;   // Settings > Advanced settings disclosure

function renderAdvanced() {
  const fields = $("#advancedFields");
  const caret = $("#advancedCaret");
  const btn = $("#advancedToggle");
  if (!fields || !caret || !btn) return;
  fields.hidden = !advancedOpen;
  caret.textContent = advancedOpen ? "▾" : "▸";
  btn.setAttribute("aria-expanded", String(advancedOpen));
}

/* ---------- app update (Settings > Update) ---------- */
/* The toast on `controllerchange` only helps if the app happens to be open
   when the browser notices a new worker, which on a phone it usually is not.
   This is the manual path: ask the registration to re-fetch the worker
   script, report honestly what came back, and reload once it has taken over. */

let updateState = { kind: "idle", version: null, checkedAt: null };

// ask the controlling worker which VERSION it is running
function swVersion() {
  return new Promise((resolve) => {
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!sw) return resolve(null);
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), 1500);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve((e.data && e.data.version) || null);
    };
    try { sw.postMessage({ type: "version" }, [ch.port2]); }
    catch (err) { clearTimeout(t); resolve(null); }
  });
}

// resolves when an incoming worker finishes installing, or rejects if it fails
function whenSettled(worker) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (worker.state === "activated") resolve("activated");
      else if (worker.state === "installed") resolve("installed");
      else if (worker.state === "redundant") reject(new Error("install failed"));
    };
    worker.addEventListener("statechange", check);
    check();
  });
}

async function checkForUpdate() {
  if (!("serviceWorker" in navigator) || IS_LOCAL_DEV) {
    updateState = { ...updateState, kind: "unsupported" };
    renderUpdateStatus();
    return;
  }
  updateState = { ...updateState, kind: "checking" };
  renderUpdateStatus();

  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      updateState = { ...updateState, kind: "unsupported" };
      renderUpdateStatus();
      return;
    }

    await reg.update();
    const incoming = reg.installing || reg.waiting;

    if (!incoming) {
      updateState = { kind: "current", version: await swVersion(), checkedAt: Date.now() };
      renderUpdateStatus();
      return;
    }

    updateState = { ...updateState, kind: "installing" };
    renderUpdateStatus();

    const state = await whenSettled(incoming);
    // install() calls skipWaiting, but nudge a worker the browser held back
    if (state === "installed") incoming.postMessage({ type: "skipWaiting" });

    updateState = { ...updateState, kind: "ready", checkedAt: Date.now() };
    renderUpdateStatus();
  } catch (e) {
    updateState = { ...updateState, kind: "error", checkedAt: Date.now() };
    renderUpdateStatus();
  }
}

let versionAsked = false;
function renderUpdateStatus() {
  const box = $("#updateStatus");
  const btn = $("#updateBtn");
  if (!box || !btn) return;

  // fill the version line in the background the first time Settings renders
  if (!versionAsked && !updateState.version && !IS_LOCAL_DEV) {
    versionAsked = true;
    swVersion().then((v) => {
      if (!v) return;
      updateState = { ...updateState, version: v };
      renderUpdateStatus();
    });
  }

  const lines = [];

  if (updateState.version) lines.push(["muted", `Version ${updateState.version}`]);

  const busy = updateState.kind === "checking" || updateState.kind === "installing";
  btn.disabled = busy;
  btn.textContent = updateState.kind === "ready" ? "Restart to finish" : "Check for updates";

  if (updateState.kind === "checking") {
    lines.push(["muted", "Checking…"]);
  } else if (updateState.kind === "installing") {
    lines.push(["muted", "New version found, downloading…"]);
  } else if (updateState.kind === "ready") {
    lines.push(["ok", "New version ready"]);
  } else if (updateState.kind === "current") {
    lines.push(["ok", "Up to date"]);
  } else if (updateState.kind === "error") {
    lines.push(["error", "Check failed. Try again when you have signal."]);
  } else if (updateState.kind === "unsupported") {
    lines.push(["muted", "Updates apply on reload here"]);
  } else if (IS_LOCAL_DEV) {
    lines.push(["muted", "Updates apply on reload here"]);
  } else if (!updateState.checkedAt) {
    lines.push(["muted", "Not checked yet"]);
  }

  if (updateState.kind !== "ready" && updateState.checkedAt) {
    const ago = timeAgo(updateState.checkedAt);
    if (ago) lines.push(["muted", `Checked ${ago}`]);
  }

  box.innerHTML = lines
    .map(([k, text]) => `<span class="sync-line ${k}"><i></i>${escapeHtml(text)}</span>`)
    .join("");
}

/* Does the window draw edge-to-edge, behind the system bars? If it does the
   safe-area insets are non-zero and the bars are transparent over our own
   --bg - the v9.11 header padding then closes the seam for free. Can only be
   read on the phone, so the app reports it. (Previously shipped in v9.9,
   removed in v9.10, restored once v9.11 gave the reading something to drive.) */
function renderDisplayDiag() {
  const box = $("#displayDiag");
  if (!box) return;
  const mode = ["fullscreen", "standalone", "minimal-ui"]
    .find((m) => matchMedia(`(display-mode: ${m})`).matches) || "browser";
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;" +
    "padding-top:env(safe-area-inset-top,0px);" +
    "padding-bottom:env(safe-area-inset-bottom,0px);";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const top = Math.round(parseFloat(cs.paddingTop) || 0);
  const bottom = Math.round(parseFloat(cs.paddingBottom) || 0);
  probe.remove();
  const vh = Math.round(window.innerHeight);
  const sh = Math.round((screen && screen.height) || 0);
  const edge = top > 0 || bottom > 0;
  const lines = [
    ["muted", `Window ${mode}`],
    [edge ? "ok" : "warn", `Safe area top ${top}px · bottom ${bottom}px`],
    ["muted", sh > 0
      ? `Viewport ${vh}px of ${sh}px screen · ${sh - vh}px is bars`
      : `Viewport ${vh}px (screen size unavailable)`],
    [edge ? "ok" : "warn", edge
      ? "Edge to edge - the page reaches under the bars"
      : "Not edge to edge - the bars are their own strip"],
  ];
  box.innerHTML = lines
    .map(([k, text]) => `<span class="sync-line ${k}"><i></i>${escapeHtml(text)}</span>`)
    .join("");
}

function renderSyncStatus() {
  const box = $("#syncStatus");
  if (!box) return;
  const lines = [];
  if (!store.state.settings.token) {
    lines.push(["warn", "No token set"]);
  } else if (syncState.kind === "unauthorized") {
    lines.push(["error", "Token rejected"]);
  } else if (syncState.kind === "offline") {
    lines.push(["warn", "Offline"]);
  } else if (syncState.kind === "rateLimited") {
    lines.push(["warn", `GitHub busy, retrying at ${hhmm(syncState.resetAt)}`]);
  } else if (syncing || flushing) {
    lines.push(["muted", "Syncing now…"]);
  } else {
    lines.push(["ok", "Connected"]);
  }

  const q = store.queue.length;
  if (q) lines.push(["warn", `${q} change${q === 1 ? "" : "s"} waiting to sync`]);

  const ago = timeAgo(store.sync.syncedAt);
  lines.push(["muted", ago ? `Last synced ${ago}` : "Not synced yet"]);

  box.innerHTML = lines
    .map(([k, text]) => `<span class="sync-line ${k}"><i></i>${escapeHtml(text)}</span>`)
    .join("");
}

function ctCell(mode, tok, v) {
  return `<span class="ct-cell">
    <span class="ct-prev" data-prev="${mode}:${tok}" style="background:${escapeHtml(v)}"></span>
    <input class="ct-hex" data-mode="${mode}" data-token="${tok}" value="${escapeHtml(v)}"
           inputmode="text" autocapitalize="off" autocorrect="off"
           spellcheck="false" maxlength="7" enterkeyhint="done" />
  </span>`;
}

let customGridBuilt = false;
function renderCustomGrid(state) {
  const grid = $("#customGrid");
  if (!grid) return;
  const c = state.settings.custom || seedCustom();
  const val = (mode, tok) => (c[mode] && c[mode][tok]) || "#000000";
  if (!customGridBuilt) {
    grid.innerHTML =
      `<div class="ct-head"><span></span><span>Light</span><span>Dark</span></div>` +
      CUSTOM_TOKENS.map((tok) => `<div class="ct-row">
        <span class="ct-name">${escapeHtml(TOKEN_LABELS[tok] || tok)}</span>
        ${ctCell("light", tok, val("light", tok))}
        ${ctCell("dark", tok, val("dark", tok))}
      </div>`).join("");
    customGridBuilt = true;
  } else {
    // keep in sync when values change from elsewhere, but never fight the caret
    ["light", "dark"].forEach((mode) => CUSTOM_TOKENS.forEach((tok) => {
      const inp = grid.querySelector(`.ct-hex[data-mode="${mode}"][data-token="${tok}"]`);
      const prev = grid.querySelector(`.ct-prev[data-prev="${mode}:${tok}"]`);
      const v = val(mode, tok);
      if (inp && document.activeElement !== inp) inp.value = v;
      if (prev) prev.style.background = v;
    }));
  }
}

/* ---------- top-level render ---------- */

// show the back-to-top button once the shopping list is scrolled past ~200px
function updateToTop() {
  const btn = $("#toTop");
  if (!btn) return;
  const sc = document.scrollingElement || document.documentElement;
  btn.classList.toggle("show", store.state.view === "list" && sc.scrollTop > 200);
}

function render(state) {
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
  if (state.view === "settings") renderSettings(state);
  updateToTop();
}

/* ---------- wiring ---------- */

function wire() {
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
    checkedOpen = !checkedOpen;
    render(store.state);
  });
  $("#tidyChecked").addEventListener("click", tidyChecked);

  $("#oppToggle").addEventListener("click", () => {
    pricesUiState.oppOpen = !pricesUiState.oppOpen;
    renderOpportunities();
  });
  $("#priceSeeAll").addEventListener("click", () => openPriceDetail());
  $("#priceReset").addEventListener("click", resetTrends);

  // tapping anywhere outside an open Trends dropdown closes it
  document.addEventListener("click", (e) => {
    if (pricesUiState.openPill &&
        !e.target.closest("#priceCatPills, #priceProdPills, #pricePillPanel, .price-subfilters")) {
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
  $("#customGrid").addEventListener("input", (e) => {
    const inp = e.target.closest(".ct-hex");
    if (!inp) return;
    let v = inp.value.trim();
    if (/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) v = "#" + v; // tolerate a pasted "aabbcc"
    if (!HEX_RE.test(v)) { inp.classList.add("bad"); return; }
    inp.classList.remove("bad");
    if (v !== inp.value) inp.value = v;
    store.setCustomToken(inp.dataset.mode, inp.dataset.token, v);
    const prev = inp.parentElement.querySelector(".ct-prev");
    if (prev) prev.style.background = v;
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
    tokenStatus = { state: "idle", text: "" };
    syncState = { kind: "idle", resetAt: null };
    render(store.state);
  });

  $("#advancedToggle").addEventListener("click", () => {
    advancedOpen = !advancedOpen;
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

/* ---------- sync engine (Tasks 6-8) ---------- */

// one sync at a time; every entry point checks these
let syncing = false;
let flushing = false;
let flushTimer;

const KNOWN_GH = ["offline", "unauthorized", "rateLimited", "notFound", "conflict"];

let rateLimitTimer;

// a sync attempt finished cleanly: clear any lingering error state
function syncOk() {
  if (syncState.kind !== "idle") {
    syncState = { kind: "idle", resetAt: null };
    render(store.state);
  }
}

// a sync attempt failed: turn the typed error into a banner state
function syncFailed(e, where) {
  if (!e || !KNOWN_GH.includes(e.gh)) console.warn(`${where}:`, e);
  if (!e) return;
  if (e.gh === "offline") syncState = { kind: "offline", resetAt: null };
  else if (e.gh === "unauthorized") syncState = { kind: "unauthorized", resetAt: null };
  else if (e.gh === "rateLimited") {
    syncState = { kind: "rateLimited", resetAt: e.resetAt || null };
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

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushQueue, FLUSH_DEBOUNCE_MS);
}

// push pending list changes to GitHub: GET -> replay -> PUT, retry on 409
async function flushQueue() {
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

async function syncRecipes() {
  const r = await github.getFile(github.config.recipesPath, { etag: store.sync.recipesEtag });
  if (r.notModified) return;
  store.state.recipes = r.json.recipes || [];
  iconCache.clear(); // names / categories may have moved under the cached art
  store.sync.recipesSha = r.sha;
  store.sync.recipesEtag = r.etag;
  store.saveRecipes();
  store.saveSync();
}

async function syncPrices() {
  const r = await github.getFile(github.config.pricesPath, { etag: store.sync.pricesEtag });
  if (r.notModified) return;
  const doc = r.json || {};
  store.state.prices = { products: doc.products || {}, resolve: doc.resolve || {} };
  store.sync.pricesSha = r.sha;
  store.sync.pricesEtag = r.etag;
  store.savePrices();
  store.saveSync();
}

async function syncList() {
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
async function fullSync() {
  if (syncing || !store.state.settings.token) return;
  syncing = true;
  render(store.state); // spinner on
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
  } finally {
    syncing = false;
    render(store.state);
  }
  flushQueue();
}

/* ---------- background poll (Task 6d) ---------- */

let pollTimer = null;
let pollSecs = 0;

// one conditional GET of the list; cheap when nothing changed (304)
function pollTick() {
  if (document.hidden || !store.state.settings.token) return;
  if (syncing || flushing) return;
  const v = store.state.view;
  if (v !== "list" && v !== "planner") return;
  syncing = true;
  syncList()
    .catch((e) => syncFailed(e, "poll"))
    .finally(() => {
      syncing = false;
      render(store.state);
      startPolling(); // GitHub may have asked for a slower cadence just now
    });
}

// Idempotent, and re-runnable: github.pollInterval moves whenever GitHub sends
// an X-Poll-Interval header, so re-arm the timer when the rate has changed.
// Reading it once at boot meant the header was recorded and then ignored.
function startPolling() {
  const secs = Math.max(60, Number(github.pollInterval) || 60);
  if (pollTimer && secs === pollSecs) return;
  clearInterval(pollTimer);
  pollSecs = secs;
  pollTimer = setInterval(pollTick, secs * 1000);
}

// "14:32" from an ISO string or epoch ms
function hhmm(t) {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// relative time for the "last synced" line
function timeAgo(iso) {
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
function showTapBanner(msg, onTap) {
  showBanner(msg);
  const b = $("#banner");
  b.classList.add("banner-tap");
  b.onclick = onTap;
}

let flashTimer;
function flashBanner(msg) {
  showBanner(msg);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $("#banner").hidden = true; }, 3500);
}

/* ---------- pull to sync (per tab) ---------- */

// pull-to-refresh on a tab: sync just that tab's data
async function syncCurrentTab() {
  if (syncing || !store.state.settings.token) {
    return new Promise((r) => setTimeout(r, 400)); // still feel the gesture
  }
  syncing = true;
  render(store.state); // spinner on
  try {
    const v = store.state.view;
    if (v === "recipes") await syncRecipes();
    if (v === "recipes" || v === "list" || v === "planner") await syncList();
  } catch (e) {
    syncFailed(e, "syncCurrentTab");
  } finally {
    syncing = false;
    render(store.state);
  }
  flushQueue();
}

function syncHeaderHeight() {
  const h = $(".app-header").offsetHeight;
  document.documentElement.style.setProperty("--header-h", h + "px");
}

function initPullToSync() {
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

  const atTop = () =>
    scroller.scrollTop <= 0 && $("#recipeDetail").hidden && $("#suggestions").hidden;

  document.addEventListener("touchstart", (e) => {
    if (busy || e.touches.length !== 1 || !atTop()) { pulling = false; return; }
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

/* ---------- boot ---------- */

store.load();                       // list + recipes + sync meta from the cache
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
    .then((arr) => {
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
