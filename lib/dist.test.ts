import { describe, expect, it } from 'vitest';
import {
  type DistDef,
  densityExpr,
  matchProbability,
  parseDistribution,
  probabilityValue,
  regionExpr,
  scanDistribution,
  toProbability,
} from './dist.ts';
import { evaluate, parseExpr } from './expr.ts';
import { classify } from './plot.ts';

const none = new Set<string>();

const dist = (rhs: string, name = 'X'): DistDef => parseDistribution(name, rhs, none);

const dists = (...ds: DistDef[]) => new Map(ds.map(d => [d.name, d]));

const prob = (inner: string, ds = dists(dist('Normal(0, 1)'))) =>
  toProbability(parseExpr(inner), ds);

describe('erf / normal built-ins', () => {
  it('evaluates erf accurately', () => {
    expect(evaluate(parseExpr('erf(1)'), {})).toBeCloseTo(0.8427008, 5);
    expect(evaluate(parseExpr('erf(-1)'), {})).toBeCloseTo(-0.8427008, 5);
    expect(evaluate(parseExpr('erf(0)'), {})).toBe(0);
  });

  it('evaluates normalpdf and normalcdf', () => {
    expect(evaluate(parseExpr('normalpdf(0, 0, 1)'), {})).toBeCloseTo(0.3989423, 6);
    expect(evaluate(parseExpr('normalpdf(3, 1, 2)'), {})).toBeCloseTo(0.1209854, 6);
    expect(evaluate(parseExpr('normalcdf(0, 0, 1)'), {})).toBeCloseTo(0.5, 6);
    expect(evaluate(parseExpr('normalcdf(1.959964, 0, 1)'), {})).toBeCloseTo(0.975, 5);
  });

  it('plots y = normalcdf(x, 0, 1) as a curve', () => {
    expect(classify(parseExpr('y = normalcdf(x, 0, 1)')).plot.type).toBe('implicit2d');
  });
});

describe('scanDistribution / parseDistribution', () => {
  it('detects name ~ rhs rows', () => {
    expect(scanDistribution('X ~ Normal(0, 1)')).toEqual({ name: 'X', rhs: 'Normal(0, 1)' });
    expect(scanDistribution('y = x^2')).toBeNull();
    expect(scanDistribution('a = 2')).toBeNull();
  });

  it('parses Normal with symbolic parameters', () => {
    const d = dist('Normal(0, a)');
    expect(d.mean).toEqual({ kind: 'num', value: 0 });
    expect(d.sd).toEqual({ kind: 'var', name: 'a' });
    expect(dist('normal(1, 2)').mean).toEqual({ kind: 'num', value: 1 });
  });

  it('rejects unknown distributions and wrong arity', () => {
    expect(() => dist('Poisson(3)')).toThrow(/Unknown distribution/);
    expect(() => dist('Normal(1)')).toThrow(/2 arguments/);
    expect(() => dist('Normal(1, 2, 3)')).toThrow(/2 arguments/);
    expect(() => dist('2x + 1')).toThrow(/Expected a distribution/);
  });
});

describe('densityExpr', () => {
  it('classifies as an implicit curve with slider params', () => {
    const c = classify(densityExpr(dist('Normal(0, a)')), new Set(['a']));
    expect(c.plot.type).toBe('implicit2d');
    expect(c.params).toEqual(['a']);
    const field = (c.plot as { field: string }).field;
    expect(field).toContain('eq_normalpdf');
    expect(field).toContain('u_a');
  });

  it('evaluates to the density (y - pdf = 0 on the curve)', () => {
    const e = densityExpr(dist('Normal(0, 1)'));
    expect(evaluate(e, { x: 0, y: 0.3989423 })).toBeCloseTo(0, 6);
  });
});

describe('toProbability', () => {
  it('reads X < b and b < X', () => {
    const upper = prob('X < 2');
    expect(upper.lo).toBeUndefined();
    expect(upper.hi).toEqual({ kind: 'num', value: 2 });
    const lower = prob('-1 < X');
    expect(lower.lo).toEqual({ kind: 'neg', a: { kind: 'num', value: 1 } });
    expect(lower.hi).toBeUndefined();
  });

  it('reads > by flipping', () => {
    const p = prob('X > 2');
    expect(p.lo).toEqual({ kind: 'num', value: 2 });
    expect(p.hi).toBeUndefined();
  });

  it('reads two-sided chains in either direction', () => {
    const asc = prob('-1 < X <= 2');
    expect(asc.lo).toEqual({ kind: 'neg', a: { kind: 'num', value: 1 } });
    expect(asc.hi).toEqual({ kind: 'num', value: 2 });
    const desc = prob('2 > X > -1');
    expect(desc.lo).toEqual({ kind: 'neg', a: { kind: 'num', value: 1 } });
    expect(desc.hi).toEqual({ kind: 'num', value: 2 });
  });

  it('picks the referenced variable among several', () => {
    const ds = dists(dist('Normal(0, 1)'), dist('Normal(5, 2)', 'Y'));
    expect(prob('Y < 4', ds).dist.name).toBe('Y');
  });

  it('rejects malformed bodies', () => {
    expect(() => prob('X + 1')).toThrow(/expects an inequality/);
    expect(() => prob('a < b')).toThrow(/must reference a random variable/);
    expect(() => prob('-1 < X > 2')).toThrow(/same way/);
    expect(() => prob('X < a < b')).toThrow(/at most two bounds/);
    expect(() => prob('X < x')).toThrow(/cannot use x/);
    const two = dists(dist('Normal(0, 1)'), dist('Normal(0, 1)', 'Y'));
    expect(() => prob('X < Y', two)).toThrow(/Only one random variable/);
  });
});

describe('regionExpr', () => {
  it('classifies as a shaded region with an outline', () => {
    const c = classify(regionExpr(prob('X < b')), new Set(['b']));
    expect(c.plot.type).toBe('ineq2d');
    const plot = c.plot as { field: string; edges: string[] };
    expect(plot.field).toContain('max(');
    expect(plot.field).toContain('eq_normalpdf');
    expect(plot.field).toContain('u_b');
    expect(plot.edges).toHaveLength(1);
    expect(c.params).toEqual(['b']);
  });

  it('is negative inside the area and positive outside', () => {
    const region = regionExpr(prob('-1 < X < 1'));
    if (region.kind !== 'ineq') throw new Error('expected ineq');
    const f = (x: number, y: number) => evaluate(region.l, { x, y });
    expect(f(0, 0.2)).toBeLessThan(0); // under the peak
    expect(f(0, 0.5)).toBeGreaterThan(0); // above the density
    expect(f(2, 0.05)).toBeGreaterThan(0); // outside the bounds
    expect(f(0, -0.1)).toBeGreaterThan(0); // below the axis
  });
});

describe('probabilityValue', () => {
  it('computes one- and two-sided probabilities', () => {
    expect(probabilityValue(prob('X < 0'), {})).toBeCloseTo(0.5, 6);
    expect(probabilityValue(prob('X < 1.959964'), {})).toBeCloseTo(0.975, 5);
    expect(probabilityValue(prob('X > 1'), {})).toBeCloseTo(0.1586553, 5);
    expect(probabilityValue(prob('-1 < X < 1'), {})).toBeCloseTo(0.6826895, 5);
  });

  it('uses the constant environment for parameters and bounds', () => {
    const ds = dists(dist('Normal(m, s)'));
    const p = toProbability(parseExpr('X < b'), ds);
    expect(probabilityValue(p, { m: 1, s: 2, b: 1 })).toBeCloseTo(0.5, 6);
  });

  it('is NaN for a non-positive sd', () => {
    const ds = dists(dist('Normal(0, s)'));
    expect(probabilityValue(toProbability(parseExpr('X < 1'), ds), { s: 0 })).toBeNaN();
  });
});

describe('P(…) row matching', () => {
  it('matches only whole P(...) rows', () => {
    expect(matchProbability('P(X < 2)')).toBe('X < 2');
    expect(matchProbability(' P ( -1 < X < 2 ) ')).toBe(' -1 < X < 2 ');
    expect(matchProbability('y = P(X < 2)')).toBeNull();
    expect(matchProbability('Q(X < 2)')).toBeNull();
  });
});
