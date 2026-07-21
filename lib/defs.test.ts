import { describe, expect, it } from 'vitest';
import {
  type Definition,
  buildDefs,
  constsAnimated,
  evalConstEnv,
  resolveExpr,
  scanDefinition,
} from './defs.ts';
import { evaluate, parseExpr } from './expr.ts';
import { classify } from './plot.ts';

const noFns = () => undefined;
const resolve = (s: string) => resolveExpr(parseExpr(s), noFns);

describe('scanDefinition', () => {
  it('detects constants and functions', () => {
    expect(scanDefinition('a = 2')).toEqual({ kind: 'const', name: 'a', rhs: ' 2' });
    expect(scanDefinition('f(x) = x^2')).toEqual({ kind: 'fn', name: 'f', params: ['x'], rhs: ' x^2' });
    expect(scanDefinition('g(a, b) = a b')).toMatchObject({ kind: 'fn', params: ['a', 'b'] });
  });

  it('leaves plots and built-ins alone', () => {
    expect(scanDefinition('y = x^2')).toBeNull(); // reserved
    expect(scanDefinition('sin(x) = 1')).toBeNull(); // built-in
    expect(scanDefinition('x^2 + y^2 = 4')).toBeNull();
    expect(scanDefinition('e = 3')).toBeNull();
  });
});

describe('d/dx derivative syntax', () => {
  const at = (s: string, env: Record<string, number>) => evaluate(resolve(s), env);

  it('differentiates with and without parens', () => {
    expect(at('d/dx (x^3)', { x: 2 })).toBe(12);
    expect(at('d/dx x^3', { x: 2 })).toBe(12);
    expect(at('d/dx sin(x)', { x: 0 })).toBe(1);
  });

  it('handles coefficients, negation, and trailing terms', () => {
    expect(at('2 d/dx (x^2)', { x: 3 })).toBe(12);
    expect(at('-d/dx (x^2)', { x: 1 })).toBe(-2);
    expect(at('d/dx (x^2) + 1', { x: 1 })).toBe(3);
  });

  it('supports higher orders and other variables', () => {
    expect(at('d^2/dx^2 (x^4)', { x: 1 })).toBe(12);
    expect(at('d/dq (q^2)', { q: 4 })).toBe(8);
  });

  it('supports the parenthesized (d/dx)(…) form', () => {
    expect(at('(d/dx)(x^2)', { x: 5 })).toBe(10);
  });

  it('nests', () => {
    expect(at('d/dx (d/dx (x^3))', { x: 2 })).toBe(12);
  });
});

describe('buildDefs', () => {
  const cdef = (name: string, rhs: string): Definition => ({ kind: 'const', name, rhs });
  const fdef = (name: string, params: string[], rhs: string): Definition => ({ kind: 'fn', name, params, rhs });

  it('resolves constants that depend on each other and t', () => {
    const { defs, errors } = buildDefs([cdef('a', '2'), cdef('b', 'a^2 + t')]);
    expect(errors.size).toBe(0);
    expect(evalConstEnv(defs, 3)).toEqual({ a: 2, b: 7 });
    expect(constsAnimated(defs)).toBe(true);
  });

  it('inlines functions, including calls to other functions', () => {
    const { defs, errors } = buildDefs([
      fdef('f', ['x'], 'x^2 + c'),
      fdef('g', ['x'], 'f(x) + 1'),
      cdef('c', '3'),
    ]);
    expect(errors.size).toBe(0);
    const e = resolveExpr(parseExpr('g(2)', new Set(['g'])), n => defs.fns.get(n));
    expect(evaluate(e, { c: 3 })).toBe(8);
  });

  it('differentiates through function definitions', () => {
    const { defs, errors } = buildDefs([
      fdef('f', ['x'], 'sin(x)'),
      fdef('g', ['x'], 'd/dx f(x)'),
    ]);
    expect(errors.size).toBe(0);
    const e = resolveExpr(parseExpr('g(0)', new Set(['g'])), n => defs.fns.get(n));
    expect(evaluate(e, {})).toBe(1);
  });

  it('rejects cycles', () => {
    const consts = buildDefs([cdef('a', 'b'), cdef('b', 'a')]);
    expect(consts.errors.get('a')).toMatch(/itself/);
    expect(consts.errors.get('b')).toMatch(/itself/);
    expect(consts.defs.consts.size).toBe(0);

    const fns = buildDefs([fdef('f', ['x'], 'f(x) + 1')]);
    expect(fns.errors.get('f')).toMatch(/itself/);
  });

  it('turns x/y-dependent definitions into coordinate fields, not constants', () => {
    const { errors, defs } = buildDefs([cdef('a', 'x + 1')]);
    expect(errors.size).toBe(0);
    expect(defs.consts.size).toBe(0);
    expect(defs.fields.has('a')).toBe(true);
  });

  it('rejects constants that depend on other plot variables', () => {
    const { errors, defs } = buildDefs([cdef('a', 'z + 1')]);
    expect(errors.get('a')).toMatch(/found z/);
    expect(defs.consts.size).toBe(0);
  });

  it('checks arity when inlining', () => {
    const { defs } = buildDefs([fdef('f', ['a', 'b'], 'a + b')]);
    expect(() => resolveExpr(parseExpr('f(1)', new Set(['f'])), n => defs.fns.get(n)))
      .toThrow(/2 arguments/);
  });
});

describe('classify with defined constants', () => {
  it('turns constants into u_ uniforms and reports them as params', () => {
    const cls = classify(resolve('y = a x^2'), new Set(['a']));
    expect(cls.params).toEqual(['a']);
    expect(cls.plot).toMatchObject({ type: 'implicit2d' });
    expect((cls.plot as { field: string }).field).toContain('u_a');
  });

  it('suggests a slider for unknown single names', () => {
    expect(() => classify(resolve('y = k x'))).toThrow(/slider/);
    expect(() => classify(resolve('y = d x'))).toThrow(/d\/dx/);
  });

  it('keeps original names for CPU-evaluated plots', () => {
    const cls = classify(resolve('(a, 2a)'), new Set(['a']));
    expect(cls.params).toEqual(['a']);
    const plot = cls.plot as { type: 'point'; coords: import('./expr.ts').Expr[] };
    expect(plot.type).toBe('point');
    expect(evaluate(plot.coords[1], { a: 3 })).toBe(6);
  });
});
