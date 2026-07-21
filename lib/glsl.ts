/**
 * Compile a symbolic Expr to a GLSL expression (float-valued).
 *
 * An equation l = r compiles to the scalar field F = l - r; the graph is the
 * zero set of F, which the renderers extract in a fragment shader.
 */
import type { Expr } from './expr.ts';

export const FN_GLSL: Record<string, string> = {
  ln: 'log',
  log: 'eq_log10',
  atan2: 'atan',
  round: 'eq_round',
  sech: 'eq_sech',
  fract: 'fract',
};

/** Helper functions some expressions need; prepend once to the shader. */
export const GLSL_PRELUDE = `
float eq_log10(float x) { return log(x) * 0.4342944819032518; }
float eq_round(float x) { return floor(x + 0.5); }
float eq_sech(float x) { return 1.0 / cosh(x); }
float eq_pow(float a, float b) {
  // Support negative bases for integer exponents (e.g. (-2)^3).
  if (a >= 0.0) return pow(a, b);
  float bi = floor(b + 0.5);
  if (abs(b - bi) < 1e-6) {
    float m = pow(-a, b);
    return mod(bi, 2.0) < 0.5 ? m : -m;
  }
  return sqrt(-1.0); // NaN: undefined for negative base, fractional exponent
}
// Complex arithmetic on vec2(re, im).
vec2 c_mul(vec2 a, vec2 b) { return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 c_div(vec2 a, vec2 b) { return vec2(a.x*b.x + a.y*b.y, a.y*b.x - a.x*b.y) / dot(b, b); }
vec2 c_ln(vec2 z) { return vec2(0.5 * log(dot(z, z)), atan(z.y, z.x)); }
vec2 c_exp(vec2 z) { return exp(z.x) * vec2(cos(z.y), sin(z.y)); }
vec2 c_pow(vec2 a, vec2 b) { return c_exp(c_mul(b, c_ln(a))); }
vec2 c_sqrt(vec2 z) {
  float r = length(z);
  return vec2(sqrt(0.5 * (r + z.x)), sign(z.y) * sqrt(0.5 * (r - z.x)));
}
vec2 c_log10(vec2 z) { return c_ln(z) * 0.4342944819032518; }
vec2 c_sin(vec2 z) { return vec2(sin(z.x) * cosh(z.y), cos(z.x) * sinh(z.y)); }
vec2 c_cos(vec2 z) { return vec2(cos(z.x) * cosh(z.y), -sin(z.x) * sinh(z.y)); }
vec2 c_tan(vec2 z) { return c_div(c_sin(z), c_cos(z)); }
vec2 c_sinh(vec2 z) { return vec2(sinh(z.x) * cos(z.y), cosh(z.x) * sin(z.y)); }
vec2 c_cosh(vec2 z) { return vec2(cosh(z.x) * cos(z.y), sinh(z.x) * sin(z.y)); }
vec2 c_tanh(vec2 z) { return c_div(c_sinh(z), c_cosh(z)); }
`;

function fmt(value: number): string {
  if (!isFinite(value)) throw new Error(`Cannot compile non-finite constant: ${value}`);
  const s = String(value);
  return /[.e]/.test(s) ? s.replace('e', 'E') : `${s}.0`;
}

/**
 * Emit a GLSL float expression. Free variables compile to their own names,
 * so the caller must declare/provide them (e.g. as function parameters).
 */
export function toGLSL(e: Expr): string {
  switch (e.kind) {
    case 'num': return fmt(e.value);
    case 'var': return e.name;
    case 'neg': return `(-${toGLSL(e.a)})`;
    case 'bin': {
      const a = toGLSL(e.a);
      const b = toGLSL(e.b);
      if (e.op === '^') {
        if (e.b.kind === 'num' && Number.isInteger(e.b.value) && e.b.value >= 1 && e.b.value <= 8) {
          // Small integer powers: expand to products (fast, exact for negative bases).
          return `(${Array.from({ length: e.b.value }, () => a).join('*')})`;
        }
        return `eq_pow(${a}, ${b})`;
      }
      return `(${a} ${e.op} ${b})`;
    }
    case 'call': {
      const name = FN_GLSL[e.name] ?? e.name;
      return `${name}(${e.args.map(toGLSL).join(', ')})`;
    }
    case 'eq':
      return `(${toGLSL(e.l)} - (${toGLSL(e.r)}))`;
    case 'ineq':
      throw new Error('Inequality in scalar context.');
    case 'vec':
      throw new Error('Vector in scalar context.');
  }
}
