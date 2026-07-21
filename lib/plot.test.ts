import { describe, expect, it } from 'vitest';
import { evaluate, parseExpr } from './expr.ts';
import { classify } from './plot.ts';

const cls = (s: string) => classify(parseExpr(s));

describe('classify', () => {
  it('routes equations to implicit curves and surfaces', () => {
    expect(cls('y = x^2').plot.type).toBe('implicit2d');
    expect(cls('x^2+y^2=4').plot.type).toBe('implicit2d');
    expect(cls('x^2+y^2+z^2=9').plot.type).toBe('implicit3d');
    expect(cls('z = sin(x)cos(y)').plot.type).toBe('implicit3d');
  });

  it('routes bare scalars', () => {
    expect(cls('sin(x)').plot.type).toBe('implicit2d'); // y = sin(x)
    expect(cls('sin(x)cos(y)').plot.type).toBe('scalar2d');
    expect(cls('x^2+y^2+z^2-9').plot.type).toBe('implicit3d');
  });

  it('routes points', () => {
    const p2 = cls('(2, 3)');
    expect(p2.plot).toMatchObject({ type: 'point', dim: 2 });
    expect(p2.needs3D).toBe(false);
    const p3 = cls('(3, 12, 0)');
    expect(p3.plot).toMatchObject({ type: 'point', dim: 3 });
    expect(p3.needs3D).toBe(true);
  });

  it('routes parametric curves and surfaces', () => {
    expect(cls('(cos(2pi u), sin(2pi u))').plot).toMatchObject({ type: 'pcurve', dim: 2 });
    expect(cls('(cos(2pi u), sin(2pi u), u)').plot).toMatchObject({ type: 'pcurve', dim: 3 });
    expect(cls('(u, v, sin(2pi u))').plot.type).toBe('psurface');
    expect(() => cls('(u, v)')).toThrow(/3 components/);
  });

  it('flags t as animated', () => {
    expect(cls('(cos(t), sin(t))').animated).toBe(true);
    expect(cls('y = sin(x - t)').animated).toBe(true);
    expect(cls('y = sin(x)').animated).toBe(false);
  });

  it('routes inequalities to shaded regions', () => {
    const strict = cls('y < x^2');
    expect(strict.plot).toMatchObject({ type: 'ineq2d', edges: [] });

    const closed = cls('x^2 + y^2 <= 4');
    expect(closed.plot.type).toBe('ineq2d');
    expect((closed.plot as { edges: string[] }).edges).toHaveLength(1);

    // > normalizes to F < 0 by flipping sides.
    expect(cls('y > x').plot).toMatchObject({ type: 'ineq2d', edges: [] });
    expect((cls('y ≥ x').plot as { edges: string[] }).edges).toHaveLength(1);
  });

  it('flattens chained inequalities into max() with per-bound edges', () => {
    const c = cls('4 <= x^2 + y^2 <= 9');
    const plot = c.plot as { type: string; field: string; edges: string[] };
    expect(plot.type).toBe('ineq2d');
    expect(plot.field).toContain('max(');
    expect(plot.edges).toHaveLength(2);

    // Mixed strictness keeps only the non-strict bound's edge.
    const mixed = cls('-1 <= y - sin(x) < 1');
    expect((mixed.plot as { edges: string[] }).edges).toHaveLength(1);
  });

  it('rejects malformed inequalities', () => {
    expect(() => cls('1 < y > x')).toThrow(/same way/);
    expect(() => cls('z < 1')).toThrow(/2D only/);
    expect(() => cls('ln(w) < 1')).toThrow(/re\(/);
  });

  it('rejects unknown variables and u/v mixing', () => {
    expect(() => cls('y = q')).toThrow(/Unknown variable/);
    expect(() => cls('(x, u, v)')).toThrow(/mix/);
  });

  it('directs a bare function name to parentheses instead of a slider', () => {
    // `sin x` parses as sin*x; the leftover `sin` var should hint at parens.
    expect(() => cls('sin x')).toThrow(/sin is a function/);
    expect(() => cls('Cos y')).toThrow(/write it with parentheses/);
  });
});

describe('vector evaluate', () => {
  it('evaluates components', () => {
    const e = parseExpr('(cos(2pi u), sin(2pi u))');
    if (e.kind !== 'vec') throw new Error('expected vec');
    expect(evaluate(e.items[0], { u: 0.5 })).toBeCloseTo(-1);
    expect(evaluate(e.items[1], { u: 0.25 })).toBeCloseTo(1);
  });
});
