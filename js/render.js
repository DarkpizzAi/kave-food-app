/* Ladle: top-level render. Every interaction ends here, and so do the shell's
   moving parts: tab switches, the menu drawer and the full pages.

   Split out of app.js, which was one 4240-line classic script. The
   boundaries are the section banners that file already drew, so any
   line's history is still one git log --follow away. */
"use strict";

import { enterLayer, exitLayer, fadeThrough, sharedAxisIn, sharedAxisOut } from "../m3/kave-m3.js";
import { backSheets } from "./back-sheets.js";
import { store, syncState } from "./store.js";
import { flushing, syncBarOn, syncing } from "./sync.js";
import { VIEW_TITLES } from "./theme.js";
import { $, $$, markJump } from "./util.js";
import { renderList, renderListBadge } from "./view-list.js";
import { renderPlanner } from "./view-plan.js";
import { renderPrices } from "./view-prices.js";
import { renderRecipes } from "./view-recipes.js";
import { renderRoadmap } from "./view-roadmap.js";
import { checkToken, renderSettings } from "./view-settings.js";
import { renderGate } from "./gate.js";

// show the back-to-top button once the shopping list is scrolled past ~200px
export function updateToTop() {
  const btn = $("#toTop");
  if (!btn) return;
  const sc = document.scrollingElement || document.documentElement;
  btn.classList.toggle("show", store.state.view === "list" && sc.scrollTop > 200);
}

/* ---------- tabs ---------- */
// the nav says "insights"; the store has always called that view "prices"
const VIEW_OF = { list: "list", insights: "prices", recipes: "recipes" };
export function setView(name) { store.setView(VIEW_OF[name] || name); }

let shownView = null;      // the tab currently on screen, to spot a switch
let tabToken = 0;

// every tab hidden but `current`, nothing left mid-fade
function settleViews(current) {
  $$(".view").forEach((v) => {
    v.hidden = v.id !== `view-${current}`;
    v.classList.remove("view-leaving");
    v.style.opacity = "";
  });
}

function showView(view) {
  const prev = shownView;
  shownView = view;
  const token = ++tabToken;
  if (prev === null || !$(`#view-${prev}`) || !$(`#view-${view}`)) {
    settleViews(view);
    return;
  }
  settleViews(prev);
  // a tab switch lands at the top with the bar showing; not a scroll the user made
  markJump(); window.scrollTo(0, 0); showTopBar();
  const oldEl = $(`#view-${prev}`), newEl = $(`#view-${view}`);
  oldEl.classList.add("view-leaving");   // lifted out of the flow while it fades
  newEl.style.opacity = "0";
  newEl.hidden = false;
  fadeThrough(oldEl, newEl).then(() => { if (token === tabToken) settleViews(view); });
}

/* ---------- top bar that scrolls away ---------- */
export function showTopBar() { $("#topBar").classList.remove("is-hidden"); }
let topBarWired = false;
function initTopBar() {
  const bar = $("#topBar");
  let lastY = window.scrollY;
  window.addEventListener("scroll", () => {
    const y = window.scrollY;
    // a programmatic jump never hides the bar (see markJump in util.js)
    if (document.documentElement.dataset.jump) { lastY = y; return; }
    if (y <= 0 || y < lastY) bar.classList.remove("is-hidden");
    else if (y > 64 && y > lastY) bar.classList.add("is-hidden");
    lastY = y;
  }, { passive: true });
}

/* ---------- drawer ---------- */
// the control that opened the drawer or a page, so closing hands focus back
let opener = null;
function restoreFocus() {
  const o = opener; opener = null;
  if (o && o.isConnected && o.offsetParent !== null) o.focus({ preventScroll: true });
}
let drawerOpen = false;
let drawerHasHistory = false;
let drawerCloseRequested = false;   // history.back() sent, popstate not landed yet
let drawerToken = 0;

export function openDrawer() {
  if (drawerOpen) return;
  drawerOpen = true;
  drawerCloseRequested = false;
  const d = $("#drawer"), scrim = $("#drawerScrim");
  drawerToken++;
  opener = document.activeElement;
  scrim.hidden = false; d.hidden = false;
  enterLayer(d, "drawer");
  try { history.pushState({ drawer: true }, ""); drawerHasHistory = true; }
  catch (e) { drawerHasHistory = false; }
  const first = d.querySelector(".m3-drawer__item");
  if (first) first.focus({ preventScroll: true });
}
function hideDrawer(keepOpener = false) {
  if (!drawerOpen) return;
  drawerOpen = false;
  drawerCloseRequested = false;
  const d = $("#drawer"), scrim = $("#drawerScrim");
  const token = ++drawerToken;
  exitLayer(d, "drawer").then(() => {
    if (token !== drawerToken) return;   // reopened meanwhile
    d.hidden = true; scrim.hidden = true;
  });
  if (!keepOpener) restoreFocus();
}
// the tap, the scrim and the phone's back button are one path
export function closeDrawer() {
  if (!drawerOpen || drawerCloseRequested) return;   // a back is already in flight
  if (drawerHasHistory) { drawerHasHistory = false; drawerCloseRequested = true; history.back(); }
  else hideDrawer();
}
backSheets.push({
  isOpen: () => drawerOpen,
  close: () => { drawerHasHistory = false; hideDrawer(); },
});

/* ---------- pages (Settings, Roadmap) ---------- */
const PAGE_TITLES = { settings: "Settings", roadmap: "Roadmap" };
let pageName = null;
let pageHasHistory = false;
let pageCloseRequested = false;
let pageToken = 0;

export function openPage(name) {
  if (!PAGE_TITLES[name] || pageName === name) return;
  const host = $("#page");
  // opened from the drawer: the drawer's history entry becomes the page's, so
  // the phone's back is one press from the tab either way
  const inherit = drawerOpen && drawerHasHistory;
  if (drawerOpen) {
    drawerHasHistory = false;
    hideDrawer(true);            // focus goes back to the opener when the page closes
  }
  if (!pageName && !inherit && !drawerOpen) opener = document.activeElement;
  pageName = name;
  pageCloseRequested = false;
  pageToken++;
  $("#pageTitle").textContent = PAGE_TITLES[name];
  $("#pageSettings").hidden = name !== "settings";
  $("#pageRoadmap").hidden = name !== "roadmap";
  if (name === "roadmap") $("#pageRoadmap").innerHTML = renderRoadmap();
  host.hidden = false;
  host.querySelector(".page-body").scrollTop = 0;
  sharedAxisIn(host, 1);
  if (inherit) pageHasHistory = true;
  else {
    try { history.pushState({ page: name }, ""); pageHasHistory = true; }
    catch (e) { pageHasHistory = false; }
  }
  render(store.state);
  $("#pageBack").focus({ preventScroll: true });
}
function hidePage() {
  if (!pageName) return;
  pageName = null;
  pageCloseRequested = false;
  const host = $("#page");
  const token = ++pageToken;
  sharedAxisOut(host, -1).then(() => { if (token === pageToken) host.hidden = true; });
  restoreFocus();
}
export function closePage() {
  if (!pageName || pageCloseRequested) return;
  if (pageHasHistory) { pageHasHistory = false; pageCloseRequested = true; history.back(); }
  else hidePage();
}
export const pageIsOpen = () => pageName !== null;
backSheets.push({
  isOpen: () => pageName !== null,
  close: () => { pageHasHistory = false; hidePage(); },
});

export function render(state) {
  // the gate first: no token (or no "who") and nothing else shows
  if (renderGate({ onToken: () => checkToken() })) return;
  if (!topBarWired) { topBarWired = true; initTopBar(); }
  $("#viewTitle").textContent = VIEW_TITLES[state.view];
  if (shownView !== state.view) showView(state.view);
  $$("[data-view]").forEach((b) => {
    const on = (VIEW_OF[b.dataset.view] || b.dataset.view) === state.view;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-current", on ? "page" : "false");
    const ic = b.querySelector(".m3-icon");
    if (ic) ic.classList.toggle("m3-icon--fill", on);
  });

  document.body.classList.toggle("readonly", store.readOnly());

  // header dot: spinner while working, amber when edits are unsynced, red on error
  const dot = $("#syncDot");
  dot.className = "sync-dot" + (
    syncing || flushing ? " working"
    : syncState.kind === "unauthorized" || syncState.kind === "offline" || syncState.kind === "rateLimited" ? " error"
    : store.queue.length ? " pending"
    : ""
  );

  // the bar under the header runs for Sync now only; a pull has its own indicator
  $$(".sync-bar").forEach((b) => { b.hidden = !syncBarOn; });
  // the offline card follows the phone's own word on the network
  $("#offlineCard").hidden = navigator.onLine !== false;

  renderListBadge(state);
  if (state.view === "list") renderList(state);
  if (state.view === "prices") renderPrices(state);
  if (state.view === "recipes") renderRecipes(state);
  if (state.view === "planner") renderPlanner(state);
  if (pageName === "settings") renderSettings(state);
  updateToTop();
}
