import { compare } from './compare';
import formatMs from './format';
import { walk } from './lang/ast';
import { BinaryInfix, Operator, OperatorDict, Prefix, shunting } from './lang/parser';
import Tokenzier, { PatternDict, Token } from './lang/tokenizer';
import { Empty, FALSE, MS, Nat, TRUE } from './ms';

type AstValueNode<V> = {
  type: 'value';
  value: V;
}

type AstPartialCallNode<V> = {
  type: 'call';
  fn: (args: V[]) => V;
  values: V[];
}

type AstSymbolicCallNode<V> = {
  type: 'symbolicCall', target: AstNode<V>, args: AstNode<V>[]
}

type AstSymbolicNativeCallNode<V> = {
  type: 'symbolicNativeCall', fn: (args: V[]) => V, args: AstNode<V>[]
}

type AstSymbolNode = {
  type: 'symbol';
  value: string;
}

type AstSeriesNode<V> = {
  type: 'series';
  items: AstNode<V>[];
}

type AstNode<V> =
  | AstValueNode<V>
  | AstPartialCallNode<V>
  | AstSymbolicCallNode<V>
  | AstSymbolNode
  | AstSeriesNode<V>
  | AstSymbolicNativeCallNode<V>;
;

function Equal(a: MS, b: MS): MS {
  return compare(a, b) === 0 ? TRUE : FALSE;
}

function Not(a: MS) {
  return Equal(a, FALSE);
}

function Plus(args: MS[]): MS {
  return function *() {
    for (const arg of args) yield* arg();
  }
}

function negate(s: MS): MS {
  return function *() {
    for (const [item, count] of s()) {
      yield [item, -count];
    }
  }
}

function Times(args: MS[]): MS {
  const a = args[0];
  const b = args[1];

  return function *() {
    for (const [aItem, aCount] of a()) {
      for (const [bItem, bCount] of b()) {
        yield [Plus([aItem, bItem]), aCount * bCount];
      }
    }
  }
}
function Power(a: MS, b: MS): MS {
  return a;
}

/**
 * Implements polynomial division of a/b
 * 
 * First, we factor terms in a and b.
 * 
 * @param a 
 * @param b 
 */
function Divide(a: MS, b: MS): MS {
  console.log('Divide', formatMs(a), '÷', formatMs(b));
  // a = aZeros + aNonZeros
  // b = bZeros + bNonZeros
  // a/b=x
  // a/b=xZeros + remainder/b

  // Remainder/b = a/b - xZeros
  // Remainder = a - xZeros * b
  // Remainder = aZeros + aNonZeros - aZeros/bZeros * (bZeros + bNonZeros)
  //           = aZeros + aNonZeros - aZeros - aZeros/bZeros * bNonZeros
  //           = aNonZeros - xZeros * bNonZeros

  // Count the number of zeros in a:
  let aZeros = 0n;
  const aNonZeros: [MS, bigint][] = [];
  for (const [item, count] of a()) {
    if (compare(item, Empty) === 0) {
      aZeros += count;
    } else {
      aNonZeros.push([item, count]);
    }
  }

  if (aZeros === 0n && aNonZeros.length === 0) {
    return Empty;
  }

  // Count the number of zeros in b:
  let bZeros = 0n;
  const bNonZeros: [MS, bigint][] = [];
  for (const [item, count] of b()) {
    if (compare(item, Empty) === 0) {
      bZeros += count;
    } else {
      bNonZeros.push([item, count]);
    }
  }

  console.log({
    aZeros,
    aNonZeros,
    bZeros,
    bNonZeros,
  });

  if (bZeros === 0n) {
    if (bNonZeros.length === 0) {
      throw new Error('PolyDivision by zero');
    }
  }

  const xZeros = aZeros / bZeros;

  console.log({ xZeros });

  // remainder = aNonZeros - xZeros * bNonZeros

  const remainder: MS = function *() {
    yield* aNonZeros;
    for (const [item, count] of bNonZeros) {
      yield [item, -xZeros * count];
    }
  };

  // console.log('remainder', formatMs(remainder));

  return function *() {
    yield [Empty, xZeros];
    yield* Divide(remainder, b)();
  }
}

const valFuncFor = <V>() => {
  type N = AstNode<V>;

  function wrap(val: V): N {
    return { type: 'value', value: val };
  }

  function unwrap<V>(node: AstNode<V>): V | undefined {
    if (node.type === 'value') {
      return node.value;
    } else if (node.type === 'call') {
      return node.fn(node.values);
    } else {
      return undefined;
    }
  }

  return {
    wrap,
    unwrap,
    binary(prec: number, fn: (a: V, b: V) => V): Operator<N> {
      return BinaryInfix('', prec, (a, b): N => {
        const aVal = unwrap(a);
        const bVal = unwrap(b);
        if (aVal && bVal) return wrap(fn(aVal, bVal));
        return { type: 'symbolicNativeCall', fn: ([x, y]) => fn(x, y), args: [a] };
      });
    },
    prefix(prec: number, fn: (a: V) => V): Operator<N> {
      return Prefix('', prec, (a): N => {
        const aVal = unwrap(a);
        if (aVal) return wrap(fn(aVal));
        return { type: 'symbolicNativeCall', fn: ([x]) => fn(x), args: [a] };
      });
    },
    assoc(prec: number, fn: (a: V[]) => V): Operator<N> {
      return {
        prec,
        n: 2,
        right: true,
        fn: (a, b): AstPartialCallNode<V> | AstSymbolicNativeCallNode<V> => {
          if (a.type === 'call') {
            if (a.fn === fn) {
              const aValues: V[] = a.values;
              if (b.type === 'value') {
                return { type: 'call', fn, values: [...aValues, b.value] };
              } else if (b.type === 'call') {
                // execute b call
                const bVal = b.fn(b.values);
                return { type: 'call', fn, values: [...aValues, bVal] };
              } else {
                const args: N[] = [...a.values.map(wrap), b];
                return { type: 'symbolicNativeCall', fn, args };
              }
            } else {
              const aValue = a.fn(a.values);
              if (b.type === 'value') {
                return { type: 'call', fn, values: [aValue, b.value] };
              } else if (b.type === 'call') {
                if (b.fn === fn) {
                  const bValues: V[] = b.values;
                  return { type: 'call', fn, values: [aValue, ...bValues] };
                } else {
                  const bValue = b.fn(b.values);
                  return { type: 'call', fn, values: [aValue, bValue] };
                }
              } else {
                const args: N[] = [wrap(aValue), b];
                return { type: 'symbolicNativeCall', fn, args };
              }
            }
          } else if (b.type === 'call') {
            if (b.fn === fn) {
              const bValues: V[] = b.values;
              if (a.type === 'value') {
                return { type: 'call', fn, values: [a.value, ...bValues] };
              } else {
                const args: N[] = [a, ...b.values.map(wrap)];
                return { type: 'symbolicNativeCall', fn, args };
              }
            } else {
              const bValue = b.fn(b.values);
              if (a.type === 'value') {
                return { type: 'call', fn, values: [a.value, bValue] };
              } else {
                const args: N[] = [a, wrap(bValue)];
                return { type: 'symbolicNativeCall', fn, args };
              }
            }
          } else if (a.type === 'value' && b.type === 'value') {
            return { type: 'call', values: [a.value, b.value], fn };
          } else {
            return { type: 'symbolicNativeCall', fn, args: [a, b] };
          }
        },
      };
    },
  };
};

type Node = AstNode<MS>;

const SameQ = Equal;
const UnsameQ = (a: MS, b: MS) => Not(SameQ(a, b));
const TrueQ = (a: MS) => Equal(a, TRUE);
const Less = (a: MS, b: MS) => compare(a, b) < 0 ? TRUE : FALSE;
const LessEqual = (a: MS, b: MS) => compare(a, b) <= 0 ? TRUE : FALSE;
const Greater = (a: MS, b: MS) => compare(a, b) > 0 ? TRUE : FALSE;
const GreaterEqual = (a: MS, b: MS) => compare(a, b) >= 0 ? TRUE : FALSE;
const Minus = (a: MS, b?: MS) => b ? Plus([a, negate(b)]) : negate(a);

const valFunc = valFuncFor<MS>();

const GlobalNameSpace = {
  'SameQ': SameQ,
  'UnsameQ': UnsameQ,
  'TrueQ': TrueQ,
  'Less': Less,
  'LessEqual': LessEqual,
  'Greater': Greater,
  'GreaterEqual': GreaterEqual,
  'Minus': Minus,
  Plus,
  Times,
  Power,
};

const ops: OperatorDict<Node> = {
  EOF: valFunc.prefix(0, (a) => a),
  // ';': BinaryInfix('Statements', 10),
  // '->': BinaryInfix('Rule', 10),
  // '//.': BinaryInfix('ReplaceRepeated', 10),
  '=': valFunc.binary(5, Equal),
  '==': valFunc.binary(10, Equal),
  // '||': BinaryInfix('Or', 10),
  // '&&': BinaryInfix('And', 10),
  // '|': BinaryInfix('Or', 10),
  // '&': BinaryInfix('And', 10),
  '!=': valFunc.binary(10, UnsameQ),
  '!!': valFunc.binary(10, TrueQ),
  '<': valFunc.binary(10, Less),
  '<=': valFunc.binary(10, LessEqual),
  '>': valFunc.binary(10, Greater),
  '>=': valFunc.binary(10, GreaterEqual),
  ',': BinaryInfix('Series', 11, (a, b): Node => {
    const aItems = a.type === 'series' ? a.items : [a];
    const bItems = b.type === 'series' ? b.items : [b];
    return {
      type: 'series',
      items: [...aItems, ...bItems],
    };
  }),
  // ':': BinaryInfix('Property', 12),
  // '=>': BinaryInfix('Lambda', 13, true),

  '-': valFunc.binary(15, Minus),
  '−': valFunc.binary(15, Minus),
  '+': valFunc.assoc(15, Plus),
  '': BinaryInfix('Default', 18, (a, b) => {
    if (a.type === 'symbol') {
      const fn = (GlobalNameSpace as any)[a.value];
      if (fn) {
        return valFunc.wrap(fn(a));
      }
    }
    return a;
  }),
  '/': valFunc.binary(20, Divide),
  '÷': valFunc.binary(20, Divide),
  '¬': valFunc.prefix(20, Not),
  '*': valFunc.assoc(20, Times),
  '×': valFunc.assoc(20, Times),
  // '^': BinaryRightInfix('Power', 25, Power),
  // '.': BinaryInfix('Dot', 30),
  // '!': Postfix('Factorial', 80),

  '}': BinaryInfix('Curly', -1, a => a),
  ')': BinaryInfix('Paren', -1, a => a),
  ']': BinaryInfix('Bracket', -1, a => {
    function fn(vals: MS[]): MS {
      return function *() {
        for (const val of vals) {
          yield [val, 1n];
        }
      }
    }
    const items: Node[] = a.type === 'series' ? a.items : [a];
    
    const allValues = items.every(i => i.type === 'value');
    if (allValues) {
      const vals = (items as AstValueNode<MS>[]).map(i => i.value);
      return valFunc.wrap(fn(vals));
    }

    return {
      type: 'symbolicNativeCall',
      fn,
      args: items,
    };
  }),
};

const MULTI_CHAR_OPS = Object.keys(ops).filter(o => o.length > 1);

function isOpCandidate(x: string) {
  if (ops[x]) return true;
  return MULTI_CHAR_OPS.some(m => m.startsWith(x));
}

function isStringCandidate(x: string): boolean {
  const c0 = x[0];
  if (c0 !== '"' && c0 !== '\'') return false;
  if (x.length === 2) return true;
  const secondLast = x[x.length - 2];
  if (secondLast === c0) {
    const thirdLast = x[x.length - 3];
    if (thirdLast !== '\\') return false;
  }
  return true;
}

const syntax: PatternDict = {
  parenopen: /^[\(\{\[]$/,
  parenclose: /^[\)\}\]]$/,
  number: /^\d+(\.\d+)*$/,
  whitespace: /\s$/,
  symbol: /[A-Za-z_]$/,
  string: isStringCandidate,
  operator: isOpCandidate,
  invalid(x) { throw new Error(`Invalid character: ${x}.`); }
};

const tokenize = Tokenzier(syntax);

const implicit: Token = {
  type: 'operator',
  str: '',
  line: -1,
  loc: [-1,-1],
}

function *addImplicitTokens(bare: Iterable<Token>): Iterable<Token> {
  let last: Token | null = null;

  for (const token of bare) {
    if (token.type === 'whitespace') {
      yield token;
      return;
    }

    if (last) {
      if (token.type === 'parenopen') {
        if (last.type !== 'operator' && last.type !== 'parenopen') {
          yield implicit;
        }
      } else if (token.type === 'number' || token.type === 'symbol') {
        if (last.type === 'number' || last.type === 'symbol') {
          yield implicit;
        }
      }
    }

    yield token;
    last = token;
  };
}

function build(token: Token): Node {
  if (token.type === 'number') return valFunc.wrap(Nat(BigInt(token.str)));
  if (token.type === 'parenopen') return null as any;
  if (token.type === 'symbol') {
    return {
      type: 'symbol',
      value: token.str,
    };
  }
  throw new Error(`Invalid token: ${token.type} ${token.str}`);
}

export function parse(str: string) {
  const tokens = addImplicitTokens(tokenize(str));
  return walk(
    ops,
    build,
    shunting(ops, tokens),
  );
}