import { walk } from './lang/ast';
import { BinaryInfix, Infix, operators, Postfix, Prefix, shunting } from './lang/parser';
import Tokenzier, { PatternDict, Token } from './lang/tokenizer';
import { MS, Nat } from './ms';
import { Divide, Equal, Greater, GreaterEqual, Less, LessEqual, Minus, Not, Plus, Times, TrueQ, UnsameQ } from './ops';

type ValueNode = { type: 'value'; value: MS };
type SeriesNode = { type: 'series'; items: Node[] };
type SymbolNode = { type: 'symbol'; name: string };
type CallableNode = { type: 'callable'; impl: (arg: MS) => MS };

type Node =
| ValueNode
| SeriesNode
| SymbolNode
| CallableNode
;

function onValueBinary(fn: (a: MS, b: MS) => MS) {
  return (a: Node, b: Node): Node => {
    if (a.type !== 'value' || b.type !== 'value') {
      throw new Error(`Expected value, got ${a.type} and ${b.type}`);
    }
    return { type: 'value', value: fn(a.value, b.value) };
  };
}

function onValueArray(fn: (args: MS[]) => MS) {
  return (nodes: Node[]): Node => {
    const values = nodes.map(n => {
      if (n.type !== 'value') {
        throw new Error(`Expected value, got ${n.type}`);
      }
      return n.value;
    });
    
    return { type: 'value', value: fn(values) };
  };
}

function onValue(fn: (value: MS) => MS) {
  return (node: Node): Node => {
    if (node.type !== 'value') {
      throw new Error(`Expected value, got ${node.type}`);
    }
    return { type: 'value', value: fn(node.value) };
  };
}

function makeMultiSet(elements: MS[]): MS {
  return function *makeMultiSet() {
    for (const val of elements) {
      yield [val, 1n];
    }
  }
}

const ops = operators<Node>({
  EOF: Postfix(a => {
    if (a.type !== 'value') {
      throw new Error(`Expected value, got ${a.type}`);
    }

    return a;
  }),

  // '}': BinaryInfix(a => a),
  // ')': BinaryInfix(a => a),
  ']': BinaryInfix((a, b) => {
    const items: Node[] = a.type === 'series' ? a.items : [a];
    
    const values = items.map(n => {
      if (n.type !== 'value') {
        throw new Error(`Expected value, got ${n.type}`);
      }

      return n.value;
    });
    
    return { type: 'value', value: makeMultiSet(values) };
  }),

  // ';': BinaryInfix('Statements', 10),
  // '->': BinaryInfix('Rule', 10),
  // '//.': BinaryInfix('ReplaceRepeated', 10),
  '=': BinaryInfix(onValueBinary(Equal)),
  '==': BinaryInfix(onValueBinary(Equal)),
  // '||': BinaryInfix('Or', 10),
  // '&&': BinaryInfix('And', 10),
  // '|': BinaryInfix('Or', 10),
  // '&': BinaryInfix('And', 10),
  '!=': BinaryInfix(onValueBinary(UnsameQ)),
  '!!': BinaryInfix(onValueBinary(TrueQ)),
  '<': BinaryInfix(onValueBinary(Less)),
  '<=': BinaryInfix(onValueBinary(LessEqual)),
  '>': BinaryInfix(onValueBinary(Greater)),
  '>=': BinaryInfix(onValueBinary(GreaterEqual)),
  ',': BinaryInfix((a, b): SeriesNode => {
    const aItems = a.type === 'series' ? a.items : [a];
    const bItems = b.type === 'series' ? b.items : [b];
    return {
      type: 'series',
      items: [...aItems, ...bItems],
    };
  }),
  // ':': BinaryInfix('Property', 12),
  // '=>': BinaryInfix('Lambda', 13, true),

  '-': BinaryInfix(onValueBinary(Minus)),
  '−': BinaryInfix(onValueBinary(Minus)),
  '+': Infix(onValueArray(Plus)),
  '': BinaryInfix((a, b) => {
    if (a.type === 'callable') {
      if (b.type === 'value') {
        return { type: 'value', value: a.impl(b.value) };
      }
    }
    if (a.type === 'value') {
      if (b.type === 'value') {
        return { type: 'value', value: Times([a.value, b.value]) };
      }
    }

    throw new Error(`Expected callable and value, got ${a.type} and ${b.type}`);
  }),
  '/': BinaryInfix(onValueBinary(Divide)),
  '÷': BinaryInfix(onValueBinary(Divide)),
  '¬': Prefix(onValue(Not)),
  '*': Infix(onValueArray(Times)),
  '×': Infix(onValueArray(Times)),
  // '^': BinaryRightInfix('Power', 25, Power),
  // '.': BinaryInfix('Dot', 30),
  // '!': Postfix('Factorial', 80),

});

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

const implicitEmpty: Token = {
  type: 'emptySeries',
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
      } else if (token.type === 'parenclose') {
        if (last.type === 'operator') {
          if (last.str === ',') {
            yield implicitEmpty;
          } else if (last.str === 'parenopen') {
            yield implicitEmpty;
          }
        }
      } else if (token.type === 'operator') {
        if (last.type === 'operator') {
          if (token.str === ',' && last.str === ',') {
            yield implicitEmpty;
          }
        }
      }
    }

    yield token;

    last = token;
  };
}

const globals = new Map<string, CallableNode>();

function FnRef(impl: (arg: MS) => MS): CallableNode {
  return {
    type: 'callable',
    impl,
  };
}

// We expect Plus[1,1] to be 2.
globals.set('Plus', FnRef(ms => {
  // Plus[0] should be 0.
  // Input: [0] ie. [[]]
  // Output: 0, i.e. []

  // Plus[1] should be 1.
  // Input: [1] ie. [[0]]
  // Output: 1, i.e. [0]

  // Plus[1,1] should be 2.
  // Input: [1,1] ie. [[0], [0]]
  // Output: 2, i.e. [0,0]

  // Plus[5, 3] should be 8.
  // Input: [5, 3] ie. [[0,0,0,0,0], [0,0,0]]
  // Output: 8, i.e. [0,0,0,0,0,0,0]

  // For 5,3 ms() will yield 1[0,0,0,0,0] and 1[0,0,0]

  return function *() {
    // Is this 'Times'?
    for (const [term, count] of ms()) {
      for (const [sub, subCount] of term()) {
        yield [sub, count * subCount];
      }
    }
  }
}));

globals.set('Times', FnRef(ms => {
  // Is this 'Power'?
  const allFactors: MS[] = [];

  for (const [factor, factorCount] of ms()) {
    if (factorCount === 0n) continue;
    if (factorCount < 0n) {
      throw new Error('Negative exponent');
    }
    for (let i = 0n; i < factorCount; i++) {
      allFactors.push(factor);
    }
  }

  return Times(allFactors);
}));

// globals.set('Power', FnRef(Power));

function createLeaf(token: Token): Node {
  if (token.type === 'number') return {
    type: 'value',
    value: Nat(BigInt(token.str)),
  };
  if (token.type === 'parenopen') return { type: 'series', items: [] };
  if (token.type === 'emptySeries') {
    return { type: 'series', items: [] };
  }
  if (token.type === 'symbol') {
    const fn = globals.get(token.str);
    if (fn) return fn;
    return {
      type: 'symbol',
      name: token.str,
    };
  }
  throw new Error(`Invalid token: ${token.type} ${token.str}`);
}

export function parse(str: string) {
  const tokens = addImplicitTokens(tokenize(str));
  return walk(
    ops,
    createLeaf,
    shunting(ops, tokens),
  );
}