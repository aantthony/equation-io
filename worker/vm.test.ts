import { describe, expect, it } from 'vitest';
import { evaluate, parseExpr } from '../lib/expr.ts';
import { compileProg, run } from './vm.ts';

describe('expression stack machine', () => {
  it('matches the AST evaluator on a typical field', () => {
    const e = parseExpr('sin(x)cos(y) + x^2/4 - atan2(y, x)');
    const prog = compileProg(e, new Map([['x', 0], ['y', 1]]));
    const stack = new Float64Array(prog.depth);
    for (const [x, y] of [[0.5, -1.2], [3, 4], [-2.5, 0.1]]) {
      expect(run(prog, [x, y], stack)).toBeCloseTo(evaluate(e, { x, y }), 12);
    }
  });

  it('matches the AST evaluator on the probability builtins', () => {
    // erf is 1-arg, normalpdf/normalcdf are the only 3-arg builtins (Fn3).
    const e = parseExpr('normalcdf(x, 1, 0.5) - normalcdf(y, 1, 0.5) + normalpdf(x y, 0, 2) + erf(x - y)');
    const prog = compileProg(e, new Map([['x', 0], ['y', 1]]));
    const stack = new Float64Array(prog.depth);
    for (const [x, y] of [[2, 0], [0.3, -1.2], [-0.5, 0.5]]) {
      expect(run(prog, [x, y], stack)).toBeCloseTo(evaluate(e, { x, y }), 12);
    }
  });

  it('matches the AST evaluator on the special functions', () => {
    const e = parseExpr('x! + gamma(x + 3) + sinc(x) + coth(x)');
    const prog = compileProg(e, new Map([['x', 0]]));
    const stack = new Float64Array(prog.depth);
    for (const x of [2.5, 0.3, -0.7]) {
      expect(run(prog, [x], stack)).toBeCloseTo(evaluate(e, { x }), 12);
    }
  });

  it('matches the AST evaluator on negative bases with fractional exponents', () => {
    const e = parseExpr('x^(1/3)');
    const prog = compileProg(e, new Map([['x', 0]]));
    const stack = new Float64Array(prog.depth);
    expect(run(prog, [-8], stack)).toBeCloseTo(evaluate(e, { x: -8 }), 12);
    expect(run(prog, [-8], stack)).toBeCloseTo(-2, 12);
    expect(run(prog, [8], stack)).toBeCloseTo(2, 12);
    const even = parseExpr('x^(1/2)');
    const evenProg = compileProg(even, new Map([['x', 0]]));
    expect(run(evenProg, [-4], new Float64Array(evenProg.depth))).toBeNaN();
  });

  it('reports the true stack depth for deeply right-nested expressions', () => {
    // 1+(1+(1+(... x ...))) nests 80 deep — more than any fixed small stack.
    const deep = '1+('.repeat(80) + 'x' + ')'.repeat(80);
    const e = parseExpr(deep);
    const prog = compileProg(e, new Map([['x', 0]]));
    expect(prog.depth).toBeGreaterThan(64);
    const stack = new Float64Array(prog.depth);
    expect(run(prog, [2], stack)).toBe(82);
  });
});
