/* Spoon. Phase 2: offline-first cache of the shared list + recipes, kept
   in sync with a private GitHub repo. */
"use strict";

/* ---------- store ---------- */

const LS_LIST = "foodapp.list";        // the shopping list, optimistic working copy
const LS_SETTINGS = "foodapp.settings";
const LS_RECIPES = "foodapp.recipes";  // last-synced recipes (offline cache)
const LS_SYNC = "foodapp.sync";        // { listSha, listEtag, recipesSha, recipesEtag, syncedAt }
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
  },
  sync: { listSha: null, listEtag: null, recipesSha: null, recipesEtag: null, syncedAt: null },
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
    // tapping Recipes again while its sheet is up closes the sheet (animated)
    if (sheetOpen && v === "recipes" && this.state.view === "recipes") {
      closeRecipe();
      return;
    }
    // leaving Recipes with a sheet open: stash it, no swoop-down
    if (sheetOpen && v !== "recipes") parkRecipe();
    this.state.view = v;
    this.notify();
    // coming back to Recipes: bring the stashed sheet straight back
    if (sheetOpen && v === "recipes") unparkRecipe();
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
      this.enqueue({ t: "check", id, checked: it.checked });
      this.saveList(); this.notify();
    }
  },
  uncheckItem(id) {
    if (this.readOnly()) return;
    const it = this.state.list.find((x) => x.id === id);
    if (it && it.checked) {
      it.checked = false;
      this.enqueue({ t: "check", id, checked: false });
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

const deburr = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

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
  recipes: "Recipes",
  planner: "Meal Planner",
  settings: "Settings",
};

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

function itemRow(it) {
  const li = document.createElement("li");
  li.className = it.checked ? "checked" : "";
  const qtyStr = it.qty != null ? `${it.qty}${it.unit ? " " + it.unit : ""}` : "";
  li.innerHTML = `
    <button class="tick" aria-label="Toggle">${it.checked ? "✓" : ""}</button>
    <span class="main">
      <span class="nm">${escapeHtml(it.name)}</span>
      ${it.note ? `<span class="sub">${escapeHtml(it.note)}</span>` : ""}
      ${qtyStr ? `<span class="qty">${escapeHtml(qtyStr)}</span>` : ""}
    </span>
    <button class="del" aria-label="Remove">✕</button>`;
  $(".tick", li).addEventListener("click", () => store.toggleItem(it.id));
  $(".del", li).addEventListener("click", () => store.deleteItem(it.id));
  return li;
}

function renderList(state) {
  const active = state.list.filter((x) => !x.checked);
  const checked = state.list.filter((x) => x.checked);

  $("#addName").disabled = store.readOnly();

  const badge = $("#listBadge");
  badge.textContent = active.length > 99 ? "99+" : String(active.length);
  badge.hidden = active.length === 0;

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

/* group ticked items that differ only by a trailing quantity / size note,
   keep the tidiest */
function tidyKey(name) {
  let s = deburr(name).replace(/\s+/g, " ").trim();
  let prev;
  do {
    prev = s;
    s = s
      .replace(/[.,;]+$/, "")
      // trailing bracketed size note, e.g. "(2x400g)", "[500 g]" - only when
      // it contains a digit, so real descriptors ("(spicy)", "(Keisy)") stay
      .replace(/\s*[([][^()[\]]*\d[^()[\]]*[)\]]$/, "")
      // trailing loose quantity, e.g. " 400g", " x2", " 1.5 l"
      .replace(/\s+(?:x\s*)?\d+(?:[.,]\d+)?\s*(?:kg|g|mg|l|ml|cl|pcs?|pc|x)?$/i, "")
      .trim();
  } while (s !== prev);
  return s;
}

function tidyChecked() {
  const groups = new Map();
  for (const it of store.state.list) {
    if (!it.checked) continue;
    const key = tidyKey(it.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const drop = new Set();
  for (const items of groups.values()) {
    if (items.length < 2) continue;
    // keep the shortest name (trailing quantities make the others longer)
    items.sort(
      (a, b) =>
        a.name.trim().length - b.name.trim().length ||
        a.name.localeCompare(b.name),
    );
    for (const it of items.slice(1)) drop.add(it.id);
  }

  if (!drop.size) {
    flashBanner("Nothing to clean up.");
    return;
  }
  store.removeMany([...drop]);
  flashBanner(`Removed ${drop.size} duplicate ticked item${drop.size === 1 ? "" : "s"}.`);
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
    if (typeof foodPixelIcon === "function") {
      li.appendChild(foodPixelIcon(r.name, r.category, 38));
    }
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

window.addEventListener("popstate", () => {
  sheetHasHistory = false;
  if (detailState == null) return;
  if ($("#recipeDetail").hidden) {
    detailState = null; // parked on another tab: back gesture just discards it
  } else {
    slideSheetDown();
  }
});

// tap or swipe-down on the tinted name bar closes the sheet
function initSheetDrag() {
  const bar = $("#detailBar");
  const el = $("#recipeDetail");
  let startY = 0;
  let dy = 0;
  let dragging = false;
  let moved = false;

  bar.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || sheetClosing) return;
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
      closeRecipe(); // tap, or dragged far enough -> close (CSS finishes the slide)
    }
    // otherwise: transform cleared -> springs back to translate(-50%, 0)
  }, { passive: false });

  bar.addEventListener("click", () => closeRecipe());
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

function renderDetail() {
  const { recipe } = detailState;

  // index-only entry: no card written yet. Show the name + where to cook it
  // from, nothing to scale.
  if (recipe.stub) {
    $("#detailBar").innerHTML = `<span class="rname">${escapeHtml(recipe.name)}</span>`;
    const tags = [recipe.cuisine, recipe.category].filter(Boolean)
      .map((x) => `<span class="stub-tag">${escapeHtml(cap(x))}</span>`).join("");
    const links = (recipe.sources || []).map((u, i) =>
      `<a class="stub-link" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">
         Open recipe${recipe.sources.length > 1 ? " " + (i + 1) : ""} &nearr;</a>`).join("");
    $("#detailBody").innerHTML = `
      <div class="stub-body">
        ${tags ? `<div class="stub-tags">${tags}</div>` : ""}
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

  const addMode = detailState.addMode;
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

  $("#detailBar").innerHTML = `<span class="rname">${escapeHtml(recipe.name)}</span>`;

  $("#detailBody").innerHTML = `
    <div class="scaler">
      <span class="scaler-label">Servings</span>
      <div class="bubbles">${bubbles}${customBubble}</div>
      <button class="reset" id="resetScale">Reset</button>
    </div>
    <div class="ing-head">
      <h3>Ingredients</h3>
      <button type="button" id="ingAddToggle" class="ing-add-toggle${addMode ? " on" : ""}" aria-label="${addMode ? "Stop adding to shopping list" : "Add ingredients to shopping list"}">${ICON.cart}</button>
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
      } else {
        if (!existing) {
          let qty = null, unit = null;
          if (ing.qty != null) {
            qty = scaled ? scaleQty(ing, factor) : ing.qty;
            unit = ing.unit;
          }
          store.addItem({
            name: ing.conceptName || ing.name,
            qty, unit,
            note: [ing.variantHint, ing.note].filter(Boolean).join(", ") || null,
            source: key,
            slug: ing.slug || null,
          });
        }
        detailState.added.add(i);
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
    await github.getFile(github.config.recipesPath); // proves repo access
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
  renderUpdateStatus();
  renderDisplayDiag();
  renderAdvanced();

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

  renderList(state);
  if (state.view === "recipes") renderRecipes(state);
  if (state.view === "settings") renderSettings(state);
}

/* ---------- wiring ---------- */

function wire() {
  $$(".bottom-nav button").forEach((b) => {
    b.addEventListener("click", () => store.setView(b.dataset.view));
  });

  $$("#cuisineFilters, #mainFilters").forEach((rail) => {
    rail.addEventListener("scroll", () => updateRailFade(rail), { passive: true });
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

  let resizeTimer;
  window.addEventListener("resize", () => {
    $$("#cuisineFilters, #mainFilters").forEach(updateRailFade);
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
    renderAdvanced();
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
      if (it) it.checked = op.checked;
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

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushQueue, 800);
}

// push pending list changes to GitHub: GET -> replay -> PUT, retry on 409
async function flushQueue() {
  if (flushing || !store.state.settings.token || store.queue.length === 0) return;
  flushing = true;
  render(store.state); // spinner on
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ops = store.queue.slice();
      const flushedIds = new Set(ops.map((o) => o.opId));
      const remote = await github.getFile(github.config.listPath);
      const base = remote.notModified ? [] : (remote.json.items || []);
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
        syncOk();
        store.notify();
        return;
      } catch (e) {
        if (e.gh === "conflict") continue; // sha moved: re-GET, re-replay
        throw e;
      }
    }
  } catch (e) {
    syncFailed(e, "flushQueue"); // offline / rateLimited / unauthorized: keep the queue
  } finally {
    flushing = false;
    render(store.state); // repaint with the flag cleared
  }
}

async function syncRecipes() {
  const r = await github.getFile(github.config.recipesPath, { etag: store.sync.recipesEtag });
  if (r.notModified) return;
  store.state.recipes = r.json.recipes || [];
  store.sync.recipesSha = r.sha;
  store.sync.recipesEtag = r.etag;
  store.saveRecipes();
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
  } finally {
    syncing = false;
    render(store.state);
  }
  flushQueue();
}

/* ---------- background poll (Task 6d) ---------- */

let pollTimer = null;

// one conditional GET of the list; cheap when nothing changed (304)
function pollTick() {
  if (document.hidden || !store.state.settings.token) return;
  if (syncing || flushing) return;
  const v = store.state.view;
  if (v !== "list" && v !== "planner") return;
  syncing = true;
  syncList()
    .catch((e) => syncFailed(e, "poll"))
    .finally(() => { syncing = false; render(store.state); });
}

function startPolling() {
  if (pollTimer) return;
  const secs = Math.max(60, Number(github.pollInterval) || 60);
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

function showBanner(msg) {
  const b = $("#banner");
  b.textContent = msg;
  b.hidden = false;
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
  syncHeaderHeight();
  window.addEventListener("resize", syncHeaderHeight);
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
render(store.state);                 // paint the cache immediately, before any network
if (store.state.settings.token) {
  checkToken();                      // "Connected as ..."; on success it kicks fullSync
}
startPolling();                      // no-ops each tick until there is a token

// dev-only: on the local server with no token, load a bundled recipes snapshot
// so the Recipes tab is browsable without GitHub. Never runs on the real site.
if (["localhost", "127.0.0.1"].includes(location.hostname) &&
    !store.state.settings.token && store.state.recipes.length === 0) {
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
    const b = $("#banner");
    b.textContent = "New version. Tap to reload.";
    b.hidden = false;
    b.classList.add("banner-tap");
    b.onclick = () => location.reload();
  });
}
