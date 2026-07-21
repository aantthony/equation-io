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

  it('rejects unknown variables and u/v mixing', () => {
    expect(() => cls('y = q')).toThrow(/Unknown variable/);
    expect(() => cls('(x, u, v)')).toThrow(/mix/);
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
