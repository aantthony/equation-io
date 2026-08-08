import { describe, expect, it } from 'vitest';
import {
  CORNER_PROJECT_S,
  type Sample,
  type Vec2,
  claimGesture,
  cornerPositions,
  dismissEdge,
  exitRay,
  makeSpring,
  nearestCorner,
  project,
  releaseVelocity,
  rubberband,
  shouldOpen,
  stepSpring,
  throwDir,
} from './fling.ts';

/** A 300×500 panel in a 390×720 phone viewport with 12px margins. */
const W = 300;
const H = 500;
const VW = 390;
const VH = 720;
const M = { top: 12, right: 12, bottom: 12, left: 12 };
const CORNERS = cornerPositions(VW, VH, W, H, M);

describe('rubberband', () => {
  it('resists immediately and saturates at the limit', () => {
    expect(rubberband(0)).toBe(0);
    expect(rubberband(10)).toBeLessThan(10);
    expect(rubberband(10)).toBeGreaterThan(0);
    expect(rubberband(1e6)).toBeLessThan(90);
    expect(rubberband(1e6)).toBeGreaterThan(85);
  });

  it('is monotonic (more pull always shows more give)', () => {
    let prev = 0;
    for (let d = 10; d <= 500; d += 10) {
      const f = rubberband(d);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });

  it('passes free directions through as zero', () => {
    expect(rubberband(-40)).toBe(0);
  });
});

describe('releaseVelocity', () => {
  const line = (n: number, dtMs: number, step: Vec2): Sample[] =>
    Array.from({ length: n }, (_, i) => ({ t: i * dtMs, x: i * step.x, y: i * step.y }));

  it('measures a steady drag', () => {
    // 10px per 16ms upward: 625 px/s.
    const v = releaseVelocity(line(10, 16, { x: 0, y: -10 }), 9 * 16);
    expect(v.x).toBe(0);
    expect(v.y).toBeCloseTo(-625, 0);
  });

  it('only reads the recent window, not the whole gesture', () => {
    // A slow start followed by a fast finish must report the finish.
    const samples: Sample[] = [
      { t: 0, x: 0, y: 0 },
      { t: 300, x: 0, y: -10 }, // crawl
      { t: 340, x: 0, y: -50 },
      { t: 380, x: 0, y: -90 }, // 1000 px/s
    ];
    const v = releaseVelocity(samples, 380);
    expect(v.y).toBeCloseTo(-1000, 0);
  });

  it('reports zero after the finger rests before lifting', () => {
    // Drag, hold still (no samples arrive while stationary), then release:
    // the old motion must not replay as a throw.
    const samples = line(10, 16, { x: 0, y: -10 });
    const v = releaseVelocity(samples, 9 * 16 + 400);
    expect(v).toEqual({ x: 0, y: 0 });
  });

  it('handles empty and single-sample gestures', () => {
    expect(releaseVelocity([], 0)).toEqual({ x: 0, y: 0 });
    expect(releaseVelocity([{ t: 5, x: 1, y: 1 }], 10)).toEqual({ x: 0, y: 0 });
  });
});

describe('cornerPositions', () => {
  it('rests the panel inside the margins at all four corners', () => {
    expect(CORNERS).toEqual([
      { x: 12, y: 12 },
      { x: VW - 12 - W, y: 12 },
      { x: 12, y: VH - 12 - H },
      { x: VW - 12 - W, y: VH - 12 - H },
    ]);
  });

  it('honors asymmetric margins (safe areas)', () => {
    const c = cornerPositions(VW, VH, W, H, { top: 60, right: 12, bottom: 40, left: 20 });
    expect(c[0]).toEqual({ x: 20, y: 60 });
    expect(c[3]).toEqual({ x: VW - 12 - W, y: VH - 40 - H });
  });
});

describe('nearestCorner', () => {
  it('picks the corner the projected point belongs to', () => {
    expect(nearestCorner({ x: 0, y: 0 }, CORNERS)).toBe(0);
    expect(nearestCorner({ x: VW, y: 0 }, CORNERS)).toBe(1);
    expect(nearestCorner({ x: 0, y: VH }, CORNERS)).toBe(2);
    expect(nearestCorner({ x: VW, y: VH }, CORNERS)).toBe(3);
  });

  it('is decided by the projection, so a soft flick crosses the screen', () => {
    // At TL, flicked down at 1500 px/s: the projected point, not the current
    // one, must land in BL territory.
    const pos = CORNERS[0];
    const v = { x: 0, y: 1500 };
    expect(nearestCorner(project(pos, v, CORNER_PROJECT_S), CORNERS)).toBe(2);
    // The same flick judged at the current position would stay put.
    expect(nearestCorner(pos, CORNERS)).toBe(0);
  });
});

describe('dismissEdge', () => {
  it('stays on-screen for positions inside the viewport', () => {
    for (const c of CORNERS) expect(dismissEdge(c, W, H, VW, VH)).toBeNull();
    expect(dismissEdge({ x: 45, y: 110 }, W, H, VW, VH)).toBeNull();
  });

  it('commits once more than half the panel projects past an edge', () => {
    expect(dismissEdge({ x: -151, y: 12 }, W, H, VW, VH)).toBe('left');
    expect(dismissEdge({ x: -149, y: 12 }, W, H, VW, VH)).toBeNull();
    expect(dismissEdge({ x: 12, y: -251 }, W, H, VW, VH)).toBe('top');
    expect(dismissEdge({ x: VW - W + 151, y: 12 }, W, H, VW, VH)).toBe('right');
    expect(dismissEdge({ x: 12, y: VH - H + 251 }, W, H, VW, VH)).toBe('bottom');
  });

  it('lets a flick commit through the projection', () => {
    // 60px into a drag toward the top, flicked at 1600 px/s.
    const proj = project({ x: 12, y: -48 }, { x: 0, y: -1600 });
    expect(dismissEdge(proj, W, H, VW, VH)).toBe('top');
  });

  it('lets a pull-back flick rescue a drag already past half', () => {
    const proj = project({ x: 12, y: -260 }, { x: 0, y: 900 });
    expect(dismissEdge(proj, W, H, VW, VH)).toBeNull();
  });

  it('reads a diagonal hurl as its deepest edge', () => {
    // Past half on the left (fraction 160/300) and beyond on the top
    // (fraction 300/500): top is the deeper crossing.
    expect(dismissEdge({ x: -160, y: -300 }, W, H, VW, VH)).toBe('top');
  });
});

describe('throwDir', () => {
  const edge = 'left' as const;

  it('follows the throw when there is one', () => {
    expect(throwDir({ x: -900, y: -200 }, { x: -10, y: 0 }, edge)).toEqual({ x: -900, y: -200 });
  });

  it('keeps a slow carry’s heading', () => {
    expect(throwDir({ x: -40, y: 0 }, { x: -180, y: -30 }, edge)).toEqual({ x: -180, y: -30 });
  });

  it('falls back to straight out the crossed edge', () => {
    expect(throwDir({ x: 0, y: 0 }, { x: 0, y: 0 }, 'bottom')).toEqual({ x: 0, y: 1 });
  });
});

describe('exitRay', () => {
  it('continues along the throw until one side fully clears', () => {
    // From TL thrown hard left with a slight upward drift.
    const t = exitRay({ x: -80, y: 0 }, { x: -1200, y: -100 }, W, H, VW, VH);
    expect(t.x).toBeCloseTo(-W - 28, 5);
    expect(t.y).toBeCloseTo(-((-W - 28 + 80) / -1200) * 100, 5);
  });

  it('can leave past any corner on a diagonal throw', () => {
    // From BR, thrown down-right: exits whichever side the ray meets first.
    const pos = CORNERS[3];
    const t = exitRay(pos, { x: 900, y: 900 }, W, H, VW, VH);
    const clearsRight = t.x >= VW + 28 - 1e-6;
    const clearsBottom = t.y >= VH + 28 - 1e-6;
    expect(clearsRight || clearsBottom).toBe(true);
    // And it kept the 45° heading.
    expect(t.x - pos.x).toBeCloseTo(t.y - pos.y, 5);
  });

  it('leaves a panel already fully out where it is', () => {
    const out = { x: -W - 100, y: 12 };
    expect(exitRay(out, { x: -500, y: 0 }, W, H, VW, VH)).toEqual(out);
  });
});

describe('shouldOpen', () => {
  const parked: Vec2 = { x: 0, y: -540 };

  it('opens once pulled (or projected) past halfway home', () => {
    expect(shouldOpen({ x: 0, y: -260 }, { x: 0, y: 0 }, parked)).toBe(true);
    expect(shouldOpen({ x: 0, y: -300 }, { x: 0, y: 0 }, parked)).toBe(false);
    // A flick toward home from barely off the parked spot.
    expect(shouldOpen({ x: 0, y: -480 }, { x: 0, y: 1400 }, parked)).toBe(true);
  });

  it('measures along the parked ray for diagonal parks', () => {
    const diag: Vec2 = { x: -400, y: -300 };
    expect(shouldOpen({ x: -160, y: -120 }, { x: 0, y: 0 }, diag)).toBe(true);
    expect(shouldOpen({ x: -360, y: -270 }, { x: 0, y: 0 }, diag)).toBe(false);
  });

  it('works for parks past the far edges too', () => {
    // Pinned bottom-right, thrown off to the right: parked is positive-x.
    const parkedRight: Vec2 = { x: 340, y: 0 };
    expect(shouldOpen({ x: 120, y: 0 }, { x: 0, y: 0 }, parkedRight)).toBe(true);
    expect(shouldOpen({ x: 220, y: 0 }, { x: 0, y: 0 }, parkedRight)).toBe(false);
    expect(shouldOpen({ x: 320, y: 0 }, { x: -1200, y: 0 }, parkedRight)).toBe(true);
  });
});

describe('spring', () => {
  /** Run a spring to rest (or the step cap) and record its path. */
  const run = (s: ReturnType<typeof makeSpring>, dt = 1 / 60) => {
    const path: number[] = [];
    for (let i = 0; i < 600 && stepSpring(s, dt); i++) path.push(s.x);
    return path;
  };

  it('settles exactly on the target', () => {
    const s = makeSpring(0, 0, -340, 0.32, 1);
    run(s);
    expect(s.x).toBe(-340);
    expect(s.v).toBe(0);
  });

  it('does not overshoot at critical damping', () => {
    const s = makeSpring(-40, 0, -340, 0.32, 1);
    for (const x of run(s)) expect(x).toBeGreaterThanOrEqual(-340.5);
  });

  it('overshoots and returns below critical damping', () => {
    const s = makeSpring(-200, 0, 0, 0.4, 0.78);
    const path = run(s);
    expect(Math.max(...path)).toBeGreaterThan(0); // one visible bounce…
    expect(Math.max(...path)).toBeLessThan(30); // …but a small one
    expect(s.x).toBe(0);
  });

  it('carries the hand-off velocity through the release', () => {
    // Released moving away from the target: a spring that took the velocity
    // keeps moving away briefly before turning — the finger's motion is not
    // discarded at release.
    const s = makeSpring(-100, -500, 0, 0.4, 0.78);
    stepSpring(s, 1 / 60);
    expect(s.x).toBeLessThan(-100);
    run(s);
    expect(s.x).toBe(0);
  });

  it('survives a stalled tab (huge dt) without exploding', () => {
    const s = makeSpring(-200, 3000, 0, 0.32, 1);
    stepSpring(s, 5); // a 5s frame gap is clamped, not integrated in one step
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Math.abs(s.x)).toBeLessThan(1000);
  });
});

describe('claimGesture', () => {
  const scrollBoth = { up: true, down: true };
  const atBottom = { up: true, down: false };
  const atTop = { up: false, down: true };

  it('stays undecided inside the slop circle', () => {
    expect(claimGesture(4, -4, null)).toBe('undecided');
    expect(claimGesture(0, -8, scrollBoth)).toBe('undecided');
  });

  it('claims horizontal motion for the panel (nothing scrolls sideways)', () => {
    expect(claimGesture(-24, -10, scrollBoth)).toBe('panel');
    expect(claimGesture(24, 10, scrollBoth)).toBe('panel');
  });

  it('cedes vertical motion the list can consume', () => {
    expect(claimGesture(2, -20, atTop)).toBe('scroll'); // finger up, list has more below
    expect(claimGesture(2, 20, atBottom)).toBe('scroll'); // finger down, list has more above
  });

  it('claims vertical motion at the list edge (the sheet behavior)', () => {
    expect(claimGesture(2, -20, atBottom)).toBe('panel');
    expect(claimGesture(2, 20, atTop)).toBe('panel');
    expect(claimGesture(0, -20, null)).toBe('panel'); // nothing scrollable at all
  });
});

describe('project', () => {
  it('adds the deceleration horizon to the offset', () => {
    expect(project({ x: -10, y: -20 }, { x: -100, y: 200 })).toEqual({ x: -30, y: 20 });
  });
});
