/**
 * Classify a parsed expression into a plot type, mirroring the old
 * equation.io renderable dispatcher:
 *
 * - "l = r" → implicit curve (2D) or implicit surface (3D when z appears)
 * - bare scalar in x → treated as y = expr
 * - bare scalar in x,y → 2D scalar field (density)
 * - vector literal with no free vars → a point
 * - vector with free u (and v) → parametric curve (u) / surface (u,v), u,v ∈ (0,1)
 * - t is always allowed and means "animated": bound to seconds since start
 */
import { compileTyped, usesComplex } from './complex.ts';
import { diff } from './diff.ts';
import { type Expr, freeVars } from './expr.ts';
import { toGLSL } from './glsl.ts';

export type Plot =
  | { type: 'implicit2d'; field: string }
  | { type: 'scalar2d'; field: string }
  /** grad: symbolic ∇F for shading normals; absent → finite differences. */
  | { type: 'implicit3d'; field: string; grad?: [string, string, string] }
  /** Complex-valued f(x+iy): level curves of im(f) (field lines) and re(f) (equipotentials). */
  | { type: 'complex2d'; field: string }
  | { type: 'point'; dim: 2 | 3; coords: Expr[] }
  | { type: 'pcurve'; dim: 2 | 3; comps: Expr[] }
  /** du/dv: symbolic tangents ∂P/∂u, ∂P/∂v for lighting; absent → finite differences. */
  | { type: 'psurface'; comps: [string, string, string]; du?: [string, string, string]; dv?: [string, string, string] };

/** Symbolically differentiate each component; undefined if any is non-smooth. */
function tryGrad(exprs: Expr[], v: string): [string, string, string] | undefined {
  try {
    const out = exprs.map(c => toGLSL(diff(c, v)));
    return out as [string, string, string];
  } catch {
    return undefined;
  }
}

export interface Classified {
  plot: Plot;
  animated: boolean;
  needs3D: boolean;
}

const SPACE_VARS = new Set(['x', 'y', 'z']);
const PARAM_VARS = new Set(['u', 'v']);

export function classify(expr: Expr): Classified {
  const vars = freeVars(expr);
  vars.delete('i');
  if (vars.delete('w')) { vars.add('x'); vars.add('y'); }
  for (const v of vars) {
    if (!SPACE_VARS.has(v) && !PARAM_VARS.has(v) && v !== 't') {
      throw new Error(`Unknown variable: ${v}`);
    }
  }
  const animated = vars.has('t');
  const hasParam = vars.has('u') || vars.has('v');
  const hasSpace = vars.has('x') || vars.has('y') || vars.has('z');
  if (hasParam && hasSpace) throw new Error('Cannot mix u/v with x/y/z.');
  if (usesComplex(expr) && (vars.has('z') || hasParam)) {
    throw new Error('Complex expressions plot in 2D only (x, y, w).');
  }

  const done = (plot: Plot): Classified => ({
    plot,
    animated,
    needs3D: plot.type === 'implicit3d' || plot.type === 'psurface'
      || ((plot.type === 'point' || plot.type === 'pcurve') && plot.dim === 3),
  });

  if (expr.kind === 'vec') {
    if (usesComplex(expr)) throw new Error('Complex values are not supported in vectors.');
    const dim = expr.items.length as 2 | 3;
    if (vars.has('v') && !vars.has('u')) throw new Error('Parametric surfaces use u (and v).');
    if (vars.has('u') && vars.has('v')) {
      if (dim !== 3) throw new Error('A parametric surface needs 3 components.');
      const [a, b, c] = expr.items;
      return done({
        type: 'psurface',
        comps: [toGLSL(a), toGLSL(b), toGLSL(c)],
        du: tryGrad(expr.items, 'u'),
        dv: tryGrad(expr.items, 'v'),
      });
    }
    if (vars.has('u')) return done({ type: 'pcurve', dim, comps: expr.items });
    return done({ type: 'point', dim, coords: expr.items });
  }

  if (hasParam) throw new Error('u/v need a vector expression like (cos(u), sin(u), v).');

  const gradOf = (f: Expr): [string, string, string] | undefined => {
    try {
      return ['x', 'y', 'z'].map(v => toGLSL(diff(f, v))) as [string, string, string];
    } catch {
      return undefined;
    }
  };

  if (expr.kind === 'eq') {
    // compileTyped rejects equations that are still complex-valued; re()/im()
    // wrapped sides come out real and flow through the implicit paths.
    const field = compileTyped(expr).code;
    return done(vars.has('z')
      ? { type: 'implicit3d', field, grad: gradOf(expr) }
      : { type: 'implicit2d', field });
  }

  // Bare scalar expression.
  const compiled = compileTyped(expr);
  if (compiled.type === 'complex') return done({ type: 'complex2d', field: compiled.code });
  if (vars.has('z')) return done({ type: 'implicit3d', field: compiled.code, grad: gradOf(expr) });
  if (vars.has('y')) return done({ type: 'scalar2d', field: compiled.code });
  // Only x (or constants / t): plot as y = expr.
  const asY: Expr = { kind: 'eq', l: { kind: 'var', name: 'y' }, r: expr };
  return done({ type: 'implicit2d', field: compileTyped(asY).code });
}
