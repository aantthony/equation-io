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

export function initPanelResize(panel: HTMLElement, handle: HTMLElement): void {
  const clampWidth = (w: number) =>
    Math.round(Math.min(Math.max(w, MIN_WIDTH), document.documentElement.clientWidth - 2 * MARGIN));

  // Restore the remembered width, re-clamped: the screen may have shrunk
  // since it was saved.
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    if (w >= MIN_WIDTH) panel.style.width = `${clampWidth(w)}px`;
  } catch {}

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
    panel.style.width = `${clampWidth(drag.w0 + dw)}px`;
  });

  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    try {
      localStorage.setItem(WIDTH_KEY, String(parseFloat(panel.style.width)));
    } catch {} // private mode: the width just won't stick across visits
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  handle.addEventListener('dblclick', () => {
    panel.style.width = '';
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {}
  });

  // Keep panel-swipe.ts from treating a resize touch as a panel drag.
  handle.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
}
