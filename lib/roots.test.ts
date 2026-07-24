import { describe, expect, it } from 'vitest';
import { parseExpr } from './expr.ts';
import { findRoots } from './roots.ts';

function find(s: string, lo: number, hi: number, v = 'x') {
  return findRoots(parseExpr(s), v, lo, hi);
}

describe('findRoots (exact path)', () => {
  it('filters polynomial roots to the interval', () => {
    const r = find('x^2 - 2', 0, 5);
    expect(r).toEqual([{ x: Math.SQRT2, mult: 1, exact: true, sym: '√2' }]);
  });

  it('reports identically-zero expressions', () => {
    expect(find('x - x', -1, 1)).toBe('zero');
  });
});

describe('findRoots (numeric path)', () => {
  it('finds all zeros of sin on [-10, 10] to high accuracy', () => {
    const r = find('sin(x)', -10, 10);
    expect(r).not.toBe('zero');
    const list = r as Array<{ x: number; mult: number }>;
    expect(list.length).toBe(7); // kπ for k = -3..3
    list.forEach((root, i) => {
      expect(root.x).toBeCloseTo((i - 3) * Math.PI, 12);
      expect(root.mult).toBe(1);
    });
  });

  it('finds tangential (even multiplicity) roots', () => {
    const r = find('sin(x)^2', 1, 5) as Array<{ x: number; mult: number }>;
    expect(r.length).toBe(1);
    expect(r[0].x).toBeCloseTo(Math.PI, 8);
    expect(r[0].mult).toBe(2);
  });

  it('does not report near-misses as roots', () => {
    expect(find('sin(x)^2 + 0.001', -5, 5)).toEqual([]);
  });

  it('rejects poles that flip sign', () => {
    const r = find('tan(x)', 1, 2); // pole at π/2 ≈ 1.5708, no root
    expect(r).toEqual([]);
  });

  it('finds roots of transcendental equations', () => {
    const r = find('exp(x) - 2', -5, 5) as Array<{ x: number }>;
    expect(r.length).toBe(1);
    expect(r[0].x).toBeCloseTo(Math.LN2, 12);
  });

  it('survives domain holes (NaN regions)', () => {
    const r = find('ln(x)', -5, 5) as Array<{ x: number }>;
    expect(r.length).toBe(1);
    expect(r[0].x).toBeCloseTo(1, 12);
  });

  it('handles steep functions without false poles', () => {
    const r = find('1000000 (x - 1)', -5, 5) as Array<{ x: number; exact: boolean }>;
    expect(r.length).toBe(1);
    expect(r[0].x).toBeCloseTo(1, 12);
  });
});

describe('findRoots (bit-budget fallback)', () => {
  // exprToPoly gives up when coefficients outgrow its bit budget; the roots
  // must still be found, just numerically — without exact multiplicities or
  // symbolic labels.

  it('still finds the root of a bailed decimal power', () => {
    // (0.1x - 0.3)^16 is over budget, so this is the numeric path.
    const r = find('(0.1x - 0.3)^16', -10, 10) as Array<{ x: number; exact: boolean }>;
    expect(r.length).toBeGreaterThan(0);
    expect(r.every(v => !v.exact)).toBe(true);
    expect(r.some(v => Math.abs(v.x - 3) < 1e-3)).toBe(true);
  });

  it('resolves the 60-second case in milliseconds', () => {
    const t0 = performance.now();
    const r = find('(0.1x - 0.3)^128', -10, 10) as Array<{ x: number; exact: boolean }>;
    const dt = performance.now() - t0;
    // Degree 128 with a 128-fold root is numerically flat over a whole
    // neighbourhood, so the cluster is wide; it still brackets x = 3.
    expect(r.length).toBeGreaterThan(0);
    expect(r.every(v => Math.abs(v.x - 3) < 0.05)).toBe(true);
    expect(r.every(v => !v.exact)).toBe(true);
    expect(dt).toBeLessThan(2000);
  });

  it('recovers both roots of a bailed two-factor product', () => {
    const r = find('(x - 0.1)^32 (x - 0.3)^32', -10, 10) as Array<{ x: number }>;
    expect(r.length).toBe(2);
    expect(r[0].x).toBeCloseTo(0.1, 3);
    expect(r[1].x).toBeCloseTo(0.3, 3);
  });
});
