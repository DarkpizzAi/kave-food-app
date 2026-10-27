/* Ladle: the whole-app search. The top bar's magnifier opens a full-screen
   page (the kit's "page" layer, one history entry) that searches the shopping
   list, the recipes and the prices, whichever tab it was opened from. Results
   update as you type and come in three groups, in this order: On the list,
   Recipes, Prices. A tap takes you to the thing: the List tab with the row
   highlighted, the recipe, or the product's trend.

   The recipe matching is Recipes' own (searchRecipes); a price result is the
   same call every other price tap makes (goToTrend). */
"use strict";

import { enterLayer, exitLayer, motionFactor } from "../m3/kave-m3.js";
import { backSheets } from "./back-sheets.js";
import { openRecipe, recipeSheetIsOpen } from "./sheet-recipe.js";
import { store } from "./store.js";
import { $, deburr, escapeHtml, markJump } from "./util.js";
import { renderList, setCheckedOpen } from "./view-list.js";
import { goToTrend } from "./view-prices.js";
import { recipeRow, searchRecipes } from "./view-recipes.js";

const DEBOUNCE_MS = 120;
const PRICE_LIMIT = 30;
const FOUND_MS = 1800;

let isOpen = false;
let hasHistory = false;
let token = 0;
let opener = null;
let timer = 0;
let waiters = [];

export const searchIsOpen = () => isOpen;

/* ---------- matching ---------- */

// list rows whose name or note holds the query: To buy first, then Bought
export function listMatches(list, query) {
  const q = deburr((query || "").trim());
  if (!q) return [];
  const has = (it) => deburr(it.name).includes(q) || deburr(it.note || "").includes(q);
  const hit = list.filter(has);
  return hit.filter((x) => !x.checked).concat(hit.filter((x) => x.checked));
}

// products whose name or category holds the query
export function priceMatches(products, query) {
  const q = deburr((query || "").trim());
  if (!q) return [];
  return Object.entries(products)
    .filter(([, e]) => deburr(e.label || "").includes(q) || deburr(e.l1_label || "").includes(q))
    .map(([key, e]) => ({ key, label: e.label || key, cat: e.l1_label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/* ---------- rows ---------- */

function group(title, rows) {
  const g = document.createElement("section");
  g.className = "srch-group";
  const h = document.createElement("div");
  h.className = "m3-list-header";
  h.innerHTML = `<span class="m3-title-s">${escapeHtml(title)}</span>`;
  const body = document.createElement("div");
  body.className = "m3-grouped";
  rows.forEach((r) => body.appendChild(r));
  g.append(h, body);
  return g;
}

function listRow(it) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "m3-list-item m3-list-item--tap srch-row";
  const qty = it.qty != null ? `${it.qty}${it.unit ? " " + it.unit : ""}` : "";
  const sub = [it.checked ? "Bought" : "To buy", it.note, qty].filter(Boolean).join(" · ");
  b.innerHTML = `<span class="m3-icon" aria-hidden="true">${it.checked ? "check_circle" : "shopping_cart"}</span>` +
    `<div class="m3-list-item__text"><div class="m3-body-l">${escapeHtml(it.name)}</div>` +
    `<div class="m3-body-m m3-variant">${escapeHtml(sub)}</div></div>`;
  b.addEventListener("click", () => showOnList(it));
  return b;
}

function recipeResult(r) {
  const row = recipeRow(r);
  // expanded: a recipe lives in the Recipes pane, so go there; elsewhere the sheet opens over this page
  row.addEventListener("click", (e) => {
    if (document.documentElement.dataset.size !== "expanded") return;
    e.stopImmediatePropagation();
    closeSearch().then(() => { store.setView("recipes"); openRecipe(r.slug); });
  }, true);
  return row;
}

function priceRow(p) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "m3-list-item m3-list-item--tap srch-row";
  b.innerHTML = `<span class="m3-icon" aria-hidden="true">insights</span>` +
    `<div class="m3-list-item__text"><div class="m3-body-l">${escapeHtml(p.label)}</div>` +
    `<div class="m3-body-m m3-variant">${escapeHtml(p.cat ? p.cat + " · See the trend" : "See the trend")}</div></div>`;
  b.addEventListener("click", () => { closeSearch().then(() => goToTrend(p.key)); });
  return b;
}

/* ---------- going to a result ---------- */

// the List tab, the row scrolled to the middle and lit for a moment
function showOnList(it) {
  closeSearch().then(() => {
    if (it.checked) setCheckedOpen(true);
    if (store.state.view !== "list") store.setView("list");
    else renderList(store.state);
    const row = document.querySelector(`#view-list .list-row[data-id="${CSS.escape(it.id)}"]`);
    if (!row) return;
    markJump();
    row.scrollIntoView({ block: "center", behavior: motionFactor() ? "smooth" : "auto" });
    row.classList.add("is-found");
    setTimeout(() => row.classList.remove("is-found"), FOUND_MS);
  });
}

/* ---------- the page ---------- */

function emptyState(icon, title, line) {
  const d = document.createElement("div");
  d.className = "m3-empty-state";
  d.innerHTML = `<span class="m3-empty-state__icon"><span class="m3-icon" aria-hidden="true">${icon}</span></span>` +
    `<span class="m3-title-m">${escapeHtml(title)}</span><span class="m3-body-m m3-variant">${escapeHtml(line)}</span>`;
  return d;
}

export function drawSearch() {
  const raw = $("#searchInput").value;
  $("#searchClear").hidden = !raw;
  const host = $("#searchResults");
  host.replaceChildren();
  if (!raw.trim()) {
    host.appendChild(emptyState("search", "Search Ladle", "Look through the shopping list, the recipes and the prices."));
    return;
  }
  const s = store.state;
  const onList = listMatches(s.list, raw);
  const recipes = searchRecipes(s.recipes, raw);
  const prices = priceMatches(s.prices.products, raw);
  if (!onList.length && !recipes.length && !prices.length) {
    host.appendChild(emptyState("search_off", "No results", `Nothing matches "${raw.trim()}".`));
    return;
  }
  if (onList.length) host.appendChild(group("On the list", onList.map(listRow)));
  if (recipes.length) host.appendChild(group("Recipes", recipes.map(recipeResult)));
  if (prices.length) {
    host.appendChild(group("Prices", prices.slice(0, PRICE_LIMIT).map(priceRow)));
    if (prices.length > PRICE_LIMIT) {
      const more = document.createElement("div");
      more.className = "m3-label-m m3-variant srch-more";
      more.textContent = `Showing ${PRICE_LIMIT} of ${prices.length}. Type more to narrow it down.`;
      host.appendChild(more);
    }
  }
}

export function openSearch() {
  if (isOpen) return;
  isOpen = true;
  token++;
  opener = document.activeElement;
  const el = $("#searchPage");
  $("#searchInput").value = "";
  drawSearch();
  el.hidden = false;
  $("#searchResults").scrollTop = 0;
  enterLayer(el, "page");
  try { history.pushState({ search: true }, ""); hasHistory = true; }
  catch (e) { hasHistory = false; }
  $("#searchInput").focus({ preventScroll: true });
}

function settle() {
  const w = waiters; waiters = [];
  w.forEach((f) => f());
}

function hideSearch() {
  if (!isOpen) return;
  isOpen = false;
  clearTimeout(timer);
  const el = $("#searchPage");
  const t = ++token;
  exitLayer(el, "page").then(() => { if (t === token) el.hidden = true; });
  const o = opener; opener = null;
  if (o && o.isConnected && o.offsetParent !== null) o.focus({ preventScroll: true });
  settle();
}

// the back arrow, Escape and the phone's back button are one path; resolves
// once the page has been told to leave, for a caller that changes tab next
export function closeSearch() {
  return new Promise((resolve) => {
    if (!isOpen) { resolve(); return; }
    waiters.push(resolve);
    if (hasHistory) { hasHistory = false; history.back(); }
    else hideSearch();
  });
}

backSheets.push({
  isOpen: () => isOpen,
  close: () => { hasHistory = false; hideSearch(); },
});

export function wireSearch() {
  const input = $("#searchInput");
  input.addEventListener("input", () => {
    $("#searchClear").hidden = !input.value;
    clearTimeout(timer);
    timer = setTimeout(drawSearch, DEBOUNCE_MS);
  });
  // Escape closes the page whatever has focus, unless the recipe sheet sits on top and takes it
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !isOpen || recipeSheetIsOpen()) return;
    e.stopPropagation(); closeSearch();
  });
  $("#searchBack").addEventListener("click", () => { closeSearch(); });
  $("#searchClear").addEventListener("click", () => { input.value = ""; clearTimeout(timer); drawSearch(); input.focus(); });
}
