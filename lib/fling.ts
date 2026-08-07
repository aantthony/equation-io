/**
 * Touch-dismissal physics: the math behind flicking a panel off-screen the
 * way iOS moves its sheets and banners. Pure and DOM-free — web/panel-swipe.ts
 * owns the touch events and styles — so the tuning that makes the gesture
 * feel right lives under test.
 *
 * The feel comes from four rules borrowed from UIKit:
 *  - while touched, the panel is pinned to the finger — no easing, no lag;
 *  - directions that cannot dismiss resist with a diminishing-returns rubber
 *    band instead of a hard stop;
 *  - release decides by *projected momentum* (where the panel would coast to,
 *    not where it is), so a slow drag past halfway and a short sharp flick
 *    both dismiss;
 *  - the hand-off from finger to animation is a spring seeded with the
 *    release velocity, so motion stays continuous through the release.
 *
 * Units are px and seconds throughout (sample times in ms, as events give).
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** A touch position at a moment, straight from a touchmove. */
export interface Sample {
  /** Event timeStamp, ms. */
  t: number;
  x: number;
  y: number;
}

/**
 * Diminishing-returns pull for directions that cannot dismiss, UIScrollView's
 * overscroll curve: starts at slope `c` and approaches `limit` asymptotically,
 * so the panel visibly gives but can never be dragged far the wrong way.
 * Negative input (a direction that is free, not resisted) passes through 0.
 */
export function rubberband(d: number, limit = 90, c = 0.55): number {
  if (d <= 0) return 0;
  return (1 - 1 / ((c * d) / limit + 1)) * limit;
}

/** Samples older than this before the release no longer describe the throw. */
const V_WINDOW_MS = 100;
/** A finger that rested this long before lifting released at velocity zero. */
const V_STALL_MS = 80;

/**
 * Release velocity (px/s) over the last V_WINDOW_MS of a gesture, the way
 * UIPanGestureRecognizer reports it. `t` is the release time: touchmove stops
 * firing the moment the finger stops, so without the stall gate a
 * drag-pause-release would replay the stale pre-pause velocity as a throw.
 */
export function releaseVelocity(samples: readonly Sample[], t: number): Vec2 {
  const last = samples[samples.length - 1];
  if (!last || t - last.t > V_STALL_MS) return { x: 0, y: 0 };
  let first = last;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (last.t - samples[i].t > V_WINDOW_MS) break;
    first = samples[i];
  }
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0) return { x: 0, y: 0 };
  return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
}

/** How far ahead a release looks: ~the distance a friction-decayed coast
 *  would add. Larger reads more flick-sensitive. */
const PROJECT_S = 0.2;

/** Where the gesture would coast to if the finger's momentum carried on. */
export function project(offset: Vec2, v: Vec2, tau = PROJECT_S): Vec2 {
  return { x: offset.x + v.x * tau, y: offset.y + v.y * tau };
}

/** The panel's at-rest viewport box, as the DOM side measures it. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Travel needed per axis (as a positive number) before a panel anchored at
 * the top-left has fully cleared the screen; `pad` covers its drop shadow.
 */
export function exitDistances(box: Box, pad = 28): Vec2 {
  return { x: box.left + box.width + pad, y: box.top + box.height + pad };
}

/**
 * Commit or cancel: dismiss when the projected point has crossed half the
 * panel on either dismissing axis (up or left). Encodes both ways out — a
 * slow deliberate drag past halfway with no speed, and a flick whose
 * projection covers the distance the finger didn't.
 */
export function shouldDismiss(offset: Vec2, v: Vec2, box: Box): boolean {
  const p = project(offset, v);
  return -p.x > box.width / 2 || -p.y > box.height / 2;
}

/**
 * Whether releasing a pull-open drag (from the collapsed chip) should open
 * the panel: the projected point must be more than halfway home along the
 * ray it was parked on. The mirror of shouldDismiss.
 */
export function shouldOpen(offset: Vec2, v: Vec2, parked: Vec2): boolean {
  const p = project(offset, v);
  const len2 = parked.x * parked.x + parked.y * parked.y;
  if (!len2) return true;
  return (p.x * parked.x + p.y * parked.y) / len2 < 0.5;
}

/** Slower than this (px/s) a release has no direction of its own. */
const THROW_MIN_SPEED = 250;

/**
 * Where a dismissal flies to: continue along the release velocity — the panel
 * leaves on the line it was thrown, like a flicked photo — stopping as soon
 * as one axis has fully cleared the screen. A slow release reuses the drag
 * displacement as its direction instead. Components pointing back on-screen
 * (down, right) are dropped: nothing exits that way.
 */
export function exitTarget(offset: Vec2, v: Vec2, dists: Vec2, minSpeed = THROW_MIN_SPEED): Vec2 {
  const fast = Math.hypot(v.x, v.y) >= minSpeed;
  let dx = fast ? Math.min(v.x, 0) : 0;
  let dy = fast ? Math.min(v.y, 0) : 0;
  if (!dx && !dy) {
    // Slow release, or a throw pointing entirely back on-screen: leave along
    // the drag displacement instead.
    dx = Math.min(offset.x, 0);
    dy = Math.min(offset.y, 0);
  }
  if (!dx && !dy) dy = -1; // nothing to go on at all: straight up
  const s = Math.min(
    dx < 0 ? (-dists.x - offset.x) / dx : Infinity,
    dy < 0 ? (-dists.y - offset.y) / dy : Infinity,
  );
  return { x: offset.x + dx * s, y: offset.y + dy * s };
}

/**
 * A damped spring, in SwiftUI's parametrization: `response` is the undamped
 * period in seconds (smaller = snappier) and `dampingRatio` 1 is critical —
 * no overshoot — with values below 1 bouncing. Mass is 1. Springs rather
 * than duration curves because they take an initial velocity, which is the
 * whole trick of a gesture-driven animation: the panel keeps the speed the
 * finger gave it.
 */
export interface Spring {
  /** Current position (px) and velocity (px/s). */
  x: number;
  v: number;
  target: number;
  /** Stiffness ω² and damping 2ζω, from makeSpring. */
  k: number;
  c: number;
}

export function makeSpring(x: number, v: number, target: number, response: number, dampingRatio: number): Spring {
  const w = (2 * Math.PI) / response;
  return { x, v, target, k: w * w, c: 2 * dampingRatio * w };
}

/**
 * Advance a spring by `dt` seconds (semi-implicit Euler, subdivided so a
 * dropped frame cannot blow the integration up; a background-tab stall is
 * clamped rather than fast-forwarded). Returns false once at rest, with the
 * position snapped to the target. `restDist`/`restSpeed` are the rest
 * thresholds — loose for a flight whose end is off-screen, tight for a
 * settle the eye watches land.
 */
export function stepSpring(s: Spring, dt: number, restDist = 0.5, restSpeed = 20): boolean {
  let remaining = Math.min(dt, 0.1);
  while (remaining > 0) {
    const h = Math.min(remaining, 1 / 120);
    remaining -= h;
    s.v += (-s.k * (s.x - s.target) - s.c * s.v) * h;
    s.x += s.v * h;
  }
  if (Math.abs(s.x - s.target) < restDist && Math.abs(s.v) < restSpeed) {
    s.x = s.target;
    s.v = 0;
    return false;
  }
  return true;
}

export type Claim = 'panel' | 'scroll' | 'undecided';

/**
 * Who owns a touch that has moved (dx, dy) from where it started: undecided
 * inside the slop circle; the panel once motion is mostly horizontal (nothing
 * inside the panel scrolls sideways); and for vertical motion, the scrollable
 * under the finger wins whenever it could actually consume the move — the
 * panel only drags once the list has nothing left to scroll that way, exactly
 * how a sheet behaves under a scroll view on iOS. `scroll` says whether such
 * a scrollable exists and which ways it can currently move.
 */
export function claimGesture(
  dx: number,
  dy: number,
  scroll: { up: boolean; down: boolean } | null,
  slop = 9,
): Claim {
  if (dx * dx + dy * dy < slop * slop) return 'undecided';
  if (Math.abs(dx) > Math.abs(dy)) return 'panel';
  // A finger moving up reveals content further down, and vice versa.
  return (dy < 0 ? scroll?.down : scroll?.up) ? 'scroll' : 'panel';
}
