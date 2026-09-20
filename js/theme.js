/* Spoon: palettes, the custom token editor's model, light and dark.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { store } from "./store.js";
import { $ } from "./util.js";

export const PALETTES = {
  cobalt:     { name: "Cobalt"     },
  amber:      { name: "Amber"      },
  chartreuse: { name: "Chartreuse" },
  lime:       { name: "Lime"       },
  tangerine:  { name: "Tangerine"  },
  volt:       { name: "Volt"       },
  custom:     { name: "Custom"     },
};

/* every themeable token, in the order shown in the custom editor */
export const CUSTOM_TOKENS = [
  "--bg", "--surface", "--surface-2", "--card", "--text", "--text-dim",
  "--accent", "--accent-text", "--accent-soft",
  "--border", "--rule", "--rule-strong", "--danger",
];
export const TOKEN_LABELS = {
  "--bg": "Background", "--surface": "Surface", "--surface-2": "Surface (raised)",
  "--card": "Card", "--text": "Text", "--text-dim": "Text (dim)", "--accent": "Accent",
  "--accent-text": "Text on accent", "--accent-soft": "Accent (soft)",
  "--border": "Border", "--rule": "Rule", "--rule-strong": "Rule (strong)",
  "--danger": "Danger",
};

export const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

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
export function seedCustom() {
  return { light: readTokensFor("light"), dark: readTokensFor("dark") };
}

/* accept { light, dark }; migrate a legacy flat set; null if unusable */
export function normaliseCustom(c) {
  if (!c || typeof c !== "object") return null;
  if (c.light || c.dark) return { light: c.light || c.dark || {}, dark: c.dark || c.light || {} };
  return { light: { ...c }, dark: { ...c } }; // legacy single set
}

/* push the right custom set (light or dark) onto <html> as inline overrides */
export function applyCustomForTheme() {
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
  if (store.state.settings.palette === "custom") applyCustomForTheme();
  syncColorScheme();
}

export function applyPalette(palette) {
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

export const VIEW_TITLES = {
  list: "Shopping List",
  prices: "Price tracking",
  recipes: "Recipe book",
  planner: "Meal Planner",
  settings: "Settings",
};
