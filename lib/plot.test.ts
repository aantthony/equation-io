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

  it('sweeps a tube only when tube(…) asks for one', () => {
    // A bare 3D curve stays a line strip, so it cannot swallow points or
    // other curves sharing the scene.
    const bare = cls('(cos(2pi u), sin(2pi u), u)').plot as { tube?: number };
    expect(bare.tube).toBeUndefined();

    const tubed = cls('tube((cos(2pi u), sin(2pi u), u))').plot;
    expect(tubed).toMatchObject({ type: 'pcurve', dim: 3, tube: 0.1 });
    // Framing derivatives still come through the wrapper.
    expect((tubed as { d1?: unknown[] }).d1).toHaveLength(3);

    expect(cls('tube((cos(2pi u), sin(2pi u), u), 0.03)').plot).toMatchObject({ tube: 0.03 });
    // A parenthesized vector flattens into the argument list, so the
    // unparenthesized spelling is the same plot.
    expect(cls('tube(cos(2pi u), sin(2pi u), u)').plot).toMatchObject({ tube: 0.1 });
    // Builtin names fold case, so Tube(…) works too.
    expect(cls('Tube((cos(2pi u), sin(2pi u), u))').plot).toMatchObject({ tube: 0.1 });
  });

  it('rejects tube(…) on anything that is not a 3D curve', () => {
    expect(() => cls('tube((cos(2pi u), sin(2pi u)))')).toThrow(/three components/);
    expect(() => cls('tube(x^2)')).toThrow(/three components/);
    expect(() => cls('tube((1, 2, 3))')).toThrow(/curve in u/);
    expect(() => cls('tube((cos(2pi u), sin(2pi u), u), 0)')).toThrow(/positive number/);
    expect(() => cls('tube((cos(2pi u), sin(2pi u), u), a)')).toThrow(/positive number/);
    expect(() => cls('z = tube((cos(u), sin(u), u))')).toThrow(/whole expression/);
  });

  it('routes (x,y)-dependent vectors to vector fields', () => {
    const f = cls('(-y, x)');
    expect(f.plot.type).toBe('vfield2d');
    expect(f.needs3D).toBe(false);
    expect(f.animated).toBe(true); // streamlines drift continuously
    expect(cls('(y, -sin(x))').plot.type).toBe('vfield2d');
    expect(cls('(cos(t) - y, x)').plot.type).toBe('vfield2d');
    expect(() => cls('(x, y, z)')).toThrow(/2D only/);
    expect(() => cls('(x, y, 1)')).toThrow(/2 components/);
  });

  it('routes ODE notation to vector fields', () => {
    const slope = cls("y' = sin(x) - y");
    expect(slope.plot).toMatchObject({ type: 'vfield2d', fx: '1.0' });

    const leib = cls('dy/dx = x y');
    expect(leib.plot).toMatchObject({ type: 'vfield2d', fx: '1.0', fy: '(x * y)' });
    expect(cls('dx/dy = x y').plot).toMatchObject({ type: 'vfield2d', fy: '1.0' });

    const sys = cls("(x', y') = (y, -sin(x))");
    expect(sys.plot).toMatchObject({ type: 'vfield2d', fx: 'y' });

    // Constant right sides still make a (uniform) field, not a point.
    expect(cls("y' = 2").plot.type).toBe('vfield2d');

    expect(() => cls("(x', y') = 3")).toThrow(/two components/);
    expect(() => cls("y = y'")).toThrow(/left of an ODE/);
    expect(() => cls("y' = sin(u)")).toThrow(/cannot use u/);
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

describe('level families', () => {
  const clsWith = (s: string, consts: string[]) => classify(parseExpr(s), new Set(consts));
  const levelsOf = (c: ReturnType<typeof classify>) =>
    (c.plot as { levels?: { glsl: string; params: string[]; angular: boolean } }).levels;

  it('detects f(x,y) = c with a slider constant, either way around', () => {
    for (const s of ['x^2 + y^2 = c', 'c = x^2 + y^2']) {
      const c = clsWith(s, ['c']);
      expect(c.plot.type).toBe('implicit2d');
      expect(c.params).toEqual(['c']);
      const lv = levelsOf(c);
      expect(lv).toBeDefined();
      expect(lv!.glsl).toContain('x');
      expect(lv!.params).toEqual([]); // family of f itself, no c
    }
  });

  it('keeps other constants as uniforms inside the family', () => {
    const lv = levelsOf(clsWith('a x^2 + y^2 = c', ['a', 'c']));
    expect(lv!.glsl).toContain('u_a');
    expect(lv!.params).toEqual(['a']);
  });

  it('marks angle-valued families as angular', () => {
    expect(levelsOf(clsWith('atan2(y, x) = c', ['c']))!.angular).toBe(true);
    expect(levelsOf(clsWith('x y = c', ['c']))!.angular).toBe(false);
  });

  it('offers no family without a lone slider side', () => {
    expect(levelsOf(cls('x^2 + y^2 = 4'))).toBeUndefined();
    expect(levelsOf(cls('y = x^2'))).toBeUndefined();
    expect(levelsOf(clsWith('x^2 + y^2 = c + 1', ['c']))).toBeUndefined();
  });

  it('offers no family for 3D, complex, or plane-free sides', () => {
    expect(clsWith('x^2 + y^2 + z^2 = c', ['c']).plot.type).toBe('implicit3d');
    expect(levelsOf(clsWith('re(w^2) = c', ['c']))).toBeUndefined();
    expect(levelsOf(clsWith('sin(t) = c', ['c']))).toBeUndefined();
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

describe('lists and piecewise plots', () => {
  it('routes numeric lists to vlist', () => {
    expect(cls('[1, 4, 2, 8]').plot.type).toBe('vlist');
  });

  it('routes point lists to plist with the right dimension', () => {
    expect(cls('[(1, 2), (3, 4)]').plot).toMatchObject({ type: 'plist', dim: 2 });
    expect(cls('[(1, 2, 3), (4, 5, 6)]').needs3D).toBe(true);
  });

  it('rejects malformed lists', () => {
    expect(() => cls('[1, (2, 3)]')).toThrow(/mix/);
    expect(() => cls('[x, 2]')).toThrow(/constants and t/);
    expect(() => cls('[(1, 2), (3, 4, 5)]')).toThrow(/same number/);
  });

  it('rejects plot-mode forms nested inside a piecewise or list', () => {
    expect(() => cls('y = {x < 0: domain(w), 1}')).toThrow(/whole expression/);
    expect(() => cls('[1, conformal(w)]')).toThrow(/whole expression/);
  });

  it('routes piecewise equations through implicit curves', () => {
    expect(cls('y = {x < 0: -x, x >= 0: x^2}').plot.type).toBe('implicit2d');
    expect(cls('{x < 0: -x, x^2}').plot.type).toBe('implicit2d'); // bare → y = expr
  });
});
