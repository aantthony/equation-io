import { describe, expect, it } from 'vitest';
import { compileTyped, usesComplex } from './complex.js';
import { parseExpr } from './expr.js';
import { classify } from './plot.js';

const typed = (s: string) => compileTyped(parseExpr(s));

describe('compileTyped', () => {
  it('leaves real expressions real', () => {
    expect(typed('x^2 + y')).toEqual({ type: 'real', code: expect.stringContaining('x') });
    expect(typed('sin(x)').type).toBe('real');
  });

  it('detects complex expressions', () => {
    expect(usesComplex(parseExpr('ln(w)'))).toBe(true);
    expect(usesComplex(parseExpr('x + i y'))).toBe(true);
    expect(usesComplex(parseExpr('x + y'))).toBe(false);
  });

  it('compiles complex arithmetic to vec2 code', () => {
    const c = typed('ln(w - 1) - ln(w + 1)');
    expect(c.type).toBe('complex');
    expect(c.code).toContain('c_ln');
    expect(c.code).toContain('vec2(x, y)');
  });

  it('compiles i as the imaginary unit', () => {
    const c = typed('x + i y');
    expect(c.type).toBe('complex');
    expect(c.code).toContain('c_mul');
  });

  it('re/im/arg/abs take complex back to real', () => {
    expect(typed('re(ln(w))').type).toBe('real');
    expect(typed('im(w^2)').type).toBe('real');
    expect(typed('arg(w)').type).toBe('real');
    expect(typed('abs(w)')).toEqual({ type: 'real', code: 'length(vec2(x, y))' });
  });

  it('conj stays complex', () => {
    expect(typed('conj(w)').type).toBe('complex');
  });

  it('rejects complex equations without re/im', () => {
    expect(() => typed('w = 1')).toThrow(/re\(/);
  });
});

describe('classify (complex)', () => {
  it('routes complex-valued expressions to complex2d', () => {
    const c = classify(parseExpr('ln(w-1) - ln(w+1)'));
    expect(c.plot.type).toBe('complex2d');
    expect(c.needs3D).toBe(false);
  });

  it('routes re/im equations to implicit curves', () => {
    expect(classify(parseExpr('im(ln(w)) = 1')).plot.type).toBe('implicit2d');
    expect(classify(parseExpr('abs(w) = 2')).plot.type).toBe('implicit2d');
  });

  it('rejects complex in 3D or parametric contexts', () => {
    expect(() => classify(parseExpr('z + i'))).toThrow(/2D only/);
    expect(() => classify(parseExpr('(i u, 1, 1)'))).toThrow(/2D only/);
    expect(() => classify(parseExpr('(i x, 1, 1)'))).toThrow(/vector/i);
  });
});
