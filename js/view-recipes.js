/* Ladle: the Recipes tab, on Material 3.

   Top to bottom: the headline, a pill search that opens the recipe search
   page, the quick filters, then "N recipes" over the dropdown chips (Cuisine,
   Type, Order by), then the recipes as grouped rows, one group per type.
   There is no + button: recipes are written in the repo, not in the app.

   On an expanded window the tab is a list-detail layout: the recipe fills a
   pane on the right (js/sheet-recipe.js hands openRecipe to selectInPane
   below); on compact and medium it opens the recipe sheet.

   The filter logic is pure and exported (filterRecipes, orderRecipes,
   searchRecipes) so the app-wide search can reuse it. */
"use strict";

import { enterLayer, exitLayer, kaveKey, sharedAxisIn, sharedAxisOut } from "../m3/kave-m3.js";
import { backSheets } from "./back-sheets.js";
import { cap, effortFor } from "./prices-data.js";
import { openRecipe, setPaneOpener } from "./sheet-recipe.js";
import { renderRecipeInto } from "./sheet-price.js";
import { store } from "./store.js";
import { $, deburr, escapeHtml } from "./util.js";

/* ---------- types: the groups, their icons and their colours ---------- */

export const TYPE_ORDER = ["pasta", "meat", "soup", "rice", "sauce", "other"];
export const TYPE_LABEL = { pasta: "Pasta", meat: "Meat", soup: "Soup", rice: "Rice", sauce: "Sauce", other: "Other" };
const TYPE_ICON = { pasta: "dinner_dining", meat: "kebab_dining", soup: "soup_kitchen", rice: "rice_bowl", sauce: "water_drop", other: "bakery_dining" };
// the kit's data colour keys; a type is a kind of food, not a store
const TYPE_KEY = { pasta: "food", meat: "life", soup: "travel", rice: "outdoors", sauce: "culture", other: "other" };

// fish and recipes with no main ingredient sit with Other
export function typeOf(r) {
  return TYPE_ORDER.includes(r.mainIngredient) ? r.mainIngredient : "other";
}

export function tileHtml(r, big = false) {
  const t = typeOf(r);
  return `<span class="m3-list-item__lead m3-list-item__lead--square${big ? " m3-list-item__lead--big" : ""} rl-tile" style="${kaveKey(TYPE_KEY[t])}">` +
    `<span class="m3-icon" aria-hidden="true">${TYPE_ICON[t]}</span></span>`;
}

/* ---------- times ---------- */

/* "1h30", "45 min", "1 h 15" -> minutes. prep + cook together; null when a
   recipe has no time at all, so it is neither quick nor slow. */
export function totalMinutes(recipe) {
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

export function fmtMinutes(m) {
  if (m == null) return "";
  m = Math.round(m);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r}` : `${h} h`;
}

/* ---------- pure filter, order and search ---------- */

export const QUICK_FILTERS = [
  { id: "quick", label: "Under 30 min", icon: "timer", test: (r) => { const m = totalMinutes(r); return m != null && m <= 30; } },
  { id: "pasta", label: "Pasta", icon: "dinner_dining", test: (r) => r.mainIngredient === "pasta" },
  { id: "soup", label: "Soup", icon: "soup_kitchen", test: (r) => r.mainIngredient === "soup" },
  { id: "leftovers", label: "Good for leftovers", icon: "inventory_2", test: (r) => !!r.batch },
];

export const ORDERS = [
  { id: "name", label: "Name", icon: "sort_by_alpha" },
  { id: "quick", label: "Quickest first", icon: "timer" },
  { id: "easy", label: "Easiest first", icon: "sentiment_satisfied" },
];

const byName = (a, b) => deburr(a.name).localeCompare(deburr(b.name));

/* AND of everything set: every quick filter, the cuisine, the type */
export function filterRecipes(recipes, { quick = [], cuisine = "", type = "" } = {}) {
  const tests = QUICK_FILTERS.filter((f) => [...quick].includes(f.id));
  return recipes.filter((r) => {
    if (cuisine && r.cuisine !== cuisine) return false;
    if (type && typeOf(r) !== type) return false;
    return tests.every((f) => f.test(r));
  });
}

/* a new array; name is always the tie-break. A recipe with no time sorts last. */
export function orderRecipes(recipes, order = "name") {
  const cmp = {
    name: byName,
    quick: (a, b) => {
      const ta = totalMinutes(a), tb = totalMinutes(b);
      if (ta == null || tb == null) return (ta == null) - (tb == null) || byName(a, b);
      return ta - tb || byName(a, b);
    },
    easy: (a, b) => effortFor(a.category) - effortFor(b.category) || byName(a, b),
  }[order] || byName;
  return recipes.slice().sort(cmp);
}

/* by name, cuisine or ingredient; no query lists everything. By name. */
export function searchRecipes(recipes, query) {
  const q = deburr((query || "").trim());
  const hits = !q ? recipes : recipes.filter((r) =>
    deburr(r.name).includes(q) || deburr(r.cuisine || "").includes(q)
    || (r.ingredients || []).some((i) => deburr(i.name || "").includes(q) || deburr(i.conceptName || "").includes(q)));
  return hits.slice().sort(byName);
}

/* ---------- state ---------- */

const ui = { quick: new Set(), cuisine: "", type: "", order: "name", sel: null };
const filtersOn = () => ui.quick.size > 0 || !!ui.cuisine || !!ui.type;
const isExpanded = () => document.documentElement.dataset.size === "expanded";

// distinct values ordered by how many recipes have them, most first
function countedValues(recipes, pick) {
  const counts = new Map();
  recipes.forEach((r) => { const v = pick(r); if (v) counts.set(v, (counts.get(v) || 0) + 1); });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}

/* ---------- rows ---------- */

function recipeMeta(r) {
  const bits = [];
  if (r.cuisine) bits.push(cap(r.cuisine));
  if (r.stub) bits.push(r.stubKind === "link" ? "Link only" : "To write");
  else { const t = fmtMinutes(totalMinutes(r)); if (t) bits.push(t); }
  return bits.length ? bits.join(" · ") : TYPE_LABEL[typeOf(r)];
}

// the effort dots sit 16px from the right edge, as far from it as the icon is from the left
export function recipeRow(r, selected = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "m3-list-item m3-list-item--tap rl-row" + (selected ? " m3-list-item--selected" : "");
  if (selected) b.setAttribute("aria-current", "true");
  const eff = effortFor(r.category);
  b.innerHTML = `${tileHtml(r)}` +
    `<div class="m3-list-item__text"><div class="m3-body-l">${escapeHtml(r.name)}</div>` +
    `<div class="m3-body-m m3-variant">${escapeHtml(recipeMeta(r))}</div></div>` +
    (r.stub ? "" : `<span class="m3-body-s m3-variant rl-effort" role="img" aria-label="Effort ${eff} of 3">${"●".repeat(eff)}${"○".repeat(3 - eff)}</span>`);
  b.addEventListener("click", () => openRecipe(r.slug));
  return b;
}

// kept for the parked Plan tab, which draws recipe cards in list items
export function recipeCard(r) {
  const li = document.createElement("li");
  li.className = "recipe-card";
  li.appendChild(recipeRow(r));
  return li;
}

// the cache the sync clears when names or categories move; nothing is cached any more
export const iconCache = new Map();

// the Plan tab's strips fade where there is more to scroll to
export function updateRailFade(rail) {
  const more = rail.scrollWidth > rail.clientWidth + 1 && rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 2;
  rail.classList.toggle("rail-fade", more);
}

/* ---------- menus (Cuisine, Type, Order by) ---------- */

let menu = null;   // { el, clear, anchor }

function onMenuKey(e) {
  if (e.key === "Escape" && menu) { e.stopPropagation(); e.preventDefault(); closeMenu(); }
}

function closeMenu(restoreFocus = true) {
  if (!menu) return;
  const { el, clear, anchor } = menu;
  menu = null;
  clear.remove();
  exitLayer(el, "menu").then(() => el.remove());
  document.removeEventListener("keydown", onMenuKey, true);
  if (anchor) anchor.setAttribute("aria-expanded", "false");
  if (restoreFocus && anchor && anchor.isConnected) anchor.focus({ preventScroll: true });
}

function openMenu(anchor, items, current, onPick) {
  closeMenu(false);
  const clear = document.createElement("div");
  clear.className = "rl-menu-clear";
  clear.addEventListener("click", () => closeMenu());
  const el = document.createElement("div");
  el.className = "m3-menu";
  el.setAttribute("role", "menu");
  items.forEach((it) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitemradio");
    b.setAttribute("aria-checked", it.id === current ? "true" : "false");
    if (it.id === current) b.classList.add("is-active");
    b.innerHTML = `<span class="m3-icon" aria-hidden="true">${it.id === current ? "check" : (it.icon || "")}</span>` +
      `<span class="m3-label-l">${escapeHtml(it.label)}</span>`;
    b.addEventListener("click", () => { closeMenu(); onPick(it.id); });
    el.appendChild(b);
  });
  document.body.append(clear, el);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8));
  el.style.left = `${left + scrollX}px`;
  el.style.top = `${r.bottom + scrollY + 4}px`;
  anchor.setAttribute("aria-expanded", "true");
  menu = { el, clear, anchor };
  document.addEventListener("keydown", onMenuKey, true);
  enterLayer(el, "menu");
  const first = el.querySelector(".is-active") || el.querySelector("button");
  if (first) first.focus({ preventScroll: true });
}

/* ---------- the tab ---------- */

function quickChip(f) {
  const on = ui.quick.has(f.id);
  const b = document.createElement("button");
  b.type = "button";
  b.className = "m3-chip m3-chip--leading" + (on ? " is-selected" : "");
  b.setAttribute("aria-pressed", String(on));
  b.innerHTML = `<span class="m3-icon" aria-hidden="true">${on ? "check" : f.icon}</span>${escapeHtml(f.label)}`;
  b.addEventListener("click", () => {
    if (ui.quick.has(f.id)) ui.quick.delete(f.id); else ui.quick.add(f.id);
    renderRecipes(store.state);
    const again = $(`#recipeQuick [data-q="${f.id}"]`);
    if (again) again.focus({ preventScroll: true });
  });
  b.dataset.q = f.id;
  return b;
}

function dropChip({ label, icon, filled, onOpen, aria }) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "m3-chip m3-chip--dropdown" + (filled ? " m3-chip--leading is-selected" : icon ? " m3-chip--leading" : "");
  b.setAttribute("aria-haspopup", "menu");
  b.setAttribute("aria-expanded", "false");
  b.setAttribute("aria-label", aria);
  b.innerHTML = (filled ? `<span class="m3-icon" aria-hidden="true">check</span>` : icon ? `<span class="m3-icon" aria-hidden="true">${icon}</span>` : "") +
    `${escapeHtml(label)}<span class="m3-icon" aria-hidden="true">arrow_drop_down</span>`;
  b.addEventListener("click", () => onOpen(b));
  return b;
}

function setFilter(key, value) {
  ui[key] = value;
  renderRecipes(store.state);
}

function clearFilters() {
  ui.quick.clear(); ui.cuisine = ""; ui.type = "";
  renderRecipes(store.state);
}

function emptyFiltered() {
  const d = document.createElement("div");
  d.className = "m3-card m3-card--filled rl-empty-card";
  d.innerHTML = `<div class="m3-empty-state"><div class="m3-empty-state__icon"><span class="m3-icon" aria-hidden="true">search_off</span></div>` +
    `<div class="m3-title-m">No recipe matches</div>` +
    `<div class="m3-body-m m3-variant">Remove a filter to see more.</div>` +
    `<button type="button" class="m3-btn m3-btn--tonal">Clear filters</button></div>`;
  $("button", d).addEventListener("click", clearFilters);
  return d;
}

export function renderRecipes(state) {
  const all = state.recipes;
  const hasBook = all.length > 0;
  $("#recipeTop").hidden = !hasBook;
  $("#recipeBody").hidden = !hasBook;
  $("#recipeBlank").hidden = hasBook;
  if (!hasBook) { $("#recipePane").hidden = true; return; }

  $("#recipePillHint").textContent = `Search ${all.length} recipes`;
  $("#recipeQuick").replaceChildren(...QUICK_FILTERS.map(quickChip));

  const rows = orderRecipes(filterRecipes(all, ui), ui.order);
  $("#recipeCount").textContent = `${rows.length} recipe${rows.length === 1 ? "" : "s"}`;

  const cuisines = countedValues(all, (r) => r.cuisine);
  const types = TYPE_ORDER.filter((t) => all.some((r) => typeOf(r) === t));
  const order = ORDERS.find((o) => o.id === ui.order) || ORDERS[0];
  const drops = [];
  if (cuisines.length) {
    drops.push(dropChip({
      label: ui.cuisine ? cap(ui.cuisine) : "Cuisine", filled: !!ui.cuisine,
      aria: `Cuisine: ${ui.cuisine ? cap(ui.cuisine) : "all"}. Change`,
      onOpen: (a) => openMenu(a, [{ id: "", label: "All cuisines" }, ...cuisines.map((c) => ({ id: c, label: cap(c) }))], ui.cuisine, (v) => setFilter("cuisine", v)),
    }));
  }
  if (types.length) {
    drops.push(dropChip({
      label: ui.type ? TYPE_LABEL[ui.type] : "Type", filled: !!ui.type,
      aria: `Type: ${ui.type ? TYPE_LABEL[ui.type] : "all"}. Change`,
      onOpen: (a) => openMenu(a, [{ id: "", label: "All types" }, ...types.map((t) => ({ id: t, label: TYPE_LABEL[t], icon: TYPE_ICON[t] }))], ui.type, (v) => setFilter("type", v)),
    }));
  }
  drops.push(dropChip({
    label: order.label, icon: "sort", filled: false, aria: `Order by: ${order.label}. Change`,
    onOpen: (a) => openMenu(a, ORDERS, ui.order, (v) => setFilter("order", v)),
  }));
  $("#recipeDrops").replaceChildren(...drops);

  // the pane's recipe: the selection, else the first row on screen
  const expanded = isExpanded();
  if (expanded) {
    let cur = ui.sel && all.find((r) => r.slug === ui.sel);
    if (!cur && rows.length) {
      const firstType = TYPE_ORDER.find((t) => rows.some((r) => typeOf(r) === t));
      cur = rows.find((r) => typeOf(r) === firstType);
    }
    ui.sel = cur ? cur.slug : null;
  }

  const groups = $("#recipeGroups");
  groups.replaceChildren();
  if (!rows.length) groups.appendChild(emptyFiltered());
  TYPE_ORDER.forEach((t) => {
    const mine = rows.filter((r) => typeOf(r) === t);
    if (!mine.length) return;
    const g = document.createElement("div");
    g.className = "m3-stack rl-group";
    g.setAttribute("role", "group");
    g.setAttribute("aria-label", TYPE_LABEL[t]);
    const h = document.createElement("div");
    h.className = "m3-list-header m3-title-s";
    h.textContent = TYPE_LABEL[t];
    const list = document.createElement("div");
    list.className = "m3-grouped";
    mine.forEach((r) => list.appendChild(recipeRow(r, expanded && r.slug === ui.sel)));
    g.append(h, list);
    groups.appendChild(g);
  });

  drawPane(state);
}

/* ---------- the expanded pane ---------- */

let paneSt = null;       // { recipe, servings }
let paneKey = "";

function drawPane(state, force = false) {
  const pane = $("#recipePane");
  const expanded = isExpanded();
  const cur = expanded && ui.sel ? state.recipes.find((r) => r.slug === ui.sel) : null;
  pane.hidden = !cur;
  if (!cur) { paneSt = null; paneKey = ""; return; }
  if (!paneSt || paneSt.recipe.slug !== cur.slug) paneSt = { recipe: cur, servings: cur.portions };
  else paneSt.recipe = cur;
  const key = `${cur.slug}|${paneSt.servings}|${store.readOnly()}`;
  // a background poll must not rebuild the pane under a finger or throw its scroll away
  if (!force && key === paneKey && pane.firstChild && pane.__recipe === cur) return;
  paneKey = key; pane.__recipe = cur;
  const top = pane.scrollTop;
  renderRecipeInto(pane, paneSt, () => drawPane(store.state, true));
  pane.scrollTop = top;
}

// openRecipe on an expanded window: select, do not open a sheet. Registered
// from wireRecipes at boot, not at load: this module sits in an import cycle
// with sheet-recipe, whose state may not exist yet while modules evaluate.
function selectInPane(recipe) {
  ui.sel = recipe.slug;
  paneSt = { recipe, servings: recipe.portions };
  renderRecipes(store.state);
  $("#recipePane").scrollTop = 0;
}

// the window crossed a size class: lay the tab out again
export function relayoutRecipes() {
  if (store.state.view === "recipes") renderRecipes(store.state);
}

/* ---------- the recipe search page ---------- */

let searchOpen = false;
let searchHasHistory = false;
let searchToken = 0;
let searchOpener = null;

function drawSearch() {
  const raw = $("#recipeSearchInput").value;
  $("#recipeSearchClear").hidden = !raw;
  const hits = searchRecipes(store.state.recipes, raw);
  const host = $("#recipeSearchResults");
  host.replaceChildren();
  const note = document.createElement("div");
  note.className = "m3-label-m m3-variant rl-search-note";
  note.textContent = raw.trim()
    ? `${hits.length} match${hits.length === 1 ? "" : "es"}, by name, cuisine or ingredient`
    : "All recipes";
  host.appendChild(note);
  if (!hits.length) return;
  const g = document.createElement("div");
  g.className = "m3-grouped";
  hits.forEach((r) => {
    const row = recipeRow(r);
    // expanded: the recipe goes to the pane, so the page steps aside; elsewhere the sheet opens over it
    row.addEventListener("click", () => { if (isExpanded()) closeRecipeSearch(); }, true);
    g.appendChild(row);
  });
  host.appendChild(g);
}

export function openRecipeSearch() {
  if (searchOpen) return;
  searchOpen = true;
  searchToken++;
  searchOpener = document.activeElement;
  const el = $("#recipeSearchPage");
  $("#recipeSearchInput").value = "";
  $("#recipeSearchInput").placeholder = `Search ${store.state.recipes.length} recipes`;
  drawSearch();
  el.hidden = false;
  $("#recipeSearchResults").scrollTop = 0;
  sharedAxisIn(el, 1);
  try { history.pushState({ recipeSearch: true }, ""); searchHasHistory = true; }
  catch (e) { searchHasHistory = false; }
  $("#recipeSearchInput").focus({ preventScroll: true });
}

function hideRecipeSearch() {
  if (!searchOpen) return;
  searchOpen = false;
  const el = $("#recipeSearchPage");
  const token = ++searchToken;
  sharedAxisOut(el, -1).then(() => { if (token === searchToken) el.hidden = true; });
  const o = searchOpener; searchOpener = null;
  if (o && o.isConnected && o.offsetParent !== null) o.focus({ preventScroll: true });
}

// the back arrow, Escape and the phone's back button are one path
export function closeRecipeSearch() {
  if (!searchOpen) return;
  if (searchHasHistory) { searchHasHistory = false; history.back(); }
  else hideRecipeSearch();
}
export const recipeSearchIsOpen = () => searchOpen;
backSheets.push({
  isOpen: () => searchOpen,
  close: () => { searchHasHistory = false; hideRecipeSearch(); },
});

export function wireRecipes() {
  setPaneOpener(selectInPane);
  $("#recipeSearchPill").addEventListener("click", openRecipeSearch);
  const input = $("#recipeSearchInput");
  input.addEventListener("input", drawSearch);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeRecipeSearch(); }
  });
  $("#recipeSearchBack").addEventListener("click", closeRecipeSearch);
  $("#recipeSearchClear").addEventListener("click", () => { input.value = ""; drawSearch(); input.focus(); });
}
