/* Swipe down anywhere on a bottom sheet to close it (Isa, 04/11/2026), as the
   Calendar's strip closes with a swipe up anywhere. The same file sits in
   Ladle and Compass: change both.

   The handle keeps its own drag (touch-action none). Everywhere else in the
   sheet the gesture is claimed only when it is clearly a pull down: the
   finger moves down more than SLOP px, more down than sideways, and nothing
   between the finger and the sheet is scrolled away from its top. Anything
   else stays an ordinary scroll, a sideways swipe (Compass's day steps), a
   tap, or typing: the gesture never starts on a form field or a slider.

   Once claimed, the move is the caller's (follow the finger, fade the scrim),
   and so is the end: past the caller's threshold it closes, else it springs
   back. The click that a claimed swipe would end in is eaten. */
"use strict";

const SLOP = 8;
const NO_START = "input, textarea, select, [contenteditable], [data-grip], .m3-drag-handle, [data-no-swipe]";

/* every scroller between the target and the sheet is at its top */
function atTop(target, sheet) {
  for (let n = target; n && n !== sheet.parentNode; n = n.parentElement) {
    if (n.scrollTop > 0) return false;
  }
  return true;
}

function eatClick() {
  const eat = (e) => { e.stopPropagation(); e.preventDefault(); };
  document.addEventListener("click", eat, { capture: true, once: true });
  setTimeout(() => document.removeEventListener("click", eat, { capture: true }), 400);
}

/* sheet: the sheet element. canDrag(): whether it is a draggable bottom sheet
   right now. begin(): the drag starts. move(dy): dy >= 0, px below rest.
   end(dy, cancelled): the finger let go (or the gesture was taken away). */
export function swipeToClose(sheet, { canDrag, begin, move, end }) {
  let s = null; // { x, y, on, id }

  const start = (x, y, target, id) => {
    s = null;
    if (!canDrag() || !target || target.closest(NO_START) || !atTop(target, sheet)) return;
    s = { x, y, on: false, id, target };
  };
  /* true when the gesture is (now) ours */
  const step = (x, y) => {
    if (!s) return false;
    const dx = x - s.x, dy = y - s.y;
    if (!s.on) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return false;
      if (dy <= 0 || Math.abs(dx) * 1.2 > dy || !atTop(s.target, sheet)) { s = null; return false; }
      s.on = true; s.y = y; begin();
    }
    move(Math.max(0, y - s.y));
    return true;
  };
  const stop = (y, cancelled) => {
    if (!s) return;
    const was = s; s = null;
    if (!was.on) return;
    if (!cancelled) eatClick();
    end(Math.max(0, y - was.y), cancelled);
  };

  /* touch: a non-passive move, so a claimed pull stops the content scrolling */
  sheet.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { s = null; return; }
    const t = e.touches[0]; start(t.clientX, t.clientY, e.target, "touch");
  }, { passive: true });
  sheet.addEventListener("touchmove", (e) => {
    if (!s || s.id !== "touch") return;
    if (e.touches.length !== 1) { stop(0, true); return; }
    const t = e.touches[0];
    if (step(t.clientX, t.clientY) && e.cancelable) e.preventDefault();
  }, { passive: false });
  sheet.addEventListener("touchend", (e) => {
    if (!s || s.id !== "touch") return;
    const t = e.changedTouches[0]; stop(t ? t.clientY : 0, false);
  }, { passive: true });
  sheet.addEventListener("touchcancel", () => { if (s && s.id === "touch") stop(0, true); }, { passive: true });

  /* a mouse (or pen): the same rule with pointer events, listened to on the
     document only while a press is down, so nothing piles up per sheet */
  const pm = (e) => { if (s && s.id === e.pointerId && step(e.clientX, e.clientY)) e.preventDefault(); };
  const off = () => {
    document.removeEventListener("pointermove", pm);
    document.removeEventListener("pointerup", pu);
    document.removeEventListener("pointercancel", pc);
  };
  const pu = (e) => { off(); if (s && s.id === e.pointerId) stop(e.clientY, false); };
  const pc = (e) => { off(); if (s && s.id === e.pointerId) stop(0, true); };
  sheet.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    start(e.clientX, e.clientY, e.target, e.pointerId);
    if (!s) return;
    document.addEventListener("pointermove", pm);
    document.addEventListener("pointerup", pu);
    document.addEventListener("pointercancel", pc);
  });
}
