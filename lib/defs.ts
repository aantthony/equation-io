/**
 * User definitions and derivative syntax.
 *
 * - `a = 2` defines a constant (the UI shows it as a slider); `b = a^2 + t`
 *   defines a computed constant. Constants stay symbolic through GLSL
 *   compilation (they become uniforms) so dragging a slider never recompiles
 *   a shader.
 * - `f(x) = x^3 - a x` defines a function; calls are inlined symbolically.
 * - `d/dx (…)` (also `d^2/dx^2`, any single-letter variable) differentiates
 *   symbolically at resolve time via diff().
 */
import { diff, mul, neg } from './diff.ts';
import { FUNCTIONS, type Expr, evaluate, freeVars, parseExpr, substVars } from './expr.ts';

export type Definition =
  | { kind: 'const'; name: string; rhs: string }
  | { kind: 'fn'; name: string; params: string[]; rhs: string };

export interface FnDef {
  params: string[];
  /** Fully resolved: no user-function calls or derivative nodes remain. */
  body: Expr;
}

export interface Defs {
  consts: Map<string, Expr>;
  fns: Map<string, FnDef>;
}

export const emptyDefs = (): Defs => ({ consts: new Map(), fns: new Map() });

/** Names with built-in meaning that definitions may not shadow. */
export const RESERVED = new Set(['x', 'y', 'z', 'u', 'v', 't', 'w', 'i', 'd', 'e', 'pi', 'tau']);

const FN_RE = /^\s*([A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*\)\s*=(?!=)([\s\S]+)$/;
const CONST_RE = /^\s*([A-Za-z_]\w*)\s*=(?!=)([\s\S]+)$/;

/** Detect a definition row before parsing (so calls to it parse everywhere). */
export function scanDefinition(text: string): Definition | null {
  let m = FN_RE.exec(text);
  if (m && !FUNCTIONS.has(m[1]) && !RESERVED.has(m[1]) && !m[1].startsWith('u_')) {
    return { kind: 'fn', name: m[1], params: m[2].split(/\s*,\s*/), rhs: m[3] };
  }
  m = CONST_RE.exec(text);
  if (m && !FUNCTIONS.has(m[1]) && !RESERVED.has(m[1]) && !m[1].startsWith('u_')) {
    return { kind: 'const', name: m[1], rhs: m[2] };
  }
  return null;
}

export type GetFn = (name: string) => FnDef | undefined;

const dVarName = (n: Expr): string | null =>
  n.kind === 'var' && /^d[A-Za-z]$/.test(n.name) ? n.name.slice(1) : null;

/** Match `d` or `d^k` (the numerator of a Leibniz derivative). */
function dOrder(n: Expr): number | null {
  if (n.kind === 'var' && n.name === 'd') return 1;
  if (n.kind === 'bin' && n.op === '^' && n.a.kind === 'var' && n.a.name === 'd'
    && n.b.kind === 'num' && Number.isInteger(n.b.value) && n.b.value >= 1 && n.b.value <= 6) {
    return n.b.value;
  }
  return null;
}

/** Match `dx` or `dx^k`, yielding the variable and order. */
function dxOrder(n: Expr): { v: string; order: number } | null {
  let v = dVarName(n);
  if (v) return { v, order: 1 };
  if (n.kind === 'bin' && n.op === '^' && (v = dVarName(n.a))
    && n.b.kind === 'num' && Number.isInteger(n.b.value) && n.b.value >= 1 && n.b.value <= 6) {
    return { v, order: n.b.value };
  }
  return null;
}

/** Numerator forms: d(^k), -d(^k), C·d(^k). */
function numeratorWrap(n: Expr): { order: number; wrap: (x: Expr) => Expr } | null {
  let order = dOrder(n);
  if (order !== null) return { order, wrap: x => x };
  if (n.kind === 'neg' && (order = dOrder(n.a)) !== null) return { order, wrap: neg };
  if (n.kind === 'bin' && n.op === '*' && (order = dOrder(n.b)) !== null) {
    const c = n.a;
    return { order, wrap: x => mul(c, x) };
  }
  return null;
}

function applyDiff(e: Expr, v: string, order: number): Expr {
  for (let k = 0; k < order; k++) e = diff(e, v);
  return e;
}

/**
 * Rewrite a division that spells a Leibniz derivative. Implicit
 * multiplication binds tighter than '/', so `d/dx expr` parses as
 * d / (dx · expr): the operand is the tail of the denominator's product chain.
 */
function matchDeriv(numr: Expr, den: Expr): Expr | null {
  const head = numeratorWrap(numr);
  if (!head) return null;
  const factors: Expr[] = [];
  let leftmost = den;
  while (leftmost.kind === 'bin' && leftmost.op === '*') {
    factors.unshift(leftmost.b);
    leftmost = leftmost.a;
  }
  const dx = dxOrder(leftmost);
  if (!dx || dx.order !== head.order || factors.length === 0) return null;
  let operand = factors[0];
  for (let k = 1; k < factors.length; k++) operand = { kind: 'bin', op: '*', a: operand, b: factors[k] };
  return head.wrap(applyDiff(operand, dx.v, head.order));
}

/** Inline user-function calls and resolve d/dx derivative notation (post-order). */
export function resolveExpr(e: Expr, getFn: GetFn): Expr {
  switch (e.kind) {
    case 'num':
    case 'var':
      return e;
    case 'neg': return { kind: 'neg', a: resolveExpr(e.a, getFn) };
    case 'bin': {
      const a = resolveExpr(e.a, getFn);
      const b = resolveExpr(e.b, getFn);
      if (e.op === '/') {
        const d = matchDeriv(a, b);
        if (d) return d;
      }
      if (e.op === '*' && a.kind === 'bin' && a.op === '/') {
        // The parenthesized form (d/dx)(expr): the quotient is bare.
        const head = numeratorWrap(a.a);
        const dx = dxOrder(a.b);
        if (head && dx && head.order === dx.order) return head.wrap(applyDiff(b, dx.v, head.order));
      }
      return { kind: 'bin', op: e.op, a, b };
    }
    case 'call': {
      const args = e.args.map(x => resolveExpr(x, getFn));
      const fn = getFn(e.name);
      if (fn) {
        if (args.length !== fn.params.length) {
          throw new Error(`${e.name} takes ${fn.params.length} argument${fn.params.length === 1 ? '' : 's'}.`);
        }
        return substVars(fn.body, Object.fromEntries(fn.params.map((p, k) => [p, args[k]])));
      }
      return { kind: 'call', name: e.name, args };
    }
    case 'eq': return { kind: 'eq', l: resolveExpr(e.l, getFn), r: resolveExpr(e.r, getFn) };
    case 'ineq': return { kind: 'ineq', op: e.op, l: resolveExpr(e.l, getFn), r: resolveExpr(e.r, getFn) };
    case 'vec': return { kind: 'vec', items: e.items.map(x => resolveExpr(x, getFn)) };
  }
}

export interface BuiltDefs {
  defs: Defs;
  /** Per-definition errors by name; failed definitions are excluded from defs. */
  errors: Map<string, string>;
}

/** Parse and resolve a set of uniquely named definitions. */
export function buildDefs(raw: Definition[]): BuiltDefs {
  const errors = new Map<string, string>();
  const defs = emptyDefs();
  const byName = new Map(raw.map(d => [d.name, d]));
  const fnNames = new Set(raw.filter(d => d.kind === 'fn').map(d => d.name));
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const parsed = new Map<string, Expr>();
  const parse = (d: Definition): Expr => {
    let p = parsed.get(d.name);
    if (!p) parsed.set(d.name, (p = parseExpr(d.rhs, fnNames)));
    return p;
  };

  const resolving = new Set<string>();
  const getFn: GetFn = name => {
    const hit = defs.fns.get(name);
    if (hit) return hit;
    if (!fnNames.has(name)) return undefined;
    if (errors.has(name)) throw new Error(`${name} has an error in its definition.`);
    if (resolving.has(name)) throw new Error(`${name} is defined in terms of itself.`);
    const d = byName.get(name) as Definition & { kind: 'fn' };
    resolving.add(name);
    try {
      const fn: FnDef = { params: d.params, body: resolveExpr(parse(d), getFn) };
      defs.fns.set(name, fn);
      return fn;
    } finally {
      resolving.delete(name);
    }
  };

  for (const d of raw) {
    try {
      if (d.kind === 'fn') {
        if (new Set(d.params).size !== d.params.length) throw new Error('Duplicate parameter names.');
        getFn(d.name);
      } else {
        defs.consts.set(d.name, resolveExpr(parse(d), getFn));
      }
    } catch (e) {
      errors.set(d.name, msg(e));
    }
  }

  // Constants may only depend on other constants and time.
  const constNames = new Set(raw.filter(d => d.kind === 'const').map(d => d.name));
  for (const [name, e] of defs.consts) {
    for (const fv of freeVars(e)) {
      if (fv !== 't' && !constNames.has(fv)) {
        errors.set(name, `${name} can only depend on other constants and t (found ${fv}).`);
        defs.consts.delete(name);
        break;
      }
    }
  }

  // Trial-evaluate to surface cycles and unsupported calls at definition time.
  const check = (name: string, visiting: Set<string>): void => {
    const e = defs.consts.get(name);
    if (!e) throw new Error(`${name} is not defined.`);
    if (visiting.has(name)) throw new Error(`${name} is defined in terms of itself.`);
    visiting.add(name);
    const env: Record<string, number> = { t: 0 };
    for (const fv of freeVars(e)) {
      if (fv !== 't') {
        check(fv, visiting);
        env[fv] = 0;
      }
    }
    visiting.delete(name);
    evaluate(e, env);
  };
  const bad = new Set<string>();
  for (const name of defs.consts.keys()) {
    try {
      check(name, new Set());
    } catch (e) {
      errors.set(name, msg(e));
      bad.add(name);
    }
  }
  for (const name of bad) defs.consts.delete(name);

  return { defs, errors };
}

/** Evaluate every constant at the given time (t may appear in definitions). */
export function evalConstEnv(defs: Defs, time: number): Record<string, number> {
  const out: Record<string, number> = {};
  const visiting = new Set<string>();
  const get = (name: string): number => {
    if (name in out) return out[name];
    const e = defs.consts.get(name);
    if (!e) throw new Error(`${name} is not defined.`);
    if (visiting.has(name)) throw new Error(`${name} is defined in terms of itself.`);
    visiting.add(name);
    try {
      const env: Record<string, number> = { t: time };
      for (const fv of freeVars(e)) if (fv !== 't') env[fv] = get(fv);
      return (out[name] = evaluate(e, env));
    } finally {
      visiting.delete(name);
    }
  };
  for (const name of defs.consts.keys()) get(name);
  return out;
}

/** True when any constant depends on time and so must be re-evaluated per frame. */
export function constsAnimated(defs: Defs): boolean {
  for (const e of defs.consts.values()) if (freeVars(e).has('t')) return true;
  return false;
}
