/* Ladle: the List tab, on Material 3.

   Two grouped sections, To buy and Bought, in the Settings rows' look. The
   first To buy row, "List item", opens the add page (a full-screen search
   view); there is no + button anywhere else. Every action that changes the
   list says so in a snackbar, and Undo goes back through the store's own
   actions, so the restored state is the stored state, not a redraw.

   The list is a tally, not a set: adding the same thing twice adds it twice,
   on purpose (see CLAUDE.md). Nothing here deduplicates a typed add. */
"use strict";

import { sharedAxisIn, sharedAxisOut, showSnackbar } from "../m3/kave-m3.js";
import { backSheets } from "./back-sheets.js";
import { cardLabel, computeBubble, resolvePriceTarget, seriesForTarget, storeColor, storeOnColor } from "./prices-data.js";
import { store } from "./store.js";
import { $, $$, deburr, escapeHtml } from "./util.js";
import { goToPriceChart } from "./view-prices.js";

export let checkedOpen = false;

// Bought is the whole catalogue of things ever ticked (hundreds of rows), so
// it shows the most recently used few and a Show all row for the rest
const BOUGHT_PREVIEW = 8;

// the chart icon (trending line + arrowhead), same mark on the list row and
// the sheet's promo dots; the nav tab is Insights now and uses Compass's lightbulb
const PRICE_ICON_PATH = '<path d="M4 17l5-6 4 3 7-7"/><path d="M15 7h5v5"/>';
// same mark, flipped: a downward trend for an Opportunities row
export const PRICE_ICON_DOWN_PATH = '<path d="M4 7l5 6 4-3 7 7"/><path d="M15 17h5v-5"/>';

// the one snackbar host (index.html)
const snack = (opts) => showSnackbar($("#snackHost"), opts);

// price hint for one list row: only unticked, only when the name resolves to
// something with a history at all - a row with no data gets no icon
// (v10 spec §6)
//
// A row added from a recipe carries its card AND its variant, both authored
// (kave-hub recipe-ingredient-variants.csv, from the same vocabulary the
// receipts use). That beats resolving the typed name, which only ever sees
// the concept: "Viande hachée mixte" resolves to the `viande` card, whose
// pooled series runs pork chops together with mince. Falling back to the
// name keeps every hand-typed row working exactly as before.
function priceHintFor(it) {
  if (it.checked) return null;
  let target = null;
  if (it.slug && it.variant) {
    target = {
      level: "l2", l1: it.slug, l2: it.variant,
      l1_label: cardLabel(it.slug) || it.slug,
    };
    if (!seriesForTarget(target).length) target = null;
  }
  if (!target) target = resolvePriceTarget(it.name);
  if (!target) return null;
  const series = seriesForTarget(target);
  if (!series.length) return null;
  return { target, bubbleStore: computeBubble(series) };
}

/* ---------- actions, each with its Undo ---------- */

// names removed this session, offered again on the add page next to Bought
const removedNames = [];

function tickRow(it) {
  if (store.readOnly()) return;
  const prev = { checked: it.checked, touchedAt: it.touchedAt };
  const name = it.name;
  store.toggleItem(it.id);
  snack({
    text: prev.checked ? `${name} moved back to To buy` : `${name} moved to Bought`,
    action: "Undo",
    onAction: () => store.restoreChecked(it.id, prev.checked, prev.touchedAt),
  });
}

function removeRow(it) {
  if (store.readOnly()) return;
  const snap = store.snapshotItems([it.id]);
  store.deleteItem(it.id);
  removedNames.unshift(it.name);
  if (removedNames.length > 40) removedNames.length = 40;
  snack({ text: `Removed ${it.name}`, action: "Undo", onAction: () => store.restoreItems(snap) });
}

function itemRow(it) {
  const row = document.createElement("div");
  row.className = "m3-list-item list-row" + (it.checked ? " is-done" : "");
  const qtyStr = it.qty != null ? `${it.qty}${it.unit ? " " + it.unit : ""}` : "";
  const sub = [it.note, qtyStr].filter(Boolean).join(" · ");
  const hint = priceHintFor(it);
  const priceBtn = hint ? `
    <button type="button" class="price-btn" aria-label="Price history for ${escapeHtml(it.name)}">
      ${hint.bubbleStore ? `<span class="price-bubble" style="background:${storeColor(hint.bubbleStore)}"></span>` : ""}
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="${hint.bubbleStore ? storeOnColor(hint.bubbleStore) : "currentColor"}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PRICE_ICON_PATH}</svg>
    </button>` : "";
  row.innerHTML = `
    <button type="button" class="row-check" role="checkbox" aria-checked="${it.checked ? "true" : "false"}"
      aria-label="${escapeHtml(it.checked ? `Move ${it.name} back to To buy` : `Mark ${it.name} as bought`)}"><span class="cb${it.checked ? " on" : ""}">${it.checked ? '<span class="m3-icon">check</span>' : ""}</span></button>
    <div class="m3-list-item__text">
      <div class="m3-body-l nm">${escapeHtml(it.name)}</div>
      ${sub ? `<div class="m3-body-m m3-variant">${escapeHtml(sub)}</div>` : ""}
    </div>
    ${priceBtn}
    <button type="button" class="m3-icon-btn del" aria-label="Remove ${escapeHtml(it.name)}"><span class="m3-icon">close</span></button>`;
  $(".row-check", row).addEventListener("click", () => tickRow(it));
  $(".del", row).addEventListener("click", () => removeRow(it));
  if (hint) {
    // Task 4 replaces this with goToTrend(productKey); until then it opens the old chart
    $(".price-btn", row).addEventListener("click", () => goToPriceChart(hint.target));
  }
  return row;
}

/* The nav badge is visible from every tab, so it updates on every render even
   when the list itself is not on screen. It counts To buy. */
export function renderListBadge(state) {
  const n = state.list.reduce((a, x) => a + (x.checked ? 0 : 1), 0);
  // one badge on the nav bar, one on the rail; only one of them is displayed
  $$(".list-badge").forEach((badge) => {
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.hidden = n === 0;
  });
}

function textRow(text) {
  const r = document.createElement("div");
  r.className = "m3-list-item";
  const t = document.createElement("span");
  t.className = "m3-body-m m3-variant";
  t.textContent = text;
  r.appendChild(t);
  return r;
}

function addRow(readOnly) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "m3-list-item m3-list-item--tap add-row";
  b.disabled = readOnly;
  b.innerHTML = '<span class="m3-icon" aria-hidden="true">add</span><span class="m3-body-l">List item</span>';
  b.addEventListener("click", openAddPage);
  return b;
}

function emptyToBuy(readOnly) {
  const d = document.createElement("div");
  d.className = "m3-list-item empty-row";
  d.innerHTML = `<div class="m3-empty-state">
      <div class="m3-empty-state__icon"><span class="m3-icon" aria-hidden="true">shopping_cart</span></div>
      <div class="m3-title-m">Nothing left to buy</div>
      <div class="m3-body-m m3-variant">Add what you need, or bring back something you bought before.</div>
      <button type="button" class="m3-btn m3-btn--tonal"${readOnly ? " disabled" : ""}><span class="m3-icon" aria-hidden="true">add</span>Add an item</button>
    </div>`;
  $("button", d).addEventListener("click", openAddPage);
  return d;
}

/* Only called when the list view is actually on screen. It rebuilds every row
   and re-binds the listeners; Bought is capped at a preview for that reason,
   since with the whole catalogue open that is 400+ rows on every store change
   and every background poll. */
export function renderList(state) {
  const ro = store.readOnly();
  const active = state.list.filter((x) => !x.checked);
  const bought = state.list.filter((x) => x.checked)
    .sort((a, b) => (Date.parse(b.touchedAt || "") || 0) - (Date.parse(a.touchedAt || "") || 0)
      || a.name.localeCompare(b.name));

  const toBuy = $("#toBuyList");
  toBuy.replaceChildren(addRow(ro));
  if (active.length) active.forEach((it) => toBuy.appendChild(itemRow(it)));
  else toBuy.appendChild(emptyToBuy(ro));
  $("#toBuyCount").textContent = String(active.length);

  const done = $("#boughtList");
  done.replaceChildren();
  const shown = checkedOpen ? bought : bought.slice(0, BOUGHT_PREVIEW);
  shown.forEach((it) => done.appendChild(itemRow(it)));
  if (!bought.length) done.appendChild(textRow("Nothing bought yet."));
  if (bought.length > BOUGHT_PREVIEW) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "m3-list-item m3-list-item--tap more-row";
    more.setAttribute("aria-expanded", checkedOpen ? "true" : "false");
    more.innerHTML = `<span class="m3-icon" aria-hidden="true">${checkedOpen ? "expand_less" : "expand_more"}</span>`
      + `<span class="m3-label-l">${checkedOpen ? "Show fewer" : `Show all ${bought.length}`}</span>`;
    more.addEventListener("click", () => { checkedOpen = !checkedOpen; renderList(store.state); });
    done.appendChild(more);
  }
  $("#boughtCount").textContent = String(bought.length);
  $("#tidyChecked").hidden = bought.length === 0;
}

/* ---------- the add page ---------- */

let addOpen = false;
let addHasHistory = false;
let addToken = 0;
let addOpener = null;

/* What the page offers: everything bought (newest use first, one per name)
   and what was removed this session, minus anything already waiting in To buy.
   Each entry is { name, id } where id is the bought row to bring back, or null
   for a removed name that would be added fresh. */
function addCandidates() {
  const waiting = new Set(store.state.list.filter((x) => !x.checked).map((x) => deburr(x.name)));
  const seen = new Set();
  const out = [];
  const bought = store.state.list.filter((x) => x.checked)
    .sort((a, b) => (Date.parse(b.touchedAt || "") || 0) - (Date.parse(a.touchedAt || "") || 0));
  for (const it of bought) {
    const k = deburr(it.name);
    if (seen.has(k) || waiting.has(k)) continue;
    seen.add(k); out.push({ name: it.name, id: it.id });
  }
  for (const n of removedNames) {
    const k = deburr(n);
    if (seen.has(k) || waiting.has(k)) continue;
    seen.add(k); out.push({ name: n, id: null });
  }
  return out;
}

function resultRow(icon, label, onPick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "m3-list-item m3-list-item--tap result-row";
  b.innerHTML = `<span class="m3-icon" aria-hidden="true">${icon}</span><span class="m3-body-l nm">${escapeHtml(label)}</span>`;
  b.addEventListener("click", onPick);
  return b;
}

function drawAdd() {
  const raw = $("#addInput").value.trim();
  const q = deburr(raw);
  $("#addClear").hidden = !raw;
  const host = $("#addResults");
  host.replaceChildren();
  const group = (rows) => {
    const g = document.createElement("div");
    g.className = "m3-grouped";
    rows.forEach((r) => g.appendChild(r));
    host.appendChild(g);
  };
  if (raw) group([resultRow("add", `Add “${raw}”`, () => submitAdd(raw))]);
  const hits = addCandidates().filter((c) => !q || deburr(c.name).includes(q)).slice(0, 10);
  const h = document.createElement("div");
  h.className = "m3-list-header m3-title-s";
  h.textContent = raw ? "Matches" : "Add back to the list";
  host.appendChild(h);
  if (hits.length) group(hits.map((c) => resultRow("history", c.name, () => submitAdd(c.name, c.id))));
  else {
    const p = document.createElement("p");
    p.className = "m3-body-m m3-variant add-none";
    p.textContent = "Nothing matches yet.";
    host.appendChild(p);
  }
}

/* One add, from Enter or a tap. A row tapped from Add back brings that very
   Bought row back; typed text that exactly names a Bought row does the same
   (as it always has). Anything else is a new row, and a new row is always a
   new row: adding the same name twice gives two. */
function submitAdd(name, boughtId = null) {
  name = name.trim();
  if (!name || store.readOnly()) return;
  let id = boughtId;
  if (!id) {
    const match = store.state.list.find((x) => x.checked && deburr(x.name) === deburr(name));
    if (match) id = match.id;
  }
  const back = id ? store.state.list.find((x) => x.id === id) : null;
  let undo;
  if (back && back.checked) {
    const prev = { checked: back.checked, touchedAt: back.touchedAt };
    store.uncheckItem(back.id);
    undo = () => store.restoreChecked(back.id, prev.checked, prev.touchedAt);
    name = back.name;
  } else {
    const made = store.addItem({ name, qty: "", unit: "", note: "" });
    if (!made) return;
    undo = () => store.deleteItem(made.id);
  }
  closeAddPage();
  snack({ text: `Added ${name} to the list`, action: "Undo", onAction: undo });
}

export function openAddPage() {
  if (addOpen || store.readOnly()) return;
  addOpen = true;
  addToken++;
  addOpener = document.activeElement;
  const el = $("#addPage");
  $("#addInput").value = "";
  drawAdd();
  el.hidden = false;
  $("#addResults").scrollTop = 0;
  sharedAxisIn(el, 1);
  try { history.pushState({ addPage: true }, ""); addHasHistory = true; }
  catch (e) { addHasHistory = false; }
  $("#addInput").focus({ preventScroll: true });
}

function hideAddPage() {
  if (!addOpen) return;
  addOpen = false;
  const el = $("#addPage");
  const token = ++addToken;
  sharedAxisOut(el, -1).then(() => { if (token === addToken) el.hidden = true; });
  const o = addOpener; addOpener = null;
  if (o && o.isConnected && o.offsetParent !== null) o.focus({ preventScroll: true });
}

// the back arrow, Escape and the phone's back button are one path
export function closeAddPage() {
  if (!addOpen) return;
  if (addHasHistory) { addHasHistory = false; history.back(); }
  else hideAddPage();
}
export const addPageIsOpen = () => addOpen;
backSheets.push({
  isOpen: () => addOpen,
  close: () => { addHasHistory = false; hideAddPage(); },
});

export function wireAddPage() {
  const input = $("#addInput");
  input.addEventListener("input", drawAdd);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submitAdd(input.value); }
    else if (e.key === "Escape") { e.stopPropagation(); closeAddPage(); }
  });
  $("#addBack").addEventListener("click", closeAddPage);
  $("#addClear").addEventListener("click", () => { input.value = ""; drawAdd(); input.focus(); });
}

/* An amount at the end of a name, but only an unambiguous one: it carries a
   unit ("200 g"), an x multiplier ("x2"), or brackets ("(2x400g)"). A bare
   trailing number is NOT an amount - "Omega 3" is a name, not three of
   something, and "Vitamine B12" and "Ratio 16 9" are names too.

   One rule, used for both halves of Clean up, because both halves delete:
   isQuantified decides whether a row is a recipe leftover to remove, and
   stripQty builds the key that decides which rows are duplicates of each
   other. Letting the key strip a bare number merged "Omega 3" with "Omega 6"
   and deleted one of them; a unit-bearing suffix is the only safe signal. */
const TRAILING_AMOUNT =
  /(?:\s+x\s*\d+(?:[.,]\d+)?|\s+\d+(?:[.,]\d+)?\s*(?:kg|g|mg|l|ml|cl|pcs?|pc)|\s*[([][^()[\]]*\d[^()[\]]*[)\]])$/i;

/* strip a trailing quantity / size note from a name, e.g. "Parmesan 200 g" ->
   "parmesan", "Tomatoes (2x400g)" -> "tomatoes". Deburred, so it doubles as a
   grouping key. A bracketed note is only stripped when it has a digit, so real
   descriptors ("(spicy)", "(Keisy)") survive. */
export function stripQty(name) {
  let s = deburr(name || "").replace(/\s+/g, " ").trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/[.,;]+$/, "").replace(TRAILING_AMOUNT, "").trim();
  } while (s !== prev);
  return s;
}

/* a ticked item is "recipe-specific" if it carries an amount: a real qty
   field, or a quantity left in the name (hand-typed items don't parse one) */
function isQuantified(it) {
  const q = Number(it.qty);
  if (Number.isFinite(q) && q !== 0) return true;
  return TRAILING_AMOUNT.test(deburr(it.name || "").replace(/\s+/g, " ").trim());
}

/* Clean up also retires ticked rows nobody has used in a long time.

   Same gesture, same meaning ("tidy the ticked block"), and doing it on an
   explicit tap beats a scheduled job that removes things unasked. It matters
   because the whole list is re-uploaded on every write, so the ticked
   catalogue is paid for on every single tick; this is what stops it growing
   forever. Retired rows also stop appearing as "add back" suggestions, which
   is the point: they are things nobody buys. */
const PRUNE_MONTHS = 6;

/* The clock starts here, not at whatever addedAt a row happens to carry.
   Usage tracking began with v9.22; before that nothing recorded whether an
   item was ever actually bought. The seed's addedAt is the bootstrap date, so
   letting it age rows out on its own would retire the catalogue on the
   strength of a timestamp that never meant "last used". Flooring at the epoch
   means the first prune cannot land until PRUNE_MONTHS of real use have been
   observed: six months from this build, whatever the data says.
   food/tools/prune_shopping_list.py mirrors both constants. */
const PRUNE_EPOCH = Date.parse("2026-09-03T00:00:00Z");

/* Last evidence a row was used: touchedAt moves on every tick and un-tick.
   Without one, the row counts as last used at its addedAt or the epoch,
   whichever is later, so a row added tomorrow ages from tomorrow and a seed
   row ages from the epoch. Never null: every row has a defensible date. */
function lastUsedAt(it) {
  const touched = Date.parse(it.touchedAt || "");
  if (Number.isFinite(touched)) return touched;
  const added = Date.parse(it.addedAt || "");
  return Math.max(Number.isFinite(added) ? added : PRUNE_EPOCH, PRUNE_EPOCH);
}

function pruneCutoffMs() {
  const d = new Date();
  d.setMonth(d.getMonth() - PRUNE_MONTHS);
  return d.getTime();
}

/* the group key: same concept (slug, or the de-quantified name) and same
   variant (the note field, where recipe adds put the variant) */
function cleanupKey(it) {
  return `${it.slug || stripQty(it.name)}|${deburr((it.note || "").trim())}`;
}

/* Everything Clean up would remove, and why. Per group of ticked items: keep
   one (a non-quantified staple by preference, else the shortest name), delete
   the rest; then delete that survivor too if it is itself quantified.
   Survivors stay ticked. Then, separately, anything ticked and past the age
   cutoff. Computing without mutating lets the confirm step show a count. */
function cleanupPlan() {
  const groups = new Map();
  for (const it of store.state.list) {
    if (!it.checked) continue;
    const k = cleanupKey(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }

  const drop = new Set();
  for (const items of groups.values()) {
    const sorted = items.slice().sort(
      (a, b) =>
        (isQuantified(a) - isQuantified(b)) ||
        (a.name.trim().length - b.name.trim().length) ||
        a.name.localeCompare(b.name),
    );
    const [keep, ...rest] = sorted;
    rest.forEach((it) => drop.add(it.id));
    if (isQuantified(keep)) drop.add(keep.id);
  }
  const dupes = drop.size;

  const cut = pruneCutoffMs();
  let stale = 0;
  for (const it of store.state.list) {
    if (!it.checked || drop.has(it.id)) continue;
    if (lastUsedAt(it) < cut) { drop.add(it.id); stale++; }
  }
  return { ids: [...drop], dupes, stale };
}



/* Clean up: one tap, and Undo covers the mistake, so there is no two-tap
   confirm any more. The snapshot keeps every removed row with its position. */
export function tidyChecked() {
  if (store.readOnly()) return;
  const plan = cleanupPlan();
  if (!plan.ids.length) { snack({ text: "Nothing to clean up" }); return; }
  const snap = store.snapshotItems(plan.ids);
  store.removeMany(plan.ids);
  snack({
    text: `Cleared ${plan.ids.length} bought item${plan.ids.length === 1 ? "" : "s"}`,
    action: "Undo",
    onAction: () => store.restoreItems(snap),
  });
}

/* An imported binding is read-only, so a module that does not declare
   one of these cannot assign to it. These are the writes that used to
   happen across what was a single shared scope. */
export function setCheckedOpen(v) { checkedOpen = v; }
