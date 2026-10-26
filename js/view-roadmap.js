/* Ladle: the Roadmap page. What each tab is for, and what is coming.

   Plan is a line here and nowhere else: js/view-plan.js stays in the repo, but
   its nav button is gone, so this is the only place it is mentioned. All the
   text below is fixed, none of it comes from the sync. */
"use strict";

import { escapeHtml } from "./util.js";

const ROADMAP = [
  ["List", "shopping_cart", true, "The shared shopping list. Tick an item to move it to Bought."],
  ["Insights", "lightbulb", true, "Prices worth watching, trends per store, and receipt clean-up."],
  ["Recipes", "menu_book", true, "The recipe book, with search and quick filters."],
  ["Plan", "event_note", false, "Meals that share ingredients, and leftovers worth cooking twice."],
];

export function renderRoadmap() {
  const rows = ROADMAP.map(([name, icon, live, text]) => `
    <div class="m3-list-item m3-list-item--three">
      <span class="m3-list-item__lead m3-list-item__lead--square${live ? "" : " is-soon"}"><span class="m3-icon">${escapeHtml(icon)}</span></span>
      <div class="m3-list-item__text m3-list-item__text--wrap">
        <div class="m3-title-m">${escapeHtml(name)}</div>
        <div class="m3-body-m m3-variant">${escapeHtml(text)}</div>
      </div>
      <span class="m3-chip${live ? " is-selected" : ""}">${live ? "Live" : "Coming soon"}</span>
    </div>`).join("");
  return `<p class="m3-body-m m3-variant page-intro">The tabs of Kave Ladle, what each one is for, and what is coming. Settings lives in the menu.</p>
    <div class="m3-grouped">${rows}</div>`;
}
