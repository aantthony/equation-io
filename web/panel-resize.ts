/**
 * Drag-to-resize for the equations panel.
 *
 * A grab strip along the panel's outer vertical edge — the edge facing away
 * from the pinned corner, so the anchored edge stays put — drags the panel
 * wider or narrower. The chosen width persists across visits; double-click
 * snaps back to the stylesheet default. Width is clamped so the panel always
 * fits on screen, and a CSS max-width re-clamps a remembered width on a
 * screen narrower than the last visit.
 *
 * The strip is also an ARIA window splitter (role="separator", focusable):
 * arrow keys resize — the arrow moves the edge in that screen direction, so
 * the panel's pin side decides whether that widens or narrows — Home/End
 * jump to the min/max width, and Enter resets to the default. The
 * aria-value* attributes track the current/min/max width in pixels.
 *
 * Touch drags on the strip are resizes, never panel throws: the strip stops
 * its touchstart from reaching panel-swipe.ts, and its touch-action: none
 * keeps the browser from panning so pointermoves keep arriving.
 */

/** The panel width the user last chose, kept across visits. */
const WIDTH_KEY = 'eq-panel-width';
/** Narrow enough for small screens, wide enough that a row stays usable. */
const MIN_WIDTH = 220;
/** Screen margin on each side while resizing (matches the panel's CSS). */
const MARGIN = 12;
/** Arrow-key resize step (px). */
const KEY_STEP = 16;

export function initPanelResize(panel: HTMLElement, handle: HTMLElement): void {
  const maxWidth = () => document.documentElement.clientWidth - 2 * MARGIN;
  const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, MIN_WIDTH), maxWidth()));

  const syncAria = () => {
    handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
    handle.setAttribute('aria-valuemax', String(Math.round(maxWidth())));
    handle.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().width)));
  };

  const save = () => {
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(panel.getBoundingClientRect().width)));
    } catch {} // private mode: the width just won't stick across visits
  };

  const setWidth = (w: number) => {
    panel.style.width = `${clampWidth(w)}px`;
    syncAria();
  };

  /** Back to the stylesheet default, forgetting the stored width. */
  const reset = () => {
    panel.style.width = '';
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {}
    syncAria();
  };

  // Restore the remembered width, re-clamped: the screen may have shrunk
  // since it was saved.
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    if (w >= MIN_WIDTH) setWidth(w);
  } catch {}
  syncAria();

  let drag: { id: number; x0: number; w0: number } | null = null;

  handle.addEventListener('pointerdown', e => {
    if (drag || e.button !== 0) return;
    e.preventDefault(); // a drag, not a text-selection start
    drag = { id: e.pointerId, x0: e.clientX, w0: panel.getBoundingClientRect().width };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {} // synthetic events have no active pointer to capture
  });

  handle.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    // The pinned edge stays anchored, so the outer edge follows the pointer:
    // pinned left, dragging right widens; pinned right, mirrored.
    const dx = e.clientX - drag.x0;
    const dw = panel.classList.contains('pin-right') ? -dx : dx;
    setWidth(drag.w0 + dw);
  });

  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    save();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  handle.addEventListener('dblclick', reset);

  handle.addEventListener('keydown', e => {
    // Arrows move the edge in that screen direction: away from the pinned
    // side widens (same mapping the pointer drag uses).
    const edgeStep = e.key === 'ArrowRight' ? KEY_STEP : e.key === 'ArrowLeft' ? -KEY_STEP : 0;
    if (edgeStep) {
      const dw = panel.classList.contains('pin-right') ? -edgeStep : edgeStep;
      setWidth(panel.getBoundingClientRect().width + dw);
      save();
    } else if (e.key === 'Home') {
      setWidth(MIN_WIDTH);
      save();
    } else if (e.key === 'End') {
      setWidth(maxWidth());
      save();
    } else if (e.key === 'Enter') {
      reset();
    } else {
      return;
    }
    e.preventDefault();
  });

  // The max (and the clamped current width) move with the viewport.
  window.addEventListener('resize', syncAria);

  // Keep panel-swipe.ts from treating a resize touch as a panel drag.
  handle.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
}
