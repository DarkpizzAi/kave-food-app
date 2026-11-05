/* Ladle: the five seeds, light and dark.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";


/* The two themes (Isa, 05/11/2026), the same table #theme-preload in
   index.html uses: the old name cobalt is Cobalt, and every retired seed or
   unknown id falls back to Cobalt. */
export const PALETTES = {
  blue:       { name: "Cobalt"     },
  chartreuse: { name: "Chartreuse" },
};
const LEGACY = { cobalt: "blue" };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export function toSeed(id) {
  if (has(PALETTES, id)) return id;
  return has(LEGACY, id) ? LEGACY[id] : "blue";
}

/* Tell the browser which way the page is leaning. This is what darkens the
   Android gesture bar at the bottom; the status bar at the top is the phone's
   own and takes no instruction from us. */
export function syncColorScheme() {
  document.documentElement.style.colorScheme = darkNow() ? "dark" : "light";
}

/* Light or dark is the phone's call and only the phone's: an installed PWA
   cannot colour the status and gesture bars, it only gets the light or dark
   pair the system chose. Following that setting exactly is what lets --bg
   (pure white or pure black) meet those bars without a seam. */
function darkNow() {
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  syncColorScheme();
}

export function applySeed(seed) {
  document.documentElement.setAttribute("data-seed", toSeed(seed));
  syncColorScheme();
}

export const VIEW_TITLES = {
  list: "List",
  prices: "Insights",
  recipes: "Recipes",
  planner: "Plan",
  settings: "Settings",
};
