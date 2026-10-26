/* Ladle: the Settings page: theme, sync, user, token, update, diagnostics.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { github } from "../github.js";
import { render } from "./render.js";
import { IS_LOCAL_DEV, setSyncState, store, syncState } from "./store.js";
import { flushing, fullSync, hhmm, syncRecipes, syncing, timeAgo } from "./sync.js";
import { PALETTES } from "./theme.js";
import { $, $$, escapeHtml } from "./util.js";

// { state: "idle"|"checking"|"ok"|"error", text, login }  (not persisted)
let tokenStatus = { state: "idle", text: "" };

export async function checkToken() {
  const token = store.state.settings.token;
  if (!token) {
    tokenStatus = { state: "idle", text: "" };
    renderSettings(store.state);
    return;
  }
  tokenStatus = { state: "checking", text: "Checking..." };
  renderSettings(store.state);
  try {
    const { login } = await github.getUser();
    // Proves repo access AND keeps what it downloads. This used to be a bare
    // getFile() whose 86 KB body was parsed and thrown away, and then fetched
    // again by the fullSync below - two full recipe downloads per app open.
    // Going through syncRecipes stores the etag, so that second read is a 304.
    await syncRecipes();
    tokenStatus = { state: "ok", login, text: `Connected as ${login}` };
    if (syncState.kind === "unauthorized") setSyncState({ kind: "idle", resetAt: null });
    fullSync().then(() => render(store.state)); // a fresh token: pull everything
  } catch (e) {
    const c = github.config;
    const msg = {
      unauthorized: `Token rejected. It must be a fine-grained token with Contents access to ${c.owner}/${c.repo}.`,
      notFound: `That token cannot see ${c.owner}/${c.repo}. Give it repository access.`,
      offline: "Offline, cannot check the token right now.",
      rateLimited: "GitHub is busy, try again in a minute.",
    }[e.gh] || `Could not check the token (${e.message}).`;
    tokenStatus = { state: "error", text: msg };
    if (e.gh === "unauthorized") setSyncState({ kind: "unauthorized", resetAt: null });
  }
  render(store.state);
}


/* The five seeds as plain solid swatches. These hexes are the seeds' identities
   (the same five the kit's data-seed blocks are built from); the fill is only
   the swatch, every other colour on the page comes from the kit. */
const SEED_HEX = {
  blue: "#4285f4", teal: "#009688", yellow: "#ffc107", periwinkle: "#5c6bc0", terracotta: "#c05c46",
};

const row = (icon, title, body, trail = "") => `
  <div class="m3-list-item set-row">
    <span class="m3-list-item__lead"><span class="m3-icon">${icon}</span></span>
    <div class="m3-list-item__text m3-list-item__text--wrap"><div class="m3-title-m">${title}</div>${body}</div>
    ${trail}
  </div>`;

/* Option D: grouped rows like Android Settings. Built once into the Settings
   page (every id below is bound once, in wire.js) and only updated in place
   after that, so a half-typed token is never thrown away by a re-render.
   Nothing here comes from the sync: it is all fixed markup. */
export function buildSettings() {
  const host = $("#pageSettings");
  if (!host) return;
  const swatches = Object.keys(PALETTES).map((id) => `
    <button type="button" class="set-swatch" data-palette="${id}" role="radio" aria-checked="false" aria-label="${PALETTES[id].name}">
      <span class="m3-swatch" style="--kave-k:${SEED_HEX[id]}"><span class="m3-swatch__check m3-icon" hidden>check</span></span>
      <span class="m3-label-m">${PALETTES[id].name}</span>
    </button>`).join("");
  host.innerHTML = `
    <div class="m3-list-header m3-title-s">Theme</div>
    <div id="setPalette" class="set-swatches" role="radiogroup" aria-label="Theme colour">${swatches}</div>
    <p class="m3-body-s m3-variant set-note">Light and dark follow the phone.</p>

    <div class="m3-list-header m3-title-s">Sync</div>
    <div class="m3-grouped">
      ${row("sync", "Sync", '<div id="syncStatus" class="sync-status m3-body-m m3-variant"></div>',
        '<button type="button" id="refreshBtn" class="m3-btn m3-btn--tonal m3-btn--small" disabled>Sync now</button>')}
    </div>

    <div class="m3-list-header m3-title-s">Advanced</div>
    <div class="m3-grouped">
      ${row("person", "User", '<div class="m3-body-m m3-variant">Stamps every edit you make</div>'
        + '<div id="setWho" class="m3-chips set-who"><button type="button" class="m3-chip" data-who="isa">Isa</button>'
        + '<button type="button" class="m3-chip" data-who="hugo">Hugo</button></div>')}
      ${row("link", "App link",
        '<input id="appLink" class="set-bare m3-body-m m3-variant" type="text" value="https://darkpizzai.github.io/kave-food-app/" readonly aria-label="App link" />'
        + '<div class="m3-body-s m3-variant">Open Ladle on another device: copy this and send it to your phone.</div>',
        '<button type="button" id="copyAppLink" class="m3-icon-btn" aria-label="Copy link"><span class="m3-icon">content_copy</span></button>')}
      ${row("key", "GitHub token",
        '<input id="setToken" class="set-bare m3-body-m" type="password" placeholder="github_pat_..." autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" aria-label="GitHub token" />'
        + '<p id="tokenStatus" class="token-status m3-body-s" hidden></p>'
        + '<div class="m3-body-s m3-variant">Stored on this device only, sent only to GitHub. It unlocks your shared list and recipes.</div>',
        '<button type="button" id="clearToken" class="m3-btn m3-btn--text">Clear</button>')}
      ${row("system_update", "Updates", '<div id="updateStatus" class="sync-status m3-body-m m3-variant"></div>',
        '<button type="button" id="updateBtn" class="m3-btn m3-btn--text">Check for updates</button>')}
      ${row("monitor_heart", "Display", '<div id="displayDiag" class="sync-status m3-body-m m3-variant"></div>')}
    </div>`;
}

export function renderSettings(state) {
  if ($("#page").hidden) return;   // built once, painted when the page is open
  $$("#setWho button").forEach((b) => {
    b.classList.toggle("is-selected", b.dataset.who === state.settings.who);
  });
  const seed = state.settings.palette || "blue";
  $$("#setPalette .set-swatch").forEach((b) => {
    const on = b.dataset.palette === seed;
    b.setAttribute("aria-checked", String(on));
    b.querySelector(".m3-swatch").classList.toggle("is-selected", on);
    b.querySelector(".m3-swatch__check").hidden = !on;
  });

  const t = $("#setToken");
  if (document.activeElement !== t) t.value = state.settings.token || "";

  const st = $("#tokenStatus");
  st.hidden = tokenStatus.state === "idle";
  st.textContent = tokenStatus.text;
  st.className = "token-status m3-body-s " + tokenStatus.state;

  renderSyncStatus();
  renderUpdateStatus();
  renderDisplayDiag();

  const rb = $("#refreshBtn");
  if (rb.textContent !== "Syncing...") {
    rb.disabled = !state.settings.token;
    rb.textContent = "Sync now";
    rb.removeAttribute("title");
  }
}

/* ---------- app update (Settings > Update) ---------- */
/* The toast on `controllerchange` only helps if the app happens to be open
   when the browser notices a new worker, which on a phone it usually is not.
   This is the manual path: ask the registration to re-fetch the worker
   script, report honestly what came back, and reload once it has taken over. */

export let updateState = { kind: "idle", version: null, checkedAt: null };

// ask the controlling worker which VERSION it is running
function swVersion() {
  return new Promise((resolve) => {
    const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!sw) return resolve(null);
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), 1500);
    ch.port1.onmessage = (e) => {
      clearTimeout(t);
      resolve((e.data && e.data.version) || null);
    };
    try { sw.postMessage({ type: "version" }, [ch.port2]); }
    catch (err) { clearTimeout(t); resolve(null); }
  });
}

// resolves when an incoming worker finishes installing, or rejects if it fails
function whenSettled(worker) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (worker.state === "activated") resolve("activated");
      else if (worker.state === "installed") resolve("installed");
      else if (worker.state === "redundant") reject(new Error("install failed"));
    };
    worker.addEventListener("statechange", check);
    check();
  });
}

export async function checkForUpdate() {
  if (!("serviceWorker" in navigator) || IS_LOCAL_DEV) {
    updateState = { ...updateState, kind: "unsupported" };
    renderUpdateStatus();
    return;
  }
  updateState = { ...updateState, kind: "checking" };
  renderUpdateStatus();

  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      updateState = { ...updateState, kind: "unsupported" };
      renderUpdateStatus();
      return;
    }

    await reg.update();
    const incoming = reg.installing || reg.waiting;

    if (!incoming) {
      updateState = { kind: "current", version: await swVersion(), checkedAt: Date.now() };
      renderUpdateStatus();
      return;
    }

    updateState = { ...updateState, kind: "installing" };
    renderUpdateStatus();

    const state = await whenSettled(incoming);
    // install() calls skipWaiting, but nudge a worker the browser held back
    if (state === "installed") incoming.postMessage({ type: "skipWaiting" });

    updateState = { ...updateState, kind: "ready", checkedAt: Date.now() };
    renderUpdateStatus();
  } catch (e) {
    updateState = { ...updateState, kind: "error", checkedAt: Date.now() };
    renderUpdateStatus();
  }
}

let versionAsked = false;
function renderUpdateStatus() {
  const box = $("#updateStatus");
  const btn = $("#updateBtn");
  if (!box || !btn) return;

  // fill the version line in the background the first time Settings renders
  if (!versionAsked && !updateState.version && !IS_LOCAL_DEV) {
    versionAsked = true;
    swVersion().then((v) => {
      if (!v) return;
      updateState = { ...updateState, version: v };
      renderUpdateStatus();
    });
  }

  const lines = [];

  if (updateState.version) lines.push(["muted", `Version ${updateState.version}`]);

  const busy = updateState.kind === "checking" || updateState.kind === "installing";
  btn.disabled = busy;
  btn.textContent = updateState.kind === "ready" ? "Restart to finish" : "Check for updates";

  if (updateState.kind === "checking") {
    lines.push(["muted", "Checking…"]);
  } else if (updateState.kind === "installing") {
    lines.push(["muted", "New version found, downloading…"]);
  } else if (updateState.kind === "ready") {
    lines.push(["ok", "New version ready"]);
  } else if (updateState.kind === "current") {
    lines.push(["ok", "Up to date"]);
  } else if (updateState.kind === "error") {
    lines.push(["error", "Check failed. Try again when you have signal."]);
  } else if (updateState.kind === "unsupported") {
    lines.push(["muted", "Updates apply on reload here"]);
  } else if (IS_LOCAL_DEV) {
    lines.push(["muted", "Updates apply on reload here"]);
  } else if (!updateState.checkedAt) {
    lines.push(["muted", "Not checked yet"]);
  }

  if (updateState.kind !== "ready" && updateState.checkedAt) {
    const ago = timeAgo(updateState.checkedAt);
    if (ago) lines.push(["muted", `Checked ${ago}`]);
  }

  box.innerHTML = lines
    .map(([k, text]) => `<span class="sync-line ${k}"><i></i>${escapeHtml(text)}</span>`)
    .join("");
}

/* Does the window draw edge-to-edge, behind the system bars? If it does the
   safe-area insets are non-zero and the bars are transparent over our own
   --bg - the v9.11 header padding then closes the seam for free. Can only be
   read on the phone, so the app reports it. (Previously shipped in v9.9,
   removed in v9.10, restored once v9.11 gave the reading something to drive.) */
// The inline theme script in index.html sets this before it does anything else.
// Absent means it never ran, which on a page with a hashed script-src means the
// hash no longer matches the script - see the CSP comment in index.html.
export function themeBootRan() {
  return document.documentElement.dataset.themeBoot === "1";
}

function renderDisplayDiag() {
  const box = $("#displayDiag");
  if (!box) return;
  const mode = ["fullscreen", "standalone", "minimal-ui"]
    .find((m) => matchMedia(`(display-mode: ${m})`).matches) || "browser";
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;" +
    "padding-top:env(safe-area-inset-top,0px);" +
    "padding-bottom:env(safe-area-inset-bottom,0px);";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const top = Math.round(parseFloat(cs.paddingTop) || 0);
  const bottom = Math.round(parseFloat(cs.paddingBottom) || 0);
  probe.remove();
  const vh = Math.round(window.innerHeight);
  const sh = Math.round((screen && screen.height) || 0);
  const edge = top > 0 || bottom > 0;
  const lines = [
    ["muted", `Window ${mode}`],
    [edge ? "ok" : "warn", `Safe area top ${top}px · bottom ${bottom}px`],
    ["muted", sh > 0
      ? `Viewport ${vh}px of ${sh}px screen · ${sh - vh}px is bars`
      : `Viewport ${vh}px (screen size unavailable)`],
    [edge ? "ok" : "warn", edge
      ? "Edge to edge - the page reaches under the bars"
      : "Not edge to edge - the bars are their own strip"],
    // The theme preload is inlined in index.html and cleared by a CSP hash, so
    // editing it silently stops it running. Say so here rather than leaving a
    // flash of the wrong colours as the only symptom.
    [themeBootRan() ? "ok" : "error", themeBootRan()
      ? "Theme preload ran"
      : "Theme preload BLOCKED - recompute the CSP hash in index.html"],
  ];
  box.innerHTML = lines
    .map(([k, text]) => `<span class="sync-line ${k}"><i></i>${escapeHtml(text)}</span>`)
    .join("");
}

export function renderSyncStatus() {
  const box = $("#syncStatus");
  if (!box) return;
  const lines = [];
  if (!store.state.settings.token) {
    lines.push(["warn", "No token set"]);
  } else if (syncState.kind === "unauthorized") {
    lines.push(["error", "Token rejected"]);
  } else if (syncState.kind === "offline") {
    lines.push(["warn", "Offline"]);
  } else if (syncState.kind === "rateLimited") {
    lines.push(["warn", `GitHub busy, retrying at ${hhmm(syncState.resetAt)}`]);
  } else if (syncing || flushing) {
    lines.push(["muted", "Syncing now…"]);
  } else {
    lines.push(["ok", "Connected"]);
  }

  const q = store.queue.length;
  if (q) lines.push(["warn", `${q} change${q === 1 ? "" : "s"} waiting to sync`]);

  const ago = timeAgo(store.sync.syncedAt);
  lines.push(["muted", ago ? `Last synced ${ago}` : "Not synced yet"]);

  box.innerHTML = lines
    .map(([k, text]) => `<span class="sync-line ${k}"><i></i>${escapeHtml(text)}</span>`)
    .join("");
}

/* An imported binding is read-only, so a module that does not declare
   one of these cannot assign to it. These are the writes that used to
   happen across what was a single shared scope. */
export function setTokenStatus(v) { tokenStatus = v; }
