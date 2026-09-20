/* Spoon: the Recipe book tab.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { foodPixelIcon } from "../pixel-icons.js";
import { ICON, MAIN_LABELS, cap, effortFor, timesText } from "./prices-data.js";
import { openRecipe } from "./sheet-recipe.js";
import { store } from "./store.js";
import { $, $$, deburr, escapeHtml, own } from "./util.js";

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

  // A rail with no chips hides itself, label and all. The label lives INSIDE
  // the rail and is static markup, so a rail that renders no chips used to
  // leave a bare "Cuisine" sitting over nothing - which reads as chips that
  // failed to load, not as a book with no recipes in it yet.
  //
  // Not a theoretical state: reinstalling clears localStorage, so both phones
  // land on an empty book every time a manifest change forces one, until the
  // token is pasted back in.
  //
  // These count over state.recipes, never over the filtered rows, so a rail
  // can only empty when the book itself is empty of that field - picking a
  // cuisine cannot make the Type rail disappear under the thumb that picked it.
  //
  // `hidden` is enough on its own here: the global [hidden] rule is !important,
  // so it beats .rail's own `display: flex`. Without that it would not.
  const cbox = $("#cuisineFilters");
  cbox.querySelectorAll(".chip").forEach((c) => c.remove());
  cbox.hidden = !cuisines.length;
  if (cuisines.length) {
    filterChip(cbox, "cuisine", "", "All");
    cuisines.forEach((c) => filterChip(cbox, "cuisine", c, cap(c)));
  }

  const mbox = $("#mainFilters");
  mbox.querySelectorAll(".chip").forEach((c) => c.remove());
  mbox.hidden = !mains.length;
  if (mains.length) {
    filterChip(mbox, "main", "", "All");
    mains.forEach((m) => filterChip(mbox, "main", m, own(MAIN_LABELS, m) ? MAIN_LABELS[m] : m));
  }

  updateRailFade(cbox);
  updateRailFade(mbox);
}

// fade the right edge only while the rail actually has more to scroll to,
// so an intentionally-cut-off chip reads as "scroll for more", not "broken" -
// and the fade clears once you've scrolled to the last chip
export function updateRailFade(rail) {
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
export const iconCache = new Map();

function recipeIcon(r) {
  if (typeof foodPixelIcon !== "function") return null;
  let el = iconCache.get(r.slug);
  if (!el) {
    el = foodPixelIcon(r.name, r.category, 38);
    iconCache.set(r.slug, el);
  }
  return el;
}

// One recipe card. Used by the Recipes grid and by the Plan tab's horizontal
// strips, so a recipe looks and behaves the same wherever it is shown - same
// markup, same tap into the same sheet.
export function recipeCard(r) {
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
  return li;
}

export function renderRecipes(state) {
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
  rows.forEach((r) => ul.appendChild(recipeCard(r)));
  const empty = $("#recipeEmpty");
  empty.hidden = rows.length !== 0;
  empty.textContent = state.recipes.length === 0
    ? "Recipes sync from your repo once a token is set."
    : "No recipe matches.";
  // No book, no furniture for it: the whole filter bar goes, search and Order
  // by with the rails, leaving the tab as the one sentence that is actually
  // true of it. Sorting nothing and searching nothing are not choices.
  //
  // The test is the BOOK, not the rows on screen. A search that matches
  // nothing must keep its field - that is the only way back out of it - so
  // this must never key off `rows`.
  $(".filterbar").hidden = state.recipes.length === 0;
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
export function equaliseCards() {
  if ($("#view-recipes").hidden) return;
  const cards = $$("#recipeList li");
  if (!cards.length) return;
  cards.forEach((c) => { c.style.minHeight = ""; });
  let max = 0;
  cards.forEach((c) => { max = Math.max(max, c.offsetHeight); });
  cards.forEach((c) => { c.style.minHeight = max + "px"; });
}
