/**
 * Small matrices — 2×2 and 3×3 — as definition-time symbolic objects.
 *
 * `M = [(a, b), (c, d)]` (rows as tuples, or nested `[[a, b], [c, d]]`, or
 * named points as rows: `R = [r1, r2]`) names a matrix. Like sums, d/dx,
 * and points, matrices vanish before anything downstream looks: det, trace,
 * the matvec `M v`, and `solve(M, v)` (Cramer's rule) all expand during
 * geometry lowering into ordinary scalar expressions. GLSL, evaluate, diff,
 * and the state integrator never see a matrix — so matrix entries can hold
 * sliders, t, or states, and `om' = solve(M, f)` integrates like any other
 * derivative.
 *
 * Cramer is exact and symbolic at these sizes; n ≥ 4 is rejected up front.
 */
import { add, div, mul, sub } from './diff.ts';
import type { Expr } from './expr.ts';

/** Row-major square matrix of scalar expressions, side 2 or 3. */
export type Mat = Expr[][];

/** Matrix lookup during lowering; null for names that are not matrices. */
export type GetMat = (name: string) => Mat | null;

const SHAPE_HINT = 'write rows of equal length: M = [(a, b), (c, d)] or [[a, b], [c, d]]';

/**
 * Read a matrix out of a lowered list literal. The list's items are rows —
 * vecs (tuples or scattered named points) or nested lists of scalars.
 * Throws on ragged or non-square shapes; a list with no row structure at
 * all (e.g. [1, 2, 3]) returns null so callers can say what a list means
 * in their context.
 */
export function matrixFromList(e: Expr): Mat | null {
  if (e.kind !== 'list' || e.items.length === 0) return null;
  const rows: Expr[][] = [];
  for (const item of e.items) {
    if (item.kind === 'vec') rows.push(item.items);
    else if (item.kind === 'list') {
      if (item.items.some(c => c.kind === 'vec' || c.kind === 'list')) {
        throw new Error(`Matrix rows hold numbers — ${SHAPE_HINT}.`);
      }
      rows.push(item.items);
    } else return null; // a flat data list, not a matrix
  }
  const n = rows.length;
  if (rows.some(r => r.length !== n) || (n !== 2 && n !== 3)) {
    throw new Error(`A matrix is 2×2 or 3×3 — ${SHAPE_HINT}.`);
  }
  return rows;
}

/** det for side 2 or 3 (cofactor expansion along the first row). */
export function detOf(m: Mat): Expr {
  if (m.length === 2) return sub(mul(m[0][0], m[1][1]), mul(m[0][1], m[1][0]));
  const minor = (r0: number, r1: number, c0: number, c1: number): Expr =>
    sub(mul(m[r0][c0], m[r1][c1]), mul(m[r0][c1], m[r1][c0]));
  return add(
    sub(mul(m[0][0], minor(1, 2, 1, 2)), mul(m[0][1], minor(1, 2, 0, 2))),
    mul(m[0][2], minor(1, 2, 0, 1)),
  );
}

export function traceOf(m: Mat): Expr {
  let s = m[0][0];
  for (let k = 1; k < m.length; k++) s = add(s, m[k][k]);
  return s;
}

/** M v, componentwise dot products. */
export function matVec(m: Mat, v: Expr[]): Expr[] {
  return m.map(row => {
    let s = mul(row[0], v[0]);
    for (let k = 1; k < v.length; k++) s = add(s, mul(row[k], v[k]));
    return s;
  });
}

/**
 * The solution of M x = v by Cramer's rule: x_i = det(M with column i
 * replaced by v) / det(M). Symbolic — a singular M yields NaN at evaluation
 * time, which the consumers already treat as "hold the last good value".
 */
export function solveVec(m: Mat, v: Expr[]): Expr[] {
  const d = detOf(m);
  return v.map((_, i) => {
    const mi = m.map((row, r) => row.map((entry, c) => (c === i ? v[r] : entry)));
    return div(detOf(mi), d);
  });
}
