/* Spoon: DOM helpers, deburring, and the two escapers.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* Memoised: renderSuggestions deburrs every item name on every keystroke, and
   the recipe sort deburrs every card on every render. NFD-normalising 400+
   strings per keypress was measurable on a phone. Bounded, because search
   typing feeds it a fresh string each time. */
const deburrCache = new Map();
export const deburr = (s) => {
  if (!s) return "";
  let v = deburrCache.get(s);
  if (v === undefined) {
    v = s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    if (deburrCache.size < 4000) deburrCache.set(s, v);
  }
  return v;
};

export const uid = () =>
  (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());

/* Own-property test for the dictionaries below. Every one of them is a plain
   object keyed by a string that came from outside - a name typed into the
   list, a key from the synced JSON - and a plain object inherits
   Object.prototype, so `products["constructor"]` answers with a function
   rather than undefined. That is not theoretical here: typing "constructor"
   as a list item resolved to an l3 target whose entry had no `.series`, and
   the TypeError took renderList down with it - on a row that persists in
   localStorage, so the list came back broken on every load. */
export const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/* palette id -> display name. The full token sets live in styles.css,
   keyed by [data-palette]; the browser-chrome colour is read from the
   resolved --surface (the app header's background) so they never drift. */
const HTML_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

/* escapeHtml is no defence inside an href. It escapes characters, and a URL
   scheme has none for it to touch - `javascript:doSomething()` comes through a
   template literal completely intact and becomes a live link running in this
   origin, which is the origin holding the GitHub token in localStorage. A
   recipe's `sources` are written into recipes.json in the hub repo, so this is
   not a stranger's input, but it is the one place a synced string is handed
   straight to the browser as code-capable markup rather than as text.
   Only http(s) is a recipe link. Anything else returns null and the caller
   drops the row, so a bad source is visibly absent rather than dead-but-there. */
export function safeUrl(u) {
  try {
    // No base argument on purpose. Resolving against location.href would turn
    // "" and "not a url" into links back to the app itself - harmless, but a
    // live "Open recipe" going nowhere. A source is an external link or it is
    // nothing, so an absolute URL is required and a relative one throws here.
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch (e) {
    return null;                      // not an absolute URL at all
  }
}
