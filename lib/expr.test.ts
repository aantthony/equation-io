import { describe, expect, it } from 'vitest';
import { evaluate, Expr, freeVars, parseExpr } from './expr.ts';
import { toGLSL } from './glsl.ts';

function evalExpr(e: Expr, env: Record<string, number>): number {
  switch (e.kind) {
    case 'num': return e.value;
    case 'var': {
      if (!(e.name in env)) throw new Error(`Unbound: ${e.name}`);
      return env[e.name];
    }
    case 'neg': return -evalExpr(e.a, env);
    case 'bin': {
      const a = evalExpr(e.a, env);
      const b = evalExpr(e.b, env);
      switch (e.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '^': return Math.pow(a, b);
      }
    }
    case 'call': {
      const args = e.args.map(a => evalExpr(a, env));
      const fns: Record<string, (...xs: number[]) => number> = {
        sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt,
        abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10,
        min: Math.min, max: Math.max, atan: Math.atan, floor: Math.floor,
      };
      return fns[e.name](...args);
    }
    case 'eq': return evalExpr(e.l, env) - evalExpr(e.r, env);
  }
}

const evl = (s: string, env: Record<string, number> = {}) => evalExpr(parseExpr(s), env);

describe('parseExpr', () => {
  it('parses arithmetic with precedence', () => {
    expect(evl('1+2*3')).toBe(7);
    expect(evl('(1+2)*3')).toBe(9);
    expect(evl('2^10')).toBe(1024);
    expect(evl('2^3^2')).toBe(512); // right associative
    expect(evl('10-2-3')).toBe(5);
    expect(evl('12/2/3')).toBe(2);
  });

  it('handles unary minus', () => {
    expect(evl('-3')).toBe(-3);
    expect(evl('-x^2', { x: 2 })).toBe(-4);
    expect(evl('2*-3')).toBe(-6);
    expect(evl('x^-1', { x: 4 })).toBe(0.25);
    expect(evl('-(1+2)')).toBe(-3);
  });

  it('handles implicit multiplication', () => {
    expect(evl('2x', { x: 5 })).toBe(10);
    expect(evl('2x^2', { x: 3 })).toBe(18);
    expect(evl('x(x+1)', { x: 3 })).toBe(12);
    expect(evl('(x+1)(x-1)', { x: 3 })).toBe(8);
    expect(evl('2pi')).toBeCloseTo(Math.PI * 2);
  });

  it('parses function calls', () => {
    expect(evl('sin(0)')).toBe(0);
    expect(evl('cos(0)')).toBe(1);
    expect(evl('sin(x)^2', { x: 2 })).toBeCloseTo(Math.sin(2) ** 2);
    expect(evl('max(1, 2)')).toBe(2);
    expect(evl('min(1+1, 5, 0-3)')).toBe(-3);
    expect(evl('2sin(x)', { x: 1 })).toBeCloseTo(2 * Math.sin(1));
  });

  it('parses decimals', () => {
    expect(evl('1.5+2.25')).toBe(3.75);
    expect(evl('0.5x', { x: 4 })).toBe(2);
  });

  it('parses equations as l - r', () => {
    const e = parseExpr('y = x^2');
    expect(e.kind).toBe('eq');
    expect(evalExpr(e, { x: 3, y: 9 })).toBe(0);
    expect(evalExpr(e, { x: 3, y: 10 })).toBe(1);
  });

  it('collects free variables', () => {
    expect([...freeVars(parseExpr('x^2+y^2=1'))].sort()).toEqual(['x', 'y']);
    expect([...freeVars(parseExpr('z = sin(x)cos(y)'))].sort()).toEqual(['x', 'y', 'z']);
    expect([...freeVars(parseExpr('sin(x)'))]).toEqual(['x']);
    expect([...freeVars(parseExpr('2pi'))]).toEqual([]);
  });
});

describe('toGLSL', () => {
  it('emits float literals', () => {
    expect(toGLSL(parseExpr('1+2'))).toBe('(1.0 + 2.0)');
    expect(toGLSL(parseExpr('1.5'))).toBe('1.5');
  });

  it('expands small integer powers', () => {
    expect(toGLSL(parseExpr('x^2'))).toBe('(x*x)');
    expect(toGLSL(parseExpr('x^y'))).toBe('eq_pow(x, y)');
  });

  it('maps function names', () => {
    expect(toGLSL(parseExpr('ln(x)'))).toBe('log(x)');
    expect(toGLSL(parseExpr('sin(x)'))).toBe('sin(x)');
  });

  it('compiles equations to a difference', () => {
    expect(toGLSL(parseExpr('y=x'))).toBe('(y - (x))');
  });
});

describe('absolute value bars', () => {
  const ev = (s: string, env: Record<string, number> = {}) => evaluate(parseExpr(s), env);

  it('parses |x| as abs(x)', () => {
    expect(ev('|x|', { x: -3 })).toBe(3);
    expect(ev('|x-5|', { x: 2 })).toBe(3);
  });

  it('multiplies implicitly around bars', () => {
    expect(ev('2|x|', { x: -3 })).toBe(6);
    expect(ev('|x||y|', { x: -2, y: -3 })).toBe(6);
    expect(ev('|x|y', { x: -2, y: 3 })).toBe(6);
  });

  it('handles nested bars', () => {
    expect(ev('||x|-4|', { x: 1 })).toBe(3);
    expect(ev('|x-|y||', { x: 1, y: -4 })).toBe(3);
  });

  it('compiles to GLSL abs', () => {
    expect(toGLSL(parseExpr('|x|+1'))).toBe('(abs(x) + 1.0)');
  });
});

describe('hyperbolic functions', () => {
  const ev = (s: string, env: Record<string, number> = {}) => evaluate(parseExpr(s), env);

  it('evaluates sech and inverse hyperbolics', () => {
    expect(ev('sech(0)')).toBe(1);
    expect(ev('sech(x)', { x: 2 })).toBeCloseTo(1 / Math.cosh(2));
    expect(ev('asinh(x)', { x: Math.sinh(1.5) })).toBeCloseTo(1.5);
    expect(ev('acosh(x)', { x: Math.cosh(1.5) })).toBeCloseTo(1.5);
    expect(ev('atanh(x)', { x: Math.tanh(0.5) })).toBeCloseTo(0.5);
  });

  it('compiles sech via helper and inverse hyperbolics to builtins', () => {
    expect(toGLSL(parseExpr('sech(x)'))).toBe('eq_sech(x)');
    expect(toGLSL(parseExpr('asinh(x)'))).toBe('asinh(x)');
    expect(toGLSL(parseExpr('acosh(x)'))).toBe('acosh(x)');
    expect(toGLSL(parseExpr('atanh(x)'))).toBe('atanh(x)');
  });
});
