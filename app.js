/* Kave Food, Phase 1: local state only, no network. */
"use strict";

/* ---------- store ---------- */

const LS_LIST = "foodapp.list";
const LS_SETTINGS = "foodapp.settings";

const store = {
  state: {
    view: "list",
    list: [],
    settings: { token: "", who: "", theme: "system", palette: "keep" },
    recipes: [], // bundled, not persisted
  },
  subs: [],
  subscribe(fn) { this.subs.push(fn); },
  notify() { this.subs.forEach((fn) => fn(this.state)); },
  load() {
    try {
      const l = JSON.parse(localStorage.getItem(LS_LIST));
      if (Array.isArray(l)) this.state.list = l;
    } catch (e) { /* ignore corrupt cache */ }
    try {
      const s = JSON.parse(localStorage.getItem(LS_SETTINGS));
      if (s && typeof s === "object") {
        this.state.settings = {
          token: s.token || "",
          who: s.who || "",
          theme: s.theme || "system",
          palette: PALETTES[s.palette] ? s.palette : "keep",
        };
      }
    } catch (e) { /* ignore */ }
    this.state.view = "list"; // always open on the list
  },
  saveList() {
    try { localStorage.setItem(LS_LIST, JSON.stringify(this.state.list)); }
    catch (e) { /* private mode, ignore */ }
  },
  saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(this.state.settings)); }
    catch (e) { /* ignore */ }
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
  addItem({ name, qty, unit, note, source = "manual" }) {
    const item = {
      id: uid(),
      name: name.trim(),
      qty: qty === "" || qty == null ? null : Number(qty),
      unit: (unit || "").trim() || null,
      note: (note || "").trim() || null,
      checked: false,
      source,
      addedBy: this.state.settings.who || "?",
      addedAt: new Date().toISOString(),
    };
    this.state.list.push(item);
    this.saveList(); this.notify();
    return item;
  },
  toggleItem(id) {
    const it = this.state.list.find((x) => x.id === id);
    if (it) { it.checked = !it.checked; this.saveList(); this.notify(); }
  },
  uncheckItem(id) {
    const it = this.state.list.find((x) => x.id === id);
    if (it && it.checked) { it.checked = false; this.saveList(); this.notify(); }
  },
  deleteItem(id) {
    this.state.list = this.state.list.filter((x) => x.id !== id);
    this.saveList(); this.notify();
  },
  clearChecked() {
    this.state.list = this.state.list.filter((x) => !x.checked);
    this.saveList(); this.notify();
  },
  setWho(who) { this.state.settings.who = who; this.saveSettings(); this.notify(); },
  setTheme(theme) {
    this.state.settings.theme = theme;
    this.saveSettings();
    applyTheme(theme);
    this.notify();
  },
  setToken(token) {
    this.state.settings.token = token;
    this.saveSettings();
    if (typeof github !== "undefined") github.setToken(token);
    this.notify();
  },
  setPalette(palette) {
    if (!PALETTES[palette]) return;
    this.state.settings.palette = palette;
    this.saveSettings();
    applyPalette(palette);
    this.notify();
  },
};

/* ---------- helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const deburr = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());

/* palette id -> { light, dark } background, for the browser chrome colour.
   The full token sets live in styles.css, keyed by [data-palette]. */
const PALETTES = {
  keep:     { name: "Google Keep",  light: "#ffffff", dark: "#202124" },
  drive:    { name: "Google Drive", light: "#ffffff", dark: "#131314" },
  whatsapp: { name: "WhatsApp",     light: "#efeae2", dark: "#0b141a" },
  todoist:  { name: "Todoist",      light: "#ffffff", dark: "#1f1f1f" },
};

function resolvedDark() {
  const theme = store.state.settings.theme || "system";
  return theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function updateThemeColor() {
  const pal = PALETTES[store.state.settings.palette] || PALETTES.keep;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolvedDark() ? pal.dark : pal.light);
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  updateThemeColor();
}

function applyPalette(palette) {
  const root = document.documentElement;
  if (palette && palette !== "keep") root.setAttribute("data-palette", palette);
  else root.removeAttribute("data-palette");
  updateThemeColor();
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
  const qtyStr = it.qty != null ? ` ${it.qty}${it.unit ? " " + it.unit : ""}` : "";
  li.innerHTML = `
    <button class="tick" aria-label="Toggle">${it.checked ? "✓" : ""}</button>
    <span class="main">
      <span>${escapeHtml(it.name)}${escapeHtml(qtyStr)}</span>
      ${it.note ? `<span class="sub"> (${escapeHtml(it.note)})</span>` : ""}
    </span>
    <button class="del" aria-label="Remove">✕</button>`;
  $(".tick", li).addEventListener("click", () => store.toggleItem(it.id));
  $(".del", li).addEventListener("click", () => store.deleteItem(it.id));
  return li;
}

function renderList(state) {
  const active = state.list.filter((x) => !x.checked);
  const checked = state.list.filter((x) => x.checked);

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
  store.state.list = store.state.list.filter((it) => !drop.has(it.id));
  store.saveList();
  store.notify();
  flashBanner(`Removed ${drop.size} duplicate ticked item${drop.size === 1 ? "" : "s"}.`);
}

const HTML_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

/* ---------- rendering: recipes ---------- */

const recipeFilters = {
  q: "",
  cuisine: "",
  main: "",
  searchOpen: false,
  sortDir: "asc", // asc = simplest first
};

const recipeFiltersActive = () =>
  !!(
    recipeFilters.cuisine ||
    recipeFilters.main ||
    recipeFilters.q.trim() ||
    recipeFilters.sortDir !== "asc"
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

  const clear = document.createElement("button");
  clear.className = "clear-btn";
  clear.hidden = !recipeFiltersActive();
  clear.innerHTML = `${ICON.x}Clear`;
  clear.addEventListener("click", () => {
    recipeFilters.q = "";
    recipeFilters.cuisine = "";
    recipeFilters.main = "";
    recipeFilters.sortDir = "asc";
    renderRecipes(store.state);
  });

  const asc = recipeFilters.sortDir === "asc";
  const sort = document.createElement("button");
  sort.className = "sort-btn";
  sort.innerHTML =
    (asc ? ICON.sortUp : ICON.sortDown) +
    `<span>${asc ? "Simplest first" : "Most complex first"}</span>`;
  sort.addEventListener("click", () => {
    recipeFilters.sortDir = asc ? "desc" : "asc";
    renderRecipes(store.state);
  });

  row.append(glass, clear, spacer, sort);
}

function renderRecipeFilters(state) {
  const cuisines = countedValues(state.recipes, (r) => r.cuisine);
  const mains = countedValues(state.recipes, (r) =>
    r.mainIngredient === "other" ? null : r.mainIngredient,
  );

  const cbox = $("#cuisineFilters");
  cbox.querySelectorAll(".chip").forEach((c) => c.remove());
  cuisines.forEach((c) => {
    const b = document.createElement("button");
    b.className = "chip" + (recipeFilters.cuisine === c ? " on" : "");
    b.textContent = cap(c);
    b.addEventListener("click", () => {
      recipeFilters.cuisine = recipeFilters.cuisine === c ? "" : c;
      renderRecipes(store.state);
    });
    cbox.appendChild(b);
  });

  const mbox = $("#mainFilters");
  mbox.querySelectorAll(".chip").forEach((c) => c.remove());
  mains.forEach((m) => {
    const b = document.createElement("button");
    b.className = "chip" + (recipeFilters.main === m ? " on" : "");
    b.textContent = MAIN_LABELS[m] || m;
    b.addEventListener("click", () => {
      recipeFilters.main = recipeFilters.main === m ? "" : m;
      renderRecipes(store.state);
    });
    mbox.appendChild(b);
  });

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
  const dir = recipeFilters.sortDir === "asc" ? 1 : -1;
  const rows = state.recipes
    .filter((r) => {
      if (recipeFilters.cuisine && r.cuisine !== recipeFilters.cuisine) return false;
      if (recipeFilters.main && r.mainIngredient !== recipeFilters.main) return false;
      if (q && !deburr(r.name).includes(q)) return false;
      return true;
    })
    .sort(
      (a, b) =>
        dir * (effortFor(a.category) - effortFor(b.category)) ||
        deburr(a.name).localeCompare(deburr(b.name)),
    );
  const ul = $("#recipeList");
  ul.innerHTML = "";
  rows.forEach((r) => {
    const li = document.createElement("li");
    li.className = "recipe-card";
    const eff = effortFor(r.category);
    const times = timesText(r);
    li.innerHTML = `
      <span class="main">${escapeHtml(r.name)}</span>
      <span class="card-meta">
        ${times ? `<span class="card-time">${escapeHtml(times)}</span>` : ""}
        <span class="dots" title="Effort ${eff}/3" aria-label="effort ${eff} of 3">${'<i class="on"></i>'.repeat(eff)}${"<i></i>".repeat(3 - eff)}</span>
      </span>`;
    if (typeof foodPixelIcon === "function") {
      li.appendChild(foodPixelIcon(r.name, r.category, 34));
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

function servingPresets(recipe) {
  if (recipe.presets && recipe.presets.length) return recipe.presets;
  const b = recipe.portions || 4;
  return [...new Set([1, 2, b, b * 2].filter((n) => n >= 1 && n <= 10))].sort((a, b2) => a - b2);
}

function qtyText(qty, unit) {
  return `${qty}${unit ? " " + escapeHtml(unit) : ""}`;
}

function renderDetail() {
  const { recipe } = detailState;
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
      const scaledQty = roundQty(ing.qty * factor, isCountUnit(ing.unit));
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
            qty = scaled ? roundQty(ing.qty * factor, isCountUnit(ing.unit)) : ing.qty;
            unit = ing.unit;
          }
          store.addItem({ name: ing.name, qty, unit, note: ing.note, source: key });
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
  } catch (e) {
    const c = github.config;
    const msg = {
      unauthorized: `Token rejected. It must be a fine-grained token with Contents access to ${c.owner}/${c.repo}.`,
      notFound: `That token cannot see ${c.owner}/${c.repo}. Give it repository access.`,
      offline: "Offline, cannot check the token right now.",
      rateLimited: "GitHub is busy, try again in a minute.",
    }[e.gh] || `Could not check the token (${e.message}).`;
    tokenStatus = { state: "error", text: msg };
  }
  renderSettings(store.state);
}

function renderSettings(state) {
  $$("#setWho button").forEach((b) => {
    b.classList.toggle("on", b.dataset.who === state.settings.who);
  });
  $$("#setTheme button").forEach((b) => {
    b.classList.toggle("on", b.dataset.theme === (state.settings.theme || "system"));
  });
  $$("#setPalette button").forEach((b) => {
    b.classList.toggle("on", b.dataset.palette === (state.settings.palette || "keep"));
  });
  const t = $("#setToken");
  if (document.activeElement !== t) t.value = state.settings.token || "";

  const st = $("#tokenStatus");
  st.hidden = tokenStatus.state === "idle";
  st.textContent = tokenStatus.text;
  st.className = "token-status " + tokenStatus.state;
}

/* ---------- top-level render ---------- */

function render(state) {
  $("#viewTitle").textContent = VIEW_TITLES[state.view];
  $$(".view").forEach((v) => { v.hidden = v.id !== `view-${state.view}`; });
  $$(".bottom-nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === state.view);
  });

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
  $$("#setTheme button").forEach((b) => {
    b.addEventListener("click", () => store.setTheme(b.dataset.theme));
  });
  $$("#setPalette button").forEach((b) => {
    b.addEventListener("click", () => store.setPalette(b.dataset.palette));
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
    render(store.state);
  });
}

// Phase 1 public build: no bundled data. The shopping list starts empty and
// the Recipes tab is empty. Phase 2 replaces this with a GitHub Contents API
// read of food/data/{shopping-list,recipes}.json from the private kave-hub
// repo, using the token from Settings.
async function loadRecipes() {
  store.state.recipes = [];
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

// Phase 1: no-op. Phase 2 swaps this for the GitHub fetch of the active tab's
// data (list / meal plan / recipes.json), using ETag / If-None-Match so an
// unchanged sync returns 304 and costs nothing against the rate limit.
function syncCurrentTab() {
  return new Promise((resolve) => setTimeout(resolve, 700));
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

store.load();
github.setToken(store.state.settings.token);
applyPalette(store.state.settings.palette || "keep");
applyTheme(store.state.settings.theme || "system");
store.subscribe(render);
wire();
initPullToSync();
initSheetDrag();
render(store.state);
loadRecipes().then(() => render(store.state));
if (store.state.settings.token) checkToken();
