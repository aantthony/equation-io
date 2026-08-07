/**
 * Swipe-to-dismiss for the equations panel — the mobile way to get the panel
 * off the graph.
 *
 * The gesture follows Apple's touch grammar: from the first move the panel is
 * pinned to the finger (drag it up, left, or diagonally — both exits work),
 * directions that cannot dismiss give with a rubber band, and release
 * projects the remaining momentum: carried or flicked past halfway the panel
 * flies off along the throw line, otherwise it springs back home. Every
 * animation is a spring seeded with the release velocity, so motion is
 * continuous through the release — and interruptible: a new touch picks the
 * panel up wherever the animation currently holds it. Once dismissed, a
 * `y=` chip appears in the panel's corner; tapping it springs the panel
 * back, and dragging it pulls the panel back in under the finger.
 *
 * Touch-only by design. On a phone the panel covers most of the graph and
 * earns its dismissal; with a mouse it never needs to move — and a mouse
 * drag over text means selection, not throwing furniture. All physics and
 * decision math is lib/fling.ts, under test; this module owns the events,
 * the scroll-vs-swipe arbitration, and the styles.
 */

import {
  type Sample,
  type Spring,
  type Vec2,
  claimGesture,
  exitDistances,
  exitTarget,
  makeSpring,
  releaseVelocity,
  rubberband,
  shouldDismiss,
  shouldOpen,
  stepSpring,
} from '../lib/fling.ts';

/** Extra travel past the screen edge so the drop shadow fully clears too. */
const EXIT_PAD = 28;
/** Movement before a touch commits to being a drag at all (px). */
const SLOP = 9;

export function initPanelSwipe(panel: HTMLElement, chip: HTMLElement): void {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  /** The panel's translation from its at-rest place; (0,0) is home. */
  const offset: Vec2 = { x: 0, y: 0 };
  let hidden = false;
  /** Unit direction the panel last left in; reopening retraces it. */
  let exitDir: Vec2 = { x: 0, y: -1 };
  /** Exit travel per axis, for the outbound fade; refreshed per gesture. */
  let dists: Vec2 = { x: 1, y: 1 };

  // --- geometry ---

  /** The panel's at-rest viewport box (its live rect minus our transform). */
  const baseBox = () => {
    const r = panel.getBoundingClientRect();
    return { left: r.left - offset.x, top: r.top - offset.y, width: r.width, height: r.height };
  };

  /** Where a hidden panel parks: just fully off-screen along exitDir.
   *  Recomputed from live geometry, so rotations while hidden can't strand
   *  the panel half-visible when it returns. */
  const parkedOffset = (): Vec2 =>
    exitTarget({ x: 0, y: 0 }, { x: exitDir.x * 1e4, y: exitDir.y * 1e4 }, exitDistances(baseBox(), EXIT_PAD));

  // --- painting ---

  function paint() {
    const out = Math.min(1, Math.max(-offset.x / dists.x, -offset.y / dists.y, 0));
    panel.style.transform = offset.x || offset.y ? `translate3d(${offset.x}px, ${offset.y}px, 0)` : '';
    // A light fade on the way out reads as speed; squared so the drag range
    // barely dims and the flight does the fading.
    panel.style.opacity = out ? String(1 - 0.5 * out * out) : '';
  }

  function showChip() {
    chip.hidden = false;
    void chip.offsetWidth; // commit the hidden pose, so .shown transitions from it
    chip.classList.add('shown');
  }

  function hideChip() {
    chip.classList.remove('shown');
    chip.hidden = true;
  }

  // --- the spring loop ---
  //
  // One rAF loop integrating an x and a y spring toward home or the exit
  // point. State lives in module scope rather than in an animation object so
  // a touch can stop the loop and adopt `offset` mid-flight — catching the
  // panel is just "the finger is the integrator now".

  let sx: Spring | null = null;
  let sy: Spring | null = null;
  let raf = 0;
  let lastT = 0;
  let restDist = 0.5;
  let restSpeed = 20;
  let onRest: (() => void) | null = null;

  function animateTo(
    target: Vec2,
    v: Vec2,
    response: number,
    damping: number,
    done: (() => void) | null,
    rest: [number, number] = [0.5, 20],
  ) {
    sx = makeSpring(offset.x, v.x, target.x, response, damping);
    sy = makeSpring(offset.y, v.y, target.y, response, damping);
    [restDist, restSpeed] = rest;
    onRest = done;
    if (!raf) {
      lastT = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }

  function tick(t: number) {
    raf = 0;
    const dt = (t - lastT) / 1000;
    lastT = t;
    if (!sx || !sy) return;
    const moveX = stepSpring(sx, dt, restDist, restSpeed);
    const moveY = stepSpring(sy, dt, restDist, restSpeed);
    offset.x = sx.x;
    offset.y = sy.x;
    paint();
    if (moveX || moveY) {
      raf = requestAnimationFrame(tick);
    } else {
      sx = sy = null;
      const cb = onRest;
      onRest = null;
      cb?.();
    }
  }

  function stopAnim() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    sx = sy = null;
    onRest = null;
  }

  /** Back at rest and untouched: drop the compositing hints. */
  function idle() {
    if (!offset.x && !offset.y && !raf && !gesture) panel.style.willChange = '';
  }

  // --- transitions ---

  function finishDismiss() {
    hidden = true;
    panel.style.visibility = 'hidden';
    panel.style.willChange = '';
    showChip();
  }

  function dismiss(v: Vec2) {
    // Drop the keyboard with the panel; the graph is what's being revealed.
    if (panel.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    const d = exitDistances(baseBox(), EXIT_PAD);
    dists = d;
    const target = exitTarget(offset, v, d);
    const len = Math.hypot(target.x, target.y) || 1;
    exitDir = { x: target.x / len, y: target.y / len };
    if (reduceMotion.matches) {
      offset.x = target.x;
      offset.y = target.y;
      paint();
      finishDismiss();
      return;
    }
    // Critically damped and quick: a thrown thing leaves fast, and any
    // overshoot would land off-screen where nobody could see it anyway.
    // Loose rest tolerances for the same reason.
    animateTo(target, v, 0.32, 1, finishDismiss, [6, 60]);
  }

  function settle(v: Vec2) {
    if (reduceMotion.matches) {
      offset.x = 0;
      offset.y = 0;
      paint();
      idle();
      return;
    }
    // Slightly underdamped: the panel arrives with one soft bounce.
    animateTo({ x: 0, y: 0 }, v, 0.4, 0.78, idle);
  }

  function present() {
    if (!hidden) return;
    hideChip();
    hidden = false;
    panel.style.visibility = '';
    const from = parkedOffset();
    offset.x = from.x;
    offset.y = from.y;
    dists = exitDistances(baseBox(), EXIT_PAD);
    if (reduceMotion.matches) {
      offset.x = 0;
      offset.y = 0;
      paint();
      return;
    }
    panel.style.willChange = 'transform, opacity';
    paint();
    animateTo({ x: 0, y: 0 }, { x: 0, y: 0 }, 0.42, 0.8, idle);
  }

  // --- touch handling ---

  interface Gesture {
    id: number;
    /** Touch start, client coords. */
    x0: number;
    y0: number;
    /** Where the panel was when the touch began (pull space, unrubbered). */
    base: Vec2;
    claimed: boolean;
    /** Ceded to a scrollable: ignore this touch for the rest of its life. */
    dead: boolean;
    /** Dragging the panel back in from the chip. */
    pull: boolean;
    scroll: { up: boolean; down: boolean } | null;
    samples: Sample[];
  }

  let gesture: Gesture | null = null;

  /**
   * The scrollable under the touch (the equation list or the examples tree)
   * and which ways it can currently move — the input claimGesture arbitrates
   * on. First match wins: they don't nest, and overscroll-behavior keeps a
   * scroll that hits its end from chaining anywhere.
   */
  function scrollableAt(el: Element | null): { up: boolean; down: boolean } | null {
    for (let n = el; n && n !== panel.parentElement; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 1) {
        const oy = getComputedStyle(n).overflowY;
        if (oy === 'auto' || oy === 'scroll') {
          return { up: n.scrollTop > 0, down: n.scrollTop + n.clientHeight < n.scrollHeight - 1 };
        }
      }
    }
    return null;
  }

  /** Free toward dismissal, rubber away from it. */
  const shape = (pull: number) => (pull <= 0 ? pull : rubberband(pull));
  /** Pull-open space: clamped at the parked spot, rubbering past home. */
  const shapePull = (raw: number, parked: number) =>
    raw > 0 ? rubberband(raw) : Math.max(raw, parked);

  const trackedTouch = (e: TouchEvent) => {
    const g = gesture;
    if (!g) return null;
    for (const t of e.changedTouches) if (t.identifier === g.id) return t;
    return null;
  };

  panel.addEventListener(
    'touchstart',
    e => {
      if (hidden || gesture || e.touches.length > 1) return;
      const t = e.changedTouches[0];
      // Range sliders and bound inputs own their drags outright. Buttons,
      // links and the editor text stay grabbable: a tap on them never crosses
      // the slop, and once a swipe claims the touch no click follows.
      if (t.target instanceof Element && t.target.closest('input, select, textarea')) return;
      const flying = raf !== 0;
      if (flying) stopAnim();
      gesture = {
        id: t.identifier,
        x0: t.clientX,
        y0: t.clientY,
        base: { x: offset.x, y: offset.y },
        claimed: flying, // a caught panel is already in hand
        dead: false,
        pull: false,
        scroll: t.target instanceof Element ? scrollableAt(t.target) : null,
        samples: [{ t: e.timeStamp, x: t.clientX, y: t.clientY }],
      };
      dists = exitDistances(baseBox(), EXIT_PAD);
      panel.style.willChange = 'transform, opacity';
    },
    { passive: true },
  );

  panel.addEventListener(
    'touchmove',
    e => {
      const g = gesture;
      if (!g || g.pull || g.dead) return;
      const t = trackedTouch(e);
      if (!t) return;
      g.samples.push({ t: e.timeStamp, x: t.clientX, y: t.clientY });
      if (g.samples.length > 32) g.samples.shift();
      const dx = t.clientX - g.x0;
      const dy = t.clientY - g.y0;
      if (!g.claimed) {
        const claim = claimGesture(dx, dy, g.scroll, SLOP);
        if (claim === 'undecided') return;
        if (claim === 'scroll') {
          g.dead = true;
          return;
        }
        g.claimed = true;
        // The touch is a panel drag now: drop the soft keyboard so the graph
        // it reveals is visible, not the keyboard's letterbox.
        if (panel.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      }
      if (e.cancelable) e.preventDefault(); // ours: no scroll, no selection
      offset.x = shape(g.base.x + dx);
      offset.y = shape(g.base.y + dy);
      paint();
    },
    { passive: false },
  );

  const endPanelTouch = (e: TouchEvent) => {
    const g = gesture;
    if (!g || g.pull) return;
    if (!trackedTouch(e)) return;
    gesture = null;
    if (!g.claimed || g.dead) {
      idle();
      return;
    }
    if (e.type === 'touchcancel') {
      settle({ x: 0, y: 0 });
      return;
    }
    const v = releaseVelocity(g.samples, e.timeStamp);
    if (shouldDismiss(offset, v, baseBox())) dismiss(v);
    else settle(v);
  };
  panel.addEventListener('touchend', endPanelTouch);
  panel.addEventListener('touchcancel', endPanelTouch);

  // --- the chip: tap to bring the panel back, or drag it back in ---

  chip.addEventListener('click', () => {
    if (gesture?.pull) return;
    present();
  });

  chip.addEventListener(
    'touchstart',
    e => {
      if (!hidden || gesture || e.touches.length > 1) return;
      const t = e.changedTouches[0];
      gesture = {
        id: t.identifier,
        x0: t.clientX,
        y0: t.clientY,
        base: { x: 0, y: 0 },
        claimed: false,
        dead: false,
        pull: true,
        scroll: null,
        samples: [{ t: e.timeStamp, x: t.clientX, y: t.clientY }],
      };
    },
    { passive: true },
  );

  chip.addEventListener(
    'touchmove',
    e => {
      const g = gesture;
      if (!g?.pull) return;
      const t = trackedTouch(e);
      if (!t) return;
      g.samples.push({ t: e.timeStamp, x: t.clientX, y: t.clientY });
      if (g.samples.length > 32) g.samples.shift();
      const dx = t.clientX - g.x0;
      const dy = t.clientY - g.y0;
      if (!g.claimed) {
        if (dx * dx + dy * dy < SLOP * SLOP) return;
        // The drag becomes the panel: park it under the finger and pull.
        g.claimed = true;
        g.base = parkedOffset();
        hidden = false;
        panel.style.visibility = '';
        hideChip();
        dists = exitDistances(baseBox(), EXIT_PAD);
        panel.style.willChange = 'transform, opacity';
      }
      if (e.cancelable) e.preventDefault();
      offset.x = shapePull(g.base.x + dx, g.base.x);
      offset.y = shapePull(g.base.y + dy, g.base.y);
      paint();
    },
    { passive: false },
  );

  const endChipTouch = (e: TouchEvent) => {
    const g = gesture;
    if (!g?.pull) return;
    if (!trackedTouch(e)) return;
    gesture = null;
    if (!g.claimed) return; // a tap: the click that follows presents
    const v = releaseVelocity(g.samples, e.timeStamp);
    const open = e.type !== 'touchcancel' && shouldOpen(offset, v, g.base);
    if (reduceMotion.matches) {
      if (open) {
        offset.x = 0;
        offset.y = 0;
        paint();
        panel.style.willChange = '';
      } else {
        offset.x = g.base.x;
        offset.y = g.base.y;
        paint();
        finishDismiss();
      }
      return;
    }
    if (open) animateTo({ x: 0, y: 0 }, v, 0.42, 0.8, idle);
    // Not pulled far enough: park it again and bring the chip back.
    else animateTo(g.base, v, 0.36, 1, finishDismiss, [6, 60]);
  };
  chip.addEventListener('touchend', endChipTouch);
  chip.addEventListener('touchcancel', endChipTouch);
}
