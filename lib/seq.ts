/**
 * Sequences and recurrences.
 *
 * - `a_n = 1/n^2` is an explicit sequence: dots at integer abscissae
 *   (n = 0, 1, 2, …; non-finite terms are skipped). The UI offers a
 *   partial-sum toggle that plots S_N = Σ a_n instead.
 * - `a_{n+1} = r a_n (1 - a_n)` (also `a_(n+1)`) is a recurrence. With no
 *   other free variables it draws a cobweb diagram: the curve y = f(x), the
 *   diagonal y = x, and the iterated path from the seed. With `x` free in the
 *   right side, x becomes the parameter axis and the plot is the orbit
 *   diagram (e.g. the logistic bifurcation for x a_n (1 - a_n)).
 * - The seed is the constant `a_0` when defined (sliders work), else 1/2.
 *
 * The whole subscripted symbol (`a_n`) is one token, so these rows are
 * recognized by regex before definition scanning, like defs.ts does.
 */
import { compileTyped, usesComplex } from './complex.ts';
import { type GetFn, RESERVED, type ResolveOpts, resolveExpr } from './defs.ts';
import { type Expr, freeVars, parseExpr, substVars } from './expr.ts';
import type { Classified } from './plot.ts';

export interface SeqScan {
  /** True for a_{n+1} = … (recurrence); false for a_n = … (explicit term). */
  rec: boolean;
  name: string;
  index: string;
  rhs: string;
}

const SEQ_RE = /^\s*([A-Za-z])_([A-Za-z])\s*=(?!=)([\s\S]+)$/;
const REC_RE = /^\s*([A-Za-z])_(?:\{\s*([A-Za-z])\s*\+\s*1\s*\}|\(\s*([A-Za-z])\s*\+\s*1\s*\))\s*=(?!=)([\s\S]+)$/;

/** Indices that read as a sequence on sight, so `a_n = 5` is the constant
 *  sequence rather than a constant named a_n. */
const SEQ_INDICES = new Set(['n', 'k', 'm']);

/** The index as a standalone identifier in the term: `a_j = 1/j^2` is a
 *  sequence, but `T_c = 300` and `k_B = 1.38` are subscripted constants. */
const usesIndex = (rhs: string, index: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9_])${index}(?![A-Za-z0-9_])`).test(rhs);

/** Detect a sequence/recurrence row before definition scanning. */
export function scanSeqRec(text: string): SeqScan | null {
  let m = REC_RE.exec(text);
  if (m) return { rec: true, name: m[1], index: m[2] ?? m[3], rhs: m[4] };
  m = SEQ_RE.exec(text);
  if (m) {
    // Every letter_letter row used to be a sequence, which stole the
    // subscripted constants physics and chemistry are written with (T_c,
    // k_B, v_x). Require a conventional index or one the term actually uses.
    const [, name, index, rhs] = m;
    if (SEQ_INDICES.has(index) || (!RESERVED.has(index) && usesIndex(rhs, index))) {
      return { rec: false, name, index, rhs };
    }
  }
  return null;
}

export function classifySeqRec(
  scan: SeqScan,
  fnNames: ReadonlySet<string>,
  getFn: GetFn,
  constNames: ReadonlySet<string>,
  ropts: ResolveOpts = {},
): Classified {
  const { name, index, rhs } = scan;
  if (RESERVED.has(index)) {
    throw new Error(`"${index}" is reserved; index sequences with n, k, or m.`);
  }
  // Σ/Π in the term expand here like anywhere else, so a_n = sum(k=1..N, k^n)
  // works — the bounds must still be constants, since expansion is static.
  const parsed = resolveExpr(parseExpr(rhs, fnNames), getFn, ropts);
  if (usesComplex(parsed)) throw new Error('Sequences are real-valued; use re(…) or im(…).');

  const recVar = `${name}_${index}`;
  const vars = freeVars(parsed);
  const params: string[] = [];
  for (const v of [...vars]) {
    if (constNames.has(v)) {
      params.push(v);
      vars.delete(v);
    }
  }
  const animated = vars.delete('t');

  // The seed constant (a_0), when the user defined one. Listed in params so
  // slider drags and animated definitions re-render, though it reaches the
  // renderers as a dedicated seed value rather than through the field.
  const a0Name = constNames.has(`${name}_0`) ? `${name}_0` : undefined;

  if (!scan.rec) {
    vars.delete(index);
    for (const v of vars) {
      throw new Error(`A sequence term may only use ${index}, t, and constants (found ${v}).`);
    }
    params.sort();
    return { plot: { type: 'sequence', term: parsed, index }, animated, needs3D: false, params };
  }

  const bifurcation = vars.delete('x');
  vars.delete(recVar);
  if (vars.has('y')) throw new Error('Put the recurrence parameter on the x-axis (use x, not y).');
  if (vars.has(index)) {
    throw new Error(`A recurrence may only use ${recVar} (and x as a parameter axis), not ${index} itself.`);
  }
  for (const v of vars) {
    throw new Error(`Unknown variable: ${v}. Define "${v} = 1" to make a slider.`);
  }
  if (a0Name) params.push(a0Name);
  params.sort();

  // GLSL sees constants as u_<name> uniforms, like classify() does.
  const g = params.length
    ? substVars(parsed, Object.fromEntries(params.map(p => [p, { kind: 'var', name: 'u_' + p } as Expr])))
    : parsed;

  if (bifurcation) {
    const field = compileTyped(substVars(g, { [recVar]: { kind: 'var', name: 'a' } })).code;
    return { plot: { type: 'bifurcation', field, a0Name }, animated, needs3D: false, params };
  }

  const curve: Expr = {
    kind: 'eq',
    l: { kind: 'var', name: 'y' },
    r: substVars(g, { [recVar]: { kind: 'var', name: 'x' } }),
  };
  return {
    plot: { type: 'cobweb', f: parsed, recVar, curveField: compileTyped(curve).code, a0Name },
    animated,
    needs3D: false,
    params,
  };
}
