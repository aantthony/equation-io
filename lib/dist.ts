/**
 * Probability distribution rows.
 *
 * - `X ~ Normal(mean, sd)` (also Uniform(a, b), Exponential(rate)) declares a
 *   random variable; the row plots its exact density. Parameters may reference
 *   constants (sliders) and t, so `X ~ Normal(0, a)` responds to the slider.
 * - `Y = g(X, …)` where the right side references random variables declares a
 *   *derived* random variable — arithmetic on distributions. `S = X1 + X2` is
 *   the convolution of independent summands, `X Y` the product distribution,
 *   and piecewise conditionals work too: `Y = {X > 0: X^2, 1}`. Derived rows
 *   (and bare expressions like `X + Y`) plot a density estimated from samples.
 * - `P(…)` takes any inequality over the declared variables: `P(X < b)`,
 *   `P(a < X < b)`, `P(Y > 0.5)`, even `P(Y > X)`. Single-variable bounds on a
 *   base distribution stay exact (closed-form CDF + shaded region); everything
 *   else is estimated from the same joint samples.
 *
 * Sampling model: every base variable owns a deterministic stratified stream
 * of standard uniforms (equal-mass quantile midpoints, shuffled by a hash of
 * its name — a Latin-hypercube pairing across variables). Samples are the
 * quantile transform of that stream, so distinct names are independent while
 * a derived variable, evaluated per-sample over its dependencies, preserves
 * the joint distribution exactly: `X + X` is 2X, `P(Y > X)` sees the
 * dependence of Y on X. Streams are fixed, so results are reproducible and
 * respond continuously to slider drags (common random numbers).
 */
import {
  EVAL_FNS,
  type Expr,
  FUNCTIONS,
  builtinFn,
  evaluate,
  freeVars,
  ineqComparisons,
  normalcdf,
  parseExpr,
} from './expr.ts';
import { usesComplex } from './complex.ts';
import { type GetFn, RESERVED, type ResolveOpts, resolveExpr } from './defs.ts';

// --- base distributions ---

export type BaseKind = 'normal' | 'uniform' | 'exponential';

/** Argument meaning by kind — normal: [mean, sd]; uniform: [lo, hi]; exponential: [rate]. */
export interface BaseDist {
  kind: BaseKind;
  args: Expr[];
}

const TILDE_RE = /^\s*([A-Za-z_]\w*)\s*~\s*([\s\S]+)$/;
const DIST_RE = /^\s*([A-Za-z_]\w*)\s*(?:\(([\s\S]*)\))?\s*$/;
const PROB_RE = /^\s*P\s*\(([\s\S]+)\)\s*$/;
const CONST_ROW_RE = /^\s*([A-Za-z_]\w*)\s*=(?!=)([\s\S]+)$/;

/** Detect a `name ~ rhs` row before parsing ('~' is not an expression token). */
export function scanDistribution(text: string): { name: string; rhs: string } | null {
  const m = TILDE_RE.exec(text);
  return m ? { name: m[1], rhs: m[2] } : null;
}

interface DistSpec {
  kind: BaseKind;
  arity: number;
  usage: string;
  defaults: number[];
}

const DIST_SPECS = new Map<string, DistSpec>([
  ...['normal', 'n'].map((a): [string, DistSpec] =>
    [a, { kind: 'normal', arity: 2, usage: 'Normal(mean, sd)', defaults: [0, 1] }]),
  ...['uniform', 'u'].map((a): [string, DistSpec] =>
    [a, { kind: 'uniform', arity: 2, usage: 'Uniform(lo, hi)', defaults: [0, 1] }]),
  ...['exponential', 'exp'].map((a): [string, DistSpec] =>
    [a, { kind: 'exponential', arity: 1, usage: 'Exponential(rate)', defaults: [1] }]),
]);

/** Parse the right side of `name ~ …`. Throws with a row-friendly message. */
export function parseDistribution(rhs: string, fnNames: ReadonlySet<string>): BaseDist {
  const m = DIST_RE.exec(rhs);
  const spec = m && DIST_SPECS.get(m[1].toLowerCase());
  if (!m || !spec) {
    throw new Error(m && !DIST_SPECS.has(m[1].toLowerCase())
      ? `Unknown distribution: ${m[1]}. Try Normal(mean, sd), Uniform(lo, hi), or Exponential(rate).`
      : 'Expected a distribution like Normal(0, 1).');
  }
  // A bare name takes the standard parameters: `X ~ N` is Normal(0, 1).
  if (m[2] === undefined) {
    return { kind: spec.kind, args: spec.defaults.map(value => ({ kind: 'num', value })) };
  }
  let args: Expr;
  try {
    args = parseExpr(`(${m[2]})`, fnNames);
  } catch (e) {
    if (e instanceof Error && /vector components/.test(e.message)) {
      throw new Error(`${spec.usage} takes ${spec.arity} arguments.`);
    }
    throw e;
  }
  const items = args.kind === 'vec' ? args.items : [args];
  if (items.length !== spec.arity) {
    throw new Error(`${spec.usage} takes ${spec.arity} argument${spec.arity > 1 ? 's' : ''}.`);
  }
  return { kind: spec.kind, args: items };
}

const v = (name: string): Expr => ({ kind: 'var', name });
const num = (value: number): Expr => ({ kind: 'num', value });
const bin = (op: '+' | '-' | '*' | '/' | '^', a: Expr, b: Expr): Expr => ({ kind: 'bin', op, a, b });
const chain = (lo: Expr, mid: Expr, hi: Expr): Expr =>
  ({ kind: 'ineq', op: '<', l: { kind: 'ineq', op: '<', l: lo, r: mid }, r: hi });

/** The exact pdf of a base distribution at `x` (piecewise where the support ends). */
export function pdfExpr(d: BaseDist, x: Expr): Expr {
  switch (d.kind) {
    case 'normal':
      return { kind: 'call', name: 'normalpdf', args: [x, d.args[0], d.args[1]] };
    case 'uniform':
      // The condition is empty while hi <= lo (mid slider drag), so the pdf
      // degrades to 0 everywhere instead of going negative.
      return {
        kind: 'piecewise',
        cases: [{ cond: chain(d.args[0], x, d.args[1]), value: bin('/', num(1), bin('-', d.args[1], d.args[0])) }],
        otherwise: num(0),
      };
    case 'exponential': {
      // max(rate, 0): a non-positive rate flattens to 0 rather than blowing up.
      const r: Expr = { kind: 'call', name: 'max', args: [d.args[0], num(0)] };
      return {
        kind: 'piecewise',
        cases: [{
          cond: { kind: 'ineq', op: '>=', l: x, r: num(0) },
          value: bin('*', r, { kind: 'call', name: 'exp', args: [{ kind: 'neg', a: bin('*', r, x) }] }),
        }],
        otherwise: num(0),
      };
    }
  }
}

/** The density curve for a base random variable: y = pdf(x). */
export function densityExpr(d: BaseDist): Expr {
  return { kind: 'eq', l: v('y'), r: pdfExpr(d, v('x')) };
}

/** The inner text of a `P(…)` row, or null if the row has another shape. */
export function matchProbability(text: string): string | null {
  const m = PROB_RE.exec(text);
  return m ? m[1] : null;
}

// --- probability specs ---

export interface ProbSpec {
  /** The inequality (chain) to estimate, resolved. */
  body: Expr & { kind: 'ineq' };
  /** Random variables the body references. */
  rvs: string[];
  /**
   * Present when the body is constant bounds around one bare variable
   * (`P(a < X < b)`): the shadeable — and for base variables, exact — case.
   */
  single?: { rv: string; lo?: Expr; hi?: Expr };
}

/** Interpret a parsed P(…) body against the declared random variables. */
export function toProbability(e: Expr, rvNames: ReadonlySet<string>): ProbSpec {
  if (e.kind !== 'ineq') throw new Error('P(…) expects an inequality like P(X < 2).');
  const frees = freeVars(e);
  const rvs = [...frees].filter(n => rvNames.has(n));
  if (!rvs.length) {
    throw new Error('P(…) must reference a random variable, e.g. X ~ Normal(0, 1) then P(X < 2).');
  }
  for (const n of frees) {
    if (/^[xyzuvw]$/.test(n)) throw new Error(`P(…) cannot use the plot coordinate ${n}.`);
  }
  const comps = ineqComparisons(e);
  if (new Set(comps.map(c => c.op[0])).size > 1) {
    throw new Error('Chained inequalities must point the same way.');
  }
  // Normalize to ascending order so the terms read lo … X … hi.
  const asc = comps.map(c => (c.op[0] === '<' ? { l: c.l, r: c.r } : { l: c.r, r: c.l }));
  if (comps[0].op[0] === '>') asc.reverse();
  const terms = [asc[0].l, ...asc.map(c => c.r)];
  const spec: ProbSpec = { body: e, rvs };

  // `lo < X < hi` with one bare variable and variable-free bounds shades (and,
  // for a base distribution, computes exactly). Anything else — P(Y > X),
  // derived expressions in place, longer chains — estimates from samples.
  const idx = terms.findIndex(t => t.kind === 'var' && rvNames.has(t.name));
  const others = terms.filter((_, k) => k !== idx);
  if (idx >= 0 && terms.length <= 3 && Math.abs(terms.length - 1 - idx) <= 1
    && others.every(t => [...freeVars(t)].every(n => !rvNames.has(n)))) {
    spec.single = {
      rv: (terms[idx] as Expr & { kind: 'var' }).name,
      lo: idx > 0 ? terms[idx - 1] : undefined,
      hi: idx < terms.length - 1 ? terms[idx + 1] : undefined,
    };
  }
  return spec;
}

/**
 * The shaded region for an exact probability: the area between the x-axis and
 * the density, clipped to the bounds. Each part is normalized to F < 0 and
 * combined with max() (intersection), the same shape classify() produces for
 * inequality chains; '<=' gives the region a drawn outline.
 */
export function regionExpr(d: BaseDist, lo?: Expr, hi?: Expr): Expr {
  const x = v('x');
  const y = v('y');
  let f: Expr = bin('-', y, pdfExpr(d, x)); // y < pdf(x)
  const parts: Expr[] = [{ kind: 'neg', a: y }]; // 0 < y
  if (lo) parts.push(bin('-', lo, x)); // lo < x
  if (hi) parts.push(bin('-', x, hi)); // x < hi
  for (const part of parts) f = { kind: 'call', name: 'max', args: [f, part] };
  return { kind: 'ineq', op: '<=', l: f, r: num(0) };
}

/** Exact CDF of a base distribution; NaN while the parameters are invalid. */
function cdf(d: BaseDist, x: number, env: Record<string, number>): number {
  const a = d.args.map(e => evaluate(e, env));
  switch (d.kind) {
    case 'normal':
      return a[1] > 0 ? normalcdf(x, a[0], a[1]) : NaN;
    case 'uniform':
      return a[1] > a[0] ? Math.min(1, Math.max(0, (x - a[0]) / (a[1] - a[0]))) : NaN;
    case 'exponential':
      return a[0] > 0 ? (x <= 0 ? 0 : 1 - Math.exp(-a[0] * x)) : NaN;
  }
}

/** Exact value of P(lo < X < hi) under the given constant environment. */
export function probabilityValue(
  d: BaseDist,
  lo: Expr | undefined,
  hi: Expr | undefined,
  env: Record<string, number>,
): number {
  return (hi ? cdf(d, evaluate(hi, env), env) : 1) - (lo ? cdf(d, evaluate(lo, env), env) : 0);
}

// --- row scanning ---

/**
 * Decide which rows declare random variables, before definitions are built.
 * `base` rows are `name ~ …`; `derived` rows are `name = rhs` where the rhs
 * mentions a random variable (transitively — `Z = Y + 1` follows `Y = X^2`
 * into the set). Rows the caller has already claimed (comments, sequences)
 * arrive as null. Word-boundary matching is textual by design: it must run
 * before parsing, because these rows must *not* become constant definitions.
 */
export function scanRandomRows(texts: readonly (string | null)[]): {
  base: Map<number, { name: string; rhs: string }>;
  derived: Map<number, { name: string; rhs: string }>;
} {
  const base = new Map<number, { name: string; rhs: string }>();
  const derived = new Map<number, { name: string; rhs: string }>();
  const names = new Set<string>();
  const candidates = new Map<number, { name: string; rhs: string }>();
  texts.forEach((text, i) => {
    if (!text) return;
    const scan = scanDistribution(text);
    if (scan) {
      base.set(i, scan);
      names.add(scan.name);
      return;
    }
    const m = CONST_ROW_RE.exec(text);
    // The name must be claimable as a definition (`e = X` stays an equation).
    if (m && !FUNCTIONS.has(m[1]) && !RESERVED.has(m[1]) && !m[1].startsWith('u_')) {
      candidates.set(i, { name: m[1], rhs: m[2] });
    }
  });
  let changed = names.size > 0;
  while (changed) {
    changed = false;
    const re = new RegExp(`\\b(?:${[...names].join('|')})\\b`);
    for (const [i, c] of candidates) {
      if (!re.test(c.rhs)) continue;
      candidates.delete(i);
      derived.set(i, c);
      names.add(c.name);
      changed = true;
    }
  }
  return { base, derived };
}

/**
 * Validate a resolved right-hand side as a derived random variable: a real
 * scalar in random variables, constants, and t.
 */
export function checkDerived(e: Expr, rvNames: ReadonlySet<string>, constNames: ReadonlySet<string>): void {
  if (e.kind === 'eq' || e.kind === 'ineq' || e.kind === 'vec' || e.kind === 'list') {
    throw new Error('A random variable must be a single value.');
  }
  if (usesComplex(e)) throw new Error('Random variables are real-valued.');
  for (const n of freeVars(e)) {
    if (rvNames.has(n) || constNames.has(n) || n === 't') continue;
    if (/^[xyzuv]$/.test(n)) {
      throw new Error(`A random variable cannot depend on the plot coordinate ${n}.`);
    }
    throw new Error(`${n} is not defined.`);
  }
}

// --- the sampled system ---

/** Joint sample count. Stratified streams keep marginals exact at any size;
 *  this is set by when the *derived-density* estimate looks smooth (KDE noise
 *  ~ 1/√(N·h), visible as low-frequency wobble on zoomed-in curves) while a
 *  slider drag can still resample every affected variable within a frame. */
export const SAMPLE_COUNT = 1 << 17;

export type RV =
  | { name: string; kind: 'base'; dist: BaseDist }
  | { name: string; kind: 'derived'; expr: Expr };

export interface DensityCurve {
  /** Flat [x0, y0, x1, y1, …] polyline of the density estimate (may be empty
   *  when the distribution is a pure point mass). */
  pts: number[];
  mean: number;
  sd: number;
  /** Fraction of samples that are finite (< 1 for partial support like sqrt(X)). */
  mass: number;
}

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

const mulberry32 = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let z = seed;
  z = Math.imul(z ^ (z >>> 15), z | 1);
  z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
  return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
};

/**
 * The stratified standard-uniform stream for a variable name: quantile
 * midpoints (i + ½)/N shuffled by a name-seeded permutation. Memoized
 * forever — the stream is a pure function of the name.
 */
const streams = new Map<string, Float64Array>();
function uniformStream(name: string): Float64Array {
  let s = streams.get(name);
  if (s) return s;
  s = new Float64Array(SAMPLE_COUNT);
  for (let i = 0; i < SAMPLE_COUNT; i++) s[i] = (i + 0.5) / SAMPLE_COUNT;
  const rand = mulberry32(fnv1a(name));
  for (let i = SAMPLE_COUNT - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
  }
  streams.set(name, s);
  return s;
}

/** Acklam's rational approximation to the standard normal quantile (~1e-9). */
function normalQuantile(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  if (p <= 0 || p >= 1) return NaN;
  if (p < plow || p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(p < plow ? p : 1 - p));
    const x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    return p < plow ? x : -x;
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Evaluate an expression column-wise over the sample vectors. Inequalities
 *  yield 1/0 masks (NaN where an operand is NaN), matching evaluate(). */
function evalCols(
  e: Expr,
  cols: ReadonlyMap<string, Float64Array>,
  env: Record<string, number>,
  n: number,
): Float64Array {
  const alloc = () => new Float64Array(n);
  switch (e.kind) {
    case 'num': {
      const out = alloc();
      out.fill(e.value);
      return out;
    }
    case 'var': {
      const col = cols.get(e.name);
      if (col) return col;
      if (!(e.name in env)) throw new Error(`Unbound variable: ${e.name}`);
      const out = alloc();
      out.fill(env[e.name]);
      return out;
    }
    case 'neg': {
      const a = evalCols(e.a, cols, env, n);
      const out = alloc();
      for (let i = 0; i < n; i++) out[i] = -a[i];
      return out;
    }
    case 'bin': {
      const a = evalCols(e.a, cols, env, n);
      const b = evalCols(e.b, cols, env, n);
      const out = alloc();
      switch (e.op) {
        case '+': for (let i = 0; i < n; i++) out[i] = a[i] + b[i]; break;
        case '-': for (let i = 0; i < n; i++) out[i] = a[i] - b[i]; break;
        case '*': for (let i = 0; i < n; i++) out[i] = a[i] * b[i]; break;
        case '/': for (let i = 0; i < n; i++) out[i] = a[i] / b[i]; break;
        case '^': for (let i = 0; i < n; i++) out[i] = Math.pow(a[i], b[i]); break;
      }
      return out;
    }
    case 'call': {
      const fn = EVAL_FNS[e.name];
      if (!fn) throw new Error(`Unknown function: ${e.name}`);
      const args = e.args.map(a => evalCols(a, cols, env, n));
      const out = alloc();
      if (args.length === 1) {
        const a = args[0];
        for (let i = 0; i < n; i++) out[i] = fn(a[i]);
      } else if (args.length === 2) {
        const [a, b] = args;
        for (let i = 0; i < n; i++) out[i] = fn(a[i], b[i]);
      } else {
        for (let i = 0; i < n; i++) out[i] = fn(...args.map(a => a[i]));
      }
      return out;
    }
    case 'eq': {
      const l = evalCols(e.l, cols, env, n);
      const r = evalCols(e.r, cols, env, n);
      const out = alloc();
      for (let i = 0; i < n; i++) out[i] = l[i] - r[i];
      return out;
    }
    case 'ineq': {
      const out = alloc();
      out.fill(1);
      for (const { op, l, r } of ineqComparisons(e)) {
        const a = evalCols(l, cols, env, n);
        const b = evalCols(r, cols, env, n);
        for (let i = 0; i < n; i++) {
          if (Number.isNaN(out[i])) continue;
          if (Number.isNaN(a[i]) || Number.isNaN(b[i])) out[i] = NaN;
          else if (!(op === '<' ? a[i] < b[i] : op === '<=' ? a[i] <= b[i]
            : op === '>' ? a[i] > b[i] : a[i] >= b[i])) out[i] = 0;
        }
      }
      return out;
    }
    case 'piecewise': {
      const out = alloc();
      out.fill(NaN);
      const taken = new Uint8Array(n);
      for (const c of e.cases) {
        const mask = evalCols(c.cond, cols, env, n);
        const val = evalCols(c.value, cols, env, n);
        for (let i = 0; i < n; i++) {
          if (!taken[i] && mask[i] === 1) {
            out[i] = val[i];
            taken[i] = 1;
          }
        }
      }
      if (e.otherwise) {
        const val = evalCols(e.otherwise, cols, env, n);
        for (let i = 0; i < n; i++) if (!taken[i]) out[i] = val[i];
      }
      return out;
    }
    case 'vec': throw new Error('Vector in scalar context.');
    case 'list': throw new Error('List in scalar context.');
  }
}

/** Estimate a density curve from samples: a binned kernel density estimate
 *  (Silverman bandwidth over a robust spread), normalized so the area equals
 *  the finite-sample mass. Null when nothing is finite. */
function estimateCurve(col: Float64Array): DensityCurve | null {
  const finite: number[] = [];
  let sum = 0;
  for (let i = 0; i < col.length; i++) {
    const x = col[i];
    if (isFinite(x)) {
      finite.push(x);
      sum += x;
    }
  }
  const n = finite.length;
  if (n < 16) return null;
  const mean = sum / n;
  let ss = 0;
  for (const x of finite) ss += (x - mean) * (x - mean);
  const sd = Math.sqrt(ss / n);
  const mass = n / col.length;
  // Quantiles from a decimated sort: plenty for a range and bandwidth.
  const sub = Float64Array.from(finite.filter((_, i) => i % Math.ceil(n / 4096) === 0)).sort();
  const q = (p: number) => sub[Math.min(sub.length - 1, Math.floor(p * sub.length))];
  const spread = Math.min(sd, (q(0.75) - q(0.25)) / 1.349);
  if (!(spread > 0)) return { pts: [], mean, sd, mass }; // a point mass: no curve to draw
  // 1.4× Silverman's rule. His 0.9 factor is MISE-optimal for i.i.d. draws;
  // measured on these stratified columns, ~1.4× lowers BOTH the sup-error and
  // the curve's residual wobble (second-difference energy ÷2.4) — smoothness
  // is what the plotted line is judged by.
  const h = 1.26 * spread * Math.pow(n, -0.2);
  const lo = q(0.005) - 3 * h;
  const hi = q(0.995) + 3 * h;
  const B = 512;
  const dx = (hi - lo) / B;
  const hist = new Float64Array(B + 1);
  const w = 1 / (col.length * dx);
  for (const x of finite) {
    // Linear binning: split each sample between its two neighboring grid
    // points, so the histogram carries no half-bin jitter into the curve.
    const k = (x - lo) / dx;
    const k0 = Math.floor(k);
    if (k0 < 0 || k0 >= B) continue;
    const f = k - k0;
    hist[k0] += w * (1 - f);
    hist[k0 + 1] += w * f;
  }
  // Gaussian smoothing of the histogram — the binned KDE.
  const r = Math.min(256, Math.ceil((3 * h) / dx));
  const kernel = new Float64Array(2 * r + 1);
  let ksum = 0;
  for (let k = -r; k <= r; k++) ksum += kernel[k + r] = Math.exp(-0.5 * ((k * dx) / h) ** 2);
  for (let k = 0; k <= 2 * r; k++) kernel[k] /= ksum;
  const pts: number[] = [];
  for (let j = 0; j <= B; j++) {
    let y = 0;
    const k0 = Math.max(0, j - r);
    const k1 = Math.min(B, j + r);
    for (let k = k0; k <= k1; k++) y += hist[k] * kernel[j - k + r];
    pts.push(lo + j * dx, y);
  }
  return { pts, mean, sd, mass };
}

/** Clip a density curve to [lo, hi] and close it down to the x-axis: the
 *  polygon a Monte Carlo `P(…)` row fills. Null when the clip is empty. */
export function shadePolygon(curve: DensityCurve, lo?: number, hi?: number): number[] | null {
  const p = curve.pts;
  if (p.length < 4) return null;
  const xlo = lo ?? p[0];
  const xhi = hi ?? p[p.length - 2];
  if (!(xhi > xlo)) return null;
  const yAt = (x: number): number => {
    for (let i = 0; i + 3 < p.length; i += 2) {
      if (x >= p[i] && x <= p[i + 2]) {
        const f = (x - p[i]) / (p[i + 2] - p[i] || 1);
        return p[i + 1] + f * (p[i + 3] - p[i + 1]);
      }
    }
    return 0;
  };
  const out: number[] = [xlo, 0, xlo, yAt(xlo)];
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] > xlo && p[i] < xhi) out.push(p[i], p[i + 1]);
  }
  out.push(xhi, yAt(xhi), xhi, 0);
  return out;
}

interface CacheEntry {
  /** Serialized definition + parameter values the column was computed under. */
  sig: string;
  col: Float64Array;
  curve?: DensityCurve | null;
}

/** An expression decomposed as Σ terms[name]·name + c, coefficients free of
 *  random variables. The affine-in-normals form has an exact distribution. */
interface Affine {
  terms: Map<string, Expr>;
  c: Expr;
}

/**
 * The declared random variables of a document plus their sample columns.
 * The instance persists across recompiles (reset() clears declarations, not
 * caches); cache entries carry the serialized definition and the values of
 * the constants the variable (transitively) references, so a slider drag
 * recomputes only the variables it touches, a static scene never resamples,
 * and an edited definition can never serve stale samples.
 */
export class RVSystem {
  private rvs = new Map<string, RV>();
  private cache = new Map<string, CacheEntry>();
  private paramsMemo = new Map<string, ReadonlySet<string>>();
  private defSigMemo = new Map<string, string>();
  private affineMemo = new Map<string, Affine | null>();

  /** Start a recompile: drop declarations, keep sample caches. */
  reset(): void {
    this.rvs.clear();
    this.paramsMemo.clear();
    this.defSigMemo.clear();
    this.affineMemo.clear();
  }

  add(rv: RV): void {
    this.rvs.set(rv.name, rv);
  }

  delete(name: string): void {
    this.rvs.delete(name);
  }

  has(name: string): boolean {
    return this.rvs.has(name);
  }

  get(name: string): RV | undefined {
    return this.rvs.get(name);
  }

  size(): number {
    return this.rvs.size;
  }

  /** End a recompile: drop cached samples of variables no longer declared. */
  prune(): void {
    for (const k of [...this.cache.keys()]) {
      if (!this.rvs.has(k)) this.cache.delete(k);
    }
  }

  /** Detect definition cycles; returns per-variable errors. */
  validate(): Map<string, string> {
    const broken = new Map<string, string>();
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (name: string, path: string[]): void => {
      const rv = this.rvs.get(name);
      if (!rv || state.get(name) === 'done') return;
      if (state.get(name) === 'visiting') {
        const cycle = path.slice(path.indexOf(name)).concat(name);
        for (const cn of cycle) broken.set(cn, `${cycle.join(' → ')} is circular.`);
        return;
      }
      state.set(name, 'visiting');
      if (rv.kind === 'derived') {
        for (const dep of freeVars(rv.expr)) {
          if (this.rvs.has(dep)) visit(dep, [...path, name]);
        }
      }
      state.set(name, 'done');
    };
    for (const name of this.rvs.keys()) visit(name, []);
    return broken;
  }

  /** Non-random free names the variable depends on, transitively (may include 't'). */
  paramsOf(name: string): ReadonlySet<string> {
    const memo = this.paramsMemo.get(name);
    if (memo) return memo;
    const out = new Set<string>();
    const seen = new Set<string>();
    const walk = (n: string): void => {
      if (seen.has(n)) return;
      seen.add(n);
      const rv = this.rvs.get(n);
      if (!rv) return;
      const frees = rv.kind === 'base'
        ? rv.dist.args.reduce((s, a) => freeVars(a, s), new Set<string>())
        : freeVars(rv.expr);
      for (const f of frees) {
        if (this.rvs.has(f)) walk(f);
        else out.add(f);
      }
    };
    walk(name);
    this.paramsMemo.set(name, out);
    return out;
  }

  /** Decompose an expression as an affine form over *base normal* names, or
   *  null where that fails (nonlinear use, or a non-normal base involved). */
  private affine(e: Expr): Affine | null {
    const rvFree = (x: Expr): boolean => ![...freeVars(x)].some(n => this.rvs.has(n));
    if (rvFree(e)) return { terms: new Map(), c: e };
    const scale = (af: Affine | null, k: Expr): Affine | null => af && {
      terms: new Map([...af.terms].map(([n, coef]) => [n, bin('*', k, coef)])),
      c: bin('*', k, af.c),
    };
    switch (e.kind) {
      case 'var': {
        const rv = this.rvs.get(e.name)!;
        if (rv.kind === 'base') {
          return rv.dist.kind === 'normal' ? { terms: new Map([[e.name, num(1)]]), c: num(0) } : null;
        }
        return this.affineOf(e.name);
      }
      case 'neg':
        return scale(this.affine(e.a), num(-1));
      case 'bin': {
        if (e.op === '+' || e.op === '-') {
          const a = this.affine(e.a);
          const b = e.op === '-' ? scale(this.affine(e.b), num(-1)) : this.affine(e.b);
          if (!a || !b) return null;
          const terms = new Map(a.terms);
          for (const [n, coef] of b.terms) {
            const prev = terms.get(n);
            terms.set(n, prev ? bin('+', prev, coef) : coef);
          }
          return { terms, c: bin('+', a.c, b.c) };
        }
        if (e.op === '*') {
          if (rvFree(e.a)) return scale(this.affine(e.b), e.a);
          if (rvFree(e.b)) return scale(this.affine(e.a), e.b);
          return null; // X·Y: a product distribution, not affine
        }
        if (e.op === '/' && rvFree(e.b)) {
          return scale(this.affine(e.a), bin('/', num(1), e.b));
        }
        return null; // X^k and friends
      }
      default:
        return null; // calls, piecewise, … over random variables: sampled path
    }
  }

  private affineOf(name: string): Affine | null {
    if (this.affineMemo.has(name)) return this.affineMemo.get(name)!;
    const rv = this.rvs.get(name);
    const af = rv?.kind === 'derived' ? this.affine(rv.expr) : null;
    this.affineMemo.set(name, af);
    return af;
  }

  /**
   * The exact distribution of a variable, when one is derivable: base
   * declarations pass through, and a derived variable affine in independent
   * normal bases is itself normal — mean Σcᵢμᵢ + d, sd √(Σ(cᵢσᵢ)²). Shared
   * names accumulate into one coefficient first, which is exactly the
   * covariance accounting: var(aX + bX) = (a+b)²σ². Null means "estimate
   * from samples" (nonlinear transforms, non-normal bases, products).
   */
  exactDist(name: string): BaseDist | null {
    const rv = this.rvs.get(name);
    if (!rv) return null;
    if (rv.kind === 'base') return rv.dist;
    const af = this.affineOf(name);
    if (!af || !af.terms.size) return null;
    let mean = af.c;
    let variance: Expr | null = null;
    for (const [n, coef] of af.terms) {
      const d = (this.rvs.get(n) as RV & { kind: 'base' }).dist;
      mean = bin('+', mean, bin('*', coef, d.args[0]));
      const term = bin('^', bin('*', coef, d.args[1]), num(2));
      variance = variance ? bin('+', variance, term) : term;
    }
    const sd: Expr = { kind: 'call', name: 'sqrt', args: [variance!] };
    return { kind: 'normal', args: [mean, sd] };
  }

  /** Non-random free names of a P(…) body, through the variables it references. */
  bodyParams(e: Expr): Set<string> {
    const out = new Set<string>();
    for (const f of freeVars(e)) {
      if (this.rvs.has(f)) for (const p of this.paramsOf(f)) out.add(p);
      else out.add(f);
    }
    return out;
  }

  /** Serialized definition of a variable *and its dependencies*, so editing
   *  `X ~ …` invalidates the cached samples of `Y = X + 1` too. */
  private defSig(name: string, seen = new Set<string>()): string {
    const memo = this.defSigMemo.get(name);
    if (memo !== undefined) return memo;
    if (seen.has(name)) return '@cycle'; // validate() reports it; keep sigs total
    seen.add(name);
    const rv = this.rvs.get(name);
    let s: string;
    if (!rv) s = '@missing';
    else if (rv.kind === 'base') s = rv.dist.kind + JSON.stringify(rv.dist.args);
    else {
      s = JSON.stringify(rv.expr);
      for (const dep of [...freeVars(rv.expr)].sort()) {
        if (this.rvs.has(dep)) s += `|${dep}:${this.defSig(dep, seen)}`;
      }
    }
    this.defSigMemo.set(name, s);
    return s;
  }

  private sig(rv: RV, env: Record<string, number>): string {
    let s = this.defSig(rv.name);
    for (const p of [...this.paramsOf(rv.name)].sort()) {
      if (!(p in env)) throw new Error(`Unbound variable: ${p}`);
      s += `;${p}=${env[p]}`;
    }
    return s;
  }

  /** The sample column for a variable under the given constants. */
  columns(name: string, env: Record<string, number>): Float64Array {
    const rv = this.rvs.get(name);
    if (!rv) throw new Error(`${name} has an error in its definition.`);
    const sig = this.sig(rv, env);
    const hit = this.cache.get(name);
    if (hit && hit.sig === sig) return hit.col;
    let col: Float64Array;
    if (rv.kind === 'base') {
      const u = uniformStream(name);
      const a = rv.dist.args.map(e => evaluate(e, env));
      col = new Float64Array(SAMPLE_COUNT);
      switch (rv.dist.kind) {
        case 'normal':
          if (a[1] > 0) for (let i = 0; i < SAMPLE_COUNT; i++) col[i] = a[0] + a[1] * normalQuantile(u[i]);
          else col.fill(NaN);
          break;
        case 'uniform':
          if (a[1] > a[0]) for (let i = 0; i < SAMPLE_COUNT; i++) col[i] = a[0] + (a[1] - a[0]) * u[i];
          else col.fill(NaN);
          break;
        case 'exponential':
          if (a[0] > 0) for (let i = 0; i < SAMPLE_COUNT; i++) col[i] = -Math.log(1 - u[i]) / a[0];
          else col.fill(NaN);
          break;
      }
    } else {
      const cols = new Map<string, Float64Array>();
      for (const dep of freeVars(rv.expr)) {
        if (this.rvs.has(dep)) cols.set(dep, this.columns(dep, env));
      }
      col = evalCols(rv.expr, cols, env, SAMPLE_COUNT);
    }
    this.cache.set(name, { sig, col });
    return col;
  }

  /** The estimated density curve (with mean/sd/mass) for a variable. */
  curve(name: string, env: Record<string, number>): DensityCurve | null {
    const col = this.columns(name, env);
    const entry = this.cache.get(name)!;
    if (entry.curve === undefined) entry.curve = estimateCurve(col);
    return entry.curve;
  }

  /**
   * Monte Carlo estimate of P(body): the fraction of joint samples where the
   * inequality holds. Samples where it is undefined count as "not the event";
   * NaN when it is undefined everywhere (broken parameters).
   */
  probability(body: Expr, env: Record<string, number>): number {
    const cols = new Map<string, Float64Array>();
    for (const f of freeVars(body)) {
      if (this.rvs.has(f)) cols.set(f, this.columns(f, env));
    }
    const mask = evalCols(body, cols, env, SAMPLE_COUNT);
    let count = 0;
    let defined = 0;
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      if (!Number.isNaN(mask[i])) {
        defined++;
        if (mask[i] === 1) count++;
      }
    }
    return defined ? count / SAMPLE_COUNT : NaN;
  }
}

// --- building the system from scanned rows ---

export interface BuildRVOpts {
  fnNames: ReadonlySet<string>;
  getFn: GetFn;
  ropts?: ResolveOpts;
  constNames: ReadonlySet<string>;
  /** Name already claimed by a definition row (constant, function, field, …). */
  taken: (name: string) => boolean;
}

export interface BuiltRVs {
  /** Every declared name, healthy or not — the set P(…) and bare rows resolve against. */
  names: ReadonlySet<string>;
  /** Row index → the variable it declares. */
  rowRV: Map<number, string>;
  /** Row index → error message, for rows whose declaration failed. */
  errors: Map<number, string>;
}

/**
 * Rebuild `sys` from the scanned rows: parse and resolve each declaration,
 * reject name collisions, then drop definition cycles and everything that
 * depends on a failed variable, reporting per-row errors. Shared by the app
 * and the worker so both accept exactly the same documents.
 */
export function buildRVSystem(sys: RVSystem, scan: ReturnType<typeof scanRandomRows>, opts: BuildRVOpts): BuiltRVs {
  sys.reset();
  const names = new Set([...scan.base.values(), ...scan.derived.values()].map(d => d.name));
  const rowRV = new Map<number, string>();
  const errors = new Map<number, string>();
  const rowOf = new Map<string, number>();

  const claim = (i: number, name: string): boolean => {
    rowRV.set(i, name);
    if (RESERVED.has(name) || builtinFn(name)) {
      errors.set(i, `Cannot use ${name} as a random variable name.`);
    } else if (sys.has(name) || opts.taken(name)) {
      errors.set(i, `${name} is already defined.`);
    } else {
      rowOf.set(name, i);
      return true;
    }
    return false;
  };

  for (const [i, { name, rhs }] of scan.base) {
    if (!claim(i, name)) continue;
    try {
      const d = parseDistribution(rhs, opts.fnNames);
      d.args = d.args.map(a => resolveExpr(a, opts.getFn, opts.ropts));
      for (const a of d.args) {
        for (const f of freeVars(a)) {
          if (names.has(f)) throw new Error('Distribution parameters cannot depend on a random variable.');
        }
        checkDerived(a, new Set(), opts.constNames);
      }
      sys.add({ name, kind: 'base', dist: d });
    } catch (e) {
      errors.set(i, e instanceof Error ? e.message : String(e));
    }
  }
  for (const [i, { name, rhs }] of scan.derived) {
    if (!claim(i, name)) continue;
    try {
      const expr = resolveExpr(parseExpr(rhs, opts.fnNames), opts.getFn, opts.ropts);
      checkDerived(expr, names, opts.constNames);
      sys.add({ name, kind: 'derived', expr });
    } catch (e) {
      errors.set(i, e instanceof Error ? e.message : String(e));
    }
  }

  // Cycles, then the ripple: a variable whose dependency failed fails too.
  const failed = sys.validate();
  for (const name of failed.keys()) sys.delete(name);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of rowOf.keys()) {
      const rv = sys.get(name);
      if (rv?.kind !== 'derived') continue;
      for (const dep of freeVars(rv.expr)) {
        if (names.has(dep) && !sys.has(dep)) {
          failed.set(name, `${dep} has an error in its definition.`);
          sys.delete(name);
          changed = true;
          break;
        }
      }
    }
  }
  for (const [name, message] of failed) {
    const row = rowOf.get(name);
    if (row !== undefined && !errors.has(row)) errors.set(row, message);
  }
  return { names, rowRV, errors };
}
