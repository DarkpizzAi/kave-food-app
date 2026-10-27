/* Ladle: the "See all" sheets of the parked Plan tab.

   Worth pairing and Good for leftovers show a few rows in place and end on a
   "See all" button. They no longer own a sheet: they open the one Insights
   sheet (js/sheet-price.js), so they rise, slide, drag and close like every
   other popup. The caller passes a render function rather than rows, so a sync
   that lands while the sheet is open redraws it from fresh state. */
"use strict";

import { closeInsSheet, openInsSheet, refreshInsSheet } from "./sheet-price.js";
import { escapeHtml } from "./util.js";

export function openListSheet(title, sub, render) {
  openInsSheet({
    title, tall: true,
    render: (body) => {
      body.innerHTML = `<p class="m3-body-m m3-variant">${escapeHtml(sub)}</p>`;
      const rows = document.createElement("div");
      body.appendChild(rows);
      render(rows);
    },
  });
}

export const refreshListSheet = refreshInsSheet;
export const closeListSheet = closeInsSheet;
