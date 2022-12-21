import { walk } from './lang/ast';
import { BinaryInfix, Infix, operators, Postfix, Prefix, shunting } from './lang/parser';
import Tokenzier, { PatternDict, Token } from './lang/tokenizer';
import { MS, Nat } from './ms';
import { Divide, Equal, Greater, GreaterEqual, Less, LessEqual, Minus, Not, Plus, Times, TrueQ, UnsameQ } from './ops';

type ValueNode = { type: 'value'; value: MS };
type SeriesNode = { type: 'series'; items: Node[] };
type IdentifierNode = { type: 'identifier'; name: string, lookup?: (name: string) => DeclarationNode };
export type DeclarationNode = { type: 'declaration'; id: IdentifierNode, value?: MS };
type FnHeaderNode = { type: 'fnHeader'; args: DeclarationNode[] };
type CallableNode = { type: 'callable'; impl: (arg: MS) => MS };
type AssignmentNode = { type: 'assignment'; l: DeclarationNode; r: MS };
type LambdaNode = { type: 'lambda', header: FnHeaderNode, body: Node };

type Node =
| ValueNode
| SeriesNode
| DeclarationNode
| CallableNode
| AssignmentNode
| IdentifierNode
| LambdaNode
| FnHeaderNode
;

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

const implicitLambdaSuffix: Token = {
  type: 'implicitLambdaSuffix',
  str: '',
  line: -1,
  loc: [-1,-1],
}

function ofType<Type extends Node['type']>(n: Type, node: Node): Node & { type: Type } {
  if (node.type !== n) {
    throw new Error(`Expected ${n}, got ${node.type}`);
  }
  return node as any;
}

function switchType<T>(cases: { [key in Node['type']]?: (node: Node & { type: key }) => T }): (node: Node) => T {
  return node => {
    const fn = cases[node.type];
    if (!fn) {
      throw new Error(`Expected one of ${Object.keys(cases).join(', ')}, got ${node.type}`);
    }
    return (fn as any)(node as any) as T;
  }
};

const getValue = switchType({
  value: n => n.value,
  identifier: n => {
    if (!n.lookup) {
      throw new Error(`Identifier ${n.name} not found.`);
    }
    const val = n.lookup(n.name);
    if (!val.value) throw new Error(`Identifier ${n.name} has no value.`);
    return val.value;
  },
});

const onValue = (fn: (x: MS) => MS): (node: Node) => Node => {
  return node => {
    return { type: 'value', value: fn(getValue(node)) };
  }
}

function onValueBinary(fn: (x: MS, y: MS) => MS): (a: Node, b: Node) => Node {
  return (a, b): ValueNode => {
    const value = fn(getValue(a), getValue(b));
    return { type: 'value', value };
  };
}

function onValueArray(fn: (args: MS[]) => MS) {
  return (args: Node[]): ValueNode => {
    const values = args.map(getValue);
    const value = fn(values);
    return { type: 'value', value };
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
    return a;
  }),

  '}': BinaryInfix(a => a),
  ')': BinaryInfix(a => a),
  ']': BinaryInfix(a => {
    const items: Node[] = a.type === 'series' ? a.items : [a];
    const values = items.map(getValue);
    return { type: 'value', value: makeMultiSet(values) };
  }),

  // ';': BinaryInfix('Statements', 10),
  // '->': BinaryInfix('Rule', 10),
  // '//.': BinaryInfix('ReplaceRepeated', 10),
  '=': BinaryInfix((a, b): AssignmentNode => {
    if (a.type === 'identifier') {
      return {
        type: 'assignment',
        l: { type: 'declaration', id: a },
        r: getValue(b),
      };
    }

    throw new Error(`Expected identifier, got ${a.type}`);
  }),
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
  [implicitLambdaSuffix.str]: Postfix((a): FnHeaderNode => {
    const items = a.type === 'series' ? a.items : [a];
  
    const args = items.map((n): DeclarationNode => {
      if (n.type !== 'identifier') {
        throw new Error(`Expected identifier, got ${n.type}`);
      }
      return { type: 'declaration', id: n };
    });

    return { type: 'fnHeader', args };
  }),
  '=>': BinaryInfix((a, body): LambdaNode => {
    const header = ofType('fnHeader', a);
    return { type: 'lambda', header, body };
  }),

  '-': BinaryInfix(onValueBinary(Minus)),
  '−': BinaryInfix(onValueBinary(Minus)),
  '+': Infix(onValueArray(Plus)),
  [implicit.str]: BinaryInfix((a, b): ValueNode => {
    if (a.type === 'callable') {
      return { type: 'value', value: a.impl(getValue(b)) };
    }
    
    return { type: 'value', value: Times([getValue(a), getValue(b)]) };
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

function *addImplicitTokens(bare: Iterable<Token>): Iterable<Token> {
  let last: Token | null = null;

  for (const token of bare) {
    if (token.type === 'whitespace') {
      // skip whitespace
      continue;
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
        if (token.str === '=>') {
          yield implicitLambdaSuffix;
        } 
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
    if (globals.has(token.str)) return globals.get(token.str)!;
    return { type: 'identifier', name: token.str };
  }
  throw new Error(`Invalid token: ${token.type} ${token.str}`);
}

type Scopes = Map<string, DeclarationNode>[];
function lookup(scopes: Scopes, name: string): DeclarationNode {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (scope.has(name)) return scope.get(name)!;
  }
  
  throw new Error(`Unknown identifier: ${name}`);
}

export function parse(str: string, rootScope: Scopes[0] = new Map()) {
  const tokens = addImplicitTokens(tokenize(str));

  const scopes: Scopes = [rootScope];
  const stack: Node[] = [];

  function push(node: Node) {
    if (node.type === 'identifier') {
      node.lookup = () => lookup(scopes, node.name);
    }

    stack.push(node);
    if (node.type === 'fnHeader') {
      const fnScope = new Map();
      node.args.forEach(arg => fnScope.set(arg.id.name, arg));
      scopes.push(fnScope);
    } else if (node.type === 'lambda') {
      const popped = scopes.pop();
      console.log(popped);
    }
  }

  function pop(n: number): Node[] {
    return stack.splice(stack.length - n);
  }

  walk(ops, createLeaf, shunting(ops, tokens), push, pop);

  // Remove this:
  return ops.EOF.fn.apply(null, pop(1));
}