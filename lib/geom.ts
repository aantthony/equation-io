/**
 * Point (2D vector) values and geometry statements.
 *
 * A constant whose right-hand side is a pair — `A = (0, 0)`, `C = B + D` —
 * is a named point. Point arithmetic (±, scalar ×/÷, dot, cross, perp,
 * midpoint, unit, |P|) is lowered here into componentwise scalar expressions,
 * with a point name `A` expanding to the derived constants `A_x`, `A_y`.
 * Lowering runs after resolveExpr (functions inlined, Σ expanded) and before
 * classify, so everything downstream — GLSL, evaluate, diff — still sees only
 * scalars, and points stay symbolic all the way to uniforms (dragging a point
 * never recompiles a shader).
 *
 * The statement forms segment/polygon/square desugar to an internal
 * '[polygon]' call holding a flat scalar vertex list (classify turns it into
 * a CPU-drawn polygon plot); circle desugars to an ordinary implicit equation.
 *
 * Tuple literals inside a call arrive flattened (the parser folds commas into
 * one argument list), so `polygon((0,0), A)` reaches us as [0, 0, A]; adjacent
 * scalar arguments re-pair into points.
 */
import { add, div, mul, neg, sub } from './diff.ts';
import type { Expr } from './expr.ts';

/** Whole-statement geometry forms (like SPECIAL_FORMS, they never nest). */
export const GEOM_STATEMENTS = new Set(['segment', 'polygon', 'square', 'circle']);

/** The derived scalar constants a point named `name` expands to. */
export const pointComps = (name: string): [string, string] => [name + '_x', name + '_y'];

type LV = { vec: false; e: Expr } | { vec: true; x: Expr; y: Expr };

const sc = (e: Expr): LV => ({ vec: false, e });
const vc = (x: Expr, y: Expr): LV => ({ vec: true, x, y });
const vnode = (x: Expr, y: Expr): Expr => ({ kind: 'vec', items: [x, y] });
const toExpr = (v: LV): Expr => (v.vec ? vnode(v.x, v.y) : v.e);

export type IsPoint = (name: string) => boolean;

/** Functions over points, by how many point arguments they take. */
const POINT_FNS: Record<string, number> = { dot: 2, cross: 2, midpoint: 2, perp: 1, unit: 1 };

const sq = (e: Expr): Expr => mul(e, e);
const lenOf = (x: Expr, y: Expr): Expr => ({ kind: 'call', name: 'sqrt', args: [add(sq(x), sq(y))] });

/** Re-pair a lowered argument list into points: vec args pass through, and
 *  adjacent scalar args (a flattened tuple literal) join into one point. */
function pairPoints(name: string, args: LV[]): Array<[Expr, Expr]> {
  const out: Array<[Expr, Expr]> = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.vec) {
      out.push([a.x, a.y]);
      continue;
    }
    const b = args[i + 1];
    if (!b || b.vec) {
      throw new Error(`${name} takes points — write ${name}(A, B) with A = (0, 0) defined above.`);
    }
    out.push([a.e, b.e]);
    i++;
  }
  return out;
}

function lower(e: Expr, isPoint: IsPoint): LV {
  const lo = (n: Expr): LV => lower(n, isPoint);
  switch (e.kind) {
    case 'num': return sc(e);
    case 'var': {
      if (!isPoint(e.name)) return sc(e);
      const [cx, cy] = pointComps(e.name);
      return vc({ kind: 'var', name: cx }, { kind: 'var', name: cy });
    }
    case 'neg': {
      const a = lo(e.a);
      if (a.vec) return vc(neg(a.x), neg(a.y));
      return a.e === e.a ? sc(e) : sc({ kind: 'neg', a: a.e });
    }
    case 'bin': {
      const a = lo(e.a);
      const b = lo(e.b);
      if (!a.vec && !b.vec) {
        // Untouched scalar subtrees pass through unchanged, so existing plots
        // keep their exact GLSL (and shader cache keys).
        if (a.e === e.a && b.e === e.b) return sc(e);
        return sc({ kind: 'bin', op: e.op, a: a.e, b: b.e });
      }
      switch (e.op) {
        case '+':
        case '-':
          if (a.vec && b.vec) {
            const f = e.op === '+' ? add : sub;
            return vc(f(a.x, b.x), f(a.y, b.y));
          }
          throw new Error(`Cannot ${e.op === '+' ? 'add' : 'subtract'} a point and a number.`);
        case '*':
          if (a.vec && b.vec) throw new Error('Use dot(A, B) or cross(A, B) to multiply points.');
          if (a.vec && !b.vec) return vc(mul(a.x, b.e), mul(a.y, b.e));
          if (!a.vec && b.vec) return vc(mul(a.e, b.x), mul(a.e, b.y));
          break;
        case '/':
          if (a.vec && !b.vec) return vc(div(a.x, b.e), div(a.y, b.e));
          throw new Error('Cannot divide by a point.');
        case '^':
          throw new Error('Cannot raise a point to a power — |A| is its length.');
      }
      break;
    }
    case 'call': {
      if (GEOM_STATEMENTS.has(e.name)) throw new Error(`${e.name}(…) must be a whole statement.`);
      const args = e.args.map(lo);
      const nPts = POINT_FNS[e.name];
      if (nPts !== undefined) {
        const pts = pairPoints(e.name, args);
        if (pts.length !== nPts) {
          throw new Error(`${e.name} takes ${nPts} point${nPts === 1 ? '' : 's'}.`);
        }
        const [ax, ay] = pts[0];
        switch (e.name) {
          case 'dot': return sc(add(mul(ax, pts[1][0]), mul(ay, pts[1][1])));
          case 'cross': return sc(sub(mul(ax, pts[1][1]), mul(ay, pts[1][0])));
          case 'midpoint': return vc(div(add(ax, pts[1][0]), num2), div(add(ay, pts[1][1]), num2));
          case 'perp': return vc(neg(ay), ax);
          case 'unit': return vc(div(ax, lenOf(ax, ay)), div(ay, lenOf(ax, ay)));
        }
      }
      if (e.name === 'abs' && args.length === 1 && args[0].vec) {
        const a = args[0] as LV & { vec: true };
        return sc(lenOf(a.x, a.y));
      }
      const flatArgs: Expr[] = [];
      for (const a of args) {
        if (a.vec) throw new Error(`${e.name} is not defined for points.`);
        flatArgs.push(a.e);
      }
      if (flatArgs.every((a, k) => a === e.args[k])) return sc(e);
      return sc({ kind: 'call', name: e.name, args: flatArgs });
    }
    case 'eq': {
      const l = lo(e.l);
      const r = lo(e.r);
      if (l.vec !== r.vec) throw new Error('One side is a point and the other is a number.');
      if (!l.vec && l.e === e.l && (r as LV & { vec: false }).e === e.r) return sc(e);
      return sc({ kind: 'eq', l: toExpr(l), r: toExpr(r) });
    }
    case 'ineq': {
      const l = lo(e.l);
      const r = lo(e.r);
      if (l.vec || r.vec) throw new Error('Points cannot be compared — compare |A - B| instead.');
      if (l.e === e.l && r.e === e.r) return sc(e);
      return sc({ kind: 'ineq', op: e.op, l: l.e, r: r.e });
    }
    case 'vec': {
      const items = e.items.map(lo);
      if (items.some(a => a.vec)) {
        if (e.items.length === 2 && items.every(a => a.vec)) {
          throw new Error('A pair of points — did you mean segment(A, B)?');
        }
        throw new Error('A point cannot be a component of a vector.');
      }
      const flat = items.map(a => (a as LV & { vec: false }).e);
      if (e.items.length === 2) return vc(flat[0], flat[1]);
      // 3-component vectors (3D points, surfaces) pass through unchanged.
      if (flat.every((f, k) => f === e.items[k])) return sc(e);
      return sc({ kind: 'vec', items: flat });
    }
  }
  throw new Error('Unreachable');
}

const num2: Expr = { kind: 'num', value: 2 };
const spaceVar = (name: 'x' | 'y'): Expr => ({ kind: 'var', name });

/** '[polygon]' (closed, filled) / '[segment]' (open) with flat scalar vertices. */
const polyCall = (name: '[polygon]' | '[segment]', pts: Array<[Expr, Expr]>): Expr =>
  ({ kind: 'call', name, args: pts.flat() });

/**
 * Lower a whole statement: desugar a root-level geometry form, expand all
 * point arithmetic, and return an expression classify already understands.
 */
export function lowerGeom(e: Expr, isPoint: IsPoint): Expr {
  if (e.kind === 'call' && GEOM_STATEMENTS.has(e.name)) {
    const args = e.args.map(a => lower(a, isPoint));
    if (e.name === 'circle') {
      // circle(C, r): the trailing argument is the scalar radius.
      const r = args[args.length - 1];
      if (args.length < 2 || !r || r.vec) throw new Error('circle takes circle(center, radius).');
      const pts = pairPoints('circle', args.slice(0, -1));
      if (pts.length !== 1) throw new Error('circle takes circle(center, radius).');
      const [cx, cy] = pts[0];
      return {
        kind: 'eq',
        l: add(sq(sub(spaceVar('x'), cx)), sq(sub(spaceVar('y'), cy))),
        r: sq(r.e),
      };
    }
    const pts = pairPoints(e.name, args);
    if (e.name === 'segment') {
      if (pts.length !== 2) {
        throw new Error('segment takes two points: segment(A, B), with A = (0, 0) defined above.');
      }
      return polyCall('[segment]', pts);
    }
    if (e.name === 'square') {
      if (pts.length !== 2) throw new Error('square takes two points: square(A, B).');
      // The square erected on side A→B, on the left of the direction A→B.
      const [[ax, ay], [bx, by]] = pts;
      const px = neg(sub(by, ay)); // perp(B - A)
      const py = sub(bx, ax);
      return polyCall('[polygon]', [
        [ax, ay],
        [bx, by],
        [add(bx, px), add(by, py)],
        [add(ax, px), add(ay, py)],
      ]);
    }
    if (pts.length < 3) throw new Error('polygon needs at least 3 vertices.');
    return polyCall('[polygon]', pts);
  }
  return toExpr(lower(e, isPoint));
}
