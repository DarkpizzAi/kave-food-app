/* Spoon: the first-run gate. The hub site's own pattern, so all three
   household apps open the same way: the wordmark, one masked pill field and
   a round arrow button. No labels, no placeholder, no error text; a token
   that cannot read the shopping list just clears the field. After a fresh
   token, two one-tap steps in the same look: who, then which theme.

   While the gate is up, body.gated hides the rest of the app (styles.css);
   render.js shows it whenever gateStep() says so. The Settings token field
   stays for replacing a token; clearing it there brings the gate back. */
"use strict";

import { github } from "../github.js";
import { syncHeaderHeight } from "./pull-to-sync.js";
import { IS_LOCAL_DEV, store } from "./store.js";
import { PALETTES } from "./theme.js";
import { $, escapeHtml } from "./util.js";

/* true between a fresh token and the theme pick, this session only */
let fresh = false;

/* On the local dev server, ?dev skips the gate so the bundled snapshots
   (recipes.dev.json, price-series.dev.json) can be browsed with no token.
   Without it the gate shows, so the no-token screen stays testable. */
/* read when asked, never at import: store.js and this module import each
   other in a cycle, so IS_LOCAL_DEV is not initialised yet at import time */
const devBypass = () => IS_LOCAL_DEV && new URLSearchParams(location.search).has("dev");

export function gateStep() {
  const s = store.state.settings;
  if (devBypass()) return null;
  if (!s.token) return "token";
  if (!s.who) return "who";
  return fresh ? "theme" : null;
}

const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const MARK = '<span class="gate-mark">Spoon</span>';

/* Each palette's accent, read from tokens.css rather than copied here. */
function accents() {
  const root = document.documentElement, prev = root.getAttribute("data-palette"), out = {};
  for (const id of Object.keys(PALETTES)) {
    if (id === "cobalt") root.removeAttribute("data-palette"); else root.setAttribute("data-palette", id);
    out[id] = getComputedStyle(root).getPropertyValue("--accent").trim();
  }
  if (prev === null) root.removeAttribute("data-palette"); else root.setAttribute("data-palette", prev);
  return out;
}

function html(step) {
  if (step === "token") {
    return `<div class="gate-box">${MARK}<div class="gate-field">`
      + '<input id="gateToken" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Access" data-1p-ignore data-lpignore="true">'
      + `<button type="button" class="gate-go" id="gateGo" aria-label="Connect">${ARROW}</button></div></div>`;
  }
  if (step === "who") {
    return `<div class="gate-box">${MARK}<div class="setup-row">`
      + '<button type="button" class="setup-choice" data-gate-who="isa">Isa</button>'
      + '<button type="button" class="setup-choice" data-gate-who="hugo">Hugo</button></div></div>';
  }
  const acc = accents();
  return `<div class="gate-box">${MARK}<div class="setup-row">${Object.keys(PALETTES).map((id) =>
    `<button type="button" class="setup-swatch" data-gate-palette="${escapeHtml(id)}" aria-label="${escapeHtml(id)}" style="background:${escapeHtml(acc[id] || "")}"></button>`).join("")}</div></div>`;
}

/* Draws the gate (or hides it). Returns true while the app is gated.
   onToken runs once a fresh token is saved. */
export function renderGate({ onToken }) {
  const step = gateStep();
  const root = $("#gate");
  document.body.classList.toggle("gated", !!step);
  if (!root) return !!step;
  if (!step) {
    const leaving = !!root.dataset.step;
    root.hidden = true; root.innerHTML = ""; root.dataset.step = "";
    if (leaving) {
      // the header was hidden while gated, so its height measured 0: measure
      // it again now it shows, and start the app at the top
      syncHeaderHeight();
      window.scrollTo(0, 0);
    }
    return false;
  }
  root.hidden = false;
  if (root.dataset.step === step) return true;   // already drawn: keep what is typed
  root.dataset.step = step;
  root.innerHTML = html(step);

  const input = $("#gateToken", root);
  if (input) {
    let busy = false;
    const submit = async () => {
      const candidate = input.value.trim();
      input.value = "";
      if (!candidate || busy) return;
      busy = true;
      github.setToken(candidate);
      let ok = false;
      try { await github.getFile(github.config.listPath); ok = true; } catch { ok = false; }
      busy = false;
      if (!ok) { github.setToken(store.state.settings.token); input.focus(); return; }
      fresh = true;
      store.setToken(candidate);
      onToken();
    };
    $("#gateGo", root).addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    input.focus();
  }
  root.querySelectorAll("[data-gate-who]").forEach((b) =>
    b.addEventListener("click", () => store.setWho(b.dataset.gateWho)));
  root.querySelectorAll("[data-gate-palette]").forEach((b) =>
    b.addEventListener("click", () => { fresh = false; store.setPalette(b.dataset.gatePalette); }));
  const first = root.querySelector(".setup-choice, .setup-swatch");
  if (first) first.focus();
  return true;
}
