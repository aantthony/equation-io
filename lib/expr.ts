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

export type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Expr; b: Expr }
  | { kind: 'neg'; a: Expr }
  | { kind: 'call'; name: string; args: Expr[] }
  | { kind: 'eq'; l: Expr; r: Expr }
  /** A vector literal like (2, 3) or (cos(u), sin(u), v). Top-level only. */
  | { kind: 'vec'; items: Expr[] };

/** Functions available in expressions (all map to GLSL builtins or helpers). */
export const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh',
  'sqrt', 'abs', 'exp', 'ln', 'log', 'floor', 'ceil', 'round',
  'min', 'max', 'mod', 'sign', 'fract',
  're', 'im', 'arg', 'conj',
]);

export const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  tau: Math.PI * 2,
  e: Math.E,
};

const num = (value: number): Expr => ({ kind: 'num', value });
const bin = (op: '+' | '-' | '*' | '/' | '^') => (a: Expr, b: Expr): Expr => ({ kind: 'bin', op, a, b });

// A private node used only while parsing: a comma-joined argument list.
type PNode = Expr | { kind: 'series'; items: Expr[] };

function asExpr(n: PNode): Expr {
  if (n.kind === 'series') {
    if (n.items.length === 1) return n.items[0];
    throw new Error('Unexpected argument list.');
  }
  return n;
}

const asBin = (op: '+' | '-' | '*' | '/' | '^') =>
  BinaryInfix<PNode>((a, b) => bin(op)(asExpr(a), asExpr(b)));

const ops = operators<PNode>({
  EOF: Postfix(a => a),

  // Shunting yields "content, openMarker" then the close token, so arg 0 is the content.
  '}': BinaryInfix<PNode>(inner => inner),
  ')': BinaryInfix<PNode>(inner => inner),
  ']': BinaryInfix<PNode>(inner => inner),

  '=': BinaryInfix<PNode>((a, b): Expr => ({ kind: 'eq', l: asExpr(a), r: asExpr(b) })),

  ',': BinaryInfix<PNode>((a, b) => {
    const items = (n: PNode): Expr[] => (n.kind === 'series' ? n.items : [n]);
    return { kind: 'series', items: [...items(a), ...items(b)] };
  }),

  '+': asBin('+'),
  '-': asBin('-'),
  '−': asBin('-'),

  '*': asBin('*'),
  '×': asBin('*'),
  '/': asBin('/'),
  '÷': asBin('/'),

  '[neg]': Prefix<PNode>((a): Expr => ({ kind: 'neg', a: asExpr(a) })),

  '[impl]': asBin('*'),

  '^': BinaryRightInfix<PNode>((a, b): PNode => bin('^')(asExpr(a), asExpr(b))),

  // Function application: binds tighter than '^' so sin(x)^2 means (sin(x))^2.
  '[apply]': BinaryInfix<PNode>((a, b): Expr => {
    if (a.kind !== 'var' || !FUNCTIONS.has(a.name)) throw new Error('Expected a function name.');
    const args = b.kind === 'series' ? b.items : [asExpr(b)];
    return { kind: 'call', name: a.name, args };
  }),
});

// Unary minus and '^' must share a precedence level (both right-associative):
// '-x^2' parses as -(x^2) and 'x^-1' as x^(-1) without either popping the other.
ops['[neg]'].prec = ops['^'].prec;

const MULTI_CHAR_OPS = Object.keys(ops).filter(o => o.length > 1);

const syntax: PatternDict = {
  parenopen: /^[\(\{\[]$/,
  parenclose: /^[\)\}\]]$/,
  number: /^\d+\.?\d*$/,
  whitespace: /\s$/,
  symbol: /^[A-Za-z_][A-Za-z_0-9]*$/,
  operator: x => !!ops[x] || MULTI_CHAR_OPS.some(m => m.startsWith(x)),
  invalid(x) { throw new Error(`Invalid character: ${JSON.stringify(x)}.`); },
};

const tokenize = Tokenizer(syntax);

function op(str: string): Token {
  return { type: 'operator', str, line: -1, loc: [-1, -1] };
}

/**
 * Insert implicit multiplication tokens (2x, x(x+1), (x+1)(x-1), x y) and
 * rewrite unary +/- into a dedicated prefix operator.
 */
function *addImplicitTokens(bare: Iterable<Token>): Iterable<Token> {
  let last: Token | null = null;
  for (const token of bare) {
    if (token.type === 'whitespace') continue;

    const afterValue = last !== null && (last.type === 'number' || last.type === 'symbol' || last.type === 'parenclose');

    if (token.type === 'operator' && (token.str === '-' || token.str === '−' || token.str === '+')) {
      if (!afterValue) {
        // Unary sign: drop unary plus, rewrite minus as the [neg] prefix op.
        if (token.str !== '+') yield op('[neg]');
        last = token;
        continue;
      }
    }

    if (afterValue && (token.type === 'number' || token.type === 'symbol' || token.type === 'parenopen')) {
      const isFnCall = token.type === 'parenopen' && last!.type === 'symbol' && FUNCTIONS.has(last!.str);
      yield op(isFnCall ? '[apply]' : '[impl]');
    }

    yield token;
    last = token;
  }
}

function createLeaf(token: Token): PNode {
  if (token.type === 'number') return num(Number(token.str));
  if (token.type === 'parenopen') return { kind: 'series', items: [] };
  if (token.type === 'symbol') {
    if (token.str in CONSTANTS) return num(CONSTANTS[token.str]);
    return { kind: 'var', name: token.str };
  }
  throw new Error(`Invalid token: ${token.type} ${JSON.stringify(token.str)}`);
}

/** Parse an expression or equation, keeping free variables symbolic. */
export function parseExpr(str: string): Expr {
  const tokens = addImplicitTokens(tokenize(str));
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
  if (top.kind === 'series') {
    if (top.items.length === 2 || top.items.length === 3) return { kind: 'vec', items: top.items };
    throw new Error('Expected 2 or 3 vector components.');
  }
  return top;
}

const EVAL_FNS: Record<string, (...xs: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  min: Math.min, max: Math.max,
  mod: (a, b) => a - Math.floor(a / b) * b,
  fract: a => a - Math.floor(a),
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
    case 'vec': throw new Error('Vector in scalar context.');
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
    case 'vec': e.items.forEach(a => freeVars(a, out)); break;
  }
  return out;
}
