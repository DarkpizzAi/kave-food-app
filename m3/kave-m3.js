/* kave-m3.js: motion and status helpers for the Material 3 kit.
   Plain ES module, no build, no app state: callers pass elements and callbacks.
   Safe under CSP script-src 'self': DOM is built with createElement and textContent only.
   Motion follows the Material 3 scale: emphasized easing for things that move across the screen,
   decelerate for things that arrive, accelerate for things that leave. All of it stops when the
   phone asks for reduced motion. */

export const EASE = {
  emphasized: "cubic-bezier(.2,0,0,1)",
  decelerate: "cubic-bezier(.05,.7,.1,1)",
  accelerate: "cubic-bezier(.3,0,.8,.15)",
};

/* window width in px to the M3 window size class */
export function sizeClass(widthPx) {
  return widthPx < 600 ? "compact" : widthPx < 840 ? "medium" : "expanded";
}

/* 0 when the phone asks for reduced motion, else 1 */
export function motionFactor() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1; } catch (e) { return 1; }
}

/* Web Animations wrapper. Resolves at the latest after ms * factor + 120 and then finish()es the
   animation: a hidden tab stops animations and must never hold the screen up. */
export function play(el, keyframes, ms, easing, opts = {}) {
  const f = motionFactor();
  if (!el || !f || typeof el.animate !== "function") return Promise.resolve();
  const delay = (opts.delay || 0) * f;
  const a = el.animate(keyframes, { duration: ms * f, easing, fill: opts.fill || "backwards", delay });
  return new Promise((resolve) => {
    let done = false;
    const end = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { try { a.finish(); } catch (e) { /* already done */ } end(); }, ms * f + delay + 120);
    Promise.resolve(a.finished).then(end, end);
  });
}

/* An exit or "out" animation fills forwards. Cancel earlier kit animations before an element enters
   again, or the old fill would come back after the new animation ends and hide the element. */
const reset = (el) => { if (el && typeof el.getAnimations === "function") el.getAnimations().forEach((a) => a.cancel()); };

const DIALOG_REST = "translate(-50%, -50%)";
const scrimOf = (el) => {
  const s = el && el.previousElementSibling;
  return s && s.classList.contains("m3-scrim") ? s : null;
};

/* kind: "bottom" | "side" | "drawer" | "dialog" | "menu" | "page". "side" is a sheet from the right, "drawer" the modal navigation drawer from the left. fromRect {x,y,w,h} turns a sheet into a container transform. */
export function enterLayer(el, kind, fromRect) {
  reset(el); reset(scrimOf(el));
  play(scrimOf(el), [{ opacity: 0 }, { opacity: 1 }], 200, "linear");
  if (fromRect && (kind === "bottom" || kind === "side" || kind === "drawer")) return containerTransform(el, fromRect);
  const D = EASE.decelerate;
  if (kind === "bottom") return play(el, [{ transform: "translateY(100%)" }, { transform: "none" }], 400, D);
  if (kind === "side") return play(el, [{ transform: "translateX(100%)" }, { transform: "none" }], 400, D);
  if (kind === "drawer") return play(el, [{ transform: "translateX(-100%)" }, { transform: "none" }], 350, D);
  if (kind === "dialog") return play(el, [{ opacity: 0, transform: DIALOG_REST + " scale(.85)" }, { opacity: 1, transform: DIALOG_REST + " scale(1)" }], 250, D);
  if (kind === "menu") {
    if (el && !el.style.transformOrigin) el.style.transformOrigin = "top left";
    return play(el, [{ opacity: 0, transform: "scale(.8)" }, { opacity: 1, transform: "none" }], 200, D);
  }
  if (kind === "page") return play(el, [{ opacity: 0, transform: "translateY(32px)" }, { opacity: 1, transform: "none" }], 350, D);
  return Promise.resolve();
}

/* the forwards fill keeps el hidden until the app removes or hides it, or re-enters it through enterLayer */
export function exitLayer(el, kind) {
  const o = { fill: "forwards" }, A = EASE.accelerate;
  play(scrimOf(el), [{ opacity: 1 }, { opacity: 0 }], 200, "linear", o);
  if (kind === "bottom") return play(el, [{ transform: "none" }, { transform: "translateY(100%)" }], 250, A, o);
  if (kind === "side") return play(el, [{ transform: "none" }, { transform: "translateX(100%)" }], 250, A, o);
  if (kind === "drawer") return play(el, [{ transform: "none" }, { transform: "translateX(-100%)" }], 200, A, o);
  if (kind === "dialog") return play(el, [{ opacity: 1, transform: DIALOG_REST }, { opacity: 0, transform: DIALOG_REST + " scale(.92)" }], 150, A, o);
  if (kind === "menu") return play(el, [{ opacity: 1 }, { opacity: 0 }], 120, "linear", o);
  if (kind === "page") return play(el, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(32px)" }], 200, A, o);
  return Promise.resolve();
}

/* the source card grows into its sheet. fromRect is {x,y,w,h} in the same offset space as el. */
export function containerTransform(el, fromRect) {
  if (!el) return Promise.resolve();
  reset(el); [...el.children].forEach(reset);
  const prevOrigin = el.style.transformOrigin;
  const to = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth || 1, h: el.offsetHeight || 1 };
  el.style.transformOrigin = "0 0";
  [...el.children].forEach((c) => play(c, [{ opacity: 0 }, { opacity: 1 }], 200, "linear", { delay: 180 }));
  return play(el, [
    { transform: `translate(${fromRect.x - to.x}px, ${fromRect.y - to.y}px) scale(${fromRect.w / to.w}, ${fromRect.h / to.h})`, borderRadius: "12px" },
    { transform: "none" },
  ], 450, EASE.emphasized).then(() => { el.style.transformOrigin = prevOrigin; });
}

/* shared axis (x): dir is 1 going forward, -1 going back */
export const sharedAxisOut = (el, dir) =>
  play(el, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 30}px)` }], 90, EASE.accelerate, { fill: "forwards" });
export const sharedAxisIn = (el, dir) =>
  (reset(el), play(el, [{ opacity: 0, transform: `translateX(${dir * 30}px)` }, { opacity: 1, transform: "none" }], 300, EASE.decelerate));

/* fade through: oldEl fades out (it stays faded; the caller removes or hides it), newEl fades in from .96 */
export async function fadeThrough(oldEl, newEl) {
  await play(oldEl, [{ opacity: 1 }, { opacity: 0 }], 90, EASE.accelerate, { fill: "forwards" });
  reset(newEl);
  await play(newEl, [{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }], 210, EASE.decelerate);
}

/* ---- snackbar: one at a time per page ---- */
let currentSnack = null;

/* ms == null means the default: 4000 without an action, 6000 with one. 0 stays until closed. */
export const snackbarMs = (ms, action) => (ms == null ? (action ? 6000 : 4000) : ms);

export function showSnackbar(host, { text, action, onAction, ms } = {}) {
  ms = snackbarMs(ms, action);
  if (currentSnack) currentSnack.drop();
  const el = document.createElement("div");
  el.className = "m3-snackbar";
  el.setAttribute("role", "status");
  const label = document.createElement("span");
  label.className = "m3-snackbar__text";
  label.textContent = String(text == null ? "" : text);
  el.appendChild(label);
  let timer = null, alive = true;

  const remove = () => { alive = false; clearTimeout(timer); el.remove(); if (currentSnack === me) currentSnack = null; };
  const me = {
    drop: remove,
    async hide() {
      if (!alive) return;
      alive = false; clearTimeout(timer);
      await play(el, [{ opacity: 1 }, { opacity: 0 }], 150, "linear", { fill: "forwards" });
      el.remove(); if (currentSnack === me) currentSnack = null;
    },
  };

  if (action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "m3-btn m3-btn--text"; b.textContent = String(action);
    b.addEventListener("click", () => { try { if (typeof onAction === "function") onAction(); } finally { me.hide(); } });
    el.appendChild(b);
  }
  if (ms === 0) {
    const x = document.createElement("button");
    x.type = "button"; x.className = "m3-icon-btn"; x.setAttribute("aria-label", "Dismiss");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "24"); svg.setAttribute("height", "24"); svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", "M6 6l12 12M18 6L6 18"); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2"); p.setAttribute("stroke-linecap", "round");
    svg.appendChild(p); x.appendChild(svg);
    x.addEventListener("click", () => { me.hide(); });
    el.appendChild(x);
  }
  host.appendChild(el);
  currentSnack = me;
  play(el, [{ opacity: 0, transform: "translateY(24px)" }, { opacity: 1, transform: "none" }], 300, EASE.decelerate);
  if (ms !== 0) timer = setTimeout(() => { me.hide(); }, ms);
  return { hide: () => me.hide() };
}

/* ---- pull to refresh ---- */
/* 72px is measured on the resisted pull (finger distance x 0.5), so the finger travels about 144px */
const THRESHOLD = 72, MAX_PULL = 110, CIRC = 56.5;
/* an onRefresh that never settles must not leave the indicator busy forever */
const REFRESH_TIMEOUT = 15000;

export function attachPullToRefresh(scroller, onRefresh) {
  let y0 = null, pulled = 0, el = null, busy = false, justPulled = false;

  const makeIndicator = () => {
    const d = document.createElement("div");
    d.className = "m3-pull-indicator"; d.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    for (const [k, v] of [["cx", "12"], ["cy", "12"], ["r", "9"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2.5"], ["stroke-linecap", "round"], ["stroke-dasharray", String(CIRC)], ["stroke-dashoffset", String(CIRC)]]) c.setAttribute(k, v);
    svg.appendChild(c); d.appendChild(svg);
    (scroller.parentElement || scroller).appendChild(d);
    d.style.top = scroller.offsetTop + "px";
    return d;
  };
  const start = (y) => { if (busy || scroller.scrollTop > 0) return; y0 = y; pulled = 0; };
  const move = (y, ev) => {
    if (y0 == null) return;
    const dy = y - y0;
    if (dy <= 4) { if (el) { el.remove(); el = null; } return; }
    if (ev && ev.cancelable) ev.preventDefault();
    pulled = Math.min(dy * 0.5, MAX_PULL);
    if (!el) el = makeIndicator();
    const p = Math.min(pulled / THRESHOLD, 1);
    el.style.transform = `translateY(${pulled - 40}px) rotate(${p * 270}deg)`;
    el.style.opacity = String(Math.min(1, p * 1.6));
    el.querySelector("circle").style.strokeDashoffset = String(CIRC * (1 - p * 0.8));
  };
  const abort = () => { y0 = null; if (el) { el.remove(); el = null; } };
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    if (!el) return;
    justPulled = true; setTimeout(() => { justPulled = false; }, 60);
    const e2 = el; el = null;
    if (pulled >= THRESHOLD) {
      busy = true;
      e2.classList.add("is-spinning"); e2.style.transform = "translateY(24px)";
      const timeout = new Promise((r) => setTimeout(r, REFRESH_TIMEOUT));
      Promise.race([Promise.resolve().then(onRefresh).catch(() => {}), timeout]).then(async () => {
        await play(e2, [{ opacity: 1, transform: "translateY(24px) scale(1)" }, { opacity: 0, transform: "translateY(24px) scale(.4)" }], 200, EASE.accelerate, { fill: "forwards" });
        e2.remove(); busy = false;
      });
    } else {
      play(e2, [{ opacity: Number(e2.style.opacity) || 0 }, { opacity: 0 }], 150, "linear", { fill: "forwards" }).then(() => e2.remove());
    }
  };

  const onTS = (e) => start(e.touches[0].clientY);
  const onTM = (e) => move(e.touches[0].clientY, e);
  const onPD = (e) => {
    if (e.pointerType !== "mouse") return;
    start(e.clientY);
    if (y0 != null) { try { scroller.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ } }
  };
  const onPM = (e) => { if (e.pointerType === "mouse") move(e.clientY, e); };
  const onPU = (e) => { if (e.pointerType === "mouse") end(); };
  const onPC = (e) => { if (e.pointerType === "mouse") abort(); };
  const onClick = (e) => { if (justPulled) { justPulled = false; e.stopImmediatePropagation(); e.preventDefault(); } };
  scroller.addEventListener("touchstart", onTS, { passive: true });
  scroller.addEventListener("touchmove", onTM, { passive: false });
  scroller.addEventListener("touchend", end);
  scroller.addEventListener("pointerdown", onPD);
  scroller.addEventListener("pointermove", onPM);
  scroller.addEventListener("touchcancel", abort);
  scroller.addEventListener("pointercancel", onPC);
  window.addEventListener("pointerup", onPU);
  window.addEventListener("pointercancel", onPC);
  scroller.addEventListener("click", onClick, true);

  return () => {
    scroller.removeEventListener("touchstart", onTS);
    scroller.removeEventListener("touchmove", onTM);
    scroller.removeEventListener("touchend", end);
    scroller.removeEventListener("pointerdown", onPD);
    scroller.removeEventListener("pointermove", onPM);
    scroller.removeEventListener("touchcancel", abort);
    scroller.removeEventListener("pointercancel", onPC);
    window.removeEventListener("pointerup", onPU);
    window.removeEventListener("pointercancel", onPC);
    scroller.removeEventListener("click", onClick, true);
    if (el) { el.remove(); el = null; }
  };
}

/* ---- data colour keys ---- */
const KEYS = new Set(["food", "nights", "culture", "outdoors", "travel", "life", "other", "keisy", "mercadona", "condis", "carrefour", "alcampo", "ametller"]);

/* Inline style for a data colour. Only a known key is ever emitted, anything else becomes "other". */
export function kaveKey(key) {
  const k = typeof key === "string" && KEYS.has(key) ? key : "other";
  return `--kave-k:var(--kave-data-${k});--kave-kc:var(--kave-data-${k}-container);--kave-onkc:var(--kave-data-on-${k}-container)`;
}
