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
