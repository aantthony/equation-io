/**
 * Symbolic expression parsing for plotting.
 *
 * Unlike syntax.ts (which eagerly evaluates to multiset values), this module
 * parses input into a small symbolic AST that can retain free variables
 * (x, y, z, ...) so it can be compiled to GLSL or JS for graphing.
 */
import { BinaryInfix, BinaryRightInfix, operators, Postfix, Prefix, shunting } from './lang/parser.ts';
import Tokenizer, { type PatternDict, type Token } from './lang/tokenizer.ts';
import { walk } from './lang/ast.ts';

export type IneqOp = '<' | '<=' | '>' | '>=';

export type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Expr; b: Expr }
  | { kind: 'neg'; a: Expr }
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'eq'; l: Expr; r: Expr }
  /** An inequality; chains like 0 < y < x nest left: ((0 < y) < x). */
  | { kind: 'ineq'; op: IneqOp; l: Expr; r: Expr }
  /** A vector literal like (2, 3) or (cos(u), sin(u), v): the whole
   *  statement, an equation side, or an operand ((A + (1, 2))/2 — lowerGeom
   *  expands 2-item operands; 3-item vectors stay top-level values). */
  | { kind: 'vec'; items: Expr[] }
  /** A data list [1, 4, 2] or [(1,2), (3,4)]. Plottable as its own row only. */
  | { kind: 'list'; items: Expr[] }
  /** {cond: value, …, otherwise?}; conditions are inequalities, tried in order. */
  | { kind: 'piecewise'; cases: Array<{ cond: Expr; value: Expr }>; otherwise?: Expr };

/** Functions available in expressions (all map to GLSL builtins or helpers). */
export const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'sech', 'asinh', 'acosh', 'atanh',
  'sqrt', 'abs', 'exp', 'ln', 'log', 'floor', 'ceil', 'round',
  'min', 'max', 'mod', 'sign', 'fract',
  'erf', 'normalpdf', 'normalcdf',
  'gcd', 'isprime',
  're', 'im', 'arg', 'conj',
  // Point (2D vector) helpers and geometry statements, lowered symbolically
  // by lowerGeom before anything evaluates or compiles them.
  'dot', 'cross', 'perp', 'midpoint', 'unit',
  'segment', 'line', 'polygon', 'square', 'circle',
  // Not real functions: Σ/Π binders, expanded symbolically by resolveExpr.
  'sum', 'prod',
  // Whole-expression plot modes (see classify): domain coloring, conformal
  // grids, escape-time iteration, and swept tubes.
  'domain', 'conformal', 'iter', 'tube',
]);

/**
 * Flatten a (possibly chained) inequality into its comparisons; comparison k
 * compares the previous comparison's right side, so 0 < y < x yields
 * [0 < y, y < x].
 */
export function ineqComparisons(e: Expr & { kind: 'ineq' }): Array<{ op: IneqOp; l: Expr; r: Expr }> {
  const chain: Array<Expr & { kind: 'ineq' }> = [];
  let node: Expr = e;
  while (node.kind === 'ineq') {
    chain.unshift(node);
    node = node.l;
  }
  return chain.map((c, k) => ({ op: c.op, l: k === 0 ? c.l : chain[k - 1].r, r: c.r }));
}

export const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  tau: Math.PI * 2,
  e: Math.E,
};

/** User-defined function names for the parse in progress (set by parseExpr). */
let activeUserFns: ReadonlySet<string> = new Set();

/**
 * Resolve a symbol to a built-in function name, folding case so `Sin`, `SIN`
 * and `sin` all reach the same builtin. Returns null if it is not a builtin
 * (user functions, which are case-sensitive, are handled separately).
 */
export const builtinFn = (name: string): string | null => {
  if (FUNCTIONS.has(name)) return name;
  const lower = name.toLowerCase();
  return FUNCTIONS.has(lower) ? lower : null;
};

/** Canonical name for a call: user functions win (exact), then case-folded builtins. */
const canonicalFn = (name: string): string =>
  activeUserFns.has(name) ? name : (builtinFn(name) ?? name);

const isFnName = (name: string): boolean => activeUserFns.has(name) || builtinFn(name) !== null;

const num = (value: number): Expr => ({ kind: 'num', value });
const bin = (op: '+' | '-' | '*' | '/' | '^') => (a: Expr, b: Expr): Expr => ({ kind: 'bin', op, a, b });

// Private nodes used only while parsing: a comma-joined argument list, an
// open-bracket marker, and a `cond: value` piecewise part.
type PCase = { kind: 'pcase'; cond: Expr; value: Expr };
type POpen = { kind: 'popen'; bracket: string; call: boolean };
type PNode = Expr | { kind: 'series'; items: Array<Expr | PCase> } | PCase | POpen;

function asExpr(n: PNode | undefined): Expr {
  if (!n) throw new Error('Incomplete expression.');
  if (n.kind === 'series') {
    if (n.items.length === 1) return asExpr(n.items[0]);
    throw new Error('Unexpected argument list.');
  }
  if (n.kind === 'pcase') throw new Error('A "condition: value" pair is only valid inside {…}.');
  if (n.kind === 'popen') throw new Error('Incomplete expression.');
  return n;
}

const asVecOrExpr = (n: PNode): Expr =>
  n.kind === 'series' && (n.items.length === 2 || n.items.length === 3)
    ? seriesToVec(n.items)
    : asExpr(n);

// Operators take tuples as operands — a parenthesized pair used in arithmetic
// is a vector literal, so (A + (1, 2))/2 works. Only a function application
// keeps a parenthesized series as an argument list (max(1, 2) stays 2 args):
// the [apply] operator binds before any of these see the series.
const asBin = (op: '+' | '-' | '*' | '/' | '^') =>
  BinaryInfix<PNode>((a, b) => bin(op)(asVecOrExpr(a), asVecOrExpr(b)));

const asIneq = (op: IneqOp) =>
  BinaryInfix<PNode>((a, b): Expr => ({ kind: 'ineq', op, l: asVecOrExpr(a), r: asVecOrExpr(b) }));

/** A comma series of 2–3 scalars in plain brackets is a vector literal. */
function seriesToVec(items: Array<Expr | PCase>): Expr {
  if (items.length === 2 || items.length === 3) return { kind: 'vec', items: items.map(asExpr) };
  throw new Error('Expected 2 or 3 vector components.');
}

/** Assemble {…} content into a piecewise if it contains `cond: value` parts. */
function bracePiecewise(content: PNode): PNode {
  const items = content.kind === 'series' ? content.items : [content];
  if (!items.some(n => n.kind === 'pcase')) {
    return content.kind === 'series' ? seriesToVec(content.items) : content;
  }
  const cases: Array<{ cond: Expr; value: Expr }> = [];
  let otherwise: Expr | undefined;
  items.forEach((n, k) => {
    if (n.kind === 'pcase') {
      if (n.cond.kind !== 'ineq') throw new Error('Piecewise conditions must be inequalities, like x < 0.');
      if (otherwise) throw new Error('The default value must come last in {…}.');
      cases.push({ cond: n.cond, value: n.value });
    } else {
      if (k !== items.length - 1) throw new Error('Each piecewise part needs a "condition: value".');
      otherwise = asExpr(n);
    }
  });
  return { kind: 'piecewise', cases, otherwise };
}

/**
 * Close-bracket handler. Shunting yields "content, openMarker" then the close
 * token, so the marker is the last argument (or the only one, for empty
 * brackets like `f()`).
 */
const closer = (open: string, finish: (content: PNode | null, call: boolean) => PNode) =>
  BinaryInfix<PNode>((a, b) => {
    const marker = b ?? a;
    if (!marker || marker.kind !== 'popen') throw new Error('Mismatched brackets.');
    if (marker.bracket !== open) throw new Error(`Mismatched brackets: "${marker.bracket}" closed by "${BRACKET_CLOSE[open]}".`);
    return finish(b === undefined ? null : a, marker.call);
  });

const BRACKET_CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

const ops = operators<PNode>({
  EOF: Postfix(a => a),

  '}': closer('{', content => {
    if (!content) throw new Error('Empty braces.');
    return bracePiecewise(content);
  }),
  ')': closer('(', (content, call) => {
    // Function-call parens keep their argument series for [apply]; plain
    // parens turn a comma series into a vector literal like (2, 3).
    if (call) return content ?? { kind: 'series', items: [] };
    if (!content) throw new Error('Empty parentheses.');
    return content.kind === 'series' ? seriesToVec(content.items) : content;
  }),
  ']': closer('[', content => {
    if (!content) throw new Error('Empty list.');
    // A comma series is a data list; a single item keeps its grouping meaning.
    if (content.kind === 'series') return { kind: 'list', items: content.items.map(asExpr) };
    return content;
  }),

  // Either side of '=' may be a tuple, so (x', y') = (y, -sin(x)) parses.
  // (In `sum(n = 1..N, body)` the ',' binds tighter than '=', so the rhs
  // arrives as the tuple (1..N, body); sumCall unpacks that shape.)
  '=': BinaryInfix<PNode>((a, b): Expr => ({ kind: 'eq', l: asVecOrExpr(a), r: asVecOrExpr(b) })),

  ',': BinaryInfix<PNode>((a, b) => {
    const items = (n: PNode): Array<Expr | PCase> =>
      n.kind === 'series' ? n.items : n.kind === 'pcase' ? [n] : [asExpr(n)];
    return { kind: 'series', items: [...items(a), ...items(b)] };
  }),

  ':': BinaryInfix<PNode>((a, b): PNode => ({ kind: 'pcase', cond: asExpr(a), value: asExpr(b) })),

  '<': asIneq('<'),
  '<=': asIneq('<='),
  '≤': asIneq('<='),
  '>': asIneq('>'),
  '>=': asIneq('>='),
  '≥': asIneq('>='),

  // Σ/Π index ranges: `1..N` (only meaningful inside sum()/prod()).
  '..': BinaryInfix<PNode>((a, b): Expr => ({ kind: 'call', name: '[range]', args: [asExpr(a), asExpr(b)] })),

  '+': asBin('+'),
  '-': asBin('-'),
  '−': asBin('-'),

  '*': asBin('*'),
  '×': asBin('*'),
  '/': asBin('/'),
  '÷': asBin('/'),

  '[neg]': Prefix<PNode>((a): Expr => ({ kind: 'neg', a: asVecOrExpr(a) })),

  '[impl]': asBin('*'),

  '^': BinaryRightInfix<PNode>((a, b): PNode => bin('^')(asVecOrExpr(a), asVecOrExpr(b))),

  // Function application: binds tighter than '^' so sin(x)^2 means (sin(x))^2.
  '[apply]': BinaryInfix<PNode>((a, b): Expr => {
    if (a?.kind !== 'var' || !isFnName(a.name)) throw new Error('Expected a function name.');
    const name = canonicalFn(a.name);
    if (name === 'sum' || name === 'prod') return sumCall(name, b);
    // Tuple literals inside a call flatten into the argument list, so
    // tube((a, b, c)) === tube(a, b, c) and |(3, 4)| reaches abs as (3, 4);
    // geometry statements re-pair adjacent scalars into points (lib/geom.ts).
    const items = b?.kind === 'series' ? b.items.map(asExpr) : [asExpr(b)];
    const args = items.flatMap(x => (x.kind === 'vec' ? x.items : [x]));
    return { kind: 'call', name, args };
  }),
});

const isRange = (e: Expr): e is Expr & { kind: 'call' } => e.kind === 'call' && e.name === '[range]';

/**
 * Shape a Σ/Π header into a call node: args are [index, lo, hi] for the
 * header-only form `sum[n=1..N] …` and [index, lo, hi, body] for
 * `sum(n=1..N, body)` — whose `n = (1..N, body)` arrives as an equation with
 * a tuple rhs. resolveExpr expands both symbolically.
 */
function sumCall(name: 'sum' | 'prod', b: PNode): Expr {
  const usage = () => new Error(`Expected ${name}(n=1..N, …).`);
  if (b.kind !== 'eq' || b.l.kind !== 'var') throw usage();
  const idx = b.l;
  let range = b.r;
  let body: Expr | null = null;
  if (range.kind === 'vec') {
    if (range.items.length !== 2) throw usage();
    [range, body] = range.items;
  }
  if (!isRange(range)) throw usage();
  const args = [idx, range.args[0], range.args[1]];
  if (body) args.push(body);
  return { kind: 'call', name, args };
}

// Unary minus and '^' must share a precedence level (both right-associative):
// '-x^2' parses as -(x^2) and 'x^-1' as x^(-1) without either popping the other.
ops['[neg]'].prec = ops['^'].prec;

// All comparators share one precedence level so chains like 0 <= y < x
// associate left: ((0 <= y) < x), the shape classify flattens.
for (const k of ['<=', '≤', '>', '>=', '≥']) ops[k].prec = ops['<'].prec;

const MULTI_CHAR_OPS = Object.keys(ops).filter(o => o.length > 1);

const syntax: PatternDict = {
  parenopen: /^[\(\{\[]$/,
  parenclose: /^[\)\}\]]$/,
  number: /^\d+\.?\d*$/,
  bar: /^\|$/,
  whitespace: /\s$/,
  symbol: /^[A-Za-z_Σ∑Π∏][A-Za-z_0-9]*'*$/,
  operator: x => !!ops[x] || MULTI_CHAR_OPS.some(m => m.startsWith(x)),
  invalid(x) { throw new Error(`Invalid character: ${JSON.stringify(x)}.`); },
};

const tokenize = Tokenizer(syntax);

function op(str: string): Token {
  return { type: 'operator', str, line: -1, loc: [-1, -1] };
}

const SYMBOL_ALIASES: Record<string, string> = { 'Σ': 'sum', '∑': 'sum', 'Π': 'prod', '∏': 'prod' };

/**
 * Map Σ/Π glyphs to sum/prod, and repair `1..N`: the greedy number match
 * takes "1." leaving a lone "." operator, so rejoin the dot into "..".
 */
function *normalizeTokens(bare: Iterable<Token>): Iterable<Token> {
  let held: Token | null = null;
  for (let token of bare) {
    if (token.type === 'symbol' && SYMBOL_ALIASES[token.str]) {
      token = { ...token, str: SYMBOL_ALIASES[token.str] };
    }
    if (held) {
      if (token.type === 'operator' && token.str.startsWith('.')) {
        yield { ...held, str: held.str.slice(0, -1) };
        token = { ...token, str: '.' + token.str };
      } else {
        yield held;
      }
      held = null;
    }
    if (token.type === 'number' && token.str.endsWith('.')) {
      held = token;
      continue;
    }
    yield token;
  }
  if (held) yield held;
}

/**
 * Insert implicit multiplication tokens (2x, x(x+1), (x+1)(x-1), x y) and
 * rewrite unary +/- into a dedicated prefix operator.
 */
function *addImplicitTokens(bare: Iterable<Token>): Iterable<Token> {
  let last: Token | null = null;
  let barDepth = 0;
  for (const token of bare) {
    if (token.type === 'whitespace') continue;

    const afterValue = last !== null && (last.type === 'number' || last.type === 'symbol' || last.type === 'parenclose');

    if (token.type === 'bar') {
      // |x| is abs(x): a bar after a value closes the innermost open bar;
      // any other bar opens one (with implicit multiplication, as in 2|x|).
      if (barDepth > 0 && afterValue) {
        barDepth--;
        const close: Token = { ...token, type: 'parenclose', str: ')' };
        yield close;
        last = close;
      } else {
        barDepth++;
        if (afterValue) yield op('[impl]');
        yield { ...token, type: 'symbol', str: 'abs' };
        yield op('[apply]');
        const open: Token = { ...token, type: 'parenopen', str: '(', call: true };
        yield open;
        last = open;
      }
      continue;
    }

    if (token.type === 'operator' && (token.str === '-' || token.str === '−' || token.str === '+')) {
      if (!afterValue) {
        // Unary sign: drop unary plus, rewrite minus as the [neg] prefix op.
        if (token.str !== '+') yield op('[neg]');
        last = token;
        continue;
      }
    }

    let emit = token;
    if (afterValue && (token.type === 'number' || token.type === 'symbol' || token.type === 'parenopen')) {
      const isFnCall = token.type === 'parenopen' && last!.type === 'symbol' && isFnName(last!.str);
      yield op(isFnCall ? '[apply]' : '[impl]');
      if (isFnCall) emit = { ...token, call: true };
    }

    yield emit;
    last = emit;
  }
}

function createLeaf(token: Token): PNode {
  if (token.type === 'number') return num(Number(token.str));
  if (token.type === 'parenopen') return { kind: 'popen', bracket: token.str, call: !!token.call };
  if (token.type === 'symbol') {
    if (token.str in CONSTANTS) return num(CONSTANTS[token.str]);
    return { kind: 'var', name: token.str };
  }
  throw new Error(`Invalid token: ${token.type} ${JSON.stringify(token.str)}`);
}

/**
 * Parse an expression or equation, keeping free variables symbolic.
 * Names in userFns parse as function calls (`f(x+1)`) instead of products.
 */
export function parseExpr(str: string, userFns: ReadonlySet<string> = new Set()): Expr {
  activeUserFns = userFns;
  try {
    const tokens = addImplicitTokens(normalizeTokens(tokenize(str)));
    const stack: PNode[] = [];
    walk(
      ops,
      createLeaf,
      shunting(ops, tokens),
      node => stack.push(node),
      n => stack.splice(stack.length - n),
    );
    if (stack.length !== 1) throw new Error('Incomplete expression.');
    const top = stack[0];
    // A bare top-level comma series (no parens) still reads as a vector.
    if (top.kind === 'series') return seriesToVec(top.items);
    return asExpr(top);
  } finally {
    activeUserFns = new Set();
  }
}

/** Replace free variables by expressions. There are no binders, so no capture. */
export function substVars(e: Expr, env: Record<string, Expr>): Expr {
  switch (e.kind) {
    case 'num': return e;
    case 'var': return env[e.name] ?? e;
    case 'neg': return { kind: 'neg', a: substVars(e.a, env) };
    case 'bin': return { kind: 'bin', op: e.op, a: substVars(e.a, env), b: substVars(e.b, env) };
    case 'call': return { kind: 'call', name: e.name, args: e.args.map(a => substVars(a, env)) };
    case 'eq': return { kind: 'eq', l: substVars(e.l, env), r: substVars(e.r, env) };
    case 'ineq': return { kind: 'ineq', op: e.op, l: substVars(e.l, env), r: substVars(e.r, env) };
    case 'vec': return { kind: 'vec', items: e.items.map(a => substVars(a, env)) };
    case 'list': return { kind: 'list', items: e.items.map(a => substVars(a, env)) };
    case 'piecewise': return {
      kind: 'piecewise',
      cases: e.cases.map(c => ({ cond: substVars(c.cond, env), value: substVars(c.value, env) })),
      otherwise: e.otherwise && substVars(e.otherwise, env),
    };
  }
}

/** Abramowitz & Stegun 7.1.26; max absolute error ~1.5e-7. */
export function erf(x: number): number {
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592)
    * t * Math.exp(-a * a);
  return Math.sign(x) * y;
}

export const normalpdf = (x: number, mean: number, sd: number): number =>
  Math.exp(-0.5 * ((x - mean) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI));

export const normalcdf = (x: number, mean: number, sd: number): number =>
  0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));

/**
 * Largest argument `isprime` decides. Trial division stops at 2048 divisors —
 * the cap the GLSL twin loops to, and within float32's exact-integer range —
 * so both implementations agree wherever they answer at all. Above it they
 * report NaN rather than guessing, and non-finite terms are skipped.
 */
export const ISPRIME_MAX = 2048 * 2048 - 1;

const EVAL_FNS: Record<string, (...xs: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sech: x => 1 / Math.cosh(x),
  asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  min: Math.min, max: Math.max,
  mod: (a, b) => a - Math.floor(a / b) * b,
  fract: a => a - Math.floor(a),
  erf, normalpdf, normalcdf,
  gcd: (a, b) => {
    a = Math.abs(Math.round(a));
    b = Math.abs(Math.round(b));
    while (b) { const t = a % b; a = b; b = t; }
    return a;
  },
  isprime: x => {
    const n = Math.round(x);
    if (!isFinite(x) || Math.abs(x - n) > 1e-6 || n < 2) return 0;
    // Past the shared trial-division limit the answer is unknown, not prime.
    // This runs per frame for sequence terms and points, where scanning √n
    // divisors (3+ seconds once n nears 2^53) would freeze the frame.
    if (n > ISPRIME_MAX) return NaN;
    for (let i = 2; i * i <= n; i++) if (n % i === 0) return 0;
    return 1;
  },
};

/** Numerically evaluate a scalar expression with the given variable bindings. */
export function evaluate(e: Expr, env: Record<string, number>): number {
  switch (e.kind) {
    case 'num': return e.value;
    case 'var': {
      if (!(e.name in env)) throw new Error(`Unbound variable: ${e.name}`);
      return env[e.name];
    }
    case 'neg': return -evaluate(e.a, env);
    case 'bin': {
      const a = evaluate(e.a, env);
      const b = evaluate(e.b, env);
      switch (e.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '^': return Math.pow(a, b);
      }
    }
    case 'call': {
      const fn = EVAL_FNS[e.name];
      if (!fn) throw new Error(`Unknown function: ${e.name}`);
      return fn(...e.args.map(a => evaluate(a, env)));
    }
    case 'eq': return evaluate(e.l, env) - evaluate(e.r, env);
    case 'ineq': throw new Error('Cannot evaluate an inequality.');
    case 'vec': throw new Error('Vector in scalar context.');
    case 'list': throw new Error('List in scalar context.');
    case 'piecewise': {
      for (const c of e.cases) {
        if (c.cond.kind !== 'ineq') throw new Error('Piecewise conditions must be inequalities.');
        const holds = ineqComparisons(c.cond).every(({ op, l, r }) => {
          const a = evaluate(l, env);
          const b = evaluate(r, env);
          return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
        });
        if (holds) return evaluate(c.value, env);
      }
      return e.otherwise ? evaluate(e.otherwise, env) : NaN;
    }
  }
}

/** Collect free variable names (excluding function names and constants). */
export function freeVars(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.kind) {
    case 'num': break;
    case 'var': out.add(e.name); break;
    case 'bin': freeVars(e.a, out); freeVars(e.b, out); break;
    case 'neg': freeVars(e.a, out); break;
    case 'call': e.args.forEach(a => freeVars(a, out)); break;
    case 'eq': freeVars(e.l, out); freeVars(e.r, out); break;
    case 'ineq': freeVars(e.l, out); freeVars(e.r, out); break;
    case 'vec': e.items.forEach(a => freeVars(a, out)); break;
    case 'list': e.items.forEach(a => freeVars(a, out)); break;
    case 'piecewise':
      e.cases.forEach(c => { freeVars(c.cond, out); freeVars(c.value, out); });
      if (e.otherwise) freeVars(e.otherwise, out);
      break;
  }
  return out;
}
