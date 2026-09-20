/* Spoon: the three palettes, light and dark.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";


export const PALETTES = {
  cobalt:     { name: "Cobalt"     },
  amber:      { name: "Amber"      },
  chartreuse: { name: "Chartreuse" },
};

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

export function applyPalette(palette) {
  const root = document.documentElement;
  if (palette && palette !== "cobalt") root.setAttribute("data-palette", palette);
  else root.removeAttribute("data-palette");
  syncColorScheme();
}

export const VIEW_TITLES = {
  list: "Shopping List",
  prices: "Price tracking",
  recipes: "Recipe book",
  planner: "Meal Planner",
  settings: "Settings",
};
