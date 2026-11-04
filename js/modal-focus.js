/* Kave Ladle: focus stays inside the top modal layer, as Material 3 asks of
   modal sheets, dialogs, the modal drawer and full-screen pages.

   One rule for every layer, watched rather than called: each modal layer is a
   child of <body> that is shown and hidden with `hidden`. While one is open,
   every other child of <body> is made inert, except the layer's own scrim (a
   tap on it closes the layer) and the snackbar host (its Undo stays
   reachable). Tab, the screen reader and taps then reach only the top layer.
   Layers stack in the order they opened; closing the top hands focus
   containment to the one under it. The sheets themselves still move focus in
   and give it back to what opened them. */
"use strict";

const LAYER_SEL = ':scope > [role="dialog"][aria-modal="true"], :scope > #page';
const KEEP_IDS = new Set(["snackHost"]);

const order = [];          // open layers, oldest first
const ours = new Set();    // the elements this module made inert

const isOpen = (el) => !el.hidden;
const scrimOf = (el) => {
  const p = el.previousElementSibling;
  return p && p.classList.contains("m3-scrim") ? p : null;
};

function apply() {
  const top = order[order.length - 1] || null;
  const keep = new Set(top ? [top, scrimOf(top)] : []);
  [...document.body.children].forEach((c) => {
    const want = !!top && !keep.has(c) && !KEEP_IDS.has(c.id) && c.tagName !== "SCRIPT";
    if (want && !c.inert) { c.inert = true; ours.add(c); }
    else if (!want && ours.has(c)) { c.inert = false; ours.delete(c); }
  });
}

function sync(layers) {
  layers.forEach((el) => {
    const i = order.indexOf(el);
    if (isOpen(el) && i < 0) order.push(el);
    else if (!isOpen(el) && i >= 0) order.splice(i, 1);
  });
  apply();
}

export function initModalFocus() {
  const layers = [...document.body.querySelectorAll(LAYER_SEL)];
  const mo = new MutationObserver(() => sync(layers));
  layers.forEach((el) => mo.observe(el, { attributes: true, attributeFilter: ["hidden"] }));
  sync(layers);
}
