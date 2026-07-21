/**
 * Complex-typed GLSL compilation.
 *
 * `i` is the imaginary unit and `w` is shorthand for x + iy, so a complex
 * potential like ln(w-1) - ln(w+1) compiles to a GLSL vec2 (re, im). Purely
 * real subtrees delegate to the scalar compiler in glsl.ts, so real plots are
 * unaffected; re()/im()/arg()/abs() take a complex value back to a real one,
 * which lets equations like im(ln(w)) = 1 flow through the implicit-curve path.
 */
import { Expr } from './expr.js';
import { FN_GLSL, toGLSL } from './glsl.js';

export type Typed = { type: 'real'; code: string } | { type: 'complex'; code: string };

/** Does this expression involve complex values anywhere? */
export function usesComplex(e: Expr): boolean {
  switch (e.kind) {
    case 'num': return false;
    case 'var': return e.name === 'i' || e.name === 'w';
    case 'neg': return usesComplex(e.a);
    case 'bin': return usesComplex(e.a) || usesComplex(e.b);
    case 'call': return e.args.some(usesComplex);
    case 'eq': return usesComplex(e.l) || usesComplex(e.r);
    case 'vec': return e.items.some(usesComplex);
  }
}

const C_FNS: Record<string, string> = {
  sin: 'c_sin', cos: 'c_cos', tan: 'c_tan',
  exp: 'c_exp', ln: 'c_ln', log: 'c_log10', sqrt: 'c_sqrt',
  sinh: 'c_sinh', cosh: 'c_cosh', tanh: 'c_tanh',
};

/** Complex-argument functions returning a real value. */
const C_TO_REAL: Record<string, (z: string) => string> = {
  abs: z => `length(${z})`,
  re: z => `(${z}).x`,
  im: z => `(${z}).y`,
  arg: z => `atan((${z}).y, (${z}).x)`,
};

function promote(v: Typed): string {
  return v.type === 'complex' ? v.code : `vec2(${v.code}, 0.0)`;
}

/** Compile an expression, inferring real vs complex type. */
export function compileTyped(e: Expr): Typed {
  if (!usesComplex(e)) {
    // re/im/arg/conj of a real value still need complex handling below.
    const touchesComplexFns = (function scan(n: Expr): boolean {
      switch (n.kind) {
        case 'call': return n.name in C_TO_REAL || n.name === 'conj' || n.args.some(scan);
        case 'bin': return scan(n.a) || scan(n.b);
        case 'neg': return scan(n.a);
        case 'eq': return scan(n.l) || scan(n.r);
        case 'vec': return n.items.some(scan);
        default: return false;
      }
    })(e);
    if (!touchesComplexFns) return { type: 'real', code: toGLSL(e) };
  }

  switch (e.kind) {
    case 'num': return { type: 'real', code: toGLSL(e) };
    case 'var':
      if (e.name === 'i') return { type: 'complex', code: 'vec2(0.0, 1.0)' };
      if (e.name === 'w') return { type: 'complex', code: 'vec2(x, y)' };
      return { type: 'real', code: e.name };
    case 'neg': {
      const a = compileTyped(e.a);
      return { type: a.type, code: `(-${a.code})` };
    }
    case 'bin': {
      const a = compileTyped(e.a);
      const b = compileTyped(e.b);
      if (a.type === 'real' && b.type === 'real') {
        if (e.op === '^') return { type: 'real', code: `eq_pow(${a.code}, ${b.code})` };
        return { type: 'real', code: `(${a.code} ${e.op} ${b.code})` };
      }
      const ca = promote(a);
      const cb = promote(b);
      switch (e.op) {
        case '+': return { type: 'complex', code: `(${ca} + ${cb})` };
        case '-': return { type: 'complex', code: `(${ca} - ${cb})` };
        case '*': return { type: 'complex', code: `c_mul(${ca}, ${cb})` };
        case '/': return { type: 'complex', code: `c_div(${ca}, ${cb})` };
        case '^': return { type: 'complex', code: `c_pow(${ca}, ${cb})` };
      }
      break;
    }
    case 'call': {
      const args = e.args.map(compileTyped);
      const anyComplex = args.some(a => a.type === 'complex');
      if (e.name === 'conj') {
        if (args.length !== 1) throw new Error('conj takes one argument.');
        const z = promote(args[0]);
        return { type: 'complex', code: `(${z} * vec2(1.0, -1.0))` };
      }
      if (e.name in C_TO_REAL && (anyComplex || e.name === 're' || e.name === 'im' || e.name === 'arg')) {
        if (args.length !== 1) throw new Error(`${e.name} takes one argument.`);
        return { type: 'real', code: C_TO_REAL[e.name](promote(args[0])) };
      }
      if (!anyComplex) {
        const name = FN_GLSL[e.name] ?? e.name;
        return { type: 'real', code: `${name}(${args.map(a => a.code).join(', ')})` };
      }
      const fn = C_FNS[e.name];
      if (!fn) throw new Error(`${e.name} is not supported for complex values.`);
      if (args.length !== 1) throw new Error(`${e.name} takes one argument.`);
      return { type: 'complex', code: `${fn}(${promote(args[0])})` };
    }
    case 'eq': {
      const l = compileTyped(e.l);
      const r = compileTyped(e.r);
      if (l.type === 'complex' || r.type === 'complex') {
        throw new Error('Complex equation: compare re(…) or im(…) instead.');
      }
      return { type: 'real', code: `(${l.code} - (${r.code}))` };
    }
    case 'vec':
      throw new Error('Vector in scalar context.');
  }
  throw new Error('Unreachable');
}
