/* Spoon: the Shopping List tab.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { cardLabel, computeBubble, resolvePriceTarget, seriesForTarget, storeColor, storeOnColor } from "./prices-data.js";
import { store } from "./store.js";
import { flashBanner } from "./sync.js";
import { $, deburr, escapeHtml } from "./util.js";
import { goToPriceChart } from "./view-prices.js";

export let checkedOpen = false;

// the chart icon (trending line + arrowhead), same mark on the list row,
// the sheet's promo dots and the Prices nav tab - one icon, one meaning
const PRICE_ICON_PATH = '<path d="M4 17l5-6 4 3 7-7"/><path d="M15 7h5v5"/>';
// same mark, flipped: a downward trend for an Opportunities row
export const PRICE_ICON_DOWN_PATH = '<path d="M4 7l5 6 4-3 7 7"/><path d="M15 17h5v-5"/>';

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

function itemRow(it) {
  const li = document.createElement("li");
  li.className = it.checked ? "checked" : "";
  const qtyStr = it.qty != null ? `${it.qty}${it.unit ? " " + it.unit : ""}` : "";
  const hint = priceHintFor(it);
  const priceBtn = hint ? `
    <button class="price-btn" aria-label="Price history">
      ${hint.bubbleStore ? `<span class="price-bubble" style="background:${storeColor(hint.bubbleStore)}"></span>` : ""}
      <svg viewBox="0 0 24 24" fill="none" stroke="${hint.bubbleStore ? storeOnColor(hint.bubbleStore) : "currentColor"}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${PRICE_ICON_PATH}</svg>
    </button>` : "";
  li.innerHTML = `
    <button class="tick" aria-label="Toggle">${it.checked ? "✓" : ""}</button>
    <span class="main">
      <span class="nm">${escapeHtml(it.name)}</span>
      ${it.note ? `<span class="sub">${escapeHtml(it.note)}</span>` : ""}
      ${qtyStr ? `<span class="qty">${escapeHtml(qtyStr)}</span>` : ""}
    </span>
    ${priceBtn}
    <button class="del" aria-label="Remove">✕</button>`;
  $(".tick", li).addEventListener("click", () => store.toggleItem(it.id));
  $(".del", li).addEventListener("click", () => store.deleteItem(it.id));
  if (hint) {
    $(".price-btn", li).addEventListener("click", () => goToPriceChart(hint.target));
  }
  return li;
}

/* The nav badge is visible from every tab, so it updates on every render even
   when the list itself is not on screen. */
export function renderListBadge(state) {
  const n = state.list.reduce((a, x) => a + (x.checked ? 0 : 1), 0);
  const badge = $("#listBadge");
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.hidden = n === 0;
}

/* Only called when the list view is actually on screen. It rebuilds every row
   and re-binds two listeners per row; with the ticked block open that is 400+
   rows, and it used to run on every store change and every background poll
   while you were sat on Recipes or Settings looking at none of it. */
export function renderList(state) {
  const active = state.list.filter((x) => !x.checked);
  const checked = state.list.filter((x) => x.checked);

  $("#addName").disabled = store.readOnly();

  const ul = $("#listItems");
  ul.innerHTML = "";
  active.forEach((it) => ul.appendChild(itemRow(it)));
  $("#listEmpty").hidden = active.length !== 0 || checked.length !== 0;

  const block = $("#checkedBlock");
  block.hidden = checked.length === 0;
  if (checked.length) {
    $("#checkedCount").textContent =
      `${checked.length} ticked item${checked.length === 1 ? "" : "s"}`;
    $("#checkedCaret").textContent = checkedOpen ? "▾" : "▸";
    const cul = $("#checkedItems");
    cul.hidden = !checkedOpen;
    cul.innerHTML = "";
    if (checkedOpen) {
      checked
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((it) => cul.appendChild(itemRow(it)));
    }
  }
}

export function renderSuggestions(state) {
  const box = $("#suggestions");
  const q = deburr($("#addName").value.trim());
  if (!q) { box.hidden = true; box.innerHTML = ""; return; }
  const matches = state.list
    .filter((it) => it.checked && deburr(it.name).includes(q))
    .slice(0, 6);
  if (!matches.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.innerHTML = `<div class="hint-line">Add back to the list:</div>`;
  matches.forEach((it) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = it.name;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      store.uncheckItem(it.id);
      $("#addName").value = "";
      renderSuggestions(state);
    });
    box.appendChild(b);
  });
  box.hidden = false;
}

export function submitAddName() {
  const input = $("#addName");
  const raw = input.value.trim();
  if (!raw) return;
  // exact (accent/case-insensitive) match on a ticked item: untick it instead
  const existing = store.state.list.find(
    (it) => it.checked && deburr(it.name) === deburr(raw),
  );
  if (existing) store.uncheckItem(existing.id);
  else store.addItem({ name: raw, qty: "", unit: "", note: "" });
  input.value = "";
  renderSuggestions(store.state);
  input.focus();
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
// a sweep bigger than this asks before deleting, see tidyChecked
const CONFIRM_OVER = 20;

/* The clock starts here, not at whatever addedAt a row happens to carry.
   Usage tracking began with v9.22; before that nothing recorded whether an
   item was ever actually bought. The seed's addedAt is the bootstrap date, so
   letting it age rows out on its own would retire the catalogue on the
   strength of a timestamp that never meant "last used". Flooring at the epoch
   means the first prune cannot land until PRUNE_MONTHS of real use have been
   observed: six months from this build, whatever the data says.
   food/tools/prune_shopping_list.py mirrors both constants. */
const PRUNE_EPOCH = Date.parse("2026-09-03T00:00:00Z");

let pruneArmed = false;
let pruneArmTimer;

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


function disarmPrune() {
  clearTimeout(pruneArmTimer);
  pruneArmed = false;
}

export function tidyChecked() {
  const plan = cleanupPlan();

  if (!plan.ids.length) {
    disarmPrune();
    showTidyResult("Nothing to clean up");
    return;
  }

  /* A big sweep - typically the first prune, retiring the untouched half of
     the seed catalogue in one go - is irreversible and there is no undo, so
     make it two taps. Small tidies go straight through, as they always have.
     The guard covers a large duplicate merge too, which was never confirmed. */
  if (plan.ids.length > CONFIRM_OVER && !pruneArmed) {
    pruneArmed = true;
    clearTimeout(pruneArmTimer);
    showTidyResult(`Remove ${plan.ids.length}? Tap again`, { hold: 6000 });
    pruneArmTimer = setTimeout(() => { pruneArmed = false; }, 6000);
    return;
  }
  disarmPrune();

  const dropSet = new Set(plan.ids);
  const stillChecked = store.state.list.some((x) => x.checked && !dropSet.has(x.id));
  store.removeMany(plan.ids);

  const bits = [];
  if (plan.dupes) bits.push(`${plan.dupes} duplicate${plan.dupes === 1 ? "" : "s"}`);
  if (plan.stale) bits.push(`${plan.stale} unused`);
  const msg = `${bits.join(" and ")} cleaned up`;
  // the result briefly replaces the Clean up button; if the whole ticked block
  // just emptied there is no button, so fall back to the page banner
  if (stillChecked) showTidyResult(msg);
  else flashBanner(msg);
}

/* the Clean up result fades in over the button, holds, then the button fades
   back. render() does not touch #tidyChecked, so the swap survives it. */
let tidyResultTimer;
function showTidyResult(text, opts) {
  const hold = (opts && opts.hold) || 2600;
  const btn = $("#tidyChecked");
  if (!btn) return;
  clearTimeout(tidyResultTimer);
  btn.classList.add("fading");
  setTimeout(() => {
    btn.textContent = text;
    btn.classList.add("result");
    btn.classList.remove("fading");
  }, 200);
  tidyResultTimer = setTimeout(() => {
    btn.classList.add("fading");
    setTimeout(() => {
      btn.textContent = "Clean up";
      btn.classList.remove("result", "fading");
    }, 200);
  }, hold);
}

/* An imported binding is read-only, so a module that does not declare
   one of these cannot assign to it. These are the writes that used to
   happen across what was a single shared scope. */
export function setCheckedOpen(v) { checkedOpen = v; }
