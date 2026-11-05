/* Kave Ladle: the top bar's scroll behaviour, Material 3 "enter always".

   The bar is not a timed slide: it moves with the page, pixel for pixel.
   Scrolling down pushes it up and away; scrolling up, anywhere on the page,
   brings it back the same way. When the scroll stops with the bar part way,
   it settles, in the direction the reader was going (all the way out after a
   downward scroll, all the way in after an upward one).

   Only scrolling the reader drives moves it: a finger on the page, the fling
   it starts (in the same direction) and a mouse wheel. A scroll the app makes
   itself (markJump in util.js: a tab switch, a jump to a chart) never does.

   One behaviour, two bars: the app's own (#topBar, the window scrolls) and
   the bar of a full-screen page (Settings, Roadmap, over #pageBody), which
   scrolled with its page before (Isa, 05/11/2026). The app's bar is sticky
   and keeps its place in the flow (styles.css), so moving it is a transform
   and never shifts the page. Compass has the same module for its own
   scrollers; the behaviour is the household's, kept identical. */
"use strict";

import { EASE, motionFactor } from "../m3/kave-m3.js";

const jumping = () => !!document.documentElement.dataset.jump;

/* the kit gives easings as CSS cubic-bezier strings; this solves one for x */
function cubic(css) {
  const m = /cubic-bezier\(([^)]+)\)/.exec(css || "");
  const [x1, y1, x2, y2] = m ? m[1].split(",").map(Number) : [0.2, 0, 0, 1];
  const at = (a, b, t) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  return (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = at(x1, x2, t) - x, d = (at(x1, x2, t + 1e-4) - at(x1, x2, t - 1e-4)) / 2e-4;
      if (!d) break;
      t = Math.min(1, Math.max(0, t - err / d));
    }
    return at(y1, y2, t);
  };
}

/* One enter-always bar. `target` is what carries the listeners (window or an
   element), `scrollY()` reads its scroll position. */
function createBar(bar, target, scrollY) {
  let H = 64;              // the bar's height, its safe-area padding included
  let o = 0;               // its offset: 0 shown, -H gone
  let lastY = scrollY(), dir = 0;  // dir: +1 down, -1 up, the reader's last direction
  let touching = false, lifted = false, wheelAt = 0, endTimer = 0, settleId = 0;

  function apply() {
    bar.style.transform = o ? `translateY(${o}px)` : "";
    bar.classList.toggle("is-hidden", o <= -H);
  }
  function setO(v) {
    const n = Math.max(-H, Math.min(0, v));
    if (n === o) return;
    o = n;
    apply();
  }
  /* where a bar left part way settles: the reader's direction, else the nearer end */
  function rest() {
    if (o >= 0 || o <= -H) return o >= 0 ? 0 : -H;
    return dir > 0 ? -H : dir < 0 ? 0 : (o < -H / 2 ? -H : 0);
  }
  function stopSettle() { if (settleId) { cancelAnimationFrame(settleId); settleId = 0; } }
  /* animate the bar to an end: 250ms emphasized, as the kit's own motion */
  function settleTo(to) {
    stopSettle();
    if (o === to) return;
    const f = motionFactor();
    if (!f) { setO(to); return; }
    const from = o, t0 = performance.now(), ms = 250 * f, ease = cubic(EASE.emphasized);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      setO(from + (to - from) * ease(p));
      settleId = p < 1 ? requestAnimationFrame(step) : 0;
    };
    settleId = requestAnimationFrame(step);
  }
  /* the scroll came to rest: a bar left part way settles */
  function scrollEnded() {
    clearTimeout(endTimer);
    lifted = false;
    if (!touching) settleTo(rest());
  }
  function onScroll() {
    const y = scrollY(), dy = y - lastY;
    lastY = y;
    if (!dy) return;
    clearTimeout(endTimer);
    endTimer = setTimeout(scrollEnded, 160); /* no scrollend event: a quiet 160ms is the end */
    if (jumping()) return;
    const s = Math.sign(dy);
    if (touching) dir = s;
    else if (!(performance.now() - wheelAt < 300 || (lifted && s === dir))) return;
    else if (!lifted) dir = s;
    stopSettle();
    setO(y <= 0 ? 0 : o - dy);
  }
  target.addEventListener("touchstart", () => { touching = true; lifted = false; stopSettle(); }, { passive: true });
  const lift = () => {
    if (!touching) return;
    touching = false;
    lifted = true;
    /* a lift with nothing still moving settles now; a fling settles at its end */
    clearTimeout(endTimer);
    endTimer = setTimeout(scrollEnded, 160);
  };
  target.addEventListener("touchend", lift, { passive: true });
  target.addEventListener("touchcancel", lift, { passive: true });
  target.addEventListener("wheel", () => { wheelAt = performance.now(); }, { passive: true });
  target.addEventListener("scroll", onScroll, { passive: true });
  target.addEventListener("scrollend", scrollEnded);

  const api = {
    show(now) { dir = -1; if (now) { stopSettle(); setO(0); } else settleTo(0); },
    measure() {
      const h = bar.offsetHeight;
      if (h && h !== H) { const gone = o <= -H; H = h; o = gone ? -H : Math.max(-H, o); apply(); }
    },
    /* a new page: shown, and the scroll it remembers is the one it has now */
    reset() { stopSettle(); lastY = scrollY(); dir = 0; setO(0); },
  };
  api.measure();
  return api;
}

let main = null, page = null;

/* The bar comes all the way back (a tab switch lands at the top with it
   showing). `now` skips the animation. */
export function showTopBar(now) { if (main) main.show(now); }

export function measureBar() { if (main) main.measure(); if (page) page.measure(); }

export function initTopBar() {
  const bar = document.getElementById("topBar");
  if (!bar) return;
  main = createBar(bar, window, () => window.scrollY);
  window.addEventListener("resize", measureBar);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureBar);
  const host = document.getElementById("page"), body = document.getElementById("pageBody");
  const pbar = host && host.querySelector(".m3-top-bar");
  if (pbar && body) page = createBar(pbar, body, () => body.scrollTop);
}

/* A page was drawn (opened, or another one stacked on top): its bar shows. */
export function resetPageBar() {
  if (!page) return;
  page.measure();
  page.reset();
  const bar = document.querySelector("#page > .m3-top-bar");
  if (bar && bar.offsetHeight) document.documentElement.style.setProperty("--page-bar-h", bar.offsetHeight + "px");
}
