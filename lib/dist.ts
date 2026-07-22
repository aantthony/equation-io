/**
 * Probability distribution rows.
 *
 * - `X ~ Normal(mean, sd)` declares a random variable; the row plots its
 *   density y = normalpdf(x, mean, sd). Parameters may reference constants
 *   (sliders) and t, so `X ~ Normal(0, a)` responds to the slider live.
 * - `P(X < b)`, `P(X > b)`, `P(a < X < b)` shade the area under X's density
 *   over the given range (reusing the inequality-region pipeline) and report
 *   the numeric probability via the normal CDF.
 */
import { type Expr, erf, evaluate, freeVars, parseExpr } from './expr.ts';

export interface DistDef {
  /** Random-variable name (the row `name ~ Normal(…)`). */
  name: string;
  mean: Expr;
  sd: Expr;
}

const TILDE_RE = /^\s*([A-Za-z_]\w*)\s*~\s*([\s\S]+)$/;
const DIST_RE = /^\s*([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*$/;
const PROB_RE = /^\s*P\s*\(([\s\S]+)\)\s*$/;

/** Detect a `name ~ rhs` row before parsing ('~' is not an expression token). */
export function scanDistribution(text: string): { name: string; rhs: string } | null {
  const m = TILDE_RE.exec(text);
  return m ? { name: m[1], rhs: m[2] } : null;
}

/** Parse the right side of `name ~ …`. Throws with a row-friendly message. */
export function parseDistribution(name: string, rhs: string, fnNames: ReadonlySet<string>): DistDef {
  const m = DIST_RE.exec(rhs);
  if (!m) throw new Error('Expected a distribution like Normal(0, 1).');
  const dist = m[1].toLowerCase();
  if (dist !== 'normal' && dist !== 'n') {
    throw new Error(`Unknown distribution: ${m[1]}. Try Normal(mean, sd).`);
  }
  let args: Expr;
  try {
    args = parseExpr(`(${m[2]})`, fnNames);
  } catch (e) {
    if (e instanceof Error && /vector components/.test(e.message)) {
      throw new Error('Normal takes 2 arguments: Normal(mean, sd).');
    }
    throw e;
  }
  if (args.kind !== 'vec' || args.items.length !== 2) {
    throw new Error('Normal takes 2 arguments: Normal(mean, sd).');
  }
  return { name, mean: args.items[0], sd: args.items[1] };
}

const v = (name: string): Expr => ({ kind: 'var', name });
const pdfCall = (d: DistDef): Expr => ({ kind: 'call', name: 'normalpdf', args: [v('x'), d.mean, d.sd] });

/** The density curve for a random variable: y = normalpdf(x, mean, sd). */
export function densityExpr(d: DistDef): Expr {
  return { kind: 'eq', l: v('y'), r: pdfCall(d) };
}

/** The inner text of a `P(…)` row, or null if the row has another shape. */
export function matchProbability(text: string): string | null {
  const m = PROB_RE.exec(text);
  return m ? m[1] : null;
}

export interface Probability {
  dist: DistDef;
  lo?: Expr;
  hi?: Expr;
}

/** Interpret a parsed P(…) body against the declared random variables. */
export function toProbability(e: Expr, dists: ReadonlyMap<string, DistDef>): Probability {
  const chain: Array<Expr & { kind: 'ineq' }> = [];
  let node = e;
  while (node.kind === 'ineq') {
    chain.unshift(node);
    node = node.l;
  }
  if (!chain.length) throw new Error('P(…) expects an inequality like P(X < 2).');
  const comps = chain.map((c, k) => ({ op: c.op, l: k === 0 ? c.l : chain[k - 1].r, r: c.r }));
  if (new Set(comps.map(c => c.op[0])).size > 1) {
    throw new Error('Chained inequalities must point the same way.');
  }
  // Normalize to ascending order so the terms read lo … X … hi.
  const asc = comps.map(c => (c.op[0] === '<' ? { l: c.l, r: c.r } : { l: c.r, r: c.l }));
  if (comps[0].op[0] === '>') asc.reverse();
  const terms = [asc[0].l, ...asc.map(c => c.r)];

  const idx = terms.findIndex(t => t.kind === 'var' && dists.has(t.name));
  if (idx < 0) {
    throw new Error('P(…) must reference a random variable, e.g. X ~ Normal(0, 1) then P(X < 2).');
  }
  terms.forEach((t, k) => {
    if (k === idx) return;
    if (Math.abs(k - idx) > 1) throw new Error('P(…) takes at most two bounds around the variable.');
    for (const name of freeVars(t)) {
      if (dists.has(name)) throw new Error('Only one random variable may appear in P(…).');
      if (/^[xyzuvw]$/.test(name)) throw new Error(`P(…) bounds cannot use ${name}.`);
    }
  });
  const dist = dists.get((terms[idx] as Expr & { kind: 'var' }).name)!;
  return {
    dist,
    lo: idx > 0 ? terms[idx - 1] : undefined,
    hi: idx < terms.length - 1 ? terms[idx + 1] : undefined,
  };
}

/**
 * The shaded region for a probability: the area between the x-axis and the
 * density, clipped to the bounds. Each part is normalized to F < 0 and
 * combined with max() (intersection), the same shape classify() produces for
 * inequality chains; '<=' gives the region a drawn outline.
 */
export function regionExpr(p: Probability): Expr {
  const x = v('x');
  const y = v('y');
  let f: Expr = { kind: 'bin', op: '-', a: y, b: pdfCall(p.dist) }; // y < pdf(x)
  const parts: Expr[] = [{ kind: 'neg', a: y }]; // 0 < y
  if (p.lo) parts.push({ kind: 'bin', op: '-', a: p.lo, b: x }); // lo < x
  if (p.hi) parts.push({ kind: 'bin', op: '-', a: x, b: p.hi }); // x < hi
  for (const part of parts) f = { kind: 'call', name: 'max', args: [f, part] };
  return { kind: 'ineq', op: '<=', l: f, r: { kind: 'num', value: 0 } };
}

/** Numeric value of the probability under the given constant environment. */
export function probabilityValue(p: Probability, env: Record<string, number>): number {
  const mean = evaluate(p.dist.mean, env);
  const sd = evaluate(p.dist.sd, env);
  if (!(sd > 0)) return NaN;
  const cdf = (e: Expr) => 0.5 * (1 + erf((evaluate(e, env) - mean) / (sd * Math.SQRT2)));
  return (p.hi ? cdf(p.hi) : 1) - (p.lo ? cdf(p.lo) : 0);
}
