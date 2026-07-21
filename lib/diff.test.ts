import { describe, expect, it } from 'vitest';
import { diff } from './diff.ts';
import { evaluate, parseExpr } from './expr.ts';
import { classify } from './plot.ts';

function ddx(s: string, at: Record<string, number>, wrt = 'x'): number {
  return evaluate(diff(parseExpr(s), wrt), at);
}

describe('diff', () => {
  it('differentiates polynomials', () => {
    expect(ddx('x^2', { x: 3 })).toBe(6);
    expect(ddx('x^3 - 2x', { x: 2 })).toBe(10);
    expect(ddx('5', { x: 1 })).toBe(0);
  });

  it('applies product, quotient, chain rules', () => {
    expect(ddx('x sin(x)', { x: 2 })).toBeCloseTo(Math.sin(2) + 2 * Math.cos(2));
    expect(ddx('sin(x^2)', { x: 1.3 })).toBeCloseTo(Math.cos(1.69) * 2.6);
    expect(ddx('1/x', { x: 4 })).toBeCloseTo(-1 / 16);
    expect(ddx('e^x', { x: 1 })).toBeCloseTo(Math.E);
    expect(ddx('ln(x)', { x: 5 })).toBeCloseTo(0.2);
    expect(ddx('sqrt(x)', { x: 9 })).toBeCloseTo(1 / 6);
    expect(ddx('x^x', { x: 2 })).toBeCloseTo(4 * (Math.log(2) + 1));
  });

  it('treats other variables as constants', () => {
    expect(ddx('u v', { u: 7, v: 5 }, 'u')).toBe(5);
    expect(ddx('cos(2pi v)', { v: 0.3 }, 'u')).toBe(0);
  });

  it('throws for non-smooth functions', () => {
    expect(() => diff(parseExpr('min(x, 1)'), 'x')).toThrow(/differentiate/);
    expect(() => diff(parseExpr('floor(x)'), 'x')).toThrow(/differentiate/);
  });
});

describe('symbolic derivatives in classification', () => {
  it('provides tangents for smooth parametric surfaces', () => {
    const c = classify(parseExpr('(cos(2pi u), sin(2pi u), v)'));
    if (c.plot.type !== 'psurface') throw new Error('expected psurface');
    expect(c.plot.du).toBeDefined();
    expect(c.plot.dv).toBeDefined();
    expect(c.plot.dv![2]).toBe('1.0');
  });

  it('falls back to undefined tangents for non-smooth components', () => {
    const c = classify(parseExpr('(u, v, floor(4u))'));
    if (c.plot.type !== 'psurface') throw new Error('expected psurface');
    expect(c.plot.du).toBeUndefined();
  });

  it('provides gradients for smooth implicit surfaces', () => {
    const c = classify(parseExpr('x^2+y^2+z^2=9'));
    if (c.plot.type !== 'implicit3d') throw new Error('expected implicit3d');
    expect(c.plot.grad).toBeDefined();
    expect(evaluate(diff(parseExpr('x^2+y^2+z^2-9'), 'z'), { x: 0, y: 0, z: 2 })).toBe(4);
  });
});
