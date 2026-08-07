import { describe, expect, it } from 'vitest';
import {
  type Sample,
  type Vec2,
  claimGesture,
  exitDistances,
  exitTarget,
  makeSpring,
  project,
  releaseVelocity,
  rubberband,
  shouldDismiss,
  shouldOpen,
  stepSpring,
} from './fling.ts';

/** A 300×500 panel sitting 12px in from the top-left corner. */
const BOX = { left: 12, top: 12, width: 300, height: 500 };

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

describe('shouldDismiss', () => {
  it('dismisses a slow drag carried past half the panel', () => {
    expect(shouldDismiss({ x: 0, y: -260 }, { x: 0, y: 0 }, BOX)).toBe(true);
    expect(shouldDismiss({ x: -160, y: 0 }, { x: 0, y: 0 }, BOX)).toBe(true);
  });

  it('cancels a slow drag short of half', () => {
    expect(shouldDismiss({ x: 0, y: -240 }, { x: 0, y: 0 }, BOX)).toBe(false);
    expect(shouldDismiss({ x: -140, y: 0 }, { x: 0, y: 0 }, BOX)).toBe(false);
  });

  it('lets a flick dismiss from a short distance (projection covers the rest)', () => {
    // 60px in, flicked up at 1600px/s: projects to 60 + 320 past halfway.
    expect(shouldDismiss({ x: 0, y: -60 }, { x: 0, y: -1600 }, BOX)).toBe(true);
    expect(shouldDismiss({ x: -40, y: 0 }, { x: -1400, y: 0 }, BOX)).toBe(true);
  });

  it('lets a pull-back flick rescue a drag already past half', () => {
    // Physically past halfway, but thrown back toward home on release.
    expect(shouldDismiss({ x: 0, y: -270 }, { x: 0, y: 800 }, BOX)).toBe(false);
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
});

describe('exitTarget', () => {
  const dists = exitDistances(BOX); // {x: 340, y: 540}

  it('computes exit travel from the panel box', () => {
    expect(dists).toEqual({ x: 12 + 300 + 28, y: 12 + 500 + 28 });
  });

  it('continues along the throw line until one axis clears the screen', () => {
    const t = exitTarget({ x: -80, y: -10 }, { x: -1200, y: -100 }, dists);
    // Leftward is the near exit: x lands exactly fully off-screen.
    expect(t.x).toBeCloseTo(-340, 5);
    // y keeps the throw's slope: 100/1200 of the remaining 260px of x travel.
    expect(t.y).toBeCloseTo(-10 - (260 / 1200) * 100, 5);
  });

  it('falls back to the drag displacement on a slow release', () => {
    const t = exitTarget({ x: -180, y: -6 }, { x: -40, y: 0 }, dists);
    expect(t.x).toBeCloseTo(-340, 5);
    expect(t.y).toBeCloseTo(-6 - (160 / 180) * 6, 5);
  });

  it('drops throw components that point back on-screen', () => {
    // Thrown up and to the right: exits straight up, x pinned where it is.
    const t = exitTarget({ x: -30, y: -100 }, { x: 600, y: -900 }, dists);
    expect(t.x).toBe(-30);
    expect(t.y).toBeCloseTo(-540, 5);
  });

  it('uses the displacement when the whole throw points on-screen', () => {
    // Deep left drag released with a small down-right jitter above the speed
    // floor: the exit must still leave leftward, not "straight up".
    const t = exitTarget({ x: -260, y: 0 }, { x: 200, y: 260 }, dists);
    expect(t.x).toBeCloseTo(-340, 5);
    expect(t.y).toBe(0);
  });

  it('goes straight up given nothing to go on', () => {
    const t = exitTarget({ x: 0, y: 0 }, { x: 0, y: 0 }, dists);
    expect(t.x).toBe(0);
    expect(t.y).toBeCloseTo(-540, 5);
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
